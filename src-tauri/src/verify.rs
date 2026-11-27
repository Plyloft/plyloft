//! v1.10.x (Phase B): cheap verify gate.
//!
//! Pipeline (Phase B):
//!   1. `cargo test --lib` (5min timeout)
//!   2. `bash <ppvp.sh from HEAD>` (2min timeout) — read via
//!      `git show HEAD:scripts/ppvp.sh` to a temp file so a card that
//!      modifies ppvp.sh doesn't gate against its own broken edit
//!      (decision 14).
//!
//! Phase C adds the sandbox `tauri build`. Phase D adds Claude-as-QA.
//!
//! Concurrency (decision 11): exactly one verify runs at a time across
//! all workspaces. New verify_start calls queue. The active worker drains
//! the queue when it finishes.
//!
//! State machine:
//!   `Queued` → `Running { step }` → `Passed` | `Failed { reason }` |
//!   `TimedOut { step }` | `CapacityStall` (Phase D — placeholder here).
//!
//! `Passed` flips the card's `verify_status` to `Passed`; `Failed`
//! flips it to `Failed`. The kanban write is atomic (Hard Rule #3).

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter};

use crate::kanban::{
    KanbanStore, VerifyEntry, VerifyStatus, VerifyStepResult,
};
use crate::project_config::{ProjectConfigStore, VerifyKind};
use crate::workspace::WorkspaceStore;

const CARGO_TIMEOUT_SECS: u64 = 5 * 60;
const PPVP_TIMEOUT_SECS: u64 = 2 * 60;
/// v1.13.6: per-step timeout for config-driven verify pipelines. Used
/// when a project's `verify_pipeline` runs a `Script` entry. Same
/// budget as PPVP_TIMEOUT_SECS — scripts that need longer should be
/// split into multiple Vec entries.
const CONFIG_PIPELINE_STEP_TIMEOUT_SECS: u64 = 10 * 60;
/// Cap on the verify-history vec per card. Mirrors `MAX_HISTORY_ENTRIES`
/// for run_history.
const MAX_VERIFY_HISTORY: usize = 10;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyJobStatus {
    pub verify_run_id: String,
    pub workspace_id: String,
    pub card_id: String,
    pub state: VerifyStateOut,
    /// Steps completed so far + the active step (if running).
    pub steps: Vec<VerifyStepResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum VerifyStateOut {
    Queued { position: usize },
    Running { step: String, started_at: i64 },
    Passed,
    Failed { reason: String },
    TimedOut { step: String },
    /// v1.12.x (Phase D, decision 17): the underlying claude CLI hit a
    /// Max-plan session-cap or auth issue. The pipeline halts WITHOUT
    /// counting this as a real fail — the user retries when capacity
    /// frees up. No fix swarm is auto-spawned for capacity stalls.
    CapacityStall { detail: String },
}

/// v1.12.x (Phase D): regex-ish substring match against stderr output to
/// detect Claude Max-plan capacity limits. Conservative — only patterns
/// we've seen in the wild qualify so we don't false-positive into stalls
/// for unrelated auth failures.
fn detect_capacity_stall(output: &str) -> Option<String> {
    const PATTERNS: &[&str] = &[
        "Max plan session limit reached",
        "session limit reached",
        "Anthropic credit balance is too low",
        "rate_limit_error",
    ];
    for p in PATTERNS {
        if output.contains(p) {
            return Some((*p).to_string());
        }
    }
    None
}

/// What the IPC payload looks like for `verify_start`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyRequest {
    pub workspace_id: String,
    pub card_id: String,
    /// v1.58.0 (Phase 4): true only for the post-swarm auto-verify, which
    /// should post a card-outcome comment (with the test result) to the
    /// backing GitHub issue when it finishes. Manual "Verify now" runs leave
    /// this `false` (serde default) so a re-verify doesn't spam the issue.
    #[serde(default)]
    pub post_outcome_issue: bool,
}

#[derive(Debug, Clone)]
struct VerifyJob {
    verify_run_id: String,
    workspace_id: String,
    card_id: String,
    repo_root: PathBuf,
    post_outcome_issue: bool,
    /// Content tree the pipeline started on (see `VerifyEntry::tree_sha`);
    /// filled in by `run_pipeline`.
    start_tree: Option<String>,
    /// `CARGO_TARGET_DIR` for the shared build cache when `repo_root` is a
    /// card worktree and the target was reset for it (see `build_cache`);
    /// filled in by `run_pipeline`.
    build_env: Vec<(String, String)>,
    /// Round 2 (G5): the card's verify status before this run was queued
    /// — what a run held for the checks' OK puts back.
    status_before: Option<VerifyStatus>,
}

/// The content a finished run may claim to have verified: the tree it
/// started on, provided nothing changed while it ran.
fn examined_tree(start_tree: Option<&str>, repo_root: &Path) -> Option<String> {
    let start = start_tree?;
    (crate::worktrees::content_tree_sha(repo_root).ok().as_deref() == Some(start))
        .then(|| start.to_string())
}

/// The latest Verify result recorded against exactly `tree` (a content
/// tree, see `VerifyEntry::tree_sha`): Some(true) passed, Some(false)
/// failed, None never examined.
pub(crate) fn verify_result_on(tree: &str, history: &[VerifyEntry]) -> Option<bool> {
    history
        .iter()
        .rev()
        .find(|e| e.tree_sha.as_deref() == Some(tree))
        .map(|e| matches!(e.status, VerifyStatus::Passed))
}

/// Ship publishes `head_sha` only once Verify passed on exactly its
/// content `tree` — a pass on other content (an earlier or later state of
/// the same worktree) does not count.
pub(crate) fn require_verified_commit(
    head_sha: &str,
    tree: &str,
    verify_in_flight: bool,
    history: &[VerifyEntry],
) -> Result<(), String> {
    let short = &head_sha[..head_sha.len().min(8)];
    if verify_in_flight {
        return Err(format!(
            "Verify is still running on {short}, the commit Ship would publish — Ship once it passes"
        ));
    }
    match verify_result_on(tree, history) {
        Some(true) => Ok(()),
        Some(false) => Err(format!(
            "Verify failed on {short}, the commit Ship would publish — fix it and verify again, then Ship"
        )),
        None => Err(format!(
            "Verify has not run on {short}, the commit Ship would publish — run Verify, then Ship"
        )),
    }
}

#[derive(Debug, Clone)]
struct ActiveJob {
    job: VerifyJob,
    state: VerifyStateOut,
    steps: Vec<VerifyStepResult>,
    started_at: i64,
}

#[derive(Clone, Default)]
pub struct VerifyRegistry {
    inner: Arc<Mutex<VerifyInner>>,
}

#[derive(Default)]
struct VerifyInner {
    /// FIFO queue of pending jobs.
    queue: VecDeque<VerifyJob>,
    /// Currently-running job (if any).
    active: Option<ActiveJob>,
    /// Most recent terminal status per workspace+card. Read by
    /// `verify_status` IPC so the frontend can display a freshly-cleared
    /// result.
    recent: HashMap<String, VerifyJobStatus>,
    /// Post-swarm auto-verifies that lost a race to card work. This is
    /// process-local intent, not a paid attempt and not persisted state.
    deferred_auto: HashSet<String>,
}

#[must_use = "dropping an unstarted deferred verification rolls back its registry record"]
pub(crate) struct DeferredVerify {
    inner: Arc<Mutex<VerifyInner>>,
    verify_run_id: String,
    starts_worker: bool,
    armed: bool,
}

impl DeferredVerify {
    pub(crate) fn run_id(&self) -> &str {
        &self.verify_run_id
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for DeferredVerify {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut inner = self.inner.lock();
        if inner
            .active
            .as_ref()
            .is_some_and(|active| active.job.verify_run_id == self.verify_run_id)
        {
            inner.active = None;
            return;
        }
        if let Some(index) = inner
            .queue
            .iter()
            .position(|job| job.verify_run_id == self.verify_run_id)
        {
            inner.queue.remove(index);
        }
    }
}

struct ActiveVerifyGuard {
    inner: Arc<Mutex<VerifyInner>>,
    verify_run_id: String,
    continue_with: Option<Box<dyn FnOnce(VerifyJob) + Send>>,
    armed: bool,
}

impl ActiveVerifyGuard {
    fn new(
        inner: Arc<Mutex<VerifyInner>>,
        verify_run_id: String,
        continue_with: impl FnOnce(VerifyJob) + Send + 'static,
    ) -> Self {
        Self {
            inner,
            verify_run_id,
            continue_with: Some(Box::new(continue_with)),
            armed: true,
        }
    }

