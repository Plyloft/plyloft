//! G8 (1.170.0): a release through a pull request, driven end to end against
//! fixture repositories — a bare `origin` standing for GitHub's repository,
//! the project folder, a second computer — with a fake GitHub
//! ([`FakeGitHub`]) that opens pull requests and merges them into the bare
//! origin as GitHub would (a squash commit written on the target, past any
//! hook: GitHub's own merge is not a push).

use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use tauri::Manager;

use super::*;
use crate::kanban::{KanbanCard, KanbanColumnId, KanbanStore, ShipStatus};
use crate::project_config::{ProjectConfig, ProjectConfigStore};
use crate::workspace::WorkspaceStore;

const CARD: &str = "card-g8";
const OTHER_CARD: &str = "card-g9";

fn git(cwd: &Path, args: &[&str]) -> String {
    let out = crate::platform::git_command().args(args).current_dir(cwd).output().expect("spawn git");
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
    for (k, v) in [
        ("user.email", "t@ply.test"),
        ("user.name", "ply-test"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
    ] {
        git(dir, &["config", k, v]);
    }
}

// ── A fake GitHub ───────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct FakePr {
    number: u64,
    branch: String,
    base: String,
    title: String,
    body: String,
    state: PrState,
    head: String,
    merge_commit: Option<String>,
    auto: bool,
}

#[derive(Default)]
struct Knobs {
    /// The repository allows auto-merge.
    allow_auto: bool,
    /// GitHub merges as soon as it is asked (no checks to wait for).
    merges_at_once: bool,
    checks: PrChecks,
    merge_state: Option<&'static str>,
    /// `gh pr merge --disable-auto` fails.
    disable_fails: bool,
    /// G3: what `gh api repos/owner/app` answers (None: it can't be read).
    repo_json: Option<&'static str>,
    /// G3: the methods GitHub refuses ("… are not allowed on this repository").
    refused_methods: Vec<MergeMethod>,
    /// 1.170.0 walk fix: whether the target requires status checks (None:
    /// Plyloft couldn't tell).
    required_checks: Option<bool>,
}

struct FakeGitHub {
    origin: PathBuf,
    scratch: PathBuf,
    prs: RefCell<Vec<FakePr>>,
    releases: RefCell<Vec<(String, String)>>,
    calls: RefCell<Vec<String>>,
    /// G3: the method of every `gh pr merge` asked, in order.
    methods: RefCell<Vec<MergeMethod>>,
    knobs: RefCell<Knobs>,
}

impl FakeGitHub {
    fn new(origin: &Path, scratch: &Path) -> Rc<Self> {
        Rc::new(Self {
            origin: origin.to_path_buf(),
            scratch: scratch.to_path_buf(),
            prs: Default::default(),
            releases: Default::default(),
            calls: Default::default(),
            methods: Default::default(),
            knobs: RefCell::new(Knobs {
                allow_auto: true,
                merges_at_once: true,
                checks: PrChecks::Passing,
                merge_state: Some("clean"),
                disable_fails: false,
                repo_json: None,
                refused_methods: Vec::new(),
                required_checks: Some(true),
            }),
        })
    }

    fn url(n: u64) -> String {
        format!("https://github.com/owner/app/pull/{n}")
    }

    fn by_url(&self, url: &str) -> Option<usize> {
        self.prs.borrow().iter().position(|p| Self::url(p.number) == url)
    }

    /// GitHub's squash merge: one commit on the base with the head's tree,
    /// written into the repository directly (no push, no hook).
    fn do_merge(&self, i: usize) {
        let (branch, base, title, number) = {
            let prs = self.prs.borrow();
            (prs[i].branch.clone(), prs[i].base.clone(), prs[i].title.clone(), prs[i].number)
        };
        let origin = &self.origin;
        let tree = git(origin, &["rev-parse", &format!("refs/heads/{branch}^{{tree}}")]);
        let parent = git(origin, &["rev-parse", &format!("refs/heads/{base}")]);
        // A head that doesn't contain the base: a real merge's tree.
        let tree = if git(origin, &["merge-base", &parent, &format!("refs/heads/{branch}")]) == parent {
            tree
        } else {
            let scratch = self.scratch.join(format!("merge-{number}"));
            if !scratch.exists() {
                git(&self.scratch, &["clone", "-q", origin.to_str().unwrap(), scratch.to_str().unwrap()]);
                identity(&scratch);
            }
            git(&scratch, &["fetch", "-q", "origin"]);
            git(&scratch, &["checkout", "-q", "-B", "m", &format!("origin/{base}")]);
            git(&scratch, &["merge", "-q", "--squash", &format!("origin/{branch}")]);
            git(&scratch, &["commit", "-q", "-m", "squash"]);
            git(&scratch, &["push", "-q", "origin", "HEAD:refs/fake/merge"]);
            git(origin, &["rev-parse", "refs/fake/merge^{tree}"])
        };
        let commit = git_with_identity(origin, &["commit-tree", &tree, "-p", &parent, "-m", &format!("{title} (#{number})")]);
        git(origin, &["update-ref", &format!("refs/heads/{base}"), &commit, &parent]);
        let mut prs = self.prs.borrow_mut();
        prs[i].state = PrState::Merged;
        prs[i].merge_commit = Some(commit);
    }

    /// GitHub's checks passed now: an auto-merge waiting on them merges.
    fn checks_pass(&self) {
        self.knobs.borrow_mut().checks = PrChecks::Passing;
        let waiting: Vec<usize> =
            self.prs.borrow().iter().enumerate().filter(|(_, p)| p.auto && p.state == PrState::Open).map(|(i, _)| i).collect();
        for i in waiting {
            self.do_merge(i);
        }
    }

    fn created(&self) -> usize {
        self.calls.borrow().iter().filter(|c| c.starts_with("create_pr")).count()
    }
}

