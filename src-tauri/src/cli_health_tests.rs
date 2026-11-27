//! 1.176.0 R1: the look at one CLI. The classifiers and findings with a
//! scripted [`Machine`] (Mac and Windows machines alike, from strings), then
//! the real [`SystemMachine`] on a temporary folder: fake `claude` scripts
//! that print a version, exit 1, or hang past the bounds; a broken link; a
//! file that isn't executable; a folder that isn't writable or readable; and
//! on macOS truncated Mach-O files (R0 C4, X3).

use super::*;
use std::collections::HashMap;
use std::sync::Mutex;

// ---------------------------------------------------------------- the fake

#[derive(Default)]
struct Fake {
    files: HashMap<String, Look>,
    folders: HashMap<String, FolderLook>,
    /// Outcomes per program, one per call (the last one repeats).
    runs: HashMap<String, Vec<RunOutcome>>,
    ran: Mutex<Vec<(String, Duration)>>,
}

fn mine(real: Option<&str>) -> FileLook {
    FileLook {
        link_target: None,
        chain_end: None,
        real_path: real.map(Into::into),
        target_unreadable: false,
        is_file: real.is_some(),
        executable: real.is_some(),
        owned: Some(true),
        folder_owned: Some(true),
    }
}

impl Fake {
    fn put(mut self, path: &str, look: FileLook) -> Self {
        self.files.insert(path.into(), Look::Found(look));
        self
    }

    fn edit(mut self, path: &str, f: impl FnOnce(&mut FileLook)) -> Self {
        if let Some(Look::Found(look)) = self.files.get_mut(path) {
            f(look);
        }
        self
    }

    /// A regular executable file of this user.
    fn file(self, path: &str) -> Self {
        self.put(path, mine(Some(path)))
    }

    fn link(self, path: &str, real: &str) -> Self {
        self.put(path, FileLook { link_target: Some(real.into()), chain_end: Some(real.into()), ..mine(Some(real)) })
    }

    /// A broken link whose chain stops at `end`.
    fn dangling(self, path: &str, end: &str) -> Self {
        self.put(path, FileLook { link_target: Some(end.into()), chain_end: Some(end.into()), ..FileLook::default() })
    }

    fn unreadable_dir(mut self, path: &str) -> Self {
        self.files.insert(path.into(), Look::Unreadable);
        self
    }

    fn prints(self, path: &str, stdout: &str) -> Self {
        self.run(path, exited(Some(0), None, stdout, ""))
    }

    fn crashes(self, path: &str, stderr: &str) -> Self {
        self.run(path, exited(Some(1), None, "", stderr))
    }

    fn run(mut self, path: &str, outcome: RunOutcome) -> Self {
        self.runs.entry(path.into()).or_default().push(outcome);
        self
    }

    fn folder(mut self, path: &str, owned: Option<bool>, writable: bool) -> Self {
        self.folders.insert(path.into(), FolderLook { exists: true, checked: Some(path.into()), owned, writable });
        self
    }

    fn calls(&self) -> Vec<(String, Duration)> {
        self.ran.lock().unwrap().clone()
    }
}

fn exited(code: Option<i32>, signal: Option<i32>, stdout: &str, stderr: &str) -> RunOutcome {
    RunOutcome::Exited { code, signal, stdout: stdout.as_bytes().to_vec(), stderr: stderr.as_bytes().to_vec() }
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

    fn run_version(&self, program: &str, _env_path: &str, timeout: Duration) -> RunOutcome {
        let mut ran = self.ran.lock().unwrap();
        let nth = ran.iter().filter(|(p, _)| p == program).count();
        ran.push((program.to_string(), timeout));
        let script = self.runs.get(program).unwrap_or_else(|| panic!("no run scripted for {program}"));
        script[nth.min(script.len() - 1)].clone()
    }
}

fn mac(path: &str) -> Inputs {
    Inputs {
        path: path.into(),
        windows: false,
        home: Some("/Users/u".into()),
        codex_home: Some("/Users/u/.codex".into()),
        system_dirs: vec!["/opt/homebrew/bin".into(), "/usr/local/bin".into()],
        ..Inputs::default()
    }
}

fn cached(inp: Inputs, path: Option<&str>) -> Inputs {
    Inputs { cached: path.map_or(Cached::Absent, |p| Cached::Path(p.into())), ..inp }
}

fn windows(path: &str) -> Inputs {
    Inputs {
        path: path.into(),
        windows: true,
        home: Some(r"C:\Users\u".into()),
        local_app_data: Some(r"C:\Users\u\AppData\Local".into()),
        app_data: Some(r"C:\Users\u\AppData\Roaming".into()),
        codex_home: Some(r"C:\Users\u\.codex".into()),
        exts: pathext(None),
        ..Inputs::default()
    }
}

fn kinds(health: &CliHealth) -> Vec<&'static str> {
    health
        .findings
        .iter()
        .map(|f| match f {
            Finding::Missing => "missing",
            Finding::NoWorkingCopy => "noWorkingCopy",
            Finding::CachedPathStale { .. } => "cachedStale",
            Finding::FirstOnPathIsNotTheWorkingOne { .. } => "firstNotWorking",
            Finding::DoesNotStart { .. } => "doesNotStart",
            Finding::StartInconclusive { .. } => "inconclusive",
            Finding::DanglingLink { .. } => "dangling",
            Finding::NotExecutable { .. } => "notExecutable",
            Finding::Unreadable { .. } => "unreadable",
            Finding::CopyNotOwned { .. } => "copyNotOwned",
            Finding::FoldersNotWritable { .. } => "notWritable",
            Finding::FoldersNotOwned { .. } => "notOwned",
            Finding::SeveralCopies { .. } => "several",
            Finding::NativeDirNotOnPath { .. } => "nativeDirNotOnPath",
        })
        .collect()
}

fn folder_ref(path: &str, needed_now: bool, system_folder: bool) -> FolderRef {
    FolderRef { path: path.into(), needed_now, system_folder }
}

const NATIVE: &str = "/Users/u/.local/share/claude/versions/2.1.0";
const NATIVE_LINK: &str = "/Users/u/.local/bin/claude";

// ---------------------------------------------------------------- pure looks

