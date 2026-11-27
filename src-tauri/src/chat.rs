//! A card's chat: a discussion with Claude or Codex about one card, with the
//! member's attachments (`docs/spikes/CHAT_ATTACHMENTS_SPIKE.md`; owner
//! decisions of 2026-10-15). Backend only; the card's "Chat" tab is part 2.
//!
//! **Discussion only.** Neither model can change anything from a chat; code
//! changes stay with the card's Builder.
//! - **Claude** is its interactive TUI in a PTY (Hard rule 1: the member's
//!   own `claude`, never `-p`, which `pty::refuse_print_mode` refuses
//!   anyway), hidden, with the read-only profile v3 of the reviews
//!   (`read_only_provider`: `--tools Read,Grep,Glob,Skill`, every writer
//!   and command tool disallowed, `--restricted`, skill shell off,
//!   `--strict-mcp-config`), plus `--add-dir` on the card's attachments and
//!   on the project. It runs in a plain folder under Plyloft's session root
//!   (`<config>/claude-sessions/chats/<ws>/<card>`), which the member's one
//!   trust click there covers. Phase 0 measured that this profile can raise
//!   no permission dialog, so the chat has no approval buttons.
//! - **Codex** is `codex app-server` (the `codex-chat` lifecycle, through
//!   `codex_app::CodexAppRegistry`, never the TUI) with a read-only sandbox
//!   and `approvalPolicy: never`, run in the same plain folder and pointed at
//!   the project by path; this module speaks its protocol itself.
//!
//! **Whether a turn is over is the transcript's to say**; **Claude's screen
//! is read for the whole session** as a terminal shows it (`chat_screen`: an
//! emulated grid fed every PTY byte; Challenger rounds 1 and 2): Claude's
//! trust question, a screen only the member can get past (sign-in, first-run
//! setup, the API-key question, the usage-limit menu) or, before the session
//! has written anything new, the startup net stops the chat and says why —
//! Plyloft never answers any of them; another menu (a model or rewind
//! picker) asks for the terminal. A message is pasted only when Claude's
//! idle composer is the last thing drawn (`chat_screen::composer_idle`);
//! otherwise the send is refused with its reason, so a menu never receives
//! a paste and its Enter. The terminal itself ("Show terminal", part 2) is
//! interactive: the member's own keystrokes reach Claude as in any tile.
//!
//! **One active chat per card, one conversation per vendor.** A card keeps
//! a conversation with each vendor it was asked (`chat_store`), and shows
//! one: the vendor chosen when the chat is opened. Each vendor's session
//! holds only its own context, so mixing both in one thread would misstate
//! what each model has seen; keeping one per vendor lets the member ask
//! the other without losing either history. Only one of a card's two runs
//! at a time, which bounds the processes and keeps the chat to one composer.
//!
//! **Sessions start lazily and sleep when idle.** A send starts the session
//! when none runs: a new Claude session gets the first message as its
//! positional prompt (the collected sessions' measured form); a resumed one
//! (`claude --resume <id>` in the same folder) starts with no prompt and gets
//! the message pasted once its composer is idle (Phase 0's measured form);
//! Codex resumes with `thread/resume`. At most [`MAX_LIVE_CHATS`] run at
//! once and a ready one is suspended after [`IDLE_SUSPEND`]. Every chat
//! process is killed on quit (`ChatRegistry::kill_all`), when its card or
//! workspace is deleted (`forget_card`, `forget_workspace`), and when the
//! card's worktree is removed (`end_card_session`, from
//! `verify_logs::card_worktree_removed`).
//!
//! **What Claude is sent** always starts with one space ([`composer_text`]):
//! measured to neutralise a leading `!` (a shell command, even in the
//! read-only profile — Phase 0 §3b) and `/` (the slash menu); a first prompt
//! starting with `-` is no option then; a leading `&` (backgrounding, in
//! newer Claude Code) is unmeasured and covered the same way. ESC and the
//! other control characters but `\n` and `\t` are removed, so no text can end
//! the bracketed paste or submit early. Stop is Esc (never Ctrl+C), sent
//! only while a turn runs.
//!
//! **Plyloft keeps its own copy** of every message (`chat_store`): Claude
//! removes transcripts after `cleanupPeriodDays`; a chat whose transcript is
//! gone continues in a new session and says so. Tokens are shown, never a
//! cost.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, Instant};

use crate::chat_attachments::{self, clean_text, Attachment};
use crate::chat_store::{self, CardChatFile, ChatMessage, ChatTool, ChatVendor, TokenUsage};
use crate::chat_transcript::{ChatItem, ChatState, ClaudeFold, TurnClose};
use crate::codex_app::{CodexAppEvent, CodexAppRegistry, CodexAppSink};

/// The most chat sessions running at once, all cards together.
pub(crate) const MAX_LIVE_CHATS: usize = 3;
/// A ready chat's session is suspended after this long without a message.
pub(crate) const IDLE_SUSPEND: Duration = Duration::from_secs(10 * 60);
/// How often a Claude chat's transcript and screen are read.
const POLL: Duration = Duration::from_millis(250);
/// A chat's record is written at most this often while a reply streams
/// (and at once when a message is sent, a turn ends or a session changes).
const SAVE_EVERY: Duration = Duration::from_secs(1);
/// Streamed assistant text reaches the UI at most this often.
const STREAM_EMIT_EVERY: Duration = Duration::from_millis(150);
/// The most of a card's notes a session is told.
const NOTES_CAP: usize = 4_000;

/// Codex App Server request ids.
const CODEX_INITIALIZE: u64 = 1;
const CODEX_THREAD_RESUME: u64 = 2;
const CODEX_THREAD_START: u64 = 3;
const CODEX_FIRST_TURN_ID: u64 = 10;

/// Events (`chat://state`, `chat://messages`).
pub(crate) const STATE_EVENT: &str = "chat://state";
pub(crate) const MESSAGES_EVENT: &str = "chat://messages";
/// A plan lane's events (Plan with two AIs §6): never the Chat's.
pub(crate) const PLAN_STATE_EVENT: &str = "plan://state";
pub(crate) const PLAN_MESSAGES_EVENT: &str = "plan://messages";

/// The timings and caps of the registry (tests shorten them).
#[derive(Debug, Clone, Copy)]
pub(crate) struct ChatLimits {
    pub max_live: usize,
    pub idle_after: Duration,
    /// A pasted message that never shows up in the transcript this long
    /// after the paste is reported as not taken.
    pub echo_timeout: Duration,
    /// For a Claude that writes no end-of-turn entry: a finished answer and
    /// a transcript still this long end the turn.
    pub turn_settle: Duration,
    /// Claude's trust question must stay the latest frame this long.
    pub trust_confirm: Duration,
    /// How long a screen must be still before the startup net or the
    /// "waits on its screen" notice.
    pub screen_settle: Duration,
    /// How long a numbered menu (a model or rewind picker opened in the
    /// terminal) must be the still screen before the tab says Claude waits
    /// on it — short: the member is looking for that line (Windows walk of
    /// 567616d4: `screen_settle`'s 20 s read as "Claude is ready").
    pub menu_settle: Duration,
    /// A session that has written nothing new this long after it started,
    /// on a still screen, waits on a screen Plyloft doesn't know.
    pub startup_net: Duration,
    /// Repeated Stops closer than this send one Esc.
    pub esc_debounce: Duration,
    /// An open turn with Claude at its idle composer and nothing changing
    /// this long is over (`ClaudeWatch`).
    pub stuck_turn: Duration,
    /// The same with Claude's working line still drawn above the composer:
    /// only a net for a line left stale (a live one can sit unchanged for
    /// long: walks of 1b958f7b).
    pub stuck_turn_working: Duration,
}

impl Default for ChatLimits {
    fn default() -> Self {
        ChatLimits {
            max_live: MAX_LIVE_CHATS,
            idle_after: IDLE_SUSPEND,
            echo_timeout: Duration::from_secs(45),
            turn_settle: Duration::from_secs(3),
            trust_confirm: Duration::from_secs(2),
            screen_settle: Duration::from_secs(20),
            menu_settle: Duration::from_millis(1500),
            startup_net: crate::pty::STARTUP_NET,
            esc_debounce: Duration::from_secs(1),
            stuck_turn: Duration::from_secs(10),
            stuck_turn_working: Duration::from_secs(600),
        }
    }
}

/// What Plyloft types for `text`: control characters but `\n` and `\t`
/// removed (an `ESC[201~` would end the bracketed paste, a CR submit), and
/// always one space in front (Phase 0, Claude Code 2.1.300: a leading space
/// keeps a `!` from running a shell command and a `/` from opening the slash
/// menu; a first prompt is then no `-` option either). Claude's transcript
/// keeps the space; the chat's reader trims it (`chat_transcript::member_words`).
pub(crate) fn composer_text(text: &str) -> String {
    format!(" {}", clean_text(text))
}

/// The bytes that put `message` into a ready Claude composer and submit it:
/// a bracketed paste (a multi-line message stays one block), then CR.
pub(crate) fn paste_bytes(message: &str) -> Vec<u8> {
    format!("\x1b[200~{}\x1b[201~\r", composer_text(message)).into_bytes()
}

/// Where the chat stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ChatStatus {
    /// No session runs (never started, suspended, closed): a send starts one.
    Idle,
    /// A session is starting (Codex's handshake).
    Starting,
    /// The model is answering (or a message waits for Claude's composer):
    /// the composer waits; Stop interrupts.
    Working,
    /// The turn ended: the composer is the member's.
    Ready,
    /// The session ended on its own or met a screen only the member can get
    /// past (`reason` says which); a send starts it again.
    Stopped,
}

/// What a session is told about its card.
#[derive(Debug, Clone, Default)]
pub(crate) struct ChatContext {
    pub title: String,
    pub notes: String,
    /// The project folder the model may read: the card's worktree when it
    /// has one, else the workspace.
    pub project_dir: Option<PathBuf>,
    /// The card's plan (`dispatch_prompt`), when it has one: told in a
    /// block of its own, so a Chat knows an accepted plan (Plan with two
    /// AIs §3).
    pub plan: Option<String>,
    /// Challenger on a pull request: what the card is (the pull request it
    /// reviews, and whether anyone on it changes that code), told instead of
    /// the Builder's line (`pr_review::chat_note`). `None` on every other card.
    pub pull_request: Option<String>,
}

/// The most of a card's plan a session is told.
pub(crate) const PLAN_BLOCK_CAP: usize = 3_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatSnapshot {
    pub workspace_id: String,
    pub card_id: String,
    pub vendor: ChatVendor,
    pub status: ChatStatus,
    pub reason: Option<String>,
    /// The model waits on its own screen (Show terminal).
    pub attention: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub usage: TokenUsage,
    pub attachments: Vec<Attachment>,
    /// The hidden Claude terminal's PTY id while one runs (`pty://data`).
    /// "Show terminal" is interactive (owner's decision, Challenger round
    /// 2): the member's own keystrokes reach Claude as in any Claude tile;
    /// only Plyloft's own writes wait for an idle composer.
    pub pty_id: Option<String>,
    /// 1.179.0: the Claude account the conversation's session was started
    /// on, which a resume runs on (`None`: Main, or a Codex conversation).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

/// `chat_screen`: a live Claude chat's terminal, to start "Show terminal".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatScreenSnapshot {
    pub pty_id: String,
    /// The screen and its terminal modes (bracketed paste, the cursor keys'
    /// mode) as escape sequences that redraw it (the grid's
    /// `state_formatted`): write it to the xterm first — after resizing the
    /// xterm to `rows` × `cols` — then follow `pty://data` for this
    /// `pty_id`, writing only the bytes at or after `offset`.
    pub formatted: String,
    /// The stream offset the grid stands at (`pty://data`'s `offset`).
    pub offset: u64,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatStateEvent {
    workspace_id: String,
    card_id: String,
    vendor: ChatVendor,
    status: ChatStatus,
    reason: Option<String>,
    attention: Option<String>,
    usage: TokenUsage,
    pty_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessagesEvent {
    workspace_id: String,
    card_id: String,
    vendor: ChatVendor,
    /// Added or changed messages (by `id`).
    messages: Vec<ChatMessage>,
}

/// How the registry tells the UI (`app.emit` in the app; a recorder in tests).
pub(crate) type Emitter = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

/// Tests: the CLIs and the vendors' config folders to use instead of the
/// real ones.
#[derive(Debug, Clone, Default)]
pub(crate) struct ChatOverrides {
    pub claude: Option<String>,
    pub codex: Option<String>,
    pub claude_config: Option<PathBuf>,
    pub codex_home: Option<PathBuf>,
    /// Where the chat folders go instead of `<config>/claude-sessions/chats`
    /// (the live test: under the test profile's trusted session root).
    pub chat_root: Option<PathBuf>,
    /// A file every Claude screen decision is appended to: the grid's rows,
    /// whether the composer read idle, its footer (the live test).
    pub screen_log: Option<PathBuf>,
}

/// Which side of a Plan with two AIs exchange a lane is. A plan lane is
/// keyed by its role, never its vendor: with one vendor ready, both roles
/// are that vendor, in two separate sessions (owner, 2026-10-16, Q5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PlanRole {
    Proposer,
    Critic,
}

impl PlanRole {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            PlanRole::Proposer => "proposer",
            PlanRole::Critic => "critic",
        }
    }
}

/// A session lane: a card's Chat, one side of a card's plan exchange
/// (`docs/plans/PLAN_WITH_TWO_AIS.md` §6), or — hosted by the workspace,
/// not a card — one side of a Next improvement round (1.173.0 E2,
/// `next_improvement::round`: `role` Proposer proposes, Critic gives the
/// second opinion). Every per-session name — the folder, the Codex session
/// key, the record, the events — comes from it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum Lane {
    Chat,
    Plan { exchange: String, role: PlanRole },
    Improve { area: String, round: String, role: PlanRole },
}

/// What a lane belongs to: a card (the Chat and plan lanes), or the
/// workspace itself (a Next improvement round's lanes, whose key has no
/// card: `card_id` is "").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LaneHost<'a> {
    Card { workspace_id: &'a str, card_id: &'a str },
    Workspace { workspace_id: &'a str },
}

/// The folder (inside a workspace's chat folders) every Next improvement
/// lane runs under: `next-improvement/<area>/round-<id>/<role>`. Card ids
/// are UUIDs, so no card's folder is ever named this.
pub(crate) const IMPROVE_FOLDER: &str = "next-improvement";

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct ChatKey {
    pub(crate) workspace_id: String,
    pub(crate) card_id: String,
    pub(crate) lane: Lane,
}

impl ChatKey {
    pub(crate) fn chat(workspace_id: &str, card_id: &str) -> Self {
        ChatKey { workspace_id: workspace_id.to_string(), card_id: card_id.to_string(), lane: Lane::Chat }
    }

    pub(crate) fn plan(workspace_id: &str, card_id: &str, exchange: &str, role: PlanRole) -> Self {
        ChatKey {
            workspace_id: workspace_id.to_string(),
            card_id: card_id.to_string(),
            lane: Lane::Plan { exchange: exchange.to_string(), role },
        }
    }

    /// One side of a Next improvement round, hosted by the workspace.
    pub(crate) fn improve(workspace_id: &str, area: &str, round: &str, role: PlanRole) -> Self {
        ChatKey {
            workspace_id: workspace_id.to_string(),
            card_id: String::new(),
            lane: Lane::Improve { area: area.to_string(), round: round.to_string(), role },
        }
    }

    pub(crate) fn host(&self) -> LaneHost<'_> {
        match self.lane {
            Lane::Improve { .. } => LaneHost::Workspace { workspace_id: &self.workspace_id },
            _ => LaneHost::Card { workspace_id: &self.workspace_id, card_id: &self.card_id },
        }
    }

    fn is_plan(&self) -> bool {
        matches!(self.lane, Lane::Plan { .. })
    }

    /// A lane a driver runs (a plan side or a Next improvement side): its
    /// record is given when it opens and saved through its sink, its
    /// terminal is view-only, and it tells the driver its turns' ends.
    fn is_driven(&self) -> bool {
        matches!(self.lane, Lane::Plan { .. } | Lane::Improve { .. })
    }

    fn exchange(&self) -> Option<&str> {
        match &self.lane {
            Lane::Plan { exchange, .. } => Some(exchange),
            Lane::Chat | Lane::Improve { .. } => None,
        }
    }

    fn same_card(&self, workspace_id: &str, card_id: &str) -> bool {
        self.workspace_id == workspace_id && self.card_id == card_id
    }
}

/// What a plan lane tells its exchange's driver (`plan_exchange`). Sent
/// under the lane's lock: the listener only records and wakes.
#[derive(Debug, Clone)]
pub(crate) enum LaneSignal {
    /// The lane's status left `Working` or `Starting` (every change goes
    /// through `Inner::set_status`, and `take_proc`).
    TurnEnded { key: ChatKey, vendor: ChatVendor, status: ChatStatus, reason: Option<String>, turn_close: TurnClose },
    /// A session started; `fresh` when it came back without its earlier
    /// context (a new Claude session id, a Codex `thread/start`).
    SessionStarted { key: ChatKey, fresh: bool },
    /// Anything else the exchange's state shows changed.
    State { key: ChatKey },
}

pub(crate) type LaneListener = Arc<dyn Fn(LaneSignal) + Send + Sync>;

/// Where a plan lane's conversation is saved: into `plan.json`, by the
/// exchange (never `chat.json`).
pub(crate) type PlanSink = Arc<dyn Fn(&chat_store::Conversation) + Send + Sync>;

/// A plan lane's own settings, set when the driver opens it.
#[derive(Clone)]
pub(crate) struct PlanLaneSpec {
    pub vendor: ChatVendor,
    /// Its system prompt / `developerInstructions` (§3, at most 8,000).
    pub instructions: String,
    /// Claude's `--add-dir` folders (attachments, the project).
    pub add_dirs: Vec<PathBuf>,
    pub sink: PlanSink,
}

/// The message a send carries instead, should the session come back fresh
/// (§3 *Fresh sessions*): the re-seed.
#[derive(Debug, Clone)]
pub(crate) struct Reseed {
    pub claude: String,
    pub codex: serde_json::Value,
    /// What Plyloft's own copy records as its text.
    pub stored: String,
}

/// One plan-lane send (`ChatRegistry::plan_send`).
#[derive(Debug, Clone)]
pub(crate) struct PlanSend {
    /// What Claude is typed (`claude_message` already applied).
    pub claude: String,
    /// Codex's `turn/start` input.
    pub codex: serde_json::Value,
    /// Plyloft's own copy's text.
    pub stored: String,
    pub attachment_ids: Vec<String>,
    pub turn: u32,
    pub relay_of: Option<String>,
    pub reseed: Option<Reseed>,
}

/// A plan lane as its driver reads it.
#[derive(Debug, Clone)]
pub(crate) struct LaneView {
    pub live: bool,
    pub vendor: ChatVendor,
    pub status: ChatStatus,
    pub reason: Option<String>,
    pub attention: Option<String>,
    pub turn_close: TurnClose,
    pub composer_idle: bool,
    /// Since when the transcript and the screen have been still (Claude).
    pub quiet_for: Duration,
    /// How Codex's last turn ended (`turn/completed`'s status, or
    /// "refused" for a refused `turn/start`).
    pub codex_turn: Option<String>,
    pub conversation: chat_store::Conversation,
    pub pty_id: Option<String>,
    /// The last send went as its re-seed (the session came back fresh).
    pub reseeded: bool,
}

