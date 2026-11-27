//! 1.176.0 R4: the guided Repair's execution — what [`crate::cli_repair::plan`]
//! is given, and the steps it names, run one at a time.
//!
//! Every call starts from a fresh look (`cli_health::inspect_now`) and a fresh
//! plan. `cli_repair_run(tool, stepId, …)` runs a step only when it is the
//! fresh plan's next one (an id is a hash of what the step acts on, so a step
//! whose paths changed since the person read them is refused too), and only
//! with paths taken from that fresh plan and checked here on the disk — never
//! a path the window sent.
//!
//! - Terminal steps (installer, `sudo chown`, npm removal) go through the
//!   Setup runner (`setup_run::SetupRunner`): its PTY, Stop, time limits,
//!   outcomes, log and last-run record. Their argv is built in
//!   `setup_actions` (`repair_*_plan`).
//! - Plyloft's own steps run here: a file or link removed with one
//!   `remove_file` (never recursive, never through a shell, a link removed
//!   itself and not followed), the owner's bits added to one folder, a re-read
//!   of the programs. After any of them that changes the tools, the snapshot
//!   is re-probed (`commands::re_probe_and_forget`).
//!
//! Every path a step acts on passes a check here first ([`check_removal`],
//! [`check_chown`], [`check_chmod`], [`check_npm_prefix`]): inside the home,
//! reached without a link out of it, one of the exact places the step is
//! for, and never the home, `/`, `~/.claude`, `~/.codex` or a sign-in file.

use parking_lot::Mutex;
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime};

use crate::cli_health::{self as health, CliHealth, CliTool, FolderRole};
use crate::cli_repair::{
    self as repair, RepairContext, RepairPlan, RepairRequest, SessionInUse, Step, StepAction, StepKind,
};
use crate::cli_repair_sessions::{AppSessions, BackendSessions};

// ---------------------------------------------------------------- checked paths

/// A path that passed one of this module's checks. Only this module makes
/// one, so a `setup_actions::repair_*_plan` argv only ever holds checked
/// paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckedPath(String);

impl CheckedPath {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Why a path was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PathRefusal {
    /// Not absolute, or with `.`/`..` in it.
    NotPlain,
    /// `/`, the home, a config home, a sign-in file.
    Protected,
    /// Not where this step may act.
    OutsideRoots,
    /// A link on the way leads out of where it should be.
    ThroughLink,
    NotAFile,
    NotALink,
    /// The link still leads somewhere: not broken.
    NotDangling,
    Missing,
    /// Not one of the tool's folders the look listed for this step.
    NotListed,
    SystemFolder,
    /// B1: the home itself isn't this user's: Plyloft changes no owner in it.
    #[cfg_attr(not(unix), allow(dead_code))]
    HomeNotYours,
    /// B1: a folder `chown -R` would take whole isn't only the tool's.
    NotOnlyTheTool,
    /// Review 2: a version file wasn't confirmed broken at the removal (a
    /// second probe, `codesign --verify`): it stays.
    NotConfirmed,
    /// Review 2: a file inside a folder `chown -R` would take has more than
    /// one link and isn't the user's: by hand.
    #[cfg_attr(not(unix), allow(dead_code))]
    HardLinked,
}

/// A user name `chown` may be given: letters, digits, `.`, `_`, `-`, not
/// starting with `-` (or a number, the uid).
pub fn valid_user(user: &str) -> bool {
    repair::user_may_own(user)
        && !user.is_empty()
        && user.len() <= 64
        && !user.starts_with('-')
        && user.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// Where a Repair may act, from the home (as the look saw it).
#[derive(Debug, Clone)]
pub struct Roots {
    pub windows: bool,
    /// The home as the look's paths spell it.
    pub home: PathBuf,
    /// The official installer's folder (`~/.local/bin`, Codex's Programs
    /// folder on Windows).
    pub install_dir: Option<PathBuf>,
    /// Folders never acted on as a whole: `~/.claude`, `~/.codex`,
    /// `$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`, and (1.179.0) Plyloft's Claude
    /// account folders.
    pub protected: Vec<PathBuf>,
}

impl Roots {
    pub fn new(tool: CliTool, inputs: &health::Inputs) -> Option<Self> {
        let home = PathBuf::from(inputs.home.clone()?);
        let mut protected = vec![home.join(".claude"), home.join(".codex")];
        protected.extend(inputs.claude_config_dir.clone().map(PathBuf::from));
        protected.extend(inputs.codex_home.clone().map(PathBuf::from));
        // 1.179.0 (C1): Plyloft's Claude account folders, each a Claude
        // config folder like `~/.claude` (`ai_accounts::protected_dirs`).
        protected.extend(crate::ai_accounts::protected_dirs());
        Some(Self {
            windows: inputs.windows,
            install_dir: health::install_dir(tool, inputs).map(PathBuf::from),
            home,
            protected,
        })
    }
}

/// File names that are sign-in or settings state: never removed.
const SIGN_IN_FILES: [&str; 4] = ["auth.json", ".credentials.json", ".claude.json", "config.toml"];

fn plain(path: &Path) -> bool {
    path.is_absolute() && !path.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir))
}

fn eq_path(a: &Path, b: &Path, windows: bool) -> bool {
    health::norm(&a.to_string_lossy(), windows) == health::norm(&b.to_string_lossy(), windows)
}

/// `dir` is reached from the home without a link: its real path is the
/// home's real path joined with the same names.
fn no_link_out(dir: &Path, roots: &Roots) -> bool {
    let Ok(rel) = dir.strip_prefix(&roots.home) else { return false };
    match (crate::platform::canonicalize(dir), crate::platform::canonicalize(&roots.home)) {
        (Ok(real), Ok(home)) => eq_path(&real, &home.join(rel), roots.windows),
        _ => false,
    }
}