#[test]
fn one_native_claude_first_on_path_is_healthy() {
    let fake = Fake::default().link(NATIVE_LINK, NATIVE).prints(NATIVE_LINK, "2.1.0 (Claude Code)\n");
    let health = inspect(CliTool::Claude, &cached(mac("/Users/u/.local/bin:/usr/bin:/bin"), Some(NATIVE_LINK)), &fake);
    assert!(health.healthy, "{health:#?}");
    assert!(health.findings.is_empty());
    let copy = &health.copies[0];
    assert_eq!(copy.channel, InstallChannel::Native);
    assert!(copy.in_install_dir && !copy.system_folder);
    assert_eq!(copy.start.as_ref().unwrap().version.as_deref(), Some("2.1.0"));
    assert_eq!(health.runs_today.as_deref(), Some(NATIVE_LINK));
    assert_eq!(health.should_run.as_deref(), Some(NATIVE_LINK));
    let check = health.cached.as_ref().unwrap();
    assert!(check.usable && check.matches_now);
    let paths: Vec<&str> = health.folders.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(
        paths,
        [
            "/Users/u/.claude",
            "/Users/u/.claude.json",
            "/Users/u/.local/bin",
            "/Users/u/.local/share/claude",
            "/Users/u/.local/share/claude/versions",
            "/Users/u/.local/state/claude",
            "/Users/u/.cache/claude",
        ]
    );
    assert!(health.folders.iter().all(|f| f.needed_now && !f.system_folder));
    assert_eq!(health.folders[1].kind, FolderKind::File);
}

#[test]
fn nothing_anywhere_is_only_missing() {
    let health = inspect(CliTool::Claude, &mac("/usr/bin:/bin"), &Fake::default());
    assert_eq!(kinds(&health), ["missing"]);
    assert!(!health.healthy);
    assert_eq!(health.runs_today, None);
}

// --- the cached path (review point 1)

#[test]
fn a_cached_path_that_is_gone_is_stale_and_unhealthy() {
    let cask = "/opt/homebrew/Caskroom/claude-code/2.1.0/claude";
    let fake = Fake::default().link("/opt/homebrew/bin/claude", cask).prints("/opt/homebrew/bin/claude", "2.1.0");
    let inp = cached(mac("/opt/homebrew/bin"), Some("/Users/u/.claude/local/claude"));
    let health = inspect(CliTool::Claude, &inp, &fake);
    assert!(!health.healthy);
    assert_eq!(health.runs_today, None, "a tile runs nothing");
    assert_eq!(kinds(&health), ["cachedStale", "firstNotWorking"]);
    assert_eq!(
        health.findings[0],
        Finding::CachedPathStale {
            cached: Some("/Users/u/.claude/local/claude".into()),
            now: Some("/opt/homebrew/bin/claude".into()),
            usable: false
        }
    );
}

#[test]
fn a_cached_alias_line_is_not_runnable() {
    let fake = Fake::default().link(NATIVE_LINK, NATIVE).prints(NATIVE_LINK, "2.1.0");
    let inp = cached(mac("/Users/u/.local/bin"), Some("alias claude=/Users/u/.claude/local/claude"));
    let health = inspect(CliTool::Claude, &inp, &fake);
    assert!(!health.healthy);
    assert!(!health.cached.as_ref().unwrap().usable);
    assert_eq!(kinds(&health)[0], "cachedStale");
}

#[test]
fn a_cached_bare_name_is_resolved_on_path() {
    let fake = Fake::default().link(NATIVE_LINK, NATIVE).prints(NATIVE_LINK, "2.1.0");
    let health = inspect(CliTool::Claude, &cached(mac("/usr/bin:/Users/u/.local/bin"), Some("claude")), &fake);
    assert_eq!(health.cached.as_ref().unwrap().runs.as_deref(), Some(NATIVE_LINK));
    assert!(health.healthy, "{health:#?}");
}

#[test]
fn a_cached_absent_tool_that_is_now_installed_is_stale() {
    let fake = Fake::default().link(NATIVE_LINK, NATIVE).prints(NATIVE_LINK, "2.1.0");
    let health = inspect(CliTool::Claude, &cached(mac("/Users/u/.local/bin"), None), &fake);
    assert_eq!(health.runs_today, None);
    assert_eq!(
        health.findings[0],
        Finding::CachedPathStale { cached: None, now: Some(NATIVE_LINK.into()), usable: false }
    );
    assert!(!health.healthy);
}

#[test]
fn a_cached_file_that_isnt_executable_is_what_a_tile_tries() {
    let fake = Fake::default()
        .file("/usr/local/bin/claude")
        .edit("/usr/local/bin/claude", |l| l.executable = false)
        .link(NATIVE_LINK, NATIVE)
        .prints(NATIVE_LINK, "2.1.0");
    let inp = cached(mac("/usr/local/bin:/Users/u/.local/bin"), Some("/usr/local/bin/claude"));
    let health = inspect(CliTool::Claude, &inp, &fake);
    assert_eq!(health.runs_today.as_deref(), Some("/usr/local/bin/claude"));
    let check = health.cached.as_ref().unwrap();
    assert!(check.exists && !check.executable && !check.usable);
    assert_eq!(check.now.as_deref(), Some(NATIVE_LINK), "resolve_program skips it");
    assert_eq!(kinds(&health), ["cachedStale", "firstNotWorking", "notExecutable", "several"]);
}

#[test]
fn a_cached_copy_off_path_is_looked_at_too() {
    let other = "/Users/u/tools/claude";
    let fake = Fake::default().file(other).prints(other, "2.1.0");
    let health = inspect(CliTool::Claude, &cached(mac("/usr/bin"), Some(other)), &fake);
    assert_eq!(health.copies.len(), 1);
    assert_eq!(health.copies[0].path_rank, None);
    assert_eq!(health.runs_today.as_deref(), Some(other));
    assert!(health.healthy, "a tile runs it and it works: {health:#?}");
    assert_eq!(kinds(&health), ["cachedStale"], "the disk's PATH has none");
}

// --- broken links (review point 2)

