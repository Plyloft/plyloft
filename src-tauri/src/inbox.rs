//! v1.65.0 (UX revamp step 1 — Inbox): cross-workspace derived event feed +
//! per-user seen store. Design: `docs/ux-revamp/STEP1.md`; contract: decision
//! card #6 in `docs/ux-revamp/spec/`.
//!
//! THE FEED IS A VIEW. There is no event log on disk — every event derives
//! from state the app already persists (kanban cards' run/verify/ship
//! histories, agent run records, schedule configs, a live `gh` query). The
//! only NEW persisted state is the seen store (`<config_dir>/inbox/seen.json`).
//!
//! seen ≠ resolved: `seen` is a per-(user, event) marker (dims the row);
//! `resolved` is never stored — acting on an item (ship, archive, re-run)
//! mutates the source store, so the item leaves the feed on the next
//! derivation.
//!
//! Windowing: shipped + standalone-run events age out after
//! `INBOX_WINDOW_DAYS` (they can't be "resolved" by an action). Needs-you
//! *card* events (failed ones included) are deliberately NOT windowed — an
//! unresolved card still wants you, however old (mirrors
//! `attention.ts::cardWantsYou`).
//!
//! 1.173.0 (F1, owner decision 2): the Inbox is the one place for what needs
//! the person. Failed is no longer a group — a failed run or failed checks is
//! a Needs you row, where the Board has the card. A Builder Plyloft's quit
//! left behind is On hold (`paused_on_close`), and a standalone run that
//! finished is News. Groups are not persisted (the seen store keeps row ids,
//! none of which changed), so no stored value goes away.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::agents::{AgentRegistry, AgentRun, AgentStatus, AgentTrigger};
use crate::atomic::write_atomic_json;
use crate::github::GhPr;
use crate::pr_status::{PrChecks, PrMergeable, PrReviewDecision, PrState};
use crate::kanban::{
    card_is_queue_eligible, KanbanCard, KanbanColumnId, KanbanStore, LastRunStatus, ReviewStatus,
    ShipStatus, VerifyEntry, VerifyStatus,
};
use crate::workspace::WorkspaceStore;

/// Feed horizon for history-shaped events (shipped, standalone runs).
/// Owner-confirmed 2026-06-10 (STEP1.md resolved call #3).
pub const INBOX_WINDOW_DAYS: i64 = 14;
/// Cost rollup horizon (decision card #3: per-workspace 4-week bucket).
pub const COST_ROLLUP_WEEKS: i64 = 4;
/// `gh` is shelled per repo — network-bound. Cache per-repo results this long.
const PR_CACHE_TTL_SECS: u64 = 300;

const DAY_MS: i64 = 24 * 3600 * 1000;
const WEEK_MS: i64 = 7 * DAY_MS;

fn window_ms() -> i64 {
    INBOX_WINDOW_DAYS * DAY_MS
}

/// The Inbox's groups. 1.173.0 (F1): `Failed` folded into `NeedsYou`;
/// `OnHold` (a card Plyloft's quit paused) and `News` (a standalone run that
/// finished) are new. Serialize-only in practice: a row's group is derived on
/// every feed and never stored (`SeenFile` keeps ids).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum InboxGroup {
    /// `failed` (before 1.173.0) reads as Needs you, should anything ever
    /// hand an old group back.
    #[serde(alias = "failed")]
    NeedsYou,
    Running,
    Shipped,
    OnHold,
    News,
    Scheduled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum InboxEventKind {
    /// Card ran successfully and has not been reviewed (review null/pending).
    ReviewNeeded,
    /// Card's last run failed / was aborted / rate-limited.
    CardFailed,
    /// Card's verify pipeline is in `Failed` state.
    VerifyFailed,
    /// GH #104 (ADR 0005): the Challenger proposed one change to a repository
    /// skill or to the root instructions, and it is waiting to be deployed.
    /// Replaces the retired post-ship lesson's `KnowledgeDecision`.
    SkillChangeWaiting,
    /// Standalone (non-card, non-swarm-leg) run finished OK — wants your eyes.
    RunDone,
    /// Standalone run errored or was killed.
    RunFailed,
    /// Open PR where the user's review is requested (live `gh` query).
    PrReview,
    /// A ship recorded in the card's `ship_history` within the window.
    Shipped,
    /// Card with a live linked run/swarm.
    CardRunning,
    /// Card waiting in the card-swarm queue (v1.30.0 derived queue).
    CardQueued,
    /// Standalone run currently running.
    RunRunning,
    /// Next cron fire of a scheduled agent (upcoming only — resolved call #2).
    ScheduleUpcoming,
    /// SL-1: the checks on GitHub failed on the card's open pull request.
    PrChecksFailed,
    /// SL-1: a reviewer asked for changes on the card's open pull request.
    PrChangesRequested,
    /// SL-1: the card's open pull request can't merge: a conflict.
    PrConflict,
    /// 1.169.1 (R1): the card's open pull request is ready to merge — its
    /// checks on GitHub passed, GitHub reports it mergeable, no review in
    /// the way, auto-merge off (`PrStatus::ready_to_merge`).
    PrReadyToMerge,
    /// 1.170.0 (G1–G3 Challenger, 2): the card's open pull request has
    /// commits Plyloft didn't push (`PrStatus::head_moved`) — nothing merges
    /// it by itself; the card offers Merge what's on GitHub now.
    PrHeadMoved,
    /// SL-1: the card's pull request merged (its ship-history entry).
    PrMerged,
    /// SL-1: the card's pull request was closed without merging; the card
    /// is back to review.
    PrClosed,
    /// G7 (1.170.0): "Fix failing checks by itself" stopped on the card's
    /// open pull request — after three tries, or because it couldn't go on
    /// (the Builder session closed or busy, a question in it, a refused
    /// push…). The detail is the reason (`pr_auto_fix::reason`); gone once
    /// the pull request has another head.
    PrAutoFixStopped,
    /// G5 (1.170.0): the card's pull request merged, but this computer's
    /// target branch couldn't be brought up to GitHub's
    /// (`PrStatus::up_to_date_refused`). Asks for **Bring this computer up
    /// to date**; gone once it is.
    BringUpToDate,
    /// Skills hub H6a (R14, R15): a team-library skill brings a script or an
    /// extra file that has no OK on this Mac. One row per skill (the two CLIs'
    /// copies are one), resolved by the OK.
    SkillNeedsOk,
    /// Skills hub H2 (R16): GitHub no longer lets this account read the team
    /// library. Asks whether to switch it off on this Mac; resolved by either
    /// answer, or by a pull that goes through again.
    LibraryAccessLost,
    /// Skills hub H4 (R3, R8, R14): a linked copy asks for a decision — it
    /// changed in the team library and here, or the library removed or
    /// renamed it. One row per skill per workspace, resolved by the choice
    /// (a card that carries it, or a proposal of this copy).
    SkillDecision,
    /// Skills hub H6b walk (R15): the team library holds a plugin Plyloft
    /// refuses for a CLI (hooks, an MCP server…), so that CLI's sessions don't
    /// get its skills. No OK lifts it; the row says who can fix it. One row
    /// per plugin, gone once the library no longer carries the reason.
    TeamPluginRefused,
    /// 1.173.0 (C3): a shared setting this Mac changed was changed on the
    /// branch too (another member, or the same person's other computer) —
    /// it waits for *Keep theirs* or *Use this Mac's*. One row per field per
    /// workspace, gone once answered.
    SharedSettingConflict,
    /// 1.173.0 (E3): a Next improvement round's ideas wait for the person —
    /// "Next improvement for Site: 3 ideas" with *Look at the ideas*.
    /// 1.174.0 (A5, P10, D4 b): News, never counted; grayed once seen (opened,
    /// or Clear the news), and kept while an idea is unanswered; gone once
    /// every idea is answered. A new round is a new row, unseen again. One
    /// row per area per workspace.
    NextImprovementIdeas,
    /// 1.174.0 (DR4): one release of a workspace — "site-v3.0.2 released ·
    /// 5 cards" — one row per tag, whichever cards it carried (a card shipped
    /// with Ship it keeps its own merged row; the release's entry isn't a
    /// second row of the card's). Shipped group, News once (`inboxView`).
    Released,
    /// 1.174.0 (DR4): the workspace's recorded release stopped where only the
    /// person can move it on (its record's problem: a pull request closed
    /// without merging, a branch Plyloft won't overwrite…). Needs you, until
    /// it is dismissed or released; its press opens the Release sheet.
    ReleaseStopped,
}

/// One feed row. `id` is STABLE — keyed off immutable facts (run ids, commit
/// SHAs, PR numbers), never off `updated_at`, so seen markers survive card
/// edits. `seen_eligible == false` rows (running/scheduled) are status, not
/// notifications: they never count toward badges and take no seen marker.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxEvent {
    pub id: String,
    pub kind: InboxEventKind,
    pub group: InboxGroup,
    pub workspace_id: String,
    pub workspace_name: String,
    pub card_id: Option<String>,
    pub run_id: Option<String>,
    pub title: String,
    pub detail: Option<String>,
    pub url: Option<String>,
    /// unix-ms event time. `None` for live PR rows (no transition timestamp).
    pub at: Option<i64>,
    pub seen_at: Option<i64>,
    pub seen_eligible: bool,
}

/// Per-workspace 4-week cost rollup for the Inbox footer (decision card #3).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCostRollup {
    pub workspace_id: String,
    pub workspace_name: String,
    pub total_usd: f64,
    /// Four 7-day buckets, oldest → newest (`weekly_usd[3]` = current week).
    pub weekly_usd: Vec<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxFeed {
    pub generated_at: i64,
    pub window_days: i64,
    pub events: Vec<InboxEvent>,
    pub cost_rollup: Vec<WorkspaceCostRollup>,
    pub eligibility_proof: InboxEligibilityProof,
    /// UX P1 point 2 (P-A): the seen markers of the rows the frontend adds
    /// for a loaded card whose state Rust never sees (a ship press that
    /// failed, a Builder waiting) — ids `card:<rule>:<card>:<round>`, kept in
    /// the same seen file, so Mark as seen works for them too. Additive: a
    /// feed without such rows sends an empty map.
    pub card_seen: BTreeMap<String, i64>,
}

/// P-A: the id prefix of the frontend's own card rows (`card_seen`).
pub const CARD_ROW_PREFIX: &str = "card:";

/// P-A (UX P1 point 2): the detail of the row a local ship stopped on a
/// conflict asks with — `cardPresentation.ts::SHIP_CONFLICT_INBOX_DETAIL`.
pub const SHIP_CONFLICT_DETAIL: &str = "ship stopped on a conflict";
/// 1.170.0 (G6): the start of the same row's detail for a conflict met
/// bringing in the target's changes ("conflict with main") —
/// `cardPresentation.ts::SYNC_CONFLICT_INBOX_PREFIX`.
pub const SYNC_CONFLICT_DETAIL_PREFIX: &str = "conflict with ";

/// The conflict row's detail: a ship's, or a bring-in's naming its branch.
fn conflict_detail(card: &KanbanCard) -> String {
    match card.ship_conflict.as_ref().filter(|c| c.sync) {
        Some(c) => {
            let branch = crate::ship_conflict::conflict_target(card, &c.branch);
            format!("{SYNC_CONFLICT_DETAIL_PREFIX}{branch}")
        }
        None => SHIP_CONFLICT_DETAIL.to_string(),
    }
}

/// 1.170.0 (G6, Challenger): a conflict a bring-in met asks the person
/// whatever the card's last run said (its Builder may never have finished a
/// turn since, or its session closed) — but not while a turn runs, nor on a
/// card whose row the success arm already gives.
fn sync_conflict_row(card: &KanbanCard) -> bool {
    card.review_status == Some(ReviewStatus::ConflictBlocked)
        && card.ship_conflict.as_ref().is_some_and(|c| c.sync)
        && !matches!(card.last_run_status, Some(LastRunStatus::Success) | Some(LastRunStatus::Running))
}
/// H8 Mac walk: a skill card's row while its workspace is cold
/// (`cardPresentation.ts::SKILL_CARD_READY_INBOX_DETAIL`).
pub const SKILL_CARD_READY_DETAIL: &str = "skill card ready to ship";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InboxProofCount {
    pub total: usize,
    pub eligible_unseen: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InboxEligibilityProof {
    pub generated_at: i64,
    pub licensed: bool,
    pub resolved_user_sha256: String,
    pub total_rows: usize,
    pub eligible_unseen_rows: usize,
    pub by_kind: BTreeMap<String, InboxProofCount>,
    pub by_group: BTreeMap<String, InboxProofCount>,
    pub eligible_unseen_set_sha256: String,
    pub target_present: Option<bool>,
    pub admitted_pr_targets: usize,
    pub successful_pr_sources: usize,
    pub failed_pr_sources: usize,
    pub pr_sources_complete: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxMarkAllSeenResult {
    pub proof: InboxEligibilityProof,
    pub marked_count: usize,
}

#[derive(Debug, Clone, Copy, Default)]
struct PrSourceSummary {
    admitted_targets: usize,
    successful_sources: usize,
    failed_sources: usize,
}

const ALL_INBOX_KINDS: [InboxEventKind; 29] = [
    InboxEventKind::ReviewNeeded,
    InboxEventKind::CardFailed,
    InboxEventKind::VerifyFailed,
    InboxEventKind::SkillChangeWaiting,
    InboxEventKind::RunDone,
    InboxEventKind::RunFailed,
    InboxEventKind::PrReview,
    InboxEventKind::Shipped,
    InboxEventKind::CardRunning,
    InboxEventKind::CardQueued,
    InboxEventKind::RunRunning,
    InboxEventKind::ScheduleUpcoming,
    InboxEventKind::PrChecksFailed,
    InboxEventKind::PrChangesRequested,
    InboxEventKind::PrConflict,
    InboxEventKind::PrReadyToMerge,
    InboxEventKind::PrHeadMoved,
    InboxEventKind::PrMerged,
    InboxEventKind::PrClosed,
    InboxEventKind::PrAutoFixStopped,
    InboxEventKind::BringUpToDate,
    InboxEventKind::SkillNeedsOk,
    InboxEventKind::LibraryAccessLost,
    InboxEventKind::SkillDecision,
    InboxEventKind::TeamPluginRefused,
    InboxEventKind::SharedSettingConflict,
    InboxEventKind::NextImprovementIdeas,
    InboxEventKind::Released,
    InboxEventKind::ReleaseStopped,
];

const ALL_INBOX_GROUPS: [InboxGroup; 6] = [
    InboxGroup::NeedsYou,
    InboxGroup::Running,
    InboxGroup::Shipped,
    InboxGroup::OnHold,
    InboxGroup::News,
    InboxGroup::Scheduled,
];

fn kind_name(kind: InboxEventKind) -> &'static str {
    match kind {
        InboxEventKind::ReviewNeeded => "review_needed",
        InboxEventKind::CardFailed => "card_failed",
        InboxEventKind::VerifyFailed => "verify_failed",
        InboxEventKind::SkillChangeWaiting => "skill_change_waiting",
        InboxEventKind::RunDone => "run_done",
        InboxEventKind::RunFailed => "run_failed",
        InboxEventKind::PrReview => "pr_review",
        InboxEventKind::Shipped => "shipped",
        InboxEventKind::CardRunning => "card_running",
        InboxEventKind::CardQueued => "card_queued",
        InboxEventKind::RunRunning => "run_running",
        InboxEventKind::ScheduleUpcoming => "schedule_upcoming",
        InboxEventKind::PrChecksFailed => "pr_checks_failed",
        InboxEventKind::PrChangesRequested => "pr_changes_requested",
        InboxEventKind::PrConflict => "pr_conflict",
        InboxEventKind::PrReadyToMerge => "pr_ready_to_merge",
        InboxEventKind::PrHeadMoved => "pr_head_moved",
        InboxEventKind::PrMerged => "pr_merged",
        InboxEventKind::PrClosed => "pr_closed",
        InboxEventKind::PrAutoFixStopped => "pr_auto_fix_stopped",
        InboxEventKind::BringUpToDate => "bring_up_to_date",
        InboxEventKind::SkillNeedsOk => "skill_needs_ok",
        InboxEventKind::LibraryAccessLost => "library_access_lost",
        InboxEventKind::SkillDecision => "skill_decision",
        InboxEventKind::TeamPluginRefused => "team_plugin_refused",
        InboxEventKind::SharedSettingConflict => "shared_setting_conflict",
        InboxEventKind::NextImprovementIdeas => "next_improvement_ideas",
        InboxEventKind::Released => "released",
        InboxEventKind::ReleaseStopped => "release_stopped",
    }
}

fn group_name(group: InboxGroup) -> &'static str {
    match group {
        InboxGroup::NeedsYou => "needs_you",
        InboxGroup::Running => "running",
        InboxGroup::Shipped => "shipped",
        InboxGroup::OnHold => "on_hold",
        InboxGroup::News => "news",
        InboxGroup::Scheduled => "scheduled",
    }
}

pub fn eligible_unseen_ids(events: &[InboxEvent]) -> Vec<String> {
    events
        .iter()
        .filter(|event| event.seen_eligible && event.seen_at.is_none())
        .map(|event| event.id.clone())
        .collect()
}

pub fn canonical_id_set_sha256(ids: &[String]) -> Result<String, String> {
    let mut sorted = ids.to_vec();
    if sorted.iter().any(|id| id.is_empty()) {
        return Err("inbox eligibility id must not be empty".into());
    }
    sorted.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
    if sorted.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err("inbox eligibility ids must be unique".into());
    }
    let mut framed = Vec::new();
    for id in sorted {
        framed.extend_from_slice(id.as_bytes());
        framed.push(b'\n');
    }
    Ok(format!("{:x}", Sha256::digest(&framed)))
}

fn sha256_text(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub fn user_key_sha256(user: &str) -> String {
    sha256_text(user)
}

pub fn is_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequiredInboxSet {
    Absent,
    Fixed(String),
    Invalid,
}

impl RequiredInboxSet {
    pub fn from_environment() -> Self {
        match std::env::var("PLY_INBOX_REQUIRED_SET_SHA256") {
            Err(std::env::VarError::NotPresent) => Self::Absent,
            Err(std::env::VarError::NotUnicode(_)) => Self::Invalid,
            Ok(value) if is_lower_sha256(&value) => Self::Fixed(value),
            Ok(_) => Self::Invalid,
        }
    }

    pub fn required_digest(&self) -> Result<Option<&str>, String> {
        match self {
            Self::Absent => Ok(None),
            Self::Fixed(digest) if is_lower_sha256(digest) => Ok(Some(digest)),
            Self::Fixed(_) | Self::Invalid => {
                Err("Inbox required-set constraint is invalid".into())
            }
        }
    }
}

fn eligibility_proof(
    events: &[InboxEvent],
    generated_at: i64,
    licensed: bool,
    resolved_user: &str,
    sources: PrSourceSummary,
    target_id_sha256: Option<&str>,
) -> Result<InboxEligibilityProof, String> {
    if let Some(target) = target_id_sha256 {
        if !is_lower_sha256(target) {
            return Err("inbox target hash must be 64 lowercase hex characters".into());
        }
    }

    let ids = eligible_unseen_ids(events);
    let mut by_kind = BTreeMap::new();
    for kind in ALL_INBOX_KINDS {
        by_kind.insert(
            kind_name(kind).to_string(),
            InboxProofCount {
                total: events.iter().filter(|event| event.kind == kind).count(),
                eligible_unseen: events
                    .iter()
                    .filter(|event| {
                        event.kind == kind && event.seen_eligible && event.seen_at.is_none()
                    })
                    .count(),
            },
        );
    }
    let mut by_group = BTreeMap::new();
    for group in ALL_INBOX_GROUPS {
        by_group.insert(
            group_name(group).to_string(),
            InboxProofCount {
                total: events.iter().filter(|event| event.group == group).count(),
                eligible_unseen: events
                    .iter()
                    .filter(|event| {
                        event.group == group && event.seen_eligible && event.seen_at.is_none()
                    })
                    .count(),
            },
        );
    }
    let target_present = target_id_sha256.map(|target| {
        ids.iter()
            .any(|id| sha256_text(id).as_bytes() == target.as_bytes())
    });
    Ok(InboxEligibilityProof {
        generated_at,
        licensed,
        resolved_user_sha256: user_key_sha256(resolved_user),
        total_rows: events.len(),
        eligible_unseen_rows: ids.len(),
        by_kind,
        by_group,
        eligible_unseen_set_sha256: canonical_id_set_sha256(&ids)?,
        target_present,
        admitted_pr_targets: sources.admitted_targets,
        successful_pr_sources: sources.successful_sources,
        failed_pr_sources: sources.failed_sources,
        pr_sources_complete: sources.failed_sources == 0,
    })
}

/// Resolve the per-user key for the seen store: the cached identity email
/// (v1.49.0, git-derived) or `"local"` when unset. App-support is already
/// per-macOS-user; the inner keying is belt-and-braces for future team-mode
/// merging (STEP1.md D3).
pub fn user_key(settings: &crate::settings::Settings) -> String {
    settings
        .identity
        .user_email
        .clone()
        .filter(|e| !e.trim().is_empty())
        .unwrap_or_else(|| "local".to_string())
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// Newest run reference on a card: the last `run_history` entry (system-
/// appended FIFO, newest last) or `linked_run_id`. The entry's `ended_at` is
/// the event time for review-needed/failed rows — kanban persists no
/// `column_changed_at` (STEP1.md resolved call #1); run-less manual cards
/// fall back to `updated_at` at the call site.
fn last_run_ref(card: &KanbanCard) -> (Option<String>, Option<i64>) {
    if let Some(entry) = card.run_history.last() {
        (Some(entry.run_id.clone()), Some(entry.ended_at))
    } else {
        (card.linked_run_id.clone(), None)
    }
}

/// QoL 1.168 (F1): the round a card row is about, for its id. A run's id
/// when the card has one; for a Builder card (no `run_history`) its latest
/// build snapshot — `n` and when it was recorded, so a later Finish and
/// check is a new row and is not "seen" already; `manual` otherwise. A
/// Finish and check on an unchanged tree keeps its snapshot, so it is the
/// same round.
fn card_round(card: &KanbanCard, run_id: Option<&str>) -> String {
    if let Some(id) = run_id {
        return id.to_string();
    }
    match card.builder.as_ref().and_then(|b| b.snapshots.last()) {
        Some(s) => format!("b{}-{}", s.n, s.at),
        None => "manual".to_string(),
    }
}

/// QoL 1.168 (F1): the seen time of a row under the id it had before rows
/// carried their round — `review:<card>:manual` for a ready or
/// changes-requested row, `failed:`/`conflict:<card>:manual` for those — when
/// that marker is no older than the round (the round's time from a Builder
/// round's `b<n>-<at>`, else the row's own time). So updating never makes a
/// row the person already saw look new, and a later round still does.
fn legacy_seen_at(id: &str, at: Option<i64>, seen_map: &HashMap<String, i64>) -> Option<i64> {
    let (prefix, rest) = id.split_once(':')?;
    let legacy_prefix = match prefix {
        "review" | "changes" => "review",
        "failed" => "failed",
        "conflict" => "conflict",
        _ => return None,
    };
    let (card, round) = rest.rsplit_once(':')?;
    if round == "manual" && prefix != "changes" {
        return None;
    }
    let seen_at = *seen_map.get(&format!("{legacy_prefix}:{card}:manual"))?;
    let round_at = round
        .strip_prefix('b')
        .and_then(|r| r.split_once('-'))
        .and_then(|(_, t)| t.parse::<i64>().ok())
        .or(at)?;
    (seen_at >= round_at).then_some(seen_at)
}

/// CL-3: the P1 findings still open on the card's review — from its findings
/// ledger once it has one, else the review's own blocking findings. Words and
/// weight only: the Inbox names them, nothing else changes.
fn open_p1_count(card: &KanbanCard) -> usize {
    let Some(review) = card.builder.as_ref().and_then(|b| b.review.as_ref()) else {
        return 0;
    };
    if !review.ledger.is_empty() {
        return review
            .ledger
            .iter()
            .filter(|finding| finding.is_open() && finding.blocks() && finding.severity.as_deref() == Some("P1"))
            .count();
    }
    review
        .findings
        .iter()
        .filter(|finding| !finding.pre_existing && finding.severity.as_deref() == Some("P1"))
        .count()
}

/// CL-3: the Inbox detail of a card whose review requests changes — "1
/// serious issue · changes requested" while a P1 is open, else the plain words.
/// Mirrors `attention.ts::changesRequestedDetail`.
fn changes_requested_detail(card: &KanbanCard) -> String {
    match open_p1_count(card) {
        0 => "changes requested — needs you".to_string(),
        1 => "1 serious issue · changes requested".to_string(),
        n => format!("{n} serious issues · changes requested"),
    }
}

fn card_is_landed(card: &KanbanCard) -> bool {
    card.ship_status == ShipStatus::Shipped || card.review_status == Some(ReviewStatus::Merged)
}

/// v1.154.1 (G2): the `card_running` row's detail when no session runs
/// the card (`inboxView.ts` words it).
pub const SESSION_ENDED_DETAIL: &str = "session ended";

/// 1.173.0 (F1, BI-7): the On hold row's detail of a card whose Builder was
/// working when Plyloft quit (`inboxView.ts` says "Paused when Plyloft
/// closed", with Resume).
pub const PAUSED_ON_CLOSE_DETAIL: &str = "paused when Plyloft closed";

/// 1.173.0 (F1, BI-7, owner D11): the run is still recorded as running, the
/// single Builder's session was lost on a restart (`lost_on_restart`, set by
/// the board's load), and no Resume ended at once. It asks nothing of the
/// person: On hold, not Needs you. A session the person closed (Aborted) or
/// one that ended by itself while Plyloft ran stays "Session closed".
/// A self-check that was under way is not paused: it asks for Finish and
/// check again (`cardPresentation.ts` rule `check-stopped`). Mirrors
/// `cardLifecycle.ts::pausedOnClose`.
fn paused_on_close(card: &KanbanCard) -> bool {
    card.last_run_status == Some(LastRunStatus::Running)
        && card.linked_run_id.is_none()
        && card.linked_swarm_id.is_none()
        && !crate::build_both::is_undecided(card)
        && card.builder.as_ref().is_some_and(|b| {
            b.pty_id.is_none()
                && b.lost_on_restart
                && !b.resume_failed
                // Challenger 3: a Finish and check that Plyloft's quit cut
                // short asks for Finish and check again — Needs you.
                && b.self_check_started_at.is_none()
        })
}

/// v1.154.1 (walk J5, G2): a card recorded as running whose Builder session
/// is gone — its own Builder with no live PTY, or both builds of an
/// undecided Build with both. Mirrors `cardLifecycle.ts::builderSessionClosed`.
/// F11: a single Builder's card whose session was closed or ended — its run
/// is recorded as Aborted (`builder::apply_close`), and it reads as "Session
/// ended" with Resume, not as a failed run. Mirrors
/// `cardLifecycle.ts::builderSessionClosed`.
fn builder_session_closed(card: &KanbanCard) -> bool {
    card.last_run_status == Some(LastRunStatus::Aborted)
        // A swarm's or an agent run's abort is that run's, and a failure.
        && card.linked_run_id.is_none()
        && card.linked_swarm_id.is_none()
        && !crate::build_both::is_undecided(card)
        && card.builder.as_ref().is_some_and(|b| b.pty_id.is_none())
}

fn card_session_ended(card: &KanbanCard) -> bool {
    if let Some(bb) = card.build_both.as_ref().filter(|bb| bb.outcome.is_none()) {
        return crate::build_both::sessions_ended(bb);
    }
    card.builder.as_ref().is_some_and(|b| b.pty_id.is_none())
}

/// Round 3: the pick a card built by both waits on, in words.
fn both_pick_words(card: &KanbanCard) -> Option<String> {
    card.build_both.as_ref().and_then(crate::build_both::pick_words)
}

/// The session-ended row's id part: when the card's Builder (or the latest
/// of its two builds) started, so a later session's end is a new row, not
/// one already seen.
fn session_started_at(card: &KanbanCard) -> i64 {
    if let Some(bb) = card.build_both.as_ref().filter(|bb| bb.outcome.is_none()) {
        return bb.lanes.iter().filter_map(|l| l.started_at).max().unwrap_or(bb.started_at);
    }
    card.builder.as_ref().map(|b| b.started_at).unwrap_or(0)
}

/// GH #243: a card in Complete that never ran, has no checks on record and
/// never landed — GitHub sync pulls a closed issue's card there. It is
/// history, not a decision: the Board shows it in Done as "Closed", so the
/// Inbox does not ask about it. Mirrors `cardLifecycle.ts::deriveCardState`'s
/// `closed` case.
fn card_is_closed_without_work(card: &KanbanCard) -> bool {
    card.column_id == KanbanColumnId::Complete
        && card.last_run_status.is_none()
        && matches!(card.verify_status, VerifyStatus::None | VerifyStatus::Legacy)
        && !card_is_landed(card)
}

/// GH #269: the Inbox's short fact for a failed verify run — the failed
/// step in words when one failed ("Rust tests"), else "2 of 4" — or None
/// when the run recorded no steps. The run's raw summary is not the Inbox's.
fn verify_failed_fact(entry: &VerifyEntry) -> Option<String> {
    let total = entry.steps.len();
    let failed: Vec<&str> = entry
        .steps
        .iter()
        .filter(|s| !s.passed)
        .map(|s| s.kind.as_str())
        .collect();
    match failed.as_slice() {
        [] => None,
        [one] => Some(
            verify_step_words(one)
                .map(str::to_string)
                .unwrap_or_else(|| format!("1 of {total}")),
        ),
        many => Some(format!("{} of {total}", many.len())),
    }
}

/// A verify step's kind in words.
fn verify_step_words(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "cargo-test" => "Rust tests",
        "npm-test" => "npm tests",
        "ppvp-sh" => "Project checks",
        "tauri-build" => "App build",
        "claude-qa" => "Claude's review",
        "shell" => "Custom check",
        _ => return None,
    })
}

