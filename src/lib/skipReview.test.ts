import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  clearedSkipReview,
  consumeSkipReview,
  skipReviewFor,
  type SkipReviewPrefs,
} from "./skipReview.ts";

// GH #135: `Skip review` is a deliberate, per-press choice. It used to
// survive the Build done that used it, so a later Build done on the same
// card skipped the Challenger again with nothing saying so.

// The Build done that used it consumes it: the flag is false afterwards.
{
  const prefs: SkipReviewPrefs = { c1: true, c2: true };
  const used = consumeSkipReview(prefs, "c1", "build-done");
  assert.equal(used.skipped, true, "this Build done skips the review");
  assert.equal(skipReviewFor(used.prefs, "c1"), false, "and the box is clear after it");
  assert.equal(skipReviewFor(used.prefs, "c2"), true, "another card keeps its own choice");
  // The next Build done on the same card runs the review.
  assert.equal(consumeSkipReview(used.prefs, "c1", "build-done").skipped, false);
}

// A Build done on an unchecked card skips nothing and changes nothing.
{
  const prefs: SkipReviewPrefs = { c2: true };
  const used = consumeSkipReview(prefs, "c1", "build-done");
  assert.equal(used.skipped, false);
  assert.equal(used.prefs, prefs, "the same map: no render for a no-op");
}

// Start and resume end the choice too — a new session is a new decision,
// and a choice made for a Build done that never came must not surprise it.
for (const consumer of ["start", "resume"] as const) {
  const prefs: SkipReviewPrefs = { c1: true };
  const used = consumeSkipReview(prefs, "c1", consumer);
  assert.equal(used.skipped, false, `${consumer} skips no review of its own`);
  assert.equal(skipReviewFor(used.prefs, "c1"), false, `${consumer} clears the box`);
}

// The map is never mutated in place — zustand compares references.
{
  const prefs: SkipReviewPrefs = { c1: true };
  assert.notEqual(clearedSkipReview(prefs, "c1"), prefs);
  assert.equal(prefs.c1, true);
  assert.equal(skipReviewFor(clearedSkipReview(prefs, "c1"), "c1"), false);
  assert.equal(clearedSkipReview(prefs, "missing"), prefs);
}

// The store wires all three: Build done reads the choice through
// `takeSkipReview` (read and cleared in one step, before the first await),
// and start/resume clear it. Asserted on the source, because the store
// itself imports Tauri and cannot run here.
{
  const store = readFileSync(new URL("../store/builderStore.ts", import.meta.url), "utf8");
  assert.match(store, /const \{ skipped: skipReview \} = takeSkipReview\(cardId\);/);
  // After the already-running guard, so a press that is refused outright
  // does not spend a choice the running Build done did not make.
  assert.match(
    store,
    /doneBusy\[cardId\]\) \{[\s\S]{0,600}?takeSkipReview\(cardId\)[\s\S]{0,200}?setDoneBusy\(cardId, true[,)]/,
  );
  assert.match(
    store,
    /function takeSkipReview[\s\S]*consumeSkipReview\(s\.skipReviewPref, cardId, "build-done"\)/,
  );
  assert.equal(
    store.match(/clearedSkipReview\(s\.skipReviewPref, cardId\)/g)?.length,
    2,
    "start and resume each clear it",
  );
  // Whatever else `start` takes (1.169.0 A3 added `retry`), it clears the
  // choice first thing.
  assert.match(store, /start: async \(workspaceId, cardId[^)]*\) => \{[\s\S]{0,400}?clearedSkipReview/);
  assert.match(store, /resume: async \(workspaceId, cardId\) => \{[\s\S]{0,300}?clearedSkipReview/);
  // Nothing else reads the raw map for a Build done.
  assert.doesNotMatch(store, /skipReviewPref\[cardId\] \?\? false/);
}

console.log("skip review tests passed");