fn git_with_identity(cwd: &Path, args: &[&str]) -> String {
    let out = crate::platform::git_command()
        .args(["-c", "user.name=GitHub", "-c", "user.email=noreply@github.com"])
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

impl ReleaseGitHub for FakeGitHub {
    fn find_prs(&self, branch: &str) -> Result<Vec<FoundPr>, String> {
        self.calls.borrow_mut().push(format!("find_prs {branch}"));
        let mut found: Vec<FoundPr> = self
            .prs
            .borrow()
            .iter()
            .filter(|p| p.branch == branch)
            .map(|p| FoundPr {
                number: p.number,
                url: Self::url(p.number),
                state: p.state,
                head: Some(p.head.clone()),
                merge_commit: p.merge_commit.clone(),
            })
            .collect();
        found.sort_by(|a, b| b.number.cmp(&a.number));
        Ok(found)
    }

    fn create_pr(&self, base: &str, branch: &str, title: &str, body: &str) -> Result<Result<String, String>, String> {
        self.calls.borrow_mut().push(format!("create_pr {base} {branch}"));
        if self.prs.borrow().iter().any(|p| p.branch == branch && p.state == PrState::Open) {
            return Ok(Err(format!("a pull request for branch \"{branch}\" into branch \"{base}\" already exists")));
        }
        let head = git(&self.origin, &["rev-parse", &format!("refs/heads/{branch}")]);
        let number = 100 + self.prs.borrow().len() as u64;
        self.prs.borrow_mut().push(FakePr {
            number,
            branch: branch.into(),
            base: base.into(),
            title: title.into(),
            body: body.into(),
            state: PrState::Open,
            head,
            merge_commit: None,
            auto: false,
        });
        Ok(Ok(Self::url(number)))
    }

    fn view_pr(&self, url: &str) -> Result<PrStatus, String> {
        self.calls.borrow_mut().push(format!("view_pr {url}"));
        let i = self.by_url(url).ok_or("no such pull request")?;
        let p = self.prs.borrow()[i].clone();
        let head = git(&self.origin, &["rev-parse", &format!("refs/heads/{}", p.branch)]);
        let knobs = self.knobs.borrow();
        Ok(PrStatus {
            number: p.number,
            state: p.state,
            checks: knobs.checks,
            mergeable: PrMergeable::Mergeable,
            merge_state: knobs.merge_state.map(str::to_string),
            head_sha: Some(head),
            merge_commit: p.merge_commit.clone(),
            auto_merge: p.auto && p.state == PrState::Open,
            ..Default::default()
        })
    }

    fn merge(&self, url: &str, head: &str, auto: bool, method: MergeMethod) -> Result<GhAnswer, String> {
        self.calls.borrow_mut().push(format!("merge {url} {head} auto={auto}"));
        self.methods.borrow_mut().push(method);
        let i = self.by_url(url).ok_or("no such pull request")?;
        if self.knobs.borrow().refused_methods.contains(&method) {
            return Ok(GhAnswer {
                ok: false,
                stdout: String::new(),
                stderr: format!("GraphQL: Merge method {method:?} merging is not allowed on this repository (mergePullRequest)"),
            });
        }
        let ok = |stdout: &str| GhAnswer { ok: true, stdout: stdout.into(), stderr: String::new() };
        // GitHub's head is the branch's tip now (a push since it opened).
        let branch = self.prs.borrow()[i].branch.clone();
        let tip = git(&self.origin, &["rev-parse", &format!("refs/heads/{branch}")]);
        self.prs.borrow_mut()[i].head = tip;
        if self.prs.borrow()[i].head != head {
            return Ok(GhAnswer { ok: false, stdout: String::new(), stderr: "Head branch was modified".into() });
        }
        if self.prs.borrow()[i].state == PrState::Merged {
            return Ok(ok("! Pull request was already merged"));
        }
        let (allow_auto, at_once) = {
            let knobs = self.knobs.borrow();
            (knobs.allow_auto, knobs.merges_at_once)
        };
        if auto && !allow_auto {
            return Ok(GhAnswer {
                ok: false,
                stdout: String::new(),
                stderr: "GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)".into(),
            });
        }
        if auto {
            self.prs.borrow_mut()[i].auto = true;
        }
        if !auto || at_once {
            self.do_merge(i);
        }
        Ok(ok(""))
    }

    fn create_release(&self, tag: &str, notes: &str) -> Result<GhAnswer, String> {
        self.calls.borrow_mut().push(format!("create_release {tag}"));
        if self.releases.borrow().iter().any(|(t, _)| t == tag) {
            return Ok(GhAnswer { ok: false, stdout: String::new(), stderr: "a release with the same tag name already exists".into() });
        }
        self.releases.borrow_mut().push((tag.into(), notes.into()));
        Ok(GhAnswer { ok: true, stdout: format!("https://github.com/owner/app/releases/tag/{tag}"), stderr: String::new() })
    }

    fn api(&self, args: &[&str]) -> Result<GhAnswer, String> {
        assert_eq!(args, ["api", "repos/owner/app"], "only the repository's merge methods are read");
        match self.knobs.borrow().repo_json {
            Some(json) => Ok(GhAnswer { ok: true, stdout: json.into(), stderr: String::new() }),
            None => Err("gh: connection refused".into()),
        }
    }

    fn disable_auto(&self, url: &str) -> Result<GhAnswer, String> {
        self.calls.borrow_mut().push(format!("disable_auto {url}"));
        if self.knobs.borrow().disable_fails {
            return Err("gh: connection refused".into());
        }
        let i = self.by_url(url).ok_or("no such pull request")?;
        self.prs.borrow_mut()[i].auto = false;
        Ok(GhAnswer { ok: true, stdout: String::new(), stderr: String::new() })
    }

    fn checks_required(&self, url: &str, base: &str) -> Option<bool> {
        self.calls.borrow_mut().push(format!("checks_required {url} {base}"));
        self.knobs.borrow().required_checks
    }
}

// ── The fixture ─────────────────────────────────────────────────────────

struct Fixture {
    _shell_env: std::sync::MutexGuard<'static, ()>,
    _tmp: tempfile::TempDir,
    app: tauri::App<tauri::test::MockRuntime>,
    ws: PathBuf,
    other: PathBuf,
    origin: PathBuf,
    ws_id: String,
    github: Rc<FakeGitHub>,
}

struct Registries {
    ship: crate::ship::ShipRegistry,
    swarms: crate::swarms::SwarmRegistry,
    intakes: crate::intake::IntakeRegistry,
    agents: crate::agents::AgentRegistry,
    pty: crate::pty::PtyRegistry,
    reviewers: crate::reviewer::ReviewerRegistry,
    discussions: crate::discussion::DiscussionRegistry,
    coordination: crate::coordination::CoordinationRegistry,
    _dir: tempfile::TempDir,
}

fn registries() -> Registries {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path().to_path_buf();
    Registries {
        ship: crate::ship::ShipRegistry::default(),
        swarms: crate::swarms::SwarmRegistry::new(d.join("swarms")).unwrap(),
        intakes: crate::intake::IntakeRegistry::default(),
        agents: crate::agents::AgentRegistry::new(&d.join("agents")).unwrap(),
        pty: crate::pty::PtyRegistry::default(),
        reviewers: crate::reviewer::ReviewerRegistry::new(d.join("reviews")).unwrap(),
        discussions: crate::discussion::DiscussionRegistry::new(d.join("discussions"), None).unwrap(),
        coordination: crate::coordination::CoordinationRegistry::new(d.join("coordination")).unwrap(),
        _dir: dir,
    }
}

impl Fixture {
    /// `origin` (GitHub's repository, `owner/app` to Plyloft), the project
    /// folder `ws` and a second computer `other`, both clones; a card whose
    /// copy commits `card_files`. Version kept in `package.json`; checks
    /// `pipeline` (scripts).
    fn new(card_files: &[(&str, &str)], pipeline: &[&str]) -> Self {
        let shell_env = crate::shell_env::lock_for_test();
        crate::shell_env::init();
        let tmp = tempfile::tempdir().unwrap();
        let seed = tmp.path().join("seed");
        fs::create_dir(&seed).unwrap();
        git(&seed, &["init", "-q", "-b", "main"]);
        identity(&seed);
        write(&seed, "README.md", "base\n");
        write(&seed, "package.json", "{\n  \"name\": \"app\",\n  \"version\": \"1.0.0\"\n}\n");
        write(&seed, ".gitignore", ".atelier-worktrees/\n.plyloft-worktrees/\n");
        for script in pipeline {
            write(&seed, script, "exit 0\n");
        }
        git(&seed, &["add", "."]);
        git(&seed, &["commit", "-q", "-m", "base"]);
        let origin = tmp.path().join("origin.git");
        git(tmp.path(), &["clone", "-q", "--bare", seed.to_str().unwrap(), origin.to_str().unwrap()]);
        let ws = tmp.path().join("ws");
        let other = tmp.path().join("other");
        for dir in [&ws, &other] {
            git(tmp.path(), &["clone", "-q", "-c", "core.autocrlf=false", origin.to_str().unwrap(), dir.to_str().unwrap()]);
            identity(dir);
        }
        let scratch = tmp.path().join("github-scratch");
        fs::create_dir(&scratch).unwrap();

        let config = tmp.path().join("config");
        let workspaces = WorkspaceStore::new(config.join("workspaces")).unwrap();
        let kanban = KanbanStore::new(config.join("kanban")).unwrap();
        let project_config = ProjectConfigStore::new(config.join("project")).unwrap();
        let ws_id = workspaces.create("App".into(), ws.to_string_lossy().into_owned()).unwrap().id;
        let pipeline: Vec<serde_json::Value> =
            pipeline.iter().map(|p| serde_json::json!({ "kind": "script", "path": p })).collect();
        let project: ProjectConfig = serde_json::from_value(serde_json::json!({
            "schemaVersion": 2,
            "targetBranch": "main",
            "versionFiles": [{ "path": "package.json", "kind": "package_json" }],
            "verifyPipeline": pipeline,
            "createdAt": 0,
            "updatedAt": 0,
        }))
        .unwrap();
        project_config.set(&ws_id, project).unwrap();
        let app = tauri::test::mock_builder().build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        app.manage(workspaces);
        app.manage(kanban);
        app.manage(project_config);
        app.manage(crate::ship::ShipRegistry::default());
        let github = FakeGitHub::new(&origin, &scratch);
        let fx = Self { _shell_env: shell_env, _tmp: tmp, app, ws, other, origin, ws_id, github };
        fx.add_card(CARD, "Add the card", card_files, Some(12));
        fx
    }

    fn add_card(&self, id: &str, title: &str, files: &[(&str, &str)], issue: Option<u64>) {
        let card = crate::worktrees::ensure_for_card(&self.ws, id, title, "main").unwrap();
        identity(&card.worktree_path);
        for (rel, body) in files {
            write(&card.worktree_path, rel, body);
            git(&card.worktree_path, &["add", rel]);
        }
        git(&card.worktree_path, &["commit", "-q", "-m", "card work"]);
        let mut c = KanbanCard::new(id.into(), self.ws_id.clone(), title.into(), None, KanbanColumnId::Complete);
        c.worktree_path = Some(card.worktree_path.to_string_lossy().into_owned());
        c.branch_name = Some(card.branch_name.clone());
        c.verify_status = crate::kanban::VerifyStatus::Passed;
        c.gh_issue_number = issue;
        self.app.state::<KanbanStore>().create_card(&self.ws_id, c).unwrap();
    }

    fn ship(&self, r: &Registries, kind: ReleaseKind) -> Result<ShipResult, ShipError> {
        self.ship_as(r, kind, "1.0.1")
    }

    fn ship_as(&self, r: &Registries, kind: ReleaseKind, version: &str) -> Result<ShipResult, ShipError> {
        let handle = self.app.handle();
        self.on_github(|| {
            crate::ship::ship_card(
                handle,
                crate::ship::ShipRequest {
                    workspace_id: self.ws_id.clone(),
                    card_id: CARD.into(),
                    release_kind: kind,
                    version: version.into(),
                    skip_verify: false,
                },
                &handle.state::<WorkspaceStore>(),
                &handle.state::<KanbanStore>(),
                &r.ship,
                &handle.state::<ProjectConfigStore>(),
                &r.swarms,
                &r.intakes,
                &r.agents,
                &r.pty,
                &r.reviewers,
                &r.discussions,
                &r.coordination,
            )
        })
    }

    fn ship_batch(&self, r: &Registries, ids: &[&str]) -> Result<ShipResult, ShipError> {
        let handle = self.app.handle();
        self.on_github(|| {
            crate::ship::ship_batch(
                handle,
                crate::ship::ShipBatchRequest {
                    workspace_id: self.ws_id.clone(),
                    card_ids: ids.iter().map(|id| id.to_string()).collect(),
                    release_kind: ReleaseKind::PushOnly,
                    version: "1.0.1".into(),
                },
                &handle.state::<WorkspaceStore>(),
                &handle.state::<KanbanStore>(),
                &r.ship,
                &handle.state::<ProjectConfigStore>(),
                &r.reviewers,
                &r.discussions,
                &r.coordination,
            )
        })
    }

    /// 1.174.0 (DR2): Release… of the workspace's area with `ids` ticked.
    fn release_area(&self, r: &Registries, kind: ReleaseKind, ids: &[&str], version: &str) -> Result<ShipResult, ShipError> {
        let handle = self.app.handle();
        self.on_github(|| {
            crate::ship::release_area(
                handle,
                crate::ship::ReleaseAreaRequest {
                    workspace_id: self.ws_id.clone(),
                    area_id: None,
                    card_ids: ids.iter().map(|id| id.to_string()).collect(),
                    release_kind: kind,
                    version: version.into(),
                    skip_verify: false,
                },
                &handle.state::<WorkspaceStore>(),
                &handle.state::<KanbanStore>(),
                &r.ship,
                &handle.state::<ProjectConfigStore>(),
            )
        })
    }

    /// 1.174.0 (DR2): Stop the release.
    fn stop(&self, r: &Registries) -> Result<crate::ship::ReleaseStopOutcome, String> {
        let handle = self.app.handle();
        self.on_github(|| {
            crate::ship::release_stop(
                handle,
                &r.ship,
                &handle.state::<ProjectConfigStore>(),
                &handle.state::<KanbanStore>(),
                &self.ws_id,
            )
        })
    }

    /// 1.174.0 (DR2): CARD as Ship it leaves a card whose pull request
    /// merged: its change on GitHub's main (`files`, pushed from the second
    /// computer), shipped there, no copy of its own. The commit.
    fn merged_by_ship_it(&self, files: &[(&str, &str)]) -> String {
        let sha = self.publish(files);
        self.app
            .state::<KanbanStore>()
            .with_card(&self.ws_id, CARD, |c| {
                c.ship_status = ShipStatus::Shipped;
                c.commit_sha = Some(sha.clone());
                c.ship_history.push(crate::kanban::ShipEntry {
                    commit_sha: sha.clone(),
                    shipped_version: String::new(),
                    release_kind: ReleaseKind::PushOnly,
                    shipped_at: 1,
                    target: Some("main".into()),
                    tag: None,
                });
                c.worktree_path = None;
                c.branch_name = None;
                Ok(())
            })
            .unwrap();
        sha
    }

    /// The record, changed by `f` and written back.
    fn change_record(&self, f: impl FnOnce(&mut PendingRelease)) {
        let mut record = self.record().expect("a record");
        f(&mut record);
        crate::release_record::save(&self.app.state::<ProjectConfigStore>().workspace_dir(&self.ws_id), &record).unwrap();
    }

    /// `f` with origin standing for `owner/app` and this fixture's GitHub.
    fn on_github<T>(&self, f: impl FnOnce() -> T) -> T {
        crate::ship::TEST_ORIGIN_SLUG.with(|s| *s.borrow_mut() = Some("owner/app".into()));
        TEST_GITHUB.with(|g| *g.borrow_mut() = Some(self.github.clone() as Rc<dyn ReleaseGitHub>));
        let out = f();
        TEST_GITHUB.with(|g| *g.borrow_mut() = None);
        crate::ship::TEST_ORIGIN_SLUG.with(|s| *s.borrow_mut() = None);
        out
    }

    fn poll(&self) {
        let handle = self.app.handle();
        self.on_github(|| poll(handle));
    }

    /// The poller's ticks (one step each, m10) until the release is done or
    /// stops moving; how many ticks moved it.
    fn poll_until_settled(&self) -> usize {
        let mut moved = 0;
        for _ in 0..12 {
            let before = self.record();
            if before.is_none() {
                break;
            }
            self.poll();
            if self.record() == before {
                break;
            }
            moved += 1;
        }
        moved
    }

    fn on_origin(&self, rev: &str) -> Option<String> {
        let out = crate::platform::git_command()
            .args(["rev-parse", "--verify", "--quiet", rev])
            .current_dir(&self.origin)
            .output()
            .unwrap();
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn record(&self) -> Option<PendingRelease> {
        crate::release_record::load(&self.app.state::<ProjectConfigStore>().workspace_dir(&self.ws_id)).unwrap()
    }

    fn card(&self, id: &str) -> KanbanCard {
        self.app.state::<KanbanStore>().get_card(&self.ws_id, id).unwrap()
    }

    /// Commit `files` on the second computer and push them: GitHub's main moves.
    fn publish(&self, files: &[(&str, &str)]) -> String {
        for (rel, body) in files {
            write(&self.other, rel, body);
            git(&self.other, &["add", rel]);
        }
        git(&self.other, &["commit", "-q", "-m", "published elsewhere"]);
        git(&self.other, &["pull", "-q", "--no-rebase", "origin", "main"]);
        git(&self.other, &["push", "-q", "origin", "main"]);
        git(&self.other, &["rev-parse", "HEAD"])
    }

    /// The subjects of `base..rev` on origin, oldest first.
    fn subjects(&self, range: &str) -> Vec<String> {
        git(&self.origin, &["log", "--reverse", "--format=%s", range]).lines().map(str::to_string).collect()
    }

    fn local_branches(&self) -> String {
        git(&self.ws, &["branch", "--list", "plyloft/release-*"])
    }
}

/// The release went through: one pull request, merged; the tag on GitHub
/// at its merge commit; the card shipped there; nothing left here.
fn assert_released(fx: &Fixture, res: &ShipResult) -> String {
    let merge = fx.on_origin("refs/heads/main").unwrap();
    assert_eq!(res.commit_sha, merge, "the merge commit");
    assert!(res.release_pr.as_ref().is_some_and(|p| p.released), "{:?}", res.release_pr);
    assert_eq!(fx.on_origin("refs/tags/v1.0.1^{commit}").as_deref(), Some(merge.as_str()), "tagged on GitHub at the merge");
    assert_eq!(git(&fx.ws, &["rev-parse", "v1.0.1^{commit}"]), merge, "tagged here too");
    let card = fx.card(CARD);
    assert_eq!(card.ship_status, ShipStatus::Shipped);
    assert_eq!(card.commit_sha.as_deref(), Some(merge.as_str()));
    assert_eq!(card.ship_history.iter().filter(|e| e.commit_sha == merge).count(), 1, "marked once");
    assert!(fx.record().is_none(), "the record is gone");
    assert_eq!(fx.local_branches(), "", "no release branch left here");
    assert_eq!(fx.github.created(), 1, "one pull request");
    merge
}

// ── The flow ────────────────────────────────────────────────────────────

/// One card: a release branch from GitHub's main with the card's commit and
/// the version commit, checked, pushed, a pull request opened and merged
/// when its checks pass, the merge tagged and the tag pushed; "Tag and
/// push" makes no GitHub release. The project folder is never on the
/// release's path: it may be on another branch with changes of its own.
#[test]
fn one_card_goes_through_a_release_pull_request() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &["check.sh"]);
    let r = registries();
    let base = fx.on_origin("refs/heads/main").unwrap();
    // The person's folder: another branch, and an edit of theirs.
    git(&fx.ws, &["checkout", "-q", "-b", "mine"]);
    write(&fx.ws, "README.md", "my own work\n");

    let res = fx.ship(&r, ReleaseKind::PushOnly).expect("released");
    let merge = assert_released(&fx, &res);
    let branch = "refs/heads/plyloft/release-v1.0.1";
    let head = fx.on_origin(branch).expect("the release branch is on GitHub");
    assert_eq!(
        fx.subjects(&format!("{base}..{head}")),
        vec!["feat: add the card".to_string(), "chore(release): v1.0.1".into()],
        "one commit per card, then the version"
    );
    let card_commit = git(&fx.origin, &["log", "-1", "--format=%B", &format!("{head}~1")]);
    assert!(card_commit.contains("Closes #12") && card_commit.contains("Card: card-g8"), "{card_commit}");
    assert_eq!(git(&fx.origin, &["show", &format!("{merge}:card.txt")]), "card");
    assert!(git(&fx.origin, &["show", &format!("{merge}:package.json")]).contains("\"version\": \"1.0.1\""));
    let pr = fx.github.prs.borrow()[0].clone();
    assert_eq!((pr.base.as_str(), pr.title.as_str()), ("main", "chore(release): v1.0.1"));
    assert!(pr.body.contains("- Add the card (closes #12)") && pr.body.contains("\nCloses #12"), "{}", pr.body);
    assert!(pr.body.contains("Checks passed on the combined change before it was pushed: check.sh."), "{}", pr.body);
    let calls = fx.github.calls.borrow().clone();
    assert!(calls.iter().any(|c| c == &format!("merge {} {head} auto=true", FakeGitHub::url(pr.number))), "{calls:?}");
    assert!(!calls.iter().any(|c| c.starts_with("create_release")), "Tag and push makes no GitHub release");
    // The folder: as the person left it.
    assert_eq!(git(&fx.ws, &["rev-parse", "--abbrev-ref", "HEAD"]), "mine");
    assert_eq!(fs::read_to_string(fx.ws.join("README.md")).unwrap(), "my own work\n");
}

/// "Publish a GitHub release": the same, then `gh release create` with the
/// cards' notes; the project folder on a clean main is brought up to date.
#[test]
fn the_github_release_kind_makes_the_release_page_and_brings_main_up_to_date() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    let r = registries();
    let res = fx.ship(&r, ReleaseKind::Github).expect("released");
    let merge = assert_released(&fx, &res);
    let releases = fx.github.releases.borrow().clone();
    assert_eq!(releases.len(), 1);
    assert_eq!(releases[0].0, "v1.0.1");
    assert_eq!(releases[0].1, "## v1.0.1\n\n- Add the card (#12)\n\nReleased through #100.\n");
    assert!(res.fast_forwarded);
    assert_eq!(git(&fx.ws, &["rev-parse", "main"]), merge, "this computer's main is at the release");
}

