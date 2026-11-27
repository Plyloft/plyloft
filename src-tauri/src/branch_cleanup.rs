//! N18: card branches are cleaned up automatically.
//!
//! Ship (Ship now, Ship batch), Land and a pull request merged on GitHub put
//! a card's worktree in `.plyloft-worktrees/.trash/` for 7 days
//! (`worktrees::TRASH_TTL_SECS`) and, before this, kept its branch for good:
//! `gc_trash` reaps the folder and deletes no branch, so shipped card
//! branches (`plyloft/card-…`, `atelier/card-…`) piled up. Ship and Land
//! squash-merge, so git ancestry cannot prove a card branch merged; what
//! proves it is the tip Plyloft recorded when the card shipped.
//!
//! **The record.** When a card ships (at the released commit), lands (at the
//! landed commit), merges on GitHub (at the pull request's head), is found
//! merged by Sync (at the tip proven merged) or is archived with a branch,
//! the card gets a [`BranchCleanup`]: the branch, that tip, why, when, and
//! the trash entry its worktree went to (if any). A card that starts again
//! before the week is up picks its branch up again and the record is
//! settled as [`CleanupOutcome::Restarted`]; a restored archived card drops
//! its archive record.
//!
//! **The deletion rule** ([`sweep_card`]), run by the trash GC right after
//! `gc_trash` (launch, daily, after Sync). A card's branch is deleted only
//! when all of these hold:
//! 1. the workspace's "Delete card branches when their trash expires" is on
//!    (`Workspace::keep_card_branches` false, the default);
//! 2. the card is this Mac's own ([`is_mine`]): a card of a local board, or a
//!    GitHub Issues card this identity created (its `author` email) or holds
//!    (`gh_assignees`/`gh_author` is this GitHub login);
//! 3. the record is due ([`is_due`]): 7 days since the ship/land/merge/archive
//!    **and** its trash entry is gone — reaped by `gc_trash`. An entry
//!    `gc_trash` keeps (written to after its card let it go) keeps the branch
//!    with it. No trash entry recorded: the 7 days alone;
//! 4. an archived card's branch only after the person said Delete in the
//!    Inbox ask (asked every time, [`CleanupReason::Archived`]); "Keep them"
//!    is remembered per branch ([`CleanupOutcome::Declined`]);
//! 5. the branch still points at the recorded tip — anything committed after
//!    it shipped keeps it, shown as "Has commits after it shipped — kept"
//!    ([`CleanupOutcome::MovedOn`]); a local branch behind a merged pull
//!    request's head is kept too ([`CleanupOutcome::Behind`]);
//! 6. no live session of the card, and the branch is checked out nowhere (the
//!    main checkout or any worktree, `git worktree list`);
//! 7. the delete itself is compare-and-delete: `git update-ref -d
//!    refs/heads/<branch> <recorded tip>`, so a commit that lands between the
//!    checks and the delete makes git refuse it.
//!
//! Local branches only: nothing here pushes, and nothing deletes a branch on
//! GitHub.
//!
//! **Copies without a card** (1.173.0 A2): a thrown-away copy's branch
//! (`plyloft/copy-…`) is recorded on its `copies.json` entry with
//! [`CleanupReason::Copy`] and judged by [`sweep_copy_record`] — rules 1, 3,
//! 5, 6 and 7 above (a copy is always this Mac's own and never asks) — from
//! `copies::sweep_for_app`, which [`sweep_for_app`] runs first.
//!
//! **The backlog** ([`scan_backlog`]): once per workspace after this update,
//! the branches of cards that shipped before it are offered for deletion in
//! the Inbox. No tip was recorded for those, so the rule is stricter: the
//! branch is exactly the name Plyloft made for one card of this board
//! (`make_branch_name(id, title)`, current or legacy prefix, or an issue
//! card's name from before 1.175.0 — never a `-b`
//! variant, and a name two cards would share proves neither), a card that is
//! this Mac's own, has shipped (`ship_history`, which Ship, Land and a merged
//! pull request all write), records no branch or worktree any more, has no
//! live session, a branch checked out nowhere, a tip committed no later
//! than the card's last ship, **and** content proof: `git merge-tree
//! --write-tree <target> <tip>` yields the target's own tree (merging it
//! changes nothing). The tip read then is the one the delete compares
//! against. An archived card that never shipped goes to the ask-every-time
//! Inbox path instead. Branches of Build with both's set-aside builds (`-b`)
//! and of deleted cards are not cleaned up here.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::git::capture as run_git;
use crate::kanban::{KanbanCard, KanbanStore};
use crate::worktrees::{checkout_holding, is_card_branch, is_card_owned_branch, TRASH_TTL_SECS};

/// The record is due this long after its ship, land, merge or archive —
/// the trash's own week.
pub const DUE_AFTER_MS: i64 = TRASH_TTL_SECS as i64 * 1000;

/// "Not now" on the backlog asks again after this long.
pub const BACKLOG_NOT_NOW_MS: i64 = DUE_AFTER_MS;

/// Why the card's branch is up for deletion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CleanupReason {
    Shipped,
    Landed,
    PrMerged,
    /// Merged into the fetched default branch elsewhere (Sync's ancestry
    /// proof, `worktrees::prune_merged_card_worktrees`).
    Merged,
    /// Archived without a release: deleted only when the person says so.
    Archived,
    /// 1.173.0 A2: a copy without a card was thrown away
    /// (`copies::throw_away`). The record lives on the copy's entry in
    /// `projects/<ws>/copies.json`, never on a card, and is swept by
    /// [`sweep_copy_record`] under the same rule as a shipped card's.
    Copy,
    /// Written by a later build: never acted on here.
    #[serde(other)]
    Unknown,
}

/// What became of the branch. `None` on the record: still waiting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CleanupOutcome {
    /// Deleted at the recorded tip.
    Deleted,
    /// It had commits after the recorded tip: kept, for good.
    MovedOn,
    /// The person answered "Keep them" in the Inbox ask.
    Declined,
    /// It was already gone when it came due.
    Gone,
    /// The card started again before it came due: the branch is its own
    /// again ("Branch kept: the card started again").
    Restarted,
    /// The recorded tip (a merged pull request's head) is ahead of the
    /// local branch, or was never fetched here: commits this Mac never had.
    /// Kept.
    Behind,
    /// The archived card was restored to the Board: its branch is its own
    /// again, and the Inbox no longer asks.
    Restored,
    #[serde(other)]
    Unknown,
}

