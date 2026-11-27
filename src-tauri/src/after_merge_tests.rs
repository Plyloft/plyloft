//! G5 tests: the branch on GitHub is deleted only at the merged head and
//! only when it is the card's; this computer is fast-forwarded only when
//! that is safe, and says why when it isn't; nothing else is touched.

use super::*;
use std::cell::RefCell;
use std::path::PathBuf;

const URL: &str = "https://github.com/acme/app/pull/12";
const BRANCH: &str = "plyloft/card-c1abcdef-add-sum";
const HEAD: &str = "1111111111111111111111111111111111111111";

struct FakeRemote {
    slug: Option<String>,
    refs: Result<OriginRefs, String>,
    /// What every read after the first says, when it differs (a push, or a
    /// failure, between the checks and the delete).
    then: Option<Result<OriginRefs, String>>,
    answer: DeleteAnswer,
    deletes: RefCell<Vec<(String, String)>>,
    reads: RefCell<u32>,
    open: Result<bool, String>,
    listed: RefCell<Vec<(String, String)>>,
}

impl FakeRemote {
    fn at(tip: Option<&str>) -> Self {
        Self {
            slug: Some("acme/app".into()),
            refs: Ok(OriginRefs { default_branch: Some("main".into()), branch_tip: tip.map(String::from) }),
            then: None,
            answer: DeleteAnswer::Deleted,
            deletes: RefCell::new(Vec::new()),
            reads: RefCell::new(0),
            open: Ok(false),
            listed: RefCell::new(Vec::new()),
        }
    }
}

impl Remote for FakeRemote {
    fn origin_slug(&self) -> Option<String> {
        self.slug.clone()
    }
    fn origin_refs(&self, _branch: &str) -> Result<OriginRefs, String> {
        *self.reads.borrow_mut() += 1;
        match &self.then {
            Some(later) if *self.reads.borrow() > 1 => later.clone(),
            _ => self.refs.clone(),
        }
    }
    fn delete_branch(&self, slug: &str, branch: &str) -> Result<DeleteAnswer, String> {
        self.deletes.borrow_mut().push((slug.into(), branch.into()));
        Ok(self.answer.clone())
    }
    fn open_prs_use(&self, slug: &str, branch: &str) -> Result<bool, String> {
        self.listed.borrow_mut().push((slug.into(), branch.into()));
        self.open.clone()
    }
}

/// The pull request's own head: `branch`, of the same repository.
fn own(branch: &str) -> PrHead<'_> {
    PrHead { name: Some(branch), cross_repository: Some(false) }
}

fn del(remote: &FakeRemote, branch: &str, head: &str, target: &str) -> BranchOutcome {
    delete_merged_branch(remote, URL, branch, own(branch), head, target)
}

#[test]
fn the_branch_is_deleted_only_while_github_has_it_at_the_merged_head() {
    let remote = FakeRemote::at(Some(HEAD));
    assert_eq!(del(&remote, BRANCH, HEAD, "main"), BranchOutcome::Deleted);
    assert_eq!(*remote.deletes.borrow(), vec![("acme/app".to_string(), BRANCH.to_string())]);

    // A short head (as GitHub may say it) is the same commit.
    let remote = FakeRemote::at(Some(HEAD));
    assert_eq!(del(&remote, BRANCH, &HEAD[..12], "main"), BranchOutcome::Deleted);

    // Someone pushed to it after the merge: kept, nothing deleted.
    let remote = FakeRemote::at(Some("2222222222222222222222222222222222222222"));
    assert!(matches!(del(&remote, BRANCH, HEAD, "main"), BranchOutcome::Kept(_)));
    assert!(remote.deletes.borrow().is_empty());
}

