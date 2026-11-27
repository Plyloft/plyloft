//! Agent collaboration Phase 2 — single-process session and handoff owner.
//!
//! All coordination mutations live in the Tauri backend under one mutex and
//! atomically replace `<config>/coordination/state.json`. `ply-collab`
//! contains the mutation-free schema/reader shared with the MCP sidecar.

use parking_lot::Mutex;
use ply_collab::{
    coordination_path, recent_handoffs_from_state, validate_state, workspace_status_from_state,
    CoordinationReader, CoordinationState,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

pub use ply_collab::{
    Attendance, CapabilityLevel, CoordinationWarning, Enforcement, ExecutionKind, HandoffRecord,
    IdentityPath, ProjectContext, ProjectRelevance, Provider, RetentionClass, SessionRecord,
    SessionStatus, WorkspaceCoordinationStatus, WriteIntent, COORDINATION_SCHEMA_VERSION,
};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const EPHEMERAL_OK_DAYS: i64 = 1;
const EPHEMERAL_ABNORMAL_DAYS: i64 = 7;
const INTERACTIVE_OK_DAYS: i64 = 14;
const INTERACTIVE_ABNORMAL_DAYS: i64 = 30;
const UNATTENDED_OK_DAYS: i64 = 30;
const UNATTENDED_ABNORMAL_DAYS: i64 = 60;
const HANDOFF_DAYS: i64 = 90;
const EPHEMERAL_CAP: usize = 250;
const INTERACTIVE_CAP: usize = 1_000;
const UNATTENDED_CAP: usize = 2_000;
const HANDOFF_CAP: usize = 1_000;
const ERROR_MAX_CHARS: usize = 1_000;
const OBJECTIVE_MAX_CHARS: usize = 512;
const OBSERVED_WARNING_CAP: usize = 20;
const HANDOFF_PATH_CAP: usize = 100;
const HANDOFF_ARTIFACT_MAX_BYTES: usize = 32 * 1024;
pub const COORDINATION_BUSY_PREFIX: &str = "PLY_COORDINATION_BUSY:";

#[derive(Debug, Clone)]
pub struct HandoffInput {
    pub run_id: String,
    pub card_id: Option<String>,
    pub failure: Option<String>,
    pub snapshot_run_id: Option<String>,
    pub changed_paths: Vec<String>,
    pub changes_truncated: bool,
    pub swarm_collisions: u32,
    pub reviewer_artifact: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpawnProject {
    Project { workspace_id: String, cwd: PathBuf },
    NonProject { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnIntent {
    pub provider: Provider,
    pub execution_kind: ExecutionKind,
    pub attendance: Attendance,
    pub write_intent: WriteIntent,
    pub enforcement: Enforcement,
    pub project: SpawnProject,
    pub capability: Option<CapabilityLevel>,
    pub card_id: Option<String>,
    pub swarm_id: Option<String>,
    pub role_id: Option<String>,
    pub run_id: Option<String>,
    pub retention_class: RetentionClass,
    pub objective: Option<String>,
}

impl SpawnIntent {
    pub fn validate(&self) -> Result<(), String> {
        if self.attendance == Attendance::Unattended && self.write_intent == WriteIntent::Unknown {
            return Err("unattended session must declare read-only or writer intent".to_string());
        }
        let expected = match &self.project {
            SpawnProject::NonProject { .. } => Enforcement::Exempt,
            SpawnProject::Project { .. }
                if self.attendance == Attendance::Unattended
                    && self.write_intent == WriteIntent::Writer =>
            {
                Enforcement::Exclusive
            }
            SpawnProject::Project { .. } => Enforcement::Advisory,
        };
        if self.enforcement != expected {
            return Err(format!(
                "invalid enforcement {:?}; {:?} required for {:?} + {:?}",
                self.enforcement, expected, self.attendance, self.write_intent
            ));
        }
        Ok(())
    }

    /// OB-3: whether the spawn gets a coordination record. Setup's guided
    /// terminal does not: it belongs to no project, is never shown as a
    /// session, and persisting its kind would make an older Ply (downgrade)
    /// fail to parse `coordination/state.json` and refuse to start.
    pub fn recorded(&self) -> bool {
        self.execution_kind != ExecutionKind::Setup
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriterConflict {
    pub worktree_key: String,
    pub active_session_id: String,
    pub active_execution_kind: ExecutionKind,
}

pub fn encode_writer_busy(conflict: &WriterConflict) -> String {
    let payload = serde_json::to_string(conflict).unwrap_or_else(|_| {
        r#"{"worktreeKey":"","activeSessionId":"","activeExecutionKind":"internal"}"#.to_string()
    });
    format!("{COORDINATION_BUSY_PREFIX}{payload}")
}

pub fn decode_writer_busy(error: &str) -> Option<WriterConflict> {
    let payload = error.strip_prefix(COORDINATION_BUSY_PREFIX)?;
    serde_json::from_str(payload).ok()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoordinationChanged {
    workspace_id: Option<String>,
}

struct CoordinationInner {
    state: Mutex<CoordinationState>,
    path: PathBuf,
    app: OnceLock<AppHandle>,
    /// R4: where this launch's `state.json` went when it didn't parse.
    set_aside: Option<PathBuf>,
}

#[derive(Clone)]
pub struct CoordinationRegistry {
    inner: Arc<CoordinationInner>,
}

/// Armed between durable `starting` admission and durable `running`
/// registration. Drop is the last-resort cleanup for any early-return path.
pub struct SpawnReservation {
    registry: CoordinationRegistry,
    session_id: String,
    armed: bool,
}

#[derive(Clone)]
pub struct SessionTracking {
    registry: CoordinationRegistry,
}

impl SessionTracking {
    pub fn finish_by_pty(&self, pty_id: &str, exit_code: Option<i32>) -> Result<(), String> {
        self.registry.finish_by_pty(pty_id, exit_code)
    }
}

impl SpawnReservation {
    pub fn fail(&mut self, error: &str) {
        if !self.armed {
            return;
        }
        match self.registry.mark_spawn_failed(&self.session_id, error) {
            Ok(()) => self.armed = false,
            Err(mark_error) => {
                log::warn!("coordination spawn-failure persistence failed: {mark_error}");
            }
        }
    }

    pub fn mark_spawned(
        mut self,
        pty_id: String,
        process_id: Option<u32>,
    ) -> Result<SessionTracking, String> {
        self.registry
            .mark_spawned(&self.session_id, pty_id, process_id)?;
        self.armed = false;
        Ok(SessionTracking {
            registry: self.registry.clone(),
        })
    }
}

impl Drop for SpawnReservation {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Err(error) = self.registry.mark_spawn_failed(
            &self.session_id,
            "spawn abandoned before child registration",
        ) {
            log::warn!("coordination reservation cleanup failed: {error}");
        }
        self.armed = false;
    }
}

impl CoordinationRegistry {
    /// 1.175.0 (R4): a `state.json` that doesn't parse stopped the launch.
    /// It is set aside (`state.json.broken-<ms>`, never written over) and
    /// the registry opens with its empty state: no session and no handoff.
    /// Every session of an earlier launch is settled as interrupted at
    /// startup anyway, and nothing is allowed because a record is missing
    /// (the overlap warnings are about sessions running now). What is lost
    /// from view is the history and the retained handoffs — and with them
    /// the snapshot folders they protect, so [`Self::set_aside`] makes the
    /// launch inventory unreliable and nothing is pruned that launch.
    ///
    /// A newer Plyloft's file is still an error here, with the file left as
    /// it is, and that still stops the launch: an "empty, writes refused"
    /// registry would refuse every PTY spawn (`pty.rs::begin_coordination`
    /// returns the write's error), so there is no clean state to start in.
    pub fn new(config_dir: PathBuf) -> Result<Self, String> {
        // The reader's own check of the folder (absolute).
        CoordinationReader::new(&config_dir)?;
        let path = coordination_path(&config_dir);
        let (loaded, set_aside) = crate::atomic::load_store_or_set_broken_aside::<CoordinationState>(
            &path,
            "schemaVersion",
            COORDINATION_SCHEMA_VERSION,
        )?;
        let missing = loaded.is_none();
        let mut state = loaded.unwrap_or_default();
        validate_state(state.clone())?;

        let now = now_millis();
        let mut changed = missing;
        if state.schema_version != COORDINATION_SCHEMA_VERSION {
            state.schema_version = COORDINATION_SCHEMA_VERSION;
            changed = true;
        }
        if state.tracking_started_at <= 0 {
            state.tracking_started_at = now;
            changed = true;
        }
        changed |= reconcile_startup(&mut state, now);
        changed |= prune_state(&mut state, now);

        if changed {
            crate::atomic::write_atomic_json(&path, &state)?;
        }
        Ok(Self {
            inner: Arc::new(CoordinationInner {
                state: Mutex::new(state),
                path,
                app: OnceLock::new(),
                set_aside,
            }),
        })
    }

    /// R4: where this launch's `state.json` went when it didn't parse. The
    /// retained handoffs are then not the whole picture
    /// ([`Self::protected_snapshot_run_ids`] protects none of theirs).
    pub fn set_aside(&self) -> Option<&Path> {
        self.inner.set_aside.as_deref()
    }

    pub fn set_app_handle(&self, app: AppHandle) {
        let _ = self.inner.app.set(app);
    }

    pub fn snapshot(&self) -> CoordinationState {
        self.inner.state.lock().clone()
    }

    pub fn reserve(&self, intent: SpawnIntent) -> Result<SpawnReservation, String> {
        let session_id = self.begin(intent)?;
        Ok(SpawnReservation {
            registry: self.clone(),
            session_id,
            armed: true,
        })
    }

    pub fn begin(&self, intent: SpawnIntent) -> Result<String, String> {
        intent.validate()?;
        let project = match intent.project {
            SpawnProject::Project { workspace_id, cwd } => {
                ProjectRelevance::Project(resolve_project_context(&workspace_id, &cwd)?)
            }
            SpawnProject::NonProject { reason } => ProjectRelevance::NonProject {
                reason: bounded(&reason, ERROR_MAX_CHARS),
            },
        };
        let base_revision = project
            .project()
            .and_then(|project| git_head(Path::new(&project.display_cwd)));
        let workspace_id = project
            .project()
            .map(|project| project.workspace_id.clone());
        let id = Uuid::new_v4().to_string();
        let now = now_millis();
        let mut record = SessionRecord {
            schema_version: COORDINATION_SCHEMA_VERSION,
            id: id.clone(),
            provider: intent.provider,
            execution_kind: intent.execution_kind,
            project,
            attendance: intent.attendance,
            write_intent: intent.write_intent,
            enforcement: intent.enforcement,
            capability: intent.capability,
            card_id: intent.card_id,
            swarm_id: intent.swarm_id,
            role_id: intent.role_id,
            run_id: intent.run_id,
            handoff_id: None,
            pty_id: None,
            process_id: None,
            base_revision,
            head_revision: None,
            status: SessionStatus::Starting,
            exit_code: None,
            error: None,
            diagnostics: Vec::new(),
            started_at: now,
            running_at: None,
            ended_at: None,
            warnings_observed: Vec::new(),
            retention_class: intent.retention_class,
            objective: intent
                .objective
                .as_deref()
                .map(|objective| bounded(objective, OBJECTIVE_MAX_CHARS)),
        };
        self.transition(workspace_id, move |state| {
            if record.enforcement == Enforcement::Exclusive {
                let record_project = record
                    .project
                    .project()
                    .expect("exclusive project session has project context");
                if let Some(peer) = state.sessions.iter().find(|peer| {
                    peer.status.is_active()
                        && peer.attendance == Attendance::Unattended
                        && peer.write_intent == WriteIntent::Writer
                        && peer.enforcement == Enforcement::Exclusive
                        && peer
                            .project
                            .project()
                            .map(|project| {
                                project.worktree.comparison_key
                                    == record_project.worktree.comparison_key
                            })
                            .unwrap_or(false)
                }) {
                    return Err(encode_writer_busy(&WriterConflict {
                        worktree_key: record_project.worktree.comparison_key.clone(),
                        active_session_id: peer.id.clone(),
                        active_execution_kind: peer.execution_kind,
                    }));
                }
            }
            let observed_at = now_millis();
            for peer in state
                .sessions
                .iter_mut()
                .filter(|peer| peer.status.is_active())
            {
                let Some((record_warning, peer_warning)) =
                    overlap_warning_pair(&record, peer, observed_at)
                else {
                    continue;
                };
                push_observed_warning(&mut record.warnings_observed, record_warning);
                push_observed_warning(&mut peer.warnings_observed, peer_warning);
            }
            state.sessions.push(record);
            Ok(())
        })?;
        Ok(id)
    }

    pub fn mark_spawned(
        &self,
        session_id: &str,
        pty_id: String,
        process_id: Option<u32>,
    ) -> Result<(), String> {
        let session_id = session_id.to_string();
        let workspace_id = self.workspace_id_for_session(&session_id);
        self.transition(workspace_id, move |state| {
            let session = find_session_mut(state, &session_id)?;
            if session.status != SessionStatus::Starting {
                return Err(format!(
                    "session {} cannot start from {:?}",
                    session.id, session.status
                ));
            }
            session.status = SessionStatus::Running;
            session.pty_id = Some(pty_id);
            session.process_id = process_id;
            session.running_at = Some(now_millis());
            Ok(())
        })
    }

    pub fn mark_spawn_failed(&self, session_id: &str, error: &str) -> Result<(), String> {
        let session_id = session_id.to_string();
        let error = bounded(error, ERROR_MAX_CHARS);
        let workspace_id = self.workspace_id_for_session(&session_id);
        self.transition(workspace_id, move |state| {
            let session = find_session_mut(state, &session_id)?;
            if !session.status.is_active() {
                return Ok(());
            }
            session.status = SessionStatus::Failed;
            session.error = Some(error);
            session.ended_at = Some(now_millis());
            session.pty_id = None;
            session.process_id = None;
            Ok(())
        })
    }

    pub fn finish_by_pty(&self, pty_id: &str, exit_code: Option<i32>) -> Result<(), String> {
        self.finish_by_pty_as(
            pty_id,
            if exit_code == Some(0) {
                SessionStatus::Completed
            } else {
                SessionStatus::Failed
            },
            exit_code,
            None,
        )
    }

    pub fn mark_killed_by_pty(&self, pty_id: &str) -> Result<(), String> {
        self.finish_by_pty_as(
            pty_id,
            SessionStatus::Killed,
            None,
            Some("session killed by Plyloft".to_string()),
        )
    }

    fn finish_by_pty_as(
        &self,
        pty_id: &str,
        terminal_status: SessionStatus,
        exit_code: Option<i32>,
        error: Option<String>,
    ) -> Result<(), String> {
        let pty_id_owned = pty_id.to_string();
        let session_snapshot = self
            .inner
            .state
            .lock()
            .sessions
            .iter()
            .find(|session| session.pty_id.as_deref() == Some(pty_id))
            .cloned();
        let Some(session_snapshot) = session_snapshot else {
            return Ok(());
        };
        let workspace_id = session_snapshot
            .project
            .project()
            .map(|project| project.workspace_id.clone());
        let head_revision = session_snapshot
            .project
            .project()
            .and_then(|project| git_head(Path::new(&project.display_cwd)));
        self.transition(workspace_id, move |state| {
            let Some(session) = state
                .sessions
                .iter_mut()
                .find(|session| session.pty_id.as_deref() == Some(&pty_id_owned))
            else {
                return Ok(());
            };
            // Shutdown interruption or an explicit kill wins over a late
            // wait-thread completion.
            if !session.status.is_active() {
                return Ok(());
            }
            session.status = terminal_status;
            session.exit_code = exit_code;
            session.error = error.map(|value| bounded(&value, ERROR_MAX_CHARS));
            session.head_revision = head_revision;
            session.ended_at = Some(now_millis());
            session.pty_id = None;
            session.process_id = None;
            Ok(())
        })
    }

    pub fn interrupt_active(&self, reason: &str) -> Result<usize, String> {
        let reason = bounded(reason, ERROR_MAX_CHARS);
        self.transition(None, move |state| {
            let now = now_millis();
            let mut count = 0;
            for session in &mut state.sessions {
                if !session.status.is_active() {
                    continue;
                }
                session.status = SessionStatus::Interrupted;
                session.error = Some(reason.clone());
                session.ended_at = Some(now);
                session.pty_id = None;
                session.process_id = None;
                count += 1;
            }
            Ok(count)
        })
    }

    /// 1.176.0 R5: how many sessions of `provider` are starting or running —
    /// Codex tiles, agent runs, reviewers (the automatic Codex update waits
    /// for none). Last launch's are reconciled at startup, so none counts.
    pub fn active_count(&self, provider: Provider) -> usize {
        self.inner
            .state
            .lock()
            .sessions
            .iter()
            .filter(|session| session.status.is_active() && session.provider == provider)
            .count()
    }

    /// A reviewer session of `provider` is running: an independent review
    /// or Challenger, or a discussion leg. The reviewer probe waits these out.
    pub fn review_active(&self, provider: Provider) -> bool {
        self.inner.state.lock().sessions.iter().any(|session| {
            session.status.is_active()
                && session.provider == provider
                && matches!(
                    session.execution_kind,
                    ExecutionKind::Reviewer
                        | ExecutionKind::DiscussionAnalysis
                        | ExecutionKind::DiscussionCrossReview
                        | ExecutionKind::DiscussionSynthesis
                )
        })
    }

    pub fn workspace_status(&self, workspace_id: &str) -> WorkspaceCoordinationStatus {
        workspace_status_from_state(&self.inner.state.lock(), workspace_id)
    }

    pub fn recent_handoffs(&self, workspace_id: &str, limit: usize) -> Vec<HandoffRecord> {
        recent_handoffs_from_state(&self.inner.state.lock(), workspace_id, limit)
    }

    pub fn record_handoff_for_run(&self, input: HandoffInput) -> Result<Option<String>, String> {
        let source = self
            .inner
            .state
            .lock()
            .sessions
            .iter()
            .find(|session| session.run_id.as_deref() == Some(&input.run_id))
            .cloned();
        let Some(source) = source else {
            return Ok(None);
        };
        if source.attendance != Attendance::Unattended
            || !matches!(
                source.execution_kind,
                ExecutionKind::AgentOneshot | ExecutionKind::SwarmRole
            )
        {
            return Ok(None);
        }
        if source.status.is_active() {
            return Err(format!(
                "cannot create handoff while session {} is active",
                source.id
            ));
        }
        if let Some(existing) = source.handoff_id.clone() {
            return Ok(Some(existing));
        }

        let workspace_id = source
            .project
            .project()
            .map(|project| project.workspace_id.clone())
            .ok_or_else(|| "project-relevant handoff source has no project context".to_string())?;
        let mut evidence_warnings = Vec::new();
        let reviewer_artifact =
            input
                .reviewer_artifact
                .and_then(|artifact| match serde_json::to_vec(&artifact) {
                    Ok(bytes) if bytes.len() <= HANDOFF_ARTIFACT_MAX_BYTES => Some(artifact),
                    Ok(bytes) => {
                        evidence_warnings.push(format!(
                            "reviewer artifact omitted: {} bytes exceeds {} byte cap",
                            bytes.len(),
                            HANDOFF_ARTIFACT_MAX_BYTES
                        ));
                        None
                    }
                    Err(error) => {
                        evidence_warnings.push(format!(
                            "reviewer artifact omitted: serialization failed: {error}"
                        ));
                        None
                    }
                });
        if input.snapshot_run_id.is_none() {
            evidence_warnings.push("snapshot change manifest unavailable".to_string());
        }
        let total = input.changed_paths.len().min(u32::MAX as usize) as u32;
        let mut paths = input.changed_paths;
        paths.sort();
        paths.dedup();
        let path_overflow = paths.len() > HANDOFF_PATH_CAP;
        paths.truncate(HANDOFF_PATH_CAP);
        let handoff_id = Uuid::new_v4().to_string();
        let handoff = HandoffRecord {
            schema_version: COORDINATION_SCHEMA_VERSION,
            id: handoff_id.clone(),
            workspace_id: workspace_id.clone(),
            project: source.project.project().cloned(),
            source_session_id: source.id.clone(),
            source_run_id: source.run_id.clone(),
            card_id: input.card_id.or(source.card_id.clone()),
            swarm_id: source.swarm_id.clone(),
            role_id: source.role_id.clone(),
            provider: source.provider,
            objective: source.objective.unwrap_or_default(),
            outcome_status: source.status,
            exit_code: source.exit_code,
            failure: input
                .failure
                .or(source.error)
                .as_deref()
                .map(|failure| bounded(failure, ERROR_MAX_CHARS)),
            base_revision: source.base_revision,
            head_revision: source.head_revision,
            snapshot_run_id: input.snapshot_run_id,
            changes: ply_collab::HandoffChangeSummary {
                total,
                paths,
                truncated: input.changes_truncated || path_overflow,
                swarm_collisions: input.swarm_collisions,
            },
            reviewer_artifact,
            evidence_warnings,
            verification_artifacts: Vec::new(),
            follow_ups: Vec::new(),
            created_at: now_millis(),
            protected_by: Vec::new(),
        };
        let run_id = input.run_id;
        self.transition(Some(workspace_id), move |state| {
            let Some(index) = state
                .sessions
                .iter()
                .position(|session| session.run_id.as_deref() == Some(&run_id))
            else {
                return Ok(None);
            };
            if let Some(existing) = state.sessions[index].handoff_id.clone() {
                return Ok(Some(existing));
            }
            state.sessions[index].handoff_id = Some(handoff_id.clone());
            state.handoffs.push(handoff);
            Ok(Some(handoff_id))
        })
    }

    pub fn protected_snapshot_run_ids(&self) -> HashSet<String> {
        self.inner
            .state
            .lock()
            .handoffs
            .iter()
            .filter_map(|handoff| handoff.snapshot_run_id.clone())
            .collect()
    }

    pub fn note_handoff_failure_for_run(&self, run_id: &str, error: &str) -> Result<(), String> {
        let run_id = run_id.to_string();
        let diagnostic = bounded(
            &format!("handoff persistence failed: {error}"),
            ERROR_MAX_CHARS,
        );
        let workspace_id = self
            .inner
            .state
            .lock()
            .sessions
            .iter()
            .find(|session| session.run_id.as_deref() == Some(&run_id))
            .and_then(|session| {
                session
                    .project
                    .project()
                    .map(|project| project.workspace_id.clone())
            });
        self.transition(workspace_id, move |state| {
            let Some(session) = state
                .sessions
                .iter_mut()
                .find(|session| session.run_id.as_deref() == Some(&run_id))
            else {
                return Ok(());
            };
            session.diagnostics.push(diagnostic);
            if session.diagnostics.len() > OBSERVED_WARNING_CAP {
                session
                    .diagnostics
                    .drain(..session.diagnostics.len() - OBSERVED_WARNING_CAP);
            }
            Ok(())
        })
    }

    fn workspace_id_for_session(&self, session_id: &str) -> Option<String> {
        self.inner
            .state
            .lock()
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .and_then(|session| {
                session
                    .project
                    .project()
                    .map(|project| project.workspace_id.clone())
            })
    }

    fn transition<T>(
        &self,
        workspace_id: Option<String>,
        mutate: impl FnOnce(&mut CoordinationState) -> Result<T, String>,
    ) -> Result<T, String> {
        let result = {
            let mut current = self.inner.state.lock();
            let mut next = current.clone();
            let result = mutate(&mut next)?;
            prune_state(&mut next, now_millis());
            crate::atomic::write_atomic_json(&self.inner.path, &next)?;
            *current = next;
            result
        };
        if let Some(app) = self.inner.app.get() {
            let _ = app.emit(
                "coordination://changed",
                CoordinationChanged { workspace_id },
            );
        }
        Ok(result)
    }
}

/// The warnings two active sessions record about each other at spawn, from
/// the one rule in `ply_collab::overlap_warning` (shared fixture
/// `crates/ply-collab/fixtures/overlap_warnings.json`). The rule fires for
/// both sides or for neither.
fn overlap_warning_pair(
    session: &SessionRecord,
    peer: &SessionRecord,
    observed_at: i64,
) -> Option<(CoordinationWarning, CoordinationWarning)> {
    let (session_code, session_summary) = ply_collab::overlap_warning(session, peer)?;
    let (peer_code, peer_summary) = ply_collab::overlap_warning(peer, session)?;
    Some((
        CoordinationWarning {
            code: session_code.to_string(),
            peer_session_id: peer.id.clone(),
            observed_at,
            summary: session_summary.to_string(),
        },
        CoordinationWarning {
            code: peer_code.to_string(),
            peer_session_id: session.id.clone(),
            observed_at,
            summary: peer_summary.to_string(),
        },
    ))
}

fn push_observed_warning(warnings: &mut Vec<CoordinationWarning>, warning: CoordinationWarning) {
    warnings.push(warning);
    if warnings.len() > OBSERVED_WARNING_CAP {
        warnings.drain(..warnings.len() - OBSERVED_WARNING_CAP);
    }
}

fn find_session_mut<'a>(
    state: &'a mut CoordinationState,
    session_id: &str,
) -> Result<&'a mut SessionRecord, String> {
    state
        .sessions
        .iter_mut()
        .find(|session| session.id == session_id)
        .ok_or_else(|| format!("coordination session not found: {session_id}"))
}

pub fn resolve_project_context(workspace_id: &str, cwd: &Path) -> Result<ProjectContext, String> {
    let git = crate::shell_env::try_get().and_then(|env| env.working_git());
    resolve_project_context_with_git(workspace_id, cwd, git.as_deref())
}

fn resolve_project_context_with_git(
    workspace_id: &str,
    cwd: &Path,
    git_executable: Option<&str>,
) -> Result<ProjectContext, String> {
    if workspace_id.trim().is_empty() {
        return Err("workspace id is required for a project session".to_string());
    }
    if !cwd.is_absolute() {
        return Err(format!("project cwd must be absolute: {}", cwd.display()));
    }
    let canonical_cwd = crate::platform::canonicalize(cwd)
        .map_err(|error| format!("canonicalize project cwd '{}': {error}", cwd.display()))?;
    if !canonical_cwd.is_dir() {
        return Err(format!(
            "project cwd is not a directory: {}",
            canonical_cwd.display()
        ));
    }

    if let Some(git) = git_executable {
        let common = git_capture(git, &canonical_cwd, &["rev-parse", "--git-common-dir"]);
        let top = git_capture(git, &canonical_cwd, &["rev-parse", "--show-toplevel"]);
        if let (Some(common), Some(top)) = (common, top) {
            let common = canonicalize_git_output(&canonical_cwd, &common);
            let top = canonicalize_git_output(&canonical_cwd, &top);
            if let (Ok(common), Ok(top)) = (common, top) {
                return Ok(ProjectContext {
                    workspace_id: workspace_id.to_string(),
                    git: true,
                    project: identity_path(&common),
                    worktree: identity_path(&top),
                    display_cwd: canonical_cwd.to_string_lossy().into_owned(),
                });
            }
        }
    }

    let fallback = identity_path(&canonical_cwd);
    Ok(ProjectContext {
        workspace_id: workspace_id.to_string(),
        git: false,
        project: fallback.clone(),
        worktree: fallback,
        display_cwd: canonical_cwd.to_string_lossy().into_owned(),
    })
}

fn git_capture(git: &str, cwd: &Path, args: &[&str]) -> Option<String> {
    let output = crate::platform::new_command(git)
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn canonicalize_git_output(cwd: &Path, raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw);
    let path = if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    };
    crate::platform::canonicalize(&path)
        .map_err(|error| format!("canonicalize Git identity '{}': {error}", path.display()))
}

fn identity_path(path: &Path) -> IdentityPath {
    let display_path = path.to_string_lossy().into_owned();
    IdentityPath {
        comparison_key: comparison_key(&display_path),
        display_path,
    }
}

// APFS and NTFS are case-insensitive by default: one worktree, one key.
fn comparison_key(path: &str) -> String {
    #[cfg(any(target_os = "macos", windows))]
    {
        path.to_lowercase()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        path.to_string()
    }
}

fn git_head(cwd: &Path) -> Option<String> {
    let git = crate::shell_env::try_get()?.working_git()?;
    git_capture(&git, cwd, &["rev-parse", "HEAD"])
}

fn reconcile_startup(state: &mut CoordinationState, now: i64) -> bool {
    let mut changed = false;
    for session in &mut state.sessions {
        if !session.status.is_active() {
            continue;
        }
        session.status = SessionStatus::Interrupted;
        session.ended_at = Some(now);
        session.pty_id = None;
        session.process_id = None;
        if session.error.is_none() {
            session.error = Some("process interrupted before Plyloft startup".to_string());
        }
        changed = true;
    }
    changed
}

fn prune_state(state: &mut CoordinationState, now: i64) -> bool {
    let before_sessions = state.sessions.len();
    state.sessions.retain(|session| {
        if session.status.is_active() {
            return true;
        }
        let terminal_at = session.ended_at.unwrap_or(session.started_at);
        let age = now.saturating_sub(terminal_at);
        let days = match (
            session.retention_class,
            session.status.is_abnormal_terminal(),
        ) {
            (RetentionClass::Ephemeral, false) => EPHEMERAL_OK_DAYS,
            (RetentionClass::Ephemeral, true) => EPHEMERAL_ABNORMAL_DAYS,
            (RetentionClass::Interactive, false) => INTERACTIVE_OK_DAYS,
            (RetentionClass::Interactive, true) => INTERACTIVE_ABNORMAL_DAYS,
            (RetentionClass::Unattended, false) => UNATTENDED_OK_DAYS,
            (RetentionClass::Unattended, true) => UNATTENDED_ABNORMAL_DAYS,
        };
        age <= days * DAY_MS
    });
    enforce_session_cap(
        &mut state.sessions,
        RetentionClass::Ephemeral,
        EPHEMERAL_CAP,
    );
    enforce_session_cap(
        &mut state.sessions,
        RetentionClass::Interactive,
        INTERACTIVE_CAP,
    );
    enforce_session_cap(
        &mut state.sessions,
        RetentionClass::Unattended,
        UNATTENDED_CAP,
    );

    let before_handoffs = state.handoffs.len();
    state.handoffs.retain(|handoff| {
        !handoff.protected_by.is_empty()
            || now.saturating_sub(handoff.created_at) <= HANDOFF_DAYS * DAY_MS
    });
    let mut unprotected: Vec<(usize, i64)> = state
        .handoffs
        .iter()
        .enumerate()
        .filter(|(_, handoff)| handoff.protected_by.is_empty())
        .map(|(index, handoff)| (index, handoff.created_at))
        .collect();
    unprotected.sort_by(|a, b| b.1.cmp(&a.1));
    let remove_handoffs: HashSet<usize> = unprotected
        .into_iter()
        .skip(HANDOFF_CAP)
        .map(|(index, _)| index)
        .collect();
    if !remove_handoffs.is_empty() {
        state.handoffs = state
            .handoffs
            .drain(..)
            .enumerate()
            .filter_map(|(index, handoff)| (!remove_handoffs.contains(&index)).then_some(handoff))
            .collect();
    }

    before_sessions != state.sessions.len() || before_handoffs != state.handoffs.len()
}

fn enforce_session_cap(sessions: &mut Vec<SessionRecord>, class: RetentionClass, cap: usize) {
    let mut terminal: Vec<(usize, i64)> = sessions
        .iter()
        .enumerate()
        .filter(|(_, session)| session.retention_class == class && !session.status.is_active())
        .map(|(index, session)| (index, session.ended_at.unwrap_or(session.started_at)))
        .collect();
    terminal.sort_by(|a, b| b.1.cmp(&a.1));
    let remove: HashSet<usize> = terminal
        .into_iter()
        .skip(cap)
        .map(|(index, _)| index)
        .collect();
    if remove.is_empty() {
        return;
    }
    *sessions = sessions
        .drain(..)
        .enumerate()
        .filter_map(|(index, session)| (!remove.contains(&index)).then_some(session))
        .collect();
}

fn bounded(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn run_git(cwd: &Path, args: &[&str]) {
        let output = crate::platform::git_command()
            .arg("-C")
            .arg(cwd)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn project_intent(cwd: &Path) -> SpawnIntent {
        SpawnIntent {
            provider: Provider::Claude,
            execution_kind: ExecutionKind::AgentOneshot,
            attendance: Attendance::Unattended,
            write_intent: WriteIntent::Writer,
            enforcement: Enforcement::Exclusive,
            project: SpawnProject::Project {
                workspace_id: "w1".into(),
                cwd: cwd.to_path_buf(),
            },
            capability: None,
            card_id: None,
            swarm_id: None,
            role_id: None,
            run_id: Some("r1".into()),
            retention_class: RetentionClass::Unattended,
            objective: Some("Do the work".into()),
        }
    }

    /// The `<name>.broken-<ms>` files beside `path`.
    fn broken_beside(path: &Path) -> Vec<PathBuf> {
        let prefix = format!("{}.broken-", path.file_name().unwrap().to_string_lossy());
        std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with(&prefix))
            .collect()
    }

    /// R4: a coordination `state.json` that doesn't parse stopped the
    /// launch. It is set aside with its bytes and the registry opens empty
    /// — no session, no handoff — and says so, because the handoffs it lost
    /// protect snapshot folders (`launch_inventory`). The registry works:
    /// its next write makes a new file and never touches the old one.
    #[test]
    fn a_corrupt_coordination_state_is_set_aside_and_the_registry_opens_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = coordination_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let corrupt = br#"{"schemaVersion":1,"sessions":[{"id":"s1","sta"#;
        fs::write(&path, corrupt).unwrap();

        let registry = CoordinationRegistry::new(dir.path().to_path_buf()).expect("the launch goes on");
        let state = registry.snapshot();
        assert!(state.sessions.is_empty() && state.handoffs.is_empty());
        assert!(registry.protected_snapshot_run_ids().is_empty());
        let kept = broken_beside(&path);
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert_eq!(registry.set_aside(), Some(kept[0].as_path()), "the registry says where it went");
        assert_eq!(fs::read(&kept[0]).unwrap(), corrupt, "the original bytes");
        // The registry wrote its new, empty state (tracking starts now).
        let fresh: CoordinationState = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(fresh.sessions.is_empty() && fresh.tracking_started_at > 0);

        let again = CoordinationRegistry::new(dir.path().to_path_buf()).unwrap();
        assert_eq!(again.set_aside(), None, "only the launch that set it aside says so");
        assert_eq!(broken_beside(&path), kept, "nothing new set aside");
        assert_eq!(fs::read(&kept[0]).unwrap(), corrupt, "never touched");
    }

    /// R4: a newer Plyloft's coordination state is still refused and left
    /// as it is — parsed or not — and a file that can't be set aside fails
    /// the load, so nothing writes an empty state over either.
    #[test]
    fn a_newer_or_unmovable_coordination_state_is_left_as_it_is() {
        let next = COORDINATION_SCHEMA_VERSION + 1;
        let parses = format!(r#"{{"schemaVersion":{next},"sessions":[]}}"#);
        let strict = format!(r#"{{"schemaVersion":{next},"sessions":{{"changed":"shape"}}}}"#);
        for newer in [parses, strict] {
            let dir = tempfile::tempdir().unwrap();
            let path = coordination_path(dir.path());
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, &newer).unwrap();
            let error = CoordinationRegistry::new(dir.path().to_path_buf()).err().expect("refused");
            assert!(error.contains("newer"), "{error}");
            assert_eq!(fs::read_to_string(&path).unwrap(), newer, "byte-identical");
            assert!(broken_beside(&path).is_empty(), "never set aside");
        }

        let dir = tempfile::tempdir().unwrap();
        let path = coordination_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{broken").unwrap();
        crate::atomic::deny_set_aside_for_test(true);
        let result = CoordinationRegistry::new(dir.path().to_path_buf());
        crate::atomic::deny_set_aside_for_test(false);
        assert!(result.err().expect("the load fails").contains("couldn't be set aside"));
        assert_eq!(fs::read(&path).unwrap(), b"{broken", "left as it is");
    }

    #[test]
    fn review_active_sees_only_running_reviewer_sessions_of_that_provider() {
        let dir = tempfile::tempdir().unwrap();
        let registry = CoordinationRegistry::new(dir.path().to_path_buf()).unwrap();
        let intent = |provider, execution_kind| SpawnIntent {
            provider,
            execution_kind,
            attendance: Attendance::Unattended,
            write_intent: WriteIntent::ReadOnly,
            enforcement: Enforcement::Exempt,
            project: SpawnProject::NonProject {
                reason: "test".into(),
            },
            capability: None,
            card_id: None,
            swarm_id: None,
            role_id: None,
            run_id: None,
            retention_class: RetentionClass::Ephemeral,
            objective: None,
        };
        registry
            .begin(intent(Provider::Claude, ExecutionKind::ReviewerProbe))
            .unwrap();
        registry
            .begin(intent(Provider::Codex, ExecutionKind::Reviewer))
            .unwrap();
        assert!(!registry.review_active(Provider::Claude));
        assert!(registry.review_active(Provider::Codex));

        let leg = registry
            .begin(intent(Provider::Claude, ExecutionKind::DiscussionAnalysis))
            .unwrap();
        assert!(registry.review_active(Provider::Claude));
        registry.mark_spawn_failed(&leg, "done").unwrap();
        assert!(!registry.review_active(Provider::Claude));
    }

    #[test]
    fn unknown_unattended_is_rejected() {
        let mut intent = project_intent(Path::new("/tmp"));
        intent.write_intent = WriteIntent::Unknown;
        assert!(intent.validate().unwrap_err().contains("must declare"));
    }

    #[test]
    fn enforcement_matrix_rejects_misclassified_intents() {
        let mut writer = project_intent(Path::new("/tmp"));
        writer.enforcement = Enforcement::Advisory;
        assert!(writer.validate().unwrap_err().contains("Exclusive"));

        let mut human = project_intent(Path::new("/tmp"));
        human.attendance = Attendance::HumanAttended;
        human.write_intent = WriteIntent::Unknown;
        assert!(human.validate().unwrap_err().contains("Advisory"));

        human.enforcement = Enforcement::Advisory;
        assert!(human.validate().is_ok());

        human.project = SpawnProject::NonProject {
            reason: "probe".into(),
        };
        assert!(human.validate().unwrap_err().contains("Exempt"));
        human.enforcement = Enforcement::Exempt;
        assert!(human.validate().is_ok());
    }

    #[test]
    fn busy_error_round_trips_without_prose_matching() {
        let conflict = WriterConflict {
            worktree_key: "/private/tmp/project".into(),
            active_session_id: "session-1".into(),
            active_execution_kind: ExecutionKind::SwarmRole,
        };
        let encoded = encode_writer_busy(&conflict);
        assert!(encoded.starts_with(COORDINATION_BUSY_PREFIX));
        assert_eq!(decode_writer_busy(&encoded), Some(conflict));
        assert!(decode_writer_busy("another writer is active").is_none());
    }

    #[test]
    fn non_git_identity_falls_back_to_canonical_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let context = resolve_project_context_with_git("w1", dir.path(), Some("git")).unwrap();
        let canonical = crate::platform::canonicalize(dir.path()).unwrap();
        assert!(!context.git);
        assert_eq!(context.project.display_path, canonical.to_string_lossy());
        assert_eq!(context.project, context.worktree);
    }

    #[test]
    fn git_worktrees_share_project_identity_but_not_worktree_identity() {
        let repo = tempfile::tempdir().unwrap();
        run_git(repo.path(), &["init", "-q"]);
        run_git(repo.path(), &["config", "user.email", "test@example.com"]);
        run_git(repo.path(), &["config", "user.name", "Test"]);
        fs::write(repo.path().join("README.md"), "one\n").unwrap();
        run_git(repo.path(), &["add", "README.md"]);
        run_git(repo.path(), &["commit", "-qm", "initial"]);
        let worktree_root = repo.path().join("linked");
        run_git(
            repo.path(),
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "phase2-test",
                worktree_root.to_str().unwrap(),
            ],
        );

        let main = resolve_project_context_with_git("w1", repo.path(), Some("git")).unwrap();
        let linked = resolve_project_context_with_git("w1", &worktree_root, Some("git")).unwrap();
        assert!(main.git && linked.git);
        assert_eq!(main.project.comparison_key, linked.project.comparison_key);
        assert_ne!(main.worktree.comparison_key, linked.worktree.comparison_key);
    }

    /// 1.173.0 A2: a tile opened in a copy without a card (`copies.rs`,
    /// `<ws>/.plyloft-worktrees/copy-<short8>/`, inside the main checkout's
    /// folder) is keyed by the copy folder, from its root or any folder in
    /// it — never by the main checkout that holds it — so a tile there and
    /// one in the project folder are not in the same worktree.
    #[test]
    fn a_tile_in_a_copy_is_keyed_by_the_copy_folder_not_the_project_folder() {
        let repo = tempfile::tempdir().unwrap();
        run_git(repo.path(), &["init", "-q", "-b", "main"]);
        run_git(repo.path(), &["config", "user.email", "test@example.com"]);
        run_git(repo.path(), &["config", "user.name", "Test"]);
        run_git(repo.path(), &["config", "commit.gpgsign", "false"]);
        fs::create_dir(repo.path().join("src")).unwrap();
        fs::write(repo.path().join("src").join("a.txt"), "one\n").unwrap();
        run_git(repo.path(), &["add", "."]);
        run_git(repo.path(), &["commit", "-qm", "initial"]);
        let registry = repo.path().join("config");
        let place = crate::copies::Place { registry_dir: &registry, workspace_cwd: repo.path() };
        let copy = crate::copies::create(place, "try", "main", None, 1, crate::worktrees::resolve_base).unwrap();
        let copy_root = std::path::PathBuf::from(&copy.path);

        let main = resolve_project_context_with_git("w1", repo.path(), Some("git")).unwrap();
        let main_sub = resolve_project_context_with_git("w1", &repo.path().join("src"), Some("git")).unwrap();
        let in_copy = resolve_project_context_with_git("w1", &copy_root, Some("git")).unwrap();
        let in_copy_sub = resolve_project_context_with_git("w1", &copy_root.join("src"), Some("git")).unwrap();
        assert!(in_copy.git);
        assert_eq!(main.worktree.comparison_key, main_sub.worktree.comparison_key);
        assert_eq!(in_copy.worktree.comparison_key, in_copy_sub.worktree.comparison_key);
        assert_ne!(main.worktree.comparison_key, in_copy.worktree.comparison_key);
        assert_eq!(
            in_copy.worktree.comparison_key,
            comparison_key(&crate::platform::canonicalize(&copy_root).unwrap().to_string_lossy())
        );
        assert_eq!(main.project.comparison_key, in_copy.project.comparison_key, "one project");
    }

    #[test]
    fn startup_reconciles_active_records_and_writes_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let path = coordination_path(dir.path());
        let state = CoordinationState {
            tracking_started_at: 1,
            sessions: vec![SessionRecord {
                id: "active".into(),
                status: SessionStatus::Running,
                pty_id: Some("pty".into()),
                process_id: Some(42),
                started_at: 1,
                ..SessionRecord::default()
            }],
            ..CoordinationState::default()
        };
        crate::atomic::write_atomic_json(&path, &state).unwrap();

        let registry = CoordinationRegistry::new(dir.path().to_path_buf()).unwrap();
        let session = &registry.snapshot().sessions[0];
        assert_eq!(session.status, SessionStatus::Interrupted);
        assert!(session.pty_id.is_none());
        assert!(session.process_id.is_none());
        let tmp = path.with_file_name("state.json.atelier-tmp");
        assert!(!tmp.exists());
    }

    #[test]
    fn lifecycle_records_spawn_and_late_exit_cannot_overwrite_killed() {
        let dir = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let registry = CoordinationRegistry::new(dir.path().to_path_buf()).unwrap();
        let id = registry.begin(project_intent(project.path())).unwrap();
        registry
            .mark_spawned(&id, "pty-1".into(), Some(123))
            .unwrap();
        registry.mark_killed_by_pty("pty-1").unwrap();
        registry.finish_by_pty("pty-1", Some(0)).unwrap();
        let state = registry.snapshot();
        let session = state.sessions.iter().find(|s| s.id == id).unwrap();
        assert_eq!(session.status, SessionStatus::Killed);
    }

    #[test]
    fn same_worktree_writer_overlap_is_advisory_and_persisted_on_both_records() {
        let dir = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let registry = CoordinationRegistry::new(dir.path().to_path_buf()).unwrap();
        let mut human = project_intent(project.path());
        human.provider = Provider::Shell;
        human.execution_kind = ExecutionKind::ShellTile;
        human.attendance = Attendance::HumanAttended;
        human.write_intent = WriteIntent::Unknown;
        human.enforcement = Enforcement::Advisory;
        human.retention_class = RetentionClass::Interactive;
        human.run_id = None;
        let human_id = registry.begin(human).unwrap();
        let writer_id = registry.begin(project_intent(project.path())).unwrap();

        let state = registry.snapshot();
        let human_record = state.sessions.iter().find(|s| s.id == human_id).unwrap();
        let writer_record = state.sessions.iter().find(|s| s.id == writer_id).unwrap();
        assert_eq!(human_record.warnings_observed.len(), 1);
        assert_eq!(
            human_record.warnings_observed[0].code,
            "unattended-writer-active"
        );
        assert_eq!(writer_record.warnings_observed.len(), 1);
        assert_eq!(
            writer_record.warnings_observed[0].code,
            "human-session-active"
        );

        let status = registry.workspace_status("w1");
        assert_eq!(status.active_sessions.len(), 2);
        assert_eq!(status.live_warnings.len(), 2);
    }

    /// One side of a case in the shared overlap fixture, as a running record.
    fn fixture_record(id: &str, side: &serde_json::Value) -> SessionRecord {
        let mut fields = side.as_object().unwrap().clone();
        let worktree = fields.remove("worktree").unwrap();
        let worktree = worktree.as_str().unwrap();
        let non_project = fields.remove("nonProject").and_then(|v| v.as_bool()) == Some(true);
        let mut record: SessionRecord =
            serde_json::from_value(serde_json::Value::Object(fields)).unwrap();
        record.id = id.into();
        record.status = SessionStatus::Running;
        if non_project {
            record.project = ProjectRelevance::NonProject {
                reason: "fixture".into(),
            };
            return record;
        }
        record.project = ProjectRelevance::Project(ProjectContext {
            workspace_id: "w1".into(),
            git: true,
            project: IdentityPath {
                display_path: "/repo/.git".into(),
                comparison_key: "/repo/.git".into(),
            },
            worktree: IdentityPath {
                display_path: worktree.into(),
                comparison_key: worktree.into(),
            },
            display_cwd: worktree.into(),
        });
        record
    }

    #[test]
    fn observed_overlap_follows_the_shared_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../crates/ply-collab/fixtures/overlap_warnings.json"
        ))
        .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let a = fixture_record("a", &case["a"]);
            let b = fixture_record("b", &case["b"]);
            let pair = overlap_warning_pair(&a, &b, 7);
            let codes = pair
                .as_ref()
                .map(|(on_a, on_b)| (on_a.code.clone(), on_b.code.clone()));
            let expected = match (case["aWarns"].as_str(), case["bWarns"].as_str()) {
                (Some(a), Some(b)) => Some((a.to_string(), b.to_string())),
                (None, None) => None,
                other => panic!("{name}: the rule fires for both sides or neither: {other:?}"),
            };
            assert_eq!(codes, expected, "{name}");
            if let Some((on_a, on_b)) = pair {
                assert_eq!(on_a.peer_session_id, "b", "{name}");
                assert_eq!(on_b.peer_session_id, "a", "{name}");
                assert_eq!(on_a.observed_at, 7, "{name}");
            }
        }
    }

    /// A4: a tile in a card's copy (a linked git worktree under
    /// `.plyloft-worktrees/`) has its own comparison key, so it never warns
    /// against the project folder; a tile in a subfolder of the project does.
    #[test]
    fn a_tile_in_a_copy_never_warns_against_the_project_folder() {
        let repo = tempfile::tempdir().unwrap();
        run_git(repo.path(), &["init", "-q"]);
        run_git(repo.path(), &["config", "user.email", "test@example.com"]);
        run_git(repo.path(), &["config", "user.name", "Test"]);
        fs::create_dir_all(repo.path().join("src")).unwrap();
        fs::write(repo.path().join("src/lib.txt"), "one\n").unwrap();
        run_git(repo.path(), &["add", "src/lib.txt"]);
        run_git(repo.path(), &["commit", "-qm", "initial"]);
        let copy = repo.path().join(".plyloft-worktrees").join("copy-1a2b3c4d");
        run_git(
            repo.path(),
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "plyloft/copy-1a2b3c4d-try",
                copy.to_str().unwrap(),
            ],
        );
        let tile = |id: &str, cwd: &Path| SessionRecord {
            id: id.into(),
            provider: Provider::Claude,
            execution_kind: ExecutionKind::ProviderTile,
            status: SessionStatus::Running,
            project: ProjectRelevance::Project(
                resolve_project_context_with_git("w1", cwd, Some("git")).unwrap(),
            ),
            ..SessionRecord::default()
        };
        let folder = tile("folder", repo.path());
        let subfolder = tile("subfolder", &repo.path().join("src"));
        let in_copy = tile("copy", &copy);

        assert!(overlap_warning_pair(&folder, &in_copy, 1).is_none());
        let (on_folder, _) = overlap_warning_pair(&folder, &subfolder, 1).unwrap();
        assert_eq!(on_folder.code, ply_collab::TWO_PROVIDER_TILES);

        let state = CoordinationState {
            sessions: vec![folder, in_copy],
            ..CoordinationState::default()
        };
        assert!(workspace_status_from_state(&state, "w1").live_warnings.is_empty());
    }

    #[test]
    fn same_worktree_unattended_writer_is_exclusive() {
        let dir = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let registry = CoordinationRegistry::new(dir.path().to_path_buf()).unwrap();
        let first = registry.begin(project_intent(project.path())).unwrap();
        let error = registry.begin(project_intent(project.path())).unwrap_err();
        let conflict = decode_writer_busy(&error).expect("typed busy conflict");
        assert_eq!(conflict.active_session_id, first);
        assert_eq!(
            conflict.active_execution_kind,
            ExecutionKind::AgentOneshot
        );
        assert_eq!(registry.snapshot().sessions.len(), 1);
    }

    #[test]
    fn read_only_and_distinct_worktrees_do_not_contend() {
        let dir = tempfile::tempdir().unwrap();
        let first_project = tempfile::tempdir().unwrap();
        let second_project = tempfile::tempdir().unwrap();
        let registry = CoordinationRegistry::new(dir.path().to_path_buf()).unwrap();
        registry.begin(project_intent(first_project.path())).unwrap();

        let mut reader = project_intent(first_project.path());
        reader.write_intent = WriteIntent::ReadOnly;
        reader.enforcement = Enforcement::Advisory;
        registry.begin(reader).unwrap();

        registry
            .begin(project_intent(second_project.path()))
            .unwrap();
        assert_eq!(registry.snapshot().sessions.len(), 3);
    }

    #[test]
    fn dropped_spawn_reservation_releases_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let registry = CoordinationRegistry::new(dir.path().to_path_buf()).unwrap();
        let reservation = registry.reserve(project_intent(project.path())).unwrap();
        assert!(decode_writer_busy(
            &registry.begin(project_intent(project.path())).unwrap_err()
        )
        .is_some());

        drop(reservation);
        registry.begin(project_intent(project.path())).unwrap();
        let state = registry.snapshot();
        assert_eq!(state.sessions.len(), 2);
        assert_eq!(state.sessions[0].status, SessionStatus::Failed);
        assert_eq!(
            state.sessions[0].error.as_deref(),
            Some("spawn abandoned before child registration")
        );
        assert_eq!(state.sessions[1].status, SessionStatus::Starting);
    }

    #[test]
    fn simultaneous_same_worktree_admission_has_one_winner() {
        use std::sync::{Arc as StdArc, Barrier};

        let dir = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let registry = CoordinationRegistry::new(dir.path().to_path_buf()).unwrap();
        let barrier = StdArc::new(Barrier::new(3));
        let mut threads = Vec::new();
        for _ in 0..2 {
            let registry = registry.clone();
            let barrier = barrier.clone();
            let cwd = project.path().to_path_buf();
            threads.push(std::thread::spawn(move || {
                barrier.wait();
                registry.begin(project_intent(&cwd))
            }));
        }
        barrier.wait();
        let results: Vec<Result<String, String>> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| {
                    result
                        .as_ref()
                        .err()
                        .and_then(|error| decode_writer_busy(error))
                        .is_some()
                })
                .count(),
            1
        );
        assert_eq!(registry.snapshot().sessions.len(), 1);
    }

    #[test]
    fn observed_warning_history_is_bounded() {
        let mut warnings = Vec::new();
        for index in 0..(OBSERVED_WARNING_CAP + 5) {
            push_observed_warning(
                &mut warnings,
                CoordinationWarning {
                    peer_session_id: index.to_string(),
                    ..CoordinationWarning::default()
                },
            );
        }
        assert_eq!(warnings.len(), OBSERVED_WARNING_CAP);
        assert_eq!(warnings[0].peer_session_id, "5");
    }

    #[test]
    fn handoff_is_bounded_idempotent_and_protects_its_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let registry = CoordinationRegistry::new(dir.path().to_path_buf()).unwrap();
        let snapshots = crate::snapshots::SnapshotsStore::new(dir.path().to_path_buf()).unwrap();
        snapshots.capture_before("r1", project.path()).unwrap();
        let mut intent = project_intent(project.path());
        intent.execution_kind = ExecutionKind::SwarmRole;
        intent.swarm_id = Some("swarm-1".into());
        intent.role_id = Some("reviewer-1".into());
        let id = registry.begin(intent).unwrap();
        registry
            .mark_spawned(&id, "pty-handoff".into(), Some(321))
            .unwrap();
        registry.finish_by_pty("pty-handoff", Some(0)).unwrap();
        let input = HandoffInput {
            run_id: "r1".into(),
            card_id: Some("card-1".into()),
            failure: None,
            snapshot_run_id: Some("r1".into()),
            changed_paths: (0..105)
                .map(|index| format!("src/file-{index:03}.rs"))
                .collect(),
            changes_truncated: false,
            swarm_collisions: 2,
            reviewer_artifact: Some(serde_json::json!({
                "body": "x".repeat(HANDOFF_ARTIFACT_MAX_BYTES + 1)
            })),
        };
        let handoff_id = registry
            .record_handoff_for_run(input.clone())
            .unwrap()
            .unwrap();
        assert_eq!(
            registry.record_handoff_for_run(input).unwrap(),
            Some(handoff_id.clone())
        );

        let state = registry.snapshot();
        assert_eq!(state.handoffs.len(), 1);
        let handoff = &state.handoffs[0];
        assert_eq!(handoff.id, handoff_id);
        assert_eq!(handoff.changes.total, 105);
        assert_eq!(handoff.changes.paths.len(), HANDOFF_PATH_CAP);
        assert!(handoff.changes.truncated);
        assert_eq!(handoff.changes.swarm_collisions, 2);
        assert_eq!(handoff.card_id.as_deref(), Some("card-1"));
        assert_eq!(handoff.swarm_id.as_deref(), Some("swarm-1"));
        assert_eq!(handoff.role_id.as_deref(), Some("reviewer-1"));
        assert!(handoff.reviewer_artifact.is_none());
        assert!(handoff
            .evidence_warnings
            .iter()
            .any(|warning| warning.contains("artifact omitted")));
        assert_eq!(
            state
                .sessions
                .iter()
                .find(|session| session.id == id)
                .unwrap()
                .handoff_id,
            Some(handoff_id)
        );
        let protected = registry.protected_snapshot_run_ids();
        assert!(protected.contains("r1"));
        assert_eq!(snapshots.gc_orphans(&protected), (1, 0));
        assert!(dir.path().join("snapshots/r1").is_dir());
    }

    #[test]
    fn failed_handoff_preserves_failure_and_missing_snapshot_diagnostic() {
        let dir = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let registry = CoordinationRegistry::new(dir.path().to_path_buf()).unwrap();
        let id = registry.begin(project_intent(project.path())).unwrap();
        registry
            .mark_spawned(&id, "pty-failed".into(), Some(456))
            .unwrap();
        registry.finish_by_pty("pty-failed", Some(2)).unwrap();
        registry
            .record_handoff_for_run(HandoffInput {
                run_id: "r1".into(),
                card_id: None,
                failure: Some("review command failed".into()),
                snapshot_run_id: None,
                changed_paths: Vec::new(),
                changes_truncated: false,
                swarm_collisions: 0,
                reviewer_artifact: Some(serde_json::json!({"verdict": "changes-requested"})),
            })
            .unwrap()
            .unwrap();
        registry
            .note_handoff_failure_for_run("r1", "disk unavailable")
            .unwrap();

        let state = registry.snapshot();
        let handoff = &state.handoffs[0];
        assert_eq!(handoff.outcome_status, SessionStatus::Failed);
        assert_eq!(handoff.exit_code, Some(2));
        assert_eq!(handoff.failure.as_deref(), Some("review command failed"));
        assert_eq!(
            handoff.reviewer_artifact,
            Some(serde_json::json!({"verdict": "changes-requested"}))
        );
        assert!(handoff
            .evidence_warnings
            .iter()
            .any(|warning| warning.contains("manifest unavailable")));
        assert!(state.sessions[0]
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.contains("disk unavailable")));
    }

    #[test]
    fn retention_prunes_old_terminal_but_never_active_or_protected_handoff() {
        let now = 100 * DAY_MS;
        let mut state = CoordinationState {
            sessions: vec![
                SessionRecord {
                    id: "old".into(),
                    status: SessionStatus::Completed,
                    retention_class: RetentionClass::Ephemeral,
                    ended_at: Some(now - 2 * DAY_MS),
                    ..SessionRecord::default()
                },
                SessionRecord {
                    id: "active".into(),
                    status: SessionStatus::Running,
                    retention_class: RetentionClass::Ephemeral,
                    started_at: 1,
                    ..SessionRecord::default()
                },
            ],
            handoffs: vec![HandoffRecord {
                id: "protected".into(),
                created_at: 1,
                protected_by: vec!["memory-1".into()],
                ..HandoffRecord::default()
            }],
            ..CoordinationState::default()
        };
        assert!(prune_state(&mut state, now));
        assert_eq!(state.sessions.len(), 1);
        assert_eq!(state.sessions[0].id, "active");
        assert_eq!(state.handoffs.len(), 1);
    }

    #[test]
    fn objective_and_errors_are_bounded() {
        let long = "é".repeat(600);
        assert_eq!(bounded(&long, 512).chars().count(), 512);
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn comparison_key_is_case_folded_on_case_insensitive_filesystems() {
        assert_eq!(comparison_key("/TMP/Foo"), "/tmp/foo");
    }
}
