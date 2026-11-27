//! Terminals block, P1 (owner, 2026-10-21): the record of a workspace's
//! Claude and Codex tiles — which CLI conversation each one is, where it ran,
//! when it started and ended, and the short title it shows — for automatic
//! tile names, Resume… and History › Sessions. Research and design:
//! `~/ply-build/terminals-block-research.md`.
//!
//! - One file per workspace, `<config>/projects/<workspaceId>/terminal_sessions.json`,
//!   written whole and atomically (`atomic::write_atomic_json`, Hard rule 3)
//!   under one lock.
//! - Only what a list needs: never a message. The title is at most
//!   [`TITLE_MAX`] characters on one line.
//! - Rows older than [`WINDOW_DAYS`] go when the file is written (a tile
//!   still running keeps its row); at most [`MAX_ROWS`] stay.
//! - Lenient to read: a missing file is empty, missing fields take their
//!   defaults, unknown keys are kept. A file a newer Plyloft wrote (a higher
//!   `version`) is read but never written over; a file that doesn't parse is
//!   set aside (`terminal_sessions.json.unreadable-<ms>`) at the next write,
//!   and the record starts again.
//! - Shells, card sessions (Builders, chat, reviews) and Codex chat are not
//!   recorded: only a Terminals tile running the Claude or Codex CLI.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const FILE_NAME: &str = "terminal_sessions.json";
pub const VERSION: u32 = 1;
pub const WINDOW_DAYS: i64 = 28;
pub const MAX_ROWS: usize = 500;
pub const TITLE_MAX: usize = 60;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    Claude,
    Codex,
}

/// Where a title came from. A member's name always wins and is never
/// replaced; the CLI's own title wins over the first message's words.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum TitleSource {
    FirstMessage,
    Cli,
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    /// Plyloft's own id for the row.
    pub id: String,
    /// The tile's PTY while it runs (a live link only; a later launch's ids
    /// are new).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pty_id: Option<String>,
    pub kind: SessionKind,
    /// The folder it ran in: a conversation resumes there only.
    pub cwd: String,
    /// The CLI's conversation id: Claude's `--session-id` given at spawn (a
    /// `/clear` moves it, P2); Codex's, looked up after its first turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_session_id: Option<String>,
    /// ms since the epoch.
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_source: Option<TitleSource>,
    /// The row this one resumed (Resume…, P4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resumed_from: Option<String>,
    /// Challenger round 2: the member's name as Plyloft passed it to the
    /// CLI (`/rename`). The CLI then holds it as its own name, so it never
    /// counts as one the CLI gave — "Use the automatic name" stays.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passed_name: Option<String>,
    /// QoL 1.168 (block 4, D11): its tile was running when Plyloft quit, at
    /// this time (ms) — what "Reopen the N sessions" offers after a relaunch.
    /// Cleared once the offer is taken or put away, or the conversation is
    /// resumed. An older Plyloft keeps it as an unknown key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_at_quit: Option<i64>,
    /// Keys a newer Plyloft wrote: kept as they are.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SessionsFile {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub sessions: Vec<SessionRow>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A loaded file, and whether this build may write it.
#[derive(Debug)]
pub struct Loaded {
    pub file: SessionsFile,
    pub writable: bool,
    /// It doesn't parse: set aside at the next write.
    pub unreadable: bool,
}

pub fn path_for(config_dir: &Path, workspace_id: &str) -> PathBuf {
    config_dir.join("projects").join(workspace_id).join(FILE_NAME)
}

/// Read a workspace's file. Missing: empty and writable. From a newer
/// Plyloft: what could be read, not writable. Unparseable: empty, and
/// `unreadable` (set aside when the record is next written).
pub fn load(path: &Path) -> Loaded {
    let empty = || SessionsFile { version: VERSION, ..Default::default() };
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return Loaded { file: empty(), writable: true, unreadable: false },
    };
    match serde_json::from_slice::<SessionsFile>(&bytes) {
        Ok(mut file) => {
            let writable = file.version <= VERSION;
            if file.version == 0 {
                file.version = VERSION;
            }
            Loaded { file, writable, unreadable: false }
        }
        Err(error) => {
            log::warn!("terminal sessions: {} does not parse: {error}", path.display());
            Loaded { file: empty(), writable: false, unreadable: true }
        }
    }
}

/// 1.174.0 E9 round 1: when a row was last used, as far as the record
/// knows — its end, else when Plyloft quit with it open, else its start.
pub fn last_used_at(r: &SessionRow) -> i64 {
    r.started_at.max(r.ended_at.unwrap_or(i64::MIN)).max(r.open_at_quit.unwrap_or(i64::MIN))
}

/// Rows not used within the window go — never a tile still running
/// (`live`) — then the least recently used beyond [`MAX_ROWS`]. 1.174.0 E9
/// round 1: by last use, as History and Resume… sort (was by start).
pub fn prune(rows: &mut Vec<SessionRow>, now_ms: i64, live: &HashSet<String>) {
    let since = now_ms - WINDOW_DAYS * DAY_MS;
    rows.retain(|r| last_used_at(r) >= since || (r.ended_at.is_none() && live.contains(&r.id)));
    if rows.len() > MAX_ROWS {
        rows.sort_by_key(last_used_at);
        let extra = rows.len() - MAX_ROWS;
        rows.drain(0..extra);
    }
}

/// One line, at most [`TITLE_MAX`] characters (an ellipsis when cut).
pub fn clean_title(raw: &str) -> Option<String> {
    let one: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let one = one.trim();
    if one.is_empty() {
        return None;
    }
    if one.chars().count() <= TITLE_MAX {
        return Some(one.to_string());
    }
    let cut: String = one.chars().take(TITLE_MAX - 1).collect();
    Some(format!("{}…", cut.trim_end()))
}

/// Set a row's title, unless a stronger source already set it.
pub fn set_title(row: &mut SessionRow, raw: &str, source: TitleSource) -> bool {
    if let Some(current) = row.title_source {
        if current > source || (current == TitleSource::User && source != TitleSource::User) {
            return false;
        }
    }
    let Some(title) = clean_title(raw) else { return false };
    if row.title.as_deref() == Some(title.as_str()) && row.title_source == Some(source) {
        return false;
    }
    row.title = Some(title);
    row.title_source = Some(source);
    true
}

// ── Claude's session id at spawn ─────────────────────────────────────────

/// The flags that already name (or pick) a Claude conversation: a tile
/// that has one is not given another.
const CLAUDE_SESSION_FLAGS: &[&str] = &["--session-id", "--resume", "-r", "--continue", "-c", "--fork-session"];

/// A Claude tile's args, with `--session-id <new uuid>` when they name no
/// conversation, and the id the tile runs (the new one, or `--resume`'s).
pub fn claude_args_with_session(mut args: Vec<String>) -> (Vec<String>, Option<String>) {
    let named = args.iter().position(|a| CLAUDE_SESSION_FLAGS.contains(&a.as_str()) || a.starts_with("--session-id=") || a.starts_with("--resume="));
    match named {
        Some(i) => {
            let flag = args[i].as_str();
            let id = if let Some(v) = flag.strip_prefix("--session-id=").or_else(|| flag.strip_prefix("--resume=")) {
                Some(v.to_string())
            } else if matches!(flag, "--session-id" | "--resume" | "-r") {
                args.get(i + 1).filter(|v| !v.starts_with('-')).cloned()
            } else {
                None
            };
            (args, id)
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            args.push("--session-id".into());
            args.push(id.clone());
            (args, Some(id))
        }
    }
}

