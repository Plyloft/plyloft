//! Skills hub H10 (R6): My library — create, use on a second Mac, publish
//! with the two-Mac compare, the deleted repository, delivery as `mine`.
//! GitHub is a [`Hub`] fake over local bare repositories; every git is real.

use super::*;
use std::cell::RefCell;

fn run(dir: &Path, args: &[&str]) -> String {
    let out = crate::platform::git_command()
        .args(["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// GitHub as local bare repositories under `remotes/`.
struct FakeHub {
    login: String,
    remotes: PathBuf,
    scopes: Option<Vec<String>>,
    offline: bool,
    create_error: Option<String>,
    created: RefCell<Vec<String>>,
}

impl FakeHub {
    fn new(remotes: &Path) -> Self {
        Self {
            login: "matteo".into(),
            remotes: remotes.to_path_buf(),
            scopes: Some(vec!["gist".into(), "read:org".into(), "repo".into()]),
            offline: false,
            create_error: None,
            created: RefCell::new(Vec::new()),
        }
    }
    fn bare(&self, slug: &str) -> PathBuf {
        self.remotes.join(format!("{}.git", crate::team::slug_dir_name(slug)))
    }
}

impl Hub for FakeHub {
    fn login(&self) -> Result<String, String> {
        Ok(self.login.clone())
    }
    fn scopes(&self, _login: &str) -> Option<Vec<String>> {
        self.scopes.clone()
    }
    fn repo(&self, slug: &str) -> Result<RepoState, String> {
        if self.offline {
            return Err(OFFLINE_WORDS.into());
        }
        let bare = self.bare(slug);
        if !bare.is_dir() {
            return Ok(RepoState::Missing);
        }
        let heads = crate::platform::git_command()
            .args(["rev-parse", "--verify", "-q", "HEAD"])
            .current_dir(&bare)
            .output()
            .unwrap();
        if !heads.status.success() {
            return Ok(RepoState::Empty);
        }
        let names = run(&bare, &["ls-tree", "--name-only", "HEAD", "library/"]);
        Ok(if names.lines().any(|n| n.ends_with("claude") || n.ends_with("codex")) {
            RepoState::Library
        } else {
            RepoState::NotLibrary
        })
    }
    fn create(&self, slug: &str) -> Result<(), String> {
        if let Some(error) = &self.create_error {
            return Err(error.clone());
        }
        self.created.borrow_mut().push(slug.to_string());
        let bare = self.bare(slug);
        std::fs::create_dir_all(&bare).unwrap();
        run(&bare, &["init", "--bare", "--quiet", "-b", "main"]);
        Ok(())
    }
    fn url(&self, slug: &str) -> String {
        self.bare(slug).to_string_lossy().into_owned()
    }
}

struct World {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    remotes: PathBuf,
    mac_a: PathBuf,
    mac_b: PathBuf,
    home: PathBuf,
}

fn world() -> World {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_path_buf();
    let w = World {
        remotes: root.join("remotes"),
        mac_a: root.join("mac-a"),
        mac_b: root.join("mac-b"),
        home: root.join("home"),
        root,
        _tmp: tmp,
    };
    for dir in [&w.remotes, &w.mac_a, &w.mac_b, &w.home] {
        std::fs::create_dir_all(dir).unwrap();
    }
    w
}

fn skill_dir(root: &Path, name: &str, body: &str) -> PathBuf {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), format!("---\nname: {name}\ndescription: {body}\n---\n{body}\n")).unwrap();
    dir
}

fn files(body: &str, name: &str) -> Vec<SourceFile> {
    vec![SourceFile {
        path: "SKILL.md".into(),
        bytes: format!("---\nname: {name}\ndescription: {body}\n---\n{body}\n").into_bytes(),
        executable: false,
    }]
}

fn on_github(hub: &FakeHub, repo: &str, path: &str) -> String {
    run(&hub.bare(repo), &["show", &format!("main:{path}")])
}

fn options() -> crate::library_snapshot::Options {
    crate::library_snapshot::Options { path_limit: None, cap_bytes: crate::library_snapshot::CAP_BYTES }
}

#[test]
fn create_makes_a_private_repo_with_the_layout_and_the_chosen_skills() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    let review = skill_dir(&w.home, "my-review", "Your review checklist.");
    let ready = create_with(&hub, &w.mac_a, "plyloft-skills", &[("my-review".into(), review.clone())]).expect("created");
    assert_eq!(ready.repo, "matteo/plyloft-skills");
    assert_eq!(ready.account, "matteo");
    assert_eq!(*hub.created.borrow(), vec!["matteo/plyloft-skills".to_string()]);
    assert_eq!(ready.dir, w.mac_a.join("my-library").join("matteo__plyloft-skills"));
    // On GitHub: the layout, the README, the skill in both halves.
    let listed = run(&hub.bare("matteo/plyloft-skills"), &["ls-tree", "-r", "--name-only", "main"]);
    for path in [
        "README.md",
        "library/claude/mine/.claude-plugin/plugin.json",
        "library/codex/.agents/plugins/marketplace.json",
        "library/codex/plugins/mine/.codex-plugin/plugin.json",
        "library/claude/mine/skills/my-review/SKILL.md",
        "library/codex/plugins/mine/skills/my-review/SKILL.md",
    ] {
        assert!(listed.lines().any(|l| l == path), "{path} missing from {listed}");
    }
    assert!(!listed.contains("library/knowledge"), "skills only (§14 Q22)");
    let market: serde_json::Value =
        serde_json::from_str(&on_github(&hub, &ready.repo, "library/codex/.agents/plugins/marketplace.json")).unwrap();
    assert_eq!(market["name"], MARKETPLACE);
    assert_eq!(market["plugins"][0]["name"], PLUGIN);
    // The original stays untouched.
    assert!(review.join("SKILL.md").is_file());
    // The library reads as the plugin `mine` for both CLIs.
    let library = crate::team_skills::read_library(&ready.dir);
    let skill = library.skills.iter().find(|s| s.name == "my-review").expect("listed");
    assert_eq!(skill.plugin, PLUGIN);
    assert!(skill.claude && skill.codex);
    // Nothing left aside.
    let leftovers: Vec<_> = std::fs::read_dir(w.mac_a.join("my-library"))
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(".new-"))
        .collect();
    assert!(leftovers.is_empty());
    assert_eq!(clones_on_disk(&w.mac_a), vec![ready.dir.clone()]);
}

/// 1.175.0 (A7, SEC-7): a publish to My library refuses what Share with
/// Team… refuses, in the same words, before anything is read or made.
#[test]
fn a_private_file_is_refused_before_a_skill_goes_to_my_library() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    let deploy = skill_dir(&w.home, "deploy", "Ship it.");
    // Clean: read as before.
    let clean = publishable_files("deploy", &deploy, false).unwrap();
    assert_eq!(clean.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["SKILL.md"]);

    std::fs::write(deploy.join(".env"), "TOKEN=abc\n").unwrap();
    let own = "deploy holds .env, which looks private, so nothing was shared. Move it out of the skill's folder, then try again.";
    assert_eq!(publishable_files("deploy", &deploy, false).unwrap_err(), own);
    assert_eq!(
        publishable_files("deploy", &deploy, true).unwrap_err(),
        format!("{own} If it's committed, take it out with a commit; it stays in the history of any branch that has it."),
        "a repository's skill"
    );
    // Create My library with it ticked: nothing is made on GitHub.
    let refused = create_with(&hub, &w.mac_a, "plyloft-skills", &[("deploy".into(), deploy.clone())]).unwrap_err();
    assert_eq!(refused, own);
    assert!(!hub.bare("matteo/plyloft-skills").exists(), "nothing was created");

    std::fs::remove_file(deploy.join(".env")).unwrap();
    std::fs::create_dir_all(deploy.join("certs")).unwrap();
    std::fs::write(deploy.join("certs/server.pem"), "-----BEGIN-----\n").unwrap();
    let refused = publishable_files("deploy", &deploy, false).unwrap_err();
    assert!(refused.starts_with("deploy holds certs/server.pem, which looks private, so nothing was shared."), "{refused}");
    std::fs::remove_dir_all(deploy.join("certs")).unwrap();

    // A repository's skill: what git ignores in that checkout is left out,
    // and the rest goes (round 3, S3).
    let repo = w.root.join("project");
    let in_repo = skill_dir(&repo.join(".claude/skills"), "deploy", "Ship it.");
    run(&repo, &["init", "-q"]);
    std::fs::write(repo.join(".git/info/exclude"), "config.json\n__pycache__/\n.venv/\n.env\n").unwrap();
    // Round 5 (V1): ignored private names are left out too, and stop nothing.
    std::fs::create_dir_all(in_repo.join(".venv/lib/certifi")).unwrap();
    std::fs::write(in_repo.join(".venv/lib/certifi/cacert.pem"), "cert\n").unwrap();
    std::fs::write(in_repo.join(".env"), "TOKEN=1\n").unwrap();
    std::fs::write(in_repo.join("config.json"), "{}\n").unwrap();
    std::fs::create_dir_all(in_repo.join("__pycache__")).unwrap();
    std::fs::write(in_repo.join("__pycache__/x.pyc"), "x").unwrap();
    std::fs::write(in_repo.join("notes.md"), "notes\n").unwrap();
    let sent = publishable_files("deploy", &in_repo, true).unwrap();
    assert_eq!(sent.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["SKILL.md", "notes.md"]);
    std::fs::write(in_repo.join("credentials.json"), "{}\n").unwrap();
    let stopped = publishable_files("deploy", &in_repo, true).unwrap_err();
    assert!(stopped.starts_with("deploy holds credentials.json, which looks private, so nothing was shared."), "{stopped}");
    std::fs::remove_file(in_repo.join("credentials.json")).unwrap();
    std::fs::write(in_repo.join("local.env.pem"), "key\n").unwrap();
    let stopped = publishable_files("deploy", &in_repo, true).unwrap_err();
    assert!(stopped.starts_with("deploy holds local.env.pem, which looks private"), "a private name git doesn't ignore: {stopped}");

    // A folder with a repository of its own inside would reach git empty.
    std::fs::create_dir_all(deploy.join(".git")).unwrap();
    let refused = publishable_files("deploy", &deploy, false).unwrap_err();
    assert!(refused.starts_with("deploy is a git repository of its own"), "{refused}");
    std::fs::remove_dir_all(deploy.join(".git")).unwrap();
    create_with(&hub, &w.mac_a, "plyloft-skills", &[("deploy".into(), deploy)]).expect("a clean skill still goes");
}