/// SL-1: the Inbox rows a card's pull request on GitHub makes, from what the
/// card last read of it (`KanbanCard::pr`). While it is open and the card's
/// work is in it: failed checks on GitHub, a request for changes (with its
/// text), a conflict; ready to merge (1.169.1, R1). Closed without merging, and not shipped again since: the
/// card is back to review, and this row says why (it stands in for the plain
/// "review it" row). Ids are keyed by the PR's head, review and close, so a
/// seen row stays seen and a new failure is a new row. Returns whether the
/// closed row was added.
fn pr_events(
    card: &KanbanCard,
    base: &dyn Fn(InboxEventKind, InboxGroup, String) -> InboxEvent,
    events: &mut Vec<InboxEvent>,
) -> bool {
    let (Some(pr), Some(url)) = (card.pr.as_ref(), card.pr_url.as_ref()) else {
        return false;
    };
    let head = pr.head_sha.as_deref().unwrap_or("unknown");
    let n = pr.number;
    match pr.state {
        // v1.154.1 (F11): from the PR's own state, not `review_status` (the
        // review loop writes it too, during a fix round).
        PrState::Open if card.ship_status != ShipStatus::Shipped => {
            if pr.checks == PrChecks::Failing {
                let mut ev = base(
                    InboxEventKind::PrChecksFailed,
                    InboxGroup::NeedsYou,
                    format!("pr-checks:{}:{n}:{head}", card.id),
                );
                ev.at = pr.checked_at.or(Some(card.updated_at));
                let names: Vec<String> = pr.failing_checks.iter().map(|c| c.label()).collect();
                ev.detail = (!names.is_empty()).then(|| names.join(", "));
                ev.url = Some(url.clone());
                events.push(ev);
            }
            // G7: where "Fix failing checks by itself" stopped, while the
            // pull request is still at that head.
            if let Some(stop) = crate::pr_auto_fix::stopped_now(pr) {
                // G7 fixes (M1): a live Builder whose card isn't shown is a
                // wait for the person (open the card), not a failure — the
                // reason says which (`inboxView.ts::isFailureRow`); both are
                // Needs you since F1.
                let mut ev = base(
                    InboxEventKind::PrAutoFixStopped,
                    InboxGroup::NeedsYou,
                    format!("pr-autofix:{}:{n}:{}:{}", card.id, stop.head, stop.reason),
                );
                ev.at = Some(stop.at);
                ev.detail = Some(stop.reason.clone());
                ev.url = Some(url.clone());
                events.push(ev);
            }
            if pr.review_decision == PrReviewDecision::ChangesRequested {
                let review = pr.changes_requested.as_ref();
                let mut ev = base(
                    InboxEventKind::PrChangesRequested,
                    InboxGroup::NeedsYou,
                    format!(
                        "pr-review:{}:{n}:{}",
                        card.id,
                        review.and_then(|r| r.submitted_at).unwrap_or(0)
                    ),
                );
                ev.at = review.and_then(|r| r.submitted_at).or(pr.checked_at);
                ev.detail = review.map(|r| r.body.clone()).filter(|b| !b.is_empty());
                ev.url = Some(url.clone());
                events.push(ev);
            }
            if pr.mergeable == PrMergeable::Conflicting {
                let mut ev = base(
                    InboxEventKind::PrConflict,
                    InboxGroup::NeedsYou,
                    format!("pr-conflict:{}:{n}:{head}", card.id),
                );
                ev.at = pr.checked_at.or(Some(card.updated_at));
                ev.url = Some(url.clone());
                events.push(ev);
            }
            // G1–G3 Challenger (2): commits on GitHub Plyloft didn't push —
            // the person looks first (never "ready", never merged by
            // itself). Keyed by GitHub's head: another push is a new row.
            if pr.head_moved() {
                let mut ev = base(
                    InboxEventKind::PrHeadMoved,
                    InboxGroup::NeedsYou,
                    format!("pr-moved:{}:{n}:{head}", card.id),
                );
                ev.at = pr.checked_at.or(Some(card.updated_at));
                ev.detail = Some(crate::pr_merge::HEAD_MOVED_LINE.to_string());
                ev.url = Some(url.clone());
                events.push(ev);
            }
            // 1.169.1 (R1): a pull request ready to merge asks for its Merge
            // (a review GitHub requires first is On hold: nothing to row).
            // Keyed by the head: a new push that is ready again is a new row.
            if crate::pr_status::card_ready_to_merge(card) {
                let mut ev = base(
                    InboxEventKind::PrReadyToMerge,
                    InboxGroup::NeedsYou,
                    format!("pr-ready:{}:{n}:{head}", card.id),
                );
                ev.at = pr.checked_at.or(Some(card.updated_at));
                ev.detail = (pr.checks == PrChecks::None)
                    .then(|| crate::pr_status::READY_NO_CHECKS_DETAIL.to_string());
                ev.url = Some(url.clone());
                events.push(ev);
            }
            false
        }
        PrState::Closed
            if card.review_status != Some(ReviewStatus::Merged)
                && card.ship_status != ShipStatus::Shipped =>
        {
            let mut ev = base(
                InboxEventKind::PrClosed,
                InboxGroup::NeedsYou,
                format!("pr-closed:{}:{n}:{}", card.id, pr.closed_at.unwrap_or(0)),
            );
            ev.at = pr.closed_at.or(pr.checked_at);
            ev.detail = Some(format!("#{n}"));
            ev.url = Some(url.clone());
            events.push(ev);
            true
        }
        // G5: merged, and this computer's target is still behind GitHub's.
        // Challenger 4: one only the person can settle (its target has
        // commits of its own) has nothing to press — the Done card says it.
        PrState::Merged => {
            if let Some(words) = pr.up_to_date_refused.as_ref().filter(|_| !pr.up_to_date_no_press) {
                let merged = pr.merge_commit.as_deref().unwrap_or(head);
                let mut ev = base(
                    InboxEventKind::BringUpToDate,
                    InboxGroup::NeedsYou,
                    format!("up-to-date:{}:{n}:{merged}", card.id),
                );
                ev.at = pr.merged_at.or(pr.checked_at);
                ev.detail = Some(words.clone());
                ev.url = Some(url.clone());
                events.push(ev);
            }
            false
        }
        _ => false,
    }
}

/// 1.174.0 (DR4): the workspace's recorded release, when only the person
/// can move it on: a problem ("site-v3.0.2 stopped" · the problem), or
/// (round 1) GitHub's checks failed on its pull request ("site-v3.0.2 is
/// waiting" · "GitHub's checks failed"). The id carries a short hash of why,
/// so a new stop is a new row, unseen again.
pub(crate) fn release_stopped_event(projects_root: &Path, ws: &crate::workspace::Workspace) -> Option<InboxEvent> {
    let record = crate::release_record::load(&projects_root.join(&ws.id)).ok().flatten()?;
    let root = crate::ship::resolve_workspace_repo_root(&ws.cwd).ok()?;
    let view = crate::release_record::view(&root, record);
    let tag = view.record.tag.clone();
    // DR4 round 2: only before the merge — a flag a later step left is no ask.
    let checks_failed = view.record.pr.as_ref().is_some_and(|pr| {
        pr.checks_failed
            && !matches!(pr.step, crate::release_record::PrReleaseStep::Merged | crate::release_record::PrReleaseStep::Tagged)
    });
    let (title, detail) = match view.problem.clone() {
        Some(problem) => (format!("{tag} stopped"), truncate_chars(problem.trim(), 160)),
        None if checks_failed => (format!("{tag} is waiting"), "GitHub's checks failed".to_string()),
        None => return None,
    };
    let why = sha256_text(&format!("{detail}|{:?}", view.record.pr.as_ref().map(|pr| pr.head.clone())));
    Some(InboxEvent {
        id: format!("release-stopped:{}:{tag}:{}", ws.id, &why[..8]),
        kind: InboxEventKind::ReleaseStopped,
        group: InboxGroup::NeedsYou,
        workspace_id: ws.id.clone(),
        workspace_name: ws.name.clone(),
        card_id: None,
        run_id: None,
        title,
        detail: Some(detail),
        url: view.record.pr.as_ref().and_then(|pr| pr.url.clone()),
        at: None,
        seen_at: None,
        seen_eligible: true,
    })
}

/// 1.174.0 (DR4 round 1): the releases this computer finished
/// (`release_record::load_released`) say themselves — one that carried no
/// card included ("site-v3.0.2 released · 2 other changes"); the rows the
/// cards' entries made are given the log's words.
fn apply_release_log(events: &mut Vec<InboxEvent>, projects_root: &Path, ws: &crate::workspace::Workspace, window_start: i64) {
    for entry in crate::release_record::load_released(&projects_root.join(&ws.id)) {
        if entry.at < window_start {
            continue;
        }
        let id = format!("release:{}:{}", ws.id, entry.tag);
        let (card_id, detail) = match (entry.cards, entry.card_id.clone(), entry.card_title.clone()) {
            (1, Some(id), Some(title)) => (Some(id), title),
            (0, _, _) => (None, if entry.other_changes == 1 { "1 other change".to_string() } else { format!("{} other changes", entry.other_changes) }),
            (n, _, _) => (None, if n == 1 { "1 card".to_string() } else { format!("{n} cards") }),
        };
        if let Some(ev) = events.iter_mut().find(|e| e.id == id) {
            ev.detail = Some(detail);
            ev.card_id = card_id;
            continue;
        }
        events.push(InboxEvent {
            id,
            kind: InboxEventKind::Released,
            group: InboxGroup::Shipped,
            workspace_id: ws.id.clone(),
            workspace_name: ws.name.clone(),
            card_id,
            run_id: None,
            title: format!("{} released", entry.tag),
            detail: Some(detail),
            url: None,
            at: Some(entry.at),
            seen_at: None,
            seen_eligible: true,
        });
    }
}

/// Derive every card-sourced event for one workspace's board. Pure — takes
/// slices, no I/O — so it unit-tests over fixtures (STEP1.md workstream A).
pub fn derive_card_events(
    workspace_name: &str,
    cards: &[KanbanCard],
    window_start: i64,
) -> Vec<InboxEvent> {
    let mut events = Vec::new();
    // 1.174.0 (DR4): the releases in the window, one row each: tag → (when,
    // how many cards).
    let mut releases: std::collections::BTreeMap<String, (i64, Vec<(String, String)>)> = std::collections::BTreeMap::new();
    for card in cards {
        let base = |kind: InboxEventKind, group: InboxGroup, id: String| InboxEvent {
            id,
            kind,
            group,
            workspace_id: card.workspace_id.clone(),
            workspace_name: workspace_name.to_string(),
            card_id: Some(card.id.clone()),
            run_id: None,
            title: card.title.clone(),
            detail: None,
            url: None,
            at: None,
            seen_at: None,
            seen_eligible: true,
        };

        // Ship history is real history: windowed, and emitted even for
        // archived cards (archiving declutters the board; the ship happened).
        for entry in &card.ship_history {
            if entry.shipped_at < window_start {
                continue;
            }
            // 1.174.0 (DR4): a release's entry is its release's row.
            if let Some(tag) = entry.tag.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
                let r = releases.entry(tag.to_string()).or_insert((entry.shipped_at, Vec::new()));
                r.0 = r.0.max(entry.shipped_at);
                if !r.1.iter().any(|(id, _)| id == &card.id) {
                    r.1.push((card.id.clone(), card.title.clone()));
                }
                continue;
            }
            // SL-1: the entry a merged pull request wrote says so (same id).
            let merged_pr = card.pr.as_ref().filter(|pr| {
                pr.state == PrState::Merged
                    && !entry.commit_sha.is_empty()
                    && (pr.merge_commit.as_deref() == Some(entry.commit_sha.as_str())
                        || pr.head_sha.as_deref() == Some(entry.commit_sha.as_str()))
            });
            let mut ev = base(
                if merged_pr.is_some() {
                    InboxEventKind::PrMerged
                } else {
                    InboxEventKind::Shipped
                },
                InboxGroup::Shipped,
                format!("ship:{}:{}", card.id, entry.commit_sha),
            );
            ev.at = Some(entry.shipped_at);
            ev.detail = Some(match merged_pr {
                Some(pr) => format!("#{}", pr.number),
                None => entry.shipped_version.clone(),
            });
            if merged_pr.is_some() {
                ev.url = card.pr_url.clone();
            }
            events.push(ev);
        }

        // Archive is the universal terminal state for attention — it
        // *resolves* every needs-you/failed/running row below.
        if card.archived {
            continue;
        }

        // Challenger on a pull request (P2-4): what its review asks — not
        // reviewed yet, new commits, a review that didn't finish, changes
        // requested, a fix ready to push (`pr_review::inbox_ask`). Merged
        // or closed, or approved with nothing to push, asks nothing. Only
        // a Builder session fixing it says more, as on any card.
        if card.pr_review.is_some() {
            if let Some((key, detail)) = crate::pr_review::inbox_ask(card) {
                let mut ev = base(
                    InboxEventKind::ReviewNeeded,
                    InboxGroup::NeedsYou,
                    format!("pr-review:{}:{key}", card.id),
                );
                ev.at = Some(card.updated_at);
                ev.detail = Some(detail);
                ev.url = card.pr_review.as_ref().map(|p| p.url.clone());
                events.push(ev);
            }
            if card.last_run_status != Some(LastRunStatus::Running) {
                continue;
            }
        }
        let landed = card_is_landed(card);
        // 1.175.0 (D3): a part of its issue both this computer and GitHub
        // changed — the card asks which version it keeps.
        if let Some(detail) = crate::issue_edit::inbox_detail(card).filter(|_| !landed && card.pr_review.is_none()) {
            let mut ev = base(InboxEventKind::ReviewNeeded, InboxGroup::NeedsYou, format!("edit:{}", card.id));
            ev.at = Some(card.updated_at);
            ev.detail = Some(detail.to_string());
            events.push(ev);
        }
        let (run_id, run_ended_at) = last_run_ref(card);
        let round = card_round(card, run_id.as_deref());
        // SL-1: what the card's pull request on GitHub asks of the person.
        let pr_closed = pr_events(card, &base, &mut events);
        let changes_requested = card.pr_review.is_none()
            && !landed
            && card.review_status == Some(ReviewStatus::ChangesRequested);

        if changes_requested {
            let mut ev = base(
                InboxEventKind::ReviewNeeded,
                InboxGroup::NeedsYou,
                // F1: its own prefix and round — never the id of the
                // "ready" row before it, nor of the round before.
                format!("changes:{}:{round}", card.id),
            );
            ev.run_id = run_id.clone();
            ev.at = Some(run_ended_at.unwrap_or(card.updated_at));
            ev.detail = Some(changes_requested_detail(card));
            events.push(ev);
        } else {
            if sync_conflict_row(card) && !landed && !pr_closed {
                let mut ev = base(
                    InboxEventKind::ReviewNeeded,
                    InboxGroup::NeedsYou,
                    format!("conflict:{}:{round}", card.id),
                );
                ev.run_id = run_id.clone();
                ev.at = Some(card.updated_at);
                ev.detail = Some(conflict_detail(card));
                events.push(ev);
            }
            match card.last_run_status {
                Some(LastRunStatus::Failed)
                | Some(LastRunStatus::Aborted)
                | Some(LastRunStatus::RateLimited)
                    if !landed && !builder_session_closed(card) =>
                {
                    let mut ev = base(
                        InboxEventKind::CardFailed,
                        InboxGroup::NeedsYou,
                        format!(
                            "failed:{}:{round}",
                            card.id,
                        ),
                    );
                    ev.run_id = run_id.clone();
                    ev.at = Some(run_ended_at.unwrap_or(card.updated_at));
                    ev.detail = Some(
                        match card.last_run_status {
                            Some(LastRunStatus::Aborted) => "aborted",
                            Some(LastRunStatus::RateLimited) => "rate-limited",
                            _ => "failed",
                        }
                        .to_string(),
                    );
                    events.push(ev);
                }
                Some(LastRunStatus::Success) if !landed && !pr_closed => {
                    // P-A (UX P1 point 2): a local ship that stopped on a
                    // conflict needs the person, as the Board and the card
                    // say ("Ship stopped on a conflict"). Its id is new, so
                    // the seen file keeps working.
                    if card.review_status == Some(ReviewStatus::ConflictBlocked) {
                        let mut ev = base(
                            InboxEventKind::ReviewNeeded,
                            InboxGroup::NeedsYou,
                            format!(
                                "conflict:{}:{round}",
                                card.id,
                            ),
                        );
                        ev.run_id = run_id.clone();
                        ev.at = Some(run_ended_at.unwrap_or(card.updated_at));
                        ev.detail = Some(conflict_detail(card));
                        events.push(ev);
                    }
                    // Mirrors attention.ts::cardWantsYou — success pending
                    // review wants you; changes-requested is handled above.
                    if matches!(card.review_status, None | Some(ReviewStatus::Pending)) {
                        let mut ev = base(
                            InboxEventKind::ReviewNeeded,
                            InboxGroup::NeedsYou,
                            format!(
                                "review:{}:{round}",
                                card.id,
                            ),
                        );
                        ev.run_id = run_id.clone();
                        ev.at = Some(run_ended_at.unwrap_or(card.updated_at));
                        // H8 Mac walk: a skill card Plyloft wrote (into a
                        // cold workspace's board, say) is ready to ship, as
                        // its Board says once loaded — not "review it".
                        if matches!(card.kind, Some(crate::kanban::CardKind::Skill(_)))
                            && card.verify_status == VerifyStatus::Passed
                        {
                            ev.detail = Some(SKILL_CARD_READY_DETAIL.to_string());
                        }
                        events.push(ev);
                    }
                }
                // v1.154.1 round 3 (walk RW-B step 10): built by both, the
                // comparison settled — the person picks, as the Board says.
                Some(LastRunStatus::Running) if both_pick_words(card).is_some() => {
                    let mut ev = base(
                        InboxEventKind::CardRunning,
                        InboxGroup::NeedsYou,
                        format!(
                            "pick:{}:{}",
                            card.id,
                            card.build_both.as_ref().and_then(|bb| bb.compare.as_ref()).map_or(0, |c| c.started_at)
                        ),
                    );
                    ev.at = Some(card.updated_at);
                    ev.detail = both_pick_words(card);
                    events.push(ev);
                }
                // v1.154.1 (walk J5, G2): recorded as running, but no
                // session runs it (after a relaunch, or it exited) — the
                // Board says "Session ended" and puts it in Needs you; so
                // does the Inbox, not Running.
                // F11: a Builder session closed (or ended) records its run as
                // Aborted; it is still the same "Session ended" row.
                Some(LastRunStatus::Running) | Some(LastRunStatus::Aborted)
                    if card_session_ended(card)
                        && (card.last_run_status == Some(LastRunStatus::Running)
                            || (!landed && builder_session_closed(card))) =>
                {
                    // F1: one Plyloft's quit paused is On hold (same id).
                    let paused = paused_on_close(card);
                    let mut ev = base(
                        InboxEventKind::CardRunning,
                        if paused { InboxGroup::OnHold } else { InboxGroup::NeedsYou },
                        format!("session-ended:{}:{}", card.id, session_started_at(card)),
                    );
                    ev.at = Some(card.updated_at);
                    ev.detail = Some(
                        if paused { PAUSED_ON_CLOSE_DETAIL } else { SESSION_ENDED_DETAIL }.to_string(),
                    );
                    events.push(ev);
                }
                Some(LastRunStatus::Running) => {
                    let mut ev = base(
                        InboxEventKind::CardRunning,
                        InboxGroup::Running,
                        format!("running:{}", card.id),
                    );
                    ev.at = Some(card.updated_at);
                    ev.seen_eligible = false;
                    events.push(ev);
                }
                _ => {}
            }
        }

        // Verify failure is its own signal — `last_run_status` can be Success
        // while the verify pipeline failed.
        if !changes_requested && !landed && card.verify_status == VerifyStatus::Failed {
            let entry = card
                .verify_history
                .iter()
                .rev()
                .find(|e| e.status == VerifyStatus::Failed);
            let mut ev = base(
                InboxEventKind::VerifyFailed,
                InboxGroup::NeedsYou,
                format!(
                    "verify:{}:{}",
                    card.id,
                    entry.map(|e| e.verify_run_id.as_str()).unwrap_or("unknown")
                ),
            );
            ev.at = Some(entry.map(|e| e.ended_at).unwrap_or(card.updated_at));
            // GH #269: one short fact from the steps, never the raw summary
            // (`verify failed: <script tail>`), which stays on the card.
            ev.detail = entry.and_then(verify_failed_fact);
            events.push(ev);
        }

        // A card manually placed in Complete still needs an explicit human
        // decision even when no successful run created a review receipt.
        // Preserve the legacy success event id above; this new id is only for
        // the manual-complete case.
        let successful_work_awaits_review = card.last_run_status == Some(LastRunStatus::Success)
            && matches!(card.review_status, None | Some(ReviewStatus::Pending));
        // P-A: a success stopped on a conflict has its own row above.
        let conflict_row = (card.last_run_status == Some(LastRunStatus::Success)
            && card.review_status == Some(ReviewStatus::ConflictBlocked)
            || sync_conflict_row(card))
            && !pr_closed;
        if !landed
            && !conflict_row
            && !changes_requested
            && !pr_closed
            && card.column_id == KanbanColumnId::Complete
            && !successful_work_awaits_review
            && !card_is_closed_without_work(card)
        {
            let mut ev = base(
                InboxEventKind::ReviewNeeded,
                InboxGroup::NeedsYou,
                format!("review:{}:manual", card.id),
            );
            ev.at = Some(card.updated_at);
            ev.detail = Some("complete — decide what happens next".to_string());
            events.push(ev);
        }

        // Derived card-swarm queue (v1.30.0): waiting for a slot. F1
        // (Challenger 6): On hold, where the Board has it.
        if card_is_queue_eligible(card) && card.last_run_status != Some(LastRunStatus::Running) {
            let mut ev = base(
                InboxEventKind::CardQueued,
                InboxGroup::OnHold,
                format!("queued:{}", card.id),
            );
            ev.at = Some(card.updated_at);
            ev.detail = Some("queued".to_string());
            ev.seen_eligible = false;
            events.push(ev);
        }
    }
    if let Some(first) = cards.first() {
        for (tag, (at, carried)) in releases {
            // DR4 round 1: with one card, that card (its title, its press).
            let (card_id, detail) = match carried.as_slice() {
                [(id, title)] => (Some(id.clone()), title.clone()),
                many => (None, format!("{} cards", many.len())),
            };
            events.push(InboxEvent {
                id: format!("release:{}:{tag}", first.workspace_id),
                kind: InboxEventKind::Released,
                group: InboxGroup::Shipped,
                workspace_id: first.workspace_id.clone(),
                workspace_name: workspace_name.to_string(),
                card_id,
                run_id: None,
                title: format!("{tag} released"),
                detail: Some(detail),
                url: None,
                at: Some(at),
                seen_at: None,
                seen_eligible: true,
            });
        }
    }
    events
}

