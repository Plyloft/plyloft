//! 1.175.0 (D2; owner, 2026-11-09): leaving a card takes the member's own
//! name off its issue.
//!
//! On a GitHub Issues board a claim is the issue's assignee, and before
//! 1.175.0 nothing ever took it off: a card moved back, stopped while it
//! started, or archived stayed "Claimed by X" for everybody else, for good
//! (TM-3). Now the three gestures that leave a card — *Move back to Ready to
//! start*, Stop during the start, *Archive* by hand — take the member's own
//! name off its issue ([`leave`], through
//! [`crate::github::issue_remove_assignee_me`]: `@me`, never a login, so
//! never anybody else's name). No question is asked; the gesture's own sheet
//! and toast say it.
//!
//! Only a card **without a pull request** that hasn't shipped and isn't
//! Done: shipped work stays its author's ([`applies`]). A pull request
//! review card has no issue.
//!
//! GitHub refuses (D2-a): the gesture still goes through, the card is marked
//! `unassign_pending`, and the next Sync tries once more before it reads
//! ([`retry_pending`]), inside that Sync's cap of writes
//! (`github_sync::LABEL_WRITES_PER_SYNC`, U33). A Start build on the card
//! drops the mark ([`taken_up`]): the member wants the card again, and the
//! name stays. The retry and the claim take turns on one small lock
//! ([`NAME_LOCK`]): a retry decides from the card as it is then, never from
//! the Sync's older reading of the board, and a claim that finds a removal
//! on its way waits for it (one bounded `gh` call) before it reads who
//! holds the issue. An issue GitHub says is gone is no longer retried.
//!
//! What became of the name is told once to the gesture that asked
//! ([`take_outcome`], the `card_name_off_outcome` command), for its toast.
//!
//! The computer's claim marker is another matter (`device_claim`, TM-6): it
//! stays while the card's copy is on this computer, and goes with the copy —
//! which is why a merged card ([`merged`]) and a deleted copy
//! ([`copy_deleted`]) release it here.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::Manager;

use crate::kanban::{KanbanCard, KanbanColumnId, KanbanStore};

/// What became of the member's name on the issue of a card they left.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NameOff {
    /// GitHub took it off.
    Off { number: u64 },
    /// GitHub didn't; the next Sync tries again. `details` is its answer.
    Refused { number: u64, details: String },
}

/// Round 2: a removal of the member's name (a card left, a Sync's retry) and
/// a claim's "wanted again" never overlap. Held across the one `gh` write.
static NAME_LOCK: Mutex<()> = Mutex::new(());

fn name_lock() -> std::sync::MutexGuard<'static, ()> {
    NAME_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

/// The last outcome per (workspace, card), until the gesture reads it.
static OUTCOMES: Mutex<Option<HashMap<(String, String), NameOff>>> = Mutex::new(None);

fn note(workspace_id: &str, card_id: &str, outcome: Option<&NameOff>) {
    let mut all = OUTCOMES.lock().unwrap_or_else(|p| p.into_inner());
    let map = all.get_or_insert_with(HashMap::new);
    let key = (workspace_id.to_string(), card_id.to_string());
    match outcome {
        Some(outcome) => map.insert(key, outcome.clone()),
        None => map.remove(&key),
    };
}

/// What [`leave`] last did for the card, once.
pub fn take_outcome(workspace_id: &str, card_id: &str) -> Option<NameOff> {
    let mut all = OUTCOMES.lock().unwrap_or_else(|p| p.into_inner());
    all.as_mut()?.remove(&(workspace_id.to_string(), card_id.to_string()))
}

/// The toast of Move back, Stop during the start and Archive asks what
/// became of the member's name on the card's issue. `None`: nothing was
/// asked of GitHub (a local board, a card that isn't theirs, one with a
/// pull request). No git, no `gh`: it reads what the gesture left.
#[tauri::command]
pub fn card_name_off_outcome(workspace_id: String, card_id: String) -> Option<NameOff> {
    take_outcome(&workspace_id, &card_id)
}

/// Leaving `card` takes the member's name off its issue: a card of an
/// issue, that has no pull request, hasn't shipped and isn't Done. Mirrors
/// the frontend's `ownNameComesOff` (`cardClaim.ts`), which also asks whose
/// the name is.
///
/// Round 2: a card in Done keeps the name whatever this computer recorded
/// of how it got there (shipped from the member's other computer, merged
/// through a pull request made by hand): archiving it is tidying, not
/// leaving the work. A card moved back is in Ready to start by the time
/// this is asked.
pub fn applies(card: &KanbanCard) -> bool {
    card.gh_issue_number.is_some()
        && card.column_id != KanbanColumnId::Complete
        && card.pr_review.is_none()
        && card.pr.is_none()
        && card.pr_url.is_none()
        && !crate::kanban::card_shipped_or_pr_open(card)
}

