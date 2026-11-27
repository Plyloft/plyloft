//! A teammate's pull requests on a GitHub-backed card (N14 item 4, U28): reads
//! only, through the `gh` chokepoint, team-gated, nothing stored.
use tauri::Manager;

use crate::commands::{team_gate, workspace_github_target};
use crate::kanban::KanbanStore;
use crate::workspace::WorkspaceStore;

/// N14 (item 4): the pull requests linked to the card's issue on GitHub —
/// a teammate's "Closes #21" — read from the issue's timeline as the
/// workspace's GitHub account. Display only and not stored: the card page
/// reads it when it opens. The card's own ship PR is left out; it has its
/// own place on the card.
#[tauri::command]
pub async fn kanban_card_linked_pull_requests(
    app: tauri::AppHandle,
    workspace_id: String,
    card_id: String,
) -> Result<Vec<crate::github::LinkedPullRequest>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        linked_pull_requests(
            &app.state::<KanbanStore>(),
            &app.state::<WorkspaceStore>(),
            &app.state::<crate::license::LicenseStore>(),
            &workspace_id,
            &card_id,
        )
    })
    .await
    .map_err(|e| format!("linked pull requests worker failed: {e}"))?
}

/// U28: which of the board's issues an open pull request closes, for the Board
/// tile: one read, display only and not stored. The Board asks after a read of
/// its issues.
#[tauri::command]
pub async fn kanban_open_pr_links(
    app: tauri::AppHandle,
    workspace_id: String,
) -> Result<Vec<crate::github::OpenPrLink>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        team_gate(&app.state::<crate::license::LicenseStore>())?;
        let workspaces = app.state::<WorkspaceStore>();
        let Some(repo) = workspace_github_target(&workspaces, &workspace_id) else {
            return Ok(Vec::new());
        };
        let _github = crate::github_account::enter_for_workspace(&workspaces, &workspace_id);
        crate::github::open_pr_links(&repo)
    })
    .await
    .map_err(|e| format!("open pull requests worker failed: {e}"))?
}

fn linked_pull_requests(
    store: &KanbanStore,
    workspaces: &WorkspaceStore,
    license: &crate::license::LicenseStore,
    workspace_id: &str,
    card_id: &str,
) -> Result<Vec<crate::github::LinkedPullRequest>, String> {
    team_gate(license)?;
    let card = store.get_card(workspace_id, card_id)?;
    let Some(number) = card.gh_issue_number else {
        return Ok(Vec::new());
    };
    let Some(repo) = workspace_github_target(workspaces, workspace_id) else {
        return Ok(Vec::new());
    };
    let _github = crate::github_account::enter_for_workspace(workspaces, workspace_id);
    let prs = crate::github::issue_linked_pull_requests(&repo, number)?;
    Ok(without_own_pull_request(&card, prs))
}

/// The card's own ship PR (its status, or the URL a ship recorded before
/// the status existed) is not a teammate's.
fn without_own_pull_request(
    card: &crate::kanban::KanbanCard,
    mut prs: Vec<crate::github::LinkedPullRequest>,
) -> Vec<crate::github::LinkedPullRequest> {
    let from_url = card
        .pr_url
        .as_deref()
        .and_then(|u| u.trim_end_matches('/').rsplit_once("/pull/"))
        .and_then(|(_, n)| n.parse::<u64>().ok());
    let own = [card.pr.as_ref().map(|pr| pr.number), from_url];
    prs.retain(|pr| !own.contains(&Some(pr.number)));
    prs
}

#[cfg(test)]
mod linked_pull_request_tests {
    use super::without_own_pull_request;
    use crate::github::LinkedPullRequest;
    use crate::kanban::{KanbanCard, KanbanColumnId};

    fn linked(number: u64) -> LinkedPullRequest {
        LinkedPullRequest {
            number,
            url: format!("https://github.com/o/r/pull/{number}"),
            state: "open".into(),
            draft: false,
            author: Some("test-user".into()),
        }
    }

    #[test]
    fn the_cards_own_ship_pull_request_is_not_a_teammates() {
        let mut card = KanbanCard::new("gh-issue-21".into(), "ws".into(), "t".into(), None, KanbanColumnId::Todo);
        let numbers = |card: &KanbanCard| {
            without_own_pull_request(card, vec![linked(23), linked(26)])
                .into_iter()
                .map(|p| p.number)
                .collect::<Vec<_>>()
        };
        assert_eq!(numbers(&card), vec![23, 26]);
        // A ship recorded only as its URL (before the PR status existed).
        card.pr_url = Some("https://github.com/o/r/pull/26/".into());
        assert_eq!(numbers(&card), vec![23]);
    }
}
