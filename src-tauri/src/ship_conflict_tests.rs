//! UX P1 point 7 (P-E): a local Ship conflict resolved by the Builder,
//! driven end to end on fixture repos — the real `land_card_local` records
//! the conflict, `ship_conflict::start` merges the recorded commit in the
//! card's copy, Finish and check (`record_build_done`) refuses while marks
//! remain and commits the merge once resolved, and Undo the merge puts the
//! card back.
//!
//! The setup is the Challenger's case: local `main` is ahead of a bare
//! `origin` by one card shipped on this Mac (`first.txt`), then by the
//! commit that conflicts with this card (`README.md`).

use std::fs;
use std::path::{Path, PathBuf};

use tauri::Manager;

use crate::kanban::{KanbanCard, KanbanColumnId, KanbanStore, ReviewStatus};
use crate::project_config::{ProjectConfig, ProjectConfigStore};
use crate::review_passes::ReviewKind;
use crate::workspace::WorkspaceStore;

const CARD_ID: &str = "card-pe";

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = crate::platform::git_command()
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("spawn git");
    assert!(
        out.status.success(),
        "git {args:?} in {}: {}",
        cwd.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn write(dir: &Path, rel: &str, body: &str) {
    let path = dir.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
}

fn identity(dir: &Path) {
    git(dir, &["config", "user.email", "t@ply.test"]);
    git(dir, &["config", "user.name", "ply-test"]);
    git(dir, &["config", "commit.gpgsign", "false"]);
    git(dir, &["config", "core.autocrlf", "false"]);
}

fn commit(dir: &Path, rel: &str, body: &str, msg: &str) -> String {
    write(dir, rel, body);
    git(dir, &["add", rel]);
    git(dir, &["commit", "-q", "-m", msg]);
    git(dir, &["rev-parse", "HEAD"])
}

/// `rel` set to `body` (removed when `None`) and committed.
fn put(dir: &Path, rel: &str, body: Option<&[u8]>, msg: &str) {
    let path = dir.join(rel);
    match body {
        Some(b) => {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b).unwrap();
            git(dir, &["add", "--", rel]);
        }
        None if path.exists() => {
            git(dir, &["rm", "-q", "--", rel]);
        }
        None => return,
    }
    git(dir, &["commit", "-q", "-m", msg]);
}

struct Fixture {
    _shell_env: std::sync::MutexGuard<'static, ()>,
    _tmp: tempfile::TempDir,
    app: tauri::App<tauri::test::MockRuntime>,
    ws: PathBuf,
    origin: PathBuf,
    wt: PathBuf,
    ws_id: String,
    /// The card's last snapshot, which Ship lands.
    publish: String,
    /// Origin's `main` at the start; nothing in the flow moves it.
    origin_main: String,
}

impl Fixture {
    fn new(builder: bool) -> Self {
        Self::with_files(builder, &[])
    }

    /// `files`: (path, the base's, the card's, main's) — each also changed
    /// on both sides before the README conflict, so the ship conflicts in
    /// them too (a body of `None` leaves the path out on that side).
    fn with_files(builder: bool, files: &[(&str, Option<&[u8]>, Option<&[u8]>, Option<&[u8]>)]) -> Self {
        Self::build(builder, files, false)
    }

    /// The Windows walk's case: before the card starts, origin's `main`
    /// gains a commit (`upstream.txt`) local `main` never takes, so the card
    /// starts from origin's tip while local `main` then diverges from it.
    fn diverged() -> Self {
        Self::build(true, &[], true)
    }

