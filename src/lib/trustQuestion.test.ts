// v1.154.1 (walk G1): a Builder stopped at its CLI's folder-trust question.
// Run with Node 22+: node --experimental-strip-types src/lib/trustQuestion.test.ts
import assert from "node:assert/strict";
import type { KanbanCard } from "../ipc.ts";
import {
  anyLiveBuilder,
  cardTrustQuestion,
  intakeTrustHelper,
  intakeTrustQuestion,
  sameTrustAsking,
  TRUST_LABEL,
  trustAskingFrom,
  trustHelper,
  trustWords,
} from "./trustQuestion.ts";
import { waitingSessions, waitingWords } from "./needsYou.ts";
import { attentionColumnFor, deriveAttentionColumn, deriveAttentionGroups } from "./boardSemantics.ts";
import { deriveBoardCardState } from "./cardPresentation.ts";

// The backend's list, by session key: a card's own Builder and SL-6's lanes.
const asking = trustAskingFrom([
  { key: "c1", workspaceId: "w", vendor: "claude" },
  { key: "c2#both-b", workspaceId: "w", vendor: "codex" },
  { key: "c3#both-a", workspaceId: "w", vendor: "claude" },
  { key: "c3#both-b", workspaceId: "w", vendor: "codex" },
]);
assert.equal(cardTrustQuestion("c1", asking), "claude");
assert.equal(cardTrustQuestion("c2", asking), "codex");
// Both builds ask: Claude's (a) is named.
assert.equal(cardTrustQuestion("c3", asking), "claude");
assert.equal(cardTrustQuestion("c4", asking), null);
assert.equal(cardTrustQuestion("c1#both", asking), null);

assert.equal(sameTrustAsking(asking, trustAskingFrom([...Object.entries(asking)].map(([key, q]) => ({ key, ...q })))), true);
assert.equal(sameTrustAsking(asking, {}), false);
assert.equal(sameTrustAsking({ a: { workspaceId: "w", vendor: "claude" } }, { a: { workspaceId: "w", vendor: "codex" } }), false);

// The words: who asks, and where to answer. Plyloft never answers.
assert.equal(
  trustHelper("claude"),
  "Claude asks this once for this project: the folder is your project's copy for this card. Choose “Yes, I trust this folder” in the session.",
);
// 1.171.0 D2: Codex wasn't measured — no "once", no button name.
assert.equal(
  trustHelper("codex"),
  "Codex asks whether to trust this folder. Answer it in the session.",
);
assert.deepEqual(trustWords("codex", "Add a nod function"), {
  // P-A (UX P1 point 2): the Board's and the card's word, with who asks.
  title: "Codex asks to trust the folder",
  detail: "In “Add a nod function” — answer it in the Builder session",
});

// The poll asks the backend only while a card has a live session.
assert.equal(anyLiveBuilder([]), false);
assert.equal(anyLiveBuilder([{ builder: { ptyId: null } }, { buildBoth: { lanes: [{ ptyId: null }] } }]), false);
assert.equal(anyLiveBuilder([{ builder: { ptyId: "p" } }]), true);
assert.equal(anyLiveBuilder([{ buildBoth: { lanes: [{}, { ptyId: "p" }] } }]), true);

// The Inbox: a session at the question waits, even while it prints (the
// question redraws, so its output is recent), attached here or not.
const now = 1_000_000;
const rows = waitingSessions({
  tilesByWorkspace: {},
  builders: {
    c1: { workspaceId: "w", vendor: "claude", startedAt: now - 60_000, lastOutputAt: now - 100 },
    c9: { workspaceId: "w", vendor: "claude", startedAt: now - 60_000, lastOutputAt: now - 100 },
  },
  cardTitle: (_ws, id) => (id === "c1" ? "Add a nod function" : id === "c2" ? "Add a bow function" : null),
  now,
  trustAsking: { c1: asking.c1, "c2#both-b": asking["c2#both-b"] },
});
assert.deepEqual(
  rows.map((r) => [r.id, r.target, r.question, waitingWords(r).title]),
  [
    ["builder:c1", { kind: "card", cardId: "c1" }, "trust", "Claude asks to trust the folder"],
    ["builder:c2#both-b", { kind: "card", cardId: "c2", lane: "b" }, "trust", "Codex asks to trust the folder"],
  ],
);
// Without it, a Builder that just printed is working, not waiting.
assert.equal(
  waitingSessions({
    tilesByWorkspace: {},
    builders: { c1: { workspaceId: "w", vendor: "claude", startedAt: now - 60_000, lastOutputAt: now - 100 } },
    cardTitle: () => null,
    now,
  }).length,
  0,
);

