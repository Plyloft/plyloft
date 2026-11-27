// Windows (W4): the close sheet names what a quit would stop, counted once
// each, in plain words.
import assert from "node:assert/strict";

import {
  CLOSE_SHEET,
  NOTHING_RUNNING,
  runningCounts,
  stopSentence,
  windowsCloseActionOf,
} from "./closeChoice.ts";

// With nothing counted it never claims that nothing runs: a discussion or a
// card's own Ship now is not counted.
assert.equal(stopSentence(NOTHING_RUNNING), "If you quit, anything Plyloft is still running stops.");
assert.equal(
  stopSentence({ ...NOTHING_RUNNING, sessions: 2, builds: 1 }),
  "If you quit, 2 sessions and 1 build will stop.",
);
assert.equal(stopSentence({ ...NOTHING_RUNNING, sessions: 1 }), "If you quit, 1 session will stop.");
assert.equal(
  stopSentence({ sessions: 1, terminals: 3, runs: 1, reviews: 1, swarms: 2, builds: 2, shipping: true }),
  "If you quit, 1 session, 3 terminals, 1 agent run, 1 review, 2 multi-AI runs, 2 builds and the ship in progress will stop.",
);
assert.equal(
  stopSentence({ ...NOTHING_RUNNING, terminals: 1, runs: 2 }),
  "If you quit, 1 terminal and 2 agent runs will stop.",
);

// Counting: live tiles by kind, an agent-run tile only through its run, a
// finished or closing tile not at all, Builder sessions as sessions.
const counts = runningCounts({
  tiles: [
    { kind: "claude", status: "running" },
    { kind: "codex", status: "pending" },
    { kind: "codex-chat", status: "running" },
    { kind: "shell", status: "running" },
    { kind: "shell", status: "done" },
    { kind: "claude", status: "running", pendingClose: true },
    { kind: "agent-run", status: "running" },
    { kind: "claude", status: "crashed" },
  ],
  builderSessions: 2,
  runStatuses: ["running", "done", "pending", "error"],
  reviewStatuses: ["running", "done", "failed"],
  swarmStatuses: ["running", "suspended", "done"],
  verifyJobs: 1,
  shipping: false,
});
assert.deepEqual(counts, {
  sessions: 5,
  terminals: 1,
  runs: 2,
  reviews: 1,
  swarms: 1,
  builds: 1,
  shipping: false,
});

// The persisted value: anything unknown reads as "ask".
assert.equal(windowsCloseActionOf("tray"), "tray");
assert.equal(windowsCloseActionOf("quit"), "quit");
assert.equal(windowsCloseActionOf("ask"), "ask");
assert.equal(windowsCloseActionOf(undefined), "ask");
assert.equal(windowsCloseActionOf("minimize"), "ask");

// The words: no "kill", no Mac.
for (const text of Object.values(CLOSE_SHEET)) {
  assert.doesNotMatch(text, /kill|mac/i, text);
}
