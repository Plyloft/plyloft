import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { KanbanCard } from "../ipc.ts";
import {
  shipFailedPresentation,
  prOpenShipFailure,
  failedShipPress,
  SKILL_PR_LOCAL_SENTENCE,
  TEAMMATE_SHIP_SENTENCE,
  CARD_STATES,
  CARD_STATE_PRESENTATION,
  EMPTY_CARD_STATE_CONTEXT,
  cardStepForState,
  deriveCardState,
  deriveCardStep,
  uniqueSnapshots,
  cardStatePresentation,
  isCardSwarmQueued,
  swarmTemplateInUse,
  noNewSnapshotToast,
  builderSessionClosed,
  archiveToastBody,
  liveBuilderSessionState,
  nowAnnouncement,
  sessionClosedLabel,
  putBackOffered,
  putBackSheet,
  cardDelivery,
  cardLanded,
  cardShippedOrPrOpen,
  type CardState,
  type CardStateContext,
} from "./cardLifecycle.ts";

function card(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: "card-1",
    workspaceId: "workspace-1",
    title: "A task",
    columnId: "todo",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function context(
  overrides: Partial<CardStateContext> = {},
): CardStateContext {
  return { ...EMPTY_CARD_STATE_CONTEXT, ...overrides };
}


const cases: Array<{
  state: CardState;
  card?: Partial<KanbanCard>;
  context?: Partial<CardStateContext>;
}> = [
  {
    state: "archived",
    card: { archived: true, shipStatus: "shipped" },
  },
  {
    state: "shipped",
    card: { shipStatus: "shipped" },
  },
  { state: "shipping", context: { shipBusy: true } },
  {
    state: "running",
    card: { lastRunStatus: "running" },
  },
  // GH #244: the Builder's session is closed or lost.
  {
    state: "session-closed",
    card: {
      lastRunStatus: "running",
      builder: { vendor: "claude", bypass: false, ptyId: null, sessionLost: false, startedAt: 1, snapshots: [] },
    },
  },
  {
    state: "paused",
    card: { lastRunStatus: "running" },
    context: { linkedSwarmStatus: "suspended" },
  },
  {
    state: "queued",
    card: {
      columnId: "in_progress",
      swarmTemplateId: "feature",
      linkedSwarmId: null,
    },
  },
  {
    state: "challenger-reviewing",
    card: {
      lastRunStatus: "success",
      builder: {
        vendor: "codex",
        bypass: true,
        sessionLost: false,
        startedAt: 1,
        snapshots: [{ n: 1, sha: "abc", at: 1 }],
        review: {
          snapshotN: 1,
          provider: "claude",
          degraded: false,
          status: "running",
          at: 1,
        },
      },
    },
  },
  {
    state: "changes-requested",
    card: {
      lastRunStatus: "success",
      builder: {
        vendor: "codex",
        bypass: true,
        sessionLost: false,
        startedAt: 1,
        snapshots: [{ n: 1, sha: "abc", at: 1 }],
        review: {
          snapshotN: 1,
          provider: "claude",
          degraded: false,
          status: "done",
          verdict: "changes_requested",
          at: 1,
        },
      },
    },
  },
  {
    state: "checking",
    card: { verifyStatus: "queued" },
  },
  {
    state: "verify-failed",
    card: { verifyStatus: "failed" },
  },
  {
    state: "failed",
    card: { verifyStatus: "none", lastRunStatus: "failed" },
  },
  {
    state: "review-stale",
    context: { reviewFreshness: "stale" },
  },
  {
    state: "no-changes",
    card: { lastRunStatus: "success" },
    context: { outcomeFilesChanged: 0 },
  },
  {
    state: "ready-to-ship",
    card: { lastRunStatus: "success" },
    context: { outcomeFilesChanged: 2 },
  },
  {
    state: "result-ready",
    card: { lastRunStatus: "success" },
    context: { outcomeLoading: true },
  },
  {
    state: "intake-live",
    card: { intakeStatus: "active" },
  },
  // GH #243: in Complete with no run, no checks and not landed.
  {
    state: "closed",
    card: { columnId: "complete", notes: "A brief" },
  },
  {
    state: "ready",
    card: { intakeStatus: "ready" },
  },
  { state: "draft" },
];

assert.equal(cases.length, CARD_STATES.length);
assert.deepEqual(
  cases.map(({ state }) => state),
  [...CARD_STATES],
);
for (const fixture of cases) {
  assert.equal(
    deriveCardState(card(fixture.card), context(fixture.context)),
    fixture.state,
    fixture.state,
  );
}

// First match wins across deliberately contradictory inputs.
assert.equal(
  deriveCardState(
    card({
      archived: true,
      shipStatus: "shipped",
      lastRunStatus: "running",
    }),
    context({ shipBusy: true }),
  ),
  "archived",
);
// GH #104: a landed card is `shipped`, full stop. The three post-ship lesson
// states that used to sit between landing and `shipped` are retired (ADR 0005).
assert.equal(
  deriveCardState(card({ shipStatus: "shipped" }), context({})),
  "shipped",
);
assert.equal(
  deriveCardState(
    card({ lastRunStatus: "running", verifyStatus: "failed" }),
    context({ shipBusy: true }),
  ),
  "shipping",
);
assert.equal(
  deriveCardState(
    card({ lastRunStatus: "failed", verifyStatus: "failed" }),
    context(),
  ),
  "verify-failed",
);

// P3-0's dispatch reset: the stale verify failure is gone, so a newer
// failed attempt is presented as stopped work rather than failed checks.
assert.equal(
  deriveCardState(
    card({ lastRunStatus: "failed", verifyStatus: "none" }),
    context(),
  ),
  "failed",
);

// A conflict blocks the normal ship action without inventing a twentieth
// state; the host applies the conflict modifier to result-ready.
assert.equal(
  deriveCardState(
    card({ lastRunStatus: "success" }),
    context({ outcomeFilesChanged: 1, shipConflict: true }),
  ),
  "result-ready",
);

const queueFixtures: Array<[Partial<KanbanCard>, boolean]> = [
  [
    {
      columnId: "in_progress",
      swarmTemplateId: "feature",
      linkedSwarmId: null,
      archived: false,
      lastRunStatus: null,
    },
    true,
  ],
  [{ columnId: "todo", swarmTemplateId: "feature" }, false],
  [{ columnId: "in_progress", swarmTemplateId: null }, false],
  [
    {
      columnId: "in_progress",
      swarmTemplateId: "feature",
      linkedSwarmId: "swarm-1",
    },
    false,
  ],
  [
    {
      columnId: "in_progress",
      swarmTemplateId: "feature",
      archived: true,
    },
    false,
  ],
  [
    {
      columnId: "in_progress",
      swarmTemplateId: "feature",
      lastRunStatus: "failed",
    },
    false,
  ],
];
for (const [overrides, expected] of queueFixtures) {
  const fixture = card(overrides);
  assert.equal(isCardSwarmQueued(fixture), expected);
  assert.equal(
    deriveCardStep(fixture, false) === "run",
    expected,
    `queue/step equivalence for ${JSON.stringify(overrides)}`,
  );
}

assert.deepEqual(
  Object.keys(CARD_STATE_PRESENTATION).sort(),
  [...CARD_STATES].sort(),
);
const expectedPresentation: Record<
  CardState,
  [label: string, action: string, tone: "accent" | "quiet"]
> = {
  archived: ["Archived", "View history", "quiet"],
  shipped: ["Shipped", "View the shipped result", "quiet"],
  shipping: ["Shipping", "Watch it ship", "quiet"],
  running: ["Working", "Open the Builder", "quiet"],
  "session-closed": ["Session closed", "Resume", "accent"],
  paused: ["Paused", "Resume", "accent"],
  queued: ["In line", "See the queue", "quiet"],
  "challenger-reviewing": ["Reviewing", "Open the Builder", "quiet"],
  // GH #135: the default press only opens the Run step, so it says so;
  // `changesRequestedPresentation` swaps it when findings are owed.
  "changes-requested": [
    "Reviewer requests changes",
    "Open the Builder",
    "accent",
  ],
  checking: ["Running checks", "Watch the checks", "quiet"],
  "verify-failed": ["Checks failed", "See what failed", "accent"],
  failed: ["Stopped", "Try again", "accent"],
  "review-stale": [
    "Review is out of date",
    "Run the review again",
    "accent",
  ],
  "no-changes": ["Nothing changed", "See the review", "accent"],
  "ready-to-ship": ["Ready to ship", "Ship it", "accent"],
  "result-ready": ["Preparing the result", "See the review", "quiet"],
  closed: ["Closed", "View history", "quiet"],
  "intake-live": [
    "Planning with Claude",
    "Open the conversation",
    "quiet",
  ],
  ready: ["Ready to start", "Start build", "accent"],
  // 1.171.0 C1 (CF5): a card with only its title starts.
  draft: ["Ready to start", "Start build", "accent"],
};
for (const state of CARD_STATES) {
  const presentation = CARD_STATE_PRESENTATION[state];
  assert.deepEqual(
    [presentation.label, presentation.actionLabel, presentation.tone],
    expectedPresentation[state],
  );
  assert.ok(presentation.label);
  assert.ok(presentation.actionLabel);
  assert.ok(presentation.helper);
  assert.ok(presentation.actionId);
  assert.ok(presentation.tone === "accent" || presentation.tone === "quiet");
}

// GH #253: every Now helper is one sentence of what is true — never the
// mechanism of the button, which is the button's title.
for (const state of CARD_STATES) {
  const { helper, actionTitle } = CARD_STATE_PRESENTATION[state];
  assert.ok((helper.match(/[.!?](\s|$)/g) ?? []).length <= 1, `${state}: one sentence — ${helper}`);
  assert.doesNotMatch(helper, /target branch|ship steps|Shows the|\bpress/i, `${state}: ${helper}`);
  assert.ok(actionTitle, `${state}: what the button does is its title`);
}

// GH #104: `cardStatePresentation` is a map lookup again. It took a proposal
// only to tell the retired lesson's "drafting" from its "not started yet".
for (const state of CARD_STATES) {
  assert.equal(cardStatePresentation(state), CARD_STATE_PRESENTATION[state]);
}

const intakeStates: CardState[] = ["draft", "intake-live", "ready"];
const runStates: CardState[] = ["queued", "running", "paused"];
const outcomeStates: CardState[] = [
  "checking",
  "verify-failed",
  "failed",
  "review-stale",
  "no-changes",
  "result-ready",
  "ready-to-ship",
];
const shipStates: CardState[] = ["shipping", "shipped"];
for (const state of intakeStates) assert.equal(cardStepForState(state, "ship"), "intake");
for (const state of runStates) assert.equal(cardStepForState(state, "ship"), "run");
for (const state of outcomeStates) assert.equal(cardStepForState(state, "ship"), "outcome");
for (const state of shipStates) assert.equal(cardStepForState(state, "intake"), "ship");
assert.equal(cardStepForState("archived", "outcome"), "outcome");

console.log("card lifecycle hierarchy tests passed");

// v1.112.0: a changes-requested verdict on an OLDER snapshot is superseded
// by the newer snapshot — the card is not "changes requested" any more.
assert.equal(
  deriveCardState(
    card({
      lastRunStatus: "success",
      builder: {
        vendor: "codex",
        bypass: true,
        sessionLost: false,
        startedAt: 1,
        snapshots: [
          { n: 1, sha: "a", at: 1 },
          { n: 2, sha: "b", at: 2 },
        ],
        review: {
          snapshotN: 1,
          provider: "claude",
          degraded: false,
          status: "done",
          verdict: "changes_requested",
          at: 1,
        },
      },
    }),
    context({ outcomeFilesChanged: 3 }),
  ),
  "ready-to-ship",
);
// v1.112.0: a written brief makes the card ready to build without intake.
assert.equal(deriveCardState(card({ notes: "Fix the login" }), context()), "ready");
assert.equal(deriveCardState(card({ notes: "   " }), context()), "draft");
// Step follows the Challenger: run while reviewing, outcome once settled.
assert.equal(
  deriveCardStep(
    card({
      lastRunStatus: "success",
      builder: {
        vendor: "claude",
        bypass: false,
        sessionLost: false,
        startedAt: 1,
        snapshots: [{ n: 1, sha: "a", at: 1 }],
        review: { snapshotN: 1, provider: "codex", degraded: false, status: "running", at: 1 },
      },
    }),
    false,
  ),
  "run",
);
assert.equal(
  deriveCardStep(
    card({
      lastRunStatus: "success",
      builder: {
        vendor: "claude",
        bypass: false,
        sessionLost: false,
        startedAt: 1,
        snapshots: [{ n: 1, sha: "a", at: 1 }],
        review: { snapshotN: 1, provider: "codex", degraded: false, status: "done", verdict: "approve", at: 1 },
      },
    }),
    false,
  ),
  "outcome",
);

// Build done never records an unchanged tree twice; cards persisted before
// that fix (PR #27 showed 358af202 twice) render each SHA once, keeping its
// latest position — the same rule as builder.rs::record_snapshot, so the
// number shown is the number Ship reports.
assert.deepEqual(
  uniqueSnapshots([
    { n: 1, sha: "aaa", at: 1 },
    { n: 2, sha: "358af202", at: 2 },
    { n: 3, sha: "358af202", at: 3 },
  ]),
  [
    { n: 1, sha: "aaa", at: 1 },
    { n: 3, sha: "358af202", at: 3 },
  ],
);
assert.deepEqual(
  uniqueSnapshots([
    { n: 1, sha: "bbb", at: 1 },
    { n: 2, sha: "aaa", at: 2 },
    { n: 3, sha: "bbb", at: 3 },
  ]),
  [
    { n: 2, sha: "aaa", at: 2 },
    { n: 3, sha: "bbb", at: 3 },
  ],
  "a re-selected older snapshot moves to the end, as the backend does",
);
assert.deepEqual(uniqueSnapshots([]), []);

// Card #38, snapshot 5: the human accepted the Builder's pushback (Build
// done + Skip review on an unchanged tree). The review is recorded as
// skipped with a note, so the card leaves Run for Outcome and can ship.
{
  const pushedBack = (review: NonNullable<KanbanCard["builder"]>["review"]) =>
    card({
      lastRunStatus: "success",
      verifyStatus: "passed",
      builder: {
        vendor: "claude",
        bypass: false,
        sessionLost: false,
        startedAt: 1,
        snapshots: [
          { n: 4, sha: "d", at: 1 },
          { n: 5, sha: "e", at: 2 },
        ],
        review,
      },
    });
  const requested = pushedBack({
    snapshotN: 5,
    provider: "codex",
    degraded: false,
    status: "done",
    verdict: "changes_requested",
    at: 3,
  });
  assert.equal(deriveCardStep(requested, false), "run");
  assert.equal(
    deriveCardState(requested, context({ outcomeFilesChanged: 2 })),
    "changes-requested",
  );
  const overridden = pushedBack({
    snapshotN: 5,
    provider: "codex",
    degraded: false,
    status: "skipped",
    verdict: null,
    note: "changes requested on snapshot 5, overridden by the human",
    overriddenBy: "me@example.com",
    at: 4,
  });
  assert.equal(deriveCardStep(overridden, false), "outcome", "the overridden card leaves Run");
  assert.equal(
    deriveCardState(overridden, context({ outcomeFilesChanged: 2 })),
    "ready-to-ship",
  );

  const snapshot = { n: 5, sha: "0123456789abcdef", at: 2 };
  // GH #124: Skip review on an unchanged tree cancels the waiting review.
  assert.equal(
    noNewSnapshotToast({ snapshot, reviewOverridden: false, changesRequested: false, snapshotVerified: false, waitingDropped: true }).title,
    "Waiting review cancelled",
  );
  assert.equal(
    noNewSnapshotToast({ snapshot, reviewOverridden: false, changesRequested: false, snapshotVerified: false, waitingStarted: 5 }).title,
    "Review started",
  );
  const accepted = noNewSnapshotToast({
    snapshot,
    reviewOverridden: true,
    changesRequested: false,
    snapshotVerified: true,
  });
  assert.equal(accepted.kind, "info");
  assert.match(accepted.body, /round 5/);
  assert.match(accepted.details, /snapshot #5/);
  assert.match(accepted.body, /overridden/);
  assert.match(accepted.body, /Your checks are not run again: this round already passed them/);
  assert.match(
    noNewSnapshotToast({ snapshot, reviewOverridden: true, changesRequested: false, snapshotVerified: false }).body,
    /Ship still needs this round to pass them/,
  );
  // 1.168.1 (Mac walk): no checks set up — none run, and none "passed".
  for (const snapshotVerified of [true, false]) {
    const none = noNewSnapshotToast({ snapshot, reviewOverridden: true, changesRequested: false, snapshotVerified }, true);
    assert.match(none.body, /No checks are set up for this project, so there are none to run\./);
    assert.doesNotMatch(none.body, /checks are not run again|pass them/);
  }
  // U15: with the session closed there is no Agree on the page; it says the way on.
  {
    const closed = noNewSnapshotToast({ snapshot, reviewOverridden: false, changesRequested: true, snapshotVerified: true }, false, "Codex", true);
    assert.match(closed.body, /Press Resume or Start fresh for Codex to fix it/);
    assert.doesNotMatch(closed.body, /Agree/);
    const quiet = noNewSnapshotToast({ snapshot, reviewOverridden: false, changesRequested: false, snapshotVerified: true }, false, "Codex", true);
    assert.match(quiet.body, /Commit your work in the card's copy and press Finish and check again/);
  }
  const blocked = noNewSnapshotToast({
    snapshot,
    reviewOverridden: false,
    changesRequested: true,
    snapshotVerified: true,
  });
  assert.equal(blocked.kind, "warn");
  assert.match(blocked.title, /Ship is not reachable/);
  // 1.171.0 C3 (CF2): the way on is the card's own press, never a
  // checked Skip review; by the Builder's name.
  assert.doesNotMatch(blocked.body, /Skip review|pushback|verdict/);
  assert.match(blocked.body, /press Agree with Claude, keep it as it is on the card/);
  assert.match(
    noNewSnapshotToast({ snapshot, reviewOverridden: false, changesRequested: true, snapshotVerified: true }, false, "Codex").body,
    /If Codex disagrees with the findings and you agree, press Agree with Codex, keep it as it is/,
  );
  assert.equal(accepted.title, "Kept as it is");
  assert.equal(
    noNewSnapshotToast({ snapshot, reviewOverridden: false, changesRequested: false, snapshotVerified: true }).title,
    "Nothing new to check",
  );
  console.log("builder pushback override lifecycle tests passed");
}

// GH #244: the closed session's one action is Resume, and its dot is not live.
assert.equal(CARD_STATE_PRESENTATION["session-closed"].actionId, "resume-session");
console.log("session-closed presentation tests passed");

// GH #257: the queued card's press does not target its own (unstarted) run.
assert.equal(CARD_STATE_PRESENTATION.queued.actionId, "see-queue");
assert.ok(!CARD_STATE_PRESENTATION.running.helper.includes("{duration}"));

// GH #306: beside a Ship that didn't go through, the callout is not "Ready to
// ship": it says the failure, keeps the ship primary as Try again, and keeps
// a helper the card page already wrote (the conflict's).
{
  const ready = CARD_STATE_PRESENTATION["ready-to-ship"];
  const failed = shipFailedPresentation(ready, "ship-it");
  assert.equal(failed.label, "Ship didn't go through");
  assert.equal(failed.actionLabel, "Try again");
  assert.equal(failed.actionId, "ship");
  assert.equal(failed.tone, "accent");
  assert.notEqual(failed.helper, ready.helper);
  assert.match(shipFailedPresentation(ready, "pr").actionTitle ?? "", /pull request/);
  // 1.171.0 B3 (Challenger 3): pushed, pull request not opened — Now's one
  // retry is the error's Open the pull request, the same press again.
  for (const press of ["ship-it", "pr", "pr-only"] as const) {
    const open = shipFailedPresentation(ready, prOpenShipFailure(press));
    assert.equal(open.actionLabel, "Open the pull request", press);
    assert.equal(open.shipMode, press === "ship-it" ? "ship_it" : press === "pr" ? "pr" : "pr_only", press);
    assert.equal(open.actionTitle, "Opens the pull request again, the same way.", press);
  }
  assert.equal(failedShipPress(prOpenShipFailure("pr-only")), "pr-only");
  assert.equal(failedShipPress("skill-pr-local"), null);
  assert.equal(shipFailedPresentation(ready, "pr-only").actionLabel, "Try again");
  const conflict = { ...CARD_STATE_PRESENTATION["result-ready"], actionId: "ship" as const, helper: "The last ship stopped on a conflict." };
  assert.equal(shipFailedPresentation(conflict, "ship-it").helper, "The last ship stopped on a conflict.");
  // Any other primary is left alone.
  assert.equal(shipFailedPresentation(CARD_STATE_PRESENTATION.shipped, "ship-it"), CARD_STATE_PRESENTATION.shipped);
  // H6b (Windows walk): a skill card's pull request refused for carrying
  // local commits is not tried again: the primary is Ship it, the local land.
  const local = shipFailedPresentation(ready, "skill-pr-local");
  assert.equal(local.label, "Ship didn't go through");
  assert.equal(local.actionLabel, "Ship it");
  assert.equal(local.shipMode, "merge_live");
  assert.equal(local.helper, SKILL_PR_LOCAL_SENTENCE);
  // 1.175.0 (D1): a teammate's work stopped the ship — no retry: the word
  // of a ship that didn't go through, a sentence, and Ship it as it was,
  // plain.
  const teammate = shipFailedPresentation(ready, "teammate");
  assert.equal(failedShipPress("teammate"), null);
  assert.equal(teammate.label, "Ship didn't go through");
  assert.equal(teammate.helper, TEAMMATE_SHIP_SENTENCE);
  assert.equal(teammate.actionLabel, ready.actionLabel);
  assert.notEqual(teammate.actionLabel, "Try again");
  assert.equal(teammate.tone, "quiet");
  assert.doesNotMatch(local.actionTitle ?? "", /again|pull request/);
  console.log("ship-failed presentation tests passed");
}

// v1.154.1 (walk J5, G2, K3): a card built by both whose sessions are gone
// reads "Session ended" (not Working); a live session whose build is done
// says so; a primary that is off is not announced as the action.
{
  const lane = (id: "a" | "b", extra: Record<string, unknown> = {}) => ({
    lane: id,
    vendor: id === "a" ? ("claude" as const) : ("codex" as const),
    worktreePath: "/w",
    branchName: "b",
    startedAt: 1,
    ...extra,
  });
  const both = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    card({ columnId: "in_progress", lastRunStatus: "running", buildBoth: { startedAt: 1, lanes: [lane("a", a), lane("b", b)] } });
  const ended = both({}, {});
  assert.equal(builderSessionClosed(ended), true);
  assert.equal(deriveCardState(ended, EMPTY_CARD_STATE_CONTEXT), "session-closed");
  assert.equal(sessionClosedLabel(ended.builder, ended.buildBoth), "Session closed");
  assert.equal(deriveCardState(both({ ptyId: "p" }, {}), EMPTY_CARD_STATE_CONTEXT), "running");
  // One stopped, the other done: nothing is working, so nothing ended.
  assert.equal(builderSessionClosed(both({ done: { sha: "a", at: 2 } }, { failed: "stopped" })), false);

  const builder = { vendor: "codex", bypass: false, startedAt: 1, ptyId: "p", snapshots: [{ n: 1, sha: "s", at: 2000 }] } as unknown as KanbanCard["builder"];
  assert.deepEqual(liveBuilderSessionState({ builder, lastRunStatus: "success" }, "working"), { id: "saved", label: "Your turn", dot: "done" });
  assert.deepEqual(liveBuilderSessionState({ builder, lastRunStatus: "success" }, "working", 1500), { id: "saved", label: "Your turn", dot: "done" });
  assert.deepEqual(liveBuilderSessionState({ builder, lastRunStatus: "running" }, "working"), { id: "working", label: "Working", dot: "running" });
  // A Fix paste (or line comments, a hand-over, typing) after Build done: working again.
  assert.deepEqual(liveBuilderSessionState({ builder, lastRunStatus: "success" }, "working", 2500), { id: "working", label: "Working", dot: "running" });
  // Build done with an unchanged tree after a send (no new snapshot): done again.
  assert.equal(liveBuilderSessionState({ builder, lastRunStatus: "success" }, "working", 2500, 3000).label, "Your turn");
  assert.equal(liveBuilderSessionState({ builder, lastRunStatus: "success" }, "working", 3500, 3000).label, "Working");
  // Round 3: idle at its prompt with its turn over, or quiet, after Build
  // done and nothing sent: still "Work saved" (no drift after ~10 s).
  assert.deepEqual(liveBuilderSessionState({ builder, lastRunStatus: "success" }, "asking-you", null, null, true), { id: "saved", label: "Your turn", dot: "done" });
  assert.equal(liveBuilderSessionState({ builder, lastRunStatus: "success" }, "wants-you").label, "Your turn");
  // A real question (its turn not over) after Finish and check: "Needs your answer".
  assert.deepEqual(liveBuilderSessionState({ builder, lastRunStatus: "success" }, "asking-you", null, null, false), { id: "question", label: "Asks you something", dot: "aborted" });
  assert.deepEqual(liveBuilderSessionState({ builder, lastRunStatus: "success" }, "asking-you"), { id: "question", label: "Asks you something", dot: "aborted" });
  assert.equal(liveBuilderSessionState({ builder, lastRunStatus: "success" }, "asking-you", 2500, null, false).label, "Asks you something");
  // Round 3 (RW-A): at its prompt with its turn over is not a question —
  // after a fix round's paste (sent since Build done), or before Build done.
  assert.deepEqual(liveBuilderSessionState({ builder, lastRunStatus: "success" }, "asking-you", 2500, null, true), { id: "stopped", label: "Your turn", dot: "done" });
  assert.equal(liveBuilderSessionState({ builder, lastRunStatus: "running" }, "asking-you", null, null, true).label, "Your turn");
  // Before Build done, silence decides as before.
  assert.equal(liveBuilderSessionState({ builder, lastRunStatus: "running" }, "wants-you").label, "Your turn");
  const changes = { ...builder!, review: { status: "done", verdict: "changes_requested", snapshotN: 1, at: 3 } } as unknown as KanbanCard["builder"];
  assert.equal(liveBuilderSessionState({ builder: changes, lastRunStatus: "success" }, "working").label, "Working");

  assert.equal(nowAnnouncement("Setting up the card", "Start build", true), "Setting up the card. Start build is off.");
  assert.equal(nowAnnouncement("Ready to start", "Start build", false), "Ready to start. Primary action: Start build.");
  // Round 3 (walk RW-B step 10): compared and waiting for the pick — the
  // Board and Now say so, sessions live or gone; with one build left it is
  // ready to continue.
  const compared = (a: Record<string, unknown>, b: Record<string, unknown>, compare: Record<string, unknown>) =>
    card({
      columnId: "in_progress",
      lastRunStatus: "running",
      buildBoth: { startedAt: 1, lanes: [lane("a", a), lane("b", b)], compare } as unknown as KanbanCard["buildBoth"],
    });
  const done = { done: { sha: "s", at: 2 } };
  const picking = compared({ ...done, ptyId: "p" }, { ...done, ptyId: "q" }, { status: "done", recommended: "a", reasons: [], startedAt: 1, at: 2 });
  assert.equal(deriveCardState(picking, EMPTY_CARD_STATE_CONTEXT), "session-closed");
  assert.equal(sessionClosedLabel(picking.builder, picking.buildBoth), "Pick one of the two builds");
  const afterQuit = compared(done, done, { status: "done", recommended: "b", reasons: [], startedAt: 1, at: 2 });
  assert.equal(sessionClosedLabel(afterQuit.builder, afterQuit.buildBoth), "Pick one of the two builds");
  const oneLeft = compared({ failed: "stopped" }, done, { status: "decided", recommended: "b", reasons: [], startedAt: 1, at: 2 });
  assert.equal(sessionClosedLabel(oneLeft.builder, oneLeft.buildBoth), "Codex's build is ready to continue");
  const leftFailed = compared({ failed: "stopped" }, { ...done, verify: { status: "failed", sha: "s", at: 3 } }, { status: "decided", recommended: "b", reasons: [], startedAt: 1, at: 2 });
  assert.equal(sessionClosedLabel(leftFailed.builder, leftFailed.buildBoth), "Only Codex's build is left");
  const odd = compared({ failed: "stopped" }, { ...done, vendor: "other" }, { status: "decided", recommended: "b", reasons: [], startedAt: 1, at: 2 });
  assert.equal(sessionClosedLabel(odd.builder, odd.buildBoth), "Claude's build is ready to continue", "as the backend names it");
  const comparing = compared({ ...done, ptyId: "p" }, { ...done, ptyId: "q" }, { status: "running", reasons: [], startedAt: 1, at: 2 });
  assert.equal(deriveCardState(comparing, EMPTY_CARD_STATE_CONTEXT), "running");
  console.log("session and announcement tests passed");
}

// F11 (team walk): closing a Builder's session records its run as aborted
// (`builder.rs::apply_close`). The card still reads "Session closed", with
// Resume — not a failed run — while a swarm's abort stays "failed", and a
// card both build is not read this way while undecided.
{
  const builder = { vendor: "claude", bypass: false, startedAt: 1, snapshots: [] } as unknown as KanbanCard["builder"];
  const closed = card({ columnId: "in_progress", lastRunStatus: "aborted", builder });
  assert.equal(builderSessionClosed(closed), true);
  assert.equal(deriveCardState(closed, EMPTY_CARD_STATE_CONTEXT), "session-closed");
  assert.equal(sessionClosedLabel(closed.builder, closed.buildBoth), "Session closed");
  const swarm = card({ columnId: "in_progress", lastRunStatus: "aborted" });
  assert.equal(builderSessionClosed(swarm), false);
  assert.equal(deriveCardState(swarm, EMPTY_CARD_STATE_CONTEXT), "failed");
  const live = card({ columnId: "in_progress", lastRunStatus: "aborted", builder: { ...builder!, ptyId: "p" } });
  assert.equal(builderSessionClosed(live), false);
  const undecided = card({
    columnId: "in_progress",
    lastRunStatus: "aborted",
    builder,
    buildBoth: { startedAt: 1, lanes: [] } as unknown as KanbanCard["buildBoth"],
  });
  assert.equal(builderSessionClosed(undecided), false);
  // A card a swarm or an agent run owns: its abort is that run's failure.
  for (const linked of [{ linkedRunId: "r1" }, { linkedSwarmId: "s1" }]) {
    const owned = card({ columnId: "in_progress", lastRunStatus: "aborted", builder, ...linked });
    assert.equal(builderSessionClosed(owned), false);
    assert.equal(deriveCardState(owned, EMPTY_CARD_STATE_CONTEXT), "failed");
  }
  // The archive toast says what archiving a closed session's card costs.
  assert.match(
    archiveToastBody({ ...closed, worktreePath: "/w" }),
    /^A task\. Its Builder session was closed; archiving moves its folder to the Trash, so Resume won't be available\.$/,
  );
  assert.equal(archiveToastBody(closed), "A task", "no folder, nothing to lose");
  assert.equal(archiveToastBody(card({ worktreePath: "/w" })), "A task");
  // 1.175.0 (D2): on a GitHub Issues board the archive takes the member's
  // own name off the issue, and the toast with Undo says so.
  assert.equal(archiveToastBody(card({ worktreePath: "/w" }), 161), "A task. Your name is off issue #161.");
  assert.match(
    archiveToastBody({ ...closed, worktreePath: "/w" }, 161),
    /^A task\. Its Builder session was closed; archiving moves its folder to the Trash, so Resume won't be available\. Your name is off issue #161\.$/,
  );
  assert.equal(archiveToastBody(card({ worktreePath: "/w" }), null), "A task");
  console.log("F11 closed-builder tests passed");
}

{
  // G4 (launch D8): a swarm template counts only while a swarm can still run.
  assert.equal(swarmTemplateInUse({ swarmTemplateId: "feature", columnId: "todo" }), false, "never ran");
  assert.equal(swarmTemplateInUse({ swarmTemplateId: "feature", columnId: "todo", linkedSwarmId: "s" }), true, "ran before");
  assert.equal(swarmTemplateInUse({ swarmTemplateId: "feature", columnId: "in_progress" }), true, "queued");
  assert.equal(swarmTemplateInUse({ swarmTemplateId: null, columnId: "in_progress", linkedSwarmId: "s" }), false);
  console.log("G4 swarm template tests passed");
}

{
  // N14 F8: a card put back in To do reads as To do — ready to start —
  // whatever its last checks or review said; its snapshots stay.
  const builder = {
    vendor: "claude",
    bypass: false,
    ptyId: null,
    sessionLost: false,
    startedAt: 1,
    snapshots: [{ n: 1, sha: "a", at: 2 }],
    review: { snapshotN: 1, provider: "codex", degraded: false, status: "done", verdict: "changes_requested", at: 3 },
  } as KanbanCard["builder"];
  const back = card({ columnId: "todo", builder, verifyStatus: "failed", notes: "" });
  assert.equal(deriveCardState(back, EMPTY_CARD_STATE_CONTEXT), "ready");
  assert.equal(deriveCardState(back, { ...EMPTY_CARD_STATE_CONTEXT, reviewFreshness: "stale" }), "ready");
  // As the backend leaves it (no review), an intake talking says so.
  const talking = { ...back, intakeStatus: "active" as const, verifyStatus: "none" as const, builder: { ...builder!, review: null } };
  assert.equal(deriveCardState(talking, EMPTY_CARD_STATE_CONTEXT), "intake-live");
  // Where the ⋯ offers it.
  const at = (over: Partial<KanbanCard>) => card({ worktreePath: "/w", ...over });
  assert.equal(putBackOffered(at({ columnId: "in_progress" }), false), true);
  assert.equal(putBackOffered(at({ columnId: "complete" }), false), true, "waiting to ship");
  assert.equal(putBackOffered(at({ columnId: "complete", worktreePath: null }), false), false, "history");
  assert.equal(putBackOffered(at({ columnId: "todo" }), false), false);
  assert.equal(putBackOffered(at({ columnId: "in_progress", shipStatus: "shipped" }), false), false);
  // 1.174.0 A2: an open pull request hasn't landed — offered, and the ⋯
  // turns it off with PUT_BACK_OPEN_PR.
  const openPr = { prUrl: "https://github.com/o/r/pull/7", pr: { number: 7, state: "open" } } as Partial<KanbanCard>;
  assert.equal(putBackOffered(at({ columnId: "in_progress", reviewStatus: "merged", ...openPr }), false), true);
  assert.equal(
    putBackOffered(at({ columnId: "in_progress", reviewStatus: "merged", prUrl: "https://github.com/o/r/pull/7" }), false),
    false,
    "a pull request Plyloft never read back counts as landed",
  );
  assert.equal(putBackOffered(at({ columnId: "in_progress", archived: true }), false), false);
  assert.equal(putBackOffered(at({ columnId: "in_progress", worktreePath: null }), true), false, "not built here");
  assert.equal(putBackOffered(at({ columnId: "in_progress" }), true), true);
  assert.deepEqual(putBackSheet("Fix login"), {
    title: "Move “Fix login” back to Ready to start?",
    body: "Its Builder session stops. The branch and the work done so far are kept; Start build picks it up again.",
    confirmLabel: "Move back",
  });
  // 1.175.0 (D2): one sentence more, only when the member's own name is on
  // the card's issue (`cardClaim.ownNameComesOff`).
  assert.equal(
    putBackSheet("Fix login redirect", 161).body,
    "Its Builder session stops. The branch and the work done so far are kept; Start build picks it up again. Your name comes off issue #161, so your team sees it as free.",
  );
  assert.deepEqual(putBackSheet("Fix login", null), putBackSheet("Fix login"));
  console.log("F8 put back tests passed");
}

// 1.174.0 A2 (P7): sent is not landed — held to the same fixtures as
// `kanban.rs::card_delivery` (src/lib/cardDelivery.fixtures.json).
{
  const fixtures: {
    cases: { name: string; card: Partial<KanbanCard>; delivery: string; shippedOrPrOpen: boolean }[];
  } = JSON.parse(readFileSync(new URL("./cardDelivery.fixtures.json", import.meta.url), "utf8"));
  assert.ok(fixtures.cases.length >= 15);
  for (const c of fixtures.cases) {
    const card = { shipStatus: "unshipped", reviewStatus: null, ...c.card } as KanbanCard;
    assert.equal(cardDelivery(card), c.delivery, c.name);
    assert.equal(cardLanded(card), c.delivery === "landed", `${c.name}: landed`);
    assert.equal(cardShippedOrPrOpen(card), c.shippedOrPrOpen, `${c.name}: shipped or open`);
  }
  console.log("A2 card delivery fixtures passed");
}
