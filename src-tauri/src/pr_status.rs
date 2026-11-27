//! SL-1 (ship loop): a card's pull request, read back from GitHub after
//! `card_ship` opened it — its checks on GitHub, review decision, whether it
//! can merge, and whether it merged or was closed.
//!
//! The state lives on the card (`KanbanCard::pr`, serde default, no schema
//! bump). One `gh pr view <url> --json …` per refresh, bounded and run as the
//! workspace's GitHub account (`github::gh_output`). Refreshes come from a
//! background poller (`start_poller`, beside the intake sweeper), from the
//! card page when it opens, and from its Refresh.
//!
//! "Checks on GitHub" are the pull request's status checks (CI). They are
//! not Plyloft's own **Checks** (the verify pipeline, `verify_status`), and
//! nothing here reads or writes those.
//!
//! What a refresh changes on the card:
//! - merged → `ship_status = Shipped` and one `ShipEntry` (the merge
//!   commit), then the worktree is pruned like `land_card_local` does and the
//!   local branch removed — only while the branch is still at the pull
//!   request's head (`worktrees::prune_pr_merged_card`);
//! - closed without merge → `review_status` back to `Pending` (the card is
//!   ready to ship again), worktree and branch kept;
//! - reopened → `review_status = Merged` again (the work is in the PR);
//! - open with no `review_status` (v1.154.0's review loop erased it) →
//!   `Merged` again (v1.154.1, F11). The review loop now puts `Merged` back
//!   itself when it clears its own word (`cleared_review_status`).
//!
//! `review_status = Merged` is still set when the PR is opened
//! (`mark_card_pr_shipped`), as before: every "landed" reader (blockers,
//! the Board's Done, the Inbox) keeps working. `pr.state` is what says whether
//! the pull request is open, merged or closed.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::kanban::{KanbanCard, ReleaseKind, ReviewStatus, ShipEntry, ShipStatus};

/// The fields one refresh reads. `gh pr view --help` (gh 2.101) lists each.
pub const PR_VIEW_FIELDS: &str = "number,state,mergeable,mergeStateStatus,statusCheckRollup,\
reviewDecision,latestReviews,mergedAt,closedAt,headRefOid,mergeCommit,url,headRefName,isCrossRepository,\
title,autoMergeRequest";

/// SL-3: [`PR_VIEW_FIELDS`] without `autoMergeRequest`, for a `gh` too old to
/// know it (the doctor sets no minimum gh version). Read this way, the
/// card's auto-merge stays as it was recorded.
pub const PR_VIEW_FIELDS_WITHOUT_AUTO_MERGE: &str = "number,state,mergeable,mergeStateStatus,\
statusCheckRollup,reviewDecision,latestReviews,mergedAt,closedAt,headRefOid,mergeCommit,url,headRefName,\
isCrossRepository,title";

/// `gh pr view --json` refused `autoMergeRequest` as a field it doesn't know.
pub fn gh_lacks_auto_merge_field(stderr: &str) -> bool {
    stderr.contains("Unknown JSON field") && stderr.contains("autoMergeRequest")
}

/// A changes-requested review's text is kept to this many characters.
const REVIEW_TEXT_MAX: usize = 2000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum PrState {
    #[default]
    Open,
    Merged,
    Closed,
}

/// The pull request's status checks on GitHub, summed up.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum PrChecks {
    /// GitHub reports no checks (or none read yet).
    #[default]
    None,
    Pending,
    Passing,
    Failing,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum PrMergeable {
    /// GitHub hasn't computed it yet (right after a push), or it is merged.
    #[default]
    Unknown,
    Mergeable,
    Conflicting,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum PrReviewDecision {
    #[default]
    None,
    ReviewRequired,
    Approved,
    ChangesRequested,
}

/// One failing check on GitHub: its name and the page that shows it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrCheck {
    pub name: String,
    /// The Actions workflow the check belongs to (`None` for a commit
    /// status or an app's check).
    #[serde(default)]
    pub workflow: Option<String>,
    /// The page of this job (SL-2 reads each job's log from it).
    #[serde(default)]
    pub url: Option<String>,
}

impl PrCheck {
    /// "workflow / name" when the workflow says something the name doesn't.
    pub fn label(&self) -> String {
        match self.workflow.as_deref() {
            Some(w) if !w.is_empty() && w != self.name => format!("{w} / {}", self.name),
            _ => self.name.clone(),
        }
    }
}

/// The latest review that asked for changes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrChangesRequest {
    #[serde(default)]
    pub author: Option<String>,
    /// The review's text, trimmed and capped at `REVIEW_TEXT_MAX`.
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub submitted_at: Option<i64>,
}

/// SL-1: what Plyloft last read of a card's pull request. Every field is
/// defaulted, so a later field never stops an older file from loading.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrStatus {
    pub number: u64,
    #[serde(default)]
    pub state: PrState,
    #[serde(default)]
    pub checks: PrChecks,
    #[serde(default)]
    pub checks_total: u32,
    #[serde(default)]
    pub checks_passed: u32,
    #[serde(default)]
    pub checks_pending: u32,
    /// Failing checks by name, each once.
    #[serde(default)]
    pub failing_checks: Vec<PrCheck>,
    #[serde(default)]
    pub mergeable: PrMergeable,
    /// GitHub's `mergeStateStatus` as read (`clean`, `blocked`, `dirty`,
    /// `behind`, `unstable`, …), lowercased — for SL-3's Merge.
    #[serde(default)]
    pub merge_state: Option<String>,
    #[serde(default)]
    pub review_decision: PrReviewDecision,
    #[serde(default)]
    pub changes_requested: Option<PrChangesRequest>,
    /// The PR's head commit — what a merge took.
    #[serde(default)]
    pub head_sha: Option<String>,
    #[serde(default)]
    pub merge_commit: Option<String>,
    /// When Plyloft opened (or linked) it.
    #[serde(default)]
    pub opened_at: Option<i64>,
    #[serde(default)]
    pub merged_at: Option<i64>,
    #[serde(default)]
    pub closed_at: Option<i64>,
    /// When GitHub was last read for it. `None` until the first read.
    #[serde(default)]
    pub checked_at: Option<i64>,
    /// After a merge: why the worktree or the branch was kept, when it was.
    #[serde(default)]
    pub cleanup_kept: Option<String>,
    /// Since when this head has been read at the fast cadence — checks
    /// pending, or waiting on GitHub's own merge (`watched_closely`) — for
    /// the cap: over an hour is read every 10 min.
    #[serde(default)]
    pub pending_since: Option<i64>,
    /// SL-3: GitHub merges it when its checks pass (`autoMergeRequest` is
    /// set). Read from GitHub on every refresh, so it stays true to it.
    #[serde(default)]
    pub auto_merge: bool,
    /// SL-3: GitHub's own answer when "Merge when checks pass" couldn't be
    /// turned on (the repository doesn't allow it, its base branch requires
    /// nothing to wait for…). Plyloft's, kept across reads until auto-merge
    /// is on.
    #[serde(default)]
    pub auto_merge_refused: Option<String>,
    /// v1.154.1 (walk I1): when Push update last sent a commit to it. With
    /// `opened_at`, the start of the wait for GitHub to register the checks
    /// of what was just sent (`awaiting_checks`). Plyloft's, kept across reads.
    #[serde(default)]
    pub pushed_at: Option<i64>,
    /// v1.154.1 (walk I1): the commit Push update sent. A read that still
    /// shows another head is GitHub not having caught up yet.
    #[serde(default)]
    pub pushed_head: Option<String>,
    /// v1.154.1 (walk I1): some read of this pull request found checks on
    /// GitHub — the repository runs them, so their absence right after a
    /// push is GitHub not having started them yet (the longer wait).
    #[serde(default)]
    pub checks_seen: bool,
    /// v1.154.1 (walk I1): right after the pull request was opened or
    /// pushed to, GitHub has no checks on its new head yet (or still shows
    /// the old head): "none" means "not started yet", not "no checks". Read
    /// every minute, and not offered to Merge, for a bounded time
    /// (`awaiting_checks`). Computed on every read.
    #[serde(default)]
    pub awaiting_checks: bool,
    /// 1.169.1 (R1): the head Plyloft last said "Ready to merge on GitHub"
    /// for (notification). Plyloft's, kept across reads: a read that sees it
    /// ready again on the same head — after GitHub briefly said `UNKNOWN`
    /// for mergeable, say — doesn't say it again.
    #[serde(default)]
    pub ready_said_head: Option<String>,
    /// 1.170.0 (G3): how Merge merges it — the method its repository allows
    /// (`merge_method`), shown beside Merge. Set on every read of an open
    /// pull request; None until then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_method: Option<crate::merge_method::MergeMethod>,
    /// 1.170.0 (G1–G3 Challenger, 1 and 3): a press wanted "Merge when
    /// checks pass", but the pull request holds a commit nobody reviewed —
    /// held off at the ship, or turned off on GitHub when Push update sent
    /// one — and Plyloft turns it on (`Resumed`) once that commit is
    /// reviewed (`pr_merge::resume_due`). Plyloft's, kept across reads; left
    /// out of the file while unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_merge_wanted: Option<AutoMergeWanted>,
    /// G5 (1.170.0): after the merge, why this computer's target branch
    /// couldn't be brought up to GitHub's ("You have changes that aren't in
    /// a commit"); the Done card and the Inbox offer **Bring this computer
    /// up to date** while it is set. Plyloft's, kept across reads; cleared
    /// once this computer is up to date (`after_merge`).
    #[serde(default)]
    pub up_to_date_refused: Option<String>,
    /// G5 (Challenger 4): the reason above is one only the person can
    /// settle (this computer's target has commits of its own): the words,
    /// no **Bring this computer up to date**. Plyloft's, kept across reads.
    #[serde(default)]
    pub up_to_date_no_press: bool,
    /// G5 (Challenger 7): why the card's branch was left on GitHub after
    /// the merge (kept on purpose, or the delete failed), short; the Done
    /// card says it in a muted line. Plyloft's, kept across reads.
    #[serde(default)]
    pub branch_kept: Option<String>,
    /// G5 (Challenger 5): the pull request's head branch (`headRefName`),
    /// from GitHub's view on every read.
    #[serde(default)]
    pub head_ref: Option<String>,
    /// G5 (Challenger 5): whether the pull request comes from another
    /// repository (`isCrossRepository`); `None` when gh didn't say.
    #[serde(default)]
    pub cross_repository: Option<bool>,
    /// G7 (1.170.0): "Fix failing checks by itself" on this pull request —
    /// the heads it tried, and where it stopped (`pr_auto_fix::PrAutoFix`).
    /// Plyloft's, kept across reads; a new pull request starts without it.
    /// Absent until a first try, and then not written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_fix: Option<crate::pr_auto_fix::PrAutoFix>,
    /// G7 fixes (Minor 5): when Plyloft first read this head's checks as
    /// failing — kept while later reads still find them failing on the same
    /// head; a new head, or checks that pass or run again, start over. The
    /// workspace's "Fix failing checks by itself" default covers only
    /// failures first seen after it was turned on. Plyloft's; absent on
    /// records before it (an old failure), and then not written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failing_since: Option<i64>,
    /// 1.170.0 (walk fix): "Merge when checks pass" kept by Plyloft, not
    /// GitHub — the base branch requires no checks (or Plyloft couldn't
    /// tell), where GitHub's auto-merge merges at once, before any check
    /// ran. The poller merges it once its checks passed (or it has none,
    /// after the wait), as the card's Merge would (`pr_merge::merge_due`).
    /// Plyloft's, kept across reads while it is open; absent while off.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub plyloft_auto_merge: bool,
    /// 1.171.0 (D8): the pull request's title as GitHub has it — what a
    /// merged card says shipped (a squash of a single commit takes that
    /// commit's subject, not the title). Absent on cards read before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// 1.171.0 (B1): the last read couldn't reach GitHub because the GitHub
    /// command isn't signed in (or its sign-in expired): the card says
    /// "Plyloft can't read GitHub: sign in again" instead of a wait that
    /// never ends. Set by a failed read (`refresh_card`), cleared by the
    /// next read that reaches GitHub. Absent while false (records before it).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sign_in_needed: bool,
}