    fn build(builder: bool, files: &[(&str, Option<&[u8]>, Option<&[u8]>, Option<&[u8]>)], diverged: bool) -> Self {
        let shell_env = crate::shell_env::lock_for_test();
        crate::shell_env::init();
        let tmp = tempfile::tempdir().unwrap();
        let seed = tmp.path().join("seed");
        fs::create_dir(&seed).unwrap();
        git(&seed, &["init", "-q", "-b", "main"]);
        identity(&seed);
        write(&seed, ".gitignore", ".atelier-worktrees/\n");
        commit(&seed, "README.md", "base\n", "base");
        for (rel, base, _, _) in files {
            put(&seed, rel, *base, "base file");
        }
        let origin = tmp.path().join("origin.git");
        git(tmp.path(), &["clone", "-q", "--bare", seed.to_str().unwrap(), origin.to_str().unwrap()]);
        let ws = tmp.path().join("ws");
        git(
            tmp.path(),
            &["clone", "-q", "-c", "core.autocrlf=false", origin.to_str().unwrap(), ws.to_str().unwrap()],
        );
        identity(&ws);
        if diverged {
            let other = tmp.path().join("other");
            git(
                tmp.path(),
                &["clone", "-q", "-c", "core.autocrlf=false", origin.to_str().unwrap(), other.to_str().unwrap()],
            );
            identity(&other);
            commit(&other, "upstream.txt", "upstream\n", "upstream");
            git(&other, &["push", "-q", "origin", "main"]);
            git(&ws, &["fetch", "-q", "origin"]);
        }
        let origin_main = git(&origin, &["rev-parse", "main"]);

        let made = crate::worktrees::ensure_for_card(&ws, CARD_ID, "Card", "main").unwrap();
        let wt = made.worktree_path.clone();
        identity(&wt);
        commit(&wt, "card.txt", "card\n", "card work");
        for (rel, _, card, _) in files {
            put(&wt, rel, *card, "card file");
        }
        let publish = commit(&wt, "README.md", "the card's\n", "card readme");

        // Local main: one card shipped on this Mac (not published), then
        // the change that conflicts with this card.
        commit(&ws, "first.txt", "first\n", "Land card: First");
        for (rel, _, _, main) in files {
            put(&ws, rel, *main, "Land card: File");
        }
        commit(&ws, "README.md", "main's\n", "Land card: Readme");

        let config = tmp.path().join("config");
        let workspaces = WorkspaceStore::new(config.join("workspaces")).unwrap();
        let kanban = KanbanStore::new(config.join("kanban")).unwrap();
        let project_config = ProjectConfigStore::new(config.join("project")).unwrap();
        let ws_id = workspaces.create("PE".into(), ws.to_string_lossy().into_owned()).unwrap().id;
        let project: ProjectConfig = serde_json::from_value(serde_json::json!({
            "schemaVersion": 2,
            "targetBranch": "main",
            "versionFiles": [],
            "createdAt": 0,
            "updatedAt": 0,
        }))
        .unwrap();
        project_config.set(&ws_id, project).unwrap();
        let mut c = KanbanCard::new(CARD_ID.into(), ws_id.clone(), "Card".into(), None, KanbanColumnId::Complete);
        c.worktree_path = Some(wt.to_string_lossy().into_owned());
        c.branch_name = Some(made.branch_name.clone());
        c.worktree_base = made.base.clone();
        c.verify_status = crate::kanban::VerifyStatus::Passed;
        c.last_run_status = Some(crate::kanban::LastRunStatus::Success);
        if builder {
            c.builder = Some(
                serde_json::from_value(serde_json::json!({
                    "vendor": "claude",
                    "snapshots": [{ "n": 1, "sha": publish, "at": 1 }],
                }))
                .unwrap(),
            );
        }
        kanban.create_card(&ws_id, c).unwrap();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(workspaces);
        app.manage(kanban);
        app.manage(project_config);
        Self { _shell_env: shell_env, _tmp: tmp, app, ws, origin, wt, ws_id, publish, origin_main }
    }