/// N18: a card's branch waiting for its trash entry to expire
/// (`KanbanCard::branch_cleanup`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCleanup {
    pub branch: String,
    /// The branch tip when the card shipped/landed/merged/was archived: the
    /// only commit the delete is allowed at.
    pub tip: String,
    pub reason: CleanupReason,
    /// When (unix ms) — the week is counted from here.
    pub since: i64,
    /// The trash entry the card's worktree went to, when there was one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trash_entry: Option<String>,
    /// An archived card's branch is due: the Inbox asks.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub asking: bool,
    /// When the Inbox started asking (the row's time).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asked_at: Option<i64>,
    /// The person said Delete in that ask.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub approved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<CleanupOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome_at: Option<i64>,
}

impl BranchCleanup {
    pub fn new(branch: &str, tip: &str, reason: CleanupReason, since: i64, trash_entry: Option<&Path>) -> Self {
        Self {
            branch: branch.to_string(),
            tip: tip.to_string(),
            reason,
            since,
            trash_entry: trash_entry.map(|p| p.to_string_lossy().to_string()),
            asking: false,
            asked_at: None,
            approved: false,
            outcome: None,
            outcome_at: None,
        }
    }

    /// Still waiting: nothing has been decided about the branch.
    pub fn pending(&self) -> bool {
        self.outcome.is_none()
    }

    /// The same record (the sweep re-checks under the board lock that what
    /// it judged is still what the card records).
    fn same(&self, other: &BranchCleanup) -> bool {
        self.branch == other.branch && self.tip == other.tip && self.since == other.since
    }
}

/// The record for `card`'s current branch: `None` when the card records no
/// card branch, or the branch is not there (no tip to pin). `tip` overrides
/// the branch's current tip (a merged pull request's head).
pub fn record(
    card: &KanbanCard,
    repo: &Path,
    reason: CleanupReason,
    tip: Option<&str>,
    trash_entry: Option<&Path>,
    now: i64,
) -> Option<BranchCleanup> {
    let branch = card.branch_name.as_deref().filter(|b| is_card_owned_branch(b))?;
    let tip = match tip {
        Some(t) => t.to_string(),
        None => crate::worktrees::branch_tip(repo, branch)?,
    };
    Some(BranchCleanup::new(branch, &tip, reason, now, trash_entry))
}

/// Put `record` on the card. A pending record of a release is not replaced
/// by an archive's at the same tip (archiving a shipped card does not turn
/// its automatic cleanup into a question); an archive that finds the branch
/// moved on since the release does replace it — those later commits are on
/// no release, so the branch goes through the Inbox ask. Anything else
/// replaces it — a card shipped again records its new tip.
pub fn stamp(card: &mut KanbanCard, record: BranchCleanup) {
    if let Some(existing) = &card.branch_cleanup {
        if existing.pending()
            && existing.branch == record.branch
            && existing.tip == record.tip
            && record.reason == CleanupReason::Archived
            && existing.reason != CleanupReason::Archived
        {
            return;
        }
    }
    card.branch_cleanup = Some(record);
}

/// The record an archive makes: the card's own branch at its tip now. A
/// shipped card no longer records its branch (Ship cleared it); if its
/// release record is still waiting, or was kept for commits after the
/// release, and the branch has moved on from the recorded tip, the archive
/// records that branch at its new tip — for the Inbox ask, never deleted
/// silently.
pub fn archive_record(card: &KanbanCard, repo: &Path, now: i64) -> Option<BranchCleanup> {
    if card.branch_name.is_some() {
        return record(card, repo, CleanupReason::Archived, None, None, now);
    }
    let existing = card.branch_cleanup.as_ref()?;
    let open = existing.pending() || existing.outcome == Some(CleanupOutcome::MovedOn);
    if !open || existing.reason == CleanupReason::Archived || !is_card_owned_branch(&existing.branch) {
        return None;
    }
    let tip = crate::worktrees::branch_tip(repo, &existing.branch)?;
    (tip != existing.tip).then(|| BranchCleanup::new(&existing.branch, &tip, CleanupReason::Archived, now, None))
}

/// The record a Ship makes for one released card: its branch at the commit
/// that was released (`card_revs`) — never the branch's tip, which may hold
/// commits made after the release. No released commit, no record.
pub fn release_record(
    card: &KanbanCard,
    repo: &Path,
    released: Option<&str>,
    trash_entry: Option<&Path>,
    now: i64,
) -> Option<BranchCleanup> {
    record(card, repo, CleanupReason::Shipped, Some(released?), trash_entry, now)
}

