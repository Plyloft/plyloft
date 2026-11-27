//! Compare (1.177.0): the last finished answer of a Claude or Codex tile,
//! read from the CLI's own file, and the one cleaned text the window pastes
//! into the other tile on the member's press.
//!
//! - **Which conversation.** The tile's record is looked at again first
//!   (`terminal_sessions::live_conversation`, through `refresh_title`: a
//!   `/clear` or `/resume` followed, a Codex session claimed), never the id
//!   the window cached. Nothing is guessed: a Codex tile whose session isn't
//!   claimed, or a Claude tile whose per-process file names another
//!   conversation, is `ambiguous`; on Windows, where Claude's per-process
//!   file is unmeasured, a Claude tile without one is `ambiguous` too.
//! - **Only the tail.** Transcripts reach hundreds of MB: the file is read
//!   backwards in growing chunks, at most [`READ_MAX`], from a line boundary.
//! - **Claude:** `chat_transcript::ClaudeFold`, then Plan with two AIs' rule
//!   (`plan_exchange::final_answer`: the text after the turn's last tool
//!   call) on the newest turn that ended; a turn whose last step is
//!   `ExitPlanMode` answers with its plan (see [`exit_plan_mode_plan`]).
//! - **Codex:** the newest `task_complete.last_agent_message`, else that
//!   turn's last `phase: "final_answer"` message.
//! - **Nothing kept.** No state, no file, no child process. An answer's text
//!   never reaches a log or an error, and `Debug` leaves it out.
//! - **The member's question** (1.179.0, `compare_asks.rs`): the member's own
//!   messages of the answer's turn ride with the answer, read in the same
//!   pass, or a reason they can't be told; the paste can carry them before
//!   the answer, cut first. Counts only in the log, like the answer.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::chat_attachments::clean_text;
use crate::chat_store::{ChatMessage, ChatVendor, Conversation as ChatConversation};
use crate::chat_transcript::{ChatItem, ChatState, ClaudeFold, ToolOutcome};
use crate::plan_exchange::{cap_relay, cap_with_cut, final_answer, relay_was_cut, RELAY_CAP};
use crate::pty::PtyRegistry;
use crate::terminal_sessions::{CliHomes, LiveConversation, SessionKind};

#[path = "compare_asks.rs"]
mod asks;
use asks::TurnAsks;

/// The first look at a file's tail.
pub(crate) const READ_FIRST: u64 = 256 * 1024;
/// The most of a file's tail ever read (spike §6: never the whole file).
pub(crate) const READ_MAX: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Vendor {
    Claude,
    Codex,
}

/// Whether Plyloft knows which conversation the tile is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConversationLink {
    Known,
    /// A tile of Claude or Codex whose conversation can't be told for sure.
    Ambiguous,
    /// A Codex tile whose conversation hasn't begun: no session claimed, and
    /// none in its folder since it started that it could be.
    Unstarted,
    /// Not a recorded Claude or Codex tile (or it has ended).
    None,
}

/// Where the tile's current turn stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnState {
    /// The AI is working (or Claude's plan waits for its approval menu).
    Open,
    Done,
    /// Nothing sent in this conversation yet (or nothing readable).
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AnswerKind {
    Text,
    Plan,
}

/// What `compare_tile_answer` gives the window (fields in camel case).
#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareAnswer {
    /// `None` only with `conversation: none`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor: Option<Vendor>,
    pub conversation: ConversationLink,
    /// The conversation's title, as the tile shows it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The current turn, beside the newest finished answer.
    pub turn: TurnState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer_kind: Option<AnswerKind>,
    /// When the answer was written (ms since the epoch), when the file says.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at_ms: Option<i64>,
    /// The answer's length in characters, as given (after any cut).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chars: Option<usize>,
    /// The answer was cut at 16,000 characters.
    pub cut: bool,
    /// The newest turn ended without an answer of its own (stopped, an API
    /// or usage-limit error, a Codex turn with no message): `answer` is an
    /// earlier turn's.
    pub from_earlier_turn: bool,
    /// Claude: the answer is the open turn's own plan, still waiting for its
    /// approval menu (read from the plan file, or its ExitPlanMode has no
    /// result yet). After the menu is answered the plan is only the last
    /// finished answer of a turn that goes on. Sent only when true.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub plan_pending: bool,
    /// Claude: the newest turn ended on a plan its transcript can't give
    /// back (the plan file was written after the plan was shown, and that
    /// write can't be read), so nothing is offered rather than an older
    /// plan. Sent only when true.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub plan_unread: bool,
    /// The answer is Claude's plan file, read while the approval menu is up
    /// (the log's fact; not sent to the window).
    #[serde(skip)]
    pub from_plan_file: bool,
    /// 1.179.0: the member's own messages of the answer's turn (memory only:
    /// never logged, never kept). Absent with no answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_asks: Option<TurnAsks>,
}

/// Never the answer's text: a stray `{:?}` must not log what an AI wrote.
impl std::fmt::Debug for CompareAnswer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CompareAnswer")
            .field("vendor", &self.vendor)
            .field("conversation", &self.conversation)
            .field("turn", &self.turn)
            .field("answer_kind", &self.answer_kind)
            .field("finished_at_ms", &self.finished_at_ms)
            .field("chars", &self.chars)
            .field("cut", &self.cut)
            .field("from_earlier_turn", &self.from_earlier_turn)
            .field("plan_pending", &self.plan_pending)
            .field("plan_unread", &self.plan_unread)
            .field("turn_asks", &self.turn_asks)
            .finish_non_exhaustive()
    }
}

impl CompareAnswer {
    fn without_answer(vendor: Option<Vendor>, conversation: ConversationLink, title: Option<String>, turn: TurnState) -> Self {
        CompareAnswer { vendor, conversation, title, turn, answer: None, answer_kind: None, finished_at_ms: None, chars: None, cut: false, from_earlier_turn: false, plan_pending: false, plan_unread: false, from_plan_file: false, turn_asks: None }
    }
}

/// An answer found in a file's tail.
#[derive(Clone, PartialEq)]
pub(crate) struct Found {
    pub text: String,
    pub kind: AnswerKind,
    pub at_ms: Option<i64>,
    pub cut: bool,
}

impl std::fmt::Debug for Found {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Found").field("chars", &self.text.chars().count()).field("kind", &self.kind).field("cut", &self.cut).finish()
    }
}

