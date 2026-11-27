// Tier 3 pure-function test. Run with Node 22+:
//   node --experimental-strip-types src/lib/boardCommands.test.ts
import assert from "node:assert/strict";
import { boardNewTaskTarget } from "./boardCommands.ts";

assert.equal(boardNewTaskTarget(false, 0), "pending");
assert.equal(boardNewTaskTarget(false, 3), "pending");
assert.equal(boardNewTaskTarget(true, 0), "hero");
assert.equal(boardNewTaskTarget(true, 1), "todo");
assert.equal(boardNewTaskTarget(true, 9), "todo");

console.log("boardNewTaskTarget: 5/5 passed");
