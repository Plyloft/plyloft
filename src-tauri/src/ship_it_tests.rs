//! G1 (1.170.0): Ship it puts the card on GitHub — a pull request that merges
//! when its checks pass on a project that can take one, a land here
//! otherwise; the GitHub CLI and a sign-in are checked before anything is
//! pushed.

use super::{
    plain_gh_host, pr_github_preflight, resolve_ship_press, ship_auto_merge_guarded, ship_it_origin_refusal,
    ship_it_unreadable_refusal, ship_press_for, ship_sign_in_refusal, PrOrigin, ShipAutoMerge, PR_OPEN_FAILED,
    SHIP_IT_UNREADABLE_TAIL, SHIP_NEEDS_SIGN_IN_WORDS,
};
use crate::workspace::WorkspaceStore;

fn pressed(mode: &str, via: Option<&str>, offers_pr: bool) -> (String, ShipAutoMerge) {
    resolve_ship_press(mode, via, offers_pr)
}

#[test]
fn ship_it_opens_a_pull_request_that_merges_where_one_can_be_opened() {
    // The default (no choice yet, every workspace from before G1) and the
    // explicit choice both ship to GitHub with auto-merge on.
    assert_eq!(pressed("ship_it", None, true), ("pr".into(), ShipAutoMerge::On));
    assert_eq!(pressed("ship_it", Some("github"), true), ("pr".into(), ShipAutoMerge::On));
    // A value a later build wrote reads as the default.
    assert_eq!(pressed("ship_it", Some("somewhere-new"), true), ("pr".into(), ShipAutoMerge::On));
}

#[test]
fn ship_it_lands_here_when_the_workspace_says_so_or_no_pull_request_can_be_opened() {
    assert_eq!(pressed("ship_it", Some("local"), true), ("merge_live".into(), ShipAutoMerge::Workspace));
    // No origin, or one on another host: Ship it lands here as it always
    // did — never a refusal, never flagged as a fallback.
    assert_eq!(pressed("ship_it", None, false), ("merge_live".into(), ShipAutoMerge::Workspace));
    assert_eq!(pressed("ship_it", Some("github"), false), ("merge_live".into(), ShipAutoMerge::Workspace));
}

#[test]
fn the_other_presses_keep_their_meaning() {
    // Only on this Mac.
    assert_eq!(pressed("merge_live", None, true), ("merge_live".into(), ShipAutoMerge::Workspace));
    // Ship as a PR follows the workspace's Merge when checks pass.
    assert_eq!(pressed("pr", Some("local"), true), ("pr".into(), ShipAutoMerge::Workspace));
    // Open the pull request only: no auto-merge.
    assert_eq!(pressed("pr_only", None, true), ("pr".into(), ShipAutoMerge::Off));
}

#[test]
fn auto_merge_is_asked_for_by_the_press_on_every_plan() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join("workspaces.json"),
        br#"{"workspaces":[{"id":"w","name":"n","cwd":"/tmp/n","createdAt":1,"lastOpenedAt":1}]}"#,
    )
    .unwrap();
    let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
    // 1.170.0 G2: the plan is no input.
    let wants = |auto| super::ship_wants_auto_merge(auto, &store, "w");
    assert!(wants(ShipAutoMerge::On), "Ship it: on, whatever Merge when checks pass says");
    assert!(!wants(ShipAutoMerge::Off), "Open the pull request only");
    assert!(!wants(ShipAutoMerge::Workspace), "Ship as a PR with the choice off");
    store.set_merge_when_checks_pass("w", true).unwrap();
    assert!(wants(ShipAutoMerge::Workspace), "Ship as a PR with the choice on");
    assert!(!wants(ShipAutoMerge::Off));
}

fn repo_with_origin(url: Option<&str>) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    crate::git::run(dir.path(), &["init", "-q"]).unwrap();
    if let Some(url) = url {
        crate::git::run(dir.path(), &["remote", "add", "origin", url]).unwrap();
    }
    dir
}

