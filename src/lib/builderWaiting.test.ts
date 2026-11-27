// UX P1 point 4 (P-B): which cards' Builders wait on the person, indexed
// from the Inbox's own `waitingSessions`, and the 3-second hold that stops
// a card hopping between columns.
// Run with Node 22+:
//   node --experimental-strip-types src/lib/builderWaiting.test.ts
import assert from "node:assert/strict";
import {
  BUILDER_WAITING_HOLD_MS,
  builderWaitingKey,
  holdBuilderWaiting,
  waitingBuildersByCard,
} from "./builderWaiting.ts";
import { waitingSessions, waitingStateOf, waitingWords, type WaitingSession } from "./needsYou.ts";

const NOW = 1_700_000_000_000;

// The state of a session whose attention waits.
assert.equal(waitingStateOf("asking-you", false), "question");
assert.equal(waitingStateOf("asking-you", true), "stopped");
assert.equal(waitingStateOf("wants-you", false), "quiet");
assert.equal(waitingStateOf("wants-you", true), "quiet");

// waitingSessions says it on each Builder row, with the vendor; the Inbox
// row's words follow it.
const rows = waitingSessions({
  tilesByWorkspace: {},
  builders: {
    q: { workspaceId: "ws", vendor: "claude", startedAt: NOW - 60_000, lastOutputAt: NOW - 500, questionInView: true },
    s: { workspaceId: "ws", vendor: "codex", startedAt: NOW - 60_000, lastOutputAt: NOW - 30_000, promptBoxIdle: true, turnIdle: true },
    z: { workspaceId: "ws", vendor: "claude", startedAt: NOW - 60_000, lastOutputAt: NOW - 30_000 },
    w: { workspaceId: "ws", vendor: "claude", startedAt: NOW - 60_000, lastOutputAt: NOW - 500 },
  },
  cardTitle: (_, id) => `card ${id}`,
  now: NOW,
});
assert.deepEqual(
  rows.map((r) => [r.id, r.session, r.vendor]),
  [
    ["builder:q", "question", "claude"],
    ["builder:s", "stopped", "codex"],
    ["builder:z", "quiet", "claude"],
  ],
  "a working Builder is not waiting",
);
assert.deepEqual(rows.map((r) => waitingWords(r).title), [
  "Claude · Asks you something",
  "Codex · Your turn",
  "Claude · Your turn",
]);

// One entry per card: its own Builder over a build; trust and plan rows
// (questions of their own) are not Builders waiting.
function row(patch: Partial<WaitingSession>): WaitingSession {
  return { id: "x", workspaceId: "ws", agent: "Claude", where: "c", since: 0, target: { kind: "card", cardId: "c" }, session: "stopped", ...patch };
}
const byCard = waitingBuildersByCard([
  row({ target: { kind: "card", cardId: "both", lane: "b" }, session: "quiet", agent: "Codex", vendor: "codex" }),
  row({ target: { kind: "card", cardId: "both", lane: "a" }, session: "stopped", vendor: "claude" }),
  row({ target: { kind: "card", cardId: "own" }, session: "question" }),
  row({ target: { kind: "card", cardId: "trust" }, question: "trust", session: undefined }),
  row({ target: { kind: "tile", tileId: "t1" } }),
]);
assert.deepEqual([...byCard.keys()].sort(), ["ws::both", "ws::own"]);
assert.deepEqual(byCard.get("ws::own"), { state: "question", vendor: "claude" });
assert.deepEqual(byCard.get("ws::both"), { state: "quiet", vendor: "codex", lane: "b" }, "the first build listed");
assert.equal(builderWaitingKey("ws", "own"), "ws::own");

