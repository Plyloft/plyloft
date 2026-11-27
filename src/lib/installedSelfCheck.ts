import type {
  ActionTraceFact,
  CardPresentationState,
  CardStateFact,
  InstalledSelfCheckDraftCheck,
  InstalledSelfCheckFailureReason,
  InstalledSelfCheckId,
  InstalledSelfCheckObservation,
  IntakeAuthorityFact,
  IntakeHostFact,
  UiCapabilityFact,
} from "../ipc.ts";
import { CARD_STATES } from "./cardLifecycle.ts";

// scripts/runtime-smoke.mjs types this exact string into the command
// palette and waits for a `.palette-item-label` that matches it verbatim
// (Tier 1.5's real palette path for the P3-1 self-check observer). Scripts
// stay put, so this query text keeps "Ply" too (Plyloft rename card).
export const INSTALLED_SELF_CHECK_QUERY = "Ply diagnostics: P3-1 self-check";
export const INSTALLED_SELF_CHECK_OBSERVATION_CAP = 256;
export const INSTALLED_SELF_CHECK_MAX_REASONS = 8;
const SEEDED_CARD_PREFIX = "p3-self-check-seeded-";

export type IntakeCheckpoint = IntakeHostFact["checkpoint"];
export type IntakeSelectionEffect = "observe" | "end_phase" | "ignore";

type ObservationInput =
  | { kind: "intake_host"; fact: Omit<IntakeHostFact, "sequence"> }
  | {
      kind: "intake_authority";
      fact: Omit<IntakeAuthorityFact, "sequence">;
    }
  | { kind: "card_state"; fact: Omit<CardStateFact, "sequence"> }
  | { kind: "ui_capability"; fact: Omit<UiCapabilityFact, "sequence"> }
  | { kind: "action_trace"; fact: Omit<ActionTraceFact, "sequence"> };

export interface InstalledSelfCheckLedger {
  observations: InstalledSelfCheckObservation[];
  capReached: boolean;
  transitionAttempts: Partial<Record<IntakeCheckpoint, number>>;
  transitionFailures: Partial<
    Record<IntakeCheckpoint, InstalledSelfCheckFailureReason[]>
  >;
  authorityFailures: number;
}

export const ALL_CARD_PRESENTATION_STATES = [...CARD_STATES];

const ALL_CHECK_IDS: InstalledSelfCheckId[] = [
  "draft_primary_action",
  "empty_intake_host_measurable",
  "intake_backend_pty_continuity",
  "intake_mount_continuity",
  "intake_scroll_continuity",
  "intake_step_transition",
  "intake_mode_transition",
  "intake_workspace_transition",
  "intake_card_close_reopen",
  "intake_disclosure_transitions",
  "all_card_states_observed",
  "one_primary_action_per_state",
  "cmd_enter_focus_guards",
  "cmd_enter_never_ships",
];

export function hiddenSelfCheckCommandVisible(query: string): boolean {
  return query === INSTALLED_SELF_CHECK_QUERY;
}

export function cardStateEvidenceOrigin(
  cardId: string,
  renderedState: CardPresentationState,
): CardStateFact["evidenceOrigin"] {
  const seededState = cardId.startsWith(SEEDED_CARD_PREFIX)
    ? cardId.slice(SEEDED_CARD_PREFIX.length)
    : null;
  return seededState === renderedState ? "seeded" : "reached";
}

/** The Intake continuity phase follows only the anchor card's real
 * close/reopen cycle. Selecting another card begins state enumeration and
 * deliberately ends that phase; otherwise seeded-card browsing would be
 * misreported as an Intake remount contract. */
export function intakeSelectionEffect(
  anchorCardId: string,
  previousCardId: string | null,
  nextCardId: string | null,
): IntakeSelectionEffect {
  if (
    (previousCardId === anchorCardId && nextCardId === null) ||
    (previousCardId === null && nextCardId === anchorCardId)
  ) {
    return "observe";
  }
  if (
    nextCardId != null &&
    nextCardId !== anchorCardId &&
    previousCardId !== nextCardId
  ) {
    return "end_phase";
  }
  return "ignore";
}

export function createInstalledSelfCheckLedger(): InstalledSelfCheckLedger {
  return {
    observations: [],
    capReached: false,
    transitionAttempts: {},
    transitionFailures: {},
    authorityFailures: 0,
  };
}

