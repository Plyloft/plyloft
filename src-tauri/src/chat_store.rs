//! A card chat's own record: `<config>/projects/<ws>/cards/<card>/chat.json`,
//! written atomically (Hard rule 3), next to the card's `attachments/`.
//!
//! Plyloft keeps its own copy of every message: Claude deletes a transcript
//! after its `cleanupPeriodDays` (30 by default), and a Codex thread can be
//! gone too, so the vendor's history is never the only one. The record also
//! holds what a later session needs to resume (Claude's session id and
//! folder, Codex's thread id) and the token totals (tokens only, never a
//! cost: on a Claude or ChatGPT plan the list-price figure is no bill).
//!
//! One file per card, holding one conversation per vendor; the card's
//! active vendor is the one its chat shows (`chat::ChatRegistry::open`).
//!
//! Schema: `version` 1. A file with no `version` (0) is read as version 1
//! with every missing field at its default and written back as 1; a file
//! from a newer Plyloft (a higher version) is read but never written over,
//! so a downgrade can't destroy what the newer app stored.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::chat_attachments::Attachment;

pub(crate) const CHAT_SCHEMA_VERSION: u32 = 1;

/// The most messages one conversation keeps; the oldest go first.
pub(crate) const MAX_MESSAGES: usize = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ChatVendor {
    Claude,
    Codex,
    /// A vendor a newer Plyloft wrote: kept, never started.
    #[serde(other)]
    Other,
}

impl ChatVendor {
    pub(crate) fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "claude" => Ok(ChatVendor::Claude),
            "codex" => Ok(ChatVendor::Codex),
            other => Err(format!("A card chat is with Claude or Codex, not '{other}'.")),
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            ChatVendor::Claude => "Claude",
            ChatVendor::Codex => "Codex",
            ChatVendor::Other => "this vendor",
        }
    }
}

/// Tokens a conversation used, as its vendor reported them. Never a cost.
/// One meaning for both vendors: `input_tokens` is the input **not** read
/// from the cache (Claude's `input_tokens`; Codex's `inputTokens` minus its
/// `cachedInputTokens`), `cache_read_tokens` what was (Claude's
/// `cache_read_input_tokens`, Codex's `cachedInputTokens`),
/// `cache_creation_tokens` Claude's cache writes (Codex: 0),
/// `reasoning_tokens` Codex's reasoning output (Claude: 0, its thinking is
/// in `output_tokens`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub reasoning_tokens: u64,
}

impl TokenUsage {
    pub(crate) fn add(&mut self, other: &TokenUsage) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_read_tokens += other.cache_read_tokens;
        self.cache_creation_tokens += other.cache_creation_tokens;
        self.reasoning_tokens += other.reasoning_tokens;
    }

    fn sub(&mut self, other: &TokenUsage) {
        self.input_tokens = self.input_tokens.saturating_sub(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_sub(other.output_tokens);
        self.cache_read_tokens = self.cache_read_tokens.saturating_sub(other.cache_read_tokens);
        self.cache_creation_tokens = self.cache_creation_tokens.saturating_sub(other.cache_creation_tokens);
        self.reasoning_tokens = self.reasoning_tokens.saturating_sub(other.reasoning_tokens);
    }
}

/// A tool the model used, as the chat shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatTool {
    pub name: String,
    #[serde(default)]
    pub detail: String,
    /// "running" | "done" | "failed" | "denied".
    #[serde(default)]
    pub outcome: String,
}

/// One message in Plyloft's copy of a chat. Flat, every field but `id` and
/// `role` defaulted, so a newer role or field never breaks an older read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatMessage {
    pub id: String,
    /// "user" | "assistant" | "tool" | "shell" | "interrupted" | "notice".
    pub role: String,
    #[serde(default)]
    pub text: String,
    /// The vendor's own id for it (a transcript uuid or message id, a Codex
    /// item id), once known: what a re-read matches.
    #[serde(default)]
    pub source_id: Option<String>,
    /// The member's attachments sent with it.
    #[serde(default)]
    pub attachment_ids: Vec<String>,
    /// An assistant message is complete.
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub is_error: bool,
    #[serde(default)]
    pub tool: Option<ChatTool>,
    /// Images pasted into Claude's own composer (counted, never copied).
    #[serde(default)]
    pub pasted_images: u32,
    #[serde(default)]
    pub at: i64,
    /// Plan with two AIs: the id of the answer this message relays to the
    /// other session (the UI hides relays). Never in `chat.json`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_of: Option<String>,
    /// Plan with two AIs: the exchange turn this message belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<u32>,
}

impl ChatMessage {
    pub(crate) fn new(role: &str, text: impl Into<String>, at: i64) -> Self {
        ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            role: role.to_string(),
            text: text.into(),
            source_id: None,
            attachment_ids: Vec::new(),
            done: true,
            is_error: false,
            tool: None,
            pasted_images: 0,
            at,
            relay_of: None,
            turn: None,
        }
    }
}

