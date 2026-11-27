//! Compare (1.177.0): the last finished answer of a Claude or Codex tile,
//! read from the CLI's own file, and the one cleaned text the window pastes
//! into the other tile on the member's press. Spike:
//! `~/ply-build/next-1177/SPIKE-backend.md`.
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
    /// The answer is Claude's plan file, read while the approval menu is up
    /// (the log's fact; not sent to the window).
    #[serde(skip)]
    pub from_plan_file: bool,
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
            .finish_non_exhaustive()
    }
}

impl CompareAnswer {
    fn without_answer(vendor: Option<Vendor>, conversation: ConversationLink, title: Option<String>, turn: TurnState) -> Self {
        CompareAnswer { vendor, conversation, title, turn, answer: None, answer_kind: None, finished_at_ms: None, chars: None, cut: false, from_earlier_turn: false, plan_pending: false, from_plan_file: false }
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
        "compare: tile read pid={:?} seen(id, pid_names_it, newer_elsewhere, file_bytes)={:?} -> conversation={:?} turn={:?} kind={:?} chars={:?} earlier={} cut={} plan_file={} plan_pending={}",
        pid,
        seen,
        out.conversation,
        out.turn,
        out.answer_kind,
        out.chars,
        out.from_earlier_turn,
        out.cut,
        out.from_plan_file,
        out.plan_pending
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
            }
        }
    }
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
        let file_waits = out.from_plan_file && !parsed.plan_answered;
        out.plan_pending = parsed.turn == TurnState::Open
            && found.kind == AnswerKind::Plan
            && (file_waits || parsed.plan_waits);
        out.answer = Some(found.text);
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
            return Parsed { turn: TurnState::None, found: None, earlier: false, last_entry_ms: None, planning: None, prompt_ms: None, plan_waits: false, plan_answered: false };
        };
        let parsed = parse(from_line_start(&bytes, whole), whole);
        if parsed.found.is_some() || whole || n >= max {
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
}

fn claude_side(text: &str) -> ClaudeSide {
    let mut side = ClaudeSide::default();
    for line in text.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line.trim()) else { continue };
        if let Some(at) = line_ms(&entry) {
            side.last_at = Some(at);
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
            if block.get("name").and_then(Value::as_str) == Some(EXIT_PLAN_MODE) {
                if let Some(plan) = exit_plan_mode_plan(&block["input"]) {
                    side.plans.insert(id.to_string(), plan);
                }
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
        return Parsed { turn: TurnState::None, found: None, earlier: false, last_entry_ms: side.last_at, planning: None, prompt_ms: None, plan_waits: false, plan_answered: false };
    };
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
    for n in (0..=newest).rev().filter(|n| real[*n]) {
        let ended = n != newest || turn == TurnState::Done;
        let cut_head = n == 0 && headless && !whole;
        if let Some(found) = claude_turn_answer(segment(n), n == 0 && headless, ended, cut_head, &side) {
            // S1: the newest turn ended without an answer of its own.
            let earlier = n != newest && turn == TurnState::Done;
            return Parsed { turn, found: Some(found), earlier, last_entry_ms: side.last_at, planning, prompt_ms, plan_waits, plan_answered };
        }
    }
    Parsed { turn, found: None, earlier: false, last_entry_ms: side.last_at, planning, prompt_ms, plan_waits, plan_answered }
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
fn claude_turn_answer(items: &[ChatItem], headless: bool, ended: bool, cut_head: bool, side: &ClaudeSide) -> Option<Found> {
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
    let plan = body.iter().rev().find_map(|it| match it {
        ChatItem::Tool { id, name, .. } if name == EXIT_PLAN_MODE => side.plans.get(id).map(|plan| (id, plan)),
        _ => None,
    });
    let plan_found = || {
        plan.map(|(id, plan)| {
            let text = cap_relay(plan);
            Found { cut: relay_was_cut(&text), text, kind: AnswerKind::Plan, at_ms: side.times.get(id).copied() }
        })
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
    Some(Found { cut: relay_was_cut(&text), at_ms: side.times.get(&last_id).copied(), text, kind: AnswerKind::Text })
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
    for line in text.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line.trim()) else { continue };
        let Some(payload) = entry.get("payload") else { continue };
        records = true;
        let kind = payload.get("type").and_then(Value::as_str);
        match (entry.get("type").and_then(Value::as_str), kind) {
            (Some("event_msg"), Some("task_started")) => {
                open = true;
                marked = true;
                in_turn = None;
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
                    last_end_answered = true;
                }
                in_turn = None;
            }
            (Some("event_msg"), Some("turn_aborted")) => {
                open = false;
                marked = true;
                last_end_answered = false;
                in_turn = None;
            }
            (Some("response_item"), _) => {
                if let Some(text) = codex_final_answer(payload) {
                    in_turn = Some((text, line_ms(&entry)));
                }
            }
            _ => {}
        }
    }
    // A whole rollout that marks no turn at all: its last final answer. A
    // partial tail without a marker (S2) is inside a turn longer than it.
    if !marked && answer.is_none() && whole {
        answer = in_turn;
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
    Parsed { turn, found, earlier, last_entry_ms: None, planning: None, prompt_ms: None, plan_waits: false, plan_answered: false }
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
}

/// One text safe to paste into a Claude or Codex composer: every piece
/// cleaned as a chat message is (no control character but newline — so no
/// ESC, no CR, no bracketed-paste end — and a leading space, so a `!` or `/`
/// is never read as a command), less bidi and zero-width characters, a tab
/// as a space ([`paste_clean`]), laid out as
///
/// ```text
///  <lead>
///
/// <fromLabel>
/// <answer>
///
/// <noteLabel>
/// <note>
/// ```
///
/// (an empty lead or note leaves its block out), at most 16,000 characters:
/// the answer is cut first, with the relay's cut line. A blank answer gives
/// an empty string.
#[tauri::command]
pub fn compare_prepare_paste(parts: PasteParts) -> String {
    prepare_paste(&parts)
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

pub(crate) fn prepare_paste(parts: &PasteParts) -> String {
    let piece = |s: Option<&str>| s.map(|s| paste_clean(s).trim().to_string()).filter(|s| !s.is_empty());
    let Some(answer) = piece(Some(&parts.answer)) else {
        // Nothing to hand over: never a lead and label alone.
        return String::new();
    };
    let lead = piece(parts.lead.as_deref());
    let from = piece(Some(&parts.from_label)).unwrap_or_default();
    let note = piece(parts.note.as_deref());
    let note_label = piece(parts.note_label.as_deref());
    let assemble = |answer: &str| {
        let mut blocks: Vec<String> = Vec::new();
        if let Some(lead) = &lead {
            blocks.push(lead.clone());
        }
        blocks.push([from.as_str(), answer].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join("\n"));
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
    let frame = assemble("").chars().count();
    let answer_room = cap.saturating_sub(frame + 1); // the newline after the label
    let text = assemble(&cap_with_cut(&answer, answer_room));
    // A frame too long on its own (a very long note): the whole is cut.
    let text = cap_with_cut(&text, cap);
    crate::chat::composer_text(&text)
}

#[cfg(test)]
#[path = "compare_tests.rs"]
mod tests;
