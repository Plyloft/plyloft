import { builderResumedIdle, useBuilder } from "./builderStore";
import { confirmSheet } from "./confirmStore";
import { earlyFinishSheet } from "../lib/finishAndCheck";

/**
 * UX P1 point 3 (P-B): the one Finish and check press — the session's
 * button and the Now box's primary when the Builder stopped. Pressed early,
 * it asks first (`earlyFinishSheet`); Esc keeps the Builder working. The
 * store toasts what was saved, or the self-check it sent first. Returns
 * whether the press went on.
 *
 * 1.171.0 C3 (CF18, CP-10): `withoutReview` is Finish and check ▾ › Check
 * without the Reviewer — the old "Skip review" toggle, now one
 * press: the card's skip is set only once the press goes on, and never
 * outlives it (a press the store turned away leaves no skip behind for the
 * next Finish and check).
 */
export async function finishAndCheck(
  workspaceId: string,
  cardId: string,
  options: {
    withoutReview?: boolean;
    /** The caller already asked (`earlyFinishSheet`): the session's own
     *  button, which shows its busy words only once the press goes on. */
    asked?: boolean;
  } = {},
): Promise<boolean> {
  const sheet = options.asked ? null : earlyFinishSheet(useBuilder.getState().byCard[cardId], Date.now(), builderResumedIdle(cardId));
  if (sheet && !(await confirmSheet(sheet))) return false;
  const builder = useBuilder.getState();
  if (options.withoutReview) builder.setSkipReviewPref(cardId, true);
  try {
    await builder.done(workspaceId, cardId);
  } catch {
    // The store already reported it; one toast per refusal.
  } finally {
    if (options.withoutReview) useBuilder.getState().setSkipReviewPref(cardId, false);
  }
  return true;
}
