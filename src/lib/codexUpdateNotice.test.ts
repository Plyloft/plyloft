import assert from "node:assert/strict";

import type { CodexUpdateDone } from "./codexUpdateIpc.ts";
import { codexStartWaitText, codexUpdateToast } from "./codexUpdateNotice.ts";

// 1.176.0 R5: the words of the automatic Codex update. The backend decides
// whether to speak (`notice`); these are what it says.

function done(overrides: Partial<CodexUpdateDone> = {}): CodexUpdateDone {
  return {
    outcome: "succeeded",
    cause: null,
    causePath: null,
    versionBefore: "0.170.0",
    versionAfter: "0.171.0",
    exitCode: 0,
    starts: true,
    notice: null,
    command: "codex update",
    tail: [],
    ...overrides,
  };
}

// Nothing to say: nothing newer, already said, a stopped run.
assert.equal(codexUpdateToast(done()), null);
assert.equal(codexUpdateToast(done({ outcome: "nothing-newer", notice: null })), null);

// A newer Codex runs: today's one quiet line, kept.
assert.deepEqual(codexUpdateToast(done({ notice: "updated" })), {
  kind: "info",
  title: "Codex is up to date",
  body: "Detected 0.171.0.",
});

// Still on the old version, the network didn't answer: a calm warning with
// R2's cause sentence, what still works and the way on.
const offline = codexUpdateToast(
  done({
    outcome: "still-on-old-version",
    cause: "network",
    versionAfter: "0.170.0",
    exitCode: 1,
    notice: "still-works",
    tail: ["curl: (6) Could not resolve host: chatgpt.com"],
  }),
);
assert.ok(offline);
assert.equal(offline.kind, "warn");
assert.equal(offline.title, "Codex wasn't updated");
assert.equal(
  offline.body,
  "The network didn't answer. Codex still works, on version 0.170.0. Plyloft tries again tomorrow. To update it now, use Update in Diagnostics. Details has the reason.",
);
assert.deepEqual(offline.action, { label: "Open Diagnostics", opens: "diagnostics" });
assert.equal(offline.details, "codex update\ncurl: (6) Could not resolve host: chatgpt.com");

// A refused folder: R2's words, and no "tries again" (it wouldn't help).
const refused = codexUpdateToast(
  done({
    outcome: "still-on-old-version",
    cause: "permissions",
    causePath: "/Users/u/.local/bin",
    exitCode: 1,
    versionAfter: "0.170.0",
    notice: "still-works",
    tail: ["ln: /Users/u/.local/bin/.codex.1: Permission denied"],
  }),
);
assert.ok(refused);
assert.match(refused.body, /^The computer didn't let Codex's updater change the folder \/Users\/u\/\.local\/bin\. /);
assert.match(refused.body, /Ask whoever manages this computer, or install it yourself\./);
assert.doesNotMatch(refused.body, /tries again/);

// Stopped at its time limit: no npm advice, whatever the channel.
const slow = codexUpdateToast(
  done({ outcome: "timed-out", cause: "timed-out", versionAfter: "0.170.0", notice: "still-works", tail: ["…"] }),
);
assert.ok(slow);
assert.match(slow.body, /^Codex's updater took too long and was stopped\. Codex still works, on version 0\.170\.0\./);
assert.doesNotMatch(slow.body, /npm/);

// An older copy answers now.
const older = codexUpdateToast(
  done({ outcome: "older-version-now", versionBefore: "0.171.0", versionAfter: "0.160.0", notice: "still-works" }),
);
assert.ok(older);
assert.match(older.body, /^Codex's update didn't finish\. An older copy of Codex answers now: version 0\.160\.0, where it was 0\.171\.0\./);

// Codex doesn't start after it: an error with Repair as the way on.
const broken = codexUpdateToast(
  done({ outcome: "failed", cause: "unknown", versionAfter: null, starts: false, notice: "not-starting", tail: ["x"] }),
);
assert.ok(broken);
assert.equal(broken.kind, "error");
assert.equal(broken.title, "Codex wasn't updated, and it doesn't start now");
assert.equal(broken.body, "Codex's update didn't finish. Codex tiles won't start until it's repaired. Details has the reason.");
assert.deepEqual(broken.action, { label: "Repair Codex", opens: "repair" });

// A tile's start that waits for the update says so; otherwise nothing.
assert.equal(codexStartWaitText(false), null);
assert.equal(codexStartWaitText(true), "Codex is updating. This tile starts as soon as it's done, or in about two minutes.");

// A clean exit that left the old version (the run only starts when a newer
// one is known): R2's "said it finished" words, told once.
const quiet = codexUpdateToast(done({ outcome: "still-on-old-version", cause: "unknown", versionAfter: "0.170.0", notice: "still-works" }));
assert.ok(quiet);
assert.match(quiet.body, /^Codex's updater said it finished, but the old version still runs\. Codex still works, on version 0\.170\.0\./);

console.log("codexUpdateNotice.test.ts ✓");