/// 1.170.0 (G1–G3 Challenger): why "Merge when checks pass" is off though a
/// press wanted it, or that Plyloft turned it on again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AutoMergeWanted {
    /// Wanted at the ship; never turned on, the last commit isn't reviewed.
    Held,
    /// It was on; Plyloft turned it off when a commit nobody reviewed was
    /// pushed to the pull request.
    TurnedOff,
    /// Plyloft turned it on again once the commit was reviewed.
    Resumed,
}

impl AutoMergeWanted {
    /// Still waiting to be turned on.
    pub fn waiting(self) -> bool {
        matches!(self, AutoMergeWanted::Held | AutoMergeWanted::TurnedOff)
    }
}

/// Two names of one commit: equal, or one the start of the other (a short
/// name and GitHub's full one).
pub fn same_commit(a: &str, b: &str) -> bool {
    !a.is_empty() && !b.is_empty() && (a.starts_with(b) || b.starts_with(a))
}

impl PrStatus {
    /// The state `card_ship` records when it opens (or links) a PR.
    pub fn opened(number: u64, at: i64) -> Self {
        Self {
            number,
            opened_at: Some(at),
            awaiting_checks: true,
            ..Default::default()
        }
    }

    /// v1.154.1 (walk I1): Push update sent `rev` at `now` — the checks on
    /// GitHub are awaited again.
    pub fn mark_pushed(&mut self, rev: &str, now: i64) {
        self.pushed_at = Some(now);
        self.pushed_head = Some(rev.to_string()).filter(|r| !r.is_empty());
        self.awaiting_checks = self.state == PrState::Open;
    }

    /// 1.169.1 (R1): GitHub would merge it if asked now — open, read at
    /// least once, its checks on GitHub passed (or it has none, once the
    /// wait after the opening or a push is over), GitHub reports it
    /// mergeable and its merge state isn't blocked, behind, a draft or
    /// dirty, no review stands in the way and GitHub isn't merging it on
    /// its own (auto-merge on asks nothing). Mirrors
    /// `prStatus.ts::prReadyToMerge`.
    pub fn ready_to_merge(&self) -> bool {
        self.checks_green_open()
            && self.mergeable == PrMergeable::Mergeable
            && !matches!(
                self.merge_state.as_deref(),
                Some("blocked" | "behind" | "draft" | "dirty")
            )
            && !matches!(
                self.review_decision,
                PrReviewDecision::ChangesRequested | PrReviewDecision::ReviewRequired
            )
    }

    /// 1.169.1 (R1): green, and a required review is all it waits for
    /// (`reviewDecision` REVIEW_REQUIRED, which GitHub reports with merge
    /// state BLOCKED), auto-merge off. On hold, not asked of the person
    /// (owner, 2026-10-26). Mirrors `prStatus.ts::prWaitsForReview`.
    pub fn waits_for_review(&self) -> bool {
        self.checks_green_open()
            && self.mergeable != PrMergeable::Conflicting
            && self.review_decision == PrReviewDecision::ReviewRequired
    }

    /// 1.170.0 (G1–G3 Challenger, 2): GitHub's pull request is no longer
    /// at the commit Plyloft pushed — GitHub's "Update branch", a bot,
    /// someone else's push. Not while GitHub may still be catching up with
    /// a push (`awaiting_checks`), nor for a pull request from before
    /// Plyloft recorded what it pushed. Nothing automatic merges it, nor is
    /// it "ready"; the person may merge what's on GitHub on their own press
    /// (`pr_merge::merge` with GitHub's head). Mirrors
    /// `prStatus.ts::prHeadMoved`.
    pub fn head_moved(&self) -> bool {
        self.state == PrState::Open
            && !self.awaiting_checks
            && match (self.pushed_head.as_deref(), self.head_sha.as_deref()) {
                (Some(pushed), Some(head)) if !pushed.is_empty() && !head.is_empty() => !same_commit(pushed, head),
                _ => false,
            }
    }

    fn checks_green_open(&self) -> bool {
        self.state == PrState::Open
            && self.checked_at.is_some()
            && !self.awaiting_checks
            && matches!(self.checks, PrChecks::Passing | PrChecks::None)
            && !self.auto_merge
    }

    /// Equal to `other` in everything GitHub said (not when it was read).
    pub fn same_facts(&self, other: &PrStatus) -> bool {
        let strip = |p: &PrStatus| PrStatus {
            checked_at: None,
            ..p.clone()
        };
        strip(self) == strip(other)
    }
}

/// G7 fixes (Minor 5): `next.failing_since` — kept from `prev` while the
/// same head's checks still fail (absent stays absent: a failure from before
/// Plyloft kept the time is an old one), `now` when they newly fail, `None`
/// when they don't.
pub fn failing_since(prev: &PrStatus, next: &PrStatus, now: i64) -> Option<i64> {
    if next.checks != PrChecks::Failing {
        return None;
    }
    if prev.checks == PrChecks::Failing && prev.head_sha == next.head_sha {
        return prev.failing_since;
    }
    Some(now)
}

/// 1.169.1 (R1): something on Plyloft's side stands between `pr` and a
/// merge — the Challenger's request for changes covers the card's latest
/// snapshot, or that snapshot isn't what the pull request holds (a fix
/// waiting for Push update). Mirrors the card-side half of
/// `prStatus.ts::prMergeBlocked`.
pub fn plyloft_blocks_merge(card: &KanbanCard, pr: &PrStatus) -> bool {
    if crate::builder::changes_requested_on_current(card) {
        return true;
    }
    // G1–G3 Challenger (2): commits on GitHub Plyloft didn't push are the
    // person's to look at first.
    if pr.head_moved() {
        return true;
    }
    let last = card.builder.as_ref().and_then(|b| b.snapshots.last());
    match (last, pr.head_sha.as_deref()) {
        (Some(last), Some(head)) => {
            let pushed = pr
                .pushed_head
                .as_deref()
                .is_some_and(|p| !p.is_empty() && (p.starts_with(&last.sha) || last.sha.starts_with(p)));
            last.sha != head && !pushed
        }
        _ => false,
    }
}

