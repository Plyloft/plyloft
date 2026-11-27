import assert from "node:assert/strict";
import {
  negotiatedIntakeGrid,
  nextIntakeResize,
  type IntakeResizeState,
} from "./intakeResize.ts";

const initial = negotiatedIntakeGrid({ cols: 120, rows: 40 });
assert.deepEqual(initial, {
  lastRequested: { cols: 120, rows: 40 },
  resizeEpoch: 0,
});

const redundant = nextIntakeResize(initial, { cols: 120, rows: 40 });
assert.equal(redundant.request, false);
assert.equal(redundant.state, initial);

const changed = nextIntakeResize(initial, { cols: 100, rows: 32 });
assert.equal(changed.request, true);
assert.deepEqual(changed.state, {
  lastRequested: { cols: 100, rows: 32 },
  resizeEpoch: 1,
});

const restored = nextIntakeResize(changed.state, { cols: 120, rows: 40 });
assert.equal(restored.request, true);
assert.equal(restored.state.resizeEpoch, 2);

const missingAuthority: IntakeResizeState = {
  lastRequested: null,
  resizeEpoch: null,
};
const retry = nextIntakeResize(missingAuthority, { cols: 120, rows: 40 });
assert.equal(retry.request, true);
assert.equal(
  retry.state.resizeEpoch,
  null,
  "a later resize must not manufacture authority after initial failure",
);

console.log("intakeResize.test.ts: all assertions passed");
