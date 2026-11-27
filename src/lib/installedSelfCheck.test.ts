import assert from "node:assert/strict";
import type {
  ActionTraceFact,
  InstalledSelfCheckObservation,
  IntakeHostFact,
} from "../ipc.ts";
import {
  INSTALLED_SELF_CHECK_QUERY,
  ALL_CARD_PRESENTATION_STATES,
  INSTALLED_SELF_CHECK_OBSERVATION_CAP,
  INSTALLED_SELF_CHECK_MAX_REASONS,
  type InstalledSelfCheckLedger,
  appendInstalledSelfCheckObservation,
  cardStateEvidenceOrigin,
  createInstalledSelfCheckLedger,
  deriveInstalledSelfCheckChecks,
  hiddenSelfCheckCommandVisible,
  intakeSelectionEffect,
  markInstalledSelfCheckAuthorityFailure,
  markInstalledSelfCheckTransition,
  markInstalledSelfCheckTransitionFailure,
  recordInstalledSelfCheckCardState,
} from "./installedSelfCheck.ts";

assert.equal(hiddenSelfCheckCommandVisible(INSTALLED_SELF_CHECK_QUERY), true);
for (const query of [
  "",
  "Plyloft diagnostics",
  "diagnostics P3-1",
  `${INSTALLED_SELF_CHECK_QUERY} now`,
  INSTALLED_SELF_CHECK_QUERY.toLowerCase(),
  `x${INSTALLED_SELF_CHECK_QUERY}`,
]) {
  assert.equal(hiddenSelfCheckCommandVisible(query), false, query);
}

assert.equal(
  cardStateEvidenceOrigin("p3-self-check-seeded-ready-to-ship", "ready-to-ship"),
  "seeded",
);
assert.equal(
  cardStateEvidenceOrigin("p3-self-check-seeded-ready-to-ship", "shipping"),
  "reached",
  "a live transition on a seeded card must not inherit seeded authority",
);
assert.equal(cardStateEvidenceOrigin("owner-card", "draft"), "reached");

assert.equal(intakeSelectionEffect("anchor", "anchor", null), "observe");
assert.equal(intakeSelectionEffect("anchor", null, "anchor"), "observe");
assert.equal(
  intakeSelectionEffect("anchor", "anchor", "seeded-card"),
  "end_phase",
);
assert.equal(
  intakeSelectionEffect("anchor", null, "seeded-card"),
  "end_phase",
);
assert.equal(
  intakeSelectionEffect("anchor", "seeded-a", "seeded-b"),
  "end_phase",
);
assert.equal(intakeSelectionEffect("anchor", "anchor", "anchor"), "ignore");

function host(
  sequence: number,
  transitionId: string | null,
  viewportRow: number,
  overrides: Partial<IntakeHostFact> = {},
): InstalledSelfCheckObservation {
  return {
    kind: "intake_host",
    fact: {
      sequence,
      checkpoint: "mode",
      transitionId,
      ptyId: "pty-1",
      mountId: "mount-1",
      viewportRow,
      scrollbackRows: viewportRow + 10,
      scrollObserved: true,
      bufferKind: "normal",
      cols: 120,
      rows: 40,
      resizeEpoch: 0,
      width: 800,
      height: 400,
      connected: true,
      displayNoneAncestor: false,
      closedDetailsAncestor: false,
      ...overrides,
    },
  };
}

function liveAuthority(sequence: number): InstalledSelfCheckObservation {
  return {
    kind: "intake_authority",
    fact: {
      sequence,
      checkpoint: sequence === 100 ? "initial" : "workspace",
      observedPtyId: "pty-1",
      authoritativePtyId: "pty-1",
      intakeRegistered: true,
      ptyIdsMatch: true,
      observedPtyLive: true,
    },
  };
}

function trace(
  sequence: number,
  overrides: Partial<ActionTraceFact>,
): InstalledSelfCheckObservation {
  return {
    kind: "action_trace",
    fact: {
      sequence,
      state: "draft",
      actionId: "plan",
      source: "keyboard",
      focusCategory: "input",
      primaryActionInvocations: 0,
      shipInvocations: 0,
      ...overrides,
    },
  };
}