struct ClaudeProc {
    pty_id: String,
    process_id: Option<u32>,
    reaped: Arc<AtomicBool>,
    /// Set when Plyloft ends the session: its watcher stops quietly.
    stop: Arc<AtomicBool>,
    screen: Arc<crate::chat_screen::ChatScreen>,
    sessions: crate::pty::PtySessions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodexPhase {
    Initializing,
    Thread,
    Ready,
}

struct CodexProc {
    session_key: String,
    phase: CodexPhase,
    thread_id: Option<String>,
    turn_id: Option<String>,
    next_id: u64,
    /// The `turn/start` request in flight, whose error ends the turn.
    turn_request: Option<u64>,
    /// The first message's input (and its id), sent once the thread is ready.
    first_turn: Option<(serde_json::Value, String)>,
    /// Stop was pressed before the turn's id arrived: sent with it.
    interrupt_wanted: bool,
    cwd: PathBuf,
    instructions: String,
    /// `thread/start` config overrides (the member's MCP servers off).
    config: serde_json::Map<String, serde_json::Value>,
    /// 1.168.1 (E1): the model its thread starts (or resumes) on.
    model: crate::settings::ModelChoice,
    last_stderr: Option<String>,
}

enum Proc {
    Claude(ClaudeProc),
    Codex(CodexProc),
}

impl Proc {
    fn vendor(&self) -> ChatVendor {
        match self {
            Proc::Claude(_) => ChatVendor::Claude,
            Proc::Codex(_) => ChatVendor::Codex,
        }
    }
}

/// How a session starts for a send: its instructions, Claude's `--add-dir`
/// folders, whether a new Claude session gets the message as its positional
/// prompt (the Chat) or always pasted at its idle composer (a plan lane:
/// Windows' command-line cap, §3), and folders to create first.
struct StartSpec {
    instructions: String,
    add_dirs: Vec<PathBuf>,
    positional: bool,
    make_dirs: Vec<PathBuf>,
    /// 1.168.1 (E1): the model a new (or resumed) session runs on — the
    /// card's row for the lane's role and vendor (`chat_lane_role`). A
    /// live session keeps the one it started with.
    model: crate::settings::ModelChoice,
}

/// One of Plyloft's user messages not yet seen in the vendor's own record.
#[derive(Debug, Clone)]
struct Pending {
    id: String,
    /// When it was pasted into Claude (`None`: Claude's positional prompt,
    /// or Codex), for the echo timeout.
    pasted_at: Option<Instant>,
}

struct Slot {
    key: ChatKey,
    file: Option<CardChatFile>,
    writable: bool,
    unsaved: bool,
    last_save: Instant,
    /// The card (or its workspace) was deleted: nothing is written for it.
    forgotten: bool,
    /// The vendor the status below is about.
    vendor: Option<ChatVendor>,
    status: ChatStatus,
    reason: Option<String>,
    attention: Option<String>,
    proc: Option<Proc>,
    /// Bumped whenever a session starts or is ended, so a late event from
    /// an earlier one is ignored.
    generation: u64,
    last_used: Instant,
    pending: VecDeque<Pending>,
    /// A message waiting for a resumed Claude's idle composer: its text as
    /// typed (`claude_message`) and its id.
    held: Option<(String, String)>,
    /// Claude's last read: a turn is open (Stop sends Esc only then).
    turn_open: bool,
    last_esc: Option<Instant>,
    /// Streamed assistant messages not yet emitted.
    stream: HashMap<String, ChatMessage>,
    last_stream_emit: Instant,
    /// A plan lane's settings (`None` on the Chat lane).
    plan: Option<PlanLaneSpec>,
    /// Claude's last read: why its turn closed, its composer idle, and
    /// since when nothing moved (a plan lane's relay point, §3).
    turn_close: TurnClose,
    composer_idle: bool,
    quiet_since: Instant,
    /// How Codex's last turn ended.
    codex_turn: Option<String>,
    /// The re-seed the next session start sends if it comes back fresh.
    reseed: Option<Reseed>,
    reseeded: bool,
}

impl Slot {
    fn new(key: ChatKey) -> Self {
        Slot {
            plan: None,
            turn_close: TurnClose::Ended,
            composer_idle: false,
            quiet_since: Instant::now(),
            codex_turn: None,
            reseed: None,
            reseeded: false,
            key,
            file: None,
            writable: true,
            unsaved: false,
            last_save: Instant::now(),
            forgotten: false,
            vendor: None,
            status: ChatStatus::Idle,
            reason: None,
            attention: None,
            proc: None,
            generation: 0,
            last_used: Instant::now(),
            pending: VecDeque::new(),
            held: None,
            turn_open: false,
            last_esc: None,
            stream: HashMap::new(),
            last_stream_emit: Instant::now(),
        }
    }

    fn card_dir(&self, config: &Path) -> Result<PathBuf, String> {
        chat_store::card_dir(config, &self.key.workspace_id, &self.key.card_id)
    }

    fn file(&mut self, config: &Path) -> Result<&mut CardChatFile, String> {
        if self.forgotten {
            return Err(DELETED.into());
        }
        if self.file.is_none() && self.plan.is_some() {
            // A plan lane's record is given when it opens, never read here.
            return Err("This plan session has no record.".into());
        }
        if self.file.is_none() {
            let (file, writable) = chat_store::load(&chat_store::chat_path(&self.card_dir(config)?))?;
            self.file = Some(file);
            self.writable = writable;
        }
        Ok(self.file.as_mut().expect("loaded above"))
    }

    /// The record, for a change: refused when a newer Plyloft wrote it.
    fn file_for_change(&mut self, config: &Path) -> Result<&mut CardChatFile, String> {
        self.file(config)?;
        if !self.writable {
            return Err("This card's chat was saved by a newer Plyloft; update Plyloft to continue it.".into());
        }
        self.unsaved = true;
        Ok(self.file.as_mut().expect("loaded above"))
    }

    fn conversation(&mut self, config: &Path, vendor: ChatVendor) -> Option<&mut chat_store::Conversation> {
        self.file_for_change(config).ok().map(|file| file.conversation_mut(vendor, now_ms()))
    }

    fn save(&mut self, config: &Path, force: bool) {
        if self.forgotten || !self.unsaved || !self.writable || (!force && self.last_save.elapsed() < SAVE_EVERY) {
            return;
        }
        let Some(file) = self.file.as_ref() else {
            return;
        };
        if let Some(plan) = &self.plan {
            // Into the exchange's `plan.json`, never `chat.json`.
            if let Some(conversation) = file.conversations.first() {
                (plan.sink)(conversation);
            }
            self.unsaved = false;
            self.last_save = Instant::now();
            return;
        }
        let result = self.card_dir(config).and_then(|dir| {
            std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
            chat_store::save(&chat_store::chat_path(&dir), file)
        });
        match result {
            Ok(()) => {
                self.unsaved = false;
                self.last_save = Instant::now();
            }
            Err(error) => log::warn!("chat {}/{}: save: {error}", self.key.workspace_id, self.key.card_id),
        }
    }

    fn live(&self) -> bool {
        self.proc.is_some()
    }

    fn pty_id(&self) -> Option<String> {
        match &self.proc {
            Some(Proc::Claude(claude)) => Some(claude.pty_id.clone()),
            _ => None,
        }
    }
}

const DELETED: &str = "This card was deleted.";

/// P2: fewer than two slots can be freed for an exchange.
pub(crate) const NO_ROOM: &str =
    "Plyloft runs at most 3 AI chats at once, and the others are answering. Wait for one to finish, then try again.";

/// The card's Chat while its plan exchange runs (P3's other side).
pub(crate) const PLANNING_NOW: &str =
    "Two AIs are planning this card now; the Chat waits until they finish (or you stop them).";

#[derive(Default)]
struct Slots {
    map: HashMap<ChatKey, Arc<Mutex<Slot>>>,
    /// Deleted while this app runs: nothing is stored for them again.
    forgotten_cards: HashSet<(String, String)>,
    forgotten_workspaces: HashSet<String>,
    /// The one running plan exchange's two slots (P2): `(ws, card,
    /// exchange)`. Its lanes are never evicted, and every other session
    /// shares what is left.
    reservation: Option<(String, String, String)>,
}

impl Slots {
    fn reserved(&self, key: &ChatKey) -> bool {
        match (&self.reservation, key.exchange()) {
            (Some((ws, card, exchange)), Some(mine)) => key.same_card(ws, card) && exchange == mine,
            _ => false,
        }
    }
}

/// How many slots a running exchange holds.
pub(crate) const PLAN_SLOTS: usize = 2;

struct Inner {
    config_dir: PathBuf,
    /// A leaf lock: no other lock (a slot's, the plan state's) is taken
    /// while it is held. `plan_exchange::Driver::end_run` takes it (through
    /// `release`) under the plan state's lock, so a slot's or the plan
    /// state's lock taken under this one would deadlock with it.
    slots: Mutex<Slots>,
    closed: AtomicBool,
    emitter: OnceLock<Emitter>,
    listener: OnceLock<LaneListener>,
    codex: CodexAppRegistry,
    limits: ChatLimits,
    overrides: ChatOverrides,
}

/// Every card chat's live session (managed state).
#[derive(Clone)]
pub struct ChatRegistry {
    inner: Arc<Inner>,
}

/// The app's registry, for the paths that remove a card's worktree without
/// an app handle (`end_card_session`).
static GLOBAL: OnceLock<ChatRegistry> = OnceLock::new();

/// A card's worktree is going (`verify_logs::card_worktree_removed`): every
/// session of the card ends — its Chat and both sides of a plan exchange
/// (their histories stay). On a thread of its own: ending a Claude session
/// waits for its hangup. A card with no live session is untouched.
pub(crate) fn end_card_session(workspace_id: &str, card_id: &str) {
    let Some(registry) = GLOBAL.get() else { return };
    let registry = registry.clone();
    let (workspace_id, card_id) = (workspace_id.to_string(), card_id.to_string());
    if registry.card_lanes(&workspace_id, &card_id).iter().all(|slot| !slot.lock().live()) {
        return;
    }
    std::thread::spawn(move || registry.end_card_lanes(&workspace_id, &card_id));
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `<config>/claude-sessions/chats/<ws>`: a workspace's chat folders.
fn workspace_chats_dir(config: &Path, workspace_id: &str) -> Result<PathBuf, String> {
    Ok(crate::claude_session::sessions_root(config)
        .join("chats")
        .join(chat_store::safe_component(workspace_id, "workspace")?))
}

/// `<config>/claude-sessions/chats/<ws>/<card>`: where a card's chat runs,
/// for both vendors. A plain folder (no `.git`), so it inherits the session
/// root's trust; always computed, never taken from a record.
pub(crate) fn chat_dir(config: &Path, workspace_id: &str, card_id: &str) -> Result<PathBuf, String> {
    Ok(workspace_chats_dir(config, workspace_id)?.join(chat_store::safe_component(card_id, "card")?))
}

/// A lane's Codex App Server key: `chat:{ws}:{card}` for the Chat,
/// `plan:{ws}:{card}:{exchange}:{role}` for a plan side — by role, so two
/// Codex sessions of one exchange never share one (Q5).
pub(crate) fn codex_session_key(key: &ChatKey) -> String {
    match &key.lane {
        Lane::Chat => format!("chat:{}:{}", key.workspace_id, key.card_id),
        Lane::Plan { exchange, role } => {
            format!("plan:{}:{}:{}:{}", key.workspace_id, key.card_id, exchange, role.as_str())
        }
        Lane::Improve { area, round, role } => format!("ni:{}:{}:{}:{}", key.workspace_id, area, round, role.as_str()),
    }
}

/// `round-<first 12 hex digits of the round id>`: a round's folder inside
/// its area's Next improvement folder.
pub(crate) fn improve_folder_name(round: &str) -> String {
    let short: String = round.chars().filter(|c| c.is_ascii_hexdigit()).take(12).collect();
    format!("round-{}", if short.is_empty() { "x".to_string() } else { short })
}

/// `plan-<first 12 hex digits of the exchange id>`: an exchange's folder
/// inside the card's chat folder.
pub(crate) fn plan_folder_name(exchange: &str) -> String {
    let short: String = exchange.chars().filter(|c| c.is_ascii_hexdigit()).take(12).collect();
    format!("plan-{}", if short.is_empty() { "x".to_string() } else { short })
}

/// What a model is told about the chat: Claude's `--append-system-prompt`,
/// Codex's `developerInstructions`. Each is told what it can really do.
pub(crate) fn chat_instructions(vendor: ChatVendor, context: &ChatContext, attachments_dir: &Path) -> String {
    let mut text = String::from(
        "You are talking with a member of the team about one card on their Plyloft board. \
         This chat is for discussion only. ",
    );
    match context.pull_request.as_deref() {
        Some(note) => {
            text.push_str(&clean_text(note.trim()));
            text.push_str(" Nothing is changed in this chat, and you should not offer to change it.\n");
        }
        None => text.push_str(
            "Code changes are made by the card's Builder, not in this chat, and you should not offer to make them.\n",
        ),
    }
    text.push_str(match vendor {
        ChatVendor::Codex => {
            "You may run read-only commands to read files (the project and the member's attachments); \
             the sandbox is read-only, so nothing you run can change a file.\n\n"
        }
        _ => {
            "You can read files (the project and the member's attachments) with your Read, Grep and Glob tools; \
             you cannot run commands or change files here. Never suggest `!` commands \
             (they would run a shell command in the member's terminal).\n\n"
        }
    });
    text.push_str(&format!("The card: {}\n", clean_text(context.title.trim())));
    let notes = context.notes.trim();
    if !notes.is_empty() {
        let shown: String = clean_text(notes).chars().take(NOTES_CAP).collect();
        text.push_str(&format!("Its notes:\n{shown}\n"));
    }
    if let Some(plan) = context.plan.as_deref().map(str::trim).filter(|plan| !plan.is_empty()) {
        let shown: String = clean_text(plan).chars().take(PLAN_BLOCK_CAP).collect();
        let cut = if plan.chars().count() > PLAN_BLOCK_CAP { "\n[cut here]" } else { "" };
        text.push_str(&format!("Its plan, as the card holds it now:\n{shown}{cut}\n"));
    }
    if let Some(project) = &context.project_dir {
        text.push_str(&format!("\nThe project's files are in: {}\n", project.display()));
    }
    text.push_str(&format!("The member's attachments are in: {}\n", attachments_dir.display()));
    text
}

/// The argv of a card's Claude chat session: the read-only profile v3 of
/// the reviews (`read_only_provider::read_only_argv`, held to it by a test)
/// with `--add-dir` on the attachments and the project, the card's context,
/// and — for a new session — the first message as the positional prompt. A
/// resumed session (`--resume`) starts with none: its message is pasted once
/// its composer is idle.
///
/// Order matters: `--add-dir` and the tool lists take several values, so
/// the prompt follows `--strict-mcp-config`, which takes none.
///
/// 1.168.1 (E1): `--model` (when `model` names one) goes after
/// `--strict-mcp-config` and before the prompt, as a review's does; blank
/// passes nothing, so the CLI's own default decides.
pub(crate) fn claude_chat_argv(
    session_id: &str,
    resume: bool,
    add_dirs: &[PathBuf],
    instructions: &str,
    prompt: Option<&str>,
    model: &crate::settings::ModelChoice,
) -> Vec<String> {
    use crate::read_only_provider::{
        CLAUDE_READ_ONLY_ALLOWED_TOOLS, CLAUDE_READ_ONLY_DISALLOWED_TOOLS, CLAUDE_READ_ONLY_SETTINGS,
        CLAUDE_READ_ONLY_TOOLS,
    };
    let mut args = vec![
        if resume { "--resume".to_string() } else { crate::claude_session::SESSION_ID_FLAG.to_string() },
        session_id.to_string(),
    ];
    if !add_dirs.is_empty() {
        args.push("--add-dir".into());
        args.extend(add_dirs.iter().map(|dir| dir.to_string_lossy().into_owned()));
    }
    args.extend([
        "--permission-mode".into(),
        "dontAsk".into(),
        "--tools".into(),
        CLAUDE_READ_ONLY_TOOLS.into(),
        "--allowedTools".into(),
        CLAUDE_READ_ONLY_ALLOWED_TOOLS.into(),
        "--disallowedTools".into(),
        CLAUDE_READ_ONLY_DISALLOWED_TOOLS.into(),
        // One argv element: no shell parses it, on Windows either.
        "--settings".into(),
        CLAUDE_READ_ONLY_SETTINGS.into(),
        "--append-system-prompt".into(),
        instructions.into(),
        "--restricted".into(),
        "--strict-mcp-config".into(),
    ]);
    // 1.169.0 (A1): `--effort` beside `--model`, each when chosen.
    args.extend(model.claude_flags());
    if let Some(prompt) = prompt {
        args.push(composer_text(prompt));
    }
    args
}

/// The web-reading tools a Next improvement proposer gets on top of the
/// read-only profile (E2): it reads the product's pages and the web, and
/// cites what it found, so both stay open to any site. Neither writes, runs
/// a command or reaches the member's MCP servers (`--strict-mcp-config`
/// stays).
pub(crate) const WEB_READING_TOOLS: [&str; 2] = ["WebFetch", "WebSearch"];

/// The file-reading tools, which a proposer may use only inside its roots.
const SCOPED_READ_TOOLS: [&str; 3] = ["Read", "Grep", "Glob"];

/// A root as Claude's permission rules name an absolute path: `//` then the
/// path with `/` separators (`//Users/me/copy/**`). A Windows path gets
/// two: `//C:/Users/me/copy/**` and `//c/Users/me/copy/**`, the form Claude
/// Code may normalise a Windows path to.
pub(crate) fn permission_roots(root: &Path) -> Vec<String> {
    let text = root.to_string_lossy().replace('\\', "/");
    let text = text.trim_start_matches('/').trim_end_matches('/');
    let mut roots = vec![format!("//{text}/**")];
    let mut chars = text.chars();
    if let (Some(drive), Some(':')) = (chars.next(), chars.next()) {
        if drive.is_ascii_alphabetic() {
            roots.push(format!("//{}{}/**", drive.to_ascii_lowercase(), &text[2..]));
        }
    }
    roots
}

/// The proposer's argv (E2, Challenger round 1): `args` (a
/// [`claude_chat_argv`]) with [`WEB_READING_TOOLS`] added to `--tools` and
/// taken out of `--disallowedTools`, and `--allowedTools` rebuilt so that,
/// under `dontAsk`, Read, Grep and Glob are allowed only inside `roots` (the
/// read-only copy): a page's injected text can't make it read `~/.ssh` and
/// send it out with WebFetch. Every other element as it was.
pub(crate) fn with_web_reading(mut args: Vec<String>, roots: &[PathBuf]) -> Vec<String> {
    let mut at = 0;
    while at + 1 < args.len() {
        let flag = args[at].clone();
        let value = &mut args[at + 1];
        match flag.as_str() {
            "--tools" => {
                let mut tools: Vec<String> = value.split(',').map(str::to_string).collect();
                for tool in WEB_READING_TOOLS {
                    if !tools.iter().any(|t| t == tool) {
                        tools.push(tool.to_string());
                    }
                }
                *value = tools.join(",");
                at += 2;
            }
            "--allowedTools" => {
                let mut allowed: Vec<String> = value
                    .split(',')
                    .filter(|t| !SCOPED_READ_TOOLS.contains(t) && !t.starts_with("mcp__"))
                    .map(str::to_string)
                    .collect();
                for root in roots.iter().flat_map(|r| permission_roots(r)) {
                    for tool in SCOPED_READ_TOOLS {
                        allowed.push(format!("{tool}({root})"));
                    }
                }
                allowed.extend(WEB_READING_TOOLS.iter().map(|t| t.to_string()));
                *value = allowed.join(",");
                at += 2;
            }
            "--disallowedTools" => {
                let tools: Vec<&str> = value.split(',').filter(|t| !WEB_READING_TOOLS.contains(t)).collect();
                *value = tools.join(",");
                at += 2;
            }
            _ => at += 1,
        }
    }
    args
}

/// 1.168.1 (E1): the `thread/start` / `thread/resume` params of a Codex chat
/// or plan lane: read-only, never asking, its instructions and config
/// overrides, and — when chosen — its model (`model`) and reasoning effort
/// (`model_reasoning_effort`, the same key as `-c` on the command line).
/// Blank parts pass nothing: Codex's own default decides.
pub(crate) fn codex_thread_params_for(
    cwd: &Path,
    instructions: &str,
    config: &serde_json::Map<String, serde_json::Value>,
    model: &crate::settings::ModelChoice,
) -> serde_json::Value {
    let mut params = serde_json::json!({
        "cwd": cwd.to_string_lossy(),
        "approvalPolicy": "never",
        "sandbox": "read-only",
        "developerInstructions": instructions,
    });
    let mut config = config.clone();
    if let Some(effort) = model.reasoning.as_deref() {
        config.insert("model_reasoning_effort".into(), serde_json::Value::String(effort.to_string()));
    }
    if !config.is_empty() {
        params["config"] = serde_json::Value::Object(config);
    }
    if let Some(name) = model.model.as_deref() {
        params["model"] = serde_json::Value::String(name.to_string());
    }
    params
}

/// 1.168.1 (E1): the role a card's chat session plays for its model. The
/// card's Chat and a plan's proposer write — the Builder's row of their
/// vendor; a plan's critic reviews — the Challenger's.
pub(crate) fn chat_lane_role(lane: &Lane) -> crate::settings::AgentRole {
    match lane {
        Lane::Plan { role: PlanRole::Critic, .. } | Lane::Improve { role: PlanRole::Critic, .. } => {
            crate::settings::AgentRole::Challenger
        }
        _ => crate::settings::AgentRole::Builder,
    }
}

/// The model a session of `vendor` on `key`'s lane starts with now.
fn lane_model<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    key: &ChatKey,
    vendor: ChatVendor,
) -> crate::settings::ModelChoice {
    let vendor = if vendor == ChatVendor::Codex { "codex" } else { "claude" };
    // 1.168.1 (E2): the card's own choice first.
    crate::settings::model_for_card_id(app, &key.workspace_id, &key.card_id, vendor, chat_lane_role(&key.lane))
}

/// `thread/start` / `thread/resume` config overrides for a Codex chat: each
/// MCP server the member's `config.toml` declares, turned off
/// (`mcp_servers.<name>.enabled = false`; the protocol has no switch for all
/// of them; the override map takes `-c`'s dotted keys — unmeasured live),
/// and on Windows the OS sandbox the read-only reviews choose. Only the
/// top-level `[mcp_servers]` table is read: servers a `[profiles.<name>]`
/// table adds, or a project's own config, are not addressed.
pub(crate) fn codex_chat_config(codex_home: &Path) -> serde_json::Map<String, serde_json::Value> {
    let mut config = serde_json::Map::new();
    let declared = std::fs::read_to_string(codex_home.join("config.toml"))
        .ok()
        .and_then(|text| text.parse::<toml::Table>().ok())
        .and_then(|table| table.get("mcp_servers").and_then(|v| v.as_table()).cloned())
        .unwrap_or_default();
    for name in declared.keys() {
        // A name that is no bare TOML key (a dot, a space) is quoted, so the
        // dotted path names this one server.
        let bare = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        let key = if bare { name.clone() } else { format!("\"{}\"", name.replace('\\', "\\\\").replace('"', "\\\"")) };
        config.insert(format!("mcp_servers.{key}.enabled"), serde_json::Value::Bool(false));
    }
    if cfg!(windows) {
        config.insert("windows.sandbox".into(), serde_json::Value::String("unelevated".into()));
    }
    config
}

fn tool_message(id: &str, name: &str, detail: &str, outcome: &str) -> ChatMessage {
    let mut message = ChatMessage::new("tool", "", now_ms());
    message.source_id = Some(id.to_string());
    message.tool = Some(ChatTool { name: name.into(), detail: detail.into(), outcome: outcome.into() });
    message
}

fn notice(text: &str, is_error: bool) -> ChatMessage {
    let mut message = ChatMessage::new("notice", text, now_ms());
    message.is_error = is_error;
    message
}

impl ChatRegistry {
    /// 1.176.0 R5: card chats' Codex App Servers running now.
    pub fn codex_live(&self) -> usize {
        self.inner.codex.live()
    }

