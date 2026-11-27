//! Build caches in card worktrees: the trash GC schedule, its in-memory
//! log for Activity, and the shared Cargo target a card's Verify gets.
//!
//! The filesystem work lives in `worktrees` (`gc_trash`, `strip_caches`,
//! `shared_build_env`); this module decides when it runs and for whom,
//! reading the workspace list and each project's config.
//!
//! The cleanup log is not persisted: Activity is a pure view, and the
//! launch pass records itself again on the next launch.
//!
//! Only Verify shares the target, and only after [`reset_shared_target`].
//! Cargo decides a path crate is fresh by comparing its sources' mtimes
//! with the last build, and records those sources relative to the package
//! root, so two worktrees of one repo look like the same crate: a worktree
//! whose files are older than another card's last build reuses that card's
//! compiled code. Verify runs one at a time, so cleaning the workspace's
//! own packages from the shared target first makes them rebuild from this
//! card while every dependency stays compiled. Builder sessions run cargo
//! whenever they like, with nothing in between to reset, so they keep
//! their own `target/`.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::{AppHandle, Manager, Runtime};

use crate::inbox::ActivityRow;
use crate::project_config::ProjectConfigStore;
use crate::workspace::WorkspaceStore;
use crate::worktrees::TrashGc;

/// The timer's period: a Mac that stays open for days still sweeps.
const DAILY: Duration = Duration::from_secs(24 * 60 * 60);
const LOG_CAP: usize = 50;

/// What started a trash pass, shown in its Activity row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GcTrigger {
    Launch,
    Daily,
    Sync,
}

