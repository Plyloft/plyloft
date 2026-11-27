//! SP-5: `Approve` for a workspace with no shared definition — a commit on the
//! integration branch, pushed only with a remote, never over a newer change.
//! Real git in temporary repositories; nothing outside them is touched.

use super::*;
use crate::shared_config::Plumbing;
use std::path::PathBuf;
use tempfile::TempDir;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = crate::platform::git_command()
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?} in {dir:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

const AGENTS: &str = "# Atelier\nRules.\n";
const AGENTS_AFTER: &str = "# Atelier\nRun the tests before reporting done.\nRules.\n";
const AGENTS_DIFF: &str = concat!(
    "--- a/AGENTS.md\n",
    "+++ b/AGENTS.md\n",
    "@@ -1,2 +1,3 @@\n",
    " # Atelier\n",
    "+Run the tests before reporting done.\n",
    " Rules.\n",
);
const SKILL_DIFF: &str = concat!(
    "--- a/.claude/skills/deploy/SKILL.md\n",
    "+++ b/.claude/skills/deploy/SKILL.md\n",
    "@@ -1,2 +1,3 @@\n",
    " # Deploy\n",
    "+Check that a rollback test exists before pushing.\n",
    " Push it.\n",
);

fn identity(dir: &Path) {
    git(dir, &["config", "user.name", "Solo"]);
    git(dir, &["config", "user.email", "solo@example.com"]);
}

/// Lay the fixture's files into `dir` and commit them on `main`.
fn seed(dir: &Path) {
    std::fs::create_dir_all(dir.join(".claude/skills/deploy")).unwrap();
    std::fs::write(dir.join(".claude/skills/deploy/SKILL.md"), "# Deploy\nPush it.\n").unwrap();
    std::fs::write(dir.join(".claude/skills/deploy/notes.md"), "Notes.\n").unwrap();
    std::fs::write(dir.join("AGENTS.md"), AGENTS).unwrap();
    std::fs::write(dir.join("app.txt"), "code\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", "init"]);
}

/// A repository with no remote, on `main`, clean.
fn solo_repo() -> TempDir {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-q", "--initial-branch=main"]);
    identity(dir.path());
    seed(dir.path());
    dir
}

/// A bare origin, a clone of it (`work`, on `main`) and another clone (`other`).
struct WithOrigin {
    dir: TempDir,
}

impl WithOrigin {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("origin.git")).unwrap();
        git(&root.join("origin.git"), &["init", "-q", "--bare", "-b", "main"]);
        git(root, &["clone", "-q", "origin.git", "other"]);
        let other = root.join("other");
        identity(&other);
        git(&other, &["checkout", "-q", "-b", "main"]);
        seed(&other);
        git(&other, &["push", "-q", "origin", "main"]);
        git(root, &["clone", "-q", "origin.git", "work"]);
        identity(&root.join("work"));
        Self { dir }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    fn origin_main(&self) -> String {
        git(&self.path("origin.git"), &["rev-parse", "main"])
    }
}

fn agents_proposal(cwd: &Path) -> StoredProposal {
    StoredProposal {
        target: ProposalTarget::Instructions { file: "AGENTS.md".into() },
        card_id: "card-1".into(),
        card_ref: "#88".into(),
        reason: "After card #88.".into(),
        words: "A line is added.".into(),
        diff: Some(AGENTS_DIFF.into()),
        target_content_id: target_content_id(cwd, "AGENTS.md"),
        target_blob: target_blob_with("git", cwd, "AGENTS.md"),
        created_at: 0,
        source: None,
    }
}

fn skill_proposal(cwd: &Path) -> StoredProposal {
    let path = ".claude/skills/deploy/SKILL.md";
    StoredProposal {
        target: ProposalTarget::Skill { name: "deploy".into(), path: path.into() },
        diff: Some(SKILL_DIFF.into()),
        target_content_id: target_content_id(cwd, path),
        target_blob: target_blob_with("git", cwd, path),
        ..agents_proposal(cwd)
    }
}

fn approve(cwd: &Path, proposal: &StoredProposal) -> Result<Approved, String> {
    approve_unshared("git", None, proposal, cwd, "main", 1_800_000_000)
}

fn rev(dir: &Path, rev: &str) -> String {
    git(dir, &["rev-parse", rev])
}

