//! 1.176.0 R5: the automatic Codex update — its pure decisions (busy, due,
//! which command, why not, the verdict, the notice), its gate against Codex
//! starts, and the update process against fake updaters (moved here from
//! `commands.rs` with the updater, and extended).

use super::*;
use crate::cli_health::{CachedCheck, CliCopy, CopyStart, FolderCheck, FolderKind, FolderRole};
use std::time::{Duration, Instant};

// ── Fixtures ───────────────────────────────────────────────────────────

fn starts(version: &str) -> CopyStart {
    CopyStart {
        starts: true,
        version: Some(version.into()),
        failure: None,
        inconclusive: false,
        exit_code: Some(0),
        signal: None,
        tail: None,
    }
}

fn copy(path: &str, real: &str, channel: InstallChannel) -> CliCopy {
    CliCopy {
        path: path.into(),
        also_at: Vec::new(),
        real_path: Some(real.into()),
        dangling: false,
        unreadable: false,
        link_target: None,
        link_end: Some(real.into()),
        path_rank: Some(0),
        in_install_dir: false,
        executable: true,
        owned_by_user: Some(true),
        folder_owned_by_user: Some(true),
        system_folder: false,
        channel,
        start: Some(starts("0.170.0")),
        starts_with_shell: None,
    }
}

fn folder(path: &str, writable: bool, needed_now: bool) -> FolderCheck {
    FolderCheck {
        path: path.into(),
        kind: FolderKind::Dir,
        role: FolderRole::InstallTarget,
        channel: InstallChannel::Standalone,
        needed_now,
        system_folder: false,
        exists: true,
        checked: Some(path.into()),
        owned_by_user: Some(writable),
        writable,
    }
}

fn health(copy: CliCopy) -> CliHealth {
    CliHealth {
        tool: CliTool::Codex,
        healthy: true,
        runs_today: Some(copy.path.clone()),
        should_run: Some(copy.path.clone()),
        install_dir: None,
        cached: Some(CachedCheck {
            path: Some(copy.path.clone()),
            runs: Some(copy.path.clone()),
            exists: true,
            executable: true,
            usable: true,
            now: Some(copy.path.clone()),
            matches_now: true,
        }),
        copies: vec![copy],
        folders: vec![folder("/Users/u/.codex", true, true)],
        findings: Vec::new(),
        passed_over: None,
    }
}

const MAC_STANDALONE: &str = "/Users/u/.local/bin/codex";
const MAC_STANDALONE_REAL: &str = "/Users/u/.codex/packages/standalone/releases/0.170.0-aarch64-apple-darwin/bin/codex";
const MAC_NPM: &str = "/Users/u/.npm-global/bin/codex";
const MAC_NPM_REAL: &str = "/Users/u/.npm-global/lib/node_modules/@openai/codex/bin/codex.js";

fn mac_facts() -> PlanFacts {
    PlanFacts {
        windows: false,
        codex: Some(MAC_STANDALONE.into()),
        npm: Some("/Users/u/.npm-global/bin/npm".into()),
        brew: Some("/opt/homebrew/bin/brew".into()),
        ..PlanFacts::default()
    }
}

fn win_facts() -> PlanFacts {
    PlanFacts {
        windows: true,
        codex: Some(r"C:\Users\u\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe".into()),
        npm: Some(r"C:\Program Files\nodejs\npm.cmd".into()),
        powershell: Some(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe".into()),
        ..PlanFacts::default()
    }
}

/// A disk where every file exists and every folder is writable, unless told.
#[derive(Default)]
struct FakeDisk {
    missing: Vec<String>,
    locked: Vec<String>,
    cache: Option<String>,
}

impl Disk for FakeDisk {
    fn exists(&self, path: &str) -> bool {
        !self.missing.iter().any(|m| m == path)
    }
    fn writable(&self, path: &str) -> bool {
        !self.locked.iter().any(|l| l == path)
    }
    fn npm_cache(&self) -> Option<String> {
        self.cache.clone()
    }
    fn update_writable(&self, path: &str) -> Option<bool> {
        Some(self.writable(path))
    }
}

fn run_of(plan: Plan) -> UpdateCommand {
    match plan {
        Plan::Run(cmd) => cmd,
        other => panic!("expected a run, got {other:?}"),
    }
}

// ── Busy ───────────────────────────────────────────────────────────────

#[test]
fn any_codex_process_or_setup_run_makes_it_busy() {
    assert_eq!(busy_reason(&Live::default()), None);
    assert_eq!(busy_reason(&Live { codex_sessions: 1, ..Live::default() }), Some(Busy::CodexRunning));
    assert_eq!(busy_reason(&Live { setup_running: true, ..Live::default() }), Some(Busy::SetupRunning));
    // Card R4's Setup or Repair run of Codex: its own term.
    assert_eq!(busy_reason(&Live { repair_running: true, ..Live::default() }), Some(Busy::RepairRunning));
    // Busy is an answer the window can read, not an error string.
    let value = serde_json::to_value(Attempt::Busy { reason: Busy::CodexStarting }).unwrap();
    assert_eq!(value["kind"], "busy");
    assert_eq!(value["reason"], "codex-starting");
}

// ── Due ────────────────────────────────────────────────────────────────

fn at(rfc: &str) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(rfc).unwrap().with_timezone(&chrono::Utc)
}

fn kept(action: &str, finished: &str) -> LastRun {
    LastRun { action_id: action.into(), finished_at: Some(finished.into()), ..LastRun::default() }
}

#[test]
fn no_record_is_due_and_a_day_spaces_the_attempts() {
    let now = at("2026-11-21T12:00:00Z");
    // A first launch, or one after R5 replaced the window's localStorage time.
    assert!(due(now, None));
    let auto = kept(ACTION_ID, "2026-11-21T01:00:00Z");
    assert!(!due(now, last_attempt(Some(&auto), None)));
    let auto = kept(ACTION_ID, "2026-11-20T11:59:00Z");
    assert!(due(now, last_attempt(Some(&auto), None)));
    // A clock set back by more than an hour doesn't hold it off for ever.
    let future = kept(ACTION_ID, "2026-12-30T00:00:00Z");
    assert!(due(now, last_attempt(Some(&future), None)));
}

#[test]
fn a_guided_codex_update_counts_and_other_runs_do_not() {
    let now = at("2026-11-21T12:00:00Z");
    let setup = kept("update.codex", "2026-11-21T10:00:00Z");
    assert!(!due(now, last_attempt(None, Some(&setup))));
    let login = kept("login.codex", "2026-11-21T10:00:00Z");
    assert!(due(now, last_attempt(None, Some(&login))));
    // The later of the two wins.
    let old_auto = kept(ACTION_ID, "2026-11-19T10:00:00Z");
    assert!(!due(now, last_attempt(Some(&old_auto), Some(&setup))));
    // An unreadable time reads as no attempt.
    let garbled = kept(ACTION_ID, "yesterday");
    assert!(due(now, last_attempt(Some(&garbled), None)));
}

