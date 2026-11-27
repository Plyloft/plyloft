// Tier 3 pure-function test. Run with Node 22+:
//   node --experimental-strip-types src/lib/boardList.test.ts
import assert from "node:assert/strict";
import type { CardPresentationState, KanbanCard } from "../ipc.ts";
import {
  BOARD_STAGES,
  STATE_STAGE,
  boardBuilder,
  boardChecksLabel,
  boardStageFor,
  sortBoardRows,
  sortStageRows,
  stageGroups,
  updatedLabel,
  type BoardStage,
} from "./boardList.ts";
import { CARD_STATES, CARD_STATE_PRESENTATION } from "./cardLifecycle.ts";
// P-A: the row and the stage are `presentCard`'s; these take the old
// positional facts.
import { boardListRowOf as boardListRow, deriveBoardStage } from "./cardPresentation.ts";
import { STATE_ATTENTION_COLUMN, type AttentionGroups } from "./boardSemantics.ts";

function card(id: string, patch: Partial<KanbanCard> = {}): KanbanCard {
  return { id, workspaceId: "ws", title: id, columnId: "todo", createdAt: 1, updatedAt: 1, ...patch };
}
const builder = (vendor: "claude" | "codex") => ({
  vendor,
  bypass: false,
  sessionLost: false,
  startedAt: 1,
  snapshots: [],
});

assert.equal(boardBuilder(card("a", { builder: builder("codex") })), "codex");
assert.equal(boardBuilder(card("a", { swarmTemplateId: "feature", linkedSwarmId: "sw-1" })), "swarm");
// G4: a template on a Todo card that never ran a swarm is no runner.
assert.equal(boardBuilder(card("a", { swarmTemplateId: "feature", columnId: "todo" })), "none");
assert.equal(boardBuilder(card("a", { agentConfigId: "x" })), "agent");
assert.equal(boardBuilder(card("a")), "none");
// 1.171.0 re-walk (step 4): no session yet — the AI its page shows.
assert.equal(boardBuilder(card("a"), "claude"), "claude");
assert.equal(boardBuilder(card("a"), "codex"), "codex");
assert.equal(boardBuilder(card("a", { builder: builder("codex") }), "claude"), "codex", "the session's own vendor wins");
assert.equal(boardBuilder(card("a", { agentConfigId: "x" }), "claude"), "agent");

assert.equal(boardChecksLabel(card("a", { verifyStatus: "failed" })), "Failed");
assert.equal(boardChecksLabel(card("a", { verifyStatus: "legacy" })), "—");
assert.equal(boardChecksLabel(card("a")), "—");
// GH #333: a pass with no checks set up is never "Passed".
assert.equal(
  boardChecksLabel(card("a", { verifyStatus: "passed", verifyHistory: [{ verifyRunId: "v", status: "passed", endedAt: 1, steps: [] }] })),
  "None set up",
);
assert.equal(
  boardChecksLabel(card("a", { verifyStatus: "passed", verifyHistory: [{ verifyRunId: "v", status: "passed", endedAt: 1, steps: [{ kind: "script", passed: true, elapsedMs: 1 }] }] })),
  "Passed",
);

assert.equal(updatedLabel(1_000, 30_000), "Just now");
assert.equal(updatedLabel(0, 6 * 60_000), "6m ago");

// GH #244: a running build has its session open.
const row = boardListRow(
  card("r", { lastRunStatus: "running", builder: { ...builder("claude"), ptyId: "pty-1" } }),
  null,
);
assert.equal(row.status, "Working");
assert.deepEqual(row.run, { state: "running", live: true });
assert.equal(row.builder, "claude");

const rows = [
  boardListRow(card("b", { title: "banana", updatedAt: 5 }), null),
  boardListRow(card("a", { title: "Apple", updatedAt: 9 }), null),
  boardListRow(card("c", { title: "cherry 10", updatedAt: 1 }), null),
  boardListRow(card("d", { title: "cherry 9", updatedAt: 1 }), null),
];
assert.deepEqual(sortBoardRows(rows, null).map((r) => r.id), ["b", "a", "c", "d"]);
assert.deepEqual(
  sortBoardRows(rows, { key: "title", dir: "asc" }).map((r) => r.id),
  ["a", "b", "d", "c"],
);
assert.deepEqual(
  sortBoardRows(rows, { key: "updated", dir: "desc" }).map((r) => r.id),
  ["a", "b", "c", "d"],
);
// The input is never reordered in place.
assert.deepEqual(rows.map((r) => r.id), ["b", "a", "c", "d"]);