    /// Preserve the historical normal-path drain timing. Drop invokes the
    /// same exact-ID drain only as a panic/forgotten-exit backstop.
    fn finish(&mut self) {
        if !self.armed {
            return;
        }
        self.armed = false;
        let next = {
            let mut inner = self.inner.lock();
            if !inner
                .active
                .as_ref()
                .is_some_and(|active| active.job.verify_run_id == self.verify_run_id)
            {
                log::error!(
                    "verify worker {} no longer owns the active registry slot",
                    self.verify_run_id
                );
                return;
            }
            inner.active = None;
            let next = inner.queue.pop_front();
            if let Some(job) = next.as_ref() {
                inner.active = Some(ActiveJob {
                    job: job.clone(),
                    state: VerifyStateOut::Queued { position: 0 },
                    steps: Vec::new(),
                    started_at: now_millis(),
                });
            }
            next
        };
        if let (Some(job), Some(continue_with)) = (next, self.continue_with.take()) {
            continue_with(job);
        }
    }
}

impl Drop for ActiveVerifyGuard {
    fn drop(&mut self) {
        self.finish();
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn job_key(workspace_id: &str, card_id: &str) -> String {
    format!("{workspace_id}::{card_id}")
}

impl VerifyRegistry {
    /// Publish a verify job into the authoritative active/queued registry
    /// without launching its worker. The card-execution gate uses this split
    /// so opposing work sees the job before the gate is released, while no
    /// check subprocess can start under that gate.
    pub(crate) fn enqueue_deferred(
        &self,
        kanban: &KanbanStore,
        workspaces: &WorkspaceStore,
        req: VerifyRequest,
    ) -> Result<DeferredVerify, String> {
        // Resolve repo root. v1.31.0 (Outcome screen): when the card has a
        // per-card git worktree, verify there — the swarm's changes live in
        // the worktree, unmerged, so verifying `ws.cwd` would test the
        // unchanged main checkout. Falls back to the workspace cwd for cards
        // with no worktree.
        let snap = workspaces.snapshot();
        let ws = snap
            .workspaces
            .iter()
            .find(|w| w.id == req.workspace_id)
            .ok_or_else(|| format!("workspace not found: {}", req.workspace_id))?;
        let repo_root = match crate::build_both::parse_lane_key(&req.card_id) {
            // SL-6: one of the two builds of a card built by both — its own
            // worktree, never the main checkout.
            Some((card_id, lane)) => kanban
                .get_card(&req.workspace_id, card_id)
                .ok()
                .and_then(|c| c.build_both)
                .and_then(|bb| bb.lane(lane).map(|l| PathBuf::from(&l.worktree_path)))
                .filter(|p| p.is_dir())
                .ok_or_else(|| format!("That build's copy of the repository is gone ({}).", req.card_id))?,
            None => kanban
                .get_card(&req.workspace_id, &req.card_id)
                .ok()
                .and_then(|c| c.worktree_path)
                .map(PathBuf::from)
                .filter(|p| p.is_dir())
                .unwrap_or_else(|| PathBuf::from(&ws.cwd)),
        };

        let verify_run_id = format!("verify-{}", now_millis());
        let job = VerifyJob {
            verify_run_id: verify_run_id.clone(),
            workspace_id: req.workspace_id.clone(),
            card_id: req.card_id.clone(),
            repo_root,
            post_outcome_issue: req.post_outcome_issue,
            start_tree: None,
            status_before: None,
            build_env: Vec::new(),
        };

        let mut inner = self.inner.lock();
        // Any admitted verification for this card supersedes a previously
        // deferred automatic request, including a manual user retry.
        inner.deferred_auto.remove(&job_key(
            &job.workspace_id,
            &job.card_id,
        ));
        let starts_worker = inner.active.is_none();
        if starts_worker {
            // Publish the active record now; the caller starts its worker only
            // after releasing the card-execution gate.
            let job_clone = job.clone();
            inner.active = Some(ActiveJob {
                job: job_clone,
                state: VerifyStateOut::Queued { position: 0 },
                steps: Vec::new(),
                started_at: now_millis(),
            });
        } else {
            inner.queue.push_back(job);
        }
        Ok(DeferredVerify {
            inner: self.inner.clone(),
            verify_run_id,
            starts_worker,
            armed: true,
        })
    }

    pub(crate) fn start_deferred(
        &self,
        app: AppHandle,
        kanban: &KanbanStore,
        mut deferred: DeferredVerify,
    ) -> Result<(), String> {
        let job = {
            let inner = self.inner.lock();
            if deferred.starts_worker {
                inner.active.as_ref().and_then(|active| {
                    (active.job.verify_run_id == deferred.verify_run_id)
                        .then(|| active.job.clone())
                })
            } else {
                inner
                    .queue
                    .iter()
                    .find(|job| job.verify_run_id == deferred.verify_run_id)
                    .cloned()
            }
        };
        let Some(job) = job else {
            log::error!(
                "deferred verify {} no longer owns its registry slot",
                deferred.verify_run_id
            );
            return Err(format!(
                "verification {} lost its registry slot before launch",
                deferred.verify_run_id
            ));
        };

        // The registry is authoritative and was published under the card
        // gate. Update the persisted UI mirror only once that publication is
        // committed to start; dropping DeferredVerify before this point
        // therefore cannot leave a false Queued card behind.
        // Round 2 (G5): what the card said before it was queued, kept with
        // the job (here and in the registry's own copy): a run held for the
        // checks' OK puts exactly that back — a Skipped card stays Skipped.
        let before = kanban.get_card(&job.workspace_id, &job.card_id).ok().map(|card| card.verify_status);
        let mut job = job;
        job.status_before = before;
        {
            let mut inner = self.inner.lock();
            if let Some(active) = inner.active.as_mut().filter(|active| active.job.verify_run_id == job.verify_run_id) {
                active.job.status_before = before;
            }
            if let Some(queued) = inner.queue.iter_mut().find(|queued| queued.verify_run_id == job.verify_run_id) {
                queued.status_before = before;
            }
        }
        let _ = mark_card_queued(kanban, &job.workspace_id, &job.card_id);
        if deferred.starts_worker {
            self.spawn_worker(app, job);
        }
        deferred.disarm();
        Ok(())
    }

    /// Authoritative active/queued query. The persisted card field is only a
    /// best-effort UI mirror and must never be used as the interlock.
    pub fn is_inflight(&self, workspace_id: &str, card_id: &str) -> bool {
        let inner = self.inner.lock();
        inner
            .active
            .as_ref()
            .is_some_and(|active| {
                active.job.workspace_id == workspace_id && active.job.card_id == card_id
            })
            || inner
                .queue
                .iter()
                .any(|job| job.workspace_id == workspace_id && job.card_id == card_id)
    }

    pub(crate) fn defer_auto_verify(&self, workspace_id: &str, card_id: &str) {
        self.inner
            .lock()
            .deferred_auto
            .insert(job_key(workspace_id, card_id));
    }

    pub(crate) fn take_deferred_auto_verify(
        &self,
        workspace_id: &str,
        card_id: &str,
    ) -> bool {
        self.inner
            .lock()
            .deferred_auto
            .remove(&job_key(workspace_id, card_id))
    }

    #[cfg(test)]
    fn has_deferred_auto_verify(&self, workspace_id: &str, card_id: &str) -> bool {
        self.inner
            .lock()
            .deferred_auto
            .contains(&job_key(workspace_id, card_id))
    }

    pub fn status(
        &self,
        workspace_id: &str,
        card_id: &str,
    ) -> Option<VerifyJobStatus> {
        let inner = self.inner.lock();
        if let Some(active) = inner.active.as_ref() {
            if active.job.workspace_id == workspace_id
                && active.job.card_id == card_id
            {
                return Some(VerifyJobStatus {
                    verify_run_id: active.job.verify_run_id.clone(),
                    workspace_id: active.job.workspace_id.clone(),
                    card_id: active.job.card_id.clone(),
                    state: active.state.clone(),
                    steps: active.steps.clone(),
                });
            }
        }
        for (idx, q) in inner.queue.iter().enumerate() {
            if q.workspace_id == workspace_id && q.card_id == card_id {
                return Some(VerifyJobStatus {
                    verify_run_id: q.verify_run_id.clone(),
                    workspace_id: q.workspace_id.clone(),
                    card_id: q.card_id.clone(),
                    state: VerifyStateOut::Queued { position: idx + 1 },
                    steps: Vec::new(),
                });
            }
        }
        inner.recent.get(&job_key(workspace_id, card_id)).cloned()
    }

    /// Snapshot of all in-flight jobs (active + queued). Read by
    /// `ship_audit` so the audit modal warns when a verify is running.
    pub fn list_inflight(&self) -> Vec<VerifyJobStatus> {
        let inner = self.inner.lock();
        let mut out = Vec::new();
        if let Some(active) = inner.active.as_ref() {
            out.push(VerifyJobStatus {
                verify_run_id: active.job.verify_run_id.clone(),
                workspace_id: active.job.workspace_id.clone(),
                card_id: active.job.card_id.clone(),
                state: active.state.clone(),
                steps: active.steps.clone(),
            });
        }
        for (idx, q) in inner.queue.iter().enumerate() {
            out.push(VerifyJobStatus {
                verify_run_id: q.verify_run_id.clone(),
                workspace_id: q.workspace_id.clone(),
                card_id: q.card_id.clone(),
                state: VerifyStateOut::Queued { position: idx + 1 },
                steps: Vec::new(),
            });
        }
        out
    }

    pub fn count_inflight(&self) -> usize {
        let inner = self.inner.lock();
        let active = if inner.active.is_some() { 1 } else { 0 };
        active + inner.queue.len()
    }

    fn spawn_worker(&self, app: AppHandle, job: VerifyJob) {
        let inner = self.inner.clone();
        let registry = self.clone();
        thread::spawn(move || {
            let continuation_app = app.clone();
            let mut completion =
                ActiveVerifyGuard::new(inner.clone(), job.verify_run_id.clone(), move |next| {
                    registry.spawn_worker(continuation_app, next);
                });
            run_pipeline(app, job, inner, &mut completion);
        });
    }

    #[cfg(test)]
    pub(crate) fn set_inflight_for_test(
        &self,
        workspace_id: &str,
        card_id: &str,
        queued: bool,
    ) {
        let job = VerifyJob {
            verify_run_id: format!("verify-test-{workspace_id}-{card_id}-{queued}"),
            workspace_id: workspace_id.to_string(),
            card_id: card_id.to_string(),
            repo_root: PathBuf::new(),
            post_outcome_issue: false,
            start_tree: None,
            status_before: None,
            build_env: Vec::new(),
        };
        let mut inner = self.inner.lock();
        if queued {
            inner.queue.push_back(job);
        } else {
            inner.active = Some(ActiveJob {
                job,
                state: VerifyStateOut::Queued { position: 0 },
                steps: Vec::new(),
                started_at: now_millis(),
            });
        }
    }
}

fn mark_card_queued(
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
) -> Result<(), String> {
    // v1.33.0: atomic single-card RMW. Was `load()` + whole-board `save()`,
    // a window where a concurrent run-history append could be clobbered. A
    // missing card stays a silent no-op, as the old `if let Some` was.
    match kanban.with_card(workspace_id, card_id, |card| {
        card.verify_status = VerifyStatus::Queued;
        Ok(())
    }) {
        Ok(()) => Ok(()),
        Err(e) if e.contains("not found") => Ok(()),
        Err(e) => Err(e),
    }
}

fn run_pipeline(
    app: AppHandle,
    mut job: VerifyJob,
    inner: Arc<Mutex<VerifyInner>>,
    completion: &mut ActiveVerifyGuard,
) {
    use tauri::Manager;
    job.start_tree = crate::worktrees::content_tree_sha(&job.repo_root).ok();
    // The shared Cargo target, only once this card's own packages are
    // cleaned out of it (see `build_cache`). Anything short of that runs
    // on the worktree's own target.
    let shared = crate::build_cache::verify_env(&app, &job.workspace_id, &job.repo_root);
    // Held until this function returns, every early return included: the
    // Doctor's Clear can't remove the target under the run.
    let _shared_target = (!shared.is_empty()).then(crate::build_cache::hold_shared_target);
    if !shared.is_empty() {
        use crate::build_cache::SharedTarget;
        match crate::build_cache::reset_shared_target(&job.repo_root, &shared) {
            Ok(SharedTarget::Ready) => job.build_env = shared,
            Ok(SharedTarget::NoCargo) => {}
            Ok(SharedTarget::NotDeclared) => log::info!(
                "verify {}: shared build cache not used: the checkout has no {}",
                job.verify_run_id,
                crate::build_cache::OPT_IN_MARKER
            ),
            Err(e) => log::warn!(
                "verify {}: shared build cache not used, reset failed: {e}",
                job.verify_run_id
            ),
        }
    }

    // The card worktree's port block (`worktree_ports`), to every step:
    // a check that starts the app's server binds its own ports, not another
    // card's.
    job.build_env.extend(crate::worktree_ports::env_for_cwd(Some(&job.repo_root)));
    // Helper closures need to access KanbanStore via app state.
    let kanban_state = app.state::<KanbanStore>();
    // This run's full step logs replace the card's previous run's.
    let log_dir = crate::verify_logs::begin_run(&job.workspace_id, &job.card_id, &job.verify_run_id);

    // v1.13.6 (Cycle D finding G phase 2): config-driven verify
    // pipeline. When the workspace has a `project_config` with a
    // non-empty `verify_pipeline`, dispatch through that instead of
    // the hardcoded cargo+ppvp pair. The hardcoded pipeline remains
    // the fallback for workspaces without a project_config (e.g.,
    // not yet onboarded). For Atelier itself, the bootstrap config
    // sets `verify_pipeline: [Script { "scripts/ppvp.sh" }]`, so
    // Atelier verifies as a single script step (which internally
    // runs cargo + npm + tauri-build — equivalent coverage with
    // fewer FE rows).
    let project_config_state = app.state::<ProjectConfigStore>();
    if let Some(config) = project_config_state.get(&job.workspace_id) {
        match config.verify_pipeline {
            Some(ref pipeline) if !pipeline.is_empty() => {
                // 1.175.0 B2 (SEC-4): checks that reached this computer from
                // the branch and weren't allowed here don't run. The card is
                // left as it was, marked as waiting for the OK; no step
                // started, and nothing is written to its history.
                // Round 2 (G5): asked of the pipeline this run holds, the
                // one it is about to execute.
                if !crate::checks_consent::checks_allowed_for(&project_config_state, &job.workspace_id, pipeline) {
                    hold_for_consent(&app, &inner, &kanban_state, &job);
                    let _ = app.emit("verify://done", &job.verify_run_id);
                    finish_and_wake(&app, &job, completion);
                    return;
                }
                clear_checks_hold(&kanban_state, &job);
                run_config_pipeline(
                    &app,
                    &job,
                    &inner,
                    &kanban_state,
                    pipeline,
                    log_dir.as_deref(),
                    completion,
                );
                return;
            }
            _ => {
                // Empty / absent pipeline — onboarded project has
                // explicitly opted out of verify. Auto-pass with no
                // steps.
                set_running(&inner, "no-verify");
                let _ = app.emit("verify://progress", &job.verify_run_id);
                finalize_pass(&app, &inner, &kanban_state, &job);
                let _ = app.emit("verify://done", &job.verify_run_id);
                finish_and_wake(&app, &job, completion);
                return;
            }
        }
    }

    // No project_config: fall back to the hardcoded Atelier pipeline.

    // Mark Running: cargo-test
    set_running(&inner, "cargo-test");
    let _ = app.emit("verify://progress", &job.verify_run_id);
    let cargo_result = run_step(
        &job.repo_root,
        &["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml", "--lib"],
        Some("source $HOME/.cargo/env >/dev/null 2>&1; "),
        &job.build_env,
        CARGO_TIMEOUT_SECS,
        "cargo-test",
        log_dir.as_deref(),
    );
    push_step(&inner, cargo_result.clone());
    let _ = app.emit("verify://progress", &job.verify_run_id);

    if !cargo_result.passed {
        // Phase D: capacity-stall short-circuit — don't persist the
        // failure to the card if it's a Max-plan session cap.
        if let Some(detail) = cargo_result
            .reason
            .as_deref()
            .and_then(detect_capacity_stall)
        {
            finalize_capacity_stall(&inner, &job, detail);
            let _ = app.emit("verify://done", &job.verify_run_id);
            finish_and_wake(&app, &job, completion);
            return;
        }
        finalize_fail(
            &app,
            &inner,
            &kanban_state,
            &job,
            cargo_result.reason.clone().unwrap_or_default(),
        );
        let _ = app.emit("verify://done", &job.verify_run_id);
        finish_and_wake(&app, &job, completion);
        return;
    }

    // Mark Running: ppvp-sh (read from HEAD per decision 14)
    set_running(&inner, "ppvp-sh");
    let _ = app.emit("verify://progress", &job.verify_run_id);
    let ppvp_result = run_ppvp_from_head(&job.repo_root, &job.build_env, log_dir.as_deref());
    push_step(&inner, ppvp_result.clone());
    let _ = app.emit("verify://progress", &job.verify_run_id);

    if !ppvp_result.passed {
        if let Some(detail) = ppvp_result
            .reason
            .as_deref()
            .and_then(detect_capacity_stall)
        {
            finalize_capacity_stall(&inner, &job, detail);
            let _ = app.emit("verify://done", &job.verify_run_id);
            finish_and_wake(&app, &job, completion);
            return;
        }
        finalize_fail(
            &app,
            &inner,
            &kanban_state,
            &job,
            ppvp_result.reason.clone().unwrap_or_default(),
        );
        let _ = app.emit("verify://done", &job.verify_run_id);
        finish_and_wake(&app, &job, completion);
        return;
    }

    finalize_pass(&app, &inner, &kanban_state, &job);
    let _ = app.emit("verify://done", &job.verify_run_id);
    finish_and_wake(&app, &job, completion);
}

/// v1.13.6: drive the verify pipeline from `project_config.verify_pipeline`.
/// Iterates entries sequentially fail-fast. `Script` entries run via
/// `bash <path>` (workspace-relative); `SlashCommand` entries spawn `claude`
/// via PTY (v1.15.0 Cycle E1). The whole pipeline is cancellable via the
/// same path as the hardcoded pipeline (the `inner` registry).
fn run_config_pipeline(
    app: &AppHandle,
    job: &VerifyJob,
    inner: &Arc<Mutex<VerifyInner>>,
    kanban: &tauri::State<'_, KanbanStore>,
    pipeline: &[VerifyKind],
    log_dir: Option<&Path>,
    completion: &mut ActiveVerifyGuard,
) {
    use tauri::Manager;
    for (idx, entry) in pipeline.iter().enumerate() {
        let step_kind = step_kind_label(entry, idx);
        set_running(inner, &step_kind);
        let _ = app.emit("verify://progress", &job.verify_run_id);

        // A capacity stall is read from a script's output, and from a
        // Claude check's result line only (`slash_capacity_stall`).
        let (result, capacity) = match entry {
            VerifyKind::Script { path } => {
                let quoted = shell_quote(path);
                let bash = crate::shell_env::bash_word(&crate::shell_env::get().path);
                let result = run_step(
                    &job.repo_root,
                    &[&bash, &quoted],
                    None,
                    &job.build_env,
                    CONFIG_PIPELINE_STEP_TIMEOUT_SECS,
                    &step_kind,
                    log_dir,
                );
                let capacity = result.reason.as_deref().and_then(detect_capacity_stall);
                (result, capacity)
            }
            VerifyKind::SlashCommand { name, args } => {
                let pty_state = app.state::<crate::pty::PtyRegistry>();
                let mut capacity = None;
                let result = run_claude_slash_step(
                    &mut capacity,
                    app,
                    &pty_state,
                    &job.workspace_id,
                    &job.repo_root,
                    &job.build_env,
                    name,
                    args,
                    CONFIG_PIPELINE_STEP_TIMEOUT_SECS,
                    &step_kind,
                    log_dir,
                );
                (result, capacity)
            }
        };
        push_step(inner, result.clone());
        let _ = app.emit("verify://progress", &job.verify_run_id);

        if !result.passed {
            if let Some(detail) = capacity {
                finalize_capacity_stall(inner, job, detail);
                let _ = app.emit("verify://done", &job.verify_run_id);
                finish_and_wake(app, job, completion);
                return;
            }
            finalize_fail(
                app,
                inner,
                kanban,
                job,
                result.reason.clone().unwrap_or_default(),
            );
            let _ = app.emit("verify://done", &job.verify_run_id);
            finish_and_wake(app, job, completion);
            return;
        }
    }

    finalize_pass(app, inner, kanban, job);
    let _ = app.emit("verify://done", &job.verify_run_id);
    finish_and_wake(app, job, completion);
}

/// G8 (1.170.0): what the project's checks said of a release's combined
/// change (`ship::release_pr`): the checks run, the ones not run there, and
/// the first that failed with why.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct TreeChecks {
    pub ran: Vec<String>,
    pub not_run: Vec<String>,
    pub failed: Option<(String, String)>,
    /// 1.174.0 (DR2): *Stop the release* ended them: the running step was
    /// killed with its whole process group, and none after it ran.
    pub stopped: bool,
}

/// G8 (1.170.0): run the project's Verify scripts in `dir` (a release built
/// from the cards together with GitHub's target), each as a Verify step runs
/// one — bash, the cached PATH (Hard Rule #2), its own process group killed
/// on app exit (Hard Rule #4), Git Bash on Windows, bounded — stopping at
/// the first that fails. A Claude check (`SlashCommand`) is not run on it:
/// it would need a Claude session in a folder Claude was never asked to
/// trust; it ran on each card's own copy, and is listed in `not_run`.
/// Blocking: call it from a worker.
///
/// 1.174.0 (DR2): `stop` set (*Stop the release*) ends them: the running
/// step's process group is killed at once — its whole tree, Git Bash's on
/// Windows (a Job Object) — and `stopped` is said; no later step starts.
pub(crate) fn run_script_checks_in(
    pipeline: &[VerifyKind],
    dir: &Path,
    extra_env: &[(String, String)],
    stop: Option<&std::sync::atomic::AtomicBool>,
) -> TreeChecks {
    use std::sync::atomic::Ordering;
    let mut out = TreeChecks::default();
    for (idx, entry) in pipeline.iter().enumerate() {
        if stop.is_some_and(|s| s.load(Ordering::SeqCst)) {
            out.stopped = true;
            return out;
        }
        match entry {
            VerifyKind::Script { path } => {
                let step_kind = step_kind_label(entry, idx);
                let quoted = shell_quote(path);
                let bash = crate::shell_env::bash_word(&crate::shell_env::get().path);
                let path_env = crate::shell_env::get().path.clone();
                let started = Instant::now();
                let ran = run_with_limits_in(
                    &STEP_GROUPS,
                    dir,
                    &[&bash, &quoted],
                    None,
                    extra_env,
                    Duration::from_secs(CONFIG_PIPELINE_STEP_TIMEOUT_SECS),
                    &path_env,
                    Capture::new(None, CAPTURE_TAIL_BYTES, CAPTURE_LOG_BYTES),
                    stop,
                );
                if matches!(ran, Err(StepError::Stopped)) {
                    out.stopped = true;
                    return out;
                }
                let result = step_result(ran, &step_kind, started, CONFIG_PIPELINE_STEP_TIMEOUT_SECS);
                out.ran.push(path.clone());
                if !result.passed {
                    out.failed = Some((path.clone(), result.reason.unwrap_or_default()));
                    return out;
                }
            }
            VerifyKind::SlashCommand { name, .. } => {
                out.not_run.push(format!("/{}", name.trim().trim_start_matches('/')));
            }
        }
    }
    out
}

/// Clear the authoritative VerifyRegistry slot before waking either work
/// queue. No card-execution gate or queue-pump lock is held here.
fn finish_and_wake(
    app: &AppHandle,
    job: &VerifyJob,
    completion: &mut ActiveVerifyGuard,
) {
    use tauri::Manager;
    completion.finish();
    // SL-6: a Verify of one of two builds goes on its lane, and may start
    // the comparison.
    if crate::build_both::parse_lane_key(&job.card_id).is_some() {
        crate::build_both::after_lane_verify(app, &job.workspace_id, &job.card_id);
    }
    crate::kanban::pump_card_queue(app, &job.workspace_id);
    if let Some(queue) = app.try_state::<crate::writer_queue::WriterQueue>() {
        queue.request_pump(app.clone());
    }
}

/// FE-friendly step label. Single-element pipelines collapse to just
/// the kind ("script" / "slash"); multi-element use 1-based ordinals
/// so the user can distinguish steps in the timeline.
fn step_kind_label(entry: &VerifyKind, idx: usize) -> String {
    match entry {
        VerifyKind::Script { path } => format!("script:{path}"),
        VerifyKind::SlashCommand { name, .. } => {
            format!("slash:{name} (step {})", idx + 1)
        }
    }
}

/// Quote a workspace-relative path for inclusion in a bash `-c`
/// command line. Defensive against spaces and shell metacharacters
/// in user-supplied paths.
fn shell_quote(s: &str) -> String {
    if s.chars().all(|c| c.is_ascii_alphanumeric() || "/._-".contains(c)) {
        s.to_string()
    } else {
        let escaped = s.replace('\'', "'\\''");
        format!("'{escaped}'")
    }
}

fn set_running(inner: &Arc<Mutex<VerifyInner>>, step: &str) {
    let mut i = inner.lock();
    if let Some(active) = i.active.as_mut() {
        active.state = VerifyStateOut::Running {
            step: step.to_string(),
            started_at: now_millis(),
        };
    }
}

fn push_step(inner: &Arc<Mutex<VerifyInner>>, step: VerifyStepResult) {
    let mut i = inner.lock();
    if let Some(active) = i.active.as_mut() {
        active.steps.push(step);
    }
}

fn finalize_pass(
    app: &AppHandle,
    inner: &Arc<Mutex<VerifyInner>>,
    kanban: &KanbanStore,
    job: &VerifyJob,
) {
    let steps = {
        let mut i = inner.lock();
        if let Some(active) = i.active.as_mut() {
            active.state = VerifyStateOut::Passed;
            active.steps.clone()
        } else {
            Vec::new()
        }
    };

    let summary = pass_summary(steps.len());
    let _ = persist_outcome(
        kanban,
        &job.workspace_id,
        &job.card_id,
        VerifyStatus::Passed,
        VerifyEntry {
            verify_run_id: job.verify_run_id.clone(),
            status: VerifyStatus::Passed,
            ended_at: now_millis(),
            summary: Some(summary),
            steps: steps.clone(),
            tree_sha: examined_tree(job.start_tree.as_deref(), &job.repo_root),
        },
    );

    post_outcome_if_requested(app, job, true, steps.len());

    let mut i = inner.lock();
    let key = job_key(&job.workspace_id, &job.card_id);
    i.recent.insert(
        key,
        VerifyJobStatus {
            verify_run_id: job.verify_run_id.clone(),
            workspace_id: job.workspace_id.clone(),
            card_id: job.card_id.clone(),
            state: VerifyStateOut::Passed,
            steps,
        },
    );
}

/// The summary a pass records. GH #333: a pass with no steps is a project
/// with no verify pipeline — nothing ran, so it never says "passed".
fn pass_summary(step_count: usize) -> String {
    if step_count == 0 {
        "no checks are set up".to_string()
    } else {
        format!("all {step_count} step(s) passed")
    }
}

/// The GitHub outcome comment's verify line. GH #333: zero steps is "none
/// set up", never a pass.
fn outcome_verify_line(passed: bool, step_count: usize) -> String {
    if passed && step_count == 0 {
        return "**Verify:** none set up".to_string();
    }
    let plural = if step_count == 1 { "" } else { "s" };
    format!(
        "**Verify:** {} ({step_count} step{plural})",
        if passed { "passed" } else { "failed" }
    )
}

/// v1.58.0 (Phase 4): when this verify was the post-swarm auto-verify
/// (`post_outcome_issue`), post a card-outcome comment to the backing GitHub
/// issue carrying the test result. The swarm itself reached Done (auto-verify
/// only runs on Done), so the header reflects the *combined* outcome. Manual
/// verify runs carry `post_outcome_issue = false` and never post.
fn post_outcome_if_requested(app: &AppHandle, job: &VerifyJob, passed: bool, step_count: usize) {
    if !job.post_outcome_issue {
        return;
    }
    let verify_line = outcome_verify_line(passed, step_count);
    let status_label = if passed {
        "✓ completed"
    } else {
        "⚠ completed, checks failed"
    };
    crate::github_sync::post_card_outcome_comment(
        app,
        &job.workspace_id,
        &job.card_id,
        status_label,
        Some(verify_line),
    );
}

/// Phase D: capacity-stall finalization. Unlike finalize_fail, this does
/// NOT update the card's verify_status — the pipeline simply halts and
/// the user retries verify when capacity frees up. The recent map is
/// updated so the UI can render "retry in N min" copy.
/// 1.175.0 B2: what a run that wasn't allowed leaves behind. The card's
/// checks are neither passed nor failed: its status goes back to what it was
/// before it was queued (its last entry's, or none), and `checks_hold` says
/// why nothing ran. One of two builds of a card says it on its lane instead
/// (`build_both::after_lane_verify` reads the registry's state).
pub(crate) const CHECKS_NEED_OK: &str = "The checks need your OK";

fn hold_for_consent(app: &AppHandle, inner: &Arc<Mutex<VerifyInner>>, kanban: &KanbanStore, job: &VerifyJob) {
    let state = VerifyStateOut::Failed { reason: CHECKS_NEED_OK.to_string() };
    {
        let mut i = inner.lock();
        if let Some(active) = i.active.as_mut() {
            active.state = state.clone();
        }
        i.recent.insert(
            job_key(&job.workspace_id, &job.card_id),
            VerifyJobStatus {
                verify_run_id: job.verify_run_id.clone(),
                workspace_id: job.workspace_id.clone(),
                card_id: job.card_id.clone(),
                state,
                steps: Vec::new(),
            },
        );
    }
    // Round 2 (G5): one of two builds — the lane says it waits
    // (`build_both::after_lane_verify`), and the card is marked too, so its
    // page offers Allow and run; the comparison doesn't start meanwhile.
    if let Some((card_id, _)) = crate::build_both::parse_lane_key(&job.card_id) {
        let _ = kanban.with_card(&job.workspace_id, card_id, |card| {
            card.checks_hold = Some(crate::checks_consent::ChecksHold { at: now_millis() });
            Ok(())
        });
        return;
    }
    let before = job.status_before;
    let held = kanban.with_card(&job.workspace_id, &job.card_id, |card| {
        held_card(card, now_millis(), before);
        Ok(())
    });
    if let Err(e) = held {
        log::warn!("verify: {}: couldn't mark the card as waiting for the checks' OK: {e}", job.card_id);
    }
    crate::kanban::emit_kanban_changed(app, &job.workspace_id);
}

/// The card of a run that was held: no longer queued, and marked.
pub(crate) fn held_card(card: &mut crate::kanban::KanbanCard, at: i64, before: Option<VerifyStatus>) {
    // What it said before the queue; when that isn't known (or was itself a
    // run under way), its last recorded result.
    card.verify_status = before
        .filter(|status| !matches!(status, VerifyStatus::Queued | VerifyStatus::Running))
        .unwrap_or_else(|| card.verify_history.last().map(|entry| entry.status).unwrap_or(VerifyStatus::None));
    card.checks_hold = Some(crate::checks_consent::ChecksHold { at });
}

/// A run of the card's checks is starting: it no longer waits for the OK.
fn clear_checks_hold(kanban: &KanbanStore, job: &VerifyJob) {
    if crate::build_both::parse_lane_key(&job.card_id).is_some() {
        return;
    }
    let held = kanban.get_card(&job.workspace_id, &job.card_id).is_ok_and(|card| card.checks_hold.is_some());
    if held {
        let _ = kanban.with_card(&job.workspace_id, &job.card_id, |card| {
            card.checks_hold = None;
            Ok(())
        });
    }
}

fn finalize_capacity_stall(
    inner: &Arc<Mutex<VerifyInner>>,
    job: &VerifyJob,
    detail: String,
) {
    let steps = {
        let mut i = inner.lock();
        if let Some(active) = i.active.as_mut() {
            active.state = VerifyStateOut::CapacityStall {
                detail: detail.clone(),
            };
            active.steps.clone()
        } else {
            Vec::new()
        }
    };
    let mut i = inner.lock();
    let key = job_key(&job.workspace_id, &job.card_id);
    i.recent.insert(
        key,
        VerifyJobStatus {
            verify_run_id: job.verify_run_id.clone(),
            workspace_id: job.workspace_id.clone(),
            card_id: job.card_id.clone(),
            state: VerifyStateOut::CapacityStall { detail },
            steps,
        },
    );
}

fn finalize_fail(
    app: &AppHandle,
    inner: &Arc<Mutex<VerifyInner>>,
    kanban: &KanbanStore,
    job: &VerifyJob,
    reason: String,
) {
    let steps = {
        let mut i = inner.lock();
        if let Some(active) = i.active.as_mut() {
            active.state = VerifyStateOut::Failed {
                reason: reason.clone(),
            };
            active.steps.clone()
        } else {
            Vec::new()
        }
    };

    post_outcome_if_requested(app, job, false, steps.len());

    let summary = format!("verify failed: {}", short_tail(&reason, 200));
    let _ = persist_outcome(
        kanban,
        &job.workspace_id,
        &job.card_id,
        VerifyStatus::Failed,
        VerifyEntry {
            verify_run_id: job.verify_run_id.clone(),
            status: VerifyStatus::Failed,
            ended_at: now_millis(),
            summary: Some(summary),
            steps: steps.clone(),
            tree_sha: examined_tree(job.start_tree.as_deref(), &job.repo_root),
        },
    );

    let mut i = inner.lock();
    let key = job_key(&job.workspace_id, &job.card_id);
    i.recent.insert(
        key,
        VerifyJobStatus {
            verify_run_id: job.verify_run_id.clone(),
            workspace_id: job.workspace_id.clone(),
            card_id: job.card_id.clone(),
            state: VerifyStateOut::Failed { reason },
            steps,
        },
    );
}

fn persist_outcome(
    kanban: &KanbanStore,
    workspace_id: &str,
    card_id: &str,
    status: VerifyStatus,
    entry: VerifyEntry,
) -> Result<(), String> {
    // v1.33.0: atomic single-card RMW. Was `load()` + whole-board `save()`.
    match kanban.with_card(workspace_id, card_id, |card| {
        card.verify_status = status;
        card.verify_history.push(entry);
        while card.verify_history.len() > MAX_VERIFY_HISTORY {
            card.verify_history.remove(0);
        }
        Ok(())
    }) {
        Ok(()) => Ok(()),
        Err(e) if e.contains("not found") => Ok(()),
        Err(e) => Err(e),
    }
}

/// Most lines of a failing step's output its persisted reason keeps.
const REASON_MAX_LINES: usize = 80;
/// Most characters of a failing step's output its persisted reason keeps.
const REASON_MAX_CHARS: usize = 4000;

/// The last `max` characters of `s`, prefixed with "…" when cut.
fn short_tail(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    let tail: String = s.chars().skip(count - max).collect();
    format!("…{tail}")
}

/// The reason recorded for a failing step: the END of its output, where
/// test runners name what failed (`failures:`, `test result: FAILED`). At
/// most `REASON_MAX_LINES` lines and `REASON_MAX_CHARS` characters; a cut
/// is marked at the top, and the complete output is in the step's log
/// (`verify_logs`). GH #62: this kept the head, which was build noise.
fn failure_reason(output: &str) -> String {
    failure_reason_after(output, 0)
}

/// [`failure_reason`] of an output's end when `earlier_lines` lines before
/// it were already dropped from memory.
fn failure_reason_after(output: &str, earlier_lines: usize) -> String {
    let output = output.trim_end();
    let total = earlier_lines + output.lines().count();
    let mut tail = tail_lines(output, REASON_MAX_LINES);
    let mut cut = total > REASON_MAX_LINES;
    let chars = tail.chars().count();
    if chars > REASON_MAX_CHARS {
        cut = true;
        let end: String = tail.chars().skip(chars - REASON_MAX_CHARS).collect();
        // Start on a line boundary rather than mid-line when there is one.
        tail = match end.split_once('\n') {
            Some((_, rest)) if !rest.is_empty() => rest.to_string(),
            _ => end,
        };
    }
    if !cut {
        return tail;
    }
    match total.saturating_sub(tail.lines().count()) {
        0 => format!("…{tail}"),
        omitted => format!("… ({omitted} earlier lines omitted)\n{tail}"),
    }
}

/// v1.9.1 hotfix (Bug F): strip ANSI CSI + OSC escape sequences from
/// captured shell output. `bash -lc` brings the user's shell-integration
/// OSC 133 codes (`\x1b]133;C\x07`) and color CSIs into our captured
/// stdout/stderr, which previously got persisted verbatim into
/// `VerifyEntry.summary` and rendered as `]133;C` garbage in the panel.
///
/// v1.19.0 (Cycle E4): exposed pub(crate) so `intake::finalize_transcript`
/// can clean up REPL-mode PTY bytes before persisting to disk.
pub(crate) fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        // 1.168.1 (A3): shift out / shift in (a TUI's charset switch) draw
        // nothing; kept, WebKit drew SI as "⌧".
        if c == '\x0e' || c == '\x0f' {
            continue;
        }
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        let next = match chars.peek() {
            Some(&n) => n,
            None => break,
        };
        if next == '[' {
            // CSI: ESC [ <params> <intermediate> <final-letter>
            chars.next();
            for inner in chars.by_ref() {
                if inner.is_ascii_alphabetic() {
                    break;
                }
            }
        } else if next == ']' {
            // OSC: ESC ] <params> (BEL | ESC \)
            chars.next();
            while let Some(inner) = chars.next() {
                if inner == '\x07' {
                    break;
                }
                if inner == '\x1b' {
                    if let Some(&inner2) = chars.peek() {
                        if inner2 == '\\' {
                            chars.next();
                            break;
                        }
                    }
                }
            }
        } else if matches!(next, '(' | ')' | '*' | '+') {
            // 1.168.1 (A3): a charset designation (`ESC ( B`, Claude Code
            // sends it) is three characters; its last one is not text.
            chars.next();
            chars.next();
        } else {
            // Some other ESC sequence — drop the ESC and the next char.
            chars.next();
        }
    }
    out
}