    fn kanban(&self) -> tauri::State<'_, KanbanStore> {
        self.app.state::<KanbanStore>()
    }

    fn card(&self) -> KanbanCard {
        self.kanban().get_card(&self.ws_id, CARD_ID).unwrap()
    }

    /// The whole `land_card_local`, as `card_ship` calls it.
    fn land(&self) -> crate::review::ReviewMergeResult {
        let handle = self.app.handle();
        super::land_card_local(
            handle,
            &handle.state::<WorkspaceStore>(),
            &handle.state::<KanbanStore>(),
            &handle.state::<ProjectConfigStore>(),
            &self.ws_id,
            CARD_ID,
            Some(self.publish.as_str()),
        )
        .expect("a conflict is an outcome, not an error")
    }

    fn start(&self) -> Result<crate::ship_conflict::ShipConflictMessage, String> {
        crate::ship_conflict::start(&self.kanban(), &self.ws_id, CARD_ID)
    }

    fn finish(&self) -> Result<crate::builder::BuildDone, String> {
        crate::builder::record_build_done(&self.kanban(), &self.ws_id, CARD_ID, false, None, ReviewKind::Review, None, false)
            .map(|(done, _)| done)
    }

    fn merge_head(&self) -> Option<String> {
        crate::ship_conflict::merge_pending(&self.wt)
    }

    /// Nothing in the flow pushed: origin is as it started, with no branch
    /// of the card's.
    fn assert_nothing_pushed(&self) {
        assert_eq!(git(&self.origin, &["rev-parse", "main"]), self.origin_main, "origin's main moved");
        assert_eq!(git(&self.origin, &["for-each-ref", "--format=%(refname)"]), "refs/heads/main");
    }
}

#[test]
fn a_conflicting_ship_records_the_paths_and_the_commit_it_met() {
    let fx = Fixture::new(true);
    let main = git(&fx.ws, &["rev-parse", "main"]);
    let res = fx.land();
    assert!(!res.merged);
    assert_eq!(res.conflicting_paths, vec!["README.md".to_string()]);
    let card = fx.card();
    assert_eq!(card.review_status, Some(ReviewStatus::ConflictBlocked));
    let conflict = card.ship_conflict.expect("the conflict is recorded");
    assert_eq!(conflict.paths, vec!["README.md".to_string()]);
    assert_eq!(conflict.target_sha, main);
    assert_eq!(conflict.branch, "main");
    assert!(conflict.at > 0);
    assert_eq!(conflict.merge_started_at, None);
    // The member's checkout is back as it was.
    assert_eq!(git(&fx.ws, &["status", "--porcelain"]), "");
}

#[test]
fn ask_the_builder_merges_the_recorded_commit_in_the_cards_copy_only() {
    let fx = Fixture::new(true);
    let met = git(&fx.ws, &["rev-parse", "main"]);
    fx.land();
    // main moves on after the ship stopped: the press still merges what the
    // ship met, not whatever main is now.
    let later = commit(&fx.ws, "later.txt", "later\n", "Land card: Later");
    let card_head = git(&fx.wt, &["rev-parse", "HEAD"]);

    let sent = fx.start().expect("the merge starts");
    assert!(!sent.already_started);
    assert_eq!(fx.merge_head().as_deref(), Some(met.as_str()));
    assert_ne!(met, later);
    assert_eq!(sent.paths, vec!["README.md".to_string()]);
    assert_eq!(sent.branch, "main");
    let readme = fs::read_to_string(fx.wt.join("README.md")).unwrap();
    assert!(crate::ship_conflict::has_conflict_marks(&readme), "{readme}");
    // Nothing committed in the card's copy; the member's checkout untouched.
    assert_eq!(git(&fx.wt, &["rev-parse", "HEAD"]), card_head);
    assert_eq!(git(&fx.ws, &["rev-parse", "HEAD"]), later);
    assert_eq!(git(&fx.ws, &["status", "--porcelain"]), "");
    // The message names the branch and the files, and forbids commit,
    // abort and push.
    assert!(sent.message.starts_with(&format!("[Plyloft] Shipping this card stopped: main on {} changed the same lines.", crate::platform::THIS_MACHINE)));
    assert!(sent.message.contains("these files have conflict marks: README.md."));
    assert!(sent.message.contains(&format!("(commit {})", &met[..7])));
    assert!(sent.message.contains("Don't commit, don't abort the merge, don't rebase, reset, push or force anything."));
    assert!(sent.message.ends_with("Then stop; the person presses Finish and check."));
    // The record: started, and the merged commit as a trusted base.
    let card = fx.card();
    assert!(card.ship_conflict.as_ref().unwrap().merge_started_at.is_some());
    assert_eq!(card.worktree_base.as_ref().unwrap().merged_target.as_deref(), Some(met.as_str()));
    assert_eq!(card.review_status, Some(ReviewStatus::ConflictBlocked));

    // A second press (after a restart, say) starts nothing new.
    let again = fx.start().expect("the same merge, the message again");
    assert!(again.already_started);
    assert_eq!(again.message, sent.message);
    assert_eq!(fx.merge_head().as_deref(), Some(met.as_str()));
    fx.assert_nothing_pushed();
}