/// The checks still running on GitHub: the press opens the pull request
/// and asks for auto-merge, and returns with the release on its way — the
/// card not shipped, the record at "Merging". Once GitHub merged it, the
/// poller tags it and marks the card.
#[test]
fn a_release_waiting_for_checks_is_finished_by_the_poller() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    {
        let mut knobs = fx.github.knobs.borrow_mut();
        knobs.merges_at_once = false;
        knobs.checks = PrChecks::Pending;
        knobs.merge_state = Some("blocked");
    }
    let r = registries();
    let res = fx.ship(&r, ReleaseKind::PushOnly).expect("on its way");
    let pr = res.release_pr.clone().unwrap();
    assert!(!pr.released && pr.step == PrReleaseStep::Merging && pr.number == Some(100), "{pr:?}");
    assert_eq!(fx.card(CARD).ship_status, ShipStatus::Unshipped);
    assert_eq!(fx.on_origin("refs/tags/v1.0.1"), None, "not tagged before the merge");
    assert_eq!(fx.record().unwrap().pr.unwrap().step, PrReleaseStep::Merging);
    // Nothing else ships meanwhile.
    let blocked = fx.ship_as(&r, ReleaseKind::PushOnly, "1.0.2");
    assert!(blocked.is_ok_and(|res| !res.release_pr.unwrap().released), "the same card's press only looks again");

    fx.github.checks_pass();
    // m10: one step per tick — merged, then tagged, then marked.
    fx.poll();
    assert_eq!(fx.record().unwrap().pr.unwrap().step, PrReleaseStep::Merged, "one step on the first tick");
    assert_eq!(fx.poll_until_settled(), 2, "tagged, then done");
    let card = fx.card(CARD);
    let merge = fx.on_origin("refs/heads/main").unwrap();
    assert_eq!(card.ship_status, ShipStatus::Shipped);
    assert_eq!(card.commit_sha.as_deref(), Some(merge.as_str()));
    assert_eq!(fx.on_origin("refs/tags/v1.0.1^{commit}"), Some(merge));
    assert!(fx.record().is_none());
}

/// DR4 round 2: GitHub's checks failed, then passed and it merged — the
/// flag goes with the merge, and the Inbox asks nothing.
#[test]
fn checks_that_failed_then_passed_leave_no_flag_after_the_merge() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    {
        let mut knobs = fx.github.knobs.borrow_mut();
        knobs.merges_at_once = false;
        knobs.checks = PrChecks::Pending;
        knobs.merge_state = Some("blocked");
    }
    let r = registries();
    fx.ship(&r, ReleaseKind::PushOnly).expect("on its way");
    fx.github.knobs.borrow_mut().checks = PrChecks::Failing;
    fx.poll();
    assert!(fx.record().unwrap().pr.unwrap().checks_failed, "the failed read is saved");
    let handle = fx.app.handle();
    let ws_dir = handle.state::<ProjectConfigStore>().workspace_dir(&fx.ws_id);
    let ws = handle.state::<WorkspaceStore>().snapshot().workspaces.into_iter().find(|w| w.id == fx.ws_id).unwrap();
    let asks = crate::inbox::release_stopped_event(ws_dir.parent().unwrap(), &ws);
    assert!(asks.is_some_and(|e| e.detail.as_deref() == Some("GitHub's checks failed")));

    fx.github.checks_pass();
    // Merged on GitHub: the press looks at it now (the poller would within
    // its minute) and takes it to Merged.
    let res = fx.ship(&r, ReleaseKind::PushOnly);
    match fx.record() {
        Some(record) => {
            let pr = record.pr.unwrap();
            assert!(matches!(pr.step, PrReleaseStep::Merged | PrReleaseStep::Tagged), "{pr:?} {res:?}");
            assert!(!pr.checks_failed, "cleared with the merge");
            assert!(crate::inbox::release_stopped_event(ws_dir.parent().unwrap(), &ws).is_none());
        }
        None => assert!(res.unwrap().release_pr.unwrap().released, "released at once"),
    }
}

/// 1.170 walk: a window following the events never reads the record gone
/// while the board it last read still has the card unshipped — the board
/// event comes before the record's.
#[test]
fn the_record_never_goes_before_the_board_says_shipped() {
    use tauri::Listener;
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    {
        let mut knobs = fx.github.knobs.borrow_mut();
        knobs.merges_at_once = false;
        knobs.checks = PrChecks::Pending;
    }
    // What the window holds after each event: the board as of the last
    // board event, the record as of the last record event.
    let seen: std::sync::Arc<std::sync::Mutex<Vec<(&'static str, bool)>>> = Default::default();
    for (name, record_event) in [(crate::kanban::KANBAN_CHANGED_EVENT, false), (crate::ship::PENDING_RELEASE_CHANGED, true)] {
        let into = seen.clone();
        let handle = fx.app.handle().clone();
        let ws_id = fx.ws_id.clone();
        fx.app.listen_any(name, move |_| {
            let now = if record_event {
                let dir = handle.state::<ProjectConfigStore>().workspace_dir(&ws_id);
                crate::release_record::load(&dir).unwrap().is_some()
            } else {
                handle.state::<KanbanStore>().get_card(&ws_id, CARD).unwrap().ship_status == ShipStatus::Shipped
            };
            into.lock().unwrap().push((if record_event { "record" } else { "board" }, now));
        });
    }
    let r = registries();
    fx.ship(&r, ReleaseKind::PushOnly).expect("on its way");
    fx.github.checks_pass();
    fx.poll_until_settled();
    assert_eq!(fx.card(CARD).ship_status, ShipStatus::Shipped);
    let seen = seen.lock().unwrap().clone();
    let (mut record_there, mut board_shipped) = (true, false);
    for (i, (what, now)) in seen.iter().enumerate() {
        if *what == "record" {
            record_there = *now
        } else {
            board_shipped = *now
        }
        assert!(
            record_there || board_shipped,
            "after event {i} the window reads neither a release on its way nor a shipped card: {seen:?}"
        );
    }
    assert!(!record_there && board_shipped, "{seen:?}");
}

/// A repository that doesn't allow auto-merge: Plyloft merges the pull
/// request itself once its checks on GitHub passed, at the head it built.
#[test]
fn without_auto_merge_plyloft_merges_once_the_checks_passed() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    fx.github.knobs.borrow_mut().allow_auto = false;
    let r = registries();
    let res = fx.ship(&r, ReleaseKind::PushOnly).expect("released");
    assert_released(&fx, &res);
    let calls = fx.github.calls.borrow().clone();
    assert!(calls.iter().any(|c| c.ends_with("auto=true")) && calls.iter().any(|c| c.ends_with("auto=false")), "{calls:?}");
}

/// 1.170.0 walk fix: a target that requires no checks (or Plyloft can't
/// tell): GitHub's auto-merge would merge it at once, before any check
/// ran, so Plyloft never asks for it — it waits for the checks and merges
/// the release itself once they passed.
#[test]
fn without_required_checks_plyloft_waits_for_the_checks_then_merges() {
    for required in [Some(false), None] {
        let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
        {
            let mut knobs = fx.github.knobs.borrow_mut();
            knobs.required_checks = required;
            knobs.checks = PrChecks::Pending;
            knobs.merge_state = Some("unstable");
        }
        let r = registries();
        let res = fx.ship(&r, ReleaseKind::PushOnly).expect("on its way");
        let pr = res.release_pr.clone().unwrap();
        assert!(!pr.released && pr.step == PrReleaseStep::Merging, "{required:?}: {pr:?}");
        let calls = fx.github.calls.borrow().clone();
        assert!(calls.iter().any(|c| c.starts_with("checks_required ") && c.ends_with(" main")), "{calls:?}");
        assert!(!calls.iter().any(|c| c.starts_with("merge ")), "{required:?}: no merge asked while checks run: {calls:?}");
        assert_eq!(fx.on_origin("refs/tags/v1.0.1"), None);

        // The checks passed: the poller's next read merges it (a merge,
        // never --auto); the read after it (a minute later) tags it.
        fx.github.checks_pass();
        fx.poll();
        let calls = fx.github.calls.borrow().clone();
        assert!(calls.iter().any(|c| c.starts_with("merge ") && c.ends_with("auto=false")), "{calls:?}");
        assert!(!calls.iter().any(|c| c.ends_with("auto=true")), "{required:?}: never --auto: {calls:?}");
        assert!(fx.github.prs.borrow().iter().all(|p| p.state == PrState::Merged), "merged on GitHub");
    }
}

/// 1.172.0 B2: the record says who merges it — Plyloft (auto-merge refused,
/// or a target that requires no checks) or GitHub (auto-merge on) — and
/// only Plyloft's own merge counts in the quit note.
#[test]
fn the_record_says_when_plyloft_merges_the_release_itself() {
    // (allow auto-merge, checks required, Plyloft merges it)
    for (allow_auto, required, plyloft) in
        [(true, Some(true), false), (false, Some(true), true), (true, Some(false), true), (true, None, true)]
    {
        let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
        {
            let mut knobs = fx.github.knobs.borrow_mut();
            knobs.allow_auto = allow_auto;
            knobs.required_checks = required;
            knobs.merges_at_once = false;
            knobs.checks = PrChecks::Pending;
            knobs.merge_state = Some("blocked");
        }
        let r = registries();
        fx.ship(&r, ReleaseKind::PushOnly).expect("on its way");
        let record = fx.record().unwrap();
        let pr = record.pr.as_ref().unwrap();
        let case = format!("allow_auto {allow_auto}, required {required:?}");
        assert_eq!(pr.step, PrReleaseStep::Merging, "{case}");
        assert_eq!(pr.plyloft_merges, plyloft, "{case}");
        assert_eq!(crate::release_record::plyloft_merges_pending(&record), plyloft, "{case}");
        assert_eq!(crate::pr_status::plyloft_merges_count(fx.app.handle()), u32::from(plyloft), "{case}: the quit count");
    }
}

/// 1.172.0 B2 (Challenger): who merges it is read again at Merging — GitHub
/// dropping its auto-merge later, or a 1.171 record already at Merging
/// (which never said), makes it Plyloft's own merge; auto-merge on again
/// makes it GitHub's. (One poll each: the poller reads a waiting release
/// once a minute.)
#[test]
fn at_merging_the_record_follows_who_merges_it_on_github() {
    let at_merging = |allow_auto: bool| {
        let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
        {
            let mut knobs = fx.github.knobs.borrow_mut();
            knobs.allow_auto = allow_auto;
            knobs.merges_at_once = false;
            knobs.checks = PrChecks::Pending;
            knobs.merge_state = Some("blocked");
        }
        let r = registries();
        fx.ship(&r, ReleaseKind::PushOnly).expect("on its way");
        fx
    };
    let merges = |fx: &Fixture| {
        let record = fx.record().unwrap();
        let pr = record.pr.as_ref().unwrap();
        assert_eq!(pr.step, PrReleaseStep::Merging);
        pr.plyloft_merges
    };

    // One fixture at a time: each holds the test environment's lock.
    // GitHub dropped its auto-merge (turned off on GitHub).
    let fx = at_merging(true);
    assert!(!merges(&fx), "GitHub's auto-merge is on");
    fx.github.prs.borrow_mut()[0].auto = false;
    fx.poll();
    assert!(merges(&fx), "Plyloft merges it now");
    assert_eq!(crate::pr_status::plyloft_merges_count(fx.app.handle()), 1, "the quit count");
    drop(fx);

    // A 1.171 record at Merging never said; GitHub's auto-merge is off.
    let fx = at_merging(false);
    let dir = fx.app.state::<ProjectConfigStore>().workspace_dir(&fx.ws_id);
    let mut old = fx.record().unwrap();
    old.pr.as_mut().unwrap().plyloft_merges = false;
    crate::release_record::save(&dir, &old).unwrap();
    fx.poll();
    assert!(merges(&fx), "read from GitHub at Merging");
    drop(fx);

    // Auto-merge turned on again on GitHub: GitHub's merge.
    let fx = at_merging(false);
    assert!(merges(&fx));
    fx.github.prs.borrow_mut()[0].auto = true;
    fx.poll();
    assert!(!merges(&fx));
    assert_eq!(crate::pr_status::plyloft_merges_count(fx.app.handle()), 0);
}

/// Walk fix: a target that requires checks keeps GitHub's auto-merge.
#[test]
fn with_required_checks_github_merges_it_when_they_pass() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    let r = registries();
    let res = fx.ship(&r, ReleaseKind::PushOnly).expect("released");
    assert_released(&fx, &res);
    let calls = fx.github.calls.borrow().clone();
    assert!(calls.iter().any(|c| c.ends_with("auto=true")), "{calls:?}");
}

/// A protected main (GitHub's rule: no push to it at all — origin's hook
/// here) works: the release never pushes main, GitHub's merge writes it.
#[cfg(unix)]
#[test]
fn a_protected_main_works() {
    use std::os::unix::fs::PermissionsExt;
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    let hook = fx.origin.join("hooks/pre-receive");
    fs::write(&hook, "#!/bin/sh\nwhile read old new ref; do\n  [ \"$ref\" = refs/heads/main ] && { echo 'GH006: Protected branch update failed' >&2; exit 1; }\ndone\nexit 0\n").unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    let r = registries();
    let res = fx.ship(&r, ReleaseKind::PushOnly).expect("released through the pull request");
    assert_released(&fx, &res);
}

/// The card's change conflicts with what GitHub's main got meanwhile: the
/// release stops on that card as Land's conflict does (recorded on it,
/// against GitHub's main, so Ask the Builder works); nothing is pushed or
/// recorded, and no branch is left.
#[test]
fn a_card_that_conflicts_with_githubs_main_stops_on_that_card() {
    let fx = Fixture::new(&[("README.md", "the card's\n")], &[]);
    let theirs = fx.publish(&[("README.md", "theirs\n")]);
    let r = registries();
    let said = fx.ship(&r, ReleaseKind::PushOnly).unwrap_err().to_string();
    assert!(said.contains("conflicts with main in README.md"), "{said}");
    assert!(said.contains(NOTHING_PUSHED), "{said}");
    let card = fx.card(CARD);
    assert_eq!(card.review_status, Some(crate::kanban::ReviewStatus::ConflictBlocked));
    assert_eq!(card.ship_conflict.unwrap().target_sha, theirs, "against GitHub's main");
    assert_eq!(fx.on_origin("refs/heads/plyloft/release-v1.0.1"), None, "nothing pushed");
    assert!(fx.record().is_none() && fx.local_branches().is_empty());
    assert_eq!(fx.github.created(), 0);
}

