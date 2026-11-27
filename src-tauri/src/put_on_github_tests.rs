//! F3: *Put it on GitHub…* against a fake `gh` and a local bare `origin`
//! in temp dirs — no real GitHub call.
// The fake `gh` is a shell script: the fixture runs on Unix only.
#![cfg_attr(not(unix), allow(dead_code, unused_imports))]

use super::*;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

struct World {
    _tmp: tempfile::TempDir,
    root: PathBuf,
}

impl World {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        fs::write(
            root.join("gitconfig"),
            "[user]\n\tname = Test Person\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n",
        )
        .unwrap();
        let w = Self { _tmp: tmp, root };
        // The bare repository `gh repo create` "makes" (the fake adds it as origin).
        w.git(&w.root, &["init", "-q", "--bare", "-b", "main", "origin.git"]);
        w
    }

    fn tools(&self, gh: Option<String>) -> Tools {
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
            gh,
            path: std::env::var("PATH").unwrap_or_default(),
        }
    }

    fn git(&self, dir: &Path, args: &[&str]) -> String {
        let mut c = self.tools(None).git_in(dir);
        c.args(args);
        let ran = run(&mut c, Duration::from_secs(60)).unwrap();
        assert!(ran.ok(), "git {args:?}: {}", ran.words());
        ran.out()
    }

    /// A project on this computer with `commits` commits on `main`.
    fn project(&self, commits: usize) -> PathBuf {
        let dir = self.root.join("lyra");
        fs::create_dir_all(&dir).unwrap();
        self.git(&dir, &["init", "-q", "-b", "main"]);
        for i in 0..commits {
            fs::write(dir.join("app.txt"), format!("version {i}\n")).unwrap();
            self.git(&dir, &["add", "-A"]);
            self.git(&dir, &["commit", "-q", "-m", &format!("change {i}")]);
        }
        dir
    }

    /// This world's project id.
    fn id(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    fn origin(&self) -> PathBuf {
        self.root.join("origin.git")
    }

    /// A fake gh: `repo create` adds the bare repository as `origin` (or
    /// says the name is taken when `taken` exists); every call is logged.
    #[cfg(unix)]
    fn gh(&self) -> String {
        let script = self.root.join("gh");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{log}'\ncase \"$1 $2\" in\n  \"repo create\")\n    if [ -f '{taken}' ]; then echo 'GraphQL: Name already exists on this account (createRepository)' >&2; exit 1; fi\n    git remote add origin '{origin}' || exit 1 ;;\nesac\n",
                log = self.root.join("gh.log").display(),
                taken = self.root.join("taken").display(),
                origin = self.origin().display(),
            ),
        )
        .unwrap();
        crate::platform::set_mode(&script, 0o755).unwrap();
        script.to_string_lossy().into_owned()
    }

    fn gh_log(&self) -> Vec<String> {
        fs::read_to_string(self.root.join("gh.log")).unwrap_or_default().lines().map(str::to_string).collect()
    }

    fn origin_branches(&self) -> String {
        self.git(&self.origin(), &["for-each-ref", "--format=%(refname)", "refs/heads"])
    }

    /// A pre-receive hook on the bare origin running `body` for each push.
    #[cfg(unix)]
    fn hook(&self, body: &str) {
        let hook = self.origin().join("hooks").join("pre-receive");
        fs::write(&hook, format!("#!/bin/sh\nwhile read old new ref; do\n{body}\ndone\n")).unwrap();
        crate::platform::set_mode(&hook, 0o755).unwrap();
    }
}

fn press(w: &World, tools: &Tools, dir: &Path, name: &str, branch: &str) -> (Outcome, Vec<Progress>) {
    let mut seen = Vec::new();
    // Each world is its own project: tests run side by side (round 2: Stop
    // and the created repository are per project).
    let outcome = create_and_send(tools, dir, "octocat", Some("octocat"), name, branch, None, &mut |p| seen.push(p), &w.id());
    (outcome, seen)
}

#[cfg(unix)]
#[test]
fn f3_creates_the_private_repository_and_sends_the_branch_cards_go_to() {
    let w = World::new();
    let dir = w.project(3);
    let tools = w.tools(Some(w.gh()));
    let preview = preview(&tools, &dir, "main").unwrap();
    assert_eq!((preview.branch.as_str(), preview.commits, preview.name.as_str()), ("main", 3, "lyra"));
    assert!(w.gh_log().is_empty(), "the preview asks GitHub nothing");

    let (outcome, progress) = press(&w, &tools, &dir, "lyra", "main");
    assert_eq!(outcome, Outcome::Done { repo: "octocat/lyra".into(), branch: "main".into() });
    assert_eq!(progress.len(), 1);
    assert_eq!((progress[0].repo.as_str(), progress[0].commits), ("octocat/lyra", 3));
    // The account's own login, private, origin set, never `--push`.
    let log = w.gh_log();
    assert_eq!(log, vec!["repo create octocat/lyra --private --source . --remote origin".to_string()]);
    // The branch is on origin, with the same commit; -u tracks it.
    assert_eq!(w.origin_branches(), "refs/heads/main");
    assert_eq!(w.git(&w.origin(), &["rev-parse", "main"]), w.git(&dir, &["rev-parse", "main"]));
    assert_eq!(w.git(&dir, &["config", "branch.main.remote"]), "origin");
}

