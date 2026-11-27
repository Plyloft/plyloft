//! Swarm — multi-agent orchestration (v1.0).
//!
//! A swarm is a goal-directed group of role-bound agents that hand work
//! between each other inside one workspace. v1.0 ships a single hardcoded
//! template: `scout → build → review` with build↔review loopback.
//!
//! This module owns:
//! - persistence (`<config_dir>/swarms/<id>/state.json`)
//! - the append-only mailbox (`<config_dir>/swarms/<id>/mailbox.jsonl`)
//! - lifecycle (`swarm_start` guards, `abort`, `kill_all`, `reconcile_orphans`)
//!
//! S3 scope: persistence + lifecycle skeleton. The FSM, role-preset seeding,
//! and IPC live in S4 / S6 / S5 respectively. See `docs/SWARM_DESIGN.md`.
//!
//! Hard rules respected: atomic writes (#3) for `state.json`; mailbox JSONL
//! uses append + `sync_all` per-line. Reader is partial-line resilient
//! (a mid-write process kill leaves a malformed last line; readers skip it).

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;

use crate::atomic::write_atomic_json;
use std::time::SystemTime;
use tauri::Emitter;
use uuid::Uuid;

const SWARMS_SUBDIR: &str = "swarms";
const STATE_FILE: &str = "state.json";
const MAILBOX_FILE: &str = "mailbox.jsonl";
const SCHEMA_V1: u32 = 1;

/// v1.1.0 (resumable swarms): a swarm in `Suspended` state for longer than
/// this many seconds is considered stale on next launch — the codebase has
/// likely drifted enough that resuming would produce a builder diff against
/// an inconsistent state. `reconcile_orphans` flips it to `Failed` instead.
/// 24h is a deliberate-but-conservative threshold; revisit if it bites in
/// practice. See `docs/RESUMABLE_SWARMS_DESIGN.md` §6.5.
const STALE_SUSPENDED_SECONDS: i64 = 24 * 3600;

/// Global wall-time backstop for the periodic `wall_time_exceeded_swarms`
/// runtime tick (`agents::runtime_tick`, which catches a swarm hung mid-leg). Per-transition
/// enforcement in `on_swarm_run_done` uses the *template's*
/// `max_wall_seconds` instead — this const must stay >= the largest builtin
/// template cap so the backstop never undercuts a template's own budget.
///
/// v1.31.0: raised 1800 → 3600. The original 30 min was too tight for a
/// multi-round bugfix on a real codebase (scout + 2–3 build/review rounds).
/// `effective_wall_seconds` / `wall_time_exceeded` subtract
/// `suspended_seconds` so a long suspension doesn't burn the budget.
pub const MAX_WALL_SECONDS: u64 = 3600;

// ── Types ──────────────────────────────────────────────

/// High-level swarm lifecycle phase. Coexists with `SwarmState` (the FSM
/// position) — see `docs/SWARM_DESIGN.md` §5.1. The state machine (S4) keeps
/// the two in sync.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SwarmStatus {
    Running,
    Done,
    Failed,
    Aborted,
    TimedOut,
    MaxIter,
    /// v1.1.0: swarm was Running when Atelier exited (Cmd-Q or crash).
    /// Distinct from Aborted (which now means user-clicked abort only).
    /// Resumable via `swarm_resume` IPC; auto-promoted to Failed at the
    /// 24h staleness cutoff. See `docs/RESUMABLE_SWARMS_DESIGN.md`.
    Suspended,
}

/// FSM position. v1.2.0 generalized this to be template-driven: any active
/// step is `PendingStep { idx, role, prior_run_ids }` regardless of which
/// template is running. Terminal variants are unit; the human-readable
/// reason lives on `Swarm.end_reason`.
///
/// **Role on PendingStep** is a small deviation from the v1.2 design doc
/// (which had only `idx` + `prior_run_ids`). Carrying the role string makes
/// `derive_role_from_state` and `suspend_for_orphan` self-contained — they
/// don't need to thread a `SwarmTemplatesStore` handle through the
/// `SwarmRegistry` API surface. The string is redundant with
/// `template.steps[idx].role` but cheap.
///
/// **Legacy compat:** v1.0/v1.1 wrote `pending_scout` / `pending_build` /
/// `pending_review` as the `kind` discriminator with auxiliary
/// `scout_run_id` / `build_run_id` fields. v1.2 deserializes those into
/// the equivalent `PendingStep` via the custom `Deserialize` impl below
/// (assumes the swarm uses the `feature` template — true by construction
/// since v1.0/v1.1 only had one template). Aliases are kept for one
/// release; remove in v1.3+.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SwarmState {
    PendingStep {
        idx: u32,
        role: String,
        #[serde(default)]
        prior_run_ids: Vec<String>,
    },
    /// v1.3.0: the coordinator is about to fire (or its tick artifact is
    /// pending parse). `tick` increments each round trip through the
    /// coordinator. Schema-additive; not produced by v1.2 templates.
    PendingCoordinator {
        tick: u32,
    },
    /// v1.3.0: a fan-out is in flight. `instances` snapshots every leg
    /// the coordinator dispatched on this tick (with their per-leg state
    /// `pending`/`running`/`done`/`failed`). The FSM advances back to
    /// `PendingCoordinator { tick + 1 }` once every instance reaches a
    /// terminal status.
    Dispatching {
        tick: u32,
        #[serde(default)]
        instances: Vec<RoleInstance>,
    },
    Done,
    Failed,
    Aborted,
    TimedOut,
    MaxIter,
}

/// v1.3.0: per-leg state inside a `Dispatching` swarm. Distinct from the
/// swarm-wide `SwarmStatus` — every instance has its own lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstanceStatus {
    Pending,
    Running,
    Done,
    Failed,
}

/// v1.3.0: one fan-out leg dispatched by the coordinator. The `id` is
/// generated by the coordinator (e.g. "builder-api", "builder-ui") and
/// remains stable across the leg's lifetime — used as the inflight-key
/// component on `AgentRun.swarm_role_instance_id`.
///
/// `RoleInstance` is also reused for `Swarm.in_flight_at_suspend` (the
/// suspend/resume snapshot for parallel swarms): the `status` field gets
/// frozen at suspend-time and resume can re-fire only the legs that were
/// not yet `done`/`failed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleInstance {
    pub id: String,
    pub role: String,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub owner_globs: Vec<String>,
    #[serde(default)]
    pub task: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    pub status: InstanceStatus,
}

impl<'de> Deserialize<'de> for SwarmState {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // Read into a serde_json::Value first so we can branch on the
        // `kind` discriminator. Cost is one extra allocation per swarm
        // load; acceptable for a once-per-startup path.
        let v = serde_json::Value::deserialize(deserializer)?;
        let kind = v
            .get("kind")
            .and_then(|k| k.as_str())
            .ok_or_else(|| serde::de::Error::custom("SwarmState: missing 'kind' field"))?;
        match kind {
            "pending_step" => {
                let idx = v
                    .get("idx")
                    .and_then(|x| x.as_u64())
                    .ok_or_else(|| serde::de::Error::custom("pending_step: missing idx"))?;
                let role = v
                    .get("role")
                    .and_then(|x| x.as_str())
                    .ok_or_else(|| serde::de::Error::custom("pending_step: missing role"))?
                    .to_string();
                let prior_run_ids = v
                    .get("prior_run_ids")
                    .and_then(|x| x.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|item| item.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                Ok(SwarmState::PendingStep {
                    idx: idx as u32,
                    role,
                    prior_run_ids,
                })
            }
            // Legacy v1.0/v1.1 → v1.2 alias mappings. Indices match the
            // `feature` built-in template.
            "pending_scout" => Ok(SwarmState::PendingStep {
                idx: 0,
                role: "scout".into(),
                prior_run_ids: Vec::new(),
            }),
            "pending_build" => {
                let scout_run_id = v
                    .get("scout_run_id")
                    .and_then(|x| x.as_str())
                    .map(String::from)
                    .unwrap_or_default();
                let prior_run_ids = if scout_run_id.is_empty() {
                    Vec::new()
                } else {
                    vec![scout_run_id]
                };
                Ok(SwarmState::PendingStep {
                    idx: 1,
                    role: "builder".into(),
                    prior_run_ids,
                })
            }
            "pending_review" => {
                let scout_run_id = v
                    .get("scout_run_id")
                    .and_then(|x| x.as_str())
                    .map(String::from);
                let build_run_id = v
                    .get("build_run_id")
                    .and_then(|x| x.as_str())
                    .map(String::from);
                let mut prior = Vec::new();
                if let Some(s) = scout_run_id {
                    prior.push(s);
                }
                if let Some(b) = build_run_id {
                    prior.push(b);
                }
                Ok(SwarmState::PendingStep {
                    idx: 2,
                    role: "reviewer".into(),
                    prior_run_ids: prior,
                })
            }
            "done" => Ok(SwarmState::Done),
            "failed" => Ok(SwarmState::Failed),
            "aborted" => Ok(SwarmState::Aborted),
            "timed_out" => Ok(SwarmState::TimedOut),
            "max_iter" => Ok(SwarmState::MaxIter),
            // v1.3.0 additions. Round-trip through serde_json::from_value
            // for the structured variants — keeps the parser DRY.
            "pending_coordinator" => {
                let tick = v
                    .get("tick")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0) as u32;
                Ok(SwarmState::PendingCoordinator { tick })
            }
            "dispatching" => {
                let tick = v
                    .get("tick")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(0) as u32;
                let instances: Vec<RoleInstance> = v
                    .get("instances")
                    .cloned()
                    .map(|val| serde_json::from_value(val).unwrap_or_default())
                    .unwrap_or_default();
                Ok(SwarmState::Dispatching { tick, instances })
            }
            other => Err(serde::de::Error::custom(format!(
                "SwarmState: unknown kind '{other}'"
            ))),
        }
    }
}

/// v1.22.0: how the swarm was initiated. Used to differentiate kanban
/// card-driven runs from the dedicated Brainstorm modal and from the
/// direct `Start swarm` button. Persisted on the Swarm record; loaded
/// records without this field default to `Adhoc`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SwarmKind {
    Adhoc,
    Card,
    Brainstorm,
}

fn default_swarm_kind() -> SwarmKind {
    SwarmKind::Adhoc
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Swarm {
    #[serde(default = "default_schema")]
    pub schema_version: u32,
    pub id: String,
    pub workspace_id: String,
    pub template_id: String,
    pub goal: String,
    pub status: SwarmStatus,
    pub state: SwarmState,
    /// v1.22.0: how this swarm was initiated. `Adhoc` is the v1.x default
    /// (Start swarm button on the Swarms tab); `Card` is set when fired
    /// from a kanban card drag; `Brainstorm` is set when fired from the
    /// dedicated Brainstorm modal. Existing persisted swarms load with
    /// this defaulted to `Adhoc`.
    #[serde(default = "default_swarm_kind")]
    pub kind: SwarmKind,
    /// Bumped each time `builder` fires after the first iteration.
    #[serde(default)]
    pub iteration: u32,
    /// role name → AgentConfig id. Populated in S6 (`ensure_presets`); empty
    /// during S3 testing.
    #[serde(default)]
    pub role_bindings: HashMap<String, String>,
    /// Every AgentRun spawned by this swarm, in order.
    #[serde(default)]
    pub run_ids: Vec<String>,
    pub started_at: i64,
    #[serde(default)]
    pub ended_at: Option<i64>,
    /// Human-readable terminator message; written when the swarm reaches a
    /// terminal status. e.g. "approved by reviewer" / "exceeded max_wall".
    #[serde(default)]
    pub end_reason: Option<String>,
    /// v1.1.0 (resumable swarms): unix-ms timestamp when status flipped to
    /// `Suspended`. None on every other status. Cleared on resume. See
    /// `docs/RESUMABLE_SWARMS_DESIGN.md` §5.1.
    #[serde(default)]
    pub suspended_at: Option<i64>,
    /// v1.1.0: cumulative seconds the swarm has spent in `Suspended` state
    /// across however many suspend/resume cycles. Subtracted from the
    /// wall-time check so an 8h suspension doesn't burn the budget.
    #[serde(default)]
    pub suspended_seconds: u64,
    /// v1.1.0: which role's run was in-flight at the moment of suspend.
    /// Used by `swarm_resume` to decide which role to re-fire. Cleared on
    /// resume.
    ///
    /// v1.3.0: superseded for parallel swarms by `in_flight_at_suspend`
    /// below. Kept for back-compat with v1.1/v1.2 records (sequential
    /// templates have at most one in-flight role; this string is exactly
    /// what gets re-fired). When `in_flight_at_suspend` is non-empty,
    /// resume favors that vec; this field becomes informational.
    #[serde(default)]
    pub in_flight_role_at_suspend: Option<String>,
    /// v1.3.0: snapshot of every fan-out leg in flight at the moment of
    /// suspend (for parallel swarms running a coordinator-mode template).
    /// Empty Vec for sequential v1.0/v1.1/v1.2 swarms — those use the
    /// single-string `in_flight_role_at_suspend` above. Resume re-fires
    /// every captured leg whose `status` is still `pending`/`running`.
    #[serde(default)]
    pub in_flight_at_suspend: Vec<RoleInstance>,
    /// v1.31.0 (Cycle 1 — Review surface fix): the swarm's effective working
    /// directory — the per-card git worktree for card swarms, the raw
    /// workspace cwd otherwise. Persisted so the FSM advance, the coordinator
    /// fan-out, and resume all fire later legs in the SAME directory as the
    /// first leg. Before this field, `swarm_start` honored the worktree only
    /// for leg 1; every later leg re-resolved `workspace.cwd` and silently
    /// wrote to the main checkout. Empty on swarms persisted before the fix —
    /// readers fall back to `workspace.cwd`.
    #[serde(default)]
    pub cwd: String,
    /// v1.31.0 (Cycle 1 — Review surface): sticky flag set when any of the
    /// swarm's runs was rate-limited / throttled. The FE's swarm-terminal
    /// mapper reads it so a throttled-then-failed swarm surfaces on the
    /// card as "Rate-limited" (queue-eligible for retry) rather than a
    /// genuine "Failed". Additive — legacy swarms load false.
    #[serde(default)]
    pub throttled: bool,
}

fn default_schema() -> u32 {
    SCHEMA_V1
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MailboxKind {
    Created,
    Dispatch,
    Report,
    Artifact,
    Terminate,
    /// v1.1.0: appended once per Cmd-Q while a swarm is running. Carries
    /// `{ in_flight_role, in_flight_run_id }` in the body.
    Suspend,
    /// v1.1.0: appended once per click of the Resume button. Carries
    /// `{ from_role, suspended_seconds }` in the body.
    Resume,
    /// v1.3.0: a coordinator emitted a tick artifact with a fresh dispatch
    /// list. Body carries the parsed `{ tick, dispatches }`. Distinct from
    /// `Dispatch` so the timeline reads "coordinator decided X, then
    /// these N legs spawned" rather than collapsing both into the same kind.
    CoordinatorTick,
    /// v1.3.0: a fan-out leg started its run. Body: `{ instanceId, role,
    /// agentId, ownerGlobs, task, dependsOn }`.
    InstanceStarted,
    /// v1.3.0: a fan-out leg finished (terminal status on the underlying
    /// AgentRun). Body: `{ instanceId, status, runId }`.
    InstanceDone,
    /// v1.3.0: a leg attempted to write outside its declared owner_globs,
    /// or two dispatches in the same tick declared overlapping globs.
    /// Body: `{ kind: "write_outside_globs" | "overlap_with", instanceId,
    /// path?, otherInstanceId? }`.
    Collision,
}

/// Per-run summary embedded in `report` mailbox entries. Self-contained so the
/// Swarm tab survives run-history pruning of the underlying `<runId>.json`
/// (see `docs/SWARM_DESIGN.md` §7).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub run_id: String,
    pub role: String,
    /// Lowercase status string (`"done"` / `"error"` / `"killed"`). Stored as
    /// a string rather than the agents-crate enum to keep this module
    /// independent of `agents.rs`.
    pub status: String,
    pub started_at: i64,
    #[serde(default)]
    pub ended_at: Option<i64>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub bytes_written: u64,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub total_cost_usd: Option<f64>,
    #[serde(default)]
    pub files_changed_count: Option<u32>,
    /// v1.31.0 (Cycle 1): true when this run's output carried a rate-limit
    /// signal. Propagated to `Swarm::throttled` by `apply_run_done`.
    #[serde(default)]
    pub throttled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxEntry {
    pub id: String,
    pub ts: i64,
    pub swarm_id: String,
    pub kind: MailboxKind,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<serde_json::Value>,
    /// Set on `report` entries — embeds run state so the swarm history is
    /// self-contained even after run-history pruning.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_summary: Option<RunSummary>,
}

// ── Registry ───────────────────────────────────────────

pub struct SwarmRegistry {
    swarms_dir: PathBuf,
    /// In-memory cache of all swarms. Keyed by swarm id. Source of truth is
    /// disk; the cache is loaded at `new()` and kept in sync on every mutation.
    cache: Mutex<HashMap<String, Swarm>>,
    /// Set once at startup by `lib.rs::setup`; absent in tests. When present,
    /// `append_mailbox` emits `swarm://mailbox` for live UI tail.
    app: OnceLock<tauri::AppHandle>,
    /// v1.30.0 (parallel swarms): max card-driven swarms allowed to run
    /// concurrently per workspace. Seeded from `Settings` at startup and on
    /// every settings change. Defaults to 3 so tests and any pre-wiring
    /// caller behave sanely. Only card-kind swarms are counted/capped —
    /// non-card swarms stay one-at-a-time regardless of this value.
    card_swarm_cap: AtomicUsize,
}

impl SwarmRegistry {
    pub fn new(config_dir: PathBuf) -> Result<Self, String> {
        let swarms_dir = config_dir.join(SWARMS_SUBDIR);
        fs::create_dir_all(&swarms_dir).map_err(|e| format!("create swarms dir: {e}"))?;
        let cache = load_all_from_disk(&swarms_dir)?;
        Ok(Self {
            swarms_dir,
            cache: Mutex::new(cache),
            app: OnceLock::new(),
            card_swarm_cap: AtomicUsize::new(3),
        })
    }

    /// Wire in an `AppHandle` after construction so `append_mailbox` can emit
    /// the `swarm://mailbox` event for the live UI tail. Idempotent — second
    /// call is a no-op (OnceLock semantics).
    pub fn set_app_handle(&self, app: tauri::AppHandle) {
        let _ = self.app.set(app);
    }

    /// v1.30.0 (parallel swarms): update the card-swarm concurrency cap.
    /// Called at startup and whenever the user changes the Settings value.
    /// Clamped to [1, 20] — `0` would deadlock the card queue, absurdly high
    /// values risk a Claude rate-limit meltdown.
    pub fn set_card_swarm_cap(&self, cap: usize) {
        self.card_swarm_cap
            .store(cap.clamp(1, 20), Ordering::Relaxed);
    }

    /// v1.30.0: the current card-swarm concurrency cap.
    pub fn card_swarm_cap(&self) -> usize {
        self.card_swarm_cap.load(Ordering::Relaxed)
    }

    /// v1.63.0: true while any swarm is Running. Consulted by the App Nap
    /// `ActivityGate` so inter-leg queue-pump gaps (moments with zero live
    /// PTYs mid-swarm) never release the suppression token.
    pub fn any_running(&self) -> bool {
        self.cache
            .lock()
            .values()
            .any(|s| s.status == SwarmStatus::Running)
    }

    /// Snapshot a single swarm by id.
    pub fn get(&self, id: &str) -> Option<Swarm> {
        self.cache.lock().get(id).cloned()
    }

    pub fn list(&self) -> Vec<Swarm> {
        self.cache.lock().values().cloned().collect()
    }

    pub fn list_by_workspace(&self, workspace_id: &str) -> Vec<Swarm> {
        self.cache
            .lock()
            .values()
            .filter(|s| s.workspace_id == workspace_id)
            .cloned()
            .collect()
    }

    /// True if any swarm in this workspace is currently `Running`.
    pub fn active_in_workspace(&self, workspace_id: &str) -> bool {
        self.cache
            .lock()
            .values()
            .any(|s| s.workspace_id == workspace_id && s.status == SwarmStatus::Running)
    }

    /// R7 (resumable swarms): true if any swarm in this workspace is currently
    /// `Suspended`. Used by `swarm_start` to force the user to Resume or
    /// Abort the suspended swarm before starting a fresh one.
    pub fn suspended_in_workspace(&self, workspace_id: &str) -> bool {
        self.cache
            .lock()
            .values()
            .any(|s| s.workspace_id == workspace_id && s.status == SwarmStatus::Suspended)
    }

    /// Exact card-swarm authority used by the verification/work interlock.
    /// A persisted card mirror alone never blocks; the linked registry record
    /// must still be running or resumable.
    pub fn is_card_swarm_live_or_resumable(
        &self,
        workspace_id: &str,
        swarm_id: &str,
    ) -> bool {
        self.cache.lock().get(swarm_id).is_some_and(|swarm| {
            swarm.workspace_id == workspace_id
                && swarm.kind == SwarmKind::Card
                && matches!(
                    swarm.status,
                    SwarmStatus::Running | SwarmStatus::Suspended
                )
        })
    }

    /// v1.30.0: count of `Running` card-kind swarms in this workspace.
    pub fn active_card_count(&self, workspace_id: &str) -> usize {
        self.cache
            .lock()
            .values()
            .filter(|s| {
                s.workspace_id == workspace_id
                    && s.status == SwarmStatus::Running
                    && s.kind == SwarmKind::Card
            })
            .count()
    }

    /// v1.30.0: count of `Suspended` card-kind swarms in this workspace. A
    /// suspended card swarm still owns its worktree, so it counts toward the
    /// cap until resumed or aborted.
    pub fn suspended_card_count(&self, workspace_id: &str) -> usize {
        self.cache
            .lock()
            .values()
            .filter(|s| {
                s.workspace_id == workspace_id
                    && s.status == SwarmStatus::Suspended
                    && s.kind == SwarmKind::Card
            })
            .count()
    }

    /// v1.30.0: true if a non-card (Adhoc / Brainstorm) swarm is `Running`
    /// in this workspace. Non-card swarms run in the raw workspace cwd, so
    /// only one may be active at a time.
    pub fn active_non_card_in_workspace(&self, workspace_id: &str) -> bool {
        self.cache.lock().values().any(|s| {
            s.workspace_id == workspace_id
                && s.status == SwarmStatus::Running
                && s.kind != SwarmKind::Card
        })
    }

    /// v1.30.0: true if a non-card swarm is `Suspended` in this workspace.
    pub fn suspended_non_card_in_workspace(&self, workspace_id: &str) -> bool {
        self.cache.lock().values().any(|s| {
            s.workspace_id == workspace_id
                && s.status == SwarmStatus::Suspended
                && s.kind != SwarmKind::Card
        })
    }

    /// v1.30.0 (parallel swarms): kind-aware slot admission check. Replaces
    /// the pre-v1.30 blanket "one swarm per workspace" gate.
    ///
    /// - Card swarms run in isolated per-card git worktrees, so up to
    ///   `card_swarm_cap` may run concurrently in one workspace. Running +
    ///   Suspended both count (a suspended swarm still owns its worktree).
    /// - Non-card swarms (Adhoc, Brainstorm) run in the raw workspace cwd
    ///   and would stomp each other, so at most one may be active/suspended.
    ///   Card swarms do NOT block a non-card swarm — different directories.
    fn validate_slot(&self, workspace_id: &str, kind: SwarmKind) -> Result<(), String> {
        match kind {
            SwarmKind::Card => {
                let cap = self.card_swarm_cap();
                let in_use = self.active_card_count(workspace_id)
                    + self.suspended_card_count(workspace_id);
                if in_use >= cap {
                    return Err(format!(
                        "This workspace already has {in_use} card swarm(s) \
                         running or suspended (limit {cap}). The card will \
                         start automatically when a slot frees — or raise the \
                         limit in Settings."
                    ));
                }
            }
            SwarmKind::Adhoc | SwarmKind::Brainstorm => {
                if self.active_non_card_in_workspace(workspace_id) {
                    return Err(
                        "A brainstorm or ad-hoc swarm is already running in \
                         this workspace. Wait for it to finish or abort it."
                            .into(),
                    );
                }
                if self.suspended_non_card_in_workspace(workspace_id) {
                    return Err(
                        "This workspace has a suspended swarm (brainstorm / \
                         ad-hoc). Resume or abort it before starting a new one."
                            .into(),
                    );
                }
            }
        }
        Ok(())
    }

    /// Pre-flight + record creation + initial mailbox `created` entry. Does
    /// NOT fire any agent — the orchestrator (`fn swarm_start` free function
    /// below) wraps this and adds the scout dispatch. Tests call this directly.
    ///
    /// `role_bindings` maps role name → AgentConfig id. v1.0 expects at least
    /// `"scout"`, `"builder"`, `"reviewer"` to be present; tests may pass a
    /// subset. Empty map is allowed for tests that exercise persistence only.
    ///
    /// Errors (user-facing):
    /// - "A swarm is already running in this workspace..." (R2)
    /// - "A suspended swarm exists in this workspace..." (R7, v1.1.0)
    /// - "Workspace cwd '<path>' is not accessible." (R11)
    pub fn swarm_start(
        &self,
        workspace_id: &str,
        template_id: &str,
        goal: &str,
        cwd: &Path,
        role_bindings: HashMap<String, String>,
        first_role: &str,
        kind: SwarmKind,
    ) -> Result<Swarm, String> {
        // v1.30.0 (parallel swarms): kind-aware admission. Card swarms run
        // in isolated per-card worktrees and parallelize up to the configured
        // cap; non-card swarms stay one-at-a-time. See `validate_slot`.
        self.validate_slot(workspace_id, kind)?;
        if !cwd.is_dir() {
            return Err(format!(
                "Workspace cwd '{}' is not accessible.",
                cwd.display()
            ));
        }

        let id = Uuid::new_v4().to_string();
        let now = now_millis();
        // v1.2.0: initial FSM position is step 0 of the resolved template.
        // The orchestrator-level `swarm_start` (in this same module, free
        // function) resolves the template + redirects the legacy
        // "scout-build-review" id and passes the first role as `first_role`.
        let swarm = Swarm {
            schema_version: SCHEMA_V1,
            id: id.clone(),
            workspace_id: workspace_id.to_string(),
            template_id: template_id.to_string(),
            goal: goal.to_string(),
            status: SwarmStatus::Running,
            state: SwarmState::PendingStep {
                idx: 0,
                role: first_role.to_string(),
                prior_run_ids: Vec::new(),
            },
            kind,
            iteration: 0,
            role_bindings,
            run_ids: Vec::new(),
            started_at: now,
            ended_at: None,
            end_reason: None,
            suspended_at: None,
            suspended_seconds: 0,
            in_flight_role_at_suspend: None,
            in_flight_at_suspend: Vec::new(),
            cwd: cwd.to_string_lossy().to_string(),
            throttled: false,
        };
        self.persist(&swarm)?;
        self.append_mailbox(&MailboxEntry {
            id: Uuid::new_v4().to_string(),
            ts: now,
            swarm_id: id.clone(),
            kind: MailboxKind::Created,
            role: None,
            run_id: None,
            body: Some(serde_json::json!({ "goal": goal, "templateId": template_id })),
            run_summary: None,
        })?;
        self.cache.lock().insert(id.clone(), swarm.clone());
        Ok(swarm)
    }

    /// v1.3.0 (P6): coordinator-mode entry. Creates a swarm in
    /// `PendingCoordinator { tick: 1 }` state and fires the same
    /// `created` mailbox entry. Mirrors `swarm_start`'s validation
    /// (active / suspended / cwd guards). The orchestrator-level
    /// `swarm_start` chooses this path when `template.coordinator: true`.
    pub fn swarm_start_coordinator(
        &self,
        workspace_id: &str,
        template_id: &str,
        goal: &str,
        cwd: &Path,
        role_bindings: HashMap<String, String>,
        kind: SwarmKind,
    ) -> Result<Swarm, String> {
        // v1.30.0 (parallel swarms): kind-aware admission (see `validate_slot`).
        self.validate_slot(workspace_id, kind)?;
        if !cwd.is_dir() {
            return Err(format!(
                "Workspace cwd '{}' is not accessible.",
                cwd.display()
            ));
        }

        let id = Uuid::new_v4().to_string();
        let now = now_millis();
        let swarm = Swarm {
            schema_version: SCHEMA_V1,
            id: id.clone(),
            workspace_id: workspace_id.to_string(),
            template_id: template_id.to_string(),
            goal: goal.to_string(),
            status: SwarmStatus::Running,
            state: SwarmState::PendingCoordinator { tick: 1 },
            kind,
            iteration: 0,
            role_bindings,
            run_ids: Vec::new(),
            started_at: now,
            ended_at: None,
            end_reason: None,
            suspended_at: None,
            suspended_seconds: 0,
            in_flight_role_at_suspend: None,
            in_flight_at_suspend: Vec::new(),
            cwd: cwd.to_string_lossy().to_string(),
            throttled: false,
        };
        self.persist(&swarm)?;
        self.append_mailbox(&MailboxEntry {
            id: Uuid::new_v4().to_string(),
            ts: now,
            swarm_id: id.clone(),
            kind: MailboxKind::Created,
            role: None,
            run_id: None,
            body: Some(serde_json::json!({
                "goal": goal,
                "templateId": template_id,
                "coordinator": true,
            })),
            run_summary: None,
        })?;
        self.cache.lock().insert(id.clone(), swarm.clone());
        Ok(swarm)
    }

    /// v1.5.0 (S1): user-clicked per-instance abort. Finds the instance
    /// in the swarm's Dispatching state, returns its run_id (if any) for
    /// the caller to kill the PTY, then marks the instance Failed +
    /// emits the InstanceDone(failed) mailbox entry. The caller is
    /// expected to `agent_registry.kill_run(run_id)` BEFORE calling this
    /// (mirrors `swarm_abort`'s "kill PTY first, then flip status"
    /// posture). Idempotent: a non-Running/non-Pending instance is a no-op.
    ///
    /// Returns the killed instance's `run_id` so the IPC layer can
    /// orchestrate the PTY kill. None if the instance had no run_id
    /// (Pending leg never fired) or was already terminal.
    pub fn abort_instance(
        &self,
        swarm_id: &str,
        instance_id: &str,
    ) -> Result<Option<String>, String> {
        // Read-only lookup first.
        let run_id = {
            let cache = self.cache.lock();
            let swarm = cache
                .get(swarm_id)
                .ok_or_else(|| format!("unknown swarm '{swarm_id}'"))?;
            if swarm.status != SwarmStatus::Running {
                return Err(format!(
                    "swarm '{swarm_id}' not running (status: {:?}); cannot abort instance",
                    swarm.status
                ));
            }
            match &swarm.state {
                SwarmState::Dispatching { instances, .. } => {
                    let inst = instances
                        .iter()
                        .find(|i| i.id == instance_id)
                        .ok_or_else(|| {
                            format!(
                                "swarm '{swarm_id}' has no instance '{instance_id}'"
                            )
                        })?;
                    // Already-terminal legs are no-op.
                    if matches!(
                        inst.status,
                        InstanceStatus::Done | InstanceStatus::Failed
                    ) {
                        return Ok(None);
                    }
                    inst.run_id.clone()
                }
                _ => {
                    return Err(format!(
                        "swarm '{swarm_id}' not in Dispatching state; cannot abort instance"
                    ));
                }
            }
        };
        mark_instance_failed(self, swarm_id, instance_id, "user aborted")?;
        Ok(run_id)
    }

    /// v1.3.0 (P6): when the FSM is in `Dispatching` state and the
    /// orchestrator just spawned a run for one of its instances, update
    /// the matching `RoleInstance.run_id` + `status: Running`. Idempotent
    /// for a given (swarm, instance) tuple — re-applying with the same
    /// run_id is a no-op.
    pub fn record_instance_started(
        &self,
        swarm_id: &str,
        instance_id: &str,
        run_id: &str,
    ) -> Result<(), String> {
        let mut cache = self.cache.lock();
        let swarm = cache
            .get_mut(swarm_id)
            .ok_or_else(|| format!("unknown swarm '{swarm_id}'"))?;
        let instances = match &mut swarm.state {
            SwarmState::Dispatching { instances, .. } => instances,
            _ => {
                return Err(format!(
                    "swarm '{swarm_id}' not in Dispatching state; cannot record instance start"
                ));
            }
        };
        let mut found = false;
        for inst in instances.iter_mut() {
            if inst.id == instance_id {
                inst.run_id = Some(run_id.to_string());
                inst.status = InstanceStatus::Running;
                found = true;
                break;
            }
        }
        if !found {
            return Err(format!(
                "swarm '{swarm_id}' Dispatching state has no instance '{instance_id}'"
            ));
        }
        // Also append to run_ids so the swarm's full run list stays accurate.
        if !swarm.run_ids.iter().any(|r| r == run_id) {
            swarm.run_ids.push(run_id.to_string());
        }
        let snapshot = swarm.clone();
        drop(cache);
        self.persist(&snapshot)?;
        Ok(())
    }

    /// Append the just-finished run's id to the swarm's `run_ids` list and
    /// persist. Used by the orchestrator immediately after `start_run` returns
    /// so the swarm's history reflects every spawn even if the FSM hasn't yet
    /// processed the eventual completion.
    pub fn record_run_started(&self, swarm_id: &str, run_id: &str) -> Result<(), String> {
        let mut cache = self.cache.lock();
        let swarm = cache
            .get_mut(swarm_id)
            .ok_or_else(|| format!("unknown swarm '{swarm_id}'"))?;
        swarm.run_ids.push(run_id.to_string());
        let snapshot = swarm.clone();
        drop(cache);
        self.persist(&snapshot)?;
        Ok(())
    }

    /// R4 (resumable swarms): flip a `Suspended` swarm back to `Running` so the
    /// caller can fire the in-flight role. Atomically:
    /// - Validates `status == Suspended` (else returns error).
    /// - Accumulates `suspended_seconds += now - suspended_at` (capped at 0).
    /// - Clears `suspended_at` and `in_flight_role_at_suspend`.
    /// - Persists.
    /// - Appends a `Resume` mailbox entry carrying `from_role` +
    ///   `suspended_seconds` (the post-accumulation total).
    /// Returns the updated Swarm.
    ///
    /// The actual `start_run` for the in-flight role is the caller's job
    /// (top-level `swarm_resume` orchestrates it). Splitting the flip from
    /// the spawn lets `swarm_resume` call this only after `start_run`
    /// validation has succeeded — if `start_run` would fail, we never
    /// flip status and the swarm stays cleanly Suspended.
    pub fn resume_to_running(&self, swarm_id: &str) -> Result<Swarm, String> {
        let now = now_millis();
        let from_role = {
            let mut cache = self.cache.lock();
            let swarm = cache
                .get_mut(swarm_id)
                .ok_or_else(|| format!("unknown swarm '{swarm_id}'"))?;
            if swarm.status != SwarmStatus::Suspended {
                return Err(format!(
                    "swarm '{swarm_id}' is not suspended (status: {:?})",
                    swarm.status
                ));
            }
            // Accumulate suspended duration. Saturating sub guards against a
            // clock that went backwards between suspend and resume.
            let gap_ms = swarm
                .suspended_at
                .map(|ts| (now - ts).max(0) as u64)
                .unwrap_or(0);
            swarm.suspended_seconds = swarm
                .suspended_seconds
                .saturating_add(gap_ms / 1000);
            swarm.status = SwarmStatus::Running;
            swarm.suspended_at = None;
            let from_role = swarm.in_flight_role_at_suspend.take();
            let snapshot = swarm.clone();
            drop(cache);
            self.persist(&snapshot)?;
            from_role
        };
        // Mailbox append outside the lock (mirrors abort/suspend pattern).
        let body = serde_json::json!({
            "from_role": from_role,
            "suspended_seconds": self.get(swarm_id).map(|s| s.suspended_seconds).unwrap_or(0),
        });
        self.append_mailbox(&MailboxEntry {
            id: Uuid::new_v4().to_string(),
            ts: now,
            swarm_id: swarm_id.to_string(),
            kind: MailboxKind::Resume,
            role: from_role.clone(),
            run_id: None,
            body: Some(body),
            run_summary: None,
        })?;
        self.get(swarm_id)
            .ok_or_else(|| format!("swarm '{swarm_id}' missing after resume"))
    }

    /// Apply the FSM's verdict for a finished run. Atomically:
    /// 1. Appends `report` (and optional `artifact`) mailbox entries.
    /// 2. For `Advance`: updates `state` + `iteration` and persists.
    /// 3. For `Terminate`: updates `status` + `state` + `ended_at` + `end_reason`,
    ///    persists, and appends the `terminate` mailbox entry.
    ///
    /// **Idempotent on terminal swarm states (R3).** If `swarm.status != Running`
    /// when this is entered (a race between user-abort and run-done, or between
    /// the wall-time timeout tick and a run-done), the method is a no-op and
    /// returns the existing swarm record unchanged.
    pub fn apply_run_done(
        &self,
        swarm_id: &str,
        transition: FsmTransition,
        run_summary: RunSummary,
        artifact: Option<serde_json::Value>,
    ) -> Result<Swarm, String> {
        let mut cache = self.cache.lock();
        let swarm = cache
            .get_mut(swarm_id)
            .ok_or_else(|| format!("unknown swarm '{swarm_id}'"))?;
        // R3: idempotency on terminal states.
        if swarm.status != SwarmStatus::Running {
            return Ok(swarm.clone());
        }

        let now = now_millis();

        // v1.31.0 (Cycle 1): propagate a run's rate-limit signal onto the
        // swarm — sticky, so any throttled leg flags the whole swarm.
        if run_summary.throttled {
            swarm.throttled = true;
        }

        // 1. Apply the transition to the in-memory record before any mailbox
        //    writes — keeps the cache and disk consistent under the lock.
        let terminate_payload = match &transition {
            FsmTransition::Advance {
                next_state,
                new_iteration,
                ..
            } => {
                swarm.state = next_state.clone();
                swarm.iteration = *new_iteration;
                None
            }
            FsmTransition::Terminate {
                status,
                state,
                reason,
            } => {
                swarm.status = *status;
                swarm.state = state.clone();
                swarm.ended_at = Some(now);
                swarm.end_reason = Some(reason.clone());
                Some(reason.clone())
            }
        };
        let snapshot = swarm.clone();
        drop(cache);

        // 2. Persist the updated state.json.
        self.persist(&snapshot)?;

        // 3. Mailbox: report → optional artifact → optional terminate.
        let role = run_summary.role.clone();
        let run_id = run_summary.run_id.clone();
        self.append_mailbox(&MailboxEntry {
            id: Uuid::new_v4().to_string(),
            ts: now,
            swarm_id: swarm_id.to_string(),
            kind: MailboxKind::Report,
            role: Some(role.clone()),
            run_id: Some(run_id.clone()),
            body: None,
            run_summary: Some(run_summary),
        })?;
        if let Some(a) = artifact {
            self.append_mailbox(&MailboxEntry {
                id: Uuid::new_v4().to_string(),
                ts: now,
                swarm_id: swarm_id.to_string(),
                kind: MailboxKind::Artifact,
                role: Some(role),
                run_id: Some(run_id),
                body: Some(a),
                run_summary: None,
            })?;
        }
        if let Some(reason) = terminate_payload {
            self.append_mailbox(&MailboxEntry {
                id: Uuid::new_v4().to_string(),
                ts: now,
                swarm_id: swarm_id.to_string(),
                kind: MailboxKind::Terminate,
                role: None,
                run_id: None,
                body: Some(serde_json::json!({ "reason": reason })),
                run_summary: None,
            })?;
            self.fire_completion_notification(&snapshot);
        }
        Ok(snapshot)
    }

    /// User-clicked abort. Flips status to `Aborted` and writes the terminate
    /// mailbox entry. Does NOT touch the in-flight agent run — that's a
    /// concern of the FSM/listener layer (S4).
    ///
    /// v1.5.4: handles `Running` AND `Suspended`. v1.1 added Suspended as a
    /// non-terminal status but didn't update this method, leaving the
    /// SuspendedBanner's "Abort permanently" button silently dead. Now
    /// both states transition to `Aborted` cleanly. Already-terminal
    /// statuses (`Done`/`Failed`/`Aborted`/`TimedOut`/`MaxIter`) remain
    /// idempotent no-ops.
    pub fn abort(&self, swarm_id: &str, reason: &str) -> Result<(), String> {
        self.abort_with_notification(swarm_id, reason, true)
    }

    /// Rollback-only abort for a Swarm that never became visible through its
    /// owning card. It persists the same terminal record and mailbox evidence
    /// as an ordinary abort but deliberately emits no native completion
    /// notification.
    pub(crate) fn abort_without_notification(
        &self,
        swarm_id: &str,
        reason: &str,
    ) -> Result<(), String> {
        self.abort_with_notification(swarm_id, reason, false)
    }

    fn abort_with_notification(
        &self,
        swarm_id: &str,
        reason: &str,
        notify: bool,
    ) -> Result<(), String> {
        let mut cache = self.cache.lock();
        let swarm = cache
            .get_mut(swarm_id)
            .ok_or_else(|| format!("unknown swarm '{swarm_id}'"))?;
        if !matches!(
            swarm.status,
            SwarmStatus::Running | SwarmStatus::Suspended
        ) {
            // Already terminal — abort is a no-op (idempotent on terminal states).
            return Ok(());
        }
        swarm.status = SwarmStatus::Aborted;
        swarm.state = SwarmState::Aborted;
        swarm.ended_at = Some(now_millis());
        swarm.end_reason = Some(reason.to_string());
        // Clear the v1.1 suspend bookkeeping fields so the resulting
        // record reads cleanly. (suspended_seconds is cumulative across
        // cycles; we keep it as historical metadata.)
        swarm.suspended_at = None;
        swarm.in_flight_role_at_suspend = None;
        swarm.in_flight_at_suspend = Vec::new();
        let snapshot = swarm.clone();
        drop(cache);
        self.persist(&snapshot)?;
        self.append_mailbox(&MailboxEntry {
            id: Uuid::new_v4().to_string(),
            ts: now_millis(),
            swarm_id: swarm_id.to_string(),
            kind: MailboxKind::Terminate,
            role: None,
            run_id: None,
            body: Some(serde_json::json!({ "reason": reason })),
            run_summary: None,
        })?;
        if notify {
            self.fire_completion_notification(&snapshot);
        }
        Ok(())
    }

    /// Called from the exit cleanup (`RunEvent::ExitRequested` or `Exit`) **before**
    /// `AgentRegistry::kill_all`. v1.1.0 (resumable swarms): every running
    /// swarm is flipped to `Suspended` (was: `Aborted`) so the next launch
    /// can offer the user a Resume button. The in-flight role and run id are
    /// captured into mailbox + state.json. The actual PTY shutdown is still
    /// the agent registry's job; its exit listener early-returns when the
    /// swarm is not in `Running`.
    pub fn kill_all(&self) {
        let running_ids: Vec<String> = self
            .cache
            .lock()
            .values()
            .filter(|s| s.status == SwarmStatus::Running)
            .map(|s| s.id.clone())
            .collect();
        for id in running_ids {
            let _ = self.suspend_for_orphan(&id);
        }
    }

    /// Run at startup, after `AgentRegistry::reconcile_orphans` (so orphan
    /// run IDs are already flipped to `killed`).
    ///
    /// v1.1.0 (resumable swarms) changes the behavior:
    /// - Any swarm still `Running` from a previous crash → `Suspended` so
    ///   the user can resume from the Swarm tab. Appends a `Suspend`
    ///   mailbox entry. (Was: `Aborted` with terminate entry.)
    /// - Any swarm already `Suspended` whose `suspended_at` is older than
    ///   `STALE_SUSPENDED_SECONDS` → `Failed` with reason
    ///   `"stale, not resumable"`. Appends a Terminate mailbox entry and
    ///   fires the completion notification (it IS terminal).
    ///
    /// Returns the swarm IDs that were transitioned in this pass (useful
    /// for callers wanting to refresh UI / kanban state). Currently the
    /// only caller in `lib.rs::setup` ignores the return value, but the
    /// shape is preserved for future use.
    pub fn reconcile_orphans(&self) -> Vec<String> {
        let now = now_millis();
        let stale_cutoff_ms = STALE_SUSPENDED_SECONDS * 1000;
        // Snapshot under lock, then mutate without holding the lock so each
        // helper can take the lock fresh (mirrors the existing `abort` flow).
        let (running, stale_suspended): (Vec<String>, Vec<String>) = {
            let cache = self.cache.lock();
            let running = cache
                .values()
                .filter(|s| s.status == SwarmStatus::Running)
                .map(|s| s.id.clone())
                .collect();
            let stale = cache
                .values()
                .filter(|s| {
                    s.status == SwarmStatus::Suspended
                        && s.suspended_at
                            .map(|ts| now - ts >= stale_cutoff_ms)
                            .unwrap_or(false)
                })
                .map(|s| s.id.clone())
                .collect();
            (running, stale)
        };
        let mut touched = Vec::with_capacity(running.len() + stale_suspended.len());
        for id in &running {
            if self.suspend_for_orphan(id).is_ok() {
                touched.push(id.clone());
            }
        }
        for id in &stale_suspended {
            if self.fail_stale_suspended(id).is_ok() {
                touched.push(id.clone());
            }
        }
        touched
    }

    /// Flip a `Running` swarm to `Suspended` (Cmd-Q / crash on the previous
    /// run). Captures the in-flight context so resume can re-fire from
    /// the right place. Append a `Suspend` mailbox entry. Idempotent: a
    /// swarm not in `Running` is a no-op.
    ///
    /// v1.1.0 captured a single in-flight role (sequential templates).
    /// v1.3.0 (P8) extends this for `Dispatching` swarms: every
    /// `RoleInstance` whose status is `Pending` or `Running` is captured
    /// into `Swarm.in_flight_at_suspend`. Resume re-fires every captured
    /// leg whose status was non-terminal at suspend.
    pub fn suspend_for_orphan(&self, swarm_id: &str) -> Result<(), String> {
        let mut cache = self.cache.lock();
        let swarm = cache
            .get_mut(swarm_id)
            .ok_or_else(|| format!("unknown swarm '{swarm_id}'"))?;
        if swarm.status != SwarmStatus::Running {
            return Ok(());
        }
        let role = derive_role_from_state(&swarm.state);
        let in_flight_run_id = swarm.run_ids.last().cloned();
        let now = now_millis();
        swarm.status = SwarmStatus::Suspended;
        swarm.suspended_at = Some(now);
        swarm.in_flight_role_at_suspend = role.clone();
        // v1.3.0 (P8): for parallel swarms in Dispatching state, snapshot
        // every non-terminal leg into in_flight_at_suspend. Sequential
        // states (PendingStep / PendingCoordinator) leave it empty —
        // suspend_for_orphan's existing in_flight_role_at_suspend +
        // run_ids.last() gives resume enough to re-fire.
        if let SwarmState::Dispatching { instances, .. } = &swarm.state {
            swarm.in_flight_at_suspend = instances
                .iter()
                .filter(|i| {
                    matches!(i.status, InstanceStatus::Pending | InstanceStatus::Running)
                })
                .cloned()
                .collect();
        }
        let snapshot = swarm.clone();
        drop(cache);
        self.persist(&snapshot)?;
        self.append_mailbox(&MailboxEntry {
            id: Uuid::new_v4().to_string(),
            ts: now,
            swarm_id: swarm_id.to_string(),
            kind: MailboxKind::Suspend,
            role: role.clone(),
            run_id: in_flight_run_id.clone(),
            body: Some(serde_json::json!({
                "in_flight_role": role,
                "in_flight_run_id": in_flight_run_id,
                "in_flight_at_suspend": &snapshot.in_flight_at_suspend,
            })),
            run_summary: None,
        })?;
        Ok(())
    }

    /// Flip a `Suspended` swarm to `Failed` because it's been suspended past
    /// the staleness cutoff. Writes the terminate mailbox entry and fires
    /// the completion notification (it IS terminal at this point).
    pub fn fail_stale_suspended(&self, swarm_id: &str) -> Result<(), String> {
        let reason = "stale, not resumable";
        let mut cache = self.cache.lock();
        let swarm = cache
            .get_mut(swarm_id)
            .ok_or_else(|| format!("unknown swarm '{swarm_id}'"))?;
        if swarm.status != SwarmStatus::Suspended {
            return Ok(());
        }
        let now = now_millis();
        swarm.status = SwarmStatus::Failed;
        swarm.state = SwarmState::Failed;
        swarm.ended_at = Some(now);
        swarm.end_reason = Some(reason.to_string());
        let snapshot = swarm.clone();
        drop(cache);
        self.persist(&snapshot)?;
        self.append_mailbox(&MailboxEntry {
            id: Uuid::new_v4().to_string(),
            ts: now,
            swarm_id: swarm_id.to_string(),
            kind: MailboxKind::Terminate,
            role: None,
            run_id: None,
            body: Some(serde_json::json!({ "reason": reason })),
            run_summary: None,
        })?;
        self.fire_completion_notification(&snapshot);
        Ok(())
    }

    /// v1.1.1: snapshot Running swarms whose effective wall-clock has exceeded
    /// `MAX_WALL_SECONDS` (suspended time excluded — see `effective_wall_seconds`).
    /// Returns `(swarm_id, in_flight_run_id)` tuples so the caller can kill the
    /// in-flight PTY before flipping the swarm to `TimedOut`. Mirrors the
    /// snapshot-then-mutate pattern used by `reconcile_orphans`.
    pub fn wall_time_exceeded_swarms(&self) -> Vec<(String, Option<String>)> {
        let now = now_millis();
        let cache = self.cache.lock();
        cache
            .values()
            .filter(|s| {
                s.status == SwarmStatus::Running
                    && wall_time_exceeded(s, now, MAX_WALL_SECONDS)
            })
            .map(|s| (s.id.clone(), s.run_ids.last().cloned()))
            .collect()
    }

    /// v1.1.1: flip a `Running` swarm to `TimedOut`. Mirrors `abort` exactly
    /// — does NOT kill the in-flight PTY (caller's job, see `swarm_abort`
    /// command for the canonical pattern). Writes terminate mailbox entry
    /// and fires the completion notification. Idempotent on terminal states.
    pub fn time_out_for_wall_time(&self, swarm_id: &str) -> Result<(), String> {
        let mut cache = self.cache.lock();
        let swarm = cache
            .get_mut(swarm_id)
            .ok_or_else(|| format!("unknown swarm '{swarm_id}'"))?;
        if swarm.status != SwarmStatus::Running {
            return Ok(());
        }
        let now = now_millis();
        let elapsed = effective_wall_seconds(swarm, now);
        let reason = format!("exceeded wall_time after {elapsed}s");
        swarm.status = SwarmStatus::TimedOut;
        swarm.state = SwarmState::TimedOut;
        swarm.ended_at = Some(now);
        swarm.end_reason = Some(reason.clone());
        let snapshot = swarm.clone();
        drop(cache);
        self.persist(&snapshot)?;
        self.append_mailbox(&MailboxEntry {
            id: Uuid::new_v4().to_string(),
            ts: now,
            swarm_id: swarm_id.to_string(),
            kind: MailboxKind::Terminate,
            role: None,
            run_id: None,
            body: Some(serde_json::json!({ "reason": reason })),
            run_summary: None,
        })?;
        self.fire_completion_notification(&snapshot);
        Ok(())
    }

    /// Read mailbox entries from `from_offset` line index. Lines that fail to
    /// parse (e.g. truncated last line from a process kill mid-write) are
    /// silently skipped — defensive posture mirroring `agents.rs`'s stream
    /// parser.
    pub fn read_mailbox(&self, swarm_id: &str, from_offset: usize) -> Result<Vec<MailboxEntry>, String> {
        let path = self.mailbox_path(swarm_id);
        if !path.exists() {
            return Ok(Vec::new());
        }
        let bytes = fs::read(&path).map_err(|e| format!("read mailbox: {e}"))?;
        let mut out = Vec::new();
        for (idx, line) in bytes.split(|b| *b == b'\n').enumerate() {
            if line.is_empty() {
                continue;
            }
            if idx < from_offset {
                continue;
            }
            match serde_json::from_slice::<MailboxEntry>(line) {
                Ok(entry) => out.push(entry),
                Err(_) => {
                    log::debug!(
                        "swarm mailbox: skipping unparseable line {idx} in {}",
                        path.display()
                    );
                }
            }
        }
        Ok(out)
    }

    /// Append a single mailbox entry. `sync_all` per write so a process kill
    /// can't leave the prefix unflushed in the OS page cache. Emits
    /// `swarm://mailbox` after the durable write so the live UI tail can
    /// react immediately without polling.
    pub fn append_mailbox(&self, entry: &MailboxEntry) -> Result<(), String> {
        let path = self.mailbox_path(&entry.swarm_id);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create mailbox parent: {e}"))?;
        }
        let mut line = serde_json::to_vec(entry).map_err(|e| format!("encode mailbox: {e}"))?;
        line.push(b'\n');
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("open mailbox: {e}"))?;
        f.write_all(&line).map_err(|e| format!("write mailbox: {e}"))?;
        f.sync_all().map_err(|e| format!("sync mailbox: {e}"))?;
        if let Some(app) = self.app.get() {
            let _ = app.emit("swarm://mailbox", entry);
        }
        Ok(())
    }

    fn persist(&self, swarm: &Swarm) -> Result<(), String> {
        let path = self.state_path(&swarm.id);
        write_atomic_json(&path, swarm)
    }

    fn state_path(&self, swarm_id: &str) -> PathBuf {
        self.swarms_dir.join(swarm_id).join(STATE_FILE)
    }

    /// v1.0 R6: fire one native notification per swarm terminal transition.
    /// Gated on `behavior.notify_on_agent_done && behavior.notify_on_swarm_done`.
    /// Suppressed on Cmd-Q ("orphaned by app exit") since the app is closing.
    fn fire_completion_notification(&self, swarm: &Swarm) {
        let Some(app) = self.app.get() else {
            return;
        };
        if swarm
            .end_reason
            .as_deref()
            .map(|r| r == "orphaned by app exit")
            .unwrap_or(false)
        {
            return;
        }
        use tauri::Manager;
        let Some(settings_store) = app.try_state::<crate::settings::SettingsStore>() else {
            return;
        };
        let s = settings_store.snapshot();
        if !s.behavior.notify_on_agent_done || !s.behavior.notify_on_swarm_done {
            return;
        }
        let title = format!(
            "Swarm {} — {}",
            match swarm.status {
                SwarmStatus::Done => "done",
                SwarmStatus::Failed => "failed",
                SwarmStatus::Aborted => "aborted",
                SwarmStatus::TimedOut => "timed out",
                SwarmStatus::MaxIter => "reached max iterations",
                SwarmStatus::Running => return,
                // Suspended is non-terminal; no completion notification.
                // Resume-completion notifications are appended in R9.
                SwarmStatus::Suspended => return,
            },
            swarm.template_id
        );
        // R9 (resumable swarms): if this swarm was ever suspended (non-zero
        // accumulated suspended_seconds), the user paused this work mid-flight
        // and resumed it later. Append "(resumed)" to the notification body
        // so the completion ping is unambiguous — the user knows this is the
        // outcome of a previously-suspended swarm, not a fresh one.
        let resumed_suffix = if swarm.suspended_seconds > 0 {
            " (resumed)"
        } else {
            ""
        };
        let body = format!(
            "{} · {} runs · iter {}{resumed_suffix}",
            swarm.end_reason.as_deref().unwrap_or("ended"),
            swarm.run_ids.len(),
            swarm.iteration,
        );
        use tauri_plugin_notification::NotificationExt;
        let _ = app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show();
    }

    /// Fire a native notification at a mid-swarm role handoff (e.g. scout
    /// done — builder running). Mirrors `fire_completion_notification`'s
    /// shape: orphaned-on-exit suppression, app-handle guard, AND-gated on
    /// `notify_on_agent_done && notify_swarm_role_boundary`. Called from the
    /// `Advance` branch of `on_swarm_run_done`, so this only fires for FSM
    /// transitions — never for terminal states (those go through
    /// `fire_completion_notification`).
    fn fire_role_boundary_notification(
        &self,
        swarm: &Swarm,
        prior_role: &str,
        next_role: &str,
    ) {
        let Some(app) = self.app.get() else {
            return;
        };
        if swarm
            .end_reason
            .as_deref()
            .map(|r| r == "orphaned by app exit")
            .unwrap_or(false)
        {
            return;
        }
        use tauri::Manager;
        let Some(settings_store) = app.try_state::<crate::settings::SettingsStore>() else {
            return;
        };
        let s = settings_store.snapshot();
        if !s.behavior.notify_on_agent_done || !s.behavior.notify_swarm_role_boundary {
            return;
        }
        let title = format!("Swarm {} — {} done", swarm.template_id, prior_role);
        let body = format!("{} running · iter {}", next_role, swarm.iteration);
        use tauri_plugin_notification::NotificationExt;
        let _ = app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show();
    }

    fn mailbox_path(&self, swarm_id: &str) -> PathBuf {
        self.swarms_dir.join(swarm_id).join(MAILBOX_FILE)
    }

    /// v1.28.0 (Cycle I-2): walk `<config_dir>/swarms/` and delete any swarm
    /// dir whose ID is neither in `live_swarm_ids` nor belongs to an Adhoc
    /// swarm. Mirrors `SnapshotsStore::gc_orphans` semantics — best-effort,
    /// per-entry errors log a warning but don't abort the sweep. Returns
    /// `(kept, deleted)` for telemetry.
    ///
    /// **Cost-conscious classification:** uses a partial struct
    /// (`SwarmKindOnly`) so the launch-time sweep doesn't deserialize the
    /// entire swarm record (which can be tens of KB) per dir.
    ///
    /// **Conservative on unreadable/corrupt state.json:** if the file is
    /// missing, unreadable, or fails to parse the `kind` field, the dir is
    /// kept. Don't delete what you can't classify — silent data loss on a
    /// schema bump would be much worse than a stale orphan.
    ///
    /// **Adhoc swarms always survive:** they have no card linkage so the
    /// caller can't include them in `live_swarm_ids` even when they should
    /// be kept. The classifier carveout makes them GC-safe by construction.
    ///
    /// Caller responsibility: assemble `live_swarm_ids` from all workspaces'
    /// kanban cards' `linkedBrainstormId` + `linkedSwarmId`. Archived /
    /// Legacy cards count toward the live set (archive ≠ delete).
    pub fn gc_orphan_swarm_dirs(
        &self,
        live_swarm_ids: &std::collections::HashSet<String>,
    ) -> (usize, usize) {
        let mut kept = 0usize;
        let mut deleted = 0usize;
        let entries = match fs::read_dir(&self.swarms_dir) {
            Ok(e) => e,
            Err(e) => {
                log::warn!(
                    "swarms: gc_orphan_swarm_dirs read_dir {} failed: {e}",
                    self.swarms_dir.display()
                );
                return (0, 0);
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                // Stray files at the root — leave them alone.
                continue;
            }
            let Some(id) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if live_swarm_ids.contains(id) {
                kept += 1;
                continue;
            }
            let state_path = path.join(STATE_FILE);
            let kind = match read_swarm_kind_only(&state_path) {
                Ok(k) => k,
                Err(reason) => {
                    log::warn!(
                        "swarms: keeping swarm dir {} — could not classify ({reason})",
                        path.display()
                    );
                    kept += 1;
                    continue;
                }
            };
            if matches!(kind, SwarmKind::Adhoc) {
                kept += 1;
                continue;
            }
            // Lock the in-memory cache while we remove disk + cache entry so a
            // concurrent `swarm_get` can't rehydrate from a half-deleted dir.
            {
                let mut cache = self.cache.lock();
                cache.remove(id);
            }
            match fs::remove_dir_all(&path) {
                Ok(()) => {
                    log::info!("swarms: pruned orphan {}", path.display());
                    deleted += 1;
                }
                Err(e) => {
                    log::warn!(
                        "swarms: failed to remove orphan {} ({e}) — kept",
                        path.display()
                    );
                    kept += 1;
                }
            }
        }
        (kept, deleted)
    }

    /// Server-side GC for a single card's linked swarms. Called by the
    /// `kanban_swarm_gc_card` IPC immediately after a card is deleted.
    /// Returns the list of swarm IDs actually deleted (for FE telemetry /
    /// audit) and the list refused-because-running. Caller passes the union
    /// of `card.linkedBrainstormId` + `card.linkedSwarmId` — both are swarm
    /// IDs, distinct kanban-side roles share one cascade-target type.
    ///
    /// Per id, refuses to delete when:
    /// - swarm record is missing or corrupt (conservative — same as launch-time)
    /// - `swarm.kind == Adhoc` (no card linkage; Adhoc must never be reaped)
    /// - swarm is still running (`endedAt: None` or non-terminal status —
    ///   mirrors v1.27.2's loud-failure principle; FE must abort first)
    /// - another card in `still_referenced` references the same id
    ///
    /// Best-effort per id — one refused swarm doesn't block the others.
    pub fn gc_swarms_for_deleted_card(
        &self,
        swarm_ids: &[String],
        still_referenced: &std::collections::HashSet<String>,
    ) -> GcCardResult {
        let mut deleted: Vec<String> = Vec::new();
        let mut refused_running: Vec<String> = Vec::new();
        let mut refused_other: Vec<String> = Vec::new();
        for id in swarm_ids {
            if still_referenced.contains(id) {
                refused_other.push(id.clone());
                continue;
            }
            let path = self.swarms_dir.join(id);
            if !path.exists() {
                // Already gone — treat as success (best-effort, idempotent).
                continue;
            }
            let state_path = path.join(STATE_FILE);
            let bytes = match fs::read(&state_path) {
                Ok(b) => b,
                Err(e) => {
                    log::warn!(
                        "swarms: gc_swarms_for_deleted_card refusing {id} — state read failed ({e})"
                    );
                    refused_other.push(id.clone());
                    continue;
                }
            };
            let swarm: Swarm = match serde_json::from_slice(&bytes) {
                Ok(s) => s,
                Err(e) => {
                    log::warn!(
                        "swarms: gc_swarms_for_deleted_card refusing {id} — state parse failed ({e})"
                    );
                    refused_other.push(id.clone());
                    continue;
                }
            };
            if matches!(swarm.kind, SwarmKind::Adhoc) {
                log::warn!("swarms: refusing to GC adhoc swarm {id}");
                refused_other.push(id.clone());
                continue;
            }
            let running = swarm.ended_at.is_none()
                || matches!(
                    swarm.status,
                    SwarmStatus::Running | SwarmStatus::Suspended
                );
            if running {
                log::warn!("swarms: refusing to GC running swarm {id} (status={:?})", swarm.status);
                refused_running.push(id.clone());
                continue;
            }
            {
                let mut cache = self.cache.lock();
                cache.remove(id);
            }
            match fs::remove_dir_all(&path) {
                Ok(()) => {
                    log::info!("swarms: GC'd swarm dir {}", path.display());
                    deleted.push(id.clone());
                }
                Err(e) => {
                    log::warn!("swarms: failed to remove {} ({e})", path.display());
                    refused_other.push(id.clone());
                }
            }
        }
        GcCardResult {
            deleted,
            refused_running,
            refused_other,
        }
    }
}

/// v1.28.0 (Cycle I-2): result of the per-card swarm cascade GC. Three
/// disjoint buckets — `deleted` is the success list; `refused_running` is
/// the actionable-by-user case (abort first then retry); `refused_other`
/// covers Adhoc / missing / corrupt / still-referenced cases that the FE
/// should silently swallow.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GcCardResult {
    pub deleted: Vec<String>,
    pub refused_running: Vec<String>,
    pub refused_other: Vec<String>,
}

/// Cost-conscious classifier for the launch-time sweep. Reads only the
/// `kind` field via a partial struct so the sweep is linear in dir-count ×
/// kilobytes-read, not full record size.
#[derive(Deserialize)]
struct SwarmKindOnly {
    #[serde(default = "default_swarm_kind")]
    kind: SwarmKind,
}

fn read_swarm_kind_only(state_path: &Path) -> Result<SwarmKind, String> {
    let bytes = fs::read(state_path).map_err(|e| format!("read: {e}"))?;
    let parsed: SwarmKindOnly =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse: {e}"))?;
    Ok(parsed.kind)
}

// ── helpers ────────────────────────────────────────────

fn load_all_from_disk(swarms_dir: &Path) -> Result<HashMap<String, Swarm>, String> {
    let mut map = HashMap::new();
    let entries = match fs::read_dir(swarms_dir) {
        Ok(e) => e,
        Err(_) => return Ok(map),
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let state_path = entry.path().join(STATE_FILE);
        let bytes = match fs::read(&state_path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let swarm: Swarm = match serde_json::from_slice(&bytes) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("swarm load: skipping {} ({e})", state_path.display());
                continue;
            }
        };
        map.insert(swarm.id.clone(), swarm);
    }
    Ok(map)
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── State machine ──────────────────────────────────────

/// Status string written by the agent registry into the run record. Stored as
/// `&str` here so this module can stay independent of `agents.rs`.
pub const STATUS_DONE: &str = "done";
pub const STATUS_ERROR: &str = "error";
pub const STATUS_KILLED: &str = "killed";

/// What the FSM consumes about a finished run.
#[derive(Debug, Clone)]
pub struct RunOutcome {
    pub run_id: String,
    pub role: String,
    pub status: String,
    pub artifact: Option<serde_json::Value>,
    pub error_msg: Option<String>,
    /// v1.3.0: which fan-out leg this run executed (None for sequential
    /// templates and pre-v1.3 runs). The Dispatching FSM branch matches on
    /// this to update the right `RoleInstance.status` in the swarm's state.
    pub role_instance_id: Option<String>,
}

/// What the FSM emits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FsmTransition {
    /// Stay running. Orchestrator persists `next_state`, bumps `iteration`,
    /// and (if `next_role` is `Some`) calls `start_run` to fire that role.
    Advance {
        next_state: SwarmState,
        next_role: Option<String>,
        new_iteration: u32,
    },
    /// Reach a terminal state. Orchestrator writes the `terminate` mailbox
    /// entry, persists, and fires the swarm-completion notification.
    Terminate {
        status: SwarmStatus,
        state: SwarmState,
        reason: String,
    },
}

/// v1.2.0: pure transition function, generalized to be template-driven.
/// Side-effect free.
///
/// Logic:
/// - Non-DONE outcome → Terminate Failed.
/// - Pull `step = template.steps[idx]`. If the template has fewer steps,
///   that's a programming error (FSM and template agree on `idx`).
/// - If `step.on_reject_jump_to.is_some()` (gate step with loopback):
///   - `verdict == "approve"` → advance (or terminate if last step).
///   - `verdict == "reject"`:
///       - If `iteration + 1 > template.max_iterations` → Terminate MaxIter.
///       - Else → Advance to the loopback step at iteration + 1.
///   - missing/unknown verdict → Terminate Failed.
/// - If `step.on_reject_jump_to.is_none()` (no loopback):
///   - **v1.27.2 (Cycle H-3)**: if `expects_artifact && artifact.is_none()`
///     → Terminate Failed `"<role> produced no artifact"`. Pre-v1.27.2 this
///     fell through to `advance_or_done`, silently passing a missing artifact
///     to the next role — observed in a `claude-codex-debate` run where the
///     architect-rebuttal step (#2, `expects_artifact: true`) wrote its
///     artifact to a typo'd path so `read_swarm_artifact` returned None,
///     and the FSM happily advanced to the final critic which then
///     approved a phantom revised plan.
///   - Otherwise advance (artifact, if any, is informational; verdict, if
///     present, is surfaced in `end_reason`).
///
/// Advance ⇒ append `outcome.run_id` to `prior_run_ids` for the new state.
/// Last step + approve ⇒ terminate Done.
///
/// See `docs/SWARM_DESIGN.md` §10 (v1.2.0) for the full transition table.
pub fn next_fsm_state(
    template: &crate::swarm_templates::SwarmTemplate,
    current_state: &SwarmState,
    iteration: u32,
    outcome: &RunOutcome,
) -> FsmTransition {
    if outcome.status != STATUS_DONE {
        let detail = outcome.error_msg.as_deref().unwrap_or(&outcome.status);
        return FsmTransition::Terminate {
            status: SwarmStatus::Failed,
            state: SwarmState::Failed,
            reason: format!("{} run failed: {}", outcome.role, detail),
        };
    }

    // v1.3.0: coordinator-mode templates use a different FSM shape. Branch
    // here so the rest of this fn stays focused on the sequential path.
    match current_state {
        SwarmState::PendingCoordinator { tick } => {
            return next_from_pending_coordinator(template, *tick, outcome);
        }
        SwarmState::Dispatching { tick, instances } => {
            return next_from_dispatching(template, *tick, instances, outcome);
        }
        _ => {}
    }

    let (idx, prior_run_ids) = match current_state {
        SwarmState::PendingStep {
            idx, prior_run_ids, ..
        } => (*idx as usize, prior_run_ids.clone()),
        // Terminal state shouldn't reach this fn — the orchestrator
        // (`on_swarm_run_done`) early-returns on non-Running. Defensive.
        _ => {
            return FsmTransition::Terminate {
                status: SwarmStatus::Failed,
                state: SwarmState::Failed,
                reason: format!("FSM called on non-pending state {:?}", current_state),
            };
        }
    };

    let step = match template.steps.get(idx) {
        Some(s) => s,
        None => {
            return FsmTransition::Terminate {
                status: SwarmStatus::Failed,
                state: SwarmState::Failed,
                reason: format!(
                    "template '{}' has no step at idx {idx} (have {})",
                    template.id,
                    template.steps.len()
                ),
            };
        }
    };

    // Sanity check: the just-completed run's role must match the step's role.
    // Mirrors the v1.0 (state, role) match arm guard.
    if outcome.role != step.role {
        return FsmTransition::Terminate {
            status: SwarmStatus::Failed,
            state: SwarmState::Failed,
            reason: format!(
                "unexpected role '{}' for step idx {idx} (expected '{}')",
                outcome.role, step.role
            ),
        };
    }

    // Build the prior_run_ids list for any subsequent state by appending
    // this run's id.
    let mut next_priors = prior_run_ids;
    next_priors.push(outcome.run_id.clone());

    // The verdict-checking semantic is gated on `on_reject_jump_to`. A
    // step with a loopback target IS a quality-gate step (reviewer / ux-
    // reviewer); its artifact must contain `verdict: "approve" | "reject"`
    // and is read here. A step without a loopback target — even if it
    // produces an artifact (scout's plan, architect's decision) — just
    // advances; the artifact is consumed by the next role's handoff
    // payload but doesn't gate the FSM. Mirrors the v1.0 behavior where
    // scout/builder always advanced and only reviewer's verdict was
    // examined.
    if let Some(target_idx) = step.on_reject_jump_to {
        let verdict = outcome
            .artifact
            .as_ref()
            .and_then(|v| v.get("verdict"))
            .and_then(|v| v.as_str());
        match verdict {
            Some("approve") => {
                advance_or_done(template, idx, iteration, next_priors, Some("approve"))
            }
            Some("reject") => {
                let next_iteration = iteration + 1;
                if next_iteration > template.max_iterations {
                    FsmTransition::Terminate {
                        status: SwarmStatus::MaxIter,
                        state: SwarmState::MaxIter,
                        reason: format!("reached max_iterations ({})", template.max_iterations),
                    }
                } else {
                    let target_step = match template.steps.get(target_idx) {
                        Some(s) => s,
                        None => {
                            return FsmTransition::Terminate {
                                status: SwarmStatus::Failed,
                                state: SwarmState::Failed,
                                reason: format!(
                                    "template '{}' on_reject_jump_to {target_idx} out of range",
                                    template.id
                                ),
                            };
                        }
                    };
                    FsmTransition::Advance {
                        next_state: SwarmState::PendingStep {
                            idx: target_idx as u32,
                            role: target_step.role.clone(),
                            prior_run_ids: next_priors,
                        },
                        next_role: Some(target_step.role.clone()),
                        new_iteration: next_iteration,
                    }
                }
            }
            _ => FsmTransition::Terminate {
                status: SwarmStatus::Failed,
                state: SwarmState::Failed,
                reason: format!("{} produced no verdict", step.role),
            },
        }
    } else {
        // No loopback configured. v1.27.2 (Cycle H-3): if the step
        // declared `expects_artifact: true` but no artifact came back,
        // fail loudly instead of silently advancing. Before this guard,
        // a missing artifact on a non-loopback step would advance the
        // FSM with `outcome.artifact = None`; the next role's handoff
        // payload silently lost the prior step's verdict and the
        // operator only saw N-1 of N artifacts in the mailbox. See the
        // module docstring for the originating incident.
        if step.expects_artifact && outcome.artifact.is_none() {
            log::warn!(
                "swarm FSM: step {idx} ({}) finished status=done but produced \
                 no artifact (run_id={}); failing the swarm. Look for a \
                 typo'd path under <workspace>/.atelier/swarm/ — Cycle H-3 \
                 added this guard after a claude-codex-debate run where the \
                 architect-rebuttal wrote to a UUID-mangled path.",
                step.role,
                outcome.run_id,
            );
            return FsmTransition::Terminate {
                status: SwarmStatus::Failed,
                state: SwarmState::Failed,
                reason: format!("{} produced no artifact", step.role),
            };
        }
        // Informational artifact (or no artifact required). Always
        // advance. Last step → Done. v1.5.13: pass the verdict (if
        // present) so a single-step audit/design template that produced
        // a "reject" verdict reports it accurately in `end_reason`
        // instead of hardcoding "approved by [role]".
        let verdict = outcome
            .artifact
            .as_ref()
            .and_then(|v| v.get("verdict"))
            .and_then(|v| v.as_str());
        advance_or_done(template, idx, iteration, next_priors, verdict)
    }
}

/// v1.2.0: resolve a `Swarm.template_id` to a concrete `SwarmTemplate`,
/// applying the legacy redirect for `"scout-build-review"` (the v1.0/v1.1
/// hardcoded id) → `"feature"` (the v1.2 builtin equivalent). Falls back
/// to the `"feature"` builtin when the id is unrecognized — keeps stale
/// references from breaking the orchestrator.
///
/// Returns `None` only if the templates store has been corrupted to the
/// point where even `"feature"` can't be found, which would indicate a
/// programming error. T4 deepens this with the full back-compat redirect
/// at all entry points (state.json load, kanban moveCard, swarm_start).
pub fn resolve_template_or_fallback(
    store: &crate::swarm_templates::SwarmTemplatesStore,
    template_id: &str,
) -> Option<crate::swarm_templates::SwarmTemplate> {
    let id = if template_id == "scout-build-review" {
        "feature"
    } else {
        template_id
    };
    if let Ok(Some(t)) = store.get(id) {
        return Some(t);
    }
    // Fallback: try "feature" builtin if the requested id is unknown.
    store.get("feature").ok().flatten()
}

/// v1.3.0: hard cap on dispatches the coordinator can request in one tick.
/// Set conservatively pending the live Max-plan probe (folded into P10
/// Tier 4). If the coordinator emits more, the tick is rejected and the
/// orchestrator re-fires the coordinator with a "you exceeded the cap"
/// preamble. v1.4 candidate: surface this as a behavior setting.
pub const MAX_PARALLEL_INSTANCES_PER_TICK: usize = 5;

/// v1.3.0 (P3): branch of `next_fsm_state` that handles a completed
/// coordinator run. Parses the structured artifact (`{tick, dispatches,
/// done, rationale?}`) and decides:
///
/// - `done: true` → Terminate Done.
/// - `done: false` and dispatches are well-formed → Advance to
///   `Dispatching { tick, instances }`. The orchestrator (P6) detects the
///   new state and fans out N start_run calls.
/// - Malformed artifact (no JSON, missing fields, dispatches > cap, dependency
///   cycle) → Terminate Failed with a specific reason.
///
/// Pure helper; no I/O.
fn next_from_pending_coordinator(
    template: &crate::swarm_templates::SwarmTemplate,
    tick: u32,
    outcome: &RunOutcome,
) -> FsmTransition {
    if outcome.role != "coordinator" {
        return FsmTransition::Terminate {
            status: SwarmStatus::Failed,
            state: SwarmState::Failed,
            reason: format!(
                "expected coordinator role for PendingCoordinator state, got '{}'",
                outcome.role
            ),
        };
    }

    let artifact = match &outcome.artifact {
        Some(a) => a,
        None => {
            return FsmTransition::Terminate {
                status: SwarmStatus::Failed,
                state: SwarmState::Failed,
                reason: "coordinator produced no dispatch artifact".into(),
            };
        }
    };

    // Done flag short-circuits.
    if artifact.get("done").and_then(|v| v.as_bool()).unwrap_or(false) {
        return FsmTransition::Terminate {
            status: SwarmStatus::Done,
            state: SwarmState::Done,
            reason: "coordinator marked done".into(),
        };
    }

    // Iteration cap: each coordinator tick consumes one iteration. If
    // tick+1 > max_iterations the next round can't fire.
    let next_tick = tick.saturating_add(1);
    if next_tick > template.max_iterations {
        return FsmTransition::Terminate {
            status: SwarmStatus::MaxIter,
            state: SwarmState::MaxIter,
            reason: format!(
                "coordinator exceeded max_iterations ({}) ticks",
                template.max_iterations
            ),
        };
    }

    let raw_dispatches = match artifact.get("dispatches").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => {
            return FsmTransition::Terminate {
                status: SwarmStatus::Failed,
                state: SwarmState::Failed,
                reason: "coordinator artifact missing 'dispatches' array".into(),
            };
        }
    };
    if raw_dispatches.is_empty() {
        return FsmTransition::Terminate {
            status: SwarmStatus::Failed,
            state: SwarmState::Failed,
            reason: "coordinator emitted zero dispatches with done:false".into(),
        };
    }
    if raw_dispatches.len() > MAX_PARALLEL_INSTANCES_PER_TICK {
        return FsmTransition::Terminate {
            status: SwarmStatus::Failed,
            state: SwarmState::Failed,
            reason: format!(
                "coordinator dispatched {} instances; cap is {}",
                raw_dispatches.len(),
                MAX_PARALLEL_INSTANCES_PER_TICK
            ),
        };
    }

    // Parse each dispatch into a RoleInstance. Required fields: id, role,
    // task. Optional: owner_globs (default []), depends_on (default []).
    let mut instances: Vec<RoleInstance> = Vec::with_capacity(raw_dispatches.len());
    for d in raw_dispatches {
        let id = match d.get("instance").and_then(|v| v.as_str()) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => {
                return FsmTransition::Terminate {
                    status: SwarmStatus::Failed,
                    state: SwarmState::Failed,
                    reason: "dispatch missing non-empty 'instance' id".into(),
                };
            }
        };
        let role = match d.get("role").and_then(|v| v.as_str()) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => {
                return FsmTransition::Terminate {
                    status: SwarmStatus::Failed,
                    state: SwarmState::Failed,
                    reason: format!("dispatch '{id}' missing non-empty 'role'"),
                };
            }
        };
        // Validate role is in the template's role pool.
        let role_in_pool = template.steps.iter().any(|s| s.role == role);
        if !role_in_pool {
            return FsmTransition::Terminate {
                status: SwarmStatus::Failed,
                state: SwarmState::Failed,
                reason: format!(
                    "dispatch '{id}' targets role '{role}' not in template '{}' role pool",
                    template.id
                ),
            };
        }
        let task = d
            .get("task")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_default();
        let owner_globs: Vec<String> = d
            .get("ownerGlobs")
            .or_else(|| d.get("owner_globs"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let depends_on: Vec<String> = d
            .get("dependsOn")
            .or_else(|| d.get("depends_on"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        instances.push(RoleInstance {
            id,
            role,
            run_id: None,
            owner_globs,
            task,
            depends_on,
            status: InstanceStatus::Pending,
        });
    }

    // Reject duplicate instance ids.
    let mut seen_ids = std::collections::HashSet::<&str>::new();
    for inst in &instances {
        if !seen_ids.insert(inst.id.as_str()) {
            return FsmTransition::Terminate {
                status: SwarmStatus::Failed,
                state: SwarmState::Failed,
                reason: format!("duplicate dispatch instance id '{}'", inst.id),
            };
        }
    }

    // Reject depends_on referring to unknown ids + simple cycle check
    // (topological sort via Kahn's algorithm).
    if let Err(reason) = validate_dependency_graph(&instances) {
        return FsmTransition::Terminate {
            status: SwarmStatus::Failed,
            state: SwarmState::Failed,
            reason,
        };
    }

    FsmTransition::Advance {
        next_state: SwarmState::Dispatching { tick, instances },
        // The orchestrator (P6) sees Dispatching and fans out start_run
        // per instance. No single "next_role" applies.
        next_role: None,
        new_iteration: tick,
    }
}

/// v1.3.0 (P3): topological-sort check that the depends_on DAG is acyclic
/// and references only known instance ids. Pure helper.
fn validate_dependency_graph(instances: &[RoleInstance]) -> Result<(), String> {
    let ids: std::collections::HashSet<&str> =
        instances.iter().map(|i| i.id.as_str()).collect();
    for inst in instances {
        for dep in &inst.depends_on {
            if !ids.contains(dep.as_str()) {
                return Err(format!(
                    "dispatch '{}' depends on unknown instance '{dep}'",
                    inst.id
                ));
            }
            if dep == &inst.id {
                return Err(format!("dispatch '{}' depends on itself", inst.id));
            }
        }
    }
    // Kahn's algorithm to detect cycles.
    let mut indeg: std::collections::HashMap<&str, usize> =
        instances.iter().map(|i| (i.id.as_str(), i.depends_on.len())).collect();
    let mut queue: std::collections::VecDeque<&str> = indeg
        .iter()
        .filter_map(|(k, &v)| if v == 0 { Some(*k) } else { None })
        .collect();
    let mut visited = 0usize;
    while let Some(id) = queue.pop_front() {
        visited += 1;
        for inst in instances {
            if inst.depends_on.iter().any(|d| d.as_str() == id) {
                if let Some(d) = indeg.get_mut(inst.id.as_str()) {
                    *d -= 1;
                    if *d == 0 {
                        queue.push_back(inst.id.as_str());
                    }
                }
            }
        }
    }
    if visited != instances.len() {
        return Err("dispatch dependency graph has a cycle".into());
    }
    Ok(())
}

/// v1.3.0 (P3): branch of `next_fsm_state` for a completed run while in
/// `Dispatching` state. Updates the matching instance's `status` and
/// either:
/// - Stays Dispatching (some instances still pending/running) → Advance
///   with same state but updated instances + `next_role: None`.
/// - All instances terminal → Advance to `PendingCoordinator { tick + 1 }`,
///   `next_role: None`. The post-transition coordinator-mode handler in
///   `on_swarm_run_done` is the canonical fire path for PendingCoordinator
///   state; returning `next_role: Some("coordinator")` here would
///   double-fire (sequential Advance branch + post-transition handler
///   both call `start_run` for the coordinator → inflight collision →
///   swarm aborts). v1.5.5 hotfix.
fn next_from_dispatching(
    _template: &crate::swarm_templates::SwarmTemplate,
    tick: u32,
    instances: &[RoleInstance],
    outcome: &RunOutcome,
) -> FsmTransition {
    let role_instance_id = match &outcome.role_instance_id {
        Some(id) => id.as_str(),
        None => {
            return FsmTransition::Terminate {
                status: SwarmStatus::Failed,
                state: SwarmState::Failed,
                reason: "Dispatching state requires role_instance_id on outcome".into(),
            };
        }
    };

    let mut updated: Vec<RoleInstance> = instances.to_vec();
    let mut found = false;
    for inst in &mut updated {
        if inst.id == role_instance_id {
            // outcome.status is already STATUS_DONE per the early-return
            // at the top of next_fsm_state — but artifact verdict could
            // still be a "fail" signal. For Dispatching we treat all
            // STATUS_DONE outcomes as instance-Done; a leg's verdict is
            // for the coordinator to interpret next tick.
            inst.status = InstanceStatus::Done;
            inst.run_id = Some(outcome.run_id.clone());
            found = true;
            break;
        }
    }
    if !found {
        return FsmTransition::Terminate {
            status: SwarmStatus::Failed,
            state: SwarmState::Failed,
            reason: format!(
                "Dispatching state has no instance '{role_instance_id}' to update"
            ),
        };
    }

    let all_terminal = updated
        .iter()
        .all(|i| matches!(i.status, InstanceStatus::Done | InstanceStatus::Failed));
    if all_terminal {
        // Advance to next coordinator tick. v1.5.5: next_role MUST be
        // None — the post-transition coordinator-mode handler in
        // on_swarm_run_done fires the coordinator. If next_role were
        // Some("coordinator"), the sequential Advance branch would ALSO
        // fire start_run, claiming the inflight slot before the
        // post-transition handler tried to claim it again → "agent
        // already running" → swarm aborts.
        FsmTransition::Advance {
            next_state: SwarmState::PendingCoordinator { tick: tick + 1 },
            next_role: None,
            new_iteration: tick + 1,
        }
    } else {
        // Stay in Dispatching with the updated instance status.
        // No new run to fire — other legs are still in flight or pending
        // their depends_on barrier. The orchestrator (P6) re-checks
        // pending instances to fire any whose barriers just cleared.
        FsmTransition::Advance {
            next_state: SwarmState::Dispatching {
                tick,
                instances: updated,
            },
            next_role: None,
            new_iteration: tick,
        }
    }
}

/// Helper for `next_fsm_state`: advance to step idx+1, or terminate Done if
/// idx was the last step. The terminal reason is borrowed from the role
/// just completed — "approved by reviewer" / "approved by ux-reviewer" / etc.
///
/// v1.5.13: when a single-step audit/design template terminates Done with a
/// non-approve verdict (because `on_reject_jump_to: None` makes the FSM
/// ignore the verdict), surface the actual verdict in the reason text so
/// `Swarm.end_reason` doesn't read "approved by ux-reviewer" when the
/// verdict was actually "reject". Compound bug found by Run #18 calibration.
fn advance_or_done(
    template: &crate::swarm_templates::SwarmTemplate,
    idx: usize,
    iteration: u32,
    prior_run_ids: Vec<String>,
    verdict: Option<&str>,
) -> FsmTransition {
    let next_idx = idx + 1;
    if next_idx >= template.steps.len() {
        // Last step — and approved (or no artifact). Done.
        let prior_role = &template.steps[idx].role;
        let reason = if template.steps[idx].expects_artifact {
            match verdict {
                Some("approve") => format!("approved by {prior_role}"),
                Some("reject") => {
                    format!("completed by {prior_role} (reject verdict, informational)")
                }
                Some(other) => format!("completed by {prior_role} (verdict: {other})"),
                None => format!("completed by {prior_role}"),
            }
        } else {
            format!("completed by {prior_role}")
        };
        return FsmTransition::Terminate {
            status: SwarmStatus::Done,
            state: SwarmState::Done,
            reason,
        };
    }
    let next_step = &template.steps[next_idx];
    FsmTransition::Advance {
        next_state: SwarmState::PendingStep {
            idx: next_idx as u32,
            role: next_step.role.clone(),
            prior_run_ids,
        },
        next_role: Some(next_step.role.clone()),
        new_iteration: iteration,
    }
}

// ── Handoff payload ────────────────────────────────────

/// Per-byte cap on a single transcript section. Tail-truncated if exceeded.
const HANDOFF_TRANSCRIPT_CAP: usize = 32 * 1024;
/// Per-step cap on the file-changes list. Older entries truncated with marker.
const HANDOFF_CHANGES_CAP: usize = 50;

/// One previous run's contribution to the handoff payload. Newest goes last.
pub struct PriorStep<'a> {
    pub role: &'a str,
    pub transcript: &'a str,
    pub changes: &'a [crate::snapshots::FileChange],
    pub artifact: Option<&'a serde_json::Value>,
}

/// Placeholder that `agents.rs::start_run` substitutes with the run's UUID
/// at spawn time. The orchestrator builds the prompt before `start_run`
/// generates the id, so we embed this literal and let `start_run` replace it.
pub const RUN_ID_PLACEHOLDER: &str = "{{ATELIER_SWARM_RUN_ID}}";

/// Pure handoff-payload builder. Concatenates the goal with each prior step's
/// transcript / changes / structured artifact in the format described by
/// `docs/SWARM_DESIGN.md` §8. Side-effect free; unit-testable.
///
/// `artifact_path_template`, when present, appends a working note telling the
/// agent where to write its structured output. The path contains the
/// `RUN_ID_PLACEHOLDER` literal which `start_run` swaps for the real id.
pub fn build_handoff_payload(
    goal: &str,
    history: &[PriorStep<'_>],
    artifact_path_template: Option<&str>,
) -> String {
    let mut out = String::new();
    out.push_str(goal);
    for step in history {
        out.push_str("\n\n# Previous step: ");
        out.push_str(step.role);
        out.push_str("\n\n## Transcript\n");
        out.push_str(&truncate_transcript(step.transcript, HANDOFF_TRANSCRIPT_CAP));
        if !step.changes.is_empty() {
            out.push_str("\n\n## Files changed\n");
            let total = step.changes.len();
            for c in step.changes.iter().take(HANDOFF_CHANGES_CAP) {
                let glyph = match c.kind {
                    crate::snapshots::ChangeKind::Added => 'A',
                    crate::snapshots::ChangeKind::Modified => 'M',
                    crate::snapshots::ChangeKind::Removed => 'D',
                };
                out.push_str(&format!("- {glyph} {}\n", c.path));
            }
            if total > HANDOFF_CHANGES_CAP {
                out.push_str(&format!(
                    "- ... [{} more]\n",
                    total - HANDOFF_CHANGES_CAP
                ));
            }
        }
        if let Some(a) = step.artifact {
            out.push_str("\n\n## Structured output\n");
            if let Ok(pretty) = serde_json::to_string_pretty(a) {
                out.push_str(&pretty);
            }
        }
    }
    if let Some(template) = artifact_path_template {
        out.push_str("\n\n# Artifact path\n");
        out.push_str(
            "When done, write your structured output as JSON to this exact path:\n  ",
        );
        out.push_str(template);
        out.push('\n');
    }
    out
}

/// Tail-truncate a transcript to at most `cap` bytes. The dropped prefix is
/// replaced with a `[truncated N bytes]` marker. UTF-8 safe — slices at the
/// next char boundary at or after the cut point.
fn truncate_transcript(text: &str, cap: usize) -> String {
    if text.len() <= cap {
        return text.to_string();
    }
    let dropped = text.len() - cap;
    let cut = (dropped..text.len())
        .find(|&i| text.is_char_boundary(i))
        .unwrap_or(text.len());
    let mut s = String::with_capacity(cap + 32);
    s.push_str(&format!("[truncated {dropped} bytes]\n"));
    s.push_str(&text[cut..]);
    s
}

// ── Role presets (S6) ──────────────────────────────────

pub const SCOUT_PRESET_ID: &str = "scout";
pub const BUILDER_PRESET_ID: &str = "builder";
pub const REVIEWER_PRESET_ID: &str = "reviewer";
/// v1.2.0: role library expansion. Three new ships-with roles to support
/// the `refactor` and `ux-audit` built-in templates. The existing 3 retain
/// their constants verbatim for back-compat.
pub const ARCHITECT_PRESET_ID: &str = "architect";
pub const UX_REVIEWER_PRESET_ID: &str = "ux-reviewer";
pub const REFACTORER_PRESET_ID: &str = "refactorer";
/// v1.3.0: Coordinator role. Meta-role that reads the mailbox + emits
/// a structured dispatch artifact each tick. Only relevant for
/// coordinator-mode templates (`SwarmTemplate.coordinator: true`).
pub const COORDINATOR_PRESET_ID: &str = "coordinator";
/// v1.22.0: Critic role. Adversarial counterpart to the Architect in the
/// `claude-codex-debate` template. Produces an `approve | reject` verdict
/// artifact (same FSM contract as Reviewer) plus `objections` /
/// `concessions` advisory fields.
pub const CRITIC_PRESET_ID: &str = "critic";

/// All ships-with role IDs. GH #171: test-only now — its one production
/// reader, the Agents page's reseed of every role preset, is retired; a swarm
/// seeds the roles its template names (`ensure_role_preset`).
#[cfg(test)]
pub const ALL_ROLE_IDS: &[&str] = &[
    SCOUT_PRESET_ID,
    ARCHITECT_PRESET_ID,
    BUILDER_PRESET_ID,
    REFACTORER_PRESET_ID,
    REVIEWER_PRESET_ID,
    CRITIC_PRESET_ID,
    UX_REVIEWER_PRESET_ID,
    COORDINATOR_PRESET_ID,
];

const SCOUT_NAME: &str = "Scout (swarm)";
const BUILDER_NAME: &str = "Builder (swarm)";
const REVIEWER_NAME: &str = "Reviewer (swarm)";
const ARCHITECT_NAME: &str = "Architect (swarm)";
const UX_REVIEWER_NAME: &str = "UX Reviewer (swarm)";
const REFACTORER_NAME: &str = "Refactorer (swarm)";
const COORDINATOR_NAME: &str = "Coordinator (swarm)";
const CRITIC_NAME: &str = "Critic (swarm)";

const SCOUT_SYSTEM_PROMPT: &str = "\
You are the Scout role in a Swarm multi-agent flow. \
Read the codebase to understand the user's goal, then propose a concrete plan. \
Do NOT modify files — that is the Builder's job. Your output is two parts:

1. A written explanation of the plan (assistant message).
2. A JSON artifact at the path provided in the user message, with shape:
   { \"plan\": \"<one-sentence summary>\", \"files_to_modify\": [\"path/one\", ...], \"rationale\": \"<why this approach>\" }

Be precise. The Builder will read the artifact verbatim, so make it actionable.";

const BUILDER_SYSTEM_PROMPT: &str = "\
You are the Builder role in a Swarm multi-agent flow. \
Read the Scout's plan and any prior Reviewer feedback in the user message, \
then implement the changes by editing files directly using your tools. \
No structured artifact required — your output IS the diff itself.

Iteration policy: if a Reviewer rejected a previous attempt, the user message \
will include the critique. Address it; do not re-introduce the same problem.";

const REVIEWER_SYSTEM_PROMPT: &str = "\
You are the Reviewer role in a Swarm multi-agent flow. \
Read the goal, the Scout's plan, and the Builder's diff in the user message. \
Decide whether the change is correct, complete, and well-implemented.

Output is two parts:
1. A written critique (assistant message).
2. A JSON artifact at the path provided in the user message, with shape:
   { \"verdict\": \"approve\" | \"reject\", \"critique\": \"<short reason>\", \"blocking_issues\": [\"...\"] }

Be honest. \"approve\" only if the change is shippable. \"reject\" if it needs another iteration.";

const CRITIC_SYSTEM_PROMPT: &str = "\
You are the Critic in a two-LLM debate. The Architect (a Claude model) has just produced a plan. \
Your job is to find what is wrong with it.

Specifically: identify hidden assumptions, missed edge cases, weaker alternatives the Architect \
dismissed without justification, and risks the Architect did not name. If the plan is actually \
sound, say so explicitly and briefly — do not invent objections. If parts are sound and parts \
are not, separate them.

You are NOT writing a polite second opinion. You are the loyal opposition. Disagree where you \
actually disagree.

Output is two parts:
1. A written critique (assistant message).
2. A JSON artifact at the path provided in the user message, with shape:
   { \"verdict\": \"approve\" | \"reject\", \"critique\": \"<short reason>\", \"objections\": [\"...\"], \"concessions\": [\"...\"] }

`approve` only when the plan is genuinely robust. `reject` when the Architect must address \
objections before proceeding. In the post-revise re-critique step, evaluate whether prior \
objections were actually addressed; do not silently drop unresolved ones.";

const ARCHITECT_SYSTEM_PROMPT: &str = "\
You are the Architect role in a Swarm multi-agent flow. \
Read the codebase to understand the user's goal, then propose a high-level design decision. \
Unlike the Scout (tactical plan: which files), you operate at the architectural level: which \
boundary to draw, which abstraction to introduce, which trade-off to accept. Do NOT modify files.

Output is two parts:
1. A written design doc (assistant message): problem statement, options considered, chosen direction, rationale.
2. A JSON artifact at the path provided in the user message, with shape:
   { \"decision\": \"<one-sentence statement>\", \"rationale\": \"<why this over the alternatives>\", \"affected_components\": [\"...\"], \"open_questions\": [\"...\"], \"summary_md\": \"<markdown report — see below>\" }

The `summary_md` field is a markdown report (max ~10KB) intended for a human reader on the \
post-run Outcome screen and as the seed `knowledge` for any follow-up implementation card. \
Structure it as: a short problem-restatement; a ranked recommendation with 3–5 sentences of \
argued rationale; the trade-offs you considered (one paragraph each); any open questions that \
require the user's judgment before implementation can start; any quick-win sub-changes that \
could land immediately regardless of the larger direction. Use headers, bullets, code spans. \
Do not duplicate verbatim — the structured fields above are the machine-readable index; \
`summary_md` is the prose the user reads.

Bias toward the option that minimizes blast radius and preserves reversibility.";

const UX_REVIEWER_SYSTEM_PROMPT: &str = "\
You are the UX Reviewer role in a Swarm multi-agent flow. \
Read the goal and any prior-step context in the user message — that may be a Scout's plan plus \
a Builder's diff (in a build-and-review chain), or just the goal alone (in an audit-only \
template). Evaluate the user-visible behavior strictly through the lens of user experience: \
clarity, discoverability, keyboard reachability, error states, empty states, motion/animation, \
and consistency with the rest of the app's vocabulary.

Do NOT review code quality — that is the Reviewer's job. UX only.

If the goal is an audit of existing UI (no diff to review), navigate the codebase yourself \
with Read / Grep / Glob to find the surface in question, then produce the artifact. The audit \
IS the deliverable; the FSM treats the verdict as informational metadata, not a retry gate.

Output is two parts:
1. A written critique focused on the user-visible behavior (assistant message).
2. A JSON artifact at the path provided in the user message, with shape:
   { \"verdict\": \"approve\" | \"reject\", \"critique\": \"<short reason>\", \"ux_issues\": [\"...\"], \"ux_strengths\": [\"...\"], \"summary_md\": \"<markdown report — see below>\" }

The `summary_md` field is a markdown report (max ~10KB) intended for a human reader on the \
post-run Outcome screen and as the seed `knowledge` for any follow-up implementation card. \
Structure it as: a one-paragraph summary of the surface you audited and the user-visible \
behaviors you tested; a ranked recommendation 1/2/3 with 3–5 sentences of argued rationale per \
option (NOT a list of bullets — actual argument); open questions that genuinely require the \
user's judgment before any implementation can start (max 3); quick wins — 1–3 changes that \
would improve the UX TODAY regardless of which larger direction wins. Use headers, bullets, \
code spans for selectors/identifiers. Do not duplicate verbatim — the structured fields above \
are the machine-readable index; `summary_md` is the prose the user reads.

\"approve\" only when the UX is genuinely good — not merely passable. \"reject\" when the user \
would notice friction. In audit mode, \"reject\" with substantive ux_issues IS the success \
case; do not soften the critique to land an approve.";

const REFACTORER_SYSTEM_PROMPT: &str = "\
You are the Refactorer role in a Swarm multi-agent flow. \
Read the Scout's plan and any prior Reviewer feedback in the user message, then improve the \
code without changing its observable behavior. Edit files directly using your tools.

Refactor scope: simplify, deduplicate, rename, restructure, tighten types, eliminate dead \
code. NOT scope: behavior changes, new features, bug fixes (those go through the `feature` \
or `bugfix` swarm templates instead).

BEFORE writing any code: verify scout's plan is actually a refactor. A plan introduces a \
feature if it adds new state, new UI, new IPC commands, new timers or intervals, new visible \
behavior, new error paths, or new logic that did not exist before. If scout's plan does any \
of these, STOP — do not implement. Instead, in your assistant message, name the feature being \
introduced and explain that the user should re-route the goal through the `feature` template. \
Producing no diff is the correct outcome when the goal is mis-routed; narrow file scope is not \
the same as no behavior change.

No structured artifact required — your output IS the diff itself, OR an explicit rejection \
explanation if the scope check fails. Verify your changes preserve behavior by reading the \
test suite and any callers.

Iteration policy: if a Reviewer rejected a previous attempt, the user message will include \
the critique. Address it; do not re-introduce the same issue.";

const COORDINATOR_SYSTEM_PROMPT: &str = "\
You are the Coordinator role in a Swarm multi-agent flow.

Your job each tick: read the user's goal and the mailbox of prior tick results, then decide \
which downstream roles to dispatch in parallel. You do NOT modify files. You do NOT review \
code. You ONLY plan and dispatch.

Output is two parts:

1. A short rationale message explaining the dispatch plan for THIS tick.

2. A JSON artifact at the path provided in the user message, with shape:
   {
     \"tick\": <integer matching the current tick>,
     \"done\": <true|false>,
     \"rationale\": \"<one paragraph: why these dispatches, what convergence looks like>\",
     \"dispatches\": [
       {
         \"instance\": \"<unique stable id within this swarm, e.g. 'builder-api'>\",
         \"role\": \"<one of the roles in the template's role pool>\",
         \"task\": \"<concrete instruction for the leg>\",
         \"ownerGlobs\": [\"<glob1>\", \"<glob2>\"],
         \"dependsOn\": [\"<other instance id this waits for>\"]
       }
     ]
   }

Rules:

- Maximum 5 dispatches per tick. Pick fewer when sequencing matters.
- `instance` ids must be unique within the swarm and stable (used as PTY scope keys).
- `role` must match a role in the template's role pool — exposed in the user message.
- `ownerGlobs` declare which file paths each leg may write. Two dispatches in the same tick \
  with overlapping owner_globs will collide and get rejected; pick disjoint scopes.
- `dependsOn` is a local sync barrier. The orchestrator fires a leg only after every listed \
  instance reaches terminal status. The graph must be acyclic; a leg cannot depend on itself.
- `done: true` ends the swarm when emitted. Use it once the goal is met (last reviewer \
  approved, no remaining work). When `done: true`, the dispatches array is ignored.
- `done: false` requires at least one dispatch.

Iteration policy: each tick consumes one iteration. The template caps total ticks via \
`max_iterations`; exceeding it terminates the swarm with status MaxIter. Plan accordingly — \
prefer one well-scoped tick over fan-out → loopback → fan-out cycles.

Bias toward minimum blast radius. When in doubt, dispatch a single Scout to learn more before \
committing parallel Builders.";

/// Returns the seed `AgentConfig` for a given role. Pure — no I/O. Tests use
/// this to verify preset shape; `ensure_role_preset` (and the legacy
/// `ensure_presets`) call it then persists.
///
/// v1.2.0: extended from the original 3 roles (scout/builder/reviewer) to
/// the 6-role library (adds architect/ux-reviewer/refactorer).
pub fn role_preset_seed(role: &str, workspace_id: &str) -> Option<crate::agents::AgentConfig> {
    let (preset_id, name, system_prompt) = match role {
        "scout" => (SCOUT_PRESET_ID, SCOUT_NAME, SCOUT_SYSTEM_PROMPT),
        "builder" => (BUILDER_PRESET_ID, BUILDER_NAME, BUILDER_SYSTEM_PROMPT),
        "reviewer" => (REVIEWER_PRESET_ID, REVIEWER_NAME, REVIEWER_SYSTEM_PROMPT),
        "architect" => (ARCHITECT_PRESET_ID, ARCHITECT_NAME, ARCHITECT_SYSTEM_PROMPT),
        "ux-reviewer" => (
            UX_REVIEWER_PRESET_ID,
            UX_REVIEWER_NAME,
            UX_REVIEWER_SYSTEM_PROMPT,
        ),
        "refactorer" => (
            REFACTORER_PRESET_ID,
            REFACTORER_NAME,
            REFACTORER_SYSTEM_PROMPT,
        ),
        "coordinator" => (
            COORDINATOR_PRESET_ID,
            COORDINATOR_NAME,
            COORDINATOR_SYSTEM_PROMPT,
        ),
        "critic" => (CRITIC_PRESET_ID, CRITIC_NAME, CRITIC_SYSTEM_PROMPT),
        _ => return None,
    };
    Some(crate::agents::AgentConfig {
        schema_version: 1,
        id: String::new(),
        scope: crate::agents::AgentScope::Workspace,
        workspace_id: Some(workspace_id.to_string()),
        name: name.into(),
        description: format!("Auto-seeded Swarm role: {role}"),
        system_prompt: system_prompt.into(),
        runtime_mode: crate::agents::RuntimeMode::Oneshot,
        prompt_template: String::new(),
        allowed_tools: vec![],
        schedule: None,
        triggers: vec![],
        tags: vec!["swarm".into(), role.into()],
        notify_on_done: false,
        preset_id: Some(preset_id.to_string()),
        previous_version: None,
        created_at: 0,
        updated_at: 0,
        // v1.49.0: swarm-preset agents are seeded by the registry, not
        // by a human; leave provenance None so the UI surfaces them as
        // "Atelier preset" rather than impersonating the current user.
        author: None,
        last_edited_by: None,
    })
}

/// v1.2.0: look up — and seed if missing — a single role-preset AgentConfig
/// in this workspace. Returns the agent_id. Idempotent: re-running for a
/// role that already has its preset returns the existing id.
///
/// The preset_id used to identify an existing config is the role string
/// itself (kebab-case) — `role_preset_seed` sets `preset_id = Some(role)`.
/// This is the building block for both the v1.0 `ensure_presets` (which
/// hits the 3 v1.0 roles) and the v1.2 `swarm_start` flow (which iterates
/// the template's role list).
pub fn ensure_role_preset(
    app: &tauri::AppHandle,
    workspace_id: &str,
    role: &str,
) -> Result<String, String> {
    use tauri::Manager;
    let agent_registry = app
        .try_state::<crate::agents::AgentRegistry>()
        .ok_or_else(|| "AgentRegistry not registered".to_string())?;

    let existing = agent_registry
        .list_agents(workspace_id, &PathBuf::new())
        .unwrap_or_default();

    if let Some(found) = existing.iter().find(|a| a.preset_id.as_deref() == Some(role)) {
        return Ok(found.id.clone());
    }
    let seed = role_preset_seed(role, workspace_id)
        .ok_or_else(|| format!("no preset seed for role '{role}'"))?;
    // v1.49.0: swarm-preset agents seeded by the registry carry no
    // human author; provenance stays None so the UI distinguishes them
    // from user-created agents.
    let created = agent_registry.create_agent(seed, None, None)?;
    Ok(created.id)
}

// v1.2.0: the v1.0 `ensure_presets(app, ws) -> {scout/builder/reviewer}`
// helper is gone — the orchestrator-level swarm_start iterates the
// resolved template's role list and calls `ensure_role_preset` per role
// directly. Removed in favor of the more granular API.

// GH #171: `reseed_presets_with_registry` and its Tauri wrapper
// `swarm_reseed_presets` were Settings › Agents' `Reset role prompts to
// built-in defaults`, and went with it. A config's `previousVersion`, which
// they wrote, still loads.

// ── Orchestrator (Tauri-level: wires `agent://run-done` to the FSM) ──

/// Role that the swarm was waiting on, given the current FSM state. The
/// orchestrator uses this to label the just-finished run when feeding it
/// to `next_fsm_state`. Returns `None` for terminal states. v1.2.0: reads
/// the `role` field directly off `PendingStep` — no template store lookup
/// needed.
///
/// v1.5.3 (hotfix): also handle `PendingCoordinator` and `Dispatching`.
/// Without these arms, `on_swarm_run_done`'s fallback path bails early
/// for any coordinator-mode swarm whose coordinator run finishes — the
/// FSM never transitions and the swarm stays stuck in PendingCoordinator.
/// (Dispatching with a non-None role_instance_id is handled explicitly
/// in on_swarm_run_done before this fn is called; the arm here covers
/// the edge case where a Dispatching-state run completes WITHOUT a
/// role_instance_id, e.g. legacy paths.)
pub fn derive_role_from_state(state: &SwarmState) -> Option<String> {
    match state {
        SwarmState::PendingStep { role, .. } => Some(role.clone()),
        SwarmState::PendingCoordinator { .. } => Some("coordinator".to_string()),
        SwarmState::Dispatching { .. } => Some("coordinator".to_string()),
        _ => None,
    }
}

/// R5 (resumable swarms): compute "effective" wall-clock seconds for a
/// swarm — total elapsed minus time spent in `Suspended` state. Pure
/// helper, intentionally `i64`-typed so it slots cleanly alongside the
/// existing `started_at: i64` (unix ms) on `Swarm`. Saturates to 0 to
/// guard against a clock that went backwards between suspend and resume.
///
/// Future wall-time enforcement (deferred from v1.0) should compare this
/// value against `MAX_WALL_SECONDS` rather than using raw `(now -
/// started_at) / 1000` — otherwise an 8-hour suspension would burn the
/// 30-min budget instantly on resume.
pub fn effective_wall_seconds(swarm: &Swarm, now_ms: i64) -> i64 {
    let total_ms = (now_ms - swarm.started_at).max(0);
    let total_secs = total_ms / 1000;
    (total_secs - swarm.suspended_seconds as i64).max(0)
}

/// R5: returns true iff the swarm has exceeded its wall-time budget,
/// using `effective_wall_seconds` (suspended time excluded). The
/// orchestrator should call this before firing the next role and on
/// each runtime tick when wall-time enforcement is finally wired.
pub fn wall_time_exceeded(swarm: &Swarm, now_ms: i64, max_wall_seconds: u64) -> bool {
    effective_wall_seconds(swarm, now_ms) >= max_wall_seconds as i64
}

/// Look up which role a run belongs to via the swarm's role-bindings map
/// (role → agent_id, reversed here). Returns the first matching role.
fn role_for_agent_id(swarm: &Swarm, agent_id: &str) -> Option<String> {
    swarm
        .role_bindings
        .iter()
        .find(|(_, aid)| aid.as_str() == agent_id)
        .map(|(role, _)| role.clone())
}

/// Owned variant of `PriorStep` — orchestrator loads run data into these and
/// then borrows them when calling `build_handoff_payload`.
struct OwnedPriorStep {
    role: String,
    transcript: String,
    changes: Vec<crate::snapshots::FileChange>,
    artifact: Option<serde_json::Value>,
}

fn load_prior_steps(
    swarm: &Swarm,
    agent_registry: &crate::agents::AgentRegistry,
    snapshots_store: &crate::snapshots::SnapshotsStore,
) -> Vec<OwnedPriorStep> {
    let mut out = Vec::new();
    for run_id in &swarm.run_ids {
        let Ok(run) = agent_registry.get_run(run_id) else {
            log::debug!("swarm orchestrator: skipping missing run {run_id}");
            continue;
        };
        let role = role_for_agent_id(swarm, &run.agent_id).unwrap_or_else(|| "unknown".into());
        let transcript = std::fs::read_to_string(&run.transcript_path).unwrap_or_default();
        let changes = snapshots_store
            .read_changes(run_id)
            .ok()
            .flatten()
            .map(|m| m.changes)
            .unwrap_or_default();
        out.push(OwnedPriorStep {
            role,
            transcript,
            changes,
            artifact: run.swarm_artifact.clone(),
        });
    }
    out
}

fn build_run_summary(swarm: &Swarm, run: &crate::agents::AgentRun) -> RunSummary {
    let role = role_for_agent_id(swarm, &run.agent_id).unwrap_or_else(|| "unknown".into());
    let status = match run.status {
        crate::agents::AgentStatus::Pending => "pending",
        crate::agents::AgentStatus::Running => "running",
        crate::agents::AgentStatus::Done => STATUS_DONE,
        crate::agents::AgentStatus::Error => STATUS_ERROR,
        crate::agents::AgentStatus::Killed => STATUS_KILLED,
    };
    let files_changed_count = run
        .swarm_artifact
        .as_ref()
        .and_then(|a| a.get("files_changed_count"))
        .and_then(|v| v.as_u64())
        .map(|n| n as u32);
    RunSummary {
        run_id: run.id.clone(),
        role,
        status: status.into(),
        started_at: run.started_at,
        ended_at: run.ended_at,
        exit_code: run.exit_code,
        bytes_written: run.bytes_written,
        model: run.model.clone(),
        total_cost_usd: run.total_cost_usd,
        files_changed_count,
        throttled: run.throttled,
    }
}

/// Public orchestrator entry. Wraps `SwarmRegistry::swarm_start` and fires the
/// initial scout via `AgentRegistry::start_run`. Called from the IPC layer
/// added in S5; manual tests can call this with a real Tauri test app, but
/// the unit tests focus on the registry-level pieces.
///
/// `cwd_override` (v1.10.x Cycle A): when `Some`, use this path as the swarm's
/// working directory instead of the workspace cwd resolved from
/// `WorkspaceStore`. Set by the kanban moveCard handler to point at the
/// card's per-card git worktree (`<workspace_cwd>/.plyloft-worktrees/<card_id>/`)
/// so multiple parallel cards in the same workspace don't fight over the
/// working tree. `None` preserves the legacy workspace-cwd behavior for
/// non-card-driven swarm starts.
#[derive(Clone)]
enum QueuedSwarmContinuation {
    RecordRun,
    ResumeRun {
        role: String,
        agent_id: String,
    },
    RecordInstance {
        instance_id: String,
    },
}

#[derive(Clone)]
struct QueuedSwarmWriter {
    swarm_id: String,
    agent_id: String,
    workspace_id: String,
    cwd: std::path::PathBuf,
    prompt: String,
    role_instance_id: Option<String>,
    owned_globs: Vec<String>,
    provider: Option<String>,
    continuation: QueuedSwarmContinuation,
    expected_run_count: usize,
}

fn enqueue_swarm_writer(
    app: &tauri::AppHandle,
    request: QueuedSwarmWriter,
) -> Result<crate::writer_queue::WriterQueueReceipt, String> {
    use tauri::Manager;
    let queue = app
        .try_state::<crate::writer_queue::WriterQueue>()
        .ok_or_else(|| "unattended writer queue is unavailable".to_string())?
        .inner()
        .clone();
    let instance_key = request
        .role_instance_id
        .clone()
        .unwrap_or_else(|| "sequential".to_string());
    let key = format!("swarm:{}:{instance_key}", request.swarm_id);
    let workspace_id = request.workspace_id.clone();
    let label = format!("swarm:{}", request.swarm_id);
    queue.enqueue(app, key, workspace_id, label, move |attempt_app| {
        let Some(agent_registry) =
            attempt_app.try_state::<crate::agents::AgentRegistry>()
        else {
            return crate::writer_queue::WriterAttempt::Failed(
                "Agent registry is unavailable".to_string(),
            );
        };
        let Some(pty_registry) = attempt_app.try_state::<crate::pty::PtyRegistry>() else {
            return crate::writer_queue::WriterAttempt::Failed(
                "PTY registry is unavailable".to_string(),
            );
        };
        let Some(swarm_registry) = attempt_app.try_state::<SwarmRegistry>() else {
            return crate::writer_queue::WriterAttempt::Failed(
                "Swarm registry is unavailable".to_string(),
            );
        };
        let Some(current) = swarm_registry.get(&request.swarm_id) else {
            return crate::writer_queue::WriterAttempt::Discarded;
        };
        let still_pending = match &request.continuation {
            QueuedSwarmContinuation::RecordInstance { instance_id } => match &current.state {
                SwarmState::Dispatching { instances, .. } => instances.iter().any(|instance| {
                    instance.id == *instance_id
                        && matches!(instance.status, InstanceStatus::Pending)
                }),
                _ => false,
            },
            QueuedSwarmContinuation::ResumeRun { .. } => {
                current.status == SwarmStatus::Suspended
                    && current.run_ids.len() == request.expected_run_count
            }
            QueuedSwarmContinuation::RecordRun => {
                current.status == SwarmStatus::Running
                    && current.run_ids.len() == request.expected_run_count
            }
        };
        if !still_pending {
            // A competing completion-path pump already launched or retired
            // this exact pending intent. Remove the stale queue entry without
            // starting a duplicate provider process.
            return crate::writer_queue::WriterAttempt::Discarded;
        }
        let result = agent_registry.start_run(
            attempt_app.clone(),
            &pty_registry,
            &request.agent_id,
            crate::agents::AgentScope::Workspace,
            &request.workspace_id,
            request.cwd.clone(),
            Some(request.prompt.clone()),
            crate::agents::AgentTrigger::Swarm,
            Some(request.swarm_id.clone()),
            request.role_instance_id.clone(),
            request.owned_globs.clone(),
            request.provider.as_deref(),
        );
        let run = match result {
            Ok(run) if run.status == crate::agents::AgentStatus::Error => {
                return queued_swarm_failure(
                    &swarm_registry,
                    &request,
                    run.error.unwrap_or_else(|| "swarm role failed to start".to_string()),
                );
            }
            Ok(run) => run,
            Err(error) if crate::coordination::decode_writer_busy(&error).is_some() => {
                return crate::writer_queue::WriterAttempt::Busy;
            }
            Err(error) => {
                return queued_swarm_failure(&swarm_registry, &request, error);
            }
        };
        let post_start = match &request.continuation {
            QueuedSwarmContinuation::RecordRun => {
                swarm_registry.record_run_started(&request.swarm_id, &run.id)
            }
            QueuedSwarmContinuation::ResumeRun { role, agent_id } => {
                swarm_registry
                    .resume_to_running(&request.swarm_id)
                    .and_then(|_| {
                        swarm_registry.append_mailbox(&MailboxEntry {
                            id: Uuid::new_v4().to_string(),
                            ts: now_millis(),
                            swarm_id: request.swarm_id.clone(),
                            kind: MailboxKind::Dispatch,
                            role: Some(role.clone()),
                            run_id: None,
                            body: Some(serde_json::json!({ "agentId": agent_id })),
                            run_summary: None,
                        })
                    })
                    .and_then(|_| {
                        swarm_registry.record_run_started(&request.swarm_id, &run.id)
                    })
            }
            QueuedSwarmContinuation::RecordInstance { instance_id } => {
                swarm_registry.record_instance_started(
                    &request.swarm_id,
                    instance_id,
                    &run.id,
                )
            }
        };
        match post_start {
            Ok(_) => crate::writer_queue::WriterAttempt::Started,
            Err(error) => crate::writer_queue::WriterAttempt::Failed(format!(
                "writer started but swarm state update failed: {error}"
            )),
        }
    })
}

fn queued_swarm_failure(
    registry: &SwarmRegistry,
    request: &QueuedSwarmWriter,
    error: String,
) -> crate::writer_queue::WriterAttempt {
    match &request.continuation {
        QueuedSwarmContinuation::RecordInstance { instance_id } => {
            let _ = mark_instance_failed(
                registry,
                &request.swarm_id,
                instance_id,
                &format!("queued start_run: {error}"),
            );
        }
        QueuedSwarmContinuation::RecordRun => {
            let _ = registry.abort(
                &request.swarm_id,
                &format!("queued role failed to start: {error}"),
            );
        }
        QueuedSwarmContinuation::ResumeRun { .. } => {
            // Preserve Suspended so the user can retry resume explicitly.
        }
    }
    crate::writer_queue::WriterAttempt::Failed(error)
}

pub fn swarm_start(
    app: &tauri::AppHandle,
    workspace_id: &str,
    template_id: &str,
    goal: &str,
    role_bindings: HashMap<String, String>,
    cwd_override: Option<std::path::PathBuf>,
    kind: SwarmKind,
) -> Result<Swarm, String> {
    use tauri::Manager;
    crate::swarm_templates::ensure_startable_template_id(template_id)?;
    let swarm_registry = app
        .try_state::<SwarmRegistry>()
        .ok_or_else(|| "SwarmRegistry not registered".to_string())?;
    let agent_registry = app
        .try_state::<crate::agents::AgentRegistry>()
        .ok_or_else(|| "AgentRegistry not registered".to_string())?;
    let pty_registry = app
        .try_state::<crate::pty::PtyRegistry>()
        .ok_or_else(|| "PtyRegistry not registered".to_string())?;
    let workspace_store = app
        .try_state::<crate::workspace::WorkspaceStore>()
        .ok_or_else(|| "WorkspaceStore not registered".to_string())?;
    let swarm_templates_store = app
        .try_state::<crate::swarm_templates::SwarmTemplatesStore>()
        .ok_or_else(|| "SwarmTemplatesStore not registered".to_string())?;
    let role_bindings_store = app
        .try_state::<crate::swarm_templates::RoleBindingsStore>()
        .ok_or_else(|| "RoleBindingsStore not registered".to_string())?;

    // Resolve cwd. Honor the explicit override when present (kanban
    // card-driven swarms point at the per-card worktree); fall back to
    // the workspace cwd from WorkspaceStore for direct swarm_start IPC
    // calls and other non-card paths.
    let cwd = match cwd_override {
        Some(p) => p,
        None => {
            let snapshot = workspace_store.snapshot();
            let workspace = snapshot
                .workspaces
                .iter()
                .find(|w| w.id == workspace_id)
                .ok_or_else(|| format!("workspace '{workspace_id}' not found"))?;
            std::path::PathBuf::from(&workspace.cwd)
        }
    };

    // v1.2.0: resolve template and normalize id. Legacy "scout-build-review"
    // is redirected to "feature" (the v1.2 builtin equivalent) so new
    // swarms always store a v1.2-shape template_id; older state.json
    // records still get redirected at read time via the same helper.
    let template = resolve_template_or_fallback(&swarm_templates_store, template_id)
        .ok_or_else(|| format!("template '{template_id}' not found and no 'feature' fallback"))?;
    let resolved_template_id = template.id.clone();

    // v1.3.0 (P6): coordinator-mode templates take a different first-fire
    // path. The "first step" concept doesn't apply — `template.steps`
    // becomes the role pool, and the coordinator role is fired first.
    if template.coordinator {
        return start_coordinator_swarm(
            app,
            workspace_id,
            &cwd,
            goal,
            &template,
            &resolved_template_id,
            role_bindings,
            kind,
        );
    }

    let first_step = template
        .steps
        .first()
        .ok_or_else(|| format!("template '{}' has no steps", template.id))?
        .clone();

    // 1. Resolve role bindings. Empty input means "use the per-workspace
    //    role-bindings store as the source of truth" — the v1.2 default.
    //    For each role in the template:
    //      a. If the bindings store has it → use that AgentConfig.id.
    //      b. Else → call ensure_role_preset (auto-seed an AgentConfig
    //         from role_preset_seed) AND persist the resulting
    //         binding so future swarms in this workspace re-use it.
    //
    //    Explicit non-empty bindings (caller-provided) bypass the store
    //    entirely. Used by tests + the bindings-panel "save all" flow
    //    (T8) which writes the full binding set in one shot via
    //    RoleBindingsStore::replace.
    //
    //    If a custom template references a role with no preset_seed and
    //    no existing binding, ensure_role_preset returns
    //    "no preset seed for role 'X'" — the user can then bind
    //    explicitly via the RoleBindingsPanel.
    let bindings = if role_bindings.is_empty() {
        let mut map = HashMap::new();
        let existing = role_bindings_store.get(workspace_id)?;
        for step in &template.steps {
            // De-dup: a template can list the same role twice, but only
            // one binding per role.
            if map.contains_key(&step.role) {
                continue;
            }
            let agent_id = match existing.get(&step.role) {
                Some(id) => id.clone(),
                None => {
                    let id = ensure_role_preset(app, workspace_id, &step.role)?;
                    // Persist so the next swarm in this workspace finds
                    // it without seeding again.
                    role_bindings_store.set_binding(workspace_id, &step.role, &id)?;
                    id
                }
            };
            map.insert(step.role.clone(), agent_id);
        }
        map
    } else {
        role_bindings
    };
    let swarm = swarm_registry.swarm_start(
        workspace_id,
        &resolved_template_id,
        goal,
        &cwd,
        bindings,
        &first_step.role,
        kind,
    )?;

    // 2. Fire the first role. The handoff payload for the initial role is
    //    just the goal (no prior steps yet). Artifact path is included
    //    only if the first step's `expects_artifact` is true.
    let first_agent_id = swarm
        .role_bindings
        .get(&first_step.role)
        .ok_or_else(|| format!("swarm has no role binding for '{}'", first_step.role))?
        .clone();

    // Append `dispatch` mailbox entry BEFORE calling start_run so the mailbox
    // captures intent even if start_run fails.
    let _ = swarm_registry.append_mailbox(&MailboxEntry {
        id: Uuid::new_v4().to_string(),
        ts: now_millis(),
        swarm_id: swarm.id.clone(),
        kind: MailboxKind::Dispatch,
        role: Some(first_step.role.clone()),
        run_id: None,
        body: Some(serde_json::json!({ "agentId": first_agent_id })),
        run_summary: None,
    });

    // Build the prompt: goal + artifact-path template (start_run will
    // substitute RUN_ID_PLACEHOLDER after generating the run id). Only
    // include the artifact path if the first step expects an artifact.
    let artifact_template = if first_step.expects_artifact {
        Some(format!(
            "{}/.atelier/swarm/{}/artifact.json",
            cwd.display(),
            RUN_ID_PLACEHOLDER
        ))
    } else {
        None
    };
    let initial_prompt = build_handoff_payload(goal, &[], artifact_template.as_deref());

    let queued_request = QueuedSwarmWriter {
        swarm_id: swarm.id.clone(),
        agent_id: first_agent_id.clone(),
        workspace_id: workspace_id.to_string(),
        cwd: cwd.clone(),
        prompt: initial_prompt.clone(),
        role_instance_id: None,
        owned_globs: Vec::new(),
        provider: first_step.provider.clone(),
        continuation: QueuedSwarmContinuation::RecordRun,
        expected_run_count: swarm.run_ids.len(),
    };
    let run = match agent_registry.start_run(
        app.clone(),
        &pty_registry,
        &first_agent_id,
        crate::agents::AgentScope::Workspace,
        workspace_id,
        cwd,
        Some(initial_prompt),
        crate::agents::AgentTrigger::Swarm,
        Some(swarm.id.clone()),
        // v1.3 P2: sequential templates run one role-instance at a time per
        // swarm; pass None until P6 wires fan-out dispatching.
        None,
        Vec::new(),
        // v1.21.0 (Phase 3): dispatch through the step's configured provider.
        first_step.provider.as_deref(),
    ) {
        Ok(run) => run,
        Err(error) if crate::coordination::decode_writer_busy(&error).is_some() => {
            enqueue_swarm_writer(app, queued_request)?;
            return Ok(swarm);
        }
        Err(error) => return Err(error),
    };
    swarm_registry.record_run_started(&swarm.id, &run.id)?;
    Ok(swarm)
}

/// Roll back a freshly-started swarm whose card-link publication failed.
/// This deliberately does not wake `pump_card_queue`: callers may still hold
/// `QUEUE_PUMP_LOCK`, and the original publication error must return first.
pub(crate) fn abort_unlinked_start(
    app: &tauri::AppHandle,
    swarm_id: &str,
    reason: &str,
) {
    use tauri::Manager;
    let (Some(swarms), Some(agents), Some(ptys)) = (
        app.try_state::<SwarmRegistry>(),
        app.try_state::<crate::agents::AgentRegistry>(),
        app.try_state::<crate::pty::PtyRegistry>(),
    ) else {
        log::error!(
            "cannot roll back unlinked swarm {swarm_id}: runtime state is unavailable"
        );
        return;
    };
    if let Some(swarm) = swarms.get(swarm_id) {
        for run_id in &swarm.run_ids {
            if let Err(error) = agents.kill_run(run_id, &ptys) {
                log::error!(
                    "cannot stop run {run_id} while rolling back swarm {swarm_id}: {error}"
                );
            }
        }
    }
    if let Err(error) = swarms.abort_without_notification(swarm_id, reason) {
        log::error!("cannot abort unlinked swarm {swarm_id}: {error}");
    }
    if let Some(queue) = app.try_state::<crate::writer_queue::WriterQueue>() {
        queue.cancel_prefix(&format!("swarm:{swarm_id}:"));
    }
}

/// R4 (resumable swarms): re-fire the in-flight role of a `Suspended`
/// swarm. Mirrors `swarm_start`'s shape but skips the registry-create
/// step and uses the saved `in_flight_role_at_suspend` to decide which
/// role to fire.
///
/// Sequence:
/// 1. Validate the swarm is `Suspended` and has an in-flight role.
/// 2. Resolve cwd from the workspace; reject if missing/unreadable.
/// 3. Reconstruct the handoff payload from prior runs via
///    `load_prior_steps` + `build_handoff_payload`.
/// 4. Call `start_run` with the role's agent_id. **If start_run fails,
///    swarm stays Suspended** — we have not yet flipped the status, so
///    the caller can retry without state corruption.
/// 5. On success: flip status `Suspended → Running` via
///    `resume_to_running` (which appends the `Resume` mailbox entry),
///    then append the `Dispatch` mailbox entry and `record_run_started`.
///
/// Returns the post-resume Swarm record (status: Running).
pub fn swarm_resume(
    app: &tauri::AppHandle,
    swarm_id: &str,
) -> Result<Swarm, String> {
    use tauri::Manager;
    let swarm_registry = app
        .try_state::<SwarmRegistry>()
        .ok_or_else(|| "SwarmRegistry not registered".to_string())?;
    let agent_registry = app
        .try_state::<crate::agents::AgentRegistry>()
        .ok_or_else(|| "AgentRegistry not registered".to_string())?;
    let pty_registry = app
        .try_state::<crate::pty::PtyRegistry>()
        .ok_or_else(|| "PtyRegistry not registered".to_string())?;
    let workspace_store = app
        .try_state::<crate::workspace::WorkspaceStore>()
        .ok_or_else(|| "WorkspaceStore not registered".to_string())?;
    let snapshots_store = app
        .try_state::<crate::snapshots::SnapshotsStore>()
        .ok_or_else(|| "SnapshotsStore not registered".to_string())?;

    // v1.3.0 (P8): coordinator-mode parallel resume. If the suspended swarm
    // was in Dispatching state with non-empty in_flight_at_suspend, branch
    // to the parallel-resume path.
    let pre_check = swarm_registry
        .get(swarm_id)
        .ok_or_else(|| format!("unknown swarm '{swarm_id}'"))?;
    if pre_check.status != SwarmStatus::Suspended {
        return Err(format!(
            "swarm '{swarm_id}' is not suspended (status: {:?}). Cannot resume.",
            pre_check.status
        ));
    }
    if matches!(pre_check.state, SwarmState::Dispatching { .. })
        && !pre_check.in_flight_at_suspend.is_empty()
    {
        return swarm_resume_parallel(app, swarm_id, &pre_check);
    }

    // 1. Validate Suspended + capture role + agent_id + cwd. Read-only.
    let (role_to_fire, agent_id, cwd, swarm_pre) = {
        let swarm = swarm_registry
            .get(swarm_id)
            .ok_or_else(|| format!("unknown swarm '{swarm_id}'"))?;
        if swarm.status != SwarmStatus::Suspended {
            return Err(format!(
                "swarm '{swarm_id}' is not suspended (status: {:?}). Cannot resume.",
                swarm.status
            ));
        }
        let role = swarm
            .in_flight_role_at_suspend
            .clone()
            .or_else(|| derive_role_from_state(&swarm.state))
            .ok_or_else(|| {
                format!("swarm '{swarm_id}' has no recoverable in-flight role; cannot resume")
            })?;
        let agent_id = swarm
            .role_bindings
            .get(&role)
            .ok_or_else(|| format!("swarm '{swarm_id}' has no binding for role '{role}'"))?
            .clone();
        let snapshot = workspace_store.snapshot();
        let workspace = snapshot
            .workspaces
            .iter()
            .find(|w| w.id == swarm.workspace_id)
            .ok_or_else(|| format!("workspace '{}' not found", swarm.workspace_id))?;
        // v1.31.0 (Cycle 1): resume in the swarm's persisted cwd (the
        // per-card worktree), not the raw workspace checkout.
        let cwd = if !swarm.cwd.is_empty() {
            std::path::PathBuf::from(&swarm.cwd)
        } else {
            std::path::PathBuf::from(&workspace.cwd)
        };
        if !cwd.exists() {
            return Err(format!(
                "swarm cwd '{}' is not accessible; cannot resume",
                cwd.display()
            ));
        }
        (role, agent_id, cwd, swarm)
    };

    // 2. Build handoff payload from prior runs.
    let prior_owned = load_prior_steps(&swarm_pre, &agent_registry, &snapshots_store);
    let prior: Vec<PriorStep<'_>> = prior_owned
        .iter()
        .map(|p| PriorStep {
            role: &p.role,
            transcript: &p.transcript,
            changes: &p.changes,
            artifact: p.artifact.as_ref(),
        })
        .collect();
    // v1.2.0: pull the step's `expects_artifact` flag from the template
    // rather than hardcoding "builder is the only no-artifact role".
    // Mirrors the on_swarm_run_done path. If the template can't be
    // resolved we conservatively include the artifact path; the role will
    // simply ignore it if not needed.
    let swarm_templates_store = app.try_state::<crate::swarm_templates::SwarmTemplatesStore>();
    let resolved_template = swarm_templates_store
        .as_ref()
        .and_then(|s| resolve_template_or_fallback(s, &swarm_pre.template_id));
    let next_expects_artifact = resolved_template
        .as_ref()
        .and_then(|tmpl| match &swarm_pre.state {
            SwarmState::PendingStep { idx, .. } => tmpl
                .steps
                .get(*idx as usize)
                .map(|step| step.expects_artifact),
            _ => None,
        })
        .unwrap_or(true);
    // v1.21.0 (Phase 3): dispatch through the resumed step's provider. None
    // means claude. If the template can't be resolved (e.g. user deleted the
    // template since the swarm started) we fall back to claude — the v1.x
    // default — to preserve resumability.
    let resumed_step_provider: Option<String> = resolved_template
        .as_ref()
        .and_then(|tmpl| match &swarm_pre.state {
            SwarmState::PendingStep { idx, .. } => tmpl
                .steps
                .get(*idx as usize)
                .and_then(|step| step.provider.clone()),
            _ => None,
        });
    let artifact_template = if next_expects_artifact {
        Some(format!(
            "{}/.atelier/swarm/{}/artifact.json",
            cwd.display(),
            RUN_ID_PLACEHOLDER
        ))
    } else {
        None
    };
    let prompt = build_handoff_payload(
        &swarm_pre.goal,
        &prior,
        artifact_template.as_deref(),
    );

    // 3. Fire the role. If this fails, swarm stays Suspended.
    let queued_request = QueuedSwarmWriter {
        swarm_id: swarm_id.to_string(),
        agent_id: agent_id.clone(),
        workspace_id: swarm_pre.workspace_id.clone(),
        cwd: cwd.clone(),
        prompt: prompt.clone(),
        role_instance_id: None,
        owned_globs: Vec::new(),
        provider: resumed_step_provider.clone(),
        continuation: QueuedSwarmContinuation::ResumeRun {
            role: role_to_fire.clone(),
            agent_id: agent_id.clone(),
        },
        expected_run_count: swarm_pre.run_ids.len(),
    };
    let run = match agent_registry.start_run(
        app.clone(),
        &pty_registry,
        &agent_id,
        crate::agents::AgentScope::Workspace,
        &swarm_pre.workspace_id,
        cwd,
        Some(prompt),
        crate::agents::AgentTrigger::Swarm,
        Some(swarm_id.to_string()),
        // v1.3 P2: sequential resume; P8 will lift this for parallel resume.
        None,
        Vec::new(),
        resumed_step_provider.as_deref(),
    ) {
        Ok(run) => run,
        Err(error) if crate::coordination::decode_writer_busy(&error).is_some() => {
            enqueue_swarm_writer(app, queued_request)?;
            return Ok(swarm_pre);
        }
        Err(error) => return Err(error),
    };

    // 4. start_run succeeded — flip status (Suspended → Running) and
    //    append Resume mailbox entry. resume_to_running handles both.
    let updated = swarm_registry.resume_to_running(swarm_id)?;

    // 5. Append Dispatch mailbox entry + record run id (mirrors the
    //    orchestrator path in on_swarm_run_done).
    let _ = swarm_registry.append_mailbox(&MailboxEntry {
        id: Uuid::new_v4().to_string(),
        ts: now_millis(),
        swarm_id: swarm_id.to_string(),
        kind: MailboxKind::Dispatch,
        role: Some(role_to_fire),
        run_id: None,
        body: Some(serde_json::json!({ "agentId": agent_id })),
        run_summary: None,
    });
    swarm_registry.record_run_started(swarm_id, &run.id)?;

    Ok(updated)
}

/// v1.3.0 (P6): orchestrator-level entry for coordinator-mode templates.
/// v1.3.0 (P8): parallel-mode resume for a Suspended swarm in Dispatching
/// state. Re-fires every leg captured in `in_flight_at_suspend` whose
/// status was Pending or Running at suspend time. Each leg goes through
/// the same start_run plumbing as a fresh dispatch (P6's `dispatch_fan_out`
/// shape — emit InstanceStarted mailbox, spawn with role_instance_id +
/// owner_globs, record_instance_started). On success of at least one leg,
/// flip the swarm Suspended → Running via `resume_to_running`.
///
/// On total failure (every captured leg's start_run returns Err), the
/// swarm stays Suspended — the user can retry.
fn swarm_resume_parallel(
    app: &tauri::AppHandle,
    swarm_id: &str,
    swarm_pre: &Swarm,
) -> Result<Swarm, String> {
    use tauri::Manager;
    let swarm_registry = app
        .try_state::<SwarmRegistry>()
        .ok_or_else(|| "SwarmRegistry not registered".to_string())?;
    let agent_registry = app
        .try_state::<crate::agents::AgentRegistry>()
        .ok_or_else(|| "AgentRegistry not registered".to_string())?;
    let pty_registry = app
        .try_state::<crate::pty::PtyRegistry>()
        .ok_or_else(|| "PtyRegistry not registered".to_string())?;
    let workspace_store = app
        .try_state::<crate::workspace::WorkspaceStore>()
        .ok_or_else(|| "WorkspaceStore not registered".to_string())?;
    // v1.21.0 (Phase 3): resolve the template so each captured instance can
    // dispatch through the correct provider (matched on role). Missing
    // template falls back to claude per the v1.x default.
    let resumed_template = app
        .try_state::<crate::swarm_templates::SwarmTemplatesStore>()
        .as_ref()
        .and_then(|s| resolve_template_or_fallback(s, &swarm_pre.template_id));

    let snapshot = workspace_store.snapshot();
    let workspace = snapshot
        .workspaces
        .iter()
        .find(|w| w.id == swarm_pre.workspace_id)
        .ok_or_else(|| format!("workspace '{}' not found", swarm_pre.workspace_id))?;
    // v1.31.0 (Cycle 1): resume in the swarm's persisted cwd.
    let cwd = if !swarm_pre.cwd.is_empty() {
        std::path::PathBuf::from(&swarm_pre.cwd)
    } else {
        std::path::PathBuf::from(&workspace.cwd)
    };
    if !cwd.exists() {
        return Err(format!(
            "swarm cwd '{}' is not accessible; cannot resume",
            cwd.display()
        ));
    }

    // Flip Suspended → Running first. resume_to_running appends the
    // Resume mailbox entry and adjusts suspended_seconds. We do this
    // before firing legs so any per-leg start_run failure is logged
    // against a Running swarm (matching the dispatch_fan_out posture).
    let _ = swarm_registry.resume_to_running(swarm_id)?;

    let mut spawned = 0usize;
    let mut queued = 0usize;
    for inst in &swarm_pre.in_flight_at_suspend {
        // Build a per-instance prompt similar to dispatch_fan_out's. Pull
        // the agent_id from the swarm's role_bindings.
        let agent_id = match swarm_pre.role_bindings.get(&inst.role) {
            Some(a) => a.clone(),
            None => {
                log::warn!(
                    "swarm_resume_parallel: no role binding for '{}' in swarm {swarm_id}",
                    inst.role
                );
                continue;
            }
        };

        let task_block = format!(
            "# Goal\n\n{goal}\n\n# Your task (instance: {inst_id}, role: {role})\n\n{task}\n",
            goal = swarm_pre.goal,
            inst_id = inst.id,
            role = inst.role,
            task = if inst.task.is_empty() { "(resumed; no task description provided)" } else { &inst.task },
        );
        let owned_block = if inst.owner_globs.is_empty() {
            String::new()
        } else {
            format!(
                "\n# Owner globs (writes outside these are flagged as collisions)\n\n{}\n",
                inst.owner_globs
                    .iter()
                    .map(|g| format!("- `{g}`"))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        };
        let artifact_block = format!(
            "\n# Artifact path\n\n{}/.atelier/swarm/{}/artifact.json\n",
            cwd.display(),
            RUN_ID_PLACEHOLDER
        );
        let prompt = format!("{task_block}{owned_block}{artifact_block}");

        let _ = swarm_registry.append_mailbox(&MailboxEntry {
            id: Uuid::new_v4().to_string(),
            ts: now_millis(),
            swarm_id: swarm_id.to_string(),
            kind: MailboxKind::InstanceStarted,
            role: Some(inst.role.clone()),
            run_id: None,
            body: Some(serde_json::json!({
                "instanceId": inst.id,
                "role": inst.role,
                "agentId": agent_id,
                "ownerGlobs": inst.owner_globs,
                "dependsOn": inst.depends_on,
                "task": inst.task,
                "resumed": true,
            })),
            run_summary: None,
        });

        // v1.21.0 (Phase 3): per-instance provider lookup. Match on role
        // in the template's step pool; absent template / role → claude.
        let inst_provider: Option<String> = resumed_template
            .as_ref()
            .and_then(|tmpl| tmpl.steps.iter().find(|s| s.role == inst.role))
            .and_then(|s| s.provider.clone());

        let queued_request = QueuedSwarmWriter {
            swarm_id: swarm_id.to_string(),
            agent_id: agent_id.clone(),
            workspace_id: swarm_pre.workspace_id.clone(),
            cwd: cwd.clone(),
            prompt: prompt.clone(),
            role_instance_id: Some(inst.id.clone()),
            owned_globs: inst.owner_globs.clone(),
            provider: inst_provider.clone(),
            continuation: QueuedSwarmContinuation::RecordInstance {
                instance_id: inst.id.clone(),
            },
            expected_run_count: swarm_pre.run_ids.len(),
        };
        match agent_registry.start_run(
            app.clone(),
            &pty_registry,
            &agent_id,
            crate::agents::AgentScope::Workspace,
            &swarm_pre.workspace_id,
            cwd.clone(),
            Some(prompt),
            crate::agents::AgentTrigger::Swarm,
            Some(swarm_id.to_string()),
            Some(inst.id.clone()),
            inst.owner_globs.clone(),
            inst_provider.as_deref(),
        ) {
            Ok(run) => {
                if let Err(e) =
                    swarm_registry.record_instance_started(swarm_id, &inst.id, &run.id)
                {
                    log::warn!(
                        "swarm_resume_parallel: record_instance_started({}) failed: {e}",
                        inst.id
                    );
                }
                spawned += 1;
            }
            Err(e) if crate::coordination::decode_writer_busy(&e).is_some() => {
                enqueue_swarm_writer(app, queued_request)?;
                queued += 1;
            }
            Err(e) => {
                log::warn!(
                    "swarm_resume_parallel: start_run failed for instance '{}': {e}",
                    inst.id
                );
                let _ = mark_instance_failed(
                    &swarm_registry,
                    swarm_id,
                    &inst.id,
                    &format!("resume start_run: {e}"),
                );
            }
        }
    }

    if spawned == 0 && queued == 0 {
        // Total failure — every captured leg errored. Leave the swarm
        // Running (the resume_to_running flip already happened); the FSM
        // will see all instances Failed and advance to PendingCoordinator
        // on the next on_swarm_run_done — which won't fire because no
        // run was spawned. Caller should expect to abort manually.
        log::warn!(
            "swarm_resume_parallel: all {} captured legs failed to spawn for {swarm_id}",
            swarm_pre.in_flight_at_suspend.len()
        );
    }

    swarm_registry
        .get(swarm_id)
        .ok_or_else(|| format!("swarm '{swarm_id}' vanished post-resume"))
}

/// Mirrors the sequential `swarm_start` body but creates the swarm in
/// `PendingCoordinator { tick: 1 }` state and fires the coordinator role
/// instead of step[0]. Role bindings are seeded for both the coordinator
/// and every role in the template's role pool — coordinator dispatches
/// can target any of them on subsequent ticks.
#[allow(clippy::too_many_arguments)]
fn start_coordinator_swarm(
    app: &tauri::AppHandle,
    workspace_id: &str,
    cwd: &std::path::Path,
    goal: &str,
    template: &crate::swarm_templates::SwarmTemplate,
    resolved_template_id: &str,
    role_bindings: HashMap<String, String>,
    kind: SwarmKind,
) -> Result<Swarm, String> {
    use tauri::Manager;
    let swarm_registry = app
        .try_state::<SwarmRegistry>()
        .ok_or_else(|| "SwarmRegistry not registered".to_string())?;
    let agent_registry = app
        .try_state::<crate::agents::AgentRegistry>()
        .ok_or_else(|| "AgentRegistry not registered".to_string())?;
    let pty_registry = app
        .try_state::<crate::pty::PtyRegistry>()
        .ok_or_else(|| "PtyRegistry not registered".to_string())?;
    let role_bindings_store = app
        .try_state::<crate::swarm_templates::RoleBindingsStore>()
        .ok_or_else(|| "RoleBindingsStore not registered".to_string())?;

    // Seed coordinator + every role in the pool so any dispatch tick can
    // fire any of them. Same pattern as the sequential path.
    let bindings = if role_bindings.is_empty() {
        let mut map = HashMap::new();
        let existing = role_bindings_store.get(workspace_id)?;
        // Always need a coordinator binding.
        let mut roles_to_seed: Vec<&str> = vec!["coordinator"];
        for step in &template.steps {
            if !roles_to_seed.iter().any(|r| *r == step.role) {
                roles_to_seed.push(&step.role);
            }
        }
        for role in roles_to_seed {
            let agent_id = match existing.get(role) {
                Some(id) => id.clone(),
                None => {
                    let id = ensure_role_preset(app, workspace_id, role)?;
                    role_bindings_store.set_binding(workspace_id, role, &id)?;
                    id
                }
            };
            map.insert(role.to_string(), agent_id);
        }
        map
    } else {
        role_bindings
    };

    let swarm = swarm_registry.swarm_start_coordinator(
        workspace_id,
        resolved_template_id,
        goal,
        cwd,
        bindings,
        kind,
    )?;

    // Fire the coordinator (tick 1).
    let coord_agent_id = swarm
        .role_bindings
        .get("coordinator")
        .ok_or_else(|| "swarm has no role binding for 'coordinator'".to_string())?
        .clone();

    let _ = swarm_registry.append_mailbox(&MailboxEntry {
        id: Uuid::new_v4().to_string(),
        ts: now_millis(),
        swarm_id: swarm.id.clone(),
        kind: MailboxKind::CoordinatorTick,
        role: Some("coordinator".into()),
        run_id: None,
        body: Some(serde_json::json!({ "tick": 1, "agentId": coord_agent_id })),
        run_summary: None,
    });

    let prompt = build_coordinator_handoff(goal, template, 1, &[]);
    let artifact_path = format!(
        "{}/.atelier/swarm/{}/artifact.json",
        cwd.display(),
        RUN_ID_PLACEHOLDER
    );
    let prompt = format!(
        "{prompt}\n\n## Artifact path\n\nWrite your dispatch artifact to: {artifact_path}\n"
    );

    let queued_request = QueuedSwarmWriter {
        swarm_id: swarm.id.clone(),
        agent_id: coord_agent_id.clone(),
        workspace_id: workspace_id.to_string(),
        cwd: cwd.to_path_buf(),
        prompt: prompt.clone(),
        role_instance_id: None,
        owned_globs: Vec::new(),
        provider: None,
        continuation: QueuedSwarmContinuation::RecordRun,
        expected_run_count: swarm.run_ids.len(),
    };
    let run = match agent_registry.start_run(
        app.clone(),
        &pty_registry,
        &coord_agent_id,
        crate::agents::AgentScope::Workspace,
        workspace_id,
        cwd.to_path_buf(),
        Some(prompt),
        crate::agents::AgentTrigger::Swarm,
        Some(swarm.id.clone()),
        // Coordinator runs are NOT instance dispatches; instance_id stays
        // None. Fan-out runs (P6 below) populate it.
        None,
        Vec::new(),
        // v1.21.0 (Phase 3): coordinator role is not part of `template.steps`
        // (it's a meta-role) — provider lives only on RoleStep, so a
        // coordinator dispatches with None: Claude where Claude is installed,
        // Codex on a Codex-only machine (OB-14, `agents::swarm_step_provider`).
        None,
    ) {
        Ok(run) => run,
        Err(error) if crate::coordination::decode_writer_busy(&error).is_some() => {
            enqueue_swarm_writer(app, queued_request)?;
            return Ok(swarm);
        }
        Err(error) => return Err(error),
    };
    swarm_registry.record_run_started(&swarm.id, &run.id)?;
    Ok(swarm)
}

/// v1.3.0 (P6): construct the coordinator's prompt for tick `tick`. Includes
/// the goal, the template's role pool, and a summary of prior-tick instance
/// results (empty for tick 1). Concise — the role's system prompt already
/// articulates the artifact contract.
fn build_coordinator_handoff(
    goal: &str,
    template: &crate::swarm_templates::SwarmTemplate,
    tick: u32,
    prior_instances: &[RoleInstance],
) -> String {
    let role_pool: Vec<String> = template
        .steps
        .iter()
        .map(|s| format!("- {}", s.role))
        .collect();
    let mut out = String::new();
    out.push_str(&format!("# Goal\n\n{}\n\n", goal));
    out.push_str(&format!("# Tick\n\n{tick} (max {})\n\n", template.max_iterations));
    out.push_str("# Role pool\n\n");
    out.push_str(&role_pool.join("\n"));
    out.push_str("\n\n");
    if !prior_instances.is_empty() {
        out.push_str("# Prior tick results\n\n");
        for inst in prior_instances {
            let status = match inst.status {
                InstanceStatus::Pending => "pending",
                InstanceStatus::Running => "running",
                InstanceStatus::Done => "done",
                InstanceStatus::Failed => "failed",
            };
            out.push_str(&format!(
                "- `{}` (role: {}, status: {})\n  task: {}\n",
                inst.id, inst.role, status, inst.task
            ));
        }
        out.push('\n');
    }
    out
}

/// v1.3.0 (P7): pure helper that finds pairs of instances whose
/// `owner_globs` overlap. Returns `(a_id, b_id)` with `a_id < b_id`
/// lexicographically for stable ordering. Heuristic: probe each glob
/// of B against A's GlobSet (stripped of `*`/`**`/`?`). The check is
/// conservative; false positives bias toward emitting collision
/// entries (safe — coordinator just re-plans next tick). Empty
/// owner_globs participate in zero collisions.
pub fn detect_glob_collisions(instances: &[RoleInstance]) -> Vec<(String, String)> {
    let mut collisions: Vec<(String, String)> = Vec::new();
    for (i, a) in instances.iter().enumerate() {
        if a.owner_globs.is_empty() {
            continue;
        }
        let mut a_set = globset::GlobSetBuilder::new();
        let mut a_added = 0usize;
        for g in &a.owner_globs {
            if let Ok(g) = globset::Glob::new(g) {
                a_set.add(g);
                a_added += 1;
            }
        }
        if a_added == 0 {
            continue;
        }
        let a_set = match a_set.build() {
            Ok(s) => s,
            Err(_) => continue,
        };
        for b in instances.iter().skip(i + 1) {
            if b.owner_globs.is_empty() {
                continue;
            }
            let overlap = b.owner_globs.iter().any(|g| {
                let probe = g.replace("**", "x").replace('*', "x").replace('?', "x");
                a_set.is_match(&probe)
            });
            if overlap {
                let (lo, hi) = if a.id < b.id {
                    (a.id.clone(), b.id.clone())
                } else {
                    (b.id.clone(), a.id.clone())
                };
                if !collisions.iter().any(|(x, y)| x == &lo && y == &hi) {
                    collisions.push((lo, hi));
                }
            }
        }
    }
    collisions
}

/// v1.3.0 (P6): for a swarm in `Dispatching` state, identify which
/// `Pending` instances have all their `depends_on` satisfied (every named
/// dependency has `InstanceStatus::Done`) and return refs to them. Used
/// by the orchestrator to fan-out start_run calls — initial dispatch
/// after the coordinator's first tick + any newly-unblocked legs after
/// each instance completes.
fn ready_instances(instances: &[RoleInstance]) -> Vec<RoleInstance> {
    let done_ids: std::collections::HashSet<&str> = instances
        .iter()
        .filter(|i| matches!(i.status, InstanceStatus::Done))
        .map(|i| i.id.as_str())
        .collect();
    instances
        .iter()
        .filter(|i| {
            matches!(i.status, InstanceStatus::Pending)
                && i.depends_on.iter().all(|d| done_ids.contains(d.as_str()))
        })
        .cloned()
        .collect()
}

/// v1.3.0 (P6): fire `start_run` for every ready instance in the
/// `Dispatching` state's instance list. Emits one `instance_started`
/// mailbox entry per leg. Errors on individual legs are logged + the
/// instance flips to `Failed` (so the FSM still terminates the leg
/// rather than hanging).
fn dispatch_fan_out(
    app: &tauri::AppHandle,
    swarm_id: &str,
    swarm_goal: &str,
    cwd: &std::path::Path,
    instances: &[RoleInstance],
    // v1.21.0 (Phase 3): template is `None` only when the lookup fails at the
    // call site; we use it to find each instance's role's configured provider.
    // Absent template / role → claude (the v1.x default).
    template: Option<&crate::swarm_templates::SwarmTemplate>,
) -> Result<(), String> {
    use tauri::Manager;
    let swarm_registry = app
        .try_state::<SwarmRegistry>()
        .ok_or_else(|| "SwarmRegistry not registered".to_string())?;
    let agent_registry = app
        .try_state::<crate::agents::AgentRegistry>()
        .ok_or_else(|| "AgentRegistry not registered".to_string())?;
    let pty_registry = app
        .try_state::<crate::pty::PtyRegistry>()
        .ok_or_else(|| "PtyRegistry not registered".to_string())?;

    // Re-fetch the swarm so role_bindings is current.
    let swarm = swarm_registry
        .get(swarm_id)
        .ok_or_else(|| format!("unknown swarm '{swarm_id}'"))?;

    for inst in instances {
        let agent_id = match swarm.role_bindings.get(&inst.role) {
            Some(a) => a.clone(),
            None => {
                log::warn!(
                    "swarm orchestrator: no role binding for '{}' in swarm {swarm_id}; failing instance '{}'",
                    inst.role,
                    inst.id
                );
                let _ = mark_instance_failed(&swarm_registry, swarm_id, &inst.id, "no role binding");
                continue;
            }
        };

        // Build a per-instance prompt: goal + the dispatch's task + the
        // role's artifact path (same RUN_ID_PLACEHOLDER trick).
        let task_block = format!(
            "# Goal\n\n{goal}\n\n# Your task (instance: {inst_id}, role: {role})\n\n{task}\n",
            goal = swarm_goal,
            inst_id = inst.id,
            role = inst.role,
            task = if inst.task.is_empty() { "(no task description provided)" } else { &inst.task },
        );
        let owned_block = if inst.owner_globs.is_empty() {
            String::new()
        } else {
            format!(
                "\n# Owner globs (writes outside these are flagged as collisions)\n\n{}\n",
                inst.owner_globs
                    .iter()
                    .map(|g| format!("- `{g}`"))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        };
        let artifact_block = format!(
            "\n# Artifact path\n\n{}/.atelier/swarm/{}/artifact.json\n",
            cwd.display(),
            RUN_ID_PLACEHOLDER
        );
        let prompt = format!("{task_block}{owned_block}{artifact_block}");

        let _ = swarm_registry.append_mailbox(&MailboxEntry {
            id: Uuid::new_v4().to_string(),
            ts: now_millis(),
            swarm_id: swarm_id.to_string(),
            kind: MailboxKind::InstanceStarted,
            role: Some(inst.role.clone()),
            run_id: None,
            body: Some(serde_json::json!({
                "instanceId": inst.id,
                "role": inst.role,
                "agentId": agent_id,
                "ownerGlobs": inst.owner_globs,
                "dependsOn": inst.depends_on,
                "task": inst.task,
            })),
            run_summary: None,
        });

        // v1.21.0 (Phase 3): per-instance provider lookup. Match on role
        // in the template's step pool; absent template / role → claude.
        let inst_provider: Option<String> = template
            .and_then(|tmpl| tmpl.steps.iter().find(|s| s.role == inst.role))
            .and_then(|s| s.provider.clone());

        let queued_request = QueuedSwarmWriter {
            swarm_id: swarm_id.to_string(),
            agent_id: agent_id.clone(),
            workspace_id: swarm.workspace_id.clone(),
            cwd: cwd.to_path_buf(),
            prompt: prompt.clone(),
            role_instance_id: Some(inst.id.clone()),
            owned_globs: inst.owner_globs.clone(),
            provider: inst_provider.clone(),
            continuation: QueuedSwarmContinuation::RecordInstance {
                instance_id: inst.id.clone(),
            },
            expected_run_count: swarm.run_ids.len(),
        };
        match agent_registry.start_run(
            app.clone(),
            &pty_registry,
            &agent_id,
            crate::agents::AgentScope::Workspace,
            &swarm.workspace_id,
            cwd.to_path_buf(),
            Some(prompt),
            crate::agents::AgentTrigger::Swarm,
            Some(swarm_id.to_string()),
            Some(inst.id.clone()),
            // v1.3 P7: pass owner_globs through to the exit listener so
            // compute_changes_with_globs flags out-of-glob writes.
            inst.owner_globs.clone(),
            inst_provider.as_deref(),
        ) {
            Ok(run) => {
                if let Err(e) =
                    swarm_registry.record_instance_started(swarm_id, &inst.id, &run.id)
                {
                    log::warn!(
                        "swarm orchestrator: record_instance_started({}) failed: {e}",
                        inst.id
                    );
                }
            }
            Err(e) if crate::coordination::decode_writer_busy(&e).is_some() => {
                enqueue_swarm_writer(app, queued_request)?;
            }
            Err(e) => {
                log::warn!(
                    "swarm orchestrator: start_run failed for instance '{}': {e}",
                    inst.id
                );
                let _ = mark_instance_failed(
                    &swarm_registry,
                    swarm_id,
                    &inst.id,
                    &format!("start_run: {e}"),
                );
            }
        }
    }

    Ok(())
}

/// v1.3.0 (P6): set a Dispatching swarm's instance to `Failed` (keeps
/// state.json consistent so the next run-done event drives FSM toward
/// PendingCoordinator(tick+1) once all legs terminal).
fn mark_instance_failed(
    swarm_registry: &SwarmRegistry,
    swarm_id: &str,
    instance_id: &str,
    reason: &str,
) -> Result<(), String> {
    let mut cache = swarm_registry.cache.lock();
    let swarm = cache
        .get_mut(swarm_id)
        .ok_or_else(|| format!("unknown swarm '{swarm_id}'"))?;
    if let SwarmState::Dispatching { instances, .. } = &mut swarm.state {
        for inst in instances.iter_mut() {
            if inst.id == instance_id {
                inst.status = InstanceStatus::Failed;
                break;
            }
        }
    }
    let snapshot = swarm.clone();
    drop(cache);
    swarm_registry.persist(&snapshot)?;
    let _ = swarm_registry.append_mailbox(&MailboxEntry {
        id: Uuid::new_v4().to_string(),
        ts: now_millis(),
        swarm_id: swarm_id.to_string(),
        kind: MailboxKind::InstanceDone,
        role: None,
        run_id: None,
        body: Some(serde_json::json!({
            "instanceId": instance_id,
            "status": "failed",
            "reason": reason,
        })),
        run_summary: None,
    });
    Ok(())
}

/// Subscribe to `agent://run-done` and dispatch swarm-spawned runs to the FSM.
/// Wire from `lib.rs::setup` — once per app lifetime.
pub fn start_swarm_listener(app: tauri::AppHandle) {
    use tauri::Listener;
    let app_for_listener = app.clone();
    app.listen("agent://run-done", move |event| {
        let payload: SwarmListenerPayload = match serde_json::from_str(event.payload()) {
            Ok(p) => p,
            Err(_) => return,
        };
        if payload.swarm_id.is_none() {
            return;
        }
        on_swarm_run_done(&app_for_listener, payload);
    });
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwarmListenerPayload {
    run_id: String,
    #[allow(dead_code)]
    agent_id: String,
    status: crate::agents::AgentStatus,
    swarm_id: Option<String>,
}

/// v1.31.0 (Outcome screen fix): apply the wall-time cap to the FSM's
/// natural decision. The cap exists to stop a swarm that would otherwise
/// keep *spending* time — so it only overrides an `Advance` (another leg
/// about to fire). If `natural` is already terminal (the reviewer approved
/// → `Done`, or a leg failed → `Failed`), that is a real outcome reached
/// by genuine work — keep it. Overriding a finished, approved swarm with
/// `TimedOut` mislabels success as failure (and drops the card out of the
/// retry queue). Pure — unit-tested.
fn apply_wall_time_cap(
    natural: FsmTransition,
    swarm: &Swarm,
    now_ms: i64,
    max_wall_seconds: u64,
) -> FsmTransition {
    match natural {
        FsmTransition::Advance { .. }
            if wall_time_exceeded(swarm, now_ms, max_wall_seconds) =>
        {
            let elapsed = effective_wall_seconds(swarm, now_ms);
            FsmTransition::Terminate {
                status: SwarmStatus::TimedOut,
                state: SwarmState::TimedOut,
                reason: format!("exceeded wall_time after {elapsed}s"),
            }
        }
        other => other,
    }
}

/// v1.31.0 (Outcome screen): auto-start a verify run for a card after its
/// swarm finishes clean. Gated on a configured `verify_pipeline` — a
/// workspace with no project_config would otherwise run the hardcoded
/// Atelier cargo+ppvp pipeline against an unrelated project. Best-effort.
/// True when the workspace has a non-empty verify pipeline configured. Shared
/// by `maybe_autostart_verify` and Phase 4's outcome-comment routing (which
/// must know whether a Done swarm will trigger an auto-verify before deciding
/// to post the issue comment now or defer to the verify-completion path).
fn workspace_has_verify_pipeline(app: &tauri::AppHandle, workspace_id: &str) -> bool {
    use tauri::Manager;
    app.try_state::<crate::project_config::ProjectConfigStore>()
        .and_then(|pc| pc.get(workspace_id))
        .and_then(|c| c.verify_pipeline)
        .map_or(false, |p| !p.is_empty())
}

/// v1.58.0 (Phase 4): friendly label for a terminal swarm status, used in the
/// card-outcome issue comment header.
fn swarm_status_label(status: SwarmStatus) -> &'static str {
    match status {
        SwarmStatus::Done => "✓ completed",
        SwarmStatus::Failed => "✗ failed",
        SwarmStatus::Aborted => "⊘ aborted",
        SwarmStatus::TimedOut => "⏱ timed out",
        SwarmStatus::MaxIter => "⚠ hit iteration cap",
        // Running/Suspended aren't terminal and don't reach the poster.
        _ => "finished",
    }
}

fn maybe_autostart_verify(app: &tauri::AppHandle, workspace_id: &str, card_id: &str) {
    use tauri::Manager;
    if !workspace_has_verify_pipeline(app, workspace_id) {
        return;
    }
    let (
        Some(verify),
        Some(kanban),
        Some(workspaces),
        Some(agents),
        Some(swarms),
        Some(card_execution),
    ) = (
        app.try_state::<crate::verify::VerifyRegistry>(),
        app.try_state::<crate::kanban::KanbanStore>(),
        app.try_state::<crate::workspace::WorkspaceStore>(),
        app.try_state::<crate::agents::AgentRegistry>(),
        app.try_state::<crate::swarms::SwarmRegistry>(),
        app.try_state::<crate::card_execution::CardExecutionGate>(),
    ) else {
        return;
    };
    let req = crate::verify::VerifyRequest {
        workspace_id: workspace_id.to_string(),
        card_id: card_id.to_string(),
        // v1.58.0 (Phase 4): this is the post-swarm auto-verify — when it
        // finishes, post the card-outcome comment to the issue with the test
        // result. (Manual verify runs leave this false → no issue spam.)
        post_outcome_issue: true,
    };
    if let Err(e) = card_execution.enqueue_verify(
        app.clone(),
        &verify,
        &kanban,
        &workspaces,
        &agents,
        &swarms,
        req,
    ) {
        // The work side won the short authorization race. Preserve one
        // process-local, unpaid retry intent; the completing Agent/Swarm
        // calls retry_deferred_auto_verify after its live authority clears.
        verify.defer_auto_verify(workspace_id, card_id);
        log::warn!("auto-verify enqueue failed for card {card_id}: {e}");
    }
}

/// Work-completion wakeup for a post-swarm auto-verify that previously lost
/// the card-execution race. A failed retry re-inserts the bounded intent via
/// `maybe_autostart_verify`; a successful/manual verify clears it at enqueue.
pub(crate) fn retry_deferred_auto_verify(
    app: &tauri::AppHandle,
    workspace_id: &str,
    card_id: &str,
) {
    use tauri::Manager;
    let Some(verify) = app.try_state::<crate::verify::VerifyRegistry>() else {
        return;
    };
    if verify.take_deferred_auto_verify(workspace_id, card_id) {
        maybe_autostart_verify(app, workspace_id, card_id);
    }
}

fn on_swarm_run_done(app: &tauri::AppHandle, payload: SwarmListenerPayload) {
    use tauri::Manager;
    let Some(swarm_id) = payload.swarm_id.as_deref() else {
        return;
    };
    let Some(swarm_registry) = app.try_state::<SwarmRegistry>() else {
        return;
    };
    let Some(agent_registry) = app.try_state::<crate::agents::AgentRegistry>() else {
        return;
    };
    let Some(pty_registry) = app.try_state::<crate::pty::PtyRegistry>() else {
        return;
    };
    let Some(snapshots_store) = app.try_state::<crate::snapshots::SnapshotsStore>() else {
        return;
    };
    let Some(workspace_store) = app.try_state::<crate::workspace::WorkspaceStore>() else {
        return;
    };
    let Some(swarm_templates_store) =
        app.try_state::<crate::swarm_templates::SwarmTemplatesStore>()
    else {
        return;
    };

    // R3: idempotency — if the swarm is already terminal (user aborted, wall
    // time fired, ...), skip cleanly. apply_run_done has its own check too.
    let Some(swarm) = swarm_registry.get(swarm_id) else {
        return;
    };
    if swarm.status != SwarmStatus::Running {
        return;
    }

    // Load the run record (which now includes parsed swarm_artifact, set by
    // the post-exit hook in agents.rs) and build the FSM input.
    let Ok(run) = agent_registry.get_run(&payload.run_id) else {
        log::warn!("swarm listener: missing run record for {}", payload.run_id);
        return;
    };

    // v1.3.0 (P6): figure out the role for this completed run. For
    // coordinator-mode swarms in Dispatching state, we look up the role
    // via the matching RoleInstance (since one role can have multiple
    // legs in flight). For sequential / PendingCoordinator states, fall
    // back to derive_role_from_state.
    let (role, instance_id_for_outcome) = match (&swarm.state, &run.swarm_role_instance_id) {
        (SwarmState::Dispatching { instances, .. }, Some(inst_id)) => {
            let role = instances
                .iter()
                .find(|i| &i.id == inst_id)
                .map(|i| i.role.clone())
                .unwrap_or_else(|| {
                    log::warn!(
                        "swarm listener: Dispatching state has no instance '{inst_id}' to match run {}",
                        run.id
                    );
                    "unknown".to_string()
                });
            (role, Some(inst_id.clone()))
        }
        _ => {
            let r = match derive_role_from_state(&swarm.state) {
                Some(r) => r,
                None => return,
            };
            (r, run.swarm_role_instance_id.clone())
        }
    };

    let outcome = RunOutcome {
        run_id: run.id.clone(),
        role: role.clone(),
        status: match payload.status {
            crate::agents::AgentStatus::Done => STATUS_DONE,
            crate::agents::AgentStatus::Error => STATUS_ERROR,
            crate::agents::AgentStatus::Killed => STATUS_KILLED,
            // Pending/Running shouldn't reach this listener; treat as error.
            _ => STATUS_ERROR,
        }
        .into(),
        artifact: run.swarm_artifact.clone(),
        error_msg: run.error.clone(),
        role_instance_id: instance_id_for_outcome.clone(),
    };

    // v1.3.0 (P6): emit instance_done mailbox entry for fan-out leg
    // completions. The orchestrator does this here (not in apply_run_done)
    // because instance_done is a coordinator-mode concept; sequential
    // swarms get the existing `report` entry only.
    if let Some(inst_id) = &instance_id_for_outcome {
        let _ = swarm_registry.append_mailbox(&MailboxEntry {
            id: Uuid::new_v4().to_string(),
            ts: now_millis(),
            swarm_id: swarm_id.to_string(),
            kind: MailboxKind::InstanceDone,
            role: Some(role.clone()),
            run_id: Some(run.id.clone()),
            body: Some(serde_json::json!({
                "instanceId": inst_id,
                "status": &outcome.status,
                "runId": run.id,
            })),
            run_summary: None,
        });

        // v1.3.0 (P7): post-exit out-of-glob detection. The exit
        // listener (P5/P7 wiring) ran compute_changes_with_globs and
        // wrote a manifest with `swarm_collisions` set. If that count is
        // non-zero, surface a Collision mailbox entry per offending path
        // so the Swarm tab can flag the leg + the coordinator gets the
        // signal next tick. Best-effort read; manifest absence is a
        // logged warning, not a fatal.
        if let Ok(Some(manifest)) = snapshots_store.read_changes(&run.id) {
            if manifest.swarm_collisions > 0 {
                for change in manifest
                    .changes
                    .iter()
                    .filter(|c| c.out_of_owned_globs)
                {
                    let _ = swarm_registry.append_mailbox(&MailboxEntry {
                        id: Uuid::new_v4().to_string(),
                        ts: now_millis(),
                        swarm_id: swarm_id.to_string(),
                        kind: MailboxKind::Collision,
                        role: Some(role.clone()),
                        run_id: Some(run.id.clone()),
                        body: Some(serde_json::json!({
                            "kind": "write_outside_globs",
                            "instanceId": inst_id,
                            "path": change.path,
                            "changeKind": change.kind,
                        })),
                        run_summary: None,
                    });
                }
            }
        }
    }

    // v1.2.0: resolve template by id; fall back to "feature" when the
    // template_id is unknown (covers v1.0/v1.1's legacy "scout-build-review"
    // until T4 formalizes the redirect, plus stale references to a
    // user-template that's since been deleted).
    let template = match resolve_template_or_fallback(&swarm_templates_store, &swarm.template_id) {
        Some(t) => t,
        None => {
            log::warn!(
                "swarm orchestrator: no resolvable template for swarm {swarm_id} (template_id='{}')",
                swarm.template_id
            );
            let _ = swarm_registry.abort(swarm_id, "template not found");
            return;
        }
    };

    // v1.1.1 wall-time enforcement (per-transition check). If the swarm's
    // effective wall-clock has passed the template's max_wall_seconds,
    // override whatever the FSM would have decided with a TimedOut
    // terminate. The role's run already finished (we're in
    // on_swarm_run_done) so no PTY kill is needed here; the periodic
    // runtime tick handles the mid-role case.
    //
    // v1.2.0: per-template max_wall_seconds (was: global MAX_WALL_SECONDS).
    // v1.31.0: the wall-time cap only cancels work the swarm would CONTINUE
    // — see `apply_wall_time_cap`. Compute the FSM's natural decision first,
    // then let the cap override it only if it's an `Advance`.
    let now_ms = now_millis();
    let natural = next_fsm_state(&template, &swarm.state, swarm.iteration, &outcome);
    let transition =
        apply_wall_time_cap(natural, &swarm, now_ms, template.max_wall_seconds);
    let next_role = match &transition {
        FsmTransition::Advance { next_role, .. } => next_role.clone(),
        FsmTransition::Terminate { .. } => None,
    };

    let summary = build_run_summary(&swarm, &run);
    let updated = match swarm_registry.apply_run_done(
        swarm_id,
        transition,
        summary,
        run.swarm_artifact.clone(),
    ) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("swarm orchestrator: apply_run_done failed for {swarm_id}: {e}");
            return;
        }
    };

    // v1.5.x: append a single aggregated run_history entry to the
    // originating kanban card on the Running → terminal transition. The
    // R3 idempotency check at the top of this fn (early-return on
    // `swarm.status != Running`) means we land here at most once per
    // swarm. Best-effort: log-and-continue, never blocks the FSM.
    //
    // Suspended is paused-not-terminal — skip and let the eventual
    // resume → terminate fire the append.
    if updated.status != SwarmStatus::Running
        && updated.status != SwarmStatus::Suspended
    {
        append_kanban_history_for_swarm(app, &updated, swarm_id, &snapshots_store);
        // v1.30.0 (parallel swarms): a card swarm just reached a terminal
        // state and freed a slot — pump the queue so the next queued card
        // in this workspace auto-starts.
        if updated.kind == SwarmKind::Card {
            crate::kanban::pump_card_queue(app, &updated.workspace_id);
            // v1.31.0 (Cycle 1): if this terminal swarm was a
            // reject-with-feedback follow-up, its card's review_decisions
            // are now stale — clear them and reset review_status so the
            // reviewer re-reviews the fresh diff. No-op for any other
            // card swarm (clear_review_after_followup gates on
            // ChangesRequested).
            use tauri::Manager;
            if let Some(kanban) = app.try_state::<crate::kanban::KanbanStore>() {
                if let Some(card_id) =
                    kanban.card_id_for_linked_swarm(&updated.workspace_id, swarm_id)
                {
                    if let Err(e) =
                        kanban.clear_review_after_followup(&updated.workspace_id, &card_id)
                    {
                        log::warn!(
                            "swarm orchestrator: clear_review_after_followup: {e}"
                        );
                    }
                    // v1.31.0 (Outcome screen): on a clean finish, auto-run
                    // verify so the outcome screen has a checks result with
                    // no manual "Verify now" click.
                    let will_autoverify = updated.status == SwarmStatus::Done
                        && workspace_has_verify_pipeline(app, &updated.workspace_id);
                    if updated.status == SwarmStatus::Done {
                        maybe_autostart_verify(app, &updated.workspace_id, &card_id);
                    } else if let Some(verify) =
                        app.try_state::<crate::verify::VerifyRegistry>()
                    {
                        // A failed/aborted/timed-out Swarm must not leave a
                        // stale auto-verify intent that can fire after some
                        // unrelated later work on the same card.
                        let _ = verify.take_deferred_auto_verify(
                            &updated.workspace_id,
                            &card_id,
                        );
                    }
                    // v1.58.0 (Cycle 3 / Phase 4): post a card-outcome comment
                    // to the backing GitHub issue. When a verify pipeline will
                    // run (Done + pipeline configured), defer to the verify
                    // completion path so the comment carries the test result;
                    // otherwise (any non-Done terminal, or Done with no
                    // pipeline) post immediately with no verify line.
                    if !will_autoverify {
                        crate::github_sync::post_card_outcome_comment(
                            app,
                            &updated.workspace_id,
                            &card_id,
                            swarm_status_label(updated.status),
                            None,
                        );
                    }
                }
            }
        }
    }

    // If the FSM said Advance, fire the next role.
    if let Some(next_role) = next_role {
        let next_agent_id = match updated.role_bindings.get(&next_role) {
            Some(a) => a.clone(),
            None => {
                log::warn!(
                    "swarm orchestrator: no role binding for '{next_role}' in swarm {swarm_id}"
                );
                let _ = swarm_registry.abort(
                    swarm_id,
                    &format!("no role binding for '{next_role}'"),
                );
                return;
            }
        };

        // Resolve cwd for handoff and start_run. v1.31.0 (Cycle 1): prefer
        // the swarm's persisted cwd (the per-card worktree) so later legs
        // run where leg 1 did, not in the raw workspace checkout.
        let cwd = if !updated.cwd.is_empty() {
            std::path::PathBuf::from(&updated.cwd)
        } else {
            match workspace_store
                .snapshot()
                .workspaces
                .iter()
                .find(|w| w.id == updated.workspace_id)
            {
                Some(w) => std::path::PathBuf::from(&w.cwd),
                None => {
                    let _ = swarm_registry.abort(
                        swarm_id,
                        &format!("workspace '{}' not found", updated.workspace_id),
                    );
                    return;
                }
            }
        };

        // Build handoff payload from prior steps. v1.0 includes every prior
        // run in run_ids order — redundant for non-loopback transitions but
        // correct, and within context-window budget at max_iter=3.
        let prior_owned = load_prior_steps(&updated, &agent_registry, &snapshots_store);
        let prior: Vec<PriorStep<'_>> = prior_owned
            .iter()
            .map(|p| PriorStep {
                role: &p.role,
                transcript: &p.transcript,
                changes: &p.changes,
                artifact: p.artifact.as_ref(),
            })
            .collect();
        // The artifact-path template uses RUN_ID_PLACEHOLDER which start_run
        // substitutes after generating the real run id. Only include for
        // roles whose step has `expects_artifact = true`. v1.2.0: read this
        // off `template.steps[next_idx]` rather than hardcoding "builder is
        // the only no-artifact role"; refactorer also produces no artifact
        // and any future user-defined no-artifact role gets the same
        // treatment automatically.
        let next_expects_artifact = match &updated.state {
            SwarmState::PendingStep { idx, .. } => template
                .steps
                .get(*idx as usize)
                .map(|s| s.expects_artifact)
                .unwrap_or(false),
            _ => false,
        };
        // v1.21.0 (Phase 3): dispatch through the next step's configured
        // provider. None means claude (the v1.x default), or Codex on a Codex-only machine (OB-14).
        let next_step_provider: Option<String> = match &updated.state {
            SwarmState::PendingStep { idx, .. } => template
                .steps
                .get(*idx as usize)
                .and_then(|s| s.provider.clone()),
            _ => None,
        };
        let artifact_template = if next_expects_artifact {
            Some(format!(
                "{}/.atelier/swarm/{}/artifact.json",
                cwd.display(),
                RUN_ID_PLACEHOLDER
            ))
        } else {
            None
        };
        let prompt = build_handoff_payload(
            &updated.goal,
            &prior,
            artifact_template.as_deref(),
        );

        let _ = swarm_registry.append_mailbox(&MailboxEntry {
            id: Uuid::new_v4().to_string(),
            ts: now_millis(),
            swarm_id: swarm_id.to_string(),
            kind: MailboxKind::Dispatch,
            role: Some(next_role.clone()),
            run_id: None,
            body: Some(serde_json::json!({ "agentId": next_agent_id })),
            run_summary: None,
        });

        swarm_registry.fire_role_boundary_notification(&updated, &role, &next_role);

        let queued_request = QueuedSwarmWriter {
            swarm_id: swarm_id.to_string(),
            agent_id: next_agent_id.clone(),
            workspace_id: updated.workspace_id.clone(),
            cwd: cwd.clone(),
            prompt: prompt.clone(),
            role_instance_id: None,
            owned_globs: Vec::new(),
            provider: next_step_provider.clone(),
            continuation: QueuedSwarmContinuation::RecordRun,
            expected_run_count: updated.run_ids.len(),
        };
        match agent_registry.start_run(
            app.clone(),
            &pty_registry,
            &next_agent_id,
            crate::agents::AgentScope::Workspace,
            &updated.workspace_id,
            cwd,
            Some(prompt),
            crate::agents::AgentTrigger::Swarm,
            Some(swarm_id.to_string()),
            // v1.3 P2: sequential transition; P6 will populate this when
            // the FSM moves into Dispatching.
            None,
            Vec::new(),
            next_step_provider.as_deref(),
        ) {
            Ok(next_run) => {
                let _ = swarm_registry.record_run_started(swarm_id, &next_run.id);
            }
            Err(e) if crate::coordination::decode_writer_busy(&e).is_some() => {
                if let Err(queue_error) = enqueue_swarm_writer(app, queued_request) {
                    log::warn!(
                        "swarm orchestrator: could not queue role '{next_role}': {queue_error}"
                    );
                    let _ = swarm_registry.abort(
                        swarm_id,
                        &format!("{next_role}: queue unavailable: {queue_error}"),
                    );
                }
            }
            Err(e) => {
                log::warn!(
                    "swarm orchestrator: start_run failed for role '{next_role}': {e}"
                );
                let _ = swarm_registry.abort(swarm_id, &format!("{next_role}: {e}"));
            }
        }
    }

    // v1.3.0 (P6): coordinator-mode post-transition handling. The FSM
    // sets `next_role: None` for Advance-into-Dispatching transitions
    // (initial fan-out and intermediate updates). The orchestrator does
    // the actual fan-out here based on the new state.
    // v1.31.0 (Cycle 1): coordinator fan-out in the swarm's persisted cwd.
    let cwd_for_coord: Option<std::path::PathBuf> = if !updated.cwd.is_empty() {
        Some(std::path::PathBuf::from(&updated.cwd))
    } else {
        workspace_store
            .snapshot()
            .workspaces
            .iter()
            .find(|w| w.id == updated.workspace_id)
            .map(|w| std::path::PathBuf::from(&w.cwd))
    };
    if let Some(cwd) = cwd_for_coord {
        match &updated.state {
            SwarmState::Dispatching { instances, .. } => {
                // v1.3.0 (P7): coordinator-time glob-overlap check.
                // For instances still Pending, scan for pairs whose
                // owner_globs overlap. Any colliding pair gets one or
                // both legs marked Failed + a Collision mailbox entry.
                // Marking failed makes "all instances terminal" possible
                // sooner so the FSM advances to PendingCoordinator(tick+1)
                // and the coordinator gets a chance to re-plan with
                // disjoint scopes. Failing the LATER instance keeps the
                // earlier one running — minimal disruption.
                let pending_only: Vec<RoleInstance> = instances
                    .iter()
                    .filter(|i| matches!(i.status, InstanceStatus::Pending))
                    .cloned()
                    .collect();
                let collisions = detect_glob_collisions(&pending_only);
                for (a, b) in &collisions {
                    let _ = swarm_registry.append_mailbox(&MailboxEntry {
                        id: Uuid::new_v4().to_string(),
                        ts: now_millis(),
                        swarm_id: swarm_id.to_string(),
                        kind: MailboxKind::Collision,
                        role: None,
                        run_id: None,
                        body: Some(serde_json::json!({
                            "kind": "overlap_with",
                            "instanceA": a,
                            "instanceB": b,
                        })),
                        run_summary: None,
                    });
                    // Fail the later (lexicographically larger) leg.
                    let _ = mark_instance_failed(
                        &swarm_registry,
                        swarm_id,
                        b,
                        &format!("owner_globs overlap with '{a}'"),
                    );
                }

                // Re-fetch the swarm so ready_instances sees the post-
                // collision state.
                let updated_after_collisions = swarm_registry
                    .get(swarm_id)
                    .unwrap_or_else(|| updated.clone());
                let ready = match &updated_after_collisions.state {
                    SwarmState::Dispatching { instances, .. } => ready_instances(instances),
                    _ => Vec::new(),
                };
                if !ready.is_empty() {
                    if let Err(e) =
                        dispatch_fan_out(app, swarm_id, &updated.goal, &cwd, &ready, Some(&template))
                    {
                        log::warn!(
                            "swarm orchestrator: dispatch_fan_out failed for {swarm_id}: {e}"
                        );
                    }
                }
                // No ready instances → still waiting on barriers. Some
                // legs are running; their completions will re-enter this
                // path until all done.
            }
            SwarmState::PendingCoordinator { tick } => {
                // Fire the coordinator for tick N+1 with handoff carrying
                // the prior tick's instance results. The "previous"
                // instances live on the just-departed Dispatching state;
                // we read them from the run record's swarm_artifact list
                // by walking the swarm's run_ids since the prior coord
                // run is too noisy for one tick. For v1.3 P6 minimum,
                // pass an empty prior_instances list — the coordinator's
                // mailbox view + its own run history is sufficient
                // context (the system prompt instructs reading the
                // mailbox). v1.3.x can enrich this if calibration shows
                // the coordinator needs more handoff scaffolding.
                let coord_agent_id = match updated.role_bindings.get("coordinator") {
                    Some(a) => a.clone(),
                    None => {
                        log::warn!(
                            "swarm orchestrator: no coordinator binding in {swarm_id}"
                        );
                        let _ = swarm_registry.abort(
                            swarm_id,
                            "no role binding for 'coordinator'",
                        );
                        return;
                    }
                };
                let _ = swarm_registry.append_mailbox(&MailboxEntry {
                    id: Uuid::new_v4().to_string(),
                    ts: now_millis(),
                    swarm_id: swarm_id.to_string(),
                    kind: MailboxKind::CoordinatorTick,
                    role: Some("coordinator".into()),
                    run_id: None,
                    body: Some(serde_json::json!({
                        "tick": tick,
                        "agentId": coord_agent_id,
                    })),
                    run_summary: None,
                });
                let prompt = build_coordinator_handoff(&updated.goal, &template, *tick, &[]);
                let prompt = format!(
                    "{prompt}\n\n## Artifact path\n\nWrite your dispatch artifact to: {}/.atelier/swarm/{}/artifact.json\n",
                    cwd.display(),
                    RUN_ID_PLACEHOLDER
                );
                let queued_request = QueuedSwarmWriter {
                    swarm_id: swarm_id.to_string(),
                    agent_id: coord_agent_id.clone(),
                    workspace_id: updated.workspace_id.clone(),
                    cwd: cwd.clone(),
                    prompt: prompt.clone(),
                    role_instance_id: None,
                    owned_globs: Vec::new(),
                    provider: None,
                    continuation: QueuedSwarmContinuation::RecordRun,
                    expected_run_count: updated.run_ids.len(),
                };
                match agent_registry.start_run(
                    app.clone(),
                    &pty_registry,
                    &coord_agent_id,
                    crate::agents::AgentScope::Workspace,
                    &updated.workspace_id,
                    cwd,
                    Some(prompt),
                    crate::agents::AgentTrigger::Swarm,
                    Some(swarm_id.to_string()),
                    None,
                    Vec::new(),
                    // v1.21.0 (Phase 3): coordinator role has no provider
                    // (not in template.steps, where provider lives): None is
                    // Claude where installed, else Codex (OB-14,
                    // `agents::swarm_step_provider`).
                    None,
                ) {
                    Ok(coord_run) => {
                        let _ = swarm_registry
                            .record_run_started(swarm_id, &coord_run.id);
                    }
                    Err(e) if crate::coordination::decode_writer_busy(&e).is_some() => {
                        if let Err(queue_error) =
                            enqueue_swarm_writer(app, queued_request)
                        {
                            log::warn!(
                                "swarm orchestrator: could not queue coordinator for {swarm_id}: {queue_error}"
                            );
                            let _ = swarm_registry.abort(
                                swarm_id,
                                &format!("coordinator queue unavailable: {queue_error}"),
                            );
                        }
                    }
                    Err(e) => {
                        log::warn!(
                            "swarm orchestrator: coordinator start_run failed for {swarm_id}: {e}"
                        );
                        let _ = swarm_registry
                            .abort(swarm_id, &format!("coordinator: {e}"));
                    }
                }
            }
            _ => {}
        }
    }
    // Terminate case: notification + UI updates land in S9.
}

/// v1.5.x: append one aggregated `RunHistoryEntry` to the kanban card
/// linked to this swarm, summarizing every leg's `changes.json`. Called
/// once per Running → terminal transition from `on_swarm_run_done`.
/// Best-effort: every failure path logs and continues.
fn append_kanban_history_for_swarm(
    app: &tauri::AppHandle,
    swarm: &Swarm,
    swarm_id: &str,
    snapshots_store: &crate::snapshots::SnapshotsStore,
) {
    use tauri::Manager;
    let Some(kanban_store) = app.try_state::<crate::kanban::KanbanStore>() else {
        return;
    };
    let Some(card_id) =
        kanban_store.card_id_for_linked_swarm(&swarm.workspace_id, swarm_id)
    else {
        // Swarm wasn't started from a kanban card (manual swarm_start IPC).
        return;
    };

    // Aggregate manifests across legs. Use a BTreeSet so the path list is
    // lex-sorted and deduplicated for the take(10) cap below.
    let mut total_changes: u32 = 0;
    let mut total_collisions: u32 = 0;
    let mut path_set: std::collections::BTreeSet<String> =
        std::collections::BTreeSet::new();
    for run_id in &swarm.run_ids {
        if let Ok(Some(manifest)) = snapshots_store.read_changes(run_id) {
            total_changes = total_changes.saturating_add(manifest.changes.len() as u32);
            total_collisions =
                total_collisions.saturating_add(manifest.swarm_collisions);
            for change in &manifest.changes {
                path_set.insert(change.path.clone());
            }
        }
    }
    let top_paths: Vec<String> = path_set.into_iter().take(10).collect();

    // Map swarm-terminal status into the AgentStatus enum the receipt uses.
    // Kept coarse on purpose (Done/Error); precise swarm status lives in
    // the Swarm tab's mailbox view.
    let status = match swarm.status {
        SwarmStatus::Done => crate::agents::AgentStatus::Done,
        SwarmStatus::Aborted => crate::agents::AgentStatus::Killed,
        SwarmStatus::Failed
        | SwarmStatus::MaxIter
        | SwarmStatus::TimedOut => crate::agents::AgentStatus::Error,
        SwarmStatus::Suspended | SwarmStatus::Running => {
            // Filtered out at the call site, but be defensive.
            return;
        }
    };

    let entry = crate::kanban::RunHistoryEntry {
        // Use the swarm_id as the entry's run_id so it's distinct from any
        // leg's run_id (legs already have their own per-leg snapshots
        // accessible via the Swarm tab) and idempotent on repeated fires.
        run_id: swarm_id.to_string(),
        status,
        ended_at: swarm.ended_at.unwrap_or_else(now_millis),
        files_changed_count: total_changes,
        top_paths,
        swarm_id: Some(swarm_id.to_string()),
        swarm_template_id: Some(swarm.template_id.clone()),
        swarm_collisions: total_collisions,
        agent_config_id: None,
        legs: swarm.run_ids.len() as u32,
    };

    if let Err(e) =
        kanban_store.append_run_history(&swarm.workspace_id, &card_id, entry)
    {
        log::warn!(
            "kanban append_run_history failed for swarm {swarm_id}: {e}"
        );
    }
    // v1.33.0: the card's run_history changed — refresh open kanban views.
    crate::kanban::emit_kanban_changed(app, &swarm.workspace_id);
}

/// v1.5.0 (S2): walk each workspace's `.atelier/swarm/` directory and
/// delete per-run artifact subdirectories whose `mtime` is older than
/// `retention_days` AND whose `runId` is NOT in `protected_run_ids`.
/// Returns the count of removed dirs. Called once at app startup
/// alongside `agent_registry.prune_runs`.
///
/// Protection: a runId belongs to a Running or Suspended swarm
/// (Running's PTY needs the artifact path; Suspended's resume rebuilds
/// handoff payloads from prior runs' transcripts/artifacts). The lib.rs
/// caller builds `protected_run_ids` by flattening every Running/
/// Suspended swarm's `run_ids` field.
///
/// Best-effort: I/O failures (unreadable dir, permission denied,
/// removed-by-someone-else races) are logged and skipped — never fatal.
pub fn prune_stale_swarm_artifact_dirs(
    workspace_cwds: &[std::path::PathBuf],
    retention_days: Option<u32>,
    protected_run_ids: &std::collections::HashSet<String>,
) -> usize {
    let Some(days) = retention_days else {
        return 0;
    };
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(
            days as u64 * 24 * 60 * 60,
        ))
        .unwrap_or(std::time::UNIX_EPOCH);
    let mut deleted = 0usize;
    for cwd in workspace_cwds {
        let swarm_root = cwd.join(".atelier").join("swarm");
        if !swarm_root.is_dir() {
            continue;
        }
        let entries = match fs::read_dir(&swarm_root) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let path = entry.path();
            let run_id = match path.file_name().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            if protected_run_ids.contains(&run_id) {
                continue;
            }
            // Use the directory's own mtime — captures the last write
            // (e.g. the artifact.json post-exit hook). Fall back to
            // metadata's modified() then created() then skip on error.
            let modified = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .unwrap_or(std::time::UNIX_EPOCH);
            if modified > cutoff {
                continue;
            }
            match fs::remove_dir_all(&path) {
                Ok(_) => {
                    deleted += 1;
                }
                Err(e) => {
                    log::warn!(
                        "swarm-artifact reaper: remove {} failed: {e}",
                        path.display()
                    );
                }
            }
        }
    }
    if deleted > 0 {
        log::info!("swarm-artifact reaper: removed {deleted} stale dir(s)");
    }
    deleted
}

/// v1.1.1: swarm-side companion to the agents runtime tick (the scheduler
/// tick until GH #171 retired scheduled agents). Walks all
/// `Running` swarms; for any whose effective wall-clock has exceeded
/// `MAX_WALL_SECONDS`, kills the in-flight PTY (so the role's `claude`
/// subprocess actually stops) and flips the swarm to `TimedOut`. Mirrors
/// the `swarm_abort` IPC handler's "kill PTY first, then flip status"
/// ordering. Best-effort: PTY-kill failures are logged and the swarm is
/// still flipped — the `TimedOut` mailbox entry is the source of truth.
///
/// Called from `agents::runtime_tick` once per `RUNTIME_TICK_SECS`
/// (30s). The per-transition check inside `on_swarm_run_done` covers the
/// case where the role finishes naturally just past the cutoff; this tick
/// covers the case where a single role runs away for hours.
pub fn tick_wall_time<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    let Some(swarm_registry) = app.try_state::<SwarmRegistry>() else {
        return;
    };
    let Some(agent_registry) = app.try_state::<crate::agents::AgentRegistry>() else {
        return;
    };
    let Some(pty_registry) = app.try_state::<crate::pty::PtyRegistry>() else {
        return;
    };
    for (swarm_id, in_flight_run_id) in swarm_registry.wall_time_exceeded_swarms() {
        if let Some(run_id) = in_flight_run_id {
            if let Err(e) = agent_registry.kill_run(&run_id, &pty_registry) {
                log::warn!(
                    "swarm wall-time tick: kill_run({run_id}) failed for swarm {swarm_id}: {e}"
                );
            }
        }
        if let Err(e) = swarm_registry.time_out_for_wall_time(&swarm_id) {
            log::warn!("swarm wall-time tick: time_out failed for {swarm_id}: {e}");
        } else {
            log::info!("swarm wall-time tick: timed out swarm {swarm_id}");
        }
    }
}

// ── Registry-level integration test (no Tauri runtime) ──

// Its fake claude is a `/bin/sh` script run directly: unix only.
#[cfg(all(test, unix))]
mod integration {
    //! Exercises `apply_run_done` end-to-end across the three roles using
    //! real (not synthesized) artifact JSON written by a fake-claude
    //! subprocess. Skips the Tauri event hop — that requires `start_run` and
    //! `start_swarm_listener` to be runtime-generic, a meaningful refactor
    //! deferred to v1.1+. What this DOES cover:
    //!
    //! - The post-exit artifact-read helper (`agents::read_swarm_artifact`)
    //!   with real on-disk JSON written by an external process
    //! - FSM happy-path scout → build → review with real `RunOutcome`s
    //! - Mailbox writes and terminal-state idempotency
    //! - The artifact-path templating contract (build_handoff_payload +
    //!   RUN_ID_PLACEHOLDER substitution)
    //!
    //! What it does NOT cover (deferred to manual Tier 4):
    //! - `start_run` actually firing the subprocess
    //! - `agent://run-done` event propagation
    //! - `start_swarm_listener` dispatch
    //! - Real claude subprocess invocation

    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    /// v1.2.0 test helper: the `feature` builtin template (FSM-equivalent
    /// to v1.0/v1.1's hardcoded scout-build-review chain). Makes the
    /// `next_fsm_state` calls in this module concise.
    fn feature_template() -> crate::swarm_templates::SwarmTemplate {
        crate::swarm_templates::builtin_templates()
            .into_iter()
            .find(|t| t.id == "feature")
            .expect("feature builtin")
    }

    /// Fake claude as a shell script. Reads `-p <prompt>`, parses the
    /// "Artifact path" line out, writes either a plan (scout) or verdict
    /// (reviewer) JSON. Detection keys on "Previous step: builder" being
    /// present in the prompt → it's the reviewer's turn.
    const FAKE_CLAUDE: &str = r##"#!/bin/sh
prompt=""
while [ $# -gt 0 ]; do
    case "$1" in
        -p) prompt="$2"; shift 2 ;;
        --append-system-prompt) shift 2 ;;
        *) shift ;;
    esac
done
artifact_path=$(printf '%s\n' "$prompt" | grep -A 2 "Artifact path" | tail -n 1 | sed 's/^[[:space:]]*//')
if [ -n "$artifact_path" ] && [ "${artifact_path#/}" != "$artifact_path" ]; then
    mkdir -p "$(dirname "$artifact_path")"
    if printf '%s' "$prompt" | grep -q "Previous step: builder"; then
        echo '{"verdict":"approve","critique":"lgtm"}' > "$artifact_path"
    else
        echo '{"plan":"do the thing","files_to_modify":[],"rationale":"ok"}' > "$artifact_path"
    fi
fi
"##;

    fn write_fake_claude(dir: &std::path::Path) -> std::path::PathBuf {
        let path = dir.join("fake-claude.sh");
        fs::write(&path, FAKE_CLAUDE).unwrap();
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).unwrap();
        path
    }

    /// Driver: invoke fake claude with the given prompt and the run_id
    /// substituted into the placeholder, mimicking what `start_run` does.
    fn run_fake_claude(claude: &std::path::Path, prompt_with_placeholder: &str, run_id: &str) {
        let prompt = prompt_with_placeholder.replace(RUN_ID_PLACEHOLDER, run_id);
        let status = crate::platform::new_command(claude)
            .arg("-p")
            .arg(&prompt)
            .arg("--output-format")
            .arg("stream-json")
            .arg("--verbose")
            .status()
            .expect("fake claude spawn");
        assert!(status.success(), "fake claude exited non-zero");
    }

    /// Walks the full happy path one role at a time:
    /// 1. Build handoff payload (with placeholder)
    /// 2. Pretend `start_run` would have generated a run_id, substitute it
    /// 3. Spawn fake claude → it writes artifact.json
    /// 4. Read artifact via the post-exit helper
    /// 5. Build RunOutcome → call FSM → call apply_run_done
    /// Final state must be Done.
    #[test]
    fn integration_happy_path_round_trips_artifact_and_terminates_done() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().join("ws-cwd");
        let config_dir = tmp.path().join("config");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(&config_dir).unwrap();
        let claude = write_fake_claude(tmp.path());

        let reg = SwarmRegistry::new(config_dir.clone()).unwrap();
        let mut bindings = HashMap::new();
        bindings.insert("scout".into(), "scout-agent".into());
        bindings.insert("builder".into(), "builder-agent".into());
        bindings.insert("reviewer".into(), "reviewer-agent".into());
        let swarm = reg
            .swarm_start("ws-1", "scout-build-review", "fix the bug", &cwd, bindings, "scout", SwarmKind::Adhoc)
            .unwrap();

        // ── Scout turn ───────────────────────────────
        let scout_run_id = "scout-run-1";
        let scout_prompt = build_handoff_payload(
            &swarm.goal,
            &[],
            Some(&format!(
                "{}/.atelier/swarm/{}/artifact.json",
                cwd.display(),
                RUN_ID_PLACEHOLDER
            )),
        );
        run_fake_claude(&claude, &scout_prompt, scout_run_id);
        let scout_artifact = crate::agents::read_swarm_artifact(&cwd, scout_run_id);
        assert!(
            scout_artifact.is_some(),
            "scout wrote artifact at the templated path"
        );
        // FSM transitions PendingScout → PendingBuild.
        let outcome = RunOutcome {
            run_id: scout_run_id.into(),
            role: "scout".into(),
            status: STATUS_DONE.into(),
            artifact: scout_artifact.clone(),
            error_msg: None,
            role_instance_id: None,
        };
        let transition = next_fsm_state(&feature_template(), &swarm.state, swarm.iteration, &outcome);
        let summary = RunSummary {
            run_id: scout_run_id.into(),
            role: "scout".into(),
            status: STATUS_DONE.into(),
            started_at: 1,
            ended_at: Some(2),
            exit_code: Some(0),
            bytes_written: 100,
            model: Some("fake".into()),
            total_cost_usd: Some(0.001),
            files_changed_count: Some(0),
            throttled: false,
        };
        reg.record_run_started(&swarm.id, scout_run_id).unwrap();
        let after_scout = reg
            .apply_run_done(&swarm.id, transition, summary, scout_artifact)
            .unwrap();
        assert_eq!(after_scout.status, SwarmStatus::Running);
        assert!(matches!(after_scout.state, SwarmState::PendingStep { idx: 1, .. }));

        // ── Builder turn ─────────────────────────────
        // Builder gets no artifact-path template (its output is the diff itself).
        let build_run_id = "build-run-1";
        let outcome = RunOutcome {
            run_id: build_run_id.into(),
            role: "builder".into(),
            status: STATUS_DONE.into(),
            artifact: None,
            error_msg: None,
            role_instance_id: None,
        };
        let transition = next_fsm_state(&feature_template(), &after_scout.state, after_scout.iteration, &outcome);
        let summary = RunSummary {
            run_id: build_run_id.into(),
            role: "builder".into(),
            status: STATUS_DONE.into(),
            started_at: 3,
            ended_at: Some(4),
            exit_code: Some(0),
            bytes_written: 200,
            model: Some("fake".into()),
            total_cost_usd: Some(0.002),
            files_changed_count: Some(2),
            throttled: false,
        };
        reg.record_run_started(&swarm.id, build_run_id).unwrap();
        let after_build = reg
            .apply_run_done(&swarm.id, transition, summary, None)
            .unwrap();
        assert_eq!(after_build.status, SwarmStatus::Running);
        assert!(matches!(after_build.state, SwarmState::PendingStep { idx: 2, .. }));

        // ── Reviewer turn ────────────────────────────
        let review_run_id = "review-run-1";
        // Build a realistic reviewer prompt — must include "Previous step: builder"
        // so fake claude detects the role and writes the verdict.
        let scout_step = PriorStep {
            role: "scout",
            transcript: "scouted",
            changes: &[],
            artifact: None,
        };
        let build_step = PriorStep {
            role: "builder",
            transcript: "built",
            changes: &[],
            artifact: None,
        };
        let review_prompt = build_handoff_payload(
            &swarm.goal,
            &[scout_step, build_step],
            Some(&format!(
                "{}/.atelier/swarm/{}/artifact.json",
                cwd.display(),
                RUN_ID_PLACEHOLDER
            )),
        );
        run_fake_claude(&claude, &review_prompt, review_run_id);
        let review_artifact = crate::agents::read_swarm_artifact(&cwd, review_run_id);
        assert_eq!(
            review_artifact.as_ref().and_then(|v| v.get("verdict")).and_then(|v| v.as_str()),
            Some("approve"),
            "reviewer's fake-claude path produced the approve verdict",
        );
        let outcome = RunOutcome {
            run_id: review_run_id.into(),
            role: "reviewer".into(),
            status: STATUS_DONE.into(),
            artifact: review_artifact.clone(),
            error_msg: None,
            role_instance_id: None,
        };
        let transition = next_fsm_state(&feature_template(), &after_build.state, after_build.iteration, &outcome);
        let summary = RunSummary {
            run_id: review_run_id.into(),
            role: "reviewer".into(),
            status: STATUS_DONE.into(),
            started_at: 5,
            ended_at: Some(6),
            exit_code: Some(0),
            bytes_written: 150,
            model: Some("fake".into()),
            total_cost_usd: Some(0.0015),
            files_changed_count: Some(0),
            throttled: false,
        };
        reg.record_run_started(&swarm.id, review_run_id).unwrap();
        let final_swarm = reg
            .apply_run_done(&swarm.id, transition, summary, review_artifact)
            .unwrap();

        // ── Final assertions ─────────────────────────
        assert_eq!(final_swarm.status, SwarmStatus::Done);
        assert_eq!(final_swarm.state, SwarmState::Done);
        assert_eq!(
            final_swarm.end_reason.as_deref(),
            Some("approved by reviewer")
        );
        assert_eq!(final_swarm.run_ids.len(), 3);
        let mailbox = reg.read_mailbox(&swarm.id, 0).unwrap();
        // created + 3 reports + scout artifact + reviewer artifact + terminate.
        assert!(
            mailbox
                .iter()
                .filter(|e| e.kind == MailboxKind::Report)
                .count()
                == 3
        );
        assert!(mailbox
            .iter()
            .any(|e| e.kind == MailboxKind::Terminate));
    }
}

// ── tests ──────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn fresh_registry() -> (tempfile::TempDir, SwarmRegistry) {
        let tmp = tempdir().unwrap();
        let reg = SwarmRegistry::new(tmp.path().to_path_buf()).unwrap();
        (tmp, reg)
    }

    /// v1.2.0 test helper: builds a `PendingStep` with role and prior_run_ids.
    /// Replaces the v1.0/v1.1 idiom of writing
    /// `SwarmState::PendingScout` / `PendingBuild { scout_run_id }` /
    /// `PendingReview { scout_run_id, build_run_id }` literals throughout
    /// the test suite.
    fn pending_step(idx: u32, role: &str, prior_run_ids: &[&str]) -> SwarmState {
        SwarmState::PendingStep {
            idx,
            role: role.into(),
            prior_run_ids: prior_run_ids.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// v1.2.0 test helper: returns the `feature` builtin template
    /// (FSM-equivalent to v1.0/v1.1's hardcoded scout-build-review chain).
    fn feature_template() -> crate::swarm_templates::SwarmTemplate {
        crate::swarm_templates::builtin_templates()
            .into_iter()
            .find(|t| t.id == "feature")
            .expect("feature builtin")
    }

    #[test]
    fn swarm_start_creates_persisted_record_and_mailbox_entry() {
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();

        let s = reg
            .swarm_start("ws-1", "scout-build-review", "fix the bug", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc)
            .expect("start");
        assert_eq!(s.status, SwarmStatus::Running);
        assert_eq!(s.state, pending_step(0, "scout", &[]));
        assert_eq!(s.workspace_id, "ws-1");

        // v1.31.0 (Cycle 1): the swarm persists its effective cwd so later
        // legs fire in the same directory as the first — not a re-resolved
        // `workspace.cwd`. Without this the builder/reviewer of a card
        // swarm silently ran in the main checkout.
        assert_eq!(s.cwd, cwd.to_string_lossy());

        // state.json is on disk and round-trips.
        let reg2 = SwarmRegistry::new(tmp.path().to_path_buf()).unwrap();
        let reloaded = reg2.get(&s.id).expect("reload");
        assert_eq!(reloaded.id, s.id);
        assert_eq!(reloaded.goal, "fix the bug");
        assert_eq!(reloaded.cwd, cwd.to_string_lossy());

        // mailbox has the `created` entry.
        let mailbox = reg.read_mailbox(&s.id, 0).unwrap();
        assert_eq!(mailbox.len(), 1);
        assert_eq!(mailbox[0].kind, MailboxKind::Created);
    }

    #[test]
    fn swarm_start_rejects_when_another_running_in_workspace() {
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        reg.swarm_start("ws-A", "scout-build-review", "first", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc)
            .expect("first start");
        let err = reg
            .swarm_start("ws-A", "scout-build-review", "second", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc)
            .expect_err("second should reject");
        assert!(err.contains("already running"), "got: {err}");
        // Different workspace is allowed concurrently.
        reg.swarm_start("ws-B", "scout-build-review", "ok", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc)
            .expect("different workspace allowed");
    }

    #[test]
    fn swarm_start_rejects_when_cwd_missing() {
        let (tmp, reg) = fresh_registry();
        let bogus = tmp.path().join("does-not-exist");
        let err = reg
            .swarm_start("ws-1", "scout-build-review", "x", &bogus, HashMap::new(), "scout", SwarmKind::Adhoc)
            .expect_err("should reject");
        assert!(err.contains("not accessible"), "got: {err}");
    }

    #[test]
    fn swarm_start_rejects_when_suspended_in_workspace() {
        // R7 (resumable swarms): the user must Resume or Abort the
        // suspended swarm before starting a fresh one in the same
        // workspace. Forces an explicit decision on the suspended work
        // rather than silently abandoning it.
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        reg.swarm_start("ws-A", "scout-build-review", "first", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc)
            .expect("first start");
        // Cmd-Q the swarm: Running -> Suspended.
        reg.kill_all();

        let err = reg
            .swarm_start("ws-A", "scout-build-review", "second", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc)
            .expect_err("second should reject — suspended swarm exists");
        assert!(
            err.contains("suspended swarm"),
            "expected 'suspended swarm' in error, got: {err}"
        );

        // Different workspace is allowed concurrently — the lock is
        // per-workspace, not global.
        reg.swarm_start("ws-B", "scout-build-review", "ok", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc)
            .expect("different workspace allowed");
    }

    // ── v1.30.0 parallel swarms: kind-aware gate matrix ──────────

    /// Card swarms parallelize up to the cap. With the default cap 3, three
    /// card swarms start in one workspace; the fourth is rejected.
    #[test]
    fn card_swarms_parallelize_up_to_cap() {
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        for i in 0..3 {
            reg.swarm_start(
                "ws-A", "scout-build-review", &format!("card {i}"), &cwd,
                HashMap::new(), "scout", SwarmKind::Card,
            )
            .unwrap_or_else(|e| panic!("card swarm {i} should start: {e}"));
        }
        let err = reg
            .swarm_start(
                "ws-A", "scout-build-review", "card 4", &cwd,
                HashMap::new(), "scout", SwarmKind::Card,
            )
            .expect_err("4th card swarm should be rejected at cap 3");
        assert!(err.contains("limit 3"), "got: {err}");
    }

    /// The cap is configurable: at cap 1, card swarms behave like the
    /// pre-v1.30 one-at-a-time gate.
    #[test]
    fn card_swarm_cap_of_one_reproduces_legacy_gate() {
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        reg.set_card_swarm_cap(1);
        reg.swarm_start(
            "ws-A", "scout-build-review", "first", &cwd,
            HashMap::new(), "scout", SwarmKind::Card,
        )
        .expect("first card swarm starts");
        let err = reg
            .swarm_start(
                "ws-A", "scout-build-review", "second", &cwd,
                HashMap::new(), "scout", SwarmKind::Card,
            )
            .expect_err("second rejected at cap 1");
        assert!(err.contains("limit 1"), "got: {err}");
    }

    /// `set_card_swarm_cap` clamps out-of-range values: 0 → 1, huge → 20.
    #[test]
    fn set_card_swarm_cap_clamps() {
        let (_tmp, reg) = fresh_registry();
        reg.set_card_swarm_cap(0);
        assert_eq!(reg.card_swarm_cap(), 1);
        reg.set_card_swarm_cap(999);
        assert_eq!(reg.card_swarm_cap(), 20);
        reg.set_card_swarm_cap(4);
        assert_eq!(reg.card_swarm_cap(), 4);
    }

    /// A card swarm and a brainstorm coexist — a running card swarm (in its
    /// worktree) does not block a non-card swarm (in the raw cwd).
    #[test]
    fn card_swarm_and_brainstorm_coexist() {
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        reg.swarm_start(
            "ws-A", "scout-build-review", "card work", &cwd,
            HashMap::new(), "scout", SwarmKind::Card,
        )
        .expect("card swarm starts");
        reg.swarm_start(
            "ws-A", "scout-build-review", "brainstorm", &cwd,
            HashMap::new(), "scout", SwarmKind::Brainstorm,
        )
        .expect("brainstorm coexists with a running card swarm");
    }

    /// Non-card swarms stay one-at-a-time: a second brainstorm/adhoc is
    /// rejected while one is already running.
    #[test]
    fn second_non_card_swarm_rejected() {
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        reg.swarm_start(
            "ws-A", "scout-build-review", "brainstorm 1", &cwd,
            HashMap::new(), "scout", SwarmKind::Brainstorm,
        )
        .expect("first brainstorm starts");
        let err = reg
            .swarm_start(
                "ws-A", "scout-build-review", "adhoc 2", &cwd,
                HashMap::new(), "scout", SwarmKind::Adhoc,
            )
            .expect_err("second non-card swarm rejected");
        assert!(err.contains("already running"), "got: {err}");
    }

    #[test]
    fn mailbox_append_creates_jsonl() {
        let (_tmp, reg) = fresh_registry();
        for i in 0..3 {
            reg.append_mailbox(&MailboxEntry {
                id: format!("e{i}"),
                ts: 100 + i,
                swarm_id: "swarm-x".into(),
                kind: MailboxKind::Dispatch,
                role: Some("scout".into()),
                run_id: None,
                body: None,
                run_summary: None,
            })
            .unwrap();
        }
        let entries = reg.read_mailbox("swarm-x", 0).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].id, "e0");
        assert_eq!(entries[2].ts, 102);
        // from_offset is line-index based.
        let tail = reg.read_mailbox("swarm-x", 1).unwrap();
        assert_eq!(tail.len(), 2);
        assert_eq!(tail[0].id, "e1");
    }

    #[test]
    fn mailbox_read_skips_partial_last_line() {
        let (_tmp, reg) = fresh_registry();
        reg.append_mailbox(&MailboxEntry {
            id: "e1".into(),
            ts: 1,
            swarm_id: "swarm-y".into(),
            kind: MailboxKind::Created,
            role: None,
            run_id: None,
            body: None,
            run_summary: None,
        })
        .unwrap();
        // Simulate a kill mid-write: append a malformed half-line.
        let path = reg.mailbox_path("swarm-y");
        let mut f = OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(br#"{ "id": "e2-truncated", "ts":"#).unwrap();
        f.sync_all().unwrap();

        let entries = reg.read_mailbox("swarm-y", 0).unwrap();
        assert_eq!(entries.len(), 1, "partial line must be skipped");
        assert_eq!(entries[0].id, "e1");
    }

    #[test]
    fn reconcile_orphans_marks_running_as_suspended() {
        // R2 (resumable swarms): a `Running` swarm orphaned by app exit
        // becomes `Suspended`, not `Aborted`. The user can resume it from
        // the Swarm tab.
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        let s = reg
            .swarm_start("ws-1", "scout-build-review", "x", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc)
            .unwrap();

        // Simulate app crash + restart: re-open the registry from the same dir.
        let reg2 = SwarmRegistry::new(tmp.path().to_path_buf()).unwrap();
        let touched = reg2.reconcile_orphans();
        assert_eq!(touched, vec![s.id.clone()]);

        let after = reg2.get(&s.id).unwrap();
        assert_eq!(after.status, SwarmStatus::Suspended);
        // FSM state is unchanged (still PendingStep idx=0 / scout) so
        // resume can re-fire the right role.
        assert_eq!(after.state, pending_step(0, "scout", &[]));
        assert!(after.suspended_at.is_some());
        assert_eq!(
            after.in_flight_role_at_suspend.as_deref(),
            Some("scout"),
            "captures the role that was in-flight (scout, since the swarm started but hadn't progressed)"
        );
        // No terminate entry — Suspended is non-terminal. Mailbox has the
        // initial `created` entry plus the new `suspend` entry.
        let mailbox = reg2.read_mailbox(&s.id, 0).unwrap();
        assert_eq!(mailbox.len(), 2);
        assert_eq!(mailbox[1].kind, MailboxKind::Suspend);
    }

    #[test]
    fn reconcile_orphans_fails_stale_suspended_swarms() {
        // R2 (resumable swarms): a swarm `Suspended` for longer than the
        // staleness cutoff is auto-promoted to `Failed { stale, not
        // resumable }`. Prevents a swarm from being resumed against a
        // codebase that has drifted significantly since suspend.
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        let s = reg
            .swarm_start("ws-1", "scout-build-review", "x", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc)
            .unwrap();
        // First reconcile: Running -> Suspended (today's behavior).
        reg.reconcile_orphans();
        // Hand-edit suspended_at to be 25h ago (past the 24h cutoff).
        {
            let mut cache = reg.cache.lock();
            let swarm = cache.get_mut(&s.id).unwrap();
            swarm.suspended_at = Some(now_millis() - (25 * 3600 * 1000));
            // Persist on disk so a fresh registry load sees the stale ts.
            let snapshot = swarm.clone();
            drop(cache);
            reg.persist(&snapshot).unwrap();
        }

        // Reload the registry from disk and reconcile again — the stale
        // Suspended now flips to Failed.
        let reg2 = SwarmRegistry::new(tmp.path().to_path_buf()).unwrap();
        let touched = reg2.reconcile_orphans();
        assert_eq!(touched, vec![s.id.clone()]);
        let after = reg2.get(&s.id).unwrap();
        assert_eq!(after.status, SwarmStatus::Failed);
        assert_eq!(after.state, SwarmState::Failed);
        assert_eq!(after.end_reason.as_deref(), Some("stale, not resumable"));
        // Mailbox now has: created, suspend (from reg's reconcile),
        // terminate (from reg2's reconcile).
        let mailbox = reg2.read_mailbox(&s.id, 0).unwrap();
        assert_eq!(mailbox.last().map(|e| e.kind), Some(MailboxKind::Terminate));
    }

    #[test]
    fn reconcile_orphans_leaves_fresh_suspended_alone() {
        // R2: a Suspended swarm whose suspended_at is *within* the cutoff
        // is preserved (resumable). reconcile_orphans should not touch it.
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        let s = reg
            .swarm_start("ws-1", "scout-build-review", "x", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc)
            .unwrap();
        reg.reconcile_orphans(); // Running -> Suspended
        let suspended_at_before = reg.get(&s.id).unwrap().suspended_at;

        // Fresh reload + second reconcile pass. Should be a no-op.
        let reg2 = SwarmRegistry::new(tmp.path().to_path_buf()).unwrap();
        let touched = reg2.reconcile_orphans();
        assert!(touched.is_empty(), "fresh Suspended swarm must not be touched");
        let after = reg2.get(&s.id).unwrap();
        assert_eq!(after.status, SwarmStatus::Suspended);
        assert_eq!(after.suspended_at, suspended_at_before);
    }

    #[test]
    fn abort_is_idempotent_on_terminal_states() {
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        let s = reg
            .swarm_start("ws-1", "scout-build-review", "x", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc)
            .unwrap();
        reg.abort(&s.id, "user aborted").unwrap();
        // Second abort is a no-op — does NOT append a duplicate terminate.
        reg.abort(&s.id, "would-be-second").unwrap();
        let mailbox = reg.read_mailbox(&s.id, 0).unwrap();
        let terminate_count = mailbox
            .iter()
            .filter(|e| e.kind == MailboxKind::Terminate)
            .count();
        assert_eq!(terminate_count, 1);
        let after = reg.get(&s.id).unwrap();
        assert_eq!(after.end_reason.as_deref(), Some("user aborted"));
    }

    #[test]
    fn unlinked_rollback_kills_every_run_and_suppresses_notification() {
        let source = include_str!("swarms.rs");
        let (_, rollback_tail) = source
            .split_once("pub(crate) fn abort_unlinked_start(")
            .expect("unlinked rollback helper must remain discoverable");
        let (rollback, _) = rollback_tail
            .split_once("/// R4 (resumable swarms)")
            .expect("unlinked rollback helper end must remain discoverable");
        assert!(rollback.contains("for run_id in &swarm.run_ids"));
        assert!(rollback.contains("abort_without_notification("));
        assert!(!rollback.contains(".run_ids.last()"));

        let (_, silent_tail) = source
            .split_once("pub(crate) fn abort_without_notification(")
            .expect("silent abort entry must remain discoverable");
        let (silent, _) = silent_tail
            .split_once("fn abort_with_notification(")
            .expect("silent abort entry end must remain discoverable");
        assert!(silent.contains("abort_with_notification(swarm_id, reason, false)"));
    }

    #[test]
    fn non_done_card_swarm_clears_deferred_auto_verify_intent() {
        let source = include_str!("swarms.rs");
        let (_, tail) = source
            .split_once("let will_autoverify = updated.status == SwarmStatus::Done")
            .expect("terminal card auto-verify branch must remain discoverable");
        let (branch, _) = tail
            .split_once("// v1.58.0 (Cycle 3 / Phase 4)")
            .expect("terminal card auto-verify branch end must remain discoverable");
        assert!(branch.contains("if updated.status == SwarmStatus::Done"));
        assert!(branch.contains("take_deferred_auto_verify("));
    }

    /// v1.5.4 regression test: abort transitions Suspended → Aborted.
    /// v1.0 wrote `abort` for Running-only; v1.1 added Suspended but
    /// didn't update abort, leaving SuspendedBanner's "Abort permanently"
    /// button silently dead. Now both states transition cleanly +
    /// suspend bookkeeping (suspended_at, in_flight_role_at_suspend,
    /// in_flight_at_suspend) is cleared.
    #[test]
    fn abort_transitions_suspended_to_aborted() {
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        let s = reg
            .swarm_start("ws-1", "scout-build-review", "x", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc)
            .unwrap();
        // Suspend it (Cmd-Q simulation).
        reg.kill_all();
        let suspended = reg.get(&s.id).unwrap();
        assert_eq!(suspended.status, SwarmStatus::Suspended);
        assert!(suspended.suspended_at.is_some());
        assert_eq!(suspended.in_flight_role_at_suspend.as_deref(), Some("scout"));

        // User clicks "Abort permanently" on the SuspendedBanner.
        reg.abort(&s.id, "abort permanently").unwrap();

        let after = reg.get(&s.id).unwrap();
        assert_eq!(after.status, SwarmStatus::Aborted);
        assert_eq!(after.state, SwarmState::Aborted);
        assert_eq!(after.end_reason.as_deref(), Some("abort permanently"));
        assert!(after.ended_at.is_some());
        // Suspend bookkeeping cleared.
        assert!(after.suspended_at.is_none());
        assert!(after.in_flight_role_at_suspend.is_none());
        assert!(after.in_flight_at_suspend.is_empty());

        // Mailbox got a Terminate entry.
        let mailbox = reg.read_mailbox(&s.id, 0).unwrap();
        let terminate_count = mailbox
            .iter()
            .filter(|e| e.kind == MailboxKind::Terminate)
            .count();
        assert_eq!(terminate_count, 1);
    }

    #[test]
    fn kill_all_suspends_every_running_swarm() {
        // R3 (resumable swarms): on Cmd-Q, every Running swarm becomes
        // Suspended (was: Aborted) so the user can resume on next launch.
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        let a = reg.swarm_start("ws-A", "t", "a", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc).unwrap();
        let b = reg.swarm_start("ws-B", "t", "b", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc).unwrap();
        reg.kill_all();
        assert_eq!(reg.get(&a.id).unwrap().status, SwarmStatus::Suspended);
        assert_eq!(reg.get(&b.id).unwrap().status, SwarmStatus::Suspended);
        assert!(reg.get(&a.id).unwrap().suspended_at.is_some());
        assert!(reg.get(&b.id).unwrap().suspended_at.is_some());
    }

    #[test]
    fn kill_all_skips_terminal_swarms() {
        // R3: a swarm already in a terminal state (Done/Failed/Aborted)
        // is not touched — kill_all is a no-op for non-Running.
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        let s = reg.swarm_start("ws-A", "t", "x", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc).unwrap();
        reg.abort(&s.id, "user aborted").unwrap();
        let suspended_at_before = reg.get(&s.id).unwrap().suspended_at;
        reg.kill_all();
        let after = reg.get(&s.id).unwrap();
        assert_eq!(after.status, SwarmStatus::Aborted, "Aborted swarms must not be re-suspended");
        assert_eq!(after.suspended_at, suspended_at_before);
    }

    // ── R4: resume_to_running ───────────────────────────

    #[test]
    fn resume_to_running_rejects_non_suspended() {
        // R4: resume_to_running on a swarm that is not Suspended must error
        // out with a clear message. Tests Running, Done (terminal), and
        // missing-swarm cases.
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        let s = reg
            .swarm_start("ws-A", "scout-build-review", "x", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc)
            .unwrap();

        // 1. Running -> error
        let err = reg.resume_to_running(&s.id).unwrap_err();
        assert!(
            err.contains("not suspended"),
            "expected 'not suspended' in error, got: {err}"
        );

        // 2. Done -> error (idempotency on terminal states)
        reg.abort(&s.id, "user aborted").unwrap();
        let err2 = reg.resume_to_running(&s.id).unwrap_err();
        assert!(err2.contains("not suspended"));

        // 3. Unknown id -> error
        let err3 = reg.resume_to_running("does-not-exist").unwrap_err();
        assert!(err3.contains("unknown swarm"));
    }

    #[test]
    fn resume_to_running_clears_suspended_state_and_accumulates_seconds() {
        // R4 happy path: Suspended swarm flips to Running, suspended_seconds
        // accumulates the gap, suspended_at and in_flight_role_at_suspend
        // both clear, status flips, mailbox carries the Resume entry.
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        let s = reg
            .swarm_start("ws-A", "scout-build-review", "x", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc)
            .unwrap();
        reg.kill_all(); // Running -> Suspended (R3)

        // Hand-edit suspended_at to be 50 seconds ago so the resume gap is
        // measurable. The persist round-trip ensures we exercise the full
        // serde + on-disk path, not just the in-memory cache.
        let fifty_sec_ago = now_millis() - 50_000;
        {
            let mut cache = reg.cache.lock();
            let swarm = cache.get_mut(&s.id).unwrap();
            swarm.suspended_at = Some(fifty_sec_ago);
            swarm.in_flight_role_at_suspend = Some("scout".into());
            let snapshot = swarm.clone();
            drop(cache);
            reg.persist(&snapshot).unwrap();
        }

        let resumed = reg.resume_to_running(&s.id).unwrap();
        assert_eq!(resumed.status, SwarmStatus::Running);
        assert!(resumed.suspended_at.is_none(), "suspended_at must clear");
        assert!(
            resumed.in_flight_role_at_suspend.is_none(),
            "in_flight_role_at_suspend must clear"
        );
        // Allow ±2s slop on the accumulated seconds for clock granularity.
        assert!(
            (48..=52).contains(&resumed.suspended_seconds),
            "expected ~50 suspended_seconds, got {}",
            resumed.suspended_seconds
        );

        // Mailbox should now have created + suspend + resume.
        let mailbox = reg.read_mailbox(&s.id, 0).unwrap();
        assert_eq!(mailbox.last().map(|e| e.kind), Some(MailboxKind::Resume));
        let resume_entry = mailbox.iter().find(|e| e.kind == MailboxKind::Resume).unwrap();
        // Resume body carries from_role + suspended_seconds.
        let body = resume_entry.body.as_ref().expect("resume body");
        assert_eq!(body.get("from_role").and_then(|v| v.as_str()), Some("scout"));
    }

    #[test]
    fn resume_to_running_accumulates_across_multiple_cycles() {
        // R4: a swarm suspended -> resumed -> suspended -> resumed should
        // have suspended_seconds reflect the SUM of the two suspended
        // intervals, not just the latest.
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        let s = reg
            .swarm_start("ws-A", "scout-build-review", "x", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc)
            .unwrap();

        // Cycle 1: suspend, hand-set suspended_at to 30s ago, resume.
        reg.kill_all();
        {
            let mut cache = reg.cache.lock();
            let swarm = cache.get_mut(&s.id).unwrap();
            swarm.suspended_at = Some(now_millis() - 30_000);
            swarm.in_flight_role_at_suspend = Some("scout".into());
            let snapshot = swarm.clone();
            drop(cache);
            reg.persist(&snapshot).unwrap();
        }
        reg.resume_to_running(&s.id).unwrap();
        let after_cycle_1 = reg.get(&s.id).unwrap().suspended_seconds;
        assert!((28..=32).contains(&after_cycle_1));

        // Cycle 2: suspend again, set suspended_at to 20s ago, resume.
        reg.kill_all();
        {
            let mut cache = reg.cache.lock();
            let swarm = cache.get_mut(&s.id).unwrap();
            swarm.suspended_at = Some(now_millis() - 20_000);
            swarm.in_flight_role_at_suspend = Some("builder".into());
            let snapshot = swarm.clone();
            drop(cache);
            reg.persist(&snapshot).unwrap();
        }
        reg.resume_to_running(&s.id).unwrap();
        let after_cycle_2 = reg.get(&s.id).unwrap().suspended_seconds;
        // ~30 + ~20 = ~50, allow some slop.
        assert!(
            (47..=53).contains(&after_cycle_2),
            "expected ~50 cumulative suspended_seconds, got {after_cycle_2}"
        );
    }

    #[test]
    fn mailbox_carries_suspend_and_resume_kinds() {
        // R4: round-trip the new MailboxKind variants. Ensures serde
        // (de)serialization stays consistent across the wire.
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        let s = reg
            .swarm_start("ws-A", "scout-build-review", "x", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc)
            .unwrap();
        reg.kill_all(); // appends Suspend
        {
            let mut cache = reg.cache.lock();
            let swarm = cache.get_mut(&s.id).unwrap();
            swarm.suspended_at = Some(now_millis() - 1000);
            let snapshot = swarm.clone();
            drop(cache);
            reg.persist(&snapshot).unwrap();
        }
        reg.resume_to_running(&s.id).unwrap(); // appends Resume

        let mailbox = reg.read_mailbox(&s.id, 0).unwrap();
        let kinds: Vec<MailboxKind> = mailbox.iter().map(|e| e.kind).collect();
        assert!(kinds.contains(&MailboxKind::Suspend), "Suspend kind missing");
        assert!(kinds.contains(&MailboxKind::Resume), "Resume kind missing");

        // Verify lossless serde round-trip: read each line back from the
        // raw on-disk file and confirm the kinds match.
        let path = reg.mailbox_path(&s.id);
        let bytes = std::fs::read(&path).unwrap();
        let mut on_disk_kinds = Vec::new();
        for line in bytes.split(|b| *b == b'\n') {
            if line.is_empty() {
                continue;
            }
            let entry: MailboxEntry =
                serde_json::from_slice(line).expect("disk line parses");
            on_disk_kinds.push(entry.kind);
        }
        assert_eq!(kinds, on_disk_kinds);
    }

    // ── State machine (pure) ───────────────────────────

    fn outcome(role: &str, run_id: &str, status: &str) -> RunOutcome {
        RunOutcome {
            run_id: run_id.into(),
            role: role.into(),
            status: status.into(),
            artifact: None,
            error_msg: None,
            role_instance_id: None,
        }
    }

    fn verdict(role: &str, run_id: &str, v: &str) -> RunOutcome {
        RunOutcome {
            run_id: run_id.into(),
            role: role.into(),
            status: STATUS_DONE.into(),
            artifact: Some(serde_json::json!({ "verdict": v })),
            error_msg: None,
            role_instance_id: None,
        }
    }

    #[test]
    fn state_machine_scout_to_build_to_review_done() {
        let tmpl = feature_template();
        // Scout finishes → fire builder. v1.27.2 (H-3): scout has
        // `expects_artifact: true` so the FSM now requires a non-None
        // artifact; pre-H-3 this test would have passed even with
        // `artifact: None` because the missing-artifact case silently
        // advanced.
        let mut scout = outcome("scout", "r1", STATUS_DONE);
        scout.artifact = Some(serde_json::json!({ "plan": "do the thing" }));
        let t = next_fsm_state(
            &tmpl,
            &pending_step(0, "scout", &[]),
            0,
            &scout,
        );
        match t {
            FsmTransition::Advance { next_state, next_role, new_iteration } => {
                assert_eq!(next_state, pending_step(1, "builder", &["r1"]));
                assert_eq!(next_role.as_deref(), Some("builder"));
                assert_eq!(new_iteration, 0);
            }
            _ => panic!("expected Advance"),
        }
        // Builder finishes → fire reviewer.
        let t = next_fsm_state(
            &tmpl,
            &pending_step(1, "builder", &["r1"]),
            0,
            &outcome("builder", "r2", STATUS_DONE),
        );
        match t {
            FsmTransition::Advance { next_state, next_role, .. } => {
                assert_eq!(next_state, pending_step(2, "reviewer", &["r1", "r2"]));
                assert_eq!(next_role.as_deref(), Some("reviewer"));
            }
            _ => panic!("expected Advance"),
        }
        // Reviewer approves → terminate Done.
        let t = next_fsm_state(
            &tmpl,
            &pending_step(2, "reviewer", &["r1", "r2"]),
            0,
            &verdict("reviewer", "r3", "approve"),
        );
        match t {
            FsmTransition::Terminate { status, reason, .. } => {
                assert_eq!(status, SwarmStatus::Done);
                assert_eq!(reason, "approved by reviewer");
            }
            _ => panic!("expected Terminate"),
        }
    }

    #[test]
    fn state_machine_loopback_until_max_iterations() {
        let tmpl = feature_template();
        let max_iter = tmpl.max_iterations;
        let mut iteration = 0u32;
        let mut state = pending_step(2, "reviewer", &["r1", "r2"]);
        // Each reject bumps iteration and fires builder again, until
        // (next_iteration > max_iter) terminates with MaxIter.
        for i in 1..=max_iter {
            let t = next_fsm_state(
                &tmpl,
                &state,
                iteration,
                &verdict("reviewer", &format!("rev-{i}"), "reject"),
            );
            match t {
                FsmTransition::Advance { next_state, next_role, new_iteration } => {
                    assert_eq!(new_iteration, i, "iteration bumps on each reject");
                    assert_eq!(next_role.as_deref(), Some("builder"));
                    assert!(matches!(next_state, SwarmState::PendingStep { idx: 1, .. }));
                    iteration = new_iteration;
                    // Simulate the next builder finishing → PendingStep idx=2.
                    state = pending_step(2, "reviewer", &["r1", "r2"]);
                }
                _ => panic!("iteration {i}: expected Advance, got {t:?}"),
            }
        }
        // One more reject → MaxIter.
        let t = next_fsm_state(
            &tmpl,
            &state,
            iteration,
            &verdict("reviewer", "rev-final", "reject"),
        );
        match t {
            FsmTransition::Terminate { status, reason, .. } => {
                assert_eq!(status, SwarmStatus::MaxIter);
                assert!(reason.contains("max_iterations"), "got: {reason}");
            }
            _ => panic!("expected Terminate(MaxIter)"),
        }
    }

    #[test]
    fn state_machine_aborts_on_run_error() {
        let tmpl = feature_template();
        for failing_status in [STATUS_ERROR, STATUS_KILLED] {
            let mut o = outcome("builder", "r2", failing_status);
            o.error_msg = Some("subprocess crashed".into());
            let t = next_fsm_state(
                &tmpl,
                &pending_step(1, "builder", &["r1"]),
                0,
                &o,
            );
            match t {
                FsmTransition::Terminate { status, reason, .. } => {
                    assert_eq!(status, SwarmStatus::Failed);
                    assert!(reason.contains("builder run failed"), "got: {reason}");
                    assert!(reason.contains("subprocess crashed"), "got: {reason}");
                }
                _ => panic!("expected Terminate(Failed) for status={failing_status}"),
            }
        }
    }

    #[test]
    fn state_machine_aborts_on_missing_artifact() {
        let tmpl = feature_template();
        // Reviewer finished done but produced no artifact → no verdict → Failed.
        let t = next_fsm_state(
            &tmpl,
            &pending_step(2, "reviewer", &["r1", "r2"]),
            0,
            &outcome("reviewer", "r3", STATUS_DONE),
        );
        match t {
            FsmTransition::Terminate { status, reason, .. } => {
                assert_eq!(status, SwarmStatus::Failed);
                assert_eq!(reason, "reviewer produced no verdict");
            }
            _ => panic!("expected Terminate(Failed)"),
        }
        // Artifact present but missing the `verdict` key → also Failed.
        let mut o = outcome("reviewer", "r3", STATUS_DONE);
        o.artifact = Some(serde_json::json!({ "critique": "no verdict field" }));
        let t = next_fsm_state(
            &tmpl,
            &pending_step(2, "reviewer", &["r1", "r2"]),
            0,
            &o,
        );
        assert!(matches!(t, FsmTransition::Terminate { status: SwarmStatus::Failed, .. }));
        // Artifact with bogus verdict value → Failed.
        let t = next_fsm_state(
            &tmpl,
            &pending_step(2, "reviewer", &["r1", "r2"]),
            0,
            &verdict("reviewer", "r3", "maybe"),
        );
        assert!(matches!(t, FsmTransition::Terminate { status: SwarmStatus::Failed, .. }));
    }

    #[test]
    fn state_machine_fails_when_non_loopback_step_expects_artifact_but_none_arrives() {
        // v1.27.2 (Cycle H-3) regression guard. A non-loopback step (no
        // `on_reject_jump_to`) with `expects_artifact: true` MUST fail
        // the swarm if the run reports done but the post-exit
        // `read_swarm_artifact` returned None. Pre-v1.27.2 this would
        // silently call `advance_or_done` and the chain continued — see
        // the originating claude-codex-debate incident where the
        // architect-rebuttal wrote its artifact to a UUID-mangled path,
        // the canonical-path read returned None, and the final critic
        // still got dispatched and "approved" a plan that the FSM never
        // saw.
        let tmpl = feature_template();
        // Step 0 in feature_template is `scout` (expects_artifact: true,
        // on_reject_jump_to: None) — the exact shape the H-3 fix
        // protects.
        let scout_step = &tmpl.steps[0];
        assert!(scout_step.expects_artifact);
        assert!(scout_step.on_reject_jump_to.is_none());

        let mut o = outcome("scout", "scout-run-1", STATUS_DONE);
        o.artifact = None; // The artifact file was missing on disk.

        let t = next_fsm_state(
            &tmpl,
            &pending_step(0, "scout", &[]),
            0,
            &o,
        );
        match t {
            FsmTransition::Terminate { status, reason, .. } => {
                assert_eq!(status, SwarmStatus::Failed);
                assert_eq!(reason, "scout produced no artifact");
            }
            _ => panic!("expected Terminate(Failed); got {t:?}"),
        }
    }

    #[test]
    fn state_machine_advances_when_non_loopback_step_does_not_expect_artifact() {
        // v1.27.2 (Cycle H-3) negative guard. The H-3 fix ONLY trips
        // when `expects_artifact: true` — a step like builder
        // (expects_artifact: false, no loopback) must still advance
        // even when no artifact arrives. Without this assertion, a
        // future refactor that broadened the guard to all non-loopback
        // steps would silently break builder/refactorer/coordinator
        // sub-steps.
        let tmpl = feature_template();
        let builder_step = &tmpl.steps[1];
        assert_eq!(builder_step.role, "builder");
        assert!(!builder_step.expects_artifact);
        assert!(builder_step.on_reject_jump_to.is_none());

        let mut o = outcome("builder", "builder-run-1", STATUS_DONE);
        o.artifact = None;

        let t = next_fsm_state(
            &tmpl,
            &pending_step(1, "builder", &["scout-r"]),
            0,
            &o,
        );
        match t {
            FsmTransition::Advance { next_role, .. } => {
                assert_eq!(next_role.as_deref(), Some("reviewer"));
            }
            _ => panic!("expected Advance after builder; got {t:?}"),
        }
    }

    #[test]
    fn state_machine_refactor_template_loops_back_to_refactorer_not_builder() {
        // v1.2.0: per-template loopback target. The refactor template's
        // reviewer reject jumps back to refactorer (idx 1), not builder.
        // Mirror test for ux-audit: reviewer reject jumps to builder (idx 1).
        // Both prove the FSM reads `on_reject_jump_to` from the actual
        // template rather than the v1.0 hardcoded "always builder".
        let refactor = crate::swarm_templates::builtin_templates()
            .into_iter()
            .find(|t| t.id == "refactor")
            .unwrap();
        let t = next_fsm_state(
            &refactor,
            &pending_step(2, "reviewer", &["scout-r", "refac-r"]),
            0,
            &verdict("reviewer", "rev-1", "reject"),
        );
        match t {
            FsmTransition::Advance { next_state, next_role, new_iteration } => {
                // The refactor template's loopback target is idx 1 ("refactorer").
                assert_eq!(new_iteration, 1);
                assert_eq!(next_role.as_deref(), Some("refactorer"));
                assert_eq!(next_state, pending_step(1, "refactorer", &["scout-r", "refac-r", "rev-1"]));
            }
            _ => panic!("expected Advance, got {t:?}"),
        }
    }

    #[test]
    fn state_machine_bugfix_template_caps_at_two_iterations() {
        // v1.2.0: per-template max_iterations. The bugfix template caps at
        // 2 (vs feature's 3) — proves caps flow from `template.max_iterations`,
        // not a hardcoded constant.
        let bugfix = crate::swarm_templates::builtin_templates()
            .into_iter()
            .find(|t| t.id == "bugfix")
            .unwrap();
        // Iteration 1 reject should advance.
        let t = next_fsm_state(
            &bugfix,
            &pending_step(2, "reviewer", &["s", "b"]),
            0,
            &verdict("reviewer", "r1", "reject"),
        );
        assert!(matches!(t, FsmTransition::Advance { new_iteration: 1, .. }));
        // Iteration 2 reject should advance.
        let t = next_fsm_state(
            &bugfix,
            &pending_step(2, "reviewer", &["s", "b", "r1", "b2"]),
            1,
            &verdict("reviewer", "r2", "reject"),
        );
        assert!(matches!(t, FsmTransition::Advance { new_iteration: 2, .. }));
        // Iteration 3 reject should hit MaxIter (bugfix caps at 2).
        let t = next_fsm_state(
            &bugfix,
            &pending_step(2, "reviewer", &["s", "b", "r1", "b2", "r2", "b3"]),
            2,
            &verdict("reviewer", "r3", "reject"),
        );
        match t {
            FsmTransition::Terminate { status, reason, .. } => {
                assert_eq!(status, SwarmStatus::MaxIter);
                assert!(reason.contains("max_iterations (2)"), "got: {reason}");
            }
            _ => panic!("expected MaxIter, got {t:?}"),
        }
    }

    // ── P3 (v1.3): coordinator + dispatching FSM ───────

    /// Helper for P3 tests: a coordinator-mode template with three roles
    /// in its pool (builder / reviewer / scout) and tick cap = 3.
    fn coordinator_template() -> crate::swarm_templates::SwarmTemplate {
        crate::swarm_templates::SwarmTemplate {
            schema_version: 1,
            id: "test-coord".into(),
            label: "test coord".into(),
            description: String::new(),
            steps: vec![
                crate::swarm_templates::RoleStep {
                    role: "builder".into(),
                    expects_artifact: false,
                    on_reject_jump_to: None,
                    provider: None,
                },
                crate::swarm_templates::RoleStep {
                    role: "reviewer".into(),
                    expects_artifact: true,
                    on_reject_jump_to: None,
                    provider: None,
                },
                crate::swarm_templates::RoleStep {
                    role: "scout".into(),
                    expects_artifact: true,
                    on_reject_jump_to: None,
                    provider: None,
                },
            ],
            max_iterations: 3,
            max_wall_seconds: 1800,
            builtin: false,
            coordinator: true,
            output_kind: crate::swarm_templates::OutputKind::Code,
            created_at: 0,
            updated_at: 0,
            author: None,
            last_edited_by: None,
            scope: crate::shared_library::LibraryScope::Personal,
        }
    }

    fn coord_outcome(run_id: &str, artifact: serde_json::Value) -> RunOutcome {
        RunOutcome {
            run_id: run_id.into(),
            role: "coordinator".into(),
            status: STATUS_DONE.into(),
            artifact: Some(artifact),
            error_msg: None,
            role_instance_id: None,
        }
    }

    #[test]
    fn p3_coordinator_done_terminates_swarm() {
        let tmpl = coordinator_template();
        let t = next_fsm_state(
            &tmpl,
            &SwarmState::PendingCoordinator { tick: 1 },
            1,
            &coord_outcome("c1", serde_json::json!({ "tick": 1, "done": true })),
        );
        match t {
            FsmTransition::Terminate { status, reason, .. } => {
                assert_eq!(status, SwarmStatus::Done);
                assert!(reason.contains("done"), "got: {reason}");
            }
            _ => panic!("expected Terminate Done, got {t:?}"),
        }
    }

    #[test]
    fn p3_coordinator_dispatches_advances_to_dispatching_with_parsed_instances() {
        let tmpl = coordinator_template();
        let artifact = serde_json::json!({
            "tick": 1,
            "done": false,
            "dispatches": [
                {"instance":"b-api","role":"builder","task":"api","ownerGlobs":["src/api/**"],"dependsOn":[]},
                {"instance":"b-ui","role":"builder","task":"ui","ownerGlobs":["src/ui/**"],"dependsOn":["b-api"]}
            ]
        });
        let t = next_fsm_state(
            &tmpl,
            &SwarmState::PendingCoordinator { tick: 1 },
            1,
            &coord_outcome("c1", artifact),
        );
        match t {
            FsmTransition::Advance { next_state, next_role, new_iteration } => {
                assert!(next_role.is_none(), "fan-out: orchestrator handles dispatch");
                assert_eq!(new_iteration, 1);
                match next_state {
                    SwarmState::Dispatching { tick, instances } => {
                        assert_eq!(tick, 1);
                        assert_eq!(instances.len(), 2);
                        assert_eq!(instances[0].id, "b-api");
                        assert_eq!(instances[0].role, "builder");
                        assert_eq!(instances[0].owner_globs, vec!["src/api/**"]);
                        assert!(matches!(instances[0].status, InstanceStatus::Pending));
                        assert_eq!(instances[1].depends_on, vec!["b-api"]);
                    }
                    _ => panic!("expected Dispatching"),
                }
            }
            _ => panic!("expected Advance, got {t:?}"),
        }
    }

    #[test]
    fn p3_coordinator_rejects_dispatch_targeting_role_outside_pool() {
        let tmpl = coordinator_template();
        let artifact = serde_json::json!({
            "tick": 1,
            "done": false,
            "dispatches": [{"instance":"x","role":"refactorer","task":"y"}]
        });
        let t = next_fsm_state(
            &tmpl,
            &SwarmState::PendingCoordinator { tick: 1 },
            1,
            &coord_outcome("c1", artifact),
        );
        match t {
            FsmTransition::Terminate { status, reason, .. } => {
                assert_eq!(status, SwarmStatus::Failed);
                assert!(reason.contains("not in template"), "got: {reason}");
            }
            _ => panic!("expected Terminate"),
        }
    }

    #[test]
    fn p3_coordinator_rejects_over_max_parallelism_cap() {
        let tmpl = coordinator_template();
        let mut dispatches = Vec::new();
        for i in 0..(MAX_PARALLEL_INSTANCES_PER_TICK + 1) {
            dispatches.push(serde_json::json!({
                "instance": format!("b-{i}"),
                "role": "builder",
                "task": "x"
            }));
        }
        let artifact = serde_json::json!({
            "tick": 1,
            "done": false,
            "dispatches": dispatches
        });
        let t = next_fsm_state(
            &tmpl,
            &SwarmState::PendingCoordinator { tick: 1 },
            1,
            &coord_outcome("c1", artifact),
        );
        match t {
            FsmTransition::Terminate { status, reason, .. } => {
                assert_eq!(status, SwarmStatus::Failed);
                assert!(reason.contains("cap is"), "got: {reason}");
            }
            _ => panic!("expected Terminate"),
        }
    }

    #[test]
    fn p3_coordinator_rejects_dispatch_dependency_cycle() {
        let tmpl = coordinator_template();
        let artifact = serde_json::json!({
            "tick": 1,
            "done": false,
            "dispatches": [
                {"instance":"a","role":"builder","task":"x","dependsOn":["b"]},
                {"instance":"b","role":"builder","task":"y","dependsOn":["a"]}
            ]
        });
        let t = next_fsm_state(
            &tmpl,
            &SwarmState::PendingCoordinator { tick: 1 },
            1,
            &coord_outcome("c1", artifact),
        );
        match t {
            FsmTransition::Terminate { status, reason, .. } => {
                assert_eq!(status, SwarmStatus::Failed);
                assert!(reason.contains("cycle"), "got: {reason}");
            }
            _ => panic!("expected Terminate"),
        }
    }

    #[test]
    fn p3_coordinator_rejects_unknown_dependency() {
        let tmpl = coordinator_template();
        let artifact = serde_json::json!({
            "tick": 1,
            "done": false,
            "dispatches": [{"instance":"a","role":"builder","task":"x","dependsOn":["ghost"]}]
        });
        let t = next_fsm_state(
            &tmpl,
            &SwarmState::PendingCoordinator { tick: 1 },
            1,
            &coord_outcome("c1", artifact),
        );
        match t {
            FsmTransition::Terminate { status, reason, .. } => {
                assert_eq!(status, SwarmStatus::Failed);
                assert!(
                    reason.contains("unknown instance"),
                    "got: {reason}"
                );
            }
            _ => panic!("expected Terminate"),
        }
    }

    #[test]
    fn p3_coordinator_rejects_when_max_iterations_reached() {
        let tmpl = coordinator_template();
        // tick = max_iterations means the next tick (max+1) is over budget.
        let t = next_fsm_state(
            &tmpl,
            &SwarmState::PendingCoordinator {
                tick: tmpl.max_iterations,
            },
            tmpl.max_iterations,
            &coord_outcome(
                "c1",
                serde_json::json!({
                    "tick": tmpl.max_iterations,
                    "done": false,
                    "dispatches": [{"instance":"b","role":"builder","task":"x"}]
                }),
            ),
        );
        match t {
            FsmTransition::Terminate { status, reason, .. } => {
                assert_eq!(status, SwarmStatus::MaxIter);
                assert!(reason.contains("max_iterations"), "got: {reason}");
            }
            _ => panic!("expected MaxIter"),
        }
    }

    #[test]
    fn p3_dispatching_one_done_stays_dispatching_with_updated_instance() {
        let tmpl = coordinator_template();
        let instances = vec![
            RoleInstance {
                id: "a".into(),
                role: "builder".into(),
                run_id: Some("run-a".into()),
                owner_globs: vec![],
                task: "x".into(),
                depends_on: vec![],
                status: InstanceStatus::Running,
            },
            RoleInstance {
                id: "b".into(),
                role: "builder".into(),
                run_id: Some("run-b".into()),
                owner_globs: vec![],
                task: "y".into(),
                depends_on: vec![],
                status: InstanceStatus::Running,
            },
        ];
        let outcome = RunOutcome {
            run_id: "run-a".into(),
            role: "builder".into(),
            status: STATUS_DONE.into(),
            artifact: None,
            error_msg: None,
            role_instance_id: Some("a".into()),
        };
        let t = next_fsm_state(
            &tmpl,
            &SwarmState::Dispatching { tick: 1, instances },
            1,
            &outcome,
        );
        match t {
            FsmTransition::Advance {
                next_state, next_role, new_iteration,
            } => {
                assert!(next_role.is_none());
                assert_eq!(new_iteration, 1);
                match next_state {
                    SwarmState::Dispatching { tick, instances } => {
                        assert_eq!(tick, 1);
                        let a = instances.iter().find(|i| i.id == "a").unwrap();
                        assert_eq!(a.status, InstanceStatus::Done);
                        let b = instances.iter().find(|i| i.id == "b").unwrap();
                        assert_eq!(b.status, InstanceStatus::Running);
                    }
                    _ => panic!("expected Dispatching"),
                }
            }
            _ => panic!("expected Advance"),
        }
    }

    #[test]
    fn p6_ready_instances_filters_pending_with_satisfied_deps() {
        let instances = vec![
            RoleInstance {
                id: "a".into(),
                role: "builder".into(),
                run_id: Some("run-a".into()),
                owner_globs: vec![],
                task: "x".into(),
                depends_on: vec![],
                status: InstanceStatus::Done,
            },
            RoleInstance {
                id: "b".into(),
                role: "builder".into(),
                run_id: None,
                owner_globs: vec![],
                task: "y".into(),
                // Depends on a (which is Done) → ready.
                depends_on: vec!["a".into()],
                status: InstanceStatus::Pending,
            },
            RoleInstance {
                id: "c".into(),
                role: "builder".into(),
                run_id: None,
                owner_globs: vec![],
                task: "z".into(),
                // Depends on b (which is still Pending) → not ready yet.
                depends_on: vec!["b".into()],
                status: InstanceStatus::Pending,
            },
            RoleInstance {
                id: "d".into(),
                role: "builder".into(),
                run_id: None,
                owner_globs: vec![],
                task: "w".into(),
                // No deps → ready.
                depends_on: vec![],
                status: InstanceStatus::Pending,
            },
        ];
        let ready = ready_instances(&instances);
        let ready_ids: Vec<String> = ready.iter().map(|i| i.id.clone()).collect();
        assert!(ready_ids.contains(&"b".to_string()));
        assert!(ready_ids.contains(&"d".to_string()));
        assert!(!ready_ids.contains(&"c".to_string())); // blocked
        assert!(!ready_ids.contains(&"a".to_string())); // already Done
    }

    #[test]
    fn p6_record_instance_started_flips_status_and_stores_run_id() {
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        // Build a coordinator-mode swarm directly (skipping the orchestrator
        // for this unit test).
        let s = reg
            .swarm_start_coordinator(
                "ws-1",
                "test-coord",
                "do work",
                &cwd,
                HashMap::new(),
                SwarmKind::Adhoc,
            )
            .unwrap();
        // Transition the swarm into Dispatching with two instances. We
        // mutate the cache directly to bypass the FSM (covered by P3 tests).
        {
            let mut cache = reg.cache.lock();
            let swarm = cache.get_mut(&s.id).unwrap();
            swarm.state = SwarmState::Dispatching {
                tick: 1,
                instances: vec![
                    RoleInstance {
                        id: "a".into(),
                        role: "builder".into(),
                        run_id: None,
                        owner_globs: vec![],
                        task: "x".into(),
                        depends_on: vec![],
                        status: InstanceStatus::Pending,
                    },
                    RoleInstance {
                        id: "b".into(),
                        role: "builder".into(),
                        run_id: None,
                        owner_globs: vec![],
                        task: "y".into(),
                        depends_on: vec![],
                        status: InstanceStatus::Pending,
                    },
                ],
            };
            let snap = swarm.clone();
            drop(cache);
            reg.persist(&snap).unwrap();
        }
        // Record start for instance "a".
        reg.record_instance_started(&s.id, "a", "run-a").unwrap();
        let s2 = reg.get(&s.id).unwrap();
        match s2.state {
            SwarmState::Dispatching { instances, .. } => {
                let a = instances.iter().find(|i| i.id == "a").unwrap();
                assert_eq!(a.status, InstanceStatus::Running);
                assert_eq!(a.run_id.as_deref(), Some("run-a"));
                let b = instances.iter().find(|i| i.id == "b").unwrap();
                assert_eq!(b.status, InstanceStatus::Pending);
                assert!(b.run_id.is_none());
            }
            _ => panic!("expected Dispatching"),
        }
        assert!(s2.run_ids.contains(&"run-a".to_string()));
    }

    #[test]
    fn p8_suspend_captures_dispatching_instances_into_in_flight_at_suspend() {
        // v1.3.0 (P8): suspending a Dispatching swarm snapshots every
        // non-terminal RoleInstance into in_flight_at_suspend.
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        let s = reg
            .swarm_start_coordinator(
                "ws-1",
                "test-coord",
                "do work",
                &cwd,
                HashMap::new(),
                SwarmKind::Adhoc,
            )
            .unwrap();
        // Mutate into Dispatching with three instances at distinct statuses.
        {
            let mut cache = reg.cache.lock();
            let swarm = cache.get_mut(&s.id).unwrap();
            swarm.state = SwarmState::Dispatching {
                tick: 1,
                instances: vec![
                    RoleInstance {
                        id: "running".into(),
                        role: "builder".into(),
                        run_id: Some("run-r".into()),
                        owner_globs: vec!["src/**".into()],
                        task: "x".into(),
                        depends_on: vec![],
                        status: InstanceStatus::Running,
                    },
                    RoleInstance {
                        id: "pending".into(),
                        role: "builder".into(),
                        run_id: None,
                        owner_globs: vec!["test/**".into()],
                        task: "y".into(),
                        depends_on: vec!["running".into()],
                        status: InstanceStatus::Pending,
                    },
                    RoleInstance {
                        id: "done".into(),
                        role: "scout".into(),
                        run_id: Some("run-d".into()),
                        owner_globs: vec![],
                        task: "z".into(),
                        depends_on: vec![],
                        status: InstanceStatus::Done,
                    },
                ],
            };
            let snap = swarm.clone();
            drop(cache);
            reg.persist(&snap).unwrap();
        }
        // Suspend (Cmd-Q simulation).
        reg.suspend_for_orphan(&s.id).unwrap();
        let after = reg.get(&s.id).unwrap();
        assert_eq!(after.status, SwarmStatus::Suspended);
        // Only Pending + Running captured; Done excluded.
        assert_eq!(after.in_flight_at_suspend.len(), 2);
        let ids: Vec<&str> = after
            .in_flight_at_suspend
            .iter()
            .map(|i| i.id.as_str())
            .collect();
        assert!(ids.contains(&"running"));
        assert!(ids.contains(&"pending"));
        assert!(!ids.contains(&"done"));
        // The Dispatching state itself stays intact (FSM resumes from it).
        assert!(matches!(after.state, SwarmState::Dispatching { .. }));
    }

    #[test]
    fn p8_suspend_pending_step_leaves_in_flight_at_suspend_empty() {
        // Sequential templates don't populate in_flight_at_suspend — they
        // rely on in_flight_role_at_suspend (v1.1) instead. Verifies the
        // Dispatching-only branch in suspend_for_orphan.
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        let s = reg
            .swarm_start(
                "ws-1",
                "scout-build-review",
                "x",
                &cwd,
                HashMap::new(),
                "scout",
                SwarmKind::Adhoc,
            )
            .unwrap();
        reg.suspend_for_orphan(&s.id).unwrap();
        let after = reg.get(&s.id).unwrap();
        assert_eq!(after.status, SwarmStatus::Suspended);
        assert_eq!(after.in_flight_role_at_suspend.as_deref(), Some("scout"));
        assert!(after.in_flight_at_suspend.is_empty());
    }

    // ── S2 (v1.5.0): swarm-artifact dir reaper ─────────

    /// Helper: backdates a directory's mtime. Tests use it to simulate
    /// stale dirs without sleeping.
    fn backdate_dir_mtime(path: &std::path::Path, days_ago: u64) {
        use std::time::{Duration, SystemTime};
        let now = SystemTime::now();
        let then = now
            .checked_sub(Duration::from_secs(days_ago * 24 * 60 * 60))
            .expect("backdate");
        let ft = filetime::FileTime::from_system_time(then);
        let _ = filetime::set_file_mtime(path, ft);
    }

    #[test]
    fn s2_reaper_removes_stale_dir_keeps_fresh_one() {
        // Two artifact dirs in a workspace cwd: one mtime-backdated 60 days,
        // one fresh. Retention = 30 days. Reaper deletes the stale one.
        // Skip if filetime crate isn't available; this is an optional
        // crate that lives in dev-dependencies for this test specifically.
        let work = tempdir().unwrap();
        let swarm_root = work.path().join(".atelier").join("swarm");
        let stale = swarm_root.join("run-stale");
        let fresh = swarm_root.join("run-fresh");
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::create_dir_all(&fresh).unwrap();
        std::fs::write(stale.join("artifact.json"), b"{}").unwrap();
        std::fs::write(fresh.join("artifact.json"), b"{}").unwrap();
        backdate_dir_mtime(&stale, 60);

        let cwds = vec![work.path().to_path_buf()];
        let protected = std::collections::HashSet::new();
        let removed = prune_stale_swarm_artifact_dirs(&cwds, Some(30), &protected);

        assert_eq!(removed, 1);
        assert!(!stale.exists(), "stale dir should be reaped");
        assert!(fresh.exists(), "fresh dir should survive");
    }

    #[test]
    fn s2_reaper_skips_protected_run_id_even_if_stale() {
        let work = tempdir().unwrap();
        let swarm_root = work.path().join(".atelier").join("swarm");
        let stale_protected = swarm_root.join("run-load-bearing");
        std::fs::create_dir_all(&stale_protected).unwrap();
        backdate_dir_mtime(&stale_protected, 90);

        let cwds = vec![work.path().to_path_buf()];
        let mut protected = std::collections::HashSet::new();
        protected.insert("run-load-bearing".to_string());
        let removed = prune_stale_swarm_artifact_dirs(&cwds, Some(30), &protected);

        assert_eq!(removed, 0);
        assert!(stale_protected.exists(), "protected dir survives");
    }

    #[test]
    fn s2_reaper_noop_when_retention_is_none() {
        let work = tempdir().unwrap();
        let swarm_root = work.path().join(".atelier").join("swarm");
        let stale = swarm_root.join("run-x");
        std::fs::create_dir_all(&stale).unwrap();
        backdate_dir_mtime(&stale, 365);
        let cwds = vec![work.path().to_path_buf()];
        let protected = std::collections::HashSet::new();
        let removed = prune_stale_swarm_artifact_dirs(&cwds, None, &protected);
        assert_eq!(removed, 0);
        assert!(stale.exists());
    }

    #[test]
    fn p7_detect_glob_collisions_finds_overlapping_pairs() {
        let instances = vec![
            RoleInstance {
                id: "a".into(),
                role: "builder".into(),
                run_id: None,
                owner_globs: vec!["src/api/**".into()],
                task: "x".into(),
                depends_on: vec![],
                status: InstanceStatus::Pending,
            },
            RoleInstance {
                id: "b".into(),
                role: "builder".into(),
                run_id: None,
                owner_globs: vec!["src/api/health.rs".into()],
                task: "y".into(),
                depends_on: vec![],
                status: InstanceStatus::Pending,
            },
            RoleInstance {
                id: "c".into(),
                role: "builder".into(),
                run_id: None,
                owner_globs: vec!["src/ui/**".into()],
                task: "z".into(),
                depends_on: vec![],
                status: InstanceStatus::Pending,
            },
        ];
        let collisions = detect_glob_collisions(&instances);
        // a vs b overlap (a covers src/api/** which contains b's literal).
        assert_eq!(collisions.len(), 1);
        assert_eq!(collisions[0], ("a".to_string(), "b".to_string()));
    }

    #[test]
    fn p7_detect_glob_collisions_disjoint_returns_empty() {
        let instances = vec![
            RoleInstance {
                id: "a".into(),
                role: "builder".into(),
                run_id: None,
                owner_globs: vec!["src/api/**".into()],
                task: "x".into(),
                depends_on: vec![],
                status: InstanceStatus::Pending,
            },
            RoleInstance {
                id: "b".into(),
                role: "builder".into(),
                run_id: None,
                owner_globs: vec!["src/ui/**".into()],
                task: "y".into(),
                depends_on: vec![],
                status: InstanceStatus::Pending,
            },
            RoleInstance {
                id: "c".into(),
                role: "builder".into(),
                run_id: None,
                owner_globs: vec!["docs/**".into()],
                task: "z".into(),
                depends_on: vec![],
                status: InstanceStatus::Pending,
            },
        ];
        assert!(detect_glob_collisions(&instances).is_empty());
    }

    #[test]
    fn p7_detect_glob_collisions_skips_empty_owner_globs() {
        // An instance with no declared owner_globs participates in no
        // collisions. (Sequential templates run with empty globs and must
        // not hit detect_glob_collisions logic.)
        let instances = vec![
            RoleInstance {
                id: "a".into(),
                role: "builder".into(),
                run_id: None,
                owner_globs: vec!["src/**".into()],
                task: "x".into(),
                depends_on: vec![],
                status: InstanceStatus::Pending,
            },
            RoleInstance {
                id: "b".into(),
                role: "builder".into(),
                run_id: None,
                owner_globs: vec![], // no globs declared
                task: "y".into(),
                depends_on: vec![],
                status: InstanceStatus::Pending,
            },
        ];
        assert!(detect_glob_collisions(&instances).is_empty());
    }

    #[test]
    fn s1_abort_instance_marks_running_leg_failed_and_returns_run_id() {
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        let s = reg
            .swarm_start_coordinator(
                "ws-1",
                "test-coord",
                "x",
                &cwd,
                HashMap::new(),
                SwarmKind::Adhoc,
            )
            .unwrap();
        // Move to Dispatching with one running leg.
        {
            let mut cache = reg.cache.lock();
            let swarm = cache.get_mut(&s.id).unwrap();
            swarm.state = SwarmState::Dispatching {
                tick: 1,
                instances: vec![RoleInstance {
                    id: "leg-a".into(),
                    role: "builder".into(),
                    run_id: Some("run-A".into()),
                    owner_globs: vec![],
                    task: "x".into(),
                    depends_on: vec![],
                    status: InstanceStatus::Running,
                }],
            };
            let snap = swarm.clone();
            drop(cache);
            reg.persist(&snap).unwrap();
        }
        let returned = reg.abort_instance(&s.id, "leg-a").unwrap();
        assert_eq!(returned.as_deref(), Some("run-A"));
        // Instance is Failed; mailbox has an InstanceDone(failed) entry
        // from mark_instance_failed.
        let s2 = reg.get(&s.id).unwrap();
        match s2.state {
            SwarmState::Dispatching { instances, .. } => {
                let leg = instances.iter().find(|i| i.id == "leg-a").unwrap();
                assert_eq!(leg.status, InstanceStatus::Failed);
            }
            _ => panic!("expected Dispatching"),
        }
        let mailbox = reg.read_mailbox(&s.id, 0).unwrap();
        assert!(
            mailbox.iter().any(|e| {
                e.kind == MailboxKind::InstanceDone
                    && e.body
                        .as_ref()
                        .and_then(|b| b.get("status"))
                        .and_then(|v| v.as_str())
                        == Some("failed")
            }),
            "expected InstanceDone(failed) entry"
        );
    }

    #[test]
    fn s1_abort_instance_terminal_leg_is_noop_returns_none() {
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        let s = reg
            .swarm_start_coordinator(
                "ws-2",
                "test-coord",
                "x",
                &cwd,
                HashMap::new(),
                SwarmKind::Adhoc,
            )
            .unwrap();
        {
            let mut cache = reg.cache.lock();
            let swarm = cache.get_mut(&s.id).unwrap();
            swarm.state = SwarmState::Dispatching {
                tick: 1,
                instances: vec![RoleInstance {
                    id: "leg-done".into(),
                    role: "builder".into(),
                    run_id: Some("run-X".into()),
                    owner_globs: vec![],
                    task: "x".into(),
                    depends_on: vec![],
                    status: InstanceStatus::Done,
                }],
            };
            let snap = swarm.clone();
            drop(cache);
            reg.persist(&snap).unwrap();
        }
        // Already-Done leg → no-op, returns None.
        let returned = reg.abort_instance(&s.id, "leg-done").unwrap();
        assert!(returned.is_none());
        let s2 = reg.get(&s.id).unwrap();
        match s2.state {
            SwarmState::Dispatching { instances, .. } => {
                assert_eq!(instances[0].status, InstanceStatus::Done);
            }
            _ => panic!("expected Dispatching"),
        }
    }

    #[test]
    fn s1_abort_instance_rejects_when_swarm_not_in_dispatching() {
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        let s = reg
            .swarm_start("ws-3", "scout-build-review", "x", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc)
            .unwrap();
        let err = reg.abort_instance(&s.id, "ghost").unwrap_err();
        assert!(err.contains("Dispatching"), "got: {err}");
    }

    #[test]
    fn p6_record_instance_started_rejects_unknown_instance() {
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        let s = reg
            .swarm_start_coordinator(
                "ws-2",
                "test-coord",
                "do work",
                &cwd,
                HashMap::new(),
                SwarmKind::Adhoc,
            )
            .unwrap();
        {
            let mut cache = reg.cache.lock();
            let swarm = cache.get_mut(&s.id).unwrap();
            swarm.state = SwarmState::Dispatching {
                tick: 1,
                instances: vec![],
            };
            let snap = swarm.clone();
            drop(cache);
            reg.persist(&snap).unwrap();
        }
        let err = reg
            .record_instance_started(&s.id, "ghost", "run-x")
            .unwrap_err();
        assert!(err.contains("ghost"), "got: {err}");
    }

    #[test]
    fn p3_dispatching_all_done_advances_to_pending_coordinator_next_tick() {
        let tmpl = coordinator_template();
        let instances = vec![RoleInstance {
            id: "a".into(),
            role: "builder".into(),
            run_id: Some("run-a".into()),
            owner_globs: vec![],
            task: "x".into(),
            depends_on: vec![],
            status: InstanceStatus::Running,
        }];
        let outcome = RunOutcome {
            run_id: "run-a".into(),
            role: "builder".into(),
            status: STATUS_DONE.into(),
            artifact: None,
            error_msg: None,
            role_instance_id: Some("a".into()),
        };
        let t = next_fsm_state(
            &tmpl,
            &SwarmState::Dispatching { tick: 2, instances },
            2,
            &outcome,
        );
        match t {
            FsmTransition::Advance {
                next_state, next_role, new_iteration,
            } => {
                // v1.5.5: next_role is None on Dispatching → PendingCoordinator
                // because the post-transition coordinator-mode handler in
                // on_swarm_run_done is the canonical fire path. If this
                // were Some("coordinator"), the sequential Advance branch
                // would ALSO fire start_run → inflight collision →
                // swarm aborts (the v1.5.5 bug).
                assert!(next_role.is_none(), "next_role must be None on Dispatching → PendingCoordinator");
                assert_eq!(new_iteration, 3);
                assert_eq!(
                    next_state,
                    SwarmState::PendingCoordinator { tick: 3 }
                );
            }
            _ => panic!("expected Advance to PendingCoordinator"),
        }
    }

    /// v1.5.5 regression: every coordinator-mode FSM transition must
    /// return next_role: None. The orchestrator's post-transition handler
    /// owns the start_run for both PendingCoordinator and Dispatching
    /// states; if next_role were Some, the sequential Advance branch
    /// would ALSO fire start_run, causing an inflight collision that
    /// aborts the swarm.
    #[test]
    fn p6_coordinator_mode_transitions_never_set_next_role() {
        let tmpl = coordinator_template();

        // 1. PendingCoordinator → Dispatching (coordinator artifact parsed).
        let t = next_fsm_state(
            &tmpl,
            &SwarmState::PendingCoordinator { tick: 1 },
            1,
            &coord_outcome(
                "c1",
                serde_json::json!({
                    "tick": 1,
                    "done": false,
                    "dispatches": [{"instance":"b","role":"builder","task":"x"}]
                }),
            ),
        );
        match t {
            FsmTransition::Advance { next_role, .. } => {
                assert!(next_role.is_none(), "PendingCoordinator → Dispatching must return None");
            }
            _ => panic!("expected Advance"),
        }

        // 2. Dispatching → Dispatching (some legs still pending).
        let outcome = RunOutcome {
            run_id: "run-a".into(),
            role: "builder".into(),
            status: STATUS_DONE.into(),
            artifact: None,
            error_msg: None,
            role_instance_id: Some("a".into()),
        };
        let instances = vec![
            RoleInstance {
                id: "a".into(),
                role: "builder".into(),
                run_id: Some("run-a".into()),
                owner_globs: vec![],
                task: "x".into(),
                depends_on: vec![],
                status: InstanceStatus::Running,
            },
            RoleInstance {
                id: "b".into(),
                role: "builder".into(),
                run_id: None,
                owner_globs: vec![],
                task: "y".into(),
                depends_on: vec![],
                status: InstanceStatus::Pending,
            },
        ];
        let t = next_fsm_state(
            &tmpl,
            &SwarmState::Dispatching { tick: 1, instances },
            1,
            &outcome,
        );
        match t {
            FsmTransition::Advance { next_role, .. } => {
                assert!(next_role.is_none(), "Dispatching → Dispatching (still pending) must return None");
            }
            _ => panic!("expected Advance"),
        }

        // 3. Dispatching → PendingCoordinator (all done) — covered by the
        // dedicated p3_dispatching_all_done test; that test asserts the
        // same invariant.
    }

    #[test]
    fn state_machine_unexpected_role_in_state_terminates_failed() {
        let tmpl = feature_template();
        // Builder finishes while we expected scout — defensive guard.
        let t = next_fsm_state(
            &tmpl,
            &pending_step(0, "scout", &[]),
            0,
            &outcome("builder", "r2", STATUS_DONE),
        );
        match t {
            FsmTransition::Terminate { status, reason, .. } => {
                assert_eq!(status, SwarmStatus::Failed);
                assert!(reason.contains("unexpected role"), "got: {reason}");
            }
            _ => panic!("expected Terminate"),
        }
    }

    // ── Handoff payload (pure) ─────────────────────────

    use crate::snapshots::{ChangeKind, FileChange};

    fn change(path: &str, kind: ChangeKind) -> FileChange {
        FileChange {
            path: path.into(),
            kind,
            before: None,
            after: None,
            out_of_owned_globs: false,
        }
    }

    #[test]
    fn handoff_payload_just_goal_when_history_empty() {
        let p = build_handoff_payload("fix the bug", &[], None);
        assert_eq!(p, "fix the bug");
    }

    #[test]
    fn handoff_payload_includes_transcript_and_changes_and_artifact() {
        let changes = vec![
            change("src/foo.rs", ChangeKind::Modified),
            change("docs/bar.md", ChangeKind::Added),
            change("temp.txt", ChangeKind::Removed),
        ];
        let artifact = serde_json::json!({ "verdict": "approve", "critique": "lgtm" });
        let history = vec![PriorStep {
            role: "builder",
            transcript: "I edited foo.",
            changes: &changes,
            artifact: Some(&artifact),
        }];
        let p = build_handoff_payload("fix it", &history, None);
        assert!(p.starts_with("fix it"));
        assert!(p.contains("# Previous step: builder"));
        assert!(p.contains("I edited foo."));
        assert!(p.contains("- M src/foo.rs"));
        assert!(p.contains("- A docs/bar.md"));
        assert!(p.contains("- D temp.txt"));
        assert!(p.contains("\"verdict\""));
    }

    #[test]
    fn handoff_payload_truncates_transcript_at_cap() {
        let huge = "x".repeat(HANDOFF_TRANSCRIPT_CAP + 1024);
        let history = vec![PriorStep {
            role: "scout",
            transcript: &huge,
            changes: &[],
            artifact: None,
        }];
        let p = build_handoff_payload("g", &history, None);
        assert!(p.contains("[truncated 1024 bytes]"));
        // The transcript section must not exceed cap + marker.
        let transcript_section = &p[p.find("## Transcript\n").unwrap()..];
        assert!(transcript_section.len() < HANDOFF_TRANSCRIPT_CAP + 256);
    }

    #[test]
    fn handoff_payload_caps_files_changed_count() {
        let changes: Vec<_> = (0..HANDOFF_CHANGES_CAP + 5)
            .map(|i| change(&format!("file_{i}.rs"), ChangeKind::Modified))
            .collect();
        let history = vec![PriorStep {
            role: "builder",
            transcript: "x",
            changes: &changes,
            artifact: None,
        }];
        let p = build_handoff_payload("g", &history, None);
        assert!(p.contains("- ... [5 more]"));
        // Spot-check: file 0 listed, file (CAP+1) not listed.
        assert!(p.contains("- M file_0.rs"));
        assert!(!p.contains(&format!("- M file_{}.rs", HANDOFF_CHANGES_CAP + 1)));
    }

    #[test]
    fn handoff_payload_loopback_includes_multiple_prior_steps() {
        let scout_artifact = serde_json::json!({ "plan": "do it", "files_to_modify": [] });
        let review_artifact = serde_json::json!({ "verdict": "reject", "critique": "missed edge case" });
        let scout = PriorStep {
            role: "scout",
            transcript: "scouted",
            changes: &[],
            artifact: Some(&scout_artifact),
        };
        let prev_build = PriorStep {
            role: "builder",
            transcript: "first attempt",
            changes: &[],
            artifact: None,
        };
        let prev_review = PriorStep {
            role: "reviewer",
            transcript: "found issues",
            changes: &[],
            artifact: Some(&review_artifact),
        };
        let p = build_handoff_payload(
            "g",
            &[scout, prev_build, prev_review],
            Some(&format!(
                "/cwd/.atelier/swarm/{RUN_ID_PLACEHOLDER}/artifact.json"
            )),
        );
        // All three sections present, in order.
        let i_scout = p.find("# Previous step: scout").unwrap();
        let i_build = p.find("# Previous step: builder").unwrap();
        let i_review = p.find("# Previous step: reviewer").unwrap();
        assert!(i_scout < i_build && i_build < i_review);
        assert!(p.contains("missed edge case"));
        assert!(p.contains("\"plan\""));
        // Artifact path appended with the placeholder for start_run to substitute.
        assert!(p.contains("# Artifact path"));
        assert!(p.contains(RUN_ID_PLACEHOLDER));
    }

    // ── apply_run_done / record_run_started ────────────

    fn sample_summary(role: &str, run_id: &str, status: &str) -> RunSummary {
        RunSummary {
            run_id: run_id.into(),
            role: role.into(),
            status: status.into(),
            started_at: 1,
            ended_at: Some(2),
            exit_code: Some(0),
            bytes_written: 100,
            model: Some("claude-sonnet-4-7".into()),
            total_cost_usd: Some(0.001),
            files_changed_count: Some(1),
            throttled: false,
        }
    }

    #[test]
    fn record_run_started_appends_to_run_ids() {
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        let s = reg
            .swarm_start("ws-1", "scout-build-review", "x", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc)
            .unwrap();
        reg.record_run_started(&s.id, "run-A").unwrap();
        reg.record_run_started(&s.id, "run-B").unwrap();
        let after = reg.get(&s.id).unwrap();
        assert_eq!(after.run_ids, vec!["run-A".to_string(), "run-B".into()]);
    }

    #[test]
    fn apply_run_done_advance_updates_state_and_writes_report() {
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        let s = reg
            .swarm_start("ws-1", "scout-build-review", "x", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc)
            .unwrap();
        let transition = FsmTransition::Advance {
            next_state: pending_step(1, "builder", &["run-A"]),
            next_role: Some("builder".into()),
            new_iteration: 0,
        };
        let updated = reg
            .apply_run_done(
                &s.id,
                transition,
                sample_summary("scout", "run-A", "done"),
                None,
            )
            .unwrap();
        assert_eq!(updated.status, SwarmStatus::Running);
        match updated.state {
            SwarmState::PendingStep { idx, role, prior_run_ids } => {
                assert_eq!(idx, 1);
                assert_eq!(role, "builder");
                assert_eq!(prior_run_ids, vec!["run-A".to_string()]);
            }
            other => panic!("unexpected state {other:?}"),
        }
        let mailbox = reg.read_mailbox(&s.id, 0).unwrap();
        // created + report = 2 entries
        assert_eq!(mailbox.len(), 2);
        assert_eq!(mailbox[1].kind, MailboxKind::Report);
        assert_eq!(mailbox[1].run_id.as_deref(), Some("run-A"));
        assert!(mailbox[1].run_summary.is_some());
    }

    #[test]
    fn apply_run_done_terminate_writes_terminate_entry_and_artifact() {
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        let s = reg
            .swarm_start("ws-1", "scout-build-review", "x", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc)
            .unwrap();
        let artifact = serde_json::json!({ "verdict": "approve" });
        let transition = FsmTransition::Terminate {
            status: SwarmStatus::Done,
            state: SwarmState::Done,
            reason: "approved by reviewer".into(),
        };
        let updated = reg
            .apply_run_done(
                &s.id,
                transition,
                sample_summary("reviewer", "run-R", "done"),
                Some(artifact.clone()),
            )
            .unwrap();
        assert_eq!(updated.status, SwarmStatus::Done);
        assert_eq!(updated.end_reason.as_deref(), Some("approved by reviewer"));
        let mailbox = reg.read_mailbox(&s.id, 0).unwrap();
        // created + report + artifact + terminate = 4
        assert_eq!(mailbox.len(), 4);
        assert_eq!(mailbox[1].kind, MailboxKind::Report);
        assert_eq!(mailbox[2].kind, MailboxKind::Artifact);
        assert_eq!(mailbox[3].kind, MailboxKind::Terminate);
    }

    /// R3: apply_run_done is a no-op once the swarm is in a terminal state.
    /// Catches the abort-vs-completion + timeout-vs-completion races.
    #[test]
    fn apply_run_done_idempotent_on_terminal_states() {
        let (tmp, reg) = fresh_registry();
        let cwd = tmp.path().to_path_buf();
        let s = reg
            .swarm_start("ws-1", "scout-build-review", "x", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc)
            .unwrap();
        // First: user aborts.
        reg.abort(&s.id, "user aborted").unwrap();
        // Then: a stale run-done arrives (race between abort and natural completion).
        let transition = FsmTransition::Advance {
            next_state: pending_step(1, "builder", &["run-A"]),
            next_role: Some("builder".into()),
            new_iteration: 0,
        };
        let after = reg
            .apply_run_done(
                &s.id,
                transition,
                sample_summary("scout", "run-A", "done"),
                None,
            )
            .unwrap();
        // Status preserved; state preserved; no extra mailbox entries.
        assert_eq!(after.status, SwarmStatus::Aborted);
        assert_eq!(after.state, SwarmState::Aborted);
        let mailbox = reg.read_mailbox(&s.id, 0).unwrap();
        // created + terminate (from abort) = 2; the stale apply_run_done was a no-op.
        assert_eq!(mailbox.len(), 2);
    }

    // ── Role presets (pure seed) ───────────────────────

    #[test]
    fn role_preset_seed_returns_workspace_scoped_oneshot_for_each_role() {
        // v1.2.0: extended from the original 3 roles to the 6-role library.
        for role in ALL_ROLE_IDS {
            let seed = role_preset_seed(role, "ws-1").expect("preset");
            assert_eq!(seed.scope, crate::agents::AgentScope::Workspace);
            assert_eq!(seed.workspace_id.as_deref(), Some("ws-1"));
            assert_eq!(seed.runtime_mode, crate::agents::RuntimeMode::Oneshot);
            assert_eq!(seed.preset_id.as_deref(), Some(*role));
            assert!(!seed.system_prompt.is_empty(), "{role} preset has no system prompt");
            assert!(seed.tags.contains(&"swarm".to_string()));
            assert!(seed.tags.contains(&role.to_string()));
            // Notifications go through the swarm-completion event, not per-run.
            assert!(!seed.notify_on_done);
        }
    }

    #[test]
    fn role_preset_seed_returns_none_for_unknown_role() {
        assert!(role_preset_seed("planner", "ws-1").is_none());
    }

    #[test]
    fn role_preset_seed_v1_3_coordinator_has_dispatch_contract() {
        let coord = role_preset_seed("coordinator", "ws").unwrap();
        assert_eq!(coord.preset_id.as_deref(), Some("coordinator"));
        assert!(coord.name.contains("Coordinator"));
        // Critical: the prompt must articulate the structured artifact
        // shape (`dispatches`, `done`, `tick`) so claude emits parseable
        // output. Light substring checks; calibration may refine wording.
        assert!(coord.system_prompt.contains("dispatches"));
        assert!(coord.system_prompt.contains("done"));
        assert!(coord.system_prompt.contains("tick"));
        assert!(coord.system_prompt.contains("ownerGlobs"));
        assert!(coord.system_prompt.contains("dependsOn"));
        // Coordinator must NOT modify files itself.
        assert!(coord.system_prompt.contains("do NOT modify files")
            || coord.system_prompt.contains("not modify files"));
    }

    #[test]
    fn role_preset_seed_supports_critic() {
        let seed = role_preset_seed("critic", "ws-test").expect("critic seeded");
        assert_eq!(seed.preset_id.as_deref(), Some("critic"));
        assert!(!seed.system_prompt.is_empty());
        assert!(seed.tags.iter().any(|t| t == "critic"));
        // Adversarial framing: prompt must articulate the disagreement role
        // and the verdict JSON contract the FSM reads.
        assert!(seed.system_prompt.contains("Critic"));
        assert!(seed.system_prompt.contains("verdict"));
        assert!(seed.system_prompt.contains("objections"));
    }

    #[test]
    fn all_role_ids_includes_critic() {
        assert!(ALL_ROLE_IDS.contains(&"critic"));
    }

    #[test]
    fn swarm_loads_without_kind_defaulting_to_adhoc() {
        // v1.22.0: literal v1.21.x persisted Swarm shape — no `kind`
        // field. serde(default) must populate it with `Adhoc`. Migration
        // test per docs/PATTERNS.md Tier 2 rule (do NOT re-serialize the
        // current struct shape).
        let v1_21 = br#"{
            "id": "s-legacy",
            "workspaceId": "ws-1",
            "templateId": "feature",
            "goal": "x",
            "status": "running",
            "state": { "kind": "pending_step", "idx": 0, "role": "scout", "prior_run_ids": [] },
            "iteration": 0,
            "roleBindings": {},
            "runIds": [],
            "startedAt": 100
        }"#;
        let parsed: Swarm = serde_json::from_slice(v1_21).expect("legacy swarm loads");
        assert_eq!(parsed.kind, SwarmKind::Adhoc);
    }

    #[test]
    fn role_preset_seed_v1_2_new_roles_have_distinguishing_directives() {
        // v1.2.0: the 3 new roles ship with system prompts that articulate
        // their distinct concerns. Light substring assertion, not full
        // text equality, so future calibration can refine wording without
        // breaking the test.
        let architect = role_preset_seed("architect", "ws").unwrap();
        assert!(architect.name.contains("Architect"));
        assert!(architect.system_prompt.contains("design"));
        assert!(architect.system_prompt.contains("decision"));

        let ux_reviewer = role_preset_seed("ux-reviewer", "ws").unwrap();
        assert!(ux_reviewer.name.contains("UX Reviewer"));
        assert!(ux_reviewer.system_prompt.contains("user experience")
            || ux_reviewer.system_prompt.contains("UX"));
        // UX-reviewer's verdict shape mirrors the Reviewer's contract.
        assert!(ux_reviewer.system_prompt.contains("verdict"));

        let refactorer = role_preset_seed("refactorer", "ws").unwrap();
        assert!(refactorer.name.contains("Refactorer"));
        assert!(refactorer.system_prompt.contains("refactor")
            || refactorer.system_prompt.contains("Refactor"));
        // Critical: refactorer must NOT change observable behavior.
        assert!(refactorer.system_prompt.contains("behavior"));
    }

    #[test]
    fn scout_and_reviewer_prompts_mention_artifact_contract() {
        // The artifact contract is the FSM's branching primitive — the prompt
        // must instruct claude to write it. Reviewer's verdict in particular
        // is what flips Done vs MaxIter vs Failed.
        let scout = role_preset_seed("scout", "ws").unwrap();
        let reviewer = role_preset_seed("reviewer", "ws").unwrap();
        let builder = role_preset_seed("builder", "ws").unwrap();
        assert!(scout.system_prompt.contains("artifact"));
        assert!(scout.system_prompt.contains("plan"));
        assert!(reviewer.system_prompt.contains("artifact"));
        assert!(reviewer.system_prompt.contains("verdict"));
        // Builder produces the diff itself — the prompt tells it no artifact required.
        assert!(builder.system_prompt.contains("No structured artifact"));
    }

    // ── Orchestrator helpers (pure) ────────────────────

    // ── R5: wall-time helpers (pure) ───────────────────

    fn fixture_swarm(started_at_ms: i64, suspended_seconds: u64) -> Swarm {
        Swarm {
            schema_version: 1,
            id: "s".into(),
            workspace_id: "ws".into(),
            template_id: "t".into(),
            goal: "g".into(),
            status: SwarmStatus::Running,
            state: SwarmState::PendingStep {
                idx: 0,
                role: "scout".into(),
                prior_run_ids: Vec::new(),
            },
            kind: SwarmKind::Adhoc,
            iteration: 0,
            role_bindings: HashMap::new(),
            run_ids: vec![],
            started_at: started_at_ms,
            ended_at: None,
            end_reason: None,
            suspended_at: None,
            suspended_seconds,
            in_flight_role_at_suspend: None,
            in_flight_at_suspend: Vec::new(),
            cwd: String::new(),
            throttled: false,
        }
    }

    #[test]
    fn effective_wall_seconds_subtracts_suspended_time() {
        // R5: a swarm that ran for 25 min wall-clock + was suspended for
        // 8 hours should report 25 min effective wall time, not 8h25m.
        // Otherwise an 8h suspension would silently exhaust the 30-min
        // wall-time budget the moment the user resumes.
        let started = 0i64;
        let now = 25 * 60 * 1000; // 25 minutes elapsed.
        let suspended_secs = 8 * 3600; // 8 hours sat as Suspended.
        // The fixture pretends the suspended time was already accumulated
        // into suspended_seconds (which `resume_to_running` does on each
        // cycle).
        let swarm = fixture_swarm(started - (suspended_secs as i64 * 1000), suspended_secs);
        // started_at is shifted earlier by the suspended duration to
        // simulate "started 8h25m ago, but 8h of that was Suspended".
        let elapsed = effective_wall_seconds(&swarm, now);
        // Within ±1 sec of 25 minutes (1500s) for clock granularity.
        assert!(
            (1499..=1501).contains(&elapsed),
            "expected ~1500 effective seconds, got {elapsed}"
        );
    }

    #[test]
    fn effective_wall_seconds_zero_suspension_equals_total() {
        // Sanity check: a swarm that was never suspended has elapsed ==
        // (now - started_at) / 1000.
        let started = 0i64;
        let now = 1000 * 1000; // 1000 seconds.
        let swarm = fixture_swarm(started, 0);
        assert_eq!(effective_wall_seconds(&swarm, now), 1000);
    }

    #[test]
    fn effective_wall_seconds_saturates_at_zero() {
        // Defensive: if `now` is somehow earlier than `started_at` (clock
        // skew, manual time travel during testing, etc.), clamp to 0
        // rather than producing a negative elapsed.
        let swarm = fixture_swarm(now_millis(), 0);
        let earlier = swarm.started_at - 5000;
        assert_eq!(effective_wall_seconds(&swarm, earlier), 0);
    }

    #[test]
    fn wall_time_exceeded_pins_both_boundaries() {
        // R5: pin both directions of the boundary check, expressed relative
        // to MAX_WALL_SECONDS so the test survives cap changes (v1.31.0
        // raised it 1800 → 3600). Under → false; exactly at / over → true.
        let cap = MAX_WALL_SECONDS as i64;
        let mut swarm = fixture_swarm(0, 0);

        assert!(!wall_time_exceeded(&swarm, (cap - 1) * 1000, MAX_WALL_SECONDS));
        assert!(wall_time_exceeded(&swarm, cap * 1000, MAX_WALL_SECONDS));
        assert!(wall_time_exceeded(&swarm, (cap + 1) * 1000, MAX_WALL_SECONDS));

        // Suspended time covering most of the gap: should NOT exceed (the
        // whole point of R5 — a long suspension doesn't burn the budget).
        swarm.suspended_seconds = (cap as u64).saturating_sub(100);
        assert!(!wall_time_exceeded(&swarm, (cap + 1) * 1000, MAX_WALL_SECONDS));
    }

    #[test]
    fn wall_time_cap_keeps_a_terminal_done_but_caps_an_advance() {
        // v1.31.0 (Outcome screen fix): the incident — a Bugfix swarm whose
        // reviewer approved on the final leg at 1801s was mislabeled
        // TimedOut because the wall-cap clobbered the FSM's natural `Done`.
        // The cap must only override an `Advance`.
        let cap = MAX_WALL_SECONDS;
        let swarm = fixture_swarm(0, 0);
        let now_over = (cap as i64 + 5) * 1000;
        assert!(wall_time_exceeded(&swarm, now_over, cap));

        // Natural = Done (reviewer approved) → kept despite the cap.
        let done = FsmTransition::Terminate {
            status: SwarmStatus::Done,
            state: SwarmState::Done,
            reason: "approved by reviewer".into(),
        };
        match apply_wall_time_cap(done, &swarm, now_over, cap) {
            FsmTransition::Terminate { status, .. } => {
                assert_eq!(status, SwarmStatus::Done, "Done must survive the cap");
            }
            _ => panic!("expected a Terminate"),
        }

        // Natural = Advance past the cap → overridden to TimedOut.
        let advance = || FsmTransition::Advance {
            next_state: SwarmState::PendingStep {
                idx: 1,
                role: "builder".into(),
                prior_run_ids: Vec::new(),
            },
            next_role: Some("builder".into()),
            new_iteration: 1,
        };
        match apply_wall_time_cap(advance(), &swarm, now_over, cap) {
            FsmTransition::Terminate { status, .. } => {
                assert_eq!(status, SwarmStatus::TimedOut);
            }
            _ => panic!("an Advance past the cap must become TimedOut"),
        }

        // Advance under the cap → untouched.
        assert!(matches!(
            apply_wall_time_cap(advance(), &swarm, (cap as i64 - 5) * 1000, cap),
            FsmTransition::Advance { .. }
        ));
    }

    // ── Orchestrator helpers (pure) ────────────────────

    /// v1.2.0 (T4): resolve_template_or_fallback redirects the legacy
    /// "scout-build-review" id to "feature" + falls back to "feature" on
    /// any unknown id. Critical for v1.1→v1.2 upgrades and stale kanban
    /// card references.
    #[test]
    fn resolve_template_or_fallback_redirects_legacy_and_falls_back() {
        let tmp = tempdir().unwrap();
        let store = crate::swarm_templates::SwarmTemplatesStore::new(tmp.path().to_path_buf())
            .unwrap();

        // Legacy id → feature.
        let resolved = resolve_template_or_fallback(&store, "scout-build-review")
            .expect("legacy id resolves");
        assert_eq!(resolved.id, "feature");

        // v1.2 id → returns the matching builtin.
        let resolved = resolve_template_or_fallback(&store, "refactor").expect("refactor exists");
        assert_eq!(resolved.id, "refactor");
        assert_eq!(resolved.steps[1].role, "refactorer");

        // Unknown id → falls back to feature.
        let resolved = resolve_template_or_fallback(&store, "user-deleted-template-uuid")
            .expect("falls back to feature");
        assert_eq!(resolved.id, "feature");

        // ux-audit resolves correctly too. v1.5.11: collapsed to a single
        // ux-reviewer step (audit-as-deliverable, not build-and-review).
        let resolved =
            resolve_template_or_fallback(&store, "ux-audit").expect("ux-audit exists");
        assert_eq!(resolved.id, "ux-audit");
        assert_eq!(resolved.steps.len(), 1);
        assert_eq!(resolved.steps[0].role, "ux-reviewer");
    }

    /// v1.2.0 Tier 2: a v1.0/v1.1 SwarmState serialized as
    /// `pending_scout` / `pending_build { scout_run_id }` /
    /// `pending_review { scout_run_id, build_run_id }` deserializes
    /// cleanly into the equivalent `PendingStep`. Relies on the custom
    /// `Deserialize` impl on SwarmState. Covers the v1.1→v1.2 upgrade
    /// path where state.json files are still on disk in the old shape.
    #[test]
    fn legacy_swarm_state_kinds_deserialize_into_pending_step() {
        let v1_scout = br#"{"kind": "pending_scout"}"#;
        let parsed: SwarmState = serde_json::from_slice(v1_scout).unwrap();
        assert_eq!(parsed, pending_step(0, "scout", &[]));

        let v1_build = br#"{"kind": "pending_build", "scout_run_id": "scout-1"}"#;
        let parsed: SwarmState = serde_json::from_slice(v1_build).unwrap();
        assert_eq!(parsed, pending_step(1, "builder", &["scout-1"]));

        let v1_review = br#"{
            "kind": "pending_review",
            "scout_run_id": "scout-1",
            "build_run_id": "build-1"
        }"#;
        let parsed: SwarmState = serde_json::from_slice(v1_review).unwrap();
        assert_eq!(parsed, pending_step(2, "reviewer", &["scout-1", "build-1"]));

        // New shape also round-trips.
        let v1_2 = br#"{
            "kind": "pending_step",
            "idx": 2,
            "role": "reviewer",
            "prior_run_ids": ["a", "b"]
        }"#;
        let parsed: SwarmState = serde_json::from_slice(v1_2).unwrap();
        assert_eq!(parsed, pending_step(2, "reviewer", &["a", "b"]));

        // Terminal kinds keep working too.
        let done = br#"{"kind": "done"}"#;
        let parsed: SwarmState = serde_json::from_slice(done).unwrap();
        assert_eq!(parsed, SwarmState::Done);
    }

    #[test]
    fn derive_role_from_state_maps_active_states() {
        assert_eq!(
            derive_role_from_state(&pending_step(0, "scout", &[])),
            Some("scout".to_string())
        );
        assert_eq!(
            derive_role_from_state(&pending_step(1, "builder", &["x"])),
            Some("builder".to_string())
        );
        assert_eq!(
            derive_role_from_state(&pending_step(2, "reviewer", &["x", "y"])),
            Some("reviewer".to_string())
        );
        // Terminal states return None — orchestrator early-returns before this point.
        assert!(derive_role_from_state(&SwarmState::Done).is_none());
        assert!(derive_role_from_state(&SwarmState::Aborted).is_none());
        assert!(derive_role_from_state(&SwarmState::MaxIter).is_none());
    }

    /// v1.5.3 regression test: PendingCoordinator + Dispatching states
    /// must label as "coordinator" so on_swarm_run_done's fallback path
    /// can build the RunOutcome instead of bailing. Without this fix,
    /// every coordinator-mode swarm froze in PendingCoordinator after
    /// its first coordinator run completed.
    #[test]
    fn derive_role_from_state_handles_coordinator_mode_states() {
        assert_eq!(
            derive_role_from_state(&SwarmState::PendingCoordinator { tick: 1 }),
            Some("coordinator".to_string())
        );
        assert_eq!(
            derive_role_from_state(&SwarmState::PendingCoordinator { tick: 7 }),
            Some("coordinator".to_string())
        );
        assert_eq!(
            derive_role_from_state(&SwarmState::Dispatching {
                tick: 2,
                instances: vec![],
            }),
            Some("coordinator".to_string())
        );
    }

    #[test]
    fn role_for_agent_id_reverses_role_bindings() {
        let mut bindings = HashMap::new();
        bindings.insert("scout".to_string(), "agent-S".to_string());
        bindings.insert("builder".to_string(), "agent-B".to_string());
        bindings.insert("reviewer".to_string(), "agent-R".to_string());
        let swarm = Swarm {
            schema_version: 1,
            id: "s1".into(),
            workspace_id: "ws".into(),
            template_id: "t".into(),
            goal: "g".into(),
            status: SwarmStatus::Running,
            state: SwarmState::PendingStep {
                idx: 0,
                role: "scout".into(),
                prior_run_ids: Vec::new(),
            },
            kind: SwarmKind::Adhoc,
            iteration: 0,
            role_bindings: bindings,
            run_ids: vec![],
            started_at: 0,
            ended_at: None,
            end_reason: None,
            suspended_at: None,
            suspended_seconds: 0,
            in_flight_role_at_suspend: None,
            in_flight_at_suspend: Vec::new(),
            cwd: String::new(),
            throttled: false,
        };
        assert_eq!(role_for_agent_id(&swarm, "agent-S").as_deref(), Some("scout"));
        assert_eq!(role_for_agent_id(&swarm, "agent-B").as_deref(), Some("builder"));
        assert_eq!(role_for_agent_id(&swarm, "agent-R").as_deref(), Some("reviewer"));
        assert!(role_for_agent_id(&swarm, "agent-Unknown").is_none());
    }

    #[test]
    fn legacy_swarm_loads_with_defaults() {
        // Tier 2: pre-shipping a hypothetical pre-v1.0.x swarm record (which
        // doesn't actually exist in any release) — verifies serde defaults
        // for forward compat if we ever ship a 1.0.x bug fix that adds a
        // field. Belt-and-braces; same pattern as the existing kanban /
        // settings fixture tests.
        let json = br#"{
            "id": "s1",
            "workspaceId": "ws-1",
            "templateId": "scout-build-review",
            "goal": "x",
            "status": "running",
            "state": { "kind": "pending_scout" },
            "startedAt": 100
        }"#;
        let parsed: Swarm = serde_json::from_slice(json).expect("parse");
        assert_eq!(parsed.id, "s1");
        assert_eq!(parsed.iteration, 0);
        assert!(parsed.role_bindings.is_empty());
        assert!(parsed.ended_at.is_none());
        // R1 (resumable swarms): the three new fields default cleanly on
        // legacy state.json that predates v1.1.0.
        assert!(parsed.suspended_at.is_none());
        assert_eq!(parsed.suspended_seconds, 0);
        assert!(parsed.in_flight_role_at_suspend.is_none());
        // P1 (v1.3.0): the new in_flight_at_suspend Vec defaults to empty
        // for any state.json predating v1.3.
        assert!(parsed.in_flight_at_suspend.is_empty());
    }

    /// P1 (v1.3.0): v1.0 / v1.1 / v1.2 state.json fixtures that lack the
    /// `in_flight_at_suspend` Vec must load with an empty Vec via
    /// `serde(default)`. Three flavors covering each pre-v1.3 release.
    #[test]
    fn p1_v1_0_state_json_loads_with_empty_in_flight_at_suspend_vec() {
        // v1.0 shape: pending_scout literal, no v1.1.0 resumable fields.
        let v1_0 = br#"{
            "id": "s",
            "workspaceId": "ws",
            "templateId": "scout-build-review",
            "goal": "g",
            "status": "running",
            "state": { "kind": "pending_scout" },
            "startedAt": 0
        }"#;
        let parsed: Swarm = serde_json::from_slice(v1_0).expect("v1.0 parses");
        assert!(parsed.in_flight_at_suspend.is_empty());

        // v1.1 shape: suspended swarm with the legacy single-string field.
        let v1_1 = br#"{
            "id": "s",
            "workspaceId": "ws",
            "templateId": "scout-build-review",
            "goal": "g",
            "status": "suspended",
            "state": { "kind": "pending_build", "scout_run_id": "scout-1" },
            "startedAt": 100,
            "suspendedAt": 200,
            "suspendedSeconds": 30,
            "inFlightRoleAtSuspend": "builder"
        }"#;
        let parsed: Swarm = serde_json::from_slice(v1_1).expect("v1.1 parses");
        assert_eq!(parsed.suspended_seconds, 30);
        assert_eq!(parsed.in_flight_role_at_suspend.as_deref(), Some("builder"));
        // v1.3 schema-additive field defaults to empty.
        assert!(parsed.in_flight_at_suspend.is_empty());

        // v1.2 shape: pending_step with role + prior_run_ids.
        let v1_2 = br#"{
            "id": "s",
            "workspaceId": "ws",
            "templateId": "feature",
            "goal": "g",
            "status": "running",
            "state": {
                "kind": "pending_step",
                "idx": 1,
                "role": "builder",
                "prior_run_ids": ["scout-1"]
            },
            "startedAt": 0
        }"#;
        let parsed: Swarm = serde_json::from_slice(v1_2).expect("v1.2 parses");
        assert!(parsed.in_flight_at_suspend.is_empty());
    }

    /// P1 (v1.3.0): the new SwarmState variants round-trip through
    /// serde — including via the custom Deserialize impl which has been
    /// extended to handle pending_coordinator + dispatching kinds.
    #[test]
    fn p1_v1_3_swarm_state_variants_round_trip() {
        // PendingCoordinator { tick: 0 }
        let coord = serde_json::json!({ "kind": "pending_coordinator", "tick": 0 });
        let parsed: SwarmState = serde_json::from_value(coord).expect("coord parses");
        assert_eq!(parsed, SwarmState::PendingCoordinator { tick: 0 });

        // Dispatching { tick: 2, instances: [] }
        let dispatch_empty = serde_json::json!({
            "kind": "dispatching",
            "tick": 2,
            "instances": []
        });
        let parsed: SwarmState =
            serde_json::from_value(dispatch_empty).expect("dispatching parses");
        match parsed {
            SwarmState::Dispatching { tick, instances } => {
                assert_eq!(tick, 2);
                assert!(instances.is_empty());
            }
            _ => panic!("expected Dispatching"),
        }

        // Dispatching with one instance.
        let dispatch_one = serde_json::json!({
            "kind": "dispatching",
            "tick": 1,
            "instances": [{
                "id": "builder-api",
                "role": "builder",
                "task": "implement /api/x",
                "ownerGlobs": ["src-tauri/src/api/**"],
                "dependsOn": [],
                "status": "pending"
            }]
        });
        let parsed: SwarmState =
            serde_json::from_value(dispatch_one).expect("dispatching with leg parses");
        match parsed {
            SwarmState::Dispatching { tick, instances } => {
                assert_eq!(tick, 1);
                assert_eq!(instances.len(), 1);
                assert_eq!(instances[0].id, "builder-api");
                assert_eq!(instances[0].status, InstanceStatus::Pending);
                assert_eq!(instances[0].owner_globs, vec!["src-tauri/src/api/**"]);
            }
            _ => panic!("expected Dispatching"),
        }
    }

    /// P1 (v1.3.0): the four new MailboxKind variants serialize / deserialize
    /// round-trip cleanly. Pairs with the existing `MailboxKind::Suspend` /
    /// `Resume` round-trip test.
    #[test]
    fn p1_v1_3_mailbox_kinds_round_trip() {
        let kinds = [
            MailboxKind::CoordinatorTick,
            MailboxKind::InstanceStarted,
            MailboxKind::InstanceDone,
            MailboxKind::Collision,
        ];
        for k in kinds {
            let s = serde_json::to_string(&k).unwrap();
            let back: MailboxKind = serde_json::from_str(&s).unwrap();
            assert_eq!(k, back, "{k:?} round-trips");
        }
        // Sanity: serde uses snake_case names (matches the pre-existing
        // suspend/resume conventions).
        assert_eq!(
            serde_json::to_string(&MailboxKind::CoordinatorTick).unwrap(),
            "\"coordinator_tick\""
        );
        assert_eq!(
            serde_json::to_string(&MailboxKind::InstanceStarted).unwrap(),
            "\"instance_started\""
        );
    }

    /// P1 (v1.3.0): a v1.3 state.json with `in_flight_at_suspend` populated
    /// (fan-out suspend path) round-trips — the legacy single-string
    /// `inFlightRoleAtSuspend` is allowed to be absent or null.
    #[test]
    fn p1_v1_3_swarm_with_in_flight_at_suspend_round_trips() {
        let json = br#"{
            "id": "s",
            "workspaceId": "ws",
            "templateId": "feature",
            "goal": "g",
            "status": "suspended",
            "state": { "kind": "dispatching", "tick": 1, "instances": [] },
            "startedAt": 100,
            "inFlightAtSuspend": [{
                "id": "builder-api",
                "role": "builder",
                "runId": "run-A",
                "ownerGlobs": ["src-tauri/src/api/**"],
                "task": "implement healthz",
                "dependsOn": [],
                "status": "running"
            }, {
                "id": "builder-ui",
                "role": "builder",
                "runId": null,
                "ownerGlobs": ["src/components/Dashboard/**"],
                "task": "render dashboard tile",
                "dependsOn": ["builder-api"],
                "status": "pending"
            }]
        }"#;
        let parsed: Swarm = serde_json::from_slice(json).expect("v1.3 parses");
        assert_eq!(parsed.in_flight_at_suspend.len(), 2);
        assert_eq!(parsed.in_flight_at_suspend[0].id, "builder-api");
        assert_eq!(parsed.in_flight_at_suspend[0].status, InstanceStatus::Running);
        assert_eq!(parsed.in_flight_at_suspend[1].depends_on, vec!["builder-api"]);
    }

    // ── v1.1.1: wall-time enforcement ──────────────────

    /// Helper for v1.1.1 wall-time tests: starts a swarm, then mutates the
    /// persisted state.json to backdate `started_at` by `secs_ago` seconds
    /// and overwrite `suspended_seconds`. Reloads the registry so the cache
    /// reflects the on-disk values. Mirrors the test pattern at
    /// `swarm_start_creates_persisted_record_and_mailbox_entry` for round-tripping.
    fn registry_with_backdated_swarm(
        secs_ago: u64,
        suspended_seconds: u64,
        status: SwarmStatus,
    ) -> (tempfile::TempDir, SwarmRegistry, String) {
        use tempfile::tempdir;
        let tmp = tempdir().unwrap();
        let cfg = tmp.path().to_path_buf();
        let cwd = tmp.path().to_path_buf();
        let reg = SwarmRegistry::new(cfg.clone()).unwrap();
        let s = reg
            .swarm_start("ws-wt", "scout-build-review", "wall-time test", &cwd, HashMap::new(), "scout", SwarmKind::Adhoc)
            .expect("start");
        let id = s.id.clone();

        // Edit state.json: backdate started_at, set suspended_seconds, status.
        let path = cfg.join(SWARMS_SUBDIR).join(&id).join(STATE_FILE);
        let bytes = std::fs::read(&path).unwrap();
        let mut json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let new_started = now_millis() - (secs_ago as i64 * 1000);
        json["startedAt"] = serde_json::Value::from(new_started);
        json["suspendedSeconds"] = serde_json::Value::from(suspended_seconds);
        json["status"] = serde_json::Value::from(match status {
            SwarmStatus::Running => "running",
            SwarmStatus::Done => "done",
            SwarmStatus::Failed => "failed",
            SwarmStatus::Aborted => "aborted",
            SwarmStatus::TimedOut => "timed_out",
            SwarmStatus::MaxIter => "max_iter",
            SwarmStatus::Suspended => "suspended",
        });
        std::fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();

        // Reload to pick up the backdated values.
        let reg2 = SwarmRegistry::new(cfg).unwrap();
        (tmp, reg2, id)
    }

    #[test]
    fn wall_time_exceeded_swarms_returns_running_exceeders() {
        // Just over the cap, never suspended → should appear. Expressed
        // relative to MAX_WALL_SECONDS so it survives cap changes.
        let (_tmp, reg, id) =
            registry_with_backdated_swarm(MAX_WALL_SECONDS + 60, 0, SwarmStatus::Running);
        let exceeded = reg.wall_time_exceeded_swarms();
        assert_eq!(exceeded.len(), 1, "expected 1 exceeded swarm, got {exceeded:?}");
        assert_eq!(exceeded[0].0, id);
    }

    #[test]
    fn wall_time_exceeded_swarms_under_cap_returns_empty() {
        // Just under the cap.
        let (_tmp, reg, _id) =
            registry_with_backdated_swarm(MAX_WALL_SECONDS - 60, 0, SwarmStatus::Running);
        assert!(reg.wall_time_exceeded_swarms().is_empty());
    }

    #[test]
    fn wall_time_exceeded_swarms_skips_non_running() {
        // Well past the cap, but status is Suspended. wall-time enforcement
        // only applies to Running swarms — Suspended ones go through the
        // staleness path (24h cutoff).
        let (_tmp, reg, _id) =
            registry_with_backdated_swarm(MAX_WALL_SECONDS + 600, 0, SwarmStatus::Suspended);
        assert!(reg.wall_time_exceeded_swarms().is_empty());
    }

    #[test]
    fn wall_time_exceeded_swarms_subtracts_suspended_seconds() {
        // 60 min wall-clock, but 35 min was Suspended → effective = 25 min < cap.
        // Re-uses the helper-on-helper invariant from
        // `effective_wall_seconds_subtracts_suspended_time`.
        let (_tmp, reg, _id) =
            registry_with_backdated_swarm(60 * 60, 35 * 60, SwarmStatus::Running);
        assert!(
            reg.wall_time_exceeded_swarms().is_empty(),
            "an 8h suspension must NOT burn the wall-time budget"
        );
    }

    #[test]
    fn time_out_for_wall_time_flips_running_to_timed_out() {
        let (_tmp, reg, id) =
            registry_with_backdated_swarm(31 * 60, 0, SwarmStatus::Running);
        reg.time_out_for_wall_time(&id).expect("time_out");
        let s = reg.get(&id).expect("swarm exists");
        assert_eq!(s.status, SwarmStatus::TimedOut);
        assert_eq!(s.state, SwarmState::TimedOut);
        assert!(s.ended_at.is_some());
        assert!(
            s.end_reason.as_deref().unwrap().starts_with("exceeded wall_time after"),
            "got reason: {:?}",
            s.end_reason
        );

        // Mailbox: the terminate entry was appended.
        let mailbox = reg.read_mailbox(&id, 0).unwrap();
        assert_eq!(mailbox.last().map(|e| e.kind), Some(MailboxKind::Terminate));
        let last = mailbox.last().unwrap();
        let body_reason = last.body.as_ref().and_then(|b| b.get("reason"));
        assert!(
            body_reason.and_then(|v| v.as_str()).map(|r| r.contains("wall_time")).unwrap_or(false),
            "expected 'wall_time' in terminate body reason, got {:?}",
            body_reason
        );
    }

    #[test]
    fn time_out_for_wall_time_is_idempotent_on_terminal() {
        let (_tmp, reg, id) =
            registry_with_backdated_swarm(31 * 60, 0, SwarmStatus::Running);
        reg.time_out_for_wall_time(&id).expect("first call");
        // Second call should be a no-op (status != Running).
        reg.time_out_for_wall_time(&id).expect("second call no-ops");
        let s = reg.get(&id).expect("swarm exists");
        assert_eq!(s.status, SwarmStatus::TimedOut);
        let mailbox = reg.read_mailbox(&id, 0).unwrap();
        // Exactly one Terminate entry — second call did not duplicate it.
        let terminate_count = mailbox
            .iter()
            .filter(|e| e.kind == MailboxKind::Terminate)
            .count();
        assert_eq!(terminate_count, 1, "expected idempotent; got {terminate_count} terminate entries");
    }

    // ── v1.28.0 (Cycle I-2): orphan-swarm-dir GC ───────────

    /// Write a minimal valid state.json under `<swarms_dir>/<id>/` so that
    /// `gc_orphan_swarm_dirs` / `gc_swarms_for_deleted_card` can classify
    /// the dir. Keeps the fixture tiny — only `kind`, `status`, and
    /// `ended_at` are load-bearing for the GC paths. Returns the path the
    /// state.json was written to.
    fn write_minimal_state_json(
        swarms_dir: &Path,
        id: &str,
        kind: &str,
        status: &str,
        ended: bool,
    ) -> PathBuf {
        let dir = swarms_dir.join(id);
        fs::create_dir_all(&dir).unwrap();
        // Terminal `state` shape: `{"kind": "done"}` matches `SwarmState::Done`.
        // For running fixtures, use `pending_step` with the canonical fields.
        let state_blob = if ended {
            r#"{"kind":"done"}"#
        } else {
            r#"{"kind":"pending_step","idx":0,"role":"scout","prior_run_ids":[]}"#
        };
        let ended_field = if ended {
            r#","endedAt":1700000000001"#
        } else {
            ""
        };
        let body = format!(
            r#"{{"schemaVersion":1,"id":"{id}","workspaceId":"ws-test","templateId":"scout-build-review","goal":"gc test","status":"{status}","state":{state_blob},"kind":"{kind}","iteration":0,"roleBindings":{{}},"runIds":[],"startedAt":1700000000000{ended_field}}}"#
        );
        let path = dir.join(STATE_FILE);
        fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn gc_orphan_swarm_dirs_deletes_when_not_referenced() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path().to_path_buf();
        let reg = SwarmRegistry::new(cfg.clone()).unwrap();
        let swarms_dir = cfg.join(SWARMS_SUBDIR);
        write_minimal_state_json(&swarms_dir, "brainstorm-1", "brainstorm", "done", true);
        let live = std::collections::HashSet::new();
        let (kept, deleted) = reg.gc_orphan_swarm_dirs(&live);
        assert_eq!(kept, 0);
        assert_eq!(deleted, 1);
        assert!(!swarms_dir.join("brainstorm-1").exists());
    }

    #[test]
    fn gc_orphan_swarm_dirs_preserves_adhoc_kind() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path().to_path_buf();
        let reg = SwarmRegistry::new(cfg.clone()).unwrap();
        let swarms_dir = cfg.join(SWARMS_SUBDIR);
        write_minimal_state_json(&swarms_dir, "adhoc-1", "adhoc", "done", true);
        let live = std::collections::HashSet::new();
        let (kept, deleted) = reg.gc_orphan_swarm_dirs(&live);
        assert_eq!(kept, 1, "adhoc must survive empty live set");
        assert_eq!(deleted, 0);
        assert!(swarms_dir.join("adhoc-1").exists());
    }

    #[test]
    fn gc_orphan_swarm_dirs_preserves_when_in_live_set() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path().to_path_buf();
        let reg = SwarmRegistry::new(cfg.clone()).unwrap();
        let swarms_dir = cfg.join(SWARMS_SUBDIR);
        write_minimal_state_json(&swarms_dir, "brainstorm-2", "brainstorm", "done", true);
        let mut live = std::collections::HashSet::new();
        live.insert("brainstorm-2".to_string());
        let (kept, deleted) = reg.gc_orphan_swarm_dirs(&live);
        assert_eq!(kept, 1);
        assert_eq!(deleted, 0);
        assert!(swarms_dir.join("brainstorm-2").exists());
    }

    #[test]
    fn gc_orphan_swarm_dirs_keeps_corrupt_state_conservatively() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path().to_path_buf();
        let reg = SwarmRegistry::new(cfg.clone()).unwrap();
        let swarms_dir = cfg.join(SWARMS_SUBDIR);
        let dir = swarms_dir.join("corrupt-1");
        fs::create_dir_all(&dir).unwrap();
        // Truncated JSON — same failure mode as a crash mid-write.
        fs::write(dir.join(STATE_FILE), br#"{ "kind": "br"#).unwrap();
        let live = std::collections::HashSet::new();
        let (kept, deleted) = reg.gc_orphan_swarm_dirs(&live);
        assert_eq!(kept, 1, "unclassifiable dir must survive (conservative)");
        assert_eq!(deleted, 0);
        assert!(swarms_dir.join("corrupt-1").exists());
    }

    #[test]
    fn gc_orphan_swarm_dirs_skips_files_at_root() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path().to_path_buf();
        let reg = SwarmRegistry::new(cfg.clone()).unwrap();
        let swarms_dir = cfg.join(SWARMS_SUBDIR);
        fs::create_dir_all(&swarms_dir).unwrap();
        // A stray file at the swarms-dir root — must not be touched.
        fs::write(swarms_dir.join("README.txt"), b"keep me").unwrap();
        let live = std::collections::HashSet::new();
        let (kept, deleted) = reg.gc_orphan_swarm_dirs(&live);
        assert_eq!(kept, 0);
        assert_eq!(deleted, 0);
        assert!(swarms_dir.join("README.txt").exists());
    }

    // ── v1.28.0 (Cycle I-2): per-card cascade GC ───────────

    #[test]
    fn gc_swarms_for_deleted_card_deletes_terminal_card_swarm() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path().to_path_buf();
        let reg = SwarmRegistry::new(cfg.clone()).unwrap();
        let swarms_dir = cfg.join(SWARMS_SUBDIR);
        write_minimal_state_json(&swarms_dir, "card-swarm-1", "card", "done", true);
        let res = reg.gc_swarms_for_deleted_card(
            &["card-swarm-1".to_string()],
            &std::collections::HashSet::new(),
        );
        assert_eq!(res.deleted, vec!["card-swarm-1".to_string()]);
        assert!(res.refused_running.is_empty());
        assert!(res.refused_other.is_empty());
        assert!(!swarms_dir.join("card-swarm-1").exists());
    }

    #[test]
    fn gc_swarms_for_deleted_card_refuses_running() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path().to_path_buf();
        let reg = SwarmRegistry::new(cfg.clone()).unwrap();
        let swarms_dir = cfg.join(SWARMS_SUBDIR);
        // Brainstorm still running: status=running AND ended=false.
        write_minimal_state_json(&swarms_dir, "running-1", "brainstorm", "running", false);
        let res = reg.gc_swarms_for_deleted_card(
            &["running-1".to_string()],
            &std::collections::HashSet::new(),
        );
        assert!(res.deleted.is_empty());
        assert_eq!(res.refused_running, vec!["running-1".to_string()]);
        assert!(res.refused_other.is_empty());
        assert!(swarms_dir.join("running-1").exists());
    }

    #[test]
    fn gc_swarms_for_deleted_card_refuses_adhoc() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path().to_path_buf();
        let reg = SwarmRegistry::new(cfg.clone()).unwrap();
        let swarms_dir = cfg.join(SWARMS_SUBDIR);
        write_minimal_state_json(&swarms_dir, "adhoc-2", "adhoc", "done", true);
        let res = reg.gc_swarms_for_deleted_card(
            &["adhoc-2".to_string()],
            &std::collections::HashSet::new(),
        );
        assert!(res.deleted.is_empty());
        assert!(res.refused_running.is_empty());
        assert_eq!(res.refused_other, vec!["adhoc-2".to_string()]);
        assert!(swarms_dir.join("adhoc-2").exists());
    }

    #[test]
    fn gc_swarms_for_deleted_card_refuses_when_still_referenced() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = tmp.path().to_path_buf();
        let reg = SwarmRegistry::new(cfg.clone()).unwrap();
        let swarms_dir = cfg.join(SWARMS_SUBDIR);
        write_minimal_state_json(&swarms_dir, "shared-1", "brainstorm", "done", true);
        let mut still = std::collections::HashSet::new();
        still.insert("shared-1".to_string());
        let res = reg.gc_swarms_for_deleted_card(&["shared-1".to_string()], &still);
        assert!(res.deleted.is_empty());
        assert!(res.refused_running.is_empty());
        assert_eq!(res.refused_other, vec!["shared-1".to_string()]);
        assert!(swarms_dir.join("shared-1").exists());
    }
}
