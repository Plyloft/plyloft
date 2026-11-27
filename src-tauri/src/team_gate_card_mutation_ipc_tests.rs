use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::webview::InvokeRequest;
use tauri::Manager;


use crate::license::PlanCase;

struct Fixture {
    _temp: tempfile::TempDir,
    app: tauri::App<MockRuntime>,
    webview: tauri::WebviewWindow<MockRuntime>,
    config: PathBuf,
    workspace_id: String,
    policy: PlanCase,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        crate::github::clear_test_gh_responses();
        crate::github::take_test_gh_invocations();
    }
}

fn snapshot_files(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn visit(root: &Path, path: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
        if !path.exists() {
            return;
        }
        let mut entries = std::fs::read_dir(path)
            .expect("read snapshot directory")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect snapshot directory");
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let kind = entry.file_type().expect("snapshot file type");
            if kind.is_dir() {
                visit(root, &path, out);
            } else if kind.is_file() {
                out.insert(
                    path.strip_prefix(root)
                        .expect("snapshot relative path")
                        .into(),
                    std::fs::read(path).expect("snapshot file"),
                );
            }
        }
    }

    let mut out = BTreeMap::new();
    visit(root, root, &mut out);
    out
}

/// One IPC call, tried again while another test's start holds
/// CARD_START_LOCK: a card created or moved into In progress takes it
/// without waiting and asks to be tried again — tests run in parallel, so a
/// refusal here must be the gate's, never that contention.
fn invoke(
    webview: &tauri::WebviewWindow<MockRuntime>,
    command: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    for _ in 0..500 {
        match invoke_once(webview, command, body.clone()) {
            Err(serde_json::Value::String(e)) if e.starts_with("Another card is starting") => {
                std::thread::sleep(std::time::Duration::from_millis(10))
            }
            other => return other,
        }
    }
    invoke_once(webview, command, body)
}

fn invoke_once(
    webview: &tauri::WebviewWindow<MockRuntime>,
    command: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, serde_json::Value> {
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: crate::test_env::local_invoke_url(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    )
    .map(|response| match response {
        InvokeResponseBody::Json(json) => serde_json::from_str(&json).expect("IPC response JSON"),
        InvokeResponseBody::Raw(_) => panic!("{command} returned an unexpected raw response"),
    })
}

fn invoke_ok(fixture: &Fixture, command: &str, body: serde_json::Value) -> serde_json::Value {
    invoke(&fixture.webview, command, body)
        .unwrap_or_else(|error| panic!("{command} unexpectedly refused: {error}"))
}

fn invoke_gate_refusal(fixture: &Fixture, command: &str, body: serde_json::Value) {
    assert_eq!(
        invoke(&fixture.webview, command, body).expect_err(command),
        serde_json::Value::String(fixture.policy.team_refusal().expect("a refused case")),
        "{command} must refuse through its registered production IPC path"
    );
}

/// `team_allowed` = the test admission seam admits; otherwise `policy`
/// decides (launch G3: every case runs under the whole plan matrix).
fn fixture(
    mode: crate::workspace::KanbanSyncMode,
    team_allowed: bool,
    issue_number: Option<u64>,
    policy: PlanCase,
) -> Fixture {
    crate::github::take_test_gh_invocations();
    crate::github::set_test_gh_responses(Vec::new());

    let temp = tempfile::tempdir().expect("tempdir");
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).expect("project directory");

    let workspaces =
        crate::workspace::WorkspaceStore::new(config.clone()).expect("workspace store");
    let workspace = workspaces
        .create(
            "Gate mutation IPC".into(),
            project.to_string_lossy().into_owned(),
        )
        .expect("workspace");
    if mode == crate::workspace::KanbanSyncMode::GitHubIssues {
        workspaces
            .set_kanban_sync(
                &workspace.id,
                crate::workspace::KanbanSyncMode::GitHubIssues,
                Some("fixture/repo".into()),
            )
            .expect("GitHub-backed workspace");
    }

    let kanban = crate::kanban::KanbanStore::new(config.clone()).expect("kanban store");
    if issue_number.is_some() {
        let mut card = crate::kanban::KanbanCard::new(
            "card-under-test".into(),
            workspace.id.clone(),
            "Original title".into(),
            Some("Original notes".into()),
            crate::kanban::KanbanColumnId::Todo,
        );
        card.gh_issue_number = issue_number;
        kanban
            .create_card(&workspace.id, card)
            .expect("seed card under test");
    }

    let license = if team_allowed {
        crate::license::LicenseStore::new_team_allowed_for_test(config.clone())
    } else {
        crate::license::LicenseStore::for_plan_test(config.clone(), policy)
    };
    let app = mock_builder()
        .manage(workspaces)
        .manage(kanban)
        .manage(crate::settings::SettingsStore::new(config.clone()).expect("settings store"))
        // 1.173.0 (B3): card create reads the areas, as in the app.
        .manage(crate::project_config::ProjectConfigStore::new(config.clone()).expect("project config store"))
        .manage(license)
        .invoke_handler(tauri::generate_handler![
            crate::commands::kanban_card_create,
            crate::commands::kanban_card_follow_up,
            crate::commands::kanban_card_patch,
            crate::commands::kanban_card_set_builder_vendor_pref,
            crate::commands::kanban_card_set_builder_permissions,
            crate::commands::kanban_card_set_models,
            crate::commands::card_line_comment_add,
            crate::commands::card_line_comment_update,
            crate::commands::card_line_comment_remove,
            crate::commands::card_line_comments_mark_sent,
            crate::commands::kanban_card_add_later_request,
            crate::commands::kanban_card_remove_later_request,
            crate::commands::workspace_set_kanban_sync_mode,
        ])
        .build(mock_context(noop_assets()))
        .expect("mock app");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("mock webview");

    Fixture {
        _temp: temp,
        app,
        webview,
        config,
        workspace_id: workspace.id,
        policy,
    }
}