export function appendInstalledSelfCheckObservation(
  ledger: InstalledSelfCheckLedger,
  observation: ObservationInput,
): InstalledSelfCheckLedger {
  if (ledger.observations.length >= INSTALLED_SELF_CHECK_OBSERVATION_CAP) {
    return ledger.capReached ? ledger : { ...ledger, capReached: true };
  }
  const fact = { ...observation.fact, sequence: ledger.observations.length };
  return {
    ...ledger,
    observations: [
      ...ledger.observations,
      { kind: observation.kind, fact } as InstalledSelfCheckObservation,
    ],
  };
}

export function markInstalledSelfCheckTransition(
  ledger: InstalledSelfCheckLedger,
  checkpoint: IntakeCheckpoint,
  failure?: InstalledSelfCheckFailureReason,
): InstalledSelfCheckLedger {
  const transitionAttempts = {
    ...ledger.transitionAttempts,
    [checkpoint]: (ledger.transitionAttempts[checkpoint] ?? 0) + 1,
  };
  if (!failure) return { ...ledger, transitionAttempts };
  const prior = ledger.transitionFailures[checkpoint] ?? [];
  return {
    ...ledger,
    transitionAttempts,
    transitionFailures: {
      ...ledger.transitionFailures,
      [checkpoint]: prior.includes(failure)
        ? prior
        : [...prior, failure],
    },
  };
}

export function markInstalledSelfCheckTransitionFailure(
  ledger: InstalledSelfCheckLedger,
  checkpoint: IntakeCheckpoint,
  failure: InstalledSelfCheckFailureReason,
): InstalledSelfCheckLedger {
  const prior = ledger.transitionFailures[checkpoint] ?? [];
  if (prior.includes(failure)) return ledger;
  return {
    ...ledger,
    transitionFailures: {
      ...ledger.transitionFailures,
      [checkpoint]: [...prior, failure],
    },
  };
}

export function markInstalledSelfCheckAuthorityFailure(
  ledger: InstalledSelfCheckLedger,
): InstalledSelfCheckLedger {
  return {
    ...ledger,
    authorityFailures: ledger.authorityFailures + 1,
  };
}

function cardStateFactIsSafe(fact: Omit<CardStateFact, "sequence">): boolean {
  return (
    fact.storeState != null &&
    fact.storeState === fact.renderedState &&
    fact.actionId != null &&
    fact.primaryActionCount === 1
  );
}

export function recordInstalledSelfCheckCardState(
  ledger: InstalledSelfCheckLedger,
  fact: Omit<CardStateFact, "sequence">,
): InstalledSelfCheckLedger {
  const existingIndex = ledger.observations.findIndex(
    (observation) =>
      observation.kind === "card_state" &&
      (observation.fact.storeState ?? observation.fact.renderedState) ===
        (fact.storeState ?? fact.renderedState),
  );
  if (existingIndex < 0) {
    return appendInstalledSelfCheckObservation(ledger, {
      kind: "card_state",
      fact,
    });
  }
  const existing = ledger.observations[existingIndex];
  if (
    existing.kind !== "card_state" ||
    !cardStateFactIsSafe(existing.fact) ||
    cardStateFactIsSafe(fact)
  ) {
    return ledger;
  }
  const observations = [...ledger.observations];
  observations[existingIndex] = {
    kind: "card_state",
    fact: { ...fact, sequence: existing.fact.sequence },
  };
  return { ...ledger, observations };
}

function passed(
  id: InstalledSelfCheckId,
): InstalledSelfCheckDraftCheck {
  return { id, status: "passed", reasons: [] };
}

function failed(
  id: InstalledSelfCheckId,
  ...reasons: InstalledSelfCheckFailureReason[]
): InstalledSelfCheckDraftCheck {
  const boundedReasons = [
    ...new Set<InstalledSelfCheckFailureReason>(
      reasons.length > 0 ? reasons : ["missing_host"],
    ),
  ].slice(0, INSTALLED_SELF_CHECK_MAX_REASONS);
  return {
    id,
    status: "failed",
    reasons: boundedReasons,
  };
}

function notObserved(
  id: InstalledSelfCheckId,
): InstalledSelfCheckDraftCheck {
  return { id, status: "not_observed", reasons: [] };
}

function hostFacts(ledger: InstalledSelfCheckLedger): IntakeHostFact[] {
  return ledger.observations.flatMap((observation) =>
    observation.kind === "intake_host" ? [observation.fact] : [],
  );
}

