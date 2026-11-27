//! Compare (1.179.0), "Include my question": the member's own messages of
//! the turn whose answer is on offer, read by the same pass that finds the
//! answer (so they are always that turn's), as the CLI's file has them.
//!
//! - **Claude.** The turn's prompt (`ChatItem::User`, the paste wrapper
//!   unwrapped by the fold), prompts queued into it when the transcript
//!   shows they joined it, and the words typed in a refusal menu ("Tell
//!   Claude what to change" on a plan, measured on 2.1.332: a `user-rejected`
//!   refusal whose text carries them after "the user said:").
//! - **Codex.** The `response_item` user messages between the turn's
//!   `task_started` and its end (measured on 0.172: a message sent while the
//!   turn runs lands there too), less Codex's own injected context; an
//!   `event_msg` `user_message` only when the turn has no such item.
//! - **Fail closed.** Whenever the start of the turn, or whose words they
//!   are, can't be told, the question is `unknown` with its reason, never a
//!   partial list that looks whole.
//! - **Memory only.** Text Compare passed is not taken out here: the window
//!   does that against the passes it holds. Nothing reaches a log or a file,
//!   and `Debug` gives counts only.

use serde::Serialize;
use serde_json::Value;

use super::{local_command, ClaudeSide, EXIT_PLAN_MODE};
use crate::chat_transcript::ChatItem;
use crate::plan_exchange::RELAY_CAP;

/// The member's own messages of the answer's turn (`CompareAnswer.turnAsks`).
#[derive(Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum TurnAsks {
    /// In order. `cut`: together they were longer than 16,000 characters,
    /// and what is past that is left out (the last one kept may end early).
    Known { messages: Vec<Ask>, cut: bool },
    /// The question must be left out.
    Unknown { why: AsksUnknown },
}

/// One message of the member's.
#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ask {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at_ms: Option<i64>,
    pub kind: AskKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AskKind {
    /// The message that started the turn.
    Prompt,
    /// Claude: a prompt queued while it worked, that joined the same turn.
    Queued,
    /// Codex: a message sent while the turn ran.
    Steer,
    /// Claude: the words typed in the plan menu ("Tell Claude what to change").
    PlanFeedback,
    /// Claude: the words typed when refusing another tool's permission.
    Feedback,
}

/// Why the question is left out. Each serialises to a stable string the
/// window maps to its sentence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AsksUnknown {
    /// The turn's start lies before what was read (a tail cut inside the
    /// turn, Claude's headless first segment, a Codex turn whose
    /// `task_started` isn't in view or a rollout with no turn markers).
    StartNotRead,
    /// The turn starts with a `!` command, a local or skill command (Claude),
    /// or is a Codex review: no message of the member's in words.
    Command,
    /// The prompt is not the member's: `promptSource` other than typed or
    /// queued, or `origin.kind` other than human (a task notification).
    NotTyped,
    /// The turn starts with a queued prompt, and the transcript doesn't show
    /// that it joined the turn before it.
    QueuedStart,
    /// A refusal in the turn carries words in a shape not known.
    FeedbackUnread,
    /// A compaction lies inside the turn.
    Compacted,
    /// Codex: a user message in the turn that is neither typed text nor
    /// known injected context.
    UnknownMessage,
}

impl AsksUnknown {
    pub fn as_str(self) -> &'static str {
        match self {
            AsksUnknown::StartNotRead => "start-not-read",
            AsksUnknown::Command => "command",
            AsksUnknown::NotTyped => "not-typed",
            AsksUnknown::QueuedStart => "queued-start",
            AsksUnknown::FeedbackUnread => "feedback-unread",
            AsksUnknown::Compacted => "compacted",
            AsksUnknown::UnknownMessage => "unknown-message",
        }
    }
}

impl TurnAsks {
    fn unknown(why: AsksUnknown) -> Self {
        TurnAsks::Unknown { why }
    }

