//! Challenger on a pull request (owner decisions of 2026-10-14, §3).
//!
//! Board › **Review a pull request** lists the repository's open pull
//! requests (`gh pr list`, as the workspace's GitHub account) or takes a
//! pasted link (or number) of one of them, and makes a card
//! "Review: <title>" linked to it ([`PrReview`] on the card):
//!
//! - **Its worktree** is the card's own, on a card branch
//!   (`plyloft/card-<short_id>-<slug>`) started at the pull request's head,
//!   fetched from `refs/pull/<n>/head` into Plyloft's `refs/ply/pr/<n>`
//!   (`worktrees::fetch_pull_head`, `ensure_for_pr_card`). Never the pull
//!   request's own branch name, which may be checked out in the member's
//!   checkout.
//! - **The review** is the card's usual Challenger pipeline
//!   (`builder::review_pr_head`): one snapshot per head of the pull request,
//!   a sweep first and follow-ups after, P1/P2/P3 findings in the card's
//!   ledger, the workspace's blocking threshold and "Not a real issue". The
//!   Challenger reads a pinned read-only tree as for every card
//!   (`reviewer.rs`); its base is the pull request's **base branch**, checked
//!   against origin's real tip as `review_base` does for every card
//!   ([`review_target`]). The card's Builder state records the Challenger's
//!   vendor as "the other one" of its `vendor` ([`builder_state_for`]).
//! - **Findings stay local.** Nothing is posted to GitHub: no comment, no
//!   review, no edit of the pull request, no issue on a GitHub board.
//! - **Fix with the Builder** only when the pull request's branch is the
//!   member's own and pushable ([`fix_permission`]: same repository, not a
//!   fork, opened by the member, GitHub doesn't refuse their push). The
//!   Builder works in the card's worktree as on any card; **Push the fixes**
//!   is `card_pr_push_update`'s card-scoped push of the verified snapshot to
//!   the pull request's own branch (`pr_fix::PushTarget`), never forced.
//!   Anyone else's pull request is review-only: every Builder start is
//!   refused ([`builder_refusal`]), and Ship never takes the card
//!   ([`ship_refusal`]).
//! - **Push** (owner decision A, AGENTS.md): only the member's own pull
//!   request's head branch, with a lease on the head the fix is built on,
//!   never the target, default or base branch.
//! - **Follows the pull request**: the card page's open and the PR poller
//!   (every [`POLL_MS`]) read it again ([`apply_facts`]). New commits on its
//!   head offer **Review again**, which brings the card's branch there
//!   (`worktrees::move_pr_card_branch`) and reviews the new head; merged or
//!   closed, the card says so and offers no review ([`review_offer`]).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::kanban::{BuilderState, KanbanCard, KanbanColumnId, KanbanStore};
use crate::pr_status::PrState;

/// `gh pr list --json` fields the sheet lists.
pub const PR_LIST_FIELDS: &str =
    "number,title,url,author,headRefName,baseRefName,isCrossRepository,isDraft,updatedAt";
/// `gh pr view --json` fields the card is made from and refreshed with.
pub const PR_VIEW_FIELDS: &str =
    "number,title,url,state,author,body,baseRefName,headRefName,headRefOid,isCrossRepository";

/// How often the poller reads a followed pull request (an open one, on a
/// card not archived). A failed read waits twice as long, up to 30 minutes.
pub const POLL_MS: i64 = 3 * 60 * 1000;
const POLL_MAX_MS: i64 = 30 * 60 * 1000;

/// The pull request's description kept in the card's brief, in characters.
pub const BRIEF_BODY_MAX: usize = 8_000;
/// The card title's pull request title, in characters.
const TITLE_MAX: usize = 120;

/// P3-10: why a fork's pull request is review-only.
pub const FORK_NOTE: &str = "This pull request comes from a fork: its branch lives in the fork, not in this \
repository, so the Reviewer only reviews it. A fix goes to the fork's branch upstream, from a checkout of the fork.";

pub const NO_GITHUB_ORIGIN: &str = "Review a pull request needs this workspace's repository on GitHub: its origin \
isn't a GitHub repository.";

/// What the card keeps of the pull request it reviews.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PrReview {
    pub url: String,
    pub number: u64,
    /// `owner/name`, the workspace's GitHub repository.
    pub repo: String,
    /// The pull request's title as GitHub last said it.
    pub title: String,
    /// Who opened it (GitHub login); `None` for a deleted account.
    pub author: Option<String>,
    /// The branch it merges into: the review's base.
    pub base_ref: String,
    /// Its own branch (in a fork for a cross-repository pull request).
    pub head_ref: String,
    /// The head commit GitHub last reported.
    pub head_sha: String,
    /// The pull request head the card's branch was last brought to (its
    /// review admitted, a push, Bring in the new commits): the head a fix
    /// is built on, and the one Push the fixes requires GitHub still has.
    pub branch_head: Option<String>,
    pub cross_repository: bool,
    /// The member may fix it with the Builder and push to its branch.
    pub pushable: bool,
    /// Why not, in plain words, when `pushable` is false.
    pub fix_note: Option<String>,
    pub state: PrState,
    /// When Plyloft last read it from GitHub (unix ms).
    pub checked_at: i64,
    /// The card's snapshots that are heads of the pull request, by number
    /// (the others are the Builder's fixes), oldest first.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub heads: Vec<u32>,
    /// The last read failed: why, for the card. Cleared by the next read.
    pub read_error: Option<String>,
    /// The Challenger chosen in the sheet ("claude" | "codex"): it stays the
    /// reviewer whichever vendor fixes the pull request. `None` on cards
    /// made before it (then the other of the Builder's vendor).
    pub challenger: Option<String>,
    /// Round 2 (P2-A): how many snapshots the card had when `branch_head`
    /// was last set. Only a snapshot after it is built on `branch_head` —
    /// a fix that can be pushed.
    #[serde(skip_serializing_if = "is_zero")]
    pub head_mark: u32,
    /// Bring in the new commits merged them into the card's branch and no
    /// Build done has snapshotted the merge yet.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub merged: bool,
    /// Walk 2 of #386: each Push the fixes GitHub took, oldest first — the
    /// card's Activity, and the head the push replaced, so a read right
    /// after it that still reports that head (GitHub not caught up yet) is
    /// not taken for the pull request going back under the fix.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub pushes: Vec<PrPush>,
    /// Walk 2 of #386: when Plyloft first read the pull request merged or
    /// closed (unix ms), for the card's Activity. 0: open, or before it.
    #[serde(skip_serializing_if = "is_zero_ms")]
    pub closed_at: i64,
    /// Walk 3 of #386 (finding 9): when each Builder session on the card
    /// started (Fix with the Builder, Start fresh), oldest first, at most
    /// [`FIX_STARTS_KEPT`] — the card's Activity, one entry each.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub fix_starts: Vec<i64>,
    /// Walk 3 of #386 (finding 5): each Bring in the new commits that merged
    /// them, oldest first, at most [`PUSHES_KEPT`] — the card's Activity
    /// ("New commits on the pull request, read at …", then the merge).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub merges: Vec<PrMerge>,
    /// Walk 3 of #386 (finding 6): the last Bring in the new commits met a
    /// conflict — the head it tried and the fix it was under. While both are
    /// still the card's, pressing it again would conflict again: the
    /// Builder resolves it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merge_conflict: Option<PrConflict>,
}

/// New commits on the pull request under an unpushed fix: read at `head`,
/// then merged into the card's branch (Bring in the new commits, or the
/// Builder itself) and built as snapshot `snapshot`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PrMerge {
    /// The pull request's head that was read (and merged).
    pub head: String,
    /// When it was read (unix ms).
    pub at: i64,
    /// Walk 4 of #386: the card's snapshot that is the merge of `head` (the
    /// Activity says "Merged the pull request's new commits" for it, not
    /// "Claude fixed it"). `None`: not merged and built yet, or recorded
    /// before it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<u32>,
}

/// A Bring in the new commits that conflicted.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PrConflict {
    /// The pull request's head it tried to merge.
    pub head: String,
    /// The card's newest snapshot (the fix) it tried to merge under.
    pub fix: String,
}

/// How many Builder session starts a card keeps for its Activity.
pub const FIX_STARTS_KEPT: usize = 20;

/// Walk 3 of #386 (finding 9): a Builder session started at `at`.
pub fn record_fix_start(pr: &mut PrReview, at: i64) {
    pr.fix_starts.push(at);
    if pr.fix_starts.len() > FIX_STARTS_KEPT {
        let extra = pr.fix_starts.len() - FIX_STARTS_KEPT;
        pr.fix_starts.drain(..extra);
    }
}

/// Walk 3 of #386 (finding 5), walk 4: the pull request's new commits were
/// read at `head` under an unpushed fix (`at`). Once per head: a later read
/// or Bring in of the same head keeps the first.
pub fn record_merge(pr: &mut PrReview, head: &str, at: i64) {
    if head.is_empty() || pr.merges.iter().any(|m| m.head == head) {
        return;
    }
    pr.merges.push(PrMerge { head: head.to_string(), at, snapshot: None });
    if pr.merges.len() > PUSHES_KEPT {
        let extra = pr.merges.len() - PUSHES_KEPT;
        pr.merges.drain(..extra);
    }
}

/// Walk 4 of #386 (finding 1): the pull request's head was read and it has
/// new commits under the card's unpushed fix — its Activity says so ("New
/// commits on the pull request, read at …"). True when it recorded one.
pub fn note_head_read(card: &mut KanbanCard, now: i64) -> bool {
    let dropped = drop_reads_over_pushed_fix(card);
    if !merge_offered(card) {
        return dropped;
    }
    let Some(pr) = card.pr_review.as_mut() else { return false };
    if pr.merges.iter().any(|m| m.head == pr.head_sha) {
        return false;
    }
    let head = pr.head_sha.clone();
    record_merge(pr, &head, now);
    true
}

/// Mac walk 2026-10-17 of #386: a read before the fix recorded a
/// "new commits under your fix" read (`merges`, no snapshot) for new
/// commits on top of a pushed fix — nothing was merged and no fix was
/// unpushed. Such an entry goes: one with no snapshot, read after a push
/// with no snapshot (a new fix) between that push and the read, whose head
/// isn't merged into the card's branch (Bring in) nor conflicting there.
/// True when it dropped one.
pub fn drop_reads_over_pushed_fix(card: &mut KanbanCard) -> bool {
    let Some(pr) = card.pr_review.as_ref() else { return false };
    if pr.merges.iter().all(|m| m.snapshot.is_some()) || pr.pushes.is_empty() {
        return false;
    }
    let snapshot_ats: Vec<i64> =
        card.builder.as_ref().map(|b| b.snapshots.iter().map(|s| s.at).collect()).unwrap_or_default();
    let pushes = pr.pushes.clone();
    let in_branch = |head: &str| {
        (pr.merged && pr.branch_head.as_deref() == Some(head))
            || pr.merge_conflict.as_ref().is_some_and(|c| c.head == head)
    };
    let wrong: Vec<bool> = pr
        .merges
        .iter()
        .map(|m| {
            m.snapshot.is_none()
                && !in_branch(&m.head)
                && pushes
                    .iter()
                    .filter(|p| p.at <= m.at)
                    .map(|p| p.at)
                    .max()
                    .is_some_and(|pushed| !snapshot_ats.iter().any(|&at| at > pushed && at <= m.at))
        })
        .collect();
    if !wrong.contains(&true) {
        return false;
    }
    let p = card.pr_review.as_mut().expect("checked above");
    let mut i = 0;
    p.merges.retain(|_| {
        let keep = !wrong[i];
        i += 1;
        keep
    });
    true
}