/// 1.169.1 (R1): the card's pull request asks for its Merge — GitHub would
/// merge it now and nothing on Plyloft's side is in the way. Mirrors
/// `prStatus.ts::prCardReadyToMerge`.
pub fn card_ready_to_merge(card: &KanbanCard) -> bool {
    card.pr.as_ref().is_some_and(|pr| card_pr_ready(card, pr))
}

/// One rule for the Inbox row and the notification: `pr` (the card's, or
/// the read about to be written) ready to merge, on a card not shipped
/// another way, with nothing on Plyloft's side in the way.
fn card_pr_ready(card: &KanbanCard, pr: &PrStatus) -> bool {
    // Walk fix: one Plyloft merges by itself asks nothing of the person.
    !pr.plyloft_auto_merge && card_pr_mergeable_now(card, pr)
}

/// 1.170.0 (walk fix): GitHub would merge `pr` now and nothing on Plyloft's
/// side is in the way — the guards of the card's Merge, for Plyloft's own
/// "Merge when checks pass" (`pr_merge::merge_due`).
pub fn card_pr_mergeable_now(card: &KanbanCard, pr: &PrStatus) -> bool {
    card.ship_status != ShipStatus::Shipped && pr.ready_to_merge() && !plyloft_blocks_merge(card, pr)
}

/// 1.169.1 (R1): the Inbox row's detail for a pull request ready to merge
/// with no checks on GitHub (`prStatus.ts::PR_READY_NO_CHECKS_DETAIL`).
pub const READY_NO_CHECKS_DETAIL: &str = "no checks";

/// The PR number in a pull request URL (`…/pull/29`).
pub fn pr_number_from_url(url: &str) -> Option<u64> {
    let tail = url.trim().trim_end_matches('/').rsplit_once("/pull/")?.1;
    let digits: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

fn iso_ms(value: Option<&serde_json::Value>) -> Option<i64> {
    let s = value?.as_str()?;
    // gh prints an unset time as the zero time.
    if s.is_empty() || s.starts_with("0001-") {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|t| t.timestamp_millis())
}

fn upper(value: Option<&serde_json::Value>) -> String {
    value
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_uppercase()
}

fn nonempty(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CheckOutcome {
    Pending,
    Passed,
    Failed,
}

/// One `statusCheckRollup` entry, read.
struct RolledCheck {
    /// Identity across runs: (workflow, name) for a check run, the context
    /// for a commit status — what `gh pr checks` keys its dedupe on.
    key: (bool, String, String),
    check: PrCheck,
    outcome: CheckOutcome,
    /// When this run started (else completed): the newest run of a check wins.
    /// A queued or running attempt with no start yet is the newest.
    at: i64,
    /// The Actions run it belongs to (`/actions/runs/<id>/` in its link).
    run_id: Option<String>,
    /// A real failure (not a cancel): FAILURE, TIMED_OUT, STARTUP_FAILURE,
    /// ACTION_REQUIRED, or ERROR/FAILURE for a status.
    hard_failure: bool,
}

/// The Actions run id in a job link (`…/actions/runs/<id>/job/…`).
fn run_id_of(url: Option<&str>) -> Option<String> {
    let tail = url?.split_once("/actions/runs/")?.1;
    let id: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
    (!id.is_empty()).then_some(id)
}

/// One `statusCheckRollup` entry: a check run (Actions, apps) or a commit
/// status (the older statuses API).
///
/// Counted as passed: SUCCESS, NEUTRAL, SKIPPED. Failed: FAILURE, TIMED_OUT,
/// CANCELLED, ACTION_REQUIRED, STARTUP_FAILURE (ERROR for a status). Every
/// other answer — still queued or running, STALE (GitHub gave up on it; it
/// needs a new run), a status that is EXPECTED but never reported — is
/// pending: never "passed". A PR pending for over an hour is read at the
/// settled cadence (`poll_interval_ms`).
fn rolled_check(entry: &serde_json::Value) -> RolledCheck {
    let time = |keys: &[&str]| keys.iter().find_map(|k| iso_ms(entry.get(*k))).unwrap_or(0);
    let is_status = entry.get("__typename").and_then(|v| v.as_str()) == Some("StatusContext");
    if is_status {
        let name = nonempty(entry.get("context")).unwrap_or_else(|| "status".to_string());
        let outcome = match upper(entry.get("state")).as_str() {
            "SUCCESS" => CheckOutcome::Passed,
            "FAILURE" | "ERROR" => CheckOutcome::Failed,
            _ => CheckOutcome::Pending,
        };
        return RolledCheck {
            key: (true, String::new(), name.clone()),
            check: PrCheck { name, workflow: None, url: nonempty(entry.get("targetUrl")) },
            outcome,
            at: time(&["startedAt", "createdAt"]),
            run_id: None,
            hard_failure: outcome == CheckOutcome::Failed,
        };
    }
    let workflow = nonempty(entry.get("workflowName"));
    let name = nonempty(entry.get("name"))
        .or_else(|| workflow.clone())
        .unwrap_or_else(|| "check".to_string());
    let completed = upper(entry.get("status")) == "COMPLETED";
    let conclusion = upper(entry.get("conclusion"));
    let hard_failure = completed
        && matches!(
            conclusion.as_str(),
            "FAILURE" | "TIMED_OUT" | "ACTION_REQUIRED" | "STARTUP_FAILURE"
        );
    let outcome = if !completed {
        CheckOutcome::Pending
    } else {
        match conclusion.as_str() {
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => CheckOutcome::Passed,
            "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE" => {
                CheckOutcome::Failed
            }
            _ => CheckOutcome::Pending,
        }
    };
    let url = nonempty(entry.get("detailsUrl"));
    let started = time(&["startedAt", "completedAt"]);
    RolledCheck {
        key: (false, workflow.clone().unwrap_or_default(), name.clone()),
        run_id: run_id_of(url.as_deref()),
        check: PrCheck { name, workflow, url },
        outcome,
        // A re-run still queued has no start yet: it is the newest attempt.
        at: if !completed && iso_ms(entry.get("startedAt")).is_none() { i64::MAX } else { started },
        hard_failure,
    }
}

/// Whether `new` stands for the check instead of `kept` (same key).
/// Within one run (a re-run attempt) or without run ids: the newest. Across
/// two runs (the push and the pull_request run of one workflow job): a real
/// failure is never hidden by the other run — only a cancelled, pending or
/// STALE entry gives way to a newer sibling.
fn supersedes(new: &RolledCheck, kept: &RolledCheck) -> bool {
    let other_run = matches!((&new.run_id, &kept.run_id), (Some(a), Some(b)) if a != b);
    if other_run && kept.hard_failure != new.hard_failure {
        return new.hard_failure;
    }
    new.at >= kept.at
}

/// The rollup with each check once — its newest run, as `gh pr checks`
/// shows it, except that a real failure in one run is not hidden by a green
/// run of the same job in another (`supersedes`). A run re-run green, or a
/// push run cancelled beside a green pull_request run, is green.
fn latest_checks(entries: &[serde_json::Value]) -> Vec<RolledCheck> {
    let mut latest: Vec<RolledCheck> = Vec::new();
    for rolled in entries.iter().map(rolled_check) {
        match latest.iter_mut().find(|r| r.key == rolled.key) {
            Some(kept) if supersedes(&rolled, kept) => *kept = rolled,
            Some(_) => {}
            None => latest.push(rolled),
        }
    }
    latest
}

/// 1.171.0 B3 (walk 6b): the checks as GitHub's pull request page counts
/// them — every workflow run of a check once (a re-run attempt replaces its
/// own run), so the push run and the pull_request run of one workflow job
/// are two, as GitHub lists them. Only the counts read this ("checks 1 of
/// 2"); whether the checks pass or fail is [`latest_checks`]'.
///
/// A run is told apart by its Actions run id (`/actions/runs/<id>/` in its
/// link). A check from another app or a commit status has none, so its
/// runs still count once, by (workflow, name) or context, as in
/// [`latest_checks`] — `gh pr view`'s rollup doesn't name their check suite.
fn page_checks(entries: &[serde_json::Value]) -> Vec<RolledCheck> {
    let mut runs: Vec<RolledCheck> = Vec::new();
    for rolled in entries.iter().map(rolled_check) {
        match runs.iter_mut().find(|r| r.key == rolled.key && r.run_id == rolled.run_id) {
            Some(kept) if rolled.at >= kept.at => *kept = rolled,
            Some(_) => {}
            None => runs.push(rolled),
        }
    }
    runs
}

/// Parse `gh pr view --json <PR_VIEW_FIELDS>` into the card's PR state.
/// `checked_at`, `opened_at` and `cleanup_kept` are the caller's.
pub fn parse_pr_view(json: &str) -> Result<PrStatus, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("couldn't read GitHub's answer: {e}"))?;
    let number = v
        .get("number")
        .and_then(|n| n.as_u64())
        .ok_or_else(|| "GitHub's answer has no pull request number".to_string())?;
    let state = match upper(v.get("state")).as_str() {
        "MERGED" => PrState::Merged,
        "CLOSED" => PrState::Closed,
        _ => PrState::Open,
    };

    let mut total = 0u32;
    let mut passed = 0u32;
    let mut pending = 0u32;
    let mut failing: Vec<PrCheck> = Vec::new();
    let entries = v
        .get("statusCheckRollup")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();
    let mut latest_pending = false;
    let mut latest_any = false;
    for rolled in latest_checks(&entries) {
        latest_any = true;
        match rolled.outcome {
            CheckOutcome::Passed => {}
            CheckOutcome::Pending => latest_pending = true,
            CheckOutcome::Failed => failing.push(rolled.check),
        }
    }
    let checks = if !failing.is_empty() {
        PrChecks::Failing
    } else if latest_pending {
        PrChecks::Pending
    } else if latest_any {
        PrChecks::Passing
    } else {
        PrChecks::None
    };
    // Walk 6b: "checks 0 of 1" while GitHub listed two runs of "test".
    for run in page_checks(&entries) {
        total += 1;
        match run.outcome {
            CheckOutcome::Passed => passed += 1,
            CheckOutcome::Pending => pending += 1,
            CheckOutcome::Failed => {}
        }
    }

    let mergeable = match upper(v.get("mergeable")).as_str() {
        "MERGEABLE" => PrMergeable::Mergeable,
        "CONFLICTING" => PrMergeable::Conflicting,
        _ => PrMergeable::Unknown,
    };
    let merge_state = nonempty(v.get("mergeStateStatus")).map(|s| s.to_ascii_lowercase());
    let mut review_decision = match upper(v.get("reviewDecision")).as_str() {
        "APPROVED" => PrReviewDecision::Approved,
        "CHANGES_REQUESTED" => PrReviewDecision::ChangesRequested,
        "REVIEW_REQUIRED" => PrReviewDecision::ReviewRequired,
        _ => PrReviewDecision::None,
    };
    // `latestReviews` is one per reviewer; the newest that asked for changes.
    let changes_requested = v
        .get("latestReviews")
        .and_then(|r| r.as_array())
        .into_iter()
        .flatten()
        .filter(|r| upper(r.get("state")) == "CHANGES_REQUESTED")
        .map(|r| {
            let body: String = r
                .get("body")
                .and_then(|b| b.as_str())
                .unwrap_or("")
                .trim()
                .chars()
                .take(REVIEW_TEXT_MAX)
                .collect();
            PrChangesRequest {
                author: r
                    .get("author")
                    .and_then(|a| nonempty(a.get("login"))),
                body,
                submitted_at: iso_ms(r.get("submittedAt")),
            }
        })
        .max_by_key(|r| r.submitted_at.unwrap_or(0));
    // GitHub leaves `reviewDecision` empty on a repository whose branch
    // protection requires no review; a reviewer's latest review asking for
    // changes still stands there.
    if review_decision == PrReviewDecision::None && changes_requested.is_some() {
        review_decision = PrReviewDecision::ChangesRequested;
    }
    let changes_requested = if review_decision == PrReviewDecision::ChangesRequested {
        changes_requested
    } else {
        None
    };

    Ok(PrStatus {
        number,
        state,
        checks,
        checks_total: total,
        checks_passed: passed,
        checks_pending: pending,
        failing_checks: failing,
        mergeable,
        merge_state,
        review_decision,
        changes_requested,
        head_sha: nonempty(v.get("headRefOid")),
        merge_commit: v.get("mergeCommit").and_then(|m| nonempty(m.get("oid"))),
        opened_at: None,
        merged_at: iso_ms(v.get("mergedAt")),
        closed_at: iso_ms(v.get("closedAt")),
        checked_at: None,
        cleanup_kept: None,
        pending_since: None,
        // A merged PR keeps its `autoMergeRequest` (real, sandbox #3): only
        // an open one waits on it.
        auto_merge: state == PrState::Open && v.get("autoMergeRequest").is_some_and(|a| a.is_object()),
        auto_merge_refused: None,
        pushed_at: None,
        pushed_head: None,
        checks_seen: total > 0,
        awaiting_checks: false,
        ready_said_head: None,
        merge_method: None,
        auto_merge_wanted: None,
        up_to_date_refused: None,
        up_to_date_no_press: false,
        branch_kept: None,
        head_ref: nonempty(v.get("headRefName")),
        cross_repository: v.get("isCrossRepository").and_then(serde_json::Value::as_bool),
        auto_fix: None,
        failing_since: None,
        plyloft_auto_merge: false,
        title: nonempty(v.get("title")),
        sign_in_needed: false,
    })
}