/// What one tail says.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Parsed {
    pub turn: TurnState,
    pub found: Option<Found>,
    /// `found` is an earlier turn's, the newest one having ended without.
    pub earlier: bool,
    /// Claude: the time stamped on the tail's last timestamped entry.
    pub last_entry_ms: Option<i64>,
    /// Claude, an open turn: whether it is a planning turn (its prompt was
    /// sent in plan mode, or it called ExitPlanMode); `None` when its prompt
    /// lies before the tail.
    pub planning: Option<bool>,
    /// Claude, an open turn: the time stamped on its prompt, when in the tail.
    pub prompt_ms: Option<i64>,
    /// Claude, an open turn whose last step is an ExitPlanMode with no result
    /// yet: its plan waits for the approval menu.
    pub plan_waits: bool,
    /// Claude, an open turn whose ExitPlanMode has its result: the approval
    /// menu was answered (review R2-M1).
    pub plan_answered: bool,
    /// Claude, an open turn whose last ExitPlanMode on disk was refused with
    /// the member's feedback: the time stamped on that refusal. Claude then
    /// writes the next plan to the plan file and shows its menu before any
    /// of it is flushed (measured, 2.1.332).
    pub plan_refused_ms: Option<i64>,
    /// Claude: the turn the answer would come from ended on a plan that
    /// can't be read back (see [`turn_plan`]).
    pub plan_unread: bool,
    /// The member's messages of `found`'s turn.
    pub asks: Option<TurnAsks>,
    /// Claude: the newest turn's, for a plan file read in its place.
    pub newest_asks: Option<TurnAsks>,
}

// ── The command ──────────────────────────────────────────────────────────

/// The last finished answer of a Claude or Codex tile, its conversation
/// looked at again first. Reads only; writes nothing but the tile record's
/// own refresh (the same one the tile title's poll makes).
#[tauri::command(async)]
pub fn compare_tile_answer(registry: State<'_, PtyRegistry>, pty_id: String) -> CompareAnswer {
    let pid = registry.process_id(&pty_id);
    let live = crate::terminal_sessions::live_conversation(&pty_id, pid, &CliHomes::real());
    // What the read found, never what it read: no title, no text, no path.
    let seen = live.as_ref().map(|l| {
        let bytes = l.file.as_deref().and_then(|f| std::fs::metadata(f).ok()).map(|m| m.len());
        (l.id.is_some(), l.pid_names_it, l.newer_elsewhere, bytes)
    });
    let out = tile_answer(live);
    log::info!(
        "compare: tile read pid={:?} seen(id, pid_names_it, newer_elsewhere, file_bytes)={:?} -> conversation={:?} turn={:?} kind={:?} chars={:?} earlier={} cut={} plan_file={} plan_pending={} plan_unread={} asks={}",
        pid,
        seen,
        out.conversation,
        out.turn,
        out.answer_kind,
        out.chars,
        out.from_earlier_turn,
        out.cut,
        out.from_plan_file,
        out.plan_pending,
        out.plan_unread,
        out.turn_asks.as_ref().map_or_else(|| "none".to_string(), TurnAsks::fact)
    );
    out
}

/// [`compare_tile_answer`] once the tile's conversation is known.
pub(crate) fn tile_answer(live: Option<LiveConversation>) -> CompareAnswer {
    let Some(live) = live else {
        return CompareAnswer::without_answer(None, ConversationLink::None, None, TurnState::None);
    };
    let vendor = match live.kind {
        SessionKind::Claude => Vendor::Claude,
        SessionKind::Codex => Vendor::Codex,
    };
    let link = link_of(&live, cfg!(windows));
    if link != ConversationLink::Known {
        return CompareAnswer::without_answer(Some(vendor), link, live.title, TurnState::None);
    }
    let Some(file) = live.file.as_deref() else {
        // Known, but the CLI hasn't written its file yet (no turn).
        return CompareAnswer::without_answer(Some(vendor), link, live.title, TurnState::None);
    };
    let parse: fn(&[u8], bool) -> Parsed = match vendor {
        Vendor::Claude => claude_tail,
        Vendor::Codex => codex_tail,
    };
    let parsed = read_tail(file_tail(file), parse, READ_FIRST, READ_MAX);
    let mut out = CompareAnswer::without_answer(Some(vendor), link, live.title, parsed.turn);
    // An answer that is blank once cleaned for the paste is none: nothing
    // label-only is ever pasted.
    let mut found = parsed.found.filter(|f| !paste_clean(&f.text).trim().is_empty());
    let mut earlier = parsed.earlier;
    let mut asks = parsed.asks;
    // Measured live (2.1.331): while the plan's approval menu is up Claude
    // may not have flushed the transcript (how far varies); its plan file is
    // already written. In a planning turn, a plan file newer than the last
    // finished answer is the answer. Never in a turn typed outside plan mode;
    // when the turn's prompt isn't in the tail, only while no entry on disk
    // is newer than the plan file.
    let floor = match parsed.planning {
        // R5-N1: written in this turn — never a plan file left by an
        // earlier planning turn while Claude still explores.
        Some(true) => Some(parsed.prompt_ms.unwrap_or(i64::MIN)),
        Some(false) => None,
        None => Some(parsed.last_entry_ms.unwrap_or(i64::MIN)),
    };
    if let (Vendor::Claude, TurnState::Open, Some(floor)) = (vendor, parsed.turn, floor) {
        let after = match &found {
            None => Some(i64::MIN),
            Some(f) => f.at_ms,
        };
        if let (Some(after), Some(plans), Some(id)) = (after, live.plans_dir.as_deref(), live.id.as_deref()) {
            if let Some(plan) = plan_file_answer(plans, id, after, floor) {
                found = Some(plan);
                earlier = false;
                out.from_plan_file = true;
                // The open turn's own plan: that turn's question.
                asks = parsed.newest_asks.clone();
            }
        }
    }
    // B1: a plan that can't be read back is said so, never replaced by an
    // older one (an open turn's plan file above may still stand in).
    out.plan_unread = parsed.plan_unread && found.is_none();
    if let Some(found) = found {
        out.from_earlier_turn = earlier;
        out.chars = Some(found.text.chars().count());
        out.answer_kind = Some(found.kind);
        out.finished_at_ms = found.at_ms;
        out.cut = found.cut;
        // Review M2, R2-M1: a plan file is the plan waiting for its menu
        // only while the turn's ExitPlanMode has no result on disk. Before
        // the menu Claude flushes its own steps after the file (the plan's
        // Write and its result, the ToolSearch for ExitPlanMode, a sentence:
        // measured, how far varies), so newer entries can't say the menu was
        // answered; the result can, and it is on disk before any step after
        // it. A write to the plan file during the work never makes it pending.
        // B1: the same holds after a plan refused with feedback (the turn's
        // last ExitPlanMode on disk): the next plan's menu is up while the
        // plan file is newer than that refusal, and none of it is flushed.
        let refused_then_rewritten =
            matches!((parsed.plan_refused_ms, found.at_ms), (Some(refused), Some(written)) if written > refused);
        let file_waits = out.from_plan_file && (!parsed.plan_answered || refused_then_rewritten);
        out.plan_pending = parsed.turn == TurnState::Open
            && found.kind == AnswerKind::Plan
            && (file_waits || parsed.plan_waits);
        out.answer = Some(found.text);
        out.turn_asks = asks;
    }
    out
}

/// The most of a plan file read: it is a short markdown file.
const PLAN_FILE_MAX: u64 = 1024 * 1024;

