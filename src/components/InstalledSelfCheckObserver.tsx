import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  installedSelfCheckIntakeAuthority,
  installedSelfCheckWriteReport,
  type CardPresentationState,
  type CardStateFact,
  type InstalledSelfCheckReportReceipt,
  type IntakeHostFact,
} from "../ipc";
import {
  appendInstalledSelfCheckObservation,
  cardStateEvidenceOrigin,
  createInstalledSelfCheckLedger,
  deriveInstalledSelfCheckChecks,
  installedSelfCheckPairFailureReasons,
  intakeSelectionEffect,
  markInstalledSelfCheckAuthorityFailure,
  markInstalledSelfCheckTransition,
  markInstalledSelfCheckTransitionFailure,
  recordInstalledSelfCheckCardState,
  subscribeInstalledSelfCheckActionTrace,
  type InstalledSelfCheckLedger,
  type IntakeCheckpoint,
} from "../lib/installedSelfCheck";
import { effectiveCenterMode, useUi } from "../store/uiStore";
import { lifecycleStepChanged } from "../lib/cardLifecycle";
import { useWorkspaces } from "../store/workspaceStore";
import { failure, type Failure } from "../lib/failure";
import { FailureText } from "./ux/FailureText";

type Props = {
  activeWorkspaceId: string | null;
  onClose: () => void;
};

const CARD_STATES = new Set<CardPresentationState>([
  "archived",
  "shipped",
  "shipping",
  "running",
  "paused",
  "queued",
  "challenger-reviewing",
  "changes-requested",
  "checking",
  "verify-failed",
  "failed",
  "review-stale",
  "no-changes",
  "ready-to-ship",
  "result-ready",
  "intake-live",
  "ready",
  "draft",
]);

function cardHost(cardId: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>("[data-ply-card-host]")].find(
      (element) => element.dataset.plyCardId === cardId,
    ) ?? null
  );
}

function intakeHost(cardId: string): HTMLElement | null {
  return (
    [
      ...document.querySelectorAll<HTMLElement>("[data-ply-intake-host]"),
    ].find((element) => element.dataset.plyCardId === cardId) ?? null
  );
}

function standaloneContenteditablePresent(): boolean {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[contenteditable]:not([contenteditable="false"])',
    ),
  ].some((element) => !element.closest(".cm-editor, .xterm"));
}

function hasDisplayNoneAncestor(element: HTMLElement): boolean {
  for (
    let current: HTMLElement | null = element;
    current;
    current = current.parentElement
  ) {
    if (getComputedStyle(current).display === "none") return true;
  }
  return false;
}

function hasClosedDetailsAncestor(element: HTMLElement): boolean {
  for (
    let current = element.parentElement;
    current;
    current = current.parentElement
  ) {
    if (current instanceof HTMLDetailsElement && !current.open) return true;
  }
  return false;
}

function sampleIntakeHost(
  cardId: string,
  checkpoint: IntakeCheckpoint,
  transitionId: string | null,
): Omit<IntakeHostFact, "sequence"> | null {
  const host = intakeHost(cardId);
  if (!host) return null;
  const ptyId = host.dataset.plyIntakePtyId;
  const mountId = host.dataset.plyIntakeMountId;
  if (!ptyId || !mountId) return null;
  const rect = host.getBoundingClientRect();
  const bufferKind =
    host.dataset.plyIntakeBufferKind === "normal" ||
    host.dataset.plyIntakeBufferKind === "alternate"
      ? host.dataset.plyIntakeBufferKind
      : null;
  const resizeEpochRaw = host.dataset.plyIntakeResizeEpoch;
  const resizeEpoch =
    resizeEpochRaw != null &&
    Number.isSafeInteger(Number(resizeEpochRaw)) &&
    Number(resizeEpochRaw) >= 0
      ? Number(resizeEpochRaw)
      : null;
  return {
    checkpoint,
    transitionId,
    ptyId,
    mountId,
    viewportRow: Number(host.dataset.plyIntakeViewportRow ?? "0"),
    scrollbackRows: Number(host.dataset.plyIntakeScrollbackRows ?? "0"),
    scrollObserved: host.dataset.plyIntakeScrollObserved === "true",
    bufferKind,
    cols: Number(host.dataset.plyIntakeCols ?? "0"),
    rows: Number(host.dataset.plyIntakeRows ?? "0"),
    resizeEpoch,
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
    connected: host.isConnected,
    displayNoneAncestor: hasDisplayNoneAncestor(host),
    closedDetailsAncestor: hasClosedDetailsAncestor(host),
  };
}

