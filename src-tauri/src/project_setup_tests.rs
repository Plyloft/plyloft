//! OB-11 tests: every row of the spec's step 8 tables on temporary
//! repositories (a bare remote for the empty-repository push), the scans and
//! their bounds, the names, and the GitHub side through a stub `gh` — never
//! the network, never the owner's own repositories or folders.

use super::*;
use std::fs;

// ── Fixtures ───────────────────────────────────────────────────────────

/// A temporary world: a fake home with a projects folder, a git global
/// config of its own, and git never looking above it.
struct World {
    _tmp: tempfile::TempDir,
    root: PathBuf,
}

impl World {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = canonical(tmp.path());
        fs::create_dir_all(root.join("home/Projects")).unwrap();
        let w = Self { _tmp: tmp, root };
        w.set_identity(true);
        w
    }

    fn home(&self) -> PathBuf {
        self.root.join("home")
    }

    fn projects(&self) -> PathBuf {
        self.root.join("home/Projects")
    }

    fn global(&self) -> PathBuf {
        self.root.join("gitconfig")
    }

    fn set_identity(&self, on: bool) {
        let base = "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n";
        let text = if on {
            format!("[user]\n\tname = Test Person\n\temail = test@example.com\n{base}")
        } else {
            base.to_string()
        };
        fs::write(self.global(), text).unwrap();
    }

    /// A failing pre-commit hook for every repository (`core.hooksPath`).
    #[cfg(unix)]
    fn failing_hooks(&self) {
        self.pre_commit("echo no >&2\nexit 1\n");
    }

    /// A pre-commit hook running `body` for every repository.
    #[cfg(unix)]
    fn pre_commit(&self, body: &str) {
        let hooks = self.root.join("hooks");
        fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("pre-commit");
        fs::write(&hook, format!("#!/bin/sh\n{body}")).unwrap();
        crate::platform::set_mode(&hook, 0o755).unwrap();
        let mut text = fs::read_to_string(self.global()).unwrap();
        text.push_str(&format!(
            "[core]\n\thooksPath = {}\n",
            crate::platform::slash_path(&hooks)
        ));
        fs::write(self.global(), text).unwrap();
    }

    fn tools(&self, gh: Option<String>) -> Tools {
        let global = self.global();
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
            gh,
            path: std::env::var("PATH").unwrap_or_default(),
        }
    }

    fn ctx(&self, workspaces: Vec<WorkspaceRef>) -> InspectCtx {
        InspectCtx {
            tools: self.tools(None),
            home: Some(self.home()),
            projects_folder: Some(self.projects()),
            workspaces,
            limits: ScanLimits::REAL,
        }
    }

    fn dir(&self, rel: &str) -> PathBuf {
        let d = self.root.join(rel);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn git(&self, dir: &Path, args: &[&str]) -> String {
        let ran = git_ran(&self.tools(None), dir, args, Duration::from_secs(30)).unwrap();
        assert!(ran.ok(), "git {args:?}: {}", ran.words());
        ran.out()
    }

    fn git_ok(&self, dir: &Path, args: &[&str]) -> bool {
        git_ran(&self.tools(None), dir, args, Duration::from_secs(30))
            .unwrap()
            .ok()
    }

    /// A repository with one commit on `main`.
    fn repo(&self, rel: &str) -> PathBuf {
        let d = self.dir(rel);
        self.git(&d, &["init", "-q", "-b", "main"]);
        fs::write(d.join("a.txt"), "a").unwrap();
        self.git(&d, &["add", "-A"]);
        self.git(&d, &["commit", "-q", "-m", "one"]);
        d
    }

    fn tracked(&self, dir: &Path) -> Vec<String> {
        let mut files: Vec<String> = self
            .git(dir, &["ls-files"])
            .lines()
            .map(String::from)
            .collect();
        files.sort();
        files
    }
}

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn ws(id: &str, cwd: &Path) -> WorkspaceRef {
    WorkspaceRef {
        id: id.into(),
        name: id.into(),
        cwd: cwd.to_string_lossy().into_owned(),
    }
}

// ── 8a: every row of the table ─────────────────────────────────────────

#[test]
fn a_repo_with_a_commit_on_a_branch_is_ready_to_add() {
    let w = World::new();
    let d = w.repo("home/code/lyra");
    let r = inspect(&d, &w.ctx(vec![])).unwrap();
    assert_eq!(r.outcome, InspectOutcome::Ready);
    assert_eq!(r.name, "lyra");
    assert!(matches!(&r.git, GitState::Branch { branch, .. } if branch == "main"));
    assert_eq!(r.branches, vec!["main".to_string()]);
    assert!(r.identity_ready && !r.needs_identity);
    assert!(!r.uncommitted_changes);
    // Nothing to save in a repository that has commits.
    assert!(r.to_save.is_none());
}

#[test]
fn a_folder_already_in_ply_is_found_by_its_canonical_path() {
    let w = World::new();
    let d = w.repo("home/code/lyra");
    // Registered through a path that only canonicalises to the same folder.
    let roundabout = d.join("..").join("lyra");
    let r = inspect(&d, &w.ctx(vec![ws("w1", &roundabout)])).unwrap();
    assert_eq!(r.outcome, InspectOutcome::AlreadyInPly);
    assert_eq!(r.existing_workspace.unwrap().id, "w1");
    let e = init(
        &d,
        &InitChoices::default(),
        &w.ctx(vec![ws("w1", &roundabout)]),
    )
    .unwrap_err();
    assert!(e.contains("already in Plyloft"), "{e}");
}

#[test]
fn a_folder_that_isnt_a_repo_is_offered_git_and_init_makes_the_first_commit() {
    let w = World::new();
    let d = w.dir("home/code/lyra");
    write(&d.join("src/main.rs"), "fn main() {}");
    write(&d.join("README.md"), "# lyra");
    write(&d.join("node_modules/x/index.js"), "junk");
    write(&d.join("build/out.o"), "junk");
    let r = inspect(&d, &w.ctx(vec![])).unwrap();
    assert_eq!(r.outcome, InspectOutcome::NotARepo);
    assert_eq!(r.git, GitState::NotRepo);
    let save = r.to_save.clone().unwrap();
    // node_modules and build output aren't counted: the .gitignore leaves them out.
    assert_eq!(save.files, 2);
    assert!(save.complete && !save.huge);
    let names: Vec<&str> = save.top_level.iter().map(|t| t.name.as_str()).collect();
    assert!(names.contains(&"src") && names.contains(&"README.md"));
    assert_eq!(r.ignore_lines.len(), INIT_IGNORE.len());

    let done = init(&d, &InitChoices::default(), &w.ctx(vec![])).unwrap();
    assert!(done.initialised);
    assert_eq!(done.branch, "main");
    assert_eq!(w.git(&d, &["log", "-1", "--format=%s"]), "chore: first commit");
    assert_eq!(w.tracked(&d), vec![".gitignore", "README.md", "src/main.rs"]);
    let ignore = fs::read_to_string(d.join(".gitignore")).unwrap();
    assert!(ignore.starts_with(IGNORE_HEADER));
    assert!(ignore.contains("node_modules/") && ignore.contains(".env"));
    // Observed: the folder is now the Ready row.
    assert_eq!(
        inspect(&d, &w.ctx(vec![])).unwrap().outcome,
        InspectOutcome::Ready
    );
}

#[test]
fn a_repo_without_commits_gets_its_first_commit_without_git_init() {
    let w = World::new();
    let d = w.dir("home/code/lyra");
    w.git(&d, &["init", "-q", "-b", "trunk"]);
    write(&d.join("app.py"), "print(1)");
    // A .gitignore of the user's own: kept, Ply's lines appended.
    write(&d.join(".gitignore"), "*.log\nnode_modules/\n");
    write(&d.join("debug.log"), "x");
    let r = inspect(&d, &w.ctx(vec![])).unwrap();
    assert_eq!(r.outcome, InspectOutcome::NoCommits);
    assert!(matches!(&r.git, GitState::Unborn { branch: Some(b) } if b == "trunk"));
    // The ignored log isn't counted; .gitignore and app.py are.
    assert_eq!(r.to_save.as_ref().unwrap().files, 2);
    assert!(!r.ignore_lines.contains(&"node_modules/".to_string()));

    let done = init(&d, &InitChoices::default(), &w.ctx(vec![])).unwrap();
    assert!(!done.initialised);
    assert_eq!(done.branch, "trunk");
    let ignore = fs::read_to_string(d.join(".gitignore")).unwrap();
    assert!(
        ignore.starts_with("*.log\nnode_modules/\n\n# Added by Plyloft\n"),
        "{ignore}"
    );
    assert_eq!(ignore.matches("node_modules/").count(), 1);
    assert_eq!(w.tracked(&d), vec![".gitignore", "app.py"]);
}

#[test]
fn a_detached_head_asks_which_branch_and_suggests_main() {
    let w = World::new();
    let d = w.repo("home/code/lyra");
    w.git(&d, &["checkout", "-q", "-b", "feature"]);
    fs::write(d.join("b.txt"), "b").unwrap();
    w.git(&d, &["add", "-A"]);
    w.git(&d, &["commit", "-q", "-m", "two"]);
    w.git(&d, &["checkout", "-q", "--detach", "HEAD"]);
    let r = inspect(&d, &w.ctx(vec![])).unwrap();
    assert_eq!(r.outcome, InspectOutcome::ChooseBranch);
    assert!(matches!(r.git, GitState::Detached { .. }));
    assert_eq!(r.suggested_branch.as_deref(), Some("main"));
    let mut branches = r.branches.clone();
    branches.sort();
    assert_eq!(branches, vec!["feature", "main"]);
    // Ply doesn't switch the folder's branch: HEAD is still detached.
    assert!(!w.git_ok(&d, &["symbolic-ref", "-q", "HEAD"]));
}

#[test]
fn an_unborn_head_beside_branches_with_commits_asks_which_branch() {
    // Spec 8b's last row (the default branch has no commits, others do),
    // seen in a folder.
    let w = World::new();
    let d = w.repo("home/code/lyra");
    w.git(&d, &["branch", "-q", "-m", "main", "dev"]);
    w.git(&d, &["checkout", "-q", "--orphan", "main"]);
    let r = inspect(&d, &w.ctx(vec![])).unwrap();
    assert_eq!(r.outcome, InspectOutcome::ChooseBranch);
    assert_eq!(r.suggested_branch.as_deref(), Some("dev"));
    assert!(init(&d, &InitChoices::default(), &w.ctx(vec![])).is_err());
}

#[test]
fn a_folder_inside_another_repo_names_it_and_is_never_made_a_nested_repo() {
    let w = World::new();
    let mono = w.repo("home/code/monorepo");
    let sub = w.dir("home/code/monorepo/packages/lyra");
    write(&sub.join("x.txt"), "x");
    let r = inspect(&sub, &w.ctx(vec![ws("m", &mono)])).unwrap();
    assert_eq!(r.outcome, InspectOutcome::InsideAnotherRepo);
    match &r.git {
        GitState::InsideAnother {
            top_level,
            name,
            in_ply,
        } => {
            assert_eq!(Path::new(top_level), mono.as_path());
            assert_eq!(name, "monorepo");
            assert_eq!(in_ply.as_ref().unwrap().id, "m");
        }
        other => panic!("{other:?}"),
    }
    let e = init(&sub, &InitChoices::default(), &w.ctx(vec![])).unwrap_err();
    assert!(e.contains("never makes a Git project inside another"), "{e}");
    assert!(!sub.join(".git").exists());
}

#[test]
fn a_home_folder_kept_in_git_doesnt_make_every_folder_inside_another_repo() {
    let w = World::new();
    w.git(&w.home(), &["init", "-q", "-b", "main"]);
    let d = w.dir("home/code/lyra");
    write(&d.join("x.txt"), "x");
    let r = inspect(&d, &w.ctx(vec![])).unwrap();
    assert_eq!(r.outcome, InspectOutcome::NotARepo);
}

#[test]
fn a_huge_folder_warns_and_the_count_is_bounded() {
    let w = World::new();
    let d = w.dir("home/code/big");
    for i in 0..30 {
        write(&d.join(format!("dir{}/f{i}.txt", i % 3)), "x");
    }
    // Over the file threshold: huge.
    let mut ctx = w.ctx(vec![]);
    ctx.limits = ScanLimits {
        huge_files: 20,
        ..ScanLimits::REAL
    };
    let s = inspect(&d, &ctx).unwrap().to_save.unwrap();
    assert!(s.huge && s.complete);
    assert_eq!(s.files, 30);
    assert_eq!(s.top_level.len(), 3);
    // Over the byte threshold: huge.
    ctx.limits = ScanLimits {
        huge_bytes: 10,
        ..ScanLimits::REAL
    };
    assert!(inspect(&d, &ctx).unwrap().to_save.unwrap().huge);
    // The count stops at its file bound (50 000 in production)…
    ctx.limits = ScanLimits {
        max_files: 7,
        ..ScanLimits::REAL
    };
    let s = inspect(&d, &ctx).unwrap().to_save.unwrap();
    assert!(!s.complete && s.huge);
    assert_eq!(s.files, 7);
    // …and at its time bound (5 s in production), in a repository too.
    ctx.limits = ScanLimits {
        max_time: Duration::ZERO,
        ..ScanLimits::REAL
    };
    assert!(!inspect(&d, &ctx).unwrap().to_save.unwrap().complete);
    w.git(&d, &["init", "-q", "-b", "main"]);
    assert!(!inspect(&d, &ctx).unwrap().to_save.unwrap().complete);
    ctx.limits = ScanLimits {
        max_files: 5,
        ..ScanLimits::REAL
    };
    let s = inspect(&d, &ctx).unwrap().to_save.unwrap();
    assert!(!s.complete);
    assert_eq!(s.files, 5);
    assert_eq!(ScanLimits::REAL.max_files, 50_000);
    assert_eq!(ScanLimits::REAL.max_time, Duration::from_secs(5));
    assert_eq!(ScanLimits::REAL.huge_files, 20_000);
    assert_eq!(ScanLimits::REAL.huge_bytes, 1 << 30);
}

