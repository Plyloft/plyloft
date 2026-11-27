use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::webview::InvokeRequest;
use tauri::Manager;

fn invoke_ok(webview: &tauri::WebviewWindow<MockRuntime>, command: &str, body: serde_json::Value) {
    get_ipc_response(
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
    .unwrap_or_else(|error| panic!("{command} unexpectedly refused: {error}"));
}

#[test]
// GH #171: 12 until the three swarm-template moves went with Settings › Swarm
// templates; the other nine are unchanged.
fn allowed_state_drives_9_registered_library_commands_through_real_layer_moves() {
    // A key holder (the test admission seam), and — onboarding §11 — a Mac
    // with no key while team is free during the beta.
    library_moves_with(crate::license::LicenseStore::new_team_allowed_for_test);
    library_moves_with(|config| {
        crate::license::LicenseStore::for_plan_test(
            config,
            crate::license::PlanCase::TeamMatching,
        )
    });
}

fn library_moves_with(license: impl Fn(std::path::PathBuf) -> crate::license::LicenseStore) {
    use crate::memory::{KnowledgeType, MemoryScope, MemorySource, NewMemory};
    use crate::shared_library::LibraryScope;

    let temp = tempfile::tempdir().expect("tempdir");
    let config = temp.path().join("config");
    let project = temp.path().join("project");
    std::fs::create_dir_all(&project).expect("project directory");
    let project_cwd = project.to_string_lossy().into_owned();
    let author = Some("t1-fixture@ply.invalid".to_string());

    let prompts = crate::prompts::PromptsStore::new(config.clone()).expect("prompts store");
    let prompt = prompts
        .create(
            crate::prompts::Prompt {
                id: String::new(),
                name: "IPC prompt".into(),
                description: "production path fixture".into(),
                system_prompt: "Stay local".into(),
                prompt_template: "Observe the fixture".into(),
                tags: vec!["t1".into()],
                created_at: 0,
                updated_at: 0,
                author: None,
                last_edited_by: None,
                scope: LibraryScope::Personal,
            },
            author.clone(),
        )
        .expect("seed prompt");

    let knowledge = crate::memory::MemoryStore::new(config.clone()).expect("memory store");
    let knowledge_entry = knowledge
        .create(NewMemory {
            title: "IPC knowledge".into(),
            body: "production path fixture".into(),
            scope: MemoryScope::Global,
            workspace_id: None,
            tags: vec!["t1".into()],
            linked_cards: Vec::new(),
            source: MemorySource::Manual,
            entry_type: KnowledgeType::Note,
            system_prompt: None,
            prompt_template: None,
            evidence: None,
        })
        .expect("seed knowledge");

    let templates = crate::templates::TemplatesStore::new(config.clone()).expect("templates store");
    let template = templates
        .create(
            crate::templates::UserTemplate {
                id: String::new(),
                label: "IPC workspace template".into(),
                description: "production path fixture".into(),
                tiles: vec![crate::templates::TileSeed {
                    kind: crate::templates::TileSeedKind::Shell,
                }],
                created_at: 0,
                updated_at: 0,
                author: None,
                last_edited_by: None,
                scope: LibraryScope::Personal,
            },
            author,
        )
        .expect("seed workspace template");


    let app = mock_builder()
        .manage(license(config.clone()))
        .manage(prompts)
        .manage(crate::settings::SettingsStore::new(config.clone()).expect("settings store"))
        .manage(knowledge)
        .manage(templates)
        .invoke_handler(tauri::generate_handler![
            crate::commands::prompts_promote,
            crate::commands::prompts_demote,
            crate::commands::prompts_fork,
            crate::commands::knowledge_promote_project,
            crate::commands::knowledge_demote_project,
            crate::commands::knowledge_fork_project,
            crate::commands::templates_promote,
            crate::commands::templates_demote,
            crate::commands::templates_fork,
        ])
        .build(mock_context(noop_assets()))
        .expect("mock app");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("mock webview");

    let prompt_id = prompt.id;
    invoke_ok(
        &webview,
        "prompts_promote",
        serde_json::json!({"projectCwd": project_cwd, "id": prompt_id}),
    );
    let prompt_store = app.state::<crate::prompts::PromptsStore>();
    assert!(prompt_store.list().expect("personal prompts").is_empty());
    assert_eq!(
        prompt_store
            .list_all_with_shared(Some(&project))
            .expect("shared prompts")
            .iter()
            .filter(|item| item.scope == LibraryScope::Shared && item.id == prompt_id)
            .count(),
        1
    );
    invoke_ok(
        &webview,
        "prompts_fork",
        serde_json::json!({"projectCwd": project_cwd, "id": prompt_id}),
    );
    let prompt_forks = prompt_store.list().expect("forked prompts");
    assert_eq!(prompt_forks.len(), 1);
    assert_ne!(prompt_forks[0].id, prompt_id);
    invoke_ok(
        &webview,
        "prompts_demote",
        serde_json::json!({"projectCwd": project_cwd, "id": prompt_id}),
    );
    let prompt_personal = prompt_store.list().expect("demoted prompts");
    assert_eq!(prompt_personal.len(), 2);
    assert!(prompt_personal.iter().any(|item| item.id == prompt_id));
    assert!(prompt_store
        .list_all_with_shared(Some(&project))
        .expect("prompts after demote")
        .iter()
        .all(|item| item.scope != LibraryScope::Shared));

    let knowledge_id = knowledge_entry.id;
    invoke_ok(
        &webview,
        "knowledge_promote_project",
        serde_json::json!({
            "projectCwd": project_cwd,
            "id": knowledge_id,
            "workspaceId": null
        }),
    );
    let knowledge_store = app.state::<crate::memory::MemoryStore>();
    assert!(knowledge_store
        .list(MemoryScope::Global, None)
        .expect("personal knowledge")
        .is_empty());
    assert_eq!(
        knowledge_store
            .list_shared(&project)
            .expect("shared knowledge")
            .iter()
            .filter(|item| item.id == knowledge_id)
            .count(),
        1
    );
    invoke_ok(
        &webview,
        "knowledge_fork_project",
        serde_json::json!({"projectCwd": project_cwd, "id": knowledge_id}),
    );
    let knowledge_forks = knowledge_store
        .list(MemoryScope::Global, None)
        .expect("forked knowledge");
    assert_eq!(knowledge_forks.len(), 1);
    assert_ne!(knowledge_forks[0].id, knowledge_id);
    invoke_ok(
        &webview,
        "knowledge_demote_project",
        serde_json::json!({"projectCwd": project_cwd, "id": knowledge_id}),
    );
    let knowledge_personal = knowledge_store
        .list(MemoryScope::Global, None)
        .expect("demoted knowledge");
    assert_eq!(knowledge_personal.len(), 2);
    assert!(knowledge_personal
        .iter()
        .all(|item| item.id != knowledge_id));
    assert!(knowledge_store
        .list_shared(&project)
        .expect("knowledge after demote")
        .is_empty());

    let template_id = template.id;
    invoke_ok(
        &webview,
        "templates_promote",
        serde_json::json!({"projectCwd": project_cwd, "id": template_id}),
    );
    let template_store = app.state::<crate::templates::TemplatesStore>();
    assert!(template_store
        .list()
        .expect("personal templates")
        .is_empty());
    assert_eq!(
        template_store
            .list_all_with_shared(Some(&project))
            .expect("shared templates")
            .iter()
            .filter(|item| item.scope == LibraryScope::Shared && item.id == template_id)
            .count(),
        1
    );
    invoke_ok(
        &webview,
        "templates_fork",
        serde_json::json!({"projectCwd": project_cwd, "id": template_id}),
    );
    let template_forks = template_store.list().expect("forked templates");
    assert_eq!(template_forks.len(), 1);
    assert_ne!(template_forks[0].id, template_id);
    invoke_ok(
        &webview,
        "templates_demote",
        serde_json::json!({"projectCwd": project_cwd, "id": template_id}),
    );
    let template_personal = template_store.list().expect("demoted templates");
    assert_eq!(template_personal.len(), 2);
    assert!(template_personal.iter().any(|item| item.id == template_id));
    assert!(template_store
        .list_all_with_shared(Some(&project))
        .expect("templates after demote")
        .iter()
        .all(|item| item.scope != LibraryScope::Shared));

    for relative in [
        ".atelier/library/prompts.json",
        ".atelier/library/templates.json",
        ".atelier/library/knowledge",
    ] {
        assert!(
            !project.join(relative).exists(),
            "{relative} survived demote"
        );
    }
}
