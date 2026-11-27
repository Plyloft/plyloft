//! 1.176.1: say when `claude` or `codex` changed under the person.
//!
//! A CLI that updated itself, or one the person updated in a terminal,
//! changes version — or even folder — without Plyloft saying a word; the
//! 1.176.0 incident began exactly so. Each look at the tools (the launch's,
//! Look again, a start's re-read: every snapshot `shell_env` publishes, via
//! [`observe`]) is compared with the version and folder Plyloft last saw,
//! kept in `cli-seen.json` so the comparison survives restarts. A difference
//! is told once, calmly ("Codex is now 0.171.0 (was 0.166.0)."), through the
//! window's notices (`cli-seen://pending`, drained by `cli_seen_take`).
//!
//! Nothing is said at the first look (nothing to compare), for a version
//! that didn't read, for a tool not found, or for a change Plyloft itself
//! just made through Setup, Repair or the automatic Codex update
//! ([`OwnChange`]) — nor for the person's own Program folders in Settings: those report their own outcome.
//!
//! Why a record of its own: the reviewer proofs
//! (`coordination/reviewer-capabilities.json`) are kept only for a tool
//! somebody proved, and `setup_last_runs.json` only after a run Plyloft made;
//! neither says what a tool was the last time Plyloft looked.
//!
//! C: the reviewer's background re-check is said on its own line right
//! before its real request ([`probe_starting`]), once per tool and version
//! per launch — never at the change, since a re-check owed may still be
//! skipped (offline, superseded, outlasted by a review).

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use ply_collab::Provider;
use serde::{Deserialize, Serialize};

use crate::cli_fresh::Cli;
use crate::shell_env::ShellEnv;

pub(crate) const FILE: &str = "cli-seen.json";
const SCHEMA_VERSION: u32 = 1;

/// The longest an [`OwnChange`] mark counts: a look that never ended (a
/// stuck thread) must not keep a tool quiet for the rest of the session.
const OWN_CHANGE_WINDOW: Duration = Duration::from_secs(10 * 60);

/// The window learns there is something to say (and drains it).
pub const PENDING_EVENT: &str = "cli-seen://pending";

fn schema_version() -> u32 {
    SCHEMA_VERSION
}

/// What Plyloft last saw of one tool: the program it resolved and the
/// version that program answered.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ToolSeen {
    pub path: String,
    pub version: String,
}

/// `cli-seen.json`. Every field defaults, so a file from before a field (or
/// one with keys this build doesn't know) still reads.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SeenRecord {
    #[serde(default = "schema_version")]
    pub schema_version: u32,
    pub claude: Option<ToolSeen>,
    pub codex: Option<ToolSeen>,
}

impl SeenRecord {
    fn tool(&self, cli: Cli) -> Option<&ToolSeen> {
        match cli {
            Cli::Claude => self.claude.as_ref(),
            Cli::Codex => self.codex.as_ref(),
        }
    }

    fn set(&mut self, cli: Cli, seen: ToolSeen) {
        match cli {
            Cli::Claude => self.claude = Some(seen),
            Cli::Codex => self.codex = Some(seen),
        }
    }
}

/// A change worth telling: the version, the folder, or both.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Change {
    pub version: Option<(String, String)>,
    pub folder: Option<(String, String)>,
}

/// What a look at one tool means.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Verdict {
    /// Say nothing and keep the record as it is: not found, version
    /// unreadable, or the same as last seen.
    Keep,
    /// Say nothing, remember this: the first look, Plyloft's own change, or
    /// a new path in the same folder.
    Remember(ToolSeen),
    /// Tell it, and remember this.
    Tell(Change, ToolSeen),
}