#[test]
fn files_over_50_mb_are_left_out_unless_unticked() {
    let w = World::new();
    let d = w.dir("home/code/media");
    write(&d.join("notes.txt"), "n");
    // A sparse file just over the real threshold (nothing is written).
    let big = fs::File::create(d.join("video.mov")).unwrap();
    big.set_len(LARGE_FILE_BYTES + 1).unwrap();
    drop(big);
    let r = inspect(&d, &w.ctx(vec![])).unwrap();
    assert_eq!(
        r.large_files,
        vec![FoundFile {
            path: "video.mov".into(),
            bytes: LARGE_FILE_BYTES + 1
        }]
    );
    // Not counted in what will be saved.
    assert_eq!(r.to_save.unwrap().files, 1);
    let done = init(
        &d,
        &InitChoices {
            leave_out: vec!["video.mov".into()],
            ..Default::default()
        },
        &w.ctx(vec![]),
    )
    .unwrap();
    assert!(done.ignore_added.contains(&"/video.mov".to_string()));
    assert_eq!(w.tracked(&d), vec![".gitignore", "notes.txt"]);

    // Unticked (a small threshold keeps the commit small): it is saved.
    let d2 = w.dir("home/code/media2");
    write(&d2.join("clip.bin"), &"x".repeat(200));
    let mut ctx = w.ctx(vec![]);
    ctx.limits = ScanLimits {
        large_file_bytes: 100,
        ..ScanLimits::REAL
    };
    assert_eq!(inspect(&d2, &ctx).unwrap().large_files.len(), 1);
    init(&d2, &InitChoices::default(), &ctx).unwrap();
    assert_eq!(w.tracked(&d2), vec![".gitignore", "clip.bin"]);
}

#[test]
fn likely_secrets_are_left_out_and_an_unticked_env_file_is_kept_in() {
    let w = World::new();
    let d = w.dir("home/code/api");
    for f in [
        ".env",
        "config/.env.local",
        "certs/server.pem",
        "certs/tls.key",
        "keys/id_rsa",
        "keys/id_rsa.pub",
        ".env.example",
        "main.go",
    ] {
        write(&d.join(f), "s");
    }
    let r = inspect(&d, &w.ctx(vec![])).unwrap();
    let mut secrets: Vec<&str> = r.secrets.iter().map(|s| s.path.as_str()).collect();
    secrets.sort();
    assert_eq!(
        secrets,
        vec![
            ".env",
            "certs/server.pem",
            "certs/tls.key",
            "config/.env.local",
            "keys/id_rsa"
        ]
    );
    let all: Vec<String> = r.secrets.iter().map(|s| s.path.clone()).collect();
    init(&d, &InitChoices { leave_out: all, ..Default::default() }, &w.ctx(vec![])).unwrap();
    assert_eq!(
        w.tracked(&d),
        vec![".env.example", ".gitignore", "keys/id_rsa.pub", "main.go"]
    );

    // `.env` unticked: the defaults would still leave it out, so a `!` line
    // keeps it in; the others stay out.
    let d2 = w.dir("home/code/api2");
    for f in [".env", "config/.env.local", "certs/tls.key", "main.go"] {
        write(&d2.join(f), "s");
    }
    let done = init(
        &d2,
        &InitChoices {
            leave_out: vec!["config/.env.local".into(), "certs/tls.key".into()],
            ..Default::default()
        },
        &w.ctx(vec![]),
    )
    .unwrap();
    assert!(done.ignore_added.contains(&"!/.env".to_string()));
    assert_eq!(w.tracked(&d2), vec![".env", ".gitignore", "main.go"]);
}