#[test]
fn a_broken_native_link_before_homebrew_is_named_and_classified() {
    // R0 C3: the update removed the version the link names; the lookup
    // then silently falls through to an older Homebrew copy.
    let cask = "/opt/homebrew/Caskroom/claude-code/2.0.9/claude";
    let gone = "/Users/u/.local/share/claude/versions/2.0.8";
    let fake = Fake::default()
        .dangling(NATIVE_LINK, gone)
        .link("/opt/homebrew/bin/claude", cask)
        .prints("/opt/homebrew/bin/claude", "2.0.9 (Claude Code)");
    let health = inspect(CliTool::Claude, &mac("/Users/u/.local/bin:/opt/homebrew/bin:/usr/bin"), &fake);
    assert_eq!(kinds(&health), ["dangling"]);
    assert!(!health.healthy, "a broken link in the install folder is not healthy");
    assert_eq!(
        health.findings[0],
        Finding::DanglingLink { path: NATIVE_LINK.into(), target: Some(gone.into()), channel: InstallChannel::Native }
    );
    assert_eq!(health.copies[0].channel, InstallChannel::Native);
    assert!(health.copies[0].start.is_none(), "a broken link is never run");
    assert_eq!(health.runs_today.as_deref(), Some("/opt/homebrew/bin/claude"));
    let cask_dir = health.folders.iter().find(|f| f.path == "/opt/homebrew/Caskroom").expect("caskroom");
    assert!(cask_dir.needed_now && cask_dir.system_folder);
    assert!(!health.folders.iter().find(|f| f.path == "/Users/u/.local/share/claude/versions").unwrap().needed_now);
}

#[test]
fn a_broken_codex_current_link_reads_as_standalone() {
    // R0 X3: `~/.local/bin/codex` → `…/standalone/current/bin/codex`, and
    // `current` dangles: the chain stops inside the standalone folder.
    let end = "/Users/u/.codex/packages/standalone/current/bin/codex";
    let fake = Fake::default().dangling("/Users/u/.local/bin/codex", end);
    let health = inspect(CliTool::Codex, &mac("/Users/u/.local/bin"), &fake);
    assert_eq!(health.copies[0].channel, InstallChannel::Standalone);
    assert_eq!(kinds(&health), ["noWorkingCopy", "dangling"]);
    let paths: Vec<&str> = health.folders.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(
        paths,
        [
            "/Users/u/.codex",
            "/Users/u/.local/bin",
            "/Users/u/.codex/packages/standalone",
            "/Users/u/.codex/packages/standalone/releases",
        ]
    );
}

#[test]
fn a_broken_npm_link_keeps_its_npm_folders() {
    let end = "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe";
    let fake = Fake::default().dangling("/opt/homebrew/bin/claude", end);
    let health = inspect(CliTool::Claude, &mac("/opt/homebrew/bin"), &fake);
    assert_eq!(health.copies[0].channel, InstallChannel::Npm);
    let npm = health.folders.iter().find(|f| f.path == "/opt/homebrew/lib/node_modules/@anthropic-ai").expect("npm scope");
    assert_eq!(npm.role, FolderRole::Copy);
    assert!(npm.system_folder);
}

#[test]
fn a_stale_link_off_path_does_not_nag_a_working_machine() {
    // Decision: only copies on PATH, in the install folder, or what a tile
    // runs count for `healthy`; a leftover elsewhere is still named.
    let fake = Fake::default()
        .link(NATIVE_LINK, NATIVE)
        .prints(NATIVE_LINK, "2.1.0")
        .dangling("/Users/u/.claude/local/claude", "/Users/u/.claude/local/node_modules/.bin/claude");
    let health = inspect(CliTool::Claude, &cached(mac("/Users/u/.local/bin"), Some(NATIVE_LINK)), &fake);
    assert!(health.healthy, "{health:#?}");
    assert_eq!(kinds(&health), ["dangling"]);
    assert_eq!(health.copies[1].channel, InstallChannel::LegacyLocal);
}

// --- failures, signals, timeouts (review point 3, minor 1)

#[test]
fn a_crashing_npm_copy_first_on_path_points_at_the_working_one() {
    let npm_real = "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js";
    let fake = Fake::default()
        .link("/usr/local/bin/claude", npm_real)
        .crashes("/usr/local/bin/claude", "\u{1b}[31mError: Cannot find module 'yoga.wasm'\u{1b}[0m\nNode.js v22.1.0\n")
        .link(NATIVE_LINK, NATIVE)
        .prints(NATIVE_LINK, "2.1.0 (Claude Code)")
        .folder("/usr/local/lib/node_modules/@anthropic-ai", Some(false), false);
    let health = inspect(CliTool::Claude, &mac("/usr/local/bin:/Users/u/.local/bin:/usr/bin"), &fake);
    // 1.176.0 R4 (B2): a tile runs what the snapshot's rule picks — the
    // first copy on PATH gives way to the next that starts when it certainly
    // doesn't (`shell_env::choose_copy`) — so the working one is what runs.
    assert_eq!(kinds(&health), ["doesNotStart", "notWritable", "several"]);
    assert_eq!(health.runs_today.as_deref(), Some(NATIVE_LINK));
    let Finding::DoesNotStart { failure, exit_code, tail, .. } = &health.findings[0] else { panic!() };
    assert_eq!((*failure, *exit_code), (StartFailure::Exited, Some(1)));
    assert_eq!(tail.as_deref(), Some("Error: Cannot find module 'yoga.wasm'\nNode.js v22.1.0"));
    // /usr/local is a system folder: named as not writable, flagged, but
    // never as "not yours" (a Repair offers no chown there).
    assert_eq!(
        health.findings[1],
        Finding::FoldersNotWritable {
            folders: vec![folder_ref("/usr/local/lib/node_modules/@anthropic-ai", false, true)]
        }
    );
    assert!(!health.healthy);
}

