//! OB-3 — Setup's guided terminal and its runner (onboarding spec §7).
//!
//! `setup_run(actionId, args?)` builds the command from the allowlist
//! (`setup_actions`), spawns it in a PTY Ply owns (`PtyRegistry::spawn_setup`,
//! `ExecutionKind::Setup`, no workspace), and watches for the result the
//! action is for — the tool resolving and answering `--version`, a
//! credential appearing, `xcode-select -p` answering — rather than trusting
//! the exit code (spec §4 principle 4). Progress goes out as
//! `setup://progress` events; the output streams as ordinary `pty://data`
//! for the frontend's `SetupTerminal`.
//!
//! Rules this module keeps:
//!
//! - **One run at a time.** A second `setup_run` while one is under way is
//!   refused with words naming the running one — not queued: the guided
//!   terminal shows one run, and a queued install would start later where
//!   nobody is looking. "Install both" (Git, then Claude, on Windows) is two
//!   runs the step starts one after the other. The slot is held until the
//!   watcher decides, so the Command Line Tools' dialog, which outlives
//!   `xcode-select --install`, still counts as running.
//! - **Stop kills the whole tree**: the PTY's process group on unix
//!   (SIGTERM, SIGKILL after two seconds; the PTY closing hangs up its
//!   foreground group too), the tile Job Object's console processes on
//!   Windows (a browser a login opened outlives it, by design).
//! - **Quit kills it** (Hard Rule 4): `shutdown` runs in the exit cleanup (`ExitRequested` or `Exit`)
//!   before `PtyRegistry::kill_all`, SIGKILLs the group, and refuses any
//!   later run.
//! - **Cached PATH and proxy** (Hard Rule 2, spec §5 step 3): the PTY gets
//!   the probe's PATH and `ShellEnv::proxy_env`.
//! - After an install or update the shell is re-probed (and the doctor's
//!   remembered answers dropped); the final event says `reprobed`, and the
//!   frontend refreshes the doctor.
//!
//! The decisions are pure ([`decide`], and the `*_seen` readers), so each
//! case — success, not observed, could not tell, timeout, cancel — is tested
//! without a process.
//!
//! R2 (1.176.0): an update is judged on evidence — the tool's version before
//! and after (`setup_outcome`), so an updater that fails and leaves the old
//! version answering ends [`Outcome::StillOnOldVersion`], not Succeeded. An
//! install or update that prints nothing for 15 minutes, or runs an hour, is
//! stopped as Stop stops it and ends TimedOut. The final event carries the
//! cause its tail shows and the versions; the start and the end go to the
//! log, and the end is kept on disk (`setup_last_run`).

use parking_lot::Mutex;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use uuid::Uuid;

use crate::doctor::{CodexStore, CredentialSeen};
use crate::pty::PtyRegistry;
use crate::setup_actions::{
    self, ActionId, PlanFacts, RunPlan, SetupArgs, SignInAnswer, Tool, Watch,
};
use crate::setup_outcome::{self as evidence, Evidence, VersionChange};
use crate::shell_env::ShellEnv;

/// The event every progress change and the final result go out on.
pub const EVENT: &str = "setup://progress";

/// The guided terminal's size until the panel sends its own (`pty_resize`).
pub const DEFAULT_COLS: u16 = 100;
pub const DEFAULT_ROWS: u16 = 24;

/// How much output the final event carries for the error block's Details.
pub const TAIL_LINES: usize = 200;

pub const QUITTING: &str = "Plyloft is quitting: nothing new is started.";

/// R2: Stop pressed while Plyloft read the tool's version, before anything ran.
pub const STOPPED_BEFORE: &str = "Stopped before anything ran.";

pub const NO_REVIEW_FOLDER: &str = "Plyloft couldn't find its review folder, so Claude wasn't opened.";

fn busy(action: ActionId) -> String {
    format!(
        "Another setup step is still running ({}). Stop it or let it finish first.",
        action.id()
    )
}

// ── Watching (pure) ────────────────────────────────────────────────────

/// What one look at the machine found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Observed {
    Yes,
    No,
    /// Ply could not tell (a keychain it could not read, a `gh` that did not
    /// answer).
    Unknown,
}

impl From<bool> for Observed {
    fn from(yes: bool) -> Self {
        if yes {
            Self::Yes
        } else {
            Self::No
        }
    }
}

/// How a run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    /// Ply saw the result.
    Succeeded,
    /// The command ended and the result isn't there (a login closed in the
    /// browser; an install Ply can't find yet).
    NotObserved,
    /// The command ended and Ply could not tell.
    CouldNotTell,
    /// An install or update exited with an error and nothing works.
    Failed,
    /// R2: an update exited with an error (or said it updated) and the tool
    /// still answers with the version it had before the run.
    StillOnOldVersion,
    /// R2: the updater found nothing newer — winget's "no applicable
    /// upgrade" codes, or a clean exit with the same version while the
    /// doctor knew of a newer release (Homebrew lagging, npm writing another
    /// prefix). Not a failure: the tool works as before.
    NothingNewer,
    /// R2: after an update a lower version answers than before (R0: a failed
    /// update removed the native launcher; an older copy answers now).
    OlderVersionNow,
    /// The Command Line Tools did not arrive within 30 minutes; or (R2) an
    /// install or update hit its time limit and was stopped.
    TimedOut,
    /// OB-6: the macOS installer's window was seen and is gone, and
    /// `xcode-select -p` still fails (dismissed, or an administrator's
    /// password refused).
    InstallerClosed,
    /// Stop (or Ply quitting).
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    /// R2: before the command starts, Plyloft reads the tool's version.
    Preparing,
    /// The command runs (or, for the CLT, the macOS installer does).
    Running,
    /// The command ended; Ply is looking (a re-probe takes a moment).
    Checking,
    /// A sign-in has waited ten minutes: *Still waiting for you to sign in.*
    /// Nothing is stopped; the person may keep waiting or Stop.
    WaitingLong,
    Done,
}

/// Timings, real or a test's.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    /// How often the loop wakes.
    pub tick: Duration,
    /// Claude's credential / Codex's `auth.json` (spec §5 step 3: every 2 s).
    pub credential_poll: Duration,
    /// `xcode-select -p` (spec §5 step 4: every 5 s).
    pub clt_poll: Duration,
    /// A sign-in's soft bound (10 min): the WaitingLong notice.
    pub login_soft_limit: Duration,
    /// The Command Line Tools' hard bound (30 min).
    pub clt_limit: Duration,
    /// After a sign-in is seen while its command still runs, how long it may
    /// finish on its own before it is stopped.
    pub success_grace: Duration,
    /// Stop: SIGTERM, then SIGKILL after this.
    pub kill_grace: Duration,
    /// `trust.claude`: how often Claude's state is read while Claude runs —
    /// often, so Claude is not left open long after the member's answer.
    pub trust_poll: Duration,
    /// `trust.claude`: once Claude's state says trusted, how long Claude is
    /// left to finish writing it before it is stopped.
    pub trust_settle: Duration,
    /// R2: an install or update that prints nothing for this long is stopped
    /// (`setup_outcome::RUN_IDLE_LIMIT`, its rationale there).
    pub run_idle_limit: Duration,
    /// R2: …and one that runs this long, whatever it prints.
    pub run_limit: Duration,
}

impl Timing {
    pub const REAL: Timing = Timing {
        tick: Duration::from_millis(250),
        credential_poll: Duration::from_secs(2),
        clt_poll: Duration::from_secs(5),
        login_soft_limit: Duration::from_secs(10 * 60),
        clt_limit: Duration::from_secs(30 * 60),
        success_grace: Duration::from_secs(10),
        kill_grace: Duration::from_secs(2),
        trust_poll: Duration::from_millis(500),
        trust_settle: Duration::from_millis(500),
        run_idle_limit: evidence::RUN_IDLE_LIMIT,
        run_limit: evidence::RUN_LIMIT,
    };
}

/// How often `watch` is looked at while the command still runs; `None` =
/// only once it has ended.
pub fn poll_every(watch: Watch, timing: &Timing) -> Option<Duration> {
    match watch {
        Watch::ClaudeSignIn | Watch::CodexSignIn => Some(timing.credential_poll),
        Watch::ClaudeFolderTrust => Some(timing.trust_poll),
        Watch::CommandLineTools => Some(timing.clt_poll),
        _ => None,
    }
}

