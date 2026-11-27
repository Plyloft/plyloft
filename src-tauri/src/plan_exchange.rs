//! Plan with two AIs (`docs/plans/PLAN_WITH_TWO_AIS.md`): a card's plan made
//! by two AI sessions arguing it out — a proposer writes it, a critic
//! critiques it, the proposer revises — for 2 rounds (3 at most), then the
//! member accepts it, asks for another round, or edits it.
//!
//! **Who runs.** With Claude and Codex both ready, the card's Builder vendor
//! proposes and the other critiques; with one ready, that vendor takes both
//! roles in two separate sessions (owner, 2026-10-16, Q5). Each side is a
//! card-chat lane of its own (`chat::Lane::Plan`, keyed by role): Claude's
//! hidden read-only TUI (Hard rule 1: never `-p`, never an API key) or
//! `codex app-server`, read-only, MCP off — the chat's machinery, sessions,
//! screen reading and cleanup.
//!
//! **The driver** is one thread for the one running exchange (P2). It
//! relays each side's final answer to the other at a safe point (§3: the
//! turn reliably over, the composer idle, the text stable), re-seeds a
//! session that came back fresh, and pauses on anything only the member
//! can get past — it answers no screen. Its state is `plan.json`
//! (`plan_store`); Accept writes the card in one backend write
//! (`KanbanStore::apply_two_ai_plan`).

use parking_lot::{Condvar, Mutex};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use crate::chat::{self, ChatContext, ChatKey, ChatStatus, LaneSignal, LaneView, PlanLaneSpec, PlanRole, PlanSend, Reseed};
use crate::chat_attachments::{self, clean_text, Attachment};
use crate::chat_store::{ChatMessage, ChatVendor, Conversation};
use crate::chat_transcript::TurnClose;
use crate::kanban::{CardAttachment, IntakeRecord, IntakeStatus, KanbanCard, KanbanColumnId, TwoAisRecord};
use crate::plan_store::{
    self, Exchange, ExchangeStatus, Outcome, OutcomeKind, Pause, PauseKind, PlanFile, SentKind, Turn, TurnOutcome,
    TurnRole, Verdict,
};

/// The rounds an exchange runs before it waits for the member, and the most.
pub(crate) const ROUNDS_DEFAULT: u32 = 2;
pub(crate) const ROUNDS_MAX: u32 = 3;
/// A relayed message is cut here.
pub(crate) const RELAY_CAP: usize = 16_000;
/// The member's ask, and a note.
pub(crate) const ASK_CAP: usize = 4_000;
/// A side's instructions (system prompt / `developerInstructions`).
pub(crate) const INSTRUCTIONS_CAP: usize = 8_000;

const RELAY_CUT: &str = "\n[Plyloft cut this at 16,000 characters]";
const RETRY_TEXT: &str = "Answer my last message again, from the start. Ignore your partial answer.";
const PLAN_FORMAT: &str = "Write the plan with these headings: Goal, What changes, Steps, Tests, Risks, Open questions. At most 1,200 words. Short code snippets only where they decide something.";
const CRITIQUE_FORMAT: &str = "List blocking problems first, numbered, each with why and what to change. Then suggestions. At most 600 words. End with one line, exactly `Verdict: ready` or `Verdict: changes needed`.";
const REVISE_FORMAT: &str = "Write the whole revised plan (not a list of changes), with the same headings and limit. For each point you don't take, add a line under **Not taken** with why.";

/// Events.
pub(crate) const STATE_EVENT: &str = chat::PLAN_STATE_EVENT;

/// P1's words, the build guard.
pub(crate) const BUILD_WAITS: &str = "Two AIs are still planning this card. Use their plan or discard it first.";
/// P3's words.
pub(crate) const CHAT_FIRST: &str = "Claude is still answering in this card's Chat. Wait for it, or press Stop there.";
/// An intake and an exchange refuse each other.
pub(crate) const INTAKE_RUNS: &str = "This card is being planned with an AI now. Finish or cancel that first.";
pub(crate) const EXCHANGE_RUNS: &str = "Two AIs are planning this card. Use their plan or discard it first.";
/// The driver's pause when the card's build started under it.
pub(crate) const BUILD_LEFT: &str =
    "This card's build started, so the two AIs stopped. Copy the plan from here if you need it, or discard it.";

/// The driver's timings (tests shorten them).
#[derive(Debug, Clone, Copy)]
pub(crate) struct PlanLimits {
    /// A turn longer than this is stopped, and the exchange pauses.
    pub turn_net: Duration,
    /// How often the driver reads its lanes.
    pub poll: Duration,
    /// A send refused because Claude isn't at its prompt is tried again
    /// this often.
    pub prompt_retry: Duration,
}

impl Default for PlanLimits {
    fn default() -> Self {
        PlanLimits { turn_net: Duration::from_secs(20 * 60), poll: Duration::from_millis(250), prompt_retry: Duration::from_secs(1) }
    }
}

/// What the driver needs from the app: the board, the card's context, a
/// lane's send, the board write, the readiness reading, the UI. The app's
/// is [`AppEnv`]; tests give their own.
pub(crate) trait PlanEnv: Send + Sync {
    fn card(&self, workspace_id: &str, card_id: &str) -> Result<KanbanCard, String>;
    fn context(&self, workspace_id: &str, card_id: &str) -> Result<ChatContext, String>;
    fn send(&self, key: &ChatKey, send: PlanSend) -> Result<ChatMessage, String>;
    #[allow(clippy::too_many_arguments)]
    fn apply(
        &self,
        workspace_id: &str,
        card_id: &str,
        text: &str,
        edited: bool,
        record: IntakeRecord,
        attachments: Vec<CardAttachment>,
    ) -> Result<KanbanCard, String>;
    fn vendor_ready(&self, vendor: ChatVendor) -> bool;
    fn emit(&self, event: &str, payload: serde_json::Value);
    fn board_changed(&self, _workspace_id: &str) {}
}

/// The app's [`PlanEnv`].
pub(crate) struct AppEnv<R: tauri::Runtime> {
    pub app: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> PlanEnv for AppEnv<R> {
    fn card(&self, workspace_id: &str, card_id: &str) -> Result<KanbanCard, String> {
        use tauri::Manager;
        self.app.try_state::<crate::kanban::KanbanStore>().ok_or("the board isn't ready")?.get_card(workspace_id, card_id)
    }

    fn context(&self, workspace_id: &str, card_id: &str) -> Result<ChatContext, String> {
        use tauri::Manager;
        let kanban = self.app.try_state::<crate::kanban::KanbanStore>().ok_or("the board isn't ready")?;
        let workspaces = self.app.try_state::<crate::workspace::WorkspaceStore>().ok_or("the workspaces aren't ready")?;
        chat::chat_context(&kanban, &workspaces, workspace_id, card_id)
    }

    fn send(&self, key: &ChatKey, send: PlanSend) -> Result<ChatMessage, String> {
        use tauri::Manager;
        let chats = self.app.try_state::<chat::ChatRegistry>().ok_or("the chats aren't ready")?;
        let pty = self.app.try_state::<crate::pty::PtyRegistry>().ok_or("the terminals aren't ready")?;
        chats.plan_send(&self.app, &pty, key, send)
    }

    fn apply(
        &self,
        workspace_id: &str,
        card_id: &str,
        text: &str,
        edited: bool,
        record: IntakeRecord,
        attachments: Vec<CardAttachment>,
    ) -> Result<KanbanCard, String> {
        use tauri::Manager;
        let kanban = self.app.try_state::<crate::kanban::KanbanStore>().ok_or("the board isn't ready")?;
        kanban.apply_two_ai_plan(workspace_id, card_id, text, edited, record, attachments)
    }

    fn vendor_ready(&self, vendor: ChatVendor) -> bool {
        match vendor {
            ChatVendor::Claude => crate::doctor::vendor_ready(&crate::shell_env::get(), "claude"),
            ChatVendor::Codex => crate::doctor::vendor_ready(&crate::shell_env::get(), "codex"),
            ChatVendor::Other => false,
        }
    }

    fn emit(&self, event: &str, payload: serde_json::Value) {
        use tauri::Emitter;
        let _ = self.app.emit(event, payload);
    }

    fn board_changed(&self, workspace_id: &str) {
        crate::kanban::emit_kanban_changed(&self.app, workspace_id);
    }
}

/// The line-up (§2): with both vendors ready, `preferred` (the card's
/// Builder vendor) proposes and the other critiques; with one ready, it
/// proposes and critiques (two sessions); with none, the words why.
pub(crate) fn lineup(preferred: ChatVendor, claude_ready: bool, codex_ready: bool) -> Result<(ChatVendor, ChatVendor), String> {
    match (claude_ready, codex_ready) {
        (true, true) => {
            let proposer = if preferred == ChatVendor::Codex { ChatVendor::Codex } else { ChatVendor::Claude };
            let critic = if proposer == ChatVendor::Claude { ChatVendor::Codex } else { ChatVendor::Claude };
            Ok((proposer, critic))
        }
        (true, false) => Ok((ChatVendor::Claude, ChatVendor::Claude)),
        (false, true) => Ok((ChatVendor::Codex, ChatVendor::Codex)),
        (false, false) => Err(
            "Plan with two AIs needs Claude Code or Codex installed and signed in on this computer, and neither is ready. Set one up in Setup, then come back."
                .into(),
        ),
    }
}

/// The verdict a critique ends with: its last non-empty line, `*`, `` ` ``
/// and `_` stripped, matched as `verdict: ready` or `verdict: changes
/// needed` (any case, an optional period). Anything else is no verdict.
pub(crate) fn verdict_of(critique: &str) -> Verdict {
    let Some(last) = critique.lines().rev().map(str::trim).find(|line| !line.is_empty()) else {
        return Verdict::None;
    };
    let line: String = last.chars().filter(|c| !matches!(c, '*' | '`' | '_')).collect();
    let line = line.trim().to_lowercase();
    let line = line.strip_suffix('.').unwrap_or(&line).trim_end();
    let Some(rest) = line.strip_prefix("verdict:") else { return Verdict::None };
    match rest.trim() {
        "ready" => Verdict::Ready,
        "changes needed" => Verdict::ChangesNeeded,
        _ => Verdict::None,
    }
}

/// A turn's final answer: the assistant text after its last tool call,
/// joined with blank lines (narration before a tool is left out), cut at
/// [`RELAY_CAP`]. `sent` is the id of the message that opened the turn.
pub(crate) fn final_answer(conversation: &Conversation, sent: &str) -> Option<(String, String)> {
    let start = conversation.messages.iter().position(|m| m.id == sent)?;
    let after = &conversation.messages[start + 1..];
    let from = after.iter().rposition(|m| matches!(m.role.as_str(), "tool" | "shell")).map_or(0, |i| i + 1);
    let answers: Vec<&ChatMessage> =
        after[from..].iter().filter(|m| m.role == "assistant" && !m.is_error && !m.text.trim().is_empty()).collect();
    let last_id = answers.last()?.id.clone();
    let text = answers.iter().map(|m| m.text.trim()).collect::<Vec<_>>().join("\n\n");
    Some((cap_relay(&text), last_id))
}

pub(crate) fn cap_relay(text: &str) -> String {
    cap_with_cut(text, RELAY_CAP)
}

/// `text` at most `cap` characters, its end replaced by the relay's cut
/// line when longer (Compare, 1.177.0, caps a hand-over the same way).
pub(crate) fn cap_with_cut(text: &str, cap: usize) -> String {
    if text.chars().count() <= cap {
        return text.to_string();
    }
    let keep = cap.saturating_sub(RELAY_CUT.chars().count());
    let mut cut: String = text.chars().take(keep).collect();
    cut.push_str(RELAY_CUT);
    cut
}

/// Whether [`cap_relay`] cut `capped`: exactly the cap long, ending in the
/// cut line.
pub(crate) fn relay_was_cut(capped: &str) -> bool {
    capped.ends_with(RELAY_CUT) && capped.chars().count() == RELAY_CAP
}

fn capped(text: &str, cap: usize) -> String {
    clean_text(text.trim()).chars().take(cap).collect()
}

fn now_ms() -> i64 {
    crate::kanban::now_ms()
}

/// What comes next after the last answered turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Next {
    Turn { round: u32, role: TurnRole },
    AwaitMember,
}