#[test]
fn create_refuses_a_name_taken_and_offers_use_for_a_library() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    create_with(&hub, &w.mac_a, "plyloft-skills", &[]).expect("created");
    let again = create_with(&hub, &w.mac_b, "plyloft-skills", &[]).unwrap_err();
    assert!(again.contains(ALREADY_A_LIBRARY_MARKER), "{again}");
    // A repository that is something else.
    hub.create("matteo/website").unwrap();
    let work = w.root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    run(&work, &["init", "-q", "-b", "main"]);
    std::fs::write(work.join("index.html"), "hi").unwrap();
    run(&work, &["add", "."]);
    run(&work, &["commit", "-qm", "site"]);
    run(&work, &["push", "-q", &hub.url("matteo/website"), "main"]);
    let taken = create_with(&hub, &w.mac_b, "website", &[]).unwrap_err();
    assert_eq!(taken, "`matteo/website` already exists and isn't a skills library. Pick another name.");
    assert!(use_with(&hub, &w.mac_b, "matteo/website", None).unwrap_err().contains("isn't a skills library"));
    assert!(name_problem("my skills").is_some());
    assert!(name_problem(".hidden").is_some());
    assert!(name_problem("plyloft-skills").is_none());
}

#[test]
fn a_token_without_repo_asks_for_it_before_anything_is_made() {
    let w = world();
    let mut hub = FakeHub::new(&w.remotes);
    hub.scopes = Some(vec!["gist".into(), "read:org".into()]);
    let refused = create_with(&hub, &w.mac_a, "plyloft-skills", &[]).unwrap_err();
    assert!(refused.starts_with(GRANT_MARKER), "{refused}");
    assert!(hub.created.borrow().is_empty());
    assert!(!w.mac_a.join("my-library").join("matteo__plyloft-skills").exists());
    // Scopes gh doesn't advertise: try, and map GitHub's 403 to the same words.
    hub.scopes = None;
    hub.create_error = Some("HTTP 403: Resource not accessible by integration".into());
    let refused = create_with(&hub, &w.mac_a, "plyloft-skills", &[]).unwrap_err();
    assert!(refused.starts_with(GRANT_MARKER), "{refused}");
    assert!(!w.mac_a.join("my-library").join("matteo__plyloft-skills").exists());
}

#[test]
fn use_on_a_second_mac_clones_it_and_offline_leaves_nothing() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    let review = skill_dir(&w.home, "my-review", "v1");
    create_with(&hub, &w.mac_a, "plyloft-skills", &[("my-review".into(), review)]).unwrap();
    assert_eq!(find_with(&hub).unwrap().as_deref(), Some("matteo/plyloft-skills"));
    let ready = use_with(&hub, &w.mac_b, "matteo/plyloft-skills", None).expect("cloned");
    assert!(ready.dir.join("library/claude/mine/skills/my-review/SKILL.md").is_file());
    assert_eq!(run(&ready.dir, &["config", "core.longpaths"]), "true");

    let mut offline = FakeHub::new(&w.remotes);
    offline.offline = true;
    let third = w.root.join("mac-c");
    std::fs::create_dir_all(&third).unwrap();
    assert_eq!(use_with(&offline, &third, "matteo/plyloft-skills", None).unwrap_err(), OFFLINE_WORDS);
    assert!(!third.join("my-library").join("matteo__plyloft-skills").exists());
    // A clone that fails half-way leaves no scratch behind.
    let broken = FakeHub::new(&w.remotes);
    let objects = broken.bare("matteo/plyloft-skills").join("objects");
    let aside = w.root.join("objects-aside");
    std::fs::rename(&objects, &aside).unwrap();
    std::fs::create_dir_all(&objects).unwrap();
    // The fake's own `repo` reads the bare repository: answer "library" for it.
    struct SaysLibrary<'a>(&'a FakeHub);
    impl Hub for SaysLibrary<'_> {
        fn login(&self) -> Result<String, String> { self.0.login() }
        fn scopes(&self, l: &str) -> Option<Vec<String>> { self.0.scopes(l) }
        fn repo(&self, _: &str) -> Result<RepoState, String> { Ok(RepoState::Library) }
        fn create(&self, s: &str) -> Result<(), String> { self.0.create(s) }
        fn url(&self, s: &str) -> String { self.0.url(s) }
    }
    assert!(use_with(&SaysLibrary(&broken), &third, "matteo/plyloft-skills", None).is_err());
    let left: Vec<_> = std::fs::read_dir(third.join("my-library")).map(|d| d.flatten().collect()).unwrap_or_default();
    assert!(left.is_empty(), "nothing half-cloned: {left:?}");
}

#[test]
fn a_second_publish_from_the_other_mac_shows_the_compare_and_never_overrides() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    let a = create_with(&hub, &w.mac_a, "plyloft-skills", &[]).unwrap();
    let b = use_with(&hub, &w.mac_b, &a.repo, None).unwrap();
    let repo = a.repo.clone();
    let path = "library/claude/mine/skills/sql-style/SKILL.md";

    // Mac A publishes v1.
    let first = publish_with(&hub, &w.mac_a, &a.dir, &repo, "sql-style", &files("v1", "sql-style"), None, None, "a Mac", 1).unwrap();
    assert!(matches!(first, Published::Published { .. }), "{first:?}");
    // The same files again: nothing to do.
    let same = publish_with(&hub, &w.mac_a, &a.dir, &repo, "sql-style", &files("v1", "sql-style"), None, None, "a Mac", 2).unwrap();
    assert!(matches!(same, Published::AlreadyThere { .. }));

    // Mac B, which never published it, publishes its own v2: the compare
    // (2-way: no version it started from), nothing written.
    let compare = match publish_with(&hub, &w.mac_b, &b.dir, &repo, "sql-style", &files("v2", "sql-style"), None, None, "a PC", 3).unwrap() {
        Published::Compare { compare, .. } => compare,
        other => panic!("expected the compare, got {other:?}"),
    };
    assert!(compare.two_way);
    assert_eq!(compare.files[0].path, "SKILL.md");
    assert_eq!(compare.files[0].status, "differs");
    assert!(compare.files[0].upstream.as_deref().unwrap().contains("v1"));
    assert!(compare.files[0].here.as_deref().unwrap().contains("v2"));
    assert!(compare.other_author.is_some());
    assert!(on_github(&hub, &repo, path).contains("v1"));
    // An answer for a version GitHub no longer has is the compare again.
    let stale = publish_with(&hub, &w.mac_b, &b.dir, &repo, "sql-style", &files("v2", "sql-style"), Some(Choice::KeepThis), Some("0000"), "a PC", 4).unwrap();
    assert!(matches!(stale, Published::Compare { .. }));
    // Keep this PC's.
    let kept = publish_with(&hub, &w.mac_b, &b.dir, &repo, "sql-style", &files("v2", "sql-style"), Some(Choice::KeepThis), Some(&compare.other_id), "a PC", 5).unwrap();
    assert!(matches!(kept, Published::Published { .. }));
    assert!(on_github(&hub, &repo, path).contains("v2"));

    // Mac A edits from v1 → v3 and publishes: 3-way (base v1, other v2).
    let compare = match publish_with(&hub, &w.mac_a, &a.dir, &repo, "sql-style", &files("v3", "sql-style"), None, None, "a Mac", 6).unwrap() {
        Published::Compare { compare, .. } => compare,
        other => panic!("expected the compare, got {other:?}"),
    };
    assert!(!compare.two_way);
    assert_eq!(compare.files[0].status, "both");
    assert!(compare.files[0].base.as_deref().unwrap().contains("v1"));
    // Keep the other's: nothing written, and this Mac's base is now v2 — so
    // the next publish of this Mac's version goes through without asking.
    let other = publish_with(&hub, &w.mac_a, &a.dir, &repo, "sql-style", &files("v3", "sql-style"), Some(Choice::KeepOther), Some(&compare.other_id), "a Mac", 7).unwrap();
    assert!(matches!(other, Published::KeptOther { .. }));
    assert!(on_github(&hub, &repo, path).contains("v2"));
    let later = publish_with(&hub, &w.mac_a, &a.dir, &repo, "sql-style", &files("v3", "sql-style"), None, None, "a Mac", 8).unwrap();
    assert!(matches!(later, Published::Published { .. }), "{later:?}");
    // Both halves carry it.
    assert!(on_github(&hub, &repo, "library/codex/plugins/mine/skills/sql-style/SKILL.md").contains("v3"));
}

