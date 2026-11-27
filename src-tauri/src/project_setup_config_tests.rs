//! OB-13 tests: step 9's reading of a workspace on temporary repositories —
//! the chosen branch, `main`, the ask (C10: never a silent `main`), detached
//! and unborn HEADs, an empty new project (no checks), an existing config and
//! a shared definition. Git runs with its own global config and never looks
//! above the temporary folder.

use super::*;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

struct World {
    _tmp: tempfile::TempDir,
    root: PathBuf,
}

impl World {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = crate::platform::canonicalize(tmp.path()).unwrap();
        fs::write(
            root.join("gitconfig"),
            "[user]\n\tname = Test Person\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n",
        )
        .unwrap();
        Self { _tmp: tmp, root }
    }

    fn tools(&self) -> Tools {
        let global = self.root.join("gitconfig");
        let ceiling = self.root.parent().unwrap().to_path_buf();
        Tools {
            git: Arc::new(move || {
                let mut c = crate::platform::git_command();
                c.env("GIT_CONFIG_GLOBAL", &global)
                    .env("GIT_CONFIG_NOSYSTEM", "1")
                    .env("GIT_CEILING_DIRECTORIES", &ceiling)
                    .env_remove("GIT_DIR")
                    .env_remove("GIT_WORK_TREE")
                    .env_remove("GIT_INDEX_FILE");
                c
            }),
            gh: None,
            path: std::env::var("PATH").unwrap_or_default(),
        }
    }

    fn git(&self, dir: &Path, args: &[&str]) -> String {
        let mut c = self.tools().git_in(dir);
        c.args(args);
        let ran = project_setup::run(&mut c, Duration::from_secs(30)).unwrap();
        assert!(ran.ok(), "git {args:?}: {}", ran.words());
        ran.out()
    }

    fn dir(&self, rel: &str) -> PathBuf {
        let d = self.root.join(rel);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// A repository with one commit on `branch`.
    fn repo_on(&self, rel: &str, branch: &str) -> PathBuf {
        let d = self.dir(rel);
        self.git(&d, &["init", "-q", "-b", branch]);
        fs::write(d.join("README.md"), "# x\n").unwrap();
        self.git(&d, &["add", "-A"]);
        self.git(&d, &["commit", "-q", "-m", "one"]);
        d
    }

    fn detect(&self, cwd: &Path, chosen: Option<&str>) -> SetupConfigView {
        detect_for_setup(cwd, chosen, &self.tools(), None, false).unwrap()
    }
}

fn saved(branch: &str) -> ProjectConfig {
    let mut c = project_config::detect_with_branch(Path::new("/nonexistent"), branch.into(), "test").config;
    c.verify_pipeline = None;
    c
}

// ── The branch (C10) ────────────────────────────────────────────────────

#[test]
fn head_on_a_branch_with_a_commit_is_used() {
    let w = World::new();
    let d = w.repo_on("lyra", "develop");
    let v = w.detect(&d, None);
    assert_eq!(v.state, SetupConfigState::Proposal);
    assert_eq!(v.config.unwrap().target_branch, "develop");
    assert_eq!(v.branch_from, Some(BranchFrom::Head));
    assert_eq!(v.head, HeadKind::Branch);
}

#[test]
fn the_branch_chosen_in_step_8_wins_when_it_exists() {
    let w = World::new();
    let d = w.repo_on("lyra", "main");
    w.git(&d, &["branch", "release"]);
    let head = w.git(&d, &["rev-parse", "HEAD"]);
    w.git(&d, &["checkout", "-q", "--detach", &head]);
    let v = w.detect(&d, Some("release"));
    assert_eq!(v.state, SetupConfigState::Proposal);
    assert_eq!(v.config.unwrap().target_branch, "release");
    assert_eq!(v.branch_from, Some(BranchFrom::Chosen));
    assert_eq!(v.head, HeadKind::Detached);
}

#[test]
fn a_chosen_branch_that_is_gone_is_not_used() {
    let w = World::new();
    let d = w.repo_on("lyra", "main");
    let v = w.detect(&d, Some("deleted-since"));
    assert_eq!(v.config.unwrap().target_branch, "main");
    assert_eq!(v.branch_from, Some(BranchFrom::Head));
}