/// Codex's `resume <id>` (Resume…, P4): the conversation a Codex tile
/// continues. `None` for a new one, whose id is looked up after its first
/// turn.
pub fn codex_resumed_session(args: &[String]) -> Option<String> {
    let i = args.iter().position(|a| a == "resume")?;
    args.get(i + 1).filter(|v| !v.starts_with('-')).cloned()
}

// ── The store ────────────────────────────────────────────────────────────

/// One lock for every workspace's file, and the live tiles: PTY id → the
/// file and row it updates when it ends.
struct Store {
    live: HashMap<String, (PathBuf, String)>,
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(Store { live: HashMap::new() }))
}

impl Store {
    /// The rows a running tile is on.
    fn live_rows(&self) -> HashSet<String> {
        self.live.values().map(|(_, id)| id.clone()).collect()
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Apply `change` to the file at `path` and write it back, pruned, when it
/// changed something and this build may write it. Runs under the store's
/// lock (`store`), whose live rows `live` are.
fn update<T>(
    path: &Path,
    live: &HashSet<String>,
    change: impl FnOnce(&mut Vec<SessionRow>) -> (bool, T),
) -> Result<T, String> {
    let Loaded { mut file, writable, unreadable } = load(path);
    let (changed, out) = change(&mut file.sessions);
    if changed {
        if unreadable {
            // Kept for whoever wants to look; the record starts again.
            let aside = path.with_extension(format!("json.unreadable-{}", now_ms()));
            std::fs::rename(path, &aside)
                .map_err(|e| format!("terminal sessions: {} doesn't parse and couldn't be set aside: {e}", path.display()))?;
        } else if !writable {
            return Err("terminal sessions: this file is a newer Plyloft's; not written".into());
        }
        prune(&mut file.sessions, now_ms(), live);
        file.version = VERSION;
        crate::atomic::write_atomic_json(path, &file)?;
    }
    Ok(out)
}

/// A Claude or Codex tile started: its row, and its PTY linked to it until
/// it ends. Returns the row's id.
pub fn record_start(
    config_dir: &Path,
    workspace_id: &str,
    pty_id: &str,
    kind: SessionKind,
    cwd: &str,
    cli_session_id: Option<String>,
) -> Result<String, String> {
    let path = path_for(config_dir, workspace_id);
    let row = SessionRow {
        id: uuid::Uuid::new_v4().to_string(),
        pty_id: Some(pty_id.to_string()),
        kind,
        cwd: cwd.to_string(),
        cli_session_id,
        started_at: now_ms(),
        ended_at: None,
        title: None,
        title_source: None,
        resumed_from: None,
        passed_name: None,
        open_at_quit: None,
        extra: Map::new(),
    };
    let id = row.id.clone();
    let mut guard = store().lock();
    let mut live = guard.live_rows();
    live.insert(id.clone());
    update(&path, &live, |rows| {
        let mut row = row;
        // P4: a conversation the record already has (Resume…) — the row it
        // continues, and the name it had.
        if let Some(id) = row.cli_session_id.as_deref() {
            if let Some(before) = rows
                .iter()
                .filter(|r| r.kind == row.kind && r.cli_session_id.as_deref() == Some(id))
                .max_by_key(|r| r.started_at)
            {
                row.resumed_from = Some(before.id.clone());
                row.title = before.title.clone();
                row.title_source = before.title_source;
            }
            // QoL 1.168 (D11): resumed, so no longer one to reopen.
            for r in rows.iter_mut().filter(|r| r.kind == row.kind && r.cli_session_id.as_deref() == Some(id)) {
                r.open_at_quit = None;
            }
        }
        rows.push(row);
        (true, ())
    })?;
    guard.live.insert(pty_id.to_string(), (path, id.clone()));
    Ok(id)
}

/// A tile's PTY ended (its exit thread): the row's end time. Nothing when
/// the PTY was not a recorded tile.
pub fn record_end(pty_id: &str) {
    let mut guard = store().lock();
    let Some((path, row_id)) = guard.live.remove(pty_id) else { return };
    let at = now_ms();
    let live = guard.live_rows();
    if let Err(error) = update(&path, &live, |rows| match rows.iter_mut().find(|r| r.id == row_id) {
        Some(row) if row.ended_at.is_none() => {
            row.ended_at = Some(at);
            row.pty_id = None;
            (true, ())
        }
        _ => (false, ()),
    }) {
        log::warn!("terminal sessions: end not saved: {error}");
    }
}

// ── QoL 1.168 (block 4, D11): Reopen the sessions open at quit ──────────

/// `<config>/terminal_last_quit.json`: when Plyloft last quit through its
/// exit cleanup. Only rows marked at that quit are offered, so a workspace
/// not opened since an earlier quit doesn't offer what was open then.
pub const LAST_QUIT_FILE: &str = "terminal_last_quit.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct LastQuit {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    quit_at: Option<i64>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// When Plyloft last quit (`None`: never recorded, or unreadable).
pub fn last_quit(config_dir: &Path) -> Option<i64> {
    let bytes = std::fs::read(config_dir.join(LAST_QUIT_FILE)).ok()?;
    serde_json::from_slice::<LastQuit>(&bytes).ok()?.quit_at
}

/// How long the quit's last look at the running tiles' conversations may
/// take, all of them together ([`mark_quit`]).
pub const QUIT_LOOK_BUDGET: std::time::Duration = std::time::Duration::from_millis(300);

/// The PTYs of the tiles running now (for their process ids at quit).
pub fn live_ptys() -> Vec<String> {
    store().lock().live.keys().cloned().collect()
}

/// Plyloft is quitting (`run_exit_cleanup`, before any PTY is killed).
///
/// Challenger round 1: first one last look at each running tile's
/// conversation, as the title poll does (`refresh_title`): a Codex tile that
/// hasn't been matched to its session yet takes it (`codex_claim`), a Claude
/// tile follows a `/clear` it made since the last poll. That look runs on its
/// own thread and is waited for at most `budget` in all ([`QUIT_LOOK_BUDGET`]):
/// the quit never waits longer, and a tile not looked at in time is marked
/// as it is. `pids` are the tiles' process ids (Claude's `/clear` follow).
pub fn mark_quit_looking(
    config_dir: &Path,
    homes: CliHomes,
    pids: HashMap<String, u32>,
    budget: std::time::Duration,
) -> usize {
    let ptys = live_ptys();
    mark_quit_after(
        config_dir,
        move || {
            for pty in ptys {
                let _ = refresh_title(&pty, pids.get(&pty).copied(), &homes);
            }
        },
        budget,
    )
}

/// [`mark_quit`] after `look` has run, or after `budget`, whichever is
/// first (`look` may go on past it; nothing it writes after the mark lands:
/// the live links are gone).
pub fn mark_quit_after(config_dir: &Path, look: impl FnOnce() + Send + 'static, budget: std::time::Duration) -> usize {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let spawned = std::thread::Builder::new().name("quit-session-look".into()).spawn(move || {
        look();
        let _ = tx.send(());
    });
    if spawned.is_ok() {
        let _ = rx.recv_timeout(budget);
    }
    mark_quit(config_dir)
}