fn changed_paths(dir: &Path, commit: &str) -> Vec<String> {
    git(dir, &["diff-tree", "--no-commit-id", "--name-only", "-r", commit])
        .lines()
        .map(str::to_string)
        .collect()
}

// ── No remote: a commit on the local branch ──────────────────────────

#[test]
fn a_clean_main_gets_one_commit_and_the_checkout_has_it() {
    let repo = solo_repo();
    let cwd = repo.path();
    let before = rev(cwd, "main");
    let approved = approve(cwd, &agents_proposal(cwd)).expect("committed");
    assert_eq!(approved.title, "Committed the change to main");
    assert!(approved.body.contains("nothing was pushed"), "{}", approved.body);

    let after = rev(cwd, "main");
    assert_eq!(rev(cwd, "main~1"), before, "exactly one commit on top");
    assert_eq!(changed_paths(cwd, &after), vec!["AGENTS.md".to_string()]);
    assert_eq!(git(cwd, &["show", "main:AGENTS.md"]) + "\n", AGENTS_AFTER);
    assert_eq!(std::fs::read_to_string(cwd.join("AGENTS.md")).unwrap(), AGENTS_AFTER);
    assert_eq!(git(cwd, &["status", "--porcelain"]), "", "index and tree match the new commit");
    assert_eq!(git(cwd, &["log", "-1", "--format=%an"]), "Solo", "the person's own identity");
}

#[test]
fn a_skill_commit_patches_one_file_and_keeps_the_rest_of_the_skill() {
    let repo = solo_repo();
    let cwd = repo.path();
    approve(cwd, &skill_proposal(cwd)).expect("committed");
    assert_eq!(
        changed_paths(cwd, "main"),
        vec![".claude/skills/deploy/SKILL.md".to_string()]
    );
    assert_eq!(git(cwd, &["show", "main:.claude/skills/deploy/notes.md"]), "Notes.");
    assert!(git(cwd, &["show", "main:.claude/skills/deploy/SKILL.md"]).contains("rollback test"));
}

#[test]
fn unrelated_uncommitted_edits_survive_byte_for_byte() {
    let repo = solo_repo();
    let cwd = repo.path();
    let proposal = agents_proposal(cwd);
    // An unstaged edit, a staged new file and an untracked one, none claimed.
    std::fs::write(cwd.join("app.txt"), b"half-done\r\nwork \xff\n").unwrap();
    std::fs::write(cwd.join("staged.txt"), "staged\n").unwrap();
    git(cwd, &["add", "staged.txt"]);
    std::fs::write(cwd.join("scratch.txt"), "untracked\n").unwrap();

    approve(cwd, &proposal).expect("committed");

    assert_eq!(std::fs::read(cwd.join("app.txt")).unwrap(), b"half-done\r\nwork \xff\n");
    assert_eq!(std::fs::read_to_string(cwd.join("scratch.txt")).unwrap(), "untracked\n");
    assert_eq!(git(cwd, &["diff", "--cached", "--name-only"]), "staged.txt", "still staged");
    assert_eq!(git(cwd, &["diff", "--name-only"]), "app.txt", "still unstaged");
    assert_eq!(changed_paths(cwd, "main"), vec!["AGENTS.md".to_string()]);
}

#[test]
fn uncommitted_changes_under_the_claimed_paths_refuse_it() {
    let repo = solo_repo();
    let cwd = repo.path();
    let proposal = skill_proposal(cwd);
    let before = rev(cwd, "main");
    std::fs::write(cwd.join(".claude/skills/deploy/notes.md"), "Mine, not committed.\n").unwrap();

    let why = approve(cwd, &proposal).expect_err("a dirty claimed path is refused");
    assert!(why.contains(".claude/skills/deploy/notes.md"), "{why}");
    assert!(why.contains("uncommitted changes"), "{why}");
    assert!(why.ends_with("Nothing was committed."), "{why}");
    assert_eq!(rev(cwd, "main"), before);
    assert_eq!(
        std::fs::read_to_string(cwd.join(".claude/skills/deploy/notes.md")).unwrap(),
        "Mine, not committed.\n"
    );
    assert!(!cwd.join(".git/index.lock").exists());

}

