//! 1.176.0 R9: the Repair engine end to end against the REAL official
//! installers, in a throwaway home, without the app.
//!
//! Every test is `#[ignore]`d and refuses to run unless the process HOME is
//! the sandbox `PLY_REPAIR_E2E_HOME` (a path containing `cli-repair-e2e`,
//! never the real home or above it). Run through `scripts/cli-repair-e2e.sh`:
//!
//!     cargo test --lib cli_repair_e2e -- --ignored --test-threads=1
//!
//! What runs is the engine's own code: `cli_health::inspect` (with the real
//! disk, or a layer over it that pretends a folder isn't the user's),
//! `cli_repair::plan`, `cli_repair_run::runnable`, the allowlist's argv
//! (`setup_actions::repair_*_plan`) and Plyloft's own steps
//! (`cli_repair_run::apply_own_step`, its real second look
//! `confirm_broken`). The snapshot is modelled by `shell_env::resolve_cli`
//! on the sandbox PATH, read again after every step as the app re-probes.
//!
//! Differences from the app, on purpose:
//! - Terminal steps run their exact argv and env as a plain bounded child
//!   (stdin closed), not in the Setup PTY: the runner needs an app handle.
//! - `sudo chown` is never run: ownership scenarios check the plan and argv.
//! - Nothing reads credentials: only the installers, `npm install/uninstall`
//!   with an explicit prefix and cache in the sandbox, `--version`,
//!   `codesign --verify` and file operations. Never `claude doctor`,
//!   `claude update`, `codex doctor`, `codex update`, `codex app-server`.
//! - Before and after each scenario the REAL install is fingerprinted
//!   (`~/.local/bin/{claude,codex,codex-code-mode-host}`, `~/.codex/packages/
//!   standalone/current`, Homebrew's and `/usr/local`'s global npm folders);
//!   any change fails loudly. The real `~/.claude.json` mtime is recorded
//!   and reported: a Claude Code session running on this Mac writes it.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::cli_health::{self as health, Cached, CliHealth, CliTool, FolderKind, FolderLook, Inputs, Look, Machine, RunOutcome};
use crate::cli_repair::{self as repair, Block, RepairContext, RepairPlan, StepAction, StepKind};
use crate::cli_repair_run as run;
use crate::setup_last_run::LastRun;

const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const SENTINEL: &[u8] = b"{\"sentinel\":\"must stay byte-identical\"}\n";

// ---------------------------------------------------------------- the sandbox

fn real_home() -> PathBuf {
    // SAFETY: getpwuid_r with a buffer this function owns; the real home of
    // this user, whatever HOME says.
    unsafe {
        let mut pwd: libc::passwd = std::mem::zeroed();
        let mut buf = vec![0 as libc::c_char; 4096];
        let mut out: *mut libc::passwd = std::ptr::null_mut();
        let rc = libc::getpwuid_r(libc::geteuid(), &mut pwd, buf.as_mut_ptr(), buf.len(), &mut out);
        assert!(rc == 0 && !out.is_null(), "no passwd entry");
        PathBuf::from(std::ffi::CStr::from_ptr(pwd.pw_dir).to_string_lossy().into_owned())
    }
}

struct Sandbox {
    /// `<home>/.e2e`: kept across scenarios (payload caches, the npm cache,
    /// the tools folder, TMPDIR), removed with the home at the end.
    root: PathBuf,
    home: PathBuf,
    real: PathBuf,
}

/// The sandbox, or a panic naming why it may not run.
fn sandbox() -> Sandbox {
    let home = std::env::var("PLY_REPAIR_E2E_HOME").expect("PLY_REPAIR_E2E_HOME is unset: refusing to run");
    let home = PathBuf::from(home);
    assert!(home.is_absolute(), "PLY_REPAIR_E2E_HOME must be absolute");
    assert!(home.to_string_lossy().contains("cli-repair-e2e"), "the sandbox must be under a path containing cli-repair-e2e");
    let real = real_home();
    assert!(home != real && !real.starts_with(&home), "the sandbox is the real home or above it: refusing");
    assert_eq!(std::env::var("HOME").ok().map(PathBuf::from), Some(home.clone()), "HOME must be the sandbox (use scripts/cli-repair-e2e.sh)");
    for var in ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"] {
        assert!(std::env::var_os(var).is_none(), "{var} must not be inherited");
    }
    let root = home.join(".e2e");
    Sandbox { root, home, real }
}

/// Owner bits back on everything under `path` (a 555 folder a scenario
/// left), then `path` removed.
fn wipe(path: &Path) {
    assert!(path.to_string_lossy().contains("cli-repair-e2e"), "only inside the sandbox");
    if std::fs::symlink_metadata(path).is_err() {
        return;
    }
    let mut stack = vec![path.to_path_buf()];
    while let Some(p) = stack.pop() {
        let Ok(meta) = std::fs::symlink_metadata(&p) else { continue };
        if meta.is_dir() {
            let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(meta.permissions().mode() | 0o700));
            if let Ok(entries) = std::fs::read_dir(&p) {
                stack.extend(entries.flatten().map(|e| e.path()));
            }
        }
    }
    if std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()) {
        std::fs::remove_dir_all(path).expect("remove inside the sandbox");
    } else {
        std::fs::remove_file(path).expect("remove inside the sandbox");
    }
}

