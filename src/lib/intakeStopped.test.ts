// N14 walk F14: an intake conversation that ended while its card still plans
// ("No, exit" at Claude's folder-trust question) — one derivation, the same
// words on the Board, the List, the card's Now box and the Inbox.
// Run with Node 22+: node --experimental-strip-types src/lib/intakeStopped.test.ts
import assert from "node:assert/strict";
import type { KanbanCard } from "../ipc.ts";
import {
  INTAKE_ENDED_REASON,
  intakeStopReason,
  intakeStoppedHappened,
  intakeStoppedLabel,
  intakeStoppedWords,
  intakeSweptReason,
  foldIntakePoll,
  type IntakeStop,
  stoppedIntakes,
} from "./intakeStopped.ts";
import { attentionCounts, waitingSessions, waitingWords } from "./needsYou.ts";
import {
  boardChipRunState,
  deriveAttentionColumn,
  deriveAttentionGroups,
} from "./boardSemantics.ts";
import { boardListRowOf as boardListRow, deriveBoardCardState } from "./cardPresentation.ts";
import { intakeStoppedError } from "./cardPage.ts";

const card = (id: string, extra: Partial<KanbanCard> = {}): KanbanCard =>
  ({
    id,
    workspaceId: "w",
    title: `Card ${id}`,
    notes: "",
    columnId: "todo",
    createdAt: 1,
    updatedAt: 1,
    lastRunStatus: null,
    intakeStatus: "active",
    ...extra,
  }) as KanbanCard;

// ── The derivation ─────────────────────────────────────────────────────
const planning = card("c1");
const ended = (since = 1): IntakeStop => ({ reason: INTAKE_ENDED_REASON, since, source: "ended" });
// Live: nothing recorded.
assert.equal(intakeStopReason(planning, {}), null);
assert.equal(intakeStopReason(planning, { c1: ended() }), INTAKE_ENDED_REASON);
// A card no longer planning is not "stopped", whatever is left over.
assert.equal(intakeStopReason(card("c2", { intakeStatus: "none" }), { c2: ended() }), null);
assert.equal(intakeStopReason(card("c3", { intakeStatus: "ready" }), { c3: ended() }), null);
// Challenger P3-2: the Board's state guard — a planning card whose state is
// not "intake-live" (a run that succeeded, archived) is not stopped.
assert.equal(intakeStopReason(card("c8", { lastRunStatus: "success" }), { c8: ended() }), null);
assert.equal(intakeStopReason(card("c9", { archived: true }), { c9: ended() }), null);

// ── The poll (Challenger P3-4) ──────────────────────────────────────────
const none = { stops: {}, missingOnce: {} };
// Ended on the backend: a stop at once, first seen now.
let folded = foldIntakePoll(none, { ended: ["c1"], live: [] }, ["c1"], 100);
assert.deepEqual(folded.stops, { c1: { reason: INTAKE_ENDED_REASON, since: 100, source: "ended" } });
// Seen again later: the time it was first seen stays (P3-3).
folded = foldIntakePoll(folded, { ended: ["c1"], live: [] }, ["c1"], 200);
assert.equal(folded.stops.c1.since, 100);
// Gone from the backend (cancelled): the poll's stop goes.
assert.deepEqual(foldIntakePoll(folded, { ended: [], live: [] }, [], 300).stops, {});
// Live: nothing.
assert.deepEqual(foldIntakePoll(none, { ended: [], live: ["c1"] }, ["c1"], 100), none);
// Planning with no conversation at all (a reload): once is not enough —
// a start or a conclude may be in flight — twice in a row is a stop.
const once = foldIntakePoll(none, { ended: [], live: [] }, ["c1"], 100);
assert.deepEqual(once, { stops: {}, missingOnce: { c1: true } });
const twice = foldIntakePoll(once, { ended: [], live: [] }, ["c1"], 102);
assert.deepEqual(twice.stops, { c1: { reason: INTAKE_ENDED_REASON, since: 102, source: "missing" } });
assert.equal(foldIntakePoll(twice, { ended: [], live: [] }, ["c1"], 104).stops.c1.since, 102);
// Live again in between: the mark goes.
assert.deepEqual(foldIntakePoll(once, { ended: [], live: ["c1"] }, ["c1"], 102), none);
// A stop the conversation's own exit recorded stays whatever the poll says.
const exit: IntakeStop = { reason: "Intake agent exited unexpectedly (code 1). Cancel and retry.", since: 5, source: "exit" };
assert.deepEqual(foldIntakePoll({ stops: { c1: exit }, missingOnce: {} }, { ended: ["c1"], live: [] }, ["c1"], 100).stops, { c1: exit });