#[test]
fn it_runs_only_after_a_quiet_spell() {
    assert!(!ready(true, Duration::from_secs(60), false));
    assert!(ready(true, IDLE_QUIET, false));
    assert!(!ready(false, IDLE_QUIET * 10, false));
    assert!(!ready(true, IDLE_QUIET * 10, true), "the feed's retry wait holds it");
}

// ── The record, old and new ────────────────────────────────────────────

#[test]
fn the_attempts_entry_sits_beside_codexs_own_and_an_older_file_still_reads() {
    let tmp = tempfile::tempdir().unwrap();
    // An R2 file: only the tools' entries.
    std::fs::write(
        tmp.path().join(crate::setup_last_run::FILE),
        r#"{"codex":{"actionId":"update.codex","finishedAt":"2026-11-21T10:00:00Z","outcome":"succeeded"}}"#,
    )
    .unwrap();
    let runs = crate::setup_last_run::load(tmp.path());
    assert!(runs.get(RECORD_KEY).is_none());
    assert!(last_attempt(None, runs.get("codex")).is_some());

    let attempt = kept(ACTION_ID, "2026-11-21T11:00:00Z");
    crate::setup_last_run::record_key(tmp.path(), RECORD_KEY, attempt.clone()).unwrap();
    let runs = crate::setup_last_run::load(tmp.path());
    assert_eq!(runs.get(RECORD_KEY), Some(&attempt));
    assert_eq!(runs.get("codex").map(|r| r.action_id.as_str()), Some("update.codex"), "Setup's entry is kept");
    // An older build's reader sees an object of entries and reads them all.
    let raw: serde_json::Value =
        serde_json::from_slice(&std::fs::read(tmp.path().join(crate::setup_last_run::FILE)).unwrap()).unwrap();
    assert_eq!(raw[RECORD_KEY]["actionId"], ACTION_ID);
    assert_eq!(crate::setup_last_run::parse(&std::fs::read(tmp.path().join(crate::setup_last_run::FILE)).unwrap()).unwrap().len(), 2);
}

// ── Which command, or why none ─────────────────────────────────────────

#[test]
fn a_standalone_mac_install_runs_codex_update_through_the_copy_tiles_run() {
    let h = health(copy(MAC_STANDALONE, MAC_STANDALONE_REAL, InstallChannel::Standalone));
    let cmd = run_of(plan(&h, &mac_facts(), Some("0.170.0"), Some("0.171.0"), &FakeDisk::default()));
    assert_eq!(cmd.argv, vec![MAC_STANDALONE.to_string(), "update".to_string()]);
    assert_eq!(cmd.display, "codex update");
    assert!(cmd.env.contains(&("CODEX_NON_INTERACTIVE".into(), "1".into())));
    assert!(!cmd.env.iter().any(|(k, _)| k == "npm_config_prefix"));
}

#[test]
fn an_npm_install_pins_the_prefix_it_was_installed_in() {
    let h = health(copy(MAC_NPM, MAC_NPM_REAL, InstallChannel::Npm));
    // The PATH's npm is another prefix's: the prefix's own is used.
    let facts = PlanFacts { npm: Some("/opt/homebrew/bin/npm".into()), ..mac_facts() };
    let cmd = run_of(plan(&h, &facts, Some("0.170.0"), Some("0.171.0"), &FakeDisk::default()));
    assert_eq!(cmd.argv[0], "/Users/u/.npm-global/bin/npm");
    assert_eq!(&cmd.argv[1..], ["install", "-g", "@openai/codex@latest", "--no-fund", "--no-audit"]);
    assert!(cmd.env.contains(&("npm_config_prefix".into(), "/Users/u/.npm-global".into())));
    assert_eq!(cmd.path_first.as_deref(), Some("/Users/u/.npm-global/bin"), "its node first on PATH");
    assert_eq!(cmd.replaces, vec!["/Users/u/.npm-global/lib/node_modules/@openai/codex".to_string()]);
    // No npm in the prefix: the PATH's, with nothing put first.
    let disk = FakeDisk { missing: vec!["/Users/u/.npm-global/bin/npm".into()], ..FakeDisk::default() };
    let cmd = run_of(plan(&h, &facts, Some("0.170.0"), Some("0.171.0"), &disk));
    assert_eq!(cmd.argv[0], "/opt/homebrew/bin/npm");
    assert_eq!(cmd.path_first, None);
    // No npm at all: nothing runs.
    let none = PlanFacts { npm: None, ..mac_facts() };
    assert_eq!(plan(&h, &none, Some("0.170.0"), Some("0.171.0"), &disk), Plan::Skip(Skip::NoNpm));
    // npm's cache can't be written (a `sudo npm` once): skipped, not run.
    let cache = FakeDisk { cache: Some("/Users/u/.npm".into()), locked: vec!["/Users/u/.npm".into()], ..FakeDisk::default() };
    assert_eq!(plan(&h, &facts, Some("0.170.0"), Some("0.171.0"), &cache), Plan::Skip(Skip::NotWritable));
}

#[test]
fn npm_prefixes_come_from_the_package_folder() {
    assert_eq!(npm_prefix_of("/usr/local/lib/node_modules/@openai", false).as_deref(), Some("/usr/local"));
    assert_eq!(
        npm_prefix_of(r"C:\Users\u\AppData\Roaming\npm\node_modules\@openai", true).as_deref(),
        Some(r"C:\Users\u\AppData\Roaming\npm")
    );
    assert_eq!(npm_prefix_of("/somewhere/else", false), None);
    assert_eq!(npm_prefix_of("/lib/node_modules/@openai", false), None, "no prefix left");
}

#[test]
fn homebrew_winget_and_unknown_installs_are_left_to_the_update_row() {
    let brew = health(copy("/opt/homebrew/bin/codex", "/opt/homebrew/Caskroom/codex/0.170.0/codex", InstallChannel::Homebrew));
    assert_eq!(plan(&brew, &mac_facts(), Some("0.170.0"), Some("0.171.0"), &FakeDisk::default()), Plan::Skip(Skip::Homebrew));
    let winget = health(copy(
        r"C:\Users\u\AppData\Local\Microsoft\WinGet\Links\codex.exe",
        r"C:\Users\u\AppData\Local\Microsoft\WinGet\Packages\OpenAI.Codex\codex.exe",
        InstallChannel::Winget,
    ));
    assert_eq!(plan(&winget, &win_facts(), Some("0.170.0"), Some("0.171.0"), &FakeDisk::default()), Plan::Skip(Skip::Winget));
    let bun = health(copy("/Users/u/.bun/bin/codex", "/Users/u/.bun/install/global/node_modules/@openai/codex/bin/codex.js", InstallChannel::Bun));
    assert_eq!(plan(&bun, &mac_facts(), Some("0.170.0"), Some("0.171.0"), &FakeDisk::default()), Plan::Skip(Skip::UnknownChannel));
    // A copy cli_health calls standalone that the doctor wouldn't update the
    // same way: nothing runs.
    let odd = health(copy(MAC_STANDALONE, "/opt/homebrew/Cellar/codex/0.170.0/bin/codex", InstallChannel::Standalone));
    assert_eq!(plan(&odd, &mac_facts(), Some("0.170.0"), Some("0.171.0"), &FakeDisk::default()), Plan::Skip(Skip::UnknownChannel));
}

