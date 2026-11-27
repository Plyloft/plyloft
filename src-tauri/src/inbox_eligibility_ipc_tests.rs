use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::webview::InvokeRequest;
use tauri::Manager;

fn request(
    webview: &tauri::WebviewWindow<MockRuntime>,
    command: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let response = get_ipc_response(
        webview,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "http://tauri.localhost".parse().expect("invoke URL"),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    )
    .map_err(|error| error.to_string())?;
    match response {
        InvokeResponseBody::Json(json) => {
            serde_json::from_str(&json).map_err(|error| error.to_string())
        }
        InvokeResponseBody::Raw(_) => Err(format!("{command} returned raw data")),
    }
}

/// Who the fixture's licence admits: a key (the test admission seam), or no
/// key under one of the two policies (onboarding §11).
#[derive(Debug, Clone, Copy)]
enum Admission {
    Key,
    NoKey(PlanCase),
}

use crate::license::PlanCase;

fn build_app(
    config: &std::path::Path,
    constraint: crate::inbox::RequiredInboxSet,
    admission: Admission,
) -> tauri::App<MockRuntime> {
    build_app_with_observer(
        config,
        constraint,
        admission,
        crate::inbox_gui_proof::GuiInboxProof::default(),
    )
}

fn build_app_with_observer(
    config: &std::path::Path,
    constraint: crate::inbox::RequiredInboxSet,
    admission: Admission,
    observer: crate::inbox_gui_proof::GuiInboxProof,
) -> tauri::App<MockRuntime> {
    let workspaces =
        crate::workspace::WorkspaceStore::new(config.to_path_buf()).expect("workspace store");
    let workspace = workspaces
        .create(
            "Inbox proof fixture".into(),
            config.to_string_lossy().into_owned(),
        )
        .expect("workspace");
    let kanban = crate::kanban::KanbanStore::new(config.to_path_buf()).expect("kanban store");
    let mut card = crate::kanban::KanbanCard::new(
        "eligible-card".into(),
        workspace.id.clone(),
        "Eligible card".into(),
        None,
        crate::kanban::KanbanColumnId::Complete,
    );
    card.last_run_status = Some(crate::kanban::LastRunStatus::Success);
    kanban.create_card(&workspace.id, card).expect("card");
    let license = match admission {
        Admission::Key => {
            crate::license::LicenseStore::new_team_allowed_for_test(config.to_path_buf())
        }
        Admission::NoKey(policy) => {
            crate::license::LicenseStore::for_plan_test(config.to_path_buf(), policy)
        }
    };
    mock_builder()
        .manage(workspaces)
        .manage(kanban)
        .manage(crate::agents::AgentRegistry::new(config).expect("agent registry"))
        // GH #104: `inbox_feed` reads each workspace's improvement proposal from
        // under `<config_dir>/projects`, which this store owns.
        .manage(
            crate::project_config::ProjectConfigStore::new(config.to_path_buf())
                .expect("project config store"),
        )
        .manage(crate::settings::SettingsStore::new(config.to_path_buf()).expect("settings store"))
        .manage(crate::inbox::SeenStore::new(config.to_path_buf()).expect("seen store"))
        .manage(crate::inbox::InboxState::default())
        .manage(observer)
        .manage(license)
        .manage(constraint)
        .invoke_handler(tauri::generate_handler![
            crate::commands::inbox_feed,
            crate::commands::inbox_mark_all_seen
        ])
        .build(mock_context(noop_assets()))
        .expect("mock app")
}

fn webview(app: &tauri::App<MockRuntime>) -> tauri::WebviewWindow<MockRuntime> {
    tauri::WebviewWindowBuilder::new(app, "main", Default::default())
        .build()
        .expect("mock webview")
}

fn feed(webview: &tauri::WebviewWindow<MockRuntime>) -> serde_json::Value {
    request(webview, "inbox_feed", serde_json::json!({})).expect("feed")
}