/// Seen while the command still runs, the run is stopped after a short
/// settle (`Timing::trust_settle`, for Claude to finish writing its state)
/// instead of the sign-ins' long grace (`Timing::success_grace`): Claude's
/// TUI after its trust question never ends by itself, and while it stays
/// open it is a full Claude session the member could type into. With the
/// 500 ms poll, Claude closes within about a second of the answer (then
/// SIGTERM, SIGKILL after `kill_grace`; on Windows the kill is a hard
/// terminate of its Job Object).
pub fn stops_on_sight(watch: Watch) -> bool {
    watch == Watch::ClaudeFolderTrust
}

fn is_sign_in(watch: Watch) -> bool {
    matches!(
        watch,
        Watch::ClaudeSignIn | Watch::CodexSignIn | Watch::GhNewAccount | Watch::GhSignedIn
    )
}

/// An install, update or configuration: a non-zero exit with nothing to see
/// is a failure. A sign-in that ends without an account is just "not signed
/// in yet" (spec: no error colour).
fn fails_on_error(watch: Watch) -> bool {
    matches!(
        watch,
        Watch::ToolWorks(_) | Watch::GhGitHelper | Watch::GhScopes | Watch::Cloned | Watch::ExitCode
    )
}

/// Where the watcher stands at one tick.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WatchState {
    pub elapsed: Duration,
    /// `Some(code)` once the command has exited (`code` `None` = killed).
    pub exit: Option<Option<i32>>,
    pub cancelled: bool,
    /// This tick's look, if one was made. Once `exit` is set, the look made
    /// after the exit.
    pub observed: Option<Observed>,
    /// The credential was already there before the run: a sign-in again. A
    /// look seeing it proves nothing until the command ends.
    pub already_there: bool,
    pub warned_long: bool,
    /// OB-6 (Command Line Tools only): the installer's window was seen and
    /// has been gone for [`INSTALLER_GONE_POLLS`] looks in a row.
    pub installer_gone: bool,
    /// R2: an update's version after the look against the one before it
    /// (`NotCompared` for everything else).
    pub version: VersionChange,
    /// R2: how long since the command last printed anything.
    pub idle: Duration,
    /// R2: the update's output says it put a new version in place
    /// (`setup_outcome::claims_update`).
    pub update_claimed: bool,
    /// R2: the doctor knew of a newer release than the version before the
    /// run (`setup_outcome::newer_known`).
    pub newer_known: bool,
}

/// How many looks in a row the CLT installer must be absent (after it was
/// seen) before Ply says it was closed: one poll's gap covers the moment
/// between the window closing and `xcode-select -p` answering.
pub const INSTALLER_GONE_POLLS: u32 = 2;

/// Pure: follow the CLT installer's window across polls. `running` is one
/// look (`None` = could not tell, which changes nothing). Returns whether it
/// is now gone. Never "gone" if it was never seen: a window Ply could not
/// find by name must not end a wait the person is still in.
pub fn track_installer(seen: &mut bool, absent: &mut u32, running: Option<bool>) -> bool {
    match running {
        Some(true) => {
            *seen = true;
            *absent = 0;
        }
        Some(false) if *seen => *absent += 1,
        _ => {}
    }
    *seen && *absent >= INSTALLER_GONE_POLLS
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Wait,
    WaitLong,
    Done(Outcome),
}

/// Pure: what the watcher does next.
pub fn decide(watch: Watch, s: &WatchState, timing: &Timing) -> Decision {
    if s.cancelled {
        return Decision::Done(Outcome::Cancelled);
    }
    // R2: an install or update that hangs is stopped (the runner ends its
    // tree as Stop does).
    if s.exit.is_none()
        && evidence::limited(watch)
        && (s.idle >= timing.run_idle_limit || s.elapsed >= timing.run_limit)
    {
        return Decision::Done(Outcome::TimedOut);
    }
    // R4: a Repair's chown or npm removal is its exit code; the Repair's
    // next look judges what it changed.
    if watch == Watch::ExitCode {
        return match s.exit {
            Some(Some(0)) => Decision::Done(Outcome::Succeeded),
            Some(_) => Decision::Done(Outcome::Failed),
            None => Decision::Wait,
        };
    }
    // OB-11: a clone that exits with an error failed, whatever it left
    // behind (git makes the `.git` folder before it downloads anything).
    if watch == Watch::Cloned && s.exit.is_some_and(|code| code != Some(0)) {
        return Decision::Done(Outcome::Failed);
    }
    if s.observed == Some(Observed::Yes) {
        // R2: an update is judged on its versions once its command ended.
        if let (Watch::ToolWorks(_), Some(code)) = (watch, s.exit) {
            if let Some(outcome) = update_outcome(s.version, code, s.update_claimed, s.newer_known) {
                return Decision::Done(outcome);
            }
        }
        // Challenger P2-1: a credential that was there before proves a
        // sign-in again only once its command ends cleanly; a cancelled
        // login (non-zero exit, killed) leaves the old one behind.
        match (s.already_there, s.exit) {
            (false, _) | (true, Some(Some(0))) => return Decision::Done(Outcome::Succeeded),
            (true, Some(_)) => return Decision::Done(Outcome::NotObserved),
            (true, None) => {}
        }
    }
    if watch == Watch::CommandLineTools {
        // `xcode-select --install` exits as soon as the dialog is up; the
        // macOS installer is what Ply waits for.
        if s.installer_gone {
            return Decision::Done(Outcome::InstallerClosed);
        }
        return if s.elapsed >= timing.clt_limit {
            Decision::Done(Outcome::TimedOut)
        } else {
            Decision::Wait
        };
    }
    if let Some(code) = s.exit {
        return match s.observed {
            // The look after the exit has not been made yet.
            None => Decision::Wait,
            Some(Observed::Unknown) => Decision::Done(Outcome::CouldNotTell),
            Some(_) if fails_on_error(watch) && code != Some(0) => Decision::Done(Outcome::Failed),
            Some(_) => Decision::Done(Outcome::NotObserved),
        };
    }
    if is_sign_in(watch) && !s.warned_long && s.elapsed >= timing.login_soft_limit {
        return Decision::WaitLong;
    }
    Decision::Wait
}

/// Pure (R2): an update whose tool answers after its command ended. `None`
/// for an install, which keeps the tolerance of spec §4 principle 4: the
/// tool working is the success, whatever the exit code (winget's "already
/// installed" codes). For an update the tool answering proves nothing by
/// itself — a refused update leaves the old version answering — so it is
/// judged on the versions:
///
/// - higher: updated, whatever the exit code;
/// - lower: never a success ([`Outcome::OlderVersionNow`]);
/// - the same: winget's "nothing newer" codes, or a clean exit claiming
///   nothing while a newer release was known, are [`Outcome::NothingNewer`];
///   a clean exit claiming nothing, with no newer release known, is "already
///   current" (Succeeded); an error exit, or an output that says a new
///   version was put in place (`claimed`: R0's read-only `~/.local/bin`,
///   exit 0), is [`Outcome::StillOnOldVersion`];
/// - different but not `X.Y.Z`, or unreadable after: a clean exit is
///   trusted, an error exit (winget's "nothing newer" codes included: only
///   the same version proves it) is "could not tell".
pub fn update_outcome(
    version: VersionChange,
    exit: Option<i32>,
    claimed: bool,
    newer_known: bool,
) -> Option<Outcome> {
    let clean = exit == Some(0);
    let nothing_newer = evidence::winget_nothing_newer(exit);
    Some(match version {
        VersionChange::NotCompared => return None,
        VersionChange::Higher => Outcome::Succeeded,
        VersionChange::Lower => Outcome::OlderVersionNow,
        VersionChange::Same if nothing_newer => Outcome::NothingNewer,
        VersionChange::Same if clean && !claimed && newer_known => Outcome::NothingNewer,
        VersionChange::Same if clean && !claimed => Outcome::Succeeded,
        VersionChange::Same => Outcome::StillOnOldVersion,
        VersionChange::Differs | VersionChange::Unreadable if clean => Outcome::Succeeded,
        VersionChange::Differs | VersionChange::Unreadable => Outcome::CouldNotTell,
    })
}

// ── Looking at the machine (pure readers) ──────────────────────────────

