//! v1.9.0 (Phase A): per-card ship pipeline.
//!
//! Mechanics: branch check → version bump → `git add -A` → `git commit`
//! with `Card:` / `Verified-By:` trailers → `git tag v<X.Y.Z>` →
//! optional `git push --follow-tags` → invoke `scripts/install-local.sh`
//! (detached). The detached install kills Atelier ~2s later and replaces
//! `/Applications/Atelier.app`.
//!
//! Phase A is verify-less: a card's `ship_status` flips to `Shipped` and
//! a `ShipEntry` is appended without consulting any verify pipeline.
//! Phase B+ wires the verify gate in front of ship.
//!
//! Concurrent-ship lock (decision 21): one ship at a time across the app.
//! The lock is acquired at the start of `ship_card`/`ship_audit_force` and
//! released either on early-error or after the detached install fires.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use crate::platform::THIS_MACHINE;
use crate::agents::AgentRegistry;
use crate::git::{capture as git_capture, run as git_run};
use crate::intake::IntakeRegistry;
use crate::kanban::{
    KanbanCard, KanbanColumnId, KanbanStore, ReleaseKind, ShipEntry, ShipStatus,
    VerifyStatus,
};
use crate::project_config::{
    self, ProjectConfig, ProjectConfigStore, VersionFileKind,
};
use crate::pty::PtyRegistry;
use crate::reviewer::ReviewerRegistry;
use crate::discussion::DiscussionRegistry;
use crate::coordination::CoordinationRegistry;
use crate::swarms::{SwarmRegistry, SwarmStatus};
use crate::workspace::WorkspaceStore;
use crate::worktrees::ShipError;

/// v1.12.4 (Cycle C): per-project concurrent-ship lock. Pre-v1.12.4
/// the lock was a single boolean — only one ship at a time across the
/// entire app. With multi-project workspaces (LYRA + Atelier + …),
/// each project ships through an independent pipeline; serializing
/// across projects was over-restrictive. Now: same-workspace ships
/// still serialize; different-workspace ships can run concurrently.
///
/// Implementation: a `HashSet<workspace_id>` of currently-shipping
/// workspaces. `try_acquire(workspace_id)` returns `None` only when
/// THAT workspace already has an in-flight ship.
#[derive(Default)]
pub struct ShipRegistry {
    in_flight: Arc<Mutex<std::collections::HashSet<String>>>,
}

impl ShipRegistry {
    /// Returns `Some(guard)` when the per-workspace lock was acquired;
    /// `None` when this workspace already has a ship in progress.
    /// Other workspaces' ships are unaffected. The guard releases
    /// the lock on drop.
    pub fn try_acquire(&self, workspace_id: &str) -> Option<ShipLockGuard> {
        let arc = self.in_flight.clone();
        let mut held = arc.lock();
        if held.contains(workspace_id) {
            return None;
        }
        held.insert(workspace_id.to_string());
        drop(held);
        Some(ShipLockGuard {
            in_flight: arc,
            workspace_id: workspace_id.to_string(),
        })
    }

    /// True iff *any* ship is currently in flight (any workspace).
    /// Used by `ship_audit` to surface a global "ship in flight" hint
    /// in the modal — preserved for FE compatibility. Per-workspace
    /// status is via `is_held_for(workspace_id)`.
    pub fn is_held(&self) -> bool {
        !self.in_flight.lock().is_empty()
    }

    /// True iff THIS workspace has a ship in flight. Used for
    /// per-workspace UX (toolbar pill, ship-button enablement) where
    /// the global `is_held` is too coarse.
    pub fn is_held_for(&self, workspace_id: &str) -> bool {
        self.in_flight.lock().contains(workspace_id)
    }
}

pub struct ShipLockGuard {
    in_flight: Arc<Mutex<std::collections::HashSet<String>>>,
    workspace_id: String,
}

impl Drop for ShipLockGuard {
    fn drop(&mut self) {
        self.in_flight.lock().remove(&self.workspace_id);
    }
}

// ── 1.174.0 (DR2): Stop the release ────────────────────────────────────

/// The releases a press is making or sending right now, by workspace (one
/// at a time: the press holds the workspace's ship lock), each with the flag
/// *Stop the release* sets. In memory only: a quit ends every press, and
/// what a stop left is in the record (`stop_requested`).
fn presses() -> &'static Mutex<std::collections::HashMap<String, Arc<std::sync::atomic::AtomicBool>>> {
    static PRESSES: std::sync::OnceLock<Mutex<std::collections::HashMap<String, Arc<std::sync::atomic::AtomicBool>>>> =
        std::sync::OnceLock::new();
    PRESSES.get_or_init(Default::default)
}

/// Held while a press makes or sends a release: its stop flag, registered
/// for the workspace. A press inside another (Release… of a release through
/// a pull request) shares the outer one's flag and leaves it registered.
pub(crate) struct PressStop {
    workspace_id: String,
    flag: Arc<std::sync::atomic::AtomicBool>,
    owner: bool,
}

impl PressStop {
    pub(crate) fn begin(workspace_id: &str) -> Self {
        let mut map = presses().lock();
        if let Some(flag) = map.get(workspace_id) {
            return Self { workspace_id: workspace_id.to_string(), flag: flag.clone(), owner: false };
        }
        let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        map.insert(workspace_id.to_string(), flag.clone());
        Self { workspace_id: workspace_id.to_string(), flag, owner: true }
    }

    pub(crate) fn flag(&self) -> Arc<std::sync::atomic::AtomicBool> {
        self.flag.clone()
    }

    pub(crate) fn stopped(&self) -> bool {
        self.flag.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// The Stop can no longer act (the release merged meanwhile): dropped.
    pub(crate) fn clear(&self) {
        self.flag.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

impl Drop for PressStop {
    fn drop(&mut self) {
        if self.owner {
            presses().lock().remove(&self.workspace_id);
        }
    }
}

/// Stop was pressed for the press running in `workspace_id` (false when none
/// runs).
pub(crate) fn stop_requested_now(workspace_id: &str) -> bool {
    presses()
        .lock()
        .get(workspace_id)
        .is_some_and(|f| f.load(std::sync::atomic::Ordering::SeqCst))
}

/// Set the stop flag of the press running in `workspace_id`; false when no
/// press runs there.
pub(crate) fn request_stop(workspace_id: &str) -> bool {
    match presses().lock().get(workspace_id) {
        Some(flag) => {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            true
        }
        None => false,
    }
}

/// What *Stop the release* did (`releaseStop`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseStopOutcome {
    /// The press making or sending it was told to stop; it takes the release
    /// back itself, and its own answer says so (`{ stopped }`, or the
    /// Dismiss of a pull request already open).
    pub stopping: bool,
    /// The release was given up here: its record is gone. What was done on
    /// GitHub, in words (its pull request's auto-merge turned off), empty
    /// when nothing was.
    pub said: Option<String>,
}

/// 1.174.0 (DR2): *Stop the release* of the workspace's release on its way.
///
/// - A press making it now (Building, its checks running, or sending it):
///   its flag is set — the checks are killed with their whole process tree,
///   the release is taken back without a push (`release_pr::build`'s own
///   take-back, or the local half's roll-back), and a release already
///   pushed is given up as Dismiss gives it up.
/// - No press, a pull request pushed, open or merging: Dismiss (`gh pr merge
///   --disable-auto`; the pull request stays open on GitHub).
/// - No press, stopped at Building by a quit: its record and local branch go.
/// - Merged, or tagged: refused — it can't be taken back.
pub(crate) fn release_stop<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    ship_registry: &ShipRegistry,
    project_config: &ProjectConfigStore,
    kanban: &KanbanStore,
    workspace_id: &str,
) -> Result<ReleaseStopOutcome, String> {
    use crate::release_record::PrReleaseStep;
    let ws_dir = project_config.workspace_dir(workspace_id);
    let record = live_record(&ws_dir, kanban, workspace_id)?;
    if let Some(step) = record.as_ref().and_then(|r| r.pr.as_ref()).map(|p| p.step) {
        if step >= PrReleaseStep::Merged {
            let tag = record.as_ref().map(|r| r.tag.clone()).unwrap_or_default();
            return Err(merged_cant_stop_words(&tag));
        }
    }
    if request_stop(workspace_id) {
        return Ok(ReleaseStopOutcome { stopping: true, said: None });
    }
    let Some(record) = record else {
        return Err(NOTHING_TO_STOP.to_string());
    };
    if release_pr::unbuilt(&record) {
        let _guard = ship_registry.try_acquire(workspace_id).ok_or_else(|| SHIP_BUSY.to_string())?;
        if let Some(root) = workspace_repo_root(app, workspace_id) {
            release_pr::discard_unbuilt(&root, &ws_dir, &record)?;
        } else {
            crate::release_record::clear(&ws_dir)?;
        }
        announce_record(app, workspace_id);
        return Ok(ReleaseStopOutcome { stopping: false, said: Some(String::new()) });
    }
    // DR2 round 2: a release through a pull request, pushed, open or
    // merging — given up as a press's Stop gives it up (`settle_stop`, under
    // the ship lock): GitHub is read first, and a failed turn-off of its
    // auto-merge keeps it. Any other record: Dismiss's, as it is.
    if record.pr.is_some() {
        let _guard = ship_registry.try_acquire(workspace_id).ok_or_else(|| SHIP_BUSY.to_string())?;
        let mut record = record;
        record.stop_requested = true;
        return settle_without_press(app, project_config, &ws_dir, kanban, workspace_id, &record);
    }
    let said = dismiss_pending_release(app, ship_registry, project_config, workspace_id)?;
    Ok(ReleaseStopOutcome { stopping: false, said: Some(said) })
}

/// [`release_stop`] with no press: the release's place, then `settle_stop`.
/// The caller holds the ship lock.
fn settle_without_press<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    project_config: &ProjectConfigStore,
    ws_dir: &Path,
    kanban: &KanbanStore,
    workspace_id: &str,
    record: &crate::release_record::PendingRelease,
) -> Result<ReleaseStopOutcome, String> {
    use tauri::Manager;
    let cwd = app
        .try_state::<WorkspaceStore>()
        .and_then(|w| w.snapshot().workspaces.iter().find(|w| w.id == workspace_id).map(|w| w.cwd.clone()))
        .ok_or_else(|| format!("workspace not found: {workspace_id}"))?;
    let repo_root = resolve_workspace_repo_root(&cwd)?;
    let mut config = ship_area_for_tag(project_config, workspace_id, &record.tag)?
        .ok_or_else(|| "This project isn't set up for releases yet.".to_string())?
        .config;
    config.target_branch = record.branch.clone();
    let _github = crate::github_account::enter_for_app(app, workspace_id);
    let place = release_pr::Place {
        app,
        workspace_id,
        ws_cwd: Path::new(&cwd),
        repo_root: &repo_root,
        ws_dir,
        config: &config,
        kanban,
    };
    match release_pr::settle_stop(&place, record).map_err(|e| e.to_string())? {
        release_pr::Settled::GivenUp(said) => Ok(ReleaseStopOutcome { stopping: false, said: Some(said) }),
        release_pr::Settled::Kept(kept) => {
            Err(kept.pr.and_then(|p| p.problem).unwrap_or_else(|| merged_cant_stop_words(&record.tag)))
        }
        release_pr::Settled::GoesOn(_) => Err(merged_cant_stop_words(&record.tag)),
    }
}

/// A Stop with no release on its way (the sheet offers none then).
pub(crate) const NOTHING_TO_STOP: &str = "There is no release on its way to stop. Nothing was changed.";

/// A Stop of a release GitHub already merged (the sheet offers none then).
pub(crate) fn merged_cant_stop_words(tag: &str) -> String {
    format!("{tag} is merged on GitHub already, so it can't be stopped. Plyloft tags it next.")
}

/// The repository of `workspace_id` in the app's workspace store.
fn workspace_repo_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str) -> Option<PathBuf> {
    use tauri::Manager;
    let cwd = app.try_state::<WorkspaceStore>().and_then(|w| {
        w.snapshot().workspaces.iter().find(|w| w.id == workspace_id).map(|w| w.cwd.clone())
    })?;
    resolve_workspace_repo_root(&cwd).ok()
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InFlightSwarm {
    pub swarm_id: String,
    pub workspace_id: String,
    pub goal: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InFlightIntake {
    pub card_id: String,
    pub workspace_id: String,
}

/// Pre-ship audit. Reports backend-known in-flight work; the frontend
/// overlays its own "user attention" items (dirty editor buffers,
/// long-running shell tiles, unsaved card-detail edits) before showing
/// the modal.
///
/// `branch_ok == true` iff the working branch is `main`. Ship aborts if
/// false; the frontend surfaces a "switch to main first" modal.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipAuditReport {
    pub active_swarms: Vec<InFlightSwarm>,
    pub active_intakes: Vec<InFlightIntake>,
    /// Count of in-flight oneshot agent runs across all workspaces.
    /// Phase A only exposes the count; Phase A.5's drain coordinator
    /// will surface per-run details.
    pub active_run_count: usize,
    pub branch: String,
    /// QoL 1.168 S1-4: `branch == target_branch`, the shipped workspace's own
    /// target (its `ProjectConfig`; `main` when it has none).
    pub branch_ok: bool,
    /// QoL 1.168 S1-4: the branch this workspace ships onto (its project
    /// settings). `None`: the workspace isn't set up for shipping yet — the
    /// sheet offers Set up, never a branch to switch to.
    #[serde(default)]
    pub target_branch: Option<String>,
    /// Current version, as the ship will bump it: the workspace's own
    /// version files (`ProjectConfig.version_files`; `package.json` only
    /// for a workspace with no settings yet), else its highest `vX.Y.Z` tag,
    /// else `0.0.0`.
    pub current_version: String,
    /// QoL 1.168 S1-4: where `current_version` was read — a version file's
    /// path, `"tag"`, or `None` for neither (the version starts at 0.0.0).
    #[serde(default)]
    pub version_source: Option<String>,
    /// QoL 1.168 S1-4: shipping this workspace ends with Plyloft's own
    /// install, which quits and relaunches Plyloft (Plyloft's repository).
    #[serde(default)]
    pub relaunches: bool,
    /// Patch-bump suggestion the frontend uses as the default in the
    /// "Ship now" dropdown. The user can override the version explicitly.
    pub suggested_next_version: String,
    /// True when another ship is already in flight (decision 21). The
    /// frontend should disable the Ship action when this is set.
    /// GH #222 review 1: for the workspace asked about (`is_held_for`); only
    /// an audit that names none falls back to "any workspace".
    pub ship_in_flight: bool,
    /// GH #222 review 1: a release of the asked-about workspace that is
    /// committed and tagged but not published (a push stopped at its bound,
    /// or Ply quit mid-push). The dialog offers `Publish vX (already
    /// committed)` for exactly its cards instead of a new version.
    #[serde(default)]
    pub pending_release: Option<crate::release_record::PendingReleaseView>,
    /// GH #222 review 3: why the workspace's record can't be read, if so —
    /// Ship waits until it is dismissed.
    #[serde(default)]
    pub pending_record_unreadable: Option<String>,
    /// GH #222 review 4: another workspace's recorded release on the same
    /// repository and branch, which holds this one back — said up front.
    #[serde(default)]
    pub pending_elsewhere: Option<String>,
    /// G8 (1.170.0): the repository's `origin` is on GitHub, so a release
    /// that pushes goes through a pull request (`release_pr`) — never onto
    /// this computer's target, whatever branch the project folder is on.
    #[serde(default)]
    pub releases_through_pr: bool,
    /// G8 fixes (1.170.0): `current_version` is GitHub's target's, later
    /// than the project folder's (a release through a pull request is built
    /// from it).
    #[serde(default)]
    pub version_on_github: bool,
    /// 1.173.0 (B4): the area this release is of — its name, its tags'
    /// prefix, or why it can't be released. Empty without areas.
    #[serde(default)]
    pub area: AuditArea,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipResult {
    pub commit_sha: String,
    pub shipped_version: String,
    pub release_kind: ReleaseKind,
    /// Stdout/stderr captured from the spawn-and-detach of
    /// `install-local.sh`. The full build log lives at
    /// `/tmp/atelier-install.log` per the script.
    pub install_log: String,
    /// GH #183: the release's fast-forward (`sync_before_release`) left the
    /// target branch at origin's tip. False for a local-only release, which
    /// never ran it, and offline or without an origin.
    #[serde(default)]
    pub fast_forwarded: bool,
    /// QoL 1.168 S1-4: the project's install script that was started, if
    /// any — what the success toast says happens next.
    #[serde(default)]
    pub install_script: Option<String>,
    /// QoL 1.168 S1-4: that script is Plyloft's own install: Plyloft quits
    /// and relaunches once it is built. Only Plyloft's own repository.
    #[serde(default)]
    pub relaunches: bool,
    /// G8 (1.170.0): a release through a pull request — its pull request and
    /// how far it got; `released` once it is merged, tagged and marked.
    /// Absent for a release made on the target branch here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_pr: Option<release_pr::ReleasePrResult>,
    /// 1.173.0 (B4): the release's tag (`site-v1.0.1` for an area's,
    /// `v1.0.1` without areas), what the toast says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
}

/// 1.175.0 B2 (SEC-4): the release `tag` is done and its install step is
/// next. `Some` when this computer hasn't allowed that step: nothing is
/// started, the release is remembered as waiting (`checks_consent`), and
/// the words are the result's log line. The release itself stands.
///
/// Round 2 (G5): `script` is the one the caller is about to start (its own
/// snapshot of the config), so the path that is checked is the path that runs.
pub(crate) fn install_held(store: &ProjectConfigStore, workspace_id: &str, tag: &str, script: Option<&str>) -> Option<String> {
    crate::checks_consent::hold_install_of(store, workspace_id, Some(tag), script).then(|| {
        format!(
            "Released {tag}. Its install step hasn't run: it changed, so it needs your OK on {}.",
            crate::platform::THIS_MACHINE
        )
    })
}

/// QoL 1.168 S1-4: what a ship's install step is, for the result and the
/// audit: the script, and whether it is Plyloft's own (quit + relaunch).
fn install_outcome(repo_root: &Path, config: &ProjectConfig) -> (Option<String>, bool) {
    let script = config.install_script.clone();
    let relaunches = script
        .as_deref()
        .is_some_and(|rel| is_self_install(repo_root, rel));
    (script, relaunches)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipRequest {
    pub workspace_id: String,
    pub card_id: String,
    pub release_kind: ReleaseKind,
    /// Version to ship as (e.g. "1.9.0"). The frontend computes a default
    /// from `suggested_next_version`; the user can override.
    pub version: String,
    /// v1.13.x (Phase E, decision 20): when true, bypass the verify-pass
    /// requirement. The resulting version tag carries an `-unverified`
    /// suffix and the card's `verify_status` is set to `Skipped`. Use
    /// sparingly — visible in the toolbar's red badge so the cost is felt.
    #[serde(default)]
    pub skip_verify: bool,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// v1.34.x: stamp ship-state onto a card that just landed via local
/// merge (the Outcome-screen "Ship it" flow). Pure mutation — the caller
/// (`commands::land_card_local` or `reconcile_ship_backfill`) wraps it in
/// `kanban.with_card` so the write is atomic under the cache mutex.
///
/// Mirrors the kanban update inside legacy `ship::ship_card` (the version-
/// bump pipeline) so a Ship-it card and a Phase-A ship card carry the
/// same on-disk shape: `Shipped` + `commit_sha` + `shipped_version` +
/// one fresh `ShipEntry` + cleared worktree handle. `verify_status` is
/// left untouched (the verify gate, if configured, stamped it earlier).
pub(crate) fn mark_card_shipped_local(
    card: &mut KanbanCard,
    commit_sha: &str,
    shipped_version: &str,
) {
    card.commit_sha = Some(commit_sha.to_string());
    card.shipped_version = Some(shipped_version.to_string());
    card.ship_status = ShipStatus::Shipped;
    card.ship_history.push(ShipEntry {
        commit_sha: commit_sha.to_string(),
        shipped_version: shipped_version.to_string(),
        release_kind: ReleaseKind::Local,
        shipped_at: now_millis(),
        target: crate::kanban::ship_target_of(card),
        tag: None,
    });
    card.worktree_path = None;
    card.branch_name = None;
    card.worktree_base = None;
    card.worktree_setup = None;
}

/// Repo root: the workspace cwd that owns the running Atelier source.
/// Phase A only ships Atelier itself, so we resolve the repo root from
/// the workspace whose cwd contains `package.json` AND `src-tauri/`. If
/// the workspace doesn't look like the Atelier repo, ship aborts with
/// a clear error instead of running `cargo`/`git` against an unrelated
/// project.
fn resolve_atelier_repo_root(cwd: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(cwd);
    if !p.is_dir() {
        return Err(format!("workspace cwd does not exist: {cwd}"));
    }
    if !p.join("package.json").is_file() {
        return Err(format!("workspace cwd has no package.json — not the Atelier repo: {cwd}"));
    }
    if !p.join("src-tauri").is_dir() {
        return Err(format!(
            "workspace cwd has no src-tauri/ — not the Atelier repo: {cwd}"
        ));
    }
    if !p.join("scripts/install-local.sh").is_file() {
        return Err(format!(
            "workspace cwd has no scripts/install-local.sh — not the Atelier repo: {cwd}"
        ));
    }
    Ok(p)
}

/// v1.12.2 (Cycle C): resolve the git toplevel for any workspace cwd.
/// Replaces the Atelier-specific marker check used by `ship_audit`'s
/// global pre-flight; per-card / per-batch ships use this so any
/// workspace whose cwd is inside a git repo can ship (LYRA, etc.).
/// `ship_audit` keeps the marker-based path because today's audit
/// surface is global and Atelier-shape only.
pub(crate) fn resolve_workspace_repo_root(cwd: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(cwd);
    if !p.is_dir() {
        return Err(format!("workspace cwd does not exist: {cwd}"));
    }
    let output = crate::platform::git_command()
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(&p)
        .output()
        .map_err(|e| format!("spawn git rev-parse --show-toplevel: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "workspace cwd is not inside a git repo: {cwd} ({})",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        return Err(format!("git toplevel resolved to empty string: {cwd}"));
    }
    Ok(PathBuf::from(root))
}

/// v1.12.2 (Cycle C): load the per-workspace `ProjectConfig` or
/// error with a clear onboarding instruction. Does not fall back to
/// hardcoded defaults — the v1.12.0 bootstrap writes Atelier's
/// config at launch, and any other workspace must have gone
/// through the setup flow before shipping.
pub(crate) fn load_project_config_for(
    workspace_id: &str,
    workspaces: &WorkspaceStore,
    project_config: &ProjectConfigStore,
) -> Result<ProjectConfig, String> {
    project_config.get(workspace_id).ok_or_else(|| {
        crate::project_config::not_set_up(
            &crate::commands::workspace_name(workspaces, workspace_id),
            crate::project_config::shared_read_only(project_config, workspace_id),
            crate::project_config::setup_unfinished(project_config, workspaces),
            "Nothing was shipped.",
            "ship again",
        )
    })
}

// ── 1.173.0 (B4): releases per area ────────────────────────────────────

/// What one release ships with: the config of one area (its branch and its
/// version files) and the prefix of its tags. Without areas — and for a card
/// exempt from choosing one — the workspace's config as it is and prefix
/// "", so a repository without areas tags `vX.Y.Z` and makes
/// `plyloft/release-vX.Y.Z` exactly as before.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ShipArea {
    pub config: ProjectConfig,
    /// `areas::tag_for(prefix, version)`; "" is `vX.Y.Z`.
    pub prefix: String,
    /// The area's id and name; `None` without areas.
    pub id: Option<String>,
    pub name: Option<String>,
}

impl ShipArea {
    pub fn tag(&self, version: &str) -> String {
        crate::areas::tag_for(&self.prefix, version)
    }
}

/// An area after the first with no version file of its own: its release
/// would write the workspace's (another area's) files.
pub(crate) fn no_version_file_words(area: &str) -> String {
    format!("{area} has no version file of its own. Add one in Settings › Project › Areas.")
}

/// An area that would write a version file another area lists as its own.
pub(crate) fn others_version_file_words(area: &str, file: &str, other: &str) -> String {
    format!(
        "{file} is {other}'s version file, so a release of {area} can't write it. Give {area} a version file of its own in Settings › Project › Areas."
    )
}

/// Cards of more than one area sent in one batch.
pub(crate) fn mixed_areas_words(names: &[String]) -> String {
    format!(
        "These cards are in different areas ({}). Release one area at a time. Nothing was shipped.",
        names.join(", ")
    )
}

/// [`ShipArea`] from a card's resolution (pure): refused on Held, Unknown
/// and a missing area (`card_area::CardArea::refusal`), and for an area
/// whose release would bump another area's version files.
pub(crate) fn ship_area_of(card: crate::card_area::CardArea, areas: &[crate::areas::AreaDef]) -> Result<ShipArea, String> {
    use crate::card_area::CardArea;
    match card {
        // Orchestrator (B4 Challenger round 1): a card exempt from choosing
        // (a skill card) in a repository with areas releases as the first
        // area — its id, so a batch doesn't split, its tags and files.
        CardArea::Workspace(config) if !areas.is_empty() => {
            let first = areas[0].id.trim().to_string();
            match crate::areas::resolve_config(&config, areas, Some(&first)) {
                crate::areas::AreaConfig::Area { area, config } => ship_area_of(CardArea::Area { area, config }, areas),
                _ => Ok(ShipArea { config, prefix: String::new(), id: None, name: None }),
            }
        }
        CardArea::Workspace(config) => Ok(ShipArea { config, prefix: String::new(), id: None, name: None }),
        CardArea::Area { area, config } => {
            let own = area.version_files.as_ref().is_some_and(|files| !files.is_empty());
            if !own && !area.first {
                return Err(no_version_file_words(&area.name));
            }
            // The first area without files of its own writes the workspace's —
            // never one another area lists as its own.
            if !own {
                let resolved = crate::areas::resolve(areas, &config.target_branch);
                for entry in &config.version_files {
                    let path = crate::areas::normalize_path(&entry.path);
                    let owner = resolved.iter().filter(|other| other.id != area.id).find(|other| {
                        other
                            .version_files
                            .iter()
                            .flatten()
                            .any(|f| crate::areas::normalize_path(&f.path) == path)
                    });
                    if let Some(other) = owner {
                        return Err(others_version_file_words(&area.name, &entry.path, &other.name));
                    }
                }
            }
            Ok(ShipArea { config, prefix: area.tag_prefix, id: Some(area.id), name: Some(area.name) })
        }
        refused => Err(refused.refusal().unwrap_or_else(|| crate::card_area::NEEDS_AREA.to_string())),
    }
}

/// The release of `card`: `Ok(None)` without a project config (the
/// callers' "not set up" refusal, as before areas).
pub(crate) fn ship_area_for_card(
    project_config: &ProjectConfigStore,
    workspace_id: &str,
    card: &KanbanCard,
) -> Result<Option<ShipArea>, String> {
    let areas = crate::areas::for_workspace(project_config, workspace_id);
    crate::card_area::resolve(project_config, workspace_id, card)
        .map(|resolved| ship_area_of(resolved, &areas))
        .transpose()
}

/// The release of the area `area_id` (`None`: the workspace's, as in a
/// repository without areas), for Ship batch's audit.
pub(crate) fn ship_area_for_id(
    project_config: &ProjectConfigStore,
    workspace_id: &str,
    area_id: Option<&str>,
) -> Result<Option<ShipArea>, String> {
    use crate::areas::AreaConfig;
    use crate::card_area::CardArea;
    let Some(resolved) = crate::project_config::config_for(project_config, workspace_id, area_id) else {
        return Ok(None);
    };
    let areas = crate::areas::for_workspace(project_config, workspace_id);
    let card = match resolved {
        AreaConfig::Implicit { config } => CardArea::Workspace(config),
        AreaConfig::Area { area, config } => CardArea::Area { area, config },
        AreaConfig::Unknown { id } => CardArea::Unknown { id },
        AreaConfig::Held { problem } => CardArea::Held { problem },
    };
    ship_area_of(card, &areas).map(Some)
}

/// The version `tag` carries for `prefix`: `<prefix>vX.Y.Z` read strictly
/// (`areas::release_version`), or that with exactly the `-unverified` suffix
/// of a skip-verify ship. `vendor-v1.0.0` is no tag of prefix "", and
/// `site-v1.0.0-rc1` is no release of the site's.
pub(crate) fn tag_version<'a>(prefix: &str, tag: &'a str) -> Option<&'a str> {
    let version = tag.strip_prefix(prefix)?.strip_prefix('v')?;
    let core = version.strip_suffix("-unverified").unwrap_or(version);
    crate::areas::release_version("", &format!("v{core}")).map(|_| version)
}

/// The area a release tag belongs to (pure): the area whose prefix reads
/// it, the longest prefix first. `Ok(None)` without areas.
pub(crate) fn area_of_tag(
    areas: &[crate::areas::AreaDef],
    workspace_branch: &str,
    tag: &str,
) -> Result<Option<String>, String> {
    if areas.is_empty() {
        return Ok(None);
    }
    let mut resolved = crate::areas::resolve(areas, workspace_branch);
    resolved.sort_by_key(|a| std::cmp::Reverse(a.tag_prefix.len()));
    resolved
        .into_iter()
        .find(|a| tag_version(&a.tag_prefix, tag).is_some())
        .map(|a| Some(a.id))
        .ok_or_else(|| tag_of_no_area_words(tag))
}

/// A recorded release whose tag no listed area reads any more.
pub(crate) fn tag_of_no_area_words(tag: &str) -> String {
    format!("{tag} belongs to none of this repository's areas any more. Dismiss it, or put its area back in Settings › Project › Areas.")
}

/// The release a recorded (or finished) one was made for, read from its
/// tag: the poller, *Update the release* and the install step go on with its
/// area's branch and files. `Ok(None)` without a project config.
pub(crate) fn ship_area_for_tag(
    project_config: &ProjectConfigStore,
    workspace_id: &str,
    tag: &str,
) -> Result<Option<ShipArea>, String> {
    let Some(config) = project_config.get(workspace_id) else {
        return Ok(None);
    };
    if let Some(problem) = crate::areas::held(project_config, workspace_id) {
        return Err(crate::card_area::held_words(&problem));
    }
    let areas = crate::areas::for_workspace(project_config, workspace_id);
    let id = area_of_tag(&areas, &config.target_branch, tag)?;
    ship_area_for_id(project_config, workspace_id, id.as_deref())
}

/// 1.173.0 (B4 follow-up): one published area's releases as Settings ›
/// Areas says them — its latest real tag (`<prefix>vX.Y.Z`, read strictly)
/// and the version its own version files are at, each `None` when unknown.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AreaRelease {
    pub id: String,
    pub tag_prefix: String,
    pub latest_tag: Option<String>,
    pub version: Option<String>,
}

/// Every area this Mac runs with (none while held), read from the
/// workspace's repository: one `git tag --list` per area and its version
/// files. 1.173.0 (G1, the D2 leftover): without areas, one entry for the
/// implicit area ([`crate::areas::IMPLICIT_AREA_ID`], prefix ""), so How this
/// goes live reads the latest strict `vX.Y.Z` tag of a project whose
/// releases are older than the records that name their kind.
pub(crate) fn area_releases(
    workspaces: &WorkspaceStore,
    project_config: &ProjectConfigStore,
    workspace_id: &str,
) -> Result<Vec<AreaRelease>, String> {
    let Some(config) = project_config.get(workspace_id) else {
        return Ok(Vec::new());
    };
    if crate::areas::held(project_config, workspace_id).is_some() {
        return Ok(Vec::new());
    }
    let areas = crate::areas::for_workspace(project_config, workspace_id);
    let snap = workspaces.snapshot();
    let ws = snap
        .workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| format!("workspace not found: {workspace_id}"))?;
    let repo_root = resolve_workspace_repo_root(&ws.cwd)?;
    if areas.is_empty() {
        return Ok(vec![implicit_area_release(&repo_root, &config)]);
    }
    Ok(crate::areas::resolve(&areas, &config.target_branch)
        .into_iter()
        .map(|area| {
            let latest_tag =
                latest_release_version(&repo_root, &area.tag_prefix).map(|v| crate::areas::tag_for(&area.tag_prefix, &v));
            // Its own files (the first area may use the workspace's); none
            // when its release would be refused.
            let version = ship_area_for_id(project_config, workspace_id, Some(&area.id))
                .ok()
                .flatten()
                .and_then(|shipping| read_project_version(&repo_root, &shipping.config));
            AreaRelease { id: area.id, tag_prefix: area.tag_prefix, latest_tag, version }
        })
        .collect())
}

/// The implicit area's releases: the latest strict `vX.Y.Z` tag (never an
/// `-unverified` one) and the version the workspace's files are at.
pub(crate) fn implicit_area_release(repo_root: &Path, config: &crate::project_config::ProjectConfig) -> AreaRelease {
    AreaRelease {
        id: crate::areas::IMPLICIT_AREA_ID.to_string(),
        tag_prefix: String::new(),
        latest_tag: latest_release_version(repo_root, "").map(|v| crate::areas::tag_for("", &v)),
        version: read_project_version(repo_root, config),
    }
}

/// [`load_project_config_for`] for one card's release: its area's config
/// and tag prefix, refused as [`ship_area_of`] refuses.
fn load_ship_area_for_card(
    workspace_id: &str,
    card: &KanbanCard,
    workspaces: &WorkspaceStore,
    project_config: &ProjectConfigStore,
) -> Result<ShipArea, String> {
    load_project_config_for(workspace_id, workspaces, project_config)?;
    ship_area_for_card(project_config, workspace_id, card)?.ok_or_else(|| {
        // Raced away between the two reads: said as not set up.
        load_project_config_for(workspace_id, workspaces, project_config).err().unwrap_or_default()
    })
}

/// The one area a batch releases (1.173.0, B4): every card's release
/// (`area_of`) must be the same area — its branch, files and tags — else the
/// batch is refused, naming the areas; the first refusal of a card is said
/// as it is.
pub(crate) fn batch_ship_area(
    cards: &[&KanbanCard],
    mut area_of: impl FnMut(&KanbanCard) -> Result<ShipArea, String>,
) -> Result<ShipArea, String> {
    let mut seen: Vec<ShipArea> = Vec::new();
    for card in cards {
        let area = area_of(card)?;
        if !seen.iter().any(|s| s.id == area.id) {
            seen.push(area);
        }
    }
    if seen.len() > 1 {
        let names: Vec<String> = seen
            .iter()
            .map(|a| a.name.clone().unwrap_or_else(|| crate::card_area::WHOLE_REPOSITORY.to_string()))
            .collect();
        return Err(mixed_areas_words(&names));
    }
    seen.pop().ok_or_else(|| "ship_batch requires at least one card_id".to_string())
}