    /// The log's fact: counts, never text (`known(2, 140)`, `known(1, 16000, cut)`,
    /// `unknown(start-not-read)`).
    pub fn fact(&self) -> String {
        match self {
            TurnAsks::Known { messages, cut } => {
                let chars: usize = messages.iter().map(|m| m.text.chars().count()).sum();
                format!("known({}, {}{})", messages.len(), chars, if *cut { ", cut" } else { "" })
            }
            TurnAsks::Unknown { why } => format!("unknown({})", why.as_str()),
        }
    }
}

/// Never a message's text: a stray `{:?}` must not log what the member wrote.
impl std::fmt::Debug for TurnAsks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.fact())
    }
}

impl std::fmt::Debug for Ask {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ask").field("chars", &self.text.chars().count()).field("at_ms", &self.at_ms).field("kind", &self.kind).finish()
    }
}

/// The messages, together at most [`RELAY_CAP`] characters (the paste can
/// carry no more): what is past it is left out, and said so.
pub(super) fn known(messages: Vec<Ask>) -> TurnAsks {
    let mut room = RELAY_CAP;
    let mut cut = false;
    let mut out = Vec::with_capacity(messages.len());
    for mut message in messages {
        if room == 0 {
            cut = true;
            break;
        }
        let len = message.text.chars().count();
        if len <= room {
            room -= len;
        } else {
            message.text = message.text.chars().take(room).collect();
            room = 0;
            cut = true;
        }
        out.push(message);
    }
    TurnAsks::Known { messages: out, cut }
}

// ── Claude ───────────────────────────────────────────────────────────────

/// Measured (2.1.332): the refusal Claude writes when the member types what
/// to change, `…To tell you how to proceed, the user said:\n<words>`, at
/// times followed by `\n\nNote: The user's next …`.
const SAID: &str = "the user said:\n";
const SAID_NOTE: &str = "\n\nNote: The user's next";
/// Measured (2.1.332): the refusal after Esc on a menu, no words of the member's.
const STOPPED: &str = "STOP what you are doing and wait for the user";

/// What a refusal's text says of the member's words.
#[derive(PartialEq)]
pub(super) enum RefusalWords {
    Feedback(String),
    /// Esc: refused with no words.
    Stopped,
    /// A shape not known.
    Unread,
}

pub(super) fn refusal_words(text: &str) -> RefusalWords {
    if let Some(at) = text.find(SAID) {
        let rest = &text[at + SAID.len()..];
        let words = match rest.rfind(SAID_NOTE) {
            Some(end) => &rest[..end],
            None => rest,
        };
        let words = words.trim();
        return if words.is_empty() { RefusalWords::Unread } else { RefusalWords::Feedback(words.to_string()) };
    }
    if text.contains(STOPPED) {
        RefusalWords::Stopped
    } else {
        RefusalWords::Unread
    }
}

/// A refusal Claude wrote for a tool call (only entries with a top-level
/// `toolDenialKind`): where, when, and what it says.
pub(super) struct Refusal {
    pub line: usize,
    pub at_ms: Option<i64>,
    pub denial: String,
    pub text: String,
}

/// A user entry's own facts, by `uuid` (measured on 2.1.332:
/// `promptSource`, `origin.kind`, `turnPosition.turnIndex`).
pub(super) struct PromptMeta {
    pub source: Option<String>,
    pub origin: Option<String>,
    pub turn_index: Option<i64>,
    /// How many turn ends (`turn_duration`) came before it in the tail.
    pub ends_before: usize,
}

/// The line an item was written on (its last, for an assistant message
/// over several lines, or a tool's result).
fn item_line(item: &ChatItem, side: &ClaudeSide) -> Option<usize> {
    match item {
        ChatItem::Tool { id, .. } => side.tool_lines.get(id).max(side.result_lines.get(id)).copied(),
        other => side.item_lines.get(other.id()).copied(),
    }
}