#[test]
fn finish_and_check_refuses_while_marks_remain_and_commits_the_merge_once_resolved() {
    let fx = Fixture::new(true);
    let met = git(&fx.ws, &["rev-parse", "main"]);
    fx.land();
    let card_head = git(&fx.wt, &["rev-parse", "HEAD"]);
    fx.start().unwrap();

    let refused = fx.finish().unwrap_err();
    assert_eq!(
        refused,
        "1 file still has conflict marks: README.md. Ask the Builder to finish them, or undo the merge (⋯ › Undo the merge)."
    );
    // The Builder `git add`ed it with its marks: still refused.
    git(&fx.wt, &["add", "README.md"]);
    assert!(fx.finish().unwrap_err().contains("README.md"));
    assert_eq!(git(&fx.wt, &["rev-parse", "HEAD"]), card_head, "nothing committed");
    // No self-check either, while the marks are there.
    let review = crate::project_config::ReviewSettings { self_check: true, ..Default::default() };
    assert_eq!(crate::builder::self_check_message(&fx.card(), &review, "t1").unwrap(), None);

    // Resolved: Finish and check commits the merge with both parents.
    write(&fx.wt, "README.md", "the card's, and main's\n");
    let done = fx.finish().expect("resolved, it commits");
    assert!(done.new_snapshot);
    let head = git(&fx.wt, &["rev-parse", "HEAD"]);
    let parents = git(&fx.wt, &["rev-list", "--parents", "-n", "1", "HEAD"]);
    assert_eq!(parents, format!("{head} {card_head} {met}"));
    assert!(git(&fx.wt, &["log", "-1", "--format=%s"]).ends_with(&format!("(merges main at {})", &met[..7])));
    assert_eq!(fx.merge_head(), None);
    // A new round: the conflict is history.
    let card = fx.card();
    assert_eq!(card.review_status, None);
    assert_eq!(card.ship_conflict, None);
    assert_eq!(card.builder.as_ref().unwrap().snapshots.last().unwrap().sha, head);
    fx.assert_nothing_pushed();
}

/// The Challenger's case: the review range of the next round holds only
/// the card's own work and the resolution — not the card shipped on this
/// Mac before it, which local main carries and origin doesn't.
#[test]
fn the_review_range_after_the_resolution_holds_only_the_cards_work() {
    let fx = Fixture::new(true);
    let met = git(&fx.ws, &["rev-parse", "main"]);
    fx.land();
    fx.start().unwrap();
    write(&fx.wt, "README.md", "the card's, and main's\n");
    fx.finish().unwrap();
    let card = fx.card();
    let head = card.builder.as_ref().unwrap().snapshots.last().unwrap().sha.clone();

    let base = crate::worktrees::card_review_base(&fx.ws, &head, card.worktree_base.as_ref(), "main").unwrap();
    assert_eq!(base.commit, met, "{:?}", base.note);
    let files = git(&fx.ws, &["diff", "--name-only", &base.commit, &head]);
    assert_eq!(files, "README.md\ncard.txt");
    assert!(!files.contains("first.txt"));

    // Without Plyloft's record the range starts where the card began, and
    // main's own work would count as this card's.
    let mut unrecorded = card.worktree_base.clone().unwrap();
    unrecorded.merged_target = None;
    let old = crate::worktrees::card_review_base(&fx.ws, &head, Some(&unrecorded), "main").unwrap();
    assert!(git(&fx.ws, &["diff", "--name-only", &old.commit, &head]).contains("first.txt"));
}

