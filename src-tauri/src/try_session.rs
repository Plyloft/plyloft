//! Try it (TI-2, `docs/try-it/TRY_IT_SPEC.md` §4.1 and §4.5): a card's Try
//! session — the shell tile that runs the member's start command in the
//! card's copy — and how it is stopped.
//!
//! **Its kind.** A Try session is a shell tile (`ExecutionKind::ShellTile`)
//! with a [`TryTarget`] marker, not a new `ExecutionKind`: the kind is
//! written to `coordination/state.json`, and an older Plyloft reading a
//! state file that named a kind it does not know refuses the whole file
//! (the reason `ExecutionKind::Setup` is never recorded). The marker lives
//! in the PTY registry, in memory only: processes never survive a relaunch.
//! The spawn is still `PtyRegistry::spawn`'s (portable-pty, the cached PATH
//! and the port variables through `session_env`; Hard rules 1 and 2).
//!
//! **Stopping.** [`stop_card_try_sessions`] is called before every path
//! that removes a card's copy (ship, archive, delete, the set-aside build,
//! the ship backfill); [`stop_in_dir`] runs at the top of
//! `worktrees::prune_worktree_at` as the net for any other path. A Try
//! session never makes a card busy (`PtyRegistry::spawn` does not count it
//! in `shell_tiles_in`), so it never blocks those paths.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// Which card copy a Try session runs in. `lane` is the build of a card
/// built by both (`"a"`/`"b"`), `None` for the card's own copy (or the
/// project folder after Ship).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TryTarget {
    pub workspace_id: String,
    pub card_id: String,
    #[serde(default)]
    pub lane: Option<String>,
}

/// TI-5: the card id a workspace's own Try session carries — the project
/// folder's, after Ship (*Try it in <project>*) — so a workspace has at most
/// one, and no card's stop or removal ever names it. Its folder has no port
/// block, so it gets `BROWSER=none` and no `PORT`. The TypeScript twin is
/// `PROJECT_TRY_ID` in `src/lib/tryTile.ts`.
// Named here for the tests and readers; the app only ever receives it.
#[cfg_attr(not(test), allow(dead_code))]
pub const PROJECT_TRY_CARD_ID: &str = "plyloft:project";

/// What the registry remembers of a live Try session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrySession {
    pub target: TryTarget,
    /// The folder it was started in.
    pub cwd: Option<PathBuf>,
}

/// Emitted once per card whose Try sessions Plyloft stopped.
pub const TRY_STOPPED_EVENT: &str = "card://try-stopped";

/// Why Plyloft stopped a card's Try sessions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TryStopReason {
    /// Ship: the local land or the pull-request ship's post-release prune.
    Ship,
    Archive,
    Delete,
    /// Build with both: the build that was set aside.
    Discard,
    /// Any other removal of the copy (the net in `prune_worktree_at`).
    CopyRemoved,
    /// The member asked (the `stop_card_try_sessions` command).
    Requested,
}

/// The event's payload. The card reads `reason == "ship"` as
/// [`STOPPED_FOR_SHIP_WORDS`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TryStoppedEvent {
    pub workspace_id: String,
    pub card_id: String,
    pub lane: Option<String>,
    pub reason: TryStopReason,
    pub pty_ids: Vec<String>,
    /// What the card says about the stop, when it says anything: a ship's
    /// [`STOPPED_FOR_SHIP_WORDS`].
    pub words: Option<&'static str>,
}

impl TryStopReason {
    /// The card's words for a stop of this kind (TS: `tryStoppedWords`).
    pub fn words(self) -> Option<&'static str> {
        (self == TryStopReason::Ship).then_some(STOPPED_FOR_SHIP_WORDS)
    }
}

/// What the card says after a ship stopped its preview (TI-4 shows it). The
/// TypeScript twin is `TRY_STOPPED_FOR_SHIP` in `src/lib/trySession.ts`.
pub const STOPPED_FOR_SHIP_WORDS: &str = "Plyloft stopped your app's preview to ship it.";

/// How long a Try session's running command gets after SIGTERM before
/// SIGKILL (unix). A dev server ends in milliseconds; the removal that asked
/// waits for it, so the folder is not pulled from under a live process.
#[cfg_attr(not(unix), allow(dead_code))]
pub const STOP_GRACE: std::time::Duration = std::time::Duration::from_millis(1500);