/// Claude's plan file for conversation `id` (`<plans>/<slug>-of-<id>.md`,
/// measured on 2.1.331; the newest when several; never for an empty id),
/// when it was written after `after_ms` (the last finished answer) and after
/// `last_entry_ms` (the caller's floor: the transcript's last timestamped
/// entry when the turn can't be told a planning one), and is not blank once
/// cleaned for the paste.
pub(crate) fn plan_file_answer(plans: &Path, id: &str, after_ms: i64, last_entry_ms: i64) -> Option<Found> {
    if id.trim().is_empty() {
        return None;
    }
    let suffix = format!("{id}.md");
    let (path, written) = std::fs::read_dir(plans)
        .ok()?
        .flatten()
        .filter(|e| e.file_name().to_str().is_some_and(|n| n.ends_with(&suffix)))
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let written = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64;
            (meta.is_file() && meta.len() <= PLAN_FILE_MAX).then(|| (e.path(), written))
        })
        .max_by_key(|(_, written)| *written)?;
    // R4-S1: while the menu is up nothing after the plan is flushed; when
    // Claude works on (an Edit of the plan file in a later turn), later
    // entries overtake it. The entries' own times, not the file's mtime: the
    // flush before the menu may land after the plan file was written.
    if written <= after_ms || written <= last_entry_ms {
        return None;
    }
    let mut bytes = Vec::new();
    File::open(&path).ok()?.take(PLAN_FILE_MAX).read_to_end(&mut bytes).ok()?;
    let plan = String::from_utf8_lossy(&bytes).trim().to_string();
    if paste_clean(&plan).trim().is_empty() {
        return None;
    }
    let text = cap_relay(&plan);
    Some(Found { cut: relay_was_cut(&text), text, kind: AnswerKind::Plan, at_ms: Some(written) })
}

/// Whether the tile's conversation is known for sure. `on_windows`: Claude's
/// `sessions/<pid>.json` there is unmeasured (spike §1 b), so a Claude tile
/// without that file is not taken on trust.
pub(crate) fn link_of(live: &LiveConversation, on_windows: bool) -> ConversationLink {
    if live.id.is_none() {
        // Codex with no session claimed: unstarted unless sessions it could
        // be began in its folder (two tiles, a `codex` run outside).
        if live.kind == SessionKind::Codex && !live.newer_elsewhere {
            return ConversationLink::Unstarted;
        }
        return ConversationLink::Ambiguous;
    }
    // Review round 1 (M2, S3): another unclaimed conversation of that CLI
    // was written in the folder since the tile started — unless Claude's own
    // per-process file names this one.
    if live.newer_elsewhere && live.pid_names_it != Some(true) {
        return ConversationLink::Ambiguous;
    }
    match (live.kind, live.pid_names_it) {
        (SessionKind::Codex, _) => ConversationLink::Known,
        (SessionKind::Claude, Some(true)) => ConversationLink::Known,
        // It moved on since the look: read nothing rather than the old one.
        (SessionKind::Claude, Some(false)) => ConversationLink::Ambiguous,
        // No per-process file: the id Plyloft gave at spawn (right until a
        // `/clear`, which writes the file) — on a Mac.
        (SessionKind::Claude, None) if on_windows => ConversationLink::Ambiguous,
        (SessionKind::Claude, None) => ConversationLink::Known,
    }
}

// ── The tail ─────────────────────────────────────────────────────────────

/// The last `n` bytes of `path` and the one before them (so a tail that
/// starts exactly at a line start keeps that line: [`from_line_start`]
/// drops only that newline), and whether they are the whole file.
fn file_tail(path: &Path) -> impl FnMut(u64) -> Option<(Vec<u8>, bool)> + '_ {
    move |n| {
        let mut file = File::open(path).ok()?;
        let len = file.metadata().ok()?.len();
        let take = n.saturating_add(1).min(len);
        file.seek(SeekFrom::Start(len - take)).ok()?;
        let mut bytes = Vec::with_capacity(take as usize);
        file.take(take).read_to_end(&mut bytes).ok()?;
        Some((bytes, take == len))
    }
}

/// Reads a tail of `first` bytes, then four times more, until `parse` finds
/// an answer, the whole file is in, or `max` is reached. `fetch(n)` gives
/// the last `n` bytes and whether that is the whole file.
pub(crate) fn read_tail(
    mut fetch: impl FnMut(u64) -> Option<(Vec<u8>, bool)>,
    parse: impl Fn(&[u8], bool) -> Parsed,
    first: u64,
    max: u64,
) -> Parsed {
    let mut n = first.min(max).max(1);
    loop {
        let Some((bytes, whole)) = fetch(n) else {
            return Parsed { turn: TurnState::None, found: None, earlier: false, last_entry_ms: None, planning: None, prompt_ms: None, plan_waits: false, plan_answered: false, plan_refused_ms: None, plan_unread: false, asks: None, newest_asks: None };
        };
        let parsed = parse(from_line_start(&bytes, whole), whole);
        // A plan that can't be read back stops the search too: what lies
        // further back is older than it.
        if parsed.found.is_some() || parsed.plan_unread || whole || n >= max {
            return parsed;
        }
        n = n.saturating_mul(4).min(max);
    }
}

/// A tail that isn't the whole file may start mid-line: from the first
/// whole line on (its first byte is the one before the tail asked for).
fn from_line_start(bytes: &[u8], whole: bool) -> &[u8] {
    if whole {
        return bytes;
    }
    match bytes.iter().position(|b| *b == b'\n') {
        Some(i) => &bytes[i + 1..],
        None => &[],
    }
}

fn line_ms(entry: &Value) -> Option<i64> {
    let at = entry.get("timestamp")?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(at).ok().map(|t| t.timestamp_millis())
}

// ── Claude ───────────────────────────────────────────────────────────────