/// The member's messages of the turn answered in segment `n` (`segments`
/// as `claude_tail` splits them; `headless`: segment 0 has no prompt).
pub(super) fn claude_asks(segments: &[&[ChatItem]], headless: bool, n: usize, side: &ClaudeSide) -> TurnAsks {
    // Where the turn started: back over queued prompts that joined it.
    let mut first = n;
    loop {
        if first == 0 && headless {
            return TurnAsks::unknown(AsksUnknown::StartNotRead);
        }
        let Some(start) = segments[first].first() else { return TurnAsks::unknown(AsksUnknown::StartNotRead) };
        let ChatItem::User { id, .. } = start else {
            // A `!` command.
            return TurnAsks::unknown(AsksUnknown::Command);
        };
        if local_command(start) {
            return TurnAsks::unknown(AsksUnknown::Command);
        }
        let Some(meta) = side.prompts.get(id) else { return TurnAsks::unknown(AsksUnknown::NotTyped) };
        if meta.origin.as_deref().is_some_and(|kind| kind != "human") {
            return TurnAsks::unknown(AsksUnknown::NotTyped);
        }
        match meta.source.as_deref() {
            Some("typed") => break,
            Some("queued") => {
                // Owner's decision: a queued prompt is the same turn only when
                // the transcript shows it — the prompt before it in the tail,
                // the same `turnIndex`, no turn end or interrupt between.
                let joined = first > 0 && !(first == 1 && headless) && {
                    let before = segments[first - 1];
                    let before_meta = match before.first() {
                        Some(ChatItem::User { id, .. }) => side.prompts.get(id),
                        _ => None,
                    };
                    before_meta.is_some_and(|b| {
                        b.turn_index.is_some()
                            && b.turn_index == meta.turn_index
                            && b.ends_before == meta.ends_before
                            && !before.iter().any(|it| matches!(it, ChatItem::Interrupted { .. }))
                    })
                };
                if !joined {
                    return TurnAsks::unknown(AsksUnknown::QueuedStart);
                }
                first -= 1;
            }
            _ => return TurnAsks::unknown(AsksUnknown::NotTyped),
        }
    }
    // Inferred: what the transcript keeps of a prompt across a compaction is
    // unmeasured, so a compaction inside the turn leaves the question out.
    let from = segments[first].first().and_then(|it| item_line(it, side));
    let to = segments[n].iter().filter_map(|it| item_line(it, side)).max();
    if let (Some(from), Some(to)) = (from, to) {
        if side.compactions.iter().any(|line| *line > from && *line <= to) {
            return TurnAsks::unknown(AsksUnknown::Compacted);
        }
    }
    let mut asks: Vec<(usize, Ask)> = Vec::new();
    for (k, segment) in segments[first..=n].iter().enumerate() {
        for item in segment.iter() {
            match item {
                ChatItem::User { id, text, .. } => {
                    // Words only: an image alone adds nothing.
                    if text.trim().is_empty() {
                        continue;
                    }
                    let kind = if k == 0 { AskKind::Prompt } else { AskKind::Queued };
                    let line = side.item_lines.get(id).copied().unwrap_or(0);
                    asks.push((line, Ask { text: text.trim().to_string(), at_ms: side.prompt_times.get(id).copied(), kind }));
                }
                ChatItem::Tool { id, name, .. } => {
                    let Some(refusal) = side.refusals.get(id) else { continue };
                    let words = refusal_words(&refusal.text);
                    if refusal.denial != "user-rejected" {
                        // A refusal by a rule carries no words of the member's;
                        // one that seems to is a shape not known.
                        if matches!(words, RefusalWords::Feedback(_)) {
                            return TurnAsks::unknown(AsksUnknown::FeedbackUnread);
                        }
                        continue;
                    }
                    match words {
                        RefusalWords::Feedback(words) => {
                            let kind = if name == EXIT_PLAN_MODE { AskKind::PlanFeedback } else { AskKind::Feedback };
                            asks.push((refusal.line, Ask { text: words, at_ms: refusal.at_ms, kind }));
                        }
                        RefusalWords::Stopped => {}
                        RefusalWords::Unread => return TurnAsks::unknown(AsksUnknown::FeedbackUnread),
                    }
                }
                _ => {}
            }
        }
    }
    asks.sort_by_key(|(line, _)| *line);
    known(asks.into_iter().map(|(_, ask)| ask).collect())
}