/// Every running tile's row ends now, and one with a conversation is marked
/// as open at this quit; then the quit's time is written. A tile's exit that
/// follows finds its row ended and writes nothing. Returns how many rows
/// were marked. Never blocks the quit on an error (logged).
pub fn mark_quit(config_dir: &Path) -> usize {
    let mut guard = store().lock();
    let at = now_ms();
    let mut by_path: HashMap<PathBuf, Vec<String>> = HashMap::new();
    for (path, row_id) in guard.live.values() {
        by_path.entry(path.clone()).or_default().push(row_id.clone());
    }
    let live = guard.live_rows();
    let mut marked = 0usize;
    for (path, ids) in by_path {
        let done = update(&path, &live, |rows| {
            let mut changed = false;
            let mut n = 0usize;
            for row in rows.iter_mut().filter(|r| ids.contains(&r.id) && r.ended_at.is_none()) {
                row.ended_at = Some(at);
                row.pty_id = None;
                if row.cli_session_id.is_some() {
                    row.open_at_quit = Some(at);
                    n += 1;
                }
                changed = true;
            }
            (changed, n)
        });
        match done {
            Ok(n) => marked += n,
            Err(error) => log::warn!("terminal sessions: quit not saved for {}: {error}", path.display()),
        }
    }
    // Nothing of this launch is updated from here on.
    guard.live.clear();
    let stamp = LastQuit { quit_at: Some(at), extra: Map::new() };
    if let Err(error) = crate::atomic::write_atomic_json(&config_dir.join(LAST_QUIT_FILE), &stamp) {
        log::warn!("terminal sessions: quit time not saved: {error}");
    }
    marked
}

/// The workspace's sessions that were open when Plyloft last quit and can be
/// offered again: a conversation to resume, not running now, in the order
/// they were opened. Empty when nothing was recorded at the last quit.
pub fn reopen_offer(config_dir: &Path, workspace_id: &str) -> Vec<ListedSession> {
    let Some(quit_at) = last_quit(config_dir) else { return Vec::new() };
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<ListedSession> = list(config_dir, workspace_id)
        .into_iter()
        .filter(|s| !s.live && s.row.open_at_quit == Some(quit_at) && s.row.cli_session_id.is_some())
        .collect();
    out.sort_by_key(|s| s.row.started_at);
    out.retain(|s| seen.insert(format!("{:?}:{}", s.row.kind, s.row.cli_session_id.as_deref().unwrap_or(""))));
    out
}

/// 1.174.0 walk G3 Windows: [`reopen_offer`], less the sessions with no
/// conversation to come back to — a Claude tile nobody wrote in leaves no
/// transcript, so `claude --resume` has nothing to open. Only a transcript
/// holding a message the member typed (or a name they gave) is offered.
pub fn reopen_offer_resumable(config_dir: &Path, workspace_id: &str, homes: &CliHomes) -> Vec<ListedSession> {
    reopen_offer(config_dir, workspace_id)
        .into_iter()
        .filter(|s| {
            s.row
                .cli_session_id
                .as_deref()
                .is_some_and(|id| has_conversation(homes, s.row.kind, Path::new(&s.row.cwd), id))
        })
        .collect()
}

/// Whether conversation `id` from `cwd` has anything to resume: its
/// transcript is there and holds a message the member typed or a name.
fn has_conversation(homes: &CliHomes, kind: SessionKind, cwd: &Path, id: &str) -> bool {
    let Some(path) = transcript_from(homes, kind, cwd, id) else { return false };
    let found = match kind {
        SessionKind::Claude => crate::session_titles::read_claude(&path),
        SessionKind::Codex => {
            let index = homes.codex.as_deref().map(|c| c.join("session_index.jsonl")).filter(|p| p.is_file());
            crate::session_titles::read_codex(&path, index.as_deref(), id)
        }
    };
    found.first_message.is_some() || found.renamed.is_some()
}

/// The offer was taken or put away: no row of the workspace is offered
/// again. Returns whether the file changed.
pub fn reopen_dismiss(config_dir: &Path, workspace_id: &str) -> Result<bool, String> {
    let path = path_for(config_dir, workspace_id);
    let guard = store().lock();
    update(&path, &guard.live_rows(), |rows| {
        let mut changed = false;
        for row in rows.iter_mut().filter(|r| r.open_at_quit.is_some()) {
            row.open_at_quit = None;
            changed = true;
        }
        (changed, changed)
    })
}

/// A row as a list shows it: `live` while its tile runs in this launch.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListedSession {
    #[serde(flatten)]
    pub row: SessionRow,
    pub live: bool,
}

/// A workspace's rows of the window, newest first.
pub fn list(config_dir: &Path, workspace_id: &str) -> Vec<ListedSession> {
    let path = path_for(config_dir, workspace_id);
    let guard = store().lock();
    let mut rows = load(&path).file.sessions;
    prune(&mut rows, now_ms(), &guard.live_rows());
    rows.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    rows.into_iter()
        .map(|row| {
            let live = row
                .pty_id
                .as_ref()
                .is_some_and(|pty| guard.live.get(pty).is_some_and(|(_, id)| id == &row.id));
            ListedSession { row, live }
        })
        .collect()
}

/// What a tile shows: its row, its title and where the title came from.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TileTitle {
    pub row_id: String,
    pub title: Option<String>,
    pub title_source: Option<TitleSource>,
    /// The CLI conversation the tile is in now (a restart resumes it).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cli_session_id: Option<String>,
    /// This look followed the tile to another conversation (`/clear`,
    /// `/resume` inside the CLI).
    #[serde(default)]
    pub followed: bool,
    /// That conversation has a name of its own — a `/rename` inside the CLI
    /// that Plyloft didn't pass — not just its first words or the CLI's own
    /// title (a fresh one after `/clear` never has).
    #[serde(default)]
    pub conversation_named: bool,
}

impl TileTitle {
    fn of(row: &SessionRow) -> Self {
        TileTitle {
            row_id: row.id.clone(),
            title: row.title.clone(),
            title_source: row.title_source,
            cli_session_id: row.cli_session_id.clone(),
            followed: false,
            conversation_named: false,
        }
    }
}

/// Where the CLIs keep their files, so tests can point elsewhere.
#[derive(Debug, Clone)]
pub struct CliHomes {
    /// Claude Code's config dir (`~/.claude`, or `CLAUDE_CONFIG_DIR`).
    pub claude: Option<PathBuf>,
    /// Codex's home (`~/.codex`).
    pub codex: Option<PathBuf>,
}

impl CliHomes {
    pub fn real() -> Self {
        CliHomes { claude: crate::claude_session::claude_config_dir(), codex: Some(crate::codex_home::real_codex_home()) }
    }
}

/// The Claude conversation a live Claude process is in now, from Claude
/// Code's own per-process file (`sessions/<pid>.json`, undocumented: only a
/// hint — absent or unreadable means "unchanged").
fn claude_current_session(homes: &CliHomes, pid: Option<u32>) -> Option<String> {
    let path = homes.claude.as_ref()?.join("sessions").join(format!("{}.json", pid?));
    let v: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    v.get("sessionId").and_then(Value::as_str).map(str::to_string)
}