/// [`load_project_config_for`] for a recorded release, by its tag.
fn load_ship_area_for_tag(
    workspace_id: &str,
    tag: &str,
    workspaces: &WorkspaceStore,
    project_config: &ProjectConfigStore,
) -> Result<ShipArea, String> {
    load_project_config_for(workspace_id, workspaces, project_config)?;
    ship_area_for_tag(project_config, workspace_id, tag)?.ok_or_else(|| {
        load_project_config_for(workspace_id, workspaces, project_config).err().unwrap_or_default()
    })
}

fn read_package_version(repo_root: &Path) -> Result<String, String> {
    let bytes = std::fs::read(repo_root.join("package.json"))
        .map_err(|e| format!("read package.json: {e}"))?;
    let v: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse package.json: {e}"))?;
    let version = v
        .get("version")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "package.json missing `version` string".to_string())?;
    Ok(version.to_string())
}

/// v1.34.x: read the project's current version by walking
/// `config.version_files` in declared order and returning the first one
/// that parses successfully. Used by `commands::land_card_local` and the
/// startup `reconcile_ship_backfill` pass to stamp `shipped_version` on
/// cards that landed via the v1.31.0 Outcome-screen "Ship it" path
/// (which reads the version, it doesn't bump it).
pub(crate) fn read_project_version(
    repo_root: &Path,
    config: &ProjectConfig,
) -> Option<String> {
    for entry in &config.version_files {
        let read = std::fs::read_to_string(repo_root.join(&entry.path))
            .ok()
            .and_then(|body| version_in_text(entry, &body));
        if let Some(v) = read {
            return Some(v);
        }
    }
    None
}

/// The version one version file's text holds, by its kind.
fn version_in_text(entry: &crate::project_config::VersionFileEntry, body: &str) -> Option<String> {
    match entry.kind {
        VersionFileKind::PackageJson | VersionFileKind::TauriConfJson => read_json_version_in(body),
        VersionFileKind::CargoToml => read_toml_section_version_in(body, "[package]"),
        VersionFileKind::PyProjectToml => read_toml_section_version_in(body, "[project]"),
        VersionFileKind::PythonModuleVar => entry
            .variable_name
            .as_deref()
            .and_then(|name| read_python_module_var_in(body, name)),
    }
}

/// G8 fixes (1.170.0, Challenger major 2): the version the project is at in
/// commit `rev` (`git show <rev>:<file>`, the version files in their order)
/// — for a release through a pull request, GitHub's target
/// (`origin/<target>`), not this computer's folder. With the file it was
/// read from.
pub(crate) fn project_version_at(repo_root: &Path, config: &ProjectConfig, rev: &str) -> Option<(String, String)> {
    config.version_files.iter().find_map(|entry| {
        let path = entry.path.replace('\\', "/");
        let body = git_capture(repo_root, &["show", &format!("{rev}:{path}")]).ok()?;
        version_in_text(entry, &body).map(|v| (v, entry.path.clone()))
    })
}

/// `a` is a later `MAJOR.MINOR.PATCH` than `b` (any `-suffix` aside);
/// `None` when either doesn't parse.
pub(crate) fn version_is_after(a: &str, b: &str) -> Option<bool> {
    fn parts(v: &str) -> Option<(u64, u64, u64)> {
        let core = v.split('-').next().unwrap_or(v);
        let mut it = core.split('.').map(|p| p.parse::<u64>().ok());
        let parsed = (it.next()??, it.next()??, it.next()??);
        it.next().is_none().then_some(parsed)
    }
    Some(parts(a)? > parts(b)?)
}

fn read_json_version_in(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    v.get("version")?.as_str().map(String::from)
}

/// `version = "…"` in a TOML `section` (`[package]`, `[project]`).
fn read_toml_section_version_in(body: &str, section: &str) -> Option<String> {
    let mut inside = false;
    for line in body.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('[') {
            inside = trimmed == section;
            continue;
        }
        if inside && trimmed.starts_with("version = \"") {
            let after = &trimmed["version = \"".len()..];
            if let Some(end) = after.find('"') {
                return Some(after[..end].to_string());
            }
        }
    }
    None
}

fn read_python_module_var_in(body: &str, variable_name: &str) -> Option<String> {
    let (start, end) = crate::project_config::find_var_in_text(body, variable_name)?;
    Some(body[start..end].to_string())
}

/// Increment the patch component of a `MAJOR.MINOR.PATCH` version
/// string. Returns `None` if the version doesn't parse as semver. Used
/// only to populate `suggested_next_version` in the audit report — the
/// caller passes the actual ship version explicitly.
fn bump_patch(version: &str) -> Option<String> {
    // Strip any pre-release suffix like "-unverified" before bumping.
    let core = version.split('-').next().unwrap_or(version);
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let major: u32 = parts[0].parse().ok()?;
    let minor: u32 = parts[1].parse().ok()?;
    let patch: u32 = parts[2].parse().ok()?;
    Some(format!("{}.{}.{}", major, minor, patch + 1))
}

fn current_branch(repo_root: &Path) -> Result<String, String> {
    let output = crate::platform::git_command()
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(repo_root)
        .output()
        .map_err(|e| format!("spawn git rev-parse: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "git rev-parse failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// QoL 1.168 S1-4: what the audit reads about the repository it ships.
struct AuditPlace {
    repo_root: PathBuf,
    target_branch: Option<String>,
    version: String,
    version_source: Option<String>,
    /// G8 fixes: `version` is GitHub's target's, later than this folder's.
    version_on_github: bool,
    relaunches: bool,
    area: AuditArea,
}

/// The shipped workspace: its git toplevel, its `ProjectConfig` target
/// branch (`None` when it has no settings yet — Ship asks to set it up),
/// and its version ([`audit_version`]).
///
/// 1.173.0 (B4): of one area — the card's (`AuditFor::card_id`) or the one
/// Ship batch releases (`AuditFor::area`): its branch, its version files and
/// its tags. A release the area refuses is said in `area.refusal`, the rest
/// read as the workspace's.
fn audit_place(
    workspaces: &WorkspaceStore,
    project_config: &ProjectConfigStore,
    kanban: &KanbanStore,
    workspace_id: &str,
    asked: AuditFor<'_>,
) -> Result<AuditPlace, String> {
    let snap = workspaces.snapshot();
    let ws = snap
        .workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| format!("workspace not found: {workspace_id}"))?;
    let repo_root = resolve_workspace_repo_root(&ws.cwd)?;
    let shipping = match asked.card_id {
        Some(card_id) => match kanban.get_card(workspace_id, card_id) {
            Ok(card) => ship_area_for_card(project_config, workspace_id, &card),
            Err(_) => Ok(None),
        },
        None => ship_area_for_id(project_config, workspace_id, asked.area),
    };
    let (area, config) = match shipping {
        Ok(Some(area)) => (
            AuditArea { name: area.name.clone(), tag_prefix: area.prefix.clone(), refusal: None },
            Some(area.config),
        ),
        Ok(None) => (AuditArea::default(), project_config.get(workspace_id)),
        Err(refusal) => (AuditArea { refusal: Some(refusal), ..AuditArea::default() }, project_config.get(workspace_id)),
    };
    let target_branch = config.as_ref().map(|c| c.target_branch.clone());
    let (mut version, mut version_source) = audit_version(&repo_root, config.as_ref(), &area.tag_prefix);
    // G8 fixes (Challenger major 2): on GitHub a release that pushes is
    // built from GitHub's target, so its version counts too — the later of
    // the two is what the next one follows (no fetch here: what this
    // computer last saw of it).
    let mut version_on_github = false;
    if let Some(config) = config.as_ref().filter(|_| github_origin(&repo_root).is_some()) {
        let rev = format!("refs/remotes/origin/{}", config.target_branch);
        if let Some((on_github, path)) = project_version_at(&repo_root, config, &rev) {
            if version_is_after(&on_github, &version).unwrap_or(version_source.is_none()) {
                version = on_github;
                version_source = Some(path);
                version_on_github = true;
            }
        }
    }
    let relaunches = config
        .as_ref()
        .is_some_and(|c| install_outcome(&repo_root, c).1);
    Ok(AuditPlace { repo_root, target_branch, version, version_source, version_on_github, relaunches, area })
}

/// 1.173.0 (B4): which area an audit is about. Neither: the workspace's,
/// as before areas.
#[derive(Debug, Clone, Copy, Default)]
pub struct AuditFor<'a> {
    /// The card Ship now / Release… releases: its area.
    pub card_id: Option<&'a str>,
    /// The area Ship batch releases (`None`: the workspace's).
    pub area: Option<&'a str>,
}

/// 1.173.0 (B4): the area an audit read, for the sheets' words.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuditArea {
    /// `None` without areas.
    #[serde(default)]
    pub name: Option<String>,
    /// The release tags' prefix: "" is `vX.Y.Z`.
    #[serde(default)]
    pub tag_prefix: String,
    /// Why this area can't be released (Held, Unknown, no area chosen, no
    /// version file of its own), in words; Ship stays off.
    #[serde(default)]
    pub refusal: Option<String>,
}

/// An audit that names no workspace (older callers): the first workspace
/// shaped like Plyloft's repository, as before S1-4.
fn legacy_audit_place(workspaces: &WorkspaceStore) -> Result<AuditPlace, String> {
    let snap = workspaces.snapshot();
    let repo_root = snap
        .workspaces
        .iter()
        .find_map(|ws| resolve_atelier_repo_root(&ws.cwd).ok())
        .ok_or_else(|| {
            "no workspace points at the Atelier repo (need package.json + src-tauri/ + scripts/install-local.sh)".to_string()
        })?;
    let version = read_package_version(&repo_root)?;
    Ok(AuditPlace {
        repo_root,
        target_branch: Some("main".to_string()),
        version,
        version_source: Some("package.json".to_string()),
        version_on_github: false,
        relaunches: true,
        area: AuditArea::default(),
    })
}

/// The version a workspace is at, as its ship will bump it: with settings,
/// its version files in `ProjectConfig` order (what `write_versions_per_config`
/// writes); with none yet, `package.json`; then its highest `vX.Y.Z` tag;
/// with none, `0.0.0` — the first ship suggests 0.0.1.
///
/// 1.173.0 (B4): `prefix` is the area's tag prefix ("" without areas): only
/// its own `<prefix>vX.Y.Z` tags count.
fn audit_version(repo_root: &Path, config: Option<&ProjectConfig>, prefix: &str) -> (String, Option<String>) {
    match config {
        Some(config) => {
            for entry in &config.version_files {
                let one = ProjectConfig { version_files: vec![entry.clone()], ..config.clone() };
                if let Some(v) = read_project_version(repo_root, &one) {
                    return (v, Some(entry.path.clone()));
                }
            }
        }
        None => {
            if let Ok(v) = read_package_version(repo_root) {
                return (v, Some("package.json".to_string()));
            }
        }
    }
    if let Some(v) = latest_version_tag(repo_root, prefix) {
        return (v, Some("tag".to_string()));
    }
    ("0.0.0".to_string(), None)
}

/// Walk fix (DR3 early walk): the first release of an area (no real tag
/// with its prefix yet) at the version its file says at `rev` — tagged as it
/// is now, with a version commit that changes no file.
pub(crate) fn first_release_as_is(
    repo_root: &Path,
    prefix: &str,
    config: &ProjectConfig,
    rev: &str,
    version: &str,
) -> bool {
    latest_release_version(repo_root, prefix).is_none()
        && project_version_at(repo_root, config, rev).is_some_and(|(at, _)| at == version.trim().trim_start_matches('v'))
}

/// 1.173.0 (G1): the latest real release's version under `prefix` — a
/// strict `vX.Y.Z`, never an `-unverified` build (which may sort above it).
pub(crate) fn latest_release_version(repo_root: &Path, prefix: &str) -> Option<String> {
    let pattern = format!("{prefix}v*");
    let output = crate::platform::git_command()
        .args(["tag", "--list", &pattern, "--sort=-v:refname"])
        .current_dir(repo_root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|t| tag_version(prefix, t.trim()))
        .find(|v| !v.ends_with("-unverified"))
        .map(str::to_string)
}

/// The highest `vX.Y.Z` tag of the repository by version (not by date,
/// not only those reachable from HEAD), without its `v`. 1.173.0 (B4): of
/// one area's tags, `<prefix>vX.Y.Z` ([`tag_version`]); "" lists `v*` as
/// before.
fn latest_version_tag(repo_root: &Path, prefix: &str) -> Option<String> {
    let pattern = format!("{prefix}v*");
    let output = crate::platform::git_command()
        .args(["tag", "--list", &pattern, "--sort=-v:refname"])
        .current_dir(repo_root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|t| tag_version(prefix, t.trim()))
        .map(str::to_string)
}

/// Phase A audit: enumerate backend-known in-flight work + branch state
/// + version. Frontend overlays its own dirty-buffer / long-running-tile
/// info before showing the modal. Tests: the workspace's audit (the IPC
/// command calls [`ship_audit_for`]).
#[cfg(test)]
pub fn ship_audit(
    workspaces: &WorkspaceStore,
    swarms: &SwarmRegistry,
    intakes: &IntakeRegistry,
    agents: &AgentRegistry,
    ship_registry: &ShipRegistry,
    kanban: &KanbanStore,
    project_config: &ProjectConfigStore,
    workspace_id: Option<&str>,
) -> Result<ShipAuditReport, String> {
    ship_audit_for(
        workspaces,
        swarms,
        intakes,
        agents,
        ship_registry,
        kanban,
        project_config,
        workspace_id,
        AuditFor::default(),
    )
}

/// [`ship_audit`] of one area (1.173.0, B4): the card's, or the one Ship
/// batch releases.
#[allow(clippy::too_many_arguments)]
pub fn ship_audit_for(
    workspaces: &WorkspaceStore,
    swarms: &SwarmRegistry,
    intakes: &IntakeRegistry,
    agents: &AgentRegistry,
    ship_registry: &ShipRegistry,
    kanban: &KanbanStore,
    project_config: &ProjectConfigStore,
    workspace_id: Option<&str>,
    asked: AuditFor<'_>,
) -> Result<ShipAuditReport, String> {
    let pending = workspace_id
        .map(|id| workspace_pending_release(workspaces, project_config, kanban, id))
        .unwrap_or_default();
    // QoL 1.168 S1-4: the shipped workspace's own repository, target branch
    // and version — any project, not only one shaped like Plyloft's.
    let place = match workspace_id {
        Some(id) => audit_place(workspaces, project_config, kanban, id, asked)?,
        None => legacy_audit_place(workspaces)?,
    };
    let active_swarms: Vec<InFlightSwarm> = swarms
        .list()
        .into_iter()
        .filter(|s| matches!(s.status, SwarmStatus::Running | SwarmStatus::Suspended))
        .map(|s| InFlightSwarm {
            swarm_id: s.id,
            workspace_id: s.workspace_id,
            goal: s.goal,
        })
        .collect();

    let active_intakes: Vec<InFlightIntake> = intakes
        .list_active()
        .into_iter()
        .map(|s| InFlightIntake {
            card_id: s.card_id,
            workspace_id: s.workspace_id,
        })
        .collect();

    let active_run_count = agents.count_active_runs();

    let branch = current_branch(&place.repo_root).unwrap_or_else(|_| "(unknown)".to_string());
    let branch_ok = place.target_branch.as_deref() == Some(branch.as_str());
    let current_version = place.version.clone();
    let suggested_next_version =
        bump_patch(&current_version).unwrap_or_else(|| current_version.clone());

    Ok(ShipAuditReport {
        active_swarms,
        active_intakes,
        active_run_count,
        branch,
        branch_ok,
        target_branch: place.target_branch,
        current_version,
        version_source: place.version_source,
        version_on_github: place.version_on_github,
        relaunches: place.relaunches,
        suggested_next_version,
        // GH #222 review 1 (m4): this workspace's ship, not any workspace's.
        ship_in_flight: match workspace_id {
            Some(id) => ship_registry.is_held_for(id),
            None => ship_registry.is_held(),
        },
        pending_elsewhere: workspace_id
            .filter(|_| pending.release.is_none() && pending.unreadable.is_none())
            .and_then(|id| pending_elsewhere(workspaces, project_config, kanban, id)),
        pending_release: pending.release,
        pending_record_unreadable: pending.unreadable,
        releases_through_pr: github_origin(&place.repo_root).is_some(),
        area: place.area,
    })
}

/// Phase A ship: per-card commit + tag + detached install.
///
/// Ordering is important — kanban must be updated BEFORE invoking
/// `install-local.sh` so the persisted ship state survives the
/// quit-replace-relaunch.
pub fn ship_card<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    req: ShipRequest,
    workspaces: &WorkspaceStore,
    kanban: &KanbanStore,
    ship_registry: &ShipRegistry,
    project_config: &ProjectConfigStore,
    _swarms: &SwarmRegistry,
    _intakes: &IntakeRegistry,
    _agents: &AgentRegistry,
    _pty: &PtyRegistry,
    // GH #104: the Challenger's records, the discussions and the coordination
    // snapshot were read here only to seal the retired post-ship lesson's
    // evidence envelope. Kept in the signature as unused: Ship's callers are
    // many and its argument list is already long, and a later card that needs
    // them back should not have to thread them again.
    _reviewers: &ReviewerRegistry,
    _discussions: &DiscussionRegistry,
    _coordination: &CoordinationRegistry,
) -> Result<ShipResult, ShipError> {
    let _guard = ship_registry
        .try_acquire(&req.workspace_id)
        .ok_or_else(|| SHIP_BUSY.to_string())?;

    // v1.12.2 (Cycle C): per-workspace project_config drives
    // target_branch / version_files / install_script. Atelier's
    // bootstrap config (v1.12.0) reproduces the legacy hardcoded
    // values 1:1 so this refactor is zero behavior change for the
    // Atelier workspace.
    // 1.173.0 (B4): the card's area — its branch, its version files and its
    // tags (`<prefix>vX.Y.Z`); a repository without areas reads the
    // workspace's config and tags `vX.Y.Z`, as before.
    let shipping = {
        load_project_config_for(&req.workspace_id, workspaces, project_config)?;
        let card = kanban
            .get_card(&req.workspace_id, &req.card_id)
            .map_err(|_| format!("card not found: {}", req.card_id))?;
        load_ship_area_for_card(&req.workspace_id, &card, workspaces, project_config)?
    };
    let config = shipping.config.clone();

    // Resolve repo root from the workspace.
    let snap = workspaces.snapshot();
    let ws = snap
        .workspaces
        .iter()
        .find(|w| w.id == req.workspace_id)
        .ok_or_else(|| format!("workspace not found: {}", req.workspace_id))?;
    let repo_root = resolve_workspace_repo_root(&ws.cwd)?;
    refuse_self_install(&repo_root, config.install_script.as_deref())?;
    // G8 (1.170.0): on GitHub, a release that pushes goes through a pull
    // request (`release_pr`), built from GitHub's target in a copy of its
    // own: the project folder's branch and changes don't matter to it.
    let pr_route = release_pr::route(&repo_root, req.release_kind).is_some();
    // GH #80: the merge, commit and push onto the target branch are
    // serialized with shared-config publishes onto that branch.
    let integration =
        crate::shared_config::integration_lock(Path::new(&ws.cwd), &config.target_branch);
    let integration_held = integration.lock().unwrap_or_else(|p| p.into_inner());
    // GH #222 review 1 (m5), review 2: card starts, worktree deletes and Trash
    // wait until the release is committed and tagged, so a card's worktree
    // can't vanish between the checks below and its merge. The lock order is
    // integration → CARD_START_LOCK → fast-forward: no holder of
    // CARD_START_LOCK (a card start, delete, Trash, resume) ever waits on an
    // integration lock. Dropped with the fast-forward lock after the tag.
    let start = crate::commands::CARD_START_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    // GH #203 review 1: Ply's own fast-forwards (a reconcile, a Trash) wait
    // for this release's merge and commit; held to the end of the ship.
    let fast_forward = crate::worktrees::hold_fast_forward(Path::new(&ws.cwd));

    // Branch check (decision: pre-ship branch check). G8: not for a release
    // through a pull request, which never touches the project folder.
    if !pr_route {
        let branch = current_branch(&repo_root)?;
        if branch != config.target_branch {
            return Err(format!(
                "ship aborted: current branch is `{branch}`. Ship lands on `{}`. Switch first or cancel.",
                config.target_branch
            ).into());
        }
    }
    // Find the card. (v1.33.0: read-only — the ship-state write below goes
    // through one atomic board write.)
    let cards = kanban.load(&req.workspace_id)?;
    let card_idx = cards
        .iter()
        .position(|c| c.id == req.card_id)
        .ok_or_else(|| format!("card not found: {}", req.card_id))?;
    let card_title = cards[card_idx].title.clone();

    // GH #222 review 2: this workspace has a release committed and tagged
    // here but never published (its record says so). Checked before the
    // fast-forward below, whose advice ("Pull") would be wrong for it: a Ship
    // of exactly its cards publishes it — no new version, nothing re-merged —
    // and any other Ship is refused until it is published or dismissed.
    let ws_dir = project_config.workspace_dir(&req.workspace_id);
    // Review 3: any workspace's record on this repository and branch counts.
    if let Some(record) = blocking_record(
        workspaces,
        project_config,
        kanban,
        &req.workspace_id,
        Path::new(&ws.cwd),
        &config.target_branch,
    )? {
        let view = crate::release_record::view(&repo_root, record);
        resume_or_refuse(&view, std::slice::from_ref(&req.card_id), &cards)?;
        // G8: a release through a pull request left before it was built
        // (a quit mid-build) is made again below, from the start.
        if release_pr::unbuilt(&view.record) {
            release_pr::discard_unbuilt(&repo_root, &ws_dir, &view.record)?;
        } else {
            drop(fast_forward);
            drop(start);
            // G8: one through a pull request goes on from its last step — with
            // no lock of the target here (its end brings this computer's target
            // up to date, under the integration lock).
            if view.record.pr.is_some() {
                drop(integration_held);
                return resume_through_pr(
                    app,
                    &ws_dir,
                    Path::new(&ws.cwd),
                    &repo_root,
                    &config,
                    kanban,
                    &req.workspace_id,
                    view.record,
                );
            }
            return publish_pending(
                app,
                &ws_dir,
                &repo_root,
                &config,
                kanban,
                &req.workspace_id,
                view.record,
                req.release_kind,
            );
        }
    }

    // R6: a project folder with tracked changes is refused before anything
    // is merged, as Land refuses it (`land_card_local`): a stopped release
    // is put back with `git reset --hard`. A legacy card's work *is* those
    // changes (`works_in_the_checkout`).
    let legacy = works_in_the_checkout(&cards[card_idx]);
    if !pr_route {
        require_clean_unless_legacy(&repo_root, legacy)?;
    }

    // GH #80: a shared-config publish moves origin's branch without touching
    // this one; a release that pushes lands on origin's tip, or is refused
    // here before anything is merged, committed or tagged.
    // OB-7b: the release's fetch and pushes run as the workspace's GitHub
    // account (`finish_release` reuses this scope).
    let _github = crate::github_account::enter_for_app(app, &req.workspace_id);
    // R9's refusal of a protected target before anything changed is gone
    // (G8): only GitHub could say it, and a GitHub project releases through
    // a pull request. Another server's refusal is read from the push.
    let fast_forwarded =
        if !pr_route && matches!(req.release_kind, ReleaseKind::Github | ReleaseKind::PushOnly) {
            crate::shared_config::sync_before_release(
                &fast_forward,
                Path::new(&ws.cwd),
                &config.target_branch,
            )?
        } else {
            false
        };
    // G5 (Challenger 2): this computer has GitHub's target now.
    crate::after_merge::up_to_date_now(app, &req.workspace_id, fast_forwarded);

    // v1.10.x (Phase B) + v1.13.x (Phase E): block ship until verify
    // passes — unless the card is `Legacy` (pre-v1.9 migration) or
    // `Skipped` (this same skip_verify flag was used previously) or the
    // current request opts into `skip_verify` (decision 20). Queued /
    // Running always block (a verify is mid-flight).
    if !req.skip_verify {
        match cards[card_idx].verify_status {
            VerifyStatus::Passed | VerifyStatus::Legacy | VerifyStatus::Skipped => {}
            VerifyStatus::None => {
                return Err(
                    "ship blocked: card has not been verified yet. Wait for verify to complete or use Skip verify."
                        .to_string().into()
                );
            }
            VerifyStatus::Queued | VerifyStatus::Running => {
                return Err("ship blocked: verify is currently running for this card".to_string().into());
            }
            VerifyStatus::Failed => {
                return Err(
                    "ship blocked: most recent verify failed. Re-run verify, fix the failure, or use Skip verify."
                        .to_string().into()
                );
            }
        }
    } else if matches!(cards[card_idx].verify_status, VerifyStatus::Queued | VerifyStatus::Running)
    {
        // Even with skip_verify, refuse if a verify is actively running —
        // the card's working tree is in flux.
        return Err(
            "ship blocked: a verify is in progress; wait for it to finish before skip-verify ship".to_string().into()
        );
    }

    // v1.13.x (Phase E): skip_verify ⇒ tag with `-unverified` suffix.
    // The caller controls the version string, but we enforce the suffix
    // so the visible cost (red toolbar badge) is unmistakable.
    let effective_version = if req.skip_verify {
        if req.version.contains("-unverified") {
            req.version.clone()
        } else {
            format!("{}-unverified", req.version)
        }
    } else {
        req.version.clone()
    };

    // Validate version: MAJOR.MINOR.PATCH with optional `-unverified` suffix.
    if !is_valid_version(&effective_version) {
        return Err(format!(
            "invalid version `{}` (expected MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-unverified)",
            effective_version
        ).into());
    }

    // Refuse to overwrite an existing tag.
    let release_tag = shipping.tag(&effective_version);
    if tag_exists(&repo_root, &release_tag)? {
        return Err(format!("tag {release_tag} already exists; pick a different version").into());
    }

    // GH #196: the release commit stages tracked changes only. Refused here,
    // before anything is merged or written, when that would leave out a
    // declared version file or a legacy card's new files.
    if pr_route {
        // G8: a card without a copy of its own has nothing to put on a branch.
        if legacy {
            return Err(release_pr::no_copy_words(&card_title).into());
        }
        // G8 fixes (Challenger major 3): nor does a card whose work is in a
        // pull request of its own still open on GitHub — it would go to the
        // target twice. Said as Ship batch says it.
        if let Some(why) = open_pr_refusal("ship", &cards[card_idx]) {
            return Err(why.into());
        }
    } else {
        require_version_files_tracked(&repo_root, &config)?;
        require_legacy_cards_have_no_untracked(&repo_root, &[&cards[card_idx]])?;
    }

    // v1.10.3 (Cycle A — worktrees): if the card was worked on in a
    // per-card git worktree, flush any uncommitted edits onto the
    // card's branch and squash-merge that branch into main. The
    // squash-merge stages its result, and the release commit below
    // captures it along with the version bump in one commit. Cards from
    // before v1.10.x have `worktree_path: None` and skip this entirely
    // (legacy main-checkout flow).
    // Challenger on a pull request: its fixes go to that pull request.
    if let Some(why) = crate::pr_review::ship_refusal(&cards[card_idx]) {
        return Err(why.into());
    }
    crate::builder::require_builder_worktree(&cards[card_idx])?;
    let card_wt = cards[card_idx].worktree_path.clone();
    let card_branch = cards[card_idx].branch_name.clone();
    // GH #222 review 1 (m5): a card whose worktree is gone is refused, never
    // released as a version bump without its change.
    if let Some(wt) = &card_wt {
        if !Path::new(wt).exists() {
            return Err(worktree_gone_message(&card_title, wt).into());
        }
    }
    // Phase F: never push an `-unverified` tag to a public release — those
    // are local-only by policy. Github releases must trace to a verified or
    // legacy build. PushOnly is excluded from this guard by design
    // (Railway-style deploys aren't strictly public; caller accepts the
    // trade-off). GH #222 review 2: refused here, before anything is
    // merged, committed or tagged.
    if req.skip_verify && matches!(req.release_kind, ReleaseKind::Github) {
        return Err(
            "github release blocked: skip-verify ships are local-only. Switch to a Local rebuild. \
             Nothing was merged, committed or tagged."
                .to_string()
                .into(),
        );
    }
    // G8: through a pull request — built, checked, pushed, opened and
    // merged when its checks pass (`release_pr`). The integration and
    // fast-forward locks aren't needed (the target here isn't touched);
    // CARD_START_LOCK is let go once the cards' copies are read.
    if pr_route {
        drop(fast_forward);
        drop(integration_held);
        return ship_through_pr(
            app,
            project_config,
            &ws_dir,
            Path::new(&ws.cwd),
            &repo_root,
            &config,
            kanban,
            &req.workspace_id,
            vec![&cards[card_idx]],
            effective_version,
            req.release_kind,
            req.skip_verify,
            &shipping.prefix,
            ReleaseFacts::default(),
            start,
        );
    }

    // R6: still clean after the fetch (the folder is the member's); then
    // the folder as it is now, which any stop before the tag puts back.
    require_clean_unless_legacy(&repo_root, legacy)?;
    let folder = FolderStart::take(&repo_root, &config, legacy)?;
    // GH #222 review 1 (m3): from here to the tag, a quit waits for this
    // release (bounded); once Ply is quitting none begins.
    let local = LOCAL_PHASES.begin()?;
    // GH #222 review 3: recorded before anything is merged or committed, so a
    // release this Ship makes can never lack its record (a write that fails
    // here refuses the Ship with nothing changed). Taken back if the local
    // half stops before its tag.
    let pre = PreRecord::arm(
        &ws_dir,
        pushes(req.release_kind),
        crate::release_record::PendingRelease {
            version: effective_version.clone(),
            tag: release_tag.clone(),
            commit_sha: String::new(),
            branch: config.target_branch.clone(),
            card_ids: vec![req.card_id.clone()],
            card_revs: Default::default(),
            release_kind: req.release_kind,
            skip_verify: req.skip_verify,
            stopped_at: None,
            cause: None,
            output: None,
            bound: None,
            created_at: now_millis(),
            stage: crate::release_record::RecordStage::Committing,
            // R7 (Challenger MAJOR 2): where the folder was, for the way back.
            start_commit: Some(folder.head.clone()),
            protected: false,
            tag_pushed: false,
            pr: None,
            merged_card_ids: Vec::new(),
            since_tag: None,
            other_changes: 0,
            stop_requested: false,
        },
    )?;
    // R6: from the first squash to the tag, a stop puts the project folder
    // back as `folder` found it (`roll_back_release`).
    // Challenger m11: whether the folder was changed yet (a squash or the
    // version write began); m4: a panic is a stop too.
    let touched = std::cell::Cell::new(false);
    let made = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<_, ReleaseStop> {
        // GH #222 review 2: the commit each worktree is merged from, so it is put
        // away after the release only while it still sits there.
        let mut card_revs = std::collections::BTreeMap::new();
        if let Some(wt_path_str) = &card_wt {
            let wt_path = PathBuf::from(wt_path_str);
            if wt_path.exists() {
                // A Builder card ships only as its verified build snapshot;
                // edits made after Build done are refused, never flushed. The
                // session stays open, so nothing is committed here at all and
                // the merge below takes the snapshot SHA, not the branch.
                if cards[card_idx].builder.is_some() {
                    if req.skip_verify {
                        // The explicit, `-unverified`-tagged opt-out still
                        // ships only the snapshot.
                        crate::builder::require_at_last_snapshot(&cards[card_idx], &wt_path)?;
                    } else {
                        use tauri::Manager;
                        let in_flight = app
                            .state::<crate::verify::VerifyRegistry>()
                            .is_inflight(&req.workspace_id, &req.card_id);
                        crate::builder::require_verified_snapshot(&cards[card_idx], &wt_path, in_flight)?;
                    }
                } else {
                    let msg = crate::commit_message::wip_subject(&card_title);
                    commit_card_edits(&wt_path, &msg, &card_title)?;
                }
            }
        }
        if let (Some(wt_path_str), Some(branch)) = (&card_wt, &card_branch) {
            let wt_path = PathBuf::from(wt_path_str);
            if wt_path.exists() {
                // v1.31.0 (Outcome screen, Phase 3): a card may have already
                // been landed by `card_ship` (local merge). Re-squash-merging
                // an already-merged branch would fail or no-op confusingly —
                // skip the merge step when the branch is already in.
                let publish = crate::builder::publish_rev(&cards[card_idx], branch);
                if let Some(rev) = resolve_commit(&repo_root, &publish) {
                    card_revs.insert(req.card_id.clone(), rev);
                }
                let already_merged = crate::worktrees::branch_is_merged_into(
                    &repo_root,
                    &publish,
                    &config.target_branch,
                )
                .unwrap_or(false);
                if already_merged {
                    log::info!(
                        "ship_card: branch {branch} already merged into {} — skipping squash-merge",
                        config.target_branch
                    );
                } else {
                    touched.set(true);
                    crate::worktrees::squash_merge_into_workspace(
                        &repo_root,
                        &publish,
                        crate::commands::own_skill_base(&cards[card_idx]),
                    )
                        .map_err(|e| {
                            // R6: a conflict is recorded on the card, as Land's;
                            // the folder is put back below (`roll_back_release`).
                            squash_stop(&repo_root, &cards[card_idx], branch, &config.target_branch, e)
                        })?;
                }
            } else {
                // GH #222 review 1 (m5): checked above under CARD_START_LOCK; never
                // a release without the card's change.
                return Err(worktree_gone_message(&card_title, wt_path_str).into());
            }
        }

        // v1.12.2 (Cycle C): write the version into every entry in
        // `config.version_files`. For Atelier this reproduces the
        // legacy package.json + Cargo.toml + tauri.conf.json + Cargo.lock
        // sequence; for non-Atelier projects it writes whatever the
        // detected/edited config declares.
        touched.set(true);
        let wrote = write_versions_per_config(&repo_root, &config, &effective_version);
        folder.note_written(&repo_root);
        #[cfg(test)]
        after_version_write();
        wrote?;

        // Stage + commit. R8 (owner): `chore(release): vX.Y.Z`, the card's
        // title in the body (`commit_message`).
        // GH #196: tracked changes only — never an untracked file in the checkout.
        stage_release_commit(&repo_root, &config, &release_tag, legacy)?;
        folder.require_staged_as_written(&repo_root)?;
        let mut commit_args: Vec<String> = vec![
            "-m".into(),
            crate::commit_message::release_tag_subject(&release_tag),
            "-m".into(),
            crate::commit_message::release_body(std::slice::from_ref(&card_title)),
            "--trailer".into(),
            format!("Card: {}", req.card_id),
        ];
        if req.skip_verify {
            commit_args.push("--trailer".into());
            commit_args.push("Verify: skipped".into());
        }
        let commit_args_ref: Vec<&str> = commit_args.iter().map(String::as_str).collect();
        // R8: bounded, a hook's refusal in its own words; the folder is put
        // back by `roll_back_release`.
        crate::git::commit(&repo_root, &commit_args_ref).map_err(|failure| failure.text())?;

        let commit_sha = git_capture(&repo_root, &["rev-parse", "HEAD"])?
            .trim()
            .to_string();

        // Tag.
        let tag = release_tag.clone();
        make_release_tag(&repo_root, &tag)?;
        Ok((card_revs, commit_sha, tag))
    }))
    .unwrap_or_else(|panic| Err(panic_stop(panic)));
    let (card_revs, commit_sha, tag) = match made {
        Ok(made) => made,
        Err(stop) => {
            return Err(roll_back_release(
                app,
                kanban,
                &req.workspace_id,
                &repo_root,
                &folder,
                &config.target_branch,
                &release_tag,
                fast_forwarded,
                touched.get(),
                stop,
            ))
        }
    };
    // GH #222 review 2: the record of this release, written before the first
    // push and inside the local half (a quit waits for it), so a push that
    // is stopped, refused or killed leaves the evidence to publish it.
    let record = crate::release_record::PendingRelease {
        version: effective_version.clone(),
        tag: tag.clone(),
        commit_sha: commit_sha.clone(),
        branch: config.target_branch.clone(),
        card_ids: vec![req.card_id.clone()],
        card_revs,
        release_kind: req.release_kind,
        skip_verify: req.skip_verify,
        stopped_at: None,
        cause: None,
        output: None,
        bound: None,
        created_at: now_millis(),
        stage: crate::release_record::RecordStage::Tagged,
        start_commit: Some(folder.head.clone()),
        protected: false,
        tag_pushed: false,
        pr: None,
        merged_card_ids: Vec::new(),
        since_tag: None,
        other_changes: 0,
        stop_requested: false,
    };
    // Review 3: the tag exists; from here the record is kept whatever
    // happens (a failed write below leaves it at `Committing`, which the
    // window offers to dismiss).
    pre.disarm();
    // R6 (Challenger m3): the tag exists — a conflict an earlier ship of
    // these cards stopped on is over (`finish_release` clears it again).
    clear_shipped_conflicts(kanban, &req.workspace_id, &cards, &record.card_ids);
    if pushes(req.release_kind) {
        save_record(app, &ws_dir, &req.workspace_id, &record)?;
    }
    // GH #203 review 2: merge, commit and tag are done; the pushes below may
    // take minutes (GH #222: `SHIP_PUSH_TIMEOUT`), so Ply's own fast-forwards
    // (and a Trash queued behind them with CARD_START_LOCK) never wait on the
    // network here.
    drop(fast_forward);
    drop(start);
    drop(local);

    // Push (Github + PushOnly), put the worktree away, mark the card shipped
    // and clear the record — GH #222: bounded; a stopped push leaves the card
    // unshipped and the record to publish it. Kanban is written BEFORE
    // install-local.sh so the post-relaunch app sees the card as shipped.
    let kept = finish_release(app, &ws_dir, &repo_root, &config, kanban, &req.workspace_id, record)?;

    // v1.12.2 (Cycle C): install_script is now per-project. None means
    // the project ships at commit + tag — no build/install step. For
    // Atelier the bootstrap config provides "scripts/install-local.sh"
    // and the legacy detached-spawn behavior (Bug A + Bug G) is
    // preserved. For LYRA-or-other projects the user's config decides.
    let install_log = if let Some(held) = install_held(project_config, &req.workspace_id, &release_tag, config.install_script.as_deref()) {
        held
    } else if let Some(rel_script) = config.install_script.as_deref() {
        spawn_install_script(&repo_root, rel_script).map_err(|e| {
            format!(
                "ship aborted: {e} (commit + tag created — fix the path or \
                 remove install_script from config, then re-ship)"
            )
        })?;
        format!(
            "Build started in background ({rel_script}). Tail {} for live output. \
             Atelier will quit and relaunch as {} once the build completes.",
            build_log_path().display(),
            release_tag
        )
    } else {
        format!(
            "Shipped {}: commit + tag created. No install_script in this project's config; \
             nothing to rebuild.",
            release_tag
        )
    };

    let (install_script, relaunches) = install_outcome(&repo_root, &config);
    Ok(ShipResult {
        commit_sha,
        shipped_version: effective_version,
        release_kind: req.release_kind,
        install_log: with_kept(install_log, &kept),
        fast_forwarded,
        install_script,
        relaunches,
        release_pr: None,
        tag: Some(release_tag),
    })
}