/// SP-5 review 3: a target git is told not to look at (assume-unchanged)
/// hides a local edit from `status`; the commit refuses rather than writing
/// over it, and says so without git's words.
#[test]
fn an_assume_unchanged_target_with_a_local_edit_is_refused_and_kept() {
    let repo = solo_repo();
    let cwd = repo.path();
    let proposal = skill_proposal(cwd);
    let before = rev(cwd, "main");
    git(cwd, &["update-index", "--assume-unchanged", ".claude/skills/deploy/notes.md"]);
    std::fs::write(cwd.join(".claude/skills/deploy/notes.md"), "Local, hidden from status.\n").unwrap();

    let why = approve(cwd, &proposal).expect_err("refused");
    assert_eq!(
        why,
        "Plyloft couldn't update .claude/skills/deploy in your checkout, so nothing was committed. \
Check `git status` there and approve again."
    );
    assert!(!why.contains("failed") && !why.contains("read-tree"), "no git stderr: {why}");
    assert_eq!(rev(cwd, "main"), before);
    assert_eq!(
        std::fs::read_to_string(cwd.join(".claude/skills/deploy/notes.md")).unwrap(),
        "Local, hidden from status.\n"
    );
    assert!(!cwd.join(".git/index.lock").exists());
}

/// SP-5 review: an untracked file the commit does not write — Finder's
/// `.DS_Store`, a draft — sits under the claimed skill and blocks nothing.
#[test]
fn untracked_files_the_commit_does_not_write_do_not_block_it() {
    let repo = solo_repo();
    let cwd = repo.path();
    let proposal = skill_proposal(cwd);
    std::fs::write(cwd.join(".claude/skills/deploy/.DS_Store"), b"\0\0junk").unwrap();
    std::fs::write(cwd.join(".claude/skills/deploy/draft.md"), "draft\n").unwrap();

    approve(cwd, &proposal).expect("committed");
    assert_eq!(changed_paths(cwd, "main"), vec![".claude/skills/deploy/SKILL.md".to_string()]);
    assert_eq!(std::fs::read_to_string(cwd.join(".claude/skills/deploy/draft.md")).unwrap(), "draft\n");
    assert!(cwd.join(".claude/skills/deploy/.DS_Store").exists());
}

/// A same-size edit made in the second the index was written is still seen:
/// the check asks the real index, whose mtime git's racy-entry rule reads.
#[test]
fn a_same_size_edit_under_the_claimed_paths_is_still_seen() {
    let repo = solo_repo();
    let cwd = repo.path();
    let proposal = skill_proposal(cwd);
    let before = rev(cwd, "main");
    std::fs::write(cwd.join(".claude/skills/deploy/notes.md"), "Mines.\n").unwrap();

    let why = approve(cwd, &proposal).expect_err("the edit is seen");
    assert!(why.contains("notes.md"), "{why}");
    assert_eq!(rev(cwd, "main"), before);
    assert_eq!(
        std::fs::read_to_string(cwd.join(".claude/skills/deploy/notes.md")).unwrap(),
        "Mines.\n"
    );
}

#[test]
fn a_target_that_moved_on_main_since_the_challenger_read_it_is_refused() {
    let repo = solo_repo();
    let cwd = repo.path();
    // The checkout is on a feature branch; main moves AGENTS.md without it.
    git(cwd, &["checkout", "-q", "-b", "feature"]);
    let proposal = agents_proposal(cwd);
    git(cwd, &["checkout", "-q", "main"]);
    std::fs::write(cwd.join("AGENTS.md"), "# Atelier\nA teammate's rule.\nRules.\n").unwrap();
    git(cwd, &["commit", "-q", "-am", "teammate"]);
    git(cwd, &["checkout", "-q", "feature"]);
    let moved = rev(cwd, "main");

    let blocked = local_commit_blocker(&Plumbing { cwd: cwd.to_path_buf() }, &proposal, "main");
    assert_eq!(
        blocked.as_deref(),
        Some("AGENTS.md changed on main since the Reviewer read it."),
        "the state says it in place of the button"
    );
    let why = approve(cwd, &proposal).expect_err("never over a newer change");
    assert_eq!(
        why,
        "AGENTS.md changed on main since the Reviewer read it. Nothing was committed."
    );
    assert_eq!(rev(cwd, "main"), moved);
}

fn blocker(cwd: &Path, proposal: &StoredProposal) -> Option<String> {
    local_commit_blocker(&Plumbing { cwd: cwd.to_path_buf() }, proposal, "main")
}

