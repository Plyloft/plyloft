use parking_lot::RwLock;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// Minimum claude CLI version that supports `--output-format stream-json`.
/// Older CLIs fall back to plain-text mode (no token / cost tracking).
pub const MIN_CLAUDE_VERSION_STREAM_JSON: (u32, u32, u32) = (1, 0, 0);

#[derive(Debug, Clone, Default)]
pub struct ShellEnv {
    pub path: String,
    pub shell: String,
    pub claude_path: Option<String>,
    /// Reported `claude --version` (e.g. "1.5.2"). None if claude is missing
    /// or the probe failed to parse a version.
    pub claude_version: Option<String>,
    /// Resolved path to the codex CLI (v1.20.8 Phase 2). None when codex is
    /// not installed — Atelier continues to work; only the codex-tile button
    /// hides from the tile-grid toolbar.
    pub codex_path: Option<String>,
    /// Reported `codex --version`. Best-effort; None on failure.
    pub codex_version: Option<String>,
    /// 1.176.0 R3 (review 1): `claude --version` didn't answer in time —
    /// both bounds ran out ([`VersionAnswer::Unknown`]) and there was no
    /// earlier version of the same file to keep. Not "doesn't start": a cold
    /// first run, memory pressure or an antivirus scan is slow, not broken.
    pub claude_version_unknown: bool,
    /// [`Self::claude_version_unknown`] for Codex.
    pub codex_version_unknown: bool,
    /// Resolved path to the git CLI (v1.32.0 dependency doctor). None when git
    /// is not on PATH. git is a *required* dependency (worktrees, swarms,
    /// ship) — `doctor.rs` treats a None here as a blocking problem. Not
    /// folded into `probe_error`: required-vs-optional policy lives in the
    /// doctor layer, not the raw probe.
    pub git_path: Option<String>,
    /// Reported `git --version`. Best-effort; None on failure.
    pub git_version: Option<String>,
    /// Resolved path to the GitHub CLI (`gh`, v1.32.0). None when gh is not
    /// installed — optional; only the card-ship "Open a PR" path needs it.
    pub gh_path: Option<String>,
    /// Reported `gh --version`. Best-effort; None on failure.
    pub gh_version: Option<String>,
    /// Human-readable error captured during the last probe. None on success.
    /// Populated when bash -lc returns non-zero (corrupted profile) or (OB-2)
    /// when neither claude nor codex is present in the resolved PATH.
    pub probe_error: Option<String>,
    /// OB-2: macOS only — whether `xcode-select -p` answered, i.e. Apple's
    /// Command Line Tools are installed. Asked **before** any git runs:
    /// without them `/usr/bin/git` is a shim that opens Apple's install
    /// dialog. `None` off macOS, and in tests that do not say.
    pub clt_installed: Option<bool>,
    /// OB-2: Windows only — Git Bash's `bash.exe` (`bash_program`), which
    /// runs project checks. `None` off Windows or when it isn't found.
    pub git_bash_path: Option<String>,
    /// OB-2: `node` on PATH (the Windows row: an npm Codex runs on it).
    pub node_path: Option<String>,
    /// `node --version`, asked on Windows only. Best-effort.
    pub node_version: Option<String>,
    /// OB-3 (spec §5 step 3, "Corporate proxy"): the proxy variables Setup's
    /// guided terminal passes on, from the login-shell probe on the Mac (a
    /// Finder-launched app never sees a `.zshrc` export) and from the
    /// process environment — what Windows builds from the system and user
    /// settings — elsewhere or when the probe could not run.
    pub proxy_env: Vec<(String, String)>,
    /// 1.176.0 R4 (B2): the first `claude` on PATH, passed over because it
    /// certainly doesn't start while a later copy does ([`choose_copy`]).
    /// Not persisted; the PTY PATH is unchanged, only `claude_path` differs.
    pub claude_path_skipped: Option<PassedOver>,
    /// [`Self::claude_path_skipped`] for Codex.
    pub codex_path_skipped: Option<PassedOver>,
}

/// 1.176.0 R4 (B2): a copy of `claude` or `codex` the snapshot didn't take
/// although it is first on PATH: it certainly doesn't start (a `--version`
/// that failed, never one that only didn't answer in time) and a later copy
/// does. Under a PATH override from Settings nothing is skipped: the first
/// copy is kept and this only reports the one that would start.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PassedOver {
    /// The first copy on PATH, which doesn't start.
    pub path: String,
    /// The later copy that starts (the one used, unless `kept_by_override`).
    pub instead: String,
    /// A PATH override is set: the first copy was kept.
    pub kept_by_override: bool,
}

/// Every file `binary` names on `path`, in order, one per real file.
pub fn find_all_in_path(path: &str, binary: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();
    for dir in crate::platform::split_path_list(path) {
        for candidate in crate::platform::program_candidates(&dir, binary) {
            if !candidate.is_file() {
                continue;
            }
            let real = crate::platform::canonicalize(&candidate).unwrap_or_else(|_| candidate.clone());
            if seen.contains(&real) {
                continue;
            }
            seen.push(real);
            out.push(candidate.to_string_lossy().into_owned());
        }
    }
    out
}

/// 1.176.0 R4 (B2), pure apart from `probe`: which copy the snapshot keeps.
/// The first candidate stays unless its answer (`first`) is a certain
/// failure; then the later ones are asked (in parallel, each bounded) and
/// the first of them that starts is taken. An `Unknown` is never skipped;
/// with `override_set` nothing is skipped and the working one is reported.
/// When no later copy starts, the first stays. No extra probe runs when the
/// first copy starts or doesn't answer.
pub(crate) fn choose_copy(
    candidates: &[String],
    first: VersionAnswer,
    override_set: bool,
    effective_path: &str,
    probe: impl Fn(&str, &str) -> VersionAnswer + Sync,
) -> (Option<String>, Option<VersionAnswer>, Option<PassedOver>) {
    // (The last probe's answers on the candidates, `answers` below.)
    let Some(head) = candidates.first() else { return (None, None, None) };
    if first != VersionAnswer::Fails || candidates.len() < 2 {
        return (Some(head.clone()), Some(first), None);
    }
    let rest = &candidates[1..];
    let answers: Vec<VersionAnswer> = std::thread::scope(|scope| {
        let handles: Vec<_> = rest.iter().map(|c| scope.spawn(|| probe(c, effective_path))).collect();
        handles.into_iter().map(|h| h.join().unwrap_or(VersionAnswer::Unknown)).collect()
    });
    // A copy that starts first; else one that only didn't answer in time
    // (slow is not broken), rather than a certain failure.
    let at = answers
        .iter()
        .position(|a| matches!(a, VersionAnswer::Starts(_)))
        .or_else(|| answers.iter().position(|a| *a == VersionAnswer::Unknown));
    let Some(at) = at else {
        return (Some(head.clone()), Some(first), None);
    };
    let passed = PassedOver { path: head.clone(), instead: rest[at].clone(), kept_by_override: override_set };
    if override_set {
        log::warn!("shell_env: {head} doesn't start; {} would, but the PATH override is kept", rest[at]);
        return (Some(head.clone()), Some(first), Some(passed));
    }
    log::warn!("shell_env: {head} doesn't start; using {} instead", rest[at]);
    (Some(rest[at].clone()), Some(answers[at].clone()), Some(passed))
}

/// The candidates for a tool: what the probe named first, then every copy on
/// the (widened) PATH.
fn candidates_for(named: Option<&str>, path: &str, binary: &str) -> Vec<String> {
    let mut out: Vec<String> = named.map(|n| vec![n.to_string()]).unwrap_or_default();
    let real = |p: &str| crate::platform::canonicalize(p).ok();
    for c in find_all_in_path(path, binary) {
        let same = out.iter().any(|o| o == &c || (real(o).is_some() && real(o) == real(&c)));
        if !same {
            out.push(c);
        }
    }
    out
}

/// Resolve and probe one CLI (`binary`) the B2 way: the chosen path, its
/// version fields, and what was passed over. `pub(crate)` for R9's sandbox
/// harness (`cli_repair_e2e_tests.rs`), which models the snapshot with it.
pub(crate) fn resolve_cli(
    named: Option<String>,
    path: &str,
    binary: &str,
    override_set: bool,
) -> (Option<String>, Option<String>, bool, Option<PassedOver>) {
    let candidates = candidates_for(named.as_deref(), path, binary);
    let Some(first) = candidates.first() else { return (None, None, false, None) };
    let answer = probe_cli_version(first, path);
    let (chosen, answer, skipped) = choose_copy(&candidates, answer, override_set, path, probe_cli_version);
    let (version, unknown) = VersionAnswer::fields(answer);
    (chosen, version, unknown, skipped)
}

impl ShellEnv {
    /// True when the resolved claude CLI version is recent enough to support
    /// stream-json + token tracking. Conservative: returns false when the
    /// version couldn't be parsed.
    pub fn supports_stream_json(&self) -> bool {
        match self.claude_version.as_deref().and_then(parse_semver) {
            Some(v) => version_at_least(v, MIN_CLAUDE_VERSION_STREAM_JSON),
            None => false,
        }
    }

    /// True when codex both resolved on PATH *and* answered `--version`.
    ///
    /// A resolved path only proves the file exists. A half-installed
    /// `@openai/codex` leaves its Node wrapper on PATH while every run crashes
    /// (2026-08-30) — a tile spawned against it dies instantly and looks like
    /// "the tile won't open". The version probe is the cheapest proof of life
    /// we already pay for at probe time, so the doctor and the tile toolbar
    /// gate on this instead of on the path alone. Single definition on
    /// purpose: policy that lives in two places drifts.
    pub fn codex_healthy(&self) -> bool {
        // R3 review 1: a version that didn't answer in time is not a crash.
        self.codex_path.is_some() && (self.codex_version.is_some() || self.codex_version_unknown)
    }

    /// 1.176.0 R3: [`Self::codex_healthy`] for Claude — resolved *and*
    /// answered `--version`. A launcher whose payload is gone or truncated
    /// (an update that failed half-way, R0 C3/C4) still resolves, and was
    /// read as "found" before: ready for every agent, offered `claude
    /// update` — the broken binary itself — as its fix.
    ///
    /// Three answers, not two (review 1): it answered (a version), it failed
    /// (a spawn error, a non-zero exit with nothing readable, killed), or it
    /// didn't answer in time ([`Self::claude_version_unknown`]). Only a
    /// failure is "doesn't start"; a slow answer counts as starting.
    pub fn claude_healthy(&self) -> bool {
        self.claude_path.is_some() && (self.claude_version.is_some() || self.claude_version_unknown)
    }

    /// OB-2 (spec §4, C9): Git **works** — resolved *and* answered `git
    /// --version`. On a Mac without the Command Line Tools `/usr/bin/git`
    /// resolves but is never run (see [`choose_git`]), so it has no version
    /// and does not work; a Homebrew git there does.
    pub fn git_works(&self) -> bool {
        self.git_path.is_some() && self.git_version.is_some()
    }

    /// The git to run, only when it works (never the CLT shim).
    pub fn working_git(&self) -> Option<String> {
        if self.git_works() {
            self.git_path.clone()
        } else {
            None
        }
    }
}

/// OB-2 review (P2-1): which program a bare `git` spawn runs.
#[derive(Debug, Clone, PartialEq)]
pub enum GitProgram {
    /// `git` from the process PATH, exactly as before: the probe has not run
    /// (unit tests), or this is not a Mac without the Command Line Tools.
    Bare,
    /// A Mac without the CLT: the working git the probe found (Homebrew's),
    /// by path, with the probed PATH — the process PATH of an app launched
    /// from Finder is `/usr/bin:/bin`, whose `git` is Apple's shim.
    At { program: String, path: String },
    /// 1.176.2 R1 (A1-01), Windows: the working `git.exe` the probe found, by
    /// its absolute path, and nothing else changed (the child's PATH is still
    /// Plyloft's own). A Git installed while Plyloft is open — Setup's Git
    /// step — is in a folder the process PATH from launch doesn't have; the
    /// probe finds it in the known folders, and a bare `git` never would.
    Found { program: String },
    /// A Mac without the CLT and no working git: nothing may run, or the shim
    /// opens Apple's install dialog unasked. The spawn fails instead.
    Unavailable,
}

/// A program that cannot exist, spawned in place of the shim so the caller's
/// ordinary spawn error path answers ("not a directory").
pub const GIT_UNAVAILABLE: &str = "/dev/null/git-needs-the-command-line-tools";

/// [`GitProgram`] for a probe snapshot. Behaviour is unchanged wherever git
/// works through the CLT on a Mac; the no-CLT Mac is rerouted, and on
/// Windows the git the probe found runs by its path while it is on disk.
pub fn git_program(env: Option<&ShellEnv>) -> GitProgram {
    git_program_on(env, cfg!(windows), |p| Path::new(p).is_file())
}

/// Pure: [`git_program`] for a platform (`windows`) and a disk check
/// (`on_disk`), so the Mac tests the Windows rule with Windows paths.
pub fn git_program_on(env: Option<&ShellEnv>, windows: bool, on_disk: impl Fn(&str) -> bool) -> GitProgram {
    let Some(env) = env else { return GitProgram::Bare };
    if env.clt_installed != Some(false) {
        // R1 (A1-01): Windows only, and only a working `.exe` still on disk
        // (checked at each spawn, as `cli_fresh` does for the AI CLIs) — the
        // one a bare `git` resolves to as well, never a `.cmd`/`.bat` that
        // would run through cmd.exe. Anything else: the bare name, as before.
        if windows {
            if let Some(program) = env.working_git().filter(|p| windows_git_exe(p) && on_disk(p)) {
                return GitProgram::Found { program };
            }
        }
        return GitProgram::Bare;
    }
    match env.working_git() {
        Some(program) if !is_apple_git_shim(&program) => {
            GitProgram::At { program, path: env.path.clone() }
        }
        _ => GitProgram::Unavailable,
    }
}

