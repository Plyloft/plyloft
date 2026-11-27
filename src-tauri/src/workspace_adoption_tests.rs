//! Tests for adoption of the shared workspace definition (GH #81).

use super::*;
use crate::kanban::{KanbanCard, KanbanColumnId, KanbanStore};
use crate::project_config::{ProjectConfigStore, VerifyKind};
use crate::shared_config::{GitPublisher, Plumbing};
use crate::workspace::WorkspaceStore;
use crate::workspace_definition::{publish_pending, RepoFile};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;

// ── Fakes ─────────────────────────────────────────────────────────────

struct FakeRepo {
    default_branch: String,
    files: RefCell<HashMap<(String, String), Vec<u8>>>,
    /// The branch the folder is on: the default branch unless a test says
    /// otherwise (`None`: detached).
    here: Option<String>,
    /// Branches the folder's commit was built on (`RepoSource::built_on`).
    built_on: Vec<String>,
}

impl FakeRepo {
    fn new(default_branch: &str) -> Self {
        Self {
            default_branch: default_branch.to_string(),
            files: RefCell::new(HashMap::new()),
            here: Some(default_branch.to_string()),
            built_on: Vec::new(),
        }
    }
    fn on(mut self, branch: &str) -> Self {
        self.here = Some(branch.to_string());
        self
    }
    fn detached(mut self) -> Self {
        self.here = None;
        self
    }
    fn made_from(mut self, branch: &str) -> Self {
        self.built_on.push(branch.to_string());
        self
    }
    fn put(&self, branch: &str, path: &str, text: &str) {
        self.files
            .borrow_mut()
            .insert((branch.into(), path.into()), text.as_bytes().to_vec());
    }
}

impl RepoSource for FakeRepo {
    fn default_branch(&self) -> String {
        self.default_branch.clone()
    }
    fn fetch(&self, _branch: &str) -> Result<(), String> {
        Ok(())
    }
    fn read(&self, branch: &str, path: &str) -> Option<RepoFile> {
        self.files
            .borrow()
            .get(&(branch.to_string(), path.to_string()))
            .map(|bytes| RepoFile {
                bytes: bytes.clone(),
                commit: Some("abc".into()),
                author: Some("someone".into()),
                changed_at: Some(1_700_000_000),
            })
    }
    fn branch_exists(&self, branch: &str) -> bool {
        self.files.borrow().keys().any(|(b, _)| b == branch)
    }
    fn branches_with(&self, path: &str) -> Vec<String> {
        let mut branches: Vec<String> = self
            .files
            .borrow()
            .keys()
            .filter(|(_, p)| p == path)
            .map(|(b, _)| b.clone())
            .collect();
        branches.sort();
        branches
    }
    fn current_branch(&self) -> Option<String> {
        self.here.clone()
    }
    fn built_on(&self, named: &str) -> bool {
        self.built_on.iter().any(|b| b == named)
    }
}

fn config(target: &str) -> ProjectConfig {
    ProjectConfig {
        schema_version: crate::project_config::PROJECT_CONFIG_SCHEMA_VERSION,
        target_branch: target.into(),
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
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    workspaces: WorkspaceStore,
    configs: ProjectConfigStore,
    ws_id: String,
    allowed: bool,
}

impl Fixture {
    fn new(cwd: Option<&Path>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let project = cwd
            .map(Path::to_path_buf)
            .unwrap_or_else(|| dir.path().join("lyra"));
        std::fs::create_dir_all(&project).unwrap();
        let workspaces = WorkspaceStore::new(dir.path().join("config")).unwrap();
        let configs = ProjectConfigStore::new(dir.path().join("config")).unwrap();
        let ws = workspaces
            .create("LYRA".into(), project.to_string_lossy().into_owned())
            .unwrap();
        // The shared Name fills it in, as for a folder-named workspace.
        workspaces.set_name_chosen(&ws.id, Some(false)).unwrap();
        workspaces
            .set_accent_color(&ws.id, Some("#0ea5e9".into()))
            .unwrap();
        Self {
            _dir: dir,
            workspaces,
            configs,
            ws_id: ws.id,
            allowed: true,
        }
    }

    fn stores(&self) -> Stores<'_> {
        Stores {
            workspaces: &self.workspaces,
            project_configs: &self.configs,
            github_board_allowed: self.allowed,
        }
    }

    fn ws(&self) -> Workspace {
        self.workspaces
            .snapshot()
            .workspaces
            .into_iter()
            .find(|w| w.id == self.ws_id)
            .unwrap()
    }
}

fn facts() -> AdoptionFacts {
    AdoptionFacts {
        github_repo: Some("o/lyra".into()),
        repo_has_file: false,
        repo_has_own_file: false,
        cache: None,
        queue: PublishQueue::default(),
        declined: false,
        effective_board: None,
        effective_repo: None,
        local_board: KanbanSyncMode::Local,
        github_board_allowed: true,
        local_cards: 5,
        ask_before_board: false,
        in_team_manifest: false,
        board_kept_local: false,
    }
}

/// OB-8 (owner decision "ask first"): when only the free beta unlocks the
/// board, every switch and migration becomes a one-press offer; "Keep it on
/// this Mac" stops the offer; after "Move to GitHub Issues" (or with a key, or
/// under a paid tier) the automatic path is exactly today's.
#[test]
fn a_board_unlocked_only_by_the_free_beta_is_offered_not_moved() {
    let switch_local_definition = AdoptionFacts {
        cache: Some(cache_with(KanbanSyncMode::Local, DefinitionSource::Repo)),
        effective_board: Some(KanbanSyncMode::Local),
        ..facts()
    };
    let switch_held_board = AdoptionFacts {
        cache: Some(cache_with(KanbanSyncMode::GitHubIssues, DefinitionSource::Repo)),
        effective_board: Some(KanbanSyncMode::GitHubIssues),
        local_board: KanbanSyncMode::Local,
        ..facts()
    };
    let migrate = AdoptionFacts {
        cache: Some(cache_with(KanbanSyncMode::GitHubIssues, DefinitionSource::Repo)),
        effective_board: Some(KanbanSyncMode::GitHubIssues),
        local_board: KanbanSyncMode::GitHubIssues,
        ..facts()
    };
    for (case, automatic, cards_only) in [
        (&switch_held_board, AdoptionAction::SwitchBoard { local_cards: 5 }, false),
        (&migrate, AdoptionAction::MigrateCards { local_cards: 5 }, true),
    ] {
        // A key, or a paid tier, or "Move to GitHub Issues" already pressed:
        // today's automatic path.
        assert_eq!(decide(case).action, automatic);
        // Free-beta arrival: the offer, nothing else.
        let asked = decide(&AdoptionFacts { ask_before_board: true, ..case.clone() });
        assert_eq!(
            asked.action,
            AdoptionAction::OfferBoard { local_cards: 5, cards_only }
        );
        assert_eq!(asked.board_repo.as_deref(), Some("o/lyra"));
        // "Keep it on this Mac": not offered again on the board, but said —
        // Settings › Board keeps the press that moves it after all.
        let kept = decide(&AdoptionFacts {
            ask_before_board: true,
            board_kept_local: true,
            ..case.clone()
        });
        assert_eq!(
            kept.action,
            AdoptionAction::BoardKeptLocal { local_cards: 5, cards_only }
        );
    }
    // T1 (team walk): a workspace of the team this Mac is in moves as the
    // team's board does — joining was the consent — unless this Mac said
    // "Keep it on this Mac".
    for (case, automatic, cards_only) in [
        (&switch_held_board, AdoptionAction::SwitchBoard { local_cards: 5 }, false),
        (&migrate, AdoptionAction::MigrateCards { local_cards: 5 }, true),
    ] {
        let member = AdoptionFacts { ask_before_board: true, in_team_manifest: true, ..case.clone() };
        assert_eq!(decide(&member).action, automatic);
        assert_eq!(
            decide(&AdoptionFacts { board_kept_local: true, ..member }).action,
            AdoptionAction::BoardKeptLocal { local_cards: 5, cards_only }
        );
    }
    // R14: a definition that says Local is neither switched nor offered on
    // any path — a key, a paid tier, an earlier "Move" for the repository, a
    // team member; an earlier "Keep it on this Mac" stays said in Settings.
    for case in [
        switch_local_definition.clone(),
        AdoptionFacts { ask_before_board: true, ..switch_local_definition.clone() },
        AdoptionFacts { in_team_manifest: true, ..switch_local_definition.clone() },
    ] {
        assert_eq!(decide(&case).action, AdoptionAction::None);
        assert_eq!(
            decide(&AdoptionFacts { board_kept_local: true, ..case }).action,
            AdoptionAction::BoardKeptLocal { local_cards: 5, cards_only: false }
        );
    }
    // The question and the conversion are not board moves: unchanged.
    assert_eq!(
        decide(&AdoptionFacts { ask_before_board: true, ..facts() }).action,
        AdoptionAction::Ask
    );
    assert_eq!(
        serde_json::to_value(AdoptionAction::OfferBoard { local_cards: 2, cards_only: true }).unwrap(),
        serde_json::json!({ "kind": "offerBoard", "localCards": 2, "cardsOnly": true })
    );
    assert_eq!(
        serde_json::to_value(AdoptionAction::BoardKeptLocal { local_cards: 0, cards_only: false })
            .unwrap(),
        serde_json::json!({ "kind": "boardKeptLocal", "localCards": 0, "cardsOnly": false })
    );
}

/// OB-8 / launch G3: a refresh (and a board switch) runs GitHub Issues on its
/// own on the matching Team plan, and holds it in every other case. No case
/// asks first any more ("only the free beta opens it" is gone), so a recorded
/// "Keep it on this Mac" changes nothing on the Team plan, as it never did for
/// a key holder.
#[test]
fn a_refresh_runs_the_board_only_on_the_matching_team_plan() {
    use crate::license::{LicenseStore, PlanCase};
    use tauri::Manager;
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("lyra");
    std::fs::create_dir_all(&repo).unwrap();
    crate::git::run(&repo, &["init", "-q", "-b", "main"]).unwrap();
    crate::git::run(&repo, &["remote", "add", "origin", "https://github.com/o/lyra.git"]).unwrap();
    for case in PlanCase::ALL {
        let config = temp.path().join(format!("{case:?}"));
        let app = tauri::test::mock_builder()
            .manage(LicenseStore::for_plan_test(config.clone(), case))
            .manage(crate::settings::SettingsStore::new(config.clone()).unwrap())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        assert_eq!(github_board_runs_here(app.handle(), &repo), case.team_allowed(), "{case:?}");
        app.state::<crate::settings::SettingsStore>().set_board_choice("o/lyra", false).unwrap();
        assert_eq!(github_board_runs_here(app.handle(), &repo), case.team_allowed(), "{case:?}: kept");
    }
    let keyed = temp.path().join("keyed");
    let app = tauri::test::mock_builder()
        .manage(LicenseStore::new_team_allowed_for_test(keyed.clone()))
        .manage(crate::settings::SettingsStore::new(keyed).unwrap())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    assert!(github_board_runs_here(app.handle(), &repo), "the admission seam: automatic");
}

fn cache_with(board: KanbanSyncMode, source: DefinitionSource) -> DefinitionCache {
    let mut cache = DefinitionCache::empty();
    cache.definition = Some(WorkspaceDefinition {
        schema_version: 1,
        name: "LYRA".into(),
        accent_color: None,
        board,
        github_owner_repo: Some("o/lyra".into()),
        integration_branch: None,
        version_files: None,
        install_script: None,
        try_command: None,
        verify_pipeline: None,
        cache_paths: None,
        shared_build_cache: None,
        self_check: None,
        review_checklist: None,
        worktree_copy: None,
        worktree_setup: None,
        library: None,
        models: None,
        areas: None,
        release_kind: None,
        extra: BTreeMap::new(),
    });
    cache.source = source;
    cache
}

// ── The question ──────────────────────────────────────────────────────

#[test]
fn the_question_is_asked_for_a_github_repo_without_a_definition() {
    let status = decide(&facts());
    assert_eq!(status.action, AdoptionAction::Ask);
    assert!(!status.has_definition);
    assert_eq!(status.github_repo.as_deref(), Some("o/lyra"));
}

#[test]
fn a_repo_without_a_github_remote_is_never_asked() {
    let status = decide(&AdoptionFacts {
        github_repo: None,
        ..facts()
    });
    assert_eq!(status.action, AdoptionAction::None);

    // A real repository with no remote at all, then a GitLab one.
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-q", "-b", "main"]);
    assert_eq!(github_repo_at(dir.path()), None);
    git(
        dir.path(),
        &["remote", "add", "origin", "git@gitlab.com:o/lyra.git"],
    );
    assert_eq!(github_repo_at(dir.path()), None);
    git(
        dir.path(),
        &["remote", "set-url", "origin", "git@github.com:o/lyra.git"],
    );
    assert_eq!(github_repo_at(dir.path()).as_deref(), Some("o/lyra"));
}

#[test]
fn the_question_is_never_asked_with_a_definition_present() {
    // In the repo, not cached yet (the refresh hasn't run).
    let status = decide(&AdoptionFacts {
        repo_has_file: true,
        repo_has_own_file: true,
        ..facts()
    });
    assert_eq!(status.action, AdoptionAction::None);
    assert!(status.has_definition);
    // Cached, from the repo, already GitHub Issues.
    for source in [DefinitionSource::Repo, DefinitionSource::Seeded] {
        let status = decide(&AdoptionFacts {
            cache: Some(cache_with(KanbanSyncMode::GitHubIssues, source)),
            effective_board: Some(KanbanSyncMode::GitHubIssues),
            local_board: KanbanSyncMode::GitHubIssues,
            local_cards: 0,
            ..facts()
        });
        assert_eq!(status.action, AdoptionAction::None, "{source:?}");
        assert!(status.has_definition);
    }
    // A legacy workspace_default.json on the branch.
    let repo = FakeRepo::new("main");
    assert!(!repo_has_file(&repo, None));
    repo.put("staging", LEGACY_PATH, "{}");
    assert!(
        repo_has_file(&repo, None),
        "found on any of origin's branches"
    );
    assert!(repo_has_file(&repo, Some(&config("staging"))));
    // 1.172.0 (B1): the refresh's own branches only for `has_definition`.
    assert!(!repo_has_own_file(&repo, None), "staging is only scanned");
    assert!(repo_has_own_file(&repo, Some(&config("staging"))));
}

#[test]
fn not_on_this_mac_is_remembered_per_mac_and_repo() {
    let declined = vec!["o/lyra".to_string()];
    assert!(is_declined(&declined, "O/Lyra"));
    assert!(
        !is_declined(&declined, "o/climbr"),
        "another repo is still asked"
    );
    let status = decide(&AdoptionFacts {
        declined: is_declined(&declined, "o/lyra"),
        ..facts()
    });
    assert_eq!(status.action, AdoptionAction::None);

    // Settings round trip: a relaunch still remembers, and nothing is in the
    // repository.
    let dir = tempfile::tempdir().unwrap();
    let store = crate::settings::SettingsStore::new(dir.path().to_path_buf()).unwrap();
    let mut next = store.snapshot();
    next.sharing.not_on_this_mac.push(repo_key("O/Lyra"));
    store.replace(next).unwrap();
    let relaunched = crate::settings::SettingsStore::new(dir.path().to_path_buf()).unwrap();
    assert_eq!(
        relaunched.snapshot().sharing.not_on_this_mac,
        vec!["o/lyra"]
    );

    // Another Mac (fresh settings) is asked.
    let other = tempfile::tempdir().unwrap();
    let other = crate::settings::SettingsStore::new(other.path().to_path_buf()).unwrap();
    assert!(!is_declined(
        &other.snapshot().sharing.not_on_this_mac,
        "o/lyra"
    ));
}