fn run_step(
    repo_root: &Path,
    cmd: &[&str],
    bash_prelude: Option<&str>,
    extra_env: &[(String, String)],
    timeout_secs: u64,
    step_kind: &str,
    log_dir: Option<&Path>,
) -> VerifyStepResult {
    let path = crate::shell_env::get().path.clone();
    run_step_on_path(repo_root, cmd, bash_prelude, extra_env, timeout_secs, step_kind, log_dir, &path)
}

/// [`run_step`] with an explicit `PATH` instead of the cached shell env.
#[allow(clippy::too_many_arguments)]
fn run_step_on_path(
    repo_root: &Path,
    cmd: &[&str],
    bash_prelude: Option<&str>,
    extra_env: &[(String, String)],
    timeout_secs: u64,
    step_kind: &str,
    log_dir: Option<&Path>,
    path: &str,
) -> VerifyStepResult {
    let started = Instant::now();
    let mut env = extra_env.to_vec();
    if let Some(dir) = log_dir {
        match std::fs::create_dir_all(dir) {
            Ok(()) => env.push((
                crate::verify_logs::LOG_DIR_ENV.to_string(),
                dir.to_string_lossy().into_owned(),
            )),
            Err(e) => log::warn!("verify {step_kind}: create log dir: {e}"),
        }
    }
    let raw_log = log_dir.map(|dir| crate::verify_logs::raw_capture_path(dir, step_kind));
    let result = run_with_timeout(
        repo_root,
        cmd,
        bash_prelude,
        &env,
        timeout_secs,
        path,
        raw_log.as_deref(),
    );
    if let (Some(dir), Some(raw)) = (log_dir, raw_log.as_deref()) {
        if raw.exists() {
            if let Err(e) = crate::verify_logs::publish_raw(dir, step_kind, raw) {
                log::warn!("verify {step_kind}: write full log: {e}");
            }
        }
    }
    step_result(result, step_kind, started, timeout_secs)
}

