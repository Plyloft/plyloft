//! 1.176.0 R4: the planner, case by case. Each machine is described to
//! `cli_health::inspect` through a scripted [`Machine`] (Mac and Windows from
//! strings, as R1's tests do), so the findings the planner reads are the ones
//! R1 really produces.

use super::*;
use crate::cli_health::{inspect, Cached, FileLook, FolderKind, FolderLook, Inputs, Look, Machine, RunOutcome};
use std::collections::HashMap;
use std::time::Duration;

// ---------------------------------------------------------------- the fake

#[derive(Default)]
struct Fake {
    files: HashMap<String, Look>,
    folders: HashMap<String, FolderLook>,
    runs: HashMap<String, RunOutcome>,
    /// 1.176.1 (Windows walk): a program that starts only when the PATH it
    /// runs with holds this folder (an npm shim's `node`); else it exits 1.
    needs: HashMap<String, String>,
}

fn mine(real: &str) -> FileLook {
    FileLook {
        link_target: None,
        chain_end: None,
        real_path: Some(real.into()),
        target_unreadable: false,
        is_file: true,
        executable: true,
        owned: Some(true),
        folder_owned: Some(true),
    }
}

fn exited(code: Option<i32>, signal: Option<i32>, stdout: &str) -> RunOutcome {
    RunOutcome::Exited { code, signal, stdout: stdout.as_bytes().to_vec(), stderr: Vec::new() }
}

impl Fake {
    fn link(mut self, path: &str, real: &str, version: &str) -> Self {
        let look = FileLook { link_target: Some(real.into()), chain_end: Some(real.into()), ..mine(real) };
        self.files.insert(path.into(), Look::Found(look));
        self.runs.insert(path.into(), exited(Some(0), None, &format!("{version}\n")));
        self
    }

    fn file(mut self, path: &str, version: &str) -> Self {
        self.files.insert(path.into(), Look::Found(mine(path)));
        self.runs.insert(path.into(), exited(Some(0), None, &format!("{version}\n")));
        self
    }

    fn dangling(mut self, path: &str, end: &str) -> Self {
        let look = FileLook { link_target: Some(end.into()), chain_end: Some(end.into()), ..FileLook::default() };
        self.files.insert(path.into(), Look::Found(look));
        self
    }

    fn needs(mut self, program: &str, dir: &str) -> Self {
        self.needs.insert(program.into(), dir.into());
        self
    }

    fn runs(mut self, path: &str, outcome: RunOutcome) -> Self {
        self.runs.insert(path.into(), outcome);
        self
    }

    fn folder(mut self, path: &str, owned: Option<bool>, writable: bool) -> Self {
        self.folders.insert(path.into(), FolderLook { exists: true, checked: Some(path.into()), owned, writable });
        self
    }

    fn missing_folder(mut self, path: &str, checked: &str, owned: Option<bool>, writable: bool) -> Self {
        self.folders.insert(path.into(), FolderLook { exists: false, checked: Some(checked.into()), owned, writable });
        self
    }
}

impl Machine for Fake {
    fn look(&self, path: &str) -> Look {
        self.files.get(path).cloned().unwrap_or(Look::Absent)
    }

    fn folder(&self, path: &str, _kind: FolderKind) -> FolderLook {
        self.folders
            .get(path)
            .cloned()
            .unwrap_or(FolderLook { exists: true, checked: Some(path.into()), owned: Some(true), writable: true })
    }

    fn run_version(&self, program: &str, env_path: &str, _timeout: Duration) -> RunOutcome {
        if let Some(dir) = self.needs.get(program) {
            if !env_path.to_ascii_lowercase().contains(&dir.to_ascii_lowercase()) {
                return RunOutcome::Exited { code: Some(1), signal: None, stdout: Vec::new(), stderr: b"env: node: No such file or directory".to_vec() };
            }
        }
        self.runs.get(program).cloned().unwrap_or_else(|| panic!("no run scripted for {program}"))
    }
}

const PATH: &str = "/Users/u/.local/bin:/opt/homebrew/bin:/usr/bin:/bin";
const LAUNCHER: &str = "/Users/u/.local/bin/claude";
const PAYLOAD: &str = "/Users/u/.local/share/claude/versions/2.1.330";
const CODEX: &str = "/Users/u/.local/bin/codex";
const CODEX_REAL: &str = "/Users/u/.codex/packages/standalone/releases/0.171.0-aarch64-apple-darwin/bin/codex";
const NPM_BIN: &str = "/opt/homebrew/bin/claude";
const NPM_REAL: &str = "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js";

fn mac(path: &str, cached: Option<&str>) -> Inputs {
    Inputs {
        path: path.into(),
        windows: false,
        home: Some("/Users/u".into()),
        codex_home: Some("/Users/u/.codex".into()),
        npm_prefix: Some("/opt/homebrew".into()),
        system_dirs: vec!["/opt/homebrew/bin".into(), "/usr/local/bin".into()],
        cached: cached.map_or(Cached::Absent, |p| Cached::Path(p.into())),
        version_bounds: Some((Duration::from_millis(10), Duration::from_millis(10))),
        // 1.176.1 (Windows walk): what the shell reports, read only under an
        // override (an outside copy is asked with it).
        shell_path: Some(SHELL_PATH.into()),
        ..Inputs::default()
    }
}

fn ctx() -> RepairContext {
    RepairContext {
        windows: false,
        home: Some("/Users/u".into()),
        user: Some("u".into()),
        npms: vec![("/opt/homebrew".into(), "/opt/homebrew/bin/npm".into())],
        free_bytes: Some(50 * NEEDED_FREE_BYTES),
        reach: Some(Reach::ok()),
        ..RepairContext::default()
    }
}

fn kinds(plan: &RepairPlan) -> Vec<StepKind> {
    plan.steps.iter().map(Step::kind).collect()
}

fn step_of(plan: &RepairPlan, kind: StepKind) -> &Step {
    plan.steps.iter().find(|s| s.kind() == kind).unwrap_or_else(|| panic!("no {kind:?} in {plan:#?}"))
}

fn has_situation(plan: &RepairPlan, f: impl Fn(&Situation) -> bool) -> bool {
    plan.situations.iter().any(f)
}

fn has_note(plan: &RepairPlan, f: impl Fn(&Note) -> bool) -> bool {
    plan.notes.iter().any(f)
}

fn claude(fake: &Fake, inputs: &Inputs) -> CliHealth {
    inspect(CliTool::Claude, inputs, fake)
}

fn healthy_claude() -> Fake {
    Fake::default().link(LAUNCHER, PAYLOAD, "2.1.330 (Claude Code)")
}

fn tile(pty: &str) -> SessionInUse {
    SessionInUse { source: SessionSource::Tile, id: pty.into(), label: None, pty_id: Some(pty.into()) }
}

// ---------------------------------------------------------------- the cases

#[test]
fn a_healthy_tool_has_nothing_to_repair() {
    let h = claude(&healthy_claude(), &mac(PATH, Some(LAUNCHER)));
    assert!(h.healthy, "{h:#?}");
    let plan = plan(&h, &ctx());
    assert_eq!(plan.block, Some(Block::NothingToRepair { healthy_enough: false }));
    assert_eq!(plan.situations, vec![Situation::Healthy]);
    assert!(plan.steps.is_empty() && plan.next_step.is_none());
}

#[test]
fn a_missing_tool_gets_the_official_installer() {
    let h = claude(&Fake::default(), &mac(PATH, None));
    let plan = plan(&h, &ctx());
    assert!(has_situation(&plan, |s| *s == Situation::Missing));
    assert_eq!(kinds(&plan), [StepKind::RunInstaller, StepKind::Reread, StepKind::Verify]);
    let install = step_of(&plan, StepKind::RunInstaller);
    assert_eq!(install.command.as_deref(), Some("curl -fsSL https://claude.ai/install.sh | bash"));
    assert_eq!(install.by, StepBy::Terminal);
    assert_eq!(install.action, StepAction::RunInstaller { channel: InstallChannel::Native });
    assert_eq!(plan.next_step.as_deref(), Some(install.id.as_str()));
    assert!(plan.block.is_none());
    assert!(plan.manual.iter().any(|m| m.purpose == ManualPurpose::Install));
}

#[test]
fn a_dangling_claude_launcher_is_removed_then_installed_again() {
    // R0 C3: `versions/<v>` moved away, the link in ~/.local/bin left.
    let fake = Fake::default().dangling(LAUNCHER, PAYLOAD);
    let h = claude(&fake, &mac(PATH, Some(LAUNCHER)));
    let plan = plan(&h, &ctx());
    assert!(has_situation(&plan, |s| matches!(s, Situation::DanglingLauncher { path, .. } if path == LAUNCHER)));
    assert_eq!(
        kinds(&plan),
        [StepKind::RemoveDanglingLauncher, StepKind::RunInstaller, StepKind::Reread, StepKind::Verify]
    );
    let removal = step_of(&plan, StepKind::RemoveDanglingLauncher);
    assert_eq!(removal.paths, [LAUNCHER]);
    assert_eq!((removal.by, removal.needs), (StepBy::Plyloft, None));
}

#[test]
fn a_dangling_codex_launcher_is_removed_then_installed_again() {
    // R0 X3: `releases/<v>` removed, `current` dangles behind ~/.local/bin/codex.
    let fake = Fake::default().dangling(CODEX, "/Users/u/.codex/packages/standalone/current/bin/codex");
    let h = inspect(CliTool::Codex, &mac(PATH, Some(CODEX)), &fake);
    let plan = plan(&h, &ctx());
    assert_eq!(
        kinds(&plan),
        [StepKind::RemoveDanglingLauncher, StepKind::RunInstaller, StepKind::Reread, StepKind::Verify]
    );
    assert_eq!(
        step_of(&plan, StepKind::RunInstaller).command.as_deref(),
        Some("curl -fsSL https://chatgpt.com/codex/install.sh | sh")
    );
}