impl Sandbox {
    fn reset(&self) {
        std::fs::create_dir_all(&self.home).unwrap();
        for entry in std::fs::read_dir(&self.home).unwrap().flatten() {
            if entry.file_name() != ".e2e" {
                wipe(&entry.path());
            }
        }
        for dir in [".claude", ".codex", ".local/bin"] {
            std::fs::create_dir_all(self.home.join(dir)).unwrap();
        }
        std::fs::write(self.home.join(".claude/e2e-sentinel.json"), SENTINEL).unwrap();
        std::fs::write(self.home.join(".codex/auth.json"), SENTINEL).unwrap();
        for dir in ["tmp", "npm-cache", "tools", "cache"] {
            std::fs::create_dir_all(self.root.join(dir)).unwrap();
        }
        // npm and node only (no other program of the real /usr/local/bin).
        for tool in ["node", "npm"] {
            let link = self.root.join("tools").join(tool);
            if std::fs::symlink_metadata(&link).is_err() {
                std::os::unix::fs::symlink(Path::new("/usr/local/bin").join(tool), &link).unwrap();
            }
        }
    }

    fn s(&self, rel: &str) -> String {
        self.home.join(rel).to_string_lossy().into_owned()
    }

    fn npm_prefix(&self) -> String {
        self.s(".npm-global")
    }

    /// The sandbox PATH: npm's bin first when `npm_first`, the installers'
    /// folder, the tools (node, npm), the system.
    fn path(&self, npm_first: bool) -> String {
        let npm = format!("{}/bin", self.npm_prefix());
        let local = self.s(".local/bin");
        let tools = self.root.join("tools").to_string_lossy().into_owned();
        let mut parts = Vec::new();
        if npm_first {
            parts.push(npm.clone());
        }
        parts.push(local);
        if !npm_first {
            parts.push(npm);
        }
        parts.extend([tools, "/usr/bin".into(), "/bin".into(), "/usr/sbin".into(), "/sbin".into()]);
        parts.join(":")
    }

    fn sentinels_intact(&self) -> bool {
        std::fs::read(self.home.join(".claude/e2e-sentinel.json")).ok().as_deref() == Some(SENTINEL)
            && std::fs::read(self.home.join(".codex/auth.json")).ok().as_deref() == Some(SENTINEL)
    }
}

// ---------------------------------------------------------------- the real install, watched

fn fingerprint(path: &Path) -> String {
    match std::fs::symlink_metadata(path) {
        Err(_) => format!("{}: absent", path.display()),
        Ok(meta) => {
            let link = std::fs::read_link(path).map(|t| t.display().to_string()).unwrap_or_default();
            let mtime = meta.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs());
            format!(
                "{}: mode {:o} len {} mtime {:?} -> {}",
                path.display(),
                meta.permissions().mode(),
                meta.len(),
                mtime,
                if link.is_empty() { "-".into() } else { link }
            )
        }
    }
}

fn listing(dir: &Path) -> String {
    match std::fs::read_dir(dir) {
        Err(_) => format!("{}: absent", dir.display()),
        Ok(entries) => {
            let mut names: Vec<String> = entries.flatten().map(|e| fingerprint(&e.path())).collect();
            names.sort();
            format!("{}: [{}]", dir.display(), names.join("; "))
        }
    }
}

/// What must not change, and what is only reported.
fn real_state(real: &Path) -> (Vec<String>, String) {
    let watched = vec![
        fingerprint(&real.join(".local/bin/claude")),
        fingerprint(&real.join(".local/bin/codex")),
        fingerprint(&real.join(".local/bin/codex-code-mode-host")),
        fingerprint(&real.join(".codex/packages/standalone/current")),
        listing(&real.join(".local/share/claude/versions")),
        listing(Path::new("/opt/homebrew/lib/node_modules/@anthropic-ai")),
        listing(Path::new("/opt/homebrew/lib/node_modules/@openai")),
        listing(Path::new("/usr/local/lib/node_modules/@anthropic-ai")),
        listing(Path::new("/usr/local/lib/node_modules/@openai")),
        fingerprint(Path::new("/opt/homebrew/bin/claude")),
        fingerprint(Path::new("/opt/homebrew/bin/codex")),
        fingerprint(Path::new("/usr/local/bin/claude")),
        fingerprint(Path::new("/usr/local/bin/codex")),
    ];
    (watched, fingerprint(&real.join(".claude.json")))
}

// ---------------------------------------------------------------- the log

fn log(sb: &Sandbox, text: &str) {
    let path = std::env::var("PLY_REPAIR_E2E_LOG")
        .map(PathBuf::from)
        .unwrap_or_else(|_| sb.home.with_file_name("results.md"));
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
    writeln!(f, "{text}").unwrap();
    eprintln!("{text}");
}

/// One scenario: a clean sandbox, the real install watched around it.
fn scenario(name: &str, body: impl FnOnce(&Sandbox) -> String) {
    let sb = sandbox();
    sb.reset();
    let (before, claude_json_before) = real_state(&sb.real);
    log(&sb, &format!("\n## {name}\n"));
    if name.starts_with("1 ") || name.starts_with("16 ") {
        log(&sb, &format!("- REAL install before:\n  {}\n  {claude_json_before}", before.join("\n  ")));
    }
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| body(&sb)));
    let (after, claude_json_after) = real_state(&sb.real);
    let intact = sb.sentinels_intact();
    let verdict = match &result {
        Ok(v) => format!("PASS — {v}"),
        Err(e) => format!(
            "FAIL — {}",
            e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()
        ),
    };
    log(&sb, &format!("- sentinels (~/.claude/e2e-sentinel.json, ~/.codex/auth.json) byte-identical: {intact}"));
    if claude_json_before != claude_json_after {
        log(&sb, &format!("- note: the REAL ~/.claude.json changed (another Claude Code session writes it):\n  before {claude_json_before}\n  after  {claude_json_after}"));
    }
    if name.starts_with("1 ") || name.starts_with("16 ") {
        log(&sb, &format!("- REAL install after:\n  {}\n  {claude_json_after}", after.join("\n  ")));
    }
    log(&sb, &format!("- real install unchanged ({} watched entries): {}", before.len(), before == after));
    log(&sb, &format!("- **{verdict}**"));
    assert_eq!(before, after, "THE REAL INSTALL OR A GLOBAL NPM FOLDER CHANGED during {name}");
    assert!(intact, "a sentinel file changed during {name}");
    if let Err(e) = result {
        std::panic::resume_unwind(e);
    }
}