/// The checks fail on the card together with GitHub's main (a change on
/// main the card never saw): nothing is pushed, the record goes.
#[test]
fn checks_that_fail_on_the_combined_change_push_nothing() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &["check.sh"]);
    // main gets a change the check refuses next to the card's file.
    fx.publish(&[("check.sh", "if [ -f card.txt ] && [ -f theirs.txt ]; then echo 'both files: broken' >&2; exit 1; fi\nexit 0\n"), ("theirs.txt", "theirs\n")]);
    let r = registries();
    let said = fx.ship(&r, ReleaseKind::PushOnly).unwrap_err().to_string();
    assert!(said.starts_with("The checks failed on the release — the card together with main on GitHub: check.sh:"), "{said}");
    assert!(said.contains("both files: broken"), "{said}");
    assert_eq!(fx.on_origin("refs/heads/plyloft/release-v1.0.1"), None);
    assert!(fx.record().is_none() && fx.local_branches().is_empty());
    assert_eq!(fx.card(CARD).ship_status, ShipStatus::Unshipped);
}

/// A branch of the release's name on GitHub already is never overwritten.
#[test]
fn a_release_branch_on_github_already_is_never_overwritten() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    git(&fx.other, &["push", "-q", "origin", "HEAD:refs/heads/plyloft/release-v1.0.1"]);
    let before = fx.on_origin("refs/heads/plyloft/release-v1.0.1");
    let r = registries();
    let said = fx.ship(&r, ReleaseKind::PushOnly).unwrap_err().to_string();
    assert!(said.contains("Plyloft never overwrites it"), "{said}");
    assert_eq!(fx.on_origin("refs/heads/plyloft/release-v1.0.1"), before);
    assert!(fx.record().is_none());
}

/// Plyloft stops right after each step was recorded (a quit, a crash):
/// the next press goes on from there, and the end is the same as without
/// the stop — one pull request, one merge, the tag at it, the card marked
/// once, one GitHub release.
#[test]
fn a_release_resumes_after_a_stop_at_each_step() {
    for step in [
        PrReleaseStep::Building,
        PrReleaseStep::Built,
        PrReleaseStep::Pushed,
        PrReleaseStep::Open,
        PrReleaseStep::Merging,
        PrReleaseStep::Merged,
        PrReleaseStep::Tagged,
    ] {
        let fx = Fixture::new(&[("card.txt", "card\n")], &["check.sh"]);
        let r = registries();
        TEST_CRASHED.with(|c| c.set(false));
        TEST_CRASH_AFTER.with(|c| c.set(Some(step)));
        let stopped = fx.ship(&r, ReleaseKind::Github);
        assert!(stopped.is_err(), "{step:?}: {stopped:?}");
        assert_eq!(fx.record().and_then(|r| r.pr).map(|p| p.step), Some(step), "{step:?}: recorded");
        if step == PrReleaseStep::Building {
            // m6: no build of it runs now — it says it stopped, and Continue
            // makes it again.
            let view = crate::release_record::view(&fx.ws, fx.record().unwrap());
            let waiting = view.record.pr.unwrap().waiting.unwrap_or_default();
            assert!(waiting.contains("stopped while it was making v1.0.1"), "{waiting}");
            assert!(waiting.contains("Continue v1.0.1 makes it again from the start"), "{waiting}");
        }
        TEST_CRASHED.with(|c| c.set(false));
        let res = fx.ship(&r, ReleaseKind::Github).unwrap_or_else(|e| panic!("{step:?}: {e}"));
        assert_released(&fx, &res);
        assert_eq!(fx.github.releases.borrow().len(), 1, "{step:?}: one GitHub release");
        let merges = fx.github.prs.borrow().iter().filter(|p| p.state == PrState::Merged).count();
        assert_eq!(merges, 1, "{step:?}");
        // m3: no release copy is left, whatever the stop left.
        assert!(!release_copies(&fx.ws), "{step:?}: {}", git(&fx.ws, &["worktree", "list"]));
    }
}

/// 1.176.2 (A5R-03): another workspace's release of the same repository
/// (another target, so `blocking_record` lets both run) clears leftovers
/// before it builds: the copy a release is running its checks in is not one
/// of them. A copy nobody uses any more (a quit's, a crash's) still goes.
#[test]
fn a_release_copy_in_use_is_left_to_its_release() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &["check.sh"]);
    let head = git(&fx.ws, &["rev-parse", "HEAD"]);
    let in_use = ReleaseTree::add(&fx.ws, &head).unwrap();
    discard_local(&fx.ws, "plyloft/release-v9.9.9");
    assert!(in_use.path.join(".git").exists(), "the running release keeps its copy");
    assert!(release_copies(&fx.ws), "{}", git(&fx.ws, &["worktree", "list"]));
    drop(in_use);
    assert!(!release_copies(&fx.ws));

    // Left by a "crash": no release uses it, so the next build removes it.
    TEST_CRASHED.with(|c| c.set(true));
    drop(ReleaseTree::add(&fx.ws, &head).unwrap());
    TEST_CRASHED.with(|c| c.set(false));
    assert!(release_copies(&fx.ws));
    discard_local(&fx.ws, "plyloft/release-v9.9.9");
    assert!(!release_copies(&fx.ws), "{}", git(&fx.ws, &["worktree", "list"]));
}

/// REV-R4 M1: git lists a copy (`locked initializing`) while its add is
/// still checking it out. Its key is reserved before the add starts, so
/// another release's clean-up leaves such a copy alone.
#[test]
fn a_release_copy_being_made_is_already_in_use() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &["check.sh"]);
    let head = git(&fx.ws, &["rev-parse", "HEAD"]);
    TEST_RESERVED_AT_ADD.with(|c| c.set(None));
    let tree = ReleaseTree::add(&fx.ws, &head).unwrap();
    assert_eq!(TEST_RESERVED_AT_ADD.with(|c| c.get()), Some(true), "reserved before git's add started");
    drop(tree);

    // The window itself: a copy reserved as `add` does, listed and locked
    // as git lists one mid-add.
    let dir = tempfile::Builder::new().prefix(TREE_PREFIX).tempdir().unwrap();
    let path = dir.path().join("release");
    let key = reserve_live(dir.path());
    git(&fx.ws, &["worktree", "add", "--quiet", "--lock", "--detach", path.to_str().unwrap(), &head]);
    discard_local(&fx.ws, "plyloft/release-v9.9.9");
    assert!(path.join(".git").exists(), "the copy being made is kept");
    assert!(release_copies(&fx.ws));
    release_live(&key);
    git(&fx.ws, &["worktree", "unlock", path.to_str().unwrap()]);
    git(&fx.ws, &["worktree", "remove", "--force", path.to_str().unwrap()]);
}

/// A release copy (`plyloft-release-…/release`) in `git worktree list`.
fn release_copies(repo: &Path) -> bool {
    git(repo, &["worktree", "list", "--porcelain"])
        .lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        .any(is_release_copy)
}

/// m8: GitHub did what a step asked (opened the pull request, turned on
/// auto-merge, took the tag, made the release page), then Plyloft couldn't
/// write that down (a full disk): the press fails, and the next one goes on
/// from the step before without doing any of it twice.
#[test]
fn a_release_resumes_when_the_record_wasnt_written_after_githubs_effect() {
    for (fails, what) in [
        (SaveFails::At(PrReleaseStep::Open), "the pull request opened"),
        (SaveFails::At(PrReleaseStep::Merging), "auto-merge turned on"),
        (SaveFails::At(PrReleaseStep::Tagged), "the tag pushed"),
        (SaveFails::ReleaseCreated, "the release page made"),
    ] {
        let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
        if matches!(fails, SaveFails::At(PrReleaseStep::Merging)) {
            // GitHub only takes the request: it merges once checks pass.
            let mut knobs = fx.github.knobs.borrow_mut();
            knobs.merges_at_once = false;
            knobs.checks = PrChecks::Pending;
            knobs.merge_state = Some("blocked");
        }
        let r = registries();
        TEST_SAVE_FAILS.with(|c| c.set(Some(fails)));
        let said = fx.ship(&r, ReleaseKind::Github).unwrap_err().to_string();
        assert!(said.contains("test: the disk is full"), "{what}: {said}");
        let before = fx.record().and_then(|r| r.pr).unwrap();
        match fails {
            SaveFails::At(PrReleaseStep::Open) => {
                assert_eq!(before.step, PrReleaseStep::Pushed, "{what}");
                assert_eq!(fx.github.created(), 1, "{what}: GitHub has it");
            }
            SaveFails::At(PrReleaseStep::Merging) => {
                assert_eq!(before.step, PrReleaseStep::Open, "{what}");
                assert!(fx.github.prs.borrow()[0].auto, "{what}: GitHub has it");
            }
            SaveFails::At(_) => {
                assert_eq!(before.step, PrReleaseStep::Merged, "{what}");
                assert!(fx.on_origin("refs/tags/v1.0.1").is_some(), "{what}: GitHub has it");
            }
            SaveFails::ReleaseCreated => {
                assert!(before.step == PrReleaseStep::Tagged && !before.release_created, "{what}");
                assert_eq!(fx.github.releases.borrow().len(), 1, "{what}: GitHub has it");
            }
        }
        if matches!(fails, SaveFails::At(PrReleaseStep::Merging)) {
            let res = fx.ship(&r, ReleaseKind::Github).expect("on its way");
            assert!(!res.release_pr.unwrap().released, "{what}");
            fx.github.checks_pass();
            fx.poll_until_settled();
            assert!(fx.record().is_none(), "{what}: done by the poller");
            assert_eq!(fx.github.created(), 1);
        } else {
            let res = fx.ship(&r, ReleaseKind::Github).unwrap_or_else(|e| panic!("{what}: {e}"));
            assert_released(&fx, &res);
        }
        assert_eq!(fx.github.releases.borrow().len(), 1, "{what}: one GitHub release");
        assert_eq!(fx.github.prs.borrow().len(), 1, "{what}: one pull request");
        let merge = fx.on_origin("refs/heads/main").unwrap();
        assert_eq!(fx.on_origin("refs/tags/v1.0.1^{commit}"), Some(merge), "{what}");
    }
}

/// Major 1: an earlier release of the same version whose pull request
/// GitHub merged — then given up (Dismiss) before its tag — is never taken
/// for this release: its merge commit is never tagged. G2 walk (Mac): it is
/// history, not a problem — this release opens its own pull request, and
/// its own merge is tagged.
#[test]
fn an_earlier_merged_pull_request_of_the_branch_is_never_taken_for_this_release() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    let main = fx.on_origin("refs/heads/main").unwrap();
    fx.github.prs.borrow_mut().push(FakePr {
        number: 90,
        branch: branch_for("", "1.0.1"),
        base: "main".into(),
        title: "chore(release): v1.0.1".into(),
        body: String::new(),
        state: PrState::Merged,
        head: "0123456789012345678901234567890123456789".into(),
        merge_commit: Some(main.clone()),
        auto: false,
    });
    let r = registries();
    let res = fx.ship(&r, ReleaseKind::PushOnly).expect("released through its own pull request");
    let pr = res.release_pr.unwrap();
    assert!(pr.released && pr.number != Some(90), "{pr:?}");
    assert_eq!(fx.github.created(), 1, "its own pull request");
    let tagged = fx.on_origin("refs/tags/v1.0.1^{commit}").unwrap();
    assert_ne!(tagged, main, "the old merge isn't tagged");
    assert_eq!(fx.card(CARD).ship_status, ShipStatus::Shipped);
}

#[test]
fn only_a_pull_request_at_the_pushed_head_is_this_releases() {
    let pr = |number, state, head: &str| FoundPr {
        number,
        url: format!("u{number}"),
        state,
        head: Some(head.into()),
        merge_commit: None,
    };
    assert_eq!(ours(vec![], "h"), Ours::None);
    assert_eq!(ours(vec![pr(3, PrState::Closed, "x")], "h"), Ours::None, "a closed one is history");
    assert_eq!(ours(vec![pr(4, PrState::Open, "h"), pr(3, PrState::Merged, "x")], "h"), Ours::Found(pr(4, PrState::Open, "h")));
    assert_eq!(ours(vec![pr(5, PrState::Merged, "h")], "h"), Ours::Found(pr(5, PrState::Merged, "h")));
    // G2 walk: an old merged one of the same branch name is history.
    assert_eq!(ours(vec![pr(6, PrState::Merged, "x")], "h"), Ours::None);
    assert_eq!(ours(vec![pr(7, PrState::Open, "x")], "h"), Ours::Other(pr(7, PrState::Open, "x")));
}

/// Major 2: GitHub's main is at a later version than this computer's folder
/// (released from elsewhere): the audit suggests the one after GitHub's,
/// and a version that isn't after it is refused before anything is made.
#[test]
fn the_version_on_github_is_what_a_release_through_a_pull_request_follows() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    fx.publish(&[("package.json", "{\n  \"name\": \"app\",\n  \"version\": \"1.0.4\"\n}\n")]);
    git(&fx.ws, &["fetch", "-q", "origin"]);
    // Not a first release (that one may tag the version as it is now):
    // an earlier release's tag is here.
    git(&fx.ws, &["tag", "v1.0.0"]);
    let r = registries();
    let handle = fx.app.handle();
    let audit = fx
        .on_github(|| {
            crate::ship::ship_audit(
                &handle.state::<WorkspaceStore>(),
                &r.swarms,
                &r.intakes,
                &r.agents,
                &r.ship,
                &handle.state::<KanbanStore>(),
                &handle.state::<ProjectConfigStore>(),
                Some(&fx.ws_id),
            )
        })
        .unwrap();
    assert_eq!((audit.current_version.as_str(), audit.suggested_next_version.as_str()), ("1.0.4", "1.0.5"));
    assert!(audit.version_on_github && audit.releases_through_pr);

    let said = fx.ship_as(&r, ReleaseKind::PushOnly, "1.0.3").unwrap_err().to_string();
    assert!(said.contains("main on GitHub is at v1.0.4 already (package.json), so v1.0.3 wouldn't be a new version"), "{said}");
    assert!(said.contains(NOTHING_PUSHED), "{said}");
    assert!(fx.record().is_none() && fx.local_branches().is_empty());
    assert_eq!(fx.on_origin("refs/heads/plyloft/release-v1.0.3"), None);
    // The same version as GitHub's: refused too.
    assert!(fx.ship_as(&r, ReleaseKind::PushOnly, "1.0.4").unwrap_err().to_string().contains("wouldn't be a new version"));
    // The next one goes through.
    let res = fx.ship_as(&r, ReleaseKind::PushOnly, "1.0.5").expect("released");
    assert!(res.release_pr.unwrap().released);
    assert_eq!(fx.on_origin("refs/tags/v1.0.5^{commit}"), fx.on_origin("refs/heads/main"));
}