/// A tool works after an install: it resolves and answered `--version`
/// (git on Windows: and Git Bash is there, spec §4 "required").
pub fn tool_works(tool: Tool, env: &ShellEnv, windows: bool) -> bool {
    match tool {
        Tool::Claude => env.claude_path.is_some() && env.claude_version.is_some(),
        Tool::Codex => env.codex_healthy(),
        Tool::Gh => env.gh_path.is_some() && env.gh_version.is_some(),
        Tool::Git => env.git_works() && (!windows || env.git_bash_path.is_some()),
        Tool::Node => env.node_path.is_some() && env.node_version.is_some(),
    }
}

/// Claude's answer about the review folder (`claude_session::folder_trusted`;
/// `None`: its state could not be read).
pub fn folder_trust_seen(trusted: Option<bool>) -> Observed {
    match trusted {
        Some(trusted) => trusted.into(),
        None => Observed::Unknown,
    }
}

/// Claude Code's credential (`claude_auth::read`: keychain, file).
pub fn claude_seen(keychain: CredentialSeen, file: CredentialSeen) -> Observed {
    match (keychain, file) {
        (CredentialSeen::Present, _) | (_, CredentialSeen::Present) => Observed::Yes,
        (CredentialSeen::Absent, CredentialSeen::Absent) => Observed::No,
        _ => Observed::Unknown,
    }
}

/// Codex's `auth.json` in the real `CODEX_HOME`. With a keychain store a
/// missing file says nothing (MEASUREMENTS §3).
pub fn codex_seen(store: CodexStore, file: CredentialSeen) -> Observed {
    match (file, store) {
        (CredentialSeen::Present, _) => Observed::Yes,
        (CredentialSeen::Absent, CodexStore::File) => Observed::No,
        _ => Observed::Unknown,
    }
}

/// One github.com account in `gh auth status --json hosts`.
#[derive(Debug, Clone, PartialEq)]
pub struct GhAccount {
    pub login: String,
    pub signed_in: bool,
    pub active: bool,
    /// `"gist, read:org, repo"`, when gh says.
    pub scopes: Option<String>,
}

/// Pure: github.com's accounts from `gh auth status --json hosts` (all of
/// them, not `--active`). `None` when the output isn't that JSON.
pub fn gh_accounts(stdout: &str) -> Option<Vec<GhAccount>> {
    let json: serde_json::Value = serde_json::from_str(stdout.trim()).ok()?;
    let hosts = json.get("hosts")?.as_object()?;
    let Some(list) = hosts.get(setup_actions::GITHUB_HOST) else {
        return Some(Vec::new());
    };
    Some(
        list.as_array()?
            .iter()
            .filter_map(|a| {
                Some(GhAccount {
                    login: a.get("login")?.as_str()?.to_string(),
                    signed_in: a.get("state").and_then(|v| v.as_str()) == Some("success"),
                    active: a.get("active").and_then(|v| v.as_bool()).unwrap_or(false),
                    scopes: a.get("scopes").and_then(|v| v.as_str()).map(String::from),
                })
            })
            .collect(),
    )
}

/// `add-account.gh`: a signed-in account that wasn't listed before.
pub fn gh_new_account(before: Option<&[GhAccount]>, now: Option<&[GhAccount]>) -> Observed {
    let Some(now) = now else {
        return Observed::Unknown;
    };
    match before {
        Some(before) => now
            .iter()
            .any(|a| {
                a.signed_in
                    && !before
                        .iter()
                        .any(|b| b.login.eq_ignore_ascii_case(&a.login))
            })
            .into(),
        // No list from before: an account now proves nothing new.
        None if now.iter().any(|a| a.signed_in) => Observed::Unknown,
        None => Observed::No,
    }
}

/// `login.gh`: a new account, or a signed-in one where none was before (a
/// sign-in again of an account whose token had gone bad).
pub fn gh_signed_in(before: Option<&[GhAccount]>, now: Option<&[GhAccount]>) -> Observed {
    let Some(now_list) = now else {
        return Observed::Unknown;
    };
    // Challenger P3-1: without a list from before, an account now proves
    // nothing about this sign-in.
    let Some(before_list) = before else {
        return if now_list.iter().any(|a| a.signed_in) {
            Observed::Unknown
        } else {
            Observed::No
        };
    };
    let none_before = !before_list.iter().any(|a| a.signed_in);
    if gh_new_account(before, now) == Observed::Yes
        || (none_before && now_list.iter().any(|a| a.signed_in))
    {
        Observed::Yes
    } else {
        Observed::No
    }
}

/// `refresh.gh`: the active account's token has `repo` and `read:org`.
pub fn gh_scopes_ok(now: Option<&[GhAccount]>) -> Observed {
    let Some(account) = now.and_then(|n| n.iter().find(|a| a.active && a.signed_in)) else {
        return Observed::Unknown;
    };
    let Some(scopes) = &account.scopes else {
        return Observed::Unknown;
    };
    let has = |want: &str| scopes.split(',').any(|s| s.trim() == want);
    (has("repo") && has("read:org")).into()
}

/// `setupgit.gh`: git's `credential.https://github.com.helper` values ask gh
/// (`!/opt/homebrew/bin/gh auth git-credential`, MEASUREMENTS §9).
pub fn gh_helper_set(helpers: &str) -> Observed {
    helpers
        .lines()
        .any(|l| l.trim().ends_with("auth git-credential"))
        .into()
}

// ── The machine, for real ──────────────────────────────────────────────

/// OB-6: the app macOS opens for `xcode-select --install`
/// (`/System/Library/CoreServices/Install Command Line Developer Tools.app`).
#[cfg(target_os = "macos")]
const CLT_INSTALLER: &str = "Install Command Line Developer Tools";

/// What was there before the run.
#[derive(Debug, Clone, Default)]
pub struct Baseline {
    pub gh: Option<Vec<GhAccount>>,
    pub credential_there: bool,
}

/// Looks at the machine. A trait so the runner's loop is tested with a
/// scripted one.
pub trait Observer: Send + Sync {
    fn baseline(&self, watch: Watch) -> Baseline;
    /// One look. For [`Watch::ToolWorks`] it re-probes the shell first.
    fn observe(&self, watch: Watch, baseline: &Baseline) -> Observed;
    /// Re-probe the shell and drop what the doctor remembered.
    fn re_probe(&self);
    /// OB-6: whether the macOS "Install Command Line Developer Tools"
    /// window is up; `None` = could not tell (and on Windows).
    fn installer_running(&self) -> Option<bool> {
        None
    }
    /// R2: the tool's version as it answers now (`--version`, bounded);
    /// `None` when it isn't there or doesn't answer. Read before an install
    /// or update and after the look that follows it.
    fn version(&self, _tool: Tool) -> Option<String> {
        None
    }
    /// R2: the newest release the doctor last read for `tool` (no network:
    /// only a fresh remembered answer).
    fn known_latest(&self, _tool: Tool) -> Option<String> {
        None
    }
}

/// The real observer.
pub struct SystemObserver<R: Runtime> {
    pub app: AppHandle<R>,
}

impl<R: Runtime> SystemObserver<R> {
    fn gh_list(&self) -> Option<Vec<GhAccount>> {
        let env = crate::shell_env::get();
        let gh = env.gh_path.as_deref()?;
        let mut command = crate::platform::command(gh, &env.path);
        command
            .args(["auth", "status", "--json", "hosts"])
            .env("PATH", &env.path)
            .env("GH_PROMPT_DISABLED", "1");
        let out =
            crate::worktrees::run_bounded_output(&mut command, Duration::from_secs(6)).ok()?;
        gh_accounts(&String::from_utf8_lossy(&out.stdout))
    }

    fn git_helpers(&self) -> Observed {
        let env = crate::shell_env::get();
        if !env.git_works() {
            return Observed::Unknown;
        }
        let mut command = crate::platform::git_command();
        command.args([
            "config",
            "--global",
            "--get-all",
            "credential.https://github.com.helper",
        ]);
        match crate::worktrees::run_bounded_output(&mut command, Duration::from_secs(5)) {
            Ok(out) if out.status.success() => gh_helper_set(&String::from_utf8_lossy(&out.stdout)),
            Ok(out) if out.status.code() == Some(1) => Observed::No,
            _ => Observed::Unknown,
        }
    }

    fn credential(&self, watch: Watch) -> Observed {
        match watch {
            Watch::ClaudeSignIn => {
                let (keychain, file) = crate::claude_auth::read();
                claude_seen(keychain, file)
            }
            Watch::CodexSignIn => {
                let (store, file) = crate::doctor_reads::codex_auth();
                codex_seen(store, file)
            }
            _ => Observed::Unknown,
        }
    }
}

