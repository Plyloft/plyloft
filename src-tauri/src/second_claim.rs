//! 1.175.0 (D1; review TM-1): two people on one card of a GitHub Issues
//! board.
//!
//! **Start build, a moment after a teammate.** Both read the issue with
//! nobody on it, both put their name on it, and both builds used to start,
//! each told "Claimed #161 and started the build". Now the claim reads the
//! issue again after it put the name on, and when another name is there too
//! it asks GitHub when each was put on ([`crate::github::issue_assignments`],
//! one more read, only then). Whoever finds a name put on before their own
//! is second ([`second_to`]): their own name comes off again
//! ([`crate::github::issue_remove_assignee_me`], D2's write), nothing
//! starts, and the window asks ([`after_claim`], `ClaimOutcome.raced`).
//! Both computers reach the same answer: on the same second, or when
//! GitHub doesn't say the order, the login later in the alphabet stops. A
//! read that fails lets the build start, as before. GitHub's timeline can
//! be a moment behind its own write: when this member's assignment isn't
//! in the answer yet, it is asked once more after a short wait
//! ([`TIMELINE_WAIT`]) before the fallback decides.
//!
//! **Ship it, when the teammate got there first.** Same card id and title
//! make the same branch name, so the second Ship's push was refused with
//! git's own words. Before anything is sent, Ship now reads the pull
//! requests that close the card's issue ([`crate::github::issue_delivery`])
//! and stops, naming the teammate's — open, or merged with the issue closed
//! ([`ship_refusal`]). Round 2: only a pull request of somebody inside the
//! repository (its owner, a member, a collaborator), or one from a branch
//! with the card's own branch name (the push would be refused anyway): a
//! bot's or an outside contributor's "Closes #n" never stops a member's
//! Ship. And a push the branch refuses names who pushed there when it is a
//! teammate ([`name_who_pushed`]) — on a card with no pull request of its
//! own; on the member's own pull request the branch is theirs, whoever
//! added to it. Each refusal is a sentence
//! the window turns into its own box (`src/lib/teammateWork.ts`); the raw
//! answer stays behind Details.

use crate::github::{Assignment, ClosingPullRequest, IssueDelivery};

fn same(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// Pure: who was on the issue before `me`, when someone was. `assignees`
/// are the names it carries now, `events` its assignments (oldest first).
///
/// For each other name: put on before mine → they are first; the same
/// second, or neither time known → the login earlier in the alphabet is
/// first; theirs known and mine not shown yet → they are first; mine known
/// and theirs not → I am. Of several, the earliest is named.
pub fn second_to(assignees: &[String], me: &str, events: &[Assignment]) -> Option<String> {
    let put_on = |login: &str| events.iter().rev().find(|e| e.assigned && same(&e.login, login)).map(|e| e.at_ms);
    let mine = put_on(me);
    let before_me = |other: &str| -> bool {
        match (put_on(other), mine) {
            (Some(theirs), Some(mine)) if theirs != mine => theirs < mine,
            (Some(_), None) => true,
            (None, Some(_)) => false,
            // The same second, or GitHub says neither: one rule for both.
            _ => other.to_lowercase() < me.to_lowercase(),
        }
    };
    assignees
        .iter()
        .filter(|a| !a.trim().is_empty() && !same(a, me) && before_me(a))
        .min_by_key(|a| (put_on(a).unwrap_or(i64::MIN), a.to_lowercase()))
        .cloned()
}

/// How long a claim waits before it asks once more for an assignment the
/// timeline doesn't show yet.
pub const TIMELINE_WAIT: std::time::Duration = std::time::Duration::from_millis(1500);

fn timeline_wait() -> std::time::Duration {
    if cfg!(test) {
        std::time::Duration::ZERO
    } else {
        TIMELINE_WAIT
    }
}

/// What a claim found right after it put the member's name on: a teammate
/// was there first.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Raced {
    /// Who claimed it first.
    pub first: String,
    /// The member's own name came off the issue again; `false`: GitHub
    /// refused, and the issue lists both.
    pub name_off: bool,
}

