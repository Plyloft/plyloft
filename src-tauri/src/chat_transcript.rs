//! A card chat with Claude, read from the interactive TUI's own transcript
//! (`<claude config>/projects/<cwd key>/<session>.jsonl`), as it grows.
//!
//! Ported from the chat spike (`spike/chat-attachments`, `read_chat`) with
//! what Phase 0 measured on Claude Code 2.1.300
//! (`docs/spikes/CHAT_ATTACHMENTS_SPIKE.md`, "Phase 0 results"):
//!
//! - **Only the top-level `type` decides** (`user`, `assistant`, `system`,
//!   `attachment`). 2.1.300 also writes `api-request-blob` entries whose
//!   `message.role` repeats every prompt and reply; keying on the role would
//!   show each message twice. `api-request*`, `queue-operation`, `mode`,
//!   `cost-state` and the other kinds are ignored.
//! - **A multi-line paste** comes back wrapped:
//!   `"\n\n<pasted_content id=\"ddf4\">\n…\n</pasted_content id=\"ddf4\">\n"`;
//!   the wrapper is removed. A one-line paste is not wrapped.
//! - **Text pasted mid-turn** is queued and later written as its own prompt
//!   with `promptSource:"queued"`: a normal user message.
//! - **The turn's end** is `system`/`turn_duration`. **An interrupted turn**
//!   (Esc) writes `[Request interrupted by user…]` (with
//!   `interruptedMessageId`) and *no* `turn_duration`: that entry ends the
//!   turn too, or a stopped chat would never be Ready again.
//! - **A resume** (`claude --resume`) after an interrupt writes an assistant
//!   entry with `message.model:"<synthetic>"` ("No response requested."):
//!   skipped.
//! - **A `!` shell command** (should one ever reach the composer — Plyloft's
//!   own sends always start with a space, `chat::composer_text`) is a user entry
//!   `<bash-input>…</bash-input>`, then `<bash-stdout>…</bash-stdout>
//!   <bash-stderr>…</bash-stderr>`: shown as a shell item, never as the
//!   member's message, so a slip is visible.
//! - **Images are never copied:** a pasted image's base64 (a user `image`
//!   block) is counted only, and a tool result's content (where a Read of an
//!   image stores its bytes, twice with `toolUseResult`) is never read.
//! - Thinking, sidechain (subagent) lines, `isMeta` lines and the
//!   post-compaction summary are not the conversation.
//!
//! The transcript format is internal to Claude Code and changes between
//! versions (its own docs say so); unknown kinds are ignored, and these
//! shapes are pinned by the tests below.

use serde::Serialize;
use std::collections::{BTreeSet, HashMap};

use crate::chat_store::TokenUsage;

/// One thing the chat draws, in transcript order. `id` is stable for the
/// same transcript read again (a resumed session reads it from the start),
/// so a chat's own copy (`chat_store`) is updated, never duplicated.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum ChatItem {
    /// A prompt as Claude received it (`uuid`).
    #[serde(rename_all = "camelCase")]
    User { id: String, text: String, pasted_images: u32, files: Vec<String>, queued: bool },
    /// One assistant message (`message.id`; one message is written over
    /// several lines).
    #[serde(rename_all = "camelCase")]
    Assistant { id: String, text: String, done: bool, is_error: bool },
    /// A tool call (`tool_use` id) and, once known, how it ended.
    #[serde(rename_all = "camelCase")]
    Tool { id: String, name: String, detail: String, outcome: ToolOutcome },
    /// A `!` shell command that ran in the session, and what it printed.
    #[serde(rename_all = "camelCase")]
    Shell { id: String, command: String, output: String },
    /// The turn was stopped (Esc).
    #[serde(rename_all = "camelCase")]
    Interrupted { id: String },
}

impl ChatItem {
    pub(crate) fn id(&self) -> &str {
        match self {
            ChatItem::User { id, .. }
            | ChatItem::Assistant { id, .. }
            | ChatItem::Tool { id, .. }
            | ChatItem::Shell { id, .. }
            | ChatItem::Interrupted { id } => id,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ToolOutcome {
    Running,
    Done,
    Failed,
    /// Refused by a rule, or left unfinished by an interrupt.
    Denied,
}

impl ToolOutcome {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ToolOutcome::Running => "running",
            ToolOutcome::Done => "done",
            ToolOutcome::Failed => "failed",
            ToolOutcome::Denied => "denied",
        }
    }
}

/// Where the session stands, from the transcript alone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum ChatState {
    /// Nothing sent yet, or the last turn ended (or was stopped).
    Ready,
    Working,
    /// A tool call with no result yet: in the read-only profile this is a
    /// Read in progress (no permission dialog can occur there, Phase 0 §3).
    WaitingOnTool { tool: String },
}