/// Whether a resolved git is a Windows program file by an absolute path
/// (`C:\…\git.exe`, `\\server\…\git.exe`).
fn windows_git_exe(path: &str) -> bool {
    let p = path.trim();
    let b = p.as_bytes();
    let absolute = p.starts_with(r"\\")
        || (b.len() > 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/'));
    absolute && p.to_ascii_lowercase().ends_with(".exe")
}

static SHELL_ENV: OnceLock<RwLock<Arc<ShellEnv>>> = OnceLock::new();

/// The user's `shell.pathOverride`, as the settings last said it. Every
/// re-probe asks this first, so nothing after startup can drop the override
/// (2026-10-16: a Codex update's re-probe replaced an override PATH with the
/// login shell's, and every claude/codex tile then failed "not found in
/// PATH" until a quit). `None` when unset or blank.
static PATH_OVERRIDE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// The last snapshot the login-shell probe gave (not an override's): what a
/// later probe is compared against before it may lose a tool.
static LAST_PROBE: std::sync::Mutex<Option<Arc<ShellEnv>>> = std::sync::Mutex::new(None);

/// One re-probe at a time. A login-shell probe takes seconds; without this a
/// Codex update's re-probe that read "no override" before Settings set one
/// could finish after the Settings re-probe and put the login shell's PATH
/// back (last writer wins). Held across the read of the override and the
/// write of the cache, so the re-probe that finishes last always applied
/// the override as it stands.
static REPROBE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 1.176.1: told each snapshot published after startup (`cli_seen::observe`:
/// a tool that changed under the person is said once). Set once by
/// `cli_seen::install`; unset in unit tests.
static OBSERVER: OnceLock<fn(&ShellEnv)> = OnceLock::new();

pub fn set_observer(observer: fn(&ShellEnv)) {
    let _ = OBSERVER.set(observer);
}

fn published(env: &ShellEnv) {
    if let Some(observer) = OBSERVER.get() {
        observer(env);
    }
}

pub fn init() {
    let initial = Arc::new(settle_unknown(None, run_probe(), retry_cli_version));
    *LAST_PROBE.lock().unwrap_or_else(|p| p.into_inner()) = Some(initial.clone());
    let _ = SHELL_ENV.set(RwLock::new(initial));
}

/// Record the user's `shell.pathOverride` (blank counts as none). Returns
/// whether it changed. It does not probe: startup applies it right after
/// (`apply_path_override`), and `settings_set` re-probes when it changed.
pub fn configure_path_override(path: Option<&str>) -> bool {
    let next = path.filter(|p| !p.trim().is_empty()).map(str::to_string);
    let mut held = PATH_OVERRIDE.lock().unwrap_or_else(|p| p.into_inner());
    let changed = *held != next;
    *held = next;
    changed
}

/// The override [`configure_path_override`] recorded, if any.
pub fn path_override() -> Option<String> {
    PATH_OVERRIDE.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/// 1.176.1: what the login shell reported (the last probe's PATH, which
/// startup runs whether or not an override is set): `$PATH` for the Program
/// folders row and "what your shell reports". `None` before the first probe.
pub fn shell_reported_path() -> Option<String> {
    LAST_PROBE.lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(|e| e.path.clone())
}

/// Re-resolve the tools and replace the cached state. Returns the fresh
/// snapshot. Called from Settings › Diagnostics' "Look again"
/// (`shell_env_retry`), Setup's guided runner after an install, a Codex
/// update, and a changed PATH override. With an override set it is applied
/// exactly as at startup; without one the login shell is probed again.
pub fn re_probe() -> Arc<ShellEnv> {
    re_probe_with(run_probe)
}

fn re_probe_with(probe: impl FnOnce() -> ShellEnv) -> Arc<ShellEnv> {
    let _one_at_a_time = REPROBE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(path) = path_override() {
        let env = apply_path_override(&path);
        log::info!(
            "shell_env: re-probe kept the pathOverride; claude={} codex={}",
            env.claude_path.as_deref().unwrap_or("<not found>"),
            env.codex_path.as_deref().unwrap_or("<not found>"),
        );
        return env;
    }
    let previous = LAST_PROBE.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let fresh = probe();
    let fresh = match previous.as_deref() {
        Some(previous) => keep_lost_tools(previous, fresh, |p| Path::new(p).is_file(), probe_cli_version),
        None => fresh,
    };
    let fresh = settle_unknown(previous.as_deref(), fresh, retry_cli_version);
    let fresh = Arc::new(fresh);
    *LAST_PROBE.lock().unwrap_or_else(|p| p.into_inner()) = Some(fresh.clone());
    match SHELL_ENV.get() {
        Some(lock) => *lock.write() = fresh.clone(),
        None => {
            let _ = SHELL_ENV.set(RwLock::new(fresh.clone()));
        }
    }
    published(&fresh);
    fresh
}

/// A re-probe must not lose claude or codex that the last probe found and
/// that is still on disk: a login shell that answers differently this time
/// (a timeout, a dotfile mid-edit, an updater's own environment) is not the
/// tool going away. The previous PATH's directories are appended to the new
/// PATH (as the known installer dirs are) and the lost tools resolved
/// through it. A tool whose file is gone is let go; a newly installed one is
/// kept either way.
///
/// 1.176.0 R3: a kept tool's version is asked again (`version`, bounded),
/// never copied from the last probe: a file still on disk is not a tool that
/// still starts — after a failed update the launcher can point at a payload
/// that is gone or truncated, and a copied version made it look healthy.
fn keep_lost_tools(
    previous: &ShellEnv,
    mut fresh: ShellEnv,
    exists: impl Fn(&str) -> bool,
    version: impl Fn(&str, &str) -> VersionAnswer + Sync,
) -> ShellEnv {
    let lost = |was: &Option<String>, now: &Option<String>| {
        now.is_none() && was.as_deref().is_some_and(&exists)
    };
    let lost_claude = lost(&previous.claude_path, &fresh.claude_path);
    let lost_codex = lost(&previous.codex_path, &fresh.codex_path);
    if !lost_claude && !lost_codex {
        return fresh;
    }
    let names: Vec<&str> = [(lost_claude, "claude"), (lost_codex, "codex")]
        .into_iter()
        .filter_map(|(lost, name)| lost.then_some(name))
        .collect();
    log::warn!(
        "shell_env: re-probe lost {} still on disk; keeping the previous PATH entries",
        names.join(" and ")
    );
    fresh.path = augment_path(&fresh.path, &crate::platform::split_path_list(&previous.path));
    // R4 (review 2): the same rule as a probe (`choose_copy`).
    let pick = |binary: &str| {
        let candidates = candidates_for(None, &fresh.path, binary);
        let Some(first) = candidates.first() else { return (None, None, None) };
        let answer = version(first, &fresh.path);
        choose_copy(&candidates, answer, false, &fresh.path, &version)
    };
    if lost_claude {
        let (path, answer, skipped) = pick("claude");
        fresh.claude_path = path;
        fresh.claude_path_skipped = skipped;
        (fresh.claude_version, fresh.claude_version_unknown) = VersionAnswer::fields(answer);
    }
    if lost_codex {
        let (path, answer, skipped) = pick("codex");
        fresh.codex_path = path;
        fresh.codex_path_skipped = skipped;
        (fresh.codex_version, fresh.codex_version_unknown) = VersionAnswer::fields(answer);
    }
    if fresh.probe_error.as_deref() == Some(NO_AI_PROBE_ERROR) {
        fresh.probe_error = ai_probe_error(fresh.claude_path.is_some(), fresh.codex_path.is_some(), false);
    }
    fresh
}

/// v1.0: Apply a user-configured `pathOverride` from settings. If `Some`, skip
/// the bash login probe entirely and resolve `claude` against the supplied
/// PATH-style string directly. This is the workaround for environments where
/// `bash -lc` doesn't see the same PATH the user does (sandboxing, dotfile
/// quirks, missing `~/.bash_profile`-sources-`~/.bashrc` chain). Called from
/// `lib.rs::setup` after the settings store loads, and by [`re_probe`] while
/// [`configure_path_override`] holds one.
pub fn apply_path_override(path: &str) -> Arc<ShellEnv> {
    // 1.176.1: a saved value that can't work is named in the log, never
    // rewritten: tiles get exactly the PATH the person set (hard rule 2).
    // Plyloft's own steps add the system folders after it (`steps_path`).
    let verdict = crate::program_folders::read_list(
        path,
        &crate::program_folders::Ctx::now(),
        &crate::program_folders::SystemDisk,
    );
    if verdict.malformed() || verdict.missing.len() == crate::program_folders::TOOLS.len() {
        log::warn!(
            "shell_env: the Program folders setting finds {:?}, misses {:?}; problems {:?}",
            verdict.found.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            verdict.missing,
            verdict.problems,
        );
    }
    // R4 (B2): under an override nothing is skipped, only reported.
    let (claude_path, claude_version, claude_version_unknown, claude_path_skipped) =
        resolve_cli(None, path, "claude", true);
    let (codex_path, codex_version, codex_version_unknown, codex_path_skipped) =
        resolve_cli(None, path, "codex", true);
    let git = probe_git(find_in_path(path, "git"), path);
    let gh_path = find_in_path(path, "gh");
    let gh_version = gh_path
        .as_deref()
        .and_then(|tool_path| probe_tool_version(tool_path, path));
    let probe_error = ai_probe_error(claude_path.is_some(), codex_path.is_some(), true);
    let (node_path, node_version) = probe_node(path);
    let env = ShellEnv {
        path: path.to_string(),
        shell: crate::platform::default_shell(),
        claude_path,
        claude_version,
        codex_path,
        codex_version,
        claude_version_unknown,
        codex_version_unknown,
        git_path: git.path,
        git_version: git.version,
        gh_path,
        gh_version,
        probe_error,
        clt_installed: git.clt_installed,
        git_bash_path: git_bash(path),
        node_path,
        node_version,
        proxy_env: process_proxy_env(),
        claude_path_skipped,
        codex_path_skipped,
    };
    let env = settle_unknown(try_get().as_deref(), env, retry_cli_version);
    let arc = Arc::new(env);
    match SHELL_ENV.get() {
        Some(lock) => *lock.write() = arc.clone(),
        None => {
            let _ = SHELL_ENV.set(RwLock::new(arc.clone()));
        }
    }
    published(&arc);
    arc
}

/// The first file `binary` names on `path`. On Windows a bare name is looked
/// up with each PATHEXT extension (`git` → `git.exe`, `codex` → `codex.cmd`).
pub fn find_in_path(path: &str, binary: &str) -> Option<String> {
    crate::platform::split_path_list(path)
        .iter()
        .flat_map(|dir| crate::platform::program_candidates(dir, binary))
        .find(|candidate| candidate.is_file())
        .map(|candidate| candidate.to_string_lossy().to_string())
}

/// GH #68: where a tile's program actually runs from. A PTY spawn resolves a
/// bare name (`zsh`) through the cached PATH, so the doctor must too; a name
/// with a slash is taken as a path. Only an executable file counts: a spawn
/// skips anything else on PATH and fails on it as a path.
pub fn resolve_program(program: &str, path: &str) -> Option<String> {
    #[cfg(unix)]
    if program.contains('/') {
        return is_executable_file(Path::new(program)).then(|| program.to_string());
    }
    // A Windows path may still leave off its extension (`C:\...\pwsh`).
    #[cfg(windows)]
    if program.contains(['/', '\\']) {
        return crate::platform::program_candidates(Path::new(""), program)
            .into_iter()
            .find(|candidate| is_executable_file(candidate))
            .map(|candidate| candidate.to_string_lossy().to_string());
    }
    crate::platform::split_path_list(path)
        .iter()
        .flat_map(|dir| crate::platform::program_candidates(dir, program))
        .find(|candidate| is_executable_file(candidate))
        .map(|candidate| candidate.to_string_lossy().to_string())
}

pub(crate) fn is_executable_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|meta| crate::platform::is_executable(path, &meta))
        .unwrap_or(false)
}

/// The bash Ply runs project scripts with (verify steps, install scripts).
/// On unix `bash` from `path`, as always. On Windows Git Bash, found from the
/// `git` on `path` or where Git for Windows installs, and None without it:
/// never a bare `bash`, which Windows resolves to System32's WSL launcher
/// (another OS, another toolchain) before it searches PATH.
pub fn bash_program(path: &str) -> Option<std::ffi::OsString> {
    #[cfg(unix)]
    {
        let _ = path;
        Some("bash".into())
    }
    #[cfg(windows)]
    {
        let var = |key: &str| std::env::var_os(key).filter(|v| !v.is_empty());
        let git = find_in_path(path, "git").map(PathBuf::from);
        let exec_path = || git.as_deref().and_then(git_exec_path);
        find_git_bash(git.clone(), exec_path, path, var, |p| p.is_file())
            .map(PathBuf::into_os_string)
    }
}

/// How a `bash -c` line names bash to run a script with: `bash` on unix, as
/// always; on Windows the resolved Git Bash, single-quoted with forward
/// slashes (bash reads `\\` as an escape), so the script can't get another
/// bash from the step's PATH. `bash` when none is found: the step then fails
/// on its own.
pub fn bash_word(path: &str) -> String {
    #[cfg(unix)]
    {
        let _ = path;
        "bash".into()
    }
    #[cfg(windows)]
    {
        match bash_program(path) {
            Some(bash) => {
                let bash = bash.to_string_lossy().replace('\\', "/").replace('\'', "'\\''");
                format!("'{bash}'")
            }
            None => "bash".into(),
        }
    }
}

/// `git --exec-path` (`<Git>/mingw64/libexec/git-core`): where Git really is
/// when the `git.exe` on PATH is a shim (Scoop's `shims\git.exe`).
#[cfg(windows)]
fn git_exec_path(git: &Path) -> Option<PathBuf> {
    let out = crate::platform::new_command(git)
        .arg("--exec-path")
        .output()
        .ok()?;
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !dir.is_empty()).then(|| PathBuf::from(dir))
}

/// Git Bash's `bin\bash.exe`, in this order: in the Git install above the
/// `git.exe` on PATH (`<Git>\cmd`, `<Git>\bin`, `<Git>\mingw64\bin`), above
/// `git --exec-path` (asked only when that finds nothing), under Program
/// Files or the per-user install, and last any `bash.exe` on PATH that isn't
/// WSL's. A directory counts as a Git install only with Git's own layout
/// (`cmd\git.exe` or `usr\bin\bash.exe` beside `bin\bash.exe`), and nothing
/// under the Windows directory or WindowsApps counts. `bin\bash.exe` rather
/// than `usr\bin\bash.exe`: it puts Git's `usr\bin` tools (dirname, sed, grep)
/// on the script's PATH.
#[cfg(windows)]
fn find_git_bash(
    git: Option<PathBuf>,
    exec_path: impl FnOnce() -> Option<PathBuf>,
    path: &str,
    var: impl Fn(&str) -> Option<std::ffi::OsString>,
    is_file: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let system_root = var("SystemRoot").map(PathBuf::from);
    let wsl = |p: &Path| is_wsl_launcher(p, system_root.as_deref());
    let git_install = |root: &Path| {
        let bash = root.join("bin").join("bash.exe");
        let layout = is_file(&root.join("cmd").join("git.exe"))
            || is_file(&root.join("usr").join("bin").join("bash.exe"));
        (!wsl(&bash) && layout && is_file(&bash)).then_some(bash)
    };
    let above = |from: &Path, levels: usize| {
        if wsl(from) {
            return None;
        }
        from.ancestors().skip(1).take(levels).find_map(|root| git_install(root))
    };

    if let Some(bash) = git.as_deref().and_then(|git| above(git, 3)) {
        return Some(bash);
    }
    if let Some(bash) = exec_path().and_then(|dir| above(&dir.join("git.exe"), 4)) {
        return Some(bash);
    }
    let installed = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|key| var(key).map(|dir| PathBuf::from(dir).join("Git")))
        .chain(var("LOCALAPPDATA").map(|dir| PathBuf::from(dir).join("Programs").join("Git")))
        .find_map(|root| git_install(&root));
    if installed.is_some() {
        return installed;
    }
    crate::platform::split_path_list(path)
        .into_iter()
        .map(|dir| dir.join("bash.exe"))
        .find(|bash| !wsl(bash) && is_file(bash))
}

/// Anything under the Windows directory (System32's `bash.exe`) or a
/// WindowsApps alias starts WSL, not Git Bash.
#[cfg(windows)]
fn is_wsl_launcher(bash: &Path, system_root: Option<&Path>) -> bool {
    let lower = |p: &Path| p.to_string_lossy().replace('/', "\\").to_ascii_lowercase();
    let bash = lower(bash);
    let under_windows = system_root.is_some_and(|root| {
        bash.starts_with(&format!("{}\\", lower(root).trim_end_matches('\\')))
    });
    under_windows || bash.contains("\\system32\\") || bash.contains("\\windowsapps\\")
}

pub fn get() -> Arc<ShellEnv> {
    SHELL_ENV
        .get()
        .expect("shell_env not initialized")
        .read()
        .clone()
}

pub fn try_get() -> Option<Arc<ShellEnv>> {
    SHELL_ENV.get().map(|env| env.read().clone())
}

/// Test-only: serializes tests that swap the cached PATH for one without
/// the tools (`apply_path_override` to a scratch dir) with tests that resolve
/// a tool through it (`doctor::require("git")`) — GH #190 review 1.
#[cfg(test)]
pub fn lock_for_test() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Test-only override: replaces (or installs) the cached shell env. Used by
/// integration tests that need a fake `claude` binary without invoking the
/// real bash probe.
#[cfg(test)]
pub fn set_for_test(env: ShellEnv) {
    let arc = Arc::new(env);
    match SHELL_ENV.get() {
        Some(lock) => *lock.write() = arc,
        None => {
            let _ = SHELL_ENV.set(RwLock::new(arc));
        }
    }
}