#[test]
fn a_publish_whose_push_fails_leaves_the_clone_as_github_has_it() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    let a = create_with(&hub, &w.mac_a, "plyloft-skills", &[]).unwrap();
    let b = use_with(&hub, &w.mac_b, &a.repo, None).unwrap();
    // B publishes another skill; A's clone is behind — its publish of its
    // own skill pulls first and goes through (another skill: no compare).
    publish_with(&hub, &w.mac_b, &b.dir, &a.repo, "other", &files("o", "other"), None, None, "a PC", 1).unwrap();
    let mine = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "mine-only", &files("m", "mine-only"), None, None, "a Mac", 2).unwrap();
    assert!(matches!(mine, Published::Published { .. }));
    let listed = run(&hub.bare(&a.repo), &["ls-tree", "-r", "--name-only", "main"]);
    assert!(listed.contains("skills/other/SKILL.md") && listed.contains("skills/mine-only/SKILL.md"));
    // A push that can't land: no commit left behind, the files GitHub's.
    let tip = run(&a.dir, &["rev-parse", "HEAD"]);
    let hook = hub.bare(&a.repo).join("hooks").join("pre-receive");
    std::fs::write(&hook, "#!/bin/sh\necho refused >&2\nexit 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let failed = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "mine-only", &files("m2", "mine-only"), None, None, "a Mac", 3);
    assert!(failed.is_err(), "{failed:?}");
    assert_eq!(run(&a.dir, &["rev-parse", "HEAD"]), tip);
    assert_eq!(run(&a.dir, &["status", "--porcelain"]), "");
}

/// Sets a hook of the fake GitHub repository.
fn set_hook(hub: &FakeHub, repo: &str, name: &str, script: &str) {
    let hook = hub.bare(repo).join("hooks").join(name);
    std::fs::write(&hook, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

/// 1.176.4: a press whose push the time limit stops before GitHub moves the
/// branch (a test bound of 2 s against a hook that sleeps 6 s).
fn kept_press(hub: &FakeHub, w: &World, dir: &Path, repo: &str, skill: &str, body: &str, at: i64) -> Published {
    set_hook(hub, repo, "pre-receive", "#!/bin/sh\nsleep 6\nexit 1\n");
    TEST_GIT_TIMEOUT.with(|t| t.set(Some(std::time::Duration::from_secs(2))));
    let out = publish_with(hub, &w.mac_a, dir, repo, skill, &files(body, skill), None, None, "a Mac", at);
    TEST_GIT_TIMEOUT.with(|t| t.set(None));
    set_hook(hub, repo, "pre-receive", "#!/bin/sh\nexit 0\n");
    out.expect("a kept press is no error")
}

/// The other computer publishes `skill`, keeping its own over the compare.
fn publish_on_b(hub: &FakeHub, w: &World, dir: &Path, repo: &str, skill: &str, body: &str, at: i64) {
    match publish_with(hub, &w.mac_b, dir, repo, skill, &files(body, skill), None, None, "a PC", at).unwrap() {
        Published::Compare { compare, .. } => {
            let out = publish_with(hub, &w.mac_b, dir, repo, skill, &files(body, skill), Some(Choice::KeepThis), Some(&compare.other_id), "a PC", at).unwrap();
            assert!(matches!(out, Published::Published { .. }), "{out:?}");
        }
        out => assert!(matches!(out, Published::Published { .. }), "{out:?}"),
    }
}

fn backups(dir: &Path) -> Vec<String> {
    run(dir, &["for-each-ref", "--format=%(objectname) %(refname)", crate::team::BACKUP_REF_PREFIX])
        .lines()
        .map(String::from)
        .collect()
}

/// 1.176.3 (A5R-09, owner 2026-11-23): a push that reached GitHub but whose
/// answer came after the bound is read back with `ls-remote`: GitHub's
/// branch holds the commit, so the skill was added — the commit is kept and
/// the base is written. 1.176.4 (owner 2026-11-23): one that GitHub's branch
/// doesn't show is kept too, said as kept, and goes with a later press.
#[test]
fn a_push_that_timed_out_after_reaching_github_is_a_publish() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    let a = create_with(&hub, &w.mac_a, "plyloft-skills", &[]).unwrap();
    // The ref moves, then GitHub's answer is slower than the bound.
    set_hook(&hub, &a.repo, "post-receive", "#!/bin/sh\nsleep 6\n");
    TEST_GIT_TIMEOUT.with(|t| t.set(Some(std::time::Duration::from_secs(2))));
    let landed = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "slow", &files("s", "slow"), None, None, "a Mac", 1);
    TEST_GIT_TIMEOUT.with(|t| t.set(None));
    let landed = landed.expect("GitHub has it: the skill was added");
    let Published::Published { commit, .. } = landed else { panic!("{landed:?}") };
    let tip = run(&hub.bare(&a.repo), &["rev-parse", "main"]);
    assert_eq!(commit, tip);
    assert_eq!(run(&a.dir, &["rev-parse", "HEAD"]), tip, "the commit is kept");
    assert!(base_of(&w.mac_a, &a.repo, "slow").is_some(), "the base is written");
    set_hook(&hub, &a.repo, "post-receive", "#!/bin/sh\nexit 0\n");

    // Timed out and GitHub's branch doesn't show it: kept, said as kept —
    // neither "added" nor "couldn't add".
    let kept = kept_press(&hub, &w, &a.dir, &a.repo, "slow", "s2", 2);
    let Published::Kept { words, .. } = &kept else { panic!("{kept:?}") };
    assert_eq!(words, &kept_words("slow"));
    assert!(words.contains("is kept in My library on") && words.contains("only when you add a skill to My library again"), "{words}");
    let held = run(&a.dir, &["rev-parse", "HEAD"]);
    assert_ne!(held, tip, "the commit is kept");
    assert_eq!(run(&a.dir, &["rev-parse", "HEAD~1"]), tip);
    assert_eq!(run(&a.dir, &["status", "--porcelain"]), "");
    assert_eq!(run(&hub.bare(&a.repo), &["rev-parse", "main"]), tip, "GitHub doesn't have it");

    // The same skill pressed again, unchanged: the kept commit goes up by
    // the same push (a fast-forward), so it is added — not "already there".
    let again = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "slow", &files("s2", "slow"), None, None, "a Mac", 3).unwrap();
    assert!(matches!(again, Published::Published { set_aside: None, .. }), "{again:?}");
    assert_eq!(run(&hub.bare(&a.repo), &["rev-parse", "main"]), held, "the kept commit, fast-forwarded");
    assert!(on_github(&hub, &a.repo, "library/claude/mine/skills/slow/SKILL.md").contains("s2"));

    // Kept again, then another skill: both go in one fast-forward.
    assert!(matches!(kept_press(&hub, &w, &a.dir, &a.repo, "slow", "s3", 4), Published::Kept { .. }));
    let other = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "quick", &files("q", "quick"), None, None, "a Mac", 5).unwrap();
    assert!(matches!(other, Published::Published { .. }), "{other:?}");
    assert_eq!(run(&hub.bare(&a.repo), &["rev-parse", "main"]), run(&a.dir, &["rev-parse", "HEAD"]));
    assert!(on_github(&hub, &a.repo, "library/claude/mine/skills/slow/SKILL.md").contains("s3"));
    assert!(on_github(&hub, &a.repo, "library/claude/mine/skills/quick/SKILL.md").contains("q"));
    // The kept version is this computer's base: an edit of it is no compare.
    let edited = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "slow", &files("s4", "slow"), None, None, "a Mac", 6).unwrap();
    assert!(matches!(edited, Published::Published { .. }), "{edited:?}");
}

/// 1.176.4 review (S3): the one read after a stopped push failing (here
/// GitHub's side of `ls-remote` can't run) counts as not landed: kept.
#[test]
fn a_read_that_fails_after_a_stopped_push_keeps_the_commit() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    let a = create_with(&hub, &w.mac_a, "plyloft-skills", &[]).unwrap();
    let tip = run(&a.dir, &["rev-parse", "HEAD"]);
    let config = a.dir.join(".git").join("config");
    // During the push, the read's upload-pack is made one that fails.
    set_hook(
        &hub,
        &a.repo,
        "pre-receive",
        &format!("#!/bin/sh\ngit config --file '{}' remote.origin.uploadpack false\nsleep 6\nexit 1\n", config.display()),
    );
    TEST_GIT_TIMEOUT.with(|t| t.set(Some(std::time::Duration::from_secs(2))));
    let out = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "r", &files("r", "r"), None, None, "a Mac", 1);
    TEST_GIT_TIMEOUT.with(|t| t.set(None));
    assert_eq!(run(&a.dir, &["config", "--get", "remote.origin.uploadpack"]), "false", "the read failed");
    run(&a.dir, &["config", "--unset", "remote.origin.uploadpack"]);
    assert!(matches!(out, Ok(Published::Kept { .. })), "{out:?}");
    assert_eq!(run(&a.dir, &["rev-parse", "HEAD~1"]), tip, "kept");
    assert_eq!(run(&hub.bare(&a.repo), &["rev-parse", "main"]), tip);
}