    pub fn new(config_dir: PathBuf) -> Self {
        Self::with(config_dir, ChatLimits::default(), ChatOverrides::default())
    }

    pub(crate) fn with(config_dir: PathBuf, limits: ChatLimits, overrides: ChatOverrides) -> Self {
        ChatRegistry {
            inner: Arc::new(Inner {
                config_dir,
                slots: Mutex::new(Slots::default()),
                closed: AtomicBool::new(false),
                emitter: OnceLock::new(),
                listener: OnceLock::new(),
                codex: CodexAppRegistry::default(),
                limits: ChatLimits { max_live: limits.max_live.max(1), ..limits },
                overrides,
            }),
        }
    }

    /// The app's own registry, for `end_card_session`.
    pub(crate) fn install_global(&self) {
        let _ = GLOBAL.set(self.clone());
    }

    pub(crate) fn set_emitter(&self, emitter: Emitter) {
        let _ = self.inner.emitter.set(emitter);
    }

    pub(crate) fn set_gate(&self, gate: Arc<crate::app_nap::ActivityGate>) {
        self.inner.codex.set_gate(gate);
    }

    /// Plan exchanges' driver: told every plan lane's turn end, session
    /// start and state change (`plan_exchange`).
    pub(crate) fn set_lane_listener(&self, listener: LaneListener) {
        let _ = self.inner.listener.set(listener);
    }

    pub(crate) fn config_dir(&self) -> &Path {
        &self.inner.config_dir
    }

    pub(crate) fn limits(&self) -> ChatLimits {
        self.inner.limits
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.inner.closed.load(Ordering::SeqCst)
    }

    /// Every lane of a card (its Chat, each plan side).
    fn card_lanes(&self, workspace_id: &str, card_id: &str) -> Vec<Arc<Mutex<Slot>>> {
        self.inner
            .slots
            .lock()
            .map
            .iter()
            .filter(|(key, _)| key.same_card(workspace_id, card_id))
            .map(|(_, slot)| slot.clone())
            .collect()
    }

    /// Ends every session of the card (a worktree removed): the Chat and
    /// both sides of a plan exchange. Their records stay.
    pub(crate) fn end_card_lanes(&self, workspace_id: &str, card_id: &str) {
        for slot in self.card_lanes(workspace_id, card_id) {
            self.close_slot(&slot);
        }
    }

    fn close_slot(&self, slot: &Arc<Mutex<Slot>>) {
        let ended = {
            let mut slot = slot.lock();
            let ended = self.inner.take_proc(&mut slot, ChatStatus::Idle, None);
            let config = self.inner.config_dir.clone();
            slot.save(&config, true);
            self.inner.emit_state(&mut slot);
            ended
        };
        self.inner.end_proc(ended);
    }

    fn forgotten(slots: &Slots, workspace_id: &str, card_id: &str) -> bool {
        slots.forgotten_cards.contains(&(workspace_id.to_string(), card_id.to_string()))
            || slots.forgotten_workspaces.contains(workspace_id)
    }

