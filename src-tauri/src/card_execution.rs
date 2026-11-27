//! Process-local card verification/work interlock.
//!
//! This is deliberately not a lease or persisted lock. One Tauri backend
//! owns the authoritative registries; the short gate closes only the
//! check-to-publication race and is released before any subprocess launch.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

use crate::agents::AgentRegistry;
use crate::kanban::{card_is_queue_eligible, KanbanCard, KanbanStore, VerifyStatus};
use crate::swarms::SwarmRegistry;
use crate::verify::{VerifyRegistry, VerifyRequest};
use crate::workspace::WorkspaceStore;

const VERIFY_INFLIGHT_COPY: &str =
    "Checks are running for this card. Finish them before starting more work.";
const WORK_INFLIGHT_COPY: &str =
    "Work is running or queued for this card. Stop or finish it before running checks.";
const ATTEMPT_PENDING_COPY: &str = "Work is already starting for this card.";
pub const CARD_WORK_FINISHED_EVENT: &str = "card-execution://work-finished";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardWorkFinished {
    pub workspace_id: String,
    pub card_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorizationKind {
    CardSwarm,
    CardAgent,
    WriterQueue,
    ReviewFollowup,
    QueuePump,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CardKey {
    workspace_id: String,
    card_id: String,
}

impl CardKey {
    fn new(workspace_id: &str, card_id: &str) -> Self {
        Self {
            workspace_id: workspace_id.to_string(),
            card_id: card_id.to_string(),
        }
    }
}

#[derive(Debug, Default)]
struct CardExecutionInner {
    attempt_pending: HashMap<CardKey, AuthorizationKind>,
}

#[derive(Clone, Debug, Default)]
pub struct CardExecutionGate {
    inner: Arc<Mutex<CardExecutionInner>>,
}

#[derive(Debug)]
#[must_use = "dropping the guard clears the attempt-pending marker"]
pub struct AttemptPendingGuard {
    inner: Arc<Mutex<CardExecutionInner>>,
    key: CardKey,
}

impl Drop for AttemptPendingGuard {
    fn drop(&mut self) {
        self.inner.lock().attempt_pending.remove(&self.key);
    }
}

impl CardExecutionGate {
    /// Atomically refuse active verification, clear only terminal current
    /// verification, and publish an RAII attempt marker. The returned guard
    /// must live until the caller has made its Agent/Swarm registry record
    /// authoritative.
    pub fn begin_attempt(
        &self,
        verify: &VerifyRegistry,
        kanban: &KanbanStore,
        workspace_id: &str,
        card_id: &str,
        kind: AuthorizationKind,
    ) -> Result<AttemptPendingGuard, String> {
        let key = CardKey::new(workspace_id, card_id);
        let mut inner = self.inner.lock();
        if verify.is_inflight(workspace_id, card_id) {
            return Err(VERIFY_INFLIGHT_COPY.to_string());
        }
        if inner.attempt_pending.contains_key(&key) {
            return Err(ATTEMPT_PENDING_COPY.to_string());
        }
        kanban.with_card(workspace_id, card_id, |card| {
            if matches!(
                card.verify_status,
                VerifyStatus::Passed | VerifyStatus::Failed | VerifyStatus::Skipped
            ) {
                card.verify_status = VerifyStatus::None;
            }
            Ok(())
        })?;
        inner.attempt_pending.insert(key.clone(), kind);
        Ok(AttemptPendingGuard {
            inner: self.inner.clone(),
            key,
        })
    }

    /// Canonical runner-backed authorization shape. The attempt marker stays
    /// live across the whole launch closure and the card-link publication
    /// closure, including the interval after a child exists but before its
    /// live registry counter is installed.
    pub fn run_attempt<T>(
        &self,
        verify: &VerifyRegistry,
        kanban: &KanbanStore,
        workspace_id: &str,
        card_id: &str,
        kind: AuthorizationKind,
        launch: impl FnOnce() -> Result<T, String>,
        publish: impl FnOnce(&T) -> Result<(), String>,
        rollback: impl FnOnce(&T),
    ) -> Result<T, String> {
        let _pending =
            self.begin_attempt(verify, kanban, workspace_id, card_id, kind)?;
        let launched = launch()?;
        if let Err(error) = publish(&launched) {
            rollback(&launched);
            return Err(error);
        }
        Ok(launched)
    }

    /// Queue admission treats only a live verification or another attempt
    /// already publishing the same card as retryable. Other failures (missing
    /// card, persistence error) must remain visible rather than spin forever.
    pub fn attempt_error_is_retryable(error: &str) -> bool {
        error == VERIFY_INFLIGHT_COPY || error == ATTEMPT_PENDING_COPY
    }

    /// Hold the short gate through the live-authority check and publication
    /// of a deferred VerifyRegistry record. The supplied closure must not
    /// launch a worker; `VerifyRegistry::start_deferred` runs after return.
    pub fn authorize_verify<T>(
        &self,
        kanban: &KanbanStore,
        agents: &AgentRegistry,
        swarms: &SwarmRegistry,
        workspace_id: &str,
        card_id: &str,
        publish: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let inner = self.inner.lock();
        let card = kanban.get_card(workspace_id, card_id)?;
        if card.workspace_id != workspace_id {
            return Err(format!(
                "Card workspace mismatch: expected {workspace_id}, found {}.",
                card.workspace_id
            ));
        }
        if card_work_in_flight(
            &card,
            workspace_id,
            inner
                .attempt_pending
                .contains_key(&CardKey::new(workspace_id, card_id)),
            agents,
            swarms,
        ) {
            return Err(WORK_INFLIGHT_COPY.to_string());
        }
        publish()
    }

    /// Canonical manual/automatic verify entrance. Publication happens under
    /// the short card gate; worker launch happens after `authorize_verify`
    /// returns and releases it.
    pub fn enqueue_verify(
        &self,
        app: tauri::AppHandle,
        verify: &VerifyRegistry,
        kanban: &KanbanStore,
        workspaces: &WorkspaceStore,
        agents: &AgentRegistry,
        swarms: &SwarmRegistry,
        request: VerifyRequest,
    ) -> Result<String, String> {
        let workspace_id = request.workspace_id.clone();
        let card_id = request.card_id.clone();
        // Challenger on a pull request: someone else's pull request is
        // reviewed, never verified or built here.
        if let Some(why) = kanban.get_card(&workspace_id, &card_id).ok().and_then(|c| crate::pr_review::work_refusal(&c)) {
            return Err(why);
        }
        let deferred =
            self.authorize_verify(kanban, agents, swarms, &workspace_id, &card_id, || {
                verify.enqueue_deferred(kanban, workspaces, request)
            })?;
        let verify_run_id = deferred.run_id().to_string();
        verify.start_deferred(app, kanban, deferred)?;
        Ok(verify_run_id)
    }

    #[cfg(test)]
    fn is_attempt_pending(&self, workspace_id: &str, card_id: &str) -> bool {
        self.inner
            .lock()
            .attempt_pending
            .contains_key(&CardKey::new(workspace_id, card_id))
    }
}

/// AgentRegistry is generic over Tauri runtimes for its PTY integration test,
/// so it emits a runtime-neutral completion event. The production Wry app
/// owns the retry that may start a real verification worker.
pub fn start_listener(app: tauri::AppHandle) {
    use tauri::Listener;
    let retry_app = app.clone();
    app.listen(CARD_WORK_FINISHED_EVENT, move |event| {
        let Ok(payload) = serde_json::from_str::<CardWorkFinished>(event.payload()) else {
            log::warn!("card work-finished event carried an invalid payload");
            return;
        };
        crate::swarms::retry_deferred_auto_verify(
            &retry_app,
            &payload.workspace_id,
            &payload.card_id,
        );
    });
}

fn card_work_in_flight(
    card: &KanbanCard,
    workspace_id: &str,
    attempt_pending: bool,
    agents: &AgentRegistry,
    swarms: &SwarmRegistry,
) -> bool {
    attempt_pending
        || card
            .linked_run_id
            .as_deref()
            .is_some_and(|run_id| agents.is_run_live(run_id))
        || card
            .linked_swarm_id
            .as_deref()
            .is_some_and(|swarm_id| swarms.is_card_swarm_live_or_resumable(workspace_id, swarm_id))
        || card_is_queue_eligible(card)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inbox::{derive_card_events, InboxEventKind, SeenStore};
    use crate::kanban::{KanbanColumnId, LastRunStatus, VerifyEntry, VerifyStepResult};
    use crate::swarms::{SwarmKind, SwarmStatus};
    use std::collections::HashMap;
    use std::sync::{mpsc, Arc, Barrier};

    struct Fixture {
        _dir: tempfile::TempDir,
        kanban: Arc<KanbanStore>,
        agents: Arc<AgentRegistry>,
        swarms: Arc<SwarmRegistry>,
        verify: Arc<VerifyRegistry>,
        gate: Arc<CardExecutionGate>,
    }

    impl Fixture {
        fn new(mut card: KanbanCard) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let kanban = Arc::new(KanbanStore::new(dir.path().to_path_buf()).unwrap());
            card.workspace_id = "ws".into();
            kanban.save("ws", vec![card]).unwrap();
            Self {
                agents: Arc::new(AgentRegistry::new(dir.path()).unwrap()),
                swarms: Arc::new(SwarmRegistry::new(dir.path().to_path_buf()).unwrap()),
                verify: Arc::new(VerifyRegistry::default()),
                gate: Arc::new(CardExecutionGate::default()),
                kanban,
                _dir: dir,
            }
        }
    }

    fn card() -> KanbanCard {
        KanbanCard::new(
            "card-1".into(),
            "ws".into(),
            "test".into(),
            None,
            KanbanColumnId::Todo,
        )
    }

    fn history_entry() -> VerifyEntry {
        VerifyEntry {
            verify_run_id: "verify-old".into(),
            tree_sha: None,
            status: VerifyStatus::Failed,
            ended_at: 10,
            summary: Some("old failure".into()),
            steps: vec![VerifyStepResult {
                kind: "script".into(),
                passed: false,
                elapsed_ms: 1,
                reason: Some("failed".into()),
            }],
        }
    }

    #[test]
    fn begin_attempt_resets_only_terminal_current_verification() {
        for status in [
            VerifyStatus::Passed,
            VerifyStatus::Failed,
            VerifyStatus::Skipped,
            VerifyStatus::Legacy,
            VerifyStatus::None,
            VerifyStatus::Queued,
            VerifyStatus::Running,
        ] {
            let mut input = card();
            input.verify_status = status;
            input.verify_history.push(history_entry());
            input.notes = Some("preserve me".into());
            let fixture = Fixture::new(input);
            let guard = fixture
                .gate
                .begin_attempt(
                    &fixture.verify,
                    &fixture.kanban,
                    "ws",
                    "card-1",
                    AuthorizationKind::CardAgent,
                )
                .unwrap();
            let saved = fixture.kanban.get_card("ws", "card-1").unwrap();
            let expected = if matches!(
                status,
                VerifyStatus::Passed | VerifyStatus::Failed | VerifyStatus::Skipped
            ) {
                VerifyStatus::None
            } else {
                status
            };
            assert_eq!(saved.verify_status, expected);
            assert_eq!(saved.verify_history.len(), 1);
            assert_eq!(saved.notes.as_deref(), Some("preserve me"));
            drop(guard);
        }
    }

    #[test]
    fn cleared_verification_survives_atomic_reload_with_history() {
        let mut input = card();
        input.verify_status = VerifyStatus::Failed;
        input.verify_history.push(history_entry());
        let fixture = Fixture::new(input);
        let guard = fixture
            .gate
            .begin_attempt(
                &fixture.verify,
                &fixture.kanban,
                "ws",
                "card-1",
                AuthorizationKind::CardSwarm,
            )
            .unwrap();
        drop(guard);
        let reloaded = KanbanStore::new(fixture._dir.path().to_path_buf()).unwrap();
        let saved = reloaded.get_card("ws", "card-1").unwrap();
        assert_eq!(saved.verify_status, VerifyStatus::None);
        assert_eq!(saved.verify_history.len(), 1);
        assert_eq!(saved.verify_history[0].verify_run_id, "verify-old");
    }

    #[test]
    fn failed_launch_direction_keeps_terminal_verification_cleared() {
        let mut input = card();
        input.verify_status = VerifyStatus::Passed;
        input.verify_history.push(history_entry());
        let fixture = Fixture::new(input);
        let launch_result: Result<(), &str> = {
            let guard = fixture
                .gate
                .begin_attempt(
                    &fixture.verify,
                    &fixture.kanban,
                    "ws",
                    "card-1",
                    AuthorizationKind::CardAgent,
                )
                .unwrap();
            let failed = Err("provider launch failed");
            drop(guard);
            failed
        };
        assert_eq!(launch_result, Err("provider launch failed"));
        let saved = fixture.kanban.get_card("ws", "card-1").unwrap();
        assert_eq!(saved.verify_status, VerifyStatus::None);
        assert_eq!(saved.verify_history.len(), 1);
        assert!(!fixture.gate.is_attempt_pending("ws", "card-1"));
    }

    #[test]
    fn run_attempt_refuses_verify_through_launch_and_link_publication() {
        let fixture = Fixture::new(card());
        let launched = fixture
            .gate
            .run_attempt(
                &fixture.verify,
                &fixture.kanban,
                "ws",
                "card-1",
                AuthorizationKind::CardAgent,
                || {
                    // Models the post-spawn/pre-counter interval in
                    // AgentRegistry::start_run: no live run is visible yet,
                    // so the attempt marker must remain the authority.
                    assert_eq!(
                        fixture
                            .gate
                            .authorize_verify(
                                &fixture.kanban,
                                &fixture.agents,
                                &fixture.swarms,
                                "ws",
                                "card-1",
                                || Ok(()),
                            )
                            .unwrap_err(),
                        WORK_INFLIGHT_COPY
                    );
                    Ok("run-1".to_string())
                },
                |run_id| {
                    assert!(fixture.gate.is_attempt_pending("ws", "card-1"));
                    fixture.kanban.set_run_state(
                        "ws",
                        "card-1",
                        crate::kanban::RunStatePatch {
                            linked_run_id: Some(Some(run_id.clone())),
                            linked_swarm_id: Some(None),
                            last_run_status: Some(Some(LastRunStatus::Running)),
                        },
                    )?;
                    Ok(())
                },
                |_| {},
            )
            .unwrap();
        assert_eq!(launched, "run-1");
        assert!(!fixture.gate.is_attempt_pending("ws", "card-1"));
    }

    #[test]
    fn publication_failure_rolls_back_before_attempt_marker_clears() {
        let fixture = Fixture::new(card());
        let rolled_back = std::cell::Cell::new(false);
        let error = fixture
            .gate
            .run_attempt(
                &fixture.verify,
                &fixture.kanban,
                "ws",
                "card-1",
                AuthorizationKind::CardAgent,
                || Ok("run-1"),
                |_| Err("card link write failed".to_string()),
                |_| {
                    assert!(fixture.gate.is_attempt_pending("ws", "card-1"));
                    rolled_back.set(true);
                },
            )
            .unwrap_err();
        assert_eq!(error, "card link write failed");
        assert!(rolled_back.get());
        assert!(!fixture.gate.is_attempt_pending("ws", "card-1"));
    }

    #[test]
    fn all_five_card_work_entrances_use_run_attempt_and_queue_lock_order() {
        fn body_between<'a>(
            source: &'a str,
            start: &str,
            end: &str,
        ) -> &'a str {
            let (_, tail) = source
                .split_once(start)
                .unwrap_or_else(|| panic!("missing source start: {start}"));
            let (body, _) = tail
                .split_once(end)
                .unwrap_or_else(|| panic!("missing source end: {end}"));
            body
        }

        let commands = include_str!("commands.rs");
        let immediate_agent = body_between(
            commands,
            "pub fn agent_run_request(",
            "pub fn agent_run_queue(",
        );
        assert!(immediate_agent.contains("card_execution.run_attempt("));
        assert!(immediate_agent.contains("AuthorizationKind::CardAgent"));
        assert!(immediate_agent.contains("registry.kill_run("));

        let explicit_writer_queue = body_between(
            commands,
            "pub fn agent_run_queue(",
            "pub fn agent_run_list(",
        );
        assert!(explicit_writer_queue.contains("card_execution.run_attempt("));
        assert!(explicit_writer_queue.contains("AuthorizationKind::WriterQueue"));

        let immediate_swarm =
            body_between(commands, "pub fn swarm_start(", "pub fn swarm_get(");
        assert!(immediate_swarm.contains("card_id is required for a card swarm"));
        assert!(immediate_swarm.contains("card_execution.run_attempt("));
        assert!(immediate_swarm.contains("AuthorizationKind::CardSwarm"));
        assert!(immediate_swarm.contains("abort_unlinked_start("));

        let followup = body_between(
            commands,
            "pub fn card_review_request_changes(",
            "pub fn card_outcome(",
        );
        assert!(followup.contains("card_execution.run_attempt("));
        assert!(followup.contains("AuthorizationKind::ReviewFollowup"));
        assert!(followup.contains("abort_unlinked_start("));

        let agents = include_str!("agents.rs");
        let writer_admission = body_between(
            agents,
            "pub fn enqueue_standalone_run(",
            "pub(crate) fn runtime_tick<",
        );
        assert!(writer_admission.contains("gate.run_attempt("));
        assert!(writer_admission.contains("AuthorizationKind::WriterQueue"));
        assert!(writer_admission.contains("registry.kill_run("));
        let writer_status_check = writer_admission
            .find("if run.status == AgentStatus::Error")
            .expect("failed card Agent launches must be rejected");
        let writer_publish = writer_admission
            .find("gate.run_attempt(")
            .expect("writer admission must enter the card gate");
        assert!(
            writer_status_check < writer_publish,
            "a failed Agent record must never be published as Running"
        );

        let kanban = include_str!("kanban.rs");
        let pump = body_between(
            kanban,
            "pub fn pump_card_queue(",
            "#[cfg(test)]\nmod tests",
        );
        let queue_lock = pump
            .find("QUEUE_PUMP_LOCK")
            .expect("queue pump must acquire its process lock");
        let card_gate = pump
            .find("card_execution.run_attempt(")
            .expect("queue pump must enter the card gate");
        assert!(queue_lock < card_gate);
        assert!(pump.contains("AuthorizationKind::QueuePump"));
        assert!(pump.contains("abort_unlinked_start("));
        let retryable = pump
            .split_once("attempt_error_is_retryable")
            .expect("queue retryable branch must remain discoverable")
            .1
            .split_once("Err(e) =>")
            .expect("queue retryable branch end must remain discoverable")
            .0;
        assert!(
            retryable.contains("continue;"),
            "per-card verification must not head-of-line block independent cards"
        );
        assert!(!retryable.contains("break;"));

        let kanban_store = include_str!("../../src/store/kanbanStore.ts");
        assert!(
            kanban_store.matches("cardExecutionRefusalMessage(e)").count() >= 2,
            "card Agent and Swarm refusals must stay retryable, not become Failed"
        );
        let card_error_contract =
            include_str!("../../src/lib/cardExecutionError.ts");
        assert!(
            card_error_contract.contains(VERIFY_INFLIGHT_COPY),
            "Rust and TypeScript verification-refusal copy must stay coupled"
        );
        assert!(
            card_error_contract.contains(ATTEMPT_PENDING_COPY),
            "Rust and TypeScript attempt-refusal copy must stay coupled"
        );

        let ipc = include_str!("../../src/ipc.ts");
        let swarm_ipc =
            body_between(ipc, "export function swarmStart(", "export function swarmGet(");
        assert!(swarm_ipc.contains("cardId: opts.cardId ?? null"));
        let agent_ipc = body_between(
            ipc,
            "export function agentRunRequest(",
            "export function agentRunQueue(",
        );
        assert!(agent_ipc.contains("cardId: opts.cardId ?? null"));
    }

    #[test]
    fn active_and_queued_verify_registry_jobs_refuse_work() {
        for queued in [false, true] {
            let fixture = Fixture::new(card());
            fixture.verify.set_inflight_for_test("ws", "card-1", queued);
            let error = fixture
                .gate
                .begin_attempt(
                    &fixture.verify,
                    &fixture.kanban,
                    "ws",
                    "card-1",
                    AuthorizationKind::CardAgent,
                )
                .unwrap_err();
            assert_eq!(error, VERIFY_INFLIGHT_COPY);
            assert!(!fixture.gate.is_attempt_pending("ws", "card-1"));
        }
    }

    #[test]
    fn stale_running_mirror_without_live_registry_record_allows_verify() {
        let mut input = card();
        input.last_run_status = Some(LastRunStatus::Running);
        input.linked_run_id = Some("dead-run".into());
        let fixture = Fixture::new(input);
        fixture
            .gate
            .authorize_verify(
                &fixture.kanban,
                &fixture.agents,
                &fixture.swarms,
                "ws",
                "card-1",
                || Ok(()),
            )
            .unwrap();
    }

    #[test]
    fn card_workspace_mismatch_refuses_before_live_authority_checks() {
        let fixture = Fixture::new(card());
        fixture
            .kanban
            .with_card("ws", "card-1", |card| {
                card.workspace_id = "stale-workspace".into();
                Ok(())
            })
            .unwrap();
        let error = fixture
            .gate
            .authorize_verify(
                &fixture.kanban,
                &fixture.agents,
                &fixture.swarms,
                "ws",
                "card-1",
                || Ok(()),
            )
            .unwrap_err();
        assert!(error.contains("Card workspace mismatch"));
    }

    #[test]
    fn live_agent_and_queue_eligible_card_refuse_verify() {
        let mut live = card();
        live.linked_run_id = Some("live-run".into());
        live.last_run_status = Some(LastRunStatus::Running);
        let fixture = Fixture::new(live);
        fixture.agents.set_run_live_for_test("live-run", true);
        let error = fixture
            .gate
            .authorize_verify(
                &fixture.kanban,
                &fixture.agents,
                &fixture.swarms,
                "ws",
                "card-1",
                || Ok(()),
            )
            .unwrap_err();
        assert_eq!(error, WORK_INFLIGHT_COPY);

        let mut queued = card();
        queued.column_id = KanbanColumnId::InProgress;
        queued.swarm_template_id = Some("feature".into());
        let fixture = Fixture::new(queued);
        let error = fixture
            .gate
            .authorize_verify(
                &fixture.kanban,
                &fixture.agents,
                &fixture.swarms,
                "ws",
                "card-1",
                || Ok(()),
            )
            .unwrap_err();
        assert_eq!(error, WORK_INFLIGHT_COPY);
    }

    #[test]
    fn suspended_linked_card_swarm_refuses_with_real_resume_stop_escape() {
        let dir = tempfile::tempdir().unwrap();
        let swarm = SwarmRegistry::new(dir.path().to_path_buf())
            .unwrap()
            .swarm_start(
                "ws",
                "feature",
                "goal",
                dir.path(),
                HashMap::new(),
                "builder",
                SwarmKind::Card,
            )
            .unwrap();
        let registry = Arc::new(SwarmRegistry::new(dir.path().to_path_buf()).unwrap());
        registry.suspend_for_orphan(&swarm.id).unwrap();
        let mut input = card();
        input.linked_swarm_id = Some(swarm.id.clone());
        input.last_run_status = Some(LastRunStatus::Running);
        let fixture_dir = tempfile::tempdir().unwrap();
        let kanban = KanbanStore::new(fixture_dir.path().to_path_buf()).unwrap();
        kanban.save("ws", vec![input]).unwrap();
        let agents = AgentRegistry::new(fixture_dir.path()).unwrap();
        let gate = CardExecutionGate::default();
        let error = gate
            .authorize_verify(&kanban, &agents, &registry, "ws", "card-1", || Ok(()))
            .unwrap_err();
        assert_eq!(error, WORK_INFLIGHT_COPY);
        let saved = registry.get(&swarm.id).unwrap();
        assert_eq!(saved.status, SwarmStatus::Suspended);
        assert!(saved.in_flight_role_at_suspend.is_some());
    }

    #[test]
    fn attempt_pending_guard_clears_on_drop_error_early_return_and_unwind() {
        fn early_return(fixture: &Fixture) -> Result<(), &'static str> {
            let _guard = fixture
                .gate
                .begin_attempt(
                    &fixture.verify,
                    &fixture.kanban,
                    "ws",
                    "card-1",
                    AuthorizationKind::CardAgent,
                )
                .unwrap();
            Err("stop")
        }

        let fixture = Fixture::new(card());
        {
            let _guard = fixture
                .gate
                .begin_attempt(
                    &fixture.verify,
                    &fixture.kanban,
                    "ws",
                    "card-1",
                    AuthorizationKind::CardAgent,
                )
                .unwrap();
            assert!(fixture.gate.is_attempt_pending("ws", "card-1"));
        }
        assert!(!fixture.gate.is_attempt_pending("ws", "card-1"));
        assert_eq!(early_return(&fixture), Err("stop"));
        assert!(!fixture.gate.is_attempt_pending("ws", "card-1"));
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = fixture
                .gate
                .begin_attempt(
                    &fixture.verify,
                    &fixture.kanban,
                    "ws",
                    "card-1",
                    AuthorizationKind::CardAgent,
                )
                .unwrap();
            panic!("exercise unwind cleanup");
        }));
        assert!(result.is_err());
        assert!(!fixture.gate.is_attempt_pending("ws", "card-1"));
    }

    #[test]
    fn simultaneous_verify_and_work_authorization_admits_exactly_one() {
        let fixture = Arc::new(Fixture::new(card()));
        let barrier = Arc::new(Barrier::new(3));
        let (result_tx, result_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();

        let work_fixture = fixture.clone();
        let work_barrier = barrier.clone();
        let work_tx = result_tx.clone();
        let work = std::thread::spawn(move || {
            work_barrier.wait();
            let guard = work_fixture.gate.begin_attempt(
                &work_fixture.verify,
                &work_fixture.kanban,
                "ws",
                "card-1",
                AuthorizationKind::CardAgent,
            );
            work_tx.send(("work", guard.is_ok())).unwrap();
            if let Ok(guard) = guard {
                release_rx.recv().unwrap();
                drop(guard);
            }
        });

        let verify_fixture = fixture.clone();
        let verify_barrier = barrier.clone();
        let verify_tx = result_tx;
        let verify = std::thread::spawn(move || {
            verify_barrier.wait();
            let result = verify_fixture.gate.authorize_verify(
                &verify_fixture.kanban,
                &verify_fixture.agents,
                &verify_fixture.swarms,
                "ws",
                "card-1",
                || {
                    verify_fixture
                        .verify
                        .set_inflight_for_test("ws", "card-1", false);
                    Ok(())
                },
            );
            verify_tx.send(("verify", result.is_ok())).unwrap();
        });

        barrier.wait();
        let results = [result_rx.recv().unwrap(), result_rx.recv().unwrap()];
        assert_eq!(results.iter().filter(|(_, admitted)| *admitted).count(), 1);
        let _ = release_tx.send(());
        work.join().unwrap();
        verify.join().unwrap();
    }

    #[test]
    fn clearing_failed_verify_removes_inbox_event_without_changing_seen_id() {
        let mut input = card();
        input.verify_status = VerifyStatus::Failed;
        input.verify_history.push(history_entry());
        let fixture = Fixture::new(input);
        let before = derive_card_events("Workspace", &fixture.kanban.load("ws").unwrap(), 0);
        let failed = before
            .iter()
            .find(|event| event.kind == InboxEventKind::VerifyFailed)
            .unwrap();
        let event_id = failed.id.clone();
        let seen = SeenStore::new(fixture._dir.path().to_path_buf()).unwrap();
        seen.mark_seen("local", std::slice::from_ref(&event_id), 100)
            .unwrap();

        let guard = fixture
            .gate
            .begin_attempt(
                &fixture.verify,
                &fixture.kanban,
                "ws",
                "card-1",
                AuthorizationKind::CardAgent,
            )
            .unwrap();
        drop(guard);
        let after = derive_card_events("Workspace", &fixture.kanban.load("ws").unwrap(), 0);
        assert!(!after
            .iter()
            .any(|event| event.kind == InboxEventKind::VerifyFailed));
        assert_eq!(seen.seen_map("local").get(&event_id), Some(&100));
    }

    #[test]
    fn manual_and_post_swarm_verify_share_the_card_gate_entrance() {
        let commands = include_str!("commands.rs");
        let (_, command_tail) = commands
            .split_once("pub fn verify_start(")
            .expect("verify_start must remain discoverable");
        let (command_body, _) = command_tail
            .split_once("pub fn verify_status(")
            .expect("verify_status delimiter must remain discoverable");
        assert!(command_body.contains("card_execution.enqueue_verify("));
        assert!(!command_body.contains("registry.enqueue("));

        let swarms = include_str!("swarms.rs");
        let (_, auto_tail) = swarms
            .split_once("fn maybe_autostart_verify(")
            .expect("maybe_autostart_verify must remain discoverable");
        let (auto_body, _) = auto_tail
            .split_once("fn on_swarm_run_done(")
            .expect("on_swarm_run_done delimiter must remain discoverable");
        assert!(auto_body.contains("card_execution.enqueue_verify("));
        assert!(!auto_body.contains("verify.enqueue("));
        assert!(auto_body.contains("verify.defer_auto_verify("));
        assert!(auto_body.contains("take_deferred_auto_verify("));

        let agents = include_str!("agents.rs");
        let (_, exit_tail) = agents
            .split_once("let exit_listener: EventId = app.listen(\"pty://exit\"")
            .expect("Agent exit listener must remain discoverable");
        let (exit_body, _) = exit_tail
            .split_once("*id_slot.lock() = Some((data_listener, exit_listener));")
            .expect("Agent exit listener end must remain discoverable");
        let clear_liveness = exit_body
            .find("run_liveness_for_exit.finish();")
            .expect("Agent live authority must clear");
        let wake_auto = exit_body
            .find("CARD_WORK_FINISHED_EVENT")
            .expect("standalone card Agent completion must wake deferred auto-verify");
        assert!(clear_liveness < wake_auto);
    }
}