#[test]
fn a_corrupt_claude_version_file_goes_before_the_installer() {
    // R0 C4: killed at start (SIGKILL); the plain installer leaves the same
    // file in place, so it is removed first.
    let fake = healthy_claude().runs(LAUNCHER, exited(None, Some(9), ""));
    let h = claude(&fake, &mac(PATH, Some(LAUNCHER)));
    let plan = plan(&h, &ctx());
    assert!(has_situation(&plan, |s| matches!(s, Situation::BrokenBinary { failure: StartFailure::BadBinary, .. })));
    assert_eq!(
        kinds(&plan),
        [StepKind::RemoveBrokenPayload, StepKind::RunInstaller, StepKind::Reread, StepKind::Verify]
    );
    assert_eq!(step_of(&plan, StepKind::RemoveBrokenPayload).paths, [PAYLOAD]);
    assert!(plan
        .manual
        .iter()
        .any(|m| m.purpose == ManualPurpose::RemovePayload && m.command == format!("rm {PAYLOAD}")));
}

#[test]
fn a_corrupt_codex_is_left_to_its_installer() {
    // R0 X3: Codex's installer notices an incomplete release and reinstalls.
    let fake = Fake::default().link(CODEX, CODEX_REAL, "codex-cli 0.171.0").runs(CODEX, exited(Some(137), None, ""));
    let h = inspect(CliTool::Codex, &mac(PATH, Some(CODEX)), &fake);
    let plan = plan(&h, &ctx());
    assert_eq!(kinds(&plan), [StepKind::RunInstaller, StepKind::Reread, StepKind::Verify]);
}

#[test]
fn folders_of_another_account_in_the_home_are_given_back_with_one_chown() {
    // A `sudo claude update`: the share folder and its versions are root's.
    let fake = healthy_claude()
        .runs(LAUNCHER, exited(Some(1), None, ""))
        .folder("/Users/u/.local/share/claude", Some(false), false)
        .folder("/Users/u/.local/share/claude/versions", Some(false), false)
        // A system folder that isn't the user's: never in the chown.
        .folder("/opt/homebrew/bin", Some(false), false);
    let h = claude(&fake, &mac(PATH, Some(LAUNCHER)));
    let plan = plan(&h, &ctx());
    assert!(has_situation(&plan, |s| matches!(s, Situation::FoldersNotOwned { .. })));
    let chown = step_of(&plan, StepKind::FixOwnership);
    // `-R` on the outer folder covers the inner one.
    assert_eq!(chown.paths, ["/Users/u/.local/share/claude"]);
    assert_eq!(chown.needs, Some(Need::Password));
    assert_eq!(chown.command.as_deref(), Some("sudo chown -R -P -- u /Users/u/.local/share/claude"));
    assert_eq!(kinds(&plan)[0], StepKind::FixOwnership);
    assert!(kinds(&plan).contains(&StepKind::RunInstaller));
    assert!(plan.steps.iter().all(|s| s.paths.iter().all(|p| !p.starts_with("/opt"))));
}

#[test]
fn a_read_only_folder_of_the_user_gets_its_bits_back_without_a_password() {
    // R0 C5: `chmod 555 ~/.local/bin` — Claude says it updated and didn't.
    let fake = healthy_claude().folder("/Users/u/.local/bin", Some(true), false);
    let h = claude(&fake, &mac(PATH, Some(LAUNCHER)));
    let plan = plan(&h, &ctx());
    assert!(has_situation(
        &plan,
        |s| matches!(s, Situation::FoldersNotWritable { paths } if paths == &["/Users/u/.local/bin"])
    ));
    // It works today: no reinstall, only the folder.
    assert_eq!(kinds(&plan), [StepKind::FixPermissions, StepKind::Reread, StepKind::Verify]);
    let fix = step_of(&plan, StepKind::FixPermissions);
    assert_eq!(fix.paths, ["/Users/u/.local/bin"]);
    assert_eq!((fix.by, fix.needs), (StepBy::Plyloft, None));
    assert!(!kinds(&plan).contains(&StepKind::FixOwnership));
}

#[test]
fn problems_only_in_system_folders_are_named_and_never_get_sudo() {
    // A Homebrew Codex whose Cellar isn't writable: not the user's to fix.
    let brew = "/opt/homebrew/bin/codex";
    let real = "/opt/homebrew/Cellar/codex/0.171.0/bin/codex";
    let fake = Fake::default()
        .link(brew, real, "codex-cli 0.171.0")
        .folder("/opt/homebrew/Cellar", Some(false), false)
        .folder("/opt/homebrew/bin", Some(false), false);
    let h = inspect(CliTool::Codex, &mac("/opt/homebrew/bin:/usr/bin", Some(brew)), &fake);
    let plan = plan(&h, &ctx());
    assert!(has_situation(&plan, |s| matches!(s, Situation::SystemFolders { .. })));
    assert!(has_situation(&plan, |s| matches!(s, Situation::CannotUpdate { channel: InstallChannel::Homebrew, .. })));
    assert!(!kinds(&plan).contains(&StepKind::FixOwnership));
    assert!(plan.manual.iter().all(|m| !m.command.contains("sudo")));
    // Its own install is offered instead, and the Homebrew copy is named.
    assert!(kinds(&plan).contains(&StepKind::RunInstaller));
    assert!(has_note(&plan, |n| matches!(n, Note::OtherCopyFirst { channel: InstallChannel::Homebrew, .. })));
}

#[test]
fn a_stale_cached_path_on_a_healthy_disk_is_just_read_again() {
    let h = claude(&healthy_claude(), &mac(PATH, Some("/Users/u/.claude/local/claude")));
    assert!(!h.healthy);
    let mut c = ctx();
    c.sessions = vec![tile("t1")];
    let plan = plan(&h, &c);
    assert!(has_situation(&plan, |s| matches!(s, Situation::CachedPathStale { .. })));
    // Nothing is written: open tiles may stay.
    assert_eq!(kinds(&plan), [StepKind::Reread, StepKind::Verify]);
    assert_eq!(plan.next_step.as_deref(), Some(plan.steps[0].id.as_str()));
}

#[test]
fn a_broken_npm_copy_first_on_path_is_passed_over_and_can_go_with_the_tick() {
    // B2: the snapshot already passed over the broken npm copy (shell_env),
    // so the tiles run the native one; only a Terminal still starts npm's.
    let fake = healthy_claude()
        .link(NPM_BIN, NPM_REAL, "2.1.300 (Claude Code)")
        .runs(NPM_BIN, exited(Some(1), None, ""));
    let inputs = mac("/opt/homebrew/bin:/Users/u/.local/bin:/usr/bin", Some(LAUNCHER));
    let h = claude(&fake, &inputs);
    assert!(h.cached.as_ref().unwrap().matches_now, "the look's rule is the snapshot's: {h:#?}");
    let without = plan(&h, &ctx());
    assert_eq!(without.block, Some(Block::NothingToRepair { healthy_enough: true }));
    assert!(has_note(&without, |n| matches!(n, Note::TerminalRunsOther { terminal, plyloft, failure: Some(StartFailure::Exited) }
        if terminal == NPM_BIN && plyloft == LAUNCHER)));
    assert!(has_note(&without, |n| matches!(n, Note::NpmCopyCanBeRemoved { prefix, .. } if prefix == "/opt/homebrew")));
    assert!(without.manual.iter().any(|m| m.purpose == ManualPurpose::PathOrder && m.command == PATH_LINE));

    let mut c = ctx();
    c.remove_npm_copy = true;
    let with = plan(&h, &c);
    assert_eq!(kinds(&with), [StepKind::RemoveNpmCopy, StepKind::Reread, StepKind::Verify]);
    let removal = step_of(&with, StepKind::RemoveNpmCopy);
    assert!(removal.optional);
    assert_eq!(
        removal.action,
        StepAction::RemoveNpmCopy { prefix: "/opt/homebrew".into(), package: "@anthropic-ai/claude-code".into() }
    );
    assert_eq!(
        removal.command.as_deref(),
        Some("/opt/homebrew/bin/npm uninstall -g --prefix /opt/homebrew @anthropic-ai/claude-code")
    );
    assert_eq!(with.next_step.as_deref(), Some(removal.id.as_str()));
    // Removed: no Terminal note about it.
    assert!(!has_note(&with, |n| matches!(n, Note::TerminalRunsOther { .. })));
}

#[test]
fn the_npm_of_the_copy_being_removed_is_used() {
    let other = "/Users/u/.npm-global/bin/claude";
    let other_real = "/Users/u/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js";
    let fake = healthy_claude().link(other, other_real, "2.1.300 (Claude Code)");
    let mut inputs = mac(&format!("{PATH}:/Users/u/.npm-global/bin"), Some(LAUNCHER));
    inputs.npm_prefix = Some("/Users/u/.npm-global".into());
    let mut c = ctx();
    c.remove_npm_copy = true;
    c.npms.push(("/Users/u/.npm-global".into(), "/Users/u/.npm-global/bin/npm".into()));
    let plan = plan(&claude(&fake, &inputs), &c);
    assert_eq!(
        step_of(&plan, StepKind::RemoveNpmCopy).command.as_deref(),
        Some("/Users/u/.npm-global/bin/npm uninstall -g --prefix /Users/u/.npm-global @anthropic-ai/claude-code")
    );
}

