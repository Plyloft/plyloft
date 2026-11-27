//! 1.176.0 R4: the checks every path passes before a Repair acts on it, on
//! a real disk (a temporary folder as the home), and which step may run.

use super::*;
#[cfg(unix)]
use crate::cli_health::{FolderCheck, FolderKind};
use crate::cli_health::InstallChannel;
use crate::cli_repair::{Block, GiveUp};
#[cfg(unix)]
use crate::cli_repair::StepBy;

#[cfg(unix)]
struct Home {
    _dir: tempfile::TempDir,
    root: PathBuf,
    roots: Roots,
}

#[cfg(unix)]
fn home() -> Home {
    let dir = tempfile::tempdir().unwrap();
    // The look's paths are the home as the process spells it; canonical here
    // so the test reads the same on macOS (/var → /private/var).
    let root = crate::platform::canonicalize(dir.path()).unwrap();
    std::fs::create_dir_all(root.join(".local/bin")).unwrap();
    std::fs::create_dir_all(root.join(".local/share/claude/versions")).unwrap();
    std::fs::create_dir_all(root.join(".claude")).unwrap();
    std::fs::create_dir_all(root.join(".codex")).unwrap();
    std::fs::write(root.join(".codex/auth.json"), "{}").unwrap();
    let roots = Roots {
        windows: false,
        home: root.clone(),
        install_dir: Some(root.join(".local/bin")),
        protected: vec![root.join(".claude"), root.join(".codex")],
    };
    Home { _dir: dir, root, roots }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[cfg(unix)]
fn symlink(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}

#[cfg(unix)]
#[test]
fn the_remover_takes_only_a_version_file_and_a_broken_launcher() {
    let h = home();
    let payload = h.root.join(".local/share/claude/versions/2.1.330");
    std::fs::write(&payload, b"truncated").unwrap();
    let ok = check_removal(CliTool::Claude, &s(&payload), Removal::Payload, &h.roots).unwrap();
    remove(&ok).unwrap();
    assert!(!payload.exists());

    let launcher = h.root.join(".local/bin/claude");
    symlink(&h.root.join(".local/share/claude/versions/gone"), &launcher);
    let ok = check_removal(CliTool::Claude, &s(&launcher), Removal::DanglingLauncher, &h.roots).unwrap();
    remove(&ok).unwrap();
    assert!(std::fs::symlink_metadata(&launcher).is_err());
}

#[cfg(unix)]
#[test]
fn the_remover_refuses_everything_else() {
    let h = home();
    let outside = tempfile::tempdir().unwrap();
    let outside_file = outside.path().join("2.1.330");
    std::fs::write(&outside_file, b"keep me").unwrap();
    let refuse = |path: &Path, kind: Removal| check_removal(CliTool::Claude, &s(path), kind, &h.roots).unwrap_err();

    // Outside its roots.
    assert_eq!(refuse(&outside_file, Removal::Payload), PathRefusal::OutsideRoots);
    assert_eq!(refuse(&h.root.join(".local/bin/other"), Removal::DanglingLauncher), PathRefusal::OutsideRoots);
    assert_eq!(refuse(&h.root.join(".local/share/claude/2.1.330"), Removal::Payload), PathRefusal::OutsideRoots);
    // The home, `/`, the config homes, a sign-in file.
    assert_eq!(refuse(&h.root, Removal::Payload), PathRefusal::Protected);
    assert_eq!(refuse(Path::new("/"), Removal::Payload), PathRefusal::Protected);
    assert_eq!(refuse(&h.root.join(".claude"), Removal::Payload), PathRefusal::Protected);
    assert_eq!(refuse(&h.root.join(".codex"), Removal::DanglingLauncher), PathRefusal::Protected);
    assert_eq!(refuse(&h.root.join(".codex/auth.json"), Removal::Payload), PathRefusal::Protected);
    let versions_auth = h.root.join(".local/share/claude/versions/auth.json");
    std::fs::write(&versions_auth, "{}").unwrap();
    assert_eq!(refuse(&versions_auth, Removal::Payload), PathRefusal::Protected);
    // Not plain.
    let dotted = format!("{}/.local/share/claude/versions/../versions/x", s(&h.root));
    assert_eq!(check_removal(CliTool::Claude, &dotted, Removal::Payload, &h.roots).unwrap_err(), PathRefusal::NotPlain);
    assert_eq!(check_removal(CliTool::Claude, "relative/x", Removal::Payload, &h.roots).unwrap_err(), PathRefusal::NotPlain);
    // A version "file" that is a link out of the home: never followed.
    let linked = h.root.join(".local/share/claude/versions/2.1.1");
    symlink(&outside_file, &linked);
    assert_eq!(refuse(&linked, Removal::Payload), PathRefusal::ThroughLink);
    // A folder is not a version file.
    let folder = h.root.join(".local/share/claude/versions/2.1.2");
    std::fs::create_dir(&folder).unwrap();
    assert_eq!(refuse(&folder, Removal::Payload), PathRefusal::NotAFile);
    // A launcher that works, or isn't a link, stays.
    let real = h.root.join(".local/share/claude/versions/2.1.3");
    std::fs::write(&real, b"ok").unwrap();
    let live = h.root.join(".local/bin/claude");
    symlink(&real, &live);
    assert_eq!(refuse(&live, Removal::DanglingLauncher), PathRefusal::NotDangling);
    let plain_file = h.root.join(".local/bin/codex");
    std::fs::write(&plain_file, b"#!/bin/sh").unwrap();
    assert_eq!(
        check_removal(CliTool::Codex, &s(&plain_file), Removal::DanglingLauncher, &h.roots).unwrap_err(),
        PathRefusal::NotALink
    );
    // Codex has no payload Plyloft removes (its installer heals it).
    assert_eq!(
        check_removal(CliTool::Codex, &s(&real), Removal::Payload, &h.roots).unwrap_err(),
        PathRefusal::OutsideRoots
    );
    assert!(outside_file.exists() && real.exists());
}

#[cfg(unix)]
#[test]
fn a_versions_folder_reached_through_a_link_out_of_the_home_is_refused() {
    let h = home();
    let outside = tempfile::tempdir().unwrap();
    let elsewhere = crate::platform::canonicalize(outside.path()).unwrap();
    std::fs::write(elsewhere.join("2.1.330"), b"not ours").unwrap();
    std::fs::remove_dir(h.root.join(".local/share/claude/versions")).unwrap();
    symlink(&elsewhere, &h.root.join(".local/share/claude/versions"));
    let target = h.root.join(".local/share/claude/versions/2.1.330");
    assert_eq!(
        check_removal(CliTool::Claude, &s(&target), Removal::Payload, &h.roots).unwrap_err(),
        PathRefusal::ThroughLink
    );
    assert!(elsewhere.join("2.1.330").exists());
}

#[cfg(unix)]
fn folder(path: &Path, role: FolderRole, owned: Option<bool>, writable: bool, system: bool) -> FolderCheck {
    FolderCheck {
        path: s(path),
        kind: FolderKind::Dir,
        role,
        channel: InstallChannel::Native,
        needed_now: true,
        system_folder: system,
        exists: true,
        checked: Some(s(path)),
        owned_by_user: owned,
        writable,
    }
}

#[cfg(unix)]
fn health_with(folders: Vec<FolderCheck>) -> CliHealth {
    CliHealth {
        tool: CliTool::Claude,
        healthy: false,
        runs_today: None,
        should_run: None,
        install_dir: None,
        cached: None,
        copies: Vec::new(),
        folders,
        findings: Vec::new(),
        passed_over: None,
    }
}

#[cfg(unix)]
fn chown_step(paths: Vec<String>) -> Step {
    Step {
        id: "fix-ownership-x".into(),
        action: StepAction::FixOwnership { user: "u".into() },
        by: StepBy::Terminal,
        needs: Some(crate::cli_repair::Need::Password),
        optional: false,
        writes: true,
        command: None,
        paths,
        password_again: false,
    }
}

#[cfg(unix)]
#[test]
fn chown_gets_only_the_tool_s_own_folders_in_the_home() {
    let h = home();
    let share = h.root.join(".local/share/claude");
    let unlisted = h.root.join(".local/state");
    std::fs::create_dir_all(&unlisted).unwrap();
    let health = health_with(vec![
        folder(&share, FolderRole::InstallTarget, Some(false), false, false),
        folder(&h.root.join(".claude"), FolderRole::Config, Some(false), false, false),
        folder(Path::new("/opt/homebrew/bin"), FolderRole::Copy, Some(false), false, true),
        folder(&h.root.join(".local/bin"), FolderRole::InstallTarget, Some(true), false, false),
    ]);
    let ok = chown_folders(&chown_step(vec![s(&share), s(&h.root.join(".claude"))]), &health, &h.roots).unwrap();
    let run = crate::setup_actions::repair_chown_plan(CliTool::Claude, "u", &ok, true, false).unwrap();
    assert_eq!(
        run.argv,
        ["/usr/bin/sudo", "/usr/sbin/chown", "-R", "-P", "--", "u", &s(&share), &s(&h.root.join(".claude"))]
    );
    assert_eq!(run.watch, crate::setup_actions::Watch::ExitCode);
    assert_eq!(run.action.id(), "repair-chown.claude");

    let one = |p: &Path| check_chown(&s(p), &health, &h.roots).unwrap_err();
    assert_eq!(one(Path::new("/opt/homebrew/bin")), PathRefusal::OutsideRoots);
    assert_eq!(one(&h.root), PathRefusal::Protected);
    assert_eq!(one(Path::new("/")), PathRefusal::Protected);
    assert_eq!(one(&unlisted), PathRefusal::NotListed);
    // The user's own (only read-only) folder isn't chown's.
    assert_eq!(one(&h.root.join(".local/bin")), PathRefusal::NotListed);
    // A system folder the look listed inside the home is still refused.
    let sys = health_with(vec![folder(&share, FolderRole::InstallTarget, Some(false), false, true)]);
    assert_eq!(check_chown(&s(&share), &sys, &h.roots).unwrap_err(), PathRefusal::SystemFolder);
    // A listed folder that is a link (out of the home) is refused.
    let outside = tempfile::tempdir().unwrap();
    let link = h.root.join(".cache-claude-link");
    symlink(outside.path(), &link);
    let linked = health_with(vec![folder(&link, FolderRole::InstallTarget, Some(false), false, false)]);
    assert_eq!(check_chown(&s(&link), &linked, &h.roots).unwrap_err(), PathRefusal::ThroughLink);
    // One refused folder refuses the whole step.
    assert!(chown_folders(&chown_step(vec![s(&share), "/opt/homebrew/bin".into()]), &health, &h.roots).is_err());
    // Windows has no chown.
    assert!(crate::setup_actions::repair_chown_plan(CliTool::Claude, "u", &ok, true, true).is_err());
    // A user name that could be an option is refused.
    assert!(crate::setup_actions::repair_chown_plan(CliTool::Claude, "-R", &ok, true, false).is_err());
    // Never to root.
    assert!(crate::setup_actions::repair_chown_plan(CliTool::Claude, "root", &ok, true, false).is_err());
    assert!(crate::setup_actions::repair_chown_plan(CliTool::Claude, "0", &ok, true, false).is_err());
    // The install folder (shared with other programs) is never `-R`'s.
    let shared = health_with(vec![folder(&h.root.join(".local/bin"), FolderRole::InstallTarget, Some(false), false, false)]);
    assert_eq!(check_chown(&s(&h.root.join(".local/bin")), &shared, &h.roots).unwrap_err(), PathRefusal::NotOnlyTheTool);
}

#[cfg(unix)]
#[test]
fn a_read_only_folder_of_the_user_gets_only_the_owner_s_bits() {
    use std::os::unix::fs::PermissionsExt;
    let h = home();
    let bin = h.root.join(".local/bin");
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o555)).unwrap();
    let health = health_with(vec![folder(&bin, FolderRole::InstallTarget, Some(true), false, false)]);
    let step = Step {
        id: "fix-permissions-x".into(),
        action: StepAction::FixPermissions,
        by: StepBy::Plyloft,
        needs: None,
        optional: false,
        writes: true,
        command: None,
        paths: vec![s(&bin)],
        password_again: false,
    };
    let applied = apply_own_step(&step, &health, &h.roots, &|_| true).unwrap();
    assert_eq!(applied.paths, [s(&bin)]);
    let mode = std::fs::metadata(&bin).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o755);
    // A folder that isn't the user's is chown's, not chmod's.
    let theirs = health_with(vec![folder(&bin, FolderRole::InstallTarget, Some(false), false, false)]);
    assert_eq!(apply_own_step(&step, &theirs, &h.roots, &|_| true).unwrap_err(), PathRefusal::NotListed);
}