/// Walk 4 of #386 (finding 1): the card's newest snapshot is a fix that
/// contains the head GitHub reports — the Builder merged the pull request's
/// new commits itself (resolving a conflict), or Bring in the new commits
/// did and Build done built it. The head is in: the fix is built on it
/// (`branch_head`, marked just before the fix), no conflict stands, and the
/// snapshot is recorded as the merge for the Activity when the head came
/// in with it (the snapshot before it didn't have it). `contains(a, b)`:
/// commit `a` is in `b`'s history. True when it changed the card.
pub fn adopt_head_in_fix(card: &mut KanbanCard, contains: &dyn Fn(&str, &str) -> bool, now: i64) -> bool {
    let Some(pr) = card.pr_review.as_ref() else { return false };
    let Some(b) = card.builder.as_ref() else { return false };
    let Some(last) = b.snapshots.last().cloned() else { return false };
    let head = pr.head_sha.clone();
    // A review-only card (the head turned protected at a push, a fork)
    // never pushes its fix: nothing to adopt, as on a read.
    if !pr.pushable || pr.state != PrState::Open || head.is_empty() || pr.heads.contains(&last.n) || last.sha == head {
        return false;
    }
    let needs_head = pr.branch_head.as_deref() != Some(head.as_str());
    let entry = pr.merges.iter().rposition(|m| m.head == head);
    let needs_label = entry.is_some_and(|i| pr.merges[i].snapshot.is_none());
    if !(needs_head || needs_label) || !contains(&head, &last.sha) {
        return false;
    }
    // Challenger on walk 4: a head that went back (force-pushed to a commit
    // the head the fix is built on already had) is in the fix without
    // anyone merging it, and pushing the fix would bring back the commits
    // taken off the pull request. Not adopted on its own: the card offers
    // Bring in the new commits, the member's own press.
    if needs_head && pr.branch_head.as_deref().is_some_and(|bh| contains(&head, bh)) {
        return false;
    }
    let prev = b.snapshots.iter().rev().nth(1).map(|s| s.sha.clone());
    let came_in_now = !prev.as_deref().is_some_and(|p| contains(&head, p));
    let p = card.pr_review.as_mut().expect("checked above");
    // True only for a real change: a read every few minutes that changes
    // nothing emits nothing.
    let mut changed = false;
    if needs_head {
        p.branch_head = Some(head.clone());
        p.head_mark = last.n.saturating_sub(1);
        p.merged = false;
        changed = true;
    }
    if p.merge_conflict.take().is_some() {
        changed = true;
    }
    if came_in_now {
        match entry {
            Some(i) => {
                let m = &mut p.merges[i];
                if m.snapshot.is_none() {
                    m.snapshot = Some(last.n);
                    m.at = m.at.min(last.at);
                    changed = true;
                }
            }
            None => {
                record_merge(p, &head, last.at.min(now));
                if let Some(m) = p.merges.last_mut().filter(|m| m.head == head) {
                    m.snapshot = Some(last.n);
                    changed = true;
                }
            }
        }
    }
    changed
}

/// [`adopt_head_in_fix`]'s `contains`, answered by git in `worktree` for
/// `head` and the card's two newest snapshots, the head its fix is built on
/// (`branch_head`, to tell a head that went back), plus `extra`, asked
/// before the card is written — no git under the board's lock.
pub fn head_containment(card: &KanbanCard, worktree: &Path, head: &str, extra: Option<&str>) -> impl Fn(&str, &str) -> bool {
    let mut revs: Vec<String> = card
        .builder
        .as_ref()
        .map(|b| b.snapshots.iter().rev().take(2).map(|s| s.sha.clone()).collect())
        .unwrap_or_default();
    revs.extend(extra.map(str::to_string));
    revs.extend(card.pr_review.as_ref().and_then(|p| p.branch_head.clone()).filter(|bh| bh != head));
    let head = head.to_string();
    let known: Vec<(String, bool)> = if head.is_empty() {
        Vec::new()
    } else {
        revs.iter().map(|r| (r.clone(), crate::worktrees::is_ancestor(worktree, &head, r))).collect()
    };
    move |a: &str, b: &str| a == head && known.iter().any(|(r, yes)| r == b && *yes)
}

/// Walk 3 of #386 (finding 6): the last Bring in the new commits conflicted
/// and neither the pull request's head nor the card's fix has changed since.
pub fn merge_conflicts_again(card: &KanbanCard) -> bool {
    let Some(pr) = card.pr_review.as_ref() else { return false };
    let Some(c) = pr.merge_conflict.as_ref() else { return false };
    let fix = card.builder.as_ref().and_then(|b| b.snapshots.last()).map(|s| s.sha.as_str());
    c.head == pr.head_sha && fix == Some(c.fix.as_str())
}

/// One Push the fixes GitHub took.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PrPush {
    /// The commit pushed: the pull request's head after it.
    pub sha: String,
    /// The pull request's head the push replaced (the one the fix is built on).
    pub over: String,
    pub at: i64,
}

/// How long after a push a read that still reports the head it replaced is
/// GitHub not caught up yet, not a change (a push to the branch can't take
/// it back there: Push the fixes is never forced and its lease is on it).
pub const PUSH_SETTLE_MS: i64 = 10 * 60 * 1000;

fn is_zero(n: &u32) -> bool {
    *n == 0
}

fn is_zero_ms(n: &i64) -> bool {
    *n == 0
}

/// Where `branch_head` now is: `head`, with the card's snapshot count as
/// its mark (P2-A). Every move of the card's branch to a head records it.
pub fn mark_branch_head(card: &mut KanbanCard, head: &str) {
    let count = card.builder.as_ref().map_or(0, |b| b.snapshots.last().map_or(0, |s| s.n));
    if let Some(p) = card.pr_review.as_mut() {
        p.branch_head = Some(head.to_string());
        p.head_mark = count;
        p.merged = false;
    }
}

/// Owner decision (A), 2026-10-15: Push the fixes never goes to a branch
/// that is the workspace's target, the repository's default branch or the
/// pull request's own base.
pub fn protected_branch_refusal(head_ref: &str, protected: &[String]) -> Option<String> {
    let head = head_ref.trim();
    protected
        .iter()
        .map(|b| b.trim())
        .find(|b| !b.is_empty() && *b == head)
        .map(|b| {
            format!(
                "Not pushed: the pull request's branch is {b}, which is this repository's target, default or base branch. Send the fixes to GitHub only goes to a pull request's own branch."
            )
        })
}

/// Walk 3 of #386 (finding 7, owner decision): a pull request whose head is
/// a protected branch (the workspace's target, the repository's default,
/// the pull request's base) is review-only from the start — Push the fixes
/// would always be refused there. Its card's words, or `None`.
pub fn protected_head_note(head_ref: &str, protected: &[String]) -> Option<String> {
    let head = head_ref.trim();
    protected
        .iter()
        .map(|b| b.trim())
        .find(|b| !b.is_empty() && *b == head)
        .map(|b| format!("{PROTECTED_HEAD_LEAD}{b}: Plyloft reviews it but can't push fixes to it."))
}

/// The lead of [`protected_head_note`]'s words.
pub const PROTECTED_HEAD_LEAD: &str = "This pull request's branch is ";

/// The card becomes review-only when its head is protected (walk 3 of #386,
/// finding 7). True when it changed.
pub fn apply_protected_head(pr: &mut PrReview, protected: &[String]) -> bool {
    if !pr.pushable {
        return false;
    }
    let mut all = protected.to_vec();
    all.push(pr.base_ref.clone());
    match protected_head_note(&pr.head_ref, &all) {
        Some(note) => {
            pr.pushable = false;
            pr.fix_note = Some(note);
            true
        }
        None => false,
    }
}

/// Challenger on #386 walk 3: a card that turned review-only (a fork, a
/// protected head) while it had a fix not pushed yet says the fix is kept
/// where it is — on the card's branch, in its worktree — and never pushed.
pub fn note_kept_fix(card: &mut KanbanCard) {
    let fixed = unpushed_fix(card);
    let branch = card.branch_name.clone().unwrap_or_else(|| "the card's branch".into());
    let Some(pr) = card.pr_review.as_mut() else { return };
    if pr.pushable || !fixed {
        return;
    }
    let note = pr.fix_note.get_or_insert_with(String::new);
    if note.contains(KEPT_FIX_LEAD) {
        return;
    }
    if !note.is_empty() {
        note.push(' ');
    }
    note.push_str(&format!("{KEPT_FIX_LEAD} on {branch} in the card's own copy of the project; Plyloft won't push it."));
}

/// The lead of [`note_kept_fix`]'s words.
pub const KEPT_FIX_LEAD: &str = "The fix this card already has stays";

/// The branches a pull request card's fixes never go to that this Mac can
/// tell without GitHub: the workspace's target and origin's HEAD as the
/// clone has it.
fn local_protected<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str, cwd: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(config) = app.try_state::<crate::project_config::ProjectConfigStore>() {
        out.push(config.get(workspace_id).map(|c| c.target_branch.clone()).unwrap_or_else(|| "main".to_string()));
        // 1.173.0 (B3): and every area's branch.
        let workspace_branch = out[0].clone();
        for area in crate::areas::resolve(&crate::areas::for_workspace(&config, workspace_id), &workspace_branch) {
            if !out.contains(&area.branch) {
                out.push(area.branch);
            }
        }
    }
    if let Ok(head) = crate::git::capture(cwd, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]) {
        if let Some(name) = head.trim().strip_prefix("origin/") {
            out.push(name.to_string());
        }
    }
    out
}

/// One pull request as GitHub gives it ([`PR_VIEW_FIELDS`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrFacts {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: PrState,
    pub author: Option<String>,
    pub body: String,
    pub base_ref: String,
    pub head_ref: String,
    pub head_sha: String,
    pub cross_repository: bool,
}

fn text(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|s| s.as_str()).unwrap_or("").to_string()
}

fn author_of(v: &serde_json::Value) -> Option<String> {
    v.get("author")
        .and_then(|a| a.get("login"))
        .and_then(|l| l.as_str())
        .map(str::to_string)
        .filter(|l| !l.is_empty())
}

pub fn parse_state(word: &str) -> PrState {
    match word.to_ascii_uppercase().as_str() {
        "MERGED" => PrState::Merged,
        "CLOSED" => PrState::Closed,
        _ => PrState::Open,
    }
}

/// `gh pr view --json PR_VIEW_FIELDS`.
pub fn parse_pr_view(json: &str) -> Result<PrFacts, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("couldn't read GitHub's answer: {e}"))?;
    let number = v
        .get("number")
        .and_then(|n| n.as_u64())
        .ok_or_else(|| "GitHub's answer has no pull request number".to_string())?;
    let facts = PrFacts {
        number,
        title: text(&v, "title"),
        url: text(&v, "url"),
        state: parse_state(&text(&v, "state")),
        author: author_of(&v),
        body: text(&v, "body"),
        base_ref: text(&v, "baseRefName"),
        head_ref: text(&v, "headRefName"),
        head_sha: text(&v, "headRefOid"),
        // Unknown reads as a fork: never a push on a guess.
        cross_repository: v.get("isCrossRepository").and_then(|b| b.as_bool()).unwrap_or(true),
    };
    if facts.base_ref.is_empty() {
        return Err(format!("GitHub didn't say which branch pull request #{number} merges into"));
    }
    Ok(facts)
}

/// One open pull request in the sheet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrListItem {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub author: Option<String>,
    pub head_ref: String,
    pub base_ref: String,
    pub cross_repository: bool,
    pub draft: bool,
    pub updated_at: Option<String>,
    /// Opened by the member (the workspace's GitHub account).
    pub mine: bool,
    /// The card already reviewing it, when there is one (not archived).
    pub card_id: Option<String>,
}

