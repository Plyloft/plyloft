//! Terminals block P2: a tile's name, read from the CLI's own files on this
//! computer — never made by Plyloft (Hard rule 1: no AI of its own).
//!
//! - Claude Code keeps `<config>/projects/<cwd key>/<session id>.jsonl`. Its
//!   own title is an `ai-title` line (`aiTitle`, Claude Code 2.1.306), written
//!   after the first turn and repeated (the last one wins); a `/rename` writes
//!   `custom-title` (`customTitle`). The first message the member typed is the
//!   first `user` line that is not meta, a sidechain or a tag (`<command-…>`,
//!   `<pasted_content>`).
//! - Codex keeps `sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`; its first user
//!   message is its own `<environment_context>`, the member's is the next.
//!   A `/rename` lands in `session_index.jsonl` (`thread_name`).
//!
//! Files can be very large (one live transcript measured 581 MB): only the
//! first and last [`SCAN_BYTES`] are read — for a Codex rollout, its lines up
//! to [`CODEX_HEAD_BYTES`], until the member's first message. Only the title leaves this module,
//! cut to one short line; the message itself is never kept.

use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use serde_json::Value;

use crate::terminal_sessions::TitleSource;

pub const SCAN_BYTES: u64 = 64 * 1024;
/// Codex 0.163 writes its own preamble first (session meta, developer
/// instructions, world state: about 75 KB measured), so the member's first
/// message lies past [`SCAN_BYTES`] (P2 walk).
pub const CODEX_HEAD_BYTES: u64 = 1024 * 1024;

/// What a transcript says about its title, the strongest first.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Found {
    /// The member's `/rename` in the CLI.
    pub renamed: Option<String>,
    /// The CLI's own title (Claude's `ai-title`).
    pub cli: Option<String>,
    /// The first message the member typed.
    pub first_message: Option<String>,
    /// Claude: the folder the conversation ran in (its first lines' `cwd`),
    /// so Resume… lists a project's own only.
    pub cwd: Option<String>,
}

impl Found {
    /// The title to show and where it came from.
    pub fn best(&self) -> Option<(String, TitleSource)> {
        if let Some(t) = &self.renamed {
            return Some((t.clone(), TitleSource::User));
        }
        if let Some(t) = &self.cli {
            return Some((t.clone(), TitleSource::Cli));
        }
        self.first_message
            .as_deref()
            .and_then(from_first_message)
            .map(|t| (t, TitleSource::FirstMessage))
    }
}

/// The first and the last [`SCAN_BYTES`] of a file, as lines (a cut line at
/// either edge is dropped).
fn head_and_tail(path: &Path) -> (Vec<String>, Vec<String>) {
    let Ok(mut file) = std::fs::File::open(path) else { return (Vec::new(), Vec::new()) };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut head = vec![0u8; SCAN_BYTES.min(len) as usize];
    if file.read_exact(&mut head).is_err() {
        return (Vec::new(), Vec::new());
    }
    let head_lines = lines_of(&head, false, len > SCAN_BYTES);
    if len <= SCAN_BYTES {
        return (head_lines, Vec::new());
    }
    let start = len.saturating_sub(SCAN_BYTES).max(SCAN_BYTES);
    let mut tail = Vec::new();
    if file.seek(SeekFrom::Start(start)).is_ok() {
        let _ = file.take(len - start).read_to_end(&mut tail);
    }
    (head_lines, lines_of(&tail, start > SCAN_BYTES, false))
}

fn lines_of(bytes: &[u8], drop_first: bool, drop_last: bool) -> Vec<String> {
    let text = String::from_utf8_lossy(bytes);
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    if drop_first && !lines.is_empty() {
        lines.remove(0);
    }
    if drop_last && !lines.is_empty() {
        lines.pop();
    }
    lines
}

/// A message's text: a string, or the text parts of a list.
fn content_text(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(parts) => {
            if parts.iter().any(|p| p.get("type").and_then(Value::as_str) == Some("tool_result")) {
                return None;
            }
            let text: Vec<&str> = parts
                .iter()
                .filter(|p| matches!(p.get("type").and_then(Value::as_str), Some("text") | Some("input_text")))
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect();
            (!text.is_empty()).then(|| text.join(" "))
        }
        _ => None,
    }
}

/// A line the member typed, not a tag the CLI wrote for them.
fn typed(text: &str) -> Option<String> {
    let t = text.trim();
    (!t.is_empty() && !t.starts_with('<')).then(|| t.to_string())
}

