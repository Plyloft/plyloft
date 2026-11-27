//! N18: the card-branch sweep, the Inbox ask, the backlog and the record's
//! schema.

use super::*;
use crate::kanban::{KanbanColumnId, KanbanStore, ReleaseKind, ShipEntry};
use std::path::{Path, PathBuf};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// A fixed "now" well past every commit date the fixtures write.
const NOW: i64 = 2_000_000_000_000;
const CARD: &str = "card-abc12345-0";
const BRANCH: &str = "plyloft/card-abc12345-tidy-the-header";

fn git(dir: &Path, args: &[&str]) -> String {
    git_at(dir, args, None)
}

/// `git` with a fixed committer date (unix seconds) when given.
fn git_at(dir: &Path, args: &[&str], date: Option<i64>) -> String {
    let mut cmd = crate::platform::git_command();
    cmd.args(args).current_dir(dir);
    if let Some(secs) = date {
        let stamp = format!("@{secs} +0000");
        cmd.env("GIT_COMMITTER_DATE", &stamp).env("GIT_AUTHOR_DATE", &stamp);
    }
    let out = cmd.output().expect("spawn git");
    assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A repository on `main` with one commit, and a card branch with one more
/// (committed at `commit_secs`). Returns the branch tip.
fn repo_with_branch(dir: &Path, branch: &str, commit_secs: i64) -> String {
    if !dir.join(".git").exists() {
        git(dir, &["init", "-q", "-b", "main"]);
        git(dir, &["config", "user.email", "test@atelier.test"]);
        git(dir, &["config", "user.name", "atelier-test"]);
        git(dir, &["config", "commit.gpgsign", "false"]);
        git(dir, &["config", "core.autocrlf", "false"]);
        std::fs::write(dir.join("README.md"), "hi\n").unwrap();
        git(dir, &["add", "."]);
        git_at(dir, &["commit", "-q", "-m", "init"], Some(commit_secs - 10));
    }
    git(dir, &["branch", branch, "main"]);
    let wt = dir.join("..").join(format!("wt-{}", branch.replace('/', "-")));
    git(dir, &["worktree", "add", "-q", wt.to_str().unwrap(), branch]);
    // One file per branch, so squash-merging several never conflicts.
    std::fs::write(wt.join(format!("work-{}.txt", branch.replace('/', "-"))), branch).unwrap();
    git(&wt, &["add", "."]);
    git_at(&wt, &["commit", "-q", "-m", "work"], Some(commit_secs));
    let tip = git(&wt, &["rev-parse", "HEAD"]);
    git(dir, &["worktree", "remove", "--force", wt.to_str().unwrap()]);
    tip
}

fn branch_exists(repo: &Path, branch: &str) -> bool {
    crate::worktrees::branch_tip(repo, branch).is_some()
}

fn card(id: &str) -> KanbanCard {
    KanbanCard::new(id.into(), "ws".into(), "Tidy the header".into(), None, KanbanColumnId::Complete)
}

fn shipped_card(id: &str, branch: &str, tip: &str, since: i64) -> KanbanCard {
    let mut c = card(id);
    c.branch_cleanup = Some(BranchCleanup::new(branch, tip, CleanupReason::Shipped, since, None));
    c
}

fn no_session(_: &KanbanCard) -> bool {
    false
}

fn env<'a>(repo: &'a Path, in_session: &'a dyn Fn(&KanbanCard) -> bool) -> Env<'a> {
    Env { repo, enabled: true, me: Me::default(), now: NOW, in_session }
}

struct Fixture {
    _tmp: tempfile::TempDir,
    repo: PathBuf,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    Fixture { _tmp: tmp, repo }
}

// ── The sweep ────────────────────────────────────────────────────────

#[test]
fn a_shipped_branch_is_deleted_once_its_week_is_up() {
    let f = fixture();
    let tip = repo_with_branch(&f.repo, BRANCH, 1_700_000_000);
    let c = shipped_card(CARD, BRANCH, &tip, NOW - 8 * DAY_MS);
    assert_eq!(sweep_card(&env(&f.repo, &no_session), &c), Verdict::Deleted);
    assert!(!branch_exists(&f.repo, BRANCH));
}

#[test]
fn a_shipped_branch_is_not_deleted_before_its_week_or_while_its_trash_entry_is_there() {
    let f = fixture();
    let tip = repo_with_branch(&f.repo, BRANCH, 1_700_000_000);
    let young = shipped_card(CARD, BRANCH, &tip, NOW - DAY_MS);
    assert_eq!(sweep_card(&env(&f.repo, &no_session), &young), Verdict::NotDue);

    // Past the week, but the trash entry is still there (gc_trash kept it,
    // or has not reaped it yet): the branch waits with it.
    let entry = f.repo.join(".plyloft-worktrees/.trash").join(format!("{CARD}-1"));
    std::fs::create_dir_all(&entry).unwrap();
    let mut old = shipped_card(CARD, BRANCH, &tip, NOW - 8 * DAY_MS);
    old.branch_cleanup.as_mut().unwrap().trash_entry = Some(entry.to_string_lossy().to_string());
    assert_eq!(sweep_card(&env(&f.repo, &no_session), &old), Verdict::NotDue);
    assert!(branch_exists(&f.repo, BRANCH));

    // Reaped: now it goes.
    std::fs::remove_dir_all(&entry).unwrap();
    assert_eq!(sweep_card(&env(&f.repo, &no_session), &old), Verdict::Deleted);
    assert!(!branch_exists(&f.repo, BRANCH));
}

#[test]
fn a_branch_with_commits_after_it_shipped_is_kept_for_good() {
    let f = fixture();
    let released = repo_with_branch(&f.repo, BRANCH, 1_700_000_000);
    // A commit after the release moves the branch on.
    let wt = f.repo.join("../later");
    git(&f.repo, &["worktree", "add", "-q", wt.to_str().unwrap(), BRANCH]);
    std::fs::write(wt.join("later.txt"), "x").unwrap();
    git(&wt, &["add", "."]);
    git(&wt, &["commit", "-q", "-m", "after the ship"]);
    git(&f.repo, &["worktree", "remove", "--force", wt.to_str().unwrap()]);

    let c = shipped_card(CARD, BRANCH, &released, NOW - 8 * DAY_MS);
    let verdict = sweep_card(&env(&f.repo, &no_session), &c);
    assert_eq!(verdict, Verdict::MovedOn);
    assert!(branch_exists(&f.repo, BRANCH));
    let mut rec = c.branch_cleanup.clone().unwrap();
    assert!(settle(&mut rec, &verdict, NOW));
    assert_eq!(rec.outcome, Some(CleanupOutcome::MovedOn));
    assert!(!rec.pending(), "settled: never judged again");
}

#[test]
fn a_branch_checked_out_anywhere_is_kept() {
    let f = fixture();
    let tip = repo_with_branch(&f.repo, BRANCH, 1_700_000_000);
    let c = shipped_card(CARD, BRANCH, &tip, NOW - 8 * DAY_MS);

    // In a worktree made by hand.
    let wt = f.repo.join("../by-hand");
    git(&f.repo, &["worktree", "add", "-q", wt.to_str().unwrap(), BRANCH]);
    assert!(matches!(sweep_card(&env(&f.repo, &no_session), &c), Verdict::Held(why) if why.contains("checked out")));
    git(&f.repo, &["worktree", "remove", "--force", wt.to_str().unwrap()]);

    // In the main checkout.
    git(&f.repo, &["checkout", "-q", BRANCH]);
    assert!(matches!(sweep_card(&env(&f.repo, &no_session), &c), Verdict::Held(_)));
    assert!(branch_exists(&f.repo, BRANCH));
    git(&f.repo, &["checkout", "-q", "main"]);
    assert_eq!(sweep_card(&env(&f.repo, &no_session), &c), Verdict::Deleted);
}

#[test]
fn a_branch_whose_card_has_a_live_session_is_kept() {
    let f = fixture();
    let tip = repo_with_branch(&f.repo, BRANCH, 1_700_000_000);
    let c = shipped_card(CARD, BRANCH, &tip, NOW - 8 * DAY_MS);
    let busy = |_: &KanbanCard| true;
    assert!(matches!(sweep_card(&env(&f.repo, &busy), &c), Verdict::Held(_)));
    assert!(branch_exists(&f.repo, BRANCH));
}

#[test]
fn another_persons_team_card_is_never_touched() {
    let f = fixture();
    let tip = repo_with_branch(&f.repo, BRANCH, 1_700_000_000);
    let mut c = shipped_card(CARD, BRANCH, &tip, NOW - 8 * DAY_MS);
    c.gh_issue_number = Some(42);
    c.author = Some("bob@team.test".into());
    c.gh_assignees = vec!["bob".into()];
    c.gh_author = Some("bob".into());
    let mut e = env(&f.repo, &no_session);
    e.me = Me { email: Some("me@team.test"), login: Some("me") };
    assert_eq!(sweep_card(&e, &c), Verdict::Skip);
    // Without a login, only the email can make it ours.
    e.me = Me { email: Some("me@team.test"), login: None };
    c.gh_assignees = vec!["me".into()];
    assert_eq!(sweep_card(&e, &c), Verdict::Skip);
    assert!(branch_exists(&f.repo, BRANCH));

    // Claimed by this login: ours.
    e.me = Me { email: Some("me@team.test"), login: Some("ME") };
    assert_eq!(sweep_card(&e, &c), Verdict::Deleted);
}

#[test]
fn is_mine_covers_local_cards_my_email_and_my_claim() {
    let me = Me { email: Some("me@x.test"), login: Some("me") };
    let local = card("c1");
    assert!(is_mine(&local, me));
    let mut team = card("c2");
    team.gh_issue_number = Some(1);
    assert!(!is_mine(&team, me));
    assert!(!is_mine(&team, Me::default()));
    team.author = Some(" Me@X.test ".into());
    assert!(is_mine(&team, me));
    team.author = None;
    team.gh_author = Some("me".into());
    assert!(is_mine(&team, me));
    // An empty identity never matches an empty field.
    team.gh_author = Some(String::new());
    assert!(!is_mine(&team, Me { email: Some(""), login: Some("") }));
}

#[test]
fn with_the_setting_off_nothing_is_deleted() {
    let f = fixture();
    let tip = repo_with_branch(&f.repo, BRANCH, 1_700_000_000);
    let c = shipped_card(CARD, BRANCH, &tip, NOW - 30 * DAY_MS);
    let mut e = env(&f.repo, &no_session);
    e.enabled = false;
    assert_eq!(sweep_card(&e, &c), Verdict::Skip);
    assert!(branch_exists(&f.repo, BRANCH));
}

#[test]
fn an_archived_cards_branch_is_asked_about_not_deleted() {
    let f = fixture();
    let tip = repo_with_branch(&f.repo, BRANCH, 1_700_000_000);
    let mut c = card(CARD);
    c.archived = true;
    c.branch_cleanup = Some(BranchCleanup::new(BRANCH, &tip, CleanupReason::Archived, NOW - 8 * DAY_MS, None));
    assert_eq!(sweep_card(&env(&f.repo, &no_session), &c), Verdict::Ask);
    assert!(branch_exists(&f.repo, BRANCH));
    // Approved in the Inbox: the same rules, then deleted.
    c.branch_cleanup.as_mut().unwrap().approved = true;
    assert_eq!(sweep_card(&env(&f.repo, &no_session), &c), Verdict::Deleted);
}

#[test]
fn a_commit_racing_the_delete_keeps_the_branch() {
    let f = fixture();
    let tip = repo_with_branch(&f.repo, BRANCH, 1_700_000_000);
    let c = shipped_card(CARD, BRANCH, &tip, NOW - 8 * DAY_MS);
    let repo = f.repo.clone();
    let mut race = || {
        // A commit lands on the branch after every check, before the delete.
        let tree = git(&repo, &["rev-parse", &format!("{tip}^{{tree}}")]);
        let later = git(&repo, &["commit-tree", &tree, "-p", &tip, "-m", "raced"]);
        git(&repo, &["update-ref", &format!("refs/heads/{BRANCH}"), &later, &tip]);
    };
    let verdict = sweep_card_hooked(&env(&f.repo, &no_session), &c, &mut race);
    assert_eq!(verdict, Verdict::MovedOn, "compare-and-delete refused the moved branch");
    assert!(branch_exists(&f.repo, BRANCH));
    assert_ne!(crate::worktrees::branch_tip(&f.repo, BRANCH).as_deref(), Some(tip.as_str()));
}

#[test]
fn a_branch_already_gone_is_settled_quietly() {
    let f = fixture();
    let tip = repo_with_branch(&f.repo, BRANCH, 1_700_000_000);
    git(&f.repo, &["branch", "-D", BRANCH]);
    let c = shipped_card(CARD, BRANCH, &tip, NOW - 8 * DAY_MS);
    assert_eq!(sweep_card(&env(&f.repo, &no_session), &c), Verdict::Gone);
}

#[test]
fn a_record_this_build_cannot_read_or_a_non_card_branch_is_never_acted_on() {
    let f = fixture();
    let tip = repo_with_branch(&f.repo, BRANCH, 1_700_000_000);
    let mut c = shipped_card(CARD, BRANCH, &tip, NOW - 8 * DAY_MS);
    c.branch_cleanup.as_mut().unwrap().reason = CleanupReason::Unknown;
    assert_eq!(sweep_card(&env(&f.repo, &no_session), &c), Verdict::Skip);
    let main_tip = git(&f.repo, &["rev-parse", "main"]);
    let main = shipped_card(CARD, "main", &main_tip, NOW - 8 * DAY_MS);
    assert_eq!(sweep_card(&env(&f.repo, &no_session), &main), Verdict::Skip);
    assert!(branch_exists(&f.repo, BRANCH) && branch_exists(&f.repo, "main"));
}

// ── Through the board ────────────────────────────────────────────────

fn store_with(dir: &Path, cards: Vec<KanbanCard>) -> KanbanStore {
    let store = KanbanStore::new(dir.join("state")).unwrap();
    for c in cards {
        let id = c.id.clone();
        let cleanup = c.branch_cleanup.clone();
        let extra = c.clone();
        store.create_card("ws", c).unwrap();
        store
            .with_card("ws", &id, |card| {
                card.branch_cleanup = cleanup;
                card.archived = extra.archived;
                card.archived_at = extra.archived_at;
                card.ship_history = extra.ship_history;
                card.gh_issue_number = extra.gh_issue_number;
                Ok(())
            })
            .unwrap();
    }
    store
}

#[test]
fn the_workspace_sweep_records_the_deletion_and_queues_the_ask() {
    let f = fixture();
    let shipped_tip = repo_with_branch(&f.repo, BRANCH, 1_700_000_000);
    let archived_branch = "plyloft/card-def67890-old-idea";
    let archived_tip = repo_with_branch(&f.repo, archived_branch, 1_700_000_100);
    let mut archived = card("card-def67890-1");
    archived.archived = true;
    archived.branch_cleanup = Some(BranchCleanup::new(
        archived_branch,
        &archived_tip,
        CleanupReason::Archived,
        NOW - 9 * DAY_MS,
        None,
    ));
    let store = store_with(
        f._tmp.path(),
        vec![shipped_card(CARD, BRANCH, &shipped_tip, NOW - 8 * DAY_MS), archived],
    );
    let e = env(&f.repo, &no_session);
    let report = sweep_workspace(&store, "ws", &e);
    assert_eq!(report.deleted, vec![(CARD.to_string(), BRANCH.to_string())]);
    assert_eq!(report.asks, 1);
    assert!(report.changed);

    let rec = store.get_card("ws", CARD).unwrap().branch_cleanup.unwrap();
    assert_eq!(rec.outcome, Some(CleanupOutcome::Deleted));
    assert_eq!(rec.outcome_at, Some(NOW));
    assert_eq!(rec.tip, shipped_tip, "the Activity row names the tip it was at");

    let cards = store.load("ws").unwrap();
    let asked = asks(&cards);
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].branch, archived_branch);
    assert!(!asked[0].shipped);
    assert!(branch_exists(&f.repo, archived_branch), "asked, never deleted");

    // A second pass changes nothing and asks no second time.
    let again = sweep_workspace(&store, "ws", &e);
    assert_eq!(again.asks, 0);
    assert!(!again.changed);
}

