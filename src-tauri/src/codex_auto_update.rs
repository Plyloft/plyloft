//! 1.176.0 R5 (plan blind spot 14, owner decision D4): the hidden automatic
//! Codex update, made safe.
//!
//! Before R5 the window started `<codex> update` when a Codex tile opened
//! and the last try was over a day old — at the moment the tile spawned,
//! whatever the install channel (on an npm install that ran npm against a
//! prefix that might be root's, or another one), re-reading nothing when it
//! failed, with a timeout that always advised `npm install -g`, and keeping
//! only the time of the try in the window's localStorage.
//!
//! Now the backend owns it:
//!
//! - **When.** A background thread ([`start`]) looks once a minute (a timed
//!   wait, woken at quit and when Setup keeps a Codex run). It runs the
//!   update only when one is due (a day after the last attempt that counts,
//!   kept on disk and in memory) and Codex has been idle for [`IDLE_QUIET`]:
//!   no Codex tile, App Server session (`codex-chat`, a card chat), headless
//!   run or reviewer, no Setup or Repair run, no Codex start since. Opening a
//!   tile never starts it. Busy is a typed answer ([`Busy`]), never an
//!   error. Another Plyloft (a second profile) is kept out by a lock file
//!   ([`AttemptLock`]); on Windows a Codex Plyloft didn't start (a shell, the
//!   person's own terminal) is found by its image path ([`image_under`]).
//! - **Starts during an update** go through the [`Gate`], at the two places
//!   every Codex start passes: the PTY spawn's coordination reservation
//!   (`PtyRegistry::begin_coordination`: tiles, Builders, intake, reviewers,
//!   agent runs, swarms) and the App Server's start (`codex_app::start_with`:
//!   `codex-chat`, card chats). The tile's own check before its spawn
//!   (`cli_fresh_check`) waits for the update, at most [`START_WAIT`], while
//!   the tile says why. Past that the start goes ahead on macOS (R0 X8: a
//!   running Codex survives an update; the standalone installer swaps its
//!   `current` link in one rename). On Windows a program that runs is a
//!   locked file: there the update is stopped (its process tree killed; the
//!   installer stages a release before switching) and every start, waiting
//!   or not, waits for that tree to end ([`STOP_WAIT`]) before it spawns.
//! - **What.** [`plan`]: only a Codex that starts, that tiles really run,
//!   whose folders are writable (`cli_health`), and only a channel Plyloft
//!   may drive unattended: the standalone install (`codex update`, or
//!   `install.ps1` on Windows, as `doctor::codex_update_cmd` names them) and
//!   npm through its own prefix's npm, prefix pinned. Homebrew and winget
//!   are skipped — the Update row in Diagnostics stays the way. Nothing runs
//!   when the vendor's feed says nothing is newer.
//! - **Judging.** R2's rules (`setup_outcome`, `setup_run::update_outcome`),
//!   stricter where only a newer release makes it run ([`judge`]). Codex is
//!   always looked at again afterwards (`cli_fresh`), unless Plyloft quits.
//! - **Kept.** Each attempt is the `codex-auto-update` entry of
//!   `setup_last_runs.json`; an update that ran is also Codex's last run
//!   there (`codex`, action [`ACTION_ID`]) for a later Repair. A stopped
//!   attempt and a skip that can clear soon don't use up the day
//!   ([`counts`]); they are retried after [`retry_in`].
//! - **Told.** One event at the end (`codex-update://done`) with the notice
//!   the window shows, if any ([`notice`]): a failure leaving Codex on its
//!   old version is told once per version and cause, not every day.
//!
//! Quitting stops it (Hard Rule 4): [`shutdown`] kills its process tree.

use parking_lot::{Condvar, Mutex};
use serde::Serialize;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::cli_health::{CliHealth, CliTool, FolderKind, InstallChannel, Machine};
use crate::setup_actions::PlanFacts;
use crate::setup_last_run::LastRun;
use crate::setup_outcome::{self as evidence, Cause, VersionChange};
use crate::setup_run::Outcome;

// ── Constants ──────────────────────────────────────────────────────────

/// The spacing between two attempts that count (as before R5).
pub const INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// How long Codex must have been idle before the update runs.
pub const IDLE_QUIET: Duration = Duration::from_secs(3 * 60);
/// How often the thread looks.
pub const TICK: Duration = Duration::from_secs(60);
/// A Codex start counts as live this long before its session is registered.
pub const START_GRACE: Duration = Duration::from_secs(60);
/// How long a tile's start waits for an update under way.
pub const START_WAIT: Duration = Duration::from_secs(2 * 60);
/// Windows: how long a start then waits for the stopped update to end.
pub const STOP_WAIT: Duration = Duration::from_secs(30);
/// How long the update may run: a ~265 MB download on a home connection.
pub const TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// The vendor's feed didn't answer (offline): look again after this.
pub const NO_LATEST_RETRY: Duration = Duration::from_secs(30 * 60);
/// A skip that can clear in a minute (a slow `--version`, a stale path).
pub const TRANSIENT_RETRY: Duration = Duration::from_secs(10 * 60);
/// A stopped update is tried again after these; past them, the next day.
pub const STOPPED_RETRIES: [Duration; 2] = [Duration::from_secs(10 * 60), Duration::from_secs(30 * 60)];
/// Another Plyloft's lock older than this is stale (its attempt is bounded).
pub const LOCK_STALE: Duration = Duration::from_secs(25 * 60);
/// Captured output per stream: the tail, where an updater says why.
const OUTPUT_CAP: usize = 64 * 1024;
/// Lines of output the record and the event keep.
const TAIL_LINES: usize = 60;

/// The record's own entry, beside the tools' (`setup_last_run`).
pub const RECORD_KEY: &str = "codex-auto-update";
/// The action id an automatic update is kept under.
pub const ACTION_ID: &str = "auto-update.codex";

pub const STATE_EVENT: &str = "codex-update://state";
pub const DONE_EVENT: &str = "codex-update://done";

/// Setup refuses a Codex step while the automatic update runs.
pub const SETUP_REFUSED: &str =
    "Codex is updating in the background. Try again in a few minutes, when it's done.";

// ── Busy ───────────────────────────────────────────────────────────────

/// Why the update doesn't run now. Not an error: it runs later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Busy {
    /// A Codex tile, App Server session, headless run or reviewer is live.
    CodexRunning,
    /// A Codex start is under way (its session isn't registered yet).
    CodexStarting,
    /// Windows: a Codex Plyloft didn't start runs from the copy to replace.
    CodexRunningElsewhere,
    /// Setup's guided terminal is running a step.
    SetupRunning,
    /// A Repair of Codex is running (card R4).
    RepairRunning,
    /// Another Plyloft is updating Codex.
    OtherInstance,
    /// An update is already running.
    Updating,
    Quitting,
}

/// What is live, as the impure side counted it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Live {
    /// Codex processes: coordination sessions of provider Codex (tiles,
    /// agent runs, reviewers), `codex-chat` App Servers, card chats.
    pub codex_sessions: usize,
    pub setup_running: bool,
    /// Card R4's Repair runner, working on Codex ([`repair_running`]).
    pub repair_running: bool,
}