fn protected(path: &Path, roots: &Roots) -> bool {
    let w = roots.windows;
    path.parent().is_none()
        || eq_path(path, &roots.home, w)
        || roots.protected.iter().any(|p| eq_path(path, p, w))
        || path
            .file_name()
            .map(|n| n.to_string_lossy().to_ascii_lowercase())
            .is_some_and(|n| SIGN_IN_FILES.contains(&n.as_str()))
}

/// The two removals Plyloft does itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Removal {
    /// Claude's `~/.local/share/claude/versions/<v>`: a regular file, one
    /// level down.
    Payload,
    /// A broken link of the program's name in the install folder.
    DanglingLauncher,
}

/// Check `target` for `kind` on the disk now.
pub fn check_removal(tool: CliTool, target: &str, kind: Removal, roots: &Roots) -> Result<CheckedPath, PathRefusal> {
    let w = roots.windows;
    let p = Path::new(target);
    if !plain(p) {
        return Err(PathRefusal::NotPlain);
    }
    if protected(p, roots) {
        return Err(PathRefusal::Protected);
    }
    let parent = p.parent().ok_or(PathRefusal::Protected)?;
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or(PathRefusal::NotPlain)?;
    let root = match kind {
        Removal::Payload => {
            if tool != CliTool::Claude {
                return Err(PathRefusal::OutsideRoots);
            }
            PathBuf::from(repair::claude_versions_dir(&roots.home.to_string_lossy(), w))
        }
        Removal::DanglingLauncher => {
            let names = [tool.program().to_string(), format!("{}.exe", tool.program()), format!("{}.cmd", tool.program())];
            if !names.iter().any(|n| if w { n.eq_ignore_ascii_case(&name) } else { *n == name }) {
                return Err(PathRefusal::OutsideRoots);
            }
            roots.install_dir.clone().ok_or(PathRefusal::OutsideRoots)?
        }
    };
    if !eq_path(parent, &root, w) || !p.starts_with(&roots.home) {
        return Err(PathRefusal::OutsideRoots);
    }
    if !no_link_out(parent, roots) {
        return Err(PathRefusal::ThroughLink);
    }
    let own = std::fs::symlink_metadata(p).map_err(|_| PathRefusal::Missing)?;
    match kind {
        Removal::Payload => {
            if own.file_type().is_symlink() {
                return Err(PathRefusal::ThroughLink);
            }
            if !own.is_file() {
                return Err(PathRefusal::NotAFile);
            }
        }
        Removal::DanglingLauncher => {
            if !own.file_type().is_symlink() {
                return Err(PathRefusal::NotALink);
            }
            if std::fs::metadata(p).is_ok() {
                return Err(PathRefusal::NotDangling);
            }
        }
    }
    Ok(CheckedPath(target.to_string()))
}

/// Remove one checked file or link (the link itself, never what it names).
pub fn remove(path: &CheckedPath) -> std::io::Result<()> {
    let p = Path::new(path.as_str());
    match std::fs::remove_file(p) {
        // Windows: a broken directory link is removed as a directory (the
        // link only; it has nothing in it to follow).
        Err(e) if cfg!(windows) && std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()) => {
            std::fs::remove_dir(p).map_err(|_| e)
        }
        other => other,
    }
}

/// A folder of the tool the look listed for an ownership or permission step.
fn listed_folder(path: &str, h: &CliHealth, roots: &Roots, owned: Option<bool>) -> Result<(), PathRefusal> {
    let w = roots.windows;
    let target = repair::target_channel(h.tool);
    let f = h
        .folders
        .iter()
        .find(|f| {
            health::norm(&f.path, w) == health::norm(path, w)
                && f.channel == target
                && matches!(f.role, FolderRole::InstallTarget | FolderRole::Config)
        })
        .ok_or(PathRefusal::NotListed)?;
    if f.system_folder {
        return Err(PathRefusal::SystemFolder);
    }
    if !f.exists || f.owned_by_user != owned {
        return Err(PathRefusal::NotListed);
    }
    Ok(())
}

fn in_home_folder(path: &str, roots: &Roots) -> Result<(), PathRefusal> {
    let p = Path::new(path);
    if !plain(p) {
        return Err(PathRefusal::NotPlain);
    }
    if p.parent().is_none() || eq_path(p, &roots.home, roots.windows) {
        return Err(PathRefusal::Protected);
    }
    if !p.starts_with(&roots.home) {
        return Err(PathRefusal::OutsideRoots);
    }
    let own = std::fs::symlink_metadata(p).map_err(|_| PathRefusal::Missing)?;
    if own.file_type().is_symlink() || !no_link_out(p, roots) {
        return Err(PathRefusal::ThroughLink);
    }
    Ok(())
}

/// B1: the home is this user's (the effective uid owns it). Unix only.
pub fn home_is_mine(roots: &Roots) -> Result<(), PathRefusal> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = std::fs::metadata(&roots.home).map_err(|_| PathRefusal::Missing)?;
        // SAFETY: geteuid has no preconditions.
        if meta.uid() != unsafe { libc::geteuid() } {
            return Err(PathRefusal::HomeNotYours);
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = roots;
        Err(PathRefusal::OutsideRoots)
    }
}

/// D1/B1: a folder `sudo chown -R -P` may be given: one of the tool's own
/// folders the look listed as someone else's, only the tool's
/// (`cli_repair::own_roots`), inside the home, reached without a link, not a
/// system folder, the home or `/`. Unix only.
pub fn check_chown(path: &str, h: &CliHealth, roots: &Roots) -> Result<CheckedPath, PathRefusal> {
    if roots.windows {
        return Err(PathRefusal::OutsideRoots);
    }
    in_home_folder(path, roots)?;
    listed_folder(path, h, roots, Some(false))?;
    let own = repair::own_roots(h, Some(&roots.home.to_string_lossy()), false);
    if !own.iter().any(|r| repair::inside(path, r, false)) {
        return Err(PathRefusal::NotOnlyTheTool);
    }
    Ok(CheckedPath(path.to_string()))
}