/// What changed on GitHub that the person is told about (Inbox + a native
/// notification).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrEvent {
    ChecksFailed,
    ChangesRequested,
    Conflict,
    /// 1.169.1 (R1): it became ready to merge (`PrStatus::ready_to_merge`).
    ReadyToMerge,
    Merged,
    Closed,
}

/// The events between two reads of the same PR. Each is said once: a failing
/// check again on the same head, the same changes-requested review, a
/// conflict that stays — none repeats. (Ready to merge is said by
/// [`apply_status`], once per head.)
pub fn pr_events(prev: &PrStatus, next: &PrStatus) -> Vec<PrEvent> {
    let mut events = Vec::new();
    match next.state {
        PrState::Merged if prev.state != PrState::Merged => events.push(PrEvent::Merged),
        PrState::Closed if prev.state != PrState::Closed => events.push(PrEvent::Closed),
        PrState::Open => {
            let failing_again =
                prev.state == PrState::Open && prev.checks == PrChecks::Failing && prev.head_sha == next.head_sha;
            if next.checks == PrChecks::Failing && !failing_again {
                events.push(PrEvent::ChecksFailed);
            }
            let review_key = |p: &PrStatus| p.changes_requested.as_ref().and_then(|r| r.submitted_at);
            let same_request = prev.state == PrState::Open
                && prev.review_decision == PrReviewDecision::ChangesRequested
                && review_key(prev) == review_key(next);
            if next.review_decision == PrReviewDecision::ChangesRequested && !same_request {
                events.push(PrEvent::ChangesRequested);
            }
            let conflicted = prev.state == PrState::Open && prev.mergeable == PrMergeable::Conflicting;
            if next.mergeable == PrMergeable::Conflicting && !conflicted {
                events.push(PrEvent::Conflict);
            }
        }
        _ => {}
    }
    events
}

/// A card shipped as a PR before SL-1 has no `pr`, and nothing reads it.
pub const LEGACY_REFUSAL: &str =
    "this card was shipped before Plyloft read pull requests back, so it is left as it is";

/// What [`apply_status`] did to the card.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Applied {
    pub events: Vec<PrEvent>,
    /// Anything GitHub said differs from what the card had (`updated_at`
    /// moves only then).
    pub changed: bool,
}