/// Why Claude's last turn closed (Plan with two AIs §3): a settle can call
/// a turn over while Claude still works, so a relay waits for more than a
/// settle. Reset to `Open` whenever a turn opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TurnClose {
    /// The transcript's `turn_duration` (or no turn yet).
    #[default]
    Ended,
    /// An interrupt entry.
    Interrupted,
    /// A finished answer and the transcript still for `turn_settle`.
    Settled,
    /// The stuck-turn closer: an idle, unchanged composer.
    Stuck,
    /// A turn is running.
    Open,
}

const INTERRUPT_PREFIX: &str = "[Request interrupted by user";
const PASTED_OPEN: &str = "<pasted_content id=\"";
const PASTED_CLOSE: &str = "</pasted_content id=\"";

fn str_of<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(|v| v.as_str())
}

fn flag(value: &serde_json::Value, key: &str) -> bool {
    value.get(key).and_then(|v| v.as_bool()) == Some(true)
}

/// `text` with every `<pasted_content id="…">…</pasted_content id="…">`
/// wrapper replaced by what it holds.
pub(crate) fn unwrap_pasted(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(open) = rest.find(PASTED_OPEN) {
        let after_id = &rest[open + PASTED_OPEN.len()..];
        let Some(id_end) = after_id.find("\">") else {
            break;
        };
        let id = &after_id[..id_end];
        let inner_start = &after_id[id_end + 2..];
        let close = format!("{PASTED_CLOSE}{id}\">");
        let Some(close_at) = inner_start.find(&close) else {
            break;
        };
        out.push_str(&rest[..open]);
        let inner = &inner_start[..close_at];
        let inner = inner.strip_prefix('\n').unwrap_or(inner);
        let inner = inner.strip_suffix('\n').unwrap_or(inner);
        out.push_str(inner);
        rest = &inner_start[close_at + close.len()..];
    }
    out.push_str(rest);
    out
}

/// The member's words in a prompt Plyloft typed: the wrapper removed, and
/// Plyloft's own attachment block (`chat_attachments::claude_message`) and
/// the leading space every chat message gets (`chat::composer_text`) left out.
pub(crate) fn member_words(text: &str) -> String {
    let text = unwrap_pasted(text);
    let cut = match text.find(crate::chat_attachments::CLAUDE_ATTACHMENTS_LEAD) {
        Some(at) => &text[..at],
        None => &text[..],
    };
    cut.trim().to_string()
}

/// Text between `<tag>` and `</tag>`, if `text` holds the pair.
fn between<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(&text[start..end])
}

/// A Claude chat's transcript folded line by line. Feed it the bytes the
/// file grew by ([`ClaudeFold::push_bytes`]); an incomplete last line waits
/// for the rest of it.
#[derive(Debug, Default)]
pub(crate) struct ClaudeFold {
    items: Vec<ChatItem>,
    /// Indices of items added or changed since [`ClaudeFold::take_dirty`].
    dirty: BTreeSet<usize>,
    /// The last prompt's uuid, and the uuid an `@file` attachment must chain
    /// from to belong to it.
    prompt_chain: Option<String>,
    turn_open: bool,
    /// Why the last turn closed (`Open` while one runs).
    close: TurnClose,
    /// Each assistant message's latest usage, by message id.
    usage: HashMap<String, TokenUsage>,
    partial: Vec<u8>,
    /// Lines read, for a fallback id when an entry carries no uuid.
    lines: usize,
}

impl ClaudeFold {
    pub(crate) fn push_bytes(&mut self, bytes: &[u8]) {
        self.partial.extend_from_slice(bytes);
        let Some(end) = self.partial.iter().rposition(|byte| *byte == b'\n') else {
            return;
        };
        let complete: Vec<u8> = self.partial.drain(..=end).collect();
        for line in String::from_utf8_lossy(&complete).lines() {
            self.push_line(line);
        }
    }

    #[cfg(test)]
    pub(crate) fn items(&self) -> &[ChatItem] {
        &self.items
    }

    /// The items added or changed since the last call, in order.
    pub(crate) fn take_dirty(&mut self) -> Vec<ChatItem> {
        let dirty = std::mem::take(&mut self.dirty);
        dirty.into_iter().filter_map(|index| self.items.get(index).cloned()).collect()
    }