/// One vendor's conversation on a card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Conversation {
    pub vendor: ChatVendor,
    /// Claude's `--session-id` (resumed with `--resume`), or Codex's thread
    /// id (`thread/resume`).
    #[serde(default)]
    pub session_id: Option<String>,
    /// The folder a Claude session runs in (a resume must use the same one).
    #[serde(default)]
    pub session_dir: Option<String>,
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
    /// Every session's tokens, this one's included.
    #[serde(default)]
    pub usage: TokenUsage,
    /// What the current session had reported when last read: replaced, not
    /// added, as its running total moves on.
    #[serde(default)]
    pub session_usage: TokenUsage,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

impl Conversation {
    pub(crate) fn new(vendor: ChatVendor, now: i64) -> Self {
        Conversation {
            vendor,
            session_id: None,
            session_dir: None,
            messages: Vec::new(),
            usage: TokenUsage::default(),
            session_usage: TokenUsage::default(),
            created_at: now,
            updated_at: now,
        }
    }

    /// The current session reports `total` so far. A total smaller than the
    /// last one (the vendor's running count started over) never lowers the
    /// conversation's: what was counted stays, and the new count adds to it.
    pub(crate) fn set_session_usage(&mut self, total: TokenUsage) {
        let s = &self.session_usage;
        let reset = total.input_tokens < s.input_tokens
            || total.output_tokens < s.output_tokens
            || total.cache_read_tokens < s.cache_read_tokens
            || total.cache_creation_tokens < s.cache_creation_tokens
            || total.reasoning_tokens < s.reasoning_tokens;
        if reset {
            self.session_usage = TokenUsage::default();
        }
        self.usage.sub(&self.session_usage);
        self.usage.add(&total);
        self.session_usage = total;
    }

    /// A new session starts: what the last one used stays in `usage`.
    pub(crate) fn begin_session(&mut self) {
        self.session_usage = TokenUsage::default();
    }

    pub(crate) fn message_mut(&mut self, id: &str) -> Option<&mut ChatMessage> {
        self.messages.iter_mut().find(|message| message.id == id)
    }

    pub(crate) fn by_source_mut(&mut self, source: &str) -> Option<&mut ChatMessage> {
        self.messages.iter_mut().rev().find(|message| message.source_id.as_deref() == Some(source))
    }

    pub(crate) fn push(&mut self, message: ChatMessage) {
        self.messages.push(message);
        if self.messages.len() > MAX_MESSAGES {
            let excess = self.messages.len() - MAX_MESSAGES;
            self.messages.drain(..excess);
        }
    }
}

/// `chat.json`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CardChatFile {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub active_vendor: Option<ChatVendor>,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    #[serde(default)]
    pub conversations: Vec<Conversation>,
}

impl CardChatFile {
    pub(crate) fn conversation(&self, vendor: ChatVendor) -> Option<&Conversation> {
        self.conversations.iter().find(|c| c.vendor == vendor)
    }

    pub(crate) fn conversation_mut(&mut self, vendor: ChatVendor, now: i64) -> &mut Conversation {
        if let Some(index) = self.conversations.iter().position(|c| c.vendor == vendor) {
            return &mut self.conversations[index];
        }
        self.conversations.push(Conversation::new(vendor, now));
        self.conversations.last_mut().expect("just pushed")
    }
}

/// `id` is safe as one path component on either platform: not empty, not
/// `.`/`..`, no separator, no `:` (a Windows stream name), no control
/// character (`verify_logs` takes the same ids, with fewer refusals).
pub(crate) fn safe_component<'a>(id: &'a str, what: &str) -> Result<&'a str, String> {
    let ok = !id.is_empty()
        && id.len() <= 200
        && id != "."
        && id != ".."
        && !id.chars().any(|c| matches!(c, '/' | '\\' | ':') || c.is_control());
    if ok {
        Ok(id)
    } else {
        Err(format!("'{id}' is not a valid {what} id"))
    }
}

/// `<config>/projects/<ws>/cards/<card>`: the card's own folder.
pub(crate) fn card_dir(config: &Path, workspace_id: &str, card_id: &str) -> Result<PathBuf, String> {
    Ok(config
        .join("projects")
        .join(safe_component(workspace_id, "workspace")?)
        .join("cards")
        .join(safe_component(card_id, "card")?))
}

pub(crate) fn chat_path(card_dir: &Path) -> PathBuf {
    card_dir.join("chat.json")
}

pub(crate) fn attachments_dir(card_dir: &Path) -> PathBuf {
    card_dir.join("attachments")
}