#[test]
fn init_takes_only_files_the_scan_found_and_leaves_the_folder_as_it_was() {
    let w = World::new();
    let d = w.dir("home/code/lyra");
    write(&d.join("a.txt"), "a");
    for bad in ["../../etc/passwd", "a.txt", "nope.pem", "*"] {
        let e = init(
            &d,
            &InitChoices {
                leave_out: vec![bad.into()],
                ..Default::default()
            },
            &w.ctx(vec![]),
        )
        .unwrap_err();
        assert!(e.contains("isn't in this folder"), "{bad}: {e}");
    }
    assert!(!d.join(".git").exists() && !d.join(".gitignore").exists());
    // Unknown fields never decode.
    assert!(serde_json::from_str::<InitChoices>(r#"{"leaveOut":[],"command":"rm"}"#).is_err());
    assert_eq!(
        serde_json::from_str::<InitChoices>(r#"{"leaveOut":["a"]}"#)
            .unwrap()
            .leave_out,
        vec!["a"]
    );
}

#[cfg(unix)]
#[test]
fn a_failed_first_commit_puts_the_folder_back() {
    let w = World::new();
    w.failing_hooks();
    // Not a repo: the .git Ply made and the .gitignore it wrote go.
    let d = w.dir("home/code/lyra");
    write(&d.join("a.txt"), "a");
    assert!(init(&d, &InitChoices::default(), &w.ctx(vec![])).is_err());
    assert!(!d.join(".git").exists());
    assert!(!d.join(".gitignore").exists());
    assert!(d.join("a.txt").exists());
    // No commits yet: the user's .gitignore is restored, the index unstaged.
    let d2 = w.dir("home/code/lyra2");
    w.git(&d2, &["init", "-q", "-b", "main"]);
    write(&d2.join(".gitignore"), "*.log\n");
    write(&d2.join("b.txt"), "b");
    write(&d2.join("c.txt"), "c");
    // Something the person had staged themselves stays staged.
    w.git(&d2, &["add", "b.txt"]);
    assert!(init(&d2, &InitChoices::default(), &w.ctx(vec![])).is_err());
    assert_eq!(fs::read_to_string(d2.join(".gitignore")).unwrap(), "*.log\n");
    assert!(d2.join(".git").exists());
    assert_eq!(w.git(&d2, &["ls-files"]), "b.txt");
}

#[test]
fn uncommitted_changes_in_a_repo_with_commits_are_only_a_hint() {
    let w = World::new();
    let d = w.repo("home/code/lyra");
    fs::write(d.join("a.txt"), "changed").unwrap();
    let r = inspect(&d, &w.ctx(vec![])).unwrap();
    assert_eq!(r.outcome, InspectOutcome::Ready);
    assert!(r.uncommitted_changes);
    let d2 = w.repo("home/code/lyra2");
    write(&d2.join("new.txt"), "n");
    assert!(inspect(&d2, &w.ctx(vec![])).unwrap().uncommitted_changes);
}

// ── 8a: saving the work first (1.171.0 D3, FR-5) ───────────────────────

#[test]
fn the_work_sheet_names_at_most_twenty_files_and_never_the_ones_left_out() {
    let names: Vec<String> = (0..30).rev().map(|i| format!("f{i:02}.txt")).chain([".env".to_string()]).collect();
    let secret = FoundFile { path: ".env".into(), bytes: 1 };
    let large = FoundFile { path: "f00.txt".into(), bytes: 1 };
    let listed = work_files_listed(&names, &[large], &[secret]);
    assert_eq!(listed.len(), WORK_FILES_LISTED);
    // Sorted, whatever order Git named them in.
    assert_eq!(listed[0], "f01.txt");
    assert_eq!(listed[19], "f20.txt");
    assert!(!listed.contains(&".env".to_string()) && !listed.contains(&"f00.txt".to_string()));
}

#[test]
fn uncommitted_files_are_counted_and_looking_never_commits() {
    let w = World::new();
    let d = w.repo("home/code/lyra");
    assert_eq!(inspect(&d, &w.ctx(vec![])).unwrap().uncommitted_files, 0);
    fs::write(d.join("a.txt"), "changed").unwrap();
    write(&d.join("src/new.js"), "n");
    write(&d.join("notes.md"), "m");
    w.git(&d, &["add", "notes.md"]);
    let head = w.git(&d, &["rev-parse", "HEAD"]);
    let r = inspect(&d, &w.ctx(vec![])).unwrap();
    assert!(r.uncommitted_changes);
    assert_eq!(r.uncommitted_files, 3);
    // The plain look doesn't scan what saving would put in Git.
    assert!(r.to_save.is_none());
    let work = inspect_work(&d, &w.ctx(vec![])).unwrap();
    assert_eq!(work.to_save.as_ref().unwrap().files, 3);
    // Looking writes nothing: same commit, same index, no .gitignore.
    assert_eq!(w.git(&d, &["rev-parse", "HEAD"]), head);
    assert_eq!(w.git(&d, &["diff", "--cached", "--name-only"]), "notes.md");
    assert!(!d.join(".gitignore").exists());
    // A clean folder has nothing to save.
    let clean = w.repo("home/code/clean");
    assert_eq!(inspect_work(&clean, &w.ctx(vec![])).unwrap_err(), NOTHING_TO_SAVE);
    assert_eq!(
        save_work(&clean, &InitChoices::default(), &w.ctx(vec![])).unwrap_err(),
        NOTHING_TO_SAVE
    );
}

#[test]
fn saving_the_work_commits_it_on_the_current_branch_and_pushes_nothing() {
    let w = World::new();
    let remote = w.dir("home/remote.git");
    w.git(&remote, &["init", "-q", "--bare"]);
    let d = w.repo("home/code/lyra");
    w.git(&d, &["remote", "add", "origin", &remote.to_string_lossy()]);
    w.git(&d, &["push", "-q", "origin", "main"]);
    w.git(&d, &["checkout", "-q", "-b", "my-work"]);
    let remote_main = w.git(&remote, &["rev-parse", "main"]);
    let before = w.git(&d, &["rev-parse", "HEAD"]);
    fs::write(d.join("a.txt"), "changed").unwrap();
    write(&d.join("src/new.js"), "n");
    write(&d.join(".env"), "SECRET=1");
    write(&d.join("node_modules/x/index.js"), "x");
    let work = inspect_work(&d, &w.ctx(vec![])).unwrap();
    let secrets: Vec<String> = work.secrets.iter().map(|f| f.path.clone()).collect();
    assert_eq!(secrets, vec![".env"]);
    // New packages are one folder, left out by its own line, never a default.
    assert_eq!(work.build_folders, vec![FoundFolder { path: "node_modules/".into(), files: 1 }]);
    assert!(work.ignore_lines.is_empty() && work.work_tracked.is_empty());
    // 1.171.0 walk fix: the sheet names the files it saves — not the
    // secret, not the packages.
    assert_eq!(work.work_files, vec!["a.txt".to_string(), "src/new.js".to_string()]);
    let mut leave_out = secrets;
    leave_out.push("node_modules/".into());
    assert_eq!(
        work_ignore_plan(&d, &leave_out).unwrap(),
        vec!["/.env".to_string(), "/node_modules/".to_string()]
    );
    let done = save_work(
        &d,
        &InitChoices { leave_out, ..Default::default() },
        &w.ctx(vec![]),
    )
    .unwrap();
    assert_eq!(done.branch, "my-work");
    assert_eq!(w.git(&d, &["rev-parse", "--abbrev-ref", "HEAD"]), "my-work");
    assert_eq!(w.git(&d, &["rev-parse", "HEAD^"]), before);
    // The work is saved; the secret and node_modules are not.
    assert_eq!(w.tracked(&d), vec![".gitignore", "a.txt", "src/new.js"]);
    assert_eq!(w.git(&d, &["show", "HEAD:a.txt"]), "changed");
    assert!(d.join(".env").exists());
    assert_eq!(done.ignore_added, vec!["/.env".to_string(), "/node_modules/".to_string()]);
    assert_eq!(w.git(&d, &["log", "-1", "--format=%s"]), crate::commit_message::SAVE_WORK);
    // Local only: main didn't move, nothing reached the remote.
    assert_eq!(w.git(&d, &["rev-parse", "main"]), before);
    assert_eq!(w.git(&remote, &["rev-parse", "main"]), remote_main);
    assert!(!w.git_ok(&remote, &["rev-parse", "--verify", "-q", "refs/heads/my-work"]));
    assert!(!inspect(&d, &w.ctx(vec![])).unwrap().uncommitted_changes);
}

#[test]
fn a_tracked_secret_left_out_keeps_its_saved_version() {
    let w = World::new();
    let d = w.repo("home/code/lyra");
    write(&d.join("certs/tls.key"), "old");
    w.git(&d, &["add", "-A"]);
    w.git(&d, &["commit", "-q", "-m", "key"]);
    fs::write(d.join("certs/tls.key"), "new").unwrap();
    fs::write(d.join("a.txt"), "changed").unwrap();
    save_work(
        &d,
        &InitChoices { leave_out: vec!["certs/tls.key".into()], ..Default::default() },
        &w.ctx(vec![]),
    )
    .unwrap();
    // Never deleted from Git, never saved with its new contents, and no
    // ignore line for a file Git has.
    assert_eq!(w.git(&d, &["show", "HEAD:certs/tls.key"]), "old");
    assert!(!d.join(".gitignore").exists());
    assert_eq!(fs::read_to_string(d.join("certs/tls.key")).unwrap(), "new");
    // Only that secret changed and its ignore line is already there:
    // everything is left out, so nothing is made.
    let d2 = w.repo("home/code/lyra2");
    let mut ignore = INIT_IGNORE.join("\n");
    ignore.push_str("\n/server.pem\n");
    write(&d2.join(".gitignore"), &ignore);
    write(&d2.join("server.pem"), "old");
    w.git(&d2, &["add", "-A"]);
    w.git(&d2, &["add", "-f", "server.pem"]);
    w.git(&d2, &["commit", "-q", "-m", "ignore"]);
    fs::write(d2.join("server.pem"), "new").unwrap();
    let head = w.git(&d2, &["rev-parse", "HEAD"]);
    let e = save_work(
        &d2,
        &InitChoices { leave_out: vec!["server.pem".into()], ..Default::default() },
        &w.ctx(vec![]),
    )
    .unwrap_err();
    assert_eq!(e, ALL_LEFT_OUT);
    assert_eq!(w.git(&d2, &["rev-parse", "HEAD"]), head);
}

#[test]
fn saving_the_work_needs_a_branch_an_identity_and_known_files() {
    let w = World::new();
    let d = w.repo("home/code/lyra");
    fs::write(d.join("a.txt"), "changed").unwrap();
    let e = save_work(
        &d,
        &InitChoices { leave_out: vec!["a.txt".into()], ..Default::default() },
        &w.ctx(vec![]),
    )
    .unwrap_err();
    assert!(e.contains("isn't in this folder"), "{e}");
    w.set_identity(false);
    assert_eq!(save_work(&d, &InitChoices::default(), &w.ctx(vec![])).unwrap_err(), IDENTITY_FOR_SAVE);
    w.set_identity(true);
    // A count that stopped is never saved, even if asked to go on.
    let mut small = w.ctx(vec![]);
    small.limits = ScanLimits { max_files: 1, ..ScanLimits::REAL };
    write(&d.join("b.txt"), "b");
    let e = save_work(&d, &InitChoices { accept_incomplete: true, ..Default::default() }, &small).unwrap_err();
    assert_eq!(e, WORK_TOO_BIG);
    fs::remove_file(d.join("b.txt")).unwrap();
    w.set_identity(true);
    // Detached: there is no current branch to save on.
    let head = w.git(&d, &["rev-parse", "HEAD"]);
    w.git(&d, &["checkout", "-q", "--detach"]);
    assert_eq!(save_work(&d, &InitChoices::default(), &w.ctx(vec![])).unwrap_err(), NOTHING_TO_SAVE);
    assert_eq!(w.git(&d, &["rev-parse", "HEAD"]), head);
    assert_eq!(fs::read_to_string(d.join("a.txt")).unwrap(), "changed");
}

#[cfg(unix)]
#[test]
fn a_failed_save_puts_the_index_and_gitignore_back() {
    let w = World::new();
    let d = w.repo("home/code/lyra");
    write(&d.join(".gitignore"), "*.log\n");
    w.git(&d, &["add", ".gitignore"]);
    w.git(&d, &["commit", "-q", "-m", "ignore"]);
    w.failing_hooks();
    fs::write(d.join("a.txt"), "changed").unwrap();
    write(&d.join("b.txt"), "b");
    w.git(&d, &["add", "b.txt"]);
    let head = w.git(&d, &["rev-parse", "HEAD"]);
    let e = save_work(&d, &InitChoices::default(), &w.ctx(vec![])).unwrap_err();
    // Plain words first; the hook's own output after a blank line.
    let (words, output) = e.split_once("\n\n").unwrap();
    assert_eq!(words, SAVE_HOOK_REFUSED);
    assert!(output.contains("no"), "{output}");
    assert_eq!(w.git(&d, &["rev-parse", "HEAD"]), head);
    assert_eq!(fs::read_to_string(d.join(".gitignore")).unwrap(), "*.log\n");
    assert_eq!(w.git(&d, &["diff", "--cached", "--name-only"]), "b.txt");
}

#[test]
fn a_tracked_build_file_is_saved_and_new_build_folders_are_named() {
    let w = World::new();
    let d = w.repo("home/code/lyra");
    write(&d.join("build/keep.txt"), "old");
    w.git(&d, &["add", "-A"]);
    w.git(&d, &["commit", "-q", "-m", "build"]);
    fs::write(d.join("build/keep.txt"), "new").unwrap();
    write(&d.join("app/dist/x.js"), "x");
    write(&d.join("app/dist/y.js"), "y");
    let work = inspect_work(&d, &w.ctx(vec![])).unwrap();
    // Git has build/keep.txt: it is counted and saved, not gathered.
    assert_eq!(work.to_save.as_ref().unwrap().files, 1);
    assert_eq!(work.build_folders, vec![FoundFolder { path: "app/dist/".into(), files: 2 }]);
    // Unticked, a build folder is saved like the rest.
    save_work(&d, &InitChoices::default(), &w.ctx(vec![])).unwrap();
    assert_eq!(w.tracked(&d), vec!["a.txt", "app/dist/x.js", "app/dist/y.js", "build/keep.txt"]);
    assert_eq!(build_folder_of("a/node_modules/b/c.js").as_deref(), Some("a/node_modules/"));
    assert_eq!(build_folder_of("node_modules"), None);
}

#[test]
fn a_merge_in_progress_or_unresolved_files_are_never_saved() {
    let w = World::new();
    let d = w.repo("home/code/lyra");
    w.git(&d, &["checkout", "-q", "-b", "other"]);
    fs::write(d.join("a.txt"), "theirs").unwrap();
    w.git(&d, &["commit", "-qam", "theirs"]);
    w.git(&d, &["checkout", "-q", "main"]);
    fs::write(d.join("a.txt"), "ours").unwrap();
    w.git(&d, &["commit", "-qam", "ours"]);
    assert!(!w.git_ok(&d, &["merge", "-q", "other"]));
    let head = w.git(&d, &["rev-parse", "HEAD"]);
    let r = inspect(&d, &w.ctx(vec![])).unwrap();
    assert!(r.uncommitted_changes);
    assert_eq!(r.work_blocked.as_deref(), Some(WORK_IN_PROGRESS));
    assert_eq!(inspect_work(&d, &w.ctx(vec![])).unwrap_err(), WORK_IN_PROGRESS);
    assert_eq!(save_work(&d, &InitChoices::default(), &w.ctx(vec![])).unwrap_err(), WORK_IN_PROGRESS);
    assert_eq!(w.git(&d, &["rev-parse", "HEAD"]), head);
    assert!(w.git_ok(&d, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]));
    // A plain change is not blocked.
    let d2 = w.repo("home/code/lyra2");
    fs::write(d2.join("a.txt"), "changed").unwrap();
    assert_eq!(inspect(&d2, &w.ctx(vec![])).unwrap().work_blocked, None);
}

#[test]
fn a_project_inside_the_folder_is_named_and_never_saved() {
    let w = World::new();
    let d = w.repo("home/code/lyra");
    let inner = d.join("vendor/lib");
    fs::create_dir_all(&inner).unwrap();
    w.git(&inner, &["init", "-q", "-b", "main"]);
    write(&inner.join("x.txt"), "x");
    w.git(&inner, &["add", "-A"]);
    w.git(&inner, &["commit", "-q", "-m", "x"]);
    fs::write(d.join("a.txt"), "changed").unwrap();
    let work = inspect_work(&d, &w.ctx(vec![])).unwrap();
    assert_eq!(work.nested_projects, vec!["vendor/lib".to_string()]);
    save_work(&d, &InitChoices::default(), &w.ctx(vec![])).unwrap();
    // The commit holds a.txt only: no pointer to the project inside.
    assert_eq!(w.tracked(&d), vec!["a.txt"]);
    assert_eq!(w.git(&d, &["show", "--name-only", "--format=", "HEAD"]), "a.txt");
}

#[test]
fn gitlink_paths_are_read_from_the_raw_diff() {
    let raw = b":000000 160000 0000000 abcdef1 A\0vendor/lib\0:100644 100644 1111111 2222222 M\0a.txt\0";
    assert_eq!(gitlink_paths(raw), vec!["vendor/lib".to_string()]);
    assert!(gitlink_paths(b"").is_empty());
}

#[test]
fn a_shared_definition_is_reported() {
    let w = World::new();
    let d = w.repo("home/code/lyra");
    assert!(!inspect(&d, &w.ctx(vec![])).unwrap().shared_definition);
    write(&d.join(".atelier/workspace.json"), "{}");
    assert!(inspect(&d, &w.ctx(vec![])).unwrap().shared_definition);
}

#[test]
fn home_root_system_and_the_projects_folder_are_refused() {
    let w = World::new();
    let ctx = w.ctx(vec![]);
    let r = inspect(&w.home(), &ctx).unwrap();
    assert_eq!(r.outcome, InspectOutcome::Refused);
    assert_eq!(r.refused, Some(RefusedFolder::Home));
    assert_eq!(r.refused_words.as_deref(), Some(REFUSED_HOME));
    assert_eq!(
        inspect(&w.projects(), &ctx).unwrap().refused,
        Some(RefusedFolder::ProjectsFolder)
    );
    assert!(init(&w.home(), &InitChoices::default(), &ctx).is_err());
    assert!(!w.home().join(".git").exists());

    let home = Some("/Users/ann");
    let projects = Some("/Users/ann/Projects");
    let mac = |p: &str| refused_folder(p, home, projects, false);
    assert_eq!(mac("/"), Some(RefusedFolder::Root));
    assert_eq!(mac("/Users/ann"), Some(RefusedFolder::Home));
    assert_eq!(mac("/Users/ann/"), Some(RefusedFolder::Home));
    assert_eq!(
        mac("/Users/ann/Projects"),
        Some(RefusedFolder::ProjectsFolder)
    );
    for system in [
        "/Users",
        "/System",
        "/System/Library/Frameworks",
        "/usr/local/lib",
        "/Library/Application Support",
        "/Applications/Xcode.app",
        "/private/etc",
        "/etc",
        "/var",
        "/private/var",
        "/Volumes",
        "/opt",
    ] {
        assert_eq!(mac(system), Some(RefusedFolder::System), "{system}");
    }
    for fine in [
        "/Users/ann/Projects/lyra",
        "/Users/ann/code",
        "/Volumes/Work/lyra",
        "/private/var/folders/xy/T/tmp1",
        "/opt/src/lyra",
    ] {
        assert_eq!(mac(fine), None, "{fine}");
    }
    let win = |p: &str| {
        refused_folder(
            p,
            Some(r"C:\Users\Ann"),
            Some(r"C:\Users\Ann\Projects"),
            true,
        )
    };
    assert_eq!(win(r"C:\"), Some(RefusedFolder::Root));
    assert_eq!(win(r"D:\"), Some(RefusedFolder::Root));
    assert_eq!(win(r"c:\users\ann"), Some(RefusedFolder::Home));
    assert_eq!(
        win(r"C:\Users\Ann\Projects"),
        Some(RefusedFolder::ProjectsFolder)
    );
    assert_eq!(win(r"C:\Users"), Some(RefusedFolder::System));
    assert_eq!(win(r"C:\Windows\System32"), Some(RefusedFolder::System));
    assert_eq!(win(r"C:\Program Files\Git"), Some(RefusedFolder::System));
    assert_eq!(win(r"C:\ProgramData"), Some(RefusedFolder::System));
    assert_eq!(win(r"\\?\C:\Windows"), Some(RefusedFolder::System));
    assert_eq!(win(r"C:\Users\Ann\Projects\lyra"), None);
    assert_eq!(win(r"D:\code\lyra"), None);
}

#[test]
fn no_git_identity_blocks_the_first_commit_and_writes_nothing() {
    let w = World::new();
    w.set_identity(false);
    let d = w.dir("home/code/lyra");
    write(&d.join("a.txt"), "a");
    let r = inspect(&d, &w.ctx(vec![])).unwrap();
    assert_eq!(r.outcome, InspectOutcome::NotARepo);
    assert!(!r.identity_ready && r.needs_identity);
    assert_eq!(
        init(&d, &InitChoices::default(), &w.ctx(vec![])).unwrap_err(),
        IDENTITY_NEEDED
    );
    assert!(!d.join(".git").exists() && !d.join(".gitignore").exists());
    // A repository with commits needs no identity to be added.
    w.set_identity(true);
    let d2 = w.repo("home/code/lyra2");
    w.set_identity(false);
    let r = inspect(&d2, &w.ctx(vec![])).unwrap();
    assert_eq!(r.outcome, InspectOutcome::Ready);
    assert!(!r.needs_identity);
}

#[test]
fn a_github_origin_is_named_for_the_account_question() {
    let w = World::new();
    let d = w.repo("home/code/lyra");
    w.git(
        &d,
        &["remote", "add", "origin", "https://github.com/Octo-Cat/Lyra.git"],
    );
    assert_eq!(
        inspect(&d, &w.ctx(vec![])).unwrap().github_origin.as_deref(),
        Some("Octo-Cat/Lyra")
    );
    w.git(&d, &["remote", "set-url", "origin", "https://gitlab.com/o/r.git"]);
    assert_eq!(inspect(&d, &w.ctx(vec![])).unwrap().github_origin, None);
}

#[test]
fn f3_the_inspection_says_whether_there_is_an_origin_and_the_name_github_would_get() {
    let w = World::new();
    let d = w.repo("home/code/Lyra Notes");
    let r = inspect(&d, &w.ctx(vec![])).unwrap();
    assert!(!r.has_origin);
    assert_eq!(r.github_name.as_deref(), Some("lyra-notes"));
    // Any origin, GitHub's or another host's: no tick, no name.
    w.git(&d, &["remote", "add", "origin", "https://gitlab.com/o/r.git"]);
    let r = inspect(&d, &w.ctx(vec![])).unwrap();
    assert!(r.has_origin);
    assert_eq!(r.github_name, None);
}

#[test]
fn a_folder_that_is_gone_is_said_in_words() {
    let w = World::new();
    let e = inspect(&w.root.join("nope"), &w.ctx(vec![])).unwrap_err();
    assert_eq!(e, "That folder isn't there any more.");
}

// ── Scans and .gitignore (pure) ────────────────────────────────────────

#[test]
fn secrets_are_named_by_the_specs_patterns() {
    for yes in [
        ".env",
        ".env.local",
        "a/b/.env.production",
        "server.pem",
        "private.KEY",
        "id_rsa",
        "keys/id_rsa_work",
        "id_ed25519",
    ] {
        assert!(is_likely_secret(yes), "{yes}");
    }
    for no in [
        ".env.example",
        ".env.sample",
        "id_rsa.pub",
        "environment.ts",
        "keyboard.rs",
        "pem.txt",
        "a/.envrc.md",
    ] {
        assert!(!is_likely_secret(no), "{no}");
    }
}

#[cfg(unix)]
#[test]
fn the_walk_skips_ignored_folders_and_never_follows_links() {
    let w = World::new();
    let d = w.dir("home/code/walk");
    write(&d.join("a/b/c.txt"), "c");
    write(&d.join("node_modules/pkg/i.js"), "x");
    write(&d.join("target/debug/bin"), "x");
    write(&d.join(".git/config"), "x");
    let outside = w.dir("outside");
    write(&outside.join("secret.pem"), "x");
    std::os::unix::fs::symlink(&outside, d.join("link")).unwrap();
    let scan = walk(&d, &ScanLimits::REAL);
    assert!(scan.complete);
    // c.txt and the link itself, nothing behind it.
    assert_eq!(scan.files, 2);
    assert!(scan.secrets.is_empty());
}

#[test]
fn ignore_lines_match_exactly_one_file_and_escape_what_gitignore_reads() {
    assert_eq!(ignore_line_for("video.mov").unwrap(), "/video.mov");
    assert_eq!(ignore_line_for("a/b c.bin").unwrap(), "/a/b c.bin");
    assert_eq!(
        ignore_line_for("#x!y*z?[1]\\").unwrap(),
        "/\\#x\\!y\\*z\\?\\[1]\\\\"
    );
    assert_eq!(ignore_line_for("trail  ").unwrap(), "/trail\\ \\ ");
    assert_eq!(ignore_line_for("a\nb"), None);
    assert_eq!(ignore_line_for(""), None);

    let (text, added) = plan_ignore("", &["node_modules/"], &["big.bin".into()], &[]);
    assert_eq!(text, "# Added by Plyloft\nnode_modules/\n/big.bin\n");
    assert_eq!(added, vec!["node_modules/", "/big.bin"]);
    // Nothing missing: the file is unchanged.
    let (text, added) = plan_ignore("node_modules/\n", &["node_modules/"], &[], &[]);
    assert_eq!(text, "node_modules/\n");
    assert!(added.is_empty());
    // No trailing newline in the user's file.
    let (text, _) = plan_ignore("*.log", &[".env"], &[], &[".env".into()]);
    assert_eq!(text, "*.log\n\n# Added by Plyloft\n.env\n!/.env\n");
}

#[test]
fn branches_are_suggested_main_then_master_then_the_most_recent() {
    let v = |x: &[&str]| x.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(
        suggest_branch(&v(&["dev", "master", "main"])).as_deref(),
        Some("main")
    );
    assert_eq!(
        suggest_branch(&v(&["dev", "master"])).as_deref(),
        Some("master")
    );
    assert_eq!(suggest_branch(&v(&["dev", "old"])).as_deref(), Some("dev"));
    assert_eq!(suggest_branch(&[]), None);
}

#[test]
fn paths_are_shown_under_the_home_folder_with_a_tilde() {
    let home = Path::new("/Users/ann");
    assert_eq!(
        display_path(Path::new("/Users/ann/Projects/lyra"), Some(home)),
        "~/Projects/lyra"
    );
    assert_eq!(display_path(home, Some(home)), "~");
    assert_eq!(display_path(Path::new("/opt/x"), Some(home)), "/opt/x");
}

// ── 8c: a new project ──────────────────────────────────────────────────

#[test]
fn names_become_slugs_and_symbol_or_reserved_names_are_refused() {
    assert_eq!(slugify("My app").unwrap(), "my-app");
    assert_eq!(slugify("  Café   Menu!! ").unwrap(), "cafe-menu");
    assert_eq!(slugify("Straße 2.0").unwrap(), "strasse-2-0");
    assert_eq!(slugify("--Hello__World--").unwrap(), "hello-world");
    assert_eq!(slugify("con app").unwrap(), "con-app");
    for bad in [
        "", "   ", "!!!", "—", "con", "CON", "Nul", "aux", "prn", "com1", "LPT9", " con ",
    ] {
        assert_eq!(slugify(bad).unwrap_err(), NAME_NEEDS_LETTERS, "{bad:?}");
    }
    let long = slugify(&"ab ".repeat(80)).unwrap();
    assert!(long.len() <= SLUG_MAX && !long.ends_with('-'));
    assert!(clean_project_name("a\nb").is_err());
    assert!(clean_project_name(&"x".repeat(101)).is_err());
    assert_eq!(clean_project_name("  My app ").unwrap(), "My app");
}

fn new_request(name: &str) -> NewProjectRequest {
    NewProjectRequest {
        name: name.into(),
        parent: None,
        github_copy: None,
    }
}

#[test]
fn a_new_project_gets_a_folder_readme_os_gitignore_and_first_commit() {
    let w = World::new();
    let tools = w.tools(None);
    let home = w.home();
    let preview = new_preview("My app", &w.projects(), &tools, Some(&home));
    assert_eq!(preview.slug.as_deref(), Some("my-app"));
    assert_eq!(preview.display_path.as_deref(), Some("~/Projects/my-app"));
    assert_eq!(preview.folder, Some(FolderState::Missing));
    assert!(preview.problem.is_none());

    let out = create_new(
        &new_request("My app"),
        &w.projects(),
        &tools,
        Some(&home),
        None,
    )
    .unwrap();
    let NewProjectOutcome::Created {
        path,
        slug,
        branch,
        github,
        ..
    } = out
    else {
        panic!("{out:?}");
    };
    assert_eq!(slug, "my-app");
    assert_eq!(branch, "main");
    assert!(github.is_none());
    let d = PathBuf::from(path);
    assert_eq!(d, w.projects().join("my-app"));
    assert_eq!(fs::read_to_string(d.join("README.md")).unwrap(), "# My app\n");
    let ignore = fs::read_to_string(d.join(".gitignore")).unwrap();
    assert_eq!(ignore, ".DS_Store\nThumbs.db\nDesktop.ini\n");
    assert_eq!(w.git(&d, &["log", "-1", "--format=%s"]), "Start My app");
    assert_eq!(w.tracked(&d), vec![".gitignore", "README.md"]);
}

#[test]
fn a_new_projects_folder_that_exists_is_used_when_empty_and_refused_with_files() {
    let w = World::new();
    let tools = w.tools(None);
    // Empty: used without asking.
    fs::create_dir_all(w.projects().join("empty-one")).unwrap();
    assert_eq!(
        new_preview("Empty one", &w.projects(), &tools, None).folder,
        Some(FolderState::Empty)
    );
    let out = create_new(&new_request("Empty one"), &w.projects(), &tools, None, None).unwrap();
    assert!(matches!(out, NewProjectOutcome::Created { .. }), "{out:?}");
    // With files: "Add that folder instead"; nothing written.
    write(&w.projects().join("lyra/notes.txt"), "mine");
    let out = create_new(&new_request("Lyra"), &w.projects(), &tools, None, None).unwrap();
    match out {
        NewProjectOutcome::FolderHasFiles { path, slug, words } => {
            assert_eq!(slug, "lyra");
            assert_eq!(PathBuf::from(path), w.projects().join("lyra"));
            assert_eq!(
                words,
                "There's already a folder called “lyra” with files in it."
            );
        }
        other => panic!("{other:?}"),
    }
    assert!(!w.projects().join("lyra/.git").exists());
    assert!(!w.projects().join("lyra/README.md").exists());
    // A file with that name: refused.
    write(&w.projects().join("notes"), "x");
    assert!(matches!(
        create_new(&new_request("Notes"), &w.projects(), &tools, None, None).unwrap(),
        NewProjectOutcome::Refused { .. }
    ));
    // Symbols or a reserved name: refused, nothing made.
    for bad in ["!!!", "con", "NUL"] {
        match create_new(&new_request(bad), &w.projects(), &tools, None, None).unwrap() {
            NewProjectOutcome::Refused { words } => assert_eq!(words, NAME_NEEDS_LETTERS),
            other => panic!("{bad}: {other:?}"),
        }
    }
    assert!(!w.projects().join("con").exists());
}

#[test]
fn a_new_project_is_never_made_inside_another_repo_or_without_an_identity() {
    let w = World::new();
    let tools = w.tools(None);
    let mono = w.repo("home/code/mono");
    let out = create_new(&new_request("Inner"), &mono, &tools, None, None).unwrap();
    assert!(matches!(out, NewProjectOutcome::Refused { .. }), "{out:?}");
    assert!(!mono.join("inner").exists());
    assert_eq!(
        new_preview("Inner", &mono, &tools, None)
            .inside_repo
            .as_deref(),
        Some("mono")
    );
    w.set_identity(false);
    let out = create_new(&new_request("Fresh"), &w.projects(), &tools, None, None).unwrap();
    assert!(
        matches!(out, NewProjectOutcome::IdentityNeeded { .. }),
        "{out:?}"
    );
    assert!(!w.projects().join("fresh").exists());
}

#[cfg(unix)]
#[test]
fn a_failed_new_project_removes_only_what_ply_made() {
    let w = World::new();
    w.failing_hooks();
    let tools = w.tools(None);
    assert!(create_new(&new_request("Doomed"), &w.projects(), &tools, None, None).is_err());
    assert!(!w.projects().join("doomed").exists());
    // A folder that was there (empty) stays, empty.
    fs::create_dir_all(w.projects().join("kept")).unwrap();
    assert!(create_new(&new_request("Kept"), &w.projects(), &tools, None, None).is_err());
    assert!(w.projects().join("kept").is_dir());
    assert_eq!(fs::read_dir(w.projects().join("kept")).unwrap().count(), 0);
}

// ── A stub gh (no network) ─────────────────────────────────────────────

const STUB_TOKEN: &str = "gho_STUBTOKEN0123456789";

/// A `gh` shell script: `auth status` lists `main-acct` (active) and
/// `work-acct`; `auth token --user work-acct` prints [`STUB_TOKEN`]; every
/// call is logged with its GH_TOKEN and working folder. `extra` adds `case`
/// arms (matched on "$1 $2").
#[cfg(unix)]
fn stub_gh(dir: &Path, extra: &str) -> String {
    let log = dir.join("gh.log");
    let script = format!(
        r#"#!/bin/sh
printf '%s|token=%s|pwd=%s\n' "$*" "${{GH_TOKEN:-}}" "$(pwd)" >> "{log}"
case "$1 $2" in
{extra}
"auth status")
  echo '{{"hosts":{{"github.com":[{{"state":"success","active":true,"host":"github.com","login":"main-acct","scopes":"repo, read:org"}},{{"state":"success","active":false,"host":"github.com","login":"work-acct","scopes":"repo"}},{{"state":"error","active":false,"host":"github.com","login":"broken-acct"}}]}}}}'
  ;;
"auth token")
  if [ "$4" = "work-acct" ]; then echo "{token}"; else echo "no oauth token found for github.com account $4" >&2; exit 1; fi
  ;;
*)
  echo "unexpected: $*" >&2; exit 2
  ;;
esac
"#,
        log = log.display(),
        token = STUB_TOKEN,
    );
    let gh = dir.join("gh");
    fs::write(&gh, script).unwrap();
    crate::platform::set_mode(&gh, 0o755).unwrap();
    gh.to_string_lossy().into_owned()
}

#[cfg(unix)]
fn gh_log(dir: &Path) -> Vec<String> {
    fs::read_to_string(dir.join("gh.log"))
        .unwrap_or_default()
        .lines()
        .map(String::from)
        .collect()
}

#[cfg(unix)]
#[test]
fn a_token_is_fetched_only_for_a_signed_in_account_that_isnt_active() {
    let w = World::new();
    let bin = w.dir("bin");
    let tools = w.tools(Some(stub_gh(&bin, "")));
    assert_eq!(token_for(&tools, None).unwrap(), None);
    assert_eq!(token_for(&tools, Some("  ")).unwrap(), None);
    // The active account: gh's own, nothing fetched.
    assert_eq!(token_for(&tools, Some("main-acct")).unwrap(), None);
    assert!(!gh_log(&bin).iter().any(|l| l.starts_with("auth token")));
    // Another signed-in account: its token, by --user.
    let token = token_for(&tools, Some("work-acct")).unwrap().unwrap();
    assert_eq!(token.expose(), STUB_TOKEN);
    assert!(gh_log(&bin)
        .iter()
        .any(|l| l.starts_with("auth token --user work-acct|token=|")));
    // Its Debug never shows it.
    assert!(!format!("{token:?}").contains(STUB_TOKEN));
    // Not signed in, unknown, or not a login: refused in words.
    for bad in ["broken-acct", "nobody", "bad login", "-x"] {
        let e = token_for(&tools, Some(bad)).unwrap_err();
        assert!(!e.contains(STUB_TOKEN), "{e}");
    }
    assert_eq!(active_login(&tools).unwrap(), "main-acct");
    // An inherited GH_TOKEN never reaches gh unless Ply put it there.
    let cmd = tools.gh(None).unwrap();
    assert!(cmd.get_envs().any(|(k, v)| k == "GH_TOKEN" && v.is_none()));
}

#[cfg(unix)]
#[test]
fn the_private_github_copy_is_made_with_the_chosen_account_and_a_taken_name_keeps_the_local_project()
{
    let w = World::new();
    let bin = w.dir("bin");
    let arms = r#""repo create")
  case "$3" in
    */taken) echo "GraphQL: Name already exists on this account (createRepository)" >&2; exit 1 ;;
    */broken) echo "HTTP 500: server says $GH_TOKEN" >&2; exit 1 ;;
    *) echo "https://github.com/$3"; exit 0 ;;
  esac
  ;;"#;
    let tools = w.tools(Some(stub_gh(&bin, arms)));
    let token = GhToken::new(STUB_TOKEN.into());
    let request = |name: &str| NewProjectRequest {
        name: name.into(),
        parent: None,
        github_copy: Some(GithubCopyRequest {
            login: "work-acct".into(),
        }),
    };
    let out = create_new(&request("My app"), &w.projects(), &tools, None, token.as_ref()).unwrap();
    let NewProjectOutcome::Created { github, path, .. } = out else {
        panic!()
    };
    let github = github.unwrap();
    assert_eq!(github.state, GithubCopyState::Created);
    assert_eq!(github.repo, "work-acct/my-app");
    let line = gh_log(&bin)
        .into_iter()
        .find(|l| l.starts_with("repo create"))
        .unwrap();
    assert_eq!(
        line,
        format!(
            "repo create work-acct/my-app --private --source . --push|token={STUB_TOKEN}|pwd={path}"
        )
    );

    let out = create_new(&request("Taken"), &w.projects(), &tools, None, token.as_ref()).unwrap();
    let NewProjectOutcome::Created { github, path, .. } = out else {
        panic!()
    };
    let github = github.unwrap();
    assert_eq!(github.state, GithubCopyState::NameTaken);
    assert!(github
        .words
        .unwrap()
        .starts_with("You already have a repository called taken on GitHub."));
    // Created locally anyway.
    assert_eq!(
        w.git(Path::new(&path), &["log", "-1", "--format=%s"]),
        "Start Taken"
    );

    // A failure that echoes the token: never in the words.
    let out = create_new(&request("Broken"), &w.projects(), &tools, None, token.as_ref()).unwrap();
    let NewProjectOutcome::Created { github, .. } = out else {
        panic!()
    };
    let github = github.unwrap();
    assert_eq!(github.state, GithubCopyState::Failed);
    let words = github.words.unwrap();
    assert!(
        words.contains("HTTP 500") && !words.contains(STUB_TOKEN),
        "{words}"
    );
    // An invalid login is refused before anything is made.
    let mut bad = request("Other");
    bad.github_copy = Some(GithubCopyRequest {
        login: "not a login".into(),
    });
    assert!(matches!(
        create_new(&bad, &w.projects(), &tools, None, None).unwrap(),
        NewProjectOutcome::Refused { .. }
    ));
    assert!(!w.projects().join("other").exists());
}

