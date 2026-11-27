//! Windows walk of #386: Sync's merged prune put the worktree of an open
//! pull request's card (#29, head `main`) in the trash. A pull request card
//! is cleaned only by its pull request's merged/closed path, its branch is
//! kept while the pull request is open, and a card the prune already took
//! gets its worktree back.

use super::*;
use crate::branch_cleanup::{BranchCleanup, CleanupOutcome, CleanupReason};
use crate::license::{LicenseStore, PlanCase};
use crate::workspace::WorkspaceStore;
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};

/// The trash entry as the Windows walk recorded it.
const WIN_TRASH: &str = r"C:\ply-test\sandboxes\pr386\.plyloft-worktrees\.trash\card-x-pr12-1792196099341";

fn json(card: &KanbanCard) -> serde_json::Value {
    serde_json::to_value(card).unwrap()
}

/// Pull request #29 of the walk: its head is `main`'s tip.
fn pr_from_main(r: &Repos) -> (KanbanCard, String) {
    // walk-base-11 at main's first commit; main one commit on.
    let base = git(&r.author, &["rev-parse", "origin/main"]);
    git(&r.author, &["push", "-q", "origin", &format!("{base}:refs/heads/walk-base-11")]);
    git(&r.author, &["checkout", "-q", "main"]);
    let main = commit(&r.author, "m.txt", "m");
    git(&r.author, &["push", "-q", "origin", "main"]);
    git(&r.clone, &["fetch", "-q", "origin"]);
    git(&r.author, &["push", "-q", "origin", &format!("{main}:refs/pull/29/head")]);
    let head = crate::worktrees::fetch_pull_head(&r.clone, 29).unwrap();
    assert_eq!(head, main);
    let mut card = pr_card(false);
    card.id = "card-x-pr29".into();
    let made = crate::worktrees::ensure_for_pr_card(&r.clone, &card.id, &card.title, &head).unwrap();
    card.worktree_path = Some(made.worktree_path.to_string_lossy().into_owned());
    card.branch_name = Some(made.branch_name);
    card.worktree_base = recorded_base(&r.clone, "walk-base-11", &head);
    assert_eq!(card.worktree_base.as_ref().unwrap().commit, base);
    let pr = card.pr_review.as_mut().unwrap();
    pr.number = 29;
    pr.base_ref = "walk-base-11".into();
    pr.head_sha = head.clone();
    pr.branch_head = Some(head.clone());
    (card, head)
}

#[test]
fn syncs_merged_prune_never_takes_a_pull_request_card() {
    let r = repos();
    let (pr29, _) = pr_from_main(&r);
    // A normal card merged into main, for contrast.
    let main = git(&r.clone, &["rev-parse", "origin/main"]);
    let mut plain = KanbanCard::new("card-plain".into(), "ws".into(), "Plain".into(), None, KanbanColumnId::InProgress);
    let made = crate::worktrees::ensure_for_pr_card(&r.clone, &plain.id, "Plain", &main).unwrap();
    plain.worktree_path = Some(made.worktree_path.to_string_lossy().into_owned());
    plain.branch_name = Some(made.branch_name);
    plain.worktree_base = pr29.worktree_base.clone();
    let cards = vec![pr29.clone(), plain];

    assert!(cleaned_only_by_its_pull_request(&pr29) && !cleaned_only_by_its_pull_request(&cards[1]));
    let candidates = crate::commands::merged_prune_candidates(&cards, &r.clone, &|_| false);
    assert_eq!(candidates.iter().map(|c| c.card_id.as_str()).collect::<Vec<_>>(), vec!["card-plain"]);
    let report = crate::worktrees::prune_merged_card_worktrees(&r.clone, "main", &candidates, &[]);
    assert_eq!(report.pruned, vec!["card-plain".to_string()], "a plain merged card still goes");
    assert!(
        Path::new(pr29.worktree_path.as_deref().unwrap()).is_dir(),
        "the open pull request's card keeps its worktree"
    );
    // Merged or closed too: its own path (`clean_up_closed`) cleans it.
    let mut merged = pr29.clone();
    merged.pr_review.as_mut().unwrap().state = PrState::Merged;
    assert!(crate::commands::merged_prune_candidates(&[merged], &r.clone, &|_| false).is_empty());
    // What the walk met: as a plain card, its tip (main) proves "merged".
    let mut as_plain = pr29.clone();
    as_plain.pr_review = None;
    let before = crate::commands::merged_prune_candidates(&[as_plain], &r.clone, &|_| false);
    let report = crate::worktrees::prune_merged_card_worktrees(&r.clone, "main", &before, &[]);
    assert_eq!(report.pruned, vec![pr29.id.clone()]);
}