#[test]
fn ship_it_reads_the_workspace_and_the_card_copy_origin() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join("workspaces.json"),
        br#"{"workspaces":[{"id":"w","name":"n","cwd":"/tmp/n","createdAt":1,"lastOpenedAt":1}]}"#,
    )
    .unwrap();
    let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
    let github = repo_with_origin(Some("https://github.com/o/r.git"));
    let none = repo_with_origin(None);
    let gitlab = repo_with_origin(Some("https://gitlab.com/o/r.git"));

    assert_eq!(ship_press_for(&store, "w", github.path(), "ship_it"), ("pr".into(), ShipAutoMerge::On));
    assert_eq!(ship_press_for(&store, "w", none.path(), "ship_it").0, "merge_live");
    assert_eq!(ship_press_for(&store, "w", gitlab.path(), "ship_it").0, "merge_live");
    store.set_ship_via("w", Some("local")).unwrap();
    assert_eq!(ship_press_for(&store, "w", github.path(), "ship_it").0, "merge_live");
    // Only Ship it follows the choice.
    assert_eq!(ship_press_for(&store, "w", github.path(), "pr_only"), ("pr".into(), ShipAutoMerge::Off));
    assert_eq!(ship_press_for(&store, "w", github.path(), "merge_live").0, "merge_live");
}

#[test]
fn a_missing_sign_in_is_refused_before_anything_is_pushed() {
    // Signed in (gh's own account, or the chosen account's token).
    assert_eq!(ship_sign_in_refusal(Ok((true, ""))), None);
    // gh has none for github.com.
    let refused = ship_sign_in_refusal(Ok((false, "no oauth token found for github.com\n"))).unwrap();
    assert!(refused.starts_with(SHIP_NEEDS_SIGN_IN_WORDS), "{refused}");
    assert!(refused.ends_with("no oauth token found for github.com"), "{refused}");
    assert_eq!(ship_sign_in_refusal(Ok((false, " "))).as_deref(), Some(SHIP_NEEDS_SIGN_IN_WORDS));
    // The workspace's chosen account can't be used: the scope's words.
    let chosen = "This workspace uses the GitHub account octo, which isn't signed in on this computer.";
    let refused = ship_sign_in_refusal(Err(chosen)).unwrap();
    assert!(refused.starts_with(SHIP_NEEDS_SIGN_IN_WORDS) && refused.ends_with(chosen), "{refused}");
}

#[test]
fn a_sign_in_that_could_not_be_read_is_left_to_the_pull_request() {
    // A gh too old for `gh auth token`, a gh that didn't answer or didn't
    // run: not a refusal — the pull request's own calls answer (R11).
    assert_eq!(ship_sign_in_refusal(Ok((false, "unknown command \"token\" for \"gh auth\""))), None);
    assert_eq!(ship_sign_in_refusal(Ok((false, "unknown flag: --hostname"))), None);
    let timeout = format!("{}: `gh auth token` was stopped after 30s.", crate::github::GH_TIMED_OUT);
    assert_eq!(ship_sign_in_refusal(Err(&timeout)), None);
    assert_eq!(ship_sign_in_refusal(Err("couldn't run GitHub CLI (`gh`): No such file")), None);
}

#[test]
fn the_preflight_asks_nothing_of_a_land_or_a_project_off_github() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join("workspaces.json"),
        br#"{"workspaces":[{"id":"w","name":"n","cwd":"/tmp/n","createdAt":1,"lastOpenedAt":1}]}"#,
    )
    .unwrap();
    let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
    let github = repo_with_origin(Some("https://github.com/o/r.git"));
    let none = repo_with_origin(None);
    // A land never needs gh, and a pull request with no origin lands here
    // (flagged), as before: neither looks for gh.
    assert_eq!(pr_github_preflight(&store, "w", github.path(), "merge_live"), Ok(()));
    assert_eq!(pr_github_preflight(&store, "w", none.path(), "pr"), Ok(()));
}