impl<R: Runtime> Observer for SystemObserver<R> {
    fn baseline(&self, watch: Watch) -> Baseline {
        match watch {
            Watch::GhNewAccount | Watch::GhSignedIn => Baseline {
                gh: self.gh_list(),
                ..Baseline::default()
            },
            Watch::ClaudeSignIn | Watch::CodexSignIn => Baseline {
                credential_there: self.credential(watch) == Observed::Yes,
                ..Baseline::default()
            },
            _ => Baseline::default(),
        }
    }

    fn observe(&self, watch: Watch, baseline: &Baseline) -> Observed {
        match watch {
            Watch::ToolWorks(tool) => {
                // 1.176.1: a change this look finds in the step's own tool is
                // Setup's, which Setup reports itself (`cli_seen`).
                let _own = own_change(Some(tool));
                self.re_probe();
                tool_works(tool, &crate::shell_env::get(), cfg!(windows)).into()
            }
            Watch::ClaudeSignIn | Watch::CodexSignIn => self.credential(watch),
            Watch::GhNewAccount => {
                gh_new_account(baseline.gh.as_deref(), self.gh_list().as_deref())
            }
            Watch::GhSignedIn => gh_signed_in(baseline.gh.as_deref(), self.gh_list().as_deref()),
            Watch::GhScopes => gh_scopes_ok(self.gh_list().as_deref()),
            Watch::GhGitHelper => self.git_helpers(),
            Watch::CommandLineTools => match crate::shell_env::clt_installed() {
                Some(true) => Observed::Yes,
                Some(false) => Observed::No,
                None => Observed::Unknown,
            },
            // Read only: Claude writes its own state, Plyloft never does.
            Watch::ClaudeFolderTrust => match self.app.path().app_config_dir() {
                Ok(config) => folder_trust_seen(crate::claude_session::folder_trusted(
                    &crate::claude_session::sessions_root(&config),
                )),
                Err(_) => Observed::Unknown,
            },
            // A clone is watched by `project_setup::CloneObserver`.
            Watch::Answer | Watch::Cloned | Watch::ExitCode => Observed::Unknown,
        }
    }

    #[cfg(target_os = "macos")]
    fn installer_running(&self) -> Option<bool> {
        // The window `xcode-select --install` opens is its own app; `-f`
        // matches its full path (the process name is cut at 16 bytes).
        let mut command = crate::platform::new_command("/usr/bin/pgrep");
        command.args(["-f", CLT_INSTALLER]);
        let out =
            crate::worktrees::run_bounded_output(&mut command, Duration::from_secs(3)).ok()?;
        match out.status.code() {
            Some(0) => Some(true),
            Some(1) => Some(false),
            _ => None,
        }
    }

    fn version(&self, tool: Tool) -> Option<String> {
        let env = crate::shell_env::get();
        let path = match tool {
            Tool::Claude => env.claude_path.as_deref(),
            Tool::Codex => env.codex_path.as_deref(),
            Tool::Gh => env.gh_path.as_deref(),
            Tool::Git => env.git_path.as_deref(),
            Tool::Node => env.node_path.as_deref(),
        }?;
        let mut command = crate::platform::command(path, &env.path);
        command.arg("--version").env("PATH", &env.path);
        let out =
            crate::worktrees::run_bounded_output(&mut command, Duration::from_secs(10)).ok()?;
        evidence::version_from_output(
            &String::from_utf8_lossy(&out.stdout),
            &String::from_utf8_lossy(&out.stderr),
            out.status.success(),
        )
    }

    fn known_latest(&self, tool: Tool) -> Option<String> {
        let latest = crate::doctor_reads::latest_versions(false, &crate::shell_env::get().path);
        match tool {
            Tool::Claude => latest.claude,
            Tool::Codex => latest.codex,
            Tool::Gh => latest.gh,
            Tool::Git | Tool::Node => None,
        }
    }

    fn re_probe(&self) {
        let capabilities = self
            .app
            .try_state::<crate::review_capabilities::ReviewerCapabilityRegistry>();
        crate::commands::re_probe_and_forget(capabilities.as_deref());
    }
}

/// 1.176.1 (review 1): the runs that get the system folders after their
/// PATH: those that install, update, remove or hand back a tool
/// (`setup_outcome::program_tool`) — never a sign-in, `trust.claude` or a
/// status read.
pub(crate) fn adds_system_dirs(action: ActionId) -> bool {
    evidence::program_tool(action).is_some()
}

/// 1.176.1: the [`crate::cli_seen::OwnChange`] for a step on `tool`: only
/// Claude's or Codex's (a git, gh or Node step marks nothing).
fn own_change(tool: Option<Tool>) -> Option<crate::cli_seen::OwnChange> {
    let cli = match tool? {
        Tool::Claude => crate::cli_fresh::Cli::Claude,
        Tool::Codex => crate::cli_fresh::Cli::Codex,
        Tool::Gh | Tool::Git | Tool::Node => return None,
    };
    Some(crate::cli_seen::OwnChange::new(&[cli]))
}

// ── The runner ─────────────────────────────────────────────────────────

/// What the frontend gets back from `setup_run`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SetupStarted {
    pub run_id: String,
    pub action_id: String,
    pub pty_id: String,
    /// The command, as a consent sheet's Details names it.
    pub display: String,
    pub watch: Watch,
}

/// A `setup://progress` event.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SetupEvent {
    pub run_id: String,
    pub action_id: String,
    pub pty_id: Option<String>,
    pub phase: Phase,
    pub outcome: Option<Outcome>,
    pub exit_code: Option<i32>,
    /// The shell was re-probed: the frontend refreshes the doctor.
    pub reprobed: bool,
    /// The last output lines, ANSI stripped (final event only).
    pub tail: Vec<String>,
    /// OB-11, a clone's final event: what it got (or why not, and that the
    /// folder Ply made for it was removed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clone: Option<crate::project_setup::CloneResult>,
    /// R2, the final event: cause, causePath, versionBefore, versionAfter.
    #[serde(flatten)]
    pub evidence: Evidence,
}

pub type Emit = Arc<dyn Fn(&SetupEvent) + Send + Sync>;

struct ActiveRun {
    started: SetupStarted,
    action: ActionId,
    pid: Option<u32>,
    cancel: Arc<AtomicBool>,
    /// Set once the child has exited and been reaped: its pid is no longer
    /// its own, so nothing is signalled after that.
    exited: Arc<AtomicBool>,
    /// OB-11: a clone's folder, removed when Ply quits mid-clone.
    clone: Option<crate::project_setup::CloneRun>,
}

#[derive(Default)]
struct RunnerState {
    active: Option<ActiveRun>,
    closed: bool,
}

/// The one guided run (managed state).
#[derive(Default, Clone)]
pub struct SetupRunner {
    state: Arc<Mutex<RunnerState>>,
    /// R2: the folder the last-run record is kept in (`setup_last_run`);
    /// `None` keeps nothing (a test's runner, a config dir that didn't
    /// resolve).
    records: Arc<Mutex<Option<std::path::PathBuf>>>,
}

impl SetupRunner {
    /// The run under way, if any (a remounted panel reattaches to it).
    pub fn active(&self) -> Option<SetupStarted> {
        self.state
            .lock()
            .active
            .as_ref()
            .filter(|a| !a.started.pty_id.is_empty())
            .map(|a| a.started.clone())
    }

    /// 1.176.0 R5: a run holds the slot, its terminal started or not yet.
    pub fn running(&self) -> bool {
        self.state.lock().active.is_some()
    }

    /// R2: keep each install's or update's end in `dir`'s record.
    pub fn keep_records_in(&self, dir: std::path::PathBuf) {
        *self.records.lock() = Some(dir);
    }

    #[cfg(test)]
    pub(crate) fn active_pid(&self) -> Option<u32> {
        self.state.lock().active.as_ref().and_then(|a| a.pid)
    }