/// What the CLI's files say about a conversation.
fn read_title(homes: &CliHomes, kind: SessionKind, id: &str) -> Option<crate::session_titles::Found> {
    let found = match kind {
        SessionKind::Claude => homes
            .claude
            .as_ref()
            .and_then(|dir| crate::claude_session::find_transcript(dir, id))
            .map(|t| crate::session_titles::read_claude(&t)),
        SessionKind::Codex => homes.codex.as_ref().and_then(|home| {
            let rollout = crate::codex_sessions::rollout_for(&home.join("sessions"), id)?;
            let index = home.join("session_index.jsonl");
            Some(crate::session_titles::read_codex(&rollout, index.is_file().then_some(index.as_path()), id))
        }),
    };
    found
}

/// Challenger round 1 (owner's rule): the Codex session a tile with none
/// yet may take — only when no other tile could own it. Codex picks its id
/// itself and writes its rollout at its first turn, and a session starts
/// no earlier than its tile, so a rollout started before every waiting
/// tile is never one of theirs (a `codex` run elsewhere in that folder),
/// and one started before the next waiting tile in that folder can only be
/// the earliest one's. Several such: ambiguous, the tile waits.
fn codex_claim(homes: &CliHomes, rows: &[SessionRow], row: &SessionRow, live: &HashSet<String>) -> Option<String> {
    let root = homes.codex.as_ref()?.join("sessions");
    let folder = crate::codex_sessions::normalized(Path::new(&row.cwd));
    let mut waiting: Vec<&SessionRow> = rows
        .iter()
        .filter(|r| {
            r.kind == SessionKind::Codex
                && r.cli_session_id.is_none()
                && r.ended_at.is_none()
                && live.contains(&r.id)
                && crate::codex_sessions::normalized(Path::new(&r.cwd)) == folder
        })
        .collect();
    waiting.sort_by_key(|r| r.started_at);
    if waiting.first().map(|r| r.id.as_str()) != Some(row.id.as_str()) {
        // A later tile: an earlier one may own anything this one could.
        return None;
    }
    let until = waiting.get(1).map(|r| r.started_at).unwrap_or(i64::MAX);
    let claimed: HashSet<&str> = rows.iter().filter_map(|r| r.cli_session_id.as_deref()).collect();
    // Review round 2 (R2-M1): Plyloft's own Codex card intake runs in the
    // project folder too; it is never a tile's.
    let mut mine = crate::codex_sessions::rollouts_for_folder(&root, Path::new(&row.cwd), Some(row.started_at))
        .into_iter()
        .filter(|(started, id, _)| *started >= row.started_at && *started < until && !claimed.contains(id.as_str()))
        .filter(|(_, _, path)| !crate::intake::rollout_is_intake(path));
    let first = mine.next()?;
    mine.next().is_none().then_some(first.1)
}

/// P2: look at a live tile's conversation again — follow a `/clear` to the
/// new conversation (the old row ends; owner, 2026-10-21), take up the one
/// a tile started with `--continue` is in, find a Codex tile's session once
/// it has one, and take the best title the CLI's files give (never over the
/// member's own name). `None` when the PTY is not a recorded tile.
///
/// The CLI's files are read without the store's lock (a transcript can be
/// large, and a tile starting waits on that lock); what was read is applied
/// under it, only if the tile is still on the same row.
pub fn refresh_title(pty_id: &str, pid: Option<u32>, homes: &CliHomes) -> Option<TileTitle> {
    let (path, row_id, live) = {
        let guard = store().lock();
        let (path, row_id) = guard.live.get(pty_id).cloned()?;
        (path, row_id, guard.live_rows())
    };
    // Read: which conversation, and its title.
    let rows = load(&path).file.sessions;
    let row = rows.iter().find(|r| r.id == row_id)?.clone();
    let mut follow: Option<String> = None;
    let mut adopt: Option<String> = None;
    if row.kind == SessionKind::Claude {
        if let Some(now_in) = claude_current_session(homes, pid) {
            match row.cli_session_id.as_deref() {
                Some(id) if id != now_in => follow = Some(now_in),
                // Started with `--continue`/`-r` and no id: the one it is in.
                None => adopt = Some(now_in),
                _ => {}
            }
        }
    } else if row.cli_session_id.is_none() {
        adopt = codex_claim(homes, &rows, &row, &live);
    }
    let session = follow.clone().or_else(|| adopt.clone()).or_else(|| row.cli_session_id.clone());
    // Challenger round 2: a name Plyloft passed to the CLI (on any row) is
    // the member's, not the conversation's own — it neither comes back after
    // "Use the automatic name" nor makes a fresh conversation "named".
    let passed: HashSet<&str> = rows.iter().filter_map(|r| r.passed_name.as_deref()).collect();
    let mut found = session.as_deref().and_then(|id| read_title(homes, row.kind, id));
    if let Some(f) = found.as_mut() {
        if f.renamed.as_deref().is_some_and(|n| passed.contains(n)) {
            f.renamed = None;
        }
    }
    let conversation_named = found.as_ref().is_some_and(|f| f.renamed.is_some());
    let found = found.and_then(|f| f.best());

    // Apply, under the lock.
    let mut guard = store().lock();
    if guard.live.get(pty_id).map(|(_, id)| id.as_str()) != Some(row_id.as_str()) {
        return None;
    }
    let now = now_ms();
    let live = guard.live_rows();
    let applied = update(&path, &live, |rows| {
        let mut changed = false;
        let Some(mut i) = rows.iter().position(|r| r.id == row_id) else { return (false, None) };
        let followed = follow.is_some();
        if let Some(now_in) = follow {
            rows[i].ended_at = Some(now);
            rows[i].pty_id = None;
            let mut next = rows[i].clone();
            next.id = uuid::Uuid::new_v4().to_string();
            next.pty_id = Some(pty_id.to_string());
            next.cli_session_id = Some(now_in);
            next.started_at = now;
            next.ended_at = None;
            // A name the member gave goes with the tile.
            if next.title_source != Some(TitleSource::User) {
                next.title = None;
                next.title_source = None;
            }
            next.resumed_from = None;
            next.open_at_quit = None;
            next.extra = Map::new();
            rows.push(next);
            i = rows.len() - 1;
            changed = true;
        } else if let Some(id) = adopt {
            // Not taken by another row meanwhile.
            if rows[i].cli_session_id.is_none() && !rows.iter().any(|r| r.cli_session_id.as_deref() == Some(id.as_str())) {
                rows[i].cli_session_id = Some(id);
                changed = true;
            }
        }
        if rows[i].cli_session_id == session {
            if let Some((title, source)) = &found {
                changed |= set_title(&mut rows[i], title, *source);
            }
        }
        let mut view = TileTitle::of(&rows[i]);
        view.followed = followed;
        view.conversation_named = conversation_named;
        (changed, Some(view))
    });
    match applied {
        Ok(view) => {
            if let Some(v) = &view {
                if v.row_id != row_id {
                    guard.live.insert(pty_id.to_string(), (path, v.row_id.clone()));
                }
            }
            view
        }
        Err(error) => {
            log::warn!("terminal sessions: title not saved: {error}");
            None
        }
    }
}

/// The member renamed the tile: their name, kept over every later title.
pub fn rename(pty_id: &str, title: &str) -> Result<Option<TileTitle>, String> {
    let guard = store().lock();
    let Some((path, row_id)) = guard.live.get(pty_id).cloned() else { return Ok(None) };
    update(&path, &guard.live_rows(), |rows| {
        let Some(row) = rows.iter_mut().find(|r| r.id == row_id) else { return (false, None) };
        let changed = set_title(row, title, TitleSource::User);
        (changed, Some(TileTitle::of(row)))
    })
}

