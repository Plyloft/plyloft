// Tier 3 pure-function test. Run with Node 22+:
//   node --experimental-strip-types src/lib/boardSemantics.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { KanbanCard, RunHistoryEntry } from "../ipc.ts";
import {
  BOARD_CARD_STATE_COLLAPSE,
  BOARD_ARCHIVE_BLOCKED_COPY,
  BOARD_ARCHIVE_SETUP_COPY,
  cardSetupRunning,
  BOARD_COLUMN_FOLLOWS_STATE_COPY,
  reorderKey,
  boardCardFact,
  shipBatchLabel,
  boardRunState,
  boardChipRunState,
  shortDuration,
  AUTO_ARCHIVE_AFTER_MS,
  autoArchiveCandidates,
  cardRestorable,
  restoreTitle,
  restoredWords,
  deriveBoardCardProvenance,
  deriveBoardDropDecision,
  legalDropZones,
  ATTENTION_COLUMNS,
  STATE_ATTENTION_COLUMN,
  attentionColumnFor,
  cardAttentionSignals,
  deriveAttentionColumn,
  deriveAttentionGroups,
  renderedBoardCardIds,
  cardRunState,
  isShipBatchEligible,
  shipBatchLeftOut,
  batchBuilderRefusal,
  BATCH_SESSION_OPEN,
  BATCH_NOT_APPROVED,
  BATCH_NOT_SAVED,
  BATCH_BOTH_UNDECIDED,
  BATCH_COPY_CHANGED,
  readyToShipForStage,
  releaseOffered,
  boardSaysReadyToShip,
  shipBatchShown,
} from "./boardSemantics.ts";
import { deriveBoardCardState, deriveBoardStage } from "./cardPresentation.ts";
import { claimedByOthersHere } from "./cardClaim.ts";
import { CARD_STATES } from "./cardLifecycle.ts";
import type { CardPresentationState } from "../ipc.ts";