/// `gh pr list --json PR_LIST_FIELDS`; `me`: the member's login.
pub fn parse_pr_list(json: &str, me: Option<&str>, cards: &[KanbanCard]) -> Result<Vec<PrListItem>, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("couldn't read GitHub's answer: {e}"))?;
    let items = v.as_array().ok_or_else(|| "GitHub's answer is not a list".to_string())?;
    Ok(items
        .iter()
        .filter_map(|item| {
            let number = item.get("number")?.as_u64()?;
            let author = author_of(item);
            Some(PrListItem {
                number,
                title: text(item, "title"),
                url: text(item, "url"),
                mine: me.is_some_and(|me| author.as_deref().is_some_and(|a| a.eq_ignore_ascii_case(me))),
                author,
                head_ref: text(item, "headRefName"),
                base_ref: text(item, "baseRefName"),
                cross_repository: item.get("isCrossRepository").and_then(|b| b.as_bool()).unwrap_or(true),
                draft: item.get("isDraft").and_then(|b| b.as_bool()).unwrap_or(false),
                updated_at: item.get("updatedAt").and_then(|s| s.as_str()).map(str::to_string),
                card_id: card_for(cards, number).map(|c| c.id.clone()),
            })
        })
        .collect())
}

/// The card (not archived) already reviewing pull request `number`.
pub fn card_for(cards: &[KanbanCard], number: u64) -> Option<&KanbanCard> {
    cards
        .iter()
        .find(|c| !c.archived && c.pr_review.as_ref().is_some_and(|p| p.number == number))
}

/// The pull request a pasted text names: a link to one of `repo`'s pull
/// requests (`https://github.com/<owner>/<name>/pull/<n>`, anything after
/// the number ignored), `#<n>` or `<n>`.
pub fn parse_pr_input(input: &str, repo: &str) -> Result<u64, String> {
    let trimmed = input.trim();
    let bare = trimmed.strip_prefix('#').unwrap_or(trimmed);
    if !bare.is_empty() && bare.bytes().all(|b| b.is_ascii_digit()) {
        return bare
            .parse::<u64>()
            .ok()
            .filter(|n| *n > 0)
            .ok_or_else(|| format!("“{trimmed}” is not a pull request number."));
    }
    let not_one = || format!("“{trimmed}” isn't a link to a pull request. Paste its link from GitHub, like https://github.com/{repo}/pull/12.");
    let rest = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .ok_or_else(not_one)?;
    let rest = rest.strip_prefix("www.").unwrap_or(rest);
    let rest = rest.strip_prefix("github.com/").ok_or_else(not_one)?;
    let mut parts = rest.split(['/', '?', '#']);
    let (owner, name, pull, number) = (parts.next(), parts.next(), parts.next(), parts.next());
    let (Some(owner), Some(name), Some("pull"), Some(number)) = (owner, name, pull, number) else {
        return Err(not_one());
    };
    let number: u64 = number.parse().ok().filter(|n| *n > 0).ok_or_else(not_one)?;
    let named = format!("{owner}/{name}");
    if !named.eq_ignore_ascii_case(repo) {
        return Err(format!(
            "That pull request is in {named}, not in this workspace's repository ({repo})."
        ));
    }
    Ok(number)
}

/// Whether the member may fix the pull request with the Builder and push
/// to its branch: same repository (not a fork), opened by the member, and
/// GitHub doesn't say they can't push (`push`: `None` is "GitHub didn't
/// say" — GitHub still refuses a push it doesn't allow). Else why not.
pub fn fix_permission(facts: &PrFacts, login: Option<&str>, push: Option<bool>) -> (bool, Option<String>) {
    if facts.cross_repository {
        return (
            false,
            Some(FORK_NOTE.into()),
        );
    }
    let Some(login) = login.filter(|l| !l.is_empty()) else {
        return (
            false,
            Some("Plyloft couldn't tell which GitHub account you use here, so the Reviewer only reviews it.".into()),
        );
    };
    match facts.author.as_deref() {
        Some(author) if author.eq_ignore_ascii_case(login) => {}
        Some(author) => {
            return (
                false,
                Some(format!("This is {author}'s pull request: the Reviewer only reviews it, and the Builder doesn't change it.")),
            )
        }
        None => {
            return (
                false,
                Some("GitHub doesn't say who opened this pull request, so the Reviewer only reviews it.".into()),
            )
        }
    }
    if push == Some(false) {
        return (
            false,
            Some("Your GitHub account can't push to this repository, so the Reviewer only reviews it.".into()),
        );
    }
    if facts.head_ref.trim().is_empty() || facts.head_ref == facts.base_ref {
        return (
            false,
            Some("This pull request's branch is its base branch, so the Reviewer only reviews it.".into()),
        );
    }
    (true, None)
}

fn cut(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// The card's title.
pub fn card_title(facts: &PrFacts) -> String {
    let title = facts.title.trim();
    if title.is_empty() {
        format!("Review: pull request #{}", facts.number)
    } else {
        format!("Review: {}", cut(title, TITLE_MAX))
    }
}

/// The card's brief — what the Challenger reviews the pull request against:
/// which pull request, its branches and its description as its author wrote
/// it (cut at [`BRIEF_BODY_MAX`]).
pub fn brief(facts: &PrFacts) -> String {
    let by = facts.author.as_deref().map(|a| format!(" by @{a}")).unwrap_or_default();
    let mut out = format!(
        "Pull request #{}{by}: {}\n{}\nIts branch {} merges into {}.",
        facts.number,
        facts.title.trim(),
        facts.url,
        facts.head_ref,
        facts.base_ref
    );
    let body = facts.body.trim();
    if !body.is_empty() {
        out.push_str("\n\nThe pull request's description, as its author wrote it:\n\n");
        out.push_str(&cut(body, BRIEF_BODY_MAX));
    }
    out
}

/// The card's record of the pull request when the card is made.
pub fn new_review(facts: &PrFacts, repo: &str, head: &str, pushable: bool, fix_note: Option<String>, now: i64) -> PrReview {
    // `branch_head` is set once a review of `head` is admitted
    // (`builder::record_pr_head_review`).
    PrReview {
        url: facts.url.clone(),
        number: facts.number,
        repo: repo.to_string(),
        title: facts.title.clone(),
        author: facts.author.clone(),
        base_ref: facts.base_ref.clone(),
        head_ref: facts.head_ref.clone(),
        head_sha: head.to_string(),
        branch_head: None,
        cross_repository: facts.cross_repository,
        pushable,
        fix_note,
        state: facts.state,
        checked_at: now,
        heads: Vec::new(),
        read_error: None,
        challenger: None,
        head_mark: 0,
        merged: false,
        pushes: Vec::new(),
        closed_at: 0,
        fix_starts: Vec::new(),
        merges: Vec::new(),
        merge_conflict: None,
    }
}

/// The pull request read again: true when anything the card shows changed.
/// Whose it is and whether it is pushable stay as recorded, except that a
/// pull request that turned out to come from a fork is never pushable.
pub fn apply_facts(review: &mut PrReview, facts: &PrFacts, now: i64) -> bool {
    let before = review.clone();
    review.title = facts.title.clone();
    if facts.author.is_some() {
        review.author = facts.author.clone();
    }
    review.base_ref = facts.base_ref.clone();
    review.head_ref = facts.head_ref.clone();
    // Walk 2 of #386: right after Push the fixes GitHub can still report
    // the head the push replaced; the card keeps the pushed one.
    let lagging = review.pushes.last().is_some_and(|p| {
        p.sha == review.head_sha && p.over == facts.head_sha && now.saturating_sub(p.at) < PUSH_SETTLE_MS
    });
    if !facts.head_sha.is_empty() && !lagging {
        review.head_sha = facts.head_sha.clone();
    }
    if review.state == PrState::Open && facts.state != PrState::Open {
        review.closed_at = now;
    }
    if facts.state == PrState::Open {
        review.closed_at = 0;
    }
    review.state = facts.state;
    if facts.cross_repository && !review.cross_repository {
        review.cross_repository = true;
        review.pushable = false;
        review.fix_note = Some(
            FORK_NOTE.into(),
        );
    }
    review.read_error = None;
    let changed = *review != PrReview { checked_at: review.checked_at, ..before };
    review.checked_at = now;
    changed
}

/// What the card offers for the Challenger now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewOffer {
    /// Never reviewed: Review.
    Review,
    /// The pull request has commits the card hasn't reviewed: Review again.
    NewCommits,
    /// The last review of this head failed or was incomplete: Review again.
    RunAgain,
    Running,
    /// This head is reviewed; nothing to do until it changes.
    Current,
    /// Merged or closed: no review.
    Closed,
}

/// Pure; `src/lib/prReview.ts::reviewOffer` mirrors it.
pub fn review_offer(card: &KanbanCard) -> Option<ReviewOffer> {
    let pr = card.pr_review.as_ref()?;
    if pr.state != PrState::Open {
        return Some(ReviewOffer::Closed);
    }
    let b = card.builder.as_ref();
    let review = b.and_then(|b| b.review.as_ref());
    if review.is_some_and(|r| r.status == "running") {
        return Some(ReviewOffer::Running);
    }
    // P3-1: new commits are a head GitHub reports that no snapshot of the
    // card is (a pushed fix is one). Walk 3 of #386 (finding 5): nor the
    // head an unpushed fix is built on (Bring in the new commits merged it):
    // the fix's own review is the one that counts.
    // Challenger on 55c90ec2: nor a pushed fix the pull request was taken
    // off (its head went back to a commit the card has).
    let snapshots = b.map(|b| b.snapshots.as_slice()).unwrap_or_default();
    if !snapshots.is_empty()
        && (!snapshots.iter().any(|s| s.sha == pr.head_sha) || pushed_fix_taken_off(card))
        && !fix_on_head(card)
    {
        return Some(ReviewOffer::NewCommits);
    }
    let last = snapshots.last();
    match (last, review) {
        (Some(last), Some(r)) if r.snapshot_n == last.n => Some(if crate::builder::review_can_run_again(r) {
            ReviewOffer::RunAgain
        } else {
            ReviewOffer::Current
        }),
        _ => Some(ReviewOffer::Review),
    }
}

/// The base branch the card's review is measured from: the pull request's
/// base, else the workspace's configured target.
pub fn review_target(card: &KanbanCard, configured: &str) -> String {
    card.pr_review
        .as_ref()
        .map(|p| p.base_ref.trim())
        .filter(|b| !b.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| configured.to_string())
}

/// Every Builder start on the card (Start build, Resume, Build with both,
/// a drag to In progress): refused on anyone else's pull request and on one
/// that is no longer open.
pub fn builder_refusal(card: &KanbanCard) -> Option<String> {
    let pr = card.pr_review.as_ref()?;
    if !pr.pushable {
        return Some(pr.fix_note.clone().unwrap_or_else(|| {
            "This card reviews someone else's pull request: the Reviewer only reviews it, and the Builder doesn't change it.".into()
        }));
    }
    if pr.state != PrState::Open {
        return Some(format!("Pull request #{} is {}: there is nothing left to fix.", pr.number, state_words(pr.state)));
    }
    None
}