#[test]
fn several_working_copies_are_left_unless_the_npm_one_is_ticked() {
    let fake = healthy_claude().link(NPM_BIN, NPM_REAL, "2.1.300 (Claude Code)");
    let h = claude(&fake, &mac(PATH, Some(LAUNCHER)));
    let without = plan(&h, &ctx());
    assert_eq!(without.block, Some(Block::NothingToRepair { healthy_enough: true }));
    assert!(matches!(without.situations[0], Situation::HealthyEnough { .. }));
    assert!(has_situation(&without, |s| matches!(s, Situation::SeveralCopies { .. })));
    assert!(has_note(&without, |n| matches!(n, Note::NpmCopyCanBeRemoved { .. })));
    assert!(without.steps.is_empty());

    let mut c = ctx();
    c.remove_npm_copy = true;
    let with = plan(&h, &c);
    assert_eq!(kinds(&with), [StepKind::RemoveNpmCopy, StepKind::Reread, StepKind::Verify]);
}

#[test]
fn an_npm_copy_in_a_folder_of_root_stays_and_is_named() {
    // Writable only with sudo: D3 leaves it, even ticked.
    let fake = healthy_claude()
        .link(NPM_BIN, NPM_REAL, "2.1.300 (Claude Code)")
        .folder("/opt/homebrew/lib/node_modules/@anthropic-ai", Some(false), false);
    let mut c = ctx();
    c.remove_npm_copy = true;
    let plan = plan(&claude(&fake, &mac(PATH, Some(LAUNCHER))), &c);
    assert!(has_note(&plan, |n| matches!(n, Note::NpmCopyStays { reason: NpmStay::NeedsAdmin, .. })));
    assert!(!kinds(&plan).contains(&StepKind::RemoveNpmCopy));
}

#[test]
fn the_macbook_incident_ends_with_plyloft_running_the_native_copy() {
    // An old `sudo npm i -g` copy first on PATH, under a prefix of root, that
    // no longer starts after a failed update; no native copy yet.
    let bin = "/usr/local/bin/claude";
    let real = "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js";
    let root_prefix = |fake: Fake| {
        fake.folder("/usr/local/lib/node_modules/@anthropic-ai", Some(false), false)
            .folder("/usr/local/bin", Some(false), false)
    };
    let path = "/usr/local/bin:/usr/bin:/bin:/Users/u/.local/bin";
    let mut inputs = mac(path, Some(bin));
    inputs.npm_prefix = Some("/usr/local".into());
    let before = root_prefix(Fake::default().link(bin, real, "2.1.300").runs(bin, exited(Some(1), None, "")));
    let plan = plan(&claude(&before, &inputs), &ctx());
    assert_eq!(kinds(&plan), [StepKind::RunInstaller, StepKind::Reread, StepKind::Verify]);
    assert!(has_note(&plan, |n| matches!(n, Note::NpmCopyStays { reason: NpmStay::NeedsAdmin, .. })));
    assert!(plan.manual.iter().all(|m| !m.command.contains("sudo")));

    // After the install and the re-read: the snapshot passed over the broken
    // npm copy (B2), so Plyloft runs the native one.
    let after = root_prefix(healthy_claude().link(bin, real, "2.1.300").runs(bin, exited(Some(1), None, "")));
    let mut inputs = mac(path, Some(LAUNCHER));
    inputs.npm_prefix = Some("/usr/local".into());
    let h = claude(&after, &inputs);
    assert_eq!(h.runs_today.as_deref(), Some(LAUNCHER));
    let mut c = ctx();
    c.attempted = vec![StepKind::RunInstaller];
    let done = super::plan(&h, &c);
    assert_eq!(done.block, Some(Block::NothingToRepair { healthy_enough: true }), "{done:#?}");
    assert!(matches!(done.situations[0], Situation::HealthyEnough { runs: Some(ref r) } if r == LAUNCHER));
    assert!(has_note(&done, |n| matches!(n, Note::TerminalRunsOther { terminal, plyloft, .. } if terminal == bin && plyloft == LAUNCHER)));
    assert!(done.manual.iter().any(|m| m.purpose == ManualPurpose::PathOrder));
}

#[test]
fn a_working_copy_that_cant_update_itself_ends_with_the_path_order() {
    // The npm copy of root still starts: the snapshot keeps it (first, and it
    // starts). After the native install only the PATH order is left.
    let bin = "/usr/local/bin/claude";
    let real = "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js";
    let fake = healthy_claude()
        .link(bin, real, "2.1.300 (Claude Code)")
        .folder("/usr/local/lib/node_modules/@anthropic-ai", Some(false), false)
        .folder("/usr/local/bin", Some(false), false);
    let mut inputs = mac("/usr/local/bin:/usr/bin:/Users/u/.local/bin", Some(bin));
    inputs.npm_prefix = Some("/usr/local".into());
    let plan = plan(&claude(&fake, &inputs), &ctx());
    assert!(has_situation(&plan, |s| matches!(s, Situation::CannotUpdate { channel: InstallChannel::Npm, .. })));
    assert_eq!(plan.block, Some(Block::CouldNotRepair { reason: GiveUp::PathOrder, step: None, evidence: None }));
    assert!(has_note(&plan, |n| matches!(n, Note::UpdatesGoToNative { runs, native } if runs == bin && native == LAUNCHER)));
    // R0 C8: its own updater may still touch the native launcher.
    assert!(has_note(&plan, |n| matches!(n, Note::NpmUpdaterMayTouchNative { npm, native } if npm == bin && native == LAUNCHER)));
    assert!(plan.manual.iter().any(|m| m.purpose == ManualPurpose::PathOrder));
}

#[test]
fn nothing_that_writes_comes_before_the_sessions_close() {
    let h = claude(&Fake::default(), &mac(PATH, None));
    let mut c = ctx();
    c.sessions = vec![
        tile("pty-1"),
        SessionInUse {
            source: SessionSource::AgentRun,
            id: "s2".into(),
            label: Some("builder".into()),
            pty_id: Some("pty-9".into()),
        },
    ];
    let plan = plan(&h, &c);
    assert_eq!(kinds(&plan)[0], StepKind::CloseSessions);
    let close = &plan.steps[0];
    assert_eq!((close.by, close.needs), (StepBy::You, Some(Need::CloseSessions)));
    assert!(matches!(&close.action, StepAction::CloseSessions { sessions } if sessions.len() == 2));
    assert_eq!(plan.next_step, None);
}

#[test]
fn offline_blocks_a_plan_that_installs() {
    let h = claude(&Fake::default(), &mac(PATH, None));
    let mut c = ctx();
    c.reach = Some(Reach { reachable: false, proxy: true, details: Some("curl: (5)".into()) });
    let plan = plan(&h, &c);
    assert_eq!(plan.block, Some(Block::Offline { proxy: true, details: Some("curl: (5)".into()) }));
    assert_eq!(plan.next_step, None);
    // Not checked is no block.
    c.reach = None;
    assert!(super::plan(&h, &c).block.is_none());
}

#[test]
fn a_full_disk_blocks_a_plan_that_installs() {
    let h = claude(&Fake::default(), &mac(PATH, None));
    let mut c = ctx();
    c.free_bytes = Some(100 * 1024 * 1024);
    let plan = plan(&h, &c);
    assert_eq!(plan.block, Some(Block::DiskFull { free_bytes: 100 * 1024 * 1024, needed_bytes: NEEDED_FREE_BYTES }));
    // Unknown space is no block.
    c.free_bytes = None;
    assert!(super::plan(&h, &c).block.is_none());
}

fn windows_inputs(path: &str, cached: Option<&str>) -> Inputs {
    Inputs {
        path: path.into(),
        windows: true,
        home: Some(r"C:\Users\u".into()),
        local_app_data: Some(r"C:\Users\u\AppData\Local".into()),
        app_data: Some(r"C:\Users\u\AppData\Roaming".into()),
        codex_home: Some(r"C:\Users\u\.codex".into()),
        exts: crate::cli_health::pathext(None),
        cached: cached.map_or(Cached::Absent, |p| Cached::Path(p.into())),
        version_bounds: Some((Duration::from_millis(10), Duration::from_millis(10))),
        ..Inputs::default()
    }
}

#[test]
fn a_windows_file_in_use_last_time_asks_for_the_codex_sessions_to_close() {
    let exe = r"C:\Users\u\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe";
    let inputs = windows_inputs(r"C:\Users\u\AppData\Local\Programs\OpenAI\Codex\bin;C:\Windows", Some(exe));
    let fake = Fake::default().file(exe, "codex-cli 0.170.0").runs(exe, exited(Some(1), None, ""));
    let h = inspect(CliTool::Codex, &inputs, &fake);
    let mut c = RepairContext { windows: true, home: Some(r"C:\Users\u".into()), user: None, ..ctx() };
    c.last_run = Some(LastRun {
        action_id: "update.codex".into(),
        outcome: Some("failed".into()),
        cause: Some("file-in-use".into()),
        cause_path: Some(exe.into()),
        ..LastRun::default()
    });
    let alone = plan(&h, &c);
    assert!(has_situation(&alone, |s| matches!(s, Situation::FileInUseLastTime { path: Some(p) } if p == exe)));
    assert_eq!(kinds(&alone), [StepKind::RunInstaller, StepKind::Reread, StepKind::Verify]);
    assert_eq!(
        step_of(&alone, StepKind::RunInstaller).command.as_deref(),
        Some("irm https://chatgpt.com/codex/install.ps1 | iex")
    );
    c.sessions = vec![SessionInUse {
        source: SessionSource::CodexAppServer,
        id: "chat:w:c".into(),
        label: None,
        pty_id: None,
    }];
    let busy = plan(&h, &c);
    assert_eq!(kinds(&busy)[0], StepKind::CloseSessions);
    assert_eq!(busy.next_step, None);
}