/// 1.176.4 review (M1): a kept commit and GitHub moved meanwhile (the other
/// computer published) is never a dead end. The press sets the kept commit
/// aside (a backup ref; nothing deleted, nothing forced), goes back to
/// GitHub's copy with the base before it, says so, and goes on: the pressed
/// skill is added, or — the same skill changed there — the compare.
#[test]
fn a_kept_commit_and_github_moved_meanwhile_is_set_aside_and_the_press_goes_on() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    let a = create_with(&hub, &w.mac_a, "plyloft-skills", &[]).unwrap();
    let b = use_with(&hub, &w.mac_b, &a.repo, None).unwrap();
    publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "shared", &files("v1", "shared"), None, None, "a Mac", 1).unwrap();
    let v1 = base_of(&w.mac_a, &a.repo, "shared").unwrap();
    assert!(matches!(kept_press(&hub, &w, &a.dir, &a.repo, "mine", "m", 2), Published::Kept { .. }));
    assert!(matches!(kept_press(&hub, &w, &a.dir, &a.repo, "shared", "v2", 3), Published::Kept { .. }));
    let held = run(&a.dir, &["rev-parse", "HEAD"]);
    publish_on_b(&hub, &w, &b.dir, &a.repo, "shared", "v3", 4);
    publish_with(&hub, &w.mac_b, &b.dir, &a.repo, "theirs", &files("t", "theirs"), None, None, "a PC", 5).unwrap();
    let github = run(&hub.bare(&a.repo), &["rev-parse", "main"]);

    // Another skill: set aside, then added on GitHub's copy.
    let out = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "other", &files("o", "other"), None, None, "a Mac", 6).unwrap();
    let Published::Published { set_aside: Some(words), .. } = &out else { panic!("{out:?}") };
    assert!(words.contains("`mine` and `shared`") && words.contains("went back to GitHub's copy"), "{words}");
    let refs = backups(&a.dir);
    assert_eq!(refs.len(), 1, "{refs:?}");
    assert!(refs[0].starts_with(&held), "{refs:?}");
    // Round 2 (R2-S1): no ref, no path, no git output in the words.
    assert!(words.contains("Plyloft keeps a copy of it on") && !words.contains("refs/") && !words.contains('/'), "{words}");
    assert_eq!(run(&hub.bare(&a.repo), &["rev-parse", "main~1"]), github, "on GitHub's tip, never forced");
    assert!(on_github(&hub, &a.repo, "library/claude/mine/skills/theirs/SKILL.md").contains("t"));
    assert!(run(&hub.bare(&a.repo), &["ls-tree", "-r", "--name-only", "main"]).contains("skills/other/SKILL.md"));
    assert!(!run(&hub.bare(&a.repo), &["ls-tree", "-r", "--name-only", "main"]).contains("skills/mine/"));
    assert_eq!(base_of(&w.mac_a, &a.repo, "mine"), None, "no base: it never was on GitHub");
    assert_eq!(base_of(&w.mac_a, &a.repo, "shared").as_deref(), Some(v1.as_str()), "back to the version before it");

    // The same skill the other computer changed: the compare, not a push.
    let compare = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "shared", &files("v2", "shared"), None, None, "a Mac", 7).unwrap();
    assert!(matches!(compare, Published::Compare { set_aside: None, .. }), "{compare:?}");
    // The set-aside one, added again: no compare (it is new there).
    let mine = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "mine", &files("m", "mine"), None, None, "a Mac", 8).unwrap();
    assert!(matches!(mine, Published::Published { .. }), "{mine:?}");
}

/// 1.176.4 review (M1, S3): GitHub refuses a kept commit for good (not the
/// time limit, not a race): set aside, said, and the next press is free —
/// whether the refusal met the same skill pressed again or another one.
#[test]
fn a_kept_commit_github_refuses_is_set_aside() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    let a = create_with(&hub, &w.mac_a, "plyloft-skills", &[]).unwrap();
    let tip = run(&a.dir, &["rev-parse", "HEAD"]);
    let refuse = "#!/bin/sh\necho 'push declined: secret found' >&2\nexit 1\n";

    // The same skill pressed again.
    assert!(matches!(kept_press(&hub, &w, &a.dir, &a.repo, "k", "k1", 1), Published::Kept { .. }));
    let held = run(&a.dir, &["rev-parse", "HEAD"]);
    set_hook(&hub, &a.repo, "pre-receive", refuse);
    let refused = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "k", &files("k1", "k"), None, None, "a Mac", 2).unwrap_err();
    assert!(refused.contains("GitHub didn't take the push of `k`") && refused.contains("went back to GitHub's copy"), "{refused}");
    assert!(!refused.contains("secret found") && !refused.contains("refs/"), "git's words and the ref go to the log: {refused}");
    assert_eq!(run(&a.dir, &["rev-parse", "HEAD"]), tip, "GitHub's copy");
    assert!(backups(&a.dir).iter().any(|r| r.starts_with(&held)), "kept aside");
    assert_eq!(base_of(&w.mac_a, &a.repo, "k"), None);
    assert_eq!(run(&hub.bare(&a.repo), &["rev-parse", "main"]), tip);

    // Another skill: this press's commit undone, the kept one set aside.
    set_hook(&hub, &a.repo, "pre-receive", "#!/bin/sh\nexit 0\n");
    assert!(matches!(kept_press(&hub, &w, &a.dir, &a.repo, "k", "k2", 3), Published::Kept { .. }));
    set_hook(&hub, &a.repo, "pre-receive", refuse);
    let refused = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "n", &files("n", "n"), None, None, "a Mac", 4).unwrap_err();
    // Round 2 (R2-S2): every skill the push carried, the pressed one too.
    assert!(refused.contains("GitHub didn't take the push of `k` and `n`"), "{refused}");
    assert_eq!(run(&a.dir, &["rev-parse", "HEAD"]), tip);
    assert_eq!(run(&a.dir, &["status", "--porcelain"]), "");

    // Refused with nothing kept: undone, said as before.
    let plain = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "n", &files("n", "n"), None, None, "a Mac", 5).unwrap_err();
    assert!(!plain.contains("kept aside"), "{plain}");
    assert_eq!(run(&a.dir, &["rev-parse", "HEAD"]), tip);
    // And free again once GitHub takes it.
    set_hook(&hub, &a.repo, "pre-receive", "#!/bin/sh\nexit 0\n");
    let k = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "k", &files("k2", "k"), None, None, "a Mac", 6).unwrap();
    assert!(matches!(k, Published::Published { .. }), "{k:?}");
}

/// 1.176.4 review (S3): with a kept commit, a press that ends in the compare
/// or in *Keep the other's*, and any pull (a read, *Read it again*), push
/// nothing.
#[test]
fn a_kept_commit_goes_only_with_a_press_whose_push_goes_through() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    let a = create_with(&hub, &w.mac_a, "plyloft-skills", &[]).unwrap();
    let b = use_with(&hub, &w.mac_b, &a.repo, None).unwrap();
    publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "y", &files("y1", "y"), None, None, "a Mac", 1).unwrap();
    publish_on_b(&hub, &w, &b.dir, &a.repo, "y", "y2", 2);
    assert!(matches!(kept_press(&hub, &w, &a.dir, &a.repo, "x", "x", 3), Published::Kept { .. }));
    let held = run(&a.dir, &["rev-parse", "HEAD"]);
    let github = run(&hub.bare(&a.repo), &["rev-parse", "main"]);
    assert_eq!(run(&a.dir, &["rev-parse", "HEAD~1"]), github);

    assert!(matches!(pull_with(&hub, &a.dir, &a.repo), Pulled::Pulled(_)));
    let compare = match publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "y", &files("y3", "y"), None, None, "a Mac", 4).unwrap() {
        Published::Compare { compare, .. } => compare,
        other => panic!("{other:?}"),
    };
    let kept = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "y", &files("y3", "y"), Some(Choice::KeepOther), Some(&compare.other_id), "a Mac", 5).unwrap();
    assert!(matches!(kept, Published::KeptOther { .. }), "{kept:?}");
    assert!(matches!(pull_with(&hub, &a.dir, &a.repo), Pulled::Pulled(_)));
    assert_eq!(run(&hub.bare(&a.repo), &["rev-parse", "main"]), github, "nothing pushed");
    assert_eq!(run(&a.dir, &["rev-parse", "HEAD"]), held, "still kept");
}