    /// Start `plan`. Refused while another run is under way, after quit,
    /// and for the AI step's status reads (those are `setup_check`).
    #[allow(clippy::too_many_arguments)]
    pub fn start<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        plan: RunPlan,
        observer: Arc<dyn Observer>,
        timing: Timing,
        emit: Emit,
        cols: u16,
        rows: u16,
    ) -> Result<SetupStarted, String> {
        if plan.watch == Watch::Answer {
            return Err(format!(
                "{} is a check, not a terminal run.",
                plan.action.id()
            ));
        }
        // Claude asks to trust the folder it starts in: never the home one.
        if plan.watch == Watch::ClaudeFolderTrust && plan.cwd.is_none() {
            return Err(NO_REVIEW_FOLDER.into());
        }
        let run_id = Uuid::new_v4().to_string();
        let cancel = Arc::new(AtomicBool::new(false));
        let exited = Arc::new(AtomicBool::new(false));
        {
            let mut state = self.state.lock();
            if state.closed {
                return Err(QUITTING.into());
            }
            if let Some(active) = &state.active {
                return Err(busy(active.action));
            }
            state.active = Some(ActiveRun {
                started: SetupStarted {
                    run_id: run_id.clone(),
                    action_id: plan.action.id().into(),
                    pty_id: String::new(),
                    display: plan.display.clone(),
                    watch: plan.watch,
                },
                action: plan.action,
                pid: None,
                cancel: cancel.clone(),
                exited: exited.clone(),
                clone: plan.clone.clone(),
            });
        }
        // Challenger P3-2: whatever ends this function or the watcher —
        // an error, a panic — frees the slot for this run.
        let mut slot = SlotGuard {
            state: self.state.clone(),
            run_id: run_id.clone(),
            on_abandon: None,
        };
        // 1.176.0 R5: never beside the automatic Codex update, which checks
        // this slot after taking its own gate (one of the two sees the other).
        if plan.action.id().ends_with(".codex") && crate::codex_auto_update::updating() {
            return Err(crate::codex_auto_update::SETUP_REFUSED.into());
        }

        let baseline = observer.baseline(plan.watch);
        // R2: what the tool answers before an install or update touches it.
        let program = evidence::program_tool(plan.action);
        if program.is_some() {
            // The read takes a moment (10 s at most): say so first.
            emit(&SetupEvent {
                run_id: run_id.clone(),
                action_id: plan.action.id().into(),
                pty_id: None,
                phase: Phase::Preparing,
                outcome: None,
                exit_code: None,
                reprobed: false,
                tail: Vec::new(),
                clone: None,
                evidence: Evidence::default(),
            });
        }
        let version_before = program.and_then(|tool| observer.version(tool));
        let newer_known = evidence::is_update(plan.action)
            && program.is_some_and(|tool| {
                evidence::newer_known(version_before.as_deref(), observer.known_latest(tool).as_deref())
            });
        // Quit, or a Stop, during the read: nothing is started.
        if self.state.lock().closed {
            return Err(QUITTING.into());
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(STOPPED_BEFORE.into());
        }
        let started_at = chrono::Utc::now().to_rfc3339();
        log::info!(
            "setup_run: start {} ({}){}",
            plan.action.id(),
            program_name(&plan.argv),
            version_before
                .as_deref()
                .map(|v| format!(", version before {v}"))
                .unwrap_or_default()
        );
        let capture = Arc::new(Mutex::new(Vec::<u8>::new()));
        let (exit_tx, exit_rx) = std::sync::mpsc::channel::<Option<i32>>();
        let mut run_env = crate::shell_env::get().proxy_env.clone();
        run_env.extend(plan.env.iter().cloned());
        // D7: the chosen account's token reaches this run's environment only.
        if let Some(token) = &plan.token {
            run_env.push(("GH_TOKEN".into(), token.expose().to_string()));
        }
        // 1.176.1: Plyloft's own command steps (installers, updates, npm
        // removal, chown) never die of "command not found" because of the
        // person's Program folders: the system folders follow the run's PATH
        // (never before it). Review 1: only those (`adds_system_dirs`); a
        // sign-in, the trust question and the status reads run the tool
        // itself, as a tile would, with exactly the person's PATH.
        let run_env = if adds_system_dirs(plan.action) {
            crate::program_folders::steps_env(
                run_env,
                &crate::shell_env::get().path,
                cfg!(windows),
                std::env::var("SystemRoot").ok().as_deref(),
            )
        } else {
            run_env
        };
        let Some(pty) = app.try_state::<PtyRegistry>() else {
            return Err("The terminal registry isn't ready.".into());
        };
        let spawned = pty.spawn_setup(
            app.clone(),
            plan.argv.clone(),
            plan.direct,
            plan.cwd.as_deref(),
            run_env,
            setup_intent(plan.action),
            cols.max(20),
            rows.max(5),
            capture.clone(),
            exited.clone(),
            Box::new(move |code| {
                let _ = exit_tx.send(code);
            }),
        );
        let (pty_id, pid) = match spawned {
            Ok(spawned) => spawned,
            Err(error) => return Err(error),
        };
        let started = {
            let mut state = self.state.lock();
            let active = state.active.as_mut().filter(|a| a.started.run_id == run_id);
            match active {
                Some(active) => {
                    active.started.pty_id = pty_id.clone();
                    active.pid = pid;
                    active.started.clone()
                }
                // Quit (or a Stop) came while it spawned.
                None => SetupStarted {
                    run_id: run_id.clone(),
                    action_id: plan.action.id().into(),
                    pty_id: pty_id.clone(),
                    display: plan.display.clone(),
                    watch: plan.watch,
                },
            }
        };
        if cancel.load(Ordering::SeqCst) || self.state.lock().closed {
            end_tree(&pty, &pty_id, pid, &exited, None);
        }
        emit(&SetupEvent {
            run_id: run_id.clone(),
            action_id: plan.action.id().into(),
            pty_id: Some(pty_id.clone()),
            phase: Phase::Running,
            outcome: None,
            exit_code: None,
            reprobed: false,
            tail: Vec::new(),
            clone: None,
            evidence: Evidence::default(),
        });
        // A watcher that dies (a panic in a look) still ends its run: the
        // tree is killed and Done says Plyloft could not tell.
        slot.on_abandon = Some({
            let app = app.clone();
            let emit = emit.clone();
            let (pty_id, exited) = (pty_id.clone(), exited.clone());
            let clone_run = plan.clone.clone();
            let mut done = SetupEvent {
                run_id: run_id.clone(),
                action_id: plan.action.id().into(),
                pty_id: Some(pty_id.clone()),
                phase: Phase::Done,
                outcome: Some(Outcome::CouldNotTell),
                exit_code: None,
                reprobed: false,
                tail: Vec::new(),
                clone: None,
                evidence: Evidence::default(),
            };
            Box::new(move || {
                if let Some(pty) = app.try_state::<PtyRegistry>() {
                    end_tree(&pty, &pty_id, pid, &exited, None);
                }
                // A clone that ended this way removes the folder it made.
                if let Some(run) = &clone_run {
                    done.clone = Some(crate::project_setup::finish_clone(
                        run,
                        false,
                        false,
                        &[],
                        &crate::project_setup::Tools::production(),
                    ));
                }
                emit(&done);
            })
        });
        let watcher = Watcher {
            slot,
            app: app.clone(),
            state: self.state.clone(),
            run_id,
            plan,
            pty_id,
            pid,
            cancel,
            exited,
            exit_rx,
            capture,
            observer,
            baseline,
            timing,
            emit,
            version_before,
            newer_known,
            started_at,
            records: self.records.lock().clone(),
        };
        thread::spawn(move || watcher.run());
        Ok(started)
    }

    /// Stop the run (`run_id`, or whichever runs): its whole tree is killed
    /// and the watcher ends it as Cancelled. False when nothing ran.
    pub fn stop<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        run_id: Option<&str>,
        timing: &Timing,
    ) -> bool {
        let target = {
            let state = self.state.lock();
            state
                .active
                .as_ref()
                .filter(|a| run_id.is_none_or(|id| id == a.started.run_id))
                .map(|a| {
                    (
                        a.started.pty_id.clone(),
                        a.pid,
                        a.cancel.clone(),
                        a.exited.clone(),
                    )
                })
        };
        let Some((pty_id, pid, cancel, exited)) = target else {
            return false;
        };
        cancel.store(true, Ordering::SeqCst);
        if let Some(pty) = app.try_state::<PtyRegistry>() {
            end_tree(&pty, &pty_id, pid, &exited, Some(timing.kill_grace));
        }
        true
    }

    /// Quit (the exit cleanup — `RunEvent::ExitRequested` or `Exit` — before `PtyRegistry::kill_all`):
    /// refuse every later run and kill the one under way, group and all, at
    /// once. Returns whether one ran.
    pub fn shutdown(&self, pty: &PtyRegistry) -> bool {
        let target = {
            let mut state = self.state.lock();
            state.closed = true;
            state.active.as_ref().map(|a| {
                (
                    a.started.pty_id.clone(),
                    a.pid,
                    a.cancel.clone(),
                    a.exited.clone(),
                    a.clone.clone(),
                )
            })
        };
        let Some((pty_id, pid, cancel, exited, clone)) = target else {
            return false;
        };
        cancel.store(true, Ordering::SeqCst);
        end_tree(pty, &pty_id, pid, &exited, None);
        // OB-11: a clone cut short by quitting leaves no partial folder
        // (the watcher may not get to it before the process ends).
        if let Some(run) = clone {
            crate::project_setup::remove_created(&run.dest);
        }
        true
    }
}