fn card(fixture: &Fixture, card_id: &str) -> crate::kanban::KanbanCard {
    fixture
        .app
        .state::<crate::kanban::KanbanStore>()
        .get_card(&fixture.workspace_id, card_id)
        .expect("persisted card")
}

fn seed_no_issue_card(fixture: &Fixture, card_id: &str) {
    let card = crate::kanban::KanbanCard::new(
        card_id.into(),
        fixture.workspace_id.clone(),
        "No issue title".into(),
        None,
        crate::kanban::KanbanColumnId::Todo,
    );
    fixture
        .app
        .state::<crate::kanban::KanbanStore>()
        .create_card(&fixture.workspace_id, card)
        .expect("seed card without issue");
}

#[test]
fn lapsed_github_create_refuses_before_local_or_remote_mutation() {
    for policy in PlanCase::ALL {
        no_key_github_create(policy);
    }
}

fn no_key_github_create(policy: PlanCase) {
    let fixture = fixture(crate::workspace::KanbanSyncMode::GitHubIssues, false, None, policy);
    if policy.team_allowed() {
        // Free during the beta: the create reaches GitHub like a key holder's.
        crate::github::set_test_gh_responses(vec![Ok(
            "https://github.com/fixture/repo/issues/43".into()
        )]);
        invoke_ok(
            &fixture,
            "kanban_card_create",
            serde_json::json!({
                "workspaceId": fixture.workspace_id,
                "cardId": "free-create",
                "title": "Free create",
                "notes": null,
                "columnId": "todo"
            }),
        );
        assert_eq!(card(&fixture, "free-create").gh_issue_number, Some(43));
        assert_eq!(crate::github::take_test_gh_invocations().len(), 1);
        return;
    }
    let before = snapshot_files(&fixture.config);

    invoke_gate_refusal(
        &fixture,
        "kanban_card_create",
        serde_json::json!({
            "workspaceId": fixture.workspace_id,
            "cardId": "refused-create",
            "title": "Refused create",
            "notes": null,
            "columnId": "todo"
        }),
    );

    assert_eq!(snapshot_files(&fixture.config), before);
    assert!(fixture
        .app
        .state::<crate::kanban::KanbanStore>()
        .get_card(&fixture.workspace_id, "refused-create")
        .is_err());
    assert!(crate::github::take_test_gh_invocations().is_empty());
}

#[test]
fn lapsed_local_create_and_github_owned_patch_remain_free() {
    for policy in PlanCase::ALL {
        no_key_local_create_and_patch(policy);
    }
}