/// 1.175.0 (A8, OP-7): the branch is read again right before the delete. A
/// push that reached it while Plyloft was asking about open pull requests
/// keeps it; so does a read that fails; a branch gone meanwhile is gone.
#[test]
fn a_push_between_the_checks_and_the_delete_keeps_the_branch() {
    let moved = |tip: Option<&str>| Ok(OriginRefs { default_branch: Some("main".into()), branch_tip: tip.map(String::from) });
    let mut remote = FakeRemote::at(Some(HEAD));
    remote.then = Some(moved(Some("2222222222222222222222222222222222222222")));
    assert_eq!(
        del(&remote, BRANCH, HEAD, "main"),
        BranchOutcome::Kept(format!("{BRANCH} has commits on GitHub the pull request didn't merge"))
    );
    assert!(remote.deletes.borrow().is_empty(), "nothing deleted");
    assert_eq!(*remote.reads.borrow(), 2, "read before the checks and before the delete");
    assert_eq!(remote.listed.borrow().len(), 1, "the second read comes after the pull request question");

    let mut remote = FakeRemote::at(Some(HEAD));
    remote.then = Some(Err("could not resolve host".into()));
    assert!(matches!(del(&remote, BRANCH, HEAD, "main"), BranchOutcome::Failed(_)));
    assert!(remote.deletes.borrow().is_empty());

    let mut remote = FakeRemote::at(Some(HEAD));
    remote.then = Some(moved(None));
    assert_eq!(del(&remote, BRANCH, HEAD, "main"), BranchOutcome::AlreadyGone);
    assert!(remote.deletes.borrow().is_empty());

    // Unmoved: deleted, after two reads.
    let remote = FakeRemote::at(Some(HEAD));
    assert_eq!(del(&remote, BRANCH, HEAD, "main"), BranchOutcome::Deleted);
    assert_eq!(*remote.reads.borrow(), 2);
}

#[test]
fn a_branch_github_already_deleted_is_fine() {
    // The repository deletes head branches itself: ls-remote finds nothing.
    let remote = FakeRemote::at(None);
    assert_eq!(del(&remote, BRANCH, HEAD, "main"), BranchOutcome::AlreadyGone);
    assert!(remote.deletes.borrow().is_empty());
    // Deleted between the read and the call: GitHub's 422.
    let mut remote = FakeRemote::at(Some(HEAD));
    remote.answer = read_delete_answer(false, "gh: Reference does not exist (HTTP 422)\n");
    assert_eq!(del(&remote, BRANCH, HEAD, "main"), BranchOutcome::AlreadyGone);
}

#[test]
fn never_the_target_the_default_branch_or_a_branch_that_isnt_the_cards() {
    for (branch, target) in [("main", "main"), ("feature/x", "main"), ("plyloft/card-c1-x", "plyloft/card-c1-x")] {
        let remote = FakeRemote::at(Some(HEAD));
        assert!(
            matches!(del(&remote, branch, HEAD, target), BranchOutcome::Kept(_)),
            "{branch}"
        );
        assert!(remote.deletes.borrow().is_empty(), "{branch}");
        assert_eq!(*remote.reads.borrow(), 0, "{branch}: not even read");
    }
    // A card-named branch that is GitHub's default.
    let mut remote = FakeRemote::at(Some(HEAD));
    remote.refs = Ok(OriginRefs { default_branch: Some(BRANCH.into()), branch_tip: Some(HEAD.into()) });
    assert!(matches!(del(&remote, BRANCH, HEAD, "main"), BranchOutcome::Kept(_)));
    assert!(remote.deletes.borrow().is_empty());
    // The pull request is in another repository than this folder's origin.
    let mut remote = FakeRemote::at(Some(HEAD));
    remote.slug = Some("someone/else".into());
    assert!(matches!(del(&remote, BRANCH, HEAD, "main"), BranchOutcome::Kept(_)));
    assert!(remote.deletes.borrow().is_empty());
    // Offline: left as it is.
    let mut remote = FakeRemote::at(Some(HEAD));
    remote.refs = Err("could not resolve host".into());
    assert!(matches!(del(&remote, BRANCH, HEAD, "main"), BranchOutcome::Failed(_)));
    assert!(remote.deletes.borrow().is_empty());
}