// The Board: a working card whose Builder asks is in Needs you, and says so.
const running: KanbanCard = {
  id: "c1",
  workspaceId: "w",
  title: "Add a nod function",
  columnId: "in_progress",
  lastRunStatus: "running",
  worktreePath: "/wt/c1",
  builder: { vendor: "claude", bypass: false, ptyId: "p1", sessionLost: false, startedAt: 1, snapshots: [] },
  createdAt: 1,
  updatedAt: 1,
} as KanbanCard;
assert.equal(deriveAttentionColumn(running, null), "working");
assert.equal(deriveAttentionColumn(running, null, [], true), "needs-you");
assert.deepEqual(
  deriveAttentionGroups([running], () => null, [running], () => true)["needs-you"].map((c) => c.id),
  ["c1"],
);
const chip = deriveBoardCardState(running, null, [], "claude", true);
assert.equal(chip.label, TRUST_LABEL);
assert.equal(chip.tone, "accent");
assert.equal(deriveBoardCardState(running, null, [], "claude", false).label === TRUST_LABEL, false);
// Only a working card moves: a question left on a finished card changes nothing.
assert.equal(attentionColumnFor("shipped", { changesRequested: false, failed: false, askingTrust: true }), "done");
assert.equal(attentionColumnFor("queued", { changesRequested: false, failed: false, askingTrust: true }), "waiting");

// N14 walk F10: an intake waiting on the question, keyed by its card. It is
// the card's own ask (Board, Needs you), in the intake's words.
const intakeAsking = trustAskingFrom([
  { key: "c5", workspaceId: "w", vendor: "claude", intake: true },
  { key: "c1", workspaceId: "w", vendor: "claude" },
]);
assert.deepEqual(intakeAsking.c5, { workspaceId: "w", vendor: "claude", intake: true });
assert.deepEqual(intakeAsking.c1, { workspaceId: "w", vendor: "claude" });
assert.equal(intakeTrustQuestion("c5", intakeAsking), "claude");
assert.equal(intakeTrustQuestion("c1", intakeAsking), null);
assert.equal(intakeTrustQuestion("c9", intakeAsking), null);
assert.equal(cardTrustQuestion("c5", intakeAsking), "claude");
assert.equal(
  sameTrustAsking({ c5: { workspaceId: "w", vendor: "claude" } }, { c5: { workspaceId: "w", vendor: "claude", intake: true } }),
  false,
);
assert.equal(intakeTrustHelper("claude"), "Claude asks this once for this project: the folder is your project. Choose “Yes, I trust this folder” in the terminal.");
const intakeRows = waitingSessions({
  tilesByWorkspace: {},
  builders: {},
  cardTitle: () => "Plan the README",
  now,
  trustAsking: { c5: intakeAsking.c5 },
});
assert.deepEqual(waitingWords(intakeRows[0]), {
  title: "Claude asks to trust the folder",
  detail: "In “Plan the README” — answer it in the conversation's terminal",
});
// The poll runs while a card plans, too.
assert.equal(anyLiveBuilder([{ intakeStatus: "active" }]), true);
assert.equal(anyLiveBuilder([{ intakeStatus: "ready" }]), false);
// The Board: a planning card whose intake asks is in Needs you, and says so.
const planning = { ...running, id: "c5", columnId: "todo", lastRunStatus: null, worktreePath: null, builder: null, intakeStatus: "active" } as KanbanCard;
assert.equal(deriveAttentionColumn(planning, null), "working");
assert.equal(deriveAttentionColumn(planning, null, [], true), "needs-you");
assert.equal(deriveBoardCardState(planning, null, [], "claude", true).label, TRUST_LABEL);

console.log("trustQuestion: ok");