/// Claude plan mode: the plan in an `ExitPlanMode` tool call's input.
/// MEASURED (Claude Code 2.1.331, `MEASURE-planmode.md`): `input = { plan:
/// <markdown string>, planFilePath: <abs path> }`; leniently, the first
/// string found under `plan` (never `planFilePath`, a path, not the plan).
pub(crate) fn exit_plan_mode_plan(input: &Value) -> Option<String> {
    fn first_string(v: &Value) -> Option<&str> {
        match v {
            Value::String(s) => Some(s),
            Value::Array(items) => items.iter().find_map(first_string),
            Value::Object(map) => map.values().find_map(first_string),
            _ => None,
        }
    }
    first_string(input.get("plan")?).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

const EXIT_PLAN_MODE: &str = "ExitPlanMode";

/// What `ClaudeFold` leaves out and Compare needs: each plan by its tool
/// call's id, and when each message or tool call was written.
#[derive(Default)]
struct ClaudeSide {
    plans: std::collections::HashMap<String, String>,
    times: std::collections::HashMap<String, i64>,
    /// The last timestamped entry's time, of any kind.
    last_at: Option<i64>,
    /// The prompts (by `uuid`) sent in plan mode.
    plan_prompts: std::collections::HashSet<String>,
    /// Each user entry's time, by `uuid`.
    prompt_times: std::collections::HashMap<String, i64>,
    /// The line each tool call was written on, by its id.
    tool_lines: std::collections::HashMap<String, usize>,
    /// The line each tool call's result was written on, by the call's id.
    result_lines: std::collections::HashMap<String, usize>,
    /// Each `Write` or `Edit` call: whether it is an Edit, its file, its input.
    writes: std::collections::HashMap<String, (bool, String, Value)>,
    /// A `Write` or `Edit` whose result is on disk: the file's content after
    /// it, `None` when that can't be read (an error, an Edit that can't be
    /// applied to the file it reports).
    written: std::collections::HashMap<String, Option<String>>,
    /// Each ExitPlanMode's `planFilePath`, by its id.
    plan_paths: std::collections::HashMap<String, String>,
    /// The ExitPlanModes refused with the member's feedback: the refusal's time.
    refused_with_feedback: std::collections::HashMap<String, Option<i64>>,
    /// The `sessionId` the transcript's entries carry (the last one seen).
    session_id: Option<String>,
    /// 1.179.0, the member's question: each user entry's own facts, by `uuid`.
    prompts: std::collections::HashMap<String, asks::PromptMeta>,
    /// The line each user entry (by `uuid`) and each assistant message (by
    /// `message.id` and `uuid`, its last line) was written on.
    item_lines: std::collections::HashMap<String, usize>,
    /// Each refusal with a `toolDenialKind`, by the refused call's id.
    refusals: std::collections::HashMap<String, asks::Refusal>,
    /// The lines of a compaction (`compact_boundary`, `isCompactSummary`).
    compactions: Vec<usize>,
    /// Turn ends (`turn_duration`) read so far.
    turn_ends: usize,
}

/// Two spellings of one file path (Windows separators, letter case).
fn same_path(a: &str, b: &str) -> bool {
    let norm = |p: &str| p.replace('\\', "/").to_lowercase();
    norm(a) == norm(b)
}

/// Whether `path` is this session's plan file, for an ExitPlanMode that
/// doesn't name it (measured, 2.1.332: a session's first ExitPlanMode can come
/// with an empty input; every later one names the same file). Tied to the
/// session, never guessed from a folder: the file another ExitPlanMode in
/// the tail names, or `plans/<slug>-of-<session id>.md` (the name Claude gives
/// it, in its config folder). A project's own `docs/plans/*.md` is neither.
fn is_session_plan_file(path: &str, side: &ClaudeSide) -> bool {
    if side.plan_paths.values().any(|named| same_path(path, named)) {
        return true;
    }
    let Some(session) = side.session_id.as_deref().filter(|s| !s.is_empty()) else { return false };
    let path = path.replace('\\', "/").to_lowercase();
    let mut parts = path.rsplit('/');
    let name = parts.next().unwrap_or("");
    name.ends_with(&format!("-of-{}.md", session.to_lowercase())) && parts.next() == Some("plans")
}

/// The file's content after a successful `Write` or `Edit`, from its result
/// (`toolUseResult`, when it is that call's own) and its input. An Edit
/// needs the file as it was (`originalFile`) and its old text in it.
fn content_after_write(edit: bool, input: &Value, result: Option<&Value>) -> Option<String> {
    fn text<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a str> {
        v.and_then(|v| v.get(key)).and_then(Value::as_str)
    }
    if !edit {
        return text(result, "content").or_else(|| text(Some(input), "content")).map(str::to_string);
    }
    let original = text(result, "originalFile")?;
    let old = text(result, "oldString").or_else(|| text(Some(input), "old_string"))?;
    let new = text(result, "newString").or_else(|| text(Some(input), "new_string"))?;
    let all = result.and_then(|r| r.get("replaceAll")).or_else(|| input.get("replace_all")).and_then(Value::as_bool)
        == Some(true);
    if old.is_empty() {
        // An Edit with no old text creates the file: only an empty one.
        return original.is_empty().then(|| new.to_string());
    }
    if !original.contains(old) {
        return None;
    }
    Some(if all { original.replace(old, new) } else { original.replacen(old, new, 1) })
}

/// A tool result's text, whether Claude wrote it as a string or as blocks.
fn result_text(block: &Value) -> String {
    match &block["content"] {
        Value::String(s) => s.clone(),
        Value::Array(parts) => {
            parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n")
        }
        _ => String::new(),
    }
}

fn claude_side(text: &str) -> ClaudeSide {
    let mut side = ClaudeSide::default();
    for (index, line) in text.lines().enumerate() {
        let Ok(entry) = serde_json::from_str::<Value>(line.trim()) else { continue };
        if let Some(at) = line_ms(&entry) {
            side.last_at = Some(at);
        }
        if let Some(session) = entry.get("sessionId").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            side.session_id = Some(session.to_string());
        }
        let sidechain = entry.get("isSidechain").and_then(Value::as_bool) == Some(true);
        let kind = entry.get("type").and_then(Value::as_str);
        if !sidechain {
            if kind == Some("system") && entry.get("subtype").and_then(Value::as_str) == Some("turn_duration") {
                side.turn_ends += 1;
            }
            if (kind == Some("system") && entry.get("subtype").and_then(Value::as_str) == Some("compact_boundary"))
                || entry.get("isCompactSummary").and_then(Value::as_bool) == Some(true)
            {
                side.compactions.push(index);
            }
            if let Some(uuid) = entry.get("uuid").and_then(Value::as_str) {
                if matches!(kind, Some("user" | "assistant")) {
                    side.item_lines.insert(uuid.to_string(), index);
                }
                if kind == Some("user") {
                    let text_of = |key: &str| entry.get(key).and_then(Value::as_str).map(str::to_string);
                    side.prompts.entry(uuid.to_string()).or_insert(asks::PromptMeta {
                        source: text_of("promptSource"),
                        origin: entry.get("origin").and_then(|o| o.get("kind")).and_then(Value::as_str).map(str::to_string),
                        turn_index: entry.get("turnPosition").and_then(|t| t.get("turnIndex")).and_then(Value::as_i64),
                        ends_before: side.turn_ends,
                    });
                }
            }
            if kind == Some("assistant") {
                if let Some(id) = entry["message"].get("id").and_then(Value::as_str) {
                    side.item_lines.insert(id.to_string(), index);
                }
            }
        }
        if entry.get("type").and_then(Value::as_str) == Some("user") && !sidechain {
            // Tool results (only `user` entries: request copies such as
            // `api-request-blob` repeat tool calls with other inputs).
            let results: Vec<&Value> = entry["message"]["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
                .collect();
            for block in &results {
                let Some(id) = block.get("tool_use_id").and_then(Value::as_str) else { continue };
                side.result_lines.entry(id.to_string()).or_insert(index);
                let is_error = block.get("is_error").and_then(Value::as_bool) == Some(true);
                if let Some((edit, path, input)) = side.writes.get(id) {
                    // `toolUseResult` is the entry's, so only an entry with one
                    // result, and only when it names the same file.
                    let own = entry.get("toolUseResult").filter(|_| results.len() == 1).filter(|r| {
                        r.get("filePath").and_then(Value::as_str).map_or(true, |p| same_path(p, path))
                    });
                    let content = if is_error { None } else { content_after_write(*edit, input, own) };
                    side.written.entry(id.to_string()).or_insert(content);
                }
                // Measured (2.1.332): "Tell Claude what to change" is a
                // `user-rejected` refusal whose text carries the member's words
                // after "the user said"; the turn goes on.
                if is_error
                    && entry.get("toolDenialKind").and_then(Value::as_str) == Some("user-rejected")
                    && result_text(block).contains("the user said")
                {
                    side.refused_with_feedback.entry(id.to_string()).or_insert(line_ms(&entry));
                }
                if let Some(denial) = entry.get("toolDenialKind").and_then(Value::as_str) {
                    side.refusals.entry(id.to_string()).or_insert(asks::Refusal {
                        line: index,
                        at_ms: line_ms(&entry),
                        denial: denial.to_string(),
                        text: result_text(block),
                    });
                }
            }
        }
        if let (Some("user"), Some(uuid), Some(at)) =
            (entry.get("type").and_then(Value::as_str), entry.get("uuid").and_then(Value::as_str), line_ms(&entry))
        {
            side.prompt_times.insert(uuid.to_string(), at);
        }
        if entry.get("type").and_then(Value::as_str) == Some("user")
            && entry.get("permissionMode").and_then(Value::as_str) == Some("plan")
        {
            if let Some(uuid) = entry.get("uuid").and_then(Value::as_str) {
                side.plan_prompts.insert(uuid.to_string());
            }
        }
        if entry.get("type").and_then(Value::as_str) != Some("assistant")
            || entry.get("isSidechain").and_then(Value::as_bool) == Some(true)
        {
            continue;
        }
        let message = &entry["message"];
        let at = line_ms(&entry);
        if let (Some(id), Some(at)) = (message.get("id").and_then(Value::as_str), at) {
            side.times.insert(id.to_string(), at);
        }
        for block in message["content"].as_array().into_iter().flatten() {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let Some(id) = block.get("id").and_then(Value::as_str) else { continue };
            if let Some(at) = at {
                side.times.insert(id.to_string(), at);
            }
            side.tool_lines.entry(id.to_string()).or_insert(index);
            let input = &block["input"];
            match block.get("name").and_then(Value::as_str) {
                Some(EXIT_PLAN_MODE) => {
                    if let Some(plan) = exit_plan_mode_plan(input) {
                        side.plans.insert(id.to_string(), plan);
                    }
                    if let Some(path) = input.get("planFilePath").and_then(Value::as_str) {
                        side.plan_paths.insert(id.to_string(), path.to_string());
                    }
                }
                Some(name @ ("Write" | "Edit")) => {
                    if let Some(path) = input.get("file_path").and_then(Value::as_str) {
                        side.writes.entry(id.to_string()).or_insert((name == "Edit", path.to_string(), input.clone()));
                    }
                }
                _ => {}
            }
        }
    }
    side
}

/// The newest finished answer in a Claude transcript's tail, and the
/// current turn. `whole`: the tail is the whole file (else the first turn in
/// it may have lost its beginning).
pub(crate) fn claude_tail(bytes: &[u8], whole: bool) -> Parsed {
    let mut fold = ClaudeFold::default();
    // A half-written last line waits in the fold: not read.
    fold.push_bytes(bytes);
    let items = fold.take_dirty();
    let side = claude_side(&String::from_utf8_lossy(bytes));
    let state = fold.state();
    // Turns: each starts at a prompt (or a `!` command); what comes before
    // the first one is the end of a turn whose start lies before the tail.
    let mut starts: Vec<usize> =
        items.iter().enumerate().filter(|(_, it)| matches!(it, ChatItem::User { .. } | ChatItem::Shell { .. })).map(|(i, _)| i).collect();
    let headless = starts.first() != Some(&0);
    if headless {
        starts.insert(0, 0);
    }
    let count = starts.len();
    let segment = |n: usize| &items[starts[n]..starts.get(n + 1).copied().unwrap_or(items.len())];
    // Review round 1 (M1, measured): a local command (`/model`, `/clear`,
    // `/rename`…) or a `!` command that nothing answered is no turn: Claude
    // writes no `turn_duration` after it, so the fold would stay Working.
    let real: Vec<bool> = (0..count).map(|n| !segment(n).is_empty() && !segment(n).iter().all(local_command)).collect();
    let Some(newest) = real.iter().rposition(|r| *r) else {
        return Parsed { turn: TurnState::None, found: None, earlier: false, last_entry_ms: side.last_at, planning: None, prompt_ms: None, plan_waits: false, plan_answered: false, plan_refused_ms: None, plan_unread: false, asks: None, newest_asks: None };
    };
    // 1.179.0: the member's question, read with the answer of the same turn.
    let segments: Vec<&[ChatItem]> = (0..count).map(segment).collect();
    let asks_of = |n: usize| asks::claude_asks(&segments, headless, n, &side);
    let newest_asks = Some(asks_of(newest));
    let turn = if newest + 1 < count || state == ChatState::Ready { TurnState::Done } else { TurnState::Open };
    // Walk 6: whether the open turn is a planning one — its prompt sent in
    // plan mode (`permissionMode: "plan"`, measured), or an ExitPlanMode in it.
    let planning = (turn == TurnState::Open).then(|| {
        let current = segment(newest);
        // R5-N2 (unmeasured, lenient): EnterPlanMode too.
        let exits = current
            .iter()
            .any(|it| matches!(it, ChatItem::Tool { name, .. } if name == EXIT_PLAN_MODE || name == "EnterPlanMode"));
        match current.first() {
            _ if exits => Some(true),
            Some(ChatItem::User { id, .. }) if !(newest == 0 && headless) => Some(side.plan_prompts.contains(id)),
            Some(ChatItem::Shell { .. }) if !(newest == 0 && headless) => Some(false),
            _ => None,
        }
    }).flatten();
    let prompt_ms = match segment(newest).first() {
        Some(ChatItem::User { id, .. } | ChatItem::Shell { id, .. }) if turn == TurnState::Open && !(newest == 0 && headless) => {
            side.prompt_times.get(id).copied()
        }
        _ => None,
    };
    // F4: the open turn's plan still waits for its menu only while its
    // ExitPlanMode is the turn's last step and has no result.
    let plan_waits = turn == TurnState::Open
        && matches!(
            segment(newest).iter().rev().find(|it| match it {
                ChatItem::Assistant { text, is_error, .. } => !is_error && !text.trim().is_empty(),
                ChatItem::Tool { .. } | ChatItem::Shell { .. } => true,
                _ => false,
            }),
            Some(ChatItem::Tool { name, outcome: ToolOutcome::Running, .. }) if name == EXIT_PLAN_MODE
        );
    let plan_answered = turn == TurnState::Open
        && segment(newest)
            .iter()
            .any(|it| matches!(it, ChatItem::Tool { name, outcome, .. } if name == EXIT_PLAN_MODE && *outcome != ToolOutcome::Running));
    // B1 (measured, 2.1.332): the open turn's last ExitPlanMode on disk was
    // refused with feedback; the next plan's menu can be up with none of it
    // flushed.
    let plan_refused_ms = if turn == TurnState::Open {
        segment(newest)
            .iter()
            .rev()
            .find_map(|it| match it {
                ChatItem::Tool { id, name, .. } if name == EXIT_PLAN_MODE => Some(id),
                _ => None,
            })
            .and_then(|id| side.refused_with_feedback.get(id).copied().flatten())
    } else {
        None
    };
    for n in (0..=newest).rev().filter(|n| real[*n]) {
        let ended = n != newest || turn == TurnState::Done;
        let cut_head = n == 0 && headless && !whole;
        match claude_turn_answer(segment(n), n == 0 && headless, ended, cut_head, &side) {
            TurnAnswer::Found(found) => {
                // S1: the newest turn ended without an answer of its own.
                let earlier = n != newest && turn == TurnState::Done;
                let asks = Some(if n == newest { newest_asks.clone().unwrap_or_else(|| asks_of(n)) } else { asks_of(n) });
                return Parsed { turn, found: Some(found), earlier, last_entry_ms: side.last_at, planning, prompt_ms, plan_waits, plan_answered, plan_refused_ms, plan_unread: false, asks, newest_asks };
            }
            // B1: never an older turn's answer instead of a plan that can't
            // be read. An open turn's plan file may still stand in.
            TurnAnswer::PlanUnread => {
                return Parsed { turn, found: None, earlier: false, last_entry_ms: side.last_at, planning, prompt_ms, plan_waits, plan_answered, plan_refused_ms, plan_unread: ended, asks: None, newest_asks };
            }
            TurnAnswer::Nothing => {}
        }
    }
    Parsed { turn, found: None, earlier: false, last_entry_ms: side.last_at, planning, prompt_ms, plan_waits, plan_answered, plan_refused_ms, plan_unread: false, asks: None, newest_asks }
}

/// A local command's line (`<command-name>…`, `<command-message>…`) or a `!`
/// command: part of a turn only when Claude answers after it.
fn local_command(item: &ChatItem) -> bool {
    match item {
        ChatItem::User { text, .. } => {
            let text = text.trim_start();
            text.starts_with("<command-name>") || text.starts_with("<command-message>")
        }
        ChatItem::Shell { .. } => true,
        _ => false,
    }
}

/// One turn's answer. `headless`: the turn's prompt is not among `items`;
/// `cut_head`: and it may lie before the tail, so only text after a tool
/// call in view is surely whole.
fn claude_turn_answer(items: &[ChatItem], headless: bool, ended: bool, cut_head: bool, side: &ClaudeSide) -> TurnAnswer {
    let speaks = |it: &ChatItem| match it {
        ChatItem::Assistant { text, is_error, .. } => !is_error && !text.trim().is_empty(),
        ChatItem::Tool { .. } | ChatItem::Shell { .. } => true,
        _ => false,
    };
    let body = if headless { items } else { &items[1..] };
    // Plan mode (measured, Claude Code 2.1.331): the turn's last step is the
    // plan while its menu is up (the narration just before it is not the
    // answer). After it (unmeasured: Approve, "keep planning", Esc) a turn
    // that ended with text answers with that text; otherwise the plan stays.
    let plan = turn_plan(body, side);
    let plan_found = || match &plan {
        TurnPlan::Known(id, plan) => {
            let text = cap_relay(plan);
            TurnAnswer::Found(Found { cut: relay_was_cut(&text), text, kind: AnswerKind::Plan, at_ms: side.times.get(*id).copied() })
        }
        TurnPlan::None => TurnAnswer::Nothing,
        TurnPlan::Unread => TurnAnswer::PlanUnread,
    };
    if matches!(body.iter().rev().find(|it| speaks(it)), Some(ChatItem::Tool { name, .. }) if name == EXIT_PLAN_MODE) {
        return plan_found();
    }
    if !ended || items.iter().any(|it| matches!(it, ChatItem::Interrupted { .. })) {
        return plan_found();
    }
    if cut_head && !body.iter().any(|it| matches!(it, ChatItem::Tool { .. } | ChatItem::Shell { .. })) {
        return plan_found();
    }
    // Plan with two AIs' rule, on Plyloft's chat messages.
    const HEAD: &str = "compare-turn-head";
    let mut conversation = ChatConversation::new(ChatVendor::Claude, 0);
    let mut head = ChatMessage::new("user", "", 0);
    head.id = HEAD.into();
    conversation.messages.push(head);
    for item in body {
        let mut message = match item {
            ChatItem::User { text, .. } => ChatMessage::new("user", text.clone(), 0),
            ChatItem::Assistant { text, is_error, .. } => {
                let mut m = ChatMessage::new("assistant", text.clone(), 0);
                m.is_error = *is_error;
                m
            }
            ChatItem::Tool { .. } => ChatMessage::new("tool", "", 0),
            ChatItem::Shell { .. } => ChatMessage::new("shell", "", 0),
            ChatItem::Interrupted { .. } => ChatMessage::new("interrupted", "", 0),
        };
        message.id = item.id().to_string();
        conversation.messages.push(message);
    }
    let Some((text, last_id)) = final_answer(&conversation, HEAD) else { return plan_found() };
    TurnAnswer::Found(Found { cut: relay_was_cut(&text), at_ms: side.times.get(&last_id).copied(), text, kind: AnswerKind::Text })
}

/// What one turn gives Compare.
enum TurnAnswer {
    Found(Found),
    /// Nothing of its own: an earlier turn's answer may stand.
    Nothing,
    /// It ended on a plan that can't be read back: nothing at all.
    PlanUnread,
}

/// A turn's plan: that of its last ExitPlanMode, readable or not.
enum TurnPlan<'a> {
    /// The ExitPlanMode's id, and its plan.
    Known(&'a str, String),
    None,
    Unread,
}

/// B1 (measured, Claude Code 2.1.332): when Claude writes the plan file and
/// calls ExitPlanMode in one message and the write's result lands after the
/// ExitPlanMode, its `input.plan` is the file as it was before that write
/// (the previous plan, or none). So the plan is the content after the last
/// write of the plan file since the turn's previous ExitPlanMode (or its
/// start), made before this one's result, when that write's result lands
/// after it; a write whose result came first left `input.plan` right, and so
/// does no write at all. A write whose content can't be read (no result yet,
/// an error, an Edit that can't be applied) makes the plan unknown: never
/// `input.plan`, never an older ExitPlanMode's. The plan file is the one the
/// ExitPlanMode names, else one tied to this session
/// ([`is_session_plan_file`]); any other file is no write of the plan.
fn turn_plan<'a>(body: &'a [ChatItem], side: &ClaudeSide) -> TurnPlan<'a> {
    let tools: Vec<(&str, &str)> = body
        .iter()
        .filter_map(|it| match it {
            ChatItem::Tool { id, name, .. } => Some((id.as_str(), name.as_str())),
            _ => None,
        })
        .collect();
    let Some(last) = tools.iter().rposition(|(_, name)| *name == EXIT_PLAN_MODE) else { return TurnPlan::None };
    let exit = tools[last].0;
    let since = tools[..last].iter().rposition(|(_, name)| *name == EXIT_PLAN_MODE).map_or(0, |p| p + 1);
    let plan_file = side.plan_paths.get(exit);
    let is_plan_file = |path: &str| match plan_file {
        Some(file) => same_path(path, file),
        None => is_session_plan_file(path, side),
    };
    let until = side.result_lines.get(exit).copied().unwrap_or(usize::MAX);
    let write = tools[since..]
        .iter()
        .map(|(id, _)| *id)
        .filter(|id| side.writes.get(*id).is_some_and(|(_, path, _)| is_plan_file(path.as_str())))
        .filter(|id| side.tool_lines.get(*id).is_some_and(|line| *line < until))
        .last();
    let from_input = side.plans.get(exit).cloned();
    let plan = match write {
        None => from_input,
        Some(id) => {
            let came_first = matches!(
                (side.result_lines.get(id), side.tool_lines.get(exit)),
                (Some(result), Some(call)) if result < call
            );
            if came_first {
                // The write landed first, so `input.plan` is that write's
                // content; an ExitPlanMode that carries none still has it
                // in the write.
                from_input.or_else(|| match side.written.get(id) {
                    Some(Some(content)) => Some(content.trim().to_string()).filter(|c| !c.is_empty()),
                    _ => None,
                })
            } else {
                match side.written.get(id) {
                    Some(Some(content)) => Some(content.trim().to_string()).filter(|c| !c.is_empty()),
                    _ => return TurnPlan::Unread,
                }
            }
        }
    };
    match plan {
        Some(plan) => TurnPlan::Known(exit, plan),
        None => TurnPlan::None,
    }
}

