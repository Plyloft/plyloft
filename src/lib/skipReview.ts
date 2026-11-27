/**
 * GH #135: `Skip review` is one press, not a setting.
 *
 * `builderStore.skipReviewPref[cardId]` was never cleared: the box stayed
 * checked after the Build done that used it, so a later Build done on the
 * same card skipped the Challenger again with nothing on screen saying so,
 * and only quitting Ply cleared it. Every event that consumes the choice —
 * a Build done that used it, and start or resume of a session — clears it,
 * so the box reflects the next press and nothing else.
 *
 * Pure (no Tauri import), so it is unit-tested under node.
 */

export type SkipReviewPrefs = Record<string, boolean>;

/** What ends a card's `Skip review`: the Build done that used it, and the
 *  start or resume of a session (a new session is a new decision). */
export type SkipReviewConsumer = "build-done" | "start" | "resume";

/** `prefs` with `cardId`'s choice removed. The same map when it had none,
 *  so a store `set` on it is a no-op render. */
export function clearedSkipReview(prefs: SkipReviewPrefs, cardId: string): SkipReviewPrefs {
  if (prefs[cardId] === undefined) return prefs;
  const next = { ...prefs };
  delete next[cardId];
  return next;
}

/** The card's choice for the press about to happen. */
export function skipReviewFor(prefs: SkipReviewPrefs, cardId: string): boolean {
  return prefs[cardId] ?? false;
}

/** The choice `consumer` used, and the map it leaves behind: cleared,
 *  whether or not the box was checked — `start` and `resume` end a choice
 *  made for a Build done that never came. */
export function consumeSkipReview(
  prefs: SkipReviewPrefs,
  cardId: string,
  consumer: SkipReviewConsumer,
): { skipped: boolean; prefs: SkipReviewPrefs } {
  return {
    skipped: consumer === "build-done" && skipReviewFor(prefs, cardId),
    prefs: clearedSkipReview(prefs, cardId),
  };
}