#[cfg(unix)]
#[test]
fn one_refused_path_changes_nothing() {
    let h = home();
    let payload = h.root.join(".local/share/claude/versions/2.1.330");
    std::fs::write(&payload, b"truncated").unwrap();
    let step = Step {
        id: "remove-broken-payload-x".into(),
        action: StepAction::RemoveBrokenPayload,
        by: StepBy::Plyloft,
        needs: None,
        optional: false,
        writes: true,
        command: None,
        paths: vec![s(&payload), s(&h.root.join(".codex/auth.json"))],
        password_again: false,
    };
    assert_eq!(apply_own_step(&step, &health_with(Vec::new()), &h.roots, &|_| true).unwrap_err(), PathRefusal::Protected);
    assert!(payload.exists() && h.root.join(".codex/auth.json").exists());
}

#[test]
fn the_npm_removal_carries_its_own_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let prefix = crate::platform::canonicalize(dir.path()).unwrap();
    let windows = cfg!(windows);
    let package = if windows {
        prefix.join("node_modules").join("@anthropic-ai").join("claude-code")
    } else {
        prefix.join("lib").join("node_modules").join("@anthropic-ai").join("claude-code")
    };
    // Not a prefix of this package yet.
    assert_eq!(check_npm_prefix(CliTool::Claude, &s(&prefix), windows).unwrap_err(), PathRefusal::OutsideRoots);
    std::fs::create_dir_all(&package).unwrap();
    let checked = check_npm_prefix(CliTool::Claude, &s(&prefix), windows).unwrap();
    let run =
        crate::setup_actions::repair_npm_remove_plan(CliTool::Claude, "/opt/homebrew/bin/npm", &checked, "/usr/bin", windows)
            .unwrap();
    // npm's `#!/usr/bin/env node` finds the prefix's own node first.
    let first = if windows { s(&prefix) } else { format!("{}/bin", s(&prefix)) };
    let sep = if windows { ';' } else { ':' };
    assert!(run.env.contains(&("PATH".to_string(), format!("{first}{sep}/usr/bin"))));
    assert_eq!(
        run.argv,
        ["/opt/homebrew/bin/npm", "uninstall", "-g", "--prefix", &s(&prefix), "@anthropic-ai/claude-code"]
    );
    assert!(run.env.contains(&("npm_config_prefix".to_string(), s(&prefix))));
    assert_eq!(run.watch, crate::setup_actions::Watch::ExitCode);
    assert_eq!(check_npm_prefix(CliTool::Claude, "/", windows).unwrap_err(), if windows { PathRefusal::NotPlain } else { PathRefusal::Protected });
    assert_eq!(check_npm_prefix(CliTool::Claude, "rel/prefix", windows).unwrap_err(), PathRefusal::NotPlain);
}