#[cfg(unix)]
#[test]
fn f3_a_taken_name_creates_nothing_and_sends_nothing() {
    let w = World::new();
    let dir = w.project(1);
    fs::write(w.root.join("taken"), "").unwrap();
    let tools = w.tools(Some(w.gh()));
    let (outcome, progress) = press(&w, &tools, &dir, "lyra", "main");
    assert_eq!(outcome, Outcome::NameTaken { name: "lyra".into() });
    assert!(progress.is_empty());
    assert!(w.origin_branches().is_empty());
    let mut remote = w.tools(None).git_in(&dir);
    remote.args(["remote"]);
    assert_eq!(run(&mut remote, Duration::from_secs(10)).unwrap().out(), "", "no origin added");
}

#[cfg(unix)]
#[test]
fn f3_a_file_over_githubs_limit_stops_it_before_anything_is_created() {
    let w = World::new();
    let dir = w.project(1);
    fs::write(dir.join("intro.mov"), vec![7u8; 4096]).unwrap();
    w.git(&dir, &["add", "-A"]);
    w.git(&dir, &["commit", "-q", "-m", "a big file"]);
    let tools = w.tools(Some(w.gh()));
    // The real limit doesn't catch 4 KB; a 1 KB limit stands in for 100 MB.
    assert_eq!(large_file_in(&tools, &dir, "main").unwrap(), None);
    assert_eq!(
        large_file_over(&tools, &dir, "main", 1024).unwrap(),
        Some(LargeFile { path: "intro.mov".into(), bytes: 4096 })
    );
    // GitHub refuses it in the push (its own words): the repository was
    // created and is empty, and that is said.
    w.hook("echo 'remote: error: GH001: Large files detected. You may want to try Git Large File Storage.' >&2\nexit 1");
    let (outcome, _) = press(&w, &tools, &dir, "lyra", "main");
    let Outcome::NotSent { repo, branch, words, .. } = outcome else { panic!("expected not sent, got {outcome:?}") };
    assert_eq!((repo.as_str(), branch.as_str()), ("octocat/lyra", "main"));
    assert!(words.contains("GH001"), "{words}");
    assert!(w.origin_branches().is_empty(), "created and empty");
}

#[cfg(unix)]
#[test]
fn f3_stop_while_sending_leaves_the_repository_empty_and_says_stopped() {
    let w = World::new();
    let dir = w.project(2);
    let tools = w.tools(Some(w.gh()));
    // The push waits in the remote's hook until Stop.
    w.hook("sleep 30");
    let id = w.id();
    let stopper = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        stop(&id)
    });
    let started = std::time::Instant::now();
    let (outcome, _) = press(&w, &tools, &dir, "lyra", "main");
    assert!(stopper.join().unwrap() >= 1, "Stop found the push");
    assert!(started.elapsed() < Duration::from_secs(20), "it didn't wait for the hook");
    assert_eq!(outcome, Outcome::Stopped { repo: "octocat/lyra".into(), branch: "main".into() });
    assert!(w.origin_branches().is_empty());

    // Send it again: only into a repository without the branch.
    fs::remove_file(w.origin().join("hooks").join("pre-receive")).unwrap();
    let again = send_again(&tools, &dir, None, "main", &mut |_| {}, &w.id());
    assert!(matches!(again, Outcome::Done { .. }), "{again:?}");
    assert_eq!(w.origin_branches(), "refs/heads/main");
    // Again with the branch there: nothing sent over it.
    let refused = send_again(&tools, &dir, None, "main", &mut |_| {}, &w.id());
    assert!(matches!(refused, Outcome::NotCreated { .. }), "{refused:?}");
}

#[cfg(unix)]
#[test]
fn f3_the_branch_cards_go_to_is_sent_whatever_branch_is_checked_out() {
    let w = World::new();
    let dir = w.project(2);
    w.git(&dir, &["checkout", "-q", "-b", "feature"]);
    fs::write(dir.join("wip.txt"), "x\n").unwrap();
    w.git(&dir, &["add", "-A"]);
    w.git(&dir, &["commit", "-q", "-m", "work in progress"]);
    let tools = w.tools(Some(w.gh()));
    let (outcome, _) = press(&w, &tools, &dir, "lyra", "main");
    assert!(matches!(outcome, Outcome::Done { .. }), "{outcome:?}");
    assert_eq!(w.origin_branches(), "refs/heads/main", "only main");
}