/// (Windows walk) Origin a local path, so the review takes the recorded
/// base ("origin is a local path"); the card started from origin's tip
/// while local main, which it met, had diverged from it. The recorded base
/// and the merged commit are then incomparable, and the merged one is used:
/// local main's own change no longer reads as the card's. The same on the
/// path that checks origin's tip.
#[test]
fn a_diverged_local_target_on_a_local_path_origin_reviews_from_the_merged_commit() {
    let fx = Fixture::diverged();
    let recorded = fx.card().worktree_base.unwrap().commit;
    assert_eq!(recorded, fx.origin_main, "the card started from origin's tip");
    let met = git(&fx.ws, &["rev-parse", "main"]);
    assert!(!crate::worktrees::is_ancestor(&fx.ws, &recorded, &met), "local main diverged from origin");
    fx.land();
    fx.start().unwrap();
    write(&fx.wt, "README.md", "the card's, and main's\n");
    fx.finish().unwrap();
    let card = fx.card();
    let head = card.builder.as_ref().unwrap().snapshots.last().unwrap().sha.clone();

    let unchecked = crate::review_base::with_production_origin(|| {
        crate::worktrees::card_review_base(&fx.ws, &head, card.worktree_base.as_ref(), "main").unwrap()
    });
    assert_eq!(unchecked.note.as_deref(), Some("Review base: the recorded base (origin is a local path)."));
    let checked = crate::worktrees::card_review_base(&fx.ws, &head, card.worktree_base.as_ref(), "main").unwrap();
    // The card's diff view and counts (informational) agree.
    let counted = crate::review_base::with_production_origin(|| {
        crate::worktrees::card_diff_base(&fx.ws, &head, card.worktree_base.as_ref(), "main").unwrap()
    });
    for base in [&unchecked.commit, &checked.commit, &counted] {
        assert_eq!(base, &met);
        let files = git(&fx.ws, &["diff", "--name-only", base, &head]);
        assert!(!files.contains("first.txt"), "local main's own work: {files}");
        assert_eq!(git(&fx.ws, &["diff", base, &head, "--", "README.md"]).lines().filter(|l| l.starts_with('+') && !l.starts_with("+++")).count(), 1);
    }

    // Before: the recorded base, and local main's work read as the card's.
    let mut unrecorded = card.worktree_base.clone().unwrap();
    unrecorded.merged_target = None;
    let old = crate::review_base::with_production_origin(|| {
        crate::worktrees::card_review_base(&fx.ws, &head, Some(&unrecorded), "main").unwrap()
    });
    assert_eq!(old.commit, recorded);
    assert!(git(&fx.ws, &["diff", "--name-only", &old.commit, &head]).contains("first.txt"));
}

#[test]
fn undo_the_merge_puts_the_card_back_at_the_conflict() {
    let fx = Fixture::new(true);
    fx.land();
    let card_head = git(&fx.wt, &["rev-parse", "HEAD"]);
    fx.start().unwrap();
    // The Builder had begun resolving.
    write(&fx.wt, "README.md", "half done\n");

    crate::ship_conflict::undo(&fx.kanban(), &fx.ws_id, CARD_ID).unwrap();
    assert_eq!(fx.merge_head(), None);
    assert_eq!(git(&fx.wt, &["rev-parse", "HEAD"]), card_head);
    assert_eq!(git(&fx.wt, &["status", "--porcelain"]), "");
    assert_eq!(fs::read_to_string(fx.wt.join("README.md")).unwrap(), "the card's\n");
    let card = fx.card();
    assert_eq!(card.review_status, Some(ReviewStatus::ConflictBlocked));
    let conflict = card.ship_conflict.unwrap();
    assert_eq!(conflict.merge_started_at, None);
    assert_eq!(conflict.paths, vec!["README.md".to_string()]);
    // And it can be asked again.
    assert!(!fx.start().unwrap().already_started);
    fx.assert_nothing_pushed();
}