/// v1.154.1 (F11): a card whose work is in a pull request still open on
/// GitHub isn't released another way (G8 fixes: Ship now's release through
/// a pull request too) — `what` names the refusing action, as before.
fn open_pr_refusal(what: &str, card: &KanbanCard) -> Option<String> {
    crate::pr_status::card_pr_open(card).then(|| {
        format!(
            "{what} blocked: card `{}` has pull request #{} open on GitHub; merge it from the card",
            card.title,
            card.pr.as_ref().map_or(0, |p| p.number)
        )
    })
}

/// G8 fixes (Challenger major 3): Ship as a PR (`card_ship`'s `pr` mode) of
/// a card that is in a release through a pull request on its way — it would
/// reach the target twice. `None` when it isn't in one.
pub(crate) fn in_release_pr_refusal(
    project_config: &ProjectConfigStore,
    kanban: &KanbanStore,
    workspace_id: &str,
    card: &KanbanCard,
) -> Option<String> {
    let record = live_record(&project_config.workspace_dir(workspace_id), kanban, workspace_id).ok()??;
    (record.pr.is_some() && record.card_ids.contains(&card.id)).then(|| {
        format!(
            "“{}” is in {}, which is on its way through a release pull request on GitHub, so it isn't \
             shipped as a pull request of its own. Wait for {} to be merged, or dismiss it on the card \
             first. Nothing was pushed.",
            card.title, record.tag, record.tag
        )
    })
}

/// G8 (1.170.0): Ship now / Ship batch on GitHub — build the release
/// branch, then take it as far as it goes now (`release_pr`). The caller
/// holds the workspace's ship lock and, as `start`, CARD_START_LOCK.
#[allow(clippy::too_many_arguments)]
fn ship_through_pr<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    project_config: &ProjectConfigStore,
    ws_dir: &Path,
    ws_cwd: &Path,
    repo_root: &Path,
    config: &ProjectConfig,
    kanban: &KanbanStore,
    workspace_id: &str,
    cards: Vec<&KanbanCard>,
    version: String,
    kind: ReleaseKind,
    skip_verify: bool,
    tag_prefix: &str,
    facts: ReleaseFacts,
    start: std::sync::MutexGuard<'static, ()>,
) -> Result<ShipResult, ShipError> {
    let _github = crate::github_account::enter_for_app(app, workspace_id);
    // 1.174.0 (DR2): Stop the release reaches this press through its flag.
    let press = PressStop::begin(workspace_id);
    let place = release_pr::Place { app, workspace_id, ws_cwd, repo_root, ws_dir, config, kanban };
    let build = release_pr::Build {
        cards,
        version,
        tag_prefix: tag_prefix.to_string(),
        kind,
        skip_verify,
        setup: crate::worktree_setup::load_settings(project_config, workspace_id),
        facts,
        stop: Some(press.flag()),
    };
    let record = release_pr::build(&place, &build, start)?;
    let advanced = release_pr::advance_now(&place, record, release_pr::PRESS_STEPS)?;
    after_press(&place, &press, advanced)
}

/// 1.174.0 (DR2): a press whose Stop came while it was sending the release:
/// what it got to is given up as Dismiss gives it up (`release_pr::settle_stop`),
/// or — merged on GitHub meanwhile — it goes on.
fn after_press<R: tauri::Runtime>(
    place: &release_pr::Place<R>,
    press: &PressStop,
    advanced: release_pr::Advanced,
) -> Result<ShipResult, ShipError> {
    if press.stopped() {
        if let release_pr::Advanced::Waiting(record) = &advanced {
            let mut record = record.clone();
            record.stop_requested = true;
            match release_pr::settle_stop(place, &record)? {
                release_pr::Settled::GivenUp(said) => {
                    log::info!("ship: {} stopped on the person's press. {said}", record.tag);
                    let pushed = record.pr.as_ref().is_some_and(|p| p.step >= crate::release_record::PrReleaseStep::Pushed);
                    return Err(ShipError::stopped_on_github(&record.tag, &record.version, pushed.then_some(said)));
                }
                // Merged on GitHub meanwhile: it can't be taken back, so it
                // goes on from there.
                release_pr::Settled::GoesOn(on) => {
                    press.clear();
                    let advanced = release_pr::advance_now(place, on, release_pr::PRESS_STEPS)?;
                    return release_pr::press_result(place, advanced);
                }
                // Its auto-merge couldn't be turned off: kept, its problem says so.
                release_pr::Settled::Kept(kept) => {
                    return release_pr::press_result(place, release_pr::Advanced::Waiting(kept));
                }
            }
        }
    }
    release_pr::press_result(place, advanced)
}

/// G8: a press on the cards of a release through a pull request that is on
/// its way — taken on from its last step.
#[allow(clippy::too_many_arguments)]
fn resume_through_pr<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    ws_dir: &Path,
    ws_cwd: &Path,
    repo_root: &Path,
    config: &ProjectConfig,
    kanban: &KanbanStore,
    workspace_id: &str,
    record: crate::release_record::PendingRelease,
) -> Result<ShipResult, ShipError> {
    let _github = crate::github_account::enter_for_app(app, workspace_id);
    // 1.173.0 (B4): on the branch the release was built for.
    let config = &ProjectConfig { target_branch: record.branch.clone(), ..config.clone() };
    let press = PressStop::begin(workspace_id);
    let place = release_pr::Place { app, workspace_id, ws_cwd, repo_root, ws_dir, config, kanban };
    let advanced = release_pr::advance_now(&place, record, release_pr::PRESS_STEPS)?;
    after_press(&place, &press, advanced)
}

/// G8: **Update the release** — GitHub's target moved on under the release
/// pull request (`release_pr::update`). Under the workspace's ship lock.
pub(crate) fn update_release_pr<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    ship_registry: &ShipRegistry,
    workspaces: &WorkspaceStore,
    project_config: &ProjectConfigStore,
    kanban: &KanbanStore,
    workspace_id: &str,
) -> Result<String, ShipError> {
    let _guard = ship_registry
        .try_acquire(workspace_id)
        .ok_or_else(|| SHIP_BUSY.to_string())?;
    load_project_config_for(workspace_id, workspaces, project_config)?;
    let snap = workspaces.snapshot();
    let ws = snap
        .workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| format!("workspace not found: {workspace_id}"))?;
    let repo_root = resolve_workspace_repo_root(&ws.cwd)?;
    let ws_dir = project_config.workspace_dir(workspace_id);
    let record = live_record(&ws_dir, kanban, workspace_id)?
        .filter(|r| r.pr.is_some())
        .ok_or_else(|| "There is no release pull request to update. Nothing was changed.".to_string())?;
    // 1.173.0 (B4): the release's area, read from its tag, on the branch it
    // was built for.
    let mut config = load_ship_area_for_tag(workspace_id, &record.tag, workspaces, project_config)?.config;
    config.target_branch = record.branch.clone();
    let _github = crate::github_account::enter_for_app(app, workspace_id);
    // DR2 round 1: Stop reaches Update the release's checks too.
    let press = PressStop::begin(workspace_id);
    let place = release_pr::Place {
        app,
        workspace_id,
        ws_cwd: Path::new(&ws.cwd),
        repo_root: &repo_root,
        ws_dir: &ws_dir,
        config: &config,
        kanban,
    };
    release_pr::update(&place, record, &crate::worktree_setup::load_settings(project_config, workspace_id), Some(&press.flag()))
}

/// G8 fixes (m2): the install step of a release the poller finished, on
/// the person's press (`release_pr::run_install`). Under the ship lock.
pub(crate) fn run_release_install(
    ship_registry: &ShipRegistry,
    workspaces: &WorkspaceStore,
    project_config: &ProjectConfigStore,
    workspace_id: &str,
    tag: &str,
) -> Result<String, String> {
    let _guard = ship_registry.try_acquire(workspace_id).ok_or_else(|| SHIP_BUSY.to_string())?;
    // 1.173.0 (B4): the area the tag is of; the branch its record was built
    // for while the record is there, else the area's.
    let mut config = load_ship_area_for_tag(workspace_id, tag, workspaces, project_config)?.config;
    if let Ok(Some(record)) = crate::release_record::load(&project_config.workspace_dir(workspace_id)) {
        if record.tag == tag {
            config.target_branch = record.branch;
        }
    }
    let snap = workspaces.snapshot();
    let ws = snap
        .workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| format!("workspace not found: {workspace_id}"))?;
    let repo_root = resolve_workspace_repo_root(&ws.cwd)?;
    refuse_self_install(&repo_root, config.install_script.as_deref())?;
    // 1.175.0 B2: a press on "Run the install step" isn't the OK for a step
    // this computer hasn't allowed; the window asks with the sheet.
    if let Some(held) = install_held(project_config, workspace_id, tag, config.install_script.as_deref()) {
        return Err(held);
    }
    release_pr::run_install(&repo_root, &config, tag)
}

/// G8: the poller's round for releases through a pull request
/// (`pr_status::poll_once`).
pub(crate) fn poll_release_prs<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    release_pr::poll(app);
}

#[path = "release_pr.rs"]
pub(crate) mod release_pr;

/// GH #222: the bound on each of a release's pushes (the target branch, then
/// the tag). A release push is normally one squash commit and a tag —
/// seconds — but it is the one push that may carry a large change (vendored
/// assets, a first push of a long history) over a slow uplink: five minutes
/// is ~37 MB at 1 Mbit/s. A push still moving data is never what this ends;
/// it ends a stalled one (an ssh or credential helper waiting on nothing, a
/// hung pre-receive hook). Ship runs on a worker (the UI stays live) and
/// holds only this workspace's ship lock and the target branch's integration
/// lock while it waits; the fast-forward lock is already released.
pub(crate) const SHIP_PUSH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

#[cfg(test)]
thread_local! {
    /// Tests shorten the bound for the ship that runs on their thread.
    pub(crate) static SHIP_PUSH_TIMEOUT_FOR_TEST: std::cell::Cell<Option<std::time::Duration>> =
        const { std::cell::Cell::new(None) };
}

pub(crate) fn ship_push_timeout() -> std::time::Duration {
    #[cfg(test)]
    if let Some(timeout) = SHIP_PUSH_TIMEOUT_FOR_TEST.with(|t| t.get()) {
        return timeout;
    }
    SHIP_PUSH_TIMEOUT
}

/// "5 minutes", or "1.5s" for a bound under a minute (tests).
pub(crate) fn describe_bound(timeout: std::time::Duration) -> String {
    let secs = timeout.as_secs();
    if secs >= 60 && secs % 60 == 0 {
        let minutes = secs / 60;
        format!("{minutes} minute{}", if minutes == 1 { "" } else { "s" })
    } else {
        format!("{:.1}s", timeout.as_secs_f32())
    }
}

/// GH #222 review 1: the refusal when another Ship (or a Land, which takes the
/// same per-workspace lock) of this project is still running. No workspace id:
/// the member never sees one.
pub(crate) const SHIP_BUSY: &str = "Another release or land of this project is still running. \
     Nothing was changed — wait for it to finish, then try again.";

/// GH #222 review 1 (m5): a card whose worktree disappeared is never released
/// as a version bump without its change.
fn worktree_gone_message(title: &str, path: &str) -> String {
    format!(
        "Ship stopped: the card's copy of the repository for `{title}` is gone ({path}), so its \
         change can't be merged. Nothing was merged, committed or tagged. Restore the folder \
         from the trash beside the cards' copies, or start the card again."
    )
}

/// R8 Challenger M4: a card's uncommitted edits are committed onto its
/// branch before it is merged, or the release stops — a refused or stopped
/// commit (a hook, a signing prompt) said in its own words, and edits still
/// left uncommitted after it said too (as `recovery_flush_and_verify`).
/// Never a release without the card's edits.
fn commit_card_edits(wt_path: &Path, msg: &str, title: &str) -> Result<(), String> {
    crate::worktrees::commit_pending_in_worktree(wt_path, msg)?;
    if crate::worktrees::worktree_is_dirty(wt_path).unwrap_or(true) {
        // Challenger minor: the paths left, as `git status --porcelain` names them.
        let left = git_capture(wt_path, &["status", "--porcelain", "--untracked-files=all"])
            .map(|out| out.lines().map(|l| l.get(3..).unwrap_or(l).to_string()).filter(|p| !p.is_empty()).collect::<Vec<_>>())
            .unwrap_or_default();
        let named = if left.is_empty() { String::new() } else { format!(": {}", left.join(", ")) };
        return Err(format!(
            "`{title}` has changes in its copy that Plyloft couldn't commit before the release \
             ({}){named}. They would be left out of it. Commit or remove them there, then ship again.",
            wt_path.display()
        ));
    }
    Ok(())
}

/// R8 Challenger M1: how long making the release tag may take.
const TAG_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// R8 Challenger M1: the release's lightweight tag. `tag.gpgSign=true` would
/// make `git tag <name>` a signed annotated tag that opens an editor for its
/// message (and may wait on a signing prompt); Plyloft's tag is never
/// signed, and the call is bounded like its commits.
fn make_release_tag(repo_root: &Path, tag: &str) -> Result<(), String> {
    let mut cmd = crate::platform::git_command();
    cmd.args(["-c", "tag.gpgSign=false", "tag", tag])
        .current_dir(repo_root)
        .env("GIT_TERMINAL_PROMPT", "0");
    crate::worktrees::run_bounded(&mut cmd, "git tag", TAG_TIMEOUT).map(|_| ())
}

/// The release kinds that push.
fn pushes(kind: ReleaseKind) -> bool {
    matches!(kind, ReleaseKind::Github | ReleaseKind::PushOnly)
}

/// `rev` as a full commit SHA in `repo`, if it names one.
fn resolve_commit(repo: &Path, rev: &str) -> Option<String> {
    git_capture(repo, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// GH #222 review 2: tell the window a workspace's pending-release record
/// changed (written, updated, cleared), so a Ship step's block follows it.
pub(crate) const PENDING_RELEASE_CHANGED: &str = "ship-pending-release-changed";

fn announce_record<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str) {
    use tauri::Emitter;
    // Windows G2 walk: a release press, a stop or a dismiss changes which
    // release branches GitHub has — the next scope lists them again.
    if let Some(root) = workspace_repo_root(app, workspace_id) {
        crate::release_scope::forget_release_branches(&root);
    }
    let _ = app.emit(PENDING_RELEASE_CHANGED, workspace_id.to_string());
}

/// Write the record (atomic) and say so.
fn save_record<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    ws_dir: &Path,
    workspace_id: &str,
    record: &crate::release_record::PendingRelease,
) -> Result<(), String> {
    crate::release_record::save(ws_dir, record)
        .map_err(|e| format!("ship aborted before pushing: couldn't record the release ({e}). {} is committed and tagged here; nothing was pushed.", record.tag))?;
    announce_record(app, workspace_id);
    Ok(())
}

/// GH #222 review 3: the record written before a release's local half
/// commits anything (`RecordStage::Committing`). Dropped while armed — the
/// local half stopped before its tag (a conflict, a refused commit) — it is
/// taken back: nothing was released. Disarmed at the tag.
struct PreRecord<'a> {
    ws_dir: &'a Path,
    armed: bool,
}

impl<'a> PreRecord<'a> {
    fn arm(
        ws_dir: &'a Path,
        write: bool,
        record: crate::release_record::PendingRelease,
    ) -> Result<Self, String> {
        if write {
            crate::release_record::save(ws_dir, &record).map_err(|e| {
                format!(
                    "ship aborted: couldn't record {} before making it ({e}). Nothing was \
                     merged, committed or tagged.",
                    record.tag
                )
            })?;
        }
        Ok(Self { ws_dir, armed: write })
    }

    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for PreRecord<'_> {
    fn drop(&mut self) {
        if self.armed {
            if let Err(e) = crate::release_record::clear(self.ws_dir) {
                log::warn!("ship: couldn't take back the record of a release that wasn't made: {e}");
            }
        }
    }
}

/// GH #222 review 3: the record, unless it is already done — every recorded
/// card carries a ship-history entry at its commit (a publish whose clear
/// failed). Such a record is cleared here and read as none.
pub(crate) fn live_record(
    ws_dir: &Path,
    kanban: &KanbanStore,
    workspace_id: &str,
) -> Result<Option<crate::release_record::PendingRelease>, String> {
    let Some(record) = crate::release_record::load(ws_dir)? else {
        return Ok(None);
    };
    if record.stage == crate::release_record::RecordStage::Tagged && !record.card_ids.is_empty() {
        let cards = kanban.load(workspace_id).unwrap_or_default();
        let published = record.card_ids.iter().all(|id| {
            cards.iter().find(|c| c.id == *id).is_some_and(|c| {
                c.ship_history.iter().any(|e| e.commit_sha == record.commit_sha)
            })
        });
        if published {
            log::info!("ship: {} was published already; clearing its record", record.tag);
            crate::release_record::clear(ws_dir)?;
            return Ok(None);
        }
    }
    Ok(Some(record))
}

/// The error for a record that can't be read.
fn unreadable(reason: String) -> ShipError {
    ShipError::RecordUnreadable(crate::worktrees::RecordUnreadable { record_unreadable: reason })
}

/// GH #222 review 3: the recorded release that holds back a Ship or a Land of
/// `branch` in the repository at `repo_cwd`: this workspace's own (returned),
/// or another workspace's on the same repository and branch (refused, named)
/// — two workspaces on one repository share its branch, like
/// `integration_lock`. An unreadable record of this workspace refuses too.
pub(crate) fn blocking_record(
    workspaces: &WorkspaceStore,
    project_config: &ProjectConfigStore,
    kanban: &KanbanStore,
    workspace_id: &str,
    repo_cwd: &Path,
    branch: &str,
) -> Result<Option<crate::release_record::PendingRelease>, ShipError> {
    let own = live_record(&project_config.workspace_dir(workspace_id), kanban, workspace_id)
        .map_err(unreadable)?;
    if own.is_some() {
        return Ok(own);
    }
    let repo = crate::shared_config::repository_identity(repo_cwd);
    for ws in workspaces.snapshot().workspaces {
        if ws.id == workspace_id
            || crate::shared_config::repository_identity(Path::new(&ws.cwd)) != repo
        {
            continue;
        }
        let Ok(Some(record)) =
            live_record(&project_config.workspace_dir(&ws.id), kanban, &ws.id)
        else {
            continue;
        };
        if record.branch == branch {
            return Err(format!(
                "{} of this repository was released from the workspace `{}` and isn't published \
                 yet, so nothing else ships or lands on {branch} until it is. Nothing was changed. \
                 Publish it — or dismiss it — from that workspace's card, then try again.",
                record.tag, ws.name
            )
            .into());
        }
    }
    Ok(None)
}

/// GH #222 review 3: a Land (Merge, the Outcome screen's merge) is refused
/// while a release of its branch is recorded — as the value, so the window
/// leads to the Ship step that offers Publish and Dismiss.
pub(crate) fn refuse_land_while_recorded(
    workspaces: &WorkspaceStore,
    project_config: &ProjectConfigStore,
    kanban: &KanbanStore,
    workspace_id: &str,
) -> Result<(), ShipError> {
    let snap = workspaces.snapshot();
    let Some(ws) = snap.workspaces.iter().find(|w| w.id == workspace_id) else {
        return Ok(());
    };
    let branch = project_config
        .get(workspace_id)
        .map(|c| c.target_branch)
        .unwrap_or_else(|| "main".to_string());
    let Some(record) = blocking_record(
        workspaces,
        project_config,
        kanban,
        workspace_id,
        Path::new(&ws.cwd),
        &branch,
    )?
    else {
        return Ok(());
    };
    let view = match resolve_workspace_repo_root(&ws.cwd) {
        Ok(root) => crate::release_record::view(&root, record),
        Err(_) => crate::release_record::PendingReleaseView { record, problem: None, undo: false },
    };
    Err(ShipError::Unpublished(crate::worktrees::ReleaseUnpublished { unpublished: view }))
}

/// GH #222 review 4: [`blocking_record`]'s refusal when it is another
/// workspace's release on the same repository and branch.
fn pending_elsewhere(
    workspaces: &WorkspaceStore,
    project_config: &ProjectConfigStore,
    kanban: &KanbanStore,
    workspace_id: &str,
) -> Option<String> {
    let branch = project_config.get(workspace_id)?.target_branch;
    let snap = workspaces.snapshot();
    let ws = snap.workspaces.iter().find(|w| w.id == workspace_id)?;
    match blocking_record(workspaces, project_config, kanban, workspace_id, Path::new(&ws.cwd), &branch) {
        Err(ShipError::Message(message)) => Some(message),
        _ => None,
    }
}

#[cfg(test)]
pub(crate) fn pending_elsewhere_for_test(
    workspaces: &WorkspaceStore,
    project_config: &ProjectConfigStore,
    kanban: &KanbanStore,
    workspace_id: &str,
) -> Option<String> {
    pending_elsewhere(workspaces, project_config, kanban, workspace_id)
}

/// GH #222 review 4: deleting a workspace with a recorded release (or an
/// unreadable record) is refused — its tag would stay on this Mac with nothing
/// in Ply to publish or dismiss it.
pub(crate) fn workspace_delete_refusal(
    project_config: &ProjectConfigStore,
    kanban: &KanbanStore,
    workspace_id: &str,
) -> Option<String> {
    match live_record(&project_config.workspace_dir(workspace_id), kanban, workspace_id) {
        Ok(None) => None,
        Ok(Some(record)) => Some(format!(
            "{} of this workspace is committed on {THIS_MACHINE} but not published yet. Nothing was \
             deleted. Publish {} — or dismiss it — from its card's Ship step first; deleting the \
             workspace now would leave the tag here with nothing in Plyloft to publish it.",
            record.tag, record.tag
        )),
        Err(reason) => Some(format!(
            "{reason} Nothing was deleted. Dismiss the record from a card's Ship step first."
        )),
    }
}

/// GH #222 review 3: deleting or archiving a card of a recorded release is
/// refused — the record would name a card nobody can reach, and its Ship
/// step (Publish, Dismiss) would be gone with it.
pub(crate) fn card_removal_refusal(
    project_config: &ProjectConfigStore,
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    title: &str,
) -> Option<String> {
    let record =
        live_record(&project_config.workspace_dir(workspace_id), kanban, workspace_id).ok()??;
    record.card_ids.iter().any(|id| id == card_id).then(|| {
        format!(
            "`{title}` is part of {}, which is committed on {THIS_MACHINE} but not published yet. \
             Nothing was changed. Publish {} — or dismiss it — from the card's Ship step first.",
            record.tag, record.tag
        )
    })
}

/// R9: true when git's words for a refused push say the branch is protected
/// — GitHub's classic protection (`GH006: Protected branch update failed`),
/// a ruleset (`GH013: Repository rule violations`), or a server's own
/// "protected branch" hook (GitLab, Gitea).
pub(crate) fn refused_as_protected(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    lower.contains("gh006") || lower.contains("gh013") || lower.contains("protected branch")
}

#[cfg(test)]
thread_local! {
    /// Tests run against a local bare origin: the GitHub repository it
    /// stands for, so the protection read (mocked `gh`) is asked.
    pub(crate) static TEST_ORIGIN_SLUG: std::cell::RefCell<Option<String>> =
        const { std::cell::RefCell::new(None) };
}

/// The GitHub repository origin is, if it is one.
pub(crate) fn github_origin(repo_root: &Path) -> Option<String> {
    #[cfg(test)]
    if let Some(slug) = TEST_ORIGIN_SLUG.with(|s| s.borrow().clone()) {
        return Some(slug);
    }
    crate::review_base::origin_record_of(repo_root).0
}

/// True when git refused a push because origin's branch moved on.
fn not_a_fast_forward(output: &str) -> bool {
    output.contains("(non-fast-forward)") || output.contains("(fetch first)")
}

/// 1.175.0 (A8, OP-6): what the branch push of a release names — the
/// release's own commit, `<sha>:refs/heads/<branch>`, so commits that reached
/// the local branch after the release was made (a publish retried days
/// later) stay on this computer. `None` when the record holds no whole commit
/// id: an empty left side would ask origin to delete the branch.
pub(crate) fn release_commit_refspec(record: &crate::release_record::PendingRelease) -> Option<String> {
    let sha = record.commit_sha.trim();
    let whole = matches!(sha.len(), 40 | 64) && sha.bytes().all(|b| b.is_ascii_hexdigit());
    (whole && !record.branch.trim().is_empty()).then(|| format!("{sha}:refs/heads/{}", record.branch))
}

/// The branch push of a release: its commit ([`release_commit_refspec`]),
/// and the branch by name, as before, only when origin can't take that
/// commit as a fast-forward — origin's branch already holds the release and
/// more (a pull moved this branch past it), or it moved on and the person
/// merged it here, and then that merge is what publishes the release. Git's
/// words name the branch either way, as they always did.
fn push_release_branch(
    repo_root: &Path,
    record: &crate::release_record::PendingRelease,
    timeout: std::time::Duration,
) -> Result<(), crate::worktrees::ReleasePushFailure> {
    use crate::worktrees::ReleasePushFailure;
    if let Some(refspec) = release_commit_refspec(record) {
        match crate::worktrees::release_push(repo_root, &refspec, timeout) {
            // Round 3 (S4): origin's branch may already hold the release (it
            // was pushed, and a pull moved this branch past it). Then there
            // is nothing to push for the branch — and pushing it by name
            // would send whatever was committed here since. Only the tag is
            // left. Asked of origin now; no answer falls back, as before.
            Err(ReleasePushFailure::Failed(msg)) if not_a_fast_forward(&msg) => {
                if origin_holds_release(repo_root, record) {
                    return Ok(());
                }
            }
            Err(ReleasePushFailure::Failed(msg)) => {
                let named = format!("git push origin {}", record.branch);
                return Err(ReleasePushFailure::Failed(msg.replacen(&format!("git push origin {refspec}"), &named, 1)));
            }
            done => return done,
        }
    }
    crate::worktrees::release_push(repo_root, &record.branch, timeout)
}

/// Origin's `record.branch`, fetched now, already contains the release's
/// commit. `false` when the fetch gives no answer.
fn origin_holds_release(repo_root: &Path, record: &crate::release_record::PendingRelease) -> bool {
    if let Err(e) = crate::worktrees::fetch_origin_branch(repo_root, &record.branch) {
        log::info!("ship: couldn't read origin's {} before the release's branch push: {e}", record.branch);
        return false;
    }
    let origin = format!("refs/remotes/origin/{}", record.branch);
    git_run(repo_root, &["merge-base", "--is-ancestor", &record.commit_sha, &origin]).is_ok()
}

/// GH #222: push the release — its branch, then its tag — each bounded by
/// [`SHIP_PUSH_TIMEOUT`]. On success the record's stop fields are cleared;
/// otherwise they say which push did not finish and why, and the caller
/// keeps the record. Review 2: when origin's branch has moved on (the branch
/// push is not a fast-forward) the tag is still pushed — the release is kept
/// on origin — and the branch is left for the person to merge: Ply never
/// force-pushes.
fn push_release(repo_root: &Path, record: &mut crate::release_record::PendingRelease) -> bool {
    use crate::release_record::{PushStopCause, ReleasePushStep};
    use crate::worktrees::ReleasePushFailure;
    let timeout = ship_push_timeout();
    // Challenger minor: an earlier attempt that found origin moved on pushed
    // the tag; a protection refusal now is never "nothing was pushed".
    let tag_pushed_before = record.tag_pushed || record.cause == Some(PushStopCause::OriginMoved);
    let stop = |record: &mut crate::release_record::PendingRelease,
                step: ReleasePushStep,
                cause: PushStopCause,
                output: Option<String>| {
        // R9: only a branch push refused as protected; the tag was not
        // pushed then (`PendingReleaseView::undo`).
        record.protected = !tag_pushed_before
            && step == ReleasePushStep::Branch
            && cause == PushStopCause::Refused
            && output.as_deref().is_some_and(refused_as_protected);
        record.stopped_at = Some(step);
        record.cause = Some(cause);
        record.output = output;
        record.bound = Some(describe_bound(timeout));
        false
    };
    match push_release_branch(repo_root, record, timeout) {
        Ok(()) => {}
        Err(ReleasePushFailure::TimedOut) => {
            return stop(record, ReleasePushStep::Branch, PushStopCause::TimedOut, None)
        }
        Err(ReleasePushFailure::Failed(msg)) if not_a_fast_forward(&msg) => {
            let tag = record.tag.clone();
            return match crate::worktrees::release_push(repo_root, &tag, timeout) {
                Ok(()) => {
                    record.tag_pushed = true;
                    stop(record, ReleasePushStep::Branch, PushStopCause::OriginMoved, Some(msg))
                }
                Err(ReleasePushFailure::TimedOut) => {
                    stop(record, ReleasePushStep::Tag, PushStopCause::TimedOut, Some(msg))
                }
                Err(ReleasePushFailure::Failed(tag_msg)) => stop(
                    record,
                    ReleasePushStep::Tag,
                    PushStopCause::Refused,
                    Some(format!("{msg}\n{tag_msg}")),
                ),
            };
        }
        Err(ReleasePushFailure::Failed(msg)) => {
            return stop(record, ReleasePushStep::Branch, PushStopCause::Refused, Some(msg))
        }
    }
    let tag = record.tag.clone();
    match crate::worktrees::release_push(repo_root, &tag, timeout) {
        Ok(()) => {
            record.stopped_at = None;
            record.cause = None;
            record.output = None;
            record.protected = false;
            true
        }
        Err(ReleasePushFailure::TimedOut) => {
            stop(record, ReleasePushStep::Tag, PushStopCause::TimedOut, None)
        }
        Err(ReleasePushFailure::Failed(msg)) => {
            stop(record, ReleasePushStep::Tag, PushStopCause::Refused, Some(msg))
        }
    }
}

