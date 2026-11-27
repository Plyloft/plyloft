//! 1.176.0 R1: a read-only look at one AI CLI (`claude` or `codex`) for the
//! guided Repair (`~/ply-build/cli-repair/PLAN.md` §2–3, measured facts in
//! `R0-FINDINGS.md`). It answers: every copy on PATH and in the folders the
//! official installers, npm and Homebrew use; where each really is (links
//! followed, a broken link named and classified by where it pointed);
//! whether each starts (`--version`, bounded, retried once on a timeout);
//! which copy a tile runs today (the path cached in the [`crate::shell_env`]
//! snapshot, checked against the disk) and which it should; whether the
//! folders an install or update writes are this user's and writable; and
//! what is wrong, most severe first.
//!
//! It never writes: the only processes are bounded `<copy> --version` probes
//! (own process group, killed at the bound); a folder's writability is tested
//! by creating and removing one uniquely named empty file, and a missing
//! folder is never created (its nearest existing parent is tested instead).
//!
//! All disk and process access is behind [`Machine`]; [`inspect`] and every
//! classifier are pure over [`Inputs`] (strings, with a `windows` flag), so
//! the Windows rules are tested on the Mac too (`cli_health_tests.rs`).
//!
//! Not covered (follow-ups): `$XDG_DATA_HOME`/`$XDG_STATE_HOME`/
//! `$XDG_CACHE_HOME` for Claude's folders (nothing in Plyloft honours them
//! yet); version managers' shims (volta, asdf, mise) are `Unknown`, since
//! the shim's real file says nothing of what it launches.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The first bound of one `--version`. A local call that answers in
/// milliseconds; 8 s covers a cold disk.
pub const VERSION_TIMEOUT: Duration = Duration::from_secs(8);
/// The second, for a copy that ran past the first: a 360 MB binary's first
/// launch (Gatekeeper's scan) can be slow. Past this too, the start is
/// inconclusive, never "does not start".
pub const VERSION_RETRY_TIMEOUT: Duration = Duration::from_secs(30);
const TAIL_LINES: usize = 12;
const TAIL_CHARS: usize = 800;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CliTool {
    Claude,
    Codex,
}

impl CliTool {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }

    pub fn program(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

/// How a copy was installed, from where its real file lives (or, for a
/// broken link, where the link pointed).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallChannel {
    /// Claude's own installer (`~/.local/share/claude/versions/`).
    Native,
    /// Codex's own installer (`~/.codex/packages/standalone`, or
    /// `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`).
    Standalone,
    Npm,
    /// `bun install -g` (`~/.bun/…`): not npm's to update.
    Bun,
    /// `pnpm add -g`: not npm's to update.
    Pnpm,
    Homebrew,
    /// Claude's older self-managed install in `~/.claude/local`.
    LegacyLocal,
    Winget,
    Unknown,
}

/// What a `--version` probe could not do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StartFailure {
    /// The file, or the interpreter its first line names, wasn't there
    /// (spawn ENOENT, or a wrapper's exit 127).
    NotFound,
    PermissionDenied,
    /// Past both bounds: inconclusive, not a failed start.
    TimedOut,
    /// A broken binary: killed by a signal (macOS kills a truncated or
    /// unsigned Mach-O with SIGKILL; a wrapper shell reports it as 137), or
    /// refused at spawn as malformed / wrong architecture / not executable
    /// format. The plain Claude installer does not replace such a file of
    /// the same version (R0 C4).
    BadBinary,
    /// It could not be started for another reason (see `tail`).
    SpawnFailed,
    /// It ran and exited without printing a version.
    Exited,
    /// It exited but its output could not be read to the end.
    Unreadable,
    /// R4 (review 2): ended by a signal other than SIGKILL (memory
    /// pressure's SIGTERM, a crash): inconclusive, not a broken binary.
    Signal,
}

/// One copy's `--version` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyStart {
    /// A version was read from it (`shell_env::parse_version_output`).
    pub starts: bool,
    pub version: Option<String>,
    pub failure: Option<StartFailure>,
    /// Ran past both bounds: whether it starts is unknown.
    pub inconclusive: bool,
    pub exit_code: Option<i32>,
    /// The signal that ended it (unix).
    pub signal: Option<i32>,
    /// The last lines it printed (or the spawn error), trimmed; only when it
    /// failed.
    pub tail: Option<String>,
}

/// One distinct copy of the CLI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliCopy {
    /// The path as found (a PATH entry or a known folder joined with the
    /// program's name, or the cached path).
    pub path: String,
    /// Other paths found that are the same real file.
    pub also_at: Vec<String>,
    /// The real file, links followed; `None` for a broken link or one that
    /// can't be followed.
    pub real_path: Option<String>,
    pub dangling: bool,
    /// The link can't be followed: a folder on its way can't be read.
    pub unreadable: bool,
    /// What the link at `path` points to (its own text), when it is a link.
    pub link_target: Option<String>,
    /// For a link, the last path its chain reaches (absolute): the real file,
    /// or where a broken chain stops.
    pub link_end: Option<String>,
    /// Its PATH entry's position (0 = first); `None` when off PATH.
    pub path_rank: Option<usize>,
    /// In the folder the official installer uses (`installDir`).
    pub in_install_dir: bool,
    pub executable: bool,
    /// Whether the real file is this user's; `None` where it can't be told
    /// (Windows, a broken link).
    pub owned_by_user: Option<bool>,
    /// Whether the folder `path` is in is this user's.
    pub folder_owned_by_user: Option<bool>,
    /// The real file is outside the home and the CLI's config folders
    /// (`/usr/local`, Homebrew's): not the user's to fix.
    pub system_folder: bool,
    pub channel: InstallChannel,
    /// `None` when it wasn't run (a broken link, not executable).
    pub start: Option<CopyStart>,
    /// 1.176.1 (Windows walk): a copy on the Program folders list that
    /// doesn't start, asked again with the folders the shell reports — `Some(true)`:
    /// the list leaves out what it needs (an npm shim's `node`), so emptying
    /// the setting makes it start. `None` when not asked.
    pub starts_with_shell: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FolderKind {
    Dir,
    File,
}

/// Why a folder is on the list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FolderRole {
    /// The CLI's own settings and sign-in home (`~/.claude`, `~/.codex`).
    Config,
    /// Where the official installer puts it, which a Repair installs into.
    InstallTarget,
    /// Where an installed copy's own manager writes (npm, Homebrew, legacy).
    Copy,
}

/// One folder (or file) an install or update writes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderCheck {
    pub path: String,
    pub kind: FolderKind,
    pub role: FolderRole,
    /// The channel whose install or update writes it.
    pub channel: InstallChannel,
    /// Whether the copy a tile runs today needs it (its own channel's
    /// folders and the config home); the others matter only for a Repair.
    pub needed_now: bool,
    /// Outside the home and the CLI's config folders (`/usr/local/…`,
    /// Homebrew's): not the user's to fix, so a Repair never offers to take
    /// it over.
    pub system_folder: bool,
    pub exists: bool,
    /// What was tested: `path`, or its nearest existing parent when it is
    /// missing; `None` when nothing above it exists.
    pub checked: Option<String>,
    pub owned_by_user: Option<bool>,
    pub writable: bool,
}

/// A folder named in a finding, with what the window needs to word it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderRef {
    /// What was tested (`FolderCheck::checked`, else its path).
    pub path: String,
    pub needed_now: bool,
    pub system_folder: bool,
}

/// What a tile runs: the path the [`crate::shell_env`] snapshot cached,
/// checked against the disk now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedCheck {
    /// The cached value; `None` when the snapshot found no such tool.
    pub path: Option<String>,
    /// What a spawn of it runs: the path itself, or a bare name resolved on
    /// PATH; `None` when there is nothing to run.
    pub runs: Option<String>,
    pub exists: bool,
    pub executable: bool,
    /// It exists and is executable: a spawn gets as far as running it.
    pub usable: bool,
    /// What the disk says now: the first executable copy on PATH (as
    /// `shell_env::resolve_program`).
    pub now: Option<String>,
    /// `runs` and `now` are the same real file.
    pub matches_now: bool,
}