/// Walk of blocks A+B: Plyloft has typed the member's name into the CLI
/// (`/rename <name>`, submitted). Recorded only then, so a name that never
/// reached the CLI is never mistaken for one the CLI holds.
pub fn name_passed(pty_id: &str, name: &str) -> Result<(), String> {
    let guard = store().lock();
    let Some((path, row_id)) = guard.live.get(pty_id).cloned() else { return Ok(()) };
    update(&path, &guard.live_rows(), |rows| {
        let Some(row) = rows.iter_mut().find(|r| r.id == row_id) else { return (false, ()) };
        let passed = clean_title(name);
        let changed = passed.is_some() && row.passed_name != passed;
        if changed {
            row.passed_name = passed;
        }
        (changed, ())
    })
}

/// Challenger round 1 (owner): "Use the automatic name" — the member's name
/// is dropped from the row, and the next look takes the conversation's own
/// title again. The CLI's own name (a `/rename` inside it) is left alone:
/// it comes back as the member's on that look.
pub fn use_automatic_name(pty_id: &str) -> Result<Option<TileTitle>, String> {
    let guard = store().lock();
    let Some((path, row_id)) = guard.live.get(pty_id).cloned() else { return Ok(None) };
    update(&path, &guard.live_rows(), |rows| {
        let Some(row) = rows.iter_mut().find(|r| r.id == row_id) else { return (false, None) };
        let changed = row.title_source == Some(TitleSource::User);
        if changed {
            row.title = None;
            row.title_source = None;
        }
        (changed, Some(TileTitle::of(row)))
    })
}

// ── P4: the project's conversations (Resume…) ───────────────────────────

/// At most this many conversations in Resume…, newest first.
pub const CONVERSATIONS_MAX: usize = 50;
/// Transcripts read at most for one list (each is read at its head and
/// tail only, `session_titles`).
pub(crate) const CONVERSATIONS_READ_MAX: usize = 200;

/// A conversation of the project folder, as Resume… lists it: its name and
/// when it was last written — never what was said.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub kind: SessionKind,
    pub cli_session_id: String,
    pub title: Option<String>,
    pub title_source: Option<TitleSource>,
    /// ms: the transcript's last write.
    pub updated_at: i64,
    /// A tile of this workspace runs it now: that tile's PTY.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_pty_id: Option<String>,
    pub live: bool,
    /// QoL 1.168 (block 4): its first message's short title (the same rule
    /// as every title: one line, at most [`TITLE_MAX`] characters), when the
    /// name shown is another — so two conversations of the same name can be
    /// told apart. Never more of what was said.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opening: Option<String>,
    /// 1.174.0 walk G3b: the copy's folder it ran in, for a conversation of
    /// one of the project's copies; absent for the project folder's own.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// Claude Code's directory name for a folder: every character that is not
/// an ASCII letter or digit becomes `-` (measured, Claude Code 2.1.306;
/// `C:\Users\me\app` → `C--Users-me-app` on Windows).
pub fn claude_project_key(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// The folders under Claude's `projects/` that may hold `cwd`'s transcripts:
/// its key as written and canonical (`/tmp` is `/private/tmp`); on Windows
/// also a name that differs only in case (a drive letter).
fn claude_project_dirs(claude: &Path, cwd: &Path) -> Vec<PathBuf> {
    let projects = claude.join("projects");
    let mut keys = vec![claude_project_key(&cwd.to_string_lossy())];
    if let Ok(real) = crate::platform::canonicalize(cwd) {
        let key = claude_project_key(&real.to_string_lossy());
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    let mut out: Vec<PathBuf> = Vec::new();
    for key in &keys {
        let dir = projects.join(key);
        if dir.is_dir() && !out.contains(&dir) {
            out.push(dir);
        }
    }
    if cfg!(windows) && out.is_empty() {
        if let Ok(entries) = std::fs::read_dir(&projects) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if keys.iter().any(|k| k.to_lowercase() == name) {
                    out.push(entry.path());
                }
            }
        }
    }
    out
}

fn mtime_ms(path: &Path) -> Option<i64> {
    let at = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(at.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64)
}

/// The title a found transcript gives a list row, unless it is a card's
/// intake, holds nothing the member typed, or ran somewhere else.
fn listable(found: &crate::session_titles::Found) -> Option<(String, TitleSource)> {
    if found.first_message.as_deref().is_some_and(crate::intake::opens_an_intake) {
        return None;
    }
    if found.first_message.is_none() && found.renamed.is_none() {
        // No message the member typed: an empty session (or only a command).
        return None;
    }
    let (title, source) = found.best()?;
    Some((clean_title(&title)?, source))
}

/// The project's copies' folders (A2: `.plyloft-worktrees/copy-<id>`):
/// those on disk now, and those the record has a session in — a copy thrown
/// away since, whose conversation still lists (and says so on Resume).
fn copy_folders(config_dir: &Path, workspace_id: &str, cwd: &Path) -> Vec<PathBuf> {
    let root = cwd.join(".plyloft-worktrees");
    let mut out: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if crate::copies::is_copy_id(&name) && entry.path().is_dir() {
                out.push(entry.path());
            }
        }
    }
    let want_root = crate::codex_sessions::normalized(&root);
    for s in list(config_dir, workspace_id) {
        let path = PathBuf::from(&s.row.cwd);
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else { continue };
        let Some(parent) = path.parent() else { continue };
        if !crate::copies::is_copy_id(&name) || crate::codex_sessions::normalized(parent) != want_root {
            continue;
        }
        let path = root.join(&name);
        if !out.contains(&path) {
            out.push(path);
        }
    }
    out.sort();
    out
}