/// The order in `card_ship_blocking_with`: the press is resolved before
/// anything reads `mode`, and the GitHub check runs before the carry stop,
/// the gate and the push.
#[test]
fn the_github_check_comes_before_the_gate_and_the_push() {
    let source = include_str!("commands.rs");
    let (_, ship) = source.split_once("fn card_ship_blocking_with(").expect("card_ship");
    let (ship, _) = ship.split_once("pub async fn card_ship_with_follow_up(").expect("its end");
    let at = |needle: &str| ship.find(needle).unwrap_or_else(|| panic!("{needle} in card_ship_blocking_with"));
    let resolved = at("ship_press_for(&workspaces, &workspace_id, &wt, &mode)");
    assert!(resolved < at("card.skill_card()"), "resolved before the skill preflight");
    let preflight = at("pr_github_preflight(&workspaces, &workspace_id, &wt, &mode)");
    assert!(preflight < at("pr_carry_stop("));
    assert!(preflight < at("ship_tree_gate("));
    assert!(preflight < at("push_branch_for_pr("));
    // The auto-merge ask (one, for a new pull request and one that was
    // already open: `open_branch_pr`, 1.173.0 A3) follows the press.
    assert_eq!(ship.matches("auto_merge,\n").count(), 1, "{}", ship.matches("auto_merge_after_ship(").count());

    // Ship with follow-up checks the same before its new card exists.
    let (_, follow) = source.split_once("fn card_ship_with_follow_up_blocking(").expect("follow-up");
    let made = follow.find("ensure_follow_up_card(").expect("the new card");
    let checked = follow.find("pr_github_preflight(&workspaces, &workspace_id, &wt, &mode)").expect("checked");
    assert!(checked < made);
}

/// G1 Challenger (1, 3, 4): nothing unreviewed, shipped over a request for
/// changes nobody resolved, or with its findings in a follow-up asks GitHub
/// to merge it by itself — whatever the press, Merge when checks pass or
/// the plan. `ship_wants_auto_merge` is the only gate before
/// `turn_on_after_ship`, so Off never reaches it.
#[test]
fn an_unreviewed_or_overridden_ship_never_merges_by_itself() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join("workspaces.json"),
        br#"{"workspaces":[{"id":"w","name":"n","cwd":"/tmp/n","createdAt":1,"lastOpenedAt":1,"mergeWhenChecksPass":true}]}"#,
    )
    .unwrap();
    let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
    let wants = |auto| super::ship_wants_auto_merge(auto, &store, "w");
    let unreviewed = Some("The last commit was not reviewed.");
    for auto in [ShipAutoMerge::On, ShipAutoMerge::Workspace, ShipAutoMerge::Off] {
        assert_eq!(ship_auto_merge_guarded(auto, unreviewed, false), ShipAutoMerge::Off, "Ship anyway");
        assert_eq!(ship_auto_merge_guarded(auto, None, true), ShipAutoMerge::Off, "with follow-up");
        assert!(!wants(ship_auto_merge_guarded(auto, unreviewed, false)));
    }
    // Reviewed and approved: the press decides, as before.
    assert_eq!(ship_auto_merge_guarded(ShipAutoMerge::On, None, false), ShipAutoMerge::On);
    assert!(wants(ship_auto_merge_guarded(ShipAutoMerge::Workspace, None, false)));
}

/// A Builder card at round 1 (`sha` "a") with `review` as its last review.
fn reviewed_card(review: &str) -> crate::kanban::KanbanCard {
    serde_json::from_str(&format!(
        r#"{{"id":"c1","workspaceId":"w","title":"t","columnId":"in_progress","createdAt":0,"updatedAt":0,
            "builder":{{"vendor":"claude","snapshots":[{{"n":1,"sha":"a","at":1}}],"review":{review}}}}}"#
    ))
    .unwrap()
}

/// What `card_ship_blocking_with` asks for, from the card's review record.
fn asked_for(card: &crate::kanban::KanbanCard, follow_up: bool) -> ShipAutoMerge {
    let unreviewed = crate::builder::ship_review_record(card, "a", follow_up);
    ship_auto_merge_guarded(ShipAutoMerge::On, unreviewed.as_deref(), follow_up)
}