#[test]
fn a_pre_81_settings_file_loads_with_no_declined_repos() {
    let dir = tempfile::tempdir().unwrap();
    let mut value = serde_json::to_value(crate::settings::Settings::default()).unwrap();
    value.as_object_mut().unwrap().remove("sharing");
    value["team"]["ignoredRepos"] = serde_json::json!(["o/x"]);
    let text = serde_json::to_string_pretty(&value).unwrap();
    std::fs::write(dir.path().join("settings.json"), &text).unwrap();
    let store = crate::settings::SettingsStore::new(dir.path().to_path_buf()).unwrap();
    let settings = store.snapshot();
    assert!(settings.sharing.not_on_this_mac.is_empty());
    assert_eq!(settings.team.ignored_repos, vec!["o/x"], "the rest is kept");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("settings.json")).unwrap(),
        text,
        "loading doesn't rewrite the file"
    );
}

#[test]
fn a_shared_repo_is_not_asked_again_while_its_creation_waits() {
    let mut queue = PublishQueue::default();
    queue.create_definition = true;
    let status = decide(&AdoptionFacts {
        cache: Some(cache_with(
            KanbanSyncMode::GitHubIssues,
            DefinitionSource::Seeded,
        )),
        queue,
        effective_board: Some(KanbanSyncMode::GitHubIssues),
        local_board: KanbanSyncMode::GitHubIssues,
        local_cards: 0,
        ..facts()
    });
    assert_eq!(status.action, AdoptionAction::None);
}

#[test]
fn team_workspaces_convert_without_a_question_and_keep_a_committed_local_board() {
    // Playground: only workspace_default.json, converted on this Mac.
    let status = decide(&AdoptionFacts {
        cache: Some(cache_with(KanbanSyncMode::Local, DefinitionSource::Legacy)),
        effective_board: Some(KanbanSyncMode::Local),
        ..facts()
    });
    assert_eq!(status.action, AdoptionAction::ConvertLegacy);
    // Published, board Local: the repository's board wins (R14) — nothing is
    // switched, offered or held; Settings › Board keeps the move.
    let status = decide(&AdoptionFacts {
        cache: Some(cache_with(KanbanSyncMode::Local, DefinitionSource::Repo)),
        effective_board: Some(KanbanSyncMode::Local),
        ..facts()
    });
    assert_eq!(status.action, AdoptionAction::None);
    assert_eq!(status.repo_board, Some(KanbanSyncMode::Local));
    // The licence gate refuses a GitHub Issues definition: the board stays
    // local and the banner says so.
    let status = decide(&AdoptionFacts {
        cache: Some(cache_with(KanbanSyncMode::GitHubIssues, DefinitionSource::Seeded)),
        effective_board: Some(KanbanSyncMode::GitHubIssues),
        github_board_allowed: false,
        ..facts()
    });
    assert!(
        matches!(&status.action, AdoptionAction::BoardHeld { reason } if reason.contains("licence")),
        "{status:?}"
    );
}

/// R14 (1.169.1): a committed Local board puts up no banner at all, on every
/// plan — Team (GitHub Issues allowed) and Free (refused) — whatever this Mac
/// runs or was told before; only an earlier "Keep it on this Mac" on a Mac
/// that may run GitHub Issues is still said (in Settings › Board).
#[test]
fn a_committed_local_board_puts_up_no_banner_on_any_plan() {
    let local = AdoptionFacts {
        cache: Some(cache_with(KanbanSyncMode::Local, DefinitionSource::Repo)),
        effective_board: Some(KanbanSyncMode::Local),
        ..facts()
    };
    for allowed in [true, false] {
        for local_board in [KanbanSyncMode::Local, KanbanSyncMode::GitHubIssues] {
            for (ask, member) in [(false, false), (true, false), (true, true)] {
                let status = decide(&AdoptionFacts {
                    github_board_allowed: allowed,
                    local_board,
                    ask_before_board: ask,
                    in_team_manifest: member,
                    ..local.clone()
                });
                assert_eq!(status.action, AdoptionAction::None, "allowed {allowed}, {local_board:?}");
                assert_eq!(status.repo_board, Some(KanbanSyncMode::Local));
            }
        }
        let kept = decide(&AdoptionFacts {
            github_board_allowed: allowed,
            board_kept_local: true,
            ..local.clone()
        });
        assert_eq!(
            kept.action,
            if allowed {
                AdoptionAction::BoardKeptLocal { local_cards: 5, cards_only: false }
            } else {
                AdoptionAction::None
            }
        );
    }
    // No definition, or no GitHub remote: the repository names no board.
    assert_eq!(decide(&facts()).repo_board, None);
    assert_eq!(decide(&AdoptionFacts { github_repo: None, ..local.clone() }).repo_board, None);
    assert_eq!(
        serde_json::to_value(decide(&local)).unwrap()["repoBoard"],
        serde_json::json!("local")
    );
}

#[test]
fn a_board_held_for_the_licence_switches_once_the_licence_arrives() {
    let held = AdoptionFacts {
        cache: Some(cache_with(
            KanbanSyncMode::GitHubIssues,
            DefinitionSource::Repo,
        )),
        effective_board: Some(KanbanSyncMode::GitHubIssues),
        local_board: KanbanSyncMode::Local,
        github_board_allowed: false,
        local_cards: 3,
        ..facts()
    };
    assert!(matches!(
        decide(&held).action,
        AdoptionAction::BoardHeld { .. }
    ));
    let licensed = AdoptionFacts {
        github_board_allowed: true,
        ..held.clone()
    };
    assert_eq!(
        decide(&licensed).action,
        AdoptionAction::SwitchBoard { local_cards: 3 }
    );
    assert_eq!(
        decide(&licensed).board_repo.as_deref(),
        Some("o/lyra"),
        "origin when unnamed"
    );
    // The definition's issue repository differs from origin: the switch and
    // the migration use it, never origin.
    let elsewhere = AdoptionFacts {
        effective_repo: Some("o/lyra-issues".into()),
        ..licensed
    };
    let status = decide(&elsewhere);
    assert_eq!(status.board_repo.as_deref(), Some("o/lyra-issues"));
    assert_eq!(status.github_repo.as_deref(), Some("o/lyra"));
    assert_eq!(
        serde_json::to_value(&status).unwrap()["boardRepo"],
        serde_json::json!("o/lyra-issues")
    );
}

#[test]
fn local_cards_migrate_on_a_mac_that_received_the_github_board() {
    let received = AdoptionFacts {
        cache: Some(cache_with(
            KanbanSyncMode::GitHubIssues,
            DefinitionSource::Repo,
        )),
        effective_board: Some(KanbanSyncMode::GitHubIssues),
        local_board: KanbanSyncMode::GitHubIssues,
        local_cards: 2,
        ..facts()
    };
    assert_eq!(
        decide(&received).action,
        AdoptionAction::MigrateCards { local_cards: 2 }
    );
    assert_eq!(
        decide(&AdoptionFacts {
            local_cards: 0,
            ..received.clone()
        })
        .action,
        AdoptionAction::None
    );
    assert_eq!(
        serde_json::to_value(AdoptionAction::MigrateCards { local_cards: 2 }).unwrap(),
        serde_json::json!({ "kind": "migrateCards", "localCards": 2 })
    );
}

// ── The seed ──────────────────────────────────────────────────────────

#[test]
fn the_seed_takes_this_macs_config_and_a_named_integration_branch() {
    let f = Fixture::new(None);
    let mut cfg = config("staging");
    cfg.version_files = vec![VersionFileEntry {
        path: "main.py".into(),
        kind: VersionFileKind::PythonModuleVar,
        variable_name: Some("__version__".into()),
    }];
    cfg.install_script = Some("scripts/install.sh".into());
    cfg.verify_pipeline = Some(vec![VerifyKind::Script {
        path: "scripts/verify.sh".into(),
    }]);
    cfg.cache_paths = vec![".venv".into()];
    cfg.shared_build_cache = false;
    cfg.try_command = Some("python3 manage.py runserver".into());
    let repo = FakeRepo::new("main");
    repo.put("staging", "pyproject.toml", "[project]\n");
    let seed = seed_definition(&f.ws(), Some(&cfg), &Default::default(), "o/lyra", &repo);
    assert_eq!(seed.name, "LYRA");
    assert_eq!(seed.accent_color.as_deref(), Some("#0ea5e9"));
    assert_eq!(seed.board, KanbanSyncMode::GitHubIssues);
    assert_eq!(seed.github_owner_repo.as_deref(), Some("o/lyra"));
    assert_eq!(seed.integration_branch.as_deref(), Some("staging"));
    assert_eq!(
        seed.version_files.as_ref().unwrap(),
        &cfg.version_files,
        "configured wins over detected"
    );
    assert_eq!(seed.install_script.as_deref(), Some("scripts/install.sh"));
    assert_eq!(seed.verify_pipeline, cfg.verify_pipeline);
    assert_eq!(seed.cache_paths, Some(vec![".venv".to_string()]));
    assert_eq!(seed.shared_build_cache, Some(false));
    // Try it: the start command travels with the build settings (D19).
    assert_eq!(seed.try_command.as_deref(), Some("python3 manage.py runserver"));
}

#[test]
fn the_seed_detects_the_default_branch_and_version_files() {
    let f = Fixture::new(None);
    let repo = FakeRepo::new("main");
    repo.put("main", "package.json", "{}");
    repo.put("main", "pyproject.toml", "[project]\n");
    repo.put("feature", "Cargo.toml", "[package]\n");
    // No local config at all.
    let seed = seed_definition(&f.ws(), None, &Default::default(), "o/climbr", &repo);
    assert_eq!(seed.integration_branch, None, "absent = the default branch");
    assert_eq!(seed.try_command, None, "no config, no start command in the seed itself");
    let paths: Vec<_> = seed
        .version_files
        .unwrap()
        .into_iter()
        .map(|v| (v.path, v.kind))
        .collect();
    assert_eq!(
        paths,
        vec![
            ("package.json".to_string(), VersionFileKind::PackageJson),
            ("pyproject.toml".to_string(), VersionFileKind::PyProjectToml),
        ]
    );
    // A local config naming the default branch doesn't pin it.
    let seed = seed_definition(&f.ws(), Some(&config("main")), &Default::default(), "o/climbr", &repo);
    assert_eq!(seed.integration_branch, None);
    assert!(seed.has_project());
    assert_eq!(seed.verify_pipeline, None);
}

/// Owner-side review of #122: a workspace with no project config keeps its
/// review settings in `review.json`; Share seeds the definition from them,
/// not from the defaults.
#[test]
fn the_seed_takes_the_review_settings_kept_without_a_config() {
    let f = Fixture::new(None);
    let repo = FakeRepo::new("main");
    let review = crate::project_config::ReviewSettings {
        blocking_findings: Default::default(),
        self_check: false,
        review_checklist: vec![crate::project_config::ReviewChecklistClass {
            name: "Branch discovery".into(),
            sentence: "Every lookup names its remote.".into(),
        }],
    };
    let seed = seed_definition(&f.ws(), None, &review, "o/climbr", &repo);
    assert_eq!(seed.self_check, Some(false));
    assert_eq!(seed.review_checklist, Some(review.review_checklist.clone()));
    // Nothing kept anywhere: the switch is on and there are no classes.
    let seed = seed_definition(&f.ws(), None, &Default::default(), "o/climbr", &repo);
    assert_eq!(seed.self_check, Some(true));
    assert_eq!(seed.review_checklist, Some(Vec::new()));
}

// ── .gitignore ────────────────────────────────────────────────────────

const CARVED: &str = ".atelier/*\n!.atelier/workspace.json\n!.atelier/library/\n!.atelier/workspace_default.json\n!.atelier/shared-cargo-target\n";

#[test]
fn a_gitignore_hiding_the_atelier_dir_gets_the_carve_out() {
    let fixed = fix_gitignore(Some("node_modules/\n.atelier/\n.env\n")).unwrap();
    assert_eq!(fixed, format!("node_modules/\n{CARVED}.env\n"));
    // Idempotent.
    assert_eq!(fix_gitignore(Some(&fixed)), None);
    // Other spellings, and a second rule, go too.
    let fixed = fix_gitignore(Some("/.atelier\n# x\n.atelier")).unwrap();
    assert_eq!(fixed, format!("{}# x", CARVED));
}

#[test]
fn a_gitignore_hiding_the_contents_gets_the_missing_exceptions() {
    let fixed = fix_gitignore(Some("target/\n.atelier/*\n!.atelier/library/\ndist/\n")).unwrap();
    assert_eq!(
        fixed,
        "target/\n.atelier/*\n!.atelier/workspace.json\n!.atelier/workspace_default.json\n!.atelier/shared-cargo-target\n!.atelier/library/\ndist/\n"
    );
    assert_eq!(fix_gitignore(Some(&fixed)), None);
    // Ply's own .gitignore needs nothing.
    let ply = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.gitignore"))
        .unwrap();
    assert_eq!(fix_gitignore(Some(&ply)), None);
}

#[test]
fn the_exceptions_follow_the_last_rule_that_ignores_the_contents() {
    // A whole-directory rule and a contents rule: one contents rule stays,
    // the exceptions after it.
    assert_eq!(
        fix_gitignore(Some(".atelier/\nbuild/\n.atelier/*\n")).unwrap(),
        format!("build/\n{CARVED}")
    );
    // An exception before a later contents rule is ignored again: the
    // exceptions go after the last one. A recursive rule would still hide
    // the library's files: it becomes `.atelier/*`.
    let fixed = fix_gitignore(Some(".atelier/*\n!.atelier/workspace.json\n.atelier/**\n")).unwrap();
    assert_eq!(
        fixed,
        format!(".atelier/*\n!.atelier/workspace.json\n{CARVED}")
    );
    assert_eq!(fix_gitignore(Some(&fixed)), None);
}

/// What git itself ignores after the rewrite, for every shape.
#[test]
fn after_the_rewrite_git_tracks_the_shared_files_and_ignores_the_rest() {
    for shape in [
        ".atelier/\n",
        "/.atelier\n",
        ".atelier/*\n",
        ".atelier/**\n",
        ".atelier/\n.atelier/*\n",
        ".atelier/*\n!.atelier/workspace.json\n.atelier/**\n",
    ] {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q", "-b", "main"]);
        let fixed = fix_gitignore(Some(shape)).unwrap();
        std::fs::write(dir.path().join(".gitignore"), &fixed).unwrap();
        let ignored = |path: &str| {
            crate::platform::git_command()
                .args(["check-ignore", "-q", "--no-index", path])
                .current_dir(dir.path())
                .status()
                .unwrap()
                .success()
        };
        for tracked in [
            ".atelier/workspace.json",
            ".atelier/workspace_default.json",
            ".atelier/library/prompts/p.md",
            ".atelier/library/templates/deep/t.json",
            ".atelier/shared-cargo-target",
        ] {
            assert!(
                !ignored(tracked),
                "{shape:?}: {tracked} ignored by\n{fixed}"
            );
        }
        for hidden in [".atelier/runs/r.json", ".atelier/cache/x"] {
            assert!(
                ignored(hidden),
                "{shape:?}: {hidden} not ignored by\n{fixed}"
            );
        }
    }
}

#[test]
fn a_legacy_file_only_on_another_branch_is_found_and_belongs_there() {
    let f = Fixture::new(None);
    let repo = FakeRepo::new("main");
    repo.put(
        "staging",
        LEGACY_PATH,
        r#"{ "name": "LYRA", "kanbanSyncMode": "local" }"#,
    );
    assert!(repo_has_file(&repo, None), "no question for the newcomer");
    let report = refresh_with(&f.stores(), &repo, &f.ws_id, RefreshMoment::Open).unwrap();
    assert!(report.has_definition);
    assert_eq!(report.source, Some(DefinitionSource::Legacy));
    assert_eq!(report.branch.as_deref(), Some("staging"));
    let cache = load_cache(&f.configs, &f.ws_id).unwrap();
    assert_eq!(
        cache.definition.unwrap().integration_branch.as_deref(),
        Some("staging"),
        "the conversion is published to staging, not main"
    );
    assert_eq!(f.configs.get(&f.ws_id).unwrap().target_branch, "staging");
}