/// Pure: whether `live` keeps the update from starting.
pub fn busy_reason(live: &Live) -> Option<Busy> {
    if live.codex_sessions > 0 {
        Some(Busy::CodexRunning)
    } else if live.setup_running {
        Some(Busy::SetupRunning)
    } else if live.repair_running {
        Some(Busy::RepairRunning)
    } else {
        None
    }
}

/// Card R4's side: a Setup or Repair run of `tool` is under way
/// (`cli_repair_run::tool_run_active`). R4's runner, for its part, refuses a
/// Codex step while [`updating`] is true (`cli_repair_run::update_blocks_step`).
pub fn repair_running<R: Runtime>(app: &AppHandle<R>, tool: CliTool) -> bool {
    crate::cli_repair_run::tool_run_active(app, tool)
}

// ── Due ────────────────────────────────────────────────────────────────

fn parse_time(value: Option<&str>) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(value?).ok().map(|t| t.with_timezone(&chrono::Utc))
}

/// Pure: an entry uses up the day. A stopped attempt (Plyloft quitting, a
/// Windows start that waited its limit) doesn't, nor a skip that can clear
/// in a minute ([`Skip::transient`]).
pub fn counts(run: &LastRun) -> bool {
    match run.outcome.as_deref() {
        Some("cancelled") => false,
        Some("skipped") => !run.cause.as_deref().is_some_and(|c| Skip::from_wire(c).is_some_and(Skip::transient)),
        _ => true,
    }
}

/// Pure: when Codex was last updated or tried, of the entries that count:
/// this updater's own, or a guided install or update of Codex (Setup's
/// `codex` entry).
pub fn last_attempt(auto: Option<&LastRun>, codex: Option<&LastRun>) -> Option<chrono::DateTime<chrono::Utc>> {
    let of = |run: &LastRun| parse_time(run.finished_at.as_deref()).or_else(|| parse_time(run.started_at.as_deref()));
    let codex = codex.filter(|run| matches!(run.action_id.as_str(), "update.codex" | "install.codex" | ACTION_ID));
    [auto, codex].into_iter().flatten().filter(|run| counts(run)).filter_map(of).max()
}

/// Pure: an attempt is due. No record (a first launch, or the window's old
/// localStorage time that R5 no longer reads) is due; so is a record from
/// the future (a clock set back), which would otherwise hold it off.
pub fn due(now: chrono::DateTime<chrono::Utc>, last: Option<chrono::DateTime<chrono::Utc>>) -> bool {
    let Some(last) = last else { return true };
    let since = now.signed_duration_since(last);
    since < chrono::Duration::zero() - chrono::Duration::hours(1)
        || since >= chrono::Duration::from_std(INTERVAL).unwrap_or(chrono::Duration::days(1))
}

/// Pure: a skip kept for the day whose facts changed since — the Codex
/// tiles run is another file, or answers another version (a reinstall, a
/// Repair, an update by hand): looked at again now, not tomorrow.
pub fn skip_facts_changed(auto: Option<&LastRun>, path: Option<&str>, version: Option<&str>) -> bool {
    auto.is_some_and(|run| {
        run.outcome.as_deref() == Some("skipped") && (run.cause_path.as_deref() != path || run.version_before.as_deref() != version)
    })
}

/// Pure: the thread runs an attempt now.
pub fn ready(due: bool, idle_for: Duration, retry_left: bool) -> bool {
    due && !retry_left && idle_for >= IDLE_QUIET
}

/// How an attempt ended, for the thread's next look.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum After {
    /// It ran to its end, or a skip or "nothing newer" kept for the day.
    Done,
    Busy,
    NoLatest,
    /// A skip that can clear soon.
    Transient,
    /// The update was stopped (a Windows start; Plyloft quitting).
    Stopped,
}

/// Pure: how long the thread holds off before the next attempt, besides
/// the day's spacing. A stopped update is tried again after 10, then 30
/// minutes, then not before the next day: a person who keeps opening
/// Codex on Windows never causes a download loop.
pub fn retry_in(after: After, stops_in_a_row: u32) -> Option<Duration> {
    match after {
        After::Done | After::Busy => None,
        After::NoLatest => Some(NO_LATEST_RETRY),
        After::Transient => Some(TRANSIENT_RETRY),
        After::Stopped => Some(
            STOPPED_RETRIES
                .get(stops_in_a_row.saturating_sub(1) as usize)
                .copied()
                .unwrap_or(INTERVAL),
        ),
    }
}

// ── What runs ──────────────────────────────────────────────────────────

/// The command an attempt runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateCommand {
    pub argv: Vec<String>,
    /// Added to the run's environment (npm's prefix).
    pub env: Vec<(String, String)>,
    /// Put first on the run's PATH (the npm prefix's `bin`, so its
    /// `#!/usr/bin/env node` finds the prefix's node).
    pub path_first: Option<String>,
    /// As `doctor::codex_update_cmd` names it: for the log and the record.
    pub display: String,
    pub channel: InstallChannel,
    /// The folders whose programs the run replaces (Windows: a process
    /// running from one of them holds the update back).
    pub replaces: Vec<String>,
}

/// Why an attempt ran nothing. Kept in the record; never shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Skip {
    /// No Codex that tiles run.
    NotFound,
    /// The Codex tiles run doesn't start: never updated through itself.
    NotStarting,
    /// Its `--version` didn't answer in time, twice: not proof it starts.
    StartUnknown,
    /// The path tiles run isn't on disk, or isn't what the disk resolves.
    NotWhatTilesRun,
    /// A folder its update writes isn't this user's to write.
    NotWritable,
    /// `brew upgrade` updates Homebrew and can upgrade other formulae, and
    /// takes long: not for a run nobody sees.
    Homebrew,
    /// winget may ask for an administrator.
    Winget,
    /// Bun, pnpm, Scoop, a version manager, an unknown place: no command.
    UnknownChannel,
    /// An npm install, but npm or its prefix wasn't found.
    NoNpm,
    NoPowershell,
}

impl Skip {
    const ALL: [Skip; 10] = [
        Skip::NotFound,
        Skip::NotStarting,
        Skip::StartUnknown,
        Skip::NotWhatTilesRun,
        Skip::NotWritable,
        Skip::Homebrew,
        Skip::Winget,
        Skip::UnknownChannel,
        Skip::NoNpm,
        Skip::NoPowershell,
    ];

    /// Can clear in a minute: tried again soon, never kept for the day.
    pub fn transient(self) -> bool {
        matches!(self, Skip::StartUnknown | Skip::NotWhatTilesRun)
    }

    pub fn from_wire(name: &str) -> Option<Skip> {
        Skip::ALL.into_iter().find(|s| wire(s) == name)
    }
}

/// What one attempt does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    Run(UpdateCommand),
    /// The feed's latest is not newer than the version installed.
    NothingNewer,
    /// The feed didn't answer: try again after [`NO_LATEST_RETRY`].
    NoLatest,
    Skip(Skip),
}