#[test]
fn the_branch_sweep_leaves_an_open_pull_requests_branch() {
    let r = repos();
    let (mut card, head) = pr_from_main(&r);
    let branch = card.branch_name.clone().unwrap();
    // Its worktree gone, as the walk found it; a due record of Sync's.
    git(&r.clone, &["worktree", "remove", "--force", card.worktree_path.as_deref().unwrap()]);
    card.worktree_path = None;
    card.branch_cleanup = Some(BranchCleanup::new(&branch, &head, CleanupReason::Merged, 0, None));
    let in_session = |_: &KanbanCard| false;
    let env = crate::branch_cleanup::Env {
        repo: &r.clone,
        enabled: true,
        me: Default::default(),
        now: crate::branch_cleanup::DUE_AFTER_MS + 1,
        in_session: &in_session,
    };
    assert!(branch_kept_while_open(&card));
    assert_eq!(crate::branch_cleanup::sweep_card(&env, &card), crate::branch_cleanup::Verdict::Skip);
    assert!(crate::worktrees::branch_tip(&r.clone, &branch).is_some());
    // The pull request closed: the sweep's own rules again.
    card.pr_review.as_mut().unwrap().state = PrState::Closed;
    assert!(!branch_kept_while_open(&card));
    assert_eq!(crate::branch_cleanup::sweep_card(&env, &card), crate::branch_cleanup::Verdict::Deleted);
}

struct World {
    repos: Repos,
    app: tauri::App<MockRuntime>,
    ws: String,
    _config: tempfile::TempDir,
}

fn world() -> World {
    let repos = repos();
    TEST_REPO.with(|r| *r.borrow_mut() = Some("o/r".into()));
    let config = tempfile::tempdir().unwrap();
    let workspaces = WorkspaceStore::new(config.path().to_path_buf()).unwrap();
    let ws = workspaces.create("Lyra".into(), repos.clone.to_string_lossy().into_owned()).unwrap().id;
    let app = mock_builder()
        .manage(workspaces)
        .manage(KanbanStore::new(config.path().to_path_buf()).unwrap())
        .manage(LicenseStore::for_plan_test(config.path().to_path_buf(), PlanCase::Free))
        .build(mock_context(noop_assets()))
        .expect("mock app");
    World { repos, app, ws, _config: config }
}

/// The member's own #12, with an unpushed fix on its branch, trashed by
/// Sync's prune as the walk saw it (`worktreePath`/`branchName` null, a
/// "merged" record with the trash entry).
fn trashed_card(w: &World) -> (KanbanCard, String, String) {
    let head = crate::worktrees::fetch_pull_head(&w.repos.clone, 12).unwrap();
    let mut card = pr_card(true);
    card.workspace_id = w.ws.clone();
    let made = crate::worktrees::ensure_for_pr_card(&w.repos.clone, &card.id, &card.title, &head).unwrap();
    identity(&made.worktree_path);
    let fix = commit(&made.worktree_path, "fix.txt", "fix");
    let branch = made.branch_name.clone();
    let pr = card.pr_review.as_mut().unwrap();
    pr.head_sha = head.clone();
    pr.branch_head = Some(head);
    // The prune's move: the folder to the trash, git told.
    let trash = w.repos.clone.join(".plyloft-worktrees").join(".trash").join("card-x-pr12-1");
    fs::create_dir_all(trash.parent().unwrap()).unwrap();
    fs::rename(&made.worktree_path, &trash).unwrap();
    git(&w.repos.clone, &["worktree", "prune"]);
    card.worktree_path = None;
    card.branch_name = None;
    card.branch_cleanup = Some(BranchCleanup::new(&branch, &fix, CleanupReason::Merged, 1, Some(Path::new(WIN_TRASH))));
    w.app.state::<KanbanStore>().create_card(&w.ws, card.clone()).unwrap();
    let card = w.app.state::<KanbanStore>().get_card(&w.ws, &card.id).unwrap();
    (card, branch, fix)
}

