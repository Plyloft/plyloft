// G10 (1.170.0): one verb, plain words — the target by its name on this
// Mac (this PC on Windows) or on GitHub, and the words defined where they appear.
//     node --experimental-strip-types src/lib/glossary.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GLOSSARY, GLOSSARY_URL, glossaryWordsIn, termLabel, termTitle } from "./glossary.ts";
import { targetHere, targetName, targetOnGitHub } from "./worktreeBase.ts";
import { ONLY_HERE_LABEL, onlyHereHint, onlyHereInline, SHIP_NOTICE_BODY } from "./shipVia.ts";
import { machineWords } from "./platform.ts";
import { shipHereTitle } from "./cardLifecycle.ts";
import { presentCard } from "./cardPresentation.ts";
import { PRESENTATION_FIXTURES } from "./cardPresentation.fixtures.ts";

// The target by its real name; never "the target branch".
assert.equal(targetName("origin/staging"), "staging");
assert.equal(targetName(" main "), "main");
assert.equal(targetName(null), "your main branch");
assert.equal(targetHere("main"), "main on this Mac");
assert.equal(targetOnGitHub("origin/main"), "main on GitHub");
assert.equal(onlyHereHint("staging"), "Merges the card into staging on this Mac. It's in staging on this Mac only; GitHub doesn't have it.");
assert.equal(shipHereTitle("main"), "Merges this card into main on this Mac and runs the configured ship steps.");
assert.equal(shipHereTitle(null, true), "Merges this card into your main branch on this Mac again and runs the configured ship steps.");
// Challenger 8 (orchestrator): one wording, "on this Mac", which Windows
// reads as "this PC" — the label inside a sentence too.
assert.equal(machineWords(targetHere("main"), "windows"), "main on this PC");
assert.equal(machineWords(ONLY_HERE_LABEL, "windows"), "Only on this PC");
assert.equal(machineWords(`Or ship it ${onlyHereInline()}.`, "windows"), "Or ship it only on this PC.");
assert.equal(machineWords(SHIP_NOTICE_BODY, "windows").includes("Mac"), false);
assert.equal(machineWords(onlyHereHint("main"), "windows"), "Merges the card into main on this PC. It's in main on this PC only; GitHub doesn't have it.");

// The card's Now names the branch the card started from.
{
  const fx = PRESENTATION_FIXTURES.find((x) => x.name === "ready to ship (result read)")!;
  const card = { ...fx.card, worktreeBase: { refName: "staging", commit: "abc1234", source: "origin" } } as typeof fx.card;
  const here = presentCard(card, { ...fx.live, outcome: { ...fx.live.outcome!, prOffered: false } });
  assert.equal(here.action.title, "Merges this card into staging on this Mac and runs the configured ship steps.");
  const again = presentCard(card, { ...fx.live, outcome: { ...fx.live.outcome!, prOffered: false }, shipFailure: "ship-it" });
  assert.equal(again.action.title, "Merges this card into staging on this Mac again and runs the configured ship steps.");
}

// No visible copy calls it the target or the build branch any more.
for (const file of [
  "src/lib/cardLifecycle.ts",
  "src/lib/cardPresentation.ts",
  "src/lib/shipVia.ts",
  "src/lib/cardPage.ts",
  "src/lib/followUp.ts",
  "src/lib/shipConflict.ts",
  "src/components/OutcomeScreen.tsx",
  "src/components/CardReviewPanel.tsx",
  "src/components/ShipConflictDetails.tsx",
]) {
  const strings = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  for (const line of strings) {
    assert.ok(!/["`'][^"`']*\b(target|build) branch\b/i.test(line), `${file}: ${line.trim()}`);
  }
}

// The changes panel has no Merge of its own: Now's Ship ships the card.
assert.ok(!/Merge to \$\{/.test(readFileSync("src/components/CardReviewPanel.tsx", "utf8")));

// Words defined where they appear, in the order the sentence uses them.
assert.deepEqual(glossaryWordsIn("Shipped as pull request #9, open on GitHub.", ["pull request", "round"]), ["pull request"]);
assert.deepEqual(glossaryWordsIn("Pull requests carry round 2", ["round", "pull request"]), ["pull request", "round"]);
assert.deepEqual(glossaryWordsIn("Findings of Round 2: raised in it.", ["round"]), ["round"]);
assert.deepEqual(glossaryWordsIn("Nothing to define around here.", ["round"]), []);
assert.equal(termLabel("pull request"), "What a pull request is");
assert.match(termTitle("pull request"), /^A pull request is GitHub's request to add a change.* Press for the glossary\.$/);
assert.match(GLOSSARY.round, /Finish and check/);
assert.equal(GLOSSARY_URL, "https://www.plyloft.com/docs/guide/#words-youll-see");
// The guide's glossary has both words, under the heading the link names.
{
  const guide = readFileSync("docs/onboarding/USER_GUIDE.md", "utf8");
  assert.ok(guide.includes("### Words you'll see"));
  assert.ok(guide.includes("| **Pull request** |"));
  assert.ok(guide.includes("| **Round** |"));
  // 1.171.0 C3 (CF9, owner D1): the Challenger, in the card's own words.
  assert.ok(guide.includes("| **Reviewer** | A second AI that reviews the change; it can't edit. |"));
}
// 1.171.0 C3: the Challenger's mark, beside the card's facts-line label.
assert.equal(GLOSSARY.Reviewer, "The Reviewer is a second AI that reviews the change; it can't edit.");
assert.equal(termLabel("Reviewer"), "What the Reviewer is");
assert.deepEqual(glossaryWordsIn("Reviewer reviewing", ["Reviewer"]), ["Reviewer"]);

// B3 (owner D11): "second opinion" is Next improvement's word, defined
// apart from the Reviewer's.
assert.match(GLOSSARY["second opinion"], /^A second opinion is Next improvement's second pass, by the other AI/);
assert.match(GLOSSARY["second opinion"], /It isn't the Reviewer, which reads a card's work\.$/);
assert.equal(termLabel("second opinion"), "What a second opinion is");
assert.deepEqual(glossaryWordsIn("Set aside by the second opinion (2)", ["second opinion", "Reviewer"]), ["second opinion"]);

console.log("glossary: ok");