/// Hard Rule 4: what the exit cleanup (`RunEvent::ExitRequested` or `Exit`) runs for Setup, before
/// `PtyRegistry::kill_all`. True when a run was under way.
pub fn exit_cleanup(runner: &SetupRunner, pty: &PtyRegistry) -> bool {
    runner.shutdown(pty)
}

/// The typed intent of every guided run (PATTERNS: every managed PTY spawn
/// carries one): no workspace, a person watching, exempt from project
/// coordination, never recorded.
pub fn setup_intent(action: ActionId) -> crate::coordination::SpawnIntent {
    use crate::coordination::*;
    SpawnIntent {
        provider: Provider::System,
        execution_kind: ExecutionKind::Setup,
        attendance: Attendance::HumanAttended,
        write_intent: WriteIntent::Unknown,
        enforcement: Enforcement::Exempt,
        project: SpawnProject::NonProject {
            reason: "setup".into(),
        },
        capability: None,
        card_id: None,
        swarm_id: None,
        role_id: None,
        run_id: None,
        retention_class: RetentionClass::Ephemeral,
        objective: Some(action.id().into()),
    }
}

/// Kill a run's tree. Unix: the PTY's child leads its own process group
/// (portable-pty `setsid`s it) — SIGTERM, then SIGKILL after `grace`, or
/// SIGKILL at once (`None`, quitting). Then the PTY itself (its hang-up
/// reaches the foreground group; on Windows its Job Object's console
/// processes are terminated). A child that already exited is not signalled
/// itself: what is left of its group is, and its terminal is closed.
fn end_tree(
    pty: &PtyRegistry,
    pty_id: &str,
    pid: Option<u32>,
    exited: &AtomicBool,
    grace: Option<Duration>,
) {
    if exited.load(Ordering::SeqCst) {
        // Challenger P3-3: the leader is reaped, but members of its group
        // (a helper that ignores the hang-up) may outlive it. The group id
        // stays reserved while any member remains, so it can only name
        // them; once the group is empty the signal finds nothing (ESRCH).
        #[cfg(unix)]
        if let Some(pid) = pid {
            // SAFETY: killpg on the group this run's child created.
            unsafe {
                libc::killpg(pid as crate::platform::Pgid, libc::SIGKILL);
            }
        }
        if !pty_id.is_empty() {
            pty.forget_exited(pty_id);
        }
        return;
    }
    #[cfg(unix)]
    if let Some(pid) = pid {
        let pgid = pid as crate::platform::Pgid;
        match grace {
            Some(grace) => crate::platform::terminate_group(pgid, grace),
            None => {
                // SAFETY: getpgid/killpg on the group this run's child leads;
                // the check keeps a reused pid that leads nothing safe.
                unsafe {
                    if libc::getpgid(pgid) == pgid {
                        libc::killpg(pgid, libc::SIGKILL);
                    }
                }
            }
        }
    }
    #[cfg(not(unix))]
    let _ = (pid, grace);
    if !pty_id.is_empty() {
        let _ = pty.kill(pty_id);
    }
}

/// Holds a run's slot. Dropped still armed (an early return, a panic), it
/// clears `active` for its run only, then runs `on_abandon` (kill the tree,
/// say Done). The watcher disarms it once it has ended the run itself.
struct SlotGuard {
    state: Arc<Mutex<RunnerState>>,
    run_id: String,
    on_abandon: Option<Box<dyn FnOnce() + Send>>,
}

impl SlotGuard {
    fn free(&self) {
        let mut state = self.state.lock();
        if state
            .active
            .as_ref()
            .is_some_and(|a| a.started.run_id == self.run_id)
        {
            state.active = None;
        }
    }

    fn disarm(mut self) {
        self.on_abandon = None;
        self.free();
        std::mem::forget(self);
    }
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        self.free();
        if let Some(abandon) = self.on_abandon.take() {
            abandon();
        }
    }
}

/// Challenger P3-6: the output kept for the tail — its last 256 KB.
pub const CAPTURE_CAP: usize = 256 * 1024;

/// Keep only the last `cap` bytes once the buffer has grown past twice that.
pub fn trim_capture(buf: &mut Vec<u8>, cap: usize) {
    if buf.len() > cap * 2 {
        let cut = buf.len() - cap;
        buf.drain(..cut);
    }
}

struct Watcher<R: Runtime> {
    slot: SlotGuard,
    app: AppHandle<R>,
    state: Arc<Mutex<RunnerState>>,
    run_id: String,
    plan: RunPlan,
    pty_id: String,
    pid: Option<u32>,
    cancel: Arc<AtomicBool>,
    exited: Arc<AtomicBool>,
    exit_rx: Receiver<Option<i32>>,
    capture: Arc<Mutex<Vec<u8>>>,
    observer: Arc<dyn Observer>,
    baseline: Baseline,
    timing: Timing,
    emit: Emit,
    /// R2: the tool's version before the run, and when it started.
    version_before: Option<String>,
    newer_known: bool,
    started_at: String,
    records: Option<std::path::PathBuf>,
}

/// The program an argv runs, by its file name only: the log never gets the
/// arguments (a URL, a token's account) or the folder it lives in.
fn program_name(argv: &[String]) -> String {
    argv.first()
        .map(|p| {
            std::path::Path::new(p)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| p.clone())
        })
        .unwrap_or_default()
}

/// R2: how many tail lines the log gets at a run's end.
pub const LOG_TAIL_LINES: usize = 40;

impl<R: Runtime> Watcher<R> {
    fn event(
        &self,
        phase: Phase,
        outcome: Option<Outcome>,
        exit: Option<Option<i32>>,
        reprobed: bool,
        tail: Vec<String>,
    ) -> SetupEvent {
        SetupEvent {
            run_id: self.run_id.clone(),
            action_id: self.plan.action.id().into(),
            pty_id: Some(self.pty_id.clone()),
            phase,
            outcome,
            exit_code: exit.flatten(),
            reprobed,
            tail,
            clone: None,
            evidence: Evidence::default(),
        }
    }

    /// R2: the final event's evidence — the cause for a run that didn't
    /// work (not for a success, nor for the person's own Stop), the versions
    /// for an install or update.
    fn evidence(
        &self,
        outcome: Outcome,
        exit: Option<Option<i32>>,
        tail: &[String],
        version_after: Option<String>,
    ) -> Evidence {
        let explained = !matches!(outcome, Outcome::Succeeded | Outcome::Cancelled);
        let diagnosis = explained
            .then(|| evidence::classify_for(self.plan.action, tail, exit.flatten(), outcome == Outcome::TimedOut));
        let program = evidence::program_tool(self.plan.action).is_some();
        let permissions = diagnosis.as_ref().map(|d| d.cause) == Some(evidence::Cause::Permissions);
        let cause_path = diagnosis.as_ref().and_then(|d| d.path.clone()).map(|p| {
            if permissions {
                evidence::folder_to_fix(&p, std::path::Path::new(&p).is_dir())
            } else {
                p
            }
        });
        Evidence {
            cause: diagnosis.as_ref().map(|d| d.cause),
            // R4 (M4): nothing read from a chown's output but its cause.
            cause_path: cause_path.filter(|_| evidence::keeps_tail(self.plan.action)),
            version_before: self.version_before.clone().filter(|_| program),
            version_after: version_after.filter(|_| program),
        }
    }