/// 1.175.0 G7 (proof P3): why no terminal tile starts in `cwd`, when it is
/// in the copy of a pull request Plyloft only reviews (a card whose review
/// is review-only, as [`builder_refusal`] reads it: somebody else's, or the
/// member's own that Plyloft can't push to). That copy sits under a folder
/// Claude already trusts, so a session there asks no trust question and
/// runs the hooks of the copy's own `.claude/settings.json`. The card
/// offers no terminal there; this is the same refusal where every tile
/// starts (`commands::pty_spawn`), for a tile restarted, resumed from
/// History or asked for by an older window. It cannot stop a `cd` typed in
/// a shell that started somewhere else.
///
/// Round 3: it fails closed. `cards` is the tile's board, `None` when it
/// couldn't be read (or the tile names no workspace). A folder that is, by
/// its path, a card's copy — under a worktrees root and not a copy without
/// a card (`copy-…`) — starts a terminal only when a card of that board
/// owns it (its own copy, or a build's when both build it) and that card
/// isn't review-only. A board file set aside as unreadable is read as an
/// empty board, so a copy no card owns is refused too. Any other folder:
/// `None`, whatever the board.
pub fn terminal_refusal(cards: Option<&[KanbanCard]>, cwd: &Path) -> Option<String> {
    let (worktree, dir) = crate::worktree_ports::worktree_of(cwd)?;
    if crate::copies::is_copy_id(&dir) {
        return None;
    }
    let same = |path: &str| !path.is_empty() && crate::worktree_ports::same_dir(Path::new(path), &worktree);
    let owner = cards.and_then(|cards| {
        cards.iter().find(|card| {
            card.worktree_path.as_deref().is_some_and(same)
                || card.build_both.as_ref().is_some_and(|bb| bb.lanes.iter().any(|lane| same(&lane.worktree_path)))
        })
    });
    match owner {
        Some(card) if card.pr_review.as_ref().is_some_and(|pr| !pr.pushable) => Some(format!(
            "This folder is the copy of a pull request Plyloft only reviews, so it opens no terminal in it: its \
             files could run things on {} without asking. The card's Reviewer reads it.",
            crate::platform::THIS_MACHINE
        )),
        Some(_) => None,
        None => Some(format!(
            "Plyloft couldn't tell which card this folder is the copy of, so it opens no terminal in it: the \
             copy of a pull request it only reviews could run things on {} without asking.",
            crate::platform::THIS_MACHINE
        )),
    }
}

/// [`terminal_refusal`] for a tile of `workspace_id` about to start in `cwd`.
pub fn refuse_terminal<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: Option<&str>,
    cwd: Option<&str>,
) -> Result<(), String> {
    let Some(cwd) = cwd.map(Path::new) else { return Ok(()) };
    if crate::worktree_ports::worktree_of(cwd).is_none() {
        return Ok(());
    }
    let cards = workspace_id.and_then(|id| app.try_state::<KanbanStore>().and_then(|store| store.load(id).ok()));
    terminal_refusal(cards.as_deref(), cwd).map_or(Ok(()), Err)
}

/// Resume on a pull request card: refused while its Builder never started.
/// The card has a Builder record from the start (its reviews live there),
/// so there is no conversation to continue, and a resume would also step
/// past the workspace's setup the first Fix with the Builder runs (walk of
/// #386, step 7). Cards that review no pull request: `None`.
pub fn resume_refusal(card: &KanbanCard) -> Option<String> {
    card.pr_review.as_ref()?;
    let never = card.builder.as_ref().is_none_or(|b| b.started_at <= 0 && b.pty_id.is_none());
    never.then(|| NOT_STARTED_RESUME_REFUSAL.to_string())
}

/// `resume_refusal`'s words.
pub const NOT_STARTED_RESUME_REFUSAL: &str =
    "The Builder hasn't started on this card, so there is no session to resume. Fix with the Builder starts it.";

/// P3-5: someone else's pull request gets no work of a Builder's kind —
/// Verify, line comments for a Builder — only its review.
pub fn work_refusal(card: &KanbanCard) -> Option<String> {
    let pr = card.pr_review.as_ref()?;
    (!pr.pushable).then(|| {
        format!(
            "Pull request #{} isn't yours to change here: the Reviewer only reviews it, so it has no checks or line comments for a Builder.",
            pr.number
        )
    })
}

/// The card's Chat (merged with v1.165.0): what a pull request card is,
/// told to its session in place of "code changes are made by the card's
/// Builder" — someone else's pull request has no Builder, and the member's
/// own is fixed only on their press (Fix with the Builder, Push the fixes).
pub fn chat_note(pr: &PrReview, base: Option<&str>) -> String {
    let mut what = format!(
        "This card reviews pull request #{} ({} into {}); the project folder is its code.",
        pr.number, pr.head_ref, pr.base_ref
    );
    // Walk of #386: told where the pull request starts, a chat that can
    // run read-only commands (Codex) reads its diff instead of guessing.
    if let Some(base) = base.map(str::trim).filter(|b| !b.is_empty() && b.chars().all(|c| c.is_ascii_hexdigit())) {
        what.push_str(&format!(
            " Its changes are `git diff {base}...HEAD` in that folder ({base} is where it leaves {}).",
            pr.base_ref
        ));
    }
    if pr.pushable {
        format!("{what} It is the member's own pull request: fixes are made by the card's Builder, never in this chat.")
    } else if let Some(note) = pr.fix_note.as_deref().filter(|n| n.starts_with(PROTECTED_HEAD_LEAD)) {
        // Walk 3 of #386 (finding 7): the member's own, on a protected branch.
        format!("{what} {note} Nothing on this card changes its code.")
    } else {
        format!("{what} It is someone else's pull request: Plyloft only reviews it, and nothing on this card changes its code.")
    }
}

/// The card's chat note (`chat_note`) for `card`, with its recorded base.
pub fn chat_note_of(card: &KanbanCard) -> Option<String> {
    let pr = card.pr_review.as_ref()?;
    Some(chat_note(pr, card.worktree_base.as_ref().map(|b| b.commit.as_str())))
}

/// Walk of #386: the teammate half of "Overlapping edits" skips pull
/// request `number` when it is the one `me` reviews — a pull request card's
/// changes are that pull request's — or one a local card already listed in
/// `listed` reviews (named once, as that card).
pub fn overlap_skips_pr(
    me: &KanbanCard,
    cards: &[KanbanCard],
    listed: &[crate::overlap::OverlapWarning],
    number: u64,
) -> bool {
    if me.pr_review.as_ref().is_some_and(|p| p.number == number) {
        return true;
    }
    listed.iter().any(|w| {
        w.kind == crate::overlap::OverlapKind::LocalCard
            && cards
                .iter()
                .any(|c| c.id == w.other_id && c.pr_review.as_ref().is_some_and(|p| p.number == number))
    })
}

/// P3-5: a pull request card is never put back in To do.
pub const PUT_BACK_REFUSAL: &str =
    "A card that reviews a pull request isn't moved back to Ready to start. Archive it when you're done with it.";

/// Ship and Ship batch never take a card that reviews a pull request: its
/// fixes go to that pull request (Push the fixes), never into a new one or
/// onto the target branch.
pub fn ship_refusal(card: &KanbanCard) -> Option<String> {
    card.pr_review.as_ref().map(|pr| {
        format!(
            "This card reviews pull request #{}. Ship doesn't take it: fixes go to that pull request with Send the fixes to GitHub.",
            pr.number
        )
    })
}

/// The card's newest snapshot is a Builder's fix GitHub doesn't have.
/// Round 2 (P2-A): a fix counts only when it is built on `branch_head` (a
/// snapshot after the mark); a fix from before a Bring in the new commits
/// isn't, until Build done snapshots the merge.
pub fn unpushed_fix(card: &KanbanCard) -> bool {
    let (Some(pr), Some(last)) = (card.pr_review.as_ref(), card.builder.as_ref().and_then(|b| b.snapshots.last())) else {
        return false;
    };
    !pr.heads.contains(&last.n) && last.sha != pr.head_sha && last.n > pr.head_mark
}

/// Challenger on 55c90ec2: the card's branch is on its newest snapshot, a
/// pushed fix (Push the fixes, or a push adopted by [`adopt_landed_fix`],
/// marked it `branch_head`), and GitHub's head is another commit — the
/// pull request was force-pushed off the fix, maybe back to a head the
/// card already has. Its head changed: a review to run again, not
/// "Approved" (the fix's review) nor new commits under a fix.
pub fn pushed_fix_taken_off(card: &KanbanCard) -> bool {
    let (Some(pr), Some(last)) = (card.pr_review.as_ref(), card.builder.as_ref().and_then(|b| b.snapshots.last())) else {
        return false;
    };
    !pr.heads.contains(&last.n)
        && last.n <= pr.head_mark
        && pr.branch_head.as_deref() == Some(last.sha.as_str())
        && !pr.head_sha.is_empty()
        && last.sha != pr.head_sha
}

/// Walk 3 of #386 (finding 5): the card's newest snapshot is an unpushed
/// fix built on the head GitHub reports (after Bring in the new commits).
pub fn fix_on_head(card: &KanbanCard) -> bool {
    card.pr_review
        .as_ref()
        .is_some_and(|pr| unpushed_fix(card) && pr.branch_head.as_deref() == Some(pr.head_sha.as_str()))
}

/// Bring in the new commits merged them, and the merge isn't built yet:
/// the Builder's Build done (Resume the Builder) snapshots, checks and
/// reviews it.
pub fn merged_not_built(card: &KanbanCard) -> bool {
    let Some(pr) = card.pr_review.as_ref() else { return false };
    let last = card.builder.as_ref().and_then(|b| b.snapshots.last()).map_or(0, |s| s.n);
    pr.merged && last <= pr.head_mark
}

/// Walk 2 of #386 (finding 5): the Challenger's review of the card's newest
/// snapshot (the fix) has settled — it ran or was skipped, none is running
/// or waiting on the card, and it didn't ask for changes. Push the fixes
/// and "fix ready to push" wait for it.
pub fn fix_review_settled(card: &KanbanCard) -> bool {
    let Some(b) = card.builder.as_ref() else { return false };
    let Some(last) = b.snapshots.last() else { return false };
    if b.waiting_review.is_some() {
        return false;
    }
    match b.review.as_ref() {
        Some(r) if r.status == "running" => false,
        Some(r) if r.snapshot_n == last.n => {
            !(r.status == "done" && r.verdict.as_deref() == Some("changes_requested"))
        }
        _ => false,
    }
}

/// Push the fixes while the fix's review hasn't settled.
pub const PUSH_WHILE_REVIEWING: &str = "Not pushed: the Reviewer hasn't finished reviewing this fix. Send the fixes to GitHub \
once the Reviewer approves it.";

/// Round 2: the words while the merge isn't built.
pub const MERGED_NOT_BUILT: &str = "The pull request's new commits are merged into the card's branch but not built \
yet. Resume the Builder and press Finish and check: the checks and the Reviewer run on the merge, then Send the fixes to GitHub.";

/// P2-2: the member's own pull request has new commits on top of the head
/// the card's unpushed fix is built on — Bring in the new commits merges
/// them into the card's branch. Mac walk 2026-10-17 of #386: only an
/// unpushed fix (a snapshot after the mark). A pushed fix is the head the
/// card's branch is on (Push the fixes marked it), so new commits on top of
/// it are plain new commits to review, not commits under a fix.
pub fn merge_offered(card: &KanbanCard) -> bool {
    let Some(pr) = card.pr_review.as_ref() else { return false };
    pr.pushable
        && pr.state == PrState::Open
        && !merged_not_built(card)
        && unpushed_fix(card)
        && pr.branch_head.as_deref() != Some(pr.head_sha.as_str())
}

/// Round 2 (P2-B): would a review of `head` be admitted now? The refusal
/// `builder::record_pr_head_review` would give, asked before the branch is
/// moved.
pub fn admission_refusal(card: &KanbanCard, head: &str) -> Option<String> {
    let b = card.builder.as_ref()?;
    if b.review.as_ref().is_some_and(|r| r.status == "running") {
        return Some("The Reviewer is already reviewing this card".into());
    }
    let last = b.snapshots.last()?;
    if last.sha != head {
        return None;
    }
    match b.review.as_ref().filter(|r| r.snapshot_n == last.n) {
        Some(r) if !crate::builder::review_can_run_again(r) => Some(crate::builder::PR_HEAD_REVIEWED.into()),
        _ => None,
    }
}