/// B1: a path the non-recursive `sudo chown -h` may be given: a shared
/// folder of the tool the look listed as someone else's (the install folder,
/// `.claude.json`), or one of the tool's own launcher entries in the install
/// folder by its exact name (a link is changed itself, never followed).
pub fn check_chown_shared(path: &str, h: &CliHealth, roots: &Roots) -> Result<CheckedPath, PathRefusal> {
    if roots.windows {
        return Err(PathRefusal::OutsideRoots);
    }
    let p = Path::new(path);
    if !plain(p) {
        return Err(PathRefusal::NotPlain);
    }
    let w = roots.windows;
    let install = roots.install_dir.as_deref();
    let in_install = p.parent().zip(install).is_some_and(|(parent, dir)| eq_path(parent, dir, w));
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if in_install && name == h.tool.program() {
        let parent = p.parent().ok_or(PathRefusal::NotPlain)?;
        if !no_link_out(parent, roots) {
            return Err(PathRefusal::ThroughLink);
        }
        let own = std::fs::symlink_metadata(p).map_err(|_| PathRefusal::Missing)?;
        if own.is_dir() {
            return Err(PathRefusal::NotAFile);
        }
        return Ok(CheckedPath(path.to_string()));
    }
    in_home_folder(path, roots)?;
    listed_folder(path, h, roots, Some(false))?;
    let home = roots.home.to_string_lossy().into_owned();
    let own = repair::own_roots(h, Some(&home), w);
    let f = h.folders.iter().find(|f| health::norm(&f.path, w) == health::norm(path, w)).ok_or(PathRefusal::NotListed)?;
    if repair::place_of(f, h, Some(&home), &own, w) == repair::Place::Broad {
        return Err(PathRefusal::NotOnlyTheTool);
    }
    Ok(CheckedPath(path.to_string()))
}

/// A folder (or `.claude.json`) of the tool that is the user's and can't be
/// written: Plyloft adds the owner's bits. Unix only.
pub fn check_chmod(path: &str, h: &CliHealth, roots: &Roots) -> Result<CheckedPath, PathRefusal> {
    if roots.windows {
        return Err(PathRefusal::OutsideRoots);
    }
    // M2: Claude's version file that can't be run gets its owner's bits.
    if h.tool == CliTool::Claude {
        if let Ok(checked) = check_removal(h.tool, path, Removal::Payload, roots) {
            return Ok(checked);
        }
    }
    in_home_folder(path, roots)?;
    listed_folder(path, h, roots, Some(true))?;
    Ok(CheckedPath(path.to_string()))
}

/// Add the owner's read, write and search bits to one checked folder (a
/// file: read and write). Not recursive; nothing else changes.
#[cfg(unix)]
pub fn add_owner_bits(path: &CheckedPath) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let p = Path::new(path.as_str());
    let meta = std::fs::symlink_metadata(p)?;
    if meta.file_type().is_symlink() {
        return Err(std::io::Error::other("a link"));
    }
    // A folder rwx; a version file (a program) rwx; another file rw.
    let program = p.parent().is_some_and(|d| d.ends_with(Path::new(".local/share/claude/versions")));
    let bits = if meta.is_dir() || program { 0o700 } else { 0o600 };
    let mode = meta.permissions().mode();
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode | bits))
}

#[cfg(not(unix))]
pub fn add_owner_bits(_path: &CheckedPath) -> std::io::Result<()> {
    Err(std::io::Error::other("not on Windows"))
}

/// D3: the prefix an npm removal is given: a plain folder, not `/`, holding
/// the tool's package where npm puts it.
pub fn check_npm_prefix(tool: CliTool, prefix: &str, windows: bool) -> Result<CheckedPath, PathRefusal> {
    let p = Path::new(prefix);
    if !plain(p) {
        return Err(PathRefusal::NotPlain);
    }
    if p.parent().is_none() {
        return Err(PathRefusal::Protected);
    }
    let modules = if windows { p.join("node_modules") } else { p.join("lib").join("node_modules") };
    let package = repair::npm_package(tool).split('/').fold(modules, |acc, part| acc.join(part));
    if !std::fs::metadata(p).is_ok_and(|m| m.is_dir()) {
        return Err(PathRefusal::Missing);
    }
    if !std::fs::metadata(&package).is_ok_and(|m| m.is_dir()) {
        return Err(PathRefusal::OutsideRoots);
    }
    Ok(CheckedPath(prefix.to_string()))
}

/// The npm of the copy's prefix (`<prefix>/bin/npm`), else the one on PATH.
pub fn npm_for(prefix: Option<&str>, path: &str, windows: bool) -> Option<String> {
    let own = prefix.map(|p| {
        if windows {
            Path::new(p).join("npm.cmd")
        } else {
            Path::new(p).join("bin").join("npm")
        }
    });
    own.filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .or_else(|| crate::shell_env::find_in_path(path, "npm"))
}

// ---------------------------------------------------------------- the machine

/// The user name a `chown` gives back to (unix: this process's user; the uid
/// when its name isn't a plain one).
#[cfg(unix)]
pub fn user_name() -> Option<String> {
    // SAFETY: getpwuid_r with a buffer this function owns.
    unsafe {
        let uid = libc::geteuid();
        let mut pwd: libc::passwd = std::mem::zeroed();
        let mut buf = vec![0 as libc::c_char; 4096];
        let mut out: *mut libc::passwd = std::ptr::null_mut();
        let rc = libc::getpwuid_r(uid, &mut pwd, buf.as_mut_ptr(), buf.len(), &mut out);
        let name = (rc == 0 && !out.is_null() && !pwd.pw_name.is_null())
            .then(|| std::ffi::CStr::from_ptr(pwd.pw_name).to_string_lossy().into_owned());
        Some(name.filter(|n| valid_user(n)).unwrap_or_else(|| uid.to_string()))
    }
}