/// Write one read of the card's PR onto the card. Refused when the card now
/// records another PR (shipped again while GitHub was being read).
///
/// Merged: `ship_status = Shipped` + one `ShipEntry` (the merge commit, else
/// the head), as `land_card_local` stamps a local land; the caller prunes.
/// Closed: `review_status` goes back to `Pending` — the card is ready to ship
/// again. Reopened: `Merged` again.
pub fn apply_status(
    card: &mut KanbanCard,
    mut next: PrStatus,
    now: i64,
    shipped_version: &str,
) -> Result<Applied, String> {
    let recorded = card
        .pr_url
        .as_deref()
        .and_then(pr_number_from_url)
        .ok_or_else(|| "this card has no pull request".to_string())?;
    if recorded != next.number {
        return Err(format!(
            "the card now records pull request #{recorded}, not #{}",
            next.number
        ));
    }
    // A card shipped before SL-1 has no PR state, and stays exactly as it is
    // (owner decision): nothing here adopts it.
    let prev = card.pr.clone().ok_or_else(|| LEGACY_REFUSAL.to_string())?;
    next.opened_at = prev.opened_at;
    // X5 (G1 walk): why the copy was kept stands only while the card still
    // has that copy; one removed since (Done, Cards' copies, its session
    // closing) leaves nothing to say.
    next.cleanup_kept = prev.cleanup_kept.clone().filter(|_| card_keeps_copy(card));
    next.up_to_date_refused = prev.up_to_date_refused.clone();
    next.up_to_date_no_press = prev.up_to_date_no_press;
    next.branch_kept = prev.branch_kept.clone();
    // G7: what "Fix failing checks by itself" tried on this pull request.
    next.auto_fix = prev.auto_fix.clone();
    // G7 fixes (Minor 5): when this head's checks were first read failing.
    next.failing_since = failing_since(&prev, &next, now);
    // Walk fix: Plyloft's own "Merge when checks pass" stands while the pull
    // request is open.
    next.plyloft_auto_merge = prev.plyloft_auto_merge && next.state == PrState::Open;
    // SL-3: why auto-merge couldn't be turned on stands until it is on.
    next.auto_merge_refused = if next.auto_merge { None } else { prev.auto_merge_refused.clone() };
    next.checked_at = Some(now);
    // Walk I1: Plyloft's own record of what it sent, and whether GitHub has
    // ever shown checks on this pull request.
    next.pushed_at = prev.pushed_at;
    next.pushed_head = prev.pushed_head.clone();
    next.checks_seen = prev.checks_seen || next.checks_total > 0;
    next.awaiting_checks = awaiting_checks(&next, now);
    // G1–G3 Challenger (3): Plyloft's hold on auto-merge stands until it is
    // on (turned on by someone, or by Plyloft once reviewed); Plyloft's
    // "on again" goes once it is off.
    next.auto_merge_wanted = match prev.auto_merge_wanted {
        Some(w) if w.waiting() && next.auto_merge => None,
        Some(AutoMergeWanted::Resumed) if !next.auto_merge => None,
        other => other,
    };
    // v1.154.1 (F12): the hour of fast reads covers GitHub merging it on
    // its own too, not only running checks.
    // M4: checks that settle into a wait for GitHub's merge restart the hour.
    next.pending_since = if !watched_closely(&next) {
        None
    } else if watched_closely(&prev) && prev.head_sha == next.head_sha && prev.checks == next.checks {
        prev.pending_since.or(Some(now))
    } else {
        Some(now)
    };
    let mut events = pr_events(&prev, &next);
    // R1: "Ready to merge on GitHub" once per head — not on every read that
    // finds it still ready, nor again after GitHub briefly said otherwise.
    next.ready_said_head = prev.ready_said_head.clone();
    if card_pr_ready(card, &next) {
        let head = next.head_sha.clone().unwrap_or_default();
        if next.ready_said_head.as_deref() != Some(head.as_str()) {
            events.push(PrEvent::ReadyToMerge);
            next.ready_said_head = Some(head);
        }
    }
    let changed = card.pr.as_ref().is_none_or(|p| !p.same_facts(&next));

    for event in &events {
        match event {
            PrEvent::Merged => {
                let sha = next
                    .merge_commit
                    .clone()
                    .or_else(|| next.head_sha.clone())
                    .unwrap_or_default();
                card.review_status = Some(ReviewStatus::Merged);
                card.ship_status = ShipStatus::Shipped;
                if !sha.is_empty() {
                    card.commit_sha = Some(sha.clone());
                }
                card.shipped_version = Some(shipped_version.to_string());
                if !card.ship_history.iter().any(|e| !sha.is_empty() && e.commit_sha == sha) {
                    card.ship_history.push(ShipEntry {
                        commit_sha: sha,
                        shipped_version: shipped_version.to_string(),
                        release_kind: ReleaseKind::Local,
                        shipped_at: next.merged_at.unwrap_or(now),
                        target: crate::kanban::ship_target_of(card),
                        tag: None,
                    });
                }
            }
            PrEvent::Closed => {
                if card.review_status == Some(ReviewStatus::Merged)
                    && card.ship_status != ShipStatus::Shipped
                {
                    card.review_status = Some(ReviewStatus::Pending);
                }
            }
            _ => {}
        }
    }
    if next.state == PrState::Open && prev.state == PrState::Closed {
        card.review_status = Some(ReviewStatus::Merged);
    }
    // v1.154.1 (F11): a card whose review loop erased its open pull request
    // (v1.154.0: an approval or an accepted pushback set `review_status` to
    // none) gets it back on the next read.
    if next.state == PrState::Open
        && card.review_status.is_none()
        && card.ship_status != ShipStatus::Shipped
    {
        card.review_status = Some(ReviewStatus::Merged);
    }
    card.pr = Some(next);
    Ok(Applied { events, changed })
}

// ── Polling cadence (pure) ──────────────────────────────────────────────

/// How often the poller wakes to see which PRs are due.
pub const POLL_TICK_SECS: u64 = 15;
/// While any check on GitHub is still running.
pub const POLL_PENDING_MS: i64 = 60_000;
/// Otherwise (and the longest wait after failed reads).
pub const POLL_SETTLED_MS: i64 = 10 * 60_000;

/// v1.154.1 (walk I1): how long, after a push (or the pull request's
/// opening), "no checks" is read as "GitHub hasn't started them yet" on a
/// pull request that has shown checks before.
pub const AWAITING_CHECKS_MS: i64 = 10 * 60_000;
/// The same wait on a pull request that never showed a check: a
/// repository without CI waits no longer than this for its Merge.
pub const AWAITING_FIRST_CHECKS_MS: i64 = 3 * 60_000;

/// v1.154.1 (walk I1): GitHub hasn't registered the checks of what was just
/// sent to the open pull request — it reports none on its head, or still
/// shows a head other than the pushed commit — within the wait after the
/// push (`AWAITING_CHECKS_MS`, or `AWAITING_FIRST_CHECKS_MS` when no check
/// was ever seen on it). The first read after a push can come before GitHub
/// starts the run: a "none" then is not "no checks".
pub fn awaiting_checks(pr: &PrStatus, now: i64) -> bool {
    if pr.state != PrState::Open {
        return false;
    }
    let Some(since) = pr.pushed_at.or(pr.opened_at) else {
        return false;
    };
    let window = if pr.checks_seen { AWAITING_CHECKS_MS } else { AWAITING_FIRST_CHECKS_MS };
    if now - since >= window {
        return false;
    }
    let behind = match (pr.pushed_head.as_deref(), pr.head_sha.as_deref()) {
        (Some(pushed), Some(head)) => !same_commit(pushed, head),
        (Some(_), None) => true,
        _ => false,
    };
    pr.checks == PrChecks::None || behind
}

/// Checks pending longer than this are read at the settled cadence (a
/// check that never reports, an EXPECTED status, a STALE run).
pub const PENDING_CAP_MS: i64 = 60 * 60_000;

/// The wait before the next read of `pr` at `now`, after `failures` reads in
/// a row that didn't reach GitHub (offline, gh signed out): 60 s while checks
/// are pending (for their first hour) or before the first read, 10 min
/// otherwise; after a failure, 1, 2, 4, 8 min … up to 10 min, never sooner
/// than the normal wait.
pub fn poll_interval_ms(pr: &PrStatus, failures: u32, now: i64) -> i64 {
    let pending_fresh = watched_closely(pr)
        && pr.pending_since.is_none_or(|since| now - since < PENDING_CAP_MS);
    // Walk I1: the wait for GitHub to start the checks of a push is read
    // every minute; the read that ends it clears the flag.
    let base = if pr.checked_at.is_none() || pending_fresh || pr.awaiting_checks {
        POLL_PENDING_MS
    } else {
        POLL_SETTLED_MS
    };
    if failures == 0 {
        return base;
    }
    let backoff = POLL_PENDING_MS.saturating_mul(1i64 << (failures - 1).min(4));
    base.max(backoff.min(POLL_SETTLED_MS))
}

/// v1.154.1 (F12): read at the pending cadence — checks on GitHub still
/// running, or "Merge when checks pass" on while nothing stops GitHub from
/// merging it (no failed check, no conflict, no request for changes): the card reaches Done about a
/// minute after GitHub merged it, not up to ten. Capped like pending checks.
pub fn watched_closely(pr: &PrStatus) -> bool {
    pr.checks == PrChecks::Pending
        || (pr.state == PrState::Open
            && (pr.auto_merge || pr.plyloft_auto_merge)
            && pr.checks != PrChecks::Failing
            && pr.mergeable != PrMergeable::Conflicting
            && pr.review_decision != PrReviewDecision::ChangesRequested)
}

/// Whether the poller reads `pr` now. `last_attempt` is this run's last try
/// (in memory); without one, the card's own `checked_at` stands for it, so a
/// relaunch doesn't read every PR at once. Never read yet → due.
pub fn poll_due(pr: &PrStatus, last_attempt: Option<i64>, failures: u32, now: i64) -> bool {
    match last_attempt.or(pr.checked_at) {
        None => true,
        Some(at) => now - at >= poll_interval_ms(pr, failures, now),
    }
}

/// How a read is written. A read that changed nothing is not written: its
/// time is kept in memory, and reaches the board only when the stored one is
/// older than `CHECKED_AT_PERSIST_MS`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrWrite {
    /// Nothing new, and the stored read time is recent: no write.
    Skip,
    /// Nothing new; the stored read time is refreshed (`updated_at` stays).
    Quiet,
    /// GitHub said something new: written, `updated_at` moves.
    Stamp,
}

/// A stored `checked_at` older than this is refreshed by a read that
/// changed nothing.
pub const CHECKED_AT_PERSIST_MS: i64 = 10 * 60_000;

/// How to write a read, given what it changed and the stored read time.
pub fn pr_write(changed: bool, stored_checked_at: Option<i64>, now: i64) -> PrWrite {
    if changed {
        PrWrite::Stamp
    } else if stored_checked_at.is_none_or(|at| now - at >= CHECKED_AT_PERSIST_MS) {
        PrWrite::Quiet
    } else {
        PrWrite::Skip
    }
}

/// 1.171.0 (B1): a failed read's words say the GitHub command isn't signed
/// in, or its sign-in expired (gh's "gh auth login", "HTTP 401", Plyloft's
/// own "isn't signed in on this Mac") — the card asks to sign in again.
pub fn read_needs_sign_in(error: &str) -> bool {
    crate::commands::probe_says_signed_out(&[error.to_string()])
}

/// v1.154.1 (F11): the card's work is in a pull request that is still open
/// — from `pr.state` (SL-1's truth), not `review_status`, which the review
/// loop also writes. A card shipped before SL-1 (no `pr`) is not.
/// 1.174.0 A2: the card links a pull request Plyloft last read open
/// (`card_delivery`'s rule; unlike `card_pr_open`, whatever `ship_status`).
pub fn pr_open_on_card(card: &KanbanCard) -> bool {
    card.pr_url.is_some() && card.pr.as_ref().is_some_and(|p| p.state == PrState::Open)
}