/// The branches a card starting again may pick up, in order: the one its
/// record names (unless that one was deleted or was already gone), then the
/// names only this card makes ([`own_names`]). Only the card's own: never a
/// `-b` variant, never another card's.
///
/// 1.175.0 (TM-2): last, for a GitHub Issues card, the name it had before
/// its short id carried its whole number — a name other issues with the
/// same title made too, so it is offered only when it can be this card's
/// and nobody else's ([`earlier_names_to_pick_up`], read against `board`,
/// the cards of its workspace). `None` when the board couldn't be read:
/// then no earlier name is offered, and the card starts on its own.
pub fn restart_candidates(card: &KanbanCard, board: Option<&[KanbanCard]>) -> Vec<String> {
    let recorded = card
        .branch_cleanup
        .as_ref()
        .filter(|r| {
            !matches!(r.outcome, Some(CleanupOutcome::Deleted) | Some(CleanupOutcome::Gone))
                && is_card_owned_branch(&r.branch)
        })
        .map(|r| r.branch.clone());
    let mut out: Vec<String> = recorded.into_iter().collect();
    let earlier = board.map(|board| earlier_names_to_pick_up(card, board)).unwrap_or_default();
    for name in own_names(card).into_iter().chain(earlier) {
        if !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

/// [`restart_candidates`] for a card of `workspace_id`'s board, as the start
/// asks it.
pub fn restart_candidates_on(store: &crate::kanban::KanbanStore, workspace_id: &str, card: &KanbanCard) -> Vec<String> {
    let board = store.load(workspace_id);
    if let Err(e) = &board {
        log::warn!("branch cleanup: the board of {workspace_id} couldn't be read ({e}); {} picks up no earlier branch name", card.id);
    }
    restart_candidates(card, board.as_deref().ok())
}

/// TM-2: whether `card` shows it was ever started — only then can a branch
/// from before 1.175.0 be its own. Any of what a start leaves: a branch or
/// a copy recorded, the commit it was cut from, a Builder, a run, a ship, a
/// branch cleanup.
fn started_before(card: &KanbanCard) -> bool {
    card.branch_name.is_some()
        || card.worktree_path.is_some()
        || card.worktree_base.is_some()
        || card.builder.is_some()
        || card.branch_cleanup.is_some()
        || !card.run_history.is_empty()
        || !card.ship_history.is_empty()
}

/// TM-2: the earlier names of `card` (`worktrees::earlier_branch_names`) a
/// start may pick up. `ghissue<d>-<slug>` was shared by every issue with
/// that title and that first digit, so the name alone proves nothing. It is
/// this card's only when the card was started before, and no other card of
/// `board` records that branch or, started before too, would have made it —
/// the backlog's rule: a name two cards share proves neither. Otherwise the
/// card starts on `issue<N>`, which only it makes.
fn earlier_names_to_pick_up(card: &KanbanCard, board: &[KanbanCard]) -> Vec<String> {
    if !started_before(card) {
        return Vec::new();
    }
    let another_s = |name: &str| {
        board.iter().filter(|other| other.id != card.id).any(|other| {
            other.branch_name.as_deref() == Some(name)
                || other.branch_cleanup.as_ref().is_some_and(|r| r.branch == name)
                || (started_before(other)
                    && crate::worktrees::earlier_branch_names(&other.id, &other.title).iter().any(|n| n == name))
        })
    };
    crate::worktrees::earlier_branch_names(&card.id, &card.title)
        .into_iter()
        .filter(|name| !another_s(name))
        .collect()
}

/// Who this Mac is, for [`is_mine`].
#[derive(Debug, Clone, Copy, Default)]
pub struct Me<'a> {
    /// `settings.identity.user_email`, stamped as a card's `author`.
    pub email: Option<&'a str>,
    /// The workspace's GitHub login, when it could be read.
    pub login: Option<&'a str>,
}

/// A card this Mac may clean up after: every card of a local board (it was
/// made here), and a GitHub Issues card this identity created (`author`) or
/// that this GitHub login holds or opened. A team card from anyone else is
/// never touched; without a login, only the email can make it ours.
pub fn is_mine(card: &KanbanCard, me: Me<'_>) -> bool {
    if card.gh_issue_number.is_none() {
        return true;
    }
    let same = |a: &str, b: &str| !b.trim().is_empty() && a.trim().eq_ignore_ascii_case(b.trim());
    if let (Some(author), Some(email)) = (card.author.as_deref(), me.email) {
        if same(author, email) {
            return true;
        }
    }
    if let Some(login) = me.login {
        if card.gh_assignees.iter().any(|a| same(a, login))
            || card.gh_author.as_deref().is_some_and(|a| same(a, login))
        {
            return true;
        }
    }
    false
}

/// Due: the week has passed and the trash entry (when one was recorded) is
/// gone — `gc_trash` reaped it, or it was removed by hand.
pub fn is_due(record: &BranchCleanup, now: i64) -> bool {
    if now.saturating_sub(record.since) < DUE_AFTER_MS {
        return false;
    }
    match record.trash_entry.as_deref() {
        Some(entry) => std::fs::symlink_metadata(entry).is_err(),
        None => true,
    }
}

/// What the sweep needs to know besides the card.
pub struct Env<'a> {
    pub repo: &'a Path,
    /// The workspace's "Delete card branches when their trash expires".
    pub enabled: bool,
    pub me: Me<'a>,
    pub now: i64,
    /// A live session (Builder, a run) of this card.
    pub in_session: &'a dyn Fn(&KanbanCard) -> bool,
}

/// What [`sweep_card`] decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Nothing to do: no pending record, not this Mac's card, the setting is
    /// off, or a record this build cannot read.
    Skip,
    NotDue,
    /// An archived card's branch is due: the Inbox asks.
    Ask,
    /// Due, but kept this pass (checked out, a session open, git could not
    /// say): looked at again on the next.
    Held(String),
    Deleted,
    MovedOn,
    /// The branch is behind the recorded tip: commits this Mac never had.
    Behind,
    Gone,
    /// The delete failed for some other reason; tried again next pass.
    Failed(String),
}

/// Judge one card's branch and, when every rule holds, delete it — see the
/// module docs for the rule.
pub fn sweep_card(env: &Env<'_>, card: &KanbanCard) -> Verdict {
    sweep_card_hooked(env, card, &mut || {})
}

/// [`sweep_card`] with `before_delete` run between the last check and the
/// delete: the seam a test races a commit on.
fn sweep_card_hooked(env: &Env<'_>, card: &KanbanCard, before_delete: &mut dyn FnMut()) -> Verdict {
    let Some(rec) = card.branch_cleanup.as_ref().filter(|r| r.pending()) else {
        return Verdict::Skip;
    };
    if rec.reason == CleanupReason::Unknown || !is_card_owned_branch(&rec.branch) {
        return Verdict::Skip;
    }
    if !env.enabled || !is_mine(card, env.me) {
        return Verdict::Skip;
    }
    // Windows walk of #386: a pull request card's branch is its own while
    // the pull request is open, whatever recorded it.
    if crate::pr_review::branch_kept_while_open(card) {
        return Verdict::Skip;
    }
    if !is_due(rec, env.now) {
        return Verdict::NotDue;
    }
    if rec.reason == CleanupReason::Archived {
        // A card restored to the Board is no longer archived: its branch is
        // its own again (`restore_card` drops the record too).
        if !card.archived {
            return Verdict::Skip;
        }
        if !rec.approved {
            return Verdict::Ask;
        }
    }
    delete_at_tip(env, card, &rec.branch, &rec.tip, before_delete)
}

/// The guarded delete shared by the sweep and the backlog: the tip, the
/// session, every checkout, then `update-ref -d <ref> <tip>`.
fn delete_at_tip(
    env: &Env<'_>,
    card: &KanbanCard,
    branch: &str,
    tip: &str,
    before_delete: &mut dyn FnMut(),
) -> Verdict {
    delete_branch_at_tip(
        env.repo,
        branch,
        tip,
        &|| (env.in_session)(card).then(|| "a session of its card is open".to_string()),
        before_delete,
    )
}

