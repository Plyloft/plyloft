//! Shared, mutation-free coordination schema and reader.
//!
//! The Tauri host owns every write to `coordination/state.json`. This crate
//! intentionally exposes only types, pure filtering, and a stateless reader
//! so the `ply-mcp` sidecar cannot acquire a collaboration mutation path.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const COORDINATION_SCHEMA_VERSION: u32 = 1;
pub const COORDINATION_SUBDIR: &str = "coordination";
pub const COORDINATION_FILE: &str = "state.json";

fn current_schema() -> u32 {
    COORDINATION_SCHEMA_VERSION
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Provider {
    #[default]
    System,
    Shell,
    Claude,
    Codex,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExecutionKind {
    #[default]
    Internal,
    ShellTile,
    ProviderTile,
    AgentRepl,
    AgentOneshot,
    SwarmRole,
    Intake,
    VerifyCollector,
    MemorySuggester,
    ReviewerProbe,
    Reviewer,
    DiscussionAnalysis,
    DiscussionCrossReview,
    DiscussionSynthesis,
    /// OB-3: Setup's guided terminal (an install, update or sign-in Ply runs
    /// from its allowlist). Never recorded in the coordination state
    /// (`SpawnIntent::recorded`): it is no project's session, and an older
    /// Ply reading a state file that named it would refuse the whole file.
    Setup,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Attendance {
    #[default]
    HumanAttended,
    Unattended,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WriteIntent {
    ReadOnly,
    Writer,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Enforcement {
    #[default]
    Advisory,
    Exclusive,
    Exempt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityLevel {
    OsSandboxed,
    HarnessEnforced,
    PromptOnly,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionStatus {
    #[default]
    Starting,
    Running,
    Completed,
    Failed,
    Killed,
    Interrupted,
}

impl SessionStatus {
    pub fn is_active(self) -> bool {
        matches!(self, Self::Starting | Self::Running)
    }

    pub fn is_abnormal_terminal(self) -> bool {
        matches!(self, Self::Failed | Self::Killed | Self::Interrupted)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RetentionClass {
    Ephemeral,
    #[default]
    Interactive,
    Unattended,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct IdentityPath {
    pub display_path: String,
    pub comparison_key: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProjectContext {
    pub workspace_id: String,
    pub git: bool,
    pub project: IdentityPath,
    pub worktree: IdentityPath,
    pub display_cwd: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ProjectRelevance {
    Project(ProjectContext),
    NonProject {
        #[serde(default)]
        reason: String,
    },
}

impl Default for ProjectRelevance {
    fn default() -> Self {
        Self::NonProject {
            reason: String::new(),
        }
    }
}

impl ProjectRelevance {
    pub fn project(&self) -> Option<&ProjectContext> {
        match self {
            Self::Project(project) => Some(project),
            Self::NonProject { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CoordinationWarning {
    pub code: String,
    pub peer_session_id: String,
    pub observed_at: i64,
    pub summary: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionRecord {
    #[serde(default = "current_schema")]
    pub schema_version: u32,
    pub id: String,
    pub provider: Provider,
    pub execution_kind: ExecutionKind,
    pub project: ProjectRelevance,
    pub attendance: Attendance,
    pub write_intent: WriteIntent,
    pub enforcement: Enforcement,
    pub capability: Option<CapabilityLevel>,
    pub card_id: Option<String>,
    pub swarm_id: Option<String>,
    pub role_id: Option<String>,
    pub run_id: Option<String>,
    pub handoff_id: Option<String>,
    pub pty_id: Option<String>,
    pub process_id: Option<u32>,
    pub base_revision: Option<String>,
    pub head_revision: Option<String>,
    pub status: SessionStatus,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
    pub diagnostics: Vec<String>,
    pub started_at: i64,
    pub running_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub warnings_observed: Vec<CoordinationWarning>,
    pub retention_class: RetentionClass,
    pub objective: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HandoffChangeSummary {
    pub total: u32,
    pub paths: Vec<String>,
    pub truncated: bool,
    pub swarm_collisions: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HandoffRecord {
    #[serde(default = "current_schema")]
    pub schema_version: u32,
    pub id: String,
    pub workspace_id: String,
    pub project: Option<ProjectContext>,
    pub source_session_id: String,
    pub source_run_id: Option<String>,
    pub card_id: Option<String>,
    pub swarm_id: Option<String>,
    pub role_id: Option<String>,
    pub provider: Provider,
    pub objective: String,
    pub outcome_status: SessionStatus,
    pub exit_code: Option<i32>,
    pub failure: Option<String>,
    pub base_revision: Option<String>,
    pub head_revision: Option<String>,
    pub snapshot_run_id: Option<String>,
    pub changes: HandoffChangeSummary,
    pub reviewer_artifact: Option<serde_json::Value>,
    pub evidence_warnings: Vec<String>,
    pub verification_artifacts: Vec<serde_json::Value>,
    pub follow_ups: Vec<String>,
    pub created_at: i64,
    pub protected_by: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CoordinationState {
    #[serde(default = "current_schema")]
    pub schema_version: u32,
    pub tracking_started_at: i64,
    pub sessions: Vec<SessionRecord>,
    pub handoffs: Vec<HandoffRecord>,
}

impl Default for CoordinationState {
    fn default() -> Self {
        Self {
            schema_version: COORDINATION_SCHEMA_VERSION,
            tracking_started_at: 0,
            sessions: Vec::new(),
            handoffs: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LiveWarning {
    pub session_id: String,
    pub peer_session_id: String,
    pub code: String,
    pub summary: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkspaceCoordinationStatus {
    pub tracking_active: bool,
    pub state: String,
    pub workspace_id: String,
    pub active_sessions: Vec<SessionRecord>,
    pub live_warnings: Vec<LiveWarning>,
    pub recent_interrupted_count: u32,
}

pub fn coordination_path(config_dir: &Path) -> PathBuf {
    config_dir.join(COORDINATION_SUBDIR).join(COORDINATION_FILE)
}

pub fn validate_state(state: CoordinationState) -> Result<CoordinationState, String> {
    if state.schema_version > COORDINATION_SCHEMA_VERSION {
        return Err(format!(
            "coordination schema {} is newer than supported schema {}",
            state.schema_version, COORDINATION_SCHEMA_VERSION
        ));
    }
    Ok(state)
}

/// An unattended writer is active in the same folder as this session.
pub const UNATTENDED_WRITER_ACTIVE: &str = "unattended-writer-active";
/// This session is the unattended writer; a human session shares its folder.
pub const HUMAN_SESSION_ACTIVE: &str = "human-session-active";
/// 1.173.0 (A4): two Claude/Codex terminals the member opened work in one
/// folder. Neither is an unattended writer, and either can change the same
/// files without seeing the other's edits. Plain shell tiles stay out: they
/// write nothing by themselves.
pub const TWO_PROVIDER_TILES: &str = "two-provider-tiles";

/// The one overlap rule: the warning `session` carries about `peer`, if any.
///
/// Both the live status (`workspace_status_from_state`) and the observed
/// history the host writes at spawn (`coordination::overlap_warning_pair`)
/// call this, and both suites run `fixtures/overlap_warnings.json`
/// (PATTERNS.md, "Duplicate implementations consume one fixture"). The rule is
/// symmetric in whether it fires: when `session` warns about `peer`, `peer`
/// warns about `session`. Two sessions overlap only when their worktree
/// comparison keys are equal, so a tile in a card's copy, or in a copy
/// without a card, never warns against the project folder.
pub fn overlap_warning(
    session: &SessionRecord,
    peer: &SessionRecord,
) -> Option<(&'static str, &'static str)> {
    let session_project = session.project.project()?;
    let peer_project = peer.project.project()?;
    if session_project.worktree.comparison_key != peer_project.worktree.comparison_key {
        return None;
    }
    let session_writer =
        session.attendance == Attendance::Unattended && session.write_intent == WriteIntent::Writer;
    let peer_writer =
        peer.attendance == Attendance::Unattended && peer.write_intent == WriteIntent::Writer;
    if peer_writer {
        return Some((
            UNATTENDED_WRITER_ACTIVE,
            "Unattended writer active in this worktree",
        ));
    }
    if session_writer {
        return Some((HUMAN_SESSION_ACTIVE, "Human session open in this worktree"));
    }
    if session.execution_kind == ExecutionKind::ProviderTile
        && peer.execution_kind == ExecutionKind::ProviderTile
    {
        return Some((
            TWO_PROVIDER_TILES,
            "Another AI terminal is working in this folder",
        ));
    }
    None
}

pub fn workspace_status_from_state(
    state: &CoordinationState,
    workspace_id: &str,
) -> WorkspaceCoordinationStatus {
    let mut active_sessions: Vec<SessionRecord> = state
        .sessions
        .iter()
        .filter(|session| {
            session.status.is_active()
                && session
                    .project
                    .project()
                    .map(|project| project.workspace_id == workspace_id)
                    .unwrap_or(false)
        })
        .cloned()
        .collect();
    active_sessions.sort_by(|a, b| a.started_at.cmp(&b.started_at).then(a.id.cmp(&b.id)));

    let mut live_warnings = Vec::new();
    for session in &active_sessions {
        for peer in &active_sessions {
            if session.id == peer.id {
                continue;
            }
            let Some((code, summary)) = overlap_warning(session, peer) else {
                continue;
            };
            live_warnings.push(LiveWarning {
                session_id: session.id.clone(),
                peer_session_id: peer.id.clone(),
                code: code.to_string(),
                summary: summary.to_string(),
            });
        }
    }
    live_warnings.sort_by(|a, b| {
        a.session_id
            .cmp(&b.session_id)
            .then(a.peer_session_id.cmp(&b.peer_session_id))
    });
    live_warnings.dedup_by(|a, b| {
        a.session_id == b.session_id && a.peer_session_id == b.peer_session_id && a.code == b.code
    });

    let recent_interrupted_count = state
        .sessions
        .iter()
        .filter(|session| {
            session.status == SessionStatus::Interrupted
                && session
                    .project
                    .project()
                    .map(|project| project.workspace_id == workspace_id)
                    .unwrap_or(false)
        })
        .count()
        .min(u32::MAX as usize) as u32;

    WorkspaceCoordinationStatus {
        tracking_active: true,
        state: "active".to_string(),
        workspace_id: workspace_id.to_string(),
        active_sessions,
        live_warnings,
        recent_interrupted_count,
    }
}

pub fn recent_handoffs_from_state(
    state: &CoordinationState,
    workspace_id: &str,
    limit: usize,
) -> Vec<HandoffRecord> {
    let mut handoffs: Vec<HandoffRecord> = state
        .handoffs
        .iter()
        .filter(|handoff| handoff.workspace_id == workspace_id)
        .cloned()
        .collect();
    handoffs.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    handoffs.truncate(limit);
    handoffs
}

#[derive(Debug, Clone)]
pub struct CoordinationReader {
    path: PathBuf,
}

impl CoordinationReader {
    pub fn new(config_dir: impl AsRef<Path>) -> Result<Self, String> {
        let config_dir = config_dir.as_ref();
        if !config_dir.is_absolute() {
            return Err(format!(
                "Plyloft config directory must be absolute: {}",
                config_dir.display()
            ));
        }
        Ok(Self {
            path: coordination_path(config_dir),
        })
    }

    pub fn read(&self) -> Result<Option<CoordinationState>, String> {
        if !self.path.exists() {
            return Ok(None);
        }
        let bytes =
            fs::read(&self.path).map_err(|error| format!("read coordination state: {error}"))?;
        let state: CoordinationState = serde_json::from_slice(&bytes)
            .map_err(|error| format!("parse coordination state: {error}"))?;
        validate_state(state).map(Some)
    }

    pub fn workspace_status(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceCoordinationStatus, String> {
        validate_workspace_id(workspace_id)?;
        let Some(state) = self.read()? else {
            return Ok(WorkspaceCoordinationStatus {
                tracking_active: false,
                state: "tracking_not_active".to_string(),
                workspace_id: workspace_id.to_string(),
                ..WorkspaceCoordinationStatus::default()
            });
        };
        Ok(workspace_status_from_state(&state, workspace_id))
    }

    pub fn recent_handoffs(
        &self,
        workspace_id: &str,
        limit: usize,
    ) -> Result<Vec<HandoffRecord>, String> {
        validate_workspace_id(workspace_id)?;
        let Some(state) = self.read()? else {
            return Ok(Vec::new());
        };
        Ok(recent_handoffs_from_state(&state, workspace_id, limit))
    }
}

fn validate_workspace_id(workspace_id: &str) -> Result<(), String> {
    let path = Path::new(workspace_id);
    let one_component = path.components().count() == 1;
    if workspace_id.trim().is_empty()
        || workspace_id == "."
        || workspace_id == ".."
        || !one_component
    {
        return Err("workspace id must be one safe path component".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(workspace_id: &str, key: &str) -> ProjectRelevance {
        ProjectRelevance::Project(ProjectContext {
            workspace_id: workspace_id.to_string(),
            git: true,
            project: IdentityPath {
                display_path: "/repo/.git".into(),
                comparison_key: "/repo/.git".into(),
            },
            worktree: IdentityPath {
                display_path: key.into(),
                comparison_key: key.into(),
            },
            display_cwd: key.into(),
        })
    }

    #[test]
    fn legacy_session_and_handoff_fields_default() {
        let raw = r#"{
          "schemaVersion": 1,
          "trackingStartedAt": 10,
          "sessions": [{
            "id": "s1",
            "project": {"kind":"non-project","reason":"probe"}
          }],
          "handoffs": [{
            "id":"h1",
            "workspaceId":"w1",
            "sourceSessionId":"s1"
          }]
        }"#;
        let state: CoordinationState = serde_json::from_str(raw).unwrap();
        assert_eq!(state.sessions[0].provider, Provider::System);
        assert_eq!(state.sessions[0].status, SessionStatus::Starting);
        assert!(state.sessions[0].warnings_observed.is_empty());
        assert!(state.sessions[0].diagnostics.is_empty());
        assert!(state.handoffs[0].protected_by.is_empty());
        assert!(state.handoffs[0].changes.paths.is_empty());
    }

    #[test]
    fn current_state_roundtrips() {
        let mut state = CoordinationState {
            tracking_started_at: 12,
            ..CoordinationState::default()
        };
        state.sessions.push(SessionRecord {
            id: "s1".into(),
            project: project("w1", "/repo"),
            provider: Provider::Claude,
            status: SessionStatus::Running,
            ..SessionRecord::default()
        });
        state.handoffs.push(HandoffRecord {
            id: "h1".into(),
            workspace_id: "w1".into(),
            source_session_id: "s1".into(),
            created_at: 13,
            ..HandoffRecord::default()
        });
        let encoded = serde_json::to_vec(&state).unwrap();
        let decoded: CoordinationState = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded, state);
    }

    #[test]
    fn future_schema_is_rejected() {
        let state = CoordinationState {
            schema_version: COORDINATION_SCHEMA_VERSION + 1,
            ..CoordinationState::default()
        };
        let error = validate_state(state).unwrap_err();
        assert!(error.contains("newer"));
    }

    #[test]
    fn missing_reader_state_is_truthfully_inactive() {
        let dir = tempfile::tempdir().unwrap();
        let reader = CoordinationReader::new(dir.path()).unwrap();
        let status = reader.workspace_status("w1").unwrap();
        assert!(!status.tracking_active);
        assert_eq!(status.state, "tracking_not_active");
    }

    #[test]
    fn workspace_status_filters_and_derives_live_warning() {
        let mut state = CoordinationState::default();
        state.sessions.push(SessionRecord {
            id: "human".into(),
            project: project("w1", "/repo"),
            attendance: Attendance::HumanAttended,
            write_intent: WriteIntent::Unknown,
            status: SessionStatus::Running,
            ..SessionRecord::default()
        });
        state.sessions.push(SessionRecord {
            id: "writer".into(),
            project: project("w1", "/repo"),
            attendance: Attendance::Unattended,
            write_intent: WriteIntent::Writer,
            status: SessionStatus::Running,
            ..SessionRecord::default()
        });
        state.sessions.push(SessionRecord {
            id: "other".into(),
            project: project("w2", "/other"),
            status: SessionStatus::Running,
            ..SessionRecord::default()
        });
        let status = workspace_status_from_state(&state, "w1");
        assert_eq!(status.active_sessions.len(), 2);
        assert_eq!(status.live_warnings.len(), 2);
        assert!(status
            .live_warnings
            .iter()
            .any(|warning| warning.session_id == "human"
                && warning.code == "unattended-writer-active"));
    }

    /// One side of a case in `fixtures/overlap_warnings.json`, as a running
    /// session of workspace `w1`.
    fn fixture_session(id: &str, side: &serde_json::Value) -> SessionRecord {
        let mut fields = side.as_object().unwrap().clone();
        let worktree = fields.remove("worktree").unwrap();
        let non_project = fields.remove("nonProject").and_then(|v| v.as_bool()) == Some(true);
        let mut record: SessionRecord =
            serde_json::from_value(serde_json::Value::Object(fields)).unwrap();
        record.id = id.into();
        record.status = SessionStatus::Running;
        record.project = if non_project {
            ProjectRelevance::NonProject {
                reason: "fixture".into(),
            }
        } else {
            project("w1", worktree.as_str().unwrap())
        };
        record
    }

    /// A peer that has ended (completed, interrupted, killed, failed) is no
    /// longer active, so a live tile never warns about it.
    #[test]
    fn ended_provider_tile_peers_do_not_warn() {
        for ended in [
            SessionStatus::Completed,
            SessionStatus::Interrupted,
            SessionStatus::Killed,
            SessionStatus::Failed,
        ] {
            let live = SessionRecord {
                id: "live".into(),
                execution_kind: ExecutionKind::ProviderTile,
                status: SessionStatus::Running,
                project: project("w1", "/repo"),
                ..SessionRecord::default()
            };
            let gone = SessionRecord {
                id: "gone".into(),
                status: ended,
                ..live.clone()
            };
            let state = CoordinationState {
                sessions: vec![live, gone],
                ..CoordinationState::default()
            };
            let status = workspace_status_from_state(&state, "w1");
            assert_eq!(status.active_sessions.len(), 1, "{ended:?}");
            assert!(status.live_warnings.is_empty(), "{ended:?}");
        }
    }

    #[test]
    fn live_warnings_follow_the_shared_overlap_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/overlap_warnings.json")).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() >= 5);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let state = CoordinationState {
                sessions: vec![
                    fixture_session("a", &case["a"]),
                    fixture_session("b", &case["b"]),
                ],
                ..CoordinationState::default()
            };
            let status = workspace_status_from_state(&state, "w1");
            let code_of = |id: &str| {
                status
                    .live_warnings
                    .iter()
                    .find(|warning| warning.session_id == id)
                    .map(|warning| warning.code.clone())
            };
            let expect = |key: &str| case[key].as_str().map(str::to_string);
            assert_eq!(code_of("a"), expect("aWarns"), "{name}: a");
            assert_eq!(code_of("b"), expect("bWarns"), "{name}: b");
            assert!(status.live_warnings.len() <= 2, "{name}: one warning a side");
            if let Some(warning) = status.live_warnings.iter().find(|w| w.session_id == "a") {
                assert_eq!(warning.peer_session_id, "b", "{name}");
            }
        }
    }

    #[test]
    fn two_provider_tiles_name_the_folder_not_a_worktree() {
        let mut a = SessionRecord {
            id: "a".into(),
            execution_kind: ExecutionKind::ProviderTile,
            status: SessionStatus::Running,
            project: project("w1", "/repo"),
            ..SessionRecord::default()
        };
        let b = SessionRecord {
            id: "b".into(),
            ..a.clone()
        };
        let (code, summary) = overlap_warning(&a, &b).unwrap();
        assert_eq!(code, TWO_PROVIDER_TILES);
        assert!(summary.contains("folder") && !summary.contains("worktree"));
        // A session of another workspace's state never reaches this rule, and
        // a non-project session never overlaps.
        a.project = ProjectRelevance::default();
        assert!(overlap_warning(&a, &b).is_none());
    }

    #[test]
    fn handoffs_are_workspace_scoped_newest_first_and_limited() {
        let state = CoordinationState {
            handoffs: vec![
                HandoffRecord {
                    id: "old".into(),
                    workspace_id: "w1".into(),
                    created_at: 1,
                    ..HandoffRecord::default()
                },
                HandoffRecord {
                    id: "other".into(),
                    workspace_id: "w2".into(),
                    created_at: 3,
                    ..HandoffRecord::default()
                },
                HandoffRecord {
                    id: "new".into(),
                    workspace_id: "w1".into(),
                    created_at: 2,
                    ..HandoffRecord::default()
                },
            ],
            ..CoordinationState::default()
        };
        let handoffs = recent_handoffs_from_state(&state, "w1", 1);
        assert_eq!(handoffs.len(), 1);
        assert_eq!(handoffs[0].id, "new");
    }
}