fn no_key_local_create_and_patch(policy: PlanCase) {
    let fixture = fixture(crate::workspace::KanbanSyncMode::Local, false, None, policy);
    invoke_ok(
        &fixture,
        "kanban_card_create",
        serde_json::json!({
            "workspaceId": fixture.workspace_id,
            "cardId": "local-card",
            "title": "Local create",
            "notes": null,
            "columnId": "todo"
        }),
    );
    invoke_ok(
        &fixture,
        "kanban_card_patch",
        serde_json::json!({
            "workspaceId": fixture.workspace_id,
            "cardId": "local-card",
            "patch": {"title": "Local edit", "columnId": "in_progress"}
        }),
    );

    let local = card(&fixture, "local-card");
    assert_eq!(local.title, "Local edit");
    assert_eq!(local.column_id, crate::kanban::KanbanColumnId::InProgress);
    assert!(!local.sync_pending);
    assert!(crate::github::take_test_gh_invocations().is_empty());
}

#[test]
fn lapsed_github_patches_refuse_owned_fields_atomically_but_allow_local_only_fields() {
    for policy in PlanCase::ALL {
        no_key_github_patches(policy);
    }
}

fn no_key_github_patches(policy: PlanCase) {
    let fixture = fixture(
        crate::workspace::KanbanSyncMode::GitHubIssues,
        false,
        Some(7),
        policy,
    );
    seed_no_issue_card(&fixture, "card-without-issue");
    if policy.team_allowed() {
        // Free during the beta: a GitHub-owned field is written and pushed to
        // the card's issue without a key.
        // 1.173.0 (C2): the live claim marker is read before the edit.
        // 1.175.0 (D3): GitHub still has the title this computer read, so
        // the title alone is written. (A title GitHub had changed would be a
        // question instead: no write, one GraphQL read of who changed it.)
        crate::github::set_test_gh_responses(vec![
            Ok(r#"{"number":7,"title":"Original title","body":""}"#.to_string()),
            Ok(String::new()),
        ]);
        invoke_ok(
            &fixture,
            "kanban_card_patch",
            serde_json::json!({
                "workspaceId": fixture.workspace_id,
                "cardId": "card-under-test",
                "patch": {"title": "Free title"}
            }),
        );
        assert_eq!(card(&fixture, "card-under-test").title, "Free title");
        let calls = crate::github::take_test_gh_invocations();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0][0..3], ["issue", "view", "7"]);
        assert_eq!(calls[1], ["issue", "edit", "7", "--repo", "fixture/repo", "--title", "Free title"]);
        return;
    }

    for patch in [
        serde_json::json!({"title": "Refused title", "notes": "Refused notes"}),
        serde_json::json!({"columnId": "in_progress"}),
        serde_json::json!({"title": "Mixed refusal", "suppressRunHistory": true}),
    ] {
        let before = snapshot_files(&fixture.config);
        invoke_gate_refusal(
            &fixture,
            "kanban_card_patch",
            serde_json::json!({
                "workspaceId": fixture.workspace_id,
                "cardId": "card-under-test",
                "patch": patch
            }),
        );
        assert_eq!(snapshot_files(&fixture.config), before);
        assert_eq!(card(&fixture, "card-under-test").title, "Original title");
        assert!(!card(&fixture, "card-under-test").suppress_run_history);
    }

    let before_no_issue = snapshot_files(&fixture.config);
    invoke_gate_refusal(
        &fixture,
        "kanban_card_patch",
        serde_json::json!({
            "workspaceId": fixture.workspace_id,
            "cardId": "card-without-issue",
            "patch": {"knowledge": "Refused knowledge"}
        }),
    );
    assert_eq!(snapshot_files(&fixture.config), before_no_issue);
    assert!(!card(&fixture, "card-without-issue").sync_pending);

    invoke_ok(
        &fixture,
        "kanban_card_patch",
        serde_json::json!({
            "workspaceId": fixture.workspace_id,
            "cardId": "card-under-test",
            "patch": {"suppressRunHistory": true}
        }),
    );
    assert!(card(&fixture, "card-under-test").suppress_run_history);
    assert!(crate::github::take_test_gh_invocations().is_empty());
}

#[test]
fn lapsed_local_escape_preserves_cards_and_never_reaches_github() {
    for policy in PlanCase::ALL {
        no_key_local_escape(policy);
    }
}