/// [`delete_at_tip`] for any recorded branch: `busy` (asked after the tip
/// check, before the checkouts) says why it is held, when it is.
fn delete_branch_at_tip(
    repo: &Path,
    branch: &str,
    tip: &str,
    busy: &dyn Fn() -> Option<String>,
    before_delete: &mut dyn FnMut(),
) -> Verdict {
    let branch_ref = format!("refs/heads/{branch}");
    match crate::worktrees::branch_tip(repo, branch) {
        None => return Verdict::Gone,
        Some(now_at) if now_at != tip => return moved(repo, &now_at, tip),
        Some(_) => {}
    }
    if let Some(why) = busy() {
        return Verdict::Held(why);
    }
    match checkout_holding(repo, &branch_ref) {
        Ok(None) => {}
        Ok(Some(at)) => return Verdict::Held(format!("it is checked out at {}", at.display())),
        Err(e) => return Verdict::Held(format!("couldn't tell where it is checked out ({})", e.trim())),
    }
    before_delete();
    match run_git(repo, &["update-ref", "-d", &branch_ref, tip]) {
        Ok(_) => Verdict::Deleted,
        Err(e) => match crate::worktrees::branch_tip(repo, branch) {
            None => Verdict::Gone,
            Some(now_at) if now_at != tip => moved(repo, &now_at, tip),
            Some(_) => Verdict::Failed(e.trim().to_string()),
        },
    }
}

/// 1.173.0 A2: judge the branch of a thrown-away copy without a card
/// ([`CleanupReason::Copy`], on its `copies.json` entry) and, when the rule
/// holds, delete it — the rule of a shipped card's branch: the workspace's
/// "Delete card branches when their trash expires" is on (`enabled`), the
/// week is up and the copy's trash entry is gone ([`is_due`]), the branch is
/// still at the tip it had when the copy was thrown away, nothing holds it
/// (`busy`: a terminal still open where the copy was) and it is checked out
/// nowhere; then `update-ref -d <ref> <tip>`. A copy is always this Mac's
/// own, so there is no [`is_mine`] step. 1.173.0 A3: a copy whose pull
/// request is still open (`pr_open`, *Open a pull request*) keeps its
/// branch — the pull request may still take a fix from it.
pub fn sweep_copy_record(
    repo: &Path,
    enabled: bool,
    now: i64,
    record: &BranchCleanup,
    pr_open: bool,
    busy: &dyn Fn() -> Option<String>,
) -> Verdict {
    if !record.pending()
        || record.reason != CleanupReason::Copy
        || !crate::copies::is_copy_branch(&record.branch)
    {
        return Verdict::Skip;
    }
    if !enabled {
        return Verdict::Skip;
    }
    if !is_due(record, now) {
        return Verdict::NotDue;
    }
    if pr_open {
        return Verdict::Held("its pull request is still open".to_string());
    }
    delete_branch_at_tip(repo, &record.branch, &record.tip, busy, &mut || {})
}

/// The branch is not at the recorded tip: behind it (the local branch is an
/// ancestor of a merged pull request's head pushed from elsewhere), or moved
/// on from it.
fn moved(repo: &Path, now_at: &str, recorded: &str) -> Verdict {
    // A recorded tip this Mac never fetched (a pull request's head pushed
    // from elsewhere): the local branch lacks those commits — behind.
    let known = crate::platform::git_command()
        .args(["cat-file", "-e", &format!("{recorded}^{{commit}}")])
        .current_dir(repo)
        .output()
        .is_ok_and(|o| o.status.success());
    if !known {
        return Verdict::Behind;
    }
    let behind = crate::platform::git_command()
        .args(["merge-base", "--is-ancestor", now_at, recorded])
        .current_dir(repo)
        .output()
        .is_ok_and(|o| o.status.success());
    if behind {
        Verdict::Behind
    } else {
        Verdict::MovedOn
    }
}

/// Write what `verdict` settled onto `record`. `false` when nothing changes.
pub(crate) fn settle(record: &mut BranchCleanup, verdict: &Verdict, now: i64) -> bool {
    let outcome = match verdict {
        Verdict::Deleted => CleanupOutcome::Deleted,
        Verdict::MovedOn => CleanupOutcome::MovedOn,
        Verdict::Behind => CleanupOutcome::Behind,
        Verdict::Gone => CleanupOutcome::Gone,
        Verdict::Ask => {
            if record.asking {
                return false;
            }
            record.asking = true;
            record.asked_at = Some(now);
            return true;
        }
        _ => return false,
    };
    record.outcome = Some(outcome);
    record.outcome_at = Some(now);
    record.asking = false;
    true
}

/// What one workspace's sweep did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SweepReport {
    /// (card id, branch) deleted.
    pub deleted: Vec<(String, String)>,
    /// Branches kept for commits after their release.
    pub moved_on: usize,
    /// Archived cards' branches newly waiting for the Inbox ask.
    pub asks: usize,
    /// Due branches kept this pass, and why.
    pub held: Vec<(String, String)>,
    /// A card record changed.
    pub changed: bool,
}

/// Sweep every card of the workspace with a pending record.
pub fn sweep_workspace(store: &KanbanStore, workspace_id: &str, env: &Env<'_>) -> SweepReport {
    sweep_cards(store, workspace_id, env, None)
}

