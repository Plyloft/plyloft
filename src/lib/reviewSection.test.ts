// 1.172.0 (C2; CP-19): the overlap chip under Now on Ready to ship, and the
// Review's words. Run with:
//   node --experimental-strip-types src/lib/reviewSection.test.ts
import assert from "node:assert/strict";
import {
  CHECK_IT_FIRST_LABEL,
  REVIEW_SECTION_TITLE,
  SEE_THE_CHECKS_LABEL,
  SEE_THE_REVIEW_LABEL,
  REVIEW_SHIP_MENU_LABEL,
  overlapChipWords,
  reviewShipName,
} from "./reviewSection.ts";

const card = (title: string, files: string[]) => ({ kind: "local_card" as const, otherId: title, otherTitle: title, files });
const pr = (title: string, files: string[]) => ({ kind: "teammate_pr" as const, otherId: title, otherTitle: title, files });

assert.equal(overlapChipWords([], "main"), null, "nothing overlaps: no chip");
assert.equal(
  overlapChipWords([card("Login page", ["src/auth.ts"])], "main"),
  "“Login page” also changes a file this card changes. Ship one, then Bring in main's changes on the other.",
);
assert.equal(
  overlapChipWords([card("Login page", ["a.ts", "b.ts"]), pr("Fix auth", ["a.ts"])], "develop"),
  "“Login page” and 1 more also change files this card changes. Ship one, then Bring in develop's changes on the other.",
  "the card's own target names the Bring in",
);
assert.equal(
  overlapChipWords([pr("Fix auth", ["a.ts"])], null),
  "“Fix auth” (a teammate's pull request) also changes a file this card changes. Shipping both may conflict.",
  "a teammate's pull request is no card here to bring changes into",
);
assert.match(
  overlapChipWords([card("X", ["a"])], null)!,
  /Bring in your main branch's changes/,
  "no target read: the words Bring in itself uses",
);

// Challenger 1: the Review's Ship it has its own name, beginning with its label.
assert.equal(reviewShipName("Ship it"), "Ship it, from the Review");
assert.ok(reviewShipName("Ship it").startsWith("Ship it"));
assert.notEqual(REVIEW_SHIP_MENU_LABEL, "Other ways: Ship it");

// One noun per thing (CP-5): the review is never "the result".
for (const words of [REVIEW_SECTION_TITLE, CHECK_IT_FIRST_LABEL, SEE_THE_CHECKS_LABEL, SEE_THE_REVIEW_LABEL]) {
  assert.doesNotMatch(words, /result/i);
}

console.log("reviewSection: ok");
