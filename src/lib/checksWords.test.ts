// GH #333: a pass with no steps is "no checks set up". Run with
// `node --experimental-strip-types src/lib/checksWords.test.ts`.
import assert from "node:assert/strict";
import type { VerifyEntry } from "../ipc.ts";
import { cardHasNoChecks, checkStepWords, entryHasNoChecks, verifyPassedMessage } from "./checksWords.ts";

const entry = (status: VerifyEntry["status"], steps: number): VerifyEntry => ({
  verifyRunId: `v-${status}-${steps}`,
  status,
  endedAt: 1,
  steps: Array.from({ length: steps }, () => ({ kind: "script", passed: status === "passed", elapsedMs: 1 })),
});

assert.equal(entryHasNoChecks(entry("passed", 0)), true);
assert.equal(entryHasNoChecks({ status: "passed" }), true);
assert.equal(entryHasNoChecks(entry("passed", 2)), false);
assert.equal(entryHasNoChecks(entry("failed", 0)), false);
assert.equal(entryHasNoChecks(entry("skipped", 0)), false);
assert.equal(entryHasNoChecks(null), false);

assert.equal(cardHasNoChecks({ verifyStatus: "passed", verifyHistory: [entry("passed", 0)] }), true);
// Only the last run counts: checks added since then ran and passed.
assert.equal(cardHasNoChecks({ verifyStatus: "passed", verifyHistory: [entry("passed", 0), entry("passed", 3)] }), false);
assert.equal(cardHasNoChecks({ verifyStatus: "passed", verifyHistory: [entry("passed", 3), entry("passed", 0)] }), true);
// No history keeps "Passed".
assert.equal(cardHasNoChecks({ verifyStatus: "passed" }), false);
assert.equal(cardHasNoChecks({ verifyStatus: "passed", verifyHistory: [] }), false);
// The skip-verify override is its own state.
assert.equal(cardHasNoChecks({ verifyStatus: "skipped", verifyHistory: [entry("skipped", 0)] }), false);
assert.equal(cardHasNoChecks({ verifyStatus: "failed", verifyHistory: [entry("passed", 0)] }), false);

// The Builder's message: zero steps never says "Verification passed".
assert.equal(
  verifyPassedMessage(0),
  "[Plyloft] No checks are set up for this project, so none ran. Nothing else is needed from you unless the review asks for changes.",
);
assert.match(verifyPassedMessage(1), /^\[Plyloft\] Verification passed \(1 check\)\./);
assert.match(verifyPassedMessage(3), /^\[Plyloft\] Verification passed \(3 checks\)\./);

// 1.172.0 D2 (CP-26): step names, never kinds.
assert.equal(checkStepWords("claude-qa"), "Claude's review");
assert.equal(checkStepWords("npm-test"), "npm tests");
assert.equal(checkStepWords("test"), "Tests");
assert.equal(checkStepWords("my-lint_step"), "My lint step");
assert.equal(checkStepWords(""), "Check");
assert.equal(checkStepWords("npm test"), "npm test");

console.log("checksWords: a pass with no steps is no checks set up");