// ── 8b: the list ───────────────────────────────────────────────────────

/// MEASUREMENTS §11's shape.
const REPO_LIST_JSON: &str = r#"[{"defaultBranchRef":{"name":"main"},"description":"The app","diskUsage":12580,"isEmpty":false,"isPrivate":true,"nameWithOwner":"main-acct/atelier","updatedAt":"2026-09-20T10:00:00Z"},
 {"defaultBranchRef":null,"description":"","diskUsage":0,"isEmpty":true,"isPrivate":false,"nameWithOwner":"main-acct/empty","updatedAt":"2026-09-25T10:00:00Z"},
 {"nameWithOwner":"bad/../slug"}]"#;

#[test]
fn gh_repo_list_and_user_repos_are_read_into_one_shape() {
    let list = parse_repo_list(REPO_LIST_JSON, RepoGroupKind::Yours, "main-acct").unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].name_with_owner, "main-acct/atelier");
    assert_eq!(list[0].disk_usage_kb, Some(12580));
    assert_eq!(list[0].default_branch.as_deref(), Some("main"));
    assert_eq!(list[0].is_empty, Some(false));
    assert_eq!(list[1].is_empty, Some(true));
    assert_eq!(list[1].description, None);
    assert!(parse_repo_list("not json", RepoGroupKind::Yours, "x").is_err());

    let rest = r#"[{"full_name":"Boss/lyra","private":true,"size":0,"updated_at":"2026-09-21T00:00:00Z","default_branch":"main","owner":{"type":"User"}},
      {"full_name":"acme/api","private":true,"size":10,"owner":{"type":"Organization"}},
      {"full_name":"main-acct/atelier","private":true,"owner":{"type":"User"}}]"#;
    let shared = parse_user_repos(rest, "main-acct").unwrap();
    assert_eq!(shared[0].group, RepoGroupKind::Shared);
    assert_eq!(shared[0].group_owner, "Boss");
    // REST doesn't say whether it is empty, and size 0 never means empty.
    assert_eq!(shared[0].is_empty, None);
    assert_eq!(shared[1].group, RepoGroupKind::Org);
    assert_eq!(shared[2].group, RepoGroupKind::Yours);
}