/// Challenger 5: a branch another open pull request has as its head or its
/// base is someone's still; a pull request whose head isn't this branch of
/// this repository never deletes it.
#[test]
fn a_branch_another_pull_request_uses_or_that_isnt_the_prs_head_is_kept() {
    let mut remote = FakeRemote::at(Some(HEAD));
    remote.open = Ok(true);
    let kept = del(&remote, BRANCH, HEAD, "main");
    assert_eq!(kept, BranchOutcome::Kept(format!("another open pull request uses {BRANCH}")));
    assert!(remote.deletes.borrow().is_empty());
    assert_eq!(*remote.listed.borrow(), vec![("acme/app".to_string(), BRANCH.to_string())]);
    // Couldn't ask: left as it is.
    let mut remote = FakeRemote::at(Some(HEAD));
    remote.open = Err("HTTP 502".into());
    assert!(matches!(del(&remote, BRANCH, HEAD, "main"), BranchOutcome::Failed(_)));
    assert!(remote.deletes.borrow().is_empty());

    for head in [
        PrHead { name: Some("plyloft/card-other-x"), cross_repository: Some(false) },
        PrHead { name: None, cross_repository: Some(false) },
        PrHead { name: Some(BRANCH), cross_repository: Some(true) },
        PrHead { name: Some(BRANCH), cross_repository: None },
    ] {
        let remote = FakeRemote::at(Some(HEAD));
        assert!(matches!(delete_merged_branch(&remote, URL, BRANCH, head, HEAD, "main"), BranchOutcome::Kept(_)), "{head:?}");
        assert!(remote.deletes.borrow().is_empty(), "{head:?}");
        assert_eq!(*remote.reads.borrow(), 0, "{head:?}: not even read");
    }
    assert_eq!(open_prs_listed("[]\n"), Ok(false));
    assert_eq!(open_prs_listed("[{\"number\":7}]"), Ok(true));
    assert!(open_prs_listed("not json").is_err());
}

/// Challenger 7: why the branch stayed on GitHub, short, for the Done card.
#[test]
fn the_reason_a_branch_stayed_is_short() {
    assert_eq!(BranchOutcome::Deleted.kept_reason(), None);
    assert_eq!(BranchOutcome::AlreadyGone.kept_reason(), None);
    let failed = BranchOutcome::Failed("gh: Resource not accessible by integration (HTTP 403).\nmore".into());
    assert_eq!(failed.kept_reason().as_deref(), Some("gh: Resource not accessible by integration (HTTP 403)"));
    let long = BranchOutcome::Kept("x".repeat(400)).kept_reason().unwrap();
    assert_eq!(long.chars().count(), 141);
}

/// Challenger 8: the probe's ssh never asks: batch mode, on the person's own
/// ssh command when there is one.
#[test]
fn the_probes_ssh_runs_in_batch_mode() {
    assert_eq!(with_batch_mode(None), "ssh -o BatchMode=yes");
    assert_eq!(with_batch_mode(Some("ssh -i ~/.ssh/work")), "ssh -i ~/.ssh/work -o BatchMode=yes");
    let source = include_str!("after_merge.rs");
    let probe = source.split("fn origin_refs(&self, branch: &str) -> Result<OriginRefs, String> {").nth(1).unwrap().split("\n    }\n").next().unwrap();
    assert!(probe.contains(".env(\"GIT_SSH_COMMAND\", batch_ssh_command(self.cwd))"));
}

#[test]
fn ls_remote_and_ghs_answers_are_read() {
    let out = format!("ref: refs/heads/main\tHEAD\n{HEAD}\tHEAD\n{HEAD}\trefs/heads/{BRANCH}\n");
    assert_eq!(
        parse_origin_refs(&out, BRANCH),
        OriginRefs { default_branch: Some("main".into()), branch_tip: Some(HEAD.into()) }
    );
    assert_eq!(parse_origin_refs("ref: refs/heads/trunk\tHEAD\nabc\tHEAD\n", BRANCH).branch_tip, None);
    assert_eq!(read_delete_answer(true, ""), DeleteAnswer::Deleted);
    assert!(matches!(read_delete_answer(false, "HTTP 403: Resource not accessible"), DeleteAnswer::Refused(_)));
    assert_eq!(pr_repo_slug(URL).as_deref(), Some("acme/app"));
    assert_eq!(pr_repo_slug("https://gitlab.com/acme/app/pull/1"), None);
    assert_eq!(pr_repo_slug("https://github.com/acme/app/issues/1"), None);
}