/// P4 (owner, 2026-10-21): every Claude and Codex conversation of the
/// project folder `cwd` from the last [`WINDOW_DAYS`] — Plyloft's tiles' and
/// any other the member had there, like `claude --resume` — newest first, at
/// most [`CONVERSATIONS_MAX`]. A conversation the record has is named as its
/// tile was; any other by the CLI's own title or its first words. A card's
/// conversations are not listed: a Builder runs in its card's own folder,
/// so only an intake (in the project folder) is left out by its opening.
pub fn conversations(config_dir: &Path, workspace_id: &str, cwd: &Path, homes: &CliHomes) -> Vec<Conversation> {
    let since = now_ms() - WINDOW_DAYS * DAY_MS;
    // 1.174.0 walk G3b: a conversation started in one of the project's copies
    // (`.plyloft-worktrees/copy-…`, A2) is the project's too — as History ›
    // Sessions has it — and resumes in that copy's folder (`cwd`, `None` for
    // the project folder's own). A card's own folder stays out (its
    // Builder's). G3b review (1a): every folder's candidates are gathered
    // first and read newest first within one budget, so the project folder
    // never crowds the copies out.
    let mut folders: Vec<(PathBuf, Option<String>)> = vec![(cwd.to_path_buf(), None)];
    for folder in copy_folders(config_dir, workspace_id, cwd) {
        let tag = folder.to_string_lossy().to_string();
        folders.push((folder, Some(tag)));
    }
    let wants: Vec<PathBuf> = folders.iter().map(|(f, _)| crate::codex_sessions::normalized(f)).collect();
    let mut out: Vec<Conversation> = Vec::new();
    let mut read = 0usize;

    if let Some(claude) = homes.claude.as_deref() {
        let mut seen: HashSet<PathBuf> = HashSet::new();
        let mut files: Vec<(i64, String, PathBuf, usize)> = Vec::new();
        for (i, (folder, _)) in folders.iter().enumerate() {
            for dir in claude_project_dirs(claude, folder) {
                let Ok(entries) = std::fs::read_dir(&dir) else { continue };
                for entry in entries.flatten() {
                    let path = entry.path();
                    let Some(id) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".jsonl")) else {
                        continue;
                    };
                    let Some(at) = mtime_ms(&path) else { continue };
                    if at >= since && path.is_file() && seen.insert(path.clone()) {
                        files.push((at, id.to_string(), path, i));
                    }
                }
            }
        }
        files.sort_by(|a, b| b.0.cmp(&a.0));
        let mut kept = 0usize;
        for (at, id, path, i) in files {
            if kept >= CONVERSATIONS_MAX || read >= CONVERSATIONS_READ_MAX {
                break;
            }
            read += 1;
            let found = crate::session_titles::read_claude(&path);
            // Two folders can share a key (`a-b` and `a/b`): the transcript's
            // own `cwd` decides when it has one.
            let at_folder = match found.cwd.as_deref() {
                Some(c) => {
                    let c = crate::codex_sessions::normalized(Path::new(c));
                    match wants.iter().position(|w| *w == c) {
                        Some(j) => j,
                        None => continue,
                    }
                }
                None => i,
            };
            let Some((title, source)) = listable(&found) else { continue };
            kept += 1;
            out.push(Conversation {
                kind: SessionKind::Claude,
                cli_session_id: id,
                title: Some(title),
                title_source: Some(source),
                updated_at: at,
                live_pty_id: None,
                live: false,
                cwd: folders[at_folder].1.clone(),
                opening: found.first_message.as_deref().and_then(crate::session_titles::from_first_message),
            });
        }
    }

    if let Some(codex) = homes.codex.as_deref() {
        let index = codex.join("session_index.jsonl");
        let index = index.is_file().then_some(index);
        // G3b review (1b): one walk of the sessions folder for every folder.
        let all: Vec<PathBuf> = folders.iter().map(|(f, _)| f.clone()).collect();
        let mut files: Vec<(i64, String, PathBuf, usize)> =
            crate::codex_sessions::rollouts_for_folders(&codex.join("sessions"), &all, Some(since))
                .into_iter()
                .filter_map(|(_, id, path, i)| mtime_ms(&path).filter(|at| *at >= since).map(|at| (at, id, path, i)))
                .collect();
        files.sort_by(|a, b| b.0.cmp(&a.0));
        let mut kept = 0usize;
        for (at, id, path, i) in files {
            if kept >= CONVERSATIONS_MAX || read >= 2 * CONVERSATIONS_READ_MAX {
                break;
            }
            read += 1;
            let found = crate::session_titles::read_codex(&path, index.as_deref(), &id);
            let Some((title, source)) = listable(&found) else { continue };
            kept += 1;
            out.push(Conversation {
                kind: SessionKind::Codex,
                cli_session_id: id,
                title: Some(title),
                title_source: Some(source),
                updated_at: at,
                live_pty_id: None,
                live: false,
                cwd: folders[i].1.clone(),
                opening: found.first_message.as_deref().and_then(crate::session_titles::from_first_message),
            });
        }
    }

    // The record: the name the tile had, and the tile that runs it now.
    let record = list(config_dir, workspace_id);
    for c in &mut out {
        let mine = record
            .iter()
            .filter(|s| s.row.kind == c.kind && s.row.cli_session_id.as_deref() == Some(c.cli_session_id.as_str()));
        if let Some(named) = mine.clone().filter(|s| s.row.title.is_some()).max_by_key(|s| s.row.started_at) {
            c.title = named.row.title.clone();
            c.title_source = named.row.title_source;
        }
        if let Some(live) = mine.filter(|s| s.live).max_by_key(|s| s.row.started_at) {
            c.live = true;
            c.live_pty_id = live.row.pty_id.clone();
        }
        if c.opening.is_some() && c.opening == c.title {
            c.opening = None;
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out.truncate(CONVERSATIONS_MAX);
    out
}

/// Why a conversation can't be resumed from here, or where it already runs.
/// Claude's `--resume <id>` finds a conversation only under its folder's
/// key, so a transcript elsewhere doesn't count.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ResumeCheck {
    /// Nothing stops it.
    Ready,
    /// A tile of this Plyloft runs it (in any workspace): show that one.
    #[serde(rename_all = "camelCase")]
    InTile { workspace_id: String, pty_id: String },
    /// Another Claude on this computer is in it now (a Terminal of the
    /// member's own, another Plyloft profile).
    Elsewhere,
    /// The folder it ran in is gone (moved or deleted).
    FolderGone,
    /// Its transcript is no longer there.
    ConversationGone,
}

#[cfg(unix)]
pub(crate) fn pid_alive(pid: u32) -> bool {
    // 0 and anything past i32 would name a process group, not a process.
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    // SAFETY: signal 0 only asks whether the process exists.
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// A pid that can't be opened, or whose process has an exit code, is gone.
#[cfg(windows)]
pub(crate) fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    // SAFETY: a query-only handle, closed below.
    let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if h.is_null() {
        return false;
    }
    let mut code = 0u32;
    // SAFETY: `h` is an open process handle, closed once.
    unsafe {
        let running = GetExitCodeProcess(h, &mut code) != 0 && code == STILL_ACTIVE as u32;
        CloseHandle(h);
        running
    }
}

/// A running Claude is in conversation `id` in folder `cwd`: Claude Code's
/// per-process files (`sessions/<pid>.json`, undocumented — only a hint),
/// read, never written. A file left by a crash whose pid was reused could
/// still match: the sheet offers "Open it anyway" (Challenger round 2).
fn claude_open_elsewhere(claude: &Path, id: &str, cwd: &Path) -> bool {
    let want = crate::codex_sessions::normalized(cwd);
    let Ok(entries) = std::fs::read_dir(claude.join("sessions")) else { return false };
    entries.flatten().any(|entry| {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            return false;
        }
        let Ok(bytes) = std::fs::read(&path) else { return false };
        let Ok(v) = serde_json::from_slice::<Value>(&bytes) else { return false };
        let pid = v.get("pid").and_then(Value::as_u64).and_then(|p| u32::try_from(p).ok()).or_else(|| {
            path.file_stem().and_then(|s| s.to_str()).and_then(|s| s.parse().ok())
        });
        v.get("sessionId").and_then(Value::as_str) == Some(id)
            && v.get("cwd").and_then(Value::as_str).is_some_and(|c| crate::codex_sessions::normalized(Path::new(c)) == want)
            && pid.is_some_and(pid_alive)
    })
}

/// Its transcript where the CLI would look for it from `cwd`.
fn transcript_from(homes: &CliHomes, kind: SessionKind, cwd: &Path, id: &str) -> Option<PathBuf> {
    match kind {
        SessionKind::Claude => {
            let name = format!("{id}.jsonl");
            claude_project_dirs(homes.claude.as_deref()?, cwd).into_iter().map(|d| d.join(&name)).find(|p| p.is_file())
        }
        SessionKind::Codex => crate::codex_sessions::rollout_for(&homes.codex.as_deref()?.join("sessions"), id),
    }
}