    /// The idle sweep, every 30 s, for as long as the app runs.
    pub(crate) fn start_sweeper(&self) {
        let weak = Arc::downgrade(&self.inner);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(30));
            let Some(inner) = weak.upgrade() else { return };
            if inner.closed.load(Ordering::SeqCst) {
                return;
            }
            ChatRegistry { inner }.sweep_idle();
        });
    }

    /// The card's slot; refused for a deleted card or workspace (checked and
    /// created under one lock, so a delete can't slip between).
    fn slot(&self, workspace_id: &str, card_id: &str) -> Result<Arc<Mutex<Slot>>, String> {
        chat_store::card_dir(&self.inner.config_dir, workspace_id, card_id)?;
        let key = ChatKey::chat(workspace_id, card_id);
        let mut slots = self.inner.slots.lock();
        if Self::forgotten(&slots, workspace_id, card_id) {
            return Err(DELETED.into());
        }
        Ok(slots.map.entry(key.clone()).or_insert_with(|| Arc::new(Mutex::new(Slot::new(key)))).clone())
    }

    fn snapshot(&self, slot: &mut Slot, vendor: ChatVendor) -> Result<ChatSnapshot, String> {
        let config = self.inner.config_dir.clone();
        let file = slot.file(&config)?;
        let conversation = file.conversation(vendor);
        let mut messages = conversation.map(|c| c.messages.clone()).unwrap_or_default();
        let usage = conversation.map(|c| c.usage.clone()).unwrap_or_default();
        let account = conversation.and_then(|c| c.account.clone());
        let attachments = file.attachments.clone();
        let mine = slot.vendor == Some(vendor);
        // An answer still marked streaming with no turn running is as
        // finished as it will be: a stopped answer, a session ended by a
        // vendor switch, or a `chat.json` written before stopped answers
        // were saved done (Windows walk of 567616d4).
        if !(mine && matches!(slot.status, ChatStatus::Working | ChatStatus::Starting)) {
            finish_streaming(&mut messages);
        }
        Ok(ChatSnapshot {
            workspace_id: slot.key.workspace_id.clone(),
            card_id: slot.key.card_id.clone(),
            vendor,
            status: if mine { slot.status } else { ChatStatus::Idle },
            reason: if mine { slot.reason.clone() } else { None },
            attention: if mine { slot.attention.clone() } else { None },
            messages,
            usage,
            attachments,
            pty_id: if mine { slot.pty_id() } else { None },
            account,
        })
    }

    /// Opens a card's chat with `vendor` (its active vendor from now on) and
    /// returns it. Starts nothing: the first send does. A session of the
    /// card's other vendor is ended.
    pub(crate) fn open(&self, workspace_id: &str, card_id: &str, vendor: ChatVendor) -> Result<ChatSnapshot, String> {
        if vendor == ChatVendor::Other {
            return Err("A card chat is with Claude or Codex.".into());
        }
        let slot = self.slot(workspace_id, card_id)?;
        let ended = {
            let mut slot = slot.lock();
            let config = self.inner.config_dir.clone();
            let file = slot.file_for_change(&config)?;
            file.active_vendor = Some(vendor);
            file.conversation_mut(vendor, now_ms());
            let ended = if slot.proc.as_ref().is_some_and(|proc| proc.vendor() != vendor) {
                self.inner.take_proc(&mut slot, ChatStatus::Idle, None)
            } else {
                None
            };
            // After the take: the ended session's answer is saved finished.
            slot.save(&config, true);
            if slot.vendor != Some(vendor) && !slot.live() {
                slot.vendor = Some(vendor);
                self.inner.set_status(&mut slot, ChatStatus::Idle);
                slot.reason = None;
                slot.attention = None;
            }
            ended
        };
        self.inner.end_proc(ended);
        let mut slot = slot.lock();
        self.snapshot(&mut slot, vendor)
    }

    /// A card's chat with `vendor` (default: its active one), from Plyloft's
    /// own copy.
    /// `preferred` (1.171.0, E1): the vendor a chat that never chose one
    /// opens on — the card's Builder, else the default Builder — instead of
    /// always Claude (`shown_vendor`).
    pub(crate) fn messages(
        &self,
        workspace_id: &str,
        card_id: &str,
        vendor: Option<ChatVendor>,
        preferred: Option<ChatVendor>,
    ) -> Result<ChatSnapshot, String> {
        let slot = self.slot(workspace_id, card_id)?;
        let mut slot = slot.lock();
        let config = self.inner.config_dir.clone();
        let vendor = match vendor {
            Some(vendor) => vendor,
            None => shown_vendor(slot.file(&config)?, preferred),
        };
        self.snapshot(&mut slot, vendor)
    }

    /// Sends the member's `text` (with `attachment_ids`) to the card's chat
    /// with its active vendor, starting or resuming its session as needed.
    /// Refused while the model is answering, and — for a live Claude — unless
    /// its idle composer is the last thing on its screen. Returns the
    /// message as stored.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn send<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        pty: &crate::pty::PtyRegistry,
        workspace_id: &str,
        card_id: &str,
        context: ChatContext,
        text: &str,
        attachment_ids: &[String],
    ) -> Result<ChatMessage, String> {
        let text = clean_text(text.trim_end());
        if text.trim().is_empty() && attachment_ids.is_empty() {
            return Err("Write a message (or attach a file) first.".into());
        }
        // Plan with two AIs (§6): a card has one composer; while its
        // exchange runs, the Chat waits.
        if self.inner.slots.lock().reservation.as_ref().is_some_and(|(ws, card, _)| ws == workspace_id && card == card_id) {
            return Err(PLANNING_NOW.into());
        }
        let slot_arc = self.slot(workspace_id, card_id)?;
        let config = self.inner.config_dir.clone();
        // A session of the card's other vendor (`open` ends it; this is the
        // net): ended outside the card's lock.
        let stale = {
            let mut slot = slot_arc.lock();
            let vendor = slot.file(&config)?.active_vendor.unwrap_or(ChatVendor::Claude);
            if slot.proc.as_ref().is_some_and(|proc| proc.vendor() != vendor) {
                let ended = self.inner.take_proc(&mut slot, ChatStatus::Idle, None);
                slot.save(&config, true);
                ended
            } else {
                None
            }
        };
        self.inner.end_proc(stale);
        let needs_room = !slot_arc.lock().live();
        if needs_room {
            self.make_room(&slot_arc)?;
        }
        let mut slot = slot_arc.lock();
        // Under the card's lock: `kill_all` takes each card's lock after it
        // closes, so a session started here is one it ends.
        if self.inner.closed.load(Ordering::SeqCst) {
            return Err(crate::pty::PTY_REGISTRY_CLOSED.into());
        }
        let card_dir = slot.card_dir(&config)?;
        let attachments_dir = chat_store::attachments_dir(&card_dir);
        let file = slot.file_for_change(&config)?;
        let vendor = file.active_vendor.unwrap_or(ChatVendor::Claude);
        if vendor == ChatVendor::Other {
            return Err("This card's chat is with a vendor this Plyloft doesn't know.".into());
        }
        let mut attachments = Vec::new();
        for id in attachment_ids {
            let found = file.attachments.iter().find(|a| &a.id == id).cloned();
            attachments.push(found.ok_or_else(|| "One of the attached files is no longer on this card.".to_string())?);
        }
        if slot.vendor == Some(vendor) && matches!(slot.status, ChatStatus::Working | ChatStatus::Starting) {
            return Err(format!("{} is still answering; wait for it, or press Stop.", vendor.label()));
        }
        let mut message = ChatMessage::new("user", text.clone(), now_ms());
        message.attachment_ids = attachment_ids.to_vec();
        let claude = chat_attachments::claude_message(&text, &attachments, &attachments_dir);
        let codex = chat_attachments::codex_input(&text, &attachments, &attachments_dir);
        let mut add_dirs = vec![attachments_dir.clone()];
        add_dirs.extend(context.project_dir.iter().filter(|dir| dir.is_dir()).cloned());
        let start = StartSpec {
            instructions: chat_instructions(vendor, &context, &attachments_dir),
            add_dirs,
            positional: true,
            make_dirs: vec![attachments_dir.clone()],
            model: lane_model(app, &slot.key, vendor),
        };
        self.deliver(app, pty, &mut slot, vendor, message, &claude, codex, start)
    }

    /// Puts `message` in the slot's record and sends it to `vendor` —
    /// pasted into a live Claude (only at its idle composer), as a Codex
    /// turn, or by starting (or resuming) the session with `start`. On a
    /// failure nothing stays: the message goes, the reason stays.
    #[allow(clippy::too_many_arguments)]
    fn deliver<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        pty: &crate::pty::PtyRegistry,
        slot: &mut Slot,
        vendor: ChatVendor,
        message: ChatMessage,
        claude_prompt: &str,
        codex_input: serde_json::Value,
        start: StartSpec,
    ) -> Result<ChatMessage, String> {
        let config = self.inner.config_dir.clone();
        // A live Claude takes a paste only at its idle composer.
        let live_claude = match &slot.proc {
            Some(Proc::Claude(claude)) if claude.sessions.contains(&claude.pty_id) => {
                let rows = claude.screen.rows();
                self.inner.log_screen("send: may Plyloft paste?", &rows);
                if !crate::chat_screen::composer_idle(&rows) {
                    return Err(
                        "Claude isn't at its prompt right now (its screen shows something else); nothing was sent. Look at Claude's screen, or try again in a moment."
                            .into(),
                    );
                }
                Some((claude.sessions.clone(), claude.pty_id.clone()))
            }
            _ => None,
        };
        if live_claude.is_some() || matches!(&slot.proc, Some(Proc::Codex(_))) {
            // A live session keeps its context: no re-seed.
            slot.reseed = None;
        }
        slot.reseeded = false;
        slot.codex_turn = None;
        slot.file_for_change(&config)?.conversation_mut(vendor, now_ms()).push(message.clone());
        slot.save(&config, true);
        slot.vendor = Some(vendor);
        slot.last_used = Instant::now();
        let sent = match vendor {
            ChatVendor::Claude => match live_claude {
                Some((sessions, pty_id)) => {
                    slot.pending.push_back(Pending { id: message.id.clone(), pasted_at: Some(Instant::now()) });
                    sessions.write(&pty_id, &paste_bytes(claude_prompt))
                }
                None => self.start_claude(app, pty, slot, &start, claude_prompt, &message.id),
            },
            _ => {
                slot.pending.push_back(Pending { id: message.id.clone(), pasted_at: None });
                let ready = matches!(&slot.proc, Some(Proc::Codex(codex)) if codex.phase == CodexPhase::Ready);
                if ready {
                    self.inner.codex_turn(slot, codex_input, &message.id)
                } else {
                    self.start_codex(slot, &start, codex_input, &message.id)
                }
            }
        };
        if let Err(error) = sent {
            // Nothing reached the model: the message goes, the reason stays.
            slot.pending.retain(|pending| pending.id != message.id);
            slot.held = None;
            slot.reseed = None;
            if let Some(conversation) = slot.conversation(&config, vendor) {
                conversation.messages.retain(|m| m.id != message.id);
            }
            slot.save(&config, true);
            slot.reason = Some(error.clone());
            self.inner.set_status(slot, ChatStatus::Stopped);
            self.inner.emit_state(slot);
            return Err(error);
        }
        // Into `Working`: no turn ends here.
        slot.status = ChatStatus::Working;
        slot.reason = None;
        slot.attention = None;
        let stored = slot
            .file(&config)
            .ok()
            .and_then(|file| file.conversation(vendor))
            .and_then(|c| c.messages.iter().rev().find(|m| m.id == message.id).cloned())
            .unwrap_or(message);
        self.inner.emit_messages(slot, vendor, vec![stored.clone()]);
        self.inner.emit_state(slot);
        Ok(stored)
    }

    /// Stops the model's answer. Claude: Esc, only while its turn runs and
    /// at most once per [`ChatLimits::esc_debounce`] (never Ctrl+C: a second
    /// one on an idle composer quits Claude); a message still waiting for a
    /// resumed Claude's composer is dropped instead. Codex: `turn/interrupt`,
    /// or — before the turn's id arrived — sent as soon as it does.
    pub(crate) fn interrupt(&self, workspace_id: &str, card_id: &str) -> Result<(), String> {
        let slot = self.slot(workspace_id, card_id)?;
        self.interrupt_slot(&slot)
    }

    fn interrupt_slot(&self, slot: &Arc<Mutex<Slot>>) -> Result<(), String> {
        let mut slot = slot.lock();
        if slot.status != ChatStatus::Working {
            return Ok(());
        }
        let config = self.inner.config_dir.clone();
        if let Some((_, id)) = slot.held.take() {
            slot.pending.retain(|pending| pending.id != id);
            let mut changed = Vec::new();
            if let Some(conversation) = slot.conversation(&config, ChatVendor::Claude) {
                if let Some(message) = conversation.message_mut(&id) {
                    message.is_error = true;
                    changed.push(message.clone());
                }
            }
            self.inner.set_status(&mut slot, ChatStatus::Ready);
            slot.save(&config, true);
            self.inner.emit_messages(&slot, ChatVendor::Claude, changed);
            self.inner.emit_state(&mut slot);
            return Ok(());
        }
        let debounce = self.inner.limits.esc_debounce;
        let turn_open = slot.turn_open;
        let recent = slot.last_esc.is_some_and(|at| at.elapsed() < debounce);
        match &mut slot.proc {
            Some(Proc::Claude(claude)) => {
                if !turn_open || recent {
                    return Ok(());
                }
                let (sessions, pty_id) = (claude.sessions.clone(), claude.pty_id.clone());
                slot.last_esc = Some(Instant::now());
                sessions.write(&pty_id, b"\x1b")
            }
            Some(Proc::Codex(codex)) => {
                let (Some(thread), Some(turn)) = (codex.thread_id.clone(), codex.turn_id.clone()) else {
                    codex.interrupt_wanted = true;
                    return Ok(());
                };
                let id = codex.next_id;
                codex.next_id += 1;
                let key = codex.session_key.clone();
                self.inner.codex.write(
                    &key,
                    &serde_json::json!({"id": id, "method": "turn/interrupt", "params": {"threadId": thread, "turnId": turn}}),
                )
            }
            None => Ok(()),
        }
    }

    /// Ends the card's chat session (its history stays; a send resumes it).
    pub(crate) fn close(&self, workspace_id: &str, card_id: &str) -> Result<(), String> {
        let slot = self.slot(workspace_id, card_id)?;
        self.close_slot(&slot);
        Ok(())
    }

    /// The card's Chat answers now (P3: an exchange waits for it).
    pub(crate) fn chat_answering(&self, workspace_id: &str, card_id: &str) -> bool {
        let slot = self.inner.slots.lock().map.get(&ChatKey::chat(workspace_id, card_id)).cloned();
        slot.is_some_and(|slot| matches!(slot.lock().status, ChatStatus::Working | ChatStatus::Starting))
    }

    /// The card's Chat attachments (an exchange's files): copied in a lock
    /// of the Chat slot's own (§6: never two slot locks at once).
    pub(crate) fn chat_attachments(&self, workspace_id: &str, card_id: &str) -> Result<(Vec<Attachment>, PathBuf), String> {
        let slot = self.slot(workspace_id, card_id)?;
        let mut slot = slot.lock();
        let config = self.inner.config_dir.clone();
        let dir = chat_store::attachments_dir(&slot.card_dir(&config)?);
        Ok((slot.file(&config)?.attachments.clone(), dir))
    }

    // ── Plan lanes (Plan with two AIs, §6) ─────────────────────────

    /// Opens (or updates) one side of an exchange: its slot, holding
    /// `conversation` (from `plan.json`) and saving through `spec.sink`.
    /// Refused for a deleted card and after quit. A live lane keeps its
    /// session.
    pub(crate) fn plan_lane_open(
        &self,
        key: &ChatKey,
        spec: PlanLaneSpec,
        conversation: chat_store::Conversation,
    ) -> Result<(), String> {
        if !key.is_driven() || spec.vendor == ChatVendor::Other {
            return Err("A plan session is with Claude or Codex.".into());
        }
        if self.is_closed() {
            return Err(crate::pty::PTY_REGISTRY_CLOSED.into());
        }
        // The host's names must be safe folder names: a card's, or (a
        // workspace-hosted lane) its own folder.
        match key.host() {
            LaneHost::Card { workspace_id, card_id } => {
                chat_store::card_dir(&self.inner.config_dir, workspace_id, card_id)?;
            }
            LaneHost::Workspace { .. } => {
                self.inner.lane_dir_for(key)?;
            }
        }
        let slot = {
            let mut slots = self.inner.slots.lock();
            if Self::forgotten(&slots, &key.workspace_id, &key.card_id) {
                return Err(DELETED.into());
            }
            slots.map.entry(key.clone()).or_insert_with(|| Arc::new(Mutex::new(Slot::new(key.clone())))).clone()
        };
        let mut slot = slot.lock();
        let vendor = spec.vendor;
        if slot.file.is_none() || !slot.live() {
            let mut conversation = conversation;
            conversation.vendor = vendor;
            slot.file = Some(CardChatFile {
                version: chat_store::CHAT_SCHEMA_VERSION,
                active_vendor: Some(vendor),
                attachments: Vec::new(),
                conversations: vec![conversation],
            });
            slot.writable = true;
        }
        slot.vendor = Some(vendor);
        slot.plan = Some(spec);
        Ok(())
    }

    fn plan_slot(&self, key: &ChatKey) -> Result<Arc<Mutex<Slot>>, String> {
        self.inner.slot_for(key).filter(|slot| slot.lock().plan.is_some()).ok_or_else(|| "This plan session isn't open.".to_string())
    }

    /// Sends one turn's message on a plan lane: pasted into its live Claude
    /// at an idle composer (else refused with "isn't at its prompt", which
    /// the driver waits on), as a Codex turn, or by starting the session —
    /// a new Claude one with no positional prompt, its message pasted at
    /// `composer_idle` (§3). `send.reseed`, when given, goes instead should
    /// the session come back fresh. Returns the stored message.
    pub(crate) fn plan_send<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        pty: &crate::pty::PtyRegistry,
        key: &ChatKey,
        send: PlanSend,
    ) -> Result<ChatMessage, String> {
        let slot_arc = self.plan_slot(key)?;
        if !slot_arc.lock().live() {
            self.make_room(&slot_arc)?;
        }
        let mut slot = slot_arc.lock();
        if self.inner.closed.load(Ordering::SeqCst) {
            return Err(crate::pty::PTY_REGISTRY_CLOSED.into());
        }
        let spec = slot.plan.clone().ok_or("This plan session isn't open.")?;
        if matches!(slot.status, ChatStatus::Working | ChatStatus::Starting) {
            return Err(format!("{} is still answering.", spec.vendor.label()));
        }
        let mut message = ChatMessage::new("user", send.stored.clone(), now_ms());
        message.attachment_ids = send.attachment_ids.clone();
        message.turn = Some(send.turn);
        message.relay_of = send.relay_of.clone();
        slot.reseed = send.reseed.clone();
        let start = StartSpec {
            instructions: spec.instructions.clone(),
            add_dirs: spec.add_dirs.clone(),
            positional: false,
            // The driver makes the folders it names.
            make_dirs: Vec::new(),
            model: lane_model(app, key, spec.vendor),
        };
        // Codex's re-seed is chosen when its thread comes back fresh
        // (`codex_thread_ready`).
        self.deliver(app, pty, &mut slot, spec.vendor, message, &send.claude, send.codex, start)
    }

    /// The lane as its driver reads it.
    pub(crate) fn lane_view(&self, key: &ChatKey) -> Option<LaneView> {
        let slot = self.inner.slot_for(key)?;
        let slot = slot.lock();
        let spec = slot.plan.as_ref()?;
        let conversation = slot.file.as_ref().and_then(|file| file.conversations.first().cloned())?;
        let quiet_for = slot.quiet_since.elapsed();
        Some(LaneView {
            live: slot.live(),
            vendor: spec.vendor,
            status: slot.status,
            reason: slot.reason.clone(),
            attention: slot.attention.clone(),
            turn_close: slot.turn_close,
            composer_idle: slot.composer_idle,
            quiet_for,
            codex_turn: slot.codex_turn.clone(),
            conversation,
            pty_id: slot.pty_id(),
            reseeded: slot.reseeded,
        })
    }

    /// A notice in a plan lane's thread ("Codex started a new session…").
    pub(crate) fn plan_notice(&self, key: &ChatKey, text: &str) {
        let Some(slot) = self.inner.slot_for(key) else { return };
        let mut slot = slot.lock();
        let config = self.inner.config_dir.clone();
        let vendor = slot.vendor.unwrap_or(ChatVendor::Claude);
        let mut changed = Vec::new();
        self.inner.push_note(&mut slot, vendor, notice(text, false), &mut changed);
        slot.save(&config, true);
        self.inner.emit_messages(&slot, vendor, changed);
    }

    /// Stop on a plan lane (the Chat's Stop, the same rules).
    pub(crate) fn plan_interrupt(&self, key: &ChatKey) -> Result<(), String> {
        let slot = self.plan_slot(key)?;
        self.interrupt_slot(&slot)
    }

    /// Ends a plan lane's session; its record stays (a Retry resumes it).
    pub(crate) fn plan_end(&self, key: &ChatKey) {
        if let Some(slot) = self.inner.slot_for(key) {
            self.close_slot(&slot);
        }
    }

    /// Ends a plan lane's session and drops its slot (Accept, Discard, the
    /// FIFO cap): its record is in `plan.json`.
    pub(crate) fn plan_drop(&self, key: &ChatKey) {
        let slot = self.inner.slots.lock().map.remove(key);
        if let Some(slot) = slot {
            self.close_slot(&slot);
        }
    }

    /// Whether `pty_id` is a plan lane's hidden Claude: its terminal is
    /// view-only (§6), so the IPC `pty_write`, `pty_resize` and `pty_kill`
    /// refuse it. The driver's own pastes and Esc go through
    /// `PtySessions::write`, which never asks.
    pub(crate) fn is_plan_pty(&self, pty_id: &str) -> bool {
        let slots: Vec<Arc<Mutex<Slot>>> = {
            let slots = self.inner.slots.lock();
            slots.map.iter().filter(|(key, _)| key.is_driven()).map(|(_, slot)| slot.clone()).collect()
        };
        slots.iter().any(|slot| slot.lock().pty_id().as_deref() == Some(pty_id))
    }

    /// A plan lane's Claude screen, for its view-only "Show terminal".
    pub(crate) fn plan_screen(&self, key: &ChatKey) -> Option<ChatScreenSnapshot> {
        let slot = self.inner.slot_for(key)?;
        let slot = slot.lock();
        Self::screen_of(&slot)
    }

    /// The folder of an exchange's lanes (`plan-<id>`), removed with it.
    pub(crate) fn plan_dir(&self, workspace_id: &str, card_id: &str, exchange: &str) -> Result<PathBuf, String> {
        Ok(self.inner.chat_dir_for(workspace_id, card_id)?.join(plan_folder_name(exchange)))
    }

    /// A workspace's Next improvement folder for one area
    /// (`next-improvement/<area>`), every round's lanes under it.
    pub(crate) fn improve_area_dir(&self, workspace_id: &str, area: &str) -> Result<PathBuf, String> {
        Ok(self.inner.workspace_chats_for(workspace_id)?.join(IMPROVE_FOLDER).join(chat_store::safe_component(area, "area")?))
    }

    /// The folder a Next improvement side runs in.
    pub(crate) fn improve_lane_dir(&self, key: &ChatKey) -> Result<PathBuf, String> {
        if !matches!(key.lane, Lane::Improve { .. }) {
            return Err("not a Next improvement lane".into());
        }
        self.inner.lane_dir_for(key)
    }

    /// The folder one plan side runs in.
    #[cfg(test)]
    pub(crate) fn lane_dir(&self, key: &ChatKey) -> Result<PathBuf, String> {
        self.inner.lane_dir_for(key)
    }

    /// Suspends ready sessions idle for [`ChatLimits::idle_after`] (resumed
    /// on the next message).
    pub(crate) fn sweep_idle(&self) {
        // A running exchange's lanes are never suspended (P2): the side
        // that waits sits Ready for as long as the other's turn takes.
        let slots: Vec<Arc<Mutex<Slot>>> = {
            let slots = self.inner.slots.lock();
            slots.map.iter().filter(|(key, _)| !slots.reserved(key)).map(|(_, slot)| slot.clone()).collect()
        };
        for slot in slots {
            let ended = {
                let mut slot = slot.lock();
                if !slot.live() || slot.status != ChatStatus::Ready || slot.last_used.elapsed() < self.inner.limits.idle_after {
                    continue;
                }
                let ended = self.inner.take_proc(&mut slot, ChatStatus::Idle, None);
                self.inner.emit_state(&mut slot);
                ended
            };
            self.inner.end_proc(ended);
        }
    }

    /// Before a session starts for `slot`: with the most sessions running,
    /// the least recently used ready one is suspended; with none ready, the
    /// send is refused.
    ///
    /// A running plan exchange holds [`PLAN_SLOTS`] (P2): its own lanes need
    /// no room, are never suspended, and every other session shares what is
    /// left.
    fn make_room(&self, slot: &Arc<Mutex<Slot>>) -> Result<(), String> {
        let mine = slot.lock().key.clone();
        let (others, reserved) = {
            let slots = self.inner.slots.lock();
            if slots.reserved(&mine) {
                return Ok(());
            }
            let others: Vec<Arc<Mutex<Slot>>> = slots
                .map
                .iter()
                .filter(|(key, other)| !Arc::ptr_eq(other, slot) && !slots.reserved(key))
                .map(|(_, other)| other.clone())
                .collect();
            (others, slots.reservation.is_some())
        };
        let room = self.inner.limits.max_live.saturating_sub(if reserved { PLAN_SLOTS } else { 0 });
        // This session takes one of `room`: the others may keep the rest.
        let freed = if room == 0 { Err(()) } else { self.free_until(&others, room - 1) };
        freed.map_err(|_| {
            if reserved {
                "Two AIs are planning a card now and hold two of Plyloft's AI sessions; the others are answering. Wait for one to finish (or stop one), then send again.".to_string()
            } else {
                format!(
                    "{} chats are answering right now; wait for one to finish (or stop one), then send again.",
                    self.inner.limits.max_live
                )
            }
        })
    }

    /// Suspends the least recently used ready sessions among `others` until
    /// at most `allowed` of them run; `Err` when the ones left all answer.
    fn free_until(&self, others: &[Arc<Mutex<Slot>>], allowed: usize) -> Result<(), ()> {
        loop {
            let mut live = Vec::new();
            for other in others {
                let guard = other.lock();
                if guard.live() {
                    live.push((other.clone(), guard.status, guard.last_used));
                }
            }
            if live.len() <= allowed {
                return Ok(());
            }
            let mut idle: Vec<_> = live.into_iter().filter(|(_, status, _)| *status == ChatStatus::Ready).collect();
            idle.sort_by_key(|(_, _, used)| *used);
            let Some((victim, _, _)) = idle.into_iter().next() else {
                return Err(());
            };
            self.close_slot(&victim);
        }
    }

    /// P2: the two slots of `exchange`'s run, taken before its critic's
    /// lane is live. Refused while another exchange holds them, and with
    /// the "No room" words when the other live sessions all answer and two
    /// can't be freed. Idempotent for the exchange that holds them.
    pub(crate) fn reserve(&self, workspace_id: &str, card_id: &str, exchange: &str) -> Result<(), String> {
        let others: Vec<Arc<Mutex<Slot>>> = {
            let mut slots = self.inner.slots.lock();
            match &slots.reservation {
                Some((ws, card, held)) if ws == workspace_id && card == card_id && held == exchange => return Ok(()),
                Some(_) => return Err("Two AIs are planning another card now. Try again when they finish.".into()),
                None => {}
            }
            // Taken first, so no session starts in the room being made.
            slots.reservation = Some((workspace_id.to_string(), card_id.to_string(), exchange.to_string()));
            slots
                .map
                .iter()
                .filter(|(key, _)| !(key.same_card(workspace_id, card_id) && key.exchange() == Some(exchange)))
                .map(|(_, slot)| slot.clone())
                .collect()
        };
        let allowed = self.inner.limits.max_live.saturating_sub(PLAN_SLOTS);
        if self.free_until(&others, allowed).is_err() {
            self.release(workspace_id, card_id, exchange);
            return Err(NO_ROOM.into());
        }
        Ok(())
    }

    /// The exchange waits for the member, paused or ended: its slots go
    /// back, and its lanes are evictable like ready chats.
    pub(crate) fn release(&self, workspace_id: &str, card_id: &str, exchange: &str) {
        let mut slots = self.inner.slots.lock();
        if slots
            .reservation
            .as_ref()
            .is_some_and(|(ws, card, held)| ws == workspace_id && card == card_id && held == exchange)
        {
            slots.reservation = None;
        }
    }

    pub(crate) fn reservation(&self) -> Option<(String, String, String)> {
        self.inner.slots.lock().reservation.clone()
    }

    #[allow(clippy::too_many_arguments)]
    fn start_claude<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        pty: &crate::pty::PtyRegistry,
        slot: &mut Slot,
        start: &StartSpec,
        prompt: &str,
        message_id: &str,
    ) -> Result<(), String> {
        let config = self.inner.config_dir.clone();
        let program = match &self.inner.overrides.claude {
            Some(program) => program.clone(),
            None => crate::doctor::require("claude")?,
        };
        let key = slot.key.clone();
        let session_dir = self.inner.lane_dir_for(&key)?;
        let reseed = slot.reseed.take();
        let conversation = slot.file_for_change(&config)?.conversation_mut(ChatVendor::Claude, now_ms());
        // A resume needs the transcript: Claude removes old ones
        // (`cleanupPeriodDays`), and then the chat goes on in a new session.
        // 1.179.0: looked for in the folder of the account the session was
        // started on, and resumed there; an account removed since (its
        // folder went with it) has no transcript to resume, so the chat
        // starts afresh, on the account new sessions start on now.
        let previous = conversation.session_id.clone();
        let recorded = conversation.account.clone();
        let resumed_on = crate::ai_accounts::for_resume(app, recorded.as_deref()).ok();
        let transcript = match (previous.as_deref(), &resumed_on) {
            (Some(id), Some(account)) => self
                .inner
                .claude_config(account.as_deref())
                .and_then(|dir| crate::claude_session::find_transcript(&dir, id)),
            _ => None,
        };
        let resumable = transcript.is_some();
        let account = match resumed_on {
            Some(account) if resumable => account,
            _ => crate::ai_accounts::for_new_session(app, crate::coordination::Provider::Claude),
        };
        let claude_config = self.inner.claude_config(account.as_deref());
        let session_id = match (&previous, resumable) {
            (Some(id), true) => id.clone(),
            _ => uuid::Uuid::new_v4().to_string(),
        };
        let mut notes = Vec::new();
        let fresh = previous.is_some() && !resumable;
        let plan_lane = key.is_plan();
        let improve_lane = matches!(key.lane, Lane::Improve { .. });
        if fresh {
            let note = notice(
                if improve_lane {
                    "Claude no longer has this session's earlier messages, so it starts a new session."
                } else if plan_lane {
                    "Claude no longer has this session's earlier messages (its own record of them is gone), so it starts a new session; Plyloft sends it the plan so far."
                } else {
                    "Claude no longer has this chat's earlier messages (its own record of them is gone), so it starts afresh; they are still shown here."
                },
                false,
            );
            conversation.push(note.clone());
            notes.push(note);
        }
        // A plan lane's session that comes back fresh gets the re-seed in
        // place of the turn's message (§3), recorded as sent.
        let mut prompt = prompt.to_string();
        let mut reseeded = false;
        if let (true, Some(reseed)) = (fresh, reseed) {
            if let Some(message) = conversation.message_mut(message_id) {
                message.text = reseed.stored.clone();
            }
            prompt = reseed.claude;
            reseeded = true;
        }
        if !resumable {
            conversation.session_id = Some(session_id.clone());
            conversation.account = account.clone();
            conversation.begin_session();
        }
        conversation.session_dir = Some(session_dir.to_string_lossy().into_owned());
        std::fs::create_dir_all(&session_dir).map_err(|e| format!("create {}: {e}", session_dir.display()))?;
        for dir in &start.make_dirs {
            std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        }
        let positional = start.positional && !resumable;
        let mut args = claude_chat_argv(
            &session_id,
            resumable,
            &start.add_dirs,
            &start.instructions,
            positional.then_some(prompt.as_str()),
            &start.model,
        );
        // A Next improvement proposer reads the web too (E2): the same
        // read-only profile, with WebFetch and WebSearch let in.
        if matches!(key.lane, Lane::Improve { role: PlanRole::Proposer, .. }) {
            args = with_web_reading(args, &start.add_dirs);
        }
        let intent = crate::coordination::SpawnIntent {
            provider: crate::coordination::Provider::Claude,
            // A card's own human-attended conversation, as intake is (a new
            // kind would make an older Plyloft refuse the coordination file).
            execution_kind: crate::coordination::ExecutionKind::Intake,
            attendance: crate::coordination::Attendance::HumanAttended,
            write_intent: crate::coordination::WriteIntent::ReadOnly,
            enforcement: crate::coordination::Enforcement::Advisory,
            project: crate::coordination::SpawnProject::Project {
                workspace_id: key.workspace_id.clone(),
                cwd: session_dir.clone(),
            },
            capability: None,
            card_id: (!improve_lane).then(|| key.card_id.clone()),
            swarm_id: None,
            role_id: None,
            run_id: None,
            retention_class: crate::coordination::RetentionClass::Interactive,
            objective: Some(
                if improve_lane {
                    "next improvement round (read-only)"
                } else if plan_lane {
                    "card plan with two AIs (read-only)"
                } else {
                    "card chat (read-only)"
                }
                .into(),
            ),
            account,
        };
        // What a resumed session's transcript already holds: its first read
        // only catches up, and is no sign the session runs.
        let catch_up = transcript.as_deref().and_then(|path| std::fs::metadata(path).ok()).map_or(0, |m| m.len());
        let capture = Arc::new(Mutex::new(Vec::new()));
        let screen = Arc::new(crate::chat_screen::ChatScreen::new(capture.clone()));
        let reaped = Arc::new(AtomicBool::new(false));
        let exited: Arc<Mutex<Option<Option<i32>>>> = Arc::new(Mutex::new(None));
        let exit_slot = exited.clone();
        let (pty_id, process_id) = pty.spawn_chat(
            app.clone(),
            &program,
            args,
            &session_dir,
            Vec::new(),
            intent,
            capture,
            reaped.clone(),
            Box::new(move |code| *exit_slot.lock() = Some(code)),
            {
                let grid = screen.clone();
                Arc::new(move |rows, cols| grid.set_size(rows, cols))
            },
        )?;
        slot.generation += 1;
        let stop = Arc::new(AtomicBool::new(false));
        slot.proc = Some(Proc::Claude(ClaudeProc {
            pty_id,
            process_id,
            reaped,
            stop: stop.clone(),
            screen: screen.clone(),
            sessions: pty.sessions_handle(),
        }));
        if !positional {
            slot.held = Some((prompt.clone(), message_id.to_string()));
        }
        slot.pending.push_back(Pending { id: message_id.to_string(), pasted_at: None });
        slot.turn_open = false;
        slot.turn_close = TurnClose::Ended;
        slot.composer_idle = false;
        slot.quiet_since = Instant::now();
        slot.last_esc = None;
        slot.reseeded = reseeded;
        slot.save(&config, true);
        self.inner.emit_messages(slot, ChatVendor::Claude, notes);
        self.inner.signal(slot, |key| LaneSignal::SessionStarted { key, fresh });
        let watch = ClaudeWatch {
            inner: Arc::downgrade(&self.inner),
            key,
            generation: slot.generation,
            session_id,
            claude_config,
            catch_up,
            screen,
            exited,
            stop,
            limits: self.inner.limits,
            screen_log: self.inner.overrides.screen_log.clone(),
        };
        std::thread::spawn(move || watch.run());
        Ok(())
    }

    fn start_codex(
        &self,
        slot: &mut Slot,
        start: &StartSpec,
        input: serde_json::Value,
        message_id: &str,
    ) -> Result<(), String> {
        let config = self.inner.config_dir.clone();
        let program = match &self.inner.overrides.codex {
            Some(program) => program.clone(),
            None => crate::doctor::require("codex")?,
        };
        let key = slot.key.clone();
        // The lane's plain folder, not the worktree: Codex reaches the
        // project by its path (the instructions name it).
        let cwd = self.inner.lane_dir_for(&key)?;
        std::fs::create_dir_all(&cwd).map_err(|e| format!("create {}: {e}", cwd.display()))?;
        for dir in &start.make_dirs {
            std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        }
        let thread_id = slot.file(&config)?.conversation(ChatVendor::Codex).and_then(|c| c.session_id.clone());
        let session_key = codex_session_key(&key);
        slot.generation += 1;
        let generation = slot.generation;
        let weak = Arc::downgrade(&self.inner);
        let sink_key = key.clone();
        let sink: CodexAppSink = Arc::new(move |_session: &str, _pid: u32, event: CodexAppEvent| {
            if let Some(inner) = weak.upgrade() {
                inner.on_codex(&sink_key, generation, event);
            }
        });
        let codex_home = self.inner.overrides.codex_home.clone().unwrap_or_else(crate::codex_home::real_codex_home);
        self.inner.codex.start_with(&session_key, &cwd, &program, sink)?;
        slot.proc = Some(Proc::Codex(CodexProc {
            session_key: session_key.clone(),
            phase: CodexPhase::Initializing,
            thread_id,
            turn_id: None,
            next_id: CODEX_FIRST_TURN_ID,
            turn_request: None,
            first_turn: Some((input, message_id.to_string())),
            interrupt_wanted: false,
            cwd,
            instructions: start.instructions.clone(),
            config: codex_chat_config(&codex_home),
            model: start.model.clone(),
            last_stderr: None,
        }));
        self.inner.codex.write(
            &session_key,
            &serde_json::json!({
                "id": CODEX_INITIALIZE,
                "method": "initialize",
                "params": {
                    "clientInfo": {"name": "ply", "title": "Plyloft", "version": env!("CARGO_PKG_VERSION")},
                    "capabilities": {"experimentalApi": true}
                }
            }),
        )
    }

    /// Quit (Hard rule 4): every chat session ends, and none starts after.
    pub fn kill_all(&self) {
        self.inner.closed.store(true, Ordering::SeqCst);
        let slots: Vec<Arc<Mutex<Slot>>> = self.inner.slots.lock().map.values().cloned().collect();
        let mut ended = Vec::new();
        for slot in slots {
            let mut slot = slot.lock();
            ended.push(self.inner.take_proc(&mut slot, ChatStatus::Idle, None));
            let config = self.inner.config_dir.clone();
            slot.save(&config, true);
        }
        // At once: each Claude session gets its hangup grace in parallel.
        let threads: Vec<_> = ended
            .into_iter()
            .flatten()
            .map(|proc| {
                let inner = self.inner.clone();
                std::thread::spawn(move || inner.end_proc(Some(proc)))
            })
            .collect();
        for thread in threads {
            let _ = thread.join();
        }
        self.inner.codex.kill_all();
    }

    /// A deleted card's chat: its session ends, and its record, attachments
    /// and chat folder are removed; nothing is stored for it again.
    pub(crate) fn forget_card(&self, workspace_id: &str, card_id: &str) {
        let Ok(card_dir) = chat_store::card_dir(&self.inner.config_dir, workspace_id, card_id) else {
            return;
        };
        // Every lane: the Chat and both sides of any plan exchange.
        let (chat, plans) = {
            let mut slots = self.inner.slots.lock();
            slots.forgotten_cards.insert((workspace_id.to_string(), card_id.to_string()));
            if slots.reservation.as_ref().is_some_and(|(ws, card, _)| ws == workspace_id && card == card_id) {
                slots.reservation = None;
            }
            let keys: Vec<ChatKey> = slots.map.keys().filter(|k| k.same_card(workspace_id, card_id)).cloned().collect();
            let mut chat = None;
            let mut plans = Vec::new();
            for key in keys {
                let slot = slots.map.remove(&key);
                if key.is_plan() {
                    plans.extend(slot);
                } else {
                    chat = slot;
                }
            }
            (chat, plans)
        };
        for plan in plans {
            self.forget_slot(Some(plan), [None, None]);
        }
        // The chat folder holds the `plan-*` folders too.
        let chat_folder = self.inner.chat_dir_for(workspace_id, card_id).ok();
        self.forget_slot(chat, [Some(card_dir), chat_folder]);
    }

    /// A deleted workspace's chats: every session ends, and every card's
    /// record, attachments and chat folder are removed. On a thread of its
    /// own (`workspace_delete` runs on the main thread); nothing is stored
    /// for the workspace from now on.
    pub(crate) fn forget_workspace(&self, workspace_id: &str) -> std::thread::JoinHandle<()> {
        let slots: Vec<Arc<Mutex<Slot>>> = {
            let mut slots = self.inner.slots.lock();
            slots.forgotten_workspaces.insert(workspace_id.to_string());
            if slots.reservation.as_ref().is_some_and(|(ws, _, _)| ws == workspace_id) {
                slots.reservation = None;
            }
            let keys: Vec<ChatKey> = slots.map.keys().filter(|k| k.workspace_id == workspace_id).cloned().collect();
            keys.iter().filter_map(|key| slots.map.remove(key)).collect()
        };
        let registry = self.clone();
        let config = self.inner.config_dir.clone();
        let workspace_id = workspace_id.to_string();
        std::thread::spawn(move || {
            for slot in slots {
                registry.forget_slot(Some(slot), [None, None]);
            }
            let cards = chat_store::safe_component(&workspace_id, "workspace")
                .ok()
                .map(|ws| config.join("projects").join(ws).join("cards"));
            for dir in [cards, registry.inner.workspace_chats_for(&workspace_id).ok()].into_iter().flatten() {
                remove_dir(&dir);
            }
        })
    }

    fn forget_slot(&self, slot: Option<Arc<Mutex<Slot>>>, dirs: [Option<PathBuf>; 2]) {
        if let Some(slot) = slot {
            let ended = {
                let mut slot = slot.lock();
                slot.forgotten = true;
                slot.unsaved = false;
                self.inner.take_proc(&mut slot, ChatStatus::Idle, None)
            };
            self.inner.end_proc(ended);
            // Under the card's lock: an attachment being stored either
            // finished before, or sees `forgotten` and writes nothing.
            let _held = slot.lock();
            for dir in dirs.iter().flatten() {
                remove_dir(dir);
            }
            return;
        }
        for dir in dirs.iter().flatten() {
            remove_dir(dir);
        }
    }

    // ── Attachments ────────────────────────────────────────────────

    /// Stores an attachment on the card. The file is checked and its text
    /// read (a PDF in a child process) without the card's lock; then, under
    /// it, the card's cap is checked and the file written — never for a card
    /// deleted meanwhile.
    pub(crate) fn attachment_add(&self, workspace_id: &str, card_id: &str, name: &str, bytes: &[u8]) -> Result<Attachment, String> {
        let slot = self.slot(workspace_id, card_id)?;
        let config = self.inner.config_dir.clone();
        let prepared = chat_attachments::prepare(name, bytes)?;
        let mut slot = slot.lock();
        if slot.forgotten {
            return Err(DELETED.into());
        }
        let dir = chat_store::attachments_dir(&slot.card_dir(&config)?);
        let count = slot.file_for_change(&config)?.attachments.len();
        if count >= chat_attachments::MAX_ATTACHMENTS_PER_CARD {
            return Err(format!(
                "A card keeps at most {} attachments; remove one first.",
                chat_attachments::MAX_ATTACHMENTS_PER_CARD
            ));
        }
        let attachment = chat_attachments::commit(&dir, prepared, bytes, now_ms())?;
        slot.file_for_change(&config)?.attachments.push(attachment.clone());
        slot.save(&config, true);
        Ok(attachment)
    }

    pub(crate) fn attachment_list(&self, workspace_id: &str, card_id: &str) -> Result<Vec<Attachment>, String> {
        let slot = self.slot(workspace_id, card_id)?;
        let mut slot = slot.lock();
        let config = self.inner.config_dir.clone();
        Ok(slot.file(&config)?.attachments.clone())
    }

    /// Removes an attachment from the card and its files from disk. Messages
    /// that carried it keep its id (their chip says it is gone).
    pub(crate) fn attachment_remove(&self, workspace_id: &str, card_id: &str, attachment_id: &str) -> Result<(), String> {
        let slot = self.slot(workspace_id, card_id)?;
        let mut slot = slot.lock();
        let config = self.inner.config_dir.clone();
        let dir = chat_store::attachments_dir(&slot.card_dir(&config)?);
        let file = slot.file_for_change(&config)?;
        let Some(index) = file.attachments.iter().position(|a| a.id == attachment_id) else {
            return Ok(());
        };
        let removed = file.attachments.remove(index);
        slot.save(&config, true);
        chat_attachments::remove_files(&dir, &removed);
        Ok(())
    }

    /// The live Claude session's PTY id and its screen as escape sequences
    /// that redraw it: "Show terminal"'s first paint (part 2), before it
    /// follows `pty://data`.
    pub(crate) fn screen_snapshot(&self, workspace_id: &str, card_id: &str) -> Result<Option<ChatScreenSnapshot>, String> {
        let slot = self.slot(workspace_id, card_id)?;
        let slot = slot.lock();
        Ok(Self::screen_of(&slot))
    }

    fn screen_of(slot: &Slot) -> Option<ChatScreenSnapshot> {
        match &slot.proc {
            Some(Proc::Claude(claude)) => {
                let state = claude.screen.state();
                Some(ChatScreenSnapshot {
                    pty_id: claude.pty_id.clone(),
                    formatted: String::from_utf8_lossy(&state.formatted).into_owned(),
                    offset: state.offset,
                    rows: state.rows,
                    cols: state.cols,
                })
            }
            _ => None,
        }
    }

    #[cfg(all(test, unix))]
    fn status_of(&self, workspace_id: &str, card_id: &str) -> (ChatStatus, Option<String>) {
        let slot = self.slot(workspace_id, card_id).unwrap();
        let slot = slot.lock();
        (slot.status, slot.reason.clone())
    }

    #[cfg(all(test, unix))]
    fn attention_of(&self, workspace_id: &str, card_id: &str) -> Option<String> {
        self.slot(workspace_id, card_id).unwrap().lock().attention.clone()
    }

    #[cfg(all(test, unix))]
    fn live_count(&self) -> usize {
        self.inner.slots.lock().map.values().filter(|slot| slot.lock().live()).count()
    }

    #[cfg(all(test, unix))]
    fn screen_size_of(&self, workspace_id: &str, card_id: &str) -> Option<(u16, u16)> {
        match &self.slot(workspace_id, card_id).ok()?.lock().proc {
            Some(Proc::Claude(claude)) => Some(claude.screen.size()),
            _ => None,
        }
    }

    #[cfg(all(test, unix))]
    fn session_id_of(&self, workspace_id: &str, card_id: &str) -> Option<String> {
        let config = self.inner.config_dir.clone();
        let slot = self.slot(workspace_id, card_id).ok()?;
        let mut slot = slot.lock();
        slot.file(&config).ok()?.conversation(ChatVendor::Claude)?.session_id.clone()
    }

    /// The live Claude session's pid (the live test's no-orphan check).
    #[cfg(all(test, unix))]
    fn claude_pid(&self, workspace_id: &str, card_id: &str) -> Option<u32> {
        match &self.slot(workspace_id, card_id).ok()?.lock().proc {
            Some(Proc::Claude(claude)) => claude.process_id,
            _ => None,
        }
    }
}