/// The Challenger of a pull request card: the one chosen in the sheet,
/// whatever vendor fixes it.
pub fn challenger_of(card: &KanbanCard) -> Option<&str> {
    card.pr_review.as_ref()?.challenger.as_deref().filter(|c| matches!(*c, "claude" | "codex"))
}

/// P2-4: what the card asks of the person in the Inbox — a key that changes
/// with what is asked (so a new ask is new), and its words. `None`: nothing
/// (reviewing, approved and nothing to push, merged or closed).
pub fn inbox_ask(card: &KanbanCard) -> Option<(String, String)> {
    let pr = card.pr_review.as_ref()?;
    if card.archived || pr.state != PrState::Open {
        return None;
    }
    let n = pr.number;
    let short = |s: &str| s.chars().take(7).collect::<String>();
    if merge_offered(card) {
        return Some((format!("under:{}", short(&pr.head_sha)), format!("Pull request #{n} · new commits under your fix")));
    }
    if merged_not_built(card) {
        return Some((format!("merged:{}", short(&pr.head_sha)), format!("Pull request #{n} · merged, not built yet")));
    }
    if pr.pushable
        && unpushed_fix(card)
        && fix_review_settled(card)
        && !matches!(card.verify_status, crate::kanban::VerifyStatus::Failed)
        && card.builder.as_ref().is_some_and(|b| b.pty_id.is_none())
    {
        let last = card.builder.as_ref().and_then(|b| b.snapshots.last()).map(|s| short(&s.sha)).unwrap_or_default();
        return Some((format!("fix:{last}"), format!("Pull request #{n} · fix ready to push")));
    }
    match review_offer(card)? {
        ReviewOffer::Review => Some(("unreviewed".into(), format!("Pull request #{n} · not reviewed yet"))),
        ReviewOffer::NewCommits => Some((format!("head:{}", short(&pr.head_sha)), format!("Pull request #{n} · new commits to review"))),
        ReviewOffer::RunAgain => Some((format!("again:{}", short(&pr.head_sha)), format!("Pull request #{n} · the review didn't finish"))),
        ReviewOffer::Current => card
            .builder
            .as_ref()
            .and_then(|b| b.review.as_ref())
            .filter(|r| r.verdict.as_deref() == Some("changes_requested"))
            .map(|r| (format!("changes:{}", r.snapshot_n), format!("Pull request #{n} · changes requested"))),
        ReviewOffer::Running | ReviewOffer::Closed => None,
    }
}

pub fn state_words(state: PrState) -> &'static str {
    match state {
        PrState::Open => "open",
        PrState::Merged => "merged",
        PrState::Closed => "closed",
    }
}

/// The lead of the Builder's brief on a pull request card: which pull
/// request, how its fix reaches it (Push the fixes, never Ship), and what
/// to fix: the Challenger's open request for changes itself
/// ([`session_findings`], walk 2 of #386), which that session is then not
/// sent again. Walk 3 of #386 (finding 1): on every new session, not only
/// the card's first — a later one, told only "You fix it", invented a
/// change and committed it. With no open request the human says what to
/// fix, and nothing is changed until then ([`WAIT_FOR_THE_HUMAN`]).
pub fn builder_lead(card: &KanbanCard) -> Option<String> {
    let pr = card.pr_review.as_ref()?;
    let mut out = format!(
        "This card is pull request #{} ({}), branch {} into {}. You fix it in this worktree, on the card's copy of \
that branch, and commit nothing else. Plyloft pushes your fix to the pull request's branch once its checks and the \
Reviewer's pass and the human presses Send the fixes to GitHub — never push, rebase or open a pull request yourself.\n\n",
        pr.number, pr.url, pr.head_ref, pr.base_ref
    );
    match session_findings(card) {
        Some(findings) => out.push_str(&findings),
        // A review that approved asks for nothing; one still running, failed
        // or not run yet hasn't said (its verdict reaches the session when
        // it lands).
        None => {
            out.push_str(if head_review_approved(card) {
                "The review of this head asks for no changes: the human says here what to fix. "
            } else {
                "No request for changes from the Reviewer comes with this brief: the human says here what to fix. "
            });
            out.push_str(WAIT_FOR_THE_HUMAN);
            out.push_str("\n\n");
        }
    }
    Some(out)
}

/// Walk 3 of #386 (finding 1): a Builder session on a pull request card
/// with no open request for changes changes nothing on its own.
pub const WAIT_FOR_THE_HUMAN: &str = "Until the human (or a request for changes from the Reviewer) tells you what \
to fix, change nothing and commit nothing: ask what to fix.";

/// The review of the card's newest snapshot ran and approved it.
fn head_review_approved(card: &KanbanCard) -> bool {
    let Some(b) = card.builder.as_ref() else { return false };
    let Some(last) = b.snapshots.last() else { return false };
    b.review
        .as_ref()
        .is_some_and(|r| r.snapshot_n == last.n && r.status == "done" && r.verdict.as_deref() == Some("approve"))
}

/// The request for changes a pull request card's new Builder session
/// starts from, in its first prompt — the verdict a new session is owed
/// (`builder::review_kept_for_new_session`), which would otherwise reach it
/// only as a second message (walk 2 of #386, finding 3). Walk 3 (finding
/// 1): every new session's (Fix with the Builder again, Start fresh), not
/// only the card's first. `None` when the newest snapshot's review asks for
/// no changes.
pub fn session_findings(card: &KanbanCard) -> Option<String> {
    card.pr_review.as_ref()?;
    let (kept, owed) = crate::builder::review_kept_for_new_session(card.builder.as_ref());
    owed?;
    let review = kept?;
    let requested = review
        .builder_handoff
        .clone()
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
        .or_else(|| {
            let listed: Vec<String> = review
                .findings
                .iter()
                .map(|f| {
                    let id = f.id.as_deref().map(|id| format!("{id} ")).unwrap_or_default();
                    let sev = f.severity.as_deref().map(|s| format!("[{s}] ")).unwrap_or_default();
                    let at = f.location.as_deref().map(|l| format!(" ({l})")).unwrap_or_default();
                    format!("- {id}{sev}{}{at}\n  {}", f.title.trim(), f.body.trim().replace('\n', "\n  "))
                })
                .collect();
            (!listed.is_empty()).then(|| listed.join("\n\n"))
        })
        .or_else(|| review.excerpt.clone().map(|e| e.trim().to_string()).filter(|e| !e.is_empty()))?;
    let who = if review.provider == "codex" { "Codex" } else { "Claude" };
    let by_id = if review.findings.iter().any(|f| f.id.is_some()) { " Each finding carries its id; answer by id." } else { "" };
    Some(format!(
        "The Reviewer ({who}) reviewed snapshot {} — the pull request's head — read-only and requests these \
changes.{by_id}\n\n{requested}\n\nAddress what is valid, push back in one line on what is not, then say you are done: \
the human presses Finish and check.\n\n",
        review.snapshot_n
    ))
}

/// The Builder state a new card starts with: no session, no snapshot, and
/// the vendor whose Challenger is `challenger` (`builder::challenger_for`).
pub fn builder_state_for(challenger: &str) -> Result<BuilderState, String> {
    let vendor = match challenger {
        "claude" => "codex",
        "codex" => "claude",
        other => return Err(format!("the Reviewer must be Claude or Codex, not {other:?}")),
    };
    serde_json::from_value(serde_json::json!({ "vendor": vendor }))
        .map_err(|e| format!("couldn't make the card's review record: {e}"))
}

/// A new card id: `card-<ms in base 36>-pr<n>`.
pub fn new_card_id(now: i64, number: u64) -> String {
    let mut n = now.max(0) as u64;
    let mut digits = Vec::new();
    loop {
        digits.push(std::char::from_digit((n % 36) as u32, 36).unwrap_or('0'));
        n /= 36;
        if n == 0 {
            break;
        }
    }
    let ts: String = digits.into_iter().rev().collect();
    format!("card-{ts}-pr{number}")
}

/// A pull request no longer open, as a refusal.
pub fn closed_words(number: u64, state: PrState) -> String {
    format!("Pull request #{number} is {}: there is nothing to review.", state_words(state))
}

/// A `gh` failure reading pull requests, in words.
fn read_words(e: &str) -> String {
    if crate::github::is_gh_timeout(e) {
        return e.to_string();
    }
    format!("Plyloft couldn't read the pull request from GitHub: {}", e.trim())
}

/// Poller timing: an open pull request on a card not archived is read every
/// [`POLL_MS`], a failing one with a backoff.
pub fn poll_due(card: &KanbanCard, last_attempt: Option<i64>, failures: u32, now: i64) -> bool {
    let Some(pr) = card.pr_review.as_ref() else { return false };
    if card.archived || pr.state != PrState::Open {
        return false;
    }
    let interval = (POLL_MS << failures.min(4)).min(POLL_MAX_MS);
    let last = last_attempt.unwrap_or(pr.checked_at).max(pr.checked_at);
    now - last >= interval
}

// ── Tauri glue ──────────────────────────────────────────────────────────

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn workspace_cwd<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str) -> Result<PathBuf, String> {
    app.state::<crate::workspace::WorkspaceStore>()
        .snapshot()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
        .map(|w| PathBuf::from(w.cwd))
        .ok_or_else(|| format!("workspace '{workspace_id}' not found"))
}

/// The workspace's GitHub repository, from its origin.
fn github_repo(cwd: &Path) -> Result<String, String> {
    #[cfg(test)]
    if let Some(slug) = TEST_REPO.with(|r| r.borrow().clone()) {
        return Ok(slug);
    }
    crate::review_base::origin_record_of(cwd).0.ok_or_else(|| NO_GITHUB_ORIGIN.to_string())
}

#[cfg(test)]
thread_local! {
    /// Tests run against a local bare origin: the repository it stands for.
    pub(crate) static TEST_REPO: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// `gh` is on this machine. Tests answer `gh` through `github`'s seam.
fn require_gh() -> Result<(), String> {
    #[cfg(not(test))]
    crate::doctor::require("gh")?;
    Ok(())
}

/// One lock per card: the poller, the card page, a review start, Bring in
/// the new commits and a push's record never read and write the same
/// card's pull request at once.
fn card_lock(key: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut map = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    map.entry(key.to_string()).or_default().clone()
}

fn locked_card(workspace_id: &str, card_id: &str) -> Arc<Mutex<()>> {
    card_lock(&format!("{workspace_id}/{card_id}"))
}

/// What the sheet lists.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrList {
    pub repo: String,
    pub prs: Vec<PrListItem>,
}

/// The sheet (`commands::pr_review_list`): the repository's open pull
/// requests. Blocking.
pub fn list<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str) -> Result<PrList, String> {
    let cwd = workspace_cwd(app, workspace_id)?;
    let repo = github_repo(&cwd)?;
    require_gh()?;
    let _github = crate::github_account::enter_for_app(app, workspace_id);
    let json = crate::github::pr_list_for_review(&repo).map_err(|e| read_words(&e))?;
    let me = crate::github::current_login().ok();
    let cards = app.state::<KanbanStore>().load(workspace_id).unwrap_or_default();
    let prs = parse_pr_list(&json, me.as_deref(), &cards)?;
    Ok(PrList { repo, prs })
}

/// What `pr_review_create` did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewCreated {
    pub card: KanbanCard,
    /// The pull request already had a card: that one, unchanged.
    pub existing: bool,
    /// The card was made but its review didn't start: why.
    pub review_error: Option<String>,
}