function card(
  id: string,
  columnId: KanbanCard["columnId"],
  patch: Partial<KanbanCard> = {},
): KanbanCard {
  return {
    id,
    workspaceId: "ws-a",
    title: id,
    columnId,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}


// UX-5.2: the columns are by attention. Every canonical state has exactly
// one column (or none: the archive), and the table is the decision record.
assert.deepEqual(
  Object.keys(STATE_ATTENTION_COLUMN).sort(),
  [...CARD_STATES].sort(),
);
// QoL 1.168 block 8 (D13): a card nobody started is Not started.
const EXPECTED_COLUMN: Record<CardPresentationState, string | null> = {
  draft: "not-started",
  ready: "not-started",
  "changes-requested": "needs-you",
  "verify-failed": "needs-you",
  failed: "needs-you",
  "review-stale": "needs-you",
  "no-changes": "needs-you",
  "ready-to-ship": "needs-you",
  "result-ready": "needs-you",
  "session-closed": "needs-you",
  "intake-live": "working",
  running: "working",
  "challenger-reviewing": "working",
  checking: "working",
  shipping: "working",
  queued: "waiting",
  paused: "waiting",
  shipped: "done",
  closed: "done",
  archived: null,
};
const QUIET = { changesRequested: false, failed: false };
for (const state of CARD_STATES) {
  assert.equal(
    attentionColumnFor(state, QUIET),
    EXPECTED_COLUMN[state],
    `column of ${state}`,
  );
}
assert.deepEqual(
  ATTENTION_COLUMNS.map((c) => c.label),
  ["Needs you", "Not started", "Working", "On hold", "Done"],
);
// UX P1 point 4 (P-B): a Builder waiting on the person moves a Working card
// to Needs you; a saved Builder is not waiting (`waitingSessions` leaves it
// out), so it stays Working. Nothing else moves.
assert.equal(attentionColumnFor("running", { ...QUIET, builderWaiting: true }), "needs-you");
assert.equal(attentionColumnFor("running", { ...QUIET, builderWaiting: false }), "working");
assert.equal(attentionColumnFor("checking", { ...QUIET, builderWaiting: true }), "needs-you", "any Working column");
assert.equal(attentionColumnFor("queued", { ...QUIET, builderWaiting: true }), "waiting");
assert.equal(attentionColumnFor("shipped", { ...QUIET, builderWaiting: true }), "done");

// Precedence: Needs you > Failed > Working > On hold > Not started. Failed has no column
// of its own on the Board, so it lands in Needs you ahead of a running or
// waiting state; a request for changes does too. Done and the archive are
// not overridden.
for (const state of CARD_STATES) {
  const expected = EXPECTED_COLUMN[state];
  const both = { changesRequested: true, failed: true };
  const failedOnly = { changesRequested: false, failed: true };
  if (expected === null || expected === "done") {
    assert.equal(attentionColumnFor(state, both), expected, `${state} kept`);
    assert.equal(attentionColumnFor(state, failedOnly), expected, `${state} kept`);
  } else {
    assert.equal(attentionColumnFor(state, both), "needs-you", `${state} + both`);
    assert.equal(attentionColumnFor(state, failedOnly), "needs-you", `${state} + failed`);
  }
}
assert.deepEqual(
  cardAttentionSignals({ lastRunStatus: "rate_limited" }),
  { changesRequested: false, failed: true, blocked: false },
);
assert.deepEqual(
  cardAttentionSignals({ verifyStatus: "failed" }),
  { changesRequested: false, failed: true, blocked: false },
);
assert.deepEqual(
  cardAttentionSignals({ reviewStatus: "changes_requested" }),
  { changesRequested: true, failed: false, blocked: false },
);
// A swarm running for a card whose last run failed: Failed outranks Working.
assert.equal(
  deriveAttentionColumn(
    card("rerun", "in_progress", {
      lastRunStatus: "failed",
      linkedSwarmId: "s1",
    }),
    "running",
  ),
  "needs-you",
);
// The persisted column does not decide: a "Complete" card that is still
// checking is Working, a "To do" card with a failed run needs you.
assert.equal(
  deriveAttentionColumn(card("checks", "complete", { verifyStatus: "running" }), null),
  "working",
);
assert.equal(
  deriveAttentionColumn(card("todo-failed", "todo", { lastRunStatus: "failed" }), null),
  "needs-you",
);

const cards = [
  card("todo-quiet", "todo", { createdAt: 3 }),
  card("todo-failed", "todo", { lastRunStatus: "failed", createdAt: 2 }),
  card("working", "in_progress", { lastRunStatus: "running" }),
  card("queued", "in_progress", { swarmTemplateId: "feature" }),
  card("review-changes", "in_progress", {
    lastRunStatus: "success",
    reviewStatus: "changes_requested",
  }),
  card("done-old", "complete", {
    shipStatus: "shipped",
    shipHistory: [
      { commitSha: "a", shippedVersion: "v1", releaseKind: "local", shippedAt: 10 },
    ],
  }),
  card("done-new", "complete", {
    shipStatus: "shipped",
    shipHistory: [
      { commitSha: "b", shippedVersion: "v2", releaseKind: "local", shippedAt: 20 },
    ],
  }),
  card("archived", "complete", { archived: true }),
  // A malformed duplicate id must still render at most once.
  card("todo-failed", "complete"),
];

const all = deriveAttentionGroups(cards, () => null);
assert.deepEqual(all["needs-you"].map((item) => item.id), [
  "review-changes",
  "todo-failed",
]);
assert.deepEqual(all["not-started"].map((item) => item.id), ["todo-quiet"]);
assert.deepEqual(all.working.map((item) => item.id), ["working"]);
assert.deepEqual(all.waiting.map((item) => item.id), ["queued"]);
// Done is newest first.
assert.deepEqual(all.done.map((item) => item.id), ["done-new", "done-old"]);

const rendered = renderedBoardCardIds(all);
assert.equal(new Set(rendered).size, rendered.length);
assert.equal(rendered.includes("archived"), false);

// The Board projection must remain an exhaustive collapse of the canonical
// P3-1 authority, never a second first-match-wins state machine.
assert.deepEqual(
  Object.keys(BOARD_CARD_STATE_COLLAPSE).sort(),
  [...CARD_STATES].sort(),
);
assert.deepEqual(BOARD_CARD_STATE_COLLAPSE, {
  archived: "archived",
  shipped: "shipped",
  shipping: "shipped",
  running: "running",
  "session-closed": "session-closed",
  paused: "paused",
  queued: "queued",
  "challenger-reviewing": "checking",
  "changes-requested": "changes-requested",
  checking: "checking",
  "verify-failed": "verify-failed",
  failed: "failed",
  "review-stale": "result-ready",
  "no-changes": "result-ready",
  "ready-to-ship": "result-ready",
  "result-ready": "result-ready",
  "intake-live": "intake-live",
  closed: "closed",
  ready: "ready",
  draft: "draft",
});

// One Board state chip: bounded fields only, with the same labels as P3-1.
assert.deepEqual(
  deriveBoardCardState(card("draft", "todo"), null),
  // 1.171.0 C1 (CF5): a card with only its title is Ready to start.
  { state: "draft", label: "Ready to start", tone: "accent", blocked: null },
);
// UX-0.5: a finished run waits for the person on the Board; it never reads
// as "Preparing the result", the card page's loading line.
assert.deepEqual(
  deriveBoardCardState(card("done", "complete", { lastRunStatus: "success" }), null),
  { state: "result-ready", label: "Result ready", tone: "accent", blocked: null },
);
assert.equal(
  deriveBoardCardState(
    card("planning", "todo", { intakeStatus: "active" }),
    null,
  ).state,
  "intake-live",
);
assert.equal(
  deriveBoardCardState(
    card("ready", "todo", { intakeStatus: "ready" }),
    null,
  ).state,
  "ready",
);
assert.equal(
  deriveBoardCardState(
    card("queued", "in_progress", { swarmTemplateId: "feature" }),
    null,
  ).state,
  "queued",
);
assert.equal(
  deriveBoardCardState(
    card("paused", "in_progress", { lastRunStatus: "running" }),
    "suspended",
  ).state,
  "paused",
);
assert.equal(
  deriveBoardCardState(
    card("checks", "complete", { verifyStatus: "running" }),
    null,
  ).state,
  "checking",
);
assert.equal(
  deriveBoardCardState(
    card("verify-failed", "complete", { verifyStatus: "failed" }),
    null,
  ).state,
  "verify-failed",
);
assert.equal(
  deriveBoardCardState(
    card("result", "complete", { lastRunStatus: "success" }),
    null,
  ).state,
  "result-ready",
);
// GH #104: a landed card is `shipped` on the Board whatever the Library is
// waiting on. The three post-ship lesson states are retired (ADR 0005).
assert.equal(
  deriveBoardCardState(
    card("lesson", "complete", { shipStatus: "shipped" }),
    null,
  ).state,
  "shipped",
);
assert.equal(
  deriveBoardCardState(
    card("shipped", "complete", { reviewStatus: "merged" }),
    null,
  ).state,
  "shipped",
);

// Exactly one thin provenance source wins: issue, local-only, then branch.
assert.deepEqual(
  deriveBoardCardProvenance(
    card("issue", "todo", { ghIssueNumber: 42, branchName: "card/issue" }),
    true,
    false,
  ),
  {
    kind: "github",
    status: "default",
    label: "#42",
    title: "Backed by a GitHub issue",
  },
);
assert.equal(
  deriveBoardCardProvenance(
    card("local", "todo", { branchName: "card/local" }),
    true,
    false,
  )?.label,
  "Local only",
);
assert.equal(
  deriveBoardCardProvenance(
    card("branch", "todo", { branchName: "card/branch" }),
    false,
    false,
  )?.label,
  "card/branch",
);
assert.equal(
  deriveBoardCardProvenance(card("none", "todo"), false, false),
  null,
);

// UX-5.3: a drag reorders within its column and archives; nothing else.
// Archive never pulls work out from under a run, a live or paused swarm, or a
// queue slot.
for (const [name, guardedCard, swarmStatus] of [
  [
    "running",
    card("running", "in_progress", { lastRunStatus: "running" }),
    null,
  ],
  [
    "live swarm",
    card("live-swarm", "in_progress", { linkedSwarmId: "swarm-live" }),
    "running",
  ],
  [
    "suspended swarm",
    card("paused-swarm", "in_progress", {
      linkedSwarmId: "swarm-paused",
    }),
    "suspended",
  ],
  [
    "derived queue",
    card("queued-card", "in_progress", { swarmTemplateId: "feature" }),
    null,
  ],
  [
    "swarm after a failed run (Needs you by precedence)",
    card("rerun", "in_progress", { lastRunStatus: "failed", linkedSwarmId: "s" }),
    "running",
  ],
] as const) {
  assert.deepEqual(
    deriveBoardDropDecision(guardedCard, swarmStatus, { kind: "archive" }, []),
    { kind: "refused", message: BOARD_ARCHIVE_BLOCKED_COPY },
    name,
  );
  // QoL 1.168 S1-3: Done never archives, running or not.
  const done = deriveBoardDropDecision(guardedCard, swarmStatus, { kind: "column", column: "done", index: 0 }, []);
  assert.equal(done.kind, "refused", name);
  assert.match((done as { message: string }).message, /^Done fills when a card ships\./, name);
}

// F6 (SL-4 walk): a card whose setup runs is refused at once, with the
// backend's own words, never archived and put back after the Undo.
{
  const settingUp = card("setting-up", "in_progress", {
    notes: "Do it",
    worktreePath: "/w",
    worktreeSetup: { state: "running", command: "sleep 600", at: 1 },
  });
  assert.ok(cardSetupRunning(settingUp));
  assert.deepEqual(deriveBoardDropDecision(settingUp, null, { kind: "archive" }, []), {
    kind: "refused",
    message: BOARD_ARCHIVE_SETUP_COPY,
  });
  assert.ok(!cardSetupRunning({ ...settingUp, worktreeSetup: { state: "failed", at: 1 } }));
  const commands = readFileSync(new URL("../../src-tauri/src/commands.rs", import.meta.url), "utf8");
  assert.ok(commands.includes(JSON.stringify(BOARD_ARCHIVE_SETUP_COPY)), "the same words as SETUP_BUSY_ARCHIVE");
}

// Across columns is refused: the column follows the state, so a drag can
// never be the gesture that starts (Needs you → Working), queues or ships.
const draft = card("draft", "todo");
for (const column of ["needs-you", "working", "waiting"] as const) {
  assert.deepEqual(
    deriveBoardDropDecision(draft, null, { kind: "column", column, index: 0 }, []),
    { kind: "refused", message: BOARD_COLUMN_FOLLOWS_STATE_COPY },
  );
}
// 1.173.0 (F1, BI-16): a drag lights only where the card may land — its own
// column (to reorder) and the Archived row unless work owns the card. Every
// other zone is refused by the same decision, so it never lights.
{
  assert.deepEqual(legalDropZones(draft, null, [draft], "not-started"), { columns: ["not-started"], archive: true });
  const running = card("busy", "in_progress", { lastRunStatus: "running", linkedSwarmId: "s" });
  assert.deepEqual(legalDropZones(running, "running", [running], "working"), { columns: ["working"], archive: false });
  const shipped = card("old", "complete", { shipStatus: "shipped" });
  assert.deepEqual(legalDropZones(shipped, null, [shipped], "done").columns, ["done"]);
  for (const c of [draft, running]) {
    const from = c === draft ? "not-started" : "working";
    const zones = legalDropZones(c, c === running ? "running" : null, [c], from);
    for (const column of ["needs-you", "not-started", "working", "waiting", "done"] as const) {
      const d = deriveBoardDropDecision(c, c === running ? "running" : null, { kind: "column", column, index: 0 }, [], [c], from);
      assert.equal(zones.columns.includes(column), d.kind !== "refused", `${c.id} → ${column}`);
    }
  }
}

// QoL 1.168 S1-3: a ready card dropped on Done is neither shipped nor
// archived — Done fills when a card ships; the Archived row archives.
const readyToShip = card("ready", "complete", {
  lastRunStatus: "success",
  verifyStatus: "passed",
  shipStatus: "unshipped",
});
assert.deepEqual(
  deriveBoardDropDecision(readyToShip, null, { kind: "column", column: "done", index: 0 }, []),
  { kind: "refused", message: "Done fills when a card ships. Open it to ship it." },
);
assert.deepEqual(
  deriveBoardDropDecision(readyToShip, null, { kind: "archive" }, []),
  { kind: "archive", cardId: "ready" },
);
// A card not finished yet is told to finish it first.
assert.deepEqual(
  deriveBoardDropDecision(draft, null, { kind: "column", column: "done", index: 0 }, []),
  { kind: "refused", message: "Done fills when a card ships. Finish it first, then ship it." },
);
assert.deepEqual(
  deriveBoardDropDecision(draft, null, { kind: "archive" }, []),
  { kind: "archive", cardId: "draft" },
);
// A shipped card on the archive row is archived; within Done it stays put.
const shippedCard = card("shipped", "complete", { shipStatus: "shipped" });
assert.deepEqual(
  deriveBoardDropDecision(shippedCard, null, { kind: "archive" }, []),
  { kind: "archive", cardId: "shipped" },
);
assert.deepEqual(
  deriveBoardDropDecision(shippedCard, null, { kind: "column", column: "done", index: 0 }, [shippedCard]),
  { kind: "noop" },
);

// Within a column: one card gets a key between its new neighbours.
const a = card("a", "todo", { createdAt: 100 });
const b = card("b", "todo", { createdAt: 200 });
const c = card("c", "todo", { createdAt: 300, boardOrder: 250 });
const column = [a, b, c];
assert.equal(reorderKey(c, column, 0), 100 - 1000);
assert.equal(reorderKey(a, column, 3), 250 + 1000);
assert.equal(reorderKey(a, column, 2), (200 + 250) / 2);
// Released where it already is (before or just after itself): no write.
assert.equal(reorderKey(b, column, 1), null);
assert.equal(reorderKey(b, column, 2), null);
assert.deepEqual(
  deriveBoardDropDecision(c, null, { kind: "column", column: "not-started", index: 1 }, column),
  { kind: "reorder", cardId: "c", boardOrder: 150 },
);
assert.deepEqual(
  deriveBoardDropDecision(b, null, { kind: "column", column: "not-started", index: 1 }, column),
  { kind: "noop" },
);
// The order the Board draws follows the key.
assert.deepEqual(
  deriveAttentionGroups([a, b, { ...c, boardOrder: 150 }], () => null)["not-started"].map((x) => x.id),
  ["a", "c", "b"],
);

// Every outcome is one of the four: none of them is a move of the persisted
// column, a start or a ship. The drag handler maps them to setBoardOrder and
// archiveCard only (the behavioural test boardDrag.test.tsx watches the IPC).
const board = readFileSync(new URL("../components/KanbanBoard.tsx", import.meta.url), "utf8");
const dropStart = board.indexOf("function onDrop(e: DragEvent)");
const dropEnd = board.indexOf('document.addEventListener("dragenter"', dropStart);
assert.notEqual(dropStart, -1);
assert.notEqual(dropEnd, -1);
const dropSource = board.slice(dropStart, dropEnd);
// QoL 1.168 (block 10, C6): the drop, the keys and the card's menu share
// `decideBoardMove` (which is `deriveBoardDropDecision`) and
// `applyBoardDecision` (setBoardOrder or the archive, nothing else).
assert.match(dropSource, /decideBoardMove\(/);
assert.match(dropSource, /applyBoardDecision\(/);
assert.doesNotMatch(dropSource, /moveCard|cardShip|shipCard|card_ship|startBuild|advance/i);
const shared = board.slice(
  board.indexOf("function boardMoveContext("),
  board.indexOf("function focusBoardStep("),
);
assert.ok(shared.length > 0, "the shared move helpers are found");
assert.match(shared, /function decideBoardMove[\s\S]*deriveBoardDropDecision\(/);
assert.doesNotMatch(shared, /moveCard|cardShip|shipCard|card_ship|startBuild|advance/i);
assert.doesNotMatch(board, /moveCard\(/);

// UX-5.4: one fact beside the state word, never a branch.
const NOW = 10 * 60_000;
assert.equal(
  boardCardFact(
    card("b", "in_progress", {
      builder: { vendor: "claude", bypass: false, sessionLost: false, startedAt: NOW - 6 * 60_000, snapshots: [] },
      ghIssueNumber: 42,
      branchName: "atelier/card-b",
    }),
    "running",
    NOW,
  ),
  "6m",
);
assert.equal(
  boardCardFact(card("s", "complete", { shippedVersion: "1.150.0", ghIssueNumber: 7 }), "shipped", NOW),
  "v1.150.0",
);
// 1.173.0 (B4): an area's release says its own tag; an older entry (no tag)
// still reads v<version>.
const entry = (tag?: string) => ({ commitSha: "c", shippedVersion: "3.0.2", releaseKind: "local" as const, shippedAt: 1, ...(tag ? { tag } : {}) });
assert.equal(
  boardCardFact(card("t", "complete", { shippedVersion: "3.0.2", shipHistory: [entry("site-v3.0.2")] }), "shipped", NOW),
  "site-v3.0.2",
);
assert.equal(boardCardFact(card("t0", "complete", { shippedVersion: "3.0.2", shipHistory: [entry()] }), "shipped", NOW), "v3.0.2");
// 1.174.0 (DR4): a card merged with Ship it and carried by a release since
// says which release — "#382 · In site-v3.0.2"; before it, "#382".
{
  const merged = {
    reviewStatus: "merged" as const,
    shipStatus: "shipped" as const,
    prUrl: "https://github.com/o/r/pull/382",
    pr: { state: "merged", mergeCommit: "m" } as never,
    commitSha: "m",
  };
  const own = { commitSha: "m", shippedVersion: "", releaseKind: "push_only" as const, shippedAt: 1 };
  const rel = { commitSha: "r", shippedVersion: "3.0.2", releaseKind: "push_only" as const, shippedAt: 2, tag: "site-v3.0.2" };
  assert.equal(boardCardFact(card("m1", "complete", { ...merged, shipHistory: [own] }), "shipped", NOW), "#382");
  assert.equal(boardCardFact(card("m2", "complete", { ...merged, shipHistory: [own, rel] }), "shipped", NOW), "#382 · In site-v3.0.2");
}
// Skills hub H3a (Mac walk 2): a Land with no version files is "Shipped",
// never "Shipped · vunknown" — the card page's own rule.
assert.equal(boardCardFact(card("u", "complete", { shippedVersion: "unknown" }), "shipped", NOW), null);
assert.equal(boardCardFact(card("u7", "complete", { shippedVersion: "unknown", ghIssueNumber: 7 }), "shipped", NOW), "#7");
assert.equal(boardCardFact(card("i", "todo", { ghIssueNumber: 42 }), "draft", NOW), "#42");
assert.equal(
  boardCardFact(card("br", "in_progress", { branchName: "atelier/card-br" }), "ready", NOW),
  null,
);
assert.equal(shortDuration(59 * 60_000), "59m");
assert.equal(shortDuration(3 * 3_600_000), "3h");
assert.equal(shortDuration(72 * 3_600_000), "3d");
// Every chip state draws a dot; only the working ones pulse.
for (const state of CARD_STATES) {
  const run = boardRunState(state);
  assert.equal(run.live, EXPECTED_COLUMN[state] === "working", state);
}

// UX-5.8: the auto-archive — landed more than 14 days ago, never archived,
// no worktree; nothing on a read-only Board.
{
  const now = 100 * AUTO_ARCHIVE_AFTER_MS;
  const shippedAt = (id: string, at: number, patch: Partial<KanbanCard> = {}) =>
    card(id, "complete", {
      shipStatus: "shipped",
      shipHistory: [{ commitSha: "a", shippedVersion: "v1", releaseKind: "local", shippedAt: at }],
      ...patch,
    });
  const board = [
    shippedAt("old", now - AUTO_ARCHIVE_AFTER_MS - 1),
    shippedAt("edge", now - AUTO_ARCHIVE_AFTER_MS),
    shippedAt("restored", 1, { archivedAt: 5 }),
    shippedAt("tree", 1, { worktreePath: "/wt" }),
    shippedAt("gone", 1, { archived: true }),
    card("merged", "complete", { reviewStatus: "merged", updatedAt: 1 }),
    card("unshipped", "complete", { lastRunStatus: "success", updatedAt: 1 }),
  ];
  assert.deepEqual(autoArchiveCandidates(board, now, { readOnly: false }), ["old", "merged"]);
  assert.deepEqual(autoArchiveCandidates(board, now, { readOnly: true }), []);
  assert.ok(cardRestorable({ archived: true, autoArchived: true }));
  assert.ok(cardRestorable({ archived: true, shipStatus: "shipped" }));
  // QoL 1.168 S1-3: every archived card comes back.
  assert.ok(cardRestorable({ archived: true }));
  assert.ok(!cardRestorable({ archived: false, autoArchived: true }));
  assert.match(restoreTitle({}), /brief, plan and branch/);
  assert.equal(restoreTitle({ shipStatus: "shipped" }), "Put it back in Done");
  assert.match(restoredWords({ title: "A" }, { worktreePath: "/w" }).body, /back with its copy/);
}

// GH #242: Ship N, Ship selected and Ship batch take only cards that can
// ship — never a card landed as a merged pull request, nor one whose work
// has nowhere to ship from. Mirrors ship.rs::passes_pending_ship_metadata.
{
  const verified = (id: string, patch: Partial<KanbanCard> = {}) =>
    card(id, "complete", { verifyStatus: "passed", shipStatus: "unshipped", ...patch });
  const later = 1_778_284_800_001;
  assert.ok(isShipBatchEligible(verified("legacy")), "a pre-worktree card ships from the checkout");
  assert.ok(isShipBatchEligible(verified("wt", { createdAt: later, worktreePath: "/wt" })));
  assert.ok(isShipBatchEligible(verified("skipped", { verifyStatus: "skipped", worktreePath: "/wt" })));
  assert.ok(
    !isShipBatchEligible(
      verified("merged", { reviewStatus: "merged", prUrl: "https://github.com/o/r/pull/9", createdAt: later }),
    ),
    "a merged pull request has landed",
  );
  assert.ok(!isShipBatchEligible(verified("merged-wt", { reviewStatus: "merged", worktreePath: "/wt" })));
  // GH #196: a non-Builder card whose handle was cleared still ships the bump.
  assert.ok(isShipBatchEligible(verified("cleared", { createdAt: later })));
  assert.ok(
    !isShipBatchEligible(
      verified("builder", { builder: { vendor: "claude" } as KanbanCard["builder"] }),
    ),
    "a Builder card without its worktree cannot ship",
  );
  assert.ok(!isShipBatchEligible(verified("shipped", { shipStatus: "shipped", worktreePath: "/wt" })));
  assert.ok(!isShipBatchEligible(verified("failed", { verifyStatus: "failed", worktreePath: "/wt" })));
  assert.ok(!isShipBatchEligible(verified("archived", { archived: true, worktreePath: "/wt" })));
  assert.ok(!isShipBatchEligible({ ...verified("todo", { worktreePath: "/wt" }), columnId: "todo" }));
}

// 1.171.0 F1 (K1): an approved Builder card in In progress with its session
// closed is in the batch; the rest are left out with why (`ship.rs`'s words).
{
  type Review = NonNullable<NonNullable<KanbanCard["builder"]>["review"]>;
  const review = (patch: Partial<Review> = {}): Review =>
    ({ snapshotN: 2, provider: "claude", degraded: false, status: "done", verdict: "approve", reviewedRevision: "b", at: 1, ...patch }) as Review;
  const b = (patch: Partial<NonNullable<KanbanCard["builder"]>> = {}) =>
    ({
      vendor: "claude",
      bypass: false,
      ptyId: null,
      sessionLost: false,
      startedAt: 1,
      snapshots: [
        { n: 1, sha: "a", at: 1 },
        { n: 2, sha: "b", at: 2 },
      ],
      review: review(),
      ...patch,
    }) as KanbanCard["builder"];
  const built = (id: string, builder: KanbanCard["builder"], patch: Partial<KanbanCard> = {}) =>
    card(id, "in_progress", { verifyStatus: "passed", shipStatus: "unshipped", worktreePath: "/wt", builder, ...patch });

  const ready = built("ready", b());
  assert.equal(batchBuilderRefusal(ready), null);
  assert.ok(isShipBatchEligible(ready), "approved, session closed: in the batch");
  assert.equal(shipBatchLeftOut(ready), null);
  // Owner 2026-10-27 (C3): a skipped review counts as unreviewed, so it stays out of a batch.
  assert.ok(!isShipBatchEligible(built("skip", b({ review: review({ status: "skipped", verdict: null }) }))), "a skipped review is unreviewed");

  const cases: Array<[string, KanbanCard, string]> = [
    ["open", built("open", b({ ptyId: "pty-1" })), BATCH_SESSION_OPEN],
    ["old round", built("old", b({ review: review({ snapshotN: 1, reviewedRevision: "a" }) })), BATCH_NOT_APPROVED],
    ["changes", built("changes", b({ review: review({ verdict: "changes_requested" }) })), BATCH_NOT_APPROVED],
    ["incomplete", built("inc", b({ review: review({ verdict: "incomplete" }) })), BATCH_NOT_APPROVED],
    ["running", built("run", b({ review: review({ status: "running", verdict: null }) })), BATCH_NOT_APPROVED],
    ["failed passes", built("fp", b({ review: review({ failedPasses: 1 }) })), BATCH_NOT_APPROVED],
    ["no review", built("none", b({ review: null })), BATCH_NOT_APPROVED],
    ["moved", built("moved", b({ review: review({ reviewedRevision: "x" }) })), BATCH_NOT_APPROVED],
    [
      "handed over",
      built("ho", b({ handedOver: { snapshotN: 2, findingIds: [], handoff: "", at: 1 } as never })),
      BATCH_NOT_APPROVED,
    ],
    ["both", built("both", b(), { buildBoth: { lanes: [], outcome: null } as never }), BATCH_BOTH_UNDECIDED],
  ];
  for (const [name, c, why] of cases) {
    assert.ok(!isShipBatchEligible(c), name);
    assert.equal(shipBatchLeftOut(c), why, name);
  }
  // Not saved: never near shipping, so not named — and not in the batch.
  const unsaved = built("unsaved", b({ snapshots: [] }));
  assert.equal(batchBuilderRefusal(unsaved), BATCH_NOT_SAVED);
  assert.ok(!isShipBatchEligible(unsaved));
  assert.equal(shipBatchLeftOut(unsaved), null);
  // Nowhere near shipping: not named.
  assert.equal(shipBatchLeftOut(built("checks", b({ ptyId: "p" }), { verifyStatus: "failed" })), null);
  assert.equal(shipBatchLeftOut(built("shipped", b({ ptyId: "p" }), { shipStatus: "shipped" })), null);
  assert.ok(!isShipBatchEligible(built("gone", b(), { worktreePath: null as never })));
  // A card without a Builder still needs Complete.
  assert.ok(!isShipBatchEligible(card("plain", "in_progress", { verifyStatus: "passed", shipStatus: "unshipped" })));
}

// 1.171.0 F1 (Challenger 2): the batch's words are the backend's, verbatim
// (`ship.rs::batch_builder_refusal`, `build_both::UNDECIDED_REFUSAL`).
{
  const ship = readFileSync("src-tauri/src/ship.rs", "utf8");
  const both = readFileSync("src-tauri/src/build_both.rs", "utf8");
  for (const [name, words] of [
    ["BATCH_SESSION_OPEN", BATCH_SESSION_OPEN],
    ["BATCH_NOT_SAVED", BATCH_NOT_SAVED],
    ["BATCH_NOT_APPROVED", BATCH_NOT_APPROVED],
  ] as const) {
    assert.ok(ship.includes(`pub(crate) const ${name}: &str =\n    ${JSON.stringify(words)};`), `${name} drifted from ship.rs`);
  }
  assert.ok(
    both.includes(`pub const UNDECIDED_REFUSAL: &str =\n    ${JSON.stringify(BATCH_BOTH_UNDECIDED)};`),
    "BATCH_BOTH_UNDECIDED drifted from build_both.rs",
  );
  // Said only by the sheet (the backend's list has no words), but plain.
  assert.ok(BATCH_COPY_CHANGED.endsWith("Press Finish and check on its page."));
}

// GH #243: a card GitHub sync pulled to Complete because its issue was
// closed — notes, no run, not landed — is Done as "Closed", never "Ready
// to start" in Needs you.
{
  const closedIssue = card("gh-44", "complete", { notes: "A brief", ghIssueNumber: 44 });
  assert.equal(deriveAttentionColumn(closedIssue, null), "done");
  const chip = deriveBoardCardState(closedIssue, null);
  assert.equal(chip.state, "closed");
  assert.equal(chip.label, "Closed");
  assert.deepEqual(boardRunState(chip.state), { state: "empty", live: false });
  // The same card in To do is still work to start.
  assert.equal(deriveAttentionColumn({ ...closedIssue, columnId: "todo" }, null), "not-started");
  // A verified card in Complete keeps its state (it may still ship), a
  // card that ran keeps its result, and a merged one is Shipped.
  assert.notEqual(deriveBoardCardState({ ...closedIssue, verifyStatus: "passed" }, null).state, "closed");
  assert.equal(deriveBoardCardState({ ...closedIssue, lastRunStatus: "failed" }, null).state, "failed");
  assert.equal(deriveBoardCardState({ ...closedIssue, reviewStatus: "merged" }, null).state, "shipped");
}

// GH #244: a Builder run whose session is closed or lost is not Working —
// the Board says so, with no live dot, in Needs you.
{
  const builder = { vendor: "claude", bypass: false, sessionLost: false, startedAt: 1, snapshots: [] } as NonNullable<KanbanCard["builder"]>;
  const closed = card("b", "in_progress", { lastRunStatus: "running", builder: { ...builder, ptyId: null } });
  const chip = deriveBoardCardState(closed, null);
  assert.equal(chip.state, "session-closed");
  assert.equal(chip.label, "Session closed");
  assert.deepEqual(boardRunState(chip.state), { state: "empty", live: false });
  assert.equal(deriveAttentionColumn(closed, null), "needs-you");
  const lost = { ...closed, builder: { ...builder, ptyId: null, sessionLost: true } };
  assert.equal(deriveBoardCardState(lost, null).label, "Session closed");
  const open = { ...closed, builder: { ...builder, ptyId: "pty-1" } };
  assert.equal(deriveBoardCardState(open, null).state, "running");
  assert.equal(deriveAttentionColumn(open, null), "working");
}

// GH #257: the dot is true — "Preparing the result" is in flight on the
// card page, "Nothing changed" needs a look; on the Board a collapsed
// "Result ready" is still finished.
assert.deepEqual(cardRunState("result-ready"), { state: "running", live: true });
assert.deepEqual(boardRunState("result-ready"), { state: "done", live: false });
assert.notEqual(boardRunState("no-changes").state, "done");
assert.notEqual(cardRunState("no-changes").state, "done");
assert.deepEqual(cardRunState("ready-to-ship"), boardRunState("ready-to-ship"));

// GH #299: a pull request merged without a Ply release is "Merged · #29";
// "Shipped · v1.149.0" is a release.
{
  const merged = card("m", "complete", {
    reviewStatus: "merged",
    prUrl: "https://github.com/o/r/pull/29",
    ghIssueNumber: 94,
  });
  const chip = deriveBoardCardState(merged, null);
  assert.equal(chip.state, "shipped");
  // 1.171.0 B1 (Challenger 5): never read back — it opened on GitHub.
  assert.equal(chip.label, "On GitHub · pull request opened");
  assert.equal(boardCardFact(merged, chip.state, 0), "#29");
  const released = card("s", "complete", { shipStatus: "shipped", shippedVersion: "1.149.0", reviewStatus: "merged" });
  assert.equal(deriveBoardCardState(released, null).label, "Shipped");
  assert.equal(boardCardFact(released, "shipped", 0), "v1.149.0");
  // No PR URL on record: the issue, as before.
  assert.equal(boardCardFact({ ...merged, prUrl: null }, "shipped", 0), "#94");
}

// F3/F5 (SL-4 walk): a card whose setup runs, failed or waits for this
// Mac's OK says so on the Board, not "Ready to start".
{
  const base = { notes: "Do it", worktreePath: "/w", branchName: "b" } as Partial<KanbanCard>;
  const running = deriveBoardCardState(
    card("s1", "in_progress", { ...base, worktreeSetup: { state: "running", command: "npm ci", at: 1 } }),
    null,
  );
  assert.equal(running.label, "Setting up the card");
  assert.equal(running.state, "ready");
  assert.deepEqual(boardChipRunState(running), { state: "running", live: true });
  const failed = deriveBoardCardState(
    card("s2", "in_progress", { ...base, worktreeSetup: { state: "failed", reason: "The setup command failed (exit code 1).", at: 1 } }),
    null,
  );
  assert.equal(failed.label, "Setup failed");
  assert.equal(failed.tone, "accent");
  assert.deepEqual(boardChipRunState(failed), { state: "aborted", live: false });
  const approval = deriveBoardCardState(
    card("s3", "in_progress", { ...base, worktreeSetup: { state: "failed", approvalNeeded: true, at: 1 } }),
    null,
  );
  assert.equal(approval.label, "Setup needs your OK");
  // Done or started anyway: the card's own state again.
  const done = deriveBoardCardState(card("s4", "in_progress", { ...base, worktreeSetup: { state: "done", at: 1 } }), null);
  assert.equal(done.label, "Ready to start");
  assert.equal(done.setup, undefined);
  assert.deepEqual(boardChipRunState(done), boardRunState("ready"));
  // A card back in draft reads as a draft, whatever old record it keeps.
  const draftCard = deriveBoardCardState(
    card("s5", "todo", { worktreeSetup: { state: "failed", reason: "Old.", at: 1 } }),
    null,
  );
  assert.equal(draftCard.state, "draft");
  assert.notEqual(draftCard.label, "Setup failed");
  assert.equal(draftCard.setup, undefined);
}

// SP-7: a finished card ready to ship says "Ready to ship" on the Board, as
// its page does; one still to be read keeps "Result ready". Never one whose
// runs all changed no file (round 4); SP-D: whatever the Ship batch takes.
{
  const verified = card("v", "complete", { lastRunStatus: "success", verifyStatus: "passed", shipStatus: "unshipped" });
  assert.equal(readyToShipForStage(verified), true);
  assert.equal(isShipBatchEligible(verified), true);
  assert.equal(boardSaysReadyToShip(verified), true);
  assert.deepEqual(deriveBoardCardState(verified, null), {
    state: "result-ready",
    label: "Ready to ship",
    tone: "accent",
    blocked: null,
  });
  // Checks not passed: Result ready.
  const unchecked = card("u", "complete", { lastRunStatus: "success" });
  assert.equal(deriveBoardCardState(unchecked, null).label, "Result ready");
  // SP-D: a Builder card in In progress approved on its latest snapshot is
  // ready to ship, as its page says: the Board says Ready to ship. 1.171.0
  // F1: with its session closed the Ship batch takes it too; open, it doesn't.
  const builder = {
    vendor: "claude" as const,
    bypass: false,
    ptyId: null,
    sessionLost: false,
    startedAt: 1,
    snapshots: [{ n: 1, sha: "a", at: 2 }, { n: 2, sha: "b", at: 3 }],
    review: { snapshotN: 2, provider: "codex" as const, degraded: false, status: "done" as const, verdict: "approve" as const, at: 4 },
  };
  const approved = card("b", "in_progress", { lastRunStatus: "success", verifyStatus: "passed", worktreePath: "/w/b", builder });
  assert.equal(readyToShipForStage(approved), true);
  assert.equal(isShipBatchEligible(approved), true);
  assert.equal(isShipBatchEligible({ ...approved, builder: { ...builder, ptyId: "pty-1" } } as KanbanCard), false);
  // 1.170 walk fix (D1): Release… is offered for it — the only way to G8's
  // release through a pull request, Only on this Mac having shipped it.
  assert.equal(releaseOffered(approved), true);
  assert.equal(releaseOffered(verified), true);
  assert.equal(releaseOffered({ ...approved, shipStatus: "shipped", reviewStatus: "merged" } as KanbanCard), false);
  assert.equal(releaseOffered({ ...approved, archived: true } as KanbanCard), false);
  assert.equal(releaseOffered({ ...approved, verifyStatus: "failed" } as KanbanCard), false);
  assert.equal(releaseOffered({ ...approved, prUrl: "u", pr: { state: "open" } } as unknown as KanbanCard), false);
  // As before: a card in Done not shipped keeps it, whatever its checks.
  assert.equal(releaseOffered(card("d", "complete", { lastRunStatus: "success" })), true);
  assert.equal(releaseOffered(card("l", "complete", { verifyStatus: "legacy" })), false);
  assert.equal(boardSaysReadyToShip(approved), true);
  assert.equal(deriveBoardCardState(approved, null).label, "Ready to ship");
  // Approved on an earlier snapshot only: not Ready to ship.
  const stale = { ...approved, builder: { ...builder, review: { ...builder.review, snapshotN: 1 } } } as KanbanCard;
  assert.equal(boardSaysReadyToShip(stale), false);
  assert.notEqual(deriveBoardCardState(stale, null).label, "Ready to ship");
  // SP-D: its Builder session still open — it can commit past the approved
  // snapshot, so the Board reads the live tip as the page does.
  const live = { ...approved, builder: { ...builder, ptyId: "pty-1" } } as KanbanCard;
  assert.equal(readyToShipForStage(live), true);
  // The tip still loading (or unreadable): Result ready.
  assert.equal(boardSaysReadyToShip(live), false);
  assert.equal(boardSaysReadyToShip(live, { branchTip: null }), false);
  assert.equal(deriveBoardCardState(live, null).label, "Result ready");
  // The tip is the reviewed snapshot: Ready to ship, on the Board as on the page.
  const atReview = { branchTip: "b", commitsSinceReview: 0 };
  assert.equal(boardSaysReadyToShip(live, atReview), true);
  assert.equal(deriveBoardCardState(live, null, [], "claude", false, atReview).label, "Ready to ship");
  assert.equal(boardSaysReadyToShip({ ...live, columnId: "complete" }, atReview), true);
  // The tip moved past the review: not ready, and the chip says why.
  const moved = { branchTip: "c", commitsSinceReview: 2 };
  assert.equal(boardSaysReadyToShip(live, moved), false);
  assert.equal(deriveBoardCardState(live, null, [], "claude", false, moved).label, "2 commits since the last review");
  // Only commits past the review demote it: a review whose passes failed
  // keeps the page's behaviour — Ready to ship underneath, its chip saying
  // the last commit was not reviewed.
  const failedPasses = {
    ...live,
    builder: { ...live.builder!, review: { ...builder.review, failedPasses: 1, passCount: 3 } },
  } as KanbanCard;
  assert.equal(boardSaysReadyToShip(failedPasses, atReview), true);
  assert.equal(
    deriveBoardCardState(failedPasses, null, [], "claude", false, atReview).label,
    "The last commit was not reviewed",
  );
  assert.equal(deriveBoardStage(failedPasses, null, atReview), "ready-to-ship");
  assert.equal(deriveBoardStage(live, null, atReview), "ready-to-ship");
  assert.notEqual(deriveBoardStage(live, null, moved), "ready-to-ship");
  assert.notEqual(deriveBoardStage(live, null), "ready-to-ship");
  // A merge that hit a git conflict: never Ready to ship.
  assert.equal(boardSaysReadyToShip({ ...approved, reviewStatus: "conflict_blocked" }), false);
  assert.equal(boardSaysReadyToShip({ ...verified, reviewStatus: "conflict_blocked" }), false);
  assert.notEqual(deriveBoardCardState({ ...verified, reviewStatus: "conflict_blocked" }, null).label, "Ready to ship");
  // The same card in Complete: Ready to ship.
  assert.equal(deriveBoardCardState({ ...approved, columnId: "complete" }, null).label, "Ready to ship");
  // Round 4: a run's count is per run. Files changed, then a re-run that
  // edited nothing: still eligible, still Ready to ship.
  const run = (filesChangedCount: number, endedAt: number): RunHistoryEntry => ({
    runId: `r${endedAt}`,
    status: "done",
    endedAt,
    filesChangedCount,
    topPaths: [],
    swarmCollisions: 0,
  });
  const rerun = { ...verified, runHistory: [run(3, 5), run(0, 6)] } as KanbanCard;
  assert.equal(isShipBatchEligible(rerun), true);
  assert.equal(deriveBoardCardState(rerun, null).label, "Ready to ship");
  // Every run changed nothing and no snapshot: eligibility is the backend's
  // (git) — unchanged here — but the chip says Result ready.
  const empty = { ...verified, runHistory: [run(0, 5), run(0, 6)] } as KanbanCard;
  assert.equal(isShipBatchEligible(empty), true);
  assert.equal(boardSaysReadyToShip(empty), false);
  assert.equal(deriveBoardCardState(empty, null).label, "Result ready");
  // A Builder snapshot is work, whatever the runs say.
  const built = {
    ...empty,
    worktreePath: "/w/e",
    builder: { vendor: "claude", bypass: false, ptyId: null, sessionLost: false, startedAt: 6, snapshots: [{ n: 1, sha: "a", at: 7 }] },
  } as KanbanCard;
  assert.equal(boardSaysReadyToShip(built), true);
  // The List's stage keeps its own rule (CL-10).
  assert.equal(deriveBoardStage(verified, null), "ready-to-ship");
}

// N14 (item 5): a card a teammate claimed on GitHub, which nobody started
// here, is On hold (id `waiting`) — out of Not started. Its own run here, a
// state past "not started", or my own claim keep their column.
{
  const QUIET = { changesRequested: false, failed: false };
  assert.equal(attentionColumnFor("ready", { ...QUIET, claimedByOthers: true }), "waiting");
  assert.equal(attentionColumnFor("draft", { ...QUIET, claimedByOthers: true }), "waiting");
  assert.equal(attentionColumnFor("ready", QUIET), "not-started");
  for (const state of ["failed", "result-ready", "running", "shipped", "closed"] as const) {
    assert.equal(
      attentionColumnFor(state, { ...QUIET, failed: state === "failed", claimedByOthers: true }),
      attentionColumnFor(state, { ...QUIET, failed: state === "failed" }),
      `${state} keeps its column`,
    );
  }

  const me = "test-owner";
  const theirs = card("gh-issue-21", "in_progress", {
    ghIssueNumber: 21,
    notes: "the brief",
    ghAssignees: ["test-user"],
  });
  const mine = { ...theirs, id: "gh-issue-22", ghIssueNumber: 22, ghAssignees: [me] };
  const unclaimed = { ...theirs, id: "gh-issue-23", ghIssueNumber: 23, ghAssignees: [] };
  const ranHere = { ...theirs, id: "gh-issue-24", ghIssueNumber: 24, runHistory: [{} as RunHistoryEntry] };
  const board = [theirs, mine, unclaimed, ranHere];
  const claimed = (c: KanbanCard) => claimedByOthersHere(c, me);
  assert.equal(deriveAttentionColumn(theirs, null, board, false, claimed(theirs)), "waiting");
  const groups = deriveAttentionGroups(board, () => null, board, () => false, claimed);
  assert.deepEqual(groups.waiting.map((c) => c.id), ["gh-issue-21"]);
  assert.equal(groups["not-started"].some((c) => c.id === "gh-issue-21"), false);
  assert.deepEqual(
    groups["not-started"].map((c) => c.id).filter((id) => id !== "gh-issue-24"),
    ["gh-issue-22", "gh-issue-23"],
  );
  // The login unknown: no guess, the card stays where its state puts it.
  const unknown = deriveAttentionGroups(board, () => null, board, () => false, (c) => claimedByOthersHere(c, null));
  assert.equal(unknown["not-started"].some((c) => c.id === "gh-issue-21"), true);
}

// 1.169.1 (R1, walk R3 step A4): a pull request ready to merge is in Needs
// you — its Merge is the person's; On hold while checks run, GitHub merges
// it on its own or a review GitHub requires is missing.
{
  const prCard = (pr: Partial<NonNullable<KanbanCard["pr"]>>) =>
    card("pr", "in_progress", {
      lastRunStatus: "success",
      reviewStatus: "merged",
      prUrl: "https://github.com/o/r/pull/108",
      pr: {
        number: 108,
        state: "open",
        checks: "passing",
        checksTotal: 1,
        checksPassed: 1,
        checksPending: 0,
        failingChecks: [],
        mergeable: "mergeable",
        reviewDecision: "none",
        checkedAt: 1,
        ...pr,
      },
    });
  const ready = prCard({});
  assert.equal(deriveAttentionColumn(ready, null), "needs-you");
  assert.deepEqual(
    deriveAttentionGroups([ready], () => null)["needs-you"].map((c) => c.id),
    ["pr"],
    "the ready card's lane is Needs you",
  );
  assert.equal(deriveBoardCardState(ready, null).label, "Ready to merge");
  assert.equal(deriveAttentionColumn(prCard({ checks: "none", checksTotal: 0, checksPassed: 0 }), null), "needs-you", "no checks on GitHub");
  // Owner (m8): a review GitHub requires is On hold.
  const review = prCard({ reviewDecision: "review_required", mergeState: "blocked" });
  assert.equal(deriveAttentionColumn(review, null), "waiting");
  assert.equal(deriveBoardCardState(review, null).label, "Waiting for a review on GitHub");
  assert.equal(deriveAttentionColumn(prCard({ mergeState: "behind" }), null), "waiting");
  // 1.171.0 B1 (owner D6): merging by itself, or its checks running, is
  // Working; Plyloft's own merge owed since a launch is On hold.
  assert.equal(deriveAttentionColumn(prCard({ autoMerge: true }), null), "working");
  assert.equal(deriveAttentionColumn(prCard({ checks: "pending", checksPassed: 0, checksPending: 1 }), null), "working");
  assert.equal(deriveAttentionColumn(prCard({ plyloftAutoMerge: true, checks: "pending", checksPassed: 0, checksPending: 1 }), null), "working");
}

// 1.171.0 E3 (owner D5): Ship N shows for two or more cards, on every plan.
{
  assert.equal(shipBatchShown(0), false);
  assert.equal(shipBatchShown(1), false, "one card ships with its own Ship it");
  assert.equal(shipBatchShown(2), true);
  assert.equal(shipBatchShown(5), true);
}

// 1.174.0 (C13, BCI-14): "Release 3 cards…", never a version-like "Release 3…".
assert.equal(shipBatchLabel(3), "Release 3 cards…");
assert.equal(shipBatchLabel(1), "Release 1 card…");
console.log("boardSemantics: all contracts passed");