/// A screen decision, its rows framed, appended to `log` (if any).
fn log_screen_to(log: Option<&Path>, what: &str, rows: &[String]) {
    use std::io::Write as _;
    let Some(log) = log else { return };
    let mut text = format!(
        "\n=== {} ms · {what} · composer_idle={} drawn_last={} menu={} blocker={:?}\n",
        now_ms(),
        crate::chat_screen::composer_idle(rows),
        crate::chat_screen::composer_drawn_last(rows),
        crate::chat_screen::menu_waiting(rows),
        crate::chat_screen::blocker(rows),
    );
    for (index, row) in rows.iter().enumerate() {
        text.push_str(&format!("{index:>2}|{row}\n"));
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(log) {
        let _ = file.write_all(text.as_bytes());
    }
}

fn remove_dir(dir: &Path) {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => log::warn!("chat: remove {}: {error}", dir.display()),
    }
}

impl Inner {
    fn workspace_chats_for(&self, workspace_id: &str) -> Result<PathBuf, String> {
        match &self.overrides.chat_root {
            Some(root) => Ok(root.join(chat_store::safe_component(workspace_id, "workspace")?)),
            None => workspace_chats_dir(&self.config_dir, workspace_id),
        }
    }

    fn chat_dir_for(&self, workspace_id: &str, card_id: &str) -> Result<PathBuf, String> {
        Ok(self.workspace_chats_for(workspace_id)?.join(chat_store::safe_component(card_id, "card")?))
    }

    /// Where a lane's session runs: the card's chat folder for the Chat,
    /// `plan-<id>/<role>` inside it for a plan side — one folder per role,
    /// so two Claude sessions never share a project folder (and never
    /// follow each other's transcripts), nor two Codex sessions a cwd.
    fn lane_dir_for(&self, key: &ChatKey) -> Result<PathBuf, String> {
        if let Lane::Improve { area, round, role } = &key.lane {
            return Ok(self
                .workspace_chats_for(&key.workspace_id)?
                .join(IMPROVE_FOLDER)
                .join(chat_store::safe_component(area, "area")?)
                .join(improve_folder_name(round))
                .join(role.as_str()));
        }
        let card = self.chat_dir_for(&key.workspace_id, &key.card_id)?;
        Ok(match &key.lane {
            Lane::Plan { exchange, role } => card.join(plan_folder_name(exchange)).join(role.as_str()),
            _ => card,
        })
    }

    /// Every slot status change goes through here (one choke point, §3):
    /// leaving `Working` or `Starting` tells a plan lane's driver its turn
    /// ended. Moves *into* `Working` (a send) may assign directly.
    fn set_status(&self, slot: &mut Slot, status: ChatStatus) {
        let before = slot.status;
        slot.status = status;
        self.turn_ended(slot, before);
    }