#[test]
fn the_installer_runs_with_its_folder_on_path_and_the_real_home() {
    let facts = crate::setup_actions::PlanFacts::default();
    let path = path_with("/usr/bin:/bin", Some("/Users/u/.local/bin"), false);
    assert_eq!(path, "/usr/bin:/bin:/Users/u/.local/bin");
    assert_eq!(path_with(&path, Some("/Users/u/.local/bin"), false), path);
    let run = crate::setup_actions::repair_install_plan(CliTool::Codex, &facts, Some("/Users/u"), &path).unwrap();
    assert_eq!(run.argv[..4], ["/bin/bash", "-o", "pipefail", "-c"]);
    assert_eq!(run.argv[4], "curl -fsSL https://chatgpt.com/codex/install.sh | sh");
    assert!(run.env.contains(&("PATH".to_string(), path.clone())));
    assert!(run.env.contains(&("HOME".to_string(), "/Users/u".to_string())));
    assert_eq!(run.action.id(), "repair-install.codex");
    assert_eq!(crate::setup_outcome::program_tool(run.action), Some(crate::setup_actions::Tool::Codex));
    // Never a frontend id: these are built only by the Repair.
    assert!(crate::setup_actions::ActionId::parse("repair-install.codex").is_none());
}

fn plan_with(steps: Vec<Step>, next: Option<&str>, block: Option<Block>) -> RepairPlan {
    RepairPlan {
        tool: CliTool::Claude,
        situations: Vec::new(),
        notes: Vec::new(),
        steps,
        block,
        next_step: next.map(String::from),
        manual: Vec::new(),
        quick: false,
        update_blocked: false,
    }
}

