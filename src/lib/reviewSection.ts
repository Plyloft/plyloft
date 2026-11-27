/**
 * 1.172.0 (C2; T7, CP-3, CP-5, CP-19, CP B2): the card page's one Review
 * section — the checks, the Challenger's verdict and the overlap with other
 * cards, then See the changes · Try it · Not right — tell the Builder, then
 * the same Ship it ▾ as Now. Pure words, no React and no store, so they are
 * tested once (`reviewSection.test.ts`).
 *
 * One noun per thing: "the changes" is the diff (See the changes), "Review"
 * is the checks plus the Challenger (the section, See the review, the facts
 * line's See the checks).
 */
import type { OverlapWarning } from "../ipc.ts";
import { bringInLabel } from "./targetSync.ts";

/** The section's heading (the tour's `card-review`). */
export const REVIEW_SECTION_TITLE = "Review";

/** 1.172.0 D2 (CP-21): the same section on a shipped card — its one
 *  receipt. */
export const SHIPPED_SECTION_TITLE = "What shipped";

/** Now on Ready to ship: the one quiet press beside Ship it ▾. A plain
 *  label, so the ⋯ menu's no-duplicate filter can match it. */
// 1.175.0 F9 (UX-8): "Check" means the checks; this press reads the review.
export const CHECK_IT_FIRST_LABEL = "Read the review";
export const CHECK_IT_FIRST_TITLE =
  "Opens the Review: your checks, the Reviewer's verdict, the changes, Try it and Not right.";

/** The Review's copy of Ship it ▾: its own accessible name, beginning with
 *  the visible label (Challenger 1: never two buttons named "Ship it"). */
export function reviewShipName(label: string): string {
  return `${label}, from the Review`;
}
export const REVIEW_SHIP_MENU_LABEL = "Other ways to ship, in the Review";

/** The facts line's Checks: opens the Review at its checks. */
export const SEE_THE_CHECKS_LABEL = "See the checks";

/** A card whose result is read opens on the review (`inspect-outcome`). */
export const SEE_THE_REVIEW_LABEL = "See the review";

/**
 * The chip under Now on Ready to ship: who else changed these files, and
 * what to do about it. Null when nothing overlaps. The full list (with the
 * files) stays in the Review.
 */
export function overlapChipWords(warnings: readonly OverlapWarning[], target: string | null | undefined): string | null {
  if (warnings.length === 0) return null;
  const [first, ...rest] = warnings;
  const named =
    first.kind === "teammate_pr" ? `“${first.otherTitle}” (a teammate's pull request)` : `“${first.otherTitle}”`;
  const who = rest.length === 0 ? `${named} also changes` : `${named} and ${rest.length} more also change`;
  const files = warnings.reduce((n, w) => n + w.files.length, 0);
  const fileWords = files === 1 ? "a file this card changes" : "files this card changes";
  const anyCard = warnings.some((w) => w.kind === "local_card");
  const then = anyCard
    ? `Ship one, then ${bringInLabel(target ?? "")} on the other.`
    : "Shipping both may conflict.";
  return `${who} ${fileWords}. ${then}`;
}