#[test]
fn a_missing_status_label_is_created_by_the_next_sync() {
    let _guard = crate::github::test_serial_lock();
    let dir = tempfile::tempdir().unwrap();
    let store = KanbanStore::new(dir.path().to_path_buf()).unwrap();
    let mut card = KanbanCard::new(
        "doing".into(),
        "ws".into(),
        "Doing".into(),
        Some("brief".into()),
        KanbanColumnId::InProgress,
    );
    card.gh_issue_number = Some(4);
    card.gh_labels_pending = true;
    store.create_card("ws", card).unwrap();
    assert!(!crate::github_sync::status_label_missing(
        "error connecting to api.github.com"
    ));

    crate::github::take_test_gh_invocations();
    crate::github::set_test_gh_responses(vec![
        Err("failed to update https://github.com/o/lyra/issues/4: 'status:in-progress' not found".into()),
        Ok(String::new()),
        Ok(String::new()),
        Ok(String::new()),
        Ok(String::new()),
        Ok(r#"[{"number":4,"title":"Doing","body":"<!-- atelier:notes -->\nbrief\n<!-- /atelier:notes -->\n","assignees":[],"labels":[{"name":"status:in-progress"}],"state":"OPEN","updatedAt":""}]"#.into()),
    ]);
    crate::github_sync::reconcile(&store, "ws", "o/lyra", None, &Default::default()).unwrap();
    let calls = crate::github::take_test_gh_invocations();
    crate::github::clear_test_gh_responses();
    let joined: Vec<String> = calls.iter().map(|c| c.join(" ")).collect();
    assert!(
        joined[1].starts_with("label create status:todo --repo o/lyra"),
        "{joined:?}"
    );
    assert!(
        joined[3].starts_with("label create status:done"),
        "{joined:?}"
    );
    assert!(
        joined[4].starts_with("issue edit 4 --repo o/lyra --add-label status:in-progress"),
        "{joined:?}"
    );
    let card = store.get_card("ws", "doing").unwrap();
    assert!(!card.gh_labels_pending);
    assert_eq!(card.column_id, KanbanColumnId::InProgress);
}

#[test]
fn a_reconcile_retry_of_a_failed_migration_keeps_the_card_status() {
    let _guard = crate::github::test_serial_lock();
    let dir = tempfile::tempdir().unwrap();
    let store = KanbanStore::new(dir.path().to_path_buf()).unwrap();
    store
        .create_card(
            "ws",
            KanbanCard::new(
                "done".into(),
                "ws".into(),
                "Shipped".into(),
                Some("brief".into()),
                KanbanColumnId::Complete,
            ),
        )
        .unwrap();
    // The migration's create failed: the card waits for Sync.
    crate::github::set_test_gh_responses(vec![Err("offline".into())]);
    let summary = crate::github_sync::push_local(&store, "ws", "o/lyra", &Default::default()).unwrap();
    assert_eq!(summary.failed, 1);
    assert!(store.get_card("ws", "done").unwrap().sync_pending);

    // Sync: the retry creates the issue with its status label before pulling.
    crate::github::take_test_gh_invocations();
    crate::github::set_test_gh_responses(vec![
        Ok("https://github.com/o/lyra/issues/9".into()),
        Ok(String::new()),
        Ok(r#"[{"number":9,"title":"Shipped","body":"<!-- atelier:notes -->\nbrief\n<!-- /atelier:notes -->\n","assignees":[],"labels":[{"name":"status:done"}],"state":"OPEN","updatedAt":""}]"#.into()),
    ]);
    crate::github_sync::reconcile(&store, "ws", "o/lyra", None, &Default::default()).unwrap();
    let calls = crate::github::take_test_gh_invocations();
    crate::github::clear_test_gh_responses();
    let labels = calls[1].join(" ");
    assert!(
        labels.starts_with("issue edit 9 --repo o/lyra --add-label status:done"),
        "{calls:?}"
    );
    let card = store.get_card("ws", "done").unwrap();
    assert_eq!(card.gh_issue_number, Some(9));
    assert_eq!(card.column_id, KanbanColumnId::Complete);
    assert!(!card.sync_pending && !card.gh_labels_pending);
}

#[test]
fn a_gitignore_without_an_atelier_rule_is_left_alone() {
    assert_eq!(fix_gitignore(None), None);
    assert_eq!(fix_gitignore(Some("")), None);
    assert_eq!(
        fix_gitignore(Some("node_modules/\n.atelier-worktrees/\n")),
        None
    );
}

// ── Local cards become issues ─────────────────────────────────────────

#[test]
fn local_cards_become_issues_with_their_brief_and_status_labels() {
    let _guard = crate::github::test_serial_lock();
    let dir = tempfile::tempdir().unwrap();
    let store = KanbanStore::new(dir.path().to_path_buf()).unwrap();
    let card = |id: &str, title: &str, notes: &str, col: KanbanColumnId| {
        KanbanCard::new(
            id.into(),
            "ws".into(),
            title.into(),
            Some(notes.into()),
            col,
        )
    };
    store
        .create_card(
            "ws",
            card("a", "Todo card", "The brief of A", KanbanColumnId::Todo),
        )
        .unwrap();
    store
        .create_card(
            "ws",
            card(
                "b",
                "Doing card",
                "The brief of B",
                KanbanColumnId::InProgress,
            ),
        )
        .unwrap();
    let mut archived = card("c", "Old card", "gone", KanbanColumnId::Complete);
    archived.archived = true;
    store.create_card("ws", archived).unwrap();

    crate::github::take_test_gh_invocations();
    crate::github::take_test_gh_stdin();
    crate::github::set_test_gh_responses(vec![
        Ok("https://github.com/o/lyra/issues/11".into()),
        Ok(String::new()),
        Ok("https://github.com/o/lyra/issues/12".into()),
        Ok(String::new()),
    ]);
    let summary = crate::github_sync::push_local(&store, "ws", "o/lyra", &Default::default()).unwrap();
    let calls = crate::github::take_test_gh_invocations();
    let fed = crate::github::take_test_gh_stdin();
    crate::github::clear_test_gh_responses();

    assert_eq!(summary.pushed, 2);
    assert_eq!(summary.failed, 0);
    assert_eq!(calls.len(), 4, "{calls:?}");
    let create = &calls[0];
    assert_eq!(&create[..4], ["issue", "create", "--repo", "o/lyra"]);
    // 1.175.0 D4 (TM-9): the body goes to gh on stdin, never as an argument.
    assert_eq!(&create[create.len() - 2..], ["--body-file", "-"], "{create:?}");
    assert_eq!(fed.len(), 2, "one body for each issue created: {fed:?}");
    let body = &fed[0];
    assert!(
        body.contains("<!-- atelier:notes -->\nThe brief of A\n<!-- /atelier:notes -->"),
        "{body}"
    );
    let labels = calls[1].join(" ");
    assert!(
        labels.starts_with("issue edit 11 --repo o/lyra --add-label status:todo"),
        "{labels}"
    );
    let labels = calls[3].join(" ");
    assert!(
        labels.contains("issue edit 12") && labels.contains("--add-label status:in-progress"),
        "{labels}"
    );

    let cards = store.load("ws").unwrap();
    let by_id = |id: &str| cards.iter().find(|c| c.id == id).unwrap().clone();
    assert_eq!(by_id("a").gh_issue_number, Some(11));
    assert_eq!(by_id("b").gh_issue_number, Some(12));
    assert_eq!(by_id("b").column_id, KanbanColumnId::InProgress);
    assert!(!by_id("a").sync_pending && !by_id("a").gh_labels_pending);
    assert_eq!(
        by_id("c").gh_issue_number,
        None,
        "archived cards stay local"
    );

    // The pull that follows keeps each card's column and brief.
    let issue = |n: u64, title: &str, body: &str, label: &str| crate::github::GhIssue {
        number: n,
        title: title.into(),
        body: body.into(),
        assignees: Vec::new(),
        labels: vec![crate::github::GhLabel { name: label.into() }],
        state: "open".into(),
        updated_at: String::new(),
        author: None,
        created_at: None,
        state_reason: None,
        origin: None,
    };
    let plan = crate::github_sync::reconcile_plan(
        &[
            issue(
                11,
                "Todo card",
                &crate::github::build_issue_body(Some("The brief of A"), None, None),
                "status:todo",
            ),
            issue(
                12,
                "Doing card",
                &crate::github::build_issue_body(Some("The brief of B"), None, None),
                "status:in-progress",
            ),
        ],
        &cards,
    );
    assert!(plan.actions.is_empty(), "{:?}", plan.actions);
}

#[test]
fn an_edit_made_while_its_issue_was_created_stays_pending() {
    let dir = tempfile::tempdir().unwrap();
    let store = KanbanStore::new(dir.path().to_path_buf()).unwrap();
    let card = |id: &str| {
        KanbanCard::new(
            id.into(),
            "ws".into(),
            "Title".into(),
            Some("old brief".into()),
            KanbanColumnId::Todo,
        )
    };
    store.create_card("ws", card("edited")).unwrap();
    store.create_card("ws", card("untouched")).unwrap();
    let uploaded_edited = store.get_card("ws", "edited").unwrap();
    let uploaded_untouched = store.get_card("ws", "untouched").unwrap();
    // While `gh issue create` runs, the user edits one card: the edit path
    // flags it pending (it has no issue yet).
    store
        .with_card("ws", "edited", |c| {
            c.notes = Some("new brief".into());
            c.sync_pending = true;
            Ok(())
        })
        .unwrap();
    crate::github_sync::stamp_pushed(&store, "ws", &uploaded_edited, 21).unwrap();
    crate::github_sync::stamp_pushed(&store, "ws", &uploaded_untouched, 22).unwrap();
    let edited = store.get_card("ws", "edited").unwrap();
    assert_eq!(edited.gh_issue_number, Some(21));
    assert!(edited.sync_pending, "the next Sync pushes the new brief");
    assert_eq!(edited.notes.as_deref(), Some("new brief"));
    let untouched = store.get_card("ws", "untouched").unwrap();
    assert_eq!(untouched.gh_issue_number, Some(22));
    assert!(!untouched.sync_pending);

    // The Sync that follows pushes the edit before pulling.
    let _guard = crate::github::test_serial_lock();
    crate::github::take_test_gh_invocations();
    crate::github::take_test_gh_stdin();
    crate::github::set_test_gh_responses(vec![
        // 1.173.0 (C2): the live claim marker is read before the edit.
        // 1.175.0 (D3): the issue has the card's title, so only the brief
        // is written (a pending card with no baseline writes each part
        // that differs, alone).
        Ok(r#"{"number":21,"title":"Title","body":""}"#.into()),
        Ok(String::new()),
        Ok(String::new()),
        Ok(r#"[]"#.into()),
        // TM-5: no open issue for these cards, so the closed ones are read.
        Ok(r#"[]"#.into()),
    ]);
    crate::github_sync::reconcile(&store, "ws", "o/lyra", None, &Default::default()).unwrap();
    let calls = crate::github::take_test_gh_invocations();
    let fed = crate::github::take_test_gh_stdin();
    crate::github::clear_test_gh_responses();
    assert!(calls[0].join(" ").starts_with("issue view 21"), "{calls:?}");
    let edit = calls[1].join(" ");
    assert!(edit.starts_with("issue edit 21 --repo o/lyra"), "{calls:?}");
    // 1.175.0 D4 (TM-9): the new brief goes to gh on stdin.
    assert!(edit.ends_with("--body-file -"), "{edit}");
    assert!(!edit.contains("--title"), "{edit}");
    assert!(fed.iter().any(|body| body.contains("new brief")), "{fed:?}");
    assert!(!store.get_card("ws", "edited").unwrap().sync_pending);
}

#[test]
fn a_card_deleted_while_its_issue_was_created_closes_the_issue() {
    let _guard = crate::github::test_serial_lock();
    let dir = tempfile::tempdir().unwrap();
    let store = KanbanStore::new(dir.path().to_path_buf()).unwrap();
    store
        .create_card(
            "ws",
            KanbanCard::new(
                "gone".into(),
                "ws".into(),
                "Gone".into(),
                None,
                KanbanColumnId::Todo,
            ),
        )
        .unwrap();
    store
        .create_card(
            "ws",
            KanbanCard::new(
                "kept".into(),
                "ws".into(),
                "Kept".into(),
                None,
                KanbanColumnId::Todo,
            ),
        )
        .unwrap();
    let uploaded = store.get_card("ws", "gone").unwrap();
    store.delete_card("ws", "gone").unwrap();
    crate::github::take_test_gh_invocations();
    crate::github::set_test_gh_responses(vec![Ok(String::new())]);
    assert!(!crate::github_sync::settle_pushed(
        &store, "o/lyra", "ws", &uploaded, 31
    ));
    let calls = crate::github::take_test_gh_invocations();
    crate::github::clear_test_gh_responses();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0].join(" "), "issue close 31 --repo o/lyra");
    // The rest of the batch goes on.
    let kept = store.get_card("ws", "kept").unwrap();
    assert!(crate::github_sync::settle_pushed(
        &store, "o/lyra", "ws", &kept, 32
    ));
    assert_eq!(
        store.get_card("ws", "kept").unwrap().gh_issue_number,
        Some(32)
    );
}

#[test]
fn a_stamped_card_is_never_deleted_locally_and_a_deleted_one_is_never_stamped() {
    let _guard = crate::github::test_serial_lock();
    let dir = tempfile::tempdir().unwrap();
    let store = KanbanStore::new(dir.path().to_path_buf()).unwrap();
    let new = |id: &str| {
        KanbanCard::new(
            id.into(),
            "ws".into(),
            id.into(),
            None,
            KanbanColumnId::Todo,
        )
    };
    store.create_card("ws", new("stamped")).unwrap();
    store.create_card("ws", new("deleted")).unwrap();
    // Stamp first, delete after: the delete refuses the GitHub card.
    let uploaded = store.get_card("ws", "stamped").unwrap();
    assert!(crate::github_sync::settle_pushed(
        &store, "o/lyra", "ws", &uploaded, 41
    ));
    assert!(!store.delete_card_without_issue("ws", "stamped").unwrap());
    assert_eq!(
        store.get_card("ws", "stamped").unwrap().gh_issue_number,
        Some(41)
    );
    // Delete first, stamp after: the stamp finds nothing, the issue is closed.
    let uploaded = store.get_card("ws", "deleted").unwrap();
    assert!(store.delete_card_without_issue("ws", "deleted").unwrap());
    crate::github::take_test_gh_invocations();
    crate::github::set_test_gh_responses(vec![Ok(String::new())]);
    assert!(!crate::github_sync::settle_pushed(
        &store, "o/lyra", "ws", &uploaded, 42
    ));
    let calls = crate::github::take_test_gh_invocations();
    crate::github::clear_test_gh_responses();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0].join(" "), "issue close 42 --repo o/lyra");
    assert!(store.get_card("ws", "deleted").is_err());
}

#[test]
fn a_failed_close_of_an_orphan_issue_restores_the_card_with_it() {
    let _guard = crate::github::test_serial_lock();
    let dir = tempfile::tempdir().unwrap();
    let store = KanbanStore::new(dir.path().to_path_buf()).unwrap();
    store
        .create_card(
            "ws",
            KanbanCard::new(
                "gone".into(),
                "ws".into(),
                "Gone".into(),
                Some("b".into()),
                KanbanColumnId::Todo,
            ),
        )
        .unwrap();
    let uploaded = store.get_card("ws", "gone").unwrap();
    store.delete_card("ws", "gone").unwrap();
    crate::github::set_test_gh_responses(vec![Err("error connecting to api.github.com".into())]);
    assert!(crate::github_sync::settle_pushed(
        &store, "o/lyra", "ws", &uploaded, 33
    ));
    crate::github::clear_test_gh_responses();
    let back = store.get_card("ws", "gone").unwrap();
    assert_eq!(
        back.gh_issue_number,
        Some(33),
        "matched to its issue: Sync imports no second card"
    );
    assert!(!back.sync_pending);
    // The next Sync's pull sees the issue already has its card.
    let issue = crate::github::GhIssue {
        number: 33,
        title: "Gone".into(),
        body: crate::github::build_issue_body(Some("b"), None, None),
        assignees: Vec::new(),
        labels: vec![crate::github::GhLabel {
            name: "status:todo".into(),
        }],
        state: "open".into(),
        updated_at: String::new(),
        author: None,
        created_at: None,
        state_reason: None,
        origin: None,
    };
    let plan = crate::github_sync::reconcile_plan(&[issue], &store.load("ws").unwrap());
    assert!(
        !plan
            .actions
            .iter()
            .any(|a| matches!(a, crate::github_sync::ReconcileAction::Create(_))),
        "{:?}",
        plan.actions
    );
}

#[test]
fn branch_discovery_sees_every_branch_of_origin() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("origin.git")).unwrap();
    git(
        &root.join("origin.git"),
        &["init", "-q", "--bare", "-b", "main"],
    );
    git(root, &["clone", "-q", "origin.git", "seed"]);
    let seed = root.join("seed");
    git(&seed, &["config", "user.name", "seed"]);
    git(&seed, &["config", "user.email", "seed@example.com"]);
    git(&seed, &["checkout", "-q", "-b", "main"]);
    std::fs::write(seed.join("a.txt"), "a\n").unwrap();
    git(&seed, &["add", "."]);
    git(
        &seed,
        &[
            "commit",
            "-q",
            "-m",
            "init",
            "--date",
            "2020-01-01T00:00:00",
        ],
    );
    git(&seed, &["push", "-q", "origin", "main"]);
    // The integration branch, old.
    git(&seed, &["checkout", "-q", "-b", "staging"]);
    std::fs::create_dir_all(seed.join(".atelier")).unwrap();
    std::fs::write(
        seed.join(DEFINITION_PATH),
        r#"{ "name": "LYRA", "integrationBranch": "staging" }"#,
    )
    .unwrap();
    git(&seed, &["add", "."]);
    crate::platform::git_command()
        .args(["commit", "-q", "-m", "definition"])
        .env("GIT_COMMITTER_DATE", "2020-01-02T00:00:00")
        .current_dir(&seed)
        .status()
        .unwrap();
    git(&seed, &["push", "-q", "origin", "staging"]);
    // 60 newer branches without it.
    git(&seed, &["checkout", "-q", "main"]);
    std::fs::write(seed.join("a.txt"), "b\n").unwrap();
    git(&seed, &["commit", "-q", "-am", "newer"]);
    let refspecs: Vec<String> = (0..60)
        .map(|n| format!("HEAD:refs/heads/card-{n}"))
        .collect();
    let mut push = vec!["push", "-q", "origin"];
    push.extend(refspecs.iter().map(String::as_str));
    git(&seed, &push);
    git(root, &["clone", "-q", "origin.git", "fresh"]);
    let repo = crate::workspace_definition::GitRepo {
        cwd: root.join("fresh"),
    };
    assert_eq!(
        repo.branches_with(DEFINITION_PATH),
        vec!["staging".to_string()]
    );
    assert!(repo_has_file(&repo, None));
    let f = Fixture::new(Some(&root.join("fresh")));
    let report = refresh_with(&f.stores(), &repo, &f.ws_id, RefreshMoment::Open).unwrap();
    assert!(report.has_definition);
    assert_eq!(report.branch.as_deref(), Some("staging"));
}