fn holds(card: &KanbanCard, login: &str) -> bool {
    card.gh_assignees.iter().any(|a| a.eq_ignore_ascii_case(login))
}

/// The card records what the issue now says: the member's name is off it.
fn record_off(store: &KanbanStore, workspace_id: &str, card: &KanbanCard, login: &str) {
    let left: Vec<String> = card.gh_assignees.iter().filter(|a| !a.eq_ignore_ascii_case(login)).cloned().collect();
    if let Err(e) = store.set_gh_assignees(workspace_id, &card.id, left) {
        log::warn!("leave issue: recording {}'s assignees failed: {e}", card.id);
    }
}

fn mark(store: &KanbanStore, workspace_id: &str, card_id: &str, pending: bool) {
    if let Err(e) = store.set_unassign_pending(workspace_id, card_id, pending) {
        log::warn!("leave issue: marking {card_id} (pending: {pending}) failed: {e}");
    }
}

/// The member left the card (Move back, Stop during the start, Archive):
/// their own name comes off its issue, when it is on it and [`applies`].
/// Best-effort — the gesture already went through: a refusal marks the card
/// for the next Sync. The caller is inside the workspace's GitHub account
/// scope. Returns what it did, also kept for [`take_outcome`].
pub fn leave(store: &KanbanStore, repo: &str, workspace_id: &str, card_id: &str) -> Option<NameOff> {
    let _turn = name_lock();
    let outcome = leave_card(store, repo, workspace_id, card_id);
    note(workspace_id, card_id, outcome.as_ref());
    outcome
}

fn leave_card(store: &KanbanStore, repo: &str, workspace_id: &str, card_id: &str) -> Option<NameOff> {
    let card = store.get_card(workspace_id, card_id).ok()?;
    let number = card.gh_issue_number?;
    if !applies(&card) || card.gh_assignees.is_empty() {
        mark(store, workspace_id, card_id, false);
        return None;
    }
    // Whose name it is: only the member's own is ever asked off.
    let login = match crate::github::current_login() {
        Ok(login) => login,
        Err(e) => {
            // Sync decides, once GitHub says who this is.
            log::warn!("leave issue: {repo}#{number}: the login couldn't be read ({e}); Sync retries");
            mark(store, workspace_id, card_id, true);
            return Some(NameOff::Refused { number, details: e });
        }
    };
    if !holds(&card, &login) {
        mark(store, workspace_id, card_id, false);
        return None;
    }
    match crate::github::issue_remove_assignee_me(repo, number) {
        Ok(()) => {
            record_off(store, workspace_id, &card, &login);
            mark(store, workspace_id, card_id, false);
            Some(NameOff::Off { number })
        }
        // GitHub has no such issue any more: nothing carries the name.
        Err(e) if gone(&e) => {
            log::info!("leave issue: {repo}#{number} is gone from GitHub ({e}); nothing to take off");
            mark(store, workspace_id, card_id, false);
            None
        }
        Err(e) => {
            log::warn!("leave issue: {repo}#{number}: the member's name wasn't taken off ({e}); Sync retries");
            mark(store, workspace_id, card_id, true);
            Some(NameOff::Refused { number, details: e })
        }
    }
}

/// GitHub's answer that the repository has no such issue (deleted, or
/// moved to a repository this one doesn't lead to): then no retry can ever
/// go through, and the mark is dropped. Nothing else counts as gone — a
/// closed issue still takes the write (the name comes off it), and a
/// refusal for any other reason (no network, no rights, a rule) may pass.
fn gone(error: &str) -> bool {
    crate::github::is_issue_not_found(error)
}

/// The member wants the card again (Start build's gate let it through, or
/// they claimed it): a name still owed off its issue stays on it.
///
/// Round 2: asked **before** the claim reads who holds the issue, and on
/// the removals' lock — a retry already on its way finishes first (then the
/// claim's reading sees the name off and puts it back), and one that comes
/// after finds no mark.
///
/// Returns whether a removal was owed, for [`not_taken`].
pub fn taken_up(store: &KanbanStore, workspace_id: &str, card_id: &str) -> bool {
    let _turn = name_lock();
    let owed = store.get_card(workspace_id, card_id).map(|c| c.unassign_pending).unwrap_or(false);
    mark(store, workspace_id, card_id, false);
    note(workspace_id, card_id, None);
    owed
}

/// Round 3: the card was not taken up after all — the claim, or the start
/// gate's reading of the issue, failed (no network). A removal that was
/// `owed` before [`taken_up`] is owed again: forgetting it left the name on
/// an issue the member had left. Hands `error` back, for a `map_err`.
pub fn not_taken<E>(store: &KanbanStore, workspace_id: &str, card_id: &str, owed: bool, error: E) -> E {
    if owed {
        let _turn = name_lock();
        mark(store, workspace_id, card_id, true);
    }
    error
}