#[test]
fn the_sources_merge_once_each_with_the_team_first_and_workspaces_marked() {
    let yours = parse_repo_list(REPO_LIST_JSON, RepoGroupKind::Yours, "main-acct").unwrap();
    let shared = parse_user_repos(
        r#"[{"full_name":"MAIN-ACCT/atelier","owner":{"type":"User"}},{"full_name":"boss/lyra","owner":{"type":"User"}}]"#,
        "main-acct",
    )
    .unwrap();
    let team = vec![
        "boss/lyra".to_string(),
        "acme/not-listed".to_string(),
        "bad".to_string(),
    ];
    let origins = vec![(
        ws("w1", Path::new("/tmp/atelier")),
        "main-acct/Atelier".to_string(),
    )];
    let (list, truncated) = merge_repos(vec![yours, shared], &team, &origins, 100);
    assert!(!truncated);
    let names: Vec<(&str, RepoGroupKind)> = list
        .iter()
        .map(|r| (r.name_with_owner.as_str(), r.group))
        .collect();
    assert_eq!(
        names,
        vec![
            ("acme/not-listed", RepoGroupKind::Team),
            ("boss/lyra", RepoGroupKind::Team),
            ("main-acct/empty", RepoGroupKind::Yours),
            ("main-acct/atelier", RepoGroupKind::Yours),
        ]
    );
    assert_eq!(list[3].in_ply.as_ref().unwrap().id, "w1");
    let (capped, truncated) = merge_repos(
        vec![parse_repo_list(REPO_LIST_JSON, RepoGroupKind::Yours, "main-acct").unwrap()],
        &[],
        &[],
        1,
    );
    assert!(truncated && capped.len() == 1);
}

#[cfg(unix)]
#[test]
fn the_list_asks_gh_for_yours_each_organisation_and_shared_repositories() {
    let w = World::new();
    let bin = w.dir("bin");
    let arms = format!(
        r#""repo list")
  case "$3" in
    main-acct) echo '{yours}' ;;
    acme) echo '[{{"nameWithOwner":"acme/api","isPrivate":true,"isEmpty":false,"diskUsage":5}}]' ;;
    *) echo "HTTP 403: nope $GH_TOKEN" >&2; exit 1 ;;
  esac
  ;;
"org list")
  printf 'acme\nlocked\n'
  ;;
"api user/repos?affiliation=collaborator,organization_member&per_page=100&page=1")
  echo '[{{"full_name":"boss/lyra","private":true,"owner":{{"type":"User"}}}}]'
  ;;"#,
        yours = REPO_LIST_JSON.replace('\n', " ")
    );
    let tools = w.tools(Some(stub_gh(&bin, &arms)));
    let token = GhToken::new(STUB_TOKEN.into());
    let list = repo_list(&tools, "main-acct", token.as_ref(), &[], &[]);
    let names: Vec<&str> = list
        .repos
        .iter()
        .map(|r| r.name_with_owner.as_str())
        .collect();
    assert_eq!(
        names,
        vec!["main-acct/empty", "main-acct/atelier", "acme/api", "boss/lyra"],
        "{:?}",
        list.errors
    );
    assert_eq!(list.repos[2].group, RepoGroupKind::Org);
    assert_eq!(list.repos[3].group, RepoGroupKind::Shared);
    // The organisation it couldn't read is said, without the token.
    assert_eq!(list.errors.len(), 1, "{:?}", list.errors);
    assert_eq!(list.errors[0].source, "org:locked");
    assert!(!list.errors[0].words.contains(STUB_TOKEN));
    // Every call carried the chosen account's token.
    let log = gh_log(&bin);
    assert_eq!(log.len(), 5, "{log:?}");
    assert!(log.iter().all(|l| l.contains(&format!("token={STUB_TOKEN}"))));
    assert!(log[0].starts_with(&format!(
        "repo list main-acct --json {REPO_FIELDS} --limit 200"
    )));
}

// ── 8b: getting one ────────────────────────────────────────────────────