// ── Real git: the stale ref and this computer ───────────────────────────

fn git(dir: &Path, args: &[&str]) -> String {
    let mut all = vec!["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgSign=false"];
    all.extend_from_slice(args);
    crate::git::capture(dir, &all).unwrap_or_else(|e| panic!("git {args:?}: {e}"))
}

fn rev(dir: &Path, name: &str) -> String {
    git(dir, &["rev-parse", name]).trim().to_string()
}

/// An origin with `main` one commit ahead of the clone `work`, which also
/// has the card's branch and a branch of the person's own.
fn behind_clone(root: &Path) -> (PathBuf, PathBuf) {
    let origin = root.join("origin.git");
    let seed = root.join("seed");
    let work = root.join("work");
    std::fs::create_dir_all(&seed).unwrap();
    git(root, &["init", "-q", "--bare", "--initial-branch=main", &origin.to_string_lossy()]);
    git(&seed, &["init", "-q", "--initial-branch=main", "."]);
    std::fs::write(seed.join("a.txt"), "1\n").unwrap();
    git(&seed, &["add", "a.txt"]);
    git(&seed, &["commit", "-q", "--no-verify", "-m", "one"]);
    git(&seed, &["remote", "add", "origin", &origin.to_string_lossy()]);
    git(&seed, &["push", "-q", "origin", "main"]);
    git(root, &["clone", "-q", &origin.to_string_lossy(), &work.to_string_lossy()]);
    git(&work, &["branch", BRANCH]);
    git(&work, &["branch", "mine"]);
    // The merge lands on GitHub.
    std::fs::write(seed.join("a.txt"), "2\n").unwrap();
    git(&seed, &["commit", "-q", "--no-verify", "-am", "merged card"]);
    git(&seed, &["push", "-q", "origin", "main"]);
    (origin, work)
}

#[test]
fn a_clean_folder_on_the_target_is_brought_up_to_date() {
    let dir = tempfile::tempdir().unwrap();
    let (origin, work) = behind_clone(dir.path());
    let (card, mine) = (rev(&work, BRANCH), rev(&work, "mine"));
    assert_ne!(rev(&work, "main"), rev(&origin, "main"));
    assert_eq!(bring_up_to_date(&work, "main"), None);
    assert_eq!(rev(&work, "main"), rev(&origin, "main"), "local main equals GitHub's");
    assert_eq!(std::fs::read_to_string(work.join("a.txt")).unwrap(), "2\n");
    // Never touches other branches.
    assert_eq!((rev(&work, BRANCH), rev(&work, "mine")), (card, mine));
    // Again: up to date, nothing to offer.
    assert_eq!(bring_up_to_date(&work, "main"), None);
}

#[test]
fn a_folder_with_changes_isnt_moved_and_says_why() {
    let dir = tempfile::tempdir().unwrap();
    let (origin, work) = behind_clone(dir.path());
    let before = rev(&work, "main");
    std::fs::write(work.join("a.txt"), "my edit\n").unwrap();
    assert_eq!(bring_up_to_date(&work, "main").map(|r| r.words).as_deref(), Some(DIRTY_WORDS));
    assert_eq!(rev(&work, "main"), before);
    assert_eq!(std::fs::read_to_string(work.join("a.txt")).unwrap(), "my edit\n", "the edit is kept");
    // The press, once the change is put away, brings it up to date.
    git(&work, &["checkout", "-q", "--", "a.txt"]);
    assert_eq!(bring_up_to_date(&work, "main"), None);
    assert_eq!(rev(&work, "main"), rev(&origin, "main"));
}