#[test]
fn versions_compare_by_their_numbers() {
    assert_eq!(crate::ship::version_is_after("1.0.10", "1.0.9"), Some(true));
    assert_eq!(crate::ship::version_is_after("1.0.1-unverified", "1.0.0"), Some(true));
    assert_eq!(crate::ship::version_is_after("1.0.0", "1.0.0"), Some(false));
    assert_eq!(crate::ship::version_is_after("0.9.9", "1.0.0"), Some(false));
    assert_eq!(crate::ship::version_is_after("1.0", "1.0.0"), None);
}

/// Major 3: a card whose work is in a pull request of its own still open on
/// GitHub isn't released through the release pull request too.
#[test]
fn a_card_with_its_own_pull_request_open_isnt_released_through_another() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    fx.app
        .state::<KanbanStore>()
        .with_card_saved(&fx.ws_id, CARD, |c| {
            c.pr_url = Some("https://github.com/owner/app/pull/7".into());
            c.pr = Some(PrStatus { number: 7, state: PrState::Open, ..Default::default() });
            Ok(())
        })
        .unwrap();
    let r = registries();
    let said = fx.ship(&r, ReleaseKind::PushOnly).unwrap_err().to_string();
    assert_eq!(said, "ship blocked: card `Add the card` has pull request #7 open on GitHub; merge it from the card");
    assert!(fx.record().is_none() && fx.github.calls.borrow().is_empty());
}

/// Major 3: while a release through a pull request is on its way, its cards
/// aren't shipped as a pull request of their own (`card_ship`'s `pr` mode).
#[test]
fn a_card_in_a_release_pull_request_isnt_shipped_as_its_own() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    fx.add_card(OTHER_CARD, "Second card", &[("second.txt", "second\n")], None);
    {
        let mut knobs = fx.github.knobs.borrow_mut();
        knobs.merges_at_once = false;
        knobs.checks = PrChecks::Pending;
    }
    let r = registries();
    fx.ship(&r, ReleaseKind::PushOnly).expect("on its way");
    let (pc, kanban) = (fx.app.state::<ProjectConfigStore>(), fx.app.state::<KanbanStore>());
    let said = crate::ship::in_release_pr_refusal(&pc, &kanban, &fx.ws_id, &fx.card(CARD)).expect("refused");
    assert!(said.contains("“Add the card” is in v1.0.1, which is on its way through a release pull request"), "{said}");
    assert_eq!(crate::ship::in_release_pr_refusal(&pc, &kanban, &fx.ws_id, &fx.card(OTHER_CARD)), None, "another card ships");
    let src = include_str!("commands.rs");
    let (_, ship) = src.split_once("fn card_ship_blocking_with(").unwrap();
    let ship = &ship[..ship.find("\nfn ").unwrap()];
    let refusal = ship.find("ship::in_release_pr_refusal(").expect("card_ship asks");
    assert!(refusal < ship.find("ship_tree_gate(").unwrap(), "before anything is gated or pushed");
}

/// Major 4: Dismiss of a release pull request turns its auto-merge off on
/// GitHub and says so; when that fails it says auto-merge may still be on.
#[test]
fn dismiss_turns_off_the_release_pull_requests_auto_merge() {
    for fails in [false, true] {
        let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
        {
            let mut knobs = fx.github.knobs.borrow_mut();
            knobs.merges_at_once = false;
            knobs.checks = PrChecks::Pending;
            knobs.disable_fails = fails;
        }
        let r = registries();
        fx.ship(&r, ReleaseKind::PushOnly).expect("on its way");
        assert!(fx.github.prs.borrow()[0].auto);
        let handle = fx.app.handle();
        let words = fx
            .on_github(|| {
                crate::ship::dismiss_pending_release(handle, &r.ship, &handle.state::<ProjectConfigStore>(), &fx.ws_id)
            })
            .unwrap();
        assert!(fx.github.calls.borrow().iter().any(|c| c == &format!("disable_auto {}", FakeGitHub::url(100))));
        if fails {
            assert!(words.contains("couldn't turn off merging #100") && words.contains("auto-merge may still be on"), "{words}");
            assert!(fx.github.prs.borrow()[0].auto);
        } else {
            assert!(words.contains("turned off merging #100 when its checks pass"), "{words}");
            assert!(!fx.github.prs.borrow()[0].auto, "GitHub won't merge it by itself");
        }
        assert!(fx.record().is_none() && fx.local_branches().is_empty());
        assert_eq!(fx.github.prs.borrow()[0].state, PrState::Open, "the pull request stays");
    }
}

/// m4: GitHub has a tag of the release's name at another commit: never
/// moved, and the release says so instead of trying again forever.
#[test]
fn a_tag_on_github_at_another_commit_is_the_persons_to_settle() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    {
        let mut knobs = fx.github.knobs.borrow_mut();
        knobs.merges_at_once = false;
        knobs.checks = PrChecks::Pending;
    }
    let r = registries();
    fx.ship(&r, ReleaseKind::PushOnly).expect("on its way");
    git(&fx.other, &["tag", "v1.0.1"]);
    git(&fx.other, &["push", "-q", "origin", "v1.0.1"]);
    let theirs = fx.on_origin("refs/tags/v1.0.1").unwrap();
    fx.github.checks_pass();
    fx.poll_until_settled();
    let pr = fx.record().unwrap().pr.unwrap();
    assert_eq!(pr.step, PrReleaseStep::Merged);
    assert!(pr.problem.as_deref().unwrap_or("").contains("GitHub has a tag v1.0.1 at another commit already"), "{pr:?}");
    assert_eq!(fx.on_origin("refs/tags/v1.0.1"), Some(theirs), "never moved");
    assert_eq!(fx.card(CARD).ship_status, ShipStatus::Unshipped);
}

/// m2: a release the poller finished says so in the window ("Released vX"),
/// with the install step offered when this computer's target is at it.
#[test]
fn the_poller_says_when_it_released() {
    use tauri::Listener;
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    {
        let mut knobs = fx.github.knobs.borrow_mut();
        knobs.merges_at_once = false;
        knobs.checks = PrChecks::Pending;
    }
    let heard: std::sync::Arc<std::sync::Mutex<Vec<String>>> = Default::default();
    let into = heard.clone();
    fx.app.listen_any(RELEASED_EVENT, move |e| into.lock().unwrap().push(e.payload().to_string()));
    let r = registries();
    fx.ship(&r, ReleaseKind::PushOnly).expect("on its way");
    fx.github.checks_pass();
    fx.poll_until_settled();
    let heard = heard.lock().unwrap().clone();
    assert_eq!(heard.len(), 1, "{heard:?}");
    let event: serde_json::Value = serde_json::from_str(&heard[0]).unwrap();
    assert_eq!(event["workspaceId"], fx.ws_id.as_str());
    assert_eq!(event["cardCount"], 1);
    assert_eq!(event["result"]["shippedVersion"], "1.0.1");
    assert_eq!(event["result"]["releasePr"]["released"], true);
    assert!(event["result"]["installScript"].is_null(), "never run by the poller");
    assert!(event["installScript"].is_null(), "this project has no install step");
}

/// m2: Run the install step, on the press — only while this computer's
/// target is at the release.
#[test]
fn the_install_step_runs_only_once_this_computer_is_at_the_release() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    let mut config = fx.app.state::<ProjectConfigStore>().get(&fx.ws_id).unwrap();
    assert_eq!(run_install(&fx.ws, &config, "v1.0.1").unwrap_err(), "This project has no install step. Nothing was run.");
    config.install_script = Some("install.sh".into());
    // The release is on GitHub's main; this computer's main is behind it.
    git(&fx.other, &["commit", "-q", "--allow-empty", "-m", "the release"]);
    git(&fx.other, &["tag", "v1.0.1"]);
    git(&fx.other, &["push", "-q", "origin", "main", "v1.0.1"]);
    git(&fx.ws, &["fetch", "-q", "origin", "--tags"]);
    let said = run_install(&fx.ws, &config, "v1.0.1").unwrap_err();
    assert!(said.contains("this computer's main isn't at v1.0.1 yet"), "{said}");
}

/// m7: the words for a card with no copy of its own name the release kind
/// as it is labelled.
#[test]
fn a_card_without_a_copy_is_pointed_at_the_local_release() {
    let words = no_copy_words("Fix it");
    assert!(words.contains(&format!("Release it with “On {} only”", crate::platform::THIS_MACHINE)), "{words}");
    assert!(!words.contains(" On this"), "{words}");
}

/// m5: whatever G3's method is, it is what the merge asks for, with
/// `--match-head-commit` always.
#[test]
fn the_merge_method_reaches_the_merge_args() {
    assert_eq!(
        merge_args("u", "h", true, MergeMethod::Squash),
        vec!["pr", "merge", "u", "--squash", "--auto", "--match-head-commit", "h"]
    );
    assert_eq!(
        merge_args("u", "h", false, MergeMethod::Rebase),
        vec!["pr", "merge", "u", "--rebase", "--match-head-commit", "h"]
    );
    assert_eq!(merge_args("u", "h", false, MergeMethod::Merge)[3], "--merge");
}

/// G3 at the integration: the release pull request is merged with the
/// method its repository allows (read with `gh api`, as a card's is), and
/// a merge refused for its method reads the repository again and tries the
/// next one it allows — never `--admin`, `--match-head-commit` always.
#[test]
fn the_release_pull_request_merges_with_the_repositorys_method() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    {
        let mut knobs = fx.github.knobs.borrow_mut();
        knobs.repo_json = Some(r#"{"allow_squash_merge":false,"allow_merge_commit":false,"allow_rebase_merge":true}"#);
        knobs.refused_methods = vec![MergeMethod::Squash, MergeMethod::Merge];
    }
    let r = registries();
    let res = fx.ship(&r, ReleaseKind::PushOnly).expect("released");
    assert_released(&fx, &res);
    let methods = fx.github.methods.borrow().clone();
    assert_eq!(methods.last(), Some(&MergeMethod::Rebase), "{methods:?}");
    assert!(!methods.contains(&MergeMethod::Merge), "the repository said no merge commits: {methods:?}");
    // One fixture at a time (it holds the shell-env test lock).
    drop(fx);

    // The tests' hook stands for G3 too.
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    TEST_MERGE_METHODS.with(|m| *m.borrow_mut() = Some(vec![MergeMethod::Merge]));
    let res = fx.ship(&r, ReleaseKind::PushOnly);
    TEST_MERGE_METHODS.with(|m| *m.borrow_mut() = None);
    assert_released(&fx, &res.expect("released"));
    assert_eq!(fx.github.methods.borrow().clone(), vec![MergeMethod::Merge]);
}

/// GitHub's main moved on and requires the release to be up to date: the
/// card says so ("Update the release"), and nothing happens by itself. The
/// press merges main into the release branch (a fast-forward push, never
/// forced), checks it again, and it goes on to its merge.
#[test]
fn update_the_release_brings_in_mains_changes_on_the_press() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    {
        let mut knobs = fx.github.knobs.borrow_mut();
        knobs.merges_at_once = false;
        knobs.checks = PrChecks::Pending;
        knobs.merge_state = Some("blocked");
    }
    let r = registries();
    let res = fx.ship(&r, ReleaseKind::PushOnly).unwrap();
    let old_head = fx.on_origin("refs/heads/plyloft/release-v1.0.1").unwrap();
    assert!(!res.release_pr.unwrap().released);
    fx.publish(&[("theirs.txt", "theirs\n")]);
    fx.github.knobs.borrow_mut().merge_state = Some("behind");
    fx.github.knobs.borrow_mut().checks = PrChecks::Passing;
    fx.poll();
    let pr = fx.record().unwrap().pr.unwrap();
    assert!(pr.outdated && pr.waiting.as_deref().unwrap_or("").contains("Update the release"), "{pr:?}");
    assert_eq!(fx.on_origin("refs/heads/plyloft/release-v1.0.1"), Some(old_head.clone()), "nothing by itself");

    fx.github.knobs.borrow_mut().merge_state = Some("clean");
    fx.github.knobs.borrow_mut().merges_at_once = true;
    let handle = fx.app.handle();
    let words = fx
        .on_github(|| {
            crate::ship::update_release_pr(
                handle,
                &handle.state::<crate::ship::ShipRegistry>(),
                &handle.state::<WorkspaceStore>(),
                &handle.state::<ProjectConfigStore>(),
                &handle.state::<KanbanStore>(),
                &fx.ws_id,
            )
        })
        .unwrap();
    assert!(words.contains("now has main's changes"), "{words}");
    let new_head = fx.on_origin("refs/heads/plyloft/release-v1.0.1").unwrap();
    assert_eq!(git(&fx.origin, &["merge-base", "--is-ancestor", &old_head, &new_head]), "", "a fast-forward");
    // Asked to merge the new head, which GitHub did.
    let merge = fx.on_origin("refs/heads/main").unwrap();
    assert_eq!(git(&fx.origin, &["show", &format!("{merge}:theirs.txt")]), "theirs");
    assert_eq!(git(&fx.origin, &["show", &format!("{merge}:card.txt")]), "card");
    fx.poll_until_settled();
    assert_eq!(fx.card(CARD).ship_status, ShipStatus::Shipped);
}

/// A non-GitHub project keeps the local release (1.169.1's): the target is
/// committed, tagged and pushed here; no release branch, no pull request.
#[test]
fn a_project_not_on_github_keeps_the_local_release() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    let r = registries();
    let handle = fx.app.handle();
    // No `owner/app` origin this time.
    TEST_GITHUB.with(|g| *g.borrow_mut() = Some(fx.github.clone() as Rc<dyn ReleaseGitHub>));
    let res = crate::ship::ship_card(
        handle,
        crate::ship::ShipRequest {
            workspace_id: fx.ws_id.clone(),
            card_id: CARD.into(),
            release_kind: ReleaseKind::PushOnly,
            version: "1.0.1".into(),
            skip_verify: false,
        },
        &handle.state::<WorkspaceStore>(),
        &handle.state::<KanbanStore>(),
        &r.ship,
        &handle.state::<ProjectConfigStore>(),
        &r.swarms,
        &r.intakes,
        &r.agents,
        &r.pty,
        &r.reviewers,
        &r.discussions,
        &r.coordination,
    );
    TEST_GITHUB.with(|g| *g.borrow_mut() = None);
    let res = res.expect("released here");
    assert!(res.release_pr.is_none());
    assert_eq!(fx.on_origin("refs/heads/main"), Some(git(&fx.ws, &["rev-parse", "HEAD"])), "main pushed from here");
    assert_eq!(fx.on_origin("refs/heads/plyloft/release-v1.0.1"), None);
    assert!(fx.github.calls.borrow().is_empty());
}