/// GH #104 (BOARDS.md §4 state C): the Inbox item for the Challenger's one
/// suggested change — `A suggested skill change is waiting — deploy` / `After card #88 ·
/// <workspace>`, and the same sentence with its own noun for an instruction
/// file. Its words are `lib/proposals.ts::proposalInboxItem`, tested there; the
/// title and detail here are the halves it composes, so one string lives in one
/// place.
///
/// `projects_root` is `<config_dir>/projects`, and the proposal is read from
/// `<ws>/improvement_proposal.json` — one small file per workspace, like the
/// board itself. The staleness rules are **not** applied here: the row leads to
/// the Library page, and that page's read is the one that drops a stale
/// proposal, once. A row for a proposal the page then drops is the same
/// transient as a card row for a card a refresh has just archived.
fn derive_proposal_events(
    projects_root: &Path,
    workspaces: &[crate::workspace::Workspace],
) -> Vec<InboxEvent> {
    let mut events = Vec::new();
    for ws in workspaces {
        let file = crate::proposals::load(&projects_root.join(&ws.id));
        let Some(proposal) = file.proposal else {
            continue;
        };
        let instructions = matches!(
            proposal.target,
            crate::proposals::ProposalTarget::Instructions { .. }
        );
        let label = proposal.target.label();
        events.push(InboxEvent {
            // Stable, and one per workspace: there is at most one proposal.
            id: format!("proposal:{}", ws.id),
            kind: InboxEventKind::SkillChangeWaiting,
            group: InboxGroup::NeedsYou,
            workspace_id: ws.id.clone(),
            workspace_name: ws.name.clone(),
            card_id: Some(proposal.card_id.clone()),
            run_id: None,
            title: if instructions {
                format!("A suggested change to {label} is waiting")
            } else {
                format!("A suggested skill change is waiting — {label}")
            },
            detail: Some(format!("After card {} · {}", proposal.card_ref, ws.name)),
            url: None,
            at: Some(proposal.created_at),
            seen_at: None,
            seen_eligible: true,
        });
    }
    events
}

/// 1.173.0 (C3): one Needs-you row per shared setting waiting for the
/// person's choice, read from each workspace's publish queue — so the
/// question waits here while Plyloft is hidden or the person is elsewhere.
pub(crate) fn derive_setting_conflict_events(
    projects_root: &Path,
    workspaces: &[crate::workspace::Workspace],
) -> Vec<InboxEvent> {
    let mut events = Vec::new();
    for ws in workspaces {
        let path = projects_root.join(&ws.id).join(crate::shared_config::QUEUE_FILENAME);
        let definition = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<crate::shared_config::PublishQueue>(&bytes).ok())
            .map(|queue| crate::setting_conflict::conflicts_of(&queue))
            .unwrap_or_default();
        // 1.173.0 (E1): a Next improvement direction field asks the same way.
        let directions = crate::next_improvement::setting_conflicts_in(&projects_root.join(&ws.id));
        for conflict in definition.into_iter().chain(directions) {
            events.push(InboxEvent {
                id: crate::setting_conflict::inbox_id(&ws.id, &conflict),
                kind: InboxEventKind::SharedSettingConflict,
                group: InboxGroup::NeedsYou,
                workspace_id: ws.id.clone(),
                workspace_name: ws.name.clone(),
                card_id: None,
                run_id: None,
                title: crate::setting_conflict::inbox_title(&conflict),
                detail: Some("Choose which value the repository keeps".to_string()),
                url: None,
                at: conflict.changed_at.map(|secs| secs * 1000),
                seen_at: None,
                seen_eligible: true,
            });
        }
    }
    events
}

/// 1.175.0 B2 (SEC-4): one Needs-you row per workspace whose finished
/// release waits for this computer's OK to run its install step
/// (`checks_consent::InstallWaiting`, in `worktree_setup.json`). Its id is
/// `install-ok:<ws>:<tag>`; the row opens the sheet ("Decide"). Filed under
/// the shared-setting kind: it is a question about a shared setting this
/// computer hasn't agreed to, and the count treats it as one.
pub(crate) fn derive_install_ok_events(
    projects_root: &Path,
    workspaces: &[crate::workspace::Workspace],
) -> Vec<InboxEvent> {
    let mut events = Vec::new();
    for ws in workspaces {
        let path = projects_root.join(&ws.id).join(crate::worktree_setup::SETTINGS_FILENAME);
        let Some(settings) = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<crate::worktree_setup::WorktreeSettings>(&bytes).ok())
        else {
            continue;
        };
        let Some(waiting) = settings.install_waiting else { continue };
        // Round 2 (G5): on a new clone nobody changed anything.
        let first_time = settings.approved_install.as_ref().is_none_or(|approved| approved.path.is_none());
        let who = settings.install_changed.and_then(|note| note.who).unwrap_or_else(|| "Someone".to_string());
        events.push(InboxEvent {
            id: format!("install-ok:{}:{}", ws.id, waiting.tag.as_deref().unwrap_or("")),
            kind: InboxEventKind::SharedSettingConflict,
            group: InboxGroup::NeedsYou,
            workspace_id: ws.id.clone(),
            workspace_name: ws.name.clone(),
            card_id: None,
            run_id: None,
            title: match &waiting.tag {
                Some(tag) => format!("{tag}'s install step needs your OK"),
                None => "The install step needs your OK".to_string(),
            },
            detail: Some(if first_time {
                format!("\u{201c}After a release, run\u{201d} hasn't run on {} before", crate::platform::THIS_MACHINE)
            } else {
                format!("{who} changed \u{201c}After a release, run\u{201d}")
            }),
            url: None,
            at: Some(waiting.at).filter(|at| *at > 0),
            seen_at: None,
            seen_eligible: true,
        });
    }
    events
}

/// The row's words; `inboxView.ts::nextImprovementRowWords` says the same.
pub(crate) fn next_improvement_row_title(area_name: &str, ideas: usize) -> String {
    let n = if ideas == 1 { "1 idea".to_string() } else { format!("{ideas} ideas") };
    let area = area_name.trim();
    if area.is_empty() {
        format!("Next improvement: {n}")
    } else {
        format!("Next improvement for {area}: {n}")
    }
}

/// 1.173.0 (E3): one row per area whose latest Next improvement
/// round has ideas waiting (`projects/<ws>/next_improvement/<area>.json`,
/// this Mac's): not still proposing (ready, or ended early with its ideas,
/// or with a change under way) — or proposing with ideas carried from the
/// last round (1.174.0, C15) — and at least one idea still unanswered —
/// neither made a card nor set aside by the person. Making one idea a card
/// doesn't answer the others (1.173.0 walk): the row stays, counting the
/// unanswered ones. 1.174.0 (A5, P10, D4 b): a News row, never counted
/// (`needsYou.ts::countedFeedRow`); seen, it stays grayed until every idea
/// is answered. Its detail is the round's byline ("Claude proposed, Codex
/// gave a second opinion"). Its id carries the round, so a new round is a
/// new row, unseen again: `next-improvement:<ws>:<area>:<round>`.
pub(crate) fn derive_next_improvement_events(
    projects_root: &Path,
    workspaces: &[crate::workspace::Workspace],
) -> Vec<InboxEvent> {
    use crate::next_improvement::round::{self, RoundStatus};
    let mut events = Vec::new();
    for ws in workspaces {
        let Ok(dir) = round::round_dir(projects_root, &ws.id) else { continue };
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut files: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "json"))
            .collect();
        files.sort();
        for path in files {
            let Some(area) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else { continue };
            let Some(current) = round::read_only(&path).and_then(|f| f.current) else { continue };
            // A round that ended early (stopped, timed out, interrupted)
            // keeps the ideas it had, and so does one with a change under
            // way: they still wait. A round still proposing has none yet.
            // 1.174.0 (C15): a round still proposing holds the last round's
            // unanswered ideas, which still wait; the row counts both.
            let proposing = current.status == RoundStatus::Running && current.change.is_none();
            let open = current.ideas.iter().filter(|i| i.unanswered() && (!proposing || i.carried_from.is_some())).count();
            if open == 0 {
                continue;
            }
            events.push(InboxEvent {
                id: format!("next-improvement:{}:{area}:{}", ws.id, current.id),
                kind: InboxEventKind::NextImprovementIdeas,
                group: InboxGroup::News,
                workspace_id: ws.id.clone(),
                workspace_name: ws.name.clone(),
                card_id: None,
                run_id: None,
                title: next_improvement_row_title(&current.area_name, open),
                detail: Some(round::byline(&current)),
                url: None,
                at: current.ended_at.or(Some(current.started_at)).filter(|t| *t > 0),
                seen_at: None,
                seen_eligible: true,
            });
        }
    }
    events
}

/// Skills hub H6a (R14): one Needs-you row per team-library skill whose
/// scripts wait for an OK on this Mac. The team library reaches every
/// workspace, so the row is filed under the active workspace (or the first),
/// whose Library opens on it. Its id is `skill:<origin>/<skill>:needs-ok:<ids>`
/// — stable while the scripts are, new when they change again, gone at OK.
pub(crate) fn derive_skill_scripts_events(
    config_dir: &Path,
    clone: &Path,
    snapshot: &crate::workspace::WorkspacesFile,
) -> Vec<InboxEvent> {
    let workspace = snapshot
        .active_workspace_id
        .as_deref()
        .and_then(|id| snapshot.workspaces.iter().find(|w| w.id == id))
        .or_else(|| snapshot.workspaces.first());
    let Some(workspace) = workspace else {
        return Vec::new();
    };
    let state = crate::skills_hub_state::load(config_dir);
    let items = match crate::skill_scripts::needs_ok(clone, &state) {
        Ok(items) => items,
        Err(error) => {
            log::debug!("inbox: team skills needing an OK unknown ({error})");
            return Vec::new();
        }
    };
    items
        .into_iter()
        .map(|item| InboxEvent {
            id: crate::skill_scripts::inbox_id(clone, &item),
            kind: InboxEventKind::SkillNeedsOk,
            group: InboxGroup::NeedsYou,
            workspace_id: workspace.id.clone(),
            workspace_name: workspace.name.clone(),
            card_id: None,
            run_id: None,
            title: format!("{} needs your OK", item.skill),
            detail: Some(crate::skill_scripts::needs_ok_detail_in(&item, crate::skill_scripts::place_words(clone))),
            url: None,
            at: None,
            seen_at: None,
            seen_eligible: true,
        })
        .collect()
}

/// Skills hub H4 (R3, R8, R14): one Needs-you row per decision a workspace's
/// linked copy asks for — *changed in the team library and here*, *removed*,
/// *renamed*. Filed under that workspace (the copy is its). Its id
/// `skill-decision:<ws>:<skill>:<state>:<about>` is stable while the question
/// stands and new when the library moves again.
pub(crate) fn derive_skill_decision_events(
    hub_state: &crate::skills_hub_state::HubState,
    clone: &Path,
    trusted: bool,
    ws: &crate::workspace::Workspace,
    cards: &[crate::kanban::KanbanCard],
) -> Vec<InboxEvent> {
    crate::commands::skills_hub_decisions::workspace_decisions(Path::new(&ws.cwd), clone, trusted, cards, hub_state)
        .into_iter()
        .map(|decision| {
            let (title, detail) = crate::commands::skills_hub_decisions::decision_words(&ws.name, &decision);
            InboxEvent {
                id: crate::commands::skills_hub_decisions::decision_id(&ws.id, &decision),
                kind: InboxEventKind::SkillDecision,
                group: InboxGroup::NeedsYou,
                workspace_id: ws.id.clone(),
                workspace_name: ws.name.clone(),
                card_id: None,
                run_id: None,
                title,
                detail: Some(detail),
                url: None,
                at: None,
                seen_at: None,
                seen_eligible: true,
            }
        })
        .collect()
}

/// Skills hub H2 (R16): the one question about a team library GitHub no
/// longer lets this account read. Filed like H6a's rows (the active workspace,
/// or the first). Its id `library:<key>:access-lost:<at>` is stable while the
/// question stands.
pub(crate) fn derive_library_access_events(
    config_dir: &Path,
    clone: &Path,
    snapshot: &crate::workspace::WorkspacesFile,
) -> Vec<InboxEvent> {
    let workspace = snapshot
        .active_workspace_id
        .as_deref()
        .and_then(|id| snapshot.workspaces.iter().find(|w| w.id == id))
        .or_else(|| snapshot.workspaces.first());
    let (Some(workspace), Some((key, lib))) =
        (workspace, crate::skills_hub::access_lost_question(config_dir, clone))
    else {
        return Vec::new();
    };
    let repo = key.strip_prefix("team:").unwrap_or(&key).to_string();
    let when = lib
        .last_pull_at
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map(|at| at.with_timezone(&chrono::Local).format("%b %-d").to_string());
    let copy = match when {
        Some(when) => format!("Your sessions still get the copy from {when}."),
        None => "Your sessions still get the last copy.".to_string(),
    };
    vec![InboxEvent {
        id: format!("library:{key}:access-lost:{}", lib.access_lost.unwrap_or_default()),
        kind: InboxEventKind::LibraryAccessLost,
        group: InboxGroup::NeedsYou,
        workspace_id: workspace.id.clone(),
        workspace_name: workspace.name.clone(),
        card_id: None,
        run_id: None,
        // Walk of H2: the same words as Settings › Team, which names the login.
        title: match lib.member_login.as_deref() {
            Some(login) => format!("{repo} isn't reachable with {login}'s GitHub account any more"),
            None => format!("{repo} isn't reachable with your GitHub account any more"),
        },
        detail: Some(format!(
            "{copy} Switch it off on {}, or keep the last copy.",
            crate::platform::THIS_MACHINE
        )),
        url: None,
        at: lib.access_lost,
        seen_at: None,
        seen_eligible: true,
    }]
}

/// Skills hub H6b walk (R15): one Needs-you row per team plugin Plyloft
/// refuses, naming the CLI that doesn't get its skills, why, and who can fix
/// it — Settings › Team said so, but a member who never opens it saw Claude
/// lose the team's skills without a word. Nothing here lifts the refusal.
/// Filed like H6a's rows (the active workspace, or the first). Its id
/// `team-plugin:<plugin>:refused:<hash>` is stable while the reasons are.
pub(crate) fn derive_team_plugin_refused_events(
    clone: &Path,
    snapshot: &crate::workspace::WorkspacesFile,
) -> Vec<InboxEvent> {
    let workspace = snapshot
        .active_workspace_id
        .as_deref()
        .and_then(|id| snapshot.workspaces.iter().find(|w| w.id == id))
        .or_else(|| snapshot.workspaces.first());
    let Some(workspace) = workspace else {
        return Vec::new();
    };
    let library = crate::team_skills::read_library(clone);
    let mut by_plugin: BTreeMap<String, Vec<&crate::team_skills::RefusedPlugin>> = BTreeMap::new();
    for refused in &library.refused {
        by_plugin.entry(refused.plugin.clone()).or_default().push(refused);
    }
    by_plugin
        .into_iter()
        .map(|(plugin, refusals)| {
            let (title, detail) = team_plugin_refused_words(&plugin, &refusals);
            let mut hash = Sha256::new();
            for refused in &refusals {
                hash.update(refused.vendor.label().as_bytes());
                hash.update([0]);
                hash.update(refused.reason.as_bytes());
                hash.update([0]);
            }
            let digest = hash.finalize();
            let short: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
            InboxEvent {
                id: format!("team-plugin:{plugin}:refused:{short}"),
                kind: InboxEventKind::TeamPluginRefused,
                group: InboxGroup::NeedsYou,
                workspace_id: workspace.id.clone(),
                workspace_name: workspace.name.clone(),
                card_id: None,
                run_id: None,
                title,
                detail: Some(detail),
                url: None,
                at: None,
                seen_at: None,
                seen_eligible: true,
            }
        })
        .collect()
}

/// The row's words: which CLI doesn't get the plugin's skills, why, that no
/// answer here changes it, and what to ask the team owner.
pub(crate) fn team_plugin_refused_words(plugin: &str, refusals: &[&crate::team_skills::RefusedPlugin]) -> (String, String) {
    let mut clis: Vec<&str> = refusals.iter().map(|r| r.vendor.label()).collect();
    clis.dedup();
    let doesnt = if clis.len() > 1 { "don't" } else { "doesn't" };
    let clis = clis.join(" and ");
    let reason = refusals.first().map(|r| r.reason.trim().trim_end_matches('.')).unwrap_or_default();
    let fix = if reason.contains("hooks") {
        "Ask the team owner to remove the hooks from it."
    } else if reason.contains("MCP server") {
        "Ask the team owner to remove the MCP server from it."
    } else {
        "Ask the team owner to fix it in the team library."
    };
    (
        format!("{clis} {doesnt} get the team's {plugin} skills"),
        format!(
            "Plyloft refuses the team's {clis} plugin {plugin}: {reason}. Nothing you answer on {} \
             changes that. {fix}",
            crate::platform::THIS_MACHINE
        ),
    )
}

/// Derive standalone-run events. Dedup rules (STEP1.md D2): swarm legs
/// (`swarm_id` set) and runs already represented by a card
/// (`suppressed_run_ids` = every card's `run_history[].run_id` +
/// `linked_run_id` across all workspaces) are suppressed — the card row is
/// the richer surface. Runs of deleted workspaces are skipped.
pub fn derive_run_events(
    runs: &[AgentRun],
    suppressed_run_ids: &HashSet<String>,
    workspace_names: &HashMap<String, String>,
    window_start: i64,
) -> Vec<InboxEvent> {
    let mut events = Vec::new();
    for run in runs {
        if run.swarm_id.is_some() || suppressed_run_ids.contains(&run.id) {
            continue;
        }
        let Some(ws_name) = workspace_names.get(&run.workspace_id) else {
            continue;
        };
        let trigger_label = match run.trigger {
            AgentTrigger::Manual => "manual",
            AgentTrigger::Scheduled => "scheduled",
            AgentTrigger::Event => "event-triggered",
            AgentTrigger::Swarm => "swarm",
        };
        let mut ev = InboxEvent {
            id: format!("run:{}", run.id),
            kind: InboxEventKind::RunDone,
            group: InboxGroup::NeedsYou,
            workspace_id: run.workspace_id.clone(),
            workspace_name: ws_name.clone(),
            card_id: None,
            run_id: Some(run.id.clone()),
            title: run.agent_name.clone(),
            detail: Some(trigger_label.to_string()),
            url: None,
            at: run.ended_at,
            seen_at: None,
            seen_eligible: true,
        };
        match run.status {
            AgentStatus::Running | AgentStatus::Pending => {
                ev.kind = InboxEventKind::RunRunning;
                ev.group = InboxGroup::Running;
                ev.at = Some(run.started_at);
                ev.seen_eligible = false;
                events.push(ev);
            }
            // F1: a finished run asks nothing — News, until seen.
            AgentStatus::Done => {
                if run.ended_at.unwrap_or(0) >= window_start {
                    ev.group = InboxGroup::News;
                    events.push(ev);
                }
            }
            // F1 (Challenger 1): an error asks the person to look (Needs
            // you, counted while unseen — it has no card to resolve it); a
            // run the person stopped asks nothing: News.
            AgentStatus::Error | AgentStatus::Killed => {
                if run.ended_at.unwrap_or(0) >= window_start {
                    ev.kind = InboxEventKind::RunFailed;
                    ev.group = if run.status == AgentStatus::Killed {
                        InboxGroup::News
                    } else {
                        InboxGroup::NeedsYou
                    };
                    if let Some(err) = run.error.as_deref() {
                        ev.detail = Some(truncate_chars(err, 120));
                    }
                    events.push(ev);
                }
            }
        }
    }
    events
}

// GH #171: `cron_next_fire_ms` went with the scheduled agents; nothing
// fires on a schedule, so no upcoming fire is shown.

// QoL 11.2 (owner D9, Challenger S1): Plyloft shows no dollar figure. It
// can't tell how a CLI is billed — Claude's `total_cost_usd` is Claude
// Code's estimate also on a Pro or Max plan, and a Codex figure is a list
// price even on a ChatGPT plan — so the cost rollup and History's costs are
// gone; the feed keeps an empty `cost_rollup` for its shape.

// ── Seen store (the ONE new persisted JSON — STEP1.md D3) ───────────────────

pub const SEEN_SCHEMA_VERSION: u32 = 1;

fn default_seen_schema() -> u32 {
    SEEN_SCHEMA_VERSION
}

/// On-disk shape of `<config_dir>/inbox/seen.json`. Keyed by user inside the
/// file (email or `"local"`); each user's map is `eventId → seenAt unix-ms`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeenFile {
    #[serde(default = "default_seen_schema")]
    pub schema_version: u32,
    #[serde(default)]
    pub users: HashMap<String, HashMap<String, i64>>,
}

impl Default for SeenFile {
    fn default() -> Self {
        Self {
            schema_version: SEEN_SCHEMA_VERSION,
            users: HashMap::new(),
        }
    }
}

/// Per-user seen markers. Atomic writes (Hard Rule #3); self-pruning on every
/// save — markers older than 2× the feed window reference events that can no
/// longer appear, so the file stays O(window). Losing this file is benign
/// (items reappear unseen), so a corrupt file logs a warning and starts
/// fresh instead of failing startup.
pub struct SeenStore {
    path: PathBuf,
    file: Mutex<SeenFile>,
}

impl SeenStore {
    pub fn new(config_dir: PathBuf) -> Result<Self, String> {
        let path = config_dir.join("inbox").join("seen.json");
        let file = match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<SeenFile>(&bytes) {
                Ok(f) => f,
                Err(e) => {
                    log::warn!("inbox: seen.json corrupt ({e}); starting fresh");
                    SeenFile::default()
                }
            },
            Err(_) => SeenFile::default(),
        };
        Ok(Self {
            path,
            file: Mutex::new(file),
        })
    }

    /// Strict read-only construction for the headless eligibility proof.
    /// A missing store is the valid never-seen state; a present store must be
    /// a regular, nonempty, decodable file and is never repaired or replaced.
    pub fn new_read_only_strict(config_dir: PathBuf) -> Result<Self, String> {
        let path = config_dir.join("inbox").join("seen.json");
        let file = match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => SeenFile::default(),
            Err(error) => return Err(format!("read Inbox seen metadata: {error}")),
            Ok(metadata) => {
                if !metadata.file_type().is_file() {
                    return Err("Inbox seen store is not a regular file".into());
                }
                let bytes = std::fs::read(&path)
                    .map_err(|error| format!("read Inbox seen store: {error}"))?;
                if bytes.is_empty() {
                    return Err("Inbox seen store is empty".into());
                }
                let decoded = serde_json::from_slice::<SeenFile>(&bytes)
                    .map_err(|error| format!("parse Inbox seen store: {error}"))?;
                if decoded.schema_version != SEEN_SCHEMA_VERSION {
                    return Err(format!(
                        "Inbox seen schema {} is not supported",
                        decoded.schema_version
                    ));
                }
                decoded
            }
        };
        Ok(Self {
            path,
            file: Mutex::new(file),
        })
    }

    /// Snapshot of one user's `eventId → seenAt` map.
    pub fn seen_map(&self, user: &str) -> HashMap<String, i64> {
        self.file
            .lock()
            .users
            .get(user)
            .cloned()
            .unwrap_or_default()
    }

    /// Mark `event_ids` seen for `user` at `now_ms`. Already-seen ids keep
    /// their original timestamp (first-look wins). Returns how many were
    /// newly marked. Persists atomically; prunes stale markers on the way.
    pub fn mark_seen(
        &self,
        user: &str,
        event_ids: &[String],
        now_ms: i64,
    ) -> Result<usize, String> {
        let mut file = self.file.lock();
        let map = file.users.entry(user.to_string()).or_default();
        let mut added = 0usize;
        for id in event_ids {
            if !map.contains_key(id) {
                map.insert(id.clone(), now_ms);
                added += 1;
            }
        }
        Self::prune(&mut file, now_ms);
        write_atomic_json(&self.path, &*file)?;
        Ok(added)
    }

    /// Compare the still-unseen subset of `candidate_ids` while holding the
    /// same mutex that protects the eventual atomic write. No file or in-memory
    /// map is changed until the canonical digest matches.
    pub fn mark_seen_if_set_matches(
        &self,
        user: &str,
        candidate_ids: &[String],
        expected_sha256: &str,
        now_ms: i64,
    ) -> Result<usize, String> {
        if !is_lower_sha256(expected_sha256) {
            return Err("Inbox expected set digest is invalid".into());
        }
        // Validate uniqueness even when the current map would otherwise hide
        // a duplicated candidate.
        canonical_id_set_sha256(candidate_ids)?;
        let mut file = self.file.lock();
        let current = file.users.get(user);
        let remaining = candidate_ids
            .iter()
            .filter(|id| current.map(|map| !map.contains_key(*id)).unwrap_or(true))
            .cloned()
            .collect::<Vec<_>>();
        let actual_sha256 = canonical_id_set_sha256(&remaining)?;
        if actual_sha256 != expected_sha256 {
            return Err("Inbox eligible set changed; refresh required".into());
        }

        let map = file.users.entry(user.to_string()).or_default();
        for id in &remaining {
            map.insert(id.clone(), now_ms);
        }
        Self::prune(&mut file, now_ms);
        write_atomic_json(&self.path, &*file)?;
        Ok(remaining.len())
    }

    /// Drop markers whose `seenAt` is older than 2× the feed window — their
    /// events have aged out of every derivable feed.
    fn prune(file: &mut SeenFile, now_ms: i64) {
        let cutoff = now_ms - 2 * window_ms();
        for map in file.users.values_mut() {
            map.retain(|_, at| *at >= cutoff);
        }
        file.users.retain(|_, map| !map.is_empty());
    }
}

// ── PR cache + feed assembly (the cold-workspace read path — D4) ────────────

struct PrCacheEntry {
    fetched_at: Instant,
    prs: Vec<GhPr>,
    successful: bool,
}

#[derive(Clone)]
struct PrResolution {
    prs: Vec<GhPr>,
    successful: bool,
}

/// In-memory, app-managed inbox state: the per-repo `gh` cache. The feed
/// itself is recomputed per call (cheap — bounded board + windowed run scan).
/// OB-7b: the review-requested cache's key — the repository, and the
/// workspace's own GitHub account when it names one (`@me` differs).
fn pr_cache_key(repo: &str, account: Option<&str>) -> String {
    match account {
        Some(login) => format!("{repo}@{}", login.to_ascii_lowercase()),
        None => repo.to_string(),
    }
}

#[derive(Default)]
pub struct InboxState {
    pr_cache: Mutex<HashMap<String, PrCacheEntry>>,
}

impl InboxState {
    /// Cached `review-requested:@me` PRs for `repo`. A fetch failure (offline,
    /// gh missing) logs and caches EMPTY for the TTL — the feed never blocks
    /// or hammers gh on errors; the group simply omits PR rows.
    #[cfg(test)]
    fn review_requested_cached(&self, repo: &str) -> PrResolution {
        self.review_requested_cached_as(repo, None, &|| None)
    }

    /// [`Self::review_requested_cached`]; on a miss, the fetch runs inside
    /// `scope` (OB-7b: the workspace's GitHub account — `@me` is that
    /// account).
    fn review_requested_cached_as(
        &self,
        repo: &str,
        account: Option<&str>,
        scope: &dyn Fn() -> Option<crate::github_account::GithubScope>,
    ) -> PrResolution {
        let key = pr_cache_key(repo, account);
        {
            let cache = self.pr_cache.lock();
            if let Some(entry) = cache.get(&key) {
                if entry.fetched_at.elapsed().as_secs() < PR_CACHE_TTL_SECS {
                    return PrResolution {
                        prs: entry.prs.clone(),
                        successful: entry.successful,
                    };
                }
            }
        }
        let github = scope();
        let listed = crate::github::pr_list_review_requested(repo);
        drop(github);
        let (prs, successful) = match listed {
            Ok(prs) => (prs, true),
            Err(e) => {
                log::warn!("inbox: pr_list_review_requested({repo}) failed: {e}");
                (Vec::new(), false)
            }
        };
        self.pr_cache.lock().insert(
            key,
            PrCacheEntry {
                fetched_at: Instant::now(),
                prs: prs.clone(),
                successful,
            },
        );
        PrResolution { prs, successful }
    }
}