#[test]
fn detached_head_uses_main_only_because_it_exists() {
    let w = World::new();
    let d = w.repo_on("lyra", "main");
    let head = w.git(&d, &["rev-parse", "HEAD"]);
    w.git(&d, &["checkout", "-q", "--detach", &head]);
    let v = w.detect(&d, None);
    assert_eq!(v.state, SetupConfigState::Proposal);
    assert_eq!(v.config.unwrap().target_branch, "main");
    assert_eq!(v.branch_from, Some(BranchFrom::Main));
    assert_eq!(v.head, HeadKind::Detached);
}

#[test]
fn detached_head_without_main_asks_with_the_local_branches() {
    let w = World::new();
    let d = w.repo_on("lyra", "trunk");
    w.git(&d, &["branch", "master"]);
    let head = w.git(&d, &["rev-parse", "HEAD"]);
    w.git(&d, &["checkout", "-q", "--detach", &head]);
    let v = w.detect(&d, None);
    assert_eq!(v.state, SetupConfigState::NeedsBranch);
    let mut branches = v.branches.clone();
    branches.sort();
    assert_eq!(branches, vec!["master".to_string(), "trunk".to_string()]);
    assert_eq!(v.suggested_branch.as_deref(), Some("master"));
    // Never a silent `main`: the proposal's branch is left for the ask.
    assert_eq!(v.config.unwrap().target_branch, "");
    assert_eq!(v.branch_from, None);
}

#[test]
fn unborn_head_beside_other_branches_asks_unless_one_was_chosen() {
    let w = World::new();
    let d = w.repo_on("lyra", "dev");
    w.git(&d, &["checkout", "-q", "--orphan", "main"]);
    let v = w.detect(&d, None);
    assert_eq!(v.head, HeadKind::Unborn);
    assert_eq!(v.head_branch.as_deref(), Some("main"));
    assert_eq!(v.state, SetupConfigState::NeedsBranch);
    assert_eq!(v.branches, vec!["dev".to_string()]);
    let chosen = w.detect(&d, Some("dev"));
    assert_eq!(chosen.state, SetupConfigState::Proposal);
    assert_eq!(chosen.config.unwrap().target_branch, "dev");
}

#[test]
fn an_unborn_repository_is_step_8s_to_fix() {
    let w = World::new();
    let d = w.dir("lyra");
    w.git(&d, &["init", "-q", "-b", "main"]);
    let v = w.detect(&d, None);
    assert_eq!(v.state, SetupConfigState::NoCommit);
    assert!(v.config.is_none());
    // Not even with a branch name handed in.
    assert_eq!(w.detect(&d, Some("main")).state, SetupConfigState::NoCommit);
}

#[test]
fn a_folder_that_is_not_a_repository_says_so() {
    let w = World::new();
    let d = w.dir("plain");
    let v = w.detect(&d, None);
    assert_eq!(v.state, SetupConfigState::NotRepo);
    assert_eq!(v.head, HeadKind::NotRepo);
    assert!(v.config.is_none());
}

#[test]
fn choose_branch_never_defaults_to_main() {
    let facts = RepoFacts {
        head: HeadKind::Detached,
        head_branch: None,
        branches: vec!["trunk".into()],
    };
    assert_eq!(choose_branch(&facts, None), None);
    assert_eq!(choose_branch(&facts, Some("  ")), None);
    assert_eq!(
        choose_branch(&facts, Some("trunk")),
        Some(("trunk".into(), BranchFrom::Chosen))
    );
    // An unborn HEAD's branch isn't a branch cards can start from.
    let unborn = RepoFacts {
        head: HeadKind::Unborn,
        head_branch: Some("main".into()),
        branches: vec!["dev".into()],
    };
    assert_eq!(choose_branch(&unborn, None), None);
}

// ── What else the scan finds ───────────────────────────────────────────