#[test]
fn windows_folders_that_cant_be_written_are_work_by_hand() {
    let fake = Fake::default().folder(r"C:\Users\u\AppData\Local\Programs\OpenAI\Codex\bin", None, false);
    let h = inspect(CliTool::Codex, &windows_inputs(r"C:\Windows", None), &fake);
    let c = RepairContext { windows: true, home: Some(r"C:\Users\u".into()), user: None, ..ctx() };
    let plan = plan(&h, &c);
    assert!(!kinds(&plan).iter().any(|k| matches!(k, StepKind::FixOwnership | StepKind::FixPermissions)));
    assert!(has_note(&plan, |n| matches!(n, Note::ByHandOnWindows { .. })));
    assert_eq!(
        plan.block,
        Some(Block::CouldNotRepair { reason: GiveUp::OnlyByHand, step: Some(StepKind::RunInstaller), evidence: None })
    );
}

#[test]
fn a_missing_folder_under_a_parent_of_root_is_only_by_hand() {
    let fake = Fake::default().missing_folder("/Users/u/.local/share/claude", "/Users/u/.local/share", Some(false), false);
    let h = claude(&fake, &mac(PATH, None));
    let plan = plan(&h, &ctx());
    assert!(has_note(&plan, |n| matches!(n, Note::ParentNotYours { path } if path == "/Users/u/.local/share")));
    assert!(plan.manual.iter().any(|m| m.command == "sudo chown -h -- u /Users/u/.local/share"));
    assert!(matches!(plan.block, Some(Block::CouldNotRepair { reason: GiveUp::OnlyByHand, .. })));
    assert!(!kinds(&plan).contains(&StepKind::FixOwnership));
}

#[test]
fn a_step_tried_already_and_still_needed_stops_the_repair_with_its_evidence() {
    let h = claude(&Fake::default(), &mac(PATH, None));
    let mut c = ctx();
    c.attempted = vec![StepKind::RunInstaller];
    c.last_run = Some(LastRun {
        action_id: "repair-install.claude".into(),
        outcome: Some("failed".into()),
        cause: Some("permissions".into()),
        cause_path: Some("/Users/u/.local/share/claude/versions".into()),
        exit_code: Some(1),
        ..LastRun::default()
    });
    let plan = plan(&h, &c);
    match &plan.block {
        Some(Block::CouldNotRepair {
            reason: GiveUp::StillThereAfter,
            step: Some(StepKind::RunInstaller),
            evidence: Some(e),
        }) => {
            assert_eq!(e.cause.as_deref(), Some("permissions"));
            assert_eq!(e.cause_path.as_deref(), Some("/Users/u/.local/share/claude/versions"));
        }
        other => panic!("expected the loop guard, got {other:?}"),
    }
    assert_eq!(plan.next_step, None);
    assert!(plan.manual.iter().any(|m| m.purpose == ManualPurpose::Install));

    // A re-read that didn't help ends the same way.
    let stale = claude(&healthy_claude(), &mac(PATH, Some("/gone/claude")));
    let mut c = ctx();
    c.attempted = vec![StepKind::Reread];
    assert!(matches!(
        super::plan(&stale, &c).block,
        Some(Block::CouldNotRepair { reason: GiveUp::StillThereAfter, step: Some(StepKind::Reread), evidence: None })
    ));
}

#[test]
fn a_step_id_is_stable_and_changes_with_what_it_acts_on() {
    let a = claude(&Fake::default().dangling(LAUNCHER, PAYLOAD), &mac(PATH, Some(LAUNCHER)));
    let first = plan(&a, &ctx());
    assert_eq!(first.steps, plan(&a, &ctx()).steps);
    let s1 = step(StepAction::FixOwnership { user: "u".into() }, None, vec!["/Users/u/.claude".into()], false);
    let s2 = step(StepAction::FixOwnership { user: "u".into() }, None, vec!["/Users/u/.codex".into()], false);
    let s3 = step(StepAction::FixOwnership { user: "v".into() }, None, vec!["/Users/u/.claude".into()], false);
    assert_ne!(s1.id, s2.id);
    assert_ne!(s1.id, s3.id);
    assert!(s1.id.starts_with("fix-ownership-"));
}

#[test]
fn an_npm_copy_s_prefix_comes_from_its_place() {
    let h = claude(&healthy_claude().link(NPM_BIN, NPM_REAL, "2.1.300"), &mac(PATH, Some(LAUNCHER)));
    let npm = h.copies.iter().find(|c| c.channel == InstallChannel::Npm).unwrap();
    assert_eq!(npm_prefix(CliTool::Claude, npm, false).as_deref(), Some("/opt/homebrew"));
    // A copy whose package isn't under its prefix's node_modules: unknown.
    let mut odd = npm.clone();
    odd.real_path = Some("/elsewhere/node_modules/@anthropic-ai/claude-code/cli.js".into());
    odd.link_end = odd.real_path.clone();
    assert_eq!(npm_prefix(CliTool::Claude, &odd, false), None);
}

#[test]
fn the_window_s_tiles_are_bounded_and_merged_once() {
    let many: Vec<TileInUse> =
        (0..100).map(|i| TileInUse { pty_id: format!("p{i}"), label: Some("x".repeat(500)) }).collect();
    let sessions = tiles_as_sessions(&many);
    assert_eq!(sessions.len(), MAX_TILES);
    assert!(sessions.iter().all(|s| s.label.as_ref().unwrap().chars().count() == MAX_LABEL_CHARS));
    let backend = vec![
        SessionInUse { source: SessionSource::Tile, id: "rec-1".into(), label: None, pty_id: Some("p1".into()) },
        SessionInUse { source: SessionSource::Swarm, id: "rec-2".into(), label: None, pty_id: Some("q".into()) },
    ];
    let merged = merge_sessions(tiles_as_sessions(&many[..2]), backend);
    assert_eq!(merged.len(), 3, "{merged:#?}");
}