fn simple(id: &str, action: StepAction) -> Step {
    let kind = action.kind();
    Step {
        id: id.into(),
        action,
        by: kind.by(),
        needs: None,
        optional: false,
        writes: kind.writes(),
        command: None,
        paths: Vec::new(),
        password_again: false,
    }
}

#[test]
fn only_the_fresh_plan_s_next_step_runs() {
    let install = simple("run-installer-1", StepAction::RunInstaller { channel: InstallChannel::Native });
    let reread = simple("reread-1", StepAction::Reread);
    let verify = simple("verify-1", StepAction::Verify);
    let plan = plan_with(vec![install.clone(), reread, verify], Some("run-installer-1"), None);
    assert_eq!(runnable(&plan, "run-installer-1").unwrap().id, "run-installer-1");
    // An id from an older plan (its paths changed) is not in this one.
    assert_eq!(runnable(&plan, "run-installer-0").unwrap_err(), Refusal::NotInPlan);
    // Later steps wait their turn; a read-only Verify never has to.
    assert_eq!(runnable(&plan, "reread-1").unwrap_err(), Refusal::NotNextStep);
    assert!(runnable(&plan, "verify-1").is_ok());
    // A blocked plan runs nothing that writes.
    let blocked = plan_with(
        vec![install],
        None,
        Some(Block::CouldNotRepair { reason: GiveUp::StillThereAfter, step: None, evidence: None }),
    );
    assert_eq!(runnable(&blocked, "run-installer-1").unwrap_err(), Refusal::Blocked);
}