/// GH #222 review 2: the second half of every release — push (the record's
/// kind), put the released worktrees away, mark every card shipped in one
/// board write, then clear the record. A push that does not finish keeps
/// the record (updated with why) and returns [`ShipError::Unpublished`];
/// nothing is marked. Marking is idempotent (a card already shipped at this
/// commit gets no second entry), so a publish retried after a failed board
/// write is safe. Returns what was kept, and why, for the result's log.
fn finish_release<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    ws_dir: &Path,
    repo_root: &Path,
    config: &ProjectConfig,
    kanban: &KanbanStore,
    workspace_id: &str,
    mut record: crate::release_record::PendingRelease,
) -> Result<Vec<String>, ShipError> {
    use crate::worktrees::ReleaseUnpublished;
    // Review 3: never push (or mark, or put away) a release that is no longer
    // what its record says — its tag gone or moved, its commit reset or
    // rebased off the branch.
    if pushes(record.release_kind) {
        let view = crate::release_record::view(repo_root, record.clone());
        if view.problem.is_some() {
            announce_record(app, workspace_id);
            return Err(ShipError::Unpublished(ReleaseUnpublished { unpublished: view }));
        }
    }
    // OB-7b: the branch and tag go to origin as the workspace's GitHub account.
    let github = crate::github_account::enter_for_app(app, workspace_id);
    let pushed = !pushes(record.release_kind) || push_release(repo_root, &mut record);
    drop(github);
    if !pushed {
        if let Err(e) = crate::release_record::save(ws_dir, &record) {
            log::warn!("ship: couldn't update the pending-release record: {e}");
        }
        announce_record(app, workspace_id);
        return Err(ShipError::Unpublished(ReleaseUnpublished {
            unpublished: crate::release_record::view(repo_root, record),
        }));
    }
    mark_released(app, ws_dir, repo_root, config, kanban, workspace_id, &record)
}

/// 1.171.0 F1 (Challenger 5): what `builder::record_shipped_unreviewed`
/// writes for Ship it, for a released Builder card: Ship's receipt line for
/// its last saved work (None when it was reviewed), and no verdict left to
/// deliver to its Builder (GH #135). Cards without a Builder: untouched.
fn settle_released_builder(card: &mut KanbanCard) {
    let Some(last) = card.builder.as_ref().and_then(|b| b.snapshots.last()).map(|s| s.sha.clone()) else {
        return;
    };
    let line = crate::builder::ship_review_record(card, &last, false);
    if let Some(b) = card.builder.as_mut() {
        b.shipped_unreviewed = line;
        b.undelivered_verdict = None;
    }
}

/// The end of every release once it is on GitHub (or made here, for a local
/// one): put the released worktrees away, mark every card shipped at
/// `record.commit_sha` in one board write (idempotent), then clear the
/// record. G8: a release through a pull request ends here too, at its merge
/// commit. Returns what was kept, and why.
fn mark_released<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    ws_dir: &Path,
    repo_root: &Path,
    config: &ProjectConfig,
    kanban: &KanbanStore,
    workspace_id: &str,
    record: &crate::release_record::PendingRelease,
) -> Result<Vec<String>, ShipError> {
    let (put_away, kept, trashed) = put_away_worktrees(app, repo_root, config, kanban, workspace_id, record);
    // N18: each released card's branch, at the commit that was released,
    // for the cleanup once its trash entry expires. Read before the board
    // lock: it is git.
    let shipped_at = now_millis();
    let branch_records: std::collections::HashMap<String, crate::branch_cleanup::BranchCleanup> = kanban
        .load(workspace_id)
        .unwrap_or_default()
        .iter()
        .filter(|c| record.card_ids.contains(&c.id))
        .filter_map(|c| {
            // Only a card whose released commit is known: never its tip.
            let rec = crate::branch_cleanup::release_record(
                c,
                repo_root,
                record.card_revs.get(&c.id).map(String::as_str),
                trashed.get(&c.id).map(PathBuf::as_path),
                shipped_at,
            )?;
            Some((c.id.clone(), rec))
        })
        .collect();
    let sha = record.commit_sha.clone();
    let version = record.version.clone();
    let kind = record.release_kind;
    let skip = record.skip_verify || version.contains("-unverified");
    // 1.174.0 (DR2, D1(b)): the cards that were on the target already (Ship
    // it's pull requests) are in this version too: one ship-history entry
    // each, with its tag and commit, in the same board write. Nothing else
    // of theirs changes (`ship_status` as it was, no copy to put away).
    let merged: Vec<String> = record
        .merged_card_ids
        .iter()
        .filter(|id| !record.card_ids.contains(id))
        .cloned()
        .collect();
    let mut written: Vec<String> = record.card_ids.clone();
    written.extend(merged.iter().cloned());
    kanban.with_cards_saved(workspace_id, &written, |card| {
        if merged.contains(&card.id) {
            if !card.ship_history.iter().any(|e| e.tag.as_deref() == Some(record.tag.as_str())) {
                card.ship_history.push(ShipEntry {
                    commit_sha: sha.clone(),
                    shipped_version: version.clone(),
                    release_kind: kind,
                    shipped_at,
                    target: Some(record.branch.clone()),
                    tag: Some(record.tag.clone()),
                });
            }
            return Ok(());
        }
        card.commit_sha = Some(sha.clone());
        card.shipped_version = Some(version.clone());
        card.ship_status = ShipStatus::Shipped;
        if !card.ship_history.iter().any(|e| e.commit_sha == sha) {
            card.ship_history.push(ShipEntry {
                commit_sha: sha.clone(),
                shipped_version: version.clone(),
                release_kind: kind,
                shipped_at,
                target: crate::kanban::ship_target_of(card),
                tag: Some(record.tag.clone()),
            });
        }
        if let Some(rec) = branch_records.get(&card.id) {
            crate::branch_cleanup::stamp(card, rec.clone());
        }
        // 1.171.0 F1 (Challenger 5): a released Builder card — a batch's
        // included — keeps Ship's receipt line, as
        // `builder::record_shipped_unreviewed` writes it for Ship it, and
        // owes its Builder nothing (GH #135: no verdict left to deliver).
        settle_released_builder(card);
        // R6: a card whose earlier ship stopped on a conflict is released
        // now; the conflict's record goes with its status (as Land's).
        if card.review_status == Some(crate::kanban::ReviewStatus::ConflictBlocked) {
            card.review_status = None;
            card.ship_conflict = None;
        }
        // Phase E (decision 20): skip-verify marks verify Skipped.
        if skip {
            card.verify_status = VerifyStatus::Skipped;
        }
        // v1.10.3: the released worktree was put away — clear its handle. A
        // kept one keeps its handle, so the card still leads to it.
        if card.worktree_path.is_none() || put_away.contains(&card.id) {
            card.worktree_path = None;
            card.branch_name = None;
            card.worktree_base = None;
            card.worktree_setup = None;
        }
        Ok(())
    })?;
    // 1.170 walk: the board says shipped before the record goes. A window
    // that read the record gone with its board still from before (a release
    // through a pull request brings this computer up to date before its own
    // board event) showed "Ship didn't go through" for seconds.
    crate::kanban::emit_kanban_changed(app, workspace_id);
    // 1.174.0 (DR4 round 1): what the Inbox's News says of it, a release
    // with no card of its own included.
    let carried: Vec<&String> = record.card_ids.iter().chain(merged.iter()).collect();
    let one = if carried.len() == 1 {
        kanban.load(workspace_id).ok().and_then(|b| b.into_iter().find(|c| &c.id == carried[0])).map(|c| (c.id, c.title))
    } else {
        None
    };
    if let Err(e) = crate::release_record::append_released(
        ws_dir,
        crate::release_record::ReleasedEntry {
            tag: record.tag.clone(),
            at: shipped_at,
            cards: u32::try_from(carried.len()).unwrap_or(u32::MAX),
            other_changes: record.other_changes,
            card_id: one.as_ref().map(|(id, _)| id.clone()),
            card_title: one.map(|(_, t)| t),
        },
    ) {
        log::warn!("ship: {} published; the Inbox's log of it wasn't written: {e}", record.tag);
    }
    if let Err(e) = crate::release_record::clear(ws_dir) {
        log::warn!("ship: {} published, but its record stays: {e}", record.tag);
    }
    announce_record(app, workspace_id);
    Ok(kept)
}

/// GH #222 review 2: put each released card's worktree in the worktree Trash
/// — only while it still holds exactly what was released (its `HEAD` is the
/// commit that was merged, and nothing uncommitted), no Builder session is
/// open on it (the reconcile's prune rule) and no Verify or agent run is
/// using it (the card delete's, `card_worktree_busy`).
/// Under CARD_START_LOCK (after the integration lock, the lock order). A
/// worktree gone already counts as put away. Returns the cards put away and
/// a sentence per worktree kept.
fn put_away_worktrees<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    repo_root: &Path,
    config: &ProjectConfig,
    kanban: &KanbanStore,
    workspace_id: &str,
    record: &crate::release_record::PendingRelease,
) -> (Vec<String>, Vec<String>, std::collections::HashMap<String, PathBuf>) {
    let _start = crate::commands::CARD_START_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let cards = kanban.load(workspace_id).unwrap_or_default();
    let (mut put_away, mut kept) = (Vec::new(), Vec::new());
    let mut trashed = std::collections::HashMap::new();
    for card in cards.iter().filter(|c| record.card_ids.contains(&c.id)) {
        let Some(wt) = card.worktree_path.as_deref().map(PathBuf::from) else {
            continue;
        };
        if !wt.exists() {
            put_away.push(card.id.clone());
            continue;
        }
        let head = crate::worktrees::head_sha(&wt).ok();
        // The reconcile's prune rule: never under an open Builder session.
        let builder_open = {
            use tauri::Manager;
            app.try_state::<crate::builder::BuilderRegistry>()
                .is_some_and(|b| b.get_pty(&card.id).is_some())
        };
        let why = if builder_open {
            Some("its Builder session is open".to_string())
        } else if let Some(busy) = crate::commands::card_worktree_busy(app, workspace_id, card) {
            Some(busy.reason)
        } else if head.is_none() || head.as_ref() != record.card_revs.get(&card.id) {
            Some("it has commits made after the release".to_string())
        } else if crate::worktrees::worktree_is_dirty(&wt).unwrap_or(true) {
            Some("it has uncommitted changes".to_string())
        } else {
            None
        };
        if let Some(why) = why {
            kept.push(format!(
                "Kept the copy of `{}` ({}): {why}.",
                card.title,
                wt.display()
            ));
            continue;
        }
        let path = crate::worktrees::card_worktree_path(repo_root, &card.id, card.worktree_path.as_deref());
        // Try it (TI-2): a preview never keeps the copy (`card_worktree_busy`
        // ignores it); it stops here, and the card says so.
        crate::try_session::stop_card_try_sessions(workspace_id, &card.id, None, crate::try_session::TryStopReason::Ship);
        match crate::worktrees::prune_worktree_at(repo_root, &path, &config.cache_paths) {
            Ok(entry) => {
                crate::verify_logs::card_worktree_removed(workspace_id, &card.id);
                if let Some(entry) = entry {
                    trashed.insert(card.id.clone(), entry);
                }
                put_away.push(card.id.clone());
            }
            Err(e) => {
                // Windows walk 2026-10-20: the card says so too, and the copy
                // is tried again once nothing holds it — only while it still
                // holds what was released (`kept_copy::retry`).
                crate::kept_copy::record(kanban, workspace_id, &card.id, &path, &e, head.clone());
                kept.push(format!(
                    "Kept the copy of `{}` ({}): it couldn't be moved to the trash: {e}.",
                    card.title,
                    wt.display()
                ));
            }
        }
    }
    (put_away, kept, trashed)
}

/// The result's log, with what was kept.
fn with_kept(log: String, kept: &[String]) -> String {
    if kept.is_empty() {
        log
    } else {
        format!("{log}\n{}", kept.join("\n"))
    }
}

/// GH #222 review 2: a Ship of exactly `pending`'s cards publishes it; any
/// other Ship is refused while it waits, so a second release never stacks on
/// an unpublished one. One that can't be published from here is the
/// [`ShipError::Unpublished`] value with its `problem`: the window offers
/// only Dismiss.
fn resume_or_refuse(
    pending: &crate::release_record::PendingReleaseView,
    wanted: &[String],
    cards: &[KanbanCard],
) -> Result<(), ShipError> {
    if pending.problem.is_some() {
        return Err(ShipError::Unpublished(crate::worktrees::ReleaseUnpublished {
            unpublished: pending.clone(),
        }));
    }
    let record = &pending.record;
    let same = wanted.len() == record.card_ids.len()
        && wanted.iter().all(|id| record.card_ids.contains(id));
    if same {
        return Ok(());
    }
    let titles: Vec<String> = record
        .card_ids
        .iter()
        .map(|id| {
            cards
                .iter()
                .find(|c| c.id == *id)
                .map(|c| format!("`{}`", c.title))
                .unwrap_or_else(|| id.clone())
        })
        .collect();
    let tag = &record.tag;
    let overlap = wanted.iter().any(|id| record.card_ids.contains(id));
    Err(if overlap {
        format!(
            "ship aborted: {tag} is already committed for {} together and isn't published yet. \
             Nothing was changed. Publish it by releasing exactly those cards together (Release N cards… in the sidebar).",
            titles.join(", ")
        )
    } else {
        format!(
            "ship aborted: {tag} ({}) is committed here but isn't published yet. Nothing was \
             changed. Publish it — or dismiss it — from {} Ship step first, then ship this.",
            titles.join(", "),
            if titles.len() == 1 { "that card's" } else { "those cards'" }
        )
    }
    .into())
}

/// GH #222 review 2: publish a recorded release — push its branch and tag
/// (a push of what origin already has is a no-op), then mark its cards
/// shipped at its version with the kind it was released as. No new version,
/// no merge, no commit. A Local request is refused: publishing *is* the push.
fn publish_pending<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    ws_dir: &Path,
    repo_root: &Path,
    config: &ProjectConfig,
    kanban: &KanbanStore,
    workspace_id: &str,
    record: crate::release_record::PendingRelease,
    requested: ReleaseKind,
) -> Result<ShipResult, ShipError> {
    // Before the push: a publish that would end in Ply's own install on
    // Windows changes nothing.
    refuse_self_install(repo_root, config.install_script.as_deref())?;
    if !pushes(requested) || !pushes(record.release_kind) {
        return Err(format!(
            "ship aborted: {} is committed here to be pushed, and publishing it is that push — a \
             release on {} only can't publish it. Nothing was changed. Choose \"Put the version \
             on GitHub\" or \"Put the version on GitHub, with a release page\" and publish again.",
            record.tag,
            crate::this_machine!()
        )
        .into());
    }
    if record.version.contains("-unverified") && matches!(record.release_kind, ReleaseKind::Github) {
        return Err(
            "github release blocked: skip-verify ships are local-only. Switch to a Local rebuild."
                .to_string()
                .into(),
        );
    }
    let (tag, sha, version, kind) = (
        record.tag.clone(),
        record.commit_sha.clone(),
        record.version.clone(),
        record.release_kind,
    );
    let kept = finish_release(app, ws_dir, repo_root, config, kanban, workspace_id, record)?;
    let held = {
        use tauri::Manager;
        app.try_state::<ProjectConfigStore>().and_then(|store| install_held(&store, workspace_id, &tag, config.install_script.as_deref()))
    };
    let install_log = if let Some(held) = held {
        held
    } else if let Some(rel_script) = config.install_script.as_deref() {
        spawn_install_script(repo_root, rel_script).map_err(|e| {
            format!(
                "ship aborted: {e} ({tag} published — fix the path or remove install_script \
                 from config, then re-ship)"
            )
        })?;
        format!(
            "Published {tag} (already committed). Build started in background ({rel_script}). \
             Tail {} for live output.",
            build_log_path().display()
        )
    } else {
        format!(
            "Published {tag} (already committed). No install_script in this project's config; \
             nothing to rebuild."
        )
    };
    let (install_script, relaunches) = install_outcome(repo_root, config);
    Ok(ShipResult {
        commit_sha: sha,
        shipped_version: version,
        release_kind: kind,
        install_log: with_kept(install_log, &kept),
        fast_forwarded: false,
        install_script,
        relaunches,
        release_pr: None,
        tag: Some(tag),
    })
}

/// GH #222 review 2–3: the workspace's recorded release as the audit and the
/// Ship step read it — or why its record can't be read. A record already
/// published is cleared on the way ([`live_record`]).
pub(crate) fn workspace_pending_release(
    workspaces: &WorkspaceStore,
    project_config: &ProjectConfigStore,
    kanban: &KanbanStore,
    workspace_id: &str,
) -> crate::release_record::PendingReleaseState {
    let record = match live_record(&project_config.workspace_dir(workspace_id), kanban, workspace_id) {
        Ok(Some(record)) => record,
        Ok(None) => return Default::default(),
        Err(reason) => {
            return crate::release_record::PendingReleaseState { release: None, unreadable: Some(reason) }
        }
    };
    let snap = workspaces.snapshot();
    let view = match snap
        .workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .and_then(|ws| resolve_workspace_repo_root(&ws.cwd).ok())
    {
        Some(root) => crate::release_record::view(&root, record),
        None => crate::release_record::PendingReleaseView {
            problem: Some("Plyloft can't find this workspace's repository to check it.".to_string()),
            record,
            undo: false,
        },
    };
    crate::release_record::PendingReleaseState { release: Some(view), unreadable: None }
}

/// GH #222 review 2: Dismiss — the person gives up publishing the recorded
/// release from Ply. The record goes; the release commit and its tag stay on
/// this Mac, the cards stay unshipped, origin is not touched. Refused while a
/// release or land of the workspace runs. Returns what was done on GitHub,
/// in words (empty when nothing was).
///
/// G8 fixes (Challenger major 4): a release through a pull request may have
/// asked GitHub to merge it when its checks pass — given up, it must not
/// merge by itself afterwards, so its auto-merge is turned off (`gh pr merge
/// --disable-auto`, as the workspace's GitHub account) and that is said; a
/// failure says auto-merge may still be on. Its pull request and branch on
/// GitHub stay; the local release branch goes.
pub(crate) fn dismiss_pending_release<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    ship_registry: &ShipRegistry,
    project_config: &ProjectConfigStore,
    workspace_id: &str,
) -> Result<String, String> {
    let _guard = ship_registry
        .try_acquire(workspace_id)
        .ok_or_else(|| SHIP_BUSY.to_string())?;
    let ws_dir = project_config.workspace_dir(workspace_id);
    let mut said = String::new();
    if let Ok(Some(record)) = crate::release_record::load(&ws_dir) {
        if let Some(pr) = &record.pr {
            use tauri::Manager;
            let cwd = app.try_state::<WorkspaceStore>().and_then(|w| {
                w.snapshot().workspaces.iter().find(|w| w.id == workspace_id).map(|w| w.cwd.clone())
            });
            let root = cwd.and_then(|cwd| resolve_workspace_repo_root(&cwd).ok());
            if let (Some(url), true) = (pr.url.as_deref(), release_pr::may_auto_merge(pr)) {
                let _github = crate::github_account::enter_for_app(app, workspace_id);
                said = release_pr::turn_off_auto_merge(root.as_deref(), url, pr.number);
            }
            if let Some(root) = root {
                release_pr::discard_local(&root, &pr.branch);
            }
        }
    }
    crate::release_record::clear(&ws_dir)?;
    announce_record(app, workspace_id);
    Ok(said)
}

/// R9: what origin has of a release — `git ls-remote origin` of its branch and
/// tag, bounded, never prompting, as the workspace's GitHub account (the
/// caller's scope). `(branch tip, tag present)`.
fn origin_has(repo_root: &Path, branch: &str, tag: &str) -> Result<(Option<String>, bool), String> {
    let (head, tag_ref) = (format!("refs/heads/{branch}"), format!("refs/tags/{tag}"));
    let mut cmd = crate::platform::git_command();
    crate::github_account::apply_to_network_git(&mut cmd, repo_root)?;
    cmd.args(["-c", "credential.interactive=never", "ls-remote", "origin", &head, &tag_ref])
        .current_dir(repo_root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("LC_ALL", "C");
    let out = crate::worktrees::run_bounded(&mut cmd, "git ls-remote origin", UNDO_LS_REMOTE_TIMEOUT)?;
    let mut tip = None;
    let mut tagged = false;
    let peeled = format!("{tag_ref}^{{}}");
    for (sha, name) in out.lines().filter_map(|l| l.split_once('\t')) {
        let name = name.trim();
        if name == head {
            tip = Some(sha.trim().to_string());
        } else if name == tag_ref || name == peeled {
            tagged = true;
        }
    }
    Ok((tip, tagged))
}

const UNDO_LS_REMOTE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// R9: *Undo the local release* — for a release whose branch push GitHub
/// refused as protected ([`PendingReleaseView::undo`]). Only when origin has
/// neither its tag nor its commit (`git ls-remote`, checked now), the local
/// target is still at the release commit and the project folder has no
/// tracked changes: the target goes back to the commit the release began on
/// (`git reset --keep`), the local tag is deleted and the record cleared, so
/// Land works again. The cards keep their own copies and branches; a legacy
/// card's change lives only in the release commit, so its release is never
/// undone. Refused while a release or land of the workspace runs. Returns
/// what was done, in words.
///
/// [`PendingReleaseView::undo`]: crate::release_record::PendingReleaseView::undo
pub(crate) fn undo_local_release<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    ship_registry: &ShipRegistry,
    workspaces: &WorkspaceStore,
    project_config: &ProjectConfigStore,
    kanban: &KanbanStore,
    workspace_id: &str,
) -> Result<String, String> {
    let _guard = ship_registry
        .try_acquire(workspace_id)
        .ok_or_else(|| SHIP_BUSY.to_string())?;
    let snap = workspaces.snapshot();
    let ws = snap
        .workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| format!("workspace not found: {workspace_id}"))?;
    let ws_dir = project_config.workspace_dir(workspace_id);
    let record = live_record(&ws_dir, kanban, workspace_id)?
        .ok_or_else(|| "There is no unpublished release to undo. Nothing was changed.".to_string())?;
    let repo_root = resolve_workspace_repo_root(&ws.cwd)?;
    // The integration lock first (nothing lands on the branch meanwhile);
    // CARD_START_LOCK and the fast-forward lock (the release's order) only
    // after the network check, so card starts and fast-forwards never wait
    // on `git ls-remote` (Challenger minor).
    let integration = crate::shared_config::integration_lock(Path::new(&ws.cwd), &record.branch);
    let _integration = integration.lock().unwrap_or_else(|p| p.into_inner());

    let view = crate::release_record::view(&repo_root, record);
    let record = &view.record;
    let (tag, branch) = (record.tag.as_str(), record.branch.as_str());
    let refused = |why: String| Err(format!("Plyloft can't undo {tag}: {why} Nothing was changed."));
    if !view.undo {
        return refused(format!(
            "it can be undone here only when GitHub refused {branch} as protected and nothing was pushed."
        ));
    }
    // R9 (Challenger MAJOR): a 1.169.0 record has no start commit; the
    // release commit's one parent stands in (`undo_start`).
    let Some(start) = crate::release_record::undo_start(&repo_root, record) else {
        return refused("its record doesn't say where the release began.".into());
    };
    let start = start.as_str();
    let cards = kanban.load(workspace_id).unwrap_or_default();
    if let Some(legacy) = cards
        .iter()
        .find(|c| record.card_ids.contains(&c.id) && works_in_the_checkout(c))
    {
        return refused(format!(
            "`{}` has no copy of its own, so its change exists only in the release commit.",
            legacy.title
        ));
    }
    let local_checks = || -> Result<(), String> {
        if current_branch(&repo_root)? != branch {
            return Err(format!("the project folder isn't on {branch}."));
        }
        if resolve_commit(&repo_root, &format!("refs/heads/{branch}")).as_deref() != Some(record.commit_sha.as_str()) {
            return Err(format!("{branch} has moved on from the release commit since it was made."));
        }
        if start == record.commit_sha
            || git_run(&repo_root, &["merge-base", "--is-ancestor", start, &record.commit_sha]).is_err()
        {
            return Err(format!("the commit it began on ({start}) is not under it."));
        }
        if let Err(e) = crate::commands::require_clean_target(&repo_root) {
            return Err(format!("the project folder has changes that aren't committed ({e})."));
        }
        Ok(())
    };
    if let Err(why) = local_checks() {
        return refused(why);
    }
    // Checked now, not as the record remembers it: a push by hand since.
    let github = crate::github_account::enter_for_app(app, workspace_id);
    let origin = origin_has(&repo_root, branch, tag);
    drop(github);
    match origin {
        Err(e) => return refused(format!("Plyloft couldn't check what GitHub has ({e}).")),
        Ok((_, true)) => return refused(format!("{tag} is on GitHub already.")),
        Ok((Some(tip), _))
            if tip == record.commit_sha
                || git_run(&repo_root, &["merge-base", "--is-ancestor", &record.commit_sha, &tip]).is_ok() =>
        {
            return refused(format!("GitHub's {branch} has the release commit already."));
        }
        Ok(_) => {}
    }
    let _start = crate::commands::CARD_START_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let _fast_forward = crate::worktrees::hold_fast_forward(Path::new(&ws.cwd));
    // The folder again, under the locks (the network check took time).
    if let Err(why) = local_checks() {
        return refused(why);
    }
    let short = &start[..start.len().min(8)];
    if let Err(e) = git_run(&repo_root, &["reset", "--keep", "--quiet", start]) {
        // Challenger minor: what the failed reset left is read, not assumed.
        let now = resolve_commit(&repo_root, &format!("refs/heads/{branch}"));
        if now.as_deref() != Some(start) {
            return Err(match now {
                Some(sha) if sha == record.commit_sha => {
                    format!("Plyloft can't undo {tag}: {e} Nothing was changed.")
                }
                Some(sha) => format!(
                    "Plyloft couldn't finish undoing {tag}: {e} {branch} is now at {}, neither the \
                     release nor where it began; the tag {tag} and the record are kept. Look at \
                     `git status` and `git log` before you change anything.",
                    &sha[..sha.len().min(8)]
                ),
                None => format!(
                    "Plyloft couldn't finish undoing {tag}: {e} {branch} can't be read now; the tag \
                     {tag} and the record are kept. Look at `git status` before you change anything."
                ),
            });
        }
        log::warn!("ship: undo of {tag}: reset reported {e}, but {branch} is at {short}; going on");
    }
    let tag_gone = git_run(&repo_root, &["tag", "-d", tag]);
    crate::release_record::clear(&ws_dir)?;
    announce_record(app, workspace_id);
    Ok(match tag_gone {
        Ok(()) => format!(
            "Undid {tag}: {branch} is back at {short}, where the release began, and the tag {tag} \
             is deleted on {THIS_MACHINE}. The cards are as they were before the release."
        ),
        Err(e) => format!(
            "Undid {tag}: {branch} is back at {short}, where the release began, but the tag {tag} \
             couldn't be deleted ({e}); delete it with `git tag -d {tag}`."
        ),
    })
}

/// GH #222 review 1 (m3): the local half of a release — squash-merge, version
/// write, stage, commit, tag — in flight. A quit waits for it (bounded,
/// [`EXIT_WAIT_FOR_RELEASE`]) so Ply never exits between a merge and its
/// commit; once the quit has begun none starts. The pushes after it are not
/// waited for: exit kills them (`FETCHES`), and the next Ship publishes the
/// release ([`pending_release`]).
pub(crate) struct LocalPhases {
    state: std::sync::Mutex<LocalPhaseState>,
    idle: std::sync::Condvar,
}

struct LocalPhaseState {
    quitting: bool,
    active: usize,
}

pub(crate) static LOCAL_PHASES: LocalPhases = LocalPhases::new();

/// How long a quit waits for a release's local half to reach its tag.
pub const EXIT_WAIT_FOR_RELEASE: std::time::Duration = std::time::Duration::from_secs(10);

/// One release's local half; ends on drop.
pub(crate) struct LocalPhase<'a> {
    phases: &'a LocalPhases,
}

impl LocalPhases {
    pub(crate) const fn new() -> Self {
        Self {
            state: std::sync::Mutex::new(LocalPhaseState { quitting: false, active: 0 }),
            idle: std::sync::Condvar::new(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, LocalPhaseState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Begin a release's local half, or refuse once a quit has begun.
    pub(crate) fn begin(&self) -> Result<LocalPhase<'_>, String> {
        let mut state = self.lock();
        if state.quitting {
            return Err("ship aborted: Plyloft is quitting. Nothing was merged, committed or tagged."
                .to_string());
        }
        state.active += 1;
        Ok(LocalPhase { phases: self })
    }

    /// Refuse every later release and wait up to `timeout` for the ones in
    /// flight to reach their tag. Returns how many were still running.
    pub(crate) fn finish_before_exit(&self, timeout: std::time::Duration) -> usize {
        let mut state = self.lock();
        state.quitting = true;
        let (state, _) = self
            .idle
            .wait_timeout_while(state, timeout, |s| s.active > 0)
            .unwrap_or_else(|p| p.into_inner());
        state.active
    }
}

impl Drop for LocalPhase<'_> {
    fn drop(&mut self) {
        let mut state = self.phases.lock();
        state.active -= 1;
        if state.active == 0 {
            self.phases.idle.notify_all();
        }
    }
}

/// App exit: see [`LocalPhases`]. Returns how many releases were still in
/// their local half when the wait ended.
pub fn finish_releases_before_exit() -> usize {
    LOCAL_PHASES.finish_before_exit(EXIT_WAIT_FOR_RELEASE)
}

/// Where a detached install script's output goes: `/tmp/atelier-build.log`
/// on the Mac, as the install messages have always said; the user's temp
/// directory on Windows, which has no `/tmp`.
fn build_log_path() -> PathBuf {
    #[cfg(unix)]
    {
        PathBuf::from("/tmp/atelier-build.log")
    }
    #[cfg(windows)]
    {
        std::env::temp_dir().join("atelier-build.log")
    }
}

/// Why Plyloft's own install can't run on Windows.
pub(crate) const SELF_INSTALL_MACOS_ONLY: &str =
    "Installing Plyloft from source is macOS-only for now: its install script builds and installs \
     Plyloft.app. Nothing was changed. Ship the card as a pull request instead, or remove \
     install_script from this project's settings to release by commit and tag.";

/// Plyloft's own install script: `install-local.sh` in a checkout of Plyloft
/// itself (`package.json` beside a `src-tauri/tauri.conf.json` whose
/// identifier is Plyloft's). It builds Plyloft.app, quits Plyloft and
/// installs into /Applications.
pub(crate) fn is_self_install(repo_root: &Path, rel_script: &str) -> bool {
    let identifier = || {
        let text = std::fs::read_to_string(repo_root.join("src-tauri").join("tauri.conf.json")).ok()?;
        let conf: serde_json::Value = serde_json::from_str(&text).ok()?;
        conf.get("identifier")?.as_str().map(str::to_owned)
    };
    Path::new(rel_script).file_name() == Some(std::ffi::OsStr::new("install-local.sh"))
        && repo_root.join("package.json").is_file()
        && identifier().as_deref() == Some("com.mbadv.ply")
}

/// Refuses, before anything is committed or merged, a ship that would end in
/// Ply's own install on a platform where that install can't run (Windows).
/// Always Ok on the Mac.
pub(crate) fn refuse_self_install(repo_root: &Path, install_script: Option<&str>) -> Result<(), String> {
    match install_script {
        Some(script) if cfg!(windows) && is_self_install(repo_root, script) => {
            Err(SELF_INSTALL_MACOS_ONLY.to_string())
        }
        _ => Ok(()),
    }
}

/// Spawn a project's install / go-live script detached (`nohup … &`), so
/// the build survives this process being killed and relaunched. Shared by
/// the release gate (`ship_card` / `ship_batch`) and the Outcome screen's
/// "Ship it = merge + go live" (`commands::card_ship`). `rel_script` is
/// workspace-relative; output goes to [`build_log_path`]. On Windows the
/// script runs with Git Bash, and Ply's own install is refused.
pub fn spawn_install_script(repo_root: &Path, rel_script: &str) -> Result<(), String> {
    refuse_self_install(repo_root, Some(rel_script))?;
    let script_path = repo_root.join(rel_script);
    if !script_path.is_file() {
        return Err(format!("install_script {} not found", script_path.display()));
    }
    // Bash reads `C:\...` as escapes; forward slashes work in Git Bash.
    let as_bash = |p: &Path| {
        let p = p.to_string_lossy();
        if cfg!(windows) { p.replace('\\', "/") } else { p.into_owned() }
    };
    // The Mac's log path needs no quoting; a Windows temp dir may have spaces.
    let log = as_bash(&build_log_path());
    let log = if cfg!(windows) { shell_escape(&log) } else { log };
    let env = crate::shell_env::get();
    // The detached script gets the same Git Bash on Windows, not one from PATH.
    let nohup_cmd = format!(
        "nohup {} {} </dev/null >{log} 2>&1 &",
        crate::shell_env::bash_word(&env.path),
        shell_escape(&as_bash(&script_path))
    );
    let bash = crate::shell_env::bash_program(&env.path).ok_or_else(|| {
        format!("{rel_script} needs Git Bash on Windows — install Git for Windows (git-scm.com)")
    })?;
    let mut command = crate::platform::new_command(bash);
    command
        .arg("-c")
        .arg(&nohup_cmd)
        .current_dir(repo_root)
        .env("PATH", &env.path);
    let status = command.status().map_err(|e| format!("spawn {rel_script}: {e}"))?;
    if !status.success() {
        return Err(format!("failed to spawn {rel_script}"));
    }
    Ok(())
}

/// Minimal shell-escape for paths embedded in `bash -c` strings.
/// Wraps in single quotes and escapes any internal single quote.
fn shell_escape(s: &str) -> String {
    let escaped = s.replace('\'', "'\\''");
    format!("'{}'", escaped)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipBatchRequest {
    pub workspace_id: String,
    pub card_ids: Vec<String>,
    pub release_kind: ReleaseKind,
    pub version: String,
}

/// v1.13.x (Phase E): batch ship.
///
/// Combines the working-tree changes of N verified-unshipped cards into
/// ONE commit + ONE tag, populating each card's `shipHistory` with the
/// same commit/version.
///
/// R7: here the combined tree is **not** verified as a whole. Each card's
/// Verify ran in its own worktree, on that card's change alone. On GitHub
/// (G9, 1.170.0) the batch is one integration pull request instead
/// (`release_pr`): one commit per card on a release branch from GitHub's
/// target, the Verify scripts run on them together, one pull request, one
/// merge, one tag. Off GitHub what a batch guarantees is only git's: the
/// cards merge without a conflict, each onto the ones before it.
///
/// Restrictions:
///   * All cards must be in the same workspace (Phase E scope; cross-
///     workspace batching is out of scope).
///   * All cards must be `verify_status: Passed | Legacy | Skipped` and
///     `ship_status: Unshipped`.
///   * Branch must be `main`.
pub fn ship_batch<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    req: ShipBatchRequest,
    workspaces: &WorkspaceStore,
    kanban: &KanbanStore,
    ship_registry: &ShipRegistry,
    project_config: &ProjectConfigStore,
    // GH #104: the Challenger's records, the discussions and the coordination
    // snapshot were read here only to seal the retired post-ship lesson's
    // evidence envelope. Kept in the signature as unused: Ship's callers are
    // many and its argument list is already long, and a later card that needs
    // them back should not have to thread them again.
    _reviewers: &ReviewerRegistry,
    _discussions: &DiscussionRegistry,
    _coordination: &CoordinationRegistry,
) -> Result<ShipResult, ShipError> {
    if req.card_ids.is_empty() {
        let _guard = ship_registry
            .try_acquire(&req.workspace_id)
            .ok_or_else(|| SHIP_BUSY.to_string())?;
        return Err("ship_batch requires at least one card_id".to_string().into());
    }
    release_cards(
        app,
        ReleaseRun {
            workspace_id: req.workspace_id,
            card_ids: req.card_ids,
            release_kind: req.release_kind,
            version: req.version,
            skip_verify: false,
            area: None,
            facts: ReleaseFacts::default(),
            sync_local: false,
        },
        workspaces,
        kanban,
        ship_registry,
        project_config,
    )
}

/// 1.174.0 (DR2, D1(b)): what a release carries besides the cards it merges
/// (`release_scope`): the cards already on the target since the area's last
/// tag, that tag, and how many other changes. Recorded on the release.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ReleaseFacts {
    pub merged_card_ids: Vec<String>,
    pub since_tag: Option<String>,
    pub other_changes: u32,
}