// ── Pieces ──────────────────────────────────────────────────────────────

#[test]
fn the_pull_request_list_reads_newest_first() {
    let found = parse_pr_list(
        r#"[{"number":7,"url":"u7","state":"CLOSED","headRefOid":"a","mergeCommit":null},
            {"number":9,"url":"u9","state":"MERGED","headRefOid":"b","mergeCommit":{"oid":"m"}}]"#,
    )
    .unwrap();
    assert_eq!(found.iter().map(|f| f.number).collect::<Vec<_>>(), vec![9, 7], "newest first");
    assert_eq!((found[0].state, found[0].merge_commit.as_deref()), (PrState::Merged, Some("m")));
    assert_eq!(parse_pr_list("[]").unwrap(), vec![]);
    assert!(parse_pr_list("nope").is_err());
}

#[test]
fn githubs_refusal_of_auto_merge_is_read() {
    assert!(auto_merge_refused("GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)"));
    assert!(auto_merge_refused("auto-merge is disabled for this repository"));
    assert!(!auto_merge_refused("Pull request is not mergeable: the base branch policy prohibits the merge."));
}

fn merging_record() -> (PendingRelease, ReleasePr) {
    let mut pr = ReleasePr::new(branch_for("", "1.0.1"), "base".into());
    pr.head = Some("h".into());
    pr.number = Some(5);
    pr.url = Some("u".into());
    pr.step = PrReleaseStep::Merging;
    pr.opened_at = Some(1_000);
    let record = PendingRelease {
        version: "1.0.1".into(),
        tag: "v1.0.1".into(),
        commit_sha: "h".into(),
        branch: "main".into(),
        card_ids: vec![],
        card_revs: Default::default(),
        release_kind: ReleaseKind::PushOnly,
        skip_verify: false,
        stopped_at: None,
        cause: None,
        output: None,
        bound: None,
        created_at: 0,
        stage: RecordStage::Committing,
        start_commit: None,
        protected: false,
        tag_pushed: false,
        pr: Some(pr.clone()),
        merged_card_ids: Vec::new(),
        since_tag: None,
        other_changes: 0,
        stop_requested: false,
    };
    (record, pr)
}

/// 1.171.0 F3 (K5): while GitHub merges the release the poller reads it
/// every tick, so "Merging the release" doesn't lag a minute behind GitHub —
/// only on a positive list (Merged, Merging just asked, or Merging whose last
/// read found its checks running or auto-merge on). Every other wait keeps
/// the minute: a refusal, a failed read, a review, a conflict, a problem.
#[test]
fn a_release_github_is_merging_is_read_every_tick() {
    let (record, _) = merging_record();
    let with = |f: &dyn Fn(&mut ReleasePr)| {
        let mut r = record.clone();
        f(r.pr.as_mut().unwrap());
        poll_every_ms(&r)
    };
    let checks = |p: &mut ReleasePr, words: &str| {
        p.waiting = Some(words.into());
        p.merge_on_its_way = true;
    };
    assert_eq!(POLL_MERGING_MS, 15_000);
    assert_eq!(poll_every_ms(&record), POLL_MERGING_MS, "merge asked, no word yet");
    assert_eq!(with(&|p| checks(p, "GitHub merges #5 when its checks pass.")), POLL_MERGING_MS);
    assert_eq!(with(&|p| checks(p, "#5 waits for its checks on GitHub.")), POLL_MERGING_MS);
    assert_eq!(with(&|p| p.step = PrReleaseStep::Merged), POLL_MERGING_MS, "the tag is next");
    // Back to a minute: every wait that isn't on the list.
    for words in [
        "GitHub didn't merge the release pull request: base branch policy prohibits the merge.",
        "Plyloft couldn't read the release pull request on GitHub (x); it tries again in a minute.",
        "Plyloft couldn't merge the release pull request yet (x); it tries again in a minute.",
        "#5 waits for a review on GitHub.",
        "Checks failed on GitHub for #5, so it isn't merged.",
    ] {
        assert_eq!(with(&|p| p.waiting = Some(words.into())), POLL_EVERY_MS, "{words}");
    }
    assert_eq!(with(&|p| { checks(p, "#5 conflicts with main"); p.outdated = true }), POLL_EVERY_MS, "the person's");
    assert_eq!(with(&|p| p.problem = Some("closed".into())), POLL_EVERY_MS);
    assert_eq!(
        with(&|p| { p.step = PrReleaseStep::Merged; p.waiting = Some("The tag couldn't be pushed yet; it tries again in a minute.".into()) }),
        POLL_EVERY_MS,
        "a tag push that failed"
    );
    for step in [PrReleaseStep::Pushed, PrReleaseStep::Open, PrReleaseStep::Tagged] {
        assert_eq!(with(&|p| { p.step = step; p.merge_on_its_way = true }), POLL_EVERY_MS, "{step:?}");
    }
    let mut local = record.clone();
    local.pr = None;
    assert_eq!(poll_every_ms(&local), POLL_EVERY_MS);
}

/// 1.171.0 F3: a read's wait says whether GitHub is on its way to merging.
#[test]
fn a_merging_read_says_whether_github_is_on_its_way() {
    let (record, pr) = merging_record();
    let open = PrStatus {
        state: PrState::Open,
        checks: PrChecks::Pending,
        mergeable: PrMergeable::Mergeable,
        merge_state: Some("clean".into()),
        head_sha: Some("h".into()),
        ..Default::default()
    };
    let checks = |view: &PrStatus| match merging(&record, &pr, view, "main", 2_000) {
        Merging::Wait { checks, .. } => Some(checks),
        _ => None,
    };
    assert_eq!(checks(&open), Some(true), "checks running");
    assert_eq!(checks(&PrStatus { auto_merge: true, ..open.clone() }), Some(true));
    assert_eq!(checks(&PrStatus { state: PrState::Merged, ..open.clone() }), Some(true), "no merge commit yet");
    assert_eq!(checks(&PrStatus { review_decision: PrReviewDecision::ReviewRequired, checks: PrChecks::Passing, ..open.clone() }), Some(false));
    assert_eq!(checks(&PrStatus { checks: PrChecks::Failing, ..open.clone() }), Some(false));
    assert_eq!(checks(&PrStatus { merge_state: Some("behind".into()), ..open.clone() }), Some(false));
    assert_eq!(checks(&PrStatus { head_sha: Some("x".into()), ..open }), Some(false));
}

/// What a read of the merging pull request leads to.
#[test]
fn a_merging_pull_request_is_read_into_one_next_step() {
    let (record, pr) = merging_record();
    let open = PrStatus {
        state: PrState::Open,
        checks: PrChecks::Passing,
        mergeable: PrMergeable::Mergeable,
        merge_state: Some("clean".into()),
        head_sha: Some("h".into()),
        ..Default::default()
    };
    let at = |view: &PrStatus, now: i64| merging(&record, &pr, view, "main", now);
    assert_eq!(at(&open, 2_000), Merging::MergeNow);
    assert!(matches!(at(&PrStatus { auto_merge: true, ..open.clone() }, 2_000), Merging::Wait { outdated: false, .. }));
    assert_eq!(
        at(&PrStatus { state: PrState::Merged, merge_commit: Some("m".into()), ..open.clone() }, 2_000),
        Merging::Merged("m".into())
    );
    assert!(matches!(at(&PrStatus { state: PrState::Closed, ..open.clone() }, 2_000), Merging::Problem(w) if w.contains("closed on GitHub without being merged")));
    assert!(matches!(at(&PrStatus { merge_state: Some("behind".into()), ..open.clone() }, 2_000), Merging::Wait { outdated: true, .. }));
    assert!(matches!(at(&PrStatus { mergeable: PrMergeable::Conflicting, ..open.clone() }, 2_000), Merging::Wait { outdated: true, .. }));
    assert!(matches!(at(&PrStatus { checks: PrChecks::Failing, ..open.clone() }, 2_000), Merging::Wait { words, .. } if words.contains("Checks failed on GitHub")));
    assert!(matches!(at(&PrStatus { checks: PrChecks::Pending, ..open.clone() }, 2_000), Merging::Wait { .. }));
    // No checks reported: taken as none only a while after it was opened.
    let none = PrStatus { checks: PrChecks::None, ..open.clone() };
    assert!(matches!(at(&none, 2_000), Merging::Wait { .. }));
    assert_eq!(at(&none, 1_000 + NO_CHECKS_WAIT_MS), Merging::MergeNow);
    // A head Plyloft didn't make is never merged by Plyloft.
    assert!(matches!(at(&PrStatus { head_sha: Some("x".into()), ..open.clone() }, 2_000), Merging::Wait { .. }));
    assert!(matches!(at(&PrStatus { review_decision: PrReviewDecision::ReviewRequired, ..open }, 2_000), Merging::Wait { words, .. } if words.contains("review")));
}

/// The merge method is chosen in one place (`merge_methods`, G3's), and
/// every merge goes through it.
#[test]
fn the_release_pull_request_is_merged_with_the_one_method_call_site() {
    let src = include_str!("release_pr.rs");
    let prod = &src[..src.find("#[cfg(test)]\nmod tests").unwrap_or(src.len())];
    assert!(!prod.contains("\"--squash\""), "no method of its own: G3's");
    assert_eq!(prod.matches("methods_for_pr(").count(), 1, "one call site");
    assert_eq!(prod.matches("github.merge(").count(), 1, "every merge asks with the method");
    assert!(!src.contains("\"--admin\""), "never --admin");
    assert!(!src.contains("with_lease") && !src.contains("\"push\", \"--force"), "never forced");
}

// ── G9: Ship batch is one integration pull request ─────────────────────

/// Two cards on a GitHub main that moved on since they were cut: one
/// release branch with one commit per card (in the order picked) and the
/// version, checked together, one pull request, one merge, one tag; both
/// cards shipped at the merge. No protection is read.
#[test]
fn a_batch_of_two_on_a_moved_main_is_one_pull_request() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &["check.sh"]);
    fx.add_card(OTHER_CARD, "Second card", &[("second.txt", "second\n")], None);
    let theirs = fx.publish(&[("theirs.txt", "theirs\n")]);
    let r = registries();
    let _serial = crate::github::test_serial_lock();
    crate::github::take_test_gh_invocations();
    crate::github::set_test_gh_responses(vec![]);
    let res = fx.ship_batch(&r, &[CARD, OTHER_CARD]);
    crate::github::clear_test_gh_responses();
    assert!(crate::github::take_test_gh_invocations().is_empty(), "no protection read");
    let res = res.expect("released");
    let merge = assert_released(&fx, &res);
    let head = fx.on_origin("refs/heads/plyloft/release-v1.0.1").unwrap();
    assert_eq!(
        fx.subjects(&format!("{theirs}..{head}")),
        vec!["feat: add the card".to_string(), "feat: second card".into(), "chore(release): v1.0.1".into()],
        "built on GitHub's main as it is now"
    );
    for file in ["card.txt", "second.txt", "theirs.txt"] {
        git(&fx.origin, &["cat-file", "-e", &format!("{merge}:{file}")]);
    }
    assert_eq!(fx.card(OTHER_CARD).commit_sha.as_deref(), Some(merge.as_str()));
    let pr = fx.github.prs.borrow()[0].clone();
    assert!(pr.body.contains("- Add the card (closes #12)\n- Second card"), "{}", pr.body);
    assert!(pr.body.contains("Checks passed on the combined change before it was pushed: check.sh."), "{}", pr.body);
}

/// Two cards of the batch change the same lines: "ship them separately",
/// nothing recorded on either card (nothing to resolve against main),
/// nothing pushed.
#[test]
fn two_cards_of_a_batch_that_conflict_are_shipped_separately() {
    let fx = Fixture::new(&[("README.md", "first card\n")], &[]);
    fx.add_card(OTHER_CARD, "Second card", &[("README.md", "second card\n")], None);
    let r = registries();
    let said = fx.ship_batch(&r, &[CARD, OTHER_CARD]).unwrap_err().to_string();
    assert!(said.contains("couldn't ship these cards together"), "{said}");
    assert!(said.contains("ship them separately"), "{said}");
    assert!(said.contains(NOTHING_PUSHED), "{said}");
    for id in [CARD, OTHER_CARD] {
        assert_eq!(fx.card(id).review_status, None, "{id}");
    }
    assert_eq!(fx.on_origin("refs/heads/plyloft/release-v1.0.1"), None);
    assert!(fx.record().is_none() && fx.local_branches().is_empty());
}

/// A batch card that conflicts with GitHub's main is recorded on it, as
/// Ship now's.
#[test]
fn a_batch_card_that_conflicts_with_main_is_recorded_on_it() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    fx.add_card(OTHER_CARD, "Second card", &[("README.md", "second card\n")], None);
    let theirs = fx.publish(&[("README.md", "theirs\n")]);
    let r = registries();
    let said = fx.ship_batch(&r, &[CARD, OTHER_CARD]).unwrap_err().to_string();
    assert!(said.contains("“Second card”") && said.contains("conflicts with main in README.md"), "{said}");
    let card = fx.card(OTHER_CARD);
    assert_eq!(card.review_status, Some(crate::kanban::ReviewStatus::ConflictBlocked));
    assert_eq!(card.ship_conflict.unwrap().target_sha, theirs);
    assert_eq!(fx.card(CARD).review_status, None);
    assert!(fx.record().is_none());
}

// ── 1.174.0 (DR2): a release with zero or more cards, Stop ──────────────