/// What is wrong, most severe first. Tagged by `kind` so a new kind is an
/// addition the window can ignore.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Finding {
    /// No copy anywhere, not even a broken link.
    Missing,
    /// Copies exist and every one that ran failed to start (a timeout alone
    /// never raises this).
    NoWorkingCopy,
    /// The path a tile runs (the cached one) can't be run, or isn't what the
    /// disk resolves now.
    CachedPathStale { cached: Option<String>, now: Option<String>, usable: bool },
    /// What a tile runs today (`first`, `None` when nothing) isn't the copy
    /// that works.
    FirstOnPathIsNotTheWorkingOne { first: Option<String>, working: String, working_on_path: bool },
    DoesNotStart {
        path: String,
        failure: StartFailure,
        exit_code: Option<i32>,
        signal: Option<i32>,
        tail: Option<String>,
    },
    /// Ran past both bounds; not a failed start.
    StartInconclusive { path: String },
    DanglingLink { path: String, target: Option<String>, channel: InstallChannel },
    NotExecutable { path: String },
    /// A folder on PATH, or one a copy's link goes through, that can't be
    /// read: what is in it is unknown.
    Unreadable { paths: Vec<String> },
    /// The copy's real file isn't this user's (a `sudo` install).
    CopyNotOwned { path: String, system_folder: bool },
    FoldersNotWritable { folders: Vec<FolderRef> },
    /// Only folders that are the user's to fix (never a system folder).
    FoldersNotOwned { folders: Vec<FolderRef> },
    /// More than one real copy (broken links are named apart).
    SeveralCopies { paths: Vec<String> },
    /// A copy is in the official installer's folder but that folder isn't on
    /// the PATH tiles get (the snapshot's, which may already include the
    /// known install folders: then this never fires for them).
    NativeDirNotOnPath { dir: String },
}

/// The whole look at one CLI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliHealth {
    pub tool: CliTool,
    /// One copy that counts (on PATH or in the install folder), it is what a
    /// tile runs and it starts, the cached path is usable, the folders it
    /// needs are writable, and its file is the user's (unless a system
    /// install). A stale copy elsewhere (a broken link left in
    /// `~/.claude/local`, off PATH) is still a finding but doesn't make a
    /// working machine unhealthy.
    pub healthy: bool,
    /// What a tile runs today: the cached path as a spawn resolves it (or,
    /// with no snapshot, the first file on PATH).
    pub runs_today: Option<String>,
    /// What it should run: the first copy that starts.
    pub should_run: Option<String>,
    /// Where the official installer puts the program (`~/.local/bin`, or
    /// Codex's Programs folder on Windows).
    pub install_dir: Option<String>,
    /// `None` when no snapshot was given.
    pub cached: Option<CachedCheck>,
    pub copies: Vec<CliCopy>,
    pub folders: Vec<FolderCheck>,
    pub findings: Vec<Finding>,
    /// R4 (B2): the snapshot passed over the first copy on PATH (it doesn't
    /// start) for a later one; `None` from [`inspect`] alone.
    pub passed_over: Option<crate::shell_env::PassedOver>,
}

/// The tool's path in the [`crate::shell_env`] snapshot.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Cached {
    /// No snapshot (tests, or before the first probe).
    #[default]
    Unknown,
    /// The snapshot found no such tool.
    Absent,
    Path(String),
}

/// Everything the look reads from the environment, so a test can describe
/// any machine (a Windows one on the Mac included).
#[derive(Debug, Clone, Default)]
pub struct Inputs {
    /// The PATH tiles get (the snapshot's).
    pub path: String,
    pub windows: bool,
    pub home: Option<String>,
    pub local_app_data: Option<String>,
    pub app_data: Option<String>,
    /// `$CLAUDE_CONFIG_DIR` when set (as `claude_auth`/`doctor_reads` read it).
    pub claude_config_dir: Option<String>,
    /// Codex's home (`codex_home::real_codex_home`: `$CODEX_HOME` or `~/.codex`).
    pub codex_home: Option<String>,
    /// npm's global prefix, when known without running npm.
    pub npm_prefix: Option<String>,
    /// Homebrew's bin folders on unix.
    pub system_dirs: Vec<String>,
    /// PATHEXT on Windows (`.com`, `.exe`, …); empty elsewhere.
    pub exts: Vec<String>,
    pub cached: Cached,
    /// The two `--version` bounds; `None` = [`VERSION_TIMEOUT`] then
    /// [`VERSION_RETRY_TIMEOUT`].
    pub version_bounds: Option<(Duration, Duration)>,
    /// R4b (`quick`): only the first bound; a copy past it stays
    /// inconclusive ("can't tell"), never asked again.
    pub no_retry: bool,
    /// 1.176.0 seams: a PATH override is set in Settings. As in the
    /// snapshot (`shell_env::choose_copy`), the first copy is then never
    /// passed over: tiles run it whatever it answers.
    pub path_override: bool,
    /// 1.176.1 (Windows walk): with an override set, what the shell reports
    /// (`shell_env::shell_reported_path`; on Windows the process PATH with
    /// the installers' folders). A copy outside the person's list is asked
    /// `--version` with these folders and its own — as it would run once
    /// reachable — never with the list that leaves it out. `None`: unknown,
    /// and such a copy's answer is inconclusive.
    pub shell_path: Option<String>,
}

impl Inputs {
    /// This machine, with `path` as the PATH tiles get and `cached` the
    /// snapshot's path for the tool.
    pub fn from_process(path: &str, cached: Cached) -> Self {
        let var = |key: &str| std::env::var(key).ok().filter(|v| !v.trim().is_empty());
        let home = crate::platform::home_dir().map(|h| h.to_string_lossy().into_owned());
        let windows = cfg!(windows);
        let npmrc = home
            .as_deref()
            .and_then(|h| std::fs::read_to_string(Path::new(h).join(".npmrc")).ok());
        let npm_prefix = var("NPM_CONFIG_PREFIX")
            .or_else(|| var("npm_config_prefix"))
            .or_else(|| npmrc.as_deref().and_then(|text| npmrc_prefix(text, home.as_deref(), windows)));
        Self {
            path: path.to_string(),
            windows,
            local_app_data: if windows { var("LOCALAPPDATA") } else { None },
            app_data: if windows { var("APPDATA") } else { None },
            claude_config_dir: var("CLAUDE_CONFIG_DIR"),
            codex_home: Some(crate::codex_home::real_codex_home().to_string_lossy().into_owned()),
            npm_prefix,
            system_dirs: if windows {
                Vec::new()
            } else {
                vec!["/opt/homebrew/bin".into(), "/usr/local/bin".into()]
            },
            exts: if windows { pathext(var("PATHEXT").as_deref()) } else { Vec::new() },
            home,
            cached,
            version_bounds: None,
            no_retry: false,
            path_override: false,
            shell_path: None,
        }
    }
}

/// PATHEXT's entries, lower-case and each with its dot (as
/// `platform::pathext`: `EXE` is `.exe`).
pub fn pathext(value: Option<&str>) -> Vec<String> {
    value
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(".COM;.EXE;.BAT;.CMD")
        .split(';')
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(|e| {
            let e = e.to_ascii_lowercase();
            if e.starts_with('.') {
                e
            } else {
                format!(".{e}")
            }
        })
        .collect()
}