/// The extra variables of a spawn: `ports` (the card copy's
/// `PLYLOFT_PORT_BASE`/`COUNT`, empty elsewhere) and, for a Try session
/// only, `PORT=<port base>` (in a card copy only) and `BROWSER=none`.
pub fn spawn_env(mut ports: Vec<(String, String)>, try_tile: bool) -> Vec<(String, String)> {
    if !try_tile {
        return ports;
    }
    let base = ports
        .iter()
        .find(|(key, _)| key == crate::worktree_ports::ENV_BASE)
        .map(|(_, value)| value.clone());
    if let Some(base) = base {
        ports.push(("PORT".into(), base));
    }
    ports.push(("BROWSER".into(), "none".into()));
    ports
}

/// Whether `target` is one of the sessions `stop_card_try_sessions(ws,
/// card, lane)` stops: `lane: None` is every Try session of the card (its
/// own copy and both builds), `Some(l)` only that build's.
pub fn selects(target: &TryTarget, workspace_id: &str, card_id: &str, lane: Option<&str>) -> bool {
    target.workspace_id == workspace_id
        && target.card_id == card_id
        && lane.is_none_or(|lane| target.lane.as_deref() == Some(lane))
}

/// The ids in `sessions` that `pred` picks, sorted (stable for tests).
pub fn select_ids(sessions: &HashMap<String, TrySession>, pred: impl Fn(&TrySession) -> bool) -> Vec<(String, TryTarget)> {
    let mut ids: Vec<(String, TryTarget)> = sessions
        .iter()
        .filter(|(_, s)| pred(s))
        .map(|(id, s)| (id.clone(), s.target.clone()))
        .collect();
    ids.sort_by(|a, b| a.0.cmp(&b.0));
    ids
}

/// Whether a session started in `cwd` runs in a card's copy (or a folder in
/// one). A Try session after Ship runs in the project folder: no removal of
/// a copy ever stops it.
pub fn in_card_copy(cwd: Option<&Path>) -> bool {
    cwd.is_some_and(|cwd| crate::worktree_ports::worktree_of(cwd).is_some())
}

/// What a removal of the card's copy stops: that card's (or build's) Try
/// sessions running in a card copy, never one in the project folder.
pub fn removal_selects(session: &TrySession, workspace_id: &str, card_id: &str, lane: Option<&str>) -> bool {
    selects(&session.target, workspace_id, card_id, lane) && in_card_copy(session.cwd.as_deref())
}

/// Whether a session started in `cwd` runs inside `dir` (a copy about to
/// be removed). A session in the project folder is never inside a card copy.
pub fn cwd_inside(cwd: Option<&Path>, dir: &Path) -> bool {
    cwd.is_some_and(|cwd| crate::pty::cwds_inside(std::iter::once(cwd), dir) == 1)
}

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Wired once by `lib.rs::setup`. Unset in unit tests, where every stop is
/// a no-op returning 0.
pub fn install(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
}

/// Before a removal of the card's copy: stop the card's (or that build's)
/// Try sessions running in a card copy — the running command and the
/// shell, children included — and tell the card why. A Try session in the
/// project folder (after Ship) is left alone. Returns how many were
/// stopped. Never fails: the removal goes ahead.
pub fn stop_card_try_sessions(workspace_id: &str, card_id: &str, lane: Option<&str>, reason: TryStopReason) -> usize {
    let Some(app) = APP.get() else { return 0 };
    stop_with(app, |s| removal_selects(s, workspace_id, card_id, lane), reason)
}

/// The member's own stop: every Try session of the card (or that build),
/// wherever it runs.
pub fn stop_all_card_try_sessions(workspace_id: &str, card_id: &str, lane: Option<&str>, reason: TryStopReason) -> usize {
    let Some(app) = APP.get() else { return 0 };
    stop_with(app, |s| selects(&s.target, workspace_id, card_id, lane), reason)
}