#[test]
fn nothing_runs_while_the_tool_s_sessions_are_open() {
    let close = simple("close-sessions-1", StepAction::CloseSessions { sessions: Vec::new() });
    let install = simple("run-installer-1", StepAction::RunInstaller { channel: InstallChannel::Native });
    let remove = simple("remove-broken-payload-1", StepAction::RemoveBrokenPayload);
    let plan = plan_with(vec![close, remove, install], None, None);
    for id in ["close-sessions-1", "remove-broken-payload-1", "run-installer-1"] {
        assert_eq!(runnable(&plan, id).unwrap_err(), Refusal::SessionsInUse, "{id}");
    }
}

#[test]
fn a_user_name_for_chown_is_plain() {
    for good in ["u", "matteo", "ada.lovelace", "j_d-1", "501"] {
        assert!(valid_user(good), "{good}");
    }
    for bad in ["", "-R", "a b", "a;b", "$(x)", "a/b", "root", "0"] {
        assert!(!valid_user(bad), "{bad}");
    }
}

#[test]
fn free_space_is_read_where_the_install_goes() {
    let dir = tempfile::tempdir().unwrap();
    // A folder that doesn't exist yet is read through its parent.
    assert!(free_bytes(&dir.path().join("not/yet")).is_some_and(|b| b > 0));
}