/// Claude Code's transcript.
pub fn read_claude(path: &Path) -> Found {
    let (head, tail) = head_and_tail(path);
    let mut found = Found::default();
    let mut scan = |line: &str, take_first: bool| {
        let wants_cwd = take_first && found.cwd.is_none() && line.contains("\"cwd\"");
        if !(wants_cwd
            || line.contains("\"ai-title\"")
            || line.contains("\"custom-title\"")
            || (take_first && line.contains("\"user\"")))
        {
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { return };
        if wants_cwd {
            found.cwd = v.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()).map(str::to_string);
        }
        match v.get("type").and_then(Value::as_str) {
            Some("ai-title") => {
                if let Some(t) = v.get("aiTitle").and_then(Value::as_str).and_then(typed) {
                    found.cli = Some(t);
                }
            }
            Some("custom-title") => {
                if let Some(t) = v.get("customTitle").and_then(Value::as_str).and_then(typed) {
                    found.renamed = Some(t);
                }
            }
            Some("user") if take_first && found.first_message.is_none() => {
                if v.get("isMeta").and_then(Value::as_bool) == Some(true)
                    || v.get("isSidechain").and_then(Value::as_bool) == Some(true)
                {
                    return;
                }
                if let Some(t) = v.pointer("/message/content").and_then(content_text).and_then(|t| typed(&t)) {
                    found.first_message = Some(t);
                }
            }
            _ => {}
        }
    };
    for line in &head {
        scan(line, true);
    }
    // The latest title is near the end.
    for line in &tail {
        scan(line, false);
    }
    found
}

/// A Codex rollout, and its name from `session_index.jsonl` when renamed.
pub fn read_codex(rollout: &Path, index: Option<&Path>, id: &str) -> Found {
    let mut found = Found::default();
    let mut head = std::fs::File::open(rollout).map(|f| BufReader::new(f.take(CODEX_HEAD_BYTES))).ok();
    let mut buf = Vec::new();
    while let Some(reader) = head.as_mut() {
        if found.first_message.is_some() {
            break;
        }
        buf.clear();
        // A line cut at the limit does not parse, and is skipped.
        if !matches!(reader.read_until(b'\n', &mut buf), Ok(n) if n > 0) {
            break;
        }
        let line = String::from_utf8_lossy(&buf);
        if !line.contains("\"user\"") && !line.contains("UserMessage") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let payload = v.get("payload").unwrap_or(&Value::Null);
        let text = if payload.get("role").and_then(Value::as_str) == Some("user") {
            payload.get("content").and_then(content_text)
        } else if payload.pointer("/item/type").and_then(Value::as_str) == Some("UserMessage") {
            payload.pointer("/item/content").and_then(content_text)
        } else {
            None
        };
        if let Some(t) = text.and_then(|t| typed(&t)) {
            found.first_message = Some(t);
        }
    }
    if let Some(index) = index {
        let (head, tail) = head_and_tail(index);
        for line in head.iter().chain(tail.iter()) {
            if !line.contains(id) {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
            if v.get("id").and_then(Value::as_str) == Some(id) {
                if let Some(t) = v.get("thread_name").and_then(Value::as_str).and_then(typed) {
                    found.renamed = Some(t);
                }
            }
        }
    }
    found
}

/// Openings that say nothing about the work: dropped from a first message's
/// title (English and Italian, the languages seen).
const FILLERS: &[&str] = &[
    "can you please ", "could you please ", "can you ", "could you ", "would you ", "please ", "hey ", "hi ",
    "puoi per favore ", "potresti per favore ", "per favore ", "puoi ", "potresti ", "ciao ",
];

/// A title from the first message: its first sentence, fillers dropped, a
/// capital first letter, one short line.
pub fn from_first_message(text: &str) -> Option<String> {
    let one: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut t = one.as_str();
    loop {
        let lower = t.to_lowercase();
        let Some(f) = FILLERS.iter().find(|f| lower.starts_with(**f)) else { break };
        t = &t[f.len()..];
    }
    let sentence = t
        .split_inclusive(['.', '?', '!', '\n'])
        .next()
        .unwrap_or(t)
        .trim()
        .trim_end_matches(['.', '?', '!', ':', ',', ';'])
        .trim();
    let mut chars = sentence.chars();
    let first = chars.next()?;
    let title: String = first.to_uppercase().chain(chars).collect();
    crate::terminal_sessions::clean_title(&title)
}