    /// Whether a turn is under way: a prompt (or a shell command) came in
    /// and neither its end nor an interrupt has been written.
    pub(crate) fn turn_open(&self) -> bool {
        self.turn_open
    }

    /// The session's token total: every assistant message's usage once.
    pub(crate) fn usage(&self) -> TokenUsage {
        let mut total = TokenUsage::default();
        for usage in self.usage.values() {
            total.add(usage);
        }
        total
    }

    pub(crate) fn state(&self) -> ChatState {
        if !self.turn_open {
            return ChatState::Ready;
        }
        match self.items.last() {
            // An API error message (a usage limit, an overload) is the
            // turn's last word even when no end-of-turn entry follows.
            Some(ChatItem::Assistant { is_error: true, .. }) => ChatState::Ready,
            Some(ChatItem::Tool { name, detail, outcome: ToolOutcome::Running, .. }) => ChatState::WaitingOnTool {
                tool: if detail.is_empty() { name.clone() } else { format!("{name} ({detail})") },
            },
            _ => ChatState::Working,
        }
    }

    /// The turn's last message reads like its answer (a finished assistant
    /// message, no tool still running): for a Claude that writes no
    /// end-of-turn entry, the caller counts the turn over once the
    /// transcript has been still for a moment.
    pub(crate) fn answer_shaped(&self) -> bool {
        self.turn_open
            && matches!(self.items.last(), Some(ChatItem::Assistant { done: true, .. }))
            && !self.items.iter().any(|item| matches!(item, ChatItem::Tool { outcome: ToolOutcome::Running, .. }))
    }

    /// Ends the open turn as if Claude had written its end (the caller's
    /// fallback above), saying why (`Settled`, `Stuck`; `Ended` for an
    /// earlier session's turn a resume closes).
    pub(crate) fn close_turn(&mut self, why: TurnClose) {
        self.turn_open = false;
        self.close = why;
    }

    /// Why the last turn closed; `Open` while one runs.
    pub(crate) fn turn_close(&self) -> TurnClose {
        if self.turn_open {
            TurnClose::Open
        } else {
            self.close
        }
    }

    fn open_turn(&mut self) {
        self.turn_open = true;
        self.close = TurnClose::Open;
    }

    fn end_turn(&mut self, why: TurnClose) {
        self.turn_open = false;
        self.close = why;
    }

    fn touch(&mut self, index: usize) {
        self.dirty.insert(index);
    }

    fn push_item(&mut self, item: ChatItem) {
        self.items.push(item);
        let index = self.items.len() - 1;
        self.touch(index);
    }

    fn index_of(&self, id: &str) -> Option<usize> {
        self.items.iter().rposition(|item| item.id() == id)
    }

