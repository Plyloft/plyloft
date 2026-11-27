//! 1.170.0 (G6): keep a card up to date with its target branch — by
//! merging, never by rewriting.
//!
//! - **Behind / Conflict ahead** ([`report`]): for each card with a copy and
//!   a branch that hasn't landed (an open pull request included), the
//!   commits GitHub's `<target>` (`refs/remotes/origin/<target>`, fetched at
//!   most every [`FETCH_EVERY`], or [`FETCH_ON_OPEN`] when a card page
//!   opens) has that the card's branch lacks, and whether merging them
//!   would conflict — a dry merge (`git merge-tree --write-tree`) that
//!   writes no ref, no index and no file. Never persisted.
//! - **Bring in the target's changes** ([`bring_in`]), only on the person's
//!   press (owner, 2026-10-26: badge and button, never automatic): `git
//!   merge --no-ff --no-commit origin/<target>` in the card's own copy. A
//!   clean merge is left pending — Finish and check commits it as a merge
//!   commit (`ship_conflict::merge_commit_message`) and runs the checks; on
//!   a card with an open pull request, Push update then sends it (the card's
//!   own branch, never forced). A conflict is undone at once (nothing is
//!   merged) and recorded as the 1.169.1 ship-conflict flow's record with
//!   `sync` set — Ask the Builder to resolve it merges the same commit for
//!   the Builder, Undo the merge drops the record and puts the card's
//!   review status back. On a card with an open pull request the record is
//!   kept without stopping the card (its review status stays the pull
//!   request's); its line asks the Builder the same way.
//!
//! Nothing here pushes, rebases, resets or forces, and nothing touches the
//! member's own checkout. R2: the merged commit is GitHub's own, so it never
//! counts among the commits a pull request would carry
//! (`commands::pr_carries_local_commits` subtracts `origin/<target>`).

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::kanban::{KanbanCard, KanbanStore, ReviewStatus, ShipStatus};

/// The Board's reading: GitHub's target is fetched at most this often.
pub const FETCH_EVERY: Duration = Duration::from_secs(180);
/// A card page that opens reads it again when the last fetch is older.
pub const FETCH_ON_OPEN: Duration = Duration::from_secs(30);
/// The dry merge's bound (a local computation; a huge repository is slow).
const DRY_MERGE_TIMEOUT: Duration = Duration::from_secs(20);

/// One card's distance from its target branch.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CardTargetSync {
    /// Commits of GitHub's target the card's branch doesn't have.
    pub behind: u32,
    /// Merging them would conflict (a dry merge); false when not behind or
    /// when git couldn't tell.
    pub conflict: bool,
    /// A merge is pending in the card's copy (Bring in, or Ask the Builder
    /// to resolve it): Finish and check commits it.
    pub merging: bool,
    /// 1.173.0 (B3): the card's own target, when its area's branch isn't
    /// the report's (absent: the report's `target`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

/// The workspace's reading: its target's name, and each tracked card's.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TargetSyncReport {
    pub target: String,
    pub cards: BTreeMap<String, CardTargetSync>,
}

/// What a press of Bring in the target's changes did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BringInResult {
    /// `merged` (pending, for Finish and check), `up_to_date` (nothing to
    /// bring in), or `conflict` (nothing merged).
    pub kind: String,
    pub target: String,
    /// The conflicting files, on `conflict`.
    pub paths: Vec<String>,
    /// The conflict was recorded for Ask the Builder to resolve it.
    pub recorded: bool,
    pub card: KanbanCard,
}

/// A card whose branch is kept up to date: not archived, not landed — an
/// open pull request's card is — with a copy and a branch. Not a pull
/// request review (its head is someone's branch), a skill card (it follows
/// its library), nor a card two Builders build until one is picked (each
/// has its own copy; the pick's is the card's).
pub fn tracked(card: &KanbanCard) -> bool {
    if card.archived || card.pr_review.is_some() || card.skill_card().is_some() {
        return false;
    }
    if crate::build_both::is_undecided(card) {
        return false;
    }
    if card.ship_status == ShipStatus::Shipped {
        return false;
    }
    // (Challenger) A pull request is open when `pr_status` says so (its
    // url, its state on GitHub, not shipped) — the review status alone
    // isn't that.
    if card.review_status == Some(ReviewStatus::Merged) && !crate::pr_status::card_pr_open(card) {
        return false;
    }
    card.branch_name.is_some() && card.worktree_path.as_deref().is_some_and(|p| Path::new(p).is_dir())
}

static LAST_FETCH: Mutex<Option<HashMap<(PathBuf, String), Instant>>> = Mutex::new(None);

/// (Challenger) The dry merge's answers, by (card tip, target commit): the
/// same two commits always merge the same way, so the Board's reading every
/// few minutes runs `git merge-tree` only for a pair it hasn't seen.
static DRY_MERGES: Mutex<Option<HashMap<(String, String), bool>>> = Mutex::new(None);
/// Pairs remembered at most (then the memory starts again).
const DRY_MERGES_KEPT: usize = 512;