fn mark_body(feed: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "expectedSetSha256": feed["eligibilityProof"]["eligibleUnseenSetSha256"],
        "expectedUserSha256": feed["eligibilityProof"]["resolvedUserSha256"]
    })
}

/// Exercises the real registered command and production evaluator, preserving
/// the SAME managed InboxState while changing only the existing test license
/// admission fixture. Signed-key installation itself remains an owner live test.
// The proof observer reports over a unix datagram socket.
#[cfg(unix)]
#[test]
fn gui_proof_ipc_cold_lapsed_renewed_and_post_seen_share_one_cache() {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixDatagram;
    use std::time::Duration;

    let config = tempfile::tempdir().unwrap();
    let sockets = tempfile::Builder::new()
        .prefix("igp")
        .tempdir_in("/tmp")
        .unwrap();
    let socket_path = crate::platform::canonicalize(sockets.path()).unwrap().join("p.sock");
    std::fs::set_permissions(sockets.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let receiver = UnixDatagram::bind(&socket_path).unwrap();
    std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    receiver
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let id = "pr:fixture/gui-proof#1";
    let digest = crate::inbox::canonical_id_set_sha256(&[id.into()]).unwrap();
    let target = crate::inbox::user_key_sha256(id); // same SHA-256 bytes, no LF
    let observer = crate::inbox_gui_proof::GuiInboxProof::from_inputs(
        Some(socket_path.into_os_string()),
        Some("a".repeat(64).into()),
        Some(target.clone().into()),
        &crate::inbox::RequiredInboxSet::Fixed(digest.clone()),
    )
    .unwrap();
    let app = build_app_with_observer(
        config.path(),
        crate::inbox::RequiredInboxSet::Fixed(digest.clone()),
        Admission::Key,
        observer,
    );
    let workspace = app
        .state::<crate::workspace::WorkspaceStore>()
        .snapshot()
        .workspaces[0]
        .clone();
    app.state::<crate::kanban::KanbanStore>()
        .delete_card(&workspace.id, "eligible-card")
        .unwrap();
    app.state::<crate::workspace::WorkspaceStore>()
        .set_kanban_sync(
            &workspace.id,
            crate::workspace::KanbanSyncMode::GitHubIssues,
            Some("fixture/gui-proof".into()),
        )
        .unwrap();
    let webview = webview(&app);
    let receive = |expected: &serde_json::Value, sequence: usize| {
        let mut bytes = [0u8; 8193];
        let length = receiver.recv(&mut bytes).unwrap();
        assert!(length <= 8192);
        let text = std::str::from_utf8(&bytes[..length]).unwrap();
        for forbidden in [
            "SECRET-PR",
            "fixture/gui-proof",
            "https://",
            "events",
            "costRollup",
        ] {
            assert!(!text.contains(forbidden), "raw field leaked: {forbidden}");
        }
        let value: serde_json::Value = serde_json::from_str(text).unwrap();
        let mut expected_keys = vec![
            "generatedAt",
            "licensed",
            "resolvedUserSha256",
            "totalRows",
            "eligibleUnseenRows",
            "byKind",
            "byGroup",
            "eligibleUnseenSetSha256",
            "targetPresent",
            "admittedPrTargets",
            "successfulPrSources",
            "failedPrSources",
            "prSourcesComplete",
        ];
        expected_keys.sort_unstable();
        assert_eq!(
            value["proof"]
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            expected_keys
        );
        for (field, expected) in [
            (
                "byKind",
                vec![
                    "review_needed",
                    "card_failed",
                    "verify_failed",
                    "skill_change_waiting",
                    "run_done",
                    "run_failed",
                    "pr_review",
                    "shipped",
                    "card_running",
                    "card_queued",
                    "run_running",
                    "schedule_upcoming",
                    "pr_checks_failed",
                    "pr_changes_requested",
                    "pr_conflict",
                    "pr_ready_to_merge",
                    "pr_head_moved",
                    "pr_merged",
                    "pr_closed",
                    "pr_auto_fix_stopped",
                    "bring_up_to_date",
                    "skill_needs_ok",
                    "library_access_lost",
                    "skill_decision",
                    // Skills hub H6b walk: a team plugin Plyloft refuses for a CLI.
                    "team_plugin_refused",
                    // 1.173.0 (C3): a shared setting both sides changed.
                    "shared_setting_conflict",
                    // 1.173.0 (E3): a Next improvement round's ideas wait.
                    "next_improvement_ideas",
                    // 1.174.0 (DR4): one row per release; a release stopped.
                    "released",
                    "release_stopped",
                ],
            ),
            (
                "byGroup",
                // 1.173.0 (F1): Failed folded into Needs you; On hold and News.
                vec!["needs_you", "running", "shipped", "on_hold", "news", "scheduled"],
            ),
        ] {
            let mut expected = expected;
            expected.sort_unstable();
            let counts = value["proof"][field].as_object().unwrap();
            assert_eq!(
                counts.keys().map(String::as_str).collect::<Vec<_>>(),
                expected
            );
            for count in counts.values() {
                assert_eq!(
                    count
                        .as_object()
                        .unwrap()
                        .keys()
                        .map(String::as_str)
                        .collect::<Vec<_>>(),
                    ["eligibleUnseen", "total"]
                );
            }
        }
        assert_eq!(value["proof"], expected["eligibilityProof"]);
        assert_eq!(value["sequence"], sequence);
        assert_eq!(value["processId"], std::process::id());
        assert_eq!(value["session"], "a".repeat(64));
        assert_eq!(value["targetSha256"], target);
        assert_eq!(value["requiredSetSha256"], digest);
        assert_eq!(value["proof"]["generatedAt"], expected["generatedAt"]);
        assert_eq!(
            value["proof"]["resolvedUserSha256"],
            crate::inbox::user_key_sha256("local")
        );
        assert!(value["emittedElapsedMs"].as_u64().unwrap() < 300_000);
        value
    };
    let _ = crate::github::take_test_gh_invocations();
    crate::github::set_test_gh_responses(vec![Ok(
        r#"[{"number":1,"title":"SECRET-PR","url":"https://example.invalid/pr/1","author":{"login":"SECRET-AUTHOR"}}]"#.into()
    )]);
    let before = gui_proof_fixture_snapshot(config.path());
    let cold = feed(&webview);
    receive(&cold, 1);
    assert_eq!(gui_proof_fixture_snapshot(config.path()), before);
    assert_eq!(cold["eligibilityProof"]["totalRows"], 1);
    assert_eq!(cold["eligibilityProof"]["eligibleUnseenSetSha256"], digest);
    assert_eq!(cold["eligibilityProof"]["successfulPrSources"], 1);
    assert_eq!(cold["eligibilityProof"]["targetPresent"], true);
    assert_eq!(crate::github::take_test_gh_invocations().len(), 1);

    // Change only the existing test admission seam, not any managed store or
    // fabricated proof. Signed-key installation remains an installed live gate.
    app.state::<crate::license::LicenseStore>()
        .set_team_allowed_for_test(false);
    let lapsed = feed(&webview);
    receive(&lapsed, 2);
    assert_eq!(lapsed["eligibilityProof"]["licensed"], false);
    assert_eq!(lapsed["eligibilityProof"]["totalRows"], 0);
    assert_eq!(lapsed["eligibilityProof"]["targetPresent"], false);
    assert_eq!(lapsed["eligibilityProof"]["successfulPrSources"], 0);
    assert!(crate::github::take_test_gh_invocations().is_empty());
    assert_eq!(gui_proof_fixture_snapshot(config.path()), before);
    assert!(request(&webview, "inbox_mark_all_seen", mark_body(&lapsed)).is_err());
    assert!(!config.path().join("inbox/seen.json").exists());

    app.state::<crate::license::LicenseStore>()
        .set_team_allowed_for_test(true);
    let renewed = feed(&webview);
    receive(&renewed, 3);
    assert_eq!(renewed["eligibilityProof"]["licensed"], true);
    assert_eq!(renewed["eligibilityProof"]["targetPresent"], true);
    assert_eq!(renewed["eligibilityProof"]["successfulPrSources"], 1);
    assert_eq!(
        renewed["eligibilityProof"]["eligibleUnseenSetSha256"],
        digest
    );
    assert!(
        crate::github::take_test_gh_invocations().is_empty(),
        "renewal must hit the SAME cache"
    );
    assert_eq!(gui_proof_fixture_snapshot(config.path()), before);
    assert_eq!(
        request(&webview, "inbox_mark_all_seen", mark_body(&renewed)).unwrap()["markedCount"],
        1
    );
    let after_write = gui_proof_fixture_snapshot(config.path());
    let seen = feed(&webview);
    receive(&seen, 4);
    assert_eq!(seen["eligibilityProof"]["totalRows"], 1);
    assert_eq!(seen["eligibilityProof"]["eligibleUnseenRows"], 0);
    assert_eq!(seen["eligibilityProof"]["targetPresent"], false);
    assert_eq!(
        seen["eligibilityProof"]["eligibleUnseenSetSha256"],
        crate::inbox::canonical_id_set_sha256(&[]).unwrap()
    );
    assert!(seen["events"][0]["seenAt"].as_i64().is_some());
    assert_eq!(gui_proof_fixture_snapshot(config.path()), after_write);
    assert!(crate::github::take_test_gh_invocations().is_empty());
    crate::github::clear_test_gh_responses();
}

#[cfg(unix)]
fn gui_proof_fixture_snapshot(root: &std::path::Path) -> Vec<(std::path::PathBuf, Vec<u8>)> {
    fn walk(
        root: &std::path::Path,
        at: &std::path::Path,
        result: &mut Vec<(std::path::PathBuf, Vec<u8>)>,
    ) {
        for entry in std::fs::read_dir(at).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                walk(root, &entry.path(), result);
            } else {
                result.push((
                    entry.path().strip_prefix(root).unwrap().to_path_buf(),
                    std::fs::read(entry.path()).unwrap(),
                ));
            }
        }
    }
    let mut result = Vec::new();
    walk(root, root, &mut result);
    result.sort();
    result
}

