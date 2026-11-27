use super::*;
use crate::card_claim::{claim_card, ClaimMode, ClaimOutcome};
use crate::github::{self, ClaimHolder};
use crate::kanban::{KanbanCard, KanbanColumnId, KanbanStore};

const REPO: &str = "o/r";
const ASSIGN: &str = "--add-assignee @me";
const REMOVE: &str = "--remove-assignee @me";

fn names(l: &[&str]) -> Vec<String> {
    l.iter().map(|s| s.to_string()).collect()
}

fn put_on(login: &str, at_ms: i64) -> Assignment {
    Assignment { login: login.into(), at_ms, assigned: true }
}

/// D1: who is second, from the times GitHub gives — and one rule both
/// computers reach when it gives none.
#[test]
fn whoever_finds_a_name_put_on_before_their_own_is_second() {
    let both = names(&["matteo", "giulia"]);
    // Alone on the issue: nobody was first.
    assert_eq!(second_to(&names(&["matteo"]), "matteo", &[put_on("matteo", 10)]), None);
    // The teammate's name was put on first, whatever the order of the list.
    assert_eq!(second_to(&both, "matteo", &[put_on("giulia", 10_000), put_on("matteo", 12_000)]), Some("giulia".into()));
    assert_eq!(second_to(&both, "giulia", &[put_on("giulia", 10_000), put_on("matteo", 12_000)]), None, "the first goes on");
    // …and after mine: I was first.
    assert_eq!(second_to(&both, "matteo", &[put_on("matteo", 10_000), put_on("giulia", 12_000)]), None);
    // The same second: the login later in the alphabet stops, on both sides.
    let tie = [put_on("matteo", 10_000), put_on("giulia", 10_000)];
    assert_eq!(second_to(&both, "matteo", &tie), Some("giulia".into()));
    assert_eq!(second_to(&both, "giulia", &tie), None);
    assert_eq!(second_to(&names(&["Anna", "giulia"]), "anna", &[put_on("Anna", 5), put_on("giulia", 5)]), None, "case doesn't matter");
    // GitHub says neither time: the same rule.
    assert_eq!(second_to(&both, "matteo", &[]), Some("giulia".into()));
    assert_eq!(second_to(&both, "giulia", &[]), None);
    // Theirs is known and mine isn't shown yet: they were first; the other
    // way round, I was. Exactly one of the two stops.
    assert_eq!(second_to(&both, "matteo", &[put_on("giulia", 10_000)]), Some("giulia".into()));
    assert_eq!(second_to(&both, "giulia", &[put_on("giulia", 10_000)]), None);
    // A name taken off and put on again counts from when it was put on last.
    let again = [
        put_on("giulia", 1_000),
        Assignment { login: "giulia".into(), at_ms: 2_000, assigned: false },
        put_on("matteo", 10_000),
        put_on("giulia", 12_000),
    ];
    assert_eq!(second_to(&both, "matteo", &again), None);
    // Three people: the earliest is the one named.
    let three = names(&["matteo", "bob", "giulia"]);
    let events = [put_on("giulia", 8_000), put_on("bob", 9_000), put_on("matteo", 10_000)];
    assert_eq!(second_to(&three, "matteo", &events), Some("giulia".into()));
    assert_eq!(second_to(&three, "bob", &events), Some("giulia".into()));
    assert_eq!(second_to(&three, "giulia", &events), None);
}

