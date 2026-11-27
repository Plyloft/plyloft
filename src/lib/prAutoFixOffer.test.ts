// 1.175.0 F7 (UX-7; owner I9): when the "Turn on" offer for "Fix failing
// checks by itself" shows, and its words.
import assert from "node:assert/strict";
import { OFFER_LINE, TURNED_ON_LINE, autoFixOffered, offerLine, turnedOnShown } from "./prAutoFixOffer.ts";

const base = {
  prReview: null,
  prAutoFix: null,
  prUrl: "https://github.com/o/r/pull/8",
  archived: false,
  builder: { vendor: "claude", bypass: false, startedAt: 0, snapshots: [] },
  pr: { number: 8, state: "open", checks: "failing" },
} as never as Parameters<typeof autoFixOffered>[0];
const off = { fixFailingChecks: false };

assert.equal(autoFixOffered(base, off), true, "the first failed check on a pull request of the project");
assert.equal(autoFixOffered(base, undefined), true);
assert.equal(autoFixOffered(base, { ...off, fixFailingChecksOffered: true }), false, "answered (Turn on or Not now): never again here");
assert.equal(autoFixOffered({ ...base, prReview: { number: 3 } } as never, off), false, "never a review card");
assert.equal(autoFixOffered({ ...base, prAutoFix: false } as never, off), false, "the card's switch was set by the person");
assert.equal(autoFixOffered({ ...base, prAutoFix: true } as never, off), false);
assert.equal(autoFixOffered(base, { fixFailingChecks: true, fixFailingChecksSince: 0 }), false, "already on by default");
assert.equal(autoFixOffered({ ...base, pr: { number: 8, state: "open", checks: "passing" } } as never, off), false, "checks didn't fail");
assert.equal(autoFixOffered({ ...base, pr: { number: 8, state: "merged", checks: "failing" } } as never, off), false);
assert.equal(autoFixOffered({ ...base, builder: null } as never, off), false, "nobody to fix it");

assert.equal(
  OFFER_LINE,
  "Plyloft can do this by itself, starting with this failure: the Builder gets the failed logs, the fix is checked and reviewed, then sent to the pull request. Up to 3 tries; it never merges.",
);
assert.equal(offerLine(null), OFFER_LINE);
assert.equal(offerLine("Codex asks before every change in this card, so its automatic fixes wait for your OK in the Builder's session."), `${OFFER_LINE} Codex asks before every change in this card, so its automatic fixes wait for your OK in the Builder's session.`);
assert.match(TURNED_ON_LINE, /^Fix failing checks by itself is on for this project's cards, starting with this failure, which Plyloft is fixing now\. You find it in Settings › Cards › Shipping, and each card has its own switch under Change…\.$/);

// Walk 7: the line after Turn on stays until the try ends.
const on = { workspaceId: "w", head: "h1", at: 100 };
const open = (extra: Record<string, unknown> = {}) => ({ pr: { number: 8, state: "open", checks: "failing", headSha: "h1", checkedAt: 1, ...extra } as never });
assert.equal(turnedOnShown(null, open()), false);
assert.equal(turnedOnShown(on, open()), true, "the try runs");
assert.equal(turnedOnShown(on, open({ headSha: "h2" })), false, "its fix pushed");
assert.equal(turnedOnShown(on, open({ state: "merged" })), false, "the pull request isn't open");
assert.equal(turnedOnShown(on, open({ autoFix: { heads: ["h1"], stopped: { reason: "no_change", head: "h1", at: 200 } } })), false, "the try stopped");
assert.equal(turnedOnShown(on, open({ autoFix: { heads: [], stopped: { reason: "session_closed", head: "h1", at: 200 } } })), true, "a wait before the try");
assert.equal(turnedOnShown(on, open({ autoFix: { heads: ["h1"], stopped: { reason: "no_change", head: "h1", at: 50 } } })), true, "a stop from before Turn on");

console.log("prAutoFixOffer (F7): ok");
