//! v1.7.0: per-card intake conversation. The user clicks "Confirm intake"
//! on a card; this module spawns a `claude` REPL PTY in the workspace cwd
//! with a system prompt that instructs the agent to (a) read the card +
//! inspect the codebase read-only, (b) hold a back-and-forth conversation
//! with the user — always asking before assuming — and (c) on receipt of
//! the `__CONCLUDE_INTAKE__` sentinel, write a JSON proposal to a known
//! draft path and exit.
//!
//! The frontend then reads the draft, validates it, and applies it to the
//! card (`dispatchPrompt` + `intakeStatus: ready`).
//!
//! OB-14 (§13.3): the intake runs with the card's Builder vendor when it is
//! ready, else the other one (`intake_vendor`). Claude's intake is exactly
//! the above. A Codex intake is the Codex TUI in a PTY (the `codex`
//! lifecycle, never `codex-chat`), `-C <workspace> -s read-only -a never` —
//! MEASUREMENTS §6 candidate (c): the project's AGENTS.md loads and the tree
//! stays clean. It gets the instructions and the card as its first prompt,
//! and answers the conclude sentinel with the proposal as the last fenced
//! `json` block of its final message; `intake_read_draft` reads it from the
//! session rollout's `task_complete.last_agent_message` (the transcript as
//! fallback) and writes it to the same draft path, so apply is unchanged.
//!
//! Design constraints:
//! - Hard Rule #1: claude CLI subprocess in a portable-pty PTY, no API
//!   key. Reuses `PtyRegistry::spawn`.
//! - Draft files are written by the agent's own write tool; we only read +
//!   delete them.
//! - The intake agent runs with the built-in `DEFAULT_SYSTEM_PROMPT`. GH #214:
//!   the pre-1.146 overrides (`<config_dir>/intake/system_prompt.md`, and
//!   `<config_dir>/projects/<wsId>/intake.md`) could no longer be seen or
//!   reset, so they are no longer read; any such file stays on disk untouched.
//! - The intake agent does NOT live in `agents.json` (agents.rs's
//!   AgentRegistry stays uninvolved). Intake is interactive REPL; the
//!   AgentRegistry abstractions (transcript, snapshot, run record) don't
//!   apply.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Listener, Manager};

use crate::kanban::{CardAttachment, KanbanStore};
use crate::pty::PtyRegistry;
use crate::shell_env;
use crate::swarm_templates::{SwarmTemplate, SwarmTemplatesStore};

/// v1.7.1: how long to wait after spawning claude before injecting the
/// priming message body. claude renders a startup banner ("Try 'edit
/// VERSION to...'" + "? for shortcuts") before its REPL is ready to
/// consume stdin; writing too early loses bytes or interleaves with the
/// banner. 1500ms is comfortably past the observed banner time.
const PRIMING_DELAY_MS: u64 = 1500;

/// v1.7.3: how long to wait between writing the priming body and the
/// submit keystroke. A trailing `\r` glued onto the body is treated as
/// part of the multi-line input by claude REPL (the `\n\n` section
/// separators put it into "multi-line paste" mode where a single CR
/// is just another line break). Delivering an isolated `\r` as a
/// separate write — after claude has finished rendering the body in its
/// input area — lands as a clean Enter keystroke that submits.
const PRIMING_SUBMIT_DELAY_MS: u64 = 400;

const INTAKE_SUBDIR: &str = "intake";
const DRAFTS_SUBDIR: &str = "intake_drafts";
/// v1.19.0 (Cycle E4): on-disk root for persisted intake conversation
/// transcripts, captured via `PtyRegistry::spawn_with_capture` and
/// finalized when intake_apply / intake_cancel runs. Path layout:
/// `<config_dir>/intake/transcripts/<wsId>/<cardId>/<intake_id>.log`.
const TRANSCRIPTS_SUBDIR: &str = "transcripts";

/// Sentinel string the user-facing "Finish planning" (`FINISH_PLANNING_LABEL`) button writes into
/// the agent's stdin to trigger the JSON proposal write. Kept stable across
/// versions because it's referenced directly inside `DEFAULT_SYSTEM_PROMPT`.
///
/// Literal body sent by the Conclude button. The submit keystroke is a
/// separate PTY write: Claude's interactive TUI does not reliably interpret
/// a carriage return glued to programmatic text as Enter.
pub const CONCLUDE_SENTINEL: &str = "__CONCLUDE_INTAKE__";

/// The intake agent's system prompt — the only one it runs with (GH #214: a
/// pre-1.146 override on disk is ignored; see `IntakeStore::system_prompt`).
/// The text is intentionally explicit about the
/// always-ask-never-guess invariant and the conclude protocol — both load-
/// bearing for the v1.7.x calibration phase.
pub const DEFAULT_SYSTEM_PROMPT: &str = include_str!("intake_system_prompt.md");

/// The card page's button that sends [`CONCLUDE_SENTINEL`]: the same words
/// as `FINISH_PLANNING_LABEL` in `src/lib/cardPage.ts` (a vitest pins the
/// two together). The prompt names the button through it, so the agent never
/// tells the user to click a button that isn't there (1.168.1 B1).
pub const FINISH_PLANNING_LABEL: &str = "Finish planning";

/// `{{FINISH_PLANNING}}` in the built-in prompt, filled with the button's
/// real name.
fn name_the_button(base: &str) -> String {
    base.replace("{{FINISH_PLANNING}}", FINISH_PLANNING_LABEL)
}

/// Per-card intake session metadata. The `pty_id` references a session
/// owned by `PtyRegistry`; this module only stores the mapping and the
/// draft path so `intake_apply` can read it on conclude.
///
/// v1.19.0 (Cycle E4): also tracks the per-session `intake_id` (UUID) and
/// a shared transcript buffer. The PTY reader thread (via
/// `PtyRegistry::spawn_with_capture`) tees its bytes into the buffer;
/// `intake_apply` / `intake_cancel` finalize it to disk.
///
/// v1.20.2: `last_activity_at` is bumped by the PTY reader on every byte
/// of output so the idle sweeper measures genuine idle time rather than
/// wall-clock since spawn. Shared `Arc<AtomicI64>` because the reader
/// thread writes and the sweeper reads.
#[derive(Debug, Clone)]
pub struct IntakeSession {
    pub pty_id: String,
    pub workspace_id: String,
    pub card_id: String,
    pub draft_path: PathBuf,
    pub started_at: i64,
    pub last_activity_at: Arc<AtomicI64>,
    pub intake_id: String,
    pub transcript_buf: Arc<parking_lot::Mutex<Vec<u8>>>,
    /// OB-14 (§13.3): "claude" | "codex" — who holds the conversation. A
    /// Codex intake runs read-only and hands its proposal back in its final
    /// message, not as a file (`codex_draft_from_rollout`).
    pub vendor: String,
    /// OB-14: a Codex intake's session rollout, once found (shared by the
    /// registry's clones, so each poll reads only it).
    pub rollout_path: Arc<parking_lot::Mutex<Option<PathBuf>>>,
    /// N14 walk F10 (Challenger P2): set once its PTY has exited (its
    /// `pty://exit`). The registry entry outlives the child until the
    /// frontend applies or cancels; an exited session asks nothing and
    /// gets no first prompt.
    pub exited: Arc<std::sync::atomic::AtomicBool>,
}

/// In-memory mapping `card_id → IntakeSession`. Multiple cards may have
/// concurrent intakes (one PTY each); the UI surfaces the selected card's
/// session via the right-panel Card tab.
#[derive(Default)]
pub struct IntakeRegistry {
    sessions: Mutex<HashMap<String, IntakeSession>>,
}

impl IntakeRegistry {
    pub fn insert(&self, session: IntakeSession) {
        self.sessions.lock().insert(session.card_id.clone(), session);
    }

    pub fn get(&self, card_id: &str) -> Option<IntakeSession> {
        self.sessions.lock().get(card_id).cloned()
    }

    pub fn remove(&self, card_id: &str) -> Option<IntakeSession> {
        self.sessions.lock().remove(card_id)
    }

    pub fn pty_id_for(&self, card_id: &str) -> Option<String> {
        self.sessions.lock().get(card_id).map(|s| s.pty_id.clone())
    }

    /// v1.9.0 (Phase A): snapshot of every active intake session, keyed
    /// by card id. Read by `ship::ship_audit` so the pre-ship modal can
    /// list intakes the user might lose if they Force-ship.
    pub fn list_active(&self) -> Vec<IntakeSession> {
        self.sessions.lock().values().cloned().collect()
    }

    /// N14 walk F10 (Challenger P3b): end a card's intake without touching
    /// the card — its row may already be gone (a delete). `kill` ends the
    /// PTY as app exit does; with the entry gone the priming thread stops.
    /// `false` when the card had no intake.
    pub fn end_session_with(&self, card_id: &str, kill: impl FnOnce(&str)) -> bool {
        let Some(session) = self.remove(card_id) else {
            return false;
        };
        kill(&session.pty_id);
        true
    }

    /// [`Self::end_session_with`] through the PTY registry.
    pub fn end_session(&self, pty_registry: &PtyRegistry, card_id: &str) -> bool {
        self.end_session_with(card_id, |pty_id| {
            if let Err(e) = pty_registry.kill(pty_id) {
                log::warn!("intake: ending {card_id}'s intake ({pty_id}): {e}");
            }
        })
    }

    /// N14 walk F10: every live intake whose screen ends on its CLI's
    /// folder-trust question, keyed by card — read from the transcript the
    /// PTY reader keeps whether or not the conversation is on screen.
    /// Plyloft never answers it; the person does, in the intake terminal.
    pub fn trust_questions(&self) -> Vec<crate::builder::SessionBlock> {
        // Taken out of the registry first: no capture is read under its lock.
        let live = self.list_active();
        let mut out: Vec<crate::builder::SessionBlock> = live
            .into_iter()
            .filter(|s| !s.exited.load(Ordering::Relaxed))
            .filter(|s| crate::builder::trust_question_pending(&transcript_tail(&s.transcript_buf)))
            .map(|s| crate::builder::SessionBlock {
                key: s.card_id,
                workspace_id: s.workspace_id,
                vendor: s.vendor,
                intake: true,
                kind: crate::builder::SessionBlockKind::Trust,
                resets_at: None,
            })
            .collect();
        out.sort_by(|a, b| a.key.cmp(&b.key));
        out
    }

    /// N14 walk F14: the cards whose intake conversation has ended (its PTY
    /// exited — "No, exit" at the trust question, a crash, `/exit`) while
    /// the card still reads as planning: the entry stays until the person
    /// cancels or plans again. The Board, the card's Now box and the Inbox
    /// say it stopped, whether or not the card's page saw the exit.
    pub fn ended_cards(&self) -> Vec<String> {
        self.cards_where(true)
    }

    /// N14 walk F14 (Challenger P3-4): the cards whose intake is live (in
    /// the registry, its PTY not exited). A card that plans with neither a
    /// live nor an ended entry has no conversation left (a webview reload,
    /// a close the frontend missed): the frontend counts it as stopped.
    pub fn live_cards(&self) -> Vec<String> {
        self.cards_where(false)
    }

    fn cards_where(&self, exited: bool) -> Vec<String> {
        let mut out: Vec<String> = self
            .list_active()
            .into_iter()
            .filter(|s| s.exited.load(Ordering::Relaxed) == exited)
            .map(|s| s.card_id)
            .collect();
        out.sort();
        out
    }
}

/// N14 walk F14: the intakes the frontend reads each poll — which ended
/// while their card still plans, and which are live.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IntakeSessionsReport {
    pub ended: Vec<String>,
    pub live: Vec<String>,
}

impl IntakeRegistry {
    pub fn sessions_report(&self) -> IntakeSessionsReport {
        IntakeSessionsReport {
            ended: self.ended_cards(),
            live: self.live_cards(),
        }
    }
}

/// How much of an intake's transcript the trust and readiness checks read.
const PRIMING_SCAN_BYTES: usize = 24 * 1024;

fn transcript_tail(buf: &parking_lot::Mutex<Vec<u8>>) -> Vec<u8> {
    let bytes = buf.lock();
    bytes[bytes.len().saturating_sub(PRIMING_SCAN_BYTES)..].to_vec()
}

/// N14 walk F10: how long the priming waits, with no trust question on
/// screen, for Claude's REPL to show it is ready before typing anyway (a
/// Claude build whose idle screen none of the markers match).
const PRIMING_FALLBACK_MS: u64 = 8_000;
/// …and only once the screen has drawn something and then stayed still
/// this long (Challenger P3a): never into a question still being drawn.
const PRIMING_STILL_MS: u64 = 1_500;
/// How often the priming thread reads the transcript while it waits.
const PRIMING_POLL_MS: u64 = 100;
/// Once the REPL is drawn, a moment for it to take input.
const PRIMING_SETTLE_MS: u64 = 300;
/// The priming stops waiting after this long (the idle sweeper ends an
/// intake left an hour anyway).
const PRIMING_GIVE_UP_MS: u64 = 60 * 60 * 1000;

/// N14 walk F10: whether the intake may type its first prompt now. Before,
/// it typed after a fixed 1.5 s: in a folder Claude didn't trust yet the
/// text landed in the trust question and its Enter chose the highlighted
/// "No, exit", so the intake died with code 1 and no one had answered.
/// Now: as soon as the REPL is ready; never while the trust question is on
/// screen (the person answers it in the intake terminal, however long that
/// takes); and after [`PRIMING_FALLBACK_MS`] without a question, as before
/// — only once something is on screen and it has not changed for
/// [`PRIMING_STILL_MS`] (`still_for`).
pub(crate) fn priming_may_write(tail: &[u8], waited_without_question: Duration, still_for: Duration) -> bool {
    if crate::builder::claude_repl_ready(tail) {
        return true;
    }
    if crate::builder::trust_question_pending(tail) {
        return false;
    }
    waited_without_question >= Duration::from_millis(PRIMING_FALLBACK_MS)
        && still_for >= Duration::from_millis(PRIMING_STILL_MS)
        && crate::builder::has_visible_text(tail)
        && !crate::builder::trust_words_on_screen(tail)
}

/// v1.17.0 (Cycle E.5): cutoff used by the launch-time intake idle
/// sweeper. Intakes whose **last activity** is older than `now - this`
/// AND whose card status is not `Ready` (sentinel-concluded but not
/// yet applied) are auto-cancelled.
///
/// v1.20.2 (hotfix): cutoff is now measured against the last byte of
/// PTY *output* rather than session start. Previously this constant
/// was effectively a hard session-duration cap — a 15+ minute active
/// conversation would get its PTY killed mid-flight with SIGHUP
/// (exit code 129).
///
/// v1.20.3 (hotfix): user-input keystrokes also bump the beacon (the
/// PTY `write` path now stamps it via `pty::PtySession.activity`), so
/// a user sitting at an interactive permission prompt for many
/// minutes without typing still survives — and once they type a
/// single key, the clock resets. Timeout raised 15 → 60 minutes,
/// since the previous value made sense only as a hard duration cap;
/// a true idle window of an hour is generous enough that a user
/// reading a prompt never trips it.
pub const IDLE_INTAKE_TIMEOUT_MS: i64 = 60 * 60 * 1000;

/// v1.17.0 (Cycle E.5): pure helper for the idle sweeper. Returns
/// true when an intake whose last activity was at `last_activity_ms`
/// should be auto-cancelled given the current epoch `now_ms` and
/// whether the card has already reached `Ready` (sentinel concluded
/// but not applied — never auto-cancel those).
///
/// v1.20.2: the second argument is the last-activity timestamp, not
/// session start. The sweeper passes the atomic stamped by the PTY
/// reader on every output byte; the timestamp moves forward whenever
/// the agent (or the user's keystroke-echo) emits output.
///
/// v1.20.3: the same atomic is also stamped by `PtyRegistry::write`
/// on every successful user-input write, so a silent permission
/// prompt that only progresses when the user types still counts as
/// activity at the keystroke moment (no echo required).
pub fn is_idle_for_cancel(
    now_ms: i64,
    last_activity_ms: i64,
    is_ready: bool,
) -> bool {
    if is_ready {
        return false;
    }
    now_ms.saturating_sub(last_activity_ms) > IDLE_INTAKE_TIMEOUT_MS
}

/// GH #214: the file names of the pre-1.146 intake prompt overrides — the
/// global `<config_dir>/intake/system_prompt.md` and a per-workspace
/// `<config_dir>/projects/<wsId>/intake.md`. Named only so the log can say an
/// ignored one is there; nothing reads them.
const IGNORED_GLOBAL_OVERRIDE: &str = "system_prompt.md";
const IGNORED_WORKSPACE_OVERRIDE: &str = "intake.md";

/// The ignored override files present under `config_dir`: existence checks
/// only, never a read.
fn ignored_overrides(config_dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let global = config_dir.join(INTAKE_SUBDIR).join(IGNORED_GLOBAL_OVERRIDE);
    if global.is_file() {
        found.push(global);
    }
    if let Ok(entries) = fs::read_dir(config_dir.join("projects")) {
        let mut per_workspace: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path().join(IGNORED_WORKSPACE_OVERRIDE))
            .filter(|p| p.is_file())
            .collect();
        per_workspace.sort();
        found.extend(per_workspace);
    }
    found
}