{
  let ledger = createInstalledSelfCheckLedger();
  ledger = {
    ...ledger,
    observations: [
      host(0, "mode-1", 10),
      host(1, "mode-1", 10),
      host(2, "workspace-1", 99, { checkpoint: "workspace" }),
      host(3, "workspace-1", 99, { checkpoint: "workspace" }),
      liveAuthority(100),
      liveAuthority(101),
    ],
  };
  ledger = markInstalledSelfCheckTransition(ledger, "mode");
  ledger = markInstalledSelfCheckTransition(ledger, "workspace");
  const checks = deriveInstalledSelfCheckChecks(ledger);
  assert.equal(
    checks.find((check) => check.id === "intake_scroll_continuity")?.status,
    "passed",
  );
  assert.equal(
    checks.find((check) => check.id === "intake_mode_transition")?.status,
    "passed",
  );
}

{
  let ledger = createInstalledSelfCheckLedger();
  ledger = {
    ...ledger,
    observations: [
      host(0, "mode-interleaved", 10),
      host(1, "workspace-interleaved", 90, { checkpoint: "workspace" }),
      host(2, "mode-interleaved", 10),
      host(3, "workspace-interleaved", 90, { checkpoint: "workspace" }),
    ],
  };
  ledger = markInstalledSelfCheckTransition(ledger, "mode");
  ledger = markInstalledSelfCheckTransition(ledger, "workspace");
  const checks = deriveInstalledSelfCheckChecks(ledger);
  assert.equal(
    checks.find((check) => check.id === "intake_mode_transition")?.status,
    "passed",
  );
  assert.equal(
    checks.find((check) => check.id === "intake_workspace_transition")?.status,
    "passed",
  );
}

for (const [label, overrides, expectedReason] of [
  ["remount", { mountId: "mount-2" }, "mount_changed"],
  ["zero-size", { width: 0 }, "zero_geometry"],
  ["display-none", { displayNoneAncestor: true }, "display_none_ancestor"],
  [
    "closed-details",
    { closedDetailsAncestor: true },
    "closed_details_ancestor",
  ],
] as const) {
  let ledger = createInstalledSelfCheckLedger();
  ledger = {
    ...ledger,
    observations: [
      host(0, `mode-${label}`, 10),
      host(1, `mode-${label}`, 10, overrides),
    ],
  };
  ledger = markInstalledSelfCheckTransition(ledger, "mode");
  const check = deriveInstalledSelfCheckChecks(ledger).find(
    (candidate) => candidate.id === "intake_mode_transition",
  );
  assert.equal(check?.status, "failed", label);
  assert.deepEqual(check?.reasons, [expectedReason], label);
}

{
  let ledger = createInstalledSelfCheckLedger();
  ledger = {
    ...ledger,
    observations: [
      host(0, "mode-1", 10),
      host(1, "mode-1", 0),
      liveAuthority(100),
      liveAuthority(101),
    ],
  };
  ledger = markInstalledSelfCheckTransition(ledger, "mode");
  const checks = deriveInstalledSelfCheckChecks(ledger);
  assert.equal(
    checks.find((check) => check.id === "intake_scroll_continuity")?.status,
    "failed",
  );
}

for (const [label, beforeOverrides, afterOverrides, expectedStatus] of [
  [
    "never-scrolled",
    { scrollObserved: false },
    { scrollObserved: false },
    "not_observed",
  ],
  [
    "zero-row",
    { viewportRow: 0, scrollbackRows: 10 },
    { viewportRow: 0, scrollbackRows: 10 },
    "not_observed",
  ],
  [
    "still-at-bottom",
    { viewportRow: 10, scrollbackRows: 10 },
    { viewportRow: 10, scrollbackRows: 10 },
    "not_observed",
  ],
  ["not-measurable", { width: 0 }, { width: 0 }, "failed"],
] as const) {
  const ledger: InstalledSelfCheckLedger = {
    ...createInstalledSelfCheckLedger(),
    observations: [
      host(0, `scroll-${label}`, 10, beforeOverrides),
      host(1, `scroll-${label}`, 10, afterOverrides),
      liveAuthority(100),
      liveAuthority(101),
    ],
  };
  const check = deriveInstalledSelfCheckChecks(ledger).find(
    (candidate) => candidate.id === "intake_scroll_continuity",
  );
  assert.equal(
    check?.status,
    expectedStatus,
    `${label} cannot prove scroll continuity`,
  );
}

{
  const ledger: InstalledSelfCheckLedger = {
    ...createInstalledSelfCheckLedger(),
    observations: [
      host(0, "scroll-returned-to-bottom", 10, { scrollbackRows: 20 }),
      host(1, "scroll-returned-to-bottom", 10, { scrollbackRows: 10 }),
      liveAuthority(100),
      liveAuthority(101),
    ],
  };
  const check = deriveInstalledSelfCheckChecks(ledger).find(
    (candidate) => candidate.id === "intake_scroll_continuity",
  );
  assert.equal(check?.status, "failed");
  assert.deepEqual(check?.reasons, ["scroll_reset"]);
}

