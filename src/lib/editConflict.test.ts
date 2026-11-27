import assert from "node:assert/strict";
import {
  BRIEF_ASKED_LINE,
  changedAgainNotice,
  conflictBody,
  conflictTitle,
  COPY_MINE_LABEL,
  droppedNotice,
  EDIT_CHOOSE_ACTION,
  EDIT_WAITS_LINE,
  editConflictOf,
  editInboxDetail,
  hasEditConflict,
  isEditInboxDetail,
  KEEP_MINE_LABEL,
  keptMineNotice,
  markedLines,
  notRecordedNotice,
  USE_GITHUBS_LABEL,
  versionHeadings,
  type EditConflict,
} from "./editConflict.ts";

// 1.175.0 (D3, mockup two-people.html#d3): the words of the question a card
// asks when a part of its issue changed on GitHub and here.
const NOW = Date.parse("2026-11-09T10:00:00Z");
const brief: EditConflict = { part: "brief", theirs: "Cut the welcome to two screens.\nKeep the \"Skip\" link on both.", who: "example-teammate", at: NOW - 4 * 60_000 };
const title: EditConflict = { part: "title", theirs: "Onboarding: welcome in two screens", who: "example-teammate", at: NOW - 4 * 60_000 };

assert.equal(conflictTitle(brief, NOW), "example-teammate changed the brief on GitHub 4 min ago");
assert.equal(conflictTitle(title, NOW), "example-teammate changed the title on GitHub 4 min ago");
assert.equal(conflictTitle({ ...brief, who: null }, NOW), "Someone else changed the brief on GitHub 4 min ago");
assert.equal(conflictTitle({ ...brief, who: null, at: null }, NOW), "Someone else changed the brief on GitHub");
assert.equal(
  conflictBody("brief", 70),
  "You changed it here too, before seeing that. Your version isn't on issue #70 yet. Which should the card keep?",
);
assert.equal(conflictBody("title", 70), "You changed it here too, before seeing that. Which should the card keep?");
assert.deepEqual(versionHeadings(brief), { theirs: "On GitHub now · example-teammate", mine: "Yours · this Mac" });
assert.deepEqual(versionHeadings({ ...brief, who: null }), { theirs: "On GitHub now", mine: "Yours · this Mac" });
assert.deepEqual(versionHeadings(title), { theirs: "On GitHub now", mine: "Yours" });
assert.deepEqual([USE_GITHUBS_LABEL, KEEP_MINE_LABEL], ["Use GitHub's", "Keep mine"]);
assert.equal(BRIEF_ASKED_LINE, "Start build sends the brief you see here. Your version stays on this Mac until you choose.");

// The two versions whole, with the lines the other doesn't have marked.
const mine = "Cut the welcome to two screens.\nThe second screen asks for the project folder.";
assert.deepEqual(markedLines(brief.theirs, mine), [
  { line: "Cut the welcome to two screens.", differs: false },
  { line: "Keep the \"Skip\" link on both.", differs: true },
]);
assert.deepEqual(markedLines(mine, brief.theirs).map((l) => l.differs), [false, true]);
assert.deepEqual(markedLines("a\n\nb", "a"), [
  { line: "a", differs: false },
  { line: "", differs: false },
  { line: "b", differs: true },
]);

// Which question a card has.
const card = { editConflicts: [title, brief] };
assert.equal(editConflictOf(card, "brief"), brief);
assert.equal(editConflictOf({ editConflicts: [title] }, "brief"), null);
assert.equal(hasEditConflict(card), true);
assert.equal(hasEditConflict({}), false);
assert.equal(hasEditConflict({ editConflicts: [] }), false);

// The Board and the Inbox.
assert.equal(EDIT_WAITS_LINE, "Changed on GitHub · your edit waits");
assert.equal(editInboxDetail(card), "The brief changed on GitHub · choose which version the card keeps");
assert.equal(editInboxDetail({ editConflicts: [title] }), "The title changed on GitHub · choose which version the card keeps");
assert.equal(editInboxDetail({}), null);
assert.ok(isEditInboxDetail(editInboxDetail(card)) && isEditInboxDetail(editInboxDetail({ editConflicts: [title] })));
assert.ok(!isEditInboxDetail("The work is done · review it") && !isEditInboxDetail(null));
assert.equal(EDIT_CHOOSE_ACTION, "Choose");

// The toasts.
assert.deepEqual(droppedNotice("brief"), {
  kind: "info",
  title: "Your change to the brief was dropped",
  body: "The card shows what is on GitHub.",
});
assert.equal(droppedNotice("title").title, "Your change to the title was dropped");
assert.equal(COPY_MINE_LABEL, "Copy what I wrote");
assert.deepEqual(keptMineNotice(brief, 70, NOW), {
  kind: "info",
  title: "Saved to issue #70",
  body: "Your brief replaced example-teammate’s change from 4 min ago.",
});
assert.equal(keptMineNotice({ ...title, who: null, at: null }, 70, NOW).body, "Your title replaced someone else’s change.");
assert.deepEqual(changedAgainNotice("brief"), {
  kind: "warn",
  title: "The brief changed on GitHub again",
  body: "Nothing was written. Look at the two versions again, then choose.",
});
// The backend's sentence leads its error; only the reason goes behind Details.
assert.deepEqual(notRecordedNotice("Plyloft couldn’t record your choice. Try again in a moment.\nHTTP 502: Bad Gateway"), {
  kind: "error",
  title: "Plyloft couldn’t record your choice",
  body: "Try again in a moment.",
  details: "HTTP 502: Bad Gateway",
});
assert.deepEqual(notRecordedNotice("Plyloft couldn’t record your choice. Try again in a moment."), {
  kind: "error",
  title: "Plyloft couldn’t record your choice",
  body: "Try again in a moment.",
});
for (const words of [conflictTitle(brief, NOW), conflictBody("brief", 70), EDIT_WAITS_LINE, BRIEF_ASKED_LINE]) {
  assert.ok(!/\bdiff\b|\bPR\b|origin|worktree/i.test(words), words);
}
console.log("editConflict (D3): ok");
