import { FOLLOW_UP_ASK } from "../lib/followUp";

/** N19: the follow-up card whose page should open on its brief, once. */
let pending: string | null = null;

/** Follow up opened this card: its page opens on the brief, not the Now
 *  title (`CardDetailPanel`'s open-focus effect takes it). */
export function focusFollowUpBrief(cardId: string) {
  pending = cardId;
}

/** 1.172.0 (C1; CP-12): a card just made with New card and opened starts
 *  on What you want, under its Now. */
export function focusNewCardBrief(cardId: string) {
  pending = cardId;
}

/** Whether the card's page should open on its brief; asking clears it. */
export function takeBriefFocus(cardId: string): boolean {
  if (pending !== cardId) return false;
  pending = null;
  return true;
}

/** Focus the brief, the caret at the end of the line the person fills in
 *  (a follow-up's ask), else after what is written. */
export function focusBrief(brief: HTMLTextAreaElement | null): boolean {
  if (!brief) return false;
  brief.focus();
  const end = brief.value.startsWith(FOLLOW_UP_ASK) ? FOLLOW_UP_ASK.length : brief.value.length;
  brief.setSelectionRange?.(end, end);
  return true;
}