#[cfg(not(unix))]
pub fn user_name() -> Option<String> {
    None
}

/// Free bytes for this user on the volume `path` is on (its nearest existing
/// folder); `None` when it can't be read.
pub fn free_bytes(path: &Path) -> Option<u64> {
    let mut at = Some(path);
    while let Some(p) = at {
        if p.is_dir() {
            return free_at(p);
        }
        at = p.parent();
    }
    None
}

#[cfg(unix)]
fn free_at(dir: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    // SAFETY: statvfs fills a struct this function owns.
    unsafe {
        let mut s: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c.as_ptr(), &mut s) != 0 {
            return None;
        }
        #[allow(clippy::unnecessary_cast)]
        Some((s.f_bavail as u64).saturating_mul(s.f_frsize as u64))
    }
}

#[cfg(windows)]
fn free_at(dir: &Path) -> Option<u64> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut available: u64 = 0;
    // SAFETY: one out-pointer to a u64 this function owns.
    unsafe { GetDiskFreeSpaceExW(&HSTRING::from(dir.as_os_str()), Some(&mut available), None, None) }.ok()?;
    Some(available)
}

/// One step run in the repair under way. A terminal step keeps its run (id,
/// action id, when it started).
#[derive(Debug, Clone, PartialEq)]
pub struct Attempt {
    pub tool: CliTool,
    pub kind: StepKind,
    pub run: Option<(String, String, chrono::DateTime<chrono::Utc>)>,
}

/// Per tool, in memory: a restart is a new repair.
static ATTEMPTS: Mutex<Vec<Attempt>> = Mutex::new(Vec::new());

/// Pure: the kinds that count as tried. A terminal step counts once its run
/// ended and left its record (`setup_last_run`: same action, finished after
/// it started). One still running doesn't count (a plan read meanwhile must
/// not say it failed), nor one the person stopped (Stop keeps no record).
pub fn counted(attempts: &[Attempt], tool: CliTool, running: Option<&str>, last: Option<&crate::setup_last_run::LastRun>) -> Vec<StepKind> {
    attempts
        .iter()
        .filter(|a| a.tool == tool)
        .filter(|a| match &a.run {
            None => true,
            Some((run_id, _, _)) if Some(run_id.as_str()) == running => false,
            Some((_, action, at)) => last.is_some_and(|l| {
                l.action_id == *action
                    && l.finished_at
                        .as_deref()
                        .and_then(|f| chrono::DateTime::parse_from_rfc3339(f).ok())
                        .is_some_and(|f| f.with_timezone(&chrono::Utc) >= *at - chrono::Duration::seconds(5))
            }),
        })
        .map(|a| a.kind)
        .collect()
}

fn note_attempt(tool: CliTool, kind: StepKind, run: Option<(String, String)>) {
    let mut held = ATTEMPTS.lock();
    held.retain(|a| !(a.tool == tool && a.kind == kind));
    held.push(Attempt { tool, kind, run: run.map(|(id, action)| (id, action, chrono::Utc::now())) });
}

fn forget_attempts(tool: CliTool) {
    ATTEMPTS.lock().retain(|a| a.tool != tool);
    UNCONFIRMED.lock().retain(|(t, _)| *t != tool);
}

/// For card R5 (the hidden Codex update, `codex_auto_update::live`) and the
/// window: a Setup run of `tool` (install, update or a Repair step) is under
/// way, so nothing else should install or update it now.
pub fn tool_run_active<R: Runtime>(app: &AppHandle<R>, tool: CliTool) -> bool {
    app.try_state::<crate::setup_run::SetupRunner>()
        .and_then(|r| r.active())
        .is_some_and(|a| a.action_id.ends_with(&format!(".{}", tool.program())))
}

/// The snapshot's PATH with the installer's folder on it (added at the end
/// when missing, so the person's order stays).
pub fn path_with(path: &str, dir: Option<&str>, windows: bool) -> String {
    let Some(dir) = dir else { return path.to_string() };
    let has = health::split_path(path, windows).iter().any(|(_, d)| health::norm(d, windows) == health::norm(dir, windows));
    if has {
        return path.to_string();
    }
    let sep = if windows { ';' } else { ':' };
    if path.is_empty() {
        dir.to_string()
    } else {
        format!("{path}{sep}{dir}")
    }
}

/// One fresh look, the context, and the plan. The installer's host is
/// checked only for a plan that installs.
pub fn gather<R: Runtime>(app: &AppHandle<R>, tool: CliTool, request: &RepairRequest) -> (CliHealth, health::Inputs, RepairPlan) {
    gather_as(app, tool, request, !request.quick)
}

