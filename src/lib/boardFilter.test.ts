// Tier 3 pure-function test. Run with Node 22+:
//   node --experimental-strip-types src/lib/boardFilter.test.ts
import assert from "node:assert/strict";
import type { KanbanCard } from "../ipc.ts";
import {
  EMPTY_BOARD_FILTER,
  boardCardMatches,
  boardFilterActive,
  boardFilterCount,
  boardQueryMatches,
  type BoardFilterFacts,
} from "./boardFilter.ts";

const card = (patch: Partial<KanbanCard>): KanbanCard => ({
  id: "c",
  workspaceId: "ws",
  title: "Rate-limit the search endpoint",
  columnId: "todo",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

// Title, notes, issue number; every word; case and accents folded.
const c = card({ notes: "Use a token bucket per user.", ghIssueNumber: 42 });
assert.ok(boardQueryMatches(c, ""));
assert.ok(boardQueryMatches(c, "rate"));
assert.ok(boardQueryMatches(c, "SEARCH endpoint"));
assert.ok(boardQueryMatches(c, "bucket"));
assert.ok(boardQueryMatches(c, "#42"));
assert.ok(boardQueryMatches(c, "42"));
assert.ok(!boardQueryMatches(c, "#4"));
assert.ok(!boardQueryMatches(c, "rate login"));
assert.ok(boardQueryMatches(card({ title: "Café menu" }), "cafe"));

const facts: BoardFilterFacts = { column: "working", state: "running", builder: "codex" };
const f = EMPTY_BOARD_FILTER;
assert.ok(boardCardMatches(c, facts, f));
assert.ok(!boardFilterActive(f));
// Needs you combines with the others (AND).
assert.ok(!boardCardMatches(c, facts, { ...f, needsYouOnly: true }));
assert.ok(
  boardCardMatches(c, { ...facts, column: "needs-you", state: "verify-failed" }, {
    ...f,
    needsYouOnly: true,
    states: ["verify-failed"],
    query: "rate",
  }),
);
assert.ok(
  !boardCardMatches(c, { ...facts, column: "needs-you", state: "draft" }, {
    ...f,
    needsYouOnly: true,
    states: ["verify-failed"],
  }),
);
assert.ok(boardCardMatches(c, facts, { ...f, builders: ["codex", "claude"] }));
assert.ok(!boardCardMatches(c, facts, { ...f, builders: ["claude"] }));
assert.ok(!boardCardMatches(c, facts, { ...f, states: ["draft"] }));
assert.ok(!boardCardMatches(c, facts, { ...f, query: "nothing like it" }));
assert.equal(boardFilterCount({ ...f, needsYouOnly: true, states: ["draft"], builders: ["none"] }), 3);
assert.ok(boardFilterActive({ ...f, query: " x " }));
assert.ok(!boardFilterActive({ ...f, query: "   " }));

console.log("boardFilter: all contracts passed");