/// Challenger 4: the target open in another folder says exactly that —
/// never "This folder is on …".
#[test]
fn a_target_open_in_another_folder_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let (_origin, work) = behind_clone(dir.path());
    git(&work, &["checkout", "-q", "mine"]);
    let elsewhere = dir.path().join("elsewhere");
    git(&work, &["worktree", "add", "-q", &elsewhere.to_string_lossy(), "main"]);
    let before = rev(&work, "main");
    let refused = bring_up_to_date(&work, "main").expect("refused");
    assert_eq!(refused, Refusal { words: "main is open in another folder".into(), press: true });
    assert_eq!(rev(&work, "main"), before);
}

#[test]
fn a_target_nobody_has_open_is_moved_on_its_own() {
    // Da confermare: as the GitHub Issues board's Sync does — `main`, not
    // open in any folder, goes to GitHub's commit; the folder stays on its
    // branch, untouched.
    let dir = tempfile::tempdir().unwrap();
    let (origin, work) = behind_clone(dir.path());
    git(&work, &["checkout", "-q", "mine"]);
    let mine = rev(&work, "mine");
    assert_eq!(bring_up_to_date(&work, "main"), None);
    assert_eq!(rev(&work, "main"), rev(&origin, "main"));
    assert_eq!(rev(&work, "HEAD"), mine);
}

#[test]
fn the_stale_ref_of_the_cards_branch_is_pruned_and_nothing_else() {
    let dir = tempfile::tempdir().unwrap();
    let (_origin, work) = behind_clone(dir.path());
    let head = rev(&work, "HEAD");
    let stale = format!("refs/remotes/origin/{BRANCH}");
    git(&work, &["update-ref", &stale, &head]);
    prune_tracking_ref(&work, BRANCH);
    assert!(crate::git::capture(&work, &["rev-parse", "-q", "--verify", &stale]).is_err());
    assert_eq!(rev(&work, "origin/main"), head, "origin/main kept");
    assert_eq!(rev(&work, BRANCH), head, "the local card branch is N18's sweep's");
    // Nothing there: nothing to do.
    prune_tracking_ref(&work, BRANCH);
}

#[test]
fn the_words_for_each_way_it_can_stay_behind() {
    use crate::worktrees::LocalBranchSync as S;
    let words = |o: &S| refusal_words(o, "main").map(|r| (r.words, r.press));
    assert_eq!(words(&S::UpToDate), None);
    assert_eq!(words(&S::FastForwarded { from: "a".into(), to: "b".into(), commits: 1 }), None);
    assert_eq!(words(&S::Ahead { ahead: 1 }), None);
    assert_eq!(words(&S::NoRemote), None);
    assert_eq!(words(&S::Dirty { behind: 1 }), Some((DIRTY_WORDS.into(), true)));
    let elsewhere = S::CheckedOutElsewhere { path: "/x".into(), behind: 1 };
    assert_eq!(words(&elsewhere), Some(("main is open in another folder".into(), true)));
    assert!(words(&S::Offline { reason: "x".into() }).is_some_and(|(_, press)| press));
    // Challenger 4: commits of its own — only the person can settle it.
    assert_eq!(
        words(&S::Diverged { ahead: 1, behind: 2 }),
        Some(("This computer's main has commits GitHub's doesn't — ship or move them first.".into(), false))
    );
    // Actionable failures pass through, in words.
    let failed = |reason: &str| words(&S::Failed { reason: reason.into() }).unwrap().0;
    assert_eq!(
        failed("a merge is in progress in /x; finish or abort it, then Sync again"),
        "Something git started in your project folder isn't finished"
    );
    assert_eq!(
        failed("another git operation is running in this checkout (/x/.git/index.lock exists); Sync again when it finishes"),
        "Git is busy in your project folder"
    );
    assert_eq!(failed("origin/main missing after fetch"), "Plyloft couldn't do it this time");
}

// ── The card and the Inbox ──────────────────────────────────────────────