{
  const alternate = {
    bufferKind: "alternate" as const,
    viewportRow: 0,
    scrollbackRows: 0,
    scrollObserved: false,
    cols: 120,
    rows: 40,
    resizeEpoch: 0,
  };
  const ledger: InstalledSelfCheckLedger = {
    ...createInstalledSelfCheckLedger(),
    observations: [
      host(0, "alternate-mode", 0, alternate),
      host(1, "alternate-mode", 0, alternate),
      liveAuthority(100),
      liveAuthority(101),
    ],
  };
  const check = deriveInstalledSelfCheckChecks(ledger).find(
    (candidate) => candidate.id === "intake_scroll_continuity",
  );
  assert.equal(check?.status, "passed");
}

for (const [label, afterOverrides, expectedReason] of [
  ["mixed-buffer", { bufferKind: "normal" }, "buffer_kind_changed"],
  ["changed-grid", { cols: 119 }, "grid_changed"],
  ["changed-epoch", { resizeEpoch: 1 }, "resize_epoch_changed"],
] as const) {
  const alternate = {
    bufferKind: "alternate" as const,
    viewportRow: 0,
    scrollbackRows: 0,
    scrollObserved: false,
    cols: 120,
    rows: 40,
    resizeEpoch: 0,
  };
  const ledger: InstalledSelfCheckLedger = {
    ...createInstalledSelfCheckLedger(),
    observations: [
      host(0, `alternate-${label}`, 0, alternate),
      host(1, `alternate-${label}`, 0, {
        ...alternate,
        ...afterOverrides,
      }),
      liveAuthority(100),
      liveAuthority(101),
    ],
  };
  const check = deriveInstalledSelfCheckChecks(ledger).find(
    (candidate) => candidate.id === "intake_scroll_continuity",
  );
  assert.equal(check?.status, "failed", label);
  assert.ok(check?.reasons.includes(expectedReason), label);
}

{
  const alternate = {
    bufferKind: "alternate" as const,
    viewportRow: 0,
    scrollbackRows: 0,
    scrollObserved: false,
    cols: 120,
    rows: 40,
    resizeEpoch: 0,
  };
  const ledger: InstalledSelfCheckLedger = {
    ...createInstalledSelfCheckLedger(),
    observations: [
      host(0, "alternate-late", 0, alternate),
      host(1, "alternate-late", 0, alternate),
      host(2, null, 0, { ...alternate, resizeEpoch: 2 }),
      liveAuthority(100),
      liveAuthority(101),
    ],
  };
  const check = deriveInstalledSelfCheckChecks(ledger).find(
    (candidate) => candidate.id === "intake_scroll_continuity",
  );
  assert.equal(check?.status, "failed");
  assert.ok(check?.reasons.includes("resize_epoch_changed"));
}

{
  const ledger: InstalledSelfCheckLedger = {
    ...createInstalledSelfCheckLedger(),
    observations: [
      host(0, "alternate-missing", 0, {
        bufferKind: "alternate",
        viewportRow: 0,
        scrollbackRows: 0,
        scrollObserved: false,
        resizeEpoch: null,
      }),
      host(1, "alternate-missing", 0, {
        bufferKind: "alternate",
        viewportRow: 0,
        scrollbackRows: 0,
        scrollObserved: false,
        resizeEpoch: null,
      }),
      liveAuthority(100),
      liveAuthority(101),
    ],
  };
  const check = deriveInstalledSelfCheckChecks(ledger).find(
    (candidate) => candidate.id === "intake_scroll_continuity",
  );
  assert.equal(check?.status, "failed");
  assert.deepEqual(check?.reasons, ["resize_epoch_missing"]);
}

{
  const ledger: InstalledSelfCheckLedger = {
    ...createInstalledSelfCheckLedger(),
    observations: [
      host(0, null, 10),
      host(1, null, 10, {
        mountId: "mount-2",
        width: 0,
        displayNoneAncestor: true,
      }),
    ],
  };
  const check = deriveInstalledSelfCheckChecks(ledger).find(
    (candidate) => candidate.id === "intake_mount_continuity",
  );
  assert.equal(check?.status, "failed");
  assert.deepEqual(check?.reasons, [
    "mount_changed",
    "zero_geometry",
    "display_none_ancestor",
  ]);
}