// ── Codex ────────────────────────────────────────────────────────────────

/// An assistant `response_item` message's text when it is a final answer
/// (`payload.phase == "final_answer"`, its `output_text` parts joined).
fn codex_final_answer(payload: &Value) -> Option<String> {
    if payload.get("type").and_then(Value::as_str) != Some("message")
        || payload.get("role").and_then(Value::as_str) != Some("assistant")
        || payload.get("phase").and_then(Value::as_str) != Some("final_answer")
    {
        return None;
    }
    let parts: Vec<&str> = payload["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p.get("type").and_then(Value::as_str) == Some("output_text"))
        .filter_map(|p| p.get("text").and_then(Value::as_str))
        .collect();
    let text = parts.join("\n").trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// The newest finished answer in a Codex rollout's tail, and the current
/// turn: `task_complete.last_agent_message` (as `intake` reads it), else
/// that turn's last `final_answer` message; a `turn_aborted` turn has none.
pub(crate) fn codex_tail(bytes: &[u8], whole: bool) -> Parsed {
    let text = String::from_utf8_lossy(bytes);
    let mut open = false;
    let mut marked = false;
    let mut records = false;
    // S1: whether the newest ended turn ended with an answer of its own.
    let mut last_end_answered = true;
    let mut in_turn: Option<(String, Option<i64>)> = None;
    let mut answer: Option<(String, Option<i64>)> = None;
    // 1.179.0: the member's messages of the turn under way, and of `answer`'s.
    let mut asking = asks::CodexTurn::default();
    let mut answer_asks: Option<TurnAsks> = None;
    for line in text.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line.trim()) else { continue };
        // Unmeasured: what a compaction keeps of the turn's messages.
        if entry.get("type").and_then(Value::as_str) == Some("compacted") {
            asking.mark(asks::AsksUnknown::Compacted);
        }
        let Some(payload) = entry.get("payload") else { continue };
        records = true;
        let kind = payload.get("type").and_then(Value::as_str);
        match (entry.get("type").and_then(Value::as_str), kind) {
            (Some("event_msg"), Some("task_started")) => {
                open = true;
                marked = true;
                in_turn = None;
                asking = asks::CodexTurn::started();
            }
            (Some("event_msg"), Some("task_complete")) => {
                open = false;
                marked = true;
                let last = payload
                    .get("last_agent_message")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .map(|t| (t.to_string(), line_ms(&entry)));
                last_end_answered = false;
                if let Some(found) = last.or_else(|| in_turn.take()) {
                    answer = Some(found);
                    answer_asks = Some(asking.finish());
                    last_end_answered = true;
                }
                in_turn = None;
                asking = asks::CodexTurn::default();
            }
            (Some("event_msg"), Some("turn_aborted")) => {
                open = false;
                marked = true;
                last_end_answered = false;
                in_turn = None;
                asking = asks::CodexTurn::default();
            }
            (Some("event_msg"), Some("user_message")) => asking.event(payload, line_ms(&entry)),
            (Some("event_msg"), Some("context_compacted")) => asking.mark(asks::AsksUnknown::Compacted),
            // Unmeasured: a review's own messages aren't the member's words.
            (Some("event_msg"), Some("entered_review_mode")) => asking.mark(asks::AsksUnknown::Command),
            (Some("response_item"), _) => {
                if let Some(text) = codex_final_answer(payload) {
                    in_turn = Some((text, line_ms(&entry)));
                }
                if matches!(kind, Some("compaction" | "compaction_summary")) {
                    asking.mark(asks::AsksUnknown::Compacted);
                }
                asking.item(payload, line_ms(&entry));
            }
            _ => {}
        }
    }
    // A whole rollout that marks no turn at all: its last final answer. A
    // partial tail without a marker (S2) is inside a turn longer than it.
    if !marked && answer.is_none() && whole {
        answer = in_turn;
        // Case 8: no turn marker, so no turn start to read the question from.
        answer_asks = answer.is_some().then_some(TurnAsks::Unknown { why: asks::AsksUnknown::StartNotRead });
    }
    let turn = if open || (!whole && !marked && records) {
        TurnState::Open
    } else if marked || answer.is_some() {
        TurnState::Done
    } else {
        TurnState::None
    };
    let found = answer.map(|(text, at_ms)| {
        let text = cap_relay(&text);
        Found { cut: relay_was_cut(&text), text, kind: AnswerKind::Text, at_ms }
    });
    let earlier = turn == TurnState::Done && found.is_some() && !last_end_answered;
    let asks = if found.is_some() { answer_asks } else { None };
    Parsed { turn, found, earlier, last_entry_ms: None, planning: None, prompt_ms: None, plan_waits: false, plan_answered: false, plan_refused_ms: None, plan_unread: false, asks, newest_asks: None }
}