#[cfg(unix)]
#[test]
fn the_install_folder_and_its_launcher_are_chowned_without_r() {
    let h = home();
    let bin = h.root.join(".local/bin");
    let launcher = bin.join("claude");
    symlink(&h.root.join(".local/share/claude/versions/gone"), &launcher);
    let other = bin.join("other-tool");
    std::fs::write(&other, b"#!/bin/sh").unwrap();
    let mut health = health_with(vec![folder(&bin, FolderRole::InstallTarget, Some(false), false, false)]);
    health.install_dir = Some(s(&bin));
    let step = Step {
        id: "fix-shared-ownership-x".into(),
        action: StepAction::FixSharedOwnership { user: "u".into() },
        by: StepBy::Terminal,
        needs: Some(crate::cli_repair::Need::Password),
        optional: false,
        writes: true,
        command: None,
        paths: vec![s(&bin), s(&launcher)],
        password_again: false,
    };
    let ok = chown_folders(&step, &health, &h.roots).unwrap();
    let run = crate::setup_actions::repair_chown_plan(CliTool::Claude, "u", &ok, false, false).unwrap();
    assert_eq!(run.argv, ["/usr/bin/sudo", "/usr/sbin/chown", "-h", "--", "u", &s(&bin), &s(&launcher)]);
    assert!(!run.argv.iter().any(|a| a == "-R"));
    // Another program's entry there is never named.
    let theirs = Step { paths: vec![s(&other)], ..step.clone() };
    assert!(chown_folders(&theirs, &health, &h.roots).is_err());
    // This home is the test's own user's.
    assert!(home_is_mine(&h.roots).is_ok());
}

#[test]
fn a_stopped_run_or_one_still_running_is_no_attempt_and_a_finished_one_is() {
    use crate::setup_last_run::LastRun;
    let at = chrono::Utc::now();
    let attempts = vec![
        Attempt { tool: CliTool::Claude, kind: StepKind::RunInstaller, run: Some(("r1".into(), "repair-install.claude".into(), at)) },
        Attempt { tool: CliTool::Claude, kind: StepKind::Reread, run: None },
        Attempt { tool: CliTool::Codex, kind: StepKind::RunInstaller, run: None },
    ];
    // Stopped: Stop keeps no record, so the last one is older (or none).
    let older = LastRun {
        action_id: "repair-install.claude".into(),
        finished_at: Some((at - chrono::Duration::hours(1)).to_rfc3339()),
        ..LastRun::default()
    };
    assert_eq!(counted(&attempts, CliTool::Claude, None, Some(&older)), [StepKind::Reread]);
    assert_eq!(counted(&attempts, CliTool::Claude, None, None), [StepKind::Reread]);
    // Still running.
    let done = LastRun { finished_at: Some((at + chrono::Duration::seconds(30)).to_rfc3339()), ..older.clone() };
    assert_eq!(counted(&attempts, CliTool::Claude, Some("r1"), Some(&done)), [StepKind::Reread]);
    // Ended with its record: the loop guard may use it.
    assert_eq!(counted(&attempts, CliTool::Claude, None, Some(&done)), [StepKind::RunInstaller, StepKind::Reread]);
    // Another action's record doesn't count for it.
    let other = LastRun { action_id: "update.claude".into(), ..done };
    assert_eq!(counted(&attempts, CliTool::Claude, None, Some(&other)), [StepKind::Reread]);
}