/// [`gather`]; `full`: the installer host is checked and the repair's
/// memory may change (start over, forgotten at nothing-to-repair). A quick
/// read (`request.quick`) is neither, and asks `--version` once, briefly.
pub fn gather_as<R: Runtime>(
    app: &AppHandle<R>,
    tool: CliTool,
    request: &RepairRequest,
    full: bool,
) -> (CliHealth, health::Inputs, RepairPlan) {
    if full && request.start_over {
        forget_attempts(tool);
    }
    let mut inputs = health::inputs_now(tool);
    inputs.no_retry = request.quick;
    let mut h = health::inspect(tool, &inputs, &health::SystemMachine);
    h.passed_over = health::passed_over_now(tool);
    let running = app.try_state::<crate::setup_run::SetupRunner>().and_then(|r| r.active()).map(|a| a.run_id);
    let sessions = repair::merge_sessions(repair::tiles_as_sessions(&request.tiles), AppSessions { app }.sessions(tool));
    let last_run = crate::setup_last_run::dir_of(app)
        .map(|dir| crate::setup_last_run::load(&dir))
        .and_then(|mut runs| runs.remove(crate::setup_last_run::tool_key(match tool {
            CliTool::Claude => crate::setup_actions::Tool::Claude,
            CliTool::Codex => crate::setup_actions::Tool::Codex,
        })));
    // Each npm copy's prefix with its own npm (`<prefix>/bin/npm` first).
    let npms: Vec<(String, String)> = h
        .copies
        .iter()
        .filter(|c| c.channel == health::InstallChannel::Npm && !c.dangling)
        .filter_map(|c| repair::npm_prefix(tool, c, inputs.windows))
        .filter_map(|prefix| npm_for(Some(&prefix), &inputs.path, inputs.windows).map(|npm| (prefix, npm)))
        .collect();
    let attempted = counted(&ATTEMPTS.lock(), tool, running.as_deref(), last_run.as_ref());
    let space_at = h.install_dir.clone().or(inputs.home.clone()).map(PathBuf::from);
    let mut ctx = RepairContext {
        windows: inputs.windows,
        home: inputs.home.clone(),
        user: user_name(),
        sessions,
        free_bytes: space_at.as_deref().and_then(free_bytes),
        reach: None,
        last_run,
        remove_npm_copy: request.remove_npm_copy,
        npms,
        unconfirmed: unconfirmed(tool),
        attempted,
        reinstall: request.reinstall,
        program_folders: crate::shell_env::path_override().map(|value| {
            let verdict = crate::program_folders::saved_verdict();
            repair::ProgramFoldersCtx {
                problems: verdict.as_ref().map(|v| v.problems.clone()).unwrap_or_default(),
                missing: verdict.map(|v| v.missing).unwrap_or_default(),
                shell_path: crate::shell_env::shell_reported_path(),
                value,
            }
        }),
    };
    let mut plan = repair::plan(&h, &ctx);
    if full && plan.installs() && plan.block.is_none() {
        let action = match tool {
            CliTool::Claude => crate::setup_actions::ActionId::InstallClaude,
            CliTool::Codex => crate::setup_actions::ActionId::InstallCodex,
        };
        ctx.reach = Some(crate::setup_run::reach_now(action));
        plan = repair::plan(&h, &ctx);
    }
    // Nothing left to repair: the next repair starts afresh.
    if full && matches!(plan.block, Some(repair::Block::NothingToRepair { .. })) {
        forget_attempts(tool);
    }
    // 1.176.0 seams: the same test Setup's Update refuses by, on the copy
    // Plyloft runs (a few file checks, no `--version`).
    let runs = crate::shell_env::try_get().and_then(|env| match tool {
        CliTool::Claude => env.claude_path.clone(),
        CliTool::Codex => env.codex_path.clone(),
    });
    plan.update_blocked = runs
        .is_some_and(|path| health::update_folders_writable(tool, &path, &inputs, &health::SystemMachine) == Some(false));
    if request.quick {
        plan = as_quick(plan);
    }
    (h, inputs, plan)
}

/// Pure (R4b): a quick read's plan — marked, and with nothing to run (its
/// reach wasn't checked, so an install in it says nothing about the network).
pub fn as_quick(mut plan: RepairPlan) -> RepairPlan {
    plan.quick = true;
    plan.next_step = None;
    plan
}

// ---------------------------------------------------------------- running a step

/// Why a step wasn't run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Refusal {
    /// The fresh plan has no step with that id (what it acts on changed).
    NotInPlan,
    /// It is in the plan but isn't the next one.
    NotNextStep,
    /// The tool's sessions are still open: they close first.
    SessionsInUse,
    /// The plan is blocked (offline, disk full, nothing to repair, gave up).
    Blocked,
    /// A path failed its check on the disk.
    PathRefused,
    /// The Setup runner refused it (another run is under way, quitting).
    RunnerRefused,
    /// R4b: the request was a quick read (`quick: true`): never run.
    QuickPlan,
    Unsupported,
}

/// What `cli_repair_run` did. Tagged by `kind`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RepairRunResult {
    /// A terminal step started; its end comes as `setup://progress`.
    Started { step_id: String, step: StepKind, started: crate::setup_run::SetupStarted },
    /// One of Plyloft's own steps ended.
    Done {
        step_id: String,
        step: StepKind,
        /// What it removed or changed.
        paths: Vec<String>,
        /// Paths it couldn't change, with why.
        failed: Vec<String>,
        reprobed: bool,
        /// `verify`: the fresh look.
        health: Option<CliHealth>,
    },
    Refused {
        reason: Refusal,
        path_refusal: Option<PathRefusal>,
        details: Option<String>,
        plan: RepairPlan,
    },
}

fn refused(reason: Refusal, plan: RepairPlan) -> RepairRunResult {
    RepairRunResult::Refused { reason, path_refusal: None, details: None, plan }
}

/// Pure: the step `step_id` may run now. `verify` (a read) runs whenever the
/// plan lists it; anything else only as the plan's next step.
pub fn runnable<'a>(plan: &'a RepairPlan, step_id: &str) -> Result<&'a Step, Refusal> {
    let Some(step) = plan.step(step_id) else { return Err(Refusal::NotInPlan) };
    if step.kind() == StepKind::Verify {
        return Ok(step);
    }
    if plan.next_step.as_deref() == Some(step_id) {
        return Ok(step);
    }
    if plan.steps.first().is_some_and(|s| s.kind() == StepKind::CloseSessions) || step.kind() == StepKind::CloseSessions
    {
        return Err(Refusal::SessionsInUse);
    }
    if plan.block.is_some() {
        return Err(Refusal::Blocked);
    }
    Err(Refusal::NotNextStep)
}