{
  let ledger = createInstalledSelfCheckLedger();
  ledger = recordInstalledSelfCheckCardState(ledger, {
    cardId: "card-mismatch",
    evidenceOrigin: "reached",
    storeState: null,
    renderedState: "draft",
    actionId: "plan",
    tone: "accent",
    actionEnabled: true,
    primaryActionCount: 1,
  });
  const check = deriveInstalledSelfCheckChecks(ledger).find(
    (candidate) => candidate.id === "draft_primary_action",
  );
  assert.equal(check?.status, "failed");
  assert.deepEqual(check?.reasons, ["store_dom_mismatch"]);
}

{
  let ledger = createInstalledSelfCheckLedger();
  ledger = recordInstalledSelfCheckCardState(ledger, {
    cardId: "card-draft",
    evidenceOrigin: "reached",
    storeState: "draft",
    renderedState: "draft",
    actionId: "plan",
    tone: "accent",
    actionEnabled: true,
    primaryActionCount: 1,
  });
  ledger = recordInstalledSelfCheckCardState(ledger, {
    cardId: "card-draft",
    evidenceOrigin: "reached",
    storeState: "draft",
    renderedState: "draft",
    actionId: "plan",
    tone: "accent",
    actionEnabled: true,
    primaryActionCount: 2,
  });
  ledger = recordInstalledSelfCheckCardState(ledger, {
    cardId: "card-draft",
    evidenceOrigin: "reached",
    storeState: "draft",
    renderedState: "draft",
    actionId: "plan",
    tone: "accent",
    actionEnabled: true,
    primaryActionCount: 1,
  });
  const checks = deriveInstalledSelfCheckChecks(ledger);
  assert.equal(
    checks.find((check) => check.id === "draft_primary_action")?.status,
    "failed",
    "a later safe render must not conceal a duplicate primary action",
  );
}

{
  const ledger = markInstalledSelfCheckAuthorityFailure(
    createInstalledSelfCheckLedger(),
  );
  const check = deriveInstalledSelfCheckChecks(ledger).find(
    (candidate) => candidate.id === "intake_backend_pty_continuity",
  );
  assert.equal(check?.status, "failed");
  assert.deepEqual(check?.reasons, ["intake_registry_missing"]);
}

{
  let ledger = createInstalledSelfCheckLedger();
  for (const state of ALL_CARD_PRESENTATION_STATES.slice(0, -1)) {
    ledger = recordInstalledSelfCheckCardState(ledger, {
      cardId: `p3-self-check-seeded-${state}`,
      evidenceOrigin: "seeded",
      storeState: state,
      renderedState: state,
      actionId: `action-${state}`,
      tone: "quiet",
      actionEnabled: true,
      primaryActionCount: 1,
    });
  }
  const checks = deriveInstalledSelfCheckChecks(ledger);
  assert.equal(
    checks.find((check) => check.id === "all_card_states_observed")?.status,
    "failed",
    "one missing state must stay visible",
  );
  assert.equal(
    checks.find((check) => check.id === "one_primary_action_per_state")
      ?.status,
    "not_observed",
  );
}

{
  const guarded = [
    "input",
    "textarea",
    "code_mirror",
    "xterm",
    "outside_card",
  ] as const;
  const observations: InstalledSelfCheckObservation[] = [
    {
      kind: "ui_capability",
      fact: { sequence: 0, standaloneContenteditable: false },
    },
    ...guarded.map((focusCategory, index) =>
      trace(index + 1, { focusCategory }),
    ),
    trace(guarded.length + 1, {
      focusCategory: "card_background",
      primaryActionInvocations: 1,
    }),
  ];
  const check = deriveInstalledSelfCheckChecks({
    ...createInstalledSelfCheckLedger(),
    observations,
  }).find((candidate) => candidate.id === "cmd_enter_focus_guards");
  assert.equal(
    check?.status,
    "passed",
    "an absent standalone contenteditable must not make the contract impossible",
  );
}

{
  const guarded = [
    "input",
    "textarea",
    "code_mirror",
    "xterm",
    "outside_card",
  ] as const;
  const observations: InstalledSelfCheckObservation[] = [
    {
      kind: "ui_capability",
      fact: { sequence: 0, standaloneContenteditable: false },
    },
    ...guarded.map((focusCategory, index) =>
      trace(index + 1, { focusCategory }),
    ),
    trace(guarded.length + 1, {
      state: "ready-to-ship",
      source: "pointer",
      focusCategory: "card_background",
      primaryActionInvocations: 1,
      shipInvocations: 1,
    }),
  ];
  const check = deriveInstalledSelfCheckChecks({
    ...createInstalledSelfCheckLedger(),
    observations,
  }).find((candidate) => candidate.id === "cmd_enter_focus_guards");
  assert.equal(
    check?.status,
    "not_observed",
    "missing keyboard background evidence is incomplete, not a failure",
  );
}