// ── The words: the card page's stopped block ────────────────────────────
assert.equal(intakeStoppedLabel("claude"), "Planning with Claude stopped");
assert.equal(intakeStoppedLabel("codex"), "Planning with Codex stopped");
assert.equal(intakeStoppedHappened(INTAKE_ENDED_REASON, "claude"), "The conversation with Claude ended, or couldn't go on.");
assert.equal(
  intakeStoppedHappened(intakeSweptReason(30), "claude"),
  "The conversation was closed after 30 minutes without an answer.",
);
// The block (a card no longer planning) says the same.
const block = intakeStoppedError(INTAKE_ENDED_REASON, "claude");
assert.equal(block.title, `${intakeStoppedLabel("claude")}.`);
assert.equal(block.happened, intakeStoppedHappened(INTAKE_ENDED_REASON, "claude"));
assert.deepEqual(intakeStoppedWords("claude", "D1 plan me", INTAKE_ENDED_REASON), {
  title: "Planning with Claude stopped",
  detail: "In “D1 plan me” — the conversation with Claude ended, or couldn't go on. Plan again or cancel it on the card.",
});


// ── The Board: Needs you, in its words, not a live dot ──────────────────
assert.equal(deriveAttentionColumn(planning, null), "working");
assert.equal(deriveAttentionColumn(planning, null, [], false, false, true), "needs-you");
const chip = deriveBoardCardState(planning, null, [], "claude", false, null, true);
assert.equal(chip.label, "Planning with Claude stopped");
assert.equal(chip.tone, "accent");
assert.deepEqual(boardChipRunState(chip), { state: "aborted", live: false });
// Live, it still reads as planning with a live dot.
const live = deriveBoardCardState(planning, null, [], "claude");
assert.equal(live.label, "Planning with Claude");
assert.deepEqual(boardChipRunState(live), { state: "running", live: true });
// Codex planned it.
assert.equal(deriveBoardCardState(planning, null, [], "codex", false, null, true).label, "Planning with Codex stopped");
// Only a planning card: a stale flag on another state changes nothing.
const draft = card("c4", { intakeStatus: "none" });
assert.equal(deriveBoardCardState(draft, null, [], "claude", false, null, true).label, "Ready to start");
assert.equal(deriveAttentionColumn(draft, null, [], false, false, true), deriveAttentionColumn(draft, null));
// Groups: the predicate moves it.
const groups = deriveAttentionGroups([planning, card("c5")], () => null, undefined, undefined, undefined, (c) => c.id === "c1");
assert.deepEqual(groups["needs-you"].map((c) => c.id), ["c1"]);
assert.deepEqual(groups.working.map((c) => c.id), ["c5"]);
// The List says the same.
const row = boardListRow(planning, null, [], () => "claude", false, null, true);
assert.equal(row.status, "Planning with Claude stopped");
assert.deepEqual(row.run, { state: "aborted", live: false });

// ── The Inbox and the one count ─────────────────────────────────────────
const boards = {
  w: { cards: [planning, card("c5"), card("c6", { archived: true }), card("c7", { intakeStatus: "none" })] },
};
const stopped = stoppedIntakes(
  { w: { cards: [...boards.w.cards, card("c8", { lastRunStatus: "success" })] } },
  { c1: ended(42), c6: ended(), c7: ended(), c8: ended() },
  () => "claude",
);
assert.deepEqual(stopped, [{ workspaceId: "w", cardId: "c1", vendor: "claude", reason: INTAKE_ENDED_REASON, since: 42 }]);
const now = 5_000_000;
const rows = waitingSessions({
  tilesByWorkspace: {},
  builders: {},
  cardTitle: (_ws, id) => (id === "c1" ? "D1 plan me" : null),
  now,
  intakesStopped: stopped,
});
assert.equal(rows.length, 1);
assert.equal(rows[0].id, "intake-stopped:c1");
assert.deepEqual(rows[0].target, { kind: "card", cardId: "c1" });
assert.equal(rows[0].question, "intake-stopped");
assert.equal(rows[0].since, 42);
assert.deepEqual(waitingWords(rows[0]), intakeStoppedWords("claude", "D1 plan me", INTAKE_ENDED_REASON));
assert.equal(attentionCounts(null, rows).total, 1);
assert.deepEqual(attentionCounts(null, rows).byWorkspace, { w: 1 });

console.log("intakeStopped: ok");
