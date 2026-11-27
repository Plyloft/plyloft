import { useState } from "react";
import { CBtn, Details } from "../ux";
import type { VerifyStepResult } from "../../ipc";
import { failure, type Failure } from "../../lib/failure";
import { showBackendText } from "../../lib/backendMarks";
import { RepairFor } from "../ux/RepairFor";

/**
 * UX language card 7 (GH #102 review 2): a Verify run's step output and its
 * logs, shared by the surfaces that need to show them.
 *
 * `VerifyFailureBlock` puts {@link StepLogButtons} under its `ErrorBlock`'s
 * `Details`. A run that **timed out** or hit a **capacity stall** is not a
 * failure and gets no block (review 1's gate), but its steps reported the same
 * output and have the same logs — so {@link VerifyStepOutput} draws them under a
 * closed disclosure of their own, without the failure block's "fix what it
 * names", which would be the wrong instruction for either.
 *
 * Opening a log reads; it changes nothing. It is never one of an error's two
 * ways out, and it lives under a disclosure wherever it appears.
 */

/** Every failing step's output, named by its step, as the backend wrote it
 *  (a typed mark kept: an `ErrorBlock` reads it for Repair and strips it). */
export function stepOutputMarked(
  failed: VerifyStepResult[],
  fallback: string | null,
): string | null {
  const parts = failed.filter((s) => s.reason).map((s) => `${s.kind}\n${s.reason}`);
  return parts.length > 0 ? parts.join("\n\n") : fallback;
}

/** Every failing step's output, named by its step. Joined, never parsed.
 *  1.176.0 seams: never a backend mark (`lib/backendMarks`). */
export function stepOutput(
  failed: VerifyStepResult[],
  fallback: string | null,
): string | null {
  return showBackendText(stepOutputMarked(failed, fallback));
}

/**
 * One button per step whose log there is (review 1): `Details` holds every one
 * of their outputs, so a single button opened a log that was not the one read.
 *
 * The label names the step by `kind`, which **is** the verify model's own
 * FE-facing step label (`verify.rs::step_kind_label` — `ppvp-sh`,
 * `script:<path>`, `slash:<name> (step 2)`); there is no other title to use,
 * and inventing one would name something the run does not.
 */
export function StepLogButtons({
  steps,
  onOpenLog,
}: {
  steps: VerifyStepResult[];
  onOpenLog: (stepKind: string) => Promise<void>;
}) {
  const [logError, setLogError] = useState<Failure | null>(null);
  const one = steps.length === 1;
  return (
    <>
      {steps.map((step, i) => (
        <CBtn
          key={`${i}-${step.kind}`}
          onClick={() => {
            setLogError(null);
            onOpenLog(step.kind).catch((cause) =>
              setLogError(failure("Plyloft couldn't open the log.", cause)),
            );
          }}
        >
          {one ? "Open full log" : `Open the log for ${step.kind}`}
        </CBtn>
      ))}
      {logError && <p className="ux-error-sentence">{logError.sentence}</p>}
      {logError?.details && (
        <Details>
          <pre className="ux-output">{logError.details}</pre>
        </Details>
      )}
    </>
  );
}

/**
 * What the steps reported, under a closed disclosure with their logs — for a
 * run that is not a failure and so has no error block (review 2).
 *
 * Null when there is nothing to show: a stall before any step ran says its own
 * sentence and needs no empty disclosure under it.
 */
export function VerifyStepOutput({
  steps,
  onOpenLog,
}: {
  steps: VerifyStepResult[];
  onOpenLog: ((stepKind: string) => Promise<void>) | null;
}) {
  const failed = steps.filter((s) => !s.passed);
  // Only what the steps themselves reported. The run's own sentence — the step
  // that timed out, the stall's detail — is already on screen above this, and
  // repeating it here would read as output a step produced.
  const output = stepOutput(failed, null);
  const marked = stepOutputMarked(failed, null);
  if (!output && !(onOpenLog && failed.length > 0)) return null;
  return (
    // GH #150: on the card, at the card's density — the same measures as the
    // dense block's own Details.
    <div className="ux-error-details ux-error-details--dense">
      <Details summary="What the steps reported">
        {output && <pre className="ux-error-output">{output}</pre>}
        {/* 1.176.0 seams: a step that couldn't start Claude, its Repair. */}
        <RepairFor texts={[marked]} />
        {onOpenLog && failed.length > 0 && (
          <div className="ux-error-details-action">
            <StepLogButtons steps={failed} onOpenLog={onOpenLog} />
          </div>
        )}
      </Details>
    </div>
  );
}