fn sweep_cards(
    store: &KanbanStore,
    workspace_id: &str,
    env: &Env<'_>,
    only: Option<&[String]>,
) -> SweepReport {
    let mut report = SweepReport::default();
    let cards = match store.load(workspace_id) {
        Ok(cards) => cards,
        Err(e) => {
            log::warn!("branch cleanup: {workspace_id}: board unreadable: {e}");
            return report;
        }
    };
    for card in &cards {
        if only.is_some_and(|ids| !ids.contains(&card.id)) {
            continue;
        }
        let Some(rec) = card.branch_cleanup.clone().filter(|r| r.pending()) else {
            continue;
        };
        let verdict = sweep_card(env, card);
        match &verdict {
            Verdict::Deleted => {
                log::info!("branch cleanup: {workspace_id}: deleted {} (was {})", rec.branch, rec.tip);
                report.deleted.push((card.id.clone(), rec.branch.clone()));
            }
            Verdict::MovedOn | Verdict::Behind => {
                log::info!("branch cleanup: {workspace_id}: kept {}: not at its recorded tip ({verdict:?})", rec.branch);
                report.moved_on += 1;
            }
            Verdict::Ask if !rec.asking => report.asks += 1,
            Verdict::Held(why) | Verdict::Failed(why) => {
                log::info!("branch cleanup: {workspace_id}: kept {} this pass: {why}", rec.branch);
                report.held.push((card.id.clone(), why.clone()));
            }
            _ => {}
        }
        let mut next = rec.clone();
        if !settle(&mut next, &verdict, env.now) {
            continue;
        }
        let written = store.with_card_unstamped(workspace_id, &card.id, |c| {
            // Only the record that was judged: a ship meanwhile replaced it.
            if c.branch_cleanup.as_ref().is_some_and(|r| r.same(&rec) && r.pending()) {
                c.branch_cleanup = Some(next);
            }
            Ok(())
        });
        match written {
            Ok(()) => report.changed = true,
            Err(e) => log::warn!("branch cleanup: {workspace_id}/{}: couldn't record it: {e}", card.id),
        }
    }
    report
}

/// The Inbox ask's answer for archived cards' branches. Delete: approved,
/// then swept at once under every rule but the question. Keep: remembered
/// per branch, never asked again.
pub fn answer_ask(
    store: &KanbanStore,
    workspace_id: &str,
    card_ids: &[String],
    delete: bool,
    env: &Env<'_>,
) -> Result<SweepReport, String> {
    for id in card_ids {
        store.with_card_unstamped(workspace_id, id, |c| {
            if let Some(rec) = c.branch_cleanup.as_mut().filter(|r| r.pending()) {
                if rec.reason != CleanupReason::Archived {
                    return Ok(());
                }
                rec.asking = false;
                if delete {
                    rec.approved = true;
                } else {
                    rec.outcome = Some(CleanupOutcome::Declined);
                    rec.outcome_at = Some(env.now);
                }
            }
            Ok(())
        })?;
    }
    if !delete {
        return Ok(SweepReport { changed: true, ..Default::default() });
    }
    let mut report = sweep_cards(store, workspace_id, env, Some(card_ids));
    report.changed = true;
    Ok(report)
}

/// One archived card's branch in the Inbox ask.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskItem {
    pub card_id: String,
    pub title: String,
    pub branch: String,
    /// When the ask started (the row's time).
    pub at: i64,
    /// The card shipped before (then started again and was archived): its
    /// last work, not all of it, is off the main branch.
    pub shipped: bool,
}

/// The archived cards' branches the Inbox asks about now.
pub fn asks(cards: &[KanbanCard]) -> Vec<AskItem> {
    cards
        .iter()
        .filter_map(|c| {
            let rec = c.branch_cleanup.as_ref()?;
            let due = rec.pending() && rec.asking && !rec.approved && rec.reason == CleanupReason::Archived;
            (due && c.archived).then(|| {
                AskItem {
                    card_id: c.id.clone(),
                    title: c.title.clone(),
                    branch: rec.branch.clone(),
                    at: rec.asked_at.unwrap_or(rec.since),
                    shipped: !c.ship_history.is_empty(),
                }
            })
        })
        .collect()
}

// ── The backlog: branches of cards shipped before N18 ─────────────────

/// The workspace's answer to the one-time backlog proposal
/// (`Workspace::branch_backlog`). `answer` is a string, so a value a later
/// build writes reads as answered here instead of failing the file:
/// `deleted`, `never`, `notNow` (asked again after a week), `nothing` (the
/// scan found nothing to offer).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklogAnswer {
    pub answer: String,
    pub at: i64,
}

/// Whether the backlog may be offered (scanned) now.
pub fn backlog_open(answer: Option<&BacklogAnswer>, now: i64) -> bool {
    match answer {
        None => true,
        Some(a) if a.answer == "notNow" => now.saturating_sub(a.at) >= BACKLOG_NOT_NOW_MS,
        Some(_) => false,
    }
}

/// One branch the backlog proposal offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklogItem {
    pub card_id: String,
    pub title: String,
    pub branch: String,
    /// The tip read by the scan: the only one the delete is allowed at.
    pub tip: String,
    /// An archived card that never shipped: goes to the Inbox ask instead.
    pub archived: bool,
    /// The card's last ship (or its archive), unix ms.
    pub since: i64,
}

/// Every local card branch (current and legacy prefixes) and its tip.
/// `None` when git can't list them.
fn local_card_branches(repo: &Path) -> Option<Vec<(String, String)>> {
    let out = run_git(repo, &["for-each-ref", "--format=%(refname)%09%(objectname)", "refs/heads/"])
        .map_err(|e| log::info!("branch cleanup: couldn't list branches in {}: {e}", repo.display()))
        .ok()?;
    Some(
        out.lines()
            .filter_map(|line| {
                let (name, sha) = line.split_once('\t')?;
                let branch = name.strip_prefix("refs/heads/")?;
                is_card_branch(branch).then(|| (branch.to_string(), sha.trim().to_string()))
            })
            .collect(),
    )
}

/// Every branch checked out anywhere: the main checkout and each worktree.
/// `None` when git can't say — then nothing counts as free.
fn checked_out_branches(repo: &Path) -> Option<HashSet<String>> {
    let list = run_git(repo, &["worktree", "list", "--porcelain"]).ok()?;
    Some(
        list.lines()
            .filter_map(|l| l.strip_prefix("branch refs/heads/"))
            .map(|b| b.trim().to_string())
            .collect(),
    )
}