/// What a step's run says: passed, or why not.
fn step_result(
    result: Result<StepOutput, StepError>,
    step_kind: &str,
    started: Instant,
    timeout_secs: u64,
) -> VerifyStepResult {
    let elapsed_ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(StepOutput { code, tail, earlier_lines }) => {
            let passed = code == 0;
            VerifyStepResult {
                kind: step_kind.to_string(),
                passed,
                elapsed_ms,
                reason: if passed {
                    None
                } else {
                    Some(failure_reason_after(&tail, earlier_lines))
                },
            }
        }
        Err(StepError::TimedOut { .. }) => VerifyStepResult {
            kind: step_kind.to_string(),
            passed: false,
            elapsed_ms: timeout_secs * 1000,
            reason: Some(format!("step `{step_kind}` timed out after {timeout_secs}s")),
        },
        Err(StepError::Spawn(e)) => VerifyStepResult {
            kind: step_kind.to_string(),
            passed: false,
            elapsed_ms,
            reason: Some(format!("spawn failed: {e}")),
        },
        Err(StepError::Unavailable(reason)) => VerifyStepResult {
            kind: step_kind.to_string(),
            passed: false,
            elapsed_ms,
            reason: Some(reason),
        },
        // Only a run given a stop flag ends so; never a passed step.
        Err(StepError::Stopped) => VerifyStepResult {
            kind: step_kind.to_string(),
            passed: false,
            elapsed_ms,
            reason: Some(format!("step `{step_kind}` was stopped")),
        },
    }
}

/// Keep a step's complete output as its full log. Best-effort: a step
/// never fails because its log couldn't be written.
fn write_step_log(dir: &Path, step_kind: &str, output: &str) {
    if let Err(e) = crate::verify_logs::write_step(dir, step_kind, output) {
        log::warn!("verify {step_kind}: write full log: {e}");
    }
}

struct StepOutput {
    code: i32,
    /// The end of the step's output (stdout and stderr interleaved, ANSI
    /// stripped); the complete output is only on disk.
    tail: String,
    /// Lines before `tail` that were dropped from memory.
    earlier_lines: usize,
}

enum StepError {
    /// Stopped at its timeout; `tail` is what it printed until then.
    TimedOut { tail: String },
    Spawn(String),
    /// Nothing to run the step with (no Git Bash on Windows); the reason
    /// says what to install.
    Unavailable(String),
    /// 1.174.0 (DR2): its stop flag was set; the group was killed.
    Stopped,
}

/// Bytes of a step's output's end kept in memory for its reason.
const CAPTURE_TAIL_BYTES: usize = 256 * 1024;
/// Bytes of a step's output written to its raw log before only the end is
/// kept (a marker, then the in-memory tail, closes the log).
const CAPTURE_LOG_BYTES: u64 = 64 * 1024 * 1024;

/// A step's output as it arrives: the last `tail_max` bytes (cut at a line
/// boundary) in memory, the raw bytes on disk. Memory stays bounded however
/// much the step prints.
struct Capture {
    tail: Vec<u8>,
    tail_max: usize,
    earlier_lines: usize,
    file: Option<std::fs::File>,
    log_max: u64,
    written: u64,
    total: u64,
}

impl Capture {
    fn new(raw_log: Option<&Path>, tail_max: usize, log_max: u64) -> Self {
        let file = raw_log.and_then(|p| match std::fs::File::create(p) {
            Ok(f) => Some(f),
            Err(e) => {
                log::warn!("verify: create raw log {}: {e}", p.display());
                None
            }
        });
        Self { tail: Vec::new(), tail_max, earlier_lines: 0, file, log_max, written: 0, total: 0 }
    }

    fn push(&mut self, bytes: &[u8]) {
        use std::io::Write;
        self.total += bytes.len() as u64;
        if let Some(f) = self.file.as_mut() {
            let room = self.log_max.saturating_sub(self.written).min(bytes.len() as u64) as usize;
            if room > 0 {
                if f.write_all(&bytes[..room]).is_ok() {
                    self.written += room as u64;
                } else {
                    self.file = None;
                }
            }
        }
        self.tail.extend_from_slice(bytes);
        if self.tail.len() > 2 * self.tail_max {
            let from = self.tail.len() - self.tail_max;
            // Start on a line boundary only when that still keeps at least
            // half the tail: a newline at (or near) the very end must not
            // drain the output's last line, which is what names a failure.
            let cut = match self.tail[from..].iter().position(|b| *b == b'\n') {
                Some(i) if self.tail.len() - (from + i + 1) >= self.tail_max / 2 => from + i + 1,
                _ => from,
            };
            self.earlier_lines += self.tail[..cut].iter().filter(|b| **b == b'\n').count();
            self.tail.drain(..cut);
        }
    }

    /// Close the raw log (the end of an over-long output after a marker)
    /// and return the in-memory end, ANSI stripped.
    fn finish(mut self) -> (String, usize) {
        use std::io::Write;
        if let Some(f) = self.file.as_mut() {
            let unwritten = self.total - self.written;
            if unwritten > 0 {
                let from_tail = unwritten.min(self.tail.len() as u64);
                let omitted = unwritten - from_tail;
                let _ = write!(f, "\n… ({omitted} bytes omitted from this log) …\n");
                let _ = f.write_all(&self.tail[self.tail.len() - from_tail as usize..]);
            }
            let _ = f.flush();
        }
        // v1.9.1 (Bug F): strip ANSI/OSC so OSC sequences like
        // `\x1b]133;C\x07` don't survive into the persisted reason text or
        // the verify-panel render.
        (strip_ansi(&String::from_utf8_lossy(&self.tail)), self.earlier_lines)
    }
}

/// Verify step process groups, killed on app exit (Hard Rule #4). A step
/// runs in its own group, so nothing else would signal what it started.
static STEP_GROUPS: crate::worktrees::FetchRegistry =
    crate::worktrees::FetchRegistry::refusing_with("Plyloft is quitting; no verify step was started");

/// App exit: refuse new verify steps and kill every running step's process
/// group. Returns how many groups were signalled.
pub fn kill_active_steps() -> usize {
    STEP_GROUPS.shutdown()
}

/// The registry [`kill_active_steps`] quits (SL-4's setup command runs in it).
pub(crate) fn step_groups() -> &'static crate::worktrees::FetchRegistry {
    &STEP_GROUPS
}

/// SL-4: what a command run by [`run_bounded_command_in`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CommandRun {
    /// The exit code; `None` when it was stopped or could not run.
    pub code: Option<i32>,
    pub timed_out: bool,
    /// The end of its output, stdout and stderr in order, ANSI stripped.
    pub output: String,
    /// Why it could not run at all (no Git Bash, a failed spawn, quitting).
    pub error: Option<String>,
    pub elapsed_ms: u64,
}

/// Bytes of a bounded command's output kept in memory.
const COMMAND_TAIL_BYTES: usize = 64 * 1024;

/// SL-4: run `command` with bash in `cwd` exactly as a verify step runs —
/// its own process group, registered in `groups` (the app's is
/// [`STEP_GROUPS`], killed on app exit, Hard Rule #4), `path` as PATH (the
/// cached one, Hard Rule #2), Git Bash on Windows, stopped with its
/// descendants after `timeout`, with `extra_env` (the worktree's port
/// block) after PATH. Blocking: call it from a worker.
/// The app passes [`step_groups`]; a test quits a registry of its own, since
/// quitting the app's one refuses every later step in the test process.
pub(crate) fn run_bounded_command_in(
    groups: &crate::worktrees::FetchRegistry,
    cwd: &Path,
    command: &str,
    timeout: Duration,
    path: &str,
    extra_env: &[(String, String)],
    // 1.174.0 (DR2 round 1): *Stop the release* kills it at once.
    stop: Option<&std::sync::atomic::AtomicBool>,
) -> CommandRun {
    let started = Instant::now();
    let out = run_with_limits_in(
        groups,
        cwd,
        &[command],
        None,
        extra_env,
        timeout,
        path,
        Capture::new(None, COMMAND_TAIL_BYTES, 0),
        stop,
    );
    let elapsed_ms = started.elapsed().as_millis() as u64;
    match out {
        Ok(StepOutput { code, tail, .. }) => CommandRun { code: Some(code), timed_out: false, output: tail, error: None, elapsed_ms },
        Err(StepError::TimedOut { tail }) => CommandRun { code: None, timed_out: true, output: tail, error: None, elapsed_ms },
        Err(StepError::Spawn(e)) => {
            CommandRun { code: None, timed_out: false, output: String::new(), error: Some(e), elapsed_ms }
        }
        Err(StepError::Stopped) => CommandRun { code: None, timed_out: false, output: String::new(), error: None, elapsed_ms },
        // Verify's own words name Verify; these name the command.
        Err(StepError::Unavailable(_)) => CommandRun {
            code: None,
            timed_out: false,
            output: String::new(),
            error: Some("it needs Git Bash on Windows — install Git for Windows (git-scm.com), then retry".into()),
            elapsed_ms,
        },
    }
}

/// The argv passed to `claude` for a SlashCommand verify step: the prompt
/// `/<name> <args>` in Claude's interactive TUI, collected through its
/// transcript (`claude_session`, `PtyRegistry::spawn_collect`), never
/// `claude -p` — Anthropic announced billing `-p` outside the member's plan
/// (Hard rule 1). An unattended writer session
/// (`claude_session::unattended_writer_args`): the check may write, as it
/// could under `-p`, and what `-p` refused for want of an answer is refused
/// here too.
///
/// 1.168.1 (E1, Challenger): `model` is the workspace's (else the app's)
/// Builder row for Claude — a check is work on the project, run on the
/// model the member chose for that; blank passes no `--model`.
fn build_claude_slash_argv(
    name: &str,
    args: &[String],
    writer: crate::claude_session::WriterMode,
    model: &crate::settings::ModelChoice,
) -> Vec<String> {
    // A check's name is stored with its slash ("/ppvp", the documented
    // shape) or without it: one slash, whichever. `//ppvp` is no command —
    // Claude answered it as text and the check passed without running it
    // (live walk of PR #382; the same on main before it).
    let mut prompt = format!("/{}", name.trim().trim_start_matches('/'));
    for a in args {
        if !a.is_empty() {
            prompt.push(' ');
            prompt.push_str(a);
        }
    }
    let mut argv = crate::claude_session::unattended_writer_args(&prompt, writer, &[]);
    // 1.169.0 (A1): `--effort` beside `--model`, each when chosen.
    argv.extend(model.claude_flags());
    argv
}

/// The collected session's result line (`claude_session::result_line`,
/// its last line): `Some(true)` when the command's turn ended in an
/// answer, `Some(false)` on an error. `None` without one (a timeout, a
/// Claude that exited on its own before its turn ended): the check failed.
fn parse_result_line(output: &str) -> Option<bool> {
    result_line(output).map(|v| !v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false))
}

/// The last `{"type":"result",…}` line of a collected session's output.
fn result_line(output: &str) -> Option<serde_json::Value> {
    for line in output.lines().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.starts_with('{') {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(|t| t.as_str()) == Some("result") {
            return Some(v);
        }
    }
    None
}

/// Why a failed SlashCommand check failed: the result line's own words
/// when the session wrote one (an error answer, or the screen that stopped
/// it: sign-in, usage limit, folder trust — naming the check's folder),
/// else the end of what it showed.
fn slash_failure_reason(output: &str, cwd: &Path) -> String {
    match result_line(output)
        .and_then(|v| v.get("result").and_then(|r| r.as_str()).map(str::to_string))
        .filter(|text| !text.trim().is_empty())
    {
        Some(text) if text.trim() == crate::claude_session::FOLDER_TRUST_REFUSAL => {
            crate::claude_session::writer_trust_refusal(cwd)
        }
        Some(text) => failure_reason(&text),
        None => failure_reason(crate::claude_session::screen_at_stop(output)),
    }
}

/// Why a SlashCommand check timed out, with what Claude's screen last
/// showed (the collected output of a session without an answer is its
/// screen's tail).
fn slash_timeout_reason(step_kind: &str, timeout_secs: u64, output: &str) -> String {
    let head = format!("step `{step_kind}` timed out after {timeout_secs}s");
    let tail = crate::claude_session::screen_at_stop(output).trim();
    if tail.is_empty() {
        head
    } else {
        format!("{head}. Claude's screen last showed:\n{}", failure_reason(tail))
    }
}

/// A SlashCommand check stalled on capacity: read from Plyloft's result
/// line only, never from the conversation (a command that talks about
/// limits is no limit). A turn that ended without an answer carries
/// Claude's own words, so it is never one.
fn slash_capacity_stall(output: &str) -> Option<String> {
    if crate::claude_session::unclassifiable(output) {
        return None;
    }
    let line = result_line(output)?;
    if line.get("is_error").and_then(|b| b.as_bool()) != Some(true) {
        return None;
    }
    let text = line.get("result").and_then(|r| r.as_str())?;
    detect_capacity_stall(text).or_else(|| {
        (crate::review_failure::classify(text, Some(1), false, true)
            == crate::review_failure::ProviderFailure::UsageLimit)
            .then(|| text.trim().to_string())
    })
}

/// OB-14 (§13.4): a SlashCommand check is a Claude slash command by nature,
/// so it needs Claude Code even where Codex builds. Said plainly.
pub const SLASH_NEEDS_CLAUDE: &str =
    "This check runs a Claude command, and Claude Code isn't installed.";

/// The claude a SlashCommand check runs, or [`SLASH_NEEDS_CLAUDE`].
/// 1.176.0 R3: by `doctor::require`'s rule — on disk, and starting (a slow
/// `--version` counts as starting); one that doesn't start says so.
fn slash_claude_path(env: &crate::shell_env::ShellEnv) -> Result<String, String> {
    slash_claude_path_with(env, crate::cli_fresh::usable)
}