#[test]
fn keep_them_is_remembered_per_branch_and_delete_them_deletes() {
    let f = fixture();
    let a = "plyloft/card-aaaa1111-one";
    let b = "plyloft/card-bbbb2222-two";
    let ta = repo_with_branch(&f.repo, a, 1_700_000_000);
    let tb = repo_with_branch(&f.repo, b, 1_700_000_100);
    let archived = |id: &str, branch: &str, tip: &str| {
        let mut c = card(id);
        c.archived = true;
        c.branch_cleanup = Some(BranchCleanup::new(branch, tip, CleanupReason::Archived, NOW - 9 * DAY_MS, None));
        c
    };
    let store = store_with(
        f._tmp.path(),
        vec![archived("card-aaaa1111-0", a, &ta), archived("card-bbbb2222-0", b, &tb)],
    );
    let e = env(&f.repo, &no_session);
    sweep_workspace(&store, "ws", &e);
    assert_eq!(asks(&store.load("ws").unwrap()).len(), 2);

    answer_ask(&store, "ws", &["card-aaaa1111-0".to_string()], false, &e).unwrap();
    let kept = store.get_card("ws", "card-aaaa1111-0").unwrap().branch_cleanup.unwrap();
    assert_eq!(kept.outcome, Some(CleanupOutcome::Declined));
    assert!(branch_exists(&f.repo, a));
    sweep_workspace(&store, "ws", &e);
    let left = asks(&store.load("ws").unwrap());
    assert_eq!(left.len(), 1, "never asked again about a kept branch");
    assert_eq!(left[0].branch, b);

    let report = answer_ask(&store, "ws", &["card-bbbb2222-0".to_string()], true, &e).unwrap();
    assert_eq!(report.deleted.len(), 1);
    assert!(!branch_exists(&f.repo, b));
    assert!(asks(&store.load("ws").unwrap()).is_empty());
}