fn next_step(exchange: &Exchange) -> Next {
    let last = exchange.turns.iter().rev().find(|t| t.outcome == Some(TurnOutcome::Answered));
    match last {
        None => Next::Turn { round: 0, role: TurnRole::Propose },
        Some(turn) => match turn.role {
            TurnRole::Propose | TurnRole::Revise => {
                if turn.round >= exchange.rounds_target {
                    Next::AwaitMember
                } else {
                    Next::Turn { round: turn.round + 1, role: TurnRole::Critique }
                }
            }
            TurnRole::Critique => {
                if turn.verdict == Some(Verdict::Ready) {
                    if turn.round >= exchange.rounds_target {
                        Next::AwaitMember
                    } else {
                        Next::Turn { round: turn.round + 1, role: TurnRole::Critique }
                    }
                } else {
                    Next::Turn { round: turn.round, role: TurnRole::Revise }
                }
            }
            TurnRole::Other => Next::AwaitMember,
        },
    }
}

fn role_of(turn: TurnRole) -> PlanRole {
    match turn {
        TurnRole::Critique => PlanRole::Critic,
        _ => PlanRole::Proposer,
    }
}

/// How one side names the other in its messages: the vendor with two
/// vendors; "the other Claude session" with one (Q5).
fn other_name(exchange: &Exchange, me: PlanRole) -> String {
    let other = match me {
        PlanRole::Proposer => exchange.critic,
        PlanRole::Critic => exchange.proposer,
    };
    if exchange.proposer == exchange.critic {
        format!("the other {} session", other.label())
    } else {
        other.label().to_string()
    }
}

fn capitalised(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// A side's instructions: the chat's (the card, its notes and plan, what
/// it can do) and its role (§3), at most [`INSTRUCTIONS_CAP`].
pub(crate) fn lane_instructions(exchange: &Exchange, role: PlanRole, context: &ChatContext, attachments_dir: &Path) -> String {
    let vendor = match role {
        PlanRole::Proposer => exchange.proposer,
        PlanRole::Critic => exchange.critic,
    };
    let same = exchange.proposer == exchange.critic;
    let other = if same {
        match role {
            PlanRole::Proposer => format!("a second, separate {} session", vendor.label()),
            PlanRole::Critic => format!("a separate {} session", vendor.label()),
        }
    } else {
        match role {
            PlanRole::Proposer => exchange.critic.label().to_string(),
            PlanRole::Critic => exchange.proposer.label().to_string(),
        }
    };
    let short = other_name(exchange, role);
    let paragraph = match role {
        PlanRole::Proposer => format!(
            "\nIn this conversation you write the plan for this card together with another AI, {other}. You write the plan, {short} critiques it, and you revise it. The card's Builder builds from your latest version, so it must be complete on its own. The member decides at the end.\n"
        ),
        PlanRole::Critic => format!(
            "\nIn this conversation you critique a plan that another AI, {other}, wrote for this card. Find what is wrong or missing so it can be built. Don't rewrite it; {short} revises it.\n"
        ),
    };
    let base = chat::chat_instructions(vendor, context, attachments_dir);
    let room = INSTRUCTIONS_CAP.saturating_sub(paragraph.chars().count());
    let mut text = fit_keeping_paths(&base, room);
    text.push_str(&paragraph);
    text
}

/// `base` in at most `room` characters: when it's longer (long notes and a
/// plan already on the card), the card's words are cut, never the closing
/// lines naming the project's folder and the attachments' — without them a
/// Codex session (whose cwd is its plan folder) wouldn't know where the
/// project is.
fn fit_keeping_paths(base: &str, room: usize) -> String {
    const CUT: &str = "\n[cut here]\n";
    if base.chars().count() <= room {
        return base.to_string();
    }
    let at = base
        .rfind("\nThe project's files are in: ")
        .or_else(|| base.rfind("The member's attachments are in: "))
        .unwrap_or(base.len());
    let (head, tail) = base.split_at(at);
    let keep = room.saturating_sub(tail.chars().count() + CUT.chars().count());
    let mut text: String = head.chars().take(keep).collect();
    text.push_str(CUT);
    text.push_str(tail);
    text.chars().take(room).collect()
}

/// One side's files for a first message or a re-seed (§3 *Files*).
#[derive(Debug, Clone, Default)]
pub(crate) struct Files {
    pub chat: Vec<Attachment>,
    pub chat_dir: PathBuf,
    pub card: Vec<String>,
    /// Chat files sent at Start that are gone now.
    pub removed: usize,
}

impl Files {
    fn claude(&self, text: &str) -> String {
        let mut message = chat_attachments::claude_message(text, &self.chat, &self.chat_dir);
        message.push_str(&self.card_block());
        message
    }

    fn codex(&self, text: &str) -> serde_json::Value {
        chat_attachments::codex_input(&format!("{text}{}", self.card_block()), &self.chat, &self.chat_dir)
    }

    fn card_block(&self) -> String {
        if self.card.is_empty() {
            return String::new();
        }
        let lines: Vec<String> = self.card.iter().map(|path| format!("- {path}")).collect();
        format!("\n\nAttached files:\n{}", lines.join("\n"))
    }
}

/// The words of one turn's message (before the files), §3 *What each turn
/// sends*. `first` when this side has had no turn yet (it gets the ask and
/// the files).
fn turn_text(exchange: &Exchange, round: u32, role: TurnRole, first: bool) -> String {
    let mut text = String::new();
    let note = exchange.note.as_deref().filter(|_| round == exchange.rounds_target).filter(|n| !n.trim().is_empty());
    let ask = |text: &mut String| {
        if !exchange.ask.trim().is_empty() {
            text.push_str(&format!("The member asks: {}\n\n", exchange.ask.trim()));
        }
    };
    match role {
        TurnRole::Propose => {
            ask(&mut text);
            text.push_str(PLAN_FORMAT);
        }
        TurnRole::Critique => {
            if let Some(note) = note {
                text.push_str(&format!("The member adds: {}\n\n", note.trim()));
            }
            if first {
                ask(&mut text);
            }
            let plan = exchange.latest_plan().unwrap_or_default();
            text.push_str(&format!(
                "{}'s plan, round {round} of {}:\n----- plan -----\n{plan}\n----- end of plan -----\n\n{CRITIQUE_FORMAT}",
                capitalised(&other_name(exchange, PlanRole::Critic)),
                exchange.rounds_target
            ));
        }
        TurnRole::Revise | TurnRole::Other => {
            let critique = exchange.latest_critique().unwrap_or_default();
            text.push_str(&format!(
                "{}'s critique, round {round} of {}:\n----- critique -----\n{critique}\n----- end of critique -----\n\n",
                capitalised(&other_name(exchange, PlanRole::Proposer)),
                exchange.rounds_target
            ));
            if let Some(note) = note {
                text.push_str(&format!("The member adds: {}\n\n", note.trim()));
            }
            text.push_str(REVISE_FORMAT);
        }
    }
    text
}

/// The re-seed for a session that came back without its context: the ask
/// and the files, the latest plan and critique, where the exchange stands,
/// and the turn's own instruction.
fn reseed_text(exchange: &Exchange, round: u32, role: TurnRole) -> String {
    let mut text = String::from(
        "Plyloft restarted this conversation: your earlier session is gone, so here is where the plan stands.\n\n",
    );
    if !exchange.ask.trim().is_empty() {
        text.push_str(&format!("The member asks: {}\n\n", exchange.ask.trim()));
    }
    if let Some(plan) = exchange.latest_plan() {
        text.push_str(&format!("The latest plan:\n----- plan -----\n{plan}\n----- end of plan -----\n\n"));
    }
    if let Some(critique) = exchange.latest_critique() {
        text.push_str(&format!("The latest critique:\n----- critique -----\n{critique}\n----- end of critique -----\n\n"));
    }
    let what = match role {
        TurnRole::Propose => "write the plan",
        TurnRole::Critique => "critique the latest plan",
        _ => "revise the plan after the latest critique",
    };
    text.push_str(&format!("This is round {round} of {}. Your turn: {what}.\n\n", exchange.rounds_target));
    text.push_str(match role {
        TurnRole::Propose => PLAN_FORMAT,
        TurnRole::Critique => CRITIQUE_FORMAT,
        _ => REVISE_FORMAT,
    });
    text
}

/// What `plan_exchange_get` returns.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanExchangeSnapshot {
    pub workspace_id: String,
    pub card_id: String,
    /// The card's open or paused exchange (none once accepted or discarded).
    pub current: Option<Exchange>,
    /// Earlier exchanges, read-only, newest last.
    pub earlier: Vec<Exchange>,
    /// The file came from a newer Plyloft: shown, never changed.
    pub read_only: bool,
    /// The card another exchange runs on now (P2), by title.
    pub running_elsewhere: Option<String>,
    pub lanes: Vec<LaneState>,
    pub waiting_for_prompt: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LaneState {
    pub role: PlanRole,
    pub vendor: ChatVendor,
    pub status: ChatStatus,
    pub usage: crate::chat_store::TokenUsage,
    pub pty_id: Option<String>,
    pub attention: Option<String>,
}

/// What `plan_exchange_open_cards` returns: a card whose latest exchange
/// runs, waits for the member or is paused — for the Board, the card's Now
/// and the Inbox, which must say so before (and without) its Chat opening,
/// after a relaunch too.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanOpenCard {
    pub workspace_id: String,
    pub card_id: String,
    pub exchange_id: String,
    pub status: ExchangeStatus,
    pub proposer: ChatVendor,
    pub critic: ChatVendor,
    pub rounds_done: u32,
    pub updated_at: i64,
    pub pause: Option<Pause>,
}