/// SP-5 review: a target main has never carried is not "changed on main".
#[test]
fn an_untracked_target_is_not_on_main_yet() {
    let repo = solo_repo();
    let cwd = repo.path();
    std::fs::write(cwd.join("CLAUDE.md"), AGENTS).unwrap();
    let proposal = StoredProposal {
        target: ProposalTarget::Instructions { file: "CLAUDE.md".into() },
        diff: Some(AGENTS_DIFF.replace("AGENTS.md", "CLAUDE.md")),
        target_content_id: target_content_id(cwd, "CLAUDE.md"),
        target_blob: target_blob_with("git", cwd, "CLAUDE.md"),
        ..agents_proposal(cwd)
    };
    let before = rev(cwd, "main");
    let why = "CLAUDE.md isn't on main yet. Commit it to main first, then approve.";
    assert_eq!(blocker(cwd, &proposal).as_deref(), Some(why));
    assert_eq!(approve(cwd, &proposal).unwrap_err(), format!("{why} Nothing was committed."));
    assert_eq!(rev(cwd, "main"), before);
}

const NOT_MAINS: &str =
    "Your checkout's AGENTS.md isn't main's copy (uncommitted changes, or another branch is checked out).";

#[test]
fn a_target_with_uncommitted_edits_is_not_mains_copy() {
    let repo = solo_repo();
    let cwd = repo.path();
    // Below the diff's context, so the diff still applies to what was read.
    std::fs::write(cwd.join("AGENTS.md"), "# Atelier\nRules.\nMine, not committed.\n").unwrap();
    let proposal = agents_proposal(cwd);
    let before = rev(cwd, "main");
    assert_eq!(blocker(cwd, &proposal).as_deref(), Some(NOT_MAINS));
    assert_eq!(approve(cwd, &proposal).unwrap_err(), format!("{NOT_MAINS} Nothing was committed."));
    assert_eq!(rev(cwd, "main"), before);
}

#[test]
fn a_target_read_on_another_branch_is_not_mains_copy() {
    let repo = solo_repo();
    let cwd = repo.path();
    git(cwd, &["checkout", "-q", "-b", "feature"]);
    std::fs::write(cwd.join("AGENTS.md"), "# Atelier\nRules.\nFeature rule.\n").unwrap();
    git(cwd, &["commit", "-q", "-am", "feature"]);
    let proposal = agents_proposal(cwd);
    let before = rev(cwd, "main");
    assert_eq!(blocker(cwd, &proposal).as_deref(), Some(NOT_MAINS));
    assert!(approve(cwd, &proposal).unwrap_err().starts_with(NOT_MAINS));
    assert_eq!(rev(cwd, "main"), before);
}

#[test]
fn the_target_as_main_has_it_is_not_blocked() {
    let repo = solo_repo();
    let cwd = repo.path();
    assert_eq!(blocker(cwd, &agents_proposal(cwd)), None);
}

/// SP-5 review: main in an unfinished rebase reads as detached; the
/// approval refuses rather than moving the ref under the rebase.
#[test]
fn a_rebase_of_main_in_progress_refuses_it() {
    let repo = solo_repo();
    let cwd = repo.path();
    std::fs::write(cwd.join("app.txt"), "two\n").unwrap();
    git(cwd, &["commit", "-q", "-am", "two"]);
    let proposal = agents_proposal(cwd);
    let out = crate::platform::git_command()
        .args(["rebase", "-i", "HEAD~1"])
        .env("GIT_SEQUENCE_EDITOR", "sed -i.bak -e 's/^pick/edit/'")
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let before = rev(cwd, "refs/heads/main");

    let why = approve(cwd, &proposal).expect_err("refused during the rebase");
    assert!(why.contains("A rebase of main is in progress"), "{why}");
    assert_eq!(rev(cwd, "refs/heads/main"), before);
    git(cwd, &["rebase", "--continue"]);
}