// ---------------------------------------------------------------- the machine

/// The real disk, with chosen folders reading as someone else's and chosen
/// copies answering a scripted `--version`.
struct Layer {
    not_owned: Vec<String>,
    runs: BTreeMap<String, RunOutcome>,
}

impl Machine for Layer {
    fn look(&self, path: &str) -> Look {
        health::SystemMachine.look(path)
    }

    fn folder(&self, path: &str, kind: FolderKind) -> FolderLook {
        let mut look = health::SystemMachine.folder(path, kind);
        if self.not_owned.iter().any(|p| p == path) {
            look.owned = Some(false);
            look.writable = false;
        }
        look
    }

    fn run_version(&self, program: &str, env_path: &str, timeout: Duration) -> RunOutcome {
        match self.runs.get(program) {
            Some(outcome) => outcome.clone(),
            None => health::SystemMachine.run_version(program, env_path, timeout),
        }
    }
}

fn real() -> Layer {
    Layer { not_owned: Vec::new(), runs: BTreeMap::new() }
}

// ---------------------------------------------------------------- the loop

#[derive(Default, Clone)]
struct Flags {
    npm_first: bool,
    remove_npm_copy: bool,
    reinstall: bool,
    /// The installer's host checked through this proxy (a dead one: offline).
    reach_proxy: Option<String>,
    /// Extra env for the terminal steps (a dead proxy: the installer fails).
    step_env: Vec<(String, String)>,
}

/// What the snapshot would hold now (`shell_env::resolve_cli`).
fn snapshot(tool: CliTool, path: &str) -> (Cached, Option<crate::shell_env::PassedOver>) {
    let (chosen, _, _, skipped) = crate::shell_env::resolve_cli(None, path, tool.program(), false);
    (chosen.map_or(Cached::Absent, Cached::Path), skipped)
}

fn inputs(sb: &Sandbox, path: &str, cached: Cached) -> Inputs {
    Inputs {
        path: path.to_string(),
        windows: false,
        home: Some(sb.home.to_string_lossy().into_owned()),
        codex_home: Some(sb.s(".codex")),
        npm_prefix: Some(sb.npm_prefix()),
        cached,
        ..Inputs::default()
    }
}

fn context(sb: &Sandbox, tool: CliTool, h: &CliHealth, path: &str, flags: &Flags, attempted: &[StepKind], last: Option<&LastRun>) -> RepairContext {
    let npms: Vec<(String, String)> = h
        .copies
        .iter()
        .filter(|c| c.channel == health::InstallChannel::Npm && !c.dangling)
        .filter_map(|c| repair::npm_prefix(tool, c, false))
        .filter_map(|prefix| run::npm_for(Some(&prefix), path, false).map(|npm| (prefix, npm)))
        .collect();
    let reach = flags.reach_proxy.as_ref().map(|proxy| {
        let action = match tool {
            CliTool::Claude => crate::setup_actions::ActionId::InstallClaude,
            CliTool::Codex => crate::setup_actions::ActionId::InstallCodex,
        };
        let url = crate::setup_actions::reach_url(action, false).unwrap();
        let argv = crate::setup_actions::reach_argv(url, false, None).unwrap();
        let mut cmd = crate::platform::new_command(&argv[0]);
        cmd.args(&argv[1..]).env_clear().env("PATH", path).env("HOME", &sb.home);
        for key in ["https_proxy", "HTTPS_PROXY", "http_proxy", "ALL_PROXY"] {
            cmd.env(key, proxy);
        }
        match crate::worktrees::run_bounded_output(&mut cmd, Duration::from_secs(8)) {
            Ok(out) => crate::setup_actions::reach_verdict(out.status.code(), &String::from_utf8_lossy(&out.stderr)),
            Err(_) => crate::setup_actions::reach_verdict(None, ""),
        }
    });
    RepairContext {
        windows: false,
        home: Some(sb.home.to_string_lossy().into_owned()),
        user: run::user_name(),
        sessions: Vec::new(),
        free_bytes: run::free_bytes(&sb.home),
        reach,
        last_run: last.cloned(),
        remove_npm_copy: flags.remove_npm_copy,
        npms,
        unconfirmed: Vec::new(),
        attempted: attempted.to_vec(),
        reinstall: flags.reinstall,
        program_folders: None,
    }
}

/// A terminal step's exact argv and env, as a bounded child (stdin closed).
fn run_child(sb: &Sandbox, plan: &crate::setup_actions::RunPlan, extra: &[(String, String)]) -> (Option<i32>, Vec<String>) {
    let mut cmd = crate::platform::new_command(&plan.argv[0]);
    cmd.args(&plan.argv[1..])
        .env_clear()
        .env("HOME", &sb.home)
        .env("USER", std::env::var("USER").unwrap_or_default())
        .env("LOGNAME", std::env::var("USER").unwrap_or_default())
        .env("LANG", "en_US.UTF-8")
        .env("SHELL", "/bin/zsh")
        .env("TMPDIR", sb.root.join("tmp"))
        .env("npm_config_cache", sb.root.join("npm-cache"))
        .stdin(std::process::Stdio::null());
    for (k, v) in plan.env.iter().chain(extra) {
        cmd.env(k, v);
    }
    match crate::worktrees::run_bounded_output(&mut cmd, INSTALL_TIMEOUT) {
        Ok(out) => {
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&out.stderr));
            let tail: Vec<String> = text.lines().rev().take(12).map(|l| crate::verify::strip_ansi(l)).collect::<Vec<_>>().into_iter().rev().collect();
            (out.status.code(), tail)
        }
        Err(e) => (None, vec![format!("{e:?}")]),
    }
}