struct CardPlans {
    file: PlanFile,
    writable: bool,
}

struct Running {
    workspace_id: String,
    card_id: String,
    exchange: String,
    generation: u64,
    stop: bool,
    waiting_for_prompt: bool,
}

#[derive(Default)]
struct State {
    files: HashMap<(String, String), CardPlans>,
    running: Option<Running>,
    forgotten_cards: HashSet<(String, String)>,
    forgotten_workspaces: HashSet<String>,
    /// Every card's `plan.json` was read once (`open_cards`): from then on
    /// `files` holds every exchange there is, since each change goes
    /// through it.
    scanned: bool,
}

struct Inner {
    config_dir: PathBuf,
    chats: chat::ChatRegistry,
    env: Arc<dyn PlanEnv>,
    limits: PlanLimits,
    state: Mutex<State>,
    wake: Mutex<u64>,
    signal: Condvar,
    generation: AtomicU64,
    closed: AtomicBool,
}

/// Every card's plan exchanges (managed state).
#[derive(Clone)]
pub struct PlanExchanges {
    inner: Arc<Inner>,
}

impl PlanExchanges {
    pub(crate) fn new(chats: chat::ChatRegistry, env: Arc<dyn PlanEnv>) -> Self {
        Self::with(chats, env, PlanLimits::default())
    }

    pub(crate) fn with(chats: chat::ChatRegistry, env: Arc<dyn PlanEnv>, limits: PlanLimits) -> Self {
        let inner = Arc::new(Inner {
            config_dir: chats.config_dir().to_path_buf(),
            chats: chats.clone(),
            env,
            limits,
            state: Mutex::new(State::default()),
            wake: Mutex::new(0),
            signal: Condvar::new(),
            generation: AtomicU64::new(0),
            closed: AtomicBool::new(false),
        });
        let weak = Arc::downgrade(&inner);
        chats.set_lane_listener(Arc::new(move |signal: LaneSignal| {
            if let Some(inner) = weak.upgrade() {
                match &signal {
                    LaneSignal::SessionStarted { key, fresh: true } => {
                        log::info!("plan {}/{}: a session came back fresh ({:?})", key.workspace_id, key.card_id, key.lane);
                    }
                    LaneSignal::TurnEnded { key, vendor, status, reason, turn_close } => log::debug!(
                        "plan {}/{} {:?}: {} turn ended {status:?} ({turn_close:?}){}",
                        key.workspace_id,
                        key.card_id,
                        key.lane,
                        vendor.label(),
                        reason.as_deref().map(|r| format!(": {r}")).unwrap_or_default()
                    ),
                    LaneSignal::State { key } | LaneSignal::SessionStarted { key, .. } => {
                        log::trace!("plan {}/{}: lane {:?} changed", key.workspace_id, key.card_id, key.lane)
                    }
                }
                inner.notify();
            }
        }));
        PlanExchanges { inner }
    }

    // ── Guards other paths ask ────────────────────────────────────

    /// The card's latest exchange is running or waits for the member: its
    /// build, a drag to In progress and an intake wait (P1). A paused one
    /// does not hold anything.
    pub(crate) fn exchange_open(&self, workspace_id: &str, card_id: &str) -> bool {
        let mut state = self.inner.state.lock();
        self.inner
            .plans(&mut state, workspace_id, card_id)
            .and_then(|plans| plans.file.exchanges.last().map(|e| e.status.open()))
            .unwrap_or(false)
    }

    /// Every card whose latest exchange runs, waits for the member or is
    /// paused. The first call reads each card's `plan.json` under
    /// `projects/*/cards/*/` (a relaunch: nothing is loaded yet); later
    /// calls answer from memory.
    pub(crate) fn open_cards(&self) -> Vec<PlanOpenCard> {
        let mut state = self.inner.state.lock();
        if !state.scanned {
            state.scanned = true;
            for (ws, card) in plan_files(&self.inner.config_dir) {
                let _ = self.inner.plans(&mut state, &ws, &card);
            }
        }
        let mut open: Vec<PlanOpenCard> = state
            .files
            .iter()
            .filter(|((ws, card), _)| {
                !state.forgotten_workspaces.contains(ws) && !state.forgotten_cards.contains(&(ws.clone(), card.clone()))
            })
            .filter_map(|((ws, card), plans)| {
                let e = plans.file.exchanges.last().filter(|e| !e.status.finished())?;
                Some(PlanOpenCard {
                    workspace_id: ws.clone(),
                    card_id: card.clone(),
                    exchange_id: e.id.clone(),
                    status: e.status,
                    proposer: e.proposer,
                    critic: e.critic,
                    rounds_done: e.rounds_done,
                    updated_at: e.updated_at,
                    pause: e.pause.clone(),
                })
            })
            .collect();
        open.sort_by(|a, b| (&a.workspace_id, &a.card_id).cmp(&(&b.workspace_id, &b.card_id)));
        open
    }

    /// P1: why the card's build may not start now, or `None`.
    pub(crate) fn build_refusal(&self, workspace_id: &str, card_id: &str) -> Option<String> {
        self.exchange_open(workspace_id, card_id).then(|| BUILD_WAITS.to_string())
    }

    /// An intake's refusal while an exchange runs or waits.
    pub(crate) fn intake_refusal(&self, workspace_id: &str, card_id: &str) -> Option<String> {
        self.exchange_open(workspace_id, card_id).then(|| EXCHANGE_RUNS.to_string())
    }

    /// Quit (before `ChatRegistry::kill_all`): a running exchange is saved
    /// `paused{quit}`, and the driver does nothing after.
    pub(crate) fn interrupt_active(&self) {
        self.inner.closed.store(true, Ordering::SeqCst);
        let mut state = self.inner.state.lock();
        if let Some(running) = state.running.take() {
            let (ws, card, id) = (running.workspace_id, running.card_id, running.exchange);
            Inner::edit_locked(&self.inner.config_dir, &mut state, &ws, &card, &id, |exchange| {
                exchange.status = ExchangeStatus::Paused;
                exchange.pause = Some(Pause { kind: PauseKind::Quit, reason: plan_store::quit_reason(exchange) });
            });
        }
        drop(state);
        self.inner.notify();
    }

    /// A deleted card: nothing is stored for it again (its `plan.json` goes
    /// with the card's folder in `ChatRegistry::forget_card`, called after).
    pub(crate) fn forget_card(&self, workspace_id: &str, card_id: &str) {
        let mut state = self.inner.state.lock();
        state.forgotten_cards.insert((workspace_id.to_string(), card_id.to_string()));
        state.files.remove(&(workspace_id.to_string(), card_id.to_string()));
        if state.running.as_ref().is_some_and(|r| r.workspace_id == workspace_id && r.card_id == card_id) {
            state.running = None;
        }
        drop(state);
        self.inner.notify();
    }

    pub(crate) fn forget_workspace(&self, workspace_id: &str) {
        let mut state = self.inner.state.lock();
        state.forgotten_workspaces.insert(workspace_id.to_string());
        state.files.retain(|(ws, _), _| ws != workspace_id);
        if state.running.as_ref().is_some_and(|r| r.workspace_id == workspace_id) {
            state.running = None;
        }
        drop(state);
        self.inner.notify();
    }

    // ── The member's actions ──────────────────────────────────────