/// The sheet's **Review** (`commands::pr_review_create`): the card for pull
/// request `input` (link or number), its worktree at the pull request's
/// head, and its review by `challenger` ("claude" | "codex"), started by
/// `start_review(card_id, head)` under `CARD_START_LOCK`. Blocking.
pub fn create<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    input: &str,
    challenger: &str,
    start_review: impl FnOnce(&str, &str) -> Result<(), String>,
) -> Result<PrReviewCreated, String> {
    let builder_state = builder_state_for(challenger)?;
    let workspaces = app.state::<crate::workspace::WorkspaceStore>();
    let kanban = app.state::<KanbanStore>();
    let license = app.state::<crate::license::LicenseStore>();
    // A read-only board (GitHub Issues without Team) takes no new card.
    crate::commands::team_gate_github_card_write(&workspaces, &license, workspace_id, true)?;
    let cwd = workspace_cwd(app, workspace_id)?;
    let repo = github_repo(&cwd)?;
    let number = parse_pr_input(input, &repo)?;
    if let Some(card) = card_for(&kanban.load(workspace_id)?, number).cloned() {
        return Ok(PrReviewCreated { card, existing: true, review_error: None });
    }
    require_gh()?;
    let card_id = new_card_id(now_ms(), number);
    let _github = crate::github_account::enter_for_app(app, workspace_id);
    let facts = parse_pr_view(&crate::github::pr_view_for_review(&repo, number).map_err(|e| read_words(&e))?)?;
    if facts.state != PrState::Open {
        return Err(closed_words(number, facts.state));
    }
    let login = crate::github::current_login().ok();
    let push = crate::github::repo_access(&repo).ok().and_then(|a| a.push);
    let (pushable, fix_note) = fix_permission(&facts, login.as_deref(), push);
    // Walk 3 of #386 (finding 7): a head that is a protected branch makes
    // the card review-only. The default branch is origin's HEAD as the
    // clone has it and GitHub's answer; neither known, Push the fixes still
    // refuses at the push (`pr_fix::DEFAULT_BRANCH_UNKNOWN`).
    let protected = if pushable {
        // GitHub is asked as well (as Push the fixes does): origin's HEAD in
        // the clone can be stale after the default branch was renamed.
        let mut list = local_protected(app, workspace_id, &cwd);
        list.extend(crate::github::repo_default_branch(&repo).ok().filter(|d| !d.is_empty()));
        list
    } else {
        Vec::new()
    };
    let head = crate::worktrees::fetch_pull_head(&cwd, number)
        .map_err(|e| format!("Plyloft couldn't fetch pull request #{number} from origin: {e}"))?;
    // The base branch's tip, for the recorded base (the review checks it
    // against origin again).
    if let Err(e) = crate::worktrees::fetch_origin_branch(&cwd, &facts.base_ref) {
        log::info!("pr_review: fetch origin {}: {e}", facts.base_ref);
    }
    let base = recorded_base(&cwd, &facts.base_ref, &head);

    let _start = crate::commands::CARD_START_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    // A second press while the first was reading GitHub.
    if let Some(card) = card_for(&kanban.load(workspace_id)?, number).cloned() {
        return Ok(PrReviewCreated { card, existing: true, review_error: None });
    }
    let title = card_title(&facts);
    let made = crate::worktrees::ensure_for_pr_card(&cwd, &card_id, &title, &head)?;
    let mut card = KanbanCard::new(card_id.clone(), workspace_id.to_string(), title, Some(brief(&facts)), KanbanColumnId::InProgress);
    card.worktree_path = Some(made.worktree_path.to_string_lossy().into_owned());
    card.branch_name = Some(made.branch_name.clone());
    card.worktree_base = base;
    let mut review = new_review(&facts, &repo, &head, pushable, fix_note, now_ms());
    apply_protected_head(&mut review, &protected);
    review.challenger = Some(challenger.to_string());
    card.pr_review = Some(review);
    // Fix with the Builder (the member's own pull request) starts the other
    // vendor by default; the Challenger stays the one chosen either way.
    card.builder_vendor_pref = Some(if builder_state.vendor == "codex" {
        crate::settings::BuilderVendor::Codex
    } else {
        crate::settings::BuilderVendor::Claude
    });
    card.builder = Some(builder_state);
    if let Some(settings) = app.try_state::<crate::settings::SettingsStore>() {
        let email = settings.snapshot().identity.user_email;
        card.author = email.clone();
        card.last_edited_by = email;
    }
    if let Err(e) = kanban.create_card(workspace_id, card) {
        undo_worktree(&cwd, &card_id, &made.branch_name);
        return Err(e);
    }
    if let Err(e) = kanban.ensure_port_base(workspace_id, &card_id, None) {
        log::warn!("worktree ports {workspace_id}/{card_id}: {e}");
    }
    crate::kanban::emit_kanban_changed(app, workspace_id);
    let review_error = start_review(&card_id, &head).err();
    Ok(PrReviewCreated { card: kanban.get_card(workspace_id, &card_id)?, existing: false, review_error })
}

/// The base the card records: where the pull request's head meets the
/// fetched `origin/<base>`, with origin as it is now.
fn recorded_base(cwd: &Path, base_ref: &str, head: &str) -> Option<crate::worktrees::WorktreeBase> {
    let tip = format!("refs/remotes/origin/{base_ref}");
    let commit = crate::git::capture(cwd, &["merge-base", &tip, head]).ok()?.trim().to_string();
    if commit.is_empty() {
        return None;
    }
    let (origin_slug, origin_url) = crate::review_base::origin_record_of(cwd);
    Some(crate::worktrees::WorktreeBase {
        commit,
        ref_name: format!("origin/{base_ref}"),
        source: crate::worktrees::BaseSource::Origin,
        note: None,
        origin_slug,
        origin_url,
        merged_target: None,
    })
}

/// A card that couldn't be saved leaves no worktree or branch behind.
fn undo_worktree(cwd: &Path, card_id: &str, branch: &str) {
    let path = crate::worktrees::worktree_path_for_card(cwd, card_id);
    if let Some(p) = path.to_str() {
        let _ = crate::git::capture(cwd, &["worktree", "remove", "--force", p]);
    }
    let _ = crate::git::capture(cwd, &["branch", "-D", branch]);
}

/// Read the card's pull request from GitHub and keep what changed. A read
/// that fails is kept on the card (`read_error`) and returned as the Err.
pub fn refresh_card<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    card_id: &str,
) -> Result<KanbanCard, String> {
    let lock = locked_card(workspace_id, card_id);
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    refresh_locked(app, workspace_id, card_id).map(|(card, _)| card)
}

fn refresh_locked<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    card_id: &str,
) -> Result<(KanbanCard, PrFacts), String> {
    let kanban = app.state::<KanbanStore>();
    let card = kanban.get_card(workspace_id, card_id)?;
    let pr = card.pr_review.clone().ok_or_else(|| "this card doesn't review a pull request".to_string())?;
    let read = (|| {
        require_gh()?;
        let _github = crate::github_account::enter_for_app(app, workspace_id);
        let json = crate::github::pr_view_for_review(&pr.repo, pr.number).map_err(|e| read_words(&e))?;
        parse_pr_view(&json)
    })();
    let now = now_ms();
    let mut changed = false;
    let facts = match read {
        Ok(facts) => facts,
        Err(e) => {
            kanban.with_card_unstamped(workspace_id, card_id, |c| {
                if let Some(p) = c.pr_review.as_mut() {
                    if p.read_error.as_deref() != Some(e.as_str()) {
                        p.read_error = Some(e.clone());
                        changed = true;
                    }
                }
                Ok(())
            })?;
            if changed {
                crate::kanban::emit_kanban_changed(app, workspace_id);
            }
            return Err(e);
        }
    };
    // Walk 3 of #386 (finding 7): a card made before it, whose head is a
    // protected branch this Mac can tell, becomes review-only too.
    let protected = if pr.pushable {
        workspace_cwd(app, workspace_id).map(|cwd| local_protected(app, workspace_id, &cwd)).unwrap_or_default()
    } else {
        Vec::new()
    };
    // Walk 4 of #386 (finding 1): a fix the Builder built on GitHub's head
    // (it merged the new commits itself) is on that head.
    // Only asked of git when there is something to adopt.
    let last_sha = card.builder.as_ref().and_then(|b| b.snapshots.last()).map(|s| s.sha.as_str());
    let to_adopt = !facts.head_sha.is_empty()
        && last_sha.is_some_and(|s| s != facts.head_sha)
        && (pr.branch_head.as_deref() != Some(facts.head_sha.as_str())
            || pr.merges.iter().any(|m| m.head == facts.head_sha && m.snapshot.is_none()));
    let contains = match card.worktree_path.as_deref().map(Path::new).filter(|p| p.is_dir()) {
        Some(wt) if to_adopt && pr.pushable && facts.state == PrState::Open => {
            Box::new(head_containment(&card, wt, &facts.head_sha, None)) as Box<dyn Fn(&str, &str) -> bool>
        }
        _ => Box::new(|_: &str, _: &str| false),
    };
    kanban.with_card_unstamped(workspace_id, card_id, |c| {
        if let Some(p) = c.pr_review.as_mut() {
            changed = apply_facts(p, &facts, now);
            if apply_protected_head(p, &protected) {
                changed = true;
            }
        }
        if pr.pushable {
            note_kept_fix(c);
        }
        if adopt_landed_fix(c, now) {
            changed = true;
        }
        if adopt_head_in_fix(c, &*contains, now) {
            changed = true;
        }
        if note_head_read(c, now) {
            changed = true;
        }
        Ok(())
    })?;
    if pr.state == PrState::Open && facts.state != PrState::Open {
        clean_up_closed(app, workspace_id, card_id);
    }
    if changed {
        crate::kanban::emit_kanban_changed(app, workspace_id);
    }
    Ok((kanban.get_card(workspace_id, card_id)?, facts))
}

/// P3-9: merged or closed, the card's worktree goes to the trash as N18
/// does for a merged pull request (its branch waits for the trash entry to
/// expire), and Plyloft's `refs/ply/pr/<n>` goes — unless a fix of the
/// member's is not pushed, its Builder is open, or the worktree has edits
/// (then it is kept, and archive cleans up as usual).
fn clean_up_closed<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str, card_id: &str) {
    let kanban = app.state::<KanbanStore>();
    let Ok(card) = kanban.get_card(workspace_id, card_id) else { return };
    let Some(pr) = card.pr_review.clone() else { return };
    if unpushed_fix(&card) {
        log::info!("pr_review: {card_id}: kept its worktree after the close: a fix isn't pushed");
        return;
    }
    let reason = if pr.state == PrState::Merged {
        crate::branch_cleanup::CleanupReason::PrMerged
    } else {
        crate::branch_cleanup::CleanupReason::Archived
    };
    let head = card
        .builder
        .as_ref()
        .and_then(|b| b.snapshots.last())
        .map(|s| s.sha.clone())
        .unwrap_or_else(|| pr.head_sha.clone());
    if let Some(kept) = crate::pr_status::clean_up_card_worktree(app, workspace_id, &card, &head, reason) {
        log::info!("pr_review: {card_id}: kept its worktree after the close: {kept}");
    }
    if let Ok(cwd) = workspace_cwd(app, workspace_id) {
        let _ = crate::git::capture(&cwd, &["update-ref", "-d", &crate::worktrees::pull_head_ref(pr.number)]);
    }
}

