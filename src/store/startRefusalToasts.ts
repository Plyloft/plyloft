import { dismissToast } from "./toastStore";

/**
 * 1.172 A3 (Windows walk 2026-10-27-163110): a refused start's toast
 * ("Build not started. Set up this repository, then press Start build.")
 * stays until dismissed — it has Set up as its action — so once covered it
 * waited in the queue and came back after the build had started. Each
 * card's refusal toasts are kept here and go the moment one of its starts
 * goes through: the refusal no longer says anything true.
 */
const byCard = new Map<string, string[]>();

/** Keep `toastId` as one of `cardId`'s start refusals. */
export function noteStartRefusalToast(cardId: string, toastId: string): void {
  byCard.set(cardId, [...(byCard.get(cardId) ?? []), toastId]);
}

/** The card's build started: its refusal toasts go, on screen or waiting. */
export function dismissStartRefusalToasts(cardId: string): void {
  const ids = byCard.get(cardId);
  if (!ids) return;
  byCard.delete(cardId);
  for (const id of ids) dismissToast(id);
}

/** Tests. */
export function resetStartRefusalToastsForTests(): void {
  byCard.clear();
}
