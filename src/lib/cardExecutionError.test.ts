// Tier 3 pure-function test. Run with Node 22+:
//   node --experimental-strip-types src/lib/cardExecutionError.test.ts
import assert from "node:assert/strict";
import {
  ATTEMPT_PENDING_MESSAGE,
  cardExecutionRefusalMessage,
  VERIFY_INFLIGHT_MESSAGE,
} from "./cardExecutionError.ts";

assert.equal(
  cardExecutionRefusalMessage(VERIFY_INFLIGHT_MESSAGE),
  VERIFY_INFLIGHT_MESSAGE,
);
assert.equal(
  cardExecutionRefusalMessage(new Error(ATTEMPT_PENDING_MESSAGE)),
  ATTEMPT_PENDING_MESSAGE,
);
assert.equal(
  cardExecutionRefusalMessage(`command failed: ${VERIFY_INFLIGHT_MESSAGE}`),
  VERIFY_INFLIGHT_MESSAGE,
);
assert.equal(cardExecutionRefusalMessage("provider failed to start"), null);
assert.equal(cardExecutionRefusalMessage({ message: VERIFY_INFLIGHT_MESSAGE }), null);

console.log("cardExecutionError: 5/5 passed");