/// Intake's on-disk places: the drafts and transcripts, and the prompt it
/// runs with.
pub struct IntakeStore {
    config_dir: PathBuf,
}

impl IntakeStore {
    pub fn new(config_dir: PathBuf) -> Result<Self, String> {
        let intake_dir = config_dir.join(INTAKE_SUBDIR);
        fs::create_dir_all(&intake_dir).map_err(|e| format!("create intake dir: {e}"))?;
        let drafts_dir = config_dir.join(DRAFTS_SUBDIR);
        fs::create_dir_all(&drafts_dir).map_err(|e| format!("create drafts dir: {e}"))?;
        // GH #214 review 1: say once per launch (the store is made once, at
        // setup) where an ignored override sits — its path, never its text.
        for path in ignored_overrides(&config_dir) {
            log::info!(
                "intake: ignoring the pre-1.146 prompt override at {} (GH #214); it is left on disk",
                path.display()
            );
        }
        Ok(Self { config_dir })
    }

    /// The system prompt intake runs with: always the built-in default.
    ///
    /// GH #214: an override written before v1.146 — the global
    /// `<config_dir>/intake/system_prompt.md` (Settings › Agents, retired in
    /// GH #171) or a per-workspace `<config_dir>/projects/<wsId>/intake.md`
    /// (v1.12.3, whose commands had no caller) — is no longer read. Nothing
    /// could show or reset it any more; the file is left where it is,
    /// never deleted or rewritten.
    pub fn system_prompt(&self) -> &'static str {
        DEFAULT_SYSTEM_PROMPT
    }

    /// Ply's config directory (where the Codex overlays live, OB-14).
    pub fn config_dir(&self) -> &Path {
        &self.config_dir
    }

    pub fn drafts_dir(&self) -> PathBuf {
        self.config_dir.join(DRAFTS_SUBDIR)
    }

    pub fn draft_path(&self, workspace_id: &str, card_id: &str) -> PathBuf {
        self.drafts_dir()
            .join(workspace_id)
            .join(format!("{card_id}.json"))
    }

    /// v1.19.0 (Cycle E4): absolute path of the transcript file for a
    /// given intake session. Resolves to
    /// `<config_dir>/intake/transcripts/<wsId>/<cardId>/<intake_id>.log`.
    pub fn transcript_path(
        &self,
        workspace_id: &str,
        card_id: &str,
        intake_id: &str,
    ) -> PathBuf {
        self.config_dir
            .join(INTAKE_SUBDIR)
            .join(TRANSCRIPTS_SUBDIR)
            .join(workspace_id)
            .join(card_id)
            .join(format!("{intake_id}.log"))
    }

    /// v1.19.0 (Cycle E4): same as `transcript_path` but returns a path
    /// relative to `config_dir`. Stored on `IntakeRecord.transcript_path`
    /// so the kanban file is portable across environments (the absolute
    /// path is resolved at read time by joining with the live
    /// `config_dir`).
    pub fn transcript_relpath(
        workspace_id: &str,
        card_id: &str,
        intake_id: &str,
    ) -> PathBuf {
        PathBuf::from(INTAKE_SUBDIR)
            .join(TRANSCRIPTS_SUBDIR)
            .join(workspace_id)
            .join(card_id)
            .join(format!("{intake_id}.log"))
    }

    /// v1.19.0 (Cycle E4): atomically write a captured intake transcript
    /// to disk. ANSI-stripped (REPL bytes carry xterm color CSIs and
    /// shell-integration OSCs that would render as garbage in `<pre>`).
    /// Returns the relative path stored on `IntakeRecord`. Fails fast on
    /// IO errors so the caller can decide whether to still append the
    /// record without a transcript_path.
    pub fn finalize_transcript(
        &self,
        workspace_id: &str,
        card_id: &str,
        intake_id: &str,
        raw: &[u8],
    ) -> Result<PathBuf, String> {
        let abs = self.transcript_path(workspace_id, card_id, intake_id);
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("create transcript dir: {e}"))?;
        }
        // 1.168.1 (A3): a TUI draws many of its spaces as a cursor move
        // (`ESC[<n>C`, Windows' ConPTY also `ESC[<n>X`); dropped with the
        // other escapes they glued the words together ("Wrote4linesto~/…")
        // in the transcript History search reads. They become spaces first.
        let text = crate::read_only_provider::json_text(&String::from_utf8_lossy(raw));
        let tmp = abs.with_extension("log.tmp");
        fs::write(&tmp, text.as_bytes()).map_err(|e| format!("write tmp: {e}"))?;
        crate::platform::rename(&tmp, &abs).map_err(|e| format!("rename: {e}"))?;
        Ok(Self::transcript_relpath(workspace_id, card_id, intake_id))
    }

    /// v1.19.0 (Cycle E4): read a persisted transcript by relative path.
    /// Returns `Ok(None)` when the file is missing (evicted by FIFO cap
    /// or never produced). UTF-8 lossy parse — transcripts are already
    /// ANSI-stripped at write time.
    pub fn read_transcript(
        &self,
        rel_path: &str,
    ) -> Result<Option<String>, String> {
        let abs = self.config_dir.join(rel_path);
        if !abs.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&abs).map_err(|e| format!("read transcript: {e}"))?;
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    }

    /// Read + parse a draft, returning `None` if the file doesn't exist.
    /// Parse errors propagate — callers surface them to the user.
    pub fn read_draft(
        &self,
        workspace_id: &str,
        card_id: &str,
    ) -> Result<Option<IntakeProposal>, String> {
        let p = self.draft_path(workspace_id, card_id);
        if !p.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&p).map_err(|e| format!("read draft: {e}"))?;
        let proposal: IntakeProposal = serde_json::from_slice(&bytes)
            .map_err(|e| format!("parse draft JSON: {e}"))?;
        Ok(Some(proposal))
    }

    /// v1.20.3: scan the workspace's drafts directory for any `*.json`
    /// files that look like strays — i.e. could plausibly be a draft
    /// the agent wrote to a hallucinated `card_id` path. A file qualifies
    /// when:
    /// - it's a regular file with extension `json`
    /// - its mtime is at or after `since_ms − 5_000` (5s slack absorbs
    ///   FS-clock vs Atelier-clock skew; both are wall-clock epoch-ms)
    /// - its file stem is NOT in `exclude_card_ids` (those are other
    ///   active intakes' canonical filenames, not strays)
    ///
    /// Returns the absolute paths. Missing workspace directory →
    /// `Ok(vec![])`. Caller decides what to do with zero / one / many.
    pub fn stray_drafts(
        &self,
        workspace_id: &str,
        since_ms: i64,
        exclude_card_ids: &[String],
    ) -> Result<Vec<PathBuf>, String> {
        let dir = self.drafts_dir().join(workspace_id);
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let cutoff_ms = since_ms.saturating_sub(5_000);
        let entries = fs::read_dir(&dir)
            .map_err(|e| format!("read drafts dir {}: {e}", dir.display()))?;
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if !meta.is_file() {
                continue;
            }
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let stem = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            if exclude_card_ids.iter().any(|c| c == &stem) {
                continue;
            }
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            if mtime_ms < cutoff_ms {
                continue;
            }
            out.push(path);
        }
        Ok(out)
    }

    /// v1.20.3: like `read_draft`, but when the canonical path is missing
    /// it scans the workspace's drafts directory for a stray that's
    /// plausibly the agent's output (likely a card_id hallucination).
    ///
    /// Returns `(proposal, recovered_path)`:
    /// - `recovered_path = None` means the canonical path was used.
    /// - `recovered_path = Some(p)` means the caller should delete `p`
    ///   after a successful apply (otherwise stale strays accumulate).
    ///
    /// Policy:
    /// - 0 strays → `Ok(None)`.
    /// - 1 stray, parses OK → log a WARN, return it.
    /// - 1 stray, fails to parse → log WARN, return `Ok(None)` (caller
    ///   falls back to the standard "No draft proposal found" error;
    ///   bubbling a serde error here would be more confusing than helpful).
    /// - ≥2 strays → `Err` listing the basenames. Fail loud — silent
    ///   guessing is how the wrong card gets dispatched.
    pub fn read_draft_with_recovery(
        &self,
        workspace_id: &str,
        card_id: &str,
        session_started_at_ms: i64,
        exclude_card_ids: &[String],
    ) -> Result<Option<(IntakeProposal, Option<PathBuf>)>, String> {
        if let Some(p) = self.read_draft(workspace_id, card_id)? {
            return Ok(Some((p, None)));
        }
        let expected = self.draft_path(workspace_id, card_id);
        let strays = self.stray_drafts(workspace_id, session_started_at_ms, exclude_card_ids)?;
        match strays.len() {
            0 => Ok(None),
            1 => {
                let found = &strays[0];
                let bytes = match fs::read(found) {
                    Ok(b) => b,
                    Err(e) => {
                        log::warn!(
                            "intake recovery: stray draft {} unreadable: {e}",
                            found.display()
                        );
                        return Ok(None);
                    }
                };
                match serde_json::from_slice::<IntakeProposal>(&bytes) {
                    Ok(prop) => {
                        log::warn!(
                            "intake_apply: draft path mismatch — expected {} but recovered {} (likely card_id hallucination)",
                            expected.display(),
                            found.display(),
                        );
                        Ok(Some((prop, Some(found.clone()))))
                    }
                    Err(e) => {
                        log::warn!(
                            "intake recovery: stray draft {} failed to parse: {e}",
                            found.display()
                        );
                        Ok(None)
                    }
                }
            }
            _ => {
                let names: Vec<String> = strays
                    .iter()
                    .filter_map(|p| p.file_name().and_then(|n| n.to_str().map(String::from)))
                    .collect();
                Err(format!(
                    "multiple stray draft files in {}; refusing to guess: [{}]",
                    self.drafts_dir().join(workspace_id).display(),
                    names.join(", ")
                ))
            }
        }
    }

    /// Idempotent — missing draft is not an error.
    pub fn delete_draft(&self, workspace_id: &str, card_id: &str) -> Result<(), String> {
        let p = self.draft_path(workspace_id, card_id);
        if p.exists() {
            fs::remove_file(&p).map_err(|e| format!("remove draft: {e}"))?;
        }
        Ok(())
    }
}

/// Structure the intake agent must produce as a JSON file at the path
/// provided in its initial system prompt. Validated before being applied
/// to the card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakeProposal {
    pub dispatch_prompt: String,
    #[serde(default)]
    pub suggested_swarm_template_id: Option<String>,
}

impl IntakeProposal {
    /// Drop suggested template ids that don't exist in the supplied
    /// catalog. Returns the validated proposal. The dispatchPrompt is
    /// rejected when empty.
    pub fn validate(self, catalog_ids: &[String]) -> Result<Self, String> {
        if self.dispatch_prompt.trim().is_empty() {
            return Err("dispatchPrompt is empty in agent proposal".into());
        }
        let suggested = match self.suggested_swarm_template_id.as_deref() {
            None => None,
            Some(id) => {
                if catalog_ids.iter().any(|c| c == id) {
                    Some(id.to_string())
                } else {
                    log::warn!(
                        "intake: agent suggested unknown swarmTemplateId '{id}' — dropping"
                    );
                    None
                }
            }
        };
        Ok(IntakeProposal {
            dispatch_prompt: self.dispatch_prompt,
            suggested_swarm_template_id: suggested,
        })
    }
}

/// Compose the full system-prompt text by appending the catalog of
/// available swarm templates and the absolute path the agent must use for
/// its proposal write. The resulting string is the value passed to
/// `claude --append-system-prompt`.
///
/// Catalog injection makes the recommendation step sharp:
/// user-defined templates become first-class targets without us having to
/// hardcode them.
pub fn assemble_system_prompt(
    base: &str,
    catalog: &[SwarmTemplate],
    draft_path: &Path,
) -> String {
    let mut catalog_block = String::from(
        "\n\n## Available swarm templates\n\nWhen recommending a `suggestedSwarmTemplateId`, pick from this list (or omit / null when no template fits):\n\n",
    );
    for t in catalog {
        catalog_block.push_str(&format!("- `{}` ({}): {}\n", t.id, t.label, t.description));
    }

    let path_block = format!(
        "\n\n## Conclude protocol\n\nWhen the user sends the literal string `{sentinel}` (the \"{button}\" button does this), STOP asking questions and write a JSON file with this exact shape:\n\n```json\n{{\n  \"dispatchPrompt\": \"<the finalized prompt that should drive the dispatched run, in plain text>\",\n  \"suggestedSwarmTemplateId\": \"<one id from the catalog above, or null>\"\n}}\n```\n\nWrite that JSON to this absolute path:\n\n    {draft_path}\n\nUse your standard Write tool. The parent directory is **already created** by Atelier — go straight to the Write call, do NOT run `mkdir` or any other shell command first (that would trigger an extra permission prompt for no reason). After writing, confirm in chat that you've concluded, then exit.\n",
        sentinel = CONCLUDE_SENTINEL.trim(),
        button = FINISH_PLANNING_LABEL,
        draft_path = draft_path.display(),
    );

    format!("{}{}{}", name_the_button(base).trim_end(), catalog_block, path_block)
}

// ── OB-14 (§13.3): intake with Codex ─────────────────────────────────

/// Who runs an intake: `preferred` (the card's Builder vendor, else the
/// Settings one) when it is ready, else the other; an error in words when
/// neither is.
pub fn intake_vendor(
    preferred: &str,
    claude_ready: bool,
    codex_ready: bool,
) -> Result<&'static str, String> {
    let (first, first_ready, second, second_ready) = if preferred == "codex" {
        ("codex", codex_ready, "claude", claude_ready)
    } else {
        ("claude", claude_ready, "codex", codex_ready)
    };
    if first_ready {
        Ok(first)
    } else if second_ready {
        Ok(second)
    } else {
        Err(format!(
            "No AI tool is ready on {}, so the card can't be planned. Install Claude Code or Codex (Settings › Setup and account › Diagnostics), then plan it again.",
            crate::platform::THIS_MACHINE
        ))
    }
}

/// The marker a Codex intake's first prompt carries, so its session rollout
/// is found among every Codex session on the machine.
/// How [`codex_intake_marker`] starts: also how Resume… knows a Codex
/// conversation is an intake ([`opens_an_intake`]).
const CODEX_INTAKE_MARKER: &str = "Plyloft intake session: ";

/// How much of a rollout's head [`rollout_is_intake`] reads: the intake's
/// first prompt follows the session record and Codex's own context.
const INTAKE_HEAD_BYTES: u64 = 1024 * 1024;

/// Compare, review round 2: a Codex rollout that is one of Plyloft's own
/// card intakes (a Codex TUI in the project folder, `source: cli`), never a
/// Terminals tile's conversation — a user message in its head carries the
/// intake marker. Round 3: only a user message, so a tile whose turn reads
/// `intake.rs` (a tool's output holding the marker's words) stays a tile's.
pub(crate) fn rollout_is_intake(path: &Path) -> bool {
    use std::io::Read;
    let Ok(file) = fs::File::open(path) else { return false };
    let mut head = Vec::new();
    if file.take(INTAKE_HEAD_BYTES).read_to_end(&mut head).is_err() {
        return false;
    }
    String::from_utf8_lossy(&head).lines().any(|line| {
        line.contains(CODEX_INTAKE_MARKER)
            && serde_json::from_str::<serde_json::Value>(line.trim())
                .ok()
                .and_then(|v| user_turn_text(v.get("payload")))
                .is_some_and(|text| text.contains(CODEX_INTAKE_MARKER))
    })
}

pub fn codex_intake_marker(intake_id: &str) -> String {
    format!("{CODEX_INTAKE_MARKER}{intake_id}")
}

/// The Codex intake's instructions: the same built-in prompt and catalog as
/// Claude's, with the conclude protocol that fits a read-only session — the
/// proposal is the last fenced `json` block of the final message, never a
/// file (MEASUREMENTS §6, candidate (c)).
pub fn assemble_codex_system_prompt(base: &str, catalog: &[SwarmTemplate], intake_id: &str) -> String {
    let mut catalog_block = String::from(
        "\n\n## Available swarm templates\n\nWhen recommending a `suggestedSwarmTemplateId`, pick from this list (or omit / null when no template fits):\n\n",
    );
    for t in catalog {
        catalog_block.push_str(&format!("- `{}` ({}): {}\n", t.id, t.label, t.description));
    }
    let protocol = format!(
        "\n\n## Conclude protocol (this session)\n\nThis conversation runs in Codex with a read-only sandbox: you cannot write any file, and you must not try. Wherever the instructions above say to write the JSON proposal to a file, do this instead. When the user sends the literal string `{sentinel}` (the \"{button}\" button does this), stop asking questions and reply with one final message that ends with a single fenced code block tagged `json`, holding exactly this shape:\n\n```json\n{{\n  \"dispatchPrompt\": \"<the finalized prompt that should drive the dispatched run, in plain text>\",\n  \"suggestedSwarmTemplateId\": \"<one id from the catalog above, or null>\"\n}}\n```\n\nPlyloft reads the proposal from that final message. Never write a `json` block before you see `{sentinel}`. After the block, stop; do not exit — Plyloft closes the session.\n\n{marker}\n",
        sentinel = CONCLUDE_SENTINEL,
        button = FINISH_PLANNING_LABEL,
        marker = codex_intake_marker(intake_id),
    );
    format!("{}{}{}", name_the_button(base).trim_end(), catalog_block, protocol)
}