/// The Builder aborted the merge itself and changed nothing: Finish and
/// check takes what is there, and the card is back where the press found it.
#[test]
fn a_merge_the_builder_aborted_leaves_the_card_as_before_the_press() {
    let fx = Fixture::new(true);
    fx.land();
    fx.start().unwrap();
    git(&fx.wt, &["merge", "--abort"]);
    let done = fx.finish().unwrap();
    assert!(!done.new_snapshot);
    let card = fx.card();
    assert_eq!(card.review_status, Some(ReviewStatus::ConflictBlocked));
    assert_eq!(card.ship_conflict.unwrap().merge_started_at, None);
}

#[test]
fn the_press_refuses_on_work_since_the_last_finish_and_check() {
    let fx = Fixture::new(true);
    fx.land();
    write(&fx.wt, "card.txt", "more\n");
    assert_eq!(fx.start().unwrap_err(), crate::ship_conflict::UNCOMMITTED);
    assert_eq!(fx.merge_head(), None);
    assert_eq!(fx.card().ship_conflict.unwrap().merge_started_at, None);
}

#[test]
fn a_card_with_no_builder_is_refused_in_plain_words() {
    let fx = Fixture::new(false);
    fx.land();
    assert_eq!(fx.card().review_status, Some(ReviewStatus::ConflictBlocked));
    assert_eq!(fx.start().unwrap_err(), crate::ship_conflict::NO_BUILDER);
    assert_eq!(fx.merge_head(), None);
}

#[test]
fn a_ship_that_lands_clears_the_conflict() {
    let fx = Fixture::new(true);
    fx.land();
    assert!(fx.card().ship_conflict.is_some());
    fx.kanban().set_card_review(&fx.ws_id, CARD_ID, Some(ReviewStatus::Merged), None).unwrap();
    assert_eq!(fx.card().ship_conflict, None);
}

#[test]
fn conflict_marks_are_git_s_shapes_only() {
    use crate::ship_conflict::has_conflict_marks;
    assert!(has_conflict_marks("a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> 1234567\n"));
    assert!(has_conflict_marks("a\r\n<<<<<<< HEAD\r\nx\r\n"));
    assert!(has_conflict_marks(">>>>>>>\n"));
    assert!(!has_conflict_marks("a\n=======\nheading underline\n"));
    assert!(!has_conflict_marks("<<<<<<<<< not a mark\n"));
    assert!(!has_conflict_marks("  <<<<<<< indented\n"));
}

#[test]
fn finish_refusal_counts_the_files() {
    let two = vec!["a.ts".to_string(), "b.ts".to_string()];
    assert_eq!(
        crate::ship_conflict::marks_refusal(&two, true),
        "2 files still have conflict marks: a.ts, b.ts. Ask the Builder to finish them, or undo the merge (⋯ › Undo the merge)."
    );
    // Once the Builder committed the merge there is none to undo.
    assert_eq!(
        crate::ship_conflict::marks_refusal(&two[..1], false),
        "1 file still has conflict marks: a.ts. Ask the Builder to finish them."
    );
}

/// (Challenger) A guide to git conflicts carries mark-shaped lines in a
/// code block on both sides. Resolved, it keeps them and Finish and check
/// takes it; a mark git wrote is still caught beside them.
#[test]
fn a_file_that_legitimately_shows_conflict_marks_is_not_refused_for_them() {
    let guide = |middle: &str| {
        format!("# Conflicts\n\n```\n<<<<<<< HEAD\nyours\n=======\ntheirs\n>>>>>>> branch\n```\n\n{middle}\n").into_bytes()
    };
    let (base, card, main) = (guide("base"), guide("the card's"), guide("main's"));
    let fx = Fixture::with_files(true, &[("docs/guide.md", Some(base.as_slice()), Some(card.as_slice()), Some(main.as_slice()))]);
    fx.land();
    assert_eq!(
        fx.card().ship_conflict.unwrap().paths,
        vec!["README.md".to_string(), "docs/guide.md".to_string()]
    );
    let sent = fx.start().unwrap();
    assert!(sent.message.contains("these files have conflict marks: README.md, docs/guide.md."), "{}", sent.message);
    write(&fx.wt, "README.md", "the card's, and main's\n");
    // git's own mark in the guide, beside its example: still refused.
    let refused = fx.finish().unwrap_err();
    assert!(refused.starts_with("1 file still has conflict marks: docs/guide.md."), "{refused}");
    // Resolved, the example stays and Finish and check commits the merge.
    fs::write(fx.wt.join("docs/guide.md"), guide("the card's and main's")).unwrap();
    assert!(fx.finish().expect("the guide's example is not a leftover mark").new_snapshot);
    assert_eq!(fx.merge_head(), None);
    fx.assert_nothing_pushed();
}