/// The `prefix=` line of an `.npmrc` (`~/` expanded), the one npm setting
/// that moves the global bin without running npm.
pub fn npmrc_prefix(text: &str, home: Option<&str>, windows: bool) -> Option<String> {
    let value = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with('#') && !line.starts_with(';'))
        .filter_map(|line| line.split_once('='))
        .filter(|(key, _)| key.trim() == "prefix")
        .map(|(_, value)| value.trim().trim_matches('"').to_string())
        .last()?;
    if value.is_empty() {
        return None;
    }
    match (value.strip_prefix("~/").or_else(|| value.strip_prefix("~\\")), home) {
        (Some(rest), Some(home)) => Some(join(home, &[rest], windows)),
        (Some(_), None) => None,
        (None, _) => Some(value),
    }
}

// ---------------------------------------------------------------- the machine

/// A path as the disk has it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FileLook {
    /// The link's own text, when `path` is a link.
    pub link_target: Option<String>,
    /// For a link, the last path its chain reaches (absolute).
    pub chain_end: Option<String>,
    /// The real file, links followed; `None` when the chain is broken.
    pub real_path: Option<String>,
    /// The chain couldn't be followed for lack of permission (not broken).
    pub target_unreadable: bool,
    /// The real thing is a regular file.
    pub is_file: bool,
    pub executable: bool,
    pub owned: Option<bool>,
    pub folder_owned: Option<bool>,
}

/// One path looked at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Look {
    /// Nothing there, not even a link.
    Absent,
    /// The folder it is in can't be read (EACCES).
    Unreadable,
    Found(FileLook),
}

/// A folder (or file) as the disk has it, writability tested.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderLook {
    pub exists: bool,
    pub checked: Option<String>,
    pub owned: Option<bool>,
    pub writable: bool,
}

/// How a `--version` run ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunOutcome {
    Exited { code: Option<i32>, signal: Option<i32>, stdout: Vec<u8>, stderr: Vec<u8> },
    SpawnFailed(String),
    TimedOut,
    Unreadable,
}

/// The disk and processes, behind a trait so [`inspect`] is tested with a
/// scripted machine.
pub trait Machine: Sync {
    fn look(&self, path: &str) -> Look;
    fn folder(&self, path: &str, kind: FolderKind) -> FolderLook;
    fn run_version(&self, program: &str, env_path: &str, timeout: Duration) -> RunOutcome;
}

/// The real machine.
pub struct SystemMachine;

impl Machine for SystemMachine {
    fn look(&self, path: &str) -> Look {
        let p = Path::new(path);
        let own = match std::fs::symlink_metadata(p) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => return Look::Unreadable,
            Err(_) => return Look::Absent,
        };
        let is_link = own.file_type().is_symlink();
        let link_target = is_link
            .then(|| std::fs::read_link(p).ok().map(|t| t.to_string_lossy().into_owned()))
            .flatten();
        let (real_path, target_unreadable) = match crate::platform::canonicalize(p) {
            Ok(real) => (Some(real.to_string_lossy().into_owned()), false),
            Err(e) => (None, e.kind() == std::io::ErrorKind::PermissionDenied),
        };
        let meta = std::fs::metadata(p).ok();
        Look::Found(FileLook {
            link_target,
            chain_end: is_link.then(|| link_chain_end(p)).flatten(),
            real_path,
            target_unreadable,
            is_file: meta.as_ref().is_some_and(|m| m.is_file()),
            executable: meta.as_ref().is_some_and(|m| crate::platform::is_executable(p, m)),
            owned: meta.as_ref().and_then(owned_by_me),
            folder_owned: p.parent().and_then(|d| std::fs::metadata(d).ok()).as_ref().and_then(owned_by_me),
        })
    }

    fn folder(&self, path: &str, kind: FolderKind) -> FolderLook {
        let p = Path::new(path);
        if let Ok(meta) = std::fs::metadata(p) {
            let writable = match kind {
                FolderKind::Dir => meta.is_dir() && dir_writable(p),
                FolderKind::File => meta.is_file() && file_writable(p),
            };
            return FolderLook { exists: true, checked: Some(path.to_string()), owned: owned_by_me(&meta), writable };
        }
        if std::fs::symlink_metadata(p).is_ok() {
            // A broken link where the folder should be: nothing can go in.
            return FolderLook { exists: true, checked: Some(path.to_string()), owned: None, writable: false };
        }
        let mut up = p.parent();
        while let Some(dir) = up {
            if let Ok(meta) = std::fs::metadata(dir) {
                return FolderLook {
                    exists: false,
                    checked: Some(dir.to_string_lossy().into_owned()),
                    owned: owned_by_me(&meta),
                    writable: meta.is_dir() && dir_writable(dir),
                };
            }
            up = dir.parent();
        }
        FolderLook { exists: false, checked: None, owned: None, writable: false }
    }

    fn run_version(&self, program: &str, env_path: &str, timeout: Duration) -> RunOutcome {
        use crate::worktrees::BoundedFailure;
        let mut command = crate::platform::command(program, env_path);
        command
            .arg("--version")
            .env("PATH", env_path)
            // Claude's own switch: a version probe must never start an update.
            .env("DISABLE_AUTOUPDATER", "1");
        match crate::worktrees::run_bounded_output(&mut command, timeout) {
            Ok(out) => RunOutcome::Exited {
                code: out.status.code(),
                signal: exit_signal(&out.status),
                stdout: out.stdout,
                stderr: out.stderr,
            },
            Err(BoundedFailure::Spawn(e)) => RunOutcome::SpawnFailed(e),
            Err(BoundedFailure::Quitting) => RunOutcome::SpawnFailed("Plyloft is quitting".into()),
            Err(BoundedFailure::TimedOut) => RunOutcome::TimedOut,
            Err(BoundedFailure::Truncated) => RunOutcome::Unreadable,
        }
    }
}

/// Follow a link chain as far as it goes, textually (relative targets
/// joined to the link's folder, `.`/`..` folded), up to 40 hops: the real
/// file, or where a broken chain stops (`versions/<v>` of a deleted Claude).
fn link_chain_end(start: &Path) -> Option<String> {
    let mut cur = start.to_path_buf();
    let mut end: Option<PathBuf> = None;
    for _ in 0..40 {
        let Ok(target) = std::fs::read_link(&cur) else { break };
        let next = if target.is_absolute() {
            target
        } else {
            cur.parent().map(|d| d.join(&target)).unwrap_or(target)
        };
        let next = fold_dots(&next);
        end = Some(next.clone());
        cur = next;
    }
    end.map(|p| p.to_string_lossy().into_owned())
}

