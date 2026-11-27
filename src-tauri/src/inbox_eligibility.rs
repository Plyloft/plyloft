//! Read-only headless Inbox eligibility proof.
//!
//! This path is selected by `main` before the Tauri builder. It deliberately
//! constructs the same production stores/feed while refusing every cold-start
//! state that could cause one of those constructors or loads to persist data.

use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;

const PROOF_FLAG: &str = "--inbox-eligibility-proof";
const TARGET_FLAG: &str = "--target-id-sha256";

fn require_file(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| format!("required file is missing: {}", path.display()))?;
    if !metadata.file_type().is_file() {
        return Err(format!(
            "required path is not a regular file: {}",
            path.display()
        ));
    }
    Ok(())
}

fn require_directory(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| format!("required directory is missing: {}", path.display()))?;
    if !metadata.file_type().is_dir() {
        return Err(format!(
            "required path is not a directory: {}",
            path.display()
        ));
    }
    Ok(())
}

#[cfg_attr(windows, allow(dead_code))]
fn config_dir_from_home(home: &Path) -> PathBuf {
    home.join("Library")
        .join("Application Support")
        .join("com.mbadv.ply")
}

#[cfg(unix)]
fn current_config_dir() -> Result<PathBuf, String> {
    let home = crate::platform::home_dir().ok_or_else(|| "HOME is unavailable".to_string())?;
    Ok(config_dir_from_home(&home))
}

/// Tauri's config dir on Windows is the roaming AppData folder, not a path
/// under home.
#[cfg(windows)]
fn current_config_dir() -> Result<PathBuf, String> {
    std::env::var_os("APPDATA")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| crate::platform::home_dir().map(|h| h.join("AppData").join("Roaming")))
        .map(|dir| dir.join("com.mbadv.ply"))
        .ok_or_else(|| "APPDATA is unavailable".to_string())
}

fn parse_target(args: &[String]) -> Result<Option<String>, String> {
    match args {
        [flag] if flag == PROOF_FLAG => Ok(None),
        [flag, target_flag, digest] if flag == PROOF_FLAG && target_flag == TARGET_FLAG => {
            if crate::inbox::is_lower_sha256(digest) {
                Ok(Some(digest.clone()))
            } else {
                Err("target hash must be 64 lowercase hex characters".into())
            }
        }
        _ => Err("invalid Inbox eligibility proof arguments".into()),
    }
}

fn validate_json_directory<T: DeserializeOwned>(
    directory: &Path,
    cutoff_ms: Option<i64>,
) -> Result<(), String> {
    if !directory.exists() {
        return Ok(());
    }
    require_directory(directory)?;
    for entry in std::fs::read_dir(directory)
        .map_err(|error| format!("read directory {}: {error}", directory.display()))?
    {
        let entry = entry.map_err(|error| format!("read directory entry: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("read metadata {}: {error}", path.display()))?;
        if !metadata.file_type().is_file() {
            return Err(format!(
                "JSON input is not a regular file: {}",
                path.display()
            ));
        }
        if let Some(cutoff) = cutoff_ms {
            let modified_ms = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64);
            if modified_ms.is_some_and(|modified| modified < cutoff) {
                continue;
            }
        }
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("read JSON input {}: {error}", path.display()))?;
        if bytes.is_empty() {
            return Err(format!("JSON input is empty: {}", path.display()));
        }
        serde_json::from_slice::<T>(&bytes)
            .map_err(|error| format!("parse JSON input {}: {error}", path.display()))?;
    }
    Ok(())
}