    /// Start (§6 IPC). The caller has passed the drain guard and the
    /// card's blockers (`start_refusal`) and holds `CARD_START_LOCK`, so a
    /// Start build can't slip in between this check and the exchange's
    /// start. Refused: a card past To do, archived, under intake, or with
    /// an exchange of its own still open or paused; another card's
    /// exchange running (P2); the card's Chat answering (P3); no vendor
    /// ready; no room for two sessions. Reads no plan gate (Q1: Free).
    pub(crate) fn start(
        &self,
        workspace_id: &str,
        card_id: &str,
        preferred: ChatVendor,
        ask: &str,
        attachment_ids: &[String],
    ) -> Result<PlanExchangeSnapshot, String> {
        if self.inner.closed.load(Ordering::SeqCst) {
            return Err(crate::pty::PTY_REGISTRY_CLOSED.into());
        }
        let card = self.inner.env.card(workspace_id, card_id)?;
        offer_refusal(&card).map_or(Ok(()), Err)?;
        if let Some(elsewhere) = self.running_elsewhere(workspace_id, card_id) {
            return Err(elsewhere);
        }
        {
            let mut state = self.inner.state.lock();
            let plans = self.inner.plans(&mut state, workspace_id, card_id).ok_or(chat_deleted())?;
            if !plans.writable {
                return Err(NEWER.into());
            }
            if let Some(last) = plans.file.exchanges.last() {
                if !last.status.finished() {
                    return Err(match last.status {
                        ExchangeStatus::Paused => "This card has a paused plan with two AIs. Retry it or discard it first.",
                        _ => EXCHANGE_RUNS,
                    }
                    .into());
                }
            }
        }
        if self.inner.chats.chat_answering(workspace_id, card_id) {
            return Err(CHAT_FIRST.into());
        }
        let (proposer, critic) = lineup(
            preferred,
            self.inner.env.vendor_ready(ChatVendor::Claude),
            self.inner.env.vendor_ready(ChatVendor::Codex),
        )?;
        let (available, _) = self.inner.chats.chat_attachments(workspace_id, card_id)?;
        for id in attachment_ids {
            if !available.iter().any(|a| &a.id == id) {
                return Err("One of the files is no longer on this card's chat.".into());
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        // P2: the two slots, before either lane is live.
        self.inner.chats.reserve(workspace_id, card_id, &id)?;
        // P3: a card has one composer — its idle Chat session ends.
        let _ = self.inner.chats.close(workspace_id, card_id);
        let now = now_ms();
        let exchange = Exchange {
            id: id.clone(),
            created_at: now,
            updated_at: now,
            proposer,
            critic,
            ask: capped(ask, ASK_CAP),
            attachment_ids: attachment_ids.to_vec(),
            rounds_default: ROUNDS_DEFAULT,
            rounds_max: ROUNDS_MAX,
            rounds_done: 0,
            rounds_target: ROUNDS_DEFAULT,
            note: None,
            status: ExchangeStatus::Running,
            pause: None,
            turns: Vec::new(),
            proposer_conversation: Some(Conversation::new(proposer, now)),
            critic_conversation: Some(Conversation::new(critic, now)),
            outcome: None,
        };
        let dropped = {
            let mut state = self.inner.state.lock();
            let Some(plans) = self.inner.plans(&mut state, workspace_id, card_id) else {
                drop(state);
                self.inner.chats.release(workspace_id, card_id, &id);
                return Err(chat_deleted());
            };
            plans.file.exchanges.push(exchange);
            let dropped = plan_store::cap(&mut plans.file);
            Inner::save_locked(&self.inner.config_dir, &state, workspace_id, card_id);
            dropped
        };
        for old in dropped {
            self.drop_lanes(workspace_id, card_id, &old);
            if let Ok(dir) = self.inner.chats.plan_dir(workspace_id, card_id, &old) {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
        self.run(workspace_id, card_id, &id);
        self.snapshot(workspace_id, card_id)
    }

    /// Stop: the turn under way is interrupted, and the exchange pauses.
    pub(crate) fn stop(&self, workspace_id: &str, card_id: &str) -> Result<(), String> {
        let mut state = self.inner.state.lock();
        match state.running.as_mut() {
            Some(running) if running.workspace_id == workspace_id && running.card_id == card_id => running.stop = true,
            _ => return Ok(()),
        }
        drop(state);
        self.inner.notify();
        Ok(())
    }

    /// Retry this turn (§3 *Retry*): the paused exchange runs again from its
    /// turn — a short "answer again" to a session that kept its context, the
    /// re-seed to one that came back fresh, the turn's whole message to one
    /// it never reached. The caller has passed the drain guard and
    /// `start_refusal`.
    pub(crate) fn retry(&self, workspace_id: &str, card_id: &str) -> Result<PlanExchangeSnapshot, String> {
        let exchange = self.current(workspace_id, card_id)?;
        if exchange.status != ExchangeStatus::Paused {
            return Err("This plan isn't paused.".into());
        }
        let card = self.inner.env.card(workspace_id, card_id)?;
        if card.archived {
            return Err("This card is archived. Restore it to go on with its plan.".into());
        }
        if card.column_id != KanbanColumnId::Todo || card.builder.is_some() {
            return Err(crate::kanban::TWO_AI_BUILD_STARTED.into());
        }
        if let Some(elsewhere) = self.running_elsewhere(workspace_id, card_id) {
            return Err(elsewhere);
        }
        self.inner.chats.reserve(workspace_id, card_id, &exchange.id)?;
        // How the paused turn goes again.
        let open = exchange.turns.last().filter(|t| t.outcome != Some(TurnOutcome::Answered)).cloned();
        let sent_kind = open.as_ref().map(|turn| {
            let key = ChatKey::plan(workspace_id, card_id, &exchange.id, role_of(turn.role));
            let conversation = self.inner.chats.lane_view(&key).map(|v| v.conversation).or_else(|| {
                match role_of(turn.role) {
                    PlanRole::Proposer => exchange.proposer_conversation.clone(),
                    PlanRole::Critic => exchange.critic_conversation.clone(),
                }
            });
            let reached = turn.sent_message_id.as_deref().is_some_and(|id| {
                conversation
                    .as_ref()
                    .and_then(|c| c.messages.iter().find(|m| m.id == id))
                    .is_some_and(|m| m.source_id.is_some() && !m.is_error)
            });
            if reached { SentKind::Retry } else { SentKind::Full }
        });
        self.edit(workspace_id, card_id, &exchange.id, |exchange| {
            exchange.status = ExchangeStatus::Running;
            exchange.pause = None;
            if let (Some(kind), Some(turn)) = (sent_kind, exchange.turns.last_mut()) {
                if turn.outcome != Some(TurnOutcome::Answered) {
                    turn.outcome = None;
                    turn.ended_at = None;
                    turn.sent = kind;
                    turn.sent_message_id = None;
                    // The turn's 20-minute net counts from this Retry, not
                    // from the turn's first start (a wait for Claude's
                    // prompt would otherwise time out at once).
                    turn.started_at = now_ms();
                }
            }
        })?;
        self.run(workspace_id, card_id, &exchange.id);
        self.snapshot(workspace_id, card_id)
    }

    /// Another round, with an optional note to both sides: one more
    /// critique and revision. Refused at [`ROUNDS_MAX`] and while another
    /// exchange runs (P2).
    pub(crate) fn more(&self, workspace_id: &str, card_id: &str, note: Option<&str>) -> Result<PlanExchangeSnapshot, String> {
        let exchange = self.current(workspace_id, card_id)?;
        if exchange.status != ExchangeStatus::AwaitingMember {
            return Err("The plan isn't waiting for you right now.".into());
        }
        if exchange.rounds_done >= exchange.rounds_max {
            return Err("Three rounds is the most.".into());
        }
        let card = self.inner.env.card(workspace_id, card_id)?;
        offer_refusal(&card).map_or(Ok(()), Err)?;
        if let Some(elsewhere) = self.running_elsewhere(workspace_id, card_id) {
            return Err(elsewhere);
        }
        self.inner.chats.reserve(workspace_id, card_id, &exchange.id)?;
        let note = note.map(|n| capped(n, ASK_CAP)).filter(|n| !n.is_empty());
        self.edit(workspace_id, card_id, &exchange.id, |exchange| {
            exchange.rounds_target = exchange.rounds_done + 1;
            exchange.note = note;
            exchange.status = ExchangeStatus::Running;
            exchange.pause = None;
        })?;
        self.run(workspace_id, card_id, &exchange.id);
        self.snapshot(workspace_id, card_id)
    }

    /// Use this plan (or, with `edited_text`, Edit… saved): the card's plan
    /// in one backend write (§5), with the chat files the plan used copied
    /// into the card's attachments (Q4). Both sessions end.
    pub(crate) fn accept(&self, workspace_id: &str, card_id: &str, edited_text: Option<&str>) -> Result<KanbanCard, String> {
        let exchange = self.current(workspace_id, card_id)?;
        if !exchange.known() {
            return Err(NEWER.into());
        }
        if exchange.status == ExchangeStatus::Running {
            return Err("The two AIs are still at work on this plan. Wait for them, or press Stop.".into());
        }
        let edited = edited_text.is_some();
        let text = match edited_text {
            Some(text) => text.trim().to_string(),
            None => exchange.latest_plan().ok_or("There is no finished plan to use yet.")?.trim().to_string(),
        };
        let card = self.inner.env.card(workspace_id, card_id)?;
        if card.archived {
            return Err("This card is archived, so the plan wasn't written. Restore it first.".into());
        }
        if card.column_id != KanbanColumnId::Todo || card.builder.is_some() {
            return Err(crate::kanban::TWO_AI_BUILD_STARTED.into());
        }
        let copies = self.copy_chat_files(workspace_id, card_id, &exchange, &card)?;
        let rounds = exchange.rounds_done.max(exchange.turns.iter().map(|t| t.round).max().unwrap_or(0));
        let record = IntakeRecord {
            intake_id: exchange.id.clone(),
            started_at: exchange.created_at,
            concluded_at: Some(now_ms()),
            dispatch_prompt: Some(text.clone()),
            transcript_path: None,
            applied: true,
            vendor: Some(vendor_str(exchange.proposer).to_string()),
            replanned: false,
            two_ais: Some(TwoAisRecord {
                critic: vendor_str(exchange.critic).to_string(),
                rounds,
                exchange_id: exchange.id.clone(),
            }),
        };
        let attachments: Vec<CardAttachment> = copies.iter().map(|(attachment, _)| attachment.clone()).collect();
        let updated = match self.inner.env.apply(workspace_id, card_id, &text, edited, record, attachments) {
            Ok(card) => card,
            Err(error) => {
                for (_, path) in &copies {
                    let _ = std::fs::remove_file(path);
                }
                return Err(error);
            }
        };
        self.edit(workspace_id, card_id, &exchange.id, |exchange| {
            exchange.status = ExchangeStatus::Accepted;
            exchange.pause = None;
            exchange.outcome = Some(Outcome {
                kind: if edited { OutcomeKind::Edited } else { OutcomeKind::Accepted },
                text: text.clone(),
                at: now_ms(),
            });
        })?;
        self.inner.chats.release(workspace_id, card_id, &exchange.id);
        self.drop_lanes(workspace_id, card_id, &exchange.id);
        self.inner.env.board_changed(workspace_id);
        self.inner.emit_state(workspace_id, card_id);
        Ok(updated)
    }

    /// Discard: the exchange ends and nothing is written to the card (a
    /// card made for it stays in To do, Q6). Its thread stays under Earlier
    /// plans.
    pub(crate) fn discard(&self, workspace_id: &str, card_id: &str) -> Result<(), String> {
        let exchange = self.current(workspace_id, card_id)?;
        {
            let mut state = self.inner.state.lock();
            if state.running.as_ref().is_some_and(|r| r.exchange == exchange.id) {
                state.running = None;
            }
        }
        self.edit(workspace_id, card_id, &exchange.id, |exchange| {
            exchange.status = ExchangeStatus::Discarded;
            exchange.pause = None;
            exchange.outcome = Some(Outcome { kind: OutcomeKind::Discarded, text: String::new(), at: now_ms() });
        })?;
        self.inner.chats.release(workspace_id, card_id, &exchange.id);
        self.drop_lanes(workspace_id, card_id, &exchange.id);
        self.inner.notify();
        self.inner.emit_state(workspace_id, card_id);
        Ok(())
    }

    /// The card's exchanges as the UI shows them.
    pub(crate) fn snapshot(&self, workspace_id: &str, card_id: &str) -> Result<PlanExchangeSnapshot, String> {
        self.inner.snapshot(workspace_id, card_id)
    }

    /// The view-only paint of the exchange's Claude session (the side whose
    /// turn it is, else the proposer's).
    pub(crate) fn screen(&self, workspace_id: &str, card_id: &str) -> Result<Option<chat::ChatScreenSnapshot>, String> {
        let exchange = match self.current(workspace_id, card_id) {
            Ok(exchange) => exchange,
            Err(_) => return Ok(None),
        };
        let mut roles = vec![PlanRole::Proposer, PlanRole::Critic];
        if let Some(turn) = exchange.turns.last() {
            roles.sort_by_key(|role| *role != role_of(turn.role));
        }
        Ok(roles
            .into_iter()
            .find_map(|role| self.inner.chats.plan_screen(&ChatKey::plan(workspace_id, card_id, &exchange.id, role))))
    }

    // ── Helpers ───────────────────────────────────────────────────

    fn current(&self, workspace_id: &str, card_id: &str) -> Result<Exchange, String> {
        let mut state = self.inner.state.lock();
        let plans = self.inner.plans(&mut state, workspace_id, card_id).ok_or(chat_deleted())?;
        if !plans.writable {
            return Err(NEWER.into());
        }
        plans
            .file
            .exchanges
            .last()
            .filter(|e| !e.status.finished())
            .cloned()
            .ok_or_else(|| "This card has no plan with two AIs under way.".to_string())
    }

    /// P2's refusal when another card's exchange runs, naming it.
    fn running_elsewhere(&self, workspace_id: &str, card_id: &str) -> Option<String> {
        let running = {
            let state = self.inner.state.lock();
            state.running.as_ref().map(|r| (r.workspace_id.clone(), r.card_id.clone()))
        };
        let (ws, card) = running.or_else(|| self.inner.chats.reservation().map(|(ws, card, _)| (ws, card)))?;
        if ws == workspace_id && card == card_id {
            return Some(EXCHANGE_RUNS.to_string());
        }
        let title = self.inner.env.card(&ws, &card).map(|c| c.title).unwrap_or_else(|_| "another card".into());
        Some(format!("Two AIs are planning \"{title}\" now. Try again when they finish."))
    }

    fn edit(&self, workspace_id: &str, card_id: &str, id: &str, change: impl FnOnce(&mut Exchange)) -> Result<(), String> {
        let mut state = self.inner.state.lock();
        if self.inner.plans(&mut state, workspace_id, card_id).is_none() {
            return Err(chat_deleted());
        }
        if Inner::edit_locked(&self.inner.config_dir, &mut state, workspace_id, card_id, id, change) {
            Ok(())
        } else {
            Err("This plan is gone.".into())
        }
    }

    fn drop_lanes(&self, workspace_id: &str, card_id: &str, id: &str) {
        for role in [PlanRole::Proposer, PlanRole::Critic] {
            self.inner.chats.plan_drop(&ChatKey::plan(workspace_id, card_id, id, role));
        }
    }

    /// Q4: the chat files the exchange used, copied into the card's own
    /// attachments folder; one already on the card (same name and size) is
    /// not copied again, and one gone from disk is left out.
    fn copy_chat_files(
        &self,
        workspace_id: &str,
        card_id: &str,
        exchange: &Exchange,
        card: &KanbanCard,
    ) -> Result<Vec<(CardAttachment, PathBuf)>, String> {
        let (available, chat_dir) = self.inner.chats.chat_attachments(workspace_id, card_id)?;
        let used: Vec<&Attachment> =
            available.iter().filter(|a| exchange.attachment_ids.contains(&a.id) && !a.stored_name.is_empty()).collect();
        if used.is_empty() {
            return Ok(Vec::new());
        }
        let dir = crate::kanban::card_attachments_dir(&self.inner.config_dir, workspace_id, card_id)?;
        let mut copies: Vec<(CardAttachment, PathBuf)> = Vec::new();
        for attachment in used {
            let source = attachment.path(&chat_dir);
            let Ok(meta) = std::fs::metadata(&source) else { continue };
            if card.attachments.iter().any(|c| c.display_name == attachment.name && c.size_bytes == meta.len()) {
                continue;
            }
            let id = uuid::Uuid::new_v4().to_string();
            let target = dir.join(format!("{id}-{}", attachment.stored_name));
            let copied = std::fs::create_dir_all(&dir)
                .map_err(|e| format!("create {}: {e}", dir.display()))
                .and_then(|()| {
                    let tmp = target.with_extension("tmp");
                    std::fs::copy(&source, &tmp).map_err(|e| format!("copy {}: {e}", attachment.name))?;
                    crate::platform::rename(&tmp, &target).map_err(|e| format!("rename: {e}"))
                });
            if let Err(error) = copied {
                for (_, path) in &copies {
                    let _ = std::fs::remove_file(path);
                }
                return Err(error);
            }
            let lower = attachment.name.to_ascii_lowercase();
            let mime = match lower.rsplit('.').next().unwrap_or("") {
                "png" => Some("image/png"),
                "jpg" | "jpeg" => Some("image/jpeg"),
                "gif" => Some("image/gif"),
                "webp" => Some("image/webp"),
                "heic" => Some("image/heic"),
                _ => None,
            };
            copies.push((
                CardAttachment {
                    id,
                    display_name: attachment.name.clone(),
                    stored_path: target.to_string_lossy().into_owned(),
                    size_bytes: meta.len(),
                    mime_type: mime.map(str::to_string),
                    added_at: now_ms(),
                },
                target,
            ));
        }
        Ok(copies)
    }

    /// Starts the driver for `id` (the slots are already reserved).
    fn run(&self, workspace_id: &str, card_id: &str, id: &str) {
        let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        {
            let mut state = self.inner.state.lock();
            state.running = Some(Running {
                workspace_id: workspace_id.to_string(),
                card_id: card_id.to_string(),
                exchange: id.to_string(),
                generation,
                stop: false,
                waiting_for_prompt: false,
            });
        }
        let inner = self.inner.clone();
        let (ws, card, id) = (workspace_id.to_string(), card_id.to_string(), id.to_string());
        std::thread::spawn(move || {
            Driver { inner: Arc::downgrade(&inner), ws, card, id, generation, candidate: None }.run();
        });
        self.inner.emit_state(workspace_id, card_id);
    }

    #[cfg(test)]
    pub(crate) fn status_of(&self, workspace_id: &str, card_id: &str) -> Option<(ExchangeStatus, Option<Pause>)> {
        let mut state = self.inner.state.lock();
        let plans = self.inner.plans(&mut state, workspace_id, card_id)?;
        plans.file.exchanges.last().map(|e| (e.status, e.pause.clone()))
    }

    /// The card's latest status, whether a run is set and whether the
    /// registry holds a reservation, read under the state lock in one go
    /// (a run's end changes all three inside it).
    #[cfg(test)]
    pub(crate) fn run_view(&self, workspace_id: &str, card_id: &str) -> Option<(ExchangeStatus, bool, bool)> {
        let mut state = self.inner.state.lock();
        let running = state.running.is_some();
        let status = self.inner.plans(&mut state, workspace_id, card_id)?.file.exchanges.last()?.status;
        Some((status, running, self.inner.chats.reservation().is_some()))
    }

    #[cfg(test)]
    pub(crate) fn latest(&self, workspace_id: &str, card_id: &str) -> Option<Exchange> {
        let mut state = self.inner.state.lock();
        self.inner.plans(&mut state, workspace_id, card_id)?.file.exchanges.last().cloned()
    }
}

/// `(workspace, card)` of every `<config>/projects/<ws>/cards/<card>/plan.json`.
fn plan_files(config: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Ok(workspaces) = std::fs::read_dir(config.join("projects")) else { return out };
    for ws in workspaces.flatten() {
        let Some(ws_id) = ws.file_name().to_str().map(str::to_string) else { continue };
        let Ok(cards) = std::fs::read_dir(ws.path().join("cards")) else { continue };
        for card in cards.flatten() {
            let Some(card_id) = card.file_name().to_str().map(str::to_string) else { continue };
            if plan_store::plan_path(&card.path()).is_file() {
                out.push((ws_id.clone(), card_id));
            }
        }
    }
    out
}

const NEWER: &str = "This card's plans were saved by a newer Plyloft; update Plyloft to go on with them.";

fn chat_deleted() -> String {
    "This card was deleted.".to_string()
}

fn vendor_str(vendor: ChatVendor) -> &'static str {
    match vendor {
        ChatVendor::Codex => "codex",
        _ => "claude",
    }
}

/// A pull request card's refusal (Challenger on a pull request).
pub(crate) const PR_CARD_REFUSAL: &str =
    "Plan with two AIs is for a card that hasn't been built yet; this card reviews a pull request.";

/// The offer rule's backend half (§2, §6): an unbuilt card, not archived,
/// not a pull request's card, with no intake under way.
fn offer_refusal(card: &KanbanCard) -> Option<String> {
    if card.archived {
        return Some("This card is archived. Restore it to plan it.".into());
    }
    if card.column_id != KanbanColumnId::Todo || card.builder.is_some() {
        return Some("Plan with two AIs is for a card that hasn't been built yet.".into());
    }
    // Challenger on a pull request: its card reviews (or fixes) code that
    // already exists, so it has no plan to write — wherever it sits.
    if card.pr_review.is_some() {
        return Some(PR_CARD_REFUSAL.into());
    }
    if card.intake_status == IntakeStatus::Active {
        return Some(INTAKE_RUNS.into());
    }
    None
}

impl Inner {
    fn notify(&self) {
        *self.wake.lock() += 1;
        self.signal.notify_all();
    }

    fn wait(&self, timeout: Duration) {
        let mut wake = self.wake.lock();
        let seen = *wake;
        let until = Instant::now() + timeout;
        while *wake == seen {
            if self.signal.wait_until(&mut wake, until).timed_out() {
                return;
            }
        }
    }

    /// The card's plans, loaded once (`None` for a deleted card).
    fn plans<'a>(&self, state: &'a mut State, workspace_id: &str, card_id: &str) -> Option<&'a mut CardPlans> {
        if state.forgotten_workspaces.contains(workspace_id)
            || state.forgotten_cards.contains(&(workspace_id.to_string(), card_id.to_string()))
        {
            return None;
        }
        let card_dir = crate::chat_store::card_dir(&self.config_dir, workspace_id, card_id).ok()?;
        Some(state.files.entry((workspace_id.to_string(), card_id.to_string())).or_insert_with(|| {
            let (file, writable) = plan_store::load(&plan_store::plan_path(&card_dir));
            CardPlans { file, writable }
        }))
    }

    fn save_locked(config: &Path, state: &State, workspace_id: &str, card_id: &str) {
        if state.forgotten_workspaces.contains(workspace_id)
            || state.forgotten_cards.contains(&(workspace_id.to_string(), card_id.to_string()))
        {
            return;
        }
        let Some(plans) = state.files.get(&(workspace_id.to_string(), card_id.to_string())) else { return };
        if !plans.writable {
            return;
        }
        let Ok(card_dir) = crate::chat_store::card_dir(config, workspace_id, card_id) else { return };
        if let Err(error) = plan_store::save(&plan_store::plan_path(&card_dir), &plans.file) {
            log::warn!("plan {workspace_id}/{card_id}: save: {error}");
        }
    }

    /// Changes exchange `id` and saves; false when it is gone.
    fn edit_locked(
        config: &Path,
        state: &mut State,
        workspace_id: &str,
        card_id: &str,
        id: &str,
        change: impl FnOnce(&mut Exchange),
    ) -> bool {
        let key = (workspace_id.to_string(), card_id.to_string());
        let Some(plans) = state.files.get_mut(&key) else { return false };
        let Some(exchange) = plans.file.exchanges.iter_mut().find(|e| e.id == id) else { return false };
        change(exchange);
        exchange.updated_at = now_ms();
        Self::save_locked(config, state, workspace_id, card_id);
        true
    }

    fn lanes(&self, workspace_id: &str, card_id: &str, exchange: &Exchange) -> Vec<LaneState> {
        [(PlanRole::Proposer, exchange.proposer, &exchange.proposer_conversation), (PlanRole::Critic, exchange.critic, &exchange.critic_conversation)]
            .into_iter()
            .map(|(role, vendor, stored)| {
                let view = self.chats.lane_view(&ChatKey::plan(workspace_id, card_id, &exchange.id, role));
                LaneState {
                    role,
                    vendor,
                    status: view.as_ref().map_or(ChatStatus::Idle, |v| v.status),
                    usage: view
                        .as_ref()
                        .map(|v| v.conversation.usage.clone())
                        .or_else(|| stored.as_ref().map(|c| c.usage.clone()))
                        .unwrap_or_default(),
                    pty_id: view.as_ref().and_then(|v| v.pty_id.clone()),
                    attention: view.and_then(|v| v.attention),
                }
            })
            .collect()
    }

    fn snapshot(&self, workspace_id: &str, card_id: &str) -> Result<PlanExchangeSnapshot, String> {
        let (file, read_only, waiting, running) = {
            let mut state = self.state.lock();
            let plans = self.plans(&mut state, workspace_id, card_id).ok_or(chat_deleted())?;
            let (file, read_only) = (plans.file.clone(), !plans.writable);
            let waiting = state.running.as_ref().is_some_and(|r| r.waiting_for_prompt);
            let running = state.running.as_ref().map(|r| (r.workspace_id.clone(), r.card_id.clone()));
            (file, read_only, waiting, running)
        };
        let mut earlier = file.exchanges;
        let current = earlier.last().filter(|e| !e.status.finished()).cloned();
        if current.is_some() {
            earlier.pop();
        }
        let lanes = current.as_ref().map(|e| self.lanes(workspace_id, card_id, e)).unwrap_or_default();
        let running_elsewhere = running
            .filter(|(ws, card)| !(ws == workspace_id && card == card_id))
            .map(|(ws, card)| self.env.card(&ws, &card).map(|c| c.title).unwrap_or_else(|_| "another card".into()));
        Ok(PlanExchangeSnapshot {
            workspace_id: workspace_id.to_string(),
            card_id: card_id.to_string(),
            current,
            earlier,
            read_only,
            running_elsewhere,
            lanes,
            waiting_for_prompt: waiting,
        })
    }

    /// `plan://state`: the card's current exchange as the UI draws it
    /// (status, rounds, turns, pause, both lanes' tokens and terminals).
    fn emit_state(&self, workspace_id: &str, card_id: &str) {
        if let Ok(snapshot) = self.snapshot(workspace_id, card_id) {
            let exchange_id = snapshot.current.as_ref().map(|e| e.id.clone());
            let mut payload = serde_json::to_value(&snapshot).unwrap_or(serde_json::Value::Null);
            if let Some(object) = payload.as_object_mut() {
                // The messages travel in `plan://messages`; the state is light.
                if let Some(current) = object.get_mut("current").and_then(|c| c.as_object_mut()) {
                    current.remove("proposerConversation");
                    current.remove("criticConversation");
                }
                object.remove("earlier");
                object.insert("exchangeId".into(), serde_json::json!(exchange_id));
            }
            self.env.emit(STATE_EVENT, payload);
        }
    }
}

/// The running exchange's driver.
struct Driver {
    inner: Weak<Inner>,
    ws: String,
    card: String,
    id: String,
    generation: u64,
    /// An answer read at a relay point, waiting to be read the same once
    /// more (the text is stable).
    candidate: Option<(u32, String)>,
}

enum Step {
    Again,
    Exit,
}

impl Driver {
    fn run(mut self) {
        let mut last_emit = Instant::now();
        loop {
            let Some(inner) = self.inner.upgrade() else { return };
            if inner.closed.load(Ordering::SeqCst) || inner.chats.is_closed() {
                return;
            }
            let poll = inner.limits.poll;
            match self.step(&inner) {
                Step::Exit => return,
                Step::Again => {}
            }
            if last_emit.elapsed() >= Duration::from_secs(1) {
                inner.emit_state(&self.ws, &self.card);
                last_emit = Instant::now();
            }
            drop(inner);
            if let Some(inner) = self.inner.upgrade() {
                inner.wait(poll);
            }
        }
    }