fn fold_dots(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

#[cfg(unix)]
fn exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn exit_signal(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}

#[cfg(unix)]
fn owned_by_me(meta: &std::fs::Metadata) -> Option<bool> {
    use std::os::unix::fs::MetadataExt;
    Some(meta.uid() == unsafe { libc::geteuid() })
}

#[cfg(not(unix))]
fn owned_by_me(_meta: &std::fs::Metadata) -> Option<bool> {
    None
}

/// Create and remove one uniquely named empty file in `dir`.
fn dir_writable(dir: &Path) -> bool {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let probe = dir.join(format!(
        ".plyloft-write-check-{}-{nanos}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(file) => {
            drop(file);
            if let Err(e) = std::fs::remove_file(&probe) {
                log::warn!("cli_health: could not remove {}: {e}", probe.display());
            }
            true
        }
        Err(_) => false,
    }
}

/// Opened for appending, nothing written: its content and times stay.
fn file_writable(path: &Path) -> bool {
    std::fs::OpenOptions::new().append(true).open(path).is_ok()
}

// ---------------------------------------------------------------- pure helpers

fn sep(windows: bool) -> char {
    if windows {
        '\\'
    } else {
        '/'
    }
}

/// `base` joined with `parts` by the platform's separator.
pub fn join(base: &str, parts: &[&str], windows: bool) -> String {
    let s = sep(windows);
    let mut out = base.trim_end_matches(['/', s]).to_string();
    if out.is_empty() && base.starts_with('/') {
        out.push('/');
    }
    for part in parts {
        if !out.ends_with(s) {
            out.push(s);
        }
        out.push_str(part.trim_matches(['/', s]));
    }
    out
}

/// The folder `path` is in.
pub fn parent(path: &str, windows: bool) -> Option<&str> {
    let cut = if windows { path.rfind(['/', '\\']) } else { path.rfind('/') }?;
    Some(if cut == 0 { "/" } else { &path[..cut] })
}

/// A path as compared: forward slashes, no trailing one, and on Windows
/// without case.
pub fn norm(path: &str, windows: bool) -> String {
    let p = if windows { path.replace('\\', "/").to_ascii_lowercase() } else { path.to_string() };
    let trimmed = p.trim_end_matches('/');
    if trimmed.is_empty() && p.starts_with('/') {
        "/".into()
    } else {
        trimmed.to_string()
    }
}

/// `path` is `dir` or inside it.
fn within(path: &str, dir: &str, windows: bool) -> bool {
    let (p, d) = (norm(path, windows), norm(dir, windows));
    p == d || p.starts_with(&format!("{}/", d.trim_end_matches('/')))
}

/// An absolute path (`/…`; on Windows `C:\…` or `\\server\…`).
pub fn is_absolute(path: &str, windows: bool) -> bool {
    if windows {
        let b = path.as_bytes();
        (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
            || path.starts_with("\\\\")
    } else {
        path.starts_with('/')
    }
}

/// The PATH's folders in order (`;` on Windows, `:` elsewhere), quotes
/// dropped, each with its position. Blank and relative entries are skipped
/// (a relative one means a different folder in every tile) but keep their
/// position out of the count of the others.
pub fn split_path(path: &str, windows: bool) -> Vec<(usize, String)> {
    path.split(if windows { ';' } else { ':' })
        .map(|d| d.trim().trim_matches('"').to_string())
        .filter(|d| !d.is_empty())
        .enumerate()
        .filter(|(_, d)| is_absolute(d, windows))
        .collect()
}

fn on_path(dir: &str, inp: &Inputs) -> bool {
    split_path(&inp.path, inp.windows).iter().any(|(_, d)| norm(d, inp.windows) == norm(dir, inp.windows))
}

/// The file names the program can have in a folder, in lookup order (as
/// `platform::program_candidates`).
pub fn program_names(tool: CliTool, inp: &Inputs) -> Vec<String> {
    if inp.windows {
        inp.exts.iter().map(|ext| format!("{}{}", tool.program(), ext.to_ascii_lowercase())).collect()
    } else {
        vec![tool.program().to_string()]
    }
}

fn home_join(inp: &Inputs, parts: &[&str]) -> Option<String> {
    inp.home.as_deref().map(|h| join(h, parts, inp.windows))
}

/// Where the official installer puts the program.
pub fn install_dir(tool: CliTool, inp: &Inputs) -> Option<String> {
    if inp.windows && tool == CliTool::Codex {
        if let Some(local) = inp.local_app_data.as_deref() {
            return Some(join(local, &["Programs", "OpenAI", "Codex", "bin"], true));
        }
    }
    home_join(inp, &[".local", "bin"])
}

/// The known folders a copy may be in besides PATH (the native or standalone
/// bin, Claude's legacy folder, npm's global bin, Homebrew's, WinGet's).
pub fn known_dirs(tool: CliTool, inp: &Inputs) -> Vec<String> {
    let w = inp.windows;
    let mut dirs = Vec::new();
    dirs.extend(install_dir(tool, inp));
    if inp.windows && tool == CliTool::Codex {
        dirs.extend(home_join(inp, &[".local", "bin"]));
    }
    if tool == CliTool::Claude {
        dirs.extend(home_join(inp, &[".claude", "local"]));
    }
    if let Some(prefix) = inp.npm_prefix.as_deref() {
        dirs.push(if w { prefix.to_string() } else { join(prefix, &["bin"], false) });
    }
    if w {
        dirs.extend(inp.app_data.as_deref().map(|a| join(a, &["npm"], true)));
        dirs.extend(inp.local_app_data.as_deref().map(|l| join(l, &["Microsoft", "WinGet", "Links"], true)));
    }
    dirs.extend(inp.system_dirs.iter().cloned());
    dirs
}

/// How a copy was installed. `resolved` is its real file, or for a broken
/// link where the chain stopped (`link_end`), so a deleted
/// `versions/<v>` still reads as Native. Codex's npm and Windows standalone
/// rules are the doctor's (`doctor::codex_is_npm`,
/// `doctor::codex_is_standalone_windows`), so Update and Repair read a copy
/// the same way; bun and pnpm are told apart first, since npm must never
/// update them.
pub fn classify(tool: CliTool, found: &str, resolved: Option<&str>, inp: &Inputs) -> InstallChannel {
    let raw = resolved.unwrap_or(found);
    let p = raw.replace('\\', "/").to_ascii_lowercase();
    let found_l = found.replace('\\', "/").to_ascii_lowercase();
    let either = |needle: &str| p.contains(needle) || found_l.contains(needle);
    let brew = p.contains("/cellar/") || p.contains("/caskroom/");
    let winget = either("/microsoft/winget/");
    let bun = either("/.bun/");
    let pnpm = either("/.pnpm/") || either("/pnpm/");
    let found_dir = parent(&found_l, false).unwrap_or_default().to_string();
    let npm_dir = found_dir.ends_with("/npm")
        || inp.npm_prefix.as_deref().is_some_and(|pre| {
            let pre = norm(pre, true);
            found_dir == pre || found_dir == format!("{pre}/bin")
        });
    match tool {
        CliTool::Claude => {
            if either("/.claude/local/") {
                InstallChannel::LegacyLocal
            } else if p.contains("/.local/share/claude/versions/")
                || (inp.windows && p.ends_with("/.local/bin/claude.exe"))
            {
                InstallChannel::Native
            } else if bun {
                InstallChannel::Bun
            } else if pnpm {
                InstallChannel::Pnpm
            } else if p.contains("/node_modules/@anthropic-ai/claude-code") || (inp.windows && npm_dir) {
                InstallChannel::Npm
            } else if brew {
                InstallChannel::Homebrew
            } else if winget {
                InstallChannel::Winget
            } else {
                InstallChannel::Unknown
            }
        }
        CliTool::Codex => {
            let home_pkg = codex_home(inp).map(|h| format!("{}/packages/standalone/", norm(&h, true)));
            if p.contains("/.codex/packages/standalone/")
                || home_pkg.is_some_and(|h| p.starts_with(&h))
                || (inp.windows && crate::doctor::codex_is_standalone_windows(Some(raw)))
            {
                InstallChannel::Standalone
            } else if bun {
                InstallChannel::Bun
            } else if pnpm {
                InstallChannel::Pnpm
            } else if crate::doctor::codex_is_npm(Some(raw)) || (inp.windows && npm_dir) {
                InstallChannel::Npm
            } else if brew {
                InstallChannel::Homebrew
            } else {
                InstallChannel::Unknown
            }
        }
    }
}

fn codex_home(inp: &Inputs) -> Option<String> {
    inp.codex_home.clone().or_else(|| home_join(inp, &[".codex"]))
}

fn claude_config(inp: &Inputs) -> Option<String> {
    inp.claude_config_dir.clone().or_else(|| home_join(inp, &[".claude"]))
}

/// Outside the home and the CLI's config folders: not the user's to fix.
pub fn is_system_folder(path: &str, inp: &Inputs) -> bool {
    let w = inp.windows;
    let mine = [inp.home.clone(), inp.claude_config_dir.clone(), inp.codex_home.clone()];
    !mine.iter().flatten().any(|dir| within(path, dir, w))
}

/// `raw` up to (and with) the first match of `needle`, matched without case
/// and slash direction.
fn prefix_through(raw: &str, needle: &str) -> Option<String> {
    let p = raw.replace('\\', "/").to_ascii_lowercase();
    let at = p.find(needle)?;
    Some(raw[..at + needle.len()].to_string())
}

/// The folder an npm install of the package writes: the package's parent
/// (`…/node_modules/@anthropic-ai`). For a Windows `.cmd` shim, beside it.
pub fn npm_package_parent(tool: CliTool, copy: &CliCopy, windows: bool) -> Option<String> {
    let scope = match tool {
        CliTool::Claude => "@anthropic-ai",
        CliTool::Codex => "@openai",
    };
    let needle = format!("node_modules/{scope}");
    // R9: the link's textual end first (the home as spelled), the canonical
    // path last.
    [copy.link_end.as_deref(), Some(copy.path.as_str()), copy.real_path.as_deref()]
        .into_iter()
        .flatten()
        .find_map(|p| prefix_through(p, &needle))
        .or_else(|| windows.then(|| parent(&copy.path, true).map(|d| join(d, &["node_modules", scope], true))).flatten())
}

/// A folder to check before it is tested.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedFolder {
    pub path: String,
    pub kind: FolderKind,
    pub role: FolderRole,
    pub channel: InstallChannel,
    pub needed_now: bool,
}

/// The folders an install or update writes: the config home, the official
/// installer's folders (with the ones R0 saw fail: Claude's `versions`,
/// Codex's `releases`), and those of each copy's own manager, broken links
/// included. `running` is the copy a tile runs today.
pub fn folder_plan(tool: CliTool, inp: &Inputs, copies: &[CliCopy], running: Option<&CliCopy>) -> Vec<PlannedFolder> {
    let w = inp.windows;
    let mut out: Vec<PlannedFolder> = Vec::new();
    let mut add = |path: Option<String>, kind, role, channel, needed_now: bool| {
        let Some(path) = path else { return };
        let key = norm(&path, w);
        if let Some(existing) = out.iter_mut().find(|f| norm(&f.path, w) == key) {
            existing.needed_now |= needed_now;
            return;
        }
        out.push(PlannedFolder { path, kind, role, channel, needed_now });
    };
    let target = match tool {
        CliTool::Claude => InstallChannel::Native,
        CliTool::Codex => InstallChannel::Standalone,
    };
    let target_now = running.map(|c| c.channel) == Some(target);
    let dir = FolderKind::Dir;
    let install = FolderRole::InstallTarget;
    match tool {
        CliTool::Claude => {
            let state_file = match inp.claude_config_dir.as_deref() {
                Some(d) => Some(join(d, &[".claude.json"], w)),
                None => home_join(inp, &[".claude.json"]),
            };
            add(claude_config(inp), dir, FolderRole::Config, target, true);
            add(state_file, FolderKind::File, FolderRole::Config, target, true);
            add(install_dir(tool, inp), dir, install, target, target_now);
            add(home_join(inp, &[".local", "share", "claude"]), dir, install, target, target_now);
            add(home_join(inp, &[".local", "share", "claude", "versions"]), dir, install, target, target_now);
            add(home_join(inp, &[".local", "state", "claude"]), dir, install, target, target_now);
            add(home_join(inp, &[".cache", "claude"]), dir, install, target, target_now);
        }
        CliTool::Codex => {
            let home = codex_home(inp);
            add(home.clone(), dir, FolderRole::Config, target, true);
            add(install_dir(tool, inp), dir, install, target, target_now);
            if let Some(h) = home {
                add(Some(join(&h, &["packages", "standalone"], w)), dir, install, target, target_now);
                add(Some(join(&h, &["packages", "standalone", "releases"], w)), dir, install, target, target_now);
            }
        }
    }
    for copy in copies {
        let now = running.is_some_and(|r| r.path == copy.path);
        let bin = parent(&copy.path, w).map(str::to_string);
        let role = FolderRole::Copy;
        match copy.channel {
            InstallChannel::Npm => {
                add(npm_package_parent(tool, copy, w), dir, role, InstallChannel::Npm, now);
                add(bin, dir, role, InstallChannel::Npm, now);
            }
            InstallChannel::Homebrew => {
                let real = copy.real_path.as_deref().or(copy.link_end.as_deref()).unwrap_or(&copy.path);
                let cellar = prefix_through(real, "/caskroom").or_else(|| prefix_through(real, "/cellar"));
                add(cellar, dir, role, InstallChannel::Homebrew, now);
                add(bin, dir, role, InstallChannel::Homebrew, now);
            }
            InstallChannel::LegacyLocal => add(bin, dir, role, InstallChannel::LegacyLocal, now),
            _ => {}
        }
    }
    out
}

/// A spawn error's kind, from the io error text (`… (os error N)`).
pub fn classify_spawn_error(message: &str) -> StartFailure {
    let m = message.to_ascii_lowercase();
    let code = |n: u32| m.contains(&format!("os error {n})"));
    // ENOEXEC 8, macOS EBADARCH 86 / EBADMACHO 88, Windows
    // ERROR_BAD_EXE_FORMAT 193 / ERROR_EXE_MACHINE_TYPE_MISMATCH 216.
    if [8, 86, 88, 193, 216].into_iter().any(code)
        || m.contains("exec format")
        || m.contains("bad cpu type")
        || m.contains("malformed mach-o")
    {
        StartFailure::BadBinary
    } else if code(2) || code(3) || m.contains("no such file") || m.contains("not found") {
        StartFailure::NotFound
    } else if code(13) || code(5) || m.contains("permission denied") || m.contains("access is denied") {
        StartFailure::PermissionDenied
    } else {
        StartFailure::SpawnFailed
    }
}

/// The last lines of what a failed run printed: escape codes and control
/// characters out, at most [`TAIL_LINES`] lines and [`TAIL_CHARS`] characters.
pub fn tail_of(stdout: &[u8], stderr: &[u8]) -> Option<String> {
    // 1.176.2 R1: a `.cmd` shim run through cmd.exe says why in the OEM
    // code page on Windows (`decode_console`).
    let mut text = crate::platform::decode_console(stdout);
    let err = crate::platform::decode_console(stderr);
    if !err.trim().is_empty() {
        if !text.trim().is_empty() {
            text.push('\n');
        }
        text.push_str(&err);
    }
    let clean = strip_escapes(&text);
    let lines: Vec<&str> = clean.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect();
    let kept = lines[lines.len().saturating_sub(TAIL_LINES)..].join("\n");
    if kept.is_empty() {
        return None;
    }
    let count = kept.chars().count();
    Some(if count > TAIL_CHARS { kept.chars().skip(count - TAIL_CHARS).collect() } else { kept })
}

fn strip_escapes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for n in chars.by_ref() {
                    if ('@'..='~').contains(&n) {
                        break;
                    }
                }
            }
            continue;
        }
        if c == '\n' || c == '\t' || !c.is_control() {
            out.push(c);
        }
    }
    out
}

