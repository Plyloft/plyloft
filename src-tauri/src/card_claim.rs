//! The claim of a card's issue on a GitHub Issues board (GH #66): who holds
//! it, this member's own name put on it, and this computer's marker
//! (1.173.0 C2). The commands that call these are in `commands.rs`
//! (`kanban_card_claim`, `kanban_card_claim_state`,
//! `kanban_card_device_claim`); moved out of it in 1.175.0 (round 2 of the
//! sharing lane) with nothing changed but where they live.

use serde::Serialize;

use crate::commands::{team_gate, workspace_github_target};
use crate::kanban::{KanbanCard, KanbanStore};
use crate::workspace::WorkspaceStore;

/// What [`kanban_card_claim`] did. `holder` is the claim as GitHub had it
/// *before* this call; `claimed` is false only when someone else holds it and
/// the caller did not confirm a second claim.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimOutcome {
    pub claimed: bool,
    pub holder: crate::github::ClaimHolder,
    pub card: KanbanCard,
    /// 1.175.0 (D1): a teammate claimed it a moment before; nothing was claimed.
    pub raced: Option<crate::second_claim::Raced>,
}

pub(crate) fn device_claim_card(
    store: &KanbanStore,
    workspaces: &WorkspaceStore,
    license: &crate::license::LicenseStore,
    workspace_id: &str,
    card_id: &str,
    how: crate::device_claim::ClaimHere,
) -> Result<KanbanCard, String> {
    team_gate(license)?;
    let repo = workspace_github_target(workspaces, workspace_id).ok_or_else(|| {
        format!("workspace '{workspace_id}' is not in GitHub-Issues sync mode")
    })?;
    let _github = crate::github_account::enter_for_workspace(workspaces, workspace_id);
    let card = store.get_card(workspace_id, card_id)?;
    let number = card
        .gh_issue_number
        .ok_or_else(|| "This card doesn't have a GitHub issue to claim yet.".to_string())?;
    // The login first: the issue read is then as fresh as it can be.
    let login = crate::github::current_login()
        .map_err(|e| format!("Couldn't read your GitHub login: {e}"))?;
    let issue = crate::github::issue_view(&repo, number)
        .map_err(|e| format!("Couldn't read who holds issue #{number}: {e}"))?;
    let after = crate::device_claim::claim_on_issue(&repo, &issue, &login, how, crate::issue_text::card_written_outside(&card))?;
    let mine = crate::device_claim::this_id_for(&repo);
    store.set_gh_claim(workspace_id, card_id, after, mine.as_deref())?;
    store.get_card(workspace_id, card_id)
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum ClaimMode {
    /// Read and record the holder only.
    ReadOnly,
    /// Assign `@me`; over someone else's claim only when `confirmed`.
    Claim { confirmed: bool },
}

pub(crate) fn claim_card(
    store: &KanbanStore,
    workspaces: &WorkspaceStore,
    license: &crate::license::LicenseStore,
    workspace_id: &str,
    card_id: &str,
    mode: ClaimMode,
) -> Result<ClaimOutcome, String> {
    team_gate(license)?;
    let repo = workspace_github_target(workspaces, workspace_id).ok_or_else(|| {
        format!("workspace '{workspace_id}' is not in GitHub-Issues sync mode")
    })?;
    // OB-7b: the claim is checked (and taken) as the workspace's account.
    let _github = crate::github_account::enter_for_workspace(workspaces, workspace_id);
    let card = store.get_card(workspace_id, card_id)?;
    let number = card
        .gh_issue_number
        .ok_or_else(|| "This card doesn't have a GitHub issue to claim yet.".to_string())?;
    // 1.175.0 (D2, round 2): the member wants the card — a name still owed
    // off its issue stays. Before the read below: a Sync's retry already on
    // its way finishes first, and this claim then sees the issue as it left it.
    let owed = matches!(mode, ClaimMode::Claim { .. }) && crate::leave_issue::taken_up(store, workspace_id, card_id);
    // Round 3: a claim that fails (the issue can't be read: no network)
    // took nothing up — the removal is owed again.
    claim_issue(store, &repo, workspace_id, card_id, &card, number, mode)
        .map_err(|e| crate::leave_issue::not_taken(store, workspace_id, card_id, owed, e))
}

/// [`claim_card`] from its reading of the issue on.
fn claim_issue(
    store: &KanbanStore,
    repo: &str,
    workspace_id: &str,
    card_id: &str,
    card: &KanbanCard,
    number: u64,
    mode: ClaimMode,
) -> Result<ClaimOutcome, String> {
    use crate::github::ClaimHolder;
    let issue = crate::github::issue_view(repo, number)
        .map_err(|e| format!("Couldn't read who holds issue #{number}: {e}"))?;
    // Who "me" is decides whether to assign, and `@me` is resolved by `gh`
    // as the account signed in *now*: the 60-second login cache could still
    // name the account before a `gh auth switch`. Re-asked on every call —
    // it also refreshes the cache the start gate reads right after.
    crate::github::invalidate_login_cache();
    let login = crate::github::current_login()
        .map_err(|e| format!("Couldn't read your GitHub login: {e}"))?;
    let mut assignees = crate::github::assignee_logins(&issue);
    let holder = crate::github::claim_holder(&assignees, &login);
    // 1.173.0 (C2, Challenger 3): the latest read of the issue, for its marker.
    let mut latest = issue.clone();
    let mut raced = None;
    let claimed = match (&holder, mode) {
        (ClaimHolder::Mine, _) => true,
        (_, ClaimMode::ReadOnly) => false,
        (ClaimHolder::Others { .. }, ClaimMode::Claim { confirmed: false }) => false,
        (before, ClaimMode::Claim { .. }) => {
            crate::github::issue_add_assignee(&repo, number, "@me")?;
            // Record what GitHub now says, not what we expect it to say.
            match crate::github::issue_view(&repo, number) {
                Ok(after) => {
                    assignees = crate::github::assignee_logins(&after);
                    latest = after;
                    // 1.175.0 (D1): nobody held it, and now a teammate does too —
                    // whoever came second takes their own name off again.
                    if *before == ClaimHolder::Unclaimed {
                        raced = crate::second_claim::after_claim(store, &repo, workspace_id, card_id, number, &login, &mut assignees);
                    }
                }
                Err(e) => {
                    log::warn!("claim: re-reading #{number} after assigning failed: {e}");
                    assignees.push(login.clone());
                }
            }
            raced.is_none()
        }
    };
    let holder = if raced.is_some() { crate::second_claim::others(&assignees, &login) } else { holder };
    store.set_gh_assignees(workspace_id, card_id, assignees)?;
    // 1.173.0 (C2): the claim says which computer took it — written when
    // this one claims (never over another computer's marker: Start asks
    // first), and read back on every claim read.
    // 1.175.0 (B3): a marker an outsider wrote into the issue is no claim.
    let outside = crate::issue_text::card_written_outside(&card);
    let device = if claimed && matches!(mode, ClaimMode::Claim { .. }) {
        crate::device_claim::claim_on_issue(&repo, &latest, &login, crate::device_claim::ClaimHere::IfFree, outside)
            .unwrap_or_else(|e| {
                log::warn!("claim: writing #{number}'s claim marker failed: {e}");
                crate::issue_text::claim_in(&latest.body, outside)
            })
    } else {
        crate::issue_text::claim_in(&latest.body, outside)
    };
    let mine = crate::device_claim::this_id_for(&repo);
    if let Err(e) = store.set_gh_claim(workspace_id, card_id, device, mine.as_deref()) {
        log::warn!("claim: recording #{number}'s claim marker failed: {e}");
    }
    // N14 (item 6): the same read says who opened the issue.
    if let Some(author) = crate::github::author_login(&issue) {
        if let Err(e) = store.set_gh_author(workspace_id, card_id, Some(author)) {
            log::warn!("claim: recording #{number}'s author failed: {e}");
        }
    }
    Ok(ClaimOutcome { claimed, holder, raced, card: store.get_card(workspace_id, card_id)? })
}