    /// R2: the end goes to the log and, for an install or update, to the
    /// last-run record on disk.
    fn finish(&self, done: &SetupEvent) {
        let outcome = done.outcome.map(|o| wire(&o)).unwrap_or_default();
        let e = &done.evidence;
        // Only an install's or update's output: a sign-in's shows one-time
        // codes, which have no place in a log.
        let program = evidence::program_tool(self.plan.action);
        let skip = if program.is_some() {
            done.tail.len().saturating_sub(LOG_TAIL_LINES)
        } else {
            done.tail.len()
        };
        let line = format!(
            "setup_run: end {} {outcome}, exit {:?}, cause {:?}{}, version {} -> {}\n{}",
            done.action_id,
            done.exit_code,
            e.cause,
            e.cause_path.as_deref().map(|p| format!(" ({p})")).unwrap_or_default(),
            e.version_before.as_deref().unwrap_or("-"),
            e.version_after.as_deref().unwrap_or("-"),
            done.tail[skip..].join("\n"),
        );
        if matches!(done.outcome, Some(Outcome::Succeeded | Outcome::Cancelled)) {
            log::info!("{line}");
        } else {
            log::warn!("{line}");
        }
        // A run the person stopped (or Plyloft quitting cut short) tells a
        // Repair nothing: the tool's last informative record stays.
        let stopped = done.outcome == Some(Outcome::Cancelled);
        let (Some(dir), Some(tool), false) = (&self.records, program, stopped) else {
            return;
        };
        let run = crate::setup_last_run::LastRun {
            action_id: done.action_id.clone(),
            started_at: Some(self.started_at.clone()),
            finished_at: Some(chrono::Utc::now().to_rfc3339()),
            exit_code: done.exit_code,
            outcome: Some(outcome),
            cause: e.cause.map(|c| wire(&c)),
            cause_path: e.cause_path.clone(),
            version_before: e.version_before.clone(),
            version_after: e.version_after.clone(),
            tail: done.tail.clone(),
        };
        if let Err(error) = crate::setup_last_run::record(dir, tool, run) {
            log::warn!("setup_run: couldn't keep the last run of {}: {error}", done.action_id);
        }
        // R5: the automatic Codex update keeps the record in memory.
        if tool == Tool::Codex {
            crate::codex_auto_update::note_records_changed();
        }
    }

    fn run(self) {
        let watch = self.plan.watch;
        let timing = self.timing;
        let started = Instant::now();
        let poll = poll_every(watch, &timing);
        let mut next_poll = poll.map(|every| started + every);
        let mut exit: Option<Option<i32>> = None;
        let mut looked_after_exit = false;
        let mut warned_long = false;
        let (mut installer_seen, mut installer_absent) = (false, 0u32);
        let mut installer_gone = false;
        // R2: the output's growth, for the idle limit (only this loop trims
        // the capture, so any other change in its length is new output).
        let (mut last_len, mut last_output) = (0usize, started);
        let program = evidence::program_tool(self.plan.action);
        let compare = evidence::is_update(self.plan.action);
        let mut version_after: Option<String> = None;
        let mut version = VersionChange::NotCompared;
        let mut update_claimed = false;
        let outcome = loop {
            if exit.is_none() {
                match self.exit_rx.recv_timeout(timing.tick) {
                    Ok(code) => exit = Some(code),
                    // The PTY never reports: it is gone.
                    Err(RecvTimeoutError::Disconnected) => exit = Some(None),
                    Err(RecvTimeoutError::Timeout) => {}
                }
            } else {
                thread::sleep(timing.tick);
            }
            {
                let mut buf = self.capture.lock();
                if buf.len() != last_len {
                    last_output = Instant::now();
                }
                trim_capture(&mut buf, CAPTURE_CAP);
                last_len = buf.len();
            }
            let cancelled = self.cancel.load(Ordering::SeqCst);
            let mut observed = None;
            if !cancelled {
                let now = Instant::now();
                if exit.is_some() && !looked_after_exit && watch != Watch::CommandLineTools {
                    (self.emit)(&self.event(Phase::Checking, None, exit, false, Vec::new()));
                    observed = Some(self.observer.observe(watch, &self.baseline));
                    looked_after_exit = true;
                    // R2: the version as it answers after the look's re-probe.
                    if let Some(tool) = program.filter(|_| matches!(watch, Watch::ToolWorks(_))) {
                        version_after = self.observer.version(tool);
                        if compare {
                            version = evidence::version_change(
                                self.version_before.as_deref(),
                                version_after.as_deref(),
                            );
                            update_claimed = evidence::claims_update(&tail_lines(
                                &self.capture.lock(),
                                TAIL_LINES,
                            ));
                        }
                    }
                } else if next_poll.is_some_and(|at| now >= at) {
                    observed = Some(self.observer.observe(watch, &self.baseline));
                    next_poll = poll.map(|every| now + every);
                    if watch == Watch::CommandLineTools && observed != Some(Observed::Yes) {
                        installer_gone = track_installer(
                            &mut installer_seen,
                            &mut installer_absent,
                            self.observer.installer_running(),
                        );
                    }
                }
            }
            // A Stop pressed during the look (its version read) wins.
            let cancelled = cancelled || self.cancel.load(Ordering::SeqCst);
            let state = WatchState {
                elapsed: started.elapsed(),
                exit,
                cancelled,
                observed,
                already_there: self.baseline.credential_there,
                warned_long,
                installer_gone,
                version,
                idle: last_output.elapsed(),
                update_claimed,
                newer_known: self.newer_known,
            };
            match decide(watch, &state, &timing) {
                Decision::Wait => {}
                Decision::WaitLong => {
                    warned_long = true;
                    (self.emit)(&self.event(Phase::WaitingLong, None, None, false, Vec::new()));
                }
                Decision::Done(outcome) => break outcome,
            }
        };

        // Seen while the command still runs (a login printing its last
        // lines): let it finish on its own, then stop it. A run at its time
        // limit gets no grace: it is ended below exactly as Stop ends one.
        // A Stop that came while the limit was reached wins: it already
        // ended the tree, and the run says Cancelled.
        let outcome = if outcome == Outcome::TimedOut && self.cancel.load(Ordering::SeqCst) {
            Outcome::Cancelled
        } else {
            outcome
        };
        let timed_out = outcome == Outcome::TimedOut && exit.is_none();
        if exit.is_none() && outcome != Outcome::Cancelled && !timed_out {
            let grace = if stops_on_sight(watch) {
                timing.trust_settle
            } else {
                timing.success_grace
            };
            if let Ok(code) = self.exit_rx.recv_timeout(grace) {
                exit = Some(code);
            }
        }
        // Still running: its tree is ended. Exited: its terminal is let go.
        if let Some(pty) = self.app.try_state::<PtyRegistry>() {
            let quitting = self.state.lock().closed;
            end_tree(
                &pty,
                &self.pty_id,
                self.pid,
                &self.exited,
                (!quitting).then_some(timing.kill_grace),
            );
        }
        // An install or update re-probes whatever happened (spec §5 step 3);
        // a ToolWorks look after the exit already did.
        let reprobed = self.plan.action.changes_programs();
        let probed_by_look = matches!(watch, Watch::ToolWorks(_)) && looked_after_exit;
        let quitting = self.state.lock().closed;
        if reprobed && !probed_by_look && !quitting {
            let _own = own_change(program);
            self.observer.re_probe();
        }
        // R2: a run that ended without its look (stopped, timed out) still
        // says what the tool answers now.
        if let Some(tool) = program.filter(|_| !looked_after_exit && !quitting) {
            version_after = self.observer.version(tool);
        }
        let tail: Vec<String> = tail_lines(&self.capture.lock(), TAIL_LINES)
            .iter()
            .map(|l| crate::project_setup::redact(l, self.plan.token.as_ref()))
            .collect();
        let mut done = self.event(Phase::Done, Some(outcome), exit, reprobed, tail);
        done.evidence = self.evidence(outcome, exit, &done.tail, version_after);
        // R4 (M4): a Repair's chown keeps no output anywhere (a typed-ahead
        // password); its cause was read from it above, in memory only.
        done.tail = evidence::kept_tail(self.plan.action, std::mem::take(&mut done.tail));
        self.finish(&done);
        // OB-11: a clone's end — removed unless it succeeded, else read.
        if let Some(run) = &self.plan.clone {
            done.clone = Some(crate::project_setup::finish_clone(
                run,
                outcome == Outcome::Succeeded,
                outcome == Outcome::Cancelled,
                &done.tail,
                &crate::project_setup::Tools::production(),
            ));
        }
        // Free the slot before saying so: the next step may start at once.
        let emit = self.emit.clone();
        self.slot.disarm();
        emit(&done);
    }
}