/// What one `--version` run says about the copy. A run killed by a signal,
/// or a wrapper's 137 (128 + SIGKILL), is a broken binary; a wrapper's 127
/// is a missing file or interpreter. A timeout here is the final one (see
/// [`probe_all`]): inconclusive.
pub fn start_from(outcome: RunOutcome) -> CopyStart {
    let none = CopyStart {
        starts: false,
        version: None,
        failure: None,
        inconclusive: false,
        exit_code: None,
        signal: None,
        tail: None,
    };
    match outcome {
        RunOutcome::Exited { code, signal, stdout, stderr } => {
            let version = crate::shell_env::parse_version_output(&stdout, &stderr, code == Some(0));
            if version.is_some() {
                return CopyStart { starts: true, version, exit_code: code, signal, ..none };
            }
            // R4 (review 2): only SIGKILL (macOS's verdict on a binary whose
            // signature fails, R0 C4) or a wrapper's 137 is a broken binary;
            // another signal is inconclusive.
            let (failure, inconclusive) = match (signal, code) {
                (Some(9), _) | (None, Some(137)) => (StartFailure::BadBinary, false),
                (Some(_), _) => (StartFailure::Signal, true),
                (None, Some(127)) => (StartFailure::NotFound, false),
                _ => (StartFailure::Exited, false),
            };
            CopyStart { failure: Some(failure), inconclusive, exit_code: code, signal, tail: tail_of(&stdout, &stderr), ..none }
        }
        RunOutcome::SpawnFailed(message) => {
            // R4 (review 2): a spawn error is certain only when it says the
            // file can't run; ETXTBSY, EAGAIN, ENOMEM… are inconclusive.
            let failure = classify_spawn_error(&message);
            CopyStart {
                failure: Some(failure),
                inconclusive: failure == StartFailure::SpawnFailed,
                tail: tail_of(message.as_bytes(), b""),
                ..none
            }
        }
        RunOutcome::TimedOut => CopyStart { failure: Some(StartFailure::TimedOut), inconclusive: true, ..none },
        // Its output couldn't be read to the end: unknown, as shell_env says.
        RunOutcome::Unreadable => CopyStart { failure: Some(StartFailure::Unreadable), inconclusive: true, ..none },
    }
}