/// The committer time of `sha`, unix seconds.
fn committed_at(repo: &Path, sha: &str) -> Option<i64> {
    run_git(repo, &["log", "-1", "--format=%ct", sha])
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// The names only `card` makes: `make_branch_name(id, title)` under the
/// current prefix and under each legacy one. Never a Build with both `-b`
/// variant: those are not the card's own branch.
fn own_names(card: &KanbanCard) -> Vec<String> {
    let current = crate::worktrees::make_branch_name(&card.id, &card.title);
    let suffix = current[crate::worktrees::BRANCH_PREFIX.len()..].to_string();
    std::iter::once(current)
        .chain(crate::worktrees::LEGACY_BRANCH_PREFIXES.iter().map(|p| format!("{p}{suffix}")))
        .collect()
}

/// Every name `card`'s branch may have been made with, for the backlog:
/// [`own_names`], then (1.175.0, TM-2) the names a GitHub Issues card had
/// before its short id carried its whole number
/// (`worktrees::earlier_branch_names`), so a branch made before the update
/// is still found. Those may be another issue's too; the backlog takes a
/// name two cards share for neither's, and a start asks
/// [`earlier_names_to_pick_up`] instead.
pub(crate) fn expected_names(card: &KanbanCard) -> Vec<String> {
    own_names(card)
        .into_iter()
        .chain(crate::worktrees::earlier_branch_names(&card.id, &card.title))
        .collect()
}

/// The content proof: merging `tip` into the target branch (the fetched
/// `origin/<target>`, or the local one) changes nothing — `git merge-tree
/// --write-tree` yields the target's own tree. A squash-merged card branch
/// passes; one with any change the target lacks, or one that would conflict,
/// does not. Needs git 2.38; an older git proves nothing.
pub fn merging_changes_nothing(repo: &Path, target: &str, tip: &str) -> bool {
    [format!("refs/remotes/origin/{target}"), format!("refs/heads/{target}")]
        .iter()
        .any(|target_ref| {
            let Some(tree) = run_git(repo, &["rev-parse", "--verify", "--quiet", &format!("{target_ref}^{{tree}}")])
                .ok()
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
            else {
                return false;
            };
            run_git(repo, &["merge-tree", "--write-tree", target_ref, tip])
                .ok()
                .and_then(|out| out.lines().next().map(|l| l.trim().to_string()))
                .is_some_and(|merged| merged == tree)
        })
}

/// The backlog for one workspace — see the module docs for the rule.
/// `None` when the repository could not be read (git failed): then nothing
/// is offered and nothing is remembered.
pub fn scan_backlog(
    repo: &Path,
    target: &str,
    cards: &[KanbanCard],
    me: Me<'_>,
    in_session: &dyn Fn(&KanbanCard) -> bool,
    now: i64,
) -> Option<Vec<BacklogItem>> {
    let held = checked_out_branches(repo)?;
    let branches = local_card_branches(repo)?;
    // Each expected name → the cards that would have made it; a name two
    // cards share proves neither.
    let mut by_name: HashMap<String, Vec<&KanbanCard>> = HashMap::new();
    for card in cards {
        for name in expected_names(card) {
            by_name.entry(name).or_default().push(card);
        }
    }
    let mut items = Vec::new();
    for (branch, tip) in branches {
        let Some([card]) = by_name.get(&branch).map(|v| v.as_slice()) else {
            continue;
        };
        if held.contains(&branch)
            || !is_mine(card, me)
            || card.branch_cleanup.is_some()
            || card.branch_name.is_some()
            || card.worktree_path.is_some()
            || in_session(card)
        {
            continue;
        }
        if let Some(last_ship) = card.ship_history.iter().map(|s| s.shipped_at).max() {
            let Some(at) = committed_at(repo, &tip) else { continue };
            if at.saturating_mul(1000) > last_ship {
                // Committed after its last ship: work no release carries.
                continue;
            }
            if !merging_changes_nothing(repo, target, &tip) {
                // Not provably in the target: something on it may exist
                // nowhere else.
                continue;
            }
            items.push(BacklogItem {
                card_id: card.id.clone(),
                title: card.title.clone(),
                branch,
                tip,
                archived: false,
                since: last_ship,
            });
        } else if card.archived {
            items.push(BacklogItem {
                card_id: card.id.clone(),
                title: card.title.clone(),
                branch,
                tip,
                archived: true,
                since: card.archived_at.unwrap_or(now),
            });
        }
    }
    items.sort_by(|a, b| a.branch.cmp(&b.branch));
    Some(items)
}

/// What applying the backlog's Delete did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklogReport {
    pub deleted: usize,
    /// Offered, but no longer passing the rule (or git refused at the tip).
    pub kept: usize,
    /// Archived cards' branches handed to the Inbox ask.
    pub queued: usize,
}

/// Delete N branches: each offered branch that a fresh scan still offers at
/// the same tip is deleted there (compare-and-delete) and recorded on its
/// card, so the card's Activity says so; an archived card's is recorded for
/// the Inbox ask instead. `Err` when the fresh scan could not be made.
pub fn apply_backlog(
    store: &KanbanStore,
    workspace_id: &str,
    target: &str,
    offered: &[BacklogItem],
    env: &Env<'_>,
) -> Result<BacklogReport, String> {
    let cards = store.load(workspace_id)?;
    let fresh = scan_backlog(env.repo, target, &cards, env.me, env.in_session, env.now)
        .ok_or_else(|| "Plyloft couldn't read the repository's branches".to_string())?;
    let mut report = BacklogReport::default();
    for item in offered {
        let Some(now_item) = fresh
            .iter()
            .find(|f| f.card_id == item.card_id && f.branch == item.branch && f.tip == item.tip)
        else {
            report.kept += 1;
            continue;
        };
        let Some(card) = cards.iter().find(|c| c.id == item.card_id) else {
            report.kept += 1;
            continue;
        };
        let mut rec = BranchCleanup::new(
            &now_item.branch,
            &now_item.tip,
            if now_item.archived { CleanupReason::Archived } else { CleanupReason::Shipped },
            now_item.since,
            None,
        );
        if now_item.archived {
            report.queued += 1;
        } else {
            let verdict = delete_at_tip(env, card, &now_item.branch, &now_item.tip, &mut || {});
            if verdict != Verdict::Deleted {
                log::info!("branch cleanup: backlog kept {}: {verdict:?}", now_item.branch);
                report.kept += 1;
                continue;
            }
            rec.outcome = Some(CleanupOutcome::Deleted);
            rec.outcome_at = Some(env.now);
            report.deleted += 1;
        }
        store.with_card_unstamped(workspace_id, &card.id, |c| {
            if c.branch_cleanup.is_none() {
                c.branch_cleanup = Some(rec);
            }
            Ok(())
        })?;
    }
    if report.queued > 0 {
        // The archived ones are long due: the ask shows now, not tomorrow.
        sweep_workspace(store, workspace_id, env);
    }
    Ok(report)
}