#[test]
fn a_request_with_an_unknown_field_is_refused() {
    let ok: RepairRequest = serde_json::from_str(r#"{"tiles":[{"ptyId":"p"}],"removeNpmCopy":true}"#).unwrap();
    assert!(ok.remove_npm_copy && !ok.start_over);
    assert!(serde_json::from_str::<RepairRequest>(r#"{"paths":["/"]}"#).is_err());
}

#[test]
fn the_plan_s_wire_shape_is_tagged_by_kind() {
    let h = claude(&Fake::default(), &mac(PATH, None));
    let v = serde_json::to_value(plan(&h, &ctx())).unwrap();
    assert_eq!(v["situations"][0]["kind"], "missing");
    assert_eq!(v["steps"][0]["kind"], "runInstaller");
    assert_eq!(v["steps"][0]["channel"], "native");
    assert_eq!(v["steps"][0]["by"], "terminal");
    assert!(v["steps"][0]["id"].as_str().unwrap().starts_with("run-installer-"));
    assert_eq!(v["manual"][0]["purpose"], "install");
    let blocked =
        serde_json::to_value(Block::CouldNotRepair { reason: GiveUp::NeedsChoice, step: None, evidence: None }).unwrap();
    assert_eq!(blocked["kind"], "couldNotRepair");
    assert_eq!(blocked["reason"], "needsChoice");
}

#[test]
fn backend_sessions_are_the_tool_s_active_records_and_codex_extras() {
    use crate::cli_repair_sessions::{codex_extras, from_records};
    use crate::coordination::{ExecutionKind, Provider, SessionRecord, SessionStatus};
    let record = |id: &str, provider: Provider, kind: ExecutionKind, status: SessionStatus| SessionRecord {
        id: id.into(),
        provider,
        execution_kind: kind,
        status,
        ..SessionRecord::default()
    };
    let records = vec![
        record("a", Provider::Claude, ExecutionKind::AgentOneshot, SessionStatus::Running),
        record("b", Provider::Claude, ExecutionKind::SwarmRole, SessionStatus::Completed),
        record("c", Provider::Codex, ExecutionKind::Reviewer, SessionStatus::Running),
        record("d", Provider::Shell, ExecutionKind::ShellTile, SessionStatus::Running),
    ];
    let claude = from_records(&records, CliTool::Claude, |_| true);
    assert_eq!(claude.iter().map(|s| (s.id.as_str(), s.source)).collect::<Vec<_>>(), [("a", SessionSource::AgentRun)]);
    let codex = from_records(&records, CliTool::Codex, |_| true);
    // M5: a record whose PTY or process is gone doesn't hold a Repair back.
    assert!(from_records(&records, CliTool::Claude, |r| r.id != "a").is_empty());
    assert_eq!(codex.iter().map(|s| s.source).collect::<Vec<_>>(), [SessionSource::Review]);
    let extras = codex_extras(&["chat:w:c".into()], true);
    assert_eq!(extras.iter().map(|s| s.source).collect::<Vec<_>>(), [SessionSource::CodexAppServer, SessionSource::CodexUpdate]);
}

#[test]
fn a_repair_s_chown_and_npm_removal_are_judged_by_their_exit_code() {
    use crate::setup_actions::Watch;
    use crate::setup_outcome::VersionChange;
    use crate::setup_run::{decide, Decision, Outcome, Timing, WatchState};
    let state = |exit: Option<Option<i32>>| WatchState {
        elapsed: Duration::from_secs(1),
        exit,
        cancelled: false,
        observed: exit.map(|_| crate::setup_run::Observed::Unknown),
        already_there: false,
        warned_long: false,
        installer_gone: false,
        version: VersionChange::NotCompared,
        idle: Duration::from_secs(1),
        update_claimed: false,
        newer_known: false,
    };
    assert_eq!(decide(Watch::ExitCode, &state(None), &Timing::REAL), Decision::Wait);
    assert_eq!(decide(Watch::ExitCode, &state(Some(Some(0))), &Timing::REAL), Decision::Done(Outcome::Succeeded));
    assert_eq!(decide(Watch::ExitCode, &state(Some(Some(1))), &Timing::REAL), Decision::Done(Outcome::Failed));
    assert_eq!(decide(Watch::ExitCode, &state(Some(None)), &Timing::REAL), Decision::Done(Outcome::Failed));
    // Stop still wins.
    let stopped = WatchState { cancelled: true, ..state(None) };
    assert_eq!(decide(Watch::ExitCode, &stopped, &Timing::REAL), Decision::Done(Outcome::Cancelled));
}

#[test]
fn a_copy_that_didnt_answer_in_time_writes_nothing() {
    // M1: a slow first launch of a working npm copy is not a reason to
    // install the native one beside it.
    let fake = Fake::default().link(NPM_BIN, NPM_REAL, "2.1.300").runs(NPM_BIN, RunOutcome::TimedOut);
    let h = claude(&fake, &mac("/opt/homebrew/bin:/usr/bin", Some(NPM_BIN)));
    let plan = plan(&h, &ctx());
    assert_eq!(plan.block, Some(Block::NotSureYet { paths: vec![NPM_BIN.into()] }));
    assert!(plan.steps.is_empty() && plan.next_step.is_none());
}

#[test]
fn a_claude_that_ran_and_printed_no_version_keeps_its_file() {
    // M2: `Exited` (no version read) may be an intact binary.
    let h = claude(&healthy_claude().runs(LAUNCHER, exited(Some(1), None, "")), &mac(PATH, Some(LAUNCHER)));
    let plan = plan(&h, &ctx());
    assert!(!kinds(&plan).contains(&StepKind::RemoveBrokenPayload), "{plan:#?}");
    assert!(kinds(&plan).contains(&StepKind::RunInstaller));
    // Review 2: a transient spawn error, or a signal other than SIGKILL
    // (memory pressure, a crash), is not sure: nothing is written.
    for outcome in [
        RunOutcome::SpawnFailed("Text file busy (os error 26)".into()),
        RunOutcome::SpawnFailed("Cannot allocate memory (os error 12)".into()),
        exited(None, Some(15), ""),
        exited(None, Some(11), ""),
    ] {
        let h = claude(&healthy_claude().runs(LAUNCHER, outcome), &mac(PATH, Some(LAUNCHER)));
        let plan = super::plan(&h, &ctx());
        assert!(matches!(plan.block, Some(Block::NotSureYet { .. })), "{plan:#?}");
        assert!(plan.steps.is_empty());
    }
}

#[test]
fn a_version_file_the_removal_didnt_confirm_stops_at_not_sure_yet() {
    let h = claude(&healthy_claude().runs(LAUNCHER, exited(None, Some(9), "")), &mac(PATH, Some(LAUNCHER)));
    let mut c = ctx();
    c.unconfirmed = vec![PAYLOAD.into()];
    let plan = plan(&h, &c);
    assert_eq!(plan.block, Some(Block::NotSureYet { paths: vec![PAYLOAD.into()] }));
    assert!(plan.steps.is_empty());
}

#[test]
fn two_sudo_steps_say_the_password_is_asked_twice() {
    let fake = Fake::default()
        .dangling(LAUNCHER, PAYLOAD)
        .folder("/Users/u/.local/bin", Some(false), false)
        .folder("/Users/u/.claude", Some(false), false);
    let first = plan(&claude(&fake, &mac(PATH, Some(LAUNCHER))), &ctx());
    assert!(!step_of(&first, StepKind::FixOwnership).password_again);
    assert!(step_of(&first, StepKind::FixSharedOwnership).password_again);
    let only_shared = Fake::default().dangling(LAUNCHER, PAYLOAD).folder("/Users/u/.local/bin", Some(false), false);
    let plan = super::plan(&claude(&only_shared, &mac(PATH, Some(LAUNCHER))), &ctx());
    assert!(!step_of(&plan, StepKind::FixSharedOwnership).password_again);
}

#[test]
fn a_version_file_that_cant_be_run_gets_its_bits_not_a_deletion() {
    let mut fake = healthy_claude();
    if let Some(Look::Found(look)) = fake.files.get_mut(LAUNCHER) {
        look.executable = false;
    }
    let h = claude(&fake, &mac(PATH, Some(LAUNCHER)));
    let plan = plan(&h, &ctx());
    assert!(!kinds(&plan).contains(&StepKind::RemoveBrokenPayload));
    assert_eq!(step_of(&plan, StepKind::FixPermissions).paths, [PAYLOAD]);
    assert!(has_note(&plan, |n| matches!(n, Note::PayloadNotExecutable { path } if path == PAYLOAD)));
}

#[test]
fn the_install_folder_is_handed_back_without_r_with_the_tool_s_launcher() {
    // B1: `~/.local/bin` holds other programs: never `chown -R` there.
    let fake = Fake::default()
        .dangling(LAUNCHER, PAYLOAD)
        .folder("/Users/u/.local/bin", Some(false), false)
        .folder("/Users/u/.claude", Some(false), false);
    let h = claude(&fake, &mac(PATH, Some(LAUNCHER)));
    let plan = plan(&h, &ctx());
    let own = step_of(&plan, StepKind::FixOwnership);
    assert_eq!(own.paths, ["/Users/u/.claude"]);
    let shared = step_of(&plan, StepKind::FixSharedOwnership);
    assert_eq!(shared.paths, ["/Users/u/.local/bin", LAUNCHER]);
    assert_eq!(shared.command.as_deref(), Some("sudo chown -h -- u /Users/u/.local/bin /Users/u/.local/bin/claude"));
    assert_eq!(shared.needs, Some(Need::Password));
    assert!(plan.steps.iter().all(|s| !(s.kind() == StepKind::FixOwnership && s.paths.iter().any(|p| p.ends_with(".local/bin")))));
}

#[test]
fn a_broad_config_folder_is_only_by_hand() {
    // B1: `$CLAUDE_CONFIG_DIR` set to a general folder (or the home): never
    // `chown -R` it.
    let fake = Fake::default().folder("/Users/u/Documents", Some(false), false);
    let mut inputs = mac(PATH, None);
    inputs.claude_config_dir = Some("/Users/u/Documents".into());
    let plan = plan(&claude(&fake, &inputs), &ctx());
    assert!(has_note(&plan, |n| matches!(n, Note::FolderByHand { path } if path == "/Users/u/Documents")));
    assert!(!plan.steps.iter().any(|s| s.paths.iter().any(|p| p == "/Users/u/Documents")));
    let home = Fake::default().folder("/Users/u", Some(false), false);
    let mut inputs = mac(PATH, None);
    inputs.claude_config_dir = Some("/Users/u".into());
    let plan = super::plan(&claude(&home, &inputs), &ctx());
    assert!(!plan.steps.iter().any(|s| s.paths.iter().any(|p| p == "/Users/u")));
    // Review 2: a relocated config home, even named for the tool, is by
    // hand; only the default `~/.claude` takes `chown -R`.
    let named = Fake::default().folder("/Users/u/conf/claude", Some(false), false);
    let mut inputs = mac(PATH, None);
    inputs.claude_config_dir = Some("/Users/u/conf/claude".into());
    let plan = super::plan(&claude(&named, &inputs), &ctx());
    assert!(has_note(&plan, |n| matches!(n, Note::FolderByHand { path } if path == "/Users/u/conf/claude")));
    assert!(!plan.steps.iter().any(|s| s.paths.iter().any(|p| p == "/Users/u/conf/claude")));
    let default = Fake::default().folder("/Users/u/.claude", Some(false), false);
    let plan = super::plan(&claude(&default, &mac(PATH, None)), &ctx());
    assert!(step_of(&plan, StepKind::FixOwnership).paths.contains(&"/Users/u/.claude".to_string()));
}

#[test]
fn root_is_never_given_the_folders() {
    let fake = Fake::default().folder("/Users/u/.claude", Some(false), false);
    let mut c = ctx();
    c.user = Some("root".into());
    let plan = plan(&claude(&fake, &mac(PATH, None)), &c);
    assert!(!kinds(&plan).iter().any(|k| matches!(k, StepKind::FixOwnership | StepKind::FixSharedOwnership)));
}

#[test]
fn sudo_s_refusals_say_why_not_still_there() {
    let fake = Fake::default().folder("/Users/u/.claude", Some(false), false);
    let h = claude(&fake, &mac(PATH, None));
    for (cause, reason) in [("not-admin", GiveUp::NeedsAdmin), ("password-refused", GiveUp::PasswordRefused), ("unknown", GiveUp::StillThereAfter)] {
        let mut c = ctx();
        c.attempted = vec![StepKind::FixOwnership];
        c.last_run = Some(LastRun { action_id: "repair-chown.claude".into(), cause: Some(cause.into()), ..LastRun::default() });
        match plan(&h, &c).block {
            Some(Block::CouldNotRepair { reason: got, step: Some(StepKind::FixOwnership), .. }) => assert_eq!(got, reason, "{cause}"),
            other => panic!("{cause}: {other:?}"),
        }
    }
}

// ---------------------------------------------------------------- R4b

#[test]
fn reinstall_anyway_adds_the_installer_on_a_healthy_machine_once() {
    let h = claude(&healthy_claude(), &mac(PATH, Some(LAUNCHER)));
    assert!(h.healthy);
    let mut c = ctx();
    c.reinstall = true;
    let p = plan(&h, &c);
    assert_eq!(kinds(&p), [StepKind::RunInstaller, StepKind::Reread, StepKind::Verify]);
    assert!(p.block.is_none() && p.next_step.is_some());
    assert_eq!(p.situations[0], Situation::Healthy);
    // The same command, the same id as an ordinary install.
    let missing = plan(&claude(&Fake::default(), &mac(PATH, None)), &ctx());
    assert_eq!(step_of(&p, StepKind::RunInstaller).id, step_of(&missing, StepKind::RunInstaller).id);
    // Once run, the flag adds nothing: the ordinary plan ends the repair.
    c.attempted = vec![StepKind::RunInstaller];
    assert_eq!(super::plan(&h, &c).block, Some(Block::NothingToRepair { healthy_enough: false }));
}

#[test]
fn reinstall_anyway_beside_a_working_npm_copy_removes_nothing() {
    let fake = healthy_claude().link(NPM_BIN, NPM_REAL, "2.1.300 (Claude Code)");
    let h = claude(&fake, &mac("/opt/homebrew/bin:/Users/u/.local/bin:/usr/bin", Some(NPM_BIN)));
    assert_eq!(plan(&h, &ctx()).block, Some(Block::NothingToRepair { healthy_enough: true }));
    let mut c = ctx();
    c.reinstall = true;
    let p = plan(&h, &c);
    assert_eq!(kinds(&p), [StepKind::RunInstaller, StepKind::Reread, StepKind::Verify]);
    assert!(!kinds(&p).iter().any(|k| matches!(k, StepKind::RemoveNpmCopy | StepKind::RemoveBrokenPayload | StepKind::RemoveDanglingLauncher)));
}

#[test]
fn reinstall_anyway_keeps_every_block() {
    let h = claude(&healthy_claude(), &mac(PATH, Some(LAUNCHER)));
    let mut c = ctx();
    c.reinstall = true;
    c.reach = Some(Reach { reachable: false, proxy: false, details: None });
    assert!(matches!(plan(&h, &c).block, Some(Block::Offline { .. })));
    c.reach = Some(Reach::ok());
    c.free_bytes = Some(10);
    assert!(matches!(plan(&h, &c).block, Some(Block::DiskFull { .. })));
    c.free_bytes = None;
    c.sessions = vec![tile("p1")];
    let p = plan(&h, &c);
    assert_eq!(kinds(&p)[0], StepKind::CloseSessions);
    assert_eq!(p.next_step, None);
    // Folders the installer needs come first.
    let fake = healthy_claude().folder("/Users/u/.local/share/claude/versions", Some(true), false);
    let mut c = ctx();
    c.reinstall = true;
    let p = plan(&claude(&fake, &mac(PATH, Some(LAUNCHER))), &c);
    assert_eq!(kinds(&p)[..2], [StepKind::FixPermissions, StepKind::RunInstaller]);
}

#[test]
fn reinstall_anyway_goes_past_its_own_slow_copy_only() {
    // The copy being reinstalled didn't answer in time: that is what the
    // person wants replaced.
    let slow_native = Fake::default().link(LAUNCHER, PAYLOAD, "x").runs(LAUNCHER, RunOutcome::TimedOut);
    let h = claude(&slow_native, &mac(PATH, Some(LAUNCHER)));
    let mut c = ctx();
    assert!(matches!(plan(&h, &c).block, Some(Block::NotSureYet { .. })));
    c.reinstall = true;
    assert!(kinds(&plan(&h, &c)).contains(&StepKind::RunInstaller));
    // Another channel's slow copy still makes it wait.
    let slow_npm = Fake::default().link(NPM_BIN, NPM_REAL, "x").runs(NPM_BIN, RunOutcome::TimedOut);
    let h = claude(&slow_npm, &mac("/opt/homebrew/bin:/usr/bin", Some(NPM_BIN)));
    assert!(matches!(plan(&h, &c).block, Some(Block::NotSureYet { .. })));
}

#[test]
fn an_install_planned_without_the_reach_check_has_no_network_claim() {
    // A quick read never checks the host: no Offline block, and (once
    // marked quick by `cli_repair_run::as_quick`) nothing to run.
    let mut c = ctx();
    c.reach = None;
    let p = plan(&claude(&Fake::default(), &mac(PATH, None)), &c);
    assert!(p.installs() && p.block.is_none() && !p.quick);
}

#[test]
fn a_quick_look_asks_version_once_and_a_slow_copy_stays_cant_tell() {
    let fake = Fake::default().link(LAUNCHER, PAYLOAD, "x").runs(LAUNCHER, RunOutcome::TimedOut);
    let mut inputs = mac(PATH, Some(LAUNCHER));
    inputs.no_retry = true;
    let h = claude(&fake, &inputs);
    let start = h.copies[0].start.as_ref().unwrap();
    assert!(start.inconclusive && !start.starts);
}

// ---------------------------------------------------------------- R9

/// R9 (found by the sandbox run): a home reached through a link
/// (`/Users/u` → `/Volumes/Disk/u`). The canonical real path names the
/// volume; the payload, the npm prefix and "not a system folder" are read
/// from the home as spelled.
#[test]
fn a_home_reached_through_a_link_still_finds_the_payload_and_the_npm_prefix() {
    let vol_payload = "/Volumes/Disk/u/.local/share/claude/versions/2.1.330";
    let mut fake = Fake::default().runs(LAUNCHER, exited(None, Some(9), ""));
    fake.files.insert(
        LAUNCHER.into(),
        Look::Found(FileLook { link_target: Some(PAYLOAD.into()), chain_end: Some(PAYLOAD.into()), ..mine(vol_payload) }),
    );
    let npm_bin = "/Users/u/.npm-global/bin/claude";
    let npm_text = "/Users/u/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe";
    let npm_vol = "/Volumes/Disk/u/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe";
    fake.files.insert(
        npm_bin.into(),
        Look::Found(FileLook { link_target: Some("../lib/x".into()), chain_end: Some(npm_text.into()), ..mine(npm_vol) }),
    );
    fake.runs.insert(npm_bin.into(), exited(Some(0), None, "2.1.300\n"));
    let mut inputs = mac(&format!("{PATH}:/Users/u/.npm-global/bin"), Some(LAUNCHER));
    inputs.npm_prefix = Some("/Users/u/.npm-global".into());
    let h = claude(&fake, &inputs);
    assert!(h.copies.iter().all(|c| !c.system_folder), "{h:#?}");
    let npm = h.copies.iter().find(|c| c.path == npm_bin).unwrap();
    assert_eq!(npm_prefix(CliTool::Claude, npm, false).as_deref(), Some("/Users/u/.npm-global"));
    let mut c = ctx();
    c.npms = vec![("/Users/u/.npm-global".into(), "/usr/local/bin/npm".into())];
    let p = plan(&h, &c);
    assert_eq!(step_of(&p, StepKind::RemoveBrokenPayload).paths, [PAYLOAD]);
    assert!(has_note(&p, |n| matches!(n, Note::NpmCopyCanBeRemoved { prefix, .. } if prefix == "/Users/u/.npm-global")), "{p:#?}");
}


/// 1.176.0 seams: a PATH override in Settings puts a broken copy first and a
/// working one later. Tiles run the broken one (an override is never
/// second-guessed), so the look agrees with them — no stale cached path —
/// and the plan ends by hand, naming the override: no reread or install
/// that can't change what tiles run.
#[test]
fn a_path_override_that_runs_a_broken_copy_ends_by_hand_naming_it() {
    let fake = healthy_claude()
        .link(NPM_BIN, NPM_REAL, "2.1.300 (Claude Code)")
        .runs(NPM_BIN, exited(Some(1), None, ""));
    let path = "/opt/homebrew/bin:/Users/u/.local/bin:/usr/bin";
    let inputs = Inputs { path_override: true, ..mac(path, Some(NPM_BIN)) };
    let mut h = claude(&fake, &inputs);
    assert!(h.cached.as_ref().unwrap().matches_now, "under the override the first copy is the one tiles run: {h:#?}");
    h.passed_over =
        Some(crate::shell_env::PassedOver { path: NPM_BIN.into(), instead: LAUNCHER.into(), kept_by_override: true });
    let plan = plan(&h, &ctx());
    assert_eq!(plan.block, Some(Block::CouldNotRepair { reason: GiveUp::PathOverride, step: None, evidence: None }));
    assert!(plan.steps.is_empty(), "nothing to run: {:?}", kinds(&plan));
    assert_eq!(plan.next_step, None);
    assert_eq!(
        plan.situations.first(),
        Some(&Situation::PathOverrideFirst { first: NPM_BIN.into(), working: LAUNCHER.into() })
    );
    assert!(!has_situation(&plan, |s| matches!(s, Situation::CachedPathStale { .. } | Situation::WrongCopyFirst { .. })));

    // Without the override the snapshot's rule passes the broken copy over.
    let free = claude(&fake, &mac(path, Some(LAUNCHER)));
    assert!(free.cached.as_ref().unwrap().matches_now, "{free:#?}");
    // An override that keeps a copy that works is no case for this.
    let mut works = claude(&healthy_claude(), &Inputs { path_override: true, ..mac(PATH, Some(LAUNCHER)) });
    works.passed_over = None;
    assert_ne!(plan_of(&works).block, Some(Block::CouldNotRepair { reason: GiveUp::PathOverride, step: None, evidence: None }));
}

fn plan_of(h: &CliHealth) -> RepairPlan {
    plan(h, &ctx())
}

/// 1.176.0 seams: the look picks the copy tiles run by the snapshot's own
/// rule (`shell_env::choose_copy`): past a certain failure, a later copy
/// that starts, else one that only didn't answer in time — never a stale
/// finding because the two rules differ.
#[test]
fn the_copy_the_look_picks_is_the_snapshots_even_when_the_later_one_is_slow() {
    let fake = Fake::default()
        .link(NPM_BIN, NPM_REAL, "2.1.300 (Claude Code)")
        .runs(NPM_BIN, exited(Some(1), None, ""))
        .link(LAUNCHER, PAYLOAD, "2.1.330 (Claude Code)")
        .runs(LAUNCHER, RunOutcome::TimedOut);
    let path = "/opt/homebrew/bin:/Users/u/.local/bin:/usr/bin";
    let h = claude(&fake, &mac(path, Some(LAUNCHER)));
    assert!(h.cached.as_ref().unwrap().matches_now, "the slow later copy is the one kept: {h:#?}");
    assert!(!has_situation(&plan_of(&h), |s| matches!(s, Situation::CachedPathStale { .. })));
}

/// 1.176.1: the owner's MacBook, as its report read: Program folders held
/// `~/.local/bin/claude`, so nothing is on the list; Claude itself starts in
/// `~/.local/bin`, off that list, and the snapshot found nothing.
fn owners_macbook() -> CliHealth {
    let inputs = Inputs { path_override: true, ..mac("~/.local/bin/claude", None) };
    claude(&healthy_claude(), &inputs)
}

#[test]
fn the_owners_macbook_reads_as_its_report_said() {
    let h = owners_macbook();
    assert_eq!(h.copies.len(), 1);
    assert_eq!(h.copies[0].path_rank, None, "off the list");
    assert!(h.findings.contains(&Finding::FirstOnPathIsNotTheWorkingOne {
        first: None,
        working: LAUNCHER.into(),
        working_on_path: false
    }));
    assert!(h.findings.contains(&Finding::NativeDirNotOnPath { dir: "/Users/u/.local/bin".into() }));
}

fn pf(value: &str, problems: Vec<crate::program_folders::Problem>, shell: Option<&str>) -> Option<ProgramFoldersCtx> {
    Some(ProgramFoldersCtx { value: value.into(), problems, shell_path: shell.map(str::to_string), missing: Vec::new() })
}

const SHELL_PATH: &str = "/opt/homebrew/bin:/usr/bin:/bin:/Users/u/.local/bin";

/// The setting is written so it can't work, and the working copy's folder is
/// already in what the shell reports: one optional step empties the setting.
/// Nothing is installed, "Reinstall anyway" or not.
#[test]
fn a_malformed_setting_whose_folder_the_shell_reports_is_emptied_in_one_step() {
    use crate::program_folders::Problem;
    let h = owners_macbook();
    for reinstall in [false, true] {
        let c = RepairContext {
            program_folders: pf("~/.local/bin/claude", vec![Problem::NamesAFile, Problem::Tilde], Some(SHELL_PATH)),
            reinstall,
            ..ctx()
        };
        let plan = plan(&h, &c);
        assert_eq!(kinds(&plan), vec![StepKind::EmptyProgramFolders, StepKind::Verify]);
        let empty = step_of(&plan, StepKind::EmptyProgramFolders);
        assert_eq!(empty.action, StepAction::EmptyProgramFolders { was: "~/.local/bin/claude".into() });
        assert!(empty.optional && empty.writes && empty.by == StepBy::Plyloft);
        assert_eq!(plan.next_step.as_deref(), Some(empty.id.as_str()));
        assert!(!plan.installs());
        assert_eq!(
            plan.situations,
            vec![Situation::OutsideProgramFolders {
                copy: LAUNCHER.into(),
                folder: "/Users/u/.local/bin".into(),
                problems: vec![Problem::NamesAFile, Problem::Tilde],
            }]
        );
        assert!(!has_note(&plan, |n| matches!(n, Note::InstallDirNotOnPath { .. })));
    }
    // The step binds the value it saw: another value is another step.
    let other = plan(&h, &RepairContext { program_folders: pf("~/x", vec![Problem::Tilde], Some(SHELL_PATH)), ..ctx() });
    assert_ne!(other.next_step, plan(&h, &RepairContext { program_folders: pf("~/.local/bin/claude", vec![Problem::Tilde], Some(SHELL_PATH)), ..ctx() }).next_step);
}

/// Emptying wouldn't make the tool found (its folder isn't what the shell
/// reports): the person corrects the setting; still no install.
#[test]
fn a_malformed_setting_the_shell_wouldnt_fix_ends_by_hand() {
    use crate::program_folders::Problem;
    let h = owners_macbook();
    let plan = plan(&h, &RepairContext { program_folders: pf("~/.local/bin/claude", vec![Problem::NamesAFile], Some("/usr/bin:/bin")), ..ctx() });
    assert_eq!(plan.block, Some(Block::CouldNotRepair { reason: GiveUp::ProgramFolders, step: None, evidence: None }));
    assert!(plan.steps.is_empty() && !plan.installs());
}

/// Review 1: with the setting malformed, the setting goes first whatever the
/// copies — never an install that tiles still couldn't see.
#[test]
fn a_malformed_setting_comes_before_any_install() {
    use crate::program_folders::Problem;
    let c = RepairContext { program_folders: pf("$PATH:/x", vec![Problem::Variable], Some(SHELL_PATH)), ..ctx() };
    // Missing everywhere.
    let missing = inspect(CliTool::Claude, &Inputs { path_override: true, ..mac("$PATH:/x", None) }, &Fake::default());
    let p = plan(&missing, &c);
    assert!(!p.installs(), "{:?}", kinds(&p));
    assert_eq!(p.block, Some(Block::CouldNotRepair { reason: GiveUp::ProgramFolders, step: None, evidence: None }));
    assert_eq!(p.situations[0], Situation::ProgramFoldersMalformed { problems: vec![Problem::Variable] });
    // The copy outside the list is broken.
    let broken = healthy_claude().runs(LAUNCHER, exited(Some(1), None, ""));
    let h = inspect(CliTool::Claude, &Inputs { path_override: true, ..mac("$PATH:/x", None) }, &broken);
    let p = plan(&h, &c);
    assert!(!p.installs(), "{:?}", kinds(&p));
    assert!(matches!(p.block, Some(Block::CouldNotRepair { reason: GiveUp::ProgramFolders, .. })));
    // Once well-formed, the ordinary plan may install.
    let ok = plan(&missing, &RepairContext { program_folders: pf("/x", Vec::new(), Some(SHELL_PATH)), ..ctx() });
    assert!(ok.installs(), "{:?}", kinds(&ok));
}

/// A well-formed list that only leaves the tool's folder out: one step adds
/// the folder at the end; no install, no sessions to close.
#[test]
fn a_tool_outside_a_good_program_folders_list_is_added_to_it() {
    let inputs = Inputs { path_override: true, ..mac("/opt/tools/bin:/usr/bin:/bin", None) };
    let h = claude(&healthy_claude(), &inputs);
    let c = RepairContext { program_folders: pf("/opt/tools/bin:/usr/bin:/bin", Vec::new(), None), sessions: vec![tile("p1")], ..ctx() };
    let plan = plan(&h, &c);
    assert_eq!(kinds(&plan), vec![StepKind::AddProgramFolder, StepKind::Verify]);
    let add = step_of(&plan, StepKind::AddProgramFolder);
    assert_eq!(
        add.action,
        StepAction::AddProgramFolder { folder: "/Users/u/.local/bin".into(), front: false, was: "/opt/tools/bin:/usr/bin:/bin".into() }
    );
    assert!(add.optional && add.writes && add.by == StepBy::Plyloft);
    assert_eq!(plan.next_step.as_deref(), Some(add.id.as_str()));
    assert_eq!(plan.block, None);
    // Tried once and still the case: the plan stops instead of looping.
    let again = super::plan(&h, &RepairContext { attempted: vec![StepKind::AddProgramFolder], ..c });
    assert!(matches!(again.block, Some(Block::CouldNotRepair { reason: GiveUp::StillThereAfter, .. })));
    // Without the setting, the ordinary plan.
    let free = super::plan(&h, &ctx());
    assert!(!has_situation(&free, |s| matches!(s, Situation::OutsideProgramFolders { .. })));
}

/// A broken copy earlier in the list would still win at the end: in front.
#[test]
fn the_folder_goes_in_front_only_ahead_of_a_broken_copy_on_the_list() {
    let fake = healthy_claude().link(NPM_BIN, NPM_REAL, "2.1.300 (Claude Code)").runs(NPM_BIN, exited(Some(1), None, ""));
    let path = "/opt/homebrew/bin:/usr/bin";
    let h = claude(&fake, &Inputs { path_override: true, ..mac(path, Some(NPM_BIN)) });
    let plan = plan(&h, &RepairContext { program_folders: pf(path, Vec::new(), None), ..ctx() });
    let add = step_of(&plan, StepKind::AddProgramFolder);
    assert!(matches!(&add.action, StepAction::AddProgramFolder { front: true, .. }), "{:?}", add.action);
}

#[test]
fn codex_outside_program_folders_is_the_same_case() {
    let fake = Fake::default().link(CODEX, CODEX_REAL, "codex-cli 0.171.0");
    let inputs = Inputs { path_override: true, ..mac("/opt/tools/bin", None) };
    let h = inspect(CliTool::Codex, &inputs, &fake);
    let plan = plan(&h, &RepairContext { program_folders: pf("/opt/tools/bin", Vec::new(), None), ..ctx() });
    assert_eq!(kinds(&plan), vec![StepKind::AddProgramFolder, StepKind::Verify]);
    assert!(matches!(&plan.situations[0], Situation::OutsideProgramFolders { copy, .. } if copy == CODEX));
}


/// 1.176.1 walk (2026-11-22): the saved list `/tmp/ply-walk-nothing-here`
/// — well-formed, finds nothing, no system folders. Claude and Codex work in
/// `~/.local/bin`, which the shell reports: the runnable step empties the
/// setting (which brings git and gh back too), never "add the folder".
#[test]
fn the_walks_list_that_finds_nothing_is_emptied_for_claude_and_codex() {
    const WALK: &str = "/tmp/ply-walk-nothing-here";
    let c = RepairContext {
        program_folders: Some(ProgramFoldersCtx {
            value: WALK.into(),
            problems: Vec::new(),
            shell_path: Some(SHELL_PATH.into()),
            missing: vec!["claude".into(), "codex".into(), "git".into(), "gh".into()],
        }),
        ..ctx()
    };
    let inputs = Inputs { path_override: true, ..mac(WALK, None) };
    let claude_h = claude(&healthy_claude(), &inputs);
    let p = plan(&claude_h, &c);
    assert_eq!(kinds(&p), vec![StepKind::EmptyProgramFolders, StepKind::Verify]);
    assert_eq!(step_of(&p, StepKind::EmptyProgramFolders).action, StepAction::EmptyProgramFolders { was: WALK.into() });
    let codex_h = inspect(CliTool::Codex, &inputs, &Fake::default().link(CODEX, CODEX_REAL, "codex-cli 0.171.0"));
    let p = plan(&codex_h, &c);
    assert_eq!(kinds(&p), vec![StepKind::EmptyProgramFolders, StepKind::Verify]);
    // Not reported by the shell: then the folder is added.
    let elsewhere = RepairContext {
        program_folders: Some(ProgramFoldersCtx { shell_path: Some("/usr/bin:/bin".into()), ..c.program_folders.clone().unwrap() }),
        ..ctx()
    };
    assert_eq!(kinds(&plan(&claude_h, &elsewhere)), vec![StepKind::AddProgramFolder, StepKind::Verify]);
}

/// 1.176.1 walk: once the tool works, a setting that still leaves out git or
/// gh is said, never a silent "repaired".
#[test]
fn a_working_tool_under_a_setting_that_misses_git_says_so() {
    let path = "/Users/u/.local/bin";
    let h = claude(&healthy_claude(), &Inputs { path_override: true, ..mac(path, Some(LAUNCHER)) });
    let c = RepairContext {
        program_folders: Some(ProgramFoldersCtx {
            value: path.into(),
            problems: Vec::new(),
            shell_path: Some(SHELL_PATH.into()),
            missing: vec!["git".into(), "gh".into()],
        }),
        ..ctx()
    };
    let p = plan(&h, &c);
    assert!(matches!(p.block, Some(Block::NothingToRepair { .. })), "{:?}", p.block);
    assert!(has_note(&p, |n| n == &Note::ProgramFoldersStillShort { missing: vec!["git".into(), "gh".into()], problems: Vec::new() }));
    // A setting that finds them all: nothing said.
    let fine = RepairContext { program_folders: Some(ProgramFoldersCtx { missing: Vec::new(), ..c.program_folders.clone().unwrap() }), ..ctx() };
    assert!(!has_note(&plan(&h, &fine), |n| matches!(n, Note::ProgramFoldersStillShort { .. })));
}


// ---------------------------------------------------------------- 1.176.1 Windows walk

const NPM_CODEX: &str = "/opt/homebrew/bin/codex";
const NPM_CODEX_REAL: &str = "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js";

fn pf_ctx(value: &str, shell: Option<&str>) -> RepairContext {
    RepairContext {
        program_folders: Some(ProgramFoldersCtx {
            value: value.into(),
            problems: Vec::new(),
            shell_path: shell.map(str::to_string),
            missing: vec!["claude".into(), "codex".into(), "git".into(), "gh".into()],
        }),
        ..ctx()
    }
}

/// An npm Codex outside the list needs node from the shell's folders: asked
/// as it would run once reachable, it starts — never "starts and stops at
/// once", never an install.
#[test]
fn an_npm_shim_outside_the_list_is_asked_with_the_shells_folders() {
    let fake = Fake::default().link(NPM_CODEX, NPM_CODEX_REAL, "codex-cli 0.171.0").needs(NPM_CODEX, "/usr/bin");
    let list = "/tmp/ply-walk-nothing-here";
    let inputs = Inputs { path_override: true, shell_path: Some(SHELL_PATH.into()), ..mac(list, None) };
    let h = inspect(CliTool::Codex, &inputs, &fake);
    let c = h.copies.iter().find(|c| c.path == NPM_CODEX).unwrap();
    assert!(c.start.as_ref().unwrap().starts, "{:?}", c.start);
    assert!(!h.findings.contains(&Finding::NoWorkingCopy));
    let p = plan(&h, &pf_ctx(list, Some(SHELL_PATH)));
    assert!(!p.installs() && p.manual.iter().all(|m| m.purpose != ManualPurpose::Install), "{:?}", kinds(&p));
    assert_eq!(kinds(&p), vec![StepKind::EmptyProgramFolders, StepKind::Verify], "the shell reports /opt/homebrew/bin");
    // With the list alone it would have failed: that is what tiles get, not
    // how the copy runs once reachable.
    let list_only = Fake::default().link(NPM_CODEX, NPM_CODEX_REAL, "codex-cli 0.171.0").needs(NPM_CODEX, "/usr/bin");
    assert!(matches!(list_only.run_version(NPM_CODEX, list, Duration::from_millis(1)), RunOutcome::Exited { code: Some(1), .. }));
    // The shell's folders unknown: not sure yet, never an install.
    let unknown = inspect(CliTool::Codex, &Inputs { path_override: true, shell_path: None, ..mac(list, None) }, &fake);
    assert!(unknown.copies[0].start.as_ref().unwrap().inconclusive);
    let p = plan(&unknown, &pf_ctx(list, None));
    assert!(matches!(p.block, Some(Block::NotSureYet { .. })), "{:?}", p.block);
    assert!(!p.installs());
}

/// The walk itself: Windows, Codex installed with npm in %APPDATA%\npm.
#[test]
fn the_windows_walks_npm_codex_outside_the_list_works() {
    let shim = r"C:\Users\u\AppData\Roaming\npm\codex.cmd";
    let shell = r"C:\Windows\System32;C:\Program Files\nodejs;C:\Users\u\AppData\Roaming\npm;C:\Users\u\.local\bin";
    let fake = Fake::default().file(shim, "codex-cli 0.171.0").needs(shim, r"C:\Program Files\nodejs");
    let list = r"C:\ply-walk-nothing-here";
    let inputs = Inputs { path_override: true, shell_path: Some(shell.into()), ..windows_inputs(list, None) };
    let h = inspect(CliTool::Codex, &inputs, &fake);
    let c = h.copies.iter().find(|c| c.path == shim).expect("found in npm's folder");
    assert_eq!(c.channel, InstallChannel::Npm);
    assert!(c.start.as_ref().unwrap().starts, "{:?}", c.start);
    let mut ctx_w = pf_ctx(list, Some(shell));
    ctx_w.windows = true;
    ctx_w.home = Some(r"C:\Users\u".into());
    let p = plan(&h, &ctx_w);
    assert_eq!(kinds(&p), vec![StepKind::EmptyProgramFolders, StepKind::Verify]);
    assert!(p.manual.is_empty(), "no by-hand install: {:?}", p.manual);
    assert!(matches!(&p.situations[0], Situation::OutsideProgramFolders { copy, .. } if copy == shim));
    // The report says it works, and no install by hand.
    let facts = crate::cli_repair_report::Facts { windows: true, home: Some(r"C:\Users\u".into()), ..Default::default() };
    let text = crate::cli_repair_report::report(&h, None, false, &p.manual, &facts);
    assert!(text.contains("starts, version 0.171.0"), "{text}");
    assert!(!text.contains("[install]") && !text.contains("install.ps1"), "{text}");
}

/// A node-based copy ON the list, with node off it: tiles really can't start
/// it. Asked with the shell's folders it starts, so the list leaves out what
/// it needs: "Empty Program folders", never an install.
#[test]
fn a_node_based_copy_on_the_list_with_node_off_it_says_what_is_missing() {
    let fake = Fake::default().link(NPM_CODEX, NPM_CODEX_REAL, "codex-cli 0.171.0").needs(NPM_CODEX, "/usr/bin");
    let list = "/opt/homebrew/bin";
    let inputs = Inputs { path_override: true, shell_path: Some(SHELL_PATH.into()), ..mac(list, Some(NPM_CODEX)) };
    let h = inspect(CliTool::Codex, &inputs, &fake);
    let c = h.copies.iter().find(|c| c.path == NPM_CODEX).unwrap();
    assert!(!c.start.as_ref().unwrap().starts, "on the list it gets the list");
    assert_eq!(c.starts_with_shell, Some(true));
    let p = plan(&h, &pf_ctx(list, Some(SHELL_PATH)));
    assert_eq!(
        p.situations[0],
        Situation::ProgramFoldersLeaveOutWhatItNeeds { path: NPM_CODEX.into(), needs: Some("node".into()) }
    );
    assert_eq!(kinds(&p), vec![StepKind::EmptyProgramFolders, StepKind::Verify]);
    assert!(!p.installs() && p.manual.is_empty());
    // Without the shell's folders nothing is asked again: the ordinary path.
    let h2 = inspect(CliTool::Codex, &Inputs { path_override: true, shell_path: None, ..mac(list, Some(NPM_CODEX)) }, &fake);
    assert_eq!(h2.copies[0].starts_with_shell, None);
}