/// Fields parsed out of the `bash -lc` probe stdout. Empty/None for missing or
/// blank lines.
#[derive(Default)]
struct ProbeFields {
    path: String,
    shell: String,
    claude_path: Option<String>,
    codex_path: Option<String>,
    git_path: Option<String>,
    gh_path: Option<String>,
    /// OB-3: `PROXY=<NAME>=<value>` lines, names from [`PROXY_VARS`] only.
    proxy_env: Vec<(String, String)>,
}

/// Pure parser for the `bash -lc` probe output. Extracted so the additive
/// GIT=/GH= lines can be tested without spawning a real shell.
#[cfg_attr(windows, allow(dead_code))]
fn parse_probe_output(stdout: &str) -> ProbeFields {
    let mut f = ProbeFields::default();
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("PATH=") {
            f.path = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("SHELL=") {
            f.shell = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("CLAUDE=") {
            let trimmed = rest.trim();
            if !trimmed.is_empty() {
                f.claude_path = Some(trimmed.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("CODEX=") {
            let trimmed = rest.trim();
            if !trimmed.is_empty() {
                f.codex_path = Some(trimmed.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("GIT=") {
            let trimmed = rest.trim();
            if !trimmed.is_empty() {
                f.git_path = Some(trimmed.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("GH=") {
            let trimmed = rest.trim();
            if !trimmed.is_empty() {
                f.gh_path = Some(trimmed.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("PROXY=") {
            if let Some((name, value)) = rest.split_once('=') {
                if PROXY_VARS.contains(&name) && !value.trim().is_empty() {
                    f.proxy_env.push((name.to_string(), value.trim().to_string()));
                }
            }
        }
    }
    f
}

/// The probe script: prints the resolved PATH/SHELL and where each tool
/// resolves. Shell-neutral (`printf` + `command -v`) so zsh and bash both
/// run it unchanged.
#[cfg_attr(windows, allow(dead_code))]
const PROBE_SCRIPT: &str = "printf 'PATH=%s\\n' \"$PATH\"; printf 'SHELL=%s\\n' \"$SHELL\"; cv=$(command -v claude 2>/dev/null); printf 'CLAUDE=%s\\n' \"$cv\"; xv=$(command -v codex 2>/dev/null); printf 'CODEX=%s\\n' \"$xv\"; gtv=$(command -v git 2>/dev/null); printf 'GIT=%s\\n' \"$gtv\"; ghv=$(command -v gh 2>/dev/null); printf 'GH=%s\\n' \"$ghv\"; for pv in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy NO_PROXY no_proxy ALL_PROXY all_proxy; do eval \"pvv=\\${$pv-}\"; [ -n \"$pvv\" ] && printf 'PROXY=%s=%s\\n' \"$pv\" \"$pvv\"; done; :";

/// OB-3: the proxy variables Setup's guided terminal carries, in both cases
/// (curl reads only the lowercase `http_proxy`; most tools read either).
pub const PROXY_VARS: [&str; 8] = [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
    "ALL_PROXY",
    "all_proxy",
];

/// Pure: the [`PROXY_VARS`] that `lookup` gives a non-blank value, in that
/// order — the process environment's, on Windows or when the probe failed.
pub fn proxy_env_from(lookup: impl Fn(&str) -> Option<String>) -> Vec<(String, String)> {
    PROXY_VARS
        .iter()
        .filter_map(|name| {
            let value = lookup(name)?;
            (!value.trim().is_empty()).then(|| (name.to_string(), value.trim().to_string()))
        })
        .collect()
}

fn process_proxy_env() -> Vec<(String, String)> {
    proxy_env_from(|name| std::env::var(name).ok())
}

/// Upper bound on the login-shell probe. An interactive rc file that blocks
/// (waits on a tty, execs a multiplexer) must not hang app start; on timeout
/// the probe falls back to the process environment plus the known tool dirs.
#[cfg_attr(windows, allow(dead_code))]
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// v1.113.0: which shell runs the probe, and with which flags.
///
/// Before 1.113 the probe was a fixed `/bin/bash -lc`. On a fresh Mac the
/// login shell is zsh and the official Claude installer appends its PATH
/// line to `~/.zshrc` — a file bash never reads — so a correctly installed
/// CLI was reported as "not found" (owner's second Mac, 2026-09-10).
///
/// - zsh: `-ilc`. `.zshrc` is an *interactive*-only file, so a plain login
///   shell (`-lc`) would still miss it. This is what editors do for shell
///   environment resolution on macOS.
/// - bash: `-lc`, unchanged (`.bash_profile` conventionally sources
///   `.bashrc`).
/// - anything else (fish, nu, missing): `/bin/bash -lc` — the probe script
///   is POSIX, those shells are not.
#[cfg_attr(windows, allow(dead_code))]
fn probe_shell_for(shell: Option<&str>, exists: impl Fn(&str) -> bool) -> (String, &'static str) {
    if let Some(shell) = shell {
        let name = Path::new(shell)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if exists(shell) {
            match name.as_str() {
                "zsh" => return (shell.to_string(), "-ilc"),
                "bash" => return (shell.to_string(), "-lc"),
                _ => {}
            }
        }
    }
    ("/bin/bash".to_string(), "-lc")
}

/// Directories the official CLI installers use, plus Homebrew. Appended
/// (never prepended — the user's own PATH order wins) when the shell probe
/// leaves a tool unresolved, so a PATH line the shell never sourced is not
/// fatal. Both `claude.ai/install.sh` and `chatgpt.com/codex/install.sh`
/// install into `~/.local/bin`; `~/.claude/local` is Claude's own
/// self-managed install location. On Windows: npm's global bin, Git for
/// Windows, the GitHub CLI, cargo, scoop and WinGet.
fn known_tool_dirs(home: Option<&str>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = home {
        let home = Path::new(home);
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".claude").join("local"));
        #[cfg(windows)]
        {
            dirs.push(home.join(".cargo").join("bin"));
            dirs.push(home.join("scoop").join("shims"));
        }
    }
    #[cfg(unix)]
    {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }
    #[cfg(windows)]
    {
        let var = |key: &str| std::env::var_os(key).filter(|v| !v.is_empty()).map(PathBuf::from);
        let home = home.map(Path::new);
        let appdata = var("APPDATA")
            .or_else(|| home.map(|h| h.join("AppData").join("Roaming")));
        let local = var("LOCALAPPDATA").or_else(|| home.map(|h| h.join("AppData").join("Local")));
        if let Some(appdata) = appdata {
            dirs.push(appdata.join("npm"));
        }
        if let Some(local) = local {
            dirs.push(local.join("Programs"));
            dirs.push(local.join("Programs").join("claude"));
            // OB-3: where Codex's install.ps1 and a per-user Git for Windows
            // land (MEASUREMENTS §7), so the re-probe after Setup's install
            // finds them without a relaunch.
            dirs.push(local.join("Programs").join("OpenAI").join("Codex").join("bin"));
            dirs.push(local.join("Programs").join("Git").join("cmd"));
            dirs.push(local.join("Microsoft").join("WinGet").join("Links"));
        }
        let program_files = var("ProgramFiles").unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
        dirs.push(program_files.join("Git").join("cmd"));
        dirs.push(program_files.join("GitHub CLI"));
    }
    dirs
}

/// Append every `dirs` entry that exists on disk and is not already in
/// `path`. Pure apart from the existence check; order of `path` is kept.
fn augment_path(path: &str, dirs: &[PathBuf]) -> String {
    let mut parts: Vec<String> = crate::platform::split_path_list(path)
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    for dir in dirs {
        if !dir.is_dir() {
            continue;
        }
        let candidate = dir.to_string_lossy().into_owned();
        if !parts.iter().any(|p| same_dir(p, &candidate)) {
            parts.push(candidate);
        }
    }
    crate::platform::join_path_list(&parts)
}

/// Whether two PATH entries name the same directory: byte-equal on unix; on
/// Windows case-insensitive and regardless of a trailing separator.
fn same_dir(a: &str, b: &str) -> bool {
    #[cfg(unix)]
    {
        a == b
    }
    #[cfg(windows)]
    {
        let trim = |s: &str| s.trim_end_matches(['\\', '/']).to_string();
        trim(a).eq_ignore_ascii_case(&trim(b))
    }
}

/// GH #68: what `<shell> --version` prints, for the doctor's "Dictation in
/// shell tiles" row. Bounded like the login probe: the doctor command runs on
/// an IPC thread and must not hang on a shell that never exits.
pub fn shell_version_output(shell: &str, effective_path: &str) -> Option<String> {
    let out = output_with_timeout(
        crate::platform::new_command(shell).arg("--version").env("PATH", effective_path),
        Duration::from_secs(2),
    )
    .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// GH #103 (Diagnostics): whether `gh` has an account signed in, and what it
/// said. `gh auth status` exits 0 when it does; it validates the stored token
/// over the network, so this has a longer bound than the version probes and a
/// timeout comes back as `None` — "Ply could not tell", never "signed out".
///
/// GH #194: asked as `gh auth status --json hosts --active` (gh 2.81 and
/// later), whose per-account `error` tells a token GitHub refused from a check
/// that got no answer — the text words both `The token in … is invalid`. It is
/// the same one check over the network. Review 1: `--active` makes gh check
/// only each host's active account, so an inactive account costs no keychain
/// read and no API call, and cannot decide the row (GH #195). `--json` exits 0
/// unless gh hits a fatal error, so the `bool` is what the plain command's
/// exit status would have said: every account listed succeeded
/// (`doctor::gh_json_all_succeeded`). A gh that does not know either flag
/// stops at it, before any network call, and is asked the plain way instead;
/// the doctor then reads the active account's block from the text. There is
/// no middle `--active` text ask: it would be a third spawn on some older gh
/// for an answer the text reading already gives.
pub fn gh_auth_output(gh: &str, effective_path: &str) -> Option<(bool, String)> {
    let (ok, text) = gh_auth_run(gh, effective_path, true)?;
    if crate::doctor::gh_flags_unsupported(ok, &text) {
        return gh_auth_run(gh, effective_path, false);
    }
    let ok = crate::doctor::gh_json_all_succeeded(&text).unwrap_or(ok);
    Some((ok, text))
}

/// `gh auth status --json hosts --active`; the first two alone are the plain
/// ask for a gh without the flags.
const GH_AUTH_JSON_ARGS: &[&str] = &["auth", "status", "--json", "hosts", "--active"];

fn gh_auth_run(gh: &str, effective_path: &str, json: bool) -> Option<(bool, String)> {
    let mut command = crate::platform::new_command(gh);
    command
        .args(if json { GH_AUTH_JSON_ARGS } else { &GH_AUTH_JSON_ARGS[..2] })
        .env("PATH", effective_path)
        .env("GH_PROMPT_DISABLED", "1");
    // GH #204 review 1: its own process group, killed whole at the bound and
    // on app exit; a helper left holding a pipe can't hang the read.
    let out = crate::worktrees::run_bounded_output(&mut command, Duration::from_secs(6)).ok()?;
    let mut text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    // `gh auth status` prints to stderr on some versions and stdout on others;
    // with `--json`, the JSON is on stdout, so it comes first.
    if !err.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&err);
    }
    Some((out.status.success(), text))
}

/// `Command::output()` with a wall-clock bound. Polls `try_wait` so a hung
/// child is killed instead of blocking the caller forever.
fn output_with_timeout(
    cmd: &mut Command,
    timeout: Duration,
) -> std::io::Result<std::process::Output> {
    use std::process::Stdio;
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let started = Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("probe exceeded {}s", timeout.as_secs()),
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    child.wait_with_output()
}

fn run_probe() -> ShellEnv {
    let mut probe_error: Option<String> = None;
    let fallback_fields = || ProbeFields {
        path: std::env::var("PATH").unwrap_or_default(),
        shell: crate::platform::default_shell(),
        proxy_env: process_proxy_env(),
        ..ProbeFields::default()
    };
    // Windows has no login shell to ask: a process's PATH is built from the
    // registry (system then user) at its launch, which is what a new terminal
    // gets too. 1.176.2 R1 (A1-03): the registry is read again at each probe
    // and any folder added there since launch is appended (never removed or
    // reordered), so a tool installed while Plyloft is open is found by Look
    // again. The known tool dirs below stay the extra layer.
    #[cfg(windows)]
    let fields = {
        let mut fields = fallback_fields();
        fields.path = crate::registry_path::current(&fields.path);
        fields
    };
    #[cfg(unix)]
    let fields = {
        let user_shell = std::env::var("SHELL").ok();
        let (program, flag) = probe_shell_for(user_shell.as_deref(), |p| Path::new(p).is_file());
        let probe_label = format!("{program} {flag}");
        let probe = output_with_timeout(
            crate::platform::new_command(&program).args([flag, PROBE_SCRIPT]),
            PROBE_TIMEOUT,
        );
        match probe {
            Ok(out) if out.status.success() => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                parse_probe_output(&stdout)
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                probe_error = Some(format!(
                    "Login shell probe (`{probe_label}`) exited with status {}: {}",
                    out.status,
                    stderr.trim()
                ));
                fallback_fields()
            }
            Err(e) => {
                probe_error = Some(format!("Login shell probe (`{probe_label}`) failed: {e}"));
                fallback_fields()
            }
        }
    };
    let ProbeFields {
        path,
        shell,
        claude_path,
        codex_path,
        git_path,
        gh_path,
        proxy_env,
    } = fields;

    let shell = if shell.is_empty() {
        crate::platform::default_shell()
    } else {
        shell
    };

    // v1.113.0: a PATH line the probe shell never sourced must not hide a
    // correctly installed CLI. Append the installers' directories and
    // resolve anything still missing against the widened PATH; PTYs inherit
    // the same widened PATH so tiles agree with the doctor.
    let home = crate::platform::home_dir().map(|h| h.to_string_lossy().into_owned());
    let path = augment_path(&path, &known_tool_dirs(home.as_deref()));
    // R4 (B2): every copy on the widened PATH is a candidate; the first that
    // certainly doesn't start gives way to a later one that does.
    let (claude_path, claude_version, claude_version_unknown, claude_path_skipped) =
        resolve_cli(claude_path, &path, "claude", false);
    let (codex_path, codex_version, codex_version_unknown, codex_path_skipped) =
        resolve_cli(codex_path, &path, "codex", false);
    let git_path = git_path.or_else(|| find_in_path(&path, "git"));
    let gh_path = gh_path.or_else(|| find_in_path(&path, "gh"));

    if probe_error.is_none() {
        probe_error = ai_probe_error(claude_path.is_some(), codex_path.is_some(), false);
    }

    let git = probe_git(git_path, &path);
    let gh_version = gh_path
        .as_deref()
        .and_then(|tool_path| probe_tool_version(tool_path, &path));
    let (node_path, node_version) = probe_node(&path);
    let git_bash_path = git_bash(&path);

    ShellEnv {
        path,
        shell,
        claude_path,
        claude_version,
        codex_path,
        codex_version,
        claude_version_unknown,
        codex_version_unknown,
        git_path: git.path,
        git_version: git.version,
        gh_path,
        gh_version,
        probe_error,
        clt_installed: git.clt_installed,
        git_bash_path,
        node_path,
        node_version,
        proxy_env,
        claude_path_skipped,
        codex_path_skipped,
    }
}

/// OB-2 (§13.1): the probe's words when **neither** AI tool resolved. One AI
/// is enough, so a Codex-only Mac has no probe error; Claude missing alone is
/// the doctor row's to say, not a broken probe.
pub const NO_AI_PROBE_ERROR: &str = "No AI tool found. Install Claude Code or Codex, or set a PATH override in Settings › Look and feel › Editor and terminals.";

/// The same, when the PATH came from the user's override.
/// The login shell was not asked, so the words name only that PATH.
#[cfg(not(windows))]
pub const NO_AI_OVERRIDE_ERROR: &str = NO_AI_OVERRIDE_ERROR_MAC;
/// 1.176.1: Windows has no login shell to ask (`run_probe`): cleared, the
/// setting gives way to the folders Windows gave Plyloft.
#[cfg(windows)]
pub const NO_AI_OVERRIDE_ERROR: &str = NO_AI_OVERRIDE_ERROR_WINDOWS;
pub const NO_AI_OVERRIDE_ERROR_MAC: &str = "Neither claude nor codex is in your Program folders (Settings › Look and feel › Editor and terminals). Check them, or empty them so Plyloft asks your login shell again.";
pub const NO_AI_OVERRIDE_ERROR_WINDOWS: &str = "Neither claude nor codex is in your Program folders (Settings › Look and feel › Editor and terminals). Check them, or empty them so Plyloft looks in the folders Windows gave it again.";

/// Pure: the AI part of `probe_error`.
pub fn ai_probe_error(claude_found: bool, codex_found: bool, override_path: bool) -> Option<String> {
    if claude_found || codex_found {
        return None;
    }
    Some(if override_path { NO_AI_OVERRIDE_ERROR } else { NO_AI_PROBE_ERROR }.to_string())
}

/// What the git probe learnt.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct GitProbe {
    pub path: Option<String>,
    pub version: Option<String>,
    pub clt_installed: Option<bool>,
}

/// Apple's shims in `/usr/bin` (git, make, clang…) run the Command Line
/// Tools' binary, and without them open the "requires the command line
/// developer tools" dialog. The real git lives under the CLT or Xcode.
pub fn is_apple_git_shim(path: &str) -> bool {
    path == "/usr/bin/git"
}

/// Which git the probe may run, and which one the row reports.
#[derive(Debug, Clone, PartialEq)]
pub struct GitChoice {
    /// The git the report names (resolved on PATH, or the working one found
    /// after skipping the shim).
    pub path: Option<String>,
    /// Whether `--version` may run on it.
    pub run: bool,
}

/// OB-2 (C9, MEASUREMENTS §12): pure. On macOS `clt` is `xcode-select -p`'s
/// answer, asked first. With the Command Line Tools, or off macOS (`None`),
/// the resolved git runs as always. Without them the `/usr/bin/git` shim is
/// **never** run — it would pop Apple's install dialog unasked — and another
/// git on PATH (Homebrew's) is used instead when there is one: a working git
/// is enough, the CLT are not required.
pub fn choose_git(resolved: Option<&str>, clt: Option<bool>, others: &[String]) -> GitChoice {
    match (resolved, clt) {
        (Some(git), Some(false)) if is_apple_git_shim(git) => {
            match others.iter().find(|p| !is_apple_git_shim(p)) {
                Some(other) => GitChoice { path: Some(other.clone()), run: true },
                None => GitChoice { path: Some(git.to_string()), run: false },
            }
        }
        (Some(git), _) => GitChoice { path: Some(git.to_string()), run: true },
        (None, _) => GitChoice { path: None, run: false },
    }
}

/// `xcode-select -p` — the safe CLT probe: it fails without any dialog.
/// Bounded, like every probe. `None` off macOS.
pub(crate) fn clt_installed() -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        let mut command = crate::platform::new_command("/usr/bin/xcode-select");
        command.arg("-p");
        let outcome = crate::worktrees::run_bounded_output(&mut command, Duration::from_secs(5))
            .map(|out| out.status.code())
            .map_err(|failure| format!("{failure:?}"));
        if let Err(error) = &outcome {
            log::warn!("shell_env: xcode-select -p gave no answer ({error}); git runs as before");
        }
        clt_from(outcome)
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// OB-2 review (P3-1): pure. Only a clean exit decides: 0 = the CLT are
/// there, any other code = they are not. A timeout, a spawn error or a kill
/// by signal is **unknown** (`None`), so git runs as it always did — one slow
/// `xcode-select` must not switch git off on a Mac that has the tools.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn clt_from(outcome: Result<Option<i32>, String>) -> Option<bool> {
    match outcome {
        Ok(Some(code)) => Some(code == 0),
        Ok(None) | Err(_) => None,
    }
}

/// Every `git` on `path`, in PATH order (for the no-CLT fallback).
fn all_gits_in_path(path: &str) -> Vec<String> {
    crate::platform::split_path_list(path)
        .into_iter()
        .map(|dir| dir.join("git"))
        .filter(|p| is_executable_file(p))
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// OB-2: the CLT check first (macOS), then `git --version` only on a git
/// [`choose_git`] allows.
fn probe_git(resolved: Option<String>, path: &str) -> GitProbe {
    let clt = if resolved.is_some() { clt_installed() } else { None };
    let others = if clt == Some(false) { all_gits_in_path(path) } else { Vec::new() };
    let choice = choose_git(resolved.as_deref(), clt, &others);
    let version = match (&choice.path, choice.run) {
        (Some(git), true) => probe_tool_version(git, path),
        _ => None,
    };
    GitProbe { path: choice.path, version, clt_installed: clt }
}

/// Git Bash on Windows (the doctor's row); `None` elsewhere.
fn git_bash(path: &str) -> Option<String> {
    #[cfg(windows)]
    {
        bash_program(path).map(|b| b.to_string_lossy().into_owned())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        None
    }
}

/// `node` on PATH, with its version asked on Windows only (the one platform
/// whose doctor shows a Node row).
fn probe_node(path: &str) -> (Option<String>, Option<String>) {
    let node = find_in_path(path, "node");
    let version = if cfg!(windows) {
        node.as_deref().and_then(|n| probe_tool_version(n, path))
    } else {
        None
    };
    (node, version)
}

/// Run `<codex> --version` and parse the first semver-shaped token. Codex may
/// print a PATH-alias warning on stderr before reporting its version.
#[cfg(all(test, unix))]
fn probe_codex_version(codex_path: &str, effective_path: &str) -> VersionAnswer {
    probe_cli_version(codex_path, effective_path)
}

/// Run `<tool> --version` and parse the first semver-shaped token. Same
/// best-effort semantics as `probe_cli_version`: any failure → None. Used
/// for `git` / `gh`, whose `--version` output (`git version 2.39.5 (Apple
/// Git-154)`, `gh version 2.40.0 (...)`) leads with a clean semver.
fn probe_tool_version(tool_path: &str, effective_path: &str) -> Option<String> {
    probe_command_version_within(tool_path, effective_path, TOOL_VERSION_TIMEOUT)
}

/// GH #204: `git --version` / `gh --version` print a line from the binary
/// itself, no network — a local call that answers in milliseconds. 10 s
/// covers a cold disk and macOS's first-launch check; a hung one then reads
/// as "version unknown" instead of stalling the dependency probe.
const TOOL_VERSION_TIMEOUT: Duration = Duration::from_secs(10);

/// `--version` with a wall-clock bound, run like every `gh`
/// (GH #204 review 1): its own process group, killed whole at the bound and
/// on app exit, and a grandchild left holding a pipe can't hang the read.
/// Then the version is unknown.
fn probe_command_version_within(
    tool_path: &str,
    effective_path: &str,
    timeout: Duration,
) -> Option<String> {
    // `platform::command`: on Windows an npm `.cmd` shim (claude or codex)
    // starts as the `node <script>` it runs; any other program as itself.
    version_answer_within(tool_path, effective_path, timeout).version()
}

/// 1.176.0 R3: what `<tool> --version` answered — three ways, never two.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum VersionAnswer {
    /// It ran and printed a version.
    Starts(String),
    /// It didn't start, or ran and printed nothing readable: a spawn error,
    /// a non-zero exit (the 2026-08-30 crashed wrapper), killed (R0 C4: 137).
    Fails,
    /// It didn't answer in time, or its output couldn't be read to the end.
    /// Slow is not broken: never read as "doesn't start".
    Unknown,
}

impl VersionAnswer {
    pub(crate) fn version(self) -> Option<String> {
        match self {
            Self::Starts(version) => Some(version),
            _ => None,
        }
    }

    /// The snapshot's two fields (`*_version`, `*_version_unknown`) for an
    /// answer; `None` for a tool that wasn't found.
    fn fields(answer: Option<Self>) -> (Option<String>, bool) {
        match answer {
            Some(Self::Starts(version)) => (Some(version), false),
            Some(Self::Unknown) => (None, true),
            Some(Self::Fails) | None => (None, false),
        }
    }
}

fn version_answer_within(tool_path: &str, effective_path: &str, timeout: Duration) -> VersionAnswer {
    // `platform::command`: on Windows an npm `.cmd` shim (claude or codex)
    // starts as the `node <script>` it runs; any other program as itself.
    let mut command = crate::platform::command(tool_path, effective_path);
    command.arg("--version").env("PATH", effective_path);
    match crate::worktrees::run_bounded_output(&mut command, timeout) {
        Ok(out) => match parse_version_output(&out.stdout, &out.stderr, out.status.success()) {
            Some(version) => VersionAnswer::Starts(version),
            None => exit_answer(&out.status),
        },
        Err(crate::worktrees::BoundedFailure::Spawn(e)) => spawn_answer(&e),
        Err(_) => VersionAnswer::Unknown,
    }
}

/// 1.176.0 R4 (review 2): a run that printed no version. A signal other
/// than SIGKILL (memory pressure's SIGTERM, a SIGSEGV of an intact binary)
/// is not a certain failure; SIGKILL — macOS killing a binary whose code
/// signature fails (R0 C4) — and a wrapper's 137 are, as is an exit code.
fn exit_answer(status: &std::process::ExitStatus) -> VersionAnswer {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return if signal == libc::SIGKILL { VersionAnswer::Fails } else { VersionAnswer::Unknown };
        }
    }
    let _ = status;
    VersionAnswer::Fails
}

/// 1.176.0 R4 (review 2): a spawn error is a certain failure only when it
/// says the file can't be run — gone (ENOENT), not allowed (EACCES/EPERM),
/// not a program (ENOEXEC, a bad Mach-O or architecture). Anything else
/// (ETXTBSY during an update, EAGAIN, ENOMEM, EMFILE, EINTR) is transient.
pub(crate) fn spawn_answer(error: &str) -> VersionAnswer {
    use crate::cli_health::StartFailure;
    match crate::cli_health::classify_spawn_error(error) {
        StartFailure::NotFound | StartFailure::PermissionDenied | StartFailure::BadBinary => VersionAnswer::Fails,
        _ => VersionAnswer::Unknown,
    }
}

/// Launch a resolved claude/codex with the same PATH that resolved it. This
/// matters for npm-style wrappers whose `#!/usr/bin/env node` shebang
/// performs a second lookup after Tauri has already found the wrapper itself.
///
/// 1.176.0 R3: bounded — it runs under the re-probe lock (`REPROBE`), so a
/// `--version` that hung held every later re-probe. The first try has R1's
/// first bound (`cli_health::VERSION_TIMEOUT`); a timeout is settled by
/// [`settle_unknown`], which keeps the same file's earlier version or tries
/// once more with the longer bound.
fn probe_cli_version(tool_path: &str, effective_path: &str) -> VersionAnswer {
    version_answer_within(tool_path, effective_path, crate::cli_health::VERSION_TIMEOUT)
}

/// The second try, with R1's longer bound (`cli_health::VERSION_RETRY_TIMEOUT`).
fn retry_cli_version(tool_path: &str, effective_path: &str) -> VersionAnswer {
    version_answer_within(tool_path, effective_path, crate::cli_health::VERSION_RETRY_TIMEOUT)
}

/// R3 review 1: a version that didn't answer in time. The same file the last
/// snapshot had a version for keeps it (no second wait); anything else is
/// asked once more with the longer bound (`retry`). Still no answer: the
/// tool stays `*_version_unknown` — present and usable, never "doesn't start".
fn settle_unknown(
    previous: Option<&ShellEnv>,
    mut env: ShellEnv,
    retry: impl Fn(&str, &str) -> VersionAnswer,
) -> ShellEnv {
    let path = env.path.clone();
    let settle = |tool: Option<&String>, version: &mut Option<String>, unknown: &mut bool, was: Option<(&Option<String>, &Option<String>)>| {
        if !*unknown {
            return;
        }
        let Some(tool) = tool else { return };
        if let Some((Some(was_path), Some(was_version))) = was {
            if was_path == tool {
                log::info!("shell_env: {tool} --version didn't answer in time; keeping {was_version}");
                *version = Some(was_version.clone());
                *unknown = false;
                return;
            }
        }
        (*version, *unknown) = VersionAnswer::fields(Some(retry(tool, &path)));
        if *unknown {
            log::warn!("shell_env: {tool} --version didn't answer in time, twice; taken as starting");
        }
    };
    settle(
        env.claude_path.as_ref(),
        &mut env.claude_version,
        &mut env.claude_version_unknown,
        previous.map(|p| (&p.claude_path, &p.claude_version)),
    );
    settle(
        env.codex_path.as_ref(),
        &mut env.codex_version,
        &mut env.codex_version_unknown,
        previous.map(|p| (&p.codex_path, &p.codex_version)),
    );
    env
}

/// R3 review 1: the narrow refresh a tile press makes for a tool found but
/// not starting — that one tool's `--version` asked again, no login shell,
/// nothing forgotten. Replaces the snapshot only when the answer changed and
/// the snapshot still has that path. Returns the snapshot as it is then.
/// 1.176.0 seams: a certain failure re-runs that tool's copy choice
/// ([`choose_copy`]) before answering.
pub(crate) fn recheck_version(claude: bool) -> Arc<ShellEnv> {
    let _one_at_a_time = REPROBE.lock().unwrap_or_else(|p| p.into_inner());
    let current = get();
    let tool = if claude { current.claude_path.clone() } else { current.codex_path.clone() };
    let Some(tool) = tool else { return current };
    let answer = probe_cli_version(&tool, &current.path);
    let mut next = (*current).clone();
    // 1.176.0 seams: a copy that broke mid-session — a certain failure —
    // gets the snapshot's copy choice again (`choose_copy`: the later copies
    // asked in parallel, each bounded; never under a PATH override), so a
    // later copy that works is the one tiles run, not "doesn't start".
    let (path, answer, skipped) = if answer == VersionAnswer::Fails {
        let candidates = candidates_for(Some(&tool), &current.path, if claude { "claude" } else { "codex" });
        let (path, answer, skipped) =
            choose_copy(&candidates, answer, path_override().is_some(), &current.path, probe_cli_version);
        (path.unwrap_or(tool), answer, skipped)
    } else {
        let skipped = if claude { current.claude_path_skipped.clone() } else { current.codex_path_skipped.clone() };
        (tool, Some(answer), skipped)
    };
    let (version, unknown) = VersionAnswer::fields(answer);
    if claude {
        (next.claude_path, next.claude_version, next.claude_version_unknown, next.claude_path_skipped) =
            (Some(path), version, unknown, skipped);
    } else {
        (next.codex_path, next.codex_version, next.codex_version_unknown, next.codex_path_skipped) =
            (Some(path), version, unknown, skipped);
    }
    if next.claude_path == current.claude_path
        && next.claude_version == current.claude_version
        && next.claude_version_unknown == current.claude_version_unknown
        && next.claude_path_skipped == current.claude_path_skipped
        && next.codex_path == current.codex_path
        && next.codex_version == current.codex_version
        && next.codex_version_unknown == current.codex_version_unknown
        && next.codex_path_skipped == current.codex_path_skipped
    {
        return current;
    }
    let next = Arc::new(next);
    if let Some(lock) = SHELL_ENV.get() {
        *lock.write() = next.clone();
    }
    published(&next);
    next
}

/// R3 review 5: a cheap look for `binary` with no login shell — the cached
/// PATH and the installers' folders (`known_tool_dirs`), executable files
/// only. For a start that may not look again yet (its cooldown).
pub(crate) fn find_cli_nearby(binary: &str, path: &str) -> Option<String> {
    let home = crate::platform::home_dir().map(|h| h.to_string_lossy().into_owned());
    let widened = augment_path(path, &known_tool_dirs(home.as_deref()));
    // R4 (review 2): consistent with `choose_copy` without a probe here (a
    // spawn may wait on it): a copy the last probe passed over for not
    // starting is passed over again.
    let skipped = try_get().and_then(|env| match binary {
        "claude" => env.claude_path_skipped.clone(),
        "codex" => env.codex_path_skipped.clone(),
        _ => None,
    });
    nearby_choice(find_all_in_path(&widened, binary), skipped.as_ref())
        .or_else(|| resolve_program(binary, &widened))
}

/// Pure: the first candidate, unless the last probe passed it over (not
/// under an override) and another is there.
fn nearby_choice(candidates: Vec<String>, skipped: Option<&PassedOver>) -> Option<String> {
    let passed = skipped.filter(|s| !s.kept_by_override).map(|s| s.path.as_str());
    candidates
        .iter()
        .find(|c| Some(c.as_str()) != passed)
        .or_else(|| candidates.first())
        .cloned()
}

/// `success` is the tool's exit status. It matters because the stderr fallback
/// is only safe on success: some CLIs print their banner to stderr after a
/// harmless warning, but a *failed* run puts a diagnostic there instead — and
/// a Node crash dump ends with the interpreter's own "Node.js vX.Y.Z" banner.
/// Reading that as the tool's version made a dead CLI look healthy (see
/// `crashed_wrapper_does_not_report_the_node_runtime_version`). On failure only
/// stdout is trusted, so a tool that prints its version and still exits
/// non-zero keeps working.
pub(crate) fn parse_version_output(stdout: &[u8], stderr: &[u8], success: bool) -> Option<String> {
    let from_stdout = parse_semver_from_text(&String::from_utf8_lossy(stdout));
    if !success {
        return from_stdout;
    }
    from_stdout.or_else(|| parse_semver_from_text(&String::from_utf8_lossy(stderr)))
}

/// Find the first `\d+\.\d+\.\d+` substring in `text` and return it as a
/// String. Used to extract the version from `claude --version` output, which
/// is something like "1.5.2 (Claude Code)".
pub fn parse_semver_from_text(text: &str) -> Option<String> {
    let mut chars = text.chars().peekable();
    let mut buf = String::new();
    let mut dots = 0usize;
    let mut in_run = false;
    while let Some(c) = chars.next() {
        if c.is_ascii_digit() {
            buf.push(c);
            in_run = true;
        } else if c == '.' && in_run {
            if dots == 2
                && buf.chars().last().is_some_and(|c| c.is_ascii_digit())
                && chars.peek().is_some_and(|n| !n.is_ascii_digit())
            {
                // A suffix after X.Y.Z, as Git for Windows prints
                // (`2.55.0.windows.5`): the version is what came before it.
                return Some(buf);
            }
            buf.push(c);
            dots += 1;
            if dots > 2 {
                // 4+ numeric parts (`1.2.3.4`, an IP) — not a clean semver, restart.
                buf.clear();
                dots = 0;
                in_run = false;
            }
        } else if in_run {
            // Non-digit / non-dot ends the run.
            if dots == 2 && buf.chars().last().map(|c| c.is_ascii_digit()).unwrap_or(false) {
                return Some(buf);
            }
            buf.clear();
            dots = 0;
            in_run = false;
        }
    }
    if dots == 2 && buf.chars().last().map(|c| c.is_ascii_digit()).unwrap_or(false) {
        Some(buf)
    } else {
        None
    }
}

pub fn parse_semver(s: &str) -> Option<(u32, u32, u32)> {
    let mut parts = s.splitn(3, '.');
    let a = parts.next()?.parse().ok()?;
    let b = parts.next()?.parse().ok()?;
    let c = parts.next()?.parse().ok()?;
    Some((a, b, c))
}

fn version_at_least(v: (u32, u32, u32), min: (u32, u32, u32)) -> bool {
    v >= min
}

#[cfg(test)]
mod tests {
    use super::*;

    // The stubs below are `/bin/sh` scripts made executable with mode bits.
    /// GH #236, the #147 pre-warm: exec a freshly written stub once with
    /// `PLY_TEST_PREWARM` set (every stub here exits at once on it) and wait
    /// for it with no deadline. macOS assesses a new executable on its first
    /// exec; beside two other loaded suites that took longer than the probe's
    /// bound (three 6 s `gh auth status` attempts all timed out, and a stub
    /// never started within 2 + 5 + 15 s). ETXTBSY (Linux: another test's
    /// fork holding the new file) is retried.
    #[cfg(unix)]
    fn prewarm(tool: &Path) {
        loop {
            match crate::platform::new_command(tool)
                .env("PLY_TEST_PREWARM", "1")
                .stdin(std::process::Stdio::null())
                .output()
            {
                Ok(out) => {
                    assert!(out.status.success(), "test setup failure: pre-warm: {}", out.status);
                    return;
                }
                Err(e) if e.raw_os_error() == Some(libc::ETXTBSY) => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => panic!("test setup failure: pre-warm: {e}"),
            }
        }
    }

    /// A pre-warmed executable `name` in a temp dir that prints `answer` and
    /// exits, leaving a backgrounded subshell (its pid in `pid`) holding its
    /// stdout for 30 s. The subshell touches `released` only once its 30 s
    /// are up, just before it lets go of the pipe: a probe that returns while
    /// `released` is missing did not wait for the pipe (GH #236: a marker
    /// instead of an elapsed-time bound).
    #[cfg(unix)]
    fn exits_leaving_a_grandchild(name: &str, answer: &str) -> Grandchild {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let pid = dir.path().join("pid");
        let released = dir.path().join("released");
        let tool = dir.path().join(name);
        std::fs::write(
            &tool,
            format!(
                "#!/bin/sh\n[ -n \"$PLY_TEST_PREWARM\" ] && exit 0\necho '{answer}'\n(sleep 30; touch \"{}\") &\necho $! > \"{}\"\n",
                released.display(),
                pid.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        prewarm(&tool);
        assert!(!pid.exists(), "the pre-warm is not the probe");
        Grandchild { _dir: dir, tool, pid, released }
    }

    #[cfg(unix)]
    struct Grandchild {
        _dir: tempfile::TempDir,
        tool: std::path::PathBuf,
        pid: std::path::PathBuf,
        released: std::path::PathBuf,
    }

    #[cfg(unix)]
    impl Grandchild {
        /// The probe returned before the grandchild let go of its pipe, and
        /// the grandchild was killed with the probe's group.
        fn assert_not_waited_for_and_dead(&self) {
            assert!(
                !self.released.exists(),
                "the probe waited for the grandchild to let go of its pipe"
            );
            let recorded = std::fs::read_to_string(&self.pid).expect("the stub recorded its grandchild");
            // A generous deadline for the kill to be reaped under load; a
            // grandchild left alive holds on for 30 s, well past it.
            let deadline = Instant::now() + Duration::from_secs(10);
            let alive = || {
                crate::platform::new_command("kill")
                    .args(["-0", recorded.trim()])
                    .stderr(std::process::Stdio::null())
                    .status()
                    .unwrap()
                    .success()
            };
            while alive() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
            assert!(!alive(), "grandchild {recorded} outlived the probe");
            assert!(!self.released.exists(), "grandchild {recorded} ran out its hold");
        }
    }

    /// GH #204 review 1: a `gh --version` that exits but leaves a grandchild
    /// holding its stdout is read at once, and the grandchild is killed with
    /// its group. `output_with_timeout` waited on the pipe for the whole 30 s.
    #[cfg(unix)]
    #[test]
    fn a_version_probe_is_not_held_by_a_grandchild_on_its_pipe() {
        let stub = exits_leaving_a_grandchild("gh", "gh version 9.9.9 (2026-09-23)");
        let version = probe_command_version_within(
            stub.tool.to_str().unwrap(),
            "/usr/bin:/bin",
            TOOL_VERSION_TIMEOUT,
        );
        stub.assert_not_waited_for_and_dead();
        assert!(version.expect("answered within the bound").contains("9.9.9"));
    }

    /// The same for `gh auth status` (its 6 s bound).
    #[cfg(unix)]
    #[test]
    fn gh_auth_status_is_not_held_by_a_grandchild_on_its_pipe() {
        let stub = exits_leaving_a_grandchild("gh", r#"{"hosts":{}}"#);
        let answer = gh_auth_run(stub.tool.to_str().unwrap(), "/usr/bin:/bin", true);
        stub.assert_not_waited_for_and_dead();
        let (ok, text) = answer.expect("answered within the bound");
        assert!(ok && text.contains("hosts"), "{text}");
    }

    /// GH #204: `gh --version` (and `git --version`) that never prints is
    /// killed at the bound and reads as "version unknown" instead of
    /// stalling the dependency probe.
    #[cfg(unix)]
    #[test]
    fn a_stalled_version_probe_is_stopped_at_its_bound() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let pid = dir.path().join("pid");
        let tool = dir.path().join("gh");
        std::fs::write(
            &tool,
            format!(
                "#!/bin/sh\n[ -n \"$PLY_TEST_PREWARM\" ] && exit 0\necho $$ > \"{}\"\nexec sleep 60\n",
                pid.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        prewarm(&tool);
        // GH #130: retry longer until the stub recorded its pid, so the kill
        // check below is never vacuous.
        for secs in [2, 5, 15] {
            let timeout = Duration::from_secs(secs);
            let started = Instant::now();
            let version =
                probe_command_version_within(tool.to_str().unwrap(), "/usr/bin:/bin", timeout);
            assert_eq!(version, None);
            // Generous for a loaded run; the stub would hold it 60 s.
            assert!(started.elapsed() < timeout + Duration::from_secs(10), "{:?}", started.elapsed());
            if let Ok(recorded) = std::fs::read_to_string(&pid) {
                std::thread::sleep(Duration::from_millis(200));
                let alive = crate::platform::new_command("kill")
                    .args(["-0", recorded.trim()])
                    .stderr(std::process::Stdio::null())
                    .status()
                    .unwrap()
                    .success();
                assert!(!alive, "pid {recorded} outlived the timeout");
                return;
            }
        }
        panic!("test setup failure: the stub never started");
    }

    #[test]
    fn gh_is_asked_for_its_active_accounts_as_json() {
        // GH #194 / review 1 (#195): JSON for the refused-or-offline error,
        // `--active` so inactive accounts are neither looked up nor checked.
        assert_eq!(GH_AUTH_JSON_ARGS, ["auth", "status", "--json", "hosts", "--active"]);
        assert_eq!(&GH_AUTH_JSON_ARGS[..2], ["auth", "status"]);
    }

    /// GH #68: the doctor finds a tile shell the way the PTY spawn runs it —
    /// a bare name through the cached PATH, a path as given.
    #[cfg(unix)]
    #[test]
    fn resolve_program_takes_bare_names_through_path_and_paths_as_given() {
        use std::os::unix::fs::PermissionsExt;
        let file = |dir: &Path, mode: u32| {
            let shell = dir.join("zsh");
            std::fs::write(&shell, b"").unwrap();
            std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(mode)).unwrap();
            shell.to_string_lossy().to_string()
        };
        let plain = tempfile::tempdir().unwrap();
        let runnable = tempfile::tempdir().unwrap();
        let not_exec = file(plain.path(), 0o644);
        let zsh = file(runnable.path(), 0o755);
        let path = format!(
            "/nonexistent:{}:{}",
            plain.path().display(),
            runnable.path().display()
        );
        assert_eq!(
            resolve_program("zsh", &path),
            Some(zsh.clone()),
            "a non-executable candidate earlier on PATH is skipped"
        );
        assert_eq!(resolve_program("zsh", "/nonexistent"), None);
        assert_eq!(resolve_program(&zsh, "/nonexistent"), Some(zsh));
        assert_eq!(resolve_program(&not_exec, &path), None, "a non-executable path");
        assert_eq!(resolve_program(plain.path().to_str().unwrap(), &path), None, "a directory");
        assert_eq!(resolve_program("./zsh", &path), None, "a relative path is not searched");
    }

    // ── OB-2: git works, and never the shim without the CLT ──────────

    #[test]
    fn without_the_clt_the_apple_shim_is_never_run() {
        let c = choose_git(Some("/usr/bin/git"), Some(false), &["/usr/bin/git".into()]);
        assert_eq!(c, GitChoice { path: Some("/usr/bin/git".into()), run: false });
        // No other git at all: still not run.
        assert!(!choose_git(Some("/usr/bin/git"), Some(false), &[]).run);
    }

    #[test]
    fn a_homebrew_git_without_the_clt_counts_as_working() {
        // Resolved first on PATH: run as always.
        let brew = choose_git(Some("/opt/homebrew/bin/git"), Some(false), &[]);
        assert_eq!(brew, GitChoice { path: Some("/opt/homebrew/bin/git".into()), run: true });
        // The shim first on PATH, Homebrew's later: the working one is used.
        let later = choose_git(
            Some("/usr/bin/git"),
            Some(false),
            &["/usr/bin/git".into(), "/opt/homebrew/bin/git".into()],
        );
        assert_eq!(later, GitChoice { path: Some("/opt/homebrew/bin/git".into()), run: true });
    }

    #[test]
    fn with_the_clt_or_off_macos_the_resolved_git_runs() {
        assert!(choose_git(Some("/usr/bin/git"), Some(true), &[]).run);
        assert!(choose_git(Some(r"C:\Program Files\Git\cmd\git.exe"), None, &[]).run);
        assert_eq!(choose_git(None, Some(false), &[]), GitChoice { path: None, run: false });
    }

    /// A tool file `find_in_path` resolves (PATHEXT's `.cmd` on Windows). Not
    /// executable: these tests never run it, and a version probe of it fails
    /// at once.
    fn tool_file(dir: &Path, name: &str) -> String {
        let file = if cfg!(windows) { format!("{name}.cmd") } else { name.to_string() };
        let path = dir.join(file);
        std::fs::write(&path, "").unwrap();
        path.to_string_lossy().into_owned()
    }

    fn reset_reprobe_state() {
        configure_path_override(None);
        *LAST_PROBE.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// 1.170 gate: the re-probe tests below replace the process-wide cached
    /// env with fakes (no git, a scratch PATH). Left in place, every later
    /// test that resolves a tool through it (`doctor::require("git")`, a
    /// verify step's `sh`) failed in the full parallel run — G8's release
    /// fixtures first. Taken after `lock_for_test()`, so it drops first and
    /// puts back the env, the override and the last probe as they were.
    struct RestoreEnv {
        env: Option<Arc<ShellEnv>>,
        last: Option<Arc<ShellEnv>>,
        path_override: Option<String>,
    }

    fn restore_env_on_drop() -> RestoreEnv {
        // Nothing cached yet: probe now, so there is a real env to put back
        // (a later `init()` keeps whatever is cached).
        if try_get().is_none() {
            init();
        }
        RestoreEnv {
            env: try_get(),
            last: LAST_PROBE.lock().unwrap_or_else(|p| p.into_inner()).clone(),
            path_override: path_override(),
        }
    }

    impl Drop for RestoreEnv {
        fn drop(&mut self) {
            if let Some(env) = self.env.take() {
                if let Some(lock) = SHELL_ENV.get() {
                    *lock.write() = env;
                }
            }
            *LAST_PROBE.lock().unwrap_or_else(|p| p.into_inner()) = self.last.take();
            *PATH_OVERRIDE.lock().unwrap_or_else(|p| p.into_inner()) = self.path_override.take();
        }
    }

    /// 2026-10-16: a Codex update's re-probe dropped the owner's override
    /// (claude only in ~/.npm-global/bin) and every tile then failed "not
    /// found in PATH". With an override recorded, a re-probe applies it and
    /// never asks the login shell.
    #[test]
    fn a_re_probe_keeps_the_path_override_and_its_tools() {
        let _guard = lock_for_test();
        let _restore = restore_env_on_drop();
        reset_reprobe_state();
        let bin = tempfile::tempdir().unwrap();
        let claude = tool_file(bin.path(), "claude");
        let codex = tool_file(bin.path(), "codex");
        let override_path = bin.path().to_string_lossy().into_owned();
        assert!(configure_path_override(Some(&override_path)));
        assert!(!configure_path_override(Some(&override_path)), "unchanged");
        set_for_test(ShellEnv { path: "/usr/bin:/bin".into(), ..ShellEnv::default() });

        let env = re_probe_with(|| panic!("the login shell is not asked while an override is set"));

        assert_eq!(env.path, override_path);
        assert_eq!(env.claude_path.as_deref(), Some(claude.as_str()));
        assert_eq!(env.codex_path.as_deref(), Some(codex.as_str()));
        assert_eq!(get().path, override_path, "the cached env PTYs spawn with");
        reset_reprobe_state();
    }

    #[test]
    fn a_cleared_override_re_probes_the_login_shell() {
        let _guard = lock_for_test();
        let _restore = restore_env_on_drop();
        reset_reprobe_state();
        configure_path_override(Some("/opt/override/bin"));
        assert!(configure_path_override(Some("  ")), "blank clears it");
        assert_eq!(path_override(), None);
        set_for_test(ShellEnv { path: "/opt/override/bin".into(), ..ShellEnv::default() });

        let env = re_probe_with(|| ShellEnv { path: "/from/the/probe".into(), ..ShellEnv::default() });

        assert_eq!(env.path, "/from/the/probe");
        assert_eq!(get().path, "/from/the/probe");
        reset_reprobe_state();
    }

    /// A probe that loses claude and codex still on disk keeps them and the
    /// PATH dirs they were found in; a tool that really went away is let go.
    #[test]
    fn a_re_probe_that_loses_tools_still_on_disk_keeps_them() {
        let _guard = lock_for_test();
        let _restore = restore_env_on_drop();
        reset_reprobe_state();
        let bin = tempfile::tempdir().unwrap();
        let claude = tool_file(bin.path(), "claude");
        let codex = tool_file(bin.path(), "codex");
        let bin_dir = bin.path().to_string_lossy().into_owned();
        let found_path = crate::platform::join_path_list(&["/usr/bin", bin_dir.as_str()]);
        let found = ShellEnv {
            path: found_path.clone(),
            claude_path: Some(claude.clone()),
            claude_version: Some("2.1.0".into()),
            codex_path: Some(codex.clone()),
            codex_version: Some("0.50.0".into()),
            ..ShellEnv::default()
        };
        let lost = || ShellEnv {
            path: "/usr/bin".into(),
            probe_error: ai_probe_error(false, false, false),
            ..ShellEnv::default()
        };
        re_probe_with(|| found.clone());

        let env = re_probe_with(lost);

        assert_eq!(env.path, found_path, "the previous PATH's dir is appended");
        assert_eq!(env.claude_path.as_deref(), Some(claude.as_str()));
        assert_eq!(env.codex_path.as_deref(), Some(codex.as_str()));
        // 1.176.0 R3: their versions are asked again, not copied — and these
        // empty files never answer, so neither looks healthy any more.
        assert_eq!(env.claude_version, None, "an empty file doesn't start");
        assert!(!env.claude_healthy());
        assert!(!env.codex_healthy());
        assert_eq!(env.probe_error, None);
        assert_eq!(get().claude_path.as_deref(), Some(claude.as_str()));

        // Uninstalled since: the file is gone, so the probe's answer stands.
        std::fs::remove_file(&claude).unwrap();
        let env = re_probe_with(lost);
        assert_eq!(env.claude_path, None);
        assert_eq!(env.codex_path.as_deref(), Some(codex.as_str()), "codex is still there");
        reset_reprobe_state();
    }

    /// A Codex update's slow login-shell re-probe that began before Settings
    /// set an override must not finish last and put the login shell's PATH
    /// back: re-probes run one at a time, so the override's re-probe waits
    /// and writes last.
    #[test]
    fn a_slow_re_probe_from_before_an_override_does_not_overwrite_it() {
        let _guard = lock_for_test();
        let _restore = restore_env_on_drop();
        reset_reprobe_state();
        let bin = tempfile::tempdir().unwrap();
        let override_path = bin.path().to_string_lossy().into_owned();
        let (probing_tx, probing_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let slow = std::thread::spawn(move || {
            re_probe_with(move || {
                probing_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                ShellEnv { path: "/from/the/login/shell".into(), ..ShellEnv::default() }
            });
        });
        probing_rx.recv().unwrap();

        assert!(configure_path_override(Some(&override_path)));
        let settings = std::thread::spawn(|| {
            re_probe_with(|| panic!("the override's re-probe never asks the login shell"));
        });
        std::thread::sleep(std::time::Duration::from_millis(100));
        release_tx.send(()).unwrap();
        slow.join().unwrap();
        settings.join().unwrap();

        assert_eq!(get().path, override_path, "the override's re-probe wrote last");
        reset_reprobe_state();
    }

    /// "Look again" after installing claude: a probe that finds more is
    /// taken as it is.
    #[test]
    fn a_tool_installed_since_the_last_probe_is_found() {
        let previous = ShellEnv { path: "/usr/bin".into(), ..ShellEnv::default() };
        let fresh = ShellEnv {
            path: "/usr/bin:/home/me/.local/bin".into(),
            claude_path: Some("/home/me/.local/bin/claude".into()),
            ..ShellEnv::default()
        };
        let kept = keep_lost_tools(&previous, fresh, |_| true, |_, _| panic!("nothing was lost"));
        assert_eq!(kept.claude_path.as_deref(), Some("/home/me/.local/bin/claude"));
        assert_eq!(kept.path, "/usr/bin:/home/me/.local/bin");
    }

    /// 1.176.0 R3 (blind spot 5): a tool the login shell lost but whose file
    /// is still there keeps its path — the original purpose — and its
    /// version is whatever `--version` answers now: a working one gets its
    /// current version (not the last probe's), a broken one (a launcher left
    /// pointing at a payload a failed update removed) gets none, so it stops
    /// reading as healthy.
    #[test]
    fn a_kept_tool_is_asked_its_version_again() {
        let lost = || ShellEnv { path: "/usr/bin".into(), ..ShellEnv::default() };
        let asked = std::sync::Mutex::new(Vec::<String>::new());
        // On disk: a real directory with the two tools in it.
        let bin = tempfile::tempdir().unwrap();
        let claude = tool_file(bin.path(), "claude");
        let codex = tool_file(bin.path(), "codex");
        let bin_dir = bin.path().to_string_lossy().into_owned();
        let previous = ShellEnv {
            path: bin_dir.clone(),
            claude_path: Some(claude.clone()),
            claude_version: Some("2.1.300".into()),
            codex_path: Some(codex.clone()),
            codex_version: Some("0.170.0".into()),
            ..ShellEnv::default()
        };
        let kept = keep_lost_tools(&previous, lost(), |p| Path::new(p).is_file(), |p, path| {
            asked.lock().unwrap().push(p.to_string());
            assert!(path.contains(&bin_dir), "asked with the PATH that found it");
            // Claude updated itself and answers; Codex's payload is broken.
            if p == claude { VersionAnswer::Starts("2.1.330".into()) } else { VersionAnswer::Fails }
        });
        assert_eq!(*asked.lock().unwrap(), vec![claude.clone(), codex.clone()], "both asked again");
        assert_eq!(kept.claude_path.as_deref(), Some(claude.as_str()), "the path is kept, as before");
        assert_eq!(kept.claude_version.as_deref(), Some("2.1.330"), "today's answer, not the copy");
        assert!(kept.claude_healthy());
        assert_eq!(kept.codex_path.as_deref(), Some(codex.as_str()));
        assert_eq!(kept.codex_version, None, "a broken file no longer looks healthy");
        assert!(!kept.codex_healthy());
    }

    #[test]
    fn claude_is_healthy_only_when_found_and_answering() {
        let mut env = ShellEnv { claude_path: Some("/c".into()), ..ShellEnv::default() };
        assert!(!env.claude_healthy(), "found, but --version didn't answer");
        env.claude_version = Some("2.1.330".into());
        assert!(env.claude_healthy());
        env.claude_path = None;
        assert!(!env.claude_healthy());
    }

    /// 1.176.0 R3 (blind spot 8; review 1): Claude's and Codex's
    /// `--version` is bounded — it runs under the re-probe lock — and a hung
    /// one is Unknown, never Fails.
    #[cfg(unix)]
    #[test]
    fn a_hung_version_answer_is_unknown_not_a_failure() {
        use std::os::unix::fs::PermissionsExt;
        let bin = tempfile::tempdir().unwrap();
        let hung = bin.path().join("claude");
        std::fs::write(&hung, "#!/bin/sh\nsleep 30\n").unwrap();
        std::fs::set_permissions(&hung, std::fs::Permissions::from_mode(0o755)).unwrap();
        let started = Instant::now();
        let answer = version_answer_within(&hung.to_string_lossy(), "/usr/bin:/bin", Duration::from_millis(300));
        assert_eq!(answer, VersionAnswer::Unknown);
        assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
        // A real failure: it starts and exits non-zero with nothing readable.
        let dead = bin.path().join("codex");
        std::fs::write(&dead, "#!/bin/sh\nexit 137\n").unwrap();
        std::fs::set_permissions(&dead, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(version_answer_within(&dead.to_string_lossy(), "/usr/bin:/bin", Duration::from_secs(5)), VersionAnswer::Fails);
        // And one that can't even be spawned.
        assert_eq!(
            version_answer_within(&bin.path().join("nothing").to_string_lossy(), "/usr/bin:/bin", Duration::from_secs(5)),
            VersionAnswer::Fails
        );
    }

    /// R3 review 1: a timed-out healthy Claude stays ready (the same file's
    /// earlier version is kept, no second wait); a real failure doesn't; a
    /// timeout after the path changed is asked once more, with the longer
    /// bound, and still no answer means "starts, version unknown".
    #[test]
    fn a_slow_version_answer_is_settled_without_reading_as_broken() {
        let previous = ShellEnv {
            claude_path: Some("/a/claude".into()),
            claude_version: Some("2.1.330".into()),
            codex_path: Some("/a/codex".into()),
            codex_version: Some("0.171.0".into()),
            ..ShellEnv::default()
        };
        let timed_out = ShellEnv {
            claude_path: Some("/a/claude".into()),
            claude_version_unknown: true,
            codex_path: Some("/a/codex".into()),
            ..ShellEnv::default() // codex: a real failure (no version, not unknown)
        };
        let settled = settle_unknown(Some(&previous), timed_out, |_, _| panic!("no second wait for the same file"));
        assert_eq!(settled.claude_version.as_deref(), Some("2.1.330"));
        assert!(settled.claude_healthy());
        assert!(!settled.codex_healthy(), "a real failure is still not starting");

        // The path changed (or there was no snapshot before): one retry.
        let moved = ShellEnv { claude_path: Some("/b/claude".into()), claude_version_unknown: true, ..ShellEnv::default() };
        let tries = std::cell::Cell::new(0);
        let settled = settle_unknown(Some(&previous), moved.clone(), |p, _| {
            tries.set(tries.get() + 1);
            assert_eq!(p, "/b/claude");
            VersionAnswer::Starts("2.1.331".into())
        });
        assert_eq!(tries.get(), 1);
        assert_eq!(settled.claude_version.as_deref(), Some("2.1.331"));
        let settled = settle_unknown(None, moved.clone(), |_, _| VersionAnswer::Unknown);
        assert!(settled.claude_version_unknown && settled.claude_healthy(), "slow twice: starts, version unknown");
        let settled = settle_unknown(None, moved, |_, _| VersionAnswer::Fails);
        assert!(!settled.claude_healthy(), "the retry's real failure is a failure");
    }

    fn no_clt(git: &str, version: Option<&str>) -> ShellEnv {
        ShellEnv {
            path: "/usr/bin:/bin:/opt/homebrew/bin".into(),
            git_path: Some(git.into()),
            git_version: version.map(String::from),
            clt_installed: Some(false),
            ..ShellEnv::default()
        }
    }

    #[test]
    fn every_git_spawn_skips_the_shim_without_the_clt() {
        // Before the probe (unit tests) and wherever the CLT are there or it
        // isn't a Mac: a bare `git`, as always.
        assert_eq!(git_program(None), GitProgram::Bare);
        let mut with_clt = no_clt("/usr/bin/git", Some("2.50.1"));
        with_clt.clt_installed = Some(true);
        assert_eq!(git_program(Some(&with_clt)), GitProgram::Bare);
        let mut windows = with_clt.clone();
        windows.clt_installed = None;
        assert_eq!(git_program(Some(&windows)), GitProgram::Bare);
        // No CLT, only the shim: nothing runs.
        let shim = no_clt("/usr/bin/git", None);
        assert_eq!(git_program(Some(&shim)), GitProgram::Unavailable);
        let command = crate::platform::git_command_for(git_program(Some(&shim)));
        assert_eq!(command.get_program(), GIT_UNAVAILABLE);
        let spawned = crate::platform::git_command_for(git_program(Some(&shim)))
            .arg("--version")
            .output();
        assert!(spawned.is_err(), "the stand-in never runs");
        // No CLT, Homebrew's git: that one, by path, with the probed PATH.
        let brew = no_clt("/opt/homebrew/bin/git", Some("2.51.0"));
        let program = git_program(Some(&brew));
        assert_eq!(
            program,
            GitProgram::At { program: "/opt/homebrew/bin/git".into(), path: brew.path.clone() }
        );
        let command = crate::platform::git_command_for(program);
        assert_eq!(command.get_program(), "/opt/homebrew/bin/git");
        assert!(command
            .get_envs()
            .any(|(k, v)| k == "PATH" && v == Some(std::ffi::OsStr::new(&brew.path))));
    }

    #[test]
    fn no_git_is_spawned_by_bare_name_outside_git_command() {
        // P2-1: the project-skills read (`git::check_ignored`), project
        // config, memory, shared config, team… all spawn through
        // `platform::git_command`, so none can reach the shim.
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        let mut stack = vec![src];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let name = path.file_name().unwrap().to_string_lossy().into_owned();
                if !name.ends_with(".rs") || name == "platform.rs" {
                    continue;
                }
                let text = std::fs::read_to_string(&path).unwrap();
                let needle = ["new_command(", "\"git\")"].concat();
                let raw = ["Command", "::new(", "\"git\")"].concat();
                if text.contains(&needle) || text.contains(&raw) {
                    offenders.push(name);
                }
            }
        }
        assert!(offenders.is_empty(), "spawn git through platform::git_command: {offenders:?}");
        // And the project-skills path is one of them.
        assert!(include_str!("git.rs").contains("crate::platform::git_command()"));
    }

    #[test]
    fn only_a_clean_exit_of_xcode_select_decides() {
        assert_eq!(clt_from(Ok(Some(0))), Some(true));
        assert_eq!(clt_from(Ok(Some(2))), Some(false), "a clean non-zero exit: no CLT");
        // Timed out, failed to spawn, killed: unknown, so git stays bare.
        assert_eq!(clt_from(Err("TimedOut".into())), None);
        assert_eq!(clt_from(Err("Spawn".into())), None);
        assert_eq!(clt_from(Ok(None)), None);
        let unknown = ShellEnv { clt_installed: clt_from(Err("TimedOut".into())), ..no_clt("/usr/bin/git", Some("2.50.1")) };
        assert_eq!(git_program(Some(&unknown)), GitProgram::Bare);
        assert_eq!(choose_git(Some("/usr/bin/git"), unknown.clt_installed, &[]).run, true);
    }

    /// 1.176.2 R1 (A1-01): on Windows, a Git installed while Plyloft is open
    /// (Setup's Git step) runs from where the probe found it, not by a bare
    /// name the launch-time PATH can't resolve.
    #[test]
    fn windows_runs_the_git_the_probe_found_while_it_is_on_disk() {
        let installed = r"C:\Program Files\Git\cmd\git.exe";
        let windows = ShellEnv {
            path: r"C:\Windows\system32;C:\Program Files\Git\cmd".into(),
            git_path: Some(installed.into()),
            git_version: Some("git version 2.51.0.windows.1".into()),
            clt_installed: None,
            ..ShellEnv::default()
        };
        let there = |p: &str| p == installed;
        let program = git_program_on(Some(&windows), true, there);
        assert_eq!(program, GitProgram::Found { program: installed.into() });
        let command = crate::platform::git_command_for(program);
        assert_eq!(command.get_program(), installed);
        assert!(
            !command.get_envs().any(|(k, _)| k == "PATH"),
            "the child's PATH is Plyloft's own, never the probe's"
        );
        // A per-user Git, any letter case.
        let user = ShellEnv {
            git_path: Some(r"C:\Users\Ada\AppData\Local\Programs\Git\cmd\GIT.EXE".into()),
            ..windows.clone()
        };
        assert!(matches!(git_program_on(Some(&user), true, |_| true), GitProgram::Found { .. }));
        // Gone from disk since the probe: the bare name, as before.
        assert_eq!(git_program_on(Some(&windows), true, |_| false), GitProgram::Bare);
        // Found but not working (no version): the bare name.
        let broken = ShellEnv { git_version: None, ..windows.clone() };
        assert_eq!(git_program_on(Some(&broken), true, |_| true), GitProgram::Bare);
        // Not a program file by an absolute path: the bare name.
        for odd in [r"C:\tools\git.cmd", r"git.exe", r"tools\git.exe"] {
            let env = ShellEnv { git_path: Some(odd.into()), ..windows.clone() };
            assert_eq!(git_program_on(Some(&env), true, |_| true), GitProgram::Bare, "{odd}");
        }
        // No probe yet: the bare name.
        assert_eq!(git_program_on(None, true, |_| true), GitProgram::Bare);
        // The Mac is unchanged: with the CLT it stays bare even when found.
        let mac = ShellEnv { clt_installed: Some(true), ..no_clt("/usr/bin/git", Some("2.50.1")) };
        assert_eq!(git_program_on(Some(&mac), false, |_| true), GitProgram::Bare);
        assert_eq!(git_program(Some(&mac)), GitProgram::Bare);
    }

    /// REV-R1 F3 (Windows only): the git this machine has is run by its path.
    #[cfg(windows)]
    #[test]
    fn windows_runs_this_machines_git_by_its_path() {
        let path = std::env::var("PATH").unwrap_or_default();
        let Some(git) = find_in_path(&path, "git") else { return };
        if !git.to_ascii_lowercase().ends_with(".exe") {
            return;
        }
        let env = ShellEnv {
            path,
            git_path: Some(git.clone()),
            git_version: Some("found".into()),
            clt_installed: None,
            ..ShellEnv::default()
        };
        assert_eq!(git_program(Some(&env)), GitProgram::Found { program: git.clone() });
        let out = crate::platform::git_command_for(git_program(Some(&env)))
            .arg("--version")
            .output()
            .expect("git runs by its path");
        assert!(out.status.success());
    }

    #[test]
    fn git_works_only_when_it_answered() {
        let mut env = ShellEnv { git_path: Some("/usr/bin/git".into()), ..ShellEnv::default() };
        assert!(!env.git_works(), "resolved but never run (no CLT)");
        env.git_version = Some("2.50.1".into());
        assert!(env.git_works());
    }

    #[test]
    fn the_probe_error_names_no_ai_only_when_both_are_missing() {
        assert_eq!(ai_probe_error(true, false, false), None);
        assert_eq!(ai_probe_error(false, true, false), None, "Codex alone is enough");
        assert_eq!(ai_probe_error(true, true, true), None);
        assert_eq!(ai_probe_error(false, false, false).as_deref(), Some(NO_AI_PROBE_ERROR));
        assert_eq!(ai_probe_error(false, false, true).as_deref(), Some(NO_AI_OVERRIDE_ERROR));
        assert_eq!(
            NO_AI_PROBE_ERROR,
            "No AI tool found. Install Claude Code or Codex, or set a PATH override in Settings › Look and feel › Editor and terminals."
        );
        assert!(!NO_AI_PROBE_ERROR.contains("claude binary"));
        assert_eq!(
            NO_AI_OVERRIDE_ERROR_MAC,
            "Neither claude nor codex is in your Program folders (Settings › Look and feel › Editor and terminals). Check them, or empty them so Plyloft asks your login shell again."
        );
        assert!(!NO_AI_OVERRIDE_ERROR_WINDOWS.contains("login shell"));
        assert!(NO_AI_OVERRIDE_ERROR_WINDOWS.ends_with("so Plyloft looks in the folders Windows gave it again."));
        assert_eq!(NO_AI_OVERRIDE_ERROR, if cfg!(windows) { NO_AI_OVERRIDE_ERROR_WINDOWS } else { NO_AI_OVERRIDE_ERROR_MAC });
    }

    #[test]
    fn parse_semver_basic() {
        assert_eq!(parse_semver("1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_semver("0.0.1"), Some((0, 0, 1)));
        assert_eq!(parse_semver("12.0.7"), Some((12, 0, 7)));
        assert_eq!(parse_semver("1.2"), None);
        assert_eq!(parse_semver(""), None);
        assert_eq!(parse_semver("not.a.version"), None);
    }

    #[test]
    fn parse_semver_from_text_extracts_first_version() {
        assert_eq!(
            parse_semver_from_text("1.5.2 (Claude Code)"),
            Some("1.5.2".to_string())
        );
        assert_eq!(
            parse_semver_from_text("Claude Code v0.9.7\nbuilt on ..."),
            Some("0.9.7".to_string())
        );
        assert_eq!(
            parse_semver_from_text("12.0.0"),
            Some("12.0.0".to_string())
        );
        assert_eq!(parse_semver_from_text("no version here"), None);
        assert_eq!(parse_semver_from_text("1.2"), None);
        assert_eq!(parse_semver_from_text(""), None);
    }

    #[test]
    fn git_for_windows_version_is_read_before_its_suffix() {
        assert_eq!(
            parse_semver_from_text("git version 2.55.0.windows.5\n"),
            Some("2.55.0".to_string())
        );
        assert_eq!(
            parse_version_output(b"git version 2.51.0.windows.1\n", b"", true),
            Some("2.51.0".to_string())
        );
        assert_eq!(
            parse_semver_from_text("git version 2.39.5 (Apple Git-154)"),
            Some("2.39.5".to_string())
        );
        // Four numeric parts are still not a version.
        assert_eq!(parse_semver_from_text("listening on 127.0.0.1"), None);
    }

    #[test]
    fn version_output_tolerates_codex_wrapper_diagnostics() {
        assert_eq!(
            parse_version_output(
                b"codex-cli 0.145.0\n",
                b"WARNING: could not create PATH aliases: Operation not permitted (os error 1)\n",
                true
            ),
            Some("0.145.0".to_string())
        );
        assert_eq!(
            parse_version_output(
                b"",
                b"warning first\nOpenAI Codex v0.146.1\n",
                true
            ),
            Some("0.146.1".to_string())
        );
        assert_eq!(parse_version_output(b"", b"wrapper failed", true), None);
        // A failed run's stderr is a diagnostic, never a version banner.
        assert_eq!(
            parse_version_output(b"", b"crashed\nNode.js v22.15.0\n", false),
            None
        );
        // ...but a version on stdout still counts, even on a non-zero exit.
        assert_eq!(
            parse_version_output(b"codex-cli 0.151.0\n", b"noise\n", false),
            Some("0.151.0".to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn crashed_wrapper_does_not_report_the_node_runtime_version() {
        use std::os::unix::fs::PermissionsExt;

        // Real failure mode (2026-08-30): a half-installed @openai/codex left
        // the Node wrapper on PATH without its platform package, so `codex
        // --version` crashed. Node's crash dump ends with its own banner —
        // "Node.js v22.15.0" — which the probe must never report as Codex's
        // version, because the doctor reads a parsed version as proof of life.
        let tmp = tempfile::tempdir().expect("tempdir");
        let wrapper = tmp.path().join("codex");
        std::fs::write(
            &wrapper,
            "#!/bin/sh\nprintf 'file:///opt/@openai/codex/bin/codex.js:105\\n\
             Error: Missing optional dependency @openai/codex-darwin-arm64.\\n\
             \\nNode.js v22.15.0\\n' >&2\nexit 1\n",
        )
        .expect("write crashing wrapper");
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755))
            .expect("chmod wrapper");

        assert_eq!(
            probe_codex_version(&wrapper.to_string_lossy(), &tmp.path().to_string_lossy()),
            VersionAnswer::Fails
        );
    }

    #[cfg(unix)]
    #[test]
    fn version_probe_injects_effective_path_for_env_shebang() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().expect("tempdir");
        let interpreter = tmp.path().join("ply-test-node");
        std::fs::write(
            &interpreter,
            "#!/bin/sh\nprintf 'codex-cli 9.8.7\\n'\n",
        )
        .expect("write fake interpreter");
        std::fs::set_permissions(&interpreter, std::fs::Permissions::from_mode(0o755))
            .expect("chmod fake interpreter");

        let wrapper = tmp.path().join("codex");
        std::fs::write(&wrapper, "#!/usr/bin/env ply-test-node\n")
            .expect("write env-shebang wrapper");
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755))
            .expect("chmod wrapper");

        assert_eq!(
            probe_codex_version(&wrapper.to_string_lossy(), &tmp.path().to_string_lossy()),
            VersionAnswer::Starts("9.8.7".to_string())
        );
    }

    #[test]
    fn version_at_least_compares_correctly() {
        assert!(version_at_least((1, 0, 0), (1, 0, 0)));
        assert!(version_at_least((1, 0, 1), (1, 0, 0)));
        assert!(version_at_least((2, 0, 0), (1, 99, 99)));
        assert!(!version_at_least((0, 9, 9), (1, 0, 0)));
        assert!(!version_at_least((1, 0, 0), (1, 0, 1)));
    }

    #[test]
    fn supports_stream_json_gates_on_min_version() {
        let mk = |v: Option<&str>| ShellEnv {
            path: String::new(),
            shell: String::new(),
            claude_path: Some("/x".into()),
            claude_version: v.map(String::from),
            codex_path: None,
            codex_version: None,
            git_path: None,
            git_version: None,
            gh_path: None,
            gh_version: None,
            probe_error: None,
            ..ShellEnv::default()
        };
        assert!(mk(Some("1.0.0")).supports_stream_json());
        assert!(mk(Some("1.5.2")).supports_stream_json());
        assert!(mk(Some("2.0.0")).supports_stream_json());
        assert!(!mk(Some("0.9.99")).supports_stream_json());
        assert!(!mk(None).supports_stream_json());
    }

    #[test]
    fn probe_shell_prefers_the_users_zsh_as_interactive_login() {
        // .zshrc (where the Claude installer writes its PATH line) is only
        // read by an *interactive* zsh — `-lc` alone still misses it.
        let exists = |p: &str| p == "/bin/zsh" || p == "/bin/bash";
        assert_eq!(
            probe_shell_for(Some("/bin/zsh"), exists),
            ("/bin/zsh".to_string(), "-ilc")
        );
        assert_eq!(
            probe_shell_for(Some("/bin/bash"), exists),
            ("/bin/bash".to_string(), "-lc")
        );
    }

    #[test]
    fn probe_shell_falls_back_to_bash_for_unknown_or_missing_shells() {
        let exists = |p: &str| p == "/opt/homebrew/bin/fish";
        assert_eq!(
            probe_shell_for(Some("/opt/homebrew/bin/fish"), exists),
            ("/bin/bash".to_string(), "-lc")
        );
        // $SHELL points at a binary that isn't there (stale dscl entry).
        assert_eq!(
            probe_shell_for(Some("/usr/local/bin/zsh"), exists),
            ("/bin/bash".to_string(), "-lc")
        );
        assert_eq!(probe_shell_for(None, exists), ("/bin/bash".to_string(), "-lc"));
    }

    #[test]
    fn augment_path_appends_existing_known_dirs_once_and_keeps_order() {
        let tmp = tempfile::tempdir().unwrap();
        let present = tmp.path().join("present");
        let already = tmp.path().join("already");
        let missing = tmp.path().join("missing");
        std::fs::create_dir_all(&present).unwrap();
        std::fs::create_dir_all(&already).unwrap();
        let list = |dirs: &[&Path]| {
            let dirs: Vec<String> = dirs.iter().map(|d| d.display().to_string()).collect();
            crate::platform::join_path_list(&dirs)
        };
        let usr_bin = Path::new("/usr/bin");
        let base = list(&[usr_bin, &already]);
        let out = augment_path(&base, &[missing.clone(), present.clone(), already.clone()]);
        assert_eq!(
            out,
            list(&[usr_bin, &already, &present]),
            "missing dir skipped, present dir appended after the user's PATH, duplicate not re-added"
        );
    }

    #[test]
    fn tool_in_a_known_dir_resolves_after_augmentation() {
        // The 2026-09-10 failure: claude in ~/.local/bin, PATH line only in
        // .zshrc, probe PATH without it. The widened PATH must find it.
        let tmp = tempfile::tempdir().unwrap();
        let local_bin = tmp.path().join(".local").join("bin");
        std::fs::create_dir_all(&local_bin).unwrap();
        // Windows runs the installer's `claude.exe`; npm's shim is `.cmd`.
        let file = if cfg!(windows) { "claude.cmd" } else { "claude" };
        std::fs::write(local_bin.join(file), "#!/bin/sh\n").unwrap();
        let narrow = crate::platform::join_path_list(&["/usr/bin", "/bin"]);
        assert!(find_in_path(&narrow, "claude").is_none());
        let widened = augment_path(&narrow, &known_tool_dirs(Some(&tmp.path().to_string_lossy())));
        assert_eq!(
            find_in_path(&widened, "claude").as_deref(),
            Some(local_bin.join(file).to_string_lossy().as_ref())
        );
    }

    /// A bare name finds the Windows program PATHEXT names, across a
    /// `;`-separated PATH with drive letters in it.
    #[cfg(windows)]
    #[test]
    fn windows_tools_resolve_by_bare_name_through_pathext() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        // npm's sh script, not a Windows program.
        std::fs::write(first.path().join("git"), "#!/bin/sh\n").unwrap();
        std::fs::write(second.path().join("git.exe"), b"MZ").unwrap();
        std::fs::write(second.path().join("codex.cmd"), "@echo off\r\n").unwrap();
        let path = crate::platform::join_path_list(&[
            first.path().display().to_string(),
            second.path().display().to_string(),
        ]);
        let git = second.path().join("git.exe").to_string_lossy().into_owned();
        assert_eq!(find_in_path(&path, "git"), Some(git.clone()));
        assert_eq!(resolve_program("git", &path), Some(git.clone()));
        assert_eq!(resolve_program(&git, ""), Some(git.clone()));
        assert_eq!(resolve_program(git.trim_end_matches(".exe"), ""), Some(git));
        assert_eq!(
            find_in_path(&path, "codex"),
            Some(second.path().join("codex.cmd").to_string_lossy().into_owned())
        );
        assert_eq!(find_in_path(&path, "gh"), None);
    }

    #[cfg(windows)]
    #[test]
    fn a_known_dir_already_on_path_in_another_case_is_not_added_again() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("Tools");
        std::fs::create_dir_all(&dir).unwrap();
        let listed = format!("{}\\", dir.display().to_string().to_ascii_uppercase());
        let base = crate::platform::join_path_list(&[r"C:\Windows", listed.as_str()]);
        assert_eq!(augment_path(&base, &[dir]), base);
    }

    /// Windows has no login shell: the probe is the process PATH plus the
    /// known dirs, and its shell is a Windows one.
    #[cfg(windows)]
    #[test]
    fn the_windows_probe_finds_git_and_a_windows_shell() {
        let env = run_probe();
        let shell = env.shell.to_ascii_lowercase();
        assert!(
            shell.ends_with("pwsh.exe") || shell.ends_with("powershell.exe") || shell.ends_with("cmd.exe"),
            "{shell}"
        );
        // The CI runner has Git for Windows and gh.
        let git = env.git_path.as_deref().map(str::to_ascii_lowercase);
        assert!(git.as_deref().is_some_and(|p| p.ends_with("git.exe")), "{git:?}");
    }

    /// Git Bash is found above whichever git.exe is in use, then above `git
    /// --exec-path` (Scoop's shim), then where Git for Windows installs, then
    /// on PATH; only a real Git layout counts and nothing under the Windows
    /// directory or WindowsApps does.
    #[cfg(windows)]
    #[test]
    fn git_bash_is_found_beside_git_and_never_in_system32() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |key: &str| {
                pairs.iter().find(|(k, _)| *k == key).map(|(_, v)| std::ffi::OsString::from(*v))
            }
        };
        // A Git for Windows layout under `root`, and nothing else on disk.
        let git_at = |root: &'static str| {
            move |p: &Path| {
                ["bin\\bash.exe", "cmd\\git.exe", "usr\\bin\\bash.exe"]
                    .iter()
                    .any(|rel| p == Path::new(root).join(rel))
            }
        };
        let windows = env(&[("SystemRoot", r"C:\Windows")]);
        let no_exec = || None;

        for git in [
            r"D:\Tools\Git\cmd\git.exe",
            r"D:\Tools\Git\bin\git.exe",
            r"D:\Tools\Git\mingw64\bin\git.exe",
        ] {
            assert_eq!(
                find_git_bash(Some(git.into()), no_exec, "", windows, git_at(r"D:\Tools\Git")),
                Some(PathBuf::from(r"D:\Tools\Git\bin\bash.exe")),
                "{git}"
            );
        }
        // Scoop: git.exe is a shim; --exec-path leads to the install.
        let scoop = r"C:\Users\me\scoop\apps\git\current";
        assert_eq!(
            find_git_bash(
                Some(r"C:\Users\me\scoop\shims\git.exe".into()),
                || Some(PathBuf::from(r"C:/Users/me/scoop/apps/git/current/mingw64/libexec/git-core")),
                "",
                windows,
                git_at(scoop)
            ),
            Some(Path::new(scoop).join("bin").join("bash.exe"))
        );
        assert_eq!(
            find_git_bash(
                None,
                no_exec,
                "",
                env(&[("ProgramFiles", r"C:\Program Files")]),
                git_at(r"C:\Program Files\Git")
            ),
            Some(PathBuf::from(r"C:\Program Files\Git\bin\bash.exe"))
        );
        // A bash.exe on PATH that isn't WSL's, after System32's is skipped.
        let path = crate::platform::join_path_list(&[r"C:\Windows\System32", r"C:\msys64\usr\bin"]);
        let msys = |p: &Path| p == Path::new(r"C:\msys64\usr\bin\bash.exe") || p.starts_with(r"C:\Windows");
        assert_eq!(
            find_git_bash(None, no_exec, &path, windows, msys),
            Some(PathBuf::from(r"C:\msys64\usr\bin\bash.exe"))
        );

        // Every file "exists": git under the Windows directory gives nothing,
        // not even the stray C:\bin\bash.exe three levels up.
        let anything = |_: &Path| true;
        let system32 = crate::platform::join_path_list(&[r"C:\Windows\System32"]);
        for git in [r"C:\Windows\System32\git.exe", r"C:\Windows\git.exe"] {
            assert_eq!(find_git_bash(Some(git.into()), no_exec, &system32, windows, anything), None, "{git}");
        }
        // Without Git's layout beside it, a bin\bash.exe is not Git Bash.
        let stray = |p: &Path| p == Path::new(r"C:\bin\bash.exe");
        assert_eq!(find_git_bash(Some(r"C:\tools\git.exe".into()), no_exec, "", windows, stray), None);
        assert!(is_wsl_launcher(Path::new(r"C:\WINDOWS\system32\bash.exe"), None));
        assert!(is_wsl_launcher(
            Path::new(r"C:\Users\me\AppData\Local\Microsoft\WindowsApps\bash.exe"),
            None
        ));
        assert!(!is_wsl_launcher(Path::new(r"C:\Program Files\Git\bin\bash.exe"), Some(Path::new(r"C:\Windows"))));
        assert_eq!(find_git_bash(None, no_exec, &system32, windows, anything), None);
    }

    /// The runner has Git for Windows: its bash is found from PATH and runs
    /// as Git Bash (MSYS), not WSL.
    #[cfg(windows)]
    #[test]
    fn the_runner_s_git_bash_runs_scripts() {
        let path = std::env::var("PATH").unwrap_or_default();
        let bash = bash_program(&path).expect("Git Bash on the runner");
        let shown = bash.to_string_lossy().to_ascii_lowercase();
        assert!(shown.ends_with(r"\bin\bash.exe") && !shown.contains("system32"), "{shown}");
        let out = crate::platform::new_command(&bash)
            .args(["-c", "uname -s; dirname a/b"])
            .env("PATH", &path)
            .output()
            .expect("run Git Bash");
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success(), "{text} {}", String::from_utf8_lossy(&out.stderr));
        assert!(text.contains("MINGW") || text.contains("MSYS"), "{text}");
        assert!(text.lines().any(|l| l.trim() == "a"), "usr/bin tools are on PATH: {text}");
    }

    #[test]
    fn parse_probe_output_with_codex() {
        let out = "PATH=/usr/bin\nSHELL=/bin/zsh\nCLAUDE=/c\nCODEX=/x\n";
        let f = parse_probe_output(out);
        assert_eq!(f.path, "/usr/bin");
        assert_eq!(f.shell, "/bin/zsh");
        assert_eq!(f.claude_path.as_deref(), Some("/c"));
        assert_eq!(f.codex_path.as_deref(), Some("/x"));
    }

    #[test]
    fn parse_probe_output_without_codex() {
        let out = "PATH=/usr/bin\nSHELL=/bin/zsh\nCLAUDE=/c\n";
        let f = parse_probe_output(out);
        assert!(f.claude_path.is_some());
        assert_eq!(f.codex_path, None);
    }

    #[test]
    fn parse_probe_output_empty_codex_line_yields_none() {
        let out = "PATH=/usr/bin\nSHELL=/bin/zsh\nCLAUDE=/c\nCODEX=\n";
        let f = parse_probe_output(out);
        assert_eq!(f.claude_path.as_deref(), Some("/c"));
        assert_eq!(f.codex_path, None);
    }

    #[test]
    fn parse_probe_output_with_git_and_gh() {
        let out = "PATH=/usr/bin\nSHELL=/bin/zsh\nCLAUDE=/c\nCODEX=/x\nGIT=/usr/bin/git\nGH=/opt/homebrew/bin/gh\n";
        let f = parse_probe_output(out);
        assert_eq!(f.git_path.as_deref(), Some("/usr/bin/git"));
        assert_eq!(f.gh_path.as_deref(), Some("/opt/homebrew/bin/gh"));
    }

    /// OB-3: the login shell's proxy variables reach Setup's guided terminal;
    /// only the known names, only with a value, both cases kept.
    #[test]
    fn the_probe_carries_the_login_shells_proxy_variables() {
        let out = "PATH=/usr/bin\nPROXY=HTTPS_PROXY=http://proxy.corp:8080\nPROXY=no_proxy=localhost,.corp\nPROXY=EVIL=x\nPROXY=HTTP_PROXY=  \nGH=/gh\n";
        let f = parse_probe_output(out);
        assert_eq!(
            f.proxy_env,
            vec![
                ("HTTPS_PROXY".to_string(), "http://proxy.corp:8080".to_string()),
                ("no_proxy".to_string(), "localhost,.corp".to_string()),
            ]
        );
        assert_eq!(f.gh_path.as_deref(), Some("/gh"));
        // Windows, or a probe that failed: the process environment's.
        let env = |name: &str| match name {
            "HTTP_PROXY" => Some("http://p:3128".to_string()),
            "http_proxy" => Some(" ".to_string()),
            "PATH" => Some("/bin".to_string()),
            _ => None,
        };
        assert_eq!(proxy_env_from(env), vec![("HTTP_PROXY".to_string(), "http://p:3128".to_string())]);
        // The script itself prints them (run by a real POSIX shell).
        #[cfg(unix)]
        {
            let out = crate::platform::new_command("/bin/sh")
                .args(["-c", PROBE_SCRIPT])
                .env("https_proxy", "http://q:1")
                .env_remove("HTTPS_PROXY")
                .output()
                .unwrap();
            assert!(out.status.success(), "the probe script still exits 0");
            let f = parse_probe_output(&String::from_utf8_lossy(&out.stdout));
            assert!(f.proxy_env.contains(&("https_proxy".to_string(), "http://q:1".to_string())));
        }
    }

    #[test]
    fn parse_probe_output_missing_git_and_gh_yield_none() {
        // Older probe output (pre-v1.32.0) had no GIT=/GH= lines at all.
        let out = "PATH=/usr/bin\nSHELL=/bin/zsh\nCLAUDE=/c\n";
        let f = parse_probe_output(out);
        assert_eq!(f.git_path, None);
        assert_eq!(f.gh_path, None);
    }

    #[test]
    fn parse_probe_output_empty_git_gh_lines_yield_none() {
        let out = "PATH=/usr/bin\nSHELL=/bin/zsh\nCLAUDE=/c\nGIT=\nGH=\n";
        let f = parse_probe_output(out);
        assert_eq!(f.git_path, None);
        assert_eq!(f.gh_path, None);
    }

    // ── 1.176.0 R4 (B2): which copy the snapshot keeps ────────────────────

    fn copies(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    fn answers(table: &'static [(&'static str, Option<&'static str>)]) -> impl Fn(&str, &str) -> VersionAnswer + Sync {
        move |p: &str, _: &str| match table.iter().find(|(n, _)| *n == p) {
            Some((_, Some(v))) => VersionAnswer::Starts(v.to_string()),
            Some((_, None)) => VersionAnswer::Fails,
            None => VersionAnswer::Unknown,
        }
    }

    #[test]
    fn a_first_copy_that_fails_gives_way_to_the_next_that_starts() {
        let c = copies(&["/opt/homebrew/bin/claude", "/u/.local/bin/claude"]);
        let probe = answers(&[("/u/.local/bin/claude", Some("2.1.330"))]);
        let (path, answer, skipped) = choose_copy(&c, VersionAnswer::Fails, false, "", probe);
        assert_eq!(path.as_deref(), Some("/u/.local/bin/claude"));
        assert_eq!(answer, Some(VersionAnswer::Starts("2.1.330".into())));
        assert_eq!(
            skipped,
            Some(PassedOver {
                path: "/opt/homebrew/bin/claude".into(),
                instead: "/u/.local/bin/claude".into(),
                kept_by_override: false
            })
        );
    }

    #[test]
    fn a_first_copy_that_only_didnt_answer_is_kept_and_nothing_else_is_asked() {
        let c = copies(&["/a/claude", "/b/claude"]);
        let asked = std::sync::Mutex::new(0);
        let probe = |_: &str, _: &str| {
            *asked.lock().unwrap() += 1;
            VersionAnswer::Starts("1.0.0".into())
        };
        let (path, answer, skipped) = choose_copy(&c, VersionAnswer::Unknown, false, "", probe);
        assert_eq!((path.as_deref(), answer, skipped), (Some("/a/claude"), Some(VersionAnswer::Unknown), None));
        let (path, _, _) = choose_copy(&c, VersionAnswer::Starts("2.0.0".into()), false, "", |_: &str, _: &str| {
            VersionAnswer::Fails
        });
        assert_eq!(path.as_deref(), Some("/a/claude"));
        assert_eq!(*asked.lock().unwrap(), 0);
    }

    #[test]
    fn under_a_path_override_nothing_is_skipped_only_reported() {
        let c = copies(&["/a/claude", "/b/claude"]);
        let probe = answers(&[("/b/claude", Some("2.1.0"))]);
        let (path, answer, skipped) = choose_copy(&c, VersionAnswer::Fails, true, "", probe);
        assert_eq!(path.as_deref(), Some("/a/claude"));
        assert_eq!(answer, Some(VersionAnswer::Fails));
        assert!(skipped.is_some_and(|s| s.kept_by_override && s.instead == "/b/claude"));
    }

    #[test]
    fn a_later_copy_that_only_didnt_answer_beats_a_certain_failure() {
        let c = copies(&["/a/claude", "/b/claude", "/c/claude"]);
        let probe = answers(&[("/b/claude", None)]); // /c: Unknown
        let (path, answer, skipped) = choose_copy(&c, VersionAnswer::Fails, false, "", probe);
        assert_eq!((path.as_deref(), answer), (Some("/c/claude"), Some(VersionAnswer::Unknown)));
        assert!(skipped.is_some_and(|s| s.instead == "/c/claude"));
    }

    #[test]
    fn only_a_spawn_error_that_says_the_file_cant_run_is_certain() {
        for certain in ["No such file or directory (os error 2)", "Permission denied (os error 13)", "Exec format error (os error 8)", "Malformed Mach-o file (os error 88)"] {
            assert_eq!(spawn_answer(certain), VersionAnswer::Fails, "{certain}");
        }
        for transient in ["Text file busy (os error 26)", "Resource temporarily unavailable (os error 35)", "Cannot allocate memory (os error 12)", "Too many open files (os error 24)", "Interrupted system call (os error 4)"] {
            assert_eq!(spawn_answer(transient), VersionAnswer::Unknown, "{transient}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn only_sigkill_is_a_certain_failure_among_signals() {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(exit_answer(&std::process::ExitStatus::from_raw(libc::SIGKILL)), VersionAnswer::Fails);
        assert_eq!(exit_answer(&std::process::ExitStatus::from_raw(libc::SIGTERM)), VersionAnswer::Unknown);
        assert_eq!(exit_answer(&std::process::ExitStatus::from_raw(libc::SIGSEGV)), VersionAnswer::Unknown);
        assert_eq!(exit_answer(&std::process::ExitStatus::from_raw(1 << 8)), VersionAnswer::Fails);
    }

    #[test]
    fn nearby_passes_over_what_the_probe_passed_over() {
        let skipped = PassedOver { path: "/a/claude".into(), instead: "/b/claude".into(), kept_by_override: false };
        assert_eq!(nearby_choice(copies(&["/a/claude", "/b/claude"]), Some(&skipped)).as_deref(), Some("/b/claude"));
        assert_eq!(nearby_choice(copies(&["/a/claude"]), Some(&skipped)).as_deref(), Some("/a/claude"));
        let kept = PassedOver { kept_by_override: true, ..skipped };
        assert_eq!(nearby_choice(copies(&["/a/claude", "/b/claude"]), Some(&kept)).as_deref(), Some("/a/claude"));
    }

    #[test]
    fn when_every_copy_fails_the_first_stays() {
        let c = copies(&["/a/claude", "/b/claude", "/c/claude"]);
        let probe = answers(&[("/b/claude", None), ("/c/claude", None)]);
        let (path, answer, skipped) = choose_copy(&c, VersionAnswer::Fails, false, "", probe);
        assert_eq!((path.as_deref(), answer, skipped), (Some("/a/claude"), Some(VersionAnswer::Fails), None));
        assert_eq!(choose_copy(&[], VersionAnswer::Fails, false, "", |_: &str, _: &str| VersionAnswer::Fails).0, None);
    }

    #[cfg(unix)]
    #[test]
    fn every_copy_on_path_is_a_candidate_once() {
        let tmp = tempfile::tempdir().unwrap();
        let (a, b) = (tmp.path().join("a"), tmp.path().join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("claude"), "#!/bin/sh\n").unwrap();
        std::os::unix::fs::symlink(a.join("claude"), b.join("claude")).unwrap();
        std::fs::write(b.join("other"), "").unwrap();
        let path = format!("{}:{}", a.display(), b.display());
        assert_eq!(find_all_in_path(&path, "claude"), [a.join("claude").to_string_lossy().into_owned()]);
    }
}