impl ReleaseFacts {
    /// From the area's scope, less the cards the release merges itself.
    pub(crate) fn of(scope: &crate::release_scope::ReleaseScope, ticked: &[String]) -> Self {
        let mut merged: Vec<String> = Vec::new();
        for card in &scope.cards {
            if !ticked.contains(&card.card_id) && !merged.contains(&card.card_id) {
                merged.push(card.card_id.clone());
            }
        }
        Self {
            merged_card_ids: merged,
            since_tag: scope.since_tag.clone(),
            other_changes: u32::try_from(scope.other_total).unwrap_or(u32::MAX),
        }
    }

    pub(crate) fn stamp(&self, record: &mut crate::release_record::PendingRelease) {
        record.merged_card_ids = self.merged_card_ids.clone();
        record.since_tag = self.since_tag.clone();
        record.other_changes = self.other_changes;
    }
}

/// One release press: Ship batch's, or (1.174.0) Release Site…'s.
pub(crate) struct ReleaseRun {
    pub workspace_id: String,
    /// The cards it merges, in order; none for a release of what is on the
    /// target already (Release Site… only).
    pub card_ids: Vec<String>,
    pub release_kind: ReleaseKind,
    pub version: String,
    /// Released without checks: the tag carries `-unverified`.
    pub skip_verify: bool,
    /// `Some`: the area asked for (`None` inside: the workspace's); the
    /// cards must be of it. `None`: the cards' own area (Ship batch).
    pub area: Option<Option<String>>,
    pub facts: ReleaseFacts,
    /// "On this Mac only" on a GitHub project first brings this computer's
    /// target up to GitHub's (`git fetch`, a fast-forward only).
    pub sync_local: bool,
}

/// 1.174.0 (DR2, D1(b)): **Release Site…** — a release of one area with zero
/// or more cards not on its target yet, carrying everything on the target
/// since the area's last tag (`release_scope`). The same release as Ship
/// batch's (`release_cards`): on GitHub one release pull request, built from
/// GitHub's target (with no card, its only commit is the version commit);
/// elsewhere the version commit and tag here. The cards already on the
/// target get a ship-history entry with its tag once it is done
/// (`mark_released`). It takes any number of ticked cards, on every plan.
pub fn release_area<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    req: ReleaseAreaRequest,
    workspaces: &WorkspaceStore,
    kanban: &KanbanStore,
    ship_registry: &ShipRegistry,
    project_config: &ProjectConfigStore,
) -> Result<ShipResult, ShipError> {
    // G2 walk (Mac): the press is stoppable from its first moment — its
    // flag is in place before the scope is read (a fetch of GitHub), and a
    // Stop pressed meanwhile is honored before anything is made.
    let press = PressStop::begin(&req.workspace_id);
    let scope = crate::release_scope::scope_for_app(app, &req.workspace_id, req.area_id.as_deref())?;
    if press.stopped() {
        let tag = crate::areas::tag_for(&scope.tag_prefix, &req.version);
        return Err(ShipError::stopped(&tag, &req.version, scope.through_github));
    }
    if let Some(refusal) = scope.refusal.clone() {
        return Err(refusal.into());
    }
    // DR3 round 1: a release recorded and not finished (its tag may be here
    // already, so the scope counts nothing new since it) is published or
    // taken on as it is: "nothing new" doesn't apply.
    let recorded = scope.in_flight.is_some()
        || live_record(&project_config.workspace_dir(&req.workspace_id), kanban, &req.workspace_id)
            .ok()
            .flatten()
            .is_some();
    // DR2 round 1: nothing ticked and nothing new since the last tag.
    if !recorded && req.card_ids.is_empty() && scope.cards_total == 0 && scope.other_total == 0 {
        return Err(nothing_new_words(&scope.target_branch, scope.since_tag.as_deref()).into());
    }
    let facts = ReleaseFacts::of(&scope, &req.card_ids);
    release_cards(
        app,
        ReleaseRun {
            workspace_id: req.workspace_id,
            card_ids: req.card_ids,
            release_kind: req.release_kind,
            version: req.version,
            skip_verify: req.skip_verify,
            area: Some(scope.area.clone()),
            facts,
            sync_local: true,
        },
        workspaces,
        kanban,
        ship_registry,
        project_config,
    )
}

/// DR2 round 1: a release with nothing ticked and nothing new to carry.
pub(crate) fn nothing_new_words(target: &str, since: Option<&str>) -> String {
    match since {
        Some(tag) => format!("Nothing new on {target} since {tag}"),
        None => format!("Nothing on {target} yet"),
    }
}

/// 1.174.0 (DR2): what **Release Site…** sends (`releaseArea`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseAreaRequest {
    pub workspace_id: String,
    /// The area's id; `None`: the workspace's (the first area's).
    #[serde(default)]
    pub area_id: Option<String>,
    /// The cards ready but not on the target yet that were ticked, in order.
    #[serde(default)]
    pub card_ids: Vec<String>,
    pub release_kind: ReleaseKind,
    pub version: String,
    #[serde(default)]
    pub skip_verify: bool,
}

/// The release of `req` (Ship batch's body, G9 and R6–R9; 1.174.0: with
/// zero or more cards).
fn release_cards<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    req: ReleaseRun,
    workspaces: &WorkspaceStore,
    kanban: &KanbanStore,
    ship_registry: &ShipRegistry,
    project_config: &ProjectConfigStore,
) -> Result<ShipResult, ShipError> {
    let _guard = ship_registry
        .try_acquire(&req.workspace_id)
        .ok_or_else(|| SHIP_BUSY.to_string())?;
    // 1.174.0 (DR2): Stop the release reaches this press through its flag.
    let press = PressStop::begin(&req.workspace_id);
    let mut req = req;
    // v1.13.x (Phase E), as `ship_card`: skip_verify ⇒ an `-unverified` tag.
    if req.skip_verify && !req.version.contains("-unverified") {
        req.version = format!("{}-unverified", req.version);
    }

    // v1.12.2 (Cycle C): per-workspace project_config drives
    // target_branch / version_files / install_script for batch ships
    // too. Atelier's bootstrap config produces identical behavior.
    // 1.173.0 (B4): one area at a time — every card's area must be the same
    // one, whose branch, version files and tags the batch uses.
    // 1.174.0 (DR2): Release Site… names its area; its cards must be of it.
    let shipping = {
        load_project_config_for(&req.workspace_id, workspaces, project_config)?;
        let board = kanban.load(&req.workspace_id)?;
        let picked: Vec<&KanbanCard> = req
            .card_ids
            .iter()
            .map(|id| board.iter().find(|c| c.id == *id).ok_or_else(|| format!("card not found: {id}")))
            .collect::<Result<_, _>>()?;
        let asked = match &req.area {
            Some(id) => Some(ship_area_for_id(project_config, &req.workspace_id, id.as_deref())?.ok_or_else(|| {
                load_project_config_for(&req.workspace_id, workspaces, project_config).err().unwrap_or_default()
            })?),
            None => None,
        };
        if picked.is_empty() {
            asked.ok_or_else(|| "ship_batch requires at least one card_id".to_string())?
        } else {
            let of_cards = batch_ship_area(&picked, |card| {
                load_ship_area_for_card(&req.workspace_id, card, workspaces, project_config)
            })?;
            if let Some(asked) = asked.filter(|a| a.id != of_cards.id) {
                let name = |a: &ShipArea| a.name.clone().unwrap_or_else(|| crate::card_area::WHOLE_REPOSITORY.to_string());
                return Err(mixed_areas_words(&[name(&asked), name(&of_cards)]).into());
            }
            of_cards
        }
    };
    let config = shipping.config.clone();

    let snap = workspaces.snapshot();
    let ws = snap
        .workspaces
        .iter()
        .find(|w| w.id == req.workspace_id)
        .ok_or_else(|| format!("workspace not found: {}", req.workspace_id))?;
    let repo_root = resolve_workspace_repo_root(&ws.cwd)?;
    refuse_self_install(&repo_root, config.install_script.as_deref())?;
    // G9 (1.170.0): on GitHub, the batch is one integration pull request —
    // `ship_card`'s release through a pull request with N cards.
    let pr_route = release_pr::route(&repo_root, req.release_kind).is_some();
    // GH #80: serialized with shared-config publishes onto the target branch.
    let integration =
        crate::shared_config::integration_lock(Path::new(&ws.cwd), &config.target_branch);
    let integration_held = integration.lock().unwrap_or_else(|p| p.into_inner());
    // GH #222 review 1 (m5), review 2: card starts, worktree deletes and Trash
    // wait until the release is committed and tagged, so a card's worktree
    // can't vanish between the checks below and its merge. The lock order is
    // integration → CARD_START_LOCK → fast-forward: no holder of
    // CARD_START_LOCK (a card start, delete, Trash, resume) ever waits on an
    // integration lock. Dropped with the fast-forward lock after the tag.
    let start = crate::commands::CARD_START_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    // GH #203 review 1: Ply's own fast-forwards (a reconcile, a Trash) wait
    // for this release's merge and commit; held to the end of the ship.
    let fast_forward = crate::worktrees::hold_fast_forward(Path::new(&ws.cwd));

    if !pr_route {
        let branch = current_branch(&repo_root)?;
        if branch != config.target_branch {
            return Err(format!(
                "ship aborted: current branch is `{branch}`. Ship lands on `{}`. Switch first or cancel.",
                config.target_branch
            ).into());
        }
    }
    // v1.33.0: read-only — the ship-state write below is one atomic board
    // write.
    let cards = kanban.load(&req.workspace_id)?;
    // GH #222 review 2: as in `ship_card`, before the fast-forward — exactly
    // these cards' unpublished release is published, not cut again.
    let ws_dir = project_config.workspace_dir(&req.workspace_id);
    // Review 3: any workspace's record on this repository and branch counts.
    if let Some(record) = blocking_record(
        workspaces,
        project_config,
        kanban,
        &req.workspace_id,
        Path::new(&ws.cwd),
        &config.target_branch,
    )? {
        let view = crate::release_record::view(&repo_root, record);
        resume_or_refuse(&view, &req.card_ids, &cards)?;
        // G9: as in `ship_card` — made again when left before it was built,
        // else taken on from its last step.
        if release_pr::unbuilt(&view.record) {
            release_pr::discard_unbuilt(&repo_root, &ws_dir, &view.record)?;
        } else {
            drop(fast_forward);
            drop(start);
            if view.record.pr.is_some() {
                drop(integration_held);
                return resume_through_pr(
                    app,
                    &ws_dir,
                    Path::new(&ws.cwd),
                    &repo_root,
                    &config,
                    kanban,
                    &req.workspace_id,
                    view.record,
                );
            }
            return publish_pending(
                app,
                &ws_dir,
                &repo_root,
                &config,
                kanban,
                &req.workspace_id,
                view.record,
                req.release_kind,
            );
        }
    }
    // R6: as in `ship_card` — a project folder with tracked changes is
    // refused before anything is merged, unless a legacy card's work is them.
    let legacy = req
        .card_ids
        .iter()
        .filter_map(|id| cards.iter().find(|c| c.id == *id))
        .any(works_in_the_checkout);
    if !pr_route {
        require_clean_unless_legacy(&repo_root, legacy)?;
    }
    // GH #80: a shared-config publish moves origin's branch without touching
    // this one; a release that pushes lands on origin's tip, or is refused
    // here before anything is merged, committed or tagged.
    // OB-7b: the release's fetch and pushes run as the workspace's GitHub
    // account (`finish_release` reuses this scope).
    let _github = crate::github_account::enter_for_app(app, &req.workspace_id);
    // R9's refusal of a protected target before anything changed is gone
    // (G8/G9): a GitHub project releases through a pull request.
    // 1.174.0 (DR2): "On this Mac only" on a GitHub project, from Release
    // Site…, brings this computer's target up to GitHub's first (a fetch and
    // a fast-forward only; nothing is sent to GitHub): both moved on is
    // refused, and so is a folder with changes (above).
    let sync_local = req.sync_local
        && matches!(req.release_kind, ReleaseKind::Local)
        && github_origin(&repo_root).is_some();
    let fast_forwarded = if sync_local {
        // DR2 round 1 (owner): offline, nothing is released.
        crate::shared_config::sync_before_local_release(&fast_forward, Path::new(&ws.cwd), &config.target_branch)?
    } else if !pr_route && matches!(req.release_kind, ReleaseKind::Github | ReleaseKind::PushOnly) {
        crate::shared_config::sync_before_release(
            &fast_forward,
            Path::new(&ws.cwd),
            &config.target_branch,
        )?
    } else {
        false
    };
    // G5 (Challenger 2): this computer has GitHub's target now.
    crate::after_merge::up_to_date_now(app, &req.workspace_id, fast_forwarded);
    // Validate each requested card.
    let mut card_titles = Vec::new();
    for card_id in &req.card_ids {
        let card = cards
            .iter()
            .find(|c| c.id == *card_id)
            .ok_or_else(|| format!("card not found: {card_id}"))?;
        match card.verify_status {
            VerifyStatus::Passed | VerifyStatus::Legacy | VerifyStatus::Skipped => {}
            other => {
                return Err(format!(
                    "ship_batch blocked: card `{}` has verify_status `{:?}` (must be Passed/Legacy/Skipped)",
                    card.title, other
                ).into());
            }
        }
        if matches!(card.ship_status, ShipStatus::Shipped) {
            return Err(format!(
                "ship_batch blocked: card `{}` is already shipped",
                card.title
            ).into());
        }
        // GH #242: its pull request merged — its work is already landed.
        if card.review_status == Some(crate::kanban::ReviewStatus::Merged) {
            return Err(format!(
                "ship_batch blocked: card `{}` already landed as a merged pull request",
                card.title
            ).into());
        }
        // UX P1 point 2 (P-A, Challenger): its last ship stopped on a
        // conflict — the batch count leaves it out
        // (`passes_pending_ship_metadata`), and a batch sent with it anyway
        // (a list read before the conflict) would only stop on it again.
        if card.review_status == Some(crate::kanban::ReviewStatus::ConflictBlocked) {
            // 1.170.0 (G6): a conflict met bringing in the target's changes,
            // not by a ship, says so.
            if let Some(conflict) = card.ship_conflict.as_ref().filter(|c| c.sync) {
                let branch = crate::ship_conflict::conflict_target(card, &conflict.branch);
                return Err(format!(
                    "ship_batch blocked: card `{}` has a conflict with {branch}; resolve it from its card (Fix with the Builder), then press Finish and check",
                    card.title
                ).into());
            }
            return Err(format!(
                "ship_batch blocked: card `{}` stopped on a conflict when it last shipped; ship it again from its card",
                card.title
            ).into());
        }
        // v1.154.1 (F11): its work is in a pull request still open on GitHub
        // (during a fix round the review loop may be writing `review_status`).
        if let Some(why) = open_pr_refusal("ship_batch", card) {
            return Err(why.into());
        }
        // GH #222 review 1 (m5): as in `ship_card`, said as what it is.
        if let Some(wt) = card.worktree_path.as_deref() {
            if !Path::new(wt).exists() {
                return Err(worktree_gone_message(&card.title, wt).into());
            }
        }
        if !card_has_worktree_changes_verified(card, &config.target_branch) {
            return Err(no_changes_to_ship_message(card, &config.target_branch).into());
        }
        // Checked for every card before any merge: a Builder card ships
        // only as its build snapshot, verified on that snapshot's content
        // unless the card was explicitly ship-skipped before.
        if let Some(why) = crate::pr_review::ship_refusal(card) {
            return Err(format!("ship_batch blocked: card `{}`: {why}", card.title).into());
        }
        // Skills hub H3a (Challenger): a skill card's Verify was *Not needed*
        // only for its skill-only commit, and its preflight (never override a
        // change on the target, refresh when the library moved) is Ship now's.
        if let Some(why) =
            crate::commands::skill_card_batch_refusal(app, workspaces, &config.target_branch, card)
        {
            return Err(format!("ship_batch blocked: card `{}`: {why}", card.title).into());
        }
        crate::builder::require_builder_worktree(card)
            .map_err(|e| format!("ship_batch blocked: card `{}`: {e}", card.title))?;
        // 1.171.0 F1: a Builder card out of Complete goes in only as the
        // list offers it — session closed, last round reviewed.
        if !matches!(card.column_id, KanbanColumnId::Complete) {
            if let Some(why) = batch_builder_refusal(card) {
                return Err(format!("ship_batch blocked: card `{}`: {why}", card.title).into());
            }
        }
        if card.builder.is_some() {
            if let Some(wt) = card.worktree_path.as_deref().map(PathBuf::from) {
                if wt.exists() {
                    let checked = if matches!(card.verify_status, VerifyStatus::Skipped) {
                        crate::builder::require_at_last_snapshot(card, &wt)
                    } else {
                        use tauri::Manager;
                        let in_flight = app
                            .state::<crate::verify::VerifyRegistry>()
                            .is_inflight(&req.workspace_id, &card.id);
                        crate::builder::require_verified_snapshot(card, &wt, in_flight)
                    };
                    checked
                        .map_err(|e| format!("ship_batch blocked: card `{}`: {e}", card.title))?;
                }
            }
        }
        card_titles.push(card.title.clone());
    }

    // Phase F, as `ship_card`: a release without checks is never published
    // with a release page.
    if req.skip_verify && matches!(req.release_kind, ReleaseKind::Github) {
        return Err(
            "github release blocked: skip-verify ships are local-only. Switch to a Local rebuild. \
             Nothing was merged, committed or tagged."
                .to_string()
                .into(),
        );
    }
    if !is_valid_version(&req.version) {
        return Err(format!("invalid version `{}`", req.version).into());
    }
    let batch_tag = shipping.tag(&req.version);
    if tag_exists(&repo_root, &batch_tag)? {
        return Err(format!("tag {batch_tag} already exists; pick a different version").into());
    }
    let batch_cards: Vec<&KanbanCard> = req
        .card_ids
        .iter()
        .filter_map(|id| cards.iter().find(|c| c.id == *id))
        .collect();
    if pr_route {
        // G9: one integration pull request, the cards in the order picked.
        if let Some(legacy) = batch_cards.iter().find(|c| works_in_the_checkout(c)) {
            return Err(release_pr::no_copy_words(&legacy.title).into());
        }
        drop(fast_forward);
        drop(integration_held);
        return ship_through_pr(
            app,
            project_config,
            &ws_dir,
            Path::new(&ws.cwd),
            &repo_root,
            &config,
            kanban,
            &req.workspace_id,
            batch_cards,
            req.version.clone(),
            req.release_kind,
            req.skip_verify,
            &shipping.prefix,
            req.facts.clone(),
            start,
        );
    }
    // GH #196: as in `ship_card`, refused before any card is merged.
    require_version_files_tracked(&repo_root, &config)?;
    require_legacy_cards_have_no_untracked(&repo_root, &batch_cards)?;

    // v1.10.3 (Cycle A — worktrees): squash-merge each card's branch
    // into main BEFORE the version bump, so the single batch commit
    // captures every card's worktree-resident changes. Iteration order
    // matches `req.card_ids`, which is also the order the user picked
    // them. R7: each card's squash is committed (a temporary commit) before
    // the next card is merged onto it, so two cards that touch one file merge
    // as git merges them; the same lines changed by both stop the later card
    // as a conflict with the earlier one. The temporaries fold into the one
    // release commit after the last card.
    // R6: still clean after the fetch; the folder to put back (`ship_card`).
    require_clean_unless_legacy(&repo_root, legacy)?;
    let on_github = github_origin(&repo_root).is_some();
    if press.stopped() {
        return Err(ShipError::stopped(&batch_tag, &req.version, on_github));
    }
    let folder = FolderStart::take(&repo_root, &config, legacy)?;
    // GH #222 review 1 (m3): from here to the tag, a quit waits for this
    // release (bounded); once Ply is quitting none begins.
    let local = LOCAL_PHASES.begin()?;
    // GH #222 review 3: recorded before anything is merged (see `ship_card`).
    let pre = PreRecord::arm(
        &ws_dir,
        pushes(req.release_kind),
        crate::release_record::PendingRelease {
            version: req.version.clone(),
            tag: batch_tag.clone(),
            commit_sha: String::new(),
            branch: config.target_branch.clone(),
            card_ids: req.card_ids.clone(),
            card_revs: Default::default(),
            release_kind: req.release_kind,
            skip_verify: req.skip_verify,
            stopped_at: None,
            cause: None,
            output: None,
            bound: None,
            created_at: now_millis(),
            stage: crate::release_record::RecordStage::Committing,
            // R7 (Challenger MAJOR 2): where the folder was, for the way back.
            start_commit: Some(folder.head.clone()),
            protected: false,
            tag_pushed: false,
            pr: None,
            merged_card_ids: req.facts.merged_card_ids.clone(),
            since_tag: req.facts.since_tag.clone(),
            other_changes: req.facts.other_changes,
            stop_requested: false,
        },
    )?;
    // R6: from the first squash to the tag, a stop puts the project folder
    // back as `folder` found it — every card's squash, not only the last.
    // Challenger m11: whether the folder was changed yet (a squash or the
    // version write began); m4: a panic is a stop too.
    let touched = std::cell::Cell::new(false);
    let made = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<_, ReleaseStop> {
        // GH #222 review 2: each worktree's merged commit (see `ship_card`).
        let mut card_revs = std::collections::BTreeMap::new();
        // R7: each card's squash so far, committed (`commit_batch_step`), with
        // the paths it changed — a later card's conflict on one of them is a
        // conflict between the two cards, not with the target.
        let mut steps: Vec<(String, Vec<String>)> = Vec::new();
        // R7 (Challenger MINOR 2): the last temporary commit, the one the
        // fold moves the branch back from.
        let mut last_step: Option<String> = None;
        for card_id in &req.card_ids {
            // 1.174.0 (DR2): Stop between cards — what was merged is put back.
            if press.stopped() {
                return Err(ReleaseStop::Failed(ShipError::stopped(&batch_tag, &req.version, on_github)));
            }
            let card = cards
                .iter()
                .find(|c| c.id == *card_id)
                .expect("validated above");
            let wt = card.worktree_path.clone();
            let branch = card.branch_name.clone();
            if let (Some(wt_path_str), Some(branch)) = (wt, branch) {
                let wt_path = PathBuf::from(&wt_path_str);
                if wt_path.exists() {
                    // A Builder card was checked at its snapshot above; commit
                    // nothing into its open session's tree.
                    if card.builder.is_none() {
                        let msg = crate::commit_message::wip_subject(&card.title);
                        commit_card_edits(&wt_path, &msg, &card.title)?;
                    }
                    // v1.31.0 (Phase 3): skip when already landed by card_ship.
                    let publish = crate::builder::publish_rev(card, &branch);
                    if let Some(rev) = resolve_commit(&repo_root, &publish) {
                        card_revs.insert(card_id.clone(), rev);
                    }
                    let already_merged = crate::worktrees::branch_is_merged_into(
                        &repo_root,
                        &publish,
                        &config.target_branch,
                    )
                    .unwrap_or(false);
                    if already_merged {
                        log::info!(
                            "ship_batch: branch {branch} already merged — skipping squash-merge"
                        );
                    } else {
                        touched.set(true);
                        crate::worktrees::squash_merge_into_workspace(
                            &repo_root,
                            &publish,
                            crate::commands::own_skill_base(card),
                        )
                            .map_err(|e| {
                                // R6: every card's squash so far is put back too.
                                squash_stop(&repo_root, card, &branch, &config.target_branch, e)
                                    .between_cards(&steps, || {
                                        merges_alone(
                                            &repo_root,
                                            &folder.head,
                                            &publish,
                                            crate::worktrees::own_base_used(
                                                &repo_root,
                                                crate::commands::own_skill_base(card),
                                                &publish,
                                            ),
                                        )
                                    })
                            })?;
                        // R7: committed before the next card is merged — git
                        // refuses a merge over a staged change.
                        if let Some((sha, paths)) = commit_batch_step(&repo_root, &card.title)? {
                            steps.push((card.title.clone(), paths));
                            last_step = Some(sha);
                        }
                    }
                } else {
                    // GH #222 review 1 (m5): checked above under CARD_START_LOCK;
                    // never a release without a card's change.
                    return Err(worktree_gone_message(&card.title, &wt_path_str).into());
                }
            }
        }

        // R7: the cards' temporary commits fold back into the index, so the
        // release is still one commit on the folder's starting commit.
        // R7 (Challenger MINOR 2): compare-and-swap — the branch moves back
        // only from the last temporary commit, never from a commit someone
        // else made on it meanwhile; the index is left as it is.
        if let Some(last) = &last_step {
            git_run(
                &repo_root,
                &["update-ref", "-m", "Plyloft: Ship batch, folded into the release", "HEAD", &folder.head, last],
            )?;
        }

        if press.stopped() {
            return Err(ReleaseStop::Failed(ShipError::stopped(&batch_tag, &req.version, on_github)));
        }
        touched.set(true);
        let wrote = write_versions_per_config(&repo_root, &config, &req.version);
        folder.note_written(&repo_root);
        #[cfg(test)]
        after_version_write();
        wrote?;

        // Single commit for the whole batch; its body lists every card title
        // for traceability.
        // GH #196: tracked changes only — never an untracked file in the checkout.
        // Walk fix (DR3 early walk): an area's first release at the version
        // its file says now stages nothing; its version commit is empty.
        let as_is = first_release_as_is(&repo_root, &shipping.prefix, &config, "HEAD", &req.version);
        match stage_release_commit(&repo_root, &config, &batch_tag, legacy) {
            Err(e) if as_is && e.starts_with("ship aborted: nothing to commit") => {}
            other => other?,
        }
        folder.require_staged_as_written(&repo_root)?;
        // R8 (owner): `chore(release): vX.Y.Z`, every card's title in the body.
        let mut commit_args: Vec<String> =
            vec!["-m".into(), crate::commit_message::release_tag_subject(&batch_tag)];
        // 1.174.0 (DR2): a release with no card of its own has no titles.
        if !card_titles.is_empty() {
            commit_args.extend(["-m".into(), crate::commit_message::release_body(&card_titles)]);
        }
        for card_id in &req.card_ids {
            commit_args.push("--trailer".into());
            commit_args.push(format!("Card: {card_id}"));
        }
        if as_is {
            commit_args.push("--allow-empty".into());
        }
        let args_ref: Vec<&str> = commit_args.iter().map(String::as_str).collect();
        // R8: as `ship_card`'s.
        crate::git::commit(&repo_root, &args_ref).map_err(|failure| failure.text())?;

        let commit_sha = git_capture(&repo_root, &["rev-parse", "HEAD"])?
            .trim()
            .to_string();
        let tag = batch_tag.clone();
        make_release_tag(&repo_root, &tag)?;
        Ok((card_revs, commit_sha, tag))
    }))
    .unwrap_or_else(|panic| Err(panic_stop(panic)));
    let (card_revs, commit_sha, tag) = match made {
        Ok(made) => made,
        Err(stop) => {
            return Err(roll_back_release(
                app,
                kanban,
                &req.workspace_id,
                &repo_root,
                &folder,
                &config.target_branch,
                &batch_tag,
                fast_forwarded,
                touched.get(),
                stop,
            ))
        }
    };
    // GH #222 review 2: the record, before the first push (see `ship_card`).
    let record = crate::release_record::PendingRelease {
        version: req.version.clone(),
        tag: tag.clone(),
        commit_sha: commit_sha.clone(),
        branch: config.target_branch.clone(),
        card_ids: req.card_ids.clone(),
        card_revs,
        release_kind: req.release_kind,
        skip_verify: req.skip_verify,
        stopped_at: None,
        cause: None,
        output: None,
        bound: None,
        created_at: now_millis(),
        stage: crate::release_record::RecordStage::Tagged,
        start_commit: Some(folder.head.clone()),
        protected: false,
        tag_pushed: false,
        pr: None,
        merged_card_ids: req.facts.merged_card_ids.clone(),
        since_tag: req.facts.since_tag.clone(),
        other_changes: req.facts.other_changes,
        stop_requested: false,
    };
    // Review 3: the tag exists; from here the record is kept whatever
    // happens (a failed write below leaves it at `Committing`, which the
    // window offers to dismiss).
    pre.disarm();
    // R6 (Challenger m3): the tag exists — a conflict an earlier ship of
    // these cards stopped on is over (`finish_release` clears it again).
    clear_shipped_conflicts(kanban, &req.workspace_id, &cards, &record.card_ids);
    if pushes(req.release_kind) {
        save_record(app, &ws_dir, &req.workspace_id, &record)?;
    }
    // GH #203 review 2: merge, commit and tag are done; the pushes below may
    // take minutes (GH #222: `SHIP_PUSH_TIMEOUT`), so Ply's own fast-forwards
    // (and a Trash queued behind them with CARD_START_LOCK) never wait on the
    // network here.
    drop(fast_forward);
    drop(start);
    drop(local);

    // Push, put the worktrees away, mark every card shipped in one board
    // write, clear the record (GH #222) — before kicking install-local.
    let kept = finish_release(app, &ws_dir, &repo_root, &config, kanban, &req.workspace_id, record)?;

    // v1.12.2 (Cycle C): per-project install_script. Same model as
    // ship_card — None means commit + tag is the entire ship, no
    // build/install step. Atelier's config supplies the legacy
    // scripts/install-local.sh so behavior is identical for the
    // Atelier workspace.
    let install_log = if let Some(held) = install_held(project_config, &req.workspace_id, &batch_tag, config.install_script.as_deref()) {
        held
    } else if let Some(rel_script) = config.install_script.as_deref() {
        spawn_install_script(&repo_root, rel_script).map_err(|e| {
            format!(
                "ship aborted: {e} (commit + tag created — fix the path or \
                 remove install_script from config, then re-ship)"
            )
        })?;
        format!(
            "Batch ship: build started in background ({} card(s); {rel_script}). \
             Tail /tmp/atelier-build.log; Atelier will quit and relaunch as {} once the build completes.",
            req.card_ids.len(),
            batch_tag
        )
    } else {
        format!(
            "Batch ship {}: commit + tag created ({} card(s)). No install_script in this project's config; nothing to rebuild.",
            batch_tag,
            req.card_ids.len()
        )
    };

    let (install_script, relaunches) = install_outcome(&repo_root, &config);
    Ok(ShipResult {
        commit_sha,
        shipped_version: req.version,
        release_kind: req.release_kind,
        install_log: with_kept(install_log, &kept),
        fast_forwarded,
        install_script,
        relaunches,
        release_pr: None,
        tag: Some(batch_tag),
    })
}

/// v1.13.x (Phase E): how many shipped-but-unverified cards exist across
/// all workspaces. Drives the toolbar's red `unverified` badge so the
/// cost of skip-verify is visible. Counted by ShipEntry whose version
/// carries the `-unverified` suffix.
pub fn unverified_ship_count(kanban: &KanbanStore, workspace_ids: &[String]) -> usize {
    let mut total = 0usize;
    for ws in workspace_ids {
        if let Ok(cards) = kanban.load(ws) {
            for c in cards {
                for entry in &c.ship_history {
                    if entry.shipped_version.contains("-unverified") {
                        total += 1;
                        break; // Don't double-count a re-intaken card.
                    }
                }
            }
        }
    }
    total
}