/// After this member's claim of an issue nobody held: `assignees` is what
/// the issue carries now. When a teammate's name was put on first, the
/// member's own comes off again and the claim didn't happen (`Some`);
/// `assignees` then says what the issue carries after that. `None`: the
/// member is alone on it, was first, or GitHub couldn't say (the build
/// starts as before 1.175.0).
pub fn after_claim(
    store: &crate::kanban::KanbanStore,
    repo: &str,
    workspace_id: &str,
    card_id: &str,
    number: u64,
    me: &str,
    assignees: &mut Vec<String>,
) -> Option<Raced> {
    if !assignees.iter().any(|a| !same(a, me)) {
        return None;
    }
    let mut events = match crate::github::issue_assignments(repo, number) {
        Ok(events) => events,
        Err(e) => {
            log::warn!("claim: reading who claimed {repo}#{number} first failed ({e}); the build starts");
            return None;
        }
    };
    // Round 2: the timeline can lag its own write. Without this member's
    // assignment in it, each of the two could read only the other's and
    // both would stop: ask once more, a moment later.
    if !events.iter().any(|e| e.assigned && same(&e.login, me)) {
        std::thread::sleep(timeline_wait());
        match crate::github::issue_assignments(repo, number) {
            Ok(again) => events = again,
            Err(e) => log::warn!("claim: the second reading of {repo}#{number}'s assignments failed ({e}); the first decides"),
        }
    }
    let first = second_to(assignees, me, &events)?;
    let name_off = match crate::github::issue_remove_assignee_me(repo, number) {
        Ok(()) => {
            assignees.retain(|a| !same(a, me));
            true
        }
        Err(e) => {
            // The issue lists both, and the sheet says so. D2-a: the next
            // Sync tries once more, unless the member claims it after all.
            log::warn!("claim: {repo}#{number}: the member's name wasn't taken off again ({e})");
            if let Err(e) = store.set_unassign_pending(workspace_id, card_id, true) {
                log::warn!("claim: marking {card_id} for the next Sync failed: {e}");
            }
            false
        }
    };
    log::info!("claim: {repo}#{number} was claimed by {first} a moment before; nothing starts here");
    Some(Raced { first, name_off })
}

/// Who holds the issue besides `me`, as a claim that didn't happen reports
/// it (the window asks before a second claim).
pub fn others(assignees: &[String], me: &str) -> crate::github::ClaimHolder {
    crate::github::ClaimHolder::Others { logins: assignees.iter().filter(|a| !same(a, me)).cloned().collect() }
}

// ── Ship ────────────────────────────────────────────────────────────────

/// Why Ship stops before it sends anything: a teammate's work for the same
/// issue is already on GitHub.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TeammateWork {
    /// Their pull request is open. `same_branch`: from a branch with the
    /// card's own branch name.
    Open { number: u64, login: String, url: String, same_branch: bool },
    /// Their pull request merged and the issue is closed.
    Merged { number: u64, login: String, url: String, issue: u64 },
}

/// Pure: the teammate's pull request that stops this card's Ship, from the
/// pull requests that close its issue. Never the card's own (`own_pr`, its
/// number), never one this member opened (their other computer), never one
/// whose author GitHub doesn't name. An open one first; a merged one only
/// once the issue is closed (work merged elsewhere may not be all of it).
///
/// Round 2: a teammate is somebody inside the repository — its owner, a
/// member of its organisation, a collaborator (`issue_text::outside`). A
/// bot's pull request, an outside contributor's or one whose author's
/// standing GitHub didn't give stops nothing, unless it comes from a branch
/// with the card's own name **in this repository**: there the push would be
/// refused anyway, and the box says why. Round 3: a fork's branch with that
/// name is another branch — the push here goes through, and anyone could
/// have stopped a card's Ship by naming a fork's branch after it.
/// The pull request comes from `branch` of this repository itself. A
/// fork's branch, and one GitHub didn't place, is not it.
fn same_branch(pr: &ClosingPullRequest, branch: &str) -> bool {
    pr.head_ref.as_deref() == Some(branch) && pr.cross_repository == Some(false)
}

pub fn teammate_work(
    delivery: &IssueDelivery,
    issue: u64,
    me: &str,
    branch: &str,
    own_pr: Option<u64>,
) -> Option<TeammateWork> {
    let theirs = |state: &str| {
        let mut found: Vec<(&ClosingPullRequest, &str)> = delivery
            .prs
            .iter()
            .filter(|pr| pr.state == state && Some(pr.number) != own_pr)
            .filter(|pr| {
                crate::issue_text::outside(pr.association.as_deref()) == Some(false) || same_branch(pr, branch)
            })
            .filter_map(|pr| pr.author.as_deref().filter(|a| !same(a, me)).map(|a| (pr, a)))
            .collect();
        // The newest: the one a teammate is working on now.
        found.sort_by_key(|(pr, _)| std::cmp::Reverse(pr.number));
        found.into_iter().next()
    };
    if let Some((pr, login)) = theirs("open") {
        return Some(TeammateWork::Open {
            number: pr.number,
            login: login.to_string(),
            url: pr.url.clone(),
            same_branch: same_branch(pr, branch),
        });
    }
    if !delivery.closed {
        return None;
    }
    theirs("merged").map(|(pr, login)| TeammateWork::Merged {
        number: pr.number,
        login: login.to_string(),
        url: pr.url.clone(),
        issue,
    })
}