/// (Challenger) The Builder committed the merge itself, marks and all,
/// despite the message: Finish and check doesn't take it as resolved.
#[test]
fn a_merge_the_builder_committed_with_marks_is_refused() {
    let fx = Fixture::new(true);
    let met = git(&fx.ws, &["rev-parse", "main"]);
    fx.land();
    fx.start().unwrap();
    git(&fx.wt, &["add", "-A"]);
    git(&fx.wt, &["commit", "-qm", "merged"]);
    assert_eq!(fx.merge_head(), None);
    let refused = fx.finish().unwrap_err();
    assert_eq!(refused, "1 file still has conflict marks: README.md. Ask the Builder to finish them.");
    // Fixed and committed (or not): taken like any of its commits.
    write(&fx.wt, "README.md", "both\n");
    git(&fx.wt, &["commit", "-qam", "resolved"]);
    assert!(fx.finish().unwrap().new_snapshot);
    let card = fx.card();
    assert_eq!(card.ship_conflict, None);
    assert_eq!(card.worktree_base.unwrap().merged_target.as_deref(), Some(met.as_str()));
}

/// (Challenger) A binary file and a file deleted on one side conflict
/// without marks: the message names them apart, and Finish and check takes
/// what is in the folder (Codex can't `git add` there).
#[test]
fn files_git_could_not_mark_are_named_apart_and_not_refused() {
    let fx = Fixture::with_files(
        true,
        &[
            ("logo.png", Some(&b"\x89PNG\0base"[..]), Some(&b"\x89PNG\0card"[..]), Some(&b"\x89PNG\0main"[..])),
            ("gone.txt", Some(&b"base\n"[..]), Some(&b"the card's\n"[..]), None),
        ],
    );
    let res = fx.land();
    let mut paths = res.conflicting_paths.clone();
    paths.sort();
    assert_eq!(paths, vec!["README.md", "gone.txt", "logo.png"]);
    let sent = fx.start().unwrap();
    assert!(sent.message.contains("these files have conflict marks: README.md."), "{}", sent.message);
    assert!(
        sent.message.contains("git couldn't write marks (a binary file, or one deleted on one side): ")
            && sent.message.contains("gone.txt")
            && sent.message.contains("logo.png"),
        "{}",
        sent.message
    );
    assert_eq!(sent.paths.len(), 3);
    write(&fx.wt, "README.md", "both\n");
    assert!(fx.finish().unwrap().new_snapshot);
    assert_eq!(git(&fx.wt, &["rev-list", "--parents", "-n", "1", "HEAD"]).split(' ').count(), 3);
}

/// (Challenger) A name with an accent is recorded as the path it is (git
/// quotes it without `-z`), so its marks are read and refused.
#[test]
fn a_conflict_in_a_file_with_an_accent_is_read_back() {
    let fx = Fixture::with_files(true, &[("perché.md", Some(&b"base\n"[..]), Some(&b"card\n"[..]), Some(&b"main\n"[..]))]);
    let res = fx.land();
    assert!(res.conflicting_paths.contains(&"perché.md".to_string()), "{:?}", res.conflicting_paths);
    fx.start().unwrap();
    write(&fx.wt, "README.md", "both\n");
    let refused = fx.finish().unwrap_err();
    assert!(refused.contains("perché.md"), "{refused}");
}