/// What [`plan`] asks the disk.
pub trait Disk {
    fn exists(&self, path: &str) -> bool;
    /// A folder (or, missing, its nearest existing parent) is writable.
    fn writable(&self, path: &str) -> bool;
    /// npm's cache folder (`npm_config_cache`, else npm's default).
    fn npm_cache(&self) -> Option<String>;
    /// R4's rule for Setup's Update (`cli_health::update_folders_writable`):
    /// the folders the updater of the copy at `path` writes can be written.
    fn update_writable(&self, path: &str) -> Option<bool>;
}

/// The real disk, with the look's inputs.
pub struct SystemDisk<'a> {
    pub inputs: &'a crate::cli_health::Inputs,
}

impl Disk for SystemDisk<'_> {
    fn exists(&self, path: &str) -> bool {
        std::path::Path::new(path).is_file()
    }

    fn writable(&self, path: &str) -> bool {
        crate::cli_health::SystemMachine.folder(path, FolderKind::Dir).writable
    }

    fn npm_cache(&self) -> Option<String> {
        let var = |key: &str| std::env::var(key).ok().filter(|v| !v.trim().is_empty());
        if let Some(cache) = var("npm_config_cache").or_else(|| var("NPM_CONFIG_CACHE")) {
            return Some(cache);
        }
        if cfg!(windows) {
            var("LOCALAPPDATA").map(|d| format!(r"{d}\npm-cache"))
        } else {
            crate::platform::home_dir().map(|h| h.join(".npm").to_string_lossy().into_owned())
        }
    }

    fn update_writable(&self, path: &str) -> Option<bool> {
        crate::cli_health::update_folders_writable(CliTool::Codex, path, self.inputs, &crate::cli_health::SystemMachine)
    }
}

/// Pure: npm's prefix from the package's parent folder
/// (`<prefix>/lib/node_modules/@openai`; `<prefix>\node_modules\@openai` on
/// Windows).
pub fn npm_prefix_of(package_parent: &str, windows: bool) -> Option<String> {
    let suffix = if windows { "/node_modules/@openai" } else { "/lib/node_modules/@openai" };
    let slashed = package_parent.replace('\\', "/");
    let lower = slashed.to_ascii_lowercase();
    let trimmed = lower.trim_end_matches('/');
    let cut = trimmed.strip_suffix(suffix)?.len();
    (cut > 0).then(|| package_parent[..cut].to_string())
}

/// Pure: the prefix's own npm and the folder put first on PATH for it.
pub fn npm_in_prefix(prefix: &str, windows: bool) -> (String, String) {
    if windows {
        (format!(r"{prefix}\npm.cmd"), prefix.to_string())
    } else {
        (format!("{prefix}/bin/npm"), format!("{prefix}/bin"))
    }
}

/// PATH with `~/.local/bin` on it (the standalone installer otherwise adds
/// it to `~/.zprofile`, R0 X1) and `first` in front.
pub fn path_for_run(path: &str, home: Option<&str>, first: Option<&str>, windows: bool) -> String {
    let sep = if windows { ";" } else { ":" };
    let mut out = path.to_string();
    if let Some(home) = home.filter(|h| !h.is_empty() && !windows) {
        let bin = format!("{}/.local/bin", home.trim_end_matches('/'));
        if !out.split(':').any(|dir| dir.trim_end_matches('/') == bin) {
            out = if out.is_empty() { bin } else { format!("{out}:{bin}") };
        }
    }
    match first {
        Some(first) if !first.is_empty() => {
            if out.is_empty() {
                first.to_string()
            } else {
                format!("{first}{sep}{out}")
            }
        }
        _ => out,
    }
}

fn parent_dir(path: &str) -> Option<String> {
    let cut = path.rfind(['/', '\\'])?;
    (cut > 0).then(|| path[..cut].to_string())
}

/// Pure: what an attempt does on this machine. `health` is `cli_health`'s
/// look at Codex; `facts` the programs Setup would use; `version` the
/// version tiles run now; `latest` the vendor feed's.
pub fn plan(health: &CliHealth, facts: &PlanFacts, version: Option<&str>, latest: Option<&str>, disk: &dyn Disk) -> Plan {
    let w = facts.windows;
    let Some(runs) = health.runs_today.as_deref() else { return Plan::Skip(Skip::NotFound) };
    let Some(copy) = health.copies.iter().find(|c| c.path == runs) else { return Plan::Skip(Skip::NotFound) };
    match &copy.start {
        Some(start) if start.starts => {}
        Some(start) if start.inconclusive => return Plan::Skip(Skip::StartUnknown),
        _ => return Plan::Skip(Skip::NotStarting),
    }
    // R4: the snapshot may run a copy that isn't first on PATH on purpose
    // (`shell_env::choose_copy` passed over one that doesn't start); only a
    // copy that isn't there, or differs with nothing passed over, is stale.
    if health.cached.as_ref().is_some_and(|c| !c.usable || (!c.matches_now && health.passed_over.is_none())) {
        return Plan::Skip(Skip::NotWhatTilesRun);
    }
    let real = copy.real_path.clone().unwrap_or_else(|| copy.path.clone());
    let command = crate::doctor::codex_update_cmd(Some(&real), w);
    let mut facts = facts.clone();
    facts.codex = Some(copy.path.clone());
    let (mut env, mut path_first, mut extra, mut replaces) = (Vec::new(), None, Vec::new(), Vec::new());
    let expected = match copy.channel {
        InstallChannel::Standalone if w => {
            replaces.extend(parent_dir(&real));
            crate::doctor::CODEX_WINDOWS_INSTALL
        }
        InstallChannel::Standalone => {
            replaces.extend(parent_dir(&real));
            env.push(("CODEX_NON_INTERACTIVE".to_string(), "1".to_string()));
            "codex update"
        }
        InstallChannel::Npm => {
            let parent = crate::cli_health::npm_package_parent(CliTool::Codex, copy, w);
            let Some(prefix) = parent.as_deref().and_then(|p| npm_prefix_of(p, w)) else {
                return Plan::Skip(Skip::NoNpm);
            };
            let (own_npm, bin) = npm_in_prefix(&prefix, w);
            if disk.exists(&own_npm) {
                facts.npm = Some(own_npm);
                path_first = Some(bin);
            }
            if let Some(cache) = disk.npm_cache() {
                if !disk.writable(&cache) {
                    return Plan::Skip(Skip::NotWritable);
                }
            }
            replaces.extend(parent.map(|p| format!("{p}{}codex", if w { "\\" } else { "/" })));
            env.push(("npm_config_prefix".to_string(), prefix));
            extra = vec!["--no-fund".to_string(), "--no-audit".to_string()];
            "npm install -g @openai/codex@latest"
        }
        InstallChannel::Homebrew => return Plan::Skip(Skip::Homebrew),
        InstallChannel::Winget => return Plan::Skip(Skip::Winget),
        _ => return Plan::Skip(Skip::UnknownChannel),
    };
    // The doctor's Update row and this run agree, or nothing runs.
    if command != Some(expected) {
        return Plan::Skip(Skip::UnknownChannel);
    }
    // R4's rule for Setup's Update, reused: the same folders, the same verdict.
    let update = crate::setup_actions::ActionId::UpdateCodex;
    if crate::setup_actions::update_refusal(update, disk.update_writable(&copy.path)).is_some() {
        return Plan::Skip(Skip::NotWritable);
    }
    let mut argv = match crate::setup_actions::argv_for(expected, &facts) {
        Ok((argv, _)) => argv,
        Err(_) if copy.channel == InstallChannel::Npm => return Plan::Skip(Skip::NoNpm),
        Err(_) if w => return Plan::Skip(Skip::NoPowershell),
        Err(_) => return Plan::Skip(Skip::NotFound),
    };
    argv.extend(extra);
    match latest {
        None => return Plan::NoLatest,
        Some(latest) if !evidence::newer_known(version, Some(latest)) && version.is_some() => {
            return Plan::NothingNewer;
        }
        Some(_) => {}
    }
    Plan::Run(UpdateCommand { argv, env, path_first, display: expected.to_string(), channel: copy.channel, replaces })
}