fn no_key_local_escape(policy: PlanCase) {
    let fixture = fixture(
        crate::workspace::KanbanSyncMode::GitHubIssues,
        false,
        Some(7),
        policy,
    );
    seed_no_issue_card(&fixture, "card-without-issue");
    let board_before = snapshot_files(&fixture.config.join("kanban"));

    assert_eq!(
        invoke_ok(
            &fixture,
            "workspace_set_kanban_sync_mode",
            serde_json::json!({
                "workspaceId": fixture.workspace_id,
                "mode": "local",
                "repo": null
            }),
        ),
        serde_json::json!(0)
    );

    assert_eq!(snapshot_files(&fixture.config.join("kanban")), board_before);
    let workspace = fixture
        .app
        .state::<crate::workspace::WorkspaceStore>()
        .snapshot()
        .workspaces
        .into_iter()
        .find(|workspace| workspace.id == fixture.workspace_id)
        .expect("workspace after Local escape");
    assert_eq!(
        workspace.kanban_sync_mode,
        crate::workspace::KanbanSyncMode::Local
    );
    assert!(workspace.github_owner_repo.is_none());
    assert_eq!(
        fixture
            .app
            .state::<crate::kanban::KanbanStore>()
            .load(&fixture.workspace_id)
            .expect("cards after Local escape")
            .len(),
        2
    );
    assert!(crate::github::take_test_gh_invocations().is_empty());
}