// CL-9: the List grouped by stage. Every canonical state lands in exactly
// one stage (the archive in none), and this table is the decision record —
// by the label the person reads.
assert.deepEqual(Object.keys(STATE_STAGE).sort(), [...CARD_STATES].sort());
assert.deepEqual(
  BOARD_STAGES.map((s) => s.label),
  ["Ready to start", "Working", "In review", "Ready to ship", "Done"],
);
const EXPECTED_STAGE: Record<string, string[]> = {
  "Ready to start": ["Draft", "Planning with Claude", "Ready to start", "In line"],
  "Working": ["Working", "Session closed", "Paused", "Stopped"],
  "In review": [
    "Reviewing",
    "Reviewer requests changes",
    "Running checks",
    "Checks failed",
    "Preparing the result",
    "Review is out of date",
    "Nothing changed",
  ],
  "Ready to ship": ["Ready to ship", "Shipping"],
  Done: ["Shipped", "Closed"],
};
const seen = new Map<string, string>();
for (const state of CARD_STATES) {
  const stage = STATE_STAGE[state];
  if (stage === null) {
    assert.equal(state, "archived", `${state} has a stage`);
    continue;
  }
  const label = BOARD_STAGES.find((s) => s.id === stage)!.label;
  assert.ok(!seen.has(state), `${state} in two stages`);
  seen.set(state, label);
  assert.ok(
    EXPECTED_STAGE[label].includes(CARD_STATE_PRESENTATION[state].label),
    `${state} (${CARD_STATE_PRESENTATION[state].label}) is in ${label}`,
  );
}
assert.equal(seen.size, CARD_STATES.length - 1);
assert.equal(
  Object.values(EXPECTED_STAGE).flat().length,
  CARD_STATES.length - 1,
  "every label in the table is a state",
);
// Stages run in lifecycle order: no state's stage comes before the stage
// of a state it can only follow.
const order = (s: CardPresentationState) =>
  BOARD_STAGES.findIndex((b) => b.id === STATE_STAGE[s]);
assert.ok(order("draft") < order("running"));
assert.ok(order("running") < order("challenger-reviewing"));
assert.ok(order("checking") < order("ready-to-ship"));
assert.ok(order("shipping") < order("shipped"));

// The two facts that move a card on from its state's stage.
const quiet = { openPullRequest: false, shipEligible: false };
assert.equal(boardStageFor("shipped", { ...quiet, openPullRequest: true }), "ready-to-ship");
assert.equal(boardStageFor("shipped", quiet), "finished");
assert.equal(boardStageFor("result-ready", { ...quiet, shipEligible: true }), "ready-to-ship");
assert.equal(boardStageFor("result-ready", quiet), "in-review");
// Ship-eligible moves nothing else: a failed check is still in review.
assert.equal(boardStageFor("verify-failed", { ...quiet, shipEligible: true }), "in-review");
assert.equal(boardStageFor("archived", quiet), null);

// From the cards themselves.
const verified = card("v", {
  columnId: "complete",
  lastRunStatus: "success",
  verifyStatus: "passed",
  shipStatus: "unshipped",
});
assert.equal(deriveBoardStage(verified, null), "ready-to-ship");
assert.equal(deriveBoardStage(card("u", { columnId: "complete", lastRunStatus: "success" }), null), "in-review");
assert.equal(deriveBoardStage(card("d"), null), "to-do");
assert.equal(deriveBoardStage(card("s", { columnId: "complete", shipStatus: "shipped" }), null), "finished");
assert.equal(
  deriveBoardStage(
    card("pr", {
      columnId: "complete",
      shipStatus: "unshipped",
      reviewStatus: "merged",
      prUrl: "https://github.com/o/r/pull/7",
      pr: { number: 7, state: "open", checks: "passing", mergeable: "mergeable", reviewDecision: null, readAt: 1 } as never,
    }),
    null,
  ),
  "ready-to-ship",
);
// CL-10: a Builder (PTY) card never leaves In progress; approved on its
// latest snapshot with checks passed it is Ready to ship all the same.
const reviewed = (verdict: "approve" | "changes_requested", patch: Partial<KanbanCard> = {}) =>
  card("b-" + verdict, {
    columnId: "in_progress",
    lastRunStatus: "success",
    verifyStatus: "passed",
    shipStatus: "unshipped",
    worktreePath: "/tmp/wt",
    builder: {
      ...builder("claude"),
      snapshots: [{ n: 1, sha: "a", at: 2 }],
      review: { snapshotN: 1, provider: "codex", degraded: false, status: "done", verdict, at: 3 },
    } as never,
    ...patch,
  });