#[test]
fn share_keeps_the_issue_repository_of_a_board_already_on_github_issues() {
    let f = Fixture::new(None);
    f.workspaces
        .set_kanban_sync(
            &f.ws_id,
            KanbanSyncMode::GitHubIssues,
            Some("o/lyra-issues".into()),
        )
        .unwrap();
    let repo = FakeRepo::new("main");
    let seed = seed_definition(&f.ws(), None, &Default::default(), "o/lyra", &repo);
    assert_eq!(seed.github_owner_repo.as_deref(), Some("o/lyra-issues"));
    // A Local board takes origin.
    let g = Fixture::new(None);
    g.workspaces
        .set_kanban_sync(&g.ws_id, KanbanSyncMode::Local, None)
        .unwrap();
    let seed = seed_definition(&g.ws(), None, &Default::default(), "o/lyra", &repo);
    assert_eq!(seed.github_owner_repo.as_deref(), Some("o/lyra"));
}

#[test]
fn a_move_while_the_issue_was_created_keeps_the_label_push_pending() {
    let dir = tempfile::tempdir().unwrap();
    let store = KanbanStore::new(dir.path().to_path_buf()).unwrap();
    store
        .create_card(
            "ws",
            KanbanCard::new(
                "m".into(),
                "ws".into(),
                "M".into(),
                None,
                KanbanColumnId::Todo,
            ),
        )
        .unwrap();
    let uploaded = store.get_card("ws", "m").unwrap();
    // Moved after its label went on, before the number was stamped: the
    // move's push saw no issue and only flagged sync_pending.
    store
        .with_card("ws", "m", |c| {
            c.column_id = KanbanColumnId::InProgress;
            c.sync_pending = true;
            Ok(())
        })
        .unwrap();
    crate::github_sync::stamp_pushed(&store, "ws", &uploaded, 51).unwrap();
    let card = store.get_card("ws", "m").unwrap();
    assert_eq!(card.gh_issue_number, Some(51));
    assert!(!card.sync_pending, "title and body went up as they are");
    assert!(
        card.gh_labels_pending,
        "the move reaches GitHub on the next Sync"
    );
    // The pull keeps the column while its label is pending.
    let issue = crate::github::GhIssue {
        number: 51,
        title: "M".into(),
        body: String::new(),
        assignees: Vec::new(),
        labels: vec![crate::github::GhLabel {
            name: "status:todo".into(),
        }],
        state: "open".into(),
        updated_at: String::new(),
        author: None,
        created_at: None,
        state_reason: None,
        origin: None,
    };
    let plan = crate::github_sync::reconcile_plan(&[issue], &store.load("ws").unwrap());
    for action in &plan.actions {
        if let crate::github_sync::ReconcileAction::Patch { column_id, .. } = action {
            assert_eq!(*column_id, None, "{:?}", plan.actions);
        }
    }
}

#[test]
fn an_unreadable_definition_found_by_discovery_is_reported() {
    let f = Fixture::new(None);
    let repo = FakeRepo::new("main");
    repo.put(
        "staging",
        DEFINITION_PATH,
        "{ \"name\": \"LYRA\",\n  \"board\": oops }",
    );
    assert!(repo_has_file(&repo, None));
    let report = refresh_with(&f.stores(), &repo, &f.ws_id, RefreshMoment::Open).unwrap();
    assert!(!report.has_definition);
    let bad = report.unreadable.expect("reported, not skipped");
    assert_eq!(bad.line, Some(2));
    let cache = load_cache(&f.configs, &f.ws_id).expect("the Doctor row reads it");
    assert!(cache.unreadable.is_some() && cache.definition.is_none());
    // A readable definition elsewhere still wins over it.
    repo.put(
        "release",
        DEFINITION_PATH,
        r#"{ "name": "LYRA", "integrationBranch": "release" }"#,
    );
    let g = Fixture::new(None);
    let report = refresh_with(&g.stores(), &repo, &g.ws_id, RefreshMoment::Open).unwrap();
    assert!(
        report.has_definition && report.unreadable.is_none(),
        "{report:?}"
    );
    assert_eq!(report.branch.as_deref(), Some("release"));
}

#[test]
fn an_unreadable_legacy_file_found_by_discovery_is_reported() {
    let f = Fixture::new(None);
    let repo = FakeRepo::new("main");
    repo.put("staging", LEGACY_PATH, "{\n  \"name\": ,\n}");
    assert!(repo_has_file(&repo, None));
    let report = refresh_with(&f.stores(), &repo, &f.ws_id, RefreshMoment::Open).unwrap();
    assert!(!report.has_definition);
    let bad = report.unreadable.expect("reported, not skipped");
    assert_eq!(bad.path, LEGACY_PATH);
    assert_eq!(bad.line, Some(2));
    assert!(load_cache(&f.configs, &f.ws_id)
        .unwrap()
        .unreadable
        .is_some());
}

#[test]
fn a_definition_only_on_a_deleted_branch_is_never_adopted() {
    let (dir, work) = lyra();
    let origin = dir.path().join("origin.git");
    // The only definition lives on a branch that is later deleted on origin.
    let seed = dir.path().join("seed");
    git(&seed, &["checkout", "-q", "-b", "old-setup"]);
    std::fs::create_dir_all(seed.join(".atelier")).unwrap();
    std::fs::write(
        seed.join(DEFINITION_PATH),
        r#"{ "name": "Old", "board": "githubIssues", "githubOwnerRepo": "o/lyra", "integrationBranch": "old-setup" }"#,
    )
    .unwrap();
    git(&seed, &["add", "-f", "."]);
    git(&seed, &["commit", "-q", "-m", "old setup"]);
    git(&seed, &["push", "-q", "origin", "old-setup"]);
    git(&work, &["fetch", "-q", "origin"]);
    assert!(git(&work, &["branch", "-r"]).contains("origin/old-setup"));
    git(&origin, &["branch", "-D", "old-setup"]);

    let repo = crate::workspace_definition::GitRepo { cwd: work.clone() };
    let f = Fixture::new(Some(&work));
    let report = refresh_with(&f.stores(), &repo, &f.ws_id, RefreshMoment::Open).unwrap();
    assert!(!report.has_definition, "{report:?}");
    assert!(
        !git(&work, &["branch", "-r"]).contains("origin/old-setup"),
        "pruned"
    );
    assert!(!repo_has_file(&repo, None));

    // Offline with the stale ref still there: nothing is scanned or adopted.
    git(
        &work,
        &[
            "update-ref",
            "refs/remotes/origin/old-setup",
            &git(&seed, &["rev-parse", "HEAD"]),
        ],
    );
    git(
        &work,
        &["remote", "set-url", "origin", "/nonexistent/origin.git"],
    );
    let report = refresh_with(&f.stores(), &repo, &f.ws_id, RefreshMoment::Open).unwrap();
    assert!(!report.has_definition, "{report:?}");
    assert!(load_cache(&f.configs, &f.ws_id).is_none());
}

#[test]
fn a_failed_label_push_is_retried_on_the_next_sync() {
    let _guard = crate::github::test_serial_lock();
    let dir = tempfile::tempdir().unwrap();
    let store = KanbanStore::new(dir.path().to_path_buf()).unwrap();
    store
        .create_card(
            "ws",
            KanbanCard::new(
                "a".into(),
                "ws".into(),
                "A".into(),
                Some("b".into()),
                KanbanColumnId::InProgress,
            ),
        )
        .unwrap();
    crate::github::set_test_gh_responses(vec![
        Ok("https://github.com/o/lyra/issues/3".into()),
        Err("error connecting to api.github.com".into()),
    ]);
    let summary = crate::github_sync::push_local(&store, "ws", "o/lyra", &Default::default()).unwrap();
    crate::github::clear_test_gh_responses();
    assert_eq!(summary.pushed, 1);
    let card = store.get_card("ws", "a").unwrap();
    assert_eq!(card.gh_issue_number, Some(3));
    assert!(card.gh_labels_pending);
}

// ── The licence gate holds the board ──────────────────────────────────

#[test]
fn an_unlicensed_mac_keeps_a_local_board_and_publishes_no_board_edit() {
    let mut f = Fixture::new(None);
    f.allowed = false;
    let repo = FakeRepo::new("main");
    repo.put(
        "main",
        DEFINITION_PATH,
        r##"{ "schemaVersion": 1, "name": "LYRA", "accentColor": "#0ea5e9", "board": "githubIssues", "githubOwnerRepo": "o/lyra" }"##,
    );
    let report = refresh_with(&f.stores(), &repo, &f.ws_id, RefreshMoment::Open).unwrap();
    assert!(report.has_definition);
    assert!(report.changes.is_empty(), "{:?}", report.changes);
    assert_eq!(f.ws().kanban_sync_mode, KanbanSyncMode::Local);
    // An unrelated local edit doesn't publish the local board over the team's.
    f.workspaces.rename(&f.ws_id, "Lyra".into()).unwrap();
    let view = crate::workspace_definition::record_local_edit(&f.stores(), &repo, &f.ws_id, false)
        .unwrap()
        .unwrap();
    assert_eq!(view.cache.pending.keys().collect::<Vec<_>>(), vec!["name"]);
    // Licensed, the same refresh switches the board.
    f.allowed = true;
    let report = refresh_with(&f.stores(), &repo, &f.ws_id, RefreshMoment::Open).unwrap();
    assert!(report.changes.iter().any(|c| c.field == "board"));
    assert_eq!(f.ws().kanban_sync_mode, KanbanSyncMode::GitHubIssues);
}

// ── R14: the repository's board wins; nothing is published unasked ────

/// What a drain asked to publish, field names per request. Every publish is
/// answered "unreachable", so what was asked stays queued to look at.
struct RecordingPublisher(RefCell<Vec<Vec<String>>>);

impl crate::shared_config::Publisher for RecordingPublisher {
    fn publish(&self, request: &crate::shared_config::PublishRequest<'_>) -> crate::shared_config::PublishOutcome {
        self.0.borrow_mut().push(request.fields.keys().cloned().collect());
        crate::shared_config::PublishOutcome::Unreachable("offline in a test".into())
    }
    fn pull_request_state(&self, _: &crate::shared_config::PullRequest) -> Option<crate::shared_config::PrState> {
        None
    }
    fn close_pull_request(&self, _: &crate::shared_config::PullRequest) -> Result<(), String> {
        Ok(())
    }
    fn withdraw_branch(&self, _: &str) -> Result<Vec<u64>, String> {
        Ok(Vec::new())
    }
}

fn facts_of(f: &Fixture) -> AdoptionFacts {
    let view = crate::workspace_definition::get_view(&f.stores(), &FakeRepo::new("main"), &f.ws_id);
    AdoptionFacts {
        repo_has_file: true,
        cache: load_cache(&f.configs, &f.ws_id),
        queue: load_queue(&f.configs, &f.ws_id),
        effective_board: view.as_ref().and_then(|v| v.effective.as_ref()).map(|d| d.board),
        effective_repo: view
            .as_ref()
            .and_then(|v| v.effective.as_ref())
            .and_then(|d| d.github_owner_repo.clone()),
        local_board: f.ws().kanban_sync_mode,
        local_cards: 0,
        ..facts()
    }
}