#[test]
fn clone_failures_are_read_from_the_last_lines() {
    let t = |s: &str| classify_clone_failure(&[s.to_string()]);
    assert_eq!(t("remote: Repository not found."), CloneFailureKind::Auth);
    assert_eq!(
        t("fatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 403"),
        CloneFailureKind::Auth
    );
    assert_eq!(t("HTTP 401: Bad credentials"), CloneFailureKind::Auth);
    assert_eq!(
        t("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
        CloneFailureKind::Auth
    );
    assert_eq!(
        t("remote: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization."),
        CloneFailureKind::Sso
    );
    assert_eq!(
        t("fatal: unable to access 'https://github.com/o/r/': Could not resolve host: github.com"),
        CloneFailureKind::Offline
    );
    assert_eq!(
        t("error: RPC failed; curl 56 Recv failure: Connection reset by peer"),
        CloneFailureKind::Offline
    );
    assert_eq!(t("fatal: early EOF"), CloneFailureKind::Offline);
    assert_eq!(t("something else"), CloneFailureKind::Other);

    let auth = clone_failure(CloneFailureKind::Auth, "acme/lyra");
    assert_eq!(auth.words, "GitHub didn't let this account download lyra.");
    let sso = clone_failure(CloneFailureKind::Sso, "acme/lyra");
    assert_eq!(
        sso.words,
        "Your organization “acme” needs you to authorize the GitHub CLI for single sign-on."
    );
    assert_eq!(sso.sso_org.as_deref(), Some("acme"));
    assert_eq!(
        clone_failure(CloneFailureKind::Offline, "a/b").words,
        "The download stopped. Nothing was added to Plyloft."
    );
}

#[test]
fn a_clone_that_exits_with_an_error_fails_even_with_a_git_folder() {
    use crate::setup_run::{decide, Decision, Observed, Outcome, Timing, WatchState};
    let state = |exit: Option<i32>, observed: Observed| WatchState {
        elapsed: Duration::from_secs(1),
        exit: Some(exit),
        cancelled: false,
        observed: Some(observed),
        already_there: false,
        warned_long: false,
        installer_gone: false,
        version: crate::setup_outcome::VersionChange::NotCompared,
        idle: Duration::ZERO,
        update_claimed: false,
        newer_known: false,
    };
    let watch = crate::setup_actions::Watch::Cloned;
    let t = Timing::REAL;
    assert_eq!(
        decide(watch, &state(Some(0), Observed::Yes), &t),
        Decision::Done(Outcome::Succeeded)
    );
    assert_eq!(
        decide(watch, &state(Some(128), Observed::Yes), &t),
        Decision::Done(Outcome::Failed)
    );
    assert_eq!(
        decide(watch, &state(None, Observed::Yes), &t),
        Decision::Done(Outcome::Failed)
    );
    assert_eq!(
        decide(watch, &state(Some(0), Observed::No), &t),
        Decision::Done(Outcome::NotObserved)
    );
}

#[test]
fn a_clone_is_refused_when_the_destination_exists_or_the_repo_is_already_in_ply() {
    let w = World::new();
    let home = w.home();
    let clear = clone_preflight("acme/lyra", &w.projects(), &[], Some(&home)).unwrap();
    assert_eq!(
        clear,
        ClonePreflight::Clear {
            path: w.projects().join("lyra").to_string_lossy().into_owned(),
            display_path: "~/Projects/lyra".into()
        }
    );
    fs::create_dir_all(w.projects().join("lyra")).unwrap();
    match clone_preflight("acme/lyra", &w.projects(), &[], Some(&home)).unwrap() {
        ClonePreflight::DestinationExists { words, name, .. } => {
            assert_eq!(name, "lyra");
            assert_eq!(
                words,
                "There's already a folder called “lyra” in Projects."
            );
        }
        other => panic!("{other:?}"),
    }
    let elsewhere = w.repo("home/work/lyra");
    let origins = vec![(ws("w9", &elsewhere), "ACME/Lyra".to_string())];
    match clone_preflight("acme/lyra", &w.projects(), &origins, Some(&home)).unwrap() {
        ClonePreflight::AlreadyInPly { workspace, words } => {
            assert_eq!(workspace.id, "w9");
            assert_eq!(words, "lyra is already in Plyloft, at ~/work/lyra.");
        }
        other => panic!("{other:?}"),
    }
    for bad in ["lyra", "a/b/c", "../x", "a/..", "o/r;rm -rf ~", ""] {
        assert!(
            clone_preflight(bad, &w.projects(), &[], None).is_err(),
            "{bad}"
        );
    }
}

#[test]
fn workspace_origins_find_the_repos_already_in_ply() {
    let w = World::new();
    let a = w.repo("home/work/a");
    w.git(&a, &["remote", "add", "origin", "git@github.com:acme/a.git"]);
    let b = w.repo("home/work/b");
    let gone = w.root.join("gone");
    let origins = workspace_origins(
        &w.tools(None),
        &[ws("a", &a), ws("b", &b), ws("g", &gone)],
    );
    assert_eq!(origins.len(), 1);
    assert_eq!(origins[0].1, "acme/a");
}

/// A bare "GitHub" repository: empty, or with commits on `branch`.
fn bare(w: &World, name: &str, commits_on: Option<&str>) -> PathBuf {
    let b = w.dir(&format!("remote/{name}.git"));
    w.git(&b, &["init", "-q", "--bare", "-b", "main"]);
    if let Some(branch) = commits_on {
        let seed = w.repo(&format!("seed/{name}"));
        w.git(
            &seed,
            &["push", "-q", &b.to_string_lossy(), &format!("main:{branch}")],
        );
    }
    b
}

#[test]
fn a_finished_clone_is_read_empty_or_not_and_a_failed_one_leaves_no_folder() {
    let w = World::new();
    let tools = w.tools(None);
    let clone = |remote: &Path, to: &str| {
        let dest = w.projects().join(to);
        fs::create_dir(&dest).unwrap();
        w.git(
            &w.projects(),
            &["clone", "-q", &remote.to_string_lossy(), to],
        );
        CloneRun {
            dest,
            repo: format!("acme/{to}"),
        }
    };
    // With commits.
    let run = clone(&bare(&w, "full", Some("main")), "full");
    let r = finish_clone(&run, true, false, &[], &tools);
    assert!(r.cloned && !r.empty && r.failure.is_none() && !r.removed_partial);
    assert_eq!(r.branch.as_deref(), Some("main"));
    // Empty repository: the first-commit offer.
    let run = clone(&bare(&w, "empty", None), "empty");
    let r = finish_clone(&run, true, false, &[], &tools);
    assert!(r.cloned && r.empty);
    assert!(r.remote_branches.is_empty());
    // The default branch has no commits but another does: which branch?
    let run = clone(&bare(&w, "odd", Some("dev")), "odd");
    let r = finish_clone(&run, true, false, &[], &tools);
    assert!(r.empty);
    assert_eq!(r.remote_branches, vec!["dev".to_string()]);
    // Failed: the folder Ply created is removed, and the reason is read.
    let dest = w.projects().join("partial");
    write(&dest.join(".git/objects/pack/tmp"), "half");
    let run = CloneRun {
        dest: dest.clone(),
        repo: "acme/partial".into(),
    };
    let r = finish_clone(&run, false, false, &["fatal: early EOF".into()], &tools);
    assert!(!r.cloned && r.removed_partial && !dest.exists());
    assert_eq!(r.failure.unwrap().kind, CloneFailureKind::Offline);
    fs::create_dir(&dest).unwrap();
    let r = finish_clone(&run, false, true, &[], &tools);
    assert_eq!(r.failure.unwrap().kind, CloneFailureKind::Cancelled);
    assert!(!dest.exists());
}

// ── 8b: an empty repository's first commit and push ────────────────────

#[test]
fn an_empty_clone_gets_a_readme_first_commit_and_push_to_main() {
    let w = World::new();
    let tools = w.tools(None);
    let remote = bare(&w, "lyra", None);
    w.git(
        &w.projects(),
        &["clone", "-q", &remote.to_string_lossy(), "lyra"],
    );
    let d = w.projects().join("lyra");
    let done = first_commit_push(&d, &tools, None).unwrap();
    assert!(done.pushed, "{:?}", done.words);
    assert_eq!(done.branch, "main");
    assert_eq!(fs::read_to_string(d.join("README.md")).unwrap(), "# lyra\n");
    assert_eq!(w.git(&d, &["log", "-1", "--format=%s"]), "chore: first commit");
    // GitHub (the bare remote) has the same start.
    assert_eq!(w.git(&remote, &["rev-parse", "main"]), done.commit);
    assert_eq!(
        w.git(&d, &["rev-parse", "--abbrev-ref", "main@{upstream}"]),
        "origin/main"
    );
    // Once is enough: a second press is refused.
    assert!(first_commit_push(&d, &tools, None)
        .unwrap_err()
        .contains("already has a first commit"));
}

#[test]
fn the_first_push_never_goes_over_commits_github_already_has() {
    let w = World::new();
    let tools = w.tools(None);
    let remote = bare(&w, "odd", Some("dev"));
    w.git(
        &w.projects(),
        &["clone", "-q", &remote.to_string_lossy(), "odd"],
    );
    let d = w.projects().join("odd");
    let e = first_commit_push(&d, &tools, None).unwrap_err();
    assert!(e.contains("already has commits"), "{e}");
    assert!(!d.join("README.md").exists());
    // No identity: refused before anything is written.
    let remote = bare(&w, "blank", None);
    w.git(
        &w.projects(),
        &["clone", "-q", &remote.to_string_lossy(), "blank"],
    );
    w.set_identity(false);
    let d = w.projects().join("blank");
    assert_eq!(
        first_commit_push(&d, &tools, None).unwrap_err(),
        IDENTITY_NEEDED
    );
    assert!(!d.join("README.md").exists());
    // No origin: refused.
    w.set_identity(true);
    let lone = w.dir("home/code/lone");
    w.git(&lone, &["init", "-q", "-b", "main"]);
    assert!(first_commit_push(&lone, &tools, None).is_err());
}

#[test]
fn git_network_calls_ask_gh_for_github_and_never_carry_a_token() {
    let args = gh_helper_args("/opt/homebrew/bin/gh");
    assert_eq!(
        args,
        vec![
            "-c",
            "credential.https://github.com.helper=",
            "-c",
            "credential.https://github.com.helper=!\"/opt/homebrew/bin/gh\" auth git-credential",
        ]
    );
    assert!(gh_helper_args(r"C:\Program Files\GitHub CLI\gh.exe")[3]
        .contains("C:/Program Files/GitHub CLI/gh.exe"));
    let w = World::new();
    let tools = w.tools(Some("/stub/gh".into()));
    let argv_of = |cmd: &Command| -> Vec<String> {
        cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect()
    };
    let no_token_env = |cmd: &Command| {
        for key in ["GH_TOKEN", "GITHUB_TOKEN"] {
            assert!(
                cmd.get_envs().any(|(k, v)| k == key && v.is_none()),
                "{key} is removed, never set"
            );
        }
    };
    // A chosen account that isn't the active one: gh asks for that login's
    // token itself when git wants it (OB-7b) — only the login is in the argv.
    let chosen = network_git(&tools, Path::new("/x"), true, Some("work-acct"));
    assert_eq!(
        argv_of(&chosen)[..4],
        crate::github_account::login_helper_args("/stub/gh", "work-acct")[..]
    );
    assert!(argv_of(&chosen)[3].contains("auth token --user 'work-acct'"));
    no_token_env(&chosen);
    // gh's active account.
    let active = network_git(&tools, Path::new("/x"), true, None);
    assert_eq!(argv_of(&active)[..4], gh_helper_args("/stub/gh")[..]);
    no_token_env(&active);
    let plain = network_git(&tools, Path::new("/x"), false, Some("work-acct"));
    assert!(!argv_of(&plain).iter().any(|a| a.contains("credential")));
    no_token_env(&plain);
}

/// OB-7b: a hook git runs during the first push (pre-push) sees no GitHub
/// token — not even one the process inherited.
#[cfg(unix)]
#[test]
fn the_first_pushs_hooks_see_no_github_token() {
    let w = World::new();
    let base = w.tools(None);
    let git = base.git.clone();
    // An inherited token on every git this test's Plyloft runs.
    let tools = Tools {
        git: Arc::new(move || {
            let mut c = git();
            c.env("GH_TOKEN", STUB_TOKEN).env("GITHUB_TOKEN", STUB_TOKEN);
            c
        }),
        gh: None,
        path: base.path.clone(),
    };
    let remote = bare(&w, "lyra", None);
    w.git(&w.projects(), &["clone", "-q", &remote.to_string_lossy(), "lyra"]);
    let d = w.projects().join("lyra");
    let hooks = w.dir("push-hooks");
    let seen = w.root.join("hook-env");
    let hook = hooks.join("pre-push");
    fs::write(&hook, format!("#!/bin/sh\nenv > \"{}\"\n", seen.display())).unwrap();
    crate::platform::set_mode(&hook, 0o755).unwrap();
    w.git(&d, &["config", "core.hooksPath", &crate::platform::slash_path(&hooks)]);
    let done = first_commit_push(&d, &tools, Some("work-acct")).unwrap();
    assert!(done.pushed, "{:?}", done.words);
    let env = fs::read_to_string(&seen).expect("the pre-push hook ran");
    assert!(!env.contains(STUB_TOKEN), "the hook saw a token");
    assert!(env
        .lines()
        .all(|l| !l.starts_with("GH_TOKEN=") && !l.starts_with("GITHUB_TOKEN=")));
}

#[test]
fn the_token_never_shows_in_debug_redacted_text_or_the_clone_plan() {
    let token = GhToken::new(format!("  {STUB_TOKEN}\n")).unwrap();
    assert_eq!(token.expose(), STUB_TOKEN);
    assert!(GhToken::new("   ".into()).is_none());
    assert!(GhToken::new("two words".into()).is_none());
    assert_eq!(format!("{token:?}"), "GhToken(<redacted>)");
    assert_eq!(
        redact(&format!("error: {STUB_TOKEN} bad"), Some(&token)),
        "error: ••• bad"
    );
    let plan = clone_plan(
        "/bin/gh",
        "acme/lyra",
        Path::new("/p/lyra"),
        Some(token),
        None,
    );
    let shown = format!("{plan:?}");
    assert!(!shown.contains(STUB_TOKEN), "{shown}");
    assert!(!plan.argv.iter().any(|a| a.contains(STUB_TOKEN)));
    assert!(!plan.display.contains(STUB_TOKEN));
    assert!(!plan.env.iter().any(|(_, v)| v.contains(STUB_TOKEN)));
    assert_eq!(
        plan.argv,
        vec![
            "/bin/gh",
            "repo",
            "clone",
            "acme/lyra",
            "/p/lyra",
            "--",
            "--progress"
        ]
    );
    assert_eq!(plan.watch, crate::setup_actions::Watch::Cloned);
    // The clone is not a setup action the frontend can name.
    assert_eq!(crate::setup_actions::ActionId::parse("project.clone"), None);
}

#[test]
fn a_workspaces_github_account_is_set_and_cleared() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::workspace::WorkspaceStore::new(dir.path().to_path_buf()).unwrap();
    let created = store.create("lyra".into(), "/tmp/lyra".into()).unwrap();
    store
        .set_github_account(&created.id, Some(" work-acct ".into()))
        .unwrap();
    assert_eq!(
        store.snapshot().workspaces[0].github_account.as_deref(),
        Some("work-acct")
    );
    assert!(store
        .set_github_account(&created.id, Some("bad login".into()))
        .is_err());
    store.set_github_account(&created.id, Some("".into())).unwrap();
    assert_eq!(store.snapshot().workspaces[0].github_account, None);
    assert!(store.set_github_account("nope", None).is_err());
}

// ── The clone in the guided terminal (real PTYs, a stub gh) ────────────

#[cfg(unix)]
mod live {
    use super::*;
    use crate::pty::PtyRegistry;
    use crate::setup_run::{Emit, Outcome, Phase, SetupEvent, SetupRunner, Timing};
    use parking_lot::Mutex;
    use tauri::Manager;

    fn fast() -> Timing {
        Timing {
            tick: Duration::from_millis(20),
            credential_poll: Duration::from_millis(50),
            clt_poll: Duration::from_millis(50),
            login_soft_limit: Duration::from_secs(600),
            clt_limit: Duration::from_secs(600),
            success_grace: Duration::from_millis(300),
            kill_grace: Duration::from_millis(300),
            trust_poll: Duration::from_millis(50),
            trust_settle: Duration::from_millis(100),
            run_idle_limit: Duration::from_secs(600),
            run_limit: Duration::from_secs(600),
        }
    }

    struct Harness {
        _app: tauri::App<tauri::test::MockRuntime>,
        handle: tauri::AppHandle<tauri::test::MockRuntime>,
        runner: SetupRunner,
        events: Arc<Mutex<Vec<SetupEvent>>>,
        _env: std::sync::MutexGuard<'static, ()>,
    }

    impl Harness {
        fn new() -> Self {
            let guard = crate::shell_env::lock_for_test();
            if crate::shell_env::try_get().is_none() {
                crate::shell_env::init();
            }
            let app = tauri::test::mock_builder()
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .expect("build test app");
            app.manage(PtyRegistry::default());
            let handle = app.handle().clone();
            Self {
                _app: app,
                handle,
                runner: SetupRunner::default(),
                events: Arc::default(),
                _env: guard,
            }
        }

        fn emit(&self) -> Emit {
            let events = self.events.clone();
            Arc::new(move |e: &SetupEvent| events.lock().push(e.clone()))
        }

        fn start(
            &self,
            gh: &str,
            repo: &str,
            parent: &Path,
            token: Option<GhToken>,
        ) -> Result<CloneStart, String> {
            start_clone(
                &self.handle,
                &self.runner,
                CloneRequest {
                    gh,
                    repo,
                    parent,
                    origins: &[],
                    home: None,
                    token,
                    cols: 80,
                    rows: 24,
                },
                fast(),
                self.emit(),
            )
        }

        fn done(&self, run_id: &str) -> SetupEvent {
            let deadline = Instant::now() + Duration::from_secs(30);
            loop {
                if let Some(e) = self
                    .events
                    .lock()
                    .iter()
                    .find(|e| e.run_id == run_id && e.phase == Phase::Done)
                {
                    return e.clone();
                }
                assert!(
                    Instant::now() < deadline,
                    "no Done: {:?}",
                    self.events.lock()
                );
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            if let Some(pty) = self.handle.try_state::<PtyRegistry>() {
                self.runner.shutdown(&pty);
            }
        }
    }