/// Assemble the cross-workspace feed. Reads every workspace's board through
/// the managed `KanbanStore` (cold workspaces included — no UI warming, no
/// raw fs reads) and one mtime-windowed scan of the global runs dir. Joins
/// seen markers so every row ships with `seenAt` resolved.
pub fn assemble_feed(
    workspaces: &WorkspaceStore,
    kanban: &KanbanStore,
    agents: &AgentRegistry,
    // GH #104: `<config_dir>/projects`, where each workspace's improvement
    // proposal is. Replaces the retired lesson registry.
    projects_root: &Path,
    seen: &SeenStore,
    state: &InboxState,
    user: &str,
    now_ms: i64,
    team_licensed: bool,
    target_id_sha256: Option<&str>,
    // Skills hub H6a: the team library's clone on this Mac, when there is one.
    team_clone: Option<&Path>,
) -> Result<InboxFeed, String> {
    let snapshot = workspaces.snapshot();
    let names: HashMap<String, String> = snapshot
        .workspaces
        .iter()
        .map(|w| (w.id.clone(), w.name.clone()))
        .collect();
    let window_start = now_ms - window_ms();

    let mut events: Vec<InboxEvent> = Vec::new();
    let mut suppressed: HashSet<String> = HashSet::new();
    let mut archived_cards: HashSet<(String, String)> = HashSet::new();
    let mut pr_sources = PrSourceSummary::default();
    let mut pr_resolutions: HashMap<String, PrResolution> = HashMap::new();
    let hub_state = match team_clone {
        Some(_) => crate::skills_hub_state::load(&workspaces.config_dir),
        None => Default::default(),
    };
    // Skills hub H4: whether *Removed* / *Renamed* may be read from the clone,
    // asked once per feed.
    let removal_trusted = team_clone.map(crate::commands::skills_hub_decisions::removal_trusted);

    for ws in &snapshot.workspaces {
        let cards = kanban.load(&ws.id).unwrap_or_default();
        for card in &cards {
            if card.archived {
                archived_cards.insert((ws.id.clone(), card.id.clone()));
            }
            for entry in &card.run_history {
                suppressed.insert(entry.run_id.clone());
            }
            if let Some(rid) = &card.linked_run_id {
                suppressed.insert(rid.clone());
            }
        }
        let mut card_events = derive_card_events(&ws.name, &cards, window_start);
        // G5 (Challenger 2): a "bring this computer up to date" row whose
        // target already equals GitHub's as this computer last saw it (pulled
        // by hand) is stale — not shown. Local refs only, no fetch.
        if card_events.iter().any(|e| e.kind == InboxEventKind::BringUpToDate) {
            let target = crate::project_config::ProjectConfigStore::target_branch_in(projects_root, &ws.id)
                .unwrap_or_else(|| "main".to_string());
            if crate::after_merge::local_target_matches_origin(Path::new(&ws.cwd), &target) {
                card_events.retain(|e| e.kind != InboxEventKind::BringUpToDate);
            }
        }
        apply_release_log(&mut card_events, projects_root, ws, window_start);
        events.extend(card_events);
        // 1.174.0 (DR4): a recorded release stopped where only the person can
        // move it on — Needs you, its press opens the Release sheet.
        if let Some(ev) = release_stopped_event(projects_root, ws) {
            events.push(ev);
        }
        // Skills hub H4: the decisions this workspace's linked copies ask for.
        if let (Some(clone), Some(trusted)) = (team_clone, removal_trusted) {
            events.extend(derive_skill_decision_events(&hub_state, clone, trusted, ws, &cards));
        }

        // GH #171: no `ScheduleUpcoming` rows. Scheduled agents are retired, so
        // an agent's `schedule` (still loaded from an old file) never fires,
        // and a row promising one would be untrue. The kind and the group stay
        // for the eligibility proof's totals, always 0.

        // PR review requested — only GitHub-synced workspaces, TTL-cached.
        // v1.85.0: review awareness is a paid team behavior; unlicensed
        // feeds carry no pr_review events (consistent with the read-only
        // lapse degrade — no half-alive team signals).
        let gh_target = if team_licensed {
            crate::commands::workspace_github_target(workspaces, &ws.id)
        } else {
            None
        };
        if let Some(repo) = gh_target {
            pr_sources.admitted_targets += 1;
            // OB-7b: `@me` is the workspace's account — one entry per
            // (repository, account).
            let account = ws
                .github_account
                .as_deref()
                .map(str::trim)
                .filter(|a| !a.is_empty());
            let resolution = pr_resolutions
                .entry(pr_cache_key(&repo, account))
                .or_insert_with(|| {
                    state.review_requested_cached_as(&repo, account, &|| {
                        Some(crate::github_account::enter_for_workspace(workspaces, &ws.id))
                    })
                })
                .clone();
            for pr in resolution.prs {
                events.push(InboxEvent {
                    id: format!("pr:{repo}#{}", pr.number),
                    kind: InboxEventKind::PrReview,
                    group: InboxGroup::NeedsYou,
                    workspace_id: ws.id.clone(),
                    workspace_name: ws.name.clone(),
                    card_id: None,
                    run_id: None,
                    title: pr.title.clone(),
                    detail: Some(format!("PR #{} · {}", pr.number, pr.author)),
                    url: Some(pr.url.clone()),
                    // QoL 14.2 (F7): the pull request's own age, not "now".
                    at: pr.created_at,
                    seen_at: None,
                    seen_eligible: true,
                });
            }
        }
    }

    events.extend(derive_proposal_events(projects_root, &snapshot.workspaces));
    events.extend(derive_setting_conflict_events(projects_root, &snapshot.workspaces));
    events.extend(derive_install_ok_events(projects_root, &snapshot.workspaces));
    events.extend(derive_next_improvement_events(projects_root, &snapshot.workspaces));
    // Skills hub H10: a My library skill that brings a script asks too.
    for mine in crate::my_library::clones_on_disk(&workspaces.config_dir) {
        events.extend(derive_skill_scripts_events(&workspaces.config_dir, &mine, &snapshot));
    }
    if let Some(clone) = team_clone {
        events.extend(derive_skill_scripts_events(&workspaces.config_dir, clone, &snapshot));
        events.extend(derive_library_access_events(&workspaces.config_dir, clone, &snapshot));
        events.extend(derive_team_plugin_refused_events(clone, &snapshot));
    }

    // One windowed runs scan feeds both run events (14d) and the cost rollup
    // (28d) — scan at the wider horizon.
    let rollup_start = now_ms - COST_ROLLUP_WEEKS * WEEK_MS;
    let runs = agents.list_runs_modified_since(rollup_start.min(window_start));
    events.extend(derive_run_events(&runs, &suppressed, &names, window_start));
    // D9: no dollar figure anywhere (see above); the field keeps its shape.
    let cost_rollup: Vec<WorkspaceCostRollup> = Vec::new();

    // Dedup by id (project-scoped scheduled agents can appear via several
    // same-cwd workspaces), join seen markers, newest first.
    let mut seen_ids: HashSet<String> = HashSet::new();
    events.retain(|e| seen_ids.insert(e.id.clone()));
    let seen_map = seen.seen_map(user);
    let mut carried: Vec<String> = Vec::new();
    for ev in events.iter_mut() {
        if ev.seen_eligible {
            ev.seen_at = seen_map.get(&ev.id).copied();
            // QoL 1.168 (F1): a row seen under its pre-round id stays seen.
            if ev.seen_at.is_none() {
                if let Some(at) = legacy_seen_at(&ev.id, ev.at, &seen_map) {
                    ev.seen_at = Some(at);
                    carried.push(ev.id.clone());
                }
            }
        }
    }
    if !carried.is_empty() {
        // Recorded under the new id, so it outlives the old marker's pruning.
        if let Err(e) = seen.mark_seen(user, &carried, now_ms) {
            log::warn!("inbox: couldn't record {} carried seen markers: {e}", carried.len());
        }
    }
    events.sort_by_key(|e| std::cmp::Reverse(e.at.unwrap_or(now_ms)));

    for resolution in pr_resolutions.values() {
        if resolution.successful {
            pr_sources.successful_sources += 1;
        } else {
            pr_sources.failed_sources += 1;
        }
    }
    let eligibility_proof = eligibility_proof(
        &events,
        now_ms,
        team_licensed,
        user,
        pr_sources,
        target_id_sha256,
    )?;

    let card_seen = seen_map
        .iter()
        .filter(|(id, _)| id.starts_with(CARD_ROW_PREFIX))
        .map(|(id, at)| (id.clone(), *at))
        .collect();
    Ok(InboxFeed {
        generated_at: now_ms,
        window_days: INBOX_WINDOW_DAYS,
        events,
        cost_rollup,
        eligibility_proof,
        card_seen,
    })
}

// ── Activity (v1.80.0 — UX revamp Part 2, P2-2) ─────────────────────────────
// Telemetry's single disclosure home (docs/ux-revamp/PART2.md Q4): runs,
// swarms, ships, verify history and cost — cross-workspace, windowed to four
// weeks. Pure VIEW, same access patterns as the inbox feed (cold workspaces
// via the managed KanbanStore, one windowed runs scan). Absorbs the retired
// SwarmTab grid: a swarm is ONE row here; its per-role legs stay runs-only
// in the stats so they aren't double-listed.

pub const ACTIVITY_WINDOW_DAYS: i64 = 28;
/// Hard cap on returned rows — `truncated` says when it bit (no silent cap).
pub const ACTIVITY_MAX_ROWS: usize = 200;