/// What a drive saw.
struct Drive {
    plans: Vec<RepairPlan>,
    last: RepairPlan,
    health: CliHealth,
    skipped: Option<crate::shell_env::PassedOver>,
}

fn kinds(plan: &RepairPlan) -> Vec<StepKind> {
    plan.steps.iter().map(|s| s.kind()).collect()
}

fn block_name(plan: &RepairPlan) -> String {
    plan.block.as_ref().map(|b| serde_json::to_value(b).unwrap()["kind"].as_str().unwrap_or("?").to_string()).unwrap_or_else(|| "-".into())
}

/// inspect → plan → run the next step → plan again, until a block (or
/// `max` steps: the loop must end by itself).
fn drive(sb: &Sandbox, tool: CliTool, flags: &Flags, machine: &dyn Machine, max: usize) -> Drive {
    let path = sb.path(flags.npm_first);
    let mut attempted: Vec<StepKind> = Vec::new();
    let mut last_run: Option<LastRun> = None;
    let mut plans = Vec::new();
    for round in 0..=max {
        let (cached, skipped) = snapshot(tool, &path);
        let h = health::inspect(tool, &inputs(sb, &path, cached.clone()), machine);
        let ctx = context(sb, tool, &h, &path, flags, &attempted, last_run.as_ref());
        let plan = repair::plan(&h, &ctx);
        log(sb, &format!(
            "- round {round}: tile runs `{}`; situations {:?}; steps {:?}; block {}; notes {:?}",
            h.runs_today.as_deref().unwrap_or("nothing"),
            plan.situations.iter().map(|s| serde_json::to_value(s).unwrap()["kind"].as_str().unwrap_or("").to_string()).collect::<Vec<_>>(),
            kinds(&plan),
            block_name(&plan),
            plan.notes.iter().map(|n| serde_json::to_value(n).unwrap()["kind"].as_str().unwrap_or("").to_string()).collect::<Vec<_>>(),
        ));
        plans.push(plan.clone());
        let Some(next) = plan.next_step.clone() else {
            return Drive { plans, last: plan, health: h, skipped };
        };
        assert!(round < max, "the plan didn't end after {max} steps");
        let step = run::runnable(&plan, &next).expect("the next step runs").clone();
        let roots = run::Roots::new(tool, &inputs(sb, &path, Cached::Unknown)).unwrap();
        let ran: String = match &step.action {
            StepAction::RunInstaller { .. } => {
                let facts = crate::setup_actions::PlanFacts { windows: false, ..Default::default() };
                let full = run::path_with(&path, h.install_dir.as_deref(), false);
                let rp = crate::setup_actions::repair_install_plan(tool, &facts, Some(&sb.home.to_string_lossy()), &full).unwrap();
                let (code, tail) = run_child(sb, &rp, &flags.step_env);
                last_run = Some(lastrun(rp.action, code, &tail));
                format!("argv {:?}, env {:?} → exit {code:?}; tail: {}", rp.argv, rp.env, tail.join(" | "))
            }
            StepAction::RemoveNpmCopy { prefix, .. } => {
                let checked = run::check_npm_prefix(tool, prefix, false).expect("the prefix checks");
                let npm = run::npm_for(Some(prefix), &path, false).expect("an npm");
                let rp = crate::setup_actions::repair_npm_remove_plan(tool, &npm, &checked, &path, false).unwrap();
                assert!(rp.argv.contains(&"--prefix".to_string()) && rp.argv.contains(prefix));
                let (code, tail) = run_child(sb, &rp, &[]);
                last_run = Some(lastrun(rp.action, code, &tail));
                format!("argv {:?} → exit {code:?}; tail: {}", rp.argv, tail.join(" | "))
            }
            StepAction::FixOwnership { .. } | StepAction::FixSharedOwnership { .. } => {
                panic!("a sudo step is never run here: {step:?}")
            }
            StepAction::RemoveBrokenPayload | StepAction::RemoveDanglingLauncher | StepAction::FixPermissions => {
                let env_path = path.clone();
                match run::apply_own_step(&step, &h, &roots, &|p| run::confirm_broken(p, &env_path)) {
                    Ok(applied) => format!("Plyloft: {:?} on {:?}, failed {:?}", step.kind(), applied.paths, applied.failed),
                    Err(why) => format!("Plyloft refused {:?}: {why:?}", step.kind()),
                }
            }
            StepAction::Reread | StepAction::Verify | StepAction::CloseSessions { .. } | StepAction::AddProgramFolder { .. } | StepAction::EmptyProgramFolders { .. } => "nothing to run".into(),
        };
        log(sb, &format!("  - ran `{}`: {ran}", step.id));
        attempted.retain(|k| *k != step.kind());
        attempted.push(step.kind());
    }
    unreachable!()
}

