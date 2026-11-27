use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::webview::InvokeRequest;

fn invoke(
    webview: &tauri::WebviewWindow<MockRuntime>,
    command: &str,
    body: serde_json::Value,
) -> serde_json::Value {
    let response = get_ipc_response(
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
    .unwrap_or_else(|error| panic!("{command} unexpectedly failed: {error}"));
    match response {
        InvokeResponseBody::Json(json) => serde_json::from_str(&json).expect("IPC response JSON"),
        InvokeResponseBody::Raw(_) => panic!("{command} returned an unexpected raw response"),
    }
}

fn init_repo(path: &std::path::Path) {
    let git = |args: &[&str]| crate::git::run(path, args).expect("fixture git command");
    git(&["init", "-q", "-b", "main"]);
    git(&["config", "user.email", "t1-soft-gate@ply.invalid"]);
    git(&["config", "user.name", "Plyloft T-1 Soft Gate"]);
    std::fs::write(path.join("overlap.txt"), "base\n").expect("seed overlap file");
    git(&["add", "overlap.txt"]);
    git(&["commit", "-q", "-m", "seed soft-gate fixture"]);
}

use crate::license::PlanCase;

/// Onboarding §11: under the paid policy a no-key Mac never reaches `gh`;
/// while team is free it asks GitHub exactly as a key holder does (the test
/// seam fails closed, so the answer is an error either way).
fn assert_gh_reached(policy: PlanCase, what: &str) {
    let calls = crate::github::take_test_gh_invocations();
    match policy {
        _ if !policy.team_allowed() => assert!(
            calls.is_empty(),
            "lapsed {what} must not reach the production gh subprocess seam"
        ),
        _ => assert!(
            !calls.is_empty(),
            "{what} asks GitHub without a key while team is free"
        ),
    }
}

#[test]
fn lapsed_overlap_registered_ipc_keeps_local_result_without_any_gh_invocation() {
    for policy in PlanCase::ALL {
        no_key_overlap(policy, None);
    }
}

/// Onboarding §10 row 8 (OB-9): in solo mode the frontend asks for the local
/// half only — no pull request is fetched even while team is free, and the
/// local overlap stays.
#[test]
fn solo_overlap_check_keeps_the_local_half_and_never_reaches_gh() {
    for policy in PlanCase::ALL {
        no_key_overlap(policy, Some(false));
    }
}

fn no_key_overlap(policy: PlanCase, teammates: Option<bool>) {
    let temp = tempfile::tempdir().expect("tempdir");
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    let sibling = temp.path().join("sibling");
    std::fs::create_dir_all(&project).expect("project directory");
    init_repo(&project);

    crate::git::run(&project, &["checkout", "-q", "-b", "card-under-test"])
        .expect("card branch");
    std::fs::write(project.join("overlap.txt"), "card edit\n").expect("card edit");

    crate::git::run(
        &project,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "sibling-card",
            sibling.to_str().expect("sibling path"),
            "main",
        ],
    )
    .expect("sibling worktree");
    std::fs::write(sibling.join("overlap.txt"), "sibling edit\n").expect("sibling edit");

    let workspaces =
        crate::workspace::WorkspaceStore::new(config.clone()).expect("workspace store");
    let workspace = workspaces
        .create("T-1 soft gate".into(), project.to_string_lossy().into_owned())
        .expect("workspace");
    workspaces
        .set_kanban_sync(
            &workspace.id,
            crate::workspace::KanbanSyncMode::GitHubIssues,
            Some("fixture/never-query".into()),
        )
        .expect("GitHub-backed workspace");

    let kanban = crate::kanban::KanbanStore::new(config.clone()).expect("kanban store");
    let mut card = crate::kanban::KanbanCard::new(
        "card-under-test".into(),
        workspace.id.clone(),
        "Card under test".into(),
        None,
        crate::kanban::KanbanColumnId::InProgress,
    );
    card.worktree_path = Some(project.to_string_lossy().into_owned());
    card.branch_name = Some("card-under-test".into());
    kanban
        .create_card(&workspace.id, card)
        .expect("card under test");

    let mut sibling_card = crate::kanban::KanbanCard::new(
        "sibling-card".into(),
        workspace.id.clone(),
        "Sibling card".into(),
        None,
        crate::kanban::KanbanColumnId::InProgress,
    );
    sibling_card.worktree_path = Some(sibling.to_string_lossy().into_owned());
    sibling_card.branch_name = Some("sibling-card".into());
    kanban
        .create_card(&workspace.id, sibling_card)
        .expect("sibling card");

    let app = mock_builder()
        .manage(workspaces)
        .manage(kanban)
        .manage(
            crate::project_config::ProjectConfigStore::new(config.clone())
                .expect("project config store"),
        )
        .manage(crate::license::LicenseStore::for_plan_test(config, policy))
        .invoke_handler(tauri::generate_handler![crate::commands::card_overlap_check])
        .build(mock_context(noop_assets()))
        .expect("mock app");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("mock webview");

    assert!(crate::github::take_test_gh_invocations().is_empty());
    let mut body = serde_json::json!({
        "workspaceId": workspace.id,
        "cardId": "card-under-test"
    });
    if let Some(teammates) = teammates {
        body["teammates"] = serde_json::json!(teammates);
    }
    let response = invoke(&webview, "card_overlap_check", body);
    let rows = response.as_array().expect("overlap rows");
    assert_eq!(rows.len(), 1, "local overlap must survive the lapse");
    assert_eq!(rows[0]["kind"], "local_card");
    assert_eq!(rows[0]["otherId"], "sibling-card");
    assert_eq!(rows[0]["files"], serde_json::json!(["overlap.txt"]));
    if teammates == Some(false) {
        assert!(
            crate::github::take_test_gh_invocations().is_empty(),
            "the solo overlap check must not fetch teammates' pull requests"
        );
    } else {
        assert_gh_reached(policy, "overlap");
    }
}