#[test]
fn windows_standalone_runs_the_installer_through_powershell() {
    let h = health(copy(
        r"C:\Users\u\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe",
        r"C:\Users\u\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe",
        InstallChannel::Standalone,
    ));
    let cmd = run_of(plan(&h, &win_facts(), Some("0.170.0"), Some("0.171.0"), &FakeDisk::default()));
    assert!(cmd.argv[0].ends_with("powershell.exe"));
    assert_eq!(cmd.argv.last().map(String::as_str), Some(crate::doctor::CODEX_WINDOWS_INSTALL));
    let facts = PlanFacts { powershell: None, ..win_facts() };
    assert_eq!(plan(&h, &facts, Some("0.170.0"), Some("0.171.0"), &FakeDisk::default()), Plan::Skip(Skip::NoPowershell));
}

#[test]
fn a_codex_that_does_not_start_is_never_updated_through_itself() {
    let mut broken = copy(MAC_STANDALONE, MAC_STANDALONE_REAL, InstallChannel::Standalone);
    broken.start = Some(CopyStart { starts: false, version: None, inconclusive: false, exit_code: Some(137), ..starts("x") });
    assert_eq!(plan(&health(broken.clone()), &mac_facts(), None, Some("0.171.0"), &FakeDisk::default()), Plan::Skip(Skip::NotStarting));
    broken.start = None;
    assert_eq!(plan(&health(broken.clone()), &mac_facts(), None, Some("0.171.0"), &FakeDisk::default()), Plan::Skip(Skip::NotStarting));
    broken.start = Some(CopyStart { starts: false, version: None, inconclusive: true, ..starts("x") });
    assert_eq!(plan(&health(broken), &mac_facts(), None, Some("0.171.0"), &FakeDisk::default()), Plan::Skip(Skip::StartUnknown));
    let mut none = health(copy(MAC_STANDALONE, MAC_STANDALONE_REAL, InstallChannel::Standalone));
    none.runs_today = None;
    assert_eq!(plan(&none, &mac_facts(), Some("0.170.0"), Some("0.171.0"), &FakeDisk::default()), Plan::Skip(Skip::NotFound));
}

#[test]
fn a_stale_path_or_a_folder_it_cannot_write_skips_it() {
    let mut stale = health(copy(MAC_STANDALONE, MAC_STANDALONE_REAL, InstallChannel::Standalone));
    stale.cached.as_mut().unwrap().matches_now = false;
    assert_eq!(plan(&stale, &mac_facts(), Some("0.170.0"), Some("0.171.0"), &FakeDisk::default()), Plan::Skip(Skip::NotWhatTilesRun));

    // R4's rule for Setup's Update (`update_folders_writable` of the copy
    // Plyloft runs), reused: a folder its updater writes is locked.
    let h = health(copy(MAC_STANDALONE, MAC_STANDALONE_REAL, InstallChannel::Standalone));
    let locked = FakeDisk { locked: vec![MAC_STANDALONE.into()], ..FakeDisk::default() };
    assert_eq!(plan(&h, &mac_facts(), Some("0.170.0"), Some("0.171.0"), &locked), Plan::Skip(Skip::NotWritable));
    assert!(matches!(plan(&h, &mac_facts(), Some("0.170.0"), Some("0.171.0"), &FakeDisk::default()), Plan::Run(_)));
    // R4's choose_copy: Plyloft runs a later copy on purpose when the first
    // on PATH doesn't start — not stale.
    let mut chosen = health(copy(MAC_STANDALONE, MAC_STANDALONE_REAL, InstallChannel::Standalone));
    chosen.cached.as_mut().unwrap().matches_now = false;
    chosen.passed_over = Some(crate::shell_env::PassedOver {
        path: MAC_NPM.into(),
        instead: MAC_STANDALONE.into(),
        kept_by_override: false,
    });
    assert!(matches!(plan(&chosen, &mac_facts(), Some("0.170.0"), Some("0.171.0"), &FakeDisk::default()), Plan::Run(_)));
    chosen.cached.as_mut().unwrap().usable = false;
    assert_eq!(plan(&chosen, &mac_facts(), Some("0.170.0"), Some("0.171.0"), &FakeDisk::default()), Plan::Skip(Skip::NotWhatTilesRun));
}

#[test]
fn nothing_runs_when_the_feed_has_nothing_newer_or_did_not_answer() {
    let h = health(copy(MAC_STANDALONE, MAC_STANDALONE_REAL, InstallChannel::Standalone));
    assert_eq!(plan(&h, &mac_facts(), Some("0.171.0"), Some("0.171.0"), &FakeDisk::default()), Plan::NothingNewer);
    assert_eq!(plan(&h, &mac_facts(), Some("0.172.0"), Some("0.171.0"), &FakeDisk::default()), Plan::NothingNewer);
    assert_eq!(plan(&h, &mac_facts(), Some("0.170.0"), None, &FakeDisk::default()), Plan::NoLatest);
}

#[test]
fn the_update_gets_local_bin_on_its_path() {
    assert_eq!(path_for_run("/usr/bin:/bin", Some("/Users/u"), None, false), "/usr/bin:/bin:/Users/u/.local/bin");
    assert_eq!(path_for_run("/Users/u/.local/bin:/usr/bin", Some("/Users/u"), None, false), "/Users/u/.local/bin:/usr/bin");
    assert_eq!(path_for_run("/usr/bin", None, None, false), "/usr/bin");
    assert_eq!(path_for_run("/usr/bin", None, Some("/p/bin"), false), "/p/bin:/usr/bin");
    assert_eq!(path_for_run(r"C:\Windows", Some(r"C:\Users\u"), Some(r"C:\npm"), true), r"C:\npm;C:\Windows");
}

// ── The verdict and the notice ─────────────────────────────────────────

fn ran(exit: Option<i32>) -> UpdateRun {
    UpdateRun { exit_code: exit, ..UpdateRun::default() }
}

fn lines(text: &[&str]) -> Vec<String> {
    text.iter().map(|l| l.to_string()).collect()
}