/// Walk R2 (O1): this Mac's record of the workspace already held GitHub
/// Issues (a board moved for the same repository before), the repository's
/// committed definition says Local. Opening it adopts Local, queues nothing,
/// publishes nothing, and the board is offered — never switched — so no
/// "config: Board — local → githubIssues" commit is made on its own.
#[test]
fn a_committed_local_board_wins_over_this_macs_record_and_is_never_published() {
    let f = Fixture::new(None);
    f.workspaces
        .set_kanban_sync(&f.ws_id, KanbanSyncMode::GitHubIssues, Some("o/lyra".into()))
        .unwrap();
    let repo = FakeRepo::new("main");
    repo.put(
        "main",
        DEFINITION_PATH,
        r##"{ "schemaVersion": 1, "name": "LYRA", "accentColor": "#0ea5e9", "board": "local" }"##,
    );
    let report = refresh_with(&f.stores(), &repo, &f.ws_id, RefreshMoment::Open).unwrap();
    assert!(report.changes.iter().any(|c| c.field == "board"), "{:?}", report.changes);
    assert_eq!(f.ws().kanban_sync_mode, KanbanSyncMode::Local);
    assert_eq!(f.ws().github_owner_repo, None);
    assert!(report.pending_fields.is_empty(), "{:?}", report.pending_fields);
    assert!(load_queue(&f.configs, &f.ws_id).is_empty());
    let publisher = RecordingPublisher(RefCell::new(Vec::new()));
    publish_pending(&f.stores(), &repo, &publisher, &f.ws_id).unwrap();
    assert!(publisher.0.borrow().is_empty(), "{:?}", publisher.0.borrow());
    // No banner — on the Team plan too, and after an earlier "Move" for this
    // repository (`ask_before_board` false); Settings › Board keeps the move.
    let status = decide(&facts_of(&f));
    assert_eq!(status.action, AdoptionAction::None);
    assert_eq!(status.repo_board, Some(KanbanSyncMode::Local));
    // A second open changes nothing more.
    let again = refresh_with(&f.stores(), &repo, &f.ws_id, RefreshMoment::Open).unwrap();
    assert!(again.changes.is_empty(), "{:?}", again.changes);
    assert!(load_queue(&f.configs, &f.ws_id).is_empty());

    // The person's own switch (Settings › Board's press) is an
    // edit: queued and published as before.
    f.workspaces
        .set_kanban_sync(&f.ws_id, KanbanSyncMode::GitHubIssues, Some("o/lyra".into()))
        .unwrap();
    let view = crate::workspace_definition::record_local_edit(&f.stores(), &repo, &f.ws_id, false)
        .unwrap()
        .unwrap();
    assert_eq!(
        view.cache.pending.keys().collect::<Vec<_>>(),
        vec!["board", "githubOwnerRepo"]
    );
    let queue = load_queue(&f.configs, &f.ws_id);
    assert_eq!(queue.fields["board"].value, serde_json::json!("githubIssues"));
    assert_eq!(queue.fields["board"].base, serde_json::json!("local"));
    publish_pending(&f.stores(), &repo, &publisher, &f.ws_id).unwrap();
    assert_eq!(
        publisher.0.borrow().as_slice(),
        &[vec!["board".to_string(), "githubOwnerRepo".to_string()]]
    );
    // Offline, it stays queued and this Mac keeps running it; the banner has
    // nothing to offer while it waits.
    assert_eq!(f.ws().kanban_sync_mode, KanbanSyncMode::GitHubIssues);
    assert!(!load_queue(&f.configs, &f.ws_id).is_empty());
    assert_eq!(decide(&facts_of(&f)).action, AdoptionAction::None);
}

/// R14 migration: a queue written by 1.169.0 holding a board switch loads
/// unchanged and is kept — nothing in it tells a switch made on its own from
/// the person's, so it is published as it would have been.
#[test]
fn a_queue_from_before_r14_loads_unchanged_and_keeps_its_board() {
    let f = Fixture::new(None);
    let path = crate::shared_config::queue_path(&f.configs, &f.ws_id);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let old = r#"{ "schemaVersion": 1, "createDefinition": false,
        "fields": {
          "board": { "value": "githubIssues", "base": "local", "baseCommit": "cd54912",
                     "queuedAt": 1761487081000, "attempts": 0, "lastError": null,
                     "pullRequest": null },
          "githubOwnerRepo": { "value": "o/lyra", "base": null, "baseCommit": "cd54912",
                     "queuedAt": 1761487081000, "attempts": 0, "lastError": null,
                     "pullRequest": null } },
        "lastError": null, "lastOffline": false, "createPullRequest": null,
        "pullRequestBranch": null, "supersededPullRequests": [] }"#;
    std::fs::write(&path, old).unwrap();
    let queue = load_queue(&f.configs, &f.ws_id);
    assert_eq!(
        queue.fields.keys().collect::<Vec<_>>(),
        vec!["board", "githubOwnerRepo"]
    );
    assert_eq!(queue.fields["board"].value, serde_json::json!("githubIssues"));
    assert_eq!(queue.fields["board"].base_commit.as_deref(), Some("cd54912"));
    assert_eq!(queue.fields["githubOwnerRepo"].queued_at, 1_761_487_081_000);
    let parsed: serde_json::Value = serde_json::from_str(old).unwrap();
    assert_eq!(serde_json::to_value(&queue).unwrap(), parsed, "round-trips field for field");
}

// ── Share, end to end on real git ─────────────────────────────────────

fn git(dir: &Path, args: &[&str]) -> String {
    let out = crate::platform::git_command()
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// LYRA: a GitHub origin (rewritten to a local bare repo) with `main` and
/// `staging`, `.atelier/` ignored whole, and the user's clone on `staging`
/// with uncommitted work.
fn lyra() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("origin.git")).unwrap();
    git(
        &root.join("origin.git"),
        &["init", "-q", "--bare", "-b", "main"],
    );
    git(root, &["clone", "-q", "origin.git", "seed"]);
    let seed = root.join("seed");
    git(&seed, &["config", "user.name", "seed"]);
    git(&seed, &["config", "user.email", "seed@example.com"]);
    git(&seed, &["checkout", "-q", "-b", "main"]);
    std::fs::write(seed.join(".gitignore"), "__pycache__/\n.atelier/\n").unwrap();
    std::fs::write(
        seed.join("pyproject.toml"),
        "[project]\nversion = \"1.0\"\n",
    )
    .unwrap();
    git(&seed, &["add", "."]);
    git(&seed, &["commit", "-q", "-m", "init"]);
    git(&seed, &["push", "-q", "origin", "main", "main:staging"]);
    git(root, &["clone", "-q", "origin.git", "work"]);
    let work = root.join("work");
    git(&work, &["config", "user.name", "test-owner"]);
    git(&work, &["config", "user.email", "m@example.com"]);
    git(&work, &["checkout", "-q", "staging"]);
    std::fs::write(work.join("pyproject.toml"), "dirty\n").unwrap();
    let url = "https://github.com/o/lyra.git";
    let bare = root.join("origin.git").display().to_string();
    git(&work, &["config", &format!("url.{bare}.insteadOf"), url]);
    git(&work, &["remote", "set-url", "origin", url]);
    (dir, work)
}

#[test]
fn share_publishes_the_definition_and_the_gitignore_fix_in_one_commit() {
    let (dir, work) = lyra();
    let origin = dir.path().join("origin.git");
    let f = Fixture::new(Some(&work));
    let mut cfg = config("staging");
    cfg.verify_pipeline = Some(vec![VerifyKind::Script {
        path: "scripts/ppvp.sh".into(),
    }]);
    f.configs.set(&f.ws_id, cfg).unwrap();
    let repo = crate::workspace_definition::GitRepo { cwd: work.clone() };
    assert_eq!(github_repo_at(&work).as_deref(), Some("o/lyra"));
    // A newcomer's clone, made before the Share: its origin refs go stale.
    git(dir.path(), &["clone", "-q", "origin.git", "newcomer"]);
    let newcomer = dir.path().join("newcomer");
    let staging_before = git(&origin, &["rev-parse", "staging"]);
    let status_before = git(&work, &["status", "--porcelain"]);

    let outcome = share(&f.stores(), &repo, &f.ws_id, "o/lyra", 5).unwrap();
    assert!(!outcome.already_shared);
    assert_eq!(outcome.board, KanbanSyncMode::GitHubIssues);
    assert_eq!(outcome.local_cards, 5);
    assert_eq!(outcome.board_held, None);
    assert_eq!(f.ws().kanban_sync_mode, KanbanSyncMode::GitHubIssues);
    assert_eq!(f.ws().github_owner_repo.as_deref(), Some("o/lyra"));
    let cache = load_cache(&f.configs, &f.ws_id).unwrap();
    assert_eq!(cache.source, DefinitionSource::Seeded);
    assert!(cache.pending.is_empty());
    // Not asked again while it is on its way.
    let status = decide(&AdoptionFacts {
        cache: Some(cache),
        queue: load_queue(&f.configs, &f.ws_id),
        effective_board: Some(KanbanSyncMode::GitHubIssues),
        local_board: KanbanSyncMode::GitHubIssues,
        local_cards: 0,
        ..facts()
    });
    assert_eq!(status.action, AdoptionAction::None);

    let publisher = GitPublisher {
        device: None,
        git: Plumbing { cwd: work.clone() },
        gh: None,
    };
    let report = publish_pending(&f.stores(), &repo, &publisher, &f.ws_id)
        .unwrap()
        .unwrap();
    assert!(report.commit.is_some(), "{report:?}");
    assert_eq!(report.branch, "staging");

    // One commit on staging, touching exactly the two files.
    assert_eq!(git(&origin, &["rev-parse", "staging^"]), staging_before);
    let files = git(&origin, &["show", "--name-only", "--format=", "staging"]);
    assert_eq!(files, ".atelier/workspace.json\n.gitignore");
    let message = git(&origin, &["log", "-1", "--format=%B", "staging"]);
    assert!(
        message.contains("chore(config): workspace definition — none → .atelier/workspace.json"),
        "{message}"
    );
    assert!(message.contains("chore(config): .gitignore"), "{message}");
    assert_eq!(
        git(&origin, &["log", "-1", "--format=%an", "staging"]),
        "test-owner"
    );
    let gitignore = git(&origin, &["show", "staging:.gitignore"]);
    assert_eq!(format!("{gitignore}\n"), format!("__pycache__/\n{CARVED}"));
    let text = git(&origin, &["show", &format!("staging:{DEFINITION_PATH}")]);
    let def = crate::workspace_definition::parse_definition(text.as_bytes()).unwrap();
    assert_eq!(def.name, "LYRA");
    assert_eq!(def.board, KanbanSyncMode::GitHubIssues);
    assert_eq!(def.github_owner_repo.as_deref(), Some("o/lyra"));
    assert_eq!(def.integration_branch.as_deref(), Some("staging"));
    assert_eq!(
        def.version_files
            .unwrap()
            .iter()
            .map(|v| v.path.as_str())
            .collect::<Vec<_>>(),
        vec!["pyproject.toml"],
        "detected on staging"
    );
    assert_eq!(
        git(&origin, &["rev-parse", "main"]),
        git(&origin, &["rev-parse", "main"])
    );
    assert!(
        git(&origin, &["show", "main:.gitignore"]).contains(".atelier/"),
        "main untouched"
    );
    // The checkout is untouched.
    assert_eq!(git(&work, &["status", "--porcelain"]), status_before);
    assert_eq!(git(&work, &["symbolic-ref", "--short", "HEAD"]), "staging");

    // The cache follows the repo; a second Share finds it shared.
    let cache = load_cache(&f.configs, &f.ws_id).unwrap();
    assert_eq!(cache.source, DefinitionSource::Repo);
    assert!(load_queue(&f.configs, &f.ws_id).is_empty());
    let again = share(&f.stores(), &repo, &f.ws_id, "o/lyra", 0).unwrap();
    assert!(again.already_shared);
    assert_eq!(
        git(&origin, &["rev-list", "--count", "staging"]),
        "2",
        "nothing more published"
    );

    // Another Mac: a fresh workspace on the same repo reads the same
    // definition and is never asked.
    let g = Fixture::new(Some(&work));
    let report = refresh_with(&g.stores(), &repo, &g.ws_id, RefreshMoment::Sync).unwrap();
    assert!(report.has_definition);
    assert_eq!(g.ws().kanban_sync_mode, KanbanSyncMode::GitHubIssues);
    assert_eq!(g.configs.get(&g.ws_id).unwrap().target_branch, "staging");
    let status = decide(&AdoptionFacts {
        repo_has_file: repo_has_file(&repo, None),
        cache: load_cache(&g.configs, &g.ws_id),
        effective_board: Some(KanbanSyncMode::GitHubIssues),
        local_board: g.ws().kanban_sync_mode,
        local_cards: 0,
        ..facts()
    });
    assert_eq!(status.action, AdoptionAction::None);
    assert!(status.has_definition);

    // The newcomer's clone last fetched before the Share and has no config:
    // its first read fetches origin's branches and finds staging's copy
    // instead of offering Share again.
    let stale = crate::workspace_definition::GitRepo {
        cwd: newcomer.clone(),
    };
    assert!(
        git(
            &newcomer,
            &["ls-tree", "--name-only", "-r", "origin/staging"]
        )
        .find(".atelier")
        .is_none(),
        "stale refs"
    );
    assert!(!repo_has_file(&stale, None), "not visible before a refresh");
    let n = Fixture::new(Some(&newcomer));
    let report = refresh_with(&n.stores(), &stale, &n.ws_id, RefreshMoment::Open).unwrap();
    assert!(report.has_definition, "{report:?}");
    assert_eq!(report.branch.as_deref(), Some("staging"));
    assert_eq!(n.configs.get(&n.ws_id).unwrap().target_branch, "staging");
    assert!(repo_has_file(&stale, None));
}

#[test]
fn share_while_origin_is_unreachable_seeds_nothing() {
    let (dir, work) = lyra();
    // Another Mac already shared on staging; this clone hasn't fetched it.
    git(dir.path(), &["clone", "-q", "origin.git", "other"]);
    let other = dir.path().join("other");
    git(&other, &["config", "user.name", "other"]);
    git(&other, &["config", "user.email", "o@example.com"]);
    git(&other, &["checkout", "-q", "staging"]);
    std::fs::create_dir_all(other.join(".atelier")).unwrap();
    std::fs::write(
        other.join(DEFINITION_PATH),
        r#"{ "name": "LYRA", "board": "githubIssues", "githubOwnerRepo": "o/lyra", "integrationBranch": "staging" }"#,
    )
    .unwrap();
    git(&other, &["add", "-f", DEFINITION_PATH]);
    git(&other, &["commit", "-q", "-m", "shared"]);
    git(&other, &["push", "-q", "origin", "staging"]);

    let f = Fixture::new(Some(&work));
    let repo = crate::workspace_definition::GitRepo { cwd: work.clone() };
    let url = git(&work, &["remote", "get-url", "origin"]);
    git(
        &work,
        &["remote", "set-url", "origin", "/nonexistent/origin.git"],
    );
    let refused = share(&f.stores(), &repo, &f.ws_id, "o/lyra", 0).unwrap_err();
    assert!(refused.contains("couldn't reach origin"), "{refused}");
    assert!(load_cache(&f.configs, &f.ws_id).is_none(), "nothing seeded");
    assert!(
        load_queue(&f.configs, &f.ws_id).is_empty(),
        "nothing queued"
    );

    // A local config naming a branch origin doesn't have is no reason to
    // refuse once origin answers.
    f.configs.set(&f.ws_id, config("no-such-branch")).unwrap();

    // Back online: Share finds the existing definition instead.
    git(&work, &["remote", "set-url", "origin", &url]);
    let outcome = share(&f.stores(), &repo, &f.ws_id, "o/lyra", 0).unwrap();
    assert!(outcome.already_shared);
    assert!(load_queue(&f.configs, &f.ws_id).is_empty());
    let origin = dir.path().join("origin.git");
    assert!(
        crate::platform::git_command()
            .args(["cat-file", "-e", &format!("main:{DEFINITION_PATH}")])
            .current_dir(&origin)
            .status()
            .map(|s| !s.success())
            .unwrap(),
        "no second definition on main"
    );
}