    /// This exchange, while it is still the running one.
    fn exchange(&self, inner: &Inner) -> Option<(Exchange, bool)> {
        let mut state = inner.state.lock();
        let running = state.running.as_ref()?;
        if running.generation != self.generation {
            return None;
        }
        let stop = running.stop;
        let plans = inner.plans(&mut state, &self.ws, &self.card)?;
        let exchange = plans.file.exchanges.iter().find(|e| e.id == self.id)?.clone();
        (exchange.status == ExchangeStatus::Running).then_some((exchange, stop))
    }

    fn edit(&self, inner: &Inner, change: impl FnOnce(&mut Exchange)) -> bool {
        let mut state = inner.state.lock();
        if inner.closed.load(Ordering::SeqCst) || state.running.as_ref().is_none_or(|r| r.generation != self.generation) {
            return false;
        }
        Inner::edit_locked(&inner.config_dir, &mut state, &self.ws, &self.card, &self.id, change)
    }

    fn set_waiting(&self, inner: &Inner, waiting: bool) {
        let changed = {
            let mut state = inner.state.lock();
            match state.running.as_mut() {
                Some(r) if r.generation == self.generation && r.waiting_for_prompt != waiting => {
                    r.waiting_for_prompt = waiting;
                    true
                }
                _ => false,
            }
        };
        if changed {
            inner.emit_state(&self.ws, &self.card);
        }
    }

