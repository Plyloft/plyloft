//! 1.176.0 R3: where `claude` and `codex` are, checked on disk when
//! something starts them.
//!
//! The app keeps one snapshot of the two CLIs (`shell_env::ShellEnv`),
//! built at launch and refreshed only by Look again, Setup's runner and a
//! Codex update. An app left open for days outlives it: a CLI that updated
//! itself or an update that failed half-way leaves a launcher pointing at a
//! payload that is gone (R0 C3), and every tile then failed with a generic
//! "The program didn't start." Before a Claude or Codex start, the cached
//! path is checked on disk (through its link, a file, executable); when it
//! fails the tools are looked for again once — the ordinary re-probe
//! (`commands::re_probe_and_forget`), shared by spawns that ask at the same
//! time — and the window is sent the fresh snapshot (`shell-env://changed`).
//!
//! A login-shell probe can take seconds, so only a thread that opted in
//! ([`waiting`]: the tile's own check `cli_fresh_check`, a chat's send, both
//! on blocking workers) waits for it. Every other start (`pty_spawn` and
//! `codex_app_start` on the main thread, `require` from an async worker)
//! judges the snapshot as it is and leaves the look to a background thread. A tool still missing after the look fails with
//! [`UNAVAILABLE_PREFIX`], which the window reads by its shape
//! (`src/lib/cliUnavailable.ts`).

use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::shell_env::{self, ShellEnv};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Cli {
    Claude,
    Codex,
}

impl Cli {
    /// The tile kind or tool id (`"claude"`, `"codex"`); nothing else is one.
    pub(crate) fn from_id(id: &str) -> Option<Self> {
        match id {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }

    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    pub(crate) fn path(self, env: &ShellEnv) -> Option<&str> {
        match self {
            Self::Claude => env.claude_path.as_deref(),
            Self::Codex => env.codex_path.as_deref(),
        }
    }

    pub(crate) fn healthy(self, env: &ShellEnv) -> bool {
        match self {
            Self::Claude => env.claude_healthy(),
            Self::Codex => env.codex_healthy(),
        }
    }

    pub(crate) fn provider(self) -> crate::mcp_launch::Provider {
        match self {
            Self::Claude => crate::mcp_launch::Provider::Claude,
            Self::Codex => crate::mcp_launch::Provider::Codex,
        }
    }

    fn slot(self) -> usize {
        match self {
            Self::Claude => 0,
            Self::Codex => 1,
        }
    }
}

/// What makes a start look again, besides a cached path that fails on disk
/// (which always does).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Ask {
    /// A tool the snapshot never found. Only a person's press: an agent or
    /// a reviewer read on a computer without Codex would otherwise ask the
    /// login shell at every call.
    pub missing: bool,
    /// A tool found that didn't answer `--version` (not healthy): perhaps
    /// fixed in a terminal since.
    pub unhealthy: bool,
    /// 1.176.0 R5: a Codex start that may wait for the automatic update
    /// under way (`codex_auto_update::Gate::before_start`). Only the tile's
    /// own check, on a worker; the others go ahead at once.
    pub update_wait: bool,
}

/// A tile's own check before its spawn (`cli_fresh_check`).
pub(crate) const TILE_CHECK: Ask = Ask { missing: true, unhealthy: true, update_wait: true };
/// The spawn itself, right after that check (`pty_spawn`).
pub(crate) const TILE_SPAWN: Ask = Ask { missing: true, unhealthy: false, update_wait: false };
/// `doctor::require` for an agent, a chat or the App Server.
pub(crate) const REQUIRE: Ask = Ask { missing: false, unhealthy: false, update_wait: false };

/// A start asked again within this of the last look takes the snapshot as it
/// is: a file that exists but can't run would otherwise re-probe at every
/// call.
const LOOK_COOLDOWN: Duration = Duration::from_secs(30);

/// Whether `cli` is on disk as the snapshot says: through its link, a file,
/// executable (`shell_env::resolve_program`'s test).
pub(crate) fn usable(path: &str) -> bool {
    shell_env::is_executable_file(Path::new(path))
}