/// The Codex TUI's first prompt: the instructions, then the card as the
/// user's first turn (Claude gets the same card as a typed priming message).
pub fn codex_first_prompt(system: &str, priming: &str) -> String {
    format!("{}\n\n---\n\n{}", system.trim_end(), priming)
}

/// The Codex intake's argv: the TUI (never `exec`, never `codex-chat`), in
/// the workspace, read-only and never asking — a command that would write
/// fails back to the model instead of offering to escalate. On Windows the
/// sandbox is `unelevated`, as for every read-only Codex run.
///
/// 1.168.1 (E1): `model` is the Builder row for Codex, resolved as the
/// Builder's is (card, else workspace, else app); blank parts pass no flag,
/// so the CLI's own default decides. `-m` / `-c model_reasoning_effort`
/// sit before the prompt, as the Builder's do.
pub fn codex_intake_args(
    prompt: &str,
    workspace_cwd: &str,
    windows: bool,
    model: &crate::settings::ModelChoice,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-C".into(),
        workspace_cwd.into(),
        "--sandbox".into(),
        "read-only".into(),
        "--ask-for-approval".into(),
        "never".into(),
        // OB-14 live check (codex-cli 0.156.1): with a newer release out, the
        // TUI opens on "Update available" (offering `curl … | sh`) and the
        // first prompt waits behind it. Plyloft offers updates itself (D6).
        // 1.176.1: every Codex PTY child gets it (`codex_update_prompt`);
        // kept here too, so the intake's argv reads as it runs.
        crate::codex_update_prompt::NO_UPDATE_PROMPT[0].into(),
        crate::codex_update_prompt::NO_UPDATE_PROMPT[1].into(),
    ];
    if windows {
        args.push("-c".into());
        args.push("windows.sandbox=unelevated".into());
    }
    if let Some(m) = model.model.as_deref() {
        args.push("-m".into());
        args.push(m.to_string());
    }
    if let Some(effort) = model.reasoning.as_deref() {
        args.push("-c".into());
        args.push(format!("model_reasoning_effort={effort}"));
    }
    args.push(prompt.to_string());
    args
}

/// 1.168.1 (E1): a Claude intake's argv — `--model` when the Builder row
/// for Claude names one (nothing otherwise: the CLI's own default), then
/// the system prompt. The theme (`claude_theme::session_args`) goes in
/// front afterwards.
pub fn claude_intake_args(full_prompt: String, model: &crate::settings::ModelChoice) -> Vec<String> {
    // 1.169.0 (A1): `--effort` beside `--model`, each when chosen.
    let mut args = model.claude_flags();
    args.push("--append-system-prompt".to_string());
    args.push(full_prompt);
    args
}

/// The last fenced ```json block of `text` that parses as a proposal.
pub fn last_json_proposal(text: &str) -> Option<IntakeProposal> {
    let mut found = None;
    let mut rest = text;
    while let Some(start) = rest.find("```json") {
        let after = &rest[start + "```json".len()..];
        // The first JSON value after the fence, read as JSON — a ``` inside
        // one of its strings does not end it (Challenger P2-2).
        let mut values = serde_json::Deserializer::from_str(after).into_iter::<IntakeProposal>();
        match values.next() {
            Some(Ok(p)) => {
                found = Some(p);
                rest = &after[values.byte_offset()..];
            }
            _ => rest = after,
        }
    }
    found
}

/// What a Codex intake's rollout says about the proposal.
#[derive(Debug, Clone, PartialEq)]
pub enum RolloutAnswer {
    /// Not concluded, or concluded and Codex has not finished its answer.
    Waiting,
    /// The answer to the sentinel, with its proposal.
    Proposal(IntakeProposal),
    /// Codex finished its answer to the sentinel, and it holds no proposal.
    NoProposal,
}

/// Said when Codex answered the conclude sentinel without a proposal.
pub const CODEX_NO_PROPOSAL: &str =
    "Couldn't parse the plan: Codex answered without a JSON proposal. Finish planning again, or cancel and plan again.";

/// Pure: the answer in a Codex session rollout (`rollout-*.jsonl`) — the
/// `task_complete` event's `last_agent_message` after the user sent the
/// conclude sentinel. None when the rollout is not this intake's (no
/// `marker`).
pub fn codex_answer_from_rollout(rollout: &str, marker: &str) -> Option<RolloutAnswer> {
    if !rollout.contains(marker) {
        return None;
    }
    let mut concluded = false;
    let mut answer = RolloutAnswer::Waiting;
    for line in rollout.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let payload = value.get("payload");
        let kind = payload.and_then(|p| p.get("type")).and_then(|t| t.as_str());
        match kind {
            Some("user_message") | Some("message") => {
                let Some(message) = user_turn_text(payload) else { continue };
                if message.trim() == CONCLUDE_SENTINEL {
                    concluded = true;
                    answer = RolloutAnswer::Waiting;
                }
            }
            Some("task_complete") if concluded => {
                answer = match payload
                    .and_then(|p| p.get("last_agent_message"))
                    .and_then(|m| m.as_str())
                    .and_then(last_json_proposal)
                {
                    Some(p) => RolloutAnswer::Proposal(p),
                    None => RolloutAnswer::NoProposal,
                };
            }
            _ => {}
        }
    }
    Some(answer)
}

/// A user turn's text in a rollout line's payload. The TUI (codex-cli
/// 0.156.1, measured live for OB-14) records it only as a `response_item`
/// `message` with `role: "user"` and `input_text` parts; `codex exec` and
/// other versions also write an `event_msg` `user_message`. Both are read.
fn user_turn_text(payload: Option<&serde_json::Value>) -> Option<String> {
    let payload = payload?;
    match payload.get("type")?.as_str()? {
        "user_message" => payload.get("message")?.as_str().map(str::to_string),
        "message" if payload.get("role")?.as_str()? == "user" => {
            let parts = payload.get("content")?.as_array()?;
            Some(
                parts
                    .iter()
                    .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("input_text"))
                    .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join(""),
            )
        }
        _ => None,
    }
}

/// The proposal alone ([`codex_answer_from_rollout`]).
pub fn codex_draft_from_rollout(rollout: &str, marker: &str) -> Option<IntakeProposal> {
    match codex_answer_from_rollout(rollout, marker)? {
        RolloutAnswer::Proposal(p) => Some(p),
        _ => None,
    }
}

/// Pure fallback: the proposal as the TUI drew it in the transcript, after
/// the last conclude sentinel. The TUI may draw the fence or not, and wraps
/// long lines, so the JSON object is looked for directly and read once as
/// drawn and once with the wraps joined.
pub fn codex_draft_from_transcript(transcript: &str) -> Option<IntakeProposal> {
    let text = crate::verify::strip_ansi(transcript);
    let after = &text[text.rfind(CONCLUDE_SENTINEL)? + CONCLUDE_SENTINEL.len()..];
    if let Some(p) = last_json_proposal(after) {
        return Some(p);
    }
    let key = after.rfind("\"dispatchPrompt\"")?;
    let open = after[..key].rfind('{')?;
    let candidate = &after[open..];
    let joined: String = candidate
        .lines()
        .map(str::trim)
        .collect::<Vec<_>>()
        .join(" ");
    for body in [candidate.to_string(), joined] {
        for (i, ch) in body.char_indices() {
            if ch == '}' {
                if let Ok(p) = serde_json::from_str::<IntakeProposal>(&body[..=i]) {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// Rollout files under `sessions/` touched since `since_ms`, newest day
/// first. Codex writes `sessions/YYYY/MM/DD/rollout-*.jsonl`; only the three
/// newest day directories are looked at.
fn recent_rollouts(sessions: &Path, since_ms: i64) -> Vec<PathBuf> {
    fn sorted_dirs(dir: &Path) -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = fs::read_dir(dir)
            .map(|entries| entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
            .unwrap_or_default();
        dirs.sort();
        dirs.reverse();
        dirs
    }
    let mut days = Vec::new();
    'outer: for year in sorted_dirs(sessions) {
        for month in sorted_dirs(&year) {
            for day in sorted_dirs(&month) {
                days.push(day);
                if days.len() >= 3 {
                    break 'outer;
                }
            }
        }
    }
    let cutoff = since_ms.saturating_sub(5_000);
    let mut files = Vec::new();
    for day in days {
        let Ok(entries) = fs::read_dir(&day) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            if !name.starts_with("rollout-") || !name.ends_with(".jsonl") {
                continue;
            }
            let modified = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            if modified >= cutoff {
                files.push(path);
            }
        }
    }
    files
}

/// The Codex homes whose `sessions/` an intake tile may have written to: the
/// member's own (an overlay links its `sessions` there), and any overlay
/// holding a real `sessions` directory of its own.
///
/// v1.154.1 round 3: a finished overlay's path is left as a link to the real
/// home (`codex_home::leave_tombstone`), so its `sessions` *is* the member's
/// — skipped, and every root is listed once by its canonical path, or each
/// poll would rescan the member's sessions once per finished session.
pub fn codex_session_roots(real_home: &Path, overlays_root: &Path) -> Vec<PathBuf> {
    let mut roots = vec![real_home.join("sessions")];
    let mut seen: Vec<PathBuf> = vec![fs::canonicalize(&roots[0]).unwrap_or_else(|_| roots[0].clone())];
    if let Ok(entries) = fs::read_dir(overlays_root) {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_symlink())
                || crate::codex_home::is_link_probe(&entry)
            {
                continue;
            }
            let sessions = entry.path().join("sessions");
            if sessions.symlink_metadata().map(|m| m.is_dir()).unwrap_or(false) {
                let canonical = fs::canonicalize(&sessions).unwrap_or_else(|_| sessions.clone());
                if !seen.contains(&canonical) {
                    seen.push(canonical);
                    roots.push(sessions);
                }
            }
        }
    }
    roots
}

/// The transcript is read only after the session has been this quiet, and
/// only when no rollout of this intake exists at all.
pub const TRANSCRIPT_FALLBACK_QUIET_MS: i64 = 3_000;

/// This intake's rollout: `known` (found on an earlier poll) when it still
/// reads, else a scan of the recent rollouts for the marker.
pub fn find_codex_rollout(
    session_roots: &[PathBuf],
    intake_id: &str,
    started_at: i64,
    known: Option<&Path>,
) -> Option<(PathBuf, String)> {
    if let Some(path) = known {
        if let Ok(text) = fs::read_to_string(path) {
            return Some((path.to_path_buf(), text));
        }
    }
    let marker = codex_intake_marker(intake_id);
    for root in session_roots {
        for path in recent_rollouts(root, started_at) {
            let Ok(text) = fs::read_to_string(&path) else { continue };
            if text.contains(&marker) {
                return Some((path, text));
            }
        }
    }
    None
}

/// A Codex intake's proposal. From its rollout whenever one exists — waiting
/// for the answer to the sentinel, never reading the transcript meanwhile
/// (Challenger P2-1: a tool call's output can show a `dispatchPrompt` long
/// before Codex answers). The transcript only when no rollout of this intake
/// exists at all and the session has been quiet for
/// [`TRANSCRIPT_FALLBACK_QUIET_MS`]. `Err` when Codex answered without a
/// proposal. Returns the rollout path so the next poll reads only it.
pub fn codex_draft(
    session_roots: &[PathBuf],
    intake_id: &str,
    started_at: i64,
    known_rollout: Option<&Path>,
    transcript: &[u8],
    quiet_ms: i64,
) -> (Result<Option<IntakeProposal>, String>, Option<PathBuf>) {
    let marker = codex_intake_marker(intake_id);
    if let Some((path, text)) = find_codex_rollout(session_roots, intake_id, started_at, known_rollout) {
        let answer = match codex_answer_from_rollout(&text, &marker) {
            Some(RolloutAnswer::Proposal(p)) => Ok(Some(p)),
            Some(RolloutAnswer::NoProposal) => Err(CODEX_NO_PROPOSAL.to_string()),
            _ => Ok(None),
        };
        return (answer, Some(path));
    }
    if quiet_ms < TRANSCRIPT_FALLBACK_QUIET_MS {
        return (Ok(None), None);
    }
    (Ok(codex_draft_from_transcript(&String::from_utf8_lossy(transcript))), None)
}

impl IntakeStore {
    /// OB-14: a Codex intake answers in its final message; once it has, the
    /// proposal is written to the card's draft path (tempfile + rename), so
    /// reading, validating and applying it are the same as for Claude.
    /// Returns whether a draft is now there.
    pub fn materialize_codex_draft(
        &self,
        session: &IntakeSession,
        session_roots: &[PathBuf],
    ) -> Result<bool, String> {
        if session.vendor != "codex" {
            return Ok(false);
        }
        if session.draft_path.exists() {
            return Ok(true);
        }
        let transcript = session.transcript_buf.lock().clone();
        let known = session.rollout_path.lock().clone();
        let quiet_ms = now_millis() - session.last_activity_at.load(Ordering::Relaxed);
        let (answer, rollout) = codex_draft(
            session_roots,
            &session.intake_id,
            session.started_at,
            known.as_deref(),
            &transcript,
            quiet_ms,
        );
        // P3-4: found once, read alone on every later poll.
        if rollout.is_some() && known != rollout {
            *session.rollout_path.lock() = rollout;
        }
        let Some(proposal) = answer? else {
            return Ok(false);
        };
        crate::atomic::write_atomic_json(&session.draft_path, &proposal)?;
        Ok(true)
    }
}

// ── v1.7.4: workspace-context enrichment for the priming message ─────

/// Pre-fetched workspace context attached to the intake priming. Empty
/// blocks (no git repo, no recent runs) are omitted from the rendered
/// message so the prompt stays lean.
///
/// v1.7.5: dropped the "Other cards in flight" block. Calibration on the
/// first multi-card workspace showed it was noise — listing unrelated
/// todos in every intake didn't help the agent and bled scope between
/// cards. The user wants one card at a time.
#[derive(Debug, Default, Clone)]
pub(crate) struct PrimingContext {
    pub git: Option<GitContext>,
    pub recent_runs: Vec<RunHistorySnapshot>,
}

impl PrimingContext {
    pub fn empty() -> Self {
        Self::default()
    }
}

#[derive(Debug, Clone)]
pub(crate) struct GitContext {
    pub branch: String,
    pub dirty_files: Vec<String>,
    pub recent_commits: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct RunHistorySnapshot {
    pub card_title: String,
    pub ended_at: i64,
    pub files_changed_count: u32,
    /// Already capped at the entry level (`MAX_TOP_PATHS = 10` in
    /// `kanban.rs`); we display only the first 3 for noise control.
    pub top_paths: Vec<String>,
}

const RECENT_RUNS_LIMIT: usize = 5;
const RECENT_RUNS_PATHS_DISPLAY: usize = 3;
const GIT_LOG_LIMIT: usize = 10;
const GIT_DIRTY_LIMIT: usize = 20;

/// Shell out to `git -C <cwd>` to gather branch + dirty files + recent
/// commits. **Best-effort**: any error (non-repo, missing git binary,
/// shell-out non-zero) returns `None` and the git block is omitted from
/// the priming. **No timeout in v1.7.4** — accepted risk per the plan.
pub(crate) fn gather_git_context(cwd: &Path) -> Option<GitContext> {
    let branch = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string();
    if branch.is_empty() {
        return None;
    }
    let status = run_git(cwd, &["status", "-s"]).unwrap_or_default();
    let dirty_files: Vec<String> = status
        .lines()
        .filter(|l| !l.trim().is_empty())
        .take(GIT_DIRTY_LIMIT)
        .map(|l| l.to_string())
        .collect();
    let log = run_git(
        cwd,
        &["log", "--oneline", &format!("-{GIT_LOG_LIMIT}")],
    )
    .unwrap_or_default();
    let recent_commits: Vec<String> = log
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.to_string())
        .collect();
    Some(GitContext {
        branch,
        dirty_files,
        recent_commits,
    })
}

fn run_git(cwd: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = crate::platform::git_command();
    cmd.arg("-C").arg(cwd);
    for a in args {
        cmd.arg(a);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout).ok()
}

/// Pull the most recent N run-history receipts across all cards in the
/// workspace, sorted by `ended_at` desc. Top-paths display is capped to
/// the first 3 per entry.
pub(crate) fn gather_recent_run_history(
    workspace_id: &str,
    store: &KanbanStore,
    limit: usize,
) -> Vec<RunHistorySnapshot> {
    let cards = match store.load(workspace_id) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let mut snaps: Vec<RunHistorySnapshot> = Vec::new();
    for card in &cards {
        for entry in &card.run_history {
            let mut paths = entry.top_paths.clone();
            paths.truncate(RECENT_RUNS_PATHS_DISPLAY);
            snaps.push(RunHistorySnapshot {
                card_title: card.title.clone(),
                ended_at: entry.ended_at,
                files_changed_count: entry.files_changed_count,
                top_paths: paths,
            });
        }
    }
    snaps.sort_by(|a, b| b.ended_at.cmp(&a.ended_at));
    snaps.truncate(limit);
    snaps
}

// ── format helpers (v1.7.4) ─────────────────────────────────────────

pub(crate) fn format_git_block(g: &GitContext) -> String {
    let mut s = String::from("Workspace git state:\n");
    s.push_str(&format!("- Branch: {}\n", g.branch));
    if g.dirty_files.is_empty() {
        s.push_str("- Dirty files: none (working tree clean)\n");
    } else {
        s.push_str(&format!("- Dirty files: {}\n", g.dirty_files.len()));
        for line in &g.dirty_files {
            s.push_str(&format!("  {line}\n"));
        }
    }
    if !g.recent_commits.is_empty() {
        s.push_str("- Recent commits:\n");
        for line in &g.recent_commits {
            s.push_str(&format!("  {line}\n"));
        }
    }
    s.trim_end().to_string()
}

pub(crate) fn format_recent_runs_block(
    runs: &[RunHistorySnapshot],
    now_ms: i64,
) -> String {
    let mut s = format!(
        "Recent kanban activity (last {} receipts across the board):\n",
        runs.len()
    );
    for r in runs {
        let when = format_relative_time(r.ended_at, now_ms);
        let paths_part = if r.top_paths.is_empty() {
            String::new()
        } else {
            format!(": {}", r.top_paths.join(", "))
        };
        let plural = if r.files_changed_count == 1 { "file" } else { "files" };
        s.push_str(&format!(
            "- {when}: \"{}\" — {} {plural}{paths_part}\n",
            r.card_title, r.files_changed_count
        ));
    }
    s.trim_end().to_string()
}

pub(crate) fn format_relative_time(then_ms: i64, now_ms: i64) -> String {
    let delta_ms = (now_ms - then_ms).max(0);
    let secs = delta_ms / 1000;
    if secs < 60 {
        return "just now".to_string();
    }
    let mins = secs / 60;
    if mins < 60 {
        return format!("{mins}m ago");
    }
    let hours = mins / 60;
    if hours < 24 {
        return format!("{hours}h ago");
    }
    let days = hours / 24;
    format!("{days}d ago")
}

// ── existing priming helpers ────────────────────────────────────────

/// How an intake's priming message starts (the card's title follows).
const PRIMING_OPENS: &str = "Card title: ";

/// Terminals block P4: a conversation whose first message is an intake's —
/// Claude's priming message, or Codex's first prompt, which carries the
/// session's marker ([`codex_intake_marker`]) — is a card's, not one the
/// member opened in Terminals: Resume… leaves it out. Both are Plyloft's own
/// constants, not the prompt's wording.
pub(crate) fn opens_an_intake(first_message: &str) -> bool {
    first_message.trim_start().starts_with(PRIMING_OPENS) || first_message.contains(CODEX_INTAKE_MARKER)
}

/// Build the priming message that gets piped into the intake PTY as the
/// "first user turn" once claude is ready. claude REPL doesn't auto-emit
/// from a system prompt alone — without this message the user lands in
/// front of a blank claude prompt and has no idea the intake protocol is
/// waiting on them. This message hands the agent the card content and
/// tells it to proceed.
pub(crate) fn build_priming_message(
    title: &str,
    notes: Option<&str>,
    knowledge: Option<&str>,
    attachments: &[CardAttachment],
    ctx: &PrimingContext,
    now_ms: i64,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    parts.push(format!("{PRIMING_OPENS}{}", title.trim()));
    if let Some(n) = notes.map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(format!("Notes:\n{n}"));
    }
    if let Some(k) = knowledge.map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(format!("Knowledge / context:\n{k}"));
    }
    if !attachments.is_empty() {
        let lines: Vec<String> = attachments
            .iter()
            .map(|a| format!("- {}", a.stored_path))
            .collect();
        parts.push(format!("Attached files:\n{}", lines.join("\n")));
    }
    // v1.7.4: workspace context blocks. Each is omitted entirely when
    // empty so the prompt stays lean for trivial workspaces (no git, no
    // history, no parallel work).
    if let Some(g) = &ctx.git {
        parts.push(format_git_block(g));
    }
    if !ctx.recent_runs.is_empty() {
        parts.push(format_recent_runs_block(&ctx.recent_runs, now_ms));
    }
    parts.push(String::from(
        "Please proceed with intake: read the card content above, inspect the codebase read-only to ground the discussion, and then ask me whatever's needed to nail down scope and approach. Remember the always-ask-never-guess invariant.",
    ));
    // v1.7.3: NO trailing terminator. The submit keystroke (`\r`) is
    // delivered as a separate PTY write after `PRIMING_SUBMIT_DELAY_MS`
    // because claude REPL treats CR/LF inside a multi-line body as more
    // line breaks rather than submit. See `start_intake` for the two-
    // write sequence.
    parts.join("\n\n")
}

