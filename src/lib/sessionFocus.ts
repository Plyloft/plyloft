/**
 * 1.171.0 D2 (owner D11, CF7): Open session puts the cursor in the
 * session's terminal, so an answer (the trust question, a permission) can
 * be typed straight away — but only the first time the card's session is
 * opened in this run of Plyloft, and said aloud (aria-live) so a keyboard
 * or screen-reader user knows where the keys now go. Later opens leave the
 * focus on the button that opened it. Pure, apart from the module's memory
 * of what was opened. No React, no store.
 */

export type SessionSection = "run" | "intake";

const opened = new Set<string>();

const keyOf = (cardId: string, section: SessionSection) => `${cardId}\u0000${section}`;

/** True until the cursor was once moved into this card's section. */
export function firstSessionOpen(cardId: string, section: SessionSection): boolean {
  return !opened.has(keyOf(cardId, section));
}

/** Record that the cursor went there (only once a terminal took it: a
 *  session not drawn yet keeps its first open for later). */
export function markSessionOpened(cardId: string, section: SessionSection): void {
  opened.add(keyOf(cardId, section));
}

/** What the live region says when the cursor moves into the terminal. */
export function sessionFocusWords(section: SessionSection): string {
  return section === "intake"
    ? "The cursor is in the conversation now: what you type goes there."
    : "The cursor is in the session now: what you type goes there.";
}

/** 1.172.0 walk (E1): the note is said while the session it is about is
 *  open on this card's page and running — not after it closed or ended. */
export function sessionFocusNoteHolds(
  note: { cardId: string; section: SessionSection | null },
  now: { cardId: string; runOpen: boolean; intakeOpen: boolean },
): boolean {
  if (!note.section || note.cardId !== now.cardId) return false;
  return note.section === "run" ? now.runOpen : now.intakeOpen;
}

/** Tests only: forget what was opened. */
export function resetSessionFocus(): void {
  opened.clear();
}