    /// Pauses with `kind`: the turn under way ends with `outcome`, the
    /// slots go back, the driver stops.
    fn pause(&self, inner: &Inner, kind: PauseKind, reason: String, outcome: Option<TurnOutcome>) -> Step {
        self.end_run(inner, |exchange| {
            if let (Some(outcome), Some(turn)) = (outcome, exchange.turns.last_mut()) {
                if turn.outcome.is_none() {
                    turn.outcome = Some(outcome);
                    turn.ended_at = Some(now_ms());
                }
            }
            exchange.status = ExchangeStatus::Paused;
            exchange.pause = Some(Pause { kind, reason });
        });
        inner.emit_state(&self.ws, &self.card);
        Step::Exit
    }

    /// The run ends (a pause, or the member's turn): the status changes,
    /// `running` clears and the slots go back under one lock. A Retry or
    /// Another round that sees the new status then never meets this run's
    /// `running` ("Two AIs are planning this card"), and never has the
    /// reservation it just took released by this run after it (the VM run
    /// of 82c036c6 met the first: Another round the moment the rounds
    /// ended). `chats.release` takes only the registry's lock, which no
    /// holder of it ever waits on this state's from.
    fn end_run(&self, inner: &Inner, change: impl FnOnce(&mut Exchange)) -> bool {
        let mut state = inner.state.lock();
        if inner.closed.load(Ordering::SeqCst) || state.running.as_ref().is_none_or(|r| r.generation != self.generation) {
            return false;
        }
        if !Inner::edit_locked(&inner.config_dir, &mut state, &self.ws, &self.card, &self.id, change) {
            return false;
        }
        state.running = None;
        inner.chats.release(&self.ws, &self.card, &self.id);
        true
    }

    /// The turn's 20-minute net (§3 *Rounds*): past it, the turn is stopped
    /// (Esc / `turn/interrupt` when it still runs) and the exchange pauses.
    /// It holds a turn that runs, and one that sits Ready but never reaches
    /// a relay point (a settled Claude whose composer never comes back
    /// idle, a Codex turn with no `turn/completed`): neither waits for ever.
    fn past_net(&self, inner: &Inner, turn: &Turn, view: &LaneView, started: Duration) -> Option<Step> {
        if started < inner.limits.turn_net {
            return None;
        }
        let _ = inner.chats.plan_interrupt(&self.key(role_of(turn.role)));
        let minutes = inner.limits.turn_net.as_secs() / 60;
        let what = match turn.role {
            TurnRole::Critique => "on this critique",
            _ => "on this turn",
        };
        Some(self.pause(
            inner,
            PauseKind::Timeout,
            format!("{} took more than {minutes} minutes {what}.", view.vendor.label()),
            Some(TurnOutcome::Stopped),
        ))
    }

    /// Why the turn may not go on: the card was archived, or its build
    /// started (it left To do, or a Builder is recorded — a GitHub board's
    /// reconcile, a paused exchange's build, P1). Read before every turn and
    /// every send (§4).
    fn card_refusal(&self, inner: &Inner) -> Option<Step> {
        match inner.env.card(&self.ws, &self.card) {
            Ok(card) if card.archived => {
                Some(self.pause(inner, PauseKind::Archived, "This card was archived.".into(), None))
            }
            Ok(card) if card.column_id != KanbanColumnId::Todo || card.builder.is_some() => Some(self.pause(
                inner,
                PauseKind::Failed,
                BUILD_LEFT.into(),
                None,
            )),
            Ok(_) => None,
            Err(error) => Some(self.pause(inner, PauseKind::SessionEnded, error, None)),
        }
    }

    fn key(&self, role: PlanRole) -> ChatKey {
        ChatKey::plan(&self.ws, &self.card, &self.id, role)
    }

    fn step(&mut self, inner: &Inner) -> Step {
        let Some((exchange, stop)) = self.exchange(inner) else { return Step::Exit };
        let open = exchange.turns.last().filter(|t| t.outcome.is_none()).cloned();
        if stop {
            if let Some(turn) = &open {
                let _ = inner.chats.plan_interrupt(&self.key(role_of(turn.role)));
                let what = match turn.role {
                    TurnRole::Propose => "plan",
                    TurnRole::Critique => "critique",
                    _ => "revision",
                };
                return self.pause(
                    inner,
                    PauseKind::Stopped,
                    format!("You stopped {}'s {what}.", turn.vendor.label()),
                    Some(TurnOutcome::Stopped),
                );
            }
            return self.pause(inner, PauseKind::Stopped, "You stopped the plan.".into(), None);
        }
        let Some(turn) = open else {
            return self.next_turn(inner, &exchange);
        };
        match turn.sent_message_id.clone() {
            None => self.send_turn(inner, &exchange, &turn),
            Some(sent) => self.watch_turn(inner, &exchange, &turn, &sent),
        }
    }