/// GH #196: stage the release commit — tracked changes only.
///
/// What a release commit holds: the squash-merge(s), which `git merge
/// --squash` has already staged (new files included, so they are tracked by
/// now); the version writes, which land in tracked files
/// (`require_version_files_tracked`; the Cargo.lock sync only rewrites an
/// existing lock); and, as before, any uncommitted edit to a tracked file in
/// the checkout — a legacy card's work is exactly that. `git add -u` stages
/// all of those and never an untracked path. It was `git add -A`, which also
/// committed, tagged and pushed every untracked file sitting in the checkout
/// (notes, a local skill copy) — and since GH #190 a Land goes through beside
/// such files, so they are there at release time.
///
/// R6: stated, not swept. The squash is already staged; what is added here
/// is only what the release wrote — the declared version files and the
/// Cargo.lock beside a declared Cargo.toml, those git tracks — so an edit of
/// the member's own is never in a release. None can be there: a release
/// starts only from a clean project folder (`require_clean_unless_legacy`).
/// The one exception is a legacy card (`works_in_the_checkout`), whose work
/// *is* the checkout's tracked edits: with one in the release, `git add -u`
/// stages them all, as before.
///
/// Nothing staged is an error, not an empty commit.
fn stage_release_commit(
    repo_root: &Path,
    config: &ProjectConfig,
    // 1.173.0 (B4): the release's tag (`areas::tag_for`), for the words.
    tag: &str,
    legacy: bool,
) -> Result<(), String> {
    if legacy {
        git_run(repo_root, &["add", "-u"])?;
    } else {
        let written = tracked_release_paths(repo_root, config)?;
        if !written.is_empty() {
            let mut args = vec!["add".to_string(), "-u".to_string(), "--".to_string()];
            args.extend(written.iter().map(|p| format!(":(literal){p}")));
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            git_run(repo_root, &args)?;
        }
    }
    let staged = crate::platform::git_command()
        .args(["diff", "--cached", "--quiet"])
        .current_dir(repo_root)
        .status()
        .map_err(|e| format!("spawn git diff --cached: {e}"))?;
    match staged.code() {
        Some(1) => Ok(()),
        Some(0) => Err(format!(
            "ship aborted: nothing to commit for {tag} — no card change and no version file \
             change is staged (untracked files are never part of a release). Nothing was \
             committed or tagged."
        )),
        _ => Err("git diff --cached failed while staging the release".to_string()),
    }
}

/// R6: the files a release's version write may change — every declared
/// version file and the Cargo.lock beside each declared Cargo.toml
/// (`sync_cargo_lock_at`) — as far as git tracks them (`git add -u` refuses a
/// path it doesn't know). `/`-separated, relative to the repository.
fn tracked_release_paths(repo_root: &Path, config: &ProjectConfig) -> Result<Vec<String>, String> {
    let mut paths: Vec<String> = Vec::new();
    for entry in &config.version_files {
        let path = entry.path.replace('\\', "/");
        if matches!(entry.kind, VersionFileKind::CargoToml) {
            let lock = match path.rsplit_once('/') {
                Some((dir, _)) => format!("{dir}/Cargo.lock"),
                None => "Cargo.lock".to_string(),
            };
            paths.push(lock);
        }
        paths.push(path);
    }
    paths.sort();
    paths.dedup();
    if paths.is_empty() {
        return Ok(paths);
    }
    let mut args = vec!["ls-files".to_string(), "-z".to_string(), "--".to_string()];
    args.extend(paths.iter().map(|p| format!(":(literal){p}")));
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let tracked = git_capture(repo_root, &args)?;
    Ok(tracked.split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect())
}

/// R6: what the end of a release that stopped says when the project folder
/// was put back (`cardPage.ts` reads it).
pub(crate) const ROLLED_BACK_WORDS: &str =
    "Nothing was released, and your project folder is as it was.";

/// R6: Ship's refusal of a project folder with tracked changes — Land's own
/// (`require_clean_target`, the typed target-dirty error), before anything is
/// merged, because the rollback below is `git reset --hard`. Not with a
/// legacy card in the release: its work is those changes.
fn require_clean_unless_legacy(repo_root: &Path, legacy: bool) -> Result<(), String> {
    if legacy {
        return Ok(());
    }
    crate::commands::require_clean_target(repo_root)
}

/// R6 (Challenger m3): the cards of a release that is tagged no longer read
/// as stopped on a conflict, even if a push after the tag stops.
fn clear_shipped_conflicts(kanban: &KanbanStore, workspace_id: &str, cards: &[KanbanCard], ids: &[String]) {
    let blocked = cards.iter().any(|c| {
        ids.contains(&c.id) && c.review_status == Some(crate::kanban::ReviewStatus::ConflictBlocked)
    });
    if !blocked {
        return;
    }
    let cleared = kanban.with_cards_saved(workspace_id, ids, |card| {
        if card.review_status == Some(crate::kanban::ReviewStatus::ConflictBlocked) {
            card.review_status = None;
            card.ship_conflict = None;
        }
        Ok(())
    });
    if let Err(e) = cleared {
        log::warn!("ship: couldn't clear the released cards' conflict: {e}");
    }
}

/// R6 (Challenger M2): the stash entry that keeps what was saved in the
/// project folder while a release that stopped was running.
pub(crate) const KEPT_EDITS_STASH: &str = "Plyloft: changes made while the release ran";
/// R6 (Challenger m5): the stash entry that keeps a legacy card's changes
/// when the folder couldn't be put back.
pub(crate) const LEGACY_EDITS_STASH: &str = "Plyloft: the legacy card's changes before the release";
/// R6: what a ship's Builder sentence says when the conflicting card has a
/// Builder (`cardPage.ts::releaseConflict` / `shipBatchFailure` read it).
// 1.175.0 F8: the press is "Fix with the Builder" (`shipConflict.ts`).
pub(crate) const ASK_BUILDER_WORDS: &str = "Open the card and press Fix with the Builder.";

/// R6: the project folder as the press found it, taken right before the
/// first squash, so any stop up to the tag puts it back.
struct FolderStart {
    head: String,
    /// A legacy release's tracked edits (index and working tree), as
    /// `git stash create` keeps them — nothing in the folder is touched to
    /// take it; `None` for a clean folder.
    edits: Option<String>,
    /// The files the release's version write changes (`tracked_release_paths`).
    release_paths: Vec<String>,
    /// R6 round 2 (Challenger MAJOR 1): what the version write left in each of
    /// `release_paths` (path, blob), recorded right after it. A release path
    /// is the release's own only while it still holds that blob; any other
    /// difference there is the member's.
    written: std::cell::RefCell<Vec<(String, String)>>,
}

/// What putting the folder back did besides that.
#[derive(Default)]
struct PutBack {
    /// Changes saved while the release ran went to the stash list
    /// ([`KEPT_EDITS_STASH`]).
    kept_edits: bool,
}

impl FolderStart {
    fn take(repo_root: &Path, config: &ProjectConfig, legacy: bool) -> Result<Self, String> {
        let head = git_capture(repo_root, &["rev-parse", "--verify", "HEAD"])
            .map_err(|e| format!("ship aborted: couldn't read the project folder's commit ({e}). Nothing was merged, committed or tagged."))?
            .trim()
            .to_string();
        let edits = if legacy {
            let sha = git_capture(repo_root, &["stash", "create"])
                .map_err(|e| format!("ship aborted: couldn't keep a copy of the project folder's changes ({e}). Nothing was merged, committed or tagged."))?;
            Some(sha.trim().to_string()).filter(|s| !s.is_empty())
        } else {
            None
        };
        let release_paths = tracked_release_paths(repo_root, config).unwrap_or_default();
        Ok(Self { head, edits, release_paths, written: Default::default() })
    }

    /// Back to the start: the tag, only one this release made (the tag was
    /// checked absent before; still, a tag is deleted only when it names a
    /// commit made on top of the start — Challenger m1); what was saved in
    /// the folder while the release ran, into the stash list (M2); then the
    /// commit, index and files (`reset --hard` also ends a stopped squash or
    /// pick); then a legacy release's own edits. Untracked files are never
    /// touched.
    fn put_back(&self, repo_root: &Path, tag: &str) -> Result<PutBack, String> {
        if let Some(tagged) = resolve_commit(repo_root, &format!("refs/tags/{tag}^{{commit}}")) {
            let made_here = tagged != self.head
                && git_run(repo_root, &["merge-base", "--is-ancestor", &self.head, &tagged]).is_ok();
            if made_here {
                git_run(repo_root, &["tag", "-d", tag])?;
            }
        }
        let kept_edits = self.keep_edits_made_meanwhile(repo_root)?;
        git_run(repo_root, &["reset", "--hard", "--quiet", &self.head])?;
        if let Some(edits) = &self.edits {
            git_run(repo_root, &["stash", "apply", "--index", "--quiet", edits])?;
        }
        Ok(PutBack { kept_edits })
    }

    /// R6 round 2 (Challenger MAJOR 1): record what the version write left
    /// in each release path — called right after it, whether or not it
    /// finished (a partial write is the release's own too).
    fn note_written(&self, repo_root: &Path) {
        let written = self
            .release_paths
            .iter()
            .filter_map(|p| worktree_blob(repo_root, p).map(|blob| (p.clone(), blob)))
            .collect();
        *self.written.borrow_mut() = written;
    }

    /// Whether `path` is a release path still as the version write left it.
    fn is_release_write(&self, repo_root: &Path, path: &str) -> bool {
        let written = self.written.borrow();
        let Some((_, blob)) = written.iter().find(|(p, _)| p == path) else {
            return false;
        };
        worktree_blob(repo_root, path).as_deref() == Some(blob.as_str())
    }

    /// R6 round 2 (Challenger MINOR 2): after the release is staged, each
    /// version file staged is what the release wrote — an edit saved in one
    /// meanwhile is never swept into the release; the release stops instead
    /// (and the edit is kept, `keep_edits_made_meanwhile`).
    ///
    /// R7 (Challenger MAJOR 1): read as "the file's bytes are still the ones
    /// written, and the index holds the file" — never by comparing a blob
    /// with the index's: under `core.autocrlf` git stages a file whose index
    /// copy already has CRs as it is, so the two blobs differ for a file
    /// nobody touched.
    fn require_staged_as_written(&self, repo_root: &Path) -> Result<(), String> {
        for (path, _) in self.written.borrow().iter() {
            let as_written = self.is_release_write(repo_root, path);
            let staged = as_written
                && git_run(repo_root, &["diff", "--quiet", "--", &format!(":(literal){path}")]).is_ok();
            if !staged {
                return Err(format!("A version file ({path}) changed while the release ran."));
            }
        }
        Ok(())
    }

    /// R6 (Challenger M2): a file saved in the folder while the release ran
    /// (an editor's save, a hook that writes) is a working-tree difference
    /// from the index the release staged. Not the release's own: a release
    /// path still as the version write left it (round 2, MAJOR 1: an edit of
    /// a version file is the member's), a conflict's marked files, and, for a
    /// legacy release, a file still as it was at the start. Those files alone
    /// go to the stash list before the reset (round 2, MAJOR 2: built on a
    /// temporary index, so it holds only them and works with a conflict under
    /// way).
    fn keep_edits_made_meanwhile(&self, repo_root: &Path) -> Result<bool, String> {
        let changed = git_capture(repo_root, &["diff", "--name-only", "-z"])?;
        let unmerged = git_capture(repo_root, &["diff", "--name-only", "-z", "--diff-filter=U"])?;
        let unmerged: Vec<&str> = unmerged.split('\0').filter(|p| !p.is_empty()).collect();
        // A version file changed after the write and staged since (the
        // release's own `git add`) matches the index: it is a candidate too.
        let restaged: Vec<String> = self
            .written
            .borrow()
            .iter()
            .map(|(p, _)| p.clone())
            .filter(|p| !self.is_release_write(repo_root, p))
            .collect();
        let mut candidates: Vec<&str> = changed.split('\0').filter(|p| !p.is_empty()).collect();
        for p in &restaged {
            if !candidates.contains(&p.as_str()) {
                candidates.push(p);
            }
        }
        let meanwhile: Vec<&str> = candidates
            .into_iter()
            .filter(|p| !unmerged.contains(p) && !self.is_release_write(repo_root, p))
            .filter(|p| {
                // Exit 1 (an error here) is "differs from the start" (a
                // legacy release's edits, else its commit).
                let start = self.edits.as_deref().unwrap_or(&self.head);
                git_run(repo_root, &["diff", "--quiet", start, "--", &format!(":(literal){p}")]).is_err()
            })
            .collect();
        if meanwhile.is_empty() {
            return Ok(false);
        }
        self.store_kept(repo_root, &meanwhile)
            .map_err(|e| format!("couldn't keep the changes saved while the release ran ({e}), so the folder was left as it is"))?;
        Ok(true)
    }