/// A unit enum's wire name (`"still-on-old-version"`, `"file-in-use"`).
fn wire<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default()
}

/// Pure: the last `n` lines of the output, escapes stripped, blank lines at
/// the end dropped.
pub fn tail_lines(bytes: &[u8], n: usize) -> Vec<String> {
    let text = crate::verify::strip_ansi(&String::from_utf8_lossy(bytes));
    let mut lines: Vec<String> = text
        .split('\n')
        .map(|l| {
            l.trim_end_matches('\r')
                .rsplit('\r')
                .next()
                .unwrap_or("")
                .to_string()
        })
        .collect();
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    let skip = lines.len().saturating_sub(n);
    lines.split_off(skip)
}

// ── The AI step's reads (D2, D4) ───────────────────────────────────────

/// `status.claude` / `status.codex`, bounded to 6 s. Only Setup's AI step
/// calls this (spec D2, D4); Diagnostics and the doctor never do.
pub fn check(action: ActionId) -> Result<SignInAnswer, String> {
    if !action.is_status_read() {
        return Err(format!("{} isn't a check.", action.id()));
    }
    let env = crate::shell_env::get();
    let facts = PlanFacts::read(&env);
    let plan = setup_actions::plan(action, None, &facts)?;
    let (program, args) = plan
        .argv
        .split_first()
        .ok_or_else(|| "nothing to run".to_string())?;
    let mut command = crate::platform::command(program, &env.path);
    // The user's own CODEX_HOME, never an overlay: nothing is set here.
    command.args(args).env("PATH", &env.path);
    let out = crate::worktrees::run_bounded_output(&mut command, Duration::from_secs(6));
    let (code, stdout, stderr) = match out {
        Ok(out) => (
            out.status.code(),
            // 1.176.2 R1: codex's `.cmd` shim may run through cmd.exe,
            // whose words are in the OEM code page on Windows.
            crate::platform::decode_console(&out.stdout),
            crate::platform::decode_console(&out.stderr),
        ),
        Err(_) => (None, String::new(), String::new()),
    };
    Ok(match action {
        ActionId::StatusClaude => setup_actions::claude_status_answer(code, &stdout),
        _ => setup_actions::codex_status_answer(code, &stderr),
    })
}

// ── Commands ───────────────────────────────────────────────────────────

pub(crate) fn app_emit<R: Runtime>(app: &AppHandle<R>) -> Emit {
    let app = app.clone();
    Arc::new(move |event: &SetupEvent| {
        let _ = app.emit(EVENT, event);
    })
}

/// `trust.claude`'s folder: Plyloft's review folder, made if missing (as
/// `claude_review_trust_status` does), so Claude starts in it.
fn review_folder<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, String> {
    let config = app.path().app_config_dir().map_err(|_| NO_REVIEW_FOLDER.to_string())?;
    let folder = crate::claude_session::sessions_root(&config);
    std::fs::create_dir_all(&folder).map_err(|_| NO_REVIEW_FOLDER.to_string())?;
    Ok(folder)
}

/// Run a Setup action in the guided terminal. The frontend sends only the
/// action id and, for gh, `{ hostname: "github.com" }`.
#[tauri::command]
pub async fn setup_run(
    app: AppHandle,
    action_id: String,
    args: Option<SetupArgs>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<SetupStarted, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let env = crate::shell_env::get();
        let mut plan =
            setup_actions::plan_request(&action_id, args.as_ref(), &PlanFacts::read(&env))?;
        // R4 (B2): never `claude update`/npm on a copy whose folders it
        // can't write; the copy judged is the one Plyloft runs.
        let copy = match plan.action {
            ActionId::UpdateClaude => env.claude_path.clone().map(|p| (crate::cli_health::CliTool::Claude, p)),
            ActionId::UpdateCodex => env.codex_path.clone().map(|p| (crate::cli_health::CliTool::Codex, p)),
            _ => None,
        };
        if let Some((tool, path)) = copy {
            let inputs = crate::cli_health::inputs_now(tool);
            let writable = crate::cli_health::update_folders_writable(tool, &path, &inputs, &crate::cli_health::SystemMachine);
            if let Some(words) = setup_actions::update_refusal(plan.action, writable) {
                return Err(words);
            }
        }
        if plan.action == ActionId::TrustClaude {
            plan.cwd = Some(review_folder(&app)?);
        }
        let runner = app.state::<SetupRunner>();
        if let Some(dir) = crate::setup_last_run::dir_of(&app) {
            runner.keep_records_in(dir);
        }
        runner.start(
            &app,
            plan,
            Arc::new(SystemObserver { app: app.clone() }),
            Timing::REAL,
            app_emit(&app),
            cols.unwrap_or(DEFAULT_COLS),
            rows.unwrap_or(DEFAULT_ROWS),
        )
    })
    .await
    .map_err(|e| format!("setup worker failed: {e}"))?
}

/// Stop the guided run (all of it). `true` when one was running.
#[tauri::command]
pub fn setup_stop(app: AppHandle, runner: State<'_, SetupRunner>, run_id: Option<String>) -> bool {
    runner.stop(&app, run_id.as_deref(), &Timing::REAL)
}

/// The run under way, for a panel that mounts while it runs.
#[tauri::command]
pub fn setup_active(runner: State<'_, SetupRunner>) -> Option<SetupStarted> {
    runner.active()
}

/// `status.claude` / `status.codex` — the AI step's sign-in reads.
#[tauri::command]
pub async fn setup_check(action_id: String) -> Result<SignInAnswer, String> {
    let action =
        ActionId::parse(&action_id).ok_or_else(|| setup_actions::unknown_action(&action_id))?;
    tauri::async_runtime::spawn_blocking(move || check(action))
        .await
        .map_err(|e| format!("setup worker failed: {e}"))?
}

/// OB-5 (spec §5 step 3, "Offline"): before an install downloads anything,
/// one HEAD to the installer's host, bounded to 5 s (`reach_argv`: curl
/// with the run's PATH and proxy variables on the Mac; PowerShell through
/// the system proxy on Windows). A check that can't run says nothing either
/// way, so the install goes ahead (its own error then speaks).
#[tauri::command]
pub async fn setup_reach(action_id: String) -> Result<setup_actions::Reach, String> {
    let action =
        ActionId::parse(&action_id).ok_or_else(|| setup_actions::unknown_action(&action_id))?;
    tauri::async_runtime::spawn_blocking(move || reach_now(action))
        .await
        .map_err(|e| format!("setup worker failed: {e}"))
}

/// The HEAD `setup_reach` makes, blocking (R4's Repair checks the installer's
/// host with it before a plan that installs).
pub fn reach_now(action: ActionId) -> setup_actions::Reach {
    let Some(url) = setup_actions::reach_url(action, cfg!(windows)) else {
        return setup_actions::Reach::ok();
    };
    let powershell = setup_actions::powershell_path();
    let Some(argv) = setup_actions::reach_argv(url, cfg!(windows), powershell.as_deref()) else {
        return setup_actions::Reach::ok();
    };
    let env = crate::shell_env::get();
    let mut command = crate::platform::new_command(&argv[0]);
    command.args(&argv[1..]).env("PATH", crate::program_folders::steps_path(&env.path));
    for (name, value) in &env.proxy_env {
        command.env(name, value);
    }
    match crate::worktrees::run_bounded_output(&mut command, Duration::from_secs(8)) {
        // 1.176.2 R1: Windows PowerShell's localised message, OEM-encoded.
        Ok(out) => setup_actions::reach_verdict(
            out.status.code(),
            &crate::platform::decode_console(&out.stderr),
        ),
        Err(crate::worktrees::BoundedFailure::TimedOut) => setup_actions::reach_verdict(None, ""),
        Err(_) => setup_actions::Reach::ok(),
    }
}

/// OB-5: open one of Setup's pages (a plan page, a vendor's install page)
/// by its id; the URL comes from `setup_actions::setup_page`.
#[tauri::command(async)]
pub fn setup_open_page(page: String) -> Result<(), String> {
    let url = setup_actions::setup_page(&page)
        .ok_or_else(|| "Plyloft doesn't know that page.".to_string())?;
    crate::platform::open_url(url, crate::platform::WEB_SCHEMES).map_err(|e| format!("open failed: {e}"))
}

#[cfg(test)]
#[path = "setup_run_tests.rs"]
mod tests;