fn merged_card(refused: Option<&str>) -> crate::kanban::KanbanCard {
    use crate::kanban::{KanbanCard, KanbanColumnId, ReviewStatus, ShipStatus};
    let mut card = KanbanCard::new("c1".into(), "ws".into(), "Add sum".into(), None, KanbanColumnId::Complete);
    card.pr_url = Some(URL.into());
    card.review_status = Some(ReviewStatus::Merged);
    card.ship_status = ShipStatus::Shipped;
    let mut pr = crate::pr_status::PrStatus::opened(12, 100);
    pr.state = crate::pr_status::PrState::Merged;
    pr.head_sha = Some(HEAD.into());
    pr.merged_at = Some(500);
    pr.up_to_date_refused = refused.map(String::from);
    card.pr = Some(pr);
    card
}

#[test]
fn the_inbox_asks_to_bring_this_computer_up_to_date_while_it_is_behind() {
    use crate::inbox::{InboxEventKind as K, InboxGroup};
    let rows = crate::inbox::derive_card_events("W", &[merged_card(Some(DIRTY_WORDS))], 0);
    let row = rows.iter().find(|e| e.kind == K::BringUpToDate).expect("a row");
    assert_eq!(row.group, InboxGroup::NeedsYou);
    assert_eq!(row.detail.as_deref(), Some(DIRTY_WORDS));
    assert_eq!(row.card_id.as_deref(), Some("c1"));
    let rows = crate::inbox::derive_card_events("W", &[merged_card(None)], 0);
    assert!(rows.iter().all(|e| e.kind != K::BringUpToDate));
    // An archived card asks nothing.
    let mut card = merged_card(Some(DIRTY_WORDS));
    card.archived = true;
    assert!(crate::inbox::derive_card_events("W", &[card], 0).iter().all(|e| e.kind != K::BringUpToDate));
}

#[test]
fn a_read_keeps_the_reason_and_old_cards_load_without_it() {
    // Schema migration: a card written before G5 has no field.
    let old = serde_json::json!({ "number": 12, "state": "merged", "headSha": HEAD, "cleanupKept": null });
    let pr: crate::pr_status::PrStatus = serde_json::from_value(old).unwrap();
    assert_eq!(pr.up_to_date_refused, None);
    let mut card = merged_card(None);
    card.pr = Some(pr);
    let json = serde_json::to_string(&card).unwrap();
    let back: crate::kanban::KanbanCard = serde_json::from_str(&json).unwrap();
    assert_eq!(back.pr.unwrap().up_to_date_refused, None);
    // Written and read back.
    let json = serde_json::to_value(merged_card(Some(DIRTY_WORDS)).pr.unwrap()).unwrap();
    assert_eq!(json["upToDateRefused"], DIRTY_WORDS);
    // Plyloft's own: a later read of GitHub keeps it.
    let mut card = merged_card(Some(DIRTY_WORDS));
    let mut next = card.pr.clone().unwrap();
    next.up_to_date_refused = None;
    crate::pr_status::apply_status(&mut card, next, 900, "1.0.0").unwrap();
    assert_eq!(card.pr.unwrap().up_to_date_refused.as_deref(), Some(DIRTY_WORDS));
}

#[test]
fn the_after_merge_steps_run_after_the_cleanup_and_in_a_github_scope() {
    let source = include_str!("pr_status.rs");
    let body = source.split("pub fn refresh_card<").nth(1).unwrap().split("\n}\n").next().unwrap();
    let cleanup = body.find("clean_up_after_merge(app").unwrap();
    let after = body.find("after_merge::after_merge_and_record(").expect("G5 runs on the merge");
    assert!(cleanup < after, "after CARD_START_LOCK was released");
    let this = include_str!("after_merge.rs");
    let lock = this.find("integration_lock(cwd, target)").unwrap();
    assert!(lock < this.find("fast_forward_local(cwd, target)").unwrap(), "under the integration lock");
    assert!(!this.split("#[cfg(test)]").next().unwrap().contains("CARD_START_LOCK.lock"));
}

// ── Challenger 2, 3, 7: one row, no stale rows, the kept branch ─────────

fn board_with(cards: Vec<crate::kanban::KanbanCard>) -> (tempfile::TempDir, crate::kanban::KanbanStore) {
    let dir = tempfile::tempdir().unwrap();
    let kanban = crate::kanban::KanbanStore::new(dir.path().to_path_buf()).unwrap();
    kanban.save("ws", cards).unwrap();
    (dir, kanban)
}

