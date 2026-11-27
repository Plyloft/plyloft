// C7 pure contract: card dependencies — who holds whom, where a held card
// sits on the Board, what it says, and that nothing starts on its own. Run:
//   node --experimental-strip-types src/lib/cardDependencies.test.ts
import assert from "node:assert/strict";
import type { KanbanCard } from "../ipc.ts";
import {
  ADD_BLOCKER_LABEL,
  blockedByLine,
  blockedByShown,
  blockerCandidates,
  dependentsOf,
  isHeld,
  startRefusal,
  unshippedBlockers,
  wouldCycle,
} from "./cardDependencies.ts";
import {
  attentionColumnFor,
  cardAttentionSignals,
  deriveAttentionColumn,
  deriveAttentionGroups,
  STATE_ATTENTION_COLUMN,
} from "./boardSemantics.ts";
import { boardListRowOf as boardListRow, deriveBoardCardState } from "./cardPresentation.ts";
import { CARD_STATES } from "./cardLifecycle.ts";

let n = 0;
const card = (id: string, patch: Partial<KanbanCard> = {}): KanbanCard => ({
  id,
  workspaceId: "ws",
  title: id.toUpperCase(),
  columnId: "todo",
  createdAt: ++n,
  updatedAt: n,
  ...patch,
});

// ── Who holds whom ──────────────────────────────────────────────────────
const cookie = card("cookie", { title: "Session cookie expiry", ghIssueNumber: 41 });
const docs = card("docs", { title: "Docs" });
const login = card("login", { title: "Fix login redirect", notes: "brief", blockedBy: ["cookie", "docs", "gone"] });
let board = [cookie, docs, login];

assert.deepEqual(unshippedBlockers(login, board).map((c) => c.id), ["cookie", "docs"]);
assert.equal(startRefusal(unshippedBlockers(login, board)), "Starts when “Session cookie expiry” and 1 more ship.");
assert.equal(startRefusal([cookie]), "Starts when “Session cookie expiry” ships.");
assert.equal(startRefusal([]), null);
assert.equal(blockedByLine([cookie]), "Blocked by #41");
assert.equal(blockedByLine([docs]), "Blocked by “Docs”");
assert.equal(blockedByLine([cookie, docs]), "Blocked by #41 and 1 more");
// 1.174.0 A2 (P7): a blocker whose pull request is open holds the card until
// the merge, and says so.
{
  const sent = card("sent", {
    title: "Site: say hello",
    reviewStatus: "merged",
    prUrl: "https://github.com/o/r/pull/138",
    pr: { number: 138, state: "open" } as KanbanCard["pr"],
  });
  const waiting = card("w", { blockedBy: ["sent"] });
  assert.deepEqual(unshippedBlockers(waiting, [sent]).map((b) => b.id), ["sent"]);
  assert.equal(blockedByLine([sent]), "Waits for “Site: say hello” to merge");
  assert.equal(blockedByLine([sent, sent]), "Waits for “Site: say hello” and 1 more to merge");
  assert.equal(blockedByLine([sent, docs]), "Blocked by “Site: say hello” and 1 more", "one not sent yet");
  const merged = { ...sent, shipStatus: "shipped" as const, pr: { number: 138, state: "merged" } as KanbanCard["pr"] };
  assert.deepEqual(unshippedBlockers(waiting, [merged]), [], "merged: it starts");
  assert.equal(startRefusal([sent]), "Starts when “Site: say hello” merges.");
  assert.equal(startRefusal([docs]), "Starts when “Docs” ships.");
  assert.equal(startRefusal([sent, sent]), "Starts when “Site: say hello” and 1 more merge.");
  assert.equal(startRefusal([sent, docs]), "Starts when “Site: say hello” and 1 more ship.", "one not sent yet");
}
assert.deepEqual(dependentsOf(cookie, board).map((c) => c.id), ["login"]);

// Held only before it starts: draft or ready, in Todo.
assert.ok(isHeld(login, board, "ready"));
assert.ok(isHeld(login, board, "draft"));
assert.ok(!isHeld(login, board, "intake-live"), "a conversation already going is not stopped");
assert.ok(!isHeld({ ...login, columnId: "in_progress" }, board, "ready"));