#[test]
fn at_launch_a_card_trashed_while_its_pull_request_was_open_gets_its_worktree_back() {
    let w = world();
    let app = w.app.handle();
    let kanban = app.state::<KanbanStore>();
    let (card, branch, fix) = trashed_card(&w);
    assert!(worktree_lost_to_sync(&card));

    remake_lost_worktrees(app);
    let back = kanban.get_card(&w.ws, &card.id).unwrap();
    let wt = PathBuf::from(back.worktree_path.clone().expect("the worktree is back on the card"));
    assert_eq!(wt, crate::worktrees::worktree_path_for_card(&w.repos.clone, &card.id));
    assert_eq!(back.branch_name.as_deref(), Some(branch.as_str()), "on the branch the prune kept");
    assert_eq!(crate::worktrees::head_sha(&wt).unwrap(), fix, "the unpushed fix came back with it");
    let rec = back.branch_cleanup.as_ref().unwrap();
    assert_eq!(rec.outcome, Some(CleanupOutcome::Restarted), "the sweep leaves the branch");
    assert_eq!(rec.trash_entry.as_deref(), Some(WIN_TRASH));
    assert!(!worktree_lost_to_sync(&back));
    // A second launch changes nothing.
    remake_lost_worktrees(app);
    assert_eq!(json(&kanban.get_card(&w.ws, &card.id).unwrap()), json(&back));
    // Merged, archived, or recorded by its own merged path: never touched.
    let mut merged = card.clone();
    merged.pr_review.as_mut().unwrap().state = PrState::Merged;
    let mut archived = card.clone();
    archived.archived = true;
    let mut own = card.clone();
    own.branch_cleanup.as_mut().unwrap().reason = CleanupReason::PrMerged;
    assert!(!worktree_lost_to_sync(&merged) && !worktree_lost_to_sync(&archived) && !worktree_lost_to_sync(&own));
}

#[test]
fn a_card_whose_branch_went_too_is_made_on_the_pull_requests_head_and_nothing_is_overwritten() {
    let w = world();
    let app = w.app.handle();
    let kanban = app.state::<KanbanStore>();
    let (card, branch, _) = trashed_card(&w);
    // Something already at the card's worktree path: refused, unchanged.
    let path = crate::worktrees::worktree_path_for_card(&w.repos.clone, &card.id);
    fs::create_dir_all(&path).unwrap();
    let refused = remake_lost_worktree(&kanban, &w.repos.clone, &w.ws, &card.id).unwrap_err();
    assert!(refused.contains("refusing to overwrite"), "{refused}");
    assert_eq!(json(&kanban.get_card(&w.ws, &card.id).unwrap()), json(&card));
    fs::remove_dir(&path).unwrap();
    // The branch deleted by the sweep: a new one at refs/ply/pr/12.
    git(&w.repos.clone, &["branch", "-D", &branch]);
    kanban
        .with_card_unstamped(&w.ws, &card.id, |c| {
            c.branch_cleanup.as_mut().unwrap().outcome = Some(CleanupOutcome::Deleted);
            Ok(())
        })
        .unwrap();
    let head = git(&w.repos.clone, &["rev-parse", "refs/ply/pr/12"]);
    assert!(remake_lost_worktree(&kanban, &w.repos.clone, &w.ws, &card.id).unwrap());
    let back = kanban.get_card(&w.ws, &card.id).unwrap();
    assert_eq!(crate::worktrees::head_sha(Path::new(back.worktree_path.as_deref().unwrap())).unwrap(), head);
    assert_eq!(back.pr_review.as_ref().unwrap().branch_head.as_deref(), Some(head.as_str()));
    assert_eq!(back.branch_cleanup.as_ref().unwrap().outcome, Some(CleanupOutcome::Deleted), "a settled record stays");
}

#[test]
fn review_again_fetches_the_head_and_makes_the_worktree_again() {
    let _serial = crate::github::test_serial_lock();
    let w = world();
    let app = w.app.handle();
    let kanban = app.state::<KanbanStore>();
    let (card, branch, _) = trashed_card(&w);
    // Neither the branch, Plyloft's ref nor a head this clone knows: the
    // launch's pass (no network) can't, and says so.
    git(&w.repos.clone, &["branch", "-D", &branch]);
    git(&w.repos.clone, &["update-ref", "-d", "refs/ply/pr/12"]);
    kanban
        .with_card_unstamped(&w.ws, &card.id, |c| {
            c.pr_review.as_mut().unwrap().head_sha = NEXT.into();
            Ok(())
        })
        .unwrap();
    let why = remake_lost_worktree(&kanban, &w.repos.clone, &w.ws, &card.id).unwrap_err();
    assert!(why.contains("neither the card's branch nor the pull request's head"), "{why}");
    // A new commit on the pull request, then Review again: fetched, made.
    let head = commit(&w.repos.author, "c.txt", "c");
    git(&w.repos.author, &["push", "-q", "-f", "origin", &format!("{head}:refs/pull/12/head")]);
    crate::github::invalidate_login_cache();
    crate::github::set_test_gh_responses(vec![Ok(view_json("OPEN", "octo", false, &head))]);
    let mut reviewed = None;
    let started = start(app, &w.ws, &card.id, false, |h| {
        reviewed = Some(h.to_string());
        Ok(())
    });
    crate::github::clear_test_gh_responses();
    let started = started.unwrap();
    assert_eq!(reviewed.as_deref(), Some(head.as_str()));
    let wt = PathBuf::from(started.worktree_path.clone().unwrap());
    assert_eq!(crate::worktrees::head_sha(&wt).unwrap(), head);
    assert!(!worktree_lost_to_sync(&started));
}

