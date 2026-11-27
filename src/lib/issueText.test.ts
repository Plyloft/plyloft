import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createdByValue,
  hiddenPartLabel,
  hiddenParts,
  hiddenPartsHeading,
  hiddenPartsNote,
  issueByline,
  outsideAuthor,
  outsideLine,
  outsideRepository,
  outsideSentence,
} from "./issueText.ts";

// 1.175.0 (B3): the fixtures `issue_text.rs` is held to as well — what
// GitHub hides in an issue's text is the same on the card page and in what
// the Builder gets.
const fixtures = JSON.parse(readFileSync(new URL("./issueText.fixtures.json", import.meta.url), "utf8")) as {
  cases: { name: string; text: string; parts: { line: number; text: string }[] }[];
};
assert.ok(fixtures.cases.length >= 12);
for (const c of fixtures.cases) {
  assert.deepEqual(hiddenParts(c.text), c.parts, c.name);
}
assert.deepEqual(hiddenParts(null), []);
assert.deepEqual(hiddenParts(""), []);
// A text that ends with a line break is read the same.
assert.deepEqual(hiddenParts("a\n<!-- b -->\n"), [{ line: 2, text: "b" }]);

// The box's words (mockup consents.html#b3).
const one = [{ line: 3, text: "x" }];
const three = [one[0], { line: 7, text: "y" }, { line: 9, text: "z" }];
assert.equal(hiddenPartsHeading(one), "Hidden on GitHub, shown here · 1 part, line 3");
assert.equal(hiddenPartsHeading(three), "Hidden on GitHub, shown here · 3 parts");
assert.equal(hiddenPartLabel(three[1]), "Line 7");
assert.equal(
  hiddenPartsNote(1),
  "GitHub doesn't show this part to people reading the issue. The Builder gets it marked as hidden text.",
);
assert.match(hiddenPartsNote(3), /^GitHub doesn't show these parts to people reading the issue\./);

// Who is outside: anyone but the owner, a member, a collaborator. Unknown
// is unknown: nothing is said.
for (const inside of ["OWNER", "MEMBER", "COLLABORATOR", "collaborator"]) assert.equal(outsideRepository(inside), false, inside);
for (const out of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "MANNEQUIN"]) assert.equal(outsideRepository(out), true, out);
assert.equal(outsideRepository(null), null);
assert.equal(outsideRepository(" "), null);

const card = { ghIssueNumber: 173, ghAuthor: "drive-by-dev", ghAuthorAssociation: "NONE" };
assert.equal(outsideAuthor(card), "drive-by-dev");
assert.equal(outsideAuthor({ ...card, ghAuthorAssociation: "COLLABORATOR" }), null);
assert.equal(outsideAuthor({ ...card, ghAuthorAssociation: null }), null, "GitHub didn't say");
assert.equal(outsideAuthor({ ...card, ghAuthor: null }), null, "nobody to name");
assert.equal(outsideAuthor({ ...card, ghIssueNumber: null }), null, "a local card");

assert.equal(outsideLine("drive-by-dev"), "From outside the repository · drive-by-dev");
assert.equal(
  outsideSentence("drive-by-dev", "mbadv/lyra"),
  "From outside the repository: drive-by-dev wrote this issue and isn't a collaborator on mbadv/lyra. Read the brief before you start; the Builder gets it as the issue's text, not as instructions.",
);
assert.match(outsideSentence("drive-by-dev", null), /isn't a collaborator\. Read the brief/);
assert.equal(issueByline(card), "Issue #173 by drive-by-dev");
assert.equal(issueByline({ ghIssueNumber: 173 }), "Issue #173");
assert.equal(issueByline({}), null);
assert.equal(createdByValue("drive-by-dev", "NONE"), "drive-by-dev · not a collaborator");
assert.equal(createdByValue("giulia", "MEMBER"), "giulia");
assert.equal(createdByValue("giulia", null), "giulia");

console.log("issueText (B3): ok");