// ---------------------------------------------------------------- the look

/// Look at `tool` on the machine `inp` and `machine` describe.
pub fn inspect(tool: CliTool, inp: &Inputs, machine: &dyn Machine) -> CliHealth {
    let w = inp.windows;
    let install = install_dir(tool, inp);
    let (mut copies, unreadable_dirs) = find_copies(tool, inp, machine);

    // What a spawn of the cached path runs; a copy off PATH is added.
    let mut cached = cached_check(tool, inp, machine, &copies);
    if let Some(runs) = cached.as_ref().and_then(|c| c.runs.clone()) {
        if copy_index(&copies, &runs, w).is_none() {
            if let Look::Found(look) = machine.look(&runs) {
                copies.push(make_copy(tool, runs, None, look, inp));
            }
        }
    }
    for copy in &mut copies {
        copy.in_install_dir = install
            .as_deref()
            .is_some_and(|dir| parent(&copy.path, w).is_some_and(|p| norm(p, w) == norm(dir, w)));
    }
    probe_all(&mut copies, inp, machine);

    // R4 (B2): what a spawn runs is the snapshot's rule — the first
    // executable copy on PATH, unless it certainly doesn't start and a later
    // one does (`shell_env::choose_copy`), so the look and the tiles agree.
    let now_idx = chosen_on_path(&copies, inp.path_override);
    let running_idx = match &inp.cached {
        Cached::Unknown => now_idx.or_else(|| copies.iter().position(|c| c.path_rank.is_some() && c.real_path.is_some())),
        Cached::Absent => None,
        Cached::Path(_) => cached.as_ref().and_then(|c| c.runs.as_deref()).and_then(|r| copy_index(&copies, r, w)),
    };
    let working_idx = copies.iter().position(|c| c.start.as_ref().is_some_and(|s| s.starts));
    if let Some(check) = cached.as_mut() {
        if let Some(i) = now_idx {
            check.now = Some(copies[i].path.clone());
        }
        let runs = check.runs.as_deref().and_then(|r| copy_index(&copies, r, w));
        let now = check.now.as_deref().and_then(|n| copy_index(&copies, n, w));
        check.matches_now = runs.is_some() && runs == now;
    }
    let running = running_idx.map(|i| copies[i].clone());

    let plan = folder_plan(tool, inp, &copies, running.as_ref());
    let folders: Vec<FolderCheck> = plan
        .into_iter()
        .map(|f| {
            let look = machine.folder(&f.path, f.kind);
            let tested = look.checked.clone().unwrap_or_else(|| f.path.clone());
            FolderCheck {
                system_folder: is_system_folder(&tested, inp),
                path: f.path,
                kind: f.kind,
                role: f.role,
                channel: f.channel,
                needed_now: f.needed_now,
                exists: look.exists,
                checked: look.checked,
                owned_by_user: look.owned,
                writable: look.writable,
            }
        })
        .collect();

    let look = Looked {
        copies: &copies,
        folders: &folders,
        running: running_idx,
        working: working_idx,
        cached: cached.as_ref(),
        install: install.as_deref(),
        unreadable_dirs: &unreadable_dirs,
    };
    let findings = findings_for(inp, &look);
    let healthy = is_healthy(&look);
    CliHealth {
        tool,
        healthy,
        runs_today: running.map(|c| c.path),
        should_run: working_idx.map(|i| copies[i].path.clone()),
        install_dir: install,
        cached,
        copies,
        folders,
        findings,
        passed_over: None,
    }
}

/// A copy's `--version` certainly failed (not a timeout, not unrun).
pub fn fails_for_certain(c: &CliCopy) -> bool {
    c.start.as_ref().is_some_and(|s| !s.starts && !s.inconclusive)
}

/// R4 (B2): the copy the snapshot's rule picks among those on PATH —
/// exactly `shell_env::choose_copy`'s: the first, unless it certainly
/// doesn't start; then the first later one that starts, else the first later
/// one that only didn't answer in time (slow is not broken), else the first.
/// Under a PATH override (`override_set`) the first is never passed over.
pub(crate) fn chosen_on_path(copies: &[CliCopy], override_set: bool) -> Option<usize> {
    let mut on_path: Vec<usize> = (0..copies.len()).filter(|&i| copies[i].path_rank.is_some() && copies[i].executable).collect();
    on_path.sort_by_key(|&i| copies[i].path_rank);
    let first = *on_path.first()?;
    if override_set || !fails_for_certain(&copies[first]) {
        return Some(first);
    }
    let later = || on_path.iter().copied().skip(1);
    Some(
        later()
            .find(|&i| copies[i].start.as_ref().is_some_and(|s| s.starts))
            .or_else(|| later().find(|&i| copies[i].start.as_ref().is_some_and(|s| s.inconclusive)))
            .unwrap_or(first),
    )
}

/// R4 (B2): whether the folders the updater of the copy at `path` writes
/// can all be written (its own channel's, as [`folder_plan`] lists them for
/// the copy that runs). No `--version` is run. `None` when there is no such
/// file. Setup's Update asks this before `claude update` or npm runs.
pub fn update_folders_writable(tool: CliTool, path: &str, inp: &Inputs, machine: &dyn Machine) -> Option<bool> {
    let Look::Found(look) = machine.look(path) else { return None };
    let copy = make_copy(tool, path.to_string(), None, look, inp);
    let plan = folder_plan(tool, inp, std::slice::from_ref(&copy), Some(&copy));
    Some(plan.iter().filter(|f| f.needed_now).all(|f| machine.folder(&f.path, f.kind).writable))
}

/// What [`inspect`] found, for the verdicts.
struct Looked<'a> {
    copies: &'a [CliCopy],
    folders: &'a [FolderCheck],
    running: Option<usize>,
    working: Option<usize>,
    cached: Option<&'a CachedCheck>,
    install: Option<&'a str>,
    unreadable_dirs: &'a [String],
}

/// The copy `path` is (found there, or the same real file).
fn copy_index(copies: &[CliCopy], path: &str, w: bool) -> Option<usize> {
    let key = norm(path, w);
    copies.iter().position(|c| {
        norm(&c.path, w) == key
            || c.also_at.iter().any(|a| norm(a, w) == key)
            || c.real_path.as_deref().is_some_and(|r| norm(r, w) == key)
    })
}