fn merged(id: &str, refused: Option<&str>, updated_at: i64) -> crate::kanban::KanbanCard {
    let mut card = merged_card(refused);
    card.id = id.into();
    card.updated_at = updated_at;
    card
}

#[test]
fn a_refusal_is_kept_on_one_card_only_and_the_others_are_cleared_quietly() {
    let (_dir, kanban) = board_with(vec![
        merged("c1", None, 10),
        merged("c2", Some(DIRTY_WORDS), 20),
        merged("c3", Some("main is open in another folder"), 30),
    ]);
    let after = AfterMerge {
        branch_kept: Some(Some("another open pull request uses x".into())),
        refused: Some(Refusal { words: DIRTY_WORDS.into(), press: true }),
    };
    let card = record_in(&kanban, "ws", "c1", &after).unwrap();
    assert_eq!(clear_refusals_except(&kanban, "ws", Some("c1")), 2);
    let pr = card.pr.unwrap();
    assert_eq!(pr.up_to_date_refused.as_deref(), Some(DIRTY_WORDS));
    assert_eq!(pr.branch_kept.as_deref(), Some("another open pull request uses x"));
    let cards = kanban.load("ws").unwrap();
    let asking: Vec<&str> =
        cards.iter().filter(|c| c.pr.as_ref().unwrap().up_to_date_refused.is_some()).map(|c| c.id.as_str()).collect();
    assert_eq!(asking, vec!["c1"], "one row only");
    let at = |id: &str| cards.iter().find(|c| c.id == id).unwrap().updated_at;
    assert_eq!((at("c2"), at("c3")), (20, 30), "cleared quietly: updated_at stays");
    // Up to date everywhere (a Sync's fast-forward): no card asks.
    assert_eq!(clear_refusals_except(&kanban, "ws", None), 1);
    assert!(kanban.load("ws").unwrap().iter().all(|c| c.pr.as_ref().unwrap().up_to_date_refused.is_none()));
    // A press that only brings it up to date keeps the kept branch's reason.
    let card = record_in(&kanban, "ws", "c1", &AfterMerge::default()).unwrap();
    assert_eq!(card.pr.unwrap().branch_kept.as_deref(), Some("another open pull request uses x"));
}

#[test]
fn a_target_with_commits_of_its_own_says_so_without_a_press_or_a_row() {
    let (_dir, kanban) = board_with(vec![merged("c1", None, 10)]);
    let refused = Refusal { words: "This computer's main has commits GitHub's doesn't — ship or move them first.".into(), press: false };
    let card = record_in(&kanban, "ws", "c1", &AfterMerge { branch_kept: None, refused: Some(refused) }).unwrap();
    assert!(card.pr.as_ref().unwrap().up_to_date_no_press);
    let json = serde_json::to_value(card.pr.as_ref().unwrap()).unwrap();
    assert_eq!(json["upToDateNoPress"], true);
    let rows = crate::inbox::derive_card_events("W", &[card], 0);
    assert!(rows.iter().all(|e| e.kind != crate::inbox::InboxEventKind::BringUpToDate), "nothing to press");
}

#[test]
fn the_inbox_row_goes_once_the_target_equals_githubs() {
    let dir = tempfile::tempdir().unwrap();
    let (_origin, work) = behind_clone(dir.path());
    git(&work, &["fetch", "-q", "origin"]);
    assert!(!local_target_matches_origin(&work, "main"), "behind GitHub's");
    git(&work, &["merge", "-q", "--ff-only", "origin/main"]);
    assert!(local_target_matches_origin(&work, "main"), "pulled by hand");
    assert!(!local_target_matches_origin(&work, "no-such-branch"));
    // The feed drops it there, before the eligibility proof is made.
    let inbox = include_str!("inbox.rs");
    let feed = inbox.split("pub fn assemble_feed(").nth(1).unwrap();
    let filter = feed.find("local_target_matches_origin(Path::new(&ws.cwd), &target)").expect("the stale filter");
    assert!(filter < feed.find("let eligibility_proof = eligibility_proof(").unwrap());
}