/// 1.176.4 review (S1): only Plyloft's own kept commits go to GitHub. A
/// commit made in the clone by hand stops every push, with words; nothing
/// is pushed or undone.
#[test]
fn a_commit_plyloft_didnt_make_is_never_pushed() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    let a = create_with(&hub, &w.mac_a, "plyloft-skills", &[]).unwrap();
    publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "s", &files("s", "s"), None, None, "a Mac", 1).unwrap();
    let github = run(&hub.bare(&a.repo), &["rev-parse", "main"]);
    std::fs::write(a.dir.join("notes.txt"), "mine").unwrap();
    run(&a.dir, &["add", "notes.txt"]);
    run(&a.dir, &["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgSign=false", "commit", "-q", "-m", "by hand"]);
    let hand = run(&a.dir, &["rev-parse", "HEAD"]);
    for (skill, body) in [("s", "s"), ("t", "t")] {
        let refused = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, skill, &files(body, skill), None, None, "a Mac", 2).unwrap_err();
        assert!(refused.contains("holds a commit Plyloft didn't make") && !refused.contains("by hand") && !refused.contains('/'), "{refused}");
        assert_eq!(run(&hub.bare(&a.repo), &["rev-parse", "main"]), github, "nothing pushed");
        assert_eq!(run(&a.dir, &["rev-parse", "HEAD"]), hand, "nothing undone");
        assert_eq!(run(&a.dir, &["status", "--porcelain"]), "");
    }
}

/// 1.176.4 review (S2): the window reads every answer in camel case.
#[test]
fn the_answers_read_in_camel_case_needs_ok_included() {
    let kept = serde_json::to_value(Published::Kept { skill: "x".into(), words: "w".into(), needs_ok: true, asks: None, set_aside: Some("a".into()) }).unwrap();
    assert_eq!(kept, serde_json::json!({"kind": "kept", "skill": "x", "words": "w", "needsOk": true, "setAside": "a"}));
    let published = serde_json::to_value(Published::Published { skill: "x".into(), commit: "c".into(), needs_ok: true, asks: None, windows: None, set_aside: None }).unwrap();
    assert_eq!(published, serde_json::json!({"kind": "published", "skill": "x", "commit": "c", "needsOk": true}));
}

#[test]
fn a_deleted_repo_is_gone_the_last_copy_stays_and_create_it_again_works() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    let review = skill_dir(&w.home, "my-review", "v1");
    let a = create_with(&hub, &w.mac_a, "plyloft-skills", &[("my-review".into(), review)]).unwrap();
    assert!(matches!(pull_with(&hub, &a.dir, &a.repo), Pulled::Pulled(Some(_))));
    std::fs::remove_dir_all(hub.bare(&a.repo)).unwrap();
    // A vanished local path is git's "does not appear to be a git
    // repository", not GitHub's "Repository not found": the fetch fails;
    // GitHub's own sentence is judged below.
    assert!(!matches!(pull_with(&hub, &a.dir, &a.repo), Pulled::Pulled(_)));
    assert!(is_not_found("remote: Repository not found.\nfatal: repository 'https://github.com/matteo/plyloft-skills.git/' not found"));
    let mut lib = crate::skills_hub_state::LibraryState::default();
    record_pull(&mut lib, &Pulled::Gone, 10);
    assert_eq!((lib.gone_at, lib.last_error.as_deref()), (Some(10), Some("gone")));
    record_pull(&mut lib, &Pulled::Gone, 20);
    assert_eq!(lib.gone_at, Some(10), "the first time stays");
    // The last copy keeps serving: the clone and its skill are there.
    let delivered = crate::library_snapshot::deliver(&w.mac_a, &a.dir, crate::library_snapshot::Half::Claude, options()).unwrap();
    assert!(delivered.library.skills.iter().any(|s| s.name == "my-review"));
    // Create it again: the private repository again, this Mac's clone in it.
    recreate_with(&hub, &a.dir, &a.repo).expect("created again");
    assert_eq!(hub.created.borrow().len(), 2);
    assert!(matches!(pull_with(&hub, &a.dir, &a.repo), Pulled::Pulled(Some(_))));
    record_pull(&mut lib, &Pulled::Pulled(Some("abc".into())), 30);
    assert_eq!((lib.gone_at, lib.last_error.as_deref()), (None, None));
    assert!(run(&hub.bare(&a.repo), &["ls-tree", "-r", "--name-only", "main"]).contains("skills/my-review/SKILL.md"));
    // On GitHub again: nothing to create.
    assert!(recreate_with(&hub, &a.dir, &a.repo).unwrap_err().contains("is on GitHub again"));
}

#[test]
fn sessions_get_my_library_as_the_plugin_mine_from_a_snapshot() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    let review = skill_dir(&w.home, "my-review", "v1");
    let a = create_with(&hub, &w.mac_a, "plyloft-skills", &[("my-review".into(), review)]).unwrap();
    let claude = crate::library_snapshot::deliver(&w.mac_a, &a.dir, crate::library_snapshot::Half::Claude, options()).unwrap();
    assert_eq!(claude.library.claude_plugins.len(), 1);
    assert_eq!(claude.library.claude_plugins[0].0, PLUGIN);
    assert!(claude.library.claude_plugin_dirs[0].starts_with(w.mac_a.join("skills_hub").join("sessions")));
    assert!(claude.library.skills.iter().any(|s| s.name == "my-review" && s.plugin == PLUGIN));
    let codex = crate::library_snapshot::deliver(&w.mac_a, &a.dir, crate::library_snapshot::Half::Codex, options()).unwrap();
    let market = codex.library.codex.expect("a marketplace");
    assert_eq!(market.name, MARKETPLACE);
    assert_eq!(market.plugins[0].name, PLUGIN);
    // Beside a team plugin called `mine`, it is `mine-<login>`.
    assert_eq!(delivered_name(&["ply-team".into()], &a.repo), "mine");
    assert_eq!(delivered_name(&["mine".into()], &a.repo), "mine-matteo");
    let renamed = renamed_snapshot(&claude.library.claude_plugin_dirs[0], false, "mine-matteo").unwrap();
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(renamed.join(".claude-plugin").join("plugin.json")).unwrap()).unwrap();
    assert_eq!(manifest["name"], "mine-matteo");
    assert!(renamed.join("skills").join("my-review").join("SKILL.md").is_file());
    let read = crate::team_skills::read_snapshot_library(vec![("x".into(), renamed.clone())], None);
    assert_eq!(read.claude_plugins[0].0, "mine-matteo");
    let codex_renamed = renamed_snapshot(&market.root, true, "mine-matteo").unwrap();
    let read = crate::team_skills::read_snapshot_library(Vec::new(), Some(&codex_renamed));
    let market = read.codex.expect("renamed marketplace");
    assert_eq!(market.plugins[0].name, "mine-matteo");
    assert!(read.skills.iter().any(|s| s.name == "my-review" && s.plugin == "mine-matteo"));
    // Stamped, so the prune keeps it while it is used.
    let name = renamed.file_name().unwrap().to_string_lossy().into_owned();
    assert!(renamed.parent().unwrap().join(format!("{name}.last-used")).is_file());
}

#[test]
fn a_script_in_a_my_library_skill_asks_for_its_own_ok() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    let a = create_with(&hub, &w.mac_a, "plyloft-skills", &[]).unwrap();
    assert!(is_clone(&a.dir));
    assert_eq!(crate::skill_scripts::library_id(&a.dir), "library:matteo/plyloft-skills");
    assert_eq!(crate::skill_scripts::place_words(&a.dir), "My library");
    let mut with_script = files("checks", "check");
    with_script.push(SourceFile { path: "scripts/check.sh".into(), bytes: b"#!/bin/sh\necho ok\n".to_vec(), executable: true });
    publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "check", &with_script, None, None, "a Mac", 1).unwrap();
    let state = crate::skills_hub_state::load(&w.mac_a);
    let held = crate::skill_scripts::needs_ok(&a.dir, &state).unwrap();
    assert_eq!(held.len(), 1);
    assert_eq!((held[0].plugin.as_str(), held[0].skill.as_str()), ("mine", "check"));
    assert!(crate::skill_scripts::inbox_id(&a.dir, &held[0]).starts_with("skill:library:matteo/plyloft-skills/mine/check:needs-ok:"));
    assert_eq!(crate::skill_scripts::needs_ok_detail_in(&held[0], "My library"), "It brings a script from My library");
    // Until the OK, new sessions don't get it.
    let delivered = crate::library_snapshot::deliver(&w.mac_a, &a.dir, crate::library_snapshot::Half::Claude, options()).unwrap();
    assert!(!delivered.library.skills.iter().any(|s| s.name == "check"));
    // The team's words are unchanged.
    assert_eq!(crate::skill_scripts::library_id(Path::new("/x/team/acme__team")), "team:acme/team");
}

#[test]
fn plain_words_for_github_answers() {
    assert!(is_offline("fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com"));
    assert!(!is_offline("remote: Repository not found."));
    assert!(is_not_found("remote: Repository not found.\nfatal: repository 'https://github.com/x/y.git/' not found"));
    assert_eq!(
        repo_missing_or_offline("GraphQL: Could not resolve to a Repository with the name 'x/y'. (repository)"),
        Ok(RepoState::Missing)
    );
    assert_eq!(repo_missing_or_offline("error connecting to api.github.com"), Err(OFFLINE_WORDS.to_string()));
    assert_eq!(parse_scopes("'gist', 'read:org', 'repo'"), vec!["gist", "read:org", "repo"]);
    assert!(network_words(
        "add `x` to My library",
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
    )
    .contains(crate::team::SIGN_IN_MARKER));
    assert!(network_words("add `x` to My library", "Could not resolve host: github.com").starts_with(OFFLINE_WORDS));
    assert!(account_words("test-user", "x").contains("My library uses the GitHub account test-user"));
}