#[test]
fn another_branch_checked_out_moves_only_the_ref() {
    let repo = solo_repo();
    let cwd = repo.path();
    git(cwd, &["checkout", "-q", "-b", "feature"]);
    std::fs::write(cwd.join("app.txt"), "feature work\n").unwrap();
    let proposal = agents_proposal(cwd);
    let before = rev(cwd, "main");

    approve(cwd, &proposal).expect("committed");

    assert_eq!(rev(cwd, "main~1"), before);
    assert_eq!(git(cwd, &["symbolic-ref", "--short", "HEAD"]), "feature");
    assert_eq!(std::fs::read_to_string(cwd.join("AGENTS.md")).unwrap(), AGENTS, "tree untouched");
    assert_eq!(std::fs::read_to_string(cwd.join("app.txt")).unwrap(), "feature work\n");
    assert_eq!(git(cwd, &["diff", "--name-only", "HEAD"]), "app.txt");
}

#[test]
fn a_merge_in_progress_refuses_it() {
    let repo = solo_repo();
    let cwd = repo.path();
    let proposal = agents_proposal(cwd);
    git(cwd, &["checkout", "-q", "-b", "side"]);
    std::fs::write(cwd.join("app.txt"), "side\n").unwrap();
    git(cwd, &["commit", "-q", "-am", "side"]);
    git(cwd, &["checkout", "-q", "main"]);
    git(cwd, &["merge", "-q", "--no-commit", "--no-ff", "side"]);
    let before = rev(cwd, "main");

    let why = approve(cwd, &proposal).expect_err("an unfinished merge refuses");
    assert!(why.contains("A merge is in progress"), "{why}");
    assert!(why.ends_with("Nothing was committed."), "{why}");
    assert_eq!(rev(cwd, "main"), before);
    assert!(cwd.join(".git/MERGE_HEAD").exists(), "the merge is left as it was");
    assert_eq!(std::fs::read_to_string(cwd.join("AGENTS.md")).unwrap(), AGENTS);
}

#[test]
fn no_git_identity_is_said_in_words_and_nothing_is_committed() {
    let repo = solo_repo();
    let cwd = repo.path();
    let proposal = agents_proposal(cwd);
    let before = rev(cwd, "main");
    // Empty values in the repository's own config override any global ones.
    git(cwd, &["config", "user.name", ""]);
    git(cwd, &["config", "user.email", ""]);

    let why = approve(cwd, &proposal).expect_err("no identity");
    assert_eq!(why, IDENTITY_MISSING);
    assert!(why.contains("Setup → Git"));
    assert_eq!(rev(cwd, "main"), before);
}

#[test]
fn a_ref_write_that_loses_a_race_rolls_the_checkout_back() {
    let repo = solo_repo();
    let cwd = repo.path().to_path_buf();
    let proposal = agents_proposal(&cwd);
    let mut raced = String::new();
    let mut race = || {
        let tree = git(&cwd, &["rev-parse", "HEAD^{tree}"]);
        let commit = git(&cwd, &["commit-tree", &tree, "-p", "HEAD", "-m", "race"]);
        git(&cwd, &["update-ref", "refs/heads/main", &commit]);
        raced = commit;
    };

    let why = approve_unshared_hooked("git", None, &proposal, &cwd, "main", 0, &mut race)
        .expect_err("the guarded ref write refuses");
    assert!(why.contains("main moved while Plyloft was committing"), "{why}");
    assert_eq!(rev(&cwd, "main"), raced, "the other writer's commit stands");
    assert_eq!(std::fs::read_to_string(cwd.join("AGENTS.md")).unwrap(), AGENTS, "tree rolled back");
    assert!(!cwd.join(".git/index.lock").exists(), "the index lock is released");
}

// ── With a remote: published, never over a newer change ─────────────

#[test]
fn with_a_bare_origin_the_change_is_pushed_and_the_checkout_follows() {
    let world = WithOrigin::new();
    let work = world.path("work");
    let before = world.origin_main();

    let approved = approve(&work, &agents_proposal(&work)).expect("published");
    assert_eq!(approved.title, "Published the change to main");
    assert_eq!(approved.body, "Your checkout has it too.");

    let after = world.origin_main();
    assert_ne!(after, before);
    let origin = world.path("origin.git");
    assert_eq!(rev(&origin, "main~1"), before, "one commit on origin");
    assert_eq!(changed_paths(&origin, "main"), vec!["AGENTS.md".to_string()]);
    assert_eq!(rev(&work, "main"), after, "the local branch was fast-forwarded");
    assert_eq!(std::fs::read_to_string(work.join("AGENTS.md")).unwrap(), AGENTS_AFTER);
}