    /// The stash entry of `paths` as they are in the folder, on the start
    /// (a legacy release's edits, else its commit): a temporary index read
    /// from the start, those paths updated from the folder, its tree as
    /// both the entry's index and working tree.
    fn store_kept(&self, repo_root: &Path, paths: &[&str]) -> Result<(), String> {
        let git_dir = git_capture(repo_root, &["rev-parse", "--absolute-git-dir"])?;
        let index = PathBuf::from(git_dir.trim()).join("plyloft-kept-index");
        let _ = std::fs::remove_file(&index);
        let with_index = |args: &[&str]| -> Result<String, String> {
            let out = crate::platform::git_command()
                .args(args)
                .env("GIT_INDEX_FILE", &index)
                .current_dir(repo_root)
                .output()
                .map_err(|e| format!("spawn git {}: {e}", args.join(" ")))?;
            if !out.status.success() {
                return Err(format!("git {} failed: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
            }
            Ok(String::from_utf8_lossy(&out.stdout).to_string())
        };
        let base = self.edits.as_deref().unwrap_or(&self.head);
        let tree = with_index(&["read-tree", base]).and_then(|_| {
            // R7 (Challenger MINOR 3): the paths on stdin, not the command
            // line (Windows' 32 KiB limit).
            update_index_stdin(repo_root, &index, paths)?;
            with_index(&["write-tree"])
        });
        let _ = std::fs::remove_file(&index);
        let tree = tree?;
        let identity = ["-c", "user.name=Plyloft", "-c", "user.email=ship@plyloft.invalid"];
        let commit = |parents: &[&str], message: &str| -> Result<String, String> {
            // git commit-tree -p <parent> per parent (one line: the print-mode scan's allowlist).
            let mut args: Vec<&str> = ["commit-tree", "--no-gpg-sign", tree.trim()].into_iter().chain(parents.iter().flat_map(|p| ["-p", *p])).collect();
            args.push("-m");
            args.push(message);
            crate::git::capture_configured(repo_root, &identity, &args).map(|s| s.trim().to_string())
        };
        let i = commit(&[&self.head], &format!("index on the release: {KEPT_EDITS_STASH}"))?;
        let w = commit(&[&self.head, &i], KEPT_EDITS_STASH)?;
        git_run(repo_root, &["stash", "store", "-m", KEPT_EDITS_STASH, &w])
    }
}

/// `git update-index --add --remove -z --stdin` on the index file `index`,
/// `paths` NUL-separated on stdin.
fn update_index_stdin(repo_root: &Path, index: &Path, paths: &[&str]) -> Result<(), String> {
    use std::io::Write;
    let mut child = crate::platform::git_command()
        .args(["update-index", "--add", "--remove", "-z", "--stdin"])
        .env("GIT_INDEX_FILE", index)
        .current_dir(repo_root)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn git update-index: {e}"))?;
    let mut input = Vec::new();
    for p in paths {
        input.extend_from_slice(p.as_bytes());
        input.push(0);
    }
    let mut stdin = child.stdin.take().expect("piped stdin");
    let written = stdin.write_all(&input);
    drop(stdin);
    let out = child.wait_with_output().map_err(|e| format!("git update-index: {e}"))?;
    written.map_err(|e| format!("git update-index: {e}"))?;
    if !out.status.success() {
        return Err(format!("git update-index failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(())
}

/// The id of `path`'s bytes in the folder as they are on disk
/// (`git hash-object --no-filters`: R7, Challenger MAJOR 1 — with the
/// repository's filters a CRLF file and its LF form read the same, and the
/// same bytes could read differently from the index's copy); `None` when it
/// isn't there.
fn worktree_blob(repo_root: &Path, path: &str) -> Option<String> {
    if !repo_root.join(path).is_file() {
        return None;
    }
    git_capture(repo_root, &["hash-object", "--no-filters", "--", path]).ok().map(|s| s.trim().to_string())
}

#[cfg(test)]
thread_local! {
    /// R6 round 2: run once on this thread right after a release's version
    /// write, before it is staged — the seam a test saves a file on.
    pub(crate) static AFTER_VERSION_WRITE: std::cell::RefCell<Option<Box<dyn FnMut()>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn after_version_write() {
    AFTER_VERSION_WRITE.with(|hook| {
        if let Some(mut hook) = hook.borrow_mut().take() {
            hook();
        }
    });
}

/// R6: why a release's local half stopped after the folder was taken.
enum ReleaseStop {
    /// A card's squash met lines the target changed too.
    Conflict {
        card_id: String,
        title: String,
        has_builder: bool,
        branch: String,
        paths: Vec<String>,
        said: String,
        /// R7: the earlier cards of the batch whose change touched one of
        /// `paths` — a conflict between the cards, not with the target.
        with: Vec<String>,
    },
    Failed(ShipError),
}

impl ReleaseStop {
    /// R7: a batch card's conflict on a path an earlier card of the batch
    /// changed (`steps`: each committed card's title and paths) is with
    /// those cards — unless it isn't. R7 (Challenger MINOR 1): a conflict on
    /// a path no earlier card touched is with the target; and on an overlap,
    /// the card is merged alone onto the folder's start (`git merge-tree`,
    /// nothing written): if it conflicts there too, it conflicts with the
    /// target (recorded on the card, `ConflictBlocked`). A git without
    /// `merge-tree --write-tree` (before 2.38) keeps the path reading.
    fn between_cards(self, steps: &[(String, Vec<String>)], alone: impl FnOnce() -> Option<bool>) -> Self {
        match self {
            ReleaseStop::Conflict { card_id, title, has_builder, branch, paths, said, .. } => {
                let touched_before = |p: &String| steps.iter().any(|(_, changed)| changed.contains(p));
                let overlap: Vec<String> = steps
                    .iter()
                    .filter(|(_, changed)| changed.iter().any(|p| paths.contains(p)))
                    .map(|(t, _)| t.clone())
                    .collect();
                let with_target = paths.iter().any(|p| !touched_before(p))
                    || (!overlap.is_empty() && alone() == Some(false));
                let with = if with_target { Vec::new() } else { overlap };
                ReleaseStop::Conflict { card_id, title, has_builder, branch, paths, said, with }
            }
            other => other,
        }
    }
}

/// R7 (Challenger MINOR 1): whether `publish` merges cleanly onto `onto` by
/// itself (`git merge-tree --write-tree`: 0 clean, 1 conflicts), with
/// `merge_base` for a skill card's own change. `None` when git can't say
/// (before 2.38, or `--merge-base` before 2.40).
fn merges_alone(repo_root: &Path, onto: &str, publish: &str, merge_base: Option<&str>) -> Option<bool> {
    let mut cmd = crate::platform::git_command();
    cmd.args(["merge-tree", "--write-tree", "--quiet"]);
    if let Some(base) = merge_base {
        cmd.arg(format!("--merge-base={base}"));
    }
    let out = cmd
        .args([onto, publish])
        .current_dir(repo_root)
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    match out.status.code() {
        Some(0) => Some(true),
        Some(1) => Some(false),
        _ => None,
    }
}

/// R7: how a batch card's temporary commit's subject starts
/// (`release_record::view` names them after a crash).
pub(crate) const BATCH_STEP_PREFIX: &str = "Plyloft: Ship batch, ";

/// R7: commit what a batch card's squash staged — a temporary commit on the
/// folder's branch, so the next card merges onto it (git refuses a merge over
/// a staged change). No hook runs and no identity of the member's is needed
/// (`commit-tree`, as `apply_own_change`): it never outlives the release —
/// `ship_batch` folds it into the release commit (`update-ref`, the index kept), and a stop
/// puts the folder back past it. Returns the paths it changed; `None` when the
/// squash staged nothing.
fn commit_batch_step(repo_root: &Path, title: &str) -> Result<Option<(String, Vec<String>)>, String> {
    let staged = crate::platform::git_command()
        .args(["diff", "--cached", "--quiet"])
        .current_dir(repo_root)
        .status()
        .map_err(|e| format!("spawn git diff --cached: {e}"))?;
    match staged.code() {
        Some(0) => return Ok(None),
        Some(1) => {}
        _ => return Err("git diff --cached failed while merging the batch".to_string()),
    }
    let head = git_capture(repo_root, &["rev-parse", "--verify", "HEAD"])?;
    let head = head.trim();
    let tree = git_capture(repo_root, &["write-tree"])?;
    let commit = crate::git::capture_configured(
        repo_root,
        &["-c", "user.name=Plyloft", "-c", "user.email=ship@plyloft.invalid"],
        &[
            "commit-tree", "--no-gpg-sign", tree.trim(), "-p", head, // git commit-tree -p <parent>
            "-m",
            &format!("{BATCH_STEP_PREFIX}“{title}” (temporary, folded into the release)"),
        ],
    )?;
    let commit = commit.trim();
    git_run(
        repo_root,
        &["update-ref", "-m", "Plyloft: Ship batch (temporary)", "HEAD", commit, head],
    )?;
    let changed = git_capture(repo_root, &["diff", "--name-only", "-z", head, commit])?;
    Ok(Some((commit.to_string(), changed.split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect())))
}

impl From<String> for ReleaseStop {
    fn from(e: String) -> Self {
        ReleaseStop::Failed(e.into())
    }
}

impl From<ShipError> for ReleaseStop {
    fn from(e: ShipError) -> Self {
        ReleaseStop::Failed(e)
    }
}

/// R6 (Challenger m4): a panic in the local half is a stop like any other —
/// the folder is put back.
fn panic_stop(panic: Box<dyn std::any::Any + Send>) -> ReleaseStop {
    let what = panic
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "an internal error".to_string());
    ReleaseStop::Failed(format!("Plyloft stopped while making the release ({what}).").into())
}

/// R6: a card's squash that failed — a conflict (git's unmerged paths, read
/// before anything is put back; `-z`, as Land) or another failure.
fn squash_stop(repo_root: &Path, card: &KanbanCard, branch: &str, target: &str, e: String) -> ReleaseStop {
    let unmerged = git_capture(repo_root, &["diff", "--name-only", "-z", "--diff-filter=U"]).unwrap_or_default();
    let paths: Vec<String> = unmerged.split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect();
    if paths.is_empty() {
        return ReleaseStop::Failed(format!("Plyloft couldn't merge {branch} into {target}: {e}").into());
    }
    ReleaseStop::Conflict {
        card_id: card.id.clone(),
        title: card.title.clone(),
        has_builder: card.builder.is_some(),
        branch: branch.to_string(),
        paths,
        said: e,
        with: Vec::new(),
    }
}

/// R6: the release stopped before its tag. When it had changed the folder
/// (`touched`: a squash or the version write began — Challenger m11), the
/// folder is put back exactly as the press found it, and a conflict is
/// recorded on its card as Land records one (`ConflictBlocked` +
/// `ship_conflict`), so **Ask the Builder to resolve it** works. The
/// pre-record is taken back by its own drop. Returns what the press says.
#[allow(clippy::too_many_arguments)]
fn roll_back_release<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    kanban: &KanbanStore,
    workspace_id: &str,
    repo_root: &Path,
    folder: &FolderStart,
    target: &str,
    tag: &str,
    fast_forwarded: bool,
    touched: bool,
    stop: ReleaseStop,
) -> ShipError {
    if !touched {
        // Nothing in the folder changed (a Builder snapshot refused, say):
        // the stop is said as it always was.
        return match stop {
            ReleaseStop::Failed(e) => e,
            ReleaseStop::Conflict { said, .. } => ShipError::Message(said),
        };
    }
    let put_back = folder.put_back(repo_root, tag);
    let mut after = match &put_back {
        Ok(_) => ROLLED_BACK_WORDS.to_string(),
        Err(e) => {
            log::error!("ship: couldn't put the project folder back after a stopped release: {e}");
            let short = &folder.head[..folder.head.len().min(8)];
            let mut said = format!(
                "Nothing was pushed, but Plyloft couldn't put your project folder back as it was \
                 ({e}): it was at commit {short} before the release. Check it with `git status`."
            );
            // Challenger m5: a legacy card's changes are never only in a
            // dangling stash commit.
            if let Some(edits) = &folder.edits {
                match git_run(repo_root, &["stash", "store", "-m", LEGACY_EDITS_STASH, edits]) {
                    Ok(()) => said.push_str(&format!(
                        " The legacy card's changes from before the release are kept in your stash list (\"{LEGACY_EDITS_STASH}\")."
                    )),
                    Err(e) => log::error!("ship: couldn't store the legacy card's changes ({edits}): {e}"),
                }
            }
            said
        }
    };
    if matches!(&put_back, Ok(PutBack { kept_edits: true })) {
        after.push_str(&format!(
            " Changes saved in the project folder while the release ran are kept in your stash list (\"{KEPT_EDITS_STASH}\")."
        ));
    }
    // Challenger m2: the fast-forward before the release is kept — said.
    if fast_forwarded {
        after.push_str(&format!(" Your project folder was first brought up to date with the online {target}."));
    }
    stop_error(app, kanban, workspace_id, target, &folder.head, &after, stop)
}

/// R6/R7: what a release that stopped before its tag says — a conflict
/// between two cards of one batch ("ship them separately"), a card's
/// conflict with the target (recorded on the card as Land's,
/// `ConflictBlocked` with the target's commit `target_sha`, so **Ask the
/// Builder to resolve it** works), or the failure — with `after` (what was
/// put back) in it. G8: also a release built through a pull request, whose
/// `target_sha` is GitHub's target.
fn stop_error<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    kanban: &KanbanStore,
    workspace_id: &str,
    target: &str,
    target_sha: &str,
    after: &str,
    stop: ReleaseStop,
) -> ShipError {
    match stop {
        // R7: two cards of one batch changed the same lines — nothing to
        // resolve against the target, so nothing is recorded on the card.
        ReleaseStop::Conflict { title, paths, said, with, .. } if !with.is_empty() => {
            let with = with.iter().map(|t| format!("“{t}”")).collect::<Vec<_>>().join(" and ");
            ShipError::Message(format!(
                "Plyloft couldn't ship these cards together: “{title}” conflicts with {with} in {}; ship them separately. {after} Git said: {said}",
                paths.join(", ")
            ))
        }
        ReleaseStop::Conflict { card_id, title, has_builder, branch, paths, said, .. } => {
            // R7: the target's commit, never a batch's temporary one: the
            // card conflicts with the target alone here (a conflict with an
            // earlier card is the arm above), and Ask the Builder merging a
            // temporary commit would bring the earlier cards' work into this
            // card's branch.
            let record = crate::kanban::ShipConflict {
                paths: paths.clone(),
                target_sha: target_sha.to_string(),
                at: crate::kanban::now_ms(),
                branch: target.to_string(),
                merge_started_at: None,
                sync: false,
                review_before: None,
            };
            let written = kanban.with_card(workspace_id, &card_id, |c| {
                c.review_status = Some(crate::kanban::ReviewStatus::ConflictBlocked);
                c.ship_conflict = Some(record);
                Ok(())
            });
            if let Err(e) = written {
                log::warn!("ship: couldn't record the conflict on {card_id}: {e}");
            }
            crate::kanban::emit_kanban_changed(app, workspace_id);
            let todo = if has_builder { ASK_BUILDER_WORDS } else { "Resolve it in the card's copy, then ship again." };
            ShipError::Message(format!(
                "Plyloft couldn't merge “{title}” ({branch}) into {target}: it conflicts with {target} in {}. {after} {todo} Git said: {said}",
                paths.join(", ")
            ))
        }
        ReleaseStop::Failed(ShipError::Message(m)) => {
            let m = m.trim_end();
            let m = if m.ends_with(['.', '!', '?', ')']) { m.to_string() } else { format!("{m}.") };
            ShipError::Message(format!("{m} {after}"))
        }
        // A typed stop (a refusal the window draws as a value) keeps its
        // shape; it carries no sentence to add to, so what the rollback did
        // is logged.
        // DR2 round 1: Stop's own value says what the take-back left here
        // when that isn't simply "put back as it was".
        ReleaseStop::Failed(ShipError::Stopped(mut stopped)) => {
            if after.trim() != ROLLED_BACK_WORDS {
                stopped.stopped.here = Some(after.trim().to_string());
            }
            ShipError::Stopped(stopped)
        }
        ReleaseStop::Failed(other) => {
            log::info!("ship: a typed stop of a release; the folder: {after}");
            other
        }
    }
}

/// A path git lists (always `/`-separated, on Windows too) inside one of the
/// card worktree roots, current or legacy.
fn is_in_worktree_root(path: &str) -> bool {
    crate::worktrees::worktree_dir_names()
        .any(|name| path.strip_prefix(name).is_some_and(|rest| rest.starts_with('/')))
}

/// GH #196: untracked paths in the checkout, as git lists them (an untracked
/// directory as one `dir/` entry). The card worktrees' homes are left out:
/// Ship never commits it. `--no-empty-directory`: without it `--directory`
/// also lists an empty directory, or one holding only ignored files (a
/// `.DS_Store`), neither of which git status shows or `git add` can clear.
fn untracked_paths(repo_root: &Path) -> Result<Vec<String>, String> {
    let out = git_capture(
        repo_root,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "--directory",
            "--no-empty-directory",
            "-z",
        ],
    )?;
    Ok(out
        .split('\0')
        .filter(|p| !p.is_empty() && !is_in_worktree_root(p))
        .map(str::to_string)
        .collect())
}

/// GH #196: when the worktree flow shipped (v1.10.1–v1.10.3, 2026-05-08):
/// from then on a card's run starts in its own worktree (`ensure_for_card`
/// on dispatch), never in the main checkout. 2026-05-09T00:00:00Z — the day
/// after, so a card made while those builds were being installed still
/// counts as legacy (refused when in doubt, never silently dropped).
const WORKTREE_FLOW_EPOCH_MS: i64 = 1_778_284_800_000;

/// GH #196: a card whose work may be the checkout's uncommitted changes —
/// the pre-v1.10 main-checkout flow. No worktree handle is not enough: the
/// handle is also cleared by Land (`mark_card_shipped_local`), review merge,
/// the reconcile merged-prune, the dangling-worktree heal and a Worktrees
/// panel delete, and none of those cards' work is in the checkout. What
/// tells a legacy card apart is that it was created before the worktree
/// flow existed; no new persisted field is needed. Shipped / Merged cards
/// are excluded as well: their work is committed.
fn works_in_the_checkout(card: &KanbanCard) -> bool {
    card.worktree_path.is_none()
        && card.created_at < WORKTREE_FLOW_EPOCH_MS
        && !matches!(card.ship_status, ShipStatus::Shipped)
        && card.review_status != Some(crate::kanban::ReviewStatus::Merged)
}

/// GH #196: a card without a worktree (the pre-v1.10 main-checkout flow)
/// ships the checkout's uncommitted changes. Its edits to tracked files are
/// staged as before; a file it created is untracked, and no one can tell it
/// from an unrelated one — so the release is refused, naming them, rather
/// than committing the lot (`add -A`, as before) or silently dropping the
/// card's new files. `git add` the card's own, move the rest (or exclude
/// them locally), or leave the card out; then ship again.
fn require_legacy_cards_have_no_untracked(
    repo_root: &Path,
    cards: &[&KanbanCard],
) -> Result<(), String> {
    let legacy: Vec<String> = cards
        .iter()
        .filter(|c| works_in_the_checkout(c))
        .map(|c| format!("`{}`", c.title))
        .collect();
    if legacy.is_empty() {
        return Ok(());
    }
    let untracked = untracked_paths(repo_root)?;
    if untracked.is_empty() {
        return Ok(());
    }
    const SHOWN: usize = 10;
    let mut listed = untracked
        .iter()
        .take(SHOWN)
        .map(|p| format!("`{p}`"))
        .collect::<Vec<_>>()
        .join(", ");
    if untracked.len() > SHOWN {
        listed.push_str(&format!(" and {} more", untracked.len() - SHOWN));
    }
    let (cards_named, has) = if legacy.len() == 1 {
        (format!("card {}", legacy[0]), "has")
    } else {
        (format!("cards {}", legacy.join(", ")), "have")
    };
    Err(format!(
        "ship aborted: {cards_named} {has} no worktree (made before worktrees), so the work is \
         this checkout's uncommitted changes, and a release commits only tracked files. \
         Untracked here: {listed}. `git add` the ones that belong to the card; move the others \
         out of the checkout (or list a file you keep locally in `.git/info/exclude`); or leave \
         {cards_named} out of this release. Then ship again — nothing was merged, committed or \
         tagged."
    ))
}

/// GH #196: every declared version file that exists must be tracked — the
/// release commit stages tracked changes only, so a bump written into an
/// untracked version file would silently be left out of `vX.Y.Z`. A missing
/// file is left to the writer's own error, as before.
fn require_version_files_tracked(repo_root: &Path, config: &ProjectConfig) -> Result<(), String> {
    let mut untracked = Vec::new();
    for entry in &config.version_files {
        if !repo_root.join(&entry.path).is_file() {
            continue;
        }
        // Exit 1 (with `--error-unmatch`) is "not tracked"; `:(literal)`
        // keeps a path with glob characters from matching other files.
        let tracked = crate::platform::git_command()
            .args(["ls-files", "--error-unmatch", "--"])
            .arg(format!(":(literal){}", entry.path))
            .current_dir(repo_root)
            .output()
            .map_err(|e| format!("spawn git ls-files: {e}"))?;
        if !tracked.status.success() {
            untracked.push(format!("`{}`", entry.path));
        }
    }
    if untracked.is_empty() {
        return Ok(());
    }
    Err(format!(
        "ship aborted: version file(s) {} not tracked by git, and a release commits only \
         tracked files. Commit them once (or fix the project's version files), then ship \
         again — nothing was merged, committed or tagged.",
        untracked.join(", ")
    ))
}

fn is_valid_version(v: &str) -> bool {
    let core = v.split('-').next().unwrap_or(v);
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

/// `tag` is already made here (`areas::tag_for`: `vX.Y.Z` without areas).
fn tag_exists(repo_root: &Path, tag: &str) -> Result<bool, String> {
    let output = crate::platform::git_command()
        .args(["tag", "-l", tag])
        .current_dir(repo_root)
        .output()
        .map_err(|e| format!("spawn git tag -l: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "git tag -l failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

/// v1.12.2 (Cycle C): legacy entry point — kept so ship_audit and
/// any other Atelier-only callers continue to work. Internally
/// dispatches through `write_versions_per_config` with Atelier's
/// hardcoded baseline. New ship_card / ship_batch callers should
/// prefer `write_versions_per_config` directly with the per-workspace
/// project_config.
fn write_package_version(repo_root: &Path, version: &str) -> Result<(), String> {
    write_versions_per_config(
        repo_root,
        &project_config::default_atelier_config(),
        version,
    )
}

/// v1.12.2 (Cycle C): version-bump dispatcher that writes every entry
/// in `config.version_files` according to its declared kind, then
/// best-effort syncs the matching Cargo.lock if a Cargo.toml is in
/// the set. Replaces the Atelier-hardcoded path list.
///
/// Atelier's bootstrap config produces byte-identical output to the
/// legacy `write_package_version` call sequence.
fn write_versions_per_config(
    repo_root: &Path,
    config: &ProjectConfig,
    version: &str,
) -> Result<(), String> {
    for entry in &config.version_files {
        let path = repo_root.join(&entry.path);
        match entry.kind {
            VersionFileKind::PackageJson | VersionFileKind::TauriConfJson => {
                write_json_version_at(&path, version)?
            }
            VersionFileKind::CargoToml => write_cargo_version_at(&path, version)?,
            VersionFileKind::PyProjectToml => {
                write_pyproject_version_at(&path, version)?
            }
            VersionFileKind::PythonModuleVar => {
                let var_name = entry.variable_name.as_deref().ok_or_else(|| {
                    format!(
                        "{}: PythonModuleVar requires `variable_name` on VersionFileEntry",
                        path.display()
                    )
                })?;
                write_python_module_var_at(&path, var_name, version)?
            }
        }
    }
    // v1.9.x (Bug E) — Cargo.lock sync. Run for any Cargo.toml entry in
    // the config so non-Atelier projects are covered. Reads the
    // package name from the Cargo.toml itself (no longer hardcoded
    // as "atelier"). Best-effort — non-cargo projects with no lock
    // file simply skip, and a stale lock is recoverable post-ship.
    for entry in &config.version_files {
        if !matches!(entry.kind, VersionFileKind::CargoToml) {
            continue;
        }
        let cargo_path = repo_root.join(&entry.path);
        let _ = sync_cargo_lock_at(&cargo_path, version);
    }
    Ok(())
}

/// R6 (Challenger m6): the version writers' atomic write — `tmp`, then a
/// rename over `path`; a `tmp` that could not be written in full or renamed
/// is removed, never left beside the version file (where a release that
/// stops would leave it as an untracked file in the project folder).
fn write_then_rename(tmp: &Path, path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Err(e) = std::fs::write(tmp, bytes) {
        let _ = std::fs::remove_file(tmp);
        return Err(format!("write tmp {}: {e}", path.display()));
    }
    if let Err(e) = crate::platform::rename(tmp, path) {
        let _ = std::fs::remove_file(tmp);
        return Err(format!("rename {}: {e}", path.display()));
    }
    Ok(())
}

/// JSON version writer (used for `package.json` and `tauri.conf.json`
/// — both have a top-level `version` string field). Atomic via
/// tempfile + rename. Output preserves the existing 2-space indent
/// + trailing newline convention.
fn write_json_version_at(path: &Path, version: &str) -> Result<(), String> {
    let bytes =
        std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut v: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("parse {}: {e}", path.display()))?;
    if let Some(obj) = v.as_object_mut() {
        obj.insert(
            "version".to_string(),
            serde_json::Value::String(version.to_string()),
        );
    } else {
        return Err(format!("{} is not a JSON object", path.display()));
    }
    let json = serde_json::to_vec_pretty(&v)
        .map_err(|e| format!("encode {}: {e}", path.display()))?;
    let mut out = json;
    out.push(b'\n');
    let tmp_name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "version.json".to_string())
        + ".tmp";
    let tmp = path.with_file_name(tmp_name);
    write_then_rename(&tmp, path, &out)?;
    Ok(())
}

/// v1.13.0 (Cycle D): pyproject.toml version writer. Replaces the
/// first `version = "..."` line in the `[project]` section (PEP 621).
/// Mirrors `write_cargo_version_at` but scoped to `[project]` instead
/// of `[package]`.
fn write_pyproject_version_at(path: &Path, version: &str) -> Result<(), String> {
    let body = std::fs::read_to_string(path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut out = String::with_capacity(body.len());
    let mut in_project = false;
    let mut replaced = false;
    for line in body.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('[') {
            in_project = trimmed == "[project]";
        }
        if in_project && !replaced && trimmed.starts_with("version = \"") {
            out.push_str(&format!("version = \"{version}\"\n"));
            replaced = true;
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    if !replaced {
        return Err(format!("{} [project].version not found", path.display()));
    }
    let tmp_name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "pyproject.toml".to_string())
        + ".tmp";
    let tmp = path.with_file_name(tmp_name);
    write_then_rename(&tmp, path, out.as_bytes())?;
    Ok(())
}

/// v1.13.0 (Cycle D finding A): Python module variable version
/// writer. Rewrites the first occurrence of
/// `<variable_name>\s*=\s*"<old>"` to use the supplied version.
/// Handles top-level assignments AND keyword arguments inside
/// function calls — captures LYRA's
/// `FastAPI(version="...")` pattern.
///
/// Word boundaries (via `find_var_in_text`) prevent matching
/// `revision` when looking for `version`.
fn write_python_module_var_at(
    path: &Path,
    variable_name: &str,
    version: &str,
) -> Result<(), String> {
    let body = std::fs::read_to_string(path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let new_body =
        crate::project_config::rewrite_var_in_text(&body, variable_name, version)
            .ok_or_else(|| {
                format!(
                    "{}: no `{variable_name} = \"...\"` pattern found",
                    path.display()
                )
            })?;
    if new_body == body {
        return Ok(());
    }
    let tmp_name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "version.py".to_string())
        + ".tmp";
    let tmp = path.with_file_name(tmp_name);
    write_then_rename(&tmp, path, new_body.as_bytes())?;
    Ok(())
}

/// Cargo.toml version writer (regex-replaces the first
/// `version = "..."` line in the `[package]` section). Same idea as
/// the legacy `sync_cargo_version` but path-driven so any Cargo.toml
/// can be the target.
fn write_cargo_version_at(path: &Path, version: &str) -> Result<(), String> {
    let body = std::fs::read_to_string(path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut out = String::with_capacity(body.len());
    let mut in_package = false;
    let mut replaced = false;
    for line in body.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('[') {
            in_package = trimmed == "[package]";
        }
        if in_package && !replaced && trimmed.starts_with("version = \"") {
            out.push_str(&format!("version = \"{version}\"\n"));
            replaced = true;
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    if !replaced {
        return Err(format!("{} [package].version not found", path.display()));
    }
    let tmp_name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Cargo.toml".to_string())
        + ".tmp";
    let tmp = path.with_file_name(tmp_name);
    write_then_rename(&tmp, path, out.as_bytes())?;
    Ok(())
}

/// Read `[package].name` from a Cargo.toml. Used by `sync_cargo_lock_at`
/// to pick the right `[[package]]` block to rewrite in the sibling
/// Cargo.lock. Returns Err if the file lacks a `[package].name`.
fn read_cargo_package_name(cargo_toml_path: &Path) -> Result<String, String> {
    let body = std::fs::read_to_string(cargo_toml_path)
        .map_err(|e| format!("read {}: {e}", cargo_toml_path.display()))?;
    let mut in_package = false;
    for line in body.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('[') {
            in_package = trimmed == "[package]";
            continue;
        }
        if in_package && trimmed.starts_with("name = \"") {
            let after = &trimmed["name = \"".len()..];
            if let Some(end) = after.find('"') {
                return Ok(after[..end].to_string());
            }
        }
    }
    Err(format!(
        "{} [package].name not found",
        cargo_toml_path.display()
    ))
}

/// Cargo.lock version sync, parameterized over the Cargo.toml that
/// declared the bumped package. Reads the package name from the
/// Cargo.toml, finds the sibling Cargo.lock, rewrites that
/// package's version line. Best-effort — missing Cargo.lock or
/// missing package block is logged and swallowed by the caller.
fn sync_cargo_lock_at(cargo_toml_path: &Path, version: &str) -> Result<(), String> {
    let lock_path = cargo_toml_path
        .parent()
        .ok_or_else(|| {
            format!(
                "cargo toml has no parent: {}",
                cargo_toml_path.display()
            )
        })?
        .join("Cargo.lock");
    if !lock_path.is_file() {
        return Ok(()); // No lock — pure-source project, nothing to sync.
    }
    let package_name = read_cargo_package_name(cargo_toml_path)?;
    let body = std::fs::read_to_string(&lock_path)
        .map_err(|e| format!("read {}: {e}", lock_path.display()))?;
    let new_body = rewrite_lock_package_version(&body, &package_name, version)?;
    if new_body == body {
        return Ok(());
    }
    let tmp_name = lock_path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Cargo.lock".to_string())
        + ".tmp";
    let tmp = lock_path.with_file_name(tmp_name);
    write_then_rename(&tmp, &lock_path, new_body.as_bytes())?;
    Ok(())
}

/// Generalized version of the v1.9.x `rewrite_atelier_lock_version`.
/// Rewrites the `[[package]]` block whose `name = "<package_name>"`
/// to use the supplied version. Returns the body unchanged when the
/// block isn't found (caller treats as no-op rather than error so a
/// non-atelier-shaped Cargo.lock doesn't fail the ship).
fn rewrite_lock_package_version(
    body: &str,
    package_name: &str,
    version: &str,
) -> Result<String, String> {
    let mut out = String::with_capacity(body.len());
    let target_name_line = format!("name = \"{package_name}\"");
    let mut in_target_block = false;
    let mut just_saw_target_name = false;
    let mut version_replaced = false;
    for line in body.lines() {
        if line.starts_with("[[package]]") {
            in_target_block = false;
            just_saw_target_name = false;
            out.push_str(line);
            out.push('\n');
            continue;
        }
        if line.trim() == target_name_line {
            in_target_block = true;
            just_saw_target_name = true;
            out.push_str(line);
            out.push('\n');
            continue;
        }
        if in_target_block && just_saw_target_name && line.starts_with("version = ") {
            out.push_str(&format!("version = \"{version}\"\n"));
            version_replaced = true;
            just_saw_target_name = false;
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    if !version_replaced {
        // Returning Ok(body unchanged) rather than Err so missing
        // package blocks don't fail the ship.
        return Ok(body.to_string());
    }
    Ok(out)
}

/// True iff the card's worktree carries changes worth shipping.
/// Mirrors the signal the Outcome screen uses (`card_outcome.files_changed`)
/// without committing pending edits — called at badge-render time, so it
/// must be non-mutating.
///
/// Returns `true` when `worktree_path` is `None` — legacy cards from before
/// the worktree pipeline still ship via the version-bump-only path; we
/// preserve that. Returns `false` when the worktree directory is missing on
/// disk (path on record but gone — nothing to ship). Otherwise returns
/// `true` iff `git status --porcelain` is non-empty (uncommitted edits) OR
/// `git diff --name-only <fork>...<branch>` is non-empty (committed changes
/// on the card's branch), `<fork>` being `worktrees::card_diff_base` (the
/// badge's: no network).
fn card_has_worktree_changes(card: &KanbanCard, base: &str) -> bool {
    worktree_changes(card, base, false)
}

/// Ship batch's gate: [`card_has_worktree_changes`] from the base checked
/// against origin's real tip (`review_base::verified`).
fn card_has_worktree_changes_verified(card: &KanbanCard, base: &str) -> bool {
    worktree_changes(card, base, true)
}

/// `verified`: the base checked against origin now, else the no-network one.
fn worktree_changes(card: &KanbanCard, base: &str, verified: bool) -> bool {
    let (wt, branch) = match (card.worktree_path.as_deref(), card.branch_name.as_deref()) {
        (Some(w), Some(b)) => (w, b),
        (None, _) => return true,
        _ => return false,
    };
    let wt_path = Path::new(wt);
    if !wt_path.is_dir() {
        return false;
    }
    if let Ok(out) = crate::platform::git_command()
        .args(["status", "--porcelain"])
        .current_dir(wt_path)
        .output()
    {
        if out.status.success() && !out.stdout.iter().all(|b| b.is_ascii_whitespace()) {
            return true;
        }
    }
    // GH #191: from the card's own base, as Outcome counts — a local target
    // behind origin must not make a card with no work look shippable.
    let recorded = crate::review_base::Recorded::of(card.worktree_base.as_ref());
    let fork = if verified {
        crate::review_base::verified(wt_path, branch, recorded, base)
    } else {
        crate::review_base::informational(wt_path, branch, recorded, base)
    }
    .map(|b| b.commit)
    .unwrap_or_else(|| base.to_string());
    if let Ok(out) = crate::platform::git_command()
        .args(["diff", "--name-only", &format!("{fork}...{branch}")])
        .current_dir(wt_path)
        .output()
    {
        if out.status.success() && !out.stdout.iter().all(|b| b.is_ascii_whitespace()) {
            return true;
        }
    }
    false
}

/// Ship batch's refusal for a card with nothing to ship. GH #191: when the
/// card's commits are already in the fetched `origin/<target>` it says so,
/// rather than "no worktree changes". Local refs only.
fn no_changes_to_ship_message(card: &KanbanCard, target_branch: &str) -> String {
    let already_in = match (card.worktree_path.as_deref(), card.branch_name.as_deref()) {
        (Some(wt), Some(branch)) if Path::new(wt).is_dir() => {
            crate::worktrees::card_already_in_origin(
                Path::new(wt),
                branch,
                card.worktree_base.as_ref().map(|b| b.commit.as_str()),
                target_branch,
            )
        }
        _ => None,
    };
    if let Some(already_in) = already_in {
        format!(
            "ship_batch blocked: card `{}` is already in {already_in} — nothing to ship",
            card.title
        )
    } else {
        format!(
            "ship_batch blocked: card `{}` has no changes in its copy to ship",
            card.title
        )
    }
}

/// Pure predicate behind `pending_ship_count`. A card is pending-to-ship iff
/// it's in the Complete column, not archived, `ship_status == Unshipped`,
/// `verify_status` is in a ship-eligible state (`Passed` or `Skipped`), AND
/// its worktree carries changes (i.e. there's actually something to ship —
/// matches the Outcome screen's "nothing to ship" gate). Cards with `None`
/// / `Queued` / `Running` / `Failed` verify state are NOT pending until
/// verify completes; `Legacy` cards are excluded because the v1.9 migration
/// already marked them shipped.
///
/// v1.34.x: added the `!archived` gate. Pre-v1.9 archived cards have
/// `verify_status = Legacy + ship_status = Shipped` (so they were already
/// excluded), but post-v1.9 cards can be archived while still
/// `Complete + Unshipped + Passed`. Without this gate the toolbar
/// over-counted those ghost cards against the user.
fn is_pending_ship(card: &KanbanCard, has_changes: bool) -> bool {
    passes_pending_ship_metadata(card) && has_changes
}

/// The cheap, git-free half of [`is_pending_ship`]: column, archived, ship
/// and verify status. `pending_ship_count` checks it first so git runs only
/// for cards that could count.
///
/// GH #242: a landed card (its pull request merged) is never pending, nor
/// is a Builder card without a worktree, which
/// `builder::require_builder_worktree` would refuse — so a batch that
/// includes it can never ship. The frontend's
/// `boardSemantics.ts::isShipBatchEligible` is the same rule; the two
/// numbers agree. UX P1 point 2 (P-A): a card whose last ship stopped on a
/// conflict is left out too — the Board says "Ship stopped on a conflict",
/// and a batch would only retry it; it ships again from its own page.
fn passes_pending_ship_metadata(card: &KanbanCard) -> bool {
    // 1.171.0 F1 (K1): an approved Builder card stays in In progress (CL-10)
    // and since C5 only a ship moves it — the batch takes it there once its
    // session is closed and its last round is reviewed (`batch_builder_refusal`).
    let column_ok = matches!(card.column_id, KanbanColumnId::Complete)
        || (card.builder.is_some() && batch_builder_refusal(card).is_none());
    column_ok
        && !card.archived
        && card.pr_review.is_none()
        && matches!(card.ship_status, ShipStatus::Unshipped)
        && card.review_status != Some(crate::kanban::ReviewStatus::Merged)
        && card.review_status != Some(crate::kanban::ReviewStatus::ConflictBlocked)
        && !crate::pr_status::card_pr_open(card)
        && matches!(
            card.verify_status,
            VerifyStatus::Passed | VerifyStatus::Skipped
        )
        && (card.worktree_path.is_some() || card.builder.is_none())
}

/// 1.171.0 F1: why the batch leaves out a Builder card that is not in
/// Complete — words the sheet shows beside it (`boardSemantics.ts::
/// shipBatchLeftOut` says the same). Ship batch used to take Complete cards
/// only, and an approved Builder card stays in In progress (CL-10), so no
/// Builder card ever went in a batch. It goes in now with the gates Ship it
/// merges by itself with: one build picked, its session closed (nothing can
/// move its copy past the saved work), its work saved, and its last round
/// reviewed as `builder::ship_review_record` (no follow-up) reads it — the
/// one rule, never a copy of it here. An unreviewed card ships
/// from its own page (Ship anyway), never unnoticed in a batch. The saved
/// work being the copy's tip is git's: `batch_ready_on_disk` for the list,
/// `require_verified_snapshot` in `ship_batch`. None: it may go in.
pub(crate) fn batch_builder_refusal(card: &KanbanCard) -> Option<String> {
    let b = card.builder.as_ref()?;
    if crate::build_both::is_undecided(card) {
        return Some(crate::build_both::UNDECIDED_REFUSAL.to_string());
    }
    if b.pty_id.is_some() {
        return Some(BATCH_SESSION_OPEN.to_string());
    }
    let Some(last) = b.snapshots.last() else {
        return Some(BATCH_NOT_SAVED.to_string());
    };
    crate::builder::ship_review_record(card, &last.sha, false).map(|_| BATCH_NOT_APPROVED.to_string())
}

/// 1.171.0 F1: [`batch_builder_refusal`]'s words (the sheet's too).
pub(crate) const BATCH_SESSION_OPEN: &str =
    "Its Builder session is still open. Close the session on its page, and the batch can take it.";
pub(crate) const BATCH_NOT_SAVED: &str =
    "The Builder's work isn't saved yet. Press Finish and check on its page first.";
pub(crate) const BATCH_NOT_APPROVED: &str =
    "The Reviewer hasn't approved its last round. Ship it from its own page.";

/// 1.171.0 F1: the list's git check — something to ship, and for a Builder
/// card the batch takes from In progress, its copy exactly at its saved,
/// reviewed work (no edit, no commit since).
fn batch_ready_on_disk(card: &KanbanCard, base: &str) -> bool {
    if !card_has_worktree_changes(card, base) {
        return false;
    }
    if card.builder.is_none() || matches!(card.column_id, KanbanColumnId::Complete) {
        return true;
    }
    card.worktree_path
        .as_deref()
        .is_some_and(|wt| crate::builder::require_at_last_snapshot(card, Path::new(wt)).is_ok())
}

/// Surface the count of pending-to-ship cards across all workspaces.
/// Drives the toolbar `Ship batch (N)` badge.
pub fn pending_ship_count(
    kanban: &KanbanStore,
    workspace_ids: &[String],
    project_config: &ProjectConfigStore,
) -> usize {
    pending_ship_count_with(kanban, workspace_ids, project_config, batch_ready_on_disk)
}

/// [`pending_ship_count`] with the git probe injectable (the test seam).
/// The probe runs only for cards that pass the metadata gates: the badge
/// is recomputed often, and git per card in every column was waste.
fn pending_ship_count_with(
    kanban: &KanbanStore,
    workspace_ids: &[String],
    project_config: &ProjectConfigStore,
    has_changes: impl FnMut(&KanbanCard, &str) -> bool,
) -> usize {
    pending_ship_cards_with(kanban, workspace_ids, project_config, has_changes)
        .iter()
        .map(|w| w.card_ids.len())
        .sum()
}

/// QoL 1.168 C7: the cards a batch can ship, per workspace — the one source
/// of every "Ship N" (the sidebar, ⌘K, the Board's header, the sheet). The
/// count is their number; the sheet lists them, loading a Board not opened
/// this session, so "Ship 1 in a batch" never opens on "Ship 0 cards".
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingShipCards {
    pub workspace_id: String,
    pub card_ids: Vec<String>,
    /// 1.173.0 (B4): in a repository with areas, the same cards by the area
    /// a batch would release them as (a batch is one area); empty without
    /// areas, and left out of the JSON then.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub areas: Vec<PendingAreaCards>,
}

/// 1.173.0 (B4): the ready cards of one area — or, with `refusal`, the
/// cards no batch can release until it is fixed (no area chosen, an area
/// removed, the areas held, no version file of its own).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingAreaCards {
    /// The area's id (`None`: the workspace's, or refused).
    pub area: Option<String>,
    pub name: String,
    pub card_ids: Vec<String>,
    pub refusal: Option<String>,
    /// Where its release goes, and its tags' prefix ("" when refused).
    pub branch: String,
    pub tag_prefix: String,
}

pub fn pending_ship_cards(
    kanban: &KanbanStore,
    workspace_ids: &[String],
    project_config: &ProjectConfigStore,
) -> Vec<PendingShipCards> {
    pending_ship_cards_with(kanban, workspace_ids, project_config, batch_ready_on_disk)
}

fn pending_ship_cards_with(
    kanban: &KanbanStore,
    workspace_ids: &[String],
    project_config: &ProjectConfigStore,
    mut has_changes: impl FnMut(&KanbanCard, &str) -> bool,
) -> Vec<PendingShipCards> {
    let mut out = Vec::new();
    for ws in workspace_ids {
        let config = project_config.get(ws);
        let target_branch = config
            .as_ref()
            .map(|c| c.target_branch.clone())
            .unwrap_or_else(|| "main".to_string());
        // 1.173.0 (B4): read once per workspace; none is the old list exactly.
        let areas = config
            .as_ref()
            .map(|_| crate::areas::for_workspace(project_config, ws))
            .unwrap_or_default();
        let held = config.as_ref().and_then(|_| crate::areas::held(project_config, ws));
        if let Ok(cards) = kanban.load(ws) {
            let mut card_ids: Vec<String> = Vec::new();
            let mut groups: Vec<PendingAreaCards> = Vec::new();
            for c in cards.iter().filter(|c| passes_pending_ship_metadata(c)) {
                let release = match (&config, areas.is_empty() && held.is_none()) {
                    (Some(config), false) => Some(ship_area_of(
                        crate::card_area::resolve_with(config, &areas, held.clone(), c),
                        &areas,
                    )),
                    _ => None,
                };
                let branch = match &release {
                    Some(Ok(area)) => area.config.target_branch.as_str(),
                    _ => target_branch.as_str(),
                };
                if !has_changes(c, branch) {
                    continue;
                }
                card_ids.push(c.id.clone());
                let Some(release) = release else { continue };
                let (area, name, refusal, branch, tag_prefix) = match release {
                    Ok(a) => (
                        a.id,
                        a.name.unwrap_or_default(),
                        None,
                        a.config.target_branch,
                        a.prefix,
                    ),
                    Err(why) => (None, String::new(), Some(why), String::new(), String::new()),
                };
                match groups.iter_mut().find(|g| g.area == area && g.refusal == refusal) {
                    Some(group) => group.card_ids.push(c.id.clone()),
                    None => groups.push(PendingAreaCards {
                        area,
                        name,
                        card_ids: vec![c.id.clone()],
                        refusal,
                        branch,
                        tag_prefix,
                    }),
                }
            }
            if !card_ids.is_empty() {
                out.push(PendingShipCards { workspace_id: ws.clone(), card_ids, areas: groups });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    /// N16: Ship leaves either worktree root out of what it commits, and
    /// nothing that merely starts with a root's name.
    #[test]
    fn untracked_paths_leave_out_both_worktree_roots() {
        for p in [".plyloft-worktrees/", ".plyloft-worktrees/card1/", ".atelier-worktrees/x/"] {
            assert!(super::is_in_worktree_root(p), "{p}");
        }
        for p in [".plyloft-worktrees-notes.md", ".atelier-worktreesX/", "src/.plyloft-worktrees/", "README.md"] {
            assert!(!super::is_in_worktree_root(p), "{p}");
        }
    }

    fn ply_checkout() -> tempfile::TempDir {
        let repo = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(repo.path().join("src-tauri")).unwrap();
        std::fs::create_dir_all(repo.path().join("scripts")).unwrap();
        std::fs::write(repo.path().join("src-tauri/tauri.conf.json"), r#"{"identifier":"com.mbadv.ply"}"#)
            .unwrap();
        std::fs::write(repo.path().join("package.json"), "{}").unwrap();
        std::fs::write(repo.path().join("scripts/install-local.sh"), "exit 0\n").unwrap();
        repo
    }

    /// Ply's own install is `install-local.sh` in a Tauri checkout; another
    /// project's go-live script, or that name elsewhere, is not.
    #[test]
    fn only_ply_s_own_install_script_is_the_self_install() {
        let ply = ply_checkout();
        assert!(super::is_self_install(ply.path(), "scripts/install-local.sh"));
        assert!(!super::is_self_install(ply.path(), "scripts/go-live.sh"));
        let other = tempfile::tempdir().unwrap();
        assert!(!super::is_self_install(other.path(), "scripts/install-local.sh"));
        // Another Tauri app with an install-local.sh is not Ply.
        let tauri_app = ply_checkout();
        std::fs::write(tauri_app.path().join("src-tauri/tauri.conf.json"), r#"{"identifier":"com.example.app"}"#)
            .unwrap();
        assert!(!super::is_self_install(tauri_app.path(), "scripts/install-local.sh"));
        assert!(super::refuse_self_install(ply.path(), None).is_ok());
        assert!(super::refuse_self_install(ply.path(), Some("scripts/go-live.sh")).is_ok());
    }

    /// The Mac installs Ply from source as before.
    #[cfg(unix)]
    #[test]
    fn the_mac_never_refuses_the_self_install() {
        let ply = ply_checkout();
        assert!(super::refuse_self_install(ply.path(), Some("scripts/install-local.sh")).is_ok());
        assert_eq!(super::build_log_path(), std::path::PathBuf::from("/tmp/atelier-build.log"));
    }

    /// Windows refuses Ply's own install up front with the reason, and the
    /// spawn itself refuses it too, before running anything.
    #[cfg(windows)]
    #[test]
    fn windows_refuses_the_self_install_clearly() {
        let ply = ply_checkout();
        let refused = super::refuse_self_install(ply.path(), Some("scripts/install-local.sh")).unwrap_err();
        assert_eq!(refused, super::SELF_INSTALL_MACOS_ONLY);
        assert!(refused.starts_with("Installing Plyloft from source is macOS-only for now"));
        assert_eq!(
            super::spawn_install_script(ply.path(), "scripts/install-local.sh").unwrap_err(),
            super::SELF_INSTALL_MACOS_ONLY
        );
        assert!(super::build_log_path().starts_with(std::env::temp_dir()));
    }

    /// GH #222 review 1 (m3): a quit waits for a release's local half and
    /// refuses a new one; the wait is bounded.
    #[test]
    fn a_quit_waits_for_a_releases_local_half_and_refuses_new_ones() {
        use std::time::{Duration, Instant};
        let phases = super::LocalPhases::new();
        let phase = phases.begin().unwrap();
        let started = Instant::now();
        let left = std::thread::scope(|s| {
            s.spawn(move || {
                std::thread::sleep(Duration::from_millis(300));
                drop(phase);
            });
            phases.finish_before_exit(Duration::from_secs(5))
        });
        assert_eq!(left, 0);
        let waited = started.elapsed();
        assert!(waited >= Duration::from_millis(250) && waited < Duration::from_secs(3), "{waited:?}");
        let refused = phases.begin().err().expect("no release starts once quitting");
        assert!(refused.contains("Nothing was merged, committed or tagged"), "{refused}");

        // Bounded: a local half that never ends does not hold the quit.
        let stuck = super::LocalPhases::new();
        let _held = stuck.begin().unwrap();
        let started = Instant::now();
        assert_eq!(stuck.finish_before_exit(Duration::from_millis(200)), 1);
        assert!(started.elapsed() < Duration::from_secs(2));
        // Nothing in flight: no wait at all.
        let idle = super::LocalPhases::new();
        let started = Instant::now();
        assert_eq!(idle.finish_before_exit(Duration::from_secs(5)), 0);
        assert!(started.elapsed() < Duration::from_millis(200));
    }

    use super::*;
    use crate::kanban::KanbanColumnId;
    use tempfile::tempdir;

    /// R6 (Challenger m1): putting the folder back deletes a tag only when it
    /// names a commit made on top of the start — never one that was there.
    #[test]
    fn put_back_deletes_only_a_tag_this_release_made() {
        let dir = tempdir().unwrap();
        let repo = dir.path();
        let g = |args: &[&str]| git_capture(repo, args).unwrap();
        g(&["init", "-q", "-b", "main"]);
        g(&["config", "user.email", "t@ply.test"]);
        g(&["config", "user.name", "ply-test"]);
        g(&["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.join("a.txt"), "a\n").unwrap();
        g(&["add", "a.txt"]);
        g(&["commit", "-q", "-m", "a"]);
        let folder = FolderStart::take(repo, &project_config::default_atelier_config(), false).unwrap();
        g(&["tag", "v9.0.0"]);
        folder.put_back(repo, "v9.0.0").unwrap();
        assert_eq!(g(&["tag", "--list"]).trim(), "v9.0.0", "a tag at the start is kept");

        std::fs::write(repo.join("b.txt"), "b\n").unwrap();
        g(&["add", "b.txt"]);
        g(&["commit", "-q", "-m", "release"]);
        g(&["tag", "v9.0.1"]);
        folder.put_back(repo, "v9.0.1").unwrap();
        assert_eq!(g(&["tag", "--list"]).trim(), "v9.0.0", "the release's own tag is gone");
        assert_eq!(g(&["rev-parse", "HEAD"]).trim(), folder.head);
        assert!(!repo.join("b.txt").exists());
    }

    #[test]
    fn ship_lock_acquires_once() {
        let reg = ShipRegistry::default();
        let g = reg.try_acquire("ws-A").expect("first acquire");
        assert!(reg.is_held());
        assert!(
            reg.try_acquire("ws-A").is_none(),
            "second acquire on same workspace must fail"
        );
        drop(g);
        assert!(!reg.is_held(), "lock must release on guard drop");
    }

    #[test]
    fn ship_lock_re_acquires_after_drop() {
        let reg = ShipRegistry::default();
        {
            let _g = reg.try_acquire("ws-A").unwrap();
        }
        let _g2 = reg
            .try_acquire("ws-A")
            .expect("re-acquire after first guard dropped");
    }

    #[test]
    fn bump_patch_increments_last_component() {
        assert_eq!(bump_patch("1.8.4"), Some("1.8.5".to_string()));
        assert_eq!(bump_patch("1.9.0"), Some("1.9.1".to_string()));
        assert_eq!(bump_patch("0.0.0"), Some("0.0.1".to_string()));
    }

    #[test]
    fn bump_patch_strips_unverified_suffix() {
        assert_eq!(bump_patch("1.9.0-unverified"), Some("1.9.1".to_string()));
    }

    #[test]
    fn bump_patch_returns_none_for_non_semver() {
        assert!(bump_patch("not-a-version").is_none());
        assert!(bump_patch("1.2").is_none());
        assert!(bump_patch("1.2.3.4").is_none());
        assert!(bump_patch("1.a.3").is_none());
    }

    #[test]
    fn is_valid_version_accepts_basic_semver() {
        assert!(is_valid_version("1.0.0"));
        assert!(is_valid_version("1.9.0"));
        assert!(is_valid_version("100.200.300"));
    }

    #[test]
    fn is_valid_version_accepts_unverified_suffix() {
        assert!(is_valid_version("1.9.0-unverified"));
    }

    #[test]
    fn is_valid_version_rejects_bad_input() {
        assert!(!is_valid_version("1.0"));
        assert!(!is_valid_version("1.0.0.0"));
        assert!(!is_valid_version("1.a.0"));
        assert!(!is_valid_version(""));
        assert!(!is_valid_version("v1.0.0"));
    }

    #[test]
    fn rewrite_lock_replaces_atelier_target_line() {
        let body = r#"[[package]]
name = "anyhow"
version = "1.0.86"

[[package]]
name = "atelier"
version = "1.9.1"
dependencies = [
 "chrono",
]

[[package]]
name = "chrono"
version = "0.4.38"
"#;
        let out = rewrite_lock_package_version(body, "atelier", "1.9.2").unwrap();
        assert!(out.contains("name = \"atelier\"\nversion = \"1.9.2\""));
        // Other packages untouched.
        assert!(out.contains("name = \"anyhow\"\nversion = \"1.0.86\""));
        assert!(out.contains("name = \"chrono\"\nversion = \"0.4.38\""));
    }

    #[test]
    fn rewrite_lock_does_not_touch_packages_named_similarly() {
        // Hypothetical sibling crate whose name shares a prefix.
        let body = r#"[[package]]
name = "atelier-helper"
version = "0.1.0"

[[package]]
name = "atelier"
version = "1.9.1"
"#;
        let out = rewrite_lock_package_version(body, "atelier", "1.9.2").unwrap();
        // The sibling stays at 0.1.0; only the exact-match `atelier` was bumped.
        assert!(out.contains("name = \"atelier-helper\"\nversion = \"0.1.0\""));
        assert!(out.contains("name = \"atelier\"\nversion = \"1.9.2\""));
    }

    /// v1.12.2: missing package is no longer an error — non-atelier-shaped
    /// Cargo.lock files (or projects with a typo) shouldn't fail the
    /// ship. Returns body unchanged so the caller can no-op.
    #[test]
    fn rewrite_lock_returns_unchanged_when_package_missing() {
        let body = r#"[[package]]
name = "anyhow"
version = "1.0.86"
"#;
        let out = rewrite_lock_package_version(body, "atelier", "1.9.2").unwrap();
        assert_eq!(out.trim_end(), body.trim_end());
    }

    #[test]
    fn rewrite_lock_idempotent_when_already_at_target() {
        let body = r#"[[package]]
name = "atelier"
version = "1.9.2"
"#;
        let out = rewrite_lock_package_version(body, "atelier", "1.9.2").unwrap();
        // The function still rewrites the line (matches), but the
        // resulting body is byte-equivalent.
        assert_eq!(out.trim_end(), body.trim_end());
    }

    /// v1.12.2: rewrites work for any package name — non-Atelier
    /// projects (LYRA etc.) get the same Cargo.lock sync without
    /// per-project hardcoded knowledge.
    #[test]
    fn rewrite_lock_supports_arbitrary_package_name() {
        let body = r#"[[package]]
name = "lyra"
version = "0.5.0"
"#;
        let out = rewrite_lock_package_version(body, "lyra", "0.5.1").unwrap();
        assert!(out.contains("name = \"lyra\"\nversion = \"0.5.1\""));
    }

    /// v1.12.2: read_cargo_package_name pulls `[package].name` from
    /// a Cargo.toml. Used by sync_cargo_lock_at to disambiguate the
    /// `[[package]]` block to rewrite.
    #[test]
    fn read_cargo_package_name_finds_atelier() {
        use std::io::Write;
        let dir = tempdir().unwrap();
        let path = dir.path().join("Cargo.toml");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(
            f,
            "[package]\nname = \"atelier\"\nversion = \"1.0.0\"\nedition = \"2021\""
        )
        .unwrap();
        assert_eq!(read_cargo_package_name(&path).unwrap(), "atelier");
    }

    #[test]
    fn read_cargo_package_name_finds_arbitrary() {
        use std::io::Write;
        let dir = tempdir().unwrap();
        let path = dir.path().join("Cargo.toml");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(
            f,
            "[package]\nname = \"lyra-core\"\nversion = \"0.5.0\""
        )
        .unwrap();
        assert_eq!(read_cargo_package_name(&path).unwrap(), "lyra-core");
    }

    #[test]
    /// v1.12.4 (Cycle C): per-workspace lock — same workspace is
    /// serialized; different workspaces are concurrent.
    #[test]
    fn ship_lock_serializes_same_workspace_only() {
        let registry = ShipRegistry::default();
        let g1 = registry.try_acquire("ws-A").unwrap();
        // Same workspace blocked.
        assert!(registry.try_acquire("ws-A").is_none());
        // Different workspace allowed.
        let g2 = registry.try_acquire("ws-B").unwrap();
        // Both held → is_held returns true; per-workspace queries
        // mirror reality.
        assert!(registry.is_held());
        assert!(registry.is_held_for("ws-A"));
        assert!(registry.is_held_for("ws-B"));
        assert!(!registry.is_held_for("ws-C"));
        // Drop ws-A guard → ws-A frees, ws-B still held.
        drop(g1);
        assert!(!registry.is_held_for("ws-A"));
        assert!(registry.is_held_for("ws-B"));
        assert!(registry.is_held());
        // ws-A re-acquirable.
        let _g3 = registry.try_acquire("ws-A").unwrap();
        assert!(registry.is_held_for("ws-A"));
        drop(g2);
        assert!(!registry.is_held_for("ws-B"));
    }

    /// v1.12.4: when no ships are in flight, `is_held` is false.
    #[test]
    fn ship_lock_starts_empty() {
        let registry = ShipRegistry::default();
        assert!(!registry.is_held());
        assert!(!registry.is_held_for("anything"));
    }

    /// The toolbar `Ship batch (N)` count must agree with the Outcome
    /// screen's "nothing to ship" gate: a Complete + Unshipped + verify-
    /// Passed/Skipped card whose worktree has zero changes is NOT pending.
    ///
    /// (Latent bug, fixed in this change: this test was missing its
    /// `#[test]` attribute and wasn't running.)
    #[test]
    fn is_pending_ship_matches_outcome_screen_gate() {
        let complete_passed_unshipped =
            sample_card("c", "ws", KanbanColumnId::Complete);
        // Baseline: Complete + Passed + Unshipped + has_changes=true → counts.
        let mut c = complete_passed_unshipped.clone();
        c.verify_status = VerifyStatus::Passed;
        assert!(is_pending_ship(&c, true));

        // Same card with empty worktree → does NOT count (the fix).
        assert!(!is_pending_ship(&c, false));

        // Verify Skipped + has_changes → still counts.
        c.verify_status = VerifyStatus::Skipped;
        assert!(is_pending_ship(&c, true));
        assert!(!is_pending_ship(&c, false));

        // v1.154.1 (F11): its pull request is still open on GitHub, mid-way
        // through a fix round (`review_status` is the review loop's) → never
        // counts: Merge is on the card.
        let mut open_pr = c.clone();
        open_pr.pr_url = Some("https://github.com/o/r/pull/11".into());
        open_pr.pr = Some(crate::pr_status::PrStatus::opened(11, 1));
        open_pr.review_status = Some(crate::kanban::ReviewStatus::ChangesRequested);
        assert!(!is_pending_ship(&open_pr, true));

        // Already shipped → never counts.
        c.verify_status = VerifyStatus::Passed;
        c.ship_status = ShipStatus::Shipped;
        assert!(!is_pending_ship(&c, true));

        // Legacy (pre-v1.9 migration) → never counts.
        let mut c = complete_passed_unshipped.clone();
        c.verify_status = VerifyStatus::Legacy;
        assert!(!is_pending_ship(&c, true));

        // Wrong column → never counts.
        let mut c = complete_passed_unshipped.clone();
        c.verify_status = VerifyStatus::Passed;
        c.column_id = KanbanColumnId::Todo;
        assert!(!is_pending_ship(&c, true));

        // Verify not done yet → never counts.
        for v in [
            VerifyStatus::None,
            VerifyStatus::Queued,
            VerifyStatus::Running,
            VerifyStatus::Failed,
        ] {
            let mut c = complete_passed_unshipped.clone();
            c.verify_status = v;
            assert!(!is_pending_ship(&c, true));
        }

        // v1.34.x: archived Complete+Unshipped+Passed → does NOT count.
        // (Pre-v1.34 this fell through the gate and the toolbar over-counted
        // ghost cards the user had already chosen to declutter.)
        let mut c = complete_passed_unshipped.clone();
        c.verify_status = VerifyStatus::Passed;
        c.archived = true;
        assert!(!is_pending_ship(&c, true));

        // Sanity inverse: same card un-archived → counts.
        c.archived = false;
        assert!(is_pending_ship(&c, true));
    }

    /// GH #196: the version-file check reads its path literally — an
    /// untracked `v[1].json` is not "tracked" because `v1.json` is.
    #[test]
    fn version_file_check_reads_the_path_literally() {
        let tmp = tempdir().unwrap();
        let repo = tmp.path();
        let git = |args: &[&str]| {
            let ok = crate::platform::git_command().args(args).current_dir(repo).status().unwrap();
            assert!(ok.success(), "git {args:?}");
        };
        git(&["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("v1.json"), "{\"version\": \"1.0.0\"}\n").unwrap();
        git(&["add", "v1.json"]);
        std::fs::write(repo.join("v[1].json"), "{\"version\": \"1.0.0\"}\n").unwrap();
        let config = |path: &str| -> ProjectConfig {
            serde_json::from_value(serde_json::json!({
                "schemaVersion": 2,
                "targetBranch": "main",
                "versionFiles": [{ "path": path, "kind": "package_json" }],
                "createdAt": 0,
                "updatedAt": 0,
            }))
            .unwrap()
        };
        assert_eq!(require_version_files_tracked(repo, &config("v1.json")), Ok(()));
        let err = require_version_files_tracked(repo, &config("v[1].json")).unwrap_err();
        assert!(err.contains("`v[1].json` not tracked"), "{err}");
    }
    /// `card_has_worktree_changes` returns `true` for legacy cards
    /// (no `worktree_path`) so the v1.9-era version-bump-only ship path
    /// keeps working, and `false` when the recorded worktree path is gone.
    #[test]
    fn card_has_worktree_changes_handles_legacy_and_missing_paths() {
        // Legacy: worktree_path None → true (preserve legacy behavior).
        let c = sample_card("c", "ws", KanbanColumnId::Complete);
        assert!(card_has_worktree_changes(&c, "main"));

        // worktree_path set but directory missing → false.
        let mut c = sample_card("c", "ws", KanbanColumnId::Complete);
        c.worktree_path = Some("/nonexistent/path/that/should/not/exist".into());
        c.branch_name = Some("card/whatever".into());
        assert!(!card_has_worktree_changes(&c, "main"));
    }

    /// GH #191: a card that changed nothing is not shippable just because
    /// this Mac's local target is behind origin — the gate diffs from the
    /// card's own base, as Outcome counts.
    #[test]
    fn card_has_worktree_changes_ignores_a_local_target_behind_origin() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let git = |dir: &Path, args: &[&str]| crate::git::capture(dir, args).unwrap();
        let (seed, origin, ws, other, wt) = (
            root.join("seed"),
            root.join("origin.git"),
            root.join("ws"),
            root.join("other"),
            root.join("wt"),
        );
        std::fs::create_dir(&seed).unwrap();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "t@t"],
            &["config", "user.name", "t"],
            &["config", "commit.gpgsign", "false"],
            &["commit", "--allow-empty", "-q", "-m", "init"],
        ] {
            git(&seed, args);
        }
        let s = |p: &Path| p.to_str().unwrap().to_string();
        git(root, &["clone", "-q", "--bare", &s(&seed), &s(&origin)]);
        for dir in [&ws, &other] {
            git(root, &["clone", "-q", &s(&origin), &s(dir)]);
            git(dir, &["config", "user.email", "t@t"]);
            git(dir, &["config", "user.name", "t"]);
            git(dir, &["config", "commit.gpgsign", "false"]);
        }
        for i in 0..3 {
            std::fs::write(other.join(format!("up-{i}.txt")), "x\n").unwrap();
            git(&other, &["add", "."]);
            git(&other, &["commit", "-q", "-m", "upstream"]);
        }
        git(&other, &["push", "-q", "origin", "main"]);
        git(&ws, &["fetch", "-q", "origin"]);
        git(&ws, &["worktree", "add", "-q", "-b", "card", &s(&wt), "origin/main"]);
        let base = git(&ws, &["rev-parse", "origin/main"]).trim().to_string();

        let mut c = sample_card("c", "ws", KanbanColumnId::Complete);
        c.worktree_path = Some(s(&wt));
        c.branch_name = Some("card".into());
        assert!(!card_has_worktree_changes(&c, "main"), "no recorded base");
        c.worktree_base = Some(crate::worktrees::WorktreeBase {
            commit: base,
            ref_name: "origin/main".into(),
            source: crate::worktrees::BaseSource::Origin,
            note: None, origin_slug: None, origin_url: None, merged_target: None,
        });
        assert!(!card_has_worktree_changes(&c, "main"), "recorded base");

        assert!(
            no_changes_to_ship_message(&c, "main").ends_with("has no changes in its copy to ship")
        );

        std::fs::write(wt.join("card.txt"), "x\n").unwrap();
        git(&wt, &["add", "."]);
        git(&wt, &["commit", "-q", "-m", "card work"]);
        assert!(card_has_worktree_changes(&c, "main"));

        // Merged into origin (another Mac, say) while local main is stale:
        // nothing to ship, and Ship batch says where the work already is.
        git(&wt, &["push", "-q", "origin", "card:main"]);
        git(&ws, &["fetch", "-q", "origin"]);
        // Ship batch's gate asks origin, which now holds the card's work.
        assert!(!card_has_worktree_changes_verified(&c, "main"));
        // The badge follows that answer without asking again.
        assert!(!card_has_worktree_changes(&c, "main"));
        assert_eq!(
            no_changes_to_ship_message(&c, "main"),
            "ship_batch blocked: card `c` is already in origin/main — nothing to ship"
        );
    }

    /// QoL 1.168 S1-4: the audit reads the shipped project's own version —
    /// its version file (any kind, in config order), then package.json, then
    /// its latest vX.Y.Z tag, else 0.0.0 — never Plyloft's.
    #[test]
    fn the_audit_version_is_the_shipped_projects_own() {
        let tmp = tempdir().unwrap();
        let repo = tmp.path();
        let git = |args: &[&str]| {
            let ok = crate::platform::git_command().args(args).current_dir(repo).status().unwrap();
            assert!(ok.success(), "git {args:?}");
        };
        git(&["init", "-q", "-b", "trunk"]);
        git(&["config", "user.email", "t@t"]);
        git(&["config", "user.name", "t"]);
        git(&["config", "commit.gpgsign", "false"]);
        let config: ProjectConfig = serde_json::from_value(serde_json::json!({
            "schemaVersion": 2,
            "targetBranch": "trunk",
            "versionFiles": [
                { "path": "missing.json", "kind": "package_json" },
                { "path": "Cargo.toml", "kind": "cargo_toml" }
            ],
            "createdAt": 0,
            "updatedAt": 0,
        }))
        .unwrap();

        // Nothing at all: 0.0.0, no source.
        assert_eq!(audit_version(repo, Some(&config), ""), ("0.0.0".to_string(), None));
        // A tag.
        git(&["commit", "--allow-empty", "-q", "-m", "init"]);
        git(&["tag", "v2.3.4"]);
        assert_eq!(audit_version(repo, Some(&config), ""), ("2.3.4".to_string(), Some("tag".to_string())));
        // The highest tag by version, not the latest made.
        git(&["tag", "v2.10.0"]);
        git(&["commit", "--allow-empty", "-q", "-m", "later"]);
        git(&["tag", "v2.9.9"]);
        assert_eq!(audit_version(repo, Some(&config), ""), ("2.10.0".to_string(), Some("tag".to_string())));
        // A package.json the ship doesn't bump (not in the settings) is not
        // what it says.
        std::fs::write(repo.join("package.json"), "{\"version\": \"0.9.0\"}\n").unwrap();
        assert_eq!(audit_version(repo, Some(&config), ""), ("2.10.0".to_string(), Some("tag".to_string())));
        // The config's own file, past a missing first one, beats package.json.
        std::fs::write(repo.join("Cargo.toml"), "[package]\nname = \"x\"\nversion = \"5.0.1\"\n").unwrap();
        assert_eq!(
            audit_version(repo, Some(&config), ""),
            ("5.0.1".to_string(), Some("Cargo.toml".to_string()))
        );
        // No config yet: package.json, as before.
        assert_eq!(audit_version(repo, None, ""), ("0.9.0".to_string(), Some("package.json".to_string())));
        // Not Plyloft's install: no relaunch.
        let with_script = ProjectConfig { install_script: Some("scripts/install-local.sh".into()), ..config };
        assert_eq!(install_outcome(repo, &with_script), (Some("scripts/install-local.sh".into()), false));
    }

    /// QoL 1.168 S1-4: only Plyloft's own repository relaunches.
    #[test]
    fn only_plyloft_s_own_install_relaunches() {
        let tmp = tempdir().unwrap();
        let repo = tmp.path();
        std::fs::create_dir_all(repo.join("src-tauri")).unwrap();
        std::fs::write(repo.join("package.json"), "{\"version\": \"1.0.0\"}").unwrap();
        std::fs::write(repo.join("src-tauri/tauri.conf.json"), "{\"identifier\": \"com.mbadv.ply\"}").unwrap();
        let config = crate::project_config::default_atelier_config();
        assert_eq!(install_outcome(repo, &config), (Some("scripts/install-local.sh".into()), true));
        let none = ProjectConfig { install_script: None, ..config };
        assert_eq!(install_outcome(repo, &none), (None, false));
    }

    /// QoL 1.168 C7: the list behind every "Ship N" groups by workspace and
    /// leaves out a workspace with none; its total is the count.
    #[test]
    fn pending_ship_cards_group_by_workspace() {
        let tmp = tempdir().unwrap();
        let kanban = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let project_config = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        let ready = |id: &str, ws: &str| {
            let mut c = sample_card(id, ws, KanbanColumnId::Complete);
            c.verify_status = VerifyStatus::Passed;
            c
        };
        kanban.save("ws-A", vec![ready("a1", "ws-A"), ready("a2", "ws-A")]).unwrap();
        kanban.save("ws-B", vec![sample_card("b1", "ws-B", KanbanColumnId::Todo)]).unwrap();
        kanban.save("ws-C", vec![ready("c1", "ws-C")]).unwrap();
        let ids = ["ws-A".to_string(), "ws-B".to_string(), "ws-C".to_string()];
        let list = pending_ship_cards_with(&kanban, &ids, &project_config, |_, _| true);
        assert_eq!(
            list,
            vec![
                PendingShipCards { workspace_id: "ws-A".into(), card_ids: vec!["a1".into(), "a2".into()], areas: vec![] },
                PendingShipCards { workspace_id: "ws-C".into(), card_ids: vec!["c1".into()], areas: vec![] },
            ]
        );
        assert_eq!(pending_ship_count_with(&kanban, &ids, &project_config, |_, _| true), 3);
    }

    /// End-to-end through the kanban store: the IO glue + pure predicate
    /// agree. All cards here are legacy (no `worktree_path`), so the
    /// worktree check is a no-op `true` and we exercise the metadata gates.
    #[test]
    fn pending_ship_count_only_counts_verified_unshipped() {
        let tmp = tempdir().unwrap();
        let kanban = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let project_config =
            ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        let mut cards = Vec::new();
        for i in 0..7 {
            let mut c = sample_card(&format!("c{i}"), "ws-A", KanbanColumnId::Complete);
            // c0: passed + unshipped → counts
            // c1: shipped → does not count
            // c2: legacy (migrated) → does not count
            // c3: passed + unshipped → counts
            // c4: in todo column → does not count
            // c5: not yet verified (None) → does not count (Phase B gate)
            // c6: archived Complete+Unshipped+Passed → does NOT count (v1.34.x)
            match i {
                0 | 3 => c.verify_status = VerifyStatus::Passed,
                1 => {
                    c.verify_status = VerifyStatus::Passed;
                    c.ship_status = ShipStatus::Shipped;
                }
                2 => c.verify_status = VerifyStatus::Legacy,
                4 => c.column_id = KanbanColumnId::Todo,
                5 => c.verify_status = VerifyStatus::None,
                6 => {
                    c.verify_status = VerifyStatus::Passed;
                    c.archived = true;
                }
                _ => {}
            }
            cards.push(c);
        }
        kanban.save("ws-A", cards).unwrap();
        let count =
            pending_ship_count(&kanban, &["ws-A".to_string()], &project_config);
        assert_eq!(count, 2);

        // GH #191 review: the git probe runs only for the two cards that pass
        // the metadata gates; the count is the same.
        let mut probed = Vec::new();
        let count = pending_ship_count_with(
            &kanban,
            &["ws-A".to_string()],
            &project_config,
            |c, _| {
                probed.push(c.id.clone());
                true
            },
        );
        assert_eq!(count, 2);
        assert_eq!(probed, vec!["c0".to_string(), "c3".to_string()]);
    }

    /// GH #242: a card that landed as a merged pull request and a Builder
    /// card whose worktree is gone never count, and the git probe never runs
    /// for them. A non-Builder card whose handle was cleared still ships the
    /// bump (GH #196, `land_untracked_tests`), so it still counts.
    #[test]
    fn pending_ship_count_skips_landed_and_worktreeless_cards() {
        let tmp = tempdir().unwrap();
        let kanban = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let project_config = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        let verified = |id: &str| {
            let mut c = sample_card(id, "ws-A", KanbanColumnId::Complete);
            c.verify_status = VerifyStatus::Passed;
            c
        };
        let legacy = verified("legacy");
        let mut worktree = verified("worktree");
        worktree.created_at = WORKTREE_FLOW_EPOCH_MS + 1;
        worktree.worktree_path = Some("/wt".into());
        worktree.branch_name = Some("card/wt".into());
        let mut merged = verified("merged");
        merged.review_status = Some(crate::kanban::ReviewStatus::Merged);
        merged.pr_url = Some("https://github.com/o/r/pull/9".into());
        let mut cleared = verified("cleared");
        cleared.created_at = WORKTREE_FLOW_EPOCH_MS + 1;
        let mut builder: KanbanCard = serde_json::from_value(serde_json::json!({
            "id": "builder", "workspaceId": "ws-A", "title": "builder",
            "columnId": "complete", "verifyStatus": "passed",
            "createdAt": 1, "updatedAt": 1,
            "builder": { "vendor": "claude" }
        }))
        .unwrap();
        builder.worktree_path = None;
        assert!(builder.builder.is_some());
        kanban
            .save("ws-A", vec![legacy, worktree, merged, cleared, builder])
            .unwrap();
        let mut probed = Vec::new();
        let count = pending_ship_count_with(
            &kanban,
            &["ws-A".to_string()],
            &project_config,
            |c, _| {
                probed.push(c.id.clone());
                true
            },
        );
        assert_eq!(count, 3);
        assert_eq!(
            probed,
            vec!["legacy".to_string(), "worktree".to_string(), "cleared".to_string()]
        );
    }

    /// UX P1 point 2 (P-A): a card whose local ship stopped on a conflict is
    /// not counted for the batch (header "Ship N", the sidebar, the Command
    /// palette's "Ship batch · N cards") and the git probe never runs for
    /// it; the verified card beside it still counts. Same rule as
    /// `boardSemantics.ts::isShipBatchEligible` (its test holds it).
    #[test]
    fn pending_ship_count_leaves_out_a_card_stopped_on_a_conflict() {
        let tmp = tempdir().unwrap();
        let kanban = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let project_config = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        let verified = |id: &str| {
            let mut c = sample_card(id, "ws-A", KanbanColumnId::Complete);
            c.verify_status = VerifyStatus::Passed;
            c
        };
        let ready = verified("ready");
        let mut conflict = verified("conflict");
        conflict.review_status = Some(crate::kanban::ReviewStatus::ConflictBlocked);
        assert!(!passes_pending_ship_metadata(&conflict));
        assert!(passes_pending_ship_metadata(&ready));
        kanban.save("ws-A", vec![ready, conflict]).unwrap();
        let mut probed = Vec::new();
        let count = pending_ship_count_with(
            &kanban,
            &["ws-A".to_string()],
            &project_config,
            |c, _| {
                probed.push(c.id.clone());
                true
            },
        );
        assert_eq!(count, 1);
        assert_eq!(probed, vec!["ready".to_string()]);
    }

    /// 1.171.0 F1 (K1): a Builder card approved on its last round with its
    /// session closed goes in the batch from In progress; one with its
    /// session open, unreviewed, under a standing request for changes, not
    /// saved, or built by both is left out with its reason. A skipped review
    /// (the person's decision) counts as Ship it counts it.
    #[test]
    fn the_batch_takes_an_approved_builder_card_with_its_session_closed() {
        let builder_card = |id: &str, pty: Option<&str>, review: &str| -> KanbanCard {
            let pty = pty.map_or("null".to_string(), |p| format!("\"{p}\""));
            serde_json::from_str(&format!(
                r#"{{"id":"{id}","workspaceId":"ws-A","title":"{id}","columnId":"in_progress","createdAt":0,"updatedAt":0,
                    "verifyStatus":"passed","worktreePath":"/wt/{id}","branchName":"plyloft/{id}",
                    "builder":{{"vendor":"claude","ptyId":{pty},"snapshots":[{{"n":1,"sha":"a","at":1}},{{"n":2,"sha":"b","at":2}}],"review":{review}}}}}"#
            ))
            .unwrap()
        };
        let approved = r#"{"snapshotN":2,"provider":"claude","status":"done","verdict":"approve","reviewedRevision":"b","at":1}"#;
        let ready = builder_card("ready", None, approved);
        assert_eq!(batch_builder_refusal(&ready), None);
        assert!(passes_pending_ship_metadata(&ready));

        let skipped = builder_card("skipped", None, r#"{"snapshotN":2,"provider":"claude","status":"skipped","at":1}"#);
        // Owner 2026-10-27 (C3): a skipped review counts as unreviewed.
        assert_eq!(batch_builder_refusal(&skipped).as_deref(), Some(BATCH_NOT_APPROVED), "a skipped review is unreviewed");

        let open = builder_card("open", Some("pty-1"), approved);
        assert_eq!(batch_builder_refusal(&open).as_deref(), Some(BATCH_SESSION_OPEN));
        assert!(!passes_pending_ship_metadata(&open));

        let old_round = builder_card(
            "old",
            None,
            r#"{"snapshotN":1,"provider":"claude","status":"done","verdict":"approve","reviewedRevision":"a","at":1}"#,
        );
        assert_eq!(batch_builder_refusal(&old_round).as_deref(), Some(BATCH_NOT_APPROVED));
        let changes = builder_card(
            "changes",
            None,
            r#"{"snapshotN":2,"provider":"claude","status":"done","verdict":"changes_requested","reviewedRevision":"b","at":1}"#,
        );
        assert_eq!(batch_builder_refusal(&changes).as_deref(), Some(BATCH_NOT_APPROVED));
        let running = builder_card("running", None, r#"{"snapshotN":2,"provider":"claude","status":"running","at":1}"#);
        assert_eq!(batch_builder_refusal(&running).as_deref(), Some(BATCH_NOT_APPROVED));
        let none = builder_card("none", None, "null");
        assert_eq!(batch_builder_refusal(&none).as_deref(), Some(BATCH_NOT_APPROVED));
        for c in [&old_round, &changes, &running, &none] {
            assert!(!passes_pending_ship_metadata(c), "{}", c.id);
        }

        let mut unsaved = ready.clone();
        unsaved.builder.as_mut().unwrap().snapshots.clear();
        assert_eq!(batch_builder_refusal(&unsaved).as_deref(), Some(BATCH_NOT_SAVED));

        // The other gates still hold for it.
        let mut failed = ready.clone();
        failed.verify_status = VerifyStatus::Failed;
        assert!(!passes_pending_ship_metadata(&failed));
        let mut gone = ready.clone();
        gone.worktree_path = None;
        assert!(!passes_pending_ship_metadata(&gone));
        // A card without a Builder still needs Complete.
        let mut plain = sample_card("plain", "ws-A", KanbanColumnId::InProgress);
        plain.verify_status = VerifyStatus::Passed;
        assert!(!passes_pending_ship_metadata(&plain));
        assert_eq!(batch_builder_refusal(&plain), None);

        // The list probes only the card it can take.
        let tmp = tempdir().unwrap();
        let kanban = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        let project_config = ProjectConfigStore::new(tmp.path().to_path_buf()).unwrap();
        kanban.save("ws-A", vec![ready, open, changes, plain]).unwrap();
        let mut probed = Vec::new();
        let cards = pending_ship_cards_with(&kanban, &["ws-A".to_string()], &project_config, |c, _| {
            probed.push(c.id.clone());
            true
        });
        assert_eq!(probed, vec!["ready".to_string()]);
        assert_eq!(cards, vec![PendingShipCards { workspace_id: "ws-A".into(), card_ids: vec!["ready".into()], areas: vec![] }]);
    }

    /// 1.171.0 F1 (Challenger 5): a released Builder card (a batch's
    /// included) owes its Builder no verdict and keeps Ship's receipt line,
    /// as Ship it's `record_shipped_unreviewed` does; `mark_released` runs it.
    #[test]
    fn a_released_builder_card_is_settled_like_ship_it() {
        let mut card: KanbanCard = serde_json::from_str(
            r#"{"id":"c","workspaceId":"ws-A","title":"c","columnId":"in_progress","createdAt":0,"updatedAt":0,
                "builder":{"vendor":"claude","snapshots":[{"n":1,"sha":"a","at":1}],
                    "review":{"snapshotN":1,"provider":"claude","status":"done","verdict":"approve","reviewedRevision":"a","at":1},
                    "shippedUnreviewed":"stale line",
                    "undeliveredVerdict":{"snapshotN":1,"at":1}}}"#,
        )
        .unwrap();
        assert!(card.builder.as_ref().unwrap().undelivered_verdict.is_some());
        settle_released_builder(&mut card);
        let b = card.builder.as_ref().unwrap();
        assert_eq!((b.shipped_unreviewed.as_deref(), b.undelivered_verdict.is_none()), (None, true));
        // Unreviewed (a Release… of it): the receipt says so.
        let mut unreviewed = card.clone();
        unreviewed.builder.as_mut().unwrap().review = None;
        settle_released_builder(&mut unreviewed);
        assert!(unreviewed.builder.as_ref().unwrap().shipped_unreviewed.as_deref().is_some_and(|l| l.contains("not reviewed")));
        // No Builder: untouched.
        let mut plain = sample_card("p", "ws-A", KanbanColumnId::Complete);
        settle_released_builder(&mut plain);
        assert!(plain.builder.is_none());
        let source = include_str!("ship.rs");
        let (_, body) = source.split_once("fn mark_released<").unwrap();
        let (body, _) = body.split_once("crate::kanban::emit_kanban_changed").unwrap();
        assert!(body.contains("settle_released_builder(card);"));
    }

    /// 1.171.0 F1: the list's git check for a Builder card from In progress
    /// asks that its copy is exactly its saved work — a commit or an edit
    /// after it is left out.
    #[test]
    fn the_batch_leaves_out_a_builder_copy_moved_past_its_saved_work() {
        let repo = tempdir().unwrap();
        let git = |args: &[&str]| crate::git::run(repo.path(), args).unwrap();
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "t@t"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(repo.path().join("a.txt"), "a").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "base"]);
        git(&["checkout", "-qb", "plyloft/c"]);
        std::fs::write(repo.path().join("a.txt"), "b").unwrap();
        git(&["commit", "-qam", "work"]);
        let saved = crate::worktrees::head_sha(repo.path()).unwrap();
        let mut card: KanbanCard = serde_json::from_str(&format!(
            r#"{{"id":"c","workspaceId":"ws-A","title":"c","columnId":"in_progress","createdAt":0,"updatedAt":0,
                "verifyStatus":"passed","worktreePath":"{}","branchName":"plyloft/c",
                "builder":{{"vendor":"claude","snapshots":[{{"n":1,"sha":"{saved}","at":1}}],
                    "review":{{"snapshotN":1,"provider":"claude","status":"done","verdict":"approve","reviewedRevision":"{saved}","at":1}}}}}}"#,
            repo.path().display()
        ))
        .unwrap();
        assert!(batch_ready_on_disk(&card, "main"));
        std::fs::write(repo.path().join("a.txt"), "c").unwrap();
        assert!(!batch_ready_on_disk(&card, "main"), "an edit after the saved work");
        git(&["commit", "-qam", "more"]);
        assert!(!batch_ready_on_disk(&card, "main"), "a commit after the saved work");
        // In Complete the old rule stands (Ship's own check refuses it there).
        card.column_id = KanbanColumnId::Complete;
        assert!(batch_ready_on_disk(&card, "main"));
    }

    /// v1.34.x: the small kanban-update helper called by
    /// `commands::land_card_local` (Outcome-screen Ship-it) and
    /// `kanban::reconcile_ship_backfill` (startup pass) must transition
    /// the card to the same on-disk shape that legacy `ship_card`
    /// produces: `Shipped` + commit_sha + shipped_version + one fresh
    /// `ShipEntry` + worktree handle cleared. `verify_status` is
    /// preserved untouched (the verify gate sets it earlier; the land
    /// path must not clobber it).
    #[test]
    fn mark_card_shipped_local_writes_full_ship_state() {
        let mut card = sample_card("c", "ws", KanbanColumnId::Complete);
        card.verify_status = VerifyStatus::Passed;
        card.worktree_path = Some("/some/path".into());
        card.branch_name = Some("atelier/card-x".into());
        card.worktree_base = Some(crate::worktrees::WorktreeBase {
            commit: "base".into(),
            ref_name: "origin/develop".into(),
            source: crate::worktrees::BaseSource::Origin,
            note: None, origin_slug: None, origin_url: None, merged_target: None,
        });

        mark_card_shipped_local(&mut card, "deadbeef", "v9.9.9");
        // 1.171.0 B2: where it shipped outlives the cleared worktree_base.
        assert_eq!(card.ship_history[0].target.as_deref(), Some("develop"));
        assert!(card.worktree_base.is_none());

        assert_eq!(card.ship_status, ShipStatus::Shipped);
        assert_eq!(card.commit_sha.as_deref(), Some("deadbeef"));
        assert_eq!(card.shipped_version.as_deref(), Some("v9.9.9"));
        assert_eq!(card.ship_history.len(), 1);
        assert_eq!(card.ship_history[0].commit_sha, "deadbeef");
        assert_eq!(card.ship_history[0].shipped_version, "v9.9.9");
        assert_eq!(card.ship_history[0].release_kind, ReleaseKind::Local);
        assert!(card.worktree_path.is_none());
        assert!(card.branch_name.is_none());
        // verify_status must NOT be overwritten — it's set by the gate
        // upstream and the land path has no authority over it.
        assert_eq!(card.verify_status, VerifyStatus::Passed);
    }

    fn sample_card(id: &str, ws: &str, col: KanbanColumnId) -> KanbanCard {
        KanbanCard {
            id: id.to_string(),
            workspace_id: ws.to_string(),
            title: id.to_string(),
            notes: None,
            knowledge: None,
            column_id: col,
            agent_config_id: None,
            linked_run_id: None,
            last_run_status: None,
            swarm_template_id: None,
            linked_swarm_id: None,
            linked_brainstorm_id: None,
            dismissed_banners: Vec::new(),
            run_history: Vec::new(),
            suppress_run_history: false,
            builder: None,
            plan_challenge: None,
            dispatch_prompt: None,
            dispatch_prompt_edited_at: None,
            intake_status: crate::kanban::IntakeStatus::None,
            intake_history: Vec::new(),
            archived: false,
            archived_at: None,
            auto_archived: false,
            put_backs: Vec::new(),
            verify_intent: None,
            verify_status: VerifyStatus::None,
            verify_history: Vec::new(),
            ship_status: ShipStatus::Unshipped,
            ship_history: Vec::new(),
            commit_sha: None,
            shipped_version: None,
            attachments: Vec::new(),
            worktree_path: None,
            branch_name: None,
            worktree_base: None,
            review_status: None,
            ship_conflict: None,
            review_decisions: Vec::new(),
            pr_url: None,
            pr: None,
            parent_card_id: None,
            gh_issue_number: None,
            sync_pending: false,
            gh_raw_remainder: None,
            gh_assignees: Vec::new(),
            gh_author: None,
            gh_claim: None,
            gh_claim_here: false,
            gh_claim_lost_to: None,
            gh_labels_pending: false,
            gh_last_read: None,
            edit_conflicts: Vec::new(),
            unassign_pending: false,
            gh_author_association: None,
            gh_last_editor: None,
            board_order: None,
            blocked_by: Vec::new(),
            builder_vendor_pref: None,
            builder_permissions: None,
            models: None,
            model_retries: Vec::new(),
            worktree_setup: None,
            checks_hold: None,
            port_base: None,
            build_both: None,
            line_comments: Vec::new(),
            branch_cleanup: None,
            kept_copy: None,
            follows_up: None,
            followed_up_by: Vec::new(),
            pr_review: None,
            pr_auto_fix: None,
            fix_round_check: None,
            fix_round_self_checks: 0,
            kind: None,
            twins_aligned: Vec::new(),
            twins_apart: Vec::new(),
            later_requests: Vec::new(),
            area: None,
            gh_area_label: None,
            from_copy: None,
            author: None,
            last_edited_by: None,
            created_at: 1,
            updated_at: 1,
        }
    }
}

#[cfg(test)]
#[path = "ship_area_tests.rs"]
mod ship_area_tests;
