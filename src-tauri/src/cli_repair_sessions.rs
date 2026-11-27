//! 1.176.0 R4 (D2): which sessions use Claude Code or Codex now, as far as
//! the backend knows, so a Repair asks for them to close before it writes.
//!
//! Tiles are the window's: it passes the ones it has open (`TileInUse`) and
//! closes them itself. The backend adds what only it knows, behind
//! [`BackendSessions`]:
//!
//! - every active session the coordination registry recorded for the
//!   provider — agent runs (REPL and one-shot), swarm roles, reviewers and
//!   discussion legs, intake and card chats, provider tiles (a duplicate of a
//!   window tile is dropped by its PTY id, `cli_repair::merge_sessions`);
//! - Codex's `app-server` sessions (`codex-chat` tiles, Codex chat lanes),
//!   which have no PTY and no record;
//! - the hidden Codex update (`codex_auto_update`, 1.176.0 R5) while it runs.
//!
//! Not seen: `claude` or `codex` typed into a shell tile (a `ShellTile`
//! session of provider Shell), or running outside Plyloft. R3's declared
//! `cli` kind on PTY spawns would let the shell-tile case be counted here.

use crate::cli_health::CliTool;
use crate::cli_repair::{SessionInUse, SessionSource};
use crate::coordination::{ExecutionKind, Provider, SessionRecord};

/// What the backend knows, behind a trait so a plan is tested without an app.
pub trait BackendSessions {
    fn sessions(&self, tool: CliTool) -> Vec<SessionInUse>;
}

/// The hidden Codex update is running now: true exactly while R5's updater
/// holds its gate (`codex_auto_update::updating`), from the moment it may
/// start its process until it has ended and Codex was looked at again.
pub fn codex_update_in_flight() -> bool {
    crate::codex_auto_update::updating()
}

fn provider_of(tool: CliTool) -> Provider {
    match tool {
        CliTool::Claude => Provider::Claude,
        CliTool::Codex => Provider::Codex,
    }
}

fn source_of(kind: ExecutionKind) -> SessionSource {
    match kind {
        ExecutionKind::ProviderTile | ExecutionKind::ShellTile => SessionSource::Tile,
        ExecutionKind::AgentRepl | ExecutionKind::AgentOneshot => SessionSource::AgentRun,
        ExecutionKind::SwarmRole => SessionSource::Swarm,
        ExecutionKind::Intake => SessionSource::Chat,
        ExecutionKind::Reviewer
        | ExecutionKind::ReviewerProbe
        | ExecutionKind::DiscussionAnalysis
        | ExecutionKind::DiscussionCrossReview
        | ExecutionKind::DiscussionSynthesis => SessionSource::Review,
        ExecutionKind::Internal
        | ExecutionKind::VerifyCollector
        | ExecutionKind::MemorySuggester
        | ExecutionKind::Setup => SessionSource::Other,
    }
}

/// Pure: the active records of the tool's provider as sessions. Setup's own
/// runs are never recorded (and a Repair's step is one of them). M5: a
/// record says "active" until its exit is seen; `live` drops one whose PTY
/// is gone from the registry or whose process has exited, so a stale record
/// can't hold a Repair back until a restart. Tiles declared `cli` (R3) are
/// `ProviderTile` records of the provider, and count here.
pub fn from_records(records: &[SessionRecord], tool: CliTool, live: impl Fn(&SessionRecord) -> bool) -> Vec<SessionInUse> {
    let provider = provider_of(tool);
    records
        .iter()
        .filter(|r| r.status.is_active() && r.provider == provider && r.execution_kind != ExecutionKind::Setup)
        .filter(|r| live(r))
        .map(|r| SessionInUse {
            source: source_of(r.execution_kind),
            id: r.id.clone(),
            label: r.card_id.clone().or_else(|| r.role_id.clone()).or_else(|| r.objective.clone()),
            pty_id: r.pty_id.clone(),
        })
        .collect()
}

/// Pure: Codex's App Server sessions and the hidden update.
pub fn codex_extras(app_servers: &[String], update_in_flight: bool) -> Vec<SessionInUse> {
    let mut out: Vec<SessionInUse> = app_servers
        .iter()
        .map(|id| SessionInUse { source: SessionSource::CodexAppServer, id: id.clone(), label: None, pty_id: None })
        .collect();
    if update_in_flight {
        out.push(SessionInUse { source: SessionSource::CodexUpdate, id: "codex-update".into(), label: None, pty_id: None });
    }
    out
}

/// The app's registries.
pub struct AppSessions<'a, R: tauri::Runtime> {
    pub app: &'a tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> BackendSessions for AppSessions<'_, R> {
    fn sessions(&self, tool: CliTool) -> Vec<SessionInUse> {
        use tauri::Manager;
        let pty = self.app.try_state::<crate::pty::PtyRegistry>();
        let live = |r: &SessionRecord| {
            let pty_ok = match (&r.pty_id, &pty) {
                (Some(id), Some(registry)) => registry.contains(id),
                _ => true,
            };
            pty_ok && r.process_id.is_none_or(crate::terminal_sessions::pid_alive)
        };
        let mut out = match self.app.try_state::<crate::coordination::CoordinationRegistry>() {
            Some(registry) => from_records(&registry.snapshot().sessions, tool, live),
            None => Vec::new(),
        };
        if tool == CliTool::Codex {
            let servers = self
                .app
                .try_state::<crate::codex_app::CodexAppRegistry>()
                .map(|r| r.session_ids())
                .unwrap_or_default();
            out.extend(codex_extras(&servers, codex_update_in_flight()));
        }
        out
    }
}
