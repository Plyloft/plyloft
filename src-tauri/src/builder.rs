//! v1.106.0 — the live **Builder** session (Builder/Challenger model, ADR
//! 0001, `docs/builder-challenger/DESIGN.md`).
//!
//! A card's Run is one human-attended provider session in the card's
//! worktree, not a chain of headless roles. This module owns:
//!
//!   - `start`: advance the card to In Progress (same claim gate + worktree
//!     path as the board drag), compose the Builder prompt, spawn the
//!     vendor CLI in the worktree with the Knowledge MCP injected, and
//!     record the session on the card (`KanbanCard::builder`).
//!   - `resume`: a new session in the same worktree using the vendor's
//!     native resume (`claude --continue`; `codex resume <its own session id>`,
//!     see `codex_sessions`), after a lost session (D13).
//!   - `done`: "Build done" (D6/E1) — commit a build snapshot of the
//!     worktree, record it, and flip the card to a finished run so the
//!     lifecycle moves to Outcome. Verify is started by the frontend.
//!   - `close` / `session_ended`: bookkeeping when the human closes the
//!     session (E3, Ship) or the process exits on its own.
//!   - `read_capture`: the captured output so the xterm can replay it when
//!     the card is reopened (the PTY outlives the React host).
//!
//! Hard rules honoured: real `claude` CLI in a PTY with cached PATH
//! (`pty.rs`), atomic card writes through `KanbanStore::with_card`,
//! children killed with the `PtyRegistry` on exit. Processes are never
//! resurrected.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicI64;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::AppHandle;

use crate::kanban::{
    BuildSnapshot, BuilderReview, BuilderState, KanbanCard, KanbanStore, LastRunStatus, ReviewStatus,
    HandedOverRequest, SelfCheckRecord, UndeliveredVerdict, WaitingReview,
};
use crate::settings::{AgentRole, BuilderPermissions, ModelChoice};
use tauri::Manager;
use crate::pty::PtyRegistry;
use crate::shell_env;

/// Bytes of captured output handed back to a re-attaching xterm.
pub(crate) const CAPTURE_REPLAY_MAX: usize = 256 * 1024;

/// In-memory record of one live Builder session.
pub struct BuilderSession {
    pub pty_id: String,
    pub workspace_id: String,
    pub card_id: String,
    pub vendor: String,
    pub capture: Arc<Mutex<Vec<u8>>>,
    pub last_activity_at: Arc<AtomicI64>,
    /// UX P-F: the `--session-id` a Claude session was started (or resumed)
    /// with — its transcript is the one the usage-limit rule reads.
    pub claude_session_id: Option<String>,
    /// Where that transcript was found, once it was (runtime cache).
    transcript: Arc<Mutex<TranscriptRead>>,
}

/// `card_id → BuilderSession`. One session per card.
#[derive(Default)]
pub struct BuilderRegistry {
    sessions: Mutex<HashMap<String, BuilderSession>>,
    /// v1.154.1 (F17): `card_id → (pty_id, when)` of a session Resume
    /// spawned, so an exit right after it is told apart (runtime only).
    resumed: Mutex<HashMap<String, (String, i64)>>,
    /// 1.176.2 (review M1), 1.176.3 phase 2: each session's screen as a
    /// terminal draws it, for the sessions no terminal of the window shows
    /// (`builder_screens`), fed when the window reads them.
    pub(crate) screens: crate::builder_screens::ScreenGrids,
}

/// v1.154.1 (F17): a resumed session that exits sooner than this found
/// nothing to continue (`claude --continue` with no conversation in the
/// worktree exits at once).
pub const RESUME_QUICK_EXIT_MS: i64 = 10_000;

impl BuilderRegistry {
    pub fn get_pty(&self, card_id: &str) -> Option<String> {
        self.sessions.lock().get(card_id).map(|s| s.pty_id.clone())
    }
    fn insert(&self, session: BuilderSession) {
        self.sessions.lock().insert(session.card_id.clone(), session);
    }
    fn remove(&self, card_id: &str) -> Option<BuilderSession> {
        self.sessions.lock().remove(card_id)
    }
    /// A session under `key` with no process behind it, for tests of the
    /// registry's keying.
    #[cfg(test)]
    pub(crate) fn insert_for_test(&self, key: &str, pty_id: &str, vendor: &str) {
        self.insert(BuilderSession {
            pty_id: pty_id.into(),
            workspace_id: "ws".into(),
            card_id: key.into(),
            vendor: vendor.into(),
            capture: Arc::new(Mutex::new(Vec::new())),
            last_activity_at: Arc::new(AtomicI64::new(0)),
            claude_session_id: None,
            transcript: Arc::default(),
        });
    }
    /// As [`Self::insert_for_test`], for a Claude session whose transcript
    /// is at `transcript`.
    #[cfg(test)]
    pub(crate) fn insert_claude_for_test(&self, key: &str, session_id: &str, transcript: Option<PathBuf>) {
        self.insert(BuilderSession {
            pty_id: format!("pty-{key}"),
            workspace_id: "ws".into(),
            card_id: key.into(),
            vendor: "claude".into(),
            capture: Arc::new(Mutex::new(Vec::new())),
            last_activity_at: Arc::new(AtomicI64::new(0)),
            claude_session_id: Some(session_id.into()),
            transcript: Arc::new(Mutex::new(TranscriptRead { path: transcript, ..TranscriptRead::default() })),
        });
    }
    /// v1.154.1 (F17): `pty_id` is a session Resume spawned at `at`.
    pub(crate) fn mark_resumed(&self, card_id: &str, pty_id: &str, at: i64) {
        self.resumed.lock().insert(card_id.to_string(), (pty_id.to_string(), at));
    }
    /// When `pty_id` was resumed, if it was (taken: asked once per exit).
    pub(crate) fn take_resumed(&self, card_id: &str, pty_id: &str) -> Option<i64> {
        let mut map = self.resumed.lock();
        match map.get(card_id) {
            Some((pty, at)) if pty == pty_id => {
                let at = *at;
                map.remove(card_id);
                Some(at)
            }
            _ => None,
        }
    }
    /// SL-6: drop a session whose PTY already exited, without a kill.
    /// Removed, with its session (so the caller can read its last output).
    pub(crate) fn forget(&self, key: &str) -> Option<BuilderSession> {
        self.remove(key)
    }
    /// SL-6: the picked lane's live session becomes the card's own — the
    /// same PTY, now under `to`. `false` when `from` had none, or `to`
    /// already has one (nothing moves then).
    pub(crate) fn rekey(&self, from: &str, to: &str) -> bool {
        let mut sessions = self.sessions.lock();
        if sessions.contains_key(to) {
            return false;
        }
        match sessions.remove(from) {
            Some(mut session) => {
                session.card_id = to.to_string();
                sessions.insert(to.to_string(), session);
                true
            }
            None => false,
        }
    }
    /// GH #116: end a live session without touching the card — the card's
    /// row may already be gone (a delete). Kills the PTY exactly as app
    /// exit does, so no `claude`, `codex` or `ply-mcp` child outlives it.
    /// `false` when the card had no live session.
    pub fn end_session(&self, pty_registry: &PtyRegistry, card_id: &str) -> bool {
        let Some(session) = self.remove(card_id) else {
            return false;
        };
        if let Err(e) = pty_registry.kill(&session.pty_id) {
            log::warn!("builder: ending {card_id}'s session ({}): {e}", session.pty_id);
        }
        true
    }
    fn capture(&self, card_id: &str) -> Option<Arc<Mutex<Vec<u8>>>> {
        self.sessions.lock().get(card_id).map(|s| s.capture.clone())
    }
    /// ADR 0006 (third card): when the session last printed anything, in
    /// ms — stamped by the PTY reader whether or not a terminal is attached,
    /// so the self-check can tell a Builder still at work from one that is
    /// back at its prompt while the card is closed.
    pub fn last_output_at(&self, card_id: &str) -> Option<i64> {
        self.sessions
            .lock()
            .get(card_id)
            .map(|s| s.last_activity_at.load(std::sync::atomic::Ordering::Relaxed))
    }
    /// 1.176.2 (review M1): what [`crate::builder_screens`] reads of each
    /// live session but those in `skip` — taken out under the registry's
    /// lock, read after it.
    pub(crate) fn screen_sources(&self, skip: &std::collections::HashSet<String>) -> Vec<crate::builder_screens::ScreenSource> {
        self.sessions
            .lock()
            .iter()
            .filter(|(key, _)| !skip.contains(*key))
            .map(|(key, s)| crate::builder_screens::ScreenSource {
                key: key.clone(),
                pty_id: s.pty_id.clone(),
                vendor: s.vendor.clone(),
                capture: s.capture.clone(),
                last_output_at: s.last_activity_at.load(std::sync::atomic::Ordering::Relaxed),
            })
            .collect()
    }
    /// UX P-F (UX P1 point 8; was `trust_questions`, v1.154.1 walk G1):
    /// every live session stopped where only the person can move it on —
    /// read whether or not a terminal is attached, so a card that isn't open
    /// is seen too. Keys are the registry's (`<card>` or SL-6's
    /// `<card>#both-a|b`). Plyloft never answers any of them and never types
    /// "continue". Per session, the first that holds:
    ///
    /// - `trust`: the capture's tail ends on the CLI's folder-trust question
    ///   ([`trust_question_pending`]);
    /// - `bypass` / `usageLimit` (menu): the tail ends on Claude's Bypass
    ///   Permissions warning or its usage-limit menu, with nothing Claude
    ///   draws once it is answered after it ([`session_menu_block`]); macOS
    ///   only until the Windows fixtures are recorded ([`MENU_RULES_ON_WINDOWS`]);
    /// - `usageLimit` (mid-turn): the last conversation entry of the
    ///   Builder's own transcript (by its `--session-id`) is Claude's API
    ///   error for a usage limit ([`transcript_usage_limit`]). Platform-free.
    pub fn session_blocks(&self) -> Vec<SessionBlock> {
        type Live = (SessionBlock, Arc<Mutex<Vec<u8>>>, Option<String>, Arc<Mutex<TranscriptRead>>);
        // Taken out of the registry first: no capture or file is read under its lock.
        let live: Vec<Live> = self
            .sessions
            .lock()
            .iter()
            .map(|(key, s)| {
                let b = SessionBlock {
                    key: key.clone(),
                    workspace_id: s.workspace_id.clone(),
                    vendor: s.vendor.clone(),
                    intake: false,
                    kind: SessionBlockKind::Trust,
                    resets_at: None,
                };
                (b, s.capture.clone(), s.claude_session_id.clone(), s.transcript.clone())
            })
            .collect();
        let config = crate::claude_session::claude_config_dir();
        let mut out: Vec<SessionBlock> = live
            .into_iter()
            .filter_map(|(b, capture, session_id, transcript)| {
                #[cfg(any(test, all(feature = "test-bridge", debug_assertions)))]
                if let Some((kind, resets_at)) = injected_block(&b.key) {
                    return Some(SessionBlock { kind, resets_at, ..b });
                }
                let tail: Vec<u8> = {
                    let capture = capture.lock();
                    let from = capture.len().saturating_sub(TRUST_SCAN_BYTES);
                    capture[from..].to_vec()
                };
                if trust_question_pending(&tail) {
                    return Some(b);
                }
                if b.vendor != "claude" {
                    return None;
                }
                if menu_rules_apply() {
                    if let Some((kind, resets_at)) = session_menu_block(&tail) {
                        return Some(SessionBlock { kind, resets_at, ..b });
                    }
                }
                let resets_at = builder_transcript_limit(config.as_deref()?, session_id.as_deref()?, &transcript)?;
                Some(SessionBlock { kind: SessionBlockKind::UsageLimit, resets_at, ..b })
            })
            .collect();
        out.sort_by(|a, b| a.key.cmp(&b.key));
        out
    }
}

/// UX P-F: what stops a session until the person acts in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionBlockKind {
    /// The CLI's folder-trust question (v1.154.1 walk G1).
    Trust,
    /// Claude's Bypass Permissions warning before its first session in it.
    Bypass,
    /// Claude's usage limit: its menu before a turn, or a turn it ended.
    UsageLimit,
}

/// UX P-F (was `TrustQuestion`, v1.154.1 walk G1): a live session stopped
/// where only the person can move it on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBlock {
    pub key: String,
    pub workspace_id: String,
    pub vendor: String,
    /// N14 walk F10: the card's intake conversation asks, not its Builder.
    pub intake: bool,
    pub kind: SessionBlockKind,
    /// A usage limit's reset time as Claude wrote it ("3pm"), when it did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
}

/// UX P-F: the menu rules ([`session_menu_block`]) read the bytes macOS's
/// PTY carries. Windows' ConPTY repaints with sequences of its own (erase
/// runs, cursor moves, 32,767-column borders), so on Windows they stay off
/// until the bypass warning and the limit menu are recorded there as
/// fixtures and the tests pass on them (owed: the Windows VM). The
/// transcript rule runs on both.
pub(crate) const MENU_RULES_ON_WINDOWS: bool = false;

/// Terminals block P3: what stops a Terminals tile's session, read from the
/// screen as xterm drew it (text, no escapes) — the same rules a card's
/// Builder is read with. Drawn text needs none of ConPTY's repaint care, so
/// the menu rules apply on Windows too here.
pub(crate) fn screen_block(text: &str) -> Option<(SessionBlockKind, Option<String>)> {
    let bytes = text.as_bytes();
    if trust_question_pending(bytes) {
        return Some((SessionBlockKind::Trust, None));
    }
    session_menu_block(bytes)
}

fn menu_rules_apply() -> bool {
    !cfg!(windows) || MENU_RULES_ON_WINDOWS
}

/// Claude's usage-limit menu: both of its ways out (squashed as
/// [`visible_squashed`]; recorded "❯ 1. Stop and wait for limit to reset /
/// 2. Upgrade your plan", `claude_session.rs` and `chat_tests.rs` fixtures).
const LIMIT_MENU_CHOICES: &[&str] = &["stopandwaitforlimittoreset", "upgradeyourplan"];
/// Claude's Bypass Permissions warning: the mode's name, then both ways out
/// ("❯ 1. No, exit / 2. Yes, I accept"), as `claude_session::blocking_screen`
/// reads it before a collected session starts.
const BYPASS_MENU_TITLE: &str = "bypasspermissionsmode";
const BYPASS_MENU_CHOICES: &[&str] = &["no,exit", "yes,iaccept"];
/// How far apart a menu's own rows may be drawn (squashed characters).
const MENU_SPAN: usize = 600;
/// What a menu's screen still draws after its last choice: a key hint, its
/// bottom edge.
const MENU_TAIL_MAX: usize = 400;
/// What Claude draws once a menu is answered, or below a copy of it that is
/// only quoted in the conversation: its composer (a rule straight above the
/// prompt mark), the composer's footer, a working turn, its welcome.
const PAST_MENU_MARKERS: &[&str] = &[
    "esctointerrupt",
    "forshortcuts",
    "shift+tabtocycle",
    "welcometoclaude",
    "\u{2500}\u{276f}",
];

/// UX P-F: whether this tail of a Claude session's output ends on its
/// Bypass Permissions warning or its usage-limit menu — every row of the
/// menu, and after its last row only the rest of the menu's own screen.
/// A Builder quoting either in its answer has its composer drawn below the
/// copy, and is not stopped.
pub(crate) fn session_menu_block(tail: &[u8]) -> Option<(SessionBlockKind, Option<String>)> {
    let text = visible_squashed(tail);
    if menu_pending(&text, BYPASS_MENU_CHOICES, Some(BYPASS_MENU_TITLE)) {
        return Some((SessionBlockKind::Bypass, None));
    }
    if menu_pending(&text, LIMIT_MENU_CHOICES, None) {
        let readable = crate::claude_session::strip_escapes(&String::from_utf8_lossy(tail));
        let from = floor_boundary(&readable, readable.len().saturating_sub(4 * 1024));
        return Some((SessionBlockKind::UsageLimit, resets_at_of(&readable[from..])));
    }
    None
}

fn floor_boundary(text: &str, mut at: usize) -> usize {
    while at > 0 && !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

/// Every one of `choices` drawn within [`MENU_SPAN`] of the last of them
/// (and `title` within twice that before it), and after it nothing but
/// [`MENU_TAIL_MAX`] characters with no [`PAST_MENU_MARKERS`].
fn menu_pending(text: &str, choices: &[&str], title: Option<&str>) -> bool {
    let ends: Option<Vec<usize>> = choices.iter().map(|c| text.rfind(c).map(|at| at + c.len())).collect();
    let Some(ends) = ends else { return false };
    let end = ends.iter().copied().max().unwrap_or(0);
    if ends.iter().any(|e| end - e > MENU_SPAN) {
        return false;
    }
    if let Some(title) = title {
        match text[..end].rfind(title) {
            Some(at) if end - at <= 2 * MENU_SPAN => {}
            _ => return false,
        }
    }
    let after = &text[end..];
    after.chars().count() <= MENU_TAIL_MAX && !PAST_MENU_MARKERS.iter().any(|m| after.contains(m))
}

/// A usage limit's reset time, as Claude wrote it on the last line that
/// says one ("… · resets 3pm", "… will reset at 3pm (Europe/Rome)."): no
/// time-zone guessing, nothing longer than a time and a zone.
pub(crate) fn resets_at_of(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let at = ["resets at ", "resets ", "reset at "]
        .iter()
        .filter_map(|word| lower.rfind(word).map(|at| at + word.len()))
        .max()?;
    let rest = text[at..].lines().next().unwrap_or("");
    let cut = rest
        .find(|c: char| matches!(c, '\u{b7}' | '\u{2219}' | '\u{2022}' | '|' | '\u{2502}'))
        .unwrap_or(rest.len());
    let time = rest[..cut].trim().trim_end_matches(['.', ',', ';', ':', '!']).trim();
    // (Challenger) A weekly limit may reset on another day: "resets Oct 21,
    // 1pm (Europe/Rome)", "resets Mon 9am" — a date or a day, then a time.
    let lower_time = time.to_ascii_lowercase();
    let starts_like_a_day =
        RESET_DAY_WORDS.iter().any(|w| lower_time.starts_with(w)) && time.chars().any(|c| c.is_ascii_digit());
    let starts_like_a_time = time.chars().next().is_some_and(|c| c.is_ascii_digit()) || starts_like_a_day;
    (starts_like_a_time && time.chars().count() <= 40).then(|| time.to_string())
}

/// What a reset written for another day starts with (a month, a weekday,
/// "tomorrow"), always with a time after it.
const RESET_DAY_WORDS: &[&str] = &[
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec", "mon", "tue", "wed", "thu",
    "fri", "sat", "sun", "tomorrow",
];

/// (Challenger) A reset time Claude gave only as a Unix time (its old
/// "Claude AI usage limit reached|1760000000" wording, or the entry's
/// `quotaLimits.resetsAt`), in this computer's own zone, as Claude's own
/// screen says it ("3pm", "3:30pm"; "Oct 21, 3pm" on another day).
fn local_reset_time(epoch_secs: i64, now: chrono::DateTime<chrono::Local>) -> Option<String> {
    use chrono::{Datelike, TimeZone, Timelike};
    let at = chrono::Local.timestamp_opt(epoch_secs, 0).single()?;
    let (pm, hour) = at.hour12();
    let half = if pm { "pm" } else { "am" };
    let time = if at.minute() == 0 { format!("{hour}{half}") } else { format!("{hour}:{:02}{half}", at.minute()) };
    if at.date_naive() == now.date_naive() {
        return Some(time);
    }
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    Some(format!("{} {}, {time}", MONTHS[at.month0() as usize], at.day()))
}

/// (Challenger) Whether an API error's text says a plan's usage limit, in
/// any wording Claude has used: "You've hit your limit · resets 3pm",
/// "You've hit your weekly limit · resets 1pm (Europe/Rome)" (recorded,
/// Claude Code 2.1.283), "5-hour limit reached ∙ resets 3pm", "Claude AI
/// usage limit reached|<time>", and the API's quota words. A context or
/// token limit ("Context limit reached", an output token maximum) is not
/// the plan's limit, nor is an overload, a server error or a refused
/// connection. Read only from an entry Claude marks `isApiErrorMessage`.
pub(crate) fn says_usage_limit(text: &str) -> bool {
    let lower = text.to_lowercase();
    if ["usage limit", "quota exceeded", "insufficient_quota"].iter().any(|w| lower.contains(w)) {
        return true;
    }
    if lower.contains("context") || lower.contains("token") {
        return false;
    }
    lower.contains("limit") && (lower.contains("hit your") || lower.contains("reached your") || lower.contains("limit reached"))
}

/// How much of a Builder's transcript the limit rule reads: its last
/// entries, many times over.
const TRANSCRIPT_TAIL_BYTES: u64 = 128 * 1024;

/// UX P-F: the mid-turn limit, from the end of a transcript (`cut`: the
/// first line may be half of one). `Some(resets_at)` when its last
/// conversation entry — an assistant or a user entry; meta and side-chain
/// entries left out — is Claude's API error for a usage limit. A user entry
/// after it (the person sent anything) clears it; text the Builder wrote,
/// a file it read or a tool's output is never an API error entry.
pub(crate) fn transcript_usage_limit(tail: &str, cut: bool) -> Option<Option<String>> {
    let skip = usize::from(cut);
    let last = tail
        .lines()
        .skip(skip)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .find(|entry| {
            let flag = |key: &str| entry.get(key).and_then(|v| v.as_bool()) == Some(true);
            matches!(entry.get("type").and_then(|t| t.as_str()), Some("user" | "assistant"))
                && !flag("isMeta")
                && !flag("isSidechain")
        })?;
    if last.get("type").and_then(|t| t.as_str()) != Some("assistant")
        || last.get("isApiErrorMessage").and_then(|v| v.as_bool()) != Some(true)
    {
        return None;
    }
    let text = match &last["message"]["content"] {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    // (Challenger) Claude 2.1 marks a plan's limit itself: `quotaLimits`
    // with `status: "rejected"` (recorded with "You've hit your weekly
    // limit"); older entries say it only in words. An overload, a server
    // error or a refused connection carry neither.
    let quota = &last["quotaLimits"];
    let rejected = quota.get("status").and_then(|v| v.as_str()) == Some("rejected");
    if !rejected && !says_usage_limit(&text) {
        return None;
    }
    let epoch = quota.get("resetsAt").and_then(|v| v.as_i64()).or_else(|| {
        let after = text.rsplit_once("limit reached|")?.1;
        after.trim().split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
    });
    Some(resets_at_of(&text).or_else(|| local_reset_time(epoch?, chrono::Local::now())))
}

/// What the limit rule last read of a Builder's transcript (runtime only).
#[derive(Debug, Default)]
pub(crate) struct TranscriptRead {
    /// Where the transcript was found, once it was.
    path: Option<PathBuf>,
    /// (Challenger) The file's length and modified time when it was last
    /// read, and what the rule said then: an unchanged file (a Builder
    /// stopped at its limit, or idle) is not read again every 2 s.
    seen: Option<(u64, Option<std::time::SystemTime>)>,
    limit: Option<Option<String>>,
    /// (Challenger) When `<config>/projects/*/` was last walked for a file
    /// not written yet: at most every [`TRANSCRIPT_SEARCH_EVERY`].
    searched_at: Option<std::time::Instant>,
}

/// How often a transcript not found yet is looked for again.
const TRANSCRIPT_SEARCH_EVERY: std::time::Duration = std::time::Duration::from_secs(10);

/// The limit rule on a Builder's own transcript, found by its session id
/// under `<config>/projects/*/` and remembered in `cache`, read again only
/// when the file changed.
fn builder_transcript_limit(config: &Path, session_id: &str, cache: &Mutex<TranscriptRead>) -> Option<Option<String>> {
    let mut read = cache.lock();
    let path = match read.path.as_ref().filter(|p| p.is_file()) {
        Some(path) => path.clone(),
        None => {
            if read.searched_at.is_some_and(|at| at.elapsed() < TRANSCRIPT_SEARCH_EVERY) {
                return None;
            }
            read.searched_at = Some(std::time::Instant::now());
            let found = crate::claude_session::find_transcript(config, session_id)?;
            *read = TranscriptRead { path: Some(found.clone()), ..TranscriptRead::default() };
            found
        }
    };
    let meta = std::fs::metadata(&path).ok()?;
    let stamp = (meta.len(), meta.modified().ok());
    if read.seen == Some(stamp) {
        return read.limit.clone();
    }
    let (tail, cut) = file_tail(&path, TRANSCRIPT_TAIL_BYTES)?;
    let limit = transcript_usage_limit(&tail, cut);
    read.seen = Some(stamp);
    read.limit = limit.clone();
    limit
}

/// The last `max` bytes of a file, and whether it had more.
fn file_tail(path: &Path, max: u64) -> Option<(String, bool)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let from = len.saturating_sub(max);
    file.seek(SeekFrom::Start(from)).ok()?;
    let mut bytes = Vec::with_capacity((len - from) as usize);
    file.read_to_end(&mut bytes).ok()?;
    Some((String::from_utf8_lossy(&bytes).into_owned(), from > 0))
}

/// UX P-F: the dev-only test bridge's `builder.injectBlock` — what
/// [`BuilderRegistry::session_blocks`] reports for a live session, so a
/// Tier 4 walk can read the card, Board and Inbox words without a real
/// limit. It sets the detector's result, never the PTY's bytes; the
/// detector itself is held by the fixtures in the tests.
#[cfg(any(test, all(feature = "test-bridge", debug_assertions)))]
type Injected = Mutex<HashMap<String, (SessionBlockKind, Option<String>)>>;

#[cfg(any(test, all(feature = "test-bridge", debug_assertions)))]
fn injected() -> &'static Injected {
    static INJECTED: std::sync::OnceLock<Injected> = std::sync::OnceLock::new();
    INJECTED.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(any(test, all(feature = "test-bridge", debug_assertions)))]
fn injected_block(key: &str) -> Option<(SessionBlockKind, Option<String>)> {
    injected().lock().get(key).cloned()
}

/// Sets (or, with `None`, clears) the block reported for session `key`.
#[cfg(any(test, all(feature = "test-bridge", debug_assertions)))]
pub(crate) fn inject_block(key: &str, block: Option<(SessionBlockKind, Option<String>)>) {
    if let Some(block) = block {
        injected().lock().insert(key.to_string(), block);
    } else {
        injected().lock().remove(key);
    }
}

/// How much of a session's capture the trust scan reads: the question and
/// what came after it fit many times over.
const TRUST_SCAN_BYTES: usize = 24 * 1024;

/// The trust question's words, lower case with every space removed (a TUI
/// may move the cursor instead of printing a space). Claude Code: "Quick
/// safety check: Is this a project you created or one you trust? … ❯ 1. Yes,
/// I trust this folder  2. No, exit" (2.1.x; older builds asked "Do you trust
/// the files in this folder?"). Codex: "Do you trust the contents of this
/// directory? … 1. Yes, continue  2. No, quit" (0.15x; older builds offered
/// "Yes, allow Codex to work in this folder without asking for approval").
/// Codex 0.158 (walk R4, J3): "Folder access … Trust this folder? Codex can
/// read, edit, and run files here … › 1. Trust and continue  2. Quit … enter
/// continue · esc quit" (a later screen offers "Open restricted" instead).
/// Codex 0.171 (1.176.2, recorded from a tile): the same screen, its way out
/// "2. Back to Agent Command Center" and its hint "enter continue · esc back".
const TRUST_MARKERS: &[&str] = &[
    "yes,itrustthisfolder",
    "isthisaprojectyoucreatedoroneyoutrust",
    "doyoutrustthefilesinthisfolder",
    "doyoutrustthecontentsofthisdirectory",
    "allowcodextoworkinthisfolder",
    "trustthisfolder?codexcan",
    "trustandcontinue",
];

/// Once the question is answered the CLI draws its own screen and starts on
/// the brief; any of these after the question means it has moved on.
const PAST_TRUST_MARKERS: &[&str] = &[
    "esctointerrupt",
    "forshortcuts",
    "shift+tabtocycle",
    "welcometoclaude",
    "openaicodex",
];

/// Visible characters (spaces removed) the question's own screen still
/// draws after its last marker: the other choice and the key hints.
const TRUST_TAIL_MAX: usize = 400;

/// The question's screen always offers a way out beside Yes…
const TRUST_NO_CHOICES: &[&str] = &[
    "no,exit",
    "no,quit",
    "no,askmetoapprove",
    "2.quit",
    "openrestricted",
    "2.backtoagentcommandcenter",
];
/// …and ends on its key hint. Without both, the words are someone's text
/// (a diff line, the Builder's answer), not the question.
const TRUST_KEY_HINTS: &[&str] = &["entertoconfirm", "pressentertocontinue", "entercontinue"];
/// How far before the last marker the way out may be drawn (a screen that
/// lists No first).
const TRUST_SCREEN_BEFORE: usize = 600;

/// The terminal's visible text: escape sequences (CSI, OSC, and two-byte
/// escapes) dropped, lower case, every whitespace character removed.
fn visible_squashed(bytes: &[u8]) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == 0x1b {
            match bytes.get(i + 1) {
                Some(b'[') => {
                    i += 2;
                    while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                        i += 1;
                    }
                    i += 1;
                }
                Some(b']') => {
                    i += 2;
                    while i < bytes.len() {
                        if bytes[i] == 0x07 {
                            i += 1;
                            break;
                        }
                        if bytes[i] == 0x1b && bytes.get(i + 1) == Some(&b'\\') {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                Some(_) => i += 2,
                None => i += 1,
            }
            continue;
        }
        if b < 0x20 || b == 0x7f {
            i += 1;
            continue;
        }
        out.push(b);
        i += 1;
    }
    String::from_utf8_lossy(&out)
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// v1.154.1 round 3 (L2): Codex's own words when `codex resume <id>` cannot
/// open the thread (measured on 0.158.0: "Error: Failed to resume session
/// from …: thread/resume failed during TUI bootstrap: thread/resume failed:
/// no rollout found for thread id …"), squashed as [`visible_squashed`].
const RESUME_FAILED_MARKERS: &[&str] = &["norolloutfoundforthreadid", "failedtoresumesession"];
/// How much of a resumed session's last output is read for them.
const RESUME_FAILED_TAIL: usize = 16 * 1024;

/// Whether a resumed session's output ends on Codex saying it could not
/// resume. Asked only of a session Resume spawned, so a Builder that merely
/// prints these words (reading this code) is never taken for one. The
/// 10 s rule alone missed it when the human took a while over the trust
/// question Codex asks first.
/// The last [`RESUME_FAILED_TAIL`] bytes of a session's capture, copied while
/// its lock is held (never the whole capture).
pub(crate) fn capture_tail(capture: &Mutex<Vec<u8>>) -> Vec<u8> {
    let bytes = capture.lock();
    bytes[bytes.len().saturating_sub(RESUME_FAILED_TAIL)..].to_vec()
}

pub(crate) fn resume_failed_in_output(output: &[u8]) -> bool {
    let tail = &output[output.len().saturating_sub(RESUME_FAILED_TAIL)..];
    let text = visible_squashed(tail);
    RESUME_FAILED_MARKERS.iter().any(|m| text.contains(m))
}

/// Whether a session Resume spawned at `resumed_at` (if it was) failed: it
/// ended at once, or Codex said it could not resume.
pub(crate) fn resume_failed(resumed_at: Option<i64>, now: i64, output: Option<&[u8]>) -> bool {
    resumed_at.is_some_and(|at| resumed_quickly(at, now) || output.is_some_and(resume_failed_in_output))
}

/// v1.154.1 (walk G1): whether this tail of a session's output ends on the
/// folder-trust question — a marker of it, and after the last one only the
/// rest of its own screen, nothing the CLI draws once it has an answer.
pub fn trust_question_pending(tail: &[u8]) -> bool {
    let text = visible_squashed(tail);
    let Some(end) = TRUST_MARKERS
        .iter()
        .filter_map(|m| text.rfind(m).map(|at| at + m.len()))
        .max()
    else {
        return false;
    };
    let after = &text[end..];
    if after.chars().count() > TRUST_TAIL_MAX || PAST_TRUST_MARKERS.iter().any(|m| after.contains(m)) {
        return false;
    }
    let mut from = end.saturating_sub(TRUST_SCREEN_BEFORE);
    while !text.is_char_boundary(from) {
        from -= 1;
    }
    let screen = &text[from..];
    TRUST_NO_CHOICES.iter().any(|m| screen.contains(m)) && TRUST_KEY_HINTS.iter().any(|m| after.contains(m))
}

/// Whether the trust question's words are on screen with nothing the CLI
/// draws once answered after them — even half drawn (no key hint yet).
pub(crate) fn trust_words_on_screen(tail: &[u8]) -> bool {
    let text = visible_squashed(tail);
    TRUST_MARKERS
        .iter()
        .filter_map(|m| text.rfind(m).map(|at| at + m.len()))
        .max()
        .is_some_and(|end| !PAST_TRUST_MARKERS.iter().any(|m| text[end..].contains(m)))
}

/// Whether this tail draws anything a person can read (not only escape
/// sequences and blank space).
pub(crate) fn has_visible_text(tail: &[u8]) -> bool {
    !visible_squashed(tail).is_empty()
}

/// What Claude Code draws once its REPL waits for the first prompt (squashed
/// as [`visible_squashed`]): the idle footer "? for shortcuts", the 2.1.x
/// mode line "… (shift+tab to cycle)", or the empty input's placeholder
/// `❯ Try "…"` (recorded on 2.1.287).
const CLAUDE_REPL_READY_MARKERS: &[&str] = &["forshortcuts", "shift+tabtocycle", "\u{276f}try\""];

/// N14 walk F10: whether this tail of a Claude session's output shows its
/// REPL ready for typed input — past the folder-trust question if it was
/// asked (only what follows the question's last marker counts), and not
/// stopped at it. Text typed into the trust question is lost and its Enter
/// picks the highlighted choice, which in 2.1.x is "No, exit".
pub(crate) fn claude_repl_ready(tail: &[u8]) -> bool {
    if trust_question_pending(tail) {
        return false;
    }
    let text = visible_squashed(tail);
    let after_trust = TRUST_MARKERS
        .iter()
        .filter_map(|m| text.rfind(m).map(|at| at + m.len()))
        .max()
        .map_or(text.as_str(), |end| &text[end..]);
    CLAUDE_REPL_READY_MARKERS.iter().any(|m| after_trust.contains(m))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuilderStartResult {
    pub pty_id: String,
    pub card: KanbanCard,
}

pub(crate) fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The rules every Builder session starts with, ahead of the card brief.
/// Kept short: the brief is the task, this is the contract with Ply.
pub fn builder_preamble(card_title: &str) -> String {
    builder_preamble_for(card_title, false)
}

/// Walk 2 of #386: on a pull request card the fix reaches the pull request
/// by Push the fixes; nothing on it is shipped.
pub fn builder_preamble_for(card_title: &str, pull_request: bool) -> String {
    let delivered = if pull_request {
        "Plyloft pushes this card's fix to its pull request when the human presses Send the fixes to GitHub."
    } else {
        "Plyloft ships this card when the human presses Ship."
    };
    // Skills hub H5 (Challenger, Builder walk): Plyloft aligns a skill's two
    // copies at Finish and check — never on a pull request card.
    let twins = if pull_request { "" } else { TWINS_RULE };
    format!(
        "You are the Builder for the Plyloft card \"{card_title}\". You are working in \
this card's own git worktree on its own branch.\n\
Rules:\n\
- Do the task below completely: code, tests, and the project's own checks.\n\
- Commit as you go if you like, but do NOT push and do NOT open pull requests. \
{delivered}\n\
- Stay inside this worktree. Do not edit the main checkout or other worktrees.\n\
- Ask the human when a decision is genuinely theirs; otherwise decide and continue.\n\
- When you are finished, say so in one line and stop: the human presses \
\"Finish and check\" in Plyloft, which snapshots the worktree, runs verification and \
sends the result back to you here.\n\
- Your sandbox may block sockets, so the project's full gate can fail locally \
on socket or port errors. That is expected, not a blocker: report what you ran \
and what passed; Plyloft runs the full gate outside the sandbox at Finish and check.\n\
{twins}\n\
Task:\n"
    )
}

/// Skills hub H5 (Challenger, Builder walk card #75): the Builder's rule
/// about a skill's two copies, so it neither edits both nor undoes
/// Plyloft's align commit as "against the brief".
pub const TWINS_RULE: &str = "- A skill in this repository can live in two copies: `.claude/skills/<name>` \
(Claude's) and `.agents/skills/<name>` (Codex's). Edit one copy only. At Finish and check \
Plyloft brings the other copy in line in a commit of its own (`skill: align <name>`); that \
commit is Plyloft's, so do not undo it.\n";

/// Argv for a Builder session. `resume` uses the vendor's native resume
/// so a lost session picks up its own thread in the same worktree.
///
/// Codex (v1.107.0, D3/D14) runs its TUI. It is always sandboxed to the
/// worktree (`--sandbox workspace-write`, the same posture as headless
/// dispatch); "Build without asking" swaps that for `--full-auto`
/// (workspace-write + approvals only on failure), never the unsandboxed
/// bypass. Resume is `codex resume <its own session id>` — never `--last`,
/// which resumes the newest session on the Mac, not in this folder
/// (v1.154.1 round 2, walk J1). `codex_session` is that id
/// ([`crate::codex_sessions::latest_for_folder`]); a Codex resume without
/// one is refused with [`crate::codex_sessions::NOT_FOUND`]. Claude ignores
/// it: `claude --continue` already continues the newest conversation of the
/// directory it runs in.
///
/// GH #69: `claude_theme` (Ply's effective theme at spawn, see
/// `claude_theme::theme_for_spawn`) becomes a per-session
/// `--settings {"theme":…}` ahead of the positional prompt. Codex ignores it.
///
/// #74: `model` is the Builder row of `behavior.models`. Blank fields push
/// no flag at all, so the vendor CLI's own default on that Mac still
/// decides — exactly the behaviour before #74.
/// CL-8 round 2: the chosen model a new Builder session of `vendor` keeps —
/// the card's, only when it is that same vendor's. Starting fresh with the
/// other vendor drops it and reads the workspace's row.
pub fn chosen_model_for(previous: Option<&BuilderState>, vendor: &str) -> Option<crate::build_both::LaneModel> {
    previous.filter(|b| b.vendor == vendor).and_then(|b| b.chosen_model.clone())
}

/// CL-8 round 2: the model a card's Builder spawn uses — the one chosen for
/// the card at Build with both's start when it has one, else the
/// workspace's Builder row (`fallback`).
pub fn builder_model(
    chosen: Option<&crate::build_both::LaneModel>,
    vendor: &str,
    fallback: impl FnOnce() -> ModelChoice,
) -> ModelChoice {
    match chosen {
        // 1.169.0 (A1): an effort the model is known not to take passes no
        // flag, as for the rows (`settings::model_for_card`).
        Some(c) => crate::model_catalog::fit(vendor, c.choice(vendor)),
        None => fallback(),
    }
}

pub fn builder_args(
    vendor: &str,
    bypass: bool,
    resume: bool,
    codex_session: Option<&str>,
    prompt: Option<&str>,
    claude_theme: Option<&str>,
    model: &ModelChoice,
) -> Result<Vec<String>, String> {
    builder_args_in_mode(vendor, bypass, None, resume, codex_session, prompt, claude_theme, model)
}

/// UX P-C (UX_P1 point 5): the guided first card's title — the same words
/// as `FIRST_CARD_TITLE` in `src/lib/firstCardGuide.ts`. Both copies are
/// held to `src/lib/firstCard.fixtures.json` by a test on each side.
pub const FIRST_CARD_TITLE: &str = "Describe this project in the README";

/// UX P-C: the guided first card's brief (its "What you want"), as
/// `FIRST_CARD_BRIEF` in `src/lib/firstCardGuide.ts`.
pub const FIRST_CARD_BRIEF: &str = "Add a short section to README.md: what this project is for and how to run it, \
based on the code. Create README.md if there is none. Change nothing else.";

/// UX P-C: the one permission mode a Builder session may be started in.
/// Claude: `--permission-mode acceptEdits` — file edits in the session's
/// folder (the card's own copy) go through without a menu; an edit outside
/// it, or a command that changes things, still asks. Never
/// `--dangerously-skip-permissions`, which has no bound and draws Claude's
/// Bypass warning. Codex: its bounded pair, `--sandbox workspace-write -a
/// on-request` (1.171.0 D1: the same flags as "Edits its copy without
/// asking", which the card shows) — it edits the card's copy without
/// asking, and anything outside it asks.
pub const GUIDED_PERMISSION_MODE: &str = "acceptEdits";

/// UX P-C: whether a Start build asking for the guided mode (`guided`) gets
/// it. Rust's own test, whatever the window asked: all of these hold, else
/// the card starts as an ordinary one (no error, the default permissions):
/// - "Build without asking" is off (`bypass`): on, it means today's bypass;
/// - the guide (`settings.onboarding.firstCard`) names this workspace and
///   card and has not ended;
/// - the card's title and brief are still the guided ones, after trimming —
///   a person who rewrote the task gets the ordinary card;
/// - it runs in the card's own copy (a worktree), never the member's own
///   checkout (`workspace_cwd`): a card whose recorded copy is the
///   workspace's own folder is refused too (Challenger);
/// - one Builder: not a card built by both, not a pull request card.
///
/// Nothing global is switched on: the mode is decided per start, so a
/// second card fails the second test and starts as today.
pub fn guided_permission_mode(
    guided: bool,
    bypass: bool,
    guide: Option<&crate::settings::FirstCardGuide>,
    workspace_id: &str,
    workspace_cwd: &str,
    card: &KanbanCard,
) -> Option<String> {
    let guide = guide?;
    let applies = guided
        && !bypass
        && guide.workspace_id == workspace_id
        && guide.card_id == card.id
        && guide.ended_at.is_none()
        && card.title.trim() == FIRST_CARD_TITLE
        && card.notes.as_deref().map(str::trim) == Some(FIRST_CARD_BRIEF)
        && card.worktree_path.as_deref().is_some_and(|p| own_copy(p, workspace_cwd))
        && card.build_both.is_none()
        && card.pr_review.is_none();
    applies.then(|| GUIDED_PERMISSION_MODE.to_string())
}

/// QoL 7.4 (B4, owner D10): the Getting started tour's own card — the card
/// the tour recorded at B3 (`settings.onboarding.tutorial.cardId`), on the
/// member's own idea — gets the same bounded mode as the README example
/// ([`GUIDED_PERMISSION_MODE`]: `acceptEdits` for Claude, `--sandbox
/// workspace-write -a on-request` for Codex). Rust's own test, as
/// [`guided_permission_mode`]'s: asked for (`guided`), "Build without
/// asking" off, the tour not ended and naming this workspace and card, the
/// card in its own copy, one Builder. Its task may be anything (it is the
/// member's idea). Only that one card: every later card fails the card test
/// and follows Settings.
pub fn tour_permission_mode(
    guided: bool,
    bypass: bool,
    tutorial: Option<&crate::settings::TutorialProgress>,
    workspace_id: &str,
    workspace_cwd: &str,
    card: &KanbanCard,
) -> Option<String> {
    let tour = tutorial?;
    let applies = guided
        && !bypass
        && tour_still_on_card(tour, workspace_id, card)
        && card.worktree_path.as_deref().is_some_and(|p| own_copy(p, workspace_cwd))
        && card.build_both.is_none()
        && card.pr_review.is_none();
    applies.then(|| GUIDED_PERMISSION_MODE.to_string())
}

/// The tour's Ship it step (`manifest.ts` `STEP.ship`): once it is done the
/// loop is over and the tour card is an ordinary card.
pub const TOUR_SHIP_STEP: &str = "base.ship";

/// QoL 7.4 (Challenger): the tour names this card and is still on it — not
/// ended, Ship it not done, the card not landed — and the card is one the
/// member made in Plyloft during the tour (prudent default for D10's scope):
/// made since the tour started, not a GitHub issue's card, not a follow-up
/// card Plyloft made, and never started before in another mode.
fn tour_still_on_card(tour: &crate::settings::TutorialProgress, workspace_id: &str, card: &KanbanCard) -> bool {
    let started = tour
        .started_at
        .as_deref()
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.timestamp_millis());
    let made_in_tour = started.is_some_and(|ms| card.created_at >= ms);
    let first_mode = card
        .builder
        .as_ref()
        .is_none_or(|b| b.permission_mode.as_deref() == Some(GUIDED_PERMISSION_MODE));
    tour.ended_at.is_none()
        && !tour.done.contains_key(TOUR_SHIP_STEP)
        && tour.workspace_id.as_deref() == Some(workspace_id)
        && tour.card_id.as_deref() == Some(card.id.as_str())
        && !crate::kanban::card_shipped_or_pr_open(card)
        && !crate::pr_status::card_pr_open(card)
        && made_in_tour
        && card.gh_issue_number.is_none()
        && card.follows_up.is_none()
        && first_mode
}

/// QoL 7.4: the bounded mode a start gets — the README example's
/// ([`guided_permission_mode`]) or the tour card's ([`tour_permission_mode`]).
pub fn bounded_permission_mode(
    guided: bool,
    bypass: bool,
    onboarding: &crate::settings::OnboardingSettings,
    workspace_id: &str,
    workspace_cwd: &str,
    card: &KanbanCard,
) -> Option<String> {
    guided_permission_mode(guided, bypass, onboarding.first_card.as_ref(), workspace_id, workspace_cwd, card).or_else(
        || tour_permission_mode(guided, bypass, onboarding.tutorial.as_ref(), workspace_id, workspace_cwd, card),
    )
}

/// UX P-C (Challenger): `worktree` is a folder of its own, not the
/// workspace's checkout itself (compared as written and, where both
/// exist, resolved).
fn own_copy(worktree: &str, workspace_cwd: &str) -> bool {
    let trim = |p: &str| p.trim().trim_end_matches(['/', '\\']).to_string();
    let (wt, cwd) = (trim(worktree), trim(workspace_cwd));
    if wt.is_empty() || wt == cwd {
        return false;
    }
    match (std::fs::canonicalize(&wt), std::fs::canonicalize(&cwd)) {
        (Ok(a), Ok(b)) => a != b,
        _ => true,
    }
}

/// UX P-C (Challenger): the mode a Resume runs in. The session's recorded
/// guided mode is kept only while Rust's own test still holds — the guide
/// not ended, the task unedited, the card's own copy — so a session
/// resumed after End the guide, or after its task was rewritten, starts
/// with the default permissions, as any card does. Any other recorded
/// value resumes with nothing extra.
pub fn resumed_permission_mode(
    state: &crate::kanban::BuilderState,
    guide: Option<&crate::settings::FirstCardGuide>,
    tutorial: Option<&crate::settings::TutorialProgress>,
    workspace_id: &str,
    workspace_cwd: &str,
    card: &KanbanCard,
) -> Option<String> {
    let recorded = state.permission_mode.as_deref() == Some(GUIDED_PERMISSION_MODE);
    // QoL 7.4: the tour card's session resumes bounded while the tour still
    // names it, as the README example's does while its guide runs.
    guided_permission_mode(recorded, state.bypass, guide, workspace_id, workspace_cwd, card)
        .or_else(|| tour_permission_mode(recorded, state.bypass, tutorial, workspace_id, workspace_cwd, card))
}

/// 1.171.0 (D1): what a Start build runs in — the choice it records
/// (`BuilderState.permissions`), whether it is the bypass, and the guided
/// mode it records (`BuilderState.permission_mode`, the tour card's).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartMode {
    pub permissions: Option<BuilderPermissions>,
    pub bypass: bool,
    pub permission_mode: Option<String>,
}

impl StartMode {
    fn chosen(p: BuilderPermissions) -> Self {
        StartMode { permissions: Some(p), bypass: p == BuilderPermissions::NeverAsks, permission_mode: None }
    }

    /// The `permission_mode` [`builder_args_in_mode`] reads for it.
    pub fn args_mode(&self) -> Option<&str> {
        self.permission_mode.as_deref().or(self.permissions.map(BuilderPermissions::mode_str))
    }
}

/// D1 (Challenger 2): the choice a Start build of `card` on `vendor` keeps
/// — the card's own, else (Start fresh) the choice its closed session on
/// the same AI started in. A session on the other AI keeps nothing, as the
/// bypass before it (#378 P3-3).
pub fn card_choice(card: &KanbanCard, vendor: &str) -> Option<BuilderPermissions> {
    card.builder_permissions
        .or_else(|| card.builder.as_ref().filter(|b| b.vendor == vendor).and_then(|b| b.permissions))
}

/// D1: a Start build's mode, in this order:
/// 1. the card's own choice (`card_choice`), or a window that asked for the
///    bypass (`window_bypass`: a closed session's posture kept by Start
///    fresh, on a card with no choice of its own);
/// 2. else the tour card's bounded mode, when Rust's own test grants it
///    (`bounded`, [`bounded_permission_mode`]), recorded as before so its
///    Resume keeps today's rule;
/// 3. else the Settings default (`behavior.builderPermissions`).
pub fn start_mode(
    card_choice: Option<BuilderPermissions>,
    window_bypass: bool,
    default: BuilderPermissions,
    bounded: impl FnOnce() -> Option<String>,
) -> StartMode {
    if let Some(p) = card_choice.or(window_bypass.then_some(BuilderPermissions::NeverAsks)) {
        return StartMode::chosen(p);
    }
    if let Some(mode) = bounded() {
        return StartMode { permissions: None, bypass: false, permission_mode: Some(mode) };
    }
    StartMode::chosen(default)
}

/// D1 (brief point 3): the mode a Resume runs in. A session started with a
/// choice (`permissions`) resumes in that same choice, whatever has changed
/// since; one started before D1 (or the tour card's bounded start) keeps
/// today's rule: its `bypass`, and the guided mode while the guide's or
/// the tour's test holds ([`resumed_permission_mode`]).
pub fn resumed_mode(
    state: &crate::kanban::BuilderState,
    guide: Option<&crate::settings::FirstCardGuide>,
    tutorial: Option<&crate::settings::TutorialProgress>,
    workspace_id: &str,
    workspace_cwd: &str,
    card: &KanbanCard,
) -> StartMode {
    match state.permissions {
        Some(p) => StartMode::chosen(p),
        None => StartMode {
            permissions: None,
            bypass: state.bypass,
            permission_mode: resumed_permission_mode(state, guide, tutorial, workspace_id, workspace_cwd, card),
        },
    }
}

/// [`builder_args`] with the session's permission mode (UX P-C). Without
/// `bypass`, [`GUIDED_PERMISSION_MODE`] (the tour card's) and, D1, the three
/// choices' [`BuilderPermissions::mode_str`] are honoured:
///
/// | mode | Claude | Codex |
/// |---|---|---|
/// | `bypass` / `neverAsks` | `--dangerously-skip-permissions` | `--sandbox workspace-write -a never` |
/// | `acceptEdits` (tour) | `--permission-mode acceptEdits` | `--sandbox workspace-write -a on-request` |
/// | `editsCopy` | `--permission-mode acceptEdits` | `--sandbox workspace-write -a on-request` |
/// | `asks` | nothing (Claude's own default) | `--sandbox read-only -a on-request` |
/// | none (before D1) | nothing | `--sandbox workspace-write` |
///
/// Codex's pairs are its own presets (`/approvals`): Read Only "approval is
/// required to edit files", Default "can read and edit files in the
/// current workspace … approval is required to access the internet or edit
/// other files". Codex's unsandboxed bypass is never passed: on Windows its
/// own sandbox enforces the same pairs, and it refuses to run a command it
/// can't hold to them rather than run it unbounded.
#[allow(clippy::too_many_arguments)]
pub fn builder_args_in_mode(
    vendor: &str,
    bypass: bool,
    permission_mode: Option<&str>,
    resume: bool,
    codex_session: Option<&str>,
    prompt: Option<&str>,
    claude_theme: Option<&str>,
    model: &ModelChoice,
) -> Result<Vec<String>, String> {
    let never = bypass || permission_mode == Some(BuilderPermissions::NeverAsks.mode_str());
    let guided = !never && permission_mode == Some(GUIDED_PERMISSION_MODE);
    let edits_copy = !never && permission_mode == Some(BuilderPermissions::EditsCopy.mode_str());
    let asks = !never && permission_mode == Some(BuilderPermissions::Asks.mode_str());
    match vendor {
        "claude" => {
            let mut args: Vec<String> = Vec::new();
            if never {
                args.push("--dangerously-skip-permissions".into());
            } else if guided || edits_copy {
                args.push("--permission-mode".into());
                args.push(GUIDED_PERMISSION_MODE.into());
            }
            // #74: the Builder row's model. Blank passes nothing, so the
            // CLI keeps using whatever `~/.claude/settings.json` says.
            // 1.169.0 (A1): its effort the same way (`--effort`).
            args.extend(model.claude_flags());
            if resume {
                args.push("--continue".into());
            }
            if let Some(p) = prompt {
                args.push(p.to_string());
            }
            Ok(crate::claude_theme::apply(args, claude_theme))
        }
        "codex" => {
            // v1.110.3 (pilot finding 3): Codex 0.153 has no `--full-auto`.
            // `--sandbox workspace-write`, or read-only on "Asks before every
            // change" (below); "Build without asking" adds
            // `-a never` (no approval prompts, failures go back to the model)
            // and never the unsandboxed bypass. v1.154.1 round 2 (walk J1):
            // `resume --last` is NOT filtered by cwd — it reopened another
            // card's session — so resume names this card's own session.
            let mut args: Vec<String> = Vec::new();
            if resume {
                let id = codex_session
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| crate::codex_sessions::NOT_FOUND.to_string())?;
                args.push("resume".into());
                args.push(id.to_string());
            }
            // #74: after `resume`, never before it — `-m` and `-c` are
            // options of the subcommand that actually runs the session.
            if let Some(m) = model.model.as_deref() {
                args.push("-m".into());
                args.push(m.to_string());
            }
            if let Some(effort) = model.reasoning.as_deref() {
                args.push("-c".into());
                args.push(format!("model_reasoning_effort={effort}"));
            }
            args.push("--sandbox".into());
            // D1: "Asks before every change" (the `asks` choice) is Codex's
            // Read Only preset; with Claude the same choice passes nothing
            // ("Uses Claude's own setting", 1.175.0 F9).
            args.push(if asks { "read-only" } else { "workspace-write" }.into());
            if never {
                args.push("-a".into());
                args.push("never".into());
            } else if guided || edits_copy || asks {
                // D1 (Challenger 5): the tour card's mode is "Edits its copy
                // without asking", as its page shows, on Codex too.
                args.push("-a".into());
                args.push("on-request".into());
            }
            if let Some(p) = prompt {
                args.push(p.to_string());
            }
            Ok(args)
        }
        other => Err(format!("Builder vendor `{other}` is not supported.")),
    }
}

/// 1.169.1 (R3): what a Codex session in `dir` must also be able to write
/// so `git add` / `git commit` work there. A card's copy is a linked
/// worktree whose index, refs and objects live in the project's git common
/// dir, outside `--sandbox workspace-write`'s workspace: Codex asked "May I
/// let Git write its worktree metadata outside the sandbox", and under
/// "Build without asking" (`-a never`) the commit failed. Granting the
/// whole common dir doesn't help (measured with Codex 0.164: it keeps the
/// copy's own git dir read-only, "could not create index.lock") and would
/// open `main`, hooks and config. What works, each its own `--add-dir`:
/// the copy's own git dir (`<common>/worktrees/<id>`), `<common>/objects`,
/// and the card branch's directory under `<common>/refs/heads` and
/// `<common>/logs/refs/heads` (`plyloft/card-x` → `…/plyloft`).
///
/// Reach, accepted: the ref grant is the whole `plyloft/` (or legacy
/// `atelier/`) directory, so it covers every card's branch, not only this
/// card's; the objects grant lets Codex add (or prune) objects shared by
/// every branch. Never granted: `main` and other branches, `refs/stash`
/// (`git stash`, and pre-commit hooks that use it, fail), hooks, config.
///
/// Plyloft — unsandboxed — makes the two ref directories first: a fresh
/// card's reflog directory may not exist yet, and `git pack-refs --prune`
/// removes an emptied `refs/heads/plyloft`; Codex can't create either. A
/// directory that can't be made is left out and logged.
///
/// Empty when `dir` is the project's own checkout (its git dir is the
/// common dir). `Err` with the reason — no grant at all, the argv as it
/// was — when the copy isn't on a card branch, the repository uses
/// per-worktree config (`extensions.worktreeConfig`) or reftable refs, or
/// git can't say (an old git, or past 5 s).
pub(crate) fn codex_git_grants(dir: &Path) -> Result<Vec<String>, String> {
    let text = git_bounded(dir, &["rev-parse", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir"])?;
    let (git_dir, common) = parse_git_dirs(&text)?;
    let same = match (crate::platform::canonicalize(&git_dir), crate::platform::canonicalize(&common)) {
        (Ok(a), Ok(b)) => a == b,
        _ => git_dir == common,
    };
    if same {
        return Ok(Vec::new());
    }
    let branch = git_bounded(dir, &["symbolic-ref", "--short", "HEAD"]).map_err(|e| format!("no branch checked out ({e})"))?;
    // Older git has no `--show-ref-format`: those only know the files backend.
    if let Ok(format) = git_bounded(dir, &["rev-parse", "--show-ref-format"]) {
        if format.trim() == "reftable" {
            return Err("the repository keeps its refs in reftable".into());
        }
    }
    if git_bounded(dir, &["config", "--bool", "--get", "extensions.worktreeConfig"]).is_ok_and(|v| v.trim() == "true") {
        return Err("the repository uses per-worktree config (extensions.worktreeConfig)".into());
    }
    let grants = codex_git_grant_paths(&git_dir, &common, branch.trim())?;
    let mut kept = Vec::with_capacity(grants.len());
    for (i, grant) in grants.into_iter().enumerate() {
        // The first two exist in any linked worktree; the ref ones are made.
        if i >= 2 {
            if let Err(e) = std::fs::create_dir_all(&grant) {
                log::info!("builder: Codex in {}: no grant for {grant} ({e})", dir.display());
                continue;
            }
        }
        kept.push(codex_dir_arg(&grant, cfg!(windows)));
    }
    Ok(kept)
}

/// The two lines of `git rev-parse --absolute-git-dir --path-format=absolute
/// --git-common-dir`, both absolute. A git older than 2.31 echoes
/// `--path-format=absolute` back instead of understanding it: an `Err`.
fn parse_git_dirs(text: &str) -> Result<(String, String), String> {
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let (Some(git_dir), Some(common), None) = (lines.next(), lines.next(), lines.next()) else {
        return Err(format!("git rev-parse said {:?}", text.trim()));
    };
    if !Path::new(git_dir).is_absolute() || !Path::new(common).is_absolute() {
        return Err(format!("git rev-parse gave a relative path ({git_dir:?}, {common:?})"));
    }
    Ok((git_dir.to_string(), common.to_string()))
}

/// A git read in `dir`, bounded to 5 s like Plyloft's other git calls.
fn git_bounded(dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = crate::platform::git_command();
    cmd.args(args).current_dir(dir);
    let out = crate::worktrees::run_bounded_output(&mut cmd, std::time::Duration::from_secs(5))
        .map_err(|e| format!("git {}: {e:?}", args.join(" ")))?;
    if !out.status.success() {
        return Err(format!("git {} failed: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// [`codex_git_grants`]' folders from git's answers, in order: the copy's
/// git dir, the objects, the card branch's directory under `refs/heads`
/// and under `logs/refs/heads`. Only a card branch
/// ([`crate::worktrees::is_card_branch`]) gets any: another branch in a
/// linked worktree is the member's own, and nothing is granted.
fn codex_git_grant_paths(git_dir: &str, common: &str, branch: &str) -> Result<Vec<String>, String> {
    if !crate::worktrees::is_card_owned_branch(branch) {
        return Err(format!("branch `{branch}` isn't a card branch"));
    }
    let Some((prefix, _)) = branch.rsplit_once('/') else {
        return Err(format!("branch `{branch}` has no directory under refs/heads"));
    };
    if prefix.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return Err(format!("branch `{branch}` has an odd directory under refs/heads"));
    }
    let common = common.trim_end_matches(['/', '\\']);
    Ok(vec![
        git_dir.to_string(),
        format!("{common}/objects"),
        format!("{common}/refs/heads/{prefix}"),
        format!("{common}/logs/refs/heads/{prefix}"),
    ])
}

/// 1.169.1 (R3, Challenger): what a Codex Builder in a card's copy is told
/// about git's one harmless error there (it can't lock `packed-refs`,
/// which stays read-only), so it doesn't read a good commit as failed.
pub const CODEX_PACKED_REFS_RULE: &str = "- git may print 'Unable to create …packed-refs.lock'; \
that's expected — the commit succeeded if `git log -1` shows it.";

/// The Builder's preamble with [`CODEX_PACKED_REFS_RULE`] for a Codex
/// session; Claude's is returned as it is.
pub fn with_codex_rules(preamble: String, vendor: &str) -> String {
    if vendor != "codex" {
        return preamble;
    }
    match preamble.rfind("\n\nTask:\n") {
        Some(at) => format!("{}\n{}{}", &preamble[..at], CODEX_PACKED_REFS_RULE, &preamble[at..]),
        None => format!("{preamble}{CODEX_PACKED_REFS_RULE}\n"),
    }
}

/// A directory as Codex's `--add-dir` takes it: Git for Windows answers
/// `C:/Users/…/.git`, written here with the platform's own separators and
/// never with the `\\?\` verbatim prefix. A string helper, so both
/// platforms' tests read Windows' shape.
fn codex_dir_arg(raw: &str, windows: bool) -> String {
    let raw = raw.trim();
    if windows {
        crate::platform::without_verbatim(&raw.replace('/', "\\")).into_owned()
    } else {
        raw.to_string()
    }
}

/// 1.169.1 (R3): one `--add-dir <dir>` per folder, right after the
/// sandbox's `--sandbox workspace-write` pair — after `resume <id>` (an
/// option of the subcommand that runs the session, as #74's `-m`/`-c`),
/// before the prompt. An argv without that pair (no sandbox) is returned
/// as it is; blank folders are skipped.
pub(crate) fn with_codex_add_dirs(mut args: Vec<String>, dirs: &[String]) -> Vec<String> {
    let Some(at) = args.windows(2).position(|w| w[0] == "--sandbox" && w[1] == "workspace-write") else {
        return args;
    };
    let flags: Vec<String> = dirs
        .iter()
        .filter(|d| !d.trim().is_empty())
        .flat_map(|d| ["--add-dir".to_string(), d.clone()])
        .collect();
    args.splice(at + 2..at + 2, flags);
    args
}

/// [`with_codex_add_dirs`] with [`codex_git_grants`] of `dir`, the folder
/// the Codex session runs in. Unresolved: the argv as it was, and why, logged.
pub(crate) fn codex_args_in(args: Vec<String>, dir: &Path, who: &str) -> Vec<String> {
    match codex_git_grants(dir) {
        Ok(grants) => with_codex_add_dirs(args, &grants),
        Err(why) => {
            log::info!("{who}: Codex in {} gets no --add-dir for git ({why})", dir.display());
            args
        }
    }
}

/// UX P-F: a Claude Builder's argv names its own session, so its transcript
/// is found by that id (a Challenger's session in the same folder is
/// another file) and Resume continues exactly it: `--session-id <id>` on a
/// new session, `--resume <id>` in place of `--continue` on a resume (which
/// keeps the id: Claude reuses it unless `--fork-session` is passed). No id
/// (Codex, or a card started before P-F) leaves the argv as it was. Put in
/// front, after `claude_theme::apply` (which reads `--session-id` as a
/// headless session and would skip the theme).
pub fn with_claude_session(mut args: Vec<String>, vendor: &str, resume: bool, session_id: Option<&str>) -> Vec<String> {
    let Some(id) = session_id.map(str::trim).filter(|id| !id.is_empty() && vendor == "claude") else {
        return args;
    };
    let flag = if resume {
        args.retain(|a| a != "--continue");
        "--resume"
    } else {
        crate::claude_session::SESSION_ID_FLAG
    };
    let mut out = vec![flag.to_string(), id.to_string()];
    out.append(&mut args);
    out
}

/// UX P-F: the id a new Claude Builder session starts with; none for Codex.
pub fn new_claude_session_id(vendor: &str) -> Option<String> {
    (vendor == "claude").then(|| uuid::Uuid::new_v4().to_string())
}

fn git_head_sha(worktree: &Path) -> Result<String, String> {
    let out = crate::platform::git_command()
        .args(["rev-parse", "HEAD"])
        .current_dir(worktree)
        .output()
        .map_err(|e| format!("git rev-parse: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git rev-parse failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn spawn_session(
    app: AppHandle,
    registry: &BuilderRegistry,
    pty_registry: &PtyRegistry,
    workspace_id: &str,
    workspace_cwd: &str,
    card: &KanbanCard,
    vendor: &str,
    args: Vec<String>,
    claude_session_id: Option<String>,
) -> Result<String, String> {
    let worktree = card
        .worktree_path
        .clone()
        .ok_or_else(|| "This card has no copy of the repository yet.".to_string())?;
    spawn_session_at(
        app,
        registry,
        pty_registry,
        workspace_id,
        workspace_cwd,
        &card.id,
        &card.id,
        &worktree,
        vendor,
        args,
        claude_session_id,
    )
}

/// The one Builder spawn: the vendor CLI in a PTY in `worktree`, with the
/// cached PATH and the Knowledge MCP, registered under `session_key` — the
/// card id, or (SL-6) a lane key of a card built by both, whose `card_id`
/// the spawn intent names.
#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_session_at(
    app: AppHandle,
    registry: &BuilderRegistry,
    pty_registry: &PtyRegistry,
    workspace_id: &str,
    workspace_cwd: &str,
    session_key: &str,
    card_id: &str,
    worktree: &str,
    vendor: &str,
    args: Vec<String>,
    claude_session_id: Option<String>,
) -> Result<String, String> {
    let worktree = worktree.to_string();
    if !Path::new(&worktree).exists() {
        return Err(format!("The card's copy of the repository is gone ({worktree})."));
    }
    let missing_words = |v: &str| {
        vendor_missing_refusal(&shell_env::get(), v, false)
            .unwrap_or_else(|| format!("Plyloft can't find the {v} command in its program folders."))
    };
    let (binary, mcp_provider, coord_provider) = match vendor {
        "claude" => (
            shell_env::get()
                .claude_path
                .clone()
                .ok_or_else(|| missing_words("claude"))?,
            crate::mcp_launch::Provider::Claude,
            crate::coordination::Provider::Claude,
        ),
        "codex" => (
            shell_env::get()
                .codex_path
                .clone()
                .ok_or_else(|| missing_words("codex"))?,
            crate::mcp_launch::Provider::Codex,
            crate::coordination::Provider::Codex,
        ),
        other => return Err(format!("unsupported Builder vendor `{other}`")),
    };
    // 1.169.1 (R3): Codex in a card's copy may write the project's git
    // common dir, so its commit needs no permission prompt.
    let args = if vendor == "codex" { codex_args_in(args, Path::new(&worktree), "builder") } else { args };
    let capture: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let last_activity_at: Arc<AtomicI64> = Arc::new(AtomicI64::new(now_millis()));
    let knowledge_mcp = crate::mcp_launch::KnowledgeMcpContext::new(
        &app,
        mcp_provider,
        workspace_id,
        workspace_cwd,
    )?;
    let pty_id = pty_registry
        .spawn_with_capture(
            app,
            &binary,
            args,
            Some(worktree.clone()),
            Some(knowledge_mcp),
            crate::coordination::SpawnIntent {
                provider: coord_provider,
                execution_kind: crate::coordination::ExecutionKind::ProviderTile,
                attendance: crate::coordination::Attendance::HumanAttended,
                write_intent: crate::coordination::WriteIntent::Unknown,
                enforcement: crate::coordination::Enforcement::Advisory,
                project: crate::coordination::SpawnProject::Project {
                    workspace_id: workspace_id.to_string(),
                    cwd: PathBuf::from(&worktree),
                },
                capability: None,
                card_id: Some(card_id.to_string()),
                swarm_id: None,
                role_id: Some("builder".into()),
                run_id: None,
                retention_class: crate::coordination::RetentionClass::Interactive,
                objective: None,
            },
            120,
            32,
            Some(capture.clone()),
            Some(last_activity_at.clone()),
        )
        .map_err(|e| format!("builder pty spawn failed: {e}"))?;
    registry.insert(BuilderSession {
        pty_id: pty_id.clone(),
        workspace_id: workspace_id.to_string(),
        card_id: session_key.to_string(),
        vendor: vendor.to_string(),
        capture,
        last_activity_at,
        claude_session_id,
        transcript: Arc::default(),
    });
    Ok(pty_id)
}

/// Challenger round on #378 (P2-1): what a new session (Start build again,
/// Start fresh) keeps of the card's review. The review of the last snapshot
/// is the snapshot's, not the session's: dropping it made an approved,
/// unchanged snapshot read "has no review" at Ship and Merge. A review of an
/// older snapshot says nothing about the last one and goes. A kept request
/// for changes is owed to the new session, which has not had it (GH #135);
/// an approval has nothing to say to it.
pub(crate) fn review_kept_for_new_session(
    previous: Option<&BuilderState>,
) -> (Option<BuilderReview>, Option<UndeliveredVerdict>) {
    let kept = previous.and_then(|b| {
        let last = b.snapshots.last()?;
        b.review.clone().filter(|r| r.snapshot_n == last.n)
    });
    let owed = kept
        .as_ref()
        .filter(|r| r.status == "done" && r.verdict.as_deref() == Some("changes_requested"))
        .map(|r| UndeliveredVerdict { snapshot_n: r.snapshot_n, at: r.at });
    (kept, owed)
}

/// Start the Builder for a card that is already In Progress with a
/// worktree (the caller advanced it through the shared claim/worktree
/// path). `prompt` is the composed brief.
#[allow(clippy::too_many_arguments)]
pub fn start(
    app: AppHandle,
    registry: &BuilderRegistry,
    pty_registry: &PtyRegistry,
    kanban: &KanbanStore,
    workspace_id: &str,
    workspace_cwd: &str,
    card: KanbanCard,
    vendor: &str,
    mode: StartMode,
    prompt: &str,
    retry: Option<crate::settings::ModelChoice>,
) -> Result<BuilderStartResult, String> {
    let bypass = mode.bypass;
    let permission_mode = mode.permission_mode.clone();
    if registry.get_pty(&card.id).is_some() {
        return Err("a Builder session is already running for this card".into());
    }
    if let Some(why) = shell_env::try_get().and_then(|env| vendor_missing_refusal(&env, vendor, false)) {
        return Err(why);
    }
    let full_prompt = format!("{}{}", with_codex_rules(builder_preamble_for(&crate::issue_text::name_for_ai(&card), card.pr_review.is_some()), vendor), prompt);
    let theme = if vendor == "claude" { crate::claude_theme::theme_for_spawn(&app) } else { None };
    // CL-8 round 2: a card that continues from a build of Build with both
    // keeps that build's chosen model (same vendor) on a Start fresh.
    // 1.168.1 (E2): otherwise the card's own choice, else the workspace's
    // and the app's rows.
    let chosen = chosen_model_for(card.builder.as_ref(), vendor);
    // 1.169.0 (A3): a "Retry on…" of this card's Builder round runs on its
    // own choice, this once; the card's models are left as they are.
    let retry = retry.map(|choice| crate::model_catalog::fit(vendor, choice));
    // The attempt it retries, for History — read before this start replaces it.
    let retried = retry.as_ref().and_then(|_| card.builder.as_ref()).map(|b| {
        (b.started_at, b.model.clone(), crate::retry_on::builder_outcome(b, card.last_run_status.as_ref()))
    });
    let model = match retry.clone() {
        Some(choice) => choice,
        None => builder_model(chosen.as_ref(), vendor, || {
            crate::settings::model_for_card(&app, workspace_id, card.models.as_ref(), vendor, AgentRole::Builder)
        }),
    };
    // UX P-F: a new Claude session is named, so its own transcript tells a
    // usage limit reached mid-turn.
    let claude_session_id = new_claude_session_id(vendor);
    let args = with_claude_session(
        builder_args_in_mode(
            vendor,
            bypass,
            mode.args_mode(),
            false,
            None,
            Some(&full_prompt),
            theme.as_deref(),
            &model,
        )?,
        vendor,
        false,
        claude_session_id.as_deref(),
    );
    let pty_id = spawn_session(
        app.clone(),
        registry,
        pty_registry,
        workspace_id,
        workspace_cwd,
        &card,
        vendor,
        args,
        claude_session_id.clone(),
    )?;
    let previous = card.builder.clone();
    let mut updated: Option<KanbanCard> = None;
    let (kept_review, owed_verdict) = review_kept_for_new_session(previous.as_ref());
    // Walk 2 of #386: a pull request card's new session had the request
    // for changes in its brief (`pr_review::builder_lead`); it isn't sent
    // to it a second time.
    let owed_verdict = if crate::pr_review::session_findings(&card).is_some() { None } else { owed_verdict };
    let started = now_millis();
    let written = kanban.with_card(workspace_id, &card.id, |c| {
        // Walk 3 of #386 (finding 9): each Fix with the Builder is its own
        // Activity entry.
        if let Some(p) = c.pr_review.as_mut() {
            crate::pr_review::record_fix_start(p, started);
        }
        let snapshots = previous.as_ref().map(|b| b.snapshots.clone()).unwrap_or_default();
        c.builder = Some(BuilderState {
            vendor: vendor.to_string(),
            bypass,
            model: model.label_for(vendor),
            pty_id: Some(pty_id.clone()),
            session_lost: false,
            resume_failed: false,
            started_at: started,
            snapshots,
            review: kept_review.clone(),
            last_reviewed_revision: previous
                .as_ref()
                .and_then(|b| b.last_reviewed_revision.clone()),
            shipped_unreviewed: None,
            first_review_done: previous.as_ref().is_some_and(|b| b.first_review_done),
            changes_requested_count: previous.as_ref().map_or(0, |b| b.changes_requested_count),
            // GH #104: a resumed session keeps the corrections the human
            // already typed — the friction is the card's, not the session's.
            user_corrections: previous.as_ref().map_or(0, |b| b.user_corrections),
            correction_texts: previous.as_ref().map(|b| b.correction_texts.clone()).unwrap_or_default(),
            review_decisions: previous.as_ref().map(|b| b.review_decisions.clone()).unwrap_or_default(),
            follow_up: previous.as_ref().and_then(|b| b.follow_up.clone()),
            self_check: previous.as_ref().and_then(|b| b.self_check.clone()),
            // GH #124: a review waiting on a running one still runs.
            waiting_review: previous.as_ref().and_then(|b| b.waiting_review.clone()),
            // GH #129: a new session has not received it either.
            handed_over: previous.as_ref().and_then(|b| b.handed_over.clone()),
            // GH #135: a fresh session has had no verdict. It is owed the
            // kept request for changes only (#378 P2-1); an approval has
            // nothing left to say to it. Resume keeps both as they were.
            undelivered_verdict: owed_verdict.clone(),
            // CL-5: the card's review rounds outlive its sessions.
            review_rounds: previous.as_ref().map(|b| b.review_rounds.clone()).unwrap_or_default(),
            chosen_model: chosen.clone(),
            claude_session_id: claude_session_id.clone(),
            // UX P-C: decided for this start alone (`guided_permission_mode`).
            permission_mode: permission_mode.clone(),
            // D1: the choice it started in, which Resume keeps.
            permissions: mode.permissions,
            lost_on_restart: false,
            // C2: a new session's Finish and check starts afresh.
            self_check_started_at: None,
            pr_draft: None,
        });
        c.last_run_status = Some(LastRunStatus::Running);
        // 1.169.0 (A3): the session started, so the retry is recorded.
        if let Some(choice) = retry.as_ref() {
            let (from_at, from_model, from_outcome) = retried.clone().unwrap_or_default();
            crate::retry_on::record(
                c,
                AgentRole::Builder,
                vendor,
                Some(from_at).filter(|at| *at > 0),
                from_model,
                Some(from_outcome).filter(|o| !o.is_empty()),
                choice,
                started,
            );
        }
        updated = Some(c.clone());
        Ok(())
    });
    // GH #116: as in `resume` — a session no card records is stopped,
    // not left running (Hard Rule #4).
    let card = match (written, updated) {
        (Ok(()), Some(card)) => card,
        (written, _) => {
            registry.end_session(pty_registry, &card.id);
            let why = written
                .err()
                .unwrap_or_else(|| "builder start did not capture card".to_string());
            return Err(format!(
                "the Builder session was started and stopped again: {why}"
            ));
        }
    };
    crate::kanban::emit_kanban_changed(&app, workspace_id);
    Ok(BuilderStartResult { pty_id, card })
}

/// v1.154.1 round 2 (walk J1): the Codex session a resume in `folder`
/// continues — the newest interactive one started there. `None` for Claude
/// (its `--continue` is per directory) and when Codex has none there.
/// `since` is the Builder's (or build's) start: a Codex run in that folder
/// before it is not its conversation.
pub(crate) fn codex_session_for(vendor: &str, folder: Option<&str>, since: Option<i64>) -> Option<String> {
    if vendor != "codex" {
        return None;
    }
    crate::codex_sessions::latest_for_folder(&crate::codex_sessions::sessions_root(), Path::new(folder?), since)
}

/// D13: new session in the same worktree, native resume. Keeps vendor,
/// bypass, the permission mode (D1: the session's own choice; UX P-C, the
/// guided mode while the guide's test holds: `resumed_mode`) and snapshots.
pub fn resume(
    app: AppHandle,
    registry: &BuilderRegistry,
    pty_registry: &PtyRegistry,
    kanban: &KanbanStore,
    workspace_id: &str,
    workspace_cwd: &str,
    card_id: &str,
    guide: Option<&crate::settings::FirstCardGuide>,
    tutorial: Option<&crate::settings::TutorialProgress>,
) -> Result<BuilderStartResult, String> {
    let card = kanban.get_card(workspace_id, card_id)?;
    let state = card
        .builder
        .clone()
        .ok_or_else(|| "this card has no Builder session to resume".to_string())?;
    // UX P-C (Challenger): the guided mode only while the guide's test holds.
    // D1: a session started in a choice resumes in that same choice.
    let mode = resumed_mode(&state, guide, tutorial, workspace_id, workspace_cwd, &card);
    let permission_mode = mode.permission_mode.clone();
    if registry.get_pty(card_id).is_some() {
        return Err("a Builder session is already running for this card".into());
    }
    if let Some(why) = shell_env::try_get().and_then(|env| vendor_missing_refusal(&env, &state.vendor, true)) {
        return Err(why);
    }
    let theme = if state.vendor == "claude" { crate::claude_theme::theme_for_spawn(&app) } else { None };
    // #74: the row is read again, so a model changed in Settings applies
    // to the new session in the same worktree — unless (CL-8 round 2) the
    // card continues from a build whose model was chosen at its start.
    // 1.168.1 (E2): the card's own choice comes before the rows.
    let model = builder_model(state.chosen_model.as_ref(), &state.vendor, || {
        crate::settings::model_for_card(&app, workspace_id, card.models.as_ref(), &state.vendor, AgentRole::Builder)
    });
    // v1.154.1 round 2 (walk J1): Codex resumes this card's own session,
    // found by its folder. None found: the card points at Start fresh
    // rather than reopening whatever session is newest on the Mac.
    let codex_session = codex_session_for(&state.vendor, card.worktree_path.as_deref(), Some(state.started_at));
    if state.vendor == "codex" && codex_session.is_none() {
        let _ = kanban.with_card(workspace_id, card_id, |c| {
            if let Some(b) = c.builder.as_mut() {
                b.resume_failed = true;
            }
            Ok(())
        });
        crate::kanban::emit_kanban_changed(&app, workspace_id);
        return Err(crate::codex_sessions::NOT_FOUND.to_string());
    }
    // UX P-C: the session's own permission mode (the guided card's) is kept
    // while the guide still names this unedited card.
    // UX P-F: a session started with an id resumes exactly it (`--resume`),
    // so its transcript stays the one the limit rule reads; one started
    // before P-F continues the folder's newest (`--continue`), as before.
    let args = with_claude_session(
        builder_args_in_mode(
            &state.vendor,
            mode.bypass,
            mode.args_mode(),
            true,
            codex_session.as_deref(),
            None,
            theme.as_deref(),
            &model,
        )?,
        &state.vendor,
        true,
        state.claude_session_id.as_deref(),
    );
    let pty_id = spawn_session(
        app.clone(),
        registry,
        pty_registry,
        workspace_id,
        workspace_cwd,
        &card,
        &state.vendor,
        args,
        state.claude_session_id.clone(),
    )?;
    let resumed_at = now_millis();
    registry.mark_resumed(card_id, &pty_id, resumed_at);
    let mut updated: Option<KanbanCard> = None;
    let written = kanban.with_card(workspace_id, card_id, |c| {
        // Walk 4 of #386: a resumed session on a pull request card is its
        // own "started fixing it" in the Activity, as a new one is.
        if let Some(p) = c.pr_review.as_mut() {
            crate::pr_review::record_fix_start(p, resumed_at);
        }
        if let Some(b) = c.builder.as_mut() {
            b.pty_id = Some(pty_id.clone());
            b.session_lost = false;
            b.resume_failed = false;
            b.lost_on_restart = false;
            // C2: a resumed session's Finish and check starts afresh.
            b.self_check_started_at = None;
            b.model = model.label_for(&state.vendor);
            // UX P-C (Challenger): the header says what this session runs in.
            b.permission_mode = permission_mode.clone();
        }
        // F11: a closed or ended session's run reads Aborted; resuming it
        // runs it again. A Success (a Build done) stays.
        if matches!(c.last_run_status, None | Some(LastRunStatus::Aborted)) {
            c.last_run_status = Some(LastRunStatus::Running);
        }
        updated = Some(c.clone());
        Ok(())
    });
    // GH #116: the session exists but no card records it — the card was
    // deleted, or the write failed. Nothing would ever stop it, so it is
    // stopped here (Hard Rule #4) rather than left running with no card.
    let card = match (written, updated) {
        (Ok(()), Some(card)) => card,
        (written, _) => {
            registry.end_session(pty_registry, card_id);
            let why = written
                .err()
                .unwrap_or_else(|| "builder resume did not capture card".to_string());
            return Err(format!(
                "the Builder session was started and stopped again: {why}"
            ));
        }
    };
    crate::kanban::emit_kanban_changed(&app, workspace_id);
    Ok(BuilderStartResult { pty_id, card })
}

/// D10: the Plan challenge block appended to the Builder's brief — the
/// synthesis the Builder's own vendor wrote, what both vendors agreed on,
/// and the human's decisions on the disagreement ledger. Pure.
pub fn plan_challenge_section(
    final_result: Option<&serde_json::Value>,
    ledger: &[crate::discussion::DisagreementEntry],
    challenge: &crate::kanban::PlanChallenge,
    // OB-14 (D5): both views came from one vendor, in two sessions.
    single_vendor: bool,
) -> String {
    let mut out = String::from("\n\n## Plan challenge (already decided — do not reopen)\n");
    if let Some(fr) = final_result {
        if let Some(answer) = fr.get("answer").and_then(|v| v.as_str()) {
            out.push_str("\nSynthesis:\n");
            out.push_str(answer.trim());
            out.push('\n');
        }
        if let Some(agreements) = fr.get("agreements").and_then(|v| v.as_array()) {
            let items: Vec<&str> = agreements.iter().filter_map(|a| a.as_str()).collect();
            if !items.is_empty() {
                out.push_str(if single_vendor { "\nBoth sessions agreed:\n" } else { "\nBoth vendors agreed:\n" });
                for a in items {
                    out.push_str(&format!("- {}\n", a.trim()));
                }
            }
        }
    }
    // v1.110.4 (pilot finding 4): a disagreement the synthesis resolved is
    // decided unless the human overrode it. Only entries with neither a
    // synthesis resolution nor a human decision are still open.
    let resolutions: Vec<(String, String, String)> = final_result
        .and_then(|fr| fr.get("disagreementResolutions"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    let id = r.get("disagreementId")?.as_str()?;
                    let disposition = r.get("disposition")?.as_str()?;
                    let rationale = r.get("rationale").and_then(|x| x.as_str()).unwrap_or("");
                    Some((id.to_string(), disposition.to_string(), rationale.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    let synthesis_for = |id: &str| -> Option<&(String, String, String)> {
        resolutions
            .iter()
            .find(|(rid, disp, _)| rid == id && disp != "unresolved")
    };
    if !challenge.decisions.is_empty() {
        out.push_str("\nDecisions by the human on the disagreements:\n");
        for d in &challenge.decisions {
            let statement = ledger
                .iter()
                .find(|e| e.id == d.disagreement_id)
                .map(|e| e.statement.as_str())
                .unwrap_or(d.statement.as_str());
            out.push_str(&format!("- {} → DECIDED: {}\n", statement.trim(), d.decision.trim()));
        }
    }
    let by_synthesis: Vec<&crate::discussion::DisagreementEntry> = ledger
        .iter()
        .filter(|e| {
            !challenge.decisions.iter().any(|d| d.disagreement_id == e.id)
                && synthesis_for(&e.id).is_some()
        })
        .collect();
    if !by_synthesis.is_empty() {
        out.push_str("\nResolved by the synthesis (the human let these stand — treat as decided):\n");
        for e in by_synthesis {
            let (_, disposition, rationale) = synthesis_for(&e.id).expect("filtered");
            out.push_str(&format!(
                "- {} → {}: {}\n",
                e.statement.trim(),
                disposition.trim(),
                rationale.trim()
            ));
        }
    }
    let undecided: Vec<&crate::discussion::DisagreementEntry> = ledger
        .iter()
        .filter(|e| {
            !challenge.decisions.iter().any(|d| d.disagreement_id == e.id)
                && synthesis_for(&e.id).is_none()
        })
        .collect();
    if !undecided.is_empty() {
        out.push_str("\nStill open (ask the human before acting on these):\n");
        for e in undecided {
            out.push_str(&format!("- {}\n", e.statement.trim()));
        }
    }
    out
}

/// Bounded reviewer markdown kept on the card for Outcome and injection.
/// GH #58: room for findings from more than one pass (requesting passes
/// come first in a merged review).
const REVIEW_EXCERPT_MAX: usize = 6000;

/// The Challenger is always the other vendor (D1).
pub fn challenger_for(builder_vendor: &str) -> &'static str {
    if builder_vendor == "codex" {
        "claude"
    } else {
        "codex"
    }
}

fn provider_of(vendor: &str) -> ply_collab::Provider {
    if vendor == "codex" {
        ply_collab::Provider::Codex
    } else {
        ply_collab::Provider::Claude
    }
}

/// OB-14 (§13.2): the vendor's CLI is on this machine at all — found on
/// Ply's PATH. Not whether it is eligible to review (that is
/// `ensure_reviewer`): a Codex that is installed but failed its probe is
/// E2's degraded case, a Codex that isn't installed is one-AI's normal case.
pub fn vendor_installed(env: &shell_env::ShellEnv, vendor: &str) -> bool {
    match vendor {
        "codex" => env.codex_path.is_some(),
        _ => env.claude_path.is_some(),
    }
}

/// Who reviews, and how the card should word it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChallengerChoice {
    pub provider: String,
    /// E2: the Builder's own vendor reviews.
    pub degraded: bool,
    /// OB-14: … because the other vendor isn't installed (implies `degraded`).
    pub single_vendor: bool,
}

/// D7 + E2 + OB-14, pure: the other vendor first; when it isn't installed,
/// the Builder's own vendor as a separate read-only session (single vendor,
/// the other is never probed); when it is installed but can't be made
/// eligible, the Builder's own vendor as E2's degraded fallback; neither →
/// the other vendor's error, and the review fails.
pub fn choose_challenger(
    builder_vendor: &str,
    other_installed: bool,
    ensure_other: impl FnOnce() -> Result<(), String>,
    ensure_own: impl FnOnce() -> Result<(), String>,
) -> Result<ChallengerChoice, String> {
    let other = challenger_for(builder_vendor);
    let own = || ChallengerChoice {
        provider: builder_vendor.to_string(),
        degraded: true,
        single_vendor: !other_installed,
    };
    if !other_installed {
        log::info!("builder: {other} isn't installed; the review is a separate {builder_vendor} session");
        return ensure_own().map(|()| own()).map_err(|e| {
            format!("{} isn't installed, and {}: {e}", vendor_display(other), vendor_display(builder_vendor))
        });
    }
    match ensure_other() {
        Ok(()) => Ok(ChallengerChoice { provider: other.to_string(), degraded: false, single_vendor: false }),
        Err(e) => {
            log::warn!("builder: challenger {other} unavailable ({e}); trying same-vendor review");
            ensure_own().map(|()| own()).map_err(|_| e)
        }
    }
}

/// 1.169.0 (A3): the vendor a review of `card` would run on now, decided
/// as `review_snapshot` decides it (eligibility checked) — what a retry's
/// choice must match. Blocking (it may probe a reviewer).
pub(crate) fn challenger_choice_now(app: &AppHandle, card: &KanbanCard) -> Result<String, String> {
    let builder_vendor = crate::pr_review::challenger_of(card)
        .map(|ch| challenger_for(ch).to_string())
        .or_else(|| card.builder.as_ref().map(|b| b.vendor.clone()))
        .unwrap_or_else(|| "claude".into());
    let other = challenger_for(&builder_vendor);
    choose_challenger(
        &builder_vendor,
        vendor_installed(&shell_env::get(), other),
        || ensure_reviewer(app, provider_of(other)),
        || ensure_reviewer(app, provider_of(&builder_vendor)),
    )
    .map(|c| c.provider)
}

/// "Claude" / "Codex".
pub fn vendor_display(vendor: &str) -> &'static str {
    if vendor == "codex" {
        "Codex"
    } else {
        "Claude"
    }
}

/// OB-14 (§13.2): why Start build (or Resume) can't open `vendor`'s session
/// on this machine, in the card's words — None when its CLI is there. Each
/// counts only when it also starts (`codex_healthy`, `claude_healthy`): a wrapper a
/// half-finished install left behind dies on every run.
pub fn vendor_missing_refusal(env: &shell_env::ShellEnv, vendor: &str, resume: bool) -> Option<String> {
    let (missing, broken) = match vendor {
        "codex" => (env.codex_path.is_none(), env.codex_path.is_some() && !env.codex_healthy()),
        // 1.176.0 R3: Claude by Codex's rule (`claude_healthy`: a slow
        // `--version` counts as starting), as `doctor::require` refuses it.
        _ => (env.claude_path.is_none(), env.claude_path.is_some() && !env.claude_healthy()),
    };
    if !missing && !broken {
        return None;
    }
    let name = vendor_display(vendor);
    let other = vendor_display(challenger_for(vendor));
    let what = if missing {
        format!("{name} isn't installed on {}.", crate::platform::THIS_MACHINE)
    } else {
        format!("{name} is installed on {} but doesn't start.", crate::platform::THIS_MACHINE)
    };
    // 1.176.0 R7: a CLI that doesn't start is repaired (Settings › Setup and
    // account › Diagnostics › Repair), not reinstalled by hand.
    let fix = if missing { format!("install {name}") } else { format!("repair {name}") };
    let sentence = if resume {
        format!("{what} This card's session was {name}'s, so it can't resume until you {fix}.")
    } else {
        format!("{what} Choose {other} for this card, or {fix}.")
    };
    // 1.176.0 R7: one that doesn't start is typed, so its surface offers
    // Repair (`cli_fresh::not_starting`, `src/lib/cliNotStarting.ts`).
    Some(match crate::cli_fresh::Cli::from_id(vendor) {
        Some(cli) if broken => crate::cli_fresh::not_starting(cli, &sentence),
        _ => sentence,
    })
}

/// Parse the reviewer's outcome: APPROVE, CHANGES_REQUESTED or (GH #58)
/// INCOMPLETE, from the text right after the "Verdict" heading first, so a
/// finding that merely mentions "approve" cannot flip the verdict; an
/// approval on a view the reviewer says was partial is `incomplete`.
/// `reviewer.rs` records the merged verdict of a multi-pass review; this is
/// the fallback for records that carry none.
pub fn parse_verdict(artifact: &str) -> Option<&'static str> {
    crate::review_passes::classify(artifact).map(|verdict| verdict.as_str())
}

/// GH #58: the review of the current snapshot can be run again — it is
/// incomplete, gave no verdict, or failed.
pub fn review_can_run_again(review: &BuilderReview) -> bool {
    review.status == "failed"
        || (review.status == "done"
            && matches!(review.verdict.as_deref(), None | Some("incomplete")))
        // GH #99 (review 9): an override accepted the findings, but a pass
        // that failed never read its files — those can still be reviewed.
        || (review.status == "skipped"
            && review.note.is_some()
            && review.failed_passes.unwrap_or(0) > 0)
}

/// E4: the PR comment carrying the Challenger's verdict.
///
/// 1.175.0 (X2, owner 2026-11-09): this is the text that goes on GitHub, so
/// what the Reviewer wrote — its notes, and the finding titles and reading
/// that quote it — passes `publish_filter::for_github` here, and only here:
/// what has the shape of a secret is replaced, a path under the member's
/// home folder loses the name (`project`: the card's copy, shown relative),
/// and a line under the notes says how many things were removed. The card's
/// own notes, what the Builder is given of the review, and the verdict are
/// not touched.
pub fn verdict_comment_body(review: &BuilderReview, project: &[&std::path::Path]) -> String {
    let mut removed = 0;
    let mut publish = |text: &str| {
        let published = crate::publish_filter::for_github_here(text, project);
        removed += published.removed;
        published.text
    };
    let who = match review.provider.as_str() {
        "codex" => "Codex",
        _ => "Claude",
    };
    let label = match review.verdict.as_deref() {
        Some("approve") => "APPROVE".to_string(),
        Some("changes_requested") => "CHANGES_REQUESTED".to_string(),
        Some("incomplete") => match review.incomplete_reason.as_deref() {
            Some(reason) => format!("INCOMPLETE ({reason})"),
            None => "INCOMPLETE".to_string(),
        },
        _ => "no verdict parsed".to_string(),
    };
    // OB-14 (§13.2): a one-AI setup is not a fault — say what it was.
    let degraded = if review.single_vendor {
        " (a separate, read-only session reviewed its own vendor's build)"
    } else if review.degraded {
        " (same-vendor review: the other vendor was unavailable)"
    } else {
        ""
    };
    let mut out = format!(
        "## Plyloft Reviewer — {who}{degraded}\n\n**Verdict:** {label} on build snapshot {}\n",
        review.snapshot_n
    );
    // Findings filter (and ADR 0006): a verdict that is Plyloft's reading
    // of the review (the workspace's threshold, a dismissal, an open
    // finding) says so, above the reviewer's own notes.
    if let Some(note) = review.ledger_note.as_deref().filter(|note| !note.trim().is_empty()) {
        out.push_str(&format!("\n**Plyloft's reading:** {}\n", publish(note.trim())));
    }
    if let Some(line) = dismissal_lines_of(review) {
        out.push_str(&format!("\n{}\n", publish(&line)));
    }
    if let (Some(files), Some(passes)) = (review.file_count, review.pass_count) {
        out.push_str(&format!(
            "\n{}\n",
            crate::review_passes::coverage_line_with(
                files as usize,
                passes as usize,
                review.synthesis_pass,
                review.model.as_deref(),
            )
        ));
    }
    if let Some(e) = &review.excerpt {
        out.push_str("\n<details><summary>Reviewer notes</summary>\n\n");
        // Round 2: what the notes left open — a code fence cut by the
        // excerpt's limit, or one whose end went with an unclosed key block —
        // is closed, or `</details>` and the count line below would be read
        // as code.
        out.push_str(&crate::pr_draft::close_open_blocks(&publish(e)));
        out.push_str("\n\n</details>\n");
    }
    if let Some(line) = crate::publish_filter::removed_line(removed, crate::publish_filter::Posted::Notes) {
        out.push_str(&format!("\n{line}\n"));
    }
    out
}

fn excerpt_of(artifact: &str) -> String {
    let mut out: String = artifact.chars().take(REVIEW_EXCERPT_MAX).collect();
    if artifact.chars().count() > REVIEW_EXCERPT_MAX {
        out.push_str("\n…");
    }
    out
}

fn set_review(
    app: &AppHandle,
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    review: BuilderReview,
    review_status: Option<Option<ReviewStatus>>,
) {
    let _ = kanban.with_card(workspace_id, card_id, |c| {
        record_settled_review(c, review.clone(), review_status.clone());
        Ok(())
    });
    crate::kanban::emit_kanban_changed(app, workspace_id);
}

/// `set_review` without the store and the event. GH #99: a completed
/// review moves `last_reviewed_revision` to the revision it read; a failed
/// one leaves it, so the commits nobody reviewed stay countable.
fn record_settled_review(
    c: &mut KanbanCard,
    review: BuilderReview,
    review_status: Option<Option<ReviewStatus>>,
) {
    let pr_card = c.pr_review.is_some();
    if let Some(b) = c.builder.as_mut() {
        // ADR 0006: the card had its first review once one judged the change.
        if review.status == "done"
            && matches!(review.verdict.as_deref(), Some("approve" | "changes_requested"))
        {
            b.first_review_done = true;
        }
        // ADR 0006: the refusals `Ship with follow-up` counts. A review
        // settles once; a re-run of the same snapshot is another verdict.
        if review.status == "done" && review.verdict.as_deref() == Some("changes_requested") {
            b.changes_requested_count += 1;
        }
        // A pass that failed left files unreviewed: not a completed review.
        if review.status == "done" && review.failed_passes.unwrap_or(0) == 0 {
            if let Some(revision) = review.reviewed_revision.clone() {
                b.last_reviewed_revision = Some(revision);
            }
        }
        settle_handed_over(b, &review);
        // GH #135: the Builder is owed this verdict until it receives it.
        // Walk 3 of #386 (finding 5): on a pull request card an approval with
        // no Builder session open asks nothing of a Builder (the fix is
        // pushed or ready to push): it is owed to none.
        let nothing_to_say = pr_card && b.pty_id.is_none() && review.verdict.as_deref() == Some("approve");
        b.undelivered_verdict = if nothing_to_say { None } else { verdict_owed(&review) };
        // CL-5: a review the ledger folded is one round on the card, once.
        b.remember_round(&review);
        b.review = Some(review);
    }
    // 1.169.0 (A3): a Challenger retry's review has settled.
    crate::retry_on::settle_review_retry(c);
    if let Some(rs) = review_status {
        // v1.154.1 (F11): an approval clears the review's own word, never
        // the card's open pull request (`review_status = Merged`).
        c.review_status = rs.or_else(|| crate::pr_status::cleared_review_status(c));
    }
}

/// GH #129: a review that judged the change carries the findings a
/// hand-over left unsent — its verdict is sent — so nothing is owed any
/// more. One that did not (failed, incomplete, no verdict) leaves them
/// owed, as the ledger it read now has them.
fn settle_handed_over(b: &mut BuilderState, review: &BuilderReview) {
    if b.handed_over.is_none() {
        return;
    }
    if review.status == "done"
        && matches!(review.verdict.as_deref(), Some("approve" | "changes_requested"))
    {
        b.handed_over = None;
        return;
    }
    if review.ledger.is_empty() {
        return;
    }
    let snapshot_n = b.handed_over.as_ref().map_or(0, |h| h.snapshot_n);
    let at = b.handed_over.as_ref().map_or(0, |h| h.at);
    b.handed_over = handed_over_from_ledger(&review.ledger, snapshot_n, at);
}

/// GH #135: the settled review whose verdict the Builder must still
/// receive — every review that has something to say, which is every one
/// `challengerReview.ts::reviewSettledMessage` writes a message for. A
/// skipped review says nothing, so it owes nothing.
fn verdict_owed(review: &BuilderReview) -> Option<UndeliveredVerdict> {
    if review.status != "done" && review.status != "failed" {
        return None;
    }
    Some(UndeliveredVerdict {
        snapshot_n: review.snapshot_n,
        at: review.at,
    })
}

/// GH #135: a new review replaces the settled one — its own verdict is
/// what the Builder will hear, and a request for changes it supersedes
/// travels on as `handed_over`. Nothing older is sent.
fn set_running_review(b: &mut BuilderState, review: BuilderReview) {
    b.undelivered_verdict = None;
    b.review = Some(review);
}

/// GH #135: the Builder received the verdict of the review that settled at
/// `at` on snapshot `snapshot_n`. A stale delivery — another review has
/// settled since — clears nothing. Idempotent: owing nothing is not an
/// error, so a second press or a reopened card cannot fail here.
pub fn mark_verdict_delivered(
    app: &AppHandle,
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    snapshot_n: u32,
    at: i64,
) -> Result<(), String> {
    let mut cleared = false;
    // All or nothing (GH #124's `with_card_saved`): the cache must never
    // say the Builder has the verdict while the board on disk still owes
    // it — a restart would then never send it.
    kanban.with_card_saved(workspace_id, card_id, |c| {
        cleared = clear_delivered_verdict(c, snapshot_n, at);
        Ok(())
    })?;
    if cleared {
        crate::kanban::emit_kanban_changed(app, workspace_id);
    }
    Ok(())
}

/// `mark_verdict_delivered` on one card. True when it owed exactly this
/// verdict and owes it no longer.
fn clear_delivered_verdict(c: &mut KanbanCard, snapshot_n: u32, at: i64) -> bool {
    let Some(b) = c.builder.as_mut() else {
        return false;
    };
    if !b
        .undelivered_verdict
        .as_ref()
        .is_some_and(|v| v.snapshot_n == snapshot_n && v.at == at)
    {
        return false;
    }
    b.undelivered_verdict = None;
    true
}

/// GH #129: the request for changes `settled` makes, as the hand-over
/// keeps it: the ledger's open blocking findings, or — for a review that
/// kept no ledger — its own hand-off. None when it asks for nothing.
fn handed_over_request(settled: &BuilderReview, at: i64) -> Option<HandedOverRequest> {
    if settled.status != "done" || settled.verdict.as_deref() != Some("changes_requested") {
        return None;
    }
    if !settled.ledger.is_empty() {
        return handed_over_from_ledger(&settled.ledger, settled.snapshot_n, at);
    }
    let handoff = settled
        .builder_handoff
        .clone()
        .or_else(|| settled.excerpt.clone())
        .unwrap_or_default();
    let finding_ids: Vec<String> = settled.findings.iter().filter_map(|f| f.id.clone()).collect();
    if handoff.trim().is_empty() && finding_ids.is_empty() {
        return None;
    }
    Some(HandedOverRequest {
        snapshot_n: settled.snapshot_n,
        finding_ids,
        handoff,
        at,
    })
}

/// The ledger's open blocking findings as a follow-up quotes them. None
/// when none is open.
fn handed_over_from_ledger(
    ledger: &[crate::review_ledger::LedgerFinding],
    snapshot_n: u32,
    at: i64,
) -> Option<HandedOverRequest> {
    let ledger = crate::review_ledger::CardLedger {
        findings: ledger.to_vec(),
        ..Default::default()
    };
    let open = ledger.open_blocking();
    if open.is_empty() {
        return None;
    }
    Some(HandedOverRequest {
        snapshot_n,
        finding_ids: open.iter().map(|f| f.id.clone()).collect(),
        handoff: crate::review_ledger::open_block(&ledger),
        at,
    })
}

/// GH #99: the card hears about the one automatic retry of its running
/// review of `snapshot_n` — "Challenger unavailable — trying again in
/// 30 s" while it waits, then reviewing again. A review that is no longer
/// that snapshot's running one (a newer Build done replaced it) is left
/// alone.
fn apply_retry_event(
    c: &mut KanbanCard,
    snapshot_n: u32,
    event: &crate::reviewer::RetryEvent,
    now: i64,
) -> bool {
    let Some(review) = c.builder.as_mut().and_then(|b| b.review.as_mut()) else {
        return false;
    };
    if review.snapshot_n != snapshot_n || review.status != "running" {
        return false;
    }
    match event {
        crate::reviewer::RetryEvent::Waiting {
            reason,
            error,
            delay_secs,
        } => {
            review.retry_at = Some(now + (*delay_secs as i64) * 1000);
            review.failure_reason = Some(reason.clone());
            review.error = Some(error.clone());
        }
        crate::reviewer::RetryEvent::Retrying => {
            review.retry_at = None;
            review.retried = true;
            review.failure_reason = None;
            review.error = None;
        }
        crate::reviewer::RetryEvent::FellBack { reason } => {
            review.kind = crate::review_passes::ReviewKind::Sweep;
            review.follow_up_fallback = Some(reason.clone());
        }
    }
    true
}

/// GH #99: commits in `from..to` in the card's worktree, or None when
/// either end is unknown or git cannot say.
fn commits_between(worktree: Option<&str>, from: Option<&str>, to: Option<&str>) -> Option<u32> {
    let (worktree, from, to) = (worktree?, from?, to?);
    if from == to {
        return Some(0);
    }
    crate::git::capture(Path::new(worktree), &["rev-list", "--count", &format!("{from}..{to}")])
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// GH #99: a failed review of the card's latest commit, with its reason in
/// words and the commits since the last completed review.
fn failed_review(
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    mut review: BuilderReview,
) -> BuilderReview {
    review.status = "failed".into();
    unreviewed_facts(kanban, workspace_id, card_id, review)
}

/// GH #99: the reason in words and the commit count for a review that left
/// the commit (or some passes of it) unreviewed.
fn unreviewed_facts(
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    mut review: BuilderReview,
) -> BuilderReview {
    review.retry_at = None;
    if review.failure_reason.is_none() {
        review.failure_reason = Some(
            crate::review_failure::classify(review.error.as_deref().unwrap_or(""), None, false, false)
                .reason()
                .to_string(),
        );
    }
    if let Ok(card) = kanban.get_card(workspace_id, card_id) {
        if let Some(b) = card.builder.as_ref() {
            let target = review.reviewed_revision.clone().or_else(|| {
                b.snapshots
                    .iter()
                    .rev()
                    .find(|s| s.n == review.snapshot_n)
                    .map(|s| s.sha.clone())
            });
            review.commits_since_review = commits_between(
                card.worktree_path.as_deref(),
                b.last_reviewed_revision.as_deref(),
                target.as_deref(),
            );
        }
    }
    review
}

/// Make `provider` eligible as a reviewer: reuse the current proof, wait
/// (bounded) for a probe already in flight, or run the behavioural probe
/// once (Phase 4 rule: capability is proved per exact executable + version,
/// never assumed).
pub(crate) fn ensure_reviewer(app: &AppHandle, provider: ply_collab::Provider) -> Result<(), String> {
    let env = shell_env::get();
    let caps = app.state::<crate::review_capabilities::ReviewerCapabilityRegistry>();
    let pty = app.state::<PtyRegistry>();
    crate::review_capabilities::ensure_current(
        &caps,
        &pty,
        provider,
        &env,
        crate::review_capabilities::REVIEW_PROBE_WAIT,
    )
    .map(|_| ())
}

/// A Challenger review as it settles on the card: the review and the card
/// `review_status` change it implies.
type SettledReview = (BuilderReview, Option<Option<ReviewStatus>>);

/// GH #124: start the Challenger on `job` in its own thread. The card must
/// already be reviewing in the slots (`ReviewSlots::admit`); the thread
/// releases it when the review ends, and runs the review that waited for
/// it, if any.
fn spawn_challenger(app: AppHandle, workspace_id: &str, card_id: &str, job: ChallengerJob) -> Result<(), String> {
    let ws = workspace_id.to_string();
    let cid = card_id.to_string();
    let thread_app = app.clone();
    let (snapshot_n, vendor, kind) = (job.snapshot_n, job.builder_vendor.clone(), job.kind);
    std::thread::Builder::new()
        .name(format!("challenger-{cid}"))
        .spawn(move || challenger_loop(thread_app, ws, cid, job))
        .map(|_| ())
        .map_err(|e| {
            let error = format!("could not start the Reviewer thread: {e}");
            // The card says the review failed, so Review again is offered,
            // and is free; a waiting review stays waiting.
            let kanban = app.state::<KanbanStore>();
            let review = failed_review(
                &kanban,
                workspace_id,
                card_id,
                BuilderReview {
                    snapshot_n,
                    provider: challenger_for(&vendor).to_string(),
                    error: Some(error.clone()),
                    at: now_millis(),
                    kind,
                    ..Default::default()
                },
            );
            app.state::<crate::reviewer::ReviewerRegistry>()
                .slots()
                .release(workspace_id, card_id, || {
                    let _ = kanban.with_card(workspace_id, card_id, |c| {
                        record_settled_review(c, review, None);
                        Ok(())
                    });
                    None::<ChallengerJob>
                });
            crate::kanban::emit_kanban_changed(&app, workspace_id);
            error
        })
}

/// GH #124: review `job`, then — in the same card write that settles it —
/// the snapshot that waited for it, until none waits.
fn challenger_loop(app: AppHandle, workspace_id: String, card_id: String, mut job: ChallengerJob) {
    loop {
        let settled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            review_snapshot(&app, &workspace_id, &card_id, &job)
        }))
        .unwrap_or_else(|_| {
            log::error!("builder: the Reviewer's review of {card_id} panicked");
            let kanban = app.state::<KanbanStore>();
            let review = failed_review(
                &kanban,
                &workspace_id,
                &card_id,
                BuilderReview {
                    snapshot_n: job.snapshot_n,
                    provider: challenger_for(&job.builder_vendor).to_string(),
                    error: Some("The review stopped unexpectedly".into()),
                    at: now_millis(),
                    kind: job.kind,
                    ..Default::default()
                },
            );
            (review, None)
        });
        match settle_and_take_next(&app, &workspace_id, &card_id, settled) {
            Some(next) => job = next,
            None => {
                // GH #104: the last review has settled and none waits, so this
                // is "Build done, after the last review". The Challenger gets
                // one more short read-only pass — and only if the card met
                // friction and is settled (GH #104 walk, A2: a request for
                // changes still waiting on the human runs nothing here; the
                // human's decision runs it, `proposals::after_human_decision`),
                // which `proposals` decides and nothing here does.
                //
                // It runs on this thread, which has nothing left to do, so it
                // holds up no card, no board and no Ship; every failure inside
                // is dropped in silence.
                crate::proposals::after_last_review(&app, &workspace_id, &card_id);
                return;
            }
        }
    }
}

/// GH #124: settle the ended review on the card and, under the slots'
/// lock, start the waiting one there — or free the card. One card write,
/// so the card is never shown idle between the two.
fn settle_and_take_next(
    app: &AppHandle,
    workspace_id: &str,
    card_id: &str,
    (review, review_status): SettledReview,
) -> Option<ChallengerJob> {
    let registry = app.state::<crate::reviewer::ReviewerRegistry>();
    let kanban = app.state::<KanbanStore>();
    let next = settle_in_slots(
        registry.slots(),
        &kanban,
        workspace_id,
        card_id,
        || registry.list_for_card(workspace_id, card_id),
        (review, review_status),
        now_millis(),
    );
    crate::kanban::emit_kanban_changed(app, workspace_id);
    // G1–G3 Challenger (3): a review that approved the commit on the card's
    // pull request turns on the auto-merge a press wanted.
    crate::pr_merge::kick_resume_held(app, workspace_id, card_id);
    next
}

/// `settle_and_take_next` without the AppHandle: `records` reads the
/// card's reviewer records under the slots' lock.
fn settle_in_slots(
    slots: &crate::reviewer::ReviewSlots,
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    records: impl FnOnce() -> Vec<crate::reviewer::ReviewerRecord>,
    (review, review_status): SettledReview,
    now: i64,
) -> Option<ChallengerJob> {
    slots.release(workspace_id, card_id, || {
        let records = records();
        let mut next = None;
        // One write: the ended review settles and the waiting one takes
        // the card. When it cannot be saved, nothing of it stays, not even
        // in the cache: no review starts, and the settle is written alone.
        let saved = kanban.with_card_saved(workspace_id, card_id, |c| {
            record_settled_review(c, review.clone(), review_status.clone());
            next = start_waiting(c, &records, now);
            Ok(())
        });
        if let Err(e) = saved {
            log::error!("builder: could not save the hand-over of {card_id}'s review: {e}");
            next = None;
            // The request stays waiting (`Build done starts its review`).
            if let Err(e) = kanban.with_card(workspace_id, card_id, |c| {
                record_settled_review(c, review, review_status);
                Ok(())
            }) {
                log::error!("builder: could not save the settled review of {card_id}: {e}");
            }
        }
        next
    })
}

/// GH #124: the waiting review becomes the card's running one — a
/// follow-up of the review it waited for when that one judged the change
/// (`review_context::kind_for_card`, with the card just settled), else as
/// #110's fallback rules decide. None when nothing waits, or its snapshot
/// is gone. Like Build done, the new snapshot supersedes an earlier
/// changes-requested verdict.
fn start_waiting(
    c: &mut KanbanCard,
    records: &[crate::reviewer::ReviewerRecord],
    now: i64,
) -> Option<ChallengerJob> {
    let kind = crate::review_context::kind_for_card(records, Some(c));
    start_waiting_as(c, kind, now)
}

/// `start_waiting` with the kind already read.
fn start_waiting_as(
    c: &mut KanbanCard,
    kind: crate::review_passes::ReviewKind,
    now: i64,
) -> Option<ChallengerJob> {
    let b = c.builder.as_mut()?;
    let waiting = b.waiting_review.take()?;
    let revision = b.snapshots.iter().rev().find(|s| s.n == waiting.snapshot_n)?.sha.clone();
    // GH #129: a request for changes this replaces is never sent — the
    // follow-up's verdict carries it. Kept until one does.
    if let Some(request) = b.review.as_ref().and_then(|r| handed_over_request(r, now)) {
        b.handed_over = Some(request);
    }
    set_running_review(b, running_review(waiting.snapshot_n, &b.vendor, kind, now));
    let job = ChallengerJob {
        snapshot_n: waiting.snapshot_n,
        builder_vendor: b.vendor.clone(),
        pass_budget: crate::review_passes::PASS_DIFF_BUDGET,
        kind,
        revision: Some(revision),
        retry: None,
    };
    if matches!(c.review_status, Some(ReviewStatus::ChangesRequested)) {
        c.review_status = crate::pr_status::cleared_review_status(c);
    }
    Some(job)
}

/// The card's review of `snapshot_n` as it starts.
fn running_review(
    snapshot_n: u32,
    builder_vendor: &str,
    kind: crate::review_passes::ReviewKind,
    at: i64,
) -> BuilderReview {
    BuilderReview {
        snapshot_n,
        provider: challenger_for(builder_vendor).to_string(),
        status: "running".into(),
        at,
        kind,
        ..Default::default()
    }
}

/// GH #124: the review a card asks for at launch: its waiting one, else
/// the snapshot of a review the card still shows running — the quit
/// interrupted it (a hand-over that landed while Ply quit, or any review
/// under way), and no review survives a restart. None otherwise.
fn restart_request(card: &KanbanCard) -> Option<u32> {
    // Owner-side review of #128: a card that is archived or already shipped
    // has nothing left for a review to act on.
    if card.archived || card.ship_status == crate::kanban::ShipStatus::Shipped {
        return None;
    }
    let b = card.builder.as_ref()?;
    b.waiting_review.as_ref().map(|w| w.snapshot_n).or_else(|| {
        b.review
            .as_ref()
            .filter(|r| r.status == "running")
            .map(|r| r.snapshot_n)
    })
}

/// At launch: the card's waiting review, or the one the quit interrupted,
/// becomes its running review.
fn resume_at_launch(
    c: &mut KanbanCard,
    records: &[crate::reviewer::ReviewerRecord],
    now: i64,
) -> Option<ChallengerJob> {
    let n = restart_request(c)?;
    let b = c.builder.as_mut()?;
    if b.waiting_review.is_none() {
        b.waiting_review = Some(WaitingReview { snapshot_n: n, requested_at: now });
    }
    start_waiting(c, records, now)
}

/// GH #124: after a restart no review runs, so every card's waiting review
/// — or the review the quit interrupted — starts now: as today, a sweep or
/// a follow-up by the card's ledger (an interrupted review counts for
/// nothing).
pub fn start_waiting_reviews(app: &AppHandle) {
    let registry = app.state::<crate::reviewer::ReviewerRegistry>();
    let kanban = app.state::<KanbanStore>();
    let workspaces = app.state::<crate::workspace::WorkspaceStore>().snapshot().workspaces;
    for workspace in workspaces {
        let Ok(cards) = kanban.load(&workspace.id) else {
            continue;
        };
        for card in cards {
            if restart_request(&card).is_none() {
                continue;
            }
            // Nor one whose worktree is gone: the review would only fail.
            if !card.worktree_path.as_deref().is_some_and(|p| std::path::Path::new(p).is_dir()) {
                continue;
            }
            let job = registry.slots().admit(
                &workspace.id,
                &card.id,
                |reviewing| {
                    if reviewing {
                        return Ok(None);
                    }
                    let records = registry.list_for_card(&workspace.id, &card.id);
                    let mut next = None;
                    kanban.with_card_saved(&workspace.id, &card.id, |c| {
                        next = resume_at_launch(c, &records, now_millis());
                        Ok(())
                    })?;
                    Ok::<_, String>(next)
                },
                Option::is_some,
            );
            match job {
                Ok(Some(job)) => {
                    crate::kanban::emit_kanban_changed(app, &workspace.id);
                    if let Err(e) = spawn_challenger(app.clone(), &workspace.id, &card.id, job) {
                        log::warn!("builder: waiting review of {} did not start: {e}", card.id);
                    }
                }
                Ok(None) => {}
                Err(e) => log::warn!("builder: waiting review of {} did not start: {e}", card.id),
            }
        }
    }
}

/// 1.168.1 (E2, Challenger): the record of a review that just started, with
/// the model it runs on (`ModelChoice::label`, `None` for the tool's own
/// default) — read by the card's Challenger chip while it runs.
fn started_review(
    snapshot_n: u32,
    provider: &str,
    degraded: bool,
    single_vendor: bool,
    model: Option<String>,
    kind: crate::review_passes::ReviewKind,
) -> BuilderReview {
    BuilderReview {
        snapshot_n,
        provider: provider.to_string(),
        degraded,
        single_vendor,
        status: "running".into(),
        at: now_millis(),
        model,
        kind,
        ..Default::default()
    }
}

/// D7 + E2: run the Challenger's review of `job`'s snapshot and return it
/// as it settles on the card. Blocking. The other vendor first; if it
/// cannot be made eligible, the Builder's own vendor, labelled degraded;
/// if neither, the review is failed and Ship is never blocked.
/// `pass_budget` (GH #58): diff bytes per review pass.
fn review_snapshot(
    app: &AppHandle,
    workspace_id: &str,
    card_id: &str,
    job: &ChallengerJob,
) -> SettledReview {
    let snapshot_n = job.snapshot_n;
    let pass_budget = job.pass_budget;
    let kind = job.kind;
    let app = app.clone();
    let (workspace_id, card_id) = (workspace_id.to_string(), card_id.to_string());
    let kanban = app.state::<KanbanStore>();
    // Challenger on a pull request: the Challenger chosen in the sheet
    // reviews every head and every fix, whichever vendor builds.
    let builder_vendor = kanban
        .get_card(&workspace_id, &card_id)
        .ok()
        .and_then(|c| crate::pr_review::challenger_of(&c).map(|ch| challenger_for(ch).to_string()))
        .unwrap_or_else(|| job.builder_vendor.clone());
    let other = challenger_for(&builder_vendor);
    // OB-14 (§13.2): one AI is enough. With the other vendor not installed
    // at all the review is a separate, read-only session of the Builder's
    // own vendor — the same mechanism as E2's fallback, told apart on the
    // record (`single_vendor`) so the card does not call it a fault.
    let choice = choose_challenger(
        &builder_vendor,
        vendor_installed(&shell_env::get(), other),
        || ensure_reviewer(&app, provider_of(other)),
        || ensure_reviewer(&app, provider_of(&builder_vendor)),
    );
    let (chosen, degraded, single_vendor) = match choice {
        Ok(c) => (c.provider, c.degraded, c.single_vendor),
        Err(e) => {
            let review = failed_review(
                &kanban,
                &workspace_id,
                &card_id,
                BuilderReview {
                    snapshot_n,
                    provider: other.to_string(),
                    degraded: false,
                    status: "failed".into(),
                    verdict: None,
                    review_id: None,
                    excerpt: None,
                    error: Some(format!("No eligible reviewer: {e}")),
                    at: now_millis(),
                    note: None,
                    overridden_by: None,
                    pass_count: None,
                    file_count: None,
                    incomplete_reason: None,
                    model: None,
                    kind,
                    ..Default::default()
                },
            );
            return (review, None);
        }
    };
    // 1.169.0 (A3): a "Retry on…" runs on its choice only on the vendor the
    // menu offered it for; on another (the other vendor couldn't review) it
    // is dropped and the person told — never a retry recorded on a model it
    // didn't run on.
    let retry = match job.retry.as_ref() {
        Some(r) if r.vendor == chosen => Some(crate::model_catalog::fit(&chosen, r.choice.clone())),
        Some(_) => {
            use tauri::Emitter;
            let _ = app.emit(
                crate::retry_on::EVENT_DROPPED,
                crate::retry_on::Dropped {
                    workspace_id: workspace_id.clone(),
                    card_id: card_id.clone(),
                    title: kanban.get_card(&workspace_id, &card_id).map(|c| c.title).unwrap_or_default(),
                    vendor: chosen.clone(),
                },
            );
            None
        }
        None => None,
    };
    // 1.168.1 (E2, Challenger): the running record names the model the
    // review is about to run on — the same resolution `reviewer::run_review`
    // uses — so the card never shows a running review on a model it isn't.
    let running_choice = retry
        .clone()
        .unwrap_or_else(|| crate::settings::model_for_card_id(&app, &workspace_id, &card_id, &chosen, AgentRole::Challenger));
    let running_model = running_choice.label_for(&chosen);
    // The attempt it retries, for History — the review this one replaces.
    let retried = retry.as_ref().and_then(|_| {
        kanban
            .get_card(&workspace_id, &card_id)
            .ok()
            .and_then(|c| c.builder.and_then(|b| b.review))
            .map(|r| (r.at, r.model.clone(), crate::retry_on::review_outcome(&r)))
    });
    set_review(
        &app,
        &kanban,
        &workspace_id,
        &card_id,
        started_review(snapshot_n, &chosen, degraded, single_vendor, running_model.clone(), kind),
        None,
    );
    // A review started without a retry's choice ends any retry still open.
    let open_retry = kanban.get_card(&workspace_id, &card_id).ok().is_some_and(|c| {
        c.model_retries.iter().any(|r| r.role == "challenger" && r.outcome.is_none())
    });
    if retry.is_none() && open_retry {
        let _ = kanban.with_card_unstamped(&workspace_id, &card_id, |c| {
            crate::retry_on::interrupt_open_review_retries(c);
            Ok(())
        });
    }
    // The review started: the retry is recorded.
    if let Some(choice) = retry.as_ref() {
        let (from_at, from_model, from_outcome) = retried.clone().unwrap_or_default();
        let _ = kanban.with_card_unstamped(&workspace_id, &card_id, |c| {
            crate::retry_on::record(
                c,
                AgentRole::Challenger,
                &chosen,
                Some(from_at).filter(|at| *at > 0),
                from_model,
                Some(from_outcome).filter(|o| !o.is_empty()),
                choice,
                now_millis(),
            );
            Ok(())
        });
        crate::kanban::emit_kanban_changed(&app, &workspace_id);
    }
    let on_retry = |event: crate::reviewer::RetryEvent| {
        let mut changed = false;
        let _ = kanban.with_card(&workspace_id, &card_id, |c| {
            changed = apply_retry_event(c, snapshot_n, &event, now_millis());
            Ok(())
        });
        if changed {
            crate::kanban::emit_kanban_changed(&app, &workspace_id);
        }
    };
    match crate::reviewer::run_review(
        &app,
        provider_of(&chosen),
        &workspace_id,
        &card_id,
        pass_budget,
        kind,
        job.revision.as_deref(),
        &on_retry,
        retry.clone(),
    ) {
        Ok(view) => {
            let (mut review, review_status) = challenger_review_from_record(
                &view.record,
                snapshot_n,
                chosen,
                degraded,
                now_millis(),
            );
            review.single_vendor = single_vendor;
            // ADR 0006: the card shows the ledger as this review left it.
            if let Some(ledger) = app
                .state::<crate::reviewer::ReviewerRegistry>()
                .ledger(&workspace_id, &card_id)
            {
                review.ledger = ledger.findings;
            }
            if review.status == "failed" {
                review = failed_review(&kanban, &workspace_id, &card_id, review);
            } else if review.failed_passes.is_some() {
                review = unreviewed_facts(&kanban, &workspace_id, &card_id, review);
            }
            (review, review_status)
        }
        Err(e) => {
            let review = failed_review(
                &kanban,
                &workspace_id,
                &card_id,
                BuilderReview {
                    snapshot_n,
                    provider: chosen,
                    degraded,
                    single_vendor,
                    status: "failed".into(),
                    verdict: None,
                    review_id: None,
                    excerpt: None,
                    error: Some(e),
                    at: now_millis(),
                    note: None,
                    overridden_by: None,
                    pass_count: None,
                    file_count: None,
                    incomplete_reason: None,
                    // It started: it says the model it ran on (A3).
                    model: running_model,
                    kind,
                    ..Default::default()
                },
            );
            (review, None)
        }
    }
}

/// The card's review of a finished reviewer record, and the card
/// `review_status` change it implies. Only a concrete CHANGES_REQUESTED
/// sets ChangesRequested; APPROVE clears it; INCOMPLETE (GH #58) leaves it
/// alone — it is not a request for changes.
fn challenger_review_from_record(
    record: &crate::reviewer::ReviewerRecord,
    snapshot_n: u32,
    provider: String,
    degraded: bool,
    at: i64,
) -> (BuilderReview, Option<Option<ReviewStatus>>) {
    let artifact = record.artifact.clone().unwrap_or_default();
    let completed = matches!(record.status, crate::reviewer::ReviewRunStatus::Completed);
    let verdict = if completed {
        record
            .verdict
            .clone()
            .or_else(|| parse_verdict(&artifact).map(str::to_string))
    } else {
        None
    };
    let review_status = match (completed, verdict.as_deref()) {
        (true, Some("changes_requested")) => Some(Some(ReviewStatus::ChangesRequested)),
        (true, Some("approve")) => Some(None),
        _ => None,
    };
    let incomplete_reason = if verdict.as_deref() == Some("incomplete") {
        record
            .incomplete_reason
            .clone()
            .or_else(|| Some("diff too large".into()))
    } else {
        None
    };
    (
        BuilderReview {
            snapshot_n,
            provider,
            degraded,
            status: if completed { "done".into() } else { "failed".into() },
            verdict,
            review_id: Some(record.id.clone()),
            excerpt: if artifact.is_empty() { None } else { Some(excerpt_of(&artifact)) },
            error: record.error.clone(),
            at,
            note: None,
            overridden_by: None,
            pass_count: (record.pass_count > 0).then_some(record.pass_count),
            file_count: (record.pass_count > 0).then_some(record.file_count),
            incomplete_reason,
            model: record.model.clone(),
            reviewed_revision: (!record.reviewed_revision.is_empty())
                .then(|| record.reviewed_revision.clone()),
            failure_reason: if completed && record.failed_passes == 0 {
                None
            } else {
                record.failure_reason.clone()
            },
            retried: record.retries > 0,
            failed_passes: (completed && record.failed_passes > 0).then_some(record.failed_passes),
            kind: record.kind,
            synthesis_pass: record.synthesis_pass,
            findings: record.findings.clone(),
            non_blocking: record.non_blocking.clone(),
            checklist: record.checklist.clone(),
            skills_followed: record.skills_followed.clone(),
            failed_pass_names: record.failed_pass_names.clone(),
            findings_unread: record.findings_unread,
            builder_handoff: record.builder_handoff.clone(),
            follow_up_fallback: record.follow_up_fallback.clone(),
            base_note: record.base_note.clone(),
            ledger_note: record.ledger_note.clone(),
            round: if completed { record.round.clone() } else { None },
            partial: record.partial,
            ..Default::default()
        },
        review_status,
    )
}

/// GH #58 "Review again in passes": re-run the Challenger on the current
/// snapshot in smaller passes, when its review is incomplete, gave no
/// verdict or failed. The worktree must still be that snapshot. The
/// alternative to #41's override for a review that could not see enough.
pub fn review_again(
    app: AppHandle,
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
) -> Result<u32, String> {
    review_again_with(app, kanban, workspace_id, card_id, None)
}

/// [`review_again`], with a "Retry on…" (A3): the settled review of the
/// current snapshot runs again on the retry's model, this once.
pub fn review_again_with(
    app: AppHandle,
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    retry: Option<crate::retry_on::ReviewRetry>,
) -> Result<u32, String> {
    let registry = app.state::<crate::reviewer::ReviewerRegistry>();
    // GH #124: one review per card at a time. The kind is read under the
    // slots' lock, so a review that ends meanwhile is counted.
    let job = registry.slots().admit(
        workspace_id,
        card_id,
        |reviewing| {
            if reviewing {
                return Err(ALREADY_REVIEWING.to_string());
            }
            let kind = review_kind_for(&app, workspace_id, card_id);
            record_review_again_with(kanban, workspace_id, card_id, kind, retry.clone())
        },
        |_| true,
    )?;
    crate::kanban::emit_kanban_changed(&app, workspace_id);
    let snapshot_n = job.snapshot_n;
    spawn_challenger(app, workspace_id, card_id, job)?;
    Ok(snapshot_n)
}

/// GH #124: "Review again" while a review of the card runs.
const ALREADY_REVIEWING: &str = "The Reviewer is already reviewing this card";

/// Challenger on a pull request: the head was reviewed with a verdict.
pub const PR_HEAD_REVIEWED: &str =
    "The Reviewer already reviewed this head of the pull request. Review again is offered once it has new commits.";

/// Challenger on a pull request: review the pull request's `head` (the
/// card's branch is already there) with the card's usual pipeline — a
/// snapshot per head, a sweep first and follow-ups after, the ledger, the
/// findings filter. A head already reviewed runs again only when that
/// review failed or was incomplete (as Review again does). One review per
/// card at a time. Returns the snapshot reviewed.
pub fn review_pr_head(
    app: &AppHandle,
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    head: &str,
) -> Result<u32, String> {
    let registry = app.state::<crate::reviewer::ReviewerRegistry>();
    let job = registry.slots().admit(
        workspace_id,
        card_id,
        |reviewing| {
            if reviewing {
                return Err(ALREADY_REVIEWING.to_string());
            }
            let kind = review_kind_for(app, workspace_id, card_id);
            record_pr_head_review(kanban, workspace_id, card_id, head, kind, now_millis())
        },
        |_| true,
    )?;
    crate::kanban::emit_kanban_changed(app, workspace_id);
    let snapshot_n = job.snapshot_n;
    spawn_challenger(app.clone(), workspace_id, card_id, job)?;
    Ok(snapshot_n)
}

/// `review_pr_head`'s card write: `head` becomes the card's newest snapshot
/// (unless it already is) and its review starts running.
pub(crate) fn record_pr_head_review(
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    head: &str,
    kind: crate::review_passes::ReviewKind,
    now: i64,
) -> Result<ChallengerJob, String> {
    let mut job: Option<ChallengerJob> = None;
    kanban.with_card(workspace_id, card_id, |c| {
        if c.pr_review.is_none() {
            return Err("this card doesn't review a pull request".into());
        }
        let legacy_reviewed = last_completed_review_revision(c);
        let b = c
            .builder
            .as_mut()
            .ok_or_else(|| "this card has no Reviewer record".to_string())?;
        let mut pass_budget = crate::review_passes::PASS_DIFF_BUDGET;
        let n = match b.snapshots.last() {
            Some(last) if last.sha == head => {
                match b.review.as_ref().filter(|r| r.snapshot_n == last.n) {
                    Some(r) if r.status == "running" => return Err(ALREADY_REVIEWING.to_string()),
                    Some(r) if !review_can_run_again(r) => return Err(PR_HEAD_REVIEWED.to_string()),
                    // An incomplete review runs again in smaller passes, as
                    // "Review again in passes" does; a failed one as it was.
                    Some(r) if r.status == "done" => {
                        pass_budget = crate::review_passes::SMALL_PASS_DIFF_BUDGET;
                    }
                    _ => {}
                }
                last.n
            }
            last => {
                let n = last.map_or(1, |s| s.n + 1);
                b.snapshots.push(BuildSnapshot { n, sha: head.to_string(), at: now });
                n
            }
        };
        let mut challenger = None;
        if let Some(pr) = c.pr_review.as_mut() {
            if !pr.heads.contains(&n) {
                pr.heads.push(n);
            }
            // P3-1: the branch is at this head only once its review is
            // admitted.
            pr.head_sha = head.to_string();
            challenger = pr.challenger.clone();
        }
        crate::pr_review::mark_branch_head(c, head);
        let b = c.builder.as_mut().expect("checked above");
        b.last_reviewed_revision = legacy_reviewed;
        let vendor = challenger
            .as_deref()
            .map(|ch| challenger_for(ch).to_string())
            .unwrap_or_else(|| b.vendor.clone());
        set_running_review(b, running_review(n, &vendor, kind, now));
        job = Some(ChallengerJob {
            snapshot_n: n,
            builder_vendor: vendor,
            pass_budget,
            kind,
            revision: Some(head.to_string()),
            retry: None,
        });
        // As at Build done: a new review supersedes an earlier request for
        // changes until its own verdict says otherwise.
        if matches!(c.review_status, Some(ReviewStatus::ChangesRequested)) {
            c.review_status = crate::pr_status::cleared_review_status(c);
        }
        Ok(())
    })?;
    job.ok_or_else(|| "the review did not capture the card".to_string())
}

fn record_review_again(
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    kind: crate::review_passes::ReviewKind,
) -> Result<ChallengerJob, String> {
    record_review_again_with(kanban, workspace_id, card_id, kind, None)
}

/// [`record_review_again`]; 1.169.0 (A3, owner B): with a `retry`, the
/// review of the current snapshot runs again even after a verdict — the
/// same snapshot, on the retry's model; the new verdict replaces the card's,
/// and both rounds stay in History.
fn record_review_again_with(
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    kind: crate::review_passes::ReviewKind,
    retry: Option<crate::retry_on::ReviewRetry>,
) -> Result<ChallengerJob, String> {
    let card = kanban.get_card(workspace_id, card_id)?;
    require_builder_worktree(&card)?;
    let wt = PathBuf::from(card.worktree_path.as_deref().unwrap_or_default());
    require_at_last_snapshot(&card, &wt)?;
    let mut job: Option<ChallengerJob> = None;
    let mut pass_budget = crate::review_passes::SMALL_PASS_DIFF_BUDGET;
    kanban.with_card(workspace_id, card_id, |c| {
        // Review 5: see `record_build_done`.
        let legacy_reviewed = last_completed_review_revision(c);
        let b = c
            .builder
            .as_mut()
            .ok_or_else(|| "this card has no Builder session".to_string())?;
        let last = b
            .snapshots
            .last()
            .map(|s| s.n)
            .ok_or_else(|| "The Builder's work isn't saved yet.".to_string())?;
        match b.review.as_ref() {
            Some(r) if r.snapshot_n == last && r.status == "running" => {
                return Err("The Reviewer is already reviewing this round.".into());
            }
            Some(r) if r.snapshot_n == last && r.status != "running" && retry.is_some() => {
                pass_budget = crate::review_passes::PASS_DIFF_BUDGET;
            }
            Some(r) if r.snapshot_n == last && review_can_run_again(r) => {
                pass_budget = if r.status == "failed" || r.failed_passes.is_some() {
                    crate::review_passes::PASS_DIFF_BUDGET
                } else {
                    crate::review_passes::SMALL_PASS_DIFF_BUDGET
                };
            }
            _ => {
                return Err(
                    "There is no incomplete or failed review of the current round to run again."
                        .into(),
                );
            }
        }
        b.last_reviewed_revision = legacy_reviewed;
        set_running_review(b, BuilderReview {
            snapshot_n: last,
            provider: challenger_for(&b.vendor).to_string(),
            degraded: false,
            status: "running".into(),
            verdict: None,
            review_id: None,
            excerpt: None,
            error: None,
            at: now_millis(),
            note: None,
            overridden_by: None,
            pass_count: None,
            file_count: None,
            incomplete_reason: None,
            model: None,
            kind,
            ..Default::default()
        });
        job = Some(ChallengerJob {
            snapshot_n: last,
            builder_vendor: b.vendor.clone(),
            pass_budget,
            kind,
            revision: b.snapshots.last().map(|s| s.sha.clone()),
            retry: retry.clone(),
        });
        Ok(())
    })?;
    job.ok_or_else(|| "the review did not capture the card".to_string())
}

/// Ship's refusal for a Builder card whose worktree moved past its last
/// build snapshot (uncommitted edits, or commits the Builder made itself).
/// Ship and Push update while a merge waits in the card's copy.
pub const MERGE_PENDING: &str = "A merge is waiting in the card's copy. Press Finish and check first: it commits the merge and runs the checks.";
pub const CHANGED_AFTER_BUILD_DONE: &str = "The Builder changed files after the last Finish and check. Press Finish and check to test them, then ship.";

/// Ship publishes a Builder card only as its last build snapshot: the
/// commit Verify and the Challenger examined. Anything the Builder changed
/// since — edits, new files, its own commits — is refused, never flushed.
pub fn require_at_last_snapshot(card: &KanbanCard, worktree: &Path) -> Result<(), String> {
    // 1.170.0 (G6, Challenger): a merge waiting in the card's copy (Bring
    // in the target's changes, or Ask the Builder to resolve it) is not the
    // snapshot: Finish and check commits it and runs the checks first.
    if crate::ship_conflict::merge_pending(worktree).is_some() {
        return Err(MERGE_PENDING.into());
    }
    let Some(last) = card.builder.as_ref().and_then(|b| b.snapshots.last()) else {
        return Err(
            "The Builder's work isn't saved yet. Press Finish and check to test it, then ship."
                .into(),
        );
    };
    if crate::worktrees::worktree_is_dirty(worktree)?
        || crate::worktrees::head_sha(worktree)? != last.sha
    {
        return Err(CHANGED_AFTER_BUILD_DONE.into());
    }
    Ok(())
}

/// A Builder card's worktree must exist to be shipped: without it Ship
/// cannot check the snapshot against Verify, and a ship that merged
/// nothing would still mark the card shipped.
pub fn require_builder_worktree(card: &KanbanCard) -> Result<(), String> {
    // SL-6: two builds and no pick yet — nothing to ship.
    if crate::build_both::is_undecided(card) {
        return Err(crate::build_both::UNDECIDED_REFUSAL.into());
    }
    if card.builder.is_none() {
        return Ok(());
    }
    match card.worktree_path.as_deref() {
        Some(p) if Path::new(p).is_dir() => Ok(()),
        _ => Err(
            "This Builder card's own copy of the repository is gone, so Ship can't check its saved work against your checks. Nothing was shipped."
                .into(),
        ),
    }
}

/// What Ship requires before publishing a Builder card: the worktree is
/// exactly the last snapshot, and Verify passed on that snapshot's content.
/// A pass on anything else — the same worktree before or after an edit —
/// is not attributed to the snapshot and does not count.
pub fn require_verified_snapshot(
    card: &KanbanCard,
    worktree: &Path,
    verify_in_flight: bool,
) -> Result<(), String> {
    require_at_last_snapshot(card, worktree)?;
    require_snapshot_verified(card, worktree, verify_in_flight)
}

/// Verify passed on the last snapshot's own content. Resolved from the
/// snapshot SHA — the commit `publish_rev` publishes — never from the
/// worktree, which the open session can change at any moment.
fn require_snapshot_verified(
    card: &KanbanCard,
    repo: &Path,
    verify_in_flight: bool,
) -> Result<(), String> {
    let snapshot = card
        .builder
        .as_ref()
        .and_then(|b| b.snapshots.last())
        .ok_or_else(|| "The Builder's work isn't saved yet. Press Finish and check to test it, then ship.".to_string())?;
    let tree = crate::worktrees::commit_tree_sha(repo, &snapshot.sha)?;
    crate::verify::require_verified_commit(&snapshot.sha, &tree, verify_in_flight, &card.verify_history)
}

/// What Ship merges or pushes for a card. A Builder card publishes its last
/// build snapshot's SHA (checked by `require_at_last_snapshot`), never its
/// branch: the session stays open and can move the branch after the check.
/// Other cards publish their branch.
pub fn publish_rev(card: &KanbanCard, branch: &str) -> String {
    card.builder
        .as_ref()
        .and_then(|b| b.snapshots.last())
        .map(|s| s.sha.clone())
        .unwrap_or_else(|| branch.to_string())
}

/// Result of "Build done". `new_snapshot` is true for a newly recorded
/// SHA; `reselected` when the tree went back to an earlier snapshot, which
/// becomes the current one again. Both false: the tree already is the
/// current snapshot — nothing is recorded, reviewed or verified again, except
/// that Skip review overrides a standing changes-requested verdict.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDone {
    pub snapshot: BuildSnapshot,
    pub new_snapshot: bool,
    pub reselected: bool,
    /// Unchanged tree + Skip review (or "Accept the Builder's pushback"):
    /// the changes-requested verdict on the current snapshot was overridden.
    pub review_overridden: bool,
    /// Unchanged tree and the Challenger's changes-requested verdict still
    /// stands on the current snapshot — why Ship is not reachable.
    pub changes_requested: bool,
    /// Unchanged tree: Verify already passed on this snapshot's content, so
    /// nothing is re-run. Always false for a new or re-selected snapshot.
    pub snapshot_verified: bool,
    /// GH #124: the Challenger was still reviewing this card, so the new
    /// snapshot is reviewed next — Some(the snapshot under review now; 0
    /// when the card does not say). None when its review started or was
    /// skipped, and on an unchanged tree.
    pub review_waiting_on: Option<u32>,
    /// GH #124: Skip review on an unchanged tree dropped the review that
    /// was waiting for the running one.
    pub waiting_dropped: bool,
    /// GH #124: an unchanged tree started the review that was left waiting
    /// with none running — this snapshot. None otherwise.
    pub waiting_started: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SnapshotRecord {
    /// A SHA never recorded: appended as the next snapshot.
    New,
    /// An earlier snapshot the tree went back to: moved to the end (the
    /// current snapshot Ship checks) with its number kept, not duplicated.
    Reselected,
    /// Already the current snapshot.
    Unchanged,
}

/// Make `sha` the current (last) build snapshot. The list never repeats a
/// SHA: an earlier entry is moved to the end rather than recorded again.
/// Duplicates persisted before this rule (PR #27's `[A, B, B]`) are
/// normalized first, keeping each SHA's latest position, so the current
/// snapshot stays current and a repeated Build done is a no-op.
fn record_snapshot(builder: &mut BuilderState, sha: &str, at: i64) -> (BuildSnapshot, SnapshotRecord) {
    let mut seen = std::collections::HashSet::new();
    let mut kept: Vec<BuildSnapshot> = Vec::with_capacity(builder.snapshots.len());
    for s in builder.snapshots.drain(..).rev() {
        if seen.insert(s.sha.clone()) {
            kept.push(s);
        }
    }
    kept.reverse();
    builder.snapshots = kept;
    match builder.snapshots.iter().position(|s| s.sha == sha) {
        Some(i) if i + 1 == builder.snapshots.len() => {
            (builder.snapshots[i].clone(), SnapshotRecord::Unchanged)
        }
        Some(i) => {
            let mut snapshot = builder.snapshots.remove(i);
            snapshot.at = at;
            builder.snapshots.push(snapshot.clone());
            (snapshot, SnapshotRecord::Reselected)
        }
        None => {
            let n = builder.snapshots.iter().map(|s| s.n).max().unwrap_or(0) + 1;
            let snapshot = BuildSnapshot { n, sha: sha.to_string(), at };
            builder.snapshots.push(snapshot.clone());
            (snapshot, SnapshotRecord::New)
        }
    }
}

/// ADR 0006 (third card): how long Build done waits for the Builder to come
/// back from its self-check before it goes on to Verify without it. The
/// frontend owns the timer; `ipc.ts` mirrors the value.
pub const SELF_CHECK_TIMEOUT_SECS: u64 = 600;

/// ADR 0006 (third card): the message Build done sends the Builder first,
/// or None when no self-check runs: the repository's switch is off, or the
/// worktree is exactly the last snapshot (Build done would record nothing
/// new, so there is nothing to check).
/// 1.171.0 C2: Finish and check asked the Builder for its self-check at
/// `at` — kept on the card (`BuilderState::self_check_started_at`) until
/// that Finish and check goes on (`done`), so one Plyloft quit during is
/// said after the relaunch. Unstamped: asking is no change to the card.
pub fn mark_self_check_started(
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    at: i64,
) -> Result<(), String> {
    kanban.with_card_unstamped(workspace_id, card_id, |c| {
        if let Some(b) = c.builder.as_mut() {
            b.self_check_started_at = Some(at);
        }
        Ok(())
    })
}

pub fn self_check_message(
    card: &KanbanCard,
    review: &crate::project_config::ReviewSettings,
    token: &str,
) -> Result<Option<String>, String> {
    if card.builder.is_none() {
        return Err("this card has no Builder session".into());
    }
    if token.is_empty() || token.len() > 32 || !token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("the self-check token must be 1 to 32 letters, digits or dashes".into());
    }
    if !review.self_check {
        return Ok(None);
    }
    // P-E: a merge with marks left goes straight to Finish and check's
    // refusal, not first to a self-check.
    if crate::ship_conflict::finish_refusal(card).is_some() {
        return Ok(None);
    }
    let worktree = card
        .worktree_path
        .as_deref()
        .ok_or_else(|| "This card has no copy of the repository.".to_string())?;
    if require_at_last_snapshot(card, Path::new(worktree)).is_ok() {
        return Ok(None);
    }
    let checklist = crate::review_passes::risk_checklist(&review.review_checklist);
    let may_add_tests = crate::review_passes::brief_asks_for_tests(&crate::kanban::card_brief_text(card))
        || project_has_tests(Path::new(worktree));
    Ok(Some(crate::review_passes::self_check_prompt(&checklist, token, may_add_tests)))
}

/// Owner decision (2026-10-01): whether the repository at `worktree` already
/// has a test suite a change should extend — a tracked test file, directory
/// or runner config (`review_passes::paths_hold_tests`), a real `test` script
/// in `package.json`, or a Rust `#[test]`. Fails towards "no suite": then the
/// self-check reports missing cases instead of adding a test setup.
pub fn project_has_tests(worktree: &Path) -> bool {
    let out = crate::platform::git_command()
        .args(["ls-files", "-z"])
        .current_dir(worktree)
        .stdin(std::process::Stdio::null())
        .output();
    let Ok(out) = out else { return false };
    if !out.status.success() {
        return false;
    }
    let paths: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect();
    if crate::review_passes::paths_hold_tests(&paths) {
        return true;
    }
    if std::fs::read_to_string(worktree.join("package.json"))
        .is_ok_and(|text| crate::review_passes::package_json_has_tests(&text))
    {
        return true;
    }
    paths.iter().any(|p| p.ends_with(".rs"))
        && crate::platform::git_command()
            .args(["grep", "-q", "-F", "#[test]", "--", "*.rs"])
            .current_dir(worktree)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
}

/// Skills hub H5 (R12): align the twins the Builder left apart on `card`'s
/// branch, now that `wt` is committed ([`crate::skill_twins::align_card_branch`]).
/// Never on a pull request review card — its fix is pushed to somebody's
/// pull request, and nothing but the Builder's fix goes there — and never
/// fatal: a twin Plyloft couldn't align is left for the Library's Align.
fn align_twins_after_build(card: &KanbanCard, wt: &Path) -> Option<crate::skill_twins::BranchAlign> {
    if card.pr_review.is_some() {
        return None;
    }
    let base = card.worktree_base.as_ref().map(|base| base.commit.clone())?;
    let prefix = crate::skill_card::workspace_prefix(wt).unwrap_or_default();
    // Challenger: an earlier round's snapshot is a newer aligned state than
    // the base, so a Builder that changes one copy back is judged from it.
    let earlier: Vec<String> = card
        .builder
        .as_ref()
        .map(|b| b.snapshots.iter().rev().map(|s| s.sha.clone()).collect())
        .unwrap_or_default();
    match crate::skill_twins::align_card_branch(wt, &base, &earlier, &card.twins_aligned, &prefix) {
        Ok(done) => {
            if !done.differ.is_empty() {
                log::info!("skills hub: card {}: the copies of {} stay apart; Align asks", card.id, done.differ.join(", "));
            }
            Some(done)
        }
        Err(why) => {
            log::warn!("skills hub: card {}: couldn't align the skills' copies ({why})", card.id);
            None
        }
    }
}

/// H5 (Challenger, Builder walk): what the card's Checks say after this
/// round — the aligns still in its tree, and the skills whose copies stay
/// apart. A skill the card no longer changes, or whose copies now stand
/// apart, loses its "updated to match" note; one aligned again leaves the
/// apart list.
fn apply_twins_round(card: &mut KanbanCard, done: &crate::skill_twins::BranchAlign) {
    card.twins_aligned
        .retain(|known| done.touched.contains(&known.skill) && !done.differ.contains(&known.skill));
    for aligned in &done.aligned {
        card.twins_aligned.retain(|known| known.skill != aligned.skill);
        card.twins_aligned.push(aligned.clone());
    }
    card.twins_apart = done.differ.clone();
}

/// D6 + E1: "Build done". Snapshot-commit the worktree, record it, and
/// mark the run finished so the lifecycle moves to Outcome. The session
/// stays open (D8: the Challenger's verdict goes back into it). Unless
/// skipped, the Challenger's review starts in the background (D7).
///
/// On an unchanged tree with `skip_review`, a changes-requested verdict on
/// the current snapshot is overridden instead (the human accepted the
/// Builder's pushback); `by` is who pressed it.
pub fn done(
    app: AppHandle,
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    skip_review: bool,
    by: Option<&str>,
    self_check: Option<SelfCheckRecord>,
) -> Result<BuildDone, String> {
    // GH #124: while a review of this card runs, the new snapshot waits
    // for it instead of starting a second one. Verify is not held. The
    // kind is read under the slots' lock: a review that ended just before
    // has settled on the card, so this one follows up on it.
    let registry = app.state::<crate::reviewer::ReviewerRegistry>();
    let (result, challenger) = build_done_in_slots(
        registry.slots(),
        kanban,
        workspace_id,
        card_id,
        skip_review,
        by,
        self_check,
        || review_kind_for(&app, workspace_id, card_id),
    )?;
    if result.new_snapshot || result.reselected || result.review_overridden
        || result.waiting_dropped
        || result.waiting_started.is_some()
    {
        crate::kanban::emit_kanban_changed(&app, workspace_id);
    }
    // GH #104 walk (A2): Skip review on an unchanged tree accepted the
    // Builder's pushback, which settles the card — the proposal pass the last
    // review held back runs now.
    if result.review_overridden {
        crate::proposals::after_human_decision(&app, workspace_id, card_id);
        // G1–G3 Challenger (3): a human's decision is an approval.
        crate::pr_merge::kick_resume_held(&app, workspace_id, card_id);
    }
    if let Some(job) = challenger {
        spawn_challenger(app, workspace_id, card_id, job)?;
    }
    Ok(result)
}

/// `done` without the AppHandle: Build done under the slots' lock, with
/// the review's kind read there too (`kind`), so a review that ended just
/// before counts. A review it starts leaves the card reviewing.
#[allow(clippy::too_many_arguments)]
fn build_done_in_slots(
    slots: &crate::reviewer::ReviewSlots,
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    skip_review: bool,
    by: Option<&str>,
    self_check: Option<SelfCheckRecord>,
    kind: impl FnOnce() -> crate::review_passes::ReviewKind,
) -> Result<(BuildDone, Option<ChallengerJob>), String> {
    let done = slots.admit(
        workspace_id,
        card_id,
        |reviewing| record_build_done(kanban, workspace_id, card_id, skip_review, by, kind(), self_check, reviewing),
        |(_, job)| job.is_some(),
    );
    // 1.171.0 C2 (Challenger 2): a Finish and check that was refused (a
    // conflict still marked, a commit or a read that failed) is over too —
    // the refusal is said by the press; the card must not later claim the
    // session ended mid re-read. Best effort, unstamped.
    if done.is_err() {
        let _ = clear_self_check_started(kanban, workspace_id, card_id);
    }
    done
}

/// 1.171.0 C2: the self-check Finish and check asked for is over.
pub(crate) fn clear_self_check_started(kanban: &KanbanStore, workspace_id: &str, card_id: &str) -> Result<(), String> {
    if kanban
        .get_card(workspace_id, card_id)?
        .builder
        .as_ref()
        .is_none_or(|b| b.self_check_started_at.is_none())
    {
        return Ok(());
    }
    kanban.with_card_unstamped(workspace_id, card_id, |c| {
        if let Some(b) = c.builder.as_mut() {
            b.self_check_started_at = None;
        }
        Ok(())
    })
}

/// The Challenger review `done` must start, if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChallengerJob {
    snapshot_n: u32,
    builder_vendor: String,
    /// GH #99: a review that failed outright runs again in normal passes —
    /// its problem was the provider, not the size of the change.
    pass_budget: usize,
    /// ADR 0006: the card's first review is a sweep.
    kind: crate::review_passes::ReviewKind,
    /// GH #124: the snapshot's commit, which the review reads — not the
    /// branch tip, which may have moved while the review waited.
    revision: Option<String>,
    /// 1.169.0 (A3): a "Retry on…" of this review: its model, this once.
    retry: Option<crate::retry_on::ReviewRetry>,
}

/// ADR 0006: whether the review about to start is the card's sweep, from
/// the reviewer records of this card.
fn review_kind_for(
    app: &AppHandle,
    workspace_id: &str,
    card_id: &str,
) -> crate::review_passes::ReviewKind {
    let registry = app.state::<crate::reviewer::ReviewerRegistry>();
    let card = app.state::<KanbanStore>().get_card(workspace_id, card_id).ok();
    crate::review_context::kind_for_card(
        &registry.list_for_card(workspace_id, card_id),
        card.as_ref(),
    )
}

/// `done` without the AppHandle side effects (event, Challenger thread),
/// so the snapshot and review bookkeeping is testable.
pub(crate) fn record_build_done(
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    skip_review: bool,
    by: Option<&str>,
    review_kind: crate::review_passes::ReviewKind,
    self_check: Option<SelfCheckRecord>,
    reviewing: bool,
) -> Result<(BuildDone, Option<ChallengerJob>), String> {
    let card = kanban.get_card(workspace_id, card_id)?;
    if card.builder.is_none() {
        return Err("this card has no Builder session".into());
    }
    let worktree = card
        .worktree_path
        .clone()
        .ok_or_else(|| "This card has no copy of the repository.".to_string())?;
    let wt = PathBuf::from(&worktree);
    let n = card
        .builder
        .as_ref()
        .map(|b| b.snapshots.len() as u32 + 1)
        .unwrap_or(1);
    // UX P1 point 7 (P-E): a merge Plyloft started for a ship conflict is
    // committed only once every file is resolved — never with its marks.
    if let Some(refusal) = crate::ship_conflict::finish_refusal(&card) {
        return Err(refusal);
    }
    // A pending merge, resolved: the snapshot is its merge commit (git
    // commits with `MERGE_HEAD` as the second parent).
    let merging = crate::ship_conflict::merge_pending(&wt).is_some();
    let message = crate::ship_conflict::merge_commit_message(&card, n)
        .unwrap_or_else(|| crate::commit_message::snapshot_subject(n, &card.title));
    crate::worktrees::commit_pending_in_worktree(&wt, &message)?;
    // Skills hub H5 (R12, Challenger): a skill whose Claude copy (or Codex
    // copy) alone the Builder changed gets the other brought in line now —
    // a commit on the card branch before the snapshot Verify, the Challenger
    // and Ship read, so all three see one tree.
    let aligned = align_twins_after_build(&card, &wt);
    let sha = git_head_sha(&wt)?;
    let at = now_millis();
    let vendor = card
        .builder
        .as_ref()
        .map(|b| b.vendor.clone())
        .unwrap_or_else(|| "claude".into());
    let mut existing: Option<BuildSnapshot> = None;
    let mut recorded: Option<BuildSnapshot> = None;
    let mut reselected = false;
    let mut overridden = false;
    let mut waiting_on: Option<u32> = None;
    let mut waiting_dropped = false;
    let mut resumed: Option<ChallengerJob> = None;
    let mut after: Option<KanbanCard> = None;
    let mut new_round = false;
    kanban.with_card(workspace_id, card_id, |c| {
        // Review 5: a completed review recorded before GH #99 carries no
        // last reviewed revision; keep its revision before it is replaced.
        let legacy_reviewed = last_completed_review_revision(c);
        // GH #104 walk (B3): the request for changes standing on the snapshot
        // this Build done replaces — answered by a change, if one is recorded.
        let open_request = changes_requested_on_current(c)
            .then(|| c.builder.as_ref().and_then(|b| b.review.as_ref()).map(|r| r.snapshot_n))
            .flatten();
        if let Some(b) = c.builder.as_mut() {
            // 1.171.0 C2: this Finish and check goes on; the self-check it
            // asked for (if any) is over.
            b.self_check_started_at = None;
            let (snapshot, kind) = record_snapshot(b, &sha, at);
            if let (Some(asked_on), true) = (open_request, kind != SnapshotRecord::Unchanged) {
                b.remember_decision(crate::kanban::RequestDecision {
                    snapshot_n: asked_on,
                    outcome: crate::kanban::RequestOutcome::BuilderChanged,
                    next_snapshot_n: Some(snapshot.n),
                    by: None,
                    at,
                });
            }
            // ADR 0006 (third card): the self-check that ran before this
            // snapshot, with the snapshot it preceded.
            if let Some(record) = &self_check {
                b.self_check = Some(SelfCheckRecord {
                    snapshot_n: Some(snapshot.n),
                    ..record.clone()
                });
            }
            if kind == SnapshotRecord::Unchanged {
                // P-E: the Builder aborted Plyloft's merge and nothing
                // changed — the card is back where the press found it.
                if !merging {
                    if let Some(conflict) = c.ship_conflict.as_mut() {
                        conflict.merge_started_at = None;
                    }
                }
                existing = Some(snapshot);
                if skip_review {
                    // GH #124: Skip review asks for no review of this
                    // snapshot, so none waits for it either.
                    if let Some(b) = c.builder.as_mut() {
                        waiting_dropped = b.waiting_review.take().is_some();
                    }
                    overridden = override_changes_requested(c, by, at).is_some();
                }
                after = Some(c.clone());
                return Ok(());
            }
            // New or re-selected: the current snapshot changed, so its
            // review (and, from the frontend, Verify) runs again.
            reselected = kind == SnapshotRecord::Reselected;
            let n = snapshot.n;
            recorded = Some(snapshot);
            new_round = true;
            if reviewing && !skip_review {
                // GH #124: the running review keeps the card; this snapshot
                // is reviewed next, replacing any that was waiting.
                waiting_on = b.review.as_ref().map(|r| r.snapshot_n);
                b.waiting_review = Some(WaitingReview { snapshot_n: n, requested_at: at });
            } else {
                // Skipped, the newest request wins: nothing waits either.
                b.waiting_review = None;
                b.last_reviewed_revision = legacy_reviewed;
                set_running_review(b, BuilderReview {
                    snapshot_n: n,
                    provider: challenger_for(&vendor).to_string(),
                    degraded: false,
                    status: if skip_review { "skipped".into() } else { "running".into() },
                    verdict: None,
                    review_id: None,
                    excerpt: None,
                    error: None,
                    at: now_millis(),
                    note: None,
                    overridden_by: None,
                    pass_count: None,
                    file_count: None,
                    incomplete_reason: None,
                    model: None,
                    kind: review_kind,
                    ..Default::default()
                });
            }
        }
        // P-E: a new round clears the last ship's conflict.
        if new_round {
            crate::ship_conflict::clear_on_new_round(c);
        }
        // H5: the Verify step names every twin Plyloft aligned on this card,
        // and the skills whose copies stay apart.
        if let Some(done) = &aligned {
            apply_twins_round(c, done);
        }
        c.last_run_status = Some(LastRunStatus::Success);
        // A fresh snapshot supersedes an earlier "changes requested".
        if matches!(c.review_status, Some(ReviewStatus::ChangesRequested)) {
            c.review_status = crate::pr_status::cleared_review_status(c);
        }
        Ok(())
    })?;
    // Walk 4 of #386 (finding 1): on a pull request card, a snapshot that
    // contains the pull request's head (the Builder merged its new commits
    // itself) is a fix built on that head — Push the fixes, no "New commits
    // under your fix".
    if let Some(head) = card.pr_review.as_ref().map(|p| p.head_sha.clone()).filter(|h| !h.is_empty()) {
        let contains = crate::pr_review::head_containment(&card, &wt, &head, Some(&sha));
        if let Err(e) = kanban.with_card_unstamped(workspace_id, card_id, |c| {
            crate::pr_review::adopt_head_in_fix(c, &contains, at);
            Ok(())
        }) {
            log::warn!("builder: {card_id}: couldn't record the pull request's head in the fix: {e}");
        }
    }
    if let Some(snapshot) = existing {
        let mut after = after.unwrap_or(card);
        // GH #124: a request left waiting with no review running (its
        // hand-over could not be saved) starts now, so the card is never
        // stuck on it — only once that is on disk.
        let left_waiting = after.builder.as_ref().is_some_and(|b| b.waiting_review.is_some());
        if !skip_review && !reviewing && left_waiting {
            let mut started: Option<KanbanCard> = None;
            let saved = kanban.with_card_saved(workspace_id, card_id, |c| {
                resumed = start_waiting_as(c, review_kind, at);
                started = Some(c.clone());
                Ok(())
            });
            match saved {
                Ok(()) => after = started.unwrap_or(after),
                Err(e) => {
                    log::error!("builder: could not start {card_id}'s waiting review: {e}");
                    resumed = None;
                }
            }
        }
        return Ok((
            BuildDone {
                snapshot,
                new_snapshot: false,
                reselected: false,
                review_overridden: overridden,
                changes_requested: changes_requested_on_current(&after),
                snapshot_verified: require_snapshot_verified(&after, &wt, false).is_ok(),
                review_waiting_on: None,
                waiting_dropped,
                waiting_started: resumed.as_ref().map(|job| job.snapshot_n),
            },
            resumed,
        ));
    }
    let snapshot =
        recorded.ok_or_else(|| "This card lost its Builder session while saving its work.".to_string())?;
    let waiting = reviewing && !skip_review;
    let challenger = (!skip_review && !waiting).then(|| ChallengerJob {
        snapshot_n: snapshot.n,
        builder_vendor: vendor,
        pass_budget: crate::review_passes::PASS_DIFF_BUDGET,
        kind: review_kind,
        revision: Some(snapshot.sha.clone()),
        retry: None,
    });
    Ok((
        BuildDone {
            snapshot,
            new_snapshot: !reselected,
            reselected,
            review_overridden: false,
            changes_requested: false,
            snapshot_verified: false,
            review_waiting_on: waiting.then(|| waiting_on.unwrap_or(0)),
            waiting_dropped: false,
            waiting_started: None,
        },
        challenger,
    ))
}

/// The Challenger's changes-requested verdict stands on the current (last)
/// build snapshot — the state that keeps a Builder card on Run.
pub fn changes_requested_on_current(card: &KanbanCard) -> bool {
    let Some(b) = card.builder.as_ref() else {
        return false;
    };
    let (Some(review), Some(last)) = (b.review.as_ref(), b.snapshots.last()) else {
        return false;
    };
    review.status == "done"
        && review.verdict.as_deref() == Some("changes_requested")
        && review.snapshot_n == last.n
}

/// Findings filter: the member dismissed a finding as not a real issue
/// (`ReviewerRegistry::dismiss_finding`); `ledger` is the card's ledger as
/// it now stands. The card's last review shows it, and a hand-over carries
/// only what still blocks. When the changes-requested verdict on the current
/// snapshot rested on findings that no longer block (and Ply read every
/// finding), the review now reads as an approval the Builder is told of.
/// True when it did.
pub fn apply_dismissal(
    card: &mut KanbanCard,
    card_ledger: &crate::review_ledger::CardLedger,
    dismissed_id: &str,
    at: i64,
) -> bool {
    let ledger = card_ledger.findings.as_slice();
    // Only a whole review: every pass judged its files (no failed pass, no
    // INCOMPLETE read as a request — the ledger moved its baseline to the
    // revision this review read) and Ply read every finding. Otherwise the
    // dismissal is recorded and the request stands.
    let whole = |review: &BuilderReview| {
        !review.partial
            && review.failed_passes.is_none()
            && !review.findings_unread
            && !review.ledger.is_empty()
            && review.reviewed_revision.is_some()
            && card_ledger.reviewed_revision == review.reviewed_revision
    };
    let approve = changes_requested_on_current(card)
        && card.builder.as_ref().and_then(|b| b.review.as_ref()).is_some_and(whole)
        && !ledger.iter().any(|finding| finding.is_open() && finding.blocks());
    let Some(b) = card.builder.as_mut() else {
        return false;
    };
    if let Some((snapshot_n, handed_at)) = b.handed_over.as_ref().map(|h| (h.snapshot_n, h.at)) {
        b.handed_over = handed_over_from_ledger(ledger, snapshot_n, handed_at);
    }
    let Some(review) = b.review.as_mut() else {
        return false;
    };
    // A running review shows no ledger yet: it reads the stored one when it
    // settles.
    if !review.ledger.is_empty() {
        review.ledger = ledger.to_vec();
    }
    if !approve {
        return false;
    }
    let note = format!(
        "Plyloft reads this review as APPROVE: the member dismissed {dismissed_id} as not a real issue, and no other finding blocks approval."
    );
    review.verdict = Some("approve".into());
    review.builder_handoff = None;
    review.ledger_note = Some(note);
    review.at = at;
    // GH #135: the Builder hears the new reading, in place of the request.
    b.undelivered_verdict = Some(UndeliveredVerdict { snapshot_n: review.snapshot_n, at });
    b.handed_over = None;
    if matches!(card.review_status, Some(ReviewStatus::ChangesRequested)) {
        card.review_status = crate::pr_status::cleared_review_status(card);
    }
    true
}

/// The human accepts the Builder's pushback: the changes-requested verdict
/// on the current snapshot becomes a `skipped` review carrying who
/// overrode it and when, and the card's changes-requested status clears.
/// The Challenger's notes (`review_id`, `excerpt`) stay for the record.
/// Returns the snapshot number, or None when there was nothing to override.
fn override_changes_requested(card: &mut KanbanCard, by: Option<&str>, at: i64) -> Option<u32> {
    if !changes_requested_on_current(card) {
        return None;
    }
    let b = card.builder.as_mut()?;
    // GH #135: the overridden verdict is not sent — `pushbackAcceptedMessage`
    // tells the Builder the human took it off the table instead.
    b.undelivered_verdict = None;
    let review = b.review.as_mut()?;
    let n = review.snapshot_n;
    review.status = "skipped".into();
    review.verdict = None;
    review.note = Some(format!(
        "changes requested on snapshot {n}, overridden by the human"
    ));
    review.overridden_by = by.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    review.at = at;
    // GH #104 walk (B3): the human's decision on this round, for the
    // improvement proposal's Challenger to read as authoritative.
    let decided_by = review.overridden_by.clone();
    b.remember_decision(crate::kanban::RequestDecision {
        snapshot_n: n,
        outcome: crate::kanban::RequestOutcome::PushbackAccepted,
        next_snapshot_n: None,
        by: decided_by,
        at,
    });
    if matches!(card.review_status, Some(ReviewStatus::ChangesRequested)) {
        // v1.154.1 (F11): back to the card's open pull request, if it has one.
        card.review_status = crate::pr_status::cleared_review_status(card);
    }
    Some(n)
}

/// "Accept the Builder's pushback" from the card header: the same override
/// as Build done + Skip review on an unchanged tree, without committing
/// anything. Refused when the worktree moved past the last snapshot —
/// those edits need a Build done (and Verify) of their own.
pub fn accept_pushback(
    app: AppHandle,
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    by: Option<&str>,
) -> Result<BuildDone, String> {
    let result = record_pushback_accepted(kanban, workspace_id, card_id, by)?;
    crate::kanban::emit_kanban_changed(&app, workspace_id);
    // GH #104 walk (A2): the human's decision settles the card, so the
    // improvement proposal's pass — held back while the request for changes
    // stood — runs now, on its own thread.
    crate::proposals::after_human_decision(&app, workspace_id, card_id);
    // G1–G3 Challenger (3): a human's decision is an approval.
    crate::pr_merge::kick_resume_held(&app, workspace_id, card_id);
    Ok(result)
}

fn record_pushback_accepted(
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    by: Option<&str>,
) -> Result<BuildDone, String> {
    let card = kanban.get_card(workspace_id, card_id)?;
    require_builder_worktree(&card)?;
    let wt = PathBuf::from(card.worktree_path.as_deref().unwrap_or_default());
    require_at_last_snapshot(&card, &wt)?;
    let at = now_millis();
    let mut after: Option<KanbanCard> = None;
    kanban.with_card(workspace_id, card_id, |c| {
        if override_changes_requested(c, by, at).is_none() {
            return Err(
                "The Reviewer hasn't asked for changes on the current round, so there is nothing to override.".into(),
            );
        }
        after = Some(c.clone());
        Ok(())
    })?;
    let after = after.ok_or_else(|| "the override did not capture the card".to_string())?;
    let snapshot = after
        .builder
        .as_ref()
        .and_then(|b| b.snapshots.last().cloned())
        .ok_or_else(|| "The Builder's work isn't saved yet.".to_string())?;
    Ok(BuildDone {
        snapshot,
        new_snapshot: false,
        reselected: false,
        review_overridden: true,
        changes_requested: false,
        snapshot_verified: require_snapshot_verified(&after, &wt, false).is_ok(),
        review_waiting_on: None,
        waiting_dropped: false,
        waiting_started: None,
    })
}

/// Findings filter: the findings of `review`'s ledger the member dismissed
/// as not a real issue, in one line: who, which, why. None when none was.
fn dismissal_lines_of(review: &BuilderReview) -> Option<String> {
    let parts: Vec<String> = review
        .ledger
        .iter()
        .filter_map(|finding| {
            let dismissal = finding.dismissal.as_ref()?;
            let who = dismissal.by.as_deref().unwrap_or("the human");
            let why = dismissal
                .reason
                .as_deref()
                .map(|reason| format!(": \"{}\"", reason.replace('"', "'")))
                .unwrap_or_default();
            Some(format!(
                "{} ({} — {}) by {who}{why}",
                finding.id,
                finding.severity.as_deref().unwrap_or("Unrated"),
                finding.title.trim()
            ))
        })
        .collect();
    (!parts.is_empty()).then(|| {
        format!("Reviewer findings dismissed as not a real issue: {}.", parts.join("; "))
    })
}

/// X2 round 2: one of Plyloft's own lines as the pull request body takes it
/// (`card_ship`: the override and dismissal line). The dismissed findings'
/// titles in it are the Reviewer's words, so the line passes the same
/// filter as the Reviewer's notes; the Ship receipt and the card keep the
/// line whole. `wt`: the card's copy.
pub fn line_for_github(line: &str, wt: &std::path::Path) -> String {
    crate::publish_filter::for_github_here(line, &[wt]).text
}

/// Findings filter: the Ship receipt's and PR body's line when the shipped
/// snapshot's last review carries findings the member dismissed, beside
/// `review_override_summary` (an accepted pushback). When the dismissal is
/// what made the review an approval, it says so.
pub fn dismissal_summary(card: &KanbanCard) -> Option<String> {
    let b = card.builder.as_ref()?;
    let review = b.review.as_ref()?;
    let last = b.snapshots.last()?;
    if review.status != "done" || review.snapshot_n != last.n {
        return None;
    }
    let line = dismissal_lines_of(review)?;
    let lifted = review.verdict.as_deref() == Some("approve")
        && review.ledger_note.as_deref().is_some_and(|note| {
            note.starts_with("Plyloft reads this review as APPROVE") && note.contains("dismissed")
        });
    Some(if lifted {
        format!(
            "The Reviewer's approval of round {} is Plyloft's reading after a human decision. {line}",
            review.snapshot_n
        )
    } else {
        line
    })
}

/// One line for the Ship receipt and PR body when the last Challenger
/// review of the shipped snapshot was overridden by the human: who, when,
/// which snapshot. None otherwise.
pub fn review_override_summary(card: &KanbanCard) -> Option<String> {
    let b = card.builder.as_ref()?;
    let review = b.review.as_ref()?;
    let last = b.snapshots.last()?;
    if review.status != "skipped" || review.note.is_none() || review.snapshot_n != last.n {
        return None;
    }
    let reviewer = match review.provider.as_str() {
        "codex" => "Codex",
        _ => "Claude",
    };
    // 1.171.0 C3: the receipt and the pull request read "the person".
    let who = review.overridden_by.as_deref().unwrap_or("the person");
    let when = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(review.at)
        .map(|d| d.format("%Y-%m-%d %H:%M UTC").to_string())
        .unwrap_or_else(|| "an unknown time".into());
    Some(format!(
        "Review overridden: the Reviewer ({reviewer}) requested changes on round {}; {who} kept it as it was on {when} without a new round.",
        review.snapshot_n
    ))
}

/// What the unreviewed line says of a review skipped on purpose (1.171.0
/// C3, owner 2026-10-27): "Last commit not reviewed by the Challenger: its
/// review was skipped (Check without the Reviewer)."
pub const SKIPPED_REVIEW_REASON: &str = "its review was skipped (Check without the Reviewer).";

/// GH #99: one line for the PR body when a Builder card ships a commit the
/// Challenger did not review — its last review failed, was still running,
/// was skipped on purpose (1.171.0 C3: "Check without the
/// Reviewer" — owner 2026-10-27, a skip is no review), or read an older
/// commit than `shipped_revision`. None when the shipped commit was
/// reviewed, when the person overrode a request for changes (an override
/// has its own line, `review_override_summary`), and on non-Builder cards.
pub fn unreviewed_ship_summary(card: &KanbanCard, shipped_revision: &str) -> Option<String> {
    let b = card.builder.as_ref()?;
    let review = b.review.as_ref()?;
    let last = b.snapshots.last();
    let failure_reason = || {
        review.failure_reason.clone().unwrap_or_else(|| {
            crate::review_failure::classify(review.error.as_deref().unwrap_or(""), None, false, false)
                .reason()
                .to_string()
        })
    };
    let failed_passes = review.failed_passes.unwrap_or(0);
    let passes_failed = || {
        // ADR 0006: a sweep's synthesis pass counts, and is named when it
        // is the one that failed.
        let total = review.pass_count.unwrap_or(0) + u32::from(review.synthesis_pass);
        let names = if review.failed_pass_names.is_empty() {
            String::new()
        } else {
            format!(" ({})", review.failed_pass_names.join(", "))
        };
        format!(
            "{failed_passes} of {} review passes failed{names}. {}",
            total.max(failed_passes),
            failure_reason()
        )
    };
    let reason = match review.status.as_str() {
        // Review 8: an override accepts the Builder's pushback on the
        // findings; it does not review the files a failed pass never read.
        "skipped" if review.note.is_some() && failed_passes > 0 => passes_failed(),
        // An override (`note`) is the person's decision on the findings.
        "skipped" if review.note.is_some() => return None,
        // 1.171.0 C3 (owner, 2026-10-27): a review skipped with "Check
        // without the Reviewer" leaves the commit unreviewed — it
        // never merges by itself, and the pull request says so.
        "skipped" => SKIPPED_REVIEW_REASON.to_string(),
        "failed" => failure_reason(),
        // Review 1: a pass that failed after its retry left files unreviewed.
        "done" if failed_passes > 0 => passes_failed(),
        "running" => "the review was still running when the card shipped.".to_string(),
        _ => {
            let read = review.reviewed_revision.clone().or_else(|| {
                b.snapshots
                    .iter()
                    .rev()
                    .find(|s| s.n == review.snapshot_n)
                    .map(|s| s.sha.clone())
            });
            let same_snapshot = last.map_or(true, |s| s.n == review.snapshot_n);
            match read {
                Some(read) if read == shipped_revision && same_snapshot => return None,
                None if same_snapshot => return None,
                _ => "commits were made after its last review.".to_string(),
            }
        }
    };
    // G2 (Challenger round 1): a failure or incomplete reason saved before
    // 1.173.0 names the Reviewer by its old name; GitHub reads the new one.
    Some(format!("Last commit not reviewed by the Reviewer: {}", reviewer_words(&reason)))
}

/// G2 (1.173.0): text saved before the rename — a review's failure or
/// incomplete reason — with the Reviewer's new name; the twin of
/// `words.ts`'s `reviewerWords` (`\bChallenger(s?)\b` → `Reviewer$1`). The
/// saved text is left as it is; lower-case ids (`challenger-reviewing`) are
/// never touched.
pub fn reviewer_words(text: &str) -> String {
    // TX3 round 1 (1.174.0): the menu item's old name in a skipped-review
    // line saved before the rename; the twin of `reviewerWords`.
    let renamed = text
        .replace("Check without the second AI's review", "Check without the Reviewer")
        .replace("Check without the second AI\u{2019}s review", "Check without the Reviewer");
    let text = renamed.as_str();
    const OLD: &str = "Challenger";
    let word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(OLD) {
        let before = rest[..at].chars().next_back().or_else(|| out.chars().next_back());
        let after_at = at + OLD.len();
        let mut end = after_at;
        if rest[after_at..].starts_with('s') {
            end += 1;
        }
        let after = rest[end..].chars().next();
        out.push_str(&rest[..at]);
        if word(before) || word(after) {
            out.push_str(&rest[at..after_at]);
            rest = &rest[after_at..];
        } else {
            out.push_str("Reviewer");
            out.push_str(&rest[after_at..end]);
            rest = &rest[end..];
        }
    }
    out.push_str(rest);
    out
}

/// GH #129: one line for the Ship receipt and PR body when the card ships
/// with a request for changes the Builder never received — its review
/// handed the card to a follow-up that gave no verdict. None otherwise.
pub fn handed_over_ship_summary(card: &KanbanCard) -> Option<String> {
    let request = card.builder.as_ref()?.handed_over.as_ref()?;
    let n = request.snapshot_n;
    Some(match request.finding_ids.len() {
        0 => format!("Shipped with the changes round {n}'s review requested, not re-checked."),
        count => format!(
            "Shipped with {count} open finding{} from round {n}'s review, not re-checked: {}.",
            if count == 1 { "" } else { "s" },
            request.finding_ids.join(", ")
        ),
    })
}

/// What Ship says about the Challenger beyond an override: the #99
/// unreviewed line and the #129 handed-over line, one per line, or None.
/// The receipt keeps it as `shipped_unreviewed`; the PR body gets each
/// line in bold (`pr_body_with_unreviewed`).
pub fn ship_review_lines(card: &KanbanCard, shipped_revision: &str) -> Option<String> {
    let lines: Vec<String> = [
        unreviewed_ship_summary(card, shipped_revision),
        handed_over_ship_summary(card),
    ]
    .into_iter()
    .flatten()
    .collect();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

/// The review panel's Merge refuses an unapproved Builder snapshot unless the
/// member chose "Merge anyway" (`card_review_merge`'s `unreviewed_ok`).
pub const MERGE_UNREVIEWED_REFUSAL: &str =
    "The Reviewer has not approved the last round, so nothing was merged. Choose Merge anyway to bring it in without an approved review.";

/// Tier 4 walk 2026-10-14 (review of PR #375): why the review panel's Merge
/// would land `publish` (the last build snapshot) without an approved
/// review, or None when it may land plainly. Plainly means what Ship treats
/// as reviewed: an approve on that snapshot (Plyloft's reading of a
/// dismissal included) or an override of a request for changes — never a
/// review skipped on purpose (1.171.0 C3, owner 2026-10-27) — and, beyond
/// Ship's #99/#129 lines (`ship_review_lines`), a review that is missing, a
/// standing request for changes or an incomplete verdict on the snapshot.
/// Non-Builder cards: None (no Challenger).
pub fn merge_review_gap(card: &KanbanCard, publish: &str) -> Option<String> {
    let b = card.builder.as_ref()?;
    let last = b.snapshots.last()?;
    let Some(review) = b.review.as_ref() else {
        return Some(format!(
            "Last commit not reviewed by the Reviewer: round {} has no review.",
            last.n
        ));
    };
    if let Some(lines) = ship_review_lines(card, publish) {
        return Some(lines);
    }
    if review.snapshot_n != last.n {
        return Some(format!(
            "Last commit not reviewed by the Reviewer: round {} has no review.",
            last.n
        ));
    }
    if review.status == "done" {
        match review.verdict.as_deref() {
            Some("changes_requested") => {
                return Some(format!(
                    "Shipped with the changes the Reviewer requested on round {}, not fixed.",
                    last.n
                ))
            }
            Some("incomplete") => {
                return Some(format!(
                    "Last commit not reviewed by the Reviewer: the review of round {} is incomplete.",
                    last.n
                ))
            }
            _ => {}
        }
    }
    None
}

/// GH #99 (review 7): keep the ship-time line on the card, so the Ship
/// receipt says what the PR body says even after a later review settles.
pub fn record_shipped_unreviewed(
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    line: Option<&str>,
) {
    let _ = kanban.with_card(workspace_id, card_id, |c| {
        if let Some(b) = c.builder.as_mut() {
            b.shipped_unreviewed = line.map(str::to_string);
            // GH #135 (owner-side review): a card that has shipped owes its
            // Builder nothing. Left standing, an approve would be offered on
            // the Ship step and injected into a later session.
            b.undelivered_verdict = None;
        }
        Ok(())
    });
}

/// GH #99 (review 1): the prefix of the PR body line, so a later Ship to
/// the same PR can replace it.
pub const UNREVIEWED_PR_LINE_PREFIX: &str = "**Last commit not reviewed by the Reviewer:";

/// G2 (1.173.0): the same line as pull requests opened before 1.173.0 carry
/// it, when the Reviewer was called the Challenger — still replaced, never
/// left beside the new one.
pub const LEGACY_UNREVIEWED_PR_LINE_PREFIX: &str = "**Last commit not reviewed by the Challenger:";

/// GH #129: how both forms of the handed-over line read in a PR body
/// ("… from round 5's review, not re-checked: F3." and "… the changes
/// snapshot 5's review requested, not re-checked."), so a later Ship to
/// the same PR can replace it. The follow-up card's line ("Shipped with N
/// open findings: #140") never says it.
const HANDED_OVER_PR_LINE_MARK: &str = ", not re-checked";

/// Tier 4 walk 2026-10-14: `merge_review_gap`'s line for a standing request
/// for changes ("Shipped with the changes the Challenger requested on
/// snapshot 3, not fixed."), which Ship now writes too.
const CHANGES_NOT_FIXED_PR_LINE_MARK: &str = ", not fixed.";

pub(crate) fn is_ship_review_pr_line(line: &str) -> bool {
    let line = line.trim();
    line.starts_with(UNREVIEWED_PR_LINE_PREFIX)
        || line.starts_with(LEGACY_UNREVIEWED_PR_LINE_PREFIX)
        || (line.starts_with("**Shipped with ")
            && (line.contains(HANDED_OVER_PR_LINE_MARK) || line.contains(CHANGES_NOT_FIXED_PR_LINE_MARK)))
}

/// What Ship (and the review panel's Merge) keeps as the card's
/// shipped-unreviewed line and puts in the PR body: Ship's #99/#129 lines,
/// or — Tier 4 walk 2026-10-14, so Ship says what Merge anyway says — why
/// the last snapshot had no approved review (`merge_review_gap`).
/// Challenger round on #378 (P2-2): `follow_up` — Ship with follow-up, the
/// sanctioned way to ship a request for changes, whose own line names the
/// card that carries the open findings — adds no gap line beside it.
///
/// Contract (1.171.0 C3, owner 2026-10-27): `Some` means `publish` ships
/// unreviewed — no review, one that failed, ran, was skipped on purpose
/// ("Check without the Reviewer"), read an older commit, is
/// incomplete, or a request for changes nobody resolved or handed over —
/// so nothing merges it by itself (`ship_auto_merge_guarded`,
/// `pr_merge::resume_due`/`merge_due`) and a batch leaves it out. `None`
/// means approved, or the person's decision on the findings (an override,
/// findings dismissed).
pub fn ship_review_record(card: &KanbanCard, publish: &str, follow_up: bool) -> Option<String> {
    let lines = ship_review_lines(card, publish);
    if follow_up {
        return lines;
    }
    lines.or_else(|| merge_review_gap(card, publish))
}

/// GH #99 (review 1): an existing PR's body with its unreviewed-commit line
/// brought up to date — any earlier line removed, `line` (if any) appended.
/// The rest of the body, human edits included, is kept as it was. GH #129:
/// `line` may hold several lines (`ship_review_lines`), each in bold.
pub fn pr_body_with_unreviewed(body: &str, line: Option<&str>) -> String {
    let kept: Vec<&str> = body.lines().filter(|l| !is_ship_review_pr_line(l)).collect();
    let mut out = kept.join("\n").trim_end().to_string();
    for line in line.into_iter().flat_map(str::lines).filter(|l| !l.trim().is_empty()) {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&format!("**{line}**"));
    }
    out
}

/// GH #99: the revision the card's last *completed* review read — the
/// recorded one, or for reviews stored before GH #99 the current review's
/// own revision (its snapshot's sha) when it completed.
pub fn last_completed_review_revision(card: &KanbanCard) -> Option<String> {
    let b = card.builder.as_ref()?;
    if let Some(revision) = &b.last_reviewed_revision {
        return Some(revision.clone());
    }
    // Review 4: a done review with a pass that failed is not a completed
    // review — the same rule as `record_settled_review`.
    let review = b
        .review
        .as_ref()
        .filter(|r| r.status == "done" && r.failed_passes.unwrap_or(0) == 0)?;
    review.reviewed_revision.clone().or_else(|| {
        b.snapshots
            .iter()
            .rev()
            .find(|s| s.n == review.snapshot_n)
            .map(|s| s.sha.clone())
    })
}

/// GH #99: a Builder card's branch tip and the commits on it since the
/// last completed review, read live from its worktree for Outcome.
pub fn review_tip_facts(card: &KanbanCard, worktree: &Path) -> (Option<String>, Option<u32>) {
    if card.builder.is_none() {
        return (None, None);
    }
    let tip = git_head_sha(worktree).ok();
    let since = commits_between(
        worktree.to_str(),
        last_completed_review_revision(card).as_deref(),
        tip.as_deref(),
    );
    (tip, since)
}

/// E3 / explicit close: kill the PTY and clear the session without
/// marking it lost.
pub fn close(
    app: AppHandle,
    registry: &BuilderRegistry,
    pty_registry: &PtyRegistry,
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
) -> Result<(), String> {
    registry.end_session(pty_registry, card_id);
    kanban.with_card(workspace_id, card_id, |c| {
        apply_close(c);
        Ok(())
    })?;
    crate::kanban::emit_kanban_changed(&app, workspace_id);
    Ok(())
}

/// [`close`]'s write to the card: no session, not lost — and (F11, team
/// walk) a run still recorded as running is not running any more: nobody
/// runs it. Aborted, not Failed: the person stopped it. A card built by
/// both is left alone while its two builds are undecided: its run belongs
/// to the lanes, which this close never touches.
pub(crate) fn apply_close(c: &mut KanbanCard) {
    let Some(b) = c.builder.as_mut() else {
        return;
    };
    let started = b.started_at;
    b.pty_id = None;
    b.session_lost = false;
    b.resume_failed = false;
    abort_running_run(c);
    // 1.169.0 (A3): a retry's session is over: its outcome is recorded.
    crate::retry_on::settle_builder_retry(c, started);
}

/// F11: a single Builder's run recorded as running, once its session is gone,
/// reads Aborted — so nothing (worktree prune, archive, GitHub sync) keeps
/// treating it as work in progress. The card page and the Inbox still say
/// "Session closed" / "Session ended" with Resume
/// (`cardLifecycle.ts::builderSessionClosed`, `inbox.rs::card_session_ended`).
fn abort_running_run(c: &mut KanbanCard) {
    // A run a swarm or an agent run owns is theirs to settle.
    if crate::build_both::is_undecided(c) || c.linked_run_id.is_some() || c.linked_swarm_id.is_some() {
        return;
    }
    if c.last_run_status == Some(LastRunStatus::Running) {
        c.last_run_status = Some(LastRunStatus::Aborted);
    }
}

/// [`session_ended`]'s write to the card, when `pty_id` is still its session.
pub(crate) fn apply_session_ended(c: &mut KanbanCard, pty_id: &str, quick: bool) {
    let Some(b) = c.builder.as_mut() else {
        return;
    };
    if b.pty_id.as_deref() != Some(pty_id) {
        return;
    }
    let started = b.started_at;
    b.pty_id = None;
    b.session_lost = true;
    b.resume_failed = quick;
    abort_running_run(c);
    crate::retry_on::settle_builder_retry(c, started);
}

/// The PTY exited on its own (crash, `/exit`, kill from outside). Mark
/// the session lost so the card offers Resume.
pub fn session_ended(
    app: AppHandle,
    registry: &BuilderRegistry,
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    pty_id: &str,
) -> Result<(), String> {
    let mut output: Option<Vec<u8>> = None;
    match registry.get_pty(card_id) {
        Some(current) if current == pty_id => {
            output = registry.remove(card_id).map(|s| capture_tail(&s.capture));
        }
        // A stale exit for a session we already replaced: ignore.
        Some(_) => return Ok(()),
        None => {}
    }
    // F17: a Resume that ended at once, or (round 3) that Codex said it
    // could not resume, is said as such on the card.
    let quick = resume_failed(registry.take_resumed(card_id, pty_id), now_millis(), output.as_deref());
    kanban.with_card(workspace_id, card_id, |c| {
        apply_session_ended(c, pty_id, quick);
        Ok(())
    })?;
    crate::kanban::emit_kanban_changed(&app, workspace_id);
    Ok(())
}

/// v1.154.1 (F17): a session resumed at `at` that exited by `now` ended at once.
pub(crate) fn resumed_quickly(at: i64, now: i64) -> bool {
    now - at < RESUME_QUICK_EXIT_MS
}

/// Captured output (tail) for xterm replay on (re-)attach, with where it
/// ends in the session's output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureReplay {
    /// The raw bytes, as the live `pty://data` events carry them (no lossy
    /// text decode: a replay cut mid-character joins the next event cleanly).
    pub data: Vec<u8>,
    /// Stream offset just past `data` — the capture's whole length (it is
    /// never trimmed). The terminal subscribes before it reads this, and
    /// drops from its live events the bytes the replay already wrote
    /// (`PtyDataEvent::offset`, `src/lib/builderAttach.ts`).
    pub end: u64,
}

impl CaptureReplay {
    /// The IPC body `builderReadCapture` decodes: `end` as 8 bytes little-
    /// endian, then `data`. `None` (no live session) is an empty body.
    pub fn encode(replay: Option<CaptureReplay>) -> Vec<u8> {
        let Some(replay) = replay else { return Vec::new() };
        let mut body = Vec::with_capacity(8 + replay.data.len());
        body.extend_from_slice(&replay.end.to_le_bytes());
        body.extend_from_slice(&replay.data);
        body
    }
}

pub fn read_capture(registry: &BuilderRegistry, card_id: &str) -> Option<CaptureReplay> {
    let buf = registry.capture(card_id)?;
    let bytes = buf.lock();
    let start = bytes.len().saturating_sub(CAPTURE_REPLAY_MAX);
    Some(CaptureReplay {
        data: bytes[start..].to_vec(),
        end: bytes.len() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review_passes::ReviewKind;

    // ── v1.154.1 (walk G1): the CLI's folder-trust question ──────────

    /// Claude Code 2.1's trust screen in a new card worktree, as the walk of
    /// 2026-09-29 saw it (SL-4 B), with the colour and cursor codes a TUI
    /// writes around it.
    const CLAUDE_TRUST: &str = "\x1b[?25l\x1b[2J\x1b[H\x1b[1mAccessing workspace:\x1b[22m\r\n\r\n \
        /Users/o/sandbox/.atelier-worktrees/card-mumi0qjo-0\r\n\r\n \
        Quick safety check: Is this a project you created or one you trust? (Like your own code, a \
        well-known open source project, or work from your team). If not, take a moment to review \
        what's in this folder first.\r\n\r\n Claude Code'll be able to read, edit, and execute files \
        here.\r\n\r\n \x1b[2mSecurity guide\x1b[22m\r\n\r\n \x1b[36m\u{276f} 1. Yes, I trust this \
        folder\x1b[39m\r\n   2. No, exit\r\n\r\n \x1b[2mEnter to confirm \u{b7} Esc to cancel\x1b[22m\r\n";

    /// What Claude draws once it has its answer: its header, the brief as
    /// the first prompt, a turn under way.
    const CLAUDE_AFTER: &str = "\x1b[2J\x1b[H\x1b[38;5;174m\u{273b}\x1b[39m Welcome to Claude Code!\r\n\r\n  \
        cwd: /Users/o/sandbox/.atelier-worktrees/card-mumi0qjo-0\r\n\r\n> You are the Builder for the \
        card \"Add a nod function\".\r\n\r\n\x1b[38;5;174m\u{2736}\x1b[39m Thinking\u{2026} (esc to interrupt)\r\n";

    /// Codex 0.15x's trust screen.
    const CODEX_TRUST: &str = "\x1b[1m> You are in /Users/o/sandbox/.atelier-worktrees/card-x-0-b\x1b[0m\r\n\r\n  \
        Do you trust the contents of this directory? Working with untrusted contents comes with \
        higher risk of prompt injection.\r\n\r\n\x1b[36m\u{203a} 1. Yes, continue\x1b[39m\r\n  2. No, \
        quit\r\n\r\n  Press enter to continue\r\n";

    #[test]
    fn a_session_stopped_at_claudes_trust_question_is_seen() {
        assert!(trust_question_pending(CLAUDE_TRUST.as_bytes()));
        // After the start-up noise of any length.
        let noisy = format!("{}{}", "\x1b[?2004h".repeat(50), CLAUDE_TRUST);
        assert!(trust_question_pending(noisy.as_bytes()));
        // Redrawn when the choice moves: the last screen decides.
        let moved = CLAUDE_TRUST.replace("\u{276f} 1.", "  1.").replace("   2. No", " \u{276f} 2. No");
        assert!(trust_question_pending(format!("{CLAUDE_TRUST}{moved}").as_bytes()));
    }

    /// The screen in the order the walk recorded it (SL-4 B, 2026-09-29):
    /// "❯ No, exit" first, then "Yes, I trust this folder", then the keys.
    #[test]
    fn the_recorded_order_no_first_is_the_question() {
        let recorded = "Accessing workspace:\r\n\r\n /Users/o/sandbox/.atelier-worktrees/card-mumi25ob-1\r\n\r\n \
            Quick safety check: Is this a project you created or one you trust?\r\n\r\n \
            \x1b[36m\u{276f} No, exit\x1b[39m\r\n   Yes, I trust this folder\r\n\r\n \
            \x1b[2mEnter to confirm \u{b7} Esc to cancel\x1b[22m\r\n";
        assert!(trust_question_pending(recorded.as_bytes()));
        // Answered: Claude's own screen follows.
        assert!(!trust_question_pending(format!("{recorded}{CLAUDE_AFTER}").as_bytes()));
    }

    #[test]
    fn spaces_drawn_as_cursor_moves_still_read_as_the_question() {
        let moved = CLAUDE_TRUST.replace("Yes, I trust this folder", "Yes,\x1b[1CI\x1b[1Ctrust\x1b[1Cthis\x1b[1Cfolder");
        assert!(trust_question_pending(moved.as_bytes()));
        // The older wording.
        assert!(trust_question_pending(
            b"\x1b[1mDo you trust the files in this folder?\x1b[0m\r\n\r\n/tmp/wt\r\n\r\n\xe2\x9d\xaf 1. Yes, proceed\r\n  2. No, exit\r\n\r\n Enter to confirm \xc2\xb7 Esc to exit\r\n"
        ));
    }

    #[test]
    fn an_answered_trust_question_is_not_pending() {
        assert!(!trust_question_pending(format!("{CLAUDE_TRUST}{CLAUDE_AFTER}").as_bytes()));
        // A long turn after it, whatever its words.
        let long = format!("{CLAUDE_TRUST}\x1b[2J{}", "Reading greet.js and writing nod().\r\n".repeat(40));
        assert!(!trust_question_pending(long.as_bytes()));
        // The Builder's idle prompt after it.
        let idle = format!("{CLAUDE_TRUST}\x1b[2J> \r\n  ? for shortcuts\r\n");
        assert!(!trust_question_pending(idle.as_bytes()));
    }

    #[test]
    fn codexs_trust_question_is_seen_and_left_once_answered() {
        assert!(trust_question_pending(CODEX_TRUST.as_bytes()));
        assert!(trust_question_pending(
            b"Since this folder is version controlled, you may wish to allow Codex to work in this folder without asking for approval.\r\n\r\n\xe2\x80\xba 1. Yes, allow Codex to work in this folder without asking for approval\r\n  2. No, ask me to approve edits and commands\r\n\r\n  Press enter to continue\r\n"
        ));
        let after = format!("{CODEX_TRUST}\x1b[2J>_ OpenAI Codex (v0.154.0)\r\n\r\n\u{2022} Working (3s \u{2022} esc to interrupt)\r\n");
        assert!(!trust_question_pending(after.as_bytes()));
    }

    /// Codex 0.158's trust screen, as the walk R4 recorded it (J3): the
    /// Inbox said Codex was waiting while its tab read "Working".
    const CODEX_158_TRUST: &str = "\x1b[1mFolder access\x1b[22m\r\n\x1b[2m/Users/o/Library/Application \
        Support/sandboxes/app/.atelier-worktrees/card-x-0-b\x1b[22m\r\n\r\n\x1b[1mTrust this folder?\x1b[22m \
        Codex can read, edit, and run files here, subject to your permission settings. Folder settings \
        can run code automatically, even without a model request. Continue only if you trust these \
        files. Your trust decision will be saved.\r\n\r\n\x1b[36m\u{203a} 1. Trust and continue\x1b[39m\r\n  \
        2. Quit\r\n\r\n  \x1b[2menter\x1b[22m continue \u{b7} \x1b[2mesc\x1b[22m quit\r\n";

    #[test]
    fn codex_158s_trust_question_is_seen_and_left_once_answered() {
        assert!(trust_question_pending(CODEX_158_TRUST.as_bytes()));
        // Cursor moves instead of spaces.
        let moved = CODEX_158_TRUST.replace("Trust and continue", "Trust\x1b[1Cand\x1b[1Ccontinue");
        assert!(trust_question_pending(moved.as_bytes()));
        // Answered: Codex draws its own screen and starts on the brief.
        let after = format!(
            "{CODEX_158_TRUST}\x1b[2J>_ OpenAI Codex (v0.158.0)\r\n\r\n\u{2022} Working (3s \u{2022} esc to interrupt)\r\n"
        );
        assert!(!trust_question_pending(after.as_bytes()));
        // The words alone, without the way out and the key hint, are text.
        assert!(!trust_question_pending(b"+ // 1. Trust and continue\r\n"));
        assert!(!trust_question_pending(b"Trust this folder? Codex can read it. 2. Quit\r\n"));
    }

    /// Codex 0.171's trust screen, as a Terminals tile drew it (1.176.2,
    /// walk 2026-11-22): the way out is now "Back to Agent Command Center"
    /// and the hint "enter continue · esc back". The tile read "Your turn"
    /// and the quit sheet left it out.
    const CODEX_171_TRUST: &str = "\x1b[1mFolder access\x1b[22m\r\n\x1b[2m/Users/o/Library/Application \
        Support/sandboxes/2026-11-22-first-ten/my-site\x1b[22m\r\n\r\n\x1b[1mTrust this folder?\x1b[22m \
        Codex can read, edit, and run files here, subject to your permission settings. Folder settings \
        can run code automatically, even without a model request. Continue only if you trust these \
        files. Your trust decision will be saved.\r\n\r\n\x1b[36m\u{203a} 1. Trust and continue\x1b[39m\r\n  \
        2. Back to Agent Command Center\r\n\r\n  \x1b[1menter\x1b[22m \x1b[2mcontinue\x1b[22m \u{b7} \
        \x1b[1mesc\x1b[22m \x1b[2mback\x1b[22m\r\n";

    #[test]
    fn codex_171s_trust_question_is_seen_and_left_once_answered() {
        assert!(trust_question_pending(CODEX_171_TRUST.as_bytes()));
        let moved = CODEX_171_TRUST.replace("Back to Agent", "Back\x1b[1Cto\x1b[1CAgent");
        assert!(trust_question_pending(moved.as_bytes()));
        let after = format!(
            "{CODEX_171_TRUST}\x1b[2J>_ OpenAI Codex (v0.171.0)\r\n\r\n\u{2022} Working (3s \u{2022} esc to interrupt)\r\n"
        );
        assert!(!trust_question_pending(after.as_bytes()));
        // Still the question's words only: no key hint, or no way out, is text.
        assert!(!trust_question_pending(b"Trust this folder? Codex can read it. 2. Back to Agent Command Center\r\n"));
        assert!(!trust_question_pending(b"+ // 1. Trust and continue\r\n  enter continue\r\n"));
        // 0.158's wording is still seen.
        assert!(trust_question_pending(CODEX_158_TRUST.as_bytes()));
    }

    /// 1.169.1 (R4): the prompt walk R2 recorded in a card's copy, where
    /// Codex adds that the trust goes to the repository root. It is the
    /// question, and stops being one once Codex starts on the brief.
    #[test]
    fn codex_s_trust_question_in_a_card_copy_is_seen() {
        let recorded = "\x1b[1mFolder access\x1b[22m\r\n\x1b[2m/Users/o/sandboxes/delivery-walk-2/.plyloft-worktrees/gh-issue-107\x1b[22m\r\n\r\n\
            Note: You\u{2019}re in a subdirectory of a Git project. Trusting will apply to the repository root:\r\n\
            /Users/o/sandboxes/delivery-walk-2\r\n\r\n\x1b[1mTrust this folder?\x1b[22m Codex can read, edit, and run files \
            here, subject to your permission settings. Folder settings can run code automatically, even without a model \
            request. Continue only if you trust these files. Your trust decision will be saved.\r\n\r\n\
            \x1b[36m\u{203a} 1. Trust and continue\x1b[39m\r\n  2. Quit\r\n\r\n  \x1b[2menter\x1b[22m continue \u{b7} \x1b[2mesc\x1b[22m quit\r\n";
        assert!(trust_question_pending(recorded.as_bytes()));
        let after = format!("{recorded}\x1b[2J>_ OpenAI Codex (v0.164.0)\r\n\r\n\u{2022} Working (1s \u{2022} esc to interrupt)\r\n");
        assert!(!trust_question_pending(after.as_bytes()));
    }

    #[test]
    fn a_session_without_the_question_is_not_pending() {
        assert!(!trust_question_pending(b""));
        assert!(!trust_question_pending(CLAUDE_AFTER.as_bytes()));
        // "trust" in the Builder's own words is not the question.
        assert!(!trust_question_pending(b"I trust this folder's tests; running npm test now.\r\n"));
        // Nor the question's words in a diff or a file, with nothing after.
        assert!(!trust_question_pending(b"+  const label = \"Yes, I trust this folder\";\r\n"));
        assert!(!trust_question_pending(
            b"  12 +// Do you trust the contents of this directory? 1. Yes, continue\r\n"
        ));
        // A way out but no key hint, or a key hint but no way out: not it.
        assert!(!trust_question_pending(b"+ Yes, I trust this folder / No, exit\r\n"));
        assert!(!trust_question_pending(b"+ Yes, I trust this folder -- Enter to confirm\r\n"));
        // A cut escape sequence at the end does not panic.
        assert!(!trust_question_pending(b"\x1b[38;5"));
        assert!(!trust_question_pending(b"\x1b]0;title"));
    }

    /// Claude Code 2.1.287's first screen in a trusted folder, as the N14
    /// walk's intake transcript recorded it: banner, the empty input with its
    /// placeholder, and the mode line.
    const CLAUDE_REPL_IDLE: &str = " \x1b[38;5;174m\u{2590}\u{259b}\u{2588}\u{2588}\u{2588}\u{259c}\u{258c}\x1b[39m \
        \x1b[1mClaude Code\x1b[22m v2.1.287\r\n\u{259d}\u{259c}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{259b}\u{2598} \
        Opus 5.5 (1M context) \u{b7} Claude Max\r\n  ~/sandboxes/2026-10-02-gates/beta\r\n\r\n\
        \u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\r\n\
        \u{276f}\u{a0}\x1b[2mTry \"write a test for <filepath>\"\x1b[22m\r\n\
        \u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\r\n  \
        \x1b[38;5;211m\u{23f5}\u{23f5} auto mode on\x1b[39m\x1b[2m (shift+tab to cycle)\x1b[22m\r\n";

    /// N14 walk F10: the intake types its first prompt only once Claude's
    /// REPL is ready — never into the folder-trust question.
    #[test]
    fn claudes_repl_is_ready_only_past_the_trust_question() {
        // A trusted folder: the REPL straight away.
        assert!(claude_repl_ready(CLAUDE_REPL_IDLE.as_bytes()));
        // The pre-2.1 footer alone.
        assert!(claude_repl_ready(b"\x1b[2J> \r\n  ? for shortcuts\r\n"));
        // Nothing drawn yet, or only the banner: not yet.
        assert!(!claude_repl_ready(b""));
        assert!(!claude_repl_ready(b"\x1b[?2004h\x1b[?25l"));
        assert!(!claude_repl_ready(" \x1b[1mClaude Code\x1b[22m v2.1.287\r\n".as_bytes()));
        // At the trust question, in either order of its choices.
        assert!(!claude_repl_ready(CLAUDE_TRUST.as_bytes()));
        let recorded = "Accessing workspace:\r\n\r\n /Users/o/beta\r\n\r\n \
            Quick safety check: Is this a project you created or one you trust?\r\n\r\n \
            \x1b[36m\u{276f} No, exit\x1b[39m\r\n   Yes, I trust this folder\r\n\r\n \
            \x1b[2mEnter to confirm \u{b7} Esc to cancel\x1b[22m\r\n";
        assert!(!claude_repl_ready(recorded.as_bytes()));
        // Answered Yes: the REPL draws after it.
        assert!(claude_repl_ready(format!("{recorded}\x1b[2J\x1b[H{CLAUDE_REPL_IDLE}").as_bytes()));
        // Answered, but the REPL is not drawn yet: still not ready.
        assert!(!claude_repl_ready(format!("{recorded}\x1b[2J\x1b[H").as_bytes()));
        // A ready marker before the question does not count past it.
        assert!(!claude_repl_ready(format!("? for shortcuts\r\n{recorded}").as_bytes()));
    }

    #[test]
    fn the_registry_names_every_session_at_the_question_card_and_lanes() {
        let registry = BuilderRegistry::default();
        registry.insert_for_test("card-a", "pty-a", "claude");
        registry.insert_for_test("card-b#both-b", "pty-b", "codex");
        registry.insert_for_test("card-c", "pty-c", "claude");
        registry.capture("card-a").unwrap().lock().extend_from_slice(CLAUDE_TRUST.as_bytes());
        registry.capture("card-b#both-b").unwrap().lock().extend_from_slice(CODEX_TRUST.as_bytes());
        registry
            .capture("card-c")
            .unwrap()
            .lock()
            .extend_from_slice(format!("{CLAUDE_TRUST}{CLAUDE_AFTER}").as_bytes());
        let trust = |key: &str, vendor: &str| SessionBlock {
            key: key.into(),
            workspace_id: "ws".into(),
            vendor: vendor.into(),
            intake: false,
            kind: SessionBlockKind::Trust,
            resets_at: None,
        };
        assert_eq!(registry.session_blocks(), vec![trust("card-a", "claude"), trust("card-b#both-b", "codex")]);
        // Only the capture's tail is read: a question long scrolled away is not.
        registry
            .capture("card-a")
            .unwrap()
            .lock()
            .extend_from_slice(&vec![b'x'; TRUST_SCAN_BYTES]);
        assert_eq!(registry.session_blocks().len(), 1);
    }

    // ── UX P-F (UX P1 point 8): usage limits and the bypass warning ──────

    /// Claude's usage-limit menu as `chat_tests.rs` records it drawn: cursor
    /// placed rows after a clear.
    const LIMIT_MENU: &str = "\x1b[2J\x1b[H\x1b[1;1H  You've hit your limit \u{b7} resets 3pm\x1b[3;1H  \u{276f} 1. Stop and wait for limit to reset\x1b[4;1H    2. Upgrade your plan";
    /// The pre-start wording `claude_session.rs` holds (no reset time).
    const LIMIT_MENU_PLAIN: &str = "Claude usage limit reached.\r\n What do you want to do?\r\n \u{276f} 1. Stop and wait for limit to reset\r\n   2. Upgrade your plan\r\n";
    /// Claude's warning before its first session in Bypass Permissions mode.
    const BYPASS_WARNING: &str = "\x1b[2J\x1b[H WARNING: Claude Code running in Bypass Permissions mode\r\n\r\n In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.\r\n\r\n \u{276f} 1. No, exit\r\n   2. Yes, I accept\r\n\r\n Enter to confirm \u{b7} Esc to exit\r\n";
    /// Claude's composer and footer, drawn below the conversation.
    const COMPOSER: &str = "\r\n\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\r\n\u{276f} \r\n\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\r\n  ? for shortcuts\r\n";

    #[test]
    fn claudes_limit_menu_and_bypass_warning_are_read_when_drawn_last() {
        assert_eq!(
            session_menu_block(LIMIT_MENU.as_bytes()),
            Some((SessionBlockKind::UsageLimit, Some("3pm".into())))
        );
        assert_eq!(session_menu_block(LIMIT_MENU_PLAIN.as_bytes()), Some((SessionBlockKind::UsageLimit, None)));
        assert_eq!(session_menu_block(BYPASS_WARNING.as_bytes()), Some((SessionBlockKind::Bypass, None)));
        // A menu answered: Claude draws its welcome, a turn, its composer.
        for menu in [LIMIT_MENU, BYPASS_WARNING] {
            assert_eq!(session_menu_block(format!("{menu}{CLAUDE_AFTER}").as_bytes()), None);
            assert_eq!(session_menu_block(format!("{menu}{COMPOSER}").as_bytes()), None);
        }
        // Only the last screen counts: an older menu, then a working turn.
        let worked = format!("{LIMIT_MENU}\x1b[2J\x1b[H\u{2736} Thinking\u{2026} (esc to interrupt)");
        assert_eq!(session_menu_block(worked.as_bytes()), None);
    }

    /// (Challenger) The false positives the spec lists for the screen rule.
    #[test]
    fn the_limit_words_on_screen_without_the_menu_are_no_block() {
        // The Builder cats a file whose first line is the limit line.
        let cat = format!("\u{23fa} Read(README.md)\r\n  \u{23bf} You've hit your limit \u{b7} resets 3pm\r\n     Claude usage limit reached\r\n\u{23fa} The README starts with a quote.{COMPOSER}");
        assert_eq!(session_menu_block(cat.as_bytes()), None);
        // The file holds the whole menu and is the last thing printed: its
        // rows are there, but the composer is drawn below them.
        let cat_menu = format!("\u{23fa} Bash(cat docs/limit.txt)\r\n  \u{23bf} {LIMIT_MENU_PLAIN}{COMPOSER}");
        assert_eq!(session_menu_block(cat_menu.as_bytes()), None);
        // The person types the words into the composer (and sends them).
        let typed = format!("\u{2500}\u{2500}\u{2500}\u{2500}\r\n\u{276f} Claude usage limit reached\r\n\u{2500}\u{2500}\u{2500}\u{2500}\r\n");
        assert_eq!(session_menu_block(typed.as_bytes()), None);
        let sent = format!("\u{276f} Claude usage limit reached. Stop and wait for limit to reset or upgrade your plan?\r\n\r\n\u{273b} Thinking\u{2026} (esc to interrupt){COMPOSER}");
        assert_eq!(session_menu_block(sent.as_bytes()), None);
        // The Builder's answer quotes the menu, above its composer.
        let quoted = format!("\u{23fa} When Claude stops it shows:\r\n{LIMIT_MENU_PLAIN}{BYPASS_WARNING}\r\n  Choose 1 to wait.{COMPOSER}");
        assert_eq!(session_menu_block(quoted.as_bytes()), None);
        // The mode named without its menu.
        assert_eq!(session_menu_block("\u{276f} explain Bypass Permissions mode\r\n".as_bytes()), None);
    }

    /// A ConPTY-style frame (erase runs `ESC[<n>X` and cursor moves for
    /// spaces) reads the same once squashed. Synthesized, not a recording:
    /// the Windows menu rules stay off until the VM's fixtures pass
    /// ([`MENU_RULES_ON_WINDOWS`]).
    #[test]
    fn a_conpty_style_frame_reads_the_same_and_windows_waits_for_its_fixtures() {
        let conpty = "\x1b[?25l\x1b[1;1H\x1b[K\x1b[2CYou've\x1b[1Chit\x1b[1Cyour\x1b[1Climit\x1b[1C\u{b7}\x1b[1Cresets\x1b[1C3pm\x1b[80X\r\n\x1b[2C\u{276f}\x1b[1C1.\x1b[1CStop\x1b[1Cand\x1b[1Cwait\x1b[1Cfor\x1b[1Climit\x1b[1Cto\x1b[1Creset\x1b[40X\r\n\x1b[4C2.\x1b[1CUpgrade\x1b[1Cyour\x1b[1Cplan\x1b[60X\r\n\x1b[?25h";
        assert_eq!(session_menu_block(conpty.as_bytes()).map(|b| b.0), Some(SessionBlockKind::UsageLimit));
        assert!(!MENU_RULES_ON_WINDOWS, "turn on only with recorded Windows fixtures");
        assert_eq!(menu_rules_apply(), !cfg!(windows));
    }

    #[test]
    fn the_reset_time_is_read_as_claude_wrote_it() {
        assert_eq!(resets_at_of("You've hit your limit \u{b7} resets 3pm").as_deref(), Some("3pm"));
        assert_eq!(resets_at_of("5-hour limit reached \u{2219} resets 3:30pm (Europe/Rome)").as_deref(), Some("3:30pm (Europe/Rome)"));
        assert_eq!(resets_at_of("Claude usage limit reached. Your limit will reset at 11pm.").as_deref(), Some("11pm"));
        assert_eq!(resets_at_of("You've hit your limit \u{b7} resets 3pm \u{b7} /upgrade to increase").as_deref(), Some("3pm"));
        // (Challenger) Recorded, Claude Code 2.1.283; and a weekly reset on
        // another day.
        assert_eq!(resets_at_of("You've hit your weekly limit \u{b7} resets 1pm (Europe/Rome)").as_deref(), Some("1pm (Europe/Rome)"));
        assert_eq!(resets_at_of("Weekly limit reached \u{2219} resets Oct 21, 1pm (Europe/Rome)").as_deref(), Some("Oct 21, 1pm (Europe/Rome)"));
        assert_eq!(resets_at_of("You've hit your limit \u{b7} resets Mon 9am").as_deref(), Some("Mon 9am"));
        assert_eq!(resets_at_of("the plan resets monthly"), None);
        // No time written, or not a time: none (no guessing).
        assert_eq!(resets_at_of("Claude AI usage limit reached|1760000000"), None);
        assert_eq!(resets_at_of("Claude usage limit reached."), None);
        assert_eq!(resets_at_of("the counter resets when you log in again"), None);
    }

    fn api_error(text: &str) -> serde_json::Value {
        serde_json::json!({"type": "assistant", "isApiErrorMessage": true, "uuid": "e1",
            "message": {"id": "e", "model": "<synthetic>", "role": "assistant", "content": [{"type": "text", "text": text}], "stop_reason": "stop_sequence"}})
    }
    fn said(role: &str, text: &str) -> serde_json::Value {
        serde_json::json!({"type": role, "uuid": format!("{role}-{text}"), "message": {"role": role, "content": [{"type": "text", "text": text}]}})
    }
    fn jsonl(entries: &[serde_json::Value]) -> String {
        entries.iter().map(|e| format!("{e}\n")).collect()
    }

    /// (Challenger) The transcript rule: Claude's own API error entry is the
    /// one source no file, tool output or typing can fake.
    #[test]
    fn a_limit_is_the_transcripts_last_entry_an_api_error_with_nothing_sent_after() {
        let limited = jsonl(&[said("user", "build it"), said("assistant", "On it."), api_error("You've hit your limit \u{b7} resets 3pm")]);
        assert_eq!(transcript_usage_limit(&limited, false), Some(Some("3pm".into())));
        // (Challenger) The old wording gives its reset only as a Unix time:
        // said in this computer's zone, as Claude's screen says it.
        let old_words = jsonl(&[said("user", "go"), api_error("Claude AI usage limit reached|1760000000")]);
        let local = local_reset_time(1_760_000_000, chrono::Local::now());
        assert!(local.is_some());
        assert_eq!(transcript_usage_limit(&old_words, false), Some(local));
        let no_time = jsonl(&[said("user", "go"), api_error("Claude usage limit reached.")]);
        assert_eq!(transcript_usage_limit(&no_time, false), Some(None));
        // Entries Claude writes after it that nobody sent keep it.
        let mut meta = said("user", "<local-command-caveat>…</local-command-caveat>");
        meta["isMeta"] = serde_json::json!(true);
        let after = format!("{limited}{}\n{}\n", serde_json::json!({"type": "system", "subtype": "turn_duration"}), meta);
        assert_eq!(transcript_usage_limit(&after, false), Some(Some("3pm".into())));
        // The person sent anything after it: cleared.
        let continued = format!("{limited}{}", jsonl(&[said("user", "continue")]));
        assert_eq!(transcript_usage_limit(&continued, false), None);
        // Another API error is not a limit.
        assert_eq!(transcript_usage_limit(&jsonl(&[api_error("API Error: 500 Internal server error")]), false), None);
        // A tail cut mid-line skips the half line, and still reads the end.
        let cut = format!("lf\": 1}}\n{limited}");
        assert_eq!(transcript_usage_limit(&cut, true), Some(Some("3pm".into())));
    }

    /// (Challenger, P-F) The entry Claude Code 2.1.283 wrote for a real
    /// weekly limit (its keys and values as recorded, ids shortened): the
    /// words "hit your weekly limit" are not "hit your limit", and Claude
    /// marks it itself (`quotaLimits.status: "rejected"`).
    #[test]
    fn a_recorded_weekly_limit_is_a_limit_and_other_api_errors_are_not() {
        let weekly = serde_json::json!({"parentUuid": "p", "isSidechain": false, "type": "assistant", "uuid": "u",
            "message": {"id": "m", "model": "<synthetic>", "role": "assistant", "stop_reason": "stop_sequence", "type": "message",
                "content": [{"type": "text", "text": "You've hit your weekly limit \u{b7} resets 1pm (Europe/Rome)"}]},
            "quotaLimits": {"status": "rejected", "resetsAt": 1790593200, "unifiedRateLimitFallbackAvailable": false,
                "rateLimitType": "seven_day", "overageStatus": "rejected", "isUsingOverage": false},
            "error": "rate_limit", "isApiErrorMessage": true, "apiErrorStatus": 429, "version": "2.1.283"});
        let limited = jsonl(&[said("user", "build it"), weekly.clone()]);
        assert_eq!(transcript_usage_limit(&limited, false), Some(Some("1pm (Europe/Rome)".into())));
        // Marked by Claude, in words Plyloft has never seen: still a limit,
        // its reset from `quotaLimits.resetsAt`.
        let mut reworded = weekly.clone();
        reworded["message"]["content"][0]["text"] = serde_json::json!("Plan paused");
        let reset = local_reset_time(1_790_593_200, chrono::Local::now());
        assert_eq!(transcript_usage_limit(&jsonl(&[reworded]), false), Some(reset));
        // API errors that are not the plan's limit, recorded or as Claude
        // words them: none says "Usage limit reached".
        for text in [
            "API Error: Connection refused \u{2014} a firewall or proxy may be blocking it (ECONNREFUSED)",
            "API Error: an image in the conversation could not be processed and was removed.",
            "API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}",
            "API Error: 500 {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Internal server error\"}}",
            "API Error: Request rejected (429) \u{b7} this may be a temporary capacity issue",
            "Context limit reached \u{b7} /compact or /clear to continue",
            "API Error: Claude's response exceeded the 32000 output token maximum.",
            "Prompt is too long",
        ] {
            assert!(!says_usage_limit(text), "{text}");
            assert_eq!(transcript_usage_limit(&jsonl(&[api_error(text)]), false), None, "{text}");
        }
        for text in [
            "You've hit your limit \u{b7} resets 3pm",
            "You've hit your weekly limit \u{b7} resets 1pm (Europe/Rome)",
            "You've hit your Opus limit \u{b7} resets Oct 21, 9am",
            "5-hour limit reached \u{2219} resets 3pm",
            "Claude AI usage limit reached|1760000000",
        ] {
            assert!(says_usage_limit(text), "{text}");
        }
    }

    #[test]
    fn a_reset_given_as_a_unix_time_reads_as_claudes_screen() {
        use chrono::TimeZone;
        let now = chrono::Local.with_ymd_and_hms(2026, 10, 18, 9, 0, 0).single().unwrap();
        let at = |h, m| chrono::Local.with_ymd_and_hms(2026, 10, 18, h, m, 0).single().unwrap().timestamp();
        assert_eq!(local_reset_time(at(15, 0), now).as_deref(), Some("3pm"));
        assert_eq!(local_reset_time(at(15, 30), now).as_deref(), Some("3:30pm"));
        assert_eq!(local_reset_time(at(0, 5), now).as_deref(), Some("12:05am"));
        let later = chrono::Local.with_ymd_and_hms(2026, 10, 21, 13, 0, 0).single().unwrap().timestamp();
        assert_eq!(local_reset_time(later, now).as_deref(), Some("Oct 21, 1pm"));
    }

    /// (Challenger) The false positives the spec lists for the transcript.
    #[test]
    fn the_limit_words_in_the_conversation_are_no_limit() {
        // The Builder cats a file whose first line is the limit line.
        let read = serde_json::json!({"type": "user", "toolUseResult": {}, "message": {"role": "user",
            "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "You've hit your limit \u{b7} resets 3pm"}]}});
        let cat = jsonl(&[said("user", "read the README"), read.clone()]);
        assert_eq!(transcript_usage_limit(&cat, false), None);
        let answered = jsonl(&[read, said("assistant", "It starts: You've hit your limit \u{b7} resets 3pm")]);
        assert_eq!(transcript_usage_limit(&answered, false), None);
        // The person types the words and sends them.
        assert_eq!(transcript_usage_limit(&jsonl(&[said("user", "Claude usage limit reached")]), false), None);
        // The Builder quotes the menu in its answer.
        let quoted = jsonl(&[said("assistant", "Claude usage limit reached. ❯ 1. Stop and wait for limit to reset 2. Upgrade your plan")]);
        assert_eq!(transcript_usage_limit(&quoted, false), None);
        // A side chain's (a subagent's) limit is not the Builder's turn.
        let mut side = api_error("usage limit reached");
        side["isSidechain"] = serde_json::json!(true);
        assert_eq!(transcript_usage_limit(&jsonl(&[said("assistant", "done"), side]), false), None);
    }

    /// (Challenger) A Challenger's session in the same folder ends on a
    /// limit: the Builder's card does not say it — its own file is read, by
    /// its `--session-id`.
    #[test]
    fn only_the_builders_own_transcript_is_read() {
        let config = tempfile::tempdir().unwrap();
        let folder = config.path().join("projects").join("-Users-o-sandbox-card-x");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("challenger-1.jsonl"), jsonl(&[said("user", "review"), api_error("usage limit reached")])).unwrap();
        std::fs::write(folder.join("builder-1.jsonl"), jsonl(&[said("user", "build"), said("assistant", "Done.")])).unwrap();
        let cache = Mutex::new(TranscriptRead::default());
        assert_eq!(builder_transcript_limit(config.path(), "builder-1", &cache), None);
        assert_eq!(cache.lock().path.as_deref(), Some(folder.join("builder-1.jsonl").as_path()));
        // No transcript of its own yet: none.
        let not_yet = Mutex::default();
        assert_eq!(builder_transcript_limit(config.path(), "builder-2", &not_yet), None);
        // (Challenger) A file not written yet is looked for again only every
        // ten seconds, not on every 2 s scan of every Builder.
        std::fs::write(folder.join("builder-2.jsonl"), jsonl(&[said("user", "b"), api_error("usage limit reached")])).unwrap();
        assert_eq!(builder_transcript_limit(config.path(), "builder-2", &not_yet), None);
        not_yet.lock().searched_at = Some(std::time::Instant::now() - TRANSCRIPT_SEARCH_EVERY);
        assert_eq!(builder_transcript_limit(config.path(), "builder-2", &not_yet), Some(None));
        assert!(not_yet.lock().seen.is_some(), "the read is remembered with the file's length and time");
        // Its own file ends on the limit (the cache is used: no folder walk).
        std::fs::write(folder.join("builder-1.jsonl"), jsonl(&[said("user", "build"), api_error("You've hit your limit \u{b7} resets 3pm")])).unwrap();
        assert_eq!(builder_transcript_limit(config.path(), "builder-1", &cache), Some(Some("3pm".into())));
        // Only its end is read.
        let mut long = jsonl(&[api_error("usage limit reached")]);
        long.push_str(&jsonl(&[said("user", &"x".repeat(TRANSCRIPT_TAIL_BYTES as usize)), said("assistant", "ok")]));
        std::fs::write(folder.join("builder-1.jsonl"), long).unwrap();
        assert_eq!(builder_transcript_limit(config.path(), "builder-1", &cache), None);
    }

    #[test]
    fn the_registry_says_each_kind_once_trust_first() {
        let dir = tempfile::tempdir().unwrap();
        let transcript = dir.path().join("b.jsonl");
        std::fs::write(&transcript, jsonl(&[said("user", "go"), api_error("You've hit your limit \u{b7} resets 3pm")])).unwrap();
        let registry = BuilderRegistry::default();
        registry.insert_claude_for_test("pf-mid", "b", Some(transcript.clone()));
        registry.insert_claude_for_test("pf-trust", "t", Some(transcript.clone()));
        registry.insert_for_test("pf-bypass", "pty-x", "claude");
        registry.insert_for_test("pf-codex", "pty-c", "codex");
        registry.insert_for_test("pf-none#both-a", "pty-n", "claude");
        registry.capture("pf-trust").unwrap().lock().extend_from_slice(CLAUDE_TRUST.as_bytes());
        registry.capture("pf-bypass").unwrap().lock().extend_from_slice(BYPASS_WARNING.as_bytes());
        // Codex is not read for Claude's menu (no recorded Codex limit screen).
        registry.capture("pf-codex").unwrap().lock().extend_from_slice(LIMIT_MENU.as_bytes());
        let kinds: Vec<(String, SessionBlockKind, Option<String>)> =
            registry.session_blocks().into_iter().map(|b| (b.key, b.kind, b.resets_at)).collect();
        let mut want = vec![
            ("pf-mid".to_string(), SessionBlockKind::UsageLimit, Some("3pm".to_string())),
            ("pf-trust".to_string(), SessionBlockKind::Trust, None),
        ];
        if menu_rules_apply() {
            want.insert(0, ("pf-bypass".to_string(), SessionBlockKind::Bypass, None));
        }
        assert_eq!(kinds, want);
        // The bridge's injection is what the walk reads; cleared, the
        // detector's own answer is back.
        inject_block("pf-none#both-a", Some((SessionBlockKind::UsageLimit, Some("5pm".into()))));
        let injected = registry.session_blocks().into_iter().find(|b| b.key == "pf-none#both-a").unwrap();
        assert_eq!((injected.kind, injected.resets_at.as_deref()), (SessionBlockKind::UsageLimit, Some("5pm")));
        inject_block("pf-none#both-a", None);
        assert!(registry.session_blocks().iter().all(|b| b.key != "pf-none#both-a"));
        // The wire shape the frontend reads.
        let wire = serde_json::to_value(&registry.session_blocks()[0]).unwrap();
        assert_eq!(wire["kind"], if menu_rules_apply() { "bypass" } else { "usageLimit" });
    }

    #[test]
    fn a_claude_builder_is_started_and_resumed_by_its_own_session_id() {
        let start = with_claude_session(
            builder_args("claude", true, false, None, Some("do it"), Some("light"), &no_model()).unwrap(),
            "claude",
            false,
            Some("sid-1"),
        );
        assert_eq!(start, ["--session-id", "sid-1", "--settings", r#"{"theme":"light"}"#, "--dangerously-skip-permissions", "do it"]);
        let resume = with_claude_session(builder_args("claude", false, true, None, None, None, &no_model()).unwrap(), "claude", true, Some("sid-1"));
        assert_eq!(resume, ["--resume", "sid-1"]);
        // A card started before P-F has no id: `--continue`, as before.
        let before = with_claude_session(builder_args("claude", false, true, None, None, None, &no_model()).unwrap(), "claude", true, None);
        assert_eq!(before, ["--continue"]);
        // Codex keeps its own resume.
        let codex = with_claude_session(builder_args("codex", false, true, Some("019-own"), None, None, &no_model()).unwrap(), "codex", true, Some("x"));
        assert_eq!(&codex[..2], ["resume", "019-own"]);
        assert!(new_claude_session_id("codex").is_none());
        let id = new_claude_session_id("claude").unwrap();
        assert!(uuid::Uuid::parse_str(&id).is_ok());
        // Still the TUI on a Ply canvas: the theme put in before the id stays
        // (`claude_theme::apply` skips an argv that already names a session).
        assert!(start.iter().any(|a| a == "--settings"));
    }

    /// #74: no model chosen — the argv is byte-for-byte what every Ply
    /// before #74 produced, so the CLI keeps deciding.
    /// 1.168.1 (E2, Challenger): a review that starts records the model it
    /// runs on (before: none, so a running review read as "the tool's
    /// default now" on the card); the tool's own default stays `None`.
    #[test]
    fn a_running_review_names_its_model() {
        let kind = crate::review_passes::ReviewKind::default();
        let chosen = ModelChoice { model: Some("gpt-7".into()), reasoning: Some("low".into()) };
        let r = started_review(3, "codex", false, true, chosen.label(), kind);
        assert_eq!((r.status.as_str(), r.provider.as_str(), r.snapshot_n), ("running", "codex", 3));
        assert_eq!(r.model.as_deref(), Some("gpt-7 low"));
        assert!(r.single_vendor && r.verdict.is_none());
        assert_eq!(started_review(3, "claude", false, false, no_model().label(), kind).model, None);
    }

    fn no_model() -> ModelChoice {
        ModelChoice::default()
    }

    // ── OB-14: one AI is enough ──────────────────────────────────────

    fn env_with(claude: bool, codex: bool) -> shell_env::ShellEnv {
        shell_env::ShellEnv {
            claude_path: claude.then(|| "/bin/claude".to_string()),
            // R3: a found Claude here starts (answers `--version`).
            claude_version: claude.then(|| "2.1.330".to_string()),
            codex_path: codex.then(|| "/bin/codex".to_string()),
            codex_version: codex.then(|| "0.157.0".to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn both_vendors_the_challenger_is_the_other_one() {
        let c = choose_challenger("claude", true, || Ok(()), || panic!("own never asked")).unwrap();
        assert_eq!(c, ChallengerChoice { provider: "codex".into(), degraded: false, single_vendor: false });
        let c = choose_challenger("codex", true, || Ok(()), || panic!("own never asked")).unwrap();
        assert_eq!(c.provider, "claude");
    }

    #[test]
    fn the_other_vendor_not_installed_is_a_single_vendor_review_never_probing_it() {
        let c = choose_challenger("claude", false, || panic!("never probe a missing CLI"), || Ok(())).unwrap();
        assert_eq!(c, ChallengerChoice { provider: "claude".into(), degraded: true, single_vendor: true });
        let c = choose_challenger("codex", false, || panic!("never probe a missing CLI"), || Ok(())).unwrap();
        assert_eq!(c, ChallengerChoice { provider: "codex".into(), degraded: true, single_vendor: true });
    }

    #[test]
    fn the_other_vendor_installed_but_failing_keeps_the_degraded_fallback() {
        let c = choose_challenger("claude", true, || Err("probe failed".into()), || Ok(())).unwrap();
        assert_eq!(c, ChallengerChoice { provider: "claude".into(), degraded: true, single_vendor: false });
    }

    #[test]
    fn neither_vendor_can_review_fails_with_the_reason() {
        let e = choose_challenger("claude", true, || Err("codex probe failed".into()), || Err("x".into()))
            .unwrap_err();
        assert_eq!(e, "codex probe failed");
        let e = choose_challenger("codex", false, || panic!(), || Err("quota".into())).unwrap_err();
        assert!(e.contains("Claude isn't installed") && e.contains("quota"), "{e}");
    }

    #[test]
    fn vendor_installed_reads_the_path_only() {
        assert!(vendor_installed(&env_with(true, false), "claude"));
        assert!(!vendor_installed(&env_with(true, false), "codex"));
        assert!(vendor_installed(&env_with(false, true), "codex"));
        assert!(!vendor_installed(&env_with(false, true), "claude"));
    }

    #[test]
    fn start_refusal_names_the_missing_vendor_and_the_two_ways_out() {
        let m = crate::platform::THIS_MACHINE;
        assert_eq!(
            vendor_missing_refusal(&env_with(true, false), "codex", false).unwrap(),
            format!("Codex isn't installed on {m}. Choose Claude for this card, or install Codex.")
        );
        assert_eq!(
            vendor_missing_refusal(&env_with(false, true), "claude", false).unwrap(),
            format!("Claude isn't installed on {m}. Choose Codex for this card, or install Claude.")
        );
        assert!(vendor_missing_refusal(&env_with(true, true), "codex", false).is_none());
        assert!(vendor_missing_refusal(&env_with(true, true), "claude", false).is_none());
        // A Codex wrapper that does not start is not a Codex.
        let mut broken = env_with(true, true);
        broken.codex_version = None;
        // 1.176.0 R7: typed (`cli_fresh::not_starting`), the sentence after it.
        assert_eq!(
            vendor_missing_refusal(&broken, "codex", false).unwrap(),
            format!(
                "PLY_CLI_NOT_STARTING_V1:{{\"tool\":\"codex\"}}\nCodex is installed on {m} but doesn't start. Choose Claude for this card, or repair Codex."
            )
        );
        // Resume cannot switch vendor: it says so.
        let r = vendor_missing_refusal(&env_with(true, false), "codex", true).unwrap();
        assert!(r.starts_with(&format!("Codex isn't installed on {m}.")) && r.contains("can't resume"), "{r}");
    }

    /// X2 (owner 2026-11-09): the comment posted on the pull request loses
    /// what has the shape of a secret, and says how many things; the review
    /// the card keeps is whole, and a review with nothing to remove is
    /// posted exactly as before.
    #[test]
    fn the_verdict_comment_is_filtered_for_github_and_the_card_keeps_the_whole_notes() {
        // Put together at run time: no secret-shaped string in this file.
        let token = ["gh", "p_", &"aB3dE6gH9jK2".repeat(3)].concat();
        let secret = "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7caB3d";
        let copy = std::path::Path::new("/Users/matteo/code/lyra/.plyloft-worktrees/card-abc");
        let notes = format!(
            "## Findings\n1. `/Users/matteo/code/lyra/.plyloft-worktrees/card-abc/src/app.js:3` hard-codes `{token}`.\n2. `.env` has SESSION_SECRET={secret}; it also read /Users/matteo/.npmrc.\n3. `const API_KEY = process.env.API_KEY` is fine."
        );
        let review = BuilderReview {
            snapshot_n: 2,
            provider: "codex".into(),
            status: "done".into(),
            verdict: Some("changes_requested".into()),
            excerpt: Some(notes.clone()),
            ledger_note: Some(format!("F1 quotes {token}")),
            ..Default::default()
        };
        let body = verdict_comment_body(&review, &[copy]);
        assert!(!body.contains(&token) && !body.contains(secret) && !body.contains("matteo"), "{body}");
        let marker = crate::publish_filter::REMOVED;
        assert!(body.contains(&format!("1. `src/app.js:3` hard-codes `{marker}`.")), "{body}");
        assert!(body.contains(&format!("SESSION_SECRET={marker}; it also read ~/.npmrc.")), "{body}");
        assert!(body.contains("3. `const API_KEY = process.env.API_KEY` is fine."), "ordinary code survives: {body}");
        assert!(body.contains(&format!("**Plyloft's reading:** F1 quotes {marker}")), "{body}");
        // The count line, under the notes.
        let line = "\nPlyloft: 3 things that looked like secrets were removed from these notes before posting. The card keeps the whole text.\n";
        assert!(body.ends_with(&format!("\n\n</details>\n{line}")), "{body}");
        // The card's own review is untouched.
        assert_eq!(review.excerpt.as_deref(), Some(notes.as_str()));

        // Nothing to remove: byte for byte what it was before the filter, and no line.
        let clean = BuilderReview { excerpt: Some("## Verdict\nAPPROVE\n\nNothing to change in `src/app.js`.".into()), ledger_note: None, ..review.clone() };
        let body = verdict_comment_body(&clean, &[copy]);
        assert_eq!(
            body,
            "## Plyloft Reviewer — Codex\n\n**Verdict:** CHANGES_REQUESTED on build snapshot 2\n\n<details><summary>Reviewer notes</summary>\n\n## Verdict\nAPPROVE\n\nNothing to change in `src/app.js`.\n\n</details>\n"
        );
        // It is the comment's one caller that hands the card's copy in.
        assert!(include_str!("commands.rs").contains("let body = crate::builder::verdict_comment_body(review, &[wt]);"));
    }

    /// X2 round 2: what the notes leave open is closed before the comment
    /// goes on — a code fence cut by the excerpt's limit, or one whose end
    /// went with a key block that was never closed — so `</details>` and
    /// the count line are read as written, not as code.
    #[test]
    fn an_open_block_in_the_notes_does_not_swallow_the_end_of_the_comment() {
        let header = ["-----BEGIN RSA PRIVATE", " KEY-----"].concat();
        let cut_key = format!("The fixture:\n\n```\n{header}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n```\n\nIt should not be committed.");
        let cut_fence = "## Findings\n\n```ts\nconst a = 1;\n…".to_string();
        for (notes, removed) in [(cut_key, 1), (cut_fence, 0)] {
            let review = BuilderReview {
                snapshot_n: 1,
                provider: "codex".into(),
                status: "done".into(),
                verdict: Some("approve".into()),
                excerpt: Some(notes.clone()),
                ..Default::default()
            };
            let body = verdict_comment_body(&review, &[]);
            let (before, after) = body.split_once("\n\n</details>\n").expect("the notes block is closed");
            let fences = before.lines().filter(|line| line.trim_start().starts_with("```")).count();
            assert_eq!(fences % 2, 0, "every fence is closed before </details>: {body}");
            match removed {
                0 => assert_eq!(after, "", "{body}"),
                _ => assert!(after.starts_with("\nPlyloft: 1 thing that looked like a secret was removed from these notes"), "{body}"),
            }
        }
    }

    /// X2 round 2: a dismissed finding's title is the Reviewer's words. The
    /// line that names it goes into the pull request body under "From
    /// Plyloft" through the same filter as the notes; the Ship receipt and
    /// the card keep the line whole. The override's own sentence holds no
    /// Reviewer text and nothing the person typed.
    #[test]
    fn the_dismissal_line_is_filtered_where_the_pull_request_body_takes_it() {
        let token = ["gh", "p_", &"aB3dE6gH9jK2".repeat(3)].concat();
        let copy = std::path::Path::new("/Users/matteo/code/lyra/.plyloft-worktrees/card-abc");
        let line = format!(
            "Reviewer findings dismissed as not a real issue: F1 (P1 — Hard-coded token {token} in /Users/matteo/code/lyra/.plyloft-worktrees/card-abc/config.js) by matteo: \"a test fixture\"."
        );
        let posted = line_for_github(&line, copy);
        assert_eq!(
            posted,
            format!(
                "Reviewer findings dismissed as not a real issue: F1 (P1 — Hard-coded token {} in config.js) by matteo: \"a test fixture\".",
                crate::publish_filter::REMOVED
            )
        );
        let plain = "Review overridden: the Reviewer (Codex) requested changes on round 2; the person kept it as it was on 2026-11-09 10:00 UTC without a new round.";
        assert_eq!(line_for_github(plain, copy), plain, "nothing to remove: as written");
        // Ship's body takes the line through it; the receipt takes it as it is.
        let commands = include_str!("commands.rs");
        assert!(commands.contains("body.push_str(&format!(\"\\n\\n**{}**\", crate::builder::line_for_github(line, &wt)));"));
        assert!(commands.contains("res.review_override = review_override_line(&card);"));
        // The override's sentence is Plyloft's: who, which round, when.
        let source = include_str!("builder.rs");
        let summary = &source[source.find("pub fn review_override_summary(").unwrap()..];
        let summary = &summary[..summary.find("\n}\n").unwrap()];
        assert!(!summary.contains("review.note.as") && !summary.contains("excerpt") && !summary.contains("finding"), "{summary}");
    }

    #[test]
    fn verdict_comment_says_a_single_vendor_review_plainly() {
        let review = BuilderReview {
            snapshot_n: 2,
            provider: "claude".into(),
            degraded: true,
            single_vendor: true,
            status: "done".into(),
            verdict: Some("approve".into()),
            ..Default::default()
        };
        let body = verdict_comment_body(&review, &[]);
        assert!(body.contains("Claude (a separate, read-only session reviewed its own vendor's build)"), "{body}");
        assert!(!body.contains("unavailable"), "{body}");
        let degraded = BuilderReview { single_vendor: false, ..review };
        assert!(verdict_comment_body(&degraded, &[]).contains("the other vendor was unavailable"));
    }

    // ── UX P-C: the guided first card's permission mode ───────────────

    /// The two copies of the guided card's words (here and in
    /// `firstCardGuide.ts`) are held to one fixture, so they cannot drift.
    #[test]
    fn the_guided_card_words_match_the_shared_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../src/lib/firstCard.fixtures.json")).unwrap();
        assert_eq!(fixture["title"], FIRST_CARD_TITLE);
        assert_eq!(fixture["brief"], FIRST_CARD_BRIEF);
    }

    #[test]
    fn guided_claude_accepts_edits_and_never_skips_permissions() {
        let a = builder_args_in_mode(
            "claude",
            false,
            Some(GUIDED_PERMISSION_MODE),
            false,
            None,
            Some("do it"),
            None,
            &no_model(),
        )
        .unwrap();
        assert_eq!(a, vec!["--permission-mode", "acceptEdits", "do it"]);
        assert!(!a.iter().any(|x| x == "--dangerously-skip-permissions"));
        assert!(!a.iter().any(|x| x.starts_with("--allowedTools")), "no allow list until one is measured");
        // Resume keeps the mode, before --continue.
        let resumed =
            builder_args_in_mode("claude", false, Some(GUIDED_PERMISSION_MODE), true, None, None, None, &no_model())
                .unwrap();
        assert_eq!(resumed, vec!["--permission-mode", "acceptEdits", "--continue"]);
        // "Build without asking" turned on is today's bypass, nothing more.
        let bypass =
            builder_args_in_mode("claude", true, Some(GUIDED_PERMISSION_MODE), false, None, Some("x"), None, &no_model())
                .unwrap();
        assert_eq!(bypass, vec!["--dangerously-skip-permissions", "x"]);
        // Any other recorded mode passes nothing: the default permissions.
        for other in ["bypassPermissions", "plan", "", "acceptedits"] {
            let a = builder_args_in_mode("claude", false, Some(other), false, None, Some("x"), None, &no_model())
                .unwrap();
            assert_eq!(a, vec!["x"], "{other}");
        }
        // The ordinary entry point is unchanged.
        assert_eq!(builder_args("claude", false, false, None, Some("x"), None, &no_model()).unwrap(), vec!["x"]);
    }

    #[test]
    fn guided_codex_keeps_its_sandboxed_pair() {
        let a = builder_args_in_mode(
            "codex",
            false,
            Some(GUIDED_PERMISSION_MODE),
            false,
            None,
            Some("do it"),
            None,
            &no_model(),
        )
        .unwrap();
        assert_eq!(a, vec!["--sandbox", "workspace-write", "-a", "on-request", "do it"]);
        assert!(!a.iter().any(|x| x.contains("dangerously") || x == "danger-full-access"));
        let ordinary = builder_args("codex", false, false, None, Some("do it"), None, &no_model()).unwrap();
        assert_eq!(ordinary, vec!["--sandbox", "workspace-write", "do it"]);
    }

    /// 1.171.0 (D1): each choice's flags, per AI, on a new session and on a
    /// Resume (Codex's after `resume <id>`); the same argv on every OS —
    /// Codex's own sandbox holds the pairs on Windows too.
    #[test]
    fn each_permissions_choice_passes_its_own_flags() {
        let args = |vendor: &str, bypass: bool, mode: Option<&str>, resume: bool| {
            builder_args_in_mode(vendor, bypass, mode, resume, Some("sess-1"), Some("go"), None, &no_model()).unwrap()
        };
        let edits = Some(BuilderPermissions::EditsCopy.mode_str());
        let asks = Some(BuilderPermissions::Asks.mode_str());
        let never = Some(BuilderPermissions::NeverAsks.mode_str());
        // Claude.
        assert_eq!(args("claude", false, edits, false), vec!["--permission-mode", "acceptEdits", "go"]);
        assert_eq!(args("claude", false, asks, false), vec!["go"]);
        assert_eq!(args("claude", true, never, false), vec!["--dangerously-skip-permissions", "go"]);
        // `neverAsks` alone is the bypass too (the mode decides, not only the flag).
        assert_eq!(args("claude", false, never, false), vec!["--dangerously-skip-permissions", "go"]);
        assert_eq!(
            args("claude", false, edits, true),
            vec!["--permission-mode", "acceptEdits", "--continue", "go"]
        );
        // Codex: its own presets, never its unsandboxed bypass.
        assert_eq!(args("codex", false, edits, false), vec!["--sandbox", "workspace-write", "-a", "on-request", "go"]);
        assert_eq!(args("codex", false, asks, false), vec!["--sandbox", "read-only", "-a", "on-request", "go"]);
        assert_eq!(args("codex", true, never, false), vec!["--sandbox", "workspace-write", "-a", "never", "go"]);
        assert_eq!(
            args("codex", false, asks, true),
            vec!["resume", "sess-1", "--sandbox", "read-only", "-a", "on-request", "go"]
        );
        for mode in [edits, asks, never] {
            let a = args("codex", mode == never, mode, false);
            assert!(!a.iter().any(|x| x.contains("dangerously") || x == "danger-full-access"), "{a:?}");
        }
        // Before D1 (no choice recorded): exactly as before.
        assert_eq!(args("claude", false, None, false), vec!["go"]);
        assert_eq!(args("codex", false, None, false), vec!["--sandbox", "workspace-write", "go"]);
        assert_eq!(
            args("codex", false, Some(GUIDED_PERMISSION_MODE), false),
            args("codex", false, edits, false),
            "the tour card runs what its page shows"
        );
        // Codex's git grants go with workspace-write only: Read Only asks.
        let granted = with_codex_add_dirs(args("codex", false, edits, false), &["/g".into()]);
        assert_eq!(granted, vec!["--sandbox", "workspace-write", "--add-dir", "/g", "-a", "on-request", "go"]);
        let read_only = with_codex_add_dirs(args("codex", false, asks, false), &["/g".into()]);
        assert!(!read_only.contains(&"--add-dir".to_string()), "{read_only:?}");
    }

    /// D1: a Start build's mode — the card's own choice first, then the tour
    /// card's bounded mode, then the Settings default.
    #[test]
    fn a_start_takes_the_cards_choice_then_the_tour_then_settings() {
        use BuilderPermissions::*;
        let tour = || Some(GUIDED_PERMISSION_MODE.to_string());
        let none = || None;
        // The card's choice wins over the tour and Settings.
        let m = start_mode(Some(Asks), false, NeverAsks, tour);
        assert_eq!(m, StartMode { permissions: Some(Asks), bypass: false, permission_mode: None });
        assert_eq!(m.args_mode(), Some("asks"));
        let m = start_mode(Some(NeverAsks), false, Asks, tour);
        assert!(m.bypass);
        assert_eq!(m.permissions, Some(NeverAsks));
        // No choice: the tour card keeps its bounded mode, recorded as before.
        let m = start_mode(None, false, Asks, tour);
        assert_eq!(m, StartMode { permissions: None, bypass: false, permission_mode: Some("acceptEdits".into()) });
        assert_eq!(m.args_mode(), Some("acceptEdits"));
        // No choice, not the tour card: the Settings default.
        assert_eq!(start_mode(None, false, Asks, none).permissions, Some(Asks));
        assert_eq!(start_mode(None, false, EditsCopy, none).args_mode(), Some("editsCopy"));
        let m = start_mode(None, false, NeverAsks, none);
        assert!(m.bypass && m.permissions == Some(NeverAsks));
        // A window that asks for the bypass (Start fresh keeping a closed
        // bypass session's posture) on a card with no choice of its own.
        assert_eq!(start_mode(None, true, Asks, tour).permissions, Some(NeverAsks));
        // …but never over the card's own choice.
        assert_eq!(start_mode(Some(EditsCopy), true, Asks, none).permissions, Some(EditsCopy));
    }

    /// D1 (Challenger 2): Start fresh keeps the closed session's choice on
    /// the same AI when the card has none of its own; the card's own choice
    /// wins; the other AI keeps nothing (the Settings default applies).
    #[test]
    fn start_fresh_keeps_the_closed_sessions_choice_on_the_same_ai() {
        let mut card = guided_card();
        card.builder = Some(
            serde_json::from_value(serde_json::json!({
                "vendor": "codex", "bypass": false, "sessionLost": true, "startedAt": 1, "snapshots": [],
                "permissions": "editsCopy"
            }))
            .unwrap(),
        );
        assert_eq!(card_choice(&card, "codex"), Some(BuilderPermissions::EditsCopy));
        assert_eq!(card_choice(&card, "claude"), None);
        let m = start_mode(card_choice(&card, "codex"), false, BuilderPermissions::Asks, || None);
        assert_eq!(m.args_mode(), Some("editsCopy"));
        card.builder_permissions = Some(BuilderPermissions::Asks);
        assert_eq!(card_choice(&card, "codex"), Some(BuilderPermissions::Asks));
        // A session from before D1 keeps nothing here (its bypass travels
        // through the window, as before).
        card.builder_permissions = None;
        card.builder.as_mut().unwrap().permissions = None;
        assert_eq!(card_choice(&card, "codex"), None);
    }

    /// D1 (brief point 3): Resume keeps the mode the session started in,
    /// whatever changed since (the guide ended, the card's task rewritten);
    /// a session from before D1 keeps today's rule.
    #[test]
    fn resume_keeps_the_sessions_own_choice() {
        let card = guided_card();
        let mut state: crate::kanban::BuilderState = serde_json::from_value(serde_json::json!({
            "vendor": "codex", "bypass": false, "sessionLost": true, "startedAt": 1, "snapshots": []
        }))
        .unwrap();
        for p in [BuilderPermissions::EditsCopy, BuilderPermissions::Asks, BuilderPermissions::NeverAsks] {
            state.permissions = Some(p);
            state.bypass = p == BuilderPermissions::NeverAsks;
            let m = resumed_mode(&state, None, None, "ws", "/tmp/ws", &card);
            assert_eq!(m.args_mode(), Some(p.mode_str()));
            assert_eq!(m.bypass, p == BuilderPermissions::NeverAsks);
            let args = builder_args_in_mode("codex", m.bypass, m.args_mode(), true, Some("s"), None, None, &no_model())
                .unwrap();
            let expected: &[&str] = match p {
                BuilderPermissions::EditsCopy => &["resume", "s", "--sandbox", "workspace-write", "-a", "on-request"],
                BuilderPermissions::Asks => &["resume", "s", "--sandbox", "read-only", "-a", "on-request"],
                BuilderPermissions::NeverAsks => &["resume", "s", "--sandbox", "workspace-write", "-a", "never"],
            };
            assert_eq!(args, expected);
        }
        // Before D1: the bypass kept, the guided mode only while its guide holds.
        state.permissions = None;
        state.bypass = true;
        let m = resumed_mode(&state, None, None, "ws", "/tmp/ws", &card);
        assert!(m.bypass && m.permissions.is_none() && m.args_mode().is_none());
        state.bypass = false;
        state.permission_mode = Some(GUIDED_PERMISSION_MODE.into());
        let guide = guide_for("card-1");
        assert_eq!(
            resumed_mode(&state, Some(&guide), None, "ws", "/tmp/ws", &card).args_mode(),
            Some(GUIDED_PERMISSION_MODE)
        );
        assert_eq!(resumed_mode(&state, None, None, "ws", "/tmp/ws", &card).args_mode(), None);
    }

    fn guided_card() -> KanbanCard {
        let mut card = KanbanCard::new(
            "card-1".into(),
            "ws".into(),
            FIRST_CARD_TITLE.into(),
            Some(FIRST_CARD_BRIEF.into()),
            crate::kanban::KanbanColumnId::InProgress,
        );
        card.worktree_path = Some("/tmp/ws/.plyloft-worktrees/card-1".into());
        card
    }

    fn guide_for(card: &str) -> crate::settings::FirstCardGuide {
        crate::settings::FirstCardGuide {
            workspace_id: "ws".into(),
            card_id: card.into(),
            started_at: "2026-10-17T10:00:00Z".into(),
            ended_at: None,
            outcome: None,
        }
    }

    #[test]
    fn only_the_unedited_guided_card_gets_the_guided_mode() {
        let card = guided_card();
        let guide = guide_for("card-1");
        let mode = |guided: bool, bypass: bool, guide: Option<&crate::settings::FirstCardGuide>, ws: &str, card: &KanbanCard| {
            guided_permission_mode(guided, bypass, guide, ws, "/tmp/ws", card)
        };
        assert_eq!(mode(true, false, Some(&guide), "ws", &card).as_deref(), Some("acceptEdits"));
        // Whitespace around the words is not an edit.
        let mut padded = card.clone();
        padded.title = format!("  {FIRST_CARD_TITLE}\n");
        padded.notes = Some(format!("{FIRST_CARD_BRIEF}\n\n"));
        assert!(mode(true, false, Some(&guide), "ws", &padded).is_some());

        // Not asked for, or "Build without asking" on: no guided mode.
        assert_eq!(mode(false, false, Some(&guide), "ws", &card), None);
        assert_eq!(mode(true, true, Some(&guide), "ws", &card), None);
        // No guide, a guide for another card or workspace, an ended guide.
        assert_eq!(mode(true, false, None, "ws", &card), None);
        assert_eq!(mode(true, false, Some(&guide_for("card-2")), "ws", &card), None);
        assert_eq!(mode(true, false, Some(&guide), "other-ws", &card), None);
        let mut ended = guide.clone();
        ended.ended_at = Some("2026-10-17T10:05:00Z".into());
        ended.outcome = Some("dismissed".into());
        assert_eq!(mode(true, false, Some(&ended), "ws", &card), None);
        let mut shipped = guide.clone();
        shipped.ended_at = Some("2026-10-17T10:09:00Z".into());
        shipped.outcome = Some("shipped".into());
        assert_eq!(mode(true, false, Some(&shipped), "ws", &card), None);
        // The task rewritten: brief or title edited, or the brief emptied.
        let mut brief = card.clone();
        brief.notes = Some(format!("{FIRST_CARD_BRIEF} Also add a licence."));
        assert_eq!(mode(true, false, Some(&guide), "ws", &brief), None);
        let mut no_brief = card.clone();
        no_brief.notes = None;
        assert_eq!(mode(true, false, Some(&guide), "ws", &no_brief), None);
        let mut title = card.clone();
        title.title = "Describe this project".into();
        assert_eq!(mode(true, false, Some(&guide), "ws", &title), None);
        // Never in the member's own checkout: the card's own copy only.
        let mut no_copy = card.clone();
        no_copy.worktree_path = None;
        assert_eq!(mode(true, false, Some(&guide), "ws", &no_copy), None);
        // Built by both: no single Builder to grant it to.
        let mut both = card.clone();
        both.build_both = Some(serde_json::from_value(serde_json::json!({ "startedAt": 0, "lanes": [] })).unwrap());
        assert_eq!(mode(true, false, Some(&guide), "ws", &both), None);
        // (Challenger) A recorded copy that is the workspace's own folder is
        // the member's checkout, whatever its spelling.
        for own in ["/tmp/ws", "/tmp/ws/", " /tmp/ws "] {
            let mut in_checkout = card.clone();
            in_checkout.worktree_path = Some(own.into());
            assert_eq!(mode(true, false, Some(&guide), "ws", &in_checkout), None, "{own}");
        }
        let real = tempfile::tempdir().unwrap();
        let cwd = real.path().to_string_lossy().into_owned();
        let mut resolved = card.clone();
        resolved.worktree_path = Some(format!("{cwd}/."));
        assert_eq!(guided_permission_mode(true, false, Some(&guide), "ws", &cwd, &resolved), None);
    }

    /// (Challenger) Resume keeps the guided mode only while the guide's test
    /// holds: after End the guide, a shipped guide, or a rewritten task, the
    /// session resumes with the default permissions; a session that was not
    /// guided never gains it.
    #[test]
    fn a_guided_session_resumes_guided_only_while_the_guide_still_holds() {
        let card = guided_card();
        let guide = guide_for("card-1");
        let mut state = card.builder.clone().unwrap_or_else(|| {
            serde_json::from_value(serde_json::json!({
                "vendor": "claude", "bypass": false, "sessionLost": false, "startedAt": 1, "snapshots": []
            }))
            .unwrap()
        });
        state.permission_mode = Some(GUIDED_PERMISSION_MODE.into());
        let resumed = |state: &crate::kanban::BuilderState, guide: Option<&crate::settings::FirstCardGuide>, card: &KanbanCard| {
            resumed_permission_mode(state, guide, None, "ws", "/tmp/ws", card)
        };
        assert_eq!(resumed(&state, Some(&guide), &card).as_deref(), Some(GUIDED_PERMISSION_MODE));
        let mut ended = guide.clone();
        ended.ended_at = Some("2026-10-17T10:05:00Z".into());
        ended.outcome = Some("dismissed".into());
        assert_eq!(resumed(&state, Some(&ended), &card), None);
        assert_eq!(resumed(&state, None, &card), None);
        let mut rewritten = card.clone();
        rewritten.notes = Some("Rewrite the whole app.".into());
        assert_eq!(resumed(&state, Some(&guide), &rewritten), None);
        let mut other = card.clone();
        other.id = "card-2".into();
        assert_eq!(resumed(&state, Some(&guide), &other), None);
        // Bypass recorded wins: nothing extra.
        let mut bypassed = state.clone();
        bypassed.bypass = true;
        assert_eq!(resumed(&bypassed, Some(&guide), &card), None);
        // A session started ordinary never gains it on Resume.
        let mut ordinary = state.clone();
        ordinary.permission_mode = None;
        assert_eq!(resumed(&ordinary, Some(&guide), &card), None);
        ordinary.permission_mode = Some("bypassPermissions".into());
        assert_eq!(resumed(&ordinary, Some(&guide), &card), None);
    }

    fn tour_for(card: &str) -> crate::settings::TutorialProgress {
        crate::settings::TutorialProgress {
            started_at: Some("2026-10-22T09:00:00Z".into()),
            workspace_id: Some("ws".into()),
            card_id: Some(card.into()),
            ..Default::default()
        }
    }

    /// QoL 7.4 (D10): the tour's own first card, on the member's own idea,
    /// gets the README example's bounded mode; every other card, an ended
    /// tour, "Build without asking" on, a card built by both, a pull request
    /// card or the member's own checkout do not.
    #[test]
    fn the_tour_card_gets_the_bounded_mode_and_nothing_else_does() {
        let mut card = guided_card();
        card.title = "Add a contact form".into();
        card.notes = Some("A form on the home page that emails me.".into());
        // Made in Plyloft during the tour (09:00 start; this is 09:05).
        card.created_at = chrono::DateTime::parse_from_rfc3339("2026-10-22T09:05:00Z").unwrap().timestamp_millis();
        let tour = tour_for("card-1");
        let mode = |guided: bool, bypass: bool, tour: Option<&crate::settings::TutorialProgress>, ws: &str, card: &KanbanCard| {
            tour_permission_mode(guided, bypass, tour, ws, "/tmp/ws", card)
        };
        assert_eq!(mode(true, false, Some(&tour), "ws", &card).as_deref(), Some(GUIDED_PERMISSION_MODE));
        assert_eq!(mode(false, false, Some(&tour), "ws", &card), None, "not asked for");
        assert_eq!(mode(true, true, Some(&tour), "ws", &card), None, "Build without asking on");
        assert_eq!(mode(true, false, None, "ws", &card), None);
        assert_eq!(mode(true, false, Some(&tour_for("card-2")), "ws", &card), None, "a later card");
        assert_eq!(mode(true, false, Some(&tour), "other-ws", &card), None);
        let mut ended = tour.clone();
        ended.ended_at = Some("2026-10-22T09:30:00Z".into());
        assert_eq!(mode(true, false, Some(&ended), "ws", &card), None, "the tour ended");
        let mut no_card = tour.clone();
        no_card.card_id = None;
        assert_eq!(mode(true, false, Some(&no_card), "ws", &card), None, "no card recorded yet");
        let mut no_copy = card.clone();
        no_copy.worktree_path = Some("/tmp/ws".into());
        assert_eq!(mode(true, false, Some(&tour), "ws", &no_copy), None, "the member's own checkout");
        let mut both = card.clone();
        both.build_both = Some(serde_json::from_value(serde_json::json!({ "startedAt": 0, "lanes": [] })).unwrap());
        assert_eq!(mode(true, false, Some(&tour), "ws", &both), None, "built by both");
        // (Challenger) The mode expires with the loop: Ship it done, the card
        // landed or its pull request open, a pull request review card.
        let mut shipped_step = tour.clone();
        shipped_step.done.insert(TOUR_SHIP_STEP.into(), "2026-10-22T10:00:00Z".into());
        assert_eq!(mode(true, false, Some(&shipped_step), "ws", &card), None, "Ship it done");
        let mut landed = card.clone();
        landed.ship_status = crate::kanban::ShipStatus::Shipped;
        assert_eq!(mode(true, false, Some(&tour), "ws", &landed), None, "landed");
        let mut merged = card.clone();
        merged.review_status = Some(crate::kanban::ReviewStatus::Merged);
        assert_eq!(mode(true, false, Some(&tour), "ws", &merged), None, "its pull request merged");
        let mut pr_review = card.clone();
        pr_review.pr_review = Some(crate::pr_review::PrReview { number: 7, ..Default::default() });
        assert_eq!(mode(true, false, Some(&tour), "ws", &pr_review), None, "a pull request review card");
        // (Challenger) Only a card the member made in Plyloft during the tour.
        let mut before = card.clone();
        before.created_at = chrono::DateTime::parse_from_rfc3339("2026-10-22T08:00:00Z").unwrap().timestamp_millis();
        assert_eq!(mode(true, false, Some(&tour), "ws", &before), None, "made before the tour");
        let mut no_start = tour.clone();
        no_start.started_at = None;
        assert_eq!(mode(true, false, Some(&no_start), "ws", &card), None, "no full tour started");
        let mut issue = card.clone();
        issue.gh_issue_number = Some(12);
        assert_eq!(mode(true, false, Some(&tour), "ws", &issue), None, "a GitHub issue's card");
        let mut follow = card.clone();
        follow.follows_up = Some(serde_json::from_value(serde_json::json!({ "cardId": "c0", "title": "t", "at": 1 })).unwrap());
        assert_eq!(mode(true, false, Some(&tour), "ws", &follow), None, "a follow-up card");
        let mut ran_ordinary = card.clone();
        ran_ordinary.builder = Some(
            serde_json::from_value(serde_json::json!({
                "vendor": "claude", "bypass": false, "sessionLost": false, "startedAt": 1, "snapshots": []
            }))
            .unwrap(),
        );
        assert_eq!(mode(true, false, Some(&tour), "ws", &ran_ordinary), None, "the slot holder, started ordinary");
        let mut ran_bounded = ran_ordinary.clone();
        ran_bounded.builder.as_mut().unwrap().permission_mode = Some(GUIDED_PERMISSION_MODE.into());
        assert!(mode(true, false, Some(&tour), "ws", &ran_bounded).is_some(), "started bounded: Start fresh stays bounded");

        // Through `bounded_permission_mode`: either test grants it.
        let mut onboarding = crate::settings::OnboardingSettings::default();
        onboarding.tutorial = Some(tour.clone());
        assert_eq!(
            bounded_permission_mode(true, false, &onboarding, "ws", "/tmp/ws", &card).as_deref(),
            Some(GUIDED_PERMISSION_MODE)
        );
        onboarding.tutorial = Some(tour_for("card-9"));
        assert_eq!(bounded_permission_mode(true, false, &onboarding, "ws", "/tmp/ws", &card), None);
        onboarding.first_card = Some(guide_for("card-1"));
        assert_eq!(
            bounded_permission_mode(true, false, &onboarding, "ws", "/tmp/ws", &guided_card()).as_deref(),
            Some(GUIDED_PERMISSION_MODE)
        );

        // The flags are the README example's, unchanged.
        let claude = builder_args_in_mode("claude", false, Some(GUIDED_PERMISSION_MODE), false, None, Some("x"), None, &no_model()).unwrap();
        assert_eq!(claude, vec!["--permission-mode", "acceptEdits", "x"]);
        let codex = builder_args_in_mode("codex", false, Some(GUIDED_PERMISSION_MODE), false, None, Some("x"), None, &no_model()).unwrap();
        assert_eq!(codex, vec!["--sandbox", "workspace-write", "-a", "on-request", "x"]);

        // Resume keeps it while the tour still names the card, and drops it
        // once the tour ended.
        let mut state: crate::kanban::BuilderState = serde_json::from_value(serde_json::json!({
            "vendor": "codex", "bypass": false, "sessionLost": false, "startedAt": 1, "snapshots": []
        }))
        .unwrap();
        state.permission_mode = Some(GUIDED_PERMISSION_MODE.into());
        assert_eq!(
            resumed_permission_mode(&state, None, Some(&tour), "ws", "/tmp/ws", &card).as_deref(),
            Some(GUIDED_PERMISSION_MODE)
        );
        assert_eq!(resumed_permission_mode(&state, None, Some(&ended), "ws", "/tmp/ws", &card), None);
        state.permission_mode = None;
        assert_eq!(resumed_permission_mode(&state, None, Some(&tour), "ws", "/tmp/ws", &card), None);
    }

    /// A second card in the same workspace never inherits it: the mode is
    /// decided per start, and that card is not the guide's.
    #[test]
    fn a_second_card_starts_with_the_default_permissions() {
        let guide = guide_for("card-1");
        let mut second = guided_card();
        second.id = "card-2".into();
        assert_eq!(guided_permission_mode(true, false, Some(&guide), "ws", "/tmp/ws", &second), None);
        let args = builder_args_in_mode("claude", false, None, false, None, Some("x"), None, &no_model()).unwrap();
        assert_eq!(args, vec!["x"]);
    }

    #[test]
    fn claude_args_carry_bypass_resume_and_prompt_in_order() {
        let a = builder_args("claude", true, false, None, Some("do it"), None, &no_model()).unwrap();
        assert_eq!(a, vec!["--dangerously-skip-permissions", "do it"]);
        let r = builder_args("claude", false, true, None, None, None, &no_model()).unwrap();
        assert_eq!(r, vec!["--continue"]);
        let both = builder_args("claude", true, true, None, None, None, &no_model()).unwrap();
        assert_eq!(both, vec!["--dangerously-skip-permissions", "--continue"]);
    }

    #[test]
    fn claude_theme_settings_precede_the_positional_prompt() {
        let a = builder_args("claude", true, false, None, Some("do it"), Some("light"), &no_model()).unwrap();
        assert_eq!(
            a,
            vec!["--settings", r#"{"theme":"light"}"#, "--dangerously-skip-permissions", "do it"]
        );
        let settings = a.iter().position(|x| x == "--settings").unwrap();
        let prompt = a.iter().position(|x| x == "do it").unwrap();
        assert!(settings + 1 < prompt);
        let r = builder_args("claude", false, true, None, None, Some("dark-daltonized"), &no_model()).unwrap();
        assert_eq!(r, vec!["--settings", r#"{"theme":"dark-daltonized"}"#, "--continue"]);
    }

    #[test]
    fn codex_builder_argv_ignores_the_claude_theme() {
        let a = builder_args("codex", false, false, None, Some("do it"), Some("light"), &no_model()).unwrap();
        assert!(!a.iter().any(|x| x == "--settings"));
    }

    #[test]
    fn codex_args_are_always_sandboxed_and_resume_uses_its_own_session() {
        let a = builder_args("codex", false, false, None, Some("do it"), None, &no_model()).unwrap();
        assert_eq!(a, vec!["--sandbox", "workspace-write", "do it"]);
        let b = builder_args("codex", true, false, None, Some("do it"), None, &no_model()).unwrap();
        assert_eq!(b, vec!["--sandbox", "workspace-write", "-a", "never", "do it"]);
        assert!(!b.iter().any(|x| x.contains("dangerously") || x == "--full-auto"));
        let r = builder_args("codex", true, true, Some("019-own"), None, None, &no_model()).unwrap();
        assert_eq!(r, vec!["resume", "019-own", "--sandbox", "workspace-write", "-a", "never"]);
        // v1.154.1 round 2 (walk J1): never `--last`, which resumes the
        // newest session on the Mac — another card's. No id, no resume.
        assert!(!r.iter().any(|x| x == "--last"));
        let none = builder_args("codex", true, true, None, None, None, &no_model()).unwrap_err();
        assert_eq!(none, crate::codex_sessions::NOT_FOUND);
        let blank = builder_args("codex", true, true, Some("  "), None, None, &no_model()).unwrap_err();
        assert_eq!(blank, crate::codex_sessions::NOT_FOUND);
        // Claude's `--continue` is per directory already and takes no id.
        let c = builder_args("claude", false, true, None, None, None, &no_model()).unwrap();
        assert_eq!(c, vec!["--continue"]);
    }

    /// A card's copy: the project's checkout with a linked worktree beside
    /// it, on `branch`, with one commit so its reflog exists.
    fn repo_with_card_copy(branch: &str) -> (tempfile::TempDir, PathBuf) {
        let repo = git_repo();
        let copy = repo.path().join(".plyloft-worktrees").join("card-1");
        crate::git::run(repo.path(), &["worktree", "add", "-q", "-b", branch, copy.to_str().unwrap()]).unwrap();
        crate::git::run(&copy, &["commit", "--allow-empty", "-q", "-m", "work"]).unwrap();
        (repo, copy)
    }

    fn canon(p: impl AsRef<Path>) -> PathBuf {
        crate::platform::canonicalize(p).unwrap()
    }

    /// 1.169.1 (R3, measured): Codex in a card's copy may write its own git
    /// dir, the objects and its branch's directory of refs and logs — each
    /// its own `--add-dir`, after `resume <id>` and the sandbox pair, before
    /// the prompt, never with the unsandboxed bypass — and never the whole
    /// common dir (`main`, hooks, config stay read-only).
    #[test]
    fn codex_in_a_card_copy_may_write_its_own_git_metadata_only() {
        let (repo, copy) = repo_with_card_copy("plyloft/card-x");
        let common = canon(repo.path().join(".git"));
        let grants = codex_git_grants(&copy).unwrap();
        let canon_grants: Vec<PathBuf> = grants.iter().map(canon).collect();
        assert_eq!(
            canon_grants,
            vec![
                common.join("worktrees").join("card-1"),
                common.join("objects"),
                common.join("refs/heads/plyloft"),
                common.join("logs/refs/heads/plyloft"),
            ]
        );
        assert!(grants.iter().all(|g| Path::new(g).is_absolute()));
        assert!(!canon_grants.iter().any(|g| *g == common || *g == common.join("refs/heads") || *g == common.join("refs")));

        let model = ModelChoice { model: Some("gpt-6-astra".into()), reasoning: Some("low".into()) };
        let flags: Vec<String> = grants.iter().flat_map(|g| ["--add-dir".to_string(), g.clone()]).collect();
        let fresh = codex_args_in(builder_args("codex", true, false, None, Some("do it"), None, &model).unwrap(), &copy, "test");
        let mut want: Vec<String> =
            ["-m", "gpt-6-astra", "-c", "model_reasoning_effort=low", "--sandbox", "workspace-write"].map(String::from).to_vec();
        want.extend(flags.clone());
        want.extend(["-a", "never", "do it"].map(String::from));
        assert_eq!(fresh, want);
        let resumed = codex_args_in(builder_args("codex", false, true, Some("019-own"), None, None, &no_model()).unwrap(), &copy, "test");
        let mut want: Vec<String> = ["resume", "019-own", "--sandbox", "workspace-write"].map(String::from).to_vec();
        want.extend(flags);
        assert_eq!(resumed, want);
        for argv in [&fresh, &resumed] {
            assert!(!argv.iter().any(|a| a.contains("dangerously") || a == "danger-full-access"));
        }
    }

    /// 1.169.1 (R3, Challenger): only a card branch gets grants — any
    /// other branch in a linked worktree (the member's own) gets none at
    /// all, not even its git dir or the objects; the argv stays as it was.
    #[test]
    fn only_a_card_branch_gets_git_grants() {
        let (_repo, copy) = repo_with_card_copy("feature/x");
        assert!(codex_git_grants(&copy).unwrap_err().contains("isn't a card branch"));
        let plain = builder_args("codex", true, false, None, Some("do it"), None, &no_model()).unwrap();
        assert_eq!(codex_args_in(plain.clone(), &copy, "test"), plain);
        let (_repo, copy) = repo_with_card_copy("card-x");
        assert!(codex_git_grants(&copy).is_err());

        for odd in ["card-x", "feature/x", "plyloft/x", "main"] {
            assert!(codex_git_grant_paths("/g", "/p/.git", odd).is_err(), "{odd}");
        }
        // A Build with both lane's branch and the legacy atelier/card-…
        assert_eq!(
            codex_git_grant_paths("/g", "/p/.git/", "plyloft/card-ab12-x-b").unwrap(),
            vec!["/g", "/p/.git/objects", "/p/.git/refs/heads/plyloft", "/p/.git/logs/refs/heads/plyloft"]
        );
        assert_eq!(
            codex_git_grant_paths("/g", "/p/.git", "atelier/card-ab12-x").unwrap()[2],
            "/p/.git/refs/heads/atelier"
        );
    }

    /// 1.169.1 (R3, Challenger): a fresh card's reflog directory may not
    /// exist and `git pack-refs --all --prune` removes `refs/heads/plyloft`;
    /// Plyloft makes both before Codex starts, and grants both.
    #[test]
    fn the_ref_directories_are_made_before_they_are_granted() {
        let (repo, copy) = repo_with_card_copy("plyloft/card-x");
        let common = canon(repo.path().join(".git"));
        crate::git::run(repo.path(), &["pack-refs", "--all", "--prune"]).unwrap();
        let _ = std::fs::remove_dir_all(common.join("logs/refs/heads/plyloft"));
        assert!(!common.join("refs/heads/plyloft").exists());
        let grants: Vec<PathBuf> = codex_git_grants(&copy).unwrap().iter().map(canon).collect();
        assert!(common.join("refs/heads/plyloft").is_dir());
        assert!(common.join("logs/refs/heads/plyloft").is_dir());
        assert_eq!(&grants[2..], &[common.join("refs/heads/plyloft"), common.join("logs/refs/heads/plyloft")]);
    }

    /// 1.169.1 (R3, Challenger): per-worktree config and reftable refs give
    /// no grants; an old git that echoes `--path-format=absolute` back too.
    #[test]
    fn worktree_config_reftable_and_an_old_git_give_no_grants() {
        let (repo, copy) = repo_with_card_copy("plyloft/card-x");
        crate::git::run(repo.path(), &["config", "extensions.worktreeConfig", "true"]).unwrap();
        assert!(codex_git_grants(&copy).unwrap_err().contains("worktreeConfig"));

        let reftable = tempfile::tempdir().unwrap();
        if crate::git::run(reftable.path(), &["init", "-q", "--ref-format=reftable", "-b", "main"]).is_ok() {
            for args in [&["config", "user.email", "t@t"][..], &["config", "user.name", "t"], &["commit", "--allow-empty", "-q", "-m", "init"]] {
                crate::git::run(reftable.path(), args).unwrap();
            }
            let copy = reftable.path().join("wt");
            crate::git::run(reftable.path(), &["worktree", "add", "-q", "-b", "plyloft/card-x", copy.to_str().unwrap()]).unwrap();
            assert!(codex_git_grants(&copy).unwrap_err().contains("reftable"));
        }

        assert!(parse_git_dirs("/p/.git/worktrees/c\n--path-format=absolute\n/p/.git\n").is_err());
        assert!(parse_git_dirs("/p/.git/worktrees/c\n.git\n").is_err());
        assert!(parse_git_dirs("/p/.git/worktrees/c\n").is_err());
        assert_eq!(
            parse_git_dirs("/p/.git/worktrees/c\n/p/.git\n").unwrap(),
            ("/p/.git/worktrees/c".to_string(), "/p/.git".to_string())
        );
    }

    /// 1.169.1 (R3, Challenger): a Codex Builder is told git's packed-refs
    /// error is harmless, before the task; Claude's preamble is unchanged.
    #[test]
    fn a_codex_builder_is_told_the_packed_refs_error_is_harmless() {
        let base = builder_preamble_for("Fix login", false);
        assert_eq!(with_codex_rules(base.clone(), "claude"), base);
        let codex = with_codex_rules(base.clone(), "codex");
        assert!(codex.ends_with("\n\nTask:\n"));
        let at = codex.find("packed-refs.lock").unwrap();
        assert!(at < codex.rfind("Task:").unwrap());
        assert!(codex.contains("`git log -1`"));
        let lane = with_codex_rules(crate::build_both::lane_preamble("Fix login"), "codex");
        assert!(lane.contains("built twice") && lane.contains("packed-refs.lock"));
    }

    /// 1.169.1 (R3): the project folder itself and a folder git can't read
    /// leave the argv exactly as it was.
    #[test]
    fn codex_outside_a_card_copy_gets_no_add_dir() {
        let (repo, _copy) = repo_with_card_copy("plyloft/card-x");
        assert_eq!(codex_git_grants(repo.path()).unwrap(), Vec::<String>::new());
        let plain = builder_args("codex", true, false, None, Some("do it"), None, &no_model()).unwrap();
        assert_eq!(codex_args_in(plain.clone(), repo.path(), "test"), plain);

        let not_git = tempfile::tempdir().unwrap();
        assert!(codex_git_grants(not_git.path()).is_err());
        assert_eq!(codex_args_in(plain.clone(), not_git.path(), "test"), plain);

        // No sandbox pair (a Claude argv), no dirs, a blank dir: unchanged.
        let claude = builder_args("claude", false, false, None, Some("do it"), None, &no_model()).unwrap();
        assert_eq!(with_codex_add_dirs(claude.clone(), &["/r/.git/objects".into()]), claude);
        assert_eq!(with_codex_add_dirs(plain.clone(), &[]), plain);
        assert_eq!(with_codex_add_dirs(plain.clone(), &["  ".into()]), plain);
    }

    /// 1.169.1 (R3): Git for Windows answers `C:/…`; Codex gets the Windows
    /// form, never the `\\?\` verbatim prefix. A unix path stays.
    #[test]
    fn codex_add_dir_takes_the_windows_form_of_the_git_dirs() {
        assert_eq!(codex_dir_arg("C:/Users/me/proj/.git/objects\n", true), r"C:\Users\me\proj\.git\objects");
        assert_eq!(codex_dir_arg(r"\\?\C:\Users\me\proj\.git", true), r"C:\Users\me\proj\.git");
        assert_eq!(codex_dir_arg("//server/share/proj/.git", true), r"\\server\share\proj\.git");
        assert_eq!(codex_dir_arg("/Users/me/proj/.git", false), "/Users/me/proj/.git");
        // A Windows common dir: the branch's directory joins with `/` and
        // comes out in the Windows form.
        let g = codex_git_grant_paths("C:/p/.git/worktrees/c", "C:/p/.git", "plyloft/card-x").unwrap();
        let g: Vec<String> = g.iter().map(|d| codex_dir_arg(d, true)).collect();
        assert_eq!(
            g,
            vec![r"C:\p\.git\worktrees\c", r"C:\p\.git\objects", r"C:\p\.git\refs\heads\plyloft", r"C:\p\.git\logs\refs\heads\plyloft"]
        );
    }

    /// #74: the Claude Builder row. Blank passes nothing; a model passes
    /// `--model <m>` and nothing else changes, resume included.
    #[test]
    fn claude_builder_row_adds_model_and_nothing_else() {
        let plain = builder_args("claude", false, false, None, Some("do it"), None, &no_model()).unwrap();
        assert!(!plain.iter().any(|arg| arg == "--model"));

        let model = ModelChoice {
            model: Some("opus".into()),
            reasoning: None,
        };
        let a = builder_args("claude", false, false, None, Some("do it"), None, &model).unwrap();
        assert_eq!(a, vec!["--model", "opus", "do it"]);
        let with_bypass = builder_args("claude", true, false, None, Some("do it"), None, &model).unwrap();
        assert_eq!(
            with_bypass,
            vec!["--dangerously-skip-permissions", "--model", "opus", "do it"]
        );
        let resumed = builder_args("claude", false, true, None, None, None, &model).unwrap();
        assert_eq!(resumed, vec!["--model", "opus", "--continue"]);
        // 1.169.0 (A1): Claude's effort after the model, on resume too.
        let effort = ModelChoice { model: Some("opus".into()), reasoning: Some("max".into()) };
        let a = builder_args("claude", false, false, None, Some("do it"), None, &effort).unwrap();
        assert_eq!(a, vec!["--model", "opus", "--effort", "max", "do it"]);
        let resumed = builder_args("claude", false, true, None, None, None, &effort).unwrap();
        assert_eq!(resumed, vec!["--model", "opus", "--effort", "max", "--continue"]);
    }

    /// #74: the Codex Builder row — model, reasoning effort, both, and
    /// `resume --last`, where the flags must land AFTER `resume`.
    #[test]
    fn codex_builder_row_adds_model_and_reasoning_after_resume() {
        let model_only = ModelChoice {
            model: Some("gpt-6-astra".into()),
            reasoning: None,
        };
        assert_eq!(
            builder_args("codex", false, false, None, Some("do it"), None, &model_only).unwrap(),
            vec!["-m", "gpt-6-astra", "--sandbox", "workspace-write", "do it"]
        );

        let effort_only = ModelChoice {
            model: None,
            reasoning: Some("low".into()),
        };
        assert_eq!(
            builder_args("codex", false, false, None, None, None, &effort_only).unwrap(),
            vec![
                "-c",
                "model_reasoning_effort=low",
                "--sandbox",
                "workspace-write"
            ]
        );

        let both = ModelChoice {
            model: Some("gpt-6-astra".into()),
            reasoning: Some("medium".into()),
        };
        assert_eq!(
            builder_args("codex", true, false, None, Some("do it"), None, &both).unwrap(),
            vec![
                "-m",
                "gpt-6-astra",
                "-c",
                "model_reasoning_effort=medium",
                "--sandbox",
                "workspace-write",
                "-a",
                "never",
                "do it"
            ]
        );

        let resumed = builder_args("codex", false, true, Some("019-own"), None, None, &both).unwrap();
        assert_eq!(
            resumed,
            vec![
                "resume",
                "019-own",
                "-m",
                "gpt-6-astra",
                "-c",
                "model_reasoning_effort=medium",
                "--sandbox",
                "workspace-write"
            ]
        );
        // `-m` / `-c` are options of the subcommand that runs the session.
        let resume_at = resumed.iter().position(|arg| arg == "resume").unwrap();
        assert!(resume_at < resumed.iter().position(|arg| arg == "-m").unwrap());
    }

    /// #74: nothing Ply does writes a model into the vendor's own config.
    #[test]
    fn a_model_row_never_names_the_vendor_config_files() {
        let both = ModelChoice {
            model: Some("gpt-6-astra".into()),
            reasoning: Some("medium".into()),
        };
        for vendor in ["claude", "codex"] {
            let args = builder_args(vendor, false, false, None, Some("do it"), None, &both).unwrap();
            assert!(!args
                .iter()
                .any(|arg| arg.contains(".claude/settings.json") || arg.contains(".codex/config.toml")));
        }
    }

    /// #74: the label the tile header, the record and the coverage line
    /// all read from.
    #[test]
    fn model_label_reads_the_way_a_human_would() {
        assert_eq!(no_model().label(), None);
        assert_eq!(
            ModelChoice {
                model: Some("opus".into()),
                reasoning: None
            }
            .label()
            .as_deref(),
            Some("opus")
        );
        assert_eq!(
            ModelChoice {
                model: Some("gpt-6-astra".into()),
                reasoning: Some("medium".into())
            }
            .label()
            .as_deref(),
            Some("gpt-6-astra medium")
        );
        assert_eq!(
            ModelChoice {
                model: None,
                reasoning: Some("low".into())
            }
            .label()
            .as_deref(),
            Some("low effort")
        );
    }

    #[test]
    fn unknown_vendor_is_refused() {
        assert!(builder_args("gemini", false, false, None, None, None, &no_model()).is_err());
    }

    #[test]
    fn preamble_forbids_push_and_names_build_done() {
        let p = builder_preamble("Fix login");
        assert!(p.contains("Fix login"));
        assert!(p.contains("do NOT push"));
        assert!(p.contains("Finish and check"));
        assert!(p.ends_with("Task:\n"));
        // Skills hub H5 (Challenger, Builder walk): the two copies of a
        // skill, and Plyloft's align commit — not on a pull request card.
        assert!(p.contains("Edit one copy only") && p.contains("`skill: align <name>`"));
        assert!(!builder_preamble_for("Fix login", true).contains("skill: align"));
    }

    #[test]
    fn challenger_is_always_the_other_vendor() {
        assert_eq!(challenger_for("claude"), "codex");
        assert_eq!(challenger_for("codex"), "claude");
        assert_eq!(challenger_for("anything-else"), "codex");
    }

    #[test]
    fn verdict_parsing_prefers_the_verdict_section() {
        assert_eq!(parse_verdict("## Verdict\nAPPROVE\n\n## Findings\nnone"), Some("approve"));
        assert_eq!(
            parse_verdict("## Verdict\nCHANGES_REQUESTED\n## Findings\n- I would approve after fixing X"),
            Some("changes_requested")
        );
        assert_eq!(parse_verdict("Verdict: changes requested — see below"), Some("changes_requested"));
        assert_eq!(parse_verdict("no structured answer"), None);
        assert_eq!(parse_verdict(""), None);
    }

    #[test]
    fn verdict_parsing_reads_incomplete_as_its_own_outcome() {
        assert_eq!(parse_verdict("## Verdict\nINCOMPLETE\n\n## Findings\nnone"), Some("incomplete"));
        assert_eq!(
            parse_verdict("## Verdict\nAPPROVE\n\n## Verification gaps\nThe supplied diff was truncated."),
            Some("incomplete")
        );
    }

    fn reviewer_record(verdict: Option<&str>, artifact: &str) -> crate::reviewer::ReviewerRecord {
        crate::reviewer::ReviewerRecord {
            id: "r1".into(),
            status: crate::reviewer::ReviewRunStatus::Completed,
            artifact: Some(artifact.into()),
            verdict: verdict.map(str::to_string),
            pass_count: 3,
            file_count: 29,
            incomplete_reason: (verdict == Some("incomplete")).then(|| "diff too large".into()),
            ..Default::default()
        }
    }

    /// GH #58: an incomplete review is presented as incomplete, keeps its
    /// pass count, and neither requests changes nor clears a status.
    #[test]
    fn incomplete_record_becomes_an_incomplete_card_review() {
        let record = reviewer_record(Some("incomplete"), "## Verdict\nINCOMPLETE");
        let (review, status) = challenger_review_from_record(&record, 7, "codex".into(), false, 9);
        assert_eq!(review.status, "done");
        assert_eq!(review.verdict.as_deref(), Some("incomplete"));
        assert_eq!(review.incomplete_reason.as_deref(), Some("diff too large"));
        assert_eq!((review.pass_count, review.file_count), (Some(3), Some(29)));
        assert_eq!(status, None, "incomplete does not touch reviewStatus");
        assert!(review_can_run_again(&review));

        let cr = reviewer_record(Some("changes_requested"), "## Verdict\nCHANGES_REQUESTED");
        let (review, status) = challenger_review_from_record(&cr, 7, "codex".into(), false, 9);
        assert_eq!(status, Some(Some(ReviewStatus::ChangesRequested)));
        assert!(!review_can_run_again(&review));

        // A record before GH #58 carries no merged verdict and no passes.
        let legacy = crate::reviewer::ReviewerRecord {
            pass_count: 0,
            verdict: None,
            ..reviewer_record(None, "## Verdict\nAPPROVE")
        };
        let (review, status) = challenger_review_from_record(&legacy, 7, "codex".into(), false, 9);
        assert_eq!(review.verdict.as_deref(), Some("approve"));
        assert_eq!(status, Some(None));
        assert_eq!(review.pass_count, None);
    }

    /// CL-5: a folded review settles on the card as one round, once —
    /// settling it again (a retried write) adds nothing; a failed one is no
    /// round, and a new session keeps the rounds.
    #[test]
    fn a_folded_review_settles_as_one_round_on_the_card() {
        let mut card = builder_card(vec![BuildSnapshot { n: 1, sha: "s1".into(), at: 0 }]);
        let counts = crate::review_ledger::RoundCounts { round: 1, new: 2, notes: 1, ..Default::default() };
        let record = crate::reviewer::ReviewerRecord {
            round: Some(counts.clone()),
            ..reviewer_record(Some("changes_requested"), "## Verdict\nCHANGES_REQUESTED")
        };
        let (review, _) = challenger_review_from_record(&record, 1, "codex".into(), false, 9);
        assert_eq!(review.round, Some(counts));
        record_settled_review(&mut card, review.clone(), None);
        record_settled_review(&mut card, review, None);
        let failed = crate::reviewer::ReviewerRecord {
            status: crate::reviewer::ReviewRunStatus::Failed,
            ..record.clone()
        };
        let (failed, _) = challenger_review_from_record(&failed, 2, "codex".into(), false, 10);
        assert_eq!(failed.round, None, "a failed review is no round");
        record_settled_review(&mut card, failed, None);
        let rounds = &card.builder.as_ref().unwrap().review_rounds;
        assert_eq!(rounds.len(), 1);
        assert_eq!(
            (rounds[0].round, rounds[0].verdict.as_str(), rounds[0].new, rounds[0].notes, rounds[0].provider.as_str(), rounds[0].at),
            (1, "changes_requested", 2, 1, "codex", 9)
        );
    }

    #[test]
    fn verdict_comment_names_an_incomplete_review_and_its_passes() {
        let record = reviewer_record(Some("incomplete"), "## Verdict\nINCOMPLETE");
        let (review, _) = challenger_review_from_record(&record, 7, "codex".into(), false, 9);
        let body = verdict_comment_body(&review, &[]);
        assert!(body.contains("**Verdict:** INCOMPLETE (diff too large) on build snapshot 7"));
        assert!(body.contains("Plyloft: 29 files, reviewed in 3 passes."));
    }

    #[test]
    fn excerpt_is_bounded() {
        let long = "x".repeat(REVIEW_EXCERPT_MAX + 50);
        let e = excerpt_of(&long);
        assert!(e.chars().count() <= REVIEW_EXCERPT_MAX + 2);
        assert!(e.ends_with('…'));
        assert_eq!(excerpt_of("short"), "short");
    }

    #[test]
    fn plan_challenge_section_lists_synthesis_decisions_and_open_points() {
        let fr = serde_json::json!({
            "answer": "Use one writer.",
            "agreements": ["Atomic JSON", "No leases"],
            "unresolvedQuestions": [],
            "disagreementResolutions": [
                {"disagreementId": "d3", "disposition": "resolved", "rationale": "Keep the mutex."},
                {"disagreementId": "d2", "disposition": "unresolved", "rationale": "No evidence."}
            ]
        });
        let ledger = vec![
            crate::discussion::DisagreementEntry {
                id: "d1".into(),
                raised_by: crate::discussion::DiscussionLegKind::CrossReviewA,
                statement: "Mutex vs channel".into(),
                rationale: String::new(),
                severity: "medium".into(),
                evidence_refs: vec![],
                related_ids: vec![],
            },
            crate::discussion::DisagreementEntry {
                id: "d2".into(),
                raised_by: crate::discussion::DiscussionLegKind::CrossReviewB,
                statement: "Retry policy".into(),
                rationale: String::new(),
                severity: "low".into(),
                evidence_refs: vec![],
                related_ids: vec![],
            },
            crate::discussion::DisagreementEntry {
                id: "d3".into(),
                raised_by: crate::discussion::DiscussionLegKind::CrossReviewB,
                statement: "Lock granularity".into(),
                rationale: String::new(),
                severity: "low".into(),
                evidence_refs: vec![],
                related_ids: vec![],
            },
        ];
        let challenge = crate::kanban::PlanChallenge {
            discussion_id: "x".into(),
            challenged_at: 1,
            brief: "b".into(),
            decisions: vec![crate::kanban::PlanDecision {
                disagreement_id: "d1".into(),
                statement: "Mutex vs channel".into(),
                decision: "mutex".into(),
            }],
        };
        let s = plan_challenge_section(Some(&fr), &ledger, &challenge, false);
        assert!(s.contains("Both vendors agreed:"));
        // OB-14 (D5): one vendor's two sessions are not "both vendors".
        let one = plan_challenge_section(Some(&fr), &ledger, &challenge, true);
        assert!(one.contains("Both sessions agreed:") && !one.contains("Both vendors"), "{one}");
        assert!(s.contains("Use one writer."));
        assert!(s.contains("- Atomic JSON"));
        assert!(s.contains("Mutex vs channel → DECIDED: mutex"));
        assert!(s.contains("Resolved by the synthesis"));
        assert!(s.contains("Lock granularity → resolved: Keep the mutex."));
        assert!(s.contains("Still open"));
        assert!(s.contains("- Retry policy"));
        assert!(!s.contains("- Lock granularity\n"), "synthesis-resolved is not open");
        assert!(s.contains("do not reopen"));
    }

    #[test]
    fn registry_is_keyed_by_card() {
        let r = BuilderRegistry::default();
        assert!(r.get_pty("c1").is_none());
        r.insert(BuilderSession {
            pty_id: "p1".into(),
            workspace_id: "ws".into(),
            card_id: "c1".into(),
            vendor: "claude".into(),
            capture: Arc::new(Mutex::new(b"hello".to_vec())),
            last_activity_at: Arc::new(AtomicI64::new(0)),
            claude_session_id: None,
            transcript: Arc::default(),
            });
        assert_eq!(r.get_pty("c1").as_deref(), Some("p1"));
        let replay = read_capture(&r, "c1").expect("a live session has a capture");
        assert_eq!(replay.data, b"hello".to_vec());
        assert_eq!(replay.end, 5, "where the replay ends in the stream");
        assert!(r.remove("c1").is_some());
        assert!(read_capture(&r, "c1").is_none());
    }

    /// Walk fix (blank Builder on the first start): a long capture replays
    /// its tail, and `end` still counts from the session's first byte, so
    /// the terminal can line the replay up with the live events' offsets.
    #[test]
    fn read_capture_replays_the_tail_and_says_where_it_ends() {
        let r = BuilderRegistry::default();
        let mut long = vec![b'a'; CAPTURE_REPLAY_MAX];
        long.extend_from_slice(b"\xe2\x9d\xaf end");
        r.insert(BuilderSession {
            pty_id: "p1".into(),
            workspace_id: "ws".into(),
            card_id: "c1".into(),
            vendor: "claude".into(),
            capture: Arc::new(Mutex::new(long.clone())),
            last_activity_at: Arc::new(AtomicI64::new(0)),
            claude_session_id: None,
            transcript: Arc::default(),
        });
        let replay = read_capture(&r, "c1").unwrap();
        assert_eq!(replay.data.len(), CAPTURE_REPLAY_MAX);
        assert_eq!(replay.end, long.len() as u64);
        assert!(replay.data.ends_with("\u{276f} end".as_bytes()), "raw bytes, not a lossy decode");
    }

    /// The raw IPC body: `end` little-endian, then the bytes; nothing for no session.
    #[test]
    fn capture_replay_encodes_end_then_bytes() {
        assert!(CaptureReplay::encode(None).is_empty());
        let body = CaptureReplay::encode(Some(CaptureReplay { data: b"hi".to_vec(), end: 258 }));
        assert_eq!(body, vec![2, 1, 0, 0, 0, 0, 0, 0, b'h', b'i']);
        let empty = CaptureReplay::encode(Some(CaptureReplay { data: Vec::new(), end: 0 }));
        assert_eq!(empty.len(), 8, "a fresh session's capture is not the no-session body");
    }

    /// SL-6: a card built by both has two sessions beside (never instead
    /// of) any card session, one per lane key; the pick re-keys the picked
    /// one to the card, and nothing moves onto a key that already has one.
    #[test]
    fn registry_keeps_both_builds_of_a_card_and_rekeys_the_pick() {
        let r = BuilderRegistry::default();
        let session = |key: &str, pty: &str| BuilderSession {
            pty_id: pty.into(),
            workspace_id: "ws".into(),
            card_id: key.into(),
            vendor: "claude".into(),
            capture: Arc::new(Mutex::new(pty.as_bytes().to_vec())),
            last_activity_at: Arc::new(AtomicI64::new(7)),
            claude_session_id: None,
            transcript: Arc::default(),
        };
        let (a, b) = (crate::build_both::lane_key("c1", "a"), crate::build_both::lane_key("c1", "b"));
        r.insert(session(&a, "pa"));
        r.insert(session(&b, "pb"));
        assert_eq!(r.get_pty(&a).as_deref(), Some("pa"));
        assert_eq!(r.get_pty(&b).as_deref(), Some("pb"));
        assert_eq!(r.get_pty("c1"), None, "the card itself has no session yet");
        assert_eq!(read_capture(&r, &b).map(|c| c.data), Some(b"pb".to_vec()));
        assert_eq!(r.last_output_at(&a), Some(7));
        assert!(r.rekey(&b, "c1"));
        assert_eq!(r.get_pty("c1").as_deref(), Some("pb"));
        assert_eq!(read_capture(&r, "c1").map(|c| c.data), Some(b"pb".to_vec()), "the same session, replayed");
        assert_eq!(r.get_pty(&b), None);
        assert!(!r.rekey(&a, "c1"), "never over a live card session");
        assert_eq!(r.get_pty(&a).as_deref(), Some("pa"));
        assert!(!r.rekey("nothing", "c2"));
        r.forget(&a);
        assert_eq!(r.get_pty(&a), None);
    }

    fn git_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "t@t"],
            &["config", "user.name", "t"],
            &["commit", "--allow-empty", "-q", "-m", "init"],
        ] {
            crate::git::run(dir.path(), args).unwrap();
        }
        dir
    }

    // ── F11 (team walk): closing a session ends its run ─────────────

    #[test]
    fn closing_a_running_builder_records_its_run_as_aborted() {
        let mut c = builder_card(Vec::new());
        c.builder.as_mut().unwrap().pty_id = Some("pty-1".into());
        c.last_run_status = Some(LastRunStatus::Running);
        apply_close(&mut c);
        let b = c.builder.as_ref().unwrap();
        assert_eq!((b.pty_id.as_deref(), b.session_lost, b.resume_failed), (None, false, false));
        assert_eq!(c.last_run_status, Some(LastRunStatus::Aborted));

        // A Build done already settled it: Success stays.
        let mut done = builder_card(Vec::new());
        done.builder.as_mut().unwrap().pty_id = Some("pty-1".into());
        done.last_run_status = Some(LastRunStatus::Success);
        apply_close(&mut done);
        assert_eq!(done.last_run_status, Some(LastRunStatus::Success));

        // A run a swarm or an agent run owns is not this close's to settle.
        let mut owned = builder_card(Vec::new());
        owned.last_run_status = Some(LastRunStatus::Running);
        owned.linked_swarm_id = Some("s1".into());
        apply_close(&mut owned);
        assert_eq!(owned.last_run_status, Some(LastRunStatus::Running));

        // No Builder: nothing of the card is touched.
        let mut bare = builder_card(Vec::new());
        bare.builder = None;
        bare.last_run_status = Some(LastRunStatus::Running);
        apply_close(&mut bare);
        assert_eq!(bare.last_run_status, Some(LastRunStatus::Running));
    }

    #[test]
    fn a_session_that_ended_on_its_own_aborts_its_run_only_when_it_is_the_cards() {
        let mut c = builder_card(Vec::new());
        c.builder.as_mut().unwrap().pty_id = Some("pty-2".into());
        c.last_run_status = Some(LastRunStatus::Running);
        // A stale exit of an older session changes nothing.
        apply_session_ended(&mut c, "pty-1", false);
        assert_eq!(c.builder.as_ref().unwrap().pty_id.as_deref(), Some("pty-2"));
        assert_eq!(c.last_run_status, Some(LastRunStatus::Running));
        apply_session_ended(&mut c, "pty-2", true);
        let b = c.builder.as_ref().unwrap();
        assert_eq!((b.pty_id.as_deref(), b.session_lost, b.resume_failed), (None, true, true));
        assert_eq!(c.last_run_status, Some(LastRunStatus::Aborted));
    }

    #[test]
    fn closing_never_settles_a_run_both_are_still_building() {
        // Build with both, undecided: the run is the two lanes', and a close of
        // the card's own (absent or set-aside) Builder must not end it.
        let mut c = builder_card(Vec::new());
        c.last_run_status = Some(LastRunStatus::Running);
        c.build_both = Some(crate::build_both::new_record("/r/a", "a", "/r/b", "b", true, 10));
        assert!(crate::build_both::is_undecided(&c));
        apply_close(&mut c);
        assert_eq!(c.last_run_status, Some(LastRunStatus::Running));
        c.builder.as_mut().unwrap().pty_id = Some("pty-x".into());
        apply_session_ended(&mut c, "pty-x", false);
        assert_eq!(c.last_run_status, Some(LastRunStatus::Running));
    }

    fn builder_card(snapshots: Vec<BuildSnapshot>) -> KanbanCard {
        let mut card: KanbanCard = serde_json::from_str(
            r#"{"id":"c1","workspaceId":"ws","title":"t","columnId":"in_progress","createdAt":0,"updatedAt":0}"#,
        )
        .unwrap();
        card.builder = Some(BuilderState {
            vendor: "claude".into(),
            bypass: false,
            model: None,
            pty_id: None,
            session_lost: false,
            resume_failed: false,
            started_at: 0,
            snapshots,
            review: None,
            last_reviewed_revision: None,
            shipped_unreviewed: None,
            first_review_done: false,
            changes_requested_count: 0,
            user_corrections: 0,
            correction_texts: Vec::new(),
            review_decisions: Vec::new(),
            follow_up: None,
            self_check: None,
            waiting_review: None,
            handed_over: None,
            undelivered_verdict: None,
            review_rounds: Vec::new(),
            chosen_model: None,
            claude_session_id: None,
            permission_mode: None,
            permissions: None,
            lost_on_restart: false,
            self_check_started_at: None,
            pr_draft: None,
        });
        card
    }

    /// ADR 0006: every changes-requested verdict that settles counts
    /// toward `Ship with follow-up`; a running review, an approve or an
    /// incomplete one does not.
    #[test]
    fn changes_requested_verdicts_are_counted_on_the_card() {
        let mut card = builder_card(vec![BuildSnapshot { n: 1, sha: "s1".into(), at: 0 }]);
        let review = |status: &str, verdict: Option<&str>| BuilderReview {
            snapshot_n: 1,
            status: status.into(),
            verdict: verdict.map(str::to_string),
            ..Default::default()
        };
        record_settled_review(&mut card, review("running", None), None);
        record_settled_review(&mut card, review("done", Some("changes_requested")), None);
        record_settled_review(&mut card, review("done", Some("incomplete")), None);
        record_settled_review(&mut card, review("done", Some("changes_requested")), None);
        record_settled_review(&mut card, review("done", Some("approve")), None);
        assert_eq!(card.builder.as_ref().unwrap().changes_requested_count, 2);
        let legacy: BuilderState = serde_json::from_str(r#"{"vendor":"claude","snapshots":[]}"#).unwrap();
        assert_eq!(legacy.changes_requested_count, 0);
        assert!(legacy.follow_up.is_none());
    }

    /// PR #27: the Builder edited after the last Build done and Ship
    /// flushed those edits into the PR unverified. Ship now refuses a
    /// worktree that moved past the last snapshot — uncommitted edits,
    /// new files, or commits the Builder made itself.
    #[test]
    fn ship_refuses_a_builder_worktree_that_moved_past_its_snapshot() {
        let repo = git_repo();
        let wt = repo.path();
        let head = crate::worktrees::head_sha(wt).unwrap();
        let card = builder_card(vec![BuildSnapshot { n: 1, sha: head, at: 1 }]);
        assert_eq!(require_at_last_snapshot(&card, wt), Ok(()));

        std::fs::write(wt.join("after.txt"), "edited after Build done\n").unwrap();
        assert_eq!(
            require_at_last_snapshot(&card, wt),
            Err(CHANGED_AFTER_BUILD_DONE.to_string()),
            "an uncommitted edit is refused, not flushed"
        );
        assert!(
            crate::worktrees::worktree_is_dirty(wt).unwrap(),
            "the refusal must leave the edit uncommitted"
        );

        crate::git::run(wt, &["add", "-A"]).unwrap();
        crate::git::run(wt, &["commit", "-q", "-m", "builder's own commit"]).unwrap();
        assert_eq!(
            require_at_last_snapshot(&card, wt),
            Err(CHANGED_AFTER_BUILD_DONE.to_string()),
            "a commit past the snapshot is just as unverified"
        );

        let no_snapshot = builder_card(Vec::new());
        assert!(require_at_last_snapshot(&no_snapshot, wt)
            .unwrap_err()
            .contains("work isn't saved yet"));
    }

    /// PR #27's snapshot list showed 358af202 twice. Build done on an
    /// unchanged tree returns the existing entry instead.
    #[test]
    fn snapshot_list_never_repeats_a_sha() {
        use SnapshotRecord::*;
        let mut b = builder_card(Vec::new()).builder.unwrap();
        assert_eq!(record_snapshot(&mut b, "aaa", 1), (BuildSnapshot { n: 1, sha: "aaa".into(), at: 1 }, New));
        assert_eq!(record_snapshot(&mut b, "bbb", 2), (BuildSnapshot { n: 2, sha: "bbb".into(), at: 2 }, New));
        assert_eq!(
            record_snapshot(&mut b, "bbb", 3),
            (BuildSnapshot { n: 2, sha: "bbb".into(), at: 2 }, Unchanged),
            "no new snapshot on an unchanged tree"
        );
        assert_eq!(
            record_snapshot(&mut b, "aaa", 4),
            (BuildSnapshot { n: 1, sha: "aaa".into(), at: 4 }, Reselected),
            "a tree reset to an older snapshot re-selects it, keeping its number"
        );
        assert_eq!(record_snapshot(&mut b, "ccc", 5).0.n, 3, "numbers stay unique after a re-select");
        let shas: Vec<&str> = b.snapshots.iter().map(|s| s.sha.as_str()).collect();
        assert_eq!(shas, ["bbb", "aaa", "ccc"]);
    }

    /// Challenger P2: with snapshots A and B, resetting to A must reach a
    /// shippable state — Build done re-selects A instead of a no-op that
    /// leaves Ship refusing HEAD forever.
    #[test]
    fn returning_to_an_older_snapshot_can_ship_after_build_done() {
        let repo = git_repo();
        let wt = repo.path();
        let a = crate::worktrees::head_sha(wt).unwrap();
        crate::git::run(wt, &["commit", "--allow-empty", "-q", "-m", "b"]).unwrap();
        let b = crate::worktrees::head_sha(wt).unwrap();
        let mut card = builder_card(vec![
            BuildSnapshot { n: 1, sha: a.clone(), at: 1 },
            BuildSnapshot { n: 2, sha: b, at: 2 },
        ]);
        crate::git::run(wt, &["reset", "-q", "--hard", &a]).unwrap();
        assert!(require_at_last_snapshot(&card, wt).is_err(), "Ship refuses until Build done");

        let (snapshot, kind) = record_snapshot(card.builder.as_mut().unwrap(), &a, 3);
        assert_eq!((snapshot.n, kind), (1, SnapshotRecord::Reselected));
        assert_eq!(require_at_last_snapshot(&card, wt), Ok(()));
        assert_eq!(publish_rev(&card, "branch"), a);
        assert_eq!(card.builder.as_ref().unwrap().snapshots.len(), 2);
    }

    /// Challenger (snapshot 2) P2: the reported legacy list `[A, B, B]`
    /// must not re-select B on every Build done.
    #[test]
    fn legacy_duplicate_snapshots_normalize_and_build_done_is_idempotent() {
        let mut b = builder_card(vec![
            BuildSnapshot { n: 1, sha: "aaa".into(), at: 1 },
            BuildSnapshot { n: 2, sha: "358af202".into(), at: 2 },
            BuildSnapshot { n: 3, sha: "358af202".into(), at: 3 },
        ])
        .builder
        .unwrap();
        for at in [10, 11] {
            let (snapshot, kind) = record_snapshot(&mut b, "358af202", at);
            assert_eq!(kind, SnapshotRecord::Unchanged, "repeated Build done is a no-op");
            assert_eq!(snapshot.sha, "358af202");
        }
        let shas: Vec<&str> = b.snapshots.iter().map(|s| s.sha.as_str()).collect();
        assert_eq!(shas, ["aaa", "358af202"]);
        assert_eq!(record_snapshot(&mut b, "new", 12).0.n, 4, "numbering continues past legacy entries");
    }

    /// Challenger (snapshot 2) P1: A → edited to B → Verify passes on B →
    /// restored to A. The pass belongs to B's content, so A may not ship.
    #[test]
    fn builder_ship_requires_a_pass_attributed_to_the_snapshot_content() {
        use crate::kanban::{VerifyEntry, VerifyStatus};
        let entry = |status, tree: &str| VerifyEntry {
            verify_run_id: "v".into(),
            status,
            ended_at: 1,
            summary: None,
            steps: Vec::new(),
            tree_sha: Some(tree.into()),
        };
        let repo = git_repo();
        let wt = repo.path();
        std::fs::write(wt.join("a.txt"), "A\n").unwrap();
        crate::worktrees::commit_pending_in_worktree(wt, "build: snapshot 1").unwrap();
        let a = crate::worktrees::head_sha(wt).unwrap();
        let tree_a = crate::worktrees::content_tree_sha(wt).unwrap();
        std::fs::write(wt.join("a.txt"), "B\n").unwrap();
        let tree_b = crate::worktrees::content_tree_sha(wt).unwrap();
        std::fs::write(wt.join("a.txt"), "A\n").unwrap();

        let mut card = builder_card(vec![BuildSnapshot { n: 1, sha: a, at: 1 }]);
        card.verify_history = vec![entry(VerifyStatus::Passed, &tree_b)];
        assert!(require_verified_snapshot(&card, wt, false).unwrap_err().contains("has not run"));
        card.verify_history.push(entry(VerifyStatus::Failed, &tree_a));
        assert!(require_verified_snapshot(&card, wt, false).unwrap_err().contains("failed"));
        card.verify_history.push(entry(VerifyStatus::Passed, &tree_a));
        assert!(require_verified_snapshot(&card, wt, true).unwrap_err().contains("still running"));
        assert_eq!(require_verified_snapshot(&card, wt, false), Ok(()));
    }

    /// Challenger (snapshot 3) P1: the worktree can change between the
    /// snapshot check and the verification lookup. The lookup is pinned to
    /// the snapshot SHA, so a pass on whatever the worktree holds now (B)
    /// never vouches for the snapshot Ship publishes (A).
    #[test]
    fn snapshot_verification_is_pinned_to_the_snapshot_sha_not_the_worktree() {
        use crate::kanban::{VerifyEntry, VerifyStatus};
        let passed = |tree: &str| VerifyEntry {
            verify_run_id: "v".into(),
            status: VerifyStatus::Passed,
            ended_at: 1,
            summary: None,
            steps: Vec::new(),
            tree_sha: Some(tree.into()),
        };
        let repo = git_repo();
        let wt = repo.path();
        std::fs::write(wt.join("a.txt"), "A\n").unwrap();
        crate::worktrees::commit_pending_in_worktree(wt, "build: snapshot 1").unwrap();
        let a = crate::worktrees::head_sha(wt).unwrap();
        let tree_a = crate::worktrees::content_tree_sha(wt).unwrap();
        // The open session moves on: worktree now holds B, and B has a pass.
        std::fs::write(wt.join("a.txt"), "B\n").unwrap();
        let tree_b = crate::worktrees::content_tree_sha(wt).unwrap();

        let mut card = builder_card(vec![BuildSnapshot { n: 1, sha: a, at: 1 }]);
        card.verify_history = vec![passed(&tree_b)];
        assert!(
            require_snapshot_verified(&card, wt, false).unwrap_err().contains("has not run"),
            "B's pass must not vouch for snapshot A"
        );
        card.verify_history.push(passed(&tree_a));
        assert_eq!(require_snapshot_verified(&card, wt, false), Ok(()), "even while the worktree holds B");
    }

    /// UX P-D2: the refusals a person reads say "round" and "the card's
    /// copy", never the developer words (D4).
    #[test]
    fn person_facing_refusals_use_plain_words() {
        let card = builder_card(Vec::new());
        let gone = require_builder_worktree(&card).unwrap_err();
        assert_eq!(
            gone,
            "This Builder card's own copy of the repository is gone, so Ship can't check its saved work against your checks. Nothing was shipped."
        );
        assert_eq!(
            MERGE_UNREVIEWED_REFUSAL,
            "The Reviewer has not approved the last round, so nothing was merged. Choose Merge anyway to bring it in without an approved review."
        );
        for line in [gone.as_str(), MERGE_UNREVIEWED_REFUSAL, CHANGED_AFTER_BUILD_DONE] {
            for word in ["worktree", "snapshot", "Build done", "origin", "stash"] {
                assert!(!line.contains(word), "{word} in {line}");
            }
        }
    }

    /// Challenger (snapshot 4) P1: a missing Builder worktree is refused,
    /// not shipped around.
    #[test]
    fn missing_builder_worktree_is_refused() {
        let repo = git_repo();
        let mut card = builder_card(Vec::new());
        assert!(require_builder_worktree(&card).unwrap_err().contains("copy of the repository is gone"));
        card.worktree_path = Some(repo.path().join("gone").to_string_lossy().into_owned());
        assert!(require_builder_worktree(&card).is_err());
        card.worktree_path = Some(repo.path().to_string_lossy().into_owned());
        assert_eq!(require_builder_worktree(&card), Ok(()));
        card.builder = None;
        card.worktree_path = None;
        assert_eq!(require_builder_worktree(&card), Ok(()), "only Builder cards need one");
    }

    /// Card #38, snapshot 5: the Challenger requested changes, the Builder
    /// pushed back without touching code, Verify had passed. A board with
    /// that card, its worktree at the snapshot.
    fn pushback_fixture() -> (tempfile::TempDir, tempfile::TempDir, KanbanStore) {
        use crate::kanban::{VerifyEntry, VerifyStatus};
        let repo = git_repo();
        let wt = repo.path();
        std::fs::write(wt.join("a.txt"), "A\n").unwrap();
        crate::worktrees::commit_pending_in_worktree(wt, "build: snapshot 5").unwrap();
        let sha = crate::worktrees::head_sha(wt).unwrap();
        let tree = crate::worktrees::content_tree_sha(wt).unwrap();
        let mut card = builder_card(vec![
            BuildSnapshot { n: 4, sha: "older".into(), at: 1 },
            BuildSnapshot { n: 5, sha, at: 2 },
        ]);
        card.worktree_path = Some(wt.to_string_lossy().into_owned());
        card.last_run_status = Some(LastRunStatus::Success);
        card.review_status = Some(ReviewStatus::ChangesRequested);
        card.verify_history = vec![VerifyEntry {
            verify_run_id: "v5".into(),
            status: VerifyStatus::Passed,
            ended_at: 3,
            summary: None,
            steps: Vec::new(),
            tree_sha: Some(tree),
        }];
        card.builder.as_mut().unwrap().review = Some(BuilderReview {
            snapshot_n: 5,
            provider: "codex".into(),
            degraded: false,
            status: "done".into(),
            verdict: Some("changes_requested".into()),
            review_id: Some("r5".into()),
            excerpt: Some("P2: rename this".into()),
            error: None,
            at: 4,
            note: None,
            overridden_by: None,
            pass_count: None,
            file_count: None,
            incomplete_reason: None,
            model: None,
            ..Default::default()
        });
        let state = tempfile::tempdir().unwrap();
        let kanban = KanbanStore::new(state.path().to_path_buf()).unwrap();
        kanban.save("ws", vec![card]).unwrap();
        (repo, state, kanban)
    }

    /// GH #124: `pushback_fixture` with the Challenger still reviewing
    /// snapshot 5 — the card's first review — in `slots`.
    fn reviewing_fixture() -> (tempfile::TempDir, tempfile::TempDir, KanbanStore, crate::reviewer::ReviewSlots) {
        let (repo, state, kanban) = pushback_fixture();
        kanban
            .with_card("ws", "c1", |c| {
                c.review_status = None;
                let b = c.builder.as_mut().unwrap();
                b.review = Some(running_review(5, &b.vendor, ReviewKind::Sweep, 4));
                Ok(())
            })
            .unwrap();
        let slots = crate::reviewer::ReviewSlots::default();
        slots.admit("ws", "c1", |_| Ok::<_, String>(()), |_| true).unwrap();
        (repo, state, kanban, slots)
    }

    /// Build done through the slots, as `done` does it.
    fn build_done_in(
        slots: &crate::reviewer::ReviewSlots,
        kanban: &KanbanStore,
        skip_review: bool,
    ) -> (BuildDone, Option<ChallengerJob>) {
        // The kind as `done` reads it, from the card as it stands under
        // the lock (no reviewer records in these fixtures).
        build_done_in_slots(slots, kanban, "ws", "c1", skip_review, None, None, || {
            crate::review_context::kind_for_card(&[], kanban.get_card("ws", "c1").ok().as_ref())
        })
        .unwrap()
    }

    /// The ended review settles and the waiting one starts, in one card
    /// write under the slots' lock, as `settle_and_take_next` does it.
    fn settle_in(
        slots: &crate::reviewer::ReviewSlots,
        kanban: &KanbanStore,
        review: BuilderReview,
        review_status: Option<Option<ReviewStatus>>,
        records: &[crate::reviewer::ReviewerRecord],
    ) -> Option<ChallengerJob> {
        settle_in_slots(slots, kanban, "ws", "c1", || records.to_vec(), (review, review_status), 10)
    }

    fn settled_review(snapshot_n: u32, status: &str, verdict: Option<&str>) -> BuilderReview {
        BuilderReview {
            snapshot_n,
            provider: "codex".into(),
            status: status.into(),
            verdict: verdict.map(str::to_string),
            kind: ReviewKind::Sweep,
            ..Default::default()
        }
    }

    /// 1.171.0 C2: the self-check Finish and check asked for is kept on the
    /// card (unstamped) until that Finish and check goes on — Plyloft quit
    /// during it leaves it behind for the card to say — and Build done
    /// clears it, with or without a new snapshot.
    #[test]
    fn the_self_check_start_is_kept_until_finish_and_check_goes_on() {
        let (repo, _state, kanban) = pushback_fixture();
        let before = kanban.get_card("ws", "c1").unwrap().updated_at;
        mark_self_check_started(&kanban, "ws", "c1", 77).unwrap();
        let card = kanban.get_card("ws", "c1").unwrap();
        assert_eq!(card.builder.as_ref().unwrap().self_check_started_at, Some(77));
        assert_eq!(card.updated_at, before, "asking for it is no change to the card");
        // A relaunch reads it back from the file.
        let reloaded = KanbanStore::new(_state.path().to_path_buf()).unwrap();
        assert_eq!(reloaded.get_card("ws", "c1").unwrap().builder.unwrap().self_check_started_at, Some(77));
        // Finish and check goes on: cleared, whatever it recorded.
        std::fs::write(repo.path().join("b.txt"), "fix\n").unwrap();
        let slots = crate::reviewer::ReviewSlots::default();
        let (result, _) = build_done_in(&slots, &kanban, true);
        assert!(result.new_snapshot);
        assert_eq!(kanban.get_card("ws", "c1").unwrap().builder.unwrap().self_check_started_at, None);
        // An unchanged tree clears it too.
        mark_self_check_started(&kanban, "ws", "c1", 78).unwrap();
        let (result, _) = build_done_in(&slots, &kanban, true);
        assert!(!result.new_snapshot);
        assert_eq!(kanban.get_card("ws", "c1").unwrap().builder.unwrap().self_check_started_at, None);
    }

    /// 1.171.0 C2 (Challenger 2): a Finish and check refused on a conflict
    /// still marked clears the self-check it asked for, so the card never
    /// later says the session ended mid re-read.
    #[test]
    fn a_refused_finish_and_check_clears_the_self_check_start() {
        let (repo, _state, kanban) = pushback_fixture();
        let wt = repo.path();
        let git = |args: &[&str]| {
            let out = crate::platform::git_command().args(args).current_dir(wt).output().unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let main = git(&["rev-parse", "--abbrev-ref", "HEAD"]);
        git(&["checkout", "-q", "-b", "side"]);
        std::fs::write(wt.join("a.txt"), "side\n").unwrap();
        git(&["commit", "-qam", "side"]);
        git(&["checkout", "-q", &main]);
        std::fs::write(wt.join("a.txt"), "mine\n").unwrap();
        git(&["commit", "-qam", "mine"]);
        git(&["merge", "-q", "side"]);
        assert!(crate::ship_conflict::merge_pending(wt).is_some(), "a merge with its marks pending");
        mark_self_check_started(&kanban, "ws", "c1", 77).unwrap();
        let slots = crate::reviewer::ReviewSlots::default();
        let refused = build_done_in_slots(&slots, &kanban, "ws", "c1", true, None, None, || ReviewKind::Sweep);
        assert!(refused.is_err(), "refused while the conflict is marked");
        assert_eq!(kanban.get_card("ws", "c1").unwrap().builder.unwrap().self_check_started_at, None);
    }

    /// GH #124 (found on #111): a Build done during a running review waits
    /// for it instead of starting a second sweep; a newer one replaces the
    /// waiting one; when the sweep judged the change, the waiting review
    /// starts as its follow-up.
    #[test]
    fn a_build_done_during_a_running_review_waits_and_becomes_a_follow_up() {
        let (repo, _state, kanban, slots) = reviewing_fixture();
        let wt = repo.path();

        std::fs::write(wt.join("b.txt"), "fix\n").unwrap();
        let (result, job) = build_done_in(&slots, &kanban, false);
        assert!(result.new_snapshot);
        assert_eq!(job, None, "no second review is spawned");
        assert_eq!(result.review_waiting_on, Some(5));
        let card = kanban.get_card("ws", "c1").unwrap();
        let b = card.builder.as_ref().unwrap();
        assert_eq!(b.snapshots.last().unwrap().n, 6);
        let review = b.review.as_ref().unwrap();
        assert_eq!((review.snapshot_n, review.status.as_str()), (5, "running"), "the running review keeps the card");
        assert_eq!(b.waiting_review.as_ref().map(|w| w.snapshot_n), Some(6));

        // A third Build done replaces the waiting one: never a queue.
        std::fs::write(wt.join("c.txt"), "another fix\n").unwrap();
        let (result, job) = build_done_in(&slots, &kanban, false);
        assert_eq!((job, result.review_waiting_on), (None, Some(5)));
        let card = kanban.get_card("ws", "c1").unwrap();
        assert_eq!(card.builder.as_ref().unwrap().waiting_review.as_ref().map(|w| w.snapshot_n), Some(7));

        // The sweep of snapshot 5 requests changes: snapshot 7 starts at
        // once as its follow-up, and the card stays reviewing.
        let next = settle_in(
            &slots,
            &kanban,
            settled_review(5, "done", Some("changes_requested")),
            Some(Some(ReviewStatus::ChangesRequested)),
            &[],
        )
        .expect("the waiting review starts");
        assert_eq!(next.snapshot_n, 7);
        assert_eq!(next.kind, ReviewKind::FollowUp);
        assert_eq!(next.pass_budget, crate::review_passes::PASS_DIFF_BUDGET);
        assert!(slots.is_reviewing("ws", "c1"));
        let card = kanban.get_card("ws", "c1").unwrap();
        let b = card.builder.as_ref().unwrap();
        assert!(b.first_review_done && b.waiting_review.is_none());
        assert_eq!(b.changes_requested_count, 1, "the sweep's verdict counts");
        let review = b.review.as_ref().unwrap();
        assert_eq!((review.snapshot_n, review.status.as_str(), review.kind), (7, "running", ReviewKind::FollowUp));
        assert_eq!(card.review_status, None, "the newer snapshot supersedes the request for changes");

        // A Build done while that follow-up runs waits for it in turn.
        std::fs::write(wt.join("d.txt"), "more\n").unwrap();
        let (result, job) = build_done_in(&slots, &kanban, false);
        assert_eq!((job, result.review_waiting_on), (None, Some(7)));

        // Nothing else waits once that one ran: the card is free, and the
        // next Build done starts its review.
        assert_eq!(
            settle_in(&slots, &kanban, settled_review(7, "done", Some("approve")), Some(None), &[]).map(|job| job.snapshot_n),
            Some(8)
        );
        assert_eq!(settle_in(&slots, &kanban, settled_review(8, "done", Some("approve")), Some(None), &[]), None);
        assert!(!slots.is_reviewing("ws", "c1"));
        std::fs::write(wt.join("e.txt"), "last\n").unwrap();
        let (result, job) = build_done_in(&slots, &kanban, false);
        assert_eq!(result.review_waiting_on, None);
        let job = job.expect("a free card starts its review");
        assert_eq!(job.snapshot_n, 9);
        assert_eq!(job.kind, ReviewKind::FollowUp, "the kind is read after the last review settled");
        assert!(slots.is_reviewing("ws", "c1"));
    }

    /// GH #124 (self-check): the kind is read under the slots' lock. A
    /// sweep that ends just before Build done has settled by then, so the
    /// new review follows up on it instead of sweeping again.
    #[test]
    fn a_review_that_ended_just_before_build_done_makes_it_a_follow_up() {
        let (repo, _state, kanban, slots) = reviewing_fixture();
        assert_eq!(
            settle_in(&slots, &kanban, settled_review(5, "done", Some("changes_requested")), None, &[]),
            None
        );
        std::fs::write(repo.path().join("b.txt"), "fix\n").unwrap();
        let (_, job) = build_done_in(&slots, &kanban, false);
        assert_eq!(job.map(|job| job.kind), Some(ReviewKind::FollowUp));
        let card = kanban.get_card("ws", "c1").unwrap();
        assert_eq!(card.builder.unwrap().review.unwrap().kind, ReviewKind::FollowUp);
    }

    /// GH #124: a first review that ended without judging the change
    /// (failed) leaves the waiting one to #110's rules: with no completed
    /// review, a sweep.
    #[test]
    fn a_failed_first_review_leaves_the_waiting_one_to_the_fallback_rules() {
        let (repo, _state, kanban, slots) = reviewing_fixture();
        std::fs::write(repo.path().join("b.txt"), "fix\n").unwrap();
        assert_eq!(build_done_in(&slots, &kanban, false).1, None);
        let failed = crate::reviewer::ReviewerRecord {
            status: crate::reviewer::ReviewRunStatus::Failed,
            ..Default::default()
        };
        let next = settle_in(&slots, &kanban, settled_review(5, "failed", None), None, &[failed])
            .expect("the waiting review starts");
        assert_eq!((next.snapshot_n, next.kind), (6, ReviewKind::Sweep));
        let card = kanban.get_card("ws", "c1").unwrap();
        assert!(!card.builder.as_ref().unwrap().first_review_done);

        // An interrupted one (Ply restarted) counts for nothing either.
        let mut card = card;
        let b = card.builder.as_mut().unwrap();
        b.waiting_review = Some(WaitingReview { snapshot_n: 6, requested_at: 1 });
        let interrupted = crate::reviewer::ReviewerRecord {
            status: crate::reviewer::ReviewRunStatus::Interrupted,
            ..Default::default()
        };
        assert_eq!(start_waiting(&mut card, &[interrupted], 1).map(|job| job.kind), Some(ReviewKind::Sweep));
        // A snapshot that is gone does not start.
        card.builder.as_mut().unwrap().waiting_review = Some(WaitingReview { snapshot_n: 99, requested_at: 1 });
        assert_eq!(start_waiting(&mut card, &[], 1), None);
        assert!(card.builder.as_ref().unwrap().waiting_review.is_none());
    }

    /// Findings filter: dismissing the last blocking finding of a request
    /// for changes on the current snapshot turns it into an approval the
    /// Builder hears; with another blocking finding open, the request stands
    /// and only the ledger the card shows changes.
    #[test]
    fn dismissing_the_last_blocking_finding_approves_the_current_review() {
        use crate::review_ledger::{CardLedger, FindingState};
        let card_with = |ledger: Vec<crate::review_ledger::LedgerFinding>| {
            let mut card = builder_card(vec![BuildSnapshot { n: 2, sha: "s2".into(), at: 0 }]);
            card.review_status = Some(ReviewStatus::ChangesRequested);
            let mut review = settled_review(2, "done", Some("changes_requested"));
            review.builder_handoff = Some("New findings: F1".into());
            review.reviewed_revision = Some("rev2".into());
            review.ledger = ledger;
            card.builder.as_mut().unwrap().review = Some(review);
            card
        };
        let mut ledger = CardLedger {
            findings: vec![
                ledger_finding("F1", "P2", FindingState::Open),
                ledger_finding("F2", "P3", FindingState::Open),
            ],
            reviewed_revision: Some("rev2".into()),
            ..CardLedger::new("ws", "c1")
        };
        let mut card = card_with(ledger.findings.clone());
        crate::review_ledger::dismiss(&mut ledger, "F1", Some("intended"), Some("me@x"), 50).unwrap();
        // Scenario A: a pass failed (after its retry): its files were never
        // read, so the request stands; the dismissal is still shown.
        let mut failed_pass = card.clone();
        failed_pass.builder.as_mut().unwrap().review.as_mut().unwrap().failed_passes = Some(1);
        assert!(!apply_dismissal(&mut failed_pass, &ledger, "F1", 60));
        let kept = failed_pass.builder.as_ref().unwrap().review.clone().unwrap();
        assert_eq!(kept.verdict.as_deref(), Some("changes_requested"));
        assert!(kept.ledger[0].dismissal.is_some());
        assert_eq!(failed_pass.review_status, Some(ReviewStatus::ChangesRequested));
        // Scenario B: the Challenger wrote INCOMPLETE and the ledger read it
        // as a request (partial; the ledger's baseline stayed behind).
        let mut incomplete = card.clone();
        incomplete.builder.as_mut().unwrap().review.as_mut().unwrap().partial = true;
        assert!(!apply_dismissal(&mut incomplete, &ledger, "F1", 60));
        let stale = CardLedger { reviewed_revision: Some("rev1".into()), ..ledger.clone() };
        let mut behind = card.clone();
        assert!(!apply_dismissal(&mut behind, &stale, "F1", 60), "a ledger whose baseline stayed behind");
        // Schema: a review written before `partial` loads as whole, and the
        // flag stays out of the file while false.
        let plain = serde_json::to_value(settled_review(2, "done", Some("approve"))).unwrap();
        assert!(plain.get("partial").is_none());
        let back: BuilderReview = serde_json::from_value(plain).unwrap();
        assert!(!back.partial);
        // A whole review: the request becomes Plyloft's approval.
        assert!(apply_dismissal(&mut card, &ledger, "F1", 60));
        let summary = dismissal_summary(&card).unwrap();
        assert!(summary.contains("Plyloft's reading after a human decision") && summary.contains("F1 (P2 — Defect F1) by me@x: \"intended\""), "{summary}");
        let comment = verdict_comment_body(card.builder.as_ref().unwrap().review.as_ref().unwrap(), &[]);
        assert!(comment.contains("**Plyloft's reading:** Plyloft reads this review as APPROVE: the member dismissed F1"), "{comment}");
        assert!(comment.contains("Reviewer findings dismissed as not a real issue: F1"), "{comment}");
        let b = card.builder.as_ref().unwrap();
        let review = b.review.as_ref().unwrap();
        assert_eq!(review.verdict.as_deref(), Some("approve"));
        assert!(review.ledger_note.as_deref().unwrap().contains("dismissed F1"));
        assert!(review.builder_handoff.is_none() && review.at == 60);
        assert!(review.ledger[0].dismissal.is_some(), "the card shows it dismissed");
        assert_eq!(b.undelivered_verdict, Some(UndeliveredVerdict { snapshot_n: 2, at: 60 }));
        assert_eq!(card.review_status, None);

        // Another blocking finding is open: the request stands.
        let mut ledger = CardLedger {
            findings: vec![
                ledger_finding("F1", "P2", FindingState::Open),
                ledger_finding("F3", "P1", FindingState::StillOpen),
            ],
            reviewed_revision: Some("rev2".into()),
            ..CardLedger::new("ws", "c1")
        };
        let mut card = card_with(ledger.findings.clone());
        crate::review_ledger::dismiss(&mut ledger, "F1", None, None, 50).unwrap();
        assert!(!apply_dismissal(&mut card, &ledger, "F1", 60));
        // Still said in the receipt, without claiming an approval.
        assert_eq!(
            dismissal_summary(&card).as_deref(),
            Some("Reviewer findings dismissed as not a real issue: F1 (P2 — Defect F1) by the human.")
        );
        let review = card.builder.as_ref().unwrap().review.clone().unwrap();
        assert_eq!(review.verdict.as_deref(), Some("changes_requested"));
        assert!(review.ledger[0].dismissal.is_some());
        assert_eq!(card.review_status, Some(ReviewStatus::ChangesRequested));
    }

    fn ledger_finding(id: &str, severity: &str, state: crate::review_ledger::FindingState) -> crate::review_ledger::LedgerFinding {
        crate::review_ledger::LedgerFinding {
            id: id.into(),
            severity: Some(severity.into()),
            title: format!("Defect {id}"),
            body: format!("The whole text of {id}."),
            round: 1,
            state,
            ..Default::default()
        }
    }

    /// Snapshot 5's sweep asks for changes on F3 and F4 (F1 is closed, F2
    /// a P3) while snapshot 6 waits: the card goes straight to 6's
    /// follow-up, and snapshot 5's verdict is never shown or sent.
    fn handed_over_fixture() -> (tempfile::TempDir, tempfile::TempDir, KanbanStore, crate::reviewer::ReviewSlots) {
        use crate::review_ledger::FindingState;
        let (repo, state, kanban, slots) = reviewing_fixture();
        std::fs::write(repo.path().join("b.txt"), "fix\n").unwrap();
        assert_eq!(build_done_in(&slots, &kanban, false).1, None);
        let mut sweep = settled_review(5, "done", Some("changes_requested"));
        sweep.builder_handoff = Some("New findings:\n\n- F3\n- F4".into());
        sweep.ledger = vec![
            ledger_finding("F1", "P1", FindingState::Closed),
            ledger_finding("F2", "P3", FindingState::Open),
            ledger_finding("F3", "P1", FindingState::Open),
            ledger_finding("F4", "P2", FindingState::StillOpen),
        ];
        let next = settle_in(&slots, &kanban, sweep, Some(Some(ReviewStatus::ChangesRequested)), &[])
            .expect("the waiting review starts");
        assert_eq!(next.snapshot_n, 6);
        (repo, state, kanban, slots)
    }

    /// GH #129: a hand-over whose follow-up fails leaves the card with the
    /// earlier request and its open ids; what `Back to the Builder` sends
    /// is those findings, whole, as a follow-up quotes them; Ship says so.
    #[test]
    fn a_handed_over_follow_up_that_fails_leaves_the_request_owed() {
        let (_repo, _state, kanban, slots) = handed_over_fixture();
        let card = kanban.get_card("ws", "c1").unwrap();
        assert_eq!(card.review_status, None);
        assert!(!changes_requested_on_current(&card));
        let owed = card.builder.as_ref().unwrap().handed_over.clone().expect("kept while 6 runs");
        assert_eq!((owed.snapshot_n, owed.finding_ids.clone()), (5, vec!["F3".to_string(), "F4".to_string()]));

        // The follow-up fails (after its retry): nothing carried the
        // findings to the Builder, so the card still owes them.
        assert_eq!(settle_in(&slots, &kanban, settled_review(6, "failed", None), None, &[]), None);
        let card = kanban.get_card("ws", "c1").unwrap();
        let b = card.builder.as_ref().unwrap();
        assert_eq!(b.review.as_ref().map(|r| (r.snapshot_n, r.status.as_str())), Some((6, "failed")));
        let owed = b.handed_over.as_ref().expect("the request is still owed");
        assert_eq!(owed.finding_ids, vec!["F3", "F4"]);
        for sent in ["F3 — P1 — Defect F3", "The whole text of F3.", "F4 — P2", "The whole text of F4."] {
            assert!(owed.handoff.contains(sent), "{sent} in {}", owed.handoff);
        }
        assert!(!owed.handoff.contains("F1") && !owed.handoff.contains("F2"), "closed and P3 ones are not owed");
        assert_eq!(
            handed_over_ship_summary(&card).as_deref(),
            Some("Shipped with 2 open findings from round 5's review, not re-checked: F3, F4.")
        );
        let lines = ship_review_lines(&card, &card_sha(&kanban, 6)).unwrap();
        assert_eq!(lines.lines().count(), 2, "the unreviewed line and the owed one: {lines}");

        // An interrupted follow-up whose restart fails is a failed one too;
        // a new session has not received the findings either.
        let fresh = {
            let mut c = card.clone();
            c.builder.as_mut().unwrap().review = None;
            c
        };
        assert!(handed_over_ship_summary(&fresh).is_some());
    }

    /// GH #129: an incomplete follow-up leaves the request owed, as the
    /// ledger it read has it; the next review that judges the change
    /// carries it, and the line goes.
    #[test]
    fn an_incomplete_follow_up_keeps_the_request_until_a_verdict() {
        use crate::review_ledger::FindingState;
        let (_repo, _state, kanban, slots) = handed_over_fixture();
        let mut incomplete = settled_review(6, "done", Some("incomplete"));
        incomplete.ledger = vec![
            ledger_finding("F3", "P1", FindingState::Closed),
            ledger_finding("F4", "P2", FindingState::StillOpen),
        ];
        settle_in(&slots, &kanban, incomplete, None, &[]);
        let card = kanban.get_card("ws", "c1").unwrap();
        let owed = card.builder.as_ref().unwrap().handed_over.clone().unwrap();
        assert_eq!((owed.snapshot_n, owed.finding_ids), (5, vec!["F4".to_string()]));
        assert_eq!(
            handed_over_ship_summary(&card).as_deref(),
            Some("Shipped with 1 open finding from round 5's review, not re-checked: F4.")
        );
        assert_eq!(
            ship_review_lines(&card, &card_sha(&kanban, 6)).as_deref(),
            handed_over_ship_summary(&card).as_deref(),
            "an incomplete review read the commit"
        );
    }

    /// GH #129: nothing changes when the handed-over follow-up completes:
    /// its verdict carries the findings, and no line is left.
    #[test]
    fn a_completed_follow_up_leaves_nothing_owed() {
        for verdict in ["changes_requested", "approve"] {
            let (_repo, _state, kanban, slots) = handed_over_fixture();
            settle_in(&slots, &kanban, settled_review(6, "done", Some(verdict)), None, &[]);
            let card = kanban.get_card("ws", "c1").unwrap();
            assert_eq!(card.builder.as_ref().unwrap().handed_over, None, "{verdict}");
            assert_eq!(handed_over_ship_summary(&card), None);
        }
        // A review that settles without a hand-over owes nothing.
        let (_repo, _state, kanban, slots) = reviewing_fixture();
        settle_in(&slots, &kanban, settled_review(5, "done", Some("changes_requested")), None, &[]);
        assert_eq!(kanban.get_card("ws", "c1").unwrap().builder.unwrap().handed_over, None);
    }

    /// GH #129: a review kept no ledger (before ADR 0006's second card):
    /// its own hand-off is what is owed.
    #[test]
    fn a_request_without_a_ledger_is_owed_as_its_hand_off() {
        let mut review = settled_review(5, "done", Some("changes_requested"));
        assert_eq!(handed_over_request(&review, 1), None, "nothing to send");
        review.builder_handoff = Some("- the defect".into());
        let owed = handed_over_request(&review, 1).unwrap();
        assert_eq!((owed.finding_ids.len(), owed.handoff.as_str()), (0, "- the defect"));
        assert_eq!(handed_over_request(&settled_review(5, "done", Some("approve")), 1), None);
    }

    /// GH #129: the PR body gets each ship line in bold, and a later Ship
    /// replaces both — never the follow-up card's line.
    #[test]
    fn the_pr_body_carries_the_handed_over_line() {
        let lines = "Last commit not reviewed by the Reviewer: it failed.\nShipped with 2 open findings from round 5's review, not re-checked: F3, F4.";
        let body = "Closes #1\n\n**Shipped with 2 open findings: #140**";
        let added = pr_body_with_unreviewed(body, Some(lines));
        assert_eq!(
            added,
            format!("{body}\n\n**Last commit not reviewed by the Reviewer: it failed.**\n\n**Shipped with 2 open findings from round 5's review, not re-checked: F3, F4.**")
        );
        assert_eq!(pr_body_with_unreviewed(&added, Some(lines)), added, "idempotent");
        assert_eq!(pr_body_with_unreviewed(&added, None), body, "the follow-up line stays");

        // The ledger-free form is replaced and removed the same way.
        let mut card = builder_card(vec![]);
        card.builder.as_mut().unwrap().handed_over = Some(HandedOverRequest {
            snapshot_n: 5,
            handoff: "- the defect".into(),
            ..Default::default()
        });
        let no_ids = handed_over_ship_summary(&card).unwrap();
        assert_eq!(no_ids, "Shipped with the changes round 5's review requested, not re-checked.");
        let added = pr_body_with_unreviewed(body, Some(&no_ids));
        assert_eq!(added, format!("{body}\n\n**{no_ids}**"));
        assert_eq!(pr_body_with_unreviewed(&added, Some(&no_ids)), added, "not duplicated");
        assert_eq!(pr_body_with_unreviewed(&added, Some(lines)).matches("not re-checked").count(), 1, "replaced");
        assert_eq!(pr_body_with_unreviewed(&added, None), body, "a later review removes it");
    }

    /// GH #129: a card saved before the field loads without it.
    #[test]
    fn a_card_before_the_handed_over_request_loads_without_one() {
        let json = r#"{"vendor":"claude","snapshots":[],"waitingReview":null}"#;
        let b: BuilderState = serde_json::from_str(json).unwrap();
        assert_eq!(b.handed_over, None);
        let owed: HandedOverRequest = serde_json::from_str(r#"{"snapshotN":5}"#).unwrap();
        assert_eq!((owed.snapshot_n, owed.finding_ids.len()), (5, 0));
    }

    /// GH #135: a card written before `undeliveredVerdict` loads without
    /// one and owes nothing — an old card is never re-sent an old verdict.
    #[test]
    fn a_card_before_the_undelivered_verdict_loads_without_one() {
        let json = r#"{"vendor":"claude","snapshots":[],"handedOver":null,"review":{"snapshotN":5,"provider":"codex","status":"done","verdict":"changes_requested","at":7}}"#;
        let b: BuilderState = serde_json::from_str(json).unwrap();
        assert_eq!(b.undelivered_verdict, None);
        assert_eq!(b.review.as_ref().unwrap().snapshot_n, 5, "the rest of the card still loads");
        // And the field round-trips once it exists.
        let owing = UndeliveredVerdict { snapshot_n: 5, at: 7 };
        let mut written = builder_card(vec![]);
        written.builder.as_mut().unwrap().undelivered_verdict = Some(owing.clone());
        let json = serde_json::to_string(&written).unwrap();
        assert!(json.contains("\"undeliveredVerdict\""), "{json}");
        assert_eq!(
            serde_json::from_str::<KanbanCard>(&json).unwrap().builder.unwrap().undelivered_verdict,
            Some(owing)
        );
    }

    /// GH #135: every review that has something to say leaves its verdict
    /// owed; it is cleared by the delivery that matches it, by a newer
    /// review, and by the human accepting the Builder's pushback.
    #[test]
    fn a_settled_verdict_is_owed_until_the_builder_receives_it() {
        let (_repo, _state, kanban, slots) = reviewing_fixture();
        let mut asked = settled_review(5, "done", Some("changes_requested"));
        asked.at = 4242;
        asked.builder_handoff = Some("- the defect".into());
        settle_in(&slots, &kanban, asked, Some(Some(ReviewStatus::ChangesRequested)), &[]);
        let card = kanban.get_card("ws", "c1").unwrap();
        assert_eq!(
            card.builder.as_ref().unwrap().undelivered_verdict,
            Some(UndeliveredVerdict { snapshot_n: 5, at: 4242 }),
            "the verdict is owed however the card was closed"
        );

        // A delivery of another verdict clears nothing; the matching one does.
        let mut c = card.clone();
        assert!(!clear_delivered_verdict(&mut c, 5, 1), "another verdict");
        assert!(!clear_delivered_verdict(&mut c, 4, 4242), "another snapshot");
        assert!(c.builder.as_ref().unwrap().undelivered_verdict.is_some());
        assert!(clear_delivered_verdict(&mut c, 5, 4242));
        assert_eq!(c.builder.as_ref().unwrap().undelivered_verdict, None);
        assert!(!clear_delivered_verdict(&mut c, 5, 4242), "sent once, never twice");

        // A failed review owes its verdict too; a skipped one says nothing.
        let mut failed = settled_review(6, "failed", None);
        failed.at = 9;
        assert_eq!(verdict_owed(&failed), Some(UndeliveredVerdict { snapshot_n: 6, at: 9 }));
        assert_eq!(verdict_owed(&settled_review(6, "skipped", None)), None);
        assert_eq!(verdict_owed(&settled_review(6, "running", None)), None);

        // A new review replaces the settled one: the old verdict is not sent.
        let mut replaced = builder_card(vec![]);
        let b = replaced.builder.as_mut().unwrap();
        b.undelivered_verdict = Some(UndeliveredVerdict { snapshot_n: 5, at: 4242 });
        set_running_review(b, running_review(6, "claude", ReviewKind::FollowUp, 1));
        assert_eq!(b.undelivered_verdict, None);

        // Accepting the Builder's pushback takes the verdict off the table.
        let mut c = card.clone();
        assert!(override_changes_requested(&mut c, None, 11).is_some());
        assert_eq!(c.builder.as_ref().unwrap().undelivered_verdict, None);
    }

    /// GH #124: Build done with Skip review during a running review asks
    /// for no review, and drops any that was waiting.
    #[test]
    fn a_skipped_build_done_drops_the_waiting_review() {
        let (repo, _state, kanban, slots) = reviewing_fixture();
        std::fs::write(repo.path().join("b.txt"), "fix\n").unwrap();
        build_done_in(&slots, &kanban, false);
        std::fs::write(repo.path().join("c.txt"), "fix\n").unwrap();
        let (result, job) = build_done_in(&slots, &kanban, true);
        assert_eq!((job, result.review_waiting_on), (None, None));
        let card = kanban.get_card("ws", "c1").unwrap();
        assert!(card.builder.as_ref().unwrap().waiting_review.is_none());
        assert_eq!(settle_in(&slots, &kanban, settled_review(5, "done", Some("approve")), Some(None), &[]), None);
        assert!(!slots.is_reviewing("ws", "c1"));
    }

    fn card_sha(kanban: &KanbanStore, n: u32) -> String {
        let card = kanban.get_card("ws", "c1").unwrap();
        card.builder.unwrap().snapshots.iter().find(|s| s.n == n).unwrap().sha.clone()
    }

    /// GH #124 F3: the waiting review reads the snapshot it was asked for.
    /// The branch moves on after that Build done (a commit the Builder made
    /// itself); the job still carries snapshot 6's commit, and that is the
    /// commit `run_review` pins.
    #[test]
    fn the_waiting_review_is_pinned_to_its_snapshot() {
        // `review_revision` runs git with the app's cached PATH.
        crate::shell_env::init();
        let (repo, _state, kanban, slots) = reviewing_fixture();
        let wt = repo.path();
        std::fs::write(wt.join("b.txt"), "fix\n").unwrap();
        build_done_in(&slots, &kanban, false);
        let six = card_sha(&kanban, 6);
        std::fs::write(wt.join("c.txt"), "later\n").unwrap();
        crate::git::run(wt, &["add", "-A"]).unwrap();
        crate::git::run(wt, &["commit", "-q", "-m", "builder's own commit"]).unwrap();
        let tip = crate::worktrees::head_sha(wt).unwrap();
        assert_ne!(tip, six);

        let next = settle_in(&slots, &kanban, settled_review(5, "done", Some("approve")), Some(None), &[]).unwrap();
        assert_eq!(next.revision.as_deref(), Some(six.as_str()));
        let branch = crate::git::capture(wt, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();
        assert_eq!(
            crate::reviewer::review_revision(wt, branch.trim(), next.revision.as_deref()).unwrap(),
            six,
            "the review reads snapshot 6, not the tip"
        );
        assert_eq!(crate::reviewer::review_revision(wt, branch.trim(), None).unwrap(), tip);
        assert!(crate::reviewer::review_revision(wt, branch.trim(), Some("0000000000000000000000000000000000000000")).is_err());

        // Build done's own review is pinned to its snapshot too.
        assert_eq!(settle_in(&slots, &kanban, settled_review(6, "done", Some("approve")), Some(None), &[]), None);
        let (result, job) = build_done_in(&slots, &kanban, false);
        assert_eq!(job.unwrap().revision, Some(result.snapshot.sha));
    }

    /// GH #124 F4: Skip review on an unchanged tree cancels the waiting
    /// review too, and says so.
    #[test]
    fn skip_review_on_an_unchanged_tree_drops_the_waiting_review() {
        let (repo, _state, kanban, slots) = reviewing_fixture();
        std::fs::write(repo.path().join("b.txt"), "fix\n").unwrap();
        build_done_in(&slots, &kanban, false);
        let (result, job) = build_done_in(&slots, &kanban, true);
        assert!(!result.new_snapshot && !result.reselected);
        assert!(result.waiting_dropped);
        assert_eq!(job, None);
        assert!(kanban.get_card("ws", "c1").unwrap().builder.unwrap().waiting_review.is_none());
        assert_eq!(settle_in(&slots, &kanban, settled_review(5, "done", Some("approve")), Some(None), &[]), None);
        assert!(!slots.is_reviewing("ws", "c1"));
        // Nothing waited: nothing to drop.
        let (result, _) = build_done_in(&slots, &kanban, true);
        assert!(!result.waiting_dropped);
    }

    /// GH #124 F6: when the card cannot be written, the waiting review does
    /// not start; the card goes back to the settled review with its request
    /// still waiting, as the disk has it too.
    #[cfg(unix)]
    #[test]
    fn a_hand_over_that_cannot_be_saved_does_not_start() {
        use std::os::unix::fs::PermissionsExt;
        let (repo, state, kanban, slots) = reviewing_fixture();
        std::fs::write(repo.path().join("b.txt"), "fix\n").unwrap();
        build_done_in(&slots, &kanban, false);
        let dir = state.path().join(crate::kanban::KANBAN_SUBDIR);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let next = settle_in(&slots, &kanban, settled_review(5, "done", Some("changes_requested")), None, &[]);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(next, None, "no review starts on a hand-over that is not on disk");
        assert!(!slots.is_reviewing("ws", "c1"));
        let card = kanban.get_card("ws", "c1").unwrap();
        let b = card.builder.as_ref().unwrap();
        assert_eq!(b.waiting_review.as_ref().map(|w| w.snapshot_n), Some(6), "the request still waits");
        let review = b.review.as_ref().unwrap();
        assert_eq!((review.snapshot_n, review.status.as_str()), (5, "done"));
        // Disk agrees: a fresh store still has snapshot 6 waiting.
        let fresh = KanbanStore::new(state.path().to_path_buf()).unwrap();
        let on_disk = fresh.get_card("ws", "c1").unwrap();
        assert_eq!(on_disk.builder.unwrap().waiting_review.map(|w| w.snapshot_n), Some(6));
    }

    /// GH #124 (self-check): a request left waiting with no review running
    /// (its hand-over could not be saved) starts on the next Build done,
    /// even on an unchanged tree; with a review running it keeps waiting.
    #[test]
    fn build_done_starts_a_request_left_waiting() {
        let (repo, _state, kanban, slots) = reviewing_fixture();
        std::fs::write(repo.path().join("b.txt"), "fix\n").unwrap();
        build_done_in(&slots, &kanban, false);
        let (result, job) = build_done_in(&slots, &kanban, false);
        assert_eq!((job, result.waiting_started), (None, None), "still reviewing: it keeps waiting");
        // The hand-over was lost: the card is free, the request still waits.
        assert_eq!(slots.release("ws", "c1", || None::<ChallengerJob>), None);
        let (result, job) = build_done_in(&slots, &kanban, false);
        assert!(!result.new_snapshot);
        assert_eq!(result.waiting_started, Some(6));
        let job = job.expect("the waiting review starts");
        assert_eq!((job.snapshot_n, job.revision), (6, Some(card_sha(&kanban, 6))));
        assert!(slots.is_reviewing("ws", "c1"));
        let b = kanban.get_card("ws", "c1").unwrap().builder.unwrap();
        assert!(b.waiting_review.is_none());
        assert_eq!(b.review.map(|r| (r.snapshot_n, r.status)), Some((6, "running".to_string())));
    }

    /// GH #124 F6 (round 2): Build done on an unchanged tree starts a
    /// request left waiting only once that is saved; when the board cannot
    /// be written, the request still waits, in the cache and on disk.
    #[cfg(unix)]
    #[test]
    fn a_waiting_request_is_not_started_unsaved() {
        use std::os::unix::fs::PermissionsExt;
        let (repo, state, kanban, slots) = reviewing_fixture();
        std::fs::write(repo.path().join("b.txt"), "fix\n").unwrap();
        build_done_in(&slots, &kanban, false);
        assert_eq!(slots.release("ws", "c1", || None::<ChallengerJob>), None);
        let mut resumed = None;
        let dir = state.path().join(crate::kanban::KANBAN_SUBDIR);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let saved = kanban.with_card_saved("ws", "c1", |c| {
            resumed = start_waiting_as(c, ReviewKind::FollowUp, 1);
            Ok(())
        });
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(saved.is_err());
        let b = kanban.get_card("ws", "c1").unwrap().builder.unwrap();
        assert_eq!(b.waiting_review.map(|w| w.snapshot_n), Some(6), "the cache kept nothing of it");
        assert_eq!(b.review.map(|r| r.snapshot_n), Some(5));
    }

    /// GH #124 F1 (round 2): at launch a card starts its waiting review,
    /// or the review the quit interrupted — a hand-over that landed while
    /// Ply quit is not lost; a card with no review under way starts none.
    #[test]
    fn launch_restarts_nothing_on_an_archived_or_shipped_card() {
        let mut card = builder_card(vec![BuildSnapshot { n: 1, sha: "s1".into(), at: 0 }]);
        card.builder.as_mut().unwrap().review = Some(running_review(1, "claude", ReviewKind::Sweep, 1));
        assert_eq!(restart_request(&card), Some(1));
        card.ship_status = crate::kanban::ShipStatus::Shipped;
        assert_eq!(restart_request(&card), None, "shipped");
        card.ship_status = crate::kanban::ShipStatus::Unshipped;
        card.archived = true;
        assert_eq!(restart_request(&card), None, "archived");
    }

    #[test]
    fn launch_restarts_the_waiting_or_interrupted_review() {
        let mut card = builder_card(vec![
            BuildSnapshot { n: 1, sha: "s1".into(), at: 0 },
            BuildSnapshot { n: 2, sha: "s2".into(), at: 0 },
        ]);
        assert_eq!(restart_request(&card), None);
        card.builder.as_mut().unwrap().review = Some(running_review(2, "claude", ReviewKind::FollowUp, 1));
        let job = resume_at_launch(&mut card.clone(), &[], 5).unwrap();
        assert_eq!((job.snapshot_n, job.revision.as_deref()), (2, Some("s2")));
        card.builder.as_mut().unwrap().waiting_review = Some(WaitingReview { snapshot_n: 1, requested_at: 1 });
        let job = resume_at_launch(&mut card, &[], 5).unwrap();
        assert_eq!(job.snapshot_n, 1, "the waiting request wins");
        let b = card.builder.as_ref().unwrap();
        assert!(b.waiting_review.is_none());
        card.builder.as_mut().unwrap().review.as_mut().unwrap().status = "done".into();
        assert_eq!(resume_at_launch(&mut card, &[], 5), None);
    }

    /// GH #124 F1: once Ply is quitting, a review killed by the exit
    /// cleanup does not hand the card on; its successor keeps waiting on
    /// disk for the next launch, and a Build done then waits too.
    #[test]
    fn a_review_ending_at_quit_leaves_its_successor_waiting() {
        let (repo, state, kanban, slots) = reviewing_fixture();
        std::fs::write(repo.path().join("b.txt"), "fix\n").unwrap();
        build_done_in(&slots, &kanban, false);
        slots.close();
        assert_eq!(settle_in(&slots, &kanban, settled_review(5, "failed", None), None, &[]), None);
        let fresh = KanbanStore::new(state.path().to_path_buf()).unwrap();
        let b = fresh.get_card("ws", "c1").unwrap().builder.unwrap();
        assert_eq!(b.waiting_review.map(|w| w.snapshot_n), Some(6));
        assert_eq!(b.review.map(|r| (r.snapshot_n, r.status)), Some((5, "running".to_string())));
        std::fs::write(repo.path().join("c.txt"), "fix\n").unwrap();
        let (result, job) = build_done_in(&slots, &kanban, false);
        assert_eq!((job, result.review_waiting_on), (None, Some(5)));
        // The next launch starts it (`start_waiting_reviews`).
        let mut card = kanban.get_card("ws", "c1").unwrap();
        assert_eq!(start_waiting(&mut card, &[], 1).map(|job| job.snapshot_n), Some(7));
    }

    /// GH #124: a card written before the waiting review loads without one.
    #[test]
    fn a_card_before_the_waiting_review_loads_without_one() {
        let legacy: BuilderState = serde_json::from_str(r#"{"vendor":"claude","snapshots":[]}"#).unwrap();
        assert!(legacy.waiting_review.is_none());
        let mut state = legacy;
        state.waiting_review = Some(WaitingReview { snapshot_n: 3, requested_at: 7 });
        let json = serde_json::to_value(&state).unwrap();
        assert_eq!(json["waitingReview"], serde_json::json!({"snapshotN": 3, "requestedAt": 7}));
        let back: BuilderState = serde_json::from_value(json).unwrap();
        assert_eq!(back.waiting_review, state.waiting_review);
    }

    /// 1.169.0 (A3, owner B): "Retry on…" re-reviews the same snapshot even
    /// after a settled verdict, carrying its model; Review again still
    /// doesn't. A running review is never retried.
    #[test]
    fn a_retry_re_reviews_a_settled_verdict_of_the_current_snapshot() {
        let (_repo, _state, kanban) = pushback_fixture();
        assert!(record_review_again(&kanban, "ws", "c1", ReviewKind::Review).is_err(), "plain Review again: refused");
        let retry = crate::retry_on::ReviewRetry {
            vendor: "codex".into(),
            choice: ModelChoice { model: Some("gpt-6-luna".into()), reasoning: Some("high".into()) },
        };
        let job = record_review_again_with(&kanban, "ws", "c1", ReviewKind::FollowUp, Some(retry.clone())).unwrap();
        assert_eq!((job.snapshot_n, job.retry.as_ref()), (5, Some(&retry)));
        let review = kanban.get_card("ws", "c1").unwrap().builder.unwrap().review.unwrap();
        assert_eq!(review.status, "running");
        // While it runs, another retry is refused.
        assert!(record_review_again_with(&kanban, "ws", "c1", ReviewKind::FollowUp, Some(retry)).is_err());
        // An approved verdict is retried too.
        kanban
            .with_card("ws", "c1", |c| {
                let r = c.builder.as_mut().unwrap().review.as_mut().unwrap();
                r.status = "done".into();
                r.verdict = Some("approve".into());
                Ok(())
            })
            .unwrap();
        let again = crate::retry_on::ReviewRetry { vendor: "codex".into(), choice: ModelChoice::default() };
        assert!(record_review_again_with(&kanban, "ws", "c1", ReviewKind::FollowUp, Some(again)).is_ok());
    }

    /// GH #58: "Review again in passes" re-runs an incomplete review of the
    /// current snapshot — the way out that is not #41's override.
    #[test]
    fn review_again_reruns_an_incomplete_review_of_the_current_snapshot() {
        let (_repo, _state, kanban) = pushback_fixture();
        // A standing changes-requested verdict is not re-run: address it or
        // accept the pushback.
        assert!(record_review_again(&kanban, "ws", "c1", ReviewKind::Review)
            .unwrap_err()
            .contains("no incomplete or failed review"));

        kanban
            .with_card("ws", "c1", |c| {
                let review = c.builder.as_mut().unwrap().review.as_mut().unwrap();
                review.verdict = Some("incomplete".into());
                review.incomplete_reason = Some("diff too large".into());
                review.pass_count = Some(1);
                c.review_status = None;
                Ok(())
            })
            .unwrap();
        // ADR 0006: an incomplete sweep runs again as a sweep, and the
        // running review says so from the start.
        let job = record_review_again(&kanban, "ws", "c1", ReviewKind::Sweep).unwrap();
        assert_eq!(
            job,
            ChallengerJob {
                snapshot_n: 5,
                builder_vendor: "claude".into(),
                pass_budget: crate::review_passes::SMALL_PASS_DIFF_BUDGET,
                kind: ReviewKind::Sweep,
                revision: Some(card_sha(&kanban, 5)),
                retry: None,
            }
        );
        let card = kanban.get_card("ws", "c1").unwrap();
        let review = card.builder.as_ref().unwrap().review.as_ref().unwrap();
        assert_eq!((review.snapshot_n, review.status.as_str()), (5, "running"));
        assert_eq!(review.kind, ReviewKind::Sweep);
        assert_eq!(review.verdict, None);
        assert!(!changes_requested_on_current(&card));
        // A second press while it runs is refused.
        assert!(record_review_again(&kanban, "ws", "c1", ReviewKind::Review)
            .unwrap_err()
            .contains("already reviewing"));
    }

    /// GH #99: a review that failed outright runs again in normal passes;
    /// an incomplete one keeps the smaller passes.
    #[test]
    fn review_again_after_a_failure_uses_normal_passes() {
        let (_repo, _state, kanban) = pushback_fixture();
        kanban
            .with_card("ws", "c1", |c| {
                let review = c.builder.as_mut().unwrap().review.as_mut().unwrap();
                review.status = "failed".into();
                review.verdict = None;
                review.error = Some("Reviewer exited with status 1: Selected model is at capacity.".into());
                c.review_status = None;
                Ok(())
            })
            .unwrap();
        let job = record_review_again(&kanban, "ws", "c1", ReviewKind::Review).unwrap();
        assert_eq!(job.pass_budget, crate::review_passes::PASS_DIFF_BUDGET);
    }

    /// GH #99: the card says "trying again in 30 s" while the one retry
    /// waits, then shows the review running again; a review a newer Build
    /// done replaced is left alone.
    #[test]
    fn the_card_hears_about_the_retry() {
        let mut card = builder_card(vec![BuildSnapshot { n: 2, sha: "b".into(), at: 1 }]);
        card.builder.as_mut().unwrap().review = Some(BuilderReview {
            snapshot_n: 2,
            provider: "codex".into(),
            status: "running".into(),
            ..Default::default()
        });
        let waiting = crate::reviewer::RetryEvent::Waiting {
            reason: "The Reviewer's model was at capacity.".into(),
            error: "Reviewer exited with status 1: Selected model is at capacity.".into(),
            delay_secs: 30,
        };
        assert!(apply_retry_event(&mut card, 2, &waiting, 1_000));
        let review = card.builder.as_ref().unwrap().review.clone().unwrap();
        assert_eq!(review.retry_at, Some(31_000));
        assert_eq!(review.status, "running");
        assert_eq!(review.failure_reason.as_deref(), Some("The Reviewer's model was at capacity."));

        assert!(apply_retry_event(&mut card, 2, &crate::reviewer::RetryEvent::Retrying, 31_000));
        let review = card.builder.as_ref().unwrap().review.clone().unwrap();
        assert_eq!((review.retry_at, review.retried), (None, true));
        assert!(review.error.is_none() && review.failure_reason.is_none());

        assert!(!apply_retry_event(&mut card, 1, &waiting, 1_000), "another snapshot's review");
    }

    /// GH #99: an approval moves the last reviewed revision; a later failed
    /// review keeps it, so the unreviewed commits stay countable.
    #[test]
    fn a_failed_review_keeps_the_last_reviewed_revision() {
        let mut card = builder_card(vec![
            BuildSnapshot { n: 1, sha: "a".into(), at: 1 },
            BuildSnapshot { n: 2, sha: "b".into(), at: 2 },
        ]);
        let approved = crate::reviewer::ReviewerRecord {
            reviewed_revision: "a".into(),
            ..reviewer_record(Some("approve"), "## Verdict\nAPPROVE")
        };
        let (review, status) = challenger_review_from_record(&approved, 1, "codex".into(), false, 3);
        assert_eq!(review.reviewed_revision.as_deref(), Some("a"));
        record_settled_review(&mut card, review, status);
        assert_eq!(card.builder.as_ref().unwrap().last_reviewed_revision.as_deref(), Some("a"));

        let failed = crate::reviewer::ReviewerRecord {
            status: crate::reviewer::ReviewRunStatus::Failed,
            reviewed_revision: "b".into(),
            artifact: None,
            verdict: None,
            error: Some("Reviewer exited with status 1: Selected model is at capacity. Please try a different model..".into()),
            failure_reason: Some("The Reviewer's model was at capacity.".into()),
            retries: 1,
            ..reviewer_record(None, "")
        };
        let (review, status) = challenger_review_from_record(&failed, 2, "codex".into(), false, 4);
        assert_eq!(review.status, "failed");
        assert!(review.retried);
        assert_eq!(review.failure_reason.as_deref(), Some("The Reviewer's model was at capacity."));
        record_settled_review(&mut card, review, status);
        let b = card.builder.as_ref().unwrap();
        assert_eq!(b.last_reviewed_revision.as_deref(), Some("a"));
        assert_eq!(b.review.as_ref().unwrap().reviewed_revision.as_deref(), Some("b"));
    }

    /// PR #375 review (P2-b): the review panel's Merge lands a Builder
    /// snapshot plainly only when Ship would call it reviewed — an approve,
    /// an accepted pushback, a Skip review — never when its review is
    /// missing, running, failed, incomplete or asks for changes.
    #[test]
    fn merge_review_gap_is_none_only_for_an_approved_last_snapshot() {
        let mut card = builder_card(vec![
            BuildSnapshot { n: 1, sha: "a".into(), at: 1 },
            BuildSnapshot { n: 2, sha: "b".into(), at: 2 },
        ]);
        let set = |card: &mut KanbanCard, review: Option<BuilderReview>| {
            card.builder.as_mut().unwrap().review = review;
        };
        assert!(merge_review_gap(&card, "b").unwrap().contains("round 2 has no review"));
        let approved = BuilderReview {
            snapshot_n: 2,
            status: "done".into(),
            verdict: Some("approve".into()),
            reviewed_revision: Some("b".into()),
            ..Default::default()
        };
        set(&mut card, Some(approved.clone()));
        assert_eq!(merge_review_gap(&card, "b"), None);
        // Approved on snapshot 1 only: snapshot 2 was not reviewed.
        set(&mut card, Some(BuilderReview { snapshot_n: 1, reviewed_revision: Some("a".into()), ..approved.clone() }));
        assert!(merge_review_gap(&card, "b").is_some());
        set(&mut card, Some(BuilderReview { status: "running".into(), verdict: None, ..approved.clone() }));
        assert!(merge_review_gap(&card, "b").unwrap().contains("still running"));
        set(&mut card, Some(BuilderReview { status: "failed".into(), verdict: None, ..approved.clone() }));
        assert!(merge_review_gap(&card, "b").is_some());
        set(&mut card, Some(BuilderReview { verdict: Some("changes_requested".into()), ..approved.clone() }));
        assert!(merge_review_gap(&card, "b").unwrap().contains("requested on round 2"));
        set(&mut card, Some(BuilderReview { verdict: Some("incomplete".into()), ..approved.clone() }));
        assert!(merge_review_gap(&card, "b").unwrap().contains("incomplete"));
        // An override (the human's note) is the person's decision, as at
        // Ship; 1.171.0 C3 (owner 2026-10-27): a plain skip is no review.
        set(
            &mut card,
            Some(BuilderReview {
                status: "skipped".into(),
                verdict: None,
                note: Some("overridden by the human".into()),
                ..approved.clone()
            }),
        );
        assert_eq!(merge_review_gap(&card, "b"), None);
        set(&mut card, Some(BuilderReview { status: "skipped".into(), verdict: None, ..approved.clone() }));
        assert_eq!(
            merge_review_gap(&card, "b").as_deref(),
            Some("Last commit not reviewed by the Reviewer: its review was skipped (Check without the Reviewer).")
        );
        assert!(ship_review_record(&card, "b", false).is_some(), "a skipped card ships unreviewed");
        // No Builder: no Challenger to ask.
        card.builder = None;
        assert_eq!(merge_review_gap(&card, "b"), None);
    }

    /// Tier 4 walk 2026-10-14: Ship as a PR records what Merge anyway
    /// records — a standing request for changes, or no review of the last
    /// snapshot — in the receipt and the PR body, and a later Ship replaces
    /// that line rather than adding a second one.
    #[test]
    fn ship_records_a_request_for_changes_as_merge_anyway_does() {
        let mut card = builder_card(vec![BuildSnapshot { n: 2, sha: "b".into(), at: 2 }]);
        assert!(ship_review_record(&card, "b", false).unwrap().contains("round 2 has no review"));
        card.builder.as_mut().unwrap().review = Some(BuilderReview {
            snapshot_n: 2,
            status: "done".into(),
            verdict: Some("changes_requested".into()),
            reviewed_revision: Some("b".into()),
            ..Default::default()
        });
        let line = ship_review_record(&card, "b", false).unwrap();
        // Ship with follow-up (#378 P2-2): its own line says it; no gap line.
        assert_eq!(ship_review_record(&card, "b", true), None);
        assert_eq!(line, "Shipped with the changes the Reviewer requested on round 2, not fixed.");
        let body = pr_body_with_unreviewed("Shipped from Plyloft.", Some(&line));
        assert_eq!(body, format!("Shipped from Plyloft.\n\n**{line}**"));
        assert_eq!(pr_body_with_unreviewed(&body, None), "Shipped from Plyloft.");
        // Approved: nothing to record, as before.
        card.builder.as_mut().unwrap().review.as_mut().unwrap().verdict = Some("approve".into());
        assert_eq!(ship_review_record(&card, "b", false), None);
    }

    /// Walk 3 of #386 (finding 5): on a pull request card with no Builder
    /// session open, an approval is owed to no Builder ("Snapshot 6's
    /// approval has not reached the Builder … Resume" said otherwise); a
    /// request for changes still is, and a normal card's approval still is.
    #[test]
    fn a_pull_request_cards_approval_is_owed_to_no_closed_session() {
        let approved = BuilderReview {
            snapshot_n: 2,
            status: "done".into(),
            verdict: Some("approve".into()),
            at: 7,
            ..Default::default()
        };
        let mut pr = builder_card(vec![BuildSnapshot { n: 2, sha: "b".into(), at: 2 }]);
        pr.pr_review = Some(Default::default());
        pr.builder.as_mut().unwrap().pty_id = None;
        let mut plain = pr.clone();
        plain.pr_review = None;
        record_settled_review(&mut pr, approved.clone(), None);
        assert_eq!(pr.builder.as_ref().unwrap().undelivered_verdict, None);
        record_settled_review(&mut plain, approved.clone(), None);
        assert!(plain.builder.as_ref().unwrap().undelivered_verdict.is_some());
        let asked = BuilderReview { verdict: Some("changes_requested".into()), at: 8, ..approved };
        record_settled_review(&mut pr, asked, None);
        assert_eq!(pr.builder.as_ref().unwrap().undelivered_verdict, Some(UndeliveredVerdict { snapshot_n: 2, at: 8 }));
    }

    /// Challenger round on #378 (P2-1): approve → a new session (Start
    /// fresh, Start build again) → Ship and Merge record nothing: the review
    /// of the unchanged last snapshot is kept. A kept request for changes is
    /// owed to the new session; a review of an older snapshot goes.
    #[test]
    fn a_new_session_keeps_the_review_of_the_last_snapshot() {
        let mut card = builder_card(vec![BuildSnapshot { n: 2, sha: "b".into(), at: 2 }]);
        let approved = BuilderReview {
            snapshot_n: 2,
            status: "done".into(),
            verdict: Some("approve".into()),
            reviewed_revision: Some("b".into()),
            at: 7,
            ..Default::default()
        };
        card.builder.as_mut().unwrap().review = Some(approved.clone());
        let (kept, owed) = review_kept_for_new_session(card.builder.as_ref());
        assert_eq!(kept.as_ref(), Some(&approved));
        assert_eq!(owed, None, "an approval says nothing to a new session");
        let mut started = card.clone();
        started.builder.as_mut().unwrap().review = kept;
        assert_eq!(ship_review_record(&started, "b", false), None);
        assert_eq!(merge_review_gap(&started, "b"), None);

        let asked = BuilderReview { verdict: Some("changes_requested".into()), ..approved.clone() };
        card.builder.as_mut().unwrap().review = Some(asked);
        let (kept, owed) = review_kept_for_new_session(card.builder.as_ref());
        assert!(kept.is_some());
        assert_eq!(owed, Some(UndeliveredVerdict { snapshot_n: 2, at: 7 }));

        card.builder.as_mut().unwrap().review = Some(BuilderReview { snapshot_n: 1, ..approved });
        assert_eq!(review_kept_for_new_session(card.builder.as_ref()), (None, None));
        assert_eq!(review_kept_for_new_session(None), (None, None));
    }

    /// GH #99: the PR body says when the shipped commit was not reviewed,
    /// and why — and says nothing for a reviewed or skipped one.
    #[test]
    fn the_pr_body_line_names_an_unreviewed_tip() {
        let mut card = builder_card(vec![
            BuildSnapshot { n: 1, sha: "a".into(), at: 1 },
            BuildSnapshot { n: 2, sha: "b".into(), at: 2 },
        ]);
        let set = |card: &mut KanbanCard, review: BuilderReview| {
            card.builder.as_mut().unwrap().review = Some(review);
        };
        set(&mut card, BuilderReview {
            snapshot_n: 2,
            status: "failed".into(),
            error: Some("Reviewer exited with status 1: Selected model is at capacity. Please try a different model..".into()),
            failure_reason: Some("The Reviewer's model was at capacity.".into()),
            ..Default::default()
        });
        assert_eq!(
            unreviewed_ship_summary(&card, "b").as_deref(),
            Some("Last commit not reviewed by the Reviewer: The Reviewer's model was at capacity.")
        );
        // A failure recorded before GH #99 is classified from its error.
        card.builder.as_mut().unwrap().review.as_mut().unwrap().failure_reason = None;
        assert_eq!(
            unreviewed_ship_summary(&card, "b").as_deref(),
            Some("Last commit not reviewed by the Reviewer: The Reviewer's model was at capacity.")
        );

        let approved = BuilderReview {
            snapshot_n: 2,
            status: "done".into(),
            verdict: Some("approve".into()),
            reviewed_revision: Some("b".into()),
            ..Default::default()
        };
        set(&mut card, approved.clone());
        assert_eq!(unreviewed_ship_summary(&card, "b"), None);
        // A review from before GH #99 (no revision) of the last snapshot.
        set(&mut card, BuilderReview { reviewed_revision: None, ..approved.clone() });
        assert_eq!(unreviewed_ship_summary(&card, "b"), None);
        // Approval, then a newer commit.
        set(&mut card, BuilderReview { reviewed_revision: Some("a".into()), ..approved.clone() });
        assert!(unreviewed_ship_summary(&card, "b").unwrap().contains("commits were made after"));

        // Review 1: pass 1 approved, pass 2 failed after its retry — the
        // merged review completed, but not every file was reviewed.
        set(&mut card, BuilderReview {
            verdict: Some("incomplete".into()),
            incomplete_reason: Some("pass 2 of 2 failed".into()),
            pass_count: Some(2),
            failed_passes: Some(1),
            failure_reason: Some("The Reviewer's model was at capacity.".into()),
            ..approved.clone()
        });
        assert_eq!(
            unreviewed_ship_summary(&card, "b").as_deref(),
            Some("Last commit not reviewed by the Reviewer: 1 of 2 review passes failed. The Reviewer's model was at capacity.")
        );

        // ADR 0006: a sweep's synthesis pass that failed is counted and named.
        set(&mut card, BuilderReview {
            verdict: Some("incomplete".into()),
            incomplete_reason: Some("the synthesis pass failed".into()),
            pass_count: Some(2),
            synthesis_pass: true,
            failed_passes: Some(1),
            failed_pass_names: vec!["the synthesis pass".into()],
            failure_reason: Some("The Reviewer's model was at capacity.".into()),
            ..approved.clone()
        });
        assert_eq!(
            unreviewed_ship_summary(&card, "b").as_deref(),
            Some("Last commit not reviewed by the Reviewer: 1 of 3 review passes failed (the synthesis pass). The Reviewer's model was at capacity.")
        );

        // Review 8: changes requested in one pass, another failed, and the
        // human accepted the pushback — the failed pass is still disclosed.
        set(&mut card, BuilderReview {
            status: "skipped".into(),
            verdict: None,
            note: Some("changes requested on snapshot 2, overridden by the human".into()),
            pass_count: Some(2),
            failed_passes: Some(1),
            failure_reason: Some("The Reviewer's model was at capacity.".into()),
            ..approved.clone()
        });
        assert_eq!(
            unreviewed_ship_summary(&card, "b").as_deref(),
            Some("Last commit not reviewed by the Reviewer: 1 of 2 review passes failed. The Reviewer's model was at capacity.")
        );

        // 1.171.0 C3 (owner 2026-10-27): a review skipped on purpose is no
        // review — the pull request body says it was skipped.
        set(&mut card, BuilderReview { status: "skipped".into(), verdict: None, ..approved.clone() });
        assert_eq!(
            unreviewed_ship_summary(&card, "b").as_deref(),
            Some("Last commit not reviewed by the Reviewer: its review was skipped (Check without the Reviewer).")
        );
        let body = pr_body_with_unreviewed("Closes #9", unreviewed_ship_summary(&card, "b").as_deref());
        assert!(body.contains("**Last commit not reviewed by the Reviewer: its review was skipped"), "{body}");
        assert!(body.lines().any(is_ship_review_pr_line), "a later Ship replaces it");
        // An override without a failed pass stays the person's decision.
        set(&mut card, BuilderReview {
            status: "skipped".into(),
            verdict: None,
            note: Some("changes requested on snapshot 2, overridden by the human".into()),
            ..approved
        });
        assert_eq!(unreviewed_ship_summary(&card, "b"), None);
    }

    /// GH #99 (review 1): a PR shipped again gets its line replaced, added
    /// or removed; the rest of the body is left alone.
    #[test]
    fn an_existing_pr_body_gets_its_unreviewed_line_refreshed() {
        let old = "Closes #9\n\nShipped from Plyloft — see the card for the task and review.\n\nA note from a human.";
        let line = "Last commit not reviewed by the Reviewer: The Reviewer's model was at capacity.";
        let added = pr_body_with_unreviewed(old, Some(line));
        assert_eq!(added, format!("{old}\n\n**{line}**"));
        assert_eq!(pr_body_with_unreviewed(&added, Some(line)), added, "idempotent");
        let other = "Last commit not reviewed by the Reviewer: The Reviewer could not reach its provider.";
        assert_eq!(pr_body_with_unreviewed(&added, Some(other)), format!("{old}\n\n**{other}**"));
        assert_eq!(pr_body_with_unreviewed(&added, None), old, "a reviewed tip removes it");
        assert_eq!(pr_body_with_unreviewed(old, None), old);
    }

    /// G2 (Challenger round 1): the twin of `reviewerWords`, and a reason
    /// saved before the rename reaches GitHub with the new name.
    #[test]
    fn reviewer_words_reads_the_new_name_and_leaves_ids() {
        assert_eq!(reviewer_words("The Challenger's model was at capacity."), "The Reviewer's model was at capacity.");
        assert_eq!(reviewer_words("two Challengers, Challenger."), "two Reviewers, Reviewer.");
        assert_eq!(reviewer_words("ChallengerJob challenger-reviewing xChallenger"), "ChallengerJob challenger-reviewing xChallenger");
        assert_eq!(reviewer_words("Challenger"), "Reviewer");
        // TX3 round 1: the old menu item's name in a saved skipped-review line.
        assert_eq!(
            reviewer_words("Last commit not reviewed by the Challenger: its review was skipped (Check without the second AI's review)."),
            format!("Last commit not reviewed by the Reviewer: {SKIPPED_REVIEW_REASON}"),
        );
        let mut card = builder_card(vec![BuildSnapshot { n: 1, sha: "a".into(), at: 1 }]);
        card.builder.as_mut().unwrap().review = Some(BuilderReview {
            snapshot_n: 1,
            status: "failed".into(),
            failure_reason: Some("The Challenger's model was at capacity.".into()),
            ..Default::default()
        });
        assert_eq!(
            unreviewed_ship_summary(&card, "a").as_deref(),
            Some("Last commit not reviewed by the Reviewer: The Reviewer's model was at capacity.")
        );
        // A pass's failure reason, saved before the rename, reads the new
        // name too: every reason goes through `reviewer_words` on its way
        // into the line.
        let review = card.builder.as_mut().unwrap().review.as_mut().unwrap();
        review.status = "done".into();
        review.failed_passes = Some(1);
        review.pass_count = Some(2);
        let line = unreviewed_ship_summary(&card, "a").unwrap();
        assert!(line.contains("1 of 2 review passes failed") && !line.contains("Challenger"), "{line}");
    }

    /// G2 (1.173.0): a pull request opened before the rename carries the
    /// line with the Reviewer's old name; a later Ship replaces it too.
    #[test]
    fn a_pre_rename_unreviewed_line_is_replaced_too() {
        let old = "Closes #9\n\n**Last commit not reviewed by the Challenger: it failed.**";
        let line = "Last commit not reviewed by the Reviewer: it failed.";
        assert_eq!(pr_body_with_unreviewed(old, Some(line)), format!("Closes #9\n\n**{line}**"));
        assert_eq!(pr_body_with_unreviewed(old, None), "Closes #9");
    }

    /// GH #99 (review 1): a completed review with a pass that failed after
    /// its retry keeps its reason and does not become the last reviewed
    /// revision.
    #[test]
    fn a_review_with_a_failed_pass_is_not_a_completed_review() {
        let mut card = builder_card(vec![BuildSnapshot { n: 1, sha: "a".into(), at: 1 }]);
        let record = crate::reviewer::ReviewerRecord {
            reviewed_revision: "a".into(),
            failed_passes: 1,
            error: Some("Pass 2 of 3 exited with status 1: Selected model is at capacity..".into()),
            failure_reason: Some("The Reviewer's model was at capacity.".into()),
            incomplete_reason: Some("pass 2 of 3 failed".into()),
            ..reviewer_record(Some("incomplete"), "## Verdict\nINCOMPLETE")
        };
        let (review, status) = challenger_review_from_record(&record, 1, "codex".into(), false, 3);
        assert_eq!(review.status, "done");
        assert_eq!(review.failed_passes, Some(1));
        assert_eq!(review.failure_reason.as_deref(), Some("The Reviewer's model was at capacity."));
        record_settled_review(&mut card, review, status);
        assert_eq!(card.builder.as_ref().unwrap().last_reviewed_revision, None);
    }

    /// GH #99: approval on one commit, then two more commits — Outcome
    /// counts them from the worktree; a pre-#99 approval of the current
    /// snapshot stands in for the missing revision.
    #[test]
    fn commits_since_the_last_review_are_counted_from_the_worktree() {
        let repo = git_repo();
        let wt = repo.path();
        let approved = crate::worktrees::head_sha(wt).unwrap();
        for (file, n) in [("b.txt", 1), ("c.txt", 2)] {
            std::fs::write(wt.join(file), "x\n").unwrap();
            crate::worktrees::commit_pending_in_worktree(wt, &format!("commit {n}")).unwrap();
        }
        let tip = crate::worktrees::head_sha(wt).unwrap();
        let mut card = builder_card(vec![BuildSnapshot { n: 1, sha: approved.clone(), at: 1 }]);
        assert_eq!(review_tip_facts(&card, wt), (Some(tip.clone()), None), "never reviewed");

        card.builder.as_mut().unwrap().review = Some(BuilderReview {
            snapshot_n: 1,
            status: "done".into(),
            verdict: Some("approve".into()),
            ..Default::default()
        });
        assert_eq!(review_tip_facts(&card, wt), (Some(tip.clone()), Some(2)));

        // Review 4: a partial review (a pass failed) is not a completed one.
        card.builder.as_mut().unwrap().review.as_mut().unwrap().failed_passes = Some(1);
        assert_eq!(last_completed_review_revision(&card), None);
        assert_eq!(review_tip_facts(&card, wt), (Some(tip.clone()), None));

        card.builder.as_mut().unwrap().last_reviewed_revision = Some(tip.clone());
        assert_eq!(review_tip_facts(&card, wt), (Some(tip), Some(0)));
    }

    /// Review 5: a completed review recorded before GH #99 keeps its
    /// revision as the last reviewed one when Build done or Review again
    /// replaces it, so a later failure can still count the commits since.
    /// ADR 0006: a card review recorded before the sweep loads as a review
    /// with no findings; a sweep record carries its findings to the card.
    #[test]
    fn a_legacy_card_review_loads_as_a_review_and_a_sweep_keeps_its_findings() {
        let legacy: BuilderReview = serde_json::from_str(
            r#"{"snapshotN":2,"provider":"codex","status":"done","verdict":"approve","at":1}"#,
        )
        .unwrap();
        assert_eq!(legacy.kind, ReviewKind::Review);
        assert!(legacy.findings.is_empty() && legacy.non_blocking.is_empty());
        assert!(legacy.checklist.is_empty() && !legacy.synthesis_pass && !legacy.findings_unread);
        // CL-2: no skills followed, and a re-save does not add the field.
        assert!(legacy.skills_followed.is_empty());
        assert!(!serde_json::to_string(&legacy).unwrap().contains("skillsFollowed"));
        // Review integrity: no base note, and a re-save does not add it.
        assert!(legacy.base_note.is_none());
        assert!(!serde_json::to_string(&legacy).unwrap().contains("baseNote"));

        let finding = |severity: &str, pre_existing: bool| crate::review_passes::ReviewFinding {
            severity: Some(severity.into()),
            title: format!("{severity} finding"),
            body: format!("**{severity} — finding.**"),
            pre_existing,
            pass: None,
            ..Default::default()
        };
        let record = crate::reviewer::ReviewerRecord {
            id: "r1".into(),
            status: crate::reviewer::ReviewRunStatus::Completed,
            artifact: Some("## Verdict\nCHANGES_REQUESTED".into()),
            verdict: Some("changes_requested".into()),
            pass_count: 2,
            file_count: 9,
            kind: ReviewKind::Sweep,
            synthesis_pass: true,
            findings: vec![finding("P1", false)],
            non_blocking: vec![finding("P3", false), finding("P2", true)],
            checklist: vec!["A. checked — nothing".into()],
            skills_followed: vec![crate::review_answer::SkillFollowed { skill: "review-rules".into(), note: "RR-OK-1".into() }],
            base_note: Some("Local main was ahead of origin; reviewed from the recorded base.".into()),
            ..Default::default()
        };
        let (review, status) = challenger_review_from_record(&record, 3, "codex".into(), false, 5);
        // CL-2: the card's review carries the skills followed.
        assert_eq!(review.skills_followed, record.skills_followed);
        // Review integrity: and the base note, for the card to show.
        assert_eq!(review.base_note, record.base_note);
        assert_eq!(status, Some(Some(ReviewStatus::ChangesRequested)));
        // Settling it marks the card's first review done.
        let mut settled = builder_card(vec![]);
        assert!(!settled.builder.as_ref().unwrap().first_review_done);
        record_settled_review(&mut settled, review.clone(), status.clone());
        assert!(settled.builder.as_ref().unwrap().first_review_done);
        assert_eq!(review.kind, ReviewKind::Sweep);
        assert!(review.synthesis_pass);
        assert_eq!(review.findings, record.findings);
        assert_eq!(review.non_blocking, record.non_blocking);
        assert_eq!(review.checklist, record.checklist);
        let json = serde_json::to_value(&review).unwrap();
        assert_eq!(json["kind"], "sweep");
        assert_eq!(json["nonBlocking"][1]["preExisting"], true);
    }

    /// Skills hub H5 (R12 AC, Challenger): the Builder edits only the Claude
    /// copy of a skill; Finish and check commits the same change to the
    /// Codex copy before the snapshot, so Verify, the Challenger and Ship
    /// read one tree, and the card records what it aligned.
    #[test]
    fn finish_and_check_brings_the_codex_copy_in_line_with_the_claude_copy() {
        let repo = git_repo();
        let wt = repo.path();
        for root in [".claude/skills/x", ".agents/skills/x"] {
            std::fs::create_dir_all(wt.join(root)).unwrap();
            std::fs::write(wt.join(root).join("SKILL.md"), "---\nname: x\ndescription: X.\n---\nOld.\n").unwrap();
        }
        crate::worktrees::commit_pending_in_worktree(wt, "twins").unwrap();
        let base = crate::worktrees::head_sha(wt).unwrap();
        let mut card = builder_card(vec![]);
        card.worktree_path = Some(wt.to_string_lossy().into_owned());
        card.worktree_base = Some(
            serde_json::from_value(serde_json::json!({"commit": base, "refName": "main", "source": "origin"})).unwrap(),
        );
        let state = tempfile::tempdir().unwrap();
        let kanban = KanbanStore::new(state.path().to_path_buf()).unwrap();
        kanban.save("ws", vec![card]).unwrap();
        // The Builder's edit: only Claude's copy.
        std::fs::write(wt.join(".claude/skills/x/SKILL.md"), "---\nname: x\ndescription: X.\n---\nNew.\n").unwrap();
        let (result, _) = record_build_done(&kanban, "ws", "c1", true, None, ReviewKind::Review, None, false).unwrap();
        assert!(result.new_snapshot);
        let card = kanban.get_card("ws", "c1").unwrap();
        let snapshot = card.builder.as_ref().unwrap().snapshots.last().unwrap().sha.clone();
        assert_eq!(snapshot, crate::worktrees::head_sha(wt).unwrap(), "the snapshot is the aligned commit");
        assert_eq!(std::fs::read_to_string(wt.join(".agents/skills/x/SKILL.md")).unwrap(), "---\nname: x\ndescription: X.\n---\nNew.\n");
        assert!(!crate::worktrees::worktree_is_dirty(wt).unwrap());
        assert_eq!(card.twins_aligned, vec![crate::skill_twins::Aligned { skill: "x".into(), winner: crate::skill_reach::Side::Claude }]);
        assert_eq!(
            crate::skill_twins::aligned_note("x", crate::skill_reach::Side::Claude),
            "Codex's copy of x updated to match Claude's."
        );
        // Challenger: a later round that changes Claude's copy back is judged
        // from round 1's aligned snapshot — Codex's copy follows the revert,
        // instead of Claude's being put back to round 1's edit.
        std::fs::write(wt.join(".claude/skills/x/SKILL.md"), "---\nname: x\ndescription: X.\n---\nOld.\n").unwrap();
        record_build_done(&kanban, "ws", "c1", true, None, ReviewKind::Review, None, false).unwrap();
        assert_eq!(std::fs::read_to_string(wt.join(".claude/skills/x/SKILL.md")).unwrap(), "---\nname: x\ndescription: X.\n---\nOld.\n");
        assert_eq!(std::fs::read_to_string(wt.join(".agents/skills/x/SKILL.md")).unwrap(), "---\nname: x\ndescription: X.\n---\nOld.\n");
        // A later round that changes both copies apart aligns nothing: Align asks.
        std::fs::write(wt.join(".claude/skills/x/SKILL.md"), "---\nname: x\ndescription: X.\n---\nMine.\n").unwrap();
        std::fs::write(wt.join(".agents/skills/x/SKILL.md"), "---\nname: x\ndescription: X.\n---\nTheirs.\n").unwrap();
        record_build_done(&kanban, "ws", "c1", true, None, ReviewKind::Review, None, false).unwrap();
        assert_eq!(std::fs::read_to_string(wt.join(".agents/skills/x/SKILL.md")).unwrap(), "---\nname: x\ndescription: X.\n---\nTheirs.\n");
        let card = kanban.get_card("ws", "c1").unwrap();
        assert!(card.twins_aligned.is_empty(), "no note says a copy was updated to match: the two stand apart");
        assert_eq!(card.twins_apart, vec!["x".to_string()]);
    }

    /// Skills hub H5 (Challenger, Builder walk card #75): round 1 edits
    /// Claude's copy and Plyloft aligns Codex's; round 2 puts Codex's copy
    /// back to the base (the Challenger called Plyloft's align "against the
    /// brief"). Finish and check must not align the other way and empty the
    /// card: the Builder's edit stays, the copies stay apart, and the card
    /// says so instead of "updated to match".
    #[test]
    fn a_round_that_undoes_plyloft_s_align_keeps_the_builder_s_edit() {
        let repo = git_repo();
        let wt = repo.path();
        let old = "---\nname: x\ndescription: X.\n---\nOld.\n";
        let edited = "---\nname: x\ndescription: X.\n---\nOld.\nBuilder line (H5 walk).\n";
        for root in [".claude/skills/x", ".agents/skills/x"] {
            std::fs::create_dir_all(wt.join(root)).unwrap();
            std::fs::write(wt.join(root).join("SKILL.md"), old).unwrap();
        }
        crate::worktrees::commit_pending_in_worktree(wt, "twins").unwrap();
        let base = crate::worktrees::head_sha(wt).unwrap();
        let mut card = builder_card(vec![]);
        card.worktree_path = Some(wt.to_string_lossy().into_owned());
        card.worktree_base = Some(
            serde_json::from_value(serde_json::json!({"commit": base, "refName": "main", "source": "origin"})).unwrap(),
        );
        let state = tempfile::tempdir().unwrap();
        let kanban = KanbanStore::new(state.path().to_path_buf()).unwrap();
        kanban.save("ws", vec![card]).unwrap();
        std::fs::write(wt.join(".claude/skills/x/SKILL.md"), edited).unwrap();
        record_build_done(&kanban, "ws", "c1", true, None, ReviewKind::Review, None, false).unwrap();
        assert_eq!(std::fs::read_to_string(wt.join(".agents/skills/x/SKILL.md")).unwrap(), edited);
        // Round 2: Codex's copy back to the base.
        std::fs::write(wt.join(".agents/skills/x/SKILL.md"), old).unwrap();
        let (result, _) = record_build_done(&kanban, "ws", "c1", true, None, ReviewKind::Review, None, false).unwrap();
        assert!(result.new_snapshot);
        assert_eq!(std::fs::read_to_string(wt.join(".claude/skills/x/SKILL.md")).unwrap(), edited, "the Builder's edit stays");
        assert_eq!(std::fs::read_to_string(wt.join(".agents/skills/x/SKILL.md")).unwrap(), old);
        let card = kanban.get_card("ws", "c1").unwrap();
        assert!(card.twins_aligned.is_empty());
        assert_eq!(card.twins_apart, vec!["x".to_string()]);
        let snapshot = card.builder.as_ref().unwrap().snapshots.last().unwrap().sha.clone();
        assert_eq!(snapshot, crate::worktrees::head_sha(wt).unwrap(), "no commit after the Builder's");
        // Round 3 with nothing new: still settled, never flipped.
        std::fs::write(wt.join("README.md"), "unrelated\n").unwrap();
        record_build_done(&kanban, "ws", "c1", true, None, ReviewKind::Review, None, false).unwrap();
        assert_eq!(std::fs::read_to_string(wt.join(".claude/skills/x/SKILL.md")).unwrap(), edited);
        assert_eq!(kanban.get_card("ws", "c1").unwrap().twins_apart, vec!["x".to_string()]);
    }

    #[test]
    fn a_legacy_completed_review_keeps_its_revision_when_replaced() {
        let (repo, _state, kanban) = pushback_fixture();
        let wt = repo.path();
        let reviewed = crate::worktrees::head_sha(wt).unwrap();
        std::fs::write(wt.join("b.txt"), "fix\n").unwrap();
        let (result, job) = record_build_done(&kanban, "ws", "c1", false, None, ReviewKind::Review, None, false).unwrap();
        assert!(result.new_snapshot && job.is_some());
        let card = kanban.get_card("ws", "c1").unwrap();
        let b = card.builder.as_ref().unwrap();
        assert_eq!(b.review.as_ref().unwrap().status, "running");
        assert_eq!(b.last_reviewed_revision.as_deref(), Some(reviewed.as_str()));

        // Review again on an incomplete legacy review of the current snapshot.
        let (_repo2, _state2, kanban) = pushback_fixture();
        kanban
            .with_card("ws", "c1", |c| {
                let review = c.builder.as_mut().unwrap().review.as_mut().unwrap();
                review.verdict = Some("incomplete".into());
                c.review_status = None;
                Ok(())
            })
            .unwrap();
        let sha = kanban.get_card("ws", "c1").unwrap().builder.unwrap().snapshots[1].sha.clone();
        record_review_again(&kanban, "ws", "c1", ReviewKind::Review).unwrap();
        let card = kanban.get_card("ws", "c1").unwrap();
        assert_eq!(card.builder.unwrap().last_reviewed_revision, Some(sha));
    }

    /// GH #99 (review 7): the ship-time line stays on the card when the
    /// review that was running at ship time settles afterwards.
    #[test]
    fn the_ship_time_line_survives_a_later_review() {
        let (_repo, _state, kanban) = pushback_fixture();
        kanban
            .with_card("ws", "c1", |c| {
                let review = c.builder.as_mut().unwrap().review.as_mut().unwrap();
                review.status = "running".into();
                review.verdict = None;
                Ok(())
            })
            .unwrap();
        let card = kanban.get_card("ws", "c1").unwrap();
        let sha = card.builder.as_ref().unwrap().snapshots[1].sha.clone();
        let line = unreviewed_ship_summary(&card, &sha);
        assert!(line.as_deref().unwrap().contains("still running"));
        record_shipped_unreviewed(&kanban, "ws", "c1", line.as_deref());

        let mut card = kanban.get_card("ws", "c1").unwrap();
        record_settled_review(
            &mut card,
            BuilderReview {
                snapshot_n: 5,
                status: "done".into(),
                verdict: Some("approve".into()),
                reviewed_revision: Some(sha.clone()),
                ..Default::default()
            },
            Some(None),
        );
        assert_eq!(unreviewed_ship_summary(&card, &sha), None, "the live rule now sees a review");
        assert_eq!(card.builder.as_ref().unwrap().shipped_unreviewed, line, "the receipt keeps the ship-time line");
    }

    /// GH #99 (review 9): changes requested in one pass, another failed,
    /// pushback accepted — Review again runs the review again, in normal
    /// passes; a plain override with no failed pass does not.
    #[test]
    fn an_overridden_review_with_a_failed_pass_can_run_again() {
        let (_repo, _state, kanban) = pushback_fixture();
        kanban
            .with_card("ws", "c1", |c| {
                let review = c.builder.as_mut().unwrap().review.as_mut().unwrap();
                review.status = "skipped".into();
                review.verdict = None;
                review.note = Some("changes requested on snapshot 5, overridden by the human".into());
                c.review_status = None;
                Ok(())
            })
            .unwrap();
        assert!(record_review_again(&kanban, "ws", "c1", ReviewKind::Review).is_err(), "a plain override is not re-run");
        kanban
            .with_card("ws", "c1", |c| {
                c.builder.as_mut().unwrap().review.as_mut().unwrap().failed_passes = Some(1);
                Ok(())
            })
            .unwrap();
        let job = record_review_again(&kanban, "ws", "c1", ReviewKind::Review).unwrap();
        assert_eq!(job.pass_budget, crate::review_passes::PASS_DIFF_BUDGET);
    }

    #[test]
    fn review_again_refuses_a_worktree_past_the_snapshot() {
        let (repo, _state, kanban) = pushback_fixture();
        kanban
            .with_card("ws", "c1", |c| {
                let review = c.builder.as_mut().unwrap().review.as_mut().unwrap();
                review.status = "failed".into();
                review.verdict = None;
                Ok(())
            })
            .unwrap();
        std::fs::write(repo.path().join("a.txt"), "edited\n").unwrap();
        assert_eq!(
            record_review_again(&kanban, "ws", "c1", ReviewKind::Review).unwrap_err(),
            CHANGED_AFTER_BUILD_DONE
        );
    }

    #[test]
    fn build_done_unchanged_with_skip_review_overrides_changes_requested() {
        let (_repo, _state, kanban) = pushback_fixture();
        let (result, challenger) =
            record_build_done(&kanban, "ws", "c1", true, Some("me@example.com"), ReviewKind::Review, None, false).unwrap();
        assert!(challenger.is_none(), "no Reviewer thread");
        assert!(!result.new_snapshot && !result.reselected, "no new snapshot");
        assert!(result.review_overridden);
        assert!(!result.changes_requested);
        assert!(result.snapshot_verified, "snapshot 5 already passed Verify");
        assert_eq!(result.snapshot.n, 5);

        let card = kanban.get_card("ws", "c1").unwrap();
        let b = card.builder.as_ref().unwrap();
        assert_eq!(b.snapshots.len(), 2);
        let review = b.review.as_ref().unwrap();
        assert_eq!(review.status, "skipped");
        assert_eq!(review.verdict, None);
        assert_eq!(review.snapshot_n, 5);
        assert_eq!(
            review.note.as_deref(),
            Some("changes requested on snapshot 5, overridden by the human")
        );
        assert_eq!(review.overridden_by.as_deref(), Some("me@example.com"));
        assert_eq!(card.review_status, None, "changes-requested cleared");
        assert!(!changes_requested_on_current(&card));
        assert_eq!(card.verify_history.len(), 1, "Verify is not re-run");

        let line = review_override_summary(&card).unwrap();
        assert!(line.contains("round 5"), "{line}");
        assert!(line.contains("me@example.com"), "{line}");
        assert!(line.contains("Codex"), "{line}");
        assert!(line.contains("UTC"), "{line}");

        let (again, _) = record_build_done(&kanban, "ws", "c1", true, Some("me@example.com"), ReviewKind::Review, None, false).unwrap();
        assert!(!again.review_overridden, "a second press has nothing left to override");
    }

    #[test]
    fn build_done_unchanged_without_skip_review_leaves_the_verdict() {
        let (_repo, _state, kanban) = pushback_fixture();
        let before = kanban.get_card("ws", "c1").unwrap();
        let (result, challenger) = record_build_done(&kanban, "ws", "c1", false, Some("me@example.com"), ReviewKind::Review, None, false).unwrap();
        assert!(challenger.is_none());
        assert!(!result.new_snapshot && !result.reselected && !result.review_overridden);
        assert!(result.changes_requested, "the toast explains why Ship is not reachable");
        let card = kanban.get_card("ws", "c1").unwrap();
        assert_eq!(card.builder, before.builder, "review and snapshots untouched");
        assert_eq!(card.review_status, Some(ReviewStatus::ChangesRequested));
        assert!(review_override_summary(&card).is_none());
    }

    #[test]
    fn build_done_with_a_change_still_takes_a_snapshot_and_skips_review() {
        let (repo, _state, kanban) = pushback_fixture();
        std::fs::write(repo.path().join("a.txt"), "B\n").unwrap();
        let (result, challenger) = record_build_done(&kanban, "ws", "c1", true, None, ReviewKind::Review, None, false).unwrap();
        assert!(result.new_snapshot && !result.review_overridden);
        assert!(challenger.is_none(), "skip review starts no Reviewer");
        let card = kanban.get_card("ws", "c1").unwrap();
        let review = card.builder.as_ref().unwrap().review.as_ref().unwrap();
        assert_eq!((review.snapshot_n, review.status.as_str()), (6, "skipped"));
        assert!(review.note.is_none(), "a plain skip is not an override");
        assert!(review_override_summary(&card).is_none());
        assert_eq!(card.review_status, None);
    }

    /// GH #104 walk (A2 + B3): while the Challenger's request for changes
    /// stands, the card is not settled and the proposal pass does not run;
    /// the human accepting the Builder's pushback settles it, and the card
    /// records that decision for the pass to read as authoritative.
    #[test]
    fn a_pending_request_holds_the_proposal_and_the_accepted_pushback_releases_it() {
        use crate::kanban::RequestOutcome;
        let (_repo, _state, kanban) = pushback_fixture();
        let pending = kanban.get_card("ws", "c1").unwrap();
        assert!(
            crate::proposals::card_settled(&pending).unwrap_err().contains("human's decision"),
            "a request for changes waits for the human"
        );
        record_pushback_accepted(&kanban, "ws", "c1", Some("me@example.com")).unwrap();
        let settled = kanban.get_card("ws", "c1").unwrap();
        assert_eq!(crate::proposals::card_settled(&settled), Ok(()));
        let decisions = &settled.builder.as_ref().unwrap().review_decisions;
        assert_eq!(decisions.len(), 1);
        assert_eq!(decisions[0].snapshot_n, 5);
        assert_eq!(decisions[0].outcome, RequestOutcome::PushbackAccepted);
        assert_eq!(decisions[0].by.as_deref(), Some("me@example.com"));
        let lines = crate::proposals::decision_lines(settled.builder.as_ref().unwrap());
        assert!(lines[0].contains("accepted the Builder's pushback"), "{lines:?}");
    }

    /// GH #104 walk (B3): a Build done over a request for changes records
    /// that the Builder changed the code; the new snapshot's review is not in
    /// yet, so the card is not settled.
    #[test]
    fn a_new_snapshot_over_a_request_records_that_the_builder_changed_the_code() {
        use crate::kanban::RequestOutcome;
        let (repo, _state, kanban) = pushback_fixture();
        std::fs::write(repo.path().join("a.txt"), "B\n").unwrap();
        record_build_done(&kanban, "ws", "c1", false, None, ReviewKind::Review, None, false).unwrap();
        let card = kanban.get_card("ws", "c1").unwrap();
        let decisions = &card.builder.as_ref().unwrap().review_decisions;
        assert_eq!(decisions.len(), 1);
        assert_eq!(decisions[0].outcome, RequestOutcome::BuilderChanged);
        assert_eq!((decisions[0].snapshot_n, decisions[0].next_snapshot_n), (5, Some(6)));
        assert!(
            crate::proposals::card_settled(&card).unwrap_err().contains("running"),
            "the fix is not re-reviewed yet"
        );
        // An unchanged Build done records nothing more.
        record_build_done(&kanban, "ws", "c1", false, None, ReviewKind::Review, None, false).unwrap();
        assert_eq!(kanban.get_card("ws", "c1").unwrap().builder.unwrap().review_decisions.len(), 1);
    }

    #[test]
    fn accept_pushback_refuses_a_moved_worktree_and_overrides_otherwise() {
        let (repo, _state, kanban) = pushback_fixture();
        std::fs::write(repo.path().join("a.txt"), "edited\n").unwrap();
        assert_eq!(
            record_pushback_accepted(&kanban, "ws", "c1", None).unwrap_err(),
            CHANGED_AFTER_BUILD_DONE
        );
        assert!(changes_requested_on_current(&kanban.get_card("ws", "c1").unwrap()));

        std::fs::write(repo.path().join("a.txt"), "A\n").unwrap();
        let result = record_pushback_accepted(&kanban, "ws", "c1", None).unwrap();
        assert!(result.review_overridden && result.snapshot_verified);
        let card = kanban.get_card("ws", "c1").unwrap();
        let review = card.builder.as_ref().unwrap().review.as_ref().unwrap();
        assert_eq!(review.status, "skipped");
        assert_eq!(review.overridden_by, None);
        assert!(review_override_summary(&card).unwrap().contains("the person kept it as it was"));
        assert!(
            record_pushback_accepted(&kanban, "ws", "c1", None)
                .unwrap_err()
                .contains("hasn't asked for changes"),
        );
    }

    /// Challenger P1: Ship publishes the checked snapshot SHA, not the
    /// branch the open session can still move.
    #[test]
    fn publish_rev_is_the_snapshot_sha_for_builder_cards_only() {
        let card = builder_card(vec![BuildSnapshot { n: 1, sha: "s1".into(), at: 1 }]);
        assert_eq!(publish_rev(&card, "atelier/card-x"), "s1");
        let mut swarm = card.clone();
        swarm.builder = None;
        assert_eq!(publish_rev(&swarm, "atelier/card-x"), "atelier/card-x");
    }

    fn review_config(self_check: bool, classes: &[(&str, &str)]) -> crate::project_config::ReviewSettings {
        crate::project_config::ReviewSettings {
            blocking_findings: Default::default(),
            self_check,
            review_checklist: classes
                .iter()
                .map(|(name, sentence)| crate::project_config::ReviewChecklistClass {
                    name: (*name).into(),
                    sentence: (*sentence).into(),
                })
                .collect(),
        }
    }

    /// ADR 0006 (third card): Build done sends the self-check only when the
    /// switch is on and there is something new to check, quoting the
    /// repository's classes after the core.
    #[test]
    fn the_self_check_runs_on_a_changed_tree_with_the_switch_on() {
        let (repo, _state, kanban) = pushback_fixture();
        let card = kanban.get_card("ws", "c1").unwrap();
        let on = review_config(true, &[("Branch discovery", "Every lookup names its remote.")]);
        // At the last snapshot: Build done records nothing new.
        assert_eq!(self_check_message(&card, &on, "ply-t1").unwrap(), None);
        std::fs::write(repo.path().join("a.txt"), "changed\n").unwrap();
        let message = self_check_message(&card, &on, "ply-t1").unwrap().expect("a self-check");
        assert!(message.contains("Self-check complete: <number of classes> classes (ply-t1)"));
        assert!(self_check_message(&card, &on, "bad token!").is_err());
        assert!(message.starts_with("[Plyloft] Finish and check — self-check first."));
        assert!(message.contains("I. User-facing text and states"));
        assert!(message.contains("J. Branch discovery — Every lookup names its remote."));
        assert!(message.contains("one line per class, A to J"));
        // Owner decision (2026-10-01): this fixture has no test suite and its
        // brief asks for none, so class H only reports missing cases.
        assert!(message.contains(crate::review_passes::SELF_CHECK_TESTS_REPORT), "{message}");
        std::fs::write(repo.path().join("a.test.js"), "test\n").unwrap();
        crate::platform::git_command()
            .args(["add", "a.test.js"])
            .current_dir(repo.path())
            .status()
            .unwrap();
        let message = self_check_message(&card, &on, "ply-t1").unwrap().expect("a self-check");
        assert!(message.contains(crate::review_passes::SELF_CHECK_TESTS_EXTEND), "{message}");
        // No config, or one written before the switch: on; off sends nothing.
        assert!(self_check_message(&card, &Default::default(), "ply-t1").unwrap().is_some());
        let off = review_config(false, &[]);
        assert_eq!(self_check_message(&card, &off, "ply-t1").unwrap(), None);
    }

    /// ADR 0006 (third card): commits the Builder made during its self-check
    /// are in the snapshot, and the card keeps how the self-check went.
    #[test]
    fn the_snapshot_is_taken_after_the_self_check_commits() {
        let (repo, _state, kanban) = pushback_fixture();
        let wt = repo.path();
        std::fs::write(wt.join("a.txt"), "built\n").unwrap();
        // The self-check found something, fixed it and committed.
        std::fs::write(wt.join("fix.txt"), "self-check fix\n").unwrap();
        crate::git::run(wt, &["add", "-A"]).unwrap();
        crate::git::run(wt, &["commit", "-q", "-m", "self-check: fix"]).unwrap();
        let fixed = crate::worktrees::head_sha(wt).unwrap();
        let record = SelfCheckRecord {
            outcome: crate::kanban::SelfCheckOutcome::Answered,
            started_at: 10,
            duration_ms: 42_000,
            snapshot_n: None,
        };
        let (result, job) =
            record_build_done(&kanban, "ws", "c1", false, None, ReviewKind::Sweep, Some(record), false).unwrap();
        assert!(result.new_snapshot && job.is_some());
        assert_eq!(result.snapshot.sha, fixed, "the snapshot is the self-check's commit");
        let card = kanban.get_card("ws", "c1").unwrap();
        let kept = card.builder.as_ref().unwrap().self_check.clone().unwrap();
        assert_eq!(kept.snapshot_n, Some(result.snapshot.n));
        assert_eq!(kept.duration_ms, 42_000);
        let json = serde_json::to_value(&card).unwrap();
        assert_eq!(json["builder"]["selfCheck"]["outcome"], "answered");
    }

    /// A timed-out self-check is recorded as such, for the note on the card.
    #[test]
    fn a_timed_out_self_check_is_kept_on_the_card() {
        let (repo, _state, kanban) = pushback_fixture();
        std::fs::write(repo.path().join("a.txt"), "B\n").unwrap();
        let record = SelfCheckRecord {
            outcome: crate::kanban::SelfCheckOutcome::TimedOut,
            started_at: 1,
            duration_ms: (SELF_CHECK_TIMEOUT_SECS * 1000) as i64,
            snapshot_n: None,
        };
        record_build_done(&kanban, "ws", "c1", false, None, ReviewKind::Review, Some(record), false).unwrap();
        let card = kanban.get_card("ws", "c1").unwrap();
        let json = serde_json::to_value(&card).unwrap();
        assert_eq!(json["builder"]["selfCheck"]["outcome"], "timedOut");
    }

    /// Cards written before the self-check load without one.
    #[test]
    fn a_card_before_the_self_check_loads_without_one() {
        let card: KanbanCard = serde_json::from_str(
            r#"{"id":"c1","workspaceId":"ws","title":"t","columnId":"in_progress","createdAt":0,"updatedAt":0,
                "builder":{"vendor":"claude","snapshots":[{"n":1,"sha":"s","at":0}]}}"#,
        )
        .unwrap();
        assert_eq!(card.builder.unwrap().self_check, None);
    }

    /// v1.154.1 (F11, walks D and E): the card's pull request #11 is open.
    /// A review round on the fix — the Challenger's request for changes, the
    /// accepted pushback, a newer snapshot, an approval — never erases it:
    /// `review_status` goes back to `Merged`, so Push update stays offered.
    #[test]
    fn an_open_pull_request_survives_a_review_round() {
        let open_pr = |kanban: &KanbanStore, state: crate::pr_status::PrState| {
            kanban
                .with_card("ws", "c1", |c| {
                    c.pr_url = Some("https://github.com/o/r/pull/11".into());
                    let mut pr = crate::pr_status::PrStatus::opened(11, 1);
                    pr.state = state;
                    c.pr = Some(pr);
                    Ok(())
                })
                .unwrap();
        };
        use crate::pr_status::PrState;

        // Changes requested (it overwrote Merged), then the pushback accepted.
        let (_repo, _state, kanban) = pushback_fixture();
        open_pr(&kanban, PrState::Open);
        record_pushback_accepted(&kanban, "ws", "c1", None).unwrap();
        assert_eq!(kanban.get_card("ws", "c1").unwrap().review_status, Some(ReviewStatus::Merged));

        // A newer snapshot supersedes the request for changes.
        let (repo, _state, kanban) = pushback_fixture();
        open_pr(&kanban, PrState::Open);
        std::fs::write(repo.path().join("a.txt"), "B\n").unwrap();
        let (result, _) = record_build_done(&kanban, "ws", "c1", true, None, ReviewKind::Review, None, false).unwrap();
        assert!(result.new_snapshot);
        assert_eq!(kanban.get_card("ws", "c1").unwrap().review_status, Some(ReviewStatus::Merged));

        // The Challenger approves the fix.
        let (_repo, _state, kanban, slots) = reviewing_fixture();
        open_pr(&kanban, PrState::Open);
        kanban
            .with_card("ws", "c1", |c| {
                c.review_status = Some(ReviewStatus::Merged);
                Ok(())
            })
            .unwrap();
        settle_in(&slots, &kanban, settled_review(5, "done", Some("approve")), Some(None), &[]);
        assert_eq!(kanban.get_card("ws", "c1").unwrap().review_status, Some(ReviewStatus::Merged));

        // Without an open pull request (closed, or none) it clears as before.
        let (_repo, _state, kanban) = pushback_fixture();
        open_pr(&kanban, PrState::Closed);
        record_pushback_accepted(&kanban, "ws", "c1", None).unwrap();
        assert_eq!(kanban.get_card("ws", "c1").unwrap().review_status, None);
        let (_repo, _state, kanban) = pushback_fixture();
        record_pushback_accepted(&kanban, "ws", "c1", None).unwrap();
        assert_eq!(kanban.get_card("ws", "c1").unwrap().review_status, None);
    }

    /// v1.154.1 (F17): a resumed session that exits at once is recorded as
    /// a Resume that failed; a later exit, or a fresh session's, is not.
    #[test]
    fn a_resume_that_ends_at_once_is_said_as_such() {
        let r = BuilderRegistry::default();
        r.mark_resumed("c1", "pty-2", 1_000);
        assert_eq!(r.take_resumed("c1", "pty-1"), None, "another session's exit");
        assert_eq!(r.take_resumed("c1", "pty-2"), Some(1_000));
        assert_eq!(r.take_resumed("c1", "pty-2"), None, "asked once");
        assert!(resumed_quickly(1_000, 1_000 + RESUME_QUICK_EXIT_MS - 1));
        assert!(!resumed_quickly(1_000, 1_000 + RESUME_QUICK_EXIT_MS));
    }

    /// v1.154.1 round 2 (walk J1): only a Codex Builder looks for a session
    /// id, and a card with no folder or no session there has none.
    /// Round 3 (L2): Codex's own words for a resume it can't open, as the
    /// walk's PTY drew them, mark a resumed session as failed however long
    /// the trust question took; a session not resumed, or other output,
    /// never does.
    #[test]
    fn codex_saying_it_cannot_resume_is_a_failed_resume() {
        let captured: &[u8] = b"\x1b[<1u\x1b[<1u\x1b[<u\x1b[>4;0mError: Failed to resume session from \
/Users/m/Library/Application Support/com.mbadv.ply.test/team/codex-home/9c5788bb-62c5-4d7c-b461-fb19b1b5a986/\r\n\
sessions/2026/09/29/rollout-2026-09-29T16-33-20-01a0ed95-9c57-71c3-adef-60dba1abd84b.jsonl: thread/resume failed \
during TUI bootstrap: thread/resume failed: no rollout\r\n found for thread id 01a0ed95-9c57-71c3-adef-60dba1abd84b (code -32600)\r\n";
        assert!(resume_failed_in_output(captured));
        let mut long = vec![b'x'; 100_000];
        long.extend_from_slice(captured);
        assert!(resume_failed_in_output(&long), "only the tail is read, and it is there");
        assert!(!resume_failed_in_output(b"\x1b[32m\xe2\x80\xa2 Done: added inc(a)\x1b[0m\r\n"));

        let at = 1_000;
        let late = at + RESUME_QUICK_EXIT_MS + 30_000; // a slow answer to the trust question
        assert!(resume_failed(Some(at), late, Some(captured)));
        assert!(!resume_failed(Some(at), late, Some(b"bye\r\n")));
        assert!(resume_failed(Some(at), at + 500, None), "the 10 s rule still holds");
        assert!(!resume_failed(None, at + 500, Some(captured)), "never for a session not resumed");
        let capture = Mutex::new(long);
        let tail = capture_tail(&capture);
        assert_eq!(tail.len(), RESUME_FAILED_TAIL);
        assert!(resume_failed_in_output(&tail));
        assert_eq!(capture_tail(&Mutex::new(b"short".to_vec())), b"short".to_vec());
    }

    #[test]
    fn only_codex_looks_for_its_own_session() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().to_string_lossy().into_owned();
        assert_eq!(codex_session_for("claude", Some(&folder), None), None);
        assert_eq!(codex_session_for("codex", None, Some(1)), None);
    }

    /// v1.154.1 (F17): `resumeFailed` is new; a card written before it loads.
    #[test]
    fn a_builder_written_before_resume_failed_loads_without_it() {
        let legacy: BuilderState =
            serde_json::from_str(r#"{"vendor":"claude","sessionLost":true,"snapshots":[]}"#).unwrap();
        assert!(legacy.session_lost && !legacy.resume_failed);
        let mut state = legacy;
        state.resume_failed = true;
        let json = serde_json::to_value(&state).unwrap();
        assert_eq!(json["resumeFailed"], true);
        let back: BuilderState = serde_json::from_value(json).unwrap();
        assert!(back.resume_failed);
    }
}

#[cfg(test)]
mod screen_block_tests {
    use super::*;

    /// Terminals block P3: a tile's screen as xterm draws it (text, rows
    /// joined by newlines) is read with the Builder's rules.
    #[test]
    fn a_tile_s_drawn_screen_says_trust_the_limit_or_nothing() {
        let trust = "Trust this folder? Codex can read, edit, and run files here.\n\n› 1. Trust and continue\n  2. Quit\n\n  enter continue · esc quit\n";
        assert_eq!(screen_block(trust).map(|b| b.0), Some(SessionBlockKind::Trust));
        let limit = "You've hit your limit · resets 3pm\n\n❯ 1. Stop and wait for limit to reset\n  2. Upgrade your plan\n";
        let (kind, resets) = screen_block(limit).unwrap();
        assert_eq!(kind, SessionBlockKind::UsageLimit);
        assert_eq!(resets.as_deref(), Some("3pm"));
        assert_eq!(screen_block("❯ \n  ? for shortcuts\n"), None);
    }

    /// 1.176.2: Codex 0.171's trust screen as a tile draws it, and 0.158's.
    #[test]
    fn a_tile_s_codex_171_trust_screen_says_trust() {
        let v171 = "Folder access\n/Users/o/my-site\n\nTrust this folder? Codex can read, edit, and run files here, subject to your permission settings.\n\n› 1. Trust and continue\n  2. Back to Agent Command Center\n\n  enter continue · esc back\n";
        assert_eq!(screen_block(v171).map(|b| b.0), Some(SessionBlockKind::Trust));
        let v158 = v171.replace("Back to Agent Command Center", "Quit").replace("esc back", "esc quit");
        assert_eq!(screen_block(&v158).map(|b| b.0), Some(SessionBlockKind::Trust));
    }
}