function authorityFacts(
  ledger: InstalledSelfCheckLedger,
): IntakeAuthorityFact[] {
  return ledger.observations.flatMap((observation) =>
    observation.kind === "intake_authority" ? [observation.fact] : [],
  );
}

function cardStateFacts(ledger: InstalledSelfCheckLedger): CardStateFact[] {
  return ledger.observations.flatMap((observation) =>
    observation.kind === "card_state" ? [observation.fact] : [],
  );
}

function actionTraceFacts(ledger: InstalledSelfCheckLedger): ActionTraceFact[] {
  return ledger.observations.flatMap((observation) =>
    observation.kind === "action_trace" ? [observation.fact] : [],
  );
}

function uiCapabilityFacts(
  ledger: InstalledSelfCheckLedger,
): UiCapabilityFact[] {
  return ledger.observations.flatMap((observation) =>
    observation.kind === "ui_capability" ? [observation.fact] : [],
  );
}

function hostMeasurable(fact: IntakeHostFact): boolean {
  return (
    fact.connected &&
    fact.width > 0 &&
    fact.height > 0 &&
    !fact.displayNoneAncestor &&
    !fact.closedDetailsAncestor
  );
}

function completeIntakeAuthorityFailureReasons(
  hosts: IntakeHostFact[],
): InstalledSelfCheckFailureReason[] {
  const reasons: InstalledSelfCheckFailureReason[] = [];
  if (hosts.some((fact) => fact.bufferKind == null)) {
    reasons.push("buffer_kind_missing");
  }
  if (hosts.some((fact) => fact.cols <= 0 || fact.rows <= 0)) {
    reasons.push("grid_missing");
  }
  if (hosts.some((fact) => fact.resizeEpoch == null)) {
    reasons.push("resize_epoch_missing");
  }
  return reasons;
}

function mountContinuityFailureReasons(
  hosts: IntakeHostFact[],
): InstalledSelfCheckFailureReason[] {
  if (hosts.length === 0) return [];
  const first = hosts[0];
  return hosts.flatMap((fact) => {
    const reasons: InstalledSelfCheckFailureReason[] = [];
    if (!fact.connected) reasons.push("missing_host");
    if (fact.ptyId !== first.ptyId) reasons.push("pty_mismatch");
    if (fact.mountId !== first.mountId) reasons.push("mount_changed");
    if (fact.width === 0 || fact.height === 0) {
      reasons.push("zero_geometry");
    }
    if (fact.displayNoneAncestor) reasons.push("display_none_ancestor");
    if (fact.closedDetailsAncestor) reasons.push("closed_details_ancestor");
    return reasons;
  });
}

function transitionPairs(
  hosts: IntakeHostFact[],
  checkpoint?: IntakeCheckpoint,
): Array<[IntakeHostFact, IntakeHostFact]> {
  const grouped = new Map<string, IntakeHostFact[]>();
  for (const host of hosts) {
    if (!host.transitionId || (checkpoint && host.checkpoint !== checkpoint)) {
      continue;
    }
    const group = grouped.get(host.transitionId) ?? [];
    group.push(host);
    grouped.set(host.transitionId, group);
  }
  const pairs: Array<[IntakeHostFact, IntakeHostFact]> = [];
  for (const group of grouped.values()) {
    if (group.length === 2) pairs.push([group[0], group[1]]);
  }
  return pairs;
}

export function installedSelfCheckPairFailureReasons(
  before: Omit<IntakeHostFact, "sequence">,
  after: Omit<IntakeHostFact, "sequence">,
): InstalledSelfCheckFailureReason[] {
  const reasons: InstalledSelfCheckFailureReason[] = [];
  if (!before.connected || !after.connected) reasons.push("missing_host");
  if (before.ptyId !== after.ptyId) reasons.push("pty_mismatch");
  if (before.mountId !== after.mountId) reasons.push("mount_changed");
  if (before.viewportRow !== after.viewportRow) reasons.push("scroll_reset");
  if (
    before.width === 0 ||
    before.height === 0 ||
    after.width === 0 ||
    after.height === 0
  ) {
    reasons.push("zero_geometry");
  }
  if (before.displayNoneAncestor || after.displayNoneAncestor) {
    reasons.push("display_none_ancestor");
  }
  if (before.closedDetailsAncestor || after.closedDetailsAncestor) {
    reasons.push("closed_details_ancestor");
  }
  return reasons;
}