/// Challenger M2: a restored card owns its branch again — the pending
/// archive record is cancelled, and nothing asks or deletes for a card that
/// is not archived.
#[test]
fn restoring_an_archived_card_cancels_its_ask() {
    let f = fixture();
    let tip = repo_with_branch(&f.repo, BRANCH, 1_700_000_000);
    let mut c = card(CARD);
    c.archived = true;
    c.auto_archived = true;
    c.archived_at = Some(NOW - 9 * DAY_MS);
    let mut rec = BranchCleanup::new(BRANCH, &tip, CleanupReason::Archived, NOW - 9 * DAY_MS, None);
    rec.asking = true;
    rec.approved = true;
    c.branch_cleanup = Some(rec);
    // Not archived any more (whatever the record says): never asked, never deleted.
    let mut back = c.clone();
    back.archived = false;
    assert_eq!(sweep_card(&env(&f.repo, &no_session), &back), Verdict::Skip);
    assert!(asks(&[back]).is_empty());
    assert!(branch_exists(&f.repo, BRANCH));

    let store = store_with(f._tmp.path(), vec![c]);
    store
        .with_card("ws", CARD, |card| {
            card.auto_archived = true;
            Ok(())
        })
        .unwrap();
    let restored = store.restore_card("ws", CARD).unwrap();
    let rec = restored.branch_cleanup.clone().unwrap();
    assert_eq!(rec.outcome, Some(CleanupOutcome::Restored), "the archive's cleanup is settled");
    assert_eq!(rec.branch, BRANCH, "the branch's name stays for the next Start build");
    assert_eq!(restart_candidates(&restored, Some(std::slice::from_ref(&restored)))[0], BRANCH);
    assert!(asks(&store.load("ws").unwrap()).is_empty());
    assert_eq!(sweep_card(&env(&f.repo, &no_session), &restored), Verdict::Skip);
}