    fn turn_ended(&self, slot: &Slot, before: ChatStatus) {
        let ended = matches!(before, ChatStatus::Working | ChatStatus::Starting)
            && !matches!(slot.status, ChatStatus::Working | ChatStatus::Starting);
        if ended {
            let (vendor, status, reason, turn_close) =
                (slot.vendor.unwrap_or(ChatVendor::Claude), slot.status, slot.reason.clone(), slot.turn_close);
            self.signal(slot, |key| LaneSignal::TurnEnded { key, vendor, status, reason, turn_close });
        }
    }

    /// A plan lane's signal to its driver; the Chat lane sends none.
    fn signal(&self, slot: &Slot, make: impl FnOnce(ChatKey) -> LaneSignal) {
        if slot.plan.is_none() || slot.forgotten {
            return;
        }
        if let Some(listener) = self.listener.get() {
            listener(make(slot.key.clone()));
        }
    }

    /// Appends a screen decision to the screen log, when there is one.
    fn log_screen(&self, what: &str, rows: &[String]) {
        log_screen_to(self.overrides.screen_log.as_deref(), what, rows);
    }

    /// 1.179.0: the folder of the Claude account a chat session runs on.
    /// Main is the tests' override, else Main's own folder.
    fn claude_config(&self, account: Option<&str>) -> Option<PathBuf> {
        match account {
            None => self.overrides.claude_config.clone().or_else(|| crate::ai_accounts::claude_dir(None)),
            Some(_) => crate::ai_accounts::claude_dir(account),
        }
    }

    fn emit(&self, event: &str, payload: impl Serialize) {
        if let (Some(emitter), Ok(value)) = (self.emitter.get(), serde_json::to_value(payload)) {
            emitter(event, value);
        }
    }

    fn emit_state(&self, slot: &mut Slot) {
        if slot.plan.is_some() {
            // A plan lane's state is its exchange's: the driver emits
            // `plan://state` (never `chat://state`, which the card's Chat
            // would take for its own).
            self.signal(slot, |key| LaneSignal::State { key });
            return;
        }
        let config = self.config_dir.clone();
        let vendor = slot.vendor.unwrap_or(ChatVendor::Claude);
        let usage = slot
            .file(&config)
            .ok()
            .and_then(|file| file.conversation(vendor).map(|c| c.usage.clone()))
            .unwrap_or_default();
        self.emit(
            STATE_EVENT,
            ChatStateEvent {
                workspace_id: slot.key.workspace_id.clone(),
                card_id: slot.key.card_id.clone(),
                vendor,
                status: slot.status,
                reason: slot.reason.clone(),
                attention: slot.attention.clone(),
                usage,
                pty_id: slot.pty_id(),
            },
        );
    }

    fn emit_messages(&self, slot: &Slot, vendor: ChatVendor, messages: Vec<ChatMessage>) {
        if messages.is_empty() {
            return;
        }
        // A Next improvement lane's messages are its round's: nothing shows
        // them as a thread, so none is emitted.
        if matches!(slot.key.lane, Lane::Improve { .. }) {
            return;
        }
        if let Lane::Plan { exchange, role } = &slot.key.lane {
            if slot.forgotten {
                return;
            }
            self.emit(
                PLAN_MESSAGES_EVENT,
                serde_json::json!({
                    "workspaceId": slot.key.workspace_id,
                    "cardId": slot.key.card_id,
                    "exchangeId": exchange,
                    "role": role,
                    "vendor": vendor,
                    "messages": messages,
                }),
            );
            return;
        }
        self.emit(
            MESSAGES_EVENT,
            ChatMessagesEvent {
                workspace_id: slot.key.workspace_id.clone(),
                card_id: slot.key.card_id.clone(),
                vendor,
                messages,
            },
        );
    }

    /// Takes the slot's session out (to be ended by [`Inner::end_proc`],
    /// outside the slot's lock), leaving `status`.
    /// Ends the slot's session (the caller ends the process outside the
    /// lock, and saves: an answer the session was streaming is marked
    /// finished here, and emitted).
    fn take_proc(&self, slot: &mut Slot, status: ChatStatus, reason: Option<String>) -> Option<Proc> {
        if let Some(vendor) = slot.proc.as_ref().map(Proc::vendor) {
            let config = self.config_dir.clone();
            let streaming = slot.file(&config).ok().and_then(|file| file.conversation(vendor)).is_some_and(
                |conversation| conversation.messages.iter().any(|m| m.role == "assistant" && !m.done),
            );
            if streaming {
                if let Some(conversation) = slot.conversation(&config, vendor) {
                    let finished = finish_streaming(&mut conversation.messages);
                    for message in &finished {
                        slot.stream.remove(&message.id);
                    }
                    self.emit_messages(slot, vendor, finished);
                }
            }
        }
        slot.generation += 1;
        let before = slot.status;
        slot.status = status;
        slot.reason = reason;
        slot.attention = None;
        slot.pending.clear();
        slot.held = None;
        slot.reseed = None;
        slot.turn_open = false;
        slot.composer_idle = false;
        // Only a turn under way ends here: a session ended Ready or Idle
        // (the idle sweep, room made, a vendor switch, close) sends nothing.
        self.turn_ended(slot, before);
        let proc = slot.proc.take();
        if let Some(Proc::Claude(claude)) = &proc {
            claude.stop.store(true, Ordering::SeqCst);
        }
        proc
    }

    /// The messages still waiting for their echo are marked not sent
    /// (`isError` on a user message): a session that stopped took them with
    /// it. Returns them, changed.
    fn fail_pending(&self, slot: &mut Slot, vendor: ChatVendor) -> Vec<ChatMessage> {
        let config = self.config_dir.clone();
        let ids: Vec<String> = slot.pending.iter().map(|p| p.id.clone()).collect();
        let mut changed = Vec::new();
        if let Some(conversation) = slot.conversation(&config, vendor) {
            for id in ids {
                if let Some(message) = conversation.message_mut(&id) {
                    message.is_error = true;
                    changed.push(message.clone());
                }
            }
        }
        changed
    }

    fn end_proc(&self, proc: Option<Proc>) {
        match proc {
            Some(Proc::Claude(claude)) => claude.sessions.end(&claude.pty_id, claude.process_id, &claude.reaped),
            Some(Proc::Codex(codex)) => self.codex.stop(&codex.session_key),
            None => {}
        }
    }

    fn slot_for(&self, key: &ChatKey) -> Option<Arc<Mutex<Slot>>> {
        self.slots.lock().map.get(key).cloned()
    }

    fn push_note(&self, slot: &mut Slot, vendor: ChatVendor, note: ChatMessage, changed: &mut Vec<ChatMessage>) {
        let config = self.config_dir.clone();
        if let Some(conversation) = slot.conversation(&config, vendor) {
            conversation.push(note.clone());
        }
        changed.push(note);
    }

    // ── Claude ─────────────────────────────────────────────────────

    /// What a Claude chat's watcher read this poll.
    fn on_claude(self: &Arc<Self>, key: &ChatKey, generation: u64, read: ClaudeRead) {
        let Some(slot) = self.slot_for(key) else { return };
        let ended = {
            let mut slot = slot.lock();
            if slot.generation != generation {
                return;
            }
            let config = self.config_dir.clone();
            let mut changed = Vec::new();
            if let Some(id) = &read.switched {
                if let Some(conversation) = slot.conversation(&config, ChatVendor::Claude) {
                    conversation.session_id = Some(id.clone());
                    conversation.begin_session();
                }
                let note = notice(
                    "Claude's terminal moved to another conversation (/clear or /resume there); the chat follows it from here.",
                    false,
                );
                self.push_note(&mut slot, ChatVendor::Claude, note, &mut changed);
            }
            if read.stuck {
                let note = notice(
                    "Claude went back to its prompt without saying it had finished; the chat treats this answer as done.",
                    false,
                );
                self.push_note(&mut slot, ChatVendor::Claude, note, &mut changed);
            }
            if !read.items.is_empty() || read.usage_changed {
                let mut pending = std::mem::take(&mut slot.pending);
                if let Some(conversation) = slot.conversation(&config, ChatVendor::Claude) {
                    changed.extend(merge_claude(conversation, &read.items, &mut pending));
                    conversation.set_session_usage(read.usage.clone());
                    conversation.updated_at = now_ms();
                }
                slot.pending = pending;
            }
            if read.grew {
                slot.last_used = Instant::now();
            }
            slot.turn_open = read.turn_open;
            slot.turn_close = read.turn_close;
            slot.composer_idle = read.composer_idle;
            slot.quiet_since = Instant::now().checked_sub(read.quiet_for).unwrap_or_else(Instant::now);
            // A resumed session's message, pasted once its composer is idle.
            if read.stop.is_none() && read.exited.is_none() && read.composer_idle && !read.turn_open {
                if let Some((prompt, id)) = slot.held.take() {
                    let sent = match &slot.proc {
                        Some(Proc::Claude(claude)) => claude.sessions.write(&claude.pty_id, &paste_bytes(&prompt)),
                        _ => Err("no session".into()),
                    };
                    match sent {
                        Ok(()) => {
                            for pending in slot.pending.iter_mut().filter(|p| p.id == id) {
                                pending.pasted_at = Some(Instant::now());
                            }
                        }
                        Err(error) => log::warn!("chat {}/{}: paste: {error}", key.workspace_id, key.card_id),
                    }
                }
            }
            // A paste the transcript never shows: reported, not waited on
            // for ever.
            let echo_timeout = self.limits.echo_timeout;
            let lost: Vec<String> = slot
                .pending
                .iter()
                .filter(|p| p.pasted_at.is_some_and(|at| at.elapsed() >= echo_timeout))
                .map(|p| p.id.clone())
                .collect();
            if !lost.is_empty() && !read.grew {
                slot.pending.retain(|p| !lost.contains(&p.id));
                if let Some(conversation) = slot.conversation(&config, ChatVendor::Claude) {
                    for id in &lost {
                        if let Some(message) = conversation.message_mut(id) {
                            message.is_error = true;
                            changed.push(message.clone());
                        }
                    }
                }
                let note = notice(
                    "Claude didn't take this message (it never reached its conversation). Send it again, or look at Claude's screen.",
                    true,
                );
                self.push_note(&mut slot, ChatVendor::Claude, note, &mut changed);
            }
            let before = (slot.status, slot.attention.clone(), slot.reason.clone());
            let mut ended = None;
            if let Some(reason) = read.stop.clone().or_else(|| {
                read.exited.map(|code| {
                    let mut reason = match code {
                        Some(code) => format!("Claude stopped (exit code {code})."),
                        None => "Claude stopped.".to_string(),
                    };
                    if !read.screen_tail.is_empty() {
                        reason.push_str(&format!(" Its screen last showed: {}", read.screen_tail));
                    }
                    reason
                })
            }) {
                changed.extend(self.fail_pending(&mut slot, ChatVendor::Claude));
                // Ended outside the lock — after its own exit too: what it
                // started may still hold its group.
                ended = self.take_proc(&mut slot, ChatStatus::Stopped, Some(reason.clone()));
                self.push_note(&mut slot, ChatVendor::Claude, notice(&reason, true), &mut changed);
            } else {
                slot.attention = read.attention;
                let status = if read.turn_open || !slot.pending.is_empty() { ChatStatus::Working } else { ChatStatus::Ready };
                self.set_status(&mut slot, status);
            }
            // No turn runs: an answer still marked streaming (stopped with
            // Esc, its turn closed) is finished — and saved so. Looked for
            // only when a turn may just have ended (the poll before was
            // working, or this one brought a streaming answer); a session's
            // end finishes its answers in `take_proc`.
            let may_stream = before.0 == ChatStatus::Working
                || changed.iter().any(|m| m.role == "assistant" && !m.done);
            if may_stream && slot.status != ChatStatus::Working {
                if let Some(conversation) = slot.conversation(&config, ChatVendor::Claude) {
                    changed.extend(finish_streaming(&mut conversation.messages));
                }
            }
            let force = slot.status != before.0
                || changed.iter().any(|m| matches!(m.role.as_str(), "user" | "notice" | "interrupted" | "shell"))
                || changed.iter().any(|m| m.role == "assistant" && m.done);
            slot.save(&config, force);
            // As stored: a stop this poll (`take_proc`) finished an answer
            // this poll's merge copied still streaming.
            stored_copies(&mut slot, &config, ChatVendor::Claude, &mut changed);
            self.emit_messages(&slot, ChatVendor::Claude, changed);
            if (slot.status, slot.attention.clone(), slot.reason.clone()) != before || read.usage_changed {
                self.emit_state(&mut slot);
            }
            ended
        };
        self.end_proc(ended);
    }

    // ── Codex ──────────────────────────────────────────────────────

    fn codex_write(&self, codex: &CodexProc, message: serde_json::Value) {
        if let Err(error) = self.codex.write(&codex.session_key, &message) {
            log::warn!("chat codex {}: write: {error}", codex.session_key);
        }
    }

    fn codex_thread_params(codex: &CodexProc) -> serde_json::Value {
        codex_thread_params_for(&codex.cwd, &codex.instructions, &codex.config, &codex.model)
    }

    /// A turn with `input` on the slot's ready thread, for message `id`.
    fn codex_turn(&self, slot: &mut Slot, input: serde_json::Value, id: &str) -> Result<(), String> {
        let Some(Proc::Codex(codex)) = &mut slot.proc else {
            return Err("Codex isn't running for this chat.".into());
        };
        let thread = codex.thread_id.clone().ok_or("Codex has no thread for this chat yet.")?;
        let request = codex.next_id;
        codex.next_id += 1;
        codex.turn_request = Some(request);
        self.codex.write(
            &codex.session_key,
            &serde_json::json!({
                "id": request,
                "method": "turn/start",
                "params": {
                    "threadId": thread,
                    "input": input,
                    "approvalPolicy": "never",
                    "sandboxPolicy": {"type": "readOnly", "networkAccess": false},
                    // Echoed as the user message item's `clientId`: what
                    // Plyloft's own copy matches it by.
                    "clientUserMessageId": id,
                }
            }),
        )
    }

    fn on_codex(self: &Arc<Self>, key: &ChatKey, generation: u64, event: CodexAppEvent) {
        let Some(slot) = self.slot_for(key) else { return };
        let ended: Option<Proc>;
        {
            let mut slot = slot.lock();
            if slot.generation != generation {
                return;
            }
            let config = self.config_dir.clone();
            let before = (slot.status, slot.reason.clone());
            let mut changed: Vec<ChatMessage> = Vec::new();
            let mut usage_changed = false;
            let mut force_save = false;
            match event {
                CodexAppEvent::Stderr(text) => {
                    if let Some(Proc::Codex(codex)) = &mut slot.proc {
                        codex.last_stderr = Some(text.chars().take(500).collect());
                    }
                    return;
                }
                CodexAppEvent::Exit(code) => {
                    let last = match &slot.proc {
                        Some(Proc::Codex(codex)) => codex.last_stderr.clone(),
                        _ => None,
                    };
                    let mut reason = match code {
                        Some(code) => format!("Codex stopped (exit code {code})."),
                        None => "Codex stopped.".to_string(),
                    };
                    if let Some(last) = last {
                        reason.push_str(&format!(" It last said: {last}"));
                    }
                    changed.extend(self.fail_pending(&mut slot, ChatVendor::Codex));
                    // Its process group, should anything it started be left.
                    ended = self.take_proc(&mut slot, ChatStatus::Stopped, Some(reason.clone()));
                    self.push_note(&mut slot, ChatVendor::Codex, notice(&reason, true), &mut changed);
                    force_save = true;
                }
                CodexAppEvent::Message(message) => {
                    ended = self.codex_message(&mut slot, &message, &mut changed, &mut usage_changed, &mut force_save);
                }
            }
            // As stored (an exit's `take_proc` finished what streamed).
            stored_copies(&mut slot, &config, ChatVendor::Codex, &mut changed);
            // Streamed text is emitted at most every STREAM_EMIT_EVERY;
            // anything else (and the end of a message) at once, with what
            // streamed.
            let streaming_only = !changed.is_empty() && changed.iter().all(|m| m.role == "assistant" && !m.done);
            for message in changed.drain(..).collect::<Vec<_>>() {
                if message.role == "assistant" && !message.done {
                    slot.stream.insert(message.id.clone(), message);
                } else {
                    slot.stream.remove(&message.id);
                    changed.push(message);
                }
            }
            if !streaming_only || slot.last_stream_emit.elapsed() >= STREAM_EMIT_EVERY {
                let mut streamed: Vec<ChatMessage> = slot.stream.drain().map(|(_, m)| m).collect();
                streamed.extend(changed);
                changed = streamed;
                slot.last_stream_emit = Instant::now();
            }
            let force = force_save || slot.status != before.0;
            slot.save(&config, force);
            self.emit_messages(&slot, ChatVendor::Codex, changed);
            if (slot.status, slot.reason.clone()) != before || usage_changed {
                self.emit_state(&mut slot);
            }
        }
        // From the App Server's own reader thread: the stop only signals.
        if let Some(Proc::Codex(codex)) = ended {
            let registry = self.codex.clone();
            std::thread::spawn(move || registry.stop(&codex.session_key));
        }
    }