// ── Codex ────────────────────────────────────────────────────────────────

/// Codex's own context, sent as a user message (measured on 0.172: the
/// first turn's `<environment_context>`, about 1.5k characters; the rule
/// `session_titles` reads first messages by), and its AGENTS.md block.
fn injected(text: &str) -> bool {
    text.starts_with('<') || text.starts_with("# AGENTS.md instructions")
}

/// One Codex turn's user messages as the rollout goes by.
#[derive(Default)]
pub(super) struct CodexTurn {
    /// Its `task_started` is in view.
    started: bool,
    /// `response_item` user messages: text, time, whether it reads as
    /// injected context.
    items: Vec<(String, Option<i64>, bool)>,
    /// `event_msg` `user_message` texts.
    events: Vec<(String, Option<i64>)>,
    unknown: Option<AsksUnknown>,
}

impl CodexTurn {
    pub(super) fn started() -> Self {
        CodexTurn { started: true, ..Default::default() }
    }

    pub(super) fn mark(&mut self, why: AsksUnknown) {
        self.unknown.get_or_insert(why);
    }

    /// A `response_item` payload: a user message is kept; anything else is
    /// not the member's.
    pub(super) fn item(&mut self, payload: &Value, at_ms: Option<i64>) {
        if payload.get("type").and_then(Value::as_str) != Some("message")
            || payload.get("role").and_then(Value::as_str) != Some("user")
        {
            return;
        }
        let parts = payload["content"].as_array().map(Vec::as_slice).unwrap_or(&[]);
        if parts.iter().any(|p| !matches!(p.get("type").and_then(Value::as_str), Some("input_text" | "input_image"))) {
            self.mark(AsksUnknown::UnknownMessage);
            return;
        }
        // Words only: an image part adds nothing.
        let text = parts
            .iter()
            .filter(|p| p.get("type").and_then(Value::as_str) == Some("input_text"))
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("");
        let text = text.trim();
        if !text.is_empty() {
            self.items.push((text.to_string(), at_ms, injected(text)));
        }
    }

    /// An `event_msg` `user_message` payload (older versions, and a second
    /// record of the same message in others).
    pub(super) fn event(&mut self, payload: &Value, at_ms: Option<i64>) {
        if let Some(text) = payload.get("message").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()) {
            self.events.push((text.to_string(), at_ms));
        }
    }

    /// The turn's question, once it ended with the answer on offer.
    pub(super) fn finish(&self) -> TurnAsks {
        if !self.started {
            return TurnAsks::unknown(AsksUnknown::StartNotRead);
        }
        if let Some(why) = self.unknown {
            return TurnAsks::unknown(why);
        }
        // Context that looks injected but is also recorded as the member's
        // own message (`event_msg`) was typed.
        let typed: Vec<(String, Option<i64>)> = self
            .items
            .iter()
            .filter(|(text, _, injected)| !*injected || self.events.iter().any(|(e, _)| e == text))
            .map(|(text, at, _)| (text.clone(), *at))
            .collect();
        let list = if typed.is_empty() { self.events.clone() } else { typed };
        known(
            list.into_iter()
                .enumerate()
                .map(|(i, (text, at_ms))| Ask { text, at_ms, kind: if i == 0 { AskKind::Prompt } else { AskKind::Steer } })
                .collect(),
        )
    }
}

#[cfg(test)]
#[path = "compare_asks_tests.rs"]
mod tests;