#[cfg(unix)]
#[test]
fn f3_a_project_that_already_has_an_origin_is_refused_and_nothing_is_asked_of_github() {
    let w = World::new();
    let dir = w.project(1);
    w.git(&dir, &["remote", "add", "origin", "https://example.com/x.git"]);
    let tools = w.tools(Some(w.gh()));
    assert!(preview(&tools, &dir, "main").is_err());
    let (outcome, _) = press(&w, &tools, &dir, "lyra", "main");
    assert!(matches!(outcome, Outcome::NotCreated { .. }), "{outcome:?}");
    assert!(w.gh_log().is_empty());
    // A name GitHub wouldn't take, and a branch with nothing: refused too.
    let w = World::new();
    let dir = w.project(1);
    let tools = w.tools(Some(w.gh()));
    assert!(matches!(press(&w, &tools, &dir, "my/repo", "main").0, Outcome::NotCreated { .. }));
    assert!(matches!(press(&w, &tools, &dir, "lyra", "release").0, Outcome::NotCreated { .. }));
    assert!(w.gh_log().is_empty());
}

#[test]
fn f3_never_forces_and_never_pushes_from_gh() {
    let source = include_str!("put_on_github.rs");
    let code = source.split("#[cfg(test)]").next().unwrap();
    assert!(!code.contains("\"--force"), "never forced");
    assert!(!code.contains("\"--push\""), "gh never pushes");
    assert!(!code.contains("\"+refs/"), "no forced refspec");
}

#[cfg(unix)]
#[test]
fn r13_cards_shipped_here_before_the_project_went_on_github_are_on_github_after() {
    let w = World::new();
    let dir = w.project(2);
    let shipped_here = w.git(&dir, &["rev-parse", "main"]);
    let tools = w.tools(Some(w.gh()));
    // Before: no origin, nothing is on GitHub.
    assert!(sent_already(&tools, &dir, &[shipped_here.clone()]).is_empty());
    let (outcome, _) = press(&w, &tools, &dir, "lyra", "main");
    assert!(matches!(outcome, Outcome::Done { .. }), "{outcome:?}");
    // After: the earlier local ship went with main.
    assert_eq!(sent_already(&tools, &dir, &[shipped_here.clone()]), vec![shipped_here.clone()]);
    // A later one shipped only here isn't, until sent.
    fs::write(dir.join("later.txt"), "x\n").unwrap();
    w.git(&dir, &["add", "-A"]);
    w.git(&dir, &["commit", "-q", "-m", "later"]);
    let later = w.git(&dir, &["rev-parse", "main"]);
    assert!(sent_already(&tools, &dir, &[later.clone()]).is_empty());
    // Not a commit name: refused, never handed to git as an option.
    assert!(sent_already(&tools, &dir, &["--all".into(), "zz".into()]).is_empty());
}


/// Round 2 (review, major): Send it again sends only into the repository
/// this project's Put it on GitHub created — an `origin` naming another
/// repository that lacks the branch gets nothing.
#[cfg(unix)]
#[test]
fn f3_send_it_again_sends_nothing_to_a_repository_plyloft_didnt_make_here() {
    let w = World::new();
    let dir = w.project(2);
    let tools = w.tools(Some(w.gh()));
    // Nothing created for this project: an origin someone added is not it.
    w.git(&w.root, &["init", "-q", "--bare", "elsewhere.git"]);
    let elsewhere = w.root.join("elsewhere.git");
    w.git(&dir, &["remote", "add", "origin", &elsewhere.to_string_lossy()]);
    let refused = send_again(&tools, &dir, None, "main", &mut |_| {}, "ws-other");
    assert_eq!(refused, Outcome::NotCreated { words: SEND_AGAIN_ELSEWHERE.into(), large: None, sign_in: false });
    assert!(w.git(&elsewhere, &["for-each-ref", "--format=%(refname)", "refs/heads"]).is_empty(), "nothing sent there");
    // Created for another project: still not this project's.
    created().insert("ws-third".into(), ("octocat/lyra".into(), w.origin().to_string_lossy().into_owned()));
    assert!(matches!(send_again(&tools, &dir, None, "main", &mut |_| {}, "ws-other"), Outcome::NotCreated { .. }));
    // A GitHub address: the same login/name only, whatever its case.
    created().insert("ws-gh".into(), ("Octocat/Lyra".into(), "https://github.com/Octocat/Lyra.git".into()));
    assert!(is_created_origin("ws-gh", "git@github.com:octocat/lyra.git"));
    assert!(!is_created_origin("ws-gh", "https://github.com/octocat/other.git"));
    assert!(!is_created_origin("ws-none", "https://github.com/octocat/lyra.git"));
}

/// Round 2 (review): Stop on one project's send doesn't stop another's.
#[cfg(unix)]
#[test]
fn f3_stop_on_one_project_leaves_another_projects_send_alone() {
    let w = World::new();
    let dir = w.project(2);
    let tools = w.tools(Some(w.gh()));
    w.hook("sleep 3");
    let stopper = std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(800));
        stop("ws-another-project")
    });
    // Its own project id: tests run side by side, each its own project.
    let outcome = create_and_send(&tools, &dir, "octocat", Some("octocat"), "lyra", "main", None, &mut |_| {}, "ws-f3-keeps-sending");
    assert_eq!(stopper.join().unwrap(), 0, "nothing of that project was sending");
    assert_eq!(outcome, Outcome::Done { repo: "octocat/lyra".into(), branch: "main".into() }, "this project's send went on");
    assert_eq!(w.origin_branches(), "refs/heads/main");
}