#[test]
fn a_branch_behind_its_merged_head_is_kept_in_its_own_words() {
    let f = fixture();
    let local = repo_with_branch(&f.repo, BRANCH, 1_700_000_000);
    // The pull request's head was pushed from elsewhere: one commit past
    // this Mac's branch.
    let tree = git(&f.repo, &["rev-parse", &format!("{local}^{{tree}}")]);
    let head = git(&f.repo, &["commit-tree", &tree, "-p", &local, "-m", "pushed from elsewhere"]);
    let mut c = card(CARD);
    c.branch_cleanup = Some(BranchCleanup::new(BRANCH, &head, CleanupReason::PrMerged, NOW - 8 * DAY_MS, None));
    let verdict = sweep_card(&env(&f.repo, &no_session), &c);
    assert_eq!(verdict, Verdict::Behind);
    let mut rec = c.branch_cleanup.clone().unwrap();
    assert!(settle(&mut rec, &verdict, NOW));
    assert_eq!(rec.outcome, Some(CleanupOutcome::Behind));
    assert!(branch_exists(&f.repo, BRANCH));

    // A head this Mac never fetched: behind too, never "after it shipped".
    c.branch_cleanup.as_mut().unwrap().tip = "1234567890abcdef1234567890abcdef12345678".into();
    assert_eq!(sweep_card(&env(&f.repo, &no_session), &c), Verdict::Behind);
}

#[test]
fn restart_candidates_are_the_cards_own_branches_only() {
    let mut c = card(CARD);
    let own = crate::worktrees::make_branch_name(CARD, "Tidy the header");
    let restart_candidates = |c: &KanbanCard| restart_candidates(c, Some(std::slice::from_ref(c)));
    assert_eq!(restart_candidates(&c), vec![own.clone(), own.replace("plyloft/card-", "atelier/card-")]);
    for outcome in [None, Some(CleanupOutcome::MovedOn), Some(CleanupOutcome::Behind), Some(CleanupOutcome::Declined), Some(CleanupOutcome::Restored)] {
        let mut rec = BranchCleanup::new("plyloft/card-abc12345-old-title", "t", CleanupReason::Shipped, 1, None);
        rec.outcome = outcome;
        c.branch_cleanup = Some(rec);
        assert_eq!(restart_candidates(&c)[0], "plyloft/card-abc12345-old-title", "{outcome:?}");
    }
    for outcome in [CleanupOutcome::Deleted, CleanupOutcome::Gone] {
        c.branch_cleanup.as_mut().unwrap().outcome = Some(outcome);
        assert_eq!(restart_candidates(&c)[0], own, "{outcome:?}: the recorded branch is gone");
    }
    c.branch_cleanup.as_mut().unwrap().branch = "main".into();
    c.branch_cleanup.as_mut().unwrap().outcome = None;
    assert!(!restart_candidates(&c).contains(&"main".to_string()), "never a branch that isn't a card's");
}