fn make_copy(tool: CliTool, path: String, rank: Option<usize>, look: FileLook, inp: &Inputs) -> CliCopy {
    let dangling = look.real_path.is_none() && !look.target_unreadable;
    let resolved = look.real_path.as_deref().or(look.chain_end.as_deref());
    let channel = classify(tool, &path, resolved, inp);
    // R9: judged on the textual end of the link (or where it was found), not
    // the canonical path: a home reached through a link (`/Users/u/x` →
    // `/Volumes/…`) is still the home.
    let system_folder = is_system_folder(look.chain_end.as_deref().unwrap_or(&path), inp);
    CliCopy {
        also_at: Vec::new(),
        dangling,
        unreadable: look.target_unreadable,
        executable: look.executable && look.real_path.is_some(),
        link_target: look.link_target,
        link_end: look.chain_end,
        real_path: look.real_path,
        path_rank: rank,
        in_install_dir: false,
        owned_by_user: look.owned,
        folder_owned_by_user: look.folder_owned,
        system_folder,
        channel,
        start: None,
        starts_with_shell: None,
        path,
    }
}

/// Every copy on PATH (in order), then in the known folders, one per real
/// file; and the PATH folders that couldn't be read.
fn find_copies(tool: CliTool, inp: &Inputs, machine: &dyn Machine) -> (Vec<CliCopy>, Vec<String>) {
    let w = inp.windows;
    let mut dirs: Vec<(String, Option<usize>)> = Vec::new();
    for (rank, dir) in split_path(&inp.path, w) {
        if !dirs.iter().any(|(d, _)| norm(d, w) == norm(&dir, w)) {
            dirs.push((dir, Some(rank)));
        }
    }
    for dir in known_dirs(tool, inp) {
        if !dirs.iter().any(|(d, _)| norm(d, w) == norm(&dir, w)) {
            dirs.push((dir, None));
        }
    }
    let names = program_names(tool, inp);
    let mut copies: Vec<CliCopy> = Vec::new();
    let mut unreadable: Vec<String> = Vec::new();
    for (dir, rank) in dirs {
        for name in &names {
            let path = join(&dir, &[name], w);
            let look = match machine.look(&path) {
                Look::Absent => continue,
                Look::Unreadable => {
                    if !unreadable.contains(&dir) {
                        unreadable.push(dir.clone());
                    }
                    continue;
                }
                Look::Found(look) => look,
            };
            if look.real_path.is_some() && !look.is_file {
                continue; // a folder of that name
            }
            let key = norm(look.real_path.as_deref().unwrap_or(&path), w);
            if let Some(same) = copies
                .iter_mut()
                .find(|c| norm(c.real_path.as_deref().unwrap_or(&c.path), w) == key)
            {
                if norm(&same.path, w) != norm(&path, w) {
                    same.also_at.push(path);
                }
                continue;
            }
            copies.push(make_copy(tool, path, rank, look, inp));
        }
    }
    (copies, unreadable)
}

/// The cached path checked against the disk; `None` without a snapshot.
fn cached_check(tool: CliTool, inp: &Inputs, machine: &dyn Machine, copies: &[CliCopy]) -> Option<CachedCheck> {
    let w = inp.windows;
    // What the disk resolves now, as `resolve_program`: the first executable
    // file on PATH.
    let now = copies.iter().find(|c| c.path_rank.is_some() && c.executable).map(|c| c.path.clone());
    let path = match &inp.cached {
        Cached::Unknown => return None,
        Cached::Absent => None,
        Cached::Path(p) => Some(p.clone()),
    };
    let (mut runs, mut exists, mut executable) = (None, false, false);
    if let Some(p) = path.as_deref() {
        let has_sep = if w { p.contains(['/', '\\']) } else { p.contains('/') };
        if has_sep {
            if let Look::Found(look) = machine.look(p) {
                exists = look.real_path.is_some() && look.is_file;
                executable = exists && look.executable;
                runs = exists.then(|| p.to_string());
            }
        } else {
            // A bare name: a spawn looks it up on PATH.
            let names = if p == tool.program() { program_names(tool, inp) } else { vec![p.to_string()] };
            let found = split_path(&inp.path, w).into_iter().find_map(|(_, dir)| {
                names.iter().find_map(|name| {
                    let candidate = join(&dir, &[name], w);
                    match machine.look(&candidate) {
                        Look::Found(look) if look.executable && look.real_path.is_some() => Some(candidate),
                        _ => None,
                    }
                })
            });
            exists = found.is_some();
            executable = exists;
            runs = found;
        }
    }
    Some(CachedCheck { path, runs, exists, executable, usable: exists && executable, now, matches_now: false })
}

/// Every runnable copy's `--version`, in parallel; those past the first
/// bound once more with the longer one.
fn probe_all(copies: &mut [CliCopy], inp: &Inputs, machine: &dyn Machine) {
    let (first, second) = inp.version_bounds.unwrap_or((VERSION_TIMEOUT, VERSION_RETRY_TIMEOUT));
    // 1.176.1 (Windows walk): a copy outside the override whose way to run
    // can't be told (the shell's folders unknown) is inconclusive, never a
    // certain failure.
    let mut runnable: Vec<usize> = Vec::new();
    let executable: Vec<usize> = (0..copies.len()).filter(|&i| copies[i].executable).collect();
    for i in executable {
        if probe_path(&copies[i], inp).is_some() {
            runnable.push(i);
        } else {
            copies[i].start = Some(start_from(RunOutcome::TimedOut));
        }
    }
    let outcomes = run_all(copies, &runnable, inp, machine, first);
    let mut again = Vec::new();
    for (i, outcome) in outcomes {
        if outcome == RunOutcome::TimedOut {
            again.push(i);
        } else {
            copies[i].start = Some(start_from(outcome));
        }
    }
    if inp.no_retry {
        for i in again {
            copies[i].start = Some(start_from(RunOutcome::TimedOut));
        }
        return;
    }
    for (i, outcome) in run_all(copies, &again, inp, machine, second) {
        copies[i].start = Some(start_from(outcome));
    }
    shell_recheck(copies, inp, machine, first);
}

/// 1.176.1 (Windows walk): the PATH a copy's `--version` runs with. A copy on
/// the list (or with no override) gets the PATH tiles get; one outside an
/// override gets its own folder and what the shell reports, as it would run
/// once reachable. `None`: an outside copy while the shell's folders are
/// unknown.
pub fn probe_path(copy: &CliCopy, inp: &Inputs) -> Option<String> {
    if !inp.path_override || copy.path_rank.is_some() {
        return Some(inp.path.clone());
    }
    let shell = inp.shell_path.as_deref()?;
    let sep = if inp.windows { ';' } else { ':' };
    Some(match parent(&copy.path, inp.windows) {
        Some(dir) => format!("{dir}{sep}{shell}"),
        None => shell.to_string(),
    })
}

/// 1.176.1 (Windows walk): under an override, a copy on the list that
/// certainly doesn't start is asked once more with the shell's folders: when
/// it starts then, the list leaves out what it needs (`starts_with_shell`).
fn shell_recheck(copies: &mut [CliCopy], inp: &Inputs, machine: &dyn Machine, timeout: Duration) {
    let Some(shell) = inp.shell_path.as_deref().filter(|_| inp.path_override) else { return };
    let which: Vec<usize> =
        (0..copies.len()).filter(|&i| copies[i].path_rank.is_some() && fails_for_certain(&copies[i])).collect();
    let sep = if inp.windows { ';' } else { ':' };
    let answers: Vec<(usize, RunOutcome)> = std::thread::scope(|scope| {
        let handles: Vec<_> = which
            .iter()
            .map(|&i| {
                let program = copies[i].path.clone();
                let env = match parent(&program, inp.windows) {
                    Some(dir) => format!("{dir}{sep}{shell}"),
                    None => shell.to_string(),
                };
                (i, scope.spawn(move || machine.run_version(&program, &env, timeout)))
            })
            .collect();
        handles.into_iter().map(|(i, h)| (i, h.join().unwrap_or(RunOutcome::Unreadable))).collect()
    });
    for (i, outcome) in answers {
        copies[i].starts_with_shell = Some(start_from(outcome).starts);
    }
}

