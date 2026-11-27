//! N14 walk F8 (launch D4): **Put back in To do**, from a card's ⋯.
//!
//! A card In progress (or in Complete, waiting to ship) that has not landed
//! goes back to To do in one step under `CARD_START_LOCK`: its live sessions
//! stop — the Builder's, both builds of Build with both, an intake still
//! talking — and the card is written To do with nothing recorded as running.
//! Its branch and worktree stay: a later Start build continues from them
//! (`commands::advance_card_to_in_progress_staged` reuses the card's own
//! worktree).
//!
//! What Plyloft can't stop from here is not stopped either: a Verify run, an
//! agent run, a setup, a swarm or the Challenger working on the card refuse
//! the put back in words (the caller's `busy`), as a delete does. A card
//! whose pull request is open is refused too — its work is on GitHub, and
//! nothing here touches the pull request.

use std::path::Path;

use crate::builder::BuilderRegistry;
use crate::kanban::{KanbanCard, KanbanColumnId, KanbanStore, VerifyStatus};
use crate::pty::PtyRegistry;

/// An open pull request is refused, in these words (the owner's).
pub const OPEN_PR_REFUSAL: &str =
    "This card has an open pull request — merge or close it first, or archive the card.";

/// What stops the put back and what it acts on, from the app's registries.
pub struct Live<'a> {
    pub builders: &'a BuilderRegistry,
    pub pty: &'a PtyRegistry,
    /// Why work the put back can't stop is still on the card (checks, an
    /// agent run, a setup, a swarm, the Challenger); `None` when nothing is.
    pub busy: &'a dyn Fn(&KanbanCard) -> Option<String>,
    /// End the card's intake conversation if one is live in this process
    /// (idempotent); `true` when one was.
    pub stop_intake: &'a dyn Fn() -> Result<bool, String>,
}

/// Why `card` can't be put back in To do; `None` when it can. Pure.
/// `github_board`: its board is backed by GitHub Issues, where only a card
/// worked on this Mac is this person's to put back.
pub fn refusal(card: &KanbanCard, github_board: bool) -> Option<String> {
    if card.archived {
        return Some("This card is archived.".into());
    }
    if card.column_id == KanbanColumnId::Todo {
        return Some("This card is already in Ready to start.".into());
    }
    // Challenger on a pull request: it has no To do; archive is its way out.
    if card.pr_review.is_some() {
        return Some(crate::pr_review::PUT_BACK_REFUSAL.into());
    }
    if crate::kanban::card_landed(card) {
        return Some("This card has shipped, so there is nothing to move back to Ready to start.".into());
    }
    if crate::pr_status::card_pr_open(card) {
        return Some(OPEN_PR_REFUSAL.into());
    }
    let here = card.worktree_path.as_deref().is_some_and(|p| !p.trim().is_empty());
    // Challenger P3-4: Complete with no worktree is history, not work.
    if card.column_id == KanbanColumnId::Complete && !here {
        return Some("This card has no work in progress to move back to Ready to start.".into());
    }
    // Challenger P3-3: the comparison runs a Challenger of its own, which
    // nothing here can end; it is waited for.
    if card.build_both.as_ref().is_some_and(|bb| bb.undecided() && bb.comparing()) {
        return Some(
            "The Reviewer is comparing the two builds. Wait for it to finish, then move the card back to Ready to start.".into(),
        );
    }
    if github_board && !here {
        return Some(format!(
            "This card isn't being built on {}, so it can't be moved back to Ready to start from here.",
            crate::platform::THIS_MACHINE
        ));
    }
    None
}

/// The card's write: To do, with nothing recorded as running or waiting —
/// no session, no run, no checks, no review under way or waiting to start.
/// Kept: the branch, the worktree, the snapshots, the review rounds and the
/// run history. What a Start build would drop anyway (the last review, an
/// undelivered verdict) is dropped now, so the card reads as To do.
pub fn apply(c: &mut KanbanCard) {
    c.column_id = KanbanColumnId::Todo;
    c.last_run_status = None;
    if c.verify_status != VerifyStatus::Legacy {
        c.verify_status = VerifyStatus::None;
    }
    if c.intake_status == crate::kanban::IntakeStatus::Active {
        c.intake_status = crate::kanban::IntakeStatus::None;
    }
    if let Some(b) = c.builder.as_mut() {
        b.pty_id = None;
        b.session_lost = false;
        b.resume_failed = false;
        b.review = None;
        b.waiting_review = None;
        b.undelivered_verdict = None;
    }
}