/// D1(b): Release… with no card ticked on GitHub — the release pull request
/// carries only the version commit on GitHub's main, which already has the
/// card shipped with Ship it; once merged and tagged that card gets an entry
/// with the tag at the merge (its own state otherwise as it was), and the
/// pull request and the release page say what is in it.
#[test]
fn a_release_with_no_card_of_its_own_carries_what_is_on_main() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    let r = registries();
    let merged = fx.merged_by_ship_it(&[("merged.txt", "merged\n")]);
    let res = fx.release_area(&r, ReleaseKind::Github, &[], "1.0.1").expect("released");
    assert!(res.release_pr.as_ref().is_some_and(|p| p.released), "{res:?}");
    let merge = fx.on_origin("refs/heads/main").unwrap();
    let head = fx.on_origin("refs/heads/plyloft/release-v1.0.1").expect("the release branch");
    assert_eq!(fx.subjects(&format!("{merged}..{head}")), vec!["chore(release): v1.0.1".to_string()], "only the version");
    assert_eq!(fx.on_origin("refs/tags/v1.0.1^{commit}").as_deref(), Some(merge.as_str()));
    assert!(git(&fx.origin, &["show", &format!("{merge}:package.json")]).contains("\"version\": \"1.0.1\""));

    let card = fx.card(CARD);
    assert_eq!(card.ship_status, ShipStatus::Shipped);
    assert_eq!(card.commit_sha.as_deref(), Some(merged.as_str()), "its own commit stays");
    let entry = card.ship_history.last().unwrap();
    assert_eq!((entry.tag.as_deref(), entry.commit_sha.as_str()), (Some("v1.0.1"), merge.as_str()), "{entry:?}");
    assert_eq!(card.ship_history.len(), 2, "one entry for the version");
    assert!(fx.record().is_none() && fx.local_branches().is_empty());

    let pr = fx.github.prs.borrow()[0].clone();
    assert!(pr.body.starts_with("Release v1.0.1 made by Plyloft: everything on main, and the version."), "{}", pr.body);
    assert!(pr.body.contains("Already on main:\n- Add the card (#12)\n- 1 other change"), "{}", pr.body);
    let notes = fx.github.releases.borrow()[0].1.clone();
    assert!(notes.starts_with("## v1.0.1\n\n- Add the card (#12)\n- 1 other change\n"), "{notes}");

    // Marked once: a second mark of the same release adds nothing.
    let again = PendingRelease {
        card_ids: Vec::new(),
        merged_card_ids: vec![CARD.into()],
        tag: "v1.0.1".into(),
        commit_sha: merge.clone(),
        ..merging_record().0
    };
    let handle = fx.app.handle();
    let ws_dir = handle.state::<ProjectConfigStore>().workspace_dir(&fx.ws_id);
    let config = handle.state::<ProjectConfigStore>().get(&fx.ws_id).unwrap();
    crate::ship::mark_released(handle, &ws_dir, &fx.ws, &config, &handle.state::<KanbanStore>(), &fx.ws_id, &again).unwrap();
    assert_eq!(fx.card(CARD).ship_history.len(), 2);

    // DR2 round 1: nothing ticked and nothing new since: refused in words,
    // nothing made.
    let said = fx.release_area(&r, ReleaseKind::Github, &[], "1.0.2").unwrap_err().to_string();
    assert_eq!(said, crate::ship::nothing_new_words("main", Some("v1.0.1")));
    assert_eq!(fx.github.created(), 1);
}

/// Walk fix (DR3 early walk, step 2): an area's first release may tag the
/// version its file says now — on GitHub (an empty version commit through
/// the release pull request) and on this Mac only.
#[test]
fn a_first_release_tags_the_version_as_it_is_now() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    let r = registries();
    let res = fx.release_area(&r, ReleaseKind::PushOnly, &[], "1.0.0").expect("released as it is");
    assert!(res.release_pr.as_ref().is_some_and(|p| p.released), "{res:?}");
    let merge = fx.on_origin("refs/heads/main").unwrap();
    assert_eq!(fx.on_origin("refs/tags/v1.0.0^{commit}").as_deref(), Some(merge.as_str()));
    // A later release of the same version is refused, as before.
    let again = fx.release_area(&r, ReleaseKind::PushOnly, &[], "1.0.0").unwrap_err().to_string();
    assert!(!again.is_empty());
}

/// G2 walk (Mac): a version whose release branch GitHub already has (its
/// pull request open) is on its way — not offered as the default.
#[test]
fn a_version_on_its_way_on_github_is_not_the_default() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    git(&fx.ws, &["push", "-q", "origin", "HEAD:refs/heads/plyloft/release-v1.0.0"]);
    let handle = fx.app.handle();
    let scope = fx.on_github(|| crate::release_scope::scope_for_app(handle, &fx.ws_id, None)).expect("scope");
    let as_is = scope.versions.iter().find(|v| v.version == "1.0.0").expect("1.0.0 listed");
    assert!(as_is.taken && as_is.on_its_way, "{:?}", scope.versions);
    assert_eq!(scope.versions[0].version, "1.0.1", "{:?}", scope.versions);
    assert!(!scope.versions[0].taken);
}

/// G2 walk (Mac): Stop pressed the moment Release is — before the press
/// read its scope or took the ship lock — stops it: nothing is made, nothing
/// reaches GitHub, and the answer is the person's own stop.
#[test]
fn a_stop_right_after_release_stops_it_before_anything() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    let r = registries();
    let early = crate::ship::PressStop::begin(&fx.ws_id);
    assert!(crate::ship::request_stop(&fx.ws_id), "the press is there to stop");
    let err = fx.release_area(&r, ReleaseKind::PushOnly, &[], "1.0.1").unwrap_err();
    assert!(matches!(err, ShipError::Stopped(_)), "{err:?}");
    drop(early);
    assert_eq!(fx.on_origin("refs/heads/plyloft/release-v1.0.1"), None);
    assert!(fx.record().is_none() && fx.local_branches().is_empty());
    assert!(fx.github.prs.borrow().is_empty());
}

/// DR4 round 1: a first release may tag the version as it is now, never
/// one before it — with no tag and GitHub at 1.0.4, 1.0.3 is refused.
#[test]
fn a_first_release_never_goes_back_before_the_version_on_github() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    fx.publish(&[("package.json", "{\n  \"name\": \"app\",\n  \"version\": \"1.0.4\"\n}\n")]);
    git(&fx.ws, &["fetch", "-q", "origin"]);
    let r = registries();
    let said = fx.release_area(&r, ReleaseKind::PushOnly, &[], "1.0.3").unwrap_err().to_string();
    assert!(said.contains("so v1.0.3 wouldn't be a new version"), "{said}");
    assert_eq!(fx.on_origin("refs/tags/v1.0.3"), None);
}

#[test]
fn a_first_release_on_this_mac_only_tags_the_version_as_it_is_now() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    let r = registries();
    fx.release_area(&r, ReleaseKind::Local, &[], "1.0.0").expect("released here as it is");
    assert_eq!(git(&fx.ws, &["rev-parse", "v1.0.0^{commit}"]), git(&fx.ws, &["rev-parse", "HEAD"]));
    assert_eq!(git(&fx.ws, &["log", "-1", "--format=%s"]), "chore(release): v1.0.0");
    // DR4 round 2: a release made only here, with no card, is logged for
    // the Inbox's News too.
    let ws_dir = fx.app.state::<ProjectConfigStore>().workspace_dir(&fx.ws_id);
    let log = crate::release_record::load_released(&ws_dir);
    assert!(log.iter().any(|e| e.tag == "v1.0.0" && e.cards == 0), "{log:?}");
}

/// DR3 round 1: a release with no card of its own, committed and tagged
/// here and stopped before its push (stage `tagged`), is published by the
/// same Release… — never refused as "nothing new" because its tag is here.
#[test]
fn a_recorded_release_with_no_card_is_published() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    let r = registries();
    git(&fx.ws, &["commit", "--allow-empty", "-q", "-m", "chore(release): v1.0.1"]);
    git(&fx.ws, &["tag", "v1.0.1"]);
    let head = git(&fx.ws, &["rev-parse", "HEAD"]);
    let record = PendingRelease {
        commit_sha: head.clone(),
        stage: RecordStage::Tagged,
        stopped_at: Some(crate::release_record::ReleasePushStep::Branch),
        pr: None,
        ..merging_record().0
    };
    crate::release_record::save(&fx.app.state::<ProjectConfigStore>().workspace_dir(&fx.ws_id), &record).unwrap();
    fx.release_area(&r, ReleaseKind::PushOnly, &[], "1.0.1").expect("published");
    assert_eq!(fx.on_origin("refs/tags/v1.0.1^{commit}").as_deref(), Some(head.as_str()));
    assert_eq!(fx.on_origin("refs/heads/main").as_deref(), Some(head.as_str()));
    assert!(fx.record().is_none());
}

/// D1(b), state 3: "On this Mac only" on a GitHub project whose main here is
/// behind GitHub's — brought up to date first (a fast-forward; nothing is
/// sent to GitHub), then the version commit and tag here.
#[test]
fn on_this_mac_only_brings_main_up_to_date_first() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    let r = registries();
    let moved = fx.publish(&[("elsewhere.txt", "x\n")]);
    let res = fx.release_area(&r, ReleaseKind::Local, &[], "1.0.1").expect("released here");
    assert!(res.fast_forwarded && res.release_pr.is_none(), "{res:?}");
    assert_eq!(git(&fx.ws, &["rev-parse", "HEAD~1"]), moved, "made on GitHub's main, brought here first");
    assert_eq!(git(&fx.ws, &["log", "-1", "--format=%s"]), "chore(release): v1.0.1");
    assert_eq!(git(&fx.ws, &["rev-parse", "v1.0.1^{commit}"]), git(&fx.ws, &["rev-parse", "HEAD"]));
    assert_eq!(fx.on_origin("refs/heads/main"), Some(moved), "nothing sent to GitHub");
    assert_eq!(fx.on_origin("refs/tags/v1.0.1"), None);
    assert!(fx.github.calls.borrow().is_empty());
    assert_eq!(fx.card(CARD).ship_status, ShipStatus::Unshipped, "a card not ticked stays ready");
}

/// State 3 (variant): both mains moved on — refused in words, nothing made.
#[test]
fn on_this_mac_only_is_refused_when_both_mains_moved_on() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    let r = registries();
    fx.publish(&[("elsewhere.txt", "x\n")]);
    write(&fx.ws, "here.txt", "mine\n");
    git(&fx.ws, &["add", "here.txt"]);
    git(&fx.ws, &["commit", "-q", "-m", "mine"]);
    let before = git(&fx.ws, &["rev-parse", "HEAD"]);
    let said = fx.release_area(&r, ReleaseKind::Local, &[], "1.0.1").unwrap_err().to_string();
    assert!(said.contains("have both moved") && said.contains("Nothing was merged"), "{said}");
    assert_eq!(git(&fx.ws, &["rev-parse", "HEAD"]), before);
    assert!(git(&fx.ws, &["tag", "--list", "v1.0.1"]).is_empty());
}

/// Stop in Building: the checks are killed with what they started, nothing
/// is pushed, and the record and the release branch go — the person's own
/// stop (`{ stopped }`), never a failure.
#[cfg(unix)]
#[test]
fn stop_while_building_kills_the_checks_and_pushes_nothing() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &["check.sh"]);
    let r = registries();
    let alive = fx._tmp.path().join("alive");
    let slow = format!(
        "(while true; do date +%s >> '{}'; sleep 0.05; done) &\nsleep 30\n",
        alive.display()
    );
    fx.publish(&[("check.sh", slow.as_str())]);
    let stopper = {
        let (alive, ws) = (alive.clone(), fx.ws_id.clone());
        std::thread::spawn(move || {
            let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
            while !alive.exists() && std::time::Instant::now() < until {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            crate::ship::request_stop(&ws)
        })
    };
    let started = std::time::Instant::now();
    let err = fx.release_area(&r, ReleaseKind::PushOnly, &[CARD], "1.0.1").unwrap_err();
    assert!(stopper.join().unwrap(), "a press was running");
    assert!(started.elapsed() < std::time::Duration::from_secs(25), "stopped, not waited out");
    let ShipError::Stopped(stopped) = &err else { panic!("{err:?}") };
    assert_eq!((stopped.stopped.tag.as_str(), stopped.stopped.on_github.as_deref()), ("v1.0.1", None));
    assert!(err.to_string().contains("Nothing of it is on GitHub"), "{err}");
    assert!(fx.record().is_none(), "taken back");
    assert_eq!(fx.local_branches(), "");
    assert_eq!(fx.on_origin("refs/heads/plyloft/release-v1.0.1"), None, "nothing pushed");
    assert_eq!(fx.github.created(), 0);
    assert!(!release_copies(&fx.ws), "{}", git(&fx.ws, &["worktree", "list"]));
    let before = fs::metadata(&alive).map(|m| m.len()).unwrap_or(0);
    std::thread::sleep(std::time::Duration::from_millis(400));
    assert_eq!(fs::metadata(&alive).map(|m| m.len()).unwrap_or(0), before, "the checks' tree is gone");
    assert_eq!(fx.card(CARD).ship_status, ShipStatus::Unshipped, "the card is still ready");
    // Nothing runs now: a Stop says so.
    assert_eq!(fx.stop(&r).unwrap_err(), crate::ship::NOTHING_TO_STOP);
}

/// Stop on a release pull request that is open and merging: Dismiss —
/// `gh pr merge --disable-auto`, the pull request left open, the record gone.
/// Merged, it can't be stopped.
#[test]
fn stop_on_an_open_release_turns_its_auto_merge_off_and_leaves_it_open() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    {
        let mut knobs = fx.github.knobs.borrow_mut();
        knobs.merges_at_once = false;
        knobs.checks = PrChecks::Pending;
    }
    let r = registries();
    fx.release_area(&r, ReleaseKind::PushOnly, &[CARD], "1.0.1").expect("on its way");
    assert_eq!(fx.record().unwrap().pr.unwrap().step, PrReleaseStep::Merging);

    // Merged on GitHub (as the record says): refused, nothing changes.
    fx.change_record(|r| r.pr.as_mut().unwrap().step = PrReleaseStep::Merged);
    let said = fx.stop(&r).unwrap_err();
    assert_eq!(said, crate::ship::merged_cant_stop_words("v1.0.1"));
    assert!(fx.record().is_some());
    fx.change_record(|r| r.pr.as_mut().unwrap().step = PrReleaseStep::Merging);

    let out = fx.stop(&r).expect("stopped");
    assert!(!out.stopping, "no press runs: given up here");
    assert!(out.said.as_deref().is_some_and(|s| s.contains("turned off merging #100")), "{out:?}");
    assert!(fx.github.calls.borrow().iter().any(|c| c == &format!("disable_auto {}", FakeGitHub::url(100))));
    assert!(!fx.github.prs.borrow()[0].auto);
    assert_eq!(fx.github.prs.borrow()[0].state, PrState::Open, "the pull request stays open");
    assert!(fx.record().is_none() && fx.local_branches().is_empty());
    assert_eq!(fx.on_origin("refs/tags/v1.0.1"), None, "nothing tagged");
}