/// Challenger round 1: just before Resume opens conversation `id` from
/// `cwd` — a tile of this Plyloft that runs it (any workspace), another
/// Claude in it, a folder or transcript gone. Codex keeps no per-process
/// file, so a Codex open outside Plyloft is not seen.
pub fn resume_check(homes: &CliHomes, kind: SessionKind, id: &str, cwd: &Path) -> ResumeCheck {
    let live: Vec<(PathBuf, String, String)> = {
        let guard = store().lock();
        guard.live.iter().map(|(pty, (path, row))| (path.clone(), row.clone(), pty.clone())).collect()
    };
    let mut files: HashMap<PathBuf, Vec<SessionRow>> = HashMap::new();
    for (path, row_id, pty) in &live {
        let rows = files.entry(path.clone()).or_insert_with(|| load(path).file.sessions);
        if rows.iter().any(|r| &r.id == row_id && r.kind == kind && r.cli_session_id.as_deref() == Some(id)) {
            let workspace_id = path
                .parent()
                .and_then(|d| d.file_name())
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            return ResumeCheck::InTile { workspace_id, pty_id: pty.clone() };
        }
    }
    // Challenger round 3: what can't be opened at all first, so "Open it
    // anyway" never spawns in a missing folder.
    if !cwd.is_dir() {
        return ResumeCheck::FolderGone;
    }
    if transcript_from(homes, kind, cwd, id).is_none() {
        return ResumeCheck::ConversationGone;
    }
    if kind == SessionKind::Claude && homes.claude.as_deref().is_some_and(|c| claude_open_elsewhere(c, id, cwd)) {
        return ResumeCheck::Elsewhere;
    }
    ResumeCheck::Ready
}

// ── P5: History › Sessions ───────────────────────────────────────────────

/// Why a History row can't be resumed (none: it can, when it has an id).
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Gone {
    Folder,
    Conversation,
}

/// A row as History › Sessions shows it: the record's row, its workspace,
/// and whether its conversation can still be resumed.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistorySession {
    pub workspace_id: String,
    #[serde(flatten)]
    pub session: ListedSession,
    pub resumable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gone: Option<Gone>,
    /// 1.174.0 E9 round 1: when its conversation's transcript was last
    /// written (unix ms) — the clock Resume… keeps — from the one file the
    /// lookup above already found. Response only, never stored.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_write_at: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryAll {
    pub sessions: Vec<HistorySession>,
    /// Workspaces whose record doesn't parse (set aside at its next write).
    pub unreadable: Vec<String>,
}

/// P5: every workspace's tile sessions of the window, newest first, each
/// with whether its conversation can still be resumed — looked for where
/// the CLI would look (Claude: under its folder's key; Codex: its tree,
/// walked once), never read — except a row with no title of its own, which
/// takes the CLI's (as Resume… shows it).
pub fn history_all(config_dir: &Path, workspace_ids: &[String], homes: &CliHomes) -> HistoryAll {
    let mut out = HistoryAll::default();
    let mut codex_paths: Option<Vec<PathBuf>> = None;
    for ws in workspace_ids {
        if load(&path_for(config_dir, ws)).unreadable {
            out.unreadable.push(ws.clone());
        }
        for session in list(config_dir, ws) {
            let row = &session.row;
            let mut last_write_at = None;
            let gone = match row.cli_session_id.as_deref() {
                None => None,
                Some(_) if !Path::new(&row.cwd).is_dir() => Some(Gone::Folder),
                Some(id) => {
                    let found: Option<PathBuf> = match row.kind {
                        SessionKind::Claude => homes.claude.as_deref().and_then(|c| {
                            let name = format!("{id}.jsonl");
                            claude_project_dirs(c, Path::new(&row.cwd))
                                .iter()
                                .map(|d| d.join(&name))
                                .find(|p| p.is_file())
                        }),
                        SessionKind::Codex => {
                            let paths = codex_paths.get_or_insert_with(|| {
                                homes
                                    .codex
                                    .as_deref()
                                    .map(|c| crate::codex_sessions::rollout_paths(&c.join("sessions")))
                                    .unwrap_or_default()
                            });
                            let suffix = format!("{id}.jsonl");
                            paths
                                .iter()
                                .find(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(&suffix)))
                                .cloned()
                        }
                    };
                    // One stat, of the file just found.
                    last_write_at = found.as_deref().and_then(mtime_ms);
                    found.is_none().then_some(Gone::Conversation)
                }
            };
            let resumable = row.cli_session_id.is_some() && gone.is_none();
            let mut session = session;
            // Walk of blocks A+B: a row with a conversation but no stored
            // title (one recorded before its title was found) is named as
            // Resume… names it — from the CLI's files, at most one short line.
            if session.row.title.is_none() && gone.is_none() {
                if let Some(id) = session.row.cli_session_id.clone() {
                    if let Some((title, source)) = read_title(homes, session.row.kind, &id).as_ref().and_then(listable) {
                        session.row.title = Some(title);
                        session.row.title_source = Some(source);
                    }
                }
            }
            out.sessions.push(HistorySession { workspace_id: ws.clone(), session, resumable, gone, last_write_at });
        }
    }
    out.sessions.sort_by(|a, b| b.session.row.started_at.cmp(&a.session.row.started_at));
    out
}

// ── Compare (1.177.0) ────────────────────────────────────────────────────

/// The conversation a live tile is in, looked at again just now (Compare
/// reads its last answer from it). Only names and paths: never a message.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LiveConversation {
    pub kind: SessionKind,
    /// The CLI's conversation id; `None` while a Codex tile's session isn't
    /// claimed (no turn yet, or ambiguous) or a `--continue` Claude's isn't
    /// known.
    pub id: Option<String>,
    pub title: Option<String>,
    /// Its transcript or rollout, where the CLI would look from the tile's
    /// folder; `None` while the CLI hasn't written one.
    pub file: Option<PathBuf>,
    /// Claude only: what Claude's per-process file says right after the look
    /// — `Some(true)` it names this conversation, `Some(false)` another one
    /// (it moved again meanwhile), `None` no file to read.
    pub pid_names_it: Option<bool>,
    /// Another conversation of the same CLI, held by no running tile, was
    /// written in the tile's folder since the tile started (Codex always;
    /// Claude when it has no per-process file). For a Codex tile with no
    /// session claimed: one it might be in began there since it started.
    pub newer_elsewhere: bool,
    /// Claude only: where Claude writes the plan files of plan mode
    /// (`<claude config>/plans/`).
    pub plans_dir: Option<PathBuf>,
}