{
  const guarded = [
    "input",
    "textarea",
    "contenteditable",
    "code_mirror",
    "xterm",
    "outside_card",
  ] as const;
  const observations: InstalledSelfCheckObservation[] = guarded.map(
    (focusCategory, sequence) => trace(sequence, { focusCategory }),
  );
  observations.push({
    kind: "ui_capability",
    fact: {
      sequence: observations.length,
      standaloneContenteditable: true,
    },
  });
  observations.push(
    trace(observations.length, {
      focusCategory: "card_background",
      primaryActionInvocations: 1,
    }),
    trace(observations.length + 1, {
      focusCategory: "input",
      primaryActionInvocations: 2,
    }),
  );
  const checks = deriveInstalledSelfCheckChecks({
    ...createInstalledSelfCheckLedger(),
    observations,
  });
  assert.equal(
    checks.find((check) => check.id === "cmd_enter_focus_guards")?.status,
    "failed",
    "a later/earlier safe trace must never conceal one guarded invocation",
  );
}

{
  const observations = [
    trace(0, {
      state: "ready-to-ship",
      focusCategory: "card_background",
    }),
    trace(1, {
      state: "ready-to-ship",
      focusCategory: "card_background",
      primaryActionInvocations: 3,
      shipInvocations: 2,
    }),
  ];
  const checks = deriveInstalledSelfCheckChecks({
    ...createInstalledSelfCheckLedger(),
    observations,
  });
  assert.equal(
    checks.find((check) => check.id === "cmd_enter_never_ships")?.status,
    "failed",
  );
}

{
  let ledger = createInstalledSelfCheckLedger();
  ledger = appendInstalledSelfCheckObservation(ledger, {
    kind: "action_trace",
    fact: {
      state: "ready-to-ship",
      actionId: "ship",
      source: "keyboard",
      focusCategory: "card_background",
      primaryActionInvocations: 100,
      shipInvocations: 87,
    },
  });
  const fact = ledger.observations[0];
  assert.equal(fact.kind, "action_trace");
  if (fact.kind === "action_trace") {
    assert.equal(fact.fact.primaryActionInvocations, 100);
    assert.equal(fact.fact.shipInvocations, 87);
  }
}

{
  let ledger = createInstalledSelfCheckLedger();
  for (
    let index = 0;
    index < INSTALLED_SELF_CHECK_OBSERVATION_CAP + 1;
    index += 1
  ) {
    ledger = appendInstalledSelfCheckObservation(ledger, {
      kind: "action_trace",
      fact: {
        state: "draft",
        actionId: "plan",
        source: "pointer",
        focusCategory: "card_background",
        primaryActionInvocations: 0,
        shipInvocations: 0,
      },
    });
  }
  assert.equal(ledger.observations.length, INSTALLED_SELF_CHECK_OBSERVATION_CAP);
  assert.equal(ledger.capReached, true);
  assert.ok(
    deriveInstalledSelfCheckChecks(ledger).every(
      (check) =>
        check.status === "failed" &&
        check.reasons.includes("observation_cap_reached"),
    ),
    "reaching the observation cap must fail every otherwise unresolved claim",
  );
}

{
  let ledger = createInstalledSelfCheckLedger();
  for (const reason of [
    "missing_host",
    "pty_mismatch",
    "mount_changed",
    "zero_geometry",
    "display_none_ancestor",
    "closed_details_ancestor",
    "scroll_reset",
    "intake_registry_missing",
  ] as const) {
    ledger = markInstalledSelfCheckTransitionFailure(ledger, "mode", reason);
  }
  ledger = { ...ledger, capReached: true };
  ledger = markInstalledSelfCheckTransition(ledger, "mode");
  const check = deriveInstalledSelfCheckChecks(ledger).find(
    (candidate) => candidate.id === "intake_mode_transition",
  );
  assert.equal(check?.status, "failed");
  assert.equal(check?.reasons.length, INSTALLED_SELF_CHECK_MAX_REASONS);
  assert.equal(
    check?.reasons[check.reasons.length - 1],
    "observation_cap_reached",
  );
}

console.log("installedSelfCheck.test.ts: all assertions passed");