/// Reads a card's `chat.json`; a missing one is an empty chat. Returns the
/// file and whether it may be written back (false for a newer version).
pub(crate) fn load(path: &Path) -> Result<(CardChatFile, bool), String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((CardChatFile { version: CHAT_SCHEMA_VERSION, ..Default::default() }, true));
        }
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    let mut file: CardChatFile =
        serde_json::from_str(&text).map_err(|error| format!("{} is not a chat record: {error}", path.display()))?;
    if file.version > CHAT_SCHEMA_VERSION {
        return Ok((file, false));
    }
    // v0 (no version) → v1: every field already defaulted; nothing to move.
    file.version = CHAT_SCHEMA_VERSION;
    Ok((file, true))
}

/// Writes `file` atomically, as the current version.
pub(crate) fn save(path: &Path, file: &CardChatFile) -> Result<(), String> {
    let mut file = file.clone();
    file.version = CHAT_SCHEMA_VERSION;
    crate::atomic::write_atomic_json(path, &file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_with_no_version_and_only_the_bare_fields_reads_and_is_written_as_v1() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("chat.json");
        std::fs::write(
            &path,
            r#"{"conversations":[{"vendor":"claude","messages":[{"id":"m1","role":"user","text":"hi"},{"id":"m2","role":"verdict"}]}],
               "attachments":[{"id":"a1","name":"x.png","kind":"image"}],"someFutureField":1}"#,
        )
        .unwrap();
        let (file, writable) = load(&path).unwrap();
        assert!(writable);
        assert_eq!(file.version, CHAT_SCHEMA_VERSION);
        assert_eq!(file.active_vendor, None);
        let chat = file.conversation(ChatVendor::Claude).unwrap();
        assert_eq!(chat.session_id, None);
        assert_eq!(chat.usage, TokenUsage::default());
        assert_eq!(chat.messages[0].source_id, None);
        assert!(!chat.messages[0].done);
        assert_eq!(chat.messages[1].role, "verdict", "an unknown role is kept as it is");
        assert_eq!(file.attachments[0].stored_name, "");
        save(&path, &file).unwrap();
        let on_disk: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk["version"], 1);
        assert_eq!(on_disk["conversations"][0]["messages"][0]["text"], "hi");
        let leftovers: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(leftovers.len(), 1, "atomic: no temp file left");
    }

    #[test]
    fn a_record_from_a_newer_plyloft_is_read_but_never_written_over() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("chat.json");
        std::fs::write(&path, r#"{"version":7,"conversations":[{"vendor":"gemini","messages":[]}]}"#).unwrap();
        let (file, writable) = load(&path).unwrap();
        assert!(!writable);
        assert_eq!(file.conversations[0].vendor, ChatVendor::Other);
    }

    #[test]
    fn a_missing_record_is_an_empty_chat_and_a_broken_one_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let (file, writable) = load(&dir.path().join("none.json")).unwrap();
        assert!(writable && file.conversations.is_empty());
        std::fs::write(dir.path().join("bad.json"), "{not json").unwrap();
        assert!(load(&dir.path().join("bad.json")).is_err());
    }

    #[test]
    fn session_usage_is_replaced_and_earlier_sessions_are_kept() {
        let mut chat = Conversation::new(ChatVendor::Claude, 0);
        let tokens = |n| TokenUsage { input_tokens: n, output_tokens: n, ..Default::default() };
        chat.set_session_usage(tokens(10));
        chat.set_session_usage(tokens(25));
        assert_eq!(chat.usage.input_tokens, 25);
        chat.begin_session();
        chat.set_session_usage(tokens(5));
        assert_eq!(chat.usage.input_tokens, 30);
        // A running total that starts over never lowers what was counted.
        chat.set_session_usage(tokens(2));
        assert_eq!(chat.usage.input_tokens, 32);
    }

    #[test]
    fn ids_must_be_one_plain_path_component() {
        assert!(card_dir(Path::new("/c"), "ws-1", "card_2").is_ok());
        for bad in ["", "..", "a/b", "a\\b", "c:d", "x\ny"] {
            assert!(card_dir(Path::new("/c"), bad, "card").is_err(), "{bad}");
            assert!(card_dir(Path::new("/c"), "ws", bad).is_err(), "{bad}");
        }
        assert_eq!(
            card_dir(Path::new("/c"), "ws", "card").unwrap(),
            Path::new("/c").join("projects").join("ws").join("cards").join("card")
        );
    }

    #[test]
    fn the_message_cap_drops_the_oldest() {
        let mut chat = Conversation::new(ChatVendor::Codex, 0);
        for n in 0..MAX_MESSAGES + 3 {
            chat.push(ChatMessage::new("user", n.to_string(), 0));
        }
        assert_eq!(chat.messages.len(), MAX_MESSAGES);
        assert_eq!(chat.messages[0].text, "3");
    }
}