fn slash_claude_path_with(env: &crate::shell_env::ShellEnv, usable: impl Fn(&str) -> bool) -> Result<String, String> {
    if !env.claude_path.as_deref().is_some_and(&usable) {
        return Err(SLASH_NEEDS_CLAUDE.to_string());
    }
    crate::doctor::require_with(env, "claude", usable)
}

/// v1.15.0 (Cycle E1): run a SlashCommand verify step. Spawns `claude` via
/// `PtyRegistry::spawn_collect` (Hard Rule #1: claude must run in a PTY for
/// Max-plan auth). The session is registered in PtyRegistry while running so
/// `kill_all` sweeps it on Cmd-Q (Hard Rule #4).
///
/// Pass/fail logic: the session's result line (`parse_result_line`); pass
/// iff `is_error` is false. Without one (a timeout, an exit on its own),
/// it failed, whatever the exit code. `capacity` is set when the result line says
/// Claude's capacity ran out (`slash_capacity_stall`).
#[allow(clippy::too_many_arguments)]
fn run_claude_slash_step(
    capacity: &mut Option<String>,
    app: &AppHandle,
    pty_registry: &crate::pty::PtyRegistry,
    workspace_id: &str,
    repo_root: &Path,
    extra_env: &[(String, String)],
    name: &str,
    args: &[String],
    timeout_secs: u64,
    step_kind: &str,
    log_dir: Option<&Path>,
) -> VerifyStepResult {
    let started = Instant::now();
    let claude_path = match slash_claude_path(&crate::shell_env::get()) {
        Ok(p) => p,
        Err(reason) => {
            return VerifyStepResult {
                kind: step_kind.to_string(),
                passed: false,
                elapsed_ms: started.elapsed().as_millis() as u64,
                reason: Some(reason),
            };
        }
    };

    let model = crate::settings::model_for_workspace(app, workspace_id, "claude", crate::settings::AgentRole::Builder);
    // 1.175.0 (A6): the member's own mode — never one the repository's
    // settings file, or the copy's, asks for.
    let writer = crate::claude_session::writer_choice(repo_root);
    let argv = build_claude_slash_argv(name, args, writer.mode, &model);
    let cwd = repo_root.to_string_lossy().to_string();
    let knowledge_mcp = match crate::mcp_launch::KnowledgeMcpContext::new(
        app,
        crate::mcp_launch::Provider::Claude,
        workspace_id,
        repo_root,
    ) {
        Ok(context) => context,
        Err(e) => {
            return VerifyStepResult {
                kind: step_kind.to_string(),
                passed: false,
                elapsed_ms: started.elapsed().as_millis() as u64,
                reason: Some(format!("Knowledge MCP context failed: {e}")),
            };
        }
    };

    let intent = crate::coordination::SpawnIntent {
        provider: crate::coordination::Provider::Claude,
        execution_kind: crate::coordination::ExecutionKind::VerifyCollector,
        attendance: crate::coordination::Attendance::Unattended,
        write_intent: crate::coordination::WriteIntent::Writer,
        enforcement: crate::coordination::Enforcement::Exclusive,
        project: crate::coordination::SpawnProject::Project {
            workspace_id: workspace_id.to_string(),
            cwd: repo_root.to_path_buf(),
        },
        capability: None,
        card_id: None,
        swarm_id: None,
        role_id: None,
        run_id: None,
        retention_class: crate::coordination::RetentionClass::Ephemeral,
        objective: Some(format!("/{name}")),
    };
    let outcome = loop {
        let elapsed = started.elapsed();
        if elapsed >= Duration::from_secs(timeout_secs) {
            return VerifyStepResult {
                kind: step_kind.to_string(),
                passed: false,
                elapsed_ms: timeout_secs * 1000,
                reason: Some(format!(
                    "step `{step_kind}` timed out waiting for writer admission \
                     after {timeout_secs}s"
                )),
            };
        }
        let remaining_secs = timeout_secs.saturating_sub(elapsed.as_secs()).max(1);
        match pty_registry.spawn_collect(
            &claude_path,
            argv.clone(),
            Some(cwd.clone()),
            Some(knowledge_mcp.clone()),
            extra_env.to_vec(),
            intent.clone(),
            remaining_secs,
        ) {
            Ok(outcome) => break outcome,
            Err(error) if crate::coordination::decode_writer_busy(&error).is_some() => {
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(error) => {
                return VerifyStepResult {
                    kind: step_kind.to_string(),
                    passed: false,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    reason: Some(format!("spawn failed: {error}")),
                };
            }
        }
    };

    let elapsed_ms = started.elapsed().as_millis() as u64;
    let raw = String::from_utf8_lossy(&outcome.output).to_string();
    let cleaned = strip_ansi(&raw);
    if let Some(dir) = log_dir {
        write_step_log(dir, step_kind, &cleaned);
    }

    if outcome.timed_out {
        return VerifyStepResult {
            kind: step_kind.to_string(),
            passed: false,
            elapsed_ms: timeout_secs * 1000,
            reason: Some(slash_timeout_reason(step_kind, timeout_secs, &cleaned)),
        };
    }

    // A collected session that ended without Plyloft's result line (Claude
    // exited on its own, before its turn ended) failed, whatever its exit
    // code.
    let answered = parse_result_line(&cleaned).unwrap_or(false);
    // A check passes only when Claude ran the command: an answer to the
    // prompt taken as text (`//hello`, a name that is no command here) is
    // no check that passed (live walk of PR #382).
    let ran = !answered || crate::claude_session::ran_as_command(&cleaned, name);
    let passed = answered && ran;
    if !answered {
        *capacity = slash_capacity_stall(&cleaned);
    }

    VerifyStepResult {
        kind: step_kind.to_string(),
        passed,
        elapsed_ms,
        reason: if passed {
            None
        } else if !ran {
            Some(not_run_as_command(name))
        } else {
            Some(without_project_bypass(slash_failure_reason(&cleaned, repo_root), writer))
        },
    }
}

/// 1.175.0 (A6): a failed check's reason, with one more sentence when the
/// project's Claude settings asked for bypass and the check ran without it
/// (`BypassAsked::Shared`) — that may be why it failed. Not when the only
/// file that asked is the folder's own local one that git couldn't judge
/// (round 3, S2): that may be the member's own, and it is only logged.
fn without_project_bypass(reason: String, writer: crate::claude_session::WriterChoice) -> String {
    if writer.bypass_not_followed == Some(crate::claude_session::BypassAsked::Shared) {
        format!("{reason}\n{}", crate::claude_session::PROJECT_BYPASS_NOT_FOLLOWED)
    } else {
        reason
    }
}

/// Why a check whose session answered failed all the same: Claude never ran
/// its command (`claude_session::ran_as_command`).
fn not_run_as_command(name: &str) -> String {
    let name = name.trim().trim_start_matches('/');
    format!("Claude did not run /{name} as a command (is it in .claude/commands of this worktree?)")
}

/// Build the `bash` command for a verify step. Uses `-c` (NOT `-lc`) and
/// injects the cached interactive PATH from `shell_env`, so we don't
/// re-source the user's `.bashrc` / `.zshrc` on every spawn. Sourcing
/// rc files leaks user-specific stderr (e.g. "no such file" warnings
/// from missing completion scripts) into the captured output, which then
/// lands in `VerifyEntry.summary` and pollutes the panel's failure copy.
/// Hard Rule #2 in CLAUDE.md exists exactly to prevent this — the rest
/// of the codebase already uses the cached env via `shell_env::get()`.
///
/// Split out as a standalone helper so the spawn config is unit-testable
/// without actually running a process. On Windows the bash is Git Bash
/// (`shell_env::bash_program`); without it the step can't run.
fn build_verify_command(
    repo_root: &Path,
    bash_cmd: &str,
    path: &str,
    extra_env: &[(String, String)],
) -> Result<Command, String> {
    let bash = crate::shell_env::bash_program(path).ok_or_else(|| GIT_BASH_MISSING.to_string())?;
    let mut cmd = crate::platform::new_command(bash);
    cmd.arg("-c")
        .arg(bash_cmd)
        .current_dir(repo_root)
        .env("PATH", path)
        .envs(extra_env.iter().map(|(k, v)| (k, v)))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // A script checked out with CRLF (core.autocrlf) runs: Git Bash drops
    // the `\r` with this option, where it would otherwise end each command.
    #[cfg(windows)]
    cmd.env("SHELLOPTS", "igncr");
    // Its own process group: whatever the step starts is killed with it.
    crate::platform::own_group(&mut cmd);
    Ok(cmd)
}

/// A verify step's reason when Windows has no Git Bash to run it with.
const GIT_BASH_MISSING: &str = "Verify needs Git Bash on Windows — install Git for Windows (git-scm.com), then verify again.";

/// Run a step in its own process group and read its output on this thread
/// until the step and everything holding its pipes is gone. Every return
/// kills the group; no reader outlives the call, and memory holds only the
/// output's end (see [`Capture`]).
fn run_with_timeout(
    repo_root: &Path,
    cmd: &[&str],
    bash_prelude: Option<&str>,
    extra_env: &[(String, String)],
    timeout_secs: u64,
    path: &str,
    raw_log: Option<&Path>,
) -> Result<StepOutput, StepError> {
    run_with_limits(
        repo_root,
        cmd,
        bash_prelude,
        extra_env,
        Duration::from_secs(timeout_secs),
        path,
        Capture::new(raw_log, CAPTURE_TAIL_BYTES, CAPTURE_LOG_BYTES),
    )
}

fn run_with_limits(
    repo_root: &Path,
    cmd: &[&str],
    bash_prelude: Option<&str>,
    extra_env: &[(String, String)],
    timeout: Duration,
    path: &str,
    capture: Capture,
) -> Result<StepOutput, StepError> {
    run_with_limits_in(&STEP_GROUPS, repo_root, cmd, bash_prelude, extra_env, timeout, path, capture, None)
}

#[allow(clippy::too_many_arguments)]
fn run_with_limits_in(
    groups: &crate::worktrees::FetchRegistry,
    repo_root: &Path,
    cmd: &[&str],
    bash_prelude: Option<&str>,
    extra_env: &[(String, String)],
    timeout: Duration,
    path: &str,
    mut capture: Capture,
    // 1.174.0 (DR2): set by *Stop the release* — the group is killed now.
    stop: Option<&std::sync::atomic::AtomicBool>,
) -> Result<StepOutput, StepError> {
    #[cfg(unix)]
    use std::io::Read;
    #[cfg(unix)]
    use std::os::fd::AsRawFd;
    /// How long pipes may stay open after the group is killed: only a
    /// descendant that left the group (setsid) can hold them that long.
    const DRAIN_GRACE: Duration = Duration::from_secs(2);

    let joined = cmd.join(" ");
    let prelude = bash_prelude.unwrap_or("");
    // stderr joins stdout in one pipe so the output keeps its real order:
    // a failure summary on stdout isn't followed by stderr printed earlier.
    let bash_cmd = format!("exec 2>&1; {prelude}{joined}");

    let mut command =
        build_verify_command(repo_root, &bash_cmd, path, extra_env).map_err(StepError::Unavailable)?;
    let (mut child, _group) = groups.spawn(&mut command).map_err(StepError::Spawn)?;
    let pgid = child.id() as crate::platform::Pgid;
    // The process group created at spawn, whose id is the child's pid. While
    // any member lives the id can't be reused (the same pattern as
    // `build_cache::run_cargo_in`).
    let kill_group = || crate::platform::kill_group(pgid);

    // Drained while the step runs: a step printing more than the pipe
    // buffer would otherwise block and time out.
    #[cfg(unix)]
    let mut pipes: Vec<Box<dyn Read>> = Vec::new();
    #[cfg(unix)]
    let mut fds: Vec<libc::pollfd> = Vec::new();
    #[cfg(unix)]
    {
        if let Some(p) = child.stdout.take() {
            fds.push(libc::pollfd { fd: p.as_raw_fd(), events: libc::POLLIN, revents: 0 });
            pipes.push(Box::new(p));
        }
        if let Some(p) = child.stderr.take() {
            fds.push(libc::pollfd { fd: p.as_raw_fd(), events: libc::POLLIN, revents: 0 });
            pipes.push(Box::new(p));
        }
    }
    #[cfg(unix)]
    let mut open = vec![true; pipes.len()];
    #[cfg(unix)]
    let mut buf = vec![0u8; 64 * 1024];
    #[cfg(windows)]
    let (pipes, mut open) = windows_pipe_readers(child.stdout.take(), child.stderr.take());

    let deadline = Instant::now() + timeout;
    let mut exit: Option<Result<i32, ()>> = None;
    let mut drain_until = None;
    loop {
        #[cfg(windows)]
        if open.iter().any(|o| *o) {
            match pipes.recv_timeout(Duration::from_millis(100)) {
                Ok((_, Some(chunk))) => capture.push(&chunk),
                Ok((i, None)) => open[i] = false,
                Err(_) => {}
            }
        } else {
            thread::sleep(Duration::from_millis(50));
        }
        #[cfg(unix)]
        if open.iter().any(|o| *o) {
            // A closed pipe is skipped by poll (negative fd).
            for (pfd, o) in fds.iter_mut().zip(&open) {
                pfd.revents = 0;
                if !*o && pfd.fd >= 0 {
                    pfd.fd = -1;
                }
            }
            // SAFETY: `fds` is a live, correctly sized pollfd array.
            let ready = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, 100) };
            if ready > 0 {
                for (i, pfd) in fds.iter().enumerate() {
                    if open[i] && pfd.revents != 0 {
                        match pipes[i].read(&mut buf) {
                            Ok(0) => open[i] = false,
                            Ok(n) => capture.push(&buf[..n]),
                            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                            Err(_) => open[i] = false,
                        }
                    }
                }
            }
        } else {
            thread::sleep(Duration::from_millis(50));
        }

        if exit.is_none() && stop.is_some_and(|s| s.load(std::sync::atomic::Ordering::SeqCst)) {
            kill_group();
            let _ = child.wait();
            return Err(StepError::Stopped);
        }
        if exit.is_none() {
            match child.try_wait() {
                Ok(Some(status)) => exit = Some(Ok(status.code().unwrap_or(-1))),
                Ok(None) if Instant::now() > deadline => {
                    kill_group();
                    let _ = child.wait();
                    exit = Some(Err(()));
                }
                Ok(None) => {}
                Err(e) => {
                    kill_group();
                    let _ = child.wait();
                    return Err(StepError::Spawn(format!("try_wait: {e}")));
                }
            }
            if exit.is_some() {
                // A background process the step left behind would keep
                // the pipes open and printing; it goes with the step.
                kill_group();
                drain_until = Some(Instant::now() + DRAIN_GRACE);
            }
        }
        if let Some(until) = drain_until {
            if !open.iter().any(|o| *o) || Instant::now() > until {
                break;
            }
        }
    }
    // Dropping the pipes closes them; a descendant that escaped the group
    // gets EPIPE on its next write. Nothing keeps reading.
    drop(pipes);
    let (tail, earlier_lines) = capture.finish();
    match exit {
        Some(Ok(code)) => Ok(StepOutput { code, tail, earlier_lines }),
        _ => Err(StepError::TimedOut { tail }),
    }
}