fn run_all(
    copies: &[CliCopy],
    which: &[usize],
    inp: &Inputs,
    machine: &dyn Machine,
    timeout: Duration,
) -> Vec<(usize, RunOutcome)> {
    std::thread::scope(|scope| {
        let handles: Vec<_> = which
            .iter()
            .map(|&i| {
                let path = copies[i].path.as_str();
                let env = probe_path(&copies[i], inp).unwrap_or_else(|| inp.path.clone());
                (i, scope.spawn(move || machine.run_version(path, &env, timeout)))
            })
            .collect();
        handles
            .into_iter()
            .map(|(i, h)| (i, h.join().unwrap_or(RunOutcome::Unreadable)))
            .collect()
    })
}

/// The copies that count for `healthy`: on PATH, in the install folder, or
/// what a tile runs. A stale leftover elsewhere (a broken `~/.claude/local`
/// link off PATH) is reported but doesn't nag a working machine.
fn counts(look: &Looked, i: usize) -> bool {
    let c = &look.copies[i];
    c.path_rank.is_some() || c.in_install_dir || look.running == Some(i)
}

fn is_healthy(look: &Looked) -> bool {
    let (Some(running), Some(working)) = (look.running, look.working) else { return false };
    let copy = &look.copies[running];
    let counted = (0..look.copies.len()).filter(|&i| counts(look, i)).count();
    counted == 1
        && running == working
        && look.cached.is_none_or(|c| c.usable)
        && look.folders.iter().filter(|f| f.needed_now).all(|f| f.writable)
        && !(copy.owned_by_user == Some(false) && !copy.system_folder)
}

fn findings_for(inp: &Inputs, look: &Looked) -> Vec<Finding> {
    let copies = look.copies;
    let mut out = Vec::new();
    let any_inconclusive = copies.iter().any(|c| c.start.as_ref().is_some_and(|s| s.inconclusive));
    if copies.is_empty() {
        out.push(Finding::Missing);
    } else if look.working.is_none() && !any_inconclusive {
        out.push(Finding::NoWorkingCopy);
    }
    if let Some(c) = look.cached {
        // R9: nothing cached and nothing on disk agree: the tool is missing,
        // not a stale path.
        let both_empty = c.path.is_none() && c.now.is_none();
        if !both_empty && (!c.usable || !c.matches_now) {
            out.push(Finding::CachedPathStale { cached: c.path.clone(), now: c.now.clone(), usable: c.usable });
        }
    }
    if let Some(working) = look.working {
        if look.running != Some(working) {
            let first = look.running.map(|i| copies[i].path.clone());
            let k = &copies[working];
            out.push(Finding::FirstOnPathIsNotTheWorkingOne {
                first,
                working: k.path.clone(),
                working_on_path: k.path_rank.is_some(),
            });
        }
    }
    for copy in copies {
        let Some(start) = copy.start.as_ref().filter(|s| !s.starts) else { continue };
        if start.inconclusive {
            out.push(Finding::StartInconclusive { path: copy.path.clone() });
        } else {
            out.push(Finding::DoesNotStart {
                path: copy.path.clone(),
                failure: start.failure.unwrap_or(StartFailure::Exited),
                exit_code: start.exit_code,
                signal: start.signal,
                tail: start.tail.clone(),
            });
        }
    }
    for copy in copies.iter().filter(|c| c.dangling) {
        out.push(Finding::DanglingLink {
            path: copy.path.clone(),
            target: copy.link_end.clone().or_else(|| copy.link_target.clone()),
            channel: copy.channel,
        });
    }
    for copy in copies.iter().filter(|c| c.real_path.is_some() && !c.executable) {
        out.push(Finding::NotExecutable { path: copy.path.clone() });
    }
    let mut unreadable: Vec<String> = look.unreadable_dirs.to_vec();
    unreadable.extend(copies.iter().filter(|c| c.unreadable).map(|c| c.path.clone()));
    if !unreadable.is_empty() {
        out.push(Finding::Unreadable { paths: unreadable });
    }
    for copy in copies.iter().filter(|c| c.real_path.is_some() && c.owned_by_user == Some(false)) {
        out.push(Finding::CopyNotOwned { path: copy.path.clone(), system_folder: copy.system_folder });
    }
    let mut not_writable: Vec<FolderRef> = Vec::new();
    let mut not_owned: Vec<FolderRef> = Vec::new();
    let put = |list: &mut Vec<FolderRef>, f: &FolderCheck| {
        let path = f.checked.clone().unwrap_or_else(|| f.path.clone());
        match list.iter_mut().find(|r| r.path == path) {
            Some(r) => r.needed_now |= f.needed_now,
            None => list.push(FolderRef { path, needed_now: f.needed_now, system_folder: f.system_folder }),
        }
    };
    for f in look.folders {
        if !f.writable {
            put(&mut not_writable, f);
        }
        if f.owned_by_user == Some(false) && !f.system_folder {
            put(&mut not_owned, f);
        }
    }
    if !not_writable.is_empty() {
        out.push(Finding::FoldersNotWritable { folders: not_writable });
    }
    if !not_owned.is_empty() {
        out.push(Finding::FoldersNotOwned { folders: not_owned });
    }
    let real: Vec<String> = copies.iter().filter(|c| !c.dangling).map(|c| c.path.clone()).collect();
    if real.len() > 1 {
        out.push(Finding::SeveralCopies { paths: real });
    }
    if let Some(dir) = look.install {
        if copies.iter().any(|c| c.in_install_dir) && !on_path(dir, inp) {
            out.push(Finding::NativeDirNotOnPath { dir: dir.to_string() });
        }
    }
    out
}

// ---------------------------------------------------------------- IPC

/// `cli_health(tool)`: the look at `claude` or `codex` with the PATH tiles
/// get and the path the snapshot cached, off the IPC thread (the
/// `--version` probes take up to [`VERSION_TIMEOUT`] + [`VERSION_RETRY_TIMEOUT`]).
#[tauri::command]
pub async fn cli_health(tool: String) -> Result<CliHealth, String> {
    let tool = CliTool::parse(&tool).ok_or_else(|| format!("No such AI tool: {tool}"))?;
    tauri::async_runtime::spawn_blocking(move || inspect_now(tool))
        .await
        .map_err(|e| format!("cli health worker failed: {e}"))
}

/// This machine's inputs for `tool`: the PATH tiles get and the path the
/// snapshot cached (`Unknown` before the first probe).
pub fn inputs_now(tool: CliTool) -> Inputs {
    let (path, cached) = match crate::shell_env::try_get() {
        Some(env) => {
            let cached = match tool {
                CliTool::Claude => env.claude_path.clone(),
                CliTool::Codex => env.codex_path.clone(),
            };
            (env.path.clone(), cached.map_or(Cached::Absent, Cached::Path))
        }
        None => (std::env::var("PATH").unwrap_or_default(), Cached::Unknown),
    };
    let mut inputs = Inputs::from_process(&path, cached);
    inputs.path_override = crate::shell_env::path_override().is_some();
    if inputs.path_override {
        inputs.shell_path = crate::shell_env::shell_reported_path();
    }
    inputs
}

/// A fresh look at `tool` on this machine (blocking: up to the two
/// `--version` bounds). R4's Repair runs it before every plan and step.
pub fn inspect_now(tool: CliTool) -> CliHealth {
    let mut health = inspect(tool, &inputs_now(tool), &SystemMachine);
    health.passed_over = passed_over_now(tool);
    health
}

/// What the snapshot passed over for `tool`.
pub fn passed_over_now(tool: CliTool) -> Option<crate::shell_env::PassedOver> {
    let env = crate::shell_env::try_get()?;
    match tool {
        CliTool::Claude => env.claude_path_skipped.clone(),
        CliTool::Codex => env.codex_path_skipped.clone(),
    }
}

#[cfg(test)]
#[path = "cli_health_tests.rs"]
mod tests;