#[test]
fn the_verdict_follows_r2s_evidence() {
    let none: Vec<String> = Vec::new();
    let j = judge(&ran(Some(0)), &none, Some("0.170.0"), Some("0.171.0"), true, true);
    assert_eq!((j.outcome, j.cause), (Outcome::Succeeded, None));
    // A clean exit with the old version, nothing claimed: it ran only
    // because a newer one was known, so it is still on the old version
    // (never a silent no-op repeated daily).
    let j = judge(&ran(Some(0)), &none, Some("0.170.0"), Some("0.170.0"), true, true);
    assert_eq!(j.outcome, Outcome::StillOnOldVersion);
    let j = judge(&ran(Some(0)), &none, Some("0.170.0"), Some("0.170.0"), true, false);
    assert_eq!(j.outcome, Outcome::StillOnOldVersion);
    // R0 X4: `ln: … Permission denied`, exit 1, old version still answers.
    let tail = lines(&["ln: /Users/u/.codex/packages/standalone/.current.597: Permission denied"]);
    let j = judge(&ran(Some(1)), &tail, Some("0.170.0"), Some("0.170.0"), true, true);
    assert_eq!(j.outcome, Outcome::StillOnOldVersion);
    assert_eq!(j.cause, Some(Cause::Permissions));
    assert!(j.cause_path.is_some());
    // A lower version answers now.
    let j = judge(&ran(Some(1)), &none, Some("0.171.0"), Some("0.160.0"), true, false);
    assert_eq!(j.outcome, Outcome::OlderVersionNow);
}

#[test]
fn a_codex_that_does_not_start_afterwards_is_a_failure_whatever_it_exited_with() {
    let j = judge(&ran(Some(0)), &[], Some("0.170.0"), None, false, true);
    assert_eq!(j.outcome, Outcome::Failed);
    assert!(!j.starts);
    let timed = UpdateRun { timed_out: true, ..UpdateRun::default() };
    let j = judge(&timed, &[], Some("0.170.0"), Some("0.170.0"), true, true);
    assert_eq!((j.outcome, j.cause), (Outcome::TimedOut, Some(Cause::TimedOut)));
    let stopped = UpdateRun { cancelled: true, ..UpdateRun::default() };
    assert_eq!(judge(&stopped, &[], Some("0.170.0"), Some("0.170.0"), true, true).outcome, Outcome::Cancelled);
}

#[test]
fn the_timeout_line_names_the_command_that_ran_never_npm_for_a_standalone() {
    let standalone = timeout_line("codex update", TIMEOUT);
    assert!(standalone.contains("`codex update`") && standalone.contains("15 minutes"), "{standalone}");
    assert!(!standalone.contains("npm"), "{standalone}");
    let npm = timeout_line("npm install -g @openai/codex@latest", TIMEOUT);
    assert!(npm.contains("npm install -g @openai/codex@latest"), "{npm}");
    let windows = timeout_line(crate::doctor::CODEX_WINDOWS_INSTALL, TIMEOUT);
    assert!(windows.contains("install.ps1") && !windows.contains("npm"), "{windows}");
}

#[test]
fn a_failure_on_the_old_version_is_told_once_per_version_and_cause() {
    let tail = lines(&["curl: (6) Could not resolve host: chatgpt.com"]);
    let j = judge(&ran(Some(1)), &tail, Some("0.170.0"), Some("0.170.0"), true, true);
    assert_eq!(j.cause, Some(Cause::Network));
    assert_eq!(notice(&j, Some("0.170.0"), Some("0.170.0"), None), Some(Notice::StillWorks));
    let previous = LastRun {
        action_id: ACTION_ID.into(),
        outcome: Some("still-on-old-version".into()),
        cause: Some("network".into()),
        version_before: Some("0.170.0".into()),
        ..LastRun::default()
    };
    assert_eq!(notice(&j, Some("0.170.0"), Some("0.170.0"), Some(&previous)), None, "said once");
    // Another cause, or another version, is new.
    let other_cause = LastRun { cause: Some("disk-full".into()), ..previous.clone() };
    assert_eq!(notice(&j, Some("0.170.0"), Some("0.170.0"), Some(&other_cause)), Some(Notice::StillWorks));
    let other_version = LastRun { version_before: Some("0.169.0".into()), ..previous.clone() };
    assert_eq!(notice(&j, Some("0.170.0"), Some("0.170.0"), Some(&other_version)), Some(Notice::StillWorks));
    // Setup's own run in between isn't the automatic one: told again.
    let setup = LastRun { action_id: "update.codex".into(), ..previous };
    assert_eq!(notice(&j, Some("0.170.0"), Some("0.170.0"), Some(&setup)), Some(Notice::StillWorks));
}

#[test]
fn success_is_quiet_unless_a_newer_version_runs_and_not_starting_is_always_told() {
    let none: Vec<String> = Vec::new();
    let updated = judge(&ran(Some(0)), &none, Some("0.170.0"), Some("0.171.0"), true, true);
    assert_eq!(notice(&updated, Some("0.170.0"), Some("0.171.0"), None), Some(Notice::Updated));
    let nothing = Judged { outcome: Outcome::NothingNewer, cause: None, cause_path: None, starts: true };
    assert_eq!(notice(&nothing, Some("0.170.0"), Some("0.170.0"), None), None);
    // The same version after a clean run: told once, as any old-version failure.
    let same = judge(&ran(Some(0)), &none, Some("0.170.0"), Some("0.170.0"), true, true);
    assert_eq!(notice(&same, Some("0.170.0"), Some("0.170.0"), None), Some(Notice::StillWorks));
    let broken = judge(&ran(Some(0)), &none, Some("0.170.0"), None, false, true);
    let previous = LastRun { action_id: ACTION_ID.into(), outcome: Some("failed".into()), ..LastRun::default() };
    assert_eq!(notice(&broken, Some("0.170.0"), None, Some(&previous)), Some(Notice::NotStarting));
    let stopped = Judged { outcome: Outcome::Cancelled, cause: None, cause_path: None, starts: true };
    assert_eq!(notice(&stopped, None, None, None), None);
}

// ── The gate ───────────────────────────────────────────────────────────

#[test]
fn the_update_refuses_while_codex_starts_runs_or_updates() {
    let gate = Gate::new();
    // A start a moment ago: its session may not be registered yet.
    gate.before_start(false, Duration::ZERO, false);
    assert_eq!(gate.begin(Instant::now(), || None).err(), Some(Busy::CodexStarting));
    let later = Instant::now() + START_GRACE + Duration::from_secs(1);
    // A live session, asked after the gate is taken; the gate is let go.
    assert_eq!(gate.begin(later, || Some(Busy::CodexRunning)).err(), Some(Busy::CodexRunning));
    assert!(!gate.updating());
    let ticket = gate.begin(later, || None).expect("idle");
    assert!(gate.updating());
    assert_eq!(gate.begin(later, || None).err(), Some(Busy::Updating));
    drop(ticket);
    assert!(!gate.updating());
}

#[test]
fn a_tile_start_waits_for_the_update_and_then_goes() {
    let gate: &'static Gate = Box::leak(Box::new(Gate::new()));
    let ticket = gate.begin(Instant::now(), || None).unwrap();
    let waiter = std::thread::spawn(move || {
        let started = Instant::now();
        (gate.before_start(true, Duration::from_secs(20), false), started.elapsed())
    });
    std::thread::sleep(Duration::from_millis(300));
    assert!(!waiter.is_finished(), "the start waits while the update runs");
    drop(ticket);
    let (how, waited) = waiter.join().unwrap();
    assert_eq!(how, StartWait::Waited);
    assert!(waited >= Duration::from_millis(250) && waited < Duration::from_secs(10), "{waited:?}");
}