pub fn card_pr_open(card: &KanbanCard) -> bool {
    card.pr_url.is_some()
        && card.ship_status != ShipStatus::Shipped
        && card.pr.as_ref().is_some_and(|p| p.state == PrState::Open)
}

/// v1.154.1 round 3 (Challenger): the review panel's "Merge to base"
/// (`card_review_merge`, a local land) while the card's work is in an open
/// pull request — refused in words: it merges on GitHub, from the card.
pub fn review_merge_refusal(card: &KanbanCard) -> Option<String> {
    // Challenger on a pull request: never landed here.
    if let Some(why) = crate::pr_review::ship_refusal(card) {
        return Some(why);
    }
    card_pr_open(card).then(|| {
        let n = card.pr.as_ref().map(|p| p.number).unwrap_or_default();
        format!(
            "Not merged here: this card's work is in pull request #{n}, which is still open. Merge it on \
             GitHub from the card (Merge), or close the pull request first; nothing was changed."
        )
    })
}

/// v1.154.1 (F11): what `review_status` goes back to when the review loop
/// clears its own word (a request for changes superseded or overridden, an
/// approval): `Merged` while the card's pull request is open — the review
/// loop never erases the link to it — else none, as before.
pub fn cleared_review_status(card: &KanbanCard) -> Option<ReviewStatus> {
    card_pr_open(card).then_some(ReviewStatus::Merged)
}

/// The cards the poller follows: a PR that Plyloft opened since SL-1 and
/// last saw open, on a card not archived. A card shipped before SL-1 (no
/// `pr`) is read only when its page asks (Refresh).
pub fn poll_candidate(card: &KanbanCard) -> bool {
    !card.archived
        && card.pr_url.is_some()
        && card.pr.as_ref().is_some_and(|p| p.state == PrState::Open)
}

/// 1.172.0 B2: the card's pull request waits for Plyloft's own merge
/// ("Merge when checks pass" where GitHub's auto-merge is off) — it merges
/// only while Plyloft is open. Mirrors `deliveryStage.ts`'s
/// `plyloftMergesPending` (an open pull request at `plyloftMerges` or
/// `plyloftMergesWhenOpen`).
pub fn plyloft_merges_pending(card: &KanbanCard) -> bool {
    !card.archived && card_pr_open(card) && card.pr.as_ref().is_some_and(|p| p.plyloft_auto_merge && !p.auto_merge)
}

/// 1.172.0 B2: the cards whose last read was refused for the GitHub sign-in
/// (`sign_in_needed`) — read again at once after a sign-in, not after the
/// failed reads' backoff (up to `POLL_SETTLED_MS`).
pub fn signed_out_reads(cards: &[KanbanCard]) -> Vec<String> {
    cards
        .iter()
        .filter(|c| poll_candidate(c) && c.pr.as_ref().is_some_and(|p| p.sign_in_needed))
        .map(|c| c.id.clone())
        .collect()
}

// ── The poller and one refresh (Tauri glue) ─────────────────────────────

/// Set on app exit: the poller stops and no new read starts.
static STOP: AtomicBool = AtomicBool::new(false);

/// Stop the poller (the exit cleanup: `RunEvent::ExitRequested` or `Exit`). An in-flight `gh` is killed
/// with the other bounded commands (`worktrees::kill_active_fetches`).
pub fn stop_poller() {
    STOP.store(true, Ordering::SeqCst);
}

/// The app is quitting: no new read starts (`pr_review::poll_once` too).
pub fn stopping() -> bool {
    STOP.load(Ordering::SeqCst)
}

#[derive(Debug, Clone, Copy, Default)]
struct Attempt {
    at: i64,
    failures: u32,
}

fn attempts() -> &'static Mutex<HashMap<String, Attempt>> {
    static ATTEMPTS: OnceLock<Mutex<HashMap<String, Attempt>>> = OnceLock::new();
    ATTEMPTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// One lock per card: the poller and the card page never read and write the
/// same card's PR at once.
fn card_lock(key: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut map = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    map.entry(key.to_string()).or_default().clone()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Who asked for a refresh. Only the poller notifies: on the card page the
/// person is already looking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshSource {
    Poller,
    CardPage,
}

/// Start the poller thread: every `POLL_TICK_SECS`, each followed PR that is
/// due is read once. `gh` missing → nothing is read this tick (quietly);
/// a read that fails is retried later with a backoff and logged at debug
/// level only — never an error in the UI.
pub fn start_poller<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(POLL_TICK_SECS));
        if STOP.load(Ordering::SeqCst) {
            return;
        }
        poll_once(&app);
    });
}

/// 1.172.0 B2: forget the failed reads of `key` (`workspace/card`): its next
/// read is not held back by their backoff.
fn forget_failures(key: &str) {
    attempts().lock().unwrap_or_else(|p| p.into_inner()).remove(key);
}

/// 1.172.0 B2 (Challenger): a read after sign-in is running.
static READING_AGAIN: AtomicBool = AtomicBool::new(false);

/// Holds [`READING_AGAIN`] while the reads after a sign-in run; dropping it
/// (the reads done, or none to start) lets the next one start.
struct ReadingAgain;

impl Drop for ReadingAgain {
    fn drop(&mut self) {
        READING_AGAIN.store(false, Ordering::SeqCst);
    }
}

/// The reads after a sign-in may start: None while others still run (a
/// second Settings close, a sign-in during them), so only one background
/// thread ever reads them.
fn claim_reading_again() -> Option<ReadingAgain> {
    READING_AGAIN
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .ok()
        .map(|_| ReadingAgain)
}

/// 1.172.0 B2: after a GitHub sign-in (or when Settings closes, where the
/// person signs in), the cards that said "sign in again" are read now, in the
/// background — their backoff forgotten — so the line clears at once instead
/// of on the next poll. How many reads were started; 0 while the reads of an
/// earlier call still run (Challenger: one thread at a time).
pub fn read_signed_out_again<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> usize {
    use tauri::Manager;
    if STOP.load(Ordering::SeqCst) {
        return 0;
    }
    let Some(claim) = claim_reading_again() else {
        return 0;
    };
    let (Some(workspaces), Some(kanban)) = (
        app.try_state::<crate::workspace::WorkspaceStore>(),
        app.try_state::<crate::kanban::KanbanStore>(),
    ) else {
        return 0;
    };
    let mut due: Vec<(String, String)> = Vec::new();
    for ws in workspaces.snapshot().workspaces {
        let Ok(cards) = kanban.load(&ws.id) else { continue };
        for card_id in signed_out_reads(&cards) {
            forget_failures(&format!("{}/{card_id}", ws.id));
            due.push((ws.id.clone(), card_id));
        }
    }
    let started = due.len();
    if started > 0 {
        let app = app.clone();
        std::thread::spawn(move || {
            // Released when the reads end, however they end.
            let _claim = claim;
            for (workspace_id, card_id) in due {
                if STOP.load(Ordering::SeqCst) {
                    return;
                }
                match refresh_card(&app, &workspace_id, &card_id, RefreshSource::Poller) {
                    Ok(card) => crate::pr_merge::merge_if_due(&app, &workspace_id, &card),
                    Err(e) => log::debug!("pr_status: after sign-in {workspace_id}/{card_id}: {e}"),
                }
            }
        });
    }
    started
}

/// 1.172.0 B2 (PLAN §12): how many pull requests wait for Plyloft's own
/// merge across every workspace — not only the boards the window has warmed
/// — the cards' (`plyloft_merges_pending`) and the releases' through a pull
/// request (`release_record::plyloft_merges_pending`). The quit note's count.
pub fn plyloft_merges_count<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> u32 {
    use tauri::Manager;
    let (Some(workspaces), Some(kanban), Some(project_config)) = (
        app.try_state::<crate::workspace::WorkspaceStore>(),
        app.try_state::<crate::kanban::KanbanStore>(),
        app.try_state::<crate::project_config::ProjectConfigStore>(),
    ) else {
        return 0;
    };
    let mut n = 0u32;
    for ws in workspaces.snapshot().workspaces {
        if let Ok(cards) = kanban.load(&ws.id) {
            n += cards.iter().filter(|c| plyloft_merges_pending(c)).count() as u32;
        }
        if let Ok(Some(record)) = crate::release_record::load(&project_config.workspace_dir(&ws.id)) {
            n += u32::from(crate::release_record::plyloft_merges_pending(&record));
        }
    }
    n
}