fn folder_of(path: &str) -> String {
    Path::new(path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn same_path(a: &str, b: &str, windows: bool) -> bool {
    if windows {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// Pure: the verdict for one tool. `previous` is what was last seen; `path`
/// and `version` what the look found now (`None`: not found, or the version
/// didn't read); `own`: Plyloft itself just changed this tool.
pub(crate) fn decide(
    previous: Option<&ToolSeen>,
    path: Option<&str>,
    version: Option<&str>,
    own: bool,
    windows: bool,
) -> Verdict {
    let (Some(path), Some(version)) = (path, version) else { return Verdict::Keep };
    let now = ToolSeen { path: path.to_string(), version: version.to_string() };
    let Some(previous) = previous else { return Verdict::Remember(now) };
    if same_path(&previous.path, &now.path, windows) && previous.version == now.version {
        return Verdict::Keep;
    }
    if own {
        return Verdict::Remember(now);
    }
    let version = (previous.version != now.version).then(|| (previous.version.clone(), now.version.clone()));
    let (was, is) = (folder_of(&previous.path), folder_of(&now.path));
    let folder = (!same_path(&was, &is, windows)).then_some((was, is));
    if version.is_none() && folder.is_none() {
        return Verdict::Remember(now);
    }
    Verdict::Tell(Change { version, folder }, now)
}

/// Pure: `folder` with `home` as `~` (the separator kept as the folder has it).
pub(crate) fn tilde(folder: &str, home: Option<&str>, windows: bool) -> String {
    let Some(home) = home.map(|h| h.trim_end_matches(['/', '\\'])).filter(|h| !h.is_empty()) else {
        return folder.to_string();
    };
    let starts = if windows {
        folder.get(..home.len()).is_some_and(|head| head.eq_ignore_ascii_case(home))
    } else {
        folder.starts_with(home)
    };
    if !starts {
        return folder.to_string();
    }
    let Some(rest) = folder.get(home.len()..) else { return folder.to_string() };
    if rest.is_empty() {
        "~".into()
    } else if rest.starts_with(['/', '\\']) {
        format!("~{rest}")
    } else {
        folder.to_string()
    }
}

/// What the window is asked to say.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Notice {
    /// A tool changed under the person ([`decide`]'s `Tell`).
    Changed {
        tool: &'static str,
        version_was: Option<String>,
        version_now: Option<String>,
        folder_was: Option<String>,
        folder_now: Option<String>,
    },
    /// The reviewer's background re-check makes its real request now.
    Checking { tool: &'static str, version: String },
}

pub(crate) fn notice_for(cli: Cli, change: &Change, home: Option<&str>, windows: bool) -> Notice {
    let show = |f: &String| tilde(f, home, windows);
    Notice::Changed {
        tool: cli.id(),
        version_was: change.version.as_ref().map(|v| v.0.clone()),
        version_now: change.version.as_ref().map(|v| v.1.clone()),
        folder_was: change.folder.as_ref().map(|f| show(&f.0)),
        folder_now: change.folder.as_ref().map(|f| show(&f.1)),
    }
}

// ── State ──────────────────────────────────────────────────────────────

/// Everything `cli_seen` holds for the session, apart from where the record
/// is kept. Pure: the global wrappers below lock it and pass the clock,
/// the home and the record's write.
#[derive(Debug, Default)]
pub(crate) struct Core {
    pub record: SeenRecord,
    /// Since when Plyloft has been changing each tool itself (Claude,
    /// Codex): set by [`OwnChange`], cleared when its look is over.
    pub own: [Option<Instant>; 2],
    /// Notices the window hasn't taken yet.
    pub pending: Vec<Notice>,
    /// Notices already queued this session: never queued twice (a record
    /// that couldn't be written must not repeat its notice in the session).
    pub told: Vec<Notice>,
    /// Re-checks already told this launch.
    pub told_checks: Vec<(Provider, String)>,
    /// A failed write of the record was logged (once per session).
    pub write_failed: bool,
}

impl Core {
    pub(crate) fn new(record: SeenRecord) -> Self {
        Core { record, ..Core::default() }
    }

    /// The look at `env`: remember what changed (in memory whatever the
    /// write does), queue what is worth telling, and write the record when
    /// it changed. Returns whether something new was queued.
    pub(crate) fn observe_with(
        &mut self,
        env: &ShellEnv,
        now: Instant,
        home: Option<&str>,
        windows: bool,
        write: impl FnOnce(&SeenRecord) -> Result<(), String>,
    ) -> bool {
        let mut changed = false;
        let mut queued = false;
        for cli in [Cli::Claude, Cli::Codex] {
            let version = match cli {
                Cli::Claude => env.claude_version.as_deref(),
                Cli::Codex => env.codex_version.as_deref(),
            };
            let mark = &mut self.own[slot(cli)];
            if mark.is_some_and(|at| now.saturating_duration_since(at) >= OWN_CHANGE_WINDOW) {
                *mark = None;
            }
            let own = mark.is_some();
            match decide(self.record.tool(cli), cli.path(env), version, own, windows) {
                Verdict::Keep => {}
                Verdict::Remember(seen) => {
                    self.record.set(cli, seen);
                    changed = true;
                }
                Verdict::Tell(change, seen) => {
                    log::info!("cli seen: {} changed since the last look ({change:?})", cli.id());
                    let notice = notice_for(cli, &change, home, windows);
                    if !self.told.contains(&notice) {
                        self.told.push(notice.clone());
                        self.pending.push(notice);
                        queued = true;
                    }
                    self.record.set(cli, seen);
                    changed = true;
                }
            }
        }
        if changed {
            if let Err(error) = write(&self.record) {
                if !self.write_failed {
                    log::warn!("cli seen: couldn't keep {FILE} (kept for this session only): {error}");
                }
                self.write_failed = true;
            }
        }
        queued
    }

    /// Plyloft starts changing `tools` itself.
    pub(crate) fn mark_own(&mut self, tools: &[Cli], now: Instant) {
        for cli in tools {
            self.own[slot(*cli)] = Some(now);
        }
    }

    /// Plyloft's look after its own change is over, changed or not.
    pub(crate) fn end_own(&mut self, tools: &[Cli]) {
        for cli in tools {
            self.own[slot(*cli)] = None;
        }
    }

    /// The reviewer's re-check of `provider` at `version` makes its real
    /// request now: queued once per tool and version per session.
    pub(crate) fn probe_starting_with(&mut self, provider: Provider, version: &str) -> bool {
        let tool = match provider {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
            _ => return false,
        };
        let key = (provider, version.to_string());
        if version.is_empty() || self.told_checks.contains(&key) {
            return false;
        }
        self.told_checks.push(key);
        self.pending.push(Notice::Checking { tool, version: version.to_string() });
        true
    }

    /// The notices not taken yet, each given once.
    pub(crate) fn take(&mut self) -> Vec<Notice> {
        std::mem::take(&mut self.pending)
    }
}

struct State {
    dir: Option<PathBuf>,
    core: Core,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

fn slot(cli: Cli) -> usize {
    match cli {
        Cli::Claude => 0,
        Cli::Codex => 1,
    }
}

fn with_core<T>(f: impl FnOnce(&mut Core, Option<&Path>) -> T) -> Option<T> {
    let mut held = STATE.lock().unwrap_or_else(|p| p.into_inner());
    let state = held.as_mut()?;
    Some(f(&mut state.core, state.dir.as_deref()))
}

/// Read the record (`dir` is Plyloft's data folder). Unreadable is set aside
/// and read as no record: the next look is then a first look.
pub(crate) fn load(dir: &Path) -> SeenRecord {
    let parse = |bytes: &[u8]| serde_json::from_slice::<SeenRecord>(bytes).map_err(|e| e.to_string());
    match crate::atomic::load_or_set_aside_with(&dir.join(FILE), parse) {
        Ok(loaded) => loaded.found().unwrap_or_default(),
        Err(error) => {
            log::warn!("cli seen: couldn't read {FILE}: {error}");
            SeenRecord::default()
        }
    }
}

/// Wired once by `lib.rs::setup`, after the PATH override: every later
/// snapshot is observed, and this one — the launch's look — at once.
pub fn install(app: &tauri::AppHandle, dir: PathBuf) {
    let _ = APP.set(app.clone());
    let record = load(&dir);
    *STATE.lock().unwrap_or_else(|p| p.into_inner()) = Some(State { dir: Some(dir), core: Core::new(record) });
    crate::shell_env::set_observer(observe);
    if let Some(env) = crate::shell_env::try_get() {
        observe(&env);
    }
}

/// Held around the look that follows a change Plyloft makes itself — Setup's
/// or Repair's step on a tool, the automatic Codex update, the person's own
/// Program folders in Settings: what that look finds changed is not told
/// (each reports its own outcome). Dropped when the look is over, changed or
/// not; a mark left longer than [`OWN_CHANGE_WINDOW`] counts for nothing.
pub(crate) struct OwnChange(Vec<Cli>);

impl OwnChange {
    pub(crate) fn new(tools: &[Cli]) -> Self {
        with_core(|core, _| core.mark_own(tools, Instant::now()));
        OwnChange(tools.to_vec())
    }
}

impl Drop for OwnChange {
    fn drop(&mut self) {
        with_core(|core, _| core.end_own(&self.0));
    }
}

/// Compare a snapshot with what was last seen; remember it, and queue what
/// is worth telling. Called by `shell_env` after each snapshot it publishes.
pub fn observe(env: &ShellEnv) {
    let home = crate::platform::home_dir().map(|h| h.to_string_lossy().into_owned());
    let queued = with_core(|core, dir| {
        core.observe_with(env, Instant::now(), home.as_deref(), cfg!(windows), |record| match dir {
            Some(dir) => crate::atomic::write_atomic_json(&dir.join(FILE), record),
            None => Ok(()),
        })
    });
    if queued == Some(true) {
        ping();
    }
}

fn ping() {
    if let Some(app) = APP.get() {
        use tauri::Emitter;
        let _ = app.emit(PENDING_EVENT, ());
    }
}

/// The reviewer's background re-check of `provider` at `version` makes its
/// real request now (`review_capabilities::run_auto_probe`, right before
/// the probe runs): the only place it is said, so it is never said for a
/// re-check that was skipped (offline, superseded, a review outlasting it).
/// Once per tool and version per launch.
pub fn probe_starting(provider: Provider, version: &str) {
    if with_core(|core, _| core.probe_starting_with(provider, version)) == Some(true) {
        ping();
    }
}

/// The notices the window hasn't shown yet, each given once. The window asks
/// at start (a launch's look comes before it listens) and on
/// [`PENDING_EVENT`].
#[tauri::command]
pub fn cli_seen_take() -> Vec<Notice> {
    with_core(|core, _| core.take()).unwrap_or_default()
}

#[cfg(test)]
#[path = "cli_seen_tests.rs"]
mod tests;