function transitionCheck(
  id: InstalledSelfCheckId,
  checkpoint: IntakeCheckpoint,
  ledger: InstalledSelfCheckLedger,
  hosts: IntakeHostFact[],
  minimum: number,
): InstalledSelfCheckDraftCheck {
  const attempts = ledger.transitionAttempts[checkpoint] ?? 0;
  if (attempts === 0) return notObserved(id);
  const failures = ledger.transitionFailures[checkpoint] ?? [];
  if (failures.length > 0) return failed(id, ...failures);
  const pairs = transitionPairs(hosts, checkpoint);
  if (pairs.length < minimum) return failed(id, "missing_host");
  const pairFailures = pairs.flatMap(([before, after]) =>
    installedSelfCheckPairFailureReasons(before, after),
  );
  return pairFailures.length === 0 ? passed(id) : failed(id, ...pairFailures);
}

function scrollContinuityCheck(
  ledger: InstalledSelfCheckLedger,
  hosts: IntakeHostFact[],
  authorities: IntakeAuthorityFact[],
): InstalledSelfCheckDraftCheck {
  const id: InstalledSelfCheckId = "intake_scroll_continuity";
  if (hosts.length === 0) return notObserved(id);

  const missingAuthority = completeIntakeAuthorityFailureReasons(hosts);
  if (missingAuthority.length > 0) return failed(id, ...missingAuthority);
  if (ledger.authorityFailures > 0) {
    return failed(id, "intake_registry_missing");
  }
  if (authorities.length < 2) return notObserved(id);
  if (
    !authorities.every(
      (fact) =>
        fact.intakeRegistered &&
        fact.ptyIdsMatch &&
        fact.observedPtyLive &&
        fact.authoritativePtyId === fact.observedPtyId,
    )
  ) {
    return failed(id, "intake_registry_missing", "pty_mismatch", "pty_not_live");
  }

  const alternateEpochs = new Set(
    hosts
      .filter((fact) => fact.bufferKind === "alternate")
      .map((fact) => fact.resizeEpoch),
  );
  if (alternateEpochs.size > 1) {
    return failed(id, "resize_epoch_changed");
  }

  const pairs = transitionPairs(hosts);
  if (pairs.length === 0) return notObserved(id);
  const failures: InstalledSelfCheckFailureReason[] = [];
  let supportedPairCount = 0;
  let normalPairLackedScrollAuthority = false;

  for (const [before, after] of pairs) {
    const commonFailures = installedSelfCheckPairFailureReasons(
      before,
      after,
    ).filter((reason) => reason !== "scroll_reset");
    failures.push(...commonFailures);

    if (before.bufferKind !== after.bufferKind) {
      failures.push("buffer_kind_changed");
      continue;
    }
    if (before.bufferKind === "alternate") {
      supportedPairCount += 1;
      if (before.cols !== after.cols || before.rows !== after.rows) {
        failures.push("grid_changed");
      }
      if (before.resizeEpoch !== after.resizeEpoch) {
        failures.push("resize_epoch_changed");
      }
      continue;
    }
    if (before.bufferKind === "normal") {
      const beforeHasScrollAuthority =
        before.scrollObserved &&
        before.viewportRow > 0 &&
        before.scrollbackRows > before.viewportRow;
      if (!beforeHasScrollAuthority) {
        normalPairLackedScrollAuthority = true;
        continue;
      }
      supportedPairCount += 1;
      if (
        !after.scrollObserved ||
        before.viewportRow !== after.viewportRow ||
        after.scrollbackRows <= after.viewportRow
      ) {
        failures.push("scroll_reset");
      }
    }
  }

  if (failures.length > 0) return failed(id, ...failures);
  if (supportedPairCount === 0 || normalPairLackedScrollAuthority) {
    return notObserved(id);
  }
  return passed(id);
}