    /// The last turn is answered: the next one opens (after reading the
    /// card's archive flag, §4), or the exchange waits for the member.
    fn next_turn(&mut self, inner: &Inner, exchange: &Exchange) -> Step {
        match next_step(exchange) {
            Next::AwaitMember => {
                self.end_run(inner, |exchange| {
                    exchange.status = ExchangeStatus::AwaitingMember;
                    exchange.note = None;
                });
                inner.emit_state(&self.ws, &self.card);
                Step::Exit
            }
            Next::Turn { round, role } => {
                if let Some(step) = self.card_refusal(inner) {
                    return step;
                }
                let vendor = match role_of(role) {
                    PlanRole::Proposer => exchange.proposer,
                    PlanRole::Critic => exchange.critic,
                };
                let n = exchange.turns.len() as u32;
                self.edit(inner, |exchange| {
                    exchange.turns.push(Turn {
                        n,
                        round,
                        role,
                        vendor,
                        sent: SentKind::Full,
                        sent_message_id: None,
                        answer_message_id: None,
                        answer: None,
                        verdict: None,
                        started_at: now_ms(),
                        ended_at: None,
                        outcome: None,
                    });
                });
                inner.emit_state(&self.ws, &self.card);
                Step::Again
            }
        }
    }

    /// The card's files for a side's first message or re-seed.
    fn files(&self, inner: &Inner, exchange: &Exchange) -> Result<Files, String> {
        let (available, chat_dir) = inner.chats.chat_attachments(&self.ws, &self.card)?;
        let chat: Vec<Attachment> = available.iter().filter(|a| exchange.attachment_ids.contains(&a.id)).cloned().collect();
        let removed = exchange.attachment_ids.len().saturating_sub(chat.len());
        let card = inner.env.card(&self.ws, &self.card)?;
        Ok(Files { chat, chat_dir, card: card.attachments.iter().map(|a| a.stored_path.clone()).collect(), removed })
    }

    /// Opens the turn's lane (its record from `plan.json`) and sends the
    /// turn's message; a Claude not at its prompt is waited for.
    fn send_turn(&mut self, inner: &Inner, exchange: &Exchange, turn: &Turn) -> Step {
        if let Some(step) = self.card_refusal(inner) {
            return step;
        }
        let role = role_of(turn.role);
        let key = self.key(role);
        let vendor = turn.vendor;
        let context = match inner.env.context(&self.ws, &self.card) {
            Ok(context) => context,
            Err(error) => return self.pause(inner, PauseKind::SessionEnded, error, None),
        };
        let files = match self.files(inner, exchange) {
            Ok(files) => files,
            Err(error) => return self.pause(inner, PauseKind::SessionEnded, error, None),
        };
        let mut add_dirs = vec![files.chat_dir.clone()];
        let card_dir = crate::kanban::card_attachments_dir(&inner.config_dir, &self.ws, &self.card).ok();
        if !files.card.is_empty() {
            if let Some(dir) = &card_dir {
                let _ = std::fs::create_dir_all(dir);
                add_dirs.push(dir.clone());
            }
        }
        let _ = std::fs::create_dir_all(&files.chat_dir);
        add_dirs.extend(context.project_dir.iter().filter(|dir| dir.is_dir()).cloned());
        let stored = match role {
            PlanRole::Proposer => exchange.proposer_conversation.clone(),
            PlanRole::Critic => exchange.critic_conversation.clone(),
        }
        .unwrap_or_else(|| Conversation::new(vendor, now_ms()));
        let had_session = stored.session_id.is_some();
        // This side's first turn (it gets the ask and the files): none of
        // its turns answered yet.
        let first =
            !exchange.turns.iter().any(|t| role_of(t.role) == role && t.n != turn.n && t.outcome == Some(TurnOutcome::Answered));
        let weak = self.inner.clone();
        let (ws, card, id) = (self.ws.clone(), self.card.clone(), self.id.clone());
        let sink: chat::PlanSink = Arc::new(move |conversation: &Conversation| {
            let Some(inner) = weak.upgrade() else { return };
            let mut state = inner.state.lock();
            let config = inner.config_dir.clone();
            Inner::edit_locked(&config, &mut state, &ws, &card, &id, |exchange| {
                let slot = match role {
                    PlanRole::Proposer => &mut exchange.proposer_conversation,
                    PlanRole::Critic => &mut exchange.critic_conversation,
                };
                *slot = Some(conversation.clone());
            });
        });
        let spec = PlanLaneSpec {
            vendor,
            instructions: lane_instructions(exchange, role, &context, &files.chat_dir),
            add_dirs,
            sink,
        };
        if let Err(error) = inner.chats.plan_lane_open(&key, spec, stored) {
            return self.pause(inner, PauseKind::SessionEnded, error, None);
        }
        // What this send carries (§3 *Retry*).
        let full = turn_text(exchange, turn.round, turn.role, first);
        let (text, with_files) = match turn.sent {
            SentKind::Retry => (RETRY_TEXT.to_string(), false),
            _ => (full, first),
        };
        let reseed_words = reseed_text(exchange, turn.round, turn.role);
        let reseed = had_session.then(|| Reseed {
            claude: files.claude(&reseed_words),
            codex: files.codex(&reseed_words),
            stored: reseed_words.clone(),
        });
        let relay_of = match (turn.role, turn.sent) {
            (TurnRole::Propose, _) | (_, SentKind::Retry) => None,
            _ => exchange.turns.iter().rev().find(|t| t.outcome == Some(TurnOutcome::Answered)).and_then(|t| t.answer_message_id.clone()),
        };
        let none = Files { chat_dir: files.chat_dir.clone(), ..Files::default() };
        let used = if with_files { &files } else { &none };
        let send = PlanSend {
            claude: used.claude(&text),
            codex: used.codex(&text),
            stored: text.clone(),
            attachment_ids: if with_files { used.chat.iter().map(|a| a.id.clone()).collect() } else { Vec::new() },
            turn: turn.n,
            relay_of,
            reseed,
        };
        match inner.env.send(&key, send) {
            Ok(message) => {
                self.set_waiting(inner, false);
                let removed = files.removed;
                self.edit(inner, |exchange| {
                    if let Some(open) = exchange.turns.last_mut() {
                        open.sent_message_id = Some(message.id.clone());
                        open.started_at = now_ms();
                    }
                });
                if removed > 0 && with_files {
                    let what = if removed == 1 { "A file was".to_string() } else { format!("{removed} files were") };
                    inner.chats.plan_notice(&key, &format!("{what} removed from the card's chat since Start, so it wasn't sent again."));
                }
                inner.emit_state(&self.ws, &self.card);
                Step::Again
            }
            Err(error) if error.contains("isn't at its prompt") || error.contains("still answering") => {
                // A wait, never a failure (§3): tried again every second,
                // within the turn's net — unless the receiving Claude waits
                // on a screen of its own (a menu, a survey): a view-only
                // lane can't answer it, so that session ends and the
                // exchange pauses at once (§4), never 20 minutes later.
                if let Some(view) = inner.chats.lane_view(&key) {
                    if let (Some(attention), ChatVendor::Claude) = (&view.attention, view.vendor) {
                        inner.chats.plan_end(&key);
                        self.set_waiting(inner, false);
                        return self.pause(
                            inner,
                            PauseKind::Screen,
                            format!("Claude was waiting on its own screen ({attention}). Plyloft ended that session."),
                            None,
                        );
                    }
                }
                self.set_waiting(inner, true);
                let waited = Duration::from_millis(now_ms().saturating_sub(turn.started_at).max(0) as u64);
                if waited >= inner.limits.turn_net {
                    let minutes = inner.limits.turn_net.as_secs() / 60;
                    return self.pause(
                        inner,
                        PauseKind::Timeout,
                        format!("{} wasn't at its prompt for more than {minutes} minutes.", vendor.label()),
                        None,
                    );
                }
                std::thread::sleep(inner.limits.prompt_retry);
                Step::Again
            }
            Err(error) if error == chat::NO_ROOM || error.contains("answering right now") || error.contains("hold two") => {
                self.pause(inner, PauseKind::Failed, chat::NO_ROOM.into(), None)
            }
            Err(error) => self.pause(inner, kind_of(&error), error, None),
        }
    }