// ── The text to paste ────────────────────────────────────────────────────

/// The pieces the window composed, in its own words (no English here).
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteParts {
    #[serde(default)]
    pub lead: Option<String>,
    pub answer: String,
    #[serde(default)]
    pub note: Option<String>,
    pub from_label: String,
    #[serde(default)]
    pub note_label: Option<String>,
    /// 1.179.0, "Include my question": the member's own words of the answer's
    /// turn, as the window made them from `turnAsks` (passed text taken out).
    /// Absent or blank: no question block, and the text as before.
    #[serde(default)]
    pub question: Option<String>,
    /// `My question to Claude:` or `My question to Codex:`.
    #[serde(default)]
    pub question_label: Option<String>,
    /// The question was already cut when read (`turnAsks.cut`): it always
    /// goes with its cut line.
    #[serde(default)]
    pub question_cut: bool,
}

/// What `compare_prepare_paste` gives: the text written, and what it holds,
/// so the composer's preview and the write come from the same function.
#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPaste {
    /// What is written, as before (empty when the answer is blank).
    pub text: String,
    /// The question exactly as it goes in `text` (cleaned, cut), without its
    /// label; absent when none was given, it was blank, or it was left out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    /// The question goes cut, ending in its cut line.
    pub question_cut: bool,
    /// A question was given but left out: less than [`QUESTION_MIN_ROOM`]
    /// characters were left for it, or the answer itself had to be cut.
    pub question_left_out: bool,
    /// The frame (lead, labels, note) made this function cut the answer.
    pub answer_cut: bool,
}

