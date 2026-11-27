//! 1.170.0 (G6): Behind / Conflict ahead and Bring in the target's changes,
//! on fixture repositories: a bare `origin`, the member's clone (whose
//! local `main` holds one unpublished card shipped on this Mac), a card's
//! copy started from origin's `main`, and a teammate's clone that moves
//! origin's `main` on after the card started.

use std::fs;
use std::path::{Path, PathBuf};

use crate::kanban::{KanbanCard, KanbanColumnId, KanbanStore, ReviewStatus};
use crate::review_passes::ReviewKind;

const CARD: &str = "card-g6";
const WS: &str = "ws";

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = crate::platform::git_command().args(args).current_dir(cwd).output().expect("spawn git");
    assert!(out.status.success(), "git {args:?} in {}: {}", cwd.display(), String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn identity(dir: &Path) {
    git(dir, &["config", "user.email", "t@ply.test"]);
    git(dir, &["config", "user.name", "ply-test"]);
    git(dir, &["config", "commit.gpgsign", "false"]);
    git(dir, &["config", "core.autocrlf", "false"]);
}

fn commit(dir: &Path, rel: &str, body: &str, msg: &str) -> String {
    let path = dir.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
    git(dir, &["add", rel]);
    git(dir, &["commit", "-q", "-m", msg]);
    git(dir, &["rev-parse", "HEAD"])
}

struct Fixture {
    _shell_env: std::sync::MutexGuard<'static, ()>,
    _tmp: tempfile::TempDir,
    kanban: KanbanStore,
    ws: PathBuf,
    origin: PathBuf,
    other: PathBuf,
    wt: PathBuf,
}

impl Fixture {
    /// `pr_open`: the card shipped as a pull request that is still open.
    fn new(pr_open: bool) -> Self {
        let shell_env = crate::shell_env::lock_for_test();
        crate::shell_env::init();
        let tmp = tempfile::tempdir().unwrap();
        let seed = tmp.path().join("seed");
        fs::create_dir(&seed).unwrap();
        git(&seed, &["init", "-q", "-b", "main"]);
        identity(&seed);
        commit(&seed, ".gitignore", ".atelier-worktrees/\n", "ignore");
        commit(&seed, "README.md", "base\n", "base");
        let origin = tmp.path().join("origin.git");
        git(tmp.path(), &["clone", "-q", "--bare", seed.to_str().unwrap(), origin.to_str().unwrap()]);
        let clone = |name: &str| {
            let dir = tmp.path().join(name);
            git(tmp.path(), &["clone", "-q", "-c", "core.autocrlf=false", origin.to_str().unwrap(), dir.to_str().unwrap()]);
            identity(&dir);
            dir
        };
        let ws = clone("ws");
        let other = clone("other");

        let made = crate::worktrees::ensure_for_card(&ws, CARD, "Card", "main").unwrap();
        let wt = made.worktree_path.clone();
        identity(&wt);
        let snap = commit(&wt, "README.md", "the card's\n", "card work");
        // Local main: a card shipped on this Mac, never published (R2).
        commit(&ws, "first.txt", "first\n", "Land card: First");

        let kanban = KanbanStore::new(tmp.path().join("kanban")).unwrap();
        let mut c = KanbanCard::new(CARD.into(), WS.into(), "Card".into(), None, KanbanColumnId::Complete);
        c.worktree_path = Some(wt.to_string_lossy().into_owned());
        c.branch_name = Some(made.branch_name.clone());
        c.worktree_base = made.base.clone();
        c.last_run_status = Some(crate::kanban::LastRunStatus::Success);
        c.builder = Some(
            serde_json::from_value(serde_json::json!({
                "vendor": "claude",
                "snapshots": [{ "n": 1, "sha": snap, "at": 1 }],
            }))
            .unwrap(),
        );
        if pr_open {
            c.review_status = Some(ReviewStatus::Merged);
            c.pr = Some(serde_json::from_value(serde_json::json!({ "number": 7, "state": "open" })).unwrap());
            c.pr_url = Some("https://github.com/acme/app/pull/7".into());
        }
        kanban.create_card(WS, c).unwrap();
        Self { _shell_env: shell_env, _tmp: tmp, kanban, ws, origin, other, wt }
    }

    /// A teammate's change lands on GitHub's main after the card started.
    fn teammate_pushes(&self, rel: &str, body: &str) -> String {
        let sha = commit(&self.other, rel, body, "teammate");
        git(&self.other, &["push", "-q", "origin", "main"]);
        sha
    }

    fn card(&self) -> KanbanCard {
        self.kanban.get_card(WS, CARD).unwrap()
    }

    fn report(&self) -> super::TargetSyncReport {
        git(&self.ws, &["fetch", "-q", "origin"]);
        super::report(&self.ws, "main", &[self.card()])
    }

    fn bring_in(&self) -> Result<super::BringInResult, String> {
        self.bring_in_live(false)
    }

    /// `live`: a Builder session runs the card (its turn: `last_run_status`).
    fn bring_in_live(&self, live: bool) -> Result<super::BringInResult, String> {
        super::bring_in(&self.kanban, WS, CARD, "main", &|wt| crate::worktrees::fetch_origin_branch(wt, "main"), &|| live)
    }

    fn finish(&self) -> Result<crate::builder::BuildDone, String> {
        crate::builder::record_build_done(&self.kanban, WS, CARD, false, None, ReviewKind::Review, None, false)
            .map(|(done, _)| done)
    }

    fn origin_refs(&self) -> String {
        git(&self.origin, &["for-each-ref", "--format=%(refname) %(objectname)"])
    }
}

#[test]
fn a_card_behind_its_target_is_measured_and_a_conflict_ahead_is_seen_without_touching_anything() {
    let fx = Fixture::new(false);
    let report = fx.report();
    assert_eq!(report.target, "main");
    assert_eq!(report.cards[CARD], super::CardTargetSync::default(), "nothing to bring in yet");

    fx.teammate_pushes("other.txt", "theirs\n");
    let head = git(&fx.wt, &["rev-parse", "HEAD"]);
    let sync = &fx.report().cards[CARD];
    assert_eq!((sync.behind, sync.conflict, sync.merging), (1, false, false));

    fx.teammate_pushes("README.md", "GitHub's\n");
    let sync = &fx.report().cards[CARD];
    assert_eq!((sync.behind, sync.conflict), (2, true));
    // The dry merge wrote nothing in the card's copy.
    assert_eq!(git(&fx.wt, &["rev-parse", "HEAD"]), head);
    assert_eq!(git(&fx.wt, &["status", "--porcelain"]), "");
    assert_eq!(crate::ship_conflict::merge_pending(&fx.wt), None);
}

#[test]
fn landed_archived_and_copyless_cards_are_not_measured_an_open_pull_request_is() {
    let fx = Fixture::new(true);
    fx.teammate_pushes("other.txt", "theirs\n");
    assert_eq!(fx.report().cards[CARD].behind, 1, "an open pull request's card is kept up to date too");
    let mut card = fx.card();
    card.pr.as_mut().unwrap().state = crate::pr_status::PrState::Merged;
    assert!(!super::tracked(&card), "its pull request merged: landed");
    let mut card = fx.card();
    card.archived = true;
    assert!(!super::tracked(&card));
    let mut card = fx.card();
    card.worktree_path = None;
    assert!(!super::tracked(&card));
    let mut card = fx.card();
    card.ship_status = crate::kanban::ShipStatus::Shipped;
    assert!(!super::tracked(&card));
}

#[test]
fn bring_in_merges_the_target_with_nothing_committed_then_finish_and_check_commits_the_merge() {
    let fx = Fixture::new(false);
    let theirs = fx.teammate_pushes("other.txt", "theirs\n");
    let card_head = git(&fx.wt, &["rev-parse", "HEAD"]);
    let before = fx.origin_refs();
    let local_main = git(&fx.ws, &["rev-parse", "main"]);

    let done = fx.bring_in().expect("a clean merge");
    assert_eq!(done.kind, "merged");
    assert_eq!(done.target, "main");
    assert!(!done.recorded);
    // Pending in the card's copy only, the fetched commit itself.
    assert_eq!(crate::ship_conflict::merge_pending(&fx.wt).as_deref(), Some(theirs.as_str()));
    assert_eq!(git(&fx.wt, &["rev-parse", "HEAD"]), card_head, "nothing committed");
    assert!(fx.report().cards[CARD].merging);
    assert_eq!(fx.card().review_status, None);
    assert_eq!(fx.card().ship_conflict, None);
    // A second press refuses while it is pending.
    assert!(fx.bring_in().unwrap_err().contains("already under way"));

    let built = fx.finish().expect("Finish and check commits the merge");
    assert!(built.new_snapshot);
    let head = git(&fx.wt, &["rev-parse", "HEAD"]);
    assert_eq!(git(&fx.wt, &["rev-list", "--parents", "-n", "1", "HEAD"]), format!("{head} {card_head} {theirs}"));
    assert!(git(&fx.wt, &["log", "-1", "--format=%s"]).ends_with(&format!("(merges main at {})", &theirs[..7])));
    assert_eq!(fx.report().cards[CARD], super::CardTargetSync::default(), "up to date");
    // Nothing pushed, nothing rewritten; the member's checkout untouched.
    assert_eq!(fx.origin_refs(), before);
    assert_eq!(git(&fx.ws, &["rev-parse", "main"]), local_main);
    assert_eq!(git(&fx.ws, &["status", "--porcelain"]), "");

    // R2: GitHub's merged commit is never one a pull request would carry.
    git(&fx.ws, &["fetch", "-q", "origin"]);
    assert!(crate::commands::pr_carries_local_commits(&fx.ws, &fx.card(), "main").is_none());

    // Up to date now: the press brings in nothing.
    assert_eq!(fx.bring_in().unwrap().kind, "up_to_date");
    assert_eq!(crate::ship_conflict::merge_pending(&fx.wt), None);
}

#[test]
fn a_conflicting_bring_in_merges_nothing_and_hands_over_to_ask_the_builder_and_undo() {
    let fx = Fixture::new(false);
    let theirs = fx.teammate_pushes("README.md", "GitHub's\n");
    let card_head = git(&fx.wt, &["rev-parse", "HEAD"]);

    let met = fx.bring_in().expect("a conflict is an outcome");
    assert_eq!(met.kind, "conflict");
    assert_eq!(met.paths, vec!["README.md".to_string()]);
    assert!(met.recorded);
    // Nothing merged: the copy is as the press found it.
    assert_eq!(crate::ship_conflict::merge_pending(&fx.wt), None);
    assert_eq!(git(&fx.wt, &["status", "--porcelain"]), "");
    assert_eq!(git(&fx.wt, &["rev-parse", "HEAD"]), card_head);
    let card = fx.card();
    assert_eq!(card.review_status, Some(ReviewStatus::ConflictBlocked));
    let conflict = card.ship_conflict.clone().unwrap();
    assert!(conflict.sync);
    assert_eq!((conflict.target_sha.as_str(), conflict.branch.as_str()), (theirs.as_str(), "main"));
    assert_eq!(conflict.merge_started_at, None);

    // Ask the Builder to resolve it: the same commit, in the card's copy,
    // in the words of a bring-in.
    let sent = crate::ship_conflict::start(&fx.kanban, WS, CARD).expect("the merge starts");
    assert_eq!(crate::ship_conflict::merge_pending(&fx.wt).as_deref(), Some(theirs.as_str()));
    assert!(sent.message.starts_with(
        "[Plyloft] Bringing main's changes into this card stopped: main on GitHub changed the same lines."
    ), "{}", sent.message);
    assert!(sent.message.contains("don't rebase, reset, push or force anything"));

    // Undo the merge: back where the press found it, the record gone.
    crate::ship_conflict::undo(&fx.kanban, WS, CARD).unwrap();
    assert_eq!(crate::ship_conflict::merge_pending(&fx.wt), None);
    let card = fx.card();
    assert_eq!(card.ship_conflict, None);
    assert_eq!(card.review_status, None);
    assert!(fx.report().cards[CARD].conflict, "still a conflict ahead");

    // Resolved by the Builder instead: Finish and check commits it and the
    // conflict is history.
    let again = fx.bring_in().unwrap();
    assert_eq!(again.kind, "conflict");
    crate::ship_conflict::start(&fx.kanban, WS, CARD).unwrap();
    fs::write(fx.wt.join("README.md"), "the card's, and GitHub's\n").unwrap();
    assert!(fx.finish().unwrap().new_snapshot);
    let card = fx.card();
    assert_eq!((card.review_status, card.ship_conflict), (None, None));
    assert_eq!(fx.report().cards[CARD], super::CardTargetSync::default());
}

/// Orchestrator #8: on a card whose pull request is open the conflict is
/// recorded beside its status, never over it, and Ask the Builder to
/// resolve it starts the merge for the Builder the same way (Plyloft runs
/// `git merge`; the Builder only resolves).
#[test]
fn an_open_pull_requests_conflict_is_recorded_beside_its_status_and_the_merge_starts_for_the_builder() {
    let fx = Fixture::new(true);
    let theirs = fx.teammate_pushes("README.md", "GitHub's\n");
    let met = fx.bring_in().unwrap();
    assert_eq!(met.kind, "conflict");
    assert!(met.recorded);
    let card = fx.card();
    assert_eq!(card.review_status, Some(ReviewStatus::Merged), "the pull request's status stands");
    let record = card.ship_conflict.clone().unwrap();
    assert!(record.sync);
    assert_eq!(record.review_before, Some(ReviewStatus::Merged));
    assert_eq!(crate::ship_conflict::merge_pending(&fx.wt), None, "nothing merged yet");
    assert!(fx.bring_in().unwrap_err().contains("stopped on a conflict"), "one conflict at a time");

    let sent = crate::ship_conflict::start(&fx.kanban, WS, CARD).expect("the merge starts for the Builder");
    assert!(sent.message.starts_with("[Plyloft] Bringing main's changes into this card stopped"), "{}", sent.message);
    assert_eq!(crate::ship_conflict::merge_pending(&fx.wt).as_deref(), Some(theirs.as_str()));
    let card = fx.card();
    assert_eq!(card.review_status, Some(ReviewStatus::Merged));
    assert!(card.ship_conflict.as_ref().unwrap().merge_started_at.is_some());
    // Push update and Ship wait for Finish and check while it is pending.
    assert_eq!(
        crate::builder::require_at_last_snapshot(&card, &fx.wt).unwrap_err(),
        crate::builder::MERGE_PENDING
    );

    // Left out: the copy as before, the record gone, the status untouched.
    crate::ship_conflict::undo(&fx.kanban, WS, CARD).unwrap();
    assert_eq!(crate::ship_conflict::merge_pending(&fx.wt), None);
    let card = fx.card();
    assert_eq!((card.review_status, card.ship_conflict), (Some(ReviewStatus::Merged), None));
}

/// Challenger (#1, #4): a non-pull-request card's conflict can be left out
/// before the merge is started for the Builder, and the review status the
/// press found comes back.
#[test]
fn leaving_the_changes_out_before_the_merge_starts_puts_the_review_status_back() {
    let fx = Fixture::new(false);
    fx.kanban
        .with_card(WS, CARD, |c| {
            c.review_status = Some(ReviewStatus::Pending);
            Ok(())
        })
        .unwrap();
    fx.teammate_pushes("README.md", "GitHub's\n");
    assert_eq!(fx.bring_in().unwrap().kind, "conflict");
    let card = fx.card();
    assert_eq!(card.review_status, Some(ReviewStatus::ConflictBlocked));
    assert_eq!(card.ship_conflict.as_ref().unwrap().review_before, Some(ReviewStatus::Pending));
    crate::ship_conflict::undo(&fx.kanban, WS, CARD).unwrap();
    let card = fx.card();
    assert_eq!((card.review_status, card.ship_conflict), (Some(ReviewStatus::Pending), None));
    assert_eq!(git(&fx.wt, &["status", "--porcelain"]), "");
}

/// Challenger (#3): a clean bring-in records GitHub's merged commit as the
/// card's trusted base, as the conflict path does — so with an origin that
/// can't vouch for a tip (here a local path, taken as production would) the
/// review's range still holds only the card's own changes.
#[test]
fn a_clean_bring_in_is_recorded_so_the_review_counts_only_the_cards_changes() {
    let fx = Fixture::new(false);
    let theirs = fx.teammate_pushes("other.txt", "theirs\n");
    assert_eq!(fx.bring_in().unwrap().kind, "merged");
    assert_eq!(fx.card().worktree_base.unwrap().merged_target.as_deref(), Some(theirs.as_str()));
    // Ship and Push update wait for Finish and check.
    assert_eq!(
        crate::builder::require_at_last_snapshot(&fx.card(), &fx.wt).unwrap_err(),
        crate::builder::MERGE_PENDING
    );
    fx.finish().unwrap();
    let card = fx.card();
    let head = card.builder.as_ref().unwrap().snapshots.last().unwrap().sha.clone();
    let base = crate::review_base::with_production_origin(|| {
        crate::worktrees::card_review_base(&fx.ws, &head, card.worktree_base.as_ref(), "main").unwrap()
    });
    assert_eq!(base.commit, theirs, "{:?}", base.note);
    assert_eq!(git(&fx.ws, &["diff", "--name-only", &base.commit, &head]), "README.md");

    // Before: the card's start, and GitHub's change read as the card's.
    let mut unrecorded = card.worktree_base.clone().unwrap();
    unrecorded.merged_target = None;
    let old = crate::review_base::with_production_origin(|| {
        crate::worktrees::card_review_base(&fx.ws, &head, Some(&unrecorded), "main").unwrap()
    });
    assert!(git(&fx.ws, &["diff", "--name-only", &old.commit, &head]).contains("other.txt"));
}

/// Challenger (#5, #6): never under a Builder's turn, never on a card two
/// Builders build until one is picked.
#[test]
fn bring_in_refuses_a_builder_at_work_and_an_undecided_build_both() {
    let fx = Fixture::new(false);
    fx.teammate_pushes("other.txt", "theirs\n");
    fx.kanban
        .with_card(WS, CARD, |c| {
            c.last_run_status = Some(crate::kanban::LastRunStatus::Running);
            Ok(())
        })
        .unwrap();
    assert_eq!(fx.bring_in_live(true).unwrap_err(), super::builder_working("main"));
    assert_eq!(crate::ship_conflict::merge_pending(&fx.wt), None);
    // Recorded as running with no session (after a relaunch): its turn is over.
    assert_eq!(fx.bring_in_live(false).unwrap().kind, "merged");
    git(&fx.wt, &["merge", "--abort"]);

    let wt = fx.wt.to_string_lossy().into_owned();
    fx.kanban
        .with_card(WS, CARD, |c| {
            c.build_both = Some(crate::build_both::new_record(&wt, "a", &wt, "b", true, 1));
            Ok(())
        })
        .unwrap();
    assert!(!super::tracked(&fx.card()));
    assert_eq!(fx.bring_in().unwrap_err(), crate::build_both::UNDECIDED_REFUSAL);
    assert!(fx.report().cards.is_empty());
}

/// Challenger (#9): the dry merge is remembered by its two commits.
#[test]
fn the_dry_merge_is_remembered_by_its_two_commits() {
    let fx = Fixture::new(false);
    let theirs = fx.teammate_pushes("README.md", "GitHub's\n");
    git(&fx.ws, &["fetch", "-q", "origin"]);
    let tip = git(&fx.wt, &["rev-parse", "HEAD"]);
    assert_eq!(super::dry_merge_conflicts_cached(&fx.ws, &tip, &theirs), Some(true));
    // Asked again for the same pair, git isn't run (a folder with no repository).
    assert_eq!(super::dry_merge_conflicts_cached(Path::new("/nowhere/g6-cache"), &tip, &theirs), Some(true));
    assert_eq!(super::dry_merge_conflicts_cached(Path::new("/nowhere/g6-cache"), &theirs, &tip), None);
}

#[test]
fn bring_in_refuses_work_since_the_last_finish_and_check() {
    let fx = Fixture::new(false);
    fx.teammate_pushes("other.txt", "theirs\n");
    fs::write(fx.wt.join("wip.txt"), "wip\n").unwrap();
    assert_eq!(fx.bring_in().unwrap_err(), super::uncommitted("main"));
    assert_eq!(crate::ship_conflict::merge_pending(&fx.wt), None);
}

#[test]
fn the_fetch_is_throttled_per_repository_and_branch() {
    let repo = Path::new("/nowhere/g6-throttle");
    let every = std::time::Duration::from_secs(60);
    assert!(super::fetch_due(repo, "main", every));
    assert!(!super::fetch_due(repo, "main", every));
    assert!(super::fetch_due(repo, "develop", every));
    assert!(super::fetch_due(repo, "main", std::time::Duration::ZERO));
}

/// PPVP Tier 2: a ship's conflict record from 1.169.1 (no `sync`, no
/// `reviewBefore`) loads unchanged and writes neither; a bring-in's
/// round-trips.
#[test]
fn an_older_conflict_record_loads_without_sync_and_a_sync_one_round_trips() {
    let old: crate::kanban::ShipConflict = serde_json::from_value(serde_json::json!({
        "paths": ["a.ts"], "targetSha": "def", "at": 5, "branch": "main", "mergeStartedAt": 6
    }))
    .unwrap();
    assert!(!old.sync);
    assert_eq!(old.review_before, None);
    let written = serde_json::to_value(&old).unwrap();
    assert!(written.get("sync").is_none());
    assert!(written.get("reviewBefore").is_none());
    assert_eq!(
        written,
        serde_json::json!({ "paths": ["a.ts"], "targetSha": "def", "at": 5, "branch": "main", "mergeStartedAt": 6 })
    );
    let new = crate::kanban::ShipConflict { sync: true, review_before: Some(ReviewStatus::Merged), ..old };
    let json = serde_json::to_value(&new).unwrap();
    assert_eq!(json["sync"], true);
    assert_eq!(json["reviewBefore"], "merged");
    let back: crate::kanban::ShipConflict = serde_json::from_value(json).unwrap();
    assert_eq!(back, new);
}