/// Pure: whether a start of `cli` from `env` should look again (the
/// login-shell re-probe): its cached path fails on disk, or — for a press —
/// the snapshot never found it.
pub(crate) fn wants_look(cli: Cli, env: &ShellEnv, usable: impl Fn(&str) -> bool, ask: Ask) -> bool {
    match cli.path(env) {
        Some(path) => !usable(path),
        None => ask.missing,
    }
}

/// Pure: whether a press on a tool that is there but doesn't start asks its
/// `--version` again — the narrow refresh (`shell_env::recheck_version`): no
/// login shell, nothing forgotten. A slow answer already counts as starting
/// (`*_version_unknown`), so this is a tool that really failed.
pub(crate) fn wants_recheck(cli: Cli, env: &ShellEnv, usable: impl Fn(&str) -> bool, ask: Ask) -> bool {
    ask.unhealthy && cli.path(env).is_some_and(&usable) && !cli.healthy(env)
}

/// Pure: one look for the spawns that ask together. `seen` is the snapshot
/// the caller judged, `current` the one cached now. A snapshot replaced
/// since (another spawn's look, Look again, Setup) is this look; a look
/// within [`LOOK_COOLDOWN`] isn't repeated. Returns the snapshot to judge
/// and whether a look happened (this one's, or the one that replaced it).
pub(crate) fn coalesced(
    seen: &Arc<ShellEnv>,
    current: Arc<ShellEnv>,
    last: &mut Option<Instant>,
    now: Instant,
    probe: impl FnOnce() -> Arc<ShellEnv>,
) -> (Arc<ShellEnv>, bool) {
    if !Arc::ptr_eq(seen, &current) {
        return (current, true);
    }
    if last.is_some_and(|at| now.saturating_duration_since(at) < LOOK_COOLDOWN) {
        return (current, false);
    }
    let fresh = probe();
    *last = Some(now);
    (fresh, true)
}

/// Whether the window's copy of the two tools would change.
fn tools_differ(a: &ShellEnv, b: &ShellEnv) -> bool {
    a.path != b.path
        || a.claude_path != b.claude_path
        || a.claude_version != b.claude_version
        || a.claude_version_unknown != b.claude_version_unknown
        || a.codex_path != b.codex_path
        || a.codex_version != b.codex_version
        || a.codex_version_unknown != b.codex_version_unknown
}

/// The time of each tool's last look, held across the look so concurrent
/// starts wait for one and share it.
static LOOKS: Mutex<[Option<Instant>; 2]> = Mutex::new([None, None]);

/// Wired once by `lib.rs::setup`, to send the fresh snapshot to the window
/// and reach the reviewer capability registry. Unset in unit tests.
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

pub fn install(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
}

fn tell_window(before: &ShellEnv, after: &ShellEnv) {
    if !tools_differ(before, after) {
        return;
    }
    if let Some(app) = APP.get() {
        use tauri::Emitter;
        let _ = app.emit(crate::commands::SHELL_ENV_CHANGED_EVENT, crate::commands::snapshot_env());
    }
}

fn look_again(cli: Cli, seen: &Arc<ShellEnv>) -> (Arc<ShellEnv>, bool) {
    let mut looks = LOOKS.lock().unwrap_or_else(|p| p.into_inner());
    let mut probed = false;
    let (env, looked) = coalesced(seen, shell_env::get(), &mut looks[cli.slot()], Instant::now(), || {
        log::info!("cli fresh: {} at {} isn't there; looking again", cli.id(), cli.path(seen).unwrap_or("<not found>"));
        probed = true;
        re_probe(seen)
    });
    if probed {
        log::info!("cli fresh: {} now at {}", cli.id(), cli.path(&env).unwrap_or("<not found>"));
        tell_window(seen, &env);
    }
    (env, looked)
}