/// Never the text: a stray `{:?}` must not log what goes into a tile.
impl std::fmt::Debug for PreparedPaste {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparedPaste")
            .field("chars", &self.text.chars().count())
            .field("question_chars", &self.question.as_ref().map(|q| q.chars().count()))
            .field("question_cut", &self.question_cut)
            .field("question_left_out", &self.question_left_out)
            .field("answer_cut", &self.answer_cut)
            .finish()
    }
}

/// The question's own cut line, where it was cut.
const QUESTION_CUT: &str = "\n[Plyloft cut your question here to fit 16,000 characters]";
/// Owner's decision: with less room than this the question is left out whole.
pub(crate) const QUESTION_MIN_ROOM: usize = 200;

/// One text safe to paste into a Claude or Codex composer, and what it
/// holds ([`PreparedPaste`]): every piece
/// cleaned as a chat message is (no control character but newline — so no
/// ESC, no CR, no bracketed-paste end — and a leading space, so a `!` or `/`
/// is never read as a command), less bidi and zero-width characters, a tab
/// as a space ([`paste_clean`]), laid out as
///
/// ```text
///  <lead>
///
/// <questionLabel>
/// <question>
///
/// <fromLabel>
/// <answer>
///
/// <noteLabel>
/// <note>
/// ```
///
/// (an empty lead, question or note leaves its block out), at most 16,000
/// characters. The question is cut first, with its own cut line, and left
/// out when less than [`QUESTION_MIN_ROOM`] is left for it; the answer is cut
/// only when the frame without any question leaves it too little room, with
/// the relay's cut line, as before. A blank answer gives an empty text.
#[tauri::command]
pub fn compare_prepare_paste(parts: PasteParts) -> PreparedPaste {
    prepare(&parts)
}