/// The backlog proposals found at launch, per workspace, until answered,
/// with when they were found.
#[derive(Default)]
pub struct BacklogState {
    by_workspace: parking_lot::Mutex<HashMap<String, (i64, Vec<BacklogItem>)>>,
}

impl BacklogState {
    pub fn set(&self, workspace_id: &str, at: i64, items: Vec<BacklogItem>) {
        let mut map = self.by_workspace.lock();
        if items.is_empty() {
            map.remove(workspace_id);
        } else {
            map.insert(workspace_id.to_string(), (at, items));
        }
    }

    pub fn get(&self, workspace_id: &str) -> Option<(i64, Vec<BacklogItem>)> {
        self.by_workspace.lock().get(workspace_id).cloned()
    }

    pub fn take(&self, workspace_id: &str) -> Vec<BacklogItem> {
        self.by_workspace.lock().remove(workspace_id).map(|(_, v)| v).unwrap_or_default()
    }

    /// Put an offer back (an answer that could not be applied).
    pub fn restore(&self, workspace_id: &str, at: i64, items: Vec<BacklogItem>) {
        self.set(workspace_id, at, items);
    }
}

// ── The app: the trash GC's pass, the Inbox's answers ─────────────────

/// A live session of the card: its Builder, a run in progress, or one of the
/// two builds of "Build with both".
fn card_in_session<R: tauri::Runtime>(app: &tauri::AppHandle<R>, card: &KanbanCard) -> bool {
    use tauri::Manager;
    let builder = app
        .try_state::<crate::builder::BuilderRegistry>()
        .is_some_and(|b| b.get_pty(&card.id).is_some());
    builder
        || card.last_run_status == Some(crate::kanban::LastRunStatus::Running)
        || card.build_both.is_some() && crate::build_both::is_undecided(card)
}

/// The workspace's folder, its cleanup switch and its backlog answer.
fn workspace_facts<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
) -> Option<(std::path::PathBuf, bool, Option<BacklogAnswer>)> {
    use tauri::Manager;
    let store = app.try_state::<crate::workspace::WorkspaceStore>()?;
    let ws = store.snapshot().workspaces.into_iter().find(|w| w.id == workspace_id)?;
    Some((std::path::PathBuf::from(ws.cwd), !ws.keep_card_branches, ws.branch_backlog))
}

/// This Mac's identity email, and — only when a GitHub Issues card needs
/// it — the workspace's GitHub login (one cached `gh api user`). The bool is
/// false when a login was needed and could not be read (offline, gh signed
/// out): what was judged without it is not a complete answer.
fn whoami<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    cards: &[KanbanCard],
) -> (Option<String>, Option<String>, bool) {
    use tauri::Manager;
    let email = app
        .try_state::<crate::settings::SettingsStore>()
        .and_then(|s| s.snapshot().identity.user_email);
    let needs_login = cards.iter().any(|c| c.gh_issue_number.is_some());
    let login = needs_login
        .then(|| {
            let _github = crate::github_account::enter_for_app(app, workspace_id);
            crate::github::current_login().ok()
        })
        .flatten();
    let complete = !needs_login || login.is_some();
    (email, login, complete)
}

/// The workspace's target branch (`ProjectConfig::target_branch`).
fn target_of<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str) -> Option<String> {
    use tauri::Manager;
    app.try_state::<crate::project_config::ProjectConfigStore>()?
        .get(workspace_id)
        .map(|c| c.target_branch)
        .filter(|t| !t.trim().is_empty())
}

/// The trash GC's branch pass for one workspace, right after `gc_trash`:
/// the sweep, and — on the launch pass, until answered — the backlog scan.
/// Serialized with card starts (`CARD_START_LOCK`), as every prune is.
pub fn sweep_for_app<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    launch: bool,
) -> SweepReport {
    use tauri::Manager;
    let Some(store) = app.try_state::<KanbanStore>() else {
        return SweepReport::default();
    };
    let Some((cwd, enabled, answer)) = workspace_facts(app, workspace_id) else {
        return SweepReport::default();
    };
    let cards = store.load(workspace_id).unwrap_or_default();
    let now = crate::kanban::now_ms();
    // 1.173.0 A2: the branches of thrown-away copies without a card, under
    // the same switch and the same rule (`sweep_copy_record`).
    crate::copies::sweep_for_app(app, workspace_id, &cwd, enabled, now);
    let pending = cards.iter().any(|c| c.branch_cleanup.as_ref().is_some_and(|r| r.pending()));
    let scan = launch && enabled && backlog_open(answer.as_ref(), now);
    if !enabled || (!pending && !scan) {
        return SweepReport::default();
    }
    let (email, login, complete) = whoami(app, workspace_id, &cards);
    let in_session = |card: &KanbanCard| card_in_session(app, card);
    let env = Env {
        repo: &cwd,
        enabled,
        me: Me { email: email.as_deref(), login: login.as_deref() },
        now,
        in_session: &in_session,
    };
    let report = {
        let _start = crate::commands::CARD_START_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        sweep_workspace(&store, workspace_id, &env)
    };
    let mut changed = report.changed;
    let target = target_of(app, workspace_id);
    if let (true, Some(target)) = (scan, target.as_deref()) {
        let cards = store.load(workspace_id).unwrap_or_default();
        // `None`: git could not be read. Nothing is offered, nothing is
        // remembered — the next launch scans again.
        let items = scan_backlog(&cwd, target, &cards, env.me, &in_session, now).unwrap_or_default();
        // R2: nor after a scan of a board that isn't the whole picture.
        let clean = complete && store.load_whole(workspace_id).is_ok();
        let read = scan_backlog_readable(&cwd);
        if items.is_empty() {
            // "Nothing" is remembered only after a scan that saw everything.
            if answer.is_none() && clean && read {
                if let Some(ws) = app.try_state::<crate::workspace::WorkspaceStore>() {
                    let nothing = BacklogAnswer { answer: "nothing".into(), at: now };
                    if let Err(e) = ws.set_branch_backlog(workspace_id, nothing) {
                        log::warn!("branch cleanup: {workspace_id}: couldn't remember the backlog: {e}");
                    }
                }
            }
        } else {
            log::info!("branch cleanup: {workspace_id}: {} old card branch(es) to offer", items.len());
            if let Some(state) = app.try_state::<BacklogState>() {
                state.set(workspace_id, now, items);
                changed = true;
            }
        }
    }
    if changed {
        crate::kanban::emit_kanban_changed(app, workspace_id);
    }
    report
}