#[test]
fn share_refuses_over_an_unreadable_definition_and_keeps_its_diagnostic() {
    let f = Fixture::new(None);
    let repo = FakeRepo::new("main");
    repo.put("staging", DEFINITION_PATH, "{ \"name\": ");
    let refused = share(&f.stores(), &repo, &f.ws_id, "o/lyra", 0).unwrap_err();
    assert!(
        refused.contains("already has .atelier/workspace.json"),
        "{refused}"
    );
    assert!(refused.contains("unreadable"), "{refused}");
    let cache = load_cache(&f.configs, &f.ws_id).unwrap();
    assert!(cache.definition.is_none(), "nothing seeded");
    assert!(cache.unreadable.is_some(), "the Doctor row keeps it");
    assert!(load_queue(&f.configs, &f.ws_id).is_empty());
}

#[test]
fn share_online_with_a_config_branch_missing_on_origin_still_seeds() {
    let (_dir, work) = lyra();
    let f = Fixture::new(Some(&work));
    f.configs.set(&f.ws_id, config("no-such-branch")).unwrap();
    let repo = crate::workspace_definition::GitRepo { cwd: work.clone() };
    let outcome = share(&f.stores(), &repo, &f.ws_id, "o/lyra", 0).unwrap();
    assert!(!outcome.already_shared);
    assert_eq!(
        load_cache(&f.configs, &f.ws_id).unwrap().source,
        DefinitionSource::Seeded
    );
}

#[test]
fn share_on_an_unlicensed_mac_publishes_github_issues_and_keeps_the_board_local() {
    let (_dir, work) = lyra();
    let mut f = Fixture::new(Some(&work));
    f.allowed = false;
    let repo = crate::workspace_definition::GitRepo { cwd: work.clone() };
    let outcome = share(&f.stores(), &repo, &f.ws_id, "o/lyra", 2).unwrap();
    assert_eq!(outcome.board, KanbanSyncMode::Local);
    assert!(outcome.board_held.unwrap().contains("licence"));
    assert_eq!(f.ws().kanban_sync_mode, KanbanSyncMode::Local);
    let cache = load_cache(&f.configs, &f.ws_id).unwrap();
    assert_eq!(
        cache.definition.unwrap().board,
        KanbanSyncMode::GitHubIssues
    );
    assert!(cache.pending.is_empty(), "the local board is not an edit");
}


/// A repository whose origin is `https://github.com/o/lyra.git`, a workspace
/// on it, and a mock app with the stores `app_status` and a refresh read —
/// no key, under `policy`.
fn free_app(
    temp: &Path,
    policy: crate::license::PlanCase,
) -> (tauri::App<tauri::test::MockRuntime>, String) {
    free_app_with(temp, policy, true, None)
}

/// [`free_app`], optionally without a cached definition and with origin's
/// fetches and pushes going to a local bare repository (`insteadOf`; the
/// configured URL — what Plyloft reads the slug from — stays GitHub's).
fn free_app_with(
    temp: &Path,
    policy: crate::license::PlanCase,
    with_definition: bool,
    bare: Option<&Path>,
) -> (tauri::App<tauri::test::MockRuntime>, String) {
    let repo = temp.join("lyra");
    std::fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str]| crate::git::run(&repo, args).unwrap();
    git(&["init", "-q", "-b", "main"]);
    git(&["remote", "add", "origin", "https://github.com/o/lyra.git"]);
    match bare {
        Some(bare) => {
            let key = format!("url.{}.insteadOf", bare.display());
            git(&["config", &key, "https://github.com/o/lyra.git"]);
            git(&["config", "user.email", "t@ply.invalid"]);
            git(&["config", "user.name", "T"]);
            git(&["commit", "-q", "--allow-empty", "-m", "init"]);
            git(&["push", "-q", "origin", "main"]);
            git(&["fetch", "-q", "origin"]);
        }
        // Never the network: a fetch fails here, at once.
        None => git(&["config", "http.proxy", "http://127.0.0.1:9"]),
    }
    let config = temp.join("config");
    let workspaces = WorkspaceStore::new(config.clone()).unwrap();
    let ws = workspaces
        .create("LYRA".into(), repo.to_string_lossy().into_owned())
        .unwrap();
    workspaces.set_name_chosen(&ws.id, Some(false)).unwrap();
    let configs = ProjectConfigStore::new(config.clone()).unwrap();
    if with_definition {
        save_cache(
            &configs,
            &ws.id,
            &cache_with(KanbanSyncMode::GitHubIssues, DefinitionSource::Repo),
        )
        .unwrap();
    }
    let app = tauri::test::mock_builder()
        .manage(workspaces)
        .manage(configs)
        .manage(crate::settings::SettingsStore::new(config.clone()).unwrap())
        .manage(crate::license::LicenseStore::for_plan_test(config, policy))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    (app, ws.id)
}

/// OB-8 review 2 (P3-6) / launch G3: end to end on a mock app — the status
/// `app_status` gives and the board a refresh may run through
/// `with_app_stores`. The matching Team plan switches at once; every other
/// case holds the board with the plan's reason.
#[test]
fn the_plan_decides_the_board_end_to_end() {
    use crate::license::PlanCase;
    for case in PlanCase::ALL {
        let temp = tempfile::tempdir().unwrap();
        let (app, ws) = free_app(temp.path(), case);
        let handle = app.handle();
        let runs_here = crate::workspace_definition::with_workspace_lock(handle, &ws, |stores, _| {
            Ok(stores.github_board_allowed)
        })
        .unwrap();
        let action = app_status(handle, &ws).unwrap().action;
        if case.team_allowed() {
            assert_eq!(action, AdoptionAction::SwitchBoard { local_cards: 0 }, "{case:?}");
            assert!(runs_here, "{case:?}");
        } else {
            assert!(matches!(action, AdoptionAction::BoardHeld { .. }), "{case:?}: {action:?}");
            assert!(!runs_here, "{case:?}");
        }
    }
}

/// OB-8 review 2 (P3-3): a Share that fails records nothing, and the
/// board's status is what it was.
#[test]
fn a_share_that_fails_does_not_record_the_move() {
    let temp = tempfile::tempdir().unwrap();
    let (app, ws) = free_app(temp.path(), crate::license::PlanCase::TeamMatching);
    // Origin is not reachable from a test: Share refuses before anything.
    assert!(app_share(app.handle(), &ws).is_err());
    use tauri::Manager;
    let sharing = app.state::<crate::settings::SettingsStore>().snapshot().sharing;
    assert!(sharing.github_board_moved.is_empty(), "{sharing:?}");
    assert_eq!(
        app_status(app.handle(), &ws).unwrap().action,
        AdoptionAction::SwitchBoard { local_cards: 0 }
    );
}

/// OB-8 review 2 (P3-6) / launch G3: a Share that succeeds on the Team plan
/// runs the board; there is no beta answer to record any more.
#[test]
fn a_share_that_succeeds_runs_the_board() {
    // The publish runs git through the app's cached PATH.
    let _shell_env = crate::shell_env::lock_for_test();
    crate::shell_env::init();
    let temp = tempfile::tempdir().unwrap();
    let bare = temp.path().join("origin.git");
    crate::git::run(temp.path(), &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()])
        .unwrap();
    let (app, ws) = free_app_with(
        temp.path(),
        crate::license::PlanCase::TeamMatching,
        false,
        Some(&bare),
    );
    let outcome = app_share(app.handle(), &ws).expect("share");
    assert!(!outcome.already_shared);
    use tauri::Manager;
    let sharing = app.state::<crate::settings::SettingsStore>().snapshot().sharing;
    assert!(sharing.github_board_moved.is_empty(), "{sharing:?}");
    assert!(crate::workspace_definition::with_workspace_lock(app.handle(), &ws, |stores, _| {
        Ok(stores.github_board_allowed)
    })
    .unwrap());
}

/// T1: the team manifest's workspaces, matched as GitHub matches names.
#[test]
fn a_team_manifest_lists_its_workspaces_case_blind() {
    let manifest = crate::team::parse_manifest(
        br#"{"schemaVersion":1,"name":"T","members":[{"login":"o","owner":true}],
            "workspaces":[{"repo":"Test-Owner/plyloft-ci-sandbox"}]}"#,
    )
    .unwrap();
    assert!(team_lists_workspace(Some(&manifest), "test-owner/plyloft-ci-sandbox"));
    assert!(!team_lists_workspace(Some(&manifest), "test-owner/other"));
    assert!(!team_lists_workspace(None, "test-owner/plyloft-ci-sandbox"));
}

// ── 1.171.0 (X2): a setup found on somebody else's branch ─────────────

const WALK_REL: &str =
    r#"{ "schemaVersion": 1, "name": "d1170-rel", "board": "local", "integrationBranch": "walk-1170-rel" }"#;

/// Walk 1.171 #1: a folder on `walk-ux-1171` (no `.atelier/workspace.json`
/// there, none on main) took the definition of `walk-1170-rel`, which names
/// itself: its name, and cards started from walk-1170-rel. Now nothing is
/// adopted, the folder keeps its own setup, and the board asks once.
#[test]
fn a_setup_on_another_feature_branch_is_asked_about_not_adopted() {
    let f = Fixture::new(None);
    let repo = FakeRepo::new("main").on("walk-ux-1171");
    repo.put("walk-1170-rel", DEFINITION_PATH, WALK_REL);
    let report = refresh_with(&f.stores(), &repo, &f.ws_id, RefreshMoment::Open).unwrap();
    assert!(!report.has_definition, "{report:?}");
    assert!(report.changes.is_empty());
    assert_eq!(f.ws().name, "LYRA", "the folder keeps its own name");
    assert!(f.configs.get(&f.ws_id).is_none(), "no target branch taken from it");
    let cache = load_cache(&f.configs, &f.ws_id).expect("the offer is kept");
    assert!(cache.definition.is_none());
    let found = cache.found_elsewhere.clone().expect("found elsewhere");
    assert_eq!(
        found,
        crate::workspace_definition::FoundElsewhere {
            branch: "walk-1170-rel".into(),
            name: "d1170-rel".into(),
            here: Some("walk-ux-1171".into()),
            answer: None,
            others: Vec::new(),
        }
    );
    let status = decide(&AdoptionFacts {
        repo_has_file: true,
        cache: Some(cache),
        ..facts()
    });
    assert_eq!(
        status.action,
        AdoptionAction::SetupElsewhere {
            here: Some("walk-ux-1171".into()),
            branch: "walk-1170-rel".into(),
            name: "d1170-rel".into(),
            others: Vec::new(),
        }
    );
    // The setup on the other branch is not this folder's: Settings says
    // nothing is shared, and Board doesn't say the repository sets it.
    assert!(!status.has_definition, "Windows walk: one statement per state");
    // A repository without a GitHub remote is asked too: the scan read it.
    let status = decide(&AdoptionFacts {
        github_repo: None,
        repo_has_file: true,
        cache: load_cache(&f.configs, &f.ws_id),
        ..facts()
    });
    assert!(matches!(status.action, AdoptionAction::SetupElsewhere { .. }));

    // "Keep this folder's setup": not asked again, still not adopted.
    answer_elsewhere(&f.configs, &f.ws_id, false, None).unwrap();
    let report = refresh_with(&f.stores(), &repo, &f.ws_id, RefreshMoment::Open).unwrap();
    assert!(!report.has_definition);
    let cache = load_cache(&f.configs, &f.ws_id).unwrap();
    assert_eq!(
        cache.found_elsewhere.as_ref().and_then(|e| e.answer),
        Some(crate::workspace_definition::ElsewhereAnswer::Keep),
        "the answer survives the next scan"
    );
    let status = decide(&AdoptionFacts {
        repo_has_file: true,
        cache: Some(cache),
        ..facts()
    });
    assert_eq!(status.action, AdoptionAction::None);
    assert_eq!(status.kept_own_setup.as_deref(), Some("walk-1170-rel"), "Settings keeps the way back");
    assert_eq!(f.ws().name, "LYRA");
}

#[test]
fn use_it_adopts_the_setup_found_on_another_branch() {
    let f = Fixture::new(None);
    let repo = FakeRepo::new("main").on("walk-ux-1171");
    repo.put("walk-1170-rel", DEFINITION_PATH, WALK_REL);
    refresh_with(&f.stores(), &repo, &f.ws_id, RefreshMoment::Open).unwrap();
    answer_elsewhere(&f.configs, &f.ws_id, true, None).unwrap();
    let report = refresh_with(&f.stores(), &repo, &f.ws_id, RefreshMoment::Open).unwrap();
    assert!(report.has_definition, "{report:?}");
    assert_eq!(report.branch.as_deref(), Some("walk-1170-rel"));
    let cache = load_cache(&f.configs, &f.ws_id).unwrap();
    assert!(cache.found_elsewhere.is_none(), "answered and adopted");
    assert_eq!(f.ws().name, "d1170-rel");
    assert_eq!(f.configs.get(&f.ws_id).unwrap().target_branch, "walk-1170-rel");
    // Later refreshes follow the adopted branch, nothing is asked.
    refresh_with(&f.stores(), &repo, &f.ws_id, RefreshMoment::Open).unwrap();
    let status = decide(&AdoptionFacts {
        repo_has_file: true,
        cache: load_cache(&f.configs, &f.ws_id),
        ..facts()
    });
    assert!(!matches!(status.action, AdoptionAction::SetupElsewhere { .. }));
    // Nothing to answer once a setup is in use.
    assert!(answer_elsewhere(&f.configs, &f.ws_id, false, None).is_err());
}

/// GH #81's team case adopts without a question: a fresh clone on the
/// default branch takes the integration branch kept off it, and a
/// teammate's feature branch made from `staging` (`built_on`) takes
/// `staging`'s, read directly or through a branch carrying its file.
#[test]
fn the_teams_integration_branch_is_still_adopted_without_a_question() {
    let staging = r#"{ "schemaVersion": 1, "name": "LYRA team", "board": "local", "integrationBranch": "staging" }"#;
    let f = Fixture::new(None);
    let repo = FakeRepo::new("main").on("main");
    repo.put("staging", DEFINITION_PATH, staging);
    let report = refresh_with(&f.stores(), &repo, &f.ws_id, RefreshMoment::Open).unwrap();
    assert!(report.has_definition);
    assert_eq!(report.branch.as_deref(), Some("staging"));
    assert!(load_cache(&f.configs, &f.ws_id).unwrap().found_elsewhere.is_none());

    for carrier in [None, Some("feature-x")] {
        let g = Fixture::new(None);
        let repo = FakeRepo::new("main").on("card-7").made_from("staging");
        repo.put("staging", DEFINITION_PATH, staging);
        if let Some(b) = carrier {
            repo.put(b, DEFINITION_PATH, staging);
        }
        let report = refresh_with(&g.stores(), &repo, &g.ws_id, RefreshMoment::Open).unwrap();
        assert!(report.has_definition, "{carrier:?}: {report:?}");
        assert_eq!(report.branch.as_deref(), Some("staging"));
        assert!(load_cache(&g.configs, &g.ws_id).unwrap().found_elsewhere.is_none());
    }
}