assert.equal(deriveBoardStage(reviewed("approve"), null), "ready-to-ship");
assert.equal(deriveBoardStage(reviewed("changes_requested"), null), "in-review");
// Not without passed checks, a worktree, or on a newer, unreviewed snapshot.
assert.equal(deriveBoardStage(reviewed("approve", { verifyStatus: undefined }), null), "in-review");
assert.equal(deriveBoardStage(reviewed("approve", { worktreePath: undefined }), null), "in-review");
assert.equal(
  deriveBoardStage(
    reviewed("approve", {
      builder: {
        ...builder("claude"),
        snapshots: [{ n: 1, sha: "a", at: 2 }, { n: 2, sha: "b", at: 4 }],
        review: { snapshotN: 1, provider: "codex", degraded: false, status: "done", verdict: "approve", at: 3 },
      } as never,
    }),
    null,
  ),
  "in-review",
);
// CL-10 round 2: an open pull request is not Ready to ship by this path;
// a landed card is Done.
assert.equal(
  deriveBoardStage(
    reviewed("approve", {
      prUrl: "https://github.com/o/r/pull/9",
      pr: { number: 9, state: "open", checks: "passing", mergeable: "mergeable", reviewDecision: null, readAt: 1 } as never,
    }),
    null,
  ),
  "in-review",
);
assert.equal(deriveBoardStage(reviewed("approve", { shipStatus: "shipped" }), null), "finished");
// SP-D: the stage follows the Board's chip — a live Builder session (it can
// still commit), a merge conflict, or runs that changed nothing keep it in
// review.
assert.equal(
  deriveBoardStage(
    reviewed("approve", {
      builder: {
        ...builder("claude"),
        ptyId: "pty-1",
        snapshots: [{ n: 1, sha: "a", at: 2 }],
        review: { snapshotN: 1, provider: "codex", degraded: false, status: "done", verdict: "approve", at: 3 },
      } as never,
    }),
    null,
  ),
  "in-review",
);
assert.equal(deriveBoardStage({ ...verified, reviewStatus: "conflict_blocked" }, null), "in-review");
assert.equal(
  deriveBoardStage(
    { ...verified, runHistory: [{ runId: "r", status: "done", endedAt: 1, filesChangedCount: 0, topPaths: [], swarmCollisions: 0 }] } as KanbanCard,
    null,
  ),
  "in-review",
);
assert.equal(deriveBoardStage(card("swarm"), "running"), "in-progress");
assert.equal(deriveBoardStage(card("a", { archived: true }), null), null);

// Regrouped: every card in exactly one stage; within a stage what needs
// the person leads, each column in the Board's own order.
const groups: AttentionGroups = {
  "needs-you": [card("n2", { columnId: "complete", lastRunStatus: "success" })],
  "not-started": [card("n1")],
  working: [card("w1", { lastRunStatus: "running" })],
  waiting: [card("q1")],
  done: [card("s1", { columnId: "complete", shipStatus: "shipped" })],
};
const stageOf: Record<string, BoardStage> = {
  n1: "to-do",
  n2: "in-review",
  w1: "in-progress",
  q1: "to-do",
  s1: "finished",
};
const staged = stageGroups(groups, (c) => stageOf[c.id]);
assert.deepEqual(
  staged.map((g) => [g.label, g.cards.map((c) => `${c.card.id}:${c.attention}`)]),
  [
    ["Ready to start", ["n1:not-started", "q1:waiting"]],
    ["Working", ["w1:working"]],
    ["In review", ["n2:needs-you"]],
    ["Ready to ship", []],
    ["Done", ["s1:done"]],
  ],
);
const total = Object.values(groups).flat().length;
assert.equal(staged.flatMap((g) => g.cards).length, total);
// A Waiting card listed first in the Board still follows Needs you.
const waitingFirst = stageGroups(
  { "needs-you": [card("late")], "not-started": [], working: [], waiting: [card("early")], done: [] },
  () => "to-do",
);
assert.deepEqual(waitingFirst[0].cards.map((c) => c.card.id), ["late", "early"]);
// The attention column table and the stage table cover the same states.
assert.deepEqual(Object.keys(STATE_ATTENTION_COLUMN).sort(), Object.keys(STATE_STAGE).sort());

// Round 2 (F1): sorted within a stage, Needs you stays first; the key
// orders the rows inside each attention word. Sorting by Attention orders
// by it, both ways; no sort keeps the order given.
const staged2 = [
  { ...boardListRow(card("w-a", { title: "Apple" }), null), attention: "working" as const },
  { ...boardListRow(card("n-z", { title: "Zebra" }), null), attention: "needs-you" as const },
  { ...boardListRow(card("d-b", { title: "Banana" }), null), attention: "done" as const },
  { ...boardListRow(card("n-c", { title: "Cherry" }), null), attention: "needs-you" as const },
];
assert.deepEqual(
  sortStageRows(staged2, { key: "title", dir: "asc" }).map((r) => r.id),
  ["n-c", "n-z", "w-a", "d-b"],
);
assert.deepEqual(
  sortStageRows(staged2, { key: "title", dir: "desc" }).map((r) => r.id),
  ["n-z", "n-c", "w-a", "d-b"],
);
assert.deepEqual(
  sortStageRows(staged2, { key: "attention", dir: "asc" }).map((r) => r.id),
  ["n-z", "n-c", "w-a", "d-b"],
);
assert.deepEqual(
  sortStageRows(staged2, { key: "attention", dir: "desc" }).map((r) => r.id),
  ["d-b", "w-a", "n-z", "n-c"],
);
assert.deepEqual(sortStageRows(staged2, null).map((r) => r.id), ["w-a", "n-z", "d-b", "n-c"]);

console.log("boardList: all contracts passed");
