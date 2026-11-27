// 1.175.0 F8 (UX-12, owner I10): one error in Now. A card could show up to
// seven error blocks under Now, each with its own buttons. This presenter
// takes what is open on the card and chooses the one that leads Now — with
// its one action — and the rest, which wait in the card's Details behind
// "2 more things on this card need a look." (mockup card-page.html §6, §6b).
//
// The order (§6b): what stopped the last press on this card (a ship stopped
// — its error, or the store's refusal block — a Start or Resume that didn't
// go through); then the Builder session's error left from before; then the
// planning that stopped. The quiet facts that ask nothing (the kept copy,
// "Behind main") are never troubles: they stay quiet lines.
//
// Pure: node runs `cardErrorNow.test.ts`.
import type { UxError, UxErrorAction } from "./uxError.ts";

/** What can be open on a card, by where it comes from. */
export type CardTroubleKind =
  /** The last press on this card stopped (`cardError`: ship, merge, a
   *  press of Now). */
  | "press"
  /** A ship the store refused (`LocalBranchBlock`, `UnpublishedReleaseBlock`):
   *  the same press, drawn by its own block. */
  | "ship-refused"
  /** The Builder session's error left from before (Start, Resume). */
  | "builder"
  /** The planning that stopped. */
  | "intake";

/** §6b's order: the first open one leads Now. */
export const TROUBLE_ORDER: readonly CardTroubleKind[] = ["press", "ship-refused", "builder", "intake"];

export interface CardErrorNow {
  /** The one that leads Now, or null when nothing is open. */
  now: CardTroubleKind | null;
  /** The others, in order: they wait in Details. */
  more: CardTroubleKind[];
}

/** Which trouble leads Now, and which wait in Details. When the one in Now
 *  is closed, the next one leads. */
export function cardErrorNow(open: Partial<Record<CardTroubleKind, boolean>>): CardErrorNow {
  const shown = TROUBLE_ORDER.filter((k) => open[k] === true);
  return { now: shown[0] ?? null, more: shown.slice(1) };
}

/** Under Now while others are open: "2 more things on this card need a
 *  look." — null with none. */
export function moreLine(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? "1 more thing on this card needs a look." : `${n} more things on this card need a look.`;
}
export const MORE_SHOW_LABEL = "Show";

/** The card's Details while it holds them: "Details · 2 to look at". */
export function detailsSummary(n: number): string {
  return n > 0 ? `Details · ${n} to look at` : "Details";
}

/** The heading of the list at the top of Details. */
export const TO_LOOK_AT_LABEL = "To look at";
/** A refusal block kept in Details opens on this press. */
export const SHOW_WAYS_OUT_LABEL = "Show the ways out";

/** Now's title: the error's title without its full stop (Now's titles
 *  have none). */
export function nowErrorTitle(title: string): string {
  return title.replace(/\.\s*$/, "");
}

/** Now's one line: what happened, then what was left untouched. */
export function nowErrorLine(error: Pick<UxError, "happened" | "untouched">): string {
  return [error.happened, error.untouched].filter((s) => s.trim()).join(" ");
}

/** The one line a trouble says in Details: its title and what happened. */
export function detailsErrorLine(error: Pick<UxError, "title" | "happened">): string {
  return [error.title, error.happened].filter((s) => s.trim()).join(" ");
}

export interface NowErrorWays {
  /** The error's own way on (a retry, Fix with the Builder, Sign in to
   *  GitHub…): it is Now's filled press. Null: Now keeps the state's. */
  primary: UxErrorAction | null;
  /** Dismiss, quiet, beside it. */
  dismiss: boolean;
}

/** The error's ways in Now: its one action — only one marked `primary`,
 *  as the error block filled only that one (F8 round 2: a first action that
 *  isn't, "Undo the merge", must never become Now's filled press) — and
 *  Dismiss. Without one, Now keeps the state's primary and the error's
 *  other ways are quiet, under its Details. A danger one never leads. */
export function nowErrorWays(error: Pick<UxError, "actions">): NowErrorWays {
  const primary = error.actions.find((a) => a.primary && !a.danger && a.id !== "dismiss") ?? null;
  return { primary, dismiss: true };
}
