import assert from "node:assert/strict";

import {
  composeLineCommentsMessage,
  diffRows,
  HUNK_GAP,
  MESSAGE_MAX_CHARS,
  QUOTE_MAX_CHARS,
  QUOTE_MAX_LINES,
  rangeLabel,
  rowLabel,
  sanitizeForPaste,
  selectionRange,
  stepSelectable,
  unsentComments,
  type SendableComment,
} from "./lineComments.ts";
import { sendLineComments, waitUntil, type LineCommentSendDeps } from "./lineCommentSend.ts";

// SL-5: the selection → range mapping, the message, and Send to Builder.

// Two hunks of one file. Hunk 0: old 10.., new 10..; hunk 1: old 40.., new 42..
const hunks = [
  { oldStart: 10, newStart: 10, body: " keep\n-gone\n+new a\n+new b\n tail\n" },
  { oldStart: 40, newStart: 42, body: " ctx40\n-drop41\n-drop42\n+add43\n\\ No newline at end of file\n" },
];
const rows = diffRows(hunks);

// Numbering: context both sides, added new side, removed old side.
assert.deepEqual(
  rows.map((r) => [r.kind, r.oldLine, r.newLine]),
  [
    ["ctx", 10, 10],
    ["del", 11, null],
    ["add", null, 11],
    ["add", null, 12],
    ["ctx", 12, 13],
    ["ctx", 40, 42],
    ["del", 41, null],
    ["del", 42, null],
    ["add", null, 43],
    ["meta", null, null],
  ],
);
assert.equal(rows.length, 10, "no row for the empty text after the last newline");

// Added lines only: new-file numbers.
assert.deepEqual(selectionRange(rows, 2, 3), {
  newStart: 11,
  newEnd: 12,
  oldStart: null,
  oldEnd: null,
  quoted: "+new a\n+new b",
});
// Either order is the same selection.
assert.deepEqual(selectionRange(rows, 3, 2), selectionRange(rows, 2, 3));

// Removed lines only: no new range; old (base) numbers.
const removed = selectionRange(rows, 6, 7)!;
assert.equal(removed.newStart, null);
assert.deepEqual([removed.oldStart, removed.oldEnd], [41, 42]);
assert.equal(rangeLabel(removed), "removed lines 41–42 of the base version");

// Mixed: context + removed + added → new range from ctx/add, old from removed.
const mixed = selectionRange(rows, 0, 4)!;
assert.deepEqual(
  [mixed.newStart, mixed.newEnd, mixed.oldStart, mixed.oldEnd],
  [10, 13, 11, 11],
);
assert.equal(rangeLabel(mixed), "lines 10–13, and removed line 11 of the base version");
assert.equal(mixed.quoted, " keep\n-gone\n+new a\n+new b\n tail");

// Across hunks: the jump is marked, the range spans both.
const across = selectionRange(rows, 3, 6)!;
assert.equal(across.quoted, `+new b\n tail\n${HUNK_GAP}\n ctx40\n-drop41`);
assert.deepEqual([across.newStart, across.newEnd, across.oldStart, across.oldEnd], [12, 42, 41, 41]);

// The "\ No newline" row is never selected or counted.
assert.equal(selectionRange(rows, 9, 9), null);
assert.deepEqual(selectionRange(rows, 8, 9)!.quoted, "+add43");

// A new file (old side 0,0) numbers from 1.
const added = diffRows([{ oldStart: 0, newStart: 1, body: "+a\n+b\n" }]);
assert.equal(rangeLabel(selectionRange(added, 0, 1)!), "lines 1–2");
assert.equal(rangeLabel({ newStart: 5, newEnd: 5 }), "line 5");

// A long selection is cut, and says so.
const long = diffRows([
  { oldStart: 1, newStart: 1, body: Array.from({ length: 200 }, (_, i) => `+l${i}`).join("\n") + "\n" },
]);
const longRange = selectionRange(long, 0, 199)!;
assert.equal(longRange.newEnd, 200, "the range is the whole selection");
assert.equal(longRange.quoted.split("\n").length, QUOTE_MAX_LINES + 1);
assert.match(longRange.quoted, /cut here\)$/);

// A cut by characters never splits a surrogate pair.
const emoji = diffRows([{ oldStart: 1, newStart: 1, body: `+${"😀".repeat(QUOTE_MAX_CHARS)}\n` }]);
const emojiQuote = selectionRange(emoji, 0, 0)!.quoted;
assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(emojiQuote), "no lone high surrogate");
assert.match(emojiQuote, /cut here\)$/);