/// Windows has no `poll` over anonymous pipes: one reader thread per pipe
/// sends its chunks here, and `None` when that pipe closes. Returns the
/// receiver and one open flag per pipe. The step's Job Object takes every
/// holder of the pipes down with it, so the readers end with the step; only
/// a process that asked to leave the job (breakaway) can keep a reader
/// blocked, until it exits or next writes after the receiver is gone.
#[cfg(windows)]
fn windows_pipe_readers(
    stdout: Option<std::process::ChildStdout>,
    stderr: Option<std::process::ChildStderr>,
) -> (std::sync::mpsc::Receiver<(usize, Option<Vec<u8>>)>, Vec<bool>) {
    use std::io::Read;
    let (tx, rx) = std::sync::mpsc::channel();
    let mut pipes: Vec<Box<dyn Read + Send>> = Vec::new();
    if let Some(p) = stdout {
        pipes.push(Box::new(p));
    }
    if let Some(p) = stderr {
        pipes.push(Box::new(p));
    }
    let open = vec![true; pipes.len()];
    for (i, mut pipe) in pipes.into_iter().enumerate() {
        let tx = tx.clone();
        thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.send((i, Some(buf[..n].to_vec()))).is_err() {
                            return;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(_) => break,
                }
            }
            let _ = tx.send((i, None));
        });
    }
    (rx, open)
}

fn tail_lines(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    if lines.len() <= n {
        return s.to_string();
    }
    let start = lines.len() - n;
    lines[start..].join("\n")
}

/// Read `scripts/ppvp.sh` from `git show HEAD:` to a temp file so a card
/// modifying ppvp doesn't gate against its own broken edit (decision 14).
fn run_ppvp_from_head(
    repo_root: &Path,
    extra_env: &[(String, String)],
    log_dir: Option<&Path>,
) -> VerifyStepResult {
    let started = Instant::now();
    let head_ppvp = match crate::platform::git_command()
        .args(["show", "HEAD:scripts/ppvp.sh"])
        .current_dir(repo_root)
        .output()
    {
        Ok(o) if o.status.success() => o.stdout,
        Ok(o) => {
            return VerifyStepResult {
                kind: "ppvp-sh".to_string(),
                passed: false,
                elapsed_ms: started.elapsed().as_millis() as u64,
                reason: Some(format!(
                    "git show HEAD:scripts/ppvp.sh failed: {}",
                    String::from_utf8_lossy(&o.stderr).trim()
                )),
            };
        }
        Err(e) => {
            return VerifyStepResult {
                kind: "ppvp-sh".to_string(),
                passed: false,
                elapsed_ms: started.elapsed().as_millis() as u64,
                reason: Some(format!("spawn git show: {e}")),
            };
        }
    };

    // Write the committed script INSIDE the repo's scripts/ dir under
    // a hidden name. ppvp.sh's preamble computes its working dir from
    // `dirname "${BASH_SOURCE[0]}"` — if we wrote the temp file to
    // /tmp/, SCRIPT_DIR would resolve to /tmp and ROOT to /, breaking
    // every `cd src-tauri` and similar inside the script. Placing it
    // alongside the real ppvp.sh keeps SCRIPT_DIR/ROOT accurate.
    // The dot-prefix keeps it visually quiet; cleanup runs on every
    // exit path.
    let temp_path = repo_root
        .join("scripts")
        .join(format!(".ppvp-head-{}.sh", now_millis()));
    if let Err(e) = std::fs::write(&temp_path, &head_ppvp) {
        return VerifyStepResult {
            kind: "ppvp-sh".to_string(),
            passed: false,
            elapsed_ms: started.elapsed().as_millis() as u64,
            reason: Some(format!("write tempfile: {e}")),
        };
    }
    let path_str = temp_path.to_string_lossy().to_string();
    // Bash reads `C:\...` as escapes: forward slashes, quoted (spaces).
    #[cfg(windows)]
    let path_str = shell_quote(&path_str.replace('\\', "/"));
    let bash = crate::shell_env::bash_word(&crate::shell_env::get().path);
    let result = run_step(
        repo_root,
        &[&bash, &path_str],
        Some("source $HOME/.cargo/env >/dev/null 2>&1; "),
        extra_env,
        PPVP_TIMEOUT_SECS,
        "ppvp-sh",
        log_dir,
    );
    let _ = std::fs::remove_file(&temp_path);
    result
}