/// [`dry_merge_conflicts`], remembered by its two commits. An answer git
/// couldn't give (`None`) isn't remembered.
pub fn dry_merge_conflicts_cached(repo: &Path, ours: &str, theirs: &str) -> Option<bool> {
    let key = (ours.to_string(), theirs.to_string());
    {
        let guard = DRY_MERGES.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(known) = guard.as_ref().and_then(|m| m.get(&key)) {
            return Some(*known);
        }
    }
    let answer = dry_merge_conflicts(repo, ours, theirs)?;
    let mut guard = DRY_MERGES.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    if map.len() >= DRY_MERGES_KEPT {
        map.clear();
    }
    map.insert(key, answer);
    Some(answer)
}

/// Whether `repo`'s `target` is due a fetch (none within `every`); a due
/// one is marked fetched now, so concurrent readers don't fetch twice.
pub fn fetch_due(repo: &Path, target: &str, every: Duration) -> bool {
    let mut guard = LAST_FETCH.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    let key = (repo.to_path_buf(), target.to_string());
    let now = Instant::now();
    if map.get(&key).is_some_and(|at| now.duration_since(*at) < every) {
        return false;
    }
    map.insert(key, now);
    true
}

/// Whether merging `theirs` into `ours` conflicts, by a dry merge that
/// writes nothing a person sees. `None` when git can't tell (a git older
/// than 2.38, a timeout).
pub fn dry_merge_conflicts(repo: &Path, ours: &str, theirs: &str) -> Option<bool> {
    let mut cmd = crate::platform::git_command();
    cmd.args(["merge-tree", "--write-tree", "--no-messages", "--name-only", ours, theirs])
        .current_dir(repo)
        .env("GIT_TERMINAL_PROMPT", "0");
    let out = crate::worktrees::run_bounded_output(&mut cmd, DRY_MERGE_TIMEOUT).ok()?;
    match out.status.code() {
        Some(0) => Some(false),
        Some(1) => Some(true),
        _ => None,
    }
}

/// `card`'s distance from `remote` (GitHub's target commit), read in `repo`.
pub fn measure(repo: &Path, card: &KanbanCard, remote: &str) -> Option<CardTargetSync> {
    let branch = card.branch_name.as_deref()?;
    let tip = crate::worktrees::resolve_commit(repo, &format!("refs/heads/{branch}"))?;
    let behind: u32 = crate::git::capture(repo, &["rev-list", "--count", &format!("{tip}..{remote}")])
        .ok()?
        .trim()
        .parse()
        .ok()?;
    let conflict = behind > 0 && dry_merge_conflicts_cached(repo, &tip, remote).unwrap_or(false);
    let merging = card
        .worktree_path
        .as_deref()
        .is_some_and(|wt| crate::ship_conflict::merge_pending(Path::new(wt)).is_some());
    Some(CardTargetSync { behind, conflict, merging, target: None })
}

/// Every tracked card's reading against the last fetched `origin/<target>`
/// (fetching is the caller's, bounded and throttled). Empty when the
/// repository has no such branch.
#[cfg_attr(not(test), allow(dead_code))]
pub fn report(repo: &Path, target: &str, cards: &[KanbanCard]) -> TargetSyncReport {
    report_by(repo, target, cards, &|_| target.to_string())
}

/// [`report`], each card against its own target (`target_of`: its area's
/// branch, B3); a card whose target isn't the workspace's `target` names it.
pub fn report_by(repo: &Path, target: &str, cards: &[KanbanCard], target_of: &dyn Fn(&KanbanCard) -> String) -> TargetSyncReport {
    let mut out = TargetSyncReport { target: target.to_string(), cards: BTreeMap::new() };
    let mut remotes: BTreeMap<String, Option<String>> = BTreeMap::new();
    for card in cards.iter().filter(|c| tracked(c)) {
        let own = target_of(card);
        let remote = remotes
            .entry(own.clone())
            .or_insert_with(|| crate::worktrees::resolve_commit(repo, &format!("refs/remotes/origin/{own}")))
            .clone();
        let Some(remote) = remote else { continue };
        if let Some(mut sync) = measure(repo, card, &remote) {
            sync.target = (own != target).then_some(own);
            out.cards.insert(card.id.clone(), sync);
        }
    }
    out
}

/// The press refused while the card's Builder is in a turn: it could still
/// change the branch.
pub fn builder_working(target: &str) -> String {
    format!("The card's Builder is working; nothing was started. Bring in {target}'s changes once its turn is over.")
}

/// The press refused while the copy has work since the last Finish and check.
pub fn uncommitted(target: &str) -> String {
    format!(
        "The card's copy has changes since the last Finish and check. Press Finish and check first, then bring in {target}'s changes."
    )
}