/// Challenger 1: a card branch carrying walk-1170-rel's file (which names
/// walk-1170-rel) is followed to walk-1170-rel — still somebody else's
/// branch, so it is asked about under that branch, never adopted.
#[test]
fn a_branch_carrying_somebody_elses_setup_is_asked_about_too() {
    let f = Fixture::new(None);
    let repo = FakeRepo::new("main").on("walk-ux-1171");
    repo.put("walk-1170-rel", DEFINITION_PATH, WALK_REL);
    repo.put("plyloft/card-3", DEFINITION_PATH, WALK_REL);
    let report = refresh_with(&f.stores(), &repo, &f.ws_id, RefreshMoment::Open).unwrap();
    assert!(!report.has_definition, "{report:?}");
    let found = load_cache(&f.configs, &f.ws_id).unwrap().found_elsewhere.unwrap();
    assert_eq!((found.branch.as_str(), found.name.as_str()), ("walk-1170-rel", "d1170-rel"));
    // The card branch alone (its target not on origin any more) likewise.
    let g = Fixture::new(None);
    let repo = FakeRepo::new("main").on("walk-ux-1171");
    repo.put("plyloft/card-3", DEFINITION_PATH, WALK_REL);
    let report = refresh_with(&g.stores(), &repo, &g.ws_id, RefreshMoment::Open).unwrap();
    assert!(!report.has_definition);
}

/// Challenger 3: a folder on no branch is asked like one on another branch,
/// unless it was built on the branch found.
#[test]
fn a_detached_folder_is_asked_unless_built_on_the_branch_found() {
    let f = Fixture::new(None);
    let repo = FakeRepo::new("main").detached();
    repo.put("walk-1170-rel", DEFINITION_PATH, WALK_REL);
    let report = refresh_with(&f.stores(), &repo, &f.ws_id, RefreshMoment::Open).unwrap();
    assert!(!report.has_definition);
    let found = load_cache(&f.configs, &f.ws_id).unwrap().found_elsewhere.unwrap();
    assert_eq!(found.here, None);
    let g = Fixture::new(None);
    let repo = FakeRepo::new("main").detached().made_from("walk-1170-rel");
    repo.put("walk-1170-rel", DEFINITION_PATH, WALK_REL);
    let report = refresh_with(&g.stores(), &repo, &g.ws_id, RefreshMoment::Open).unwrap();
    assert!(report.has_definition);
}

/// A cache written before 1.171.0 has no `foundElsewhere`, and one without
/// an offer writes none.
#[test]
fn a_cache_from_before_found_elsewhere_loads_unchanged() {
    let old = r#"{ "schemaVersion": 1, "definition": null, "source": "repo", "refreshedAt": 5 }"#;
    let cache: DefinitionCache = serde_json::from_str(old).unwrap();
    assert!(cache.found_elsewhere.is_none());
    assert_eq!(cache.refreshed_at, 5);
    let written = serde_json::to_value(&DefinitionCache::empty()).unwrap();
    assert!(written.get("foundElsewhere").is_none());
}

/// Block A walk (1.171.0): the cache the walk's Setup wrote — read the way
/// the board's status reads it — asks the question.
#[test]
fn the_walks_cache_asks_about_the_setup_found_elsewhere() {
    let walk = r#"{
      "schemaVersion": 1, "definition": null, "source": "repo", "branch": null,
      "commit": null, "author": null, "changedAt": null, "refreshedAt": 1793099909864,
      "unreadable": null, "pending": {}, "pendingState": null,
      "writeAccess": { "canPush": null, "checkedAt": 0, "pushRefused": null },
      "foundElsewhere": { "branch": "walk-1170-rel", "name": "d1170-rel", "here": "walk-ux-1171", "answer": null }
    }"#;
    let cache: DefinitionCache = serde_json::from_str(walk).unwrap();
    for (github_repo, repo_has_file) in [(Some("o/my-notes-app".to_string()), true), (None, false)] {
        let status = decide(&AdoptionFacts { github_repo, repo_has_file, cache: Some(cache.clone()), ..facts() });
        assert_eq!(
            status.action,
            AdoptionAction::SetupElsewhere {
                here: Some("walk-ux-1171".into()),
                branch: "walk-1170-rel".into(),
                name: "d1170-rel".into(),
                others: Vec::new(),
            }
        );
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["action"]["kind"], "setupElsewhere");
        assert_eq!(json["action"]["here"], "walk-ux-1171");
    }
}

/// Challenger (walk fixes 2): solo mode's status comes from the cache alone
/// — the question about a setup found elsewhere, else nothing; never Share,
/// a conversion or a board move (and no GitHub access check).
#[test]
fn solo_status_says_only_a_setup_found_elsewhere() {
    let repo = Some("o/lyra".to_string());
    assert_eq!(solo_status(repo.clone(), None).action, AdoptionAction::None, "no Share question");
    for source in [DefinitionSource::Legacy, DefinitionSource::Repo] {
        let cache = cache_with(KanbanSyncMode::Local, source);
        let status = solo_status(repo.clone(), Some(&cache));
        assert_eq!(status.action, AdoptionAction::None, "{source:?}: no conversion or switch");
        assert_eq!(status.repo_board, None);
        // 1.172.0 (B1): a GitHub Issues board stays local in solo mode, and
        // that is said — never switched or offered.
        let cache = cache_with(KanbanSyncMode::GitHubIssues, source);
        let status = solo_status(repo.clone(), Some(&cache));
        assert_eq!(status.action, AdoptionAction::SoloBoardLocal, "{source:?}");
        assert_eq!(status.repo_board, Some(KanbanSyncMode::GitHubIssues));
    }
    // Not for a folder without a GitHub remote.
    let cache = cache_with(KanbanSyncMode::GitHubIssues, DefinitionSource::Repo);
    assert_eq!(solo_status(None, Some(&cache)).action, AdoptionAction::None);
    let mut asked = DefinitionCache::empty();
    asked.found_elsewhere = Some(crate::workspace_definition::FoundElsewhere {
        branch: "walk-1170-rel".into(),
        name: "d1170-rel".into(),
        here: Some("walk-ux-1171".into()),
        answer: None,
        others: Vec::new(),
    });
    assert!(matches!(
        solo_status(repo.clone(), Some(&asked)).action,
        AdoptionAction::SetupElsewhere { .. }
    ));
    asked.found_elsewhere.as_mut().unwrap().answer = Some(crate::workspace_definition::ElsewhereAnswer::Keep);
    let kept = solo_status(repo, Some(&asked));
    assert_eq!(kept.action, AdoptionAction::None);
    assert_eq!(kept.kept_own_setup.as_deref(), Some("walk-1170-rel"));
}

// ── 1.172.0 (B1): one candidate on the default branch ─────────────────

const STAGING: &str =
    r#"{ "schemaVersion": 1, "name": "LYRA team", "board": "local", "integrationBranch": "staging" }"#;

/// A fresh clone on main takes the one shared setup there is without a
/// word (GH #81's team case, card branches carrying staging's file count as
/// staging's) — but with two (staging and somebody's branch naming itself)
/// it asks which, naming both, and adopts nothing.
#[test]
fn a_fresh_clone_on_main_adopts_silently_only_one_candidate() {
    // One candidate, carried by a card branch too.
    let f = Fixture::new(None);
    let repo = FakeRepo::new("main").on("main");
    repo.put("staging", DEFINITION_PATH, STAGING);
    repo.put("plyloft/card-1", DEFINITION_PATH, STAGING);
    let report = refresh_with(&f.stores(), &repo, &f.ws_id, RefreshMoment::Open).unwrap();
    assert!(report.has_definition, "{report:?}");
    assert_eq!(report.branch.as_deref(), Some("staging"));

    // Two: asked, both named.
    let g = Fixture::new(None);
    let repo = FakeRepo::new("main").on("main");
    repo.put("staging", DEFINITION_PATH, STAGING);
    repo.put("walk-1170-rel", DEFINITION_PATH, WALK_REL);
    let report = refresh_with(&g.stores(), &repo, &g.ws_id, RefreshMoment::Open).unwrap();
    assert!(!report.has_definition, "{report:?}");
    assert_eq!(g.ws().name, "LYRA", "nothing adopted");
    let found = load_cache(&g.configs, &g.ws_id).unwrap().found_elsewhere.unwrap();
    let mut named = vec![found.branch.clone()];
    named.extend(found.others.clone());
    named.sort();
    assert_eq!(named, ["staging", "walk-1170-rel"]);
    assert_eq!(found.here.as_deref(), Some("main"));
    let status = decide(&AdoptionFacts {
        repo_has_file: true,
        cache: load_cache(&g.configs, &g.ws_id),
        ..facts()
    });
    let AdoptionAction::SetupElsewhere { branch, others, .. } = status.action else {
        panic!("asked: {:?}", status.action);
    };
    assert_eq!(others.len(), 1);
    assert_ne!(branch, others[0]);
}

/// "Use the one for …" for one of the others named adopts that one; "Keep"
/// holds for every branch the notice named, whatever order the next scan
/// finds them in.
#[test]
fn the_person_chooses_which_of_several_setups() {
    let f = Fixture::new(None);
    let repo = FakeRepo::new("main").on("main");
    repo.put("staging", DEFINITION_PATH, STAGING);
    repo.put("walk-1170-rel", DEFINITION_PATH, WALK_REL);
    refresh_with(&f.stores(), &repo, &f.ws_id, RefreshMoment::Open).unwrap();
    let found = load_cache(&f.configs, &f.ws_id).unwrap().found_elsewhere.unwrap();
    let other = found.others[0].clone();
    assert!(answer_elsewhere(&f.configs, &f.ws_id, true, Some("nowhere")).is_err());
    answer_elsewhere(&f.configs, &f.ws_id, true, Some(&other)).unwrap();
    let report = refresh_with(&f.stores(), &repo, &f.ws_id, RefreshMoment::Open).unwrap();
    assert!(report.has_definition, "{report:?}");
    assert_eq!(report.branch.as_deref(), Some(other.as_str()));

    let g = Fixture::new(None);
    refresh_with(&g.stores(), &repo, &g.ws_id, RefreshMoment::Open).unwrap();
    answer_elsewhere(&g.configs, &g.ws_id, false, None).unwrap();
    // Recorded with the branches the other way round, as when the other one
    // is committed to and the next scan finds it first.
    let mut cache = load_cache(&g.configs, &g.ws_id).unwrap();
    let kept = cache.found_elsewhere.as_mut().unwrap();
    std::mem::swap(&mut kept.branch, &mut kept.others[0]);
    crate::workspace_definition::save_cache(&g.configs, &g.ws_id, &cache).unwrap();
    refresh_with(&g.stores(), &repo, &g.ws_id, RefreshMoment::Open).unwrap();
    let cache = load_cache(&g.configs, &g.ws_id).unwrap();
    assert!(cache.definition.is_none());
    assert_eq!(
        cache.found_elsewhere.as_ref().and_then(|e| e.answer),
        Some(crate::workspace_definition::ElsewhereAnswer::Keep)
    );
    let status = decide(&AdoptionFacts { repo_has_file: true, cache: Some(cache), ..facts() });
    assert_eq!(status.action, AdoptionAction::None);
    assert!(status.kept_own_setup.is_some());
    assert_eq!(status.kept_own_setup_others.len(), 1);
}

/// Challenger: "Keep" given with two setups on main holds after one of the
/// branches went (merged and deleted) — the one left is not taken silently.
#[test]
fn keep_holds_when_one_of_several_setups_goes() {
    let f = Fixture::new(None);
    let repo = FakeRepo::new("main").on("main");
    repo.put("staging", DEFINITION_PATH, STAGING);
    repo.put("feature-x", DEFINITION_PATH, &STAGING.replace("staging", "feature-x"));
    refresh_with(&f.stores(), &repo, &f.ws_id, RefreshMoment::Open).unwrap();
    answer_elsewhere(&f.configs, &f.ws_id, false, None).unwrap();
    repo.files
        .borrow_mut()
        .remove(&("feature-x".to_string(), DEFINITION_PATH.to_string()));
    let report = refresh_with(&f.stores(), &repo, &f.ws_id, RefreshMoment::Open).unwrap();
    assert!(!report.has_definition, "{report:?}");
    let cache = load_cache(&f.configs, &f.ws_id).unwrap();
    assert!(cache.definition.is_none());
    let status = decide(&AdoptionFacts { repo_has_file: true, cache: Some(cache), ..facts() });
    assert_eq!(status.action, AdoptionAction::None);
    assert_eq!(status.kept_own_setup.as_deref(), Some("staging"));
    assert!(status.kept_own_setup_others.is_empty());
    // With no answer given, the one setup there is is still taken.
    let g = Fixture::new(None);
    let report = refresh_with(&g.stores(), &repo, &g.ws_id, RefreshMoment::Open).unwrap();
    assert!(report.has_definition);
}

/// On main, the scan stops once the notice has as many branches as it names.
#[test]
fn the_scan_on_main_stops_at_the_branches_the_notice_names() {
    let f = Fixture::new(None);
    let repo = FakeRepo::new("main").on("main");
    for i in 0..8 {
        let b = format!("own-{i}");
        repo.put(&b, DEFINITION_PATH, &STAGING.replace("staging", &b));
    }
    refresh_with(&f.stores(), &repo, &f.ws_id, RefreshMoment::Open).unwrap();
    let found = load_cache(&f.configs, &f.ws_id).unwrap().found_elsewhere.unwrap();
    assert_eq!(found.others.len(), 3);
}

/// A cache from 1.171.0 (one branch, no `others`) loads, and one without
/// others writes none.
#[test]
fn a_found_elsewhere_from_before_others_loads_unchanged() {
    let old = r#"{ "branch": "walk-1170-rel", "name": "d1170-rel", "here": "walk-ux-1171", "answer": "keep" }"#;
    let found: crate::workspace_definition::FoundElsewhere = serde_json::from_str(old).unwrap();
    assert!(found.others.is_empty());
    assert_eq!(found.answer, Some(crate::workspace_definition::ElsewhereAnswer::Keep));
    let json = serde_json::to_value(&found).unwrap();
    assert!(json.get("others").is_none());
}

/// 1.173.0 (G1 Challenger 3): this Mac's own default release kind (saved
/// while the repository shared nothing) goes into the definition Share
/// seeds, and the refresh after it keeps it here.
#[test]
fn share_carries_this_mac_s_default_release_kind() {
    let (_dir, work) = lyra();
    let f = Fixture::new(Some(&work));
    f.configs.set(&f.ws_id, config("staging")).unwrap();
    crate::areas::set_local_release_kind(&f.configs, &f.ws_id, Some(crate::kanban::ReleaseKind::PushOnly)).unwrap();
    let repo = crate::workspace_definition::GitRepo { cwd: work.clone() };
    share(&f.stores(), &repo, &f.ws_id, "o/lyra", 0).unwrap();
    let cache = load_cache(&f.configs, &f.ws_id).unwrap();
    assert_eq!(cache.definition.unwrap().release_kind.as_deref(), Some("push_only"));
    assert_eq!(crate::areas::load_release_kind(&f.configs, &f.ws_id).as_deref(), Some("push_only"));
}

// ── 1.174.0 (C10, D6): the areas kept on this Mac travel with Share ────

fn c10_list(json: &str) -> Vec<crate::areas::AreaDef> {
    serde_json::from_str(json).unwrap()
}

fn c10_ids(list: Vec<crate::areas::AreaDef>) -> Vec<String> {
    list.into_iter().map(|a| a.id).collect()
}