/// Windows walk of #386: a pull request card's worktree is cleaned up only
/// by its pull request's own merged or closed path ([`clean_up_closed`]) —
/// never by Sync's merged prune, which takes a branch whose tip is already
/// on the target for merged work (a pull request from `main`, one whose
/// commits are already in, an approved one waiting to merge).
pub fn cleaned_only_by_its_pull_request(card: &KanbanCard) -> bool {
    card.pr_review.is_some()
}

/// The branch sweep leaves a pull request card's branch alone while the
/// pull request is open and the card is on the Board.
pub fn branch_kept_while_open(card: &KanbanCard) -> bool {
    !card.archived && card.pr_review.as_ref().is_some_and(|p| p.state == PrState::Open)
}

/// Windows walk of #386: before the fix above, Sync's merged prune put the
/// worktree of an open pull request's card in the trash (`branchCleanup`
/// "merged", no worktree or branch on the card). Such a card gets its
/// worktree back ([`remake_lost_worktree`]).
pub fn worktree_lost_to_sync(card: &KanbanCard) -> bool {
    !card.archived
        && card.pr_review.as_ref().is_some_and(|p| p.state == PrState::Open)
        && card.worktree_path.is_none()
        && card
            .branch_cleanup
            .as_ref()
            .is_some_and(|r| r.reason == crate::branch_cleanup::CleanupReason::Merged)
}

/// Make the worktree of a card [`worktree_lost_to_sync`] again — on its
/// card branch when that is still here (the branch the prune kept, with any
/// fix on it), else on a new card branch at the pull request's head as
/// this computer has it (`refs/ply/pr/<n>`, or the head the card recorded)
/// — and put it back on the card: its worktree and branch, the branch
/// record settled as Restarted (the sweep leaves it). No network: a card
/// with neither is left for Review / Review again, which fetch the head.
/// The trash entry stays and is reaped with the trash. Under
/// `CARD_START_LOCK`. `Ok(false)`: nothing to do.
pub fn remake_lost_worktree(kanban: &KanbanStore, cwd: &Path, workspace_id: &str, card_id: &str) -> Result<bool, String> {
    let _start = crate::commands::CARD_START_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let card = kanban.get_card(workspace_id, card_id)?;
    if !worktree_lost_to_sync(&card) {
        return Ok(false);
    }
    let Some(pr) = card.pr_review.clone() else { return Ok(false) };
    let rec = card.branch_cleanup.clone();
    let branch = rec
        .as_ref()
        .filter(|r| !matches!(r.outcome, Some(crate::branch_cleanup::CleanupOutcome::Deleted)))
        .map(|r| r.branch.clone());
    let head = crate::worktrees::resolve_commit(cwd, &crate::worktrees::pull_head_ref(pr.number))
        .or_else(|| (!pr.head_sha.is_empty()).then(|| crate::worktrees::resolve_commit(cwd, &pr.head_sha)).flatten());
    let (made, kept) = crate::worktrees::remake_for_pr_card(cwd, &card.id, &card.title, branch.as_deref(), head.as_deref())?;
    // Challenger on c273cb92: a recorded branch that was gone (not deleted
    // by the sweep) is made anew under the same name — fresh all the same.
    let fresh = !kept;
    // Challenger on c273cb92: the prune cleared the recorded base with the
    // worktree; the review's diff and the chat note read it. Made again
    // from `origin/<base>` as this clone has it (no fetch); Review again
    // records it anew when the pull request moved (`rerecord_base_if_moved`).
    let base = card.worktree_base.clone().or_else(|| {
        let at = head.clone().or_else(|| crate::worktrees::head_sha(&made.worktree_path).ok())?;
        recorded_base(cwd, &pr.base_ref, &at)
    });
    let now = now_ms();
    let written = kanban.with_card_unstamped(workspace_id, card_id, |c| {
        c.worktree_path = Some(made.worktree_path.to_string_lossy().into_owned());
        c.branch_name = Some(made.branch_name.clone());
        if c.worktree_base.is_none() {
            c.worktree_base = base.clone();
        }
        if let Some(r) = c.branch_cleanup.as_mut().filter(|r| r.pending()) {
            r.outcome = Some(crate::branch_cleanup::CleanupOutcome::Restarted);
            r.outcome_at = Some(now);
            r.asking = false;
        }
        if fresh {
            if let Some(h) = head.as_deref() {
                mark_branch_head(c, h);
            }
        }
        Ok(())
    });
    if let Err(e) = written {
        // Challenger on c273cb92: a checkout the card doesn't record would
        // block every later remake ("already exists"). The checkout goes,
        // and a branch made here with it; a kept branch stays.
        let path = made.worktree_path.to_string_lossy().into_owned();
        let _ = crate::git::capture(cwd, &["worktree", "remove", "--force", &path]);
        if fresh {
            let _ = crate::git::capture(cwd, &["branch", "-D", &made.branch_name]);
        }
        // The store changed its copy before the write failed: it is put
        // back as the board file has it, so the card says "lost" again.
        let _ = kanban.with_card_unstamped(workspace_id, card_id, |c| {
            c.worktree_path = card.worktree_path.clone();
            c.branch_name = card.branch_name.clone();
            c.worktree_base = card.worktree_base.clone();
            c.branch_cleanup = card.branch_cleanup.clone();
            c.pr_review = card.pr_review.clone();
            Ok(())
        });
        return Err(e);
    }
    log::info!(
        "pr_review: {card_id}: made its worktree again on {} (Sync had put it in the trash while pull request #{} was open)",
        made.branch_name,
        pr.number
    );
    Ok(true)
}

/// At launch: every card [`worktree_lost_to_sync`] gets its worktree back.
pub fn remake_lost_worktrees<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let (Some(workspaces), Some(kanban)) = (
        app.try_state::<crate::workspace::WorkspaceStore>(),
        app.try_state::<KanbanStore>(),
    ) else {
        return;
    };
    for ws in workspaces.snapshot().workspaces {
        let Ok(cards) = kanban.load(&ws.id) else { continue };
        let lost: Vec<String> = cards.iter().filter(|c| worktree_lost_to_sync(c)).map(|c| c.id.clone()).collect();
        if lost.is_empty() {
            continue;
        }
        let cwd = PathBuf::from(&ws.cwd);
        let mut changed = false;
        for card_id in lost {
            match remake_lost_worktree(&kanban, &cwd, &ws.id, &card_id) {
                Ok(made) => changed |= made,
                Err(e) => log::warn!("pr_review: {}/{card_id}: its worktree couldn't be made again: {e}", ws.id),
            }
        }
        if changed {
            crate::kanban::emit_kanban_changed(app, &ws.id);
        }
    }
}

/// Bring the card's worktree base to the pull request's base branch when
/// the pull request was retargeted (P3-7).
fn rerecord_base_if_moved(kanban: &KanbanStore, cwd: &Path, workspace_id: &str, card_id: &str, base_ref: &str, head: &str) {
    let recorded = kanban.get_card(workspace_id, card_id).ok().and_then(|c| c.worktree_base);
    if recorded.as_ref().is_some_and(|b| b.ref_name == format!("origin/{base_ref}")) {
        return;
    }
    if let Err(e) = crate::worktrees::fetch_origin_branch(cwd, base_ref) {
        log::info!("pr_review: fetch origin {base_ref}: {e}");
    }
    if let Some(base) = recorded_base(cwd, base_ref, head) {
        let _ = kanban.with_card_unstamped(workspace_id, card_id, |c| {
            c.worktree_base = Some(base);
            Ok(())
        });
    }
}

/// P2-2: the words when an unpushed fix meets new commits on top.
pub const MERGE_FIRST: &str = "The pull request has new commits and this card has a fix that isn't pushed yet. \
Press Bring in the new commits: Plyloft merges them into the card's branch under your fix, and the checks and the \
Reviewer then run on the merge by themselves.";

/// A review-only card (a fork, a protected head found later) whose branch
/// holds a fix meets new commits on the pull request.
pub const REVIEW_ONLY_KEPT_FIX: &str = "The pull request has new commits, and this card's branch holds a fix Plyloft \
can't push to it, so the branch wasn't moved. The fix stays on the card's branch; keep what you need of it, then \
archive this card and review the pull request again.";

/// **Review** / **Review again** (`commands::pr_review_start`): read the
/// pull request, bring the card's branch to its head and review that head
/// (`start_review(head)`, under `CARD_START_LOCK`).
/// Blocking.
pub fn start<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    card_id: &str,
    builder_live: bool,
    start_review: impl FnOnce(&str) -> Result<(), String>,
) -> Result<KanbanCard, String> {
    let lock = locked_card(workspace_id, card_id);
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    let (card, facts) = refresh_locked(app, workspace_id, card_id)?;
    if card.archived {
        return Err("This card is archived.".into());
    }
    if facts.state != PrState::Open {
        return Err(closed_words(facts.number, facts.state));
    }
    // Windows walk of #386: a worktree Sync put in the trash while the pull
    // request was open is made again here too (the launch's pass needs the
    // head on this computer; this one fetches it first).
    let card = if worktree_lost_to_sync(&card) {
        let kanban = app.state::<KanbanStore>();
        let cwd = workspace_cwd(app, workspace_id)?;
        if let Some(number) = card.pr_review.as_ref().map(|p| p.number) {
            let _github = crate::github_account::enter_for_app(app, workspace_id);
            if let Err(e) = crate::worktrees::fetch_pull_head(&cwd, number) {
                log::info!("pr_review: fetch pull request #{number}: {e}");
            }
        }
        remake_lost_worktree(&kanban, &cwd, workspace_id, card_id)
            .map_err(|e| format!("This card's copy of the repository is gone and Plyloft couldn't make it again: {e}"))?;
        kanban.get_card(workspace_id, card_id)?
    } else {
        card
    };
    let pr = card.pr_review.clone().ok_or_else(|| "this card doesn't review a pull request".to_string())?;
    let worktree = card
        .worktree_path
        .clone()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .ok_or_else(|| "This card's copy of the repository is gone, so the pull request can't be reviewed here. Archive the card and review the pull request again from the Board.".to_string())?;
    let cwd = workspace_cwd(app, workspace_id)?;
    let head = {
        let _github = crate::github_account::enter_for_app(app, workspace_id);
        crate::worktrees::fetch_pull_head(&cwd, pr.number)
            .map_err(|e| format!("Plyloft couldn't fetch pull request #{} from origin: {e}", pr.number))?
    };
    let tip = crate::worktrees::head_sha(&worktree)?;
    if tip != head && builder_live {
        return Err("The pull request has new commits. Close the Builder session first; Review again then brings the card's branch to them.".into());
    }
    let mut seen = card.clone();
    if let Some(p) = seen.pr_review.as_mut() {
        p.head_sha = head.clone();
    }
    if merged_not_built(&seen) {
        return Err(MERGED_NOT_BUILT.into());
    }
    if merge_offered(&seen) {
        return Err(MERGE_FIRST.into());
    }
    let kanban = app.state::<KanbanStore>();
    rerecord_base_if_moved(&kanban, &cwd, workspace_id, card_id, &facts.base_ref, &head);
    {
        // Round 2 (P2-B): the admission first; the branch moves only for a
        // review that starts.
        let _start = crate::commands::CARD_START_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(why) = admission_refusal(&kanban.get_card(workspace_id, card_id)?, &head) {
            return Err(why);
        }
        // Challenger on #386 walk 3: a card that turned review-only keeps a
        // fix it can't push; Bring in the new commits isn't offered there.
        let moved = crate::worktrees::move_pr_card_branch(&worktree, &head, pr.branch_head.as_deref())
            .map_err(|e| if !pr.pushable && e == MERGE_FIRST { REVIEW_ONLY_KEPT_FIX.to_string() } else { e })?;
        if moved != crate::worktrees::PrBranchMove::Already {
            kanban.with_card_unstamped(workspace_id, card_id, |c| {
                mark_branch_head(c, &head);
                Ok(())
            })?;
        }
        start_review(&head)?;
    }
    kanban.get_card(workspace_id, card_id)
}