// A shipped, merged, archived or deleted blocker holds no one back.
const shipped = { ...cookie, shipStatus: "shipped" as const };
const merged = { ...docs, reviewStatus: "merged" as const };
assert.deepEqual(unshippedBlockers(login, [shipped, merged, login]), []);
assert.deepEqual(unshippedBlockers(login, [{ ...cookie, archived: true }, docs, login]).map((c) => c.id), ["docs"]);
assert.deepEqual(unshippedBlockers(login, [docs, login]).map((c) => c.id), ["docs"], "cookie deleted");

// ── Cycles ──────────────────────────────────────────────────────────────
const a = card("a", { blockedBy: ["b"] });
const b = card("b", { blockedBy: ["c"] });
const c = card("c");
const ring = [a, b, c];
assert.ok(wouldCycle(ring, "c", "a"), "c → a → b → c");
assert.ok(wouldCycle(ring, "b", "a"));
assert.ok(wouldCycle(ring, "a", "a"), "itself");
assert.ok(!wouldCycle(ring, "a", "c"), "a already waits for c through b: no cycle");
// The picker never offers a cycle, the card itself, an archived card or one
// already chosen; it finds by title or #n.
const pick = [a, b, c, card("old", { archived: true }), card("x", { title: "Header tweaks", ghIssueNumber: 120 })];
assert.deepEqual(blockerCandidates(c, pick, "").map((k) => k.id), ["x"]);
assert.deepEqual(blockerCandidates(a, pick, "").map((k) => k.id), ["c", "x"]);
assert.deepEqual(blockerCandidates(a, pick, "header").map((k) => k.id), ["x"]);
assert.deepEqual(blockerCandidates(a, pick, "#12").map((k) => k.id), ["x"]);

// ── The Board: Waiting while held, Needs you when free (UX-7.2) ─────────
// Every state keeps its column when nothing blocks it.
for (const state of CARD_STATES) {
  const none = { changesRequested: false, failed: false, blocked: false };
  assert.equal(attentionColumnFor(state, none), STATE_ATTENTION_COLUMN[state], state);
  const held = attentionColumnFor(state, { ...none, blocked: true });
  if (state === "draft" || state === "ready") assert.equal(held, "waiting", `${state} held`);
  else assert.equal(held, STATE_ATTENTION_COLUMN[state], `${state} is not held once started`);
}
assert.equal(cardAttentionSignals(login, board).blocked, true);
assert.equal(deriveAttentionColumn(login, null, board), "waiting");
assert.equal(deriveAttentionColumn(login, null), "not-started", "no board, no blockers known");
const chip = deriveBoardCardState(login, null, board);
assert.equal(chip.blocked, "Blocked by #41 and 1 more");
assert.equal(boardListRow(login, null, board).status, "Blocked by #41 and 1 more");
assert.equal(boardListRow(login, null, board).blocked, true);

// A filter that hides the blockers still sees them (the whole board).
const groups = deriveAttentionGroups([login], () => null, board);
assert.deepEqual(groups.waiting.map((k) => k.id), ["login"]);

// The last blocker ships: Needs you, "Ready to start" — and nothing changed
// on the card, so nothing started it.
board = [shipped, { ...docs, shipStatus: "shipped" }, login];
const before = JSON.stringify(login);
assert.equal(deriveAttentionColumn(login, null, board), "not-started");
const free = deriveBoardCardState(login, null, board);
assert.equal(free.blocked, null);
assert.equal(free.label, "Ready to start");
assert.equal(boardListRow(login, null, board).status, "Ready to start");
assert.equal(JSON.stringify(login), before, "unblocking writes nothing and starts nothing");
assert.equal(login.columnId, "todo");
assert.equal(login.lastRunStatus, undefined);

// 1.174.0 (C2, BCI-11): the facts line says Blocked by only when the card
// names a blocker still on the board; a blocker is added under Change….
{
  const fresh = card("fresh");
  assert.equal(blockedByShown(fresh, [fresh, cookie]), false, "a new card has no Blocked by Nothing · Add");
  assert.equal(blockedByShown(card("x", { blockedBy: [] }), [cookie]), false);
  assert.equal(blockedByShown(card("x", { blockedBy: ["gone"] }), [cookie]), false, "a deleted blocker is no blocker");
  assert.equal(blockedByShown(card("x", { blockedBy: ["gone", "cookie"] }), [cookie]), true);
  assert.equal(ADD_BLOCKER_LABEL, "Add a blocker");
}

console.log("cardDependencies: all assertions passed");