    /// A gh whose `repo clone` runs `body` (`$4` is the destination).
    fn clone_gh(dir: &Path, body: &str) -> String {
        let gh = dir.join("gh");
        fs::write(
            &gh,
            format!(
                "#!/bin/sh\nprintf '%s' \"${{GH_TOKEN:-}}\" > \"{seen}\"\nexport GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1\n{body}\n",
                seen = dir.join("token-seen").display()
            ),
        )
        .unwrap();
        crate::platform::set_mode(&gh, 0o755).unwrap();
        gh.to_string_lossy().into_owned()
    }

    fn started(start: CloneStart) -> (String, PathBuf) {
        match start {
            CloneStart::Started { run, path } => (run.run_id, PathBuf::from(path)),
            other => panic!("{other:?}"),
        }
    }

    fn wait_for(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !path.exists() {
            assert!(Instant::now() < deadline, "the stub never started");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn a_clone_runs_in_the_guided_terminal_and_its_end_says_what_it_got() {
        let h = Harness::new();
        let w = World::new();
        let remote = bare(&w, "lyra", Some("main"));
        let bin = w.dir("bin");
        let gh = clone_gh(
            &bin,
            &format!(
                "echo \"$@\"; git clone --progress \"{}\" \"$4\"",
                remote.display()
            ),
        );
        let token = GhToken::new(STUB_TOKEN.into());
        let (run_id, path) = started(h.start(&gh, "acme/lyra", &w.projects(), token).unwrap());
        assert_eq!(path, w.projects().join("lyra"));
        let done = h.done(&run_id);
        assert_eq!(done.outcome, Some(Outcome::Succeeded), "{:?}", done.tail);
        assert_eq!(done.action_id, "project.clone");
        let clone = done.clone.clone().unwrap();
        assert!(clone.cloned && !clone.empty && clone.failure.is_none());
        assert!(path.join("a.txt").exists());
        // The chosen account's token reached gh's environment…
        assert_eq!(
            fs::read_to_string(bin.join("token-seen")).unwrap(),
            STUB_TOKEN
        );
        // …and nothing the frontend gets carries it.
        let json = serde_json::to_string(&done).unwrap();
        assert!(!json.contains(STUB_TOKEN));
        // Without an account, no token at all.
        let (run_id, _) = started(h.start(&gh, "acme/other", &w.projects(), None).unwrap());
        h.done(&run_id);
        assert_eq!(fs::read_to_string(bin.join("token-seen")).unwrap(), "");
    }

    #[test]
    fn a_refused_or_offline_clone_removes_the_folder_it_made_and_says_why() {
        let h = Harness::new();
        let w = World::new();
        let bin = w.dir("bin");
        let gh = clone_gh(
            &bin,
            "mkdir -p \"$4/.git\"; echo \"remote: Repository not found. $GH_TOKEN\" >&2; exit 128",
        );
        let token = GhToken::new(STUB_TOKEN.into());
        let (run_id, path) = started(h.start(&gh, "acme/lyra", &w.projects(), token).unwrap());
        let done = h.done(&run_id);
        assert_eq!(done.outcome, Some(Outcome::Failed));
        let clone = done.clone.clone().unwrap();
        assert_eq!(clone.failure.as_ref().unwrap().kind, CloneFailureKind::Auth);
        assert!(clone.removed_partial && !path.exists());
        // The tail it shows never carries the token.
        assert!(
            !done.tail.join("\n").contains(STUB_TOKEN),
            "{:?}",
            done.tail
        );

        let gh = clone_gh(
            &bin,
            "echo \"fatal: unable to access 'https://github.com/acme/api/': Could not resolve host: github.com\" >&2; exit 128",
        );
        let (run_id, path) = started(h.start(&gh, "acme/api", &w.projects(), None).unwrap());
        let clone = h.done(&run_id).clone.unwrap();
        assert_eq!(clone.failure.unwrap().kind, CloneFailureKind::Offline);
        assert!(!path.exists());
    }

    #[test]
    fn stop_and_quit_remove_only_the_folder_the_clone_created() {
        let h = Harness::new();
        let w = World::new();
        let bin = w.dir("bin");
        let gh = clone_gh(
            &bin,
            "mkdir -p \"$4/.git\"; echo partial > \"$4/.git/x\"; exec sleep 60",
        );
        // The user's own folders beside it, one named like a repo.
        write(&w.projects().join("mine/keep.txt"), "mine");
        fs::create_dir_all(w.projects().join("taken")).unwrap();
        // A destination that exists is never cloned into (or removed).
        match h.start(&gh, "acme/taken", &w.projects(), None).unwrap() {
            CloneStart::DestinationExists { .. } => {}
            other => panic!("{other:?}"),
        }
        assert!(w.projects().join("taken").is_dir());

        let (run_id, path) = started(h.start(&gh, "acme/lyra", &w.projects(), None).unwrap());
        wait_for(&path.join(".git/x"));
        // One run at a time: a second clone is refused and makes nothing.
        let e = h
            .start(&gh, "acme/second", &w.projects(), None)
            .unwrap_err();
        assert!(e.contains("project.clone"), "{e}");
        assert!(!w.projects().join("second").exists());
        assert!(h.runner.stop(&h.handle, Some(&run_id), &fast()));
        let done = h.done(&run_id);
        assert_eq!(done.outcome, Some(Outcome::Cancelled));
        let clone = done.clone.unwrap();
        assert_eq!(clone.failure.unwrap().kind, CloneFailureKind::Cancelled);
        assert!(clone.removed_partial && !path.exists());
        assert_eq!(
            fs::read_to_string(w.projects().join("mine/keep.txt")).unwrap(),
            "mine"
        );
        assert!(w.projects().join("taken").is_dir());

        // Quitting mid-clone removes it too.
        let (_, path) = started(h.start(&gh, "acme/quit", &w.projects(), None).unwrap());
        wait_for(&path.join(".git/x"));
        let pty = h.handle.state::<PtyRegistry>();
        assert!(h.runner.shutdown(&pty));
        assert!(!path.exists());
        assert!(w.projects().join("mine/keep.txt").exists());
    }
}

// ── Review fixes (Challenger on 785cf8c1) ──────────────────────────────

#[test]
fn a_staged_file_left_out_is_taken_out_of_the_index() {
    let w = World::new();
    let d = w.dir("home/code/lyra");
    w.git(&d, &["init", "-q", "-b", "main"]);
    write(&d.join("server.pem"), "secret");
    write(&d.join("app.py"), "print(1)");
    // Staged by the person before Plyloft looked.
    w.git(&d, &["add", "server.pem"]);
    let r = inspect(&d, &w.ctx(vec![])).unwrap();
    assert!(r.secrets.iter().any(|s| s.path == "server.pem"));
    init(
        &d,
        &InitChoices {
            leave_out: vec!["server.pem".into()],
            ..Default::default()
        },
        &w.ctx(vec![]),
    )
    .unwrap();
    assert_eq!(w.tracked(&d), vec![".gitignore", "app.py"]);
    assert!(d.join("server.pem").exists());
}

#[test]
fn a_gitignore_that_isnt_utf8_text_is_never_rewritten() {
    let w = World::new();
    let d = w.dir("home/code/lyra");
    write(&d.join("a.txt"), "a");
    // UTF-16 with a byte-order mark.
    let utf16: Vec<u8> = [0xFF, 0xFE]
        .into_iter()
        .chain("*.log\n".encode_utf16().flat_map(|u| u.to_le_bytes()))
        .collect();
    fs::write(d.join(".gitignore"), &utf16).unwrap();
    let r = inspect(&d, &w.ctx(vec![])).unwrap();
    assert!(r.ignore_problem.as_deref().unwrap().contains("UTF-8"));
    let e = init(&d, &InitChoices::default(), &w.ctx(vec![])).unwrap_err();
    assert!(e.contains("UTF-8"), "{e}");
    assert_eq!(fs::read(d.join(".gitignore")).unwrap(), utf16);
    assert!(!d.join(".git").exists());
}

#[cfg(unix)]
#[test]
fn a_linked_gitignore_is_left_as_a_link() {
    let w = World::new();
    let d = w.dir("home/code/lyra");
    write(&d.join("a.txt"), "a");
    let shared = w.root.join("shared-ignore");
    fs::write(&shared, "*.log\n").unwrap();
    std::os::unix::fs::symlink(&shared, d.join(".gitignore")).unwrap();
    let e = init(&d, &InitChoices::default(), &w.ctx(vec![])).unwrap_err();
    assert!(e.contains("link"), "{e}");
    assert!(fs::symlink_metadata(d.join(".gitignore"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read_to_string(&shared).unwrap(), "*.log\n");
    assert!(!d.join(".git").exists());
}

#[cfg(unix)]
#[test]
fn a_failure_after_the_write_keeps_an_edit_made_meanwhile() {
    let w = World::new();
    // The hook edits .gitignore (someone else's change), then fails.
    w.pre_commit("echo mine >> .gitignore\nexit 1\n");
    // Plyloft created it: an edited file isn't deleted.
    let d = w.dir("home/code/lyra");
    write(&d.join("a.txt"), "a");
    assert!(init(&d, &InitChoices::default(), &w.ctx(vec![])).is_err());
    let text = fs::read_to_string(d.join(".gitignore")).unwrap();
    assert!(text.starts_with(IGNORE_HEADER) && text.ends_with("mine\n"), "{text}");
    // Plyloft appended: the edited file isn't cut back.
    let d2 = w.dir("home/code/lyra2");
    write(&d2.join("a.txt"), "a");
    write(&d2.join(".gitignore"), "*.log\n");
    assert!(init(&d2, &InitChoices::default(), &w.ctx(vec![])).is_err());
    let text = fs::read_to_string(d2.join(".gitignore")).unwrap();
    assert!(text.starts_with("*.log\n") && text.ends_with("mine\n"), "{text}");
    // Without an edit, the append is taken back exactly.
    w.failing_hooks();
    let d3 = w.dir("home/code/lyra3");
    write(&d3.join("a.txt"), "a");
    write(&d3.join(".gitignore"), "*.log");
    assert!(init(&d3, &InitChoices::default(), &w.ctx(vec![])).is_err());
    assert_eq!(fs::read_to_string(d3.join(".gitignore")).unwrap(), "*.log");
}

#[test]
fn the_first_push_refuses_a_folder_with_more_than_the_download() {
    let w = World::new();
    let tools = w.tools(None);
    let remote = bare(&w, "lyra", None);
    w.git(&w.projects(), &["clone", "-q", &remote.to_string_lossy(), "lyra"]);
    let d = w.projects().join("lyra");
    write(&d.join("notes.txt"), "mine");
    let e = first_commit_push(&d, &tools, None).unwrap_err();
    assert!(e.contains("files besides the download"), "{e}");
    assert!(!d.join("README.md").exists());
    assert!(!w.git_ok(&remote, &["rev-parse", "--verify", "-q", "main"]));
    // Something staged (then removed from the folder) is refused too.
    w.git(&d, &["add", "notes.txt"]);
    fs::remove_file(d.join("notes.txt")).unwrap();
    let e = first_commit_push(&d, &tools, None).unwrap_err();
    assert!(e.contains("staged"), "{e}");
    assert!(!w.git_ok(&remote, &["rev-parse", "--verify", "-q", "main"]));
    // A README already there (an earlier try) is what gets committed.
    w.git(&d, &["rm", "-q", "--cached", "notes.txt"]);
    write(&d.join("README.md"), "# Mine\n");
    let done = first_commit_push(&d, &tools, None).unwrap();
    assert!(done.pushed);
    assert_eq!(w.tracked(&d), vec!["README.md"]);
    assert_eq!(fs::read_to_string(d.join("README.md")).unwrap(), "# Mine\n");
}

#[cfg(unix)]
#[test]
fn a_secret_whose_name_a_gitignore_cant_hold_stops_the_first_commit() {
    let w = World::new();
    let d = w.dir("home/code/lyra");
    write(&d.join("a.txt"), "a");
    write(&d.join("odd\nname.pem"), "secret");
    let r = inspect(&d, &w.ctx(vec![])).unwrap();
    assert_eq!(r.unnameable.len(), 1);
    assert!(r.secrets.is_empty());
    assert!(r.scan_warning.as_deref().unwrap().contains("Rename them"));
    let e = init(&d, &InitChoices::default(), &w.ctx(vec![])).unwrap_err();
    assert!(e.contains("Rename them"), "{e}");
    assert!(!d.join(".git").exists());
    // Not UTF-8, in a repository's listing.
    use std::os::unix::ffi::OsStrExt;
    let d2 = w.dir("home/code/lyra2");
    w.git(&d2, &["init", "-q", "-b", "main"]);
    let name = std::ffi::OsStr::from_bytes(b"k\xffy.key");
    if fs::write(d2.join(name), "secret").is_ok() {
        let r = inspect(&d2, &w.ctx(vec![])).unwrap();
        assert_eq!(r.unnameable.len(), 1, "{:?}", r.secrets);
        assert!(init(&d2, &InitChoices::default(), &w.ctx(vec![])).is_err());
        assert_eq!(w.git(&d2, &["ls-files"]), "");
    }
}

#[test]
fn a_cut_short_list_or_count_is_said_and_never_passed_silently() {
    let w = World::new();
    let d = w.dir("home/code/keys");
    for i in 0..=FOUND_CAP {
        write(&d.join(format!("k{i}.pem")), "k");
    }
    let r = inspect(&d, &w.ctx(vec![])).unwrap();
    assert!(r.found_truncated);
    assert_eq!(r.secrets.len(), FOUND_CAP);
    assert!(r.scan_warning.is_some());
    let all: Vec<String> = r.secrets.iter().map(|s| s.path.clone()).collect();
    let e = init(
        &d,
        &InitChoices {
            leave_out: all,
            accept_incomplete: true,
        },
        &w.ctx(vec![]),
    )
    .unwrap_err();
    assert!(e.contains("more than"), "{e}");
    assert!(!d.join(".git").exists());

    // A count stopped at its bound: refused unless the person accepts it.
    let d2 = w.dir("home/code/many");
    for i in 0..10 {
        write(&d2.join(format!("f{i}.txt")), "x");
    }
    let mut ctx = w.ctx(vec![]);
    ctx.limits = ScanLimits {
        max_files: 3,
        ..ScanLimits::REAL
    };
    let r = inspect(&d2, &ctx).unwrap();
    assert!(r.scan_warning.as_deref().unwrap().contains("stopped counting"));
    assert!(init(&d2, &InitChoices::default(), &ctx).is_err());
    assert!(!d2.join(".git").exists());
    init(
        &d2,
        &InitChoices {
            accept_incomplete: true,
            ..Default::default()
        },
        &ctx,
    )
    .unwrap();
    assert_eq!(w.tracked(&d2).len(), 11);
    assert!(serde_json::from_str::<InitChoices>(r#"{"leaveOut":[],"acceptIncomplete":true}"#)
        .unwrap()
        .accept_incomplete);
}

#[test]
fn env_files_are_matched_case_insensitively_and_templates_are_kept() {
    assert!(default_ignores_env(".ENV"));
    assert!(default_ignores_env("cfg/.Env.Local"));
    for template in [".env.example", ".env.sample", ".env.template", ".env.dist", ".ENV.SAMPLE"] {
        assert!(!default_ignores_env(template), "{template}");
    }
    let w = World::new();
    let d = w.dir("home/code/api");
    for f in [".env.sample", ".env.template", ".env.dist", ".env.example", "main.go"] {
        write(&d.join(f), "x");
    }
    init(&d, &InitChoices::default(), &w.ctx(vec![])).unwrap();
    assert_eq!(
        w.tracked(&d),
        vec![".env.dist", ".env.example", ".env.sample", ".env.template", ".gitignore", "main.go"]
    );
}

#[test]
fn disk_and_share_roots_are_refused_and_so_are_bad_places_for_new_projects() {
    let mac = |p: &str| refused_folder(p, Some("/Users/ann"), None, false);
    assert_eq!(mac("/Volumes/Backup"), Some(RefusedFolder::Volume));
    assert_eq!(mac("/volumes/backup/"), Some(RefusedFolder::Volume));
    assert_eq!(mac("/Volumes/Backup/code"), None);
    assert_eq!(RefusedFolder::Volume.words(), REFUSED_ROOT);
    let win = |p: &str| refused_folder(p, Some(r"C:\Users\Ann"), None, true);
    assert_eq!(win(r"\\server\share"), Some(RefusedFolder::Volume));
    assert_eq!(win(r"\\server\share\"), Some(RefusedFolder::Volume));
    assert_eq!(win(r"\\server"), Some(RefusedFolder::Volume));
    assert_eq!(win(r"\\?\UNC\server\share"), Some(RefusedFolder::Volume));
    assert_eq!(win(r"\\server\share\lyra"), None);
    assert_eq!(win(r"\\?\UNC\server\share\lyra"), None);

    let w = World::new();
    let tools = w.tools(None);
    #[cfg(unix)]
    {
        let p = new_preview("My app", Path::new("/"), &tools, None);
        assert!(p.place_refused && p.problem.is_some(), "{p:?}");
        let p = new_preview("My app", Path::new("/usr"), &tools, None);
        assert!(p.place_refused, "{p:?}");
        assert!(clone_preflight("acme/lyra", Path::new("/"), &[], None).is_err());
        assert!(clone_preflight("acme/lyra", Path::new("/System"), &[], None).is_err());
    }
    // The folder holding the home folders is refused as a parent (like
    // /Users); the home folder is a fine parent; the home folder itself or
    // the projects folder as the thing made is refused.
    let home = w.home();
    assert!(new_preview("Lyra", &w.root, &tools, Some(&home)).place_refused);
    assert!(!new_preview("Lyra", &home, &tools, Some(&home)).place_refused);
    let out = create_new(&new_request("Home"), &w.root, &tools, Some(&home), None).unwrap();
    assert!(matches!(out, NewProjectOutcome::Refused { .. }), "{out:?}");
    assert!(!home.join(".git").exists());
    assert!(targets_projects_folder("Projects", &home, &w.projects()));
    assert!(targets_projects_folder(" projects ", &home, &w.projects()));
    assert!(!targets_projects_folder("Lyra", &home, &w.projects()));
}

#[cfg(unix)]
#[test]
fn a_partial_download_that_cant_be_removed_is_marked_for_next_time() {
    let w = World::new();
    let dest = w.dir("home/Projects/lyra");
    write(&dest.join(".git/locked/obj"), "x");
    let locked = dest.join(".git/locked");
    crate::platform::set_mode(&locked, 0o555).unwrap();
    let removed = remove_created_within(&dest, 2, Duration::from_millis(10));
    crate::platform::set_mode(&locked, 0o755).unwrap();
    assert!(!removed);
    assert!(dest.join(PARTIAL_MARKER).exists());
    let r = inspect(&dest, &w.ctx(vec![])).unwrap();
    assert!(r.partial_download);
    match clone_preflight("acme/lyra", &w.projects(), &[], None).unwrap() {
        ClonePreflight::DestinationExists { words, .. } => {
            assert!(words.contains("partial download"), "{words}")
        }
        other => panic!("{other:?}"),
    }
    // Removable now: gone on the first try.
    assert!(remove_created_within(&dest, 2, Duration::from_millis(10)));
    assert!(!dest.exists());
}

#[cfg(unix)]
#[test]
fn a_full_page_of_organisations_marks_the_list_cut_short() {
    let w = World::new();
    let bin = w.dir("bin");
    let arms = r#""org list")
  i=0; while [ $i -lt 30 ]; do echo "org$i"; i=$((i+1)); done
  ;;
"repo list")
  echo '[]'
  ;;
"api user/repos?affiliation=collaborator,organization_member&per_page=100&page=1")
  echo '[]'
  ;;"#;
    let tools = w.tools(Some(stub_gh(&bin, arms)));
    let list = repo_list(&tools, "main-acct", None, &[], &[]);
    assert!(list.truncated);
    assert!(list.errors.is_empty(), "{:?}", list.errors);
}

#[test]
fn a_guided_run_never_inherits_a_github_token() {
    assert!(crate::pty::SETUP_SCRUBBED_ENV.contains(&"GH_TOKEN"));
    assert!(crate::pty::SETUP_SCRUBBED_ENV.contains(&"GITHUB_TOKEN"));
    // The scrub comes before the run's own variables (the chosen token).
    let src = include_str!("pty.rs");
    let spawn = &src[src.find("pub fn spawn_setup").unwrap()..];
    let scrub = spawn.find("SETUP_SCRUBBED_ENV").unwrap();
    let extra = spawn.find("for (key, value) in &extra_env").unwrap();
    assert!(scrub < extra);
}

// ── Follow-ups (re-review of 80734503) ─────────────────────────────────

#[test]
fn a_half_written_gitignore_is_taken_back_and_nothing_else() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(".gitignore");
    let text = "# Added by Plyloft\nnode_modules/\n.env\n";
    // Created, and only part of it got out: removed.
    fs::write(&path, &text[..10]).unwrap();
    undo_ignore(&path, &IgnoreWrite::Created(text.into()));
    assert!(!path.exists());
    // Created, then someone added a line: kept.
    fs::write(&path, format!("{text}mine\n")).unwrap();
    undo_ignore(&path, &IgnoreWrite::Created(text.into()));
    assert!(path.exists());
    // Appended, only part of the tail got out: cut back to the original.
    let after = format!("*.log\n{text}");
    fs::write(&path, &after[..12]).unwrap();
    undo_ignore(&path, &IgnoreWrite::Appended { before: 6, after: after.clone() });
    assert_eq!(fs::read_to_string(&path).unwrap(), "*.log\n");
    // Appended, nothing got out: unchanged.
    undo_ignore(&path, &IgnoreWrite::Appended { before: 6, after: after.clone() });
    assert_eq!(fs::read_to_string(&path).unwrap(), "*.log\n");
    // Appended, and the original was changed meanwhile: kept.
    fs::write(&path, format!("*.tmp\n{}", &after[6..12])).unwrap();
    undo_ignore(&path, &IgnoreWrite::Appended { before: 6, after });
    assert!(fs::read_to_string(&path).unwrap().starts_with("*.tmp\n"));

    // A write that fails once the file is Plyloft's still records it.
    let mut wrote = IgnoreWrite::Nothing;
    let fresh = dir.path().join("fresh");
    write_ignore(&fresh, None, text, &mut wrote).unwrap();
    assert!(matches!(wrote, IgnoreWrite::Created(_)));
    // …and one that can't even open (the file appeared meanwhile) doesn't.
    let mut wrote = IgnoreWrite::Nothing;
    assert!(write_ignore(&fresh, None, text, &mut wrote).is_err());
    assert!(matches!(wrote, IgnoreWrite::Nothing));
    undo_ignore(&fresh, &wrote);
    assert!(fresh.exists());
}

#[test]
fn the_first_push_wants_a_plain_readme_and_ignores_os_files() {
    let w = World::new();
    let tools = w.tools(None);
    let remote = bare(&w, "lyra", None);
    w.git(&w.projects(), &["clone", "-q", &remote.to_string_lossy(), "lyra"]);
    let d = w.projects().join("lyra");
    // A README.md that is a folder: refused, nothing committed or pushed.
    fs::create_dir(d.join("README.md")).unwrap();
    let e = first_commit_push(&d, &tools, None).unwrap_err();
    assert!(e.contains("README.md"), "{e}");
    assert!(!w.git_ok(&d, &["rev-parse", "--verify", "-q", "HEAD"]));
    assert!(!w.git_ok(&remote, &["rev-parse", "--verify", "-q", "main"]));
    fs::remove_dir(d.join("README.md")).unwrap();
    // The operating system's own files are allowed and left out.
    write(&d.join(".DS_Store"), "x");
    write(&d.join("Thumbs.db"), "x");
    let done = first_commit_push(&d, &tools, None).unwrap();
    assert!(done.pushed, "{:?}", done.words);
    assert_eq!(w.tracked(&d), vec!["README.md"]);
    assert!(d.join(".DS_Store").exists());
}

// ── OB-12: step 7's projects folder ──────────────────────────────────────

#[test]
fn projects_folder_look_counts_git_projects_directly_inside() {
    let tmp = tempfile::tempdir().unwrap();
    let root = canonical(tmp.path());
    let missing = look_projects_folder(&root.join("Projects"));
    assert!(!missing.exists && !missing.not_a_folder);
    assert_eq!(missing.projects, 0);

    let folder = root.join("Projects");
    fs::create_dir_all(folder.join("lyra/.git")).unwrap();
    fs::create_dir_all(folder.join("atlas")).unwrap();
    fs::write(folder.join("atlas/.git"), "gitdir: elsewhere").unwrap(); // a worktree's .git file
    fs::create_dir_all(folder.join("notes")).unwrap();
    fs::create_dir_all(folder.join("deep/inner/.git")).unwrap(); // not directly inside
    fs::write(folder.join("readme.txt"), "x").unwrap();
    let look = look_projects_folder(&folder);
    assert!(look.exists && !look.not_a_folder);
    assert_eq!(look.projects, 2);

    let file = root.join("file");
    fs::write(&file, "x").unwrap();
    let look = look_projects_folder(&file);
    assert!(look.exists && look.not_a_folder);
}

#[test]
fn projects_folder_create_makes_it_keeps_one_there_and_refuses_a_file() {
    let tmp = tempfile::tempdir().unwrap();
    let root = canonical(tmp.path());
    let folder = root.join("home/Projects");
    assert_eq!(create_projects_folder(&folder).unwrap(), folder);
    assert!(folder.is_dir());
    fs::write(folder.join("keep.txt"), "mine").unwrap();
    create_projects_folder(&folder).unwrap();
    assert_eq!(fs::read_to_string(folder.join("keep.txt")).unwrap(), "mine");

    let file = root.join("taken");
    fs::write(&file, "x").unwrap();
    assert!(create_projects_folder(&file).unwrap_err().contains("not a folder"));
    assert!(create_projects_folder(Path::new("relative/Projects")).is_err());
}

#[test]
fn ignore_plan_is_exactly_what_init_writes() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = canonical(tmp.path());
    fs::write(dir.join(".gitignore"), "node_modules/\n/big.mov\n").unwrap();
    let secrets = vec![".env".to_string(), "deploy.pem".to_string()];
    // big.mov and deploy.pem left out; .env unticked (kept, needs a `!` line).
    let leave_out = vec!["big.mov".to_string(), "deploy.pem".to_string()];
    let plan = ignore_plan(&dir, &secrets, &leave_out).unwrap();
    let existing = fs::read_to_string(dir.join(".gitignore")).unwrap();
    let kept = kept_env_secrets(&secrets, &leave_out);
    assert_eq!(kept, vec![".env".to_string()]);
    let (_, added) = plan_ignore(&existing, INIT_IGNORE, &leave_out, &kept);
    assert_eq!(plan, added);
    assert!(!plan.contains(&"node_modules/".to_string()));
    assert!(!plan.contains(&"/big.mov".to_string()));
    assert!(plan.contains(&"/deploy.pem".to_string()));
    assert!(plan.contains(&"!/.env".to_string()));
    // Ticking .env drops the keep line.
    let plan = ignore_plan(&dir, &secrets, &[".env".to_string()]).unwrap();
    assert!(!plan.contains(&"!/.env".to_string()));
}