    /// One App Server message. Returns a session to end (outside the lock).
    fn codex_message(
        &self,
        slot: &mut Slot,
        message: &serde_json::Value,
        changed: &mut Vec<ChatMessage>,
        usage_changed: &mut bool,
        force_save: &mut bool,
    ) -> Option<Proc> {
        let config = self.config_dir.clone();
        let method = message.get("method").and_then(|m| m.as_str());
        let id = message.get("id").and_then(|id| id.as_u64());
        let params = message.get("params").cloned().unwrap_or(serde_json::Value::Null);
        // A request from the server (an approval, a question): nobody can
        // grant anything in a read-only chat, and `approvalPolicy: never`
        // means none should come. Refused, and said.
        if let (Some(method), Some(raw_id)) = (method, message.get("id")) {
            if let Some(Proc::Codex(codex)) = &slot.proc {
                self.codex_write(
                    codex,
                    serde_json::json!({"id": raw_id, "error": {"code": -32601, "message": "Plyloft's card chat is read-only; it grants nothing."}}),
                );
            }
            let note = notice(&format!("Codex asked for something a read-only chat can't give ({method}); Plyloft refused it."), false);
            self.push_note(slot, ChatVendor::Codex, note, changed);
            return None;
        }
        if method.is_none() {
            // A response to one of Plyloft's requests.
            let error = message.get("error").map(|e| {
                e.get("message").and_then(|m| m.as_str()).map(str::to_string).unwrap_or_else(|| e.to_string())
            });
            let result = message.get("result").cloned().unwrap_or(serde_json::Value::Null);
            let thread_of = |result: &serde_json::Value| {
                result.get("thread").and_then(|t| t.get("id")).and_then(|id| id.as_str()).map(str::to_string)
            };
            match id {
                Some(CODEX_INITIALIZE) => {
                    if let Some(error) = error {
                        return self.codex_fail(slot, &format!("Codex refused to start the chat: {error}"), changed);
                    }
                    let Some(Proc::Codex(codex)) = &mut slot.proc else { return None };
                    codex.phase = CodexPhase::Thread;
                    self.codex_write(codex, serde_json::json!({"method": "initialized"}));
                    let mut params = Self::codex_thread_params(codex);
                    match codex.thread_id.clone() {
                        Some(thread) => {
                            params["threadId"] = serde_json::json!(thread);
                            self.codex_write(codex, serde_json::json!({"id": CODEX_THREAD_RESUME, "method": "thread/resume", "params": params}));
                        }
                        None => {
                            params["ephemeral"] = serde_json::json!(false);
                            self.codex_write(codex, serde_json::json!({"id": CODEX_THREAD_START, "method": "thread/start", "params": params}));
                        }
                    }
                }
                Some(CODEX_THREAD_RESUME) => match (error, thread_of(&result)) {
                    (None, Some(thread)) => return self.codex_thread_ready(slot, thread, false, changed),
                    _ => {
                        let note = notice(
                            "Codex couldn't resume this chat's earlier session, so it starts afresh; the earlier messages are still shown here.",
                            false,
                        );
                        self.push_note(slot, ChatVendor::Codex, note, changed);
                        let Some(Proc::Codex(codex)) = &mut slot.proc else { return None };
                        let mut params = Self::codex_thread_params(codex);
                        params["ephemeral"] = serde_json::json!(false);
                        self.codex_write(codex, serde_json::json!({"id": CODEX_THREAD_START, "method": "thread/start", "params": params}));
                    }
                },
                Some(CODEX_THREAD_START) => {
                    return match (error, thread_of(&result)) {
                        (None, Some(thread)) => self.codex_thread_ready(slot, thread, true, changed),
                        (error, _) => self.codex_fail(
                            slot,
                            &format!("Codex couldn't start a chat thread: {}", error.unwrap_or_else(|| "no thread id".into())),
                            changed,
                        ),
                    };
                }
                Some(other) => {
                    let turn = matches!(&slot.proc, Some(Proc::Codex(codex)) if codex.turn_request == Some(other));
                    if let (true, Some(error)) = (turn, error) {
                        changed.extend(self.fail_pending(slot, ChatVendor::Codex));
                        slot.pending.clear();
                        self.push_note(slot, ChatVendor::Codex, notice(&format!("Codex refused the message: {error}"), true), changed);
                        slot.codex_turn = Some(format!("refused: {error}"));
                        self.set_status(slot, ChatStatus::Ready);
                        *force_save = true;
                    }
                }
                None => {}
            }
            return None;
        }
        let item = params.get("item").cloned().unwrap_or(serde_json::Value::Null);
        let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match method.unwrap_or("") {
            "turn/started" => {
                if let Some(Proc::Codex(codex)) = &mut slot.proc {
                    codex.turn_id = params.get("turn").and_then(|t| t.get("id")).and_then(|id| id.as_str()).map(str::to_string);
                    // Stop pressed before the turn had an id.
                    if std::mem::take(&mut codex.interrupt_wanted) {
                        if let (Some(thread), Some(turn)) = (codex.thread_id.clone(), codex.turn_id.clone()) {
                            let request = codex.next_id;
                            codex.next_id += 1;
                            self.codex_write(
                                codex,
                                serde_json::json!({"id": request, "method": "turn/interrupt", "params": {"threadId": thread, "turnId": turn}}),
                            );
                        }
                    }
                }
                slot.status = ChatStatus::Working;
            }
            "item/started" | "item/completed" if item_type == "userMessage" => {
                // By the id Plyloft gave it (`clientUserMessageId`), else the
                // oldest one waiting.
                let client = item.get("clientId").and_then(|v| v.as_str()).map(str::to_string);
                let index = match &client {
                    Some(client) => slot.pending.iter().position(|p| &p.id == client),
                    None => (!slot.pending.is_empty()).then_some(0),
                };
                if let Some(pending) = index.and_then(|i| slot.pending.remove(i)) {
                    if let Some(conversation) = slot.conversation(&config, ChatVendor::Codex) {
                        if let Some(message) = conversation.message_mut(&pending.id) {
                            message.source_id = Some(item_id);
                            changed.push(message.clone());
                        }
                    }
                }
            }
            "item/agentMessage/delta" => {
                let item_id = params.get("itemId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let delta = params.get("delta").and_then(|v| v.as_str()).unwrap_or("");
                if item_id.is_empty() || delta.is_empty() {
                    return None;
                }
                self.upsert_codex(slot, &item_id, changed, |message| {
                    message.text.push_str(delta);
                    message.done = false;
                }, || {
                    let mut message = ChatMessage::new("assistant", delta, now_ms());
                    message.done = false;
                    message
                });
            }
            "item/completed" if item_type == "agentMessage" => {
                let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let final_text = text.clone();
                self.upsert_codex(slot, &item_id, changed, move |message| {
                    message.text = final_text;
                    message.done = true;
                }, || ChatMessage::new("assistant", text, now_ms()));
            }
            "item/started" if item_type == "commandExecution" => {
                let command = item.get("command").and_then(|v| v.as_str()).unwrap_or("");
                let detail: String = command.lines().next().unwrap_or("").chars().take(120).collect();
                let message = tool_message(&item_id, "command", &detail, "running");
                self.upsert_codex(slot, &item_id, changed, |_| {}, || message);
            }
            "item/completed" if item_type == "commandExecution" || item_type == "fileChange" => {
                let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("");
                let exit = item.get("exitCode").and_then(|v| v.as_i64());
                let outcome = if status == "declined" {
                    "denied"
                } else if status == "failed" || exit.is_some_and(|code| code != 0) {
                    "failed"
                } else {
                    "done"
                };
                let name = if item_type == "fileChange" { "file change" } else { "command" };
                let command = item.get("command").and_then(|v| v.as_str()).unwrap_or("");
                let detail: String = command.lines().next().unwrap_or("").chars().take(120).collect();
                let fresh = tool_message(&item_id, name, &detail, outcome);
                self.upsert_codex(slot, &item_id, changed, |message| {
                    if let Some(tool) = &mut message.tool {
                        tool.outcome = outcome.to_string();
                    }
                }, || fresh);
            }
            "turn/completed" => {
                let turn = params.get("turn").cloned().unwrap_or(serde_json::Value::Null);
                let status = turn.get("status").and_then(|v| v.as_str()).unwrap_or("");
                if let Some(Proc::Codex(codex)) = &mut slot.proc {
                    codex.turn_id = None;
                    codex.turn_request = None;
                    codex.interrupt_wanted = false;
                }
                // Whatever streamed is all there is.
                if let Some(conversation) = slot.conversation(&config, ChatVendor::Codex) {
                    changed.extend(finish_streaming(&mut conversation.messages));
                }
                match status {
                    "interrupted" => {
                        let mut message = ChatMessage::new("interrupted", "", now_ms());
                        message.source_id = turn.get("id").and_then(|v| v.as_str()).map(str::to_string);
                        self.push_note(slot, ChatVendor::Codex, message, changed);
                    }
                    "failed" => {
                        let why = turn
                            .get("error")
                            .and_then(|e| e.get("message"))
                            .and_then(|m| m.as_str())
                            .unwrap_or("the turn failed");
                        self.push_note(slot, ChatVendor::Codex, notice(&format!("Codex: {why}"), true), changed);
                    }
                    _ => {}
                }
                slot.pending.clear();
                slot.codex_turn = Some(if status.is_empty() { "completed".to_string() } else { status.to_string() });
                if status == "failed" {
                    let why = turn.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()).unwrap_or("the turn failed");
                    slot.codex_turn = Some(format!("failed: {why}"));
                }
                self.set_status(slot, ChatStatus::Ready);
                slot.last_used = Instant::now();
                *force_save = true;
            }
            "thread/tokenUsage/updated" => {
                let total = &params["tokenUsage"]["total"];
                let n = |key: &str| total.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
                // One meaning across vendors (`chat_store::TokenUsage`):
                // Codex's input counts its cached part; it is taken out.
                let cached = n("cachedInputTokens");
                let usage = TokenUsage {
                    input_tokens: n("inputTokens").saturating_sub(cached),
                    output_tokens: n("outputTokens"),
                    cache_read_tokens: cached,
                    cache_creation_tokens: 0,
                    reasoning_tokens: n("reasoningOutputTokens"),
                };
                if let Some(conversation) = slot.conversation(&config, ChatVendor::Codex) {
                    conversation.set_session_usage(usage);
                }
                *usage_changed = true;
            }
            "error" => {
                let why = params
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| params.to_string());
                self.push_note(slot, ChatVendor::Codex, notice(&format!("Codex: {why}"), true), changed);
            }
            _ => {}
        }
        None
    }

    /// The message whose source is `source` updated, or a new one.
    fn upsert_codex(
        &self,
        slot: &mut Slot,
        source: &str,
        changed: &mut Vec<ChatMessage>,
        update: impl FnOnce(&mut ChatMessage),
        create: impl FnOnce() -> ChatMessage,
    ) {
        let config = self.config_dir.clone();
        let Some(conversation) = slot.conversation(&config, ChatVendor::Codex) else { return };
        conversation.updated_at = now_ms();
        if let Some(message) = conversation.by_source_mut(source) {
            update(message);
            changed.push(message.clone());
            return;
        }
        let mut message = create();
        message.source_id = Some(source.to_string());
        conversation.push(message.clone());
        changed.push(message);
    }

    fn codex_thread_ready(&self, slot: &mut Slot, thread: String, fresh: bool, changed: &mut Vec<ChatMessage>) -> Option<Proc> {
        let config = self.config_dir.clone();
        // A session that had an earlier thread and got a new one came back
        // without its context.
        let mut lost_context = false;
        if let Some(conversation) = slot.conversation(&config, ChatVendor::Codex) {
            lost_context = conversation.session_id.as_deref().is_some_and(|before| before != thread);
            if fresh || conversation.session_id.as_deref() != Some(thread.as_str()) {
                conversation.begin_session();
            }
            conversation.session_id = Some(thread.clone());
        }
        let reseed = slot.reseed.take();
        let mut first = match &mut slot.proc {
            Some(Proc::Codex(codex)) => {
                codex.thread_id = Some(thread);
                codex.phase = CodexPhase::Ready;
                codex.first_turn.take()
            }
            _ => None,
        };
        // A plan lane's fresh thread gets the re-seed in place of the turn's
        // message (§3 *Fresh sessions*).
        if let (true, Some(reseed), Some((input, id))) = (lost_context, reseed, first.as_mut()) {
            *input = reseed.codex;
            let id = id.clone();
            if let Some(conversation) = slot.conversation(&config, ChatVendor::Codex) {
                if let Some(message) = conversation.message_mut(&id) {
                    message.text = reseed.stored;
                    changed.push(message.clone());
                }
            }
            slot.reseeded = true;
        }
        slot.save(&config, true);
        self.signal(slot, |key| LaneSignal::SessionStarted { key, fresh: lost_context });
        if let Some((input, id)) = first {
            if let Err(error) = self.codex_turn(slot, input, &id) {
                changed.extend(self.fail_pending(slot, ChatVendor::Codex));
                slot.pending.clear();
                self.push_note(slot, ChatVendor::Codex, notice(&format!("Codex didn't get the message: {error}"), true), changed);
                slot.codex_turn = Some(format!("refused: {error}"));
                self.set_status(slot, ChatStatus::Ready);
            }
        } else if slot.status == ChatStatus::Starting {
            self.set_status(slot, ChatStatus::Ready);
        }
        None
    }

    fn codex_fail(&self, slot: &mut Slot, reason: &str, changed: &mut Vec<ChatMessage>) -> Option<Proc> {
        changed.extend(self.fail_pending(slot, ChatVendor::Codex));
        self.push_note(slot, ChatVendor::Codex, notice(reason, true), changed);
        self.take_proc(slot, ChatStatus::Stopped, Some(reason.to_string()))
    }
}

/// Merges what a Claude transcript poll added or changed into Plyloft's copy;
/// returns the messages added or changed. A transcript prompt is the
/// member's oldest message still waiting for its echo (`pending`); one with
/// none waiting is matched to an earlier message of Plyloft's with the same
/// words and no source yet (sent, then the app quit before its echo was
/// read), else added as Claude recorded it (typed in a terminal, queued).
fn merge_claude(
    conversation: &mut chat_store::Conversation,
    items: &[ChatItem],
    pending: &mut VecDeque<Pending>,
) -> Vec<ChatMessage> {
    let mut changed = Vec::new();
    for item in items {
        let id = item.id().to_string();
        match item {
            ChatItem::User { text, pasted_images, .. } => {
                if conversation.by_source_mut(&id).is_some() {
                    continue;
                }
                if let Some(own) = pending.pop_front() {
                    if let Some(message) = conversation.message_mut(&own.id) {
                        message.source_id = Some(id);
                        message.pasted_images = *pasted_images;
                        changed.push(message.clone());
                        continue;
                    }
                }
                let words = clean_text(text.trim());
                if let Some(message) = conversation
                    .messages
                    .iter_mut()
                    .find(|m| m.role == "user" && m.source_id.is_none() && m.text.trim() == words)
                {
                    message.source_id = Some(id);
                    message.is_error = false;
                    message.pasted_images = *pasted_images;
                    changed.push(message.clone());
                    continue;
                }
                let mut message = ChatMessage::new("user", text.clone(), now_ms());
                message.source_id = Some(id);
                message.pasted_images = *pasted_images;
                conversation.push(message.clone());
                changed.push(message);
            }
            ChatItem::Assistant { text, done, is_error, .. } => {
                if let Some(message) = conversation.by_source_mut(&id) {
                    // Finished stays finished: a stopped answer is saved
                    // done, and the transcript re-read on a resume (still
                    // partial there) doesn't make it stream again.
                    let done = *done || message.done;
                    if message.text != *text || message.done != done || message.is_error != *is_error {
                        message.text = text.clone();
                        message.done = done;
                        message.is_error = *is_error;
                        changed.push(message.clone());
                    }
                    continue;
                }
                let mut message = ChatMessage::new("assistant", text.clone(), now_ms());
                message.source_id = Some(id);
                message.done = *done;
                message.is_error = *is_error;
                conversation.push(message.clone());
                changed.push(message);
            }
            ChatItem::Tool { name, detail, outcome, .. } => {
                if let Some(message) = conversation.by_source_mut(&id) {
                    if let Some(tool) = &mut message.tool {
                        if tool.outcome != outcome.as_str() {
                            tool.outcome = outcome.as_str().to_string();
                            changed.push(message.clone());
                        }
                    }
                    continue;
                }
                let message = tool_message(&id, name, detail, outcome.as_str());
                conversation.push(message.clone());
                changed.push(message);
            }
            ChatItem::Shell { command, output, .. } => {
                if let Some(message) = conversation.by_source_mut(&id) {
                    if let Some(tool) = &mut message.tool {
                        if tool.detail != *output {
                            tool.detail = output.clone();
                            changed.push(message.clone());
                        }
                    }
                    continue;
                }
                let mut message = ChatMessage::new("shell", command.clone(), now_ms());
                message.source_id = Some(id);
                message.tool = Some(ChatTool { name: "shell".into(), detail: output.clone(), outcome: "done".into() });
                conversation.push(message.clone());
                changed.push(message);
            }
            ChatItem::Interrupted { .. } => {
                if conversation.by_source_mut(&id).is_some() {
                    continue;
                }
                let mut message = ChatMessage::new("interrupted", "", now_ms());
                message.source_id = Some(id);
                conversation.push(message.clone());
                changed.push(message);
            }
        }
    }
    changed
}

/// Each of `changed` replaced by the conversation's stored copy (newer when
/// the session ended after the copy was taken).
fn stored_copies(slot: &mut Slot, config: &Path, vendor: ChatVendor, changed: &mut [ChatMessage]) {
    if changed.is_empty() {
        return;
    }
    let Some(conversation) = slot.file(config).ok().and_then(|file| file.conversation(vendor)) else { return };
    for message in changed.iter_mut() {
        if let Some(stored) = conversation.messages.iter().rev().find(|m| m.id == message.id) {
            if stored != message {
                *message = stored.clone();
            }
        }
    }
}

/// Whether the tab says Claude waits on a menu: once the menu has been the
/// still screen for `menu_settle`, and from then on for as long as a menu
/// is drawn — the member's arrow keys redraw it, and the notice (with its
/// Show terminal button) must not come and go with each.
#[derive(Debug, Default)]
struct MenuNotice {
    said: bool,
    /// When a said menu was first seen gone: it is taken as gone only after
    /// [`MENU_GONE_AFTER`] (a ConPTY repaint can split a frame, leaving the
    /// chevron row erased for a poll).
    gone_since: Option<Instant>,
}

/// How long a said menu must be gone before its notice goes (over two polls).
const MENU_GONE_AFTER: Duration = Duration::from_millis(600);

impl MenuNotice {
    fn update(&mut self, menu: bool, still_for: Duration, settle: Duration, now: Instant) -> bool {
        if menu {
            self.gone_since = None;
            self.said |= still_for >= settle;
        } else if self.said {
            let since = *self.gone_since.get_or_insert(now);
            if now.duration_since(since) >= MENU_GONE_AFTER {
                self.said = false;
                self.gone_since = None;
            }
        }
        self.said
    }
}

/// Assistant messages still marked streaming, marked finished; returns them.
fn finish_streaming(messages: &mut [ChatMessage]) -> Vec<ChatMessage> {
    let mut changed = Vec::new();
    for message in messages.iter_mut().filter(|m| m.role == "assistant" && !m.done) {
        message.done = true;
        changed.push(message.clone());
    }
    changed
}

/// One poll of a Claude chat.
struct ClaudeRead {
    items: Vec<ChatItem>,
    usage: TokenUsage,
    usage_changed: bool,
    grew: bool,
    turn_open: bool,
    /// Why the last turn closed (`ClaudeFold::turn_close`).
    turn_close: TurnClose,
    /// How long the transcript and the screen have both been still.
    quiet_for: Duration,
    /// Claude's idle composer is the last thing drawn: a held message may
    /// be pasted.
    composer_idle: bool,
    /// Claude moved to another transcript (its new session id).
    switched: Option<String>,
    /// The turn was closed: Claude sat at its idle composer with the
    /// transcript still open.
    stuck: bool,
    attention: Option<String>,
    /// The session is ended with this (a screen only the member can get
    /// past, the startup net).
    stop: Option<String>,
    /// The CLI exited on its own (with its code).
    exited: Option<Option<i32>>,
    screen_tail: String,
}

/// A Claude chat session's watcher: reads only what the transcript grew by,
/// folds it, and reads the screen's latest frame every poll.
struct ClaudeWatch {
    inner: Weak<Inner>,
    key: ChatKey,
    generation: u64,
    session_id: String,
    claude_config: Option<PathBuf>,
    /// What the transcript held when the session started (a resume's
    /// earlier conversation): growth past it is the session's own.
    catch_up: u64,
    screen: Arc<crate::chat_screen::ChatScreen>,
    /// Set (with the exit code) once the CLI has exited and its output
    /// drained.
    exited: Arc<Mutex<Option<Option<i32>>>>,
    stop: Arc<AtomicBool>,
    limits: ChatLimits,
    screen_log: Option<PathBuf>,
}