/// Share puts the areas kept here in its one `chore(config)` commit of
/// `.atelier/workspace.json` — no other file, no other commit. A second
/// computer that kept other areas reads the repository's, sets its own
/// aside, and writes nothing; its Share writes nothing either.
#[test]
fn c10_share_carries_the_areas_kept_here_in_its_one_commit() {
    let (dir, work) = lyra();
    let origin = dir.path().join("origin.git");
    let f = Fixture::new(Some(&work));
    f.configs.set(&f.ws_id, config("staging")).unwrap();
    let kept = c10_list(r#"[{ "id": "app", "name": "App", "path": "" }, { "id": "site", "name": "Site", "path": "site", "targetBranch": "main" }]"#);
    crate::areas::save_local(&f.configs, &f.ws_id, &kept).unwrap();
    let repo = crate::workspace_definition::GitRepo { cwd: work.clone() };
    let before = git(&origin, &["rev-list", "--count", "staging"]);

    let outcome = share(&f.stores(), &repo, &f.ws_id, "o/lyra", 0).unwrap();
    assert!(!outcome.already_shared && !outcome.areas_shared);
    assert!(crate::areas::kept_here(&f.configs, &f.ws_id).is_none(), "the repository's from now on");
    assert!(crate::areas::set_aside(&f.configs, &f.ws_id).is_none());
    let publisher = GitPublisher { device: None, git: Plumbing { cwd: work.clone() }, gh: None };
    publish_pending(&f.stores(), &repo, &publisher, &f.ws_id).unwrap().unwrap();
    assert_eq!(
        git(&origin, &["rev-list", "--count", "staging"]).parse::<u32>().unwrap(),
        before.parse::<u32>().unwrap() + 1,
        "one commit"
    );
    let files = git(&origin, &["show", "--name-only", "--format=", "staging"]);
    assert_eq!(files, ".atelier/workspace.json\n.gitignore");
    assert!(git(&origin, &["log", "-1", "--format=%B", "staging"]).contains("chore(config):"));
    let text = git(&origin, &["show", &format!("staging:{DEFINITION_PATH}")]);
    let def = crate::workspace_definition::parse_definition(text.as_bytes()).unwrap();
    assert_eq!(c10_ids(def.areas.unwrap().valid().unwrap().to_vec()), ["app", "site"]);
    assert_eq!(c10_ids(crate::areas::for_workspace(&f.configs, &f.ws_id)), ["app", "site"]);

    // Another computer kept App and Web.
    let g = Fixture::new(Some(&work));
    crate::areas::save_local(
        &g.configs,
        &g.ws_id,
        &c10_list(r#"[{ "id": "app", "name": "App", "path": "" }, { "id": "web", "name": "Web", "path": "web" }]"#),
    )
    .unwrap();
    let shared_at = git(&origin, &["rev-parse", "staging"]);
    refresh_with(&g.stores(), &repo, &g.ws_id, RefreshMoment::Sync).unwrap();
    assert_eq!(c10_ids(crate::areas::for_workspace(&g.configs, &g.ws_id)), ["app", "site"], "the repository's");
    let aside = crate::areas::set_aside(&g.configs, &g.ws_id).expect("its own set aside");
    assert_eq!(c10_ids(aside.areas), ["app", "web"]);
    let again = share(&g.stores(), &repo, &g.ws_id, "o/lyra", 0).unwrap();
    assert!(again.already_shared && !again.areas_shared, "the repository has areas: the Board asks");
    assert!(load_queue(&g.configs, &g.ws_id).is_empty());
    assert_eq!(git(&origin, &["rev-parse", "staging"]), shared_at, "nothing written");
}

/// Someone shared the repository without areas meanwhile: this press's
/// Share takes the areas kept here to it, as its edit.
#[test]
fn c10_share_after_someone_shared_without_areas_brings_the_kept_ones() {
    let (_dir, work) = lyra();
    let f = Fixture::new(Some(&work));
    f.configs.set(&f.ws_id, config("staging")).unwrap();
    let repo = crate::workspace_definition::GitRepo { cwd: work.clone() };
    share(&f.stores(), &repo, &f.ws_id, "o/lyra", 0).unwrap();
    let publisher = GitPublisher { device: None, git: Plumbing { cwd: work.clone() }, gh: None };
    publish_pending(&f.stores(), &repo, &publisher, &f.ws_id).unwrap().unwrap();

    let g = Fixture::new(Some(&work));
    crate::areas::save_local(
        &g.configs,
        &g.ws_id,
        &c10_list(r#"[{ "id": "app", "name": "App", "path": "" }, { "id": "site", "name": "Site", "path": "site" }]"#),
    )
    .unwrap();
    let outcome = share(&g.stores(), &repo, &g.ws_id, "o/lyra", 0).unwrap();
    assert!(outcome.already_shared && outcome.areas_shared);
    assert!(crate::areas::set_aside(&g.configs, &g.ws_id).is_none(), "answered by the press");
    let queue = load_queue(&g.configs, &g.ws_id);
    assert_eq!(queue.fields.keys().collect::<Vec<_>>(), ["areas"]);
}

// ── 1.175.0 (C1, SC-2) ────────────────────────────────────────────────

fn removed_cache(pending: &[&str]) -> DefinitionCache {
    let mut cache = cache_with(KanbanSyncMode::GitHubIssues, DefinitionSource::Repo);
    cache.definition = None;
    cache.branch = Some("staging".into());
    cache.removed = Some(crate::stop_sharing::Removed {
        branch: "staging".into(),
        commit: Some("c2".into()),
        author: Some("example-teammate".into()),
        at: Some(1_700_000_500),
        pending: pending.iter().map(|p| p.to_string()).collect(),
        left_open: vec![12, 15],
    });
    cache
}

#[test]
fn c1_a_removed_setup_asks_what_to_do_and_never_the_share_question() {
    let mut f = facts();
    f.cache = Some(removed_cache(&["name", "verifyPipeline"]));
    let status = decide(&f);
    assert_eq!(
        status.action,
        AdoptionAction::SetupRemoved { branch: "staging".into(), who: Some("example-teammate".into()), at: Some(1_700_000_500), pending: 2 }
    );
    assert!(!status.has_definition);
    assert_eq!(
        status.shared_setup,
        Some(SharedSetup::Removed { branch: "staging".into(), who: Some("example-teammate".into()), at: Some(1_700_000_500), read_only: false, left_open: vec![12, 15] })
    );
    // The older file still on the branch changes nothing, nor "Not on this Mac".
    f.repo_has_file = true;
    f.declined = true;
    assert!(matches!(decide(&f).action, AdoptionAction::SetupRemoved { .. }));
    // Without a GitHub remote nobody is asked.
    f.github_repo = None;
    assert_eq!(decide(&f).action, AdoptionAction::None);
    assert_eq!(decide(&f).shared_setup, None);
}

#[test]
fn c1_a_setup_kept_here_or_stopped_here_is_not_asked_about_again() {
    use crate::stop_sharing::{Sharing, SharingState};
    for (state, who, here) in [
        (SharingState::KeptLocal, Some("example-teammate".to_string()), false),
        (SharingState::StoppedHere, None, true),
    ] {
        let mut f = facts();
        let mut cache = removed_cache(&[]);
        cache.removed = None;
        cache.sharing = Some(Sharing { state, at: 1_700_000_500, who: who.clone(), branch: Some("staging".into()), left_open: vec![7], to_close: vec![], removal: None });
        f.cache = Some(cache);
        let status = decide(&f);
        assert_eq!(status.action, AdoptionAction::None, "the Share question doesn't come back by itself");
        assert_eq!(
            status.shared_setup,
            Some(SharedSetup::NotShared { who, at: 1_700_000_500, here, read_only: false, left_open: vec![7] })
        );
    }
    // A project that never shared is asked as before, and has no row.
    let f = facts();
    assert_eq!(decide(&f).action, AdoptionAction::Ask);
    assert_eq!(decide(&f).shared_setup, None);
}

#[test]
fn c1_the_shared_setup_row_says_shared_its_pending_changes_and_a_waiting_removal() {
    let mut f = facts();
    let mut cache = cache_with(KanbanSyncMode::GitHubIssues, DefinitionSource::Repo);
    cache.branch = Some("staging".into());
    cache.author = Some("example-teammate".into());
    cache.pending.insert("verifyPipeline".into(), serde_json::json!([]));
    f.cache = Some(cache.clone());
    assert_eq!(
        decide(&f).shared_setup,
        Some(SharedSetup::Shared {
            branch: "staging".into(),
            read_only: false,
            author: Some("example-teammate".into()),
            pending: vec!["verifyPipeline".into()],
            pull_request: None,
            unreadable: None,
        })
    );
    // WALKFIX-1: a file that can't be read now is said on the row.
    let mut broken = cache.clone();
    broken.unreadable = Some(crate::workspace_definition::Unreadable {
        path: ".atelier/workspace.json".into(),
        line: Some(4),
        message: "unknown variant `npm`".into(),
        commit: None,
    });
    let mut g = facts();
    g.cache = Some(broken);
    let Some(SharedSetup::Shared { unreadable, .. }) = decide(&g).shared_setup else { panic!("shared") };
    assert_eq!(unreadable.and_then(|u| u.line), Some(4));
    f.queue.removal_pull_request = Some(crate::shared_config::PullRequest {
        number: 231,
        url: "https://github.com/o/lyra/pull/231".into(),
        branch: "atelier/config-stop-sharing-7".into(),
        head: None,
    });
    let Some(SharedSetup::Shared { pull_request, .. }) = decide(&f).shared_setup else { panic!("shared") };
    assert_eq!(pull_request, Some(SetupPullRequest { number: 231, url: "https://github.com/o/lyra/pull/231".into() }));
    // Read-only.
    cache.write_access.record_permission(false);
    f.cache = Some(cache.clone());
    let Some(SharedSetup::Shared { read_only, .. }) = decide(&f).shared_setup else { panic!("shared") };
    assert!(read_only);
    // A setup not on the branch yet (Share queued, or the older file) has no row.
    for source in [DefinitionSource::Seeded, DefinitionSource::Legacy] {
        cache.source = source;
        f.cache = Some(cache.clone());
        assert_eq!(decide(&f).shared_setup, None);
    }
    // Solo mode: sharing is not its subject.
    assert_eq!(solo_status(Some("o/lyra".into()), Some(&removed_cache(&[]))).shared_setup, None);
    assert_eq!(solo_status(Some("o/lyra".into()), Some(&removed_cache(&[]))).action, AdoptionAction::None);
}

/// The status as the frontend reads it (`src/lib/adoption.ts`).
#[test]
fn c1_the_status_serializes_as_the_frontend_reads_it() {
    let mut f = facts();
    f.cache = Some(removed_cache(&["name"]));
    let value = serde_json::to_value(decide(&f)).unwrap();
    assert_eq!(
        value["action"],
        serde_json::json!({ "kind": "setupRemoved", "branch": "staging", "who": "example-teammate", "at": 1_700_000_500, "pending": 1 })
    );
    assert_eq!(
        value["sharedSetup"],
        serde_json::json!({ "state": "removed", "branch": "staging", "who": "example-teammate", "at": 1_700_000_500, "readOnly": false, "leftOpen": [12, 15] })
    );
    // A status from before (no row) still reads.
    let old: AdoptionStatus = serde_json::from_str(
        r#"{ "githubRepo": "o/lyra", "hasDefinition": false, "action": { "kind": "ask" } }"#,
    )
    .unwrap();
    assert_eq!(old.shared_setup, None);
}

/// Round 2 (and C2 beside it): the one answer to "may the older file be
/// converted and published without a press?".
#[test]
fn c1r2_the_older_file_converts_by_itself_only_where_nothing_was_removed_or_stopped() {
    use crate::stop_sharing::{Sharing, SharingState};
    let legacy = cache_with(KanbanSyncMode::Local, DefinitionSource::Legacy);
    assert!(may_convert_by_itself(&legacy, false), "a repository never converted: as before");
    assert!(!may_convert_by_itself(&legacy, true), "a creation already queued or waiting");
    assert!(!may_convert_by_itself(&cache_with(KanbanSyncMode::Local, DefinitionSource::Repo), false));
    assert!(!may_convert_by_itself(&cache_with(KanbanSyncMode::Local, DefinitionSource::Seeded), false));
    let mut removed = legacy.clone();
    removed.removed = removed_cache(&[]).removed;
    assert!(!may_convert_by_itself(&removed, false), "the shared setup was removed");
    let mut stopped = legacy.clone();
    stopped.sharing = Some(Sharing { state: SharingState::StoppedHere, at: 1, who: None, branch: None, left_open: vec![], to_close: vec![], removal: None });
    assert!(!may_convert_by_itself(&stopped, false), "sharing was stopped here");
    let mut unread = legacy.clone();
    unread.definition = None;
    assert!(!may_convert_by_itself(&unread, false));

    // C2: nor after the conversion's pull request was closed without merging.
    let mut declined = legacy.clone();
    declined.conversion_declined = Some(ConversionDeclined { pull_request: 214, who: None, at: 1, seen: false });
    assert!(!may_convert_by_itself(&declined, false), "the conversion was declined");

    // And `decide` asks it.
    let mut f = facts();
    f.cache = Some(declined);
    assert_ne!(decide(&f).action, AdoptionAction::ConvertLegacy);
    f.cache = Some(legacy);
    assert_eq!(decide(&f).action, AdoptionAction::ConvertLegacy);
    f.cache = Some(removed);
    assert_ne!(decide(&f).action, AdoptionAction::ConvertLegacy);
    f.cache = Some(stopped);
    assert_ne!(decide(&f).action, AdoptionAction::ConvertLegacy);
}

// ── 1.175.0 (C2, SC-1) ────────────────────────────────────────────────

#[test]
fn c2_a_declined_conversion_is_said_once_on_the_board_and_stays_in_settings() {
    let mut cache = cache_with(KanbanSyncMode::Local, DefinitionSource::Legacy);
    cache.conversion_declined = Some(ConversionDeclined { pull_request: 214, who: Some("example-teammate".into()), at: 1, seen: false });
    let mut f = facts();
    f.cache = Some(cache.clone());
    let status = decide(&f);
    assert_eq!(status.action, AdoptionAction::ConversionDeclined { pull_request: 214, who: Some("example-teammate".into()) });
    let row = Some(SharedSetup::Declined { pull_request: 214, who: Some("example-teammate".into()), read_only: false });
    assert_eq!(status.shared_setup, row);
    assert_eq!(
        serde_json::to_value(&status).unwrap()["action"],
        serde_json::json!({ "kind": "conversionDeclined", "pullRequest": 214, "who": "example-teammate" })
    );
    assert_eq!(
        serde_json::to_value(&status).unwrap()["sharedSetup"],
        serde_json::json!({ "state": "declined", "pullRequest": 214, "who": "example-teammate", "readOnly": false })
    );

    // Seen: the notice doesn't come back; the row and its button stay, and
    // nothing converts by itself.
    cache.conversion_declined.as_mut().unwrap().seen = true;
    f.cache = Some(cache.clone());
    let status = decide(&f);
    assert_eq!(status.action, AdoptionAction::None);
    assert_eq!(status.shared_setup, row);

    // A new proposal on its way: no notice meanwhile.
    cache.conversion_declined.as_mut().unwrap().seen = false;
    f.cache = Some(cache.clone());
    f.queue.create_definition = true;
    assert_eq!(decide(&f).action, AdoptionAction::None);

    // Solo mode asks and says nothing of it.
    assert_eq!(solo_status(Some("o/lyra".into()), Some(&cache)).action, AdoptionAction::None);
}

/// WALKFIX-3 (item 3): a Share waiting in its pull request keeps the row.
#[test]
fn walkfix3_a_share_waiting_in_its_pull_request_keeps_the_shared_setup_row() {
    let mut f = facts();
    let mut cache = cache_with(KanbanSyncMode::Local, DefinitionSource::Seeded);
    cache.branch = Some("w1175-int".into());
    f.cache = Some(cache);
    assert_eq!(decide(&f).shared_setup, None, "pushing: nothing to say yet");
    f.queue.create_pull_request = Some(crate::shared_config::PullRequest {
        number: 224,
        url: "https://github.com/o/lyra/pull/224".into(),
        branch: "atelier/config-definition-7".into(),
        head: None,
    });
    assert_eq!(
        decide(&f).shared_setup,
        Some(SharedSetup::Waiting {
            branch: "w1175-int".into(),
            pull_request: SetupPullRequest { number: 224, url: "https://github.com/o/lyra/pull/224".into() },
            read_only: false,
        })
    );
}