impl GcTrigger {
    fn label(self) -> &'static str {
        match self {
            GcTrigger::Launch => "at launch",
            GcTrigger::Daily => "daily sweep",
            GcTrigger::Sync => "after Sync",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TrashCleanup {
    pub workspace_id: String,
    pub at: i64,
    pub trigger: GcTrigger,
    pub gc: TrashGc,
}

/// Recent trash passes worth showing — one that freed something, or one
/// that kept a staged checkout something wrote to. Newest last.
#[derive(Default)]
pub struct TrashCleanupLog {
    entries: Mutex<VecDeque<TrashCleanup>>,
}

impl TrashCleanupLog {
    fn record(&self, entry: TrashCleanup) {
        let mut entries = self.entries.lock();
        entries.push_back(entry);
        while entries.len() > LOG_CAP {
            entries.pop_front();
        }
    }

    pub fn snapshot(&self) -> Vec<TrashCleanup> {
        self.entries.lock().iter().cloned().collect()
    }
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Run one trash pass for a workspace and log it when it freed anything.
pub fn gc_workspace<R: Runtime>(
    app: &AppHandle<R>,
    workspace_id: &str,
    cwd: &Path,
    trigger: GcTrigger,
) -> TrashGc {
    let cache_paths = app
        .try_state::<ProjectConfigStore>()
        .map(|store| store.cache_paths(workspace_id))
        .unwrap_or_default();
    let gc = crate::worktrees::gc_trash(cwd, &cache_paths);
    // N18: right after the trash, the branches of cards whose entry it just
    // reaped (or whose week is up with no entry); `gc_trash` deletes none.
    crate::branch_cleanup::sweep_for_app(app, workspace_id, trigger == GcTrigger::Launch);
    // GH #116: a pass that kept an entry is worth recording even when it
    // freed nothing. Such an entry holds a write that raced a card
    // delete, it is the only copy of it, and nothing else in the app
    // shows it — the Worktrees panel lists live worktrees, not the
    // trash — so this row is how the human learns it is there.
    if gc.freed_bytes > 0 || gc.kept_changed > 0 {
        log::info!(
            "build cache: {workspace_id} trash {}: {} expired, {} kept (written to after \
             their card was deleted), {} cache dir(s) stripped, {} freed",
            trigger.label(),
            gc.expired,
            gc.kept_changed,
            gc.stripped_dirs,
            format_bytes(gc.freed_bytes)
        );
        if let Some(log) = app.try_state::<TrashCleanupLog>() {
            log.record(TrashCleanup {
                workspace_id: workspace_id.to_string(),
                at: now_millis(),
                trigger,
                gc,
            });
        }
    }
    gc
}

fn workspace_cwds<R: Runtime>(app: &AppHandle<R>) -> Vec<(String, PathBuf)> {
    app.try_state::<WorkspaceStore>()
        .map(|store| {
            store
                .snapshot()
                .workspaces
                .into_iter()
                .map(|w| (w.id, PathBuf::from(w.cwd)))
                .collect()
        })
        .unwrap_or_default()
}

/// The launch pass, then one pass a day, over every workspace, on a thread
/// of its own: healing a trash full of build output removes gigabytes and
/// must not hold up the window. The thread owns no child process; it ends
/// with the app.
pub fn spawn_trash_gc<R: Runtime>(app: AppHandle<R>) {
    let spawned = std::thread::Builder::new()
        .name("ply-trash-gc".into())
        .spawn(move || {
            let mut trigger = GcTrigger::Launch;
            loop {
                for (id, cwd) in workspace_cwds(&app) {
                    gc_workspace(&app, &id, &cwd, trigger);
                }
                std::thread::sleep(DAILY);
                trigger = GcTrigger::Daily;
            }
        });
    if let Err(e) = spawned {
        log::warn!("build cache: trash GC thread failed to start: {e}");
    }
}

/// The environment a Verify run in `run_cwd` gets for the shared Cargo
/// target (see `worktrees::shared_build_env`): empty when the project turned
/// `shared_build_cache` off, the workspace is unknown, or `run_cwd` isn't one
/// of its card worktrees. The caller resets the target before using it
/// ([`reset_shared_target`]).
pub fn verify_env<R: Runtime>(
    app: &AppHandle<R>,
    workspace_id: &str,
    run_cwd: &Path,
) -> Vec<(String, String)> {
    let Some(cwd) = workspace_cwds(app)
        .into_iter()
        .find_map(|(id, cwd)| (id == workspace_id).then_some(cwd))
    else {
        return Vec::new();
    };
    let enabled = app
        .try_state::<ProjectConfigStore>()
        .is_none_or(|store| store.shared_build_cache(workspace_id));
    crate::worktrees::shared_build_env(&cwd, run_cwd, enabled)
}

/// Bound on each `cargo metadata` / `cargo clean` of a reset.
const CARGO_TIMEOUT: Duration = Duration::from_secs(120);

/// What [`reset_shared_target`] decided for one Verify run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SharedTarget {
    /// Every local crate was cleaned out of the shared target: use it.
    Ready,
    /// No Cargo manifest in the checkout: nothing would use the target.
    NoCargo,
    /// The checkout doesn't declare [`OPT_IN_MARKER`]: nothing says its
    /// scripts look for build output where `CARGO_TARGET_DIR` puts it, and
    /// a script running `./target/debug/x` after `cargo build` would run the
    /// worktree's own older binary. Verify there keeps the worktree's target.
    NotDeclared,
}

/// Committed in a repository whose Verify scripts read Cargo output through
/// `CARGO_TARGET_DIR` (or never read it). Only a checkout that carries it
/// gets the shared target, so a card branched before its scripts learned
/// the variable verifies as it always did. It is the repository's claim,
/// versioned with the scripts it is about; `sharedBuildCache` is the
/// owner's switch on top.
pub const OPT_IN_MARKER: &str = ".atelier/shared-cargo-target";

/// Held by a Verify for its whole run on the shared target, and briefly by
/// [`clear_shared_target`] while it moves the directory aside. Verify is the
/// only thing Ply points at the shared target, so this is the exclusion.
static SHARED_TARGET_USE: Mutex<()> = parking_lot::const_mutex(());

/// Wait for any Clear's move-aside to finish, then keep the shared target
/// from being cleared until the guard drops.
pub fn hold_shared_target() -> parking_lot::MutexGuard<'static, ()> {
    SHARED_TARGET_USE.lock()
}

/// The Doctor's Clear: refused while a Verify uses the shared target. The
/// directory is renamed aside under the guard, then deleted without it, so
/// a Verify starting meanwhile gets a fresh target.
pub fn clear_shared_target(workspace_cwd: &Path) -> Result<u64, String> {
    let Some(guard) = SHARED_TARGET_USE.try_lock() else {
        return Err(
            "a Verify is using the shared build cache; clear it when the Verify finishes"
                .to_string(),
        );
    };
    crate::worktrees::move_shared_target_aside(workspace_cwd)?;
    drop(guard);
    crate::worktrees::delete_cleared_targets(workspace_cwd)
}

/// Make the shared target safe for one Verify run in the card checkout
/// `repo_root`: `cargo clean -p` for every local crate, in each profile
/// directory the shared target holds. The local crates of each Cargo
/// workspace in the checkout (submodules included) are its members, from
/// `cargo metadata --no-deps`, plus every package its `Cargo.lock` records
/// without a source: path dependencies outside the members. An error means
/// the target may still hold another card's build (a workspace without a
/// `Cargo.lock`, or with one its manifests have outgrown, can't prove which
/// local crates it builds): the caller must not use it.
pub fn reset_shared_target(
    repo_root: &Path,
    env: &[(String, String)],
) -> Result<SharedTarget, String> {
    let target = env
        .iter()
        .find_map(|(k, v)| (k == "CARGO_TARGET_DIR").then(|| PathBuf::from(v)))
        .ok_or("no shared target in the environment")?;
    let manifests = cargo_manifests(repo_root);
    if manifests.is_empty() {
        return Ok(SharedTarget::NoCargo);
    }
    if !repo_root.join(OPT_IN_MARKER).is_file() {
        return Ok(SharedTarget::NotDeclared);
    }
    // Manifests of members already cleaned through their workspace.
    let mut covered: Vec<PathBuf> = Vec::new();
    for manifest in &manifests {
        if covered.iter().any(|m| same_file(m, manifest)) {
            continue;
        }
        let json = run_cargo(
            repo_root,
            &[
                "metadata".into(),
                "--no-deps".into(),
                "--frozen".into(),
                "--format-version".into(),
                "1".into(),
                "--manifest-path".into(),
                manifest.to_string_lossy().into_owned(),
            ],
            env,
        )?;
        let (root, members) = parse_workspace_members(&json)?;
        covered.extend(members.iter().map(|m| m.manifest_path.clone()));
        let lock = std::fs::read_to_string(root.join("Cargo.lock")).map_err(|e| {
            format!("{}: no readable Cargo.lock to list its local crates ({e})", root.display())
        })?;
        let mut names: Vec<String> = members.into_iter().map(|m| m.name).collect();
        names.extend(local_lock_packages(&lock));
        names.sort_unstable();
        names.dedup();
        if names.is_empty() {
            continue;
        }
        // `--frozen`: the lock file must already describe this checkout's
        // graph. `--offline` alone quietly rewrites it (a path dependency
        // the card added but never locked), cleaning without the new crate
        // and editing the card's checkout during Verify. At least one clean
        // runs even on an empty target, so that check always happens.
        let mut profiles = profile_dirs(&target);
        if profiles.is_empty() {
            profiles.push(Vec::new());
        }
        for profile_args in profiles {
            let mut args: Vec<String> = vec![
                "clean".into(),
                "--frozen".into(),
                "--manifest-path".into(),
                manifest.to_string_lossy().into_owned(),
            ];
            args.extend(profile_args);
            // Plain names: `cargo clean` ignores a version qualifier.
            for name in &names {
                args.push("-p".into());
                args.push(name.clone());
            }
            run_cargo(repo_root, &args, env)?;
        }
    }
    Ok(SharedTarget::Ready)
}

/// The packages a `Cargo.lock` records without a `source`: the workspace's
/// members and its path dependencies. Registry and git packages carry one.
fn local_lock_packages(lock: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current: Option<(Option<String>, bool)> = None;
    let mut flush = |entry: Option<(Option<String>, bool)>, out: &mut Vec<String>| {
        if let Some((Some(name), false)) = entry {
            out.push(name);
        }
    };
    for line in lock.lines().map(str::trim) {
        if line == "[[package]]" {
            flush(current.take(), &mut out);
            current = Some((None, false));
        } else if line.starts_with('[') {
            flush(current.take(), &mut out);
        } else if let Some((name, has_source)) = current.as_mut() {
            if let Some(v) = line.strip_prefix("name = ") {
                *name = Some(v.trim_matches('"').to_string());
            } else if line.starts_with("source = ") {
                *has_source = true;
            }
        }
    }
    flush(current, &mut out);
    out
}

fn same_file(a: &Path, b: &Path) -> bool {
    a == b || matches!((crate::platform::canonicalize(a), crate::platform::canonicalize(b)), (Ok(x), Ok(y)) if x == y)
}

/// Every `Cargo.toml` git sees in the checkout, tracked or untracked but
/// not ignored (so no `target/` or vendored build output), shallowest first
/// so a workspace root is read before its members.
fn cargo_manifests(repo_root: &Path) -> Vec<PathBuf> {
    // `--recurse-submodules` can't be combined with `--others`: two lists.
    let list = |args: &[&str]| {
        crate::platform::git_command()
            .args(["ls-files", "-z"])
            .args(args)
            .args(["--", "*Cargo.toml"])
            .current_dir(repo_root)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| o.stdout)
            .unwrap_or_default()
    };
    let mut listed = list(&["--cached", "--others", "--exclude-standard"]);
    listed.push(0);
    listed.extend(list(&["--cached", "--recurse-submodules"]));
    let mut manifests: Vec<PathBuf> = listed
        .split(|b| *b == 0)
        .filter_map(|rel| std::str::from_utf8(rel).ok())
        .filter(|rel| Path::new(rel).file_name().is_some_and(|n| n == "Cargo.toml"))
        .map(|rel| repo_root.join(rel))
        .filter(|m| m.is_file())
        .collect();
    manifests.sort_by_key(|m| (m.components().count(), m.clone()));
    manifests.dedup();
    manifests
}