/// Windows (spec §7): which of `names` have a `<name>.cmd` shim in a folder
/// of `path` (the cached PATH) — the only ones a Try session types as
/// `<name>.cmd`. A name that is not a plain program name is never looked up.
pub fn cmd_shims_in(path: &str, names: &[String]) -> Vec<String> {
    let dirs = crate::platform::split_path_list(path);
    let mut found: Vec<String> = names
        .iter()
        .filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .filter(|n| dirs.iter().any(|d| d.join(format!("{n}.cmd")).is_file()))
        .cloned()
        .collect();
    found.sort();
    found.dedup();
    found
}

/// TI-4 (spec §4.4): a copy that needs its packages before Try it starts
/// it — a `package.json` at its top and nothing installed beside it: no
/// `node_modules`, and no Yarn Plug'n'Play map (`.pnp.cjs`, `.pnp.loader.mjs`),
/// which installs without one. Other stacks are not checked: a failed start
/// shows its own output.
pub fn copy_needs_packages(dir: &Path) -> bool {
    dir.join("package.json").is_file()
        && !["node_modules", ".pnp.cjs", ".pnp.loader.mjs"].iter().any(|n| dir.join(n).exists())
}

/// TI-4 (spec §4.4): a package manager's plain install (`npm install`…).
/// "Install them this time" runs it, or a lockfile's frozen form
/// ([`is_project_install`]), without saving it.
pub fn is_plain_install(command: &str) -> bool {
    let words: Vec<&str> = command.split_whitespace().collect();
    matches!(words.as_slice(), [pm, "install"] if ["npm", "pnpm", "yarn", "bun"].contains(pm))
}

/// TI-5: how Try it in <project> installs the project folder's own packages.
/// With a lockfile, its frozen form, so the install never rewrites it:
/// `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable`
/// (Yarn 2+, a `.yarnrc.yml` or a lockfile with `__metadata`) or
/// `--frozen-lockfile` (Yarn 1), `bun install --frozen-lockfile`. With
/// none, the plain install, which also writes `creates` — the ask says so.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInstall {
    pub command: String,
    /// The lockfile the install will create, when there is none yet.
    pub creates: Option<&'static str>,
}

/// The install for `dir`, whatever its packages' state.
pub fn project_install_for(dir: &Path) -> ProjectInstall {
    let has = |n: &str| dir.join(n).is_file();
    let frozen = |command: &str| ProjectInstall { command: command.to_string(), creates: None };
    if has("pnpm-lock.yaml") {
        return frozen("pnpm install --frozen-lockfile");
    }
    if has("yarn.lock") {
        let berry = has(".yarnrc.yml")
            || std::fs::read_to_string(dir.join("yarn.lock")).is_ok_and(|t| t.contains("__metadata:"));
        return frozen(if berry { "yarn install --immutable" } else { "yarn install --frozen-lockfile" });
    }
    if has("bun.lockb") || has("bun.lock") {
        return frozen("bun install --frozen-lockfile");
    }
    if has("package-lock.json") || has("npm-shrinkwrap.json") {
        return frozen("npm ci");
    }
    ProjectInstall { command: "npm install".into(), creates: Some("package-lock.json") }
}

/// Walk fix (Challenger): how a card's copy installs its packages. With a
/// lockfile, [`project_install_for`]'s frozen form. With none, an install
/// that writes no lockfile into the copy — it would reach the card's diff
/// and be shipped: `npm install --no-package-lock`, `pnpm install
/// --no-lockfile`, `yarn install --no-lockfile` (Yarn 1), `bun install
/// --no-save`. Yarn 2+ (a `.yarnrc.yml`, or `packageManager: yarn@2…`) has
/// no such option: its plain install, which creates `yarn.lock` — the ask
/// says so. The package manager with no lockfile is `package.json`'s
/// `packageManager`, else npm.
pub fn copy_install_for(dir: &Path) -> ProjectInstall {
    let planned = project_install_for(dir);
    if planned.creates.is_none() {
        return planned;
    }
    let declared = std::fs::read(dir.join("package.json"))
        .ok()
        .and_then(|b| {
            let body = b.strip_prefix("\u{feff}".as_bytes()).unwrap_or(&b).to_vec();
            serde_json::from_slice::<serde_json::Value>(&body).ok()
        })
        .and_then(|v| v.get("packageManager").and_then(|p| p.as_str()).map(str::to_string))
        .unwrap_or_default();
    let name = declared.split('@').next().unwrap_or("").trim();
    let version_major = declared.split('@').nth(1).and_then(|v| v.split('.').next()).and_then(|m| m.parse::<u32>().ok());
    let none = |command: &str| ProjectInstall { command: command.to_string(), creates: None };
    match name {
        "pnpm" => none("pnpm install --no-lockfile"),
        "bun" => none("bun install --no-save"),
        "yarn" if dir.join(".yarnrc.yml").is_file() || version_major.is_some_and(|m| m >= 2) => {
            ProjectInstall { command: "yarn install".into(), creates: Some("yarn.lock") }
        }
        "yarn" => none("yarn install --no-lockfile"),
        _ if dir.join(".yarnrc.yml").is_file() => ProjectInstall { command: "yarn install".into(), creates: Some("yarn.lock") },
        _ => none("npm install --no-package-lock"),
    }
}

