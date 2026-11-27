// G2 (1.173.0): the shared words, and the saved role ids read for display.
//     node --experimental-strip-types src/lib/words.test.ts
import assert from "node:assert/strict";
import * as words from "./words.ts";
import { GLOSSARY } from "./glossary.ts";
import { SEND_FIXES_LABEL } from "./deliveryWords.ts";

// One module re-exports the others' words, unchanged.
assert.equal(words.GLOSSARY, GLOSSARY);
assert.equal(words.SEND_FIXES_LABEL, SEND_FIXES_LABEL);
assert.equal(typeof words.NEW_COPY_MENU, "string");

// The saved ids keep their names; the screen reads the Reviewer.
assert.equal(words.roleWord("challenger"), "Reviewer");
assert.equal(words.roleWord("builder"), "Builder");
assert.equal(words.roleWord("other"), "other");
assert.equal(words.ROLE_WORDS.challenger, words.REVIEWER);
// TX3 (D11): Next improvement's word is its own, and the glossary defines it.
assert.equal(words.SECOND_OPINION, "second opinion");
assert.equal(
  words.GLOSSARY[words.SECOND_OPINION],
  "A second opinion is Next improvement's second pass, by the other AI or by the same one in a separate session, that sets aside ideas that only add. It isn't the Reviewer, which reads a card's work.",
);
// TX3 round 1: a skipped-review line saved before 1.174.0 reads the new name.
assert.equal(
  words.reviewerWords("Last commit not reviewed by the Reviewer: its review was skipped (Check without the second AI\u2019s review)."),
  "Last commit not reviewed by the Reviewer: its review was skipped (Check without the Reviewer).",
);
assert.equal(
  words.reviewerWords("its review was skipped (Check without the second AI" + "'s review)."),
  "its review was skipped (Check without the Reviewer).",
);

// Text saved before 1.173.0 reads the new name.
assert.equal(
  words.reviewerWords("Last commit not reviewed by the Challenger: The Challenger's model was at capacity."),
  "Last commit not reviewed by the Reviewer: The Reviewer's model was at capacity.",
);
assert.equal(words.reviewerWords(null), null);
assert.equal(words.reviewerWords(undefined), undefined);
assert.equal(words.reviewerWords("challenger-reviewing"), "challenger-reviewing", "ids are not copy");

assert.equal(words.SUGGESTED_SKILL_CHANGE, "Suggested skill change");

console.log("words: ok");