fn poll_once<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    // G8 (1.170.0): releases through a pull request on their way, each once
    // a minute, every tick while GitHub merges it (1.171.0 F3,
    // `ship::release_pr::poll`).
    crate::ship::poll_release_prs(app);
    let (Some(workspaces), Some(kanban)) = (
        app.try_state::<crate::workspace::WorkspaceStore>(),
        app.try_state::<crate::kanban::KanbanStore>(),
    ) else {
        return;
    };
    let now = now_ms();
    let mut due: Vec<(String, String)> = Vec::new();
    for ws in workspaces.snapshot().workspaces {
        let Ok(cards) = kanban.load(&ws.id) else { continue };
        for card in cards.iter().filter(|c| poll_candidate(c)) {
            let key = format!("{}/{}", ws.id, card.id);
            let attempt = attempts()
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(&key)
                .copied();
            let pr = card.pr.as_ref().expect("poll_candidate has a pr");
            if poll_due(pr, attempt.map(|a| a.at), attempt.map_or(0, |a| a.failures), now) {
                due.push((ws.id.clone(), card.id.clone()));
            }
        }
    }
    if due.is_empty() {
        return;
    }
    if crate::doctor::require("gh").is_err() {
        log::debug!("pr_status: gh isn't available; {} pull request(s) not read", due.len());
        return;
    }
    for (workspace_id, card_id) in due {
        if STOP.load(Ordering::SeqCst) {
            return;
        }
        match refresh_card(app, &workspace_id, &card_id, RefreshSource::Poller) {
            // Walk fix: Plyloft's own "Merge when checks pass", once its
            // checks passed — outside the card's read lock.
            Ok(card) => crate::pr_merge::merge_if_due(app, &workspace_id, &card),
            Err(e) => log::debug!("pr_status: {workspace_id}/{card_id}: {e}"),
        }
    }
}

/// Read the card's PR from GitHub now and apply it (the card page's open and
/// Refresh, and the poller). Returns the card as written.
pub fn refresh_card<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    card_id: &str,
    source: RefreshSource,
) -> Result<KanbanCard, String> {
    use tauri::Manager;
    if STOP.load(Ordering::SeqCst) {
        return Err("Plyloft is quitting".to_string());
    }
    let key = format!("{workspace_id}/{card_id}");
    let lock = card_lock(&key);
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    let kanban = app.state::<crate::kanban::KanbanStore>();
    let card = kanban.get_card(workspace_id, card_id)?;
    let url = card
        .pr_url
        .clone()
        .ok_or_else(|| "this card has no pull request".to_string())?;
    if card.pr.is_none() {
        return Err(LEGACY_REFUSAL.to_string());
    }

    let fetched = (|| {
        let gh = crate::doctor::require("gh")?;
        let _github = crate::github_account::enter_for_app(app, workspace_id);
        let view = |fields: &str| {
            crate::github::gh_output(
                &gh,
                None,
                &["pr", "view", &url, "--json", fields],
                crate::github::GH_API_TIMEOUT,
            )
        };
        let mut out = view(PR_VIEW_FIELDS)?;
        let mut kept_auto_merge = None;
        if !out.status.success() && gh_lacks_auto_merge_field(&String::from_utf8_lossy(&out.stderr)) {
            out = view(PR_VIEW_FIELDS_WITHOUT_AUTO_MERGE)?;
            kept_auto_merge = card.pr.as_ref().map(|p| p.auto_merge);
        }
        if !out.status.success() {
            return Err(format!(
                "couldn't read the pull request on GitHub: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        let mut next = parse_pr_view(&String::from_utf8_lossy(&out.stdout))?;
        if let Some(on) = kept_auto_merge {
            next.auto_merge = on && next.state == PrState::Open;
        }
        // G3: the way Merge will merge it, beside Merge (read again at most
        // daily, `merge_method::for_pr`).
        if next.state == PrState::Open {
            if let Some(workspaces) = app.try_state::<crate::workspace::WorkspaceStore>() {
                next.merge_method = Some(crate::merge_method::for_pr(&workspaces, workspace_id, &url, false, |args| {
                    crate::github::gh_output(&gh, None, args, crate::github::GH_API_TIMEOUT)
                        .map(|out| crate::pr_merge::GhAnswer::from_output(&out))
                }));
            }
        }
        Ok(next)
    })();
    let now = now_ms();
    let next = match fetched {
        Ok(next) => {
            attempts()
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(key.clone(), Attempt { at: now, failures: 0 });
            next
        }
        Err(e) => {
            {
                let mut map = attempts().lock().unwrap_or_else(|p| p.into_inner());
                let entry = map.entry(key.clone()).or_default();
                entry.at = now;
                entry.failures = entry.failures.saturating_add(1);
            }
            // 1.171.0 (B1): a read the GitHub sign-in refused is said on the
            // card (once: the next refusal changes nothing), not a wait.
            if read_needs_sign_in(&e) && !card.pr.as_ref().is_some_and(|p| p.sign_in_needed) {
                match kanban.update_card_pr(workspace_id, card_id, |c| {
                    if let Some(pr) = c.pr.as_mut() {
                        pr.sign_in_needed = true;
                    }
                    Ok(((), PrWrite::Stamp))
                }) {
                    Ok(_) => crate::kanban::emit_kanban_changed(app, workspace_id),
                    Err(w) => log::warn!("pr_status: {card_id}: couldn't record the sign-in: {w}"),
                }
            }
            return Err(e);
        }
    };

    let shipped_version = shipped_version_for(app, workspace_id);
    let (mut card, (applied, write)) = kanban.update_card_pr(workspace_id, card_id, |c| {
        let stored = c.pr.as_ref().and_then(|p| p.checked_at);
        let applied = apply_status(c, next, now, &shipped_version)?;
        let write = pr_write(applied.changed, stored, now);
        Ok(((applied, write), write))
    })?;

    if applied.events.contains(&PrEvent::Merged) {
        if let Some(kept) = clean_up_after_merge(app, workspace_id, &card) {
            card = kanban
                .update_card_pr(workspace_id, card_id, |c| {
                    if let Some(pr) = c.pr.as_mut() {
                        pr.cleanup_kept = Some(kept);
                    }
                    Ok(((), PrWrite::Quiet))
                })?
                .0;
        } else {
            card = kanban.get_card(workspace_id, card_id)?;
        }
        // G5: the card's branch on GitHub deleted (only at the merged head),
        // its stale ref pruned, this computer brought up to date — after the
        // cleanup released `CARD_START_LOCK`.
        match crate::after_merge::after_merge_and_record(app, workspace_id, &card) {
            Ok(written) => card = written,
            Err(e) => log::warn!("pr_status: {card_id}: after the merge: {e}"),
        }
    }
    if source == RefreshSource::Poller {
        for event in &applied.events {
            notify(app, &card, *event);
        }
    }
    // Views reload only when the card changed; a read that found nothing new
    // is the returned card's `checked_at` (and the poller's memory).
    if write == PrWrite::Stamp {
        crate::kanban::emit_kanban_changed(app, workspace_id);
    }
    Ok(card)
}

/// The project's version now, as `land_card_local` stamps a local land.
fn shipped_version_for<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str) -> String {
    use tauri::Manager;
    let cwd = app
        .try_state::<crate::workspace::WorkspaceStore>()
        .and_then(|w| {
            w.snapshot()
                .workspaces
                .into_iter()
                .find(|w| w.id == workspace_id)
                .map(|w| std::path::PathBuf::from(w.cwd))
        });
    let config = app
        .try_state::<crate::project_config::ProjectConfigStore>()
        .and_then(|c| c.get(workspace_id));
    match (cwd, config) {
        (Some(cwd), Some(cfg)) => crate::ship::read_project_version(&cwd, &cfg),
        _ => None,
    }
    .unwrap_or_else(|| "unknown".to_string())
}

/// After a merge: the worktree to the trash — only while the branch is at
/// the merged head and nothing uses the worktree
/// (`worktrees::prune_pr_merged_card`). N18: the local branch is recorded
/// for the cleanup sweep (deleted at the merged head once the trash entry
/// expires), no longer deleted here. Returns why something was kept.
pub(crate) fn clean_up_after_merge<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    card: &KanbanCard,
) -> Option<String> {
    if card.branch_name.is_none() {
        // Nothing of the card's is left to clean up, or a worktree without
        // a recorded branch, which is not proven to be the merged work.
        return card
            .worktree_path
            .as_ref()
            .map(|_| "the card records no branch for its worktree, so it was kept".to_string());
    };
    let Some(head) = card.pr.as_ref().and_then(|p| p.head_sha.clone()) else {
        return Some(
            "GitHub didn't say which commit it merged, so the worktree and its branch were kept"
                .to_string(),
        );
    };
    clean_up_card_worktree(app, workspace_id, card, &head, crate::branch_cleanup::CleanupReason::PrMerged)
}

/// G11 (1.170.0): why a merged pull request's cleanup waited — the card's
/// Builder session was open when it merged (the session follows the pull
/// request until Done).
pub(crate) const KEPT_FOR_SESSION: &str = "its Builder session is open";
/// 1.174.0 C4: why it waited — a terminal is open in the card's folder (a
/// card made from a copy keeps the copy's terminals). Kept as for a session.
pub(crate) const KEPT_FOR_TERMINAL: &str = "a terminal is open in its copy";

/// What keeps a merged pull request's worktree for now: its Builder
/// session, a terminal open in it, a run in progress — in that order.
pub(crate) fn after_merge_busy(builder_open: bool, terminals: usize, run_in_progress: bool) -> Option<String> {
    if builder_open {
        Some(KEPT_FOR_SESSION.to_string())
    } else if terminals > 0 {
        Some(KEPT_FOR_TERMINAL.to_string())
    } else if run_in_progress {
        Some("a run is in progress".to_string())
    } else {
        None
    }
}

/// X5: the card still has its copy of the repository: it records one, and
/// the folder is there.
pub(crate) fn card_keeps_copy(card: &KanbanCard) -> bool {
    card.worktree_path.as_deref().is_some_and(|p| !p.trim().is_empty() && std::path::Path::new(p).is_dir())
}

/// G11: the card's cleanup after its merge waits on its Builder session: a
/// merged pull request whose worktree was kept (`cleanup_kept`) and is still
/// recorded.
pub(crate) fn cleanup_waits_on_session(card: &KanbanCard) -> bool {
    card.worktree_path.is_some()
        && card
            .pr
            .as_ref()
            .is_some_and(|p| p.state == PrState::Merged && p.cleanup_kept.is_some())
}

/// G11: once more, the cleanup [`clean_up_after_merge`] kept for the
/// session, and its answer recorded on the card (`cleanup_kept`: why it is
/// still kept, or nothing). `None` when the card's cleanup doesn't wait on
/// a session; else the new `cleanup_kept`.
pub(crate) fn retry_cleanup_once<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    card_id: &str,
) -> Option<Option<String>> {
    use tauri::Manager;
    let kanban = app.state::<crate::kanban::KanbanStore>();
    let card = kanban.get_card(workspace_id, card_id).ok()?;
    if !cleanup_waits_on_session(&card) {
        return None;
    }
    let kept = clean_up_after_merge(app, workspace_id, &card);
    let recorded = kept.clone();
    if let Err(e) = kanban.update_card_pr(workspace_id, card_id, |c| {
        if let Some(pr) = c.pr.as_mut() {
            pr.cleanup_kept = recorded;
        }
        Ok(((), PrWrite::Quiet))
    }) {
        log::warn!("pr_status: {card_id}: cleanup after the session: {e}");
    }
    Some(kept)
}