function sampleCardState(cardId: string): Omit<CardStateFact, "sequence"> | null {
  const host = cardHost(cardId);
  const encodedState = host?.dataset.plyCardState;
  if (
    !host ||
    !encodedState ||
    !CARD_STATES.has(encodedState as CardPresentationState)
  ) {
    return null;
  }
  const actions = [
    ...host.querySelectorAll<HTMLElement>("[data-ply-primary-action-id]"),
  ];
  const action = actions[0] ?? null;
  const renderedState = host.dataset.plyCardState as CardPresentationState;
  const storeState = host.dataset.plyCardStoreState as
    | CardPresentationState
    | undefined;
  const tone = action?.dataset.plyPrimaryActionTone;
  return {
    cardId,
    evidenceOrigin: cardStateEvidenceOrigin(cardId, renderedState),
    storeState:
      storeState && CARD_STATES.has(storeState) ? storeState : null,
    renderedState,
    actionId: action?.dataset.plyPrimaryActionId ?? null,
    tone: tone === "accent" || tone === "quiet" ? tone : null,
    actionEnabled:
      action != null &&
      !("disabled" in action && Boolean(action.disabled)) &&
      action.getAttribute("aria-disabled") !== "true",
    primaryActionCount: actions.length,
  };
}

export function InstalledSelfCheckObserver({
  activeWorkspaceId,
  onClose,
}: Props) {
  const [observing, setObserving] = useState(false);
  const [scope, setScope] = useState<{
    workspaceId: string;
    cardId: string;
  } | null>(null);
  const [ledger, setLedger] = useState<InstalledSelfCheckLedger>(
    createInstalledSelfCheckLedger,
  );
  const [receipt, setReceipt] =
    useState<InstalledSelfCheckReportReceipt | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const [writing, setWriting] = useState(false);
  const observingRef = useRef(observing);
  const scopeRef = useRef(scope);
  const pendingTransitionsRef = useRef(new Set<IntakeCheckpoint>());
  const intakePhaseOpenRef = useRef(false);
  const pendingDisclosureRef = useRef<{
    before: Omit<IntakeHostFact, "sequence"> | null;
    cardId: string;
    transitionId: string;
  } | null>(null);

  observingRef.current = observing;
  scopeRef.current = scope;

  const updateLedger = useCallback(
    (update: (current: InstalledSelfCheckLedger) => InstalledSelfCheckLedger) => {
      setLedger((current) => {
        const next = update(current);
        return next;
      });
    },
    [],
  );

  const appendHost = useCallback(
    (
      fact: Omit<IntakeHostFact, "sequence">,
      includeAuthority: boolean,
    ) => {
      updateLedger((current) =>
        appendInstalledSelfCheckObservation(current, {
          kind: "intake_host",
          fact,
        }),
      );
      if (!includeAuthority || !scopeRef.current) return;
      const { cardId } = scopeRef.current;
      void installedSelfCheckIntakeAuthority(cardId, fact.ptyId)
        .then((authority) => {
          if (!observingRef.current || scopeRef.current?.cardId !== cardId) {
            return;
          }
          updateLedger((current) =>
            appendInstalledSelfCheckObservation(current, {
              kind: "intake_authority",
              fact: {
                checkpoint: fact.checkpoint,
                observedPtyId: authority.observedPtyId,
                authoritativePtyId: authority.authoritativePtyId,
                intakeRegistered: authority.intakeRegistered,
                ptyIdsMatch: authority.ptyIdsMatch,
                observedPtyLive: authority.observedPtyLive,
              },
            }),
          );
        })
        .catch(() => {
          updateLedger((current) =>
            markInstalledSelfCheckAuthorityFailure(current),
          );
        });
    },
    [updateLedger],
  );

  const appendCardState = useCallback(() => {
    const workspaceId = scopeRef.current?.workspaceId;
    if (!workspaceId || useWorkspaces.getState().activeId !== workspaceId) {
      return;
    }
    const cardId = useUi.getState().selectedCardId[workspaceId] ?? null;
    if (!cardId) return;
    const fact = sampleCardState(cardId);
    if (!fact) return;
    updateLedger((current) =>
      recordInstalledSelfCheckCardState(current, fact),
    );
  }, [updateLedger]);

  const finishTransition = useCallback(
    (
      checkpoint: IntakeCheckpoint,
      cardId: string,
      transitionId: string,
      before: Omit<IntakeHostFact, "sequence"> | null,
    ) => {
      if (
        !observingRef.current ||
        !intakePhaseOpenRef.current ||
        pendingTransitionsRef.current.has(checkpoint)
      ) {
        return;
      }
      pendingTransitionsRef.current.add(checkpoint);
      if (before) appendHost(before, false);
      updateLedger((current) =>
        markInstalledSelfCheckTransition(current, checkpoint),
      );
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          pendingTransitionsRef.current.delete(checkpoint);
          if (!observingRef.current || scopeRef.current?.cardId !== cardId) {
            return;
          }
          const after = sampleIntakeHost(cardId, checkpoint, transitionId);
          if (after) appendHost(after, true);
          const failures =
            before && after
              ? installedSelfCheckPairFailureReasons(
                  before,
                  after,
                )
              : (["missing_host"] as const);
          if (failures.length > 0) {
            updateLedger((current) =>
              failures.reduce(
                (next, failure) =>
                  markInstalledSelfCheckTransitionFailure(
                    next,
                    checkpoint,
                    failure,
                  ),
                current,
              ),
            );
          }
          appendCardState();
        });
      });
    },
    [appendCardState, appendHost, updateLedger],
  );

  const observeTransition = useCallback(
    (checkpoint: IntakeCheckpoint) => {
      const cardId = scopeRef.current?.cardId;
      if (!cardId) return;
      const transitionId = crypto.randomUUID();
      finishTransition(
        checkpoint,
        cardId,
        transitionId,
        sampleIntakeHost(cardId, checkpoint, transitionId),
      );
    },
    [finishTransition],
  );

  useEffect(() => {
    if (!observing || !scope) return;
    const unsubscribeWorkspaces = useWorkspaces.subscribe((state, previous) => {
      if (
        state.activeId !== previous.activeId &&
        (state.activeId === scope.workspaceId ||
          previous.activeId === scope.workspaceId)
      ) {
        observeTransition("workspace");
      }
    });
    const unsubscribeUi = useUi.subscribe((state, previous) => {
      const workspaceId = scope.workspaceId;
      if (
        effectiveCenterMode(state.centerMode, workspaceId) !==
        effectiveCenterMode(previous.centerMode, workspaceId)
      ) {
        observeTransition("mode");
      }
      const selectionEffect = intakeSelectionEffect(
        scope.cardId,
        previous.selectedCardId[workspaceId] ?? null,
        state.selectedCardId[workspaceId] ?? null,
      );
      if (selectionEffect === "observe") {
        observeTransition("card_close_reopen");
      } else if (selectionEffect === "end_phase") {
        intakePhaseOpenRef.current = false;
        pendingDisclosureRef.current = null;
      }
      // The card's Chat is a section of the page, not a lifecycle step: its
      // opening and closing are no "step" transition.
      if (lifecycleStepChanged(previous.cardStep[scope.cardId], state.cardStep[scope.cardId])) {
        observeTransition("step");
      }
    });
    const unsubscribeTrace = subscribeInstalledSelfCheckActionTrace((fact) => {
      if (
        useWorkspaces.getState().activeId !== scope.workspaceId ||
        !useUi.getState().selectedCardId[scope.workspaceId]
      ) {
        return;
      }
      updateLedger((current) =>
        appendInstalledSelfCheckObservation(current, {
          kind: "action_trace",
          fact,
        }),
      );
    });
    const observer = new MutationObserver(() => {
      appendCardState();
      if (standaloneContenteditablePresent()) {
        updateLedger((current) => {
          if (
            current.observations.some(
              (observation) =>
                observation.kind === "ui_capability" &&
                observation.fact.standaloneContenteditable,
            )
          ) {
            return current;
          }
          return appendInstalledSelfCheckObservation(current, {
            kind: "ui_capability",
            fact: { standaloneContenteditable: true },
          });
        });
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "data-ply-card-state",
        "data-ply-card-store-state",
        "data-ply-primary-action-id",
        "data-ply-primary-action-tone",
        "disabled",
        "aria-disabled",
      ],
    });
    const onDisclosureInput = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest("[data-ply-self-check-disclosure]")) return;
      if (
        event instanceof KeyboardEvent &&
        event.key !== "Enter" &&
        event.key !== " "
      ) {
        return;
      }
      const cardId = scopeRef.current?.cardId;
      if (
        !cardId ||
        !intakePhaseOpenRef.current ||
        pendingDisclosureRef.current
      ) {
        return;
      }
      const transitionId = crypto.randomUUID();
      pendingDisclosureRef.current = {
        before: sampleIntakeHost(cardId, "disclosure", transitionId),
        cardId,
        transitionId,
      };
    };
    const onDisclosureToggle = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (!target?.matches("[data-ply-self-check-disclosure]")) return;
      const pending = pendingDisclosureRef.current;
      pendingDisclosureRef.current = null;
      if (!pending) return;
      finishTransition(
        "disclosure",
        pending.cardId,
        pending.transitionId,
        pending.before,
      );
    };
    document.addEventListener("pointerdown", onDisclosureInput, true);
    document.addEventListener("keydown", onDisclosureInput, true);
    document.addEventListener("toggle", onDisclosureToggle, true);
    return () => {
      unsubscribeWorkspaces();
      unsubscribeUi();
      unsubscribeTrace();
      observer.disconnect();
      document.removeEventListener("pointerdown", onDisclosureInput, true);
      document.removeEventListener("keydown", onDisclosureInput, true);
      document.removeEventListener("toggle", onDisclosureToggle, true);
    };
  }, [
    appendCardState,
    finishTransition,
    observeTransition,
    observing,
    scope,
    updateLedger,
  ]);

  const checks = useMemo(
    () => deriveInstalledSelfCheckChecks(ledger),
    [ledger],
  );
  const observedStateCount = useMemo(
    () =>
      new Set(
        ledger.observations.flatMap((observation) =>
          observation.kind === "card_state" && observation.fact.storeState
            ? [observation.fact.storeState]
            : [],
        ),
      ).size,
    [ledger.observations],
  );

  const begin = () => {
    const workspaceId = activeWorkspaceId;
    const cardId = workspaceId
      ? useUi.getState().selectedCardId[workspaceId] ?? null
      : null;
    if (!workspaceId || !cardId) {
      setError({ sentence: "Open a disposable card before beginning observation.", details: "" });
      return;
    }
    const next = appendInstalledSelfCheckObservation(
      createInstalledSelfCheckLedger(),
      {
        kind: "ui_capability",
        fact: {
          standaloneContenteditable: standaloneContenteditablePresent(),
        },
      },
    );
    setLedger(next);
    const nextScope = { workspaceId, cardId };
    scopeRef.current = nextScope;
    setScope(nextScope);
    setReceipt(null);
    setError(null);
    intakePhaseOpenRef.current = true;
    observingRef.current = true;
    setObserving(true);
    requestAnimationFrame(() => {
      const initial = sampleIntakeHost(cardId, "initial", null);
      if (initial) appendHost(initial, true);
      appendCardState();
    });
  };

  const discard = () => {
    const next = createInstalledSelfCheckLedger();
    scopeRef.current = null;
    intakePhaseOpenRef.current = false;
    pendingDisclosureRef.current = null;
    observingRef.current = false;
    setLedger(next);
    setScope(null);
    setObserving(false);
    setReceipt(null);
    setError(null);
  };

  const writeReport = async () => {
    if (!scope) {
      setError({ sentence: "Begin an observation before writing a report.", details: "" });
      return;
    }
    setWriting(true);
    setError(null);
    try {
      const result = await installedSelfCheckWriteReport({
        workspaceId: scope.workspaceId,
        cardId: scope.cardId,
        checks,
        observations: ledger.observations,
      });
      setReceipt(result);
    } catch (cause) {
      setError(failure("The self-check report wasn't written.", cause));
    } finally {
      setWriting(false);
    }
  };

  return (
    <aside
      className="installed-self-check"
      data-ply-installed-self-check=""
      aria-label="P3-1 installed self-check"
    >
      <header>
        <div>
          <strong>P3-1 installed self-check</strong>
          <span>
            {observing ? "Observing only" : scope ? "Paused" : "Not started"}
          </span>
        </div>
        <button type="button" onClick={onClose} aria-label="Close self-check">
          ×
        </button>
      </header>
      <p>
        This diagnostic observes cards in one disposable workspace. It never
        clicks, changes state, or starts work.
      </p>
      <div className="installed-self-check-actions">
        {!scope ? (
          <button type="button" onClick={begin}>
            Begin observation
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              observingRef.current = !observing;
              setObserving(!observing);
            }}
          >
            {observing ? "Pause observation" : "Resume observation"}
          </button>
        )}
        <button type="button" disabled={!scope || writing} onClick={writeReport}>
          {writing ? "Writing…" : "Write report"}
        </button>
        <button type="button" disabled={!scope} onClick={discard}>
          Discard
        </button>
      </div>
      <div className="installed-self-check-summary">
        <span>{ledger.observations.length}/256 observations</span>
        <span>
          {checks.filter((check) => check.status === "passed").length} passed
        </span>
        <span>
          {checks.filter((check) => check.status === "failed").length} failed
        </span>
        <span>
          {checks.filter((check) => check.status === "not_observed").length} not
          observed
        </span>
        <span>{observedStateCount}/16 states</span>
      </div>
      {scope && (
        <p className="muted">
          State scope is locked to this workspace. Intake continuity remains
          anchored to the card that was open when observation began. Keep each
          seeded card open until the state count advances.
        </p>
      )}
      {receipt && (
        <div className="installed-self-check-receipt">
          <strong>Report: {receipt.report.overall}</strong>
          <code>{receipt.reportPath}</code>
          <button type="button" onClick={() => void invoke("reveal_log_dir")}>
            Reveal logs
          </button>
        </div>
      )}
      {error && <div className="installed-self-check-error"><FailureText failure={error} /></div>}
    </aside>
  );
}