#[test]
fn signals_and_wrapper_codes_map_to_their_kind() {
    let kind = |o: RunOutcome| start_from(o).failure;
    assert_eq!(kind(exited(None, Some(9), "", "")), Some(StartFailure::BadBinary));
    assert_eq!(start_from(exited(None, Some(9), "", "")).signal, Some(9));
    assert_eq!(kind(exited(Some(137), None, "", "")), Some(StartFailure::BadBinary));
    assert_eq!(kind(exited(Some(127), None, "", "env: node: No such file")), Some(StartFailure::NotFound));
    assert_eq!(kind(exited(Some(2), None, "", "")), Some(StartFailure::Exited));
    assert_eq!(kind(RunOutcome::SpawnFailed("Malformed Mach-o file (os error 88)".into())), Some(StartFailure::BadBinary));
    assert_eq!(kind(RunOutcome::SpawnFailed("Bad CPU type in executable (os error 86)".into())), Some(StartFailure::BadBinary));
    assert_eq!(kind(RunOutcome::SpawnFailed("Exec format error (os error 8)".into())), Some(StartFailure::BadBinary));
    assert_eq!(
        kind(RunOutcome::SpawnFailed("%1 is not a valid Win32 application. (os error 193)".into())),
        Some(StartFailure::BadBinary)
    );
    assert_eq!(kind(RunOutcome::SpawnFailed("No such file or directory (os error 2)".into())), Some(StartFailure::NotFound));
    assert_eq!(kind(RunOutcome::SpawnFailed("Access is denied. (os error 5)".into())), Some(StartFailure::PermissionDenied));
    assert_eq!(kind(RunOutcome::SpawnFailed("Too many open files (os error 24)".into())), Some(StartFailure::SpawnFailed));
}

#[test]
fn a_slow_first_launch_is_retried_with_the_longer_bound() {
    let fake = Fake::default()
        .link(NATIVE_LINK, NATIVE)
        .run(NATIVE_LINK, RunOutcome::TimedOut)
        .prints(NATIVE_LINK, "2.1.0");
    let health = inspect(CliTool::Claude, &mac("/Users/u/.local/bin"), &fake);
    assert!(health.healthy, "{health:#?}");
    assert_eq!(fake.calls(), [(NATIVE_LINK.to_string(), VERSION_TIMEOUT), (NATIVE_LINK.to_string(), VERSION_RETRY_TIMEOUT)]);
}

#[test]
fn a_copy_past_both_bounds_is_inconclusive_not_broken() {
    let fake = Fake::default().link(NATIVE_LINK, NATIVE).run(NATIVE_LINK, RunOutcome::TimedOut);
    let health = inspect(CliTool::Claude, &mac("/Users/u/.local/bin"), &fake);
    assert_eq!(kinds(&health), ["inconclusive"], "no NoWorkingCopy on timeouts alone");
    let start = health.copies[0].start.as_ref().unwrap();
    assert!(start.inconclusive && !start.starts);
    assert!(!health.healthy);
}

#[test]
fn spawn_failures_and_timeouts_are_told_apart() {
    let fake = Fake::default()
        .link(NATIVE_LINK, NATIVE)
        .run(NATIVE_LINK, RunOutcome::SpawnFailed("Permission denied (os error 13)".into()))
        .file("/opt/homebrew/bin/claude")
        .run("/opt/homebrew/bin/claude", RunOutcome::TimedOut);
    let health = inspect(CliTool::Claude, &mac("/Users/u/.local/bin:/opt/homebrew/bin"), &fake);
    assert_eq!(kinds(&health), ["doesNotStart", "inconclusive", "several"]);
    assert_eq!(health.copies[0].start.as_ref().unwrap().failure, Some(StartFailure::PermissionDenied));
    assert_eq!(health.copies[0].start.as_ref().unwrap().tail.as_deref(), Some("Permission denied (os error 13)"));
}

// --- folders and owners (review point 4, minor 2–3)

#[test]
fn a_root_owned_native_version_is_named_and_unhealthy() {
    // After a `sudo` install: `versions/2.1.330` belongs to root.
    let fake = Fake::default()
        .link(NATIVE_LINK, NATIVE)
        .edit(NATIVE_LINK, |l| l.owned = Some(false))
        .prints(NATIVE_LINK, "2.1.0")
        .folder("/Users/u/.local/share/claude/versions", Some(false), false);
    let health = inspect(CliTool::Claude, &mac("/Users/u/.local/bin"), &fake);
    assert!(!health.healthy);
    assert_eq!(
        health.findings,
        [
            Finding::CopyNotOwned { path: NATIVE_LINK.into(), system_folder: false },
            Finding::FoldersNotWritable {
                folders: vec![folder_ref("/Users/u/.local/share/claude/versions", true, false)]
            },
            Finding::FoldersNotOwned {
                folders: vec![folder_ref("/Users/u/.local/share/claude/versions", true, false)]
            },
        ]
    );
}

#[test]
fn a_root_owned_homebrew_copy_is_named_but_healthy() {
    let cask = "/opt/homebrew/Caskroom/claude-code/2.1.0/claude";
    let fake = Fake::default()
        .link("/opt/homebrew/bin/claude", cask)
        .edit("/opt/homebrew/bin/claude", |l| l.owned = Some(false))
        .prints("/opt/homebrew/bin/claude", "2.1.0")
        .folder("/opt/homebrew/Caskroom", Some(false), true);
    let health = inspect(CliTool::Claude, &mac("/opt/homebrew/bin"), &fake);
    assert!(health.healthy, "{health:#?}");
    assert_eq!(
        health.findings,
        [Finding::CopyNotOwned { path: "/opt/homebrew/bin/claude".into(), system_folder: true }],
        "never FoldersNotOwned for a system folder"
    );
}

#[test]
fn a_working_homebrew_copy_stays_healthy_when_only_the_repair_target_is_blocked() {
    let cask = "/opt/homebrew/Caskroom/claude-code/2.1.0/claude";
    let fake = Fake::default()
        .link("/opt/homebrew/bin/claude", cask)
        .prints("/opt/homebrew/bin/claude", "2.1.0")
        .folder("/Users/u/.local/bin", Some(false), false);
    let health = inspect(CliTool::Claude, &mac("/opt/homebrew/bin:/Users/u/.local/bin"), &fake);
    assert!(health.healthy, "{health:#?}");
    assert_eq!(
        health.findings,
        [
            Finding::FoldersNotWritable { folders: vec![folder_ref("/Users/u/.local/bin", false, false)] },
            Finding::FoldersNotOwned { folders: vec![folder_ref("/Users/u/.local/bin", false, false)] },
        ],
        "named for a later Repair, not needed now"
    );
}

