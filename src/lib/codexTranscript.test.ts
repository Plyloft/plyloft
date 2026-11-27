import assert from "node:assert/strict";

import {
  appendDelta,
  capEntries,
  commandMayWrite,
  completeEntry,
  finishEntry,
  pushEntry,
  replaceEntry,
  TRIM_MARKER_ID,
  TRIM_MARKER_TEXT,
  type TranscriptEntry,
} from "./codexTranscript.ts";

const EMPTY: TranscriptEntry[] = [];

// One command's output is one entry, however many chunks it arrives in.
// v1.102.0 pushed one entry per chunk: a build produced thousands of nodes.
let entries = appendDelta(EMPTY, "item-1", "activity", "$ cargo build\n", "a");
entries = appendDelta(entries, "item-1", "activity", "Compiling…\n", "b");
entries = appendDelta(entries, "item-1", "activity", "Finished\n", "c");
assert.equal(entries.length, 1);
assert.equal(entries[0].text, "$ cargo build\nCompiling…\nFinished\n");
assert.equal(entries[0].itemId, "item-1");

// A different item never joins an open entry.
entries = appendDelta(entries, "item-2", "assistant", "Done.", "d");
assert.equal(entries.length, 2);
assert.equal(entries[1].role, "assistant");

// Completion freezes the entry, and later deltas for the same id open a new
// one rather than reviving a finished item.
entries = completeEntry(entries, "item-2", "assistant", "Done. Two files.", "e");
assert.equal(entries.length, 2);
assert.equal(entries[1].text, "Done. Two files.");
assert.equal(entries[1].done, true);
entries = appendDelta(entries, "item-2", "assistant", "late", "f");
assert.equal(entries.length, 3);

// The case v1.102.0 rendered as an empty transcript: a turn that completes
// without ever streaming a delta. The final message must still appear.
const silent = completeEntry(EMPTY, "item-9", "assistant", "No stream.", "z");
assert.equal(silent.length, 1);
assert.equal(silent[0].text, "No stream.");
assert.equal(silent[0].done, true);

// An empty final text keeps whatever was streamed.
let kept = appendDelta(EMPTY, "item-3", "assistant", "partial", "g");
kept = completeEntry(kept, "item-3", "assistant", "", "h");
assert.equal(kept[0].text, "partial");
assert.equal(kept[0].done, true);

// finishEntry closes a command without rewriting its output, and can add a
// closing note. An unknown item is a no-op, never a stray entry.
let cmd = appendDelta(EMPTY, "item-4", "activity", "$ false\n", "i");
cmd = finishEntry(cmd, "item-4", "(exit 1)");
assert.equal(cmd[0].text, "$ false\n\n(exit 1)");
assert.equal(cmd[0].done, true);
assert.deepEqual(finishEntry(cmd, "item-unknown", "(exit 0)"), cmd);

// A re-sent item replaces its entry instead of stacking copies of itself.
let patch = replaceEntry(EMPTY, "item-7", "activity", "✎ a.ts", "p1");
patch = replaceEntry(patch, "item-7", "activity", "✎ a.ts, b.ts", "p2");
assert.equal(patch.length, 1);
assert.equal(patch[0].text, "✎ a.ts, b.ts");
assert.equal(patch[0].done, undefined);
// ...and once it is closed, a later update opens a fresh entry rather than
// rewriting history.
patch = finishEntry(patch, "item-7");
patch = replaceEntry(patch, "item-7", "activity", "✎ c.ts", "p3");
assert.equal(patch.length, 2);

// Empty text never creates an entry.
assert.equal(pushEntry(EMPTY, { id: "x", role: "activity", text: "" }).length, 0);
assert.equal(appendDelta(EMPTY, "item-5", "activity", "", "y").length, 0);

// The cap keeps the newest entries and says so, exactly once, at the head.
const many: TranscriptEntry[] = Array.from({ length: 10 }, (_, i) => ({
  id: `e${i}`,
  role: "activity" as const,
  text: `line ${i}`,
}));
const capped = capEntries(many, 4);
assert.equal(capped.length, 4);
assert.equal(capped[0].id, TRIM_MARKER_ID);
assert.equal(capped[0].text, TRIM_MARKER_TEXT);
assert.deepEqual(
  capped.slice(1).map((entry) => entry.text),
  ["line 7", "line 8", "line 9"],
);

// Trimming again does not stack markers.
const twice = capEntries([...capped, ...many], 4);
assert.equal(twice.filter((entry) => entry.id === TRIM_MARKER_ID).length, 1);
assert.equal(twice[0].id, TRIM_MARKER_ID);

// Under the cap, nothing is touched — identity included, so React sees no
// change it does not need to see.
assert.equal(capEntries(many, 10), many);

// GH #211 review 1 (m3): which commands may have changed files, from Codex's
// own `commandActions`.
assert.equal(commandMayWrite({ commandActions: [{ type: "search", command: "rg x" }] }), false);
assert.equal(
  commandMayWrite({
    commandActions: [
      { type: "read", command: "cat a" },
      { type: "listFiles", command: "ls" },
    ],
  }),
  false,
);
assert.equal(
  commandMayWrite({
    commandActions: [
      { type: "read", command: "cat a" },
      { type: "unknown", command: "printf x > b" },
    ],
  }),
  true,
);
assert.equal(commandMayWrite({ commandActions: [] }), true);
assert.equal(commandMayWrite({}), true);
// A kind this client does not know is not assumed to be read-only.
assert.equal(commandMayWrite({ commandActions: [{ type: "edit", command: "x" }] }), true);
assert.equal(commandMayWrite({ commandActions: [null] }), true);

console.log("codexTranscript.test.ts ✓");