// ── Windows: a Codex Plyloft can't see ─────────────────────────────────

#[cfg_attr(not(windows), allow(dead_code))]
fn norm_windows(path: &str) -> String {
    let p = path.replace('/', "\\").to_ascii_lowercase();
    let p = p.strip_prefix(r"\\?\").unwrap_or(&p).to_string();
    p.trim_end_matches('\\').to_string()
}

#[cfg_attr(not(windows), allow(dead_code))]
/// Pure: a process image is inside one of `dirs` (Windows paths: case,
/// either separator, the `\\?\` prefix `QueryFullProcessImageNameW` may
/// give).
pub fn image_under(image: &str, dirs: &[String]) -> bool {
    let image = norm_windows(image);
    dirs.iter().map(|d| norm_windows(d)).any(|dir| {
        !dir.is_empty() && image.len() > dir.len() && image.starts_with(&dir) && image[dir.len()..].starts_with('\\')
    })
}

/// Windows: a running process whose image is in one of `dirs` — a Codex
/// typed in a shell tile, the person's own terminal, another Plyloft. Its
/// file is locked, so the update would fail half-way under it.
#[cfg(windows)]
fn codex_running_from(dirs: &[String]) -> bool {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if dirs.is_empty() {
        return false;
    }
    // SAFETY: a snapshot of the process list, walked and closed here; each
    // process handle is opened for a query only and closed.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = false;
        let mut ok = Process32FirstW(snap, &mut entry) != 0;
        while ok && !found {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID);
            if !process.is_null() {
                let mut buf = vec![0u16; 1024];
                let mut len = buf.len() as u32;
                if QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len) != 0 {
                    let image = std::ffi::OsString::from_wide(&buf[..len as usize]).to_string_lossy().into_owned();
                    found = image_under(&image, dirs);
                }
                CloseHandle(process);
            }
            ok = Process32NextW(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
        found
    }
}

/// macOS: a running Codex survives the update (R0 X8); nothing to look for.
#[cfg(not(windows))]
fn codex_running_from(_dirs: &[String]) -> bool {
    false
}

// ── One attempt at a time, across Plyloft instances ────────────────────

/// The lock's file: in the user's temp folder, not beside one profile's
/// record, so Plyloft and Plyloft Test (two profiles, two record folders)
/// never update the same npm prefix or standalone install at once.
pub fn lock_path() -> std::path::PathBuf {
    std::env::temp_dir().join("plyloft-codex-auto-update.lock")
}

/// Pure: a lock file's content is stale — unreadable, older than
/// [`LOCK_STALE`] (an attempt is bounded by [`TIMEOUT`]), or held by a
/// process that is gone.
pub fn lock_is_stale(content: &str, now: chrono::DateTime<chrono::Utc>, alive: impl Fn(u32) -> bool) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(content) else { return true };
    let pid = value["pid"].as_u64().map(|p| p as u32);
    let at = parse_time(value["startedAt"].as_str());
    match (pid, at) {
        (Some(pid), Some(at)) => {
            let age = now.signed_duration_since(at);
            age < chrono::Duration::zero() - chrono::Duration::hours(1)
                || age > chrono::Duration::from_std(LOCK_STALE).unwrap_or(chrono::Duration::minutes(25))
                || !alive(pid)
        }
        _ => true,
    }
}

fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: signal 0 delivers nothing; it only asks.
        let rc = unsafe { libc::kill(pid as i32, 0) };
        rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        // SAFETY: a query handle, closed at once.
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return false;
            }
            CloseHandle(h);
            true
        }
    }
}

/// The attempt's hold on [`lock_path`], removed when dropped.
pub struct AttemptLock {
    path: std::path::PathBuf,
    content: String,
}

impl AttemptLock {
    /// Take the lock at `path`, created exclusively; a stale one is taken
    /// over once. `None`: another Plyloft holds it.
    pub fn take(path: &std::path::Path, alive: impl Fn(u32) -> bool) -> Option<AttemptLock> {
        let content = serde_json::json!({ "pid": std::process::id(), "startedAt": chrono::Utc::now().to_rfc3339() }).to_string();
        for _ in 0..2 {
            match std::fs::OpenOptions::new().write(true).create_new(true).open(path) {
                Ok(mut file) => {
                    use std::io::Write;
                    let _ = file.write_all(content.as_bytes());
                    return Some(AttemptLock { path: path.to_path_buf(), content });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let held = std::fs::read_to_string(path).unwrap_or_default();
                    if !lock_is_stale(&held, chrono::Utc::now(), &alive) {
                        return None;
                    }
                    log::info!("codex auto-update: taking over a stale lock ({held})");
                    let _ = std::fs::remove_file(path);
                }
                Err(e) => {
                    log::warn!("codex auto-update: no lock at {}: {e}", path.display());
                    return None;
                }
            }
        }
        None
    }
}