#[test]
fn a_chown_s_output_is_never_kept() {
    use crate::setup_actions::ActionId;
    let tail = vec!["hunter2".to_string(), "Password:".to_string()];
    assert!(crate::setup_outcome::kept_tail(ActionId::RepairChownClaude, tail.clone()).is_empty());
    assert!(crate::setup_outcome::kept_tail(ActionId::RepairChownCodex, tail.clone()).is_empty());
    assert_eq!(crate::setup_outcome::kept_tail(ActionId::RepairInstallClaude, tail.clone()), tail);
    // Its cause is still read (in memory) from it.
    let sudo = vec!["Sorry, try again.".to_string(), "sudo: 3 incorrect password attempts".to_string()];
    let chown = ActionId::RepairChownClaude;
    assert_eq!(crate::setup_outcome::classify_for(chown, &sudo, Some(1), false).cause, crate::setup_outcome::Cause::PasswordRefused);
    // Review 2: only a chown's output is read for sudo's answers.
    assert_ne!(
        crate::setup_outcome::classify_for(ActionId::RepairInstallClaude, &sudo, Some(1), false).cause,
        crate::setup_outcome::Cause::PasswordRefused
    );
    let admin = vec!["u is not in the sudoers file.  This incident will be reported.".to_string()];
    assert_eq!(crate::setup_outcome::classify_for(chown, &admin, Some(1), false).cause, crate::setup_outcome::Cause::NotAdmin);
    assert_eq!(
        crate::setup_outcome::classify_for(ActionId::UpdateClaude, &admin, Some(1), false).cause,
        crate::setup_outcome::Cause::Unknown
    );
}

#[test]
fn setup_s_update_refuses_a_copy_it_cant_write() {
    use crate::setup_actions::{update_refusal, ActionId};
    assert!(update_refusal(ActionId::UpdateClaude, Some(false)).is_some_and(|w| w.contains("Repair")));
    assert!(update_refusal(ActionId::UpdateCodex, Some(false)).is_some());
    // 1.176.0 seams: typed, so Setup's block offers Repair.
    assert!(update_refusal(ActionId::UpdateCodex, Some(false))
        .is_some_and(|w| w.starts_with("PLY_CLI_UPDATE_REFUSED_V1:{\"tool\":\"codex\"}\n")));
    assert_eq!(update_refusal(ActionId::UpdateClaude, Some(true)), None);
    assert_eq!(update_refusal(ActionId::UpdateClaude, None), None);
    assert_eq!(update_refusal(ActionId::InstallClaude, Some(false)), None);
}

fn start(starts: bool, failure: Option<crate::cli_health::StartFailure>) -> crate::cli_health::CopyStart {
    crate::cli_health::CopyStart {
        starts,
        version: starts.then(|| "2.1.330".into()),
        failure,
        inconclusive: false,
        exit_code: None,
        signal: None,
        tail: None,
    }
}

#[test]
fn a_version_file_is_confirmed_broken_only_by_a_second_look() {
    use crate::cli_health::StartFailure;
    let bad = start(false, Some(StartFailure::BadBinary));
    assert!(payload_confirmed(&bad, Some(false), true), "codesign fails: confirmed");
    assert!(!payload_confirmed(&bad, Some(true), true), "codesign passes: intact, kept");
    assert!(payload_confirmed(&bad, None, true), "codesign couldn't run: the second probe decides");
    assert!(payload_confirmed(&bad, None, false), "elsewhere: a second identical failure");
    assert!(!payload_confirmed(&start(true, None), Some(false), true), "it starts now");
    let killed = crate::cli_health::start_from(crate::cli_health::RunOutcome::Exited {
        code: None,
        signal: Some(15),
        stdout: Vec::new(),
        stderr: Vec::new(),
    });
    assert!(killed.inconclusive && killed.failure == Some(StartFailure::Signal));
    assert!(!payload_confirmed(&killed, None, false), "an intact binary killed by SIGTERM");
}

#[cfg(unix)]
#[test]
fn an_unconfirmed_version_file_is_never_removed() {
    let h = home();
    let payload = h.root.join(".local/share/claude/versions/2.1.330");
    std::fs::write(&payload, b"intact").unwrap();
    let step = Step {
        id: "remove-broken-payload-x".into(),
        action: StepAction::RemoveBrokenPayload,
        by: StepBy::Plyloft,
        needs: None,
        optional: false,
        writes: true,
        command: None,
        paths: vec![s(&payload)],
        password_again: false,
    };
    assert_eq!(apply_own_step(&step, &health_with(Vec::new()), &h.roots, &|_| false).unwrap_err(), PathRefusal::NotConfirmed);
    assert!(payload.exists());
}