#[test]
fn codex_folders_honour_codex_home() {
    let inp = Inputs { codex_home: Some("/data/codex".into()), ..mac("/Users/u/.local/bin") };
    let real = "/data/codex/packages/standalone/releases/0.60.0/codex";
    let fake = Fake::default()
        .link("/Users/u/.local/bin/codex", real)
        .prints("/Users/u/.local/bin/codex", "codex-cli 0.60.0");
    let health = inspect(CliTool::Codex, &inp, &fake);
    let paths: Vec<&str> = health.folders.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(
        paths,
        ["/data/codex", "/Users/u/.local/bin", "/data/codex/packages/standalone", "/data/codex/packages/standalone/releases"]
    );
    assert!(health.folders.iter().all(|f| !f.system_folder), "a moved Codex home is still the user's");
    assert!(health.healthy);
    assert_eq!(health.copies[0].channel, InstallChannel::Standalone);
}

#[test]
fn claude_config_dir_moves_the_config_folders() {
    let inp = Inputs { claude_config_dir: Some("/data/claude".into()), ..mac("") };
    let plan = folder_plan(CliTool::Claude, &inp, &[], None);
    assert_eq!(plan[0].path, "/data/claude");
    assert_eq!(plan[1].path, "/data/claude/.claude.json");
    assert!(plan[2..].iter().all(|f| !f.needed_now), "nothing runs: only the config is needed now");
}

// --- PATH, unreadable folders (minor 4, 7)

