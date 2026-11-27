// UX P-F (UX P1 point 8): Claude's usage limit and its Bypass Permissions
// warning, as the backend reports them (`builder_session_blocks`), in the
// words of the card, the Board and the Inbox. Run with Node 22+:
//   node --experimental-strip-types src/lib/sessionBlock.test.ts
import assert from "node:assert/strict";
import {
  cardSessionBlock,
  sameSessionBlocks,
  sessionBlockWords,
  sessionBlocksFrom,
  usageLimitSentence,
} from "./sessionBlock.ts";
import { trustAskingFrom } from "./trustQuestion.ts";
import { waitingSessions, waitingWords } from "./needsYou.ts";

// The backend's one list: trust goes to `trustAsking`, the rest here; an
// intake is only ever the trust question.
const list = [
  { key: "c1", workspaceId: "w", vendor: "claude", kind: "usageLimit", resetsAt: "3pm" },
  { key: "c2#both-a", workspaceId: "w", vendor: "claude", kind: "bypass" },
  { key: "c3", workspaceId: "w", vendor: "claude", kind: "trust" },
  { key: "c4", workspaceId: "w", vendor: "claude", kind: "trust", intake: true },
  { key: "c5", workspaceId: "w", vendor: "claude", kind: "usageLimit", resetsAt: "  " },
];
const blocks = sessionBlocksFrom(list);
assert.deepEqual(blocks, {
  c1: { workspaceId: "w", vendor: "claude", kind: "usageLimit", resetsAt: "3pm" },
  "c2#both-a": { workspaceId: "w", vendor: "claude", kind: "bypass", resetsAt: null },
  c5: { workspaceId: "w", vendor: "claude", kind: "usageLimit", resetsAt: null },
});
assert.deepEqual(Object.keys(trustAskingFrom(list)), ["c3", "c4"]);
// A list from before P-F (no kind) is the trust question.
assert.deepEqual(Object.keys(trustAskingFrom([{ key: "c9", workspaceId: "w", vendor: "codex" }])), ["c9"]);
assert.equal(sameSessionBlocks(blocks, sessionBlocksFrom(list)), true);
assert.equal(sameSessionBlocks(blocks, sessionBlocksFrom(list.slice(1))), false);

// A card's block: its own, else either build's.
assert.deepEqual(cardSessionBlock("c1", blocks), { vendor: "claude", kind: "usageLimit", resetsAt: "3pm" });
assert.deepEqual(cardSessionBlock("c2", blocks), { vendor: "claude", kind: "bypass", resetsAt: null });
assert.equal(cardSessionBlock("c3", blocks), null);

// The words, with and without a time; never a guess.
assert.equal(usageLimitSentence("claude", "3pm"), "Claude's usage limit is reached. After it resets at 3pm, tell the Builder to continue.");
assert.equal(usageLimitSentence("claude", null), "Claude's usage limit is reached. After it resets, tell the Builder to continue.");
assert.deepEqual(sessionBlockWords("claude", "usageLimit", "Add a nod function", "3pm"), {
  title: "Claude · Paused · your plan's limit resets at 3pm",
  detail: "In “Add a nod function”",
});
assert.deepEqual(sessionBlockWords("claude", "usageLimit", "Add a nod function", null).detail, "In “Add a nod function”");

// The Inbox: a stopped session waits whatever it printed, attached here or
// not, one row per session, and its turn-over row is not a second one.
const now = 1_000_000;
const rows = waitingSessions({
  tilesByWorkspace: {},
  builders: {
    c1: { workspaceId: "w", vendor: "claude", startedAt: now - 60_000, lastOutputAt: now - 60_000, turnIdle: true, promptBoxIdle: true },
  },
  cardTitle: (_ws, id) => (id === "c1" ? "Add a nod function" : id === "c2" ? "Add a bow function" : null),
  now,
  sessionBlocks: blocks,
});
assert.deepEqual(
  rows.map((r) => [r.id, r.target, r.question, waitingWords(r).title, waitingWords(r).detail]),
  [
    ["builder:c1", { kind: "card", cardId: "c1" }, "usage-limit", "Claude · Paused · your plan's limit resets at 3pm", "In “Add a nod function”"],
    [
      "builder:c2#both-a",
      { kind: "card", cardId: "c2", lane: "a" },
      "bypass",
      "Claude asks to work without asking",
      "In “Add a bow function” — answer it in the Builder session",
    ],
    ["builder:c5", { kind: "card", cardId: "c5" }, "usage-limit", "Claude · Paused · your plan's limit resets soon", "In “a card's session”"],
  ],
);

console.log("sessionBlock: ok");
