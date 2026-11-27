import assert from "node:assert/strict";
import { cardFromHeroText, HERO_TITLE_MAX } from "./boardHeroCard.ts";

// Short and complete: the title is all of it, and there are no notes.
assert.deepEqual(cardFromHeroText("Export reports as CSV"), { title: "Export reports as CSV" });
assert.deepEqual(cardFromHeroText("  Export reports as CSV.  "), { title: "Export reports as CSV" });
assert.equal(cardFromHeroText("   "), null);

// The walk's case: one sentence with file names in it. A dot inside a word
// ("sum.js") does not end the sentence; the long sentence is cut on a word
// boundary and the full text goes to the notes.
const walk =
  "Add calcHalf(value) to sum.js returning value / 2, with a test in sum.test.js.";
const fromWalk = cardFromHeroText(walk)!;
assert.ok(fromWalk.title.length <= HERO_TITLE_MAX + 1, fromWalk.title);
assert.ok(fromWalk.title.endsWith("…"));
assert.ok(walk.startsWith(fromWalk.title.slice(0, -1)));
assert.ok(!/\s…$/.test(fromWalk.title));
assert.equal(fromWalk.notes, walk);

// Several sentences: the first is the title, the paragraph the notes.
const para = "Add dark mode. It should follow the system setting and remember a choice.";
assert.deepEqual(cardFromHeroText(para), { title: "Add dark mode", notes: para });

// A line break ends the first sentence too.
assert.deepEqual(cardFromHeroText("Fix the signup bug\nIt fails on empty email"), {
  title: "Fix the signup bug",
  notes: "Fix the signup bug\nIt fails on empty email",
});

// One very long word is cut where it has to be.
const word = "x".repeat(90);
assert.equal(cardFromHeroText(word)!.title, `${"x".repeat(HERO_TITLE_MAX)}…`);
assert.equal(cardFromHeroText(word)!.notes, word);

// Challenger: leading punctuation is not a sentence, and nothing to name a
// card by is no card.
assert.equal(cardFromHeroText("?"), null);
assert.equal(cardFromHeroText("... !!"), null);
assert.deepEqual(cardFromHeroText("... fix the login"), { title: "fix the login" });
assert.deepEqual(cardFromHeroText("!!! Fix it now"), { title: "Fix it now" });

// A full stop ends the sentence only before a capital or at the end.
assert.deepEqual(cardFromHeroText("Fix the U.S. map please"), {
  title: "Fix the U.S. map please",
});
assert.deepEqual(cardFromHeroText("Fix the map. Then ship it."), {
  title: "Fix the map",
  notes: "Fix the map. Then ship it.",
});

// The cut counts code points, so an emoji at the edge is never split.
const emoji = `${"a".repeat(HERO_TITLE_MAX - 1)}🚀🚀 tail`;
const emojiTitle = cardFromHeroText(emoji)!.title;
assert.ok(!emojiTitle.includes("\uFFFD"));
assert.ok(Array.from(emojiTitle).every((ch) => ch !== "\uD83D" && ch !== "\uDE80"));
assert.equal(emojiTitle, `${"a".repeat(HERO_TITLE_MAX - 1)}🚀…`);

console.log("boardHeroCard.test.ts ✓");