impl ClaudeWatch {
    fn run(mut self) {
        let started_at = Instant::now();
        let mut fold = ClaudeFold::default();
        let mut transcript: Option<PathBuf> = None;
        let mut read_len = 0u64;
        let mut last_growth = Instant::now();
        let mut trust_since: Option<Instant> = None;
        let mut frame = 0u64;
        let mut last_draw = Instant::now();
        let mut last_usage = TokenUsage::default();
        let mut last_logged = (false, String::new());
        let mut menu = MenuNotice::default();
        let spawned = std::time::SystemTime::now();
        let mut polls = 0u64;
        // A resume's catch-up (what the transcript held when the session
        // started) not yet folded.
        let mut caught_up = self.catch_up == 0;
        loop {
            std::thread::sleep(POLL);
            if self.stop.load(Ordering::SeqCst) {
                return;
            }
            let exit = *self.exited.lock();
            if transcript.is_none() {
                transcript = self
                    .claude_config
                    .as_deref()
                    .and_then(|dir| crate::claude_session::find_transcript(dir, &self.session_id));
            }
            // `/clear`, `/resume` … typed in Claude's terminal move it to
            // another transcript in the same project folder: the chat
            // follows the one written last (checked about once a second).
            polls += 1;
            let mut switched = None;
            if let Some(current) = transcript.clone().filter(|_| polls % 4 == 0) {
                if let Some(newer) = newer_transcript(&current, spawned) {
                    let id = newer.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string();
                    if !id.is_empty() {
                        transcript = Some(newer);
                        read_len = 0;
                        self.catch_up = 0;
                        caught_up = true;
                        fold = ClaudeFold::default();
                        last_usage = TokenUsage::default();
                        self.session_id = id.clone();
                        switched = Some(id);
                    }
                }
            }
            let read_from = read_len;
            let grown = transcript.as_deref().map(|path| read_grown(path, &mut read_len)).unwrap_or_default();
            let grew = !grown.is_empty();
            if grew {
                if !caught_up && read_len >= self.catch_up {
                    // The earlier session's record ends here. A turn it left
                    // open (it ended mid-answer: a message never answered) is
                    // no turn of this session's: closed silently, before
                    // anything this session writes (Windows walk of
                    // 3f159198: the open turn held the resumed message's
                    // paste until the stuck-turn closer ended it, with its
                    // notice, inside the new turn).
                    let split = (self.catch_up.saturating_sub(read_from) as usize).min(grown.len());
                    fold.push_bytes(&grown[..split]);
                    if fold.turn_open() {
                        fold.close_turn(TurnClose::Ended);
                    }
                    caught_up = true;
                    fold.push_bytes(&grown[split..]);
                } else {
                    fold.push_bytes(&grown);
                }
                last_growth = Instant::now();
            }
            // The session wrote something of its own (past a resume's
            // catch-up read).
            let started = read_len > self.catch_up;
            if fold.answer_shaped() && last_growth.elapsed() >= self.limits.turn_settle {
                fold.close_turn(TurnClose::Settled);
            }
            // The screen as a terminal shows it now (`chat_screen`).
            let rows = self.screen.rows();
            let screen = crate::chat_screen::text(&rows);
            let signature = crate::claude_session::frame_signature(&screen);
            if signature != frame {
                frame = signature;
                last_draw = Instant::now();
            }
            let idle = crate::chat_screen::composer_idle(&rows);
            // The transcript says a turn is open, but Claude has sat at its
            // idle composer, the grid unchanged, for a while: the turn is
            // over (no end entry came).
            // Claude's working line above the box says a turn runs: then
            // only the long net applies.
            let quiet = if crate::chat_screen::working_line_shown(&rows) {
                self.limits.stuck_turn_working
            } else {
                self.limits.stuck_turn
            };
            let stuck = fold.turn_open()
                && idle
                && last_draw.elapsed() >= quiet
                && last_growth.elapsed() >= quiet;
            if stuck {
                fold.close_turn(TurnClose::Stuck);
            }
            // Every poll, for the session's lifetime.
            let mut stop = None;
            if exit.is_none() {
                if crate::claude_session::asks_for_folder_trust(&screen) {
                    if trust_since.get_or_insert_with(Instant::now).elapsed() >= self.limits.trust_confirm {
                        stop = Some(crate::claude_session::FOLDER_TRUST_REFUSAL.to_string());
                    }
                } else {
                    trust_since = None;
                }
                if stop.is_none() {
                    stop = crate::chat_screen::blocker(&rows).map(str::to_string);
                }
                if stop.is_none()
                    && !started
                    && started_at.elapsed() >= self.limits.startup_net
                    && last_draw.elapsed() >= self.limits.screen_settle
                    && !idle
                {
                    stop = Some(crate::claude_session::unknown_screen_message(&crate::chat_screen::tail(&rows, 1500)));
                }
            }
            let settled = last_draw.elapsed() >= self.limits.screen_settle;
            // A menu Claude waits on — not its permission dialog nor the
            // trust question, which have their own paths and words.
            let menu_now = crate::chat_screen::menu_waiting(&rows)
                && !crate::claude_session::asks_for_permission(&screen)
                && !crate::claude_session::asks_for_folder_trust(&screen);
            let menu_said = menu.update(menu_now, last_draw.elapsed(), self.limits.menu_settle, Instant::now());
            let attention = match fold.state() {
                ChatState::WaitingOnTool { tool }
                    if last_growth.elapsed() >= self.limits.screen_settle
                        && settled
                        && crate::claude_session::asks_for_permission(&screen) =>
                {
                    Some(crate::claude_session::permission_question_message(
                        &tool,
                        &crate::chat_screen::tail(&rows, 1500),
                    ))
                }
                // Any other menu Claude waits on (a model or rewind picker
                // opened in the terminal): the member answers it there.
                _ if menu_said => Some(format!(
                    "Claude shows a menu on its screen and waits for a choice; answer it in Claude's terminal. Its screen shows: {}",
                    crate::chat_screen::tail(&rows, 600)
                )),
                _ => None,
            };
            let usage = fold.usage();
            let usage_changed = usage != last_usage;
            last_usage = usage.clone();
            let screen_tail =
                if exit.is_some() && !started { crate::chat_screen::tail(&rows, 600) } else { String::new() };
            let decision = format!("watch: started={started} turn_open={} stop={stop:?} attention={}", fold.turn_open(), attention.is_some());
            if self.screen_log.is_some() && (idle, decision.clone()) != last_logged {
                log_screen_to(self.screen_log.as_deref(), &decision, &rows);
                last_logged = (idle, decision);
            }
            let read = ClaudeRead {
                items: fold.take_dirty(),
                usage,
                usage_changed,
                grew,
                turn_open: fold.turn_open(),
                turn_close: fold.turn_close(),
                quiet_for: last_draw.elapsed().min(last_growth.elapsed()),
                composer_idle: idle,
                switched,
                stuck,
                attention,
                stop: stop.clone(),
                exited: exit,
                screen_tail,
            };
            let Some(inner) = self.inner.upgrade() else { return };
            if self.stop.load(Ordering::SeqCst) {
                return;
            }
            inner.on_claude(&self.key, self.generation, read);
            if stop.is_some() || exit.is_some() {
                return;
            }
        }
    }
}

/// Another transcript in `current`'s project folder written after `current`
/// and since the session started (`since`): where Claude went after a
/// `/clear` or `/resume` in its terminal. The chat's folder is the card's
/// own, so its project folder holds only this card's sessions.
fn newer_transcript(current: &Path, since: std::time::SystemTime) -> Option<PathBuf> {
    let modified = |path: &Path| std::fs::metadata(path).and_then(|m| m.modified()).ok();
    let current_at = modified(current)?;
    std::fs::read_dir(current.parent()?)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path != current && path.extension().is_some_and(|ext| ext == "jsonl"))
        .filter_map(|path| modified(&path).map(|at| (at, path)))
        .filter(|(at, _)| *at > current_at && *at >= since)
        .max_by_key(|(at, _)| *at)
        .map(|(_, path)| path)
}

/// What `path` grew by since `read_len`, which moves on (complete or not:
/// the fold keeps a partial last line).
fn read_grown(path: &Path, read_len: &mut u64) -> Vec<u8> {
    use std::io::{Read as _, Seek as _};
    let Ok(len) = std::fs::metadata(path).map(|meta| meta.len()) else {
        return Vec::new();
    };
    if len <= *read_len {
        return Vec::new();
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    if file.seek(std::io::SeekFrom::Start(*read_len)).is_err() {
        return Vec::new();
    }
    let mut grown = Vec::new();
    if file.take(len - *read_len).read_to_end(&mut grown).is_err() {
        return Vec::new();
    }
    *read_len += grown.len() as u64;
    grown
}

// ── IPC ──────────────────────────────────────────────────────────────

/// The card, which must exist: a chat is never kept for a card that
/// doesn't.
fn require_card(kanban: &crate::kanban::KanbanStore, workspace_id: &str, card_id: &str) -> Result<crate::kanban::KanbanCard, String> {
    kanban.get_card(workspace_id, card_id)
}

/// A lane's host, which must exist: a card ([`require_card`], unchanged for
/// card lanes), or a workspace (a Next improvement round's lanes).
pub(crate) fn require_host(
    kanban: &crate::kanban::KanbanStore,
    workspaces: &crate::workspace::WorkspaceStore,
    host: LaneHost<'_>,
) -> Result<(), String> {
    match host {
        LaneHost::Card { workspace_id, card_id } => require_card(kanban, workspace_id, card_id).map(|_| ()),
        LaneHost::Workspace { workspace_id } => {
            if workspaces.snapshot().workspaces.iter().any(|w| w.id == workspace_id) {
                Ok(())
            } else {
                Err(format!("workspace '{workspace_id}' not found"))
            }
        }
    }
}

/// The card's context for a session: its title and notes, and the folder
/// the model may read (its worktree, else the workspace's folder).
pub(crate) fn chat_context(
    kanban: &crate::kanban::KanbanStore,
    workspaces: &crate::workspace::WorkspaceStore,
    workspace_id: &str,
    card_id: &str,
) -> Result<ChatContext, String> {
    let card = require_card(kanban, workspace_id, card_id)?;
    let workspace_dir = workspaces
        .snapshot()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
        .map(|w| PathBuf::from(w.cwd));
    let project_dir = card
        .worktree_path
        .as_deref()
        .map(PathBuf::from)
        .filter(|dir| dir.is_dir())
        .or(workspace_dir);
    // 1.175.0 (B3 round 2): an issue card's title and notes are the issue's
    // text — told quoted, its hidden parts marked, as the Builder gets them.
    let (title, notes) = match crate::issue_text::brief_for_ai(&card) {
        Some(quoted) => (crate::issue_text::name_for_ai(&card), quoted),
        None => (card.title.clone(), card.notes.clone().unwrap_or_default()),
    };
    Ok(ChatContext {
        title,
        notes,
        project_dir,
        plan: card.dispatch_prompt.clone(),
        pull_request: crate::pr_review::chat_note_of(&card),
    })
}

#[tauri::command]
pub fn chat_open(
    registry: tauri::State<'_, ChatRegistry>,
    kanban: tauri::State<'_, crate::kanban::KanbanStore>,
    workspace_id: String,
    card_id: String,
    vendor: String,
) -> Result<ChatSnapshot, String> {
    require_card(&kanban, &workspace_id, &card_id)?;
    registry.open(&workspace_id, &card_id, ChatVendor::parse(&vendor)?)
}

#[tauri::command]
pub fn chat_messages(
    registry: tauri::State<'_, ChatRegistry>,
    kanban: tauri::State<'_, crate::kanban::KanbanStore>,
    workspace_id: String,
    card_id: String,
    vendor: Option<String>,
    preferred: Option<String>,
) -> Result<ChatSnapshot, String> {
    require_card(&kanban, &workspace_id, &card_id)?;
    let vendor = vendor.as_deref().map(ChatVendor::parse).transpose()?;
    // A vendor this Plyloft doesn't know is no preference (never refused).
    let preferred = preferred.as_deref().and_then(|v| ChatVendor::parse(v).ok());
    registry.messages(&workspace_id, &card_id, vendor, preferred)
}

/// 1.171.0 (E1; walk 2026-10-27 #6): the vendor a card's chat shows when
/// none is asked for. The one the person last chose (`active_vendor`);
/// else, in a file from before that was recorded, the vendor that already
/// has a conversation, so its history is what opens; else `preferred` (the
/// card's Builder or the default Builder); else Claude, as before.
pub(crate) fn shown_vendor(file: &CardChatFile, preferred: Option<ChatVendor>) -> ChatVendor {
    if let Some(vendor) = file.active_vendor {
        return vendor;
    }
    if let Some(talked) = file
        .conversations
        .iter()
        .find(|c| c.vendor != ChatVendor::Other && !c.messages.is_empty())
    {
        return talked.vendor;
    }
    match preferred {
        Some(vendor) if vendor != ChatVendor::Other => vendor,
        _ => ChatVendor::Claude,
    }
}

/// On a worker: a send may start a session.
#[tauri::command]
pub async fn chat_send(
    app: tauri::AppHandle,
    workspace_id: String,
    card_id: String,
    text: String,
    attachment_ids: Option<Vec<String>>,
) -> Result<ChatMessage, String> {
    // 1.176.0 R3: a blocking worker, so a stale Claude/Codex path may wait
    // for its look (`cli_fresh::waiting`).
    tauri::async_runtime::spawn_blocking(move || crate::cli_fresh::waiting(|| {
        use tauri::Manager;
        let context = chat_context(
            &app.state::<crate::kanban::KanbanStore>(),
            &app.state::<crate::workspace::WorkspaceStore>(),
            &workspace_id,
            &card_id,
        )?;
        app.state::<ChatRegistry>().send(
            &app,
            &app.state::<crate::pty::PtyRegistry>(),
            &workspace_id,
            &card_id,
            context,
            &text,
            &attachment_ids.unwrap_or_default(),
        )
    }))
    .await
    .map_err(|e| format!("chat send worker failed: {e}"))?
}

/// "Show terminal"'s first paint: the live Claude session's PTY id and its
/// screen; `None` when no Claude session runs for the card.
#[tauri::command]
pub fn chat_screen(
    registry: tauri::State<'_, ChatRegistry>,
    kanban: tauri::State<'_, crate::kanban::KanbanStore>,
    workspace_id: String,
    card_id: String,
) -> Result<Option<ChatScreenSnapshot>, String> {
    require_card(&kanban, &workspace_id, &card_id)?;
    registry.screen_snapshot(&workspace_id, &card_id)
}

#[tauri::command]
pub fn chat_interrupt(
    registry: tauri::State<'_, ChatRegistry>,
    kanban: tauri::State<'_, crate::kanban::KanbanStore>,
    workspace_id: String,
    card_id: String,
) -> Result<(), String> {
    require_card(&kanban, &workspace_id, &card_id)?;
    registry.interrupt(&workspace_id, &card_id)
}

/// On a worker: ending a Claude session waits for its hangup.
#[tauri::command]
pub async fn chat_close(app: tauri::AppHandle, workspace_id: String, card_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        require_card(&app.state::<crate::kanban::KanbanStore>(), &workspace_id, &card_id)?;
        app.state::<ChatRegistry>().close(&workspace_id, &card_id)
    })
    .await
    .map_err(|e| format!("chat close worker failed: {e}"))?
}

/// Header names of [`chat_attachment_add`]'s raw request.
pub(crate) const HEADER_WORKSPACE: &str = "x-ply-workspace-id";
pub(crate) const HEADER_CARD: &str = "x-ply-card-id";
/// The file's name, percent-encoded UTF-8 (`encodeURIComponent`): a header
/// value is ASCII.
pub(crate) const HEADER_NAME: &str = "x-ply-file-name";

/// `%XX` decoded (UTF-8), for a header value `encodeURIComponent` wrote.
pub(crate) fn percent_decode(raw: &str) -> Result<String, String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = raw.get(i + 1..i + 3).ok_or("a broken %-escape in the file name")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "a broken %-escape in the file name")?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "the file name is not UTF-8".to_string())
}

/// What a raw attachment request carries: the card, the file's name, and
/// its bytes (borrowed: never copied in memory).
pub(crate) fn attachment_request<'a>(
    headers: &'a tauri::http::HeaderMap,
    body: &'a tauri::ipc::InvokeBody,
) -> Result<(String, String, String, &'a [u8]), String> {
    // The same reading as a dropped file's (`commands::DroppedRequest`):
    // the same headers, the same refusal of a JSON body.
    let request = crate::commands::DroppedRequest::new(headers, body)?;
    Ok((
        request.header(HEADER_WORKSPACE)?,
        request.header(HEADER_CARD)?,
        request.name()?,
        request.bytes,
    ))
}

/// Attaches a file to a card's chat. The body is the file's raw bytes
/// (`invoke("chat_attachment_add", bytes, { headers })`), not a JSON number
/// array (the old way a dropped file's bytes went, several times the size);
/// the card and the name travel in the headers above. Off the main
/// thread (a PDF is read in a child for up to 20 s), reading the body in
/// place.
#[tauri::command(async)]
pub fn chat_attachment_add(
    registry: tauri::State<'_, ChatRegistry>,
    kanban: tauri::State<'_, crate::kanban::KanbanStore>,
    request: tauri::ipc::Request<'_>,
) -> Result<Attachment, String> {
    let (workspace_id, card_id, name, bytes) = attachment_request(request.headers(), request.body())?;
    require_card(&kanban, &workspace_id, &card_id)?;
    registry.attachment_add(&workspace_id, &card_id, &name, bytes)
}

#[tauri::command]
pub fn chat_attachment_list(
    registry: tauri::State<'_, ChatRegistry>,
    kanban: tauri::State<'_, crate::kanban::KanbanStore>,
    workspace_id: String,
    card_id: String,
) -> Result<Vec<Attachment>, String> {
    require_card(&kanban, &workspace_id, &card_id)?;
    registry.attachment_list(&workspace_id, &card_id)
}

#[tauri::command]
pub fn chat_attachment_remove(
    registry: tauri::State<'_, ChatRegistry>,
    kanban: tauri::State<'_, crate::kanban::KanbanStore>,
    workspace_id: String,
    card_id: String,
    attachment_id: String,
) -> Result<(), String> {
    require_card(&kanban, &workspace_id, &card_id)?;
    registry.attachment_remove(&workspace_id, &card_id, &attachment_id)
}

#[cfg(test)]
#[path = "chat_tests.rs"]
mod tests;

/// By hand only, with the owner's approval: a real `claude` and `codex`.
#[cfg(all(test, target_os = "macos"))]
#[path = "chat_live_tests.rs"]
mod live_tests;

#[cfg(test)]
mod menu_notice_tests {
    use super::{MenuNotice, MENU_GONE_AFTER};
    use std::time::{Duration, Instant};

    #[test]
    fn a_menu_is_said_once_still_and_kept_through_redraws_until_it_goes() {
        let settle = Duration::from_millis(1500);
        let t0 = Instant::now();
        let at = |ms: u64| t0 + Duration::from_millis(ms);
        let mut notice = MenuNotice::default();
        assert!(!notice.update(true, Duration::from_millis(200), settle, at(0)), "not before it settles");
        assert!(notice.update(true, Duration::from_millis(1600), settle, at(1400)), "said once still");
        assert!(notice.update(true, Duration::ZERO, settle, at(1650)), "kept through a redraw (an arrow key)");
        // A split repaint: the chevron row erased for a poll or two.
        assert!(notice.update(false, Duration::ZERO, settle, at(1900)), "kept: gone for one poll");
        assert!(notice.update(false, Duration::ZERO, settle, at(2150)), "kept: gone for two polls");
        assert!(notice.update(true, Duration::ZERO, settle, at(2400)), "back, still said");
        assert!(notice.update(false, Duration::ZERO, settle, at(2650)));
        let gone = 2650 + MENU_GONE_AFTER.as_millis() as u64;
        assert!(!notice.update(false, Duration::from_secs(5), settle, at(gone)), "gone with the menu");
        assert!(!notice.update(true, Duration::ZERO, settle, at(gone + 250)), "a new menu settles again");
    }
}