#[test]
fn every_fast_forward_to_githubs_target_clears_the_rows() {
    let commands = include_str!("commands.rs");
    let reconcile = commands.split("crate::github_sync::reconcile(&store, &workspace_id").nth(1).unwrap();
    let reconcile = &reconcile[..reconcile.find("prune_merged_card_worktrees").unwrap()];
    assert!(reconcile.contains("crate::after_merge::clear_refusals_except(&store, &workspace_id, None)"));
    let land = commands.split("let fast_forwarded = land_sync_gate(").nth(1).unwrap();
    assert!(land[..400].contains("crate::after_merge::up_to_date_now(app, workspace_id, fast_forwarded)"));
    let trash = commands.split("trash_untracked_then_sync_for(&ws_cwd").nth(1).unwrap();
    assert!(trash[..400].contains("crate::after_merge::up_to_date_now(&app, &workspace_id"));
    let ship = include_str!("ship.rs");
    assert_eq!(ship.matches("crate::after_merge::up_to_date_now(app, &req.workspace_id, fast_forwarded)").count(), 2);
}

#[test]
fn the_pr_view_says_its_head_branch_and_old_cards_load_without_the_new_fields() {
    let fields = crate::pr_status::PR_VIEW_FIELDS;
    assert!(fields.contains("headRefName") && fields.contains("isCrossRepository"));
    let old_gh = crate::pr_status::PR_VIEW_FIELDS_WITHOUT_AUTO_MERGE;
    assert!(old_gh.contains("headRefName") && old_gh.contains("isCrossRepository"));
    let pr = crate::pr_status::parse_pr_view(&format!(
        r#"{{"number":12,"state":"MERGED","headRefOid":"{HEAD}","headRefName":"{BRANCH}","isCrossRepository":false}}"#
    ))
    .unwrap();
    assert_eq!((pr.head_ref.as_deref(), pr.cross_repository), (Some(BRANCH), Some(false)));
    // Schema migration: a card written by 1.169 has none of them.
    let old = serde_json::json!({ "number": 12, "state": "merged", "headSha": HEAD, "upToDateRefused": DIRTY_WORDS });
    let pr: crate::pr_status::PrStatus = serde_json::from_value(old).unwrap();
    assert_eq!(pr.up_to_date_refused.as_deref(), Some(DIRTY_WORDS));
    assert!(!pr.up_to_date_no_press);
    assert_eq!((pr.branch_kept, pr.head_ref, pr.cross_repository), (None, None, None));
    // Plyloft's own two are kept across a read of GitHub.
    let mut card = merged_card(Some(DIRTY_WORDS));
    if let Some(p) = card.pr.as_mut() {
        p.up_to_date_no_press = true;
        p.branch_kept = Some("x".into());
    }
    let mut next = card.pr.clone().unwrap();
    next.up_to_date_no_press = false;
    next.branch_kept = None;
    crate::pr_status::apply_status(&mut card, next, 900, "1.0.0").unwrap();
    let pr = card.pr.unwrap();
    assert!(pr.up_to_date_no_press);
    assert_eq!(pr.branch_kept.as_deref(), Some("x"));
}

// 1.174.0 (E13, CH-10): the branch in the DELETE's path is percent-encoded;
// its slashes stay, as the refs API reads them.
#[test]
fn the_deleted_ref_is_encoded_in_the_url() {
    assert_eq!(encode_ref_path("plyloft/card-12"), "plyloft/card-12");
    assert_eq!(encode_ref_path("fix#2"), "fix%232");
    assert_eq!(encode_ref_path("100%"), "100%25");
    assert_eq!(encode_ref_path("a?b c&d"), "a%3Fb%20c%26d");
    assert_eq!(encode_ref_path("café"), "caf%C3%A9");
    assert_eq!(encode_ref_path("v1.2_x~y"), "v1.2_x~y");
    assert_eq!(delete_ref_path("o/r", "plyloft/fix#2"), "repos/o/r/git/refs/heads/plyloft/fix%232");
}