/// Archiving a shipped card whose branch has moved on since the release
/// goes through the Inbox ask — never a silent "kept"; at the released tip
/// the release's own record stands.
#[test]
fn archiving_a_shipped_card_whose_branch_moved_on_asks() {
    let f = fixture();
    let released = repo_with_branch(&f.repo, BRANCH, 1_700_000_000);
    let mut c = card(CARD);
    c.branch_cleanup = Some(BranchCleanup::new(BRANCH, &released, CleanupReason::Shipped, 1, None));
    assert!(archive_record(&c, &f.repo, NOW).is_none(), "at the released tip: nothing new");

    let tree = git(&f.repo, &["rev-parse", &format!("{released}^{{tree}}")]);
    let later = git(&f.repo, &["commit-tree", &tree, "-p", &released, "-m", "after the ship"]);
    git(&f.repo, &["update-ref", &format!("refs/heads/{BRANCH}"), &later]);
    for outcome in [None, Some(CleanupOutcome::MovedOn)] {
        let mut shipped = c.clone();
        shipped.branch_cleanup.as_mut().unwrap().outcome = outcome;
        let rec = archive_record(&shipped, &f.repo, NOW).unwrap();
        assert_eq!((rec.reason, rec.tip.as_str()), (CleanupReason::Archived, later.as_str()));
        stamp(&mut shipped, rec.clone());
        assert_eq!(shipped.branch_cleanup.as_ref(), Some(&rec), "{outcome:?}: the archive's record wins");
    }
    // Deleted or declined: nothing to ask about.
    let mut done = c.clone();
    done.branch_cleanup.as_mut().unwrap().outcome = Some(CleanupOutcome::Deleted);
    assert!(archive_record(&done, &f.repo, NOW).is_none());
}

#[test]
fn a_release_records_the_released_commit_never_the_tip() {
    let f = fixture();
    let released = repo_with_branch(&f.repo, BRANCH, 1_700_000_000);
    let tree = git(&f.repo, &["rev-parse", &format!("{released}^{{tree}}")]);
    let later = git(&f.repo, &["commit-tree", &tree, "-p", &released, "-m", "after the release"]);
    git(&f.repo, &["update-ref", &format!("refs/heads/{BRANCH}"), &later]);
    let mut c = card(CARD);
    c.branch_name = Some(BRANCH.into());
    assert!(release_record(&c, &f.repo, None, None, NOW).is_none(), "no released commit, no record");
    let rec = release_record(&c, &f.repo, Some(&released), None, NOW).unwrap();
    assert_eq!(rec.tip, released);
    let mut shipped = card(CARD);
    shipped.branch_cleanup = Some(BranchCleanup { since: NOW - 8 * DAY_MS, ..rec });
    assert_eq!(sweep_card(&env(&f.repo, &no_session), &shipped), Verdict::MovedOn);
    assert!(branch_exists(&f.repo, BRANCH));
}

// ── The record ───────────────────────────────────────────────────────

#[test]
fn record_pins_the_card_branch_and_skips_anything_else() {
    let f = fixture();
    let tip = repo_with_branch(&f.repo, BRANCH, 1_700_000_000);
    let mut c = card(CARD);
    assert!(record(&c, &f.repo, CleanupReason::Shipped, None, None, NOW).is_none(), "no branch recorded");
    c.branch_name = Some("main".into());
    assert!(record(&c, &f.repo, CleanupReason::Shipped, None, None, NOW).is_none(), "not a card branch");
    c.branch_name = Some(BRANCH.into());
    let rec = record(&c, &f.repo, CleanupReason::Landed, None, Some(Path::new("/t/e")), NOW).unwrap();
    assert_eq!((rec.tip.as_str(), rec.reason, rec.since), (tip.as_str(), CleanupReason::Landed, NOW));
    assert_eq!(rec.trash_entry.as_deref(), Some("/t/e"));
    let merged = record(&c, &f.repo, CleanupReason::PrMerged, Some("abc"), None, NOW).unwrap();
    assert_eq!(merged.tip, "abc", "a merged pull request pins its head");
    c.branch_name = Some("plyloft/card-zzzz9999-gone".into());
    assert!(record(&c, &f.repo, CleanupReason::Shipped, None, None, NOW).is_none(), "nothing to pin");
}

#[test]
fn archiving_a_shipped_card_keeps_its_automatic_cleanup() {
    let mut c = card(CARD);
    let shipped = BranchCleanup::new(BRANCH, "t1", CleanupReason::Shipped, 1, None);
    stamp(&mut c, shipped.clone());
    stamp(&mut c, BranchCleanup::new(BRANCH, "t1", CleanupReason::Archived, 2, None));
    assert_eq!(c.branch_cleanup.as_ref(), Some(&shipped));
    // Shipped again: the new tip replaces it.
    let again = BranchCleanup::new(BRANCH, "t2", CleanupReason::Shipped, 3, None);
    stamp(&mut c, again.clone());
    assert_eq!(c.branch_cleanup.as_ref(), Some(&again));
}

/// A board written before N18 loads with no record and writes none back; a
/// record round-trips; values a later build writes read as Unknown instead
/// of failing the board.
#[test]
fn schema_a_board_from_before_n18_loads_and_a_record_round_trips() {
    let old = r#"{
        "id": "c1", "workspaceId": "ws", "title": "t", "columnId": "complete",
        "createdAt": 1, "updatedAt": 2, "branchName": null
    }"#;
    let card: KanbanCard = serde_json::from_str(old).unwrap();
    assert!(card.branch_cleanup.is_none());
    let back = serde_json::to_value(&card).unwrap();
    assert!(back.get("branchCleanup").is_none(), "not written while absent");

    let mut with = card.clone();
    let mut rec = BranchCleanup::new(BRANCH, "abc", CleanupReason::PrMerged, 5, Some(Path::new("/x")));
    rec.outcome = Some(CleanupOutcome::Deleted);
    rec.outcome_at = Some(9);
    with.branch_cleanup = Some(rec.clone());
    let json = serde_json::to_value(&with).unwrap();
    assert_eq!(json["branchCleanup"]["reason"], "prMerged");
    assert_eq!(json["branchCleanup"]["outcome"], "deleted");
    assert_eq!(json["branchCleanup"]["trashEntry"], "/x");
    assert!(json["branchCleanup"].get("asking").is_none());
    let parsed: KanbanCard = serde_json::from_value(json).unwrap();
    assert_eq!(parsed.branch_cleanup, Some(rec));

    let newer = r#"{
        "id": "c1", "workspaceId": "ws", "title": "t", "columnId": "complete",
        "createdAt": 1, "updatedAt": 2,
        "branchCleanup": { "branch": "plyloft/card-x-y", "tip": "abc", "reason": "squashedLater",
                           "since": 1, "outcome": "archivedElsewhere", "futureField": true }
    }"#;
    let card: KanbanCard = serde_json::from_str(newer).unwrap();
    let rec = card.branch_cleanup.unwrap();
    assert_eq!(rec.reason, CleanupReason::Unknown);
    assert_eq!(rec.outcome, Some(CleanupOutcome::Unknown));
}