#[test]
fn lapsed_inbox_registered_ipc_keeps_non_pr_event_without_any_gh_invocation() {
    for policy in PlanCase::ALL {
        no_key_inbox(policy);
    }
}

fn no_key_inbox(policy: PlanCase) {
    let temp = tempfile::tempdir().expect("tempdir");
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).expect("project directory");

    let workspaces =
        crate::workspace::WorkspaceStore::new(config.clone()).expect("workspace store");
    let workspace = workspaces
        .create("T-1 soft gate".into(), project.to_string_lossy().into_owned())
        .expect("workspace");
    workspaces
        .set_kanban_sync(
            &workspace.id,
            crate::workspace::KanbanSyncMode::GitHubIssues,
            Some("fixture/never-query".into()),
        )
        .expect("GitHub-backed workspace");

    let kanban = crate::kanban::KanbanStore::new(config.clone()).expect("kanban store");
    let mut card = crate::kanban::KanbanCard::new(
        "ordinary-event".into(),
        workspace.id.clone(),
        "Ordinary complete card".into(),
        None,
        crate::kanban::KanbanColumnId::Complete,
    );
    // GH #243: verified, so it is a decision (a card closed without work
    // asks nothing).
    card.verify_status = crate::kanban::VerifyStatus::Passed;
    kanban
        .create_card(&workspace.id, card)
        .expect("ordinary event card");

    let app = mock_builder()
        .manage(workspaces)
        .manage(kanban)
        .manage(crate::agents::AgentRegistry::new(&config).expect("agent registry"))
        // GH #104: `inbox_feed` reads each workspace's improvement proposal from
        // under `<config_dir>/projects`, which this store owns.
        .manage(
            crate::project_config::ProjectConfigStore::new(config.clone())
                .expect("project config store"),
        )
        .manage(crate::settings::SettingsStore::new(config.clone()).expect("settings store"))
        .manage(crate::inbox::SeenStore::new(config.clone()).expect("seen store"))
        .manage(crate::inbox::InboxState::default())
        .manage(crate::inbox_gui_proof::GuiInboxProof::default())
        .manage(crate::license::LicenseStore::for_plan_test(config, policy))
        .invoke_handler(tauri::generate_handler![crate::commands::inbox_feed])
        .build(mock_context(noop_assets()))
        .expect("mock app");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("mock webview");

    assert!(crate::github::take_test_gh_invocations().is_empty());
    let response = invoke(&webview, "inbox_feed", serde_json::json!({}));
    let events = response["events"].as_array().expect("inbox events");
    assert!(events.iter().any(|event| {
        event["kind"] == "review_needed" && event["cardId"] == "ordinary-event"
    }));
    assert!(
        events.iter().all(|event| event["kind"] != "pr_review"),
        "the inbox must not invent PR-review events GitHub did not give"
    );
    assert_gh_reached(policy, "inbox");
}

#[test]
fn gh_invocation_observer_positive_control_records_exact_arguments() {
    assert!(crate::github::take_test_gh_invocations().is_empty());
    crate::github::record_test_gh_invocation(&[
        "pr",
        "list",
        "--search",
        "review-requested:@me",
    ]);
    assert_eq!(
        crate::github::take_test_gh_invocations(),
        vec![vec![
            "pr".to_string(),
            "list".to_string(),
            "--search".to_string(),
            "review-requested:@me".to_string(),
        ]]
    );
}
