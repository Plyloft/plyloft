/**
 * UX language card 8, review 1 (GH #103): when an `Undo` may still be used.
 *
 * A toast offers Undo for about six seconds, and in six seconds the same field
 * can change twice — `TypeOrChoose` does it in one gesture: typing commits on
 * blur, and picking from the list commits again. That left **two** live Undo
 * toasts for one field, and pressing the older one restored the value from
 * before the *first* change, throwing the second away with nothing said.
 *
 * Two rules fix it, and both live here so they can be tested without a store:
 *
 *  1. **One live Undo per field.** A new change to a field takes the previous
 *     one's place, and the toast it replaces is dismissed.
 *  2. **An Undo is inert once the value has moved on.** Even one toast can be
 *     pressed after something else changed the same field — another window, a
 *     page reset, the row itself — so before it writes anything it checks that
 *     the value is still the one it announced, and says so when it is not.
 *
 * Pure: no React, no zustand, no Tauri.
 */

/** The live Undo per key: a field id, or `reset:<page>` for a page's reset. */
export type LiveUndos = Map<string, string>;

/**
 * Register `toastId` as the live Undo for `key`, and return the toast id it
 * replaced — which the caller dismisses, so one field never has two.
 */
export function claimUndo(live: LiveUndos, key: string, toastId: string): string | null {
  const previous = live.get(key) ?? null;
  live.set(key, toastId);
  return previous === toastId ? null : previous;
}

/** Forget `toastId`, if it is still the live one for `key`. */
export function releaseUndo(live: LiveUndos, key: string, toastId: string): void {
  if (live.get(key) === toastId) live.delete(key);
}

/** The live Undo for `key`, or null. */
export function liveUndo(live: LiveUndos, key: string): string | null {
  return live.get(key) ?? null;
}

/**
 * May this Undo still run? Only while the field still holds the value the toast
 * announced.
 *
 * `null` and `undefined` are the same value in `settings.json` — both mean
 * "nothing set", and the Rust side parses either as `None` — so a model field
 * written blank over an absent one has not moved.
 */
export function undoStillApplies(announced: unknown, current: unknown): boolean {
  if (announced == null && current == null) return true;
  return JSON.stringify(announced ?? null) === JSON.stringify(current ?? null);
}

/**
 * Run an Undo through a mutation queue, deciding **inside the mutation** whether
 * it still applies.
 *
 * Review 2 (N1): comparing before enqueueing reads the last *committed* state,
 * and a second change to the same field can be in flight — its write sent, its
 * result not back. The Undo then saw the value it had announced, passed, and
 * queued a restore behind that write, so the second change was overwritten and
 * nothing said so. Inside the mutation there is no window: `latest` is the state
 * the restore is actually about to be applied to.
 *
 * Resolves true when it wrote, false when it found the value had moved on — so
 * the caller says the superseded sentence from the answer rather than from a
 * guess it made earlier.
 *
 * Generic over the state so `undoable.test.ts` can drive it with a real
 * `createMutationQueue` and a deliberately slow write.
 */
export function runUndo<T>(
  mutate: (mutation: (latest: T) => T) => Promise<T>,
  undo: {
    /** The value the toast announced. */
    announced: unknown;
    read: (state: T) => unknown;
    restore: (state: T) => T;
  },
): Promise<boolean> {
  let applied = false;
  return mutate((latest) => {
    if (!undoStillApplies(undo.announced, undo.read(latest))) return latest;
    applied = true;
    return undo.restore(latest);
  }).then(() => applied);
}

/** What a superseded Undo says instead of writing. It names the reason, because
 *  a button that does nothing and says nothing reads as a bug. */
export const UNDO_SUPERSEDED =
  "That setting has changed again since, so Undo would put back an older value. Nothing was changed.";

/** The key a field's Undo is filed under. */
export function fieldUndoKey(fieldId: string): string {
  return `field:${fieldId}`;
}

/** The key a page reset's Undo is filed under: one per page, and never the same
 *  as any single field's. */
export function resetUndoKey(page: string): string {
  return `reset:${page}`;
}