#[test]
fn schema_a_board_file_from_before_n18_loads_through_the_store() {
    let tmp = tempfile::tempdir().unwrap();
    let state = tmp.path().join("state");
    let store = KanbanStore::new(state.clone()).unwrap();
    store.create_card("ws", card(CARD)).unwrap();
    // The board on disk carries no branchCleanup key while no card has one.
    let path = walk(&state)
        .into_iter()
        .find(|p| p.file_name().is_some_and(|n| n == "ws.json"))
        .unwrap();
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(!raw.contains("branchCleanup"));
    let again = KanbanStore::new(state).unwrap();
    assert!(again.get_card("ws", CARD).unwrap().branch_cleanup.is_none());
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(walk(&p));
        } else {
            out.push(p);
        }
    }
    out
}

// ── The backlog ──────────────────────────────────────────────────────

fn shipped_at(c: &mut KanbanCard, at_ms: i64) {
    c.ship_history.push(ShipEntry {
        commit_sha: "s".into(),
        shipped_version: "1.0.0".into(),
        release_kind: ReleaseKind::Local,
        shipped_at: at_ms,
        target: None,
        tag: None,
    });
}

fn titled(id: &str, title: &str) -> KanbanCard {
    KanbanCard::new(id.into(), "ws".into(), title.into(), None, KanbanColumnId::Complete)
}

/// The branch Plyloft would have made for `card`.
fn name_of(card: &KanbanCard) -> String {
    crate::worktrees::make_branch_name(&card.id, &card.title)
}

/// Squash-merge `branch` into `main`, as Ship and Land do.
fn squash_into_main(repo: &Path, branch: &str, secs: i64) {
    git(repo, &["merge", "-q", "--squash", branch]);
    git_at(repo, &["commit", "-q", "-m", &format!("Land {branch}")], Some(secs));
}

#[test]
fn the_backlog_offers_only_branches_its_rule_proves() {
    let f = fixture();
    let ship_secs = 1_700_000_000;
    let ship_ms = ship_secs * 1000;
    let me = Me { email: Some("me@x.test"), login: Some("me") };
    // Shipped, squash-merged, committed before the ship: offered.
    let mut ok = titled(CARD, "Tidy the header");
    shipped_at(&mut ok, ship_ms);
    let ok_tip = repo_with_branch(&f.repo, &name_of(&ok), ship_secs - 60);
    squash_into_main(&f.repo, &name_of(&ok), ship_secs - 50);
    // Its Build with both variant: never offered.
    git(&f.repo, &["branch", &format!("{}-b", name_of(&ok)), &name_of(&ok)]);
    // Legacy prefix, shipped and merged: offered too.
    let mut leg = titled("card-legacy01-0", "Old footer");
    shipped_at(&mut leg, ship_ms);
    let legacy = name_of(&leg).replace("plyloft/card-", "atelier/card-");
    repo_with_branch(&f.repo, &legacy, ship_secs - 60);
    squash_into_main(&f.repo, &legacy, ship_secs - 40);
    // Shipped but its content is not in main: not offered.
    let mut unmerged = titled("card-unmerg01-0", "Never landed");
    shipped_at(&mut unmerged, ship_ms);
    repo_with_branch(&f.repo, &name_of(&unmerged), ship_secs - 60);
    // Committed after its last ship: not offered.
    let mut late = titled("card-late0001-0", "Late");
    shipped_at(&mut late, ship_ms);
    repo_with_branch(&f.repo, &name_of(&late), ship_secs + 60);
    squash_into_main(&f.repo, &name_of(&late), ship_secs + 70);
    // Checked out by hand: not offered.
    let mut held = titled("card-held0001-0", "Held");
    shipped_at(&mut held, ship_ms);
    repo_with_branch(&f.repo, &name_of(&held), ship_secs - 60);
    squash_into_main(&f.repo, &name_of(&held), ship_secs - 30);
    let wt = f.repo.join("../held");
    git(&f.repo, &["worktree", "add", "-q", wt.to_str().unwrap(), &name_of(&held)]);
    // Someone else's team card: not offered.
    let mut theirs = titled("card-their001-0", "Theirs");
    shipped_at(&mut theirs, ship_ms);
    theirs.gh_issue_number = Some(3);
    theirs.gh_assignees = vec!["bob".into()];
    repo_with_branch(&f.repo, &name_of(&theirs), ship_secs - 60);
    squash_into_main(&f.repo, &name_of(&theirs), ship_secs - 20);
    // Archived without shipping: offered, for the Inbox ask.
    let mut arch = titled("card-arch0001-0", "Dropped idea");
    arch.archived = true;
    arch.archived_at = Some(123);
    repo_with_branch(&f.repo, &name_of(&arch), ship_secs - 60);
    // Never shipped, not archived: not offered.
    let open = titled("card-open0001-0", "Open");
    repo_with_branch(&f.repo, &name_of(&open), ship_secs - 60);
    // A branch whose title part no card has: not offered.
    repo_with_branch(&f.repo, "plyloft/card-abc12345-another-title", ship_secs - 60);

    let cards = vec![ok.clone(), leg, unmerged, late, held, theirs, arch.clone(), open];
    let items = scan_backlog(&f.repo, "main", &cards, me, &no_session, NOW).unwrap();
    let names: Vec<(String, bool)> = items.iter().map(|i| (i.branch.clone(), i.archived)).collect();
    let mut want = vec![(legacy.clone(), false), (name_of(&ok), false), (name_of(&arch), true)];
    want.sort();
    assert_eq!(names, want);
    let first = items.iter().find(|i| i.branch == name_of(&ok)).unwrap();
    assert_eq!(first.tip, ok_tip);
    assert_eq!(first.since, ship_ms);
    assert_eq!(items.iter().find(|i| i.archived).unwrap().since, 123);

    // A live session holds its card's branch back.
    let busy = |c: &KanbanCard| c.id == CARD;
    let items = scan_backlog(&f.repo, "main", &cards, me, &busy, NOW).unwrap();
    assert!(items.iter().all(|i| i.branch != name_of(&ok)));

    // Without git, nothing is offered — and the scan says it could not look.
    assert!(scan_backlog(&f._tmp.path().join("not-a-repo"), "main", &cards, me, &no_session, NOW).is_none());
}