struct Member {
    name: String,
    manifest_path: PathBuf,
}

/// The workspace root and the members `cargo metadata --no-deps
/// --format-version 1` lists.
fn parse_workspace_members(json: &str) -> Result<(PathBuf, Vec<Member>), String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("read cargo metadata: {e}"))?;
    let root = v["workspace_root"]
        .as_str()
        .map(PathBuf::from)
        .ok_or("cargo metadata has no workspace_root")?;
    let members = v["packages"]
        .as_array()
        .map(|packages| {
            packages
                .iter()
                .filter_map(|p| {
                    Some(Member {
                        name: p["name"].as_str()?.to_string(),
                        manifest_path: PathBuf::from(p["manifest_path"].as_str()?),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok((root, members))
}

/// The profile directories under a target dir, as `cargo clean` arguments:
/// `debug` (dev and test) takes none, `release` takes `--release`, a custom
/// profile `--profile <name>`, and a `<triple>/<profile>` directory adds
/// `--target <triple>`. A profile directory is one holding `.fingerprint`.
fn profile_dirs(target: &Path) -> Vec<Vec<String>> {
    fn subdirs(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| !n.starts_with('.'))
            .collect();
        names.sort();
        names
    }
    fn profile_flag(name: &str) -> Vec<String> {
        match name {
            "debug" => Vec::new(),
            "release" => vec!["--release".into()],
            other => vec!["--profile".into(), other.into()],
        }
    }
    let mut out = Vec::new();
    for name in subdirs(target) {
        let dir = target.join(&name);
        if dir.join(".fingerprint").is_dir() {
            out.push(profile_flag(&name));
            continue;
        }
        for profile in subdirs(&dir) {
            if dir.join(&profile).join(".fingerprint").is_dir() {
                let mut args = vec!["--target".to_string(), name.clone()];
                args.extend(profile_flag(&profile));
                out.push(args);
            }
        }
    }
    out
}

/// The reset's cargo children, killed on app exit (Hard Rule #4) like
/// `git fetch`: each runs in its own process group, registered at spawn.
static CARGO_RESETS: crate::worktrees::FetchRegistry =
    crate::worktrees::FetchRegistry::refusing_with("Plyloft is quitting; no cargo reset was started");

/// App exit: refuse new resets and kill every in-flight cargo group.
/// Returns how many groups were signalled.
pub fn kill_active_resets() -> usize {
    CARGO_RESETS.shutdown()
}

fn run_cargo(cwd: &Path, args: &[String], env: &[(String, String)]) -> Result<String, String> {
    run_cargo_in(&CARGO_RESETS, cwd, args, env, CARGO_TIMEOUT)
}

/// cargo on `path`, else where rustup installs it, else the bare name (and
/// the spawn's own not-found error).
#[cfg(windows)]
fn windows_cargo(path: &str) -> std::path::PathBuf {
    crate::shell_env::find_in_path(path, "cargo")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            let rustup = crate::platform::home_dir()?.join(".cargo").join("bin").join("cargo.exe");
            rustup.is_file().then_some(rustup)
        })
        .unwrap_or_else(|| "cargo".into())
}

/// Run cargo in `cwd` with the cached PATH (and `~/.cargo/env`, as Verify's
/// steps do), bounded by `timeout`. Output goes to files, not pipes, so a
/// large `cargo metadata` can't stall the child. The child runs in its own
/// process group registered with `registry`, so a timeout or app exit kills
/// cargo and whatever it started; the group is killed again before it is
/// unregistered, so nothing it left behind outlives the call.
fn run_cargo_in(
    registry: &crate::worktrees::FetchRegistry,
    cwd: &Path,
    args: &[String],
    env: &[(String, String)],
    timeout: Duration,
) -> Result<String, String> {
    let verb = args.first().map_or("", |a| a.as_str());
    let stdout = tempfile::NamedTempFile::new().map_err(|e| format!("cargo stdout: {e}"))?;
    let stderr = tempfile::NamedTempFile::new().map_err(|e| format!("cargo stderr: {e}"))?;
    let path = crate::shell_env::try_get()
        .map(|e| e.path.clone())
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    // By absolute path: `Command` looks the program up on the PATH it is
    // given, and a cached PATH may lack /bin.
    #[cfg(unix)]
    let mut cmd = {
        let mut cmd = crate::platform::new_command("/bin/bash");
        cmd.arg("-c")
            .arg(r#"source "$HOME/.cargo/env" >/dev/null 2>&1; exec cargo "$@""#)
            .arg("cargo");
        cmd
    };
    // rustup's installer puts cargo on the user PATH, so there is no env
    // file to source; a PATH cached before the install lacks it.
    #[cfg(windows)]
    let mut cmd = crate::platform::new_command(windows_cargo(&path));
    cmd.args(args)
        .current_dir(cwd)
        .env("PATH", path)
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(stdout.reopen().map_err(|e| format!("cargo stdout: {e}"))?)
        .stderr(stderr.reopen().map_err(|e| format!("cargo stderr: {e}"))?);
    crate::platform::own_group(&mut cmd);
    let (mut child, _group) = registry.spawn(&mut cmd).map_err(|e| format!("cargo {verb}: {e}"))?;
    // The process group created above, whose id is our child's pid.
    let kill_group =
        |child: &std::process::Child| crate::platform::kill_group(child.id() as crate::platform::Pgid);
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                kill_group(&child);
                let _ = child.wait();
                return Err(format!("cargo {verb} timed out"));
            }
            Err(e) => return Err(format!("wait for cargo: {e}")),
        }
    };
    kill_group(&child);
    if !status.success() {
        let err = std::fs::read_to_string(stderr.path()).unwrap_or_default();
        // The first error names the cause; the last line only counts them.
        let cause = err
            .lines()
            .skip_while(|l| !l.starts_with("error"))
            .take(6)
            .collect::<Vec<_>>()
            .join("\n");
        let cause = if cause.is_empty() { format!("{status}") } else { cause };
        return Err(format!("cargo {verb} failed: {}", cause.trim()));
    }
    std::fs::read_to_string(stdout.path()).map_err(|e| format!("read cargo output: {e}"))
}

