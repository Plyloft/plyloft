//! Onboarding §11 / launch G3: the team this Mac is in comes from
//! `settings.team.teamRepo` (a stored key's `teamRepo` no longer names one),
//! and every reader of "the team repo" goes through
//! [`crate::commands::team_repo_of`]. Each case runs under the plan matrix
//! (`license::PlanCase`) where the plan decides anything.
//!
//! The `#[tauri::command]`s themselves take the product runtime's handle and
//! cannot be registered on a mock app; their bodies are the store-level
//! functions exercised here, and the two generic readers run on a mock app.

use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri::Manager;

use crate::license::PlanCase;

const TEAM: &str = "octocat/octocat-team";

struct Stores {
    _temp: tempfile::TempDir,
    config: std::path::PathBuf,
    settings: crate::settings::SettingsStore,
    license: crate::license::LicenseStore,
    workspaces: crate::workspace::WorkspaceStore,
    team: crate::team::TeamStore,
    memory: crate::memory::MemoryStore,
}

/// No key on this Mac; `team_repo` stored in the settings or not.
fn stores(team_repo: Option<&str>, policy: PlanCase) -> Stores {
    let temp = tempfile::tempdir().expect("tempdir");
    let config = temp.path().join("config");
    let settings = crate::settings::SettingsStore::new(config.clone()).expect("settings store");
    settings
        .set_team_repo(team_repo.map(str::to_string))
        .expect("store the team");
    Stores {
        license: crate::license::LicenseStore::for_plan_test(config.clone(), policy),
        workspaces: crate::workspace::WorkspaceStore::new(config.clone()).expect("workspace store"),
        team: crate::team::TeamStore::new(config.clone()),
        memory: crate::memory::MemoryStore::new(config.clone()).expect("memory store"),
        settings,
        config,
        _temp: temp,
    }
}

#[test]
fn a_team_stored_without_a_key_is_the_team_everywhere() {
    for policy in PlanCase::ALL {
        let s = stores(Some(TEAM), policy);

        let status = crate::commands::team_status_with(
            &s.license,
            &s.settings,
            &s.workspaces,
            &s.team,
            false,
        );
        assert_eq!(status.team_repo.as_deref(), Some(TEAM), "{policy:?}");
        // Sharing into the library.
        assert!(!status.can_write_library);
        let reason = status.write_library_reason.expect("a reason");
        // Launch G3: on the matching Team plan the only reason is the
        // missing clone; in every other case it is the team gate's own words.
        match policy.team_refusal() {
            None => {
                assert!(reason.contains("not cloned"), "{reason}");
                assert!(!reason.contains("key"), "{reason}");
            }
            Some(gate) => assert_eq!(reason, gate, "{policy:?}"),
        }

        let knowledge =
            crate::commands::team_knowledge_view(&s.license, &s.settings, &s.team, &s.memory)
                .expect("team knowledge");
        assert!(knowledge.configured);
        assert!(!knowledge.has_clone);
        assert_eq!(knowledge.can_share, policy.team_allowed());
    }
}

#[test]
fn with_no_team_the_readers_say_so_without_mentioning_a_key() {
    for policy in PlanCase::ALL {
        let s = stores(None, policy);
        let status = crate::commands::team_status_with(
            &s.license,
            &s.settings,
            &s.workspaces,
            &s.team,
            false,
        );
        assert_eq!(status.team_repo, None);

        let knowledge =
            crate::commands::team_knowledge_view(&s.license, &s.settings, &s.team, &s.memory)
                .expect("team knowledge");
        assert!(!knowledge.configured);
        let reason = knowledge.reason.expect("a reason");
        assert!(reason.contains("not on a team yet"), "{reason}");
        assert!(!reason.contains("key"), "{reason}");
    }
}

#[test]
fn team_repo_of_reads_the_setting_and_ignores_a_blank_one() {
    let s = stores(None, PlanCase::TeamMatching);
    assert_eq!(crate::commands::team_repo_of(&s.settings), None);
    s.settings
        .set_team_repo(Some(format!("  {TEAM} ")))
        .unwrap();
    assert_eq!(
        crate::commands::team_repo_of(&s.settings).as_deref(),
        Some(TEAM)
    );
    s.settings.set_team_repo(Some("  ".into())).unwrap();
    assert_eq!(crate::commands::team_repo_of(&s.settings), None);
}

/// The two readers that take an app handle: `current_team_repo` (every
/// command's) and the managed-launch team clone that feeds Claude and Codex
/// the team's skills.
#[test]
fn app_readers_follow_the_setting_and_the_launch_finds_its_clone() {
    let s = stores(Some(TEAM), PlanCase::TeamMatching);
    let clone = s.team.clone_dir(TEAM);
    std::fs::create_dir_all(clone.join(".git")).expect("fake clone");
    let config = s.config.clone();
    let app = mock_builder()
        .manage(s.settings)
        .manage(s.license)
        .manage(s.team)
        .build(mock_context(noop_assets()))
        .expect("mock app");
    let handle = app.handle();
    assert_eq!(
        crate::commands::current_team_repo(handle).as_deref(),
        Some(TEAM)
    );
    assert_eq!(crate::mcp_launch::team_clone_dir(handle), Some(clone));

    // No settings store managed (a narrow app): no team.
    let bare = mock_builder()
        .manage(crate::license::LicenseStore::for_plan_test(
            config,
            PlanCase::TeamMatching,
        ))
        .build(mock_context(noop_assets()))
        .expect("mock app");
    assert_eq!(crate::commands::current_team_repo(bare.handle()), None);
    assert!(bare.try_state::<crate::settings::SettingsStore>().is_none());
}

/// Challenger P3-5: a read of the team records the login it ran as as the
/// team's account when none is recorded — once, for this team only — so the
/// team gates compare with a record, never gh's process-wide guess.
#[test]
fn a_team_read_records_the_teams_account_once() {
    let s = stores(Some(TEAM), PlanCase::TeamMatching);
    let mut status = crate::commands::team_status_with(&s.license, &s.settings, &s.workspaces, &s.team, false);
    status.login = Some("octocat".into());
    // Round 2 (P2-b): a login GitHub says is not a member, or a verdict that
    // is only the last one remembered, records nothing.
    for (membership, stale) in [
        (crate::team::Membership::NotListed, false),
        (crate::team::Membership::NoRepoAccess, false),
        (crate::team::Membership::Unknown, false),
        (crate::team::Membership::Member, true),
    ] {
        status.membership = membership;
        status.membership_stale = stale;
        assert!(crate::commands::record_team_account(&s.settings, &status).is_none(), "{membership:?} stale={stale}");
    }
    assert_eq!(s.settings.snapshot().team.account, None);
    status.membership = crate::team::Membership::Member;
    status.membership_stale = false;
    let saved = crate::commands::record_team_account(&s.settings, &status).expect("recorded");
    assert_eq!(saved.team.account.as_deref(), Some("octocat"));
    status.login = Some("someone-else".into());
    assert!(crate::commands::record_team_account(&s.settings, &status).is_none(), "never overwritten");
    status.team_repo = Some("other/team".into());
    s.settings.clear_team().unwrap();
    s.settings.set_team_repo(Some(TEAM.into())).unwrap();
    assert!(crate::commands::record_team_account(&s.settings, &status).is_none(), "another team's read");
    assert_eq!(s.settings.snapshot().team.account, None);
}