/// R0 C4 again, at the removal: a truncated and a byte-changed copy of
/// `/bin/ls` are confirmed broken (second probe + `codesign --verify`); the
/// same slice unchanged is not, whatever the first probe said.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[test]
fn real_broken_mach_o_files_are_confirmed_and_an_intact_one_is_not() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let ls = std::fs::read("/bin/ls").unwrap();
    let slice = arm64e_slice(&ls).expect("an arm64e slice in /bin/ls");
    let mut flipped = slice.clone();
    let middle = flipped.len() / 2;
    flipped[middle] ^= 0xff;
    let write = |name: &str, bytes: &[u8]| {
        let p = dir.path().join(name);
        std::fs::write(&p, bytes).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        s(&p)
    };
    assert!(confirm_broken(&write("cut", &ls[..4096]), "/usr/bin:/bin"));
    assert!(confirm_broken(&write("flipped", &flipped), "/usr/bin:/bin"));
    assert!(!confirm_broken(&write("intact", &slice), "/usr/bin:/bin"));
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn arm64e_slice(fat: &[u8]) -> Option<Vec<u8>> {
    let word = |at: usize| -> Option<u64> { Some(u32::from_be_bytes(fat.get(at..at + 4)?.try_into().ok()?).into()) };
    if word(0)? != 0xcafe_babe {
        return None;
    }
    (0..word(4)? as usize).find_map(|i| {
        let at = 8 + i * 20;
        let (cpu, sub) = (word(at)?, word(at + 4)? & 0xff);
        let (offset, size) = (word(at + 8)? as usize, word(at + 12)? as usize);
        (cpu == 0x0100_000c && sub == 2).then(|| fat.get(offset..offset + size).map(<[u8]>::to_vec)).flatten()
    })
}

#[cfg(unix)]
#[test]
fn hard_links_of_another_account_refuse_a_recursive_chown() {
    let h = home();
    let tree = h.root.join(".claude");
    std::fs::write(tree.join("mine"), b"x").unwrap();
    std::fs::hard_link(tree.join("mine"), tree.join("mine-again")).unwrap();
    // The user's own hard links are fine.
    assert!(check_hard_links(&tree).is_ok());
    // One of root's (a system file hard-linked here) can't be made without
    // root; the refusal is shown on a root-owned multi-link file when the
    // system has one under /usr (read only, nothing changed).
    let sys = std::path::Path::new("/usr/bin");
    let mut found = None;
    if let Ok(entries) = std::fs::read_dir(sys) {
        use std::os::unix::fs::MetadataExt;
        for e in entries.flatten() {
            if let Ok(m) = std::fs::symlink_metadata(e.path()) {
                if m.is_file() && m.nlink() > 1 && m.uid() == 0 {
                    found = Some(e.path());
                    break;
                }
            }
        }
    }
    if let Some(file) = found {
        assert_eq!(check_hard_links(&file), Err(PathRefusal::HardLinked));
    }
}

#[test]
fn a_quick_plan_is_marked_and_has_nothing_to_run() {
    let install = simple("run-installer-1", StepAction::RunInstaller { channel: InstallChannel::Native });
    let quick = as_quick(plan_with(vec![install], Some("run-installer-1"), None));
    assert!(quick.quick);
    assert_eq!(quick.next_step, None);
    assert_eq!(runnable(&quick, "run-installer-1").unwrap_err(), Refusal::NotNextStep);
    assert_eq!(serde_json::to_value(Refusal::QuickPlan).unwrap(), "quickPlan");
    let r: RepairRequest = serde_json::from_str(r#"{"quick":true,"reinstall":true}"#).unwrap();
    assert!(r.quick && r.reinstall);
}
