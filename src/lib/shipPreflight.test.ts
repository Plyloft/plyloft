// Tier 3 pure-function test. Run with Node 22+:
//   node --experimental-strip-types src/lib/shipPreflight.test.ts
import assert from "node:assert/strict";
import {
  decodeTargetDirtyError,
  targetDirtyMessage,
  targetDirtyToastBody,
  TARGET_DIRTY_ERROR_PREFIX,
} from "./shipPreflight.ts";

const payload = {
  totalCount: 103,
  paths: ["a.txt", "renamed.txt"],
  truncated: true,
};
const encoded = `${TARGET_DIRTY_ERROR_PREFIX}${JSON.stringify(payload)}`;

assert.deepEqual(decodeTargetDirtyError(encoded), payload);
assert.deepEqual(decodeTargetDirtyError(new Error(encoded)), payload);
assert.equal(decodeTargetDirtyError("workspace dirty"), null);
assert.equal(decodeTargetDirtyError(`${TARGET_DIRTY_ERROR_PREFIX}{`), null);
assert.equal(
  decodeTargetDirtyError(
    `${TARGET_DIRTY_ERROR_PREFIX}${JSON.stringify({
      totalCount: -1,
      paths: [],
      truncated: false,
    })}`,
  ),
  null,
);
assert.equal(
  decodeTargetDirtyError(
    `${TARGET_DIRTY_ERROR_PREFIX}${JSON.stringify({
      totalCount: 1,
      paths: [7],
      truncated: false,
    })}`,
  ),
  null,
);
assert.equal(
  targetDirtyMessage({
    totalCount: 1,
    paths: ["one.txt"],
    truncated: false,
  }),
  "Your project folder has 1 changed file that isn't in a commit, so Plyloft won't ship into it. Commit it or undo it, then ship again.",
);
assert.equal(
  targetDirtyMessage(payload),
  "Your project folder has 103 changed files that aren't in a commit, so Plyloft won't ship into it. Showing the first 2. Commit them or undo them, then ship again.",
);

// TX5 (T31): the toast's body names its own press.
assert.equal(
  targetDirtyToastBody({ totalCount: 1, paths: ["one.txt"], truncated: false }),
  "1 changed file in your project folder isn't saved in a commit, so Plyloft won't ship into it. Show them opens it, and Claude can save it for you; then ship again.",
);
assert.equal(
  targetDirtyToastBody({ totalCount: 3, paths: ["a", "b", "c"], truncated: false }),
  "3 changed files in your project folder aren't saved in a commit, so Plyloft won't ship into it. Show them opens them, and Claude can save them for you; then ship again.",
);
assert.equal(
  targetDirtyToastBody(payload),
  "103 changed files in your project folder aren't saved in a commit, so Plyloft won't ship into it. Showing the first 2. Show them opens them, and Claude can save them for you; then ship again.",
);

console.log("shipPreflight: 11/11 passed");