/// 1.176.0 R5: the look after the automatic Codex update, success or not:
/// the narrow refresh (`shell_env::recheck_version`, no login shell) while
/// Codex's path is still on disk, the full re-probe when it isn't; the gh
/// and Claude sign-in answers are forgotten only if their path moved
/// (`commands::forget_moved`), and the window is sent what changed.
pub(crate) fn look_after_update(
    seen: &Arc<ShellEnv>,
    capabilities: Option<&crate::review_capabilities::ReviewerCapabilityRegistry>,
) -> Arc<ShellEnv> {
    let still_there = seen.codex_path.as_deref().is_some_and(usable);
    let fresh = if still_there { shell_env::recheck_version(false) } else { shell_env::re_probe() };
    crate::commands::forget_moved(seen, &fresh, capabilities);
    tell_window(seen, &fresh);
    fresh
}

/// The ordinary re-probe, forgetting only what a moved tool makes stale
/// (`commands::forget_moved`): a spawn's look must not throw away the gh
/// and Claude sign-in answers when nothing they describe changed.
fn re_probe(seen: &ShellEnv) -> Arc<ShellEnv> {
    let fresh = shell_env::re_probe();
    if let Some(app) = APP.get() {
        use tauri::Manager;
        let capabilities = app.try_state::<crate::review_capabilities::ReviewerCapabilityRegistry>();
        crate::commands::forget_moved(seen, &fresh, capabilities.as_ref().map(|state| state.inner()));
    }
    fresh
}