fn activity_window_ms() -> i64 {
    ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityStats {
    /// The median duration of the agent runs that ended inside the window
    /// (in the workspace asked for). Builder rounds have none.
    pub median_run_secs: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRow {
    pub id: String,
    /// "run" | "swarm" | "build" | "ship" | "verify" | "discussion" | "cleanup"
    pub kind: String,
    /// running | done | failed | killed | shipped | passed | no_checks | aborted |
    /// timed_out | max_iter | suspended
    pub state: String,
    pub title: String,
    pub detail: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub card_id: Option<String>,
    pub run_id: Option<String>,
    pub at: i64,
    /// QoL 11.1 (F8): how many events of this kind the row stands for — a
    /// card is one row per kind (its ships, its checks, its Builder rounds),
    /// the latest one's state and time. 1 for every other row.
    pub count: usize,
    /// 1.168.1 (A4): the row's card was deleted — its history stays, marked,
    /// and `card_id` is None so nothing opens a card that is gone.
    pub card_deleted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityFeed {
    pub generated_at: i64,
    pub window_days: i64,
    pub stats: ActivityStats,
    pub rows: Vec<ActivityRow>,
    pub truncated: bool,
    /// QoL 11.1 (Challenger 2): each tab's rows before the cap, in the
    /// workspace asked for — so a cut tab can say "the latest 200 of N".
    pub tab_totals: BTreeMap<String, usize>,
}

fn swarm_state_label(status: crate::swarms::SwarmStatus) -> &'static str {
    use crate::swarms::SwarmStatus as S;
    match status {
        S::Running => "running",
        S::Done => "done",
        S::Failed => "failed",
        S::Aborted => "aborted",
        S::TimedOut => "timed_out",
        S::MaxIter => "max_iter",
        S::Suspended => "suspended",
    }
}

/// The median duration (seconds) of the terminal runs that ended inside the
/// window, over those with a sane duration (ended ≥ started).
pub fn activity_median_run_secs(runs: &[AgentRun], window_start: i64) -> Option<i64> {
    let mut durations: Vec<i64> = runs
        .iter()
        .filter(|run| !matches!(run.status, AgentStatus::Running | AgentStatus::Pending))
        .filter_map(|run| run.ended_at.map(|ended| (run, ended)))
        .filter(|(run, ended)| *ended >= window_start && *ended >= run.started_at)
        .map(|(run, ended)| (ended - run.started_at) / 1000)
        .collect();
    durations.sort_unstable();
    (!durations.is_empty()).then(|| durations[durations.len() / 2])
}

fn discussion_activity_rows(
    records: Vec<crate::discussion::DiscussionRecord>,
    names: &HashMap<String, String>,
    window_start: i64,
) -> Vec<ActivityRow> {
    let mut rows = Vec::new();
    for discussion in records {
        let live = matches!(
            discussion.status,
            crate::discussion::DiscussionStatus::Preparing
                | crate::discussion::DiscussionStatus::Running
                | crate::discussion::DiscussionStatus::PausedProviderUnavailable
                | crate::discussion::DiscussionStatus::Interrupted
        );
        let at = discussion.ended_at.unwrap_or(discussion.updated_at);
        if !live && at < window_start {
            continue;
        }
        let Some(ws_name) = names.get(&discussion.workspace_id) else {
            continue;
        };
        let state = match discussion.status {
            crate::discussion::DiscussionStatus::Preparing => "preparing",
            crate::discussion::DiscussionStatus::Running => "running",
            crate::discussion::DiscussionStatus::PausedProviderUnavailable => {
                "paused_provider_unavailable"
            }
            crate::discussion::DiscussionStatus::Completed => "completed",
            crate::discussion::DiscussionStatus::Failed => "failed",
            crate::discussion::DiscussionStatus::Aborted => "aborted",
            crate::discussion::DiscussionStatus::Interrupted => "interrupted",
        };
        let phase = match discussion.current_phase {
            crate::discussion::DiscussionPhase::Preparing => "preparing",
            crate::discussion::DiscussionPhase::IndependentAnalyses => "independent analyses",
            crate::discussion::DiscussionPhase::CrossReviews => "cross-reviews",
            crate::discussion::DiscussionPhase::Synthesis => "synthesis",
            crate::discussion::DiscussionPhase::Completed => "completed",
        };
        let synthesizer = match discussion.participants.synthesizer.provider {
            crate::coordination::Provider::Claude => "Claude",
            crate::coordination::Provider::Codex => "Codex",
            crate::coordination::Provider::System => "System",
            crate::coordination::Provider::Shell => "Shell",
        };
        rows.push(ActivityRow {
            id: format!("discussion:{}", discussion.id),
            kind: "discussion".into(),
            state: state.into(),
            title: discussion.problem,
            detail: format!(
                "{} · synthesis by {} {}",
                phase, synthesizer, discussion.participants.synthesizer.version
            ),
            workspace_id: discussion.workspace_id,
            workspace_name: ws_name.clone(),
            card_id: discussion.card_id,
            run_id: None,
            at,
            count: 1,
            card_deleted: false,
        });
    }
    rows
}

/// A verify entry's row state (GH #333: a pass with no steps is
/// "no_checks"); `None` for a non-terminal entry.
fn verify_row_state(entry: &crate::kanban::VerifyEntry) -> Option<&'static str> {
    match entry.status {
        VerifyStatus::Passed if entry.steps.is_empty() => Some("no_checks"),
        VerifyStatus::Passed => Some("passed"),
        VerifyStatus::Failed => Some("failed"),
        _ => None,
    }
}

/// QoL 11.1 (F8): one card's History rows, one per kind — its ships, its
/// checks, its Builder rounds — each the latest event's state and time,
/// `count` the events it stands for. A ship whose latest checks found none
/// set up carries that in its own detail ("no checks set up"), so one ship
/// never reads as two events.
pub fn card_activity_rows(
    ws_id: &str,
    ws_name: &str,
    cards: &[KanbanCard],
    window_start: i64,
) -> Vec<ActivityRow> {
    let mut out: Vec<ActivityRow> = Vec::new();
    let row = |id: String,
               kind: &str,
               state: &str,
               card: &KanbanCard,
               detail: String,
               at: i64,
               count: usize| ActivityRow {
        id,
        kind: kind.into(),
        state: state.into(),
        title: card.title.clone(),
        detail,
        workspace_id: ws_id.to_string(),
        workspace_name: ws_name.to_string(),
        card_id: Some(card.id.clone()),
        run_id: None,
        at,
        count,
        card_deleted: false,
    };
    for card in cards {
        // Its checks: the latest terminal entry in the window, and how many.
        let mut checks = 0usize;
        let mut latest_check: Option<(&VerifyEntry, &'static str)> = None;
        for entry in &card.verify_history {
            if entry.ended_at < window_start {
                continue;
            }
            let Some(state) = verify_row_state(entry) else {
                continue;
            };
            checks += 1;
            if latest_check.is_none_or(|(l, _)| entry.ended_at >= l.ended_at) {
                latest_check = Some((entry, state));
            }
        }
        let no_checks = latest_check.is_some_and(|(_, state)| state == "no_checks");

        // Its ships.
        let ships: Vec<&crate::kanban::ShipEntry> = card
            .ship_history
            .iter()
            .filter(|e| e.shipped_at >= window_start)
            .collect();
        let latest_ship = ships.iter().max_by_key(|e| e.shipped_at).copied();
        if let Some(entry) = latest_ship {
            let sha_short: String = entry.commit_sha.chars().take(7).collect();
            // 1.173.0 (B4): an area's release names its own tag (site-v3.0.2).
            let tag = entry.tag.clone().unwrap_or_else(|| format!("v{}", entry.shipped_version));
            let mut detail = format!("{tag} · {sha_short}");
            if no_checks {
                detail.push_str(" · no checks set up");
            }
            out.push(row(
                format!("ship:{}:{}", card.id, entry.commit_sha),
                "ship",
                "shipped",
                card,
                detail,
                entry.shipped_at,
                ships.len(),
            ));
        }

        // Its checks row — not when it would only say a shipped card had none.
        if let Some((entry, state)) = latest_check {
            if !(no_checks && latest_ship.is_some()) {
                out.push(row(
                    format!("verify:{}:{}", card.id, entry.verify_run_id),
                    "verify",
                    state,
                    card,
                    // An entry recorded before GH #333 says "all 0 step(s) passed".
                    if state == "no_checks" {
                        "no checks are set up".to_string()
                    } else {
                        entry.summary.clone().unwrap_or_default()
                    },
                    entry.ended_at,
                    checks,
                ));
            }
        }

        // Its Builder rounds: one per *Finish and check* (a snapshot); a
        // session still working shows as Working. 1.168.1 (A1): an open
        // session whose round is done (Finish and check recorded it, the card
        // is Ready to ship or under review) is not working — the card's own
        // run says so (`last_run_status`, as `cardLifecycle.ts` reads it).
        if let Some(builder) = &card.builder {
            let rounds: Vec<i64> = builder
                .snapshots
                .iter()
                .map(|snap| snap.at)
                .filter(|at| *at >= window_start)
                .collect();
            let live = builder.pty_id.is_some()
                && card.last_run_status == Some(LastRunStatus::Running);
            if !rounds.is_empty() || live {
                let last = rounds.iter().copied().max().unwrap_or(builder.started_at);
                let at = if live { last.max(builder.started_at) } else { last };
                let n = rounds.len();
                let vendor = if builder.vendor == "codex" { "Codex" } else { "Claude" };
                out.push(row(
                    format!("build:{}", card.id),
                    "build",
                    if live { "working" } else { "built" },
                    card,
                    format!("{vendor} · {n} round{}", if n == 1 { "" } else { "s" }),
                    at,
                    n,
                ));
            }
        }
    }
    out
}

/// 1.168.1 (A4, Windows walk): a deleted card's rows, as `card_activity_rows`
/// draws them, plus its Builder row when the card was deleted with a round
/// still open and no round finished (`kanban::history_of_deleted` keeps it
/// stopped): "Stopped", 0 rounds, at the session's start — so deleting a
/// card keeps that run too, never as Working.
pub fn deleted_card_activity_rows(
    ws_id: &str,
    ws_name: &str,
    cards: &[KanbanCard],
    window_start: i64,
) -> Vec<ActivityRow> {
    let mut out = card_activity_rows(ws_id, ws_name, cards, window_start);
    for card in cards {
        let Some(builder) = &card.builder else {
            continue;
        };
        let id = format!("build:{}", card.id);
        if card.last_run_status != Some(LastRunStatus::Aborted)
            || builder.started_at < window_start
            || out.iter().any(|r| r.id == id)
        {
            continue;
        }
        let vendor = if builder.vendor == "codex" { "Codex" } else { "Claude" };
        out.push(ActivityRow {
            id,
            kind: "build".into(),
            state: "aborted".into(),
            title: card.title.clone(),
            detail: format!("{vendor} · 0 rounds"),
            workspace_id: ws_id.to_string(),
            workspace_name: ws_name.to_string(),
            card_id: Some(card.id.clone()),
            run_id: None,
            at: builder.started_at,
            count: 0,
            card_deleted: false,
        });
    }
    out
}

/// The History tab a row is listed under (QoL 11.1): Runs holds agent runs,
/// swarms and Builder rounds; a worktree-trash pass is the Cleanup tab's.
pub fn activity_tab(kind: &str) -> &'static str {
    match kind {
        "run" | "swarm" | "build" => "runs",
        "ship" => "ships",
        "verify" => "checks",
        "discussion" => "discussions",
        _ => "cleanup",
    }
}

/// Newest first, at most `ACTIVITY_MAX_ROWS` per tab, so one busy kind never
/// pushes another out; `true` when any tab was cut.
fn cap_per_tab(rows: Vec<ActivityRow>) -> (Vec<ActivityRow>, bool) {
    let mut per: HashMap<&'static str, usize> = HashMap::new();
    let mut truncated = false;
    let mut kept = Vec::with_capacity(rows.len());
    for r in rows {
        let n = per.entry(activity_tab(&r.kind)).or_insert(0);
        if *n >= ACTIVITY_MAX_ROWS {
            truncated = true;
            continue;
        }
        *n += 1;
        kept.push(r);
    }
    (kept, truncated)
}

/// 1.168.1 (A4): a row whose card is no longer on its (readable) board is
/// from a deleted card: marked, and it opens no card.
fn mark_deleted_cards(rows: &mut [ActivityRow], live_cards: &HashMap<String, HashSet<String>>) {
    for r in rows.iter_mut() {
        let Some(card_id) = r.card_id.as_deref() else {
            continue;
        };
        if live_cards.get(&r.workspace_id).is_some_and(|live| !live.contains(card_id)) {
            r.card_id = None;
            r.card_deleted = true;
        }
    }
}

pub fn assemble_activity(
    workspaces: &WorkspaceStore,
    kanban: &KanbanStore,
    agents: &AgentRegistry,
    swarms: &crate::swarms::SwarmRegistry,
    discussions: &crate::discussion::DiscussionRegistry,
    trash_cleanups: &[crate::build_cache::TrashCleanup],
    workspace_id: Option<&str>,
    now_ms: i64,
) -> ActivityFeed {
    let snapshot = workspaces.snapshot();
    // QoL 11.1 (Challenger 2): History's workspace filter applies here, before
    // the cap — every row below needs its workspace in `names`.
    let names: HashMap<String, String> = snapshot
        .workspaces
        .iter()
        .filter(|w| workspace_id.is_none_or(|id| w.id == id))
        .map(|w| (w.id.clone(), w.name.clone()))
        .collect();
    let window_start = now_ms - activity_window_ms();

    let mut rows: Vec<ActivityRow> = Vec::new();
    // 1.168.1 (A4): each readable board's cards, to tell a row whose card
    // was deleted. A board that can't be read marks nothing.
    let mut live_cards: HashMap<String, HashSet<String>> = HashMap::new();
    for ws in snapshot.workspaces.iter().filter(|w| names.contains_key(&w.id)) {
        let Ok(cards) = kanban.load(&ws.id) else {
            continue;
        };
        rows.extend(card_activity_rows(&ws.id, &ws.name, &cards, window_start));
        let live: HashSet<String> = cards.iter().map(|c| c.id.clone()).collect();
        // Its deleted cards keep their runs, checks and ships.
        let gone: Vec<KanbanCard> = kanban
            .deleted_cards(&ws.id)
            .into_iter()
            .filter(|c| !live.contains(&c.id))
            .collect();
        rows.extend(deleted_card_activity_rows(&ws.id, &ws.name, &gone, window_start));
        live_cards.insert(ws.id.clone(), live);
    }

    // The retired SwarmTab grid, absorbed: one row per swarm — running ones
    // always, terminal ones inside the window.
    for swarm in swarms.list() {
        let live = matches!(
            swarm.status,
            crate::swarms::SwarmStatus::Running | crate::swarms::SwarmStatus::Suspended
        );
        let at = swarm.ended_at.unwrap_or(swarm.started_at);
        if !live && at < window_start {
            continue;
        }
        let Some(ws_name) = names.get(&swarm.workspace_id) else {
            continue;
        };
        rows.push(ActivityRow {
            id: format!("swarm:{}", swarm.id),
            kind: "swarm".into(),
            state: swarm_state_label(swarm.status).into(),
            title: swarm.goal.clone(),
            detail: format!("swarm · iteration {}", swarm.iteration),
            workspace_id: swarm.workspace_id.clone(),
            workspace_name: ws_name.clone(),
            card_id: None,
            run_id: None,
            at,
            count: 1,
            card_deleted: false,
        });
    }

    // Phase 5D: discussion records share Activity's cross-workspace history.
    rows.extend(discussion_activity_rows(
        discussions.snapshot(),
        &names,
        window_start,
    ));
    rows.extend(crate::build_cache::activity_rows(trash_cleanups, &names, window_start));

    // One windowed runs scan: the median over the workspace's runs; rows for
    // STANDALONE runs only (swarm legs are represented by their swarm row).
    let runs: Vec<AgentRun> = agents
        .list_runs_modified_since(window_start)
        .into_iter()
        .filter(|run| names.contains_key(&run.workspace_id))
        .collect();
    let median_run_secs = activity_median_run_secs(&runs, window_start);
    for run in &runs {
        if run.swarm_id.is_some() {
            continue;
        }
        let Some(ws_name) = names.get(&run.workspace_id) else {
            continue;
        };
        let (state, at): (&str, i64) = match run.status {
            AgentStatus::Running | AgentStatus::Pending => ("running", run.started_at),
            AgentStatus::Done => ("done", run.ended_at.unwrap_or(run.started_at)),
            AgentStatus::Error => ("failed", run.ended_at.unwrap_or(run.started_at)),
            AgentStatus::Killed => ("killed", run.ended_at.unwrap_or(run.started_at)),
        };
        if state != "running" && at < window_start {
            continue;
        }
        rows.push(ActivityRow {
            id: format!("arun:{}", run.id),
            kind: "run".into(),
            state: state.into(),
            title: run.agent_name.clone(),
            detail: match run.trigger {
                AgentTrigger::Manual => "manual",
                AgentTrigger::Scheduled => "scheduled",
                AgentTrigger::Event => "event-triggered",
                AgentTrigger::Swarm => "swarm",
            }
            .into(),
            workspace_id: run.workspace_id.clone(),
            workspace_name: ws_name.clone(),
            card_id: None,
            run_id: Some(run.id.clone()),
            at,
            count: 1,
            card_deleted: false,
        });
    }

    mark_deleted_cards(&mut rows, &live_cards);
    rows.sort_by(|a, b| b.at.cmp(&a.at));
    let mut tab_totals: BTreeMap<String, usize> = BTreeMap::new();
    for r in &rows {
        *tab_totals.entry(activity_tab(&r.kind).to_string()).or_insert(0) += 1;
    }
    let (rows, truncated) = cap_per_tab(rows);

    ActivityFeed {
        generated_at: now_ms,
        window_days: ACTIVITY_WINDOW_DAYS,
        stats: ActivityStats { median_run_secs },
        rows,
        truncated,
        tab_totals,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kanban::{KanbanColumnId, ShipEntry, VerifyStepResult};
    use tempfile::TempDir;

    fn mk_card(id: &str, ws: &str) -> KanbanCard {
        KanbanCard::new(
            id.to_string(),
            ws.to_string(),
            format!("card {id}"),
            None,
            KanbanColumnId::InProgress,
        )
    }

    fn mk_run(id: &str, ws: &str, status: AgentStatus, ended_at: Option<i64>) -> AgentRun {
        AgentRun {
            schema_version: 1,
            id: id.to_string(),
            agent_id: "agent-1".into(),
            agent_name: "Nightly".into(),
            workspace_id: ws.to_string(),
            trigger: AgentTrigger::Scheduled,
            runtime_mode: crate::agents::RuntimeMode::Oneshot,
            status,
            started_at: ended_at.unwrap_or(1_000_000) - 60_000,
            ended_at,
            exit_code: None,
            pty_id: None,
            transcript_path: "x.log".into(),
            bytes_written: 0,
            error: None,
            usage: None,
            model: None,
            provider: None,
            total_cost_usd: None,
            throttled: false,
            swarm_id: None,
            swarm_artifact: None,
            swarm_role_instance_id: None,
            swarm_owned_globs: Vec::new(),
        }
    }

    const NOW: i64 = 2_000_000_000_000;

    fn window_start() -> i64 {
        NOW - window_ms()
    }

    fn proof_event(
        id: &str,
        kind: InboxEventKind,
        group: InboxGroup,
        seen_eligible: bool,
        seen_at: Option<i64>,
    ) -> InboxEvent {
        InboxEvent {
            id: id.into(),
            kind,
            group,
            workspace_id: "ws1".into(),
            workspace_name: "Workspace".into(),
            card_id: None,
            run_id: None,
            title: "public fixture".into(),
            detail: None,
            url: None,
            at: Some(NOW),
            seen_at,
            seen_eligible,
        }
    }

    #[test]
    fn canonical_id_set_hash_is_sorted_lf_framed_and_strict() {
        assert_eq!(
            canonical_id_set_sha256(&[]).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            canonical_id_set_sha256(&["b".into(), "a".into()]).unwrap(),
            "911169ddaaf146aff539f58c26c489af3b892dff0fe283c1c264c65ae5aa59a2"
        );
        assert_eq!(
            canonical_id_set_sha256(&["a".into(), "b".into()]).unwrap(),
            canonical_id_set_sha256(&["b".into(), "a".into()]).unwrap()
        );
        assert!(canonical_id_set_sha256(&[String::new()]).is_err());
        assert!(canonical_id_set_sha256(&["a".into(), "a".into()]).is_err());
        assert_eq!(RequiredInboxSet::Absent.required_digest().unwrap(), None);
        let fixed_digest = "a".repeat(64);
        let fixed = RequiredInboxSet::Fixed(fixed_digest.clone());
        assert_eq!(
            fixed.required_digest().unwrap(),
            Some(fixed_digest.as_str())
        );
        assert!(RequiredInboxSet::Fixed("bad".into())
            .required_digest()
            .is_err());
        assert!(RequiredInboxSet::Invalid.required_digest().is_err());
    }

    #[test]
    fn eligibility_proof_counts_every_vocabulary_entry_and_target() {
        let events = vec![
            proof_event(
                "PLY-SECRET-EVENT",
                InboxEventKind::PrReview,
                InboxGroup::NeedsYou,
                true,
                None,
            ),
            proof_event(
                "seen",
                InboxEventKind::PrReview,
                InboxGroup::NeedsYou,
                true,
                Some(NOW - 1),
            ),
            proof_event(
                "status",
                InboxEventKind::RunRunning,
                InboxGroup::Running,
                false,
                None,
            ),
        ];
        let target = sha256_text("PLY-SECRET-EVENT");
        let proof = eligibility_proof(
            &events,
            NOW,
            true,
            "owner@example.test",
            PrSourceSummary {
                admitted_targets: 2,
                successful_sources: 1,
                failed_sources: 0,
            },
            Some(&target),
        )
        .unwrap();
        assert_eq!(proof.total_rows, 3);
        assert_eq!(proof.eligible_unseen_rows, 1);
        assert_eq!(proof.by_kind.len(), ALL_INBOX_KINDS.len());
        assert_eq!(proof.by_group.len(), ALL_INBOX_GROUPS.len());
        assert_eq!(
            proof.by_kind.keys().map(String::as_str).collect::<Vec<_>>(),
            vec![
                // G5: merged, this computer still behind GitHub.
                "bring_up_to_date",
                "card_failed",
                "card_queued",
                "card_running",
                // Skills hub H2: GitHub no longer lets this account read the team library.
                "library_access_lost",
                // 1.173.0 (E3): a Next improvement round's ideas wait.
                "next_improvement_ideas",
                // G7: Fix failing checks by itself stopped.
                "pr_auto_fix_stopped",
                // SL-1: the card's pull request on GitHub.
                "pr_changes_requested",
                "pr_checks_failed",
                "pr_closed",
                "pr_conflict",
                // G1–G3 Challenger (2): commits Plyloft didn't push.
                "pr_head_moved",
                "pr_merged",
                // 1.169.1 (R1): a pull request ready to merge asks for its Merge.
                "pr_ready_to_merge",
                "pr_review",
                // 1.174.0 (DR4): a release stopped, and one row per release.
                "release_stopped",
                "released",
                "review_needed",
                "run_done",
                "run_failed",
                "run_running",
                "schedule_upcoming",
                // 1.173.0 (C3): a shared setting both sides changed.
                "shared_setting_conflict",
                "shipped",
                // GH #104: the Challenger's improvement proposal replaced the
                // retired post-ship lesson's `knowledge_decision`, and the
                // vocabulary is a sorted BTreeMap's keys.
                "skill_change_waiting",
                // Skills hub H4: a linked copy asks for a decision.
                "skill_decision",
                // Skills hub H6a: a team skill whose scripts wait for an OK.
                "skill_needs_ok",
                // Skills hub H6b walk: a team plugin Plyloft refuses for a CLI.
                "team_plugin_refused",
                "verify_failed",
            ]
        );
        assert_eq!(
            proof
                .by_group
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["needs_you", "news", "on_hold", "running", "scheduled", "shipped"]
        );
        assert_eq!(proof.by_kind["pr_review"].total, 2);
        assert_eq!(proof.by_kind["pr_review"].eligible_unseen, 1);
        assert_eq!(proof.by_kind["card_failed"].total, 0);
        assert_eq!(proof.by_group["needs_you"].eligible_unseen, 1);
        assert_eq!(proof.by_group["scheduled"].total, 0);
        assert_eq!(proof.target_present, Some(true));
        assert_eq!(proof.admitted_pr_targets, 2);
        assert_eq!(proof.successful_pr_sources, 1);
        assert_eq!(proof.failed_pr_sources, 0);
        assert!(proof.pr_sources_complete);
        let encoded = serde_json::to_string(&proof).unwrap();
        for forbidden in [
            "PLY-SECRET-EVENT",
            "public fixture",
            "owner@example.test",
            "Workspace",
        ] {
            assert!(!encoded.contains(forbidden), "proof leaked {forbidden}");
        }
    }

    #[test]
    fn eligibility_proof_rejects_malformed_target_and_reports_failed_source() {
        let events = vec![proof_event(
            "eligible",
            InboxEventKind::CardFailed,
            InboxGroup::NeedsYou,
            true,
            None,
        )];
        assert!(eligibility_proof(
            &events,
            NOW,
            false,
            "local",
            PrSourceSummary::default(),
            Some("ABC")
        )
        .is_err());
        let proof = eligibility_proof(
            &events,
            NOW,
            true,
            "local",
            PrSourceSummary {
                admitted_targets: 1,
                successful_sources: 0,
                failed_sources: 1,
            },
            None,
        )
        .unwrap();
        assert!(!proof.pr_sources_complete);

        let absent = eligibility_proof(
            &events,
            NOW,
            true,
            "local",
            PrSourceSummary::default(),
            Some(&sha256_text("not-present")),
        )
        .unwrap();
        assert_eq!(absent.target_present, Some(false));
    }

    /// OB-7b: `@me` differs per account, so two workspaces on one
    /// repository with different accounts don't share an answer.
    #[test]
    fn pr_cache_is_kept_per_repository_and_account() {
        let _ = crate::github::take_test_gh_invocations();
        let state = InboxState::default();
        let one = r#"[{"number":1,"title":"A","url":"https://example.invalid/1","author":{"login":"bot"}}]"#;
        crate::github::set_test_gh_responses(vec![Ok(one.into()), Ok("[]".into())]);
        let active = state.review_requested_cached_as("o/r", None, &|| None);
        let work = state.review_requested_cached_as("o/r", Some("Work-Acct"), &|| None);
        assert_eq!(active.prs.len(), 1);
        assert_eq!(work.prs.len(), 0);
        // Both cached now, the account's key case-folded.
        assert_eq!(state.review_requested_cached_as("o/r", None, &|| None).prs.len(), 1);
        assert_eq!(state.review_requested_cached_as("o/r", Some("work-acct"), &|| None).prs.len(), 0);
        assert_eq!(crate::github::take_test_gh_invocations().len(), 2);
        assert_eq!(pr_cache_key("o/r", None), "o/r");
        assert_eq!(pr_cache_key("o/r", Some("B")), "o/r@b");
    }

    #[test]
    fn pr_cache_preserves_success_failure_and_expiry_provenance() {
        let _ = crate::github::take_test_gh_invocations();
        let success_state = InboxState::default();
        crate::github::set_test_gh_responses(vec![Ok(
            r#"[{"number":7,"title":"Review","url":"https://example.invalid/7","author":{"login":"bot"}}]"#
                .into(),
        )]);
        let fresh = success_state.review_requested_cached("fixture/success");
        let cached = success_state.review_requested_cached("fixture/success");
        assert!(fresh.successful && cached.successful);
        assert_eq!(fresh.prs.len(), 1);
        assert_eq!(cached.prs.len(), 1);
        assert_eq!(crate::github::take_test_gh_invocations().len(), 1);

        let failed_state = InboxState::default();
        crate::github::set_test_gh_responses(vec![Err("offline".into())]);
        let failed = failed_state.review_requested_cached("fixture/failure");
        let cached_failure = failed_state.review_requested_cached("fixture/failure");
        assert!(!failed.successful && !cached_failure.successful);
        assert!(failed.prs.is_empty() && cached_failure.prs.is_empty());
        assert_eq!(crate::github::take_test_gh_invocations().len(), 1);

        failed_state.pr_cache.lock().insert(
            "fixture/failure".into(),
            PrCacheEntry {
                fetched_at: Instant::now() - std::time::Duration::from_secs(PR_CACHE_TTL_SECS + 1),
                prs: Vec::new(),
                successful: false,
            },
        );
        crate::github::set_test_gh_responses(vec![Ok("[]".into())]);
        let refreshed = failed_state.review_requested_cached("fixture/failure");
        assert!(refreshed.successful);
        assert_eq!(crate::github::take_test_gh_invocations().len(), 1);
        crate::github::clear_test_gh_responses();
    }

    #[test]
    fn production_assembly_binds_cards_runs_schedules_proposals_seen_and_windows() {
        let temp = TempDir::new().unwrap();
        let config = temp.path().to_path_buf();
        let project = temp.path().join("project");
        std::fs::create_dir_all(project.join(".atelier/agents")).unwrap();
        let workspaces = WorkspaceStore::new(config.clone()).unwrap();
        let first = workspaces
            .create("First".into(), project.to_string_lossy().into_owned())
            .unwrap();
        let _second = workspaces
            .create("Second".into(), project.to_string_lossy().into_owned())
            .unwrap();
        let kanban = KanbanStore::new(config.clone()).unwrap();

        let mut review = mk_card("assembly-review", &first.id);
        review.last_run_status = Some(LastRunStatus::Success);
        review.linked_run_id = Some("suppressed-run".into());
        kanban.create_card(&first.id, review).unwrap();

        let agents = AgentRegistry::new(&config).unwrap();
        let scheduled = agents
            .create_agent(
                crate::agents::AgentConfig {
                    schema_version: 1,
                    id: String::new(),
                    scope: crate::agents::AgentScope::Project,
                    workspace_id: None,
                    name: "Shared schedule".into(),
                    description: String::new(),
                    system_prompt: String::new(),
                    runtime_mode: crate::agents::RuntimeMode::Oneshot,
                    prompt_template: String::new(),
                    allowed_tools: Vec::new(),
                    schedule: Some(crate::agents::AgentScheduleConfig {
                        cron: "*/5 * * * *".into(),
                    }),
                    triggers: Vec::new(),
                    tags: Vec::new(),
                    notify_on_done: true,
                    preset_id: None,
                    previous_version: None,
                    created_at: 0,
                    updated_at: 0,
                    author: None,
                    last_edited_by: None,
                },
                Some(&project),
                None,
            )
            .unwrap();

        let now = chrono::Utc::now().timestamp_millis();
        let boundary = mk_run(
            "boundary-run",
            &first.id,
            AgentStatus::Done,
            Some(now - window_ms()),
        );
        let outside = mk_run(
            "outside-run",
            &first.id,
            AgentStatus::Done,
            Some(now - window_ms() - 1),
        );
        let suppressed = mk_run(
            "suppressed-run",
            &first.id,
            AgentStatus::Done,
            Some(now - 1),
        );
        for run in [boundary, outside, suppressed] {
            std::fs::write(agents.run_path(&run.id), serde_json::to_vec(&run).unwrap()).unwrap();
        }

        // GH #104: the improvement proposal this workspace is waiting on.
        let projects = config.join("projects");
        let workspace_dir = projects.join(&first.id);
        let mut proposal_file = crate::proposals::ProposalFile::default();
        proposal_file.proposal = Some(crate::proposals::StoredProposal {
            target: crate::proposals::ProposalTarget::Skill {
                name: "deploy".into(),
                path: ".claude/skills/deploy/SKILL.md".into(),
            },
            card_id: "assembly-review".into(),
            card_ref: "#88".into(),
            reason: "After card #88.".into(),
            words: "One line is added.".into(),
            diff: Some("--- a/x\n+++ b/x\n".into()),
            target_content_id: Some("abc".into()),
            target_blob: Some("0".repeat(40)),
            created_at: now,
            source: None,
        });
        crate::proposals::save(&workspace_dir, &proposal_file).unwrap();

        let seen = SeenStore::new(config).unwrap();
        seen.mark_seen(
            "owner@example.test",
            &["review:assembly-review:suppressed-run".into()],
            now - 10,
        )
        .unwrap();
        let feed = assemble_feed(
            &workspaces,
            &kanban,
            &agents,
            &projects,
            &seen,
            &InboxState::default(),
            "owner@example.test",
            now,
            false,
            None,
            None,
        )
        .unwrap();

        let ids = feed
            .events
            .iter()
            .map(|event| event.id.as_str())
            .collect::<HashSet<_>>();
        assert!(ids.contains("review:assembly-review:suppressed-run"));
        assert!(ids.contains("run:boundary-run"));
        assert!(!ids.contains("run:outside-run"));
        assert!(!ids.contains("run:suppressed-run"));
        // GH #104: one row per workspace with a proposal, with the board's words.
        let proposal_row = feed
            .events
            .iter()
            .find(|event| event.id == format!("proposal:{}", first.id))
            .expect("the improvement proposal is in the feed");
        assert_eq!(proposal_row.kind, InboxEventKind::SkillChangeWaiting);
        assert_eq!(proposal_row.group, InboxGroup::NeedsYou);
        assert_eq!(proposal_row.title, "A suggested skill change is waiting — deploy");
        assert_eq!(
            proposal_row.detail.as_deref(),
            Some(format!("After card #88 · {}", first.name).as_str())
        );
        assert!(proposal_row.seen_eligible);
        // GH #171: an agent with a schedule is listed nowhere as upcoming —
        // scheduled agents are retired and it will never fire.
        assert!(!feed
            .events
            .iter()
            .any(|event| event.id == format!("sched:{}", scheduled.id)));
        assert!(!feed
            .events
            .iter()
            .any(|event| event.kind == InboxEventKind::ScheduleUpcoming));
        assert_eq!(
            feed.events
                .iter()
                .find(|event| event.id == "review:assembly-review:suppressed-run")
                .unwrap()
                .seen_at,
            Some(now - 10)
        );
        let eligible = eligible_unseen_ids(&feed.events);
        assert_eq!(
            feed.eligibility_proof.eligible_unseen_set_sha256,
            canonical_id_set_sha256(&eligible).unwrap()
        );
        assert_eq!(feed.eligibility_proof.generated_at, feed.generated_at);
        assert_eq!(feed.eligibility_proof.by_kind["run_done"].total, 1);
        assert_eq!(
            feed.eligibility_proof.by_kind["skill_change_waiting"].total,
            1
        );
        assert_eq!(feed.eligibility_proof.by_kind["schedule_upcoming"].total, 0);
    }

    #[test]
    fn production_assembly_deduplicates_pr_sources_but_counts_admitted_targets() {
        let temp = TempDir::new().unwrap();
        let config = temp.path().to_path_buf();
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        let workspaces = WorkspaceStore::new(config.clone()).unwrap();
        for name in ["First", "Second"] {
            let workspace = workspaces
                .create(name.into(), project.to_string_lossy().into_owned())
                .unwrap();
            workspaces
                .set_kanban_sync(
                    &workspace.id,
                    crate::workspace::KanbanSyncMode::GitHubIssues,
                    Some("fixture/shared".into()),
                )
                .unwrap();
        }
        let kanban = KanbanStore::new(config.clone()).unwrap();
        let agents = AgentRegistry::new(&config).unwrap();
        let projects = config.join("projects");
        let seen = SeenStore::new(config).unwrap();
        let _ = crate::github::take_test_gh_invocations();
        crate::github::set_test_gh_responses(vec![Ok(
            r#"[{"number":1,"title":"Review","url":"https://example.invalid/1","author":{"login":"bot"}}]"#
                .into(),
        )]);
        let feed = assemble_feed(
            &workspaces,
            &kanban,
            &agents,
            &projects,
            &seen,
            &InboxState::default(),
            "local",
            chrono::Utc::now().timestamp_millis(),
            true,
            None,
            None,
        )
        .unwrap();
        crate::github::clear_test_gh_responses();
        assert_eq!(feed.eligibility_proof.admitted_pr_targets, 2);
        assert_eq!(feed.eligibility_proof.successful_pr_sources, 1);
        assert_eq!(feed.eligibility_proof.failed_pr_sources, 0);
        assert!(feed.eligibility_proof.pr_sources_complete);
        assert_eq!(feed.eligibility_proof.by_kind["pr_review"].total, 1);
        assert_eq!(crate::github::take_test_gh_invocations().len(), 1);
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct AttentionFixture {
        name: String,
        last_run_status: Option<LastRunStatus>,
        review_status: Option<ReviewStatus>,
        verify_status: VerifyStatus,
        ship_status: ShipStatus,
        column_id: KanbanColumnId,
        archived: bool,
        /// 1.169.1 (R1): the card's pull request, when the fixture has one.
        #[serde(default)]
        pr_url: Option<String>,
        #[serde(default)]
        pr: Option<crate::pr_status::PrStatus>,
        /// 1.170.0 (G6): a conflict record, when the fixture has one.
        #[serde(default)]
        ship_conflict: Option<crate::kanban::ShipConflict>,
        /// 1.173.0 (F1): the card's Builder, when the fixture has one.
        #[serde(default)]
        builder: Option<crate::kanban::BuilderState>,
        /// 1.175.0 (D3): open questions on its issue's title or brief.
        #[serde(default)]
        edit_conflicts: Vec<crate::issue_edit::EditConflict>,
        expected_wants: bool,
        /// P-A (UX P1 point 2): the card's Inbox group, as
        /// `cardPresentation.ts::recordInboxGroup` gives it from the record
        /// alone — "none" for no attention row.
        #[serde(default)]
        expected_group: Option<String>,
    }

    /// P-A: the group of a card's attention rows, one word — needs you
    /// outranks on hold, on hold outranks running; ships are history.
    /// 1.173.0 (F1): Failed folded into Needs you.
    fn card_group(events: &[InboxEvent]) -> &'static str {
        let has = |g: InboxGroup| events.iter().any(|e| e.group == g);
        if has(InboxGroup::NeedsYou) {
            "needs_you"
        } else if has(InboxGroup::OnHold) {
            "on_hold"
        } else if has(InboxGroup::Running) {
            "running"
        } else {
            "none"
        }
    }

    #[test]
    fn shared_attention_fixtures_keep_frontend_and_inbox_semantics_aligned() {
        let fixtures: Vec<AttentionFixture> =
            serde_json::from_str(include_str!("../../src/lib/attention.fixtures.json")).unwrap();
        for fixture in fixtures {
            let mut card = mk_card(&fixture.name, "ws1");
            card.last_run_status = fixture.last_run_status;
            card.review_status = fixture.review_status;
            card.verify_status = fixture.verify_status;
            card.ship_status = fixture.ship_status;
            card.column_id = fixture.column_id;
            card.archived = fixture.archived;
            card.pr_url = fixture.pr_url;
            card.pr = fixture.pr;
            card.ship_conflict = fixture.ship_conflict;
            card.builder = fixture.builder;
            card.edit_conflicts = fixture.edit_conflicts;

            let events = derive_card_events("WS", &[card.clone()], window_start());
            let workflow_wants = events
                .iter()
                .any(|event| event.group == InboxGroup::NeedsYou);

            assert_eq!(
                workflow_wants,
                fixture.expected_wants,
                "shared attention fixture: {}",
                fixture.name
            );
            if let Some(group) = fixture.expected_group.as_deref() {
                assert_eq!(
                    card_group(&events),
                    group,
                    "shared attention fixture's Inbox group (P-A): {}",
                    fixture.name
                );
            }
        }
    }

    #[test]
    fn a_ship_stopped_on_a_conflict_is_a_needs_you_row() {
        // P-A (UX P1 point 2): the Board and the card say "Ship stopped on a
        // conflict"; the Inbox had nothing (`conflict_blocked` is neither
        // None nor Pending).
        let mut card = mk_card("c-conflict", "ws1");
        card.last_run_status = Some(LastRunStatus::Success);
        card.review_status = Some(ReviewStatus::ConflictBlocked);
        card.verify_status = VerifyStatus::Passed;
        card.column_id = KanbanColumnId::Complete;
        card.linked_run_id = Some("run-3".into());
        let events = derive_card_events("WS", &[card], window_start());
        assert_eq!(events.len(), 1, "{events:?}");
        assert_eq!(events[0].id, "conflict:c-conflict:run-3");
        assert_eq!(events[0].group, InboxGroup::NeedsYou);
        assert_eq!(events[0].kind, InboxEventKind::ReviewNeeded);
        assert_eq!(events[0].detail.as_deref(), Some(SHIP_CONFLICT_DETAIL));
        assert!(events[0].seen_eligible);
    }

    /// 1.170.0 (G6, Challenger): a conflict met bringing in main's changes
    /// asks the person in a cold workspace too, in its own words, whatever
    /// the card's last run said — not while a turn runs.
    #[test]
    fn a_bring_in_conflict_is_a_needs_you_row_whatever_the_last_run() {
        let mut card = mk_card("c-sync", "ws1");
        card.review_status = Some(ReviewStatus::ConflictBlocked);
        card.ship_conflict = Some(crate::kanban::ShipConflict {
            paths: vec!["a.ts".into()],
            target_sha: "def".into(),
            at: 1,
            branch: "main".into(),
            merge_started_at: None,
            sync: true,
            review_before: None,
        });
        for last in [None, Some(LastRunStatus::Success), Some(LastRunStatus::Aborted)] {
            card.last_run_status = last.clone();
            let events = derive_card_events("WS", &[card.clone()], window_start());
            let rows: Vec<_> = events.iter().filter(|e| e.id.starts_with("conflict:")).collect();
            assert_eq!(rows.len(), 1, "{last:?}: {events:?}");
            assert_eq!(rows[0].group, InboxGroup::NeedsYou);
            assert_eq!(rows[0].detail.as_deref(), Some("conflict with main"), "{last:?}");
        }
        card.last_run_status = Some(LastRunStatus::Running);
        assert!(!derive_card_events("WS", &[card.clone()], window_start())
            .iter()
            .any(|e| e.id.starts_with("conflict:")));
        // A ship's conflict keeps its words.
        card.last_run_status = Some(LastRunStatus::Success);
        card.ship_conflict.as_mut().unwrap().sync = false;
        let events = derive_card_events("WS", &[card], window_start());
        assert_eq!(events[0].detail.as_deref(), Some(SHIP_CONFLICT_DETAIL));
    }

    #[test]
    fn a_merged_or_archived_conflict_card_asks_nothing() {
        let mut card = mk_card("c-conflict", "ws1");
        card.last_run_status = Some(LastRunStatus::Success);
        card.review_status = Some(ReviewStatus::ConflictBlocked);
        card.archived = true;
        assert!(derive_card_events("WS", &[card.clone()], window_start())
            .iter()
            .all(|e| e.group == InboxGroup::Shipped));
        card.archived = false;
        card.ship_status = ShipStatus::Shipped;
        assert!(!derive_card_events("WS", &[card], window_start())
            .iter()
            .any(|e| e.id.starts_with("conflict:")));
    }

    #[test]
    fn failed_card_yields_failed_event_with_stable_id() {
        let mut card = mk_card("c1", "ws1");
        card.last_run_status = Some(LastRunStatus::Failed);
        card.linked_run_id = Some("run-9".into());
        let events = derive_card_events("WS One", &[card], window_start());
        assert_eq!(events.len(), 1);
        // F1: the id is unchanged (a seen marker still finds it); the row is
        // a Needs you row now, where the Board has the card.
        assert_eq!(events[0].id, "failed:c1:run-9");
        assert_eq!(events[0].kind, InboxEventKind::CardFailed);
        assert_eq!(events[0].group, InboxGroup::NeedsYou);
        assert!(events[0].seen_eligible);
        // Not windowed: an unresolved failure from long ago still wants you.
        // (updated_at on a fresh card is "now"-ish but the derivation never
        // compared it to window_start — asserted by construction above.)
    }

    #[test]
    fn success_pending_review_yields_review_needed_and_merged_resolves_it() {
        let mut card = mk_card("c2", "ws1");
        card.last_run_status = Some(LastRunStatus::Success);
        let events = derive_card_events("WS", &[card.clone()], window_start());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, InboxEventKind::ReviewNeeded);
        assert_eq!(events[0].group, InboxGroup::NeedsYou);
        assert_eq!(events[0].id, "review:c2:manual");

        card.review_status = Some(ReviewStatus::Merged);
        let resolved = derive_card_events("WS", &[card], window_start());
        assert!(resolved.is_empty(), "merged review resolves the row");
    }

    /// H8 Mac walk: a skill card Plyloft wrote into a cold workspace's
    /// board reads ready to ship, the same row id; an ordinary card's row
    /// keeps no detail.
    #[test]
    fn a_skill_card_row_says_ready_to_ship() {
        let mut card = mk_card("skill", "ws1");
        card.last_run_status = Some(LastRunStatus::Success);
        card.verify_status = VerifyStatus::Passed;
        let plain = derive_card_events("WS", &[card.clone()], window_start());
        assert_eq!(plain[0].detail, None);
        card.kind = Some(crate::kanban::CardKind::Skill(crate::skill_card::SkillCard {
            verb: crate::skill_card::SkillVerb::Copy,
            skill: "x".into(),
            prefix: String::new(),
            origin: Default::default(),
            here: Default::default(),
            content: Default::default(),
            links: Vec::new(), renamed_to: None, link_before: None, link_after: None, align_winner: None, local_link: false, from_words: None,
            extra: Default::default(),
        }));
        let events = derive_card_events("WS", &[card], window_start());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "review:skill:manual");
        assert_eq!(events[0].detail.as_deref(), Some(SKILL_CARD_READY_DETAIL));
    }

    #[test]
    fn landed_card_suppresses_stale_workflow_attention() {
        let mut card = mk_card("landed", "ws1");
        card.last_run_status = Some(LastRunStatus::Failed);
        card.verify_status = VerifyStatus::Failed;
        card.review_status = Some(ReviewStatus::Merged);
        let events = derive_card_events("WS", &[card], window_start());
        assert!(
            events.is_empty(),
            "landing resolves stale run and verification attention"
        );
    }

    #[test]
    fn manual_complete_uses_a_stable_additive_receipt_id() {
        let mut card = mk_card("manual-complete", "ws1");
        card.column_id = KanbanColumnId::Complete;
        // Verified and not shipped: there is a decision to make.
        card.verify_status = VerifyStatus::Passed;
        let events = derive_card_events("WS", &[card], window_start());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "review:manual-complete:manual");
        assert_eq!(events[0].group, InboxGroup::NeedsYou);
    }

    /// GH #243: a card GitHub sync pulled to Complete because its issue was
    /// closed (no run, no checks, not landed) asks nothing of the person —
    /// the Board shows it in Done as "Closed".
    #[test]
    fn a_card_closed_without_work_is_not_a_decision() {
        let mut card = mk_card("gh-44", "ws1");
        card.column_id = KanbanColumnId::Complete;
        card.gh_issue_number = Some(44);
        card.notes = Some("A brief".into());
        assert!(derive_card_events("WS", &[card.clone()], window_start()).is_empty());
        card.verify_status = VerifyStatus::Legacy;
        assert!(derive_card_events("WS", &[card.clone()], window_start()).is_empty());
        // A run on record is still a decision.
        card.last_run_status = Some(LastRunStatus::Aborted);
        assert!(!derive_card_events("WS", &[card], window_start()).is_empty());
    }

    #[test]
    fn changes_requested_needs_attention_in_every_column() {
        for column_id in [
            KanbanColumnId::Todo,
            KanbanColumnId::InProgress,
            KanbanColumnId::Complete,
        ] {
            let mut card = mk_card("followup", "ws1");
            card.column_id = column_id;
            card.last_run_status = Some(LastRunStatus::Success);
            card.review_status = Some(ReviewStatus::ChangesRequested);
            let events = derive_card_events("WS", &[card], window_start());
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].id, "changes:followup:manual");
            assert_eq!(events[0].kind, InboxEventKind::ReviewNeeded);
            assert_eq!(events[0].group, InboxGroup::NeedsYou);
            assert_eq!(
                events[0].detail.as_deref(),
                Some("changes requested — needs you")
            );
        }
    }

    /// QoL 1.168 (F1): a Builder card has no run id, so its rows used to
    /// share `review:<card>:manual` — ready, changes requested and every
    /// later round. Each is its own row now: seen in round 1, a round 2
    /// result arrives unseen; a Finish and check on an unchanged tree is the
    /// same round.
    #[test]
    fn a_builder_cards_later_rounds_are_new_rows() {
        let builder = |snapshots: serde_json::Value| -> crate::kanban::BuilderState {
            serde_json::from_value(serde_json::json!({
                "vendor": "claude", "startedAt": 0, "snapshots": snapshots, "ptyId": "pty-1"
            }))
            .expect("a builder state")
        };
        let mut card = mk_card("b1", "ws1");
        card.last_run_status = Some(LastRunStatus::Success);
        card.builder = Some(builder(serde_json::json!([{ "n": 1, "sha": "a", "at": 100 }])));
        let id_of = |card: &KanbanCard| {
            let events = derive_card_events("WS", &[card.clone()], window_start());
            assert_eq!(events.len(), 1, "{events:?}");
            events[0].id.clone()
        };
        let ready1 = id_of(&card);
        assert_eq!(ready1, "review:b1:b1-100");

        card.review_status = Some(ReviewStatus::ChangesRequested);
        let changes1 = id_of(&card);
        assert_eq!(changes1, "changes:b1:b1-100");

        card.review_status = Some(ReviewStatus::Pending);
        card.builder = Some(builder(serde_json::json!([
            { "n": 1, "sha": "a", "at": 100 }, { "n": 2, "sha": "b", "at": 200 }
        ])));
        let ready2 = id_of(&card);
        assert_eq!(ready2, "review:b1:b2-200");
        card.last_run_status = Some(LastRunStatus::Failed);
        let failed2 = id_of(&card);
        assert_eq!(failed2, "failed:b1:b2-200");
        card.last_run_status = Some(LastRunStatus::Success);

        // Seen in round 1 (both rows): round 2's row is not seen.
        let dir = TempDir::new().unwrap();
        let store = SeenStore::new(dir.path().to_path_buf()).unwrap();
        store.mark_seen("local", &[ready1.clone(), changes1.clone()], NOW).unwrap();
        let seen = store.seen_map("local");
        assert!(seen.contains_key(&ready1) && seen.contains_key(&changes1));
        assert!(!seen.contains_key(&ready2), "the next round arrives unseen");
        let mut set = HashSet::new();
        for id in [&ready1, &changes1, &ready2, &failed2] {
            assert!(set.insert(id.clone()), "every round and verdict has its own id");
        }

        // A run id still wins (agent runs keep their ids).
        card.linked_run_id = Some("run-7".into());
        assert_eq!(id_of(&card), "review:b1:run-7");
    }

    /// QoL 1.168 (Challenger 5): a seen file written before rows carried
    /// their round keeps the rows it covers seen under their new ids; a
    /// round after the marker is new.
    #[test]
    fn a_seen_marker_from_before_rounds_carries_over() {
        let mut seen = HashMap::new();
        seen.insert("review:b1:manual".to_string(), 150);
        seen.insert("failed:b2:manual".to_string(), 500);
        // Round 1 recorded at 100, seen at 150 under the old id: still seen.
        assert_eq!(legacy_seen_at("review:b1:b1-100", Some(999), &seen), Some(150));
        assert_eq!(legacy_seen_at("changes:b1:b1-100", None, &seen), Some(150));
        // Round 2 at 200, after the marker: new.
        assert_eq!(legacy_seen_at("review:b1:b2-200", Some(10), &seen), None);
        // A run id's round uses the row's own time.
        assert_eq!(legacy_seen_at("changes:b1:run-7", Some(120), &seen), Some(150));
        assert_eq!(legacy_seen_at("changes:b1:run-7", Some(160), &seen), None);
        assert_eq!(legacy_seen_at("failed:b2:b3-400", None, &seen), Some(500));
        // The old id itself, other kinds and unknown cards carry nothing.
        assert_eq!(legacy_seen_at("review:b1:manual", Some(1), &seen), None);
        assert_eq!(legacy_seen_at("ship:b1:abc", Some(1), &seen), None);
        assert_eq!(legacy_seen_at("review:zz:b1-1", Some(1), &seen), None);
    }

    /// CL-3: a review that requests changes with a P1 open says so in the
    /// Inbox detail, read from the card's ledger (closed and P2 ones don't
    /// count), else from the review's findings.
    #[test]
    fn changes_requested_names_its_open_p1s() {
        use crate::review_ledger::{FindingState, LedgerFinding};
        let mut card = mk_card("p1", "ws1");
        card.last_run_status = Some(LastRunStatus::Success);
        card.review_status = Some(ReviewStatus::ChangesRequested);
        let ledger = |severity: &str, state: FindingState| LedgerFinding {
            id: "F1".into(),
            severity: Some(severity.into()),
            title: "T".into(),
            state,
            ..LedgerFinding::default()
        };
        let finding = |severity: &str| crate::review_passes::ReviewFinding {
            severity: Some(severity.into()),
            title: "T".into(),
            ..Default::default()
        };
        let with_review = |review: crate::kanban::BuilderReview| {
            let mut card = card.clone();
            let mut builder: crate::kanban::BuilderState =
                serde_json::from_str(r#"{"vendor":"claude"}"#).unwrap();
            builder.review = Some(review);
            card.builder = Some(builder);
            derive_card_events("WS", &[card], window_start())[0].detail.clone().unwrap()
        };
        assert_eq!(
            with_review(crate::kanban::BuilderReview {
                findings: vec![finding("P1"), finding("P2")],
                ..Default::default()
            }),
            "1 serious issue · changes requested"
        );
        assert_eq!(
            with_review(crate::kanban::BuilderReview {
                findings: vec![finding("P1")],
                ledger: vec![
                    ledger("P1", FindingState::Open),
                    ledger("P1", FindingState::StillOpen),
                    ledger("P1", FindingState::Closed),
                    ledger("P2", FindingState::Open),
                ],
                ..Default::default()
            }),
            "2 serious issues · changes requested"
        );
        assert_eq!(
            with_review(crate::kanban::BuilderReview { findings: vec![finding("P2")], ..Default::default() }),
            "changes requested — needs you"
        );

        // The fixtures `attention.ts::changesRequestedDetail` is held to.
        #[derive(serde::Deserialize)]
        struct Fixture {
            name: String,
            review: crate::kanban::BuilderReview,
            expected: String,
        }
        let fixtures: Vec<Fixture> =
            serde_json::from_str(include_str!("../../src/lib/p1Detail.fixtures.json")).unwrap();
        assert!(fixtures.len() >= 4);
        for fixture in fixtures {
            assert_eq!(with_review(fixture.review), fixture.expected, "{}", fixture.name);
        }
    }

    /// GH #104: the improvement proposal's row — one per workspace that has
    /// one, with the board's words, and nothing at all for a workspace without.
    #[test]
    fn an_improvement_proposal_is_one_inbox_row_per_workspace() {
        let temp = TempDir::new().unwrap();
        // Through the real store, so the rows are derived from the workspaces
        // the app actually has.
        let store = WorkspaceStore::new(temp.path().to_path_buf()).unwrap();
        let first = store
            .create("LYRA - Jun 2025".into(), temp.path().to_string_lossy().into_owned())
            .unwrap();
        let second = store
            .create("Ply".into(), temp.path().to_string_lossy().into_owned())
            .unwrap();
        let workspaces = store.snapshot().workspaces;
        let projects = temp.path().join("projects");

        // Nothing on disk: no rows, and no read that fails loudly.
        assert!(derive_proposal_events(&projects, &workspaces).is_empty());

        let mut file = crate::proposals::ProposalFile::default();
        file.proposal = Some(crate::proposals::StoredProposal {
            target: crate::proposals::ProposalTarget::Skill {
                name: "deploy".into(),
                path: ".claude/skills/deploy/SKILL.md".into(),
            },
            card_id: "card-88".into(),
            card_ref: "#88".into(),
            reason: "After card #88.".into(),
            words: "Four lines are added.".into(),
            diff: Some("--- a/x\n+++ b/x\n".into()),
            target_content_id: Some("abc".into()),
            target_blob: Some("0".repeat(40)),
            created_at: NOW,
            source: None,
        });
        crate::proposals::save(&projects.join(&first.id), &file).unwrap();

        let rows = derive_proposal_events(&projects, &workspaces);
        assert_eq!(rows.len(), 1, "one workspace has one, the other has none");
        assert_eq!(rows[0].id, format!("proposal:{}", first.id));
        assert_eq!(rows[0].kind, InboxEventKind::SkillChangeWaiting);
        assert_eq!(rows[0].group, InboxGroup::NeedsYou);
        assert_eq!(rows[0].title, "A suggested skill change is waiting — deploy");
        assert_eq!(
            rows[0].detail.as_deref(),
            Some("After card #88 · LYRA - Jun 2025")
        );
        assert_eq!(rows[0].card_id.as_deref(), Some("card-88"));
        assert!(rows[0].seen_eligible, "it is a notification, not status");

        // An instruction file gets its own noun.
        let mut instructions = crate::proposals::ProposalFile::default();
        instructions.proposal = Some(crate::proposals::StoredProposal {
            target: crate::proposals::ProposalTarget::Instructions { file: "AGENTS.md".into() },
            card_id: "card-90".into(),
            card_ref: "#90".into(),
            reason: "After card #90.".into(),
            words: "One rule is added.".into(),
            diff: Some("--- a/AGENTS.md\n+++ b/AGENTS.md\n".into()),
            target_content_id: Some("def".into()),
            target_blob: Some("1".repeat(40)),
            created_at: NOW,
            source: None,
        });
        crate::proposals::save(&projects.join(&second.id), &instructions).unwrap();
        let rows = derive_proposal_events(&projects, &workspaces);
        assert_eq!(rows.len(), 2);
        let instructions_row = rows
            .iter()
            .find(|row| row.id == format!("proposal:{}", second.id))
            .expect("the second workspace's row");
        assert_eq!(
            instructions_row.title,
            "A suggested change to AGENTS.md is waiting"
        );
        assert_eq!(instructions_row.detail.as_deref(), Some("After card #90 · Ply"));

        // Dismissed: the row goes with it.
        crate::proposals::dismiss(&projects.join(&first.id)).unwrap();
        let rows = derive_proposal_events(&projects, &workspaces);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, format!("proposal:{}", second.id));
    }

    /// 1.174.0 (DR4 round 1): the finished releases' log names a release
    /// with no card ("N other changes"), and gives a card row's release its
    /// one card.
    #[test]
    fn the_release_log_says_a_release_with_no_card() {
        let projects = tempfile::tempdir().unwrap();
        let ws: crate::workspace::Workspace = serde_json::from_value(serde_json::json!({
            "id": "ws1", "name": "WS", "cwd": "/nowhere", "createdAt": 1, "lastOpenedAt": 1
        }))
        .unwrap();
        let dir = projects.path().join("ws1");
        std::fs::create_dir_all(&dir).unwrap();
        crate::release_record::append_released(
            &dir,
            crate::release_record::ReleasedEntry { tag: "v1.0.1".into(), at: NOW - DAY_MS, cards: 0, other_changes: 2, card_id: None, card_title: None },
        )
        .unwrap();
        let mut events = Vec::new();
        apply_release_log(&mut events, projects.path(), &ws, window_start());
        assert_eq!(events.len(), 1);
        assert_eq!((events[0].title.as_str(), events[0].detail.as_deref()), ("v1.0.1 released", Some("2 other changes")));
        assert_eq!(events[0].kind, InboxEventKind::Released);
    }

    /// 1.174.0 (DR4): one row per release, whichever cards it carried; a
    /// card's own ship keeps its own row.
    #[test]
    fn a_release_is_one_row_naming_how_many_cards() {
        let entry = |sha: &str, tag: Option<&str>, at: i64| ShipEntry {
            commit_sha: sha.into(),
            shipped_version: "3.0.2".into(),
            release_kind: crate::kanban::ReleaseKind::PushOnly,
            shipped_at: at,
            target: Some("main".into()),
            tag: tag.map(str::to_string),
        };
        let mut a = mk_card("a", "ws1");
        a.ship_history.push(entry("own", None, NOW - 2 * DAY_MS));
        a.ship_history.push(entry("rel", Some("site-v3.0.2"), NOW - DAY_MS));
        let mut b = mk_card("b", "ws1");
        b.ship_history.push(entry("rel", Some("site-v3.0.2"), NOW - DAY_MS));
        let events = derive_card_events("WS", &[a, b], window_start());
        let released: Vec<_> = events.iter().filter(|e| e.kind == InboxEventKind::Released).collect();
        assert_eq!(released.len(), 1, "{events:?}");
        assert_eq!(released[0].id, "release:ws1:site-v3.0.2");
        assert_eq!(released[0].title, "site-v3.0.2 released");
        assert_eq!(released[0].detail.as_deref(), Some("2 cards"));
        // DR4 round 1: one card's release names it, and opens it.
        let mut c = mk_card("c", "ws1");
        c.ship_history.push(entry("one", Some("site-v3.0.3"), NOW - DAY_MS));
        let one = derive_card_events("WS", &[c], window_start());
        let row = one.iter().find(|e| e.kind == InboxEventKind::Released).unwrap();
        assert_eq!((row.detail.clone(), row.card_id.clone()), (Some("card c".to_string()), Some("c".to_string())));
        assert_eq!(released[0].card_id, None);
        assert_eq!(events.iter().filter(|e| e.kind == InboxEventKind::Shipped).count(), 1, "the card's own ship only");
    }

    #[test]
    fn archived_card_silences_attention_but_keeps_ship_history() {
        let mut card = mk_card("c3", "ws1");
        card.last_run_status = Some(LastRunStatus::Failed);
        card.archived = true;
        card.ship_history.push(ShipEntry {
            commit_sha: "abc123".into(),
            shipped_version: "v1.64.0".into(),
            release_kind: crate::kanban::ReleaseKind::Github,
            shipped_at: NOW - DAY_MS,
            target: None,
            tag: None,
        });
        let events = derive_card_events("WS", &[card], window_start());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, InboxEventKind::Shipped);
        assert_eq!(events[0].id, "ship:c3:abc123");
    }

    #[test]
    fn ship_entries_outside_window_are_excluded() {
        let mut card = mk_card("c4", "ws1");
        card.ship_history.push(ShipEntry {
            commit_sha: "old".into(),
            shipped_version: "v1.50.0".into(),
            release_kind: crate::kanban::ReleaseKind::Local,
            shipped_at: NOW - 30 * DAY_MS,
            target: None,
            tag: None,
        });
        card.ship_history.push(ShipEntry {
            commit_sha: "new".into(),
            shipped_version: "v1.64.0".into(),
            release_kind: crate::kanban::ReleaseKind::Local,
            shipped_at: NOW - DAY_MS,
            target: None,
            tag: None,
        });
        let events = derive_card_events("WS", &[card], window_start());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "ship:c4:new");
    }

    #[test]
    fn verify_failed_emits_its_own_row_with_summary() {
        let mut card = mk_card("c5", "ws1");
        card.verify_status = VerifyStatus::Failed;
        card.verify_history.push(VerifyEntry {
            verify_run_id: "vr-1".into(),
            tree_sha: None,
            status: VerifyStatus::Failed,
            ended_at: NOW - DAY_MS,
            summary: Some("verify failed: ppvp.sh failed at check #3".into()),
            steps: vec![
                step("cargo-test", true),
                step("ppvp-sh", false),
                step("tauri-build", true),
            ],
        });
        let events = derive_card_events("WS", &[card.clone()], window_start());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "verify:c5:vr-1");
        assert_eq!(events[0].group, InboxGroup::NeedsYou);
        // GH #269: one short fact, never the raw summary.
        assert_eq!(events[0].detail.as_deref(), Some("Project checks"));

        card.verify_history[0].steps[0].passed = false;
        let events = derive_card_events("WS", &[card.clone()], window_start());
        assert_eq!(events[0].detail.as_deref(), Some("2 of 3"));

        card.verify_history[0].steps.clear();
        let events = derive_card_events("WS", &[card], window_start());
        assert_eq!(events[0].detail, None);
    }

    fn step(kind: &str, passed: bool) -> VerifyStepResult {
        VerifyStepResult {
            kind: kind.into(),
            passed,
            elapsed_ms: 1,
            reason: (!passed).then(|| "2 tests failed in kanban::tests".into()),
        }
    }

    #[test]
    fn run_events_suppress_swarm_legs_and_card_linked_runs() {
        let mut swarm_leg = mk_run("r1", "ws1", AgentStatus::Done, Some(NOW - DAY_MS));
        swarm_leg.swarm_id = Some("swarm-1".into());
        let card_linked = mk_run("r2", "ws1", AgentStatus::Done, Some(NOW - DAY_MS));
        let standalone = mk_run("r3", "ws1", AgentStatus::Done, Some(NOW - DAY_MS));
        let suppressed: HashSet<String> = ["r2".to_string()].into_iter().collect();
        let names: HashMap<String, String> = [("ws1".to_string(), "WS".to_string())]
            .into_iter()
            .collect();
        let events = derive_run_events(
            &[swarm_leg, card_linked, standalone],
            &suppressed,
            &names,
            window_start(),
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "run:r3");
        // 1.173.0 (F1): a finished run asks nothing — News.
        assert_eq!(events[0].group, InboxGroup::News);
    }

    /// N14 (item 5): a card someone else claimed on GitHub that this Mac
    /// has not run asks nothing of this person — whatever column its issue
    /// labels put it in, the Inbox has no Needs you (or Failed) row for it,
    /// as the Board puts it under Waiting (`boardSemantics.ts`).
    #[test]
    fn a_card_claimed_by_a_teammate_and_not_run_here_is_no_inbox_ask() {
        for column in [KanbanColumnId::Todo, KanbanColumnId::InProgress, KanbanColumnId::Complete] {
            let mut card = mk_card("gh-issue-21", "ws1");
            card.column_id = column.clone();
            card.gh_issue_number = Some(21);
            card.notes = Some("the brief".into());
            card.gh_assignees = vec!["test-user".into()];
            card.gh_author = Some("test-user".into());
            let asks: Vec<_> = derive_card_events("WS", &[card], window_start())
                .into_iter()
                .filter(|e| e.group == InboxGroup::NeedsYou)
                .collect();
            assert!(asks.is_empty(), "{column:?}: {asks:?}");
        }
    }

    /// v1.154.1 (walk J5, G2): after a relaunch a card recorded as running
    /// whose session is gone is under Needs you ("session ended"), as the
    /// Board says — a single Builder, and both builds of Build with both.
    /// (1.173.0 F1: one marked `lost_on_restart` is On hold instead —
    /// `a_builder_paused_by_plyloft_s_quit_is_on_hold`.)
    #[test]
    fn a_running_card_whose_session_ended_needs_you() {
        let builder = |pty: Option<&str>| -> crate::kanban::BuilderState {
            serde_json::from_value(serde_json::json!({
                "vendor": "claude", "startedAt": 0, "snapshots": [], "ptyId": pty
            }))
            .expect("a builder state")
        };
        let mut live = mk_card("c1", "ws1");
        live.last_run_status = Some(LastRunStatus::Running);
        live.builder = Some(builder(Some("pty-1")));
        let mut ended = live.clone();
        ended.id = "c2".into();
        ended.builder = Some(builder(None));
        let lane = |id: &str, pty: Option<&str>| crate::build_both::BuildLane {
            lane: id.into(),
            vendor: if id == "b" { "codex".into() } else { "claude".into() },
            pty_id: pty.map(str::to_string),
            started_at: Some(1),
            ..Default::default()
        };
        let mut both = mk_card("c3", "ws1");
        both.last_run_status = Some(LastRunStatus::Running);
        both.build_both = Some(crate::build_both::BuildBoth {
            started_at: 1,
            lanes: vec![lane("a", None), lane("b", None)],
            ..Default::default()
        });
        let mut both_live = both.clone();
        both_live.id = "c4".into();
        both_live.build_both.as_mut().unwrap().lanes[1].pty_id = Some("pty-b".into());

        // A later session's end is a new row (its start is in the id).
        let mut restarted = ended.clone();
        restarted.builder.as_mut().unwrap().started_at = 99;
        let ids = |c: &KanbanCard| {
            derive_card_events("WS", std::slice::from_ref(c), window_start())
                .into_iter()
                .map(|e| e.id)
                .collect::<Vec<_>>()
        };
        assert_ne!(ids(&ended), ids(&restarted));
        let events = derive_card_events("WS", &[live, ended, both, both_live], window_start());
        let row = |card: &str| {
            events
                .iter()
                .find(|e| e.card_id.as_deref() == Some(card) && e.kind == InboxEventKind::CardRunning)
                .unwrap_or_else(|| panic!("a row for {card}"))
        };
        assert_eq!(row("c1").group, InboxGroup::Running);
        assert_eq!(row("c4").group, InboxGroup::Running);
        for card in ["c2", "c3"] {
            let ev = row(card);
            assert_eq!(ev.group, InboxGroup::NeedsYou, "{card}");
            assert_eq!(ev.detail.as_deref(), Some(SESSION_ENDED_DETAIL));
            assert!(ev.seen_eligible);
            assert!(ev.id.starts_with(&format!("session-ended:{card}:")), "{}", ev.id);
        }
    }

    /// F11 (team walk): a closed Builder session records its run as Aborted.
    /// The row is still "session ended" under Needs you — not a failed run —
    /// while a swarm's abort stays a failed one.
    #[test]
    fn a_closed_builders_aborted_run_is_a_session_ended_row_not_a_failure() {
        let mut closed = mk_card("c1", "ws1");
        closed.last_run_status = Some(LastRunStatus::Aborted);
        closed.builder = Some(
            serde_json::from_value(serde_json::json!({
                "vendor": "claude", "startedAt": 0, "snapshots": []
            }))
            .expect("a builder state"),
        );
        let mut swarm = mk_card("c2", "ws1");
        swarm.last_run_status = Some(LastRunStatus::Aborted);
        // A Builder card whose run a swarm or an agent run owns: theirs, failed.
        let mut owned_run = closed.clone();
        owned_run.id = "c3".into();
        owned_run.linked_run_id = Some("r1".into());
        let mut owned_swarm = closed.clone();
        owned_swarm.id = "c4".into();
        owned_swarm.linked_swarm_id = Some("s1".into());
        let events = derive_card_events("WS", &[closed, swarm, owned_run, owned_swarm], window_start());
        let of = |card: &str| {
            events
                .iter()
                .filter(|e| e.card_id.as_deref() == Some(card))
                .collect::<Vec<_>>()
        };
        let closed = of("c1");
        assert_eq!(closed.len(), 1, "{closed:?}");
        assert_eq!(closed[0].kind, InboxEventKind::CardRunning);
        assert_eq!(closed[0].group, InboxGroup::NeedsYou);
        assert_eq!(closed[0].detail.as_deref(), Some(SESSION_ENDED_DETAIL));
        for card in ["c2", "c3", "c4"] {
            let failed = of(card);
            assert!(
                failed.iter().any(|e| e.kind == InboxEventKind::CardFailed && e.detail.as_deref() == Some("aborted")),
                "{card}: {failed:?}"
            );
            assert!(!failed.iter().any(|e| e.detail.as_deref() == Some(SESSION_ENDED_DETAIL)), "{card}");
        }
    }

    /// 1.173.0 (F1, BI-7, owner D11): a Builder that was working when
    /// Plyloft quit is On hold ("paused when Plyloft closed"), under the same
    /// row id; one the person closed, one that ended by itself, or one whose
    /// Resume ended at once is still "session ended" under Needs you.
    #[test]
    fn a_builder_paused_by_plyloft_s_quit_is_on_hold() {
        let builder = |lost_on_restart: bool, resume_failed: bool| -> crate::kanban::BuilderState {
            serde_json::from_value(serde_json::json!({
                "vendor": "claude", "startedAt": 5, "snapshots": [],
                "sessionLost": true, "lostOnRestart": lost_on_restart, "resumeFailed": resume_failed
            }))
            .expect("a builder state")
        };
        let mut paused = mk_card("p1", "ws1");
        paused.last_run_status = Some(LastRunStatus::Running);
        paused.builder = Some(builder(true, false));
        let mut ended = paused.clone();
        ended.id = "p2".into();
        ended.builder = Some(builder(false, false));
        let mut quick = paused.clone();
        quick.id = "p3".into();
        quick.builder = Some(builder(true, true));
        // Closed by the person after the relaunch: Aborted, not paused.
        let mut closed = paused.clone();
        closed.id = "p4".into();
        closed.last_run_status = Some(LastRunStatus::Aborted);
        // Challenger 3: Plyloft quit during Finish and check's self-check —
        // it asks for Finish and check again, so it needs the person.
        let mut checking = paused.clone();
        checking.id = "p5".into();
        checking.builder.as_mut().unwrap().self_check_started_at = Some(4);
        let events = derive_card_events("WS", &[paused, ended, quick, closed, checking], window_start());
        let row = |card: &str| {
            let rows: Vec<_> = events.iter().filter(|e| e.card_id.as_deref() == Some(card)).collect();
            assert_eq!(rows.len(), 1, "{card}: {rows:?}");
            rows[0].clone()
        };
        let p = row("p1");
        assert_eq!((p.kind, p.group), (InboxEventKind::CardRunning, InboxGroup::OnHold));
        assert_eq!(p.detail.as_deref(), Some(PAUSED_ON_CLOSE_DETAIL));
        assert_eq!(p.id, "session-ended:p1:5", "the row keeps its id");
        // The Inbox words it by the same string (`inboxView.ts`).
        assert!(include_str!("../../src/lib/inboxView.ts")
            .contains(&format!("PAUSED_ON_CLOSE_DETAIL = {PAUSED_ON_CLOSE_DETAIL:?}")));
        for card in ["p2", "p3", "p4", "p5"] {
            let ev = row(card);
            assert_eq!(ev.group, InboxGroup::NeedsYou, "{card}");
            assert_eq!(ev.detail.as_deref(), Some(SESSION_ENDED_DETAIL), "{card}");
        }
    }

    /// 1.173.0 (F1, Challenger 6 and 7): a queued card is On hold, where the
    /// Board has it; an old "failed" group reads as Needs you.
    #[test]
    fn a_queued_card_is_on_hold_and_failed_reads_as_needs_you() {
        assert_eq!(serde_json::from_str::<InboxGroup>("\"failed\"").unwrap(), InboxGroup::NeedsYou);
        assert_eq!(serde_json::to_string(&InboxGroup::NeedsYou).unwrap(), "\"needs_you\"");
        assert_eq!(serde_json::to_string(&InboxGroup::OnHold).unwrap(), "\"on_hold\"");
        let mut card = mk_card("q1", "ws1");
        card.column_id = KanbanColumnId::InProgress;
        card.notes = Some("the brief".into());
        card.swarm_template_id = Some("solo".into());
        let queued: Vec<_> = derive_card_events("WS", &[card.clone()], window_start())
            .into_iter()
            .filter(|e| e.kind == InboxEventKind::CardQueued)
            .collect();
        assert!(card_is_queue_eligible(&card));
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].group, InboxGroup::OnHold);
        assert!(!queued[0].seen_eligible);
    }

    /// 1.173.0 (F1): a seen file written before Failed folded into Needs you
    /// loads through the real store, and every marker still finds its row —
    /// the ids did not change, only the groups — with other users' markers
    /// and the schema untouched. No stored value names a group.
    #[test]
    fn a_seen_file_from_before_f1_keeps_every_row_it_marked() {
        let dir = TempDir::new().unwrap();
        let inbox_dir = dir.path().join("inbox");
        std::fs::create_dir_all(&inbox_dir).unwrap();
        std::fs::write(
            inbox_dir.join("seen.json"),
            serde_json::json!({
                "schemaVersion": 1,
                "users": {
                    "local": { "failed:c1:run-9": NOW - 10, "verify:c5:vr-1": NOW - 9, "run:rd": NOW - 8 },
                    "ana@example.com": { "review:x:manual": NOW - 7 }
                }
            })
            .to_string(),
        )
        .unwrap();
        let store = SeenStore::new(dir.path().to_path_buf()).unwrap();
        let mut failed = mk_card("c1", "ws1");
        failed.last_run_status = Some(LastRunStatus::Failed);
        failed.linked_run_id = Some("run-9".into());
        let mut verify = mk_card("c5", "ws1");
        verify.verify_status = VerifyStatus::Failed;
        verify.verify_history.push(VerifyEntry {
            verify_run_id: "vr-1".into(),
            status: VerifyStatus::Failed,
            ended_at: NOW - DAY_MS,
            summary: None,
            steps: Vec::new(),
            tree_sha: None,
        });
        let names: HashMap<String, String> = [("ws1".to_string(), "WS".to_string())].into_iter().collect();
        let mut events = derive_card_events("WS", &[failed, verify], window_start());
        events.extend(derive_run_events(
            &[mk_run("rd", "ws1", AgentStatus::Done, Some(NOW - DAY_MS))],
            &HashSet::new(),
            &names,
            window_start(),
        ));
        let seen = store.seen_map("local");
        for id in ["failed:c1:run-9", "verify:c5:vr-1", "run:rd"] {
            let ev = events.iter().find(|e| e.id == id).unwrap_or_else(|| panic!("{id}"));
            assert!(seen.contains_key(&ev.id), "{id} keeps its marker");
            assert!(matches!(ev.group, InboxGroup::NeedsYou | InboxGroup::News), "{id}: {:?}", ev.group);
        }
        assert_eq!(store.seen_map("ana@example.com").len(), 1, "another user's markers survive");
        // A later write keeps every marker and the schema.
        store.mark_seen("local", &["review:c9:manual".to_string()], NOW).unwrap();
        let reread = SeenStore::new(dir.path().to_path_buf()).unwrap();
        assert_eq!(reread.seen_map("local").len(), 4);
        let raw: serde_json::Value = serde_json::from_slice(&std::fs::read(inbox_dir.join("seen.json")).unwrap()).unwrap();
        assert_eq!(raw["schemaVersion"], SEEN_SCHEMA_VERSION);
    }

    /// v1.154.1 round 3 (walk RW-B step 10): a card built by both whose
    /// comparison settled is under Needs you in the Board's words — before
    /// a quit (sessions live) and after (sessions gone, builds done).
    #[test]
    fn a_card_built_by_both_waiting_for_the_pick_needs_you() {
        let lane = |id: &str, pty: Option<&str>, failed: Option<&str>| crate::build_both::BuildLane {
            lane: id.into(),
            vendor: if id == "b" { "codex".into() } else { "claude".into() },
            pty_id: pty.map(str::to_string),
            started_at: Some(1),
            done: failed.is_none().then(|| crate::build_both::LaneSnapshot { sha: "s".into(), at: 2 }),
            failed: failed.map(str::to_string),
            ..Default::default()
        };
        let compare = |status: &str, rec: Option<&str>| crate::build_both::BuildCompare {
            status: status.into(),
            recommended: rec.map(str::to_string),
            started_at: 5,
            ..Default::default()
        };
        let card = |id: &str, lanes, cmp| {
            let mut c = mk_card(id, "ws1");
            c.last_run_status = Some(LastRunStatus::Running);
            c.build_both = Some(crate::build_both::BuildBoth { started_at: 1, lanes, compare: cmp, outcome: None });
            c
        };
        let live = card("c1", vec![lane("a", Some("p"), None), lane("b", Some("q"), None)], Some(compare("done", Some("a"))));
        let gone = card("c2", vec![lane("a", None, None), lane("b", None, None)], Some(compare("done", Some("b"))));
        let one = card("c3", vec![lane("a", None, Some("stopped")), lane("b", None, None)], Some(compare("decided", Some("b"))));
        let mut failed_lane = lane("b", None, None);
        failed_lane.verify = Some(crate::build_both::LaneVerify { status: "failed".into(), ..Default::default() });
        let left = card("c5", vec![lane("a", None, Some("stopped")), failed_lane], Some(compare("decided", Some("b"))));
        let comparing = card("c4", vec![lane("a", Some("p"), None), lane("b", Some("q"), None)], Some(compare("running", None)));
        let events = derive_card_events("WS", &[live, gone, one, comparing, left], window_start());
        let row = |card: &str| {
            events
                .iter()
                .find(|e| e.card_id.as_deref() == Some(card) && e.kind == InboxEventKind::CardRunning)
                .unwrap_or_else(|| panic!("a row for {card}"))
        };
        for card in ["c1", "c2"] {
            assert_eq!(row(card).group, InboxGroup::NeedsYou, "{card}");
            assert_eq!(row(card).detail.as_deref(), Some("Pick one of the two builds"));
            assert_eq!(row(card).id, format!("pick:{card}:5"));
        }
        assert_eq!(row("c3").detail.as_deref(), Some("Codex's build is ready to continue"));
        assert_eq!(row("c4").group, InboxGroup::Running, "still comparing");
        assert_eq!(row("c5").detail.as_deref(), Some("Only Codex's build is left"));
    }

    #[test]
    fn run_status_maps_to_groups_and_running_is_not_seen_eligible() {
        let names: HashMap<String, String> = [("ws1".to_string(), "WS".to_string())]
            .into_iter()
            .collect();
        let none = HashSet::new();
        let mut failed = mk_run("rf", "ws1", AgentStatus::Error, Some(NOW - DAY_MS));
        failed.error = Some("boom".into());
        let running = mk_run("rr", "ws1", AgentStatus::Running, None);
        let old_done = mk_run("ro", "ws1", AgentStatus::Done, Some(NOW - 20 * DAY_MS));
        let done = mk_run("rd", "ws1", AgentStatus::Done, Some(NOW - DAY_MS));
        let events = derive_run_events(&[failed, running, old_done, done], &none, &names, window_start());
        assert_eq!(events.len(), 3, "old done run aged out of the window");
        let f = events.iter().find(|e| e.id == "run:rf").unwrap();
        // F1: a failed run is a Needs you row; a finished one is News.
        assert_eq!(f.group, InboxGroup::NeedsYou);
        let d = events.iter().find(|e| e.id == "run:rd").unwrap();
        assert_eq!((d.kind, d.group), (InboxEventKind::RunDone, InboxGroup::News));
        // Challenger 1: a run the person stopped asks nothing — News.
        let killed = mk_run("rk", "ws1", AgentStatus::Killed, Some(NOW - DAY_MS));
        let k = derive_run_events(&[killed], &none, &names, window_start()).remove(0);
        assert_eq!((k.kind, k.group), (InboxEventKind::RunFailed, InboxGroup::News));
        assert_eq!(f.detail.as_deref(), Some("boom"));
        let r = events.iter().find(|e| e.id == "run:rr").unwrap();
        assert_eq!(r.group, InboxGroup::Running);
        assert!(!r.seen_eligible);
    }

    #[test]
    fn deleted_workspace_runs_are_skipped() {
        let names: HashMap<String, String> = HashMap::new();
        let run = mk_run("r9", "ws-gone", AgentStatus::Done, Some(NOW - DAY_MS));
        let events = derive_run_events(&[run], &HashSet::new(), &names, window_start());
        assert!(events.is_empty());
    }

    // ── Tier-2 schema tests: seen store ─────────────────────────────────────

    #[test]
    fn seen_store_missing_file_loads_empty() {
        let dir = TempDir::new().unwrap();
        let store = SeenStore::new(dir.path().to_path_buf()).unwrap();
        assert!(store.seen_map("local").is_empty());
    }

    #[test]
    fn strict_seen_store_allows_absence_and_refuses_corrupt_input_without_write() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("inbox").join("seen.json");
        let absent = SeenStore::new_read_only_strict(dir.path().to_path_buf()).unwrap();
        assert!(absent.seen_map("local").is_empty());
        assert!(!dir.path().join("inbox").exists());

        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{not json").unwrap();
        let before = std::fs::read(&path).unwrap();
        assert!(SeenStore::new_read_only_strict(dir.path().to_path_buf()).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);

        std::fs::write(&path, serde_json::to_vec(&SeenFile::default()).unwrap()).unwrap();
        assert!(SeenStore::new_read_only_strict(dir.path().to_path_buf()).is_ok());

        std::fs::write(&path, br#"{"schemaVersion":2,"users":{}}"#).unwrap();
        assert!(SeenStore::new_read_only_strict(dir.path().to_path_buf()).is_err());
    }

    #[test]
    fn seen_store_legacy_minimal_json_loads_with_defaults() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("inbox").join("seen.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{}").unwrap();
        let store = SeenStore::new(dir.path().to_path_buf()).unwrap();
        assert!(store.seen_map("local").is_empty());
        // And a corrupt file starts fresh instead of erroring.
        std::fs::write(&path, b"{not json").unwrap();
        let store2 = SeenStore::new(dir.path().to_path_buf()).unwrap();
        assert!(store2.seen_map("local").is_empty());
    }

    #[test]
    fn seen_store_round_trips_per_user_and_first_look_wins() {
        let dir = TempDir::new().unwrap();
        let store = SeenStore::new(dir.path().to_path_buf()).unwrap();
        let added = store
            .mark_seen("m@example.com", &["ev1".into(), "ev2".into()], NOW)
            .unwrap();
        assert_eq!(added, 2);
        // Re-marking keeps the original timestamp and reports 0 new.
        let again = store
            .mark_seen("m@example.com", &["ev1".into()], NOW + 1000)
            .unwrap();
        assert_eq!(again, 0);
        assert_eq!(store.seen_map("m@example.com").get("ev1"), Some(&NOW));
        // Other users are isolated.
        assert!(store.seen_map("local").is_empty());
        // Reload from disk: markers survive.
        let reloaded = SeenStore::new(dir.path().to_path_buf()).unwrap();
        assert_eq!(reloaded.seen_map("m@example.com").len(), 2);
    }

    #[test]
    fn checked_seen_write_compares_under_lock_before_creating_file() {
        let dir = TempDir::new().unwrap();
        let store = SeenStore::new(dir.path().to_path_buf()).unwrap();
        let path = dir.path().join("inbox").join("seen.json");
        let candidates = vec!["b".to_string(), "a".to_string()];
        assert!(store
            .mark_seen_if_set_matches("local", &candidates, &"0".repeat(64), NOW)
            .is_err());
        assert!(!path.exists());
        assert!(store.seen_map("local").is_empty());

        let expected = canonical_id_set_sha256(&candidates).unwrap();
        assert_eq!(
            store
                .mark_seen_if_set_matches("local", &candidates, &expected, NOW)
                .unwrap(),
            2
        );
        let first = std::fs::read(&path).unwrap();
        assert_eq!(store.seen_map("local").len(), 2);

        assert!(store
            .mark_seen_if_set_matches("local", &candidates, &expected, NOW + 1)
            .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), first);
    }

    #[test]
    fn checked_seen_write_rechecks_concurrent_seen_drift() {
        let dir = TempDir::new().unwrap();
        let store = SeenStore::new(dir.path().to_path_buf()).unwrap();
        store.mark_seen("local", &["a".into()], NOW).unwrap();
        let candidates = vec!["a".to_string(), "b".to_string()];
        let remaining_hash = canonical_id_set_sha256(&["b".into()]).unwrap();
        assert_eq!(
            store
                .mark_seen_if_set_matches("local", &candidates, &remaining_hash, NOW + 1)
                .unwrap(),
            1
        );
        assert_eq!(store.seen_map("local").get("a"), Some(&NOW));
        assert_eq!(store.seen_map("local").get("b"), Some(&(NOW + 1)));
    }

    #[test]
    fn legacy_receipt_ids_keep_seen_timestamps_after_reload() {
        let dir = TempDir::new().unwrap();
        let store = SeenStore::new(dir.path().to_path_buf()).unwrap();
        let ids = [
            "failed:c-failed:run-9".to_string(),
            "review:c-review:run-10".to_string(),
            "verify:c-verify:verify-11".to_string(),
        ];
        store.mark_seen("local", &ids, NOW).unwrap();
        let reloaded = SeenStore::new(dir.path().to_path_buf()).unwrap();

        let mut failed = mk_card("c-failed", "ws1");
        failed.last_run_status = Some(LastRunStatus::Failed);
        failed.linked_run_id = Some("run-9".to_string());
        let mut review = mk_card("c-review", "ws1");
        review.last_run_status = Some(LastRunStatus::Success);
        review.linked_run_id = Some("run-10".to_string());
        let mut verify = mk_card("c-verify", "ws1");
        verify.verify_status = VerifyStatus::Failed;
        verify.verify_history.push(VerifyEntry {
            verify_run_id: "verify-11".to_string(),
            tree_sha: None,
            status: VerifyStatus::Failed,
            ended_at: NOW,
            summary: None,
            steps: Vec::new(),
        });
        let mut events = derive_card_events("WS", &[failed, review, verify], window_start());
        let seen = reloaded.seen_map("local");
        for event in &mut events {
            event.seen_at = seen.get(&event.id).copied();
        }

        for id in ids {
            let event = events.iter().find(|event| event.id == id).unwrap();
            assert_eq!(event.seen_at, Some(NOW), "legacy receipt {id}");
        }
    }

    #[test]
    fn seen_store_prunes_only_stale_markers_on_save() {
        let dir = TempDir::new().unwrap();
        let store = SeenStore::new(dir.path().to_path_buf()).unwrap();
        let stale_at = NOW - 2 * window_ms() - DAY_MS;
        store.mark_seen("local", &["old".into()], stale_at).unwrap();
        store.mark_seen("local", &["fresh".into()], NOW).unwrap();
        let map = store.seen_map("local");
        assert!(map.contains_key("fresh"));
        assert!(!map.contains_key("old"), "stale marker pruned on save");
    }

    #[test]
    fn assemble_seen_join_marks_only_eligible_rows() {
        // Pure-ish: exercise the join logic through derive + a manual join,
        // mirroring assemble_feed's loop (assemble_feed itself needs managed
        // stores; the join is the part worth pinning).
        let mut card = mk_card("c1", "ws1");
        card.last_run_status = Some(LastRunStatus::Success);
        let mut events = derive_card_events("WS", &[card], window_start());
        let mut running = mk_run("rr", "ws1", AgentStatus::Running, None);
        running.workspace_id = "ws1".into();
        let names: HashMap<String, String> = [("ws1".to_string(), "WS".to_string())]
            .into_iter()
            .collect();
        events.extend(derive_run_events(
            &[running],
            &HashSet::new(),
            &names,
            window_start(),
        ));

        let dir = TempDir::new().unwrap();
        let store = SeenStore::new(dir.path().to_path_buf()).unwrap();
        store
            .mark_seen("local", &["review:c1:manual".into(), "run:rr".into()], NOW)
            .unwrap();
        let seen_map = store.seen_map("local");
        for ev in events.iter_mut() {
            if ev.seen_eligible {
                ev.seen_at = seen_map.get(&ev.id).copied();
            }
        }
        let review = events.iter().find(|e| e.id == "review:c1:manual").unwrap();
        assert_eq!(review.seen_at, Some(NOW));
        let run = events.iter().find(|e| e.id == "run:rr").unwrap();
        assert_eq!(run.seen_at, None, "running rows never take a seen marker");
    }

    // ── v1.80.0 (P2-2): activity stats fold ────────────────────────────────

    #[test]
    fn activity_median_is_over_ended_runs_in_the_window() {
        let ok1 = mk_run("a", "ws1", AgentStatus::Done, Some(NOW - 1_000));
        let mut ok2 = mk_run("b", "ws1", AgentStatus::Done, Some(NOW - 2_000));
        ok2.started_at = ok2.ended_at.unwrap() - 10_000; // 10s
        let failed = mk_run("c", "ws1", AgentStatus::Error, Some(NOW - 3_000));
        let running = mk_run("d", "ws1", AgentStatus::Running, None);
        let ancient = mk_run("e", "ws1", AgentStatus::Done, Some(1_000_000));
        let window = NOW - activity_window_ms();
        // durations sorted: [10s, 60s, 60s] → median 60
        assert_eq!(activity_median_run_secs(&[ok1, ok2, failed, running, ancient], window), Some(60));
        assert_eq!(activity_median_run_secs(&[], 0), None);
    }

    #[test]
    fn a_verify_pass_with_no_steps_is_no_checks() {
        use crate::kanban::{VerifyEntry, VerifyStepResult};
        let entry = |status: VerifyStatus, steps: usize| VerifyEntry {
            verify_run_id: "v".into(),
            status,
            ended_at: 1,
            summary: None,
            steps: (0..steps)
                .map(|_| VerifyStepResult {
                    kind: "script".into(),
                    passed: status == VerifyStatus::Passed,
                    elapsed_ms: 1,
                    reason: None,
                })
                .collect(),
            tree_sha: None,
        };
        assert_eq!(verify_row_state(&entry(VerifyStatus::Passed, 0)), Some("no_checks"));
        assert_eq!(verify_row_state(&entry(VerifyStatus::Passed, 2)), Some("passed"));
        assert_eq!(verify_row_state(&entry(VerifyStatus::Failed, 1)), Some("failed"));
        assert_eq!(verify_row_state(&entry(VerifyStatus::Skipped, 0)), None);
    }

    // ── QoL 11.1: History's folded rows ─────────────────────────────────

    fn ship(sha: &str, at: i64) -> ShipEntry {
        ShipEntry {
            commit_sha: sha.into(),
            shipped_version: "1.0.0".into(),
            release_kind: crate::kanban::ReleaseKind::Local,
            shipped_at: at,
            target: None,
            tag: None,
        }
    }

    fn verify(id: &str, status: VerifyStatus, steps: usize, at: i64) -> crate::kanban::VerifyEntry {
        crate::kanban::VerifyEntry {
            verify_run_id: id.into(),
            status,
            ended_at: at,
            summary: Some(format!("summary {id}")),
            steps: (0..steps)
                .map(|_| VerifyStepResult {
                    kind: "script".into(),
                    passed: status == VerifyStatus::Passed,
                    elapsed_ms: 1,
                    reason: None,
                })
                .collect(),
            tree_sha: None,
        }
    }

    #[test]
    fn a_shipped_card_with_no_checks_is_one_ships_row_not_two() {
        let mut card = mk_card("c1", "ws1");
        card.verify_history.push(verify("v1", VerifyStatus::Passed, 0, NOW - 2 * DAY_MS));
        card.ship_history.push(ship("aaaaaaa1", NOW - 2 * DAY_MS));
        card.ship_history.push(ship("bbbbbbb2", NOW - DAY_MS));
        card.ship_history.push(ship("old", NOW - 40 * DAY_MS));
        let out = card_activity_rows("ws1", "WS", &[card], window_start());
        assert_eq!(out.len(), 1, "no separate 'No checks set up' row");
        let r = &out[0];
        assert_eq!((r.kind.as_str(), r.state.as_str(), r.count), ("ship", "shipped", 2));
        assert_eq!(r.at, NOW - DAY_MS, "the latest ship");
        assert!(r.detail.ends_with("no checks set up"), "{}", r.detail);
    }

    #[test]
    fn an_area_release_row_names_its_own_tag() {
        let mut card = mk_card("c1", "ws1");
        card.verify_history.push(verify("v1", VerifyStatus::Passed, 2, NOW - DAY_MS));
        let mut entry = ship("abcdef12", NOW - DAY_MS);
        entry.shipped_version = "3.0.2".into();
        entry.tag = Some("site-v3.0.2".into());
        card.ship_history.push(entry);
        let out = card_activity_rows("ws1", "WS", &[card], window_start());
        let row = out.iter().find(|r| r.kind == "ship").expect("a ship row");
        assert!(row.detail.starts_with("site-v3.0.2 · abcdef1"), "{}", row.detail);
        let mut plain = mk_card("c2", "ws1");
        plain.ship_history.push(ship("1234567a", NOW - DAY_MS));
        let out = card_activity_rows("ws1", "WS", &[plain], window_start());
        assert!(out[0].detail.starts_with("v1.0.0 · 1234567"), "{}", out[0].detail);
    }

    #[test]
    fn a_card_is_one_checks_row_with_its_latest_result() {
        let mut card = mk_card("c1", "ws1");
        card.verify_history.push(verify("v1", VerifyStatus::Failed, 2, NOW - 3 * DAY_MS));
        card.verify_history.push(verify("v2", VerifyStatus::Passed, 2, NOW - DAY_MS));
        card.verify_history.push(verify("v3", VerifyStatus::Running, 2, NOW));
        card.ship_history.push(ship("abc", NOW - DAY_MS / 2));
        let mut unshipped = mk_card("c2", "ws1");
        unshipped.verify_history.push(verify("w1", VerifyStatus::Passed, 0, NOW - DAY_MS));
        let out = card_activity_rows("ws1", "WS", &[card, unshipped], window_start());
        let kinds: Vec<(&str, &str, &str, usize)> = out
            .iter()
            .map(|r| (r.card_id.as_deref().unwrap(), r.kind.as_str(), r.state.as_str(), r.count))
            .collect();
        assert_eq!(
            kinds,
            vec![
                ("c1", "ship", "shipped", 1),
                ("c1", "verify", "passed", 2),
                // Not shipped: its "no checks" stays a Checks row.
                ("c2", "verify", "no_checks", 1),
            ]
        );
        assert!(!out[0].detail.contains("no checks"));
    }

    #[test]
    fn builder_rounds_are_a_runs_row_and_counted() {
        let mut card = mk_card("c1", "ws1");
        card.builder = Some(
            serde_json::from_value(serde_json::json!({
                "vendor": "codex",
                "startedAt": NOW - 5 * DAY_MS,
                "snapshots": [
                    { "n": 1, "sha": "a", "at": NOW - 40 * DAY_MS },
                    { "n": 2, "sha": "b", "at": NOW - 2 * DAY_MS },
                    { "n": 3, "sha": "c", "at": NOW - DAY_MS }
                ]
            }))
            .unwrap(),
        );
        let mut live = mk_card("c2", "ws1");
        live.builder = Some(
            serde_json::from_value(serde_json::json!({
                "vendor": "claude", "startedAt": NOW - 1_000, "ptyId": "p1", "snapshots": []
            }))
            .unwrap(),
        );
        live.last_run_status = Some(LastRunStatus::Running);
        // 1.168.1 (A1): its session still open, its round done (Ready to
        // ship) — Built, not Working.
        let mut done_open = mk_card("c4", "ws1");
        done_open.builder = Some(
            serde_json::from_value(serde_json::json!({
                "vendor": "claude", "startedAt": NOW - 5_000, "ptyId": "p2",
                "snapshots": [{ "n": 1, "sha": "d", "at": NOW - 2_000 }]
            }))
            .unwrap(),
        );
        done_open.last_run_status = Some(LastRunStatus::Success);
        let never = mk_card("c3", "ws1");
        let out = card_activity_rows("ws1", "WS", &[card, live, never, done_open], window_start());
        let rows: Vec<(&str, &str, usize, &str)> = out
            .iter()
            .map(|r| (r.kind.as_str(), r.state.as_str(), r.count, r.detail.as_str()))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("build", "built", 2, "Codex · 2 rounds"),
                ("build", "working", 0, "Claude · 0 rounds"),
                ("build", "built", 1, "Claude · 1 round"),
            ]
        );
        assert_eq!(out[0].at, NOW - DAY_MS);
        assert_eq!(activity_tab("build"), "runs");
    }

    #[test]
    fn the_workspace_filter_applies_before_the_cap_and_totals_count_past_it() {
        let temp = TempDir::new().unwrap();
        let config = temp.path().to_path_buf();
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        let workspaces = WorkspaceStore::new(config.clone()).unwrap();
        let busy = workspaces.create("Busy".into(), project.to_string_lossy().into_owned()).unwrap();
        let quiet = workspaces.create("Quiet".into(), project.to_string_lossy().into_owned()).unwrap();
        let kanban = KanbanStore::new(config.clone()).unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let shipped = |id: String, ws: &str, at: i64| {
            let mut c = mk_card(&id, ws);
            c.ship_history.push(ship(&format!("sha-{id}"), at));
            c
        };
        let busy_cards: Vec<KanbanCard> = (0..ACTIVITY_MAX_ROWS + 5)
            .map(|i| shipped(format!("b{i}"), &busy.id, now - 1_000 - i as i64))
            .collect();
        // Older than every busy ship: an overall cap would drop them all.
        let quiet_cards: Vec<KanbanCard> =
            (0..3).map(|i| shipped(format!("q{i}"), &quiet.id, now - DAY_MS - i as i64)).collect();
        kanban.save(&busy.id, busy_cards).unwrap();
        kanban.save(&quiet.id, quiet_cards).unwrap();
        let agents = AgentRegistry::new(&config).unwrap();
        let swarms = crate::swarms::SwarmRegistry::new(config.join("swarms")).unwrap();
        let discussions = crate::discussion::DiscussionRegistry::new(config.join("discussions"), None).unwrap();
        let feed = |ws: Option<&str>| assemble_activity(&workspaces, &kanban, &agents, &swarms, &discussions, &[], ws, now);

        let all = feed(None);
        assert!(all.truncated);
        assert_eq!(all.rows.len(), ACTIVITY_MAX_ROWS);
        assert_eq!(all.tab_totals.get("ships"), Some(&(ACTIVITY_MAX_ROWS + 8)));
        assert!(all.rows.iter().all(|r| r.workspace_id == busy.id));

        let q = feed(Some(&quiet.id));
        assert!(!q.truncated, "the quiet workspace's ships are not cut by the busy one's");
        assert_eq!(q.rows.len(), 3);
        assert_eq!(q.tab_totals.get("ships"), Some(&3));

        let b = feed(Some(&busy.id));
        assert!(b.truncated);
        assert_eq!(b.tab_totals.get("ships"), Some(&(ACTIVITY_MAX_ROWS + 5)));
    }

    /// 1.168.1 (A4, owner 2026-10-22): deleting a card keeps its runs and
    /// checks in History, marked as from a deleted card and opening no card;
    /// a discussion of that card is marked the same way.
    #[test]
    fn a_deleted_cards_runs_and_checks_stay_marked_and_open_nothing() {
        let temp = TempDir::new().unwrap();
        let config = temp.path().to_path_buf();
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        let workspaces = WorkspaceStore::new(config.clone()).unwrap();
        let ws = workspaces.create("Lyra".into(), project.to_string_lossy().into_owned()).unwrap();
        let kanban = KanbanStore::new(config.clone()).unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let mut gone = mk_card("gone", &ws.id);
        gone.builder = Some(
            serde_json::from_value(serde_json::json!({
                "vendor": "claude", "startedAt": now - 5_000, "ptyId": "p1",
                "snapshots": [{ "n": 1, "sha": "a", "at": now - 4_000 }]
            }))
            .unwrap(),
        );
        gone.verify_history.push(verify("v1", VerifyStatus::Passed, 2, now - 3_000));
        let kept = mk_card("kept", &ws.id);
        kanban.save(&ws.id, vec![gone, kept.clone()]).unwrap();
        let agents = AgentRegistry::new(&config).unwrap();
        let swarms = crate::swarms::SwarmRegistry::new(config.join("swarms")).unwrap();
        let discussions = crate::discussion::DiscussionRegistry::new(config.join("discussions"), None).unwrap();
        let feed = || assemble_activity(&workspaces, &kanban, &agents, &swarms, &discussions, &[], None, now);
        let before: Vec<(String, Option<String>, bool)> =
            feed().rows.into_iter().map(|r| (r.id, r.card_id, r.card_deleted)).collect();
        assert_eq!(
            before,
            vec![
                ("verify:gone:v1".to_string(), Some("gone".to_string()), false),
                ("build:gone".to_string(), Some("gone".to_string()), false),
            ]
        );

        assert!(kanban.delete_card_without_issue(&ws.id, "gone").unwrap());
        let rows = feed().rows;
        let after: Vec<(&str, &str, Option<&str>, bool)> = rows
            .iter()
            .map(|r| (r.id.as_str(), r.state.as_str(), r.card_id.as_deref(), r.card_deleted))
            .collect();
        assert_eq!(
            after,
            vec![("verify:gone:v1", "passed", None, true), ("build:gone", "built", None, true)],
            "the same rows, marked, opening no card — and never Working"
        );
        assert_eq!(rows[1].title, "card gone");
        // A second delete path (no issue check) keeps it the same way.
        kanban.delete_card(&ws.id, "kept").unwrap();
        assert_eq!(kanban.deleted_cards(&ws.id).iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["kept", "gone"]);
        // The board file carries no deleted card.
        let board = std::fs::read_to_string(config.join("kanban/workspaces").join(format!("{}.json", ws.id))).unwrap();
        assert!(!board.contains("\"gone\""));
        // The workspace's removal takes them with it.
        kanban.delete_workspace(&ws.id).unwrap();
        assert!(kanban.deleted_cards(&ws.id).is_empty());
    }

    /// 1.168.1 (A4, Windows walk): a card deleted with its Builder round
    /// still open (working, never Finish and check) keeps its Runs row,
    /// stopped and marked — not Working, and the count stays.
    #[test]
    fn a_card_deleted_with_its_round_still_open_keeps_its_runs_row_stopped() {
        let temp = TempDir::new().unwrap();
        let config = temp.path().to_path_buf();
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        let workspaces = WorkspaceStore::new(config.clone()).unwrap();
        let ws = workspaces.create("Lyra".into(), project.to_string_lossy().into_owned()).unwrap();
        let kanban = KanbanStore::new(config.clone()).unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let mut open = mk_card("open", &ws.id);
        open.builder = Some(
            serde_json::from_value(serde_json::json!({
                "vendor": "codex", "startedAt": now - 5_000, "ptyId": "p1", "snapshots": []
            }))
            .unwrap(),
        );
        open.last_run_status = Some(LastRunStatus::Running);
        // Its session already stopped, the round never finished.
        let mut stopped = mk_card("stopped", &ws.id);
        stopped.builder = Some(
            serde_json::from_value(serde_json::json!({
                "vendor": "claude", "startedAt": now - 9_000, "snapshots": []
            }))
            .unwrap(),
        );
        stopped.last_run_status = Some(LastRunStatus::Running);
        // Never started a session: nothing to keep, as before.
        let never = mk_card("never", &ws.id);
        kanban.save(&ws.id, vec![open, stopped, never]).unwrap();
        let agents = AgentRegistry::new(&config).unwrap();
        let swarms = crate::swarms::SwarmRegistry::new(config.join("swarms")).unwrap();
        let discussions = crate::discussion::DiscussionRegistry::new(config.join("discussions"), None).unwrap();
        let feed = || assemble_activity(&workspaces, &kanban, &agents, &swarms, &discussions, &[], None, now);
        let before: Vec<(String, String)> = feed().rows.into_iter().map(|r| (r.id, r.state)).collect();
        assert_eq!(before, vec![("build:open".to_string(), "working".to_string())]);

        for id in ["open", "stopped", "never"] {
            assert!(kanban.delete_card_without_issue(&ws.id, id).unwrap());
        }
        let rows = feed().rows;
        let after: Vec<(&str, &str, &str, Option<&str>, bool, usize)> = rows
            .iter()
            .map(|r| (r.id.as_str(), r.state.as_str(), r.detail.as_str(), r.card_id.as_deref(), r.card_deleted, r.count))
            .collect();
        assert_eq!(
            after,
            vec![
                ("build:open", "aborted", "Codex · 0 rounds", None, true, 0),
                ("build:stopped", "aborted", "Claude · 0 rounds", None, true, 0),
            ]
        );
        // A deleted card with a finished round keeps its Built row only.
        let mut built = mk_card("built", &ws.id);
        built.builder = Some(
            serde_json::from_value(serde_json::json!({
                "vendor": "claude", "startedAt": now - 3_000, "ptyId": "p2",
                "snapshots": [{ "n": 1, "sha": "a", "at": now - 2_000 }]
            }))
            .unwrap(),
        );
        built.last_run_status = Some(LastRunStatus::Running);
        let rows = deleted_card_activity_rows(&ws.id, "Lyra", &[crate::kanban::history_of_deleted(&built, now)], now - activity_window_ms());
        assert_eq!(rows.iter().map(|r| (r.id.as_str(), r.state.as_str())).collect::<Vec<_>>(), [("build:built", "built")]);
    }

    /// A row of any kind whose card is gone from a readable board — here a
    /// discussion's — is marked and opens nothing; an unreadable board marks
    /// nothing.
    #[test]
    fn a_discussion_of_a_card_no_longer_on_its_board_is_marked_and_opens_nothing() {
        let row = ActivityRow {
            id: "discussion:d1".into(),
            kind: "discussion".into(),
            state: "completed".into(),
            title: String::new(),
            detail: String::new(),
            workspace_id: "ws1".into(),
            workspace_name: "WS".into(),
            card_id: Some("gone".into()),
            run_id: None,
            at: 1,
            count: 1,
            card_deleted: false,
        };
        let mut unreadable = row.clone();
        unreadable.workspace_id = "ws2".into();
        let mut live = row.clone();
        live.card_id = Some("here".into());
        let boards: HashMap<String, HashSet<String>> =
            HashMap::from([("ws1".to_string(), HashSet::from(["here".to_string()]))]);
        let mut rows = vec![row.clone(), unreadable, live];
        mark_deleted_cards(&mut rows, &boards);
        assert_eq!((rows[0].card_id.as_deref(), rows[0].card_deleted), (None, true));
        // A board that couldn't be read marks nothing.
        assert_eq!((rows[1].card_id.as_deref(), rows[1].card_deleted), (Some("gone"), false));
        assert_eq!((rows[2].card_id.as_deref(), rows[2].card_deleted), (Some("here"), false));
    }

    #[test]
    fn rows_are_capped_per_tab_not_overall() {
        let mk = |kind: &str, i: usize| ActivityRow {
            id: format!("{kind}{i}"),
            kind: kind.into(),
            state: "done".into(),
            title: String::new(),
            detail: String::new(),
            workspace_id: "ws1".into(),
            workspace_name: "WS".into(),
            card_id: None,
            run_id: None,
            at: i as i64,
            count: 1,
            card_deleted: false,
        };
        let mut rows: Vec<ActivityRow> = (0..ACTIVITY_MAX_ROWS + 5).map(|i| mk("run", i)).collect();
        rows.push(mk("ship", 0));
        rows.push(mk("discussion", 0));
        let (kept, truncated) = cap_per_tab(rows);
        assert!(truncated);
        assert_eq!(kept.iter().filter(|r| r.kind == "run").count(), ACTIVITY_MAX_ROWS);
        assert_eq!(kept.iter().filter(|r| r.kind != "run").count(), 2, "other tabs keep theirs");
        let (_, cut) = cap_per_tab(vec![mk("run", 1)]);
        assert!(!cut);
    }

    #[test]
    fn discussion_activity_is_discoverable_with_pause_and_card_link() {
        let mut paused =
            crate::discussion::DiscussionRecord::new("d1", "ws1", "Choose an API", NOW);
        paused.card_id = Some("card-1".into());
        paused.status = crate::discussion::DiscussionStatus::PausedProviderUnavailable;
        paused.current_phase = crate::discussion::DiscussionPhase::CrossReviews;
        paused.participants.synthesizer.provider = crate::coordination::Provider::Codex;
        paused.participants.synthesizer.version = "0.145.0".into();

        let mut ancient = crate::discussion::DiscussionRecord::new("d2", "ws1", "Old answer", 1);
        ancient.status = crate::discussion::DiscussionStatus::Completed;
        ancient.ended_at = Some(2);
        ancient.updated_at = 2;

        let names = HashMap::from([("ws1".to_string(), "Ply".to_string())]);
        let rows =
            discussion_activity_rows(vec![paused, ancient], &names, NOW - activity_window_ms());
        assert_eq!(rows.len(), 1, "old terminal discussions are windowed");
        assert_eq!(rows[0].id, "discussion:d1");
        assert_eq!(rows[0].kind, "discussion");
        assert_eq!(rows[0].state, "paused_provider_unavailable");
        assert_eq!(rows[0].card_id.as_deref(), Some("card-1"));
        assert!(rows[0].detail.contains("cross-reviews"));
        assert!(rows[0].detail.contains("Codex 0.145.0"));
    }


    /// 1.175.0 B2: a release whose install step waits for this computer's
    /// OK is a Needs-you row of its workspace, read from
    /// `worktree_setup.json`; a file from before 1.175.0 gives none, and the
    /// row goes with the wait.
    #[test]
    fn b2_an_install_step_waiting_for_the_ok_is_a_needs_you_row() {
        let root = tempfile::tempdir().unwrap();
        let ws: crate::workspace::Workspace = serde_json::from_value(serde_json::json!({
            "id": "ws-1", "name": "Lyra", "cwd": "/tmp/lyra", "createdAt": 0, "lastOpenedAt": 0
        }))
        .unwrap();
        let dir = root.path().join("ws-1");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(crate::worktree_setup::SETTINGS_FILENAME);
        std::fs::write(&path, r#"{"worktreeSetup":"npm ci","approvedSetup":"npm ci"}"#).unwrap();
        assert!(derive_install_ok_events(root.path(), std::slice::from_ref(&ws)).is_empty(), "a 1.174.5 file asks nothing");
        std::fs::write(
            &path,
            serde_json::json!({
                "approvedInstall": { "path": "scripts/install.sh" },
                "installChanged": { "who": "example-teammate", "at": 1_700_000_000_000i64 },
                "installWaiting": { "tag": "v1.4.0", "at": 1_700_000_100_000i64 }
            })
            .to_string(),
        )
        .unwrap();
        let events = derive_install_ok_events(root.path(), std::slice::from_ref(&ws));
        assert_eq!(events.len(), 1);
        let row = &events[0];
        assert_eq!(row.id, "install-ok:ws-1:v1.4.0");
        assert_eq!(row.group, InboxGroup::NeedsYou);
        assert_eq!(row.title, "v1.4.0's install step needs your OK");
        assert_eq!(row.detail.as_deref(), Some("example-teammate changed \u{201c}After a release, run\u{201d}"));
        assert_eq!(row.at, Some(1_700_000_100_000));
        // A card shipped by a merge here has no version; nobody known is "Someone".
        std::fs::write(&path, r#"{"approvedInstall":{},"installWaiting":{"tag":"v1.4.0","at":5}}"#).unwrap();
        let first = derive_install_ok_events(root.path(), std::slice::from_ref(&ws)).remove(0);
        assert_eq!(first.detail, Some(format!("\u{201c}After a release, run\u{201d} hasn't run on {} before", crate::platform::THIS_MACHINE)), "nobody changed it (round 2)");
        std::fs::write(&path, r#"{"approvedInstall":{"path":"scripts/install.sh"},"installWaiting":{"at":5}}"#).unwrap();
        let row = derive_install_ok_events(root.path(), std::slice::from_ref(&ws)).remove(0);
        assert_eq!(row.title, "The install step needs your OK");
        assert_eq!(row.detail.as_deref(), Some("Someone changed \u{201c}After a release, run\u{201d}"));
        std::fs::write(&path, r#"{"approvedInstall":{"path":"scripts/deploy-all.sh"}}"#).unwrap();
        assert!(derive_install_ok_events(root.path(), &[ws]).is_empty(), "allowed: gone");
    }

    /// 1.173.0 (C3): a shared setting waiting for a choice is a Needs-you
    /// row of its workspace, read from the publish queue on disk, and goes
    /// once answered.
    #[test]
    fn c3_a_held_shared_setting_is_a_needs_you_row() {
        let root = tempfile::tempdir().unwrap();
        let ws: crate::workspace::Workspace = serde_json::from_value(serde_json::json!({
            "id": "ws-1", "name": "Lyra", "cwd": "/tmp/lyra", "createdAt": 0, "lastOpenedAt": 0
        }))
        .unwrap();
        let dir = root.path().join("ws-1");
        std::fs::create_dir_all(&dir).unwrap();
        let queue = serde_json::json!({
            "schemaVersion": 1,
            "fields": {
                "versionFiles": {
                    "value": [{ "path": "a.json" }, { "path": "shopify/package.json" }],
                    "base": [],
                    "conflict": {
                        "theirs": [{ "path": "a.json" }],
                        "author": "matteo", "device": "MacBook Pro", "samePerson": true,
                        "changedAt": 1_700_000_000
                    }
                },
                "name": { "value": "Lyra 2", "base": "Lyra" }
            }
        });
        let path = dir.join(crate::shared_config::QUEUE_FILENAME);
        std::fs::write(&path, queue.to_string()).unwrap();
        let events = derive_setting_conflict_events(root.path(), std::slice::from_ref(&ws));
        assert_eq!(events.len(), 1, "only the held field asks");
        let row = &events[0];
        assert_eq!(row.kind, InboxEventKind::SharedSettingConflict);
        assert_eq!(row.group, InboxGroup::NeedsYou);
        assert_eq!(row.workspace_id, "ws-1");
        assert!(row.title.ends_with("changed: Version files"), "{}", row.title);
        assert_eq!(row.id, "setting-conflict:ws-1:versionFiles:1700000000");
        assert_eq!(row.at, Some(1_700_000_000_000));
        assert!(row.seen_eligible);

        std::fs::write(&path, serde_json::json!({ "schemaVersion": 1, "fields": {} }).to_string()).unwrap();
        assert!(derive_setting_conflict_events(root.path(), &[ws]).is_empty(), "answered: gone");
    }

    /// 1.173.0 (E1): a Next improvement direction field both sides changed
    /// is the same row, with no definition queue at all.
    #[test]
    fn e1_a_direction_field_both_sides_changed_is_the_same_needs_you_row() {
        let root = tempfile::tempdir().unwrap();
        let ws: crate::workspace::Workspace = serde_json::from_value(serde_json::json!({
            "id": "ws-1", "name": "Lyra", "cwd": "/tmp/lyra", "createdAt": 0, "lastOpenedAt": 0
        }))
        .unwrap();
        let dir = root.path().join("ws-1");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("areas.json"), r#"{"schemaVersion":1,"areas":[{"id":"site","name":"Site"}]}"#).unwrap();
        let queue = serde_json::json!({
            "areas": { "site": {
                "value": { "better": "Fast on a phone." },
                "conflicts": { "better": { "theirs": "Clear pricing.", "author": "bob", "changedAt": 1_700_000_000 } }
            } }
        });
        std::fs::write(dir.join(crate::next_improvement::QUEUE_FILENAME), queue.to_string()).unwrap();
        let events = derive_setting_conflict_events(root.path(), std::slice::from_ref(&ws));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "setting-conflict:ws-1:ni-site-better:1700000000");
        assert_eq!(events[0].title, "A setting bob changed too: Next improvement · What “better” means here (Site)");
    }

    /// 1.173.0 (E3), 1.174.0 (A5): a round's ideas waiting are a News row
    /// per area, with the unanswered ideas counted and the round's byline
    /// as its detail; it stays while one is unanswered, and every idea made
    /// a card or set aside takes it away; a running round has none; a new
    /// round is a new row.
    #[test]
    fn e3_a_round_with_ideas_waiting_is_a_news_row() {
        use crate::next_improvement::round::{self, Idea, Round, RoundFile, RoundStatus};
        let root = tempfile::tempdir().unwrap();
        let ws: crate::workspace::Workspace = serde_json::from_value(serde_json::json!({
            "id": "ws-1", "name": "Lyra", "cwd": "/tmp/lyra", "createdAt": 0, "lastOpenedAt": 0
        }))
        .unwrap();
        let idea = |id: &str| Idea { id: id.to_string(), title: format!("Idea {id}"), ..Idea::default() };
        let mut file = RoundFile {
            area: "site".into(),
            current: Some(Round {
                id: "r-7".into(),
                status: RoundStatus::Ready,
                started_at: 1_000,
                ended_at: Some(2_000),
                area_name: "Site".into(),
                ideas: vec![idea("a"), idea("b"), Idea { dismissed: true, ..idea("c") }],
                ..Round::default()
            }),
            ..RoundFile::default()
        };
        let path = round::round_path(root.path(), "ws-1", "site").unwrap();
        round::save(&path, &file).unwrap();
        // A shots folder beside the files is not a round.
        std::fs::create_dir_all(round::round_dir(root.path(), "ws-1").unwrap().join("shots")).unwrap();
        let events = derive_next_improvement_events(root.path(), std::slice::from_ref(&ws));
        assert_eq!(events.len(), 1);
        let row = &events[0];
        assert_eq!(row.kind, InboxEventKind::NextImprovementIdeas);
        assert_eq!(row.group, InboxGroup::News);
        assert_eq!(row.id, "next-improvement:ws-1:site:r-7");
        assert_eq!(row.detail.as_deref(), Some(round::byline(file.current.as_ref().unwrap()).as_str()));
        assert_eq!(row.title, "Next improvement for Site: 2 ideas");
        assert_eq!(row.at, Some(2_000));
        assert!(row.seen_eligible);

        // A card made of one: the other still waits, and the row stays with
        // the same id, counting only the unanswered one (1.173.0 walk).
        file.current.as_mut().unwrap().ideas[0].card_id = Some("card-1".into());
        round::save(&path, &file).unwrap();
        let events = derive_next_improvement_events(root.path(), std::slice::from_ref(&ws));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "next-improvement:ws-1:site:r-7");
        assert_eq!(events[0].title, "Next improvement for Site: 1 idea");
        // The other made a card too: every idea is answered.
        file.current.as_mut().unwrap().ideas[1].card_id = Some("card-2".into());
        round::save(&path, &file).unwrap();
        assert!(derive_next_improvement_events(root.path(), std::slice::from_ref(&ws)).is_empty());
        file.current.as_mut().unwrap().ideas[1].card_id = None;

        // Every idea answered.
        let current = file.current.as_mut().unwrap();
        current.ideas[0].card_id = None;
        for i in current.ideas.iter_mut() {
            i.dismissed = true;
        }
        round::save(&path, &file).unwrap();
        assert!(derive_next_improvement_events(root.path(), std::slice::from_ref(&ws)).is_empty());

        // Still proposing: nothing to choose yet.
        let current = file.current.as_mut().unwrap();
        current.ideas[0].dismissed = false;
        current.status = RoundStatus::Running;
        round::save(&path, &file).unwrap();
        assert!(derive_next_improvement_events(root.path(), std::slice::from_ref(&ws)).is_empty());

        // C15: a new round proposing keeps the last round's unanswered
        // ideas, which still wait: the row counts them.
        file.current.as_mut().unwrap().ideas[0].carried_from = Some(6);
        round::save(&path, &file).unwrap();
        let events = derive_next_improvement_events(root.path(), std::slice::from_ref(&ws));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].title, "Next improvement for Site: 1 idea");
        file.current.as_mut().unwrap().ideas[0].carried_from = None;
        round::save(&path, &file).unwrap();

        // A change under way on one idea: the others still wait.
        file.current.as_mut().unwrap().change =
            Some(round::Change { idea_id: "a".into(), comment: "lighter".into(), started_at: 1 });
        round::save(&path, &file).unwrap();
        assert_eq!(derive_next_improvement_events(root.path(), std::slice::from_ref(&ws)).len(), 1);

        // Stopped or timed out with its ideas kept: they still wait.
        for status in [RoundStatus::Stopped, RoundStatus::TimedOut] {
            let current = file.current.as_mut().unwrap();
            current.change = None;
            current.status = status;
            round::save(&path, &file).unwrap();
            let events = derive_next_improvement_events(root.path(), std::slice::from_ref(&ws));
            assert_eq!(events.len(), 1, "{status:?}");
            assert_eq!(events[0].title, "Next improvement for Site: 1 idea");
        }

        // A new round with ideas is a new row: its own id, so unseen again.
        let current = file.current.as_mut().unwrap();
        current.id = "r-8".into();
        current.status = RoundStatus::Ready;
        round::save(&path, &file).unwrap();
        let events = derive_next_improvement_events(root.path(), std::slice::from_ref(&ws));
        assert_eq!(events[0].id, "next-improvement:ws-1:site:r-8");
        assert_eq!(events[0].group, InboxGroup::News);

        // Without areas: no area named.
        assert_eq!(next_improvement_row_title("", 1), "Next improvement: 1 idea");
    }
}