fn lastrun(action: crate::setup_actions::ActionId, code: Option<i32>, tail: &[String]) -> LastRun {
    let cause = (code != Some(0)).then(|| crate::setup_outcome::classify_for(action, tail, code, false).cause);
    LastRun {
        action_id: action.id().into(),
        exit_code: code,
        outcome: Some(if code == Some(0) { "succeeded" } else { "failed" }.into()),
        cause: cause.map(|c| serde_json::to_value(c).unwrap().as_str().unwrap_or("").to_string()),
        finished_at: Some(chrono::Utc::now().to_rfc3339()),
        tail: tail.to_vec(),
        ..LastRun::default()
    }
}

fn version_of(h: &CliHealth) -> Option<String> {
    let runs = h.runs_today.as_deref()?;
    repair::copy_of(h, runs, false)?.start.as_ref()?.version.clone()
}

fn assert_working(d: &Drive, sb: &Sandbox, launcher: &str) -> String {
    assert!(
        matches!(d.last.block, Some(Block::NothingToRepair { .. })),
        "ended at {:?}",
        d.last.block
    );
    assert_eq!(d.health.runs_today.as_deref(), Some(sb.s(launcher).as_str()));
    let v = version_of(&d.health).expect("a version read");
    format!("{} runs, version {v}", launcher)
}

// ---------------------------------------------------------------- caches (bandwidth)

/// A healthy native Claude in the sandbox: from the cache when an earlier
/// scenario installed one, else by the installer.
fn seed_claude(sb: &Sandbox) -> String {
    let cache = sb.root.join("cache/claude");
    let cached: Option<PathBuf> = std::fs::read_dir(&cache).ok().and_then(|mut e| e.next()).and_then(|e| e.ok()).map(|e| e.path());
    match cached {
        Some(file) => {
            let v = file.file_name().unwrap().to_string_lossy().into_owned();
            let versions = sb.home.join(".local/share/claude/versions");
            std::fs::create_dir_all(&versions).unwrap();
            std::fs::copy(&file, versions.join(&v)).unwrap();
            std::os::unix::fs::symlink(versions.join(&v), sb.home.join(".local/bin/claude")).unwrap();
            v
        }
        None => {
            let d = drive(sb, CliTool::Claude, &Flags::default(), &real(), 4);
            assert!(matches!(d.last.block, Some(Block::NothingToRepair { .. })));
            keep_claude(sb);
            version_of(&d.health).unwrap()
        }
    }
}

fn keep_claude(sb: &Sandbox) {
    let link = std::fs::read_link(sb.home.join(".local/bin/claude")).unwrap();
    let cache = sb.root.join("cache/claude");
    std::fs::create_dir_all(&cache).unwrap();
    if std::fs::read_dir(&cache).unwrap().next().is_none() {
        std::fs::copy(&link, cache.join(link.file_name().unwrap())).unwrap();
    }
}

fn cp(from: &Path, to: &Path) {
    let st = crate::platform::new_command("/bin/cp").arg("-Rp").arg(from).arg(to).status().unwrap();
    assert!(st.success(), "cp {} {}", from.display(), to.display());
}

/// A healthy standalone Codex: from the cache, else by the installer.
fn seed_codex(sb: &Sandbox) {
    let cache = sb.root.join("cache/codex");
    if cache.join("packages").exists() {
        cp(&cache.join("packages"), &sb.home.join(".codex/packages"));
        for name in ["codex", "codex-code-mode-host"] {
            let target = sb.home.join(".codex/packages/standalone/current/bin").join(name);
            if target.exists() {
                std::os::unix::fs::symlink(&target, sb.home.join(".local/bin").join(name)).unwrap();
            }
        }
        return;
    }
    let d = drive(sb, CliTool::Codex, &Flags::default(), &real(), 4);
    assert!(matches!(d.last.block, Some(Block::NothingToRepair { .. })));
    keep_codex(sb);
}

fn keep_codex(sb: &Sandbox) {
    let cache = sb.root.join("cache/codex");
    if !cache.join("packages").exists() {
        std::fs::create_dir_all(&cache).unwrap();
        cp(&sb.home.join(".codex/packages"), &cache.join("packages"));
    }
}

fn npm_install(sb: &Sandbox, package: &str) {
    let prefix = sb.npm_prefix();
    let npm = sb.root.join("tools/npm");
    let mut cmd = crate::platform::new_command(&npm);
    cmd.args(["install", "-g", "--prefix", &prefix, package])
        .env_clear()
        .env("HOME", &sb.home)
        .env("PATH", sb.path(false))
        .env("npm_config_prefix", &prefix)
        .env("npm_config_cache", sb.root.join("npm-cache"))
        .env("TMPDIR", sb.root.join("tmp"))
        .stdin(std::process::Stdio::null());
    let out = crate::worktrees::run_bounded_output(&mut cmd, INSTALL_TIMEOUT).expect("npm ran");
    assert!(out.status.success(), "npm install {package}: {}", String::from_utf8_lossy(&out.stderr));
}

/// Break the npm copy's real program: a truncated Mach-O for Claude's native
/// binary, a failing script for anything else.
fn break_file(path: &Path) {
    let bytes = std::fs::read(path).unwrap();
    let macho = bytes.starts_with(&[0xcf, 0xfa, 0xed, 0xfe]) || bytes.starts_with(&[0xca, 0xfe, 0xba, 0xbe]);
    let mode = std::fs::metadata(path).unwrap().permissions().mode();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode | 0o200)).unwrap();
    if macho {
        std::fs::write(path, &bytes[..4096]).unwrap();
    } else {
        std::fs::write(path, b"#!/bin/sh\necho broken >&2\nexit 1\n").unwrap();
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode | 0o111)).unwrap();
}

fn real_of(link: &str) -> PathBuf {
    std::fs::canonicalize(link).unwrap()
}

