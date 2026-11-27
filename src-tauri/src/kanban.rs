//! Per-workspace kanban board persistence.
//!
//! Each workspace stores its cards at `<config_dir>/kanban/workspaces/<wsId>.json`.
//! The on-the-wire schema is versioned (`version: 1`); future schema bumps
//! must update `KANBAN_SCHEMA_VERSION` and provide a migration path or
//! reject older versions cleanly. Atomic writes via tempfile + rename
//! (Hard Rule #3).
//!
//! v0.6.0: introduced.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::agents::AgentStatus;

pub(crate) const KANBAN_SUBDIR: &str = "kanban/workspaces";

/// 1.175.0 (X1, Windows walk): a folder under `config_dir` named by a
/// relative path written with `/`, joined part by part. `config_dir.join(
/// "kanban/workspaces")` keeps the `/` on Windows, and every path derived
/// from it — the board file, the file a notice says is kept, the marker —
/// read `C:\…\kanban/workspaces\<id>.json…` on screen and in the log.
fn config_subdir(config_dir: &Path, relative: &str) -> PathBuf {
    relative.split('/').fold(config_dir.to_path_buf(), |dir, part| dir.join(part))
}

/// X1 follow-up: a path that was stored as text, with this platform's own
/// separators. A `<id>.json.restored` written by a 1.175 build from before
/// X1 holds its `keptAs` as `C:\…\kanban/workspaces\<id>.json.unreadable-<ms>`;
/// read back part by part, the notice and its Show in File Explorer get the
/// path as Windows writes it. Elsewhere `/` is the separator already.
fn native_path(stored: &str) -> PathBuf {
    Path::new(stored).components().collect()
}

/// The boards folder (`<config_dir>/kanban/workspaces`), with the
/// platform's own separators. The one way production code names it:
/// `boards_dir_is_never_joined_with_a_slash` holds the others out.
pub(crate) fn boards_dir(config_dir: &Path) -> PathBuf {
    config_subdir(config_dir, KANBAN_SUBDIR)
}
/// v2 (v1.9.0): added verify/ship lifecycle fields. Existing v1 files
/// migrate on load — Complete-column cards become `verify_status: Legacy`
/// + `ship_status: Shipped` so the UI shows them as "shipped (pre-v1.9)"
/// without retroactive verification.
///
/// v3 (earlier in v1.10.0 cycle): added per-card `attachments`. v2 → v3
/// is a no-op migration — `#[serde(default)]` materializes
/// `attachments: Vec::new()` for existing cards; the version bump is
/// persisted so the on-disk file stops advertising v2 once read.
///
/// v4 (v1.10.0 Cycle A — worktrees): added `worktree_path` and
/// `branch_name` for per-card ephemeral git worktrees. v3 → v4 is a
/// no-op `#[serde(default)]` migration. Existing InProgress cards keep
/// `worktree_path: None` until their next column transition; the
/// lifecycle hooks (Cycle A v1.10.1) materialize the worktree lazily.
///
/// v6 (v1.26.0): added `linked_brainstorm_id` so a card can carry a
/// durable pointer to the brainstorm swarm launched from its detail
/// panel. Separate from `linked_swarm_id` because the kanban moveCard
/// flow overwrites `linked_swarm_id` on Confirm-intake dispatch — a
/// shared field would orphan the brainstorm. v5 → v6 is a no-op
/// `#[serde(default)]` migration.
///
/// v7 (v1.27.0, Cycle H phase 2): added `dismissed_banners` so the
/// `LinkedBrainstormBanner` ✕ button can hide itself without destroying
/// the durable `linked_brainstorm_id` routing that `PromoteButton`'s
/// cross-restart fallback relies on. v6 → v7 is a no-op
/// `#[serde(default)]` migration. The field is FE-only — no backend
/// writer races the whole-workspace persist path in
/// `kanbanStore.updateCard`.
///
/// v8 (v1.57.0, Cycle 3 — GitHub Issues backing): added `gh_issue_number`
/// so a card can mirror a GitHub issue when its workspace's
/// `kanban_sync_mode` is `GitHubIssues`. `None` for local-only cards (and
/// all legacy cards). v7 → v8 is a no-op `#[serde(default)]` migration.
pub(crate) const KANBAN_SCHEMA_VERSION: u32 = 8;
/// v1.19.0 (Cycle E4): cap on the per-card `intake_history` Vec. Mirrors
/// `MAX_HISTORY_ENTRIES` for run_history. Evicting an entry deletes its
/// transcript file from disk.
pub const MAX_INTAKE_HISTORY: usize = 10;
/// N14 walk F19: how many put backs a card keeps (`KanbanCard::put_backs`).
pub const MAX_PUT_BACKS: usize = 20;

/// v1.5.x run_history caps. Tighter than the architect's design proposed
/// (10 entries / 25 paths / 16 KB) because `kanban_load` is on the render
/// hot path and the per-card receipt is a "what shipped" signal, not an
/// archive.
const MAX_HISTORY_ENTRIES: usize = 5;
const MAX_TOP_PATHS: usize = 10;
const MAX_PATH_CHARS: usize = 200;
const MAX_ENTRY_BYTES: usize = 4 * 1024;

/// v1.5.x: system-managed receipt for a single agent or swarm run that
/// completed against a card. Appended by the PTY exit listener
/// (`agents.rs`) for oneshot runs and by `swarms::on_swarm_run_done` once
/// per swarm-terminal transition. Never user-edited and never injected
/// into a future run's prompt — see `docs/PATTERNS.md` for the
/// knowledge-vs-run_history rule.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunHistoryEntry {
    pub run_id: String,
    pub status: AgentStatus,
    pub ended_at: i64,
    pub files_changed_count: u32,
    /// Workspace-relative paths from the run's `changes.json`. Capped at
    /// `MAX_TOP_PATHS`, individually middle-truncated to `MAX_PATH_CHARS`.
    /// May be cleared (kept empty) when the serialized entry would exceed
    /// `MAX_ENTRY_BYTES`; counts remain.
    #[serde(default)]
    pub top_paths: Vec<String>,
    #[serde(default)]
    pub swarm_id: Option<String>,
    #[serde(default)]
    pub swarm_template_id: Option<String>,
    /// Out-of-glob writes detected in the run's manifest. Aggregated across
    /// legs for swarm entries.
    #[serde(default)]
    pub swarm_collisions: u32,
    #[serde(default)]
    pub agent_config_id: Option<String>,
    /// Number of legs aggregated into this entry. 1 for oneshot/sequential;
    /// >1 for coordinator-mode swarms with fan-out.
    #[serde(default = "default_legs")]
    pub legs: u32,
}

fn default_legs() -> u32 {
    1
}

/// v1.19.0 (Cycle E4): one record per intake session ever opened on a
/// card. Appended to `KanbanCard.intake_history` by `intake_apply`
/// (applied=true) or `intake_cancel` (applied=false). FIFO cap is
/// `MAX_INTAKE_HISTORY`; evicting an entry deletes its transcript.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IntakeRecord {
    pub intake_id: String,
    pub started_at: i64,
    pub concluded_at: Option<i64>,
    pub dispatch_prompt: Option<String>,
    /// Path relative to `<config_dir>` (e.g.
    /// `intake/transcripts/<wsId>/<cardId>/<intake_id>.log`). Joined with
    /// `config_dir` at read time. None when transcript persistence
    /// failed or the session never produced bytes.
    #[serde(default)]
    pub transcript_path: Option<String>,
    pub applied: bool,
    /// OB-14 (§13.3): "claude" | "codex" — who held the conversation. None
    /// on records written before OB-14, which were all Claude.
    #[serde(default)]
    pub vendor: Option<String>,
    /// N14 walk F20: this conversation was ended by Plan again, which
    /// started a new one at once — the Activity says "Planned again", not
    /// a cancel. `false` on every record before it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub replanned: bool,
    /// Plan with two AIs: this plan came from an exchange (its critic, the
    /// rounds, the exchange). `vendor` is then the proposer. Absent on every
    /// other record; an older Plyloft that writes the board back drops it,
    /// and the record reads as a plain intake by the proposer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub two_ais: Option<TwoAisRecord>,
}

/// What an Accept of Plan with two AIs adds to its `IntakeRecord`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TwoAisRecord {
    /// "claude" | "codex" — the same as the proposer when one vendor took
    /// both roles (Q5).
    pub critic: String,
    pub rounds: u32,
    pub exchange_id: String,
}

/// The longest plan Accept writes on a card.
pub const MAX_TWO_AI_PLAN_CHARS: usize = 24_000;

/// Accept on a card whose build has started (P1's backstop).
pub const TWO_AI_BUILD_STARTED: &str =
    "This card's Builder already started, so the plan wasn't changed. Copy it from here into Send to Builder if you need it.";

/// `<config>/attachments/<ws>/<card>`: a card's own attachments (the
/// Builder gets them as "Attached files:"), both ids checked as one path
/// component each.
pub fn card_attachments_dir(config_dir: &std::path::Path, workspace_id: &str, card_id: &str) -> Result<PathBuf, String> {
    Ok(config_dir
        .join("attachments")
        .join(crate::chat_store::safe_component(workspace_id, "workspace")?)
        .join(crate::chat_store::safe_component(card_id, "card")?))
}

/// The board's clock, for callers outside this module (UX-5.8).
pub fn now_ms() -> i64 {
    now_millis()
}

/// N19: the card has landed (`card_landed`). 1.174.0 A2: never while its
/// pull request is still open.
/// 1.174.0 (A6 round 1): the earliest ship among these cards (unix ms) — a
/// card's earliest `ship_history` entry, or `now_ms` for a shipped card with
/// none recorded. `None` while none shipped. The frontend's `firstShipAt`
/// says the same.
pub fn earliest_ship_ms(cards: &[KanbanCard], now_ms: i64) -> Option<i64> {
    cards
        .iter()
        .filter_map(|c| {
            let entry = c.ship_history.iter().map(|e| e.shipped_at).filter(|t| *t > 0).min();
            entry.or(matches!(c.ship_status, ShipStatus::Shipped).then_some(now_ms))
        })
        .min()
}

pub fn card_has_landed(card: &KanbanCard) -> bool {
    card_landed(card)
}

/// N19: whether `Follow up` may start from this card: it has landed, or —
/// on a GitHub Issues board — its issue is done (the card is in Complete
/// with an issue: a teammate shipped it, and this Mac never did). The
/// frontend's `followUpOffered`.
pub fn follow_up_allowed(card: &KanbanCard) -> bool {
    // 1.174.0 A2 round 1: not while the card's own pull request is open,
    // whatever its issue's column says.
    card_has_landed(card)
        || (card.gh_issue_number.is_some()
            && card.column_id == KanbanColumnId::Complete
            && !crate::pr_status::pr_open_on_card(card))
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Middle-truncate a string to at most `max_chars` characters, inserting
/// `…` between the head and tail. UTF-8 aware via char iteration.
fn middle_truncate(s: &str, max_chars: usize) -> String {
    let total: usize = s.chars().count();
    if total <= max_chars {
        return s.to_string();
    }
    if max_chars <= 1 {
        return "…".to_string();
    }
    let keep = max_chars - 1;
    let head_len = keep / 2 + (keep % 2);
    let tail_len = keep - head_len;
    let head: String = s.chars().take(head_len).collect();
    let tail: String = s.chars().skip(total - tail_len).collect();
    format!("{head}…{tail}")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KanbanColumnId {
    Todo,
    InProgress,
    /// `alias = "in_review"` accepts the retired In Review column on
    /// deserialize so legacy on-disk JSON loads as Complete. Serialize
    /// always writes `"complete"`, so the next save converges.
    #[serde(alias = "in_review")]
    Complete,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LastRunStatus {
    Running,
    Success,
    Failed,
    /// v1.30.0 (parallel swarms): the linked swarm was aborted by the
    /// user — a deliberate stop, distinct from a genuine `Failed`. Kept
    /// separate so the card badge labels it accurately ("aborted", not
    /// "failed"). Additive variant — legacy cards never carry it.
    Aborted,
    /// v1.31.0 (Cycle 1 — Review surface): the linked swarm's run was
    /// rate-limited / throttled, not genuinely failed. Kept separate so
    /// the card badge reads "Rate-limited" and the card stays
    /// queue-eligible for an auto-retry. Additive variant.
    RateLimited,
}

/// v1.31.0 (Cycle 1 — Review surface): lifecycle of the post-swarm review
/// for a card swarm. `None` until the card is first reviewed. `Merged` is
/// the terminal "landed locally" state; `ConflictBlocked` means a
/// `card_review_merge` hit a real git conflict needing manual resolution;
/// `ChangesRequested` means a reject-with-feedback follow-up swarm is in
/// flight. Additive — legacy cards never carry it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewStatus {
    Pending,
    ChangesRequested,
    ConflictBlocked,
    Merged,
}

/// UX P1 point 7 (P-E): a local ship that stopped on a git conflict.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShipConflict {
    /// The files git reported conflicting, as git names them.
    pub paths: Vec<String>,
    /// The target branch's commit the card's work met (the checkout's HEAD
    /// at the merge, after Ship brought it up to origin).
    pub target_sha: String,
    /// When the ship stopped (ms).
    pub at: i64,
    /// The target branch's name then, for the words ("main changed the
    /// same lines"). Empty on a record without it.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub branch: String,
    /// When Plyloft started merging `target_sha` into the card's copy for
    /// the Builder to resolve (`card_ship_conflict_start`); `None` until
    /// then and after Undo the merge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_started_at: Option<i64>,
    /// 1.170.0 (G6): the conflict was met by Bring in the target's changes
    /// (`card_sync::bring_in`: GitHub's target merged into the card's copy
    /// on the person's press), not by a ship — the words say so, and Undo
    /// the merge drops the record. Absent (false) on every ship's record
    /// and on older ones, and then not written.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sync: bool,
    /// 1.170.0 (G6, Challenger): a bring-in's record — the card's review
    /// status before the press, put back by Undo the merge / Leave the
    /// changes out (`ship_conflict::undo`). Absent on a ship's record and
    /// on older ones, and then not written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_before: Option<ReviewStatus>,
}

/// v1.31.0 (Cycle 1): a reviewer's verdict on one diff hunk.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDecisionStatus {
    Accepted,
    Rejected,
}

/// v1.31.0 (Cycle 1): one persisted per-hunk review verdict. The whole set
/// is cleared when a follow-up swarm linked to the card reaches a terminal
/// state — the diff has moved and `hunk_header` is stale.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDecision {
    pub path: String,
    /// The raw `@@ … @@` header — the hunk's identity within a diff.
    pub hunk_header: String,
    pub status: ReviewDecisionStatus,
    /// Reviewer's feedback; `Some` only when `status == Rejected`.
    #[serde(default)]
    pub feedback: Option<String>,
}

/// v1.7.0: lifecycle state of a card's intake conversation. The intake
/// agent runs in a `RuntimeMode::Repl` PTY and there is no way to
/// re-attach to a dead PTY across an app restart, so any card with
/// `Active` at load time is force-reset to `None` (see `KanbanStore::load`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum IntakeStatus {
    #[default]
    None,
    Active,
    Ready,
}

/// v1.9.0: lifecycle state of a card's verify pipeline. `Legacy` is set
/// during the v1 → v2 migration for cards that were complete before the
/// verify gate existed. `Skipped` is set by the skip-verify ship override
/// (Phase E). New cards default to `None`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum VerifyStatus {
    #[default]
    None,
    Queued,
    Running,
    Passed,
    Failed,
    Skipped,
    Legacy,
}

/// v1.9.0: whether this card's content has been shipped to the installed
/// /Applications/Atelier.app. Migrated to `Shipped` for legacy
/// complete-column cards on the v1 → v2 load.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ShipStatus {
    #[default]
    Unshipped,
    Shipped,
}

/// Where a ship lands.
/// - `Local` (v1.9.0): commit + tag, overwrites /Applications only.
/// - `PushOnly` (v1.13.4): commit + tag + push branch + push tag.
///   Suits deploy-via-push targets like Railway watching a remote
///   branch (LYRA's `staging`). No `skip_verify` guard — caller
///   accepts the trade-off; Railway-style deploys aren't strictly
///   public the way a GitHub release is.
/// - `Github` (v1.9.0, Phase F target): commit + tag + push + the
///   tauri-updater pipeline (Releases API + updater feed).
///   `skip_verify` is rejected by policy — public releases must
///   trace to a verified or legacy build.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseKind {
    Local,
    PushOnly,
    Github,
}

/// v1.9.0: per-step receipt produced by the verify pipeline. Fields are
/// optional so early phases (cargo + ppvp only) can serialize without
/// later phases' shape (Claude-QA screenshots).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyStepResult {
    /// Step kind: "cargo-test" | "ppvp-sh" | "tauri-build" | "claude-qa" | "shell".
    pub kind: String,
    pub passed: bool,
    pub elapsed_ms: u64,
    /// Short reason for failure when `passed == false`. Truncated by callers.
    #[serde(default)]
    pub reason: Option<String>,
}

/// v1.9.0: capped FIFO entry capturing one verify-pipeline run. Written
/// by `verify.rs` (Phase B+); legacy cards have an empty history.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyEntry {
    pub verify_run_id: String,
    pub status: VerifyStatus,
    pub ended_at: i64,
    /// Aggregate one-line summary, e.g. "all 4 steps passed",
    /// "ppvp.sh failed at check #3 (cargo test)".
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub steps: Vec<VerifyStepResult>,
    /// The content this run examined: the git tree of the worktree
    /// (uncommitted edits included), set only when it was the same at start
    /// and end. Ship publishes a flush or recovery commit only when a pass is
    /// recorded against its tree. None on entries written before this field.
    #[serde(default)]
    pub tree_sha: Option<String>,
}

/// v1.9.0: append-only entry recording one ship event for this card. A
/// card can accumulate entries when it gets re-intaken after a prior ship
/// (decision 23 in plan).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipEntry {
    pub commit_sha: String,
    pub shipped_version: String,
    pub release_kind: ReleaseKind,
    pub shipped_at: i64,
    /// 1.171.0 B2: the branch it shipped to, by its name ("main", never
    /// "origin/main") — the card says it after the ship cleared its
    /// `worktree_base`. `None` on older entries and where it wasn't known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// 1.173.0 (B4): the release's tag (`site-v3.0.2` for an area's,
    /// `v1.0.1` without areas), what the card and the Board say. `None` on
    /// older entries, a Land and a merged pull request: those read as
    /// `v<shipped_version>`. Not written while `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
}

/// 1.171.0 B2: the branch a card ships to, by name, from its worktree's
/// start (`WorktreeBase::ref_name`) — read before the ship clears it.
pub fn ship_target_of(card: &KanbanCard) -> Option<String> {
    let name = card.worktree_base.as_ref()?.ref_name.trim();
    let name = name.strip_prefix("origin/").unwrap_or(name);
    (!name.is_empty()).then(|| name.to_string())
}

/// v1.10.0: per-card file attachment. Bytes live under
/// `<app_config>/attachments/<workspace_id>/<card_id>/<uuid>-<safe_name>`;
/// this struct only stores the metadata persisted in the kanban JSON.
/// The `mime_type` is sniffed from the filename extension at add time and
/// is the basis for the Card panel's image-thumbnail eligibility check.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardAttachment {
    pub id: String,
    pub display_name: String,
    pub stored_path: String,
    pub size_bytes: u64,
    #[serde(default)]
    pub mime_type: Option<String>,
    pub added_at: i64,
}

/// v1.106.0 (Builder/Challenger D6/D13/E1): the live Builder session of a
/// card. One vendor per card; the session is a human-attended PTY in the
/// card worktree. `pty_id` is runtime-only — force-cleared on load like
/// `IntakeStatus::Active`, with `session_lost` set so the card can offer
/// Resume (native `--continue` / `codex resume`). Processes are never
/// resurrected (product boundary).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuilderState {
    /// "claude" | "codex" (v1.107.0 adds codex).
    pub vendor: String,
    /// D14: launched with the vendor's permission bypass.
    #[serde(default)]
    pub bypass: bool,
    /// #74: the model this session was spawned on, as the human reads it
    /// ("opus", "gpt-6-astra medium"). None when the Builder row is blank
    /// (the CLI's own default) and on sessions started before #74.
    #[serde(default)]
    pub model: Option<String>,
    /// Live PTY id; None once the session ended or after an app restart.
    #[serde(default)]
    pub pty_id: Option<String>,
    /// True when the session ended without the human closing it (crash,
    /// app restart). Drives "Session lost" + Resume.
    #[serde(default)]
    pub session_lost: bool,
    /// v1.154.1 (F17): the last Resume ended at once (within
    /// `builder::RESUME_QUICK_EXIT_MS`) — usually no conversation to continue
    /// in this worktree; the card points at Start fresh. Cleared by the next
    /// start, resume or close. Serde default: older cards load as false.
    #[serde(default)]
    pub resume_failed: bool,
    #[serde(default)]
    pub started_at: i64,
    /// E1: one entry per "Build done" — the snapshot commit Verify and the
    /// Challenger examine.
    #[serde(default)]
    pub snapshots: Vec<BuildSnapshot>,
    /// v1.108.0 (D7/D8/E2): the Challenger's review of the latest snapshot.
    /// Replaced on every "Build done"; the full record lives in the
    /// reviewer registry (`review_id`).
    #[serde(default)]
    pub review: Option<BuilderReview>,
    /// GH #99: the revision the last *completed* Challenger review read —
    /// kept when a later review fails, so the card can count the commits
    /// nobody reviewed. None before any review completed, and on cards
    /// recorded before GH #99.
    #[serde(default)]
    pub last_reviewed_revision: Option<String>,
    /// GH #99 (review 7): the "Last commit not reviewed by the Challenger"
    /// line as it stood when the card shipped — what the PR body says. A
    /// review that settles after the ship does not change it. None when the
    /// shipped commit was reviewed, before shipping, and before GH #99.
    #[serde(default)]
    pub shipped_unreviewed: Option<String>,
    /// ADR 0006: a review of this card completed with approve or changes
    /// requested, so later reviews are not the sweep — kept on the card,
    /// because the reviewer records are capped and old ones are evicted.
    /// False on cards recorded before it (their records still say).
    #[serde(default)]
    pub first_review_done: bool,
    /// ADR 0006: changes-requested verdicts this card received. From the
    /// fourth, the Ship step offers `Ship with follow-up`. 0 on cards
    /// recorded before it.
    #[serde(default)]
    pub changes_requested_count: u32,
    /// GH #104: corrections the human typed into the Builder session **after
    /// its first answer** — one of the three conditions the improvement
    /// proposal's friction rule reads (`proposals::met_friction`).
    ///
    /// Counted by the window, because that is the only place the human's
    /// keystrokes exist: the Builder is the vendor's own TUI in a PTY and Ply
    /// keeps no transcript of it. `BuilderSession`'s `onData` is the human's
    /// hand and nothing else — Ply's own injections go through `ptyWrite`
    /// directly — so one submission there, once the session has come back to
    /// its prompt at least once, is one correction. 0 on cards recorded before
    /// this, which reads as "no correction", the safe way round: a card with
    /// no record of one proposes nothing.
    #[serde(default)]
    pub user_corrections: u32,
    /// GH #104 walk (B3): the words of the last corrections counted in
    /// `user_corrections`, oldest first — what the improvement proposal's
    /// Challenger reads as the human's side, so a proposal never goes against
    /// a rule the human typed. Local to this card, bounded
    /// (`CORRECTION_TEXTS_MAX` entries of at most `CORRECTION_TEXT_MAX`
    /// bytes). Empty on cards recorded before it.
    #[serde(default)]
    pub correction_texts: Vec<String>,
    /// GH #104 walk (B3): how each changes-requested round ended, as the human
    /// or the Builder settled it — the pushback accepted, or the code changed
    /// in a new snapshot. Oldest first, bounded (`REVIEW_DECISIONS_MAX`).
    /// Empty on cards recorded before it.
    #[serde(default)]
    pub review_decisions: Vec<RequestDecision>,
    /// ADR 0006: the card `Ship with follow-up` made for this card's open
    /// findings. Set as soon as it exists, so a ship that fails and is tried
    /// again never makes a second one. None otherwise.
    #[serde(default)]
    pub follow_up: Option<FollowUpCard>,
    /// ADR 0006 (third card): the Builder's self-check at the last Build
    /// done that ran one — how it ended and how long it took. None when the
    /// switch is off, before the first, and on cards recorded before it.
    #[serde(default)]
    pub self_check: Option<SelfCheckRecord>,
    /// GH #124: a Build done that came while the Challenger was still
    /// reviewing this card — the snapshot reviewed next, once that review
    /// ends. A newer one replaces it; there is never a queue. Kept on the
    /// card so it survives a close and a restart. None otherwise, and on
    /// cards recorded before it.
    #[serde(default)]
    pub waiting_review: Option<WaitingReview>,
    /// GH #129: a request for changes the Builder has not received. When a
    /// review asking for changes hands the card straight to the review
    /// that waited for it, its verdict is never sent: the follow-up quotes
    /// the open findings and its own verdict carries them. Kept until a
    /// later review gives a verdict; while none has (it failed, was
    /// interrupted, incomplete), the card names what is still owed and
    /// Ship says it. None otherwise, and on cards recorded before it.
    #[serde(default)]
    pub handed_over: Option<HandedOverRequest>,
    /// GH #135: the settled Challenger review whose verdict has not reached
    /// the Builder. A verdict used to be injected only by the Run step
    /// while it was mounted, so a review that settled with the card closed
    /// was never sent and the loop looked stuck. Recorded when the review
    /// settles, cleared when the Builder receives it (or when a newer
    /// review replaces it). None otherwise, and on cards recorded before it.
    #[serde(default)]
    pub undelivered_verdict: Option<UndeliveredVerdict>,
    /// CL-5: every review round the ledger folded for this card, oldest
    /// first — what Activity lists as "Round 2 · Codex · nothing blocking".
    /// Kept on the card because the reviewer records are capped across all
    /// cards and the ledger prunes old closed findings. One entry per
    /// folded review (keyed by its record); failed, interrupted and skipped
    /// reviews are not rounds. Bounded (`REVIEW_ROUNDS_MAX`). Empty on cards
    /// recorded before it, and left out of the file while empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub review_rounds: Vec<ReviewRound>,
    /// CL-8 round 2: the model chosen for this card when it was built by
    /// both — the picked build's — so every later Resume / Start fresh of
    /// this card's Builder runs on it rather than the workspace's row.
    /// `None` on every other card (and before CL-8): the row decides.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chosen_model: Option<crate::build_both::LaneModel>,
    /// UX P-F (UX P1 point 8): the id a Claude Builder was started with
    /// (`--session-id`), so its own transcript — never a Challenger's in the
    /// same folder — tells a usage limit reached mid-turn
    /// (`builder::transcript_usage_limit`), and Resume continues it by id
    /// (`--resume`). `None` for Codex and on cards started before P-F: those
    /// resume with `--continue` and their mid-turn limit is not read until
    /// the next Start fresh. Serde default; left out of the file while unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_session_id: Option<String>,
    /// UX P-C (UX_P1 point 5): the permission mode this session was started
    /// in — only ever `builder::GUIDED_PERMISSION_MODE` ("acceptEdits"),
    /// granted by Rust to the unedited guided first card while its guide
    /// runs (`builder::guided_permission_mode`). Resume keeps it; a new
    /// session decides again. `None` = the default permissions (every other
    /// card, cards built by both, and every record written before P-C).
    /// Left out of the file while `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    /// 1.171.0 (D1): the choice this session was started in (the card's,
    /// else the Settings default), so Resume runs it again in the same mode
    /// (`builder::resumed_mode`), and Start fresh on the same AI keeps it
    /// (`builder::card_choice`). `None` on every session started before D1,
    /// and on the tour card's own bounded start: those keep today's rule
    /// (`bypass`, `permission_mode`). Left out of the file while `None`; an
    /// unknown value reads as `None`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::settings::lenient_opt"
    )]
    pub permissions: Option<crate::settings::BuilderPermissions>,
    /// 1.169.0 (A3): the session was lost because Plyloft quit or restarted
    /// (set by the launch cleanup, cleared by the next start or resume) —
    /// Resume's case, not "Retry on…"'s. A session that ended on its own
    /// while the app ran leaves it false. Left out of the file while false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub lost_on_restart: bool,
    /// 1.171.0 C2: when Finish and check asked the Builder for its
    /// self-check (`builder_self_check_message`), until that Finish and
    /// check goes on (`builder::done` clears it, whatever the self-check's
    /// outcome). The run itself is the window's, in memory: one Plyloft
    /// quit during (or a session that ended during it) leaves this behind,
    /// so the card says what happened and offers Finish and check again
    /// instead of waiting for good. Cleared by the next start or resume.
    /// `None` on every record before it; left out of the file while `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub self_check_started_at: Option<i64>,
    /// 1.175.0 (F6, UX-6): the pull request draft asked of this session
    /// while the Reviewer reviews (`pr_draft.rs::PrDraftRecord`): the
    /// request, the commit it is about, when. A Ship of that same commit uses
    /// it, after a relaunch too; any other commit's is refused. Not written
    /// while `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_draft: Option<crate::pr_draft::PrDraftRecord>,
}

/// CL-5: how many review rounds a card keeps; the oldest go first.
pub const REVIEW_ROUNDS_MAX: usize = 100;

/// CL-5: one completed review round of a card, in counts.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ReviewRound {
    /// The round as the card numbers it: the ledger's round while the
    /// card's ledger is the one it started with, and after a ledger that
    /// started over (its records evicted, `reviewer::prune_ledgers`) the
    /// card's own sequence goes on. A jump from the previous round is a
    /// round that was not recorded; Activity says so.
    pub round: u32,
    /// CL-5 (round 2): the ledger's own round number, the `round` of the
    /// findings it raised. Equal to `round` until a ledger starts over.
    pub ledger_round: u32,
    /// CL-5 (round 2): the ledger started over at this round, so the ids of
    /// every round before it name findings of a ledger that is gone (and
    /// may be reused). Left out of the file while false.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub ledger_restart: bool,
    /// CL-5 (round 3): the rounds before this one were recorded and later
    /// dropped by the `REVIEW_ROUNDS_MAX` cap. Left out of the file while
    /// false.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub trimmed_before: bool,
    /// "approve" | "changes_requested" | "incomplete".
    pub verdict: String,
    /// Blocking findings raised for the first time.
    pub new: u32,
    /// Non-blocking findings raised for the first time.
    #[serde(skip_serializing_if = "is_zero")]
    pub notes: u32,
    /// Earlier findings this round closed.
    pub closed: u32,
    /// Blocking findings of earlier rounds still open after it.
    pub still_open: u32,
    /// CL-5 (round 2): the ids behind the counts, as the fold saw them:
    /// what "See its findings" shows. `new_ids` holds the notes too.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub new_ids: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub closed_ids: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub still_open_ids: Vec<String>,
    pub at: i64,
    /// "claude" | "codex" — the vendor that reviewed.
    pub provider: String,
    /// The reviewer record; what makes recording a round idempotent.
    pub review_id: String,
    pub snapshot_n: u32,
    /// 1.169.0 (A3): the model the round reviewed on, as recorded
    /// (`BuilderReview::model`); absent with the tool's default and on
    /// rounds recorded before it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// 1.169.0 (A3): how many "Retry on…" records a card keeps.
pub const MODEL_RETRIES_MAX: usize = 20;

/// 1.169.0 (A3): one "Retry on…" of a round.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelRetry {
    /// "builder" | "challenger".
    pub role: String,
    /// "claude" | "codex".
    pub vendor: String,
    /// When the retry started.
    pub at: i64,
    /// When the attempt it retried started (a Builder session's start).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_started_at: Option<i64>,
    /// The attempt it retried ran on (its recorded label), when it said.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_model: Option<String>,
    /// How that attempt ended: `finished`, `stopped`, `ended`, `failed`, or
    /// a review's verdict.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_outcome: Option<String>,
    /// The model and effort it was retried on, as a label; absent = the
    /// tool's default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// How the retry itself ended, once it has; absent while it runs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
}

fn is_zero_u8(n: &u8) -> bool {
    *n == 0
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// GH #104 walk (B3): how many corrections' words a card keeps.
pub const CORRECTION_TEXTS_MAX: usize = 5;
/// GH #104 walk (B3): the most of one correction a card keeps, in bytes.
pub const CORRECTION_TEXT_MAX: usize = 500;
/// GH #104 walk (B3): how many settled changes-requested rounds a card keeps.
pub const REVIEW_DECISIONS_MAX: usize = 20;

/// GH #104 walk (B3): how one changes-requested round was settled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestOutcome {
    /// The human accepted the Builder's pushback: the code stayed as it was,
    /// and the Challenger's request was overruled.
    PushbackAccepted,
    /// The Builder changed the code: a new snapshot was recorded over the
    /// request.
    BuilderChanged,
}

/// GH #104 walk (B3): one changes-requested round and how it ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestDecision {
    /// The snapshot whose review asked for changes.
    pub snapshot_n: u32,
    pub outcome: RequestOutcome,
    /// `BuilderChanged`: the snapshot that answered it.
    #[serde(default)]
    pub next_snapshot_n: Option<u32>,
    /// `PushbackAccepted`: who pressed it, when the card says.
    #[serde(default)]
    pub by: Option<String>,
    #[serde(default)]
    pub at: i64,
}

impl BuilderState {
    /// GH #104 walk (B3): keep the words of one counted correction, bounded.
    pub fn remember_correction(&mut self, text: &str) {
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        let mut end = text.len().min(CORRECTION_TEXT_MAX);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let kept = if end < text.len() {
            format!("{}…", text[..end].trim_end())
        } else {
            text.to_string()
        };
        self.correction_texts.push(kept);
        if self.correction_texts.len() > CORRECTION_TEXTS_MAX {
            let drop = self.correction_texts.len() - CORRECTION_TEXTS_MAX;
            self.correction_texts.drain(0..drop);
        }
    }

    /// CL-5: record the round a settled review was, once. A review the
    /// ledger did not fold (failed, interrupted, skipped, unstructured) has
    /// no round and adds nothing; the same review settling again (a retried
    /// write, a reload, an override of it) adds nothing either.
    pub fn remember_round(&mut self, review: &BuilderReview) {
        let (Some(counts), Some(review_id)) = (review.round.as_ref(), review.review_id.as_deref()) else {
            return;
        };
        let Some(verdict) = review.verdict.as_deref() else {
            return;
        };
        if review.status != "done" || self.review_rounds.iter().any(|r| r.review_id == review_id) {
            return;
        }
        // A ledger round at or below the last one recorded: the ledger
        // started over. The card's numbering goes on from its own last
        // round; within one ledger a jump stays a jump.
        let (round, ledger_restart) = match self.review_rounds.last() {
            None => (counts.round.max(1), false),
            // A round stored before `ledger_round` existed loads it as 0:
            // its ledger round was its round.
            Some(last) => {
                let last_ledger = if last.ledger_round == 0 { last.round } else { last.ledger_round };
                if counts.round <= last_ledger {
                    (last.round + 1, true)
                } else {
                    (last.round + (counts.round - last_ledger), false)
                }
            }
        };
        self.review_rounds.push(ReviewRound {
            round,
            ledger_round: counts.round,
            ledger_restart,
            trimmed_before: false,
            verdict: verdict.to_string(),
            new: counts.new,
            notes: counts.notes,
            closed: counts.closed,
            still_open: counts.still_open,
            new_ids: counts.new_ids.clone(),
            closed_ids: counts.closed_ids.clone(),
            still_open_ids: counts.still_open_ids.clone(),
            at: review.at,
            provider: review.provider.clone(),
            review_id: review_id.to_string(),
            snapshot_n: review.snapshot_n,
            model: review.model.clone(),
        });
        if self.review_rounds.len() > REVIEW_ROUNDS_MAX {
            let drop = self.review_rounds.len() - REVIEW_ROUNDS_MAX;
            self.review_rounds.drain(0..drop);
            // Activity says the rounds before it are no longer kept, not
            // that they were never recorded.
            self.review_rounds[0].trimmed_before = true;
        }
    }

    /// GH #104 walk (B3): record how a changes-requested round ended, bounded.
    pub fn remember_decision(&mut self, decision: RequestDecision) {
        self.review_decisions.push(decision);
        if self.review_decisions.len() > REVIEW_DECISIONS_MAX {
            let drop = self.review_decisions.len() - REVIEW_DECISIONS_MAX;
            self.review_decisions.drain(0..drop);
        }
    }
}

/// GH #135: which settled review's verdict the Builder is still owed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UndeliveredVerdict {
    /// The build snapshot the review read.
    pub snapshot_n: u32,
    /// `BuilderReview.at` of that review — which verdict this is, so a
    /// delivery of an older one never clears a newer one.
    pub at: i64,
}

/// GH #129: the request for changes a hand-over left unsent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HandedOverRequest {
    /// The build snapshot whose review asked for changes.
    pub snapshot_n: u32,
    /// The open blocking findings of the card's ledger, by id.
    pub finding_ids: Vec<String>,
    /// What the Builder is sent: those findings, as a follow-up quotes
    /// them (`review_ledger::open_block`), or the review's own hand-off
    /// when it kept no ledger.
    pub handoff: String,
    /// When the hand-over happened (ms).
    pub at: i64,
}

/// GH #124: the review a Build done asked for while another review of the
/// same card was running.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WaitingReview {
    /// The build snapshot to review.
    pub snapshot_n: u32,
    /// When Build done asked for it (ms).
    pub requested_at: i64,
}

/// ADR 0006 (third card): how a self-check ended.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SelfCheckOutcome {
    /// The Builder answered and was back at its prompt.
    #[default]
    Answered,
    /// The human pressed Skip.
    Skipped,
    /// The Builder was not back within `builder::SELF_CHECK_TIMEOUT_SECS`.
    TimedOut,
}

/// ADR 0006 (third card): one self-check, as the card keeps it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SelfCheckRecord {
    pub outcome: SelfCheckOutcome,
    pub started_at: i64,
    pub duration_ms: i64,
    /// The snapshot Build done took after it.
    pub snapshot_n: Option<u32>,
}

/// N19: one end of the link between a shipped card and a card made to
/// follow it up (`KanbanCard::follows_up`, `KanbanCard::followed_up_by`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardFollowLink {
    /// The other card's id (same workspace).
    pub card_id: String,
    /// The other card's title when the link was made — what the page says
    /// once that card is deleted.
    pub title: String,
    /// When the follow-up card was made.
    pub at: i64,
}

/// N19: the line a follow-up card's brief opens with, for the person to
/// finish (the frontend's `FOLLOW_UP_ASK`, trimmed).
pub const FOLLOW_UP_ASK: &str = "What should change now:";

/// N19: the refusal of a start while that line is unfinished — the same
/// words the card page says (`followUp.ts::FOLLOW_UP_ASK_EMPTY`).
pub const FOLLOW_UP_ASK_EMPTY: &str = "Say what should change first.";

/// N19: a follow-up card in To do whose brief's first line is still the
/// bare ask (`followUp.ts::followUpAskEmpty`).
pub fn follow_up_ask_empty(card: &KanbanCard) -> bool {
    card.follows_up.is_some()
        && !card.archived
        && card.column_id == KanbanColumnId::Todo
        && card.notes.as_deref().unwrap_or("").lines().next().unwrap_or("").trim_end() == FOLLOW_UP_ASK
}

/// 1.174.0 C4 (P17): the refusal of a start while a card made from a copy
/// has no brief — the words beside its Start build
/// (`cardPresentation.ts::COPY_BRIEF_EMPTY`).
pub const COPY_BRIEF_EMPTY: &str = "Say what the Builder should do first.";

/// C4: a card made from a copy, in To do, whose brief is still empty
/// (`cardPresentation.ts::copyBriefEmpty`).
pub fn copy_brief_empty(card: &KanbanCard) -> bool {
    card.from_copy.is_some()
        && !card.archived
        && card.column_id == KanbanColumnId::Todo
        && card.notes.as_deref().unwrap_or("").trim().is_empty()
}

/// N19: the refusal `Follow up` gets on a card that has not shipped.
pub const FOLLOW_UP_NOT_SHIPPED: &str =
    "Only a shipped card can be followed up — this one hasn't shipped.";

/// ADR 0006: the card that carries a shipped card's open findings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FollowUpCard {
    pub card_id: String,
    /// How the PR body and the receipt name it: "#140", or its title in
    /// quotes on a board without issues.
    pub card_ref: String,
    /// The finding ids it carries.
    pub finding_ids: Vec<String>,
    /// The ship went through with it (the PR body carries its line).
    pub shipped: bool,
}

/// v1.109.0: the human's decision on one disagreement-ledger entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanDecision {
    pub disagreement_id: String,
    pub statement: String,
    pub decision: String,
}

/// v1.109.0: a card's Plan challenge record (see `PlanDecision`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanChallenge {
    pub discussion_id: String,
    pub challenged_at: i64,
    pub brief: String,
    #[serde(default)]
    pub decisions: Vec<PlanDecision>,
}

/// v1.108.0: state of the Challenger's diff review for one build snapshot.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuilderReview {
    pub snapshot_n: u32,
    /// "claude" | "codex" — the vendor that reviewed.
    pub provider: String,
    /// E2: true when the review had to run with the Builder's own vendor
    /// because the other one was unavailable.
    #[serde(default)]
    pub degraded: bool,
    /// OB-14 (§13.2): the same-vendor review ran because the other vendor
    /// isn't installed on this machine at all — one AI is a normal setup,
    /// not a fault, so the card says "reviewed by a separate session"
    /// instead of "the other vendor was unavailable". Always with
    /// `degraded`. False on reviews recorded before OB-14, which read as
    /// they always did.
    #[serde(default)]
    pub single_vendor: bool,
    /// "running" | "done" | "failed" | "skipped".
    pub status: String,
    /// "approve" | "changes_requested" | "incomplete" once done and
    /// parseable. GH #58: "incomplete" — the reviewer could not see enough
    /// of the change to judge it — is its own outcome: it does not request
    /// changes and does not block Ship; "Review again in passes" re-runs it.
    #[serde(default)]
    pub verdict: Option<String>,
    #[serde(default)]
    pub review_id: Option<String>,
    /// Bounded copy of the reviewer's markdown for Outcome and injection.
    #[serde(default)]
    pub excerpt: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    pub at: i64,
    /// The human's decision recorded on a `skipped` review, e.g. "changes
    /// requested on snapshot 5, overridden by the human". None on reviews
    /// written before the override existed and on plain skips.
    #[serde(default)]
    pub note: Option<String>,
    /// Identity (settings email) of the human who overrode a
    /// changes-requested verdict; `at` is when. None when unknown.
    #[serde(default)]
    pub overridden_by: Option<String>,
    /// GH #58: passes the complete diff was reviewed in. None on reviews
    /// before passes existed, and while running.
    #[serde(default)]
    pub pass_count: Option<u32>,
    /// GH #58: files in the reviewed diff.
    #[serde(default)]
    pub file_count: Option<u32>,
    /// GH #58: why an "incomplete" verdict is incomplete, e.g. "diff too
    /// large" or "pass 2 of 3 failed".
    #[serde(default)]
    pub incomplete_reason: Option<String>,
    /// #74: the model the Challenger reviewed on ("gpt-6-astra medium").
    /// None when its row is blank, and on reviews recorded before #74.
    #[serde(default)]
    pub model: Option<String>,
    /// GH #99: the commit the review read (the reviewer record's
    /// `reviewed_revision`). A verdict belongs to this revision. None while
    /// running, when the review failed before pinning one, and on reviews
    /// recorded before GH #99 (the snapshot's sha stands in).
    #[serde(default)]
    pub reviewed_revision: Option<String>,
    /// GH #99: a failed review's reason in words ("The Challenger's model
    /// was at capacity."); `error` keeps the raw text. While `retry_at` is
    /// set, the reason for the retry.
    #[serde(default)]
    pub failure_reason: Option<String>,
    /// GH #99: while running, the provider failed for a reason that passes
    /// with time and the one automatic retry starts at this time (ms).
    #[serde(default)]
    pub retry_at: Option<i64>,
    /// GH #99: the review used its automatic retry.
    #[serde(default)]
    pub retried: bool,
    /// GH #99: on a failed review, commits between the last completed
    /// review's revision and the commit this one should have read. None
    /// when no review ever completed or it could not be counted.
    #[serde(default)]
    pub commits_since_review: Option<u32>,
    /// GH #99 (review 1): on a done review, passes that failed even after
    /// the retry — their files were not reviewed, whatever the merged
    /// verdict says. None when every pass completed, and before GH #99.
    #[serde(default)]
    pub failed_passes: Option<u32>,
    /// ADR 0006: `sweep` for the card's first review, `review` after. Set
    /// when the review starts, so the Run step can say a sweep takes
    /// minutes. Reviews recorded before ADR 0006 load as `review`.
    #[serde(default)]
    pub kind: crate::review_passes::ReviewKind,
    /// ADR 0006: the sweep ran a synthesis pass after its passes.
    #[serde(default)]
    pub synthesis_pass: bool,
    /// ADR 0006: P1 and P2 findings — what the verdict is about.
    #[serde(default)]
    pub findings: Vec<crate::review_passes::ReviewFinding>,
    /// ADR 0006: P3 and pre-existing findings. They never block and are
    /// never sent to the Builder as changes requested.
    #[serde(default)]
    pub non_blocking: Vec<crate::review_passes::ReviewFinding>,
    /// ADR 0006: the reviewer's risk checklist, one line per class.
    #[serde(default)]
    pub checklist: Vec<String>,
    /// The passes that failed by name ("pass 2 of 3", "the synthesis
    /// pass"), so the card says which.
    #[serde(default)]
    pub failed_pass_names: Vec<String>,
    /// The review holds findings Ply could not read into `findings`: the
    /// Builder gets the reviewer's own words with the structured list.
    #[serde(default)]
    pub findings_unread: bool,
    /// On a request for changes, the complete message for the Builder:
    /// every blocking finding in full, independent of the card's display
    /// caps. None on other verdicts and on reviews before it existed.
    #[serde(default)]
    pub builder_handoff: Option<String>,
    /// ADR 0006 (follow-up card): why a follow-up review ran as a sweep.
    #[serde(default)]
    pub follow_up_fallback: Option<String>,
    /// Review integrity: why the reviewed range's base is not the plain one
    /// checked against origin's real tip (origin unreachable, a local ref
    /// ahead of origin not used). None otherwise and on reviews before it;
    /// left out of the file then, so an older card re-saves as it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_note: Option<String>,
    /// ADR 0006 (follow-up card): why Ply requests changes although the
    /// reviewer wrote otherwise — earlier findings still open.
    #[serde(default)]
    pub ledger_note: Option<String>,
    /// ADR 0006 (follow-up card): the card's findings ledger as this review
    /// left it — every finding with its id, state and round. Empty on
    /// reviews before it.
    #[serde(default)]
    pub ledger: Vec<crate::review_ledger::LedgerFinding>,
    /// CL-2: the skills the Challenger says it followed (GH #216), shown
    /// as chips. Empty on reviews before CL-2 — the card reads those from
    /// the excerpt's `Followed:` line — and left out of the file while
    /// empty, so an older card re-saves byte-for-byte as it was.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills_followed: Vec<crate::review_answer::SkillFollowed>,
    /// CL-5: the ledger round this review was folded in as, with its
    /// counts. None while running, on reviews the ledger did not fold, and
    /// on reviews before CL-5; left out of the file then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub round: Option<crate::review_ledger::RoundCounts>,
    /// Findings filter: the review did not read everything it was given (a
    /// failed or incomplete pass, or an INCOMPLETE the ledger read as a
    /// request), so a dismissal never turns it into an approval. False on
    /// reviews before it, and left out of the file then.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub partial: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSnapshot {
    pub n: u32,
    pub sha: String,
    pub at: i64,
}

/// 1.173.0 A3: where a card made from a copy came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardFromCopy {
    /// The copy's id (`copy-<short8>`).
    #[serde(default)]
    pub id: String,
    /// The person's name for it.
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanCard {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    #[serde(default)]
    pub notes: Option<String>,
    /// v0.8.0: longer-form context attached to the card. Appended to the
    /// card-driven agent prompt after `notes`. Optional; null on legacy cards.
    #[serde(default)]
    pub knowledge: Option<String>,
    pub column_id: KanbanColumnId,
    #[serde(default)]
    pub agent_config_id: Option<String>,
    #[serde(default)]
    pub linked_run_id: Option<String>,
    #[serde(default)]
    pub last_run_status: Option<LastRunStatus>,
    /// v1.0: Swarm. When set, dragging Todo→In Progress kicks off a swarm
    /// (via `SwarmRegistry::swarm_start`) instead of a single agent run. Mutually
    /// exclusive with `agent_config_id` at the UI level (see SWARM_DESIGN §11.3).
    #[serde(default)]
    pub swarm_template_id: Option<String>,
    /// v1.0: Swarm. Mirrors `linked_run_id` for the swarm path. Set when a
    /// swarm starts from this card; cleared by orphan reconciliation if Atelier
    /// crashes mid-swarm.
    #[serde(default)]
    pub linked_swarm_id: Option<String>,
    /// v1.26.0 (Cycle H): durable pointer to the brainstorm swarm
    /// launched from this card's detail panel (`BrainstormModal` with
    /// linkedCardId set). Separate from `linked_swarm_id` because the
    /// kanban moveCard flow overwrites `linked_swarm_id` on dispatch —
    /// sharing would orphan the brainstorm. Powers the
    /// `LinkedBrainstormBanner` in `CardDetailPanel` and the
    /// `PromoteButton`'s cross-restart fallback.
    #[serde(default)]
    pub linked_brainstorm_id: Option<String>,
    /// v1.27.0 (Cycle H phase 2): banner keys the user has dismissed.
    /// Format: `<kind>:<id>` strings (e.g. `brainstorm:swarm-abc`).
    /// FE-only field — no backend writer races this, so the
    /// whole-workspace persist path in `kanbanStore.updateCard` is safe.
    /// Cap at 16 entries (FIFO eviction on add).
    #[serde(default)]
    pub dismissed_banners: Vec<String>,
    /// v1.5.x: system-managed FIFO of run receipts. Written exclusively by
    /// the PTY exit listener (oneshot) and `on_swarm_run_done` (swarm
    /// terminal). Never read into a future run's prompt — see PATTERNS.md.
    #[serde(default)]
    pub run_history: Vec<RunHistoryEntry>,
    /// v1.5.x: per-card opt-out. When true, `append_run_history` is a no-op
    /// for this card.
    #[serde(default)]
    pub suppress_run_history: bool,
    /// v1.106.0: the live Builder session (Builder/Challenger model). None
    /// on legacy cards and on cards run through the swarm path.
    #[serde(default)]
    pub builder: Option<BuilderState>,
    /// v1.109.0 (D5/D10/D15): the Plan challenge — a Discussion on this
    /// card's brief plus the human's decisions on its disagreement ledger.
    /// Travels into the Builder prompt. `brief` is the brief as it read when
    /// the decisions were saved, so a later edit shows as stale.
    #[serde(default)]
    pub plan_challenge: Option<PlanChallenge>,
    /// v1.7.0: finalized prompt produced by the intake conversation. When
    /// present, replaces the legacy `title + notes + knowledge` concat as
    /// the dispatch prompt for card-driven runs (`kanbanStore.moveCard`).
    /// Never overwrites user-edited title/notes/knowledge.
    #[serde(default)]
    pub dispatch_prompt: Option<String>,
    /// v1.7.0: unix-ms set when the user manually edits `dispatch_prompt`
    /// after an intake finished. Null when never edited or freshly
    /// populated by intake. Drives the "edited since intake" UI marker.
    #[serde(default)]
    pub dispatch_prompt_edited_at: Option<i64>,
    /// v1.7.0: intake conversation lifecycle state. `Active` is force-reset
    /// to `None` on `KanbanStore::load` — no surviving PTY can be
    /// re-attached after an app restart.
    #[serde(default)]
    pub intake_status: IntakeStatus,
    /// v1.19.0 (Cycle E4): append-only history of intake sessions. Each
    /// entry captures the dispatch_prompt produced by an intake plus a
    /// path to the saved transcript. FIFO-capped at `MAX_INTAKE_HISTORY`
    /// (10) — evicting an entry deletes its transcript file.
    #[serde(default)]
    pub intake_history: Vec<IntakeRecord>,
    /// v1.8.0: one-way soft-archive flag for cards in the Complete column.
    /// Archived cards are hidden from the main column body and surfaced
    /// only inside the collapsible "Archived (N)" disclosure. There is
    /// intentionally no UI to un-archive — the data is preserved but the
    /// user has chosen to declutter the Complete column.
    #[serde(default)]
    pub archived: bool,
    /// UX-5.8: when the card was last archived (unix ms). Kept when the card
    /// is restored, which is what stops the auto-archive from taking a card
    /// the person brought back. `None` on cards never archived since C5 —
    /// including every card archived before it. Additive, no schema bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<i64>,
    /// UX-5.8: Ply archived it on its own (shipped more than
    /// `AUTO_ARCHIVE_AFTER_MS` ago), so the archive offers Restore. `false`
    /// on every card before it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub auto_archived: bool,
    /// N14 walk F19: when the card was put back in To do (unix ms), oldest
    /// first, capped at `MAX_PUT_BACKS` — one Activity row each. Empty on
    /// every card before it. Additive, no schema bump.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub put_backs: Vec<i64>,
    /// v1.9.0 (Phase D+): markdown doc the builder writes during the swarm
    /// describing what this card changed and what the QA agent should
    /// specifically check. Optional in Phase A — populated once the
    /// builder-completion step ships. Read by the verify pipeline.
    #[serde(default)]
    pub verify_intent: Option<String>,
    /// v1.9.0: lifecycle state of the verify pipeline for this card.
    #[serde(default)]
    pub verify_status: VerifyStatus,
    /// v1.9.0: capped FIFO of verify-pipeline receipts. Written exclusively
    /// by `verify.rs` (Phase B+). Empty on legacy cards.
    #[serde(default)]
    pub verify_history: Vec<VerifyEntry>,
    /// v1.9.0: whether this card's changes are live in
    /// /Applications/Atelier.app.
    #[serde(default)]
    pub ship_status: ShipStatus,
    /// v1.9.0: append-only history of every ship that included this card.
    /// Multi-iteration cards (re-intake after ship) accumulate entries.
    #[serde(default)]
    pub ship_history: Vec<ShipEntry>,
    /// v1.9.0: most recent per-card commit SHA, written by the ship
    /// pipeline when the working tree is committed. Hooks for future
    /// rollback UX.
    #[serde(default)]
    pub commit_sha: Option<String>,
    /// v1.9.0: most recent version tag this card was shipped under
    /// (e.g. "v1.9.3", or "v1.9.3-unverified" for skip-verify ships).
    #[serde(default)]
    pub shipped_version: Option<String>,
    /// v1.10.0: file attachments belonging to this card. Bytes live on
    /// disk under `<app_config>/attachments/<workspace>/<card>/`; this
    /// vec carries the metadata that the FE renders and that the
    /// dispatch + intake prompt-concat paths read for absolute paths.
    #[serde(default)]
    pub attachments: Vec<CardAttachment>,
    /// v1.10.0 (Cycle A — worktrees): absolute path to this card's git
    /// worktree, populated by the lifecycle hook on Todo→InProgress.
    /// `None` until the card transitions, after a worktree was pruned,
    /// or on cards from before the worktree feature shipped.
    #[serde(default)]
    pub worktree_path: Option<String>,
    /// v1.10.0 (Cycle A): branch name captured at worktree-create time
    /// (`plyloft/card-<short_id>-<slug>`; `atelier/card-…` before SP-7). Slug is derived from the
    /// title at create time and is NOT renamed if the title later
    /// changes — branches are stable identifiers.
    #[serde(default)]
    pub branch_name: Option<String>,
    /// The commit this card's worktree branched from — normally the
    /// freshly fetched `origin/<target>` head, the local target branch when
    /// offline / ahead / without a remote. Captured with `worktree_path`
    /// and cleared with it; shown in the card header. `None` on legacy
    /// cards and on worktrees created before cards fetched first.
    #[serde(default)]
    pub worktree_base: Option<crate::worktrees::WorktreeBase>,
    /// v1.31.0 (Cycle 1 — Review surface): lifecycle of this card's
    /// post-swarm review. `None` until the card is first reviewed.
    #[serde(default)]
    pub review_status: Option<ReviewStatus>,
    /// UX P1 point 7 (P-E): what the last local ship's conflict was — the
    /// files and the target commit it met — recorded by the land that
    /// stopped (`land_card_local`), because the rollback leaves nothing to
    /// read later. "Ask the Builder to resolve it" merges exactly that
    /// commit. Kept only beside `ConflictBlocked`: cleared with it (a new
    /// round, a ship that lands, any other review status). Absent on every
    /// other card and on every card before it, and then not written: an old
    /// board loads unchanged. Additive `#[serde(default)]`, no schema bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ship_conflict: Option<ShipConflict>,
    /// v1.31.0 (Cycle 1): persisted per-hunk review verdicts so an
    /// in-progress review survives a panel close / app restart. Cleared on
    /// a linked follow-up swarm's terminal completion.
    #[serde(default)]
    pub review_decisions: Vec<ReviewDecision>,
    /// v1.31.0 (Outcome screen, Phase 3): the GitHub PR URL when the card
    /// was shipped as a pull request. `None` for cards landed by local
    /// merge or not yet shipped.
    #[serde(default)]
    pub pr_url: Option<String>,
    /// SL-1 (ship loop): what Plyloft last read of that pull request on
    /// GitHub — open/merged/closed, its checks on GitHub (not Plyloft's own
    /// Checks), review decision, conflict (`pr_status::PrStatus`). Set when
    /// `card_ship` opens the PR, refreshed by the poller and the card page.
    /// `None` on every card before it (a PR shipped before SL-1 included),
    /// and then not written: an old board loads unchanged. Additive
    /// `#[serde(default)]`, no schema bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr: Option<crate::pr_status::PrStatus>,
    /// v1.39.0 (Recon-fork cycle, Increment 2): the id of the recon card
    /// this card was forked from via `kanban_card_fork_to_implementation`.
    /// `None` for non-forked cards (the default for every card created
    /// before v1.39.0 and every card created via the regular create-card
    /// path). The link is flat — chain forks do not transit through this
    /// field. Increment 3's link UX renders direct parent / direct
    /// children only.
    #[serde(default)]
    pub parent_card_id: Option<String>,
    /// v1.49.0 (Team Mode Phase 0): provenance. `author` is stamped at
    /// card-create-time and stays stable across edits — it identifies who
    /// originated the work item. `last_edited_by` is rewritten on every
    /// user-driven patch (`patch_card`) but NOT on system-driven
    /// mutations (run history append, ship state update, swarm hooks):
    /// those are mechanical book-keeping and don't represent a person's
    /// edit. Both fields are `None` on legacy cards and on cards created
    /// before identity was configured.
    /// v1.57.0 (Cycle 3 — GitHub Issues backing): the GitHub issue number
    /// this card mirrors, when the workspace's `kanban_sync_mode` is
    /// `GitHubIssues`. `None` for local-only cards (and all legacy cards).
    /// Purely-local fields (run state, worktree, ship, review) are never
    /// written back to the issue — only title/notes/knowledge round-trip.
    #[serde(default)]
    pub gh_issue_number: Option<u64>,
    /// v1.57.0 (Cycle 3 — increment 3a): a local edit (create/title/notes/
    /// knowledge/column) that has not yet been mirrored to the backing
    /// GitHub issue — set when an issue-sync hook fails or the user is
    /// offline. The next reconcile/Sync retries (push-then-pull) and clears
    /// it. While `true`, reconcile's pull does NOT overwrite this card's
    /// GitHub-owned fields, so an unpushed local edit is never clobbered.
    /// Backend-owned (never in `CardPatch`); `false` for every legacy card.
    #[serde(default)]
    pub sync_pending: bool,
    /// v1.57.0 (Cycle 3 — increment 3a): free-form text a human typed into
    /// the issue body *outside* the `atelier:notes/knowledge` marker blocks
    /// (parsed out by `github::parse_issue_body`). Cached here so a card
    /// edit from Ply can re-append it via `build_issue_body` instead of
    /// silently erasing it on `issue_edit`. `None` when the issue body has
    /// no out-of-marker text (and for every legacy card).
    #[serde(default)]
    pub gh_raw_remainder: Option<String>,
    /// GH #66: the backing issue's assignee logins, as last read from GitHub
    /// (Sync, the claim gate, Claim). The claim is the assignee, so this is
    /// what the header and the board tile show as "Claimed by X" / "Yours".
    /// A display cache only: every claim decision re-reads the live issue.
    /// GitHub-owned, refreshed on every pull (even a `sync_pending` card's,
    /// since Ply never pushes assignees). Empty on local-only and legacy cards.
    #[serde(default)]
    pub gh_assignees: Vec<String>,
    /// N14 (item 6): the GitHub login of who opened the backing issue, as
    /// last read from GitHub (Sync, Claim). The card page says "<login>
    /// described the card" when it is someone else. GitHub-owned and
    /// display only, refreshed on every pull like `gh_assignees` (Ply never
    /// pushes it); a pull that reads no author keeps the one recorded.
    /// Absent on local-only cards and on every card before it, and then not
    /// written: an old board loads unchanged. Additive `#[serde(default)]`,
    /// no schema bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gh_author: Option<String>,
    /// 1.173.0 (C2): which computer took the card — the hidden marker in
    /// its issue body (`device_claim`), as last read from GitHub (Sync, the
    /// claim, a release). GitHub-owned like `gh_assignees`; a body Plyloft
    /// rebuilds from the card carries it back. Absent on local-only cards
    /// and on every card before it, and then not written: an old board loads
    /// unchanged. Additive `#[serde(default)]`, no schema bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gh_claim: Option<crate::device_claim::DeviceClaim>,
    /// 1.173.0 (C2): `gh_claim` names this computer (its id in this
    /// repository's markers, `device_claim::this_id_for`). Local, decided
    /// when the marker is recorded; `false` on every card before it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub gh_claim_here: bool,
    /// 1.173.0 (C2, Challenger 2): the name of the computer that took the
    /// card over from this one — set only when this computer's marker was
    /// replaced by another's, cleared by this computer's next claim (or when
    /// the issue carries none). "Taken over by <name>" reads it. Local only;
    /// absent on every card before it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gh_claim_lost_to: Option<String>,
    /// GH #66: the card's status label has not reached its issue: a
    /// label-only push (Start build, Resume, a column move) failed. The next
    /// Sync retries **only** the labels, unlike `sync_pending`, which re-pushes
    /// the cached title and body and would overwrite issue edits made since.
    /// The pull still applies to the card. `false` on every legacy card.
    #[serde(default)]
    pub gh_labels_pending: bool,
    /// 1.175.0 (B3): the association with the repository of who opened the
    /// card's issue, as GitHub names it (`OWNER`, `MEMBER`, `COLLABORATOR`,
    /// `CONTRIBUTOR`, `NONE`, …), from the last read that said it. Anything
    /// but the first three is somebody outside the repository
    /// (`issue_text::outside`). `None` on a local card, on every card before
    /// it, and while GitHub hasn't said: then nothing is claimed either way.
    /// Additive `#[serde(default)]`, no schema bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gh_author_association: Option<String>,
    /// 1.175.0 (B3): who edited the issue's text last, when somebody has
    /// since it was written. With the author and its association it says
    /// whether the last hand on the text was outside the repository
    /// (`issue_text::card_written_outside`): then Plyloft's own marks in it
    /// don't count. `None` on every card before it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gh_last_editor: Option<String>,
    /// 1.175.0 (D3): what GitHub had of the title or the brief when this
    /// computer's edit of that part began, kept only while the edit isn't on
    /// GitHub yet (`issue_edit`); the write is judged against it. `None` on
    /// every card before it and on every card in step with its issue.
    /// Additive `#[serde(default)]`, no schema bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gh_last_read: Option<crate::issue_edit::GhLastRead>,
    /// 1.175.0 (D3): the parts (title, brief; two at most) both this
    /// computer and GitHub changed — the card keeps the member's version
    /// and asks which to keep (`issue_edit::EditConflict`). Empty on every
    /// card before it, and then not written.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub edit_conflicts: Vec<crate::issue_edit::EditConflict>,
    /// 1.175.0 (D2): the member left this card (Move back, Stop during the
    /// start, Archive) and GitHub didn't take their own name off its issue.
    /// The next Sync tries once more (`leave_issue::retry_pending`), inside
    /// its cap of writes; a Start build on the card drops the mark, and the
    /// name stays. `false` on every card before it, and then not written:
    /// an old board loads unchanged. Additive `#[serde(default)]`, no schema
    /// bump.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unassign_pending: bool,
    /// UX-5.3: where the person dragged the card within its Board column.
    /// A sort key in the same space as `created_at` (the default order), so
    /// a reorder writes one card: the midpoint of its new neighbours. Board
    /// view state only — never synced to GitHub, never a lifecycle input.
    /// `None` on every card before it, which sorts by `created_at`. Additive
    /// `#[serde(default)]`, no schema bump (as `builder`, `gh_assignees`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board_order: Option<f64>,
    /// UX-7.1: the cards of the same workspace this card waits for, by id.
    /// A card with a blocker that has not shipped cannot start (plan or
    /// build) — `start_refusal`; when its last blocker ships it is ready,
    /// never started on its own. An archived or deleted blocker holds no one
    /// back, and a delete removes its id everywhere. Cycles are refused at
    /// write time (`set_blocked_by`). Local only — never synced to GitHub.
    /// Empty on every card before it, and then not written: an old board
    /// loads unchanged. Additive `#[serde(default)]`, no schema bump.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocked_by: Vec<String>,
    /// The Builder vendor chosen for this card before any build (the card's
    /// Builder property, the Run step's picker). `None` = the Settings
    /// default (`behavior.builderVendor`). Read only when a build starts;
    /// once a session exists `builder.vendor` is the fact. Set only through
    /// `set_builder_vendor_pref`. Local only — never synced to GitHub. Absent
    /// on every card before it, and then not written: an old board loads
    /// unchanged. Additive `#[serde(default)]`, no schema bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builder_vendor_pref: Option<crate::settings::BuilderVendor>,
    /// 1.171.0 (D1): how this card's Builder asks before it changes
    /// things, chosen on the card before Start build. `None` = the Settings
    /// default (`behavior.builderPermissions`), or the tour card's own mode.
    /// Read when a build starts; once a session exists
    /// `builder.permissions` is the fact, and Resume keeps it. Set only
    /// through `set_builder_permissions`. Local only — never synced to
    /// GitHub. Absent on every card before it, and then not written: an old
    /// board loads unchanged. An unknown value reads as `None`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::settings::lenient_opt"
    )]
    pub builder_permissions: Option<crate::settings::BuilderPermissions>,
    /// 1.168.1 (E2): the models chosen for this card only — per role and
    /// vendor, in the shape of a workspace's own rows (`claude` / `codex`
    /// rows, `cliDefault` for "the tool's default"). Over the workspace's
    /// and the app's at every spawn for the card (`settings::model_for_card`);
    /// a running session keeps the model it started with. Set only through
    /// `set_card_models`. A preference of this Mac: local only — never
    /// synced to GitHub (the issue carries the title and the brief). Absent
    /// on every card before it, and then not written: an old board loads
    /// unchanged; an older Plyloft drops it on its next write of the card.
    /// Additive `#[serde(default)]`, no schema bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<crate::settings::WorkspaceModels>,
    /// 1.169.0 (A3): each "Retry on…" of a round — which round, the model it
    /// had and the one it was retried on — oldest first, bounded
    /// (`MODEL_RETRIES_MAX`). The card's own `models` never change for it.
    /// Local only, never synced to GitHub. Absent on every card before it,
    /// and left out of the file while empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub model_retries: Vec<ModelRetry>,
    /// SL-4: what the setup of the card's worktree did — the git-ignored
    /// files copied in from the main checkout and the setup command's outcome
    /// (`worktree_setup::prepare_worktree`). A `failed` record holds the
    /// Builder back until Retry or Start anyway. File names only, never
    /// contents. Written by the backend alone; cleared with the worktree on
    /// archive. Absent on every card before it and on cards whose workspace
    /// configures no setup, and then not written: an old board loads
    /// unchanged. Additive `#[serde(default)]`, no schema bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_setup: Option<crate::worktree_setup::WorktreeSetupRecord>,
    /// 1.175.0 B2 (SEC-4): the card's checks were asked for and didn't run,
    /// because this computer hasn't allowed the repository's checks
    /// (`checks_consent`): "The checks need your OK". Set by the verify
    /// worker, cleared when a run of the checks starts. Local only, never
    /// synced to GitHub. Absent on every card before it and then not
    /// written: an old board loads unchanged. Additive, no schema bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checks_hold: Option<crate::checks_consent::ChecksHold>,
    /// The first of the card worktree's ten ports (`worktree_ports`):
    /// handed out when the worktree is made, or the first time something
    /// runs in a worktree made before this, and exposed as
    /// `PLYLOFT_PORT_BASE` to everything run there. In use only while the
    /// card has a worktree; kept after the worktree goes, so the card gets
    /// the same ports back unless another card took them. Written by the
    /// backend alone. Absent on every card before it, and then not written:
    /// an old board loads unchanged. Additive `#[serde(default)]`, no schema
    /// bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port_base: Option<u16>,
    /// SL-6: Build with both — the two builds (Claude in this card's
    /// worktree, Codex in `<card_id>-b`), the Challenger's comparison and,
    /// once the owner picked (or stopped), what became of each. While it is
    /// undecided the card has no `builder`; the pick makes the chosen build
    /// the card's worktree, branch and Builder. Absent on every card built
    /// the normal way, and then not written: an old board loads unchanged.
    /// Additive `#[serde(default)]`, no schema bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_both: Option<crate::build_both::BuildBoth>,
    /// SL-5: comments on lines of the card's review diff, for its Builder
    /// (`line_comments::LineComment`). Unsent ones are editable and
    /// removable; **Send to Builder** pastes them in one message and marks
    /// them sent, and they stay as the card's history. Local only — never
    /// synced or posted to GitHub. Empty on every card before it, and then
    /// not written: an old board loads unchanged. Additive
    /// `#[serde(default)]`, no schema bump.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub line_comments: Vec<crate::line_comments::LineComment>,
    /// N18: the card branch Plyloft will delete once the card's worktree
    /// trash entry expires (`branch_cleanup`): its name and the tip recorded
    /// when the card shipped, landed, merged on GitHub or was archived, and
    /// what became of it. Written by the backend alone; local only, never
    /// synced. Absent on every card before it, and then not written: an old
    /// board loads unchanged. Additive `#[serde(default)]`, no schema bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_cleanup: Option<crate::branch_cleanup::BranchCleanup>,
    /// Windows walk 2026-10-20 (Try it spec §4.5): the card's copy a Ship
    /// couldn't move to the trash (a program still has it open), and why —
    /// the card says so, and Plyloft tries again when its Builder session
    /// closes and at launch (`kept_copy`), clearing it once the copy is
    /// gone. Written by the backend alone; local only, never synced. Absent
    /// on every card before it and whenever nothing was kept, and then not
    /// written: an old board loads unchanged. Additive `#[serde(default)]`,
    /// no schema bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kept_copy: Option<crate::kept_copy::KeptCopy>,
    /// N19: the shipped card this card follows up (`Follow up` on a shipped
    /// card made it): the card page says "Follows up <title>". Written by the
    /// backend alone (`KanbanStore::create_follow_up`); local only, never
    /// synced. Absent on every other card and on every card before it, and
    /// then not written: an old board loads unchanged. Additive
    /// `#[serde(default)]`, no schema bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follows_up: Option<CardFollowLink>,
    /// N19: the cards made to follow this one up, oldest first — its
    /// Activity says "Followed up by <title>". The only field a follow-up
    /// writes on the shipped card: its ship, branch and branch cleanup
    /// record stay as they were. Local only, never synced. Empty on every
    /// card before it, and then not written. Additive `#[serde(default)]`,
    /// no schema bump.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub followed_up_by: Vec<CardFollowLink>,
    /// Challenger on a pull request: the open pull request of this
    /// repository the card reviews (`pr_review::PrReview`) — its number,
    /// branches, the head Plyloft last read and whether its branch is the
    /// member's own to fix. Set only by `pr_review_create`; refreshed by the
    /// card page and the PR poller. The card's Builder state then holds the
    /// Challenger's reviews of the pull request's heads (one snapshot each).
    /// Local only: nothing of it is posted to GitHub. Absent on every other
    /// card and on every card before it, and then not written: an old board
    /// loads unchanged. Additive `#[serde(default)]`, no schema bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_review: Option<crate::pr_review::PrReview>,
    /// G7 (1.170.0): "Fix failing checks by itself" for this card — `Some`
    /// once the person flipped it on the card, `None` follows the
    /// workspace's default (`Workspace::fix_failing_checks`, off). Absent on
    /// every card before it, and then not written: an old board loads
    /// unchanged. Additive `#[serde(default)]`, no schema bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_auto_fix: Option<bool>,
    /// 1.175.0 (F5, owner I7): this card's "After a fix round" — `Some(true)`
    /// checks by itself, `Some(false)` waits for the person; absent follows
    /// `settings.behavior.checkFixRoundsByItself`. Not written while absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fix_round_check: Option<bool>,
    /// 1.175.0 (F5, owner I6): how many Finish and checks Plyloft started by
    /// itself in a row on this card; at two, the next fix round waits for
    /// the person. Back to zero at an approval or the person's own press.
    /// Not written while zero.
    #[serde(default, skip_serializing_if = "is_zero_u8")]
    pub fix_round_self_checks: u8,
    /// Skills hub H3a (`docs/plans/SKILLS_HUB.md` §4.2): what kind of card
    /// this is. `None` is an ordinary card; `Skill` is a card Plyloft made
    /// whose worktree already carries one skill change as one commit
    /// (Install, Update): it opens at Ship, skips Verify when Ship finds only
    /// skill files changed — until a Builder or a swarm works on it, which
    /// makes it an ordinary card (§14 Q29).
    /// Absent on every other card and on every card before it, and then not
    /// written: an old board loads unchanged. A kind this build cannot read
    /// is an ordinary card ([`lenient_card_kind`]), never a board that fails
    /// to load. An older app's next board write drops it and the card becomes
    /// ordinary (it then needs Verify and takes the slot) — safe, and accepted
    /// (§4.2). Additive `#[serde(default)]`, no schema bump.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_card_kind"
    )]
    pub kind: Option<CardKind>,
    /// Skills hub H5 (R12): the skills whose other copy Plyloft brought in
    /// line with the one the Builder edited, at a *Finish and check* of this
    /// card — the Verify step says so ("Codex's copy of x updated to match
    /// Claude's."). One entry per skill, the latest winner. Empty on every
    /// other card and on every card before it, and then not written: an old
    /// board loads unchanged. Additive `#[serde(default)]`, no schema bump.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub twins_aligned: Vec<crate::skill_twins::Aligned>,
    /// Skills hub H5 (Challenger, Builder walk): the skills this card
    /// changed whose Claude and Codex copies stay apart after its last
    /// *Finish and check* — both changed, or aligning would have written
    /// over the Builder's own edit. The Verify step says so, and the
    /// Library's Align asks which wins. Same rules as `twins_aligned`:
    /// additive, absent while empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub twins_apart: Vec<String>,
    /// 1.172.0 (A1): what the person asked the Builder after the first
    /// result (`later_requests::LaterRequest`: the words, when, and whether
    /// from Not right, Request changes or Ask about this card), oldest first,
    /// bounded (`LATER_REQUESTS_MAX`). The card page lists them under What
    /// you want; the Challenger's brief (`review_context::brief_of`) and the
    /// pull-request draft's material carry them. Local: never mirrored to
    /// the card's issue; Ship's pull-request draft may quote them. A
    /// follow-up card starts without them. Empty on every card before it,
    /// and then not written: an old board loads unchanged. Additive
    /// `#[serde(default)]`, no schema bump.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub later_requests: Vec<crate::later_requests::LaterRequest>,
    /// 1.173.0 (B3): the area of the repository this card belongs to
    /// (`areas::AreaDef::id`), so its start, Ship and Bring in read the
    /// area's branch (`card_area`). Set when the card is made (the current
    /// area), changed on the card page while it is Not started, or chosen
    /// on a card that has none in a repository with areas ("Which area is
    /// this?"). `None` on every card before it and in a repository without
    /// areas, and then not written: an old board loads unchanged. On a
    /// GitHub Issues board it travels as the area's label on the card's
    /// issue (C1, `github_sync::push_area_label`, and back on the pull).
    /// Additive `#[serde(default)]`, no schema bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub area: Option<String>,
    /// 1.173.0 (C1): the area label the card's issue had when this Mac last
    /// read it or put it there, as GitHub spells it (also an `area:…` label
    /// no listed area has, which the card then names). The area label goes
    /// up only while it differs from the card's area's, so a label a person
    /// removed on GitHub wins on the next pull, and two Macs never fight.
    /// `None` on every card before it, on local boards, and then not
    /// written. Additive `#[serde(default)]`, no schema bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gh_area_label: Option<String>,
    /// 1.173.0 A3 (walk fix): the copy without a card *Make it a card* made
    /// this card from — its worktree is that copy's folder — so the card
    /// page says the work there is its own (`card_copy_changes`). `None` on
    /// every other card and then not written. Local: never mirrored.
    /// Additive `#[serde(default)]`, no schema bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_copy: Option<CardFromCopy>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub last_edited_by: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Skills hub H3a: the kind of a card Plyloft made (§4.2). Tagged by
/// `type`, so a later kind is a new variant beside this one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CardKind {
    Skill(crate::skill_card::SkillCard),
}

/// `kind` as this build knows it: anything it cannot read (a kind from a
/// later build, a field edited by hand) is an ordinary card.
fn lenient_card_kind<'de, D>(deserializer: D) -> Result<Option<CardKind>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value.and_then(|value| serde_json::from_value(value).ok()))
}

impl KanbanCard {
    /// 1.173.0 (C2): record the claim marker the issue carries, with what
    /// it means here — `gh_claim_here`, and `gh_claim_lost_to` when this
    /// computer's marker was replaced by another's (cleared by this
    /// computer's next claim, or when the issue carries none). `mine` is this
    /// computer's id in the repository's markers. Returns whether anything
    /// changed.
    pub fn take_gh_claim(&mut self, claim: Option<crate::device_claim::DeviceClaim>, mine: Option<&str>) -> bool {
        // 1.174.0 (E12 round 1): this computer not known yet — the marker is
        // kept, and whether it is this computer's (or was lost) stays as it was.
        if mine.is_none() {
            let changed = self.gh_claim != claim;
            self.gh_claim = claim;
            return changed;
        }
        let here = matches!((&claim, mine), (Some(c), Some(id)) if c.device == id);
        let was_here = self.gh_claim.is_some() && self.gh_claim_here;
        let lost_to = match &claim {
            None => None,
            Some(_) if here => None,
            Some(c) if was_here => Some(c.name.clone()),
            Some(_) => self.gh_claim_lost_to.clone(),
        };
        let changed = self.gh_claim != claim || self.gh_claim_here != here || self.gh_claim_lost_to != lost_to;
        self.gh_claim = claim;
        self.gh_claim_here = here;
        self.gh_claim_lost_to = lost_to;
        changed
    }

    /// Skills hub H3a: the skill change this card carries while it is still
    /// a skill card — no Builder session and no swarm ever worked on it
    /// (§14 Q29: once one does, it is an ordinary card).
    ///
    /// Challenger (H3a): every trace of work counts, and stays counted — an
    /// agent run linked or recorded (`linked_run_id`, `run_history`), a
    /// Build with both (`build_both`, kept after it stops, which clears
    /// `builder`) — so a card never turns back into a skill card when a
    /// Builder field is cleared later.
    pub fn skill_card(&self) -> Option<&crate::skill_card::SkillCard> {
        if self.builder.is_some()
            || self.linked_swarm_id.is_some()
            || self.linked_run_id.is_some()
            || !self.run_history.is_empty()
            || self.build_both.is_some()
        {
            return None;
        }
        match self.kind.as_ref()? {
            CardKind::Skill(skill) => Some(skill),
        }
    }

    /// v1.33.0: construct a fresh card with every backend-owned field at
    /// its default. This is the only constructor for new cards — it keeps
    /// `KanbanStore::create_card` from trusting an FE-supplied full struct,
    /// so the frontend can never seed a card with forged run/ship/review
    /// state.
    pub fn new(
        id: String,
        workspace_id: String,
        title: String,
        notes: Option<String>,
        column_id: KanbanColumnId,
    ) -> Self {
        let now = now_millis();
        Self {
            id,
            workspace_id,
            title,
            notes,
            knowledge: None,
            column_id,
            agent_config_id: None,
            linked_run_id: None,
            last_run_status: None,
            swarm_template_id: None,
            linked_swarm_id: None,
            linked_brainstorm_id: None,
            dismissed_banners: Vec::new(),
            run_history: Vec::new(),
            suppress_run_history: false,
            builder: None,
            plan_challenge: None,
            dispatch_prompt: None,
            dispatch_prompt_edited_at: None,
            intake_status: IntakeStatus::None,
            intake_history: Vec::new(),
            archived: false,
            archived_at: None,
            auto_archived: false,
            put_backs: Vec::new(),
            verify_intent: None,
            verify_status: VerifyStatus::None,
            verify_history: Vec::new(),
            ship_status: ShipStatus::Unshipped,
            ship_history: Vec::new(),
            commit_sha: None,
            shipped_version: None,
            attachments: Vec::new(),
            worktree_path: None,
            branch_name: None,
            worktree_base: None,
            review_status: None,
            ship_conflict: None,
            review_decisions: Vec::new(),
            pr_url: None,
            pr: None,
            parent_card_id: None,
            gh_issue_number: None,
            sync_pending: false,
            gh_raw_remainder: None,
            gh_assignees: Vec::new(),
            gh_author: None,
            gh_claim: None,
            gh_claim_here: false,
            gh_claim_lost_to: None,
            gh_labels_pending: false,
            gh_last_read: None,
            edit_conflicts: Vec::new(),
            unassign_pending: false,
            gh_author_association: None,
            gh_last_editor: None,
            board_order: None,
            blocked_by: Vec::new(),
            builder_vendor_pref: None,
            builder_permissions: None,
            models: None,
            model_retries: Vec::new(),
            worktree_setup: None,
            checks_hold: None,
            port_base: None,
            build_both: None,
            line_comments: Vec::new(),
            branch_cleanup: None,
            kept_copy: None,
            follows_up: None,
            followed_up_by: Vec::new(),
            pr_review: None,
            pr_auto_fix: None,
            fix_round_check: None,
            fix_round_self_checks: 0,
            kind: None,
            twins_aligned: Vec::new(),
            twins_apart: Vec::new(),
            later_requests: Vec::new(),
            area: None,
            gh_area_label: None,
            from_copy: None,
            // v1.49.0 (Team Mode Phase 0): provenance defaults to None.
            // The IPC command path stamps both fields when the cached
            // identity email is available.
            author: None,
            last_edited_by: None,
            created_at: now,
            updated_at: now,
        }
    }

    /// v1.39.0 (Recon-fork cycle, Increment 2): forked-card constructor.
    /// Delegates to `new()` for the all-defaults base, then layers on
    /// the recon-fork prefills:
    /// - `knowledge` — the parent audit's `summary_md` plus a provenance
    ///   line. Source of truth for the implementation context.
    /// - `parent_card_id` — links back to the audit. Drives Increment 3's
    ///   "Forked from / Forked into" UX.
    /// - `swarm_template_id` — the suggested template for the
    ///   implementation run (typically `coordinator-feature`).
    ///
    /// Intentionally does NOT set `dispatch_prompt` — leaving it `None`
    /// makes the existing `card_compose_dispatch_prompt` path
    /// concatenate title + notes + knowledge at dispatch time. Single
    /// source of truth: edits to `knowledge` flow into dispatch
    /// automatically. Halves the storage cost per forked card vs.
    /// dual-writing the same summary into both fields.
    pub fn from_audit(
        id: String,
        workspace_id: String,
        title: String,
        knowledge: String,
        parent_card_id: String,
        swarm_template_id: Option<String>,
        column_id: KanbanColumnId,
    ) -> Self {
        let mut card = Self::new(id, workspace_id, title, None, column_id);
        card.knowledge = Some(knowledge);
        card.parent_card_id = Some(parent_card_id);
        card.swarm_template_id = swarm_template_id;
        card
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanFile {
    pub version: u32,
    #[serde(default)]
    pub cards: Vec<KanbanCard>,
}

impl Default for KanbanFile {
    fn default() -> Self {
        Self {
            version: KANBAN_SCHEMA_VERSION,
            cards: Vec::new(),
        }
    }
}

/// 1.168.1 (A4, owner 2026-10-22): a deleted card keeps its runs and checks
/// in History, marked as from a deleted card. What History needs of it —
/// its title, its Builder rounds, its checks and its ships — is kept here,
/// beside the boards and not in them: no board reader, sync or search
/// takes it for a card. `<config_dir>/kanban/deleted-cards/<wsId>.json`.
pub(crate) const DELETED_CARDS_SUBDIR: &str = "kanban/deleted-cards";
pub const DELETED_CARDS_VERSION: u32 = 1;
/// History's window: a card deleted longer ago has no row left to show.
const DELETED_CARD_KEEP_MS: i64 = crate::inbox::ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
/// At most this many deleted cards per workspace, newest kept.
const MAX_DELETED_CARDS: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedCardsFile {
    pub version: u32,
    #[serde(default)]
    pub cards: Vec<DeletedCard>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedCard {
    pub deleted_at: i64,
    /// The card as History reads it: id, title, Builder, checks and ships;
    /// everything else of it is left out.
    pub card: KanbanCard,
}

/// What History keeps of a card being deleted, as of `now`: its id, title
/// and times, and the Builder rounds, checks and ships inside History's
/// window — no brief, no review, no Builder internals (session ids, review
/// bodies), no check step's output; `ptyId` never, so it never reads as
/// Working.
pub fn history_of_deleted(card: &KanbanCard, now: i64) -> KanbanCard {
    let since = now - DELETED_CARD_KEEP_MS;
    let mut kept = KanbanCard::new(
        card.id.clone(),
        card.workspace_id.clone(),
        card.title.clone(),
        None,
        card.column_id.clone(),
    );
    kept.created_at = card.created_at;
    kept.updated_at = card.updated_at;
    kept.verify_history = card
        .verify_history
        .iter()
        .filter(|e| e.ended_at >= since)
        .map(|e| VerifyEntry {
            verify_run_id: e.verify_run_id.clone(),
            status: e.status,
            ended_at: e.ended_at,
            summary: e.summary.clone(),
            // History reads only whether any step ran ("no checks set up").
            steps: e
                .steps
                .iter()
                .map(|st| VerifyStepResult { kind: st.kind.clone(), passed: st.passed, elapsed_ms: st.elapsed_ms, reason: None })
                .collect(),
            tree_sha: None,
        })
        .collect();
    kept.ship_history = card.ship_history.iter().filter(|e| e.shipped_at >= since).cloned().collect();
    // 1.168.1 (A4, Windows walk): a round still open when the card was
    // deleted (its Builder working, never Finish and check) is kept as a
    // stopped one — never running, so it never reads Working — and History
    // lists it (`inbox::deleted_card_activity_rows`).
    if card.builder.as_ref().is_some_and(|b| b.pty_id.is_some())
        || card.last_run_status == Some(LastRunStatus::Running)
    {
        kept.last_run_status = Some(LastRunStatus::Aborted);
    }
    kept.builder = card.builder.as_ref().and_then(|b| {
        let rounds: Vec<&BuildSnapshot> = b.snapshots.iter().filter(|snap| snap.at >= since).collect();
        // Only its vendor, its start and its rounds.
        serde_json::from_value(serde_json::json!({
            "vendor": b.vendor,
            "startedAt": b.started_at,
            "snapshots": rounds,
        }))
        .ok()
    });
    kept
}

/// Validate the exact on-disk board directory before a read-only headless
/// diagnostic constructs `KanbanStore`. This rejects every state for which
/// `load` could migrate/reset-and-write, plus malformed/future files that the
/// interactive app conservatively degrades to an empty board.
///
/// C17: not [`read_board_file`]: a read-only check never moves a file, so an
/// unreadable one is refused here and left for the app to set aside.
pub fn preflight_read_only(config_dir: &std::path::Path) -> Result<(), String> {
    let root = boards_dir(config_dir);
    if !root.is_dir() {
        return Err("kanban/workspaces directory is missing".into());
    }
    let entries = fs::read_dir(&root)
        .map_err(|error| format!("read kanban/workspaces: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("read kanban entry: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("stat {}: {error}", path.display()))?;
        if !metadata.file_type().is_file() {
            return Err(format!("kanban file is not regular: {}", path.display()));
        }
        let bytes = fs::read(&path)
            .map_err(|error| format!("read {}: {error}", path.display()))?;
        if bytes.is_empty() {
            return Err(format!("kanban file is empty: {}", path.display()));
        }
        let parsed: KanbanFile = serde_json::from_slice(&bytes)
            .map_err(|error| format!("parse {}: {error}", path.display()))?;
        if parsed.version != KANBAN_SCHEMA_VERSION {
            return Err(format!(
                "kanban version is {} instead of {}: {}",
                parsed.version,
                KANBAN_SCHEMA_VERSION,
                path.display()
            ));
        }
        if parsed
            .cards
            .iter()
            .any(|card| card.intake_status == IntakeStatus::Active)
        {
            return Err(format!("kanban has active intake: {}", path.display()));
        }
    }
    Ok(())
}

/// v1.33.0: deserializer that distinguishes an *absent* JSON key from a
/// key present with value `null`. With a plain `Option<T>` serde collapses
/// both to `None`; wrapping the result in an extra `Some` gives the
/// three-state `Option<Option<T>>` a patch needs: absent → `None` (leave
/// the field untouched), `null` → `Some(None)` (clear it), value →
/// `Some(Some(v))` (set it). Pair with `#[serde(default, deserialize_with
/// = "double_option")]`.
fn double_option<'de, T, D>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Deserialize::deserialize(de).map(Some)
}

/// v1.33.0: wire-only partial patch for a single kanban card. Replaces the
/// whole-board `kanban_save` overwrite that lost cards (v1.32.x data-loss
/// bug): the frontend sends only the fields the user changed and the
/// backend merges them onto the live card under the cache mutex. `CardPatch`
/// structurally cannot express a backend-owned field (`run_history`,
/// verify/ship/review state, worktree, attachments, link ids), so a stale
/// frontend board can never clobber them. See `docs/PATTERNS.md`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub notes: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub knowledge: Option<Option<String>>,
    #[serde(default)]
    pub column_id: Option<KanbanColumnId>,
    #[serde(default, deserialize_with = "double_option")]
    pub agent_config_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub swarm_template_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub dispatch_prompt: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub dispatch_prompt_edited_at: Option<Option<i64>>,
    #[serde(default)]
    pub dismissed_banners: Option<Vec<String>>,
    #[serde(default)]
    pub suppress_run_history: Option<bool>,
    #[serde(default, deserialize_with = "double_option")]
    pub verify_intent: Option<Option<String>>,
    #[serde(default)]
    pub intake_status: Option<IntakeStatus>,
    #[serde(default, deserialize_with = "double_option")]
    pub linked_brainstorm_id: Option<Option<String>>,
}

/// v1.33.0: wire-only patch for a card's run-link fields. These are
/// backend-owned (set by the dispatch path and the run-done listener, never
/// a user edit) so they live apart from `CardPatch`. Each field is
/// three-state via `double_option`: absent = leave, `null` = clear, value =
/// set.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStatePatch {
    #[serde(default, deserialize_with = "double_option")]
    pub linked_run_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub linked_swarm_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub last_run_status: Option<Option<LastRunStatus>>,
}

/// v1.33.0: cap on `dismissed_banners` (FE-only field). Mirrors the comment
/// on `KanbanCard::dismissed_banners`.
const MAX_DISMISSED_BANNERS: usize = 16;

/// 1.168.1 (A4): `Ok(None)` when there is no file, `Err` when there is one
/// that can't be read (or comes from a newer Plyloft).
fn read_deleted_cards(path: &Path) -> Result<Option<DeletedCardsFile>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|e| format!("read: {e}"))?;
    let file: DeletedCardsFile = serde_json::from_slice(&bytes).map_err(|e| format!("parse: {e}"))?;
    if file.version > DELETED_CARDS_VERSION {
        return Err(format!("version {} is newer than {DELETED_CARDS_VERSION}", file.version));
    }
    Ok(Some(file))
}

/// v1.33.0: ensure `workspace_id`'s cards are materialized in `cache`,
/// reading them from disk on a miss. Returns a mutable handle to the cached
/// vec. Factored out of `mutate_card` so `create_card`/`delete_card` share
/// one materialize path — every write holds the cache mutex, so concurrent
/// writers serialize on the one canonical view.
fn materialize_cards<'a>(
    cache: &'a mut HashMap<String, Vec<KanbanCard>>,
    workspace_id: &str,
    path: &std::path::Path,
    unreadable: &Mutex<HashMap<String, BoardTrouble>>,
) -> Result<&'a mut Vec<KanbanCard>, String> {
    if !cache.contains_key(workspace_id) {
        // Any supported version: cards from an older file get the same
        // `serde(default)` fallbacks as fresh ones; the legacy migration
        // (Decision 15) runs only in `load()`. C17: a newer Plyloft's board
        // refuses (`read_board_file`), so it is never written over. R2: a
        // board opened from its backup comes migrated and already written.
        let cards = match read_board_file(path, workspace_id, unreadable)? {
            BoardRead::None => Vec::new(),
            BoardRead::Board(parsed) => parsed.cards,
            BoardRead::Restored(cards) => cards,
        };
        cache.insert(workspace_id.to_string(), cards);
    }
    Ok(cache
        .get_mut(workspace_id)
        .expect("workspace cards inserted above"))
}

/// C17: what [`crate::atomic::newer_refusal`] calls a board.
const NEWER_BOARD: &str = "This board";

/// C17: the newer boards already warned about, by workspace and the file's
/// modification time, so each write refused on one says it once (then debug).
static NEWER_WARNED: Mutex<Option<std::collections::HashSet<(String, Option<std::time::SystemTime>)>>> = Mutex::new(None);

/// Whether this is the first refusal for `workspace_id`'s board as it is now.
fn first_newer_warning(workspace_id: &str, path: &Path) -> bool {
    let modified = fs::metadata(path).and_then(|m| m.modified()).ok();
    NEWER_WARNED.lock().get_or_insert_with(Default::default).insert((workspace_id.to_string(), modified))
}

/// `<id>.json.bak`: the rolling backup beside a board file ([`write_board`]).
fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("json.bak")
}

/// OP-2: a board file's own fields with its cards counted, not built — what
/// tells a board from an empty or broken file without reading every card.
#[derive(Deserialize)]
struct BoardShape {
    #[allow(dead_code)]
    version: u32,
    #[serde(default)]
    cards: Vec<serde::de::IgnoredAny>,
}

/// OP-2: how many cards `bytes` hold when they are a board file; `None` for
/// an empty file or one that isn't a board.
fn board_card_count(bytes: &[u8]) -> Option<usize> {
    serde_json::from_slice::<BoardShape>(bytes).ok().map(|board| board.cards.len())
}

/// OP-2: how many cards the board file at `path` holds, `None` when there is
/// no file, it can't be read, it is empty or it isn't a board.
fn board_card_count_at(path: &Path) -> Option<usize> {
    fs::read(path).ok().and_then(|bytes| board_card_count(&bytes))
}

/// What a board that couldn't be read came to, said once on the Board
/// ([`KanbanStore::take_notice`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoardNotice {
    /// The last saved copy (`<id>.json.bak`) was opened in the file's place;
    /// `false`: there was none to open, and the board started empty.
    pub restored: bool,
    /// Where the file that couldn't be read is kept.
    pub kept_as: PathBuf,
    /// T4: on how many of the restored cards "Merge when checks pass" was
    /// turned off (`pr_merge::turn_off_on_restore`); 0 when on none.
    pub auto_merge_off: usize,
}

/// R2: a board that couldn't be read, for the rest of this session
/// (`KanbanStore.unreadable`). What the board shows since is not the whole
/// picture — empty, or one save behind — so nothing is pruned on it
/// ([`KanbanStore::not_whole`]).
#[derive(Debug, Clone)]
struct BoardTrouble {
    notice: BoardNotice,
    /// Round 6 (W3): the window has shown the notice and said so
    /// ([`KanbanStore::note_said`]). Remembered beside the board
    /// ([`RestoredMarker`], or the absence of [`unsaid_path`]), so a notice
    /// that was never on screen is shown at the next launch.
    said: bool,
    /// [`KanbanStore::take_notice`] has handed the notice to the window this
    /// session, so it isn't handed out twice. In memory only.
    handed: bool,
    /// Opened from its backup: when that backup was written.
    backup_written_ms: Option<i64>,
    /// GitHub's issues were read once since the board was opened from its
    /// backup ([`KanbanStore::note_pulled`]).
    pulled: bool,
    /// The cards the store has are the board's own. `false` for the session
    /// that set the board aside or opened its backup (not the whole
    /// picture); `true` when a later launch found the board's
    /// [`RestoredMarker`] — the restore is behind it, the cards were read as
    /// they are, and only the notice and the first read from GitHub are
    /// still owed.
    whole: bool,
    /// `<id>.json.restored` exists and follows `said` and `pulled`.
    marker: bool,
}

/// `<id>.json.restored`: beside a board that was opened from its last saved
/// copy, until that was said and — on a GitHub Issues board — GitHub's
/// issues were read once.
fn restored_marker_path(path: &Path) -> PathBuf {
    path.with_extension("json.restored")
}

/// 1.175.0 (round 4, T2): what [`BoardTrouble`] must not forget at a quit.
/// A board opened from its backup is one save behind, and until GitHub's
/// issues were read once nothing of it may be sent there: a card whose
/// number was stamped in the lost save would get a second issue, and the
/// read a second card. In memory only, a quit before that read (offline)
/// left an ordinary board file, and the next launch pushed before it
/// pulled. The marker is written with the restore and re-arms, at the next
/// launch, the hold on issue writes, the relink window (from
/// `backup_written_ms`) and the notice if it wasn't said — not "not whole":
/// by then the cards are read from the board's own file.
///
/// It is not a board. Everything that lists the boards folder goes by the
/// name `<id>.json` and never sees it (`a_restored_marker_is_never_taken_for_a_board`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoredMarker {
    /// When the backup the board was opened from was written (ms).
    backup_written_ms: i64,
    /// Where the unreadable file is kept, as the notice names it.
    kept_as: String,
    /// The notice was shown.
    #[serde(default)]
    said: bool,
    /// GitHub's issues were read once since.
    #[serde(default)]
    pulled: bool,
    /// T4: how many cards had "Merge when checks pass" turned off, for a
    /// notice shown at a later launch.
    #[serde(default)]
    auto_merge_off: usize,
}

/// T2: the marker beside the board at `path`, when there is one this build
/// can read. One that doesn't parse says nothing usable: removed, and logged.
fn read_restored_marker(path: &Path) -> Option<RestoredMarker> {
    let marker = restored_marker_path(path);
    let bytes = fs::read(&marker).ok()?;
    match serde_json::from_slice(&bytes) {
        Ok(found) => Some(found),
        Err(e) => {
            log::warn!("kanban: {} can't be read ({e}); removed", marker.display());
            let _ = fs::remove_file(&marker);
            None
        }
    }
}

/// Round 6 (W3): `<kept file>.unsaid`, zero bytes, beside a board file that
/// was set aside with no copy to open, until the window has shown its
/// notice. A board opened from its copy remembers that in its
/// [`RestoredMarker`]; a board that started empty has no file of its own to
/// remember anything, and a quit before the toast was on screen left an
/// empty board with nothing ever said. Not a board, not a set-aside file
/// (the launch inventory skips zero-byte files) and not a marker.
fn unsaid_path(kept_as: &Path) -> PathBuf {
    let mut name = kept_as.as_os_str().to_owned();
    name.push(".unsaid");
    PathBuf::from(name)
}

/// W3: the file set aside from the board at `path` whose notice was never
/// shown, if there is one (the newest by the time in its name). An
/// `.unsaid` left beside nothing — the kept file was moved away — is
/// removed.
fn unsaid_set_aside(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_str()?;
    let bak = backup_path(path);
    let prefixes = [
        format!("{name}{}", crate::atomic::UNREADABLE_SUFFIX),
        format!("{}{}", bak.file_name()?.to_str()?, crate::atomic::UNREADABLE_SUFFIX),
    ];
    let mut found: Vec<(i64, PathBuf)> = Vec::new();
    for entry in fs::read_dir(path.parent()?).ok()?.flatten() {
        let file = entry.file_name();
        let Some(kept_name) = file.to_str().and_then(|n| n.strip_suffix(".unsaid")) else { continue };
        let Some(at) = prefixes.iter().find_map(|prefix| kept_name.strip_prefix(prefix.as_str())) else { continue };
        let kept = entry.path().with_file_name(kept_name);
        if !kept.exists() {
            let _ = fs::remove_file(entry.path());
            continue;
        }
        found.push((at.parse().unwrap_or(i64::MIN), kept));
    }
    found.into_iter().max().map(|(_, kept)| kept)
}

/// T2: no board is restored at `path` any more (it is missing, or was set
/// aside): a marker left beside it is removed, and said in the log.
fn drop_stale_restored_marker(path: &Path) {
    let marker = restored_marker_path(path);
    match fs::remove_file(&marker) {
        Ok(()) => log::warn!("kanban: {} had no restored board beside it; removed", marker.display()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::warn!("kanban: couldn't remove {}: {e}", marker.display()),
    }
}

impl BoardTrouble {
    /// T2: bring `<id>.json.restored` in line with `said` and `pulled`. Once
    /// both hold there is nothing left to remember and it is removed.
    fn sync_marker(&mut self, path: &Path) {
        let (true, Some(backup_written_ms)) = (self.marker, self.backup_written_ms) else { return };
        let marker = restored_marker_path(path);
        if self.said && self.pulled {
            self.forget_marker(path);
            return;
        }
        let file = RestoredMarker {
            backup_written_ms,
            kept_as: self.notice.kept_as.display().to_string(),
            said: self.said,
            pulled: self.pulled,
            auto_merge_off: self.notice.auto_merge_off,
        };
        if let Err(e) = crate::atomic::write_atomic_json(&marker, &file) {
            log::warn!("kanban: couldn't update {}: {e}", marker.display());
        }
    }

    fn forget_marker(&mut self, path: &Path) {
        if !self.marker {
            return;
        }
        self.marker = false;
        let marker = restored_marker_path(path);
        if let Err(e) = fs::remove_file(&marker) {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!("kanban: couldn't remove {}: {e}", marker.display());
            }
        }
    }
}

/// What [`read_board_file`] found.
enum BoardRead {
    /// No file, or an empty one with no backup that holds cards.
    None,
    Board(KanbanFile),
    /// R2: the file couldn't be read and the board was opened from its
    /// backup: these cards, migrated, settled and already written back.
    Restored(Vec<KanbanCard>),
}

/// R2: what `<id>.json.bak` is to a board file that couldn't be read.
enum Backup {
    /// No backup, one that can't be read or isn't a board, or a board
    /// without cards: nothing to open and nothing to keep.
    Nothing,
    /// A board with cards that this build can't open (a card it can't
    /// parse, a version no Plyloft wrote). Not opened, and kept.
    Unusable,
    /// A newer Plyloft's.
    Newer(u32),
    /// A board this build can read, and when it was written (ms).
    Board { file: KanbanFile, written_ms: i64 },
}

fn read_backup(backup: &Path) -> Backup {
    let Ok(bytes) = fs::read(backup) else { return Backup::Nothing };
    if let Some(found) = crate::atomic::newer_version(&bytes, "version", KANBAN_SCHEMA_VERSION) {
        return Backup::Newer(found);
    }
    if !board_card_count(&bytes).is_some_and(|cards| cards > 0) {
        return Backup::Nothing;
    }
    match serde_json::from_slice::<KanbanFile>(&bytes) {
        Ok(file) if (1..=KANBAN_SCHEMA_VERSION).contains(&file.version) => {
            let written_ms = fs::metadata(backup)
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|since| since.as_millis() as i64)
                // Unknown: a day back, which holds any save a crash cut short.
                .unwrap_or_else(|| now_ms() - 24 * 60 * 60 * 1000);
            Backup::Board { file, written_ms }
        }
        _ => Backup::Unusable,
    }
}

/// C17: a board file. `None` when there is none. One that doesn't parse used
/// to read as empty and the next save wrote over it (SL-0, Ship pilot). One
/// a newer Plyloft wrote — parsed or not — is refused in
/// [`crate::atomic::newer_refusal`]'s words and left as it is: `load()`
/// returns it (`kanban_load`'s toast) and every write refuses.
///
/// 1.175.0 (R2, owner 2026-11-09): a file that can't be read — one that
/// doesn't parse, or zero bytes where a board was (what a crash leaves of a
/// save that never reached the disk) — opens from its last saved copy when
/// `<id>.json.bak` is a board with cards this build can read:
///
/// 1. the backup's cards go through the same version migration and restart
///    settling as a normal load, never raw;
/// 2. the unreadable bytes are kept as found beside the file
///    (`<id>.json.unreadable-<ms>`, [`crate::atomic::keep_unreadable_copy`]);
/// 3. the restored board is written to `<id>.json` with the flushed atomic
///    writer, before anything is cached. If that write fails the read fails
///    and nothing has changed. `.bak` is never touched: the saves after this
///    one roll boards that hold the restored cards.
///
/// It is remembered for the session ([`BoardTrouble`]) and said once
/// ([`KanbanStore::take_notice`]). A backup a newer Plyloft wrote is refused
/// like a newer board, and both files are left as they are.
///
/// With no backup to open: a file that doesn't parse is set aside as found
/// (renamed; one that can't be renamed fails the read, so nothing writes
/// over it), remembered and said, and reads as none; an empty file is an
/// empty board, as it always was. A backup that holds cards this build can't
/// open is set aside as found first (`<id>.json.bak.unreadable-<ms>`): the
/// saves that follow would roll over it, and it may be the only copy.
///
/// Not through [`crate::atomic::load_or_set_aside_with`]: that helper sets a
/// file aside the moment it doesn't parse, and here the backup decides first
/// whether anything is set aside at all, and in which order.
fn read_board_file(
    path: &Path,
    workspace_id: &str,
    unreadable: &Mutex<HashMap<String, BoardTrouble>>,
) -> Result<BoardRead, String> {
    let newer = |found: u32| {
        let error = crate::atomic::newer_refusal(NEWER_BOARD, found, KANBAN_SCHEMA_VERSION);
        if first_newer_warning(workspace_id, path) {
            log::warn!("kanban: workspace {workspace_id}: {error}");
        } else {
            log::debug!("kanban: workspace {workspace_id}: {error}");
        }
        Err(error)
    };
    let named = |e: String| format!("kanban: board for {workspace_id}: {e}");
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            drop_stale_restored_marker(path);
            rearm_unsaid_set_aside(path, workspace_id, unreadable);
            return Ok(BoardRead::None);
        }
        Err(e) => return Err(named(format!("read {}: {e}", path.display()))),
    };
    let why = if bytes.is_empty() {
        "the file is empty".to_string()
    } else {
        match serde_json::from_slice::<KanbanFile>(&bytes) {
            Ok(file) if file.version > KANBAN_SCHEMA_VERSION => return newer(file.version),
            Ok(file) => {
                // T2: restored at an earlier launch, and the notice or the
                // first read from GitHub is still owed.
                if let Some(marker) = read_restored_marker(path) {
                    unreadable.lock().entry(workspace_id.to_string()).or_insert_with(|| {
                        log::warn!(
                            "kanban: workspace {workspace_id}: its board was opened from its last saved copy at an earlier launch (said: {}, read from GitHub since: {})",
                            marker.said,
                            marker.pulled
                        );
                        BoardTrouble {
                            notice: BoardNotice {
                                restored: true,
                                kept_as: native_path(&marker.kept_as),
                                auto_merge_off: marker.auto_merge_off,
                            },
                            said: marker.said,
                            handed: false,
                            backup_written_ms: Some(marker.backup_written_ms),
                            pulled: marker.pulled,
                            whole: true,
                            marker: true,
                        }
                    });
                }
                rearm_unsaid_set_aside(path, workspace_id, unreadable);
                return Ok(BoardRead::Board(file));
            }
            Err(e) => match crate::atomic::newer_version(&bytes, "version", KANBAN_SCHEMA_VERSION) {
                Some(found) => return newer(found),
                None => e.to_string(),
            },
        }
    };
    let backup = backup_path(path);
    let trouble = |kept_as: PathBuf, restored: Option<i64>, auto_merge_off: usize| {
        let notice = BoardNotice { restored: restored.is_some(), kept_as, auto_merge_off };
        if restored.is_none() {
            // W3: a board that started empty remembers beside the kept file
            // that its notice is still owed. Best-effort: without it the
            // notice is said this session or not at all, as before.
            if let Err(e) = fs::write(unsaid_path(&notice.kept_as), b"") {
                log::warn!("kanban: couldn't note that {} wasn't said yet: {e}", notice.kept_as.display());
            }
        }
        let trouble = BoardTrouble {
            notice,
            said: false,
            handed: false,
            backup_written_ms: restored,
            pulled: false,
            whole: false,
            // T2: `restore_board` wrote it, before the board.
            marker: restored.is_some(),
        };
        unreadable.lock().insert(workspace_id.to_string(), trouble);
    };
    match read_backup(&backup) {
        Backup::Newer(found) => newer(found),
        Backup::Board { file, written_ms } => {
            let (cards, kept_as, auto_merge_off) = restore_board(path, workspace_id, &bytes, file, written_ms).map_err(|(e, kept)| {
                log::error!("kanban: workspace {workspace_id}: {} can't be read ({why}) and its last saved copy couldn't be opened in its place: {e}", path.display());
                // The file is as it was; a copy made of it is one too many.
                if let Some(kept) = kept.filter(|_| fs::read(path).is_ok_and(|now| now == bytes)) {
                    let _ = fs::remove_file(kept);
                }
                named(e)
            })?;
            log::warn!(
                "kanban: workspace {workspace_id}: {} couldn't be read ({why}); opened from its last saved copy {} ({} card(s)), and what it held is kept as {}",
                path.display(),
                backup.display(),
                cards.len(),
                kept_as.display()
            );
            trouble(kept_as, Some(written_ms), auto_merge_off);
            Ok(BoardRead::Restored(cards))
        }
        usable => {
            let holds_cards = matches!(usable, Backup::Unusable);
            if bytes.is_empty() && !holds_cards {
                return Ok(BoardRead::None);
            }
            // The backup first: if it can't be kept, nothing has moved and
            // the read fails, so no save rolls over it.
            let backup_aside = match holds_cards {
                true => crate::atomic::set_aside_unreadable(&backup, "a board with cards this Plyloft can't open").map_err(&named)?,
                false => None,
            };
            let aside = crate::atomic::set_aside_unreadable(path, &why).map_err(&named)?;
            // T2: an earlier restore's marker has no restored board beside it now.
            drop_stale_restored_marker(path);
            // An empty file set aside says nothing; its backup holds the cards.
            match (aside, backup_aside) {
                (Some(_), Some(backup_aside)) if bytes.is_empty() => trouble(backup_aside, None, 0),
                (Some(aside), _) => trouble(aside, None, 0),
                // Another reader set it aside first, and said so.
                (None, _) => {}
            }
            Ok(BoardRead::None)
        }
    }
}

/// W3: a board file was set aside at an earlier launch with no copy to open,
/// and its notice was never on screen ([`unsaid_path`]): it is owed again.
/// The board itself is an ordinary one by now — empty, or with what was
/// added since — so this is no "not whole" (the launch inventory goes by the
/// kept file's age, T5).
fn rearm_unsaid_set_aside(path: &Path, workspace_id: &str, unreadable: &Mutex<HashMap<String, BoardTrouble>>) {
    let mut unreadable = unreadable.lock();
    if unreadable.contains_key(workspace_id) {
        return;
    }
    let Some(kept_as) = unsaid_set_aside(path) else { return };
    log::warn!(
        "kanban: workspace {workspace_id}: its board file was set aside as {} at an earlier launch and that was never shown",
        kept_as.display()
    );
    unreadable.insert(
        workspace_id.to_string(),
        BoardTrouble {
            notice: BoardNotice { restored: false, kept_as, auto_merge_off: 0 },
            said: false,
            handed: false,
            backup_written_ms: None,
            pulled: false,
            whole: true,
            marker: false,
        },
    );
}

/// R2: open `path`'s board from `backup` (see [`read_board_file`]). Returns
/// the cards, where the unreadable `bytes` are kept and on how many cards
/// "Merge when checks pass" was turned off (T4); on an error, the copy
/// already made of the bytes, if any, with nothing else changed.
///
/// T2: `<id>.json.restored` ([`RestoredMarker`]) is written before the
/// board, so no crash leaves a restored board without it; a crash between
/// the two leaves the unreadable file in place, and the next read restores
/// again and writes it again. A marker that can't be written fails the
/// restore, like the board's own write.
fn restore_board(
    path: &Path,
    workspace_id: &str,
    bytes: &[u8],
    backup: KanbanFile,
    backup_written_ms: i64,
) -> Result<(Vec<KanbanCard>, PathBuf, usize), (String, Option<PathBuf>)> {
    let from = backup.version;
    let Some((mut cards, _)) = migrate_board(backup, workspace_id) else {
        return Err((format!("its backup has version {from}"), None));
    };
    settle_after_restart(&mut cards, workspace_id);
    // T4: the lost save may have been the one that turned it off.
    let auto_merge_off = crate::pr_merge::turn_off_on_restore(&mut cards);
    let kept = crate::atomic::keep_unreadable_copy(path, bytes).map_err(|e| (e, None))?;
    let marker = RestoredMarker {
        backup_written_ms,
        kept_as: kept.display().to_string(),
        said: false,
        pulled: false,
        auto_merge_off,
    };
    let marker_path = restored_marker_path(path);
    if let Err(e) = crate::atomic::write_atomic_json(&marker_path, &marker) {
        return Err((format!("write {}: {e}", marker_path.display()), Some(kept)));
    }
    let file = KanbanFile { version: KANBAN_SCHEMA_VERSION, cards };
    // The plain atomic writer, not `write_board`: nothing is rolled into
    // `.bak`, which stays the copy these cards came from.
    match crate::atomic::write_atomic_json(path, &file) {
        Ok(()) => Ok((file.cards, kept, auto_merge_off)),
        Err(e) => {
            // Nothing was restored: the marker has no restored board beside it.
            let _ = fs::remove_file(&marker_path);
            Err((format!("write: {e}"), Some(kept)))
        }
    }
}

/// The cards of a board file of any version this build reads, as this
/// version has them, and whether that changed anything worth writing back.
/// `None` for a version no Plyloft wrote (0); a newer one never gets here
/// ([`read_board_file`]).
fn migrate_board(parsed: KanbanFile, workspace_id: &str) -> Option<(Vec<KanbanCard>, bool)> {
    match parsed.version {
        1 => {
            // v1 → v2 migration: every Complete-column card was
            // shipped in the pre-verify world, so mark them
            // `verify_status: Legacy` + `ship_status: Shipped`
            // so the new UI doesn't try to gate them on verify.
            // In-progress / todo / in-review cards keep defaults.
            let mut cards = parsed.cards;
            let mut legacy_count = 0usize;
            for card in cards.iter_mut() {
                if matches!(card.column_id, KanbanColumnId::Complete) {
                    card.verify_status = VerifyStatus::Legacy;
                    card.ship_status = ShipStatus::Shipped;
                    legacy_count += 1;
                }
            }
            log::info!(
                "kanban: migrated workspace {workspace_id} v1 → v{KANBAN_SCHEMA_VERSION} ({legacy_count} legacy complete card(s) marked shipped)"
            );
            Some((cards, true))
        }
        // v2 → v3 (`attachments`), v3 → v4 (Cycle A: `worktree_path`,
        // `branch_name`), v4 → v5 (Cycle E4: `intake_history`), v5 → v6
        // (Cycle H: `linked_brainstorm_id`), v6 → v7 (`dismissed_banners`),
        // v7 → v8 (Cycle 3: the GitHub-Issues-backing fields): every field
        // defaults through `#[serde(default)]`. The arm only says the file
        // is to be rewritten under the current version stamp.
        from if (2..KANBAN_SCHEMA_VERSION).contains(&from) => {
            log::info!("kanban: migrated workspace {workspace_id} v{from} → v{KANBAN_SCHEMA_VERSION} (new fields defaulted)");
            Some((parsed.cards, true))
        }
        KANBAN_SCHEMA_VERSION => Some((parsed.cards, false)),
        other => {
            log::warn!(
                "kanban: workspace {workspace_id} has version {other} (expected ≤{KANBAN_SCHEMA_VERSION}); ignoring"
            );
            None
        }
    }
}

/// What no card keeps across a restart: an Active intake (v1.7.0: its PTY is
/// gone) is reset, a Builder's `pty_id` is cleared and the card reads
/// "session lost" (v1.106.0), a running setup or build-with-both lane is
/// settled. Returns whether any card changed.
fn settle_after_restart(cards: &mut [KanbanCard], workspace_id: &str) -> bool {
    let mut had_active = false;
    for c in cards.iter_mut() {
        if matches!(c.intake_status, IntakeStatus::Active) {
            c.intake_status = IntakeStatus::None;
            had_active = true;
        }
        let mut lost_at = None;
        if let Some(b) = c.builder.as_mut() {
            if b.pty_id.is_some() {
                b.pty_id = None;
                b.session_lost = true;
                b.lost_on_restart = true;
                had_active = true;
                lost_at = Some(b.started_at);
            }
        }
        // 1.169.0 (A3): a retry's session ended with the app ("ended").
        if let Some(started) = lost_at {
            crate::retry_on::settle_builder_retry(c, started);
        }
        // SL-4: a setup that was running when Plyloft quit failed.
        if crate::worktree_setup::settle_interrupted(&mut c.worktree_setup, workspace_id, &c.id) {
            had_active = true;
        }
        // SL-6: the same for both builds of a card built by both.
        if let Some(bb) = c.build_both.as_mut() {
            if crate::build_both::settle_on_load(bb, workspace_id, &c.id) {
                had_active = true;
            }
        }
    }
    had_active
}

/// 1.172.0 (A1): why a landed card's later requests can't be removed (the
/// card page's done line, `followUp.ts::doneBriefLine`).
pub const LATER_REQUESTS_DONE: &str = "This card is done, so what it asked for stays as it was.";

/// 1.174.0 A2 (P7): where a card's work is — sent is not landed. The
/// frontend's `cardLifecycle.ts::cardDelivery`; both are held to
/// `src/lib/cardDelivery.fixtures.json`. No field of its own: derived from
/// `ship_status`, `review_status` (`Merged` also marks a pull request
/// opened, `set_pr_url`), `pr_url` and `pr.state`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardDelivery {
    /// Never shipped.
    NotSent,
    /// In a pull request still open, or closed without merging: not done.
    Sent,
    /// On the target branch: its pull request merged, or shipped on this
    /// Mac. A pull request shipped before SL-1 (a `pr_url`, no `pr`) counts
    /// as landed, as it always did.
    Landed,
}

pub fn card_delivery(card: &KanbanCard) -> CardDelivery {
    use crate::pr_status::PrState;
    if card.ship_status == ShipStatus::Shipped {
        return CardDelivery::Landed;
    }
    let pr = card.pr_url.as_ref().and(card.pr.as_ref());
    // Round 1: an open pull request is sent, whatever `review_status` says
    // (a review loop may have cleared its mark for a moment).
    if pr.is_some_and(|p| p.state == PrState::Open) {
        return CardDelivery::Sent;
    }
    if card.review_status == Some(ReviewStatus::Merged) {
        return match pr {
            Some(p) if p.state != PrState::Merged => CardDelivery::Sent,
            _ => CardDelivery::Landed,
        };
    }
    if pr.is_some_and(|p| p.state == PrState::Closed) {
        return CardDelivery::Sent;
    }
    CardDelivery::NotSent
}

/// UX-7.2: a card has landed — its pull request merged, or shipped on this
/// Mac. 1.174.0 A2: not while its pull request is open (`card_delivery`).
pub(crate) fn card_landed(card: &KanbanCard) -> bool {
    card_delivery(card) == CardDelivery::Landed
}

/// 1.174.0 A2: Ship it went through — the card landed, or its pull request
/// is open (what `card_landed` meant before 1.174.0). The skill cards'
/// rules read this; "done" is `card_landed`. The frontend's
/// `cardShippedOrPrOpen`.
pub(crate) fn card_shipped_or_pr_open(card: &KanbanCard) -> bool {
    matches!(card.ship_status, ShipStatus::Shipped)
        || matches!(card.review_status, Some(ReviewStatus::Merged))
}

/// UX-7.2: the blockers of `card` that still hold it back: on this board,
/// not archived, not landed (1.174.0 A2: a blocker in an open pull request
/// holds it until the merge). Unknown ids (a card deleted) hold no one.
pub fn unshipped_blockers<'a>(cards: &'a [KanbanCard], card: &KanbanCard) -> Vec<&'a KanbanCard> {
    card.blocked_by
        .iter()
        .filter_map(|id| cards.iter().find(|c| &c.id == id))
        .filter(|b| !b.archived && !card_landed(b))
        .collect()
}

/// "Starts when “A” ships." / "Starts when “A” and “B” ship." — the words
/// the card and the backend say for a held start. 1.174.0 A2: a blocker in
/// an open pull request "merges" ("Starts when “A” merges.").
pub fn start_refusal_message(blockers: &[&KanbanCard]) -> Option<String> {
    match blockers {
        [] => None,
        [one] if crate::pr_status::pr_open_on_card(one) => Some(format!("Starts when “{}” merges.", one.title)),
        [one] => Some(format!("Starts when “{}” ships.", one.title)),
        // Round 2 (owner): all of them in open pull requests.
        [first, rest @ ..] if blockers.iter().all(|b| crate::pr_status::pr_open_on_card(b)) => Some(format!(
            "Starts when “{}” and {} more merge.",
            first.title,
            rest.len()
        )),
        [first, rest @ ..] => Some(format!(
            "Starts when “{}” and {} more ship.",
            first.title,
            rest.len()
        )),
    }
}

/// UX-7.1: the blocker in `wanted` that already waits, through its own
/// blockers, for `card_id` — what would close a cycle. `None` when none does.
fn blocking_cycle(cards: &[KanbanCard], card_id: &str, wanted: &[String]) -> Option<String> {
    for start in wanted {
        let mut stack = vec![start.as_str()];
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        while let Some(id) = stack.pop() {
            if id == card_id {
                return Some(start.clone());
            }
            if !seen.insert(id) {
                continue;
            }
            if let Some(c) = cards.iter().find(|c| c.id == id) {
                stack.extend(c.blocked_by.iter().map(String::as_str));
            }
        }
    }
    None
}

/// UX-7.2: a deleted card leaves every Blocked by.
fn prune_blocker(cards: &mut [KanbanCard], removed: &str) {
    for c in cards.iter_mut() {
        c.blocked_by.retain(|id| id != removed);
    }
}

/// `worktree_ports`: a board not loaded, read for its port blocks only.
/// Nothing is cached or written; a file that doesn't parse reads as empty.
/// C17: not [`read_board_file`], so a port lookup never moves a board file;
/// the board's own load sets an unreadable one aside.
fn read_board_read_only(path: &Path) -> Vec<KanbanCard> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<KanbanFile>(&bytes).ok())
        .filter(|file| file.version <= KANBAN_SCHEMA_VERSION)
        .map(|file| file.cards)
        .unwrap_or_default()
}

/// 1.175.0 (R1): the cards of a board file the project list doesn't name,
/// for what they link (`launch_inventory`). Like [`read_board_read_only`] it
/// never moves or writes the file, but a board that can't be read is an
/// error, not an empty board: the caller prunes on what this returns. An
/// empty file is an empty board only while its backup holds no cards.
pub(crate) fn peek_board(path: &Path) -> Result<Vec<KanbanCard>, String> {
    let bytes = fs::read(path).map_err(|e| format!("read: {e}"))?;
    if bytes.is_empty() {
        return match board_card_count_at(&backup_path(path)) {
            Some(cards) if cards > 0 => Err("the file is empty and its backup holds cards".to_string()),
            _ => Ok(Vec::new()),
        };
    }
    let file: KanbanFile = serde_json::from_slice(&bytes).map_err(|e| format!("parse: {e}"))?;
    if file.version > KANBAN_SCHEMA_VERSION {
        return Err(format!("version {} is newer than {KANBAN_SCHEMA_VERSION}", file.version));
    }
    Ok(file.cards)
}

/// `worktree_ports`: the blocks `card`'s worktrees hold — its own while it
/// has a worktree, an undecided Build-with-both lane `b`'s while that lane
/// records one — each handed to `held`, except `skip` (`Some(None)`: the
/// card's own; `Some(Some(lane))`: that lane's).
fn collect_port_bases(card: &KanbanCard, skip: Option<Option<&str>>, held: &mut impl FnMut(u16)) {
    if skip != Some(None) && card.worktree_path.as_deref().is_some_and(|p| !p.is_empty()) {
        card.port_base.into_iter().for_each(&mut *held);
    }
    if let Some(bb) = card.build_both.as_ref().filter(|bb| bb.undecided()) {
        for lane in bb.lanes.iter().filter(|l| l.lane != crate::build_both::LANE_A && !l.worktree_path.is_empty()) {
            if skip != Some(Some(lane.lane.as_str())) {
                lane.port_base.into_iter().for_each(&mut *held);
            }
        }
    }
}

/// `worktree_ports`: whose worktree `worktree` is on `card` — `Some(None)`
/// its own, `Some(Some(lane))` an undecided lane `b`'s.
fn worktree_owner(card: &KanbanCard, worktree: &Path) -> Option<Option<String>> {
    if card
        .worktree_path
        .as_deref()
        .is_some_and(|p| !p.is_empty() && crate::worktree_ports::same_dir(Path::new(p), worktree))
    {
        return Some(None);
    }
    card.build_both.as_ref().filter(|bb| bb.undecided()).and_then(|bb| {
        bb.lanes
            .iter()
            .filter(|l| l.lane != crate::build_both::LANE_A && !l.worktree_path.is_empty())
            .find(|l| crate::worktree_ports::same_dir(Path::new(&l.worktree_path), worktree))
            .map(|l| Some(l.lane.clone()))
    })
}

/// v1.33.0: persist a workspace board atomically (tempfile + `rename`, via
/// `atomic::write_atomic_json`) with a one-deep rolling backup. The prior
/// file, if any, is copied to `<path>.bak` before the new bytes land —
/// cheap recovery insurance after the v1.32.x whole-board-clobber data
/// loss. The backup copy is best-effort: a failure there must not block
/// the write.
///
/// 1.175.0 (OP-2): the prior file is copied only when it is a board. One that
/// is empty or doesn't parse never replaces a backup that holds cards.
///
/// R5: the current file's length is asked first. Zero bytes is not a board,
/// and nothing of it is read; any other file is still parsed for its
/// outline (its cards counted, not built), since bytes that don't parse must
/// not replace a backup that holds cards either.
fn write_board(path: &std::path::Path, cards: &[KanbanCard]) -> Result<(), String> {
    if let Ok(current) = fs::metadata(path) {
        let bak = backup_path(path);
        let is_board = current.len() > 0 && board_card_count_at(path).is_some();
        if !is_board && board_card_count_at(&bak).is_some_and(|cards| cards > 0) {
            log::warn!("kanban: {path:?} is empty or isn't a board; its backup {bak:?} holds cards and is kept");
        } else if let Err(e) = fs::copy(path, &bak) {
            log::warn!("kanban: rolling backup copy failed for {path:?}: {e}");
        }
    }
    let file = KanbanFile {
        version: KANBAN_SCHEMA_VERSION,
        cards: cards.to_vec(),
    };
    crate::atomic::write_atomic_json(path, &file)
}

/// v1.33.0: event name carried to the frontend when a workspace board
/// changes on disk.
pub const KANBAN_CHANGED_EVENT: &str = "kanban://changed";

/// v1.33.0: notify every kanban view that a workspace board changed so a
/// stale display refreshes. Emitted by every card-mutating IPC command and
/// by the backend-side writers (run-history append, swarm completion,
/// queue pump). Payload is the workspace id; the frontend debounces a
/// single-workspace reload. Best-effort — a failed emit never blocks a
/// write.
pub fn emit_kanban_changed<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
) {
    use tauri::Emitter;
    let _ = app.emit(KANBAN_CHANGED_EVENT, workspace_id.to_string());
}

/// `worktree_ports`: a worktree's block, the workspace of the card that
/// holds it, and whether finding it wrote that board (a block handed out
/// now), so the caller can tell the board views.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortLookup {
    pub base: u16,
    pub workspace_id: String,
    pub wrote: bool,
}

pub struct KanbanStore {
    config_dir: PathBuf,
    /// In-memory cache: workspaceId → cards. Mirrors disk; saves write through.
    cache: Mutex<HashMap<String, Vec<KanbanCard>>>,
    /// A board file that could not be read this session — set aside, or
    /// replaced by its last saved copy — by workspaceId. Said once
    /// ([`Self::take_notice`]) and never forgotten before the app quits
    /// ([`Self::not_whole`]).
    unreadable: Mutex<HashMap<String, BoardTrouble>>,
}

impl KanbanStore {
    pub fn new(config_dir: PathBuf) -> Result<Self, String> {
        let dir = boards_dir(&config_dir);
        fs::create_dir_all(&dir).map_err(|e| format!("create kanban dir: {e}"))?;
        // T2: a restored marker whose board is gone remembers nothing.
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let marker = entry.path();
                let board = marker.to_str().and_then(|p| p.strip_suffix(".restored")).map(PathBuf::from);
                if board.is_some_and(|board| restored_marker_path(&board) == marker && !board.exists()) {
                    drop_stale_restored_marker(&marker.with_extension(""));
                }
            }
        }
        Ok(Self {
            config_dir,
            cache: Mutex::new(HashMap::new()),
            unreadable: Mutex::new(HashMap::new()),
        })
    }

    /// What became of the board file this workspace had that could not be
    /// read, once: the first call after it was set aside (or opened from its
    /// last saved copy) says it. The session keeps knowing
    /// ([`Self::not_whole`]).
    ///
    /// Round 6 (W3): handing it out is not saying it. The window shows the
    /// toast and then acknowledges ([`Self::note_said`]); a notice that was
    /// handed out and never shown (a quit while it waited its turn) is
    /// handed out again at the next launch.
    pub fn take_notice(&self, workspace_id: &str) -> Option<BoardNotice> {
        let mut unreadable = self.unreadable.lock();
        let trouble = unreadable.get_mut(workspace_id).filter(|trouble| !trouble.said && !trouble.handed)?;
        trouble.handed = true;
        Some(trouble.notice.clone())
    }

    /// W3: the window has shown this workspace's notice. Remembered beside
    /// the board: in its marker when it was opened from its copy, by
    /// removing the kept file's `.unsaid` when it started empty.
    pub fn note_said(&self, workspace_id: &str) {
        let path = self.workspace_path(workspace_id);
        if let Some(trouble) = self.unreadable.lock().get_mut(workspace_id).filter(|trouble| !trouble.said) {
            trouble.said = true;
            trouble.handed = true;
            trouble.sync_marker(&path);
            if !trouble.notice.restored {
                let _ = fs::remove_file(unsaid_path(&trouble.notice.kept_as));
                // And an older one of this board's: said with this notice.
                while let Some(older) = unsaid_set_aside(&path) {
                    if fs::remove_file(unsaid_path(&older)).is_err() {
                        break;
                    }
                }
            }
        }
    }

    /// W3: where the file this workspace's notice names is kept, for the
    /// notice's *Show in Finder*. `None` when its board was read as it is.
    pub fn trouble_kept_as(&self, workspace_id: &str) -> Option<PathBuf> {
        self.unreadable.lock().get(workspace_id).map(|trouble| trouble.notice.kept_as.clone())
    }

    /// Round 4 (T2): this workspace's board isn't on GitHub Issues, so there
    /// is no read from GitHub to wait for: once its notice was shown, its
    /// `<id>.json.restored` goes. The session keeps what it knows (a board
    /// that is put on GitHub Issues later this session still reads first).
    pub fn settle_local_restore(&self, workspace_id: &str) {
        let path = self.workspace_path(workspace_id);
        if let Some(trouble) = self.unreadable.lock().get_mut(workspace_id).filter(|trouble| trouble.said) {
            trouble.forget_marker(&path);
        }
    }

    /// 1.175.0 (round 4, T1): every board trouble not said yet, by workspace
    /// id, each handed out once like [`Self::take_notice`]. The window asks
    /// at launch, after the launch inventory read every listed board: a
    /// board is restored at launch whether or not its project is ever
    /// opened, and its notice must not wait for that.
    pub fn take_all_notices(&self) -> Vec<(String, BoardNotice)> {
        let mut unreadable = self.unreadable.lock();
        let mut notices: Vec<(String, BoardNotice)> = unreadable
            .iter_mut()
            .filter(|(_, trouble)| !trouble.said && !trouble.handed)
            .map(|(id, trouble)| {
                trouble.handed = true;
                (id.clone(), trouble.notice.clone())
            })
            .collect();
        notices.sort_by(|a, b| a.0.cmp(&b.0));
        notices
    }

    /// R2: where this workspace's unreadable board file is kept, when its
    /// board was set aside or opened from its last saved copy this session.
    /// The cards the store has since are then not the whole picture: an
    /// empty board, or one save behind. Nothing may be pruned, released or
    /// deleted because a card is missing from them; such a reader takes
    /// [`Self::load_whole`].
    ///
    /// T2: not a board a later launch found restored (its marker): by then
    /// the cards are read from the board's own file.
    pub fn not_whole(&self, workspace_id: &str) -> Option<PathBuf> {
        let unreadable = self.unreadable.lock();
        unreadable.get(workspace_id).filter(|trouble| !trouble.whole).map(|trouble| trouble.notice.kept_as.clone())
    }

    /// R2: one board that is [`Self::not_whole`], if any (the first by id).
    pub fn first_not_whole(&self) -> Option<(String, PathBuf)> {
        let unreadable = self.unreadable.lock();
        let (id, trouble) = unreadable.iter().filter(|(_, trouble)| !trouble.whole).min_by(|a, b| a.0.cmp(b.0))?;
        Some((id.clone(), trouble.notice.kept_as.clone()))
    }

    /// R2: [`Self::load`] for a reader that acts on a card being absent. An
    /// error while the board is [`Self::not_whole`].
    pub fn load_whole(&self, workspace_id: &str) -> Result<Vec<KanbanCard>, String> {
        let cards = self.load(workspace_id)?;
        match self.not_whole(workspace_id) {
            Some(kept_as) => Err(format!(
                "kanban: board for {workspace_id} couldn't be read this session (its file is kept as {}), so its cards aren't the whole picture",
                kept_as.display()
            )),
            None => Ok(cards),
        }
    }

    /// R2: when the backup this workspace's board was opened from this
    /// session was written (ms), and whether GitHub's issues were read since
    /// ([`Self::note_pulled`]). `None` for a board that was read as it is.
    pub fn restored_from_backup(&self, workspace_id: &str) -> Option<(i64, bool)> {
        let unreadable = self.unreadable.lock();
        let trouble = unreadable.get(workspace_id)?;
        Some((trouble.backup_written_ms?, trouble.pulled))
    }

    /// Round 6 (W1): where the unreadable file of this workspace's restore is
    /// kept — the board was opened from its last saved copy this session, or
    /// at an earlier launch that still owes its notice or its read. What
    /// else that restore sets aside is put beside it.
    pub fn restore_kept_as(&self, workspace_id: &str) -> Option<PathBuf> {
        let unreadable = self.unreadable.lock();
        let trouble = unreadable.get(workspace_id)?;
        trouble.backup_written_ms.map(|_| trouble.notice.kept_as.clone())
    }

    /// R2: the boards opened from their backup this session that GitHub's
    /// issues haven't been read for since: nothing of theirs is sent to
    /// GitHub yet (`github_sync::restored_board_holds`).
    pub fn restored_awaiting_pull(&self) -> Vec<String> {
        let unreadable = self.unreadable.lock();
        unreadable
            .iter()
            .filter(|(_, trouble)| trouble.backup_written_ms.is_some() && !trouble.pulled)
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// R2: GitHub's issues were read and applied to this workspace's board.
    /// T2: remembered beside the board too, so a quit doesn't bring the
    /// hold back; the marker goes once the notice was shown as well.
    pub fn note_pulled(&self, workspace_id: &str) {
        let path = self.workspace_path(workspace_id);
        if let Some(trouble) = self.unreadable.lock().get_mut(workspace_id).filter(|trouble| !trouble.pulled) {
            trouble.pulled = true;
            trouble.sync_marker(&path);
        }
    }

    fn workspace_path(&self, workspace_id: &str) -> PathBuf {
        boards_dir(&self.config_dir).join(format!("{workspace_id}.json"))
    }

    /// Load cards for a workspace from disk (or empty if file is missing /
    /// has unknown version). Caches the result.
    ///
    /// v1.7.0: any card with `intake_status == Active` is force-reset to
    /// `None` because the originating PTY cannot survive an app restart.
    /// If any reset occurred, the cleanup is persisted atomically before
    /// caching, so the on-disk JSON does not keep advertising stale Active
    /// state.
    pub fn load(&self, workspace_id: &str) -> Result<Vec<KanbanCard>, String> {
        // C17 (round 1): held across the read, the write-back and the insert,
        // as every writer holds it, so a write between this read and the
        // insert is neither written over on disk nor dropped from the cache.
        let mut cache = self.cache.lock();
        if let Some(cards) = cache.get(workspace_id) {
            return Ok(cards.clone());
        }
        let path = self.workspace_path(workspace_id);
        // `migrated`: an older-version file was loaded, so the write-back
        // below persists the new defaults under the current schema shape.
        let (mut cards, migrated) = match read_board_file(&path, workspace_id, &self.unreadable)? {
            BoardRead::None => (Vec::new(), false),
            // R2: opened from its backup — migrated, settled and written.
            BoardRead::Restored(cards) => {
                cache.insert(workspace_id.to_string(), cards.clone());
                return Ok(cards);
            }
            BoardRead::Board(parsed) => match migrate_board(parsed, workspace_id) {
                Some(read) => read,
                // A version no Plyloft wrote (0): ignored, and not cached.
                None => return Ok(Vec::new()),
            },
        };

        // Force-reset any stale Active intake_status; persist if changed.
        // v1.106.0: same for a Builder pty_id — no PTY survives a restart,
        // so the card flips to "session lost" and offers Resume.
        let had_active = settle_after_restart(&mut cards, workspace_id);
        if migrated || had_active {
            // 1.175.0 (OP-9): through the board's one writer — the file as it
            // was before this rewrite becomes the backup, and a write that
            // fails is said in the log (the cards read stay in use).
            if let Err(e) = write_board(&path, &cards) {
                log::warn!("kanban: rewriting workspace {workspace_id}'s board after its load failed: {e}");
            }
            if had_active {
                log::info!(
                    "kanban: reset stale Active intake_status on workspace {workspace_id}"
                );
            }
        }

        cache.insert(workspace_id.to_string(), cards.clone());
        Ok(cards)
    }

    /// Persist a full set of cards for a workspace, atomically.
    ///
    /// v1.33.0: no longer an IPC target — the whole-board `kanban_save`
    /// command was removed because a stale frontend board overwrote it and
    /// lost cards. The remaining caller is `reconcile_orphan_runs`, which
    /// runs once at startup before any frontend is connected. New FE-driven
    /// writes go through `create_card` / `patch_card` / `delete_card`.
    pub fn save(&self, workspace_id: &str, cards: Vec<KanbanCard>) -> Result<(), String> {
        let path = self.workspace_path(workspace_id);
        write_board(&path, &cards)?;
        self.cache.lock().insert(workspace_id.to_string(), cards);
        Ok(())
    }

    /// Walk every workspace kanban file on disk and clear any card whose
    /// `linkedRunId` is in the supplied set. Cards matched have their
    /// `linkedRunId` cleared and `lastRunStatus` set to `failed` so the UI
    /// reflects reality after a crash that the agent registry already
    /// reconciled. Returns the number of cards updated. No-op when the set
    /// is empty.
    pub fn reconcile_orphan_runs(&self, orphan_run_ids: &[String]) -> usize {
        if orphan_run_ids.is_empty() {
            return 0;
        }
        let dir = boards_dir(&self.config_dir);
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => return 0,
        };
        let orphan_set: std::collections::HashSet<&str> =
            orphan_run_ids.iter().map(String::as_str).collect();
        let mut total_updated = 0usize;
        for entry in entries.filter_map(|r| r.ok()) {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let workspace_id = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let cards = match self.load(&workspace_id) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let mut changed = false;
            let updated: Vec<KanbanCard> = cards
                .into_iter()
                .map(|mut c| {
                    if let Some(run_id) = c.linked_run_id.as_deref() {
                        if orphan_set.contains(run_id) {
                            c.linked_run_id = None;
                            c.last_run_status = Some(LastRunStatus::Failed);
                            changed = true;
                            total_updated += 1;
                        }
                    }
                    c
                })
                .collect();
            if changed {
                if let Err(e) = self.save(&workspace_id, updated) {
                    log::warn!(
                        "kanban: reconcile_orphan_runs save failed for {workspace_id}: {e}"
                    );
                }
            }
        }
        if total_updated > 0 {
            log::info!(
                "kanban: cleared linkedRunId on {total_updated} card(s) after orphan reconcile"
            );
        }
        total_updated
    }

    /// v1.34.x: one-shot startup pass that flips each card stuck in
    /// `review_status = Merged` + `ship_status = Unshipped` to `Shipped`
    /// when a matching `Land card: <title>` commit exists on the
    /// workspace's target branch. Reconciles cards landed by the v1.31.0
    /// "Ship it = merge + go live" path that pre-dates the ship-state
    /// writeback in `commands::land_card_local` — without this pass the
    /// already-landed cards stayed Unshipped forever and the toolbar
    /// `Ship batch (N)` badge over-counted by one per stuck card.
    ///
    /// Scans the last 200 commits on `target_branch` once and matches
    /// each card's title against the subject line. A match writes the
    /// found SHA into `commit_sha`, populates `shipped_version` from
    /// `read_project_version_fn(repo_root)` (caller-supplied so this
    /// module doesn't reach into ship/project_config), pushes a fresh
    /// `ShipEntry` with `ReleaseKind::Local`, clears
    /// `worktree_path`/`branch_name`, and best-effort prunes the
    /// per-card worktree directory to its root's `.trash/`.
    ///
    /// Idempotent by predicate: a `Shipped` card never matches the
    /// scan filter, so a repeat boot is a no-op. Failure on a single
    /// card never blocks the rest — every step is logged.
    ///
    /// Returns the count of cards backfilled (mainly for tests and
    /// the post-boot log line).
    pub fn reconcile_ship_backfill(
        &self,
        workspace_id: &str,
        repo_root: &std::path::Path,
        target_branch: &str,
        cache_paths: &[String],
        read_project_version_fn: &dyn Fn(&std::path::Path) -> Option<String>,
    ) -> usize {
        let cards = match self.load(workspace_id) {
            Ok(c) => c,
            Err(e) => {
                log::warn!(
                    "kanban: reconcile_ship_backfill load failed for {workspace_id}: {e}"
                );
                return 0;
            }
        };
        let stuck: Vec<(String, String, std::path::PathBuf)> = cards
            .iter()
            .filter(|c| {
                c.review_status == Some(ReviewStatus::Merged)
                    && matches!(c.ship_status, ShipStatus::Unshipped)
                    && c.branch_name.is_some()
            })
            .map(|c| {
                let path = crate::worktrees::card_worktree_path(repo_root, &c.id, c.worktree_path.as_deref());
                (c.id.clone(), c.title.clone(), path)
            })
            .collect();
        if stuck.is_empty() {
            return 0;
        }
        // Bounded git log scan on the target branch: `<sha>\t<subject>` per
        // line. A missing target branch (a fresh repo, a bad config) is not
        // an error — we just skip the workspace.
        let log_out = match crate::platform::git_command()
            .args([
                "log",
                "-n",
                "200",
                "--format=%H%x09%s",
                target_branch,
            ])
            .current_dir(repo_root)
            .output()
        {
            Ok(o) if o.status.success() => {
                String::from_utf8_lossy(&o.stdout).to_string()
            }
            _ => {
                log::info!(
                    "kanban: reconcile_ship_backfill skipped for {workspace_id} \
                     (git log on '{target_branch}' failed at {})",
                    repo_root.display()
                );
                return 0;
            }
        };
        let version = read_project_version_fn(repo_root)
            .unwrap_or_else(|| "unknown".to_string());
        let mut backfilled = 0usize;
        for (card_id, title, path) in stuck {
            // R8: the Land commit in either form (`commit_message`).
            // Newest first, as `git log` lists them.
            let Some(sha) = log_out
                .lines()
                .filter_map(|line| line.split_once('\t'))
                .find(|(_, subject)| crate::commit_message::is_land_subject(subject, &title, &card_id))
                .map(|(sha, _)| sha.to_string())
            else {
                continue;
            };
            let sha_for_log = sha.clone();
            let version_clone = version.clone();
            let mutate_result = self.with_card(workspace_id, &card_id, move |c| {
                crate::ship::mark_card_shipped_local(c, &sha, &version_clone);
                Ok(())
            });
            match mutate_result {
                Ok(()) => {
                    backfilled += 1;
                    log::info!(
                        "kanban: backfilled ship-state for {workspace_id}/{card_id} \
                         (title={title:?}, sha={sha_for_log})"
                    );
                    // Try it (TI-2): its preview stops before its copy goes.
                    crate::try_session::stop_card_try_sessions(
                        workspace_id,
                        &card_id,
                        None,
                        crate::try_session::TryStopReason::Ship,
                    );
                    // Windows walk: a copy a program still holds is kept, and
                    // the card says so (`kept_copy`).
                    match crate::kept_copy::prune_or_keep(self, workspace_id, &card_id, repo_root, &path, cache_paths) {
                        Ok(_) => crate::verify_logs::card_worktree_removed(workspace_id, &card_id),
                        Err(e) => log::warn!(
                            "kanban: reconcile_ship_backfill worktree prune for \
                             {card_id}: {e}"
                        ),
                    }
                }
                Err(e) => {
                    log::warn!(
                        "kanban: reconcile_ship_backfill mutate failed for \
                         {workspace_id}/{card_id}: {e}"
                    );
                }
            }
        }
        if backfilled > 0 {
            log::info!(
                "kanban: reconcile_ship_backfill flipped {backfilled} card(s) to \
                 Shipped on workspace {workspace_id}"
            );
        }
        backfilled
    }

    /// v1.5.x: append a system-generated run receipt to the named card.
    /// Holds the cache mutex across load → mutate → atomic-save so two
    /// concurrent run completions on the same card serialize cleanly.
    /// Best-effort: returns `Ok(())` (with a logged warning) when the card
    /// is missing or `suppress_run_history` is set, so the exit listener
    /// never has to special-case "card was deleted between dispatch and
    /// completion".
    pub fn append_run_history(
        &self,
        workspace_id: &str,
        card_id: &str,
        mut entry: RunHistoryEntry,
    ) -> Result<(), String> {
        let path = self.workspace_path(workspace_id);
        let mut cache = self.cache.lock();

        // Ensure the workspace's cards are materialized in the cache so
        // that the modify happens against the canonical view.
        materialize_cards(&mut cache, workspace_id, &path, &self.unreadable)?;

        let cards = cache
            .get_mut(workspace_id)
            .expect("workspace cards inserted above");
        let card_idx = match cards.iter().position(|c| c.id == card_id) {
            Some(i) => i,
            None => {
                log::warn!(
                    "kanban: append_run_history skipped — card '{card_id}' not found in workspace '{workspace_id}'"
                );
                return Ok(());
            }
        };

        let card = &mut cards[card_idx];
        if card.suppress_run_history {
            return Ok(());
        }
        // Idempotent: a re-fire (e.g. exit listener and a future retry path)
        // for the same run_id is a no-op.
        if card
            .run_history
            .iter()
            .any(|e| e.run_id == entry.run_id)
        {
            return Ok(());
        }

        // 1) Middle-truncate any path that exceeds MAX_PATH_CHARS.
        for p in entry.top_paths.iter_mut() {
            if p.chars().count() > MAX_PATH_CHARS {
                *p = middle_truncate(p, MAX_PATH_CHARS);
            }
        }
        // 2) Cap the number of paths.
        if entry.top_paths.len() > MAX_TOP_PATHS {
            entry.top_paths.truncate(MAX_TOP_PATHS);
        }
        // 3) If the serialized entry exceeds 4 KB, drop top_paths and keep
        //    counts only. This is a defensive fallback for unusual cases —
        //    10 × 200-char paths plus the fixed fields fit comfortably.
        if let Ok(bytes) = serde_json::to_vec(&entry) {
            if bytes.len() > MAX_ENTRY_BYTES {
                entry.top_paths.clear();
            }
        }

        card.run_history.push(entry);
        // FIFO trim — keep at most MAX_HISTORY_ENTRIES.
        while card.run_history.len() > MAX_HISTORY_ENTRIES {
            card.run_history.remove(0);
        }
        card.updated_at = now_millis();

        // Atomic write (Hard Rule #3) through the board's one writer, so the
        // rolling backup is kept (1.175.0, OP-9). Cache is already current.
        write_board(&path, &cards[..])
    }

    /// v1.19.0 (Cycle E4): append an `IntakeRecord` to the card's
    /// `intake_history`. FIFO cap at `MAX_INTAKE_HISTORY` (10) — when the
    /// list overflows, the oldest entry is removed AND its transcript file
    /// is deleted from `<config_dir>/<transcript_path>`. Atomic kanban
    /// rewrite (Hard Rule #3); transcript deletion is best-effort and
    /// only logs on failure.
    pub fn append_intake_history(
        &self,
        workspace_id: &str,
        card_id: &str,
        record: IntakeRecord,
    ) -> Result<(), String> {
        let path = self.workspace_path(workspace_id);
        let mut cache = self.cache.lock();

        materialize_cards(&mut cache, workspace_id, &path, &self.unreadable)?;

        let cards = cache
            .get_mut(workspace_id)
            .expect("workspace cards inserted above");
        let card_idx = match cards.iter().position(|c| c.id == card_id) {
            Some(i) => i,
            None => {
                log::warn!(
                    "kanban: append_intake_history skipped — card '{card_id}' not found in workspace '{workspace_id}'"
                );
                return Ok(());
            }
        };

        let card = &mut cards[card_idx];
        card.intake_history.push(record);
        // FIFO eviction with transcript cleanup.
        while card.intake_history.len() > MAX_INTAKE_HISTORY {
            let evicted = card.intake_history.remove(0);
            if let Some(rel_path) = &evicted.transcript_path {
                let abs = self.config_dir.join(rel_path);
                if let Err(e) = fs::remove_file(&abs) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        log::warn!(
                            "kanban: evict intake transcript {} failed: {e}",
                            abs.display()
                        );
                    }
                }
            }
        }
        card.updated_at = now_millis();

        // 1.175.0 (OP-9): the board's one writer, rolling backup included.
        write_board(&path, &cards[..])
    }

    /// v1.5.x: clear all run-history entries for a card. Used by the UI
    /// "Clear history" button. Atomic write through the cache mutex.
    pub fn clear_run_history(
        &self,
        workspace_id: &str,
        card_id: &str,
    ) -> Result<(), String> {
        let path = self.workspace_path(workspace_id);
        let mut cache = self.cache.lock();
        materialize_cards(&mut cache, workspace_id, &path, &self.unreadable)?;
        let cards = cache
            .get_mut(workspace_id)
            .expect("workspace cards inserted above");
        let mut changed = false;
        if let Some(card) = cards.iter_mut().find(|c| c.id == card_id) {
            if !card.run_history.is_empty() {
                card.run_history.clear();
                card.updated_at = now_millis();
                changed = true;
            }
        }
        if !changed {
            return Ok(());
        }
        // 1.175.0 (OP-9): the board's one writer, rolling backup included.
        write_board(&path, &cards[..])
    }

    /// v1.10.0: append a `CardAttachment` to a card's `attachments` vec.
    /// Holds the cache mutex across load → mutate → atomic-save so two
    /// concurrent attachment adds on the same card serialize cleanly.
    /// Errors when the card is missing — the caller (the IPC command) has
    /// already materialized bytes to disk and surfaces the error so the
    /// FE doesn't show a phantom row.
    pub fn push_attachment(
        &self,
        workspace_id: &str,
        card_id: &str,
        attachment: CardAttachment,
    ) -> Result<(), String> {
        self.mutate_card(workspace_id, card_id, move |card| {
            card.attachments.push(attachment);
            Ok(())
        })
    }

    /// v1.10.0: remove a `CardAttachment` by id and return the removed
    /// entry so the caller can best-effort delete the file from disk.
    /// Returns `Ok(None)` when the card or attachment id is missing —
    /// idempotent so the FE doesn't have to special-case races.
    pub fn remove_attachment(
        &self,
        workspace_id: &str,
        card_id: &str,
        attachment_id: &str,
    ) -> Result<Option<CardAttachment>, String> {
        let mut removed: Option<CardAttachment> = None;
        let res = self.mutate_card(workspace_id, card_id, |card| {
            if let Some(idx) =
                card.attachments.iter().position(|a| a.id == attachment_id)
            {
                removed = Some(card.attachments.remove(idx));
            }
            Ok(())
        });
        // If the card was missing, mutate_card returned an error — convert
        // that to Ok(None) so the call is idempotent on a deleted card.
        match res {
            Ok(()) => Ok(removed),
            Err(e) if e.contains("not found") => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// v1.10.0 (Cycle A): set a card's column to InProgress and stamp
    /// its `worktree_path` + `branch_name`. Idempotent — re-running
    /// against an already-advanced card is a no-op for the worktree
    /// fields (they're only written when `None`) but still ensures the
    /// column is InProgress. Returns the updated card so the IPC layer
    /// can hand it to the FE without a separate `load`.
    pub fn advance_to_in_progress(
        &self,
        workspace_id: &str,
        card_id: &str,
        worktree_path: String,
        branch_name: String,
        base: Option<crate::worktrees::WorktreeBase>,
    ) -> Result<KanbanCard, String> {
        let mut updated: Option<KanbanCard> = None;
        self.mutate_card(workspace_id, card_id, |card| {
            // G4: a template that never ran stays behind in Todo.
            if card.column_id != KanbanColumnId::InProgress {
                drop_unstarted_swarm_template(card);
            }
            card.column_id = KanbanColumnId::InProgress;
            if card.worktree_path.is_none() {
                card.worktree_path = Some(worktree_path);
                card.worktree_base = base;
            }
            if card.branch_name.is_none() {
                card.branch_name = Some(branch_name);
            }
            updated = Some(card.clone());
            Ok(())
        })?;
        updated.ok_or_else(|| "advance_to_in_progress did not capture card".to_string())
    }

    /// v1.10.0 (Cycle A): flip `archived` true and clear worktree fields.
    /// Caller (`commands::kanban_card_archive`) is responsible for
    /// invoking `worktrees::prune_for_card` BEFORE calling this; on
    /// success here, the card no longer references the (possibly
    /// already-trashed) worktree.
    pub fn archive_card(
        &self,
        workspace_id: &str,
        card_id: &str,
        auto: bool,
    ) -> Result<KanbanCard, String> {
        let mut updated: Option<KanbanCard> = None;
        self.mutate_card(workspace_id, card_id, |card| {
            // UX-5.8: the auto-archive re-checks under the cache lock — a
            // card restored, reopened or moved since the Board looked is
            // left alone.
            if auto && !auto_archive_eligible(card, now_millis()) {
                return Err(AUTO_ARCHIVE_NOT_ELIGIBLE.to_string());
            }
            card.archived = true;
            card.archived_at = Some(now_millis());
            card.auto_archived = auto;
            card.worktree_path = None;
            card.branch_name = None;
            card.worktree_base = None;
            card.worktree_setup = None;
            // N14 walk F11: archiving is not a review. It used to stamp
            // `review_status: merged` (a 2026-05 belt for the attention
            // rows, which now skip archived cards themselves), so a card
            // archived unshipped read as landed (`card_landed`). The
            // review status stays what it was.
            updated = Some(card.clone());
            Ok(())
        })?;
        updated.ok_or_else(|| "archive_card did not capture card".to_string())
    }

    /// UX-5.8: bring an archived card back to the Board. A card the
    /// auto-archive took, or one that shipped, lands in Done; QoL 1.168 S1-3:
    /// any other archived card lands where its state puts it. `archived_at`
    /// is kept, so the auto-archive does not take it again; the person can
    /// still archive it by hand.
    pub fn restore_card(
        &self,
        workspace_id: &str,
        card_id: &str,
    ) -> Result<KanbanCard, String> {
        let mut updated: Option<KanbanCard> = None;
        self.mutate_card(workspace_id, card_id, |card| {
            if !card.archived {
                return Err("This card is not archived.".to_string());
            }
            if !card_restorable(card) {
                return Err(RESTORE_REFUSAL.to_string());
            }
            card.archived = false;
            card.auto_archived = false;
            if card.archived_at.is_none() {
                card.archived_at = Some(now_millis());
            }
            // N18: a card back on the Board owns its branch again — the
            // archive's pending cleanup (the Inbox ask) is settled as
            // restored, keeping the branch's name for its next Start build.
            if let Some(rec) = card.branch_cleanup.as_mut().filter(|r| {
                r.pending() && r.reason == crate::branch_cleanup::CleanupReason::Archived
            }) {
                rec.outcome = Some(crate::branch_cleanup::CleanupOutcome::Restored);
                rec.outcome_at = Some(now_millis());
                rec.asking = false;
            }
            updated = Some(card.clone());
            Ok(())
        })?;
        updated.ok_or_else(|| "restore_card did not capture card".to_string())
    }

    /// Clear a card's worktree handle (`worktree_path`, `branch_name`,
    /// `worktree_base`) and nothing else: its column and `archived` stay.
    /// For a worktree that is gone — deleted from the Worktrees panel or
    /// pruned — so the card doesn't keep pointing at a missing directory.
    pub fn clear_worktree_handle(
        &self,
        workspace_id: &str,
        card_id: &str,
    ) -> Result<KanbanCard, String> {
        let mut updated: Option<KanbanCard> = None;
        self.mutate_card(workspace_id, card_id, |card| {
            card.worktree_path = None;
            card.branch_name = None;
            card.worktree_base = None;
            // SL-4: the setup record describes the worktree that went.
            card.worktree_setup = None;
            updated = Some(card.clone());
            Ok(())
        })?;
        updated.ok_or_else(|| "clear_worktree_handle did not capture card".to_string())
    }

    /// [`Self::clear_worktree_handle`], only while the card still records
    /// `path` as its `worktree_path` (`None`: still no path) and that path
    /// is still missing on disk — re-checked under the cache mutex, so a
    /// card start that recreated or set a worktree meanwhile keeps it.
    /// Returns whether the handle was cleared; no write when not.
    pub fn clear_dangling_worktree_handle(
        &self,
        workspace_id: &str,
        card_id: &str,
        path: Option<&str>,
    ) -> Result<bool, String> {
        let board = self.workspace_path(workspace_id);
        let mut cache = self.cache.lock();
        let cards = materialize_cards(&mut cache, workspace_id, &board, &self.unreadable)?;
        let Some(card) = cards.iter_mut().find(|c| c.id == card_id) else {
            return Ok(false);
        };
        if card.worktree_path.as_deref() != path
            || path.is_some_and(|p| std::path::Path::new(p).exists())
            || (card.branch_name.is_none() && card.worktree_base.is_none() && path.is_none())
        {
            return Ok(false);
        }
        card.worktree_path = None;
        card.branch_name = None;
        card.worktree_base = None;
        card.worktree_setup = None;
        card.updated_at = now_millis();
        write_board(&board, &cards[..])?;
        Ok(true)
    }

    /// v1.31.0 (Cycle 1 — Review surface): set a card's `review_status`,
    /// optionally replacing `review_decisions`. The single backend writer
    /// of these fields. `decisions: None` leaves the existing verdicts
    /// untouched; `Some(vec)` replaces them (an empty vec clears them).
    pub fn set_card_review(
        &self,
        workspace_id: &str,
        card_id: &str,
        status: Option<ReviewStatus>,
        decisions: Option<Vec<ReviewDecision>>,
    ) -> Result<KanbanCard, String> {
        let mut updated: Option<KanbanCard> = None;
        self.mutate_card(workspace_id, card_id, |card| {
            card.review_status = status;
            // P-E: the conflict's record lives only beside its status.
            if status != Some(ReviewStatus::ConflictBlocked) {
                card.ship_conflict = None;
            }
            if let Some(d) = decisions {
                card.review_decisions = d;
            }
            updated = Some(card.clone());
            Ok(())
        })?;
        updated.ok_or_else(|| "set_card_review did not capture card".to_string())
    }

    /// v1.31.0 (Cycle 1): stamp a card after a reject-with-feedback
    /// follow-up swarm is dispatched — re-points `linked_swarm_id`, flips
    /// `last_run_status` to Running and `review_status` to
    /// `ChangesRequested`, and records the rejected hunks as
    /// `review_decisions`.
    pub fn mark_review_followup(
        &self,
        workspace_id: &str,
        card_id: &str,
        swarm_id: &str,
        decisions: Vec<ReviewDecision>,
    ) -> Result<(), String> {
        self.mutate_card(workspace_id, card_id, |card| {
            card.linked_swarm_id = Some(swarm_id.to_string());
            card.linked_run_id = None;
            card.last_run_status = Some(LastRunStatus::Running);
            card.review_status = Some(ReviewStatus::ChangesRequested);
            card.review_decisions = decisions;
            Ok(())
        })
    }

    /// v1.31.0 (Cycle 1): when a follow-up swarm linked to a card whose
    /// `review_status` is `ChangesRequested` reaches a terminal state, the
    /// diff has moved — clear the now-stale `review_decisions` and reset
    /// `review_status` to `Pending` so the reviewer re-reviews the fresh
    /// diff. No-op for cards not in `ChangesRequested` (e.g. the original
    /// swarm's completion). Returns true if the card was reset.
    pub fn clear_review_after_followup(
        &self,
        workspace_id: &str,
        card_id: &str,
    ) -> Result<bool, String> {
        let mut reset = false;
        self.mutate_card(workspace_id, card_id, |card| {
            if card.review_status == Some(ReviewStatus::ChangesRequested) {
                // v1.154.1 (M5): back to the card's open pull request, if any.
                card.review_status =
                    crate::pr_status::cleared_review_status(card).or(Some(ReviewStatus::Pending));
                card.review_decisions.clear();
                reset = true;
            }
            Ok(())
        })?;
        Ok(reset)
    }

    /// v1.31.0 (Outcome screen, Phase 3): record that a card shipped as a
    /// GitHub PR — stores the PR URL and marks the review `Merged` (the
    /// card's work has left for the pull request).
    pub fn mark_card_pr_shipped(
        &self,
        workspace_id: &str,
        card_id: &str,
        pr_url: &str,
        pushed_head: Option<&str>,
    ) -> Result<(), String> {
        self.mutate_card(workspace_id, card_id, |card| {
            // SL-1: the PR's state starts open, not yet read from GitHub (the
            // poller reads it on its next tick). Linking the PR the card
            // already records keeps what is known of it.
            let number = crate::pr_status::pr_number_from_url(pr_url);
            let same = card.pr_url.as_deref() == Some(pr_url)
                && card.pr.as_ref().is_some_and(|p| {
                    Some(p.number) == number && p.state == crate::pr_status::PrState::Open
                });
            if !same {
                card.pr = number.map(|n| {
                    let mut pr = crate::pr_status::PrStatus::opened(n, now_millis());
                    // v1.154.1 (walk I1): the head the ship pushed — the wait
                    // for checks ends on that commit's checks.
                    pr.pushed_head = pushed_head.map(str::to_string).filter(|h| !h.is_empty());
                    pr
                });
            } else if let Some(pr) = card.pr.as_mut() {
                // v1.154.1 (walk I1): the ship pushed `pushed_head` to that
                // pull request; its checks are awaited again, until GitHub
                // shows checks on that head.
                pr.mark_pushed(pushed_head.unwrap_or(""), now_millis());
            }
            card.pr_url = Some(pr_url.to_string());
            card.review_status = Some(ReviewStatus::Merged);
            Ok(())
        })
    }

    /// SL-1: write a read of the card's pull request (`pr_status`). `f`
    /// returns its value and how to write it: `Stamp` writes and moves
    /// `updated_at`; `Quiet` writes without it (a poll that finds nothing new
    /// is not an update of the card); `Skip` writes nothing and leaves the
    /// board as it was. Returns the card as `f` left it (with `Skip`, what
    /// the caller may show but the board doesn't hold).
    pub fn update_card_pr<T>(
        &self,
        workspace_id: &str,
        card_id: &str,
        f: impl FnOnce(&mut KanbanCard) -> Result<(T, crate::pr_status::PrWrite), String>,
    ) -> Result<(KanbanCard, T), String> {
        use crate::pr_status::PrWrite;
        let path = self.workspace_path(workspace_id);
        let mut cache = self.cache.lock();
        let cards = materialize_cards(&mut cache, workspace_id, &path, &self.unreadable)?;
        let idx = cards
            .iter()
            .position(|c| c.id == card_id)
            .ok_or_else(|| format!("card '{card_id}' not found in workspace '{workspace_id}'"))?;
        let before = cards[idx].clone();
        let (value, write) = match f(&mut cards[idx]) {
            Ok(done) => done,
            Err(e) => {
                cards[idx] = before;
                return Err(e);
            }
        };
        let after = cards[idx].clone();
        match write {
            PrWrite::Skip => {
                cards[idx] = before;
                return Ok((after, value));
            }
            PrWrite::Stamp => cards[idx].updated_at = now_millis(),
            PrWrite::Quiet => {}
        }
        if let Err(e) = write_board(&path, &cards[..]) {
            cards[idx] = before;
            return Err(e);
        }
        Ok((cards[idx].clone(), value))
    }

    /// v1.10.0 (Cycle A): read a single card. Used by the lifecycle IPC
    /// commands to fetch the title (for branch slug derivation) before
    /// invoking the worktree create.
    pub fn get_card(
        &self,
        workspace_id: &str,
        card_id: &str,
    ) -> Result<KanbanCard, String> {
        let cards = self.load(workspace_id)?;
        cards
            .into_iter()
            .find(|c| c.id == card_id)
            .ok_or_else(|| {
                format!("card '{card_id}' not found in workspace '{workspace_id}'")
            })
    }

    /// v1.33.0: append a brand-new card to a workspace board. The single
    /// FE-driven card-creation path — replaces the `addCard` →
    /// whole-board-`kanban_save` overwrite. Holds the cache mutex across
    /// materialize → push → write, so a card created here can never drop
    /// a card a concurrent writer added. Rejects a duplicate id rather than
    /// silently overwriting.
    pub fn create_card(
        &self,
        workspace_id: &str,
        card: KanbanCard,
    ) -> Result<KanbanCard, String> {
        let path = self.workspace_path(workspace_id);
        let mut cache = self.cache.lock();
        let cards = materialize_cards(&mut cache, workspace_id, &path, &self.unreadable)?;
        if cards.iter().any(|c| c.id == card.id) {
            return Err(format!(
                "card '{}' already exists in workspace '{workspace_id}'",
                card.id
            ));
        }
        cards.push(card.clone());
        write_board(&path, &cards[..])?;
        Ok(card)
    }

    /// 1.175.0 (R5): [`Self::create_card`] for several cards in one write —
    /// what one read of a GitHub Issues board adds (`github_sync`), which
    /// used to rewrite the whole board, and roll its backup, once per card.
    /// A card whose id is already on the board, or earlier in `new`, is
    /// skipped and said in the log, as a racing create was. Returns how
    /// many were added; a write that fails adds none, here or on disk.
    pub fn create_cards(&self, workspace_id: &str, new: Vec<KanbanCard>) -> Result<usize, String> {
        let path = self.workspace_path(workspace_id);
        let mut cache = self.cache.lock();
        let cards = materialize_cards(&mut cache, workspace_id, &path, &self.unreadable)?;
        let before = cards.len();
        for card in new {
            if cards.iter().any(|c| c.id == card.id) {
                log::warn!("kanban: card '{}' already exists in workspace '{workspace_id}'; not created again", card.id);
                continue;
            }
            cards.push(card);
        }
        let added = cards.len() - before;
        if added == 0 {
            return Ok(0);
        }
        if let Err(e) = write_board(&path, &cards[..]) {
            cards.truncate(before);
            return Err(e);
        }
        Ok(added)
    }

    /// N19: `Follow up` on a shipped card — creates `card` (a fresh To do
    /// card, `KanbanCard::new`) linked to `original_id`, and records the link
    /// on the original, in one write under the cache lock. Refuses a card
    /// that has not landed (shipped, or its pull request merged) and a
    /// duplicate id. The original keeps everything else as it was, its
    /// `updated_at` too. Returns the new card.
    pub fn create_follow_up(
        &self,
        workspace_id: &str,
        original_id: &str,
        mut card: KanbanCard,
    ) -> Result<KanbanCard, String> {
        let path = self.workspace_path(workspace_id);
        let mut cache = self.cache.lock();
        let cards = materialize_cards(&mut cache, workspace_id, &path, &self.unreadable)?;
        if cards.iter().any(|c| c.id == card.id) {
            return Err(format!(
                "card '{}' already exists in workspace '{workspace_id}'",
                card.id
            ));
        }
        let original = cards
            .iter_mut()
            .find(|c| c.id == original_id)
            .ok_or_else(|| format!("card '{original_id}' not found in workspace '{workspace_id}'"))?;
        if !follow_up_allowed(original) {
            return Err(FOLLOW_UP_NOT_SHIPPED.to_string());
        }
        let at = now_millis();
        card.follows_up = Some(CardFollowLink {
            card_id: original.id.clone(),
            title: original.title.clone(),
            at,
        });
        original.followed_up_by.push(CardFollowLink {
            card_id: card.id.clone(),
            title: card.title.clone(),
            at,
        });
        cards.push(card.clone());
        write_board(&path, &cards[..])?;
        Ok(card)
    }

    /// N19 + ADR 0006: record the follow-up link on a card `Ship with
    /// follow-up` made (`commands::ensure_follow_up_card`) — the new card's
    /// `follows_up` and the shipped card's `followed_up_by` — in one write.
    /// Idempotent: a retried ship adds nothing. No landed check (the link is
    /// made before the ship lands) and no `updated_at` bump on either card.
    pub fn link_follow_up(
        &self,
        workspace_id: &str,
        original_id: &str,
        follow_id: &str,
    ) -> Result<(), String> {
        let path = self.workspace_path(workspace_id);
        let mut cache = self.cache.lock();
        let cards = materialize_cards(&mut cache, workspace_id, &path, &self.unreadable)?;
        let (Some(oi), Some(fi)) = (
            cards.iter().position(|c| c.id == original_id),
            cards.iter().position(|c| c.id == follow_id),
        ) else {
            return Err(format!("card '{original_id}' or '{follow_id}' not found in workspace '{workspace_id}'"));
        };
        let at = now_millis();
        let mut changed = false;
        if cards[fi].follows_up.is_none() {
            let title = cards[oi].title.clone();
            cards[fi].follows_up = Some(CardFollowLink { card_id: original_id.to_string(), title, at });
            changed = true;
        }
        if !cards[oi].followed_up_by.iter().any(|l| l.card_id == follow_id) {
            let title = cards[fi].title.clone();
            cards[oi].followed_up_by.push(CardFollowLink { card_id: follow_id.to_string(), title, at });
            changed = true;
        }
        if changed {
            write_board(&path, &cards[..])?;
        }
        Ok(())
    }

    /// v1.33.0: remove one card by id. Idempotent — a missing card is
    /// `Ok(())` so an FE retry after an optimistic delete doesn't error.
    /// Holds the cache mutex across materialize → retain → write.
    pub fn delete_card(
        &self,
        workspace_id: &str,
        card_id: &str,
    ) -> Result<(), String> {
        let path = self.workspace_path(workspace_id);
        let mut cache = self.cache.lock();
        let cards = materialize_cards(&mut cache, workspace_id, &path, &self.unreadable)?;
        let gone = cards.iter().find(|c| c.id == card_id).map(|c| history_of_deleted(c, now_ms()));
        let before = cards.len();
        cards.retain(|c| c.id != card_id);
        if cards.len() != before {
            // UX-7.2: a deleted blocker holds no one back.
            prune_blocker(cards, card_id);
            write_board(&path, &cards[..])?;
            if let Some(gone) = gone {
                self.keep_deleted_history(workspace_id, gone, now_ms());
            }
        }
        Ok(())
    }

    /// GH #81: delete one card only if it has no GitHub issue, checked and
    /// removed under the same lock — a migration stamping an issue number
    /// between a separate check and the delete would leave that issue open.
    /// `Ok(false)` when the card carries an issue (nothing deleted); a missing
    /// card is `Ok(true)`, like [`Self::delete_card`].
    pub fn delete_card_without_issue(
        &self,
        workspace_id: &str,
        card_id: &str,
    ) -> Result<bool, String> {
        let path = self.workspace_path(workspace_id);
        let mut cache = self.cache.lock();
        let cards = materialize_cards(&mut cache, workspace_id, &path, &self.unreadable)?;
        if cards
            .iter()
            .any(|c| c.id == card_id && c.gh_issue_number.is_some())
        {
            return Ok(false);
        }
        let gone = cards.iter().find(|c| c.id == card_id).map(|c| history_of_deleted(c, now_ms()));
        let before = cards.len();
        cards.retain(|c| c.id != card_id);
        if cards.len() != before {
            prune_blocker(cards, card_id);
            write_board(&path, &cards[..])?;
            if let Some(gone) = gone {
                self.keep_deleted_history(workspace_id, gone, now_ms());
            }
        }
        Ok(true)
    }

    /// v1.33.0: merge a `CardPatch` onto one card and persist. The single
    /// FE-driven card-edit path — replaces the `updateCard` →
    /// whole-board-`kanban_save` overwrite. Only the fields present in the
    /// patch change; every backend-owned field is untouched because
    /// `CardPatch` cannot name one. Returns the patched card so the IPC
    /// layer reconciles the FE optimistic update without a reload.
    pub fn patch_card(
        &self,
        workspace_id: &str,
        card_id: &str,
        patch: CardPatch,
        author_email: Option<String>,
    ) -> Result<KanbanCard, String> {
        let mut updated: Option<KanbanCard> = None;
        self.mutate_card(workspace_id, card_id, |card| {
            // SL-6: no runner is attached to a card Claude and Codex are
            // both building.
            let adds_runner = matches!(patch.agent_config_id, Some(Some(_))) || matches!(patch.swarm_template_id, Some(Some(_)));
            if adds_runner && crate::build_both::is_undecided(card) {
                return Err(crate::build_both::UNDECIDED_REFUSAL.to_string());
            }
            // G4 (D8): no card gets a swarm template it did not already
            // have, unless a swarm already ran on it.
            if let Some(Some(template)) = patch.swarm_template_id.as_ref() {
                if card.swarm_template_id.as_ref() != Some(template)
                    && card.linked_swarm_id.is_none()
                {
                    return Err(SWARM_TEMPLATE_REFUSAL.to_string());
                }
            }
            if let Some(v) = patch.title {
                card.title = v;
            }
            if let Some(v) = patch.notes {
                card.notes = v;
            }
            if let Some(v) = patch.knowledge {
                card.knowledge = v;
            }
            // G4: a template that never ran stays behind in Todo.
            let enters_in_progress = patch.column_id == Some(KanbanColumnId::InProgress)
                && card.column_id != KanbanColumnId::InProgress;
            if let Some(v) = patch.column_id {
                card.column_id = v;
            }
            if let Some(v) = patch.agent_config_id {
                card.agent_config_id = v;
            }
            if let Some(v) = patch.swarm_template_id {
                card.swarm_template_id = v;
            }
            if enters_in_progress {
                drop_unstarted_swarm_template(card);
            }
            if let Some(v) = patch.dispatch_prompt {
                card.dispatch_prompt = v;
            }
            if let Some(v) = patch.dispatch_prompt_edited_at {
                card.dispatch_prompt_edited_at = v;
            }
            if let Some(v) = patch.dismissed_banners {
                card.dismissed_banners = v;
                let len = card.dismissed_banners.len();
                if len > MAX_DISMISSED_BANNERS {
                    card.dismissed_banners.drain(0..len - MAX_DISMISSED_BANNERS);
                }
            }
            if let Some(v) = patch.suppress_run_history {
                card.suppress_run_history = v;
            }
            if let Some(v) = patch.verify_intent {
                card.verify_intent = v;
            }
            if let Some(v) = patch.intake_status {
                card.intake_status = v;
            }
            if let Some(v) = patch.linked_brainstorm_id {
                card.linked_brainstorm_id = v;
            }
            // v1.49.0 (Team Mode Phase 0): user-driven patch — bump
            // last_edited_by from the caller's cached identity. Only
            // overwrite when an email is supplied: `None` means the
            // caller is doing internal bookkeeping (intake_status flip,
            // dispatch lifecycle, ship-state sync) and shouldn't claim
            // attribution. `author` is left alone (set on create, never
            // overwritten).
            if author_email.is_some() {
                card.last_edited_by = author_email.clone();
            }
            updated = Some(card.clone());
            Ok(())
        })?;
        updated.ok_or_else(|| "patch_card did not capture card".to_string())
    }

    /// v1.33.0: set a card's run-link fields (`linked_run_id`,
    /// `linked_swarm_id`, `last_run_status`). These are backend-owned —
    /// written by the dispatch path and the run-done listener, never a user
    /// edit — so they sit apart from `CardPatch`. Each `RunStatePatch` field
    /// is three-state: `None` leaves it, `Some(None)` clears it,
    /// `Some(Some(v))` sets it.
    pub fn set_run_state(
        &self,
        workspace_id: &str,
        card_id: &str,
        patch: RunStatePatch,
    ) -> Result<KanbanCard, String> {
        let mut updated: Option<KanbanCard> = None;
        self.mutate_card(workspace_id, card_id, |card| {
            if let Some(v) = patch.linked_run_id {
                card.linked_run_id = v;
            }
            if let Some(v) = patch.linked_swarm_id {
                card.linked_swarm_id = v;
            }
            if let Some(v) = patch.last_run_status {
                card.last_run_status = v;
            }
            updated = Some(card.clone());
            Ok(())
        })?;
        updated.ok_or_else(|| "set_run_state did not capture card".to_string())
    }

    /// v1.57.0 (Cycle 3 — increment 3a): set a card's GitHub-Issues sync
    /// bookkeeping (`gh_issue_number`, `sync_pending`, `gh_raw_remainder`).
    /// Backend-owned — written by the reconcile applier and the per-card
    /// sync hooks, never a user edit — so it sits apart from `CardPatch`.
    /// Each field is three-state: `None` leaves it, `Some(None)` clears it
    /// (for the `Option` fields), `Some(v)` sets it. Does NOT bump
    /// `last_edited_by` (mechanical bookkeeping, not a person's edit).
    pub fn set_github_sync(
        &self,
        workspace_id: &str,
        card_id: &str,
        gh_issue_number: Option<Option<u64>>,
        sync_pending: Option<bool>,
        gh_raw_remainder: Option<Option<String>>,
    ) -> Result<KanbanCard, String> {
        let mut updated: Option<KanbanCard> = None;
        self.mutate_card(workspace_id, card_id, |card| {
            if let Some(v) = gh_issue_number {
                card.gh_issue_number = v;
            }
            if let Some(v) = sync_pending {
                card.sync_pending = v;
            }
            if let Some(v) = gh_raw_remainder {
                card.gh_raw_remainder = v;
            }
            updated = Some(card.clone());
            Ok(())
        })?;
        updated.ok_or_else(|| "set_github_sync did not capture card".to_string())
    }

    /// GH #66: set or clear [`KanbanCard::gh_labels_pending`]. Bookkeeping,
    /// like [`Self::set_github_sync`]; writes nothing when unchanged.
    pub fn set_gh_labels_pending(
        &self,
        workspace_id: &str,
        card_id: &str,
        pending: bool,
    ) -> Result<(), String> {
        if self.get_card(workspace_id, card_id)?.gh_labels_pending == pending {
            return Ok(());
        }
        self.mutate_card(workspace_id, card_id, |card| {
            card.gh_labels_pending = pending;
            Ok(())
        })
    }

    /// 1.175.0 (B3): record where the card's issue text comes from, as a
    /// read of GitHub said it. Backend-owned bookkeeping like
    /// [`Self::set_gh_author`]; writes nothing when unchanged, and returns
    /// whether it wrote.
    pub fn set_gh_origin(&self, workspace_id: &str, card_id: &str, origin: crate::issue_text::Origin) -> Result<bool, String> {
        let card = self.get_card(workspace_id, card_id)?;
        if card.gh_author_association == origin.association && card.gh_last_editor == origin.editor {
            return Ok(false);
        }
        self.mutate_card(workspace_id, card_id, |card| {
            card.gh_author_association = origin.association;
            card.gh_last_editor = origin.editor;
            Ok(())
        })?;
        Ok(true)
    }

    /// 1.175.0 (D2): set or clear [`KanbanCard::unassign_pending`].
    /// Bookkeeping, like [`Self::set_gh_labels_pending`]; writes nothing
    /// when unchanged.
    pub fn set_unassign_pending(
        &self,
        workspace_id: &str,
        card_id: &str,
        pending: bool,
    ) -> Result<(), String> {
        if self.get_card(workspace_id, card_id)?.unassign_pending == pending {
            return Ok(());
        }
        self.mutate_card(workspace_id, card_id, |card| {
            card.unassign_pending = pending;
            Ok(())
        })
    }

    /// GH #66: store the backing issue's assignee logins. Backend-owned
    /// bookkeeping like [`Self::set_github_sync`] (no `last_edited_by`).
    /// Writes nothing when the list is unchanged; returns whether it wrote.
    pub fn set_gh_assignees(
        &self,
        workspace_id: &str,
        card_id: &str,
        logins: Vec<String>,
    ) -> Result<bool, String> {
        if self.get_card(workspace_id, card_id)?.gh_assignees == logins {
            return Ok(false);
        }
        self.mutate_card(workspace_id, card_id, |card| {
            card.gh_assignees = logins;
            Ok(())
        })?;
        Ok(true)
    }

    /// N14 (item 6): store the backing issue's author login. Backend-owned
    /// bookkeeping like [`Self::set_gh_assignees`]. Writes nothing when it
    /// is unchanged; returns whether it wrote.
    pub fn set_gh_author(
        &self,
        workspace_id: &str,
        card_id: &str,
        login: Option<String>,
    ) -> Result<bool, String> {
        if self.get_card(workspace_id, card_id)?.gh_author == login {
            return Ok(false);
        }
        self.mutate_card(workspace_id, card_id, |card| {
            card.gh_author = login;
            Ok(())
        })?;
        Ok(true)
    }

    /// 1.173.0 (C2): store the claim marker read from the card's issue.
    /// Backend-owned bookkeeping like [`Self::set_gh_assignees`]. Writes
    /// nothing when it is unchanged; returns whether it wrote.
    /// `mine` is this computer's id in the repository's markers.
    pub fn set_gh_claim(
        &self,
        workspace_id: &str,
        card_id: &str,
        claim: Option<crate::device_claim::DeviceClaim>,
        mine: Option<&str>,
    ) -> Result<bool, String> {
        let mut probe = self.get_card(workspace_id, card_id)?;
        if !probe.take_gh_claim(claim.clone(), mine) {
            return Ok(false);
        }
        self.mutate_card(workspace_id, card_id, |card| {
            card.take_gh_claim(claim, mine);
            Ok(())
        })?;
        Ok(true)
    }

    /// "Use as brief": move the card's cached issue remainder into `notes`
    /// (appended below existing notes) and clear the remainder, so the issue
    /// write-back carries the text once, inside the notes block. A user edit:
    /// stamps `last_edited_by` like `patch_card`. Errors if there is no
    /// remainder.
    pub fn adopt_gh_remainder(
        &self,
        workspace_id: &str,
        card_id: &str,
        author_email: Option<String>,
    ) -> Result<KanbanCard, String> {
        let mut updated: Option<KanbanCard> = None;
        self.mutate_card(workspace_id, card_id, |card| {
            let remainder = card
                .gh_raw_remainder
                .take()
                .filter(|r| !r.trim().is_empty())
                .ok_or_else(|| "This card has no issue text outside its brief.".to_string())?;
            card.notes = Some(crate::github::notes_with_remainder(
                card.notes.as_deref(),
                &remainder,
            ));
            if author_email.is_some() {
                card.last_edited_by = author_email.clone();
            }
            updated = Some(card.clone());
            Ok(())
        })?;
        updated.ok_or_else(|| "adopt_gh_remainder did not capture card".to_string())
    }

    /// N18: [`Self::with_card`] without touching `updated_at` — the branch
    /// sweep's book-keeping is not an edit of the card.
    pub fn with_card_unstamped(
        &self,
        workspace_id: &str,
        card_id: &str,
        mutate: impl FnOnce(&mut KanbanCard) -> Result<(), String>,
    ) -> Result<(), String> {
        self.mutate_card_stamped(workspace_id, card_id, false, mutate)
    }

    /// N18: record the card's branch for the cleanup sweep
    /// (`branch_cleanup::stamp`'s rule). `None` writes nothing.
    pub fn record_branch_cleanup(
        &self,
        workspace_id: &str,
        card_id: &str,
        record: Option<crate::branch_cleanup::BranchCleanup>,
    ) {
        let Some(record) = record else { return };
        if let Err(e) = self.with_card_unstamped(workspace_id, card_id, |card| {
            crate::branch_cleanup::stamp(card, record);
            Ok(())
        }) {
            log::warn!("kanban: couldn't record {card_id}'s branch for the cleanup: {e}");
        }
    }

    /// v1.33.0: public single-card read-modify-write. The cross-module
    /// entry point to `mutate_card`, so `verify.rs` and `ship.rs` persist a
    /// card change atomically under the cache mutex instead of the racy
    /// `load()` + whole-board `save()` they used before (a window where a
    /// concurrent run-history append could be clobbered).
    pub fn with_card(
        &self,
        workspace_id: &str,
        card_id: &str,
        mutate: impl FnOnce(&mut KanbanCard) -> Result<(), String>,
    ) -> Result<(), String> {
        self.mutate_card(workspace_id, card_id, mutate)
    }

    /// GH #124: `with_card`, all or nothing. When the board cannot be
    /// written, the cached card goes back to what it was before `mutate`,
    /// under the same cache lock, so the cache never keeps a change the
    /// disk lacks and no concurrent update (a Verify result) is replaced.
    pub fn with_card_saved(
        &self,
        workspace_id: &str,
        card_id: &str,
        mutate: impl FnOnce(&mut KanbanCard) -> Result<(), String>,
    ) -> Result<(), String> {
        let path = self.workspace_path(workspace_id);
        let mut cache = self.cache.lock();
        let cards = materialize_cards(&mut cache, workspace_id, &path, &self.unreadable)?;
        let idx = cards
            .iter()
            .position(|c| c.id == card_id)
            .ok_or_else(|| format!("card '{card_id}' not found in workspace '{workspace_id}'"))?;
        let before = cards[idx].clone();
        let applied = mutate(&mut cards[idx]).and_then(|()| {
            cards[idx].updated_at = now_millis();
            write_board(&path, &cards[..])
        });
        if applied.is_err() {
            cards[idx] = before;
        }
        applied
    }

    /// GH #222 review 2: `with_card_saved` for several cards in **one** board
    /// write — all of them or none. Cards not on the board are skipped (a
    /// card deleted meanwhile has nothing to mark); `mutate` runs once per
    /// card present. On any error the cached cards go back to what they
    /// were. Returns the ids that were present.
    pub fn with_cards_saved(
        &self,
        workspace_id: &str,
        card_ids: &[String],
        mut mutate: impl FnMut(&mut KanbanCard) -> Result<(), String>,
    ) -> Result<Vec<String>, String> {
        let path = self.workspace_path(workspace_id);
        let mut cache = self.cache.lock();
        let cards = materialize_cards(&mut cache, workspace_id, &path, &self.unreadable)?;
        let before = cards.clone();
        let mut present = Vec::new();
        let mut apply = || -> Result<(), String> {
            for card in cards.iter_mut() {
                if card_ids.iter().any(|id| *id == card.id) {
                    mutate(card)?;
                    card.updated_at = now_millis();
                    present.push(card.id.clone());
                }
            }
            write_board(&path, &cards[..])
        };
        let applied = apply();
        if applied.is_err() {
            *cards = before;
        }
        applied.map(|()| present)
    }

    /// v1.10.0: shared load → mutate-card → atomic-save scaffold. The
    /// closure runs while the cache mutex is held, so attachment writes
    /// serialize against `append_run_history` and other concurrent
    /// kanban mutations. Returns the closure's `Err` straight back to
    /// the caller; missing cards yield `Err("card 'X' not found …")`.
    fn mutate_card(
        &self,
        workspace_id: &str,
        card_id: &str,
        mutate: impl FnOnce(&mut KanbanCard) -> Result<(), String>,
    ) -> Result<(), String> {
        self.mutate_card_stamped(workspace_id, card_id, true, mutate)
    }

    /// `mutate_card`, with the choice of stamping `updated_at`. Board view
    /// state (a reorder) is not an update of the card.
    fn mutate_card_stamped(
        &self,
        workspace_id: &str,
        card_id: &str,
        stamp: bool,
        mutate: impl FnOnce(&mut KanbanCard) -> Result<(), String>,
    ) -> Result<(), String> {
        let path = self.workspace_path(workspace_id);
        let mut cache = self.cache.lock();
        let cards = materialize_cards(&mut cache, workspace_id, &path, &self.unreadable)?;
        let idx = cards
            .iter()
            .position(|c| c.id == card_id)
            .ok_or_else(|| {
                format!("card '{card_id}' not found in workspace '{workspace_id}'")
            })?;
        mutate(&mut cards[idx])?;
        if stamp {
            cards[idx].updated_at = now_millis();
        }
        write_board(&path, &cards[..])
    }

    /// UX-7.1: set the cards `card_id` waits for (the whole list; empty
    /// clears it). Refused, with nothing written, when an id is the card
    /// itself, is not a card of this workspace, or would close a cycle — a
    /// card that, through its own blockers, already waits for this one.
    /// Duplicates collapse, order kept. Atomic like every board write; it is
    /// the person's edit, so `updated_at` moves.
    pub fn set_blocked_by(
        &self,
        workspace_id: &str,
        card_id: &str,
        blocked_by: Vec<String>,
    ) -> Result<KanbanCard, String> {
        let path = self.workspace_path(workspace_id);
        let mut cache = self.cache.lock();
        let cards = materialize_cards(&mut cache, workspace_id, &path, &self.unreadable)?;
        let idx = cards
            .iter()
            .position(|c| c.id == card_id)
            .ok_or_else(|| format!("card '{card_id}' not found in workspace '{workspace_id}'"))?;
        let mut wanted: Vec<String> = Vec::new();
        for id in blocked_by {
            if !wanted.contains(&id) {
                wanted.push(id);
            }
        }
        for id in &wanted {
            if id == card_id {
                return Err("A card can't wait for itself.".to_string());
            }
            if !cards.iter().any(|c| &c.id == id) {
                return Err(format!("There is no card '{id}' on this board to wait for."));
            }
        }
        if let Some(cycle) = blocking_cycle(cards, card_id, &wanted) {
            let title = |id: &str| {
                cards
                    .iter()
                    .find(|c| c.id == id)
                    .map(|c| c.title.clone())
                    .unwrap_or_else(|| id.to_string())
            };
            return Err(format!(
                "“{}” can't wait for “{}”: “{}” already waits for “{}”.",
                title(card_id),
                title(&cycle),
                title(&cycle),
                title(card_id),
            ));
        }
        cards[idx].blocked_by = wanted;
        cards[idx].updated_at = now_millis();
        let updated = cards[idx].clone();
        write_board(&path, &cards[..])?;
        Ok(updated)
    }

    /// Plan with two AIs, Accept (`docs/plans/PLAN_WITH_TWO_AIS.md` §5): the
    /// card's plan in one backend write, under one cache lock — the
    /// `dispatch_prompt`, `dispatch_prompt_edited_at` (now for Edit…, cleared
    /// for Use this plan), `intake_status: Ready`, the chat files copied for
    /// it (`attachments`, Q4) and the `IntakeRecord`, FIFO-capped as
    /// `append_intake_history`. Refused, with nothing changed, on a card
    /// whose build started (not in To do, or a Builder recorded), an
    /// archived card, and a text that is empty or past
    /// [`MAX_TWO_AI_PLAN_CHARS`]. A failed write puts the card back as it
    /// was; an evicted record's transcript is deleted only after the write
    /// succeeds.
    pub fn apply_two_ai_plan(
        &self,
        workspace_id: &str,
        card_id: &str,
        text: &str,
        edited: bool,
        record: IntakeRecord,
        attachments: Vec<CardAttachment>,
    ) -> Result<KanbanCard, String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("The plan is empty, so nothing was written on the card.".to_string());
        }
        if text.chars().count() > MAX_TWO_AI_PLAN_CHARS {
            return Err(format!(
                "The plan is longer than {MAX_TWO_AI_PLAN_CHARS} characters; shorten it with Edit…, then use it."
            ));
        }
        let path = self.workspace_path(workspace_id);
        let mut cache = self.cache.lock();
        let cards = materialize_cards(&mut cache, workspace_id, &path, &self.unreadable)?;
        let idx = cards
            .iter()
            .position(|c| c.id == card_id)
            .ok_or_else(|| format!("card '{card_id}' not found in workspace '{workspace_id}'"))?;
        if cards[idx].column_id != KanbanColumnId::Todo || cards[idx].builder.is_some() {
            return Err(TWO_AI_BUILD_STARTED.to_string());
        }
        if cards[idx].archived {
            return Err("This card is archived, so the plan wasn't written. Restore it first.".to_string());
        }
        let before = cards[idx].clone();
        let now = now_millis();
        let card = &mut cards[idx];
        card.dispatch_prompt = Some(text.to_string());
        card.dispatch_prompt_edited_at = if edited { Some(now) } else { None };
        card.intake_status = IntakeStatus::Ready;
        card.attachments.extend(attachments);
        card.intake_history.push(record);
        let mut evicted = Vec::new();
        while card.intake_history.len() > MAX_INTAKE_HISTORY {
            evicted.push(card.intake_history.remove(0));
        }
        card.updated_at = now;
        let updated = card.clone();
        if let Err(error) = write_board(&path, &cards[..]) {
            cards[idx] = before;
            return Err(error);
        }
        drop(cache);
        for record in evicted {
            if let Some(rel_path) = &record.transcript_path {
                let abs = self.config_dir.join(rel_path);
                if let Err(e) = fs::remove_file(&abs) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        log::warn!("kanban: evict intake transcript {} failed: {e}", abs.display());
                    }
                }
            }
        }
        Ok(updated)
    }

    /// UX-7.2: why `card_id` may not start now — the titles of the blockers
    /// that have not shipped — or `None`. Only a card that has not started
    /// (Todo) is held: a blocker added to work already under way does not
    /// stop it.
    pub fn start_refusal(&self, workspace_id: &str, card_id: &str) -> Result<Option<String>, String> {
        let cards = self.load(workspace_id)?;
        let Some(card) = cards.iter().find(|c| c.id == card_id) else {
            return Ok(None);
        };
        if !matches!(card.column_id, KanbanColumnId::Todo) {
            return Ok(None);
        }
        if let Some(why) = start_refusal_message(&unshipped_blockers(&cards, card)) {
            return Ok(Some(why));
        }
        // N19: every start path (the Board's move, Start build, Plan, Build
        // with both, a second window) asks here.
        if follow_up_ask_empty(card) {
            return Ok(Some(FOLLOW_UP_ASK_EMPTY.to_string()));
        }
        // C4: nor a card made from a copy before its brief says anything.
        Ok(copy_brief_empty(card).then(|| COPY_BRIEF_EMPTY.to_string()))
    }

    /// UX-5.3: set (or clear with `None`) where the card sits in its Board
    /// column. Atomic like every board write; `updated_at` is left alone —
    /// dragging a card is not editing it. A non-finite key is refused.
    pub fn set_board_order(
        &self,
        workspace_id: &str,
        card_id: &str,
        board_order: Option<f64>,
    ) -> Result<KanbanCard, String> {
        if board_order.is_some_and(|v| !v.is_finite()) {
            return Err("board order must be a finite number".to_string());
        }
        let mut updated: Option<KanbanCard> = None;
        self.mutate_card_stamped(workspace_id, card_id, false, |card| {
            card.board_order = board_order;
            updated = Some(card.clone());
            Ok(())
        })?;
        updated.ok_or_else(|| "set_board_order did not capture card".to_string())
    }

    /// Set (or clear with `None`, back to the Settings default) the Builder
    /// vendor chosen for the card before a build. Atomic like every board
    /// write; `updated_at` is left alone — a picker choice is not an edit of
    /// the card. An unknown card is refused with nothing written.
    pub fn set_builder_vendor_pref(
        &self,
        workspace_id: &str,
        card_id: &str,
        vendor: Option<crate::settings::BuilderVendor>,
    ) -> Result<KanbanCard, String> {
        let mut updated: Option<KanbanCard> = None;
        self.mutate_card_stamped(workspace_id, card_id, false, |card| {
            card.builder_vendor_pref = vendor;
            updated = Some(card.clone());
            Ok(())
        })?;
        updated.ok_or_else(|| "set_builder_vendor_pref did not capture card".to_string())
    }

    /// 1.171.0 (D1): set (or clear with `None`, back to the Settings
    /// default) how the card's Builder asks before it changes things, as
    /// `set_builder_vendor_pref`: atomic, `updated_at` left alone, an
    /// unknown card refused with nothing written.
    pub fn set_builder_permissions(
        &self,
        workspace_id: &str,
        card_id: &str,
        permissions: Option<crate::settings::BuilderPermissions>,
    ) -> Result<KanbanCard, String> {
        let mut updated: Option<KanbanCard> = None;
        self.mutate_card_stamped(workspace_id, card_id, false, |card| {
            card.builder_permissions = permissions;
            updated = Some(card.clone());
            Ok(())
        })?;
        updated.ok_or_else(|| "set_builder_permissions did not capture card".to_string())
    }

    /// 1.168.1 (E2): set the card's own models (`None`, or nothing left after
    /// normalizing, clears them back to the workspace's). Atomic like every
    /// board write; `updated_at` is left alone — a model choice is not an
    /// edit of the card, and never marks it for a GitHub push. A changed
    /// Builder choice for the vendor the card's Builder runs on replaces the
    /// model a Build with both chose for it (`builder.chosen_model`): the
    /// later, explicit choice wins. An unknown card is refused with nothing
    /// written.
    pub fn set_card_models(
        &self,
        workspace_id: &str,
        card_id: &str,
        models: Option<crate::settings::WorkspaceModels>,
    ) -> Result<KanbanCard, String> {
        let models = models.and_then(|m| m.normalized());
        let mut updated: Option<KanbanCard> = None;
        self.mutate_card_stamped(workspace_id, card_id, false, |card| {
            if let Some(builder) = card.builder.as_mut() {
                let part = |m: Option<&crate::settings::WorkspaceModels>| {
                    let vendor = builder.vendor.as_str();
                    let role = crate::settings::AgentRole::Builder;
                    m.map(|m| {
                        (
                            m.rows.for_role(vendor, role),
                            m.forces_cli_default(crate::settings::model_field_key(vendor, role, false)),
                            m.forces_cli_default(crate::settings::model_field_key(vendor, role, true)),
                        )
                    })
                    .unwrap_or_default()
                };
                if part(card.models.as_ref()) != part(models.as_ref()) {
                    builder.chosen_model = None;
                }
            }
            card.models = models;
            updated = Some(card.clone());
            Ok(())
        })?;
        updated.ok_or_else(|| "set_card_models did not capture card".to_string())
    }

    /// SL-4: record what the setup of the card's worktree did (or clear it
    /// with `None`). Atomic like every board write; `updated_at` is left
    /// alone — the backend preparing a worktree is not an edit of the card.
    pub fn set_worktree_setup(
        &self,
        workspace_id: &str,
        card_id: &str,
        record: Option<crate::worktree_setup::WorktreeSetupRecord>,
    ) -> Result<KanbanCard, String> {
        let mut updated: Option<KanbanCard> = None;
        self.mutate_card_stamped(workspace_id, card_id, false, |card| {
            card.worktree_setup = record;
            updated = Some(card.clone());
            Ok(())
        })?;
        updated.ok_or_else(|| "set_worktree_setup did not capture card".to_string())
    }

    /// `worktree_ports`: the port block of a card's worktree (`lane` `b`:
    /// its Build-with-both lane's worktree), handing one out — and writing
    /// it — when it has none or another card's worktree holds the same one.
    /// `None` when that worktree is not recorded (no worktree, no undecided
    /// lane `b`) or every block is in use. Unique across every workspace's
    /// boards: those not loaded are read, never cached or written. The ports
    /// are probed with no lock held and the pick is re-checked under the
    /// lock before it is written, so two allocations cannot keep one block.
    pub fn ensure_port_base(
        &self,
        workspace_id: &str,
        card_id: &str,
        lane: Option<&str>,
    ) -> Result<Option<u16>, String> {
        self.ensure_port_base_wrote(workspace_id, card_id, lane).map(|(base, _)| base)
    }

    /// [`Self::ensure_port_base`], also saying whether it wrote the board.
    fn ensure_port_base_wrote(
        &self,
        workspace_id: &str,
        card_id: &str,
        lane: Option<&str>,
    ) -> Result<(Option<u16>, bool), String> {
        self.ensure_port_base_probed(workspace_id, card_id, lane, &crate::worktree_ports::block_is_free)
    }

    /// The allocation, with the probe given. The probe runs with no lock
    /// held — on Windows a block can take a moment — so the pick is
    /// checked again under the lock and, taken meanwhile, made again
    /// ([`crate::worktree_ports::MAX_PICK_ATTEMPTS`] times, then without
    /// probing).
    pub(crate) fn ensure_port_base_probed(
        &self,
        workspace_id: &str,
        card_id: &str,
        lane: Option<&str>,
        probe: &(dyn Fn(u16) -> bool + Sync),
    ) -> Result<(Option<u16>, bool), String> {
        use crate::worktree_ports::{is_block_base, pick_block, MAX_PICK_ATTEMPTS};
        // 1.173.0 A3: one hand-out at a time, a card's or a copy's.
        let _pick = crate::worktree_ports::PICK_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let lane_b = lane.filter(|l| *l != crate::build_both::LANE_A);
        let own = |slot: &Option<u16>, used: &std::collections::HashSet<u16>| {
            slot.filter(|b| is_block_base(*b) && !used.contains(b))
        };
        // Its own block, while nobody else holds it: kept, even with its
        // server listening there.
        let first = self.with_port_slot(workspace_id, card_id, lane_b, |used, slot| match own(slot, used) {
            Some(base) => Ok(base),
            None => Err(used.clone()),
        })?;
        let mut used = match first {
            None => return Ok((None, false)),
            Some(Ok(base)) => return Ok((Some(base), false)),
            Some(Err(used)) => used,
        };
        for _ in 0..MAX_PICK_ATTEMPTS {
            let Some(candidate) = pick_block(&used, None, probe) else { return Ok((None, false)) };
            let settled = self.with_port_slot(workspace_id, card_id, lane_b, |now, slot| {
                if let Some(base) = own(slot, now) {
                    return Ok(base);
                }
                if now.contains(&candidate) {
                    return Err(now.clone());
                }
                *slot = Some(candidate);
                Ok(candidate)
            })?;
            match settled {
                None => return Ok((None, false)),
                Some(Ok(base)) => return Ok((Some(base), base == candidate)),
                Some(Err(now)) => used = now,
            }
        }
        let last = self.with_port_slot(workspace_id, card_id, lane_b, |now, slot| {
            if let Some(base) = own(slot, now) {
                return (Some(base), false);
            }
            let picked = pick_block(now, None, |_| true);
            if picked.is_some() {
                *slot = picked;
            }
            (picked, picked.is_some())
        })?;
        Ok(last.unwrap_or((None, false)))
    }

    /// Under the cache lock: the blocks every other worktree holds (across
    /// every workspace's board; those not loaded are read, never cached or
    /// written) and the card's (`lane_b`: its lane's) block slot, for `f`.
    /// The board is written when `f` changed the slot. `None` when that
    /// worktree is not recorded (no worktree, no undecided lane `b`).
    fn with_port_slot<R>(
        &self,
        workspace_id: &str,
        card_id: &str,
        lane_b: Option<&str>,
        f: impl FnOnce(&std::collections::HashSet<u16>, &mut Option<u16>) -> R,
    ) -> Result<Option<R>, String> {
        // 1.173.0 A3: a copy's block is never a card's (read before the
        // cache lock: the copies' registries take no lock of the board's).
        let held_by_copies = crate::worktree_ports::held_by_others();
        let mut cache = self.cache.lock();
        let mut used = held_by_copies;
        for ws in self.board_ids(&cache) {
            if ws == workspace_id {
                continue;
            }
            let disk;
            let cards: &[KanbanCard] = match cache.get(&ws) {
                Some(cards) => cards,
                None => {
                    disk = read_board_read_only(&self.workspace_path(&ws));
                    &disk
                }
            };
            for c in cards {
                collect_port_bases(c, None, &mut |b| {
                    used.insert(b);
                });
            }
        }
        let path = self.workspace_path(workspace_id);
        let cards = materialize_cards(&mut cache, workspace_id, &path, &self.unreadable)?;
        for c in cards.iter() {
            let skip = (c.id == card_id).then_some(lane_b);
            collect_port_bases(c, skip, &mut |b| {
                used.insert(b);
            });
        }
        let card = cards
            .iter_mut()
            .find(|c| c.id == card_id)
            .ok_or_else(|| format!("card '{card_id}' not found in workspace '{workspace_id}'"))?;
        let slot = match lane_b {
            None => card.worktree_path.as_deref().is_some_and(|p| !p.is_empty()).then_some(&mut card.port_base),
            Some(lane) => card
                .build_both
                .as_mut()
                .filter(|bb| bb.undecided())
                .and_then(|bb| bb.lane_mut(lane))
                .filter(|l| !l.worktree_path.is_empty())
                .map(|l| &mut l.port_base),
        };
        let Some(slot) = slot else { return Ok(None) };
        let before = *slot;
        let out = f(&used, slot);
        if *slot != before {
            write_board(&path, &cards[..])?;
        }
        Ok(Some(out))
    }

    /// Tests: nobody holds the cache lock now.
    #[cfg(test)]
    pub(crate) fn cache_is_free(&self) -> bool {
        self.cache.try_lock().is_some()
    }

    /// `worktree_ports`: the port block of the card worktree `cwd` is in
    /// (handed out now if it has none), `None` outside one or for a worktree
    /// no card records. One read of the boards: a worktree whose block no
    /// other worktree holds — every spawn after the first — is answered
    /// from it; only a missing or shared block goes on to allocate.
    pub fn port_base_for_cwd(&self, cwd: &Path) -> Option<PortLookup> {
        let (worktree, dir) = crate::worktree_ports::worktree_of(cwd)?;
        let ids = crate::worktree_ports::card_ids_for_dir(&dir);
        let mut owner: Option<(String, String, Option<String>, Option<u16>)> = None;
        let mut held: HashMap<u16, usize> = HashMap::new();
        {
            let cache = self.cache.lock();
            for ws in self.board_ids(&cache) {
                let disk;
                let cards: &[KanbanCard] = match cache.get(&ws) {
                    Some(cards) => cards,
                    None => {
                        disk = read_board_read_only(&self.workspace_path(&ws));
                        &disk
                    }
                };
                for c in cards {
                    collect_port_bases(c, None, &mut |b| *held.entry(b).or_default() += 1);
                    if owner.is_none() && ids.contains(&c.id) {
                        owner = worktree_owner(c, &worktree).map(|lane| {
                            let base = match lane.as_deref() {
                                None => c.port_base,
                                Some(l) => c.build_both.as_ref().and_then(|bb| bb.lane(l)).and_then(|l| l.port_base),
                            };
                            (ws.clone(), c.id.clone(), lane, base)
                        });
                    }
                }
            }
        }
        let (ws, card_id, lane, base) = owner?;
        if let Some(base) = base.filter(|b| crate::worktree_ports::is_block_base(*b) && held.get(b) == Some(&1)) {
            return Some(PortLookup { base, workspace_id: ws, wrote: false });
        }
        match self.ensure_port_base_wrote(&ws, &card_id, lane.as_deref()) {
            Ok((Some(base), wrote)) => Some(PortLookup { base, workspace_id: ws, wrote }),
            Ok((None, _)) => None,
            Err(e) => {
                log::warn!("worktree ports {ws}/{card_id}: {e}");
                None
            }
        }
    }

    /// Every workspace with a board: loaded, or a `<id>.json` on disk.
    /// 1.173.0 A3: every block a card (or a Build-with-both lane) holds,
    /// across every workspace's board — what a copy's block must not be.
    pub fn port_bases_in_use(&self) -> std::collections::HashSet<u16> {
        let cache = self.cache.lock();
        let mut used = std::collections::HashSet::new();
        for ws in self.board_ids(&cache) {
            let disk;
            let cards: &[KanbanCard] = match cache.get(&ws) {
                Some(cards) => cards,
                None => {
                    disk = read_board_read_only(&self.workspace_path(&ws));
                    &disk
                }
            };
            for c in cards {
                collect_port_bases(c, None, &mut |b| {
                    used.insert(b);
                });
            }
        }
        used
    }

    fn board_ids(&self, cache: &HashMap<String, Vec<KanbanCard>>) -> Vec<String> {
        let mut ids: Vec<String> = cache.keys().cloned().collect();
        if let Ok(entries) = fs::read_dir(boards_dir(&self.config_dir)) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let Some(id) = name.to_str().and_then(|n| n.strip_suffix(".json")) else { continue };
                if !id.is_empty() && !id.contains('.') && !ids.iter().any(|known| known == id) {
                    ids.push(id.to_string());
                }
            }
        }
        ids.sort();
        ids
    }

    /// SL-5: add a line comment to the card (`line_comments::comment_from_draft`
    /// validates it; the id and times are made here). Atomic like every board
    /// write; `updated_at` is left alone — a review note is not an edit of
    /// the card's brief. A refused draft writes nothing.
    pub fn add_line_comment(
        &self,
        workspace_id: &str,
        card_id: &str,
        draft: crate::line_comments::LineCommentDraft,
    ) -> Result<KanbanCard, String> {
        // Challenger on a pull request: line comments go to a Builder, and
        // someone else's pull request has none.
        if let Some(why) = crate::pr_review::work_refusal(&self.get_card(workspace_id, card_id)?) {
            return Err(why);
        }
        let comment = crate::line_comments::comment_from_draft(
            draft,
            format!("lc-{}", uuid::Uuid::new_v4().simple()),
            now_millis(),
        )?;
        self.mutate_line_comments(workspace_id, card_id, |list| {
            crate::line_comments::add(list, comment)
        })
    }

    /// SL-5: change an unsent line comment's text (a sent one is refused).
    pub fn update_line_comment(
        &self,
        workspace_id: &str,
        card_id: &str,
        comment_id: &str,
        body: &str,
    ) -> Result<KanbanCard, String> {
        let now = now_millis();
        self.mutate_line_comments(workspace_id, card_id, |list| {
            crate::line_comments::update(list, comment_id, body, now)
        })
    }

    /// SL-5: remove an unsent line comment (a sent one is history, refused).
    pub fn remove_line_comment(
        &self,
        workspace_id: &str,
        card_id: &str,
        comment_id: &str,
    ) -> Result<KanbanCard, String> {
        self.mutate_line_comments(workspace_id, card_id, |list| {
            crate::line_comments::remove(list, comment_id)
        })
    }

    /// SL-5: mark the comments that reached the Builder session sent.
    /// Only unsent ones change; ids no longer on the card are skipped.
    pub fn mark_line_comments_sent(
        &self,
        workspace_id: &str,
        card_id: &str,
        ids: &[String],
    ) -> Result<KanbanCard, String> {
        let now = now_millis();
        self.mutate_line_comments(workspace_id, card_id, |list| {
            crate::line_comments::mark_sent(list, ids, now);
            Ok(())
        })
    }

    fn mutate_line_comments(
        &self,
        workspace_id: &str,
        card_id: &str,
        mutate: impl FnOnce(&mut Vec<crate::line_comments::LineComment>) -> Result<(), String>,
    ) -> Result<KanbanCard, String> {
        let mut updated: Option<KanbanCard> = None;
        self.mutate_card_stamped(workspace_id, card_id, false, |card| {
            mutate(&mut card.line_comments)?;
            updated = Some(card.clone());
            Ok(())
        })?;
        updated.ok_or_else(|| "line comment write did not capture card".to_string())
    }

    /// 1.172.0 (A1): keep a request the person sent the Builder after the
    /// first result. Atomic like every board write; `updated_at` left alone,
    /// as for line comments (it is the card's history, not an edit of it).
    pub fn add_later_request(
        &self,
        workspace_id: &str,
        card_id: &str,
        text: &str,
        source: crate::later_requests::LaterRequestSource,
    ) -> Result<KanbanCard, String> {
        let request = crate::later_requests::LaterRequest {
            id: format!("lr-{}", uuid::Uuid::new_v4().simple()),
            text: text.to_string(),
            at: now_millis(),
            source,
        };
        self.mutate_later_requests(workspace_id, card_id, |card| crate::later_requests::add(&mut card.later_requests, request))
    }

    /// 1.172.0 (A1): drop one before the card has landed; a landed card's
    /// are refused — they are part of what it was reviewed against.
    pub fn remove_later_request(&self, workspace_id: &str, card_id: &str, id: &str) -> Result<KanbanCard, String> {
        self.mutate_later_requests(workspace_id, card_id, |card| {
            if card_landed(card) {
                return Err(LATER_REQUESTS_DONE.to_string());
            }
            crate::later_requests::remove(&mut card.later_requests, id);
            Ok(())
        })
    }

    fn mutate_later_requests(
        &self,
        workspace_id: &str,
        card_id: &str,
        mutate: impl FnOnce(&mut KanbanCard) -> Result<(), String>,
    ) -> Result<KanbanCard, String> {
        let mut updated: Option<KanbanCard> = None;
        self.mutate_card_stamped(workspace_id, card_id, false, |card| {
            mutate(card)?;
            updated = Some(card.clone());
            Ok(())
        })?;
        updated.ok_or_else(|| "later request write did not capture card".to_string())
    }

    /// v1.5.x: locate the card whose `linked_run_id` matches. Scoped to a
    /// single workspace because the run record always carries
    /// `workspace_id`. Returns the card id if found.
    pub fn card_id_for_linked_run(
        &self,
        workspace_id: &str,
        run_id: &str,
    ) -> Option<String> {
        self.load(workspace_id)
            .ok()?
            .into_iter()
            .find(|c| c.linked_run_id.as_deref() == Some(run_id))
            .map(|c| c.id)
    }

    /// v1.5.x: locate the card whose `linked_swarm_id` matches.
    pub fn card_id_for_linked_swarm(
        &self,
        workspace_id: &str,
        swarm_id: &str,
    ) -> Option<String> {
        self.load(workspace_id)
            .ok()?
            .into_iter()
            .find(|c| c.linked_swarm_id.as_deref() == Some(swarm_id))
            .map(|c| c.id)
    }

    /// Delete the kanban file for a workspace (called when the workspace
    /// itself is deleted). Idempotent — missing file is not an error.
    pub fn delete_workspace(&self, workspace_id: &str) -> Result<(), String> {
        let path = self.workspace_path(workspace_id);
        if path.exists() {
            fs::remove_file(&path).map_err(|e| format!("remove kanban: {e}"))?;
        }
        // 1.168.1 (A4): its deleted cards' history goes with the workspace.
        let _ = fs::remove_file(self.deleted_cards_path(workspace_id));
        // T2: and what it remembered of a restore.
        let _ = fs::remove_file(restored_marker_path(&path));
        self.unreadable.lock().remove(workspace_id);
        self.cache.lock().remove(workspace_id);
        Ok(())
    }

    fn deleted_cards_path(&self, workspace_id: &str) -> PathBuf {
        config_subdir(&self.config_dir, DELETED_CARDS_SUBDIR).join(format!("{workspace_id}.json"))
    }

    /// 1.168.1 (A4): the deleted cards History still shows, as History
    /// reads a card. A missing file is none; one that can't be read is none
    /// too, and is never written over (`keep_deleted_history`).
    pub fn deleted_cards(&self, workspace_id: &str) -> Vec<KanbanCard> {
        read_deleted_cards(&self.deleted_cards_path(workspace_id))
            .ok()
            .flatten()
            .map(|f| f.cards.into_iter().map(|d| d.card).collect())
            .unwrap_or_default()
    }

    /// 1.168.1 (A4): keep a deleted card's history, newest first, dropping
    /// the cards deleted before History's window and past the cap. Atomic
    /// (tempfile + rename); best-effort — the card is already deleted, so a
    /// failure here is logged, never raised. Called under the cache lock, so
    /// two deletes never write it at once.
    fn keep_deleted_history(&self, workspace_id: &str, card: KanbanCard, now: i64) {
        let path = self.deleted_cards_path(workspace_id);
        let mut file = match read_deleted_cards(&path) {
            Ok(f) => f.unwrap_or(DeletedCardsFile { version: DELETED_CARDS_VERSION, cards: Vec::new() }),
            Err(e) => {
                log::warn!("kanban: deleted-card history for {workspace_id} unreadable ({e}); left as it is");
                return;
            }
        };
        file.version = DELETED_CARDS_VERSION;
        file.cards.retain(|d| d.card.id != card.id && d.deleted_at >= now - DELETED_CARD_KEEP_MS);
        file.cards.insert(0, DeletedCard { deleted_at: now, card });
        file.cards.truncate(MAX_DELETED_CARDS);
        if let Err(e) = crate::atomic::write_atomic_json(&path, &file) {
            log::warn!("kanban: couldn't keep the deleted card's history for {workspace_id}: {e}");
        }
    }
}

// ── v1.30.0 (parallel swarms): card-swarm queue pump ─────────────
//
// The In Progress column doubles as the card-swarm queue: a card sitting
// there with a swarm template but no live swarm is "queued". When a slot
// frees (a swarm finishes, is aborted, or the cap is raised), the pump
// starts the next queued card(s) up to the configured cap.

/// Process-wide serialization lock for `pump_card_queue`. Two swarms
/// finishing at the same instant must not both observe the same free slot
/// and over-fill the cap, so every pump runs under this lock.
static QUEUE_PUMP_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// v1.30.0: true if `card` is waiting in the card-swarm queue — In Progress,
/// has a swarm template, not archived, no live swarm linked, and its last
/// dispatch did not permanently fail. A finished card keeps a non-null
/// `linked_swarm_id`, so it is correctly excluded; a card whose dispatch
/// failed is marked `Failed` and excluded so it cannot block the queue.
/// UX-5.8: a shipped card leaves Done for the archive this long after it
/// shipped. Mirrored by `boardSemantics.ts::AUTO_ARCHIVE_AFTER_MS`.
pub const AUTO_ARCHIVE_AFTER_MS: i64 = 14 * 24 * 60 * 60 * 1000;

pub const AUTO_ARCHIVE_NOT_ELIGIBLE: &str =
    "This card is not one Plyloft archives on its own: it has not been shipped for 14 days, it was archived before, or its worktree is still there.";

pub const RESTORE_REFUSAL: &str =
    "Only a shipped card, or one Plyloft archived on its own, can come back from the archive.";

/// When the card landed: its latest ship, else its last update (a card
/// merged through a pull request, or migrated as shipped, has no ship entry).
pub fn card_shipped_at(card: &KanbanCard) -> i64 {
    card.ship_history
        .iter()
        .map(|entry| entry.shipped_at)
        .max()
        .filter(|at| *at > 0)
        .unwrap_or(card.updated_at)
}

/// UX-5.8: the auto-archive takes a card that landed more than 14 days ago,
/// was never archived (a card the person restored has `archived_at`), and
/// has no worktree left to prune. Mirrored by `autoArchiveCandidates`.
pub fn auto_archive_eligible(card: &KanbanCard, now: i64) -> bool {
    // 1.174.0 A2 round 1: landed — never a card whose pull request is open.
    !card.archived
        && card_landed(card)
        && card.archived_at.is_none()
        && card.worktree_path.is_none()
        && now - card_shipped_at(card) > AUTO_ARCHIVE_AFTER_MS
}

/// UX-5.8: what the archive can give back. QoL 1.168 S1-3: every archived
/// card — its brief, plan and branch stay with it, and its copy comes back
/// from the Trash while it is there (`commands::kanban_card_restore`).
pub fn card_restorable(card: &KanbanCard) -> bool {
    card.archived
}

// ── G4 (launch D8): role-chain swarms are retired ────────────────
//
// No new swarm starts. A card that already ran one (`linked_swarm_id`)
// finishes it as before — running, suspended, resumed — and a card already
// waiting in the queue (In Progress with a template) is still started by
// `pump_card_queue`. A template on a card still in Todo that never ran a
// swarm is dropped when the card starts, so it is built by the Builder.

/// The refusal `swarm_start` gives a card that never ran a swarm.
pub const NEW_CARD_SWARM_REFUSAL: &str =
    "Swarms are retired, so this card can't start one: it has never run a swarm. Build it with the Builder instead. A card that already runs a swarm still finishes it.";

/// The refusal `swarm_start` gives a swarm that belongs to no card.
pub const NEW_SWARM_REFUSAL: &str =
    "Swarms are retired, so a new one can't start. A card that already runs a swarm still finishes it.";

/// The refusal when something tries to give a card a swarm template.
pub const SWARM_TEMPLATE_REFUSAL: &str =
    "Swarms are retired, so a card can't be given a swarm template. Build it with the Builder instead.";

/// Why `swarm_start` refuses: `None` only for a card swarm on a card that
/// has run a swarm before. The queue pump does not come through here.
pub fn swarm_start_refusal(card_swarm: bool, card: Option<&KanbanCard>) -> Option<&'static str> {
    if !card_swarm {
        return Some(NEW_SWARM_REFUSAL);
    }
    match card {
        Some(card) if card.linked_swarm_id.is_some() => None,
        _ => Some(NEW_CARD_SWARM_REFUSAL),
    }
}

/// The card's swarm template still means something: a swarm ran on the card,
/// or the card is past Todo (running one, or queued for one). A template on a
/// Todo card that never ran a swarm can no longer start one.
pub fn swarm_template_in_use(card: &KanbanCard) -> bool {
    card.swarm_template_id.is_some()
        && (card.linked_swarm_id.is_some() || card.column_id != KanbanColumnId::Todo)
}

/// A card leaving Todo for In Progress drops a template that never ran, so
/// the queue pump cannot start a new swarm for it.
pub(crate) fn drop_unstarted_swarm_template(card: &mut KanbanCard) {
    if card.linked_swarm_id.is_none() {
        card.swarm_template_id = None;
    }
}

pub fn card_is_queue_eligible(card: &KanbanCard) -> bool {
    card.column_id == KanbanColumnId::InProgress
        && card.swarm_template_id.is_some()
        && !card.archived
        && card.linked_swarm_id.is_none()
        && card.last_run_status != Some(LastRunStatus::Failed)
}

/// v1.30.0: the dispatch prompt for a card-driven swarm. Backend mirror of
/// the frontend assembly in `kanbanStore.moveCard` — prefers the
/// intake-finalized `dispatch_prompt`, else concatenates title + notes +
/// knowledge, then appends an `Attached files:` block. Kept in lockstep
/// with the frontend: if one side changes, change both.
/// v1.109.0: the brief as the Plan challenge sees it — the intake-finalized
/// dispatch prompt when present, else title + notes. The frontend mirrors
/// this rule to detect a stale challenge.
pub fn card_brief_text(card: &KanbanCard) -> String {
    if let Some(p) = card.dispatch_prompt.as_deref() {
        if !p.trim().is_empty() {
            return p.trim().to_string();
        }
    }
    let mut parts = vec![card.title.trim().to_string()];
    if let Some(n) = card.notes.as_deref() {
        if !n.trim().is_empty() {
            parts.push(n.trim().to_string());
        }
    }
    parts.join("\n\n")
}

pub fn card_dispatch_prompt(card: &KanbanCard) -> String {
    let mut prompt = match card
        .dispatch_prompt
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        Some(p) => p.to_string(),
        // 1.175.0 (B3): an issue card's text is the issue's — quoted as
        // data, its HTML comments shown and marked (`issue_text`).
        None if crate::issue_text::issue_of(card).is_some() => crate::issue_text::for_agent(card).unwrap_or_default(),
        None => {
            let mut parts: Vec<&str> = vec![card.title.as_str()];
            if let Some(n) = card.notes.as_deref().filter(|s| !s.is_empty()) {
                parts.push(n);
            }
            if let Some(k) = card.knowledge.as_deref().filter(|s| !s.is_empty()) {
                parts.push(k);
            }
            parts.join("\n\n")
        }
    };
    if !card.attachments.is_empty() {
        let lines: Vec<String> = card
            .attachments
            .iter()
            .map(|a| format!("- {}", a.stored_path))
            .collect();
        prompt = format!("{prompt}\n\nAttached files:\n{}", lines.join("\n"));
    }
    prompt
}

/// v1.36.0 (memory Increment 2): card-dispatch prompt **with** the
/// memory injection block prepended. Centralizes the FE↔backend
/// lockstep that previously had two copies of the assembly logic
/// (CLAUDE.md gotcha: "the agent's stored `promptTemplate` is bypassed
/// for card-driven runs — kanbanStore.moveCard builds [title, notes,
/// knowledge].filter(present).join …"). The FE now calls the
/// `card_compose_dispatch_prompt` IPC instead of assembling locally,
/// which is the only place that constructs the dispatched prompt.
///
/// Returns:
///   `<memory block>\n\n<card body>` when one or more memories match.
///   `<card body>` verbatim when no memories match or memory is empty.
///
/// `inject_global` is the user's `Settings::behavior::inject_global_memories`
/// snapshot. The workspace's own memories are always considered; the
/// global pool only joins the candidate set when this flag is true.
pub fn card_compose_dispatch_prompt(
    card: &KanbanCard,
    memory: &crate::memory::MemoryStore,
    inject_global: bool,
) -> String {
    let body = card_dispatch_prompt(card);
    // Search query: the user-owned fields the agent will actually be
    // working from. The intake-finalized `dispatch_prompt` is
    // deliberately NOT included — it's already the "polished" form and
    // tends to skew towards generic language, blunting the FTS match
    // against memory titles/tags that mirror user phrasing.
    let mut q = String::with_capacity(256);
    q.push_str(&card.title);
    if let Some(n) = card.notes.as_deref() {
        q.push(' ');
        q.push_str(n);
    }
    if let Some(k) = card.knowledge.as_deref() {
        q.push(' ');
        q.push_str(k);
    }
    let block = memory.compose_dispatch_block(&card.workspace_id, &q, inject_global);
    if block.is_empty() {
        body
    } else {
        format!("{block}\n\n{body}")
    }
}

/// Mark a card's last dispatch as `Failed` so `card_is_queue_eligible`
/// excludes it — a card that can never dispatch must not block the cards
/// behind it in the queue.
fn mark_card_dispatch_failed(kanban: &KanbanStore, workspace_id: &str, card_id: &str) {
    let _ = kanban.mutate_card(workspace_id, card_id, |c| {
        c.last_run_status = Some(LastRunStatus::Failed);
        Ok(())
    });
}

/// Phase 3: attach a queued single-agent run only after writer admission
/// succeeds. The queue entry itself is not persisted as a fake run.
pub fn link_queued_agent_run(
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    run_id: &str,
) -> Result<(), String> {
    kanban.mutate_card(workspace_id, card_id, |card| {
        card.linked_run_id = Some(run_id.to_string());
        card.linked_swarm_id = None;
        card.last_run_status = Some(LastRunStatus::Running);
        Ok(())
    })
}

/// v1.30.0 (parallel swarms): start as many queued card swarms in
/// `workspace_id` as there are free slots, in In Progress column order.
/// Serialized process-wide by `QUEUE_PUMP_LOCK` so concurrent
/// swarm-completion events cannot over-fill the cap. Best-effort: a card
/// whose worktree or swarm dispatch fails is marked `Failed` (leaves the
/// queue, does not block the rest) and the pump moves on. Skipped while a
/// ship-drain is in progress. A no-op when there are no free slots or no
/// eligible cards — safe to call from any completion / abort / startup path.
pub fn pump_card_queue(app: &tauri::AppHandle, workspace_id: &str) {
    use tauri::Manager;
    let _guard = QUEUE_PUMP_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    // Do not fight an in-progress ship drain, which is trying to bring
    // in-flight work to zero.
    if let Some(drain) = app.try_state::<crate::drain::DrainCoordinator>() {
        if drain.is_draining() {
            return;
        }
    }
    let Some(swarm_registry) = app.try_state::<crate::swarms::SwarmRegistry>() else {
        return;
    };
    let Some(kanban_state) = app.try_state::<KanbanStore>() else {
        return;
    };
    let kanban: &KanbanStore = &kanban_state;
    let (Some(verify), Some(card_execution)) = (
        app.try_state::<crate::verify::VerifyRegistry>(),
        app.try_state::<crate::card_execution::CardExecutionGate>(),
    ) else {
        return;
    };

    let cap = swarm_registry.card_swarm_cap();
    let in_use = swarm_registry.active_card_count(workspace_id)
        + swarm_registry.suspended_card_count(workspace_id);
    let mut free = cap.saturating_sub(in_use);
    if free == 0 {
        return;
    }

    let cards = match kanban.load(workspace_id) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("pump_card_queue: load kanban for '{workspace_id}': {e}");
            return;
        }
    };
    let workspace_cwd: Option<PathBuf> =
        app.try_state::<crate::workspace::WorkspaceStore>().and_then(|ws| {
            ws.snapshot()
                .workspaces
                .iter()
                .find(|w| w.id == workspace_id)
                .map(|w| PathBuf::from(&w.cwd))
        });

    for card in cards.iter().filter(|c| card_is_queue_eligible(c)) {
        if free == 0 {
            break;
        }
        let Some(template_id) = card.swarm_template_id.clone() else {
            continue;
        };
        let Some(cwd) = workspace_cwd.as_deref() else {
            log::warn!(
                "pump_card_queue: no workspace cwd for '{workspace_id}'; \
                 cannot dispatch card '{}'",
                card.id
            );
            mark_card_dispatch_failed(kanban, workspace_id, &card.id);
            continue;
        };

        let card_id = card.id.clone();
        let attempt = card_execution.run_attempt(
            &verify,
            kanban,
            workspace_id,
            &card_id,
            crate::card_execution::AuthorizationKind::QueuePump,
            || {
                // `ensure_for_card` and provider launch happen after
                // begin_attempt has released the card gate. The outer
                // QUEUE_PUMP_LOCK remains the only long-held serializer.
                // 1.176.2 (A5R-04): a copy made afresh starts from the
                // card's own branch (its workspace's target, or its area's),
                // as Start build's does — not always `main`.
                let base = match app.try_state::<crate::project_config::ProjectConfigStore>() {
                    Some(store) => crate::card_area::branch_for_card(&store, workspace_id, card)?,
                    None => "main".to_string(),
                };
                let ensured = {
                    // OB-7b: the worktree's fetch of origin as the
                    // workspace's GitHub account — only the fetch; the
                    // agents started below never see it (D7).
                    let _github = crate::github_account::enter_for_app(app, workspace_id);
                    crate::worktrees::ensure_for_card(cwd, &card.id, &card.title, &base)?
                };
                // v1.36.0 (memory Increment 2): compose the dispatch prompt
                // with memory injection. Missing stores degrade to the pure
                // body so queue admission never blocks on Memory.
                let goal = match (
                    app.try_state::<crate::memory::MemoryStore>(),
                    app.try_state::<crate::settings::SettingsStore>(),
                ) {
                    (Some(mem), Some(settings)) => {
                        let inject_global =
                            settings.snapshot().behavior.inject_global_memories;
                        card_compose_dispatch_prompt(card, &mem, inject_global)
                    }
                    _ => card_dispatch_prompt(card),
                };
                let swarm = crate::swarms::swarm_start(
                    app,
                    workspace_id,
                    &template_id,
                    &goal,
                    HashMap::new(),
                    Some(ensured.worktree_path.clone()),
                    crate::swarms::SwarmKind::Card,
                )?;
                Ok((swarm, ensured))
            },
            |(swarm, ensured)| {
                let wt = ensured.worktree_path.to_string_lossy().to_string();
                let branch = ensured.branch_name.clone();
                let linked = kanban.mutate_card(workspace_id, &card_id, |c| {
                    c.linked_swarm_id = Some(swarm.id.clone());
                    c.linked_run_id = None;
                    c.last_run_status = Some(LastRunStatus::Running);
                    if c.worktree_path.is_none() {
                        c.worktree_path = Some(wt.clone());
                        c.worktree_base = ensured.base.clone();
                    }
                    if c.branch_name.is_none() {
                        c.branch_name = Some(branch.clone());
                    }
                    Ok(())
                });
                if linked.is_ok() {
                    if let Some(base) = ensured.base.as_ref() {
                        crate::commands::emit_worktree_base_notice(
                            app,
                            workspace_id,
                            &card_id,
                            &card.title,
                            base,
                        );
                    }
                }
                linked
            },
            |(swarm, _)| {
                crate::swarms::abort_unlinked_start(
                    app,
                    &swarm.id,
                    "queued card swarm link failed",
                );
            },
        );
        match attempt {
            Ok((swarm, _)) => {
                log::info!(
                    "pump_card_queue: started swarm {} for queued card '{card_id}'",
                    swarm.id
                );
                // v1.33.0: the card's run-link fields changed — refresh
                // open kanban views.
                emit_kanban_changed(app, workspace_id);
                free -= 1;
            }
            Err(e)
                if crate::card_execution::CardExecutionGate::attempt_error_is_retryable(
                    &e,
                ) =>
            {
                // Verification is a per-card constraint. Preserve this
                // card's eligibility and scan later cards so one long check
                // does not consume the workspace's remaining parallel
                // capacity. The next pump reconsiders this card in its
                // original board order after verification clears.
                log::info!(
                    "pump_card_queue: card '{}' remains queued while checks run",
                    card.id
                );
                continue;
            }
            Err(e) => {
                log::warn!(
                    "pump_card_queue: dispatch for card '{}': {e}",
                    card.id
                );
                mark_card_dispatch_failed(kanban, workspace_id, &card.id);
                emit_kanban_changed(app, workspace_id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// 1.176.2 (A5R-04): the queue pump makes a missing copy from the
    /// card's own branch, resolved as Start build resolves it — never from a
    /// `main` written in.
    #[test]
    fn the_queue_pump_starts_a_copy_from_the_cards_own_branch() {
        let source = include_str!("kanban.rs");
        let pump = &source[source.find("pub fn pump_card_queue(").unwrap()..];
        let pump = &pump[..pump.find("\n}\n").unwrap()];
        assert!(pump.contains("crate::card_area::branch_for_card(&store, workspace_id, card)?"));
        assert!(pump.contains("ensure_for_card(cwd, &card.id, &card.title, &base)?"));
        assert!(!pump.contains("&card.title, \"main\")"));
    }

    #[test]
    fn read_only_preflight_uses_production_directory_and_refuses_write_triggers() {
        let temp = tempdir().unwrap();
        assert!(preflight_read_only(temp.path()).is_err());
        assert!(!temp.path().join(KANBAN_SUBDIR).exists());
        let root = temp.path().join(KANBAN_SUBDIR);
        fs::create_dir_all(&root).unwrap();
        assert!(preflight_read_only(temp.path()).is_ok());

        let mut file = KanbanFile::default();
        file.cards.push(sample_card("ws", KanbanColumnId::Todo));
        let path = root.join("ws.json");
        fs::write(&path, serde_json::to_vec(&file).unwrap()).unwrap();
        let baseline = fs::read(&path).unwrap();
        assert!(preflight_read_only(temp.path()).is_ok());
        assert_eq!(fs::read(&path).unwrap(), baseline);

        file.version = KANBAN_SCHEMA_VERSION - 1;
        fs::write(&path, serde_json::to_vec(&file).unwrap()).unwrap();
        let old = fs::read(&path).unwrap();
        assert!(preflight_read_only(temp.path()).is_err());
        assert_eq!(fs::read(&path).unwrap(), old);

        file.version = KANBAN_SCHEMA_VERSION;
        file.cards[0].intake_status = IntakeStatus::Active;
        fs::write(&path, serde_json::to_vec(&file).unwrap()).unwrap();
        let active = fs::read(&path).unwrap();
        assert!(preflight_read_only(temp.path()).is_err());
        assert_eq!(fs::read(&path).unwrap(), active);
    }

    /// 1.174.0 (A6 round 1): the launch backfill's earliest ship.
    #[test]
    fn earliest_ship_ms_reads_history_then_shipped_status() {
        let entry = |at: i64| ShipEntry {
            commit_sha: "abc".into(),
            shipped_version: "1.0.0".into(),
            release_kind: ReleaseKind::Local,
            shipped_at: at,
            target: None,
            tag: None,
        };
        let plain = sample_card("ws", KanbanColumnId::Todo);
        assert_eq!(earliest_ship_ms(&[plain.clone()], 99), None);
        let mut shipped = plain.clone();
        shipped.ship_status = ShipStatus::Shipped;
        assert_eq!(earliest_ship_ms(&[shipped.clone()], 99), Some(99));
        let mut a = plain.clone();
        a.ship_history = vec![entry(50), entry(30)];
        let mut b = plain.clone();
        b.ship_history = vec![entry(40)];
        assert_eq!(earliest_ship_ms(&[a, b, shipped], 99), Some(30));
    }

    fn sample_card(ws: &str, col: KanbanColumnId) -> KanbanCard {
        let idx = match col {
            KanbanColumnId::Todo => 0,
            KanbanColumnId::InProgress => 1,
            KanbanColumnId::Complete => 2,
        };
        KanbanCard {
            id: format!("card_{idx}"),
            workspace_id: ws.to_string(),
            title: "test".into(),
            notes: None,
            knowledge: None,
            column_id: col,
            agent_config_id: None,
            linked_run_id: None,
            last_run_status: None,
            swarm_template_id: None,
            linked_swarm_id: None,
            linked_brainstorm_id: None,
            dismissed_banners: Vec::new(),
            run_history: Vec::new(),
            suppress_run_history: false,
            builder: None,
            plan_challenge: None,
            dispatch_prompt: None,
            dispatch_prompt_edited_at: None,
            intake_status: IntakeStatus::None,
            intake_history: Vec::new(),
            archived: false,
            archived_at: None,
            auto_archived: false,
            put_backs: Vec::new(),
            verify_intent: None,
            verify_status: VerifyStatus::None,
            verify_history: Vec::new(),
            ship_status: ShipStatus::Unshipped,
            ship_history: Vec::new(),
            commit_sha: None,
            shipped_version: None,
            attachments: Vec::new(),
            worktree_path: None,
            branch_name: None,
            worktree_base: None,
            review_status: None,
            ship_conflict: None,
            review_decisions: Vec::new(),
            pr_url: None,
            pr: None,
            parent_card_id: None,
            gh_issue_number: None,
            sync_pending: false,
            gh_raw_remainder: None,
            gh_assignees: Vec::new(),
            gh_author: None,
            gh_claim: None,
            gh_claim_here: false,
            gh_claim_lost_to: None,
            gh_labels_pending: false,
            gh_last_read: None,
            edit_conflicts: Vec::new(),
            unassign_pending: false,
            gh_author_association: None,
            gh_last_editor: None,
            board_order: None,
            blocked_by: Vec::new(),
            builder_vendor_pref: None,
            builder_permissions: None,
            models: None,
            model_retries: Vec::new(),
            worktree_setup: None,
            checks_hold: None,
            port_base: None,
            build_both: None,
            line_comments: Vec::new(),
            branch_cleanup: None,
            kept_copy: None,
            follows_up: None,
            followed_up_by: Vec::new(),
            pr_review: None,
            pr_auto_fix: None,
            fix_round_check: None,
            fix_round_self_checks: 0,
            kind: None,
            twins_aligned: Vec::new(),
            twins_apart: Vec::new(),
            later_requests: Vec::new(),
            area: None,
            gh_area_label: None,
            from_copy: None,
            author: None,
            last_edited_by: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    // ── v1.39.0 (Recon-fork cycle, Increment 2) ────────────────────

    #[test]
    fn from_audit_constructor_sets_prefills_and_keeps_other_defaults() {
        let card = KanbanCard::from_audit(
            "c-new".into(),
            "ws".into(),
            "Implement: derived title".into(),
            "> Derived from audit card …\n\n## Recommendation\n\nFoo".into(),
            "c-parent".into(),
            Some("coordinator-feature".into()),
            KanbanColumnId::Todo,
        );
        // Prefilled
        assert_eq!(card.id, "c-new");
        assert_eq!(card.title, "Implement: derived title");
        assert_eq!(card.parent_card_id.as_deref(), Some("c-parent"));
        assert_eq!(card.swarm_template_id.as_deref(), Some("coordinator-feature"));
        assert!(card.knowledge.as_deref().unwrap().contains("## Recommendation"));
        assert_eq!(card.column_id, KanbanColumnId::Todo);
        // Critical: dispatch_prompt stays None (single source of truth in
        // knowledge — composition happens at dispatch time).
        assert!(card.dispatch_prompt.is_none());
        assert!(card.dispatch_prompt_edited_at.is_none());
        // agent_config_id stays None (forked cards run via swarm template).
        assert!(card.agent_config_id.is_none());
        // Attachments NOT inherited.
        assert!(card.attachments.is_empty());
        // No run/ship/review state.
        assert!(card.linked_run_id.is_none());
        assert!(card.linked_swarm_id.is_none());
        assert!(card.run_history.is_empty());
        assert_eq!(card.ship_status, ShipStatus::Unshipped);
        assert!(card.review_status.is_none());
    }

    #[test]
    fn parent_card_id_defaults_to_none_for_legacy_persisted_cards() {
        // v1.39.0 migration: pre-v1.39 persisted cards have no
        // `parentCardId` key in their JSON. Serde's #[serde(default)]
        // must make them deserialize as None.
        let legacy_json = r#"{
            "id": "c-legacy",
            "workspaceId": "ws",
            "title": "old card",
            "columnId": "todo",
            "createdAt": 0,
            "updatedAt": 0
        }"#;
        let card: KanbanCard = serde_json::from_str(legacy_json)
            .expect("legacy card JSON deserializes");
        assert!(card.parent_card_id.is_none());
        // Sanity: every other Option<_>/Vec<_>/default field also defaults.
        assert!(card.notes.is_none());
        assert!(card.knowledge.is_none());
        assert!(card.attachments.is_empty());
    }

    fn card_with_worktree(id: &str, column: KanbanColumnId, path: &str) -> KanbanCard {
        let mut card = KanbanCard::new(id.into(), "ws".into(), id.into(), None, column);
        card.worktree_path = Some(path.into());
        card.branch_name = Some(format!("atelier/{id}"));
        card.worktree_base = Some(crate::worktrees::WorktreeBase {
            commit: "abc".into(),
            ref_name: "origin/main".into(),
            source: crate::worktrees::BaseSource::Origin,
            note: None, origin_slug: None, origin_url: None, merged_target: None,
        });
        card
    }

    /// SL-0 app tester, Ship pilot: a board file that doesn't parse read as
    /// an empty board and the next save wrote over it. It is set aside, said
    /// once, and a new board never touches it.
    #[test]
    fn an_unreadable_board_is_set_aside_and_never_written_over() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let dir = tmp.path().join(KANBAN_SUBDIR);
        let garbage = br#"{"version":8,"cards":[{"id":"c1","worktreeBase":"sha"}]}"#;
        fs::write(dir.join("ws.json"), garbage).unwrap();

        assert!(store.load("ws").unwrap().is_empty());
        assert!(!dir.join("ws.json").exists(), "the unreadable file is moved out of the way");
        let notice = store.take_notice("ws").expect("said once");
        assert!(!notice.restored, "no backup: an empty board");
        let aside = notice.kept_as;
        assert!(aside.file_name().unwrap().to_string_lossy().starts_with("ws.json.unreadable-"));
        assert_eq!(store.take_notice("ws"), None, "only once");
        assert_eq!(store.not_whole("ws"), Some(aside.clone()), "the session keeps knowing");
        assert!(store.load_whole("ws").unwrap_err().contains("aren't the whole picture"));

        store.create_card("ws", card_with_worktree("new", KanbanColumnId::Todo, "/x")).unwrap();
        assert_eq!(fs::read(&aside).unwrap(), garbage, "the old cards are still there");
        assert_eq!(store.load("ws").unwrap().len(), 1);
    }

    /// C17: a write that reads the board first (no `load()` before it) sets
    /// an unreadable file aside too, instead of writing a fresh board over it.
    #[test]
    fn a_write_before_any_load_never_writes_over_an_unreadable_board() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let dir = tmp.path().join(KANBAN_SUBDIR);
        fs::write(dir.join("ws.json"), b"not json").unwrap();
        store.create_card("ws", card_with_worktree("new", KanbanColumnId::Todo, "/x")).unwrap();
        let aside = store.take_notice("ws").expect("set aside").kept_as;
        assert!(aside.file_name().unwrap().to_string_lossy().starts_with("ws.json.unreadable-"));
        assert_eq!(fs::read(&aside).unwrap(), b"not json", "the old bytes are kept");
        assert_eq!(store.load("ws").unwrap().len(), 1, "a fresh board");
    }

    /// A board of `ids` saved twice over, so `ws.json` and `ws.json.bak` both
    /// hold cards; returns the board directory.
    fn saved_board_with_backup(root: &Path, ids: &[&str]) -> PathBuf {
        let store = KanbanStore::new(root.to_path_buf()).unwrap();
        for id in ids {
            store.create_card("ws", card_with_worktree(id, KanbanColumnId::Todo, "/x")).unwrap();
        }
        let dir = root.join(KANBAN_SUBDIR);
        assert!(board_card_count_at(&dir.join("ws.json.bak")).is_some_and(|n| n > 0), "a backup with cards");
        dir
    }

    fn unreadable_files(dir: &Path) -> Vec<PathBuf> {
        fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                let name = p.file_name().unwrap().to_string_lossy().into_owned();
                name.starts_with("ws.json.unreadable-") && !name.ends_with(".unsaid")
            })
            .collect()
    }

    fn ids_of(cards: &[KanbanCard]) -> Vec<&str> {
        cards.iter().map(|c| c.id.as_str()).collect()
    }

    /// Every file in the boards folder with its bytes, by name.
    fn folder(dir: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
        fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| (e.file_name().to_string_lossy().into_owned(), fs::read(e.path()).unwrap()))
            .collect()
    }

    /// R2 (owner, 2026-11-09): a board file that can't be read — zero bytes
    /// where a board was, or bytes that don't parse — opens from its last
    /// saved copy. The cards are there after the load, the unreadable file
    /// is kept as found, the backup is byte-identical, it is said once as
    /// restored, and the session keeps knowing the board isn't whole. Two
    /// saves later the restored cards are still the board.
    #[test]
    fn an_unreadable_board_file_opens_from_its_last_saved_copy() {
        for unreadable in [&b""[..], &br#"{"version":8,"cards":[{"id":"c1","worktreeBase":"sha"}]}"#[..], &b"\x00\xff{"[..]] {
            let what = String::from_utf8_lossy(unreadable).into_owned();
            let tmp = tempdir().unwrap();
            let dir = saved_board_with_backup(tmp.path(), &["a", "b", "c"]);
            let backup = fs::read(dir.join("ws.json.bak")).unwrap();
            fs::write(dir.join("ws.json"), unreadable).unwrap();

            let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
            let cards = store.load("ws").unwrap();
            assert_eq!(ids_of(&cards), ["a", "b"], "{what}: the backup's cards (one save behind)");
            assert_eq!(fs::read(dir.join("ws.json.bak")).unwrap(), backup, "{what}: the backup is byte-identical");
            let notice = store.take_notice("ws").expect("said");
            assert!(notice.restored, "{what}");
            assert_eq!(unreadable_files(&dir), vec![notice.kept_as.clone()], "{what}");
            assert_eq!(fs::read(&notice.kept_as).unwrap(), unreadable, "{what}: kept as found");
            assert_eq!(store.take_notice("ws"), None, "{what}: said once");
            assert!(store.take_all_notices().is_empty(), "{what}: nor by the launch's ask");
            // The board file is the restored board, written before the cache was filled.
            let on_disk: KanbanFile = serde_json::from_slice(&fs::read(dir.join("ws.json")).unwrap()).unwrap();
            assert_eq!((on_disk.version, ids_of(&on_disk.cards)), (KANBAN_SCHEMA_VERSION, vec!["a", "b"]), "{what}");
            // The session keeps knowing: nothing is pruned on these cards.
            assert_eq!(store.not_whole("ws"), Some(notice.kept_as.clone()));
            assert_eq!(store.first_not_whole(), Some(("ws".to_string(), notice.kept_as.clone())));
            assert!(store.load_whole("ws").is_err(), "{what}");
            assert!(matches!(store.restored_from_backup("ws"), Some((written, false)) if written > 0));

            // Two saves later the restored cards are still the board, the
            // backup is a board that holds them, and the kept file is as found.
            store.create_card("ws", card_with_worktree("new", KanbanColumnId::Todo, "/x")).unwrap();
            store.create_card("ws", card_with_worktree("newer", KanbanColumnId::Todo, "/x")).unwrap();
            let again = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
            assert_eq!(ids_of(&again.load("ws").unwrap()), ["a", "b", "new", "newer"], "{what}");
            assert_eq!(again.not_whole("ws"), None, "{what}: a new session reads a whole board");
            let rolled: KanbanFile = serde_json::from_slice(&fs::read(dir.join("ws.json.bak")).unwrap()).unwrap();
            assert_eq!(ids_of(&rolled.cards), ["a", "b", "new"], "{what}");
            assert_eq!(fs::read(&notice.kept_as).unwrap(), unreadable, "{what}: never touched again");
            assert_eq!(unreadable_files(&dir).len(), 1, "{what}");
        }
    }

    /// R2: a write that reads the board first (no `load()` before it) opens
    /// the last saved copy too, and adds to it.
    #[test]
    fn a_write_before_any_load_opens_the_last_saved_copy() {
        let tmp = tempdir().unwrap();
        let dir = saved_board_with_backup(tmp.path(), &["a", "b", "c"]);
        let backup = fs::read(dir.join("ws.json.bak")).unwrap();
        fs::write(dir.join("ws.json"), b"").unwrap();

        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store.create_card("ws", card_with_worktree("new", KanbanColumnId::Todo, "/x")).unwrap();
        assert_eq!(ids_of(&store.load("ws").unwrap()), ["a", "b", "new"]);
        let notice = store.take_notice("ws").expect("said");
        assert!(notice.restored);
        assert_eq!(fs::read(&notice.kept_as).unwrap(), b"");
        // That save rolled the restored board — the backup's own cards — into the backup.
        let rolled: KanbanFile = serde_json::from_slice(&fs::read(dir.join("ws.json.bak")).unwrap()).unwrap();
        let before: KanbanFile = serde_json::from_slice(&backup).unwrap();
        assert_eq!(ids_of(&rolled.cards), ids_of(&before.cards));
    }

    /// R2: the backup goes through the same migration and restart settling
    /// as a board that loads, never raw: a v1 backup's Complete card is
    /// marked shipped, a Builder session reads as lost, and the board file
    /// is written under the current version.
    #[test]
    fn a_board_opened_from_its_backup_is_migrated_and_settled() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let dir = tmp.path().join(KANBAN_SUBDIR);
        let done = card_with_worktree("done", KanbanColumnId::Complete, "/x");
        assert_ne!(done.ship_status, ShipStatus::Shipped);
        let mut busy = card_with_worktree("busy", KanbanColumnId::InProgress, "/y");
        busy.intake_status = IntakeStatus::Active;
        let v1 = serde_json::to_vec(&KanbanFile { version: 1, cards: vec![done, busy] }).unwrap();
        fs::write(dir.join("ws.json.bak"), &v1).unwrap();
        fs::write(dir.join("ws.json"), b"{cut").unwrap();

        let cards = store.load("ws").unwrap();
        assert_eq!(ids_of(&cards), ["done", "busy"]);
        assert_eq!((cards[0].verify_status, cards[0].ship_status), (VerifyStatus::Legacy, ShipStatus::Shipped));
        assert_eq!(cards[1].intake_status, IntakeStatus::None);
        let on_disk: KanbanFile = serde_json::from_slice(&fs::read(dir.join("ws.json")).unwrap()).unwrap();
        assert_eq!(on_disk.version, KANBAN_SCHEMA_VERSION);
        assert_eq!(on_disk.cards[0].ship_status, ShipStatus::Shipped);
        assert_eq!(on_disk.cards[1].intake_status, IntakeStatus::None);
        assert_eq!(fs::read(dir.join("ws.json.bak")).unwrap(), v1, "the backup is byte-identical");
    }

    /// R2: a backup a newer Plyloft wrote is refused like a newer board, by
    /// the load and by every write, and both files are left as they are.
    #[test]
    fn a_backup_from_a_newer_plyloft_is_refused_and_both_files_are_left() {
        let next = KANBAN_SCHEMA_VERSION + 1;
        let refusal = crate::atomic::newer_refusal("This board", next, KANBAN_SCHEMA_VERSION);
        let parses = format!(r#"{{"version":{next},"cards":[]}}"#);
        let strict = format!(r#"{{"version":{next},"cards":[{{"id":"c1","columnId":"somewhereNew"}}]}}"#);
        for newer in [parses, strict] {
            for unreadable in [&b""[..], &b"{cut"[..]] {
                let tmp = tempdir().unwrap();
                let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
                let dir = tmp.path().join(KANBAN_SUBDIR);
                fs::write(dir.join("ws.json.bak"), &newer).unwrap();
                fs::write(dir.join("ws.json"), unreadable).unwrap();
                let before = folder(&dir);
                let card = || card_with_worktree("new", KanbanColumnId::Todo, "/x");
                assert_eq!(store.create_card("ws", card()).expect_err("write refused"), refusal, "{newer}");
                assert_eq!(store.load("ws").expect_err("load refused"), refusal, "{newer}");
                assert_eq!(store.create_card("ws", card()).expect_err("write refused"), refusal, "{newer}");
                assert_eq!(folder(&dir), before, "{newer}: both files byte-identical, nothing beside them");
                assert_eq!(store.take_notice("ws"), None, "never set aside");
            }
        }
    }

    /// R2: when the restored board can't be written, the load fails and
    /// nothing has changed: the unreadable file is where it was, the backup
    /// is byte-identical, no copy is left beside them, and nothing is cached
    /// (the next load, with the write possible again, restores).
    #[test]
    fn a_restore_that_cannot_be_written_fails_the_load_and_changes_nothing() {
        let tmp = tempdir().unwrap();
        let dir = saved_board_with_backup(tmp.path(), &["a", "b", "c"]);
        fs::write(dir.join("ws.json"), b"{cut").unwrap();
        // The atomic writer's temp name is taken by a folder: the write fails.
        let blocker = dir.join(format!("ws.json{}", crate::atomic::TEMP_SUFFIX));
        fs::create_dir(&blocker).unwrap();
        let before = folder_files(&dir);

        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let error = store.load("ws").expect_err("the load fails");
        assert!(error.contains("board for ws") && error.contains("write"), "{error}");
        assert_eq!(folder_files(&dir), before, "nothing changed, and no copy left behind");
        assert_eq!((store.take_notice("ws"), store.not_whole("ws")), (None, None));
        assert!(store.create_card("ws", card_with_worktree("new", KanbanColumnId::Todo, "/x")).is_err(), "no write over it");
        assert_eq!(folder_files(&dir), before);

        fs::remove_dir(&blocker).unwrap();
        assert_eq!(ids_of(&store.load("ws").unwrap()), ["a", "b"], "nothing was cached: the next load restores");
        assert!(store.take_notice("ws").unwrap().restored);
    }

    fn marker_at(dir: &Path) -> Option<RestoredMarker> {
        fs::read(dir.join("ws.json.restored")).ok().map(|bytes| serde_json::from_slice(&bytes).unwrap())
    }

    /// T2: "restored, not yet read from GitHub" survives a quit. The restore
    /// leaves `<id>.json.restored` with the backup's time; a store opened on
    /// the same folder afterwards (a relaunch) reads the board as it is —
    /// whole — and is told again what is still owed: the notice until it was
    /// shown, the first read from GitHub until it went through. Once both
    /// happened the marker is gone.
    #[test]
    fn a_restored_board_is_still_known_after_a_relaunch() {
        let tmp = tempdir().unwrap();
        let dir = saved_board_with_backup(tmp.path(), &["a", "b", "c"]);
        fs::write(dir.join("ws.json"), b"").unwrap();
        let relaunch = || KanbanStore::new(tmp.path().to_path_buf()).unwrap();

        // The launch that restores, then a quit before anything was said or read.
        let first = relaunch();
        assert_eq!(ids_of(&first.load("ws").unwrap()), ["a", "b"]);
        let (written, _) = first.restored_from_backup("ws").unwrap();
        let kept = first.not_whole("ws").unwrap();
        let marker = marker_at(&dir).expect("written with the restore");
        assert_eq!((marker.backup_written_ms, marker.said, marker.pulled), (written, false, false));
        assert_eq!(PathBuf::from(&marker.kept_as), kept);
        drop(first);

        // The next launch: an ordinary board file, and the marker beside it.
        let second = relaunch();
        assert_eq!(ids_of(&second.load("ws").unwrap()), ["a", "b"]);
        assert_eq!(second.not_whole("ws"), None, "the cards were read as they are: whole");
        assert_eq!(second.first_not_whole(), None);
        assert!(second.load_whole("ws").is_ok());
        assert_eq!(second.restored_from_backup("ws"), Some((written, false)), "the backup's time, from the marker");
        assert_eq!(second.restored_awaiting_pull(), ["ws"], "its issue writes are held again");
        let notice = second.take_notice("ws").expect("the notice that was never shown");
        assert_eq!(notice, BoardNotice { restored: true, kept_as: kept.clone(), auto_merge_off: 0 });
        // W3: handed to the window is not said; shown is.
        assert_eq!(second.take_notice("ws"), None, "handed out once a session");
        assert!(!marker_at(&dir).unwrap().said);
        second.note_said("ws");
        assert!(marker_at(&dir).unwrap().said, "remembered beside the board");
        // A write before any load re-arms it too.
        let by_write = relaunch();
        by_write.create_card("ws", card_with_worktree("new", KanbanColumnId::Todo, "/x")).unwrap();
        assert_eq!(by_write.restored_awaiting_pull(), ["ws"]);
        drop((second, by_write));

        // A third launch: said already, still not read.
        let third = relaunch();
        third.load("ws").unwrap();
        assert_eq!(third.take_notice("ws"), None, "not said twice");
        assert!(third.take_all_notices().is_empty());
        assert_eq!(third.restored_awaiting_pull(), ["ws"]);
        third.note_pulled("ws");
        assert!(third.restored_awaiting_pull().is_empty());
        assert_eq!(marker_at(&dir), None, "said and read: nothing left to remember");
        assert!(!dir.join("ws.json.restored").exists());
        drop(third);

        let fourth = relaunch();
        fourth.load("ws").unwrap();
        assert_eq!((fourth.restored_from_backup("ws"), fourth.take_notice("ws")), (None, None));
    }

    /// W3: a notice counts as said only once the window has shown it. Three
    /// boards in trouble at one launch — one opened from its copy, two set
    /// aside with no copy to open — are handed to the window; it shows the
    /// first and Plyloft quits. The other two come back at the next launch,
    /// the first doesn't; once shown, none does. The boards themselves are
    /// ordinary by then: nothing is "not whole" again because of a notice.
    #[test]
    fn a_notice_handed_out_but_never_shown_comes_back_at_the_next_launch() {
        let tmp = tempdir().unwrap();
        let dir = tmp.path().join(KANBAN_SUBDIR);
        {
            let before = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
            for ws in ["a", "b", "c"] {
                for id in ["1", "2", "3"] {
                    let mut card = card_with_worktree(id, KanbanColumnId::Todo, "/x");
                    card.workspace_id = ws.into();
                    before.create_card(ws, card).unwrap();
                }
            }
        }
        fs::write(dir.join("a.json"), b"").unwrap(); // opened from its copy
        for ws in ["b", "c"] {
            fs::write(dir.join(format!("{ws}.json")), b"{cut").unwrap(); // no copy to open
            fs::remove_file(dir.join(format!("{ws}.json.bak"))).unwrap();
        }
        let launch = || {
            let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
            for ws in ["a", "b", "c"] {
                store.load(ws).unwrap();
            }
            store
        };
        let ids = |notices: &[(String, BoardNotice)]| notices.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>();

        let first = launch();
        let handed = first.take_all_notices();
        assert_eq!(ids(&handed), ["a", "b", "c"]);
        assert!(first.take_all_notices().is_empty(), "handed out once a session");
        assert_eq!(first.take_notice("b"), None, "nor by the board's own ask");
        let kept_b = handed[1].1.kept_as.clone();
        assert!(unsaid_path(&kept_b).exists(), "a board that started empty notes it beside the kept file");
        first.note_said("a"); // the first toast is on screen; then the quit
        drop(first);

        let second = launch();
        assert_eq!(second.first_not_whole(), None, "ordinary boards by now");
        let back = second.take_all_notices();
        assert_eq!(ids(&back), ["b", "c"], "the two that were never shown");
        assert_eq!(back[0].1, BoardNotice { restored: false, kept_as: kept_b.clone(), auto_merge_off: 0 });
        assert_eq!(second.trouble_kept_as("b"), Some(kept_b.clone()));
        assert_eq!(second.trouble_kept_as("a"), handed[0].1.kept_as.clone().into(), "its marker still owes the read");
        second.note_said("b");
        assert!(!unsaid_path(&kept_b).exists());
        assert_eq!(fs::read(&kept_b).unwrap(), b"{cut", "the kept file is never touched");
        drop(second);

        // A card added since doesn't change what is owed.
        let third = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        third.create_card("c", card_with_worktree("new", KanbanColumnId::Todo, "/x")).unwrap();
        assert_eq!(ids(&third.take_all_notices()), ["c"]);
        third.note_said("c");
        drop(third);
        assert!(launch().take_all_notices().is_empty(), "each was shown once");

        // The kept file moved away by hand: nothing is left to name.
        let tmp = tempdir().unwrap();
        let dir = tmp.path().join(KANBAN_SUBDIR);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("ws.json"), b"{cut").unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store.load("ws").unwrap();
        let kept = store.take_notice("ws").unwrap().kept_as;
        drop(store);
        fs::remove_file(&kept).unwrap();
        let again = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        again.load("ws").unwrap();
        assert_eq!(again.take_notice("ws"), None);
        assert!(!unsaid_path(&kept).exists(), "removed with it");
    }

    /// T2: the two halves in the other order — read from GitHub first, the
    /// notice still owed — and a board that isn't on GitHub Issues, whose
    /// marker goes as soon as its notice was shown.
    #[test]
    fn the_marker_goes_when_nothing_is_owed_any_more() {
        let tmp = tempdir().unwrap();
        let dir = saved_board_with_backup(tmp.path(), &["a", "b", "c"]);
        fs::write(dir.join("ws.json"), b"{cut").unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store.load("ws").unwrap();
        store.note_pulled("ws");
        let marker = marker_at(&dir).expect("the notice is still owed");
        assert!(marker.pulled && !marker.said);
        let again = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        again.load("ws").unwrap();
        assert!(again.restored_awaiting_pull().is_empty(), "read already: nothing held");
        assert!(again.take_notice("ws").unwrap().restored);
        assert!(marker_at(&dir).is_some(), "handed out, not shown yet");
        again.note_said("ws");
        assert_eq!(marker_at(&dir), None);

        // A local board: said, then settled — no read from GitHub to wait for.
        let tmp = tempdir().unwrap();
        let dir = saved_board_with_backup(tmp.path(), &["a", "b", "c"]);
        fs::write(dir.join("ws.json"), b"").unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store.load("ws").unwrap();
        store.settle_local_restore("ws");
        assert!(marker_at(&dir).is_some(), "not before its notice was shown");
        store.take_notice("ws").unwrap();
        store.settle_local_restore("ws");
        assert!(marker_at(&dir).is_some(), "handed out is not shown");
        store.note_said("ws");
        store.settle_local_restore("ws");
        assert_eq!(marker_at(&dir), None);
        assert!(store.restored_from_backup("ws").is_some(), "this session still knows");
        let again = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        again.load("ws").unwrap();
        assert_eq!((again.restored_from_backup("ws"), again.take_notice("ws")), (None, None));
    }

    /// T2: the marker is written before the board. One that can't be
    /// written fails the restore with nothing changed; one left with no
    /// restored board beside it — the board is gone, was set aside, or its
    /// project was removed — is removed; one that doesn't parse is too.
    #[test]
    fn a_marker_never_outlives_or_precedes_its_restored_board() {
        let tmp = tempdir().unwrap();
        let dir = saved_board_with_backup(tmp.path(), &["a", "b", "c"]);
        fs::write(dir.join("ws.json"), b"{cut").unwrap();
        let blocker = dir.join(format!("ws.json.restored{}", crate::atomic::TEMP_SUFFIX));
        fs::create_dir(&blocker).unwrap();
        let before = folder_files(&dir);
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let error = store.load("ws").expect_err("no restore without its marker");
        assert!(error.contains("ws.json.restored"), "{error}");
        assert_eq!(folder_files(&dir), before, "nothing changed, no copy and no marker left");
        fs::remove_dir(&blocker).unwrap();
        assert_eq!(ids_of(&store.load("ws").unwrap()), ["a", "b"]);
        assert!(marker_at(&dir).is_some());

        // The board is gone (removed by hand): the marker goes at the next start.
        fs::remove_file(dir.join("ws.json")).unwrap();
        let again = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        assert!(!dir.join("ws.json.restored").exists(), "removed when the store opens");
        assert_eq!(again.restored_from_backup("ws"), None);

        // The restored board is set aside at a later launch (no copy to open by then).
        let tmp = tempdir().unwrap();
        let dir = saved_board_with_backup(tmp.path(), &["a", "b", "c"]);
        fs::write(dir.join("ws.json"), b"").unwrap();
        KanbanStore::new(tmp.path().to_path_buf()).unwrap().load("ws").unwrap();
        fs::write(dir.join("ws.json"), b"{cut again").unwrap();
        fs::remove_file(dir.join("ws.json.bak")).unwrap();
        let later = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        assert!(later.load("ws").unwrap().is_empty());
        assert!(!dir.join("ws.json.restored").exists());
        assert!(!later.take_notice("ws").unwrap().restored);
        later.note_said("ws");
        assert_eq!(later.restored_from_backup("ws"), None);

        // Its project is removed.
        let tmp = tempdir().unwrap();
        let dir = saved_board_with_backup(tmp.path(), &["a", "b", "c"]);
        fs::write(dir.join("ws.json"), b"").unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store.load("ws").unwrap();
        store.delete_workspace("ws").unwrap();
        assert!(!dir.join("ws.json.restored").exists());
        assert!(store.restored_awaiting_pull().is_empty());

        // A marker that doesn't parse says nothing usable.
        let tmp = tempdir().unwrap();
        let dir = saved_board_with_backup(tmp.path(), &["a", "b"]);
        fs::write(dir.join("ws.json.restored"), b"{cut").unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(ids_of(&store.load("ws").unwrap()), ["a", "b"]);
        assert!(!dir.join("ws.json.restored").exists());
        assert_eq!(store.restored_from_backup("ws"), None);
    }

    /// T2: `<id>.json.restored` is not a board. Everything that lists the
    /// boards folder goes by the name `<id>.json` and must never see it: the
    /// store's own listings, the read-only preflight, the launch inventory
    /// and its check for boards, the project list's check, and History.
    #[test]
    fn a_restored_marker_is_never_taken_for_a_board() {
        let tmp = tempdir().unwrap();
        let dir = saved_board_with_backup(tmp.path(), &["a", "b", "c"]);
        fs::write(dir.join("ws.json"), b"").unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store.load("ws").unwrap();
        assert!(dir.join("ws.json.restored").exists());

        assert_eq!(store.board_ids(&store.cache.lock()), ["ws"]);
        let fresh = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(fresh.board_ids(&HashMap::new()), ["ws"], "from the folder alone");
        // Walks every board file on disk: only `ws` is loaded.
        fresh.reconcile_orphan_runs(&["no-such-run".to_string()]);
        assert_eq!(fresh.cache.lock().keys().cloned().collect::<Vec<_>>(), ["ws"]);
        preflight_read_only(tmp.path()).expect("the marker is no board to refuse");
        assert_eq!(crate::history_search::classify("kanban/workspaces/ws.json.restored"), None);
        assert!(crate::history_search::classify("kanban/workspaces/ws.json").is_some());

        // Alone in a boards folder it is no board at all.
        let alone = tempdir().unwrap();
        let boards = alone.path().join(KANBAN_SUBDIR);
        fs::create_dir_all(&boards).unwrap();
        fs::copy(dir.join("ws.json.restored"), boards.join("old.json.restored")).unwrap();
        assert!(!crate::launch_inventory::has_board_file(&boards));
        // An empty project list beside it is still a fresh profile, not a lost list.
        fs::write(alone.path().join("workspaces.json"), b"").unwrap();
        let list = crate::workspace::WorkspaceStore::new(alone.path().to_path_buf()).unwrap();
        assert_eq!(list.trouble(), None);
        assert!(peek_board(&boards.join("old.json")).is_err(), "there is no such board");
    }

    /// [`folder`] without the sub-folders (a test's own obstacle).
    fn folder_files(dir: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
        fs::read_dir(dir)
            .unwrap()
            .flatten()
            .filter(|e| e.path().is_file())
            .map(|e| (e.file_name().to_string_lossy().into_owned(), fs::read(e.path()).unwrap()))
            .collect()
    }

    /// R2: a backup that holds cards this build can't open is not opened —
    /// and not left for the next saves to roll over: it is set aside as
    /// found before the unreadable file is, and the board starts empty. For
    /// an empty file the notice points at the backup, which holds the cards.
    #[test]
    fn a_backup_with_cards_this_build_cannot_open_is_set_aside_as_found() {
        let unusable = br#"{"version":8,"cards":[{"id":"c1","columnId":"somewhereNew"}]}"#;
        for unreadable in [&b""[..], &b"{cut"[..]] {
            let tmp = tempdir().unwrap();
            let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
            let dir = tmp.path().join(KANBAN_SUBDIR);
            fs::write(dir.join("ws.json.bak"), unusable).unwrap();
            fs::write(dir.join("ws.json"), unreadable).unwrap();

            assert!(store.load("ws").unwrap().is_empty());
            let notice = store.take_notice("ws").expect("said");
            assert!(!notice.restored);
            store.note_said("ws");
            let kept = folder(&dir);
            assert_eq!(kept.len(), 2, "{:?}", kept.keys());
            let (backup_aside, bytes) = kept.iter().find(|(name, _)| name.starts_with("ws.json.bak.unreadable-")).expect("the backup, set aside");
            assert_eq!(bytes, unusable, "as found");
            let (aside, bytes) = kept.iter().find(|(name, _)| name.starts_with("ws.json.unreadable-")).expect("the file, set aside");
            assert_eq!(bytes, unreadable, "as found");
            let pointed = notice.kept_as.file_name().unwrap().to_string_lossy().into_owned();
            assert_eq!(&pointed, if unreadable.is_empty() { backup_aside } else { aside });

            // The saves that follow touch neither.
            store.create_card("ws", card_with_worktree("new", KanbanColumnId::Todo, "/x")).unwrap();
            store.create_card("ws", card_with_worktree("newer", KanbanColumnId::Todo, "/x")).unwrap();
            let after = folder(&dir);
            assert_eq!(after[backup_aside], unusable);
            assert_eq!(after[aside], unreadable);
        }
    }

    /// OP-2: with no backup that is a board, an empty file is an empty board,
    /// as before: nothing is moved and nothing is said.
    #[test]
    fn an_empty_board_file_without_a_usable_backup_is_an_empty_board() {
        // R2 (Reviewer 12): a backup that is a board without cards has
        // nothing to open either.
        let no_cards = br#"{"version":8,"cards":[]}"#;
        for backup in [None, Some(&b""[..]), Some(&b"not json"[..]), Some(&no_cards[..])] {
            let tmp = tempdir().unwrap();
            let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
            let dir = tmp.path().join(KANBAN_SUBDIR);
            fs::write(dir.join("ws.json"), b"").unwrap();
            if let Some(bytes) = backup {
                fs::write(dir.join("ws.json.bak"), bytes).unwrap();
            }
            assert!(store.load("ws").unwrap().is_empty(), "{backup:?}");
            assert_eq!(store.take_notice("ws"), None, "{backup:?}: nothing to say");
            assert_eq!(store.not_whole("ws"), None, "{backup:?}");
            assert!(unreadable_files(&dir).is_empty(), "{backup:?}: nothing set aside");
            store.create_card("ws", card_with_worktree("new", KanbanColumnId::Todo, "/x")).unwrap();
            assert_eq!(store.load("ws").unwrap().len(), 1, "{backup:?}");
        }
    }

    /// X1 (Windows walk): the boards folder is named with the platform's
    /// own separators, so the path a notice shows — and the one in the log —
    /// has no `/` on Windows (it read `…\kanban/workspaces\<id>.json…`).
    /// Under `cfg(windows)` this fails on a `/`; elsewhere it holds the same
    /// path to the joined form. What catches the mistake on any platform is
    /// the source pin below: production code never joins the folder's name
    /// as one string.
    #[test]
    fn boards_dir_is_never_joined_with_a_slash() {
        let base = if cfg!(windows) { PathBuf::from(r"C:\Users\me\AppData\Roaming\com.mbadv.ply") } else { PathBuf::from("/Users/me/Library/Application Support/com.mbadv.ply") };
        let joined: PathBuf = [base.as_path(), Path::new("kanban"), Path::new("workspaces")].iter().collect();
        let dir = boards_dir(&base);
        assert_eq!(dir.to_string_lossy(), joined.to_string_lossy(), "the same text, not only the same components");
        let foreign = if cfg!(windows) { '/' } else { '\\' };
        let store = KanbanStore { config_dir: base.clone(), cache: Mutex::new(HashMap::new()), unreadable: Mutex::new(HashMap::new()) };
        let kept = crate::atomic::set_aside_name_for_test(&store.workspace_path("ws"));
        for shown in [dir.clone(), store.workspace_path("ws"), restored_marker_path(&store.workspace_path("ws")), backup_path(&store.workspace_path("ws")), store.deleted_cards_path("ws"), kept] {
            let text = shown.to_string_lossy().into_owned();
            assert!(!text.contains(foreign), "{text}");
            assert!(text.starts_with(&*base.to_string_lossy()), "{text}");
        }
        let sep = std::path::MAIN_SEPARATOR;
        assert!(store.workspace_path("ws").to_string_lossy().ends_with(&format!("{sep}kanban{sep}workspaces{sep}ws.json")));

        // No production code spells a `kanban/…` path as one string: not in
        // a join, a `format!`, a `Path::new` or a `push`. Every source file
        // is read, subfolders too; tests and comments are not code. The only
        // such strings left are the folder's two names (joined part by part
        // by `config_subdir`), the read-only check's message, and History's
        // reading of a relative path it has already turned to `/`.
        let allowed = [
            "pub(crate) const KANBAN_SUBDIR: &str = \"kanban/workspaces\";",
            "pub(crate) const DELETED_CARDS_SUBDIR: &str = \"kanban/deleted-cards\";",
            "return Err(\"kanban/workspaces directory is missing\".into());",
            "if let Some(rest) = rel.strip_prefix(\"kanban/workspaces/\") {",
        ];
        fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
            for entry in fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                if path.is_dir() {
                    if name != "tests" && !name.ends_with("_fixtures") {
                        sources(&path, out);
                    }
                } else if name.ends_with(".rs") && !name.ends_with("_tests.rs") && name != "tests.rs" {
                    out.push(path);
                }
            }
        }
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        sources(&src, &mut files);
        // (Today the subfolders hold only tests and fixtures; the walk goes
        // into them all the same, for the day one holds code.)
        let nested = tempdir().unwrap();
        fs::create_dir_all(nested.path().join("lane").join("tests")).unwrap();
        for file in ["top.rs", "lane/inner.rs", "lane/inner_tests.rs", "lane/tests.rs", "lane/tests/deep.rs", "lane/notes.md"] {
            fs::write(nested.path().join(file), "").unwrap();
        }
        let mut walked = Vec::new();
        sources(nested.path(), &mut walked);
        walked.sort();
        assert_eq!(walked, [nested.path().join("lane").join("inner.rs"), nested.path().join("top.rs")], "subfolders are read, tests are not");
        let (mut seen, mut found) = (0, Vec::new());
        for file in &files {
            let name = file.strip_prefix(&src).unwrap().to_string_lossy().into_owned();
            let source = fs::read_to_string(file).unwrap();
            let code = source.split("#[cfg(test)]\nmod tests").next().unwrap();
            seen += code.matches("boards_dir(").count();
            for bad in [".join(KANBAN_SUBDIR)", ".join(crate::kanban::KANBAN_SUBDIR)", ".join(DELETED_CARDS_SUBDIR)"] {
                assert!(!code.contains(bad), "{name}: `{bad}` keeps the `/` on Windows; use kanban::boards_dir");
            }
            for line in code.lines().map(str::trim).filter(|line| !line.starts_with("//") && line.contains("\"kanban/")) {
                if allowed.contains(&line) {
                    found.push(line.to_string());
                } else {
                    panic!("{name}: `{line}` spells a kanban path with a `/`, which Windows keeps; use kanban::boards_dir");
                }
            }
        }
        assert!(seen >= 8, "the scan found the known uses: {seen}");
        found.sort();
        found.dedup();
        assert_eq!(found.len(), allowed.len(), "each allowed line is still there: {found:?}");
    }

    /// X1 follow-up: a marker written before X1 holds its kept file's path
    /// with a `/` in it on Windows. Read back, it is spelled as the platform
    /// spells paths, so the notice's Show in File Explorer gets a native
    /// path; a path that already is one is not changed. (Under
    /// `cfg(windows)` this fails on a `/`; elsewhere it holds the path
    /// equal, and that the marker's reader goes through `native_path`.)
    #[test]
    fn a_marker_s_kept_path_is_read_back_in_the_platform_s_own_spelling() {
        #[cfg(windows)]
        {
            let stored = "C:\\Users\\me\\AppData\\Roaming\\com.mbadv.ply\\kanban/workspaces\\ws.json.unreadable-17";
            let read = native_path(stored);
            assert!(!read.to_string_lossy().contains('/'), "{read:?}");
            assert_eq!(read.to_string_lossy(), stored.replace('/', "\\"));
        }
        let tmp = tempdir().unwrap();
        let dir = saved_board_with_backup(tmp.path(), &["a", "b", "c"]);
        fs::write(dir.join("ws.json"), b"").unwrap();
        let first = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        first.load("ws").unwrap();
        let kept = first.trouble_kept_as("ws").unwrap();
        drop(first);
        let stored = marker_at(&dir).unwrap().kept_as;
        assert_eq!(native_path(&stored), kept, "a native path is read back as it is");
        let again = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        again.load("ws").unwrap();
        let read = again.trouble_kept_as("ws").unwrap();
        assert_eq!(read, kept);
        let foreign = if cfg!(windows) { '/' } else { '\\' };
        assert!(!read.to_string_lossy().contains(foreign), "{read:?}");
        let source = include_str!("kanban.rs");
        assert!(source.contains("kept_as: native_path(&marker.kept_as),"));
    }

    /// R5: several cards in one write. The backup after it is the board as
    /// it was before the batch, a duplicate is skipped, and a write that
    /// fails adds no card, in memory or on disk.
    #[test]
    fn create_cards_adds_a_batch_in_one_write() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let dir = tmp.path().join(KANBAN_SUBDIR);
        let card = |id: &str| card_with_worktree(id, KanbanColumnId::Todo, "/x");
        // On a board with no file: one write, so no backup yet.
        assert_eq!(store.create_cards("ws", vec![card("a"), card("b"), card("a")]), Ok(2));
        assert!(!dir.join("ws.json.bak").exists(), "one write: nothing was rolled");
        let before = fs::read(dir.join("ws.json")).unwrap();
        assert_eq!(store.create_cards("ws", vec![card("c"), card("b"), card("d"), card("e")]), Ok(3));
        assert_eq!(fs::read(dir.join("ws.json.bak")).unwrap(), before, "one write: the backup is the board before the batch");
        assert_eq!(ids_of(&store.load("ws").unwrap()), ["a", "b", "c", "d", "e"]);
        // Nothing new: nothing written.
        assert_eq!(store.create_cards("ws", vec![card("a")]), Ok(0));
        assert_eq!(store.create_cards("ws", Vec::new()), Ok(0));
        assert_eq!(fs::read(dir.join("ws.json.bak")).unwrap(), before);
        // A write that fails adds none.
        let blocker = dir.join(format!("ws.json{}", crate::atomic::TEMP_SUFFIX));
        fs::create_dir(&blocker).unwrap();
        assert!(store.create_cards("ws", vec![card("f"), card("g")]).is_err());
        fs::remove_dir(&blocker).unwrap();
        assert_eq!(ids_of(&store.load("ws").unwrap()), ["a", "b", "c", "d", "e"]);
        let again = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(ids_of(&again.load("ws").unwrap()), ["a", "b", "c", "d", "e"]);
    }

    /// OP-2: the rolling backup never trades a backup that holds cards for a
    /// current file that is empty or isn't a board; any other file rolls.
    #[test]
    fn a_save_never_rolls_an_empty_or_broken_file_over_a_backup_with_cards() {
        let tmp = tempdir().unwrap();
        let dir = saved_board_with_backup(tmp.path(), &["a", "b"]);
        let (path, bak) = (dir.join("ws.json"), dir.join("ws.json.bak"));
        let backup = fs::read(&bak).unwrap();
        let cards = vec![card_with_worktree("new", KanbanColumnId::Todo, "/x")];
        for bad in [&b""[..], &b"{\"version\":8,\"cards\":[{\"id\""[..], &b"[]"[..]] {
            fs::write(&path, bad).unwrap();
            write_board(&path, &cards).unwrap();
            assert_eq!(fs::read(&bak).unwrap(), backup, "{:?} never replaces the backup", String::from_utf8_lossy(bad));
            assert_eq!(board_card_count_at(&path), Some(1), "the save itself lands");
        }
        // A board rolls as it always did, also an empty one.
        let saved = fs::read(&path).unwrap();
        write_board(&path, &[]).unwrap();
        assert_eq!(fs::read(&bak).unwrap(), saved);
        let empty_board = fs::read(&path).unwrap();
        write_board(&path, &cards).unwrap();
        assert_eq!(fs::read(&bak).unwrap(), empty_board, "a board without cards is still a board");
        // A backup that holds no cards is not worth keeping over anything.
        fs::write(&path, b"").unwrap();
        write_board(&path, &cards).unwrap();
        assert_eq!(fs::read(&bak).unwrap(), b"", "nothing to protect");
    }

    #[test]
    fn a_newer_board_is_warned_about_once_per_file_version() {
        let tmp = tempdir().unwrap();
        let file = tmp.path().join("ws-warn-once.json");
        fs::write(&file, "{}").unwrap();
        assert!(first_newer_warning("ws-warn-once", &file));
        assert!(!first_newer_warning("ws-warn-once", &file), "the repeat is debug");
        assert!(first_newer_warning("ws-warn-other", &file), "per workspace");
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
        fs::File::options().write(true).open(&file).unwrap().set_modified(later).unwrap();
        assert!(first_newer_warning("ws-warn-once", &file), "a changed file is said again");
    }

    /// C17: a newer Plyloft's board is refused by `load()` (the board's
    /// toast) and by every write, in the same words, and never written over
    /// or moved — also when its cards don't parse here (an unknown value).
    #[test]
    fn a_newer_plyloft_s_board_is_never_written_over() {
        let next = KANBAN_SCHEMA_VERSION + 1;
        let refusal = crate::atomic::newer_refusal("This board", next, KANBAN_SCHEMA_VERSION);
        let parses = format!(r#"{{"version":{next},"cards":[],"later":true}}"#);
        let strict = format!(r#"{{"version":{next},"cards":[{{"id":"c1","columnId":"somewhereNew"}}]}}"#);
        for newer in [parses, strict] {
            let tmp = tempdir().unwrap();
            let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
            let file = tmp.path().join(KANBAN_SUBDIR).join("ws.json");
            fs::write(&file, &newer).unwrap();
            // A write with nothing loaded yet, then a load, then a write.
            let card = || card_with_worktree("new", KanbanColumnId::Todo, "/x");
            assert_eq!(store.create_card("ws", card()).expect_err("write refused"), refusal, "{newer}");
            assert_eq!(store.load("ws").expect_err("load refused"), refusal, "{newer}");
            assert_eq!(store.create_card("ws", card()).expect_err("write refused"), refusal, "{newer}");
            assert_eq!(fs::read_to_string(&file).unwrap(), newer, "byte-identical");
            assert_eq!(store.take_notice("ws"), None, "never set aside");
            assert_eq!(fs::read_dir(file.parent().unwrap()).unwrap().count(), 1, "nothing beside it");
        }
    }

    #[test]
    #[cfg(unix)]
    fn an_unreadable_board_that_cannot_be_set_aside_fails_the_load() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let dir = tmp.path().join(KANBAN_SUBDIR);
        fs::write(dir.join("ws.json"), b"not json").unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        let loaded = store.load("ws");
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        let error = loaded.expect_err("no empty board over a file it could not move");
        assert!(error.contains("couldn't be set aside"), "{error}");
        assert_eq!(fs::read(dir.join("ws.json")).unwrap(), b"not json");
    }

    #[test]
    fn clear_worktree_handle_keeps_column_and_archived_in_every_column() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        for (id, column) in [
            ("todo", KanbanColumnId::Todo),
            ("doing", KanbanColumnId::InProgress),
            ("done", KanbanColumnId::Complete),
        ] {
            store
                .create_card("ws", card_with_worktree(id, column.clone(), "/gone"))
                .unwrap();
            let cleared = store.clear_worktree_handle("ws", id).unwrap();
            assert_eq!(cleared.worktree_path, None);
            assert_eq!(cleared.branch_name, None);
            assert_eq!(cleared.worktree_base, None);
            assert_eq!(cleared.column_id, column);
            assert!(!cleared.archived, "{id} must not be archived");
            assert_eq!(cleared.review_status, None);
        }
    }

    #[test]
    fn clear_dangling_worktree_handle_only_clears_a_still_missing_path() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().join("state")).unwrap();
        let missing = tmp.path().join("missing").to_string_lossy().to_string();
        let present = tmp.path().to_string_lossy().to_string();
        store
            .create_card("ws", card_with_worktree("a", KanbanColumnId::InProgress, &missing))
            .unwrap();
        store
            .create_card("ws", card_with_worktree("b", KanbanColumnId::InProgress, &present))
            .unwrap();

        // The card moved on to another path meanwhile: untouched.
        assert!(!store.clear_dangling_worktree_handle("ws", "a", Some("/elsewhere")).unwrap());
        // The directory exists: untouched.
        assert!(!store.clear_dangling_worktree_handle("ws", "b", Some(&present)).unwrap());
        assert!(store.get_card("ws", "b").unwrap().worktree_path.is_some());

        assert!(store.clear_dangling_worktree_handle("ws", "a", Some(&missing)).unwrap());
        let a = store.get_card("ws", "a").unwrap();
        assert_eq!((a.worktree_path, a.branch_name, a.worktree_base), (None, None, None));
        assert_eq!(a.column_id, KanbanColumnId::InProgress);
        assert!(!a.archived);
    }

    // ── v1.33.0: granular card commands (whole-board data-loss fix) ──

    #[test]
    fn card_patch_updates_only_supplied_fields() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store
            .create_card(
                "ws",
                KanbanCard::new(
                    "c1".into(),
                    "ws".into(),
                    "original".into(),
                    Some("keep-notes".into()),
                    KanbanColumnId::Todo,
                ),
            )
            .unwrap();
        let updated = store
            .patch_card(
                "ws",
                "c1",
                CardPatch {
                    title: Some("renamed".into()),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        assert_eq!(updated.title, "renamed");
        // an absent patch field leaves the card's value alone
        assert_eq!(updated.notes.as_deref(), Some("keep-notes"));
        assert_eq!(updated.column_id, KanbanColumnId::Todo);
    }

    #[test]
    fn adopt_gh_remainder_moves_issue_text_below_notes() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store
            .create_card(
                "ws",
                KanbanCard::new(
                    "c1".into(),
                    "ws".into(),
                    "T".into(),
                    Some("mine".into()),
                    KanbanColumnId::Todo,
                ),
            )
            .unwrap();
        // No remainder → refused, card untouched.
        assert!(store.adopt_gh_remainder("ws", "c1", None).is_err());
        store
            .set_github_sync("ws", "c1", Some(Some(7)), None, Some(Some("theirs".into())))
            .unwrap();
        let updated = store
            .adopt_gh_remainder("ws", "c1", Some("me@example.com".into()))
            .unwrap();
        assert_eq!(updated.notes.as_deref(), Some("mine\n\ntheirs"));
        assert_eq!(updated.gh_raw_remainder, None);
        assert_eq!(updated.last_edited_by.as_deref(), Some("me@example.com"));
        let persisted = store.get_card("ws", "c1").unwrap();
        assert_eq!(persisted.notes.as_deref(), Some("mine\n\ntheirs"));
        assert_eq!(persisted.gh_raw_remainder, None);
    }

    #[test]
    fn card_patch_clear_vs_untouched_via_json() {
        // The double_option contract: an absent JSON key means "leave the
        // field alone"; a key present with `null` means "clear it".
        let absent: CardPatch = serde_json::from_str("{}").unwrap();
        assert!(absent.notes.is_none(), "absent key -> None (untouched)");
        let cleared: CardPatch = serde_json::from_str(r#"{"notes":null}"#).unwrap();
        assert_eq!(cleared.notes, Some(None), "explicit null -> clear");
        let set: CardPatch = serde_json::from_str(r#"{"notes":"hi"}"#).unwrap();
        assert_eq!(set.notes, Some(Some("hi".into())), "value -> set");
    }

    #[test]
    fn card_patch_clears_notes_only_when_explicitly_null() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store
            .create_card(
                "ws",
                KanbanCard::new(
                    "c1".into(),
                    "ws".into(),
                    "t".into(),
                    Some("notes-v1".into()),
                    KanbanColumnId::Todo,
                ),
            )
            .unwrap();
        // present null -> cleared
        let cleared = store
            .patch_card("ws", "c1", serde_json::from_str(r#"{"notes":null}"#).unwrap(), None)
            .unwrap();
        assert_eq!(cleared.notes, None);
        // re-set, then a patch with no `notes` key leaves it untouched
        store
            .patch_card("ws", "c1", serde_json::from_str(r#"{"notes":"notes-v2"}"#).unwrap(), None)
            .unwrap();
        let after = store
            .patch_card("ws", "c1", serde_json::from_str(r#"{"title":"x"}"#).unwrap(), None)
            .unwrap();
        assert_eq!(after.notes.as_deref(), Some("notes-v2"));
    }

    /// 1.168.1 (A4): the deleted-card history file. A config written before
    /// it (no `kanban/deleted-cards/`) reads as none and the first delete
    /// creates it; a record from this version loads back; a file that can't
    /// be read, or comes from a newer Plyloft, is never written over.
    #[test]
    fn deleted_card_history_is_backward_compatible_and_never_overwrites_what_it_cannot_read() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        // A pre-1.168.1 board, as on disk: no deleted-cards directory.
        let now = now_ms();
        let old_at = now - DELETED_CARD_KEEP_MS - 1;
        let board = format!(
            r#"{{"version":8,"cards":[{{"id":"c1","workspaceId":"ws","title":"Old card","notes":"brief",
            "columnId":"in_progress","createdAt":1,"updatedAt":2,
            "builder":{{"vendor":"claude","startedAt":5,"ptyId":"p","model":"opus",
                "claudeSessionId":"sess-1","correctionTexts":["no, the other one"],
                "snapshots":[{{"n":1,"sha":"a","at":{old_at}}},{{"n":2,"sha":"b","at":{now}}}]}},
            "verifyHistory":[
                {{"verifyRunId":"v0","status":"failed","endedAt":{old_at},"steps":[]}},
                {{"verifyRunId":"v1","status":"failed","endedAt":{now},"summary":"tests failed","treeSha":"t",
                  "steps":[{{"kind":"shell","passed":false,"elapsedMs":3,"reason":"secret output"}}]}}],
            "shipHistory":[{{"commitSha":"s0","shippedVersion":"1.0.0","releaseKind":"local","shippedAt":{old_at}}}]}}]}}"#
        );
        let dir = tmp.path().join(KANBAN_SUBDIR);
        fs::write(dir.join("ws.json"), board).unwrap();
        assert!(!tmp.path().join(DELETED_CARDS_SUBDIR).exists());
        assert!(store.deleted_cards("ws").is_empty());

        store.delete_card("ws", "c1").unwrap();
        let kept = store.deleted_cards("ws");
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].title, "Old card");
        assert_eq!(kept[0].notes, None, "only what History reads is kept");
        let b = kept[0].builder.as_ref().unwrap();
        // Its rounds inside the window, none of the Builder's internals.
        assert_eq!((b.pty_id.as_deref(), b.snapshots.iter().map(|s| s.n).collect::<Vec<_>>()), (None, vec![2]));
        assert_eq!((b.vendor.as_str(), b.started_at), ("claude", 5));
        assert_eq!((b.model.as_deref(), b.claude_session_id.as_deref()), (None, None));
        assert!(b.correction_texts.is_empty());
        // Its checks inside the window, without a step's output.
        let v = &kept[0].verify_history;
        assert_eq!(v.iter().map(|e| e.verify_run_id.as_str()).collect::<Vec<_>>(), ["v1"]);
        assert_eq!((v[0].summary.as_deref(), v[0].tree_sha.as_deref()), (Some("tests failed"), None));
        assert_eq!((v[0].steps.len(), v[0].steps[0].reason.as_deref()), (1, None));
        assert!(kept[0].ship_history.is_empty(), "a ship before the window is not kept");
        assert_eq!((kept[0].created_at, kept[0].updated_at), (1, 2));
        // The file as this version writes it, read back by a fresh store.
        let path = tmp.path().join(DELETED_CARDS_SUBDIR).join("ws.json");
        let written: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["version"], DELETED_CARDS_VERSION);
        assert!(written["cards"][0]["deletedAt"].as_i64().unwrap() > 0);
        let again = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(again.deleted_cards("ws")[0].id, "c1");

        // Unreadable, or newer: left as it is, and reads as none.
        for odd in ["not json", r#"{"version":99,"cards":[]}"#] {
            fs::write(&path, odd).unwrap();
            store.create_card("ws", KanbanCard::new("c2".into(), "ws".into(), "t".into(), None, KanbanColumnId::Todo)).unwrap();
            store.delete_card("ws", "c2").unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), odd);
            assert!(store.deleted_cards("ws").is_empty());
        }
    }

    /// 1.168.1 (A4): History's window and the cap bound the file.
    #[test]
    fn deleted_card_history_drops_cards_past_the_window() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let card = |id: &str| KanbanCard::new(id.into(), "ws".into(), id.into(), None, KanbanColumnId::Todo);
        let now = now_ms();
        store.keep_deleted_history("ws", card("old"), now - DELETED_CARD_KEEP_MS - 1);
        store.keep_deleted_history("ws", card("recent"), now - 1_000);
        store.keep_deleted_history("ws", card("recent"), now - 500);
        store.keep_deleted_history("ws", card("new"), now);
        let ids: Vec<String> = store.deleted_cards("ws").into_iter().map(|c| c.id).collect();
        assert_eq!(ids, ["new", "recent"]);
    }

    /// v1.154.1 (M5): the swarm follow-up's reset keeps an open pull request.
    #[test]
    fn a_follow_up_reset_keeps_the_open_pull_request() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut card = KanbanCard::new("c1".into(), "ws".into(), "t".into(), None, KanbanColumnId::InProgress);
        card.review_status = Some(ReviewStatus::ChangesRequested);
        card.pr_url = Some("https://github.com/o/r/pull/11".into());
        card.pr = Some(crate::pr_status::PrStatus::opened(11, 1));
        let mut plain = card.clone();
        plain.id = "c2".into();
        plain.pr_url = None;
        plain.pr = None;
        store.save("ws", vec![card, plain]).unwrap();
        assert!(store.clear_review_after_followup("ws", "c1").unwrap());
        assert!(store.clear_review_after_followup("ws", "c2").unwrap());
        assert_eq!(store.get_card("ws", "c1").unwrap().review_status, Some(ReviewStatus::Merged));
        assert_eq!(store.get_card("ws", "c2").unwrap().review_status, Some(ReviewStatus::Pending));
    }

    #[test]
    fn card_patch_preserves_backend_owned_fields() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store
            .create_card(
                "ws",
                KanbanCard::new(
                    "c1".into(),
                    "ws".into(),
                    "t".into(),
                    None,
                    KanbanColumnId::InProgress,
                ),
            )
            .unwrap();
        // backend writers stamp run_history + review_status
        store.append_run_history("ws", "c1", sample_entry("r1")).unwrap();
        store
            .set_card_review("ws", "c1", Some(ReviewStatus::Pending), None)
            .unwrap();
        // a user title patch must not disturb either
        let updated = store
            .patch_card(
                "ws",
                "c1",
                CardPatch {
                    title: Some("renamed".into()),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        assert_eq!(updated.title, "renamed");
        assert_eq!(updated.run_history.len(), 1);
        assert_eq!(updated.review_status, Some(ReviewStatus::Pending));
    }

    /// Regression for the v1.32.x data-loss bug: a card mutation can never
    /// drop another card or its backend-owned state. The old whole-board
    /// `kanban_save` overwrote the file from a frontend snapshot; the
    /// granular commands materialize from the live cache instead.
    #[test]
    fn concurrent_stale_board_cannot_drop_a_card() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store
            .create_card(
                "ws",
                KanbanCard::new("A".into(), "ws".into(), "a".into(), None, KanbanColumnId::Todo),
            )
            .unwrap();
        // a backend writer appends run history to A
        store.append_run_history("ws", "A", sample_entry("run-1")).unwrap();
        // a second card is created afterwards — under the old whole-board
        // save, a stale snapshot taken before A's append would have lost
        // both A's history and (if the snapshot predated A) A itself
        store
            .create_card(
                "ws",
                KanbanCard::new("B".into(), "ws".into(), "b".into(), None, KanbanColumnId::Todo),
            )
            .unwrap();
        // re-read from disk through a fresh, cache-less store
        let cards = KanbanStore::new(tmp.path().to_path_buf())
            .unwrap()
            .load("ws")
            .unwrap();
        assert_eq!(cards.len(), 2, "both cards survive");
        let a = cards.iter().find(|c| c.id == "A").expect("A present");
        assert_eq!(a.run_history.len(), 1, "A keeps its run_history");
        assert!(cards.iter().any(|c| c.id == "B"), "B present");
        // deleting B leaves A and its history intact
        store.delete_card("ws", "B").unwrap();
        let after = KanbanStore::new(tmp.path().to_path_buf())
            .unwrap()
            .load("ws")
            .unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].id, "A");
        assert_eq!(after[0].run_history.len(), 1);
    }

    #[test]
    fn create_card_rejects_duplicate_id() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store
            .create_card(
                "ws",
                KanbanCard::new(
                    "dup".into(),
                    "ws".into(),
                    "first".into(),
                    None,
                    KanbanColumnId::Todo,
                ),
            )
            .unwrap();
        let err = store
            .create_card(
                "ws",
                KanbanCard::new(
                    "dup".into(),
                    "ws".into(),
                    "second".into(),
                    None,
                    KanbanColumnId::Todo,
                ),
            )
            .unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
        let cards = store.load("ws").unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].title, "first");
    }

    #[test]
    fn delete_card_missing_is_ok() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        assert!(store.delete_card("ws", "ghost").is_ok());
    }

    #[test]
    fn set_run_state_sets_link_fields_only() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store
            .create_card(
                "ws",
                KanbanCard::new(
                    "c1".into(),
                    "ws".into(),
                    "keep-title".into(),
                    None,
                    KanbanColumnId::Todo,
                ),
            )
            .unwrap();
        let updated = store
            .set_run_state(
                "ws",
                "c1",
                RunStatePatch {
                    linked_swarm_id: Some(Some("swarm-9".into())),
                    last_run_status: Some(Some(LastRunStatus::Running)),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.linked_swarm_id.as_deref(), Some("swarm-9"));
        assert_eq!(updated.last_run_status, Some(LastRunStatus::Running));
        // untouched fields stay put
        assert_eq!(updated.title, "keep-title");
        assert_eq!(updated.column_id, KanbanColumnId::Todo);
    }

    #[test]
    fn patch_card_missing_card_errors() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let err = store
            .patch_card("ws", "ghost", CardPatch::default(), None)
            .unwrap_err();
        assert!(err.contains("not found"), "got: {err}");
    }

    // ── G4 (launch D8): no new swarm starts ──────────────────────

    #[test]
    fn swarm_start_is_refused_unless_the_card_already_ran_a_swarm() {
        let mut card = sample_card("ws", KanbanColumnId::Todo);
        card.swarm_template_id = Some("feature".into());
        assert_eq!(swarm_start_refusal(true, Some(&card)), Some(NEW_CARD_SWARM_REFUSAL));
        assert_eq!(swarm_start_refusal(true, None), Some(NEW_CARD_SWARM_REFUSAL));
        assert_eq!(swarm_start_refusal(false, None), Some(NEW_SWARM_REFUSAL), "brainstorm / adhoc");
        assert_eq!(swarm_start_refusal(false, Some(&card)), Some(NEW_SWARM_REFUSAL));
        card.linked_swarm_id = Some("swarm-1".into());
        assert_eq!(swarm_start_refusal(true, Some(&card)), None, "a card that ran one finishes as before");
        assert!(NEW_CARD_SWARM_REFUSAL.contains("Builder"));
    }

    #[test]
    fn an_unstarted_template_is_dropped_on_start_and_a_queued_card_still_waits() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut fresh = sample_card("ws", KanbanColumnId::Todo);
        fresh.id = "fresh".into();
        fresh.swarm_template_id = Some("feature".into());
        assert!(!swarm_template_in_use(&fresh));
        let mut ran = fresh.clone();
        ran.id = "ran".into();
        ran.linked_swarm_id = Some("swarm-1".into());
        assert!(swarm_template_in_use(&ran));
        let mut queued = sample_card("ws", KanbanColumnId::InProgress);
        queued.id = "queued".into();
        queued.swarm_template_id = Some("feature".into());
        assert!(swarm_template_in_use(&queued));
        let mut dragged = fresh.clone();
        dragged.id = "dragged".into();
        store
            .save("ws", vec![fresh, ran, queued, dragged])
            .unwrap();

        // Start (Builder or the board): the template that never ran stays behind.
        let started = store
            .advance_to_in_progress("ws", "fresh", "/w/fresh".into(), "atelier/fresh".into(), None)
            .unwrap();
        assert_eq!(started.swarm_template_id, None);
        assert!(!card_is_queue_eligible(&started), "the pump starts no new swarm for it");

        // A card that ran a swarm keeps its template and may run it again.
        let again = store
            .advance_to_in_progress("ws", "ran", "/w/ran".into(), "atelier/ran".into(), None)
            .unwrap();
        assert_eq!(again.swarm_template_id.as_deref(), Some("feature"));

        // A card queued before the swarm UI went still waits for the pump.
        let queued = store.get_card("ws", "queued").unwrap();
        assert!(card_is_queue_eligible(&queued));
        let renamed = store
            .patch_card("ws", "queued", CardPatch { title: Some("t2".into()), ..Default::default() }, None)
            .unwrap();
        assert!(card_is_queue_eligible(&renamed), "an edit leaves the queue alone");

        // The fallback move (a column patch) drops it the same way.
        let moved = store
            .patch_card(
                "ws",
                "dragged",
                CardPatch { column_id: Some(KanbanColumnId::InProgress), ..Default::default() },
                None,
            )
            .unwrap();
        assert_eq!(moved.swarm_template_id, None);
        assert!(!card_is_queue_eligible(&moved));
    }

    #[test]
    fn no_card_is_given_a_new_swarm_template() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut card = sample_card("ws", KanbanColumnId::Todo);
        card.id = "c".into();
        store.save("ws", vec![card]).unwrap();
        let attach = |id: &str| CardPatch {
            swarm_template_id: Some(Some(id.into())),
            ..Default::default()
        };
        assert_eq!(
            store.patch_card("ws", "c", attach("feature"), None).unwrap_err(),
            SWARM_TEMPLATE_REFUSAL
        );
        assert_eq!(store.get_card("ws", "c").unwrap().swarm_template_id, None);
        // Clearing one is always allowed.
        let clear = CardPatch { swarm_template_id: Some(None), ..Default::default() };
        assert!(store.patch_card("ws", "c", clear, None).is_ok());
    }

    // ── v1.30.0 parallel swarms: queue helpers ───────────────────

    #[test]
    fn queue_eligible_requires_in_progress_template_and_no_live_swarm() {
        let mut card = sample_card("ws", KanbanColumnId::InProgress);
        card.swarm_template_id = Some("feature".into());
        assert!(
            card_is_queue_eligible(&card),
            "in-progress + template + no swarm should be eligible"
        );

        let mut todo = card.clone();
        todo.column_id = KanbanColumnId::Todo;
        assert!(!card_is_queue_eligible(&todo), "Todo card is not queued");

        let mut no_tmpl = card.clone();
        no_tmpl.swarm_template_id = None;
        assert!(
            !card_is_queue_eligible(&no_tmpl),
            "card without a swarm template is not queued"
        );

        let mut linked = card.clone();
        linked.linked_swarm_id = Some("swarm-1".into());
        assert!(
            !card_is_queue_eligible(&linked),
            "card with a live/linked swarm is not queued"
        );

        let mut failed = card.clone();
        failed.last_run_status = Some(LastRunStatus::Failed);
        assert!(
            !card_is_queue_eligible(&failed),
            "failed-dispatch card is excluded so it cannot block the queue"
        );

        let mut archived = card.clone();
        archived.archived = true;
        assert!(!card_is_queue_eligible(&archived), "archived card is not queued");
    }

    #[test]
    fn dispatch_prompt_prefers_intake_then_concats_then_attachments() {
        let mut card = sample_card("ws", KanbanColumnId::InProgress);
        card.title = "Add dark mode".into();
        card.notes = Some("respect system pref".into());
        card.knowledge = Some("see theme.ts".into());
        assert_eq!(
            card_dispatch_prompt(&card),
            "Add dark mode\n\nrespect system pref\n\nsee theme.ts",
            "no dispatch_prompt → concat title + notes + knowledge"
        );

        card.dispatch_prompt = Some("Finalized: ship dark mode".into());
        assert_eq!(
            card_dispatch_prompt(&card),
            "Finalized: ship dark mode",
            "dispatch_prompt is used verbatim, concat ignored"
        );

        card.attachments = vec![CardAttachment {
            id: "a1".into(),
            display_name: "spec.md".into(),
            stored_path: "/tmp/atelier/spec.md".into(),
            size_bytes: 10,
            mime_type: None,
            added_at: 1,
        }];
        assert_eq!(
            card_dispatch_prompt(&card),
            "Finalized: ship dark mode\n\nAttached files:\n- /tmp/atelier/spec.md",
        );

        card.dispatch_prompt = Some("   ".into());
        card.attachments = Vec::new();
        assert_eq!(
            card_dispatch_prompt(&card),
            "Add dark mode\n\nrespect system pref\n\nsee theme.ts",
            "whitespace-only dispatch_prompt falls back to the concat"
        );
    }

    // ── card_compose_dispatch_prompt (v1.36.0 / Increment 2) ─

    fn make_memory_store_with(workspace_id: &str, items: &[(&str, &str)]) -> (tempfile::TempDir, crate::memory::MemoryStore) {
        let tmp = tempdir().unwrap();
        let store = crate::memory::MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        for (title, body) in items {
            store
                .create(crate::memory::NewMemory {
                    title: (*title).into(),
                    body: (*body).into(),
                    scope: crate::memory::MemoryScope::Workspace,
                    workspace_id: Some(workspace_id.into()),
                    tags: vec![],
                    linked_cards: vec![],
                    source: crate::memory::MemorySource::Manual,
                    entry_type: crate::memory::KnowledgeType::Note,
                    system_prompt: None,
                    prompt_template: None,
                    evidence: None,
                })
                .unwrap();
        }
        (tmp, store)
    }

    #[test]
    fn compose_with_no_matching_memory_equals_card_dispatch_prompt() {
        let mut card = sample_card("ws-x", KanbanColumnId::InProgress);
        card.title = "feature q".into();
        let (_tmp, store) = make_memory_store_with("ws-x", &[]);
        let composed = card_compose_dispatch_prompt(&card, &store, false);
        assert_eq!(composed, card_dispatch_prompt(&card));
    }

    #[test]
    fn compose_prepends_memory_block_above_card_body() {
        let mut card = sample_card("ws-x", KanbanColumnId::InProgress);
        card.title = "auth refactor".into();
        card.notes = Some("touch token handler".into());
        let (_tmp, store) =
            make_memory_store_with("ws-x", &[("auth flow", "uses JWT cookies")]);
        let composed = card_compose_dispatch_prompt(&card, &store, false);
        assert!(composed.starts_with("## Relevant prior learnings\n"));
        // The card body must still be present, after the memory block.
        let body = card_dispatch_prompt(&card);
        assert!(composed.ends_with(&body));
        // Memory comes BEFORE the body.
        let mem_pos = composed.find("auth flow: uses JWT cookies").unwrap();
        let body_pos = composed.find("auth refactor").unwrap();
        assert!(mem_pos < body_pos);
    }

    #[test]
    fn compose_respects_intake_dispatch_prompt_for_body_but_still_prepends_memory() {
        let mut card = sample_card("ws-x", KanbanColumnId::InProgress);
        card.title = "auth refactor".into();
        // Intake replaced the body. Memory injection should STILL happen
        // because the search query uses title/notes/knowledge, not
        // dispatch_prompt — and the user-owned content is what indexes
        // back into memory most cleanly.
        card.dispatch_prompt = Some("Polished intake brief about auth".into());
        let (_tmp, store) =
            make_memory_store_with("ws-x", &[("auth flow", "uses JWT cookies")]);
        let composed = card_compose_dispatch_prompt(&card, &store, false);
        assert!(composed.contains("## Relevant prior learnings"));
        assert!(composed.contains("auth flow: uses JWT cookies"));
        // The intake-finalized body is preserved verbatim at the end.
        assert!(composed.ends_with("Polished intake brief about auth"));
    }

    #[test]
    fn compose_workspace_isolation_holds() {
        // A memory in ws-other must NOT inject into a card from ws-x,
        // even with the same query.
        let mut card = sample_card("ws-x", KanbanColumnId::InProgress);
        card.title = "auth refactor".into();
        let (_tmp, store) =
            make_memory_store_with("ws-other", &[("auth flow", "from other ws")]);
        let composed = card_compose_dispatch_prompt(&card, &store, false);
        assert!(!composed.contains("from other ws"));
        assert_eq!(composed, card_dispatch_prompt(&card));
    }

    #[test]
    fn compose_global_injection_is_gated_by_flag() {
        let mut card = sample_card("ws-x", KanbanColumnId::InProgress);
        card.title = "auth refactor".into();
        let tmp = tempdir().unwrap();
        let store = crate::memory::MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        store
            .create(crate::memory::NewMemory {
                title: "auth pattern".into(),
                body: "use bearer headers".into(),
                scope: crate::memory::MemoryScope::Global,
                workspace_id: None,
                tags: vec![],
                linked_cards: vec![],
                source: crate::memory::MemorySource::Manual,
                entry_type: crate::memory::KnowledgeType::Note,
                system_prompt: None,
                prompt_template: None,
                evidence: None,
            })
            .unwrap();
        // Flag off → no global injection.
        let off = card_compose_dispatch_prompt(&card, &store, false);
        assert!(!off.contains("auth pattern"));
        // Flag on → global is included.
        let on = card_compose_dispatch_prompt(&card, &store, true);
        assert!(on.contains("auth pattern: use bearer headers"));
    }

    #[test]
    fn save_and_load_round_trips() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let cards = vec![
            sample_card("ws1", KanbanColumnId::Todo),
            sample_card("ws1", KanbanColumnId::Complete),
        ];
        store.save("ws1", cards.clone()).unwrap();
        // Bypass in-memory cache by constructing a fresh store
        let store2 = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let loaded = store2.load("ws1").unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].column_id, KanbanColumnId::Todo);
    }

    #[test]
    fn missing_workspace_file_returns_empty() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let cards = store.load("nonexistent").unwrap();
        assert!(cards.is_empty());
    }

    #[test]
    fn unknown_version_is_refused_and_does_not_crash() {
        // C17 (round 1): a newer version used to open as an empty board; it
        // is refused (the board's toast) and left as it is.
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        // Write a file with version 99 directly
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-future.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, br#"{"version":99,"cards":[]}"#).unwrap();
        let error = store.load("ws-future").expect_err("refused");
        assert!(error.contains("saved by a newer Plyloft"), "{error}");
        assert_eq!(fs::read(&path).unwrap(), br#"{"version":99,"cards":[]}"#);
    }

    #[test]
    fn deserializes_with_optional_fields_missing() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-min.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        // Card without notes, agentConfigId, linkedRunId, lastRunStatus
        let json = br#"{
            "version": 1,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-min",
                "title": "minimal",
                "columnId": "todo",
                "createdAt": 1,
                "updatedAt": 1
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-min").unwrap();
        assert_eq!(cards.len(), 1);
        assert!(cards[0].notes.is_none());
        assert!(cards[0].agent_config_id.is_none());
    }

    /// v1.106.0 Tier 2 (Builder/Challenger): a pre-v1.106 card has no
    /// `builder` field and must load with `None`; a card persisted mid-
    /// session (`builder.ptyId` set) must come back with the pty cleared
    /// and `sessionLost` true, mirroring the `IntakeStatus::Active` reset.
    #[test]
    fn pre_v1_106_card_loads_with_builder_none() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-builder.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 1,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-pre-builder",
                "title": "legacy",
                "columnId": "in_progress",
                "worktreePath": "/tmp/wt",
                "branchName": "atelier/card-c1",
                "lastRunStatus": "running",
                "createdAt": 100,
                "updatedAt": 200
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-pre-builder").unwrap();
        assert_eq!(cards.len(), 1);
        assert!(cards[0].builder.is_none());
        assert_eq!(cards[0].worktree_path.as_deref(), Some("/tmp/wt"));
    }

    /// Tier 2 schema-migration (cards start from the fetched default
    /// branch): a card persisted before `worktreeBase` existed — including
    /// one with a live worktree — loads with `None` and keeps its worktree
    /// handle; a card saved with a base round-trips it unchanged.
    #[test]
    fn pre_worktree_base_card_loads_with_none_and_base_round_trips() {
        use crate::worktrees::{BaseSource, WorktreeBase};
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-base.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 8,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-pre-base",
                "title": "legacy worktree card",
                "columnId": "in_progress",
                "worktreePath": "/tmp/wt",
                "branchName": "atelier/card-c1-legacy",
                "createdAt": 100,
                "updatedAt": 200
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-pre-base").unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].worktree_base, None);
        assert_eq!(cards[0].worktree_path.as_deref(), Some("/tmp/wt"));
        assert_eq!(cards[0].branch_name.as_deref(), Some("atelier/card-c1-legacy"));

        let base = WorktreeBase {
            commit: "0123456789abcdef0123456789abcdef01234567".into(),
            ref_name: "origin/main".into(),
            source: BaseSource::Origin,
            note: None, origin_slug: None, origin_url: None, merged_target: None,
        };
        let mut card = cards[0].clone();
        card.worktree_base = Some(base.clone());
        store.save("ws-pre-base", vec![card]).unwrap();
        let on_disk = fs::read_to_string(&path).unwrap();
        assert!(on_disk.contains("\"worktreeBase\""), "{on_disk}");
        let reloaded = store.load("ws-pre-base").unwrap();
        assert_eq!(reloaded[0].worktree_base, Some(base));
    }

    #[test]
    fn pre_v1_109_card_loads_with_plan_challenge_none_and_round_trips() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-plan.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 1,
            "cards": [
              {"id": "c1", "workspaceId": "ws-plan", "title": "legacy", "columnId": "todo", "createdAt": 1, "updatedAt": 2},
              {"id": "c2", "workspaceId": "ws-plan", "title": "challenged", "columnId": "todo", "createdAt": 1, "updatedAt": 2,
               "planChallenge": {"discussionId": "d1", "challengedAt": 5, "brief": "challenged",
                                 "decisions": [{"disagreementId": "x", "statement": "s", "decision": "go with A"}]}}
            ]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-plan").unwrap();
        assert!(cards[0].plan_challenge.is_none());
        let pc = cards[1].plan_challenge.as_ref().unwrap();
        assert_eq!(pc.discussion_id, "d1");
        assert_eq!(pc.decisions[0].decision, "go with A");
        assert_eq!(card_brief_text(&cards[1]), "challenged");
    }

    #[test]
    fn builder_pty_is_cleared_and_marked_lost_on_load() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-builder.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 1,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-builder",
                "title": "live",
                "columnId": "in_progress",
                "lastRunStatus": "running",
                "builder": {
                    "vendor": "claude",
                    "bypass": true,
                    "ptyId": "pty-old",
                    "sessionLost": false,
                    "startedAt": 5,
                    "snapshots": [{"n": 1, "sha": "abc", "at": 6}]
                },
                "createdAt": 100,
                "updatedAt": 200
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-builder").unwrap();
        let b = cards[0].builder.as_ref().expect("builder survives");
        assert_eq!(b.vendor, "claude");
        assert!(b.bypass);
        assert!(b.pty_id.is_none(), "no PTY survives a restart");
        assert!(b.session_lost, "the card must offer Resume");
        assert_eq!(b.snapshots.len(), 1);
        assert_eq!(b.snapshots[0].sha, "abc");
        // The reset is persisted, so a second load (cache cleared) agrees.
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"sessionLost\": true"));
        assert!(!raw.contains("pty-old"));
    }

    /// UX P-F schema migration (Tier 2): a card and a build written before
    /// `claudeSessionId` load with none and re-save without the key; once
    /// set it round-trips on the Builder and on a build of Build with both.
    #[test]
    fn a_card_before_claude_session_ids_loads_without_them_and_round_trips_them() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pf.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 1,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-pf",
                "title": "started before P-F",
                "columnId": "in_progress",
                "builder": {"vendor": "claude", "ptyId": "pty-old", "startedAt": 3},
                "createdAt": 100,
                "updatedAt": 200
            }, {
                "id": "c2",
                "workspaceId": "ws-pf",
                "title": "built by both before P-F",
                "columnId": "in_progress",
                "buildBoth": {
                    "startedAt": 1,
                    "lanes": [
                        {"lane": "a", "vendor": "claude", "worktreePath": "/w/a", "branchName": "a", "bypass": false, "sessionLost": false, "resumeFailed": false},
                        {"lane": "b", "vendor": "codex", "worktreePath": "/w/b", "branchName": "b", "bypass": false, "sessionLost": false, "resumeFailed": false}
                    ]
                },
                "createdAt": 100,
                "updatedAt": 200
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let mut cards = store.load("ws-pf").unwrap();
        assert_eq!(cards[0].builder.as_ref().unwrap().claude_session_id, None);
        let lanes = &cards[1].build_both.as_ref().expect("the build loads").lanes;
        assert!(lanes.iter().all(|l| l.claude_session_id.is_none()));
        store.save("ws-pf", cards.clone()).unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(!written.contains("claudeSessionId"), "{written}");

        cards[0].builder.as_mut().unwrap().claude_session_id = Some("sid-builder".into());
        cards[1].build_both.as_mut().unwrap().lanes[0].claude_session_id = Some("sid-lane".into());
        store.save("ws-pf", cards).unwrap();
        let back = store.load("ws-pf").unwrap();
        assert_eq!(back[0].builder.as_ref().unwrap().claude_session_id.as_deref(), Some("sid-builder"));
        assert_eq!(back[1].build_both.as_ref().unwrap().lanes[0].claude_session_id.as_deref(), Some("sid-lane"));
    }

    /// UX P-C schema migration (PPVP Tier 2): a builder record written
    /// before `permissionMode` loads as `None` (today's permissions) and
    /// re-saves without the key; a guided session's mode round-trips, so
    /// Resume after a restart keeps it.
    #[test]
    fn a_builder_before_permission_mode_loads_without_it_and_a_guided_one_round_trips() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pc.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 1,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-pc",
                "title": "built before P-C",
                "columnId": "in_progress",
                "builder": {
                    "vendor": "claude",
                    "bypass": false,
                    "ptyId": "pty-old",
                    "sessionLost": false,
                    "startedAt": 5,
                    "snapshots": [{"n": 1, "sha": "abc", "at": 3}]
                },
                "createdAt": 100,
                "updatedAt": 200
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-pc").unwrap();
        let b = cards[0].builder.as_ref().unwrap();
        assert_eq!(b.permission_mode, None);
        assert!(!b.bypass);
        assert_eq!(b.snapshots.len(), 1);
        store.save("ws-pc", cards.clone()).unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(!written.contains("permissionMode"), "{written}");

        let mut card = cards[0].clone();
        card.builder.as_mut().unwrap().permission_mode =
            Some(crate::builder::GUIDED_PERMISSION_MODE.to_string());
        store.save("ws-pc", vec![card]).unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(written.contains(r#""permissionMode": "acceptEdits""#), "{written}");
        let back = store.load("ws-pc").unwrap();
        assert_eq!(back[0].builder.as_ref().unwrap().permission_mode.as_deref(), Some("acceptEdits"));
    }

    /// CL-5 schema migration: a card written before review rounds (a done
    /// review with no `round`, a builder with no `reviewRounds`) loads with
    /// none and re-saves without either key; once a round is recorded it
    /// round-trips.
    /// 1.173.0 A3 (walk fix), the v1.11.x template: a board written before a
    /// card could come from a copy loads with `from_copy: None` and is
    /// written back without a `fromCopy` key; one made from a copy
    /// round-trips.
    #[test]
    fn pre_a3_card_loads_without_a_copy_and_resaves_without_the_key() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-a3.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 1,
            "cards": [{
                "id": "c1", "workspaceId": "ws-a3", "title": "made in 1.172", "notes": "the brief",
                "columnId": "todo", "worktreePath": "/tmp/wt-c1", "createdAt": 100, "updatedAt": 200
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let mut cards = store.load("ws-a3").unwrap();
        assert_eq!(cards[0].from_copy, None);
        assert_eq!(cards[0].worktree_path.as_deref(), Some("/tmp/wt-c1"));
        store.save("ws-a3", cards.clone()).unwrap();
        assert!(!fs::read_to_string(&path).unwrap().contains("fromCopy"));
        cards[0].from_copy = Some(CardFromCopy { id: "copy-1a2b3c4d".into(), name: "try".into() });
        store.save("ws-a3", cards).unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(written.contains("\"fromCopy\""), "{written}");
        let back = KanbanStore::new(tmp.path().to_path_buf()).unwrap().load("ws-a3").unwrap();
        assert_eq!(back[0].from_copy.as_ref().map(|c| c.name.as_str()), Some("try"));
    }

    /// 1.173.0 (B3), the v1.11.x template: a board written before cards had
    /// an area loads with `area: None`, keeps its other fields, and is
    /// written back without an `area` key; a chosen area round-trips.
    #[test]
    fn pre_v1_173_card_loads_without_an_area_and_resaves_without_the_key() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-b3.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 1,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-b3",
                "title": "made in 1.172",
                "notes": "the brief",
                "columnId": "in_progress",
                "branchName": "plyloft/card-c1-made",
                "worktreePath": "/tmp/wt-c1",
                "ghIssueNumber": 7,
                "createdAt": 100,
                "updatedAt": 200
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-b3").unwrap();
        assert_eq!(cards[0].area, None);
        assert_eq!(cards[0].title, "made in 1.172");
        assert_eq!(cards[0].notes.as_deref(), Some("the brief"));
        assert_eq!(cards[0].branch_name.as_deref(), Some("plyloft/card-c1-made"));
        assert_eq!(cards[0].gh_issue_number, Some(7));
        store.save("ws-b3", cards.clone()).unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(!written.contains("\"area\""), "{written}");

        store.with_card("ws-b3", "c1", |c| {
            c.area = Some("site".into());
            Ok(())
        })
        .unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(written.contains("\"area\": \"site\""), "{written}");
        let fresh = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(fresh.load("ws-b3").unwrap()[0].area.as_deref(), Some("site"));
    }

    /// 1.173.0 (C1), the v1.11.x template: a GitHub board written before
    /// cards remembered their issue's area label loads with
    /// `gh_area_label: None`, keeps its other fields, and is written back
    /// without the key; a label read from the issue round-trips.
    #[test]
    fn pre_c1_card_loads_without_an_area_label_and_resaves_without_the_key() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-c1.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 1,
            "cards": [{
                "id": "gh-issue-7",
                "workspaceId": "ws-c1",
                "title": "made before C1",
                "columnId": "todo",
                "ghIssueNumber": 7,
                "ghLabelsPending": true,
                "area": "site",
                "createdAt": 100,
                "updatedAt": 200
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-c1").unwrap();
        assert_eq!(cards[0].gh_area_label, None);
        assert_eq!(cards[0].area.as_deref(), Some("site"));
        assert_eq!(cards[0].gh_issue_number, Some(7));
        assert!(cards[0].gh_labels_pending);
        store.save("ws-c1", cards).unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(!written.contains("ghAreaLabel"), "{written}");

        store
            .with_card("ws-c1", "gh-issue-7", |c| {
                c.gh_area_label = Some("area:site".into());
                Ok(())
            })
            .unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(written.contains("\"ghAreaLabel\": \"area:site\""), "{written}");
        let fresh = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(fresh.load("ws-c1").unwrap()[0].gh_area_label.as_deref(), Some("area:site"));
    }

    #[test]
    fn a_card_before_review_rounds_loads_without_them_and_resaves_without_the_key() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-cl5.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 1,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-cl5",
                "title": "reviewed before CL-5",
                "columnId": "in_progress",
                "builder": {
                    "vendor": "claude",
                    "snapshots": [{"n": 1, "sha": "abc", "at": 3}],
                    "review": {
                        "snapshotN": 1,
                        "provider": "codex",
                        "status": "done",
                        "verdict": "changes_requested",
                        "reviewId": "rev-1",
                        "at": 4
                    }
                },
                "createdAt": 100,
                "updatedAt": 200
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-cl5").unwrap();
        let b = cards[0].builder.as_ref().unwrap();
        assert!(b.review_rounds.is_empty());
        assert_eq!(b.review.as_ref().unwrap().round, None);
        store.save("ws-cl5", cards.clone()).unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(!written.contains("reviewRounds"), "{written}");
        assert!(!written.contains("\"round\""), "{written}");

        let mut card = cards[0].clone();
        let b = card.builder.as_mut().unwrap();
        let mut review = b.review.clone().unwrap();
        review.round = Some(crate::review_ledger::RoundCounts { round: 1, new: 2, new_ids: vec!["F1".into(), "F2".into()], ..Default::default() });
        b.remember_round(&review);
        store.save("ws-cl5", vec![card]).unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(written.contains("\"reviewRounds\""), "{written}");
        let value: serde_json::Value = serde_json::from_str(&written).unwrap();
        let round = &value["cards"][0]["builder"]["reviewRounds"][0];
        assert!(round.get("notes").is_none(), "a zero count of notes is left out: {round}");
        assert!(round.get("ledgerRestart").is_none() && round.get("closedIds").is_none(), "{round}");
        assert_eq!(round["stillOpen"], 0);
        assert_eq!(round["newIds"], serde_json::json!(["F1", "F2"]));
        let again = store.load("ws-cl5").unwrap();
        let rounds = &again[0].builder.as_ref().unwrap().review_rounds;
        assert_eq!(rounds.len(), 1);
        assert_eq!(
            (rounds[0].round, rounds[0].verdict.as_str(), rounds[0].new, rounds[0].provider.as_str(), rounds[0].review_id.as_str()),
            (1, "changes_requested", 2, "codex", "rev-1")
        );
    }

    /// CL-5 round 2 (F2): a card first recorded mid-way keeps the ledger's
    /// number (Activity says the earlier ones weren't recorded); a jump stays
    /// a jump; a ledger that starts over (records evicted) continues the
    /// card's numbering and is marked, so older rounds' ids aren't trusted.
    #[test]
    fn round_numbers_follow_the_card_across_a_ledger_that_starts_over() {
        let review = |id: &str, ledger_round| BuilderReview {
            status: "done".into(),
            verdict: Some("approve".into()),
            review_id: Some(id.into()),
            round: Some(crate::review_ledger::RoundCounts { round: ledger_round, ..Default::default() }),
            ..BuilderReview::default()
        };
        let mut b: BuilderState = serde_json::from_str(r#"{"vendor":"claude"}"#).unwrap();
        for (id, n) in [("a", 5), ("b", 6), ("c", 8), ("d", 1), ("e", 2)] {
            b.remember_round(&review(id, n));
        }
        let seen: Vec<_> = b.review_rounds.iter().map(|r| (r.round, r.ledger_round, r.ledger_restart)).collect();
        assert_eq!(seen, vec![(5, 5, false), (6, 6, false), (8, 8, false), (9, 1, true), (10, 2, false)]);

        // CL-5 round 3: a round stored before `ledgerRound` loads it as 0 and
        // reads as its own round — the next one follows, no jump.
        let mut old: BuilderState =
            serde_json::from_str(r#"{"vendor":"claude","reviewRounds":[{"round":3,"verdict":"approve","reviewId":"x"}]}"#).unwrap();
        assert_eq!(old.review_rounds[0].ledger_round, 0);
        old.remember_round(&review("y", 4));
        assert_eq!((old.review_rounds[1].round, old.review_rounds[1].ledger_restart), (4, false));
    }

    /// CL-5: one round per folded review — the same review settling again
    /// (a retried write, a reload, its override) adds nothing; a failed or
    /// unfolded review is not a round; the list is bounded.
    #[test]
    fn a_review_is_recorded_as_one_round_once() {
        let counts = |round| Some(crate::review_ledger::RoundCounts { round, new: 1, ..Default::default() });
        let review = |id: &str, status: &str, round| BuilderReview {
            snapshot_n: 1,
            provider: "codex".into(),
            status: status.into(),
            verdict: (status != "failed").then(|| "changes_requested".to_string()),
            review_id: Some(id.into()),
            at: 5,
            round,
            ..BuilderReview::default()
        };
        let mut b: BuilderState = serde_json::from_str(r#"{"vendor":"claude"}"#).unwrap();
        b.remember_round(&review("r1", "done", counts(1)));
        b.remember_round(&review("r1", "done", counts(1)));
        b.remember_round(&review("r1", "skipped", counts(1)));
        assert_eq!(b.review_rounds.len(), 1, "the same review is one round");
        b.remember_round(&review("r2", "failed", None));
        b.remember_round(&review("r3", "done", None));
        assert_eq!(b.review_rounds.len(), 1, "a review the ledger did not fold is no round");
        b.remember_round(&review("r4", "done", counts(2)));
        assert_eq!(b.review_rounds.iter().map(|r| r.round).collect::<Vec<_>>(), vec![1, 2]);
        for n in 3..(REVIEW_ROUNDS_MAX as u32 + 10) {
            b.remember_round(&review(&format!("x{n}"), "done", counts(n)));
        }
        assert_eq!(b.review_rounds.len(), REVIEW_ROUNDS_MAX);
        assert!(b.review_rounds[0].trimmed_before, "the cap marks where it cut");
        assert!(!b.review_rounds[1].trimmed_before);
        assert_eq!(b.review_rounds.last().unwrap().round, REVIEW_ROUNDS_MAX as u32 + 9);
    }

    /// OB-14 Tier 2: a board written before OB-14 — a same-vendor review
    /// with `degraded` and no `singleVendor`, an intake record with no
    /// `vendor` — loads with `single_vendor` false (the E2 words, as today)
    /// and `vendor` None (read as Claude), and both round-trip once set.
    #[test]
    fn pre_v153_board_loads_without_single_vendor_or_intake_vendor() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-ob14.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 1,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-ob14",
                "title": "reviewed by its own vendor",
                "columnId": "in_progress",
                "intakeHistory": [{
                    "intakeId": "int-1",
                    "startedAt": 1,
                    "concludedAt": 2,
                    "dispatchPrompt": "do it",
                    "transcriptPath": null,
                    "applied": true
                }],
                "builder": {
                    "vendor": "claude",
                    "snapshots": [{"n": 1, "sha": "abc", "at": 3}],
                    "review": {
                        "snapshotN": 1,
                        "provider": "claude",
                        "degraded": true,
                        "status": "done",
                        "verdict": "approve",
                        "at": 4
                    }
                },
                "createdAt": 100,
                "updatedAt": 200
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-ob14").unwrap();
        let review = cards[0].builder.as_ref().unwrap().review.as_ref().unwrap();
        assert!(review.degraded);
        assert!(!review.single_vendor, "an old same-vendor review keeps the E2 words");
        assert_eq!(cards[0].intake_history[0].vendor, None);

        let mut card = cards[0].clone();
        card.builder.as_mut().unwrap().review.as_mut().unwrap().single_vendor = true;
        card.intake_history[0].vendor = Some("codex".into());
        store.save("ws-ob14", vec![card]).unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(written.contains("\"singleVendor\": true"), "{written}");
        assert!(written.contains("\"vendor\": \"codex\""), "{written}");
        let again = store.load("ws-ob14").unwrap();
        assert!(again[0].builder.as_ref().unwrap().review.as_ref().unwrap().single_vendor);
        assert_eq!(again[0].intake_history[0].vendor.as_deref(), Some("codex"));
    }

    /// N14 walk F19/F20 Tier 2: a board written before the put back record
    /// and the replanned flag — a card with no `putBacks`, an intake record
    /// with no `replanned` — loads with both empty/false, saves without the
    /// keys, and round-trips them once set.
    #[test]
    fn pre_n14_f19_board_loads_without_put_backs_or_replanned() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-f19.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 8,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-f19",
                "title": "put back before F19",
                "columnId": "todo",
                "branchName": "plyloft/card-c1",
                "intakeHistory": [{
                    "intakeId": "int-1",
                    "startedAt": 1,
                    "concludedAt": 2,
                    "dispatchPrompt": null,
                    "transcriptPath": null,
                    "applied": false,
                    "vendor": "claude"
                }],
                "createdAt": 100,
                "updatedAt": 200
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-f19").unwrap();
        assert!(cards[0].put_backs.is_empty());
        assert!(!cards[0].intake_history[0].replanned);
        assert_eq!(cards[0].branch_name.as_deref(), Some("plyloft/card-c1"), "existing fields survive");
        assert_eq!(cards[0].intake_history[0].vendor.as_deref(), Some("claude"));
        store.save("ws-f19", cards.clone()).unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(!written.contains("putBacks"), "{written}");
        assert!(!written.contains("replanned"), "{written}");

        let mut card = cards[0].clone();
        card.put_backs = vec![300, 400];
        card.intake_history[0].replanned = true;
        store.save("ws-f19", vec![card]).unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(written.contains("\"putBacks\""), "{written}");
        assert!(written.contains("\"replanned\": true"), "{written}");
        let again = store.load("ws-f19").unwrap();
        assert_eq!(again[0].put_backs, vec![300, 400]);
        assert!(again[0].intake_history[0].replanned);
    }

    /// 1.172.0 (A1) Tier 2: a board written before later requests loads
    /// with none, is not rewritten, saves without the key; once added they
    /// round-trip with their words, time and source, oldest first.
    #[test]
    fn a_board_from_before_later_requests_loads_unchanged_and_round_trips_them() {
        use crate::later_requests::LaterRequestSource;
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-lr.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = format!(
            r#"{{
            "version": {KANBAN_SCHEMA_VERSION},
            "cards": [{{
                "id": "c1",
                "workspaceId": "ws-pre-lr",
                "title": "built before later requests",
                "columnId": "in_progress",
                "notes": "Add a line to README.md.",
                "createdAt": 1,
                "updatedAt": 5
            }}]
        }}"#
        );
        fs::write(&path, json.as_bytes()).unwrap();
        let cards = store.load("ws-pre-lr").unwrap();
        assert!(cards[0].later_requests.is_empty());
        assert_eq!(cards[0].notes.as_deref(), Some("Add a line to README.md."), "existing fields survive");
        assert_eq!(fs::read(&path).unwrap(), json.as_bytes(), "not rewritten");
        store.save("ws-pre-lr", cards).unwrap();
        assert!(!fs::read_to_string(&path).unwrap().contains("laterRequests"));

        let first = store.add_later_request("ws-pre-lr", "c1", "  also add a comment  ", LaterRequestSource::Chat).unwrap();
        assert_eq!(first.updated_at, 5, "history, not an edit: updated_at left alone");
        store.add_later_request("ws-pre-lr", "c1", "and the changelog", LaterRequestSource::NotRight).unwrap();
        assert!(store.add_later_request("ws-pre-lr", "c1", "  ", LaterRequestSource::Changes).is_err());
        assert!(fs::read_to_string(&path).unwrap().contains("\"laterRequests\""));
        let again = store.load("ws-pre-lr").unwrap();
        let list = &again[0].later_requests;
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].text, "also add a comment");
        assert_eq!(list[0].source, LaterRequestSource::Chat);
        assert!(list[0].at > 0 && list[0].id.starts_with("lr-"));
        assert_eq!(list[1].source, LaterRequestSource::NotRight);

        let removed = store.remove_later_request("ws-pre-lr", "c1", &list[0].id).unwrap();
        assert_eq!(removed.later_requests.len(), 1);
        assert_eq!(removed.later_requests[0].text, "and the changelog");
    }

    /// 1.172.0 (A1): a landed card's later requests stay — what it was
    /// reviewed against — and a follow-up made from it starts without them.
    #[test]
    fn a_landed_card_keeps_its_later_requests_and_a_follow_up_starts_without() {
        use crate::later_requests::LaterRequestSource;
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut shipped = KanbanCard::new("s".into(), "ws".into(), "Search".into(), Some("brief".into()), KanbanColumnId::Complete);
        shipped.ship_status = ShipStatus::Shipped;
        store.save("ws", vec![shipped]).unwrap();
        let card = store.add_later_request("ws", "s", "also sort them", LaterRequestSource::NotRight).unwrap();
        let id = card.later_requests[0].id.clone();
        assert_eq!(store.remove_later_request("ws", "s", &id).unwrap_err(), LATER_REQUESTS_DONE);
        assert_eq!(store.get_card("ws", "s").unwrap().later_requests.len(), 1);

        let fresh = KanbanCard::new("f1".into(), "ws".into(), "Follow-up: Search".into(), Some("next".into()), KanbanColumnId::Todo);
        let made = store.create_follow_up("ws", "s", fresh).unwrap();
        assert!(made.later_requests.is_empty());
        assert_eq!(store.get_card("ws", "s").unwrap().later_requests.len(), 1);
    }

    /// N19 Tier 2: a board written before follow-ups — no `followsUp`, no
    /// `followedUpBy` — loads with both empty, is not rewritten, saves
    /// without the keys, and round-trips them once set.
    #[test]
    fn a_board_from_before_follow_ups_loads_unchanged() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-fu.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = format!(
            r#"{{
            "version": {KANBAN_SCHEMA_VERSION},
            "cards": [{{
                "id": "c1",
                "workspaceId": "ws-pre-fu",
                "title": "shipped before follow-ups",
                "columnId": "complete",
                "shipStatus": "shipped",
                "branchName": "atelier/c1",
                "createdAt": 1,
                "updatedAt": 5
            }}]
        }}"#
        );
        fs::write(&path, json.as_bytes()).unwrap();
        let cards = store.load("ws-pre-fu").unwrap();
        assert!(cards[0].follows_up.is_none());
        assert!(cards[0].followed_up_by.is_empty());
        assert_eq!(cards[0].ship_status, ShipStatus::Shipped, "existing fields survive");
        assert_eq!(fs::read(&path).unwrap(), json.as_bytes(), "not rewritten");
        store.save("ws-pre-fu", cards.clone()).unwrap();
        let on_disk = fs::read_to_string(&path).unwrap();
        assert!(!on_disk.contains("followsUp") && !on_disk.contains("followedUpBy"), "{on_disk}");

        let mut card = cards[0].clone();
        let link = CardFollowLink { card_id: "c2".into(), title: "Follow-up: x".into(), at: 9 };
        card.followed_up_by = vec![link.clone()];
        card.follows_up = Some(CardFollowLink { card_id: "c0".into(), title: "Older".into(), at: 3 });
        store.save("ws-pre-fu", vec![card]).unwrap();
        let on_disk = fs::read_to_string(&path).unwrap();
        assert!(on_disk.contains("\"followedUpBy\"") && on_disk.contains("\"followsUp\""), "{on_disk}");
        let again = store.load("ws-pre-fu").unwrap();
        assert_eq!(again[0].followed_up_by, vec![link]);
        assert_eq!(again[0].follows_up.as_ref().unwrap().card_id, "c0");
    }

    /// N19: a follow-up is made and linked in one write; the shipped card
    /// keeps its ship, branch, branch cleanup record and `updated_at`; a
    /// second follow-up adds a second link; a card that has not landed (and
    /// a duplicate id) is refused with nothing written. A merged pull
    /// request counts as landed.
    #[test]
    fn create_follow_up_links_both_cards_and_leaves_the_shipped_one_alone() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut shipped = KanbanCard::new("s".into(), "ws".into(), "Search".into(), Some("brief".into()), KanbanColumnId::Complete);
        shipped.ship_status = ShipStatus::Shipped;
        shipped.branch_name = Some("atelier/card-s".into());
        shipped.branch_cleanup = Some(crate::branch_cleanup::BranchCleanup::new(
            "atelier/card-s",
            "abc",
            crate::branch_cleanup::CleanupReason::Shipped,
            7,
            None,
        ));
        let mut merged = KanbanCard::new("m".into(), "ws".into(), "Merged".into(), None, KanbanColumnId::Complete);
        merged.review_status = Some(ReviewStatus::Merged);
        let open = KanbanCard::new("o".into(), "ws".into(), "Open".into(), None, KanbanColumnId::InProgress);
        store.save("ws", vec![shipped.clone(), merged, open]).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws.json");

        let fresh = |id: &str| KanbanCard::new(id.into(), "ws".into(), "Follow-up: Search".into(), Some("next".into()), KanbanColumnId::Todo);
        let made = store.create_follow_up("ws", "s", fresh("f1")).unwrap();
        assert_eq!(made.follows_up.as_ref().unwrap().card_id, "s");
        assert_eq!(made.follows_up.as_ref().unwrap().title, "Search");
        assert!(made.branch_name.is_none());
        let after = store.get_card("ws", "s").unwrap();
        assert_eq!(after.followed_up_by.len(), 1);
        assert_eq!(after.followed_up_by[0].card_id, "f1");
        assert_eq!(after.followed_up_by[0].title, "Follow-up: Search");
        let mut unchanged = after.clone();
        unchanged.followed_up_by.clear();
        assert_eq!(serde_json::to_value(&unchanged).unwrap(), serde_json::to_value(&shipped).unwrap());

        store.create_follow_up("ws", "s", fresh("f2")).unwrap();
        let ids: Vec<_> = store.get_card("ws", "s").unwrap().followed_up_by.into_iter().map(|l| l.card_id).collect();
        assert_eq!(ids, vec!["f1", "f2"]);
        assert!(store.create_follow_up("ws", "m", fresh("f3")).is_ok(), "a merged pull request has landed");

        let before = fs::read(&path).unwrap();
        assert_eq!(store.create_follow_up("ws", "o", fresh("f4")).unwrap_err(), FOLLOW_UP_NOT_SHIPPED);
        assert!(store.create_follow_up("ws", "s", fresh("f1")).is_err(), "a duplicate id");
        assert!(store.create_follow_up("ws", "gone", fresh("f5")).is_err());
        assert_eq!(fs::read(&path).unwrap(), before, "a refusal writes nothing");

        let reloaded = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(reloaded.get_card("ws", "f1").unwrap().follows_up.unwrap().card_id, "s");
    }

    /// N19: a follow-up whose brief still opens with the bare ask may not
    /// start by any path (`start_refusal` is what the Board's move, Start
    /// build, Plan and Build with both ask); once a word follows, it may.
    #[test]
    fn a_follow_up_with_the_bare_ask_may_not_start() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut f = KanbanCard::new(
            "f".into(),
            "ws".into(),
            "Follow-up: Search".into(),
            Some("What should change now: \n\n---\nContext".into()),
            KanbanColumnId::Todo,
        );
        f.follows_up = Some(CardFollowLink { card_id: "s".into(), title: "Search".into(), at: 1 });
        let plain = KanbanCard::new("p".into(), "ws".into(), "Plain".into(), Some("What should change now:".into()), KanbanColumnId::Todo);
        store.save("ws", vec![f.clone(), plain]).unwrap();
        assert_eq!(store.start_refusal("ws", "f").unwrap().as_deref(), Some(FOLLOW_UP_ASK_EMPTY));
        assert_eq!(store.start_refusal("ws", "p").unwrap(), None, "not a follow-up");
        store
            .with_card("ws", "f", |c| {
                c.notes = Some("What should change now: add a filter\n\n---".into());
                Ok(())
            })
            .unwrap();
        assert_eq!(store.start_refusal("ws", "f").unwrap(), None);
    }

    /// 1.174.0 C4 (P17): a card made from a copy doesn't start while its
    /// brief is empty — by any path — and does once it says something.
    #[test]
    fn a_card_made_from_a_copy_waits_for_its_brief() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut c = KanbanCard::new("c".into(), "ws".into(), "Pricing".into(), Some("  \n".into()), KanbanColumnId::Todo);
        c.from_copy = Some(CardFromCopy { id: "copy-1".into(), name: "win-copy-1".into() });
        let plain = KanbanCard::new("p".into(), "ws".into(), "Plain".into(), None, KanbanColumnId::Todo);
        store.save("ws", vec![c, plain]).unwrap();
        assert_eq!(store.start_refusal("ws", "c").unwrap().as_deref(), Some(COPY_BRIEF_EMPTY));
        assert_eq!(store.start_refusal("ws", "p").unwrap(), None, "a title-only card starts on its title");
        store
            .with_card("ws", "c", |c| {
                c.notes = Some("Keep two plans".into());
                Ok(())
            })
            .unwrap();
        assert_eq!(store.start_refusal("ws", "c").unwrap(), None);
    }

    /// N19: a GitHub card whose issue is done (Complete, never shipped on
    /// this Mac) may be followed up; a local card in Complete that never
    /// shipped may not.
    #[test]
    fn follow_up_is_allowed_from_a_done_issue_a_teammate_shipped() {
        let mut card = KanbanCard::new("c".into(), "ws".into(), "t".into(), None, KanbanColumnId::Complete);
        assert!(!follow_up_allowed(&card));
        card.gh_issue_number = Some(12);
        assert!(follow_up_allowed(&card));
        card.column_id = KanbanColumnId::Todo;
        assert!(!follow_up_allowed(&card), "an open issue");
    }

    /// N19 + ADR 0006: the Ship-with-follow-up link is written both ways,
    /// once — a retry adds nothing and writes nothing.
    #[test]
    fn link_follow_up_records_both_ends_once() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let a = KanbanCard::new("a".into(), "ws".into(), "Adoption".into(), None, KanbanColumnId::InProgress);
        let f = KanbanCard::new("f".into(), "ws".into(), "Follow-up: Adoption".into(), None, KanbanColumnId::Todo);
        store.save("ws", vec![a, f]).unwrap();
        store.link_follow_up("ws", "a", "f").unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws.json");
        let once = fs::read(&path).unwrap();
        store.link_follow_up("ws", "a", "f").unwrap();
        assert_eq!(fs::read(&path).unwrap(), once, "idempotent");
        assert_eq!(store.get_card("ws", "f").unwrap().follows_up.unwrap().title, "Adoption");
        let by = store.get_card("ws", "a").unwrap().followed_up_by;
        assert_eq!(by.len(), 1);
        assert_eq!(by[0].title, "Follow-up: Adoption");
        assert!(store.link_follow_up("ws", "a", "gone").is_err());
    }

    /// Schema migration: a Builder review persisted before the pushback
    /// override (no `note`, no `overriddenBy`) loads with both None and
    /// round-trips them once set.
    #[test]
    fn builder_review_without_override_fields_loads_with_none() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-review.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 1,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-review",
                "title": "reviewed",
                "columnId": "in_progress",
                "lastRunStatus": "success",
                "reviewStatus": "changes_requested",
                "builder": {
                    "vendor": "claude",
                    "snapshots": [{"n": 5, "sha": "abc", "at": 6}],
                    "review": {
                        "snapshotN": 5,
                        "provider": "codex",
                        "status": "done",
                        "verdict": "changes_requested",
                        "reviewId": "r1",
                        "at": 7
                    }
                },
                "createdAt": 100,
                "updatedAt": 200
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let mut cards = store.load("ws-review").unwrap();
        let review = cards[0].builder.as_ref().unwrap().review.clone().unwrap();
        assert_eq!(review.verdict.as_deref(), Some("changes_requested"));
        assert!(review.note.is_none());
        assert!(review.overridden_by.is_none());
        // GH #58 fields default on a review written before passes.
        assert!(review.pass_count.is_none());
        assert!(review.file_count.is_none());
        assert!(review.incomplete_reason.is_none());
        // GH #99 fields default on a review written before retries.
        assert!(review.reviewed_revision.is_none());
        assert!(review.failure_reason.is_none());
        assert!(review.retry_at.is_none());
        assert!(!review.retried);
        assert!(review.commits_since_review.is_none());
        assert!(cards[0].builder.as_ref().unwrap().last_reviewed_revision.is_none());
        assert!(cards[0].builder.as_ref().unwrap().shipped_unreviewed.is_none());

        let r = cards[0].builder.as_mut().unwrap().review.as_mut().unwrap();
        r.note = Some("changes requested on snapshot 5, overridden by the human".into());
        r.overridden_by = Some("me@example.com".into());
        store.save("ws-review", cards).unwrap();
        let reloaded = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let cards = reloaded.load("ws-review").unwrap();
        let review = cards[0].builder.as_ref().unwrap().review.clone().unwrap();
        assert_eq!(review.overridden_by.as_deref(), Some("me@example.com"));
        assert!(review.note.unwrap().contains("overridden by the human"));

        // GH #99: a failed review's facts and the last reviewed revision
        // round-trip once set.
        let mut cards = cards;
        let b = cards[0].builder.as_mut().unwrap();
        b.last_reviewed_revision = Some("abc".into());
        b.shipped_unreviewed = Some("Last commit not reviewed by the Reviewer: x".into());
        let r = b.review.as_mut().unwrap();
        r.status = "failed".into();
        r.reviewed_revision = Some("def".into());
        r.failure_reason = Some("The Reviewer's model was at capacity.".into());
        r.retried = true;
        r.commits_since_review = Some(2);
        store.save("ws-review", cards).unwrap();
        let cards = KanbanStore::new(tmp.path().to_path_buf())
            .unwrap()
            .load("ws-review")
            .unwrap();
        let b = cards[0].builder.as_ref().unwrap();
        assert_eq!(b.last_reviewed_revision.as_deref(), Some("abc"));
        assert!(b.shipped_unreviewed.is_some());
        let review = b.review.as_ref().unwrap();
        assert_eq!(review.reviewed_revision.as_deref(), Some("def"));
        assert_eq!(review.commits_since_review, Some(2));
        assert!(review.retried);
    }

    /// Schema migration (GH #58): an incomplete review with its pass count
    /// round-trips through the board file.
    #[test]
    fn builder_review_incomplete_verdict_and_pass_count_round_trip() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-passes.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 1,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-passes",
                "title": "large",
                "columnId": "in_progress",
                "builder": {
                    "vendor": "claude",
                    "snapshots": [{"n": 2, "sha": "abc", "at": 6}],
                    "review": {
                        "snapshotN": 2,
                        "provider": "codex",
                        "status": "done",
                        "verdict": "incomplete",
                        "passCount": 4,
                        "fileCount": 29,
                        "incompleteReason": "diff too large",
                        "at": 7
                    }
                },
                "createdAt": 100,
                "updatedAt": 200
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-passes").unwrap();
        store.save("ws-passes", cards).unwrap();
        let reloaded = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let cards = reloaded.load("ws-passes").unwrap();
        let review = cards[0].builder.as_ref().unwrap().review.clone().unwrap();
        assert_eq!(review.verdict.as_deref(), Some("incomplete"));
        assert_eq!((review.pass_count, review.file_count), (Some(4), Some(29)));
        assert_eq!(review.incomplete_reason.as_deref(), Some("diff too large"));
    }

    #[test]
    fn v0_6_0_card_loads_with_knowledge_defaulted_to_none() {
        // Tier 2 schema-migration test for v0.8.0: a card serialized by
        // v0.6.0–v0.7.4 (no `knowledge` field) must round-trip cleanly with
        // `knowledge: None`. Same shape as the prior test but with an
        // intentionally complete legacy card.
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-legacy.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 1,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-legacy",
                "title": "legacy",
                "notes": "old notes",
                "columnId": "in_progress",
                "agentConfigId": "agent-1",
                "linkedRunId": "run-1",
                "lastRunStatus": "running",
                "createdAt": 100,
                "updatedAt": 200
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-legacy").unwrap();
        assert_eq!(cards.len(), 1);
        assert!(cards[0].knowledge.is_none());
        assert_eq!(cards[0].notes.as_deref(), Some("old notes"));
    }

    /// v1.49.0 Tier 2 (Team Mode Phase 0): a pre-team-mode kanban board
    /// JSON loads cleanly with `author` and `lastEditedBy` defaulting to
    /// None on every card. Established cards stay attribution-less; the UI
    /// shows "Unknown".
    #[test]
    fn legacy_kanban_loads_with_provenance_none() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-team.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 1,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-pre-team",
                "title": "legacy",
                "notes": "old notes",
                "knowledge": "context",
                "columnId": "in_progress",
                "createdAt": 100,
                "updatedAt": 200
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-pre-team").unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].author, None);
        assert_eq!(cards[0].last_edited_by, None);
        // adjacent migration-shaped fields still survive.
        assert_eq!(cards[0].notes.as_deref(), Some("old notes"));
        assert_eq!(cards[0].knowledge.as_deref(), Some("context"));
    }

    /// v1.49.0: `patch_card` with `Some(email)` rewrites `lastEditedBy`
    /// and preserves `author`. `patch_card` with `None` (system-driven
    /// bookkeeping like intake-status flips) leaves both alone.
    #[test]
    fn patch_card_stamps_last_edited_by_only_when_email_supplied() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut card = KanbanCard::new(
            "c1".into(),
            "ws".into(),
            "t".into(),
            None,
            KanbanColumnId::Todo,
        );
        card.author = Some("alice@x.com".into());
        card.last_edited_by = Some("alice@x.com".into());
        store.create_card("ws", card).unwrap();
        // User-driven patch with bob's email → lastEditedBy = bob, author = alice.
        let updated = store
            .patch_card(
                "ws",
                "c1",
                CardPatch {
                    title: Some("renamed".into()),
                    ..Default::default()
                },
                Some("bob@x.com".into()),
            )
            .unwrap();
        assert_eq!(updated.author.as_deref(), Some("alice@x.com"));
        assert_eq!(updated.last_edited_by.as_deref(), Some("bob@x.com"));
        // Internal patch with None → author + lastEditedBy unchanged.
        let after = store
            .patch_card(
                "ws",
                "c1",
                CardPatch {
                    title: Some("renamed-again".into()),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        assert_eq!(after.author.as_deref(), Some("alice@x.com"));
        assert_eq!(after.last_edited_by.as_deref(), Some("bob@x.com"));
    }

    /// Tier 2 schema-migration test for v1.0: a card serialized by v0.8.0–v0.11.0
    /// (no `swarmTemplateId` / `linkedSwarmId`) must round-trip cleanly with
    /// both fields defaulting to None.
    #[test]
    fn pre_v1_card_loads_without_swarm_fields() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-v1.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 1,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-pre-v1",
                "title": "legacy",
                "notes": "old",
                "knowledge": "context",
                "columnId": "in_progress",
                "agentConfigId": "agent-1",
                "createdAt": 100,
                "updatedAt": 200
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-pre-v1").unwrap();
        assert_eq!(cards.len(), 1);
        assert!(cards[0].swarm_template_id.is_none());
        assert!(cards[0].linked_swarm_id.is_none());
        assert_eq!(cards[0].agent_config_id.as_deref(), Some("agent-1"));
    }

    #[test]
    fn reconcile_orphan_runs_clears_linked_run_on_matching_card() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut card = sample_card("ws-recon", KanbanColumnId::InProgress);
        card.linked_run_id = Some("dead-run-1".into());
        card.last_run_status = Some(LastRunStatus::Running);
        store.save("ws-recon", vec![card]).unwrap();

        let updated = store.reconcile_orphan_runs(&["dead-run-1".into()]);
        assert_eq!(updated, 1);

        // Re-read from disk to ensure the change was persisted, not just cached.
        let store2 = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let cards = store2.load("ws-recon").unwrap();
        assert_eq!(cards.len(), 1);
        assert!(cards[0].linked_run_id.is_none());
        assert_eq!(cards[0].last_run_status, Some(LastRunStatus::Failed));
    }

    #[test]
    fn reconcile_orphan_runs_leaves_unmatched_cards_alone() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut card = sample_card("ws-keep", KanbanColumnId::InProgress);
        card.linked_run_id = Some("alive-run".into());
        card.last_run_status = Some(LastRunStatus::Running);
        store.save("ws-keep", vec![card]).unwrap();

        let updated = store.reconcile_orphan_runs(&["different-run".into()]);
        assert_eq!(updated, 0);

        let cards = store.load("ws-keep").unwrap();
        assert_eq!(cards[0].linked_run_id.as_deref(), Some("alive-run"));
        assert_eq!(cards[0].last_run_status, Some(LastRunStatus::Running));
    }

    #[test]
    fn reconcile_orphan_runs_is_noop_with_empty_set() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut card = sample_card("ws-empty", KanbanColumnId::InProgress);
        card.linked_run_id = Some("any-run".into());
        store.save("ws-empty", vec![card]).unwrap();

        assert_eq!(store.reconcile_orphan_runs(&[]), 0);
        let cards = store.load("ws-empty").unwrap();
        assert_eq!(cards[0].linked_run_id.as_deref(), Some("any-run"));
    }

    /// Tier 2 schema-migration test for v1.5.x: a card serialized before
    /// run_history / suppress_run_history were introduced must round-trip
    /// cleanly with empty/false defaults.
    #[test]
    fn pre_v1_5_card_loads_without_run_history_fields() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-v15.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 1,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-pre-v15",
                "title": "legacy",
                "notes": "old",
                "knowledge": "context",
                "columnId": "in_progress",
                "agentConfigId": "agent-1",
                "swarmTemplateId": "feature",
                "createdAt": 100,
                "updatedAt": 200
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-pre-v15").unwrap();
        assert_eq!(cards.len(), 1);
        assert!(cards[0].run_history.is_empty());
        assert!(!cards[0].suppress_run_history);
        // Pre-existing fields still load.
        assert_eq!(cards[0].swarm_template_id.as_deref(), Some("feature"));
        assert_eq!(cards[0].knowledge.as_deref(), Some("context"));
    }

    fn sample_entry(run_id: &str) -> RunHistoryEntry {
        RunHistoryEntry {
            run_id: run_id.into(),
            status: AgentStatus::Done,
            ended_at: 1_000_000,
            files_changed_count: 2,
            top_paths: vec!["src/a.rs".into(), "src/b.rs".into()],
            swarm_id: None,
            swarm_template_id: None,
            swarm_collisions: 0,
            agent_config_id: Some("agent-1".into()),
            legs: 1,
        }
    }

    #[test]
    fn append_run_history_appends_entry() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let card = sample_card("ws", KanbanColumnId::InProgress);
        let card_id = card.id.clone();
        store.save("ws", vec![card]).unwrap();
        store
            .append_run_history("ws", &card_id, sample_entry("run-1"))
            .unwrap();
        let cards = store.load("ws").unwrap();
        assert_eq!(cards[0].run_history.len(), 1);
        assert_eq!(cards[0].run_history[0].run_id, "run-1");
    }

    #[test]
    fn append_run_history_is_idempotent_on_run_id() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let card = sample_card("ws", KanbanColumnId::InProgress);
        let card_id = card.id.clone();
        store.save("ws", vec![card]).unwrap();
        store
            .append_run_history("ws", &card_id, sample_entry("run-1"))
            .unwrap();
        store
            .append_run_history("ws", &card_id, sample_entry("run-1"))
            .unwrap();
        let cards = store.load("ws").unwrap();
        assert_eq!(cards[0].run_history.len(), 1);
    }

    #[test]
    fn append_run_history_fifo_trims_to_five() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let card = sample_card("ws", KanbanColumnId::InProgress);
        let card_id = card.id.clone();
        store.save("ws", vec![card]).unwrap();
        for i in 0..7 {
            store
                .append_run_history("ws", &card_id, sample_entry(&format!("run-{i}")))
                .unwrap();
        }
        let cards = store.load("ws").unwrap();
        assert_eq!(cards[0].run_history.len(), MAX_HISTORY_ENTRIES);
        // Oldest two evicted; surviving entries are run-2 .. run-6.
        assert_eq!(cards[0].run_history.first().unwrap().run_id, "run-2");
        assert_eq!(cards[0].run_history.last().unwrap().run_id, "run-6");
    }

    #[test]
    fn append_run_history_caps_top_paths_count() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let card = sample_card("ws", KanbanColumnId::InProgress);
        let card_id = card.id.clone();
        store.save("ws", vec![card]).unwrap();
        let mut entry = sample_entry("run-1");
        entry.top_paths = (0..25).map(|i| format!("src/f{i}.rs")).collect();
        store
            .append_run_history("ws", &card_id, entry)
            .unwrap();
        let cards = store.load("ws").unwrap();
        assert_eq!(cards[0].run_history[0].top_paths.len(), MAX_TOP_PATHS);
    }

    #[test]
    fn append_run_history_middle_truncates_long_paths() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let card = sample_card("ws", KanbanColumnId::InProgress);
        let card_id = card.id.clone();
        store.save("ws", vec![card]).unwrap();
        let mut entry = sample_entry("run-1");
        let long = "a".repeat(MAX_PATH_CHARS + 50);
        entry.top_paths = vec![long];
        store
            .append_run_history("ws", &card_id, entry)
            .unwrap();
        let cards = store.load("ws").unwrap();
        let p = &cards[0].run_history[0].top_paths[0];
        assert_eq!(p.chars().count(), MAX_PATH_CHARS);
        assert!(p.contains('…'));
    }

    #[test]
    fn append_run_history_drops_top_paths_when_over_4kb() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let card = sample_card("ws", KanbanColumnId::InProgress);
        let card_id = card.id.clone();
        store.save("ws", vec![card]).unwrap();
        // 10 paths × 200 chars = 2000 of payload, plus JSON overhead, plus
        // every other field. To force the 4 KB fallback we craft an entry
        // whose paths all sit at MAX_PATH_CHARS — 10 × 200 = 2000 chars
        // alone is fine — and pad files_changed_count's neighbors via a
        // long agent_config_id. (Simpler: skip the cap check by hand here
        // and assert the post-condition on a synthesized too-large entry.)
        let mut entry = sample_entry("run-1");
        entry.agent_config_id = Some("x".repeat(8000));
        entry.top_paths = (0..MAX_TOP_PATHS)
            .map(|i| format!("path/{i}/{}", "y".repeat(MAX_PATH_CHARS - 16)))
            .collect();
        store
            .append_run_history("ws", &card_id, entry)
            .unwrap();
        let cards = store.load("ws").unwrap();
        assert!(cards[0].run_history[0].top_paths.is_empty());
        // Counts remain.
        assert_eq!(cards[0].run_history[0].files_changed_count, 2);
    }

    #[test]
    fn append_run_history_no_op_when_suppressed() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut card = sample_card("ws", KanbanColumnId::InProgress);
        card.suppress_run_history = true;
        let card_id = card.id.clone();
        store.save("ws", vec![card]).unwrap();
        store
            .append_run_history("ws", &card_id, sample_entry("run-1"))
            .unwrap();
        let cards = store.load("ws").unwrap();
        assert!(cards[0].run_history.is_empty());
    }

    #[test]
    fn append_run_history_missing_card_is_ok() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        // No cards saved yet; lookup miss must not error (best-effort path).
        store
            .append_run_history("ws", "nope", sample_entry("run-1"))
            .unwrap();
    }

    #[test]
    fn clear_run_history_empties_vec() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let card = sample_card("ws", KanbanColumnId::InProgress);
        let card_id = card.id.clone();
        store.save("ws", vec![card]).unwrap();
        store
            .append_run_history("ws", &card_id, sample_entry("run-1"))
            .unwrap();
        store.clear_run_history("ws", &card_id).unwrap();
        let cards = store.load("ws").unwrap();
        assert!(cards[0].run_history.is_empty());
    }

    /// 1.175.0 (A8, OP-9): the run-history and intake-history writers and
    /// the rewrite after a load go through `write_board`, so each leaves the
    /// board as it was before it as the rolling backup.
    #[test]
    fn the_history_writers_and_the_load_rewrite_keep_the_rolling_backup() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let file = tmp.path().join(KANBAN_SUBDIR).join("ws.json");
        let bak = backup_path(&file);
        let card = sample_card("ws", KanbanColumnId::InProgress);
        let card_id = card.id.clone();
        store.save("ws", vec![card]).unwrap();
        let backed_up = |what: &str, write: &dyn Fn()| {
            let before = fs::read(&file).unwrap();
            write();
            assert_ne!(fs::read(&file).unwrap(), before, "{what}: the board changed");
            assert_eq!(fs::read(&bak).unwrap(), before, "{what}: the backup is the board before it");
            assert!(!file.with_extension("json.tmp").exists(), "{what}: no temp file of its own");
        };
        backed_up("append_run_history", &|| {
            store.append_run_history("ws", &card_id, sample_entry("run-1")).unwrap()
        });
        backed_up("append_intake_history", &|| {
            let record = IntakeRecord {
                intake_id: "int-1".to_string(),
                started_at: 1,
                concluded_at: Some(2),
                dispatch_prompt: Some("first".to_string()),
                transcript_path: None,
                applied: true,
                vendor: None,
                replanned: false,
                two_ais: None,
            };
            store.append_intake_history("ws", &card_id, record).unwrap()
        });
        backed_up("clear_run_history", &|| store.clear_run_history("ws", &card_id).unwrap());

        // A board from an older schema is rewritten when it is first read:
        // the file as it was becomes the backup.
        let old = tmp.path().join(KANBAN_SUBDIR).join("old.json");
        let mut older: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        older["version"] = serde_json::json!(KANBAN_SCHEMA_VERSION - 1);
        let before = serde_json::to_vec_pretty(&older).unwrap();
        fs::write(&old, &before).unwrap();
        assert_eq!(store.load("old").unwrap().len(), 1);
        assert_eq!(board_card_count_at(&old), Some(1));
        assert_ne!(fs::read(&old).unwrap(), before, "rewritten at this version");
        assert_eq!(fs::read(backup_path(&old)).unwrap(), before, "the older file is the backup");
    }

    #[test]
    fn card_id_for_linked_run_finds_match() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut a = sample_card("ws", KanbanColumnId::InProgress);
        a.id = "a".into();
        a.linked_run_id = Some("run-99".into());
        let mut b = sample_card("ws", KanbanColumnId::Todo);
        b.id = "b".into();
        store.save("ws", vec![a, b]).unwrap();
        assert_eq!(
            store.card_id_for_linked_run("ws", "run-99").as_deref(),
            Some("a")
        );
        assert!(store.card_id_for_linked_run("ws", "run-999").is_none());
    }

    #[test]
    fn queued_agent_run_is_linked_only_when_it_starts() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut card = sample_card("ws", KanbanColumnId::InProgress);
        card.id = "queued-card".into();
        store.save("ws", vec![card]).unwrap();

        link_queued_agent_run(&store, "ws", "queued-card", "run-queued").unwrap();

        let saved = store.load("ws").unwrap();
        assert_eq!(saved[0].linked_run_id.as_deref(), Some("run-queued"));
        assert!(saved[0].linked_swarm_id.is_none());
        assert_eq!(saved[0].last_run_status, Some(LastRunStatus::Running));
    }

    #[test]
    fn card_id_for_linked_swarm_finds_match() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut a = sample_card("ws", KanbanColumnId::InProgress);
        a.id = "a".into();
        a.linked_swarm_id = Some("sw-1".into());
        store.save("ws", vec![a]).unwrap();
        assert_eq!(
            store.card_id_for_linked_swarm("ws", "sw-1").as_deref(),
            Some("a")
        );
    }

    #[test]
    fn middle_truncate_preserves_short_strings() {
        assert_eq!(middle_truncate("hello", 10), "hello");
    }

    #[test]
    fn middle_truncate_inserts_ellipsis() {
        let s = "a".repeat(50);
        let t = middle_truncate(&s, 10);
        assert_eq!(t.chars().count(), 10);
        assert!(t.contains('…'));
    }

    /// Tier 2 schema-migration test for v1.7.0: a card serialized before
    /// `dispatch_prompt`, `dispatch_prompt_edited_at`, and `intake_status`
    /// were introduced must round-trip cleanly with default values.
    #[test]
    fn pre_v1_7_card_loads_without_intake_fields() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-v17.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 1,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-pre-v17",
                "title": "legacy",
                "notes": "old",
                "knowledge": "context",
                "columnId": "todo",
                "swarmTemplateId": "feature",
                "createdAt": 100,
                "updatedAt": 200
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-pre-v17").unwrap();
        assert_eq!(cards.len(), 1);
        assert!(cards[0].dispatch_prompt.is_none());
        assert!(cards[0].dispatch_prompt_edited_at.is_none());
        assert_eq!(cards[0].intake_status, IntakeStatus::None);
        // Pre-existing fields still load.
        assert_eq!(cards[0].swarm_template_id.as_deref(), Some("feature"));
        assert_eq!(cards[0].knowledge.as_deref(), Some("context"));
    }

    /// v1.7.0: a card persisted with `intake_status: Active` (e.g. the app
    /// crashed during an intake conversation) must come back as `None` on
    /// the next load — the originating PTY can't be re-attached. The reset
    /// is also persisted to disk so a subsequent process sees the cleanup.
    #[test]
    fn kanban_load_resets_active_intake_to_none() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-stale.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 1,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-stale",
                "title": "had intake mid-flight",
                "columnId": "todo",
                "intakeStatus": "active",
                "createdAt": 100,
                "updatedAt": 200
            }]
        }"#;
        fs::write(&path, json).unwrap();

        let cards = store.load("ws-stale").unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].intake_status, IntakeStatus::None);

        // Reset persisted: a fresh store sees `None` without re-running
        // the cleanup (i.e. the on-disk file was rewritten).
        let store2 = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let cards2 = store2.load("ws-stale").unwrap();
        assert_eq!(cards2[0].intake_status, IntakeStatus::None);
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"intakeStatus\": \"none\""));
    }

    /// v1.7.0: a Ready intake (dispatchPrompt populated, conversation
    /// concluded) must NOT be reset on load — only the in-flight Active
    /// state is unsafe.
    #[test]
    fn kanban_load_preserves_ready_intake_status() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-ready.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 1,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-ready",
                "title": "prepared",
                "columnId": "todo",
                "intakeStatus": "ready",
                "dispatchPrompt": "Build X with constraint Y",
                "createdAt": 100,
                "updatedAt": 200
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-ready").unwrap();
        assert_eq!(cards[0].intake_status, IntakeStatus::Ready);
        assert_eq!(
            cards[0].dispatch_prompt.as_deref(),
            Some("Build X with constraint Y")
        );
    }

    /// Tier 2 schema-migration test for v1.8.0: a card serialized before the
    /// `archived` field was introduced must round-trip cleanly with
    /// `archived: false`. Schema version stays at 1; `#[serde(default)]`
    /// is the migration path (same pattern as `knowledge`,
    /// `swarm_template_id`, `run_history`, `intake_status`).
    #[test]
    fn pre_archive_card_loads_with_archived_defaulted_to_false() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-archive.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 1,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-pre-archive",
                "title": "legacy complete card",
                "notes": "shipped",
                "knowledge": "context",
                "columnId": "complete",
                "swarmTemplateId": "feature",
                "createdAt": 100,
                "updatedAt": 200
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-pre-archive").unwrap();
        assert_eq!(cards.len(), 1);
        assert!(!cards[0].archived);
        // Pre-existing fields still load.
        assert_eq!(cards[0].column_id, KanbanColumnId::Complete);
        assert_eq!(cards[0].swarm_template_id.as_deref(), Some("feature"));
    }

    /// N14 walk F11: archiving clears the worktree and leaves the review
    /// status as it was — an unshipped card archived is not landed.
    #[test]
    fn archive_card_keeps_review_status() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut seed = sample_card("ws-arch", KanbanColumnId::InProgress);
        seed.worktree_path = Some("/tmp/wt".into());
        seed.branch_name = Some("atelier/c".into());
        seed.review_status = Some(ReviewStatus::Pending);
        let mut never_reviewed = sample_card("ws-arch", KanbanColumnId::InProgress);
        never_reviewed.id = "card_2".into();
        never_reviewed.review_status = None;
        let mut pr_open = sample_card("ws-arch", KanbanColumnId::Complete);
        pr_open.id = "card_3".into();
        pr_open.review_status = Some(ReviewStatus::Merged);
        pr_open.pr_url = Some("https://github.com/o/r/pull/7".into());
        store.save("ws-arch", vec![seed, never_reviewed, pr_open]).unwrap();

        for id in ["card_1", "card_2", "card_3"] {
            store.archive_card("ws-arch", id, false).unwrap();
        }

        let cards = store.load("ws-arch").unwrap();
        assert_eq!(cards.len(), 3);
        assert!(cards.iter().all(|c| c.archived));
        assert!(cards[0].worktree_path.is_none());
        assert!(cards[0].branch_name.is_none());
        assert_eq!(cards[0].review_status, Some(ReviewStatus::Pending));
        assert_eq!(cards[1].review_status, None);
        assert!(!card_landed(&cards[0]));
        assert!(!card_landed(&cards[1]));
        // A pull request's own `merged` mark stays.
        assert_eq!(cards[2].review_status, Some(ReviewStatus::Merged));
        assert!(card_landed(&cards[2]));
    }

    /// 1.174.0 A2 (P7): sent is not landed — held to the same fixtures as
    /// `cardLifecycle.ts::cardDelivery` (`src/lib/cardDelivery.fixtures.json`).
    /// A landed card is done: Follow up, and its waiting cards start; a sent
    /// one is neither, yet reads as shipped.
    #[test]
    fn card_delivery_matches_the_shared_fixtures() {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Case {
            name: String,
            card: serde_json::Value,
            delivery: String,
            shipped_or_pr_open: bool,
            follow_up: Option<bool>,
        }
        #[derive(serde::Deserialize)]
        struct Fixtures {
            cases: Vec<Case>,
        }
        let fixtures: Fixtures = serde_json::from_str(include_str!("../../src/lib/cardDelivery.fixtures.json")).unwrap();
        assert!(fixtures.cases.len() >= 15);
        for c in fixtures.cases {
            let mut value = serde_json::to_value(sample_card("ws", KanbanColumnId::Complete)).unwrap();
            for (k, v) in c.card.as_object().unwrap() {
                value[k] = v.clone();
            }
            let card: KanbanCard = serde_json::from_value(value).unwrap_or_else(|e| panic!("{}: {e}", c.name));
            let want = match c.delivery.as_str() {
                "not-sent" => CardDelivery::NotSent,
                "sent" => CardDelivery::Sent,
                "landed" => CardDelivery::Landed,
                other => panic!("{}: delivery {other}", c.name),
            };
            assert_eq!(card_delivery(&card), want, "{}", c.name);
            assert_eq!(card_landed(&card), want == CardDelivery::Landed, "{}: landed", c.name);
            assert_eq!(follow_up_allowed(&card), c.follow_up.unwrap_or(want == CardDelivery::Landed), "{}: Follow up", c.name);
            assert_eq!(card_shipped_or_pr_open(&card), c.shipped_or_pr_open, "{}: shipped or open", c.name);
            // A card waiting for it starts only once it landed.
            let mut waiting = sample_card("ws", KanbanColumnId::Todo);
            waiting.blocked_by = vec![card.id.clone()];
            let board = [card.clone()];
            assert_eq!(unshipped_blockers(&board, &waiting).is_empty(), want == CardDelivery::Landed, "{}: blocks", c.name);
        }
    }

    /// 1.174.0 A2 round 1: a held start names a blocker in an open pull
    /// request by its merge.
    #[test]
    fn a_start_held_by_an_open_pull_request_waits_for_its_merge() {
        let mut a = sample_card("ws", KanbanColumnId::Complete);
        a.title = "A".into();
        assert_eq!(start_refusal_message(&[&a]).as_deref(), Some("Starts when “A” ships."));
        a.review_status = Some(ReviewStatus::Merged);
        a.pr_url = Some("https://github.com/o/r/pull/3".into());
        a.pr = Some(crate::pr_status::PrStatus::opened(3, 1));
        assert_eq!(start_refusal_message(&[&a]).as_deref(), Some("Starts when “A” merges."));
        let b = sample_card("ws", KanbanColumnId::Todo);
        assert_eq!(start_refusal_message(&[&a, &b]).as_deref(), Some("Starts when “A” and 1 more ship."));
        assert_eq!(start_refusal_message(&[&a, &a]).as_deref(), Some("Starts when “A” and 1 more merge."));
        // Auto-archive takes a landed card only.
        let mut old = a.clone();
        old.worktree_path = None;
        assert!(!auto_archive_eligible(&old, 1_000_000_000_000_000), "its pull request is open");
        old.ship_status = ShipStatus::Shipped;
        old.pr.as_mut().unwrap().state = crate::pr_status::PrState::Merged;
        assert!(auto_archive_eligible(&old, 1_000_000_000_000_000));
    }

    /// N14 walk F11, migration safety: a board saved by an older build,
    /// whose archived card carries the `merged` that archive used to stamp,
    /// loads unchanged and saves back unchanged (nothing is rewritten), and
    /// it stays out of the attention rules as an archived card.
    #[test]
    fn a_board_with_an_old_archive_stamped_merged_loads_unchanged() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut old = sample_card("ws-old", KanbanColumnId::InProgress);
        old.archived = true;
        old.review_status = Some(ReviewStatus::Merged);
        store.save("ws-old", vec![old]).unwrap();
        let raw = std::fs::read_to_string(store.workspace_path("ws-old")).unwrap();
        assert!(raw.contains("\"reviewStatus\": \"merged\""));

        let fresh = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let cards = fresh.load("ws-old").unwrap();
        assert_eq!(cards.len(), 1);
        assert!(cards[0].archived);
        assert_eq!(cards[0].review_status, Some(ReviewStatus::Merged));
    }

    #[test]
    fn delete_workspace_is_idempotent() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store.save("ws-x", vec![sample_card("ws-x", KanbanColumnId::Todo)]).unwrap();
        store.delete_workspace("ws-x").unwrap();
        store.delete_workspace("ws-x").unwrap();
        let cards = store.load("ws-x").unwrap();
        assert!(cards.is_empty());
    }

    /// Tier 2 schema-migration test for v1.9.0 (Phase A): a v1 file with a
    /// Complete-column card must come back as `verify_status: Legacy` +
    /// `ship_status: Shipped` so the new ship gate doesn't try to gate
    /// pre-feature shipped work on retroactive verification (decision 15).
    #[test]
    fn pre_v9_complete_card_migrates_to_legacy_shipped() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-v9.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 1,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-pre-v9",
                "title": "shipped before v9",
                "columnId": "complete",
                "createdAt": 100,
                "updatedAt": 200
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-pre-v9").unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].verify_status, VerifyStatus::Legacy);
        assert_eq!(cards[0].ship_status, ShipStatus::Shipped);
        assert!(cards[0].verify_history.is_empty());
        assert!(cards[0].ship_history.is_empty());
        assert!(cards[0].commit_sha.is_none());
        assert!(cards[0].shipped_version.is_none());
    }

    /// Tier 2 schema-migration test for v1.31.0 (Cycle 1): a card JSON
    /// written before the review surface — no `reviewStatus` /
    /// `reviewDecisions` keys — must deserialize with `review_status: None`
    /// and an empty `review_decisions`. The `#[serde(default)]` on both
    /// fields is the migration; there is no schema-version bump.
    #[test]
    fn pre_v31_card_loads_without_review_fields() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-v31.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = format!(
            r#"{{
                "version": {KANBAN_SCHEMA_VERSION},
                "cards": [{{
                    "id": "c1",
                    "workspaceId": "ws-pre-v31",
                    "title": "made before review surface",
                    "columnId": "in_progress",
                    "createdAt": 100,
                    "updatedAt": 200
                }}]
            }}"#
        );
        fs::write(&path, json.as_bytes()).unwrap();
        let cards = store.load("ws-pre-v31").unwrap();
        assert_eq!(cards.len(), 1);
        assert!(cards[0].review_status.is_none());
        assert!(cards[0].review_decisions.is_empty());
        assert!(cards[0].pr_url.is_none());
    }

    /// v1 cards in non-Complete columns must stay `verify_status: None` +
    /// `ship_status: Unshipped` after migration — they're still actual
    /// in-flight work. The retired `"in_review"` column maps to Complete
    /// via the serde alias and therefore takes the Legacy/Shipped path
    /// alongside the `"complete"` card.
    #[test]
    fn pre_v9_non_complete_card_stays_unshipped() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-v9-mix.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 1,
            "cards": [
                {
                    "id": "c-todo",
                    "workspaceId": "ws-pre-v9-mix",
                    "title": "todo",
                    "columnId": "todo",
                    "createdAt": 1, "updatedAt": 1
                },
                {
                    "id": "c-prog",
                    "workspaceId": "ws-pre-v9-mix",
                    "title": "in progress",
                    "columnId": "in_progress",
                    "createdAt": 1, "updatedAt": 1
                },
                {
                    "id": "c-rev",
                    "workspaceId": "ws-pre-v9-mix",
                    "title": "in review",
                    "columnId": "in_review",
                    "createdAt": 1, "updatedAt": 1
                },
                {
                    "id": "c-done",
                    "workspaceId": "ws-pre-v9-mix",
                    "title": "complete",
                    "columnId": "complete",
                    "createdAt": 1, "updatedAt": 1
                }
            ]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-pre-v9-mix").unwrap();
        assert_eq!(cards.len(), 4);
        // The retired In Review column aliases to Complete, so two of the
        // four cards (c-rev, c-done) should land in Complete and pick up
        // Legacy/Shipped via the v1 → v3 migration.
        let rev = cards.iter().find(|c| c.id == "c-rev").unwrap();
        assert_eq!(rev.column_id, KanbanColumnId::Complete);
        for c in &cards {
            match c.column_id {
                KanbanColumnId::Complete => {
                    assert_eq!(c.verify_status, VerifyStatus::Legacy);
                    assert_eq!(c.ship_status, ShipStatus::Shipped);
                }
                _ => {
                    assert_eq!(c.verify_status, VerifyStatus::None);
                    assert_eq!(c.ship_status, ShipStatus::Unshipped);
                }
            }
        }
    }

    /// Migration must persist to disk: after the first load rewrites the
    /// file under the current schema, a fresh store sees the new version
    /// directly without re-running the migration. The on-disk JSON must
    /// carry the current `KANBAN_SCHEMA_VERSION`.
    #[test]
    fn pre_v9_migration_persists_to_disk_as_current_version() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-persist.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 1,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-persist",
                "title": "old shipped card",
                "columnId": "complete",
                "createdAt": 1, "updatedAt": 1
            }]
        }"#;
        fs::write(&path, json).unwrap();
        store.load("ws-persist").unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        assert!(
            raw.contains(&format!("\"version\": {KANBAN_SCHEMA_VERSION}")),
            "expected version {KANBAN_SCHEMA_VERSION} on disk after migration, got: {raw}"
        );
        assert!(raw.contains("\"shipStatus\": \"shipped\""));
        assert!(raw.contains("\"verifyStatus\": \"legacy\""));

        // Fresh store should now see the current version without re-migrating.
        let store2 = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let cards = store2.load("ws-persist").unwrap();
        assert_eq!(cards[0].verify_status, VerifyStatus::Legacy);
        assert_eq!(cards[0].ship_status, ShipStatus::Shipped);
        assert!(cards[0].attachments.is_empty());
    }

    /// Tier 2 schema-migration test for the In Review retirement: a v3
    /// file with the retired `"in_review"` column-id must deserialize as
    /// Complete via the serde alias, and a subsequent save must rewrite
    /// the on-disk JSON to the canonical `"complete"` string.
    #[test]
    fn in_review_column_aliases_to_complete_and_persists() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-in-review.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 3,
            "cards": [{
                "id": "c-rev",
                "workspaceId": "ws-in-review",
                "title": "stuck in review",
                "columnId": "in_review",
                "shipStatus": "unshipped",
                "verifyStatus": "none",
                "attachments": [],
                "createdAt": 1, "updatedAt": 1
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-in-review").unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].column_id, KanbanColumnId::Complete);

        // Save back and re-read the file from disk: the alias must serialize
        // as `"complete"` so on-disk JSON converges to the canonical form.
        store.save("ws-in-review", cards).unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        assert!(
            raw.contains("\"columnId\": \"complete\""),
            "expected canonical \"complete\" on disk, got: {raw}"
        );
        assert!(
            !raw.contains("\"in_review\""),
            "stale \"in_review\" should be gone, got: {raw}"
        );

        // Fresh store sees Complete directly.
        let store2 = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let cards2 = store2.load("ws-in-review").unwrap();
        assert_eq!(cards2[0].column_id, KanbanColumnId::Complete);
    }

    /// Tier 2 schema-migration test for the attachments field: a v2 file
    /// without `attachments` must round-trip cleanly with
    /// `attachments: vec![]`, and the on-disk file must rewrite to the
    /// current `KANBAN_SCHEMA_VERSION`. The migration also folds in the
    /// later worktree fields (v3 → v4) since v2 → v4 collapses through
    /// the no-op `#[serde(default)]` arms.
    #[test]
    fn v2_card_loads_with_attachments_defaulted_to_empty() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-attach.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 2,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-pre-attach",
                "title": "pre-attachments",
                "columnId": "todo",
                "shipStatus": "unshipped",
                "verifyStatus": "none",
                "createdAt": 1, "updatedAt": 1
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-pre-attach").unwrap();
        assert_eq!(cards.len(), 1);
        assert!(cards[0].attachments.is_empty());
        assert!(cards[0].worktree_path.is_none());
        assert!(cards[0].branch_name.is_none());

        let raw = fs::read_to_string(&path).unwrap();
        assert!(
            raw.contains(&format!("\"version\": {KANBAN_SCHEMA_VERSION}")),
            "expected current version on disk after migration, got: {raw}"
        );
    }

    /// Tier 2 schema-migration test for v1.10.0 Cycle A: a v3 file without
    /// `worktreePath` / `branchName` must round-trip cleanly with both
    /// fields defaulted to `None` and the on-disk file rewritten to v4.
    /// Existing InProgress cards keep `None` until their next column
    /// transition; the lifecycle hook materializes the worktree lazily
    /// (Cycle A v1.10.1).
    #[test]
    fn v3_card_loads_with_worktree_fields_defaulted_to_none() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-worktree.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 3,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-pre-worktree",
                "title": "active card",
                "columnId": "in_progress",
                "shipStatus": "unshipped",
                "verifyStatus": "none",
                "attachments": [],
                "createdAt": 1, "updatedAt": 1
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-pre-worktree").unwrap();
        assert_eq!(cards.len(), 1);
        assert!(cards[0].worktree_path.is_none());
        assert!(cards[0].branch_name.is_none());
        assert_eq!(cards[0].column_id, KanbanColumnId::InProgress);

        let raw = fs::read_to_string(&path).unwrap();
        assert!(
            raw.contains(&format!("\"version\": {KANBAN_SCHEMA_VERSION}")),
            "expected version {KANBAN_SCHEMA_VERSION} on disk after migration, got: {raw}"
        );
    }

    /// Tier 2 round-trip test: a v4 card with `worktree_path` and
    /// `branch_name` populated must save and reload losslessly.
    #[test]
    fn v4_card_with_worktree_round_trips() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut card = sample_card("ws-wt", KanbanColumnId::InProgress);
        card.worktree_path = Some(
            "/Users/mb/code/atelier/.atelier-worktrees/card_1".to_string(),
        );
        card.branch_name = Some("atelier/card-card_1-test-title".to_string());
        store.save("ws-wt", vec![card]).unwrap();

        let store2 = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let cards = store2.load("ws-wt").unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(
            cards[0].worktree_path.as_deref(),
            Some("/Users/mb/code/atelier/.atelier-worktrees/card_1")
        );
        assert_eq!(
            cards[0].branch_name.as_deref(),
            Some("atelier/card-card_1-test-title")
        );
    }

    /// Tier 2 round-trip test for v1.10.0: a v3 file with a populated
    /// `attachments` array must load and save losslessly.
    #[test]
    fn v3_card_with_attachments_round_trips() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut card = sample_card("ws-attach", KanbanColumnId::Todo);
        card.attachments = vec![
            CardAttachment {
                id: "att-1".into(),
                display_name: "screenshot.png".into(),
                stored_path: "/tmp/atelier/attachments/ws-attach/c1/abc-screenshot.png".into(),
                size_bytes: 1234,
                mime_type: Some("image/png".into()),
                added_at: 1_000_000,
            },
            CardAttachment {
                id: "att-2".into(),
                display_name: "doc.pdf".into(),
                stored_path: "/tmp/atelier/attachments/ws-attach/c1/def-doc.pdf".into(),
                size_bytes: 56_789,
                mime_type: None,
                added_at: 1_000_001,
            },
        ];
        store.save("ws-attach", vec![card]).unwrap();

        let store2 = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let cards = store2.load("ws-attach").unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].attachments.len(), 2);
        assert_eq!(cards[0].attachments[0].id, "att-1");
        assert_eq!(cards[0].attachments[0].display_name, "screenshot.png");
        assert_eq!(
            cards[0].attachments[0].mime_type.as_deref(),
            Some("image/png")
        );
        assert_eq!(cards[0].attachments[0].size_bytes, 1234);
        assert_eq!(cards[0].attachments[1].id, "att-2");
        assert!(cards[0].attachments[1].mime_type.is_none());
    }

    /// 1.171.0 B2: a ship entry written before `target` loads (None) and a
    /// new one keeps it; None is not written, so an older build reads the
    /// file it always did.
    #[test]
    fn ship_entry_target_is_backward_compatible() {
        let old: ShipEntry = serde_json::from_str(
            r#"{"commitSha":"a","shippedVersion":"1.0.0","releaseKind":"local","shippedAt":5}"#,
        )
        .unwrap();
        assert_eq!(old.target, None);
        let json = serde_json::to_value(&old).unwrap();
        assert!(json.get("target").is_none(), "None isn't written");
        let new = ShipEntry { target: Some("develop".into()), ..old };
        let back: ShipEntry = serde_json::from_value(serde_json::to_value(&new).unwrap()).unwrap();
        assert_eq!(back.target.as_deref(), Some("develop"));
        // The card's target, by name, from its worktree's start.
        let mut card = sample_card("ws", KanbanColumnId::Complete);
        assert_eq!(ship_target_of(&card), None);
        card.worktree_base = Some(crate::worktrees::WorktreeBase {
            commit: "c".into(),
            ref_name: "origin/develop".into(),
            source: crate::worktrees::BaseSource::Origin,
            note: None, origin_slug: None, origin_url: None, merged_target: None,
        });
        assert_eq!(ship_target_of(&card).as_deref(), Some("develop"));
    }

    /// 1.173.0 (B4): an entry from before `tag` loads with none, is saved
    /// again without the key (an older build reads the file it always did)
    /// and still reads as `v<version>`; a new one keeps its tag.
    #[test]
    fn ship_entry_tag_is_backward_compatible() {
        let raw = r#"{"commitSha":"a","shippedVersion":"1.0.0","releaseKind":"local","shippedAt":5,"target":"main"}"#;
        let old: ShipEntry = serde_json::from_str(raw).unwrap();
        assert_eq!(old.tag, None);
        let json = serde_json::to_value(&old).unwrap();
        assert!(json.get("tag").is_none(), "None isn't written");
        assert_eq!(json, serde_json::from_str::<serde_json::Value>(raw).unwrap(), "re-saved as it was");
        assert_eq!(old.tag.clone().unwrap_or_else(|| format!("v{}", old.shipped_version)), "v1.0.0");
        let new = ShipEntry { tag: Some("site-v3.0.2".into()), ..old };
        let back: ShipEntry = serde_json::from_value(serde_json::to_value(&new).unwrap()).unwrap();
        assert_eq!(back.tag.as_deref(), Some("site-v3.0.2"));
    }

    /// A natively-v2 card with verify/ship history populated must round-trip.
    #[test]
    fn v2_card_with_verify_and_ship_round_trips() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut card = sample_card("ws-rt", KanbanColumnId::Complete);
        card.verify_status = VerifyStatus::Passed;
        card.verify_intent = Some("click X, expect Y".into());
        card.verify_history.push(VerifyEntry {
            verify_run_id: "vr-1".into(),
            tree_sha: None,
            status: VerifyStatus::Passed,
            ended_at: 1234,
            summary: Some("all 4 steps passed".into()),
            steps: vec![VerifyStepResult {
                kind: "cargo-test".into(),
                passed: true,
                elapsed_ms: 12_000,
                reason: None,
            }],
        });
        card.ship_status = ShipStatus::Shipped;
        card.commit_sha = Some("abc123".into());
        card.shipped_version = Some("v1.9.3".into());
        card.ship_history.push(ShipEntry {
            commit_sha: "abc123".into(),
            shipped_version: "v1.9.3".into(),
            release_kind: ReleaseKind::Local,
            shipped_at: 5_678,
            target: None,
            tag: None,
        });
        store.save("ws-rt", vec![card]).unwrap();

        let store2 = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let cards = store2.load("ws-rt").unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].verify_status, VerifyStatus::Passed);
        assert_eq!(cards[0].verify_intent.as_deref(), Some("click X, expect Y"));
        assert_eq!(cards[0].verify_history.len(), 1);
        assert_eq!(cards[0].verify_history[0].verify_run_id, "vr-1");
        assert_eq!(cards[0].verify_history[0].steps.len(), 1);
        assert_eq!(cards[0].ship_status, ShipStatus::Shipped);
        assert_eq!(cards[0].commit_sha.as_deref(), Some("abc123"));
        assert_eq!(cards[0].shipped_version.as_deref(), Some("v1.9.3"));
        assert_eq!(cards[0].ship_history.len(), 1);
        assert_eq!(cards[0].ship_history[0].release_kind, ReleaseKind::Local);
    }

    #[test]
    fn release_kind_deserializes_local_github_and_push_only() {
        // Tier 2 schema-migration test for v1.13.4: the ReleaseKind enum
        // grew a `PushOnly` variant. Pre-v1.13.4 disk JSON only has
        // `local` and `github`; both must still deserialize unchanged.
        // The new `push_only` discriminant must round-trip into the new
        // variant.
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-rk.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 4,
            "cards": [{
                "id": "c-local",
                "workspaceId": "ws-rk",
                "title": "local",
                "columnId": "complete",
                "createdAt": 1,
                "updatedAt": 1,
                "shipHistory": [{
                    "commitSha": "aaa",
                    "shippedVersion": "v1.0.0",
                    "releaseKind": "local",
                    "shippedAt": 1
                }]
            }, {
                "id": "c-github",
                "workspaceId": "ws-rk",
                "title": "github",
                "columnId": "complete",
                "createdAt": 1,
                "updatedAt": 1,
                "shipHistory": [{
                    "commitSha": "bbb",
                    "shippedVersion": "v1.0.0",
                    "releaseKind": "github",
                    "shippedAt": 1
                }]
            }, {
                "id": "c-push-only",
                "workspaceId": "ws-rk",
                "title": "push_only",
                "columnId": "complete",
                "createdAt": 1,
                "updatedAt": 1,
                "shipHistory": [{
                    "commitSha": "ccc",
                    "shippedVersion": "v1.13.4",
                    "releaseKind": "push_only",
                    "shippedAt": 1
                }]
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-rk").unwrap();
        assert_eq!(cards.len(), 3);
        assert_eq!(cards[0].ship_history[0].release_kind, ReleaseKind::Local);
        assert_eq!(cards[1].ship_history[0].release_kind, ReleaseKind::Github);
        assert_eq!(cards[2].ship_history[0].release_kind, ReleaseKind::PushOnly);
    }

    // ── v1.19.0 (Cycle E4): IntakeRecord + intake_history tests ──

    #[test]
    fn pre_v5_card_loads_with_empty_intake_history() {
        // Tier 2 schema-migration: a v4 file lacks the `intakeHistory`
        // field; load should default it to an empty Vec without
        // dropping any other field.
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-v5.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 4,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-pre-v5",
                "title": "pre-v5 card with intake completed",
                "columnId": "todo",
                "dispatchPrompt": "build the thing",
                "intakeStatus": "ready",
                "createdAt": 1,
                "updatedAt": 1
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-pre-v5").unwrap();
        assert_eq!(cards.len(), 1);
        // intake_history defaulted to empty without losing dispatch_prompt.
        assert!(cards[0].intake_history.is_empty());
        assert_eq!(cards[0].dispatch_prompt.as_deref(), Some("build the thing"));
        assert_eq!(cards[0].intake_status, IntakeStatus::Ready);
    }

    #[test]
    fn pre_v6_card_loads_with_no_linked_brainstorm_id() {
        // Tier 2 schema-migration (v1.26.0): a v5 file lacks the
        // `linkedBrainstormId` field; load should default it to `None`
        // without dropping any other field. Mirrors the v4 → v5
        // intake_history migration test directly above.
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-v6.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 5,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-pre-v6",
                "title": "pre-v6 card",
                "columnId": "in_progress",
                "linkedSwarmId": "sw-dispatch-1",
                "createdAt": 1,
                "updatedAt": 1
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-pre-v6").unwrap();
        assert_eq!(cards.len(), 1);
        // The new field defaults to None.
        assert!(cards[0].linked_brainstorm_id.is_none());
        // The pre-existing linked_swarm_id is preserved (we don't want
        // the migration to confuse the two fields).
        assert_eq!(cards[0].linked_swarm_id.as_deref(), Some("sw-dispatch-1"));
    }

    #[test]
    fn linked_brainstorm_id_round_trips_through_serde() {
        // v1.26.0: the new field survives save → reload via a fresh
        // store (bypasses in-memory cache).
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut card = sample_card("ws-brainstorm", KanbanColumnId::Todo);
        card.linked_brainstorm_id = Some("sw-brainstorm-1".into());
        store.save("ws-brainstorm", vec![card]).unwrap();

        let store2 = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let cards = store2.load("ws-brainstorm").unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(
            cards[0].linked_brainstorm_id.as_deref(),
            Some("sw-brainstorm-1"),
        );
    }

    #[test]
    fn pre_v8_card_loads_with_no_gh_issue_number() {
        // Tier 2 schema-migration (v1.57.0, Cycle 3): a v7 file lacks
        // `ghIssueNumber`; load defaults it to None without dropping other
        // fields, and rewrites the file at the current version (so v7 boards
        // are NOT dropped by the `other => ignoring` arm after the bump).
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-v8.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 7,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-pre-v8",
                "title": "pre-v8 card",
                "columnId": "todo",
                "createdAt": 1,
                "updatedAt": 1
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-pre-v8").unwrap();
        assert_eq!(cards.len(), 1, "v7 board must survive the bump to v8");
        assert_eq!(cards[0].gh_issue_number, None);
        // The other v8 GitHub-backing fields also default cleanly.
        assert!(!cards[0].sync_pending);
        assert_eq!(cards[0].gh_raw_remainder, None);
        assert_eq!(cards[0].title, "pre-v8 card");

        // The on-disk file now advertises the current version.
        let bytes = fs::read(&path).unwrap();
        let parsed: KanbanFile = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed.version, KANBAN_SCHEMA_VERSION);
    }

    #[test]
    fn v8_card_without_sync_fields_defaults_them() {
        // Tier 2 schema-migration (v1.57.0, Cycle 3): a v8 board written
        // before `sync_pending` / `gh_raw_remainder` were folded into the
        // schema lacks those keys; serde `#[serde(default)]` must fill them
        // without dropping the card or its `ghIssueNumber`.
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-v8-old.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = format!(
            r#"{{
            "version": {KANBAN_SCHEMA_VERSION},
            "cards": [{{
                "id": "c1",
                "workspaceId": "ws-v8-old",
                "title": "v8 card",
                "columnId": "todo",
                "ghIssueNumber": 42,
                "createdAt": 1,
                "updatedAt": 1
            }}]
        }}"#
        );
        fs::write(&path, json.as_bytes()).unwrap();
        let cards = store.load("ws-v8-old").unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].gh_issue_number, Some(42));
        assert!(!cards[0].sync_pending);
        assert_eq!(cards[0].gh_raw_remainder, None);
    }

    /// Tier 2 (UX-5.3): a board written before `boardOrder` existed loads
    /// unchanged — the field defaults to `None` (the card sorts by
    /// `createdAt`), the file on disk is not rewritten, and a card that was
    /// never reordered writes no `boardOrder` key back.
    #[test]
    fn a_board_from_before_board_order_loads_unchanged() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-order.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = format!(
            r#"{{
            "version": {KANBAN_SCHEMA_VERSION},
            "cards": [{{
                "id": "c1",
                "workspaceId": "ws-pre-order",
                "title": "a card from before UX-5.3",
                "columnId": "complete",
                "archived": true,
                "shipStatus": "shipped",
                "createdAt": 1,
                "updatedAt": 5
            }}]
        }}"#
        );
        fs::write(&path, json.as_bytes()).unwrap();
        let cards = store.load("ws-pre-order").unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].board_order, None);
        assert!(cards[0].archived, "nothing beside it changes");
        assert_eq!(cards[0].updated_at, 5);
        assert_eq!(fs::read(&path).unwrap(), json.as_bytes(), "not rewritten");
        let out = serde_json::to_value(&cards[0]).unwrap();
        assert!(out.get("boardOrder").is_none(), "{out}");
    }

    /// Tier 2 (UX-5.8): a board from before `archivedAt` / `autoArchived`
    /// loads unchanged — archived cards stay archived with `None` / `false`,
    /// the file is not rewritten, and neither key is written back for them.
    #[test]
    fn a_board_from_before_auto_archive_loads_unchanged() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-archive.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = format!(
            r#"{{
            "version": {KANBAN_SCHEMA_VERSION},
            "cards": [{{
                "id": "old-archived",
                "workspaceId": "ws-pre-archive",
                "title": "archived before C5",
                "columnId": "complete",
                "archived": true,
                "reviewStatus": "merged",
                "createdAt": 1,
                "updatedAt": 2
            }}, {{
                "id": "old-shipped",
                "workspaceId": "ws-pre-archive",
                "title": "shipped long ago",
                "columnId": "complete",
                "shipStatus": "shipped",
                "createdAt": 1,
                "updatedAt": 2
            }}]
        }}"#
        );
        fs::write(&path, json.as_bytes()).unwrap();
        let cards = store.load("ws-pre-archive").unwrap();
        assert_eq!(cards.len(), 2);
        assert!(cards[0].archived);
        assert_eq!(cards[0].archived_at, None);
        assert!(!cards[0].auto_archived);
        assert!(!cards[1].archived);
        assert_eq!(fs::read(&path).unwrap(), json.as_bytes(), "not rewritten");
        for card in &cards {
            let out = serde_json::to_value(card).unwrap();
            assert!(out.get("archivedAt").is_none(), "{out}");
            assert!(out.get("autoArchived").is_none(), "{out}");
        }
        // QoL 1.168 S1-3: every archived card comes back — one from before
        // C5 that never shipped too; the Board draws it where its state says.
        assert!(card_restorable(&cards[0]));
        let back = store.restore_card("ws-pre-archive", "old-archived").unwrap();
        assert!(!back.archived);
        assert!(back.archived_at.is_some(), "the auto-archive won't take it again");
        assert_eq!(
            store.restore_card("ws-pre-archive", "old-archived").unwrap_err(),
            "This card is not archived."
        );
    }

    fn shipped_card(id: &str, shipped_at: i64) -> KanbanCard {
        let mut card = KanbanCard::new(
            id.into(),
            "ws".into(),
            id.into(),
            None,
            KanbanColumnId::Complete,
        );
        card.ship_status = ShipStatus::Shipped;
        card.ship_history = vec![ShipEntry {
            commit_sha: "abc".into(),
            shipped_version: "v1.0.0".into(),
            release_kind: ReleaseKind::Local,
            shipped_at,
            target: None,
            tag: None,
        }];
        card
    }

    /// UX-5.8: shipped more than 14 days ago, never archived, no worktree —
    /// and nothing else — is taken by the auto-archive.
    #[test]
    fn auto_archive_takes_only_old_shipped_cards() {
        let now = 100 * AUTO_ARCHIVE_AFTER_MS;
        let old = now - AUTO_ARCHIVE_AFTER_MS - 1;
        assert!(auto_archive_eligible(&shipped_card("a", old), now));
        assert!(!auto_archive_eligible(&shipped_card("b", now - AUTO_ARCHIVE_AFTER_MS), now));
        let mut with_tree = shipped_card("c", old);
        with_tree.worktree_path = Some("/tmp/wt".into());
        assert!(!auto_archive_eligible(&with_tree, now));
        let mut restored = shipped_card("d", old);
        restored.archived_at = Some(old);
        assert!(!auto_archive_eligible(&restored, now), "a restored card stays");
        let mut unshipped = shipped_card("e", old);
        unshipped.ship_status = ShipStatus::Unshipped;
        assert!(!auto_archive_eligible(&unshipped, now));
        // A card merged through a PR, with no ship entry, ages by updated_at.
        let mut merged = shipped_card("f", 0);
        merged.ship_status = ShipStatus::Unshipped;
        merged.ship_history.clear();
        merged.review_status = Some(ReviewStatus::Merged);
        merged.updated_at = old;
        assert!(auto_archive_eligible(&merged, now));
    }

    /// UX-5.8: archive (auto) → restore → not auto-archived again; the store
    /// refuses an auto-archive of a card that is not eligible.
    #[test]
    fn auto_archive_is_reversible_and_does_not_come_back() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store
            .save("ws", vec![shipped_card("old", 1), shipped_card("new", now_millis())])
            .unwrap();
        assert_eq!(
            store.archive_card("ws", "new", true).unwrap_err(),
            AUTO_ARCHIVE_NOT_ELIGIBLE
        );
        let archived = store.archive_card("ws", "old", true).unwrap();
        assert!(archived.archived && archived.auto_archived);
        assert!(archived.archived_at.is_some());

        let reopened = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let back = reopened.restore_card("ws", "old").unwrap();
        assert!(!back.archived && !back.auto_archived);
        assert!(back.archived_at.is_some(), "kept, so it is not taken again");
        assert!(!auto_archive_eligible(&back, i64::MAX / 2));
        assert_eq!(
            reopened.archive_card("ws", "old", true).unwrap_err(),
            AUTO_ARCHIVE_NOT_ELIGIBLE
        );
        // By hand it can still go.
        assert!(reopened.archive_card("ws", "old", false).unwrap().archived);
    }

    /// Tier 2 (1.168.1 E2): a board written before a card's own `models`
    /// existed loads unchanged — `None` (the workspace's), the file not
    /// rewritten, a save without the key; a set choice round-trips, a
    /// cleared one leaves no key, and setting it leaves `updatedAt` and the
    /// GitHub push flag alone.
    #[test]
    fn a_board_from_before_card_models_loads_unchanged() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-models.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = format!(
            r#"{{
            "version": {KANBAN_SCHEMA_VERSION},
            "cards": [{{
                "id": "c1",
                "workspaceId": "ws-pre-models",
                "title": "a card from before its own models",
                "columnId": "todo",
                "notes": "Do it",
                "builderVendorPref": "codex",
                "createdAt": 1,
                "updatedAt": 5
            }}]
        }}"#
        );
        fs::write(&path, json.as_bytes()).unwrap();
        let cards = store.load("ws-pre-models").unwrap();
        assert_eq!(cards[0].models, None);
        assert_eq!(cards[0].builder_vendor_pref, Some(crate::settings::BuilderVendor::Codex));
        assert_eq!(fs::read(&path).unwrap(), json.as_bytes(), "not rewritten");
        assert!(serde_json::to_value(&cards[0]).unwrap().get("models").is_none());
        store.save("ws-pre-models", cards).unwrap();
        assert!(!String::from_utf8(fs::read(&path).unwrap()).unwrap().contains("\"models\""));

        let mut own = crate::settings::WorkspaceModels::default();
        own.rows.codex.builder = Some(" gpt-6-astra ".into());
        own.rows.codex.challenger_reasoning = Some("low".into());
        own.cli_default = vec!["claude.challenger".into()];
        let set = store.set_card_models("ws-pre-models", "c1", Some(own)).unwrap();
        assert_eq!(set.updated_at, 5, "a model choice is not an edit");
        assert!(!set.sync_pending, "never pushed to GitHub");
        let reopened = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let again = reopened.load("ws-pre-models").unwrap();
        let models = again[0].models.clone().unwrap();
        assert_eq!(models.rows.codex.builder.as_deref(), Some("gpt-6-astra"), "normalized");
        assert_eq!(models.cli_default, vec!["claude.challenger".to_string()]);
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(on_disk["cards"][0]["models"]["codex"]["challengerReasoning"], "low");

        // An older Plyloft reads the card as it always did (unknown key ignored).
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct OldCard {
            id: String,
            title: String,
        }
        let old: OldCard = serde_json::from_value(on_disk["cards"][0].clone()).unwrap();
        assert_eq!((old.id.as_str(), old.title.as_str()), ("c1", "a card from before its own models"));

        // Blank everywhere clears it: no key at all.
        let mut blank = crate::settings::WorkspaceModels::default();
        blank.rows.claude.builder = Some("  ".into());
        assert_eq!(reopened.set_card_models("ws-pre-models", "c1", Some(blank)).unwrap().models, None);
        assert!(!String::from_utf8(fs::read(&path).unwrap()).unwrap().contains("\"models\""));
        assert!(reopened.set_card_models("ws-pre-models", "nope", None).is_err());
    }

    /// Tier 2 (1.169.0 A1): a card whose `models` were written by 1.168.1
    /// (no Claude effort, a Codex `minimal`) loads unchanged and is not
    /// rewritten; a Claude effort set on it round-trips under
    /// `claude.builderReasoning`.
    #[test]
    fn a_card_with_1168_models_loads_unchanged_and_takes_a_claude_effort() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-1168.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = format!(
            r#"{{
            "version": {KANBAN_SCHEMA_VERSION},
            "cards": [{{
                "id": "c1",
                "workspaceId": "ws-1168",
                "title": "a 1.168.1 card",
                "columnId": "todo",
                "models": {{"claude":{{"builder":"opus"}},"codex":{{"builderReasoning":"minimal"}}}},
                "createdAt": 1,
                "updatedAt": 5
            }}]
        }}"#
        );
        fs::write(&path, json.as_bytes()).unwrap();
        let cards = store.load("ws-1168").unwrap();
        let models = cards[0].models.clone().unwrap();
        assert_eq!(models.rows.claude.builder.as_deref(), Some("opus"));
        assert_eq!(models.rows.claude.builder_reasoning, None);
        assert_eq!(models.rows.codex.builder_reasoning.as_deref(), Some("minimal"), "kept");
        assert_eq!(fs::read(&path).unwrap(), json.as_bytes(), "not rewritten");

        let mut next = models.clone();
        next.rows.claude.builder_reasoning = Some(" high ".into());
        store.set_card_models("ws-1168", "c1", Some(next)).unwrap();
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(on_disk["cards"][0]["models"]["claude"]["builderReasoning"], "high");
        assert!(on_disk["cards"][0]["models"]["claude"].get("challengerReasoning").is_none());
        assert_eq!(on_disk["cards"][0]["models"]["codex"]["builderReasoning"], "minimal");
    }

    /// 1.168.1 (E2): a changed Builder choice for the Builder's own vendor
    /// replaces the model Build with both chose; a Challenger or other-vendor
    /// change keeps it.
    #[test]
    fn a_card_builder_model_replaces_the_build_with_both_choice() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut card = sample_card("ws", KanbanColumnId::InProgress);
        card.id = "c1".into();
        card.builder = Some(serde_json::from_value(serde_json::json!({
            "vendor": "codex", "startedAt": 1, "snapshots": [],
            "chosenModel": {"model": "gpt-5.5", "reasoning": "high"}
        })).unwrap());
        store.save("ws", vec![card]).unwrap();
        let chosen = |s: &KanbanStore| s.get_card("ws", "c1").unwrap().builder.unwrap().chosen_model;
        assert!(chosen(&store).is_some(), "saved with the choice");
        let mut challenger = crate::settings::WorkspaceModels::default();
        challenger.rows.codex.challenger = Some("gpt-7".into());
        challenger.rows.claude.builder = Some("opus".into());
        store.set_card_models("ws", "c1", Some(challenger.clone())).unwrap();
        assert!(chosen(&store).is_some(), "not the Builder's own vendor and role");
        let mut builder = challenger.clone();
        builder.rows.codex.builder_reasoning = Some("low".into());
        store.set_card_models("ws", "c1", Some(builder)).unwrap();
        assert_eq!(chosen(&store), None);
    }

    /// Tier 2: a board written before `builderVendorPref` existed loads
    /// unchanged — the field defaults to `None` (the Settings default), the
    /// file is not rewritten, and a save round-trips without the key.
    #[test]
    fn a_board_from_before_builder_vendor_pref_loads_unchanged() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-vendor.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = format!(
            r#"{{
            "version": {KANBAN_SCHEMA_VERSION},
            "cards": [{{
                "id": "c1",
                "workspaceId": "ws-pre-vendor",
                "title": "a card from before the vendor choice was saved",
                "columnId": "todo",
                "notes": "Do it",
                "createdAt": 1,
                "updatedAt": 5
            }}]
        }}"#
        );
        fs::write(&path, json.as_bytes()).unwrap();
        let cards = store.load("ws-pre-vendor").unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].builder_vendor_pref, None);
        assert_eq!(cards[0].notes.as_deref(), Some("Do it"));
        assert_eq!(cards[0].updated_at, 5);
        assert_eq!(fs::read(&path).unwrap(), json.as_bytes(), "not rewritten");
        let out = serde_json::to_value(&cards[0]).unwrap();
        assert!(out.get("builderVendorPref").is_none(), "{out}");

        // Round-trip: saved and reloaded, still `None`, still no key.
        store.save("ws-pre-vendor", cards).unwrap();
        let reopened = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let again = reopened.load("ws-pre-vendor").unwrap();
        assert_eq!(again[0].builder_vendor_pref, None);
        let on_disk = String::from_utf8(fs::read(&path).unwrap()).unwrap();
        assert!(!on_disk.contains("builderVendorPref"), "{on_disk}");
    }

    /// 1.171.0 (D1) Tier 2: a board written before the Builder permissions
    /// choice loads unchanged — the card's choice and its session's are
    /// `None` (the session resumes by today's rule), the file is not
    /// rewritten, and a save round-trips without either key; a saved choice
    /// round-trips; a value this Plyloft doesn't know reads as `None`
    /// instead of failing the whole board.
    #[test]
    fn a_board_from_before_builder_permissions_loads_unchanged_and_round_trips() {
        use crate::settings::BuilderPermissions;
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-d1.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = format!(
            r#"{{
            "version": {KANBAN_SCHEMA_VERSION},
            "cards": [{{
                "id": "c1",
                "workspaceId": "ws-d1",
                "title": "built before D1",
                "columnId": "in_progress",
                "builderVendorPref": "codex",
                "builder": {{
                    "vendor": "codex",
                    "bypass": true,
                    "sessionLost": true,
                    "startedAt": 5,
                    "snapshots": []
                }},
                "createdAt": 1,
                "updatedAt": 5
            }}]
        }}"#
        );
        fs::write(&path, json.as_bytes()).unwrap();
        let cards = store.load("ws-d1").unwrap();
        assert_eq!(cards[0].builder_permissions, None);
        let b = cards[0].builder.as_ref().unwrap();
        assert_eq!(b.permissions, None);
        assert!(b.bypass, "the old session keeps its bypass");
        assert_eq!(fs::read(&path).unwrap(), json.as_bytes(), "not rewritten");
        store.save("ws-d1", cards.clone()).unwrap();
        let on_disk = fs::read_to_string(&path).unwrap();
        assert!(!on_disk.contains("builderPermissions") && !on_disk.contains(r#""permissions""#), "{on_disk}");

        let mut card = cards[0].clone();
        card.builder_permissions = Some(BuilderPermissions::EditsCopy);
        card.builder.as_mut().unwrap().permissions = Some(BuilderPermissions::NeverAsks);
        store.save("ws-d1", vec![card]).unwrap();
        let on_disk = fs::read_to_string(&path).unwrap();
        assert!(on_disk.contains(r#""builderPermissions": "editsCopy""#), "{on_disk}");
        assert!(on_disk.contains(r#""permissions": "neverAsks""#), "{on_disk}");
        let back = KanbanStore::new(tmp.path().to_path_buf()).unwrap().load("ws-d1").unwrap();
        assert_eq!(back[0].builder_permissions, Some(BuilderPermissions::EditsCopy));
        assert_eq!(back[0].builder.as_ref().unwrap().permissions, Some(BuilderPermissions::NeverAsks));

        // A newer Plyloft's value: read as no choice, the board still loads.
        let newer = on_disk
            .replace(r#""builderPermissions": "editsCopy""#, r#""builderPermissions": "askLater""#)
            .replace(r#""permissions": "neverAsks""#, r#""permissions": "askLater""#);
        fs::write(&path, newer).unwrap();
        let back = KanbanStore::new(tmp.path().to_path_buf()).unwrap().load("ws-d1").unwrap();
        assert_eq!(back[0].builder_permissions, None);
        assert_eq!(back[0].builder.as_ref().unwrap().permissions, None);
        assert_eq!(back[0].builder_vendor_pref, Some(crate::settings::BuilderVendor::Codex));
    }

    /// D1: the setter persists, reloads and clears; an unknown card is
    /// refused with nothing written.
    #[test]
    fn set_builder_permissions_persists_reloads_and_refuses_strangers() {
        use crate::settings::BuilderPermissions;
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let card = KanbanCard::new("c1".into(), "ws".into(), "t".into(), None, KanbanColumnId::Todo);
        store.save("ws", vec![card]).unwrap();
        let out = store.set_builder_permissions("ws", "c1", Some(BuilderPermissions::Asks)).unwrap();
        assert_eq!(out.builder_permissions, Some(BuilderPermissions::Asks));
        let reopened = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(reopened.load("ws").unwrap()[0].builder_permissions, Some(BuilderPermissions::Asks));
        assert!(reopened.set_builder_permissions("ws", "nope", Some(BuilderPermissions::NeverAsks)).is_err());
        assert_eq!(reopened.load("ws").unwrap()[0].builder_permissions, Some(BuilderPermissions::Asks));
        let cleared = reopened.set_builder_permissions("ws", "c1", None).unwrap();
        assert_eq!(cleared.builder_permissions, None);
    }

    /// Tier 2 (SL-5): a board written before `lineComments` existed loads
    /// unchanged — the list is empty, the file is not rewritten, and a save
    /// round-trips without the key.
    #[test]
    fn a_board_from_before_line_comments_loads_unchanged() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-lc.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = format!(
            r#"{{
            "version": {KANBAN_SCHEMA_VERSION},
            "cards": [{{
                "id": "c1",
                "workspaceId": "ws-pre-lc",
                "title": "a card from before line comments",
                "columnId": "in_progress",
                "worktreePath": "/tmp/wt",
                "branchName": "atelier/c1",
                "createdAt": 1,
                "updatedAt": 5
            }}]
        }}"#
        );
        fs::write(&path, json.as_bytes()).unwrap();
        let cards = store.load("ws-pre-lc").unwrap();
        assert!(cards[0].line_comments.is_empty());
        assert_eq!(cards[0].branch_name.as_deref(), Some("atelier/c1"));
        assert_eq!(fs::read(&path).unwrap(), json.as_bytes(), "not rewritten");
        store.save("ws-pre-lc", cards).unwrap();
        let on_disk = String::from_utf8(fs::read(&path).unwrap()).unwrap();
        assert!(!on_disk.contains("lineComments"), "{on_disk}");
    }

    /// SL-5: line comments persist atomically, survive a reload, leave
    /// `updated_at` alone, and sent ones stay as history.
    #[test]
    fn line_comments_persist_edit_remove_and_stay_as_history() {
        use crate::line_comments::LineCommentDraft;
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let card = KanbanCard::new("c1".into(), "ws".into(), "Review".into(), None, KanbanColumnId::InProgress);
        let updated_at = card.updated_at;
        store.save("ws", vec![card]).unwrap();
        let draft = |body: &str| LineCommentDraft {
            path: "src/a.ts".into(),
            new_start: Some(4),
            new_end: Some(6),
            old_start: Some(3),
            old_end: Some(3),
            quoted: "-old\n+new\n ctx".into(),
            body: body.into(),
        };
        let out = store.add_line_comment("ws", "c1", draft("first")).unwrap();
        assert_eq!(out.updated_at, updated_at);
        let a = out.line_comments[0].id.clone();
        assert!(a.starts_with("lc-"));
        let out = store.add_line_comment("ws", "c1", draft("second")).unwrap();
        let b = out.line_comments[1].id.clone();
        assert_ne!(a, b);

        let path = tmp.path().join(KANBAN_SUBDIR).join("ws.json");
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let first = &on_disk["cards"][0]["lineComments"][0];
        assert_eq!(first["path"], "src/a.ts");
        assert_eq!(first["newStart"], 4);
        assert_eq!(first["oldEnd"], 3);
        assert!(first.get("sentAt").is_none(), "{first}");

        store.update_line_comment("ws", "c1", &b, "second, edited").unwrap();
        let before = fs::read(&path).unwrap();
        assert!(store.add_line_comment("ws", "c1", draft("  ")).is_err());
        assert!(store.add_line_comment("ws", "nope", draft("x")).is_err());
        assert_eq!(fs::read(&path).unwrap(), before, "a refused write writes nothing");

        let out = store.mark_line_comments_sent("ws", "c1", &[a.clone()]).unwrap();
        assert!(out.line_comments[0].sent_at.is_some());
        assert!(out.line_comments[1].sent_at.is_none());
        assert!(store.remove_line_comment("ws", "c1", &a).is_err(), "history stays");
        assert!(store.update_line_comment("ws", "c1", &a, "rewrite").is_err());
        store.remove_line_comment("ws", "c1", &b).unwrap();

        let reopened = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let card = reopened.get_card("ws", "c1").unwrap();
        assert_eq!(card.line_comments.len(), 1);
        assert_eq!(card.line_comments[0].body, "first");
        assert!(card.line_comments[0].sent_at.is_some());
        assert_eq!(card.updated_at, updated_at);
    }

    /// Tier 2 (SL-1): a board written before `pr` existed — including a card
    /// shipped as a PR, with `prUrl` and `reviewStatus: merged` — loads
    /// unchanged: `pr` is `None`, the file is not rewritten, and a save
    /// round-trips without the key. A `pr` holding only its number (or keys a
    /// later Plyloft adds) loads with every other field at its default.
    #[test]
    fn a_board_from_before_pr_status_loads_unchanged() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-pr.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = format!(
            r#"{{
            "version": {KANBAN_SCHEMA_VERSION},
            "cards": [{{
                "id": "c1",
                "workspaceId": "ws-pre-pr",
                "title": "shipped as a pull request before SL-1",
                "columnId": "complete",
                "prUrl": "https://github.com/o/r/pull/29",
                "reviewStatus": "merged",
                "createdAt": 1,
                "updatedAt": 5
            }}]
        }}"#
        );
        fs::write(&path, json.as_bytes()).unwrap();
        let cards = store.load("ws-pre-pr").unwrap();
        assert_eq!(cards[0].pr, None);
        assert_eq!(cards[0].review_status, Some(ReviewStatus::Merged));
        assert_eq!(cards[0].updated_at, 5);
        assert_eq!(fs::read(&path).unwrap(), json.as_bytes(), "not rewritten");
        store.save("ws-pre-pr", cards).unwrap();
        let on_disk = String::from_utf8(fs::read(&path).unwrap()).unwrap();
        assert!(!on_disk.contains("\"pr\""), "{on_disk}");

        let minimal: KanbanCard = serde_json::from_str(
            r#"{"id":"c2","workspaceId":"w","title":"t","columnId":"todo","createdAt":1,"updatedAt":1,
                "pr":{"number":7,"someLaterField":true}}"#,
        )
        .unwrap();
        let pr = minimal.pr.unwrap();
        assert_eq!(pr.number, 7);
        assert_eq!(pr.state, crate::pr_status::PrState::Open);
        assert_eq!(pr.checks, crate::pr_status::PrChecks::None);
        assert_eq!(pr.checked_at, None);
    }

    /// The vendor choice is written atomically, survives a reload, is not
    /// an update of the card, clears with `None`, and an unknown card is
    /// refused with nothing written.
    #[test]
    fn set_builder_vendor_pref_persists_reloads_and_refuses_strangers() {
        use crate::settings::BuilderVendor;
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let card = KanbanCard::new("c1".into(), "ws".into(), "Pick".into(), None, KanbanColumnId::Todo);
        let updated_at = card.updated_at;
        store.save("ws", vec![card]).unwrap();

        let out = store.set_builder_vendor_pref("ws", "c1", Some(BuilderVendor::Codex)).unwrap();
        assert_eq!(out.builder_vendor_pref, Some(BuilderVendor::Codex));
        assert_eq!(out.updated_at, updated_at);
        assert!(out.builder.is_none());
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws.json");
        let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(on_disk["cards"][0]["builderVendorPref"], "codex", "{on_disk}");

        let reopened = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(
            reopened.load("ws").unwrap()[0].builder_vendor_pref,
            Some(BuilderVendor::Codex)
        );

        let before = fs::read(&path).unwrap();
        let err = reopened
            .set_builder_vendor_pref("ws", "nope", Some(BuilderVendor::Claude))
            .unwrap_err();
        assert!(err.contains("not found"), "{err}");
        assert!(reopened
            .set_builder_vendor_pref("other-ws", "c1", Some(BuilderVendor::Claude))
            .is_err());
        assert_eq!(fs::read(&path).unwrap(), before, "nothing written");

        let cleared = reopened.set_builder_vendor_pref("ws", "c1", None).unwrap();
        assert_eq!(cleared.builder_vendor_pref, None);
        let again = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(again.load("ws").unwrap()[0].builder_vendor_pref, None);
    }

    /// UX-5.3: a reorder writes the key atomically, survives a reload, and
    /// is not an update of the card (`updated_at` stays).
    #[test]
    fn set_board_order_persists_without_touching_the_card() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let card = KanbanCard::new(
            "c1".into(),
            "ws".into(),
            "Reorder me".into(),
            None,
            KanbanColumnId::InProgress,
        );
        let updated_at = card.updated_at;
        store.save("ws", vec![card]).unwrap();
        let out = store.set_board_order("ws", "c1", Some(150.5)).unwrap();
        assert_eq!(out.board_order, Some(150.5));
        assert_eq!(out.updated_at, updated_at);
        assert!(matches!(out.column_id, KanbanColumnId::InProgress));

        let reopened = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let cards = reopened.load("ws").unwrap();
        assert_eq!(cards[0].board_order, Some(150.5));
        assert!(matches!(cards[0].column_id, KanbanColumnId::InProgress));

        assert_eq!(reopened.set_board_order("ws", "c1", None).unwrap().board_order, None);
        assert!(reopened.set_board_order("ws", "c1", Some(f64::NAN)).is_err());
    }

    /// Tier 2 (UX-7.1): a board written before `blockedBy` existed loads
    /// unchanged — the field defaults to empty, the file on disk is not
    /// rewritten, and a card with no blocker writes no `blockedBy` key back.
    #[test]
    fn a_board_from_before_blocked_by_loads_unchanged() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-deps.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = format!(
            r#"{{
            "version": {KANBAN_SCHEMA_VERSION},
            "cards": [{{
                "id": "c1",
                "workspaceId": "ws-pre-deps",
                "title": "a card from before UX-7.1",
                "notes": "a brief",
                "columnId": "todo",
                "createdAt": 1,
                "updatedAt": 5
            }}]
        }}"#
        );
        fs::write(&path, json.as_bytes()).unwrap();
        let cards = store.load("ws-pre-deps").unwrap();
        assert_eq!(cards.len(), 1);
        assert!(cards[0].blocked_by.is_empty());
        assert_eq!(cards[0].updated_at, 5);
        assert_eq!(fs::read(&path).unwrap(), json.as_bytes(), "not rewritten");
        let out = serde_json::to_value(&cards[0]).unwrap();
        assert!(out.get("blockedBy").is_none(), "{out}");
        assert_eq!(store.start_refusal("ws-pre-deps", "c1").unwrap(), None);
    }

    fn dep_board(store: &KanbanStore, titles: &[(&str, &str)]) {
        let cards = titles
            .iter()
            .map(|(id, title)| {
                KanbanCard::new(
                    id.to_string(),
                    "ws".into(),
                    title.to_string(),
                    Some("brief".into()),
                    KanbanColumnId::Todo,
                )
            })
            .collect();
        store.save("ws", cards).unwrap();
    }

    /// UX-7.1: `blockedBy` is written atomically, survives a reload, and
    /// moves `updated_at`; duplicates collapse.
    #[test]
    fn set_blocked_by_persists_and_reloads() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        dep_board(&store, &[("a", "Session cookie"), ("b", "Login redirect"), ("c", "Docs")]);
        let out = store
            .set_blocked_by("ws", "b", vec!["a".into(), "c".into(), "a".into()])
            .unwrap();
        assert_eq!(out.blocked_by, vec!["a".to_string(), "c".to_string()]);
        let reopened = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let cards = reopened.load("ws").unwrap();
        let b = cards.iter().find(|c| c.id == "b").unwrap();
        assert_eq!(b.blocked_by, vec!["a".to_string(), "c".to_string()]);
        let raw: serde_json::Value =
            serde_json::from_slice(&fs::read(tmp.path().join(KANBAN_SUBDIR).join("ws.json")).unwrap()).unwrap();
        let written = raw["cards"].as_array().unwrap().iter().find(|c| c["id"] == "b").unwrap();
        assert_eq!(written["blockedBy"], serde_json::json!(["a", "c"]));
        // Clearing writes no key again.
        let cleared = reopened.set_blocked_by("ws", "b", vec![]).unwrap();
        assert!(cleared.blocked_by.is_empty());
        assert!(serde_json::to_value(&cleared).unwrap().get("blockedBy").is_none());
    }

    /// UX-7.2: cycles, the card itself and unknown ids are refused at write
    /// time, with nothing written.
    #[test]
    fn set_blocked_by_refuses_cycles_and_strangers() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        dep_board(&store, &[("a", "A"), ("b", "B"), ("c", "C")]);
        store.set_blocked_by("ws", "b", vec!["a".into()]).unwrap();
        store.set_blocked_by("ws", "c", vec!["b".into()]).unwrap();
        // Direct: a waits for b, which waits for a.
        let direct = store.set_blocked_by("ws", "a", vec!["b".into()]).unwrap_err();
        assert_eq!(direct, "“A” can't wait for “B”: “B” already waits for “A”.");
        // Indirect: a → c → b → a.
        assert!(store.set_blocked_by("ws", "a", vec!["c".into()]).is_err());
        assert_eq!(
            store.set_blocked_by("ws", "a", vec!["a".into()]).unwrap_err(),
            "A card can't wait for itself."
        );
        assert!(store.set_blocked_by("ws", "a", vec!["nope".into()]).is_err());
        let cards = store.load("ws").unwrap();
        assert!(cards.iter().find(|c| c.id == "a").unwrap().blocked_by.is_empty(), "nothing written");
    }

    /// UX-7.2: an unshipped blocker holds a card that has not started; a
    /// shipped, archived or deleted one does not, and the ship starts
    /// nothing — the dependent stays in Todo, never run.
    #[test]
    fn a_blocker_holds_the_start_until_it_ships_and_never_starts_anything() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        dep_board(&store, &[("a", "Session cookie"), ("b", "Login redirect"), ("c", "Docs")]);
        store.set_blocked_by("ws", "b", vec!["a".into()]).unwrap();
        assert_eq!(
            store.start_refusal("ws", "b").unwrap().as_deref(),
            Some("Starts when “Session cookie” ships.")
        );
        store.set_blocked_by("ws", "b", vec!["a".into(), "c".into()]).unwrap();
        assert_eq!(
            store.start_refusal("ws", "b").unwrap().as_deref(),
            Some("Starts when “Session cookie” and 1 more ship.")
        );
        // `a` ships.
        store
            .mutate_card("ws", "a", |c| {
                c.ship_status = ShipStatus::Shipped;
                Ok(())
            })
            .unwrap();
        assert_eq!(
            store.start_refusal("ws", "b").unwrap().as_deref(),
            Some("Starts when “Docs” ships.")
        );
        // `c` is archived: it holds no one back.
        store.archive_card("ws", "c", false).unwrap();
        assert_eq!(store.start_refusal("ws", "b").unwrap(), None);
        let b = store.get_card("ws", "b").unwrap();
        assert!(matches!(b.column_id, KanbanColumnId::Todo), "never started");
        assert!(b.last_run_status.is_none() && b.builder.is_none() && b.worktree_path.is_none());
        // A card already under way is not stopped by a blocker added later.
        store.set_blocked_by("ws", "c", vec![]).unwrap();
        store
            .mutate_card("ws", "b", |c| {
                c.column_id = KanbanColumnId::InProgress;
                Ok(())
            })
            .unwrap();
        assert_eq!(store.start_refusal("ws", "b").unwrap(), None);
    }

    /// UX-7.2: deleting a blocker takes it out of every Blocked by.
    #[test]
    fn deleting_a_blocker_unblocks_its_dependents() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        dep_board(&store, &[("a", "A"), ("b", "B"), ("c", "C")]);
        store.set_blocked_by("ws", "b", vec!["a".into(), "c".into()]).unwrap();
        store.set_blocked_by("ws", "c", vec!["a".into()]).unwrap();
        store.delete_card("ws", "a").unwrap();
        let cards = store.load("ws").unwrap();
        assert_eq!(cards.iter().find(|c| c.id == "b").unwrap().blocked_by, vec!["c".to_string()]);
        assert!(cards.iter().find(|c| c.id == "c").unwrap().blocked_by.is_empty());
        assert_eq!(store.start_refusal("ws", "c").unwrap(), None);
        assert!(store.start_refusal("ws", "b").unwrap().is_some(), "c still holds b");
    }

    /// Tier 2 (GH #104): a `builder` object written before `userCorrections`
    /// existed loads, and reads as "no correction" — the safe way round, since a
    /// card with no record of one proposes nothing.
    #[test]
    fn a_builder_without_user_corrections_defaults_it() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-104.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = format!(
            r#"{{
            "version": {KANBAN_SCHEMA_VERSION},
            "cards": [{{
                "id": "c1",
                "workspaceId": "ws-pre-104",
                "title": "a card from before GH #104",
                "columnId": "in_progress",
                "createdAt": 1,
                "updatedAt": 1,
                "builder": {{
                    "vendor": "claude",
                    "snapshots": [{{ "n": 1, "sha": "abc1234", "at": 2 }}],
                    "changesRequestedCount": 3
                }}
            }}]
        }}"#
        );
        fs::write(&path, json.as_bytes()).unwrap();
        let cards = store.load("ws-pre-104").unwrap();
        assert_eq!(cards.len(), 1, "the card is not dropped");
        let builder = cards[0].builder.as_ref().expect("its Builder state loads");
        assert_eq!(builder.user_corrections, 0);
        // GH #104 walk (B3): and before the corrections' words and the
        // requests' outcomes were kept.
        assert!(builder.correction_texts.is_empty());
        assert!(builder.review_decisions.is_empty());
        assert_eq!(builder.changes_requested_count, 3, "and nothing beside it is lost");
        assert_eq!(builder.snapshots.len(), 1);
    }

    /// GH #104 walk (B3): the corrections' words are kept bounded — the last
    /// five, each capped — and round-trip through the board with the
    /// requests' outcomes.
    #[test]
    fn the_corrections_words_are_bounded_and_round_trip() {
        let mut builder: BuilderState = serde_json::from_value(serde_json::json!({
            "vendor": "claude", "startedAt": 0, "snapshots": []
        }))
        .unwrap();
        builder.remember_correction("   ");
        assert!(builder.correction_texts.is_empty(), "nothing typed, nothing kept");
        for i in 1..=7 {
            builder.remember_correction(&format!("correction {i}"));
        }
        assert_eq!(builder.correction_texts.len(), CORRECTION_TEXTS_MAX);
        assert_eq!(builder.correction_texts[0], "correction 3", "the oldest go first");
        assert_eq!(builder.correction_texts[4], "correction 7");
        builder.remember_correction(&"é".repeat(400));
        let long = builder.correction_texts.last().unwrap();
        assert!(long.len() <= CORRECTION_TEXT_MAX + "…".len());
        assert!(long.ends_with('…'));
        for n in 0..(REVIEW_DECISIONS_MAX as u32 + 3) {
            builder.remember_decision(RequestDecision {
                snapshot_n: n,
                outcome: RequestOutcome::BuilderChanged,
                next_snapshot_n: Some(n + 1),
                by: None,
                at: 0,
            });
        }
        assert_eq!(builder.review_decisions.len(), REVIEW_DECISIONS_MAX);
        assert_eq!(builder.review_decisions[0].snapshot_n, 3);

        let json = serde_json::to_value(&builder).unwrap();
        assert_eq!(json["reviewDecisions"][0]["outcome"], "builder_changed");
        let back: BuilderState = serde_json::from_value(json).unwrap();
        assert_eq!(back, builder);
    }

    #[test]
    fn card_without_gh_assignees_loads_with_none_and_keeps_its_issue() {
        // Tier 2 schema-migration (GH #66): a board written before
        // `ghAssignees` existed loads with an empty list, keeping every
        // other field — no version bump, the field is `#[serde(default)]`.
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-assignees.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = format!(
            r#"{{
            "version": {KANBAN_SCHEMA_VERSION},
            "cards": [{{
                "id": "gh-issue-62",
                "workspaceId": "ws-pre-assignees",
                "title": "claimed on another Mac",
                "columnId": "in_progress",
                "ghIssueNumber": 62,
                "syncPending": true,
                "createdAt": 1,
                "updatedAt": 1
            }}]
        }}"#
        );
        fs::write(&path, json.as_bytes()).unwrap();
        let cards = store.load("ws-pre-assignees").unwrap();
        assert_eq!(cards.len(), 1);
        assert!(cards[0].gh_assignees.is_empty());
        assert!(!cards[0].gh_labels_pending);
        assert_eq!(cards[0].gh_issue_number, Some(62));
        assert!(cards[0].sync_pending);
        assert_eq!(cards[0].column_id, KanbanColumnId::InProgress);
    }

    #[test]
    fn card_without_gh_claim_loads_unchanged_and_the_claim_round_trips() {
        // Tier 2 schema-migration (1.173.0, C2): a board written before
        // `ghClaim` loads with none, keeping every other field.
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-claim.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = format!(
            r#"{{
            "version": {KANBAN_SCHEMA_VERSION},
            "cards": [{{
                "id": "gh-issue-7",
                "workspaceId": "ws-pre-claim",
                "title": "taken on the other Mac",
                "columnId": "in_progress",
                "ghIssueNumber": 7,
                "ghAssignees": ["matteo"],
                "createdAt": 1,
                "updatedAt": 1
            }}]
        }}"#
        );
        fs::write(&path, json.as_bytes()).unwrap();
        let cards = store.load("ws-pre-claim").unwrap();
        assert_eq!(cards[0].gh_claim, None);
        assert!(!cards[0].gh_claim_here);
        assert_eq!(cards[0].gh_claim_lost_to, None);
        assert_eq!(cards[0].gh_assignees, vec!["matteo".to_string()]);
        assert_eq!(cards[0].gh_issue_number, Some(7));
        let claim = crate::device_claim::DeviceClaim {
            device: "dev-pro".into(),
            name: "MacBook Pro".into(),
            login: Some("matteo".into()),
            at: "2026-10-30T08:00:00Z".into(),
        };
        assert!(store.set_gh_claim("ws-pre-claim", "gh-issue-7", Some(claim.clone()), Some("dev-mini")).unwrap());
        assert!(!store.set_gh_claim("ws-pre-claim", "gh-issue-7", Some(claim.clone()), Some("dev-mini")).unwrap());
        let bytes = fs::read_to_string(&path).unwrap();
        assert!(bytes.contains("\"ghClaim\""));
        // Another computer's over it: "taken over", kept through the file.
        let mini = crate::device_claim::DeviceClaim { device: "dev-mini".into(), ..claim.clone() };
        assert!(store.set_gh_claim("ws-pre-claim", "gh-issue-7", Some(mini), Some("dev-mini")).unwrap());
        assert!(store.set_gh_claim("ws-pre-claim", "gh-issue-7", Some(claim.clone()), Some("dev-mini")).unwrap());
        assert!(fs::read_to_string(&path).unwrap().contains("\"ghClaimLostTo\": \"MacBook Pro\""));
        let reopened = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let back = reopened.get_card("ws-pre-claim", "gh-issue-7").unwrap();
        assert_eq!(back.gh_claim, Some(claim));
        assert_eq!(back.gh_claim_lost_to.as_deref(), Some("MacBook Pro"));
        assert!(store.set_gh_claim("ws-pre-claim", "gh-issue-7", None, Some("dev-mini")).unwrap());
        let file = fs::read_to_string(&path).unwrap();
        assert!(!file.contains("ghClaim"), "none is not written: {file}");
    }

    #[test]
    fn gh_assignees_round_trip_through_the_board_file() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store.create_card("ws", sample_card("ws", KanbanColumnId::Todo)).unwrap();
        let id = store.load("ws").unwrap()[0].id.clone();
        let logins = vec!["test-owner".to_string(), "hubot".to_string()];
        assert!(store.set_gh_assignees("ws", &id, logins.clone()).unwrap());
        assert!(
            !store.set_gh_assignees("ws", &id, logins.clone()).unwrap(),
            "an unchanged list writes nothing"
        );

        let bytes = fs::read(tmp.path().join(KANBAN_SUBDIR).join("ws.json")).unwrap();
        assert!(String::from_utf8_lossy(&bytes).contains("\"ghAssignees\""));
        let reopened = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(reopened.get_card("ws", &id).unwrap().gh_assignees, logins);
    }

    #[test]
    fn card_without_gh_author_loads_and_round_trips_unchanged() {
        // Tier 2 schema-migration (N14 item 6): a board written before
        // `ghAuthor` existed loads with no author, keeps every other field,
        // and is written back without the key — no version bump, the field
        // is `#[serde(default, skip_serializing_if)]`.
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-author.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = format!(
            r#"{{
            "version": {KANBAN_SCHEMA_VERSION},
            "cards": [{{
                "id": "gh-issue-21",
                "workspaceId": "ws-pre-author",
                "title": "written by a teammate",
                "notes": "the brief",
                "columnId": "todo",
                "ghIssueNumber": 21,
                "ghAssignees": ["test-user"],
                "createdAt": 1,
                "updatedAt": 2
            }}]
        }}"#
        );
        fs::write(&path, json.as_bytes()).unwrap();
        let cards = store.load("ws-pre-author").unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].gh_author, None);
        assert_eq!(cards[0].gh_issue_number, Some(21));
        assert_eq!(cards[0].gh_assignees, vec!["test-user".to_string()]);
        assert_eq!(cards[0].notes.as_deref(), Some("the brief"));

        // A write that is not about the author keeps the file free of it.
        assert!(store.set_gh_assignees("ws-pre-author", "gh-issue-21", Vec::new()).unwrap());
        let bytes = fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("ghAuthor"));
        let reopened = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let card = reopened.get_card("ws-pre-author", "gh-issue-21").unwrap();
        assert_eq!(card.gh_author, None);
        assert_eq!(card.title, "written by a teammate");
        assert_eq!(card.created_at, 1);
    }

    #[test]
    fn gh_author_round_trips_through_the_board_file() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store.create_card("ws", sample_card("ws", KanbanColumnId::Todo)).unwrap();
        let id = store.load("ws").unwrap()[0].id.clone();
        let author = Some("test-user".to_string());
        assert!(store.set_gh_author("ws", &id, author.clone()).unwrap());
        assert!(
            !store.set_gh_author("ws", &id, author.clone()).unwrap(),
            "an unchanged author writes nothing"
        );
        let bytes = fs::read(tmp.path().join(KANBAN_SUBDIR).join("ws.json")).unwrap();
        let file: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(file["cards"][0]["ghAuthor"], "test-user");
        let reopened = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(reopened.get_card("ws", &id).unwrap().gh_author, author);
    }

    #[test]
    fn pre_v7_card_loads_with_empty_dismissed_banners() {
        // Tier 2 schema-migration (v1.27.0, Cycle H phase 2): a v6 file
        // lacks the `dismissedBanners` field; load should default it to
        // `Vec::new()` without dropping any other field. After the
        // migration the file is rewritten under v7 so a subsequent
        // re-load sees the new version stamp.
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(KANBAN_SUBDIR).join("ws-pre-v7.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = br#"{
            "version": 6,
            "cards": [{
                "id": "c1",
                "workspaceId": "ws-pre-v7",
                "title": "pre-v7 card",
                "columnId": "todo",
                "linkedBrainstormId": "sw-brainstorm-1",
                "createdAt": 1,
                "updatedAt": 1
            }]
        }"#;
        fs::write(&path, json).unwrap();
        let cards = store.load("ws-pre-v7").unwrap();
        assert_eq!(cards.len(), 1);
        // The new field defaults to an empty Vec.
        assert!(cards[0].dismissed_banners.is_empty());
        // Pre-existing fields preserved across the migration.
        assert_eq!(
            cards[0].linked_brainstorm_id.as_deref(),
            Some("sw-brainstorm-1"),
        );

        // The on-disk file should now advertise the current version so
        // the migration arm doesn't keep firing on every load.
        let bytes = fs::read(&path).unwrap();
        let parsed: KanbanFile = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed.version, KANBAN_SCHEMA_VERSION);
    }

    #[test]
    fn dismissed_banners_round_trip_preserves_entries_and_cap_size() {
        // v1.27.0 (Cycle H phase 2): non-empty `dismissed_banners`
        // survives save → reload via a fresh store (bypasses
        // in-memory cache). Also exercises a 16-element array (the
        // FE-side FIFO cap) round-tripping cleanly — the backend has
        // no writer for this field, so it must at least preserve any
        // valid shape the FE produces.
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();

        // (a) round-trip a small non-empty array.
        let mut card_a = sample_card("ws-dismiss", KanbanColumnId::Todo);
        card_a.id = "card-a".into();
        card_a.dismissed_banners =
            vec!["brainstorm:sw-1".into(), "brainstorm:sw-2".into()];

        // (b) round-trip the FE FIFO cap of 16 distinct entries; no
        // truncation should happen because the cap is FE-enforced and
        // 16 is the steady-state ceiling.
        let mut card_b = sample_card("ws-dismiss", KanbanColumnId::Todo);
        card_b.id = "card-b".into();
        card_b.dismissed_banners = (0..16)
            .map(|i| format!("brainstorm:sw-{i}"))
            .collect();

        store
            .save("ws-dismiss", vec![card_a, card_b])
            .unwrap();

        let store2 = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let cards = store2.load("ws-dismiss").unwrap();
        assert_eq!(cards.len(), 2);
        let by_id: std::collections::HashMap<&str, &KanbanCard> =
            cards.iter().map(|c| (c.id.as_str(), c)).collect();
        assert_eq!(
            by_id["card-a"].dismissed_banners,
            vec!["brainstorm:sw-1", "brainstorm:sw-2"],
        );
        assert_eq!(by_id["card-b"].dismissed_banners.len(), 16);
        assert_eq!(
            by_id["card-b"].dismissed_banners.last().map(String::as_str),
            Some("brainstorm:sw-15"),
        );
    }

    #[test]
    fn intake_record_round_trips_through_serde() {
        let r = IntakeRecord {
            intake_id: "int-aaaa".to_string(),
            started_at: 100,
            concluded_at: Some(200),
            dispatch_prompt: Some("ship it".to_string()),
            transcript_path: Some(
                "intake/transcripts/ws-1/c-1/int-aaaa.log".to_string(),
            ),
            applied: true,
            vendor: None,
            replanned: true,
            two_ais: None,
        };
        let bytes = serde_json::to_vec(&r).unwrap();
        let decoded: IntakeRecord = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(decoded, r);
    }

    fn two_ai_record(id: &str) -> IntakeRecord {
        IntakeRecord {
            intake_id: id.to_string(),
            started_at: 1,
            concluded_at: Some(2),
            dispatch_prompt: Some("plan".into()),
            transcript_path: None,
            applied: true,
            vendor: Some("claude".into()),
            replanned: false,
            two_ais: Some(TwoAisRecord { critic: "codex".into(), rounds: 2, exchange_id: id.to_string() }),
        }
    }

    fn attachment(path: &str) -> CardAttachment {
        CardAttachment {
            id: "att-1".into(),
            display_name: "shot.png".into(),
            stored_path: path.into(),
            size_bytes: 3,
            mime_type: Some("image/png".into()),
            added_at: 1,
        }
    }

    /// Plan with two AIs §5: Accept's one backend write — the fields, the
    /// copied chat files and the record with `twoAis` in one board write;
    /// Edit… marks the plan edited; Use this plan clears the mark.
    #[test]
    fn apply_two_ai_plan_writes_the_plan_the_files_and_the_record_in_one_write() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store.create_card("ws", sample_card("ws", KanbanColumnId::Todo)).unwrap();
        let before = store.get_card("ws", "card_0").unwrap().updated_at;
        std::thread::sleep(std::time::Duration::from_millis(5));
        let card = store
            .apply_two_ai_plan("ws", "card_0", "  ## Goal\nShip it  ", false, two_ai_record("ex-1"), vec![attachment("/a/shot.png")])
            .unwrap();
        assert_eq!(card.dispatch_prompt.as_deref(), Some("## Goal\nShip it"));
        assert_eq!(card.dispatch_prompt_edited_at, None);
        assert_eq!(card.intake_status, IntakeStatus::Ready);
        assert_eq!(card.attachments.len(), 1);
        assert_eq!(card.intake_history.last().unwrap().two_ais.as_ref().unwrap().critic, "codex");
        assert!(card.updated_at > before, "updated_at stamped");
        // From disk, through a fresh store.
        let reread = KanbanStore::new(tmp.path().to_path_buf()).unwrap().get_card("ws", "card_0").unwrap();
        assert_eq!(reread.intake_history, card.intake_history);
        assert_eq!(reread.attachments[0].stored_path, "/a/shot.png");
        assert!(card_dispatch_prompt(&reread).contains("Attached files:\n- /a/shot.png"), "the Builder gets the copied file");
        // Edit… saved: marked edited.
        let edited = store.apply_two_ai_plan("ws", "card_0", "mine", true, two_ai_record("ex-2"), vec![]).unwrap();
        assert!(edited.dispatch_prompt_edited_at.is_some());
        let cleared = store.apply_two_ai_plan("ws", "card_0", "theirs", false, two_ai_record("ex-3"), vec![]).unwrap();
        assert_eq!(cleared.dispatch_prompt_edited_at, None);
    }

    #[test]
    fn apply_two_ai_plan_refuses_a_started_or_archived_card_and_a_bad_text_changing_nothing() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store.create_card("ws", sample_card("ws", KanbanColumnId::Todo)).unwrap();
        store.create_card("ws", sample_card("ws", KanbanColumnId::InProgress)).unwrap();
        let untouched = store.get_card("ws", "card_0").unwrap();
        assert!(store.apply_two_ai_plan("ws", "card_0", "   ", false, two_ai_record("e"), vec![]).is_err());
        let long = "x".repeat(MAX_TWO_AI_PLAN_CHARS + 1);
        assert!(store.apply_two_ai_plan("ws", "card_0", &long, false, two_ai_record("e"), vec![]).is_err());
        assert_eq!(
            store.apply_two_ai_plan("ws", "card_1", "plan", false, two_ai_record("e"), vec![]).unwrap_err(),
            TWO_AI_BUILD_STARTED
        );
        store.archive_card("ws", "card_0", false).unwrap();
        assert!(store.apply_two_ai_plan("ws", "card_0", "plan", false, two_ai_record("e"), vec![]).unwrap_err().contains("archived"));
        let after = store.get_card("ws", "card_0").unwrap();
        assert_eq!(after.dispatch_prompt, untouched.dispatch_prompt);
        assert_eq!(after.intake_history, untouched.intake_history);
    }

    /// A failed write puts the card back in the cache, and the evicted
    /// record's transcript is deleted only after a good write.
    #[test]
    fn apply_two_ai_plan_restores_the_card_on_a_failed_write_and_evicts_transcripts_only_after_a_good_one() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        store.create_card("ws", sample_card("ws", KanbanColumnId::Todo)).unwrap();
        let rel = "intake/transcripts/ws/card_0/old.log".to_string();
        let abs = tmp.path().join(&rel);
        fs::create_dir_all(abs.parent().unwrap()).unwrap();
        fs::write(&abs, "old").unwrap();
        let mut oldest = two_ai_record("old");
        oldest.two_ais = None;
        oldest.transcript_path = Some(rel);
        store.append_intake_history("ws", "card_0", oldest).unwrap();
        for i in 1..MAX_INTAKE_HISTORY {
            store.append_intake_history("ws", "card_0", two_ai_record(&format!("r{i}"))).unwrap();
        }
        // The board's temp file is a folder: the write fails.
        let board = store.workspace_path("ws");
        let mut blocker_name = board.file_name().unwrap().to_owned();
        blocker_name.push(crate::atomic::TEMP_SUFFIX);
        let blocker = board.with_file_name(blocker_name);
        fs::create_dir_all(&blocker).unwrap();
        assert!(store.apply_two_ai_plan("ws", "card_0", "plan", false, two_ai_record("new"), vec![]).is_err());
        let card = store.get_card("ws", "card_0").unwrap();
        assert_eq!(card.dispatch_prompt, None, "the cache holds the card as it was");
        assert_eq!(card.intake_history.len(), MAX_INTAKE_HISTORY);
        assert!(abs.is_file(), "no transcript lost to a failed write");
        fs::remove_dir_all(&blocker).unwrap();
        let card = store.apply_two_ai_plan("ws", "card_0", "plan", false, two_ai_record("new"), vec![]).unwrap();
        assert_eq!(card.intake_history.len(), MAX_INTAKE_HISTORY);
        assert_eq!(card.intake_history.last().unwrap().intake_id, "new");
        assert!(!abs.exists(), "the evicted transcript goes after the write");
    }

    /// Tier 2: a board from before `twoAis` loads unchanged, a record with
    /// it round-trips, and today's struct reads it.
    #[test]
    fn a_board_from_before_two_ais_loads_and_a_two_ai_record_round_trips() {
        let old: IntakeRecord = serde_json::from_str(
            r#"{"intakeId":"i","startedAt":1,"concludedAt":2,"dispatchPrompt":"p","applied":true,"vendor":"claude"}"#,
        )
        .unwrap();
        assert_eq!(old.two_ais, None);
        let bytes = serde_json::to_string(&old).unwrap();
        assert!(!bytes.contains("twoAis"), "absent, not null: an older board's bytes stay");
        let record = two_ai_record("ex");
        let json = serde_json::to_value(&record).unwrap();
        assert_eq!(json["twoAis"]["exchangeId"], "ex");
        let back: IntakeRecord = serde_json::from_value(json).unwrap();
        assert_eq!(back, record, "TwoAisRecord is Eq");
        assert_eq!(card_attachments_dir(Path::new("/c"), "ws", "card").unwrap(), Path::new("/c/attachments/ws/card"));
        assert!(card_attachments_dir(Path::new("/c"), "../ws", "card").is_err());
        assert!(card_attachments_dir(Path::new("/c"), "ws", "a/b").is_err());
    }

    #[test]
    fn append_intake_history_caps_at_max_with_transcript_eviction() {
        let tmp = tempdir().unwrap();
        let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let mut card = sample_card("ws-1", KanbanColumnId::Todo);
        card.id = "c1".to_string();
        store.save("ws-1", vec![card]).unwrap();

        // Pre-create a transcript file for the entry we expect to evict.
        let evictee_rel =
            "intake/transcripts/ws-1/c1/int-evict.log".to_string();
        let evictee_abs = tmp.path().join(&evictee_rel);
        fs::create_dir_all(evictee_abs.parent().unwrap()).unwrap();
        fs::write(&evictee_abs, b"transcript bytes").unwrap();
        assert!(evictee_abs.exists());

        // Push the to-be-evicted entry first, then 10 more (total 11).
        store
            .append_intake_history(
                "ws-1",
                "c1",
                IntakeRecord {
                    intake_id: "int-evict".to_string(),
                    started_at: 1,
                    concluded_at: Some(2),
                    dispatch_prompt: Some("first".to_string()),
                    transcript_path: Some(evictee_rel.clone()),
                    applied: true,
                    vendor: None,
                    replanned: false,
                    two_ais: None,
                },
            )
            .unwrap();
        for i in 0..MAX_INTAKE_HISTORY {
            let id = format!("int-{i}");
            store
                .append_intake_history(
                    "ws-1",
                    "c1",
                    IntakeRecord {
                        intake_id: id.clone(),
                        started_at: 100 + i as i64,
                        concluded_at: Some(200 + i as i64),
                        dispatch_prompt: Some(format!("iter {i}")),
                        transcript_path: None,
                        applied: i % 2 == 0,
                        vendor: None,
                        replanned: false,
                        two_ais: None,
                    },
                )
                .unwrap();
        }

        let cards = store.load("ws-1").unwrap();
        assert_eq!(cards.len(), 1);
        let history = &cards[0].intake_history;
        assert_eq!(history.len(), MAX_INTAKE_HISTORY);
        // The first entry (with the transcript file) was evicted.
        assert!(!history.iter().any(|r| r.intake_id == "int-evict"));
        // ...and its transcript file was deleted from disk.
        assert!(!evictee_abs.exists(), "evicted transcript should be removed");
    }

    // ── v1.34.x: reconcile_ship_backfill ─────────────────────────────

    /// Initialize a fresh git repo in `dir` and return the resulting
    /// initial commit's branch name. We always create `main` so the
    /// backfill scan has a stable target branch regardless of the host
    /// git's `init.defaultBranch` setting.
    fn init_git_repo_with_commits(dir: &std::path::Path, subjects: &[&str]) {
        let run = |args: &[&str]| {
            let out = crate::platform::git_command()
                .args(args)
                .current_dir(dir)
                .env("GIT_AUTHOR_NAME", "test")
                .env("GIT_AUTHOR_EMAIL", "test@example.com")
                .env("GIT_COMMITTER_NAME", "test")
                .env("GIT_COMMITTER_EMAIL", "test@example.com")
                .output()
                .expect("spawn git");
            assert!(
                out.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&["init", "-q", "-b", "main"]);
        // An initial root commit so subsequent commits are real.
        std::fs::write(dir.join("seed.txt"), b"seed\n").unwrap();
        run(&["add", "seed.txt"]);
        run(&["commit", "-q", "-m", "seed"]);
        for (i, subject) in subjects.iter().enumerate() {
            let f = format!("f{i}.txt");
            std::fs::write(dir.join(&f), format!("{i}\n")).unwrap();
            run(&["add", &f]);
            run(&["commit", "-q", "-m", subject]);
        }
    }

    fn merged_unshipped_card(id: &str, title: &str) -> KanbanCard {
        let mut c = sample_card("ws-bf", KanbanColumnId::Complete);
        c.id = id.to_string();
        c.title = title.to_string();
        c.review_status = Some(ReviewStatus::Merged);
        c.ship_status = ShipStatus::Unshipped;
        c.branch_name = Some(format!("atelier/{id}"));
        c.worktree_path = Some(format!("/tmp/atelier-fake-wt/{id}"));
        c.verify_status = VerifyStatus::Passed;
        c
    }

    #[test]
    fn reconcile_ship_backfill_flips_merged_unshipped_card_with_matching_land_commit() {
        let cfg_tmp = tempdir().unwrap();
        let store = KanbanStore::new(cfg_tmp.path().to_path_buf()).unwrap();
        let repo_tmp = tempdir().unwrap();
        init_git_repo_with_commits(
            repo_tmp.path(),
            &["unrelated", "Land card: ship fix", "noise"],
        );
        let card = merged_unshipped_card("c-ship-fix", "ship fix");
        store.save("ws-bf", vec![card]).unwrap();
        let reader = |_root: &std::path::Path| Some("v1.34.0".to_string());
        let n = store.reconcile_ship_backfill(
            "ws-bf",
            repo_tmp.path(),
            "main",
            &[],
            &reader,
        );
        assert_eq!(n, 1);
        let cards = store.load("ws-bf").unwrap();
        let c = &cards[0];
        assert_eq!(c.ship_status, ShipStatus::Shipped);
        assert_eq!(c.shipped_version.as_deref(), Some("v1.34.0"));
        assert!(
            c.commit_sha.is_some(),
            "commit_sha must be set after backfill"
        );
        assert!(
            !c.commit_sha.as_deref().unwrap().is_empty(),
            "commit_sha must be a real SHA, not empty"
        );
        assert_eq!(c.ship_history.len(), 1);
        assert_eq!(
            c.ship_history[0].release_kind,
            ReleaseKind::Local
        );
        assert_eq!(c.ship_history[0].commit_sha, *c.commit_sha.as_ref().unwrap());
        assert!(c.worktree_path.is_none());
        assert!(c.branch_name.is_none());
    }

    /// R8: a Land commit in the new form (`feat: <title>`) is found as the
    /// old one is, the newest of the two when both exist.
    #[test]
    fn reconcile_ship_backfill_reads_the_conventional_land_subject_too() {
        let cfg_tmp = tempdir().unwrap();
        let store = KanbanStore::new(cfg_tmp.path().to_path_buf()).unwrap();
        let repo_tmp = tempdir().unwrap();
        init_git_repo_with_commits(
            repo_tmp.path(),
            &["Land card: Add a tagline", "feat: add a tagline", "Land card: Beta", "noise"],
        );
        store
            .save(
                "ws-bf",
                vec![
                    merged_unshipped_card("c-tagline", "Add a tagline"),
                    merged_unshipped_card("c-beta", "Beta"),
                ],
            )
            .unwrap();
        let newest = |subject: &str| {
            let out = crate::platform::git_command()
                .args(["log", "-n", "1", "--format=%H", "--grep", &format!("^{subject}$"), "main"])
                .current_dir(repo_tmp.path())
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let reader = |_: &std::path::Path| Some("v1.34.0".to_string());
        assert_eq!(store.reconcile_ship_backfill("ws-bf", repo_tmp.path(), "main", &[], &reader), 2);
        let cards = store.load("ws-bf").unwrap();
        assert_eq!(cards[0].commit_sha.as_deref(), Some(newest("feat: add a tagline").as_str()));
        assert_eq!(cards[1].commit_sha.as_deref(), Some(newest("Land card: Beta").as_str()));
    }

    #[test]
    fn reconcile_ship_backfill_leaves_card_untouched_when_no_matching_commit() {
        let cfg_tmp = tempdir().unwrap();
        let store = KanbanStore::new(cfg_tmp.path().to_path_buf()).unwrap();
        let repo_tmp = tempdir().unwrap();
        // `main` carries no `Land card: …` commit matching the card title.
        init_git_repo_with_commits(repo_tmp.path(), &["chore: cleanup", "wip"]);
        let card = merged_unshipped_card("c-orphan", "feature never landed");
        store.save("ws-bf", vec![card.clone()]).unwrap();
        let reader = |_: &std::path::Path| Some("v1.34.0".to_string());
        let n = store.reconcile_ship_backfill(
            "ws-bf",
            repo_tmp.path(),
            "main",
            &[],
            &reader,
        );
        assert_eq!(n, 0);
        let cards = store.load("ws-bf").unwrap();
        assert_eq!(cards[0].ship_status, ShipStatus::Unshipped);
        assert!(cards[0].commit_sha.is_none());
        assert_eq!(cards[0].branch_name, card.branch_name);
        assert_eq!(cards[0].worktree_path, card.worktree_path);
    }

    #[test]
    fn reconcile_ship_backfill_is_idempotent() {
        let cfg_tmp = tempdir().unwrap();
        let store = KanbanStore::new(cfg_tmp.path().to_path_buf()).unwrap();
        let repo_tmp = tempdir().unwrap();
        init_git_repo_with_commits(
            repo_tmp.path(),
            &["Land card: alpha", "Land card: beta"],
        );
        store
            .save(
                "ws-bf",
                vec![
                    merged_unshipped_card("c-alpha", "alpha"),
                    merged_unshipped_card("c-beta", "beta"),
                ],
            )
            .unwrap();
        let reader = |_: &std::path::Path| Some("v1.34.0".to_string());
        let first = store.reconcile_ship_backfill(
            "ws-bf",
            repo_tmp.path(),
            "main",
            &[],
            &reader,
        );
        assert_eq!(first, 2);
        // Re-run: every card is now Shipped, so the predicate filters
        // them out and the second pass is a no-op.
        let second = store.reconcile_ship_backfill(
            "ws-bf",
            repo_tmp.path(),
            "main",
            &[],
            &reader,
        );
        assert_eq!(second, 0);
        let cards = store.load("ws-bf").unwrap();
        for c in &cards {
            assert_eq!(c.ship_status, ShipStatus::Shipped);
            assert_eq!(c.ship_history.len(), 1, "ship_history must not double-append");
        }
    }

    #[test]
    fn reconcile_ship_backfill_skips_card_without_branch_name() {
        // A Merged + Unshipped card with `branch_name = None` (legacy
        // shape) must not be touched — the predicate requires
        // `branch_name.is_some()` as the signal that this is a real
        // post-v1.10.0 worktree-driven card.
        let cfg_tmp = tempdir().unwrap();
        let store = KanbanStore::new(cfg_tmp.path().to_path_buf()).unwrap();
        let repo_tmp = tempdir().unwrap();
        init_git_repo_with_commits(repo_tmp.path(), &["Land card: legacy"]);
        let mut card = merged_unshipped_card("c-legacy", "legacy");
        card.branch_name = None;
        card.worktree_path = None;
        store.save("ws-bf", vec![card]).unwrap();
        let reader = |_: &std::path::Path| Some("v1.34.0".to_string());
        let n = store.reconcile_ship_backfill(
            "ws-bf",
            repo_tmp.path(),
            "main",
            &[],
            &reader,
        );
        assert_eq!(n, 0);
        let cards = store.load("ws-bf").unwrap();
        assert_eq!(cards[0].ship_status, ShipStatus::Unshipped);
    }

    #[test]
    #[ignore = "cross-layer fixture check invoked by test-prepare-p3-4-knowledge-fixture.sh"]
    fn p3_4_prepared_fixture_decodes_with_production_model() {
        let path = std::env::var("PLY_P3_4_DECODE_FIXTURE")
            .expect("PLY_P3_4_DECODE_FIXTURE must name the generated Board file");
        let bytes = std::fs::read(&path).expect("read generated P3-4 fixture Board");
        let parsed: KanbanFile = serde_json::from_slice(&bytes)
            .unwrap_or_else(|error| panic!("generated P3-4 fixture parse failed: {error}"));
        let fixture_cards: Vec<&KanbanCard> = parsed
            .cards
            .iter()
            .filter(|card| card.id.starts_with("p3-4-fixture-"))
            .collect();
        assert_eq!(parsed.version, 8);
        assert_eq!(fixture_cards.len(), 3);
        assert!(fixture_cards.iter().all(|card| {
            card.ship_status == ShipStatus::Shipped
                && card.review_status == Some(ReviewStatus::Merged)
        }));
    }

    #[test]
    fn verify_entry_without_tree_sha_loads_as_unattributed() {
        // Entries written before Ship tied verification to content have no
        // `treeSha`: they load, and count for no commit.
        let legacy: VerifyEntry = serde_json::from_str(
            r#"{"verifyRunId":"vr-1","status":"passed","endedAt":1,"summary":"ok","steps":[]}"#,
        )
        .expect("legacy verify entry deserializes");
        assert!(legacy.tree_sha.is_none());
        let current: VerifyEntry = serde_json::from_str(
            r#"{"verifyRunId":"vr-2","status":"passed","endedAt":2,"treeSha":"abc"}"#,
        )
        .unwrap();
        assert_eq!(current.tree_sha.as_deref(), Some("abc"));
        let round = serde_json::to_value(&current).unwrap();
        assert_eq!(round["treeSha"], "abc");
    }
}

#[cfg(all(test, unix))]
mod with_card_saved_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// GH #124 F7: a change that cannot be written leaves nothing in the
    /// cache, and an update saved before it (a Verify result) stays.
    #[test]
    fn a_change_that_cannot_be_saved_leaves_the_cache_as_it_was() {
        let state = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(state.path().to_path_buf()).unwrap();
        let card: KanbanCard = serde_json::from_str(
            r#"{"id":"c1","workspaceId":"ws","title":"t","columnId":"in_progress","createdAt":0,"updatedAt":0}"#,
        )
        .unwrap();
        store.save("ws", vec![card]).unwrap();
        store.with_card("ws", "c1", |c| {
            c.notes = Some("verify landed".into());
            Ok(())
        })
        .unwrap();
        let dir = state.path().join(KANBAN_SUBDIR);
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        let saved = store.with_card_saved("ws", "c1", |c| {
            c.title = "unsaved".into();
            Ok(())
        });
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(saved.is_err());
        let card = store.get_card("ws", "c1").unwrap();
        assert_eq!(card.title, "t");
        assert_eq!(card.notes.as_deref(), Some("verify landed"));
        // A refused mutation leaves it as it was too.
        assert!(store.with_card_saved("ws", "c1", |c| {
            c.title = "half".into();
            Err("no".into())
        })
        .is_err());
        assert_eq!(store.get_card("ws", "c1").unwrap().title, "t");
        store.with_card_saved("ws", "c1", |c| {
            c.title = "saved".into();
            Ok(())
        })
        .unwrap();
        let fresh = KanbanStore::new(state.path().to_path_buf()).unwrap();
        assert_eq!(fresh.get_card("ws", "c1").unwrap().title, "saved");
    }

    /// 1.171.0 C2 (schema migration): `selfCheckStartedAt` is new on the
    /// Builder record. A board written before it loads with none; one with
    /// none writes no key (an older Plyloft reads the file unchanged); one
    /// set survives the relaunch's session cleanup, which is when the card
    /// says the check didn't finish.
    #[test]
    fn self_check_started_at_is_backward_compatible_and_survives_a_relaunch() {
        let old = r#"{"id":"c1","workspaceId":"ws","title":"t","columnId":"in_progress","createdAt":0,"updatedAt":0,
            "lastRunStatus":"running",
            "builder":{"vendor":"claude","ptyId":"pty-1","startedAt":5,"snapshots":[]}}"#;
        let card: KanbanCard = serde_json::from_str(old).unwrap();
        assert_eq!(card.builder.as_ref().unwrap().self_check_started_at, None);
        let written = serde_json::to_value(&card).unwrap();
        assert!(written["builder"].get("selfCheckStartedAt").is_none(), "left out while None");

        let mut marked = card.clone();
        marked.builder.as_mut().unwrap().self_check_started_at = Some(42);
        assert_eq!(serde_json::to_value(&marked).unwrap()["builder"]["selfCheckStartedAt"], 42);

        // Plyloft quit during the self-check: the next launch clears the
        // session and keeps the marker beside lost_on_restart.
        let state = tempfile::tempdir().unwrap();
        let store = KanbanStore::new(state.path().to_path_buf()).unwrap();
        store.save("ws", vec![marked]).unwrap();
        let relaunched = KanbanStore::new(state.path().to_path_buf()).unwrap();
        let b = relaunched.get_card("ws", "c1").unwrap().builder.unwrap();
        assert_eq!(b.pty_id, None);
        assert!(b.lost_on_restart && b.session_lost);
        assert_eq!(b.self_check_started_at, Some(42));
    }
}