#[test]
fn free_absent_constraint_marks_exact_displayed_set_through_registered_ipc() {
    for policy in PlanCase::ALL {
        no_key_absent_constraint_marks(policy);
    }
}

fn no_key_absent_constraint_marks(policy: PlanCase) {
    let temp = tempfile::tempdir().unwrap();
    let app = build_app(
        temp.path(),
        crate::inbox::RequiredInboxSet::Absent,
        Admission::NoKey(policy),
    );
    let webview = webview(&app);
    let before = feed(&webview);
    assert_eq!(before["eligibilityProof"]["licensed"], policy.team_allowed());
    assert_eq!(before["eligibilityProof"]["eligibleUnseenRows"], 1);
    let ids = before["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["seenEligible"] == true && event["seenAt"] == serde_json::Value::Null)
        .map(|event| event["id"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        before["eligibilityProof"]["eligibleUnseenSetSha256"],
        crate::inbox::canonical_id_set_sha256(&ids).unwrap()
    );
    let result = request(&webview, "inbox_mark_all_seen", mark_body(&before)).unwrap();
    assert_eq!(result["markedCount"], 1);
    assert_eq!(
        result["proof"]["eligibleUnseenSetSha256"],
        before["eligibilityProof"]["eligibleUnseenSetSha256"]
    );
    let after = feed(&webview);
    assert_eq!(after["eligibilityProof"]["eligibleUnseenRows"], 0);
    assert_ne!(
        after["eligibilityProof"]["eligibleUnseenSetSha256"],
        before["eligibilityProof"]["eligibleUnseenSetSha256"]
    );
}

#[test]
fn required_arguments_and_changed_candidate_set_refuse_without_seen_file() {
    for policy in PlanCase::ALL {
        required_arguments_under(policy);
    }
}

fn required_arguments_under(policy: PlanCase) {
    let temp = tempfile::tempdir().unwrap();
    let app = build_app(
        temp.path(),
        crate::inbox::RequiredInboxSet::Absent,
        Admission::NoKey(policy),
    );
    let webview = webview(&app);
    let before = feed(&webview);
    assert!(request(&webview, "inbox_mark_all_seen", serde_json::json!({})).is_err());

    let workspaces = app.state::<crate::workspace::WorkspaceStore>();
    let workspace_id = workspaces.snapshot().workspaces[0].id.clone();
    let kanban = app.state::<crate::kanban::KanbanStore>();
    let mut changed = crate::kanban::KanbanCard::new(
        "changed-card".into(),
        workspace_id.clone(),
        "Changed card".into(),
        None,
        crate::kanban::KanbanColumnId::Complete,
    );
    changed.last_run_status = Some(crate::kanban::LastRunStatus::Success);
    kanban.create_card(&workspace_id, changed).unwrap();
    assert!(request(&webview, "inbox_mark_all_seen", mark_body(&before)).is_err());
    assert!(!temp.path().join("inbox/seen.json").exists());
}

#[test]
fn stale_digest_and_wrong_user_refuse_before_seen_file_creation() {
    for body in [
        serde_json::json!({
            "expectedSetSha256": "0".repeat(64),
            "expectedUserSha256": crate::inbox::user_key_sha256("local")
        }),
        serde_json::json!({
            "expectedSetSha256": crate::inbox::canonical_id_set_sha256(
                &["review:eligible-card:manual".into()]
            ).unwrap(),
            "expectedUserSha256": "0".repeat(64)
        }),
    ] {
        for policy in PlanCase::ALL {
            let temp = tempfile::tempdir().unwrap();
            let app = build_app(
                temp.path(),
                crate::inbox::RequiredInboxSet::Absent,
                Admission::NoKey(policy),
            );
            let webview = webview(&app);
            assert!(request(&webview, "inbox_mark_all_seen", body.clone()).is_err());
            assert!(!temp.path().join("inbox/seen.json").exists());
        }
    }
}

#[test]
fn invalid_and_fixed_constraints_are_independent_managed_states() {
    let invalid_temp = tempfile::tempdir().unwrap();
    let invalid_app = build_app(
        invalid_temp.path(),
        crate::inbox::RequiredInboxSet::Invalid,
        Admission::Key,
    );
    let invalid_webview = webview(&invalid_app);
    let invalid_feed = feed(&invalid_webview);
    assert!(request(
        &invalid_webview,
        "inbox_mark_all_seen",
        mark_body(&invalid_feed)
    )
    .is_err());
    assert!(!invalid_temp.path().join("inbox/seen.json").exists());

    let fixed_temp = tempfile::tempdir().unwrap();
    let fixed_app_seed = build_app(
        fixed_temp.path(),
        crate::inbox::RequiredInboxSet::Absent,
        Admission::Key,
    );
    let seed_webview = webview(&fixed_app_seed);
    let seed_feed = feed(&seed_webview);
    let digest = seed_feed["eligibilityProof"]["eligibleUnseenSetSha256"]
        .as_str()
        .unwrap()
        .to_string();
    drop(fixed_app_seed);

    let fixed_app = build_app(
        fixed_temp.path(),
        crate::inbox::RequiredInboxSet::Fixed(digest),
        Admission::Key,
    );
    let fixed_webview = webview(&fixed_app);
    let fixed_feed = feed(&fixed_webview);
    let result = request(
        &fixed_webview,
        "inbox_mark_all_seen",
        mark_body(&fixed_feed),
    )
    .unwrap();
    assert_eq!(result["markedCount"], 1);
}

#[test]
fn fixed_constraint_requires_team_license_before_write() {
    for policy in PlanCase::ALL {
        fixed_constraint_without_a_key(policy);
    }
}

/// Paid: a fixed constraint needs the licence before it writes. Free during
/// the beta: no key is needed, so the accepted set is marked.
fn fixed_constraint_without_a_key(policy: PlanCase) {
    let temp = tempfile::tempdir().unwrap();
    let digest =
        crate::inbox::canonical_id_set_sha256(&["review:eligible-card:manual".to_string()])
            .unwrap();
    let app = build_app(
        temp.path(),
        crate::inbox::RequiredInboxSet::Fixed(digest),
        Admission::NoKey(policy),
    );
    let webview = webview(&app);
    let before = feed(&webview);
    let result = request(&webview, "inbox_mark_all_seen", mark_body(&before));
    match policy {
        _ if !policy.team_allowed() => {
            assert!(result.is_err());
            assert!(!temp.path().join("inbox/seen.json").exists());
        }
        _ => {
            assert_eq!(result.expect("marked without a key")["markedCount"], 1);
        }
    }
}

#[test]
fn fixed_constraint_rejects_a_freshly_displayed_superset() {
    let temp = tempfile::tempdir().unwrap();
    let seed = build_app(temp.path(), crate::inbox::RequiredInboxSet::Absent, Admission::Key);
    let seed_webview = webview(&seed);
    let accepted = feed(&seed_webview)["eligibilityProof"]["eligibleUnseenSetSha256"]
        .as_str()
        .unwrap()
        .to_string();
    drop(seed);

    let app = build_app(
        temp.path(),
        crate::inbox::RequiredInboxSet::Fixed(accepted),
        Admission::Key,
    );
    let workspaces = app.state::<crate::workspace::WorkspaceStore>();
    let workspace_id = workspaces.snapshot().workspaces[0].id.clone();
    let kanban = app.state::<crate::kanban::KanbanStore>();
    let mut extra = crate::kanban::KanbanCard::new(
        "fixed-superset".into(),
        workspace_id.clone(),
        "Fixed superset".into(),
        None,
        crate::kanban::KanbanColumnId::Complete,
    );
    extra.last_run_status = Some(crate::kanban::LastRunStatus::Success);
    kanban.create_card(&workspace_id, extra).unwrap();
    let webview = webview(&app);
    let refreshed = feed(&webview);
    assert!(request(&webview, "inbox_mark_all_seen", mark_body(&refreshed)).is_err());
    assert!(!temp.path().join("inbox/seen.json").exists());
}

#[test]
fn free_mode_skips_github_and_fixed_mode_refuses_incomplete_pr_source() {
    for policy in PlanCase::ALL {
        no_key_github_and_fixed_incomplete(policy);
    }
}

/// Paid: a Mac with no key never asks GitHub for PR reviews. Free during the
/// beta: it does, as a key holder would.
fn no_key_github_and_fixed_incomplete(policy: PlanCase) {
    let free_temp = tempfile::tempdir().unwrap();
    let free_app = build_app(
        free_temp.path(),
        crate::inbox::RequiredInboxSet::Absent,
        Admission::NoKey(policy),
    );
    let free_workspaces = free_app.state::<crate::workspace::WorkspaceStore>();
    let free_id = free_workspaces.snapshot().workspaces[0].id.clone();
    free_workspaces
        .set_kanban_sync(
            &free_id,
            crate::workspace::KanbanSyncMode::GitHubIssues,
            Some("fixture/free".into()),
        )
        .unwrap();
    let _ = crate::github::take_test_gh_invocations();
    crate::github::set_test_gh_responses(Vec::new());
    let free_feed = feed(&webview(&free_app));
    crate::github::clear_test_gh_responses();
    match policy {
        _ if !policy.team_allowed() => {
            assert_eq!(free_feed["eligibilityProof"]["admittedPrTargets"], 0);
            assert!(crate::github::take_test_gh_invocations().is_empty());
        }
        _ => {
            assert_eq!(free_feed["eligibilityProof"]["licensed"], true);
            assert!(!crate::github::take_test_gh_invocations().is_empty());
        }
    }

    let fixed_temp = tempfile::tempdir().unwrap();
    let fixed_app = build_app(
        fixed_temp.path(),
        crate::inbox::RequiredInboxSet::Fixed("0".repeat(64)),
        Admission::Key,
    );
    let fixed_workspaces = fixed_app.state::<crate::workspace::WorkspaceStore>();
    let fixed_id = fixed_workspaces.snapshot().workspaces[0].id.clone();
    fixed_workspaces
        .set_kanban_sync(
            &fixed_id,
            crate::workspace::KanbanSyncMode::GitHubIssues,
            Some("fixture/offline".into()),
        )
        .unwrap();
    let _ = crate::github::take_test_gh_invocations();
    crate::github::set_test_gh_responses(vec![Err("offline".into())]);
    let fixed_webview = webview(&fixed_app);
    let incomplete = feed(&fixed_webview);
    assert_eq!(incomplete["eligibilityProof"]["prSourcesComplete"], false);
    assert!(request(
        &fixed_webview,
        "inbox_mark_all_seen",
        mark_body(&incomplete)
    )
    .is_err());
    crate::github::clear_test_gh_responses();
    assert_eq!(crate::github::take_test_gh_invocations().len(), 1);
    assert!(!fixed_temp.path().join("inbox/seen.json").exists());
}

#[test]
fn fixed_constraint_refuses_incomplete_pr_source_at_the_accepted_digest() {
    let temp = tempfile::tempdir().unwrap();
    let digest =
        crate::inbox::canonical_id_set_sha256(&["review:eligible-card:manual".to_string()])
            .unwrap();
    let app = build_app(
        temp.path(),
        crate::inbox::RequiredInboxSet::Fixed(digest.clone()),
        Admission::Key,
    );
    let workspaces = app.state::<crate::workspace::WorkspaceStore>();
    let workspace_id = workspaces.snapshot().workspaces[0].id.clone();
    workspaces
        .set_kanban_sync(
            &workspace_id,
            crate::workspace::KanbanSyncMode::GitHubIssues,
            Some("fixture/offline-accepted".into()),
        )
        .unwrap();

    let _ = crate::github::take_test_gh_invocations();
    crate::github::set_test_gh_responses(vec![Err("offline".into())]);
    let webview = webview(&app);
    let incomplete = feed(&webview);
    let result = request(&webview, "inbox_mark_all_seen", mark_body(&incomplete));
    crate::github::clear_test_gh_responses();

    assert_eq!(incomplete["eligibilityProof"]["prSourcesComplete"], false);
    assert_eq!(
        incomplete["eligibilityProof"]["eligibleUnseenSetSha256"],
        digest
    );
    assert!(result.is_err());
    assert_eq!(crate::github::take_test_gh_invocations().len(), 1);
    assert!(!temp.path().join("inbox/seen.json").exists());
}

/// The feed asks GitHub once per workspace; on the main thread that froze
/// the window at launch. The IPC tests above run it synchronously (the `gh`
/// seam is thread-local), so this keeps the production attribute async.
#[test]
fn inbox_feed_runs_off_the_main_thread() {
    let commands = include_str!("commands.rs");
    assert!(commands.contains(
        "#[cfg_attr(not(test), tauri::command(async))]\n#[cfg_attr(test, tauri::command)]\npub fn inbox_feed("
    ));
}