/// The installs a card's copy may run once, unsaved (*Install them this
/// time*): [`is_project_install`]'s, or one of [`copy_install_for`]'s
/// no-lockfile forms.
pub fn is_copy_install(command: &str) -> bool {
    let words: Vec<&str> = command.split_whitespace().collect();
    is_project_install(command)
        || matches!(
            words.as_slice(),
            ["npm", "install", "--no-package-lock"]
                | ["pnpm", "install", "--no-lockfile"]
                | ["yarn", "install", "--no-lockfile"]
                | ["bun", "install", "--no-save"]
        )
}

/// The installs Try it may run once, unsaved — in the project folder (TI-5)
/// or in a card's copy (*Install them this time*): a plain install, or one
/// of [`project_install_for`]'s frozen forms.
pub fn is_project_install(command: &str) -> bool {
    let words: Vec<&str> = command.split_whitespace().collect();
    is_plain_install(command)
        || matches!(
            words.as_slice(),
            ["npm", "ci"]
                | ["pnpm", "install", "--frozen-lockfile"]
                | ["yarn", "install", "--immutable"]
                | ["yarn", "install", "--frozen-lockfile"]
                | ["bun", "install", "--frozen-lockfile"]
        )
}

/// What `try_install_packages_in_project` runs, checked before anything
/// does: an install [`is_project_install`] allows, in the workspace's own
/// folder (`ws_cwd`, `None` when the workspace is unknown or its folder gone).
pub fn checked_project_install(command: &str, ws_cwd: Option<PathBuf>) -> Result<(String, PathBuf), String> {
    let command = command.trim().to_string();
    if !is_project_install(&command) {
        return Err("Plyloft only runs a package manager's install here.".to_string());
    }
    let dir = ws_cwd.filter(|p| p.is_dir()).ok_or_else(|| "This project's folder wasn't found.".to_string())?;
    Ok((command, dir))
}

/// TI-5 (spec §3.2): whether the project folder's checkout holds `sha` — a
/// pull request's merge commit — so its change is there to try. Only a hex
/// commit id is asked about (never an option-looking word).
pub fn project_has_commit(dir: &Path, sha: &str) -> bool {
    let sha = sha.trim();
    (7..=64).contains(&sha.len())
        && sha.chars().all(|c| c.is_ascii_hexdigit())
        && crate::worktrees::is_ancestor(dir, sha, "HEAD")
}

/// TI-4 (spec §3.3): the file `name` inside the card copy `copy`, checked
/// before it is opened: a regular file, not a symlink, and — once both are
/// resolved — inside the copy (no `..` walking out of it).
pub fn checked_file_in(copy: &Path, name: &str) -> Result<PathBuf, String> {
    let missing = || format!("There is no {name} at the top of this copy.");
    let file = copy.join(name);
    let meta = std::fs::symlink_metadata(&file).map_err(|_| missing())?;
    if meta.file_type().is_symlink() {
        return Err(format!("Plyloft doesn't open {name}: it is a link to another file."));
    }
    if !meta.is_file() {
        return Err(missing());
    }
    let root = copy.canonicalize().map_err(|_| missing())?;
    let resolved = file.canonicalize().map_err(|_| missing())?;
    if !resolved.starts_with(&root) {
        return Err(format!("Plyloft doesn't open {name}: it is outside the card's copy."));
    }
    Ok(resolved)
}