    pub(crate) fn push_line(&mut self, line: &str) {
        self.lines += 1;
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            return;
        };
        if flag(&entry, "isSidechain") {
            return; // a subagent's own conversation
        }
        let uuid = str_of(&entry, "uuid").map(str::to_string).unwrap_or_else(|| format!("line-{}", self.lines));
        let parent = str_of(&entry, "parentUuid").map(str::to_string);
        match str_of(&entry, "type") {
            Some("user") => self.user_entry(&entry, uuid),
            Some("attachment") => self.attachment_entry(&entry, uuid, parent),
            Some("assistant") => self.assistant_entry(&entry, uuid),
            Some("system") if str_of(&entry, "subtype") == Some("turn_duration") => {
                for index in 0..self.items.len() {
                    if let ChatItem::Assistant { done, .. } = &mut self.items[index] {
                        if !*done {
                            *done = true;
                            self.dirty.insert(index);
                        }
                    }
                }
                self.end_turn(TurnClose::Ended);
                self.prompt_chain = None;
            }
            _ => {}
        }
    }

    fn user_entry(&mut self, entry: &serde_json::Value, uuid: String) {
        if flag(entry, "isMeta") || flag(entry, "isCompactSummary") {
            self.prompt_chain = None;
            return;
        }
        let content = &entry["message"]["content"];
        let mut text = String::new();
        let mut images = 0u32;
        let mut any_result = false;
        if let Some(plain) = content.as_str() {
            text.push_str(plain);
        }
        for block in content.as_array().into_iter().flatten() {
            match str_of(block, "type") {
                Some("tool_result") => {
                    any_result = true;
                    let id = str_of(block, "tool_use_id").unwrap_or("");
                    let outcome = if entry.get("toolDenialKind").is_some() {
                        ToolOutcome::Denied
                    } else if flag(block, "is_error") {
                        ToolOutcome::Failed
                    } else {
                        ToolOutcome::Done
                    };
                    if let Some(index) = self.index_of(id) {
                        if let ChatItem::Tool { outcome: slot, .. } = &mut self.items[index] {
                            *slot = outcome;
                            self.dirty.insert(index);
                        }
                    }
                }
                Some("text") => {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(str_of(block, "text").unwrap_or(""));
                }
                // Counted, never copied: the base64 stays in the transcript.
                Some("image") => images += 1,
                _ => {}
            }
        }
        if entry.get("interruptedMessageId").is_some() || text.trim_start().starts_with(INTERRUPT_PREFIX) {
            // A tool left running when the turn was stopped never ends.
            for index in 0..self.items.len() {
                if let ChatItem::Tool { outcome, .. } = &mut self.items[index] {
                    if *outcome == ToolOutcome::Running {
                        *outcome = ToolOutcome::Denied;
                        self.dirty.insert(index);
                    }
                }
            }
            if self.index_of(&uuid).is_none() {
                self.push_item(ChatItem::Interrupted { id: uuid });
            }
            self.prompt_chain = None;
            self.end_turn(TurnClose::Interrupted);
            return;
        }
        if any_result {
            self.prompt_chain = None;
            return;
        }
        if let Some(command) = between(&text, "bash-input") {
            self.push_item(ChatItem::Shell { id: uuid.clone(), command: command.trim().to_string(), output: String::new() });
            self.prompt_chain = Some(uuid);
            self.open_turn();
            return;
        }
        if text.contains("<bash-stdout>") || text.contains("<bash-stderr>") {
            let output = [between(&text, "bash-stdout"), between(&text, "bash-stderr")]
                .into_iter()
                .flatten()
                .map(str::trim)
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            if let Some(index) = self.items.iter().rposition(|item| matches!(item, ChatItem::Shell { .. })) {
                if let ChatItem::Shell { output: slot, .. } = &mut self.items[index] {
                    *slot = output;
                    self.dirty.insert(index);
                }
            }
            return;
        }
        // A local command's own output (`/cost` and the like): no prompt.
        if text.trim_start().starts_with("<local-command-") {
            return;
        }
        let words = member_words(&text);
        if words.is_empty() && images == 0 {
            return;
        }
        if self.index_of(&uuid).is_none() {
            let queued = str_of(entry, "promptSource") == Some("queued");
            self.push_item(ChatItem::User { id: uuid.clone(), text: words, pasted_images: images, files: vec![], queued });
        }
        self.prompt_chain = Some(uuid);
        self.open_turn();
    }

    fn attachment_entry(&mut self, entry: &serde_json::Value, uuid: String, parent: Option<String>) {
        let attachment = &entry["attachment"];
        let chained = self.prompt_chain.is_some() && parent.is_some() && parent == self.prompt_chain;
        if !chained {
            return;
        }
        // Every attachment Claude adds after the prompt chains on (reminders,
        // listings); only `file` ones are the member's `@` mentions.
        self.prompt_chain = Some(uuid);
        if str_of(attachment, "type") != Some("file") {
            return;
        }
        let shown =
            str_of(attachment, "displayPath").or_else(|| str_of(attachment, "filename")).unwrap_or("").to_string();
        if let Some(index) = self.items.iter().rposition(|item| matches!(item, ChatItem::User { .. })) {
            if let ChatItem::User { files, .. } = &mut self.items[index] {
                files.push(shown);
                self.dirty.insert(index);
            }
        }
    }

    fn assistant_entry(&mut self, entry: &serde_json::Value, uuid: String) {
        let message = &entry["message"];
        // Written by a resume after an interrupt ("No response requested."):
        // nobody's answer.
        if str_of(message, "model") == Some("<synthetic>") {
            return;
        }
        self.prompt_chain = None;
        self.open_turn();
        let id = str_of(message, "id").map(str::to_string).unwrap_or(uuid);
        if let Some(usage) = message.get("usage").and_then(|u| u.as_object()) {
            let n = |key: &str| usage.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
            self.usage.insert(
                id.clone(),
                TokenUsage {
                    input_tokens: n("input_tokens"),
                    output_tokens: n("output_tokens"),
                    cache_read_tokens: n("cache_read_input_tokens"),
                    cache_creation_tokens: n("cache_creation_input_tokens"),
                    reasoning_tokens: 0,
                },
            );
        }
        let final_stop =
            matches!(str_of(message, "stop_reason"), Some("end_turn" | "stop_sequence" | "max_tokens" | "refusal"));
        let is_error = flag(entry, "isApiErrorMessage");
        for block in message["content"].as_array().into_iter().flatten() {
            match str_of(block, "type") {
                Some("text") => {
                    let part = str_of(block, "text").unwrap_or("");
                    match self.items.last_mut() {
                        Some(ChatItem::Assistant { id: last, text, done, is_error: err }) if *last == id => {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(part);
                            *done |= final_stop || is_error;
                            *err |= is_error;
                            let index = self.items.len() - 1;
                            self.touch(index);
                        }
                        _ => self.push_item(ChatItem::Assistant {
                            id: id.clone(),
                            text: part.to_string(),
                            done: final_stop || is_error,
                            is_error,
                        }),
                    }
                }
                Some("tool_use") => {
                    let tool_id = str_of(block, "id").unwrap_or("").to_string();
                    if self.index_of(&tool_id).is_some() {
                        continue;
                    }
                    let input = &block["input"];
                    let detail = ["file_path", "path", "pattern", "command", "notebook_path", "url", "skill"]
                        .iter()
                        .find_map(|key| input.get(*key).and_then(|v| v.as_str()))
                        .map(|value| value.lines().next().unwrap_or("").chars().take(120).collect())
                        .unwrap_or_default();
                    self.push_item(ChatItem::Tool {
                        id: tool_id,
                        name: str_of(block, "name").unwrap_or("a tool").to_string(),
                        detail,
                        outcome: ToolOutcome::Running,
                    });
                }
                _ => {} // thinking, redacted thinking
            }
        }
    }
}