#[test]
fn an_empty_new_project_gets_no_checks_no_version_and_nothing_after_shipping() {
    // What step 8c makes: `git init -b main`, README.md, a commit.
    let w = World::new();
    let d = w.repo_on("my-app", "main");
    let v = w.detect(&d, None);
    assert_eq!(v.state, SetupConfigState::Proposal);
    let c = v.config.unwrap();
    assert_eq!(c.target_branch, "main");
    assert!(c.version_files.is_empty());
    assert_eq!(c.install_script, None);
    assert_eq!(c.verify_pipeline, None);
    assert_eq!(v.detected_verify, None);
    assert_eq!(v.version, None);
}

#[test]
fn a_project_with_scripts_and_a_version_file_is_read() {
    let w = World::new();
    let d = w.repo_on("lyra", "main");
    fs::create_dir_all(d.join("scripts")).unwrap();
    fs::write(d.join("scripts/verify.sh"), "#!/bin/sh\n").unwrap();
    fs::write(d.join("scripts/install.sh"), "#!/bin/sh\n").unwrap();
    fs::write(d.join("package.json"), "{\"name\":\"lyra\",\"version\":\"1.4.2\"}").unwrap();
    let v = w.detect(&d, None);
    let c = v.config.unwrap();
    assert_eq!(c.install_script.as_deref(), Some("scripts/install.sh"));
    assert_eq!(
        c.verify_pipeline,
        Some(vec![VerifyKind::Script { path: "scripts/verify.sh".into() }])
    );
    assert_eq!(c.version_files.len(), 1);
    assert_eq!(v.version.as_deref(), Some("1.4.2"));
    assert_eq!(v.detected_verify, c.verify_pipeline);
}

// ── Saved and shared configs ───────────────────────────────────────────

#[test]
fn an_existing_config_is_shown_as_it_is() {
    let w = World::new();
    let d = w.repo_on("lyra", "main");
    fs::create_dir_all(d.join("scripts")).unwrap();
    fs::write(d.join("scripts/test.sh"), "#!/bin/sh\n").unwrap();
    w.git(&d, &["branch", "staging"]);
    let v = detect_for_setup(&d, None, &w.tools(), Some(saved("staging")), false).unwrap();
    assert_eq!(v.state, SetupConfigState::Existing);
    assert!(!v.read_only);
    assert_eq!(v.config.unwrap().target_branch, "staging");
    // The Change form still gets the branches and the script it can turn on.
    assert_eq!(v.branches.len(), 2);
    assert_eq!(
        v.detected_verify,
        Some(vec![VerifyKind::Script { path: "scripts/test.sh".into() }])
    );
}

#[test]
fn an_existing_config_is_shown_even_when_git_cannot_read_the_folder() {
    let w = World::new();
    let d = w.dir("gone-git");
    let v = detect_for_setup(&d, None, &w.tools(), Some(saved("main")), false).unwrap();
    assert_eq!(v.state, SetupConfigState::Existing);
    assert!(v.branches.is_empty());
}

#[test]
fn a_shared_definition_is_read_only_with_or_without_its_config_yet() {
    let w = World::new();
    let d = w.repo_on("lyra", "main");
    let v = detect_for_setup(&d, None, &w.tools(), Some(saved("main")), true).unwrap();
    assert_eq!(v.state, SetupConfigState::Shared);
    assert!(v.read_only);
    assert!(v.config.is_some());
    let waiting = detect_for_setup(&d, None, &w.tools(), None, true).unwrap();
    assert_eq!(waiting.state, SetupConfigState::Shared);
    assert!(waiting.read_only);
    assert!(waiting.config.is_none());
}

#[test]
fn a_definition_file_in_the_folder_counts_only_with_a_project_part() {
    let w = World::new();
    let d = w.repo_on("lyra", "main");
    let store = ProjectConfigStore::new(w.root.join("config")).unwrap();
    assert!(!shared_definition_has_project(&store, "ws1", &d));
    fs::create_dir_all(d.join(".atelier")).unwrap();
    fs::write(d.join(".atelier/workspace.json"), "{\"name\":\"lyra\"}").unwrap();
    assert!(!shared_definition_has_project(&store, "ws1", &d));
    fs::write(
        d.join(".atelier/workspace.json"),
        "{\"name\":\"lyra\",\"integrationBranch\":\"main\"}",
    )
    .unwrap();
    assert!(shared_definition_has_project(&store, "ws1", &d));
}