/// Hard rules 3 and 4, and the scoped push exception, pinned to the source:
/// every network git of My library is bounded in the exit registry, no push
/// is ever forced, and every command runs on the blocking pool behind its
/// gate.
#[test]
fn network_git_is_bounded_never_forced_and_open_on_every_plan() {
    let source = include_str!("my_library.rs");
    let body = source.split("#[cfg(test)]").next().unwrap();
    assert!(body.contains("run_bounded_network_git_in(dir, &configured, git_timeout(), crate::worktrees::exit_registry())"));
    // The release bound is still GIT_TIMEOUT; the read after a stopped push
    // has its own short one (1.176.3 review S1, S4).
    assert!(body.contains("#[cfg(not(test))]\nfn git_timeout() -> std::time::Duration {\n    GIT_TIMEOUT\n}"));
    assert!(body.contains("run_bounded_output(&mut cmd, landed_read_timeout())"));
    assert_eq!(landed_read_timeout(), std::time::Duration::from_secs(25));
    assert!(landed_read_timeout() < GIT_TIMEOUT);
    assert!(!body.contains("\"--force"));
    assert!(!body.contains("\"-f\""));
    for command in [
        "my_library_status",
        "my_library_find",
        "my_library_create",
        "my_library_use",
        "my_library_forget",
        "my_library_recreate",
        "my_library_pull_now",
        "my_library_publish",
    ] {
        let (_, rest) = body.split_once(&format!("pub async fn {command}(")).expect(command);
        let head = rest.split("\n}\n").next().unwrap();
        assert!(head.contains("spawn_blocking"), "{command} runs on the blocking pool");
    }
    // My library is open on every plan: no command, no pull and no view
    // reads the licence.
    assert!(!body.contains("LicenseStore"), "no plan gate in My library");
}

/// The view the window reads carries no plan field.
#[test]
fn the_view_carries_no_plan_field() {
    let wire = serde_json::to_value(super::MyLibraryView::default()).unwrap();
    assert!(wire.get("proAllowed").is_none() && wire.get("heldBack").is_none(), "{wire}");
    assert!(wire.get("repo").is_some(), "{wire}");
}

#[test]
fn the_window_names_its_sources_and_reads_the_answers_in_camel_case() {
    let source: PublishSource = serde_json::from_str(r#"{"kind":"repository","workspaceId":"ws-1","skill":"x"}"#).unwrap();
    assert!(matches!(source, PublishSource::Repository { ref workspace_id, .. } if workspace_id == "ws-1"));
    let source: PublishSource = serde_json::from_str(r#"{"kind":"thisMac","skill":"x"}"#).unwrap();
    assert!(matches!(source, PublishSource::ThisMac { .. }));
    let choice: Choice = serde_json::from_str(r#""keepOther""#).unwrap();
    assert_eq!(choice, Choice::KeepOther);
    let out = serde_json::to_value(Published::AlreadyThere { skill: "x".into(), set_aside: None }).unwrap();
    assert_eq!(out, serde_json::json!({"kind": "alreadyThere", "skill": "x"}));
}

/// The refusal leads the window answers with a button (*Grant it*, *Use it
/// on this Mac*) and the offline words are the same on both sides.
#[test]
fn the_frontend_knows_every_my_library_lead() {
    let ts = include_str!("../../src/lib/myLibrary.ts");
    for lead in [GRANT_MARKER, ALREADY_A_LIBRARY_MARKER, OFFLINE_WORDS] {
        assert!(ts.contains(&format!("\"{lead}\"")), "myLibrary.ts lacks {lead}");
    }
}

/// Challenger (§14 Q5, the scoped push exception): My library is a
/// repository of the account's own login — *Use one you have…* refuses an
/// organisation's or someone else's repository and the team library, so a
/// publish can never push anywhere else; every push first finds the clone's
/// fetch *and* push URL naming My library's repository, and pushes the branch
/// by an explicit refspec without `+`.
#[test]
fn my_library_is_the_accounts_own_repository_and_pushes_only_there() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    let a = create_with(&hub, &w.mac_a, "plyloft-skills", &[]).unwrap();
    // Someone else's, an organisation's, the team library.
    let other = use_with(&hub, &w.mac_b, "acme/plyloft-skills", None).unwrap_err();
    assert!(other.contains("belongs to acme, not to matteo"), "{other}");
    let team = use_with(&hub, &w.mac_b, "Matteo/plyloft-skills", Some("matteo/plyloft-skills")).unwrap_err();
    assert!(team.contains("is your team's library"), "{team}");
    assert!(!w.mac_b.join("my-library").join("matteo__plyloft-skills").exists());
    assert_eq!(ownership_problem("Matteo/x", "matteo", Some("acme/team")), None);

    // A clone whose push URL was pointed elsewhere: nothing is pushed.
    let elsewhere = hub.url("matteo/elsewhere");
    run(&a.dir, &["remote", "set-url", "--push", "origin", &elsewhere]);
    let tip = run(&a.dir, &["rev-parse", "HEAD"]);
    let refused = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "x", &files("x", "x"), None, None, "a Mac", 1).unwrap_err();
    assert!(refused.contains("points somewhere other than `matteo/plyloft-skills`"), "{refused}");
    assert_eq!(run(&a.dir, &["rev-parse", "HEAD"]), tip, "nothing committed");
    assert!(recreate_with(&hub, &a.dir, &a.repo).unwrap_err().contains("points somewhere other"));
    run(&a.dir, &["config", "--unset", "remote.origin.pushurl"]);
    // A member's own push config (a forcing refspec, `matching`) is ignored:
    // the branch goes by the explicit refspec.
    run(&a.dir, &["config", "remote.origin.push", "+refs/heads/*:refs/heads/other-*"]);
    let published = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "x", &files("x", "x"), None, None, "a Mac", 2).unwrap();
    assert!(matches!(published, Published::Published { .. }), "{published:?}");
    let heads = run(&hub.bare(&a.repo), &["for-each-ref", "--format=%(refname)", "refs/heads"]);
    assert_eq!(heads, "refs/heads/main", "only the branch itself: {heads}");
    assert!(names_repo("git@github.com:Matteo/plyloft-skills.git", "https://github.com/matteo/plyloft-skills.git", "matteo/plyloft-skills"));
    assert!(!names_repo("https://github.com/acme/team.git", "https://github.com/matteo/plyloft-skills.git", "matteo/plyloft-skills"));
    let source = include_str!("my_library.rs");
    let body = source.split("#[cfg(test)]").next().unwrap();
    assert_eq!(body.matches("network_git_outcome(clone, &[\"push\"").count(), 1, "one push of a clone, push_branch");
    assert_eq!(body.matches("network_git(clone, &[\"push\"").count(), 0, "no other push of a clone");
    assert!(body.contains("let refspec = format!(\"HEAD:refs/heads/{}\", branch(clone));"));
}

/// Challenger: *Keep the other's* pressed twice is kept, not an error; and a
/// pull whose account couldn't sign in is a sign-in problem, never "gone".
#[test]
fn keep_the_others_twice_and_a_signed_out_account() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    let a = create_with(&hub, &w.mac_a, "plyloft-skills", &[]).unwrap();
    let b = use_with(&hub, &w.mac_b, &a.repo, None).unwrap();
    publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "s", &files("v1", "s"), None, None, "a Mac", 1).unwrap();
    let Published::Compare { compare, .. } =
        publish_with(&hub, &w.mac_b, &b.dir, &a.repo, "s", &files("v2", "s"), None, None, "a PC", 2).unwrap()
    else {
        panic!("the compare")
    };
    for at in [3, 4] {
        let kept = publish_with(&hub, &w.mac_b, &b.dir, &a.repo, "s", &files("v2", "s"), Some(Choice::KeepOther), Some(&compare.other_id), "a PC", at).unwrap();
        assert!(matches!(kept, Published::KeptOther { .. }), "{kept:?}");
    }
    let mut lib = crate::skills_hub_state::LibraryState::default();
    record_pull(&mut lib, &Pulled::SignIn, 5);
    assert_eq!((lib.last_error.as_deref(), lib.gone_at), (Some("signIn"), None));
    let words = network_words(
        "add `s` to My library",
        &format!("git fetch: {}", account_words("test-user", "x")),
    );
    assert!(words.starts_with("My library uses the GitHub account test-user"), "{words}");
}