#[test]
fn blank_and_relative_path_entries_are_skipped() {
    assert_eq!(
        split_path("/a::./bin:bin:/b", false),
        [(0, "/a".to_string()), (3, "/b".to_string())]
    );
    assert_eq!(split_path(r#"C:\a;;"C:\b c";.\bin;\\srv\x"#, true), [(0, r"C:\a".into()), (1, r"C:\b c".into()), (3, r"\\srv\x".into())]);
    let fake = Fake::default().file("bin/claude").prints("bin/claude", "2.1.0");
    let health = inspect(CliTool::Claude, &mac("bin"), &fake);
    assert_eq!(kinds(&health), ["missing"]);
}

#[test]
fn an_unreadable_path_folder_is_reported_not_hidden() {
    let fake = Fake::default()
        .unreadable_dir("/Users/u/bin/claude")
        .link(NATIVE_LINK, NATIVE)
        .prints(NATIVE_LINK, "2.1.0");
    let health = inspect(CliTool::Claude, &mac("/Users/u/bin:/Users/u/.local/bin"), &fake);
    assert_eq!(health.findings, [Finding::Unreadable { paths: vec!["/Users/u/bin".into()] }]);
}

#[test]
fn a_link_that_cant_be_followed_is_unreadable_not_dangling() {
    let fake = Fake::default().put(
        NATIVE_LINK,
        FileLook {
            link_target: Some(NATIVE.into()),
            chain_end: Some(NATIVE.into()),
            target_unreadable: true,
            ..FileLook::default()
        },
    );
    let health = inspect(CliTool::Claude, &mac("/Users/u/.local/bin"), &fake);
    assert!(!health.copies[0].dangling && health.copies[0].unreadable);
    assert_eq!(health.copies[0].channel, InstallChannel::Native);
    assert_eq!(kinds(&health), ["noWorkingCopy", "unreadable"]);
}

#[test]
fn the_native_folder_off_path_is_named_only_with_a_copy_in_it() {
    let fake = Fake::default().link(NATIVE_LINK, NATIVE).prints(NATIVE_LINK, "2.1.0");
    let health = inspect(CliTool::Claude, &mac("/usr/bin:/bin"), &fake);
    assert_eq!(health.copies[0].path_rank, None);
    assert_eq!(kinds(&health), ["firstNotWorking", "nativeDirNotOnPath"]);
    assert_eq!(
        health.findings[0],
        Finding::FirstOnPathIsNotTheWorkingOne { first: None, working: NATIVE_LINK.into(), working_on_path: false }
    );
    assert!(!health.healthy);
}

#[test]
fn paths_that_are_one_real_file_are_one_copy() {
    let fake = Fake::default()
        .link("/opt/homebrew/bin/claude", NATIVE)
        .link(NATIVE_LINK, NATIVE)
        .prints("/opt/homebrew/bin/claude", "2.1.0");
    let health = inspect(CliTool::Claude, &mac("/opt/homebrew/bin:/Users/u/.local/bin:/opt/homebrew/bin/"), &fake);
    assert_eq!(health.copies.len(), 1);
    assert_eq!(health.copies[0].also_at, [NATIVE_LINK]);
    assert_eq!(fake.calls().len(), 1, "one real file is run once");
    assert!(health.healthy);
}

#[test]
fn a_file_that_isnt_executable_is_named_and_not_run() {
    let fake = Fake::default().file(NATIVE_LINK).edit(NATIVE_LINK, |l| l.executable = false);
    let health = inspect(CliTool::Claude, &mac("/Users/u/.local/bin"), &fake);
    assert_eq!(kinds(&health), ["noWorkingCopy", "notExecutable"]);
    assert_eq!(health.runs_today.as_deref(), Some(NATIVE_LINK), "find_in_path picks any file");
    assert!(fake.calls().is_empty());
}

// --- channels (minor 5, 6)

#[test]
fn claude_channels_from_their_paths() {
    let inp = mac("");
    let c = |found: &str, real: Option<&str>| classify(CliTool::Claude, found, real, &inp);
    assert_eq!(c(NATIVE_LINK, Some(NATIVE)), InstallChannel::Native);
    assert_eq!(
        c("/opt/homebrew/bin/claude", Some("/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js")),
        InstallChannel::Npm
    );
    assert_eq!(c("/usr/local/bin/claude", Some("/usr/local/Caskroom/claude-code/2.1.0/claude")), InstallChannel::Homebrew);
    assert_eq!(
        c("/Users/u/.claude/local/claude", Some("/Users/u/.claude/local/node_modules/@anthropic-ai/claude-code/cli.js")),
        InstallChannel::LegacyLocal
    );
    assert_eq!(
        c("/Users/u/.bun/bin/claude", Some("/Users/u/.bun/install/global/node_modules/@anthropic-ai/claude-code/cli.js")),
        InstallChannel::Bun
    );
    assert_eq!(
        c(
            "/Users/u/Library/pnpm/claude",
            Some("/Users/u/Library/pnpm/global/5/.pnpm/@anthropic-ai+claude-code@2.1.0/node_modules/@anthropic-ai/claude-code/cli.js")
        ),
        InstallChannel::Pnpm
    );
    // A version manager's shim says nothing of what it launches.
    assert_eq!(c("/Users/u/.volta/bin/claude", Some("/Users/u/.volta/bin/volta-shim")), InstallChannel::Unknown);
    assert_eq!(c("/usr/local/bin/claude", None), InstallChannel::Unknown);
}

#[test]
fn codex_channels_follow_the_doctors_rules() {
    let inp = mac("");
    let c = |found: &str, real: Option<&str>| classify(CliTool::Codex, found, real, &inp);
    assert_eq!(
        c("/Users/u/.local/bin/codex", Some("/Users/u/.codex/packages/standalone/releases/0.60.0/codex")),
        InstallChannel::Standalone
    );
    assert_eq!(
        c("/opt/homebrew/bin/codex", Some("/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js")),
        InstallChannel::Npm
    );
    assert_eq!(
        c("/Users/u/.bun/bin/codex", Some("/Users/u/.bun/install/global/node_modules/@openai/codex/bin/codex.js")),
        InstallChannel::Bun,
        "npm must never update a bun install"
    );
    assert_eq!(c("/opt/homebrew/bin/codex", Some("/opt/homebrew/Caskroom/codex/0.60.0/codex")), InstallChannel::Homebrew);
    assert_eq!(c("/usr/local/bin/codex", Some("/usr/local/bin/codex")), InstallChannel::Unknown);
    let moved = Inputs { codex_home: Some("/data/codex".into()), ..mac("") };
    assert_eq!(
        classify(CliTool::Codex, "/Users/u/.local/bin/codex", Some("/data/codex/packages/standalone/x/codex"), &moved),
        InstallChannel::Standalone
    );
}

#[test]
fn windows_channels_from_strings() {
    let inp = windows("");
    let claude = |found: &str, real: Option<&str>| classify(CliTool::Claude, found, real, &inp);
    let codex = |found: &str, real: Option<&str>| classify(CliTool::Codex, found, real, &inp);
    assert_eq!(claude(r"C:\Users\u\.local\bin\claude.exe", None), InstallChannel::Native);
    assert_eq!(claude(r"C:\Users\u\AppData\Roaming\npm\claude.cmd", None), InstallChannel::Npm);
    assert_eq!(claude(r"C:\Users\u\AppData\Local\pnpm\claude.cmd", None), InstallChannel::Pnpm);
    assert_eq!(
        claude(
            r"C:\Users\u\AppData\Local\Microsoft\WinGet\Links\claude.exe",
            Some(r"C:\Users\u\AppData\Local\Microsoft\WinGet\Packages\Anthropic.ClaudeCode_x\claude.exe")
        ),
        InstallChannel::Winget
    );
    assert_eq!(codex(r"C:\Users\u\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe", None), InstallChannel::Standalone);
    assert_eq!(codex(r"C:\Users\u\AppData\Roaming\npm\codex.cmd", None), InstallChannel::Npm);
    assert_eq!(codex(r"C:\Users\u\scoop\shims\codex.exe", None), InstallChannel::Unknown);
    // An npm prefix moved out of %APPDATA%\npm (`prefix=` in .npmrc).
    let moved = Inputs { npm_prefix: Some(r"D:\npm-global".into()), ..windows("") };
    assert_eq!(classify(CliTool::Claude, r"D:\npm-global\claude.cmd", None, &moved), InstallChannel::Npm);
    assert!(known_dirs(CliTool::Claude, &moved).contains(&r"D:\npm-global".to_string()));
}

#[test]
fn windows_names_and_known_folders() {
    let inp = windows("");
    assert_eq!(program_names(CliTool::Codex, &inp), ["codex.com", "codex.exe", "codex.bat", "codex.cmd"]);
    assert_eq!(pathext(Some("EXE; .Cmd ;;")), [".exe", ".cmd"], "entries without a dot get one");
    assert_eq!(
        known_dirs(CliTool::Codex, &inp),
        [
            r"C:\Users\u\AppData\Local\Programs\OpenAI\Codex\bin",
            r"C:\Users\u\.local\bin",
            r"C:\Users\u\AppData\Roaming\npm",
            r"C:\Users\u\AppData\Local\Microsoft\WinGet\Links",
        ]
    );
    assert_eq!(
        known_dirs(CliTool::Claude, &inp),
        [
            r"C:\Users\u\.local\bin",
            r"C:\Users\u\.claude\local",
            r"C:\Users\u\AppData\Roaming\npm",
            r"C:\Users\u\AppData\Local\Microsoft\WinGet\Links",
        ]
    );
}

#[test]
fn a_windows_npm_codex_found_once_without_case() {
    let shim = r"c:\users\u\appdata\roaming\NPM\codex.cmd";
    let fake = Fake::default()
        .file(shim)
        .edit(shim, |l| {
            l.owned = None;
            l.folder_owned = None;
        })
        .prints(shim, "codex-cli 0.60.1");
    let inp = cached(windows(r"c:\users\u\appdata\roaming\NPM;C:\Windows"), Some(shim));
    let health = inspect(CliTool::Codex, &inp, &fake);
    assert_eq!(health.copies.len(), 1, "{health:#?}");
    let copy = &health.copies[0];
    assert_eq!(copy.path_rank, Some(0));
    assert_eq!(copy.channel, InstallChannel::Npm);
    assert_eq!(copy.owned_by_user, None, "ownership isn't read on Windows");
    let npm_pkg = health.folders.iter().find(|f| f.role == FolderRole::Copy && f.path.ends_with("@openai"));
    assert_eq!(npm_pkg.map(|f| f.path.as_str()), Some(r"c:\users\u\appdata\roaming\NPM\node_modules\@openai"));
    assert!(npm_pkg.is_some_and(|f| f.needed_now && !f.system_folder));
    assert!(health.cached.as_ref().unwrap().matches_now);
    assert!(health.healthy, "{health:#?}");
}

// --- small pure pieces

#[test]
fn npm_prefix_from_npmrc() {
    assert_eq!(npmrc_prefix("# x\nprefix=~/.npm-global\n", Some("/Users/u"), false).as_deref(), Some("/Users/u/.npm-global"));
    assert_eq!(npmrc_prefix("prefix = \"/opt/npm\"", None, false).as_deref(), Some("/opt/npm"));
    assert_eq!(npmrc_prefix("registry=https://x", Some("/Users/u"), false), None);
    let inp = Inputs { npm_prefix: Some("/Users/u/.npm-global".into()), ..mac("") };
    assert!(known_dirs(CliTool::Claude, &inp).contains(&"/Users/u/.npm-global/bin".to_string()));
}

#[test]
fn the_tail_keeps_the_last_lines_only() {
    let many: String = (1..=40).map(|n| format!("line {n}\n")).collect();
    let tail = tail_of(many.as_bytes(), b"").unwrap();
    assert_eq!(tail.lines().count(), 12);
    assert!(tail.starts_with("line 29") && tail.ends_with("line 40"));
    let long = "é".repeat(2000);
    assert_eq!(tail_of(long.as_bytes(), b"").unwrap().chars().count(), 800);
    assert_eq!(tail_of(b"  \n", b"\n"), None);
}

#[test]
fn findings_serialise_tagged_by_kind() {
    let json = serde_json::to_value(Finding::FirstOnPathIsNotTheWorkingOne {
        first: None,
        working: "/w".into(),
        working_on_path: false,
    })
    .unwrap();
    assert_eq!(
        json,
        serde_json::json!({"kind": "firstOnPathIsNotTheWorkingOne", "first": null, "working": "/w", "workingOnPath": false})
    );
    let json = serde_json::to_value(Finding::FoldersNotWritable { folders: vec![folder_ref("/f", true, false)] }).unwrap();
    assert_eq!(
        json,
        serde_json::json!({"kind": "foldersNotWritable", "folders": [{"path": "/f", "neededNow": true, "systemFolder": false}]})
    );
    let json = serde_json::to_value(Finding::CachedPathStale { cached: None, now: None, usable: false }).unwrap();
    assert_eq!(json["kind"], "cachedPathStale");
    let start = serde_json::to_value(start_from(exited(None, Some(9), "", ""))).unwrap();
    assert_eq!(start["failure"], "badBinary");
    assert_eq!(start["signal"], 9);
    assert_eq!(start["inconclusive"], false);
    assert_eq!(serde_json::to_value(InstallChannel::LegacyLocal).unwrap(), "legacyLocal");
}

// ---------------------------------------------------------------- real disk

#[cfg(unix)]
mod real {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn script(path: &Path, body: &str) {
        std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn inputs(home: &Path, bins: &[&Path]) -> Inputs {
        let path = bins.iter().map(|b| b.to_string_lossy().into_owned()).collect::<Vec<_>>().join(":");
        Inputs {
            path,
            windows: false,
            home: Some(home.to_string_lossy().into_owned()),
            codex_home: Some(home.join(".codex").to_string_lossy().into_owned()),
            version_bounds: Some((Duration::from_secs(8), Duration::from_secs(8))),
            ..Inputs::default()
        }
    }

    /// A temporary home, canonical (macOS's `/var` is a link to
    /// `/private/var`) so real paths compare as found.
    fn real_home() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = std::fs::canonicalize(dir.path()).unwrap();
        (dir, path)
    }

    fn bin_in(home: &Path) -> PathBuf {
        let bin = home.join("bin");
        std::fs::create_dir(&bin).unwrap();
        bin
    }

    fn root() -> bool {
        unsafe { libc::geteuid() == 0 }
    }

    #[test]
    fn a_script_that_prints_a_version_starts() {
        let (_keep, home) = real_home();
        let bin = bin_in(&home);
        script(&bin.join("claude"), "echo '2.1.3 (Claude Code)'");
        let health = inspect(CliTool::Claude, &inputs(&home, &[&bin]), &SystemMachine);
        assert_eq!(health.copies.len(), 1, "{health:#?}");
        let start = health.copies[0].start.as_ref().unwrap();
        assert!(start.starts);
        assert_eq!(start.version.as_deref(), Some("2.1.3"));
        assert_eq!(health.copies[0].owned_by_user, Some(true));
        assert!(health.healthy, "{health:#?}");
        let share = health.folders.iter().find(|f| f.path.ends_with("/.local/share/claude")).unwrap();
        assert!(!share.exists && share.writable);
        assert_eq!(share.checked.as_deref(), Some(home.to_string_lossy().as_ref()));
        assert!(!home.join(".local").exists(), "a look never creates a folder");
        let left: Vec<_> = std::fs::read_dir(&home).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left, [std::ffi::OsString::from("bin")], "nothing left behind");
    }

    #[test]
    fn a_script_that_exits_1_does_not_start() {
        let (_keep, home) = real_home();
        let bin = bin_in(&home);
        script(&bin.join("claude"), "echo 'Error: EACCES: permission denied' >&2\nexit 1");
        let health = inspect(CliTool::Claude, &inputs(&home, &[&bin]), &SystemMachine);
        let start = health.copies[0].start.as_ref().unwrap();
        assert!(!start.starts);
        assert_eq!(start.exit_code, Some(1));
        assert_eq!(start.tail.as_deref(), Some("Error: EACCES: permission denied"));
        assert_eq!(kinds(&health), ["noWorkingCopy", "doesNotStart"]);
    }

    #[test]
    fn a_script_that_hangs_is_inconclusive_after_two_bounds() {
        let (_keep, home) = real_home();
        let bin = bin_in(&home);
        script(&bin.join("claude"), "exec /bin/sleep 30");
        let inp = Inputs { version_bounds: Some((Duration::from_secs(1), Duration::from_secs(1))), ..inputs(&home, &[&bin]) };
        let started = std::time::Instant::now();
        let health = inspect(CliTool::Claude, &inp, &SystemMachine);
        assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
        assert!(health.copies[0].start.as_ref().unwrap().inconclusive);
        assert_eq!(kinds(&health), ["inconclusive"]);
    }

    #[test]
    fn a_broken_link_is_classified_by_where_it_pointed() {
        let (_keep, home) = real_home();
        let local = home.join(".local").join("bin");
        std::fs::create_dir_all(&local).unwrap();
        // Relative, as a hand-made link might be: the chain end is folded.
        std::os::unix::fs::symlink("../share/claude/versions/2.0.8", local.join("claude")).unwrap();
        let other = home.join("other");
        std::fs::create_dir(&other).unwrap();
        std::fs::write(other.join("claude"), "#!/bin/sh\necho 1.0.0\n").unwrap();
        std::fs::set_permissions(other.join("claude"), std::fs::Permissions::from_mode(0o644)).unwrap();
        let health = inspect(CliTool::Claude, &inputs(&home, &[&local, &other]), &SystemMachine);
        assert_eq!(health.copies.len(), 2, "{health:#?}");
        let broken = &health.copies[0];
        assert!(broken.dangling);
        assert_eq!(broken.link_target.as_deref(), Some("../share/claude/versions/2.0.8"));
        let end = home.join(".local/share/claude/versions/2.0.8");
        assert_eq!(broken.link_end.as_deref(), Some(end.to_string_lossy().as_ref()));
        assert_eq!(broken.channel, InstallChannel::Native);
        assert!(!health.copies[1].executable);
        assert_eq!(kinds(&health), ["noWorkingCopy", "dangling", "notExecutable"]);
    }

    #[test]
    fn two_copies_and_a_read_only_folder() {
        if root() {
            return;
        }
        let (_keep, home) = real_home();
        let a = home.join("a");
        let b = home.join("b");
        std::fs::create_dir(&a).unwrap();
        std::fs::create_dir(&b).unwrap();
        script(&a.join("claude"), "echo 2.1.0");
        script(&b.join("claude"), "echo 2.0.0");
        let config = home.join(".claude");
        std::fs::create_dir(&config).unwrap();
        std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o555)).unwrap();
        let health = inspect(CliTool::Claude, &inputs(&home, &[&a, &b]), &SystemMachine);
        std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(kinds(&health), ["notWritable", "several"], "{health:#?}");
        assert_eq!(
            health.findings[0],
            Finding::FoldersNotWritable { folders: vec![folder_ref(&config.to_string_lossy(), true, false)] }
        );
        assert_eq!(health.should_run.as_deref(), Some(a.join("claude").to_string_lossy().as_ref()));
        assert!(!health.healthy);
    }

    #[test]
    fn an_unreadable_path_folder_is_reported() {
        if root() {
            return;
        }
        let (_keep, home) = real_home();
        let shut = home.join("shut");
        std::fs::create_dir(&shut).unwrap();
        script(&shut.join("claude"), "echo 2.1.0");
        std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o000)).unwrap();
        let health = inspect(CliTool::Claude, &inputs(&home, &[&shut]), &SystemMachine);
        std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(kinds(&health), ["missing", "unreadable"], "{health:#?}");
    }

    #[test]
    fn an_existing_state_file_is_checked_without_changing_it() {
        let (_keep, home) = real_home();
        let file = home.join(".claude.json");
        std::fs::write(&file, "{}").unwrap();
        let before = std::fs::metadata(&file).unwrap().modified().unwrap();
        let look = SystemMachine.folder(&file.to_string_lossy(), FolderKind::File);
        assert!(look.exists && look.writable && look.owned == Some(true));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{}");
        assert_eq!(std::fs::metadata(&file).unwrap().modified().unwrap(), before);
    }

    /// R0 C4. A truncated Mach-O (here `/bin/ls`'s first 4 KB) is refused at
    /// spawn as malformed (os error 88); one whole but with a byte changed
    /// (its arm64e slice, so its code signature no longer matches) starts
    /// and is killed by macOS with SIGKILL. Both are a broken binary.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn broken_mach_o_files_are_bad_binaries() {
        let (_keep, home) = real_home();
        let ls = std::fs::read("/bin/ls").unwrap();
        let cut = home.join("cut");
        let changed = home.join("changed");
        std::fs::create_dir(&cut).unwrap();
        std::fs::create_dir(&changed).unwrap();
        let mut slice = arm64e_slice(&ls).expect("an arm64e slice in /bin/ls");
        let middle = slice.len() / 2;
        slice[middle] ^= 0xff;
        for (file, bytes) in [(cut.join("claude"), &ls[..4096]), (changed.join("claude"), &slice[..])] {
            std::fs::write(&file, bytes).unwrap();
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let health = inspect(CliTool::Claude, &inputs(&home, &[&cut, &changed]), &SystemMachine);
        let starts: Vec<&CopyStart> = health.copies.iter().map(|c| c.start.as_ref().unwrap()).collect();
        assert_eq!(starts[0].failure, Some(StartFailure::BadBinary), "{health:#?}");
        assert!(starts[0].tail.as_deref().is_some_and(|t| t.contains("os error 88")), "{health:#?}");
        assert_eq!(starts[1].failure, Some(StartFailure::BadBinary), "{health:#?}");
        assert_eq!(starts[1].signal, Some(9), "{health:#?}");
        assert_eq!(kinds(&health), ["noWorkingCopy", "doesNotStart", "doesNotStart", "several"]);
    }

    /// The arm64e slice of a universal Mach-O (`fat_header`, big-endian).
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
}

/// R9 (the sandbox run): a tool the snapshot didn't find and the disk
/// doesn't have is missing, not a stale cached path.
#[test]
fn nothing_cached_and_nothing_on_disk_is_only_missing() {
    let health = inspect(CliTool::Claude, &cached(mac("/Users/u/.local/bin:/usr/bin"), None), &Fake::default());
    assert_eq!(kinds(&health), ["missing"]);
    // Something on disk the snapshot doesn't know of is stale.
    let fake = Fake::default().link(NATIVE_LINK, NATIVE).prints(NATIVE_LINK, "2.1.0");
    let health = inspect(CliTool::Claude, &cached(mac("/Users/u/.local/bin"), None), &fake);
    assert!(kinds(&health).contains(&"cachedStale"));
}

