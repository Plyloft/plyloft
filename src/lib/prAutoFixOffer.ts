/**
 * 1.175.0 F7 (UX-7; owner I9, I11): "Turn on" in line for "Fix failing
 * checks by itself". At the first failed check on a pull request of the
 * project, under Fix with the Builder, one line says what Plyloft could do
 * by itself, with its limit; Turn on switches on this card (so the failure
 * now starts) and the project's default (`fixFailingChecks`, with its
 * time); Undo switches both off; Not now hides it for the project. Once
 * answered it never comes back there (`workspace.fixFailingChecksOffered`).
 * Never on a card that reviews somebody else's pull request.
 *
 * Pure, for its tests; `components/AutoFixOffer.tsx` draws it. F8's
 * `nowNote.ts` is where this note belongs once it exists: it should call
 * `autoFixOffered` and render the same words.
 */
import type { KanbanCard } from "../ipc.ts";
import { autoFixOn, autoFixSoftStop } from "./prAutoFix.ts";

/** F7 round 2 (review): Turn on starts with this failure — the words say so. */
export const OFFER_LINE =
  "Plyloft can do this by itself, starting with this failure: the Builder gets the failed logs, the fix is checked and reviewed, then sent to the pull request. Up to 3 tries; it never merges.";
export const TURN_ON_LABEL = "Turn on";
export const NOT_NOW_LABEL = "Not now";
export const TURNED_ON_LINE =
  "Fix failing checks by itself is on for this project's cards, starting with this failure, which Plyloft is fixing now. You find it in Settings › Cards › Shipping, and each card has its own switch under Change….";
/** Walk 7: Turn on with the Builder session closed — the try starts once
 *  the session is open again (G7 never resumes a closed one); modelled on
 *  the loop's own waits ("Plyloft starts once that's settled"). */
export const TURNED_ON_CLOSED_LINE =
  "Fix failing checks by itself is on for this project's cards. The Builder session is closed, so Plyloft starts on this failure once it is open again. You find it in Settings › Cards › Shipping, and each card has its own switch under Change….";
/** The line after Turn on, by whether the card's Builder session is open. */
export function turnedOnLine(sessionOpen: boolean): string {
  return sessionOpen ? TURNED_ON_LINE : TURNED_ON_CLOSED_LINE;
}
export const UNDO_LABEL = "Undo";

/** The offer shows: a pull request of this card, open, its checks failed;
 *  the switch never set on the card and off by default; not answered in
 *  the project; not a review card; a Builder to fix it. */
export function autoFixOffered(
  card: Pick<KanbanCard, "prReview" | "prAutoFix" | "pr" | "prUrl" | "builder" | "archived">,
  ws: { fixFailingChecksOffered?: boolean; fixFailingChecks?: boolean; fixFailingChecksSince?: number | null } | null | undefined,
): boolean {
  if (card.prReview || card.archived || !card.builder || !card.prUrl) return false;
  // Answered here already, or on by default (a failure older than the
  // default is the card's own switch's, and offering "Turn on" would mislead).
  if (ws?.fixFailingChecksOffered || ws?.fixFailingChecks) return false;
  if (card.prAutoFix != null) return false;
  if (card.pr?.state !== "open" || card.pr.checks !== "failing") return false;
  return !autoFixOn(card, ws?.fixFailingChecks ? (ws.fixFailingChecksSince ?? 0) : null);
}

/** The offer's line with what the Builder's permission means for it (the
 *  card's own `unattendedAsksNote` line, said before the choice). */
export function offerLine(asksLine: string | null | undefined): string {
  return asksLine ? `${OFFER_LINE} ${asksLine}` : OFFER_LINE;
}

/** Turn on pressed on a card: which pull request head was failing then. */
export type TurnedOn = { workspaceId: string; head: string | null; at: number };

/** Walk 7: the line after Turn on, with Undo, stays — whatever Now's
 *  primary is once the try starts — until the try ends: GitHub has
 *  another head (its fix pushed), the pull request isn't open, or a try
 *  stopped on that head (a stop before any try, such as a closed session,
 *  waits and keeps it). Leaving the card forgets it (`AutoFixOffer.tsx`). */
export function turnedOnShown(
  on: TurnedOn | null | undefined,
  card: Pick<KanbanCard, "pr">,
): boolean {
  if (!on) return false;
  const pr = card.pr;
  if (!pr || pr.state !== "open" || pr.headSha !== on.head) return false;
  const stop = pr.autoFix?.stopped;
  if (stop && stop.head === on.head && stop.at >= on.at && !autoFixSoftStop(pr.autoFix, stop)) return false;
  return true;
}