/// D2-a: a Sync tries once more to take the member's name off the issues of
/// the cards still marked, newest issue first, before it reads. At most
/// `limit` writes (what is left of the Sync's cap, U33); the rest wait for
/// the next Sync. A card worked on again, one that got a pull request or is
/// Done, and one whose issue no longer carries the name are unmarked
/// without a write; so is one whose issue GitHub says is gone.
/// Returns the writes it made, refused ones included.
///
/// Round 2: `local` (the Sync's reading of the board) only says which cards
/// to look at. Each is read again from the store under [`NAME_LOCK`] right
/// before its write, so a Start build since that reading keeps the name.
pub fn retry_pending(store: &KanbanStore, repo: &str, workspace_id: &str, local: &[KanbanCard], limit: usize) -> usize {
    let mut due: Vec<&KanbanCard> = local.iter().filter(|c| c.unassign_pending).collect();
    if due.is_empty() {
        return 0;
    }
    due.sort_by_key(|c| std::cmp::Reverse(c.gh_issue_number));
    let Ok(login) = crate::github::current_login() else {
        // GitHub can't say who this is: the write would be refused too.
        return 0;
    };
    let mut written = 0;
    for seen in due {
        let _turn = name_lock();
        // As it is now, not as the Sync read it.
        let Ok(card) = store.get_card(workspace_id, &seen.id) else { continue };
        if !card.unassign_pending {
            continue;
        }
        let working = !card.archived && card.column_id == KanbanColumnId::InProgress;
        let number = match card.gh_issue_number {
            Some(number) if applies(&card) && !working && holds(&card, &login) => number,
            _ => {
                mark(store, workspace_id, &card.id, false);
                continue;
            }
        };
        if written == limit {
            break;
        }
        written += 1;
        match crate::github::issue_remove_assignee_me(repo, number) {
            Ok(()) => {
                record_off(store, workspace_id, &card, &login);
                mark(store, workspace_id, &card.id, false);
            }
            Err(e) if gone(&e) => {
                log::info!("leave issue: {repo}#{number} is gone from GitHub ({e}); no more retries");
                mark(store, workspace_id, &card.id, false);
            }
            Err(e) => log::warn!("leave issue: {repo}#{number}: the retry was refused too ({e}); the next Sync tries again"),
        }
    }
    written
}

/// The GitHub Issues repository of the workspace, for a team that may write.
fn issues_repo<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str) -> Option<String> {
    let workspaces = app.try_state::<crate::workspace::WorkspaceStore>()?;
    let repo = crate::commands::workspace_github_target(&workspaces, workspace_id)?;
    let license = app.try_state::<crate::license::LicenseStore>()?;
    crate::commands::team_gate(&license).is_ok().then_some(repo)
}

/// TM-6: the card's pull request merged — the card is done and its copy
/// goes to the Trash, so this computer's marker comes off its issue. Only
/// a card this computer marked; nothing on a local board. Best-effort.
pub fn merged<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str, card: &KanbanCard) {
    if card.gh_claim.is_none() {
        return;
    }
    let (Some(repo), Some(store)) = (issues_repo(app, workspace_id), app.try_state::<KanbanStore>()) else {
        return;
    };
    let _github = crate::github_account::enter_for_app(app, workspace_id);
    crate::device_claim::release_card(&store, &repo, workspace_id, card);
}

/// The card whose copy is the folder `path` (named `dir_name`), when this
/// computer's marker is on its issue: asked before the copy is deleted, for
/// [`copy_deleted`] after it.
pub fn marked_owner(store: &KanbanStore, workspace_id: &str, dir_name: &str, path: &std::path::Path) -> Option<String> {
    let same = |p: &str| std::path::Path::new(p) == path;
    store
        .load(workspace_id)
        .ok()?
        .into_iter()
        .find(|c| c.gh_claim_here && (c.id == dir_name || c.worktree_path.as_deref().is_some_and(same)))
        .map(|c| c.id)
}

/// TM-6: the copy of the card `marked` ([`marked_owner`]) was deleted from
/// this computer, so this computer's marker comes off its issue — off the
/// caller's thread (the delete holds the cards' start lock; this is a
/// GitHub round trip). `None`: no card of that copy carried it.
pub fn copy_deleted<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str, marked: Option<String>) {
    let Some(card_id) = marked else {
        return;
    };
    let (app, workspace_id) = (app.clone(), workspace_id.to_string());
    std::thread::spawn(move || {
        let (Some(repo), Some(store)) = (issues_repo(&app, &workspace_id), app.try_state::<KanbanStore>()) else {
            return;
        };
        let Ok(card) = store.get_card(&workspace_id, &card_id) else {
            return;
        };
        if card.gh_claim.is_none() {
            return;
        }
        let _github = crate::github_account::enter_for_app(&app, &workspace_id);
        crate::device_claim::release_unless_copy_here(&store, &repo, &workspace_id, &card);
        crate::kanban::emit_kanban_changed(&app, &workspace_id);
    });
}

#[cfg(test)]
#[path = "leave_issue_tests.rs"]
mod tests;