/// **Bring in the target's changes**: GitHub's `target` (fetched first by
/// `fetch`, in the card's copy; offline, the last fetched copy) merged into
/// the card's copy with nothing committed. See the module's words.
pub fn bring_in(
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    target: &str,
    fetch: &dyn Fn(&Path) -> Result<(), String>,
    session_live: &dyn Fn() -> bool,
) -> Result<BringInResult, String> {
    let card = kanban.get_card(workspace_id, card_id)?;
    if crate::build_both::is_undecided(&card) {
        return Err(crate::build_both::UNDECIDED_REFUSAL.into());
    }
    if !tracked(&card) {
        return Err("This card has no work of its own to bring the changes into; nothing was started.".into());
    }
    if card.review_status == Some(ReviewStatus::ConflictBlocked) || card.ship_conflict.is_some() {
        return Err("This card stopped on a conflict. Resolve that first (Fix with the Builder); nothing was started.".into());
    }
    // (Challenger) Not under a Builder's turn: it could still change the
    // branch, and the merge would land in the middle of its work.
    if card.last_run_status == Some(crate::kanban::LastRunStatus::Running) && session_live() {
        return Err(builder_working(target));
    }
    let worktree = PathBuf::from(card.worktree_path.as_deref().unwrap_or_default());
    if crate::ship_conflict::merge_pending(&worktree).is_some() {
        return Err("A merge is already under way in the card's copy; nothing was started. Press Finish and check to commit it, or undo it (⋯ › Undo the merge).".into());
    }
    if let Some(op) = crate::worktrees::pending_operation(&worktree) {
        return Err(format!(
            "The card's copy is in the middle of {op}; nothing was started. Ask the Builder to finish or stop it, then press again."
        ));
    }
    if crate::worktrees::worktree_is_dirty(&worktree)? {
        return Err(uncommitted(target));
    }
    if let Err(e) = fetch(&worktree) {
        log::info!("card_sync: {card_id}: origin/{target} not refreshed before the merge: {e}");
    }
    let remote = crate::worktrees::resolve_commit(&worktree, &format!("refs/remotes/origin/{target}")).ok_or_else(|| {
        format!("Plyloft couldn't read {target} on GitHub for this project; nothing was started.")
    })?;
    let result = |kind: &str, paths: Vec<String>, recorded: bool| -> Result<BringInResult, String> {
        Ok(BringInResult {
            kind: kind.into(),
            target: target.to_string(),
            paths,
            recorded,
            card: kanban.get_card(workspace_id, card_id)?,
        })
    };
    if crate::worktrees::is_ancestor(&worktree, &remote, "HEAD") {
        return result("up_to_date", Vec::new(), false);
    }
    crate::ship_conflict::merge_no_commit(&worktree, &remote)?;
    let paths: Vec<String> = crate::git::capture(&worktree, &["diff", "--name-only", "-z", "--diff-filter=U"])
        .unwrap_or_default()
        .split('\0')
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    if paths.is_empty() {
        // (Challenger) The merged commit is GitHub's own, recorded as the
        // conflict path records it (`ship_conflict::record_started`): the
        // review's range then starts there even when origin can't vouch
        // for a tip (offline, a local path), and the target's changes never
        // read as the card's.
        kanban.with_card(workspace_id, card_id, |c| {
            if let Some(base) = c.worktree_base.as_mut() {
                base.merged_target = Some(remote.clone());
            }
            Ok(())
        })?;
        return result("merged", Vec::new(), false);
    }
    // A conflict: nothing is left merged — the card's copy is as the press
    // found it, and the 1.169.1 flow starts the merge again for the Builder
    // (Ask the Builder to resolve it: Plyloft runs the merge, the Builder
    // only resolves — Codex's sandbox can't write the copy's git dir).
    crate::git::run(&worktree, &["merge", "--abort"])
        .map_err(|e| format!("The merge met a conflict and couldn't be undone; resolve it in the card's copy. {e}"))?;
    // On a card whose pull request is open the record is kept beside the
    // pull request's status, never over it (orchestrator, #8): the card
    // still reads as its pull request, and its line asks the Builder.
    let pr_open = crate::pr_status::card_pr_open(&card);
    let record = crate::kanban::ShipConflict {
        paths: paths.clone(),
        target_sha: remote,
        at: crate::kanban::now_ms(),
        branch: target.to_string(),
        merge_started_at: None,
        sync: true,
        review_before: card.review_status,
    };
    kanban.with_card(workspace_id, card_id, |c| {
        if !pr_open {
            c.review_status = Some(ReviewStatus::ConflictBlocked);
        }
        c.ship_conflict = Some(record);
        Ok(())
    })?;
    result("conflict", paths, true)
}

#[cfg(test)]
#[path = "card_sync_tests.rs"]
mod tests;