/// H10 Windows walk (§8): a skill whose session snapshot paths would pass
/// Windows' limit is named with the snapshot's own words before it is added
/// (refused on Windows; a Mac's toast says a PC won't get it), and the index
/// marks it on a computer whose snapshots leave it out.
#[test]
fn a_skill_too_long_for_windows_is_said_before_and_on_the_row() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    let a = create_with(&hub, &w.mac_a, "plyloft-skills", &[]).unwrap();
    let deep = format!("{}/SKILL.md", ["a-rather-long-folder-name"; 8].join("/"));
    let long = vec![SourceFile { path: deep.clone(), bytes: b"x\n".to_vec(), executable: false }];
    let windows = Path::new(WINDOWS_CONFIG_ESTIMATE);
    let words = too_long_for_windows(windows, &a.dir, "walk-long", &long).expect("too long");
    assert!(words.starts_with(&format!("`walk-long`: {}", crate::library_snapshot::PATH_TOO_LONG)), "{words}");
    assert!(words.contains(&deep), "{words}");
    assert_eq!(too_long_for_windows(windows, &a.dir, "walk-long", &files("x", "walk-long")), None);
    // On Windows the publish itself refuses it, before anything is written:
    // the snapshot half below needs it published, so it runs elsewhere.
    if cfg!(windows) {
        let head = run(&a.dir, &["rev-parse", "HEAD"]);
        let refused = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "walk-long", &long, None, None, "a PC", 1)
            .expect_err("Windows refuses it");
        assert!(refused.starts_with(&format!("`walk-long`: {}", crate::library_snapshot::PATH_TOO_LONG)), "{refused}");
        assert!(refused.ends_with("Nothing was published."), "{refused}");
        assert_eq!(run(&a.dir, &["rev-parse", "HEAD"]), head, "no commit");
        assert!(!a.dir.join("library/claude/mine/skills/walk-long").exists(), "no file");
        return;
    }
    // The measure is the snapshot's own: the same skill in My library is left
    // out of a limited snapshot, and the index names it.
    publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "walk-long", &long, None, None, "a Mac", 1).unwrap();
    let (_, units) = crate::library_snapshot::delivered_path(&w.mac_a, &a.dir, &format!("library/claude/mine/skills/walk-long/{deep}")).unwrap();
    let limited = crate::library_snapshot::Options { path_limit: Some(units - 1), cap_bytes: crate::library_snapshot::CAP_BYTES };
    let delivered = crate::library_snapshot::deliver(&w.mac_a, &a.dir, crate::library_snapshot::Half::Claude, limited).unwrap();
    assert!(!delivered.library.skills.iter().any(|s| s.name == "walk-long"));
    assert!(delivered.library.errors.iter().any(|e| e.contains("`walk-long`") && e.contains(crate::library_snapshot::PATH_TOO_LONG)));
    let marked = crate::library_snapshot::skills_too_long_here(&w.mac_a, &a.dir, limited);
    assert_eq!(marked.into_iter().collect::<Vec<_>>(), vec!["walk-long".to_string()]);
    assert!(crate::library_snapshot::skills_too_long_here(&w.mac_a, &a.dir, options()).is_empty());
    // Windows refuses it before anything is written.
    let source = include_str!("my_library.rs");
    let body = source.split("#[cfg(test)]").next().unwrap();
    let publish = body.split_once("pub(crate) fn publish_with(").unwrap().1;
    let check = publish.find("too_long_for_windows(config_dir, clone, &skill, files)").expect("checked");
    assert!(check < publish.find("lock().lock()").unwrap(), "before anything is written");
}

/// F2: My library's commits are Plyloft's own — a member's global signing
/// or hooks never ask or refuse there — and read `chore(library): …`.
#[test]
fn my_library_commits_skip_signing_and_hooks_and_are_chore_library() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    let a = create_with(&hub, &w.mac_a, "plyloft-skills", &[]).unwrap();
    assert_eq!(run(&a.dir, &["log", "-1", "--format=%s"]), "chore(library): create My library");

    // Signing on with a key program that can't run, and hooks that refuse.
    let hooks = w.root.join("hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    for name in ["pre-commit", "prepare-commit-msg", "commit-msg"] {
        let hook = hooks.join(name);
        std::fs::write(&hook, "#!/bin/sh\necho refused by the hook >&2\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
    run(&a.dir, &["config", "commit.gpgSign", "true"]);
    run(&a.dir, &["config", "gpg.program", &w.root.join("no-such-gpg").to_string_lossy()]);
    run(&a.dir, &["config", "core.hooksPath", &hooks.to_string_lossy()]);
    // The way git itself would commit here: refused.
    std::fs::write(a.dir.join("scratch.txt"), "x").unwrap();
    let plain = crate::platform::git_command()
        .args(["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "x"])
        .current_dir(&a.dir)
        .output()
        .unwrap();
    assert!(!plain.status.success(), "the setup must bite");
    std::fs::remove_file(a.dir.join("scratch.txt")).unwrap();

    let published = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "sql-style", &files("v1", "sql-style"), None, None, "a Mac", 1).unwrap();
    assert!(matches!(published, Published::Published { .. }), "{published:?}");
    assert_eq!(run(&a.dir, &["log", "-1", "--format=%s|%G?"]), "chore(library): add sql-style from a Mac|N");
    assert!(on_github(&hub, &a.repo, "library/claude/mine/skills/sql-style/SKILL.md").contains("v1"));
}

/// 1.176.4 review round 2 (R2-M1): a kept commit whose skill or file name
/// isn't ASCII is Plyloft's own all the same, and goes with the next press.
#[test]
fn a_kept_commit_with_a_non_ascii_name_goes_with_the_next_press() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    let a = create_with(&hub, &w.mac_a, "plyloft-skills", &[]).unwrap();
    let mut caffe = files("c", "caffè");
    caffe.push(SourceFile { path: "note-è.md".into(), bytes: b"nota\n".to_vec(), executable: false });
    set_hook(&hub, &a.repo, "pre-receive", "#!/bin/sh\nsleep 6\nexit 1\n");
    TEST_GIT_TIMEOUT.with(|t| t.set(Some(std::time::Duration::from_secs(2))));
    let kept = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "caffè", &caffe, None, None, "a Mac", 1);
    TEST_GIT_TIMEOUT.with(|t| t.set(None));
    set_hook(&hub, &a.repo, "pre-receive", "#!/bin/sh\nexit 0\n");
    assert!(matches!(kept, Ok(Published::Kept { .. })), "{kept:?}");
    let next = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "other", &files("o", "other"), None, None, "a Mac", 2);
    assert!(matches!(next, Ok(Published::Published { .. })), "{next:?}");
    assert_eq!(run(&hub.bare(&a.repo), &["rev-parse", "main"]), run(&a.dir, &["rev-parse", "HEAD"]));
    assert!(on_github(&hub, &a.repo, "library/claude/mine/skills/caffè/note-è.md").contains("nota"));
}

/// Round 2 (R2-S3): GitHub moved while a commit was kept, and a tracked file
/// in the clone was edited by hand: nothing is reset, nothing set aside,
/// the edit stays, and the words say why.
#[test]
fn a_clone_with_edits_is_never_reset_to_set_commits_aside() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    let a = create_with(&hub, &w.mac_a, "plyloft-skills", &[]).unwrap();
    let b = use_with(&hub, &w.mac_b, &a.repo, None).unwrap();
    publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "s", &files("s", "s"), None, None, "a Mac", 1).unwrap();
    assert!(matches!(kept_press(&hub, &w, &a.dir, &a.repo, "k", "k", 2), Published::Kept { .. }));
    let held = run(&a.dir, &["rev-parse", "HEAD"]);
    publish_on_b(&hub, &w, &b.dir, &a.repo, "t", "t", 3);
    let edited = a.dir.join("library/claude/mine/skills/s/SKILL.md");
    std::fs::write(&edited, "edited by hand\n").unwrap();
    let refused = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "o", &files("o", "o"), None, None, "a Mac", 4).unwrap_err();
    assert!(refused.contains("has changes to its files that aren't in a commit"), "{refused}");
    assert_eq!(run(&a.dir, &["rev-parse", "HEAD"]), held, "nothing reset");
    assert_eq!(std::fs::read_to_string(&edited).unwrap(), "edited by hand\n", "the edit stays");
    assert!(backups(&a.dir).is_empty(), "nothing set aside");
}

/// Round 2 (R2-S4): what counts as GitHub refusing the push, so kept commits
/// are set aside — and what is a passing answer, kept like any failure.
#[test]
fn only_a_real_refusal_sets_kept_commits_aside() {
    for refused in [
        "! [remote rejected] main -> main (pre-receive hook declined)",
        "remote: error: GH013: Repository rule violations found for refs/heads/main.\n ! [remote rejected] main -> main (push declined due to repository rule violations)",
        "remote: error: GH009: Secrets detected!\n ! [remote rejected] main -> main (push declined due to secret scanning)",
        "remote: Permission to matteo/plyloft-skills.git denied to someone.\nfatal: unable to access 'https://github.com/matteo/plyloft-skills.git/': The requested URL returned error: 403",
    ] {
        assert!(github_refused(refused), "{refused}");
    }
    for passing in [
        "! [remote rejected] main -> main (Internal Server Error)",
        "! [remote rejected] main -> main (failure)",
        "remote: You have exceeded a secondary rate limit.\nfatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 403",
        "GitHub didn't answer in time (`git` was stopped after 120s)",
        "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com",
        "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
        " ! [rejected]        main -> main (fetch first)",
        "Plyloft is quitting",
    ] {
        assert!(!github_refused(passing), "{passing}");
    }
}