impl Drop for AttemptLock {
    fn drop(&mut self) {
        // Only our own: a lock taken over meanwhile stays.
        if std::fs::read_to_string(&self.path).is_ok_and(|c| c == self.content) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

// ── Judging ────────────────────────────────────────────────────────────

/// What one update process did.
#[derive(Debug, Default)]
pub struct UpdateRun {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    /// Stopped: Plyloft quitting, or (Windows) a start that met it.
    pub cancelled: bool,
}

/// The verdict on one update that ran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Judged {
    pub outcome: Outcome,
    pub cause: Option<Cause>,
    pub cause_path: Option<String>,
    /// Codex answers `--version` after the run (`ShellEnv::codex_healthy`).
    pub starts: bool,
}

/// The line the tail ends with when the time limit stopped the update. It
/// names the command that ran, never another channel's.
pub fn timeout_line(display: &str, limit: Duration) -> String {
    format!(
        "Plyloft stopped `{display}` after {} minutes without it finishing, then looked at Codex again.",
        limit.as_secs() / 60
    )
}

/// Pure: R2's verdict on an update (`setup_run::update_outcome`), with
/// Plyloft's own: a run it stopped, a Codex that doesn't start afterwards
/// (whatever its exit code said), and — since this run only starts when a
/// newer release is known — the same version afterwards is never "already
/// current" or "nothing newer": it is still on the old version.
pub fn judge(
    run: &UpdateRun,
    tail: &[String],
    before: Option<&str>,
    after: Option<&str>,
    starts: bool,
    newer_known: bool,
) -> Judged {
    let failed = |outcome: Outcome| {
        let d = evidence::classify(tail, run.exit_code, run.timed_out);
        Judged { outcome, cause: Some(d.cause), cause_path: d.path, starts }
    };
    if run.cancelled {
        return Judged { outcome: Outcome::Cancelled, cause: None, cause_path: None, starts };
    }
    if run.timed_out {
        return failed(Outcome::TimedOut);
    }
    if !starts {
        return failed(Outcome::Failed);
    }
    let change = evidence::version_change(before, after);
    let outcome = crate::setup_run::update_outcome(change, run.exit_code, evidence::claims_update(tail), newer_known)
        .unwrap_or(Outcome::CouldNotTell);
    match outcome {
        Outcome::Succeeded | Outcome::NothingNewer if change == VersionChange::Same => failed(Outcome::StillOnOldVersion),
        Outcome::Succeeded | Outcome::NothingNewer => Judged { outcome, cause: None, cause_path: None, starts },
        other => failed(other),
    }
}

/// What the window says about an attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Notice {
    /// A newer version runs now (the quiet "Codex is up to date").
    Updated,
    /// It wasn't updated and still works, on its old version.
    StillWorks,
    /// Codex doesn't start after the update: Repair.
    NotStarting,
}

fn wire<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
}

/// Pure: the notice for `judged`, if any. A failure that leaves Codex on its
/// old version is told once: not again while the last automatic attempt
/// (`previous`) failed the same way, from the same version, for the same
/// cause.
pub fn notice(judged: &Judged, before: Option<&str>, after: Option<&str>, previous: Option<&LastRun>) -> Option<Notice> {
    match judged.outcome {
        Outcome::Cancelled | Outcome::NothingNewer => None,
        _ if !judged.starts => Some(Notice::NotStarting),
        Outcome::Succeeded => {
            (evidence::version_change(before, after) == VersionChange::Higher).then_some(Notice::Updated)
        }
        outcome => {
            let told = previous.is_some_and(|p| {
                p.action_id == ACTION_ID
                    && p.outcome.as_deref() == Some(wire(&outcome).as_str())
                    && p.cause == judged.cause.map(|c| wire(&c))
                    && p.version_before.as_deref() == before
            });
            (!told).then_some(Notice::StillWorks)
        }
    }
}

// ── The gate between starts and the update ─────────────────────────────

#[derive(Default)]
struct GateState {
    updating: bool,
    cancel: Option<Arc<AtomicBool>>,
    pid: Option<u32>,
    last_start: Option<Instant>,
    closed: bool,
    /// Setup kept a Codex run: the thread reads the record again.
    records_changed: bool,
}

/// One per process ([`GATE`]); tests make their own.
pub struct Gate {
    state: Mutex<GateState>,
    /// Waiting starts and the thread's timed wait.
    turn: Condvar,
}

/// How a Codex start met the gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartWait {
    /// No update was running.
    Clear,
    /// It waited, and the update ended.
    Waited,
    /// It waited [`START_WAIT`] and went ahead (Windows: the update stopped).
    WaitedTheLimit,
    /// It couldn't wait and went ahead (Windows: the update stopped).
    WentAhead,
}

/// Held while an update runs; dropping it lets the starts that wait go.
pub struct Ticket<'a> {
    gate: &'a Gate,
    pub cancel: Arc<AtomicBool>,
}

impl Drop for Ticket<'_> {
    fn drop(&mut self) {
        let mut g = self.gate.state.lock();
        g.updating = false;
        g.cancel = None;
        g.pid = None;
        self.gate.turn.notify_all();
    }
}

impl Ticket<'_> {
    pub fn set_pid(&self, pid: u32) {
        self.gate.state.lock().pid = Some(pid);
    }
}

impl Default for Gate {
    fn default() -> Self {
        Self::new()
    }
}

impl Gate {
    pub const fn new() -> Self {
        Self {
            state: Mutex::new(GateState {
                updating: false,
                cancel: None,
                pid: None,
                last_start: None,
                closed: false,
                records_changed: false,
            }),
            turn: Condvar::new(),
        }
    }

    pub fn updating(&self) -> bool {
        self.state.lock().updating
    }

    pub fn closed(&self) -> bool {
        self.state.lock().closed
    }

    pub fn last_start(&self) -> Option<Instant> {
        self.state.lock().last_start
    }

    /// Take the gate for an update, or say why not. `busy` is asked after
    /// the gate is taken (and outside its lock), so a start can't slip in
    /// between the look and the run: a start sees `updating` and waits, a
    /// session registered before is in `busy`.
    pub fn begin(&self, now: Instant, busy: impl FnOnce() -> Option<Busy>) -> Result<Ticket<'_>, Busy> {
        let cancel = {
            let mut g = self.state.lock();
            if g.closed {
                return Err(Busy::Quitting);
            }
            if g.updating {
                return Err(Busy::Updating);
            }
            if g.last_start.is_some_and(|at| now.saturating_duration_since(at) < START_GRACE) {
                return Err(Busy::CodexStarting);
            }
            let cancel = Arc::new(AtomicBool::new(false));
            g.updating = true;
            g.cancel = Some(cancel.clone());
            cancel
        };
        let ticket = Ticket { gate: self, cancel };
        match busy() {
            Some(reason) => Err(reason),
            None => Ok(ticket),
        }
    }

    /// A Codex start. `wait`: the caller may block (a tile's check on a
    /// worker) and waits for an update under way, at most `limit`; past it,
    /// or when it may not wait, it goes ahead — and with `stop` (Windows)
    /// the update is stopped first and, waiting or not, its end is waited
    /// for (at most [`STOP_WAIT`]), so no start races the kill.
    pub fn before_start(&self, wait: bool, limit: Duration, stop: bool) -> StartWait {
        let mut g = self.state.lock();
        let mut how = StartWait::Clear;
        if g.updating {
            if wait {
                let deadline = Instant::now() + limit;
                while g.updating {
                    if self.turn.wait_until(&mut g, deadline).timed_out() {
                        break;
                    }
                }
                how = if g.updating { StartWait::WaitedTheLimit } else { StartWait::Waited };
            } else {
                how = StartWait::WentAhead;
            }
            if g.updating && stop {
                if let Some(cancel) = &g.cancel {
                    cancel.store(true, Ordering::SeqCst);
                }
                let deadline = Instant::now() + STOP_WAIT;
                while g.updating {
                    if self.turn.wait_until(&mut g, deadline).timed_out() {
                        break;
                    }
                }
            }
        }
        g.last_start = Some(Instant::now());
        // The thread's idle clock starts again from this start.
        self.turn.notify_all();
        how
    }

    /// 1.176.2 (A5R-08): a Codex start that can be left out, like the model
    /// list's `codex debug models`. While an update runs it is left out
    /// (false): it never stops the update (Windows) nor waits for it, and
    /// the update's idle clock is left alone. Otherwise it is a start like
    /// [`Self::before_start`]'s (true). One look under the lock, so an update
    /// can't begin between the look and the start being recorded.
    pub fn start_unless_updating(&self) -> bool {
        let mut g = self.state.lock();
        if g.updating {
            return false;
        }
        g.last_start = Some(Instant::now());
        self.turn.notify_all();
        true
    }

    /// Quit: no update starts any more, the one running is stopped and its
    /// process tree killed now. True when one was running.
    pub fn shutdown(&self) -> bool {
        let mut g = self.state.lock();
        g.closed = true;
        if let Some(cancel) = &g.cancel {
            cancel.store(true, Ordering::SeqCst);
        }
        let pid = g.pid.take();
        let running = g.updating;
        self.turn.notify_all();
        drop(g);
        if let Some(pid) = pid {
            kill_tree_now(pid);
        }
        running
    }

    /// The thread's wait between looks: `TICK`, or until quit, a Codex start
    /// or a changed record wakes it. True when the record changed.
    fn nap(&self, tick: Duration) -> bool {
        let mut g = self.state.lock();
        if !g.closed && !g.records_changed {
            let _ = self.turn.wait_for(&mut g, tick);
        }
        std::mem::take(&mut g.records_changed)
    }
}