/// Spawn the intake PTY for a card. Builds the assembled system prompt,
/// invokes `claude --append-system-prompt <body>` in the workspace cwd via
/// `PtyRegistry::spawn`, registers an `IntakeSession`, then schedules a
/// detached thread that writes the priming message to the PTY after
/// `PRIMING_DELAY_MS`. Returns the pty_id so the frontend can attach an
/// xterm.
///
/// Errors propagate (PTY spawn failure, claude binary missing, card not
/// found, etc.) so the frontend can surface them in the Card panel.
pub fn start_intake(
    app: AppHandle,
    kanban_store: &KanbanStore,
    intake_store: &IntakeStore,
    intake_registry: &IntakeRegistry,
    pty_registry: &PtyRegistry,
    swarm_templates: &SwarmTemplatesStore,
    workspace_id: &str,
    card_id: &str,
    workspace_cwd: &str,
) -> Result<String, String> {
    if intake_registry.get(card_id).is_some() {
        return Err(format!(
            "intake already active for card {card_id} — conclude or cancel first"
        ));
    }
    let env = shell_env::get();

    // Look up the card synchronously so we error early if missing; the
    // user's title/notes/knowledge get cloned into the priming thread.
    // v1.7.4: priming construction itself (build + workspace-context
    // gather) moves to the detached thread so slow `git log` on a giant
    // repo doesn't block the intake_start IPC.
    let cards = kanban_store.load(workspace_id)?;
    let card = cards
        .iter()
        .find(|c| c.id == card_id)
        .ok_or_else(|| format!("card {card_id} not found in workspace {workspace_id}"))?;
    // 1.175.0 (B3): an issue card's text reaches the planner quoted as the
    // issue's text, its HTML comments shown and marked — its title too
    // (round 2): the priming's own title line names the issue by number.
    let priming_title = crate::issue_text::name_for_ai(card);
    let (priming_notes, priming_knowledge) = crate::issue_text::for_planner(card);
    let priming_attachments = card.attachments.clone();
    let card_models = card.models.clone();

    // OB-14 (§13.3): the card's Builder vendor when it is ready, else the
    // other one. Claude's intake is exactly what it always was.
    let preferred = card
        .builder_vendor_pref
        .map(|v| v.as_str().to_string())
        .or_else(|| {
            app.try_state::<crate::settings::SettingsStore>()
                .map(|s| s.snapshot().behavior.builder_vendor.as_str().to_string())
        })
        .unwrap_or_else(|| "claude".to_string());
    let vendor = intake_vendor(
        &preferred,
        crate::doctor::vendor_ready(&env, "claude"),
        crate::doctor::vendor_ready(&env, "codex"),
    )?;

    let catalog: Vec<SwarmTemplate> = swarm_templates
        .list_all()
        .unwrap_or_else(|e| {
            log::warn!("intake: list_all swarm templates failed ({e}); proceeding with empty catalog");
            Vec::new()
        });

    let draft_path = intake_store.draft_path(workspace_id, card_id);
    if let Some(parent) = draft_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create drafts subdir: {e}"))?;
    }
    // Stale drafts from a previous abandoned session would otherwise show
    // up immediately on the next read. Clear before spawn.
    let _ = intake_store.delete_draft(workspace_id, card_id);

    // v1.19.0 (Cycle E4): create the per-session UUID and transcript
    // buffer BEFORE spawn so `spawn_with_capture` can wire the reader
    // thread to tee bytes into the buffer.
    // v1.20.2: same pattern for `last_activity_at` — the reader thread
    // stamps it on every output byte; the idle sweeper reads it.
    let intake_id = uuid::Uuid::new_v4().to_string();

    // 1.168.1 (E1): planning runs on the model the card's Builder would use
    // for this vendor — the same resolution as the Builder's.
    let model = crate::settings::model_for_card(&app, workspace_id, card_models.as_ref(), vendor, crate::settings::AgentRole::Builder);

    let (binary, args, mcp_provider, coord_provider) = if vendor == "codex" {
        // OB-14 (§13.3, MEASUREMENTS §6 candidate (c)): the Codex TUI in a
        // PTY, read-only in the workspace (AGENTS.md loads, the tree stays
        // clean); the system prompt and the card go in as its first prompt,
        // and the proposal comes back in its final message.
        let codex_path = env
            .codex_path
            .clone()
            .ok_or_else(|| "Plyloft can't find the codex command in its program folders.".to_string())?;
        let system = assemble_codex_system_prompt(intake_store.system_prompt(), &catalog, &intake_id);
        let ctx = PrimingContext {
            git: gather_git_context(Path::new(workspace_cwd)),
            recent_runs: gather_recent_run_history(workspace_id, kanban_store, RECENT_RUNS_LIMIT),
        };
        let priming = build_priming_message(
            &priming_title,
            priming_notes.as_deref(),
            priming_knowledge.as_deref(),
            &priming_attachments,
            &ctx,
            now_millis(),
        );
        (
            codex_path,
            codex_intake_args(&codex_first_prompt(&system, &priming), workspace_cwd, cfg!(windows), &model),
            crate::mcp_launch::Provider::Codex,
            crate::coordination::Provider::Codex,
        )
    } else {
        let claude_path = env
            .claude_path
            .clone()
            .ok_or_else(|| "Plyloft can't find the claude command in its program folders.".to_string())?;
        // GH #214: the built-in prompt; no on-disk override is read.
        let full_prompt = assemble_system_prompt(intake_store.system_prompt(), &catalog, &draft_path);

        let args = claude_intake_args(full_prompt, &model);
        // GH #69: the intake conversation draws for Ply's effective theme.
        let args = crate::claude_theme::session_args(&app, args);
        (
            claude_path,
            args,
            crate::mcp_launch::Provider::Claude,
            crate::coordination::Provider::Claude,
        )
    };

    // Clone the AppHandle BEFORE the spawn moves it; we need it to fetch
    // PtyRegistry from inside the priming-write thread.
    let app_for_priming = app.clone();
    let transcript_buf: Arc<parking_lot::Mutex<Vec<u8>>> =
        Arc::new(parking_lot::Mutex::new(Vec::new()));
    let started_at = now_millis();
    let last_activity_at: Arc<AtomicI64> = Arc::new(AtomicI64::new(started_at));
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
            Some(workspace_cwd.to_string()),
            Some(knowledge_mcp),
            crate::coordination::SpawnIntent {
                provider: coord_provider,
                execution_kind: crate::coordination::ExecutionKind::Intake,
                attendance: crate::coordination::Attendance::HumanAttended,
                write_intent: crate::coordination::WriteIntent::Unknown,
                enforcement: crate::coordination::Enforcement::Advisory,
                project: crate::coordination::SpawnProject::Project {
                    workspace_id: workspace_id.to_string(),
                    cwd: workspace_cwd.into(),
                },
                capability: None,
                card_id: Some(card_id.to_string()),
                swarm_id: None,
                role_id: None,
                run_id: None,
                retention_class: crate::coordination::RetentionClass::Interactive,
                objective: None,
            },
            120,
            32,
            Some(transcript_buf.clone()),
            Some(last_activity_at.clone()),
        )
        .map_err(|e| format!("intake pty spawn failed: {e}"))?;

    let transcript_for_priming = transcript_buf.clone();
    // Challenger P2: the backend learns of the intake's exit itself, so an
    // intake that ended at the trust question ("No, exit") neither asks nor
    // gets typed into. The listener goes once it has seen this PTY's exit.
    let exited: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
    let exited_for_priming = exited.clone();
    {
        let exited = exited.clone();
        let target = pty_id.clone();
        let app_for_unlisten = app_for_priming.clone();
        let slot: Arc<parking_lot::Mutex<Option<tauri::EventId>>> = Arc::new(parking_lot::Mutex::new(None));
        let slot_in = slot.clone();
        let id = app_for_priming.listen("pty://exit", move |event| {
            let Ok(payload) = serde_json::from_str::<crate::pty::PtyExitEvent>(event.payload()) else {
                return;
            };
            if payload.id != target {
                return;
            }
            exited.store(true, Ordering::Relaxed);
            if let Some(id) = slot_in.lock().take() {
                app_for_unlisten.unlisten(id);
            }
        });
        *slot.lock() = Some(id);
        // An exit that landed between the listen and the slot write.
        if exited_for_priming.load(Ordering::Relaxed) {
            if let Some(id) = slot.lock().take() {
                app_for_priming.unlisten(id);
            }
        }
    }
    intake_registry.insert(IntakeSession {
        pty_id: pty_id.clone(),
        workspace_id: workspace_id.to_string(),
        card_id: card_id.to_string(),
        draft_path,
        started_at,
        last_activity_at,
        intake_id,
        transcript_buf,
        vendor: vendor.to_string(),
        rollout_path: Arc::new(parking_lot::Mutex::new(None)),
        exited,
    });

    // OB-14: Codex was primed through its first prompt; nothing to type.
    if vendor == "codex" {
        return Ok(pty_id);
    }

    // v1.7.1/v1.7.3/v1.7.4: prime the conversation in a detached thread.
    //
    // - IPC returns immediately so the FE can attach the xterm before the
    //   priming arrives.
    // - Workspace-context gather (git + recent_runs + other_cards) runs
    //   here, parallel with claude's startup banner, so a slow `git log`
    //   never blocks the IPC.
    // - Two-write submit: body first, then a standalone `\r` after a small
    //   gap. claude REPL treats CR-after-multiline as another in-input
    //   line break, so an isolated keystroke is what triggers Enter.
    // - All writes are best-effort; failure logs and moves on.
    let pty_id_for_priming = pty_id.clone();
    let card_id_for_priming = card_id.to_string();
    let workspace_id_for_priming = workspace_id.to_string();
    let workspace_cwd_for_priming = workspace_cwd.to_string();
    thread::spawn(move || {
        let started = Instant::now();

        // 1. Gather workspace context.
        let cwd_path = PathBuf::from(&workspace_cwd_for_priming);
        let git = gather_git_context(&cwd_path);
        let recent_runs = match app_for_priming.try_state::<KanbanStore>() {
            Some(store) => gather_recent_run_history(
                &workspace_id_for_priming,
                &store,
                RECENT_RUNS_LIMIT,
            ),
            None => {
                log::warn!("intake: KanbanStore state unavailable in priming thread");
                Vec::new()
            }
        };
        let ctx = PrimingContext { git, recent_runs };

        // 2. Build the priming message.
        let priming = build_priming_message(
            &priming_title,
            priming_notes.as_deref(),
            priming_knowledge.as_deref(),
            &priming_attachments,
            &ctx,
            now_millis(),
        );

        // 3. Sleep the remaining time to PRIMING_DELAY_MS (claude needs to
        //    finish its startup banner before its REPL accepts stdin).
        let elapsed = started.elapsed();
        let target = Duration::from_millis(PRIMING_DELAY_MS);
        if elapsed < target {
            thread::sleep(target - elapsed);
        }

        // 3b. N14 walk F10: wait until Claude's REPL is ready. While its
        //     folder-trust question is on screen nothing is typed — an Enter
        //     there picks "No, exit" — and the person answers it in the
        //     intake terminal. Stops if the intake ends meanwhile.
        let Some(intakes) = app_for_priming.try_state::<IntakeRegistry>() else {
            log::warn!("intake: IntakeRegistry state unavailable for priming wait");
            return;
        };
        let mut quiet_since = Instant::now();
        let mut seen_len = 0usize;
        let mut still_since = Instant::now();
        loop {
            if exited_for_priming.load(Ordering::Relaxed)
                || intakes.pty_id_for(&card_id_for_priming).as_deref() != Some(pty_id_for_priming.as_str())
            {
                return;
            }
            let len = transcript_for_priming.lock().len();
            if len != seen_len {
                seen_len = len;
                still_since = Instant::now();
            }
            let tail = transcript_tail(&transcript_for_priming);
            if crate::builder::trust_question_pending(&tail) {
                quiet_since = Instant::now();
            }
            if priming_may_write(&tail, quiet_since.elapsed(), still_since.elapsed()) {
                if !crate::builder::claude_repl_ready(&tail) {
                    log::warn!("intake: Claude's REPL never looked ready; typing the first prompt anyway");
                }
                break;
            }
            if started.elapsed() >= Duration::from_millis(PRIMING_GIVE_UP_MS) {
                log::warn!("intake: still at the trust question after an hour; not typing the first prompt");
                return;
            }
            thread::sleep(Duration::from_millis(PRIMING_POLL_MS));
        }
        thread::sleep(Duration::from_millis(PRIMING_SETTLE_MS));

        // 4. Two-write submit.
        let reg = match app_for_priming.try_state::<PtyRegistry>() {
            Some(r) => r,
            None => {
                log::warn!("intake: PtyRegistry state unavailable for priming write");
                return;
            }
        };
        if let Err(e) = reg.write(&pty_id_for_priming, priming.as_bytes()) {
            log::warn!("intake: priming body write failed for pty {pty_id_for_priming}: {e}");
            return;
        }
        thread::sleep(Duration::from_millis(PRIMING_SUBMIT_DELAY_MS));
        if let Err(e) = reg.write(&pty_id_for_priming, b"\r") {
            log::warn!("intake: priming submit write failed for pty {pty_id_for_priming}: {e}");
        }
    });

    Ok(pty_id)
}