/// Challenger M1, then TM-2 (1.175.0): gh-issue ids shared their short id
/// (`gh-issue-6`, `-62`, `-61` → `ghissue6`) and only the title slug told
/// their branches apart. A branch made then is still found for its card,
/// by that earlier name; a name two cards would have made proves neither.
#[test]
fn the_backlog_finds_an_issue_card_s_branch_from_before_its_short_id_changed() {
    let f = fixture();
    let ship_secs = 1_700_000_000;
    let me = Me { email: Some("me@x.test"), login: Some("me") };
    let mut six = titled("gh-issue-6", "Six");
    let mut sixty_two = titled("gh-issue-62", "Sixty two");
    let mut sixty_one = titled("gh-issue-61", "Sixty one");
    for c in [&mut six, &mut sixty_two, &mut sixty_one] {
        shipped_at(c, ship_secs * 1000);
    }
    assert_eq!(crate::worktrees::branch_short_id("gh-issue-62"), "issue62");
    assert_eq!(name_of(&six), "plyloft/card-issue6-six");
    let earlier = "plyloft/card-ghissue6-sixty-two";
    assert_eq!(
        expected_names(&sixty_two),
        [
            "plyloft/card-issue62-sixty-two",
            "atelier/card-issue62-sixty-two",
            earlier,
            "atelier/card-ghissue6-sixty-two",
        ]
    );
    // Only #62's branch exists, made before the update, merged.
    repo_with_branch(&f.repo, earlier, ship_secs - 60);
    squash_into_main(&f.repo, earlier, ship_secs - 50);
    let items = scan_backlog(&f.repo, "main", &[six, sixty_two.clone(), sixty_one], me, &no_session, NOW).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].card_id, "gh-issue-62");
    assert_eq!(items[0].branch, earlier);

    // Two issues with one title made that one name: it proves neither.
    let mut twin = titled("gh-issue-63", "Sixty two");
    shipped_at(&mut twin, ship_secs * 1000);
    assert_ne!(name_of(&twin), name_of(&sixty_two), "from 1.175.0 each has its own");
    assert!(expected_names(&twin).contains(&earlier.to_string()));
    let items = scan_backlog(&f.repo, "main", &[sixty_two.clone(), twin], me, &no_session, NOW).unwrap();
    assert!(items.is_empty());

    // The same with today's name: #62's own branch is #62's alone.
    let own = name_of(&sixty_two);
    git(&f.repo, &["branch", "-m", earlier, &own]);
    let twin = {
        let mut twin = titled("gh-issue-63", "Sixty two");
        shipped_at(&mut twin, ship_secs * 1000);
        twin
    };
    let items = scan_backlog(&f.repo, "main", &[sixty_two, twin], me, &no_session, NOW).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!((items[0].card_id.as_str(), items[0].branch.as_str()), ("gh-issue-62", own.as_str()));
}

/// TM-2 (fix round 1): `ghissue<d>-<slug>` was every same-title issue's
/// name, so a start picks it up only for a card that was started before and
/// only while no other card records it or, started before too, would have
/// made it. The name only this card makes comes first.
#[test]
fn an_earlier_issue_branch_name_is_picked_up_only_by_the_card_it_can_be() {
    let earlier = "plyloft/card-ghissue1-update-docs";
    let own = |n: u64| vec![format!("plyloft/card-issue{n}-update-docs"), format!("atelier/card-issue{n}-update-docs")];
    let with_earlier = |n: u64| [own(n), vec![earlier.to_string(), "atelier/card-ghissue1-update-docs".to_string()]].concat();
    let never_started = |n: u64| titled(&format!("gh-issue-{n}"), "Update docs");
    let started = |n: u64| {
        let mut card = never_started(n);
        shipped_at(&mut card, 1_700_000_000_000);
        card
    };

    // #12 was started before the update; #150, same title, never was.
    let board = [started(12), never_started(150)];
    assert_eq!(restart_candidates(&board[0], Some(&board)), with_earlier(12), "#12 still finds its branch");
    assert_eq!(restart_candidates(&board[1], Some(&board)), own(150), "#150 starts on its own");

    // Both were started before: the name proves neither.
    let board = [started(12), started(150)];
    assert_eq!(restart_candidates(&board[0], Some(&board)), own(12));
    assert_eq!(restart_candidates(&board[1], Some(&board)), own(150));

    // Another card records the branch: it is that card's.
    let mut holder = never_started(150);
    holder.branch_name = Some(earlier.into());
    let board = [started(12), holder];
    assert_eq!(restart_candidates(&board[0], Some(&board)), own(12));
    let mut cleaned = never_started(150);
    cleaned.branch_cleanup = Some(BranchCleanup::new(earlier, "t", CleanupReason::Shipped, 1, None));
    let board = [started(12), cleaned];
    assert!(!restart_candidates(&board[0], Some(&board)).contains(&earlier.to_string()));
    // …and for the card that records it, its record comes first, as ever.
    assert_eq!(restart_candidates(&board[1], Some(&board))[0], earlier);

    // A board that couldn't be read: no earlier name is offered at all.
    assert_eq!(restart_candidates(&started(12), None), own(12));
    // A card that isn't an issue's has no earlier name.
    let mut local = titled("card-moxa1234-1", "Update docs");
    shipped_at(&mut local, 1_700_000_000_000);
    assert_eq!(restart_candidates(&local, Some(std::slice::from_ref(&local))).len(), 2);
}