/// A `file://` URL for an absolute path, every byte outside the unreserved
/// set and `/` percent-encoded (spaces included, which the opener refuses
/// raw). On Windows the `\\?\` prefix a canonical path carries is dropped
/// and backslashes become slashes: `file:///C:/Users/…`.
pub fn file_url(path: &Path) -> String {
    let text = path.to_string_lossy();
    let plain = text.strip_prefix(r"\\?\").unwrap_or(&text).replace('\\', "/");
    let mut out = String::from(if plain.starts_with('/') { "file://" } else { "file:///" });
    for b in plain.bytes() {
        let keep = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'/') || (b == b':' && cfg!(windows));
        if keep {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The net in `prune_worktree_at`: stop every Try session started in `dir`.
pub fn stop_in_dir(dir: &Path, reason: TryStopReason) -> usize {
    let Some(app) = APP.get() else { return 0 };
    stop_with(app, |s| cwd_inside(s.cwd.as_deref(), dir), reason)
}

fn stop_with(app: &tauri::AppHandle, pred: impl Fn(&TrySession) -> bool, reason: TryStopReason) -> usize {
    use tauri::{Emitter, Manager};
    let Some(registry) = app.try_state::<crate::pty::PtyRegistry>() else { return 0 };
    let picked = registry.try_sessions_matching(pred);
    let mut by_card: Vec<(TryTarget, Vec<String>)> = Vec::new();
    for (id, target) in picked {
        // Waits for the command to end: the copy goes next.
        if let Err(e) = registry.kill_with(&id, true) {
            log::debug!("try session {id}: {e}");
            continue;
        }
        match by_card.iter_mut().find(|(t, _)| *t == target) {
            Some((_, ids)) => ids.push(id),
            None => by_card.push((target, vec![id])),
        }
    }
    let stopped = by_card.iter().map(|(_, ids)| ids.len()).sum();
    for (target, pty_ids) in by_card {
        log::info!(
            "try: stopped {} session(s) of {}/{} ({reason:?})",
            pty_ids.len(),
            target.workspace_id,
            target.card_id
        );
        let _ = app.emit(
            TRY_STOPPED_EVENT,
            TryStoppedEvent {
                workspace_id: target.workspace_id,
                card_id: target.card_id,
                lane: target.lane,
                reason,
                pty_ids,
                words: reason.words(),
            },
        );
    }
    stopped
}

/// Unix: end the jobs (process groups) a Try session's shell is running —
/// SIGTERM to each group, then SIGKILL to what is left after `grace`. With
/// `wait` the call blocks until they are gone (at most `grace`): a removal
/// of the copy, and the quit. Without it (the tile's Stop or close, an IPC
/// on the main thread) the SIGKILL comes from a thread of its own. Each
/// group is the shell's foreground job (`npm run dev` and the `node` it
/// started share it: npm, a shell and node start no group of their own),
/// never the shell's or Plyloft's group.
#[cfg(unix)]
pub(crate) fn end_jobs(pgids: &[i32], grace: std::time::Duration, wait: bool) {
    let own = unsafe { libc::getpgrp() };
    let pgids: Vec<i32> = pgids.iter().copied().filter(|&g| g > 1 && g != own).collect();
    if pgids.is_empty() {
        return;
    }
    for &g in &pgids {
        // SAFETY: a signal to a group a Try session's terminal reported as
        // its foreground job; checked above not to be Plyloft's own.
        unsafe {
            libc::killpg(g, libc::SIGTERM);
        }
    }
    if wait {
        kill_after(&pgids, grace);
    } else {
        std::thread::spawn(move || kill_after(&pgids, grace));
    }
}

/// SIGKILL to each group still there once `grace` is up (or at once when
/// all have gone). A group exists while any member does, its leader gone
/// or not.
#[cfg(unix)]
fn kill_after(pgids: &[i32], grace: std::time::Duration) {
    use std::time::{Duration, Instant};
    let live = |g: i32| unsafe { libc::killpg(g, 0) } == 0;
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline && pgids.iter().any(|&g| live(g)) {
        std::thread::sleep(Duration::from_millis(25));
    }
    for &g in pgids {
        if live(g) {
            // SAFETY: as in `end_jobs`.
            unsafe {
                libc::killpg(g, libc::SIGKILL);
            }
        }
    }
}

#[cfg(test)]
#[path = "try_session_tests.rs"]
mod tests;
