// GH #309: History's Result words. Run with
// `node --experimental-strip-types src/lib/historyWords.test.ts`.
import assert from "node:assert/strict";
import { HISTORY_RESULTS, historyResult, typicalRun } from "./historyWords.ts";

const expected: Record<string, string> = {
  running: "Running",
  preparing: "Preparing",
  generating: "Generating",
  pending_generation: "Waiting to start",
  done: "Done",
  completed: "Done",
  resolved: "Resolved",
  shipped: "Shipped",
  built: "Built",
  working: "Working",
  passed: "Checks passed",
  no_checks: "No checks set up",
  failed: "Failed",
  generation_failed: "Failed to start",
  killed: "Stopped",
  aborted: "Stopped",
  interrupted: "Stopped",
  timed_out: "Timed out",
  max_iter: "Hit the step limit",
  paused_provider_unavailable: "Paused — provider unavailable",
  suspended: "Paused",
};
assert.deepEqual(
  Object.fromEntries(Object.entries(HISTORY_RESULTS).map(([k, v]) => [k, v.word])),
  expected,
);
for (const [state, word] of Object.entries(expected)) {
  assert.equal(historyResult(state).word, word);
  assert.doesNotMatch(word, /_/);
}
// The words the audit found derived from the state string are gone.
for (const state of ["max_iter", "paused_provider_unavailable", "generation_failed", "pending_generation"]) {
  const derived = (state.charAt(0).toUpperCase() + state.slice(1)).replace(/_/g, " ");
  assert.notEqual(historyResult(state).word, derived, state);
}
assert.deepEqual(historyResult("something_new"), { state: "empty", word: "Unknown" });
assert.equal(historyResult("toString").word, "Unknown");
assert.equal(historyResult("max_iter").state, "aborted");
assert.equal(historyResult("running").state, "running");
assert.equal(historyResult("working").state, "running");

assert.equal(typicalRun(23 * 60), "23m");
assert.equal(typicalRun(3 * 3600 + 5), "3h");
assert.equal(typicalRun(40), "Under a minute");

console.log("historyWords: Result words passed");