/// v1.12.x (Phase D): Claude-as-QA step. NOT YET WIRED INTO THE PIPELINE.
///
/// The intended flow:
///   1. Read `card.verify_intent` from the kanban (set by the swarm
///      builder in its completion step).
///   2. Spawn `Atelier-Verify.app` via `open` so the user sees the
///      sandbox build run alongside their installed Atelier.
///   3. Spawn a claude oneshot session with a system prompt instructing
///      it to drive Atelier-Verify.app via screenshots / accessibility,
///      executing the steps in `verify_intent`, and producing a JSON
///      pass/fail report with screenshot evidence.
///   4. Parse the JSON; populate a `VerifyStepResult` with kind
///      "claude-qa", passed = report.verdict == "pass".
///
/// The wiring requires a per-step orchestrator that knows how to dispatch
/// a claude PTY (already in agents.rs), which is non-trivial to
/// integrate as a synchronous step inside `run_pipeline`. Phase D leaves
/// this as a typed entry point for follow-up: the step kind is reserved
/// in the `VerifyStepKind` enum (workspace.rs) and the capacity-stall
/// detection in `detect_capacity_stall` already covers the claude CLI
/// failure mode this step would surface.
///
/// Design constraint: this step MUST NOT modify the working tree. The
/// QA agent reads, screenshots, and reports only. Anything that requires
/// code changes (e.g. fixing a broken UI flow) re-spawns through the
/// fix-swarm loop, not directly from QA.
#[allow(dead_code)]
fn claude_qa_step_stub() -> VerifyStepResult {
    VerifyStepResult {
        kind: "claude-qa".to_string(),
        passed: false,
        elapsed_ms: 0,
        reason: Some(
            "claude-qa not yet wired (Phase D follow-up)".to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn a_pass_with_no_steps_says_no_checks_are_set_up() {
        // GH #333: an empty pipeline records Passed for ship gating, but its
        // words never claim a check ran.
        assert_eq!(pass_summary(0), "no checks are set up");
        assert_eq!(pass_summary(3), "all 3 step(s) passed");
        assert_eq!(outcome_verify_line(true, 0), "**Verify:** none set up");
        assert_eq!(outcome_verify_line(true, 1), "**Verify:** passed (1 step)");
        assert_eq!(outcome_verify_line(true, 4), "**Verify:** passed (4 steps)");
        assert_eq!(outcome_verify_line(false, 2), "**Verify:** failed (2 steps)");
    }

    /// SL-6: a Verify of one of the two builds runs in that build's
    /// worktree — and is refused, never run on the main checkout, when the
    /// worktree is gone.
    #[test]
    fn a_lane_verify_runs_in_its_worktree_or_not_at_all() {
        let config = tempfile::tempdir().unwrap();
        let checkout = tempfile::tempdir().unwrap();
        let lane_wt = tempfile::tempdir().unwrap();
        let workspaces = WorkspaceStore::new(config.path().to_path_buf()).unwrap();
        let workspace = workspaces
            .create("Workspace".into(), checkout.path().to_string_lossy().into_owned())
            .unwrap();
        let kanban = KanbanStore::new(config.path().to_path_buf()).unwrap();
        let mut card = crate::kanban::KanbanCard::new(
            "card-1".into(),
            workspace.id.clone(),
            "test".into(),
            None,
            crate::kanban::KanbanColumnId::InProgress,
        );
        let gone = checkout.path().join("gone");
        card.build_both = Some(crate::build_both::new_record(
            &lane_wt.path().to_string_lossy(),
            "atelier/card-1-x",
            &gone.to_string_lossy(),
            "atelier/card-1-x-b",
            false,
            1,
        ));
        kanban.save(&workspace.id, vec![card]).unwrap();
        let registry = VerifyRegistry::default();
        let request = |lane: &str| VerifyRequest {
            workspace_id: workspace.id.clone(),
            card_id: crate::build_both::lane_key("card-1", lane),
            post_outcome_issue: false,
        };
        let err = registry.enqueue_deferred(&kanban, &workspaces, request("b")).err().unwrap();
        assert!(err.contains("copy of the repository is gone"), "{err}");
        assert!(!registry.is_inflight(&workspace.id, "card-1#both-b"));
        let deferred = registry.enqueue_deferred(&kanban, &workspaces, request("a")).unwrap();
        let root = registry.inner.lock().active.as_ref().unwrap().job.repo_root.clone();
        assert_eq!(root, lane_wt.path());
        assert!(registry.is_inflight(&workspace.id, "card-1#both-a"));
        assert!(!registry.is_inflight(&workspace.id, "card-1"), "the card itself has no Verify");
        drop(deferred);
    }

    #[test]
    fn deferred_enqueue_publishes_inflight_authority_before_worker_start() {
        let config = tempfile::tempdir().unwrap();
        let checkout = tempfile::tempdir().unwrap();
        let workspaces =
            WorkspaceStore::new(config.path().to_path_buf()).unwrap();
        let workspace = workspaces
            .create(
                "Workspace".into(),
                checkout.path().to_string_lossy().into_owned(),
            )
            .unwrap();
        let kanban = KanbanStore::new(config.path().to_path_buf()).unwrap();
        let card = crate::kanban::KanbanCard::new(
            "card-1".into(),
            workspace.id.clone(),
            "test".into(),
            None,
            crate::kanban::KanbanColumnId::Todo,
        );
        kanban.save(&workspace.id, vec![card]).unwrap();
        let registry = VerifyRegistry::default();
        registry.defer_auto_verify(&workspace.id, "card-1");
        assert!(registry.has_deferred_auto_verify(&workspace.id, "card-1"));
        let deferred = registry
            .enqueue_deferred(
                &kanban,
                &workspaces,
                VerifyRequest {
                    workspace_id: workspace.id.clone(),
                    card_id: "card-1".into(),
                    post_outcome_issue: false,
                },
            )
            .unwrap();
        assert!(!registry.has_deferred_auto_verify(&workspace.id, "card-1"));
        assert!(deferred.starts_worker);
        assert!(registry.is_inflight(&workspace.id, "card-1"));
        assert!(matches!(
            registry.status(&workspace.id, "card-1").unwrap().state,
            VerifyStateOut::Queued { position: 0 }
        ));
        assert_eq!(
            kanban
                .get_card(&workspace.id, "card-1")
                .unwrap()
                .verify_status,
            VerifyStatus::None
        );
        drop(deferred);
        assert!(!registry.is_inflight(&workspace.id, "card-1"));
    }

    #[test]
    fn deferred_auto_verify_is_bounded_and_take_is_exact() {
        let registry = VerifyRegistry::default();
        registry.defer_auto_verify("ws", "card");
        registry.defer_auto_verify("ws", "card");
        registry.defer_auto_verify("other", "card");
        assert!(registry.has_deferred_auto_verify("ws", "card"));
        assert!(registry.take_deferred_auto_verify("ws", "card"));
        assert!(!registry.take_deferred_auto_verify("ws", "card"));
        assert!(registry.has_deferred_auto_verify("other", "card"));
    }

    #[test]
    fn terminal_verify_wakeup_clears_registry_before_both_work_queues() {
        let source = include_str!("verify.rs");
        let (_, tail) = source
            .split_once("fn finish_and_wake(")
            .expect("verify wake helper must remain discoverable");
        let (body, _) = tail
            .split_once("/// FE-friendly step label")
            .expect("verify wake helper delimiter must remain discoverable");
        let clear = body
            .find("completion.finish();")
            .expect("verify authority must clear");
        let swarm_queue = body
            .find("pump_card_queue(")
            .expect("card-swarm queue must wake");
        let writer_queue = body
            .find("queue.request_pump(")
            .expect("single-agent writer queue must wake");
        assert!(clear < swarm_queue);
        assert!(clear < writer_queue);
    }

    #[test]
    fn deferred_drop_rolls_back_only_its_matching_queued_record() {
        let registry = VerifyRegistry::default();
        registry.set_inflight_for_test("ws", "active", false);
        let queued = VerifyJob {
            verify_run_id: "verify-queued".into(),
            workspace_id: "ws".into(),
            card_id: "queued".into(),
            repo_root: PathBuf::new(),
            post_outcome_issue: false,
            start_tree: None,
            status_before: None,
            build_env: Vec::new(),
        };
        registry.inner.lock().queue.push_back(queued);
        let deferred = DeferredVerify {
            inner: registry.inner.clone(),
            verify_run_id: "verify-queued".into(),
            starts_worker: false,
            armed: true,
        };
        drop(deferred);
        assert!(registry.is_inflight("ws", "active"));
        assert!(!registry.is_inflight("ws", "queued"));
    }

    #[test]
    fn panicking_worker_guard_clears_only_its_job_and_advances_the_queue() {
        let registry = VerifyRegistry::default();
        registry.set_inflight_for_test("ws", "panics", false);
        let active_run_id = registry
            .inner
            .lock()
            .active
            .as_ref()
            .unwrap()
            .job
            .verify_run_id
            .clone();
        registry.inner.lock().queue.push_back(VerifyJob {
            verify_run_id: "verify-next".into(),
            workspace_id: "ws".into(),
            card_id: "next".into(),
            repo_root: PathBuf::new(),
            post_outcome_issue: false,
            start_tree: None,
            status_before: None,
            build_env: Vec::new(),
        });
        let continued = Arc::new(AtomicBool::new(false));
        let continued_after_panic = continued.clone();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = ActiveVerifyGuard::new(
                registry.inner.clone(),
                active_run_id,
                move |next| {
                    assert_eq!(next.verify_run_id, "verify-next");
                    continued_after_panic.store(true, Ordering::SeqCst);
                },
            );
            panic!("exercise worker unwind");
        }));
        assert!(result.is_err());
        assert!(!registry.is_inflight("ws", "panics"));
        assert!(registry.is_inflight("ws", "next"));
        assert!(continued.load(Ordering::SeqCst));
    }

    #[test]
    fn stale_worker_guard_never_clears_a_newer_active_job() {
        let registry = VerifyRegistry::default();
        registry.set_inflight_for_test("ws", "newer", false);
        let mut stale =
            ActiveVerifyGuard::new(registry.inner.clone(), "verify-stale".into(), |_| {});
        stale.finish();
        assert!(registry.is_inflight("ws", "newer"));
    }

    #[test]
    fn detect_capacity_stall_matches_known_patterns() {
        assert!(detect_capacity_stall("Max plan session limit reached").is_some());
        assert!(detect_capacity_stall("session limit reached").is_some());
        assert!(detect_capacity_stall("Anthropic credit balance is too low").is_some());
        assert!(detect_capacity_stall("rate_limit_error: too many").is_some());
    }

    #[test]
    fn detect_capacity_stall_returns_none_for_normal_failures() {
        assert!(detect_capacity_stall("test failure: assertion failed").is_none());
        assert!(detect_capacity_stall("compilation error: missing semicolon").is_none());
        assert!(detect_capacity_stall("").is_none());
    }

    #[test]
    fn strip_ansi_removes_osc_133_sequences() {
        // OSC 133;C BEL — the bash-shell-integration prompt-mark code
        // that polluted persisted verify reasons in v1.9.0.
        let input = "\x1b]133;C\x07── cargo check\n  ✗ fail";
        let out = strip_ansi(input);
        assert_eq!(out, "── cargo check\n  ✗ fail");
    }

    #[test]
    fn strip_ansi_removes_csi_color_codes() {
        let input = "\x1b[31merror\x1b[0m: failed";
        let out = strip_ansi(input);
        assert_eq!(out, "error: failed");
    }

    #[test]
    fn strip_ansi_handles_st_terminated_osc() {
        // OSC terminated by ESC \ instead of BEL.
        let input = "\x1b]0;title\x1b\\done";
        let out = strip_ansi(input);
        assert_eq!(out, "done");
    }

    #[test]
    fn strip_ansi_passes_through_clean_text() {
        let input = "no escape codes here\nline 2";
        assert_eq!(strip_ansi(input), input);
    }

    #[test]
    fn strip_ansi_handles_multiple_consecutive_escapes() {
        let input = "\x1b]133;A\x07\x1b]133;B\x07cmd\x1b]133;C\x07output";
        assert_eq!(strip_ansi(input), "cmdoutput");
    }

    /// Regression: the verify spawn must use `bash -c` (NOT `-lc`) so it
    /// doesn't re-source the user's rc files. Sourcing leaks lines like
    /// `/Users/mb/.bashrc: line 14: ...openclaw.bash: No such file...`
    /// into the captured stderr, which previously polluted persisted
    /// `VerifyEntry.summary` text. PATH must come from the cached shell
    /// env probe (Hard Rule #2) instead.
    #[test]
    fn build_verify_command_uses_bash_c_with_explicit_path() {
        use std::ffi::OsStr;
        let cmd = build_verify_command(
            Path::new("/tmp/repo"),
            "echo hello",
            "/usr/bin:/usr/local/bin:/Users/me/.cargo/bin",
            &[("CARGO_TARGET_DIR".to_string(), "/ws/.plyloft-worktrees/.cargo-target".to_string())],
        )
        .expect("a bash to run the step with");

        #[cfg(unix)]
        assert_eq!(cmd.get_program(), OsStr::new("bash"));
        // Git Bash, found where Git for Windows installs: never System32's.
        #[cfg(windows)]
        {
            let program = cmd.get_program().to_string_lossy().to_ascii_lowercase();
            assert!(program.ends_with(r"\bin\bash.exe") && !program.contains("system32"), "{program}");
            let igncr = cmd
                .get_envs()
                .find_map(|(k, v)| (k == OsStr::new("SHELLOPTS")).then_some(v.unwrap()));
            assert_eq!(igncr, Some(OsStr::new("igncr")), "CRLF scripts run");
        }

        let args: Vec<&OsStr> = cmd.get_args().collect();
        assert_eq!(args.len(), 2, "expected exactly `-c <bash_cmd>`");
        assert_eq!(args[0], OsStr::new("-c"));
        assert_ne!(args[0], OsStr::new("-lc"), "must not source rc files");
        assert_eq!(args[1], OsStr::new("echo hello"));

        let path_env = cmd
            .get_envs()
            .find_map(|(k, v)| (k == OsStr::new("PATH")).then_some(v.unwrap()))
            .expect("PATH env must be set from cached shell_env");
        assert_eq!(
            path_env,
            OsStr::new("/usr/bin:/usr/local/bin:/Users/me/.cargo/bin"),
        );

        assert_eq!(cmd.get_current_dir(), Some(Path::new("/tmp/repo")));

        let target = cmd
            .get_envs()
            .find_map(|(k, v)| (k == OsStr::new("CARGO_TARGET_DIR")).then_some(v.unwrap()))
            .expect("the shared build cache reaches the step");
        assert_eq!(target, OsStr::new("/ws/.plyloft-worktrees/.cargo-target"));
    }

    /// v1.13.6: shell_quote leaves safe paths untouched.
    #[test]
    fn shell_quote_leaves_simple_paths_untouched() {
        assert_eq!(shell_quote("scripts/ppvp.sh"), "scripts/ppvp.sh");
        assert_eq!(shell_quote("verify.sh"), "verify.sh");
        assert_eq!(shell_quote("a-b_c.d/e"), "a-b_c.d/e");
    }

    /// v1.13.6: shell_quote single-quotes paths with metacharacters
    /// and escapes embedded single quotes.
    #[test]
    fn shell_quote_quotes_paths_with_spaces_or_specials() {
        assert_eq!(shell_quote("my scripts/run.sh"), "'my scripts/run.sh'");
        assert_eq!(shell_quote("a$b"), "'a$b'");
        // Embedded single quote escapes via '\''.
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    /// v1.13.6: step_kind_label includes the script path / slash name
    /// so the FE timeline can disambiguate steps in a multi-step
    /// pipeline.
    #[test]
    fn step_kind_label_includes_path_or_name() {
        assert_eq!(
            step_kind_label(
                &VerifyKind::Script {
                    path: "scripts/ppvp.sh".to_string()
                },
                0
            ),
            "script:scripts/ppvp.sh"
        );
        assert_eq!(
            step_kind_label(
                &VerifyKind::SlashCommand {
                    name: "/ppvp".to_string(),
                    args: vec!["--staging".to_string()]
                },
                2
            ),
            "slash:/ppvp (step 3)"
        );
    }

    // v1.15.0 (Cycle E1): SlashCommand verify runtime tests.

    #[test]
    fn a_slash_check_without_claude_says_it_needs_claude_code() {
        let codex_only = crate::shell_env::ShellEnv {
            codex_path: Some("/bin/codex".into()),
            ..Default::default()
        };
        assert_eq!(
            slash_claude_path(&codex_only).unwrap_err(),
            "This check runs a Claude command, and Claude Code isn't installed."
        );
        let claude = crate::shell_env::ShellEnv {
            claude_path: Some("/bin/claude".into()),
            claude_version: Some("2.1.330".into()),
            ..Default::default()
        };
        let there = |_: &str| true;
        assert_eq!(slash_claude_path_with(&claude, there).unwrap(), "/bin/claude");
        // R3: a path that isn't on disk needs Claude Code; one that doesn't
        // start says so; a slow `--version` still runs.
        assert_eq!(slash_claude_path_with(&claude, |_| false).unwrap_err(), SLASH_NEEDS_CLAUDE);
        let dead = crate::shell_env::ShellEnv { claude_version: None, ..claude.clone() };
        assert!(slash_claude_path_with(&dead, there).unwrap_err().contains("doesn't start"));
        let slow = crate::shell_env::ShellEnv { claude_version_unknown: true, ..dead };
        assert_eq!(slash_claude_path_with(&slow, there).unwrap(), "/bin/claude");
    }

    /// A6: a check that failed after the project's settings asked for bypass
    /// says the check ran without it; any other failure reads as before.
    #[test]
    fn a_failed_check_says_when_the_projects_bypass_was_not_followed() {
        use crate::claude_session::{BypassAsked, WriterChoice, WriterMode, PROJECT_BYPASS_NOT_FOLLOWED};
        let own = WriterChoice { mode: WriterMode::Refuse, bypass_not_followed: None };
        assert_eq!(without_project_bypass("2 tests failed".into(), own), "2 tests failed");
        // The folder's own local file, which git couldn't judge: log only.
        let unjudged = WriterChoice { mode: WriterMode::AcceptEdits, bypass_not_followed: Some(BypassAsked::Unjudged) };
        assert_eq!(without_project_bypass("2 tests failed".into(), unjudged), "2 tests failed");
        let asked = WriterChoice { mode: WriterMode::AcceptEdits, bypass_not_followed: Some(BypassAsked::Shared) };
        assert_eq!(
            without_project_bypass("2 tests failed".into(), asked),
            format!("2 tests failed\n{PROJECT_BYPASS_NOT_FOLLOWED}")
        );
    }

    /// The check runs in Claude's interactive TUI, collected through its
    /// transcript: a named session, never `claude -p` or its output flags.
    #[test]
    fn a_slash_check_is_an_interactive_unattended_writer_session_not_print_mode() {
        use crate::claude_session::WriterMode;
        let argv = build_claude_slash_argv("ppvp", &[], WriterMode::Refuse, &crate::settings::ModelChoice::default());
        assert!(!argv.iter().any(|a| a == "-p" || a == "--print" || a == "--output-format"));
        assert_eq!(argv[0], crate::claude_session::SESSION_ID_FLAG);
        assert!(uuid::Uuid::parse_str(&argv[1]).is_ok(), "a session id: {argv:?}");
        assert_eq!(&argv[2..], ["--permission-mode", "dontAsk", "/ppvp", "--disallowedTools", "AskUserQuestion"]);
        assert!(crate::claude_session::collected_session_id(&argv).is_some());
        assert!(crate::claude_session::is_unattended_writer(&argv), "the startup net applies");
        // A writer: neither restricted nor tool-limited, like `-p` was.
        assert!(!argv.iter().any(|a| a == "--restricted" || a == "--tools"));
        // A fresh session each time.
        assert_ne!(build_claude_slash_argv("ppvp", &[], WriterMode::Refuse, &crate::settings::ModelChoice::default())[1], argv[1]);
        // The member's own mode.
        let bypass = build_claude_slash_argv("ppvp", &[], WriterMode::Bypass, &crate::settings::ModelChoice::default());
        assert_eq!(&bypass[2..4], ["--permission-mode", "bypassPermissions"]);
        let edits = build_claude_slash_argv("ppvp", &[], WriterMode::AcceptEdits, &crate::settings::ModelChoice::default());
        assert_eq!(&edits[2..4], ["--permission-mode", "dontAsk"]);
        assert_eq!(&edits[7..], ["--allowedTools", "Edit", "Write", "MultiEdit", "NotebookEdit"]);
    }

    #[test]
    fn build_claude_slash_argv_joins_args_into_prompt() {
        let argv = build_claude_slash_argv(
            "verify-build",
            &["--mode".to_string(), "release".to_string()],
            crate::claude_session::WriterMode::Refuse,
            &crate::settings::ModelChoice::default(),
        );
        // The prompt is a single arg with the slash command + space-joined args.
        assert_eq!(argv[4], "/verify-build --mode release");
    }

    /// The documented shape stores the name with its slash (`/ppvp`): the
    /// prompt has one slash either way, with or without arguments.
    #[test]
    fn a_slash_checks_name_gets_exactly_one_slash() {
        let refuse = crate::claude_session::WriterMode::Refuse;
        for name in ["/ppvp", "ppvp", "//ppvp", " /ppvp "] {
            assert_eq!(build_claude_slash_argv(name, &[], refuse, &crate::settings::ModelChoice::default())[4], "/ppvp", "{name:?}");
        }
        let args = ["tier1".to_string(), "--fast".to_string()];
        assert_eq!(build_claude_slash_argv("/ppvp", &args, refuse, &crate::settings::ModelChoice::default())[4], "/ppvp tier1 --fast");
        assert_eq!(build_claude_slash_argv("ppvp", &args, refuse, &crate::settings::ModelChoice::default())[4], "/ppvp tier1 --fast");
    }

    /// 1.168.1 (E1, Challenger): a check runs on the Builder row for Claude
    /// (before: none); blank passes no `--model`. Still a collected session.
    #[test]
    fn a_slash_check_carries_the_builder_model() {
        let refuse = crate::claude_session::WriterMode::Refuse;
        let opus = crate::settings::ModelChoice { model: Some("opus".into()), reasoning: None };
        let argv = build_claude_slash_argv("ppvp", &[], refuse, &opus);
        assert_eq!(argv[4], "/ppvp", "the prompt keeps its place");
        assert_eq!(&argv[argv.len() - 2..], ["--model", "opus"]);
        assert!(crate::claude_session::collected_session_id(&argv).is_some());
        let none = build_claude_slash_argv("ppvp", &[], refuse, &crate::settings::ModelChoice::default());
        assert!(!none.iter().any(|a| a == "--model"));
        // 1.169.0 (A1): and its effort.
        let low = crate::settings::ModelChoice { model: None, reasoning: Some("low".into()) };
        let argv = build_claude_slash_argv("ppvp", &[], refuse, &low);
        assert_eq!(&argv[argv.len() - 2..], ["--effort", "low"]);
        assert!(!argv.iter().any(|a| a == "--model"));
    }

    #[test]
    fn build_claude_slash_argv_skips_empty_args() {
        let argv = build_claude_slash_argv(
            "ppvp",
            &["".to_string(), "tier1".to_string(), "".to_string()],
            crate::claude_session::WriterMode::Refuse,
            &crate::settings::ModelChoice::default(),
        );
        assert_eq!(argv[4], "/ppvp tier1");
    }

    /// A timed-out check says what Claude's screen last showed; a session
    /// that ended without Plyloft's result line failed whatever its exit
    /// code; the startup net's unknown screen is never a capacity stall.
    #[test]
    fn a_slash_checks_timeout_and_missing_result_line_fail_with_the_screen() {
        let reason = slash_timeout_reason("slash:/ppvp (step 1)", 600, "Some dialog\n> 1. Continue");
        assert!(reason.starts_with("step `slash:/ppvp (step 1)` timed out after 600s. Claude's screen last showed:"));
        assert!(reason.contains("1. Continue"));
        assert_eq!(slash_timeout_reason("s", 5, "  "), "step `s` timed out after 5s");
        assert_eq!(parse_result_line("Welcome back\nexited"), None, "no result line: failed by the caller");
        let unknown = crate::claude_session::unknown_screen_line("s", "Upgrade or wait for your usage limit");
        assert_eq!(parse_result_line(&unknown), Some(false));
        assert_eq!(slash_capacity_stall(&unknown), None, "an unknown screen is never classified");
        assert!(slash_failure_reason(&unknown, Path::new("/x")).starts_with("Claude is waiting on a screen Plyloft doesn't know"));
    }

    /// What a collected session hands back: its transcript, then Plyloft's
    /// result line (`claude_session::result_line`).
    fn collected(transcript_text: &str, result: &str) -> String {
        format!(
            "{}\n{result}\n",
            serde_json::json!({"type": "assistant", "message": {"content": [{"type": "text", "text": transcript_text}], "stop_reason": "end_turn"}})
        )
    }

    #[test]
    fn a_slash_checks_result_line_decides_and_names_the_failure() {
        let ok = collected("all green", &crate::claude_session::result_line("s", "all green", false, None));
        assert_eq!(parse_result_line(&ok), Some(true));
        let failed = collected(
            "x",
            &crate::claude_session::result_line("s", "API Error: overloaded", true, None),
        );
        assert_eq!(parse_result_line(&failed), Some(false));
        let cwd = Path::new("/work/card");
        assert_eq!(slash_failure_reason(&failed, cwd), "API Error: overloaded");
        // No result line (a timeout's screen tail): the output's end.
        assert_eq!(slash_failure_reason("Welcome\nworking…", cwd), "Welcome\nworking…");
        // The folder-trust refusal names the check's own folder.
        let trust = crate::claude_session::result_line("s", crate::claude_session::FOLDER_TRUST_REFUSAL, true, None);
        assert_eq!(slash_failure_reason(&trust, cwd), crate::claude_session::writer_trust_refusal(cwd));
        assert!(slash_failure_reason(&trust, cwd).contains("/work/card"));
    }

    /// The rule for every collected session: a capacity stall is read from
    /// Plyloft's result line, never from the conversation.
    #[test]
    fn a_slash_checks_capacity_stall_is_read_from_its_result_line_only() {
        // The command's own words quote a limit: the check passed, no stall.
        let talk = collected(
            "the docs say: Max plan session limit reached",
            &crate::claude_session::result_line("s", "the docs say: Max plan session limit reached", false, None),
        );
        assert_eq!(slash_capacity_stall(&talk), None);
        // The usage-limit screen that stopped the session.
        let screen = crate::claude_session::result_line("s", crate::claude_session::USAGE_LIMIT, true, None);
        assert_eq!(slash_capacity_stall(&screen).as_deref(), Some(crate::claude_session::USAGE_LIMIT));
        // An API error in the transcript's own error answer.
        let api = crate::claude_session::result_line("s", "rate_limit_error: slow down", true, None);
        assert_eq!(slash_capacity_stall(&api).as_deref(), Some("rate_limit_error"));
        // A turn that ended without an answer carries Claude's own words.
        let words = crate::claude_session::result_line_for("s", "the usage limit is unclear", true, true, None);
        assert_eq!(slash_capacity_stall(&words), None);
        // A failing transcript mentioning a limit, with no result line.
        assert_eq!(slash_capacity_stall("session limit reached"), None);
    }

    #[test]
    fn parse_result_line_passes_on_is_error_false() {
        let stream = r#"{"type":"system","subtype":"init"}
{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}
{"type":"result","is_error":false,"total_cost_usd":0.012,"result":"ok"}"#;
        assert_eq!(parse_result_line(stream), Some(true));
    }

    #[test]
    fn parse_result_line_fails_on_is_error_true() {
        let stream = r#"{"type":"system","subtype":"init"}
{"type":"result","is_error":true,"result":"verify step found a regression"}"#;
        assert_eq!(parse_result_line(stream), Some(false));
    }

    #[test]
    fn parse_result_line_returns_none_when_no_result_event() {
        let stream = r#"{"type":"system","subtype":"init"}
{"type":"assistant","message":{"content":[{"type":"text","text":"thinking"}]}}"#;
        assert_eq!(parse_result_line(stream), None);
    }

    #[test]
    fn parse_result_line_returns_none_on_garbage_input() {
        assert_eq!(parse_result_line(""), None);
        assert_eq!(parse_result_line("not json at all\nstill not json"), None);
        assert_eq!(parse_result_line("{not even valid json}"), None);
    }

    #[test]
    fn parse_result_line_finds_last_result_event_when_multiple() {
        // If a stream somehow has multiple result events, the last one wins
        // (matches the bottom-up scan order). In practice claude emits one.
        let stream = r#"{"type":"result","is_error":true,"result":"first"}
{"type":"assistant","message":{"content":[]}}
{"type":"result","is_error":false,"result":"second"}"#;
        assert_eq!(parse_result_line(stream), Some(true));
    }

    #[test]
    fn parse_result_line_tolerates_missing_is_error_field() {
        // Defensive: if claude ever emits a result event without is_error,
        // treat it as success rather than failing the verify step.
        let stream = r#"{"type":"result","result":"done"}"#;
        assert_eq!(parse_result_line(stream), Some(true));
    }
}