/// [`clean_text`] (U+2028/U+2029 first made new lines, which it would
/// drop), less what hides or reorders text (bidi controls, the zero-width
/// space and BOM; the joiners U+200C/U+200D stay, emoji and Persian or Indic
/// text need them), and a tab as four spaces (a key replay must never send
/// it as Tab).
pub(crate) fn paste_clean(text: &str) -> String {
    let lines: String = text.chars().map(|c| if matches!(c, '\u{2028}' | '\u{2029}') { '\n' } else { c }).collect();
    let mut out = String::with_capacity(lines.len());
    for c in clean_text(&lines).chars() {
        match c {
            '\t' => out.push_str("    "),
            '\u{200B}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}' => {}
            c => out.push(c),
        }
    }
    out
}

/// The text alone ([`prepare`]): the tests that pin it byte for byte.
#[cfg(test)]
pub(crate) fn prepare_paste(parts: &PasteParts) -> String {
    prepare(parts).text
}

pub(crate) fn prepare(parts: &PasteParts) -> PreparedPaste {
    let piece = |s: Option<&str>| s.map(|s| paste_clean(s).trim().to_string()).filter(|s| !s.is_empty());
    let mut out = PreparedPaste { text: String::new(), question: None, question_cut: false, question_left_out: false, answer_cut: false };
    let Some(answer) = piece(Some(&parts.answer)) else {
        // Nothing to hand over: never a lead and label alone.
        return out;
    };
    let lead = piece(parts.lead.as_deref());
    let from = piece(Some(&parts.from_label)).unwrap_or_default();
    let note = piece(parts.note.as_deref());
    let note_label = piece(parts.note_label.as_deref());
    let question = piece(parts.question.as_deref());
    let question_label = piece(parts.question_label.as_deref());
    let labelled = |label: Option<&str>, body: &str| {
        [label.unwrap_or(""), body].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join("\n")
    };
    let assemble = |question: Option<&str>, answer: &str| {
        let mut blocks: Vec<String> = Vec::new();
        if let Some(lead) = &lead {
            blocks.push(lead.clone());
        }
        if let Some(question) = question {
            blocks.push(labelled(question_label.as_deref(), question));
        }
        blocks.push(labelled(Some(from.as_str()), answer));
        if let Some(note) = &note {
            blocks.push(match &note_label {
                Some(label) => format!("{label}\n{note}"),
                None => note.clone(),
            });
        }
        blocks.join("\n\n")
    };
    // The leading space counts toward the cap.
    let cap = RELAY_CAP - 1;
    let frame = assemble(None, "").chars().count();
    let answer_room = cap.saturating_sub(frame + 1); // the newline after the label
    let answer_fits = answer.chars().count() <= answer_room;
    // The question takes only the room the whole answer leaves: it is cut
    // first, and never makes the answer shorter.
    let mut asked: Option<String> = None;
    if let Some(question) = &question {
        if answer_fits {
            let without = assemble(None, &answer).chars().count();
            // Its label and newline, and the blank line that parts it from the next block.
            let overhead = 2 + question_label.as_ref().map_or(0, |l| l.chars().count() + 1);
            let room = cap.saturating_sub(without + overhead);
            match cut_question(question, room, parts.question_cut) {
                Some((text, cut)) => {
                    asked = Some(text);
                    out.question_cut = cut;
                }
                None => out.question_left_out = true,
            }
        } else {
            out.question_left_out = true;
        }
    }
    out.answer_cut = !answer_fits;
    let text = assemble(asked.as_deref(), &cap_with_cut(&answer, answer_room));
    // A frame too long on its own (a very long note): the whole is cut. A
    // question is never in it then (the answer didn't fit).
    let capped = cap_with_cut(&text, cap);
    if capped != text {
        out.answer_cut = true;
    }
    out.text = crate::chat::composer_text(&capped);
    out.question = asked;
    out
}

/// The question within `room` characters, and whether it goes cut: whole
/// when it fits (with its cut line when it was cut when read), else cut
/// with its cut line; `None` when less than [`QUESTION_MIN_ROOM`] is left.
fn cut_question(question: &str, room: usize, cut_when_read: bool) -> Option<(String, bool)> {
    let len = question.chars().count();
    let line = QUESTION_CUT.chars().count();
    if !cut_when_read && len <= room {
        return Some((question.to_string(), false));
    }
    if cut_when_read && len + line <= room {
        return Some((format!("{question}{QUESTION_CUT}"), true));
    }
    if room < QUESTION_MIN_ROOM {
        return None;
    }
    let mut cut: String = question.chars().take(room - line).collect();
    cut.push_str(QUESTION_CUT);
    Some((cut, true))
}

#[cfg(test)]
#[path = "compare_tests.rs"]
mod tests;