/// Compare (1.177.0): a fresh [`refresh_title`] first (a `/clear` or
/// `/resume` followed, a Codex session claimed — never the cached id), then
/// the tile's row as it now stands. `None` when the PTY is not a recorded
/// Claude or Codex tile (a shell, a card session, Codex chat).
pub(crate) fn live_conversation(pty_id: &str, pid: Option<u32>, homes: &CliHomes) -> Option<LiveConversation> {
    let view = refresh_title(pty_id, pid, homes)?;
    let path = store().lock().live.get(pty_id).map(|(path, _)| path.clone())?;
    let rows = load(&path).file.sessions;
    let row = rows.iter().find(|r| r.id == view.row_id)?.clone();
    let id = row.cli_session_id.clone();
    let file = id.as_deref().and_then(|id| transcript_from(homes, row.kind, Path::new(&row.cwd), id));
    let pid_names_it = match row.kind {
        SessionKind::Claude => claude_current_session(homes, pid).map(|now_in| id.as_deref() == Some(now_in.as_str())),
        SessionKind::Codex => None,
    };
    // Review round 1 (M2, S3): another conversation of the same CLI written
    // in that folder since the tile started, that no running tile holds —
    // the tile may be in it (Codex `/new` or `/resume`, which the record
    // doesn't follow; a Claude `/clear` with no per-process file to say so),
    // or it is somebody else's. Either way not this tile's for sure.
    let newer_elsewhere = match (row.kind, id.as_deref(), file.as_deref()) {
        (SessionKind::Codex, Some(own), Some(own_file)) => {
            let ended = ended_codex_claims(&rows);
            homes.codex.as_deref().is_some_and(|home| codex_written_elsewhere(home, &row, own, own_file, &ended))
        }
        // Not claimed yet: any unclaimed session begun in the folder since
        // the tile started is one it might be in ("unstarted" when none).
        // Review round 2 (R2-S1): written since the tile started, whatever
        // its start — the tile's first action may be `/resume` of an older one.
        (SessionKind::Codex, None, _) => homes.codex.as_deref().is_some_and(|home| codex_unclaimed_since(home, &row)),
        (SessionKind::Claude, Some(own), _) if pid_names_it.is_none() => {
            homes.claude.as_deref().is_some_and(|claude| claude_written_elsewhere(claude, &row, own))
        }
        _ => false,
    };
    let plans_dir = match row.kind {
        SessionKind::Claude => homes.claude.as_ref().map(|c| c.join("plans")),
        SessionKind::Codex => None,
    };
    Some(LiveConversation { kind: row.kind, id, title: view.title, file, pid_names_it, newer_elsewhere, plans_dir })
}

/// The CLI conversation ids every running tile is in, in every workspace.
fn live_cli_ids() -> HashSet<String> {
    let live: Vec<(PathBuf, String)> = store().lock().live.values().cloned().collect();
    let mut files: HashMap<PathBuf, Vec<SessionRow>> = HashMap::new();
    let mut ids = HashSet::new();
    for (path, row_id) in live {
        let rows = files.entry(path.clone()).or_insert_with(|| load(&path).file.sessions);
        if let Some(id) = rows.iter().find(|r| r.id == row_id).and_then(|r| r.cli_session_id.clone()) {
            ids.insert(id);
        }
    }
    ids
}

/// R2-S1: an unclaimed interactive Codex rollout in the tile's folder,
/// written since the tile started — never Plyloft's own intake.
fn codex_unclaimed_since(codex: &Path, row: &SessionRow) -> bool {
    let cwd = Path::new(&row.cwd);
    let claimed = live_cli_ids();
    crate::codex_sessions::rollout_paths(&codex.join("sessions")).into_iter().any(|path| {
        mtime_ms(&path).is_some_and(|w| w >= row.started_at)
            && crate::codex_sessions::session_of(&path, cwd).is_some_and(|(id, _)| !claimed.contains(&id))
            && !crate::intake::rollout_is_intake(&path)
    })
}

/// 1.179.0: the Codex sessions claimed by this record's tiles that have
/// ended, each with when its tile ended (the latest, when several did).
fn ended_codex_claims(rows: &[SessionRow]) -> HashMap<String, i64> {
    let mut ended: HashMap<String, i64> = HashMap::new();
    for r in rows.iter().filter(|r| r.kind == SessionKind::Codex) {
        if let (Some(id), Some(at)) = (r.cli_session_id.as_deref(), r.ended_at) {
            let slot = ended.entry(id.to_string()).or_insert(at);
            *slot = (*slot).max(at);
        }
    }
    ended
}

/// M2: an unclaimed interactive Codex rollout in the tile's folder, written
/// since the tile started, that either started after the tile's own (and
/// after the tile: `/new`, a `codex` run outside) or was written later than
/// the tile's own (`/resume` of an older one).
///
/// 1.179.0: a rollout another tile of this record claimed and that tile has
/// since closed (`ended`) is not one this tile moved to just for having
/// started later, while it was last written no later than that tile ended
/// and no later than this tile's own. Otherwise a second Codex tile opened
/// and closed in the same folder left the first "can't tell" for good. A
/// write after the other tile closed, or after this tile's own last write
/// (this tile resumed it, or the claim was wrong and this tile is in it),
/// still counts: then it may be this tile's, so not this tile's for sure.
fn codex_written_elsewhere(
    codex: &Path,
    row: &SessionRow,
    own: &str,
    own_file: &Path,
    ended: &HashMap<String, i64>,
) -> bool {
    let cwd = Path::new(&row.cwd);
    let own_started = crate::codex_sessions::session_of(own_file, cwd).map_or(i64::MIN, |(_, s)| s);
    let own_written = mtime_ms(own_file).unwrap_or(i64::MIN);
    let claimed = live_cli_ids();
    crate::codex_sessions::rollout_paths(&codex.join("sessions")).into_iter().any(|path| {
        if path == own_file {
            return false;
        }
        // Stat first: nothing last written before the tile started matters.
        let Some(written) = mtime_ms(&path).filter(|w| *w >= row.started_at) else { return false };
        let Some((id, started)) = crate::codex_sessions::session_of(&path, cwd) else { return false };
        if id == own || claimed.contains(&id) {
            return false;
        }
        if ended.get(&id).is_some_and(|at| written <= *at) && written <= own_written {
            return false;
        }
        ((started > own_started && started >= row.started_at) || written > own_written)
            && !crate::intake::rollout_is_intake(&path)
    })
}

/// S3: with no per-process file to say which conversation a Claude tile is
/// in — another transcript in its project folder written since the tile
/// started, that no running tile holds.
fn claude_written_elsewhere(claude: &Path, row: &SessionRow, own: &str) -> bool {
    let claimed = live_cli_ids();
    claude_project_dirs(claude, Path::new(&row.cwd)).into_iter().any(|dir| {
        let Ok(entries) = std::fs::read_dir(&dir) else { return false };
        entries.flatten().any(|entry| {
            let path = entry.path();
            let Some(id) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".jsonl")) else {
                return false;
            };
            id != own && !claimed.contains(id) && mtime_ms(&path).is_some_and(|w| w >= row.started_at)
        })
    })
}

/// Tests: the live links are one process-wide map, so every test module
/// that touches them takes this lock.
#[cfg(test)]
pub(crate) fn serial_for_tests() -> parking_lot::MutexGuard<'static, ()> {
    static LOCK: parking_lot::Mutex<()> = parking_lot::const_mutex(());
    LOCK.lock()
}

/// Tests: link a PTY to a row as a running tile would be.
#[cfg(test)]
pub fn link_for_tests(path: &Path, pty_id: &str, row_id: &str) {
    store().lock().live.insert(pty_id.to_string(), (path.to_path_buf(), row_id.to_string()));
}

/// Tests: forget the live links.
#[cfg(test)]
pub fn reset_for_tests() {
    store().lock().live.clear();
}