// ── Tier 4 proxy: a card can start right after step 9 ───────────────────

#[test]
fn a_card_worktree_starts_from_the_saved_branch_right_after_setup() {
    // An empty new project (8c) and a detached HEAD with the branch chosen
    // at 8a: step 9's config, then the card start's own worktree call.
    let w = World::new();
    for (rel, detach, chosen) in [("fresh", false, None), ("detached", true, Some("release"))] {
        let d = w.repo_on(rel, "main");
        if detach {
            w.git(&d, &["branch", "release"]);
            let head = w.git(&d, &["rev-parse", "HEAD"]);
            w.git(&d, &["checkout", "-q", "--detach", &head]);
        }
        let v = w.detect(&d, chosen);
        let config = v.config.unwrap();
        let store = ProjectConfigStore::new(w.root.join(format!("config-{rel}"))).unwrap();
        store.set_keeping_review("ws", config.clone()).unwrap();
        let target = store.get("ws").unwrap().target_branch;
        assert_eq!(target, chosen.unwrap_or("main"));
        let made = crate::worktrees::ensure_for_card(&d, "c1", "First card", &target).unwrap();
        assert!(made.created, "{rel}: worktree created");
        assert!(made.worktree_path.join("README.md").is_file());
    }
}

/// n16: the start's set-up reads origin's default from local refs only, and
/// only from `refs/remotes/origin/HEAD` — never guessed from `main` or
/// HEAD's branch (a pushed, not cloned, repository has no such ref).
#[test]
fn local_origin_reads_only_origins_own_head_and_never_fetches() {
    let git = |dir: &Path, args: &[&str]| {
        let out = crate::platform::git_command().args(args).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    let tmp = tempfile::tempdir().unwrap();
    let seed = tmp.path().join("seed");
    fs::create_dir(&seed).unwrap();
    git(&seed, &["init", "-q", "-b", "trunk"]);
    git(&seed, &["config", "user.email", "t@t.test"]);
    git(&seed, &["config", "user.name", "t"]);
    git(&seed, &["config", "commit.gpgsign", "false"]);
    fs::write(seed.join("a"), "a\n").unwrap();
    git(&seed, &["add", "a"]);
    git(&seed, &["commit", "-q", "-m", "a"]);
    // No origin at all.
    assert_eq!(local_origin(&seed), LocalOrigin { has_origin: false, default_branch: None, github_repo: None });

    // Pushed, not cloned: an origin with no origin/HEAD, on a feature branch.
    let bare = tmp.path().join("origin.git");
    git(tmp.path(), &["init", "-q", "--bare", bare.to_str().unwrap()]);
    git(&seed, &["checkout", "-q", "-b", "feature"]);
    git(&seed, &["remote", "add", "origin", bare.to_str().unwrap()]);
    git(&seed, &["push", "-q", "origin", "feature", "trunk"]);
    assert_eq!(
        local_origin(&seed),
        LocalOrigin { has_origin: true, default_branch: None, github_repo: None },
        "no origin/HEAD: no default, never the checked-out feature branch"
    );

    // Cloned: origin/HEAD names the default.
    let clone = tmp.path().join("clone");
    git(tmp.path(), &["clone", "-q", bare.to_str().unwrap(), clone.to_str().unwrap()]);
    git(&clone, &["remote", "set-head", "origin", "trunk"]);
    assert_eq!(local_origin(&clone), LocalOrigin { has_origin: true, default_branch: Some("trunk".into()), github_repo: None });

    // An unreachable origin answers at once: nothing is fetched.
    git(&clone, &["remote", "set-url", "origin", "https://example.invalid/r.git"]);
    let started = std::time::Instant::now();
    assert_eq!(local_origin(&clone).default_branch.as_deref(), Some("trunk"));
    assert!(started.elapsed() < Duration::from_secs(5));

    // N18: a GitHub origin names its repository (offline: only the URL is read).
    git(&clone, &["remote", "set-url", "origin", "git@github.com:acme/lyra.git"]);
    assert_eq!(local_origin(&clone).github_repo.as_deref(), Some("acme/lyra"));
}