#[test]
fn the_assignments_are_read_from_the_issues_timeline() {
    let json = serde_json::json!({"data": {"repository": {"issue": {"timelineItems": {"nodes": [
        {"__typename": "AssignedEvent", "createdAt": "2026-11-09T10:00:01Z", "assignee": {"__typename": "User", "login": "giulia"}},
        {"__typename": "UnassignedEvent", "createdAt": "2026-11-09T10:00:02Z", "assignee": {"__typename": "User", "login": "giulia"}},
        {"__typename": "AssignedEvent", "createdAt": "2026-11-09T10:00:03Z", "assignee": {"__typename": "Bot", "login": "helper"}},
        // A deleted account, a time that can't be read: left out.
        {"__typename": "AssignedEvent", "createdAt": "2026-11-09T10:00:04Z", "assignee": null},
        {"__typename": "AssignedEvent", "createdAt": "not a time", "assignee": {"login": "bob"}}
    ]}}}}})
    .to_string();
    let read = assignments_of(&json);
    assert_eq!(read.iter().map(|a| (a.login.as_str(), a.assigned)).collect::<Vec<_>>(), [("giulia", true), ("giulia", false), ("helper", true)]);
    assert_eq!(read[1].at_ms - read[0].at_ms, 1_000, "to the second");
    assert!(github::assignments_from_issue(r#"{"errors":[{"message":"Could not resolve to an Issue"}]}"#).is_err());
    assert!(github::assignments_from_issue(r#"{"data":{"repository":{"issue":null}}}"#).is_err(), "no answer is not 'nobody'");
}

fn assignments_of(json: &str) -> Vec<Assignment> {
    github::assignments_from_issue(json).unwrap()
}

// ── claim_card ──────────────────────────────────────────────────────────

struct Board {
    _tmp: tempfile::TempDir,
    store: KanbanStore,
    workspaces: crate::workspace::WorkspaceStore,
    license: crate::license::LicenseStore,
    ws: String,
}

fn board() -> Board {
    let tmp = tempfile::tempdir().unwrap();
    let config = tmp.path().join("config");
    let repo = tmp.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let workspaces = crate::workspace::WorkspaceStore::new(config.clone()).unwrap();
    let ws = workspaces.create("GH board".into(), repo.to_string_lossy().into_owned()).unwrap().id;
    workspaces.set_kanban_sync(&ws, crate::workspace::KanbanSyncMode::GitHubIssues, Some(REPO.into())).unwrap();
    let store = KanbanStore::new(config.clone()).unwrap();
    let mut card = KanbanCard::new("gh-issue-161".into(), ws.clone(), "Fix login redirect".into(), None, KanbanColumnId::Todo);
    card.gh_issue_number = Some(161);
    store.create_card(&ws, card).unwrap();
    Board { license: crate::license::LicenseStore::new_team_allowed_for_test(config), _tmp: tmp, store, workspaces, ws }
}

fn issue_json(assignees: &[&str]) -> Result<String, String> {
    let assignees: Vec<_> = assignees.iter().map(|l| serde_json::json!({"login": l})).collect();
    Ok(serde_json::json!({
        "number": 161, "title": "Fix login redirect", "body": "", "state": "OPEN",
        "assignees": assignees, "labels": [{"name": "status:todo"}], "updatedAt": ""
    })
    .to_string())
}

/// The timeline's answer: each name put on at its second.
fn timeline(put_on: &[(&str, u32)]) -> Result<String, String> {
    let nodes: Vec<_> = put_on
        .iter()
        .map(|(login, second)| {
            serde_json::json!({"__typename": "AssignedEvent", "createdAt": format!("2026-11-09T10:00:{second:02}Z"),
                "assignee": {"__typename": "User", "login": login}})
        })
        .collect();
    Ok(serde_json::json!({"data": {"repository": {"issue": {"timelineItems": {"nodes": nodes}}}}}).to_string())
}

fn ok() -> Result<String, String> {
    Ok(String::new())
}

/// D2, round 3 (finding 6): a claim says "wanted again" before it reads the
/// issue, which drops a name still owed off it. When that reading fails —
/// no network — nothing was taken up: the removal is owed again, and the
/// next Sync makes it. A claim that goes through keeps the name.
#[test]
fn a_claim_that_fails_still_owes_the_name_off_the_issue() {
    let _serial = github::test_serial_lock();
    let b = board();
    let owed = || b.store.get_card(&b.ws, "gh-issue-161").unwrap().unassign_pending;
    let offline = |mode: ClaimMode| {
        crate::device_claim::set_test_device(None);
        github::invalidate_login_cache();
        github::take_test_gh_invocations();
        github::set_test_gh_responses(vec![Err("error connecting to api.github.com".into())]);
        let failed = claim_card(&b.store, &b.workspaces, &b.license, &b.ws, "gh-issue-161", mode);
        github::clear_test_gh_responses();
        github::take_test_gh_invocations();
        failed.err().expect("the issue couldn't be read")
    };
    b.store.set_unassign_pending(&b.ws, "gh-issue-161", true).unwrap();
    assert!(offline(ClaimMode::Claim { confirmed: false }).contains("Couldn't read who holds issue #161"));
    assert!(owed(), "the claim failed: the name is still owed off the issue");
    // Reading who holds it never touched the mark.
    offline(ClaimMode::ReadOnly);
    assert!(owed());
    // The claim goes through (the name is still on the issue): it stays.
    let (outcome, _) = claim_as(&b, "matteo", false, &["matteo"], vec![]);
    assert!(outcome.claimed);
    assert!(!owed(), "wanted again");
    // And a failure marks nothing on a card that owed nothing.
    offline(ClaimMode::Claim { confirmed: false });
    assert!(!owed());
}

/// A Start build's claim as `me`, with gh answering `answers` after the
/// first read (nobody on the issue) and the login. Returns the outcome and
/// what gh was asked, each call on a line.
fn claim_as(b: &Board, me: &str, confirmed: bool, first_read: &[&str], answers: Vec<Result<String, String>>) -> (ClaimOutcome, Vec<String>) {
    crate::device_claim::set_test_device(None);
    github::invalidate_login_cache();
    github::take_test_gh_invocations();
    let mut all = vec![issue_json(first_read), Ok(me.to_string())];
    all.extend(answers);
    github::set_test_gh_responses(all);
    let outcome = claim_card(&b.store, &b.workspaces, &b.license, &b.ws, "gh-issue-161", ClaimMode::Claim { confirmed }).unwrap();
    let calls = github::take_test_gh_invocations().iter().map(|c| c.join(" ")).collect();
    github::clear_test_gh_responses();
    github::invalidate_login_cache();
    (outcome, calls)
}

fn count(calls: &[String], what: &str) -> usize {
    calls.iter().filter(|c| c.contains(what)).count()
}

/// D1: the reading after the claim shows only this member — the build
/// starts, and GitHub isn't asked who was first.
#[test]
fn alone_on_the_issue_after_the_claim_the_build_starts() {
    let _serial = github::test_serial_lock();
    let b = board();
    let (out, calls) = claim_as(&b, "matteo", false, &[], vec![ok(), issue_json(&["matteo"])]);
    assert!(out.claimed);
    assert_eq!(out.raced, None);
    assert_eq!(out.holder, ClaimHolder::Unclaimed, "who held it before");
    assert_eq!((count(&calls, ASSIGN), count(&calls, "graphql"), count(&calls, REMOVE)), (1, 0, 0), "{calls:?}");
    assert_eq!(out.card.gh_assignees, names(&["matteo"]));
}

/// D1: a teammate's name was put on a moment before — this member's own
/// comes off again, nothing is claimed, and the outcome names the teammate.
#[test]
fn a_teammate_put_on_first_stops_the_second_and_takes_their_name_off() {
    let _serial = github::test_serial_lock();
    let b = board();
    let (out, calls) = claim_as(
        &b,
        "matteo",
        false,
        &[],
        vec![ok(), issue_json(&["giulia", "matteo"]), timeline(&[("giulia", 1), ("matteo", 3)]), ok()],
    );
    assert!(!out.claimed, "the build doesn't start");
    assert_eq!(out.raced, Some(Raced { first: "giulia".into(), name_off: true }));
    assert_eq!(out.holder, ClaimHolder::Others { logins: names(&["giulia"]) });
    assert_eq!(out.card.gh_assignees, names(&["giulia"]), "as the issue is now");
    assert!(!out.card.unassign_pending);
    // The order: my name on, the read, who was first, my name off — and
    // only `@me` is ever taken off.
    let writes: Vec<&String> = calls.iter().filter(|c| c.starts_with("issue edit") || c.contains("graphql")).collect();
    assert_eq!(writes.len(), 3, "{calls:?}");
    assert!(writes[0].contains(ASSIGN) && writes[1].contains("graphql") && writes[2].ends_with(REMOVE), "{calls:?}");
    assert!(!writes[2].contains("giulia"));
    // No marker of this computer went on a card it didn't claim.
    assert!(!calls.iter().any(|c| c.contains("--body-file")), "{calls:?}");
}

/// D1: this member's name was put on first — the build starts; the
/// teammate's computer is the one that stops.
#[test]
fn a_teammate_put_on_after_leaves_the_first_to_build() {
    let _serial = github::test_serial_lock();
    let b = board();
    let (out, calls) = claim_as(
        &b,
        "matteo",
        false,
        &[],
        vec![ok(), issue_json(&["matteo", "giulia"]), timeline(&[("matteo", 1), ("giulia", 3)])],
    );
    assert!(out.claimed);
    assert_eq!(out.raced, None);
    assert_eq!((count(&calls, "graphql"), count(&calls, REMOVE)), (1, 0), "{calls:?}");
    assert_eq!(out.card.gh_assignees, names(&["matteo", "giulia"]), "the card says both");
}

/// D1: the same second — the login later in the alphabet stops, so exactly
/// one of the two builds starts.
#[test]
fn on_the_same_second_the_login_later_in_the_alphabet_stops() {
    let _serial = github::test_serial_lock();
    let same_second = || timeline(&[("matteo", 5), ("giulia", 5)]);
    let b = board();
    let (out, calls) = claim_as(&b, "matteo", false, &[], vec![ok(), issue_json(&["matteo", "giulia"]), same_second(), ok()]);
    assert_eq!(out.raced.map(|r| r.first), Some("giulia".into()));
    assert_eq!(count(&calls, REMOVE), 1);
    let b = board();
    let (out, calls) = claim_as(&b, "giulia", false, &[], vec![ok(), issue_json(&["matteo", "giulia"]), same_second()]);
    assert!(out.claimed && out.raced.is_none(), "giulia goes on");
    assert_eq!(count(&calls, REMOVE), 0);
}

/// D1 (1.5): GitHub refuses to take the name off again — nothing starts all
/// the same, the outcome says the issue lists both, and the next Sync tries
/// once more (D2-a).
#[test]
fn a_refused_withdrawal_still_stops_the_build_and_says_the_issue_lists_both() {
    let _serial = github::test_serial_lock();
    let b = board();
    let (out, _calls) = claim_as(
        &b,
        "matteo",
        false,
        &[],
        vec![ok(), issue_json(&["giulia", "matteo"]), timeline(&[("giulia", 1), ("matteo", 3)]), Err("HTTP 502".into())],
    );
    assert!(!out.claimed);
    assert_eq!(out.raced, Some(Raced { first: "giulia".into(), name_off: false }));
    assert_eq!(out.holder, ClaimHolder::Others { logins: names(&["giulia"]) }, "the teammate, not this member");
    assert_eq!(out.card.gh_assignees, names(&["giulia", "matteo"]), "as GitHub still has it");
    assert!(out.card.unassign_pending, "the next Sync tries again");

    // "Claim it too" after that: the name is still on, it stays, and
    // nothing is owed any more.
    let (out, calls) = claim_as(&b, "matteo", true, &["giulia", "matteo"], vec![]);
    assert!(out.claimed && out.raced.is_none());
    assert_eq!(count(&calls, ASSIGN), 0, "already on it");
    assert!(!out.card.unassign_pending, "wanted again: the mark drops");
}

/// D1 (1.5): without an answer nobody can be said to be there — a re-read
/// that fails, or a timeline that can't be read, lets the build start.
#[test]
fn a_reading_that_fails_lets_the_build_start_as_before() {
    let _serial = github::test_serial_lock();
    let b = board();
    let (out, calls) = claim_as(&b, "matteo", false, &[], vec![ok(), Err("error connecting to api.github.com".into())]);
    assert!(out.claimed && out.raced.is_none());
    assert_eq!((count(&calls, "graphql"), count(&calls, REMOVE)), (0, 0), "{calls:?}");
    assert_eq!(out.card.gh_assignees, names(&["matteo"]));

    let b = board();
    let (out, calls) =
        claim_as(&b, "matteo", false, &[], vec![ok(), issue_json(&["giulia", "matteo"]), Err("HTTP 502".into())]);
    assert!(out.claimed && out.raced.is_none());
    assert_eq!((count(&calls, "graphql"), count(&calls, REMOVE)), (1, 0), "{calls:?}");
    assert_eq!(out.card.gh_assignees, names(&["giulia", "matteo"]), "the next read of the Board says both");
}

/// D1: "Claim it too" is the member's own choice — a confirmed second
/// claim is never undone, and GitHub isn't asked who was first.
#[test]
fn a_confirmed_second_claim_is_never_taken_back() {
    let _serial = github::test_serial_lock();
    let b = board();
    let (out, calls) = claim_as(&b, "matteo", true, &["giulia"], vec![ok(), issue_json(&["giulia", "matteo"])]);
    assert!(out.claimed && out.raced.is_none());
    assert_eq!((count(&calls, ASSIGN), count(&calls, "graphql"), count(&calls, REMOVE)), (1, 0, 0), "{calls:?}");
    // And an unconfirmed claim of a held issue assigns nobody, as before.
    let (out, calls) = claim_as(&b, "matteo", false, &["giulia"], vec![]);
    assert!(!out.claimed && out.raced.is_none());
    assert_eq!(count(&calls, ASSIGN), 0);
}

// ── Ship ────────────────────────────────────────────────────────────────

const BRANCH: &str = "plyloft/card-ghissue161-fix-login-redirect";

/// A collaborator's pull request.
fn pr(number: u64, state: &str, author: Option<&str>, head: &str) -> ClosingPullRequest {
    pr_of(number, state, author, head, Some("COLLABORATOR"))
}

fn pr_of(number: u64, state: &str, author: Option<&str>, head: &str, association: Option<&str>) -> ClosingPullRequest {
    ClosingPullRequest {
        number,
        url: format!("https://github.com/{REPO}/pull/{number}"),
        state: state.into(),
        author: author.map(str::to_string),
        head_ref: Some(head.into()),
        association: association.map(str::to_string),
        cross_repository: Some(false),
    }
}

fn delivery(closed: bool, prs: Vec<ClosingPullRequest>) -> IssueDelivery {
    IssueDelivery { closed, prs, ..Default::default() }
}

/// D1 (1.4): the teammate's pull request that stops Ship — open, or merged
/// once the issue is closed; never this member's own.
#[test]
fn ship_stops_on_a_teammates_pull_request_for_the_same_issue() {
    let work = |d: &IssueDelivery| teammate_work(d, 161, "matteo", BRANCH, None);
    let open = work(&delivery(false, vec![pr(178, "open", Some("example-teammate"), BRANCH)])).unwrap();
    assert_eq!(
        open.refusal(),
        "Pull request #178 by example-teammate is already open for this card, from a branch with the same name as yours. \
         Nothing was sent to GitHub. https://github.com/o/r/pull/178"
    );
    // From a branch of another name: stopped the same, without that clause.
    let other = work(&delivery(false, vec![pr(178, "open", Some("example-teammate"), "giulia/login")])).unwrap();
    assert_eq!(
        other.refusal(),
        "Pull request #178 by example-teammate is already open for this card. Nothing was sent to GitHub. https://github.com/o/r/pull/178"
    );
    // Merged, and the issue is closed.
    let merged = work(&delivery(true, vec![pr(178, "merged", Some("example-teammate"), BRANCH)])).unwrap();
    assert_eq!(
        merged.refusal(),
        "Pull request #178 by example-teammate was merged for this card, and issue #161 is closed. \
         Nothing was sent to GitHub. https://github.com/o/r/pull/178"
    );
    // Merged while the issue is still open: more may be wanted — Ship goes on.
    assert_eq!(work(&delivery(false, vec![pr(178, "merged", Some("example-teammate"), BRANCH)])), None);
    // An open one comes before a merged one; of two, the newest.
    let both = delivery(true, vec![pr(170, "merged", Some("bob"), "x"), pr(175, "open", Some("bob"), "y"), pr(178, "open", Some("example-teammate"), BRANCH)]);
    assert!(matches!(work(&both), Some(TeammateWork::Open { number: 178, .. })));
    // This member's own (their other computer, any case), one closed
    // without merging, one whose author is gone: nothing stops.
    assert_eq!(work(&delivery(false, vec![pr(178, "open", Some("Matteo"), BRANCH)])), None);
    assert_eq!(work(&delivery(true, vec![pr(178, "closed", Some("example-teammate"), BRANCH)])), None);
    assert_eq!(work(&delivery(false, vec![pr(178, "open", None, BRANCH)])), None);
    // The card's own pull request is never a teammate's.
    let d = delivery(false, vec![pr(178, "open", Some("example-teammate"), BRANCH)]);
    assert_eq!(teammate_work(&d, 161, "matteo", BRANCH, Some(178)), None);
}

/// Round 2 (major): only somebody inside the repository stops Ship. A
/// bot's "Closes #161", an outside contributor's on a public repository, an
/// abandoned one of theirs — none blocks a member, open or merged. The one
/// exception is a branch with the card's own name, where the push would be
/// refused anyway.
#[test]
fn a_bots_or_an_outsiders_pull_request_never_stops_ship() {
    let work = |d: &IssueDelivery| teammate_work(d, 161, "matteo", BRANCH, None);
    for inside in ["OWNER", "MEMBER", "COLLABORATOR"] {
        let d = delivery(false, vec![pr_of(178, "open", Some("example-teammate"), "giulia/login", Some(inside))]);
        assert!(matches!(work(&d), Some(TeammateWork::Open { number: 178, same_branch: false, .. })), "{inside}");
    }
    for outside in [Some("NONE"), Some("CONTRIBUTOR"), Some("FIRST_TIME_CONTRIBUTOR"), Some("MANNEQUIN"), None] {
        // A bot (dependabot, renovate) reads as NONE or CONTRIBUTOR; an
        // unknown standing is not called a teammate either.
        for author in ["dependabot[bot]", "drive-by-dev"] {
            let open = delivery(false, vec![pr_of(178, "open", Some(author), "dependabot/npm/x", outside)]);
            assert_eq!(work(&open), None, "{author} {outside:?}");
            let merged = delivery(true, vec![pr_of(178, "merged", Some(author), "dependabot/npm/x", outside)]);
            assert_eq!(work(&merged), None, "{author} {outside:?} merged");
        }
    }
    // An outsider's pull request beside a collaborator's: the collaborator's stops it.
    let both = delivery(
        false,
        vec![pr_of(180, "open", Some("drive-by-dev"), "fork/x", Some("NONE")), pr_of(178, "open", Some("example-teammate"), "g/y", Some("MEMBER"))],
    );
    assert!(matches!(work(&both), Some(TeammateWork::Open { number: 178, .. })));
    // The card's own branch name, whoever opened it: the push would fail,
    // so Ship says why before it tries.
    let same = delivery(false, vec![pr_of(181, "open", Some("drive-by-dev"), BRANCH, Some("NONE"))]);
    assert_eq!(
        work(&same).unwrap().refusal(),
        "Pull request #181 by drive-by-dev is already open for this card, from a branch with the same name as yours. \
         Nothing was sent to GitHub. https://github.com/o/r/pull/181"
    );
    // Round 3: the same name on a fork's branch is another branch — it
    // stops nothing (the push here goes through); nor does one GitHub
    // didn't place. A collaborator's from a fork still stops Ship, as any
    // of theirs does, without the "same name" words.
    for elsewhere in [Some(true), None] {
        let fork = ClosingPullRequest { cross_repository: elsewhere, ..pr_of(181, "open", Some("drive-by-dev"), BRANCH, Some("NONE")) };
        assert_eq!(work(&delivery(false, vec![fork.clone()])), None, "{elsewhere:?}");
        let merged = ClosingPullRequest { state: "merged".into(), ..fork };
        assert_eq!(work(&delivery(true, vec![merged])), None, "{elsewhere:?} merged");
    }
    let theirs = ClosingPullRequest { cross_repository: Some(true), ..pr_of(182, "open", Some("example-teammate"), BRANCH, Some("MEMBER")) };
    assert!(matches!(work(&delivery(false, vec![theirs])), Some(TeammateWork::Open { number: 182, same_branch: false, .. })));
    // The query asks GitHub for the standing and for where the branch is,
    // and the answer is read.
    let json = serde_json::json!({"data": {"repository": {"issue": {"state": "OPEN", "closedByPullRequestsReferences": {"nodes": [
        {"number": 178, "url": "u", "state": "OPEN", "headRefName": "b", "isCrossRepository": true, "authorAssociation": "MEMBER", "author": {"login": "giulia"}},
        {"number": 179, "url": "u", "state": "OPEN", "headRefName": "b", "author": {"login": "old-gh"}}
    ]}}}}})
    .to_string();
    let read = github::issue_delivery_from(&json, REPO).unwrap();
    assert_eq!(read.prs[0].association.as_deref(), Some("MEMBER"));
    assert_eq!((read.prs[0].cross_repository, read.prs[1].cross_repository), (Some(true), None));
    assert!(include_str!("github.rs").contains("headRefName isCrossRepository authorAssociation author{login}"));
}

/// Round 2: GitHub's timeline can be a moment behind its own write. When
/// this member's assignment isn't in the answer yet, it is asked once more
/// before anything is decided — else each of the two could see only the
/// other's and both would stop.
#[test]
fn a_timeline_without_my_assignment_is_read_once_more() {
    let _serial = github::test_serial_lock();
    // The second answer has both: this member was first, and builds.
    let b = board();
    let (out, calls) = claim_as(
        &b,
        "matteo",
        false,
        &[],
        vec![ok(), issue_json(&["matteo", "giulia"]), timeline(&[("giulia", 3)]), timeline(&[("matteo", 1), ("giulia", 3)])],
    );
    assert!(out.claimed && out.raced.is_none(), "{:?}", out.raced);
    assert_eq!((count(&calls, "graphql"), count(&calls, REMOVE)), (2, 0), "{calls:?}");
    // Still not there: what is known decides (theirs is, so they were first).
    let b = board();
    let (out, calls) = claim_as(
        &b,
        "matteo",
        false,
        &[],
        vec![ok(), issue_json(&["matteo", "giulia"]), timeline(&[("giulia", 3)]), timeline(&[("giulia", 3)]), ok()],
    );
    assert_eq!(out.raced.map(|r| r.first), Some("giulia".into()));
    assert_eq!((count(&calls, "graphql"), count(&calls, REMOVE)), (2, 1), "{calls:?}");
    // The second reading fails: the first decides.
    let b = board();
    let (out, calls) = claim_as(
        &b,
        "matteo",
        false,
        &[],
        vec![ok(), issue_json(&["matteo", "giulia"]), timeline(&[("giulia", 3)]), Err("HTTP 502".into()), ok()],
    );
    assert!(out.raced.is_some());
    assert_eq!(count(&calls, "graphql"), 2, "{calls:?}");
    // With it in the first answer nothing is asked twice, and the wait a
    // person would notice is a second and a half at most.
    let b = board();
    let (_, calls) = claim_as(&b, "matteo", false, &[], vec![ok(), issue_json(&["matteo", "giulia"]), timeline(&[("matteo", 1), ("giulia", 3)])]);
    assert_eq!(count(&calls, "graphql"), 1);
    assert!(TIMELINE_WAIT <= std::time::Duration::from_secs(2));
}

fn issue_card() -> KanbanCard {
    let mut card = KanbanCard::new("gh-issue-161".into(), "ws".into(), "Fix login redirect".into(), None, KanbanColumnId::Complete);
    card.gh_issue_number = Some(161);
    card
}

fn delivery_json(state: &str, prs: serde_json::Value) -> Result<String, String> {
    Ok(serde_json::json!({"data": {"repository": {"defaultBranchRef": {"name": "main"}, "issue": {"state": state, "closedByPullRequestsReferences": {"nodes": prs}}}}}).to_string())
}

fn asked(responses: Vec<Result<String, String>>, run: impl FnOnce() -> Result<(), String>) -> (Result<(), String>, Vec<String>) {
    github::invalidate_login_cache();
    github::take_test_gh_invocations();
    github::set_test_gh_responses(responses);
    let out = run();
    let calls = github::take_test_gh_invocations().iter().map(|c| c.join(" ")).collect();
    github::clear_test_gh_responses();
    github::invalidate_login_cache();
    (out, calls)
}

/// D1: Ship reads the pull requests that close the card's issue before it
/// sends anything; a read that fails stops nothing, and a card that isn't
/// of an issue, or already has its own pull request, isn't read at all.
#[test]
fn ship_reads_before_it_sends_and_a_failed_read_stops_nothing() {
    let _serial = github::test_serial_lock();
    let theirs = serde_json::json!([
        {"number": 178, "url": "https://github.com/o/r/pull/178", "state": "OPEN", "headRefName": BRANCH, "isCrossRepository": false,
         "authorAssociation": "COLLABORATOR", "author": {"login": "example-teammate"}, "repository": {"nameWithOwner": "O/R"}},
        // Another repository's pull request is not this board's.
        {"number": 9, "url": "https://github.com/x/y/pull/9", "state": "OPEN", "headRefName": "z",
         "author": {"login": "eve"}, "repository": {"nameWithOwner": "x/y"}}
    ]);
    let (out, calls) = asked(vec![Ok("matteo".into()), delivery_json("OPEN", theirs.clone())], || ship_refusal(REPO, &issue_card(), BRANCH, "main"));
    assert!(out.unwrap_err().starts_with("Pull request #178 by example-teammate is already open for this card, from a branch"));
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert!(calls[1].starts_with("api graphql") && calls[1].contains("number=161"), "{calls:?}");
    assert!(!calls.iter().any(|c| c.contains("push") || c.starts_with("pr ")), "read only");

    // Nobody else's pull request: Ship goes on.
    let (out, _) = asked(vec![Ok("matteo".into()), delivery_json("OPEN", serde_json::json!([]))], || ship_refusal(REPO, &issue_card(), BRANCH, "main"));
    assert_eq!(out, Ok(()));
    // The read fails, or the login does: the push decides, as before.
    let (out, _) = asked(vec![Ok("matteo".into()), Err("HTTP 502".into())], || ship_refusal(REPO, &issue_card(), BRANCH, "main"));
    assert_eq!(out, Ok(()));
    let (out, calls) = asked(vec![Err("gh: not logged in".into())], || ship_refusal(REPO, &issue_card(), BRANCH, "main"));
    assert_eq!(out, Ok(()));
    assert_eq!(calls.len(), 1, "{calls:?}");

    // Not read at all: a local card, a card whose own pull request is open.
    let mut local = issue_card();
    local.gh_issue_number = None;
    let mut shipped = issue_card();
    shipped.pr_url = Some("https://github.com/o/r/pull/150".into());
    shipped.pr = Some(crate::pr_status::PrStatus { number: 150, ..Default::default() });
    for card in [local, shipped] {
        let (out, calls) = asked(vec![], || ship_refusal(REPO, &card, BRANCH, "main"));
        assert_eq!(out, Ok(()));
        assert!(calls.is_empty(), "{calls:?}");
    }

    // The answer's shape: the issue's state, and an error said as one.
    let read = github::issue_delivery_from(&delivery_json("CLOSED", theirs).unwrap(), REPO).unwrap();
    assert!(read.closed);
    assert_eq!(read.prs, vec![pr(178, "open", Some("example-teammate"), BRANCH)]);
    assert!(github::issue_delivery_from(r#"{"data":{"repository":{"issue":null}}}"#, REPO).is_err());
}

/// D1 (1.4, third case): the push was refused because the branch on GitHub
/// holds commits this card doesn't — a teammate's are named; this member's
/// own, or nobody GitHub knows, leave the words as they were.
#[test]
fn a_refused_push_names_the_teammate_who_pushed_the_branch() {
    let _serial = github::test_serial_lock();
    const MOVED: &str = "couldn't push the branch to the remote:  ! [rejected] abc -> plyloft/card (fetch first)";
    let run = |error: &str, responses: Vec<Result<String, String>>| {
        let mut out = String::new();
        let (_, calls) = asked(responses, || {
            out = name_who_pushed(Some(REPO), BRANCH, &issue_card(), error.to_string());
            Ok(())
        });
        (out, calls)
    };
    let (out, calls) = run(MOVED, vec![Ok("matteo".into()), Ok("example-teammate".into())]);
    assert_eq!(
        out,
        format!(
            "example-teammate already pushed work for this card to GitHub, on a branch with the same name as yours. \
             Nothing was sent to GitHub. https://github.com/o/r/tree/{BRANCH}\n{MOVED}"
        )
    );
    assert_eq!(calls[1], format!("api repos/o/r/commits/heads/{BRANCH} --jq .author.login // \"\""));
    // This member's own push from another computer, an author GitHub doesn't
    // know, a read that fails: unchanged.
    assert_eq!(run(MOVED, vec![Ok("matteo".into()), Ok("Matteo".into())]).0, MOVED);
    assert_eq!(run(MOVED, vec![Ok("matteo".into()), Ok(String::new())]).0, MOVED);
    assert_eq!(run(MOVED, vec![Ok("matteo".into()), Err("HTTP 404".into())]).0, MOVED);
    // Any other refusal isn't about somebody's work: nothing is read.
    let (out, calls) = run("couldn't push the branch to the remote: Permission denied (publickey)", vec![]);
    assert!(out.ends_with("(publickey)"));
    assert!(calls.is_empty());
    // No GitHub repository known for the pull request: nothing is read.
    assert_eq!(name_who_pushed(None, BRANCH, &issue_card(), MOVED.into()), MOVED);

    // Round 2: a card with a pull request of its own — the branch is the
    // member's, whoever added to it (a teammate's "Update branch"): the
    // words stay as they were, and nothing is read.
    let mut own = issue_card();
    own.pr_url = Some("https://github.com/o/r/pull/150".into());
    own.pr = Some(crate::pr_status::PrStatus { number: 150, state: crate::pr_status::PrState::Closed, ..Default::default() });
    let mut url_only = issue_card();
    url_only.pr_url = Some("https://github.com/o/r/pull/150".into());
    for card in [own, url_only] {
        let mut out = String::new();
        let (_, calls) = asked(vec![], || {
            out = name_who_pushed(Some(REPO), BRANCH, &card, MOVED.to_string());
            Ok(())
        });
        assert_eq!(out, MOVED);
        assert!(calls.is_empty(), "{calls:?}");
    }
}

/// D1: where Ship asks — before the push, on a GitHub Issues board, and the
/// push's refusal goes through the naming.
#[test]
fn ship_asks_before_its_push() {
    let commands = include_str!("commands.rs");
    let code = commands.split("#[cfg(test)]\nmod tests").next().unwrap();
    let check = code.find("crate::second_claim::ship_refusal(&repo, &card, &branch, &base)?;").expect("Ship asks");
    let push = code[check..].find("push_branch_for_pr(").expect("then pushes");
    assert!(push < 200, "right before the push");
    assert!(code[check - 200..check].contains("workspace_github_target(&workspaces, &workspace_id)"), "only on a GitHub Issues board");
    assert!(code.contains(".map_err(|e| crate::second_claim::name_who_pushed(origin_repo.as_deref(), &branch, &card, e))?;"));
    assert_eq!(code.matches("crate::second_claim::ship_refusal(").count(), 1);
    // The claim asks who was first only where nobody held the issue, after
    // the reading that followed its own write.
    let claim = include_str!("card_claim.rs");
    let claim = &claim[claim.find("fn claim_issue(").unwrap()..];
    let claim = &claim[..claim.find("\n}\n").unwrap()];
    let reread = claim.find("latest = after;").unwrap();
    let asked = claim.find("crate::second_claim::after_claim(").unwrap();
    assert!(reread < asked);
    assert!(claim[reread..asked].contains("if *before == ClaimHolder::Unclaimed {"));
}

/// Team walk (TEAMFIX 6): GitHub links "Closes #N" only for pull requests to
/// the default branch. On a project whose cards go to another branch, a
/// second bounded read finds a teammate's pull request to that branch whose
/// title or description closes the issue; the same rule then applies.
#[test]
fn ship_finds_a_teammates_pull_request_to_a_branch_that_isnt_the_default() {
    let _serial = github::test_serial_lock();
    let node = |number: u64, base: &str, body: &str, association: &str, cross: bool| {
        serde_json::json!({"number": number, "url": format!("https://github.com/o/r/pull/{number}"), "state": "OPEN",
            "headRefName": "giulia/login", "baseRefName": base, "isCrossRepository": cross, "authorAssociation": association,
            "author": {"login": "example-teammate"}, "repository": {"nameWithOwner": "o/r"}, "title": "Login redirect", "body": body})
    };
    let search = |nodes: serde_json::Value| -> Result<String, String> {
        Ok(serde_json::json!({"data": {"search": {"nodes": nodes}}}).to_string())
    };
    let none = || delivery_json("OPEN", serde_json::json!([]));
    let theirs = search(serde_json::json!([node(180, "site", "Fixes #161\n\nThe redirect.", "MEMBER", false)]));
    let (out, calls) = asked(vec![Ok("matteo".into()), none(), theirs.clone()], || ship_refusal(REPO, &issue_card(), BRANCH, "site"));
    assert!(out.unwrap_err().starts_with("Pull request #180 by example-teammate is already open for this card."), "{calls:?}");
    assert_eq!(calls.len(), 3, "{calls:?}");
    assert!(calls[2].starts_with("api graphql") && calls[2].contains("q=repo:o/r is:pr base:site 161 in:title,body"), "{calls:?}");
    assert!(!calls.iter().any(|c| c.contains("push") || c.starts_with("pr ")), "read only");

    // Not stopped: a mention that doesn't close it, another base, an
    // outsider's pull request, another number.
    for nodes in [
        serde_json::json!([node(181, "site", "Related to #161", "MEMBER", false)]),
        serde_json::json!([node(182, "main", "Closes #161", "MEMBER", false)]),
        serde_json::json!([node(183, "site", "Closes #161", "NONE", true)]),
        serde_json::json!([node(184, "site", "Closes #1612", "MEMBER", false)]),
    ] {
        let (out, _) = asked(vec![Ok("matteo".into()), none(), search(nodes)], || ship_refusal(REPO, &issue_card(), BRANCH, "site"));
        assert_eq!(out, Ok(()));
    }
    // The second read fails: the push decides, as before.
    let (out, _) = asked(vec![Ok("matteo".into()), none(), Err("HTTP 502".into())], || ship_refusal(REPO, &issue_card(), BRANCH, "site"));
    assert_eq!(out, Ok(()));
    // The second read fails: what the first read found still stops Ship.
    let linked = serde_json::json!([
        {"number": 178, "url": "https://github.com/o/r/pull/178", "state": "OPEN", "headRefName": "giulia/x", "isCrossRepository": false,
         "authorAssociation": "MEMBER", "author": {"login": "example-teammate"}, "repository": {"nameWithOwner": "o/r"}}
    ]);
    let (out, _) = asked(vec![Ok("matteo".into()), delivery_json("OPEN", linked), Err("HTTP 502".into())], || {
        ship_refusal(REPO, &issue_card(), BRANCH, "site")
    });
    assert!(out.unwrap_err().starts_with("Pull request #178 by example-teammate"));
    let (out, _) = asked(vec![Ok("matteo".into()), none(), Ok("not json".into())], || ship_refusal(REPO, &issue_card(), BRANCH, "site"));
    assert_eq!(out, Ok(()));
    // Cards that go to the default branch: one read, as before.
    let (_, calls) = asked(vec![Ok("matteo".into()), none()], || ship_refusal(REPO, &issue_card(), BRANCH, "main"));
    assert_eq!(calls.len(), 2, "{calls:?}");

    // GitHub's closing forms.
    assert!(github::closes_issue("closes: #161", 161, REPO));
    assert!(github::closes_issue("Resolves o/r#161.", 161, REPO));
    assert!(github::closes_issue("Fixed https://github.com/O/R/issues/161", 161, REPO));
    assert!(!github::closes_issue("prefixes #161", 161, REPO));
    assert!(!github::closes_issue("Closes x/y#161", 161, REPO));
}