#[test]
fn a_dirty_checkout_is_published_to_and_told_to_pull() {
    let world = WithOrigin::new();
    let work = world.path("work");
    let proposal = agents_proposal(&work);
    std::fs::write(work.join("app.txt"), "my own unfinished edit\n").unwrap();

    let approved = approve(&work, &proposal).expect("published");
    assert_eq!(approved.body, "Pull main to see it locally.");
    assert_eq!(
        std::fs::read_to_string(work.join("app.txt")).unwrap(),
        "my own unfinished edit\n"
    );
    assert_eq!(std::fs::read_to_string(work.join("AGENTS.md")).unwrap(), AGENTS);
}

#[test]
fn a_base_that_moved_on_origin_without_gh_is_blocked_and_nothing_is_pushed() {
    let world = WithOrigin::new();
    let work = world.path("work");
    let proposal = agents_proposal(&work);
    // A teammate changes AGENTS.md on origin; this checkout has not seen it.
    let other = world.path("other");
    // Appended below the diff's context, so the diff still applies there.
    std::fs::write(other.join("AGENTS.md"), "# Atelier\nRules.\nA teammate's rule.\n").unwrap();
    git(&other, &["commit", "-q", "-am", "teammate"]);
    git(&other, &["push", "-q", "origin", "main"]);
    let moved = world.origin_main();

    let why = approve(&work, &proposal).expect_err("blocked, not committed over");
    assert!(why.contains("AGENTS.md changed on main"), "{why}");
    assert!(
        why.ends_with(
            "Plyloft doesn't commit over it, and without the GitHub CLI it can't open a pull request. \
Nothing was published; the proposal stays here."
        ),
        "{why}"
    );
    assert_eq!(world.origin_main(), moved, "origin is exactly as the teammate left it");
    assert_eq!(std::fs::read_to_string(work.join("AGENTS.md")).unwrap(), AGENTS);
}

/// SP-5 review 2: with a remote, a copy origin never had or one the checkout
/// differs from is refused in the same words — never a pull request opened on
/// a "changed on main" that isn't true.
#[test]
fn with_a_remote_a_copy_that_is_not_mains_is_refused_not_sent_to_a_pull_request() {
    let world = WithOrigin::new();
    let work = world.path("work");
    let before = world.origin_main();
    std::fs::write(work.join("AGENTS.md"), "# Atelier\nRules.\nMine, not committed.\n").unwrap();
    let edited = agents_proposal(&work);
    assert_eq!(
        approve(&work, &edited).unwrap_err(),
        "Your checkout's AGENTS.md isn't the main on GitHub (uncommitted or unpushed changes, or \
another branch is checked out). Nothing was published; the proposal stays here."
    );

    git(&work, &["checkout", "--", "AGENTS.md"]);
    std::fs::write(work.join("CLAUDE.md"), AGENTS).unwrap();
    let untracked = StoredProposal {
        target: ProposalTarget::Instructions { file: "CLAUDE.md".into() },
        diff: Some(AGENTS_DIFF.replace("AGENTS.md", "CLAUDE.md")),
        target_content_id: target_content_id(&work, "CLAUDE.md"),
        target_blob: target_blob_with("git", &work, "CLAUDE.md"),
        ..agents_proposal(&work)
    };
    assert_eq!(
        approve(&work, &untracked).unwrap_err(),
        "CLAUDE.md isn't on main on GitHub yet. Commit it to main and push, then approve. \
Nothing was published; the proposal stays here."
    );
    assert_eq!(world.origin_main(), before, "nothing pushed, no pull request branch");
    assert_eq!(git(&world.path("origin.git"), &["branch", "--list"]), "* main");
}

