// 1.172.0 (A1): the words of the card's later requests.
import assert from "node:assert/strict";
import {
  LATER_REQUESTS_INTRO,
  laterRequestMeta,
  laterRequestRemoveName,
  laterRequestSourceWords,
  laterRequestsHeading,
} from "./laterRequests.ts";

assert.equal(laterRequestsHeading(2), "Asked later (2)");
assert.match(LATER_REQUESTS_INTRO, /Reviewer checks the work against these/);
assert.equal(laterRequestSourceWords("notRight"), "Not right");
assert.equal(laterRequestSourceWords("changes"), "Request changes");
assert.equal(laterRequestSourceWords("chat"), "Ask about this card");
assert.equal(laterRequestSourceWords("other"), null);
const at = new Date(2026, 9, 27, 9, 5).getTime();
assert.equal(laterRequestMeta({ at, source: "chat" }, at), "27 Oct, 09:05 · from Ask about this card");
assert.equal(laterRequestMeta({ at, source: "other" }, at), "27 Oct, 09:05");
assert.equal(laterRequestMeta({ at, source: "notRight" }, new Date(2027, 0, 1).getTime()), "27 Oct 2026, 09:05 · from Not right");
assert.equal(laterRequestRemoveName(" make it  blue "), 'Remove "make it blue"');
assert.equal(laterRequestRemoveName("x".repeat(50)), `Remove "${"x".repeat(40)}…"`);
console.log("laterRequests: all assertions passed");
