import assert from "node:assert/strict";
import { teammateWork, teammateWorkError } from "./teammateWork.ts";
import { cardActionError } from "./cardPage.ts";
import { errorForMachine } from "./uxError.ts";

// 1.175.0 (D1, mockup two-people.html#d1 1.4): the three variants of the
// Ship box when a teammate got there first — the sentences are
// `second_claim.rs`'s (`TeammateWork::refusal`, `name_who_pushed`).

const BRANCH = "plyloft/card-ghissue161-fix-login-redirect";
const OPEN =
  "Pull request #178 by example-teammate is already open for this card, from a branch with the same name as yours. Nothing was sent to GitHub. https://github.com/o/r/pull/178";
const OPEN_OTHER_BRANCH =
  "Pull request #178 by example-teammate is already open for this card. Nothing was sent to GitHub. https://github.com/o/r/pull/178";
const MERGED =
  "Pull request #178 by example-teammate was merged for this card, and issue #161 is closed. Nothing was sent to GitHub. https://github.com/o/r/pull/178";
const GIT = "couldn't push the branch to the remote:  ! [rejected] abc -> plyloft/card (fetch first)";
const PUSHED = `example-teammate already pushed work for this card to GitHub, on a branch with the same name as yours. Nothing was sent to GitHub. https://github.com/o/r/tree/${BRANCH}\n${GIT}`;

assert.deepEqual(teammateWork(OPEN), {
  kind: "open",
  number: 178,
  login: "example-teammate",
  sameBranch: true,
  url: "https://github.com/o/r/pull/178",
});
assert.deepEqual(teammateWork(OPEN_OTHER_BRANCH), { ...teammateWork(OPEN), sameBranch: false });
assert.deepEqual(teammateWork(MERGED), {
  kind: "merged",
  number: 178,
  login: "example-teammate",
  issue: 161,
  url: "https://github.com/o/r/pull/178",
});
assert.deepEqual(teammateWork(PUSHED), {
  kind: "pushed",
  login: "example-teammate",
  url: `https://github.com/o/r/tree/${BRANCH}`,
  raw: GIT,
});
// Anything else is not a teammate's work: git's refusal alone stays "moved".
assert.equal(teammateWork(GIT), null);
assert.equal(teammateWork("Pull request #178 by example-teammate is open for this card."), null);
assert.equal(teammateWork(""), null);

// The box: the press's own title, the mockup's words, no "Try again", and
// the full button opens the teammate's page.
const ship = (raw: string) => cardActionError("Ship it", raw, { retry: true, github: true });
{
  const box = ship(OPEN);
  assert.deepEqual(box, {
    title: "Ship it didn't go through.",
    happened: "Pull request #178 by example-teammate is already open for this card, from a branch with the same name as yours.",
    untouched: "Nothing was sent to GitHub. Your work is safe in this card's copy on this Mac.",
    todo: "Look at pull request #178 and agree with example-teammate which work ships. Plyloft never overwrites a teammate's branch.",
    actions: [
      { id: "open-github", label: "Open pull request #178", primary: true, url: "https://github.com/o/r/pull/178" },
      { id: "dismiss", label: "Dismiss" },
    ],
    details: null,
  });
  assert.equal(
    ship(OPEN_OTHER_BRANCH).happened,
    "Pull request #178 by example-teammate is already open for this card.",
    "said of the same branch name only when it is",
  );
  // Windows: this PC, where the box is drawn.
  assert.equal(
    errorForMachine(box, "windows").untouched,
    "Nothing was sent to GitHub. Your work is safe in this card's copy on this PC.",
  );
}
{
  const box = ship(MERGED);
  assert.equal(box.happened, "Pull request #178 by example-teammate was merged for this card, and issue #161 is closed.");
  assert.equal(box.todo, "If your work is still needed, make a new card for it; this card's copy keeps your commits.");
  assert.deepEqual(
    box.actions.map((a) => a.label),
    ["Open pull request #178", "Dismiss"],
  );
}
{
  const box = ship(PUSHED);
  assert.equal(
    box.happened,
    "example-teammate already pushed work for this card to GitHub, on a branch with the same name as yours.",
  );
  assert.equal(box.todo, "Agree with example-teammate which work ships. Plyloft never overwrites a teammate's branch.");
  assert.deepEqual(box.actions, [
    { id: "open-github", label: "Open on GitHub", primary: true, url: `https://github.com/o/r/tree/${BRANCH}` },
    { id: "dismiss", label: "Dismiss" },
  ]);
  assert.equal(box.details, GIT, "git's own answer stays behind Details");
}
for (const raw of [OPEN, MERGED, PUSHED]) {
  const box = ship(raw);
  assert.ok(!box.actions.some((a) => a.id === "retry" || /try again/i.test(a.label)), "pressing again would be refused again");
  assert.ok(!/press Ship it again|Try again/.test(box.todo));
  for (const words of [box.happened, box.untouched, box.todo]) {
    assert.ok(!/\bPR\b|origin|worktree|fetch first/.test(words), words);
  }
}
// A branch that moved on and nobody is named: as before 1.175.0.
{
  const box = ship(GIT);
  assert.equal(box.happened, "The branch on GitHub has commits this card doesn't.");
  assert.match(box.todo, /^Look at the branch on GitHub; Plyloft never overwrites it\./);
}
// The same box under another press's title.
assert.equal(teammateWorkError("The pull request didn't open.", teammateWork(OPEN)!).title, "The pull request didn't open.");

console.log("teammateWork (D1 Ship): ok");