/// Activity rows for the logged passes inside the window.
pub fn activity_rows(
    log: &[TrashCleanup],
    names: &std::collections::HashMap<String, String>,
    window_start: i64,
) -> Vec<ActivityRow> {
    log.iter()
        .filter(|e| e.at >= window_start)
        .filter_map(|e| {
            let workspace_name = names.get(&e.workspace_id)?.clone();
            let mut parts = Vec::new();
            if e.gc.stripped_dirs > 0 {
                parts.push(format!(
                    "{} build cache dir{} stripped",
                    e.gc.stripped_dirs,
                    if e.gc.stripped_dirs == 1 { "" } else { "s" }
                ));
            }
            if e.gc.expired > 0 {
                parts.push(format!(
                    "{} expired entr{} removed",
                    e.gc.expired,
                    if e.gc.expired == 1 { "y" } else { "ies" }
                ));
            }
            if e.gc.kept_changed > 0 {
                parts.push(format!(
                    "{} kept: written to after the card was deleted",
                    e.gc.kept_changed
                ));
            }
            parts.push(e.trigger.label().to_string());
            // A pass that only kept something freed nothing, and saying
            // "0 B freed" would bury the one thing worth reading.
            let title = if e.gc.freed_bytes == 0 && e.gc.kept_changed > 0 {
                "Worktree trash: kept work that outlived its card".to_string()
            } else {
                format!("Worktree trash: {} freed", format_bytes(e.gc.freed_bytes))
            };
            Some(ActivityRow {
                id: format!("cleanup:{}:{}", e.workspace_id, e.at),
                kind: "cleanup".into(),
                state: "done".into(),
                title,
                detail: parts.join(" · "),
                workspace_id: e.workspace_id.clone(),
                workspace_name,
                card_id: None,
                run_id: None,
                at: e.at,
                count: 1,
                card_deleted: false,
            })
        })
        .collect()
}