/// Pure (R5): a step of `tool` waits for the hidden Codex update in flight.
/// `verify` only reads, so it runs; Claude's steps don't touch Codex.
pub fn update_blocks_step(tool: CliTool, kind: StepKind, codex_update_in_flight: bool) -> bool {
    codex_update_in_flight && tool == CliTool::Codex && kind != StepKind::Verify
}

/// What one of Plyloft's own steps did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Applied {
    pub paths: Vec<String>,
    pub failed: Vec<String>,
}

/// Run one of Plyloft's own writing steps on paths from the fresh plan,
/// each checked first. Every path is checked before anything is changed: one
/// refusal changes nothing.
pub fn apply_own_step(
    step: &Step,
    h: &CliHealth,
    roots: &Roots,
    confirm: &dyn Fn(&str) -> bool,
) -> Result<Applied, PathRefusal> {
    let tool = h.tool;
    let checked: Vec<CheckedPath> = step
        .paths
        .iter()
        .map(|p| match step.kind() {
            StepKind::RemoveBrokenPayload => check_removal(tool, p, Removal::Payload, roots),
            StepKind::RemoveDanglingLauncher => check_removal(tool, p, Removal::DanglingLauncher, roots),
            StepKind::FixPermissions => check_chmod(p, h, roots),
            _ => Err(PathRefusal::OutsideRoots),
        })
        .collect::<Result<_, _>>()?;
    // Review 2: a version file goes only when a second look confirms it
    // broken; one unconfirmed keeps them all.
    if step.kind() == StepKind::RemoveBrokenPayload && !checked.iter().all(|p| confirm(p.as_str())) {
        return Err(PathRefusal::NotConfirmed);
    }
    let mut applied = Applied::default();
    for path in checked {
        let result = match step.kind() {
            StepKind::FixPermissions => add_owner_bits(&path),
            _ => remove(&path),
        };
        match result {
            Ok(()) => applied.paths.push(path.as_str().to_string()),
            Err(e) => applied.failed.push(format!("{}: {e}", path.as_str())),
        }
    }
    Ok(applied)
}

/// Pure: a second look confirms a version file broken. It must again be a
/// broken binary (SIGKILL, 137, or refused at spawn as not a program); on
/// macOS a `codesign --verify` that passes means it is intact (do not
/// delete), one that fails confirms, one that couldn't run leaves the second
/// probe to decide.
pub fn payload_confirmed(second: &health::CopyStart, codesign: Option<bool>, macos: bool) -> bool {
    let broken = !second.starts && second.failure == Some(health::StartFailure::BadBinary);
    broken && !(macos && codesign == Some(true))
}

/// `/usr/bin/codesign --verify <path>`, bounded: `Some(true)` it verifies.
#[cfg(target_os = "macos")]
fn codesign_verifies(path: &str) -> Option<bool> {
    let mut command = crate::platform::new_command("/usr/bin/codesign");
    command.arg("--verify").arg(path);
    crate::worktrees::run_bounded_output(&mut command, std::time::Duration::from_secs(20))
        .ok()
        .map(|out| out.status.success())
}

#[cfg(not(target_os = "macos"))]
fn codesign_verifies(_path: &str) -> Option<bool> {
    None
}

/// The real second look at a version file (`payload_confirmed`).
pub fn confirm_broken(path: &str, env_path: &str) -> bool {
    use health::Machine;
    let second = health::start_from(health::SystemMachine.run_version(path, env_path, health::VERSION_TIMEOUT));
    let codesign = if cfg!(target_os = "macos") { codesign_verifies(path) } else { None };
    payload_confirmed(&second, codesign, cfg!(target_os = "macos"))
}

/// Review 2: `chown -R` hands over every inode in the tree. A regular file
/// inside with more than one link that isn't the user's (a hard link to a
/// file elsewhere) refuses it. Links are not followed.
pub fn check_hard_links(root: &Path) -> Result<(), PathRefusal> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no preconditions.
        let me = unsafe { libc::geteuid() };
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let meta = std::fs::symlink_metadata(&dir).map_err(|_| PathRefusal::Missing)?;
            if meta.is_file() && meta.nlink() > 1 && meta.uid() != me {
                return Err(PathRefusal::HardLinked);
            }
            if !meta.is_dir() {
                continue;
            }
            // A folder this user can't read (another account's, mode 700)
            // can't be looked into without sudo; refusing it would refuse
            // the very case Repair is for (a `.claude` made by `sudo`), so it
            // is passed by, and logged.
            let Ok(entries) = std::fs::read_dir(&dir) else {
                log::warn!("cli_repair: {} can't be read; its links weren't checked", dir.display());
                continue;
            };
            for entry in entries.flatten() {
                stack.push(entry.path());
            }
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = root;
        Err(PathRefusal::OutsideRoots)
    }
}

/// Version files a removal didn't confirm (per tool, in memory).
static UNCONFIRMED: Mutex<Vec<(CliTool, String)>> = Mutex::new(Vec::new());

fn unconfirmed(tool: CliTool) -> Vec<String> {
    UNCONFIRMED.lock().iter().filter(|(t, _)| *t == tool).map(|(_, p)| p.clone()).collect()
}

/// The chown argv's folders, each checked on the disk.
pub fn chown_folders(step: &Step, h: &CliHealth, roots: &Roots) -> Result<Vec<CheckedPath>, PathRefusal> {
    match step.kind() {
        StepKind::FixOwnership => step
            .paths
            .iter()
            .map(|p| check_chown(p, h, roots).and_then(|c| check_hard_links(Path::new(c.as_str())).map(|()| c)))
            .collect(),
        StepKind::FixSharedOwnership => step.paths.iter().map(|p| check_chown_shared(p, h, roots)).collect(),
        _ => Err(PathRefusal::OutsideRoots),
    }
}