/// Send the conclude sentinel to the PTY so the agent emits its proposal
/// JSON. The PTY stays alive until `intake_apply` or `intake_cancel` runs.
fn write_conclude_submission(
    body: &[u8],
    mut write: impl FnMut(&[u8]) -> Result<(), String>,
    wait_before_submit: impl FnOnce(),
) -> Result<(), String> {
    write(body).map_err(|e| format!("write conclude sentinel: {e}"))?;
    wait_before_submit();
    write(b"\r").map_err(|e| format!("write conclude submit: {e}"))
}

pub fn send_conclude_sentinel(
    app: &AppHandle,
    pty_registry: &PtyRegistry,
    intake_registry: &IntakeRegistry,
    card_id: &str,
) -> Result<(), String> {
    let session = intake_registry
        .get(card_id)
        .ok_or_else(|| format!("no active intake for card {card_id}"))?;
    let pty_id = session.pty_id.clone();
    if !submits_after_quiet(&session.vendor, cfg!(windows)) {
        return write_conclude_submission(
            CONCLUDE_SENTINEL.as_bytes(),
            |data| pty_registry.write(&pty_id, data),
            || thread::sleep(Duration::from_millis(PRIMING_SUBMIT_DELAY_MS)),
        );
    }
    // OB-14 (Windows port, PORT_STATUS): Codex under ConPTY reads the
    // sentinel as a paste burst and an Enter inside it as part of the paste.
    // The Enter goes on its own once the session has been quiet — on a
    // thread, so the IPC does not wait on the screen.
    pty_registry
        .write(&pty_id, CONCLUDE_SENTINEL.as_bytes())
        .map_err(|e| format!("write conclude sentinel: {e}"))?;
    let written_at = now_millis();
    let activity = session.last_activity_at.clone();
    let app = app.clone();
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_millis(SETTLE_POLL_MS));
            let now = now_millis();
            if settled_for_enter(now, written_at, activity.load(Ordering::Relaxed)) {
                break;
            }
        }
        if let Some(reg) = app.try_state::<PtyRegistry>() {
            if let Err(e) = reg.write(&pty_id, b"\r") {
                log::warn!("intake: conclude submit write failed for pty {pty_id}: {e}");
            }
        }
    });
    Ok(())
}

/// OB-14: the Enter is its own write after the session went quiet — only
/// Codex on Windows (`builderInject.ts::submitsSeparately`, the same rule).
pub fn submits_after_quiet(vendor: &str, windows: bool) -> bool {
    windows && vendor == "codex"
}

/// The same numbers as the Builder's paste (`builderInject.ts`): 500 ms of
/// no output, never sooner than 500 ms after the write, and by 30 s whatever
/// the screen does.
const SETTLE_QUIET_MS: i64 = 500;
const SETTLE_MIN_MS: i64 = 500;
const SETTLE_MAX_MS: i64 = 30_000;
const SETTLE_POLL_MS: u64 = 100;

/// Pure: is it time for the Enter? `last_activity` is the session's last
/// output (or keystroke) — our own write stamps it too.
pub fn settled_for_enter(now: i64, written_at: i64, last_activity: i64) -> bool {
    let since_write = now.saturating_sub(written_at);
    if since_write >= SETTLE_MAX_MS {
        return true;
    }
    since_write >= SETTLE_MIN_MS && now.saturating_sub(last_activity.max(written_at)) >= SETTLE_QUIET_MS
}

/// v1.20.3: emitted by the idle sweeper just before it cancels a swept
/// intake. The FE (`IntakeConversation` + `CardDetailPanel`) listens
/// for this so it can replace the generic "exited unexpectedly" red
/// banner with a softer "auto-cancelled after N minutes of inactivity"
/// message. Frontend filters by `pty_id` to ignore unrelated cards.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakeSweptEvent {
    pub pty_id: String,
    pub workspace_id: String,
    pub card_id: String,
    /// `IDLE_INTAKE_TIMEOUT_MS / 60_000` at sweep time so the FE can
    /// say "after N minutes" without hardcoding the number.
    pub idle_minutes: i64,
}

/// Kill the intake PTY, delete the draft (if any), and clear the registry
/// entry. Idempotent — calling twice is safe.
/// v1.17.0 (Cycle E.5): tick fired every `INTAKE_SWEEPER_TICK_SECS` from
/// the launch-time sweeper thread. Walks active intake sessions; for each
/// idle one (per `is_idle_for_cancel`), emits `intake://swept` then calls
/// `cancel_intake`. Reads the card's `intake_status` via `KanbanStore`
/// to skip Ready sessions (sentinel concluded but not yet applied).
///
/// v1.20.3: takes `&AppHandle` so it can emit `intake://swept` before
/// cancelling. The FE uses that signal to render a friendlier banner
/// instead of the generic "exited unexpectedly" error.
pub fn idle_sweeper_tick(
    app: &AppHandle,
    kanban_store: &crate::kanban::KanbanStore,
    intake_store: &IntakeStore,
    pty_registry: &PtyRegistry,
    intake_registry: &IntakeRegistry,
) {
    let active = intake_registry.list_active();
    if active.is_empty() {
        return;
    }
    let now_ms = now_millis();
    for session in active {
        // Resolve `is_ready` from the card's kanban state. Loading per-
        // workspace per-tick is cheap (kanban files are small JSON);
        // optimizing only if profiling demands it.
        let is_ready = match kanban_store.load(&session.workspace_id) {
            Ok(cards) => cards
                .iter()
                .find(|c| c.id == session.card_id)
                .map(|c| matches!(c.intake_status, crate::kanban::IntakeStatus::Ready))
                .unwrap_or(false),
            Err(e) => {
                log::warn!(
                    "intake idle sweeper: load kanban {} failed: {e}",
                    session.workspace_id
                );
                false
            }
        };
        let last_activity = session.last_activity_at.load(Ordering::Relaxed);
        if !is_idle_for_cancel(now_ms, last_activity, is_ready) {
            continue;
        }
        log::info!(
            "intake idle sweeper: cancelling idle intake card={} workspace={}",
            session.card_id,
            session.workspace_id
        );
        // v1.20.3: notify FE BEFORE cancel — once `cancel_intake` runs,
        // the PTY exit event fires and the FE's onUnexpectedExit would
        // race the swept-event handler. Emitting first lets the FE flip
        // `normalExit = true` before the exit event arrives.
        let _ = app.emit(
            "intake://swept",
            IntakeSweptEvent {
                pty_id: session.pty_id.clone(),
                workspace_id: session.workspace_id.clone(),
                card_id: session.card_id.clone(),
                idle_minutes: IDLE_INTAKE_TIMEOUT_MS / 60_000,
            },
        );
        if let Err(e) = cancel_intake(
            intake_store,
            pty_registry,
            intake_registry,
            &session.workspace_id,
            &session.card_id,
        ) {
            log::warn!(
                "intake idle sweeper: cancel_intake failed for card {}: {e}",
                session.card_id
            );
        }
    }
}

/// v1.17.0 (Cycle E.5): how often the idle-intake sweeper runs. 60s is
/// fine-grained enough to cap stale PTYs near `IDLE_INTAKE_TIMEOUT_MS`
/// without putting meaningful load on the kanban-load path.
pub const INTAKE_SWEEPER_TICK_SECS: u64 = 60;