    /// The turn under way: its end, read from its lane; at a relay point
    /// the answer is taken (twice the same), and the next turn follows.
    fn watch_turn(&mut self, inner: &Inner, exchange: &Exchange, turn: &Turn, sent: &str) -> Step {
        let key = self.key(role_of(turn.role));
        let Some(view) = inner.chats.lane_view(&key) else {
            return self.pause(inner, PauseKind::SessionEnded, "The session ended.".into(), Some(TurnOutcome::Stopped));
        };
        // The session came back fresh and took the re-seed (Claude decides
        // it at its start, Codex once its resume fails): recorded, and said.
        if view.reseeded && turn.sent != SentKind::Reseed {
            self.edit(inner, |exchange| {
                if let Some(open) = exchange.turns.last_mut() {
                    open.sent = SentKind::Reseed;
                }
            });
            inner.chats.plan_notice(
                &key,
                &format!("{} started a new session, so Plyloft sent it the plan so far.", view.vendor.label()),
            );
            return Step::Again;
        }
        let started = Duration::from_millis(now_ms().saturating_sub(turn.started_at).max(0) as u64);
        if matches!(view.status, ChatStatus::Working | ChatStatus::Starting) {
            if let Some(step) = self.past_net(inner, turn, &view, started) {
                return step;
            }
        }
        if view.status == ChatStatus::Stopped {
            let reason = view.reason.clone().unwrap_or_else(|| format!("{} stopped.", view.vendor.label()));
            return self.pause(inner, kind_of(&reason), reason, Some(TurnOutcome::Stopped));
        }
        if let (Some(attention), ChatVendor::Claude) = (&view.attention, view.vendor) {
            // A view-only lane can't answer Claude's own screen: that
            // session ends; Retry resumes it (§4).
            inner.chats.plan_end(&key);
            return self.pause(
                inner,
                PauseKind::Screen,
                format!("Claude was waiting on its own screen ({attention}). Plyloft ended that session."),
                Some(TurnOutcome::Stopped),
            );
        }
        let message = view.conversation.messages.iter().find(|m| m.id == sent).cloned();
        if !view.live && matches!(view.status, ChatStatus::Idle) {
            return self.pause(inner, PauseKind::SessionEnded, "The session ended.".into(), Some(TurnOutcome::Stopped));
        }
        if matches!(view.status, ChatStatus::Working | ChatStatus::Starting) {
            self.candidate = None;
            return Step::Again;
        }
        if message.as_ref().is_some_and(|m| m.is_error) {
            return self.pause(
                inner,
                PauseKind::Failed,
                format!("{} didn't take the message.", view.vendor.label()),
                Some(TurnOutcome::Failed),
            );
        }
        // Ready: did the turn end with an answer, and is it safe to relay?
        match view.vendor {
            ChatVendor::Codex => match view.codex_turn.as_deref() {
                Some("completed") => {}
                Some("interrupted") => {
                    return self.pause(inner, PauseKind::Stopped, "Codex's turn was stopped.".into(), Some(TurnOutcome::Interrupted))
                }
                Some(failed) => {
                    let why = failed.split_once(": ").map_or(failed, |(_, why)| why).to_string();
                    let reason = format!("Codex: {why}");
                    return self.pause(inner, kind_of(&reason), reason, Some(TurnOutcome::Failed));
                }
                None => return self.past_net(inner, turn, &view, started).unwrap_or(Step::Again),
            },
            _ => {
                if !relay_point(&view, inner.chats.limits().stuck_turn) {
                    return self.past_net(inner, turn, &view, started).unwrap_or(Step::Again);
                }
                if view.turn_close == TurnClose::Interrupted {
                    return self.pause(inner, PauseKind::Stopped, "Claude's turn was stopped.".into(), Some(TurnOutcome::Interrupted));
                }
                // Its echo must be in: the turn read is this message's.
                if message.as_ref().is_none_or(|m| m.source_id.is_none()) {
                    return Step::Again;
                }
            }
        }
        let Some((text, answer_id)) = final_answer(&view.conversation, sent) else {
            return self.pause(
                inner,
                PauseKind::Failed,
                format!("{}'s turn ended without an answer.", view.vendor.label()),
                Some(TurnOutcome::NoAnswer),
            );
        };
        // The answer is stable: read the same twice, a poll apart.
        match &self.candidate {
            Some((n, previous)) if *n == turn.n && *previous == text => {}
            _ => {
                self.candidate = Some((turn.n, text));
                return Step::Again;
            }
        }
        self.candidate = None;
        let verdict = (turn.role == TurnRole::Critique).then(|| verdict_of(&text));
        self.edit(inner, |exchange| {
            if let Some(open) = exchange.turns.last_mut() {
                open.answer = Some(text.clone());
                open.answer_message_id = Some(answer_id.clone());
                open.verdict = verdict;
                open.outcome = Some(TurnOutcome::Answered);
                open.ended_at = Some(now_ms());
                match (open.role, verdict) {
                    (TurnRole::Revise, _) => exchange.rounds_done = open.round,
                    (TurnRole::Critique, Some(Verdict::Ready)) => {
                        // Early stop: the round ends here, and the plan stands.
                        exchange.rounds_done = open.round;
                        exchange.rounds_target = open.round;
                    }
                    _ => {}
                }
            }
        });
        let _ = exchange;
        inner.emit_state(&self.ws, &self.card);
        Step::Again
    }
}

/// A Claude answer may be relayed (§3): the turn is reliably over — closed
/// by the transcript, an interrupt or the stuck closer, or settled with the
/// composer idle and nothing moving for `stuck_turn` — and the composer is
/// idle.
pub(crate) fn relay_point(view: &LaneView, stuck_turn: Duration) -> bool {
    let over = match view.turn_close {
        TurnClose::Ended | TurnClose::Interrupted | TurnClose::Stuck => true,
        TurnClose::Settled => view.quiet_for >= stuck_turn,
        TurnClose::Open => false,
    };
    over && view.composer_idle
}

/// The pause kind a session's stop reason names.
pub(crate) fn kind_of(reason: &str) -> PauseKind {
    use crate::claude_session as cs;
    if reason == cs::FOLDER_TRUST_REFUSAL {
        PauseKind::Trust
    } else if reason == cs::USAGE_LIMIT || reason.to_lowercase().contains("usage limit") || reason.to_lowercase().contains("rate limit") {
        PauseKind::UsageLimit
    } else if reason == cs::NOT_LOGGED_IN
        || reason.to_lowercase().contains("not logged in")
        || reason.to_lowercase().contains("sign in")
        || reason.to_lowercase().contains("unauthorized")
    {
        PauseKind::SignIn
    } else if reason == cs::API_KEY_QUESTION || reason == cs::FIRST_RUN_SETUP || reason == cs::BYPASS_QUESTION || reason.contains("screen") {
        PauseKind::Screen
    } else if reason == crate::pty::PTY_REGISTRY_CLOSED {
        PauseKind::Quit
    } else {
        PauseKind::Failed
    }
}

// ── IPC ──────────────────────────────────────────────────────────────

fn require_card(kanban: &crate::kanban::KanbanStore, workspace_id: &str, card_id: &str) -> Result<KanbanCard, String> {
    kanban.get_card(workspace_id, card_id)
}

/// On a worker: a start may wait for room and reads the doctor.
#[tauri::command]
pub async fn plan_exchange_start(
    app: tauri::AppHandle,
    workspace_id: String,
    card_id: String,
    preferred: Option<String>,
    ask: Option<String>,
    attachment_ids: Option<Vec<String>>,
) -> Result<PlanExchangeSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        crate::drain::guard_dispatch(&app.state::<crate::drain::DrainCoordinator>(), "plan")?;
        let kanban = app.state::<crate::kanban::KanbanStore>();
        require_card(&kanban, &workspace_id, &card_id)?;
        if let Some(why) = kanban.start_refusal(&workspace_id, &card_id)? {
            return Err(why);
        }
        let preferred = match preferred.as_deref() {
            Some("codex") => ChatVendor::Codex,
            _ => ChatVendor::Claude,
        };
        // Under CARD_START_LOCK: a Start build can't slip in between the
        // offer rule's check and the exchange's start (P1 reads it there).
        let _start = crate::commands::CARD_START_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        app.state::<PlanExchanges>().start(
            &workspace_id,
            &card_id,
            preferred,
            ask.as_deref().unwrap_or(""),
            &attachment_ids.unwrap_or_default(),
        )
    })
    .await
    .map_err(|e| format!("plan start worker failed: {e}"))?
}

#[tauri::command]
pub fn plan_exchange_get(
    plans: tauri::State<'_, PlanExchanges>,
    kanban: tauri::State<'_, crate::kanban::KanbanStore>,
    workspace_id: String,
    card_id: String,
) -> Result<PlanExchangeSnapshot, String> {
    require_card(&kanban, &workspace_id, &card_id)?;
    plans.snapshot(&workspace_id, &card_id)
}

#[tauri::command]
pub fn plan_exchange_stop(
    plans: tauri::State<'_, PlanExchanges>,
    kanban: tauri::State<'_, crate::kanban::KanbanStore>,
    workspace_id: String,
    card_id: String,
) -> Result<(), String> {
    require_card(&kanban, &workspace_id, &card_id)?;
    plans.stop(&workspace_id, &card_id)
}

#[tauri::command]
pub async fn plan_exchange_retry(app: tauri::AppHandle, workspace_id: String, card_id: String) -> Result<PlanExchangeSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        crate::drain::guard_dispatch(&app.state::<crate::drain::DrainCoordinator>(), "plan")?;
        let kanban = app.state::<crate::kanban::KanbanStore>();
        require_card(&kanban, &workspace_id, &card_id)?;
        if let Some(why) = kanban.start_refusal(&workspace_id, &card_id)? {
            return Err(why);
        }
        let _start = crate::commands::CARD_START_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        app.state::<PlanExchanges>().retry(&workspace_id, &card_id)
    })
    .await
    .map_err(|e| format!("plan retry worker failed: {e}"))?
}

#[tauri::command]
pub async fn plan_exchange_more(
    app: tauri::AppHandle,
    workspace_id: String,
    card_id: String,
    note: Option<String>,
) -> Result<PlanExchangeSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        crate::drain::guard_dispatch(&app.state::<crate::drain::DrainCoordinator>(), "plan")?;
        let kanban = app.state::<crate::kanban::KanbanStore>();
        require_card(&kanban, &workspace_id, &card_id)?;
        let _start = crate::commands::CARD_START_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        app.state::<PlanExchanges>().more(&workspace_id, &card_id, note.as_deref())
    })
    .await
    .map_err(|e| format!("plan round worker failed: {e}"))?
}

/// On a worker: Accept copies files and ends two sessions.
#[tauri::command]
pub async fn plan_exchange_accept(
    app: tauri::AppHandle,
    workspace_id: String,
    card_id: String,
    edited_text: Option<String>,
) -> Result<KanbanCard, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        require_card(&app.state::<crate::kanban::KanbanStore>(), &workspace_id, &card_id)?;
        // Under CARD_START_LOCK: a Start build either ran before (and the
        // refusal says so) or waits for this write.
        let _start = crate::commands::CARD_START_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        app.state::<PlanExchanges>().accept(&workspace_id, &card_id, edited_text.as_deref())
    })
    .await
    .map_err(|e| format!("plan accept worker failed: {e}"))?
}

#[tauri::command]
pub async fn plan_exchange_discard(app: tauri::AppHandle, workspace_id: String, card_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        require_card(&app.state::<crate::kanban::KanbanStore>(), &workspace_id, &card_id)?;
        app.state::<PlanExchanges>().discard(&workspace_id, &card_id)
    })
    .await
    .map_err(|e| format!("plan discard worker failed: {e}"))?
}

/// The cards whose plan with two AIs runs, waits or is paused (every
/// workspace): the Board, the card's Now and the Inbox say so.
#[tauri::command]
pub async fn plan_exchange_open_cards(app: tauri::AppHandle) -> Result<Vec<PlanOpenCard>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        app.state::<PlanExchanges>().open_cards()
    })
    .await
    .map_err(|e| format!("plan list worker failed: {e}"))
}

#[tauri::command]
pub fn plan_exchange_screen(
    plans: tauri::State<'_, PlanExchanges>,
    kanban: tauri::State<'_, crate::kanban::KanbanStore>,
    workspace_id: String,
    card_id: String,
) -> Result<Option<chat::ChatScreenSnapshot>, String> {
    require_card(&kanban, &workspace_id, &card_id)?;
    plans.screen(&workspace_id, &card_id)
}

#[cfg(test)]
#[path = "plan_exchange_tests.rs"]
mod tests;