/// `1.4 GB`, `333 MB`, `12 KB` — decimal units, as Finder shows sizes.
pub fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if bytes < 1000 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64;
    let mut unit = "B";
    for u in UNITS {
        if value < 1000.0 {
            break;
        }
        value /= 1000.0;
        unit = u;
    }
    if value < 10.0 {
        format!("{value:.1} {unit}")
    } else {
        format!("{value:.0} {unit}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn git(dir: &Path, args: &[&str]) {
        let out = crate::platform::git_command().args(args).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// The version lives in `dep/`, a path dependency git doesn't list
    /// (ignored) and the root workspace excludes: only `Cargo.lock` names it.
    fn write_version(checkout: &Path, version: u32) {
        std::fs::create_dir_all(checkout.join("dep/src")).unwrap();
        std::fs::write(
            checkout.join("dep/Cargo.toml"),
            "[package]\nname = \"stale_dep\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .unwrap();
        std::fs::write(
            checkout.join("dep/src/lib.rs"),
            format!("pub fn v() -> u32 {{ {version} }}\n"),
        )
        .unwrap();
    }

    /// Which `v()` a `cargo test` in `checkout` actually ran.
    fn tested_version(checkout: &Path, env: &[(String, String)]) -> String {
        let args: Vec<String> =
            ["test", "--offline", "-q", "--", "--nocapture"].map(String::from).to_vec();
        let out = run_cargo(checkout, &args, env).unwrap();
        out.lines().find(|l| l.starts_with("VERSION=")).unwrap_or("none").to_string()
    }

    fn cargo_available() -> bool {
        crate::platform::new_command("/bin/bash")
            .args(["-c", r#"source "$HOME/.cargo/env" >/dev/null 2>&1; command -v cargo"#])
            .output()
            .is_ok_and(|o| o.status.success())
    }

    /// The experiment behind Verify-only sharing, against real cargo: two
    /// worktrees of one crate share a target; B's edit predates A's build.
    /// Without the reset B's `cargo test` runs A's code; after it, B's own —
    /// including a path dependency only `Cargo.lock` lists.
    #[test]
    fn a_shared_target_builds_the_other_worktree_unless_reset() {
        if !cargo_available() {
            eprintln!("cargo not available; skipping");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::write(
            repo.join("Cargo.toml"),
            "[package]\nname = \"stale_probe\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n\
             [dependencies]\nstale_dep = { path = \"dep\" }\n\n[workspace]\nexclude = [\"dep\"]\n",
        )
        .unwrap();
        std::fs::write(
            repo.join("src/lib.rs"),
            "#[test] fn which() { println!(\"VERSION={}\", stale_dep::v()); }\n",
        )
        .unwrap();
        std::fs::write(repo.join(".gitignore"), "target/\n/dep/\n").unwrap();
        std::fs::create_dir_all(repo.join(".atelier")).unwrap();
        std::fs::write(repo.join(OPT_IN_MARKER), "").unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["add", "-A"]);
        git(&repo, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base"]);
        let (a, b) = (tmp.path().join("a"), tmp.path().join("b"));
        git(&repo, &["worktree", "add", "-q", b.to_str().unwrap(), "-b", "b"]);
        git(&repo, &["worktree", "add", "-q", a.to_str().unwrap(), "-b", "a"]);
        write_version(&b, 2);
        std::thread::sleep(Duration::from_millis(1100));
        write_version(&a, 1);
        let shared = tmp.path().join("shared-target");
        let env = vec![
            ("CARGO_TARGET_DIR".to_string(), shared.to_string_lossy().into_owned()),
            // Other tests install a fake cached shell PATH; this one needs
            // the real toolchain (cargo, the `cc` linker).
            ("PATH".to_string(), std::env::var("PATH").unwrap_or_default()),
        ];

        // No Cargo.lock yet: which local crates it builds can't be proven.
        assert!(reset_shared_target(&b, &env).unwrap_err().contains("Cargo.lock"));

        assert_eq!(tested_version(&a, &env), "VERSION=1");
        assert_eq!(tested_version(&b, &env), "VERSION=1", "the stale build this guards against");

        assert_eq!(reset_shared_target(&b, &env), Ok(SharedTarget::Ready));
        assert_eq!(tested_version(&b, &env), "VERSION=2");
        assert_eq!(reset_shared_target(&a, &env), Ok(SharedTarget::Ready));
        assert_eq!(tested_version(&a, &env), "VERSION=1");

        // B adds a path dependency and never updates its lock file: the
        // graph isn't proven, so no reset, and the lock file is left as is.
        let lock_before = std::fs::read_to_string(b.join("Cargo.lock")).unwrap();
        std::fs::create_dir_all(b.join("newdep/src")).unwrap();
        std::fs::write(
            b.join("newdep/Cargo.toml"),
            "[package]\nname = \"newdep\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .unwrap();
        std::fs::write(b.join("newdep/src/lib.rs"), "pub fn x() {}\n").unwrap();
        let manifest = std::fs::read_to_string(b.join("Cargo.toml")).unwrap().replace(
            "[dependencies]\n",
            "[dependencies]\nnewdep = { path = \"newdep\" }\n",
        );
        std::fs::write(b.join("Cargo.toml"), manifest).unwrap();
        let refused = reset_shared_target(&b, &env).unwrap_err();
        assert!(refused.contains("--frozen"), "got {refused:?}");
        assert_eq!(std::fs::read_to_string(b.join("Cargo.lock")).unwrap(), lock_before);

        let plain = tempfile::tempdir().unwrap();
        assert_eq!(reset_shared_target(plain.path(), &env), Ok(SharedTarget::NoCargo));
    }

    #[cfg(windows)]
    #[test]
    fn cargo_is_found_on_path_or_where_rustup_puts_it() {
        let lower = |p: std::path::PathBuf| p.to_string_lossy().to_lowercase();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("cargo.exe"), b"MZ").unwrap();
        let on_path = windows_cargo(&dir.path().display().to_string());
        assert_eq!(lower(on_path), lower(dir.path().join("cargo.exe")));
        let rustup = crate::platform::home_dir().unwrap().join(".cargo").join("bin").join("cargo.exe");
        let expected = if rustup.is_file() { rustup } else { "cargo".into() };
        assert_eq!(lower(windows_cargo("")), lower(expected));
    }

    /// App exit kills a reset's cargo and what cargo started, and refuses
    /// new ones.
    #[cfg(unix)]
    #[test]
    fn quitting_kills_an_in_flight_cargo_reset_and_its_children() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let pid_file = tmp.path().join("grandchild.pid");
        // A cargo that starts a long-lived child of its own and waits.
        std::fs::write(
            bin.join("cargo"),
            format!("#!/bin/sh\nsleep 60 &\necho $! > '{}'\nwait\n", pid_file.display()),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(bin.join("cargo"), std::fs::Permissions::from_mode(0o755)).unwrap();
        // No `~/.cargo/env` in this HOME, so the fake cargo is the one run.
        let env = vec![
            ("HOME".to_string(), tmp.path().to_string_lossy().into_owned()),
            ("PATH".to_string(), format!("{}:/bin:/usr/bin", bin.display())),
        ];
        static REGISTRY: crate::worktrees::FetchRegistry =
            crate::worktrees::FetchRegistry::refusing_with("quitting");
        let cwd = tmp.path().to_path_buf();
        let run = {
            let env = env.clone();
            std::thread::spawn(move || {
                run_cargo_in(&REGISTRY, &cwd, &["clean".into()], &env, Duration::from_secs(60))
            })
        };
        let started = Instant::now();
        while !pid_file.exists() || std::fs::read_to_string(&pid_file).unwrap().trim().is_empty() {
            assert!(started.elapsed() < Duration::from_secs(10), "fake cargo never started");
            std::thread::sleep(Duration::from_millis(20));
        }
        let grandchild: i32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();

        assert_eq!(REGISTRY.shutdown(), 1);
        let result = run.join().unwrap();
        assert!(result.is_err(), "a killed reset is no reset");
        assert!(started.elapsed() < Duration::from_secs(10));
        let deadline = Instant::now() + Duration::from_secs(5);
        // SAFETY: signal 0 only probes whether the pid exists.
        while unsafe { libc::kill(grandchild, 0) } == 0 {
            assert!(Instant::now() < deadline, "cargo's child outlived the quit");
            std::thread::sleep(Duration::from_millis(20));
        }
        let refused = run_cargo_in(&REGISTRY, tmp.path(), &["clean".into()], &env, Duration::from_secs(1));
        assert!(refused.unwrap_err().contains("quitting"));
    }

    #[test]
    fn only_a_checkout_that_declares_it_gets_the_shared_target() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        git(repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("Cargo.toml"), "[package]\nname = \"x\"\n").unwrap();
        // A script that would run an old local binary after building into
        // the shared target, while another file mentions the variable.
        std::fs::create_dir_all(repo.join("scripts")).unwrap();
        std::fs::write(repo.join("scripts/check.sh"), "cargo build\n./target/debug/check\n").unwrap();
        std::fs::write(repo.join("scripts/env.sh"), "echo $CARGO_TARGET_DIR\n").unwrap();
        let env = vec![("CARGO_TARGET_DIR".to_string(), "/nonexistent".to_string())];
        assert_eq!(reset_shared_target(repo, &env), Ok(SharedTarget::NotDeclared));

        std::fs::create_dir_all(repo.join(".atelier")).unwrap();
        std::fs::write(repo.join(OPT_IN_MARKER), "").unwrap();
        // Declared: the reset proceeds (here to cargo, which finds no lock).
        assert_ne!(reset_shared_target(repo, &env), Ok(SharedTarget::NotDeclared));
    }

    #[test]
    fn clear_is_refused_while_a_verify_holds_the_shared_target() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path();
        let target = crate::worktrees::shared_target_dir(ws);
        std::fs::create_dir_all(target.join("debug/deps")).unwrap();
        std::fs::write(target.join("debug/deps/libx.rlib"), vec![1u8; 8192]).unwrap();

        let verify = hold_shared_target();
        assert!(clear_shared_target(ws).unwrap_err().contains("a Verify is using"));
        assert!(target.join("debug/deps/libx.rlib").exists());
        drop(verify);

        assert!(clear_shared_target(ws).unwrap() >= 8192);
        assert!(!target.exists());
        // Free again for the next Verify.
        drop(hold_shared_target());
    }

    #[test]
    fn a_lockfile_names_its_local_crates() {
        let lock = r#"# This file is automatically @generated by Cargo.
version = 4

[[package]]
name = "app"
version = "0.1.0"
dependencies = [
 "serde",
 "vendored",
]

[[package]]
name = "serde"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "abc"

[[package]]
name = "pinned"
version = "0.2.0"
source = "git+https://example.com/pinned#deadbeef"

[[package]]
name = "vendored"
version = "0.3.0"
"#;
        assert_eq!(local_lock_packages(lock), vec!["app".to_string(), "vendored".to_string()]);
    }

    #[test]
    fn profile_dirs_become_cargo_clean_arguments() {
        let tmp = tempfile::tempdir().unwrap();
        for dir in [
            "debug/.fingerprint",
            "release/.fingerprint",
            "ci/.fingerprint",
            "aarch64-apple-darwin/debug/.fingerprint",
            "aarch64-apple-darwin/release/.fingerprint",
            "tmp",
            "aarch64-apple-darwin/release/bundle",
        ] {
            std::fs::create_dir_all(tmp.path().join(dir)).unwrap();
        }
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            profile_dirs(tmp.path()),
            vec![
                args(&["--target", "aarch64-apple-darwin"]),
                args(&["--target", "aarch64-apple-darwin", "--release"]),
                args(&["--profile", "ci"]),
                args(&[]),
                args(&["--release"]),
            ]
        );
    }

    #[test]
    fn bytes_read_like_finder() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(12_345), "12 KB");
        assert_eq!(format_bytes(333_000_000), "333 MB");
        assert_eq!(format_bytes(4_200_000_000), "4.2 GB");
        assert_eq!(format_bytes(81_000_000_000), "81 GB");
    }

    /// GH #116: a pass that freed nothing but kept a staged checkout
    /// something wrote to is the one row the human must not miss — the
    /// trash is not in the Worktrees panel, so this is where they learn
    /// the folder is there. It must not read as "0 B freed".
    #[test]
    fn a_pass_that_only_kept_work_says_so_rather_than_nothing_freed() {
        let names = HashMap::from([("ws".to_string(), "Atelier".to_string())]);
        let rows = activity_rows(
            &[TrashCleanup {
                workspace_id: "ws".into(),
                at: 1_000,
                trigger: GcTrigger::Daily,
                gc: TrashGc {
                    expired: 0,
                    kept_changed: 1,
                    stripped_dirs: 0,
                    freed_bytes: 0,
                },
            }],
            &names,
            0,
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "Worktree trash: kept work that outlived its card");
        assert!(
            rows[0].detail.contains("1 kept: written to after the card was deleted"),
            "got {}",
            rows[0].detail
        );
    }

    #[test]
    fn a_cleanup_reads_as_one_activity_row_per_pass_inside_the_window() {
        let names = HashMap::from([("ws".to_string(), "Atelier".to_string())]);
        let pass = |at, trigger, gc| TrashCleanup {
            workspace_id: "ws".into(),
            at,
            trigger,
            gc,
        };
        let log = vec![
            pass(10, GcTrigger::Launch, TrashGc { expired: 0, kept_changed: 0, stripped_dirs: 3, freed_bytes: 1 }),
            pass(
                200,
                GcTrigger::Sync,
                TrashGc { expired: 1, kept_changed: 0, stripped_dirs: 1, freed_bytes: 4_200_000_000 },
            ),
            TrashCleanup { workspace_id: "gone".into(), ..pass(300, GcTrigger::Daily, TrashGc::default()) },
        ];
        let rows = activity_rows(&log, &names, 100);
        assert_eq!(rows.len(), 1, "outside the window and unknown workspaces drop");
        assert_eq!(rows[0].kind, "cleanup");
        assert_eq!(rows[0].title, "Worktree trash: 4.2 GB freed");
        assert_eq!(
            rows[0].detail,
            "1 build cache dir stripped · 1 expired entry removed · after Sync"
        );
        assert_eq!(rows[0].workspace_name, "Atelier");
    }
}