/// (Challenger) A cherry-pick (or rebase) the Builder left half done: the
/// press doesn't stack a merge on it.
#[test]
fn the_press_refuses_over_another_git_operation_under_way() {
    let fx = Fixture::new(true);
    fx.land();
    let main = git(&fx.ws, &["rev-parse", "main"]);
    let out = crate::platform::git_command()
        .args(["cherry-pick", &main])
        .current_dir(&fx.wt)
        .output()
        .unwrap();
    assert!(!out.status.success(), "the cherry-pick conflicts");
    let refused = fx.start().unwrap_err();
    assert!(refused.starts_with("The card's copy is in the middle of a cherry-pick; nothing was started."), "{refused}");
    assert_eq!(fx.merge_head(), None);
}

/// PPVP Tier 2: a board written before P-E (no `shipConflict`, no
/// `mergedTarget`) loads unchanged, and a card without them writes neither.
#[test]
fn an_old_card_without_ship_conflict_loads_and_round_trips() {
    let old = serde_json::json!({
        "id": "c1",
        "workspaceId": "ws",
        "title": "Old",
        "columnId": "complete",
        "reviewStatus": "conflict_blocked",
        "worktreeBase": { "commit": "abc", "refName": "origin/main", "source": "origin" },
        "createdAt": 1,
        "updatedAt": 1
    });
    let card: KanbanCard = serde_json::from_value(old).unwrap();
    assert_eq!(card.review_status, Some(ReviewStatus::ConflictBlocked));
    assert_eq!(card.ship_conflict, None);
    assert_eq!(card.worktree_base.as_ref().unwrap().merged_target, None);
    let written = serde_json::to_value(&card).unwrap();
    assert!(written.get("shipConflict").is_none());
    assert!(written["worktreeBase"].get("mergedTarget").is_none());

    // A record of this version reads back as written.
    let mut card = card;
    card.ship_conflict = Some(crate::kanban::ShipConflict {
        paths: vec!["a.ts".into()],
        target_sha: "def".into(),
        at: 5,
        branch: "main".into(),
        merge_started_at: Some(6),
        sync: false,
        review_before: None,
    });
    card.worktree_base.as_mut().unwrap().merged_target = Some("def".into());
    let json = serde_json::to_value(&card).unwrap();
    assert_eq!(
        json["shipConflict"],
        serde_json::json!({ "paths": ["a.ts"], "targetSha": "def", "at": 5, "branch": "main", "mergeStartedAt": 6 })
    );
    assert_eq!(json["worktreeBase"]["mergedTarget"], "def");
    let back: KanbanCard = serde_json::from_value(json).unwrap();
    assert_eq!(back.ship_conflict, card.ship_conflict);
    // A record with only the spec's three fields loads too.
    let minimal: crate::kanban::ShipConflict =
        serde_json::from_value(serde_json::json!({ "paths": [], "targetSha": "x", "at": 1 })).unwrap();
    assert_eq!(minimal.branch, "");
    assert_eq!(minimal.merge_started_at, None);
}

/// K6 (1.171.0 A3): a conflict's target is said by its real name — the one
/// recorded, else the card's start's — and "your main branch" when neither is
/// known; never "the target branch".
#[test]
fn a_conflicts_target_is_named_never_the_target_branch() {
    let mut card = KanbanCard::new("c".into(), "ws".into(), "Add a footer".into(), None, KanbanColumnId::Todo);
    assert_eq!(crate::ship_conflict::conflict_target(&card, ""), "your main branch");
    assert_eq!(crate::ship_conflict::conflict_target(&card, "trunk"), "trunk");
    card.worktree_base = Some(
        serde_json::from_value(serde_json::json!({ "commit": "a", "refName": "origin/develop", "source": "origin" }))
            .unwrap(),
    );
    assert_eq!(crate::ship_conflict::conflict_target(&card, " "), "develop");
    assert_eq!(crate::ship_conflict::conflict_target(&card, "trunk"), "trunk");
    let words = crate::ship_conflict::message(true, "", "abcdef1234", &["a.txt".into()], &[]);
    assert!(!words.contains("the target branch"), "{words}");
    assert!(words.contains("your main branch"), "{words}");
}