/// What every refusal of this module ends its first part with; the window
/// reads the page to open after it (`teammateWork.ts`).
pub const NOTHING_SENT: &str = "Nothing was sent to GitHub.";

impl TeammateWork {
    /// The refusal, in the owner's words, then the pull request's page.
    pub fn refusal(&self) -> String {
        match self {
            TeammateWork::Open { number, login, url, same_branch } => format!(
                "Pull request #{number} by {login} is already open for this card{}. {NOTHING_SENT} {url}",
                if *same_branch { ", from a branch with the same name as yours" } else { "" }
            ),
            TeammateWork::Merged { number, login, url, issue } => format!(
                "Pull request #{number} by {login} was merged for this card, and issue #{issue} is closed. {NOTHING_SENT} {url}"
            ),
        }
    }
}

/// Ship, before its push, for a card of an issue on a GitHub Issues board
/// (`repo`): `Err` with the teammate's pull request when one stops it. A
/// card that already has its own pull request is past this (its push
/// updates that one). A read that fails stops nothing: Ship goes on as
/// before, and the push decides. The caller is inside the workspace's
/// GitHub account scope.
///
/// Team walk (TEAMFIX 6): `base` is the branch the card's pull request goes
/// to; when it isn't the repository's default, GitHub doesn't link "Closes
/// #N" and a second bounded read finds those pull requests.
pub fn ship_refusal(repo: &str, card: &crate::kanban::KanbanCard, branch: &str, base: &str) -> Result<(), String> {
    let Some(issue) = card.gh_issue_number else {
        return Ok(());
    };
    if card.pr_review.is_some() || crate::pr_status::pr_open_on_card(card) {
        return Ok(());
    }
    let read = crate::github::current_login().and_then(|me| Ok((crate::github::issue_delivery(repo, issue, Some(base))?, me)));
    let (delivery, me) = match read {
        Ok(read) => read,
        Err(e) => {
            log::warn!("ship: reading the pull requests of {repo}#{issue} failed ({e}); the push decides");
            return Ok(());
        }
    };
    let own_pr = card.pr.as_ref().map(|p| p.number);
    match teammate_work(&delivery, issue, &me, branch, own_pr) {
        Some(work) => Err(work.refusal()),
        None => Ok(()),
    }
}

/// Whether `error` is a push the branch on GitHub refused because it holds
/// commits this one doesn't (git's own words).
fn branch_moved(error: &str) -> bool {
    let e = error.to_ascii_lowercase();
    e.contains("(fetch first)") || e.contains("non-fast-forward") || e.contains("(stale info)")
}

/// Ship's push of the card's branch was refused (`error`). When the branch
/// on GitHub holds commits this card doesn't and a teammate wrote its
/// newest one, the refusal names them, with git's answer after it for
/// Details; otherwise `error` as it was (whose work it is isn't known).
/// `repo` is the pull request's repository; one bounded read, only here.
///
/// Round 2: only for a card with no pull request of its own. On the
/// member's own pull request the branch is theirs: a teammate who pressed
/// "Update branch" there didn't push work of their own for the card.
pub fn name_who_pushed(repo: Option<&str>, branch: &str, card: &crate::kanban::KanbanCard, error: String) -> String {
    if card.pr.is_some() || card.pr_url.is_some() {
        return error;
    }
    let Some(repo) = repo.filter(|_| branch_moved(&error)) else {
        return error;
    };
    let who = crate::github::current_login()
        .and_then(|me| Ok((crate::github::branch_tip_author(repo, branch)?, me)));
    match who {
        Ok((Some(login), me)) if !same(&login, &me) => format!(
            "{login} already pushed work for this card to GitHub, on a branch with the same name as yours. {NOTHING_SENT} https://github.com/{repo}/tree/{branch}\n{error}"
        ),
        Ok(_) => error,
        Err(e) => {
            log::warn!("ship: reading who pushed {repo}@{branch} failed ({e})");
            error
        }
    }
}

#[cfg(test)]
#[path = "second_claim_tests.rs"]
mod tests;