/// Owner, 2026-10-15: a human's decision is an approval. Findings the
/// person dismissed and a Builder's pushback the person accepted still
/// merge by themselves (their lines stay in the receipt and the pull
/// request); only a request for changes nobody resolved, an unreviewed
/// commit or a follow-up turn auto-merge off.
#[test]
fn a_human_decided_approval_still_merges_by_itself() {
    // The Builder's pushback accepted (`override_changes_requested`).
    let accepted = reviewed_card(
        r#"{"snapshotN":1,"provider":"claude","status":"skipped","at":1,
            "note":"changes requested on snapshot 1, overridden by the human","overriddenBy":"me@example.com"}"#,
    );
    assert!(crate::builder::review_override_summary(&accepted).is_some(), "the receipt still says so");
    assert_eq!(asked_for(&accepted, false), ShipAutoMerge::On);
    // Findings dismissed as not a real issue, read as an approval.
    let dismissed = reviewed_card(
        r#"{"snapshotN":1,"provider":"claude","status":"done","verdict":"approve","reviewedRevision":"a","at":1,
            "ledgerNote":"Plyloft reads this review as APPROVE: the member dismissed F1 as not a real issue, and no other finding blocks approval.",
            "ledger":[{"id":"F1","severity":"S2","title":"x","dismissal":{"by":"me","at":1,"round":1}}]}"#,
    );
    assert!(crate::builder::dismissal_summary(&dismissed).is_some(), "the receipt still says so");
    assert_eq!(asked_for(&dismissed, false), ShipAutoMerge::On);
    // A plain approval.
    let approved = reviewed_card(r#"{"snapshotN":1,"provider":"claude","status":"done","verdict":"approve","reviewedRevision":"a","at":1}"#);
    assert_eq!(asked_for(&approved, false), ShipAutoMerge::On);
    // 1.171.0 C3 (owner 2026-10-27): a review skipped with "Check without
    // the Reviewer" is no review — never a merge by itself.
    let skipped = reviewed_card(r#"{"snapshotN":1,"provider":"claude","status":"skipped","at":1}"#);
    assert_eq!(asked_for(&skipped, false), ShipAutoMerge::Off);
    assert!(
        crate::builder::ship_review_record(&skipped, "a", false).unwrap().contains("its review was skipped"),
        "the pull request says the review was skipped"
    );

    // Shipped over a request for changes nobody resolved: a true override.
    let standing = reviewed_card(
        r#"{"snapshotN":1,"provider":"claude","status":"done","verdict":"changes_requested","reviewedRevision":"a","at":1}"#,
    );
    assert_eq!(asked_for(&standing, false), ShipAutoMerge::Off);
    // Not reviewed: still running, or no review of the last round.
    let running = reviewed_card(r#"{"snapshotN":1,"provider":"claude","status":"running","at":1}"#);
    assert_eq!(asked_for(&running, false), ShipAutoMerge::Off);
    // The findings in a follow-up: Off, even over an approval.
    assert_eq!(asked_for(&approved, true), ShipAutoMerge::Off);
    assert_eq!(asked_for(&accepted, true), ShipAutoMerge::Off);
}

/// The order in `card_ship_blocking_with`: the guard is applied to the
/// press's auto-merge once the review record is read, before either ask;
/// a skill card forced to a pull request (HereMoved) is Off.
#[test]
fn the_guard_reaches_both_auto_merge_asks() {
    let source = include_str!("commands.rs");
    let (_, ship) = source.split_once("fn card_ship_blocking_with(").expect("card_ship");
    let (ship, _) = ship.split_once("pub async fn card_ship_with_follow_up(").expect("its end");
    let at = |needle: &str| ship.find(needle).unwrap_or_else(|| panic!("{needle} in card_ship_blocking_with"));
    let record = at("let unreviewed = crate::builder::ship_review_record(");
    let guarded = at("let auto_merge = ship_auto_merge_guarded(auto_merge, unreviewed.as_deref(), pr_line.is_some());");
    assert!(record < guarded);
    assert!(guarded < at("auto_merge_after_ship("));
    let (_, moved) = ship.split_once("Preflight::HereMoved(why) =>").expect("HereMoved");
    let (moved, _) = moved.split_once("Preflight::Go").expect("its end");
    assert!(moved.contains("mode = \"pr\".to_string();") && moved.contains("auto_merge = ShipAutoMerge::Off;"));
    // Ship it's unreadable-origin refusal comes before the gate and the push.
    let refused = at("if let Some(why) = unreadable_refusal {");
    assert!(refused < at("ship_tree_gate("));
    let (_, follow) = source.split_once("fn card_ship_with_follow_up_blocking(").expect("follow-up");
    let checked = follow.find("ship_it_origin_refusal(&workspaces, &workspace_id, &wt, &mode)").expect("checked");
    assert!(checked < follow.find("ensure_follow_up_card(").expect("the new card"));
}

/// G1 Challenger (8): Ship it from a GitHub address that isn't a
/// repository's stops before anything, with Only on this Mac as the
/// way on — it no longer lands here.
#[test]
fn ship_it_refuses_an_unreadable_github_address() {
    let url = "https://github.com/o".to_string();
    let refused = ship_it_unreadable_refusal(&PrOrigin::Unreadable(url.clone()), None).unwrap();
    assert!(refused.starts_with("This project's GitHub address isn't a repository Plyloft can read: https://github.com/o."), "{refused}");
    assert!(refused.ends_with(SHIP_IT_UNREADABLE_TAIL), "{refused}");
    assert!(ship_it_unreadable_refusal(&PrOrigin::Unreadable(url.clone()), Some("github")).is_some());
    // Kept on this Mac: Ship it lands here, as the person chose.
    assert_eq!(ship_it_unreadable_refusal(&PrOrigin::Unreadable(url), Some("local")), None);
    assert_eq!(ship_it_unreadable_refusal(&PrOrigin::None, None), None);
    assert_eq!(ship_it_unreadable_refusal(&PrOrigin::GitHub { repo: Some("o/r".into()) }, None), None);
    assert_eq!(ship_it_unreadable_refusal(&PrOrigin::Elsewhere("gitlab.com".into()), None), None);

    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join("workspaces.json"),
        br#"{"workspaces":[{"id":"w","name":"n","cwd":"/tmp/n","createdAt":1,"lastOpenedAt":1}]}"#,
    )
    .unwrap();
    let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
    let odd = repo_with_origin(Some("https://github.com/o"));
    assert!(ship_it_origin_refusal(&store, "w", odd.path(), "ship_it").is_some());
    // Only Ship it: Only on this Mac lands, Ship as a PR is R10's.
    assert_eq!(ship_it_origin_refusal(&store, "w", odd.path(), "merge_live"), None);
    assert_eq!(ship_it_origin_refusal(&store, "w", odd.path(), "pr"), None);
    store.set_ship_via("w", Some("local")).unwrap();
    assert_eq!(ship_it_origin_refusal(&store, "w", odd.path(), "ship_it"), None);
}

/// G1 Challenger (7): on a GitHub Enterprise host the preflight asks gh
/// about that host — only a plain host name, never an alias or an option.
#[test]
fn a_plain_enterprise_host_is_asked_about_its_sign_in() {
    let same = |h: &str| Some(h.to_string());
    let none = |_: &str| None;
    assert_eq!(plain_gh_host("https://ghe.corp.example/o/r.git", &none).as_deref(), Some("ghe.corp.example"));
    assert_eq!(plain_gh_host("https://user:secret@GHE.Corp.Example/o/r", &none).as_deref(), Some("ghe.corp.example"));
    // SSH: the host ssh connects to.
    assert_eq!(plain_gh_host("git@ghe.corp.example:o/r.git", &same).as_deref(), Some("ghe.corp.example"));
    let resolve = |_: &str| Some("ghe.corp.example".to_string());
    assert_eq!(plain_gh_host("git@work:o/r.git", &resolve).as_deref(), Some("ghe.corp.example"));
    // An alias ssh can't resolve, or one that is no host name: gh's own
    // calls answer for the sign-in.
    assert_eq!(plain_gh_host("git@work:o/r.git", &none), None);
    assert_eq!(plain_gh_host("git@work:o/r.git", &same), None);
    assert_eq!(plain_gh_host("https://-x.example/o/r", &none), None);
    assert_eq!(plain_gh_host("https://localhost/o/r", &none), None);
}

/// 1.171.0 B3: a ship whose push reached GitHub and whose pull request
/// didn't open says so in the words the card reads (`prOpenFailure`), so it
/// offers Open the pull request — the same `card_ship` again.
#[test]
fn a_pull_request_that_did_not_open_is_said_in_the_cards_words() {
    let ts = include_str!("../../src/lib/shipVia.ts");
    assert!(
        ts.contains(&format!("PR_OPEN_FAILED_WORDS = \"{PR_OPEN_FAILED}\"")),
        "shipVia.ts reads Rust's words"
    );
    // Both ways it fails after the push carry them: gh's refusal and a gh
    // that didn't finish.
    let src = include_str!("commands.rs");
    assert_eq!(src.matches("format!(\"{PR_OPEN_FAILED} {}\"").count(), 2);
}