#[cfg(test)]
mod tests_old {
    use super::*;

    #[test]
    fn job_key_uniqueness() {
        assert_ne!(job_key("ws1", "card-A"), job_key("ws2", "card-A"));
        assert_eq!(job_key("ws1", "card-A"), job_key("ws1", "card-A"));
    }

    #[test]
    fn short_tail_keeps_the_end_and_marks_the_cut_in_front() {
        let s = format!("{}END", "a".repeat(500));
        let t = short_tail(&s, 50);
        assert_eq!(t.chars().count(), 51); // ellipsis + 50
        assert!(t.starts_with('…'));
        assert!(t.ends_with("END"));
        assert_eq!(short_tail("hello", 50), "hello");
    }

    /// The failing test's own report of what failed, after `noise` lines.
    fn cargo_failure(noise: usize) -> String {
        let mut out = String::new();
        for i in 0..noise {
            out.push_str(&format!(
                "Initialized empty Git repository in /T/.tmp{i:04}/seed/.git/ [main (root-commit) f658a14] init\n"
            ));
        }
        out.push_str("failures:\n    verify::tests::the_failing_one\n\n");
        out.push_str("test result: FAILED. 1 failed\n");
        out
    }

    #[test]
    fn failure_reason_keeps_the_end_of_a_long_output() {
        let output = cargo_failure(60);
        assert!(output.chars().count() > 5000);
        let reason = failure_reason(&output);
        assert!(reason.ends_with("test result: FAILED. 1 failed"), "{reason}");
        assert!(reason.contains("verify::tests::the_failing_one"));
        assert!(reason.starts_with('…'), "a cut is marked at the top: {reason}");
        assert!(reason.chars().count() <= REASON_MAX_CHARS + 40);
        assert!(!reason.contains(".tmp0000"), "the head is what's dropped");
    }

    #[test]
    fn failure_reason_marks_omitted_lines_and_passes_short_output_through() {
        let many = (0..200).map(|i| format!("line-{i}")).collect::<Vec<_>>().join("\n");
        let reason = failure_reason(&many);
        assert!(reason.starts_with("… (120 earlier lines omitted)\nline-120\n"), "{reason}");
        assert!(reason.ends_with("line-199"));

        assert_eq!(failure_reason("boom\n"), "boom");

        let one_line = format!("{}FAILED", "x".repeat(5000));
        let reason = failure_reason(&one_line);
        assert!(reason.starts_with('…') && reason.ends_with("FAILED"));
    }

    /// GH #62: a real failing step records the end of its output as the
    /// reason, keeps the complete output as its log, and the next run
    /// replaces that log.
    #[test]
    fn failing_step_records_the_tail_and_writes_the_complete_log() {
        let repo = tempfile::tempdir().unwrap();
        let logs = tempfile::tempdir().unwrap();
        let path = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into());
        let output = cargo_failure(60);
        std::fs::write(repo.path().join("out.txt"), &output).unwrap();
        // Half to stderr, the verdict to stdout: one ordered stream.
        std::fs::write(
            repo.path().join("step.sh"),
            "head -c 2500 out.txt >&2; tail -c +2501 out.txt; \
             test -n \"$PLY_VERIFY_LOG_DIR\" && test -d \"$PLY_VERIFY_LOG_DIR\"; exit 1\n",
        )
        .unwrap();

        let run_dir = crate::verify_logs::begin_run_in(logs.path(), "ws", "card", "verify-1").unwrap();
        let step = run_step_on_path(
            repo.path(),
            &["bash", "step.sh"],
            None,
            &[],
            30,
            "script:scripts/ppvp.sh",
            Some(&run_dir),
            &path,
        );
        assert!(!step.passed);
        let reason = step.reason.unwrap();
        assert!(reason.contains("test result: FAILED. 1 failed"), "{reason}");
        assert!(reason.contains("verify::tests::the_failing_one"));

        let log = crate::verify_logs::step_log_path_in(
            logs.path(),
            "ws",
            "card",
            "verify-1",
            "script:scripts/ppvp.sh",
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&log).unwrap(), output, "the log is complete");

        let run_dir = crate::verify_logs::begin_run_in(logs.path(), "ws", "card", "verify-2").unwrap();
        assert!(!log.exists(), "the next run replaces the previous log");
        std::fs::write(repo.path().join("step.sh"), "echo all good\n").unwrap();
        let step = run_step_on_path(
            repo.path(),
            &["bash", "step.sh"],
            None,
            &[],
            30,
            "script:scripts/ppvp.sh",
            Some(&run_dir),
            &path,
        );
        assert!(step.passed && step.reason.is_none());
        let log = crate::verify_logs::step_log_path_in(
            logs.path(),
            "ws",
            "card",
            "verify-2",
            "script:scripts/ppvp.sh",
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "all good\n");
    }

    /// 1.174.0 (DR2): Stop the release ends the release's checks at once —
    /// the running step and what it started (its whole process group) are
    /// killed, it says `stopped` (not failed), and no later step runs.
    #[cfg(unix)]
    #[test]
    fn a_stopped_release_check_is_killed_with_its_whole_tree() {
        let _env = crate::shell_env::lock_for_test();
        crate::shell_env::init();
        let repo = tempfile::tempdir().unwrap();
        std::fs::write(
            repo.path().join("slow.sh"),
            "(while true; do date +%s >> alive; sleep 0.05; done) &\nsleep 30\n",
        )
        .unwrap();
        std::fs::write(repo.path().join("after.sh"), "touch ran-after\n").unwrap();
        let pipeline = vec![
            VerifyKind::Script { path: "slow.sh".into() },
            VerifyKind::Script { path: "after.sh".into() },
        ];
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let alive = repo.path().join("alive");
        let setter = {
            let (stop, alive) = (stop.clone(), alive.clone());
            thread::spawn(move || {
                let until = Instant::now() + Duration::from_secs(10);
                while !alive.exists() && Instant::now() < until {
                    thread::sleep(Duration::from_millis(20));
                }
                stop.store(true, std::sync::atomic::Ordering::SeqCst);
            })
        };
        let started = Instant::now();
        let checks = run_script_checks_in(&pipeline, repo.path(), &[], Some(&stop));
        setter.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(10), "stopped, not waited out");
        assert!(checks.stopped && checks.failed.is_none(), "{checks:?}");
        assert!(!repo.path().join("ran-after").exists(), "no later step ran");
        let before = std::fs::metadata(&alive).map(|m| m.len()).unwrap_or(0);
        thread::sleep(Duration::from_millis(400));
        let after = std::fs::metadata(&alive).map(|m| m.len()).unwrap_or(0);
        assert_eq!(before, after, "what the step started died with it");

        // A flag set before they start: none runs.
        let checks = run_script_checks_in(&pipeline, repo.path(), &[], Some(&stop));
        assert!(checks.stopped && checks.ran.is_empty(), "{checks:?}");
        // Without a flag, as before.
        std::fs::write(repo.path().join("slow.sh"), "exit 0\n").unwrap();
        let checks = run_script_checks_in(&pipeline, repo.path(), &[], None);
        assert!(!checks.stopped && checks.failed.is_none(), "{checks:?}");
        assert_eq!(checks.ran, vec!["slow.sh".to_string(), "after.sh".into()]);
    }

    /// Hard rule 4 (DR2): the release's checks run in Verify's step groups,
    /// the registry `ExitRequested` kills (`verify::kill_active_steps`).
    #[test]
    fn the_release_checks_run_in_the_registry_killed_on_exit() {
        let source = include_str!("verify.rs");
        let (_, body) = source.split_once("pub(crate) fn run_script_checks_in(").unwrap();
        let body = body.split_once("\n}\n").unwrap().0;
        assert!(body.contains("run_with_limits_in(\n                    &STEP_GROUPS,"), "{body}");
        assert!(include_str!("lib.rs").contains("let verify_steps = verify::kill_active_steps();"));
    }

    /// Challenger P2 on #62: a background process a step leaves printing
    /// is killed with the step, the call returns, and memory holds only the
    /// capped tail while the on-disk log keeps head, marker and end.
    #[cfg(unix)]
    #[test]
    fn a_background_writer_is_killed_with_its_step_and_capture_stays_bounded() {
        let repo = tempfile::tempdir().unwrap();
        let path = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into());
        let raw = repo.path().join("step.log.raw");
        let started = Instant::now();
        let out = run_with_limits(
            repo.path(),
            &["(while true; do echo noise; date +%s >> alive; sleep 0.01; done) & \
               for i in $(seq 1 3000); do echo line-$i; done; exit 1"],
            None,
            &[],
            Duration::from_secs(20),
            &path,
            Capture::new(Some(&raw), 1024, 4096),
        )
        .ok()
        .expect("the step exits");
        assert!(started.elapsed() < Duration::from_secs(10), "the call returns");
        assert_eq!(out.code, 1);
        assert!(out.tail.len() <= 2 * 1024 + 64, "memory holds a bounded tail");
        assert!(out.tail.contains("line-3000"), "{}", out.tail);
        assert!(out.earlier_lines > 2000);

        let alive = repo.path().join("alive");
        let before = std::fs::metadata(&alive).map(|m| m.len()).unwrap_or(0);
        thread::sleep(Duration::from_millis(400));
        let after = std::fs::metadata(&alive).map(|m| m.len()).unwrap_or(0);
        assert_eq!(before, after, "the background writer died with the step");

        let log = std::fs::read(&raw).unwrap();
        assert!(log.len() < 4096 + 2 * 1024 + 128, "the log is capped: {}", log.len());
        let log = String::from_utf8_lossy(&log);
        // Head, marker, then the end; the background writer's noise may
        // interleave anywhere.
        let marker = log.find("bytes omitted from this log").expect("the cap is marked");
        assert!(log[..marker].contains("line-1\n"), "the head is kept");
        assert!(log[marker..].contains("line-3000\n"), "the end is kept");
    }

    /// Challenger P2 on snapshot 2: newline-free output whose only newline
    /// is its last byte kept nothing, so the reason came out empty.
    #[test]
    fn capture_keeps_the_end_when_the_only_newline_is_the_last_byte() {
        let mut capture = Capture::new(None, 1024, 0);
        capture.push(&vec![b'x'; 4096]);
        capture.push(b"FAILED\n");
        let (tail, earlier_lines) = capture.finish();
        assert!(tail.ends_with("FAILED\n"), "{tail:?}");
        assert!(tail.len() >= 1024);
        assert_eq!(earlier_lines, 0);
        assert!(failure_reason_after(&tail, earlier_lines).ends_with("FAILED"));

        // A newline just before a short last line keeps the long line too.
        let mut capture = Capture::new(None, 1024, 0);
        capture.push(&vec![b'y'; 4096]);
        capture.push(b"FAILED\nx");
        let (tail, _) = capture.finish();
        assert!(tail.ends_with("FAILED\nx") && tail.len() >= 1024, "{tail:?}");

        // Lines at the cut still start the tail on a boundary.
        let mut capture = Capture::new(None, 1024, 0);
        for i in 0..1000 {
            capture.push(format!("line-{i}\n").as_bytes());
        }
        let (tail, earlier_lines) = capture.finish();
        assert!(tail.starts_with("line-") && tail.ends_with("line-999\n"));
        assert_eq!(earlier_lines + tail.lines().count(), 1000);
    }

    #[cfg(unix)]
    #[test]
    fn a_timed_out_step_is_killed_with_its_descendants() {
        let repo = tempfile::tempdir().unwrap();
        let path = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into());
        let started = Instant::now();
        let out = run_with_limits(
            repo.path(),
            &["(while true; do date +%s >> alive; sleep 0.01; done) & while true; do echo noise; sleep 0.01; done"],
            None,
            &[],
            Duration::from_secs(1),
            &path,
            Capture::new(None, 1024, 4096),
        );
        assert!(matches!(out, Err(StepError::TimedOut { .. })));
        assert!(started.elapsed() < Duration::from_secs(6));
        let alive = repo.path().join("alive");
        let before = std::fs::metadata(&alive).map(|m| m.len()).unwrap_or(0);
        thread::sleep(Duration::from_millis(400));
        assert_eq!(before, std::fs::metadata(&alive).map(|m| m.len()).unwrap_or(0));
    }

    /// core.autocrlf checks scripts out with CRLF on Windows; Git Bash still
    /// runs them, through the resolved bash for the inner script too.
    #[cfg(windows)]
    #[test]
    fn a_crlf_script_runs_with_git_bash() {
        let repo = tempfile::tempdir().unwrap();
        let path = std::env::var("PATH").unwrap_or_default();
        std::fs::write(repo.path().join("step.sh"), "set -e\r\nx=ok\r\necho \"$x\"\r\n").unwrap();
        let bash = crate::shell_env::bash_word(&path);
        assert!(bash.starts_with('\'') && bash.contains("/bin/bash.exe"), "{bash}");
        let step = run_step_on_path(repo.path(), &[&bash, "step.sh"], None, &[], 30, "crlf", None, &path);
        assert!(step.passed, "{:?}", step.reason);
    }

    #[test]
    fn a_step_printing_more_than_a_pipe_buffer_finishes() {
        let repo = tempfile::tempdir().unwrap();
        let path = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into());
        let step = run_step_on_path(
            repo.path(),
            &["yes x | head -c 1000000; echo; echo LAST; exit 3"],
            None,
            &[],
            20,
            "big",
            None,
            &path,
        );
        assert!(!step.passed);
        assert!(step.reason.unwrap().ends_with("LAST"));
    }

    #[test]
    fn tail_lines_keeps_last_n() {
        let s = (0..100).map(|i| format!("line-{i}")).collect::<Vec<_>>().join("\n");
        let t = tail_lines(&s, 10);
        assert_eq!(t.lines().count(), 10);
        assert!(t.starts_with("line-90"));
        assert!(t.ends_with("line-99"));
    }

    #[test]
    fn registry_count_inflight_starts_zero() {
        let r = VerifyRegistry::default();
        assert_eq!(r.count_inflight(), 0);
        assert!(r.list_inflight().is_empty());
    }
}