#[test]
fn past_its_limit_a_mac_start_goes_ahead_and_a_windows_start_stops_the_update() {
    let gate = Gate::new();
    let ticket = gate.begin(Instant::now(), || None).unwrap();
    // macOS: a running Codex survives the update (R0 X8).
    assert_eq!(gate.before_start(true, Duration::from_millis(100), false), StartWait::WaitedTheLimit);
    assert!(!ticket.cancel.load(Ordering::SeqCst));
    // A start that can't wait goes ahead at once.
    assert_eq!(gate.before_start(false, START_WAIT, false), StartWait::WentAhead);
    assert!(!ticket.cancel.load(Ordering::SeqCst));
    // Windows: the update is stopped so the start doesn't race a locked file.
    assert_eq!(gate.before_start(false, START_WAIT, true), StartWait::WentAhead);
    assert!(ticket.cancel.load(Ordering::SeqCst));
    drop(ticket);
    assert_eq!(gate.before_start(true, START_WAIT, true), StartWait::Clear);
}

#[test]
fn quitting_stops_the_update_and_refuses_the_next() {
    let gate = Gate::new();
    let ticket = gate.begin(Instant::now() + START_GRACE * 2, || None).unwrap();
    assert!(gate.shutdown());
    assert!(ticket.cancel.load(Ordering::SeqCst));
    drop(ticket);
    assert_eq!(gate.begin(Instant::now() + START_GRACE * 2, || None).err(), Some(Busy::Quitting));
}

// ── Wiring (read from the source, as `lib.rs`'s exit tests do) ────────

fn body_of<'a>(src: &'a str, signature: &str) -> &'a str {
    let start = src.find(signature).unwrap_or_else(|| panic!("{signature}"));
    let end = start + src[start..].find("\n}\n").expect("its end");
    &src[start..end]
}

/// A method's body (four-space indented `impl` member).
fn body_of_method<'a>(src: &'a str, signature: &str) -> &'a str {
    let start = src.find(signature).unwrap_or_else(|| panic!("{signature}"));
    let end = start + src[start..].find("\n    }\n").expect("its end");
    &src[start..end]
}

/// Every PTY spawn that takes a `SpawnIntent` reaches `begin_coordination`
/// (itself, or through the spawn it hands on to): a Builder's, intake's or
/// reviewer's Codex can't start beside the gate.
#[test]
fn every_pty_spawn_with_an_intent_passes_the_gate() {
    let pty = include_str!("pty.rs");
    let production = &pty[..pty.find("\n#[cfg(test)]\nmod").unwrap_or(pty.len())];
    let mut checked = 0;
    for (at, _) in production.match_indices("    pub fn ").chain(production.match_indices("    fn ")).chain(production.match_indices("    pub(crate) fn ")) {
        let rest = &production[at..];
        let signature_end = rest.find('{').unwrap_or(rest.len());
        if !rest[..signature_end].contains("intent: crate::coordination::SpawnIntent") {
            continue;
        }
        let name = &rest[..rest.find('(').unwrap()];
        if name.contains("begin_coordination") {
            continue;
        }
        let body = &rest[..rest.find("\n    }\n").unwrap_or(rest.len())];
        assert!(
            ["self.begin_coordination(", "self.spawn_tile(", "self.begin_collect("].iter().any(|via| body.contains(via)),
            "{name} spawns with an intent but never reaches begin_coordination"
        );
        checked += 1;
    }
    assert!(checked >= 5, "found only {checked} spawns: the scan is broken");
    // Builder and intake Codex starts are such spawns.
    assert!(include_str!("builder.rs").contains("crate::coordination::Provider::Codex"));
    assert!(include_str!("intake.rs").contains("PtyRegistry"));
}

#[test]
fn every_update_that_ran_is_followed_by_a_look_before_its_verdict() {
    let src = include_str!("codex_auto_update.rs");
    let body = body_of(src, "pub fn attempt<R: Runtime>(");
    let run = body.find("run_update_process(").unwrap();
    let look = body.find("cli_fresh::look_after_update(").unwrap();
    let quit = body.find("if GATE.closed()").unwrap();
    assert!(run < quit && quit < look, "a quit skips the look");
    let gate_let_go = look + body[look..].find("drop(ticket);").unwrap();
    let verdict = body.find("judge(&run").unwrap();
    assert!(run < look && look < gate_let_go && gate_let_go < verdict);
    // Nothing returns between the run and the look: a failed run is looked
    // at too (the run's own error becomes its output, not an early return).
    // Only the quit returns between the run and the look.
    assert_eq!(body[run..look].matches("return").count(), 1, "an early return skips the look");
    assert!(!body[run..look].contains('?'), "a `?` skips the look");
}

#[test]
fn the_exit_cleanup_stops_the_update_and_every_codex_start_meets_the_gate() {
    let lib = include_str!("lib.rs");
    assert!(body_of(lib, "fn run_exit_cleanup(").contains("codex_auto_update::shutdown()"));
    let fresh = include_str!("cli_fresh.rs");
    assert!(body_of(fresh, "pub(crate) fn fresh_env(").contains("Cli::Codex if ask.update_wait => match crate::codex_auto_update::before_codex_start(true)"));
    // Only the tile's own check (on a worker) waits.
    assert!(fresh.contains("TILE_CHECK: Ask = Ask { missing: true, unhealthy: true, update_wait: true }"));
    // ...and every real start meets it where it spawns.
    let pty = include_str!("pty.rs");
    assert!(body_of_method(pty, "fn begin_coordination(").contains("crate::codex_auto_update::before_codex_start(false)"));
    let app_server = include_str!("codex_app.rs");
    assert!(body_of_method(app_server, "pub(crate) fn start_with(").contains("crate::codex_auto_update::before_codex_start(false)"));
    // 1.176.2 (A5R-08): the model list's read is the one start that is left
    // out while an update runs, never one that stops it.
    let catalog = include_str!("model_catalog.rs");
    assert!(body_of(catalog, "fn read_codex(").contains("crate::codex_auto_update::codex_start_unless_updating()"));
    assert!(!catalog.contains("before_codex_start("));
    assert!(fresh.contains("TILE_SPAWN: Ask = Ask { missing: true, unhealthy: false, update_wait: false }"));
    assert!(fresh.contains("REQUIRE: Ask = Ask { missing: false, unhealthy: false, update_wait: false }"));
    // Setup never runs a Codex step beside it.
    assert!(include_str!("setup_run.rs").contains("crate::codex_auto_update::updating()"));
}

// ── The process (fake updaters) ────────────────────────────────────────

#[cfg(unix)]
fn write_script(path: &std::path::Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, body).expect("write script");
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).expect("chmod script");
}