/// The whole of a transcript folded at once (tests, and a reader that has
/// the text already).
#[cfg(test)]
pub(crate) fn read_chat(transcript: &str) -> ClaudeFold {
    let mut fold = ClaudeFold::default();
    fold.push_bytes(transcript.as_bytes());
    if !transcript.ends_with('\n') {
        fold.push_bytes(b"\n");
    }
    fold
}

#[cfg(test)]
pub(crate) mod fixtures {
    //! Lines in the shapes Claude Code 2.1.287–2.1.300 writes (Phase 0;
    //! synthetic text, no real transcript content).
    use serde_json::json;

    pub(crate) fn lines(entries: &[serde_json::Value]) -> String {
        entries.iter().map(|e| e.to_string() + "\n").collect()
    }

    pub(crate) fn prompt(uuid: &str, parent: Option<&str>, content: serde_json::Value) -> serde_json::Value {
        json!({"type":"user","uuid":uuid,"parentUuid":parent,"isSidechain":false,
               "promptSource":"typed","origin":{"kind":"human"},
               "message":{"role":"user","content":content}})
    }

    pub(crate) fn assistant(uuid: &str, id: &str, content: serde_json::Value, stop: Option<&str>) -> serde_json::Value {
        json!({"type":"assistant","uuid":uuid,"isSidechain":false,
               "message":{"id":id,"role":"assistant","model":"claude-opus","content":content,"stop_reason":stop,
                          "usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":20}}})
    }

    pub(crate) fn result(uuid: &str, tool: &str, is_error: bool) -> serde_json::Value {
        json!({"type":"user","uuid":uuid,"isSidechain":false,"toolUseResult":{"file":{"base64":"QUJD"}},
               "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":tool,"is_error":is_error,
                          "content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORtoolbytes"}}]}]}})
    }

    pub(crate) fn turn_end(uuid: &str) -> serde_json::Value {
        json!({"type":"system","subtype":"turn_duration","uuid":uuid,"durationMs":1497,"messageCount":11})
    }

    pub(crate) fn interrupt(uuid: &str, message: &str) -> serde_json::Value {
        json!({"type":"user","uuid":uuid,"interruptedMessageId":message,
               "message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}})
    }

    /// 2.1.300's request blob: repeats a prompt or a reply under
    /// `message.role`, with a top-level type that is neither.
    pub(crate) fn blob(role: &str, text: &str) -> serde_json::Value {
        json!({"type":"api-request-blob","message":{"role":role,"content":[{"type":"text","text":text}]}})
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;
    use serde_json::json;

    fn users(fold: &ClaudeFold) -> Vec<String> {
        fold.items()
            .iter()
            .filter_map(|item| match item {
                ChatItem::User { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_turn_reads_as_prompt_tool_and_answer_with_thinking_left_out() {
        let t = lines(&[
            prompt("u1", None, json!("Summarise the plan")),
            assistant("a1", "msg_1", json!([{"type":"thinking","thinking":"hmm"}]), Some("tool_use")),
            assistant("a2", "msg_1", json!([{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"/x/plan.md"}}]), Some("tool_use")),
            result("u2", "toolu_1", false),
            assistant("a3", "msg_2", json!([{"type":"text","text":"Here is"}]), Some("end_turn")),
            assistant("a4", "msg_2", json!([{"type":"text","text":"the summary."}]), Some("end_turn")),
            turn_end("t1"),
            json!({"type":"cost-state","totalCostUSD":0.25}),
        ]);
        let fold = read_chat(&t);
        assert_eq!(
            fold.items(),
            &[
                ChatItem::User { id: "u1".into(), text: "Summarise the plan".into(), pasted_images: 0, files: vec![], queued: false },
                ChatItem::Tool { id: "toolu_1".into(), name: "Read".into(), detail: "/x/plan.md".into(), outcome: ToolOutcome::Done },
                ChatItem::Assistant { id: "msg_2".into(), text: "Here is\nthe summary.".into(), done: true, is_error: false },
            ]
        );
        assert_eq!(fold.state(), ChatState::Ready);
        // Tokens, once per message (msg_1 and msg_2), never a cost.
        let usage = fold.usage();
        assert_eq!((usage.input_tokens, usage.output_tokens, usage.cache_read_tokens), (20, 10, 200));
        assert!(!serde_json::to_string(fold.items()).unwrap().contains("iVBOR"), "tool image bytes never reach the chat");
    }

    #[test]
    fn request_blobs_never_double_a_message() {
        let t = lines(&[
            prompt("u1", None, json!("hi")),
            blob("user", "hi"),
            assistant("a1", "msg_1", json!([{"type":"text","text":"Hello"}]), Some("end_turn")),
            blob("assistant", "Hello"),
            json!({"type":"queue-operation","operation":"enqueue","content":"x"}),
            json!({"type":"api-request","requestId":"r"}),
            turn_end("t1"),
        ]);
        let fold = read_chat(&t);
        assert_eq!(fold.items().len(), 2, "{:?}", fold.items());
    }

    #[test]
    fn a_multi_line_paste_is_unwrapped_and_plyloft_s_attachment_block_left_out() {
        let pasted = "\n\n<pasted_content id=\"ddf4\">\n Line one: apple\nLine two: banana\n\nThe member attached these files. Read each one with the Read tool before you answer:\n- \"/a b/x.png\" (image: x.png)\n</pasted_content id=\"ddf4\">\n";
        let fold = read_chat(&lines(&[prompt("u1", None, json!(pasted))]));
        assert_eq!(users(&fold), vec!["Line one: apple\nLine two: banana".to_string()]);
        assert_eq!(fold.state(), ChatState::Working);
        assert_eq!(unwrap_pasted("a <pasted_content id=\"1\">\nx\n</pasted_content id=\"1\"> b"), "a x b");
        assert_eq!(unwrap_pasted("no wrapper"), "no wrapper");
        assert_eq!(unwrap_pasted("<pasted_content id=\"1\">half"), "<pasted_content id=\"1\">half");
    }

    #[test]
    fn a_queued_prompt_is_its_own_user_message() {
        let mut queued = prompt("u2", None, json!("second"));
        queued["promptSource"] = json!("queued");
        let t = lines(&[
            prompt("u1", None, json!("first")),
            assistant("a1", "msg_1", json!([{"type":"text","text":"one"}]), Some("end_turn")),
            turn_end("t1"),
            queued,
            assistant("a2", "msg_2", json!([{"type":"text","text":"two"}]), Some("end_turn")),
            turn_end("t2"),
        ]);
        let fold = read_chat(&t);
        assert_eq!(users(&fold), vec!["first".to_string(), "second".to_string()]);
        assert!(matches!(&fold.items()[2], ChatItem::User { queued: true, .. }));
        assert_eq!(fold.state(), ChatState::Ready);
    }

    #[test]
    fn an_interrupt_ends_the_turn_without_a_turn_duration() {
        let t = lines(&[
            prompt("u1", None, json!("write a long essay")),
            assistant("a1", "msg_1", json!([{"type":"text","text":"Once upon"}]), None),
        ]);
        let mut fold = read_chat(&t);
        assert_eq!(fold.state(), ChatState::Working);
        fold.push_bytes(lines(&[interrupt("u2", "msg_1")]).as_bytes());
        assert_eq!(fold.state(), ChatState::Ready, "Phase 0: no turn_duration follows an Esc");
        assert_eq!(fold.items().last(), Some(&ChatItem::Interrupted { id: "u2".into() }));
        assert!(matches!(&fold.items()[1], ChatItem::Assistant { done: false, .. }), "the partial answer stays partial");
    }

    /// Plan with two AIs §3: why each turn closed, set where it happens,
    /// and reset to `Open` whenever a turn opens — a prompt after a settle,
    /// or more of Claude's answer after one.
    #[test]
    fn the_turn_close_says_why_and_resets_when_a_turn_opens() {
        let mut fold = read_chat(&lines(&[prompt("u1", None, json!("one"))]));
        assert_eq!(fold.turn_close(), TurnClose::Open);
        fold.push_bytes(lines(&[assistant("a1", "m1", json!([{"type":"text","text":"Done."}]), Some("end_turn")), turn_end("t1")]).as_bytes());
        assert_eq!(fold.turn_close(), TurnClose::Ended);
        fold.push_bytes(lines(&[prompt("u2", None, json!("two"))]).as_bytes());
        assert_eq!(fold.turn_close(), TurnClose::Open, "a new prompt opens a turn");
        fold.push_bytes(lines(&[assistant("a2", "m2", json!([{"type":"text","text":"Para one."}]), Some("end_turn"))]).as_bytes());
        assert!(fold.answer_shaped());
        fold.close_turn(TurnClose::Settled);
        assert_eq!(fold.turn_close(), TurnClose::Settled);
        // Claude goes on after the settle (a slow tool, a second paragraph).
        fold.push_bytes(lines(&[assistant("a3", "m3", json!([{"type":"text","text":"Para two."}]), None)]).as_bytes());
        assert_eq!(fold.turn_close(), TurnClose::Open, "the turn reopened");
        fold.close_turn(TurnClose::Stuck);
        assert_eq!(fold.turn_close(), TurnClose::Stuck);
        fold.push_bytes(lines(&[prompt("u3", None, json!("three")), interrupt("u4", "m4")]).as_bytes());
        assert_eq!(fold.turn_close(), TurnClose::Interrupted);
    }

    #[test]
    fn a_tool_left_running_by_an_interrupt_reads_denied() {
        let mut interrupted = interrupt("u3", "msg_2");
        interrupted["message"]["content"][0]["text"] = json!("[Request interrupted by user for tool use]");
        let t = lines(&[
            prompt("u1", None, json!("look")),
            assistant("a1", "msg_2", json!([{"type":"tool_use","id":"toolu_2","name":"Grep","input":{"pattern":"TODO"}}]), Some("tool_use")),
        ]);
        let mut fold = read_chat(&t);
        assert_eq!(fold.state(), ChatState::WaitingOnTool { tool: "Grep (TODO)".into() });
        fold.push_bytes(lines(&[interrupted]).as_bytes());
        assert!(matches!(&fold.items()[1], ChatItem::Tool { outcome: ToolOutcome::Denied, .. }));
        assert_eq!(fold.state(), ChatState::Ready);
    }

    #[test]
    fn a_resume_s_synthetic_answer_is_skipped_and_the_session_continues() {
        let mut synthetic = assistant("s1", "msg_s", json!([{"type":"text","text":"No response requested."}]), Some("stop_sequence"));
        synthetic["message"]["model"] = json!("<synthetic>");
        let t = lines(&[
            prompt("u1", None, json!("first")),
            assistant("a1", "msg_1", json!([{"type":"text","text":"partial"}]), None),
            interrupt("u2", "msg_1"),
            synthetic,
            prompt("u3", None, json!("What fruit was on line two?")),
            assistant("a2", "msg_2", json!([{"type":"text","text":"Banana"}]), Some("end_turn")),
            turn_end("t1"),
        ]);
        let fold = read_chat(&t);
        assert!(!serde_json::to_string(fold.items()).unwrap().contains("No response requested"));
        assert_eq!(users(&fold), vec!["first".to_string(), "What fruit was on line two?".to_string()]);
        assert_eq!(fold.state(), ChatState::Ready);
    }

    #[test]
    fn a_shell_command_shows_as_such_never_as_the_member_s_message() {
        let t = lines(&[
            prompt("u1", None, json!("<bash-input> pwd > sentinel.txt</bash-input>")),
            prompt("u2", None, json!("<bash-stdout>(Bash completed with no output)</bash-stdout><bash-stderr></bash-stderr>")),
            assistant("a1", "msg_1", json!([{"type":"text","text":"Ran it."}]), Some("end_turn")),
            turn_end("t1"),
        ]);
        let fold = read_chat(&t);
        assert_eq!(
            fold.items()[0],
            ChatItem::Shell { id: "u1".into(), command: "pwd > sentinel.txt".into(), output: "(Bash completed with no output)".into() }
        );
        assert!(users(&fold).is_empty());
    }

    #[test]
    fn a_pasted_image_is_counted_not_copied() {
        let fold = read_chat(&lines(&[prompt(
            "u1",
            None,
            json!([{"type":"text","text":"[Image #1] what is wrong here?"},
                   {"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo"}}]),
        )]));
        assert!(matches!(&fold.items()[0], ChatItem::User { pasted_images: 1, .. }));
        assert!(!serde_json::to_string(fold.items()).unwrap().contains("iVBOR"));
    }

    #[test]
    fn a_mentioned_file_belongs_to_its_prompt_and_a_compaction_reattach_does_not() {
        let t = lines(&[
            prompt("u1", None, json!("Look at @notes.md")),
            json!({"type":"attachment","uuid":"x1","parentUuid":"u1","attachment":{"type":"total_tokens_reminder"}}),
            json!({"type":"attachment","uuid":"x2","parentUuid":"x1","attachment":{"type":"file","filename":"/w/notes.md","displayPath":"notes.md"}}),
            assistant("a1", "msg_1", json!([{"type":"text","text":"Read it."}]), Some("end_turn")),
            turn_end("t1"),
            json!({"type":"user","uuid":"c1","parentUuid":"c0","isCompactSummary":true,"message":{"content":"Summary…"}}),
            json!({"type":"attachment","uuid":"c2","parentUuid":"c1","attachment":{"type":"file","displayPath":"other.md"}}),
        ]);
        let fold = read_chat(&t);
        assert_eq!(users(&fold).len(), 1);
        assert!(matches!(&fold.items()[0], ChatItem::User { files, .. } if files == &vec!["notes.md".to_string()]));
    }

    #[test]
    fn sidechain_meta_and_half_written_lines_are_skipped_and_the_half_waits() {
        let mut side = assistant("s1", "msg_s", json!([{"type":"text","text":"subagent"}]), Some("end_turn"));
        side["isSidechain"] = json!(true);
        let whole = lines(&[
            prompt("u1", None, json!("go")),
            side,
            json!({"type":"user","uuid":"m","isMeta":true,"message":{"content":"<command-name>"}}),
        ]);
        let mut fold = ClaudeFold::default();
        let answer = assistant("a1", "msg_1", json!([{"type":"text","text":"done"}]), Some("end_turn")).to_string();
        let (head, tail) = answer.split_at(20);
        fold.push_bytes(whole.as_bytes());
        fold.push_bytes(head.as_bytes());
        assert_eq!(fold.items().len(), 1, "the half line waits");
        fold.push_bytes(format!("{tail}\n").as_bytes());
        assert_eq!(fold.items().len(), 2);
        assert!(fold.answer_shaped());
    }

    #[test]
    fn an_api_error_is_a_finished_error_and_the_turn_is_over() {
        let mut err = assistant("a1", "msg_e", json!([{"type":"text","text":"API Error: usage limit reached"}]), None);
        err["isApiErrorMessage"] = json!(true);
        let fold = read_chat(&lines(&[prompt("u1", None, json!("hi")), err]));
        assert!(matches!(&fold.items()[1], ChatItem::Assistant { done: true, is_error: true, .. }));
        assert_eq!(fold.state(), ChatState::Ready);
    }

    #[test]
    fn reading_the_same_transcript_again_gives_the_same_ids_and_dirty_marks_changes() {
        let t = lines(&[
            prompt("u1", None, json!("hi")),
            assistant("a1", "msg_1", json!([{"type":"text","text":"Hel"}]), None),
        ]);
        let mut fold = read_chat(&t);
        let first: Vec<String> = fold.take_dirty().iter().map(|i| i.id().to_string()).collect();
        assert_eq!(first, vec!["u1".to_string(), "msg_1".to_string()]);
        fold.push_bytes(lines(&[assistant("a2", "msg_1", json!([{"type":"text","text":"lo"}]), Some("end_turn"))]).as_bytes());
        let changed = fold.take_dirty();
        assert_eq!(changed.len(), 1);
        assert!(matches!(&changed[0], ChatItem::Assistant { text, done: true, .. } if text == "Hel\nlo"));
        let again = read_chat(&(t + &lines(&[assistant("a2", "msg_1", json!([{"type":"text","text":"lo"}]), Some("end_turn"))])));
        assert_eq!(again.items(), fold.items());
    }
}