/// The process's gate.
pub static GATE: Gate = Gate::new();

/// The two places every Codex start passes (`PtyRegistry::begin_coordination`,
/// `codex_app::start_with`) and a tile's own check (`cli_fresh_check`, the
/// only one that waits).
pub(crate) fn before_codex_start(wait: bool) -> StartWait {
    let how = GATE.before_start(wait, START_WAIT, cfg!(windows));
    if how != StartWait::Clear {
        log::info!("codex auto-update: a Codex start met the update under way ({how:?})");
    }
    how
}

/// A Codex start that is skipped while the update runs
/// ([`Gate::start_unless_updating`]). True: go ahead.
pub(crate) fn codex_start_unless_updating() -> bool {
    let go = GATE.start_unless_updating();
    if !go {
        log::info!("codex auto-update: a skippable Codex start left out while the update runs");
    }
    go
}

/// The automatic update is running now. Setup refuses Codex steps then;
/// card R4's Repair runner asks this too.
pub fn updating() -> bool {
    GATE.updating()
}

/// Setup kept a Codex install or update (`setup_last_run`): the thread
/// reads the record again instead of its copy in memory.
pub fn note_records_changed() {
    let mut g = GATE.state.lock();
    g.records_changed = true;
    GATE.turn.notify_all();
}

/// The exit cleanup's step (Hard Rule 4).
pub fn shutdown() -> bool {
    GATE.shutdown()
}

// ── The process ────────────────────────────────────────────────────────

/// Run `cmd` under a deadline, capturing its output, until it exits, the
/// deadline passes or `cancel` is set (then its process tree is stopped).
/// A run whose `cancel` was set is cancelled however it ended — at quit the
/// tree is killed from outside, so its exit may be seen first. `on_spawn`
/// gets its pid (the gate keeps it for [`shutdown`]). An error only when it
/// couldn't be started or watched.
pub fn run_update_process(
    cmd: &UpdateCommand,
    path_env: &str,
    timeout: Duration,
    cancel: &AtomicBool,
    on_spawn: impl FnOnce(u32),
) -> Result<UpdateRun, String> {
    let program = cmd.argv.first().ok_or("no update command")?;
    // An npm `.cmd` shim on Windows runs as node (`platform::command`).
    let mut command = crate::platform::command(program, path_env);
    command
        .args(&cmd.argv[1..])
        .env("PATH", path_env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in crate::shell_env::try_get().map(|e| e.proxy_env.clone()).unwrap_or_default() {
        command.env(key, value);
    }
    for (key, value) in &cmd.env {
        command.env(key, value);
    }
    if std::env::var_os("LANG").is_none() {
        command.env("LANG", "en_US.UTF-8");
    }
    // Its own process group (a Job Object on Windows), so a stop takes the
    // downloader it starts with it.
    crate::platform::own_group(&mut command);
    let mut child = command.spawn().map_err(|e| format!("spawn {}: {e}", cmd.display))?;
    crate::platform::adopt(&child);
    let pid = child.id();
    on_spawn(pid);
    // Both pipes drained on their own threads: an updater reporting progress
    // fills a ~64 KB pipe and would otherwise block for ever.
    let stdout_reader = child.stdout.take().map(drain_stream);
    let stderr_reader = child.stderr.take().map(drain_stream);

    let deadline = Instant::now() + timeout;
    let (mut timed_out, mut cancelled) = (false, false);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if cancel.load(Ordering::SeqCst) => {
                cancelled = true;
                terminate_group(&mut child, pid);
                let _ = child.wait();
                break None;
            }
            Ok(None) if Instant::now() >= deadline => {
                timed_out = true;
                terminate_group(&mut child, pid);
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(250)),
            Err(e) => {
                terminate_group(&mut child, pid);
                let _ = child.wait();
                return Err(format!("watch {}: {e}", cmd.display));
            }
        }
    };
    cancelled |= cancel.load(Ordering::SeqCst);
    let join = |h: Option<std::thread::JoinHandle<String>>| h.map(|h| h.join().unwrap_or_default()).unwrap_or_default();
    Ok(UpdateRun {
        exit_code: status.and_then(|s| s.code()),
        stdout: join(stdout_reader),
        stderr: join(stderr_reader),
        timed_out,
        cancelled,
    })
}

/// What a tail cut at the front keeps: from just after its first `\n`; with
/// none (one line past the cap, an npm progress bar), from its first whole
/// character — the up to three UTF-8 continuation bytes the cut left are
/// dropped (REV-R1 F5), or the whole line would be read in the OEM code
/// page. Not cut: all of it.
fn whole_lines(kept: &[u8], cut: bool) -> &[u8] {
    if !cut {
        return kept;
    }
    match kept.iter().position(|b| *b == b'\n') {
        Some(at) => &kept[at + 1..],
        None => {
            let half = kept.iter().take(3).take_while(|b| (0x80..=0xBF).contains(*b)).count();
            &kept[half..]
        }
    }
}

/// Read a pipe to its end on its own thread, keeping the last
/// [`OUTPUT_CAP`] bytes.
fn drain_stream<R: std::io::Read + Send + 'static>(mut pipe: R) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut kept: Vec<u8> = Vec::new();
        let mut cut = false;
        let mut buf = [0u8; 8192];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    kept.extend_from_slice(&buf[..n]);
                    if kept.len() > OUTPUT_CAP {
                        let overflow = kept.len() - OUTPUT_CAP;
                        kept.drain(..overflow);
                        cut = true;
                    }
                }
            }
        }
        // 1.176.2 R1: npm.cmd and install.ps1 run through cmd.exe or Windows
        // PowerShell, whose own words are in the OEM code page; a buffer cut
        // at the cap starts at its first whole line, so no half character is
        // read as one (as `worktrees::run_bounded_output_capped_in` does).
        crate::platform::decode_console(whole_lines(&kept, cut))
    })
}