/// SP-5 review 2 (Windows parity): a file committed with CRLF in a checkout
/// with `core.autocrlf=true` is clean, and is main's copy — the blob is the
/// index's, not a re-hash through today's filters.
#[test]
fn a_crlf_file_under_autocrlf_is_mains_copy_and_approves() {
    let repo = solo_repo();
    let cwd = repo.path();
    std::fs::write(cwd.join("AGENTS.md"), "# Atelier\r\nRules.\r\n").unwrap();
    git(cwd, &["commit", "-q", "-am", "crlf"]);
    git(cwd, &["config", "core.autocrlf", "true"]);
    assert_eq!(git(cwd, &["status", "--porcelain"]), "", "clean");
    let proposal = StoredProposal {
        diff: Some(
            [
                "--- a/AGENTS.md",
                "+++ b/AGENTS.md",
                "@@ -1,2 +1,3 @@",
                " # Atelier\r",
                "+Run the tests before reporting done.\r",
                " Rules.\r",
                "",
            ]
            .join("\n"),
        ),
        ..agents_proposal(cwd)
    };
    assert_eq!(proposal.target_blob.as_deref(), Some(git(cwd, &["rev-parse", "main:AGENTS.md"]).as_str()));
    assert_eq!(blocker(cwd, &proposal), None);
    approve(cwd, &proposal).expect("committed");
    assert_eq!(changed_paths(cwd, "main"), vec!["AGENTS.md".to_string()]);
    let committed = git(cwd, &["cat-file", "blob", "main:AGENTS.md"]);
    assert!(committed.contains("Run the tests before reporting done.\r\n"), "{committed:?}");
}

/// SP-5 review: the skill case in the toast's own words — no git stderr, and
/// not the queue's "waits on this Mac" (nothing was queued).
#[test]
fn a_skill_that_moved_on_origin_without_gh_is_said_in_its_own_words() {
    let world = WithOrigin::new();
    let work = world.path("work");
    let proposal = skill_proposal(&work);
    let other = world.path("other");
    // The skill's own target moves (below the diff's context, so it applies).
    std::fs::write(other.join(".claude/skills/deploy/SKILL.md"), "# Deploy\nPush it.\nTeammate.\n")
        .unwrap();
    git(&other, &["commit", "-q", "-am", "teammate"]);
    git(&other, &["push", "-q", "origin", "main"]);
    let moved = world.origin_main();

    let why = approve(&work, &proposal).expect_err("blocked, not committed over");
    assert!(why.starts_with("deploy changed on main"), "{why}");
    assert!(why.contains("Plyloft doesn't commit over it"), "{why}");
    assert!(why.ends_with("Nothing was published; the proposal stays here."), "{why}");
    assert!(!why.contains("waits on"), "{why}");
    assert!(!why.contains("git "), "no git stderr: {why}");
    assert_eq!(world.origin_main(), moved);
}

// ── SP-5 walk: a skill in both CLIs' roots ───────────────────────────

/// Give `dir` Codex's copy of `deploy` — the same files as Claude's, or with
/// its notes changed — and commit it.
fn codex_copy(dir: &Path, same: bool) {
    let codex = dir.join(".agents/skills/deploy");
    std::fs::create_dir_all(&codex).unwrap();
    std::fs::write(codex.join("SKILL.md"), "# Deploy\nPush it.\n").unwrap();
    std::fs::write(codex.join("notes.md"), if same { "Notes.\n" } else { "Codex's own notes.\n" })
        .unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", "codex copy"]);
}

#[test]
fn identical_copies_in_both_roots_change_together_in_one_commit() {
    let repo = solo_repo();
    let cwd = repo.path();
    codex_copy(cwd, true);
    let before = rev(cwd, "main");

    let git_ = Plumbing { cwd: cwd.to_path_buf() };
    assert_eq!(
        copies_hint_at("git", &git_, "refs/heads/main", &skill_proposal(cwd), cwd).as_deref(),
        Some("Codex's copy (.agents/skills/deploy) is the same file, so it changes too."),
        "said before the press"
    );
    let approved = approve(cwd, &skill_proposal(cwd)).expect("committed");
    assert!(
        approved.body.ends_with("Codex's copy (.agents/skills/deploy) was the same, so it changed too."),
        "{}",
        approved.body
    );
    assert_eq!(rev(cwd, "main~1"), before, "one commit");
    let mut changed = changed_paths(cwd, "main");
    changed.sort();
    assert_eq!(
        changed,
        vec![".agents/skills/deploy/SKILL.md".to_string(), ".claude/skills/deploy/SKILL.md".to_string()]
    );
    let claude = git(cwd, &["rev-parse", "main:.claude/skills/deploy"]);
    let codex = git(cwd, &["rev-parse", "main:.agents/skills/deploy"]);
    assert_eq!(claude, codex, "the two copies are still the same files");
    assert!(git(cwd, &["show", "main:.agents/skills/deploy/SKILL.md"]).contains("rollback test"));
    assert_eq!(git(cwd, &["status", "--porcelain"]), "");
}

