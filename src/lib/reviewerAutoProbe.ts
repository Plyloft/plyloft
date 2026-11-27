import type { ReviewerAutoProbeEvent } from "../ipc";
import { isFolderTrustRefusal, OPEN_CLAUDE_THERE } from "./claudeReviewTrust.ts";

/** E3: the press the toast offers — the Diagnostics row's own, opened from
 *  the toast instead of named as a path to it. The store wires it. */
export type ReviewerAutoProbePress = "open-trust" | "prove-again";

export const PROVE_IT_AGAIN = "Prove it again";

export interface ReviewerAutoProbeToast {
  kind: "warn";
  title: string;
  body: string;
  /** The probe's own words (the doctor row's), behind Details. */
  details?: string;
  press: { kind: ReviewerAutoProbePress; label: string };
}

/** Claude or Codex, as the rest of the app names them. */
function shortName(event: Pick<ReviewerAutoProbeEvent, "provider" | "providerName">): string {
  if (event.provider === "claude") return "Claude";
  if (event.provider === "codex") return "Codex";
  return event.providerName;
}

/** Toast for `reviewer-capability://auto-probe`. Loud only when the probe
 *  ran and failed; a pass or a skip just refreshes the doctor row.
 *
 *  E3 (owner, 2026-10-28): it says what it means for the person — the AI
 *  can't review their cards until the check passes (each review proves it
 *  first, `review_capabilities::ensure_current`, and one whose proof fails
 *  doesn't start) — and the press is in the toast, never a
 *  "Settings › Diagnostics › …" path to it. */
export function reviewerAutoProbeToast(
  event: ReviewerAutoProbeEvent,
): ReviewerAutoProbeToast | null {
  if (event.result !== "failed") return null;
  const name = shortName(event);
  const title = `${name} can't review your cards yet`;
  const who = `${event.providerName} ${event.version}`;
  // The trust step is the way out, not a re-run: the probe meets the same
  // question until the member answers it.
  if (isFolderTrustRefusal(event.detail)) {
    return {
      kind: "warn",
      title,
      body: `${who} needs your OK on Plyloft's review folder before it can review again: open Claude there and answer Yes.`,
      press: { kind: "open-trust", label: OPEN_CLAUDE_THERE },
    };
  }
  return {
    kind: "warn",
    title,
    body: `${who} didn't pass Plyloft's check that its reviews can't change your files.`,
    details: event.detail,
    press: { kind: "prove-again", label: PROVE_IT_AGAIN },
  };
}