/// Stop an abandoned updater and its descendants: the group on unix
/// (SIGTERM, SIGKILL half a second later), the Job Object on Windows.
fn terminate_group(child: &mut std::process::Child, pid: u32) {
    #[cfg(unix)]
    {
        let pgid = pid as i32;
        // Only a group the child leads: a killpg of Plyloft's own group
        // would take Plyloft down with it.
        if unsafe { libc::getpgid(pgid) } == pgid {
            // SAFETY: plain signal delivery to a group we created ourselves.
            unsafe {
                libc::killpg(pgid, libc::SIGTERM);
            }
            std::thread::sleep(Duration::from_millis(500));
            // Re-checked at the escalation: never a reused pid's group.
            if unsafe { libc::getpgid(pgid) } == pgid {
                unsafe {
                    libc::killpg(pgid, libc::SIGKILL);
                }
            }
        } else {
            log::warn!("codex auto-update: pid {pid} doesn't lead its own group; killing only it");
        }
    }
    #[cfg(not(unix))]
    crate::platform::kill_group(pid as crate::platform::Pgid);
    let _ = child.kill();
}

/// Quit: SIGKILL the updater's whole group at once (its watcher reaps it).
fn kill_tree_now(pid: u32) {
    #[cfg(unix)]
    {
        let pgid = pid as i32;
        if unsafe { libc::getpgid(pgid) } == pgid {
            // SAFETY: the updater's own group (see `terminate_group`).
            unsafe {
                libc::killpg(pgid, libc::SIGKILL);
            }
        }
    }
    #[cfg(not(unix))]
    crate::platform::kill_group(pid as crate::platform::Pgid);
}

// ── One attempt, on the machine ────────────────────────────────────────

/// What the window is told at the end of an update that ran.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Done {
    pub outcome: Outcome,
    pub cause: Option<Cause>,
    pub cause_path: Option<String>,
    pub version_before: Option<String>,
    pub version_after: Option<String>,
    pub exit_code: Option<i32>,
    pub starts: bool,
    pub notice: Option<Notice>,
    /// What ran, as Diagnostics' Update row names it.
    pub command: String,
    pub tail: Vec<String>,
}

/// One attempt's answer.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Attempt {
    Busy { reason: Busy },
    Skipped { reason: Skip },
    NothingNewer,
    NoLatest,
    /// Stopped before its end (a Windows start; Plyloft quitting).
    Stopped,
    Ran { done: Done },
}

impl Attempt {
    /// For the thread's next look.
    pub fn after(&self) -> After {
        match self {
            Attempt::Busy { .. } => After::Busy,
            Attempt::NoLatest => After::NoLatest,
            Attempt::Skipped { reason } if reason.transient() => After::Transient,
            Attempt::Stopped => After::Stopped,
            _ => After::Done,
        }
    }
}

#[derive(Serialize, Clone)]
struct StateEvent {
    running: bool,
}

/// Codex processes, Setup and Repair runs, counted across their registries.
fn live<R: Runtime>(app: &AppHandle<R>) -> Live {
    let coordination = app
        .try_state::<crate::coordination::CoordinationRegistry>()
        .map_or(0, |r| r.active_count(crate::coordination::Provider::Codex));
    let app_server = app.try_state::<crate::codex_app::CodexAppRegistry>().map_or(0, |r| r.live());
    let chats = app.try_state::<crate::chat::ChatRegistry>().map_or(0, |r| r.codex_live());
    let setup_running = app.try_state::<crate::setup_run::SetupRunner>().is_some_and(|r| r.running());
    Live { codex_sessions: coordination + app_server + chats, setup_running, repair_running: repair_running(app, CliTool::Codex) }
}

fn record(dir: &std::path::Path, run: LastRun, ran: bool) {
    if ran {
        if let Err(e) = crate::setup_last_run::record(dir, crate::setup_actions::Tool::Codex, run.clone()) {
            log::warn!("codex auto-update: couldn't keep Codex's last run: {e}");
        }
    }
    if let Err(e) = crate::setup_last_run::record_key(dir, RECORD_KEY, run) {
        log::warn!("codex auto-update: couldn't keep the attempt: {e}");
    }
}

fn skipped_run(outcome: &str, cause: Option<String>, path: Option<&str>, version: Option<&str>) -> LastRun {
    let now = chrono::Utc::now().to_rfc3339();
    LastRun {
        action_id: ACTION_ID.into(),
        started_at: Some(now.clone()),
        finished_at: Some(now),
        outcome: Some(outcome.into()),
        cause,
        // The facts the skip was judged on (`skip_facts_changed`).
        cause_path: path.map(String::from),
        version_before: version.map(String::from),
        version_after: version.map(String::from),
        ..LastRun::default()
    }
}

