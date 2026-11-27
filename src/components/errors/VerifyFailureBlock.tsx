import { checkStepWords } from "../../lib/checksWords";
import { ErrorBlock } from "../ux";
import { StepLogButtons, stepOutputMarked } from "./VerifyStepLogs";
import { verifyFailedError, type VerifyFailure } from "../../lib/uxError";
import type { VerifyStepResult } from "../../ipc";

/**
 * UX language card 7 (GH #102): a failed Verify run's summary on the card, in
 * the error shape — the third case, on a work surface rather than a page.
 *
 * It replaces `Verify failed.` followed by a raw reason: the title, the three
 * parts, and the steps' own output under `Details`, where the logs sit. Opening
 * a log reads, it does not change anything, so it is not one of the two ways
 * out — it belongs under Details, as the card asks.
 *
 * The buttons and the output are `VerifyStepLogs`', shared with the disclosure a
 * timed-out or stalled run gets instead of this block (review 2).
 *
 * It sits on the card, a work surface, so it is drawn at the card's density
 * (`density="dense"`, GH #150).
 *
 * `Re-verify` is not repeated here: it is already the panel's header action,
 * and PATTERNS.md §3 allows one action per place.
 */
export function VerifyFailureBlock({
  steps,
  reason,
  onOpenLog,
}: {
  /** The run's steps; the failing ones name what happened. */
  steps: VerifyStepResult[];
  /** What the run itself said, used when no step carried a reason. */
  reason: string | null;
  /** Reveal a step's full log in Finder, when there is a run to reveal. */
  onOpenLog: ((stepKind: string) => Promise<void>) | null;
}) {
  const failed = steps.filter((s) => !s.passed);
  const failure: VerifyFailure = {
    // 1.172.0 D2 (CP-26): the steps' names, not their kinds.
    steps: failed.map((s) => checkStepWords(s.kind)),
    reason,
    // The failing steps' own output, each under its step's name. The end of it
    // is where test runners say what failed, so it is kept whole and not cut.
    // 1.176.0 seams: as written — `ErrorBlock` offers Repair for a
    // marked step and strips the mark.
    output: stepOutputMarked(failed, reason),
  };
  return (
    <ErrorBlock
      error={verifyFailedError(failure)}
      // GH #150: the card is a work surface, so the block is drawn dense.
      density="dense"
      // The end of the output: where a test runner says what failed (GH #62).
      detailsToEnd
      detailsAction={
        onOpenLog && failed.length > 0 ? (
          <StepLogButtons steps={failed} onOpenLog={onOpenLog} />
        ) : undefined
      }
    />
  );
}