/// N14 walk F19: remember when the card was put back (oldest first, capped
/// at `MAX_PUT_BACKS`), for its Activity row.
pub fn record_put_back(c: &mut KanbanCard, at: i64) {
    c.put_backs.push(at);
    let max = crate::kanban::MAX_PUT_BACKS;
    if c.put_backs.len() > max {
        let extra = c.put_backs.len() - max;
        c.put_backs.drain(..extra);
    }
}

/// The put back. The caller holds `CARD_START_LOCK` (a start, a resume, a
/// pick, a Ship and an archive all take it), so nothing starts on the card
/// between the checks and the write.
#[allow(clippy::too_many_arguments)]
pub fn put_back_locked(
    kanban: &KanbanStore,
    ws_cwd: &Path,
    cache_paths: &[String],
    live: &Live<'_>,
    github_board: bool,
    workspace_id: &str,
    card_id: &str,
    by: Option<&str>,
) -> Result<KanbanCard, String> {
    let card = kanban.get_card(workspace_id, card_id)?;
    if let Some(why) = refusal(&card, github_board) {
        return Err(why);
    }
    if let Some(why) = (live.busy)(&card) {
        return Err(why);
    }
    // The sessions: the Builder's, and both builds' while both build it.
    // Killed as app exit kills them (Hard Rule #4); the write below clears
    // their ids, so a late exit event finds nothing to mark.
    let mut stopped = live.builders.end_session(live.pty, card_id);
    let both = crate::build_both::is_undecided(&card);
    let archived = both.then(|| {
        stopped |= crate::build_both::end_lane_sessions(live.builders, live.pty, card_id);
        // As Stop both does: Codex's build is set aside (anything uncommitted
        // committed on its branch first, the branch kept); Claude's worktree
        // is the card's own and stays.
        let lane_b = card
            .build_both
            .as_ref()
            .and_then(|bb| bb.lane(crate::build_both::LANE_B))
            .cloned()
            .unwrap_or_default();
        let dir = crate::build_both::variant_dir(card_id);
        // N16: the lane's own record of its folder, never a lookup by name.
        let path = crate::worktrees::recorded_worktree_path(ws_cwd, &dir, Some(&lane_b.worktree_path));
        if path.is_dir() {
            let _ = crate::worktrees::commit_pending_in_worktree(
                &path,
                &crate::commit_message::set_aside_subject("Codex", &card.title),
            );
        }
        // Try it (TI-2): the set-aside build's preview stops with it.
        crate::try_session::stop_card_try_sessions(
            workspace_id,
            card_id,
            Some(crate::build_both::LANE_B),
            crate::try_session::TryStopReason::Discard,
        );
        crate::build_both::archived_lane(&lane_b, crate::worktrees::prune_worktree_at(ws_cwd, &path, cache_paths))
    });
    // Challenger P3-1: whatever the card says, a conversation still live
    // for it in this process is ended.
    match (live.stop_intake)() {
        Ok(ended) => stopped |= ended,
        Err(e) => log::warn!("put back {card_id}: ending its intake: {e}"),
    }
    let at = crate::kanban::now_ms();
    let mut updated = None;
    let written = kanban.with_card(workspace_id, card_id, |c| {
        if let Some(archived) = archived.clone() {
            crate::build_both::apply_stop(c, by, at, archived)?;
        }
        apply(c);
        // N14 walk F19: the Activity's "Put back in To do" row.
        record_put_back(c, at);
        updated = Some(c.clone());
        Ok(())
    });
    // Challenger P3-2: said as it is — what was stopped stays stopped.
    if let Err(e) = written {
        log::warn!("put back {card_id}: the card couldn't be written (stopped: {stopped}): {e}");
        return Err(if stopped {
            format!("Its sessions were stopped, but the card couldn't be moved back to Ready to start: {e}")
        } else {
            format!("The card couldn't be moved back to Ready to start: {e}")
        });
    }
    if both {
        for lane in [crate::build_both::LANE_A, crate::build_both::LANE_B] {
            crate::verify_logs::card_worktree_removed(workspace_id, &crate::build_both::lane_key(card_id, lane));
        }
    }
    updated.ok_or_else(|| "the put back did not capture the card".to_string())
}

#[cfg(test)]
mod tests;