#[test]
fn allowed_github_create_and_patch_reach_exact_production_subprocess_seam() {
    let fixture = fixture(
        crate::workspace::KanbanSyncMode::GitHubIssues,
        true,
        None,
        PlanCase::Free,
    );
    crate::github::set_test_gh_responses(vec![Ok(
        "https://github.com/fixture/repo/issues/42".into()
    )]);
    invoke_ok(
        &fixture,
        "kanban_card_create",
        serde_json::json!({
            "workspaceId": fixture.workspace_id,
            "cardId": "allowed-card",
            "title": "Allowed create",
            "notes": null,
            "columnId": "todo"
        }),
    );
    assert_eq!(card(&fixture, "allowed-card").gh_issue_number, Some(42));
    assert_eq!(
        crate::github::take_test_gh_invocations(),
        vec![vec![
            "issue",
            "create",
            "--repo",
            "fixture/repo",
            "--title",
            "Allowed create",
            "--body-file",
            "-",
        ]
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>()]
    );

    // 1.173.0 (C2): the live claim marker is read before the body edit.
    // 1.175.0 (D3): the issue is read once, then the title and the body are
    // each written alone (both were touched and GitHub still had what this
    // computer read), then the labels.
    crate::github::set_test_gh_responses(vec![
        Ok(r#"{"number":42,"title":"Allowed create","body":""}"#.to_string()),
        Ok(String::new()),
        Ok(String::new()),
        Ok(String::new()),
    ]);
    invoke_ok(
        &fixture,
        "kanban_card_patch",
        serde_json::json!({
            "workspaceId": fixture.workspace_id,
            "cardId": "allowed-card",
            "patch": {"title": "Allowed edit", "notes": "Allowed notes"}
        }),
    );
    invoke_ok(
        &fixture,
        "kanban_card_patch",
        serde_json::json!({
            "workspaceId": fixture.workspace_id,
            "cardId": "allowed-card",
            "patch": {"columnId": "in_progress"}
        }),
    );

    let allowed = card(&fixture, "allowed-card");
    assert_eq!(allowed.title, "Allowed edit");
    assert_eq!(allowed.notes.as_deref(), Some("Allowed notes"));
    assert_eq!(allowed.column_id, crate::kanban::KanbanColumnId::InProgress);
    assert!(!allowed.sync_pending);
    let mut calls = crate::github::take_test_gh_invocations();
    assert_eq!(calls.len(), 4, "{calls:?}");
    assert_eq!(calls.remove(0)[0..3], ["issue", "view", "42"]);
    assert_eq!(calls[0], ["issue", "edit", "42", "--repo", "fixture/repo", "--title", "Allowed edit"]);
    calls.remove(0);
    assert_eq!(
        calls[0][0..5],
        ["issue", "edit", "42", "--repo", "fixture/repo"]
    );
    // 1.175.0 D4 (TM-9): the body is on stdin, never an argument.
    assert!(calls[0].windows(2).any(|pair| pair == ["--body-file", "-"]));
    assert!(!calls[0].iter().any(|a| a == "--title"), "a body write carries no title (D3)");
    assert!(crate::github::take_test_gh_stdin()
        .iter()
        .any(|body| body.contains("Allowed notes")));
    assert_eq!(
        calls[1],
        vec![
            "issue",
            "edit",
            "42",
            "--repo",
            "fixture/repo",
            "--add-label",
            "status:in-progress",
            "--remove-label",
            "status:todo",
            "--remove-label",
            "status:done",
        ]
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>()
    );
}

#[test]
fn missing_workspace_refuses_before_create_mutation() {
    for policy in PlanCase::ALL {
        missing_workspace_under(policy);
    }
}

fn missing_workspace_under(policy: PlanCase) {
    let fixture = fixture(crate::workspace::KanbanSyncMode::Local, false, None, policy);
    let before = snapshot_files(&fixture.config);
    assert_eq!(
        invoke(
            &fixture.webview,
            "kanban_card_create",
            serde_json::json!({
                "workspaceId": "missing-workspace",
                "cardId": "orphan-card",
                "title": "Must not exist",
                "notes": null,
                "columnId": "todo"
            }),
        )
        .expect_err("missing workspace must refuse"),
        serde_json::Value::String("workspace 'missing-workspace' not found".into())
    );
    assert_eq!(snapshot_files(&fixture.config), before);
    assert!(crate::github::take_test_gh_invocations().is_empty());
}

/// The card's Builder vendor choice is local (never pushed to the issue), so
/// a lapsed GitHub-backed board still takes it; it persists through the
/// registered IPC path, `null` clears it, and an unknown workspace or card is
/// refused with nothing written.
#[test]
fn builder_vendor_pref_is_local_persists_and_refuses_strangers() {
    for policy in PlanCase::ALL {
        builder_vendor_pref_under(policy);
    }
}

fn builder_vendor_pref_under(policy: PlanCase) {
    let fixture = fixture(
        crate::workspace::KanbanSyncMode::GitHubIssues,
        false,
        Some(7),
        policy,
    );
    let out = invoke_ok(
        &fixture,
        "kanban_card_set_builder_vendor_pref",
        serde_json::json!({
            "workspaceId": fixture.workspace_id,
            "cardId": "card-under-test",
            "vendor": "codex"
        }),
    );
    assert_eq!(out["builderVendorPref"], "codex");
    assert_eq!(
        card(&fixture, "card-under-test").builder_vendor_pref,
        Some(crate::settings::BuilderVendor::Codex)
    );
    let reopened = crate::kanban::KanbanStore::new(fixture.config.clone()).expect("reopen");
    assert_eq!(
        reopened
            .get_card(&fixture.workspace_id, "card-under-test")
            .expect("card")
            .builder_vendor_pref,
        Some(crate::settings::BuilderVendor::Codex)
    );
    assert!(crate::github::take_test_gh_invocations().is_empty());

    let before = snapshot_files(&fixture.config);
    assert_eq!(
        invoke(
            &fixture.webview,
            "kanban_card_set_builder_vendor_pref",
            serde_json::json!({
                "workspaceId": "missing-workspace",
                "cardId": "card-under-test",
                "vendor": "claude"
            }),
        )
        .expect_err("missing workspace must refuse"),
        serde_json::Value::String("workspace 'missing-workspace' not found".into())
    );
    assert!(invoke(
        &fixture.webview,
        "kanban_card_set_builder_vendor_pref",
        serde_json::json!({
            "workspaceId": fixture.workspace_id,
            "cardId": "no-such-card",
            "vendor": "claude"
        }),
    )
    .is_err());
    assert_eq!(snapshot_files(&fixture.config), before);

    let cleared = invoke_ok(
        &fixture,
        "kanban_card_set_builder_vendor_pref",
        serde_json::json!({
            "workspaceId": fixture.workspace_id,
            "cardId": "card-under-test",
            "vendor": null
        }),
    );
    assert!(cleared.get("builderVendorPref").is_none(), "{cleared}");
    assert_eq!(card(&fixture, "card-under-test").builder_vendor_pref, None);
}

/// 1.171.0 (D1): the card's Builder permissions choice is local like its
/// vendor choice — saved through the registered IPC path on a GitHub-backed
/// board, never a `gh` call, `null` clears it, a stranger card is refused
/// with nothing written.
#[test]
fn builder_permissions_are_local_persist_and_refuse_strangers() {
    for policy in PlanCase::ALL {
        let fixture = fixture(crate::workspace::KanbanSyncMode::GitHubIssues, false, Some(7), policy);
        let out = invoke_ok(
            &fixture,
            "kanban_card_set_builder_permissions",
            serde_json::json!({
                "workspaceId": fixture.workspace_id,
                "cardId": "card-under-test",
                "permissions": "editsCopy"
            }),
        );
        assert_eq!(out["builderPermissions"], "editsCopy");
        assert_eq!(
            card(&fixture, "card-under-test").builder_permissions,
            Some(crate::settings::BuilderPermissions::EditsCopy)
        );
        assert!(crate::github::take_test_gh_invocations().is_empty());
        let before = snapshot_files(&fixture.config);
        assert!(invoke(
            &fixture.webview,
            "kanban_card_set_builder_permissions",
            serde_json::json!({
                "workspaceId": fixture.workspace_id,
                "cardId": "no-such-card",
                "permissions": "neverAsks"
            }),
        )
        .is_err());
        assert_eq!(snapshot_files(&fixture.config), before);
        let cleared = invoke_ok(
            &fixture,
            "kanban_card_set_builder_permissions",
            serde_json::json!({
                "workspaceId": fixture.workspace_id,
                "cardId": "card-under-test",
                "permissions": null
            }),
        );
        assert!(cleared.get("builderPermissions").is_none(), "{cleared}");
        assert_eq!(card(&fixture, "card-under-test").builder_permissions, None);
    }
}

/// 1.168.1 (E2): a card's own models on a GitHub-backed board are a local
/// preference — saved through the registered IPC path, never a `gh` call or
/// a pending push, `null` clears them, a stranger card is refused with
/// nothing written.
#[test]
fn card_models_are_local_on_a_github_board() {
    for policy in PlanCase::ALL {
        let fixture = fixture(crate::workspace::KanbanSyncMode::GitHubIssues, false, Some(7), policy);
        let before_card = card(&fixture, "card-under-test");
        let out = invoke_ok(
            &fixture,
            "kanban_card_set_models",
            serde_json::json!({
                "workspaceId": fixture.workspace_id,
                "cardId": "card-under-test",
                "models": {"claude": {"builder": "opus"}, "codex": {"challengerReasoning": "low"}}
            }),
        );
        assert_eq!(out["models"]["claude"]["builder"], "opus");
        let saved = card(&fixture, "card-under-test");
        assert_eq!(saved.models.as_ref().unwrap().rows.claude.builder.as_deref(), Some("opus"));
        assert_eq!(saved.sync_pending, before_card.sync_pending, "no GitHub push owed");
        assert_eq!(saved.updated_at, before_card.updated_at);
        assert!(crate::github::take_test_gh_invocations().is_empty());

        let before = snapshot_files(&fixture.config);
        assert!(invoke(
            &fixture.webview,
            "kanban_card_set_models",
            serde_json::json!({"workspaceId": fixture.workspace_id, "cardId": "no-such-card", "models": null}),
        )
        .is_err());
        assert_eq!(snapshot_files(&fixture.config), before);

        let cleared = invoke_ok(
            &fixture,
            "kanban_card_set_models",
            serde_json::json!({"workspaceId": fixture.workspace_id, "cardId": "card-under-test", "models": null}),
        );
        assert!(cleared.get("models").is_none(), "{cleared}");
    }
}

/// SL-5: line comments are local card state on a GitHub-backed board with
/// no team key too — added, edited, marked sent and kept through the
/// registered IPC paths, with no `gh` call: nothing is posted to GitHub.
#[test]
fn line_comments_are_local_and_never_reach_github() {
    for policy in PlanCase::ALL {
        let fixture = fixture(
            crate::workspace::KanbanSyncMode::GitHubIssues,
            false,
            Some(7),
            policy,
        );
        let ids = |out: &serde_json::Value| -> Vec<String> {
            out["lineComments"]
                .as_array()
                .expect("lineComments")
                .iter()
                .map(|c| c["id"].as_str().expect("id").to_string())
                .collect()
        };
        let out = invoke_ok(
            &fixture,
            "card_line_comment_add",
            serde_json::json!({
                "workspaceId": fixture.workspace_id,
                "cardId": "card-under-test",
                "draft": {
                    "path": "src/a.ts",
                    "newStart": 3,
                    "newEnd": 4,
                    "quoted": "+a\n+b",
                    "body": "name it after what it holds"
                }
            }),
        );
        let id = ids(&out)[0].clone();
        invoke_ok(
            &fixture,
            "card_line_comment_update",
            serde_json::json!({
                "workspaceId": fixture.workspace_id,
                "cardId": "card-under-test",
                "commentId": id,
                "body": "edited"
            }),
        );
        let sent = invoke_ok(
            &fixture,
            "card_line_comments_mark_sent",
            serde_json::json!({
                "workspaceId": fixture.workspace_id,
                "cardId": "card-under-test",
                "commentIds": [id]
            }),
        );
        assert!(sent["lineComments"][0]["sentAt"].is_i64(), "{sent}");
        assert_eq!(sent["lineComments"][0]["body"], "edited");
        let before = snapshot_files(&fixture.config);
        assert!(invoke(
            &fixture.webview,
            "card_line_comment_remove",
            serde_json::json!({
                "workspaceId": fixture.workspace_id,
                "cardId": "card-under-test",
                "commentId": id
            }),
        )
        .is_err());
        assert_eq!(snapshot_files(&fixture.config), before, "history stays");
        let stored = card(&fixture, "card-under-test");
        assert_eq!(stored.line_comments.len(), 1);
        assert!(!stored.sync_pending, "a line comment is not an issue edit");
        assert!(crate::github::take_test_gh_invocations().is_empty());
    }
}

/// 1.172.0 (A1): later requests are local card state on a GitHub-backed
/// board with no team key too — kept and removed through the registered IPC
/// paths, with no `gh` call and no issue edit queued.
#[test]
fn later_requests_are_local_and_never_reach_github() {
    for policy in PlanCase::ALL {
        let fixture = fixture(
            crate::workspace::KanbanSyncMode::GitHubIssues,
            false,
            Some(7),
            policy,
        );
        let out = invoke_ok(
            &fixture,
            "kanban_card_add_later_request",
            serde_json::json!({
                "workspaceId": fixture.workspace_id,
                "cardId": "card-under-test",
                "text": "also add a comment",
                "source": "chat"
            }),
        );
        assert_eq!(out["laterRequests"][0]["text"], "also add a comment", "{out}");
        assert_eq!(out["laterRequests"][0]["source"], "chat");
        let id = out["laterRequests"][0]["id"].as_str().expect("id").to_string();
        let out = invoke_ok(
            &fixture,
            "kanban_card_remove_later_request",
            serde_json::json!({
                "workspaceId": fixture.workspace_id,
                "cardId": "card-under-test",
                "requestId": id
            }),
        );
        assert!(out.get("laterRequests").is_none(), "{out}");
        let stored = card(&fixture, "card-under-test");
        assert!(stored.later_requests.is_empty());
        assert!(!stored.sync_pending, "a later request is not an issue edit");
        assert!(crate::github::take_test_gh_invocations().is_empty());
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedPredicateCase {
    name: String,
    mode: crate::workspace::KanbanSyncMode,
    team_allowed: bool,
    touches_github_owned_field: bool,
    blocked: bool,
}

#[test]
fn shared_card_write_matrix_drives_the_rust_product_predicate() {
    let cases: Vec<SharedPredicateCase> = serde_json::from_str(include_str!(
        "../../fixtures/team-gate-card-write-cases.json"
    ))
    .expect("shared card-write fixture");
    for case in cases {
        assert_eq!(
            crate::commands::github_card_write_blocked(
                case.mode,
                case.team_allowed,
                case.touches_github_owned_field,
            ),
            case.blocked,
            "{}",
            case.name
        );
    }
}

/// N19: a shipped card to follow up, as the store holds one after a ship.
fn seed_shipped_card(fixture: &Fixture, card_id: &str) -> crate::kanban::KanbanCard {
    let mut card = crate::kanban::KanbanCard::new(
        card_id.into(),
        fixture.workspace_id.clone(),
        "Shipped title".into(),
        Some("What it did".into()),
        crate::kanban::KanbanColumnId::Complete,
    );
    card.ship_status = crate::kanban::ShipStatus::Shipped;
    card.branch_name = Some(format!("atelier/card-{card_id}"));
    card.commit_sha = Some("abc123".into());
    fixture
        .app
        .state::<crate::kanban::KanbanStore>()
        .create_card(&fixture.workspace_id, card)
        .expect("seed shipped card")
}

fn follow_up_body(fixture: &Fixture, original: &str, card_id: &str) -> serde_json::Value {
    serde_json::json!({
        "workspaceId": fixture.workspace_id,
        "originalCardId": original,
        "cardId": card_id,
        "title": "Follow-up: Shipped title",
        "notes": "Follows up the shipped card"
    })
}

/// N19: Follow up on a local board is a card creation — free on every plan
/// (it lands in To do), linked both ways, the shipped card
/// otherwise as it was, and nothing reaches GitHub.
#[test]
fn follow_up_on_a_local_board_is_free_and_links_both_cards() {
    for policy in PlanCase::ALL {
        let fixture = fixture(crate::workspace::KanbanSyncMode::Local, false, None, policy);
        let before = seed_shipped_card(&fixture, "shipped");
        let made = invoke_ok(&fixture, "kanban_card_follow_up", follow_up_body(&fixture, "shipped", "follow"));
        assert_eq!(made["followsUp"]["cardId"], "shipped", "{policy:?}");
        let follow = card(&fixture, "follow");
        assert_eq!(follow.column_id, crate::kanban::KanbanColumnId::Todo);
        assert_eq!(follow.title, "Follow-up: Shipped title");
        assert!(follow.branch_name.is_none() && follow.worktree_path.is_none(), "a fresh start, never the old branch");
        assert_eq!(follow.follows_up.as_ref().unwrap().title, "Shipped title");
        let after = card(&fixture, "shipped");
        assert_eq!(after.followed_up_by.len(), 1);
        assert_eq!(after.followed_up_by[0].card_id, "follow");
        let mut unchanged = after.clone();
        unchanged.followed_up_by.clear();
        assert_eq!(
            serde_json::to_value(&unchanged).unwrap(),
            serde_json::to_value(&before).unwrap(),
            "the shipped card keeps everything but the link"
        );
        assert!(crate::github::take_test_gh_invocations().is_empty());
    }
}

/// N19: a card that has not shipped is refused, and nothing is written.
#[test]
fn follow_up_refuses_a_card_that_has_not_shipped() {
    let fixture = fixture(crate::workspace::KanbanSyncMode::Local, false, None, PlanCase::ALL[0]);
    seed_no_issue_card(&fixture, "not-shipped");
    let before = snapshot_files(&fixture.config);
    assert_eq!(
        invoke(&fixture.webview, "kanban_card_follow_up", follow_up_body(&fixture, "not-shipped", "follow"))
            .expect_err("refused"),
        serde_json::Value::String(crate::kanban::FOLLOW_UP_NOT_SHIPPED.into())
    );
    assert_eq!(snapshot_files(&fixture.config), before);
}

/// N19: on a GitHub Issues board, Follow up takes the normal new-card path:
/// the Team gate first, then the new card's issue, as New card makes one.
#[test]
fn follow_up_on_a_github_board_takes_the_new_card_path() {
    for policy in PlanCase::ALL {
        let fixture = fixture(crate::workspace::KanbanSyncMode::GitHubIssues, false, None, policy);
        seed_shipped_card(&fixture, "shipped");
        if policy.team_allowed() {
            crate::github::set_test_gh_responses(vec![Ok(
                "https://github.com/fixture/repo/issues/44".into()
            )]);
            invoke_ok(&fixture, "kanban_card_follow_up", follow_up_body(&fixture, "shipped", "follow"));
            assert_eq!(card(&fixture, "follow").gh_issue_number, Some(44));
            assert_eq!(crate::github::take_test_gh_invocations().len(), 1);
            assert_eq!(card(&fixture, "shipped").followed_up_by[0].card_id, "follow");
            continue;
        }
        let before = snapshot_files(&fixture.config);
        invoke_gate_refusal(&fixture, "kanban_card_follow_up", follow_up_body(&fixture, "shipped", "follow"));
        assert_eq!(snapshot_files(&fixture.config), before);
        assert!(crate::github::take_test_gh_invocations().is_empty());
    }
}

/// N19: on a GitHub board, a card whose issue is done (Complete) can be
/// followed up although this Mac never shipped it — a teammate did.
#[test]
fn follow_up_from_a_done_issue_a_teammate_shipped() {
    let fixture = fixture(crate::workspace::KanbanSyncMode::GitHubIssues, true, None, PlanCase::ALL[0]);
    let mut done = crate::kanban::KanbanCard::new(
        "done".into(),
        fixture.workspace_id.clone(),
        "Shipped title".into(),
        None,
        crate::kanban::KanbanColumnId::Complete,
    );
    done.gh_issue_number = Some(21);
    fixture
        .app
        .state::<crate::kanban::KanbanStore>()
        .create_card(&fixture.workspace_id, done)
        .expect("seed done card");
    crate::github::set_test_gh_responses(vec![Ok("https://github.com/fixture/repo/issues/45".into())]);
    invoke_ok(&fixture, "kanban_card_follow_up", follow_up_body(&fixture, "done", "follow"));
    assert_eq!(card(&fixture, "done").followed_up_by[0].card_id, "follow");
    assert_eq!(card(&fixture, "follow").gh_issue_number, Some(45));
}