fn preflight(config_dir: &Path, now_ms: i64) -> Result<(), String> {
    require_directory(config_dir)?;
    let workspaces_path = config_dir.join("workspaces.json");
    require_file(&workspaces_path)?;
    require_file(&config_dir.join("settings.json"))?;
    require_directory(&crate::kanban::boards_dir(config_dir))?;
    require_directory(&config_dir.join("agents/workspaces"))?;
    require_directory(&config_dir.join("agents/runs"))?;
    crate::kanban::preflight_read_only(config_dir)?;

    let workspace_bytes =
        std::fs::read(&workspaces_path).map_err(|error| format!("read workspaces: {error}"))?;
    if workspace_bytes.is_empty() {
        return Err("workspaces input is empty".into());
    }
    let workspaces: crate::workspace::WorkspacesFile = serde_json::from_slice(&workspace_bytes)
        .map_err(|error| format!("parse workspaces: {error}"))?;
    for workspace in &workspaces.workspaces {
        validate_json_directory::<crate::agents::AgentConfig>(
            &config_dir.join("agents/workspaces").join(&workspace.id),
            None,
        )?;
        validate_json_directory::<crate::agents::AgentConfig>(
            &Path::new(&workspace.cwd).join(".atelier/agents"),
            None,
        )?;
    }
    let run_cutoff = now_ms - crate::inbox::COST_ROLLUP_WEEKS * 7 * 24 * 60 * 60 * 1000;
    validate_json_directory::<crate::agents::AgentRun>(
        &config_dir.join("agents/runs"),
        Some(run_cutoff),
    )
}

fn build_proof(config_dir: PathBuf, target: Option<&str>) -> Result<String, String> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    preflight(&config_dir, now_ms)?;
    // Launch G3: the plan from `account.json` and the team from the
    // settings, both read without writing.
    let settings = crate::settings::SettingsStore::new_read_only_strict(config_dir.clone())?.snapshot();
    let license = crate::license::LicenseStore::read_only(config_dir.clone(), settings);
    build_proof_after_preflight(config_dir, target, license, now_ms)
}

#[cfg(test)]
fn build_proof_with_license(
    config_dir: PathBuf,
    target: Option<&str>,
    license: crate::license::LicenseStore,
) -> Result<String, String> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    preflight(&config_dir, now_ms)?;
    build_proof_after_preflight(config_dir, target, license, now_ms)
}

fn build_proof_after_preflight(
    config_dir: PathBuf,
    target: Option<&str>,
    license: crate::license::LicenseStore,
    now_ms: i64,
) -> Result<String, String> {
    let settings = crate::settings::SettingsStore::new_read_only_strict(config_dir.clone())?;
    let settings_snapshot = settings.snapshot();
    initialize_shell_environment(&settings_snapshot);

    let workspaces = crate::workspace::WorkspaceStore::new(config_dir.clone())?;
    let kanban = crate::kanban::KanbanStore::new(config_dir.clone())?;
    let agents = crate::agents::AgentRegistry::new(&config_dir)?;
    let seen = crate::inbox::SeenStore::new_read_only_strict(config_dir.clone())?;
    let inbox_state = crate::inbox::InboxState::default();
    let user = crate::inbox::user_key(&settings_snapshot);
    let licensed = license.team_allowed_at(now_ms);
    let feed = crate::inbox::assemble_feed(
        &workspaces,
        &kanban,
        &agents,
        // GH #104: the improvement proposals, read straight off disk — no
        // registry, no startup reconciliation, nothing this proof could write.
        &config_dir.join("projects"),
        &seen,
        &inbox_state,
        &user,
        now_ms,
        licensed,
        target,
        // Skills hub H6a: the same rows the app's feed carries.
        crate::team::current_team_repo(&settings_snapshot.team)
            .map(|slug| crate::team::TeamStore::new(config_dir.clone()).clone_dir(&slug))
            .filter(|dir| dir.join(".git").exists())
            .as_deref(),
    )?;
    if !feed.eligibility_proof.licensed {
        return Err("Inbox eligibility proof requires the Team plan".into());
    }
    if !feed.eligibility_proof.pr_sources_complete {
        return Err("Inbox eligibility proof requires complete PR sources".into());
    }
    serde_json::to_string(&feed.eligibility_proof)
        .map_err(|error| format!("serialize Inbox eligibility proof: {error}"))
}

/// Keep binary resolution identical to normal startup. This must precede the
/// cold InboxState's possible `gh` request.
fn initialize_shell_environment(settings: &crate::settings::Settings) {
    crate::shell_env::init();
    crate::shell_env::configure_path_override(settings.shell.path_override.as_deref());
    if let Some(path) = crate::shell_env::path_override() {
        crate::shell_env::apply_path_override(&path);
    }
}