// Paste safety: escapes and other control characters go; tab and newline stay.
assert.equal(sanitizeForPaste("a\u001b[201~b\tc\r\nd\u0007"), "a[201~b\tc\nd");

// The message: every comment, with file, lines, quote and comment, in order.
const comments: SendableComment[] = [
  { id: "1", path: "src/a.ts", newStart: 11, newEnd: 12, quoted: "+new a\n+new b", body: " Name this after what it holds. " },
  { id: "2", path: "src/b.ts", oldStart: 41, oldEnd: 42, quoted: "-drop41\n-drop42", body: "Why was this removed?" },
  { id: "3", path: "src/c.md", newStart: 3, newEnd: 3, quoted: "+```js", body: "fence", sentAt: 5 },
];
const unsent = unsentComments(comments);
assert.deepEqual(unsent.map((c) => c.id), ["1", "2"]);
const message = composeLineCommentsMessage(unsent);
assert.equal(
  message,
  [
    "[Plyloft] Review comments on this card's changes (2). Please address each one in this worktree. " +
      "Line numbers are from the card's last committed version of each file; removed lines are numbered in the base version. " +
      "If the code has moved since, find the place by the quoted lines.",
    "",
    "1. src/a.ts, lines 11–12",
    "```diff",
    "+new a",
    "+new b",
    "```",
    "Comment: Name this after what it holds.",
    "",
    "2. src/b.ts, removed lines 41–42 of the base version",
    "```diff",
    "-drop41",
    "-drop42",
    "```",
    "Comment: Why was this removed?",
  ].join("\n"),
);
// A quote holding a fence gets a longer one.
assert.match(composeLineCommentsMessage([comments[2]]), /\n````diff\n\+```js\n````\n/);
assert.match(composeLineCommentsMessage([comments[0]]), /\(1\)\. Please address it in/);

// ── Send to Builder ────────────────────────────────────────────────────

type Log = string[];
function sendDeps(
  over: Partial<LineCommentSendDeps> & { open?: boolean; recorded?: boolean; attachAfterResume?: boolean },
): { deps: LineCommentSendDeps; log: Log } {
  const log: Log = [];
  let open = over.open ?? true;
  let held = false;
  const deps: LineCommentSendDeps = {
    claim: () => {
      if (held) return false;
      held = true;
      return true;
    },
    queued: () => log.push("state:queued"),
    release: () => {
      held = false;
    },
    shipping: () => false,
    comments: () => comments,
    hasBuilder: () => true,
    sessionOpen: () => open,
    sessionRecorded: () => over.recorded ?? open,
    resume: async () => {
      log.push("resume");
      if (over.attachAfterResume !== false) open = true;
    },
    waitForSession: async () => {
      log.push("wait");
      return open;
    },
    deliver: (text) => {
      log.push(`deliver:${text.split("\n")[0].slice(0, 48)}`);
      return Promise.resolve();
    },
    markSent: async (ids) => {
      log.push(`mark:${ids.join(",")}`);
    },
    notify: (kind, title) => log.push(`${kind}:${title}`),
    ...over,
  };
  return { deps, log };
}

async function sendTests() {
  // A live session: one paste, then marked sent — only the unsent ones.
  {
    const { deps, log } = sendDeps({});
    assert.equal(await sendLineComments(deps), "sent");
    assert.deepEqual(log, [
      "deliver:[Plyloft] Review comments on this card's changes",
      "mark:1,2",
      "info:Sent to the Builder",
    ]);
  }
  // A closed session: resumed in the same worktree first, then the paste.
  {
    const { deps, log } = sendDeps({ open: false, recorded: false });
    assert.equal(await sendLineComments(deps), "sent");
    assert.deepEqual(log.slice(0, 3), ["resume", "wait", "deliver:[Plyloft] Review comments on this card's changes"]);
  }
  // A session recorded on the card whose terminal is not attached yet is
  // waited for, never resumed a second time.
  {
    const { deps, log } = sendDeps({ open: false, recorded: true, waitForSession: async () => false });
    assert.equal(await sendLineComments(deps), "failed");
    assert.ok(!log.includes("resume"));
    assert.ok(log.includes("warn:The Builder session didn't open"));
    assert.ok(!log.some((l) => l.startsWith("mark:")));
  }
  // A refused resume: nothing written, nothing marked.
  {
    const { deps, log } = sendDeps({
      open: false,
      recorded: false,
      resume: async () => {
        throw new Error("drain");
      },
    });
    assert.equal(await sendLineComments(deps), "failed");
    assert.ok(!log.some((l) => l.startsWith("deliver") || l.startsWith("mark")));
  }
  // Held for the prompt: said so; marked only once written.
  {
    let release!: () => void;
    const { deps, log } = sendDeps({
      deliver: (_text, onQueued) => {
        onQueued();
        return new Promise<void>((r) => (release = r));
      },
    });
    const done = sendLineComments(deps);
    await Promise.resolve();
    assert.deepEqual(log, ["state:queued", "info:Queued for the Builder"]);
    // A second press while the first is held sends nothing.
    assert.equal(await sendLineComments(deps), "busy");
    assert.equal(log.filter((l) => l.startsWith("deliver")).length, 0);
    release();
    assert.equal(await done, "sent");
    assert.ok(log.includes("mark:1,2"));
  }
  // The write failed or the session ended first: kept unsent.
  {
    const { deps, log } = sendDeps({ deliver: () => Promise.reject(new Error("session ended")) });
    assert.equal(await sendLineComments(deps), "failed");
    assert.ok(log.includes("error:The comments did not reach the Builder"));
    assert.ok(!log.some((l) => l.startsWith("mark")));
  }
  // No session to deliver into after all.
  {
    const { deps } = sendDeps({ deliver: () => null });
    assert.equal(await sendLineComments(deps), "failed");
  }
  // Nothing unsent; no Builder.
  {
    const { deps, log } = sendDeps({ comments: () => [comments[2]] });
    assert.equal(await sendLineComments(deps), "nothing");
    assert.deepEqual(log, []);
    const none = sendDeps({ hasBuilder: () => false });
    assert.equal(await sendLineComments(none.deps), "no-builder");
    assert.ok(!none.log.some((l) => l.startsWith("deliver")));
  }
  // Written, but the mark failed: reported as sent, with the warning.
  {
    const { deps, log } = sendDeps({
      markSent: async () => {
        throw new Error("disk");
      },
    });
    assert.equal(await sendLineComments(deps), "sent");
    assert.ok(log.includes("warn:Sent to the Builder, but not marked sent"));
  }
  // The slot is given back after a failure too.
  {
    const { deps } = sendDeps({ deliver: () => Promise.reject(new Error("x")) });
    assert.equal(await sendLineComments(deps), "failed");
    assert.equal(deps.claim(), true);
  }
  // Shipping: nothing sent, the comments kept.
  {
    const { deps, log } = sendDeps({ shipping: () => true, open: false, recorded: false });
    assert.equal(await sendLineComments(deps), "busy");
    assert.deepEqual(log, ["warn:The card is being shipped"]);
  }
  // Too long for one message: refused with words, nothing resumed or written.
  {
    const big: SendableComment[] = Array.from({ length: 12 }, (_, i) => ({
      id: `b${i}`,
      path: "src/big.ts",
      newStart: 1,
      newEnd: 1,
      quoted: "+" + "x".repeat(QUOTE_MAX_CHARS - 1),
      body: "shorten",
    }));
    assert.ok(composeLineCommentsMessage(big).length > MESSAGE_MAX_CHARS);
    const { deps, log } = sendDeps({ comments: () => big, open: false, recorded: false });
    assert.equal(await sendLineComments(deps), "too-long");
    assert.deepEqual(log, ["warn:Too much to send in one message"]);
  }
  // waitUntil: true once ready, false after the timeout.
  {
    let n = 0;
    assert.equal(await waitUntil(() => ++n >= 3, 1000, async () => {}), true);
    assert.equal(await waitUntil(() => false, 300, async () => {}), false);
  }
}

await sendTests();
console.log("lineComments: ok");

// v1.154.1 (walk F21): each line's accessible name and the keyboard's steps.
assert.equal(rowLabel("src/a.ts", rows[2]), "src/a.ts, added line 11: new a");
assert.equal(rowLabel("src/a.ts", rows[1]), "src/a.ts, removed line 11 of the base version: gone");
assert.equal(rowLabel("src/a.ts", rows[0]), "src/a.ts, unchanged line 10: keep");
assert.equal(
  rowLabel("src/a.ts", rows[5]),
  "src/a.ts, unchanged line 42 (line 40 of the base version): ctx40",
);
assert.equal(rowLabel("x", { ...rows[2], text: "+   " }), "x, added line 11: (empty line)");
assert.equal(stepSelectable(rows, 0, 1), 1);
assert.equal(stepSelectable(rows, 0, -1), 0);
// The meta line is never a stop.
assert.equal(stepSelectable(rows, 8, 1), 8);
assert.equal(stepSelectable(rows, 3, Infinity), 8);
assert.equal(stepSelectable(rows, 3, -Infinity), 0);
assert.equal(stepSelectable([], 0, 1), 0);