#[test]
fn copies_that_already_differed_change_one_and_say_so() {
    let repo = solo_repo();
    let cwd = repo.path();
    codex_copy(cwd, false);
    let codex_before = git(cwd, &["rev-parse", "main:.agents/skills/deploy"]);

    let approved = approve(cwd, &skill_proposal(cwd)).expect("committed");
    assert_eq!(changed_paths(cwd, "main"), vec![".claude/skills/deploy/SKILL.md".to_string()]);
    assert_eq!(git(cwd, &["rev-parse", "main:.agents/skills/deploy"]), codex_before, "left as it is");
    assert!(
        approved.body.ends_with(
            "Only Claude's copy of deploy (.claude/skills/deploy) changed. Codex's copy \
(.agents/skills/deploy) was already different, so it was left as it is — compare the two and align them."
        ),
        "{}",
        approved.body
    );
}

#[test]
fn with_a_remote_identical_copies_are_published_together_not_sent_to_a_pull_request() {
    let world = WithOrigin::new();
    let other = world.path("other");
    codex_copy(&other, true);
    git(&other, &["push", "-q", "origin", "main"]);
    let work = world.path("work");
    git(&work, &["pull", "-q", "origin", "main"]);
    let before = world.origin_main();

    let approved = approve(&work, &skill_proposal(&work)).expect("published");
    assert_eq!(approved.title, "Published the change to main");
    let origin = world.path("origin.git");
    assert_eq!(rev(&origin, "main~1"), before);
    let mut changed = changed_paths(&origin, "main");
    changed.sort();
    assert_eq!(
        changed,
        vec![".agents/skills/deploy/SKILL.md".to_string(), ".claude/skills/deploy/SKILL.md".to_string()]
    );
}

/// Review: the other root moving on origin after the change was read sends it
/// to never-override through `moved_skill_roots` — for the Codex root too.
#[test]
fn a_codex_copy_that_moves_on_origin_after_the_read_is_never_committed_over() {
    let world = WithOrigin::new();
    let other = world.path("other");
    codex_copy(&other, true);
    git(&other, &["push", "-q", "origin", "main"]);
    let work = world.path("work");
    git(&work, &["pull", "-q", "origin", "main"]);
    let proposal = skill_proposal(&work);
    let plumbing = Plumbing { cwd: work.clone() };
    plumbing.fetch("main").unwrap();
    let tip = plumbing.tip("main").unwrap();
    let (change, _) = change_at("git", &plumbing, &tip, &proposal, &work).unwrap();
    assert_eq!(change.claimed().len(), 2, "both roots, each with its base");

    // A teammate edits Codex's copy only, after the read.
    std::fs::write(other.join(".agents/skills/deploy/notes.md"), "Codex-only edit.\n").unwrap();
    git(&other, &["commit", "-q", "-am", "codex edit"]);
    git(&other, &["push", "-q", "origin", "main"]);
    let moved = world.origin_main();

    let outcome =
        crate::shared_library_sync::publish_change(&plumbing, None, "main", &change, "atelier/proposal-t", 0);
    let crate::shared_library_sync::ChangeOutcome::Failed(why) = outcome else {
        panic!("never committed over: {outcome:?}");
    };
    assert!(why.contains(".agents/skills/deploy"), "{why}");
    assert_eq!(world.origin_main(), moved);
}

// ── Who is offered Approve ───────────────────────────────────────────

#[test]
fn the_state_offers_approve_with_a_target_branch_and_names_the_commit() {
    // Shared definition: the channel's rule, unchanged.
    assert_eq!(approve_offer(true, false, Some("main"), true), (true, None));
    assert_eq!(approve_offer(true, true, Some("main"), true), (false, None));
    // No definition, with a remote: `Approve and publish`.
    assert_eq!(approve_offer(false, false, Some("main"), true), (true, None));
    // No definition, no remote: `Approve and commit to main`.
    assert_eq!(
        approve_offer(false, false, Some("staging"), false),
        (true, Some("staging".to_string()))
    );
    // No integration branch: nowhere to commit, no button.
    assert_eq!(approve_offer(false, false, None, false), (false, None));
    assert_eq!(approve_offer(false, false, Some("  "), true), (false, None));
}