pub fn cancel_intake(
    intake_store: &IntakeStore,
    pty_registry: &PtyRegistry,
    intake_registry: &IntakeRegistry,
    workspace_id: &str,
    card_id: &str,
) -> Result<(), String> {
    // v1.20.3: snapshot session start BEFORE removing it so we can
    // scope the stray sweep to "files written after this session
    // started." Without this, a cancel that runs without an active
    // session entry (already-removed paranoia case) can't safely
    // distinguish strays from prior intakes' files.
    let started_at = intake_registry.get(card_id).map(|s| s.started_at);

    if let Some(session) = intake_registry.remove(card_id) {
        let _ = pty_registry.kill(&session.pty_id);
    }
    intake_store.delete_draft(workspace_id, card_id)?;

    // v1.20.3: defensive stray cleanup. If the agent hallucinated a
    // card_id path before the user cancelled, the wrong-named file
    // would otherwise accumulate forever AND collide with the next
    // intake's recovery scan. Exclude any other active card's
    // canonical filename so we never touch a concurrent intake's draft.
    if let Some(started) = started_at {
        let exclude: Vec<String> = intake_registry
            .list_active()
            .into_iter()
            .filter(|s| s.workspace_id == workspace_id)
            .map(|s| s.card_id)
            .collect();
        if let Ok(strays) = intake_store.stray_drafts(workspace_id, started, &exclude) {
            for path in strays {
                if let Err(e) = fs::remove_file(&path) {
                    log::warn!(
                        "intake cancel: remove stray {} failed: {e}",
                        path.display()
                    );
                }
            }
        }
    }
    Ok(())
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    // ── OB-14 (§13.3): intake with Codex ─────────────────────────────

    /// Tier 4 helper (never in the suite): writes the Codex intake argv for
    /// a trivial card to `$PLY_OB14_ARGV` as JSON, so a live check launches
    /// Codex exactly as `start_intake` does. `$PLY_OB14_CWD` is the repo.
    #[test]
    #[ignore]
    fn dump_codex_intake_argv_for_a_live_check() {
        let out = std::env::var("PLY_OB14_ARGV").expect("PLY_OB14_ARGV");
        let cwd = std::env::var("PLY_OB14_CWD").expect("PLY_OB14_CWD");
        let id = std::env::var("PLY_OB14_ID").unwrap_or_else(|_| "live-check".into());
        let system = assemble_codex_system_prompt(
            DEFAULT_SYSTEM_PROMPT,
            &crate::swarm_templates::builtin_templates(),
            &id,
        );
        let priming = build_priming_message(
            "Add a one-line README",
            Some("The repo has no README. Add README.md with the project name. Nothing else."),
            None,
            &[],
            &PrimingContext::empty(),
            now_millis(),
        );
        let args = codex_intake_args(&codex_first_prompt(&system, &priming), &cwd, cfg!(windows), &crate::settings::ModelChoice::default());
        fs::write(out, serde_json::to_string(&args).unwrap()).unwrap();
    }

    #[test]
    fn intake_runs_with_the_builder_vendor_when_ready_else_the_other() {
        assert_eq!(intake_vendor("claude", true, true), Ok("claude"));
        assert_eq!(intake_vendor("codex", true, true), Ok("codex"));
        // Claude-only machine: always Claude, whatever the preference.
        assert_eq!(intake_vendor("codex", true, false), Ok("claude"));
        assert_eq!(intake_vendor("claude", true, false), Ok("claude"));
        // Codex-only machine.
        assert_eq!(intake_vendor("claude", false, true), Ok("codex"));
        let none = intake_vendor("claude", false, false).unwrap_err();
        assert!(none.contains("No AI tool is ready") && none.contains("Claude Code or Codex"), "{none}");
    }

    #[test]
    fn codex_intake_argv_is_the_tui_read_only_in_the_workspace() {
        let none = crate::settings::ModelChoice::default();
        let mac = codex_intake_args("PROMPT", "/w", false, &none);
        assert_eq!(
            mac,
            vec![
                "-C", "/w", "--sandbox", "read-only", "--ask-for-approval", "never",
                "-c", "check_for_update_on_startup=false", "PROMPT"
            ]
        );
        assert!(!mac.iter().any(|a| a == "exec" || a == "workspace-write" || a == "--add-dir"));
        // Plyloft never trusts a folder on the person's behalf.
        assert!(!mac.iter().any(|a| a.contains("trust")));
        let win = codex_intake_args("PROMPT", r"C:\w", true, &none);
        assert_eq!(&win[8..10], ["-c", "windows.sandbox=unelevated"]);
        assert_eq!(win.last().unwrap(), "PROMPT");
    }

    /// 1.168.1 (E1): an intake runs on the Builder's model for its vendor —
    /// before, neither vendor's intake passed one. Blank passes nothing.
    #[test]
    fn intake_argv_carries_the_builder_model() {
        let codex = crate::settings::ModelChoice { model: Some("gpt-6-astra".into()), reasoning: Some("high".into()) };
        let args = codex_intake_args("PROMPT", "/w", false, &codex);
        let m = args.iter().position(|a| a == "-m").expect("-m");
        assert_eq!(args[m + 1], "gpt-6-astra");
        assert!(args.windows(2).any(|w| w[0] == "-c" && w[1] == "model_reasoning_effort=high"));
        assert_eq!(args.last().unwrap(), "PROMPT", "the prompt stays last");
        let win = codex_intake_args("PROMPT", r"C:\w", true, &codex);
        assert!(win.iter().any(|a| a == "windows.sandbox=unelevated") && win.iter().any(|a| a == "-m"));
        assert_eq!(win.last().unwrap(), "PROMPT");

        let none = crate::settings::ModelChoice::default();
        assert!(!codex_intake_args("PROMPT", "/w", false, &none).iter().any(|a| a == "-m" || a.starts_with("model_reasoning")));

        let claude = crate::settings::ModelChoice { model: Some("opus".into()), reasoning: None };
        assert_eq!(
            claude_intake_args("SYS".into(), &claude),
            vec!["--model", "opus", "--append-system-prompt", "SYS"]
        );
        assert_eq!(claude_intake_args("SYS".into(), &none), vec!["--append-system-prompt", "SYS"]);
        // 1.169.0 (A1): Plan it passes Claude's effort beside the model.
        let effort = crate::settings::ModelChoice { model: Some("opus".into()), reasoning: Some("xhigh".into()) };
        assert_eq!(
            claude_intake_args("SYS".into(), &effort),
            vec!["--model", "opus", "--effort", "xhigh", "--append-system-prompt", "SYS"]
        );
        // The theme composes in front of the model.
        let themed = crate::claude_theme::apply(claude_intake_args("SYS".into(), &claude), Some("auto"));
        assert_eq!(&themed[0..1], &["--settings".to_string()]);
        assert_eq!(&themed[2..4], &["--model".to_string(), "opus".to_string()]);
    }

    #[test]
    fn codex_intake_prompt_asks_for_the_json_in_the_final_message_not_a_file() {
        let catalog = vec![SwarmTemplate {
            id: "feature".into(),
            label: "Feature".into(),
            description: "Plan, build, review".into(),
            ..crate::swarm_templates::builtin_templates().into_iter().next().unwrap()
        }];
        let p = assemble_codex_system_prompt(DEFAULT_SYSTEM_PROMPT, &catalog, "int-42");
        assert!(p.starts_with(name_the_button(DEFAULT_SYSTEM_PROMPT).trim_end()), "the built-in prompt, unchanged");
        assert!(p.contains("- `feature` (Feature): Plan, build, review"));
        assert!(p.contains("read-only sandbox"));
        assert!(p.contains("single fenced code block tagged `json`"));
        assert!(p.contains(&codex_intake_marker("int-42")));
        assert!(!p.contains("Use your standard Write tool"), "no file protocol for Codex");
        let first = codex_first_prompt(&p, "Card title: X");
        assert!(first.ends_with("---\n\nCard title: X"));
    }

    #[test]
    fn both_intake_prompts_name_the_real_finish_button() {
        // 1.168.1 B1: Claude told the user to "click Conclude intake"; the
        // button is "Finish planning".
        let claude = assemble_system_prompt(DEFAULT_SYSTEM_PROMPT, &[], Path::new("/d/c.json"));
        let codex = assemble_codex_system_prompt(DEFAULT_SYSTEM_PROMPT, &[], "int-1");
        for p in [&claude, &codex] {
            assert!(p.contains(&format!("\"{FINISH_PLANNING_LABEL}\" button")));
            assert!(p.contains(&format!("click {FINISH_PLANNING_LABEL} when you want")));
            for stale in ["Conclude intake", "Confirm intake", "clicking Conclude", "{{FINISH_PLANNING}}"] {
                assert!(!p.contains(stale), "{stale}");
            }
        }
    }

    #[test]
    fn claude_intake_prompt_is_unchanged_by_ob14() {
        // Claude's system prompt still names the draft path and the Write tool.
        let p = assemble_system_prompt(DEFAULT_SYSTEM_PROMPT, &[], Path::new("/d/c.json"));
        assert!(p.contains("/d/c.json") && p.contains("Use your standard Write tool"));
        assert!(!p.contains("Plyloft intake session"));
    }

    #[test]
    fn an_intake_s_opening_is_known_so_resume_leaves_it_out() {
        let ctx = PrimingContext { git: None, recent_runs: Vec::new() };
        assert!(opens_an_intake(&build_priming_message("Archive action", None, None, &[], &ctx, 0)));
        let codex = assemble_codex_system_prompt(DEFAULT_SYSTEM_PROMPT, &[], "int-1");
        assert!(opens_an_intake(&codex_first_prompt(&codex, "Card title: X")));
        // By Plyloft's own marker, whatever the prompt's first line says.
        assert!(opens_an_intake(&codex_first_prompt(&codex.replacen("# Intake agent", "# Renamed", 1), "x")));
        assert!(!opens_an_intake("fix the login on Safari"));
    }

    fn rollout(lines: &[serde_json::Value]) -> String {
        lines.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n")
    }

    fn user(message: &str) -> serde_json::Value {
        serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":message,"images":[]}})
    }

    fn done(last: &str) -> serde_json::Value {
        serde_json::json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"t","last_agent_message":last}})
    }

    const ANSWER: &str = "Concluded.\n\n```json\n{\"dispatchPrompt\":\"Build it\",\"suggestedSwarmTemplateId\":\"feature\"}\n```";

    #[test]
    fn rollout_draft_is_the_last_answer_after_the_sentinel() {
        let marker = codex_intake_marker("int-1");
        let text = rollout(&[
            serde_json::json!({"type":"session_meta","payload":{"cwd":"/w"}}),
            user(&format!("instructions mentioning {CONCLUDE_SENTINEL}\n{marker}")),
            done("Which area? ```json\n{\"dispatchPrompt\":\"too early\"}\n```"),
            user("the frontend"),
            done("Got it."),
            user(CONCLUDE_SENTINEL),
            done(ANSWER),
        ]);
        let p = codex_draft_from_rollout(&text, &marker).unwrap();
        assert_eq!(p.dispatch_prompt, "Build it");
        assert_eq!(p.suggested_swarm_template_id.as_deref(), Some("feature"));
    }

    #[test]
    fn rollout_without_the_sentinel_or_the_marker_has_no_draft() {
        let marker = codex_intake_marker("int-1");
        // A JSON block before the conclude press is not a proposal.
        let early = rollout(&[user(&marker), done(ANSWER)]);
        assert!(codex_draft_from_rollout(&early, &marker).is_none());
        // Someone else's Codex session.
        let other = rollout(&[user("hi"), user(CONCLUDE_SENTINEL), done(ANSWER)]);
        assert!(codex_draft_from_rollout(&other, &marker).is_none());
        // Concluded, not answered yet.
        let waiting = rollout(&[user(&marker), user(CONCLUDE_SENTINEL)]);
        assert!(codex_draft_from_rollout(&waiting, &marker).is_none());
    }

    #[test]
    fn transcript_fallback_reads_a_fenced_or_a_drawn_proposal() {
        let fenced = format!("\x1b[1m{CONCLUDE_SENTINEL}\x1b[0m\r\n{ANSWER}\r\n");
        assert_eq!(codex_draft_from_transcript(&fenced).unwrap().dispatch_prompt, "Build it");
        // The TUI drew it without the fence, wrapped mid-value.
        let drawn = format!(
            "{CONCLUDE_SENTINEL}\n  {{\n    \"dispatchPrompt\": \"Build the\n    thing\",\n    \"suggestedSwarmTemplateId\": null\n  }}\n"
        );
        assert_eq!(codex_draft_from_transcript(&drawn).unwrap().dispatch_prompt, "Build the thing");
        assert!(codex_draft_from_transcript("no sentinel {\"dispatchPrompt\":\"x\"}").is_none());
    }

    #[test]
    fn codex_draft_finds_this_intakes_rollout_among_recent_sessions() {
        let tmp = tempdir().unwrap();
        let home = tmp.path().join("codex-home");
        let day = home.join("sessions").join("2026").join("09").join("28");
        fs::create_dir_all(&day).unwrap();
        let marker = codex_intake_marker("int-7");
        fs::write(day.join("rollout-other.jsonl"), rollout(&[user("x"), user(CONCLUDE_SENTINEL), done(ANSWER)])).unwrap();
        fs::write(day.join("notes.txt"), "not a rollout").unwrap();
        fs::write(day.join("rollout-mine.jsonl"), rollout(&[user(&marker), user(CONCLUDE_SENTINEL), done(ANSWER)])).unwrap();
        let roots = codex_session_roots(&home, &tmp.path().join("no-overlays"));
        assert_eq!(roots, vec![home.join("sessions")]);
        let (answer, found) = codex_draft(&roots, "int-7", now_millis(), None, b"", 0);
        assert_eq!(answer.unwrap().unwrap().dispatch_prompt, "Build it");
        assert_eq!(found.as_deref(), Some(day.join("rollout-mine.jsonl").as_path()));
        // A session started after every rollout was last written: not it.
        let (answer, found) = codex_draft(&roots, "int-7", now_millis() + 60_000, None, b"", 0);
        assert!(answer.unwrap().is_none() && found.is_none());
        // Another intake id finds nothing.
        assert!(codex_draft(&roots, "int-8", 0, None, b"", 0).0.unwrap().is_none());
    }

    fn tui_user(text: &str) -> serde_json::Value {
        serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}})
    }

    /// OB-14 live check (codex-cli 0.156.1 TUI): user turns are recorded as
    /// `response_item` messages only — no `event_msg` `user_message` — and
    /// `item_completed` events also carry the sentinel's text.
    #[test]
    fn a_tui_rollout_records_user_turns_as_response_items() {
        let marker = codex_intake_marker("int-tui");
        let completed_item = serde_json::json!({"type":"event_msg","payload":{"type":"item_completed","item":{"text":CONCLUDE_SENTINEL}}});
        let text = rollout(&[
            tui_user(&format!("instructions naming {CONCLUDE_SENTINEL}\n{marker}")),
            done("Which name?"),
            tui_user(CONCLUDE_SENTINEL),
            completed_item,
            done(ANSWER),
        ]);
        assert_eq!(codex_draft_from_rollout(&text, &marker).unwrap().dispatch_prompt, "Build it");
        // An assistant message is not a user turn.
        let assistant = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":CONCLUDE_SENTINEL}]}});
        let not_concluded = rollout(&[tui_user(&marker), assistant, done(ANSWER)]);
        assert_eq!(codex_answer_from_rollout(&not_concluded, &marker), Some(RolloutAnswer::Waiting));
    }

    /// Tier 4 helper (never in the suite): parses a real rollout named by
    /// `$PLY_OB14_ROLLOUT` for the intake `$PLY_OB14_ID`.
    #[test]
    #[ignore]
    fn parse_a_live_rollout() {
        let path = std::env::var("PLY_OB14_ROLLOUT").expect("PLY_OB14_ROLLOUT");
        let id = std::env::var("PLY_OB14_ID").expect("PLY_OB14_ID");
        let text = fs::read_to_string(path).unwrap();
        let answer = codex_answer_from_rollout(&text, &codex_intake_marker(&id));
        println!("LIVE ANSWER: {answer:?}");
        assert!(matches!(answer, Some(RolloutAnswer::Proposal(_))));
    }

    /// v1.154.1 round 3: finished overlays' links to the real home are not
    /// extra roots, however many there are; a live overlay's own `sessions`
    /// directory still is, once.
    #[cfg(unix)]
    #[test]
    fn finished_overlay_links_add_no_session_roots() {
        let tmp = tempdir().unwrap();
        let home = tmp.path().join("home");
        fs::create_dir_all(home.join("sessions")).unwrap();
        let overlays = tmp.path().join("codex-home");
        fs::create_dir_all(&overlays).unwrap();
        for n in 0..5 {
            std::os::unix::fs::symlink(&home, overlays.join(format!("finished-{n}"))).unwrap();
        }
        let live = overlays.join("live");
        fs::create_dir_all(live.join("sessions")).unwrap();
        let linked = overlays.join("linked-live");
        fs::create_dir_all(&linked).unwrap();
        std::os::unix::fs::symlink(home.join("sessions"), linked.join("sessions")).unwrap();
        let roots = codex_session_roots(&home, &overlays);
        assert_eq!(roots, vec![home.join("sessions"), live.join("sessions")]);
    }

    /// Challenger P2-1: while this intake's rollout exists the transcript is
    /// never read — a `rg dispatchPrompt` in it is not the plan.
    #[test]
    fn an_unanswered_rollout_wins_over_a_transcript_showing_a_proposal() {
        let tmp = tempdir().unwrap();
        let home = tmp.path().join("codex-home");
        let day = home.join("sessions").join("2026").join("09").join("28");
        fs::create_dir_all(&day).unwrap();
        let marker = codex_intake_marker("int-3");
        fs::write(day.join("rollout-mine.jsonl"), rollout(&[user(&marker), user(CONCLUDE_SENTINEL)])).unwrap();
        let roots = codex_session_roots(&home, tmp.path());
        let transcript = format!(
            "{CONCLUDE_SENTINEL}\n$ rg dispatchPrompt\nsrc/x.json: {{\"dispatchPrompt\": \"not the plan\"}}\n"
        );
        assert!(codex_draft_from_transcript(&transcript).is_some(), "the transcript alone would be misread");
        let (answer, found) = codex_draft(&roots, "int-3", 0, None, transcript.as_bytes(), 60_000);
        assert_eq!(answer, Ok(None));
        assert!(found.is_some());
        // With no rollout at all: only once the session has been quiet.
        let none = tmp.path().join("empty");
        let roots = codex_session_roots(&none, &none);
        assert_eq!(codex_draft(&roots, "int-3", 0, None, transcript.as_bytes(), 1_000).0, Ok(None));
        assert!(codex_draft(&roots, "int-3", 0, None, transcript.as_bytes(), 3_000).0.unwrap().is_some());
    }

    /// Challenger P2-2: an answer without a proposal is said, not waited out.
    #[test]
    fn an_answer_without_a_proposal_is_an_error_not_a_wait() {
        let marker = codex_intake_marker("int-4");
        let text = rollout(&[user(&marker), user(CONCLUDE_SENTINEL), done("Sure — what else?")]);
        assert_eq!(codex_answer_from_rollout(&text, &marker), Some(RolloutAnswer::NoProposal));
        let tmp = tempdir().unwrap();
        let day = tmp.path().join("sessions").join("2026").join("09").join("28");
        fs::create_dir_all(&day).unwrap();
        fs::write(day.join("rollout-a.jsonl"), &text).unwrap();
        let roots = vec![tmp.path().join("sessions")];
        let (answer, _) = codex_draft(&roots, "int-4", 0, None, b"", 0);
        assert!(answer.unwrap_err().starts_with("Couldn't parse the plan"));
        // Before the answer: waiting.
        let waiting = rollout(&[user(&marker), user(CONCLUDE_SENTINEL)]);
        assert_eq!(codex_answer_from_rollout(&waiting, &marker), Some(RolloutAnswer::Waiting));
    }

    /// Challenger P2-2: a ``` inside a string of the proposal does not end it.
    #[test]
    fn a_fence_inside_the_prompt_string_does_not_cut_the_proposal() {
        let text = "Done.\n\n```json\n{\"dispatchPrompt\":\"Run:\\n```bash\\nnpm test\\n```\\nthen ship\",\"suggestedSwarmTemplateId\":null}\n```\n";
        let p = last_json_proposal(text).unwrap();
        assert_eq!(p.dispatch_prompt, "Run:\n```bash\nnpm test\n```\nthen ship");
        // Two blocks: the last one counts.
        let two = format!("```json\n{{\"dispatchPrompt\":\"first\"}}\n```\n{text}");
        assert_eq!(last_json_proposal(&two).unwrap().dispatch_prompt, "Run:\n```bash\nnpm test\n```\nthen ship");
        assert!(last_json_proposal("```json\nnot json\n```").is_none());
    }

    /// P3-4: once found, the rollout is read alone.
    #[test]
    fn a_known_rollout_is_read_without_a_scan() {
        let tmp = tempdir().unwrap();
        let file = tmp.path().join("elsewhere.jsonl");
        let marker = codex_intake_marker("int-5");
        fs::write(&file, rollout(&[user(&marker), user(CONCLUDE_SENTINEL), done(ANSWER)])).unwrap();
        // No roots at all: only the known path can answer.
        let (answer, found) = codex_draft(&[], "int-5", 0, Some(&file), b"", 0);
        assert_eq!(answer.unwrap().unwrap().dispatch_prompt, "Build it");
        assert_eq!(found.as_deref(), Some(file.as_path()));
    }

    #[test]
    fn materialized_codex_draft_is_read_and_applied_like_claudes() {
        let tmp = tempdir().unwrap();
        let store = IntakeStore::new(tmp.path().to_path_buf()).unwrap();
        let home = tmp.path().join("codex-home");
        let day = home.join("sessions").join("2026").join("09").join("28");
        fs::create_dir_all(&day).unwrap();
        fs::write(
            day.join("rollout-a.jsonl"),
            rollout(&[user(&codex_intake_marker("int-9")), user(CONCLUDE_SENTINEL), done(ANSWER)]),
        )
        .unwrap();
        let draft_path = store.draft_path("ws", "card");
        fs::create_dir_all(draft_path.parent().unwrap()).unwrap();
        let session = |vendor: &str| IntakeSession {
            pty_id: "p".into(),
            workspace_id: "ws".into(),
            card_id: "card".into(),
            draft_path: draft_path.clone(),
            started_at: 0,
            last_activity_at: Arc::new(AtomicI64::new(0)),
            intake_id: "int-9".into(),
            transcript_buf: Arc::new(parking_lot::Mutex::new(Vec::new())),
            rollout_path: Arc::new(parking_lot::Mutex::new(None)),
            exited: Default::default(),
            vendor: vendor.into(),
        };
        let roots = codex_session_roots(&home, tmp.path());
        // A Claude intake writes its own file; nothing is materialized.
        assert!(!store.materialize_codex_draft(&session("claude"), &roots).unwrap());
        assert!(store.read_draft("ws", "card").unwrap().is_none());
        assert!(store.materialize_codex_draft(&session("codex"), &roots).unwrap());
        let read = store.read_draft("ws", "card").unwrap().unwrap();
        assert_eq!(read.dispatch_prompt, "Build it");
        // No temp file left beside it.
        let names: Vec<String> = fs::read_dir(draft_path.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["card.json".to_string()]);
    }

    #[test]
    fn the_conclude_enter_waits_for_quiet_only_for_codex_on_windows() {
        assert!(submits_after_quiet("codex", true));
        assert!(!submits_after_quiet("codex", false));
        assert!(!submits_after_quiet("claude", true));
        assert!(!submits_after_quiet("claude", false));
        // Never before 500 ms, then after 500 ms of quiet, and by 30 s.
        assert!(!settled_for_enter(1_300, 1_000, 1_000));
        assert!(settled_for_enter(1_500, 1_000, 1_000));
        assert!(!settled_for_enter(1_700, 1_000, 1_400));
        assert!(settled_for_enter(1_900, 1_000, 1_400));
        assert!(settled_for_enter(31_000, 1_000, 30_999));
    }

    // v1.17.0 (Cycle E.5): idle-cancel helper tests.

    #[test]
    fn idle_cancel_skips_ready_intakes_regardless_of_age() {
        // A Ready intake (sentinel concluded, awaiting apply) is never
        // auto-cancelled even if it's hours old.
        let one_hour_ago = -3_600_000;
        assert!(!is_idle_for_cancel(0, one_hour_ago, true));
    }

    #[test]
    fn idle_cancel_fires_after_timeout_when_not_ready() {
        // Timeout + 1ms past last activity, status not Ready → cancel.
        let last_activity = 0;
        let now = IDLE_INTAKE_TIMEOUT_MS + 1;
        assert!(is_idle_for_cancel(now, last_activity, false));
    }

    #[test]
    fn idle_cancel_skips_when_within_timeout() {
        // Just under timeout past last activity, not Ready → still alive.
        let last_activity = 0;
        let now = IDLE_INTAKE_TIMEOUT_MS - 60_000;
        assert!(!is_idle_for_cancel(now, last_activity, false));
    }

    #[test]
    fn idle_cancel_handles_clock_skew_gracefully() {
        // If somehow `now < last_activity_at` (clock skew, mocked test),
        // the saturating_sub keeps the result at 0, so we don't cancel.
        assert!(!is_idle_for_cancel(0, 1_000_000, false));
    }

    #[test]
    fn store_returns_default_when_no_override() {
        let tmp = tempdir().unwrap();
        let store = IntakeStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(store.system_prompt(), DEFAULT_SYSTEM_PROMPT);
    }

    /// GH #214: an override planted where the pre-1.146 builds wrote one —
    /// global and per-workspace — is ignored, and left on disk as it was.
    #[test]
    fn intake_ignores_a_planted_pre_1_146_override_and_leaves_it_on_disk() {
        let tmp = tempdir().unwrap();
        let store = IntakeStore::new(tmp.path().to_path_buf()).unwrap();
        let global = tmp.path().join("intake").join("system_prompt.md");
        fs::write(&global, "custom intake prompt body").unwrap();
        let per_ws = tmp.path().join("projects").join("ws-A").join("intake.md");
        fs::create_dir_all(per_ws.parent().unwrap()).unwrap();
        fs::write(&per_ws, "ws-A specific").unwrap();
        assert_eq!(store.system_prompt(), DEFAULT_SYSTEM_PROMPT);
        // A fresh store (the next launch) ignores them too.
        let again = IntakeStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(again.system_prompt(), DEFAULT_SYSTEM_PROMPT);
        // User state is never deleted or rewritten.
        assert_eq!(fs::read_to_string(&global).unwrap(), "custom intake prompt body");
        assert_eq!(fs::read_to_string(&per_ws).unwrap(), "ws-A specific");
    }

    /// GH #214: `start_intake` takes its base prompt from
    /// `IntakeStore::system_prompt`, and the override files are named only
    /// by their constants and `ignored_overrides`, which never reads (the
    /// read cannot come back by another path). The production code is
    /// everything before `mod tests {`, however many `#[cfg(test)]` items
    /// sit above it (review 1).
    #[test]
    fn start_intake_reads_no_override_file() {
        let src = include_str!("intake.rs");
        let production = src.split_once("\nmod tests {").expect("the test module").0;
        let code: Vec<&str> = production
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect();
        let joined = code.join("\n");
        assert!(joined.contains("assemble_system_prompt(intake_store.system_prompt(),"));
        for gone in ["\"system_prompt.md\"", "\"intake.md\"", "IGNORED_GLOBAL_OVERRIDE", "IGNORED_WORKSPACE_OVERRIDE"] {
            let named: Vec<&&str> = code.iter().filter(|l| l.contains(gone)).collect();
            for line in &named {
                let line = line.trim_start();
                assert!(
                    line.starts_with("const IGNORED_")
                        || line.starts_with("let global = config_dir.join(INTAKE_SUBDIR).join(IGNORED_GLOBAL_OVERRIDE)")
                        || line.starts_with(".map(|e| e.path().join(IGNORED_WORKSPACE_OVERRIDE))"),
                    "intake.rs names {gone} outside ignored_overrides: {line}"
                );
            }
        }
        let lister = joined
            .split_once("fn ignored_overrides(")
            .unwrap()
            .1
            .split_once("\n}\n")
            .unwrap()
            .0;
        assert!(!lister.contains("read_to_string") && !lister.contains("fs::read("), "ignored_overrides must never read a file");
        for gone in ["system_prompt_for", "override_path"] {
            assert!(!joined.contains(gone), "intake.rs code still names {gone}");
        }
    }

    /// GH #214 review 1: what the launch log names — both kinds of ignored
    /// override, and nothing when there is none.
    #[test]
    fn ignored_overrides_lists_the_files_it_would_log() {
        let tmp = tempdir().unwrap();
        let store = IntakeStore::new(tmp.path().to_path_buf()).unwrap();
        assert!(ignored_overrides(tmp.path()).is_empty());
        let global = tmp.path().join("intake").join("system_prompt.md");
        fs::write(&global, "x").unwrap();
        let per_ws = tmp.path().join("projects").join("ws-A").join("intake.md");
        fs::create_dir_all(per_ws.parent().unwrap()).unwrap();
        fs::write(&per_ws, "y").unwrap();
        fs::create_dir_all(tmp.path().join("projects").join("ws-B")).unwrap();
        assert_eq!(ignored_overrides(tmp.path()), vec![global, per_ws]);
        assert_eq!(store.system_prompt(), DEFAULT_SYSTEM_PROMPT);
    }

    /// 1.168.1 (A3): the TUI's cursor-forward spaces stay spaces in the
    /// transcript History search reads; the other escapes still go.
    #[test]
    fn finalize_transcript_keeps_the_spaces_a_tui_draws_as_cursor_moves() {
        let tmp = tempdir().unwrap();
        let store = IntakeStore::new(tmp.path().to_path_buf()).unwrap();
        let raw = b"\x1b[1m\xe2\x8e\xbf\x1b[22m\x1b[1CWrote\x1b[1C4\x1b[1Clines\x1b[1Cto\x1b[1C~/notes";
        let rel = store.finalize_transcript("ws", "card", "i1", raw).unwrap();
        let text = store.read_transcript(&rel.to_string_lossy()).unwrap().unwrap();
        assert_eq!(text, "\u{23bf} Wrote 4 lines to ~/notes");
        // Mac walk: Claude Code 2.1.x moves to each word's column instead
        // (`ESC[<n>G`), and resets its charset (`ESC ( B`, shift-in).
        let raw = b"3.\x1b[4GHow\x1b[8Gdo\x1b[11Gwe\x1b[14Gcount\x1b[20Gwords?\r\r\n  \x1b(B\x0f\r\xe2\x9d\xaf 1a";
        let rel = store.finalize_transcript("ws", "card", "i2", raw).unwrap();
        let text = store.read_transcript(&rel.to_string_lossy()).unwrap().unwrap();
        assert_eq!(text, "3. How do we count words?\r\r\n  \r\u{276f} 1a");
    }

    #[test]
    fn read_draft_returns_none_when_missing() {
        let tmp = tempdir().unwrap();
        let store = IntakeStore::new(tmp.path().to_path_buf()).unwrap();
        let r = store.read_draft("ws", "card").unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn read_draft_parses_valid_json() {
        let tmp = tempdir().unwrap();
        let store = IntakeStore::new(tmp.path().to_path_buf()).unwrap();
        let path = store.draft_path("ws", "card-1");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let body = br#"{"dispatchPrompt":"Build a thing","suggestedSwarmTemplateId":"feature"}"#;
        fs::write(&path, body).unwrap();
        let proposal = store.read_draft("ws", "card-1").unwrap().unwrap();
        assert_eq!(proposal.dispatch_prompt, "Build a thing");
        assert_eq!(
            proposal.suggested_swarm_template_id.as_deref(),
            Some("feature")
        );
    }

    #[test]
    fn read_draft_errors_on_malformed_json() {
        let tmp = tempdir().unwrap();
        let store = IntakeStore::new(tmp.path().to_path_buf()).unwrap();
        let path = store.draft_path("ws", "card-1");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{not json").unwrap();
        let err = store.read_draft("ws", "card-1").unwrap_err();
        assert!(err.contains("parse"));
    }

    #[test]
    fn read_draft_accepts_null_suggested_template() {
        let tmp = tempdir().unwrap();
        let store = IntakeStore::new(tmp.path().to_path_buf()).unwrap();
        let path = store.draft_path("ws", "card-1");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let body = br#"{"dispatchPrompt":"X","suggestedSwarmTemplateId":null}"#;
        fs::write(&path, body).unwrap();
        let proposal = store.read_draft("ws", "card-1").unwrap().unwrap();
        assert!(proposal.suggested_swarm_template_id.is_none());
    }

    #[test]
    fn read_draft_accepts_missing_suggested_template_field() {
        let tmp = tempdir().unwrap();
        let store = IntakeStore::new(tmp.path().to_path_buf()).unwrap();
        let path = store.draft_path("ws", "card-1");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let body = br#"{"dispatchPrompt":"X"}"#;
        fs::write(&path, body).unwrap();
        let proposal = store.read_draft("ws", "card-1").unwrap().unwrap();
        assert!(proposal.suggested_swarm_template_id.is_none());
    }

    #[test]
    fn delete_draft_is_idempotent() {
        let tmp = tempdir().unwrap();
        let store = IntakeStore::new(tmp.path().to_path_buf()).unwrap();
        store.delete_draft("ws", "card-1").unwrap();
        store.delete_draft("ws", "card-1").unwrap();
    }

    #[test]
    fn validate_drops_unknown_template_id() {
        let prop = IntakeProposal {
            dispatch_prompt: "ok".into(),
            suggested_swarm_template_id: Some("nonexistent".into()),
        };
        let validated = prop.validate(&["feature".into(), "refactor".into()]).unwrap();
        assert!(validated.suggested_swarm_template_id.is_none());
    }

    #[test]
    fn validate_keeps_known_template_id() {
        let prop = IntakeProposal {
            dispatch_prompt: "ok".into(),
            suggested_swarm_template_id: Some("feature".into()),
        };
        let validated = prop.validate(&["feature".into(), "refactor".into()]).unwrap();
        assert_eq!(
            validated.suggested_swarm_template_id.as_deref(),
            Some("feature")
        );
    }

    #[test]
    fn validate_rejects_empty_dispatch_prompt() {
        let prop = IntakeProposal {
            dispatch_prompt: "".into(),
            suggested_swarm_template_id: None,
        };
        assert!(prop.validate(&["feature".into()]).is_err());
        let prop2 = IntakeProposal {
            dispatch_prompt: "   \n  ".into(),
            suggested_swarm_template_id: None,
        };
        assert!(prop2.validate(&["feature".into()]).is_err());
    }

    #[test]
    fn assemble_system_prompt_includes_catalog_and_draft_path() {
        let base = "You are the intake agent.";
        let catalog = vec![
            SwarmTemplate {
                schema_version: 1,
                id: "feature".into(),
                label: "Feature".into(),
                description: "Plan + build + review".into(),
                steps: Vec::new(),
                max_iterations: 3,
                max_wall_seconds: 600,
                builtin: true,
                coordinator: false,
                output_kind: crate::swarm_templates::OutputKind::Code,
                created_at: 0,
                updated_at: 0,
                author: None,
                last_edited_by: None,
                scope: crate::shared_library::LibraryScope::Personal,
            },
        ];
        let path = PathBuf::from("/tmp/draft.json");
        let assembled = assemble_system_prompt(base, &catalog, &path);
        assert!(assembled.contains("You are the intake agent."));
        assert!(assembled.contains("`feature`"));
        assert!(assembled.contains("Plan + build + review"));
        assert!(assembled.contains("/tmp/draft.json"));
        assert!(assembled.contains(CONCLUDE_SENTINEL));
    }

    #[test]
    fn conclude_submission_writes_body_then_isolated_enter() {
        assert!(!CONCLUDE_SENTINEL.contains('\r'));
        assert!(!CONCLUDE_SENTINEL.contains('\n'));

        let mut writes = Vec::<Vec<u8>>::new();
        let waited = std::cell::Cell::new(false);
        write_conclude_submission(
            CONCLUDE_SENTINEL.as_bytes(),
            |bytes| {
                writes.push(bytes.to_vec());
                Ok(())
            },
            || waited.set(true),
        )
        .expect("submission succeeds");

        assert!(waited.get());
        assert_eq!(
            writes,
            vec![CONCLUDE_SENTINEL.as_bytes().to_vec(), b"\r".to_vec()]
        );
    }

    #[test]
    fn conclude_submission_does_not_press_enter_after_body_failure() {
        let calls = std::cell::Cell::new(0_u32);
        let waited = std::cell::Cell::new(false);
        let error = write_conclude_submission(
            CONCLUDE_SENTINEL.as_bytes(),
            |_| {
                calls.set(calls.get() + 1);
                Err("body unavailable".into())
            },
            || waited.set(true),
        )
        .expect_err("body failure must stop submission");

        assert_eq!(calls.get(), 1);
        assert!(!waited.get());
        assert_eq!(
            error,
            "write conclude sentinel: body unavailable".to_string()
        );
    }

    #[test]
    fn conclude_submission_reports_isolated_enter_failure() {
        let calls = std::cell::Cell::new(0_u32);
        let error = write_conclude_submission(
            CONCLUDE_SENTINEL.as_bytes(),
            |_| {
                calls.set(calls.get() + 1);
                if calls.get() == 1 {
                    Ok(())
                } else {
                    Err("submit unavailable".into())
                }
            },
            || {},
        )
        .expect_err("submit failure must remain distinct");

        assert_eq!(calls.get(), 2);
        assert_eq!(error, "write conclude submit: submit unavailable".to_string());
    }

    fn now_for_test() -> i64 {
        // Fixed reference instant for relative-time formatting tests.
        // 2026-05-06T20:00:00Z in unix-ms.
        1_777_017_600_000
    }

    #[test]
    fn priming_message_includes_title_notes_knowledge_and_proceed_instruction() {
        let m = build_priming_message(
            "Add archive action",
            Some("Completed cards stay in Complete forever."),
            Some("See PATTERNS.md for kanban-cache rule."),
            &[],
            &PrimingContext::empty(),
            now_for_test(),
        );
        assert!(m.starts_with("Card title: Add archive action"));
        assert!(m.contains("Completed cards stay in Complete forever."));
        assert!(m.contains("See PATTERNS.md"));
        assert!(m.contains("Please proceed with intake"));
        assert!(m.contains("always-ask-never-guess"));
        // v1.7.3: body has NO trailing terminator. Submit `\r` is sent as
        // a separate PTY write after `PRIMING_SUBMIT_DELAY_MS`; gluing it
        // onto the body fails because claude treats CR-after-multiline as
        // another in-input line break.
        assert!(!m.ends_with('\r'));
        assert!(!m.ends_with('\n'));
    }

    #[test]
    fn priming_message_omits_empty_notes_and_knowledge() {
        let m = build_priming_message(
            "Simple card",
            None,
            None,
            &[],
            &PrimingContext::empty(),
            now_for_test(),
        );
        assert!(m.starts_with("Card title: Simple card"));
        assert!(!m.contains("Notes:"));
        assert!(!m.contains("Knowledge"));
        assert!(!m.contains("Attached files"));
        assert!(m.contains("Please proceed with intake"));
    }

    #[test]
    fn priming_message_treats_whitespace_as_empty() {
        let m = build_priming_message(
            "Title",
            Some("   \n  "),
            Some(""),
            &[],
            &PrimingContext::empty(),
            now_for_test(),
        );
        assert!(!m.contains("Notes:"));
        assert!(!m.contains("Knowledge"));
    }

    #[test]
    fn priming_message_trims_title() {
        let m = build_priming_message(
            "  spaced  ",
            None,
            None,
            &[],
            &PrimingContext::empty(),
            now_for_test(),
        );
        assert!(m.starts_with("Card title: spaced"));
        assert!(!m.contains("  spaced  "));
    }

    #[test]
    fn priming_message_includes_attachments_block_when_present() {
        let attachments = vec![
            CardAttachment {
                id: "a1".into(),
                display_name: "shot.png".into(),
                stored_path: "/tmp/atelier/attachments/ws/c1/a1-shot.png"
                    .into(),
                size_bytes: 1024,
                mime_type: Some("image/png".into()),
                added_at: 0,
            },
            CardAttachment {
                id: "a2".into(),
                display_name: "doc.pdf".into(),
                stored_path: "/tmp/atelier/attachments/ws/c1/a2-doc.pdf"
                    .into(),
                size_bytes: 4096,
                mime_type: None,
                added_at: 0,
            },
        ];
        let m = build_priming_message(
            "T",
            None,
            None,
            &attachments,
            &PrimingContext::empty(),
            now_for_test(),
        );
        assert!(m.contains("Attached files:"));
        assert!(m.contains("/tmp/atelier/attachments/ws/c1/a1-shot.png"));
        assert!(m.contains("/tmp/atelier/attachments/ws/c1/a2-doc.pdf"));
    }

    fn sample_git() -> GitContext {
        GitContext {
            branch: "feature-xyz".into(),
            dirty_files: vec!["M src/foo.rs".into(), "?? new.txt".into()],
            recent_commits: vec![
                "abc1234 v1.7.3: hotfix".into(),
                "def5678 v1.7.2: another".into(),
            ],
        }
    }

    fn sample_run_snap(title: &str, ended_at: i64) -> RunHistorySnapshot {
        RunHistorySnapshot {
            card_title: title.into(),
            ended_at,
            files_changed_count: 3,
            top_paths: vec!["src/a.rs".into(), "src/b.rs".into()],
        }
    }

    #[test]
    fn priming_includes_git_context_block_when_provided() {
        let ctx = PrimingContext {
            git: Some(sample_git()),
            ..PrimingContext::empty()
        };
        let m =
            build_priming_message("T", None, None, &[], &ctx, now_for_test());
        assert!(m.contains("Workspace git state:"));
        assert!(m.contains("Branch: feature-xyz"));
        assert!(m.contains("M src/foo.rs"));
        assert!(m.contains("abc1234 v1.7.3"));
    }

    #[test]
    fn priming_omits_git_block_when_none() {
        let m = build_priming_message(
            "T",
            None,
            None,
            &[],
            &PrimingContext::empty(),
            now_for_test(),
        );
        assert!(!m.contains("Workspace git state"));
        assert!(!m.contains("Branch:"));
    }

    #[test]
    fn priming_includes_recent_run_history_block() {
        let ctx = PrimingContext {
            recent_runs: vec![
                sample_run_snap("Card A", now_for_test() - 60_000),
                sample_run_snap("Card B", now_for_test() - 3_600_000),
            ],
            ..PrimingContext::empty()
        };
        let m =
            build_priming_message("T", None, None, &[], &ctx, now_for_test());
        assert!(m.contains("Recent kanban activity"));
        assert!(m.contains("\"Card A\""));
        assert!(m.contains("\"Card B\""));
        assert!(m.contains("1m ago"));
        assert!(m.contains("1h ago"));
        assert!(m.contains("3 files"));
    }

    #[test]
    fn priming_omits_recent_runs_block_when_empty() {
        let m = build_priming_message(
            "T",
            None,
            None,
            &[],
            &PrimingContext::empty(),
            now_for_test(),
        );
        assert!(!m.contains("Recent kanban activity"));
    }

    #[test]
    fn format_relative_time_buckets() {
        let now: i64 = 1_000_000_000;
        assert_eq!(format_relative_time(now - 30_000, now), "just now");
        assert_eq!(format_relative_time(now - 60_000, now), "1m ago");
        assert_eq!(format_relative_time(now - 3_600_000, now), "1h ago");
        assert_eq!(format_relative_time(now - 86_400_000, now), "1d ago");
        // Future timestamp clamps to "just now" rather than producing
        // negative output.
        assert_eq!(format_relative_time(now + 1000, now), "just now");
    }

    #[test]
    fn registry_insert_get_remove_round_trip() {
        let reg = IntakeRegistry::default();
        let session = IntakeSession {
            pty_id: "pty-1".into(),
            workspace_id: "ws".into(),
            card_id: "card-1".into(),
            draft_path: PathBuf::from("/tmp/x.json"),
            started_at: 1,
            last_activity_at: Arc::new(AtomicI64::new(1)),
            intake_id: "int-test-1".into(),
            transcript_buf: Arc::new(parking_lot::Mutex::new(Vec::new())),
            rollout_path: Arc::new(parking_lot::Mutex::new(None)),
            exited: Default::default(),
            vendor: "claude".into(),
        };
        reg.insert(session);
        assert!(reg.get("card-1").is_some());
        assert_eq!(reg.pty_id_for("card-1").as_deref(), Some("pty-1"));
        let removed = reg.remove("card-1").unwrap();
        assert_eq!(removed.pty_id, "pty-1");
        assert!(reg.get("card-1").is_none());
    }

    // ── N14 walk F10: the first prompt waits past the trust question ──

    /// Claude Code 2.1.287 at its folder-trust question, as the walk's
    /// intake recorded it ("No, exit" highlighted).
    const RECORDED_TRUST: &str = "\x1b[2J\x1b[H\x1b[38;5;178m\u{2500}\u{2500}\u{2500}\u{2500}\x1b[39m\r\n \
        \x1b[1mAccessing workspace:\x1b[22m\r\n\r\n /Users/o/sandboxes/2026-10-02-gates/beta\r\n\r\n \
        Quick safety check: Is this a project you created or one you trust? (Like your own code, a \
        well-known open source project, or work from your team). If not, take a moment to review \
        what's in this folder first.\r\n\r\n Claude Code'll be able to read, edit, and execute files \
        here.\r\n\r\n \x1b[2mSecurity guide\x1b[22m\r\n\r\n \x1b[38;5;105m\u{276f} No, exit\x1b[39m\r\n   \
        Yes, I trust this folder\r\n\r\n \x1b[2mEnter to confirm \u{b7} Esc to cancel\x1b[22m\r\n";

    /// Its REPL once ready: input placeholder and mode line (2.1.287).
    const RECORDED_REPL: &str = "\x1b[2J\x1b[H \x1b[1mClaude Code\x1b[22m v2.1.287\r\n \
        Opus 5.5 (1M context) \u{b7} Claude Max\r\n\r\n\u{2500}\u{2500}\u{2500}\u{2500}\r\n\
        \u{276f} \x1b[2mTry \"write a test for <filepath>\"\x1b[22m\r\n\u{2500}\u{2500}\u{2500}\u{2500}\r\n  \
        \u{23f5}\u{23f5} auto mode on (shift+tab to cycle)\r\n";

    #[test]
    fn the_first_prompt_waits_at_the_trust_question_however_long() {
        let hour = Duration::from_secs(3600);
        assert!(!priming_may_write(RECORDED_TRUST.as_bytes(), Duration::ZERO, Duration::ZERO));
        assert!(!priming_may_write(RECORDED_TRUST.as_bytes(), hour, hour));
        // The person said Yes: the REPL draws and the prompt goes in.
        let answered = format!("{RECORDED_TRUST}{RECORDED_REPL}");
        assert!(priming_may_write(answered.as_bytes(), Duration::ZERO, Duration::ZERO));
    }

    #[test]
    fn the_first_prompt_goes_in_once_the_repl_is_ready_or_after_the_fallback() {
        let fallback = Duration::from_millis(PRIMING_FALLBACK_MS);
        let still = Duration::from_millis(PRIMING_STILL_MS);
        // A trusted folder: no question, the REPL straight away.
        assert!(priming_may_write(RECORDED_REPL.as_bytes(), Duration::ZERO, Duration::ZERO));
        // A screen no marker matches: not before the fallback…
        let unknown = b"\x1b[2J Claude Code v9\r\n > \r\n";
        assert!(!priming_may_write(unknown, Duration::from_millis(1500), still));
        // …nor while it is still being drawn (Challenger P3a)…
        assert!(!priming_may_write(unknown, fallback, Duration::from_millis(200)));
        // …but once it has stood still past the fallback, it gets the prompt.
        assert!(priming_may_write(unknown, fallback, still));
        // Nothing visible drawn yet (only start-up escapes): never blind.
        let noise = b"\x1b[?2004h\x1b[?1004h\x1b[?25l";
        assert!(!priming_may_write(noise, Duration::from_secs(60), Duration::from_secs(60)));
        assert!(!priming_may_write(b"", Duration::from_secs(60), Duration::from_secs(60)));
        // A question half drawn (its key hint not out yet): its words are
        // on screen, so no fallback types into it, however still.
        let half = RECORDED_TRUST.split("Enter to confirm").next().unwrap();
        assert!(!crate::builder::trust_question_pending(half.as_bytes()));
        assert!(!priming_may_write(half.as_bytes(), Duration::from_secs(60), Duration::from_secs(60)));
    }

    /// Challenger P2: an intake whose Claude exited at the question (its
    /// transcript still ends on it) asks nothing.
    #[test]
    fn an_exited_intake_at_the_trust_question_is_not_asking() {
        let reg = IntakeRegistry::default();
        let session = |card: &str| IntakeSession {
            pty_id: format!("pty-{card}"),
            workspace_id: "ws".into(),
            card_id: card.into(),
            draft_path: PathBuf::from("/tmp/x.json"),
            started_at: 1,
            last_activity_at: Arc::new(AtomicI64::new(1)),
            intake_id: format!("int-{card}"),
            transcript_buf: Arc::new(parking_lot::Mutex::new(RECORDED_TRUST.as_bytes().to_vec())),
            rollout_path: Arc::new(parking_lot::Mutex::new(None)),
            exited: Default::default(),
            vendor: "claude".into(),
        };
        let live = session("card-live");
        let gone = session("card-gone");
        gone.exited.store(true, Ordering::Relaxed);
        reg.insert(live);
        reg.insert(gone);
        let keys: Vec<String> = reg.trust_questions().into_iter().map(|q| q.key).collect();
        assert_eq!(keys, vec!["card-live".to_string()]);
    }

    /// N14 walk F14: an intake whose PTY exited is listed as ended (the
    /// Board and the Inbox read it); a live one is not.
    #[test]
    fn an_exited_intake_is_listed_as_ended() {
        let reg = IntakeRegistry::default();
        let session = |card: &str| IntakeSession {
            pty_id: format!("pty-{card}"),
            workspace_id: "ws".into(),
            card_id: card.into(),
            draft_path: PathBuf::from("/tmp/x.json"),
            started_at: 1,
            last_activity_at: Arc::new(AtomicI64::new(1)),
            intake_id: format!("int-{card}"),
            transcript_buf: Arc::new(parking_lot::Mutex::new(Vec::new())),
            rollout_path: Arc::new(parking_lot::Mutex::new(None)),
            exited: Default::default(),
            vendor: "claude".into(),
        };
        assert_eq!(reg.sessions_report(), IntakeSessionsReport::default());
        let live = session("card-live");
        let gone = session("card-gone");
        reg.insert(live);
        reg.insert(gone.clone());
        assert!(reg.ended_cards().is_empty());
        assert_eq!(reg.live_cards(), vec!["card-gone".to_string(), "card-live".to_string()]);
        gone.exited.store(true, Ordering::Relaxed);
        assert_eq!(
            reg.sessions_report(),
            IntakeSessionsReport { ended: vec!["card-gone".into()], live: vec!["card-live".into()] }
        );
        // Cancelled (or planned again): the entry goes, and so does the row.
        reg.remove("card-gone");
        assert!(reg.ended_cards().is_empty());
        assert_eq!(reg.live_cards(), vec!["card-live".to_string()]);
    }

    /// Challenger P3b: deleting a card ends its intake — the entry goes
    /// (so the priming thread stops) and its PTY is killed.
    #[test]
    fn ending_a_cards_intake_removes_it_and_kills_its_pty() {
        let reg = IntakeRegistry::default();
        reg.insert(IntakeSession {
            pty_id: "pty-9".into(),
            workspace_id: "ws".into(),
            card_id: "card-9".into(),
            draft_path: PathBuf::from("/tmp/x.json"),
            started_at: 1,
            last_activity_at: Arc::new(AtomicI64::new(1)),
            intake_id: "int-9".into(),
            transcript_buf: Arc::new(parking_lot::Mutex::new(Vec::new())),
            rollout_path: Arc::new(parking_lot::Mutex::new(None)),
            exited: Default::default(),
            vendor: "claude".into(),
        });
        let mut killed = Vec::new();
        assert!(reg.end_session_with("card-9", |id| killed.push(id.to_string())));
        assert_eq!(killed, vec!["pty-9".to_string()]);
        assert!(reg.pty_id_for("card-9").is_none());
        assert!(!reg.end_session_with("card-9", |_| panic!("no second kill")));
        // The card delete calls it (beside the Builder's end_session).
        let commands = include_str!("commands.rs");
        let delete = &commands[commands.find("fn finish_card_delete(").unwrap()..];
        let delete = &delete[..delete.find("\n}\n").unwrap()];
        assert!(delete.contains("state::<IntakeRegistry>()") && delete.contains(".end_session("));
    }

    #[test]
    fn the_registry_names_intakes_at_the_trust_question() {
        let reg = IntakeRegistry::default();
        let session = |card: &str, bytes: &str| IntakeSession {
            pty_id: format!("pty-{card}"),
            workspace_id: "ws".into(),
            card_id: card.into(),
            draft_path: PathBuf::from("/tmp/x.json"),
            started_at: 1,
            last_activity_at: Arc::new(AtomicI64::new(1)),
            intake_id: format!("int-{card}"),
            transcript_buf: Arc::new(parking_lot::Mutex::new(bytes.as_bytes().to_vec())),
            rollout_path: Arc::new(parking_lot::Mutex::new(None)),
            exited: Default::default(),
            vendor: "claude".into(),
        };
        reg.insert(session("card-b", RECORDED_TRUST));
        reg.insert(session("card-a", &format!("{RECORDED_TRUST}{RECORDED_REPL}")));
        reg.insert(session("card-c", RECORDED_REPL));
        assert_eq!(
            reg.trust_questions(),
            vec![crate::builder::SessionBlock {
                key: "card-b".into(),
                workspace_id: "ws".into(),
                vendor: "claude".into(),
                intake: true,
                kind: crate::builder::SessionBlockKind::Trust,
                resets_at: None,
            }]
        );
    }

    /// v1.20.2 hotfix: idle is measured from last activity, not session
    /// start. A long-running session that received output recently is
    /// still alive even if it spawned well past the cutoff ago.
    #[test]
    fn idle_cancel_skips_long_session_with_recent_activity() {
        let now = IDLE_INTAKE_TIMEOUT_MS + 60_000; // 1 minute past cutoff
        let last_activity = now - 60_000;          // 1 minute ago
        assert!(!is_idle_for_cancel(now, last_activity, false));
    }

    /// v1.20.2 hotfix: conversely, a session whose last activity is
    /// older than the cutoff IS idle and gets swept.
    #[test]
    fn idle_cancel_fires_when_no_recent_activity() {
        let now = IDLE_INTAKE_TIMEOUT_MS + 60_000;
        let last_activity = 0;
        assert!(is_idle_for_cancel(now, last_activity, false));
    }

    // --- v1.20.3 hotfix: draft-path recovery ---------------------------

    fn sample_proposal_bytes() -> &'static [u8] {
        br#"{"dispatchPrompt":"Build a thing","suggestedSwarmTemplateId":null}"#
    }

    #[test]
    fn read_draft_with_recovery_returns_canonical_when_present() {
        let tmp = tempdir().unwrap();
        let store = IntakeStore::new(tmp.path().to_path_buf()).unwrap();
        let path = store.draft_path("ws", "card-A");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, sample_proposal_bytes()).unwrap();
        let r = store
            .read_draft_with_recovery("ws", "card-A", 0, &[])
            .unwrap()
            .unwrap();
        assert_eq!(r.0.dispatch_prompt, "Build a thing");
        assert!(r.1.is_none(), "canonical path → recovered = None");
    }

    #[test]
    fn read_draft_with_recovery_falls_back_to_single_stray() {
        let tmp = tempdir().unwrap();
        let store = IntakeStore::new(tmp.path().to_path_buf()).unwrap();
        let dir = store.drafts_dir().join("ws");
        fs::create_dir_all(&dir).unwrap();
        let stray = dir.join("card-WRONG.json");
        fs::write(&stray, sample_proposal_bytes()).unwrap();
        let r = store
            .read_draft_with_recovery("ws", "card-A", 0, &[])
            .unwrap()
            .unwrap();
        assert_eq!(r.0.dispatch_prompt, "Build a thing");
        assert_eq!(r.1.as_deref(), Some(stray.as_path()));
    }

    #[test]
    fn read_draft_with_recovery_ignores_pre_session_strays() {
        let tmp = tempdir().unwrap();
        let store = IntakeStore::new(tmp.path().to_path_buf()).unwrap();
        let dir = store.drafts_dir().join("ws");
        fs::create_dir_all(&dir).unwrap();
        let stray = dir.join("card-OLD.json");
        fs::write(&stray, sample_proposal_bytes()).unwrap();
        // 1 hour in the future — anything older than this is ignored.
        let future = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
            + 3_600_000;
        let r = store
            .read_draft_with_recovery("ws", "card-A", future, &[])
            .unwrap();
        assert!(r.is_none(), "old stray must be ignored");
    }

    #[test]
    fn read_draft_with_recovery_skips_excluded_cards() {
        let tmp = tempdir().unwrap();
        let store = IntakeStore::new(tmp.path().to_path_buf()).unwrap();
        let dir = store.drafts_dir().join("ws");
        fs::create_dir_all(&dir).unwrap();
        // The "stray" is actually card-B's canonical draft — should be
        // excluded.
        let card_b = dir.join("card-B.json");
        fs::write(&card_b, sample_proposal_bytes()).unwrap();
        let r = store
            .read_draft_with_recovery("ws", "card-A", 0, &["card-B".to_string()])
            .unwrap();
        assert!(r.is_none(), "excluded card filename is not a stray");
    }

    #[test]
    fn read_draft_with_recovery_errors_on_multiple_strays() {
        let tmp = tempdir().unwrap();
        let store = IntakeStore::new(tmp.path().to_path_buf()).unwrap();
        let dir = store.drafts_dir().join("ws");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("card-X.json"), sample_proposal_bytes()).unwrap();
        fs::write(dir.join("card-Y.json"), sample_proposal_bytes()).unwrap();
        let err = store
            .read_draft_with_recovery("ws", "card-A", 0, &[])
            .unwrap_err();
        assert!(err.contains("multiple stray"), "got: {err}");
        assert!(err.contains("card-X.json"));
        assert!(err.contains("card-Y.json"));
    }

    #[test]
    fn read_draft_with_recovery_handles_missing_workspace_dir() {
        let tmp = tempdir().unwrap();
        let store = IntakeStore::new(tmp.path().to_path_buf()).unwrap();
        let r = store
            .read_draft_with_recovery("ws-missing", "card-A", 0, &[])
            .unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn read_draft_with_recovery_treats_unparseable_stray_as_none() {
        let tmp = tempdir().unwrap();
        let store = IntakeStore::new(tmp.path().to_path_buf()).unwrap();
        let dir = store.drafts_dir().join("ws");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("card-GARBAGE.json"), b"{not json").unwrap();
        let r = store
            .read_draft_with_recovery("ws", "card-A", 0, &[])
            .unwrap();
        assert!(r.is_none(), "unparseable stray → Ok(None) for caller to surface the standard 'no draft' error");
    }

    #[test]
    fn cancel_intake_cleans_stray_drafts() {
        // Set up: workspace has the canonical draft AND a hallucinated
        // stray. Cancel should kill both.
        let tmp = tempdir().unwrap();
        let store = IntakeStore::new(tmp.path().to_path_buf()).unwrap();
        let dir = store.drafts_dir().join("ws");
        fs::create_dir_all(&dir).unwrap();
        let canonical = store.draft_path("ws", "card-A");
        fs::write(&canonical, sample_proposal_bytes()).unwrap();
        let stray = dir.join("card-HALLUCINATED.json");
        fs::write(&stray, sample_proposal_bytes()).unwrap();

        // Register an active session for card-A. PTY id is fake — the
        // generic `pty_registry.kill` will error, which `cancel_intake`
        // already swallows with `let _ =`.
        let reg = IntakeRegistry::default();
        let pty_reg = PtyRegistry::default();
        reg.insert(IntakeSession {
            pty_id: "fake-pty".into(),
            workspace_id: "ws".into(),
            card_id: "card-A".into(),
            draft_path: canonical.clone(),
            started_at: 0,
            last_activity_at: Arc::new(AtomicI64::new(0)),
            intake_id: "int-test-1".into(),
            transcript_buf: Arc::new(parking_lot::Mutex::new(Vec::new())),
            rollout_path: Arc::new(parking_lot::Mutex::new(None)),
            exited: Default::default(),
            vendor: "claude".into(),
        });

        cancel_intake(&store, &pty_reg, &reg, "ws", "card-A").unwrap();
        assert!(!canonical.exists(), "canonical draft removed");
        assert!(!stray.exists(), "stray draft also removed");
        assert!(reg.get("card-A").is_none(), "session cleared");
    }
}