fn re_probe<R: Runtime>(app: &AppHandle<R>, tool: CliTool) {
    // 1.176.1: a change this look finds in the repaired tool is Repair's own
    // (`cli_seen`), until the look is over.
    let _own = crate::cli_seen::OwnChange::new(&[match tool {
        CliTool::Claude => crate::cli_fresh::Cli::Claude,
        CliTool::Codex => crate::cli_fresh::Cli::Codex,
    }]);
    let capabilities = app.try_state::<crate::review_capabilities::ReviewerCapabilityRegistry>();
    crate::commands::re_probe_and_forget(capabilities.as_deref());
}

fn start_terminal<R: Runtime>(
    app: &AppHandle<R>,
    step: &Step,
    run: Result<crate::setup_actions::RunPlan, String>,
    plan: RepairPlan,
    size: (u16, u16),
) -> RepairRunResult {
    let run = match run {
        Ok(run) => run,
        Err(details) => {
            return RepairRunResult::Refused { reason: Refusal::Unsupported, path_refusal: None, details: Some(details), plan }
        }
    };
    let runner = app.state::<crate::setup_run::SetupRunner>();
    if let Some(dir) = crate::setup_last_run::dir_of(app) {
        runner.keep_records_in(dir);
    }
    match runner.start(
        app,
        run,
        Arc::new(crate::setup_run::SystemObserver { app: app.clone() }),
        crate::setup_run::Timing::REAL,
        crate::setup_run::app_emit(app),
        size.0,
        size.1,
    ) {
        Ok(started) => {
            note_attempt(plan.tool, step.kind(), Some((started.run_id.clone(), started.action_id.clone())));
            RepairRunResult::Started { step_id: step.id.clone(), step: step.kind(), started }
        }
        Err(details) => {
            RepairRunResult::Refused { reason: Refusal::RunnerRefused, path_refusal: None, details: Some(details), plan }
        }
    }
}

/// Run `step_id` of a fresh plan.
pub fn run_step<R: Runtime>(
    app: &AppHandle<R>,
    tool: CliTool,
    step_id: &str,
    request: &RepairRequest,
    size: (u16, u16),
) -> RepairRunResult {
    if request.quick {
        let (_, _, plan) = gather(app, tool, request);
        return refused(Refusal::QuickPlan, plan);
    }
    let (h, inputs, plan) = gather(app, tool, request);
    let step = match runnable(&plan, step_id) {
        Ok(step) => step.clone(),
        Err(reason) => return refused(reason, plan),
    };
    // Nothing runs beside a Setup run under way (an installer still
    // writing): its end comes first, then the plan is read again.
    let busy = app.try_state::<crate::setup_run::SetupRunner>().and_then(|r| r.active());
    if let (Some(active), false) = (busy, step.kind() == StepKind::Verify) {
        return RepairRunResult::Refused {
            reason: Refusal::RunnerRefused,
            path_refusal: None,
            details: Some(format!("{} is still running.", active.action_id)),
            plan,
        };
    }
    // R5: never beside the hidden Codex update (its process may be writing
    // the very folders a step repairs); read again once it has ended.
    if update_blocks_step(tool, step.kind(), crate::codex_auto_update::updating()) {
        return RepairRunResult::Refused {
            reason: Refusal::RunnerRefused,
            path_refusal: None,
            details: Some(crate::codex_auto_update::SETUP_REFUSED.into()),
            plan,
        };
    }
    let Some(roots) = Roots::new(tool, &inputs) else {
        return refused(Refusal::Unsupported, plan);
    };
    let path_refused = |why: PathRefusal, plan: RepairPlan| RepairRunResult::Refused {
        reason: Refusal::PathRefused,
        path_refusal: Some(why),
        details: None,
        plan,
    };
    let done = |paths: Vec<String>, failed: Vec<String>, reprobed: bool, health: Option<CliHealth>| RepairRunResult::Done {
        step_id: step.id.clone(),
        step: step.kind(),
        paths,
        failed,
        reprobed,
        health,
    };
    match &step.action {
        StepAction::CloseSessions { .. } => refused(Refusal::SessionsInUse, plan),
        StepAction::Verify => done(Vec::new(), Vec::new(), false, Some(h)),
        StepAction::Reread => {
            note_attempt(tool, StepKind::Reread, None);
            re_probe(app, tool);
            done(Vec::new(), Vec::new(), true, None)
        }
        StepAction::RemoveBrokenPayload | StepAction::RemoveDanglingLauncher | StepAction::FixPermissions => {
            let env_path = inputs.path.clone();
            match apply_own_step(&step, &h, &roots, &|p| confirm_broken(p, &env_path)) {
                Ok(applied) => {
                    note_attempt(tool, step.kind(), None);
                    let changes_programs = step.kind() != StepKind::FixPermissions;
                    if changes_programs {
                        re_probe(app, tool);
                    }
                    log::info!(
                        "cli_repair: {} {} — {} done, {} failed",
                        tool.program(),
                        step.kind().wire(),
                        applied.paths.len(),
                        applied.failed.len()
                    );
                    done(applied.paths, applied.failed, changes_programs, None)
                }
                Err(PathRefusal::NotConfirmed) => {
                    let mut held = UNCONFIRMED.lock();
                    for p in &step.paths {
                        if !held.iter().any(|(t, q)| *t == tool && q == p) {
                            held.push((tool, p.clone()));
                        }
                    }
                    drop(held);
                    let mut plan = plan;
                    plan.block = Some(repair::Block::NotSureYet { paths: step.paths.clone() });
                    plan.steps.clear();
                    plan.next_step = None;
                    path_refused(PathRefusal::NotConfirmed, plan)
                }
                Err(why) => path_refused(why, plan),
            }
        }
        StepAction::FixOwnership { user } | StepAction::FixSharedOwnership { user } => {
            let recursive = step.kind() == StepKind::FixOwnership;
            if let Err(why) = home_is_mine(&roots) {
                return path_refused(why, plan);
            }
            let fresh_user = user_name();
            if fresh_user.as_deref() != Some(user.as_str()) || !valid_user(user) {
                return refused(Refusal::Unsupported, plan);
            }
            match chown_folders(&step, &h, &roots) {
                Ok(folders) => {
                    let run = crate::setup_actions::repair_chown_plan(tool, user, &folders, recursive, inputs.windows);
                    start_terminal(app, &step, run, plan, size)
                }
                Err(why) => path_refused(why, plan),
            }
        }
        StepAction::RemoveNpmCopy { prefix, .. } => {
            let checked = match check_npm_prefix(tool, prefix, inputs.windows) {
                Ok(checked) => checked,
                Err(why) => return path_refused(why, plan),
            };
            let Some(npm) = npm_for(Some(prefix), &inputs.path, inputs.windows) else {
                return refused(Refusal::Unsupported, plan);
            };
            let run = crate::setup_actions::repair_npm_remove_plan(tool, &npm, &checked, &inputs.path, inputs.windows);
            start_terminal(app, &step, run, plan, size)
        }
        // 1.176.1: through the setting's own save, checked again first.
        StepAction::AddProgramFolder { folder, front, was } => match crate::program_folders::add_folder(app, folder, *front, was) {
            Ok(saved) => {
                note_attempt(tool, StepKind::AddProgramFolder, None);
                log::info!("cli_repair: {} added {folder} to Program folders", tool.program());
                done(vec![saved], Vec::new(), true, None)
            }
            Err(details) => RepairRunResult::Refused { reason: Refusal::Unsupported, path_refusal: None, details: Some(details), plan },
        },
        StepAction::EmptyProgramFolders { was } => match crate::program_folders::empty(app, was) {
            Ok(()) => {
                note_attempt(tool, StepKind::EmptyProgramFolders, None);
                log::info!("cli_repair: {} emptied Program folders", tool.program());
                done(Vec::new(), Vec::new(), true, None)
            }
            Err(details) => RepairRunResult::Refused { reason: Refusal::Unsupported, path_refusal: None, details: Some(details), plan },
        },
        StepAction::RunInstaller { .. } => {
            let env = crate::shell_env::get();
            let facts = crate::setup_actions::PlanFacts::read(&env);
            let path = path_with(&env.path, h.install_dir.as_deref(), inputs.windows);
            let run = crate::setup_actions::repair_install_plan(tool, &facts, inputs.home.as_deref(), &path);
            start_terminal(app, &step, run, plan, size)
        }
    }
}

