//! Bounded, observation-only receipts for the installed P3-1 walk.
//!
//! This module owns validation and provenance. It accepts only typed facts
//! about a pre-existing UI scenario, recomputes the result, and writes one
//! atomic JSON receipt in Ply's existing log directory. It never prepares
//! product state or controls a provider, PTY, card, or WebView.

use crate::bundle_fingerprint::BundleFingerprint;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

pub const SELF_CHECK_SCHEMA_VERSION: u32 = 1;
pub const BUNDLE_FINGERPRINT_ALGORITHM: &str = "ply_bundle_manifest_v1_sha256";
const MAX_OBSERVATIONS: usize = 256;
/// GH #104: sixteen, since the three post-ship lesson-proposal states were
/// retired with the feature (ADR 0005). Kept equal to
/// [`ALL_CARD_PRESENTATION_STATES`]'s length by the test that walks both.
const MAX_STATE_FACTS: usize = ALL_CARD_PRESENTATION_STATES.len();
const MAX_OPAQUE_ID_BYTES: usize = 128;
const MAX_REASONS_PER_CHECK: usize = 8;
const MAX_DIAGNOSTIC_BYTES: usize = 512;

fn schema_version() -> u32 {
    SELF_CHECK_SCHEMA_VERSION
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SelfCheckReportKind {
    #[default]
    P3_1InstalledWalk,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SelfCheckOverall {
    Passed,
    Failed,
    #[default]
    Incomplete,
    ProvenanceError,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SelfCheckId {
    DraftPrimaryAction,
    EmptyIntakeHostMeasurable,
    IntakeBackendPtyContinuity,
    IntakeMountContinuity,
    IntakeScrollContinuity,
    IntakeStepTransition,
    IntakeModeTransition,
    IntakeWorkspaceTransition,
    IntakeCardCloseReopen,
    IntakeDisclosureTransitions,
    AllCardStatesObserved,
    OnePrimaryActionPerState,
    CmdEnterFocusGuards,
    CmdEnterNeverShips,
}

pub const ALL_SELF_CHECK_IDS: [SelfCheckId; 14] = [
    SelfCheckId::DraftPrimaryAction,
    SelfCheckId::EmptyIntakeHostMeasurable,
    SelfCheckId::IntakeBackendPtyContinuity,
    SelfCheckId::IntakeMountContinuity,
    SelfCheckId::IntakeScrollContinuity,
    SelfCheckId::IntakeStepTransition,
    SelfCheckId::IntakeModeTransition,
    SelfCheckId::IntakeWorkspaceTransition,
    SelfCheckId::IntakeCardCloseReopen,
    SelfCheckId::IntakeDisclosureTransitions,
    SelfCheckId::AllCardStatesObserved,
    SelfCheckId::OnePrimaryActionPerState,
    SelfCheckId::CmdEnterFocusGuards,
    SelfCheckId::CmdEnterNeverShips,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SelfCheckStatus {
    Passed,
    Failed,
    #[default]
    NotObserved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SelfCheckFailureReason {
    MissingHost,
    ZeroGeometry,
    DisplayNoneAncestor,
    ClosedDetailsAncestor,
    IntakeRegistryMissing,
    PtyMismatch,
    PtyNotLive,
    MountChanged,
    ScrollReset,
    BufferKindMissing,
    BufferKindChanged,
    GridMissing,
    GridChanged,
    ResizeEpochMissing,
    ResizeEpochChanged,
    StateMissing,
    StoreDomMismatch,
    MissingPrimaryAction,
    MultiplePrimaryActions,
    GuardedActionInvoked,
    KeyboardShipInvoked,
    ObservationCapReached,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelfCheckDraftCheck {
    pub id: SelfCheckId,
    pub status: SelfCheckStatus,
    #[serde(default)]
    pub reasons: Vec<SelfCheckFailureReason>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CardPresentationState {
    Archived,
    Shipped,
    Shipping,
    Running,
    Paused,
    Queued,
    Checking,
    VerifyFailed,
    Failed,
    ReviewStale,
    NoChanges,
    ReadyToShip,
    ResultReady,
    IntakeLive,
    Ready,
    Draft,
}

pub const ALL_CARD_PRESENTATION_STATES: [CardPresentationState; 16] = [
    CardPresentationState::Archived,
    CardPresentationState::Shipped,
    CardPresentationState::Shipping,
    CardPresentationState::Running,
    CardPresentationState::Paused,
    CardPresentationState::Queued,
    CardPresentationState::Checking,
    CardPresentationState::VerifyFailed,
    CardPresentationState::Failed,
    CardPresentationState::ReviewStale,
    CardPresentationState::NoChanges,
    CardPresentationState::ReadyToShip,
    CardPresentationState::ResultReady,
    CardPresentationState::IntakeLive,
    CardPresentationState::Ready,
    CardPresentationState::Draft,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrimaryActionTone {
    Accent,
    Quiet,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CardStateEvidenceOrigin {
    Seeded,
    #[default]
    Reached,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntakeCheckpoint {
    Initial,
    Step,
    Mode,
    Workspace,
    CardCloseReopen,
    Disclosure,
    Scroll,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntakeBufferKind {
    Normal,
    Alternate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionSource {
    Pointer,
    Keyboard,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FocusCategory {
    CardBackground,
    Input,
    Textarea,
    Contenteditable,
    CodeMirror,
    Xterm,
    OutsideCard,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntakeHostFact {
    pub sequence: u16,
    pub checkpoint: IntakeCheckpoint,
    #[serde(default)]
    pub transition_id: Option<String>,
    pub pty_id: String,
    pub mount_id: String,
    pub viewport_row: u32,
    #[serde(default)]
    pub scrollback_rows: u32,
    #[serde(default)]
    pub scroll_observed: bool,
    #[serde(default)]
    pub buffer_kind: Option<IntakeBufferKind>,
    #[serde(default)]
    pub cols: u16,
    #[serde(default)]
    pub rows: u16,
    #[serde(default)]
    pub resize_epoch: Option<u32>,
    pub width: u32,
    pub height: u32,
    pub connected: bool,
    pub display_none_ancestor: bool,
    pub closed_details_ancestor: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CardStateFact {
    pub sequence: u16,
    #[serde(default)]
    pub card_id: String,
    #[serde(default)]
    pub evidence_origin: CardStateEvidenceOrigin,
    #[serde(default)]
    pub store_state: Option<CardPresentationState>,
    pub rendered_state: CardPresentationState,
    pub action_id: Option<String>,
    pub tone: Option<PrimaryActionTone>,
    pub action_enabled: bool,
    pub primary_action_count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiCapabilityFact {
    pub sequence: u16,
    pub standalone_contenteditable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionTraceFact {
    pub sequence: u16,
    pub state: CardPresentationState,
    pub action_id: Option<String>,
    pub source: ActionSource,
    pub focus_category: FocusCategory,
    pub primary_action_invocations: u32,
    pub ship_invocations: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntakeAuthorityFact {
    pub sequence: u16,
    pub checkpoint: IntakeCheckpoint,
    pub observed_pty_id: String,
    pub authoritative_pty_id: Option<String>,
    pub intake_registered: bool,
    pub pty_ids_match: bool,
    pub observed_pty_live: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "fact", rename_all = "snake_case")]
pub enum SelfCheckObservation {
    IntakeHost(IntakeHostFact),
    IntakeAuthority(IntakeAuthorityFact),
    CardState(CardStateFact),
    UiCapability(UiCapabilityFact),
    ActionTrace(ActionTraceFact),
}

impl SelfCheckObservation {
    fn sequence(&self) -> u16 {
        match self {
            Self::IntakeHost(fact) => fact.sequence,
            Self::IntakeAuthority(fact) => fact.sequence,
            Self::CardState(fact) => fact.sequence,
            Self::UiCapability(fact) => fact.sequence,
            Self::ActionTrace(fact) => fact.sequence,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstalledSelfCheckDraftV1 {
    pub workspace_id: String,
    pub card_id: String,
    pub checks: Vec<SelfCheckDraftCheck>,
    #[serde(default)]
    pub observations: Vec<SelfCheckObservation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSelfCheckReportV1 {
    #[serde(default = "schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub report_id: String,
    #[serde(default)]
    pub report_kind: SelfCheckReportKind,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub app_version: String,
    #[serde(default)]
    pub bundle_fingerprint: Option<String>,
    #[serde(default)]
    pub bundle_fingerprint_algorithm: String,
    #[serde(default)]
    pub overall: SelfCheckOverall,
    #[serde(default)]
    pub workspace_id: String,
    #[serde(default)]
    pub card_id: String,
    #[serde(default)]
    pub checks: Vec<SelfCheckDraftCheck>,
    #[serde(default)]
    pub observations: Vec<SelfCheckObservation>,
    #[serde(default)]
    pub observation_count: u32,
    #[serde(default)]
    pub observation_cap_reached: bool,
    #[serde(default)]
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSelfCheckReportReceipt {
    pub report_path: String,
    pub report: InstalledSelfCheckReportV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakeAuthorityCheckpoint {
    pub card_id: String,
    pub observed_pty_id: String,
    pub intake_registered: bool,
    pub authoritative_pty_id: Option<String>,
    pub pty_ids_match: bool,
    pub observed_pty_live: bool,
}

fn validate_opaque_id(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{label} is empty"));
    }
    if value.len() > MAX_OPAQUE_ID_BYTES {
        return Err(format!("{label} exceeds {MAX_OPAQUE_ID_BYTES} bytes"));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("{label} contains a control character"));
    }
    Ok(())
}

fn validate_draft(draft: &InstalledSelfCheckDraftV1) -> Result<(), String> {
    validate_opaque_id("workspace id", &draft.workspace_id)?;
    validate_opaque_id("card id", &draft.card_id)?;
    if draft.checks.len() != ALL_SELF_CHECK_IDS.len() {
        return Err(format!(
            "self-check requires exactly {} checks",
            ALL_SELF_CHECK_IDS.len()
        ));
    }
    let mut seen = HashSet::new();
    for check in &draft.checks {
        if !seen.insert(check.id) {
            return Err(format!("duplicate self-check id: {:?}", check.id));
        }
        match check.status {
            SelfCheckStatus::Passed if !check.reasons.is_empty() => {
                return Err(format!(
                    "passed self-check {:?} cannot carry failure reasons",
                    check.id
                ));
            }
            SelfCheckStatus::Failed if check.reasons.is_empty() => {
                return Err(format!(
                    "failed self-check {:?} requires a typed reason",
                    check.id
                ));
            }
            _ => {}
        }
    }
    if seen.len() != ALL_SELF_CHECK_IDS.len()
        || ALL_SELF_CHECK_IDS.iter().any(|id| !seen.contains(id))
    {
        return Err("self-check ids do not match the P3-1 contract".into());
    }

    if draft.observations.len() > MAX_OBSERVATIONS {
        return Err(format!(
            "self-check exceeds the {MAX_OBSERVATIONS}-observation cap"
        ));
    }
    let state_facts = draft
        .observations
        .iter()
        .filter(|observation| matches!(observation, SelfCheckObservation::CardState(_)))
        .count();
    if state_facts > MAX_STATE_FACTS {
        return Err(format!(
            "self-check exceeds the {MAX_STATE_FACTS}-state-fact cap"
        ));
    }
    for (index, observation) in draft.observations.iter().enumerate() {
        if usize::from(observation.sequence()) != index {
            return Err("self-check observation sequence is not contiguous".into());
        }
        match observation {
            SelfCheckObservation::IntakeHost(fact) => {
                validate_opaque_id("observed PTY id", &fact.pty_id)?;
                validate_opaque_id("intake mount id", &fact.mount_id)?;
                if let Some(transition_id) = &fact.transition_id {
                    validate_opaque_id("intake transition id", transition_id)?;
                }
            }
            SelfCheckObservation::IntakeAuthority(fact) => {
                validate_opaque_id("authority observed PTY id", &fact.observed_pty_id)?;
                if let Some(pty_id) = &fact.authoritative_pty_id {
                    validate_opaque_id("authority backend PTY id", pty_id)?;
                }
            }
            SelfCheckObservation::CardState(fact) => {
                validate_opaque_id("observed card id", &fact.card_id)?;
                if let Some(action_id) = &fact.action_id {
                    validate_opaque_id("primary action id", action_id)?;
                }
            }
            SelfCheckObservation::UiCapability(_) => {}
            SelfCheckObservation::ActionTrace(fact) => {
                if let Some(action_id) = &fact.action_id {
                    validate_opaque_id("action trace id", action_id)?;
                }
            }
        }
    }
    validate_pass_claims(draft)?;
    Ok(())
}

fn intake_hosts(draft: &InstalledSelfCheckDraftV1) -> Vec<&IntakeHostFact> {
    draft
        .observations
        .iter()
        .filter_map(|observation| match observation {
            SelfCheckObservation::IntakeHost(fact) => Some(fact),
            _ => None,
        })
        .collect()
}

fn card_states(draft: &InstalledSelfCheckDraftV1) -> Vec<&CardStateFact> {
    draft
        .observations
        .iter()
        .filter_map(|observation| match observation {
            SelfCheckObservation::CardState(fact) => Some(fact),
            _ => None,
        })
        .collect()
}

fn action_traces(draft: &InstalledSelfCheckDraftV1) -> Vec<&ActionTraceFact> {
    draft
        .observations
        .iter()
        .filter_map(|observation| match observation {
            SelfCheckObservation::ActionTrace(fact) => Some(fact),
            _ => None,
        })
        .collect()
}

fn ui_capabilities(draft: &InstalledSelfCheckDraftV1) -> Vec<&UiCapabilityFact> {
    draft
        .observations
        .iter()
        .filter_map(|observation| match observation {
            SelfCheckObservation::UiCapability(fact) => Some(fact),
            _ => None,
        })
        .collect()
}

fn host_is_measurable(fact: &IntakeHostFact) -> bool {
    fact.connected
        && fact.width > 0
        && fact.height > 0
        && !fact.display_none_ancestor
        && !fact.closed_details_ancestor
}

fn host_checkpoint_supported(
    hosts: &[&IntakeHostFact],
    checkpoint: IntakeCheckpoint,
    minimum: usize,
) -> bool {
    let pairs = host_transition_pairs(hosts, Some(checkpoint));
    pairs.len() >= minimum
        && pairs.into_iter().all(|(before, after)| {
            before.pty_id == after.pty_id
                && before.mount_id == after.mount_id
                && before.viewport_row == after.viewport_row
                && host_is_measurable(before)
                && host_is_measurable(after)
        })
}

fn host_transition_pairs<'a>(
    hosts: &[&'a IntakeHostFact],
    checkpoint: Option<IntakeCheckpoint>,
) -> Vec<(&'a IntakeHostFact, &'a IntakeHostFact)> {
    let mut grouped: BTreeMap<&str, Vec<&IntakeHostFact>> = BTreeMap::new();
    for fact in hosts {
        let Some(transition_id) = fact.transition_id.as_deref() else {
            continue;
        };
        if checkpoint.is_some_and(|expected| fact.checkpoint != expected) {
            continue;
        }
        grouped.entry(transition_id).or_default().push(fact);
    }
    grouped
        .into_values()
        .filter_map(|group| (group.len() == 2).then(|| (group[0], group[1])))
        .collect()
}

fn nonempty_all<T>(items: &[T], predicate: impl Fn(&T) -> bool) -> bool {
    !items.is_empty() && items.iter().all(predicate)
}

fn passed_claim_supported(id: SelfCheckId, draft: &InstalledSelfCheckDraftV1) -> bool {
    let hosts = intake_hosts(draft);
    let states = card_states(draft);
    let traces = action_traces(draft);
    let capabilities = ui_capabilities(draft);
    match id {
        SelfCheckId::DraftPrimaryAction => states.iter().any(|fact| {
            fact.store_state == Some(CardPresentationState::Draft)
                && fact.rendered_state == CardPresentationState::Draft
                && fact.action_id.is_some()
                && fact.tone == Some(PrimaryActionTone::Accent)
                && fact.action_enabled
                && fact.primary_action_count == 1
        }),
        SelfCheckId::EmptyIntakeHostMeasurable => hosts.iter().any(|fact| host_is_measurable(fact)),
        SelfCheckId::IntakeBackendPtyContinuity => {
            let authority: Vec<_> = draft
                .observations
                .iter()
                .filter_map(|observation| match observation {
                    SelfCheckObservation::IntakeAuthority(fact) => Some(fact),
                    _ => None,
                })
                .collect();
            authority.len() >= 2
                && authority.iter().all(|fact| {
                    fact.intake_registered
                        && fact.pty_ids_match
                        && fact.observed_pty_live
                        && fact.authoritative_pty_id.as_deref()
                            == Some(fact.observed_pty_id.as_str())
                })
        }
        SelfCheckId::IntakeMountContinuity => {
            if hosts.len() < 2 {
                return false;
            }
            let first = hosts[0];
            hosts.iter().all(|fact| {
                fact.pty_id == first.pty_id
                    && fact.mount_id == first.mount_id
                    && host_is_measurable(fact)
            })
        }
        SelfCheckId::IntakeScrollContinuity => {
            if hosts.iter().any(|fact| {
                fact.buffer_kind.is_none()
                    || fact.cols == 0
                    || fact.rows == 0
                    || fact.resize_epoch.is_none()
            }) {
                return false;
            }
            let alternate_epochs: HashSet<_> = hosts
                .iter()
                .filter(|fact| fact.buffer_kind == Some(IntakeBufferKind::Alternate))
                .filter_map(|fact| fact.resize_epoch)
                .collect();
            if alternate_epochs.len() > 1 {
                return false;
            }
            let authority: Vec<_> = draft
                .observations
                .iter()
                .filter_map(|observation| match observation {
                    SelfCheckObservation::IntakeAuthority(fact) => Some(fact),
                    _ => None,
                })
                .collect();
            if authority.len() < 2
                || !authority.iter().all(|fact| {
                    fact.intake_registered
                        && fact.pty_ids_match
                        && fact.observed_pty_live
                        && fact.authoritative_pty_id.as_deref()
                            == Some(fact.observed_pty_id.as_str())
                })
            {
                return false;
            }
            let transition_pairs = host_transition_pairs(&hosts, None);
            nonempty_all(&transition_pairs, |(before, after)| {
                if before.pty_id != after.pty_id
                    || before.mount_id != after.mount_id
                    || !host_is_measurable(before)
                    || !host_is_measurable(after)
                    || before.buffer_kind != after.buffer_kind
                {
                    return false;
                }
                match before.buffer_kind {
                    Some(IntakeBufferKind::Normal) => {
                        before.scroll_observed
                            && after.scroll_observed
                            && before.viewport_row > 0
                            && before.scrollback_rows > before.viewport_row
                            && before.viewport_row == after.viewport_row
                            && after.scrollback_rows > after.viewport_row
                    }
                    Some(IntakeBufferKind::Alternate) => {
                        before.cols > 0
                            && before.rows > 0
                            && before.cols == after.cols
                            && before.rows == after.rows
                            && before.resize_epoch == after.resize_epoch
                    }
                    None => false,
                }
            })
        }
        SelfCheckId::IntakeStepTransition => {
            host_checkpoint_supported(&hosts, IntakeCheckpoint::Step, 1)
        }
        SelfCheckId::IntakeModeTransition => {
            host_checkpoint_supported(&hosts, IntakeCheckpoint::Mode, 1)
        }
        SelfCheckId::IntakeWorkspaceTransition => {
            host_checkpoint_supported(&hosts, IntakeCheckpoint::Workspace, 1)
        }
        SelfCheckId::IntakeCardCloseReopen => {
            host_checkpoint_supported(&hosts, IntakeCheckpoint::CardCloseReopen, 1)
        }
        SelfCheckId::IntakeDisclosureTransitions => {
            host_checkpoint_supported(&hosts, IntakeCheckpoint::Disclosure, 2)
        }
        SelfCheckId::AllCardStatesObserved => {
            let distinct: HashSet<_> = states.iter().filter_map(|fact| fact.store_state).collect();
            states.len() == MAX_STATE_FACTS && distinct.len() == MAX_STATE_FACTS
        }
        SelfCheckId::OnePrimaryActionPerState => {
            states.len() == MAX_STATE_FACTS
                && states.iter().all(|fact| {
                    fact.store_state == Some(fact.rendered_state)
                        && fact.action_id.is_some()
                        && fact.primary_action_count == 1
                })
        }
        SelfCheckId::CmdEnterFocusGuards => {
            let mut guarded = vec![
                FocusCategory::Input,
                FocusCategory::Textarea,
                FocusCategory::CodeMirror,
                FocusCategory::Xterm,
                FocusCategory::OutsideCard,
            ];
            if capabilities
                .iter()
                .any(|fact| fact.standalone_contenteditable)
            {
                guarded.push(FocusCategory::Contenteditable);
            }
            if capabilities.is_empty() {
                return false;
            }
            guarded.iter().all(|focus| {
                let matching: Vec<_> = traces
                    .iter()
                    .copied()
                    .filter(|fact| {
                        fact.source == ActionSource::Keyboard && fact.focus_category == *focus
                    })
                    .collect();
                nonempty_all(&matching, |fact| {
                    fact.primary_action_invocations == 0 && fact.ship_invocations == 0
                })
            }) && {
                let eligible_background: Vec<_> = traces
                    .iter()
                    .copied()
                    .filter(|fact| {
                        fact.source == ActionSource::Keyboard
                            && fact.focus_category == FocusCategory::CardBackground
                            && fact.state != CardPresentationState::ReadyToShip
                    })
                    .collect();
                nonempty_all(&eligible_background, |fact| {
                    fact.primary_action_invocations == 1 && fact.ship_invocations == 0
                })
            }
        }
        SelfCheckId::CmdEnterNeverShips => {
            let ready_to_ship: Vec<_> = traces
                .iter()
                .copied()
                .filter(|fact| {
                    fact.source == ActionSource::Keyboard
                        && fact.focus_category == FocusCategory::CardBackground
                        && fact.state == CardPresentationState::ReadyToShip
                })
                .collect();
            nonempty_all(&ready_to_ship, |fact| {
                fact.primary_action_invocations == 0 && fact.ship_invocations == 0
            })
        }
    }
}

fn validate_pass_claims(draft: &InstalledSelfCheckDraftV1) -> Result<(), String> {
    for check in &draft.checks {
        if check.status == SelfCheckStatus::Passed && !passed_claim_supported(check.id, draft) {
            return Err(format!(
                "passed self-check {:?} lacks supporting observations",
                check.id
            ));
        }
    }
    Ok(())
}

fn recompute_overall(checks: &[SelfCheckDraftCheck], provenance_ok: bool) -> SelfCheckOverall {
    if !provenance_ok {
        SelfCheckOverall::ProvenanceError
    } else if checks
        .iter()
        .any(|check| check.status == SelfCheckStatus::Failed)
    {
        SelfCheckOverall::Failed
    } else if checks
        .iter()
        .any(|check| check.status == SelfCheckStatus::NotObserved)
    {
        SelfCheckOverall::Incomplete
    } else {
        SelfCheckOverall::Passed
    }
}

fn diagnostics_for(checks: &[SelfCheckDraftCheck], provenance_ok: bool) -> Vec<String> {
    let mut diagnostics = Vec::new();
    if !provenance_ok {
        diagnostics.push("installed bundle provenance unavailable".to_string());
    }
    for check in checks {
        if check.status != SelfCheckStatus::Passed {
            let diagnostic = format!("{:?}: {:?}", check.id, check.status);
            diagnostics.push(
                diagnostic
                    .chars()
                    .take(MAX_DIAGNOSTIC_BYTES)
                    .collect::<String>(),
            );
        }
    }
    diagnostics
}

fn report_path(log_dir: &Path, created_at: i64, report_id: &str) -> PathBuf {
    log_dir.join(format!("self-check-p3-1-{created_at}-{report_id}.json"))
}

fn normalize_draft(mut draft: InstalledSelfCheckDraftV1) -> InstalledSelfCheckDraftV1 {
    for check in &mut draft.checks {
        let cap_reached = check
            .reasons
            .contains(&SelfCheckFailureReason::ObservationCapReached);
        let mut seen = HashSet::new();
        let mut normalized = Vec::new();
        let non_cap_limit = if cap_reached {
            MAX_REASONS_PER_CHECK - 1
        } else {
            MAX_REASONS_PER_CHECK
        };
        for reason in check.reasons.iter().copied() {
            if reason == SelfCheckFailureReason::ObservationCapReached {
                continue;
            }
            if seen.insert(reason) && normalized.len() < non_cap_limit {
                normalized.push(reason);
            }
        }
        if cap_reached {
            normalized.push(SelfCheckFailureReason::ObservationCapReached);
        }
        check.reasons = normalized;
    }
    draft
}

pub(crate) fn write_report(
    log_dir: &Path,
    fingerprint: Result<BundleFingerprint, String>,
    draft: InstalledSelfCheckDraftV1,
    created_at: i64,
    report_id: String,
) -> Result<InstalledSelfCheckReportReceipt, String> {
    write_report_where(
        log_dir,
        fingerprint,
        draft,
        created_at,
        report_id,
        crate::bundle_fingerprint::PROVENANCE_APPLIES,
    )
}

/// [`write_report`] on a platform where bundle provenance does or doesn't
/// apply. Where it doesn't (Windows), its absence is noted, not a failure.
fn write_report_where(
    log_dir: &Path,
    fingerprint: Result<BundleFingerprint, String>,
    draft: InstalledSelfCheckDraftV1,
    created_at: i64,
    report_id: String,
    provenance_applies: bool,
) -> Result<InstalledSelfCheckReportReceipt, String> {
    let draft = normalize_draft(draft);
    validate_draft(&draft)?;
    validate_opaque_id("report id", &report_id)?;
    let bundle_fingerprint = fingerprint.ok().map(|value| value.digest);
    let provenance_ok = bundle_fingerprint.is_some() || !provenance_applies;
    let mut diagnostics = diagnostics_for(&draft.checks, provenance_ok);
    if !provenance_applies {
        diagnostics.insert(0, "installed bundle provenance not applicable on this platform".to_string());
    }
    let observation_count = draft.observations.len() as u32;
    let observation_cap_reached = draft.checks.iter().any(|check| {
        check
            .reasons
            .contains(&SelfCheckFailureReason::ObservationCapReached)
    });
    let report = InstalledSelfCheckReportV1 {
        schema_version: SELF_CHECK_SCHEMA_VERSION,
        report_id: report_id.clone(),
        report_kind: SelfCheckReportKind::P3_1InstalledWalk,
        created_at,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        bundle_fingerprint,
        bundle_fingerprint_algorithm: BUNDLE_FINGERPRINT_ALGORITHM.to_string(),
        overall: recompute_overall(&draft.checks, provenance_ok),
        workspace_id: draft.workspace_id,
        card_id: draft.card_id,
        diagnostics,
        checks: draft.checks,
        observations: draft.observations,
        observation_count,
        observation_cap_reached,
    };
    let path = report_path(log_dir, created_at, &report_id);
    crate::atomic::write_atomic_json(&path, &report)?;
    Ok(InstalledSelfCheckReportReceipt {
        report_path: path.to_string_lossy().into_owned(),
        report,
    })
}

pub(crate) fn intake_authority_checkpoint(
    intake: &crate::intake::IntakeRegistry,
    pty: &crate::pty::PtyRegistry,
    card_id: String,
    observed_pty_id: String,
) -> Result<IntakeAuthorityCheckpoint, String> {
    validate_opaque_id("card id", &card_id)?;
    validate_opaque_id("observed PTY id", &observed_pty_id)?;
    let authoritative_pty_id = intake.pty_id_for(&card_id);
    let pty_ids_match = authoritative_pty_id.as_deref() == Some(observed_pty_id.as_str());
    Ok(IntakeAuthorityCheckpoint {
        card_id,
        observed_pty_live: pty.contains(&observed_pty_id),
        observed_pty_id,
        intake_registered: authoritative_pty_id.is_some(),
        authoritative_pty_id,
        pty_ids_match,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intake::{IntakeRegistry, IntakeSession};
    use crate::pty::PtyRegistry;
    use std::fs;
    use std::sync::atomic::AtomicI64;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn checks(status: SelfCheckStatus) -> Vec<SelfCheckDraftCheck> {
        ALL_SELF_CHECK_IDS
            .iter()
            .copied()
            .map(|id| SelfCheckDraftCheck {
                id,
                status,
                reasons: if status == SelfCheckStatus::Failed {
                    vec![SelfCheckFailureReason::MissingHost]
                } else {
                    Vec::new()
                },
            })
            .collect()
    }

    fn draft(status: SelfCheckStatus) -> InstalledSelfCheckDraftV1 {
        InstalledSelfCheckDraftV1 {
            workspace_id: "workspace-1".into(),
            card_id: "card-1".into(),
            checks: checks(status),
            observations: Vec::new(),
        }
    }

    fn passing_draft() -> InstalledSelfCheckDraftV1 {
        let mut observations = Vec::new();
        observations.push(SelfCheckObservation::IntakeHost(IntakeHostFact {
            sequence: 0,
            checkpoint: IntakeCheckpoint::Initial,
            transition_id: None,
            pty_id: "pty-1".into(),
            mount_id: "mount-1".into(),
            viewport_row: 17,
            scrollback_rows: 23,
            scroll_observed: true,
            buffer_kind: Some(IntakeBufferKind::Normal),
            cols: 120,
            rows: 40,
            resize_epoch: Some(0),
            width: 800,
            height: 400,
            connected: true,
            display_none_ancestor: false,
            closed_details_ancestor: false,
        }));
        for (transition_index, checkpoint) in [
            IntakeCheckpoint::Step,
            IntakeCheckpoint::Mode,
            IntakeCheckpoint::Workspace,
            IntakeCheckpoint::CardCloseReopen,
            IntakeCheckpoint::Disclosure,
            IntakeCheckpoint::Disclosure,
        ]
        .into_iter()
        .enumerate()
        {
            for _ in 0..2 {
                observations.push(SelfCheckObservation::IntakeHost(IntakeHostFact {
                    sequence: observations.len() as u16,
                    checkpoint,
                    transition_id: Some(format!("transition-{transition_index}")),
                    pty_id: "pty-1".into(),
                    mount_id: "mount-1".into(),
                    viewport_row: 17,
                    scrollback_rows: 23,
                    scroll_observed: true,
                    buffer_kind: Some(IntakeBufferKind::Normal),
                    cols: 120,
                    rows: 40,
                    resize_epoch: Some(0),
                    width: 800,
                    height: 400,
                    connected: true,
                    display_none_ancestor: false,
                    closed_details_ancestor: false,
                }));
            }
        }
        for checkpoint in [IntakeCheckpoint::Initial, IntakeCheckpoint::Workspace] {
            observations.push(SelfCheckObservation::IntakeAuthority(IntakeAuthorityFact {
                sequence: observations.len() as u16,
                checkpoint,
                observed_pty_id: "pty-1".into(),
                authoritative_pty_id: Some("pty-1".into()),
                intake_registered: true,
                pty_ids_match: true,
                observed_pty_live: true,
            }));
        }
        for (index, state) in ALL_CARD_PRESENTATION_STATES.iter().copied().enumerate() {
            observations.push(SelfCheckObservation::CardState(CardStateFact {
                sequence: observations.len() as u16,
                card_id: format!("card-{index}"),
                evidence_origin: CardStateEvidenceOrigin::Seeded,
                store_state: Some(state),
                rendered_state: state,
                action_id: Some(format!("action-{index}")),
                tone: Some(PrimaryActionTone::Accent),
                action_enabled: true,
                primary_action_count: 1,
            }));
        }
        observations.push(SelfCheckObservation::UiCapability(UiCapabilityFact {
            sequence: observations.len() as u16,
            standalone_contenteditable: false,
        }));
        for focus_category in [
            FocusCategory::Input,
            FocusCategory::Textarea,
            FocusCategory::Contenteditable,
            FocusCategory::CodeMirror,
            FocusCategory::Xterm,
            FocusCategory::OutsideCard,
        ] {
            observations.push(SelfCheckObservation::ActionTrace(ActionTraceFact {
                sequence: observations.len() as u16,
                state: CardPresentationState::Draft,
                action_id: Some("draft-action".into()),
                source: ActionSource::Keyboard,
                focus_category,
                primary_action_invocations: 0,
                ship_invocations: 0,
            }));
        }
        observations.push(SelfCheckObservation::ActionTrace(ActionTraceFact {
            sequence: observations.len() as u16,
            state: CardPresentationState::Draft,
            action_id: Some("draft-action".into()),
            source: ActionSource::Keyboard,
            focus_category: FocusCategory::CardBackground,
            primary_action_invocations: 1,
            ship_invocations: 0,
        }));
        observations.push(SelfCheckObservation::ActionTrace(ActionTraceFact {
            sequence: observations.len() as u16,
            state: CardPresentationState::ReadyToShip,
            action_id: Some("ship".into()),
            source: ActionSource::Keyboard,
            focus_category: FocusCategory::CardBackground,
            primary_action_invocations: 0,
            ship_invocations: 0,
        }));
        InstalledSelfCheckDraftV1 {
            workspace_id: "workspace-1".into(),
            card_id: "card-1".into(),
            checks: checks(SelfCheckStatus::Passed),
            observations,
        }
    }

    fn fingerprint() -> Result<BundleFingerprint, String> {
        Ok(BundleFingerprint {
            digest: "a".repeat(64),
            manifest: Vec::new(),
        })
    }

    fn append_live_intake_authority(draft: &mut InstalledSelfCheckDraftV1) {
        for checkpoint in [IntakeCheckpoint::Initial, IntakeCheckpoint::Workspace] {
            draft
                .observations
                .push(SelfCheckObservation::IntakeAuthority(IntakeAuthorityFact {
                    sequence: draft.observations.len() as u16,
                    checkpoint,
                    observed_pty_id: "pty-1".into(),
                    authoritative_pty_id: Some("pty-1".into()),
                    intake_registered: true,
                    pty_ids_match: true,
                    observed_pty_live: true,
                }));
        }
    }

    #[test]
    fn exact_check_set_and_caps_are_enforced() {
        let mut missing = draft(SelfCheckStatus::NotObserved);
        missing.checks.pop();
        assert!(validate_draft(&missing).unwrap_err().contains("exactly 14"));

        let mut duplicate = draft(SelfCheckStatus::NotObserved);
        duplicate.checks[13].id = duplicate.checks[0].id;
        assert!(validate_draft(&duplicate)
            .unwrap_err()
            .contains("duplicate"));

        let mut too_many = draft(SelfCheckStatus::NotObserved);
        too_many.observations = (0..=MAX_OBSERVATIONS)
            .map(|sequence| {
                SelfCheckObservation::ActionTrace(ActionTraceFact {
                    sequence: sequence as u16,
                    state: CardPresentationState::Draft,
                    action_id: None,
                    source: ActionSource::Pointer,
                    focus_category: FocusCategory::CardBackground,
                    primary_action_invocations: 0,
                    ship_invocations: 0,
                })
            })
            .collect();
        assert!(validate_draft(&too_many)
            .unwrap_err()
            .contains("observation cap"));
    }

    #[test]
    fn overall_is_backend_recomputed_with_failure_before_incomplete() {
        assert_eq!(
            recompute_overall(&checks(SelfCheckStatus::Passed), true),
            SelfCheckOverall::Passed
        );
        assert_eq!(
            recompute_overall(&checks(SelfCheckStatus::Failed), true),
            SelfCheckOverall::Failed
        );
        let mut mixed = checks(SelfCheckStatus::Failed);
        mixed[0].status = SelfCheckStatus::NotObserved;
        mixed[0].reasons.clear();
        assert_eq!(recompute_overall(&mixed, true), SelfCheckOverall::Failed);
        assert_eq!(
            recompute_overall(&checks(SelfCheckStatus::Passed), false),
            SelfCheckOverall::ProvenanceError
        );
    }

    #[test]
    fn provenance_failure_is_sanitized_and_never_falls_back_to_version() {
        let dir = TempDir::new().unwrap();
        let receipt = write_report_where(
            dir.path(),
            Err("/private/secret/path was unreadable".into()),
            draft(SelfCheckStatus::NotObserved),
            1,
            "provenance".into(),
            true,
        )
        .unwrap();
        assert_eq!(receipt.report.overall, SelfCheckOverall::ProvenanceError);
        assert_eq!(receipt.report.bundle_fingerprint, None);
        let json = fs::read_to_string(receipt.report_path).unwrap();
        assert!(!json.contains("/private/secret"));
        assert!(json.contains("installed bundle provenance unavailable"));
    }

    /// Where there is no bundle to fingerprint (Windows), the report says so
    /// and is judged on its checks alone, never as a provenance error.
    #[test]
    fn provenance_not_applicable_is_noted_not_an_error() {
        let dir = TempDir::new().unwrap();
        let receipt = write_report_where(
            dir.path(),
            Err("installed bundle provenance is not applicable on Windows".into()),
            draft(SelfCheckStatus::NotObserved),
            1,
            "not-applicable".into(),
            false,
        )
        .unwrap();
        assert_eq!(receipt.report.overall, SelfCheckOverall::Incomplete);
        assert_eq!(receipt.report.bundle_fingerprint, None);
        assert_eq!(
            receipt.report.diagnostics[0],
            "installed bundle provenance not applicable on this platform"
        );
        assert!(!receipt
            .report
            .diagnostics
            .iter()
            .any(|d| d.contains("provenance unavailable")));
    }

    #[cfg(windows)]
    #[test]
    fn windows_has_no_bundle_provenance_to_check() {
        assert!(!crate::bundle_fingerprint::PROVENANCE_APPLIES);
        let err = crate::bundle_fingerprint::current_app_bundle().unwrap_err();
        assert!(err.contains("not applicable"), "{err}");
    }

    #[test]
    fn passed_claim_without_supporting_observations_is_rejected() {
        let dir = TempDir::new().unwrap();
        let error = write_report(
            dir.path(),
            fingerprint(),
            draft(SelfCheckStatus::Passed),
            1,
            "unsupported-green".into(),
        )
        .unwrap_err();
        assert!(error.contains("lacks supporting observations"), "{error}");
        assert!(!report_path(dir.path(), 1, "unsupported-green").exists());
    }

    #[test]
    fn action_pass_claims_require_every_matching_trace_to_be_safe() {
        let mut focus_regression = passing_draft();
        focus_regression
            .observations
            .push(SelfCheckObservation::ActionTrace(ActionTraceFact {
                sequence: focus_regression.observations.len() as u16,
                state: CardPresentationState::Draft,
                action_id: Some("draft-action".into()),
                source: ActionSource::Keyboard,
                focus_category: FocusCategory::Input,
                primary_action_invocations: 2,
                ship_invocations: 0,
            }));
        assert!(!passed_claim_supported(
            SelfCheckId::CmdEnterFocusGuards,
            &focus_regression
        ));

        let mut ship_regression = passing_draft();
        ship_regression
            .observations
            .push(SelfCheckObservation::ActionTrace(ActionTraceFact {
                sequence: ship_regression.observations.len() as u16,
                state: CardPresentationState::ReadyToShip,
                action_id: Some("ship".into()),
                source: ActionSource::Keyboard,
                focus_category: FocusCategory::CardBackground,
                primary_action_invocations: 2,
                ship_invocations: 2,
            }));
        assert!(!passed_claim_supported(
            SelfCheckId::CmdEnterNeverShips,
            &ship_regression
        ));
    }

    #[test]
    fn contenteditable_is_required_only_when_the_product_exposes_one() {
        let mut no_standalone = passing_draft();
        no_standalone.observations.retain(|observation| {
            !matches!(
                observation,
                SelfCheckObservation::ActionTrace(ActionTraceFact {
                    focus_category: FocusCategory::Contenteditable,
                    ..
                })
            )
        });
        for (sequence, observation) in no_standalone.observations.iter_mut().enumerate() {
            match observation {
                SelfCheckObservation::IntakeHost(fact) => fact.sequence = sequence as u16,
                SelfCheckObservation::IntakeAuthority(fact) => fact.sequence = sequence as u16,
                SelfCheckObservation::CardState(fact) => fact.sequence = sequence as u16,
                SelfCheckObservation::UiCapability(fact) => fact.sequence = sequence as u16,
                SelfCheckObservation::ActionTrace(fact) => fact.sequence = sequence as u16,
            }
        }
        assert!(passed_claim_supported(
            SelfCheckId::CmdEnterFocusGuards,
            &no_standalone
        ));

        let capability = no_standalone
            .observations
            .iter_mut()
            .find_map(|observation| match observation {
                SelfCheckObservation::UiCapability(fact) => Some(fact),
                _ => None,
            })
            .expect("capability fact");
        capability.standalone_contenteditable = true;
        assert!(!passed_claim_supported(
            SelfCheckId::CmdEnterFocusGuards,
            &no_standalone
        ));
    }

    #[test]
    fn duplicate_invocations_remain_reportable_instead_of_rejecting_the_draft() {
        let mut duplicate = draft(SelfCheckStatus::NotObserved);
        duplicate
            .observations
            .push(SelfCheckObservation::CardState(CardStateFact {
                sequence: 0,
                card_id: "card-1".into(),
                evidence_origin: CardStateEvidenceOrigin::Reached,
                store_state: Some(CardPresentationState::Draft),
                rendered_state: CardPresentationState::Draft,
                action_id: Some("draft-action".into()),
                tone: Some(PrimaryActionTone::Accent),
                action_enabled: true,
                primary_action_count: 7,
            }));
        duplicate
            .observations
            .push(SelfCheckObservation::ActionTrace(ActionTraceFact {
                sequence: 1,
                state: CardPresentationState::ReadyToShip,
                action_id: Some("ship".into()),
                source: ActionSource::Keyboard,
                focus_category: FocusCategory::CardBackground,
                primary_action_invocations: 23,
                ship_invocations: 11,
            }));
        validate_draft(&duplicate).expect("severe duplicate evidence must remain reportable");
    }

    #[test]
    fn scroll_continuity_compares_each_immediate_transition_pair() {
        let mut transition_draft = draft(SelfCheckStatus::NotObserved);
        for (transition_id, checkpoint, row) in [
            ("step-1", IntakeCheckpoint::Step, 17),
            ("mode-1", IntakeCheckpoint::Mode, 91),
        ] {
            for _ in 0..2 {
                transition_draft
                    .observations
                    .push(SelfCheckObservation::IntakeHost(IntakeHostFact {
                        sequence: transition_draft.observations.len() as u16,
                        checkpoint,
                        transition_id: Some(transition_id.into()),
                        pty_id: "pty-1".into(),
                        mount_id: "mount-1".into(),
                        viewport_row: row,
                        scrollback_rows: row + 6,
                        scroll_observed: true,
                        buffer_kind: Some(IntakeBufferKind::Normal),
                        cols: 120,
                        rows: 40,
                        resize_epoch: Some(0),
                        width: 800,
                        height: 400,
                        connected: true,
                        display_none_ancestor: false,
                        closed_details_ancestor: false,
                    }));
            }
        }
        append_live_intake_authority(&mut transition_draft);
        assert!(passed_claim_supported(
            SelfCheckId::IntakeScrollContinuity,
            &transition_draft
        ));
        assert!(passed_claim_supported(
            SelfCheckId::IntakeStepTransition,
            &transition_draft
        ));
        assert!(passed_claim_supported(
            SelfCheckId::IntakeModeTransition,
            &transition_draft
        ));

        for observation in &mut transition_draft.observations {
            let SelfCheckObservation::IntakeHost(fact) = observation else {
                continue;
            };
            fact.scroll_observed = false;
        }
        assert!(
            !passed_claim_supported(SelfCheckId::IntakeScrollContinuity, &transition_draft),
            "a row value without observed scroll authority cannot support a pass"
        );
        for observation in &mut transition_draft.observations {
            let SelfCheckObservation::IntakeHost(fact) = observation else {
                continue;
            };
            fact.scroll_observed = true;
        }

        let after = transition_draft
            .observations
            .iter_mut()
            .rev()
            .find_map(|observation| match observation {
                SelfCheckObservation::IntakeHost(fact) => Some(fact),
                _ => None,
            })
            .expect("last Intake host");
        after.viewport_row = 0;
        assert!(!passed_claim_supported(
            SelfCheckId::IntakeScrollContinuity,
            &transition_draft
        ));
        assert!(!passed_claim_supported(
            SelfCheckId::IntakeModeTransition,
            &transition_draft
        ));
    }

    #[test]
    fn alternate_scroll_contract_requires_grid_epoch_and_session_stability() {
        let mut alternate = passing_draft();
        for observation in &mut alternate.observations {
            let SelfCheckObservation::IntakeHost(fact) = observation else {
                continue;
            };
            fact.buffer_kind = Some(IntakeBufferKind::Alternate);
            fact.viewport_row = 0;
            fact.scrollback_rows = 0;
            fact.scroll_observed = false;
            fact.cols = 120;
            fact.rows = 40;
            fact.resize_epoch = Some(0);
        }
        assert!(passed_claim_supported(
            SelfCheckId::IntakeScrollContinuity,
            &alternate
        ));

        let mut changed_grid = alternate.clone();
        let changed = changed_grid
            .observations
            .iter_mut()
            .find_map(|observation| match observation {
                SelfCheckObservation::IntakeHost(fact) if fact.transition_id.is_some() => {
                    Some(fact)
                }
                _ => None,
            })
            .expect("paired alternate host");
        changed.cols = 119;
        assert!(!passed_claim_supported(
            SelfCheckId::IntakeScrollContinuity,
            &changed_grid
        ));

        let mut late_resize = alternate.clone();
        let last_host = late_resize
            .observations
            .iter_mut()
            .rev()
            .find_map(|observation| match observation {
                SelfCheckObservation::IntakeHost(fact) => Some(fact),
                _ => None,
            })
            .expect("last alternate host");
        last_host.resize_epoch = Some(2);
        assert!(!passed_claim_supported(
            SelfCheckId::IntakeScrollContinuity,
            &late_resize
        ));

        let mut missing_epoch = alternate;
        let first_host = missing_epoch
            .observations
            .iter_mut()
            .find_map(|observation| match observation {
                SelfCheckObservation::IntakeHost(fact) => Some(fact),
                _ => None,
            })
            .expect("first alternate host");
        first_host.resize_epoch = None;
        assert!(!passed_claim_supported(
            SelfCheckId::IntakeScrollContinuity,
            &missing_epoch
        ));
    }

    #[test]
    fn interleaved_transition_ids_pair_without_array_adjacency() {
        let mut transition_draft = draft(SelfCheckStatus::NotObserved);
        for (transition_id, checkpoint, row) in [
            ("mode-1", IntakeCheckpoint::Mode, 17),
            ("workspace-1", IntakeCheckpoint::Workspace, 91),
            ("mode-1", IntakeCheckpoint::Mode, 17),
            ("workspace-1", IntakeCheckpoint::Workspace, 91),
        ] {
            transition_draft
                .observations
                .push(SelfCheckObservation::IntakeHost(IntakeHostFact {
                    sequence: transition_draft.observations.len() as u16,
                    checkpoint,
                    transition_id: Some(transition_id.into()),
                    pty_id: "pty-1".into(),
                    mount_id: "mount-1".into(),
                    viewport_row: row,
                    scrollback_rows: row + 6,
                    scroll_observed: true,
                    buffer_kind: Some(IntakeBufferKind::Normal),
                    cols: 120,
                    rows: 40,
                    resize_epoch: Some(0),
                    width: 800,
                    height: 400,
                    connected: true,
                    display_none_ancestor: false,
                    closed_details_ancestor: false,
                }));
        }
        append_live_intake_authority(&mut transition_draft);
        assert!(passed_claim_supported(
            SelfCheckId::IntakeScrollContinuity,
            &transition_draft
        ));
        assert!(passed_claim_supported(
            SelfCheckId::IntakeModeTransition,
            &transition_draft
        ));
        assert!(passed_claim_supported(
            SelfCheckId::IntakeWorkspaceTransition,
            &transition_draft
        ));
    }

    #[test]
    fn missing_store_authority_cannot_support_a_dom_state_claim() {
        let mut missing_store = draft(SelfCheckStatus::NotObserved);
        missing_store
            .observations
            .push(SelfCheckObservation::CardState(CardStateFact {
                sequence: 0,
                card_id: "card-1".into(),
                evidence_origin: CardStateEvidenceOrigin::Reached,
                store_state: None,
                rendered_state: CardPresentationState::Draft,
                action_id: Some("draft-action".into()),
                tone: Some(PrimaryActionTone::Accent),
                action_enabled: true,
                primary_action_count: 1,
            }));
        assert!(!passed_claim_supported(
            SelfCheckId::DraftPrimaryAction,
            &missing_store
        ));
        assert!(!passed_claim_supported(
            SelfCheckId::OnePrimaryActionPerState,
            &missing_store
        ));

        let mut value = serde_json::to_value(&missing_store.observations[0]).unwrap();
        value["fact"]
            .as_object_mut()
            .expect("card-state fact")
            .remove("storeState");
        value["fact"]
            .as_object_mut()
            .expect("card-state fact")
            .remove("cardId");
        value["fact"]
            .as_object_mut()
            .expect("card-state fact")
            .remove("evidenceOrigin");
        let parsed: SelfCheckObservation = serde_json::from_value(value).unwrap();
        let SelfCheckObservation::CardState(parsed) = parsed else {
            unreachable!()
        };
        assert_eq!(parsed.store_state, None);
        assert_eq!(parsed.card_id, "");
        assert_eq!(parsed.evidence_origin, CardStateEvidenceOrigin::Reached);
    }

    #[test]
    fn reason_overflow_is_truncated_but_cap_evidence_is_retained() {
        let mut overflow = draft(SelfCheckStatus::Failed);
        overflow.checks[0].reasons = vec![
            SelfCheckFailureReason::MissingHost,
            SelfCheckFailureReason::PtyMismatch,
            SelfCheckFailureReason::MountChanged,
            SelfCheckFailureReason::ZeroGeometry,
            SelfCheckFailureReason::DisplayNoneAncestor,
            SelfCheckFailureReason::ClosedDetailsAncestor,
            SelfCheckFailureReason::ScrollReset,
            SelfCheckFailureReason::IntakeRegistryMissing,
            SelfCheckFailureReason::ObservationCapReached,
        ];
        let dir = TempDir::new().unwrap();
        let receipt =
            write_report(dir.path(), fingerprint(), overflow, 1, "reason-cap".into()).unwrap();
        assert_eq!(
            receipt.report.checks[0].reasons.len(),
            MAX_REASONS_PER_CHECK
        );
        assert_eq!(
            receipt.report.checks[0].reasons.last(),
            Some(&SelfCheckFailureReason::ObservationCapReached)
        );
        assert!(receipt.report.observation_cap_reached);
        assert_eq!(receipt.report.observation_count, 0);
    }

    #[test]
    fn complete_supported_contract_is_the_only_green_path() {
        let dir = TempDir::new().unwrap();
        let receipt = write_report(
            dir.path(),
            fingerprint(),
            passing_draft(),
            1,
            "supported-green".into(),
        )
        .unwrap();
        assert_eq!(receipt.report.overall, SelfCheckOverall::Passed);
        assert_eq!(
            receipt
                .report
                .observations
                .iter()
                .filter(|observation| matches!(observation, SelfCheckObservation::CardState(_)))
                .count(),
            16
        );
    }

    #[test]
    fn frontend_authority_fields_are_rejected_instead_of_accepted() {
        let mut value = serde_json::to_value(draft(SelfCheckStatus::NotObserved)).unwrap();
        value["appVersion"] = serde_json::json!("spoofed");
        value["bundleFingerprint"] = serde_json::json!("spoofed");
        value["overall"] = serde_json::json!("passed");
        let error = serde_json::from_value::<InstalledSelfCheckDraftV1>(value).unwrap_err();
        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn tier2_legacy_minimal_report_defaults_and_round_trips() {
        let legacy = serde_json::json!({
            "schemaVersion": 1,
            "reportId": "legacy",
            "reportKind": "p3_1_installed_walk",
            "createdAt": 1,
            "appVersion": "1.94.0",
            "overall": "incomplete",
            "workspaceId": "ws",
            "cardId": "card",
            "checks": []
        });
        let parsed: InstalledSelfCheckReportV1 = serde_json::from_value(legacy).unwrap();
        assert_eq!(parsed.bundle_fingerprint, None);
        assert!(parsed.bundle_fingerprint_algorithm.is_empty());
        assert!(parsed.observations.is_empty());
        assert_eq!(parsed.observation_count, 0);
        assert!(!parsed.observation_cap_reached);
        assert!(parsed.diagnostics.is_empty());
        let round_trip: InstalledSelfCheckReportV1 =
            serde_json::from_slice(&serde_json::to_vec(&parsed).unwrap()).unwrap();
        assert_eq!(round_trip, parsed);
    }

    #[test]
    fn tier2_legacy_intake_scroll_authority_defaults_and_round_trips() {
        let legacy = serde_json::json!({
            "schemaVersion": 1,
            "reportId": "legacy-scroll",
            "reportKind": "p3_1_installed_walk",
            "createdAt": 1,
            "appVersion": "1.95.0",
            "overall": "incomplete",
            "workspaceId": "ws",
            "cardId": "card",
            "checks": [],
            "observations": [{
                "kind": "intake_host",
                "fact": {
                    "sequence": 0,
                    "checkpoint": "mode",
                    "transitionId": "transition-1",
                    "ptyId": "pty-1",
                    "mountId": "mount-1",
                    "viewportRow": 17,
                    "width": 800,
                    "height": 400,
                    "connected": true,
                    "displayNoneAncestor": false,
                    "closedDetailsAncestor": false
                }
            }]
        });
        let parsed: InstalledSelfCheckReportV1 =
            serde_json::from_value(legacy).expect("legacy report");
        let SelfCheckObservation::IntakeHost(fact) = &parsed.observations[0] else {
            unreachable!()
        };
        assert_eq!(fact.scrollback_rows, 0);
        assert!(!fact.scroll_observed);
        assert_eq!(fact.buffer_kind, None);
        assert_eq!(fact.cols, 0);
        assert_eq!(fact.rows, 0);
        assert_eq!(fact.resize_epoch, None);

        let mut current = parsed;
        let SelfCheckObservation::IntakeHost(fact) = &mut current.observations[0] else {
            unreachable!()
        };
        fact.scrollback_rows = 23;
        fact.scroll_observed = true;
        fact.buffer_kind = Some(IntakeBufferKind::Alternate);
        fact.cols = 120;
        fact.rows = 40;
        fact.resize_epoch = Some(0);
        let round_trip: InstalledSelfCheckReportV1 =
            serde_json::from_slice(&serde_json::to_vec(&current).unwrap()).unwrap();
        assert_eq!(round_trip, current);

        let mut unknown = serde_json::to_value(&current).unwrap();
        unknown["observations"][0]["fact"]["bufferKind"] = serde_json::json!("provider_guessed");
        let error = serde_json::from_value::<InstalledSelfCheckReportV1>(unknown).unwrap_err();
        assert!(error.to_string().contains("unknown variant"));
    }

    #[test]
    fn injected_atomic_write_failure_leaves_no_partial_final_report() {
        let dir = TempDir::new().unwrap();
        let final_path = report_path(dir.path(), 7, "atomic");
        let tmp_path = dir.path().join("self-check-p3-1-7-atomic.json.atelier-tmp");
        fs::create_dir(&tmp_path).unwrap();
        let error = write_report(
            dir.path(),
            fingerprint(),
            draft(SelfCheckStatus::NotObserved),
            7,
            "atomic".into(),
        )
        .unwrap_err();
        assert!(error.contains("write tmp"), "{error}");
        assert!(!final_path.exists());
    }

    #[test]
    fn authority_checkpoint_requires_mapping_match_and_live_pty() {
        let intake = IntakeRegistry::default();
        let pty = PtyRegistry::default();
        let missing =
            intake_authority_checkpoint(&intake, &pty, "card".into(), "pty".into()).unwrap();
        assert!(!missing.intake_registered);
        assert!(!missing.pty_ids_match);
        assert!(!missing.observed_pty_live);

        intake.insert(IntakeSession {
            pty_id: "authoritative-pty".into(),
            workspace_id: "workspace".into(),
            card_id: "card".into(),
            draft_path: PathBuf::from("/not-read"),
            started_at: 0,
            last_activity_at: Arc::new(AtomicI64::new(0)),
            intake_id: "intake".into(),
            transcript_buf: Arc::new(parking_lot::Mutex::new(Vec::new())),
            rollout_path: Arc::new(parking_lot::Mutex::new(None)),
            exited: Default::default(),
            vendor: "claude".into(),
        });
        let dead_match =
            intake_authority_checkpoint(&intake, &pty, "card".into(), "authoritative-pty".into())
                .unwrap();
        assert!(dead_match.intake_registered);
        assert!(dead_match.pty_ids_match);
        assert!(!dead_match.observed_pty_live);
    }

    #[test]
    fn rust_and_typescript_share_check_ids_and_narrow_command_names() {
        let ipc = include_str!("../../src/ipc.ts");
        for id in ALL_SELF_CHECK_IDS {
            let encoded = serde_json::to_string(&id).unwrap();
            assert!(
                ipc.contains(encoded.trim_matches('"')),
                "TypeScript is missing {encoded}"
            );
        }
        for command in [
            "installed_self_check_intake_authority",
            "installed_self_check_write_report",
        ] {
            assert!(ipc.contains(command), "TypeScript is missing {command}");
        }
    }

    #[test]
    fn command_boundary_accepts_no_path_or_authoritative_report_field() {
        let commands = include_str!("commands.rs");
        let start = commands
            .find("pub fn installed_self_check_intake_authority")
            .expect("authority command");
        let end = commands[start..]
            .find("// v1.73.0")
            .map(|offset| start + offset)
            .expect("self-check command boundary");
        let self_check_commands = &commands[start..end];
        for forbidden in [
            "destination_path",
            "bundle_path",
            "report_path:",
            "app_version:",
            "overall:",
        ] {
            assert!(
                !self_check_commands.contains(forbidden),
                "self-check IPC accepts forbidden field {forbidden}"
            );
        }
    }

    #[test]
    fn sc2_observer_is_passive_hidden_and_mounted_outside_warmed_hosts() {
        let observer = include_str!("../../src/components/InstalledSelfCheckObserver.tsx");
        for forbidden in [
            ".click(",
            "dispatchEvent",
            "new KeyboardEvent",
            "webview.eval",
            "useKanban",
            "useIntake",
            "moveCard",
            "ptyWrite",
            "ptyResize",
            "startRun",
            "cardShip",
            "reviewStart",
            "discussionStart",
            "<Terminal",
        ] {
            assert!(
                !observer.contains(forbidden),
                "observation-only component contains forbidden action {forbidden}"
            );
        }
        for required in [
            "installedSelfCheckIntakeAuthority",
            "installedSelfCheckWriteReport",
            "useWorkspaces.subscribe",
            "useUi.subscribe",
            "MutationObserver",
            "requestAnimationFrame",
            "data-ply-installed-self-check",
        ] {
            assert!(
                observer.contains(required),
                "observer is missing passive mechanism {required}"
            );
        }

        let palette = include_str!("../../src/components/CommandPalette.tsx");
        assert!(palette.contains("hiddenSelfCheckCommandVisible(query)"));
        assert!(palette.contains("INSTALLED_SELF_CHECK_QUERY"));

        let app = include_str!("../../src/App.tsx");
        let shell_start = app.find("<NewWorkspaceShell").expect("workspace shell");
        let shell_end = app[shell_start..]
            .find("/>")
            .map(|offset| shell_start + offset + 2)
            .expect("self-closing warmed workspace shell");
        let observer_mount = app
            .find("<InstalledSelfCheckObserver")
            .expect("self-check observer mount");
        assert!(
            shell_end < observer_mount,
            "observer must be a sibling after the closed warmed workspace shell"
        );
    }

    #[test]
    fn sc2_dom_hooks_are_stable_non_content_identifiers() {
        let intake = include_str!("../../src/components/IntakeConversation.tsx");
        for required in [
            "data-ply-intake-host",
            "data-ply-card-id={cardId}",
            "data-ply-intake-pty-id={ptyId}",
            "data-ply-intake-mount-id={mountIdRef.current}",
            "data-ply-intake-viewport-row",
            "data-ply-intake-scrollback-rows",
            "data-ply-intake-scroll-observed",
            "data-ply-intake-buffer-kind",
            "data-ply-intake-cols",
            "data-ply-intake-rows",
            "data-ply-intake-resize-epoch",
            "term.buffer.active.type",
            "term.buffer.onBufferChange",
            "term.onScroll",
            "term.onRender",
            "nextIntakeResize",
            "negotiatedIntakeGrid",
        ] {
            assert!(intake.contains(required), "missing intake hook {required}");
        }
        let ordinary_terminal = include_str!("../../src/components/Terminal.tsx");
        assert!(
            // 2026-09-30: the same fit-then-resize, through the guard that
            // stops a closed tile's resize reaching its gone PTY (lib/ptyGone).
            ordinary_terminal.contains("pty?.resize(term.cols, term.rows)"),
            "v1.96.4 deliberately leaves ordinary tile resize behavior unchanged"
        );
        // …and the guard is wired to the real resize, so a no-op guard fails.
        assert!(
            ordinary_terminal.contains("guardPty(ptyId, { write: ptyWrite, resize: ptyResize })"),
            "the ordinary tile's guarded resize must still call ptyResize"
        );
        for forbidden in [
            "data-ply-intake-buffer-kind=",
            "data-ply-intake-cols=",
            "data-ply-intake-rows=",
            "data-ply-intake-resize-epoch=",
        ] {
            assert!(
                !intake.contains(forbidden),
                "React must not render fallback authority {forbidden}"
            );
        }
        assert!(
            intake.contains("useRef(crypto.randomUUID())"),
            "mount identity must be allocated once per mounted IntakeConversation"
        );

        let card = include_str!("../../src/components/CardDetailPanel.tsx");
        for required in [
            "data-ply-card-host",
            "data-ply-card-id={card.id}",
            "data-ply-card-state={presentationState}",
            "data-ply-card-store-state={storePresentationState ?? undefined}",
            "const freshCard =",
            "[contenteditable]:not([contenteditable=\"false\"])",
        ] {
            assert!(card.contains(required), "missing card hook {required}");
        }
        assert!(
            !card.contains("data-ply-card-store-state={presentationState}"),
            "rendered and store state must never share one expression"
        );

        let observer = include_str!("../../src/components/InstalledSelfCheckObserver.tsx");
        for required in [
            "selectedCardId[workspaceId]",
            "standaloneContenteditablePresent",
            "cardStateEvidenceOrigin(cardId, renderedState)",
        ] {
            assert!(
                observer.contains(required),
                "workspace-scoped observer is missing {required}"
            );
        }

        let reducer = include_str!("../../src/lib/installedSelfCheck.ts");
        for required in [
            "INSTALLED_SELF_CHECK_MAX_REASONS = 8",
            "transitionId",
            "guardedFailure",
            "backgroundFailure",
            "missingEvidence",
            "ready.every(",
            "recordInstalledSelfCheckCardState",
            "observation_cap_reached",
        ] {
            assert!(
                reducer.contains(required),
                "self-check reducer is missing fail-honest contract {required}"
            );
        }
        assert!(
            !intake.contains("data-ply-intake-viewport-row=\"0\""),
            "React must not overwrite xterm's imperative viewport observation"
        );
        assert_eq!(
            card.matches("data-ply-self-check-disclosure").count(),
            2,
            "both real Intake disclosures must be observable"
        );
        assert!(
            observer.contains("intakeSelectionEffect")
                && observer.contains("intakePhaseOpenRef.current = false"),
            "state enumeration must end rather than contaminate Intake continuity"
        );
        assert!(
            observer.contains("document.addEventListener(\"toggle\"")
                && observer.contains("finishTransition("),
            "a disclosure sample must be confirmed by the real native toggle"
        );
    }

    #[test]
    fn p3_1_state_fixture_is_external_bounded_and_atomically_published() {
        let fixture = include_str!("../../scripts/prepare-p3-1-state-fixture.sh");
        for required in [
            "Ply or Plyloft is running. Quit it with Cmd-Q",
            "refusing non-disposable workspace path",
            "autoResumeSuspended",
            "atomic_install \"$BOARD_TMP\" \"$BOARD_FILE\"",
            "atomic_install \"$REVIEWS_TMP\" \"$REVIEWS_FILE\"",
            "atomic_install \"$SUSPENDED_TMP\" \"$SUSPENDED_DIR/state.json\"",
            "p3-self-check-seeded-",
            "p3-self-check-suspended-",
            "Seeded:    14 presentation states",
            "Reached:   intake-live and shipping",
        ] {
            assert!(
                fixture.contains(required),
                "fixture preparation is missing boundary {required}"
            );
        }
        assert!(
            fixture.contains("mv -f \"$tmp\" \"$target\""),
            "persisted fixture files must publish through same-filesystem rename"
        );
        // GH #104: the fixture seeded three post-ship lesson proposals and their
        // evidence envelopes. The feature is retired (ADR 0005), so the fixture
        // writes none and the contract proves the directory stays absent.

        let contract = include_str!("../../scripts/test-prepare-p3-1-state-fixture.sh");
        assert!(
            contract.matches("run_fixture >/dev/null").count() >= 2,
            "fixture contract must prove idempotent repeated preparation"
        );
        assert!(
            contract.contains(r#"[[ ! -e "$CONFIG_ROOT/memory/proposals" ]]"#),
            "fixture contract must prove the retired proposals directory stays absent"
        );
    }

    #[test]
    fn p3_1_intake_host_stays_mounted_measurable_and_outside_disclosures() {
        let card = include_str!("../../src/components/CardDetailPanel.tsx");
        assert_eq!(
            card.matches("<IntakeConversation").count(),
            1,
            "the intake PTY must have exactly one React host"
        );
        assert!(
            card.contains("retainedCardIdRef"),
            "closing a card must retain its warmed editor"
        );
        let intake = card
            .find("<IntakeConversation")
            .expect("intake terminal host");
        // C6: the card page's disclosures (`<Details`) may sit above the
        // terminal, but every one is closed before it opens — the terminal
        // has no details ancestor.
        let before = &card[..intake];
        assert_eq!(
            before.matches("<Details").count(),
            before.matches("</Details>").count(),
            "the intake terminal must never have a details ancestor"
        );
        let intake_invocation_end = card[intake..]
            .find("/>")
            .map(|offset| intake + offset)
            .expect("closed IntakeConversation invocation");
        assert!(
            !card[intake..intake_invocation_end].contains("key="),
            "the intake terminal host must not be re-keyed"
        );

        // 1.174.0 (DR3): the Release flow no longer replaces the card's body
        // (the Release sheet opens over the page), so the body is never put
        // behind: it is one static element, no class toggled on it.
        assert!(
            card.contains("<div className=\"ux-card-stack\">\n        <div\n          className=\"ux-card-body\"\n")
                && !card.contains("ux-card-body--behind")
                && !card.contains("<ReleaseFlow"),
            "the card's body must stay one mounted element"
        );
        // 1.174.0 (C1): the folded brief hides with `hidden`; it holds only
        // the brief (`briefBlock`), never the intake terminal.
        let (_, fold) = card.split_once("hidden={!briefShown}>").expect("the brief's fold");
        let fold = fold.split_once("</div>").expect("its end").0;
        assert_eq!(fold.trim(), "{briefBlock}", "the folded brief holds only the brief");
        let (_, brief) = card.split_once("const briefBlock = (").expect("briefBlock");
        let brief = brief.split_once("\n  );\n").expect("its end").0;
        assert!(!brief.contains("<IntakeConversation"), "the intake terminal is never in the folded brief");

        // C6: a closed section of the card page (`CardSection`) hides its
        // body with visibility; the warmed card host too.
        let css = [
            include_str!("../../src/App.css"),
            include_str!("../../src/components/ux/ux.css"),
        ]
        .concat();
        for selector in [
            ".ux-card-slot--closed > .ux-card-slot-body {",
            ".center-card-host.hidden {",
        ] {
            let start = css.find(selector).expect("terminal-safe hidden selector");
            let end = css[start..]
                .find('}')
                .map(|offset| start + offset)
                .expect("closed hidden selector");
            let rule = &css[start..end];
            assert!(
                rule.contains("visibility: hidden"),
                "{selector} must hide with visibility"
            );
            assert!(
                !rule.contains("display: none"),
                "{selector} must remain measurable"
            );
        }
    }

    #[test]
    fn p3_1_card_scroller_reserves_width_and_background_focus_is_explicit() {
        // C6: the card page scrolls in its `Page`.
        let css = include_str!("../../src/components/ux/ux.css");
        let panel = css
            .split(".ux-card-page .ux-page {")
            .nth(1)
            .and_then(|rest| rest.split('}').next())
            .expect("card page scroller CSS rule");
        assert!(
            panel.contains("scrollbar-gutter: stable"),
            "disclosures must not resize the Intake PTY by adding a vertical scrollbar"
        );

        let header = include_str!("../../src/components/CardStateHeader.tsx");
        assert!(
            header.contains("data-ply-card-background-focus")
                && header.contains("event.currentTarget.focus({ preventScroll: true })"),
            "the eligible card-background Cmd-Enter path needs an explicit focus target"
        );
    }

    #[test]
    fn p3_1_has_one_primary_action_host_and_result_first_steps() {
        let card = include_str!("../../src/components/CardDetailPanel.tsx");
        let header = include_str!("../../src/components/CardStateHeader.tsx");
        let outcome = include_str!("../../src/components/OutcomeScreen.tsx");
        let ship = include_str!("../../src/components/CardShipStep.tsx");

        assert!(
            card.contains("<CardStateHeader"),
            "the card lifecycle must render the shared state/action host"
        );
        // 1.175.0 F8: an error that leads Now relabels the same control
        // (`{ ...primaryData, … "data-ply-primary-action-id": lead.id }`):
        // still one primary-action control.
        assert_eq!(
            header.matches("data-ply-primary-action-id").count()
                - header.matches("{ ...primaryData, title: lead.title && machineWords(lead.title), \"data-ply-primary-action-id\": lead.id").count(),
            1,
            "the shared host must expose exactly one primary-action control"
        );
        assert!(
            card.contains("statePresentation.actionId === \"ship\""),
            "Cmd-Enter must never dispatch the Ship action"
        );
        for required_trace_contract in [
            "reportInstalledSelfCheckActionTrace",
            "\"outside_card\"",
            "!cardModeActive",
            "primaryActionInvocations: 0",
            "primaryActionInvocations: 1",
            "shipInvocations:",
        ] {
            assert!(
                card.contains(required_trace_contract),
                "the real card action route is missing passive trace wiring: {required_trace_contract}"
            );
        }
        for retired_duplicate in ["Ship quick wins", "className=\"outcome-btn primary\""] {
            assert!(
                !outcome.contains(retired_duplicate),
                "Outcome still owns duplicate primary chrome: {retired_duplicate}"
            );
        }
        assert!(
            // GH #260: the disclosure is the page's `Details` primitive now.
            outcome.contains("<Details summary=\"Everything else\">"),
            "Outcome developer machinery must sit behind the frozen disclosure"
        );

        // GH #104: the Knowledge decision panel is retired (ADR 0005). The Ship
        // step still owns the landed result, and the Challenger's improvement
        // proposal is a line inside it that leads to the Library — not a second
        // panel under it, which is what this ordering used to hold.
        assert!(
            card.contains("<CardShipStep"),
            "Ship must still own the landed result"
        );
        assert!(
            !card.contains("<SuggestedMemoriesPanel"),
            "the retired Knowledge decision panel must be gone"
        );
        // C6 (UX-6.6/6.7): the project release is `Release…` in the card's ⋯ —
        // never the primary, never in the body. 1.174.0 (DR3): it opens the
        // one Release sheet (`openRelease`) instead of a flow over the card.
        assert!(
            card.contains("more(\"ship\", { label: \"Release…\", hint: RELEASE_ITEM_HINT, onSelect: openReleaseSheet })")
                && card.contains("openRelease({ workspaceId: card.workspaceId, areaId: cardAreaOf(card), cardIds: [card.id] })")
                && !card.contains("<ReleaseFlow")
                && !ship.contains("card-detail-btn primary"),
            "project release must remain an explicit secondary control"
        );
    }

    #[test]
    fn cmdq_cleanup_checker_is_bounded_visible_and_non_destructive() {
        let checker = include_str!("../../scripts/check-ply-cmdq-cleanup.sh");
        for required in [
            "TIMEOUT_SECS",
            "SECONDS + TIMEOUT_SECS",
            "capture_ply_tree",
            "tracked_csv",
            "if (tracked[pid]) print pid",
            "/Applications\\/(Ply|Plyloft)[.]app\\/Contents\\/MacOS\\/atelier",
            "Keep `[.]` in this source regex",
            "PASS: no process from the armed Plyloft process tree remains.",
            "FAIL: process(es) from the armed Plyloft process tree remained",
        ] {
            assert!(
                checker.contains(required),
                "Cmd-Q checker is missing {required}"
            );
        }
        for forbidden in ["kill ", "pkill", "killall", "rm -"] {
            assert!(
                !checker.contains(forbidden),
                "Cmd-Q checker must observe only; found {forbidden}"
            );
        }
    }
}