/// One attempt now: look, decide, run, judge, keep, tell. Blocking.
pub fn attempt<R: Runtime>(app: &AppHandle<R>) -> Attempt {
    if let Some(reason) = busy_reason(&live(app)) {
        return Attempt::Busy { reason };
    }
    let Some(_lock) = AttemptLock::take(&lock_path(), pid_alive) else {
        return Attempt::Busy { reason: Busy::OtherInstance };
    };
    let dir = crate::setup_last_run::dir_of(app);
    // A fresh version first (the narrow refresh: no login shell), so
    // before and after come from the same probe.
    let seen = crate::shell_env::recheck_version(false);
    let Some(codex_path) = seen.codex_path.clone() else {
        return Attempt::Skipped { reason: Skip::NotFound };
    };
    // R4's look at the copy Plyloft runs (`env.codex_path`, chosen as the
    // first that starts), with what it passed over.
    let inputs = crate::cli_health::Inputs::from_process(&seen.path, crate::cli_health::Cached::Path(codex_path.clone()));
    let health = crate::cli_health::inspect_now(CliTool::Codex);
    let facts = PlanFacts::read(&seen);
    let latest = crate::doctor_reads::latest_versions(true, &seen.path).codex;
    let before = seen.codex_version.clone();
    let cmd = match plan(&health, &facts, before.as_deref(), latest.as_deref(), &SystemDisk { inputs: &inputs }) {
        Plan::NoLatest => return Attempt::NoLatest,
        Plan::NothingNewer => {
            if let Some(dir) = &dir {
                record(dir, skipped_run("nothing-newer", None, Some(&codex_path), before.as_deref()), false);
            }
            return Attempt::NothingNewer;
        }
        Plan::Skip(reason) => {
            log::info!("codex auto-update: skipped ({})", wire(&reason));
            if let Some(dir) = &dir {
                record(dir, skipped_run("skipped", Some(wire(&reason)), Some(&codex_path), before.as_deref()), false);
            }
            return Attempt::Skipped { reason };
        }
        Plan::Run(cmd) => cmd,
    };
    if codex_running_from(&cmd.replaces) {
        return Attempt::Busy { reason: Busy::CodexRunningElsewhere };
    }
    let ticket = match GATE.begin(Instant::now(), || busy_reason(&live(app))) {
        Ok(ticket) => ticket,
        Err(reason) => return Attempt::Busy { reason },
    };
    let _ = app.emit(STATE_EVENT, StateEvent { running: true });
    let started_at = chrono::Utc::now().to_rfc3339();
    let home = crate::platform::home_dir().map(|h| h.to_string_lossy().into_owned());
    let path_env = path_for_run(&seen.path, home.as_deref(), cmd.path_first.as_deref(), cfg!(windows));
    log::info!("codex auto-update: start `{}` (version before {})", cmd.display, before.as_deref().unwrap_or("-"));
    let run = run_update_process(&cmd, &path_env, TIMEOUT, &ticket.cancel, |pid| ticket.set_pid(pid))
        .unwrap_or_else(|error| UpdateRun { exit_code: None, stderr: error, ..UpdateRun::default() });
    // Quitting: no look (a login shell while the app exits) and no verdict.
    // Only a stopped attempt is kept, which doesn't use up the day.
    if GATE.closed() {
        drop(ticket);
        if let Some(dir) = &dir {
            record(dir, skipped_run("cancelled", None, Some(&codex_path), before.as_deref()), false);
        }
        return Attempt::Stopped;
    }
    // A start stopped it (Windows): let that start go now, then look.
    let ticket = if run.cancelled {
        drop(ticket);
        None
    } else {
        Some(ticket)
    };
    // Always looked at again otherwise, whatever happened: a failed update
    // must never leave the app on facts from before it.
    let capabilities = app.try_state::<crate::review_capabilities::ReviewerCapabilityRegistry>();
    // 1.176.1: the update reports itself; its change isn't told again (`cli_seen`).
    let own = crate::cli_seen::OwnChange::new(&[crate::cli_fresh::Cli::Codex]);
    let fresh = crate::cli_fresh::look_after_update(&seen, capabilities.as_deref());
    drop(own);
    drop(ticket);
    let _ = app.emit(STATE_EVENT, StateEvent { running: false });

    let mut tail = crate::setup_run::tail_lines(format!("{}\n{}", run.stdout, run.stderr).as_bytes(), TAIL_LINES);
    if run.timed_out {
        tail.push(timeout_line(&cmd.display, TIMEOUT));
    }
    let after = fresh.codex_version.clone();
    let starts = fresh.codex_healthy();
    let newer_known = evidence::newer_known(before.as_deref(), latest.as_deref());
    let judged = judge(&run, &tail, before.as_deref(), after.as_deref(), starts, newer_known);
    let previous = dir.as_ref().and_then(|d| crate::setup_last_run::load(d).remove(RECORD_KEY));
    let told = notice(&judged, before.as_deref(), after.as_deref(), previous.as_ref());
    let line = format!(
        "codex auto-update: end `{}` {}, exit {:?}, cause {:?}, version {} -> {}, starts {starts}",
        cmd.display,
        wire(&judged.outcome),
        run.exit_code,
        judged.cause,
        before.as_deref().unwrap_or("-"),
        after.as_deref().unwrap_or("-"),
    );
    if matches!(judged.outcome, Outcome::Succeeded | Outcome::NothingNewer | Outcome::Cancelled) {
        log::info!("{line}");
    } else {
        log::warn!("{line}\n{}", tail.join("\n"));
    }
    if let Some(dir) = &dir {
        let kept = LastRun {
            action_id: ACTION_ID.into(),
            started_at: Some(started_at),
            finished_at: Some(chrono::Utc::now().to_rfc3339()),
            exit_code: run.exit_code,
            outcome: Some(wire(&judged.outcome)),
            cause: judged.cause.map(|c| wire(&c)),
            cause_path: judged.cause_path.clone(),
            version_before: before.clone(),
            version_after: after.clone(),
            tail: tail.clone(),
        };
        // A run Plyloft stopped tells a Repair nothing: Codex's own entry stays.
        record(dir, kept, judged.outcome != Outcome::Cancelled);
    }
    if judged.outcome == Outcome::Cancelled {
        return Attempt::Stopped;
    }
    let done = Done {
        outcome: judged.outcome,
        cause: judged.cause,
        cause_path: judged.cause_path,
        version_before: before,
        version_after: after,
        exit_code: run.exit_code,
        starts,
        notice: told,
        command: cmd.display,
        tail,
    };
    let _ = app.emit(DONE_EVENT, done.clone());
    Attempt::Ran { done }
}

/// Pure: the idle clock after a look — reset by a live session now, and
/// by a Codex start since the last look (a session that came and went
/// between two looks still counts).
pub fn idle_since(previous: Instant, busy_now: bool, now: Instant, last_start: Option<Instant>) -> Instant {
    if busy_now {
        return now;
    }
    last_start.map_or(previous, |at| previous.max(at))
}

/// The background thread: at most once a minute, an attempt when one is
/// due and Codex has been idle for [`IDLE_QUIET`]. Started once at launch.
pub fn start<R: Runtime>(app: AppHandle<R>) {
    let spawned = std::thread::Builder::new().name("codex-auto-update".into()).spawn(move || {
        let mut idle = Instant::now();
        let mut retry_at: Option<Instant> = None;
        let mut stops_in_a_row = 0u32;
        let dir = crate::setup_last_run::dir_of(&app);
        let load = || dir.as_deref().map(crate::setup_last_run::load).unwrap_or_default();
        let mut runs = load();
        loop {
            if GATE.nap(TICK) {
                runs = load();
            }
            if GATE.closed() {
                return;
            }
            let now = Instant::now();
            idle = idle_since(idle, busy_reason(&live(&app)).is_some(), now, GATE.last_start());
            let env = crate::shell_env::get();
            let auto = runs.get(RECORD_KEY);
            let is_due = due(chrono::Utc::now(), last_attempt(auto, runs.get("codex")))
                || skip_facts_changed(auto, env.codex_path.as_deref(), env.codex_version.as_deref());
            if !ready(is_due, now.saturating_duration_since(idle), retry_at.is_some_and(|at| now < at)) {
                continue;
            }
            let result = attempt(&app);
            let after = result.after();
            stops_in_a_row = if after == After::Stopped { stops_in_a_row + 1 } else { 0 };
            if let Attempt::Busy { reason } = &result {
                log::info!("codex auto-update: not now ({})", wire(reason));
                idle = Instant::now();
            }
            retry_at = retry_in(after, stops_in_a_row).map(|d| Instant::now() + d);
            runs = load();
        }
    });
    if let Err(error) = spawned {
        log::warn!("codex auto-update: no background thread: {error}");
    }
}

#[cfg(test)]
#[path = "codex_auto_update_tests.rs"]
mod tests;