/// G11: the card's Builder session closed or ended — Plyloft closes it at
/// Done, or the person did. A merged pull request's worktree kept for that
/// session goes now, on a worker, a few times while the session's
/// processes exit (Windows lets go of the folder only then). A session
/// opened again meanwhile keeps it, and the card says so.
pub fn clean_up_after_session(app: &tauri::AppHandle, workspace_id: &str, card_id: &str) {
    use tauri::Manager;
    let waits = app
        .state::<crate::kanban::KanbanStore>()
        .get_card(workspace_id, card_id)
        .is_ok_and(|c| cleanup_waits_on_session(&c));
    if !waits {
        return;
    }
    let app = app.clone();
    let (workspace_id, card_id) = (workspace_id.to_string(), card_id.to_string());
    std::thread::spawn(move || {
        for wait in crate::kept_copy::AFTER_SESSION_TRIES {
            std::thread::sleep(wait);
            match retry_cleanup_once(&app, &workspace_id, &card_id) {
                Some(Some(kept)) if kept != KEPT_FOR_SESSION => continue,
                _ => break,
            }
        }
        crate::kanban::emit_kanban_changed(&app, &workspace_id);
    });
}

/// [`clean_up_after_merge`] for a known head: the card's worktree to the
/// trash through the guarded move (a dirty, busy or moved-on worktree is
/// kept, and the words say why), its branch recorded for N18's sweep at
/// `head` with `reason`. Challenger on a pull request uses it for a merged
/// or closed pull request (`pr_review::clean_up_closed`).
pub(crate) fn clean_up_card_worktree<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    card: &KanbanCard,
    head: &str,
    reason: crate::branch_cleanup::CleanupReason,
) -> Option<String> {
    use tauri::Manager;
    let Some(branch) = card.branch_name.clone() else {
        return card
            .worktree_path
            .as_ref()
            .map(|_| "the card records no branch for its worktree, so it was kept".to_string());
    };
    let head = head.to_string();
    let Some(cwd) = app
        .try_state::<crate::workspace::WorkspaceStore>()
        .and_then(|w| {
            w.snapshot()
                .workspaces
                .into_iter()
                .find(|w| w.id == workspace_id)
                .map(|w| std::path::PathBuf::from(w.cwd))
        })
    else {
        return Some("its workspace folder isn't known, so the worktree and its branch were kept".to_string());
    };
    // Serialized with card starts, as Sync's prune: a start can't pick up
    // the worktree mid-prune.
    let _start = crate::commands::CARD_START_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let busy = after_merge_busy(
        app.try_state::<crate::builder::BuilderRegistry>().is_some_and(|b| b.get_pty(&card.id).is_some()),
        crate::commands::card_folder_terminals(app, card),
        card.last_run_status == Some(crate::kanban::LastRunStatus::Running),
    );
    // Only the conventional location: `prune_for_card` acts on it.
    if let Some(wt) = card.worktree_path.as_deref() {
        let expected = crate::worktrees::card_worktree_path(&cwd, &card.id, Some(wt));
        let same = match (
            crate::platform::canonicalize(std::path::Path::new(wt)),
            crate::platform::canonicalize(&expected),
        ) {
            (Ok(a), Ok(b)) => a == b,
            // Already gone: the branch is all that is left.
            _ => !std::path::Path::new(wt).exists(),
        };
        if !same {
            return Some("its worktree isn't where Plyloft keeps card worktrees".to_string());
        }
    }
    let cache_paths = app
        .try_state::<crate::project_config::ProjectConfigStore>()
        .map(|c| c.cache_paths(workspace_id))
        .unwrap_or_default();
    let candidate = crate::worktrees::PruneCandidate {
        card_id: card.id.clone(),
        path: crate::worktrees::card_worktree_path(&cwd, &card.id, card.worktree_path.as_deref()),
        branch,
        recorded_base: card.worktree_base.as_ref().map(|b| b.commit.clone()),
        busy,
    };
    let cleanup = crate::worktrees::prune_pr_merged_card(&cwd, &candidate, &head, &cache_paths);
    let kanban = app.state::<crate::kanban::KanbanStore>();
    // N18: the branch is left for the sweep, at the merged head — it goes
    // when the worktree's trash entry expires, like a shipped card's.
    if cleanup.branch_present {
        let record = crate::branch_cleanup::record(
            card,
            &cwd,
            reason,
            Some(&head),
            cleanup.trash_entry.as_deref(),
            crate::kanban::now_ms(),
        );
        kanban.record_branch_cleanup(workspace_id, &card.id, record);
    }
    if cleanup.pruned || cleanup.kept.is_none() {
        if let Err(e) = kanban.clear_worktree_handle(workspace_id, &card.id) {
            log::warn!("pr_status: {}: cleaned up but couldn't clear the card: {e}", card.id);
        }
        crate::verify_logs::card_worktree_removed(workspace_id, &card.id);
    }
    if let Some(kept) = &cleanup.kept {
        log::info!("pr_status: kept {}'s worktree after the merge: {kept}", card.id);
    }
    cleanup.kept
}

/// The notification's words for one event (title, body).
pub fn notification_words(card: &KanbanCard, event: PrEvent) -> (String, String) {
    let pr = card.pr.as_ref();
    let number = pr.map(|p| format!("#{}", p.number)).unwrap_or_default();
    let title = match event {
        PrEvent::ChecksFailed => "Checks failed on GitHub",
        PrEvent::ChangesRequested => "Changes requested on GitHub",
        PrEvent::Conflict => "Pull request can't merge: conflict",
        PrEvent::ReadyToMerge => "Ready to merge on GitHub",
        PrEvent::Merged => "Pull request merged",
        PrEvent::Closed => "Pull request closed without merging",
    };
    let detail = match event {
        PrEvent::ChecksFailed => pr
            .map(|p| {
                p.failing_checks
                    .iter()
                    .map(PrCheck::label)
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .filter(|s| !s.is_empty()),
        PrEvent::ChangesRequested => pr
            .and_then(|p| p.changes_requested.as_ref())
            .map(|r| r.body.chars().take(140).collect::<String>())
            .filter(|s| !s.is_empty()),
        PrEvent::ReadyToMerge => Some(
            if pr.is_some_and(|p| p.checks == PrChecks::None) {
                "no checks on GitHub"
            } else {
                "checks passed"
            }
            .to_string(),
        ),
        _ => None,
    };
    let mut body = format!("{} {}", card.title, number).trim().to_string();
    if let Some(d) = detail {
        body.push_str(" · ");
        body.push_str(&d);
    }
    (title.to_string(), body)
}

/// A native notification, under the existing "Tell me when a run finishes"
/// toggle (`behavior.notifyOnAgentDone`).
fn notify<R: tauri::Runtime>(app: &tauri::AppHandle<R>, card: &KanbanCard, event: PrEvent) {
    use tauri::Manager;
    use tauri_plugin_notification::NotificationExt;
    let Some(settings) = app.try_state::<crate::settings::SettingsStore>() else {
        return;
    };
    if !settings.snapshot().behavior.notify_on_agent_done {
        return;
    }
    let (title, body) = notification_words(card, event);
    if app.notification().builder().title(title).body(body).show().is_ok() {
        // QoL 1.168 (F5): the window opens this card when the person comes
        // back to Plyloft from the notification (`lib/notifyTarget.ts`).
        use tauri::Emitter;
        let _ = app.emit(
            "notification://sent",
            serde_json::json!({ "workspaceId": card.workspace_id, "cardId": card.id }),
        );
    }
}

#[cfg(test)]
#[path = "pr_status_tests.rs"]
mod tests;