/// GH #236, the #147 pre-warm: exec a fresh script once with no deadline
/// (macOS assesses a new executable on its first exec; ETXTBSY retried).
#[cfg(unix)]
fn prewarm(script: &std::path::Path) {
    loop {
        match crate::platform::new_command(script)
            .env("PLY_TEST_PREWARM", "1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
        {
            Ok(status) => {
                assert!(status.success(), "test setup failure: pre-warm: {status}");
                break;
            }
            Err(e) if e.raw_os_error() == Some(libc::ETXTBSY) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => panic!("test setup failure: pre-warm: {e}"),
        }
    }
}

#[cfg(unix)]
fn fake(script: &std::path::Path, env: Vec<(String, String)>) -> UpdateCommand {
    UpdateCommand {
        argv: vec![script.to_string_lossy().into_owned(), "update".into()],
        env,
        path_first: None,
        display: "codex update".into(),
        channel: InstallChannel::Standalone,
        replaces: Vec::new(),
    }
}

#[cfg(unix)]
fn path_of(tmp: &std::path::Path) -> String {
    format!("{}:/usr/bin:/bin", tmp.to_string_lossy())
}

#[cfg(unix)]
#[test]
fn update_with_chatty_output_does_not_deadlock_on_a_full_pipe() {
    // A real `codex update` downloads ~265 MB and reports progress. A pipe
    // holds ~64 KB: an updater that outruns it blocks forever unless both
    // streams are drained while it runs.
    let tmp = tempfile::tempdir().expect("tempdir");
    let script = tmp.path().join("chatty-update");
    write_script(
        &script,
        "#!/bin/sh\n[ -n \"$PLY_TEST_PREWARM\" ] && exit 0\nawk 'BEGIN { for (i = 0; i < 40000; i++) print \"downloading chunk\" i }'\nexit 0\n",
    );
    prewarm(&script);
    let started = Instant::now();
    let cancel = AtomicBool::new(false);
    let run = run_update_process(&fake(&script, Vec::new()), &path_of(tmp.path()), Duration::from_secs(60), &cancel, |_| {})
        .expect("it starts");
    assert!(!run.timed_out, "a chatty updater must complete, not time out");
    assert!(started.elapsed() < Duration::from_secs(30), "took {:?}: it blocked on the pipe", started.elapsed());
    assert!(run.stdout.contains("downloading chunk39999"));
}

#[cfg(unix)]
#[test]
fn a_failed_update_is_an_outcome_with_its_output_not_an_error() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let script = tmp.path().join("refused-update");
    write_script(
        &script,
        "#!/bin/sh\n[ -n \"$PLY_TEST_PREWARM\" ] && exit 0\necho \"prefix=$npm_config_prefix path=$PATH\"\necho 'ln: /Users/u/.local/bin/.codex.1: Permission denied' >&2\nexit 1\n",
    );
    prewarm(&script);
    let cancel = AtomicBool::new(false);
    let env = vec![("npm_config_prefix".to_string(), "/Users/u/.npm-global".to_string())];
    let run = run_update_process(&fake(&script, env), &path_of(tmp.path()), Duration::from_secs(60), &cancel, |_| {})
        .expect("a failure is an outcome");
    assert_eq!(run.exit_code, Some(1));
    assert!(!run.timed_out && !run.cancelled);
    assert!(run.stderr.contains("Permission denied"));
    // The pinned prefix and the PATH reach the updater.
    assert!(run.stdout.contains("prefix=/Users/u/.npm-global"), "{}", run.stdout);
    assert!(run.stdout.contains(&path_of(tmp.path())), "{}", run.stdout);
    let tail = crate::setup_run::tail_lines(format!("{}\n{}", run.stdout, run.stderr).as_bytes(), 60);
    let j = judge(&run, &tail, Some("0.170.0"), Some("0.170.0"), true, true);
    assert_eq!((j.outcome, j.cause), (Outcome::StillOnOldVersion, Some(Cause::Permissions)));
}

#[cfg(unix)]
fn read_pid(path: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let pid = raw.trim();
    (!pid.is_empty()).then(|| pid.to_string())
}

#[cfg(unix)]
fn alive(pid: &str) -> bool {
    crate::platform::new_command("/bin/kill")
        .args(["-0", pid])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// A fake updater that backgrounds a worker writing its pid, then sleeps.
#[cfg(unix)]
fn slow_updater(dir: &std::path::Path, name: &str, pid_file: &std::path::Path) -> std::path::PathBuf {
    let script = dir.join(name);
    // Output goes to /dev/null so a survivor cannot hold the pipes open.
    write_script(
        &script,
        &format!(
            "#!/bin/sh\nexec >/dev/null 2>&1\nsh -c 'echo $$ > \"{pid}\"; while :; do sleep 0.05; done' &\nwhile [ ! -s \"{pid}\" ]; do sleep 0.05; done\nsleep 60\n",
            pid = pid_file.to_string_lossy()
        ),
    );
    script
}

/// Judge every worker that started: none may outlive the stop.
#[cfg(unix)]
fn assert_no_survivor(pid_files: &[std::path::PathBuf]) {
    let worker_pids: Vec<String> = pid_files.iter().filter_map(|f| read_pid(f)).collect();
    assert!(!worker_pids.is_empty(), "test setup failure: the fake worker never started — the test proves nothing");
    let deadline = Instant::now() + Duration::from_secs(3);
    while worker_pids.iter().any(|p| alive(p)) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    let survivors: Vec<&String> = worker_pids.iter().filter(|p| alive(p)).collect();
    for pid in &survivors {
        let _ = crate::platform::new_command("/bin/kill").args(["-9", pid]).status();
    }
    assert!(survivors.is_empty(), "workers {survivors:?} survived — only the direct child was killed");
}

#[cfg(unix)]
#[test]
fn timed_out_update_kills_the_whole_process_tree() {
    // The 2026-08-30 breakage: killing only the direct child left the real
    // downloader running. GH #130: a worker that never started before the
    // timeout proves nothing, so such an attempt is retried, longer.
    let tmp = tempfile::tempdir().expect("tempdir");
    let mut pid_files = Vec::new();
    for (attempt, timeout_ms) in [1500u64, 5000, 15000].into_iter().enumerate() {
        let pid_file = tmp.path().join(format!("worker-{attempt}.pid"));
        let script = slow_updater(tmp.path(), &format!("slow-update-{attempt}"), &pid_file);
        let cancel = AtomicBool::new(false);
        let run = run_update_process(
            &fake(&script, Vec::new()),
            &path_of(tmp.path()),
            Duration::from_millis(timeout_ms),
            &cancel,
            |_| {},
        )
        .expect("it starts");
        assert!(run.timed_out, "must time out");
        pid_files.push(pid_file);
        if pid_files.last().is_some_and(|f| read_pid(f).is_some()) {
            break;
        }
    }
    assert_no_survivor(&pid_files);
}

#[cfg(unix)]
#[test]
fn a_stopped_update_leaves_no_child_behind() {
    // A Windows start past its wait, or Plyloft quitting, sets the flag.
    let tmp = tempfile::tempdir().expect("tempdir");
    let mut pid_files = Vec::new();
    for attempt in 0..3 {
        let pid_file = tmp.path().join(format!("stopped-{attempt}.pid"));
        let script = slow_updater(tmp.path(), &format!("stopped-update-{attempt}"), &pid_file);
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let watched = pid_file.clone();
        let stopper = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(15);
            while read_pid(&watched).is_none() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
            flag.store(true, Ordering::SeqCst);
        });
        let mut seen_pid = None;
        let run = run_update_process(
            &fake(&script, Vec::new()),
            &path_of(tmp.path()),
            Duration::from_secs(60),
            &cancel,
            |pid| seen_pid = Some(pid),
        )
        .expect("it starts");
        stopper.join().unwrap();
        assert!(run.cancelled && !run.timed_out);
        assert!(seen_pid.is_some(), "the gate is handed the pid");
        pid_files.push(pid_file);
        if pid_files.last().is_some_and(|f| read_pid(f).is_some()) {
            break;
        }
    }
    assert_no_survivor(&pid_files);
}