function guardedTraceCheck(
  traces: ActionTraceFact[],
  capabilities: UiCapabilityFact[],
): InstalledSelfCheckDraftCheck {
  const id: InstalledSelfCheckId = "cmd_enter_focus_guards";
  const guarded: ActionTraceFact["focusCategory"][] = [
    "input",
    "textarea",
    "code_mirror",
    "xterm",
    "outside_card",
  ];
  if (capabilities.some((fact) => fact.standaloneContenteditable)) {
    guarded.push("contenteditable");
  }
  if (capabilities.length === 0) return notObserved(id);
  let missingEvidence = false;
  const guardedFailure = guarded.some((focusCategory) => {
    const matching = traces.filter(
      (trace) =>
        trace.source === "keyboard" &&
        trace.focusCategory === focusCategory,
    );
    if (matching.length === 0) {
      missingEvidence = true;
      return false;
    }
    return matching.some(
      (trace) =>
        trace.primaryActionInvocations !== 0 ||
        trace.shipInvocations !== 0,
    );
  });
  const background = traces.filter(
    (trace) =>
      trace.source === "keyboard" &&
      trace.focusCategory === "card_background" &&
      trace.state !== "ready-to-ship",
  );
  if (background.length === 0) missingEvidence = true;
  const backgroundFailure = background.some(
    (trace) =>
      trace.primaryActionInvocations !== 1 ||
      trace.shipInvocations !== 0,
  );
  if (guardedFailure || backgroundFailure) {
    return failed(id, "guarded_action_invoked");
  }
  return missingEvidence ? notObserved(id) : passed(id);
}

function keyboardShipCheck(
  traces: ActionTraceFact[],
): InstalledSelfCheckDraftCheck {
  const id: InstalledSelfCheckId = "cmd_enter_never_ships";
  const ready = traces.filter(
    (trace) =>
      trace.source === "keyboard" &&
      trace.focusCategory === "card_background" &&
      trace.state === "ready-to-ship",
  );
  if (ready.length === 0) return notObserved(id);
  return ready.every(
    (trace) =>
      trace.primaryActionInvocations === 0 && trace.shipInvocations === 0,
  )
    ? passed(id)
    : failed(id, "keyboard_ship_invoked");
}