/// Resume after a quit: a record that says its Stop was asked is withdrawn
/// by the poller once no press holds it — at Building (the take-back a quit
/// cut short) and at Merging (Dismiss's); one that doesn't say so goes on.
#[test]
fn after_a_quit_a_stopped_release_is_withdrawn_and_another_goes_on() {
    // Building: the press "died" right after recording it. (Each fixture
    // holds the shell-env test lock: one at a time.)
    {
    let fx = Fixture::new(&[("card.txt", "card\n")], &["check.sh"]);
    let r = registries();
    TEST_CRASHED.with(|c| c.set(false));
    TEST_CRASH_AFTER.with(|c| c.set(Some(PrReleaseStep::Building)));
    assert!(fx.release_area(&r, ReleaseKind::PushOnly, &[CARD], "1.0.1").is_err());
    TEST_CRASHED.with(|c| c.set(false));
    fx.change_record(|r| r.stop_requested = true);
    let wire: serde_json::Value = serde_json::from_slice(
        &fs::read(crate::release_record::path(&fx.app.state::<ProjectConfigStore>().workspace_dir(&fx.ws_id))).unwrap(),
    )
    .unwrap();
    assert_eq!(wire["stopRequested"], true);
    fx.poll();
    assert!(fx.record().is_none(), "withdrawn");
    assert_eq!(fx.local_branches(), "");
    assert!(!release_copies(&fx.ws), "{}", git(&fx.ws, &["worktree", "list"]));
    assert_eq!(fx.github.created(), 0);
    }

    // Merging: auto-merge turned off, the pull request left open.
    {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    {
        let mut knobs = fx.github.knobs.borrow_mut();
        knobs.merges_at_once = false;
        knobs.checks = PrChecks::Pending;
    }
    let r = registries();
    fx.release_area(&r, ReleaseKind::PushOnly, &[CARD], "1.0.1").expect("on its way");
    fx.change_record(|r| r.stop_requested = true);
    fx.poll();
    assert!(fx.record().is_none(), "withdrawn");
    assert!(fx.github.calls.borrow().iter().any(|c| c.starts_with("disable_auto")));
    assert_eq!(fx.github.prs.borrow()[0].state, PrState::Open);
    }

    // Not stopped: the poller takes it on.
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    {
        let mut knobs = fx.github.knobs.borrow_mut();
        knobs.merges_at_once = false;
        knobs.checks = PrChecks::Pending;
    }
    let r = registries();
    fx.release_area(&r, ReleaseKind::PushOnly, &[CARD], "1.0.1").expect("on its way");
    fx.github.checks_pass();
    fx.poll_until_settled();
    assert!(fx.record().is_none());
    assert_eq!(fx.card(CARD).ship_status, ShipStatus::Shipped, "released");
}

/// A Stop that comes while the press is sending the release (after it was
/// built): given up from where it got, as Dismiss — nothing pushed here
/// since the build was the last step; said as the person's stop.
#[test]
fn a_stop_after_the_build_pushes_nothing() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    let handle = fx.app.handle();
    let ws_dir = handle.state::<ProjectConfigStore>().workspace_dir(&fx.ws_id);
    let config = handle.state::<ProjectConfigStore>().get(&fx.ws_id).unwrap();
    let place = Place {
        app: handle,
        workspace_id: &fx.ws_id,
        ws_cwd: &fx.ws,
        repo_root: &fx.ws,
        ws_dir: &ws_dir,
        config: &config,
        kanban: handle.state::<KanbanStore>().inner(),
    };
    let press = crate::ship::PressStop::begin(&fx.ws_id);
    let cards = handle.state::<KanbanStore>().load(&fx.ws_id).unwrap();
    let b = Build {
        cards: cards.iter().filter(|c| c.id == CARD).collect(),
        version: "1.0.1".into(),
        tag_prefix: String::new(),
        kind: ReleaseKind::PushOnly,
        skip_verify: false,
        setup: Default::default(),
        facts: Default::default(),
        stop: Some(press.flag()),
    };
    let start = crate::commands::CARD_START_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let record = fx.on_github(|| super::build(&place, &b, start)).expect("built");
    assert!(crate::ship::request_stop(&fx.ws_id));
    let advanced = fx.on_github(|| advance_now(&place, record, PRESS_STEPS)).unwrap();
    let Advanced::Waiting(record) = &advanced else { panic!("{advanced:?}") };
    assert_eq!(record.pr.as_ref().unwrap().step, PrReleaseStep::Built, "no step after the Stop");
    let err = fx.on_github(|| crate::ship::after_press(&place, &press, advanced)).unwrap_err();
    let ShipError::Stopped(stopped) = &err else { panic!("{err:?}") };
    assert_eq!(stopped.stopped.on_github, None, "nothing was on GitHub");
    assert!(fx.record().is_none() && fx.local_branches().is_empty());
    assert_eq!(fx.on_origin("refs/heads/plyloft/release-v1.0.1"), None);
    drop(press);
    assert!(!crate::ship::stop_requested_now(&fx.ws_id), "the press is gone");
}

/// DR2 round 1: a Stop asked of a release GitHub merged meanwhile can't take
/// it back — it goes on (tagged, the card shipped); one whose auto-merge
/// can't be turned off is kept, its problem saying so.
#[test]
fn a_stop_after_githubs_merge_goes_on_and_a_failed_turn_off_is_kept() {
    {
        let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
        {
            let mut knobs = fx.github.knobs.borrow_mut();
            knobs.merges_at_once = false;
            knobs.checks = PrChecks::Pending;
        }
        let r = registries();
        fx.release_area(&r, ReleaseKind::PushOnly, &[CARD], "1.0.1").expect("on its way");
        fx.github.checks_pass();
        fx.change_record(|r| r.stop_requested = true);
        fx.poll();
        let kept = fx.record().expect("not given up");
        assert!(!kept.stop_requested, "the ask is dropped");
        assert!(!fx.github.calls.borrow().iter().any(|c| c.starts_with("disable_auto")));
        fx.poll_until_settled();
        assert!(fx.record().is_none());
        assert_eq!(fx.card(CARD).ship_status, ShipStatus::Shipped);
        assert!(fx.on_origin("refs/tags/v1.0.1").is_some(), "tagged");
    }
    {
        let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
        {
            let mut knobs = fx.github.knobs.borrow_mut();
            knobs.merges_at_once = false;
            knobs.checks = PrChecks::Pending;
            knobs.disable_fails = true;
        }
        let r = registries();
        fx.release_area(&r, ReleaseKind::PushOnly, &[CARD], "1.0.1").expect("on its way");
        fx.change_record(|r| r.stop_requested = true);
        fx.poll();
        let kept = fx.record().expect("kept while GitHub may merge it");
        assert!(kept.stop_requested);
        let problem = kept.pr.unwrap().problem.unwrap_or_default();
        assert!(problem.contains("auto-merge may still be on"), "{problem}");
        // DR2 round 2: GitHub merges it after all — it goes on by itself
        // (the kept problem goes with the Stop), tagged and shipped.
        fx.github.checks_pass();
        fx.poll_until_settled();
        assert!(fx.record().is_none(), "{:?}", fx.record());
        assert!(fx.on_origin("refs/tags/v1.0.1").is_some(), "tagged");
        assert_eq!(fx.card(CARD).ship_status, ShipStatus::Shipped);
    }
}

/// DR2 round 1 (owner): a Stop of a release pushed before its pull request
/// says its branch stays on GitHub.
#[test]
fn a_stop_after_the_push_says_the_branch_stays() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    let r = registries();
    TEST_CRASHED.with(|c| c.set(false));
    TEST_CRASH_AFTER.with(|c| c.set(Some(PrReleaseStep::Pushed)));
    assert!(fx.release_area(&r, ReleaseKind::PushOnly, &[CARD], "1.0.1").is_err());
    TEST_CRASHED.with(|c| c.set(false));
    fx.change_record(|r| r.stop_requested = true);
    let handle = fx.app.handle();
    let ws_dir = handle.state::<ProjectConfigStore>().workspace_dir(&fx.ws_id);
    let config = handle.state::<ProjectConfigStore>().get(&fx.ws_id).unwrap();
    let place = Place {
        app: handle,
        workspace_id: &fx.ws_id,
        ws_cwd: &fx.ws,
        repo_root: &fx.ws,
        ws_dir: &ws_dir,
        config: &config,
        kanban: handle.state::<KanbanStore>().inner(),
    };
    let record = fx.record().unwrap();
    let settled = fx.on_github(|| settle_stop(&place, &record)).unwrap();
    let Settled::GivenUp(said) = settled else { panic!("{settled:?}") };
    assert_eq!(said, "Its branch plyloft/release-v1.0.1 stays on GitHub; no pull request was opened.");
    assert!(fx.record().is_none());
}

/// Release… takes any number of ticked cards not on main yet, on every
/// plan: two of them go in one release pull request.
#[test]
fn two_ticked_cards_not_on_main_release_together() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    fx.add_card(OTHER_CARD, "Another card", &[("other.txt", "other\n")], None);
    let r = registries();
    let res = fx.release_area(&r, ReleaseKind::PushOnly, &[CARD, OTHER_CARD], "1.0.1").expect("released");
    assert!(res.release_pr.is_some_and(|p| p.released));
    assert_eq!(fx.github.prs.borrow().len(), 1, "one release pull request");
    for id in [CARD, OTHER_CARD] {
        assert_eq!(fx.card(id).ship_status, ShipStatus::Shipped, "{id}");
    }
}

/// DR2 round 1: the Stopped sentence names GitHub only for a GitHub
/// project, and says what the take-back left in the project folder.
#[test]
fn the_stopped_sentence_names_github_only_when_there_is_one() {
    assert!(ShipError::stopped("v1.0.1", "1.0.1", true).to_string().contains("Nothing of it is on GitHub"));
    let local = ShipError::stopped("v1.0.1", "1.0.1", false).to_string();
    assert!(local.contains("Nothing of it was pushed") && !local.contains("GitHub"), "{local}");
    let mut kept = ShipError::stopped("v1.0.1", "1.0.1", false);
    if let ShipError::Stopped(s) = &mut kept {
        s.stopped.here = Some("Changes saved in the project folder are kept in your stash list.".into());
    }
    assert!(kept.to_string().ends_with("kept in your stash list."), "{kept}");
    let wire = serde_json::to_value(&kept).unwrap();
    assert_eq!(wire["stopped"]["github"], false, "{wire}");
    assert_eq!(wire["stopped"]["here"], "Changes saved in the project folder are kept in your stash list.");
}

/// DR2 round 2: Stop with no press on an open release whose auto-merge can't
/// be turned off keeps it, says why, and is never "stopped".
#[test]
fn stop_without_a_press_keeps_a_release_whose_auto_merge_stays_on() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    {
        let mut knobs = fx.github.knobs.borrow_mut();
        knobs.merges_at_once = false;
        knobs.checks = PrChecks::Pending;
        knobs.disable_fails = true;
    }
    let r = registries();
    fx.release_area(&r, ReleaseKind::PushOnly, &[CARD], "1.0.1").expect("on its way");
    let said = fx.stop(&r).unwrap_err();
    assert!(said.contains("auto-merge may still be on"), "{said}");
    let kept = fx.record().expect("kept");
    assert!(kept.stop_requested && kept.pr.unwrap().problem.is_some());
    assert!(fx.github.calls.borrow().iter().any(|c| c.starts_with("disable_auto")));
}

/// DR2 round 2: Stop during Update the release's setup kills it and gives the
/// release up as an open one is given up (`--disable-auto`), never as a
/// failed setup.
#[cfg(unix)]
#[test]
fn stop_during_update_the_releases_setup_gives_it_up() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &["check.sh"]);
    {
        let mut knobs = fx.github.knobs.borrow_mut();
        knobs.merges_at_once = false;
        knobs.checks = PrChecks::Pending;
    }
    let r = registries();
    fx.release_area(&r, ReleaseKind::PushOnly, &[CARD], "1.0.1").expect("on its way");
    fx.publish(&[("theirs.txt", "theirs\n")]);
    let started = fx._tmp.path().join("setup-started");
    let command = format!("touch '{}'; sleep 30", started.display());
    let setup = crate::worktree_setup::WorktreeSettings {
        worktree_setup: Some(command.clone()),
        approved_setup: Some(command),
        ..Default::default()
    };
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let setter = {
        let (stop, started) = (stop.clone(), started.clone());
        std::thread::spawn(move || {
            let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
            while !started.exists() && std::time::Instant::now() < until {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            stop.store(true, std::sync::atomic::Ordering::SeqCst);
        })
    };
    let handle = fx.app.handle();
    let ws_dir = handle.state::<ProjectConfigStore>().workspace_dir(&fx.ws_id);
    let config = handle.state::<ProjectConfigStore>().get(&fx.ws_id).unwrap();
    let place = Place {
        app: handle,
        workspace_id: &fx.ws_id,
        ws_cwd: &fx.ws,
        repo_root: &fx.ws,
        ws_dir: &ws_dir,
        config: &config,
        kanban: handle.state::<KanbanStore>().inner(),
    };
    let record = fx.record().unwrap();
    let begun = std::time::Instant::now();
    let err = fx.on_github(|| update(&place, record, &setup, Some(&stop))).unwrap_err();
    setter.join().unwrap();
    assert!(begun.elapsed() < std::time::Duration::from_secs(25), "the setup didn't run its 30 seconds");
    let ShipError::Stopped(stopped) = &err else { panic!("{err:?}") };
    assert!(stopped.stopped.on_github.as_deref().is_some_and(|s| s.contains("turned off merging #100")), "{err:?}");
    assert!(fx.github.calls.borrow().iter().any(|c| c.starts_with("disable_auto")));
    assert!(fx.record().is_none());
    assert_eq!(fx.github.prs.borrow()[0].state, PrState::Open);
}

/// DR2 round 1–2 (owner): "On this Mac only" with GitHub out of reach is
/// refused in words; nothing is made here.
#[test]
fn on_this_mac_only_offline_releases_nothing() {
    let fx = Fixture::new(&[("card.txt", "card\n")], &[]);
    let r = registries();
    git(&fx.ws, &["remote", "set-url", "origin", "/nonexistent/origin.git"]);
    let before = git(&fx.ws, &["rev-parse", "HEAD"]);
    let said = fx.release_area(&r, ReleaseKind::Local, &[], "1.0.1").unwrap_err().to_string();
    assert_eq!(said, crate::shared_config::offline_local_release_words("main"));
    assert_eq!(git(&fx.ws, &["rev-parse", "HEAD"]), before);
    assert!(git(&fx.ws, &["tag", "--list", "v1.0.1"]).is_empty());
}