// ── Review round 1 ─────────────────────────────────────────────────────

#[test]
fn a_stopped_attempt_or_a_skip_that_clears_soon_does_not_use_up_the_day() {
    let now = at("2026-11-21T12:00:00Z");
    let stopped = LastRun { outcome: Some("cancelled".into()), ..kept(ACTION_ID, "2026-11-21T11:00:00Z") };
    assert!(!counts(&stopped));
    assert!(due(now, last_attempt(Some(&stopped), None)));
    for transient in ["start-unknown", "not-what-tiles-run"] {
        let skip = LastRun { outcome: Some("skipped".into()), cause: Some(transient.into()), ..kept(ACTION_ID, "2026-11-21T11:00:00Z") };
        assert!(!counts(&skip), "{transient}");
    }
    for stable in ["homebrew", "not-writable", "not-starting"] {
        let skip = LastRun { outcome: Some("skipped".into()), cause: Some(stable.into()), ..kept(ACTION_ID, "2026-11-21T11:00:00Z") };
        assert!(counts(&skip), "{stable}");
        assert!(!due(now, last_attempt(Some(&skip), None)));
    }
    for skip in Skip::ALL {
        assert_eq!(Skip::from_wire(&wire(&skip)), Some(skip));
    }
}

#[test]
fn a_stopped_update_is_retried_soon_then_not_before_the_next_day() {
    assert_eq!(retry_in(After::Stopped, 1), Some(Duration::from_secs(600)));
    assert_eq!(retry_in(After::Stopped, 2), Some(Duration::from_secs(1800)));
    assert_eq!(retry_in(After::Stopped, 3), Some(INTERVAL), "no download loop");
    assert_eq!(retry_in(After::Transient, 0), Some(TRANSIENT_RETRY));
    assert_eq!(retry_in(After::NoLatest, 0), Some(NO_LATEST_RETRY));
    assert_eq!(retry_in(After::Done, 0), None);
    assert_eq!(Attempt::Stopped.after(), After::Stopped);
    assert_eq!(Attempt::Skipped { reason: Skip::StartUnknown }.after(), After::Transient);
    assert_eq!(Attempt::Skipped { reason: Skip::Homebrew }.after(), After::Done);
}

#[test]
fn a_skip_kept_for_the_day_is_looked_at_again_when_codex_changed() {
    let skip = LastRun {
        outcome: Some("skipped".into()),
        cause: Some("not-writable".into()),
        cause_path: Some(MAC_STANDALONE.into()),
        version_before: Some("0.170.0".into()),
        ..kept(ACTION_ID, "2026-11-21T11:00:00Z")
    };
    assert!(!skip_facts_changed(Some(&skip), Some(MAC_STANDALONE), Some("0.170.0")));
    assert!(skip_facts_changed(Some(&skip), Some(MAC_NPM), Some("0.170.0")), "another copy");
    assert!(skip_facts_changed(Some(&skip), Some(MAC_STANDALONE), Some("0.171.0")), "updated by hand");
    let ran = LastRun { outcome: Some("succeeded".into()), ..skip };
    assert!(!skip_facts_changed(Some(&ran), Some(MAC_NPM), None));
}

#[test]
fn a_codex_start_between_two_looks_still_resets_the_idle_clock() {
    let t0 = Instant::now();
    let later = t0 + Duration::from_secs(120);
    assert_eq!(idle_since(t0, true, later, None), later);
    assert_eq!(idle_since(t0, false, later, None), t0);
    let start = t0 + Duration::from_secs(30);
    assert_eq!(idle_since(t0, false, later, Some(start)), start, "a session that came and went");
    assert_eq!(idle_since(later, false, later, Some(start)), later);
}

#[test]
fn windows_finds_a_codex_running_from_the_copy_to_replace() {
    let dirs = vec![r"C:\Users\u\AppData\Local\Programs\OpenAI\Codex\bin".to_string()];
    assert!(image_under(r"C:\Users\u\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe", &dirs));
    assert!(image_under(r"\\?\c:\users\u\appdata\local\programs\openai\codex\BIN\codex.EXE", &dirs));
    assert!(image_under("C:/Users/u/AppData/Local/Programs/OpenAI/Codex/bin/codex-exec-server.exe", &dirs));
    assert!(!image_under(r"C:\Users\u\AppData\Local\Programs\OpenAI\Codex\binary\codex.exe", &dirs));
    assert!(!image_under(r"C:\Windows\System32\cmd.exe", &dirs));
    assert!(!image_under(r"C:\x.exe", &[String::new()]));
    let npm = vec![r"C:\Users\u\AppData\Roaming\npm\node_modules\@openai\codex".to_string()];
    assert!(image_under(r"C:\Users\u\AppData\Roaming\npm\node_modules\@openai\codex\vendor\x86_64-pc-windows-msvc\codex\codex.exe", &npm));
    // The plan names what each channel replaces.
    let h = health(copy(
        r"C:\Users\u\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe",
        r"C:\Users\u\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe",
        InstallChannel::Standalone,
    ));
    let cmd = run_of(plan(&h, &win_facts(), Some("0.170.0"), Some("0.171.0"), &FakeDisk::default()));
    assert_eq!(cmd.replaces, dirs);
}