/// Whether the repository's branches and checkouts can be read at all.
fn scan_backlog_readable(repo: &Path) -> bool {
    checked_out_branches(repo).is_some() && local_card_branches(repo).is_some()
}

/// What the Inbox shows for one workspace.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingCleanup {
    pub workspace_id: String,
    pub workspace_name: String,
    /// Archived cards' branches that are due: Delete them / Keep them.
    pub asks: Vec<AskItem>,
    /// The one-time proposal for branches of cards shipped before N18.
    pub backlog: Vec<BacklogItem>,
    /// When the proposal was found (its row's time).
    pub backlog_at: Option<i64>,
}

/// Every workspace's asks and backlog proposal; workspaces with neither,
/// or with the cleanup turned off, are left out.
#[tauri::command]
pub fn branch_cleanup_pending(app: tauri::AppHandle) -> Vec<PendingCleanup> {
    use tauri::Manager;
    let Some(workspaces) = app.try_state::<crate::workspace::WorkspaceStore>() else {
        return Vec::new();
    };
    let kanban = app.state::<KanbanStore>();
    let backlog = app.state::<BacklogState>();
    workspaces
        .snapshot()
        .workspaces
        .into_iter()
        .filter(|w| !w.keep_card_branches)
        .filter_map(|w| {
            let cards = kanban.load(&w.id).unwrap_or_default();
            let (backlog_at, offered) = match backlog.get(&w.id) {
                Some((at, items)) => (Some(at), items),
                None => (None, Vec::new()),
            };
            let item = PendingCleanup {
                asks: asks(&cards),
                backlog: offered,
                backlog_at,
                workspace_id: w.id,
                workspace_name: w.name,
            };
            (!item.asks.is_empty() || !item.backlog.is_empty()).then_some(item)
        })
        .collect()
}

/// Run `f` with the sweep's environment for a workspace, off the UI thread.
async fn with_env<T: Send + 'static>(
    app: tauri::AppHandle,
    workspace_id: String,
    f: impl FnOnce(&KanbanStore, &Env<'_>) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let (cwd, enabled, _) =
            workspace_facts(&app, &workspace_id).ok_or_else(|| "workspace not found".to_string())?;
        let store = app.state::<KanbanStore>();
        let cards = store.load(&workspace_id)?;
        let (email, login, _) = whoami(&app, &workspace_id, &cards);
        let in_session = |card: &KanbanCard| card_in_session(&app, card);
        let env = Env {
            repo: &cwd,
            enabled,
            me: Me { email: email.as_deref(), login: login.as_deref() },
            now: crate::kanban::now_ms(),
            in_session: &in_session,
        };
        let _start = crate::commands::CARD_START_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let out = f(&store, &env);
        crate::kanban::emit_kanban_changed(&app, &workspace_id);
        out
    })
    .await
    .map_err(|e| format!("branch cleanup worker failed: {e}"))?
}

/// What an answer did, for the toast.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerResult {
    pub deleted: usize,
    /// Due branches kept this time (checked out, a session open, moved on).
    pub kept: usize,
    /// Archived cards' branches handed to the Inbox ask (backlog only).
    pub queued: usize,
}

/// The Inbox ask: Delete them (`delete` true) or Keep them, for these cards.
#[tauri::command]
pub async fn branch_cleanup_answer(
    app: tauri::AppHandle,
    workspace_id: String,
    card_ids: Vec<String>,
    delete: bool,
) -> Result<AnswerResult, String> {
    with_env(app, workspace_id.clone(), move |store, env| {
        let report = answer_ask(store, &workspace_id, &card_ids, delete, env)?;
        Ok(AnswerResult {
            deleted: report.deleted.len(),
            kept: if delete { card_ids.len().saturating_sub(report.deleted.len()) } else { card_ids.len() },
            queued: 0,
        })
    })
    .await
}

/// The backlog proposal's answer: `delete`, `notNow` or `never`.
#[tauri::command]
pub async fn branch_backlog_answer(
    app: tauri::AppHandle,
    workspace_id: String,
    answer: String,
) -> Result<AnswerResult, String> {
    use tauri::Manager;
    if !matches!(answer.as_str(), "delete" | "notNow" | "never") {
        return Err(format!("unknown answer: {answer}"));
    }
    let state = app.state::<BacklogState>();
    let found_at = state.get(&workspace_id).map(|(at, _)| at).unwrap_or_else(crate::kanban::now_ms);
    let offered = state.take(&workspace_id);
    let remember = |app: &tauri::AppHandle, word: &str| -> Result<(), String> {
        app.state::<crate::workspace::WorkspaceStore>().set_branch_backlog(
            &workspace_id,
            BacklogAnswer { answer: word.to_string(), at: crate::kanban::now_ms() },
        )
    };
    if answer != "delete" {
        remember(&app, &answer)?;
        crate::kanban::emit_kanban_changed(&app, &workspace_id);
        return Ok(AnswerResult::default());
    }
    let Some(target) = target_of(&app, &workspace_id) else {
        app.state::<BacklogState>().restore(&workspace_id, found_at, offered);
        return Err("This project has no integration branch chosen in Settings, so nothing was deleted.".to_string());
    };
    let ws = workspace_id.clone();
    let kept_offer = offered.clone();
    let applied = with_env(app.clone(), workspace_id.clone(), move |store, env| {
        apply_backlog(store, &ws, &target, &offered, env)
    })
    .await;
    match applied {
        // Remembered only once it was applied: a failure offers it again.
        Ok(report) => {
            remember(&app, "deleted")?;
            crate::kanban::emit_kanban_changed(&app, &workspace_id);
            Ok(AnswerResult { deleted: report.deleted, kept: report.kept, queued: report.queued })
        }
        Err(e) => {
            app.state::<BacklogState>().restore(&workspace_id, found_at, kept_offer);
            Err(e)
        }
    }
}

#[cfg(test)]
#[path = "branch_cleanup_tests.rs"]
mod tests;