/// P2-2 **Bring in the new commits** (`commands::pr_review_merge_head`): the
/// member's own pull request has new commits on top of the head an unpushed
/// fix is built on; they are merged into the card's branch (a merge commit,
/// never a rebase), and the head they came with becomes the one the fix is
/// built on. A conflict is aborted and said; the Builder resolves it.
pub fn merge_new_commits<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    card_id: &str,
    builder_live: impl Fn() -> bool,
) -> Result<KanbanCard, String> {
    let lock = locked_card(workspace_id, card_id);
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    let (card, facts) = refresh_locked(app, workspace_id, card_id)?;
    if facts.state != PrState::Open {
        return Err(closed_words(facts.number, facts.state));
    }
    if let Some(why) = builder_refusal(&card) {
        return Err(why);
    }
    // Round 3: asked under the card's lock, not before it.
    if builder_live() {
        return Err("Close the Builder session first, or ask the Builder to merge the pull request's new commits itself.".into());
    }
    let pr = card.pr_review.clone().ok_or_else(|| "this card doesn't review a pull request".to_string())?;
    let worktree = card
        .worktree_path
        .clone()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .ok_or_else(|| "This card's copy of the repository is gone.".to_string())?;
    let cwd = workspace_cwd(app, workspace_id)?;
    let head = {
        let _github = crate::github_account::enter_for_app(app, workspace_id);
        crate::worktrees::fetch_pull_head(&cwd, pr.number)
            .map_err(|e| format!("Plyloft couldn't fetch pull request #{} from origin: {e}", pr.number))?
    };
    let kanban = app.state::<KanbanStore>();
    let last = card.builder.as_ref().and_then(|b| b.snapshots.last()).cloned();
    let merged = match crate::worktrees::merge_pr_head_into_card(&worktree, &head, pr.branch_head.as_deref()) {
        Ok(merged) => merged,
        Err(e) => {
            // Walk 3 of #386 (finding 6): a conflict is kept, so the card
            // offers the Builder (to resolve it), not the same merge again.
            if crate::worktrees::is_pr_merge_conflict(&e) {
                let fix = last.as_ref().map(|s| s.sha.clone()).unwrap_or_default();
                let now = now_ms();
                let _ = kanban.with_card_unstamped(workspace_id, card_id, |c| {
                    if let Some(p) = c.pr_review.as_mut() {
                        p.head_sha = head.clone();
                        p.merge_conflict = Some(PrConflict { head: head.clone(), fix: fix.clone() });
                    }
                    // Walk 4 of #386: the head read is in the Activity.
                    note_head_read(c, now);
                    Ok(())
                });
                crate::kanban::emit_kanban_changed(app, workspace_id);
            }
            return Err(e);
        }
    };
    // Already in the branch (round 2): the newest snapshot is built on the
    // head when it contains it; else the branch got it after that snapshot
    // (the Builder merged it) and the next Build done builds it.
    // Walk 4 of #386: a fix that already contains the head is adopted at
    // Build done and at each read (`adopt_head_in_fix`); this is the same.
    let built_on_head = !merged && last.as_ref().is_some_and(|s| crate::worktrees::is_ancestor(&worktree, &head, &s.sha));
    let contains = head_containment(&card, &worktree, &head, None);
    let now = now_ms();
    kanban.with_card_unstamped(workspace_id, card_id, |c| {
        if let Some(p) = c.pr_review.as_mut() {
            p.head_sha = head.clone();
            // The new commits read, once per head (walk 4: a conflict
            // before recorded it already).
            record_merge(p, &head, now);
        }
        if !(built_on_head && adopt_head_in_fix(c, &contains, now)) {
            mark_branch_head(c, &head);
            if let Some(p) = c.pr_review.as_mut() {
                p.merge_conflict = None;
                if built_on_head {
                    p.head_mark = last.as_ref().map_or(0, |s| s.n.saturating_sub(1));
                } else {
                    p.merged = true;
                }
            }
        }
        Ok(())
    })?;
    crate::kanban::emit_kanban_changed(app, workspace_id);
    kanban.get_card(workspace_id, card_id)
}

/// After **Push the fixes**: the pull request's head is the pushed commit,
/// and the card's branch is there. Under the card's lock (P3-2).
pub fn record_pushed(kanban: &KanbanStore, workspace_id: &str, card_id: &str, rev: &str) -> Result<(), String> {
    let lock = locked_card(workspace_id, card_id);
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    kanban
        .with_card_unstamped(workspace_id, card_id, |c| apply_pushed(c, rev, now_ms()))
        .map(|_| ())
}

/// Round 3: the push's record — the head is `rev`, marked at the snapshot
/// that is `rev` (the one pushed), so a later snapshot is a new fix. Walk 2
/// of #386: and the push itself (Activity; the head it replaced, so a read
/// GitHub answers before it caught up isn't new commits under the fix).
pub fn apply_pushed(card: &mut KanbanCard, rev: &str, now: i64) -> Result<(), String> {
    let pushed = card
        .builder
        .as_ref()
        .and_then(|b| b.snapshots.iter().rev().find(|s| s.sha == rev).map(|s| s.n));
    let over = card
        .pr_review
        .as_ref()
        .map(|p| p.branch_head.clone().unwrap_or_else(|| p.head_sha.clone()))
        .unwrap_or_default();
    mark_branch_head(card, rev);
    if let Some(p) = card.pr_review.as_mut() {
        p.head_sha = rev.to_string();
        if let Some(n) = pushed {
            p.head_mark = n;
        }
        if over != rev {
            p.pushes.push(PrPush { sha: rev.to_string(), over, at: now });
            // The Activity keeps the last few; the guard reads the last.
            let extra = p.pushes.len().saturating_sub(PUSHES_KEPT);
            p.pushes.drain(0..extra);
        }
    }
    Ok(())
}

/// Challenger round 3 of #386: GitHub's head is one of the card's own fixes
/// though no push of it was recorded — a Push the fixes that timed out
/// after it reached GitHub ("It may have reached GitHub; Refresh shows…"),
/// or the card's branch pushed from outside Plyloft. It is recorded as the
/// push it was, so the card stands on that head (a later fix is built on
/// it, the push leases it) instead of offering to bring its own fix in as
/// new commits. True when it did.
pub fn adopt_landed_fix(card: &mut KanbanCard, now: i64) -> bool {
    let Some(pr) = card.pr_review.as_ref() else { return false };
    if pr.state != PrState::Open || pr.head_sha.is_empty() || pr.branch_head.as_deref() == Some(pr.head_sha.as_str()) {
        return false;
    }
    let head = pr.head_sha.clone();
    let fix = card.builder.as_ref().and_then(|b| b.snapshots.iter().rev().find(|s| s.sha == head)).map(|s| s.n);
    match fix {
        Some(n) if !pr.heads.contains(&n) => apply_pushed(card, &head, now).is_ok(),
        _ => false,
    }
}

/// How many pushes a card keeps.
pub const PUSHES_KEPT: usize = 20;

/// Round 3: Push the fixes waits while a Builder session is open (it could
/// still change the branch).
pub const PUSH_WHILE_BUILDING: &str =
    "Not pushed: the Builder's session is open. Close it (press Finish and check first if the Builder changed anything since), then Send the fixes to GitHub.";

/// The poller's last read of one card.
#[derive(Debug, Clone, Copy, Default)]
pub struct Attempt {
    pub at: i64,
    pub failures: u32,
}

fn attempts() -> &'static Mutex<HashMap<String, Attempt>> {
    static ATTEMPTS: OnceLock<Mutex<HashMap<String, Attempt>>> = OnceLock::new();
    ATTEMPTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// P3-4: at most this many pull requests are read per tick.
pub const READS_PER_TICK: usize = 3;
/// P3-4: GitHub refused for the rate limit (or a 403): no read for this long.
pub const RATE_LIMIT_PAUSE_MS: i64 = 10 * 60 * 1000;
/// The poller's tick.
pub const POLL_TICK_SECS: u64 = 20;

/// Until when every read waits (a rate limit), unix ms.
static PAUSED_UNTIL: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

/// The read failed because GitHub is rate-limiting the account (or refused
/// it outright): every read pauses, not only this card's.
pub fn pauses_all(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("rate limit") || lower.contains("x-ratelimit-remaining: 0")
}

/// Pure: the cards due this tick, at most [`READS_PER_TICK`], the longest
/// waiting first.
pub fn due_cards<'a>(
    cards: impl IntoIterator<Item = (&'a KanbanCard, Option<Attempt>)>,
    now: i64,
) -> Vec<&'a KanbanCard> {
    let mut due: Vec<(&KanbanCard, i64)> = cards
        .into_iter()
        .filter(|(card, attempt)| poll_due(card, attempt.map(|a| a.at), attempt.map_or(0, |a| a.failures), now))
        .map(|(card, attempt)| (card, attempt.map_or(0, |a| a.at)))
        .collect();
    due.sort_by_key(|(_, at)| *at);
    due.into_iter().take(READS_PER_TICK).map(|(card, _)| card).collect()
}

/// P3-4: its own thread, beside SL-1's poller (never holding it up). Stops
/// with it (`pr_status::stopping`).
pub fn start_poller<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    std::thread::spawn(move || {
        // Windows walk of #386: first, the worktrees Sync trashed while
        // their pull request was open come back (local git only).
        remake_lost_worktrees(&app);
        loop {
            std::thread::sleep(std::time::Duration::from_secs(POLL_TICK_SECS));
            if crate::pr_status::stopping() {
                return;
            }
            poll_once(&app);
        }
    });
}

/// One tick: the due pull requests, a few at most. Quiet: a failed read is
/// logged at debug level and kept on the card.
pub fn poll_once<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let now = now_ms();
    if PAUSED_UNTIL.load(std::sync::atomic::Ordering::SeqCst) > now {
        return;
    }
    let (Some(workspaces), Some(kanban)) = (
        app.try_state::<crate::workspace::WorkspaceStore>(),
        app.try_state::<KanbanStore>(),
    ) else {
        return;
    };
    let mut all: Vec<(String, KanbanCard)> = Vec::new();
    for ws in workspaces.snapshot().workspaces {
        let Ok(cards) = kanban.load(&ws.id) else { continue };
        all.extend(cards.into_iter().filter(|c| c.pr_review.is_some()).map(|c| (ws.id.clone(), c)));
    }
    let known = attempts().lock().unwrap_or_else(|p| p.into_inner()).clone();
    let due: Vec<(String, String)> = due_cards(
        all.iter().map(|(ws, c)| (c, known.get(&format!("{ws}/{}", c.id)).copied())),
        now,
    )
    .into_iter()
    .map(|c| (c.workspace_id.clone(), c.id.clone()))
    .collect();
    if due.is_empty() || require_gh().is_err() {
        return;
    }
    for (workspace_id, card_id) in due {
        if crate::pr_status::stopping() {
            return;
        }
        let result = refresh_card(app, &workspace_id, &card_id);
        let mut map = attempts().lock().unwrap_or_else(|p| p.into_inner());
        let entry = map.entry(format!("{workspace_id}/{card_id}")).or_default();
        entry.at = now_ms();
        match result {
            Ok(_) => entry.failures = 0,
            Err(e) => {
                entry.failures = entry.failures.saturating_add(1);
                log::debug!("pr_review: {workspace_id}/{card_id}: {e}");
                if pauses_all(&e) {
                    PAUSED_UNTIL.store(now_ms() + RATE_LIMIT_PAUSE_MS, std::sync::atomic::Ordering::SeqCst);
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