/// `None` means ordinary GUI startup. `Some` means the headless flag was
/// present and owns the process, whether it succeeds or fails.
pub fn dispatch(args: &[String]) -> Option<Result<String, String>> {
    if args.first().map(String::as_str) != Some(PROOF_FLAG) {
        return None;
    }
    Some(parse_target(args).and_then(|target| {
        let config_dir = current_config_dir()?;
        build_proof(config_dir, target.as_deref())
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lock_shell_env_test() -> std::sync::MutexGuard<'static, ()> {
        crate::shell_env::lock_for_test()
    }

    #[test]
    fn parser_admits_only_the_exact_redacted_surface() {
        assert_eq!(parse_target(&[PROOF_FLAG.into()]).unwrap(), None);
        let digest = "a".repeat(64);
        assert_eq!(
            parse_target(&[PROOF_FLAG.into(), TARGET_FLAG.into(), digest.clone()]).unwrap(),
            Some(digest)
        );
        assert!(parse_target(&[]).is_err());
        assert!(parse_target(&[PROOF_FLAG.into(), "raw-id".into()]).is_err());
        assert!(parse_target(&[PROOF_FLAG.into(), TARGET_FLAG.into(), "A".repeat(64)]).is_err());
    }

    #[test]
    fn config_path_matches_the_macos_identifier_shape() {
        assert_eq!(
            config_dir_from_home(Path::new("/Users/example")),
            PathBuf::from("/Users/example/Library/Application Support/com.mbadv.ply")
        );
    }

    #[test]
    fn current_config_dir_matches_tauri_config_base_plus_identifier() {
        use tauri::Manager;
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        // mock_context has no bundle identifier, so its app_config_dir is the
        // platform base. Join the production identifier explicitly.
        assert_eq!(
            current_config_dir().unwrap(),
            app.path().app_config_dir().unwrap().join("com.mbadv.ply")
        );
    }

    #[test]
    fn shell_path_override_uses_nonblank_replacement_semantics() {
        let _guard = lock_shell_env_test();
        crate::shell_env::init();
        let original = crate::shell_env::get().path.clone();
        let baseline = "/private/tmp/ply-inbox-shell-baseline";
        crate::shell_env::apply_path_override(baseline);
        let mut settings = crate::settings::Settings::default();
        settings.shell.path_override = Some("   ".into());
        initialize_shell_environment(&settings);
        assert_eq!(crate::shell_env::get().path, baseline);

        let replacement = "/private/tmp/ply-inbox-shell-replacement:/usr/bin";
        settings.shell.path_override = Some(replacement.into());
        initialize_shell_environment(&settings);
        assert_eq!(crate::shell_env::get().path, replacement);
        crate::shell_env::apply_path_override(&original);
        crate::shell_env::configure_path_override(None);
    }

    #[test]
    fn preflight_requires_real_production_directories_without_creating_them() {
        let temp = tempfile::tempdir().unwrap();
        assert!(preflight(temp.path(), 1).is_err());
        assert!(!temp.path().join("kanban").exists());
        for directory in [
            "kanban/workspaces",
            "agents/workspaces",
            "agents/runs",
        ] {
            std::fs::create_dir_all(temp.path().join(directory)).unwrap();
        }
        std::fs::write(temp.path().join("workspaces.json"), b"{}").unwrap();
        std::fs::write(temp.path().join("settings.json"), b"{}").unwrap();
        assert!(preflight(temp.path(), 1).is_ok());
        assert!(!temp.path().join("inbox").exists());

        let run = temp.path().join("agents/runs/corrupt.json");
        std::fs::write(&run, b"{bad").unwrap();
        let before = std::fs::read(&run).unwrap();
        assert!(preflight(temp.path(), chrono::Utc::now().timestamp_millis()).is_err());
        assert_eq!(std::fs::read(&run).unwrap(), before);
    }

    fn seed_proof_fixture(config: &Path) -> String {
        let project = config.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let workspaces = crate::workspace::WorkspaceStore::new(config.to_path_buf()).unwrap();
        let workspace = workspaces
            .create(
                "Proof workspace".into(),
                project.to_string_lossy().into_owned(),
            )
            .unwrap();
        workspaces
            .set_kanban_sync(
                &workspace.id,
                crate::workspace::KanbanSyncMode::GitHubIssues,
                Some("fixture/inbox-proof".into()),
            )
            .unwrap();
        crate::kanban::KanbanStore::new(config.to_path_buf()).unwrap();
        crate::agents::AgentRegistry::new(config).unwrap();
        let settings = crate::settings::SettingsStore::new(config.to_path_buf()).unwrap();
        settings
            .replace(crate::settings::Settings::default())
            .unwrap();
        workspace.id
    }

    fn snapshot(root: &Path) -> Vec<(PathBuf, bool, Vec<u8>)> {
        fn walk(root: &Path, at: &Path, out: &mut Vec<(PathBuf, bool, Vec<u8>)>) {
            let mut entries = std::fs::read_dir(at)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect::<Vec<_>>();
            entries.sort();
            for path in entries {
                let metadata = std::fs::symlink_metadata(&path).unwrap();
                let relative = path.strip_prefix(root).unwrap().to_path_buf();
                if metadata.file_type().is_dir() {
                    out.push((relative, true, Vec::new()));
                    walk(root, &path, out);
                } else {
                    out.push((relative, false, std::fs::read(&path).unwrap()));
                }
            }
        }
        let mut out = Vec::new();
        walk(root, root, &mut out);
        out
    }

    fn successful_pr_response() -> Result<String, String> {
        Ok(
            r#"[{"number":1,"title":"Review","url":"https://example.invalid/pr/1","author":{"login":"bot"}}]"#
                .into(),
        )
    }

    fn assert_proof_refuses_without_writing(
        config: PathBuf,
        expected_error: &str,
    ) -> Result<String, String> {
        let before = snapshot(&config);
        let _ = crate::github::take_test_gh_invocations();
        crate::github::set_test_gh_responses(vec![successful_pr_response()]);
        let result = build_proof_with_license(
            config.clone(),
            None,
            crate::license::LicenseStore::new_team_allowed_for_test(config.clone()),
        );
        crate::github::clear_test_gh_responses();
        let invocations = crate::github::take_test_gh_invocations();
        assert_eq!(snapshot(&config), before);
        let error = result.expect_err("unsafe input must stop the headless proof");
        assert!(
            error.contains(expected_error),
            "expected {expected_error:?}, got {error:?}"
        );
        assert!(
            invocations.is_empty(),
            "strict construction must refuse before the PR subprocess seam"
        );
        Err(error)
    }

    #[test]
    fn headless_path_binds_kanban_preflight_before_migrating_load() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().to_path_buf();
        let workspace_id = seed_proof_fixture(&config);
        let board_path = config
            .join("kanban/workspaces")
            .join(format!("{workspace_id}.json"));
        let mut legacy = crate::kanban::KanbanFile::default();
        legacy.version -= 1;
        std::fs::write(&board_path, serde_json::to_vec_pretty(&legacy).unwrap()).unwrap();

        let _ = assert_proof_refuses_without_writing(config, "kanban version");
    }

    #[test]
    fn headless_path_binds_strict_seen_store() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().to_path_buf();
        seed_proof_fixture(&config);
        let seen_path = config.join("inbox/seen.json");
        std::fs::create_dir_all(seen_path.parent().unwrap()).unwrap();
        std::fs::write(&seen_path, b"{corrupt").unwrap();

        let _ = assert_proof_refuses_without_writing(config, "parse Inbox seen store");
    }

    #[test]
    fn headless_path_binds_strict_settings_store() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().to_path_buf();
        seed_proof_fixture(&config);
        std::fs::write(config.join("settings.json"), b"{corrupt").unwrap();

        let _ = assert_proof_refuses_without_writing(config, "settings: strict parse");
    }

    #[test]
    fn headless_path_initializes_shell_environment_from_strict_settings() {
        let _guard = lock_shell_env_test();
        crate::shell_env::init();
        let original = crate::shell_env::get().path.clone();
        let before = "/private/tmp/ply-inbox-headless-path-before";
        let expected = "/private/tmp/ply-inbox-headless-path-expected:/usr/bin";
        crate::shell_env::apply_path_override(before);

        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().to_path_buf();
        seed_proof_fixture(&config);
        let settings = crate::settings::SettingsStore::new(config.clone()).unwrap();
        let mut snapshot = settings.snapshot();
        snapshot.shell.path_override = Some(expected.into());
        settings.replace(snapshot).unwrap();
        crate::github::set_test_gh_responses(vec![successful_pr_response()]);
        let result = build_proof_with_license(
            config.clone(),
            None,
            crate::license::LicenseStore::new_team_allowed_for_test(config),
        );
        crate::github::clear_test_gh_responses();
        let observed = crate::shell_env::get().path.clone();
        crate::shell_env::apply_path_override(&original);
        crate::shell_env::configure_path_override(None);

        assert!(result.is_ok());
        assert_eq!(observed, expected);
    }

    #[test]
    fn preflight_independently_requires_each_unvalidated_write_trigger_path() {
        for missing in ["settings.json", "agents/runs"] {
            let temp = tempfile::tempdir().unwrap();
            let config = temp.path().to_path_buf();
            seed_proof_fixture(&config);
            let path = config.join(missing);
            if path.is_dir() {
                std::fs::remove_dir(&path).unwrap();
            } else {
                std::fs::remove_file(&path).unwrap();
            }
            let before = snapshot(&config);
            let result = preflight(&config, chrono::Utc::now().timestamp_millis());
            assert!(result.is_err(), "missing {missing} must fail independently");
            assert_eq!(
                snapshot(&config),
                before,
                "missing {missing} must not be repaired"
            );
        }
    }

    #[test]
    fn proof_uses_cold_production_pr_path_and_preserves_fixture_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().to_path_buf();
        seed_proof_fixture(&config);

        let before = snapshot(&config);
        crate::github::set_test_gh_responses(vec![successful_pr_response()]);
        let license = crate::license::LicenseStore::new_team_allowed_for_test(config.clone());
        let output = build_proof_with_license(config.clone(), None, license).unwrap();
        crate::github::clear_test_gh_responses();
        let json: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(json["licensed"], true);
        assert_eq!(json["admittedPrTargets"], 1);
        assert_eq!(json["successfulPrSources"], 1);
        assert_eq!(json["failedPrSources"], 0);
        assert_eq!(json["prSourcesComplete"], true);
        assert_eq!(snapshot(&config), before);
        assert!(!config.join("inbox").exists());
        assert_eq!(crate::github::take_test_gh_invocations().len(), 1);
    }

    /// Paid: a Mac with no key refuses the headless proof before GitHub or a
    /// write. Free during the beta (onboarding §11): it goes on to ask GitHub
    /// for the PR source, and refuses only on that source's answer.
    #[test]
    fn free_headless_refuses_without_calling_github_or_writing() {
        for policy in crate::license::PlanCase::ALL {
            let temp = tempfile::tempdir().unwrap();
            let config = temp.path().to_path_buf();
            seed_proof_fixture(&config);
            let before = snapshot(&config);
            let _ = crate::github::take_test_gh_invocations();
            crate::github::set_test_gh_responses(Vec::new());
            let result = build_proof_with_license(
                config.clone(),
                None,
                crate::license::LicenseStore::for_plan_test(config.clone(), policy),
            );
            crate::github::clear_test_gh_responses();
            match policy {
                _ if !policy.team_allowed() => {
                    assert!(result.unwrap_err().contains("requires the Team plan"));
                    assert!(crate::github::take_test_gh_invocations().is_empty());
                    assert_eq!(snapshot(&config), before);
                    assert!(!config.join("inbox").exists());
                }
                _ => {
                    // Past the licence: the proof asked GitHub for the PR
                    // source and refused on the unarmed seam's answer.
                    assert_eq!(
                        result.unwrap_err(),
                        "Inbox eligibility proof requires complete PR sources"
                    );
                    let calls = crate::github::take_test_gh_invocations();
                    assert_eq!(calls.len(), 1);
                    assert_eq!(calls[0][0..4], ["pr", "list", "--repo", "fixture/inbox-proof"]);
                    assert_eq!(snapshot(&config), before, "a proof never writes");
                }
            }
        }
    }

    #[test]
    fn incomplete_pr_source_refuses_without_writing() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().to_path_buf();
        seed_proof_fixture(&config);
        let before = snapshot(&config);
        let _ = crate::github::take_test_gh_invocations();
        crate::github::set_test_gh_responses(vec![Err("offline".into())]);
        let error = build_proof_with_license(
            config.clone(),
            None,
            crate::license::LicenseStore::new_team_allowed_for_test(config.clone()),
        )
        .unwrap_err();
        crate::github::clear_test_gh_responses();
        assert!(error.contains("complete PR sources"));
        assert_eq!(crate::github::take_test_gh_invocations().len(), 1);
        assert_eq!(snapshot(&config), before);
        assert!(!config.join("inbox").exists());
    }
}
