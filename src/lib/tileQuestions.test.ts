// Terminals block P3: a Claude/Codex tile that waits on the member says so
// at once and in one set of words — its header, its sidebar row and its
// Inbox row — and never reads "Ready" meanwhile. Run by ppvp-pure-contracts.
import assert from "node:assert/strict";
import { deriveTileAttention } from "./attention.ts";
import { waitingSessions, waitingWords } from "./needsYou.ts";
import { sessionRows } from "./sessionRows.ts";
import { tileQuestionWords, tileStatusLine } from "./tileStatusLine.ts";

const now = 1_000_000;
const tile = (question: "decision" | "trust" | "usageLimit" | "bypass" | null, kind = "claude") => ({
  id: "t1",
  kind,
  label: "Fix the footer",
  status: "running",
  startedAt: now - 1000,
  lastOutputAt: now - 500,
  readiness: undefined,
  question,
  questionResetsAt: question === "usageLimit" ? "3pm" : null,
});

// The header: never "Ready" while it waits.
{
  const line = tileStatusLine({ kind: "claude", status: "running", startedAt: now, now, question: "decision" });
  assert.equal(line.tone, "asks");
  assert.equal(line.text, "Asks you something");
  assert.equal(tileStatusLine({ kind: "codex", status: "running", startedAt: now, now, question: "trust" }).text, "Codex asks to trust the folder");
  assert.equal(tileQuestionWords("claude", "usageLimit", "3pm"), "Paused · your plan's limit resets at 3pm");
  assert.notEqual(tileStatusLine({ kind: "claude", status: "running", startedAt: now, now, question: null }).tone, "asks");
  // A shell never asks.
  assert.notEqual(tileStatusLine({ kind: "shell", status: "running", startedAt: now, now, question: "decision" }).tone, "asks");
}

// Attention: at once, not after 10 s of silence.
assert.equal(deriveTileAttention(tile("decision") as never, now), "asking-you");
assert.equal(deriveTileAttention(tile(null) as never, now), "working");

// The sidebar row: the same words, and a dot that is not "empty".
{
  const [row] = sessionRows([tile("trust") as never], [], now);
  assert.equal(row.state, "Claude · asks to trust the folder");
  assert.equal(row.dot, "warn");
  const [limit] = sessionRows([tile("usageLimit") as never], [], now);
  assert.equal(limit.state, "Claude · paused · your plan's limit resets at 3pm");
}

// The Inbox: trust and the limit in their own words.
{
  const rows = waitingSessions({
    tilesByWorkspace: { ws: { tiles: [tile("trust") as never, { ...tile("usageLimit"), id: "t2" } as never] } },
    builders: {},
    cardTitle: () => null,
    now,
  } as never);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].question, "trust");
  assert.equal(rows[1].question, "usage-limit");
  assert.equal(rows[1].resetsAt, "3pm");
  assert.deepEqual(waitingWords(rows[0]), {
    title: "Claude asks to trust the folder",
    // P3 walk: a tile is no card's Builder.
    detail: "In “Fix the footer” — answer it in the session",
  });
  const bypass = waitingSessions({
    tilesByWorkspace: { ws: { tiles: [tile("bypass") as never] } },
    builders: {},
    cardTitle: () => null,
    now,
  } as never);
  assert.doesNotMatch(waitingWords(bypass[0]).detail, /Builder/);
}

console.log("tileQuestions.test.ts: one state for a waiting tile");