/// TM-2 (fix round 1), on a repository: #12's branch from before the update
/// is free. #150, same title and never started, is cut a branch of its own
/// and #12's is untouched; #12 starting again gets its branch back.
#[test]
fn a_new_issue_card_never_takes_an_earlier_card_s_branch() {
    let f = fixture();
    let earlier = "plyloft/card-ghissue1-update-docs";
    let tip = repo_with_branch(&f.repo, earlier, 1_700_000_000);
    let mut twelve = titled("gh-issue-12", "Update docs");
    shipped_at(&mut twelve, 1_700_000_100_000);
    let board = [twelve, titled("gh-issue-150", "Update docs")];
    let pick_up = |card: &KanbanCard| {
        restart_candidates(card, Some(&board))
            .iter()
            .find_map(|b| crate::worktrees::reattach_card_branch(&f.repo, &card.id, None, Some(b)))
    };

    assert!(pick_up(&board[1]).is_none(), "#150 has nothing to pick up");
    let made = crate::worktrees::ensure_for_card(&f.repo, "gh-issue-150", "Update docs", "main").unwrap();
    assert!(made.created);
    assert_eq!(made.branch_name, "plyloft/card-issue150-update-docs");
    assert_eq!(git(&f.repo, &["rev-parse", earlier]).trim(), tip, "#12's branch is untouched");
    assert!(!checked_out_branches(&f.repo).unwrap().contains(earlier), "and still free");

    let again = pick_up(&board[0]).expect("#12 finds its branch");
    assert_eq!(again.branch_name, earlier);
    assert_eq!(git(&again.worktree_path, &["rev-parse", "HEAD"]).trim(), tip);
}

#[test]
fn merging_changes_nothing_is_the_content_proof() {
    let f = fixture();
    let tip = repo_with_branch(&f.repo, BRANCH, 1_700_000_000);
    assert!(!merging_changes_nothing(&f.repo, "main", &tip), "its change is not in main");
    squash_into_main(&f.repo, BRANCH, 1_700_000_010);
    assert!(merging_changes_nothing(&f.repo, "main", &tip), "squash-merged: merging changes nothing");
    assert!(!merging_changes_nothing(&f.repo, "no-such-branch", &tip));
}

#[test]
fn delete_n_branches_deletes_what_still_passes_and_queues_the_archived() {
    let f = fixture();
    let ship_secs = 1_700_000_000;
    let mut ok = titled(CARD, "Tidy the header");
    shipped_at(&mut ok, ship_secs * 1000);
    let tip = repo_with_branch(&f.repo, &name_of(&ok), ship_secs - 60);
    squash_into_main(&f.repo, &name_of(&ok), ship_secs - 55);
    let mut moved_card = titled("card-moved001-0", "Moved");
    shipped_at(&mut moved_card, ship_secs * 1000);
    let moved = name_of(&moved_card);
    repo_with_branch(&f.repo, &moved, ship_secs - 60);
    squash_into_main(&f.repo, &moved, ship_secs - 50);
    let mut arch_card = titled("card-arch0001-0", "Dropped");
    arch_card.archived = true;
    arch_card.archived_at = Some(NOW - 30 * DAY_MS);
    let arch = name_of(&arch_card);
    repo_with_branch(&f.repo, &arch, ship_secs - 60);
    let store = store_with(f._tmp.path(), vec![ok, moved_card, arch_card]);
    let e = env(&f.repo, &no_session);
    let offered = scan_backlog(&f.repo, "main", &store.load("ws").unwrap(), e.me, &no_session, NOW).unwrap();
    assert_eq!(offered.len(), 3);

    // Between the offer and the answer, one branch gets a commit (dated
    // before the ship, so only the tip check can catch it).
    let wt = f.repo.join("../moved");
    git(&f.repo, &["worktree", "add", "-q", wt.to_str().unwrap(), &moved]);
    std::fs::write(wt.join("more.txt"), "x").unwrap();
    git(&wt, &["add", "."]);
    git_at(&wt, &["commit", "-q", "-m", "more"], Some(ship_secs - 30));
    git(&f.repo, &["worktree", "remove", "--force", wt.to_str().unwrap()]);

    let report = apply_backlog(&store, "ws", "main", &offered, &e).unwrap();
    assert_eq!(report, BacklogReport { deleted: 1, kept: 1, queued: 1 });
    assert!(!branch_exists(&f.repo, &name_of(&store.get_card("ws", CARD).unwrap())));
    assert!(branch_exists(&f.repo, &moved), "its tip moved since the offer");
    assert!(branch_exists(&f.repo, &arch), "archived: asked in the Inbox, not deleted");

    let rec = store.get_card("ws", CARD).unwrap().branch_cleanup.unwrap();
    assert_eq!(rec.outcome, Some(CleanupOutcome::Deleted));
    assert_eq!(rec.tip, tip);
    let asked = asks(&store.load("ws").unwrap());
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].branch, arch);

    // A repository that can't be read is an error, not "nothing to do".
    assert!(apply_backlog(&store, "ws", "main", &offered, &env(&f._tmp.path().join("gone"), &no_session)).is_err());
}

#[test]
fn the_backlog_is_offered_until_answered_and_not_now_waits_a_week() {
    assert!(backlog_open(None, NOW));
    let answer = |word: &str, at: i64| BacklogAnswer { answer: word.into(), at };
    assert!(!backlog_open(Some(&answer("never", 0)), NOW));
    assert!(!backlog_open(Some(&answer("deleted", 0)), NOW));
    assert!(!backlog_open(Some(&answer("nothing", 0)), NOW));
    assert!(!backlog_open(Some(&answer("notNow", NOW - DAY_MS)), NOW));
    assert!(backlog_open(Some(&answer("notNow", NOW - 8 * DAY_MS)), NOW));
}