// ---------------------------------------------------------------- IPC

fn parse_tool(tool: &str) -> Result<CliTool, String> {
    CliTool::parse(tool).ok_or_else(|| format!("No such AI tool: {tool}"))
}

/// `cli_repair_plan(tool, request)`: a fresh look, the context and the plan.
#[tauri::command]
pub async fn cli_repair_plan(app: AppHandle, tool: String, request: Option<RepairRequest>) -> Result<RepairPlan, String> {
    let tool = parse_tool(&tool)?;
    let request = request.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || gather(&app, tool, &request).2)
        .await
        .map_err(|e| format!("repair worker failed: {e}"))
}

/// `cli_repair_run(tool, stepId, request)`: run the fresh plan's next step.
#[tauri::command]
pub async fn cli_repair_run(
    app: AppHandle,
    tool: String,
    step_id: String,
    request: Option<RepairRequest>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<RepairRunResult, String> {
    let tool = parse_tool(&tool)?;
    let request = request.unwrap_or_default();
    let size = (
        cols.unwrap_or(crate::setup_run::DEFAULT_COLS).max(20),
        rows.unwrap_or(crate::setup_run::DEFAULT_ROWS).max(5),
    );
    tauri::async_runtime::spawn_blocking(move || run_step(&app, tool, &step_id, &request, size))
        .await
        .map_err(|e| format!("repair worker failed: {e}"))
}

/// `cli_repair_in_use(tool)`: the sessions only the backend knows of.
#[tauri::command(async)]
pub fn cli_repair_in_use(app: AppHandle, tool: String) -> Result<Vec<SessionInUse>, String> {
    let tool = parse_tool(&tool)?;
    Ok(AppSessions { app: &app }.sessions(tool))
}

/// `cli_repair_report(tool, includeTail)`: the plain-text report for support.
#[tauri::command]
pub async fn cli_repair_report(app: AppHandle, tool: String, include_tail: Option<bool>) -> Result<String, String> {
    let tool = parse_tool(&tool)?;
    tauri::async_runtime::spawn_blocking(move || {
        // The plan as it stands (no reach check, nothing remembered changed),
        // for its by-hand commands.
        let (h, inputs, plan) = gather_as(&app, tool, &RepairRequest::default(), false);
        let last = crate::setup_last_run::dir_of(&app)
            .map(|dir| crate::setup_last_run::load(&dir))
            .and_then(|mut runs| runs.remove(tool.program()));
        let facts = crate::cli_repair_report::Facts {
            app_version: app.package_info().version.to_string(),
            os: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
            home: inputs.home.clone(),
            user: user_name().or_else(|| std::env::var("USERNAME").ok()),
            host: crate::cli_repair_report::host_name(),
            windows: inputs.windows,
            looked_in: Some(crate::cli_repair_report::LookedIn {
                path: inputs.path.clone(),
                from_setting: crate::shell_env::path_override().is_some(),
                verdict: crate::program_folders::saved_verdict(),
                probe_error: crate::shell_env::try_get().and_then(|e| e.probe_error.clone()),
            }),
        };
        crate::cli_repair_report::report(&h, last.as_ref(), include_tail.unwrap_or(false), &plan.manual, &facts)
    })
    .await
    .map_err(|e| format!("repair worker failed: {e}"))
}

#[cfg(test)]
#[path = "cli_repair_run_tests.rs"]
mod tests;