// The hold.
const now1 = new Map([["ws::c", { state: "quiet" as const, vendor: "claude" as const }]]);
const a = holdBuilderWaiting({}, now1, NOW);
assert.deepEqual(a, { "ws::c": { state: "quiet", vendor: "claude", releaseAt: null } }, "waiting shows at once");
assert.equal(holdBuilderWaiting(a, now1, NOW + 1_000), a, "nothing changed: the same object (no redraw)");
const b = holdBuilderWaiting(a, new Map(), NOW + 2_000);
assert.deepEqual(b["ws::c"], { state: "quiet", vendor: "claude", releaseAt: NOW + 2_000 + BUILDER_WAITING_HOLD_MS }, "it printed again: held");
assert.equal(holdBuilderWaiting(b, new Map(), NOW + 3_000), b, "still held, unchanged");
assert.deepEqual(holdBuilderWaiting(b, new Map(), NOW + 2_000 + BUILDER_WAITING_HOLD_MS), {}, "3 s later it goes");
// Waiting again inside the hold: no release, the new state at once.
const again = holdBuilderWaiting(b, new Map([["ws::c", { state: "question" as const, vendor: "claude" as const }]]), NOW + 3_000);
assert.deepEqual(again["ws::c"], { state: "question", vendor: "claude", releaseAt: null });
// Another kind of wait replaces the state at once.
const stopped = holdBuilderWaiting(a, new Map([["ws::c", { state: "stopped" as const, vendor: "claude" as const }]]), NOW + 500);
assert.equal(stopped["ws::c"].state, "stopped");

// (Challenger) During Finish and check (its self-check, or the press
// itself) a Builder at its prompt or quiet is not waiting for the person;
// a question in view still is (CL-11).
const finishingRows = waitingSessions({
  tilesByWorkspace: {},
  builders: {
    q: { workspaceId: "ws", vendor: "claude", startedAt: NOW - 60_000, lastOutputAt: NOW - 500, questionInView: true },
    s: { workspaceId: "ws", vendor: "codex", startedAt: NOW - 60_000, lastOutputAt: NOW - 30_000, promptBoxIdle: true, turnIdle: true },
    z: { workspaceId: "ws", vendor: "claude", startedAt: NOW - 60_000, lastOutputAt: NOW - 30_000 },
  },
  cardTitle: (_, id) => `card ${id}`,
  now: NOW,
  finishing: () => true,
});
assert.deepEqual(finishingRows.map((r) => r.id), ["builder:q"], "only the question waits while it finishes");

// (Challenger) A build of a card built by both whose Finish and check went
// through, with nothing sent since, waits for the other build — not for the
// person. Sent new work after it, it waits again; a question always does.
{
  const lanes = (doneAt: number | null) => ({
    status: "building",
    lanes: [
      { lane: "a", vendor: "claude", worktreePath: "/a", branchName: "a", ptyId: "pa", startedAt: NOW - 60_000, done: doneAt == null ? null : { sha: "s", at: doneAt } },
      { lane: "b", vendor: "codex", worktreePath: "/b", branchName: "b", ptyId: "pb", startedAt: NOW - 60_000, done: null },
    ],
  });
  const card = (doneAt: number | null) => ({ id: "both", columnId: "in_progress", buildBoth: lanes(doneAt) }) as never;
  const atPrompt = { workspaceId: "ws", vendor: "claude" as const, startedAt: NOW - 60_000, lastOutputAt: NOW - 30_000, promptBoxIdle: true, turnIdle: true };
  const run = (doneAt: number | null, extra: Record<string, unknown> = {}, sentAt: Record<string, number> = {}) =>
    waitingSessions({
      tilesByWorkspace: {},
      builders: { "both#both-a": { ...atPrompt, ptyId: "pa", ...extra } },
      cardTitle: () => "both",
      now: NOW,
      card: () => card(doneAt),
      sentAt,
    }).map((r) => r.id);
  assert.deepEqual(run(null), ["builder:both#both-a"], "a build that stopped before its Finish and check waits");
  assert.deepEqual(run(NOW - 40_000), [], "a done build at its prompt waits for the other build");
  assert.deepEqual(run(NOW - 40_000, {}, { "both#both-a": NOW - 35_000 }), ["builder:both#both-a"], "new work sent after it: waiting again");
  assert.deepEqual(run(NOW - 40_000, { questionInView: true, lastOutputAt: NOW - 500, turnIdle: false }), ["builder:both#both-a"], "a question waits");
}

console.log("builderWaiting: ok");