/// Round 3 (R3-M1): an edited clone stops the press before anything can
/// reset it — here a kept commit, the normal path, and a push GitHub would
/// refuse: the edit stays, nothing is undone, reset or pushed, and the
/// words end with the way out (R3-S1).
#[test]
fn an_edited_clone_stops_the_press_before_any_reset() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    let a = create_with(&hub, &w.mac_a, "plyloft-skills", &[]).unwrap();
    publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "s", &files("s", "s"), None, None, "a Mac", 1).unwrap();
    assert!(matches!(kept_press(&hub, &w, &a.dir, &a.repo, "k", "k", 2), Published::Kept { .. }));
    let held = run(&a.dir, &["rev-parse", "HEAD"]);
    let github = run(&hub.bare(&a.repo), &["rev-parse", "main"]);
    set_hook(&hub, &a.repo, "pre-receive", "#!/bin/sh\necho 'push declined: secret found' >&2\nexit 1\n");
    let edited = a.dir.join("library/claude/mine/skills/s/SKILL.md");
    std::fs::write(&edited, "edited by hand\n").unwrap();
    let refused = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "n", &files("n", "n"), None, None, "a Mac", 3).unwrap_err();
    assert!(refused.contains("has changes to its files that aren't in a commit"), "{refused}");
    assert!(refused.ends_with(&way_out_words()), "{refused}");
    assert_eq!(std::fs::read_to_string(&edited).unwrap(), "edited by hand\n", "the edit stays");
    assert_eq!(run(&a.dir, &["rev-parse", "HEAD"]), held, "nothing undone or reset");
    assert!(backups(&a.dir).is_empty(), "nothing set aside");
    assert_eq!(run(&hub.bare(&a.repo), &["rev-parse", "main"]), github, "nothing pushed");
}

/// Round 3 (R3-S2): a push carrying kept skills that fails for a reason not
/// recognised as a refusal names them, and gives the way out; they stay kept.
#[test]
fn a_push_with_kept_skills_that_fails_otherwise_names_them() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    let a = create_with(&hub, &w.mac_a, "plyloft-skills", &[]).unwrap();
    assert!(matches!(kept_press(&hub, &w, &a.dir, &a.repo, "k", "k", 1), Published::Kept { .. }));
    let held = run(&a.dir, &["rev-parse", "HEAD"]);
    // A passing answer (R2-S4), not taken for a refusal.
    set_hook(&hub, &a.repo, "pre-receive", "#!/bin/sh\necho 'You have exceeded a secondary rate limit' >&2\nexit 1\n");
    for (skill, at) in [("k", 2), ("n", 3)] {
        let failed = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, skill, &files(skill, skill), None, None, "a Mac", at).unwrap_err();
        assert!(failed.contains("It also carried `k`, kept on this"), "{failed}");
        assert!(failed.contains("If this keeps happening, to start again") && failed.ends_with(&way_out_words()[1..]), "{failed}");
        assert_eq!(run(&a.dir, &["rev-parse", "HEAD"]), held, "still kept, this press's commit undone");
    }
}

/// The same bytes written again a second later: git can no longer trust
/// the index's stat and reads the file, as after any checkout or touch.
fn rewrite_same(path: &Path) {
    std::thread::sleep(std::time::Duration::from_millis(1100));
    std::fs::write(path, std::fs::read(path).unwrap()).unwrap();
}

fn crlf_files(name: &str, body: &str) -> Vec<SourceFile> {
    vec![SourceFile {
        path: "SKILL.md".into(),
        bytes: format!("---\r\nname: {name}\r\ndescription: {body}\r\n---\r\n{body}\r\n").into_bytes(),
        executable: false,
    }]
}

/// Coordinator's must-fix after round 3: line endings alone are no edit.
/// A clone checked out with `core.autocrlf=true` (Git for Windows' default)
/// holds CRLF working files for LF blobs; when the git that reads it later
/// has autocrlf off, every such file reads as modified. A press must not
/// stop there (a reset loses nothing), nor must the set-aside's guard; a
/// real edit, also of a CRLF file, still stops it. A CRLF blob committed
/// from another computer with autocrlf off is no edit either.
#[test]
fn line_endings_alone_never_stop_a_press() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    let a = create_with(&hub, &w.mac_a, "plyloft-skills", &[]).unwrap();
    let b = use_with(&hub, &w.mac_b, &a.repo, None).unwrap();
    run(&b.dir, &["config", "core.autocrlf", "false"]);
    publish_on_b(&hub, &w, &b.dir, &a.repo, "lf", "l", 1);
    let crlf_on_b = publish_with(&hub, &w.mac_b, &b.dir, &a.repo, "crlf", &crlf_files("crlf", "c"), None, None, "a PC", 2).unwrap();
    assert!(matches!(crlf_on_b, Published::Published { .. }), "{crlf_on_b:?}");
    // A checks them out with autocrlf on.
    run(&a.dir, &["config", "core.autocrlf", "true"]);
    assert!(matches!(pull_with(&hub, &a.dir, &a.repo), Pulled::Pulled(_)));
    let lf = a.dir.join("library/claude/mine/skills/lf/SKILL.md");
    assert!(std::fs::read(&lf).unwrap().windows(2).any(|w| w == b"\r\n"), "checked out with CRLF");
    let ok = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "one", &files("1", "one"), None, None, "a Mac", 3).unwrap();
    assert!(matches!(ok, Published::Published { .. }), "a CRLF blob under autocrlf is no edit: {ok:?}");
    // Then a git with autocrlf off reads the same clone: phantom edits.
    run(&a.dir, &["config", "core.autocrlf", "false"]);
    rewrite_same(&lf);
    let listed = run(&a.dir, &["status", "--porcelain", "--untracked-files=no"]);
    assert!(listed.contains("skills/lf/SKILL.md"), "git lists it with no edit made: {listed}");
    let ok = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "two", &files("2", "two"), None, None, "a Mac", 4).unwrap();
    assert!(matches!(ok, Published::Published { .. }), "line endings alone: {ok:?}");

    // The set-aside's guard: a kept commit, GitHub moved, phantom edits —
    // set aside and the press goes on.
    run(&a.dir, &["config", "core.autocrlf", "true"]);
    assert!(matches!(kept_press(&hub, &w, &a.dir, &a.repo, "k", "k", 5), Published::Kept { .. }));
    run(&a.dir, &["config", "core.autocrlf", "false"]);
    publish_on_b(&hub, &w, &b.dir, &a.repo, "theirs", "t", 6);
    rewrite_same(&lf);
    let lf_checked = run(&a.dir, &["status", "--porcelain", "--untracked-files=no"]);
    assert!(!lf_checked.is_empty(), "still phantom: {lf_checked}");
    let out = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "three", &files("3", "three"), None, None, "a Mac", 7).unwrap();
    assert!(matches!(out, Published::Published { set_aside: Some(_), .. }), "{out:?}");

    // A real edit of a CRLF file still stops the press, nothing reset.
    let crlf = a.dir.join("library/claude/mine/skills/crlf/SKILL.md");
    let mut bytes = std::fs::read(&crlf).unwrap();
    bytes.extend_from_slice(b"edited by hand\r\n");
    std::fs::write(&crlf, &bytes).unwrap();
    let head = run(&a.dir, &["rev-parse", "HEAD"]);
    let refused = publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "four", &files("4", "four"), None, None, "a Mac", 8).unwrap_err();
    assert!(refused.contains("has changes to its files that aren't in a commit"), "{refused}");
    assert_eq!(std::fs::read(&crlf).unwrap(), bytes, "the edit stays");
    assert_eq!(run(&a.dir, &["rev-parse", "HEAD"]), head);
}

/// What counts as an edit beyond line endings: content (also staged and
/// not in the working tree), a deleted file, a file added to the index, a
/// mode change; CR at the end of lines alone does not.
#[test]
fn an_edit_beyond_line_endings_is_read_from_the_patch() {
    let w = world();
    let hub = FakeHub::new(&w.remotes);
    let a = create_with(&hub, &w.mac_a, "plyloft-skills", &[]).unwrap();
    publish_with(&hub, &w.mac_a, &a.dir, &a.repo, "s", &files("s", "s"), None, None, "a Mac", 1).unwrap();
    let file = a.dir.join("library/claude/mine/skills/s/SKILL.md");
    let original = std::fs::read(&file).unwrap();
    let reset = || run(&a.dir, &["reset", "--quiet", "--hard", "HEAD"]);
    assert!(!edited_beyond_line_endings(&a.dir).unwrap());
    // CRLF only.
    let crlf: Vec<u8> = String::from_utf8(original.clone()).unwrap().replace('\n', "\r\n").into_bytes();
    std::fs::write(&file, &crlf).unwrap();
    assert!(!run(&a.dir, &["status", "--porcelain", "--untracked-files=no"]).is_empty());
    assert!(!edited_beyond_line_endings(&a.dir).unwrap(), "line endings alone");
    // Content, in the working tree and staged.
    std::fs::write(&file, b"other\n").unwrap();
    assert!(edited_beyond_line_endings(&a.dir).unwrap());
    run(&a.dir, &["add", "--", "library/claude/mine/skills/s/SKILL.md"]);
    std::fs::write(&file, &original).unwrap();
    assert!(edited_beyond_line_endings(&a.dir).unwrap(), "staged");
    reset();
    // Deleted; an empty file added to the index.
    std::fs::remove_file(&file).unwrap();
    assert!(edited_beyond_line_endings(&a.dir).unwrap(), "deleted");
    reset();
    std::fs::write(a.dir.join("empty.md"), b"").unwrap();
    run(&a.dir, &["add", "--", "empty.md"]);
    assert!(edited_beyond_line_endings(&a.dir).unwrap(), "added");
    run(&a.dir, &["rm", "--cached", "--quiet", "--", "empty.md"]);
    std::fs::remove_file(a.dir.join("empty.md")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(edited_beyond_line_endings(&a.dir).unwrap(), "mode");
        reset();
    }
    assert!(!edited_beyond_line_endings(&a.dir).unwrap());
}