fn chmod(path: &Path, mode: u32) {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

// ---------------------------------------------------------------- Claude

#[test]
#[ignore]
fn s01_claude_missing_is_installed() {
    scenario("1 Claude missing → install → healthy", |sb| {
        let d = drive(sb, CliTool::Claude, &Flags::default(), &real(), 4);
        assert_eq!(kinds(&d.plans[0]), [StepKind::RunInstaller, StepKind::Reread, StepKind::Verify]);
        keep_claude(sb);
        assert_working(&d, sb, ".local/bin/claude")
    });
}

#[test]
#[ignore]
fn s02_claude_dangling_launcher() {
    scenario("2 Claude dangling launcher (versions/<v> deleted)", |sb| {
        let v = seed_claude(sb);
        std::fs::remove_file(sb.home.join(".local/share/claude/versions").join(&v)).unwrap();
        let d = drive(sb, CliTool::Claude, &Flags::default(), &real(), 5);
        assert_eq!(
            kinds(&d.plans[0]),
            [StepKind::RemoveDanglingLauncher, StepKind::RunInstaller, StepKind::Reread, StepKind::Verify]
        );
        assert_working(&d, sb, ".local/bin/claude")
    });
}

#[test]
#[ignore]
fn s03_claude_truncated_payload_and_an_intact_one_kept() {
    scenario("3 Claude truncated payload (4 KB); an intact payload under a simulated kill is kept", |sb| {
        // First: an intact payload that a scripted look says was killed.
        let v = seed_claude(sb);
        let launcher = sb.s(".local/bin/claude");
        let payload = sb.home.join(".local/share/claude/versions").join(&v);
        let killed = Layer {
            not_owned: Vec::new(),
            runs: BTreeMap::from([(launcher.clone(), RunOutcome::Exited { code: None, signal: Some(9), stdout: Vec::new(), stderr: Vec::new() })]),
        };
        let path = sb.path(false);
        let (cached, _) = snapshot(CliTool::Claude, &path);
        let h = health::inspect(CliTool::Claude, &inputs(sb, &path, cached), &killed);
        let plan = repair::plan(&h, &context(sb, CliTool::Claude, &h, &path, &Flags::default(), &[], None));
        let removal = plan.steps.iter().find(|s| s.kind() == StepKind::RemoveBrokenPayload).expect("the scripted kill plans a removal").clone();
        let roots = run::Roots::new(CliTool::Claude, &inputs(sb, &path, Cached::Unknown)).unwrap();
        let before = std::fs::read(&payload).unwrap();
        let refused = run::apply_own_step(&removal, &h, &roots, &|p| run::confirm_broken(p, &path));
        log(sb, &format!("- intact payload, simulated SIGKILL: apply_own_step → {refused:?}"));
        assert_eq!(refused.unwrap_err(), run::PathRefusal::NotConfirmed);
        assert_eq!(std::fs::read(&payload).unwrap(), before, "the intact payload is untouched");

        // Then the real thing: truncated to 4 KB.
        let bytes = std::fs::read(&payload).unwrap();
        std::fs::write(&payload, &bytes[..4096]).unwrap();
        let d = drive(sb, CliTool::Claude, &Flags::default(), &real(), 5);
        assert_eq!(
            kinds(&d.plans[0]),
            [StepKind::RemoveBrokenPayload, StepKind::RunInstaller, StepKind::Reread, StepKind::Verify]
        );
        let size = std::fs::metadata(&payload).unwrap().len();
        let out = assert_working(&d, sb, ".local/bin/claude");
        format!("{out}; payload back to {size} bytes")
    });
}

#[test]
#[ignore]
fn s04_claude_local_bin_read_only() {
    scenario("4 Claude ~/.local/bin mode 555", |sb| {
        seed_claude(sb);
        chmod(&sb.home.join(".local/bin"), 0o555);
        let d = drive(sb, CliTool::Claude, &Flags::default(), &real(), 4);
        assert_eq!(kinds(&d.plans[0]), [StepKind::FixPermissions, StepKind::Reread, StepKind::Verify]);
        assert!(d.plans[0].steps.iter().all(|s| s.command.as_deref().is_none_or(|c| !c.contains("sudo"))));
        assert_working(&d, sb, ".local/bin/claude")
    });
}

#[test]
#[ignore]
fn s05_claude_versions_read_only() {
    scenario("5 Claude versions/ mode 555, the user's", |sb| {
        seed_claude(sb);
        chmod(&sb.home.join(".local/share/claude/versions"), 0o555);
        let d = drive(sb, CliTool::Claude, &Flags::default(), &real(), 4);
        let first = kinds(&d.plans[0]);
        log(sb, &format!("- the plan for a read-only versions/: {first:?}"));
        assert_eq!(first[0], StepKind::FixPermissions);
        assert_working(&d, sb, ".local/bin/claude")
    });
}

#[test]
#[ignore]
fn s06_claude_broken_npm_copy_first_then_removed() {
    scenario("6 Claude npm copy first and broken, native missing; then removeNpmCopy", |sb| {
        npm_install(sb, "@anthropic-ai/claude-code");
        let npm_bin = format!("{}/bin/claude", sb.npm_prefix());
        let npm_real = real_of(&npm_bin);
        log(sb, &format!("- npm copy {npm_bin} -> {}", npm_real.display()));
        break_file(&npm_real);
        let flags = Flags { npm_first: true, ..Flags::default() };
        let d = drive(sb, CliTool::Claude, &flags, &real(), 4);
        assert!(kinds(&d.plans[0]).contains(&StepKind::RunInstaller));
        assert_eq!(d.health.runs_today.as_deref(), Some(sb.s(".local/bin/claude").as_str()), "Plyloft runs the native copy");
        assert!(d.skipped.as_ref().is_some_and(|s| s.path == npm_bin), "the snapshot passed over the npm copy: {:?}", d.skipped);
        assert!(d.last.notes.iter().any(|n| matches!(n, repair::Note::TerminalRunsOther { terminal, .. } if *terminal == npm_bin)));
        keep_claude(sb);
        // Now the tick.
        let flags = Flags { npm_first: true, remove_npm_copy: true, ..Flags::default() };
        let d = drive(sb, CliTool::Claude, &flags, &real(), 4);
        assert!(kinds(&d.plans[0]).contains(&StepKind::RemoveNpmCopy));
        assert!(std::fs::symlink_metadata(&npm_bin).is_err(), "the npm copy is gone");
        assert!(!Path::new(&sb.npm_prefix()).join("lib/node_modules/@anthropic-ai/claude-code").exists());
        let out = assert_working(&d, sb, ".local/bin/claude");
        format!("{out}; npm copy removed with --prefix {}", sb.npm_prefix())
    });
}

#[test]
#[ignore]
fn s07_claude_npm_and_native_both_working() {
    scenario("7 Claude npm copy first and working, native working", |sb| {
        seed_claude(sb);
        npm_install(sb, "@anthropic-ai/claude-code");
        let flags = Flags { npm_first: true, ..Flags::default() };
        let d = drive(sb, CliTool::Claude, &flags, &real(), 2);
        let writable = format!("{:?} notes {:?}", d.last.block, d.last.notes);
        assert_eq!(d.last.block, Some(Block::NothingToRepair { healthy_enough: true }));
        // The same, with the npm package folder read-only: it can't update.
        let scope = Path::new(&sb.npm_prefix()).join("lib/node_modules/@anthropic-ai");
        chmod(&scope, 0o555);
        let d = drive(sb, CliTool::Claude, &flags, &real(), 2);
        chmod(&scope, 0o755);
        assert!(matches!(d.last.block, Some(Block::CouldNotRepair { reason: repair::GiveUp::PathOrder, .. })), "{:?}", d.last.block);
        assert!(d.last.notes.iter().any(|n| matches!(n, repair::Note::UpdatesGoToNative { .. })));
        assert!(d.last.notes.iter().any(|n| matches!(n, repair::Note::NpmUpdaterMayTouchNative { .. })));
        format!("writable npm: {writable}; read-only npm: pathOrder with UpdatesGoToNative and the C8 note")
    });
}

#[test]
#[ignore]
fn s08_claude_reinstall_on_healthy() {
    scenario("8 Claude reinstall: true on a healthy sandbox", |sb| {
        seed_claude(sb);
        let flags = Flags { reinstall: true, ..Flags::default() };
        let d = drive(sb, CliTool::Claude, &flags, &real(), 4);
        assert_eq!(kinds(&d.plans[0]), [StepKind::RunInstaller, StepKind::Reread, StepKind::Verify]);
        let installs = d.plans.iter().filter(|p| p.next_step.as_deref().is_some_and(|n| n.starts_with("run-installer"))).count();
        assert_eq!(installs, 1, "the installer runs once");
        assert_working(&d, sb, ".local/bin/claude")
    });
}

#[test]
#[ignore]
fn s09_claude_installer_failing_ends_in_the_loop_guard() {
    scenario("9 Claude installer failing (dead proxy) → loop guard", |sb| {
        let dead = "http://127.0.0.1:9".to_string();
        let flags = Flags {
            step_env: ["https_proxy", "HTTPS_PROXY", "http_proxy", "ALL_PROXY"].iter().map(|k| (k.to_string(), dead.clone())).collect(),
            ..Flags::default()
        };
        let d = drive(sb, CliTool::Claude, &flags, &real(), 3);
        match &d.last.block {
            Some(Block::CouldNotRepair { reason: repair::GiveUp::StillThereAfter, step: Some(StepKind::RunInstaller), evidence }) => {
                assert!(!d.last.manual.is_empty());
                format!("stillThereAfter runInstaller, evidence {evidence:?}, by hand {:?}", d.last.manual.iter().map(|m| &m.command).collect::<Vec<_>>())
            }
            other => panic!("expected the loop guard, got {other:?}"),
        }
    });
}

#[test]
#[ignore]
fn s10_claude_offline_blocks_and_deletes_nothing() {
    scenario("10 Claude offline (dead proxy on the reach check), dangling launcher", |sb| {
        let v = seed_claude(sb);
        std::fs::remove_file(sb.home.join(".local/share/claude/versions").join(&v)).unwrap();
        let flags = Flags { reach_proxy: Some("http://127.0.0.1:9".into()), ..Flags::default() };
        let d = drive(sb, CliTool::Claude, &flags, &real(), 1);
        assert!(matches!(d.last.block, Some(Block::Offline { .. })), "{:?}", d.last.block);
        assert!(std::fs::symlink_metadata(sb.home.join(".local/bin/claude")).is_ok(), "the dangling launcher is still there");
        format!("{:?}; nothing removed", d.last.block)
    });
}

// ---------------------------------------------------------------- Codex

#[test]
#[ignore]
fn s11_codex_missing_is_installed() {
    scenario("11 Codex missing → install → healthy", |sb| {
        let d = drive(sb, CliTool::Codex, &Flags::default(), &real(), 4);
        assert_eq!(kinds(&d.plans[0]), [StepKind::RunInstaller, StepKind::Reread, StepKind::Verify]);
        keep_codex(sb);
        assert_working(&d, sb, ".local/bin/codex")
    });
}

#[test]
#[ignore]
fn s12_codex_release_removed() {
    scenario("12 Codex releases/<v> removed (current dangles)", |sb| {
        seed_codex(sb);
        let current = std::fs::read_link(sb.home.join(".codex/packages/standalone/current")).unwrap();
        wipe_dir(&current);
        let d = drive(sb, CliTool::Codex, &Flags::default(), &real(), 5);
        log(sb, &format!("- first plan: {:?}", kinds(&d.plans[0])));
        assert!(kinds(&d.plans[0]).contains(&StepKind::RunInstaller));
        assert_working(&d, sb, ".local/bin/codex")
    });
}

fn wipe_dir(dir: &Path) {
    wipe(dir);
}

#[test]
#[ignore]
fn s13_codex_truncated_binary() {
    scenario("13 Codex truncated binary", |sb| {
        seed_codex(sb);
        let bin = real_of(&sb.s(".local/bin/codex"));
        let bytes = std::fs::read(&bin).unwrap();
        std::fs::write(&bin, &bytes[..4096]).unwrap();
        let d = drive(sb, CliTool::Codex, &Flags::default(), &real(), 4);
        assert_eq!(kinds(&d.plans[0]), [StepKind::RunInstaller, StepKind::Reread, StepKind::Verify]);
        assert_working(&d, sb, ".local/bin/codex")
    });
}

#[test]
#[ignore]
fn s14_codex_broken_npm_copy_first() {
    scenario("14 Codex npm copy first and broken, standalone missing", |sb| {
        npm_install(sb, "@openai/codex");
        let npm_bin = format!("{}/bin/codex", sb.npm_prefix());
        break_file(&real_of(&npm_bin));
        let flags = Flags { npm_first: true, ..Flags::default() };
        let d = drive(sb, CliTool::Codex, &flags, &real(), 4);
        assert!(kinds(&d.plans[0]).contains(&StepKind::RunInstaller));
        assert_eq!(d.health.runs_today.as_deref(), Some(sb.s(".local/bin/codex").as_str()), "Plyloft runs the standalone copy");
        assert!(d.last.notes.iter().any(|n| matches!(n, repair::Note::TerminalRunsOther { .. })));
        assert_working(&d, sb, ".local/bin/codex")
    });
}

#[test]
#[ignore]
fn s15_codex_installer_leaves_zprofile_alone() {
    scenario("15 Codex installer with .local/bin on PATH: ~/.zprofile untouched", |sb| {
        let d = drive(sb, CliTool::Codex, &Flags::default(), &real(), 4);
        assert!(matches!(d.last.block, Some(Block::NothingToRepair { .. })));
        for rc in [".zprofile", ".zshrc", ".bash_profile", ".bashrc", ".profile"] {
            assert!(!sb.home.join(rc).exists(), "the installer wrote {rc}");
        }
        "no rc file written".into()
    });
}

// ---------------------------------------------------------------- ownership (plan and argv only)

#[test]
#[ignore]
fn s16_ownership_plan_and_argv_only() {
    scenario("16 ownership: ~/.claude and ~/.local/bin read as someone else's (plan/argv only, nothing run)", |sb| {
        let v = seed_claude(sb);
        std::fs::remove_file(sb.home.join(".local/share/claude/versions").join(&v)).unwrap();
        let layer = Layer { not_owned: vec![sb.s(".claude"), sb.s(".local/bin")], runs: BTreeMap::new() };
        let path = sb.path(false);
        let (cached, _) = snapshot(CliTool::Claude, &path);
        let h = health::inspect(CliTool::Claude, &inputs(sb, &path, cached), &layer);
        let plan = repair::plan(&h, &context(sb, CliTool::Claude, &h, &path, &Flags::default(), &[], None));
        let own = plan.steps.iter().find(|s| s.kind() == StepKind::FixOwnership).expect("fixOwnership");
        let shared = plan.steps.iter().find(|s| s.kind() == StepKind::FixSharedOwnership).expect("fixSharedOwnership");
        assert_eq!(own.paths, [sb.s(".claude")]);
        assert_eq!(shared.paths, [sb.s(".local/bin"), sb.s(".local/bin/claude")]);
        assert!(!own.password_again && shared.password_again);
        let roots = run::Roots::new(CliTool::Claude, &inputs(sb, &path, Cached::Unknown)).unwrap();
        let user = run::user_name().unwrap();
        let own_argv = crate::setup_actions::repair_chown_plan(CliTool::Claude, &user, &run::chown_folders(own, &h, &roots).unwrap(), true, false).unwrap().argv;
        let shared_argv = crate::setup_actions::repair_chown_plan(CliTool::Claude, &user, &run::chown_folders(shared, &h, &roots).unwrap(), false, false).unwrap().argv;
        assert_eq!(own_argv, ["/usr/bin/sudo", "/usr/sbin/chown", "-R", "-P", "--", &user, &sb.s(".claude")]);
        assert_eq!(shared_argv, ["/usr/bin/sudo", "/usr/sbin/chown", "-h", "--", &user, &sb.s(".local/bin"), &sb.s(".local/bin/claude")]);
        log(sb, &format!("- steps {:?}\n- argv 1 {own_argv:?}\n- argv 2 {shared_argv:?} (passwordAgain)", kinds(&plan)));
        "two sudo steps, -R only on ~/.claude, -h on ~/.local/bin and its launcher; not run".into()
    });
}

/// Run last: removes the sandbox home — that exact path, caches included.
#[test]
#[ignore]
fn s99_cleanup() {
    let sb = sandbox();
    wipe(&sb.home);
}