thread_local! {
    /// Set by [`waiting`]: this thread may wait for a login shell.
    static MAY_WAIT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// R3 review 7: run `f` on a thread that may wait for a look (a blocking
/// worker: the tile's check, a chat's send). Anywhere else — the main
/// thread, an async worker, a caller nobody vouched for — a start judges the
/// snapshot as it is and the look runs in the background for the next one.
pub(crate) fn waiting<T>(f: impl FnOnce() -> T) -> T {
    let before = MAY_WAIT.with(|flag| flag.replace(true));
    let out = f();
    MAY_WAIT.with(|flag| flag.set(before));
    out
}

fn may_wait() -> bool {
    MAY_WAIT.with(|flag| flag.get())
}

/// The snapshot a start judges, and whether a look stands behind it.
#[derive(Debug, Clone)]
pub(crate) struct Fresh {
    pub env: Arc<ShellEnv>,
    pub looked: bool,
}

/// The snapshot to start `cli` from: `seen` when it does; else, where this
/// thread may wait ([`waiting`]), the one a look (or, for a tool that is
/// there and doesn't start, a version recheck) gave; elsewhere `seen`, with
/// the look started in the background.
pub(crate) fn fresh_env(cli: Cli, seen: Arc<ShellEnv>, ask: Ask) -> Fresh {
    // R5: a tile's own check waits here for an automatic update under way
    // and then judges the snapshot it left. Every spawn meets the gate again
    // where it really starts (`PtyRegistry::begin_coordination`,
    // `codex_app::start_with`), without waiting.
    let seen = match cli {
        Cli::Codex if ask.update_wait => match crate::codex_auto_update::before_codex_start(true) {
            crate::codex_auto_update::StartWait::Clear => seen,
            _ => shell_env::get(),
        },
        _ => seen,
    };
    if wants_recheck(cli, &seen, usable, ask) && may_wait() {
        let env = shell_env::recheck_version(cli == Cli::Claude);
        tell_window(&seen, &env);
        return Fresh { env, looked: false };
    }
    if !wants_look(cli, &seen, usable, ask) {
        return Fresh { env: seen, looked: false };
    }
    if !may_wait() {
        let behind = seen.clone();
        let spawned = std::thread::Builder::new().name("cli-fresh".into()).spawn(move || {
            look_again(cli, &behind);
        });
        if let Err(error) = spawned {
            log::warn!("cli fresh: no background look for {}: {error}", cli.id());
        }
        return Fresh { env: seen, looked: false };
    }
    let (env, looked) = look_again(cli, &seen);
    Fresh { env, looked }
}

/// The shape the window recognises: this prefix, a JSON object
/// (`{"tool":"claude","was":"/path"}`) and, after a newline, the tool's
/// words. Matched by `src/lib/cliUnavailable.ts`.
pub(crate) const UNAVAILABLE_PREFIX: &str = "PLY_CLI_UNAVAILABLE_V1:";

/// 1.176.0 R7: the second kind — `cli` is there but certainly doesn't start
/// (`doctor::require`, `builder::vendor_missing_refusal`). This prefix, a
/// JSON object (`{"tool":"codex"}`), a newline, then the plain sentence a
/// text-only surface shows. Decoded (and stripped before anything is shown)
/// by `src/lib/cliNotStarting.ts`, which reads this constant in its test.
pub(crate) const NOT_STARTING_PREFIX: &str = "PLY_CLI_NOT_STARTING_V1:";

/// `sentence`, marked as [`NOT_STARTING_PREFIX`] for `cli`.
pub(crate) fn not_starting(cli: Cli, sentence: &str) -> String {
    let payload = serde_json::json!({ "tool": cli.id() });
    format!("{NOT_STARTING_PREFIX}{payload}\n{sentence}")
}

/// 1.176.0 seams: the third kind — Setup's Update refused on a copy whose
/// own updater can't write its folders (`setup_actions::update_refusal`).
/// The same shape; the window's block offers Repair (`src/lib/backendMarks.ts`).
pub(crate) const UPDATE_REFUSED_PREFIX: &str = "PLY_CLI_UPDATE_REFUSED_V1:";

/// `sentence`, marked as [`UPDATE_REFUSED_PREFIX`] for `cli`.
pub(crate) fn update_refused(cli: Cli, sentence: &str) -> String {
    let payload = serde_json::json!({ "tool": cli.id() });
    format!("{UPDATE_REFUSED_PREFIX}{payload}\n{sentence}")
}

/// `cli` is not on disk. `was` is where the snapshot had it, if anywhere;
/// `looked`: a look really happened (review 5: never claimed otherwise).
pub(crate) fn unavailable(cli: Cli, was: Option<&str>, looked: bool) -> String {
    let payload = serde_json::json!({ "tool": cli.id(), "was": was });
    let at = was.map(|w| format!("; it was at {w}")).unwrap_or_default();
    let again = if looked { ". Plyloft looked for it again" } else { "" };
    format!("{UNAVAILABLE_PREFIX}{payload}\n{}: not found in PATH{again}{at}.", cli.id())
}

/// Pure: the program a `cli` start runs, or the error that says it can't.
/// `was` is the path before any look. When the snapshot's path isn't on
/// disk (a look in its cooldown, or one left to the background), `nearby`
/// is asked — the cached PATH and the installers' folders, no login shell
/// (`shell_env::find_cli_nearby`) — so a reinstall made a moment ago starts.
pub(crate) fn program_in(
    cli: Cli,
    fresh: &Fresh,
    was: Option<&str>,
    usable: impl Fn(&str) -> bool,
    nearby: impl FnOnce(&str) -> Option<String>,
) -> Result<String, String> {
    let now = cli.path(&fresh.env);
    if let Some(path) = now.filter(|p| usable(p)) {
        return Ok(path.to_string());
    }
    if let Some(found) = nearby(&fresh.env.path).filter(|p| usable(p)) {
        log::info!("cli fresh: {} found at {found} without a look", cli.id());
        return Ok(found);
    }
    Err(unavailable(cli, was.or(now), fresh.looked))
}

fn nearby(cli: Cli) -> impl FnOnce(&str) -> Option<String> {
    move |path| shell_env::find_cli_nearby(cli.id(), path)
}

/// Pure: what a tile declares itself (`pty_spawn`'s `cli`). A Claude or
/// Codex tile is known by its kind, never by its command string matching the
/// snapshot's path: the window and the backend can hold different snapshots
/// (a look neither side saw), and a tile so mismatched started as a plain
/// shell, with no Knowledge server, no session id and no theme. A shell tile
/// declares nothing and stays a shell whatever it runs.
pub(crate) fn tile_cli(cli: Option<&str>) -> Result<Option<Cli>, String> {
    match cli {
        None => Ok(None),
        Some(id) => Cli::from_id(id)
            .map(Some)
            .ok_or_else(|| format!("unknown tile program `{id}`: a tile is claude, codex or a shell")),
    }
}

/// `pty_spawn`: the program and provider of a tile. A shell runs `cmd`; a
/// Claude or Codex tile runs the backend's own path for its kind, checked on
/// disk now — whatever path the window sent.
pub(crate) fn tile_program(
    cli: Option<&str>,
    cmd: String,
) -> Result<(String, Option<crate::mcp_launch::Provider>), String> {
    let Some(cli) = tile_cli(cli)? else { return Ok((cmd, None)) };
    let seen = shell_env::get();
    let was = cli.path(&seen).map(str::to_string);
    let fresh = fresh_env(cli, seen, TILE_SPAWN);
    Ok((program_in(cli, &fresh, was.as_deref(), usable, nearby(cli))?, Some(cli.provider())))
}

/// The tile's check before its spawn: on a blocking worker, so the look
/// (when one is needed) may wait for the login shell. Fails with
/// [`unavailable`] when the tool isn't there even after it.
#[tauri::command]
pub async fn cli_fresh_check(tool: String) -> Result<(), String> {
    let cli = Cli::from_id(&tool).ok_or_else(|| format!("unknown tool `{tool}`"))?;
    tauri::async_runtime::spawn_blocking(move || {
        waiting(|| {
            let seen = shell_env::get();
            let was = cli.path(&seen).map(str::to_string);
            let fresh = fresh_env(cli, seen, TILE_CHECK);
            program_in(cli, &fresh, was.as_deref(), usable, nearby(cli)).map(|_| ())
        })
    })
    .await
    .map_err(|e| format!("join cli check: {e}"))?
}

/// 1.176.0 R7: what a tile whose CLI ended at once learns when it asks the
/// backend: R3's three answers, after the narrow `--version` recheck.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StartVerdict {
    /// It answered with a version: it starts (what ended was the session).
    Starts,
    /// It certainly doesn't start: `--version` failed, or its file is gone.
    Fails,
    /// Slow, not found, or mid-update: nothing certain.
    Unknown,
}