/// Challenger on c273cb92: the prune cleared the card's recorded base with
/// its worktree (`clear_worktree_handle`); the remake records it again
/// from `origin/<base>` as the clone has it, so the review's diff and the
/// chat note have their base before any Review again.
#[test]
fn the_remade_worktree_has_its_base_again() {
    let w = world();
    let app = w.app.handle();
    let kanban = app.state::<KanbanStore>();
    let (card, _, _) = trashed_card(&w);
    assert!(card.worktree_base.is_none(), "as Sync's prune left it");
    assert!(remake_lost_worktree(&kanban, &w.repos.clone, &w.ws, &card.id).unwrap());
    let back = kanban.get_card(&w.ws, &card.id).unwrap();
    let base = back.worktree_base.expect("the base is recorded again");
    assert_eq!(base.ref_name, "origin/main");
    let head = git(&w.repos.clone, &["rev-parse", "refs/ply/pr/12"]);
    assert_eq!(base.commit, git(&w.repos.clone, &["merge-base", "origin/main", &head]));
}

/// Challenger on c273cb92: a recorded branch that is gone without the sweep
/// having deleted it is made anew under the same name — at the pull
/// request's head, and marked there, as any new branch.
#[test]
fn a_branch_gone_without_the_sweep_is_made_fresh_at_the_head() {
    let w = world();
    let app = w.app.handle();
    let kanban = app.state::<KanbanStore>();
    let (card, branch, fix) = trashed_card(&w);
    git(&w.repos.clone, &["branch", "-D", &branch]);
    kanban
        .with_card_unstamped(&w.ws, &card.id, |c| {
            c.pr_review.as_mut().unwrap().branch_head = Some(fix.clone());
            Ok(())
        })
        .unwrap();
    assert!(remake_lost_worktree(&kanban, &w.repos.clone, &w.ws, &card.id).unwrap());
    let back = kanban.get_card(&w.ws, &card.id).unwrap();
    let head = git(&w.repos.clone, &["rev-parse", "refs/ply/pr/12"]);
    assert_eq!(back.branch_name.as_deref(), Some(branch.as_str()), "the same name, made anew");
    assert_eq!(crate::worktrees::head_sha(Path::new(back.worktree_path.as_deref().unwrap())).unwrap(), head);
    assert_eq!(back.pr_review.as_ref().unwrap().branch_head.as_deref(), Some(head.as_str()));
}

/// Challenger on c273cb92: a card that can't be written leaves no checkout
/// behind (one would refuse every later remake as "already exists"), the
/// kept branch with its fix stays, and the card still reads as lost.
#[cfg(unix)]
#[test]
fn a_remake_whose_card_cant_be_written_leaves_no_checkout() {
    use std::os::unix::fs::PermissionsExt;
    let w = world();
    let app = w.app.handle();
    let kanban = app.state::<KanbanStore>();
    let (card, branch, fix) = trashed_card(&w);
    let boards = w._config.path().join(crate::kanban::KANBAN_SUBDIR);
    fs::set_permissions(&boards, fs::Permissions::from_mode(0o555)).unwrap();
    let failed = remake_lost_worktree(&kanban, &w.repos.clone, &w.ws, &card.id);
    fs::set_permissions(&boards, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(failed.is_err(), "{failed:?}");
    let path = crate::worktrees::worktree_path_for_card(&w.repos.clone, &card.id);
    assert!(!path.exists(), "no checkout the card doesn't record");
    assert_eq!(crate::worktrees::branch_tip(&w.repos.clone, &branch).as_deref(), Some(fix.as_str()));
    assert!(worktree_lost_to_sync(&kanban.get_card(&w.ws, &card.id).unwrap()));
    // The next pass makes it.
    assert!(remake_lost_worktree(&kanban, &w.repos.clone, &w.ws, &card.id).unwrap());
    assert!(path.is_dir());
}