#[test]
fn another_plyloft_holding_the_lock_keeps_this_one_out_until_it_is_stale() {
    let now = at("2026-11-21T12:00:00Z");
    let fresh = r#"{"pid":42,"startedAt":"2026-11-21T11:55:00Z"}"#;
    assert!(!lock_is_stale(fresh, now, |_| true));
    assert!(lock_is_stale(fresh, now, |_| false), "its process is gone");
    assert!(lock_is_stale(r#"{"pid":42,"startedAt":"2026-11-21T11:00:00Z"}"#, now, |_| true), "older than an attempt can be");
    assert!(lock_is_stale("garbage", now, |_| true));

    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("lock");
    let first = AttemptLock::take(&path, |_| true).expect("free");
    assert!(AttemptLock::take(&path, |_| true).is_none(), "held by a live Plyloft");
    drop(first);
    assert!(!path.exists(), "let go");
    std::fs::write(&path, r#"{"pid":1,"startedAt":"2026-11-21T11:59:00Z"}"#).unwrap();
    let taken = AttemptLock::take(&path, |_| false).expect("a dead holder's lock is taken over");
    drop(taken);
}

#[test]
fn on_windows_a_start_that_cannot_wait_still_waits_for_the_stopped_update_to_end() {
    let gate: &'static Gate = Box::leak(Box::new(Gate::new()));
    let ticket = gate.begin(Instant::now(), || None).unwrap();
    let cancel = ticket.cancel.clone();
    // The update's side: it sees the stop, its tree ends, it lets go.
    let updater = std::thread::spawn(move || {
        while !cancel.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(10));
        }
        std::thread::sleep(Duration::from_millis(300));
        drop(ticket);
    });
    let started = Instant::now();
    assert_eq!(gate.before_start(false, START_WAIT, true), StartWait::WentAhead);
    assert!(!gate.updating(), "the start went only once the update had ended");
    assert!(started.elapsed() >= Duration::from_millis(250));
    updater.join().unwrap();
}

#[cfg(unix)]
#[test]
fn an_update_killed_from_outside_at_quit_is_stopped_not_failed() {
    // `shutdown` sets the flag and SIGKILLs the group itself: the watcher
    // may see the exit before the flag, which must still read as stopped.
    let tmp = tempfile::tempdir().expect("tempdir");
    let script = tmp.path().join("quit-update");
    write_script(&script, "#!/bin/sh\n[ -n \"$PLY_TEST_PREWARM\" ] && exit 0\nsleep 30\n");
    prewarm(&script);
    let gate: &'static Gate = Box::leak(Box::new(Gate::new()));
    let ticket = gate.begin(Instant::now(), || None).unwrap();
    let cancel = ticket.cancel.clone();
    let quitter = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        gate.shutdown()
    });
    let run = run_update_process(&fake(&script, Vec::new()), &path_of(tmp.path()), Duration::from_secs(60), &cancel, |pid| {
        ticket.set_pid(pid)
    })
    .expect("it starts");
    assert!(quitter.join().unwrap(), "an update was running");
    assert!(run.cancelled, "a quit is a stop");
    let j = judge(&run, &[], Some("0.170.0"), Some("0.170.0"), true, true);
    assert_eq!(j.outcome, Outcome::Cancelled);
    assert_eq!(notice(&j, None, None, None), None);
    let kept = LastRun { outcome: Some(wire(&j.outcome)), ..kept(ACTION_ID, "2026-11-21T11:00:00Z") };
    assert!(!counts(&kept), "and it doesn't use up the day");
    drop(ticket);
}

// ── Merged with R4 (the Repair engine) ─────────────────────────────────

#[test]
fn the_update_and_a_codex_repair_refuse_each_other() {
    // The update waits for a Setup or Repair run of Codex.
    assert_eq!(busy_reason(&Live { repair_running: true, ..Live::default() }), Some(Busy::RepairRunning));
    let src = include_str!("codex_auto_update.rs");
    assert!(body_of(src, "pub fn repair_running<R: Runtime>(").contains("crate::cli_repair_run::tool_run_active(app, tool)"));
    // A Repair step of Codex waits for the update; `verify` (a read) and
    // Claude's steps don't.
    use crate::cli_repair::StepKind;
    use crate::cli_repair_run::update_blocks_step;
    assert!(update_blocks_step(CliTool::Codex, StepKind::RunInstaller, true));
    assert!(!update_blocks_step(CliTool::Codex, StepKind::Verify, true));
    assert!(!update_blocks_step(CliTool::Claude, StepKind::RunInstaller, true));
    assert!(!update_blocks_step(CliTool::Codex, StepKind::RunInstaller, false));
    let runner = include_str!("cli_repair_run.rs");
    assert!(body_of(runner, "pub fn run_step<R: Runtime>(").contains("update_blocks_step(tool, step.kind(), crate::codex_auto_update::updating())"));
    // R4's session list names the update exactly while the gate is held.
    let gate = Gate::new();
    assert!(!gate.updating());
    let ticket = gate.begin(Instant::now(), || None).unwrap();
    assert!(gate.updating());
    drop(ticket);
    assert!(include_str!("cli_repair_sessions.rs").contains("crate::codex_auto_update::updating()"));
}

/// 1.176.2 R1: a tail cut at the cap starts at its first whole line, so the
/// decode never sees half a character; an uncut one is kept whole.
#[test]
fn a_cut_tail_starts_at_its_first_whole_line() {
    assert_eq!(whole_lines(b"\x8a riconosciuto\nnext\n", true), b"next\n");
    assert_eq!(whole_lines(b"\x8a riconosciuto\nnext\n", false), b"\x8a riconosciuto\nnext\n");
    assert_eq!(whole_lines(b"no newline", true), b"no newline");
    assert_eq!(whole_lines(b"", true), b"");
}

/// REV-R1 F5: a tail cut at the cap with no newline in it drops the half
/// character the cut left at its front, so the line stays valid UTF-8 and
/// is never read in the OEM code page whole.
#[test]
fn a_cut_tail_without_a_newline_drops_the_half_character_at_its_front() {
    let line = "è scaricato ☕ 100%".as_bytes();
    let cut = &line[1..]; // `è` is two bytes: the cut kept only its second.
    assert!(std::str::from_utf8(cut).is_err());
    assert_eq!(whole_lines(cut, true), " scaricato ☕ 100%".as_bytes());
    let decoded = crate::platform::decode_lines_with(whole_lines(cut, true), |_| Some("OEM".into()));
    assert_eq!(decoded, " scaricato ☕ 100%");
    // Three continuation bytes at most (a four-byte character cut after one).
    let crab = "🦀ok".as_bytes();
    assert_eq!(whole_lines(&crab[1..], true), b"ok");
    // An uncut buffer is never trimmed; a whole first character is kept.
    assert_eq!(whole_lines(&line[1..], false), &line[1..]);
    assert_eq!(whole_lines(line, true), line);
}

/// 1.176.2 (A5R-08): a model-list read during an update is left out: the
/// update isn't stopped (Windows' `stop`), and its idle clock isn't reset.
#[test]
fn a_skippable_start_never_stops_or_delays_a_running_update() {
    let gate = Gate::new();
    let ticket = gate.begin(Instant::now(), || None).unwrap();
    assert!(!gate.start_unless_updating());
    assert!(!ticket.cancel.load(Ordering::SeqCst), "the update keeps running");
    assert_eq!(gate.last_start(), None, "its idle clock is left alone");
    drop(ticket);
    // With no update running it is an ordinary start: recorded, so an update
    // can't begin under it (START_GRACE).
    assert!(gate.start_unless_updating());
    assert!(gate.last_start().is_some());
    assert_eq!(gate.begin(Instant::now(), || None).err(), Some(Busy::CodexStarting));
}