/// Pure: the verdict for `cli` in `env`. Only a found tool whose
/// `--version` failed (never "didn't answer in time"), or whose cached file
/// is gone from disk, fails; a Codex under its automatic update is Unknown.
pub(crate) fn start_verdict(cli: Cli, env: &ShellEnv, usable: impl Fn(&str) -> bool, updating: bool) -> StartVerdict {
    if cli == Cli::Codex && updating {
        return StartVerdict::Unknown;
    }
    let Some(path) = cli.path(env) else { return StartVerdict::Unknown };
    if !usable(path) {
        return StartVerdict::Fails;
    }
    let (version, unknown) = match cli {
        Cli::Claude => (&env.claude_version, env.claude_version_unknown),
        Cli::Codex => (&env.codex_version, env.codex_version_unknown),
    };
    match (version, unknown) {
        (Some(_), _) => StartVerdict::Starts,
        (None, true) => StartVerdict::Unknown,
        (None, false) => StartVerdict::Fails,
    }
}

/// 1.176.0 R7: a tile's CLI ended at once — does the tool start? Asks its
/// `--version` again (`shell_env::recheck_version`: no login shell, nothing
/// forgotten), sends the window the fresh snapshot when it changed, and
/// answers [`start_verdict`]. On a blocking worker.
#[tauri::command]
pub async fn cli_start_verdict(tool: String) -> Result<StartVerdict, String> {
    let cli = Cli::from_id(&tool).ok_or_else(|| format!("unknown tool `{tool}`"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let seen = shell_env::get();
        if crate::codex_auto_update::updating() && cli == Cli::Codex {
            return StartVerdict::Unknown;
        }
        let env = shell_env::recheck_version(cli == Cli::Claude);
        tell_window(&seen, &env);
        start_verdict(cli, &env, usable, crate::codex_auto_update::updating())
    })
    .await
    .map_err(|e| format!("join cli verdict: {e}"))
}

#[cfg(test)]
#[path = "cli_fresh_tests.rs"]
mod tests;