export function deriveInstalledSelfCheckChecks(
  ledger: InstalledSelfCheckLedger,
): InstalledSelfCheckDraftCheck[] {
  const hosts = hostFacts(ledger);
  const authorities = authorityFacts(ledger);
  const states = cardStateFacts(ledger);
  const traces = actionTraceFacts(ledger);
  const capabilities = uiCapabilityFacts(ledger);
  const byId = new Map<
    InstalledSelfCheckId,
    InstalledSelfCheckDraftCheck
  >();

  const draftFacts = states.filter((fact) => fact.renderedState === "draft");
  byId.set(
    "draft_primary_action",
    draftFacts.length === 0
      ? notObserved("draft_primary_action")
      : draftFacts.every(
          (fact) =>
            fact.storeState === "draft" &&
            fact.renderedState === "draft" &&
            fact.actionId != null &&
            fact.tone === "accent" &&
            fact.actionEnabled &&
            fact.primaryActionCount === 1,
        )
      ? passed("draft_primary_action")
      : failed(
          "draft_primary_action",
          ...draftFacts.flatMap((fact) => {
            const reasons: InstalledSelfCheckFailureReason[] = [];
            if (fact.storeState !== fact.renderedState) {
              reasons.push("store_dom_mismatch");
            }
            if (fact.actionId == null) reasons.push("missing_primary_action");
            if (fact.primaryActionCount !== 1) {
              reasons.push("multiple_primary_actions");
            }
            return reasons;
          }),
        ),
  );

  byId.set(
    "empty_intake_host_measurable",
    hosts.length === 0
      ? notObserved("empty_intake_host_measurable")
      : hosts.some(hostMeasurable)
      ? passed("empty_intake_host_measurable")
      : failed(
          "empty_intake_host_measurable",
          "zero_geometry",
          "display_none_ancestor",
        ),
  );

  byId.set(
    "intake_backend_pty_continuity",
    ledger.authorityFailures > 0
      ? failed("intake_backend_pty_continuity", "intake_registry_missing")
      : authorities.length < 2
      ? notObserved("intake_backend_pty_continuity")
      : authorities.every(
          (fact) =>
            fact.intakeRegistered &&
            fact.ptyIdsMatch &&
            fact.observedPtyLive &&
            fact.authoritativePtyId === fact.observedPtyId,
        )
      ? passed("intake_backend_pty_continuity")
      : failed(
          "intake_backend_pty_continuity",
          "intake_registry_missing",
          "pty_mismatch",
          "pty_not_live",
        ),
  );

  const mountFailureReasons = mountContinuityFailureReasons(hosts);
  byId.set(
    "intake_mount_continuity",
    hosts.length < 2
      ? notObserved("intake_mount_continuity")
      : mountFailureReasons.length === 0
      ? passed("intake_mount_continuity")
      : failed(
          "intake_mount_continuity",
          ...mountFailureReasons,
        ),
  );

  byId.set(
    "intake_scroll_continuity",
    scrollContinuityCheck(ledger, hosts, authorities),
  );

  byId.set(
    "intake_step_transition",
    transitionCheck(
      "intake_step_transition",
      "step",
      ledger,
      hosts,
      1,
    ),
  );
  byId.set(
    "intake_mode_transition",
    transitionCheck(
      "intake_mode_transition",
      "mode",
      ledger,
      hosts,
      1,
    ),
  );
  byId.set(
    "intake_workspace_transition",
    transitionCheck(
      "intake_workspace_transition",
      "workspace",
      ledger,
      hosts,
      1,
    ),
  );
  byId.set(
    "intake_card_close_reopen",
    transitionCheck(
      "intake_card_close_reopen",
      "card_close_reopen",
      ledger,
      hosts,
      1,
    ),
  );
  byId.set(
    "intake_disclosure_transitions",
    transitionCheck(
      "intake_disclosure_transitions",
      "disclosure",
      ledger,
      hosts,
      2,
    ),
  );

  const distinctStates = new Set(
    states.flatMap((fact) => (fact.storeState ? [fact.storeState] : [])),
  );
  byId.set(
    "all_card_states_observed",
    states.length === 0
      ? notObserved("all_card_states_observed")
      : states.length === ALL_CARD_PRESENTATION_STATES.length &&
        distinctStates.size === ALL_CARD_PRESENTATION_STATES.length
      ? passed("all_card_states_observed")
      : failed(
          "all_card_states_observed",
          "state_missing",
          ...(states.some(
            (fact) =>
              fact.storeState == null ||
              fact.storeState !== fact.renderedState,
          )
            ? (["store_dom_mismatch"] as InstalledSelfCheckFailureReason[])
            : []),
        ),
  );
  byId.set(
    "one_primary_action_per_state",
    states.length < ALL_CARD_PRESENTATION_STATES.length
      ? notObserved("one_primary_action_per_state")
      : states.every(
          (fact) =>
            fact.storeState != null &&
            fact.storeState === fact.renderedState &&
            fact.actionId != null &&
            fact.primaryActionCount === 1,
        )
      ? passed("one_primary_action_per_state")
      : failed(
          "one_primary_action_per_state",
          ...(states.some(
            (fact) =>
              fact.storeState == null ||
              fact.storeState !== fact.renderedState,
          )
            ? (["store_dom_mismatch"] as InstalledSelfCheckFailureReason[])
            : []),
          ...(states.some((fact) => fact.actionId == null)
            ? (["missing_primary_action"] as InstalledSelfCheckFailureReason[])
            : []),
          ...(states.some((fact) => fact.primaryActionCount !== 1)
            ? ([
                "multiple_primary_actions",
              ] as InstalledSelfCheckFailureReason[])
            : []),
        ),
  );
  byId.set(
    "cmd_enter_focus_guards",
    guardedTraceCheck(traces, capabilities),
  );
  byId.set("cmd_enter_never_ships", keyboardShipCheck(traces));

  if (ledger.capReached) {
    for (const check of byId.values()) {
      check.status = "failed";
      const withoutCap = check.reasons.filter(
        (reason) => reason !== "observation_cap_reached",
      );
      check.reasons = [
        ...withoutCap.slice(0, INSTALLED_SELF_CHECK_MAX_REASONS - 1),
        "observation_cap_reached",
      ];
    }
  }

  return ALL_CHECK_IDS.map((id) => byId.get(id) ?? notObserved(id));
}

export type InstalledSelfCheckActionTraceInput = Omit<
  ActionTraceFact,
  "sequence"
>;

type TraceListener = (trace: InstalledSelfCheckActionTraceInput) => void;
const traceListeners = new Set<TraceListener>();

export function reportInstalledSelfCheckActionTrace(
  trace: InstalledSelfCheckActionTraceInput,
): void {
  for (const listener of traceListeners) listener(trace);
}

export function subscribeInstalledSelfCheckActionTrace(
  listener: TraceListener,
): () => void {
  traceListeners.add(listener);
  return () => traceListeners.delete(listener);
}
