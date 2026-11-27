// 1.175.0 F8 (UX-12, owner I10): one error in Now — the order of §6b, one
// action, the next one up when the first is closed, and never more than
// one outside Details. Run with Node 22+:
//   node --experimental-strip-types src/lib/cardErrorNow.test.ts
import assert from "node:assert/strict";
import {
  TROUBLE_ORDER,
  cardErrorNow,
  detailsErrorLine,
  detailsSummary,
  moreLine,
  nowErrorLine,
  nowErrorTitle,
  nowErrorWays,
  type CardTroubleKind,
} from "./cardErrorNow.ts";
import { nowNote, nowNoteId, NOW_NOTES } from "./nowNote.ts";
import { PRESENTATION_FIXTURES } from "./cardPresentation.fixtures.ts";
import type { UxError } from "./uxError.ts";

// §6b's order: the last press stopped (its error, or a refused ship), then
// the Builder session's error, then the planning that stopped.
assert.deepEqual([...TROUBLE_ORDER], ["press", "ship-refused", "builder", "intake"]);
assert.deepEqual(cardErrorNow({}), { now: null, more: [] });
assert.deepEqual(cardErrorNow({ intake: true, builder: true }), { now: "builder", more: ["intake"] });
assert.deepEqual(cardErrorNow({ intake: true, builder: true, press: true }), { now: "press", more: ["builder", "intake"] });
assert.deepEqual(cardErrorNow({ "ship-refused": true, builder: true }), { now: "ship-refused", more: ["builder"] });
// The next one leads when the first is closed.
assert.deepEqual(cardErrorNow({ press: false, builder: true, intake: true }).now, "builder");
assert.deepEqual(cardErrorNow({ builder: false, intake: true }), { now: "intake", more: [] });

// The maximum: whatever is open, on every card the presentation knows, Now
// holds one error and every other one is in Details — never two outside.
const kinds = TROUBLE_ORDER;
for (const f of PRESENTATION_FIXTURES) {
  for (let mask = 0; mask < 1 << kinds.length; mask++) {
    const open: Partial<Record<CardTroubleKind, boolean>> = {};
    kinds.forEach((k, i) => (open[k] = (mask & (1 << i)) !== 0));
    const r = cardErrorNow(open);
    const count = kinds.filter((k) => open[k]).length;
    assert.equal(r.now === null ? 0 : 1, Math.min(count, 1), `${f.name}: one in Now`);
    assert.equal(r.more.length, Math.max(count - 1, 0), `${f.name}: the rest in Details`);
    assert.ok(!r.more.includes(r.now as CardTroubleKind), `${f.name}: never twice`);
  }
}

// The words.
assert.equal(moreLine(0), null);
assert.equal(moreLine(1), "1 more thing on this card needs a look.");
assert.equal(moreLine(2), "2 more things on this card need a look.");
assert.equal(detailsSummary(0), "Details");
assert.equal(detailsSummary(2), "Details · 2 to look at");
assert.equal(nowErrorTitle("Ship it stopped: the card's changes conflict with main."), "Ship it stopped: the card's changes conflict with main");
assert.equal(nowErrorTitle("No full stop"), "No full stop");

const conflict: UxError = {
  title: "Ship it stopped: the card's changes conflict with main.",
  happened: "They conflict in 2 files.",
  untouched: "Nothing was merged; the card and its copy are as they were.",
  todo: "Resolve the conflict in the card's copy, then ship again.",
  actions: [
    { id: "ship-conflict-ask", label: "Fix with the Builder", primary: true },
    { id: "dismiss", label: "Dismiss" },
  ],
  details: "CONFLICT (content): Merge conflict in a.ts",
};
assert.equal(nowErrorLine(conflict), "They conflict in 2 files. Nothing was merged; the card and its copy are as they were.");
assert.equal(detailsErrorLine({ title: "Resume didn't go through.", happened: "Couldn't find this card's Codex conversation." }), "Resume didn't go through. Couldn't find this card's Codex conversation.");

// One action: the error's own way on (else Now keeps the state's), with
// Dismiss beside it; a destructive way never leads.
assert.deepEqual(nowErrorWays(conflict), { primary: conflict.actions[0], dismiss: true });
assert.deepEqual(nowErrorWays({ actions: [{ id: "dismiss", label: "Dismiss" }] }), { primary: null, dismiss: true });
// F8 round 2 (review): only an action marked primary leads — never a first
// one that isn't (the conflict-marks error's Undo the merge), never a
// danger one; then Now keeps the state's primary.
assert.equal(nowErrorWays({ actions: [{ id: "trash", label: "Move to the Trash", danger: true }, { id: "retry", label: "Try again" }] }).primary, null);
assert.equal(nowErrorWays({ actions: [{ id: "undo-merge", label: "Undo the merge" }, { id: "dismiss", label: "Dismiss" }] }).primary, null);
assert.equal(nowErrorWays({ actions: [{ id: "x", label: "X", primary: true, danger: true }] }).primary, null);
assert.equal(nowErrorWays({ actions: [{ id: "show-files", label: "Show the files" }, { id: "dismiss", label: "Dismiss" }] }).primary, null);
assert.equal(nowErrorWays({ actions: [{ id: "show-files", label: "Show the files" }, { id: "ask-commit", label: "Ask the Builder to commit them", primary: true }] }).primary?.id, "ask-commit");

// The note under Now's primary: the first in the order that applies.
assert.deepEqual(NOW_NOTES, { putOnGithub: { rank: 40 }, noPullRequest: { rank: 50 }, autoFixOffer: { rank: 60 } });
assert.equal(nowNoteId({ noPullRequest: true, putOnGithub: true }), "putOnGithub");
assert.equal(nowNoteId({}), null);
assert.equal(nowNoteId({ autoFixOffer: true, noPullRequest: true }), "noPullRequest");
assert.equal(nowNoteId({ autoFixOffer: true, noPullRequest: false }), "autoFixOffer");
// Ranks are each note's own: no two share one.
const ranks = Object.values(NOW_NOTES).map((n) => n.rank);
assert.equal(new Set(ranks).size, ranks.length);
assert.equal(nowNote({}), null);
assert.equal(nowNote({ noPullRequest: null }), null);
assert.equal(nowNote({ noPullRequest: "  " }), null);
assert.deepEqual(nowNote({ noPullRequest: "This project is only on this Mac, so Ship it merges the card here." }), {
  id: "noPullRequest",
  text: "This project is only on this Mac, so Ship it merges the card here.",
});

console.log("cardErrorNow: ok");
