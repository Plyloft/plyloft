import assert from "node:assert/strict";
import {
  codexApprovalSummary,
  codexEventBelongsToSession,
} from "./codexApprovalPolicy.ts";

const summary = codexApprovalSummary({
  id: 9,
  method: "item/fileChange/requestApproval",
  params: {
    reason: "Create generated assets",
    grantRoot: "/work/project/generated",
  },
});
assert.match(summary.detail, /\/work\/project\/generated/);
assert.match(summary.detail, /Create generated assets/);

assert.equal(codexEventBelongsToSession("tile-1", null, "tile-1", 41), true);
assert.equal(codexEventBelongsToSession("tile-1", 41, "tile-1", 41), true);
assert.equal(codexEventBelongsToSession("tile-1", 41, "tile-1", 42), false);
assert.equal(codexEventBelongsToSession("tile-1", null, "tile-2", 41), false);

console.log("codexApprovalPolicy.test.ts ✓");
