/**
 * Claude's read-only sessions (Challenger reviews, proposals, discussions,
 * the reviewer probe) run in Claude's interactive TUI, which asks "Is this a
 * project you created or one you trust?" in a folder it has not seen.
 * Plyloft never answers that question: the member trusts Plyloft's session
 * folder (`<config>/claude-sessions`) once, in a Claude tile opened there,
 * and every session folder below it inherits the trust
 * (`claude_review_trust_status`).
 *
 * Pure — no React, no store, no IPC — so node runs it on its own.
 */
import type { BuilderReview, DiscussionRecord } from "../ipc.ts";
import type { UxError } from "./uxError.ts";

/**
 * What a Claude session that met the trust question reports, word for word.
 * Mirrors `crate::claude_session::FOLDER_TRUST_REFUSAL`; the Rust test
 * `folder_trust_refusal_matches_the_ui_constant` reads this file and fails
 * when the two drift apart.
 */
export const FOLDER_TRUST_REFUSAL =
  "Claude asks whether to trust the review folder before it starts. Plyloft never answers that question for you.";

/** Whether an error, a failure reason or a probe's detail is the refusal.
 *  A substring: callers wrap it ("….", a pass name before it). */
export function isFolderTrustRefusal(text: string | null | undefined): boolean {
  return typeof text === "string" && text.includes(FOLDER_TRUST_REFUSAL);
}

/** A card's Challenger review that stopped at Claude's trust question. */
export function reviewMetTrustQuestion(
  review: Pick<BuilderReview, "provider" | "error" | "failureReason"> | null | undefined,
): boolean {
  if (!review || review.provider !== "claude") return false;
  return isFolderTrustRefusal(review.error) || isFolderTrustRefusal(review.failureReason);
}

/** A discussion whose last attempt of a Claude leg stopped at the trust
 *  question. Only the last attempt: a retry that went through settles it. */
export function discussionMetTrustQuestion(
  record: Pick<DiscussionRecord, "legs"> | null | undefined,
): boolean {
  if (!record) return false;
  return Object.values(record.legs).some((leg) => {
    if (leg.provider !== "claude") return false;
    const last = leg.attemptHistory[leg.attemptHistory.length - 1];
    return isFolderTrustRefusal(last?.error);
  });
}

/** Whether to show the trust step. `trusted` is Claude's own answer
 *  (null: Claude's state could not be read); `refused` says a session
 *  already met the question, which is the evidence when the state is
 *  unreadable. Trusted hides it either way: the next run goes through. */
export function showsTrustStep(trusted: boolean | null | undefined, refused: boolean): boolean {
  if (trusted === true) return false;
  if (trusted === false) return true;
  return refused && trusted === null;
}

/** What stopped at the question: a review (the default), a card's
 *  improvement proposal, which otherwise fails in silence, or a card's chat
 *  with Claude (its sessions run under the same folder). */
export type TrustSubject = "review" | "proposal" | "chat";

/** The card shows the trust step where its proposal would appear: its last
 *  proposal pass stopped at the question, it has no proposal, and its own
 *  review doesn't already show the step (one copy per card). */
export function proposalMetTrustQuestion(
  cardId: string,
  trustStoppedCard: string | null | undefined,
  hasProposal: boolean,
  reviewShowsIt: boolean,
): boolean {
  return trustStoppedCard === cardId && !hasProposal && !reviewShowsIt;
}

/** The card's line once Claude trusts the folder after its proposal pass
 *  stopped: no button names a way that may not be on this card. */
export const PROPOSAL_AFTER_TRUST =
  "Claude trusts the review folder now. The next review of this card can suggest a skill change.";

export const OPEN_CLAUDE_THERE = "Open Claude there";
export const CHECK_AGAIN = "Look again";
export const TRUST_HINT = "Choose “Yes, I trust this folder”, then close the tile.";

/** The trust step in the error shape. `stillUntrusted`: Look again found
 *  Claude still asking. `noWorkspace`: a Claude tile belongs to a
 *  workspace's Terminals, and none is open — the step says how to answer
 *  without one, and offers only Look again. */
export function trustStepError(
  folder: string,
  stillUntrusted = false,
  noWorkspace = false,
  subject: TrustSubject = "review",
): UxError {
  const yet = stillUntrusted ? "Claude doesn't trust it yet. " : "";
  return {
    title: "Claude needs to trust Plyloft's review folder.",
    happened:
      subject === "proposal"
        ? "Claude asked whether to trust the folder before it could suggest a skill change for this card, and Plyloft never answers that for you."
        : subject === "chat"
          ? "Claude asked whether to trust the folder before this chat could start, and Plyloft never answers that for you."
          : "Claude asks whether to trust a folder before a review starts, and Plyloft never answers that for you.",
    untouched:
      subject === "proposal"
        ? "No suggested skill change was written, and nothing in your projects changed."
        : subject === "chat"
          ? "Your message wasn't sent, and nothing in your projects changed. Send it again once Claude trusts the folder."
          : "No review ran, and nothing in your projects changed.",
    todo: noWorkspace
      ? `${yet}Open a workspace to open Claude there from Plyloft, or run claude in the folder under Details from any terminal. Choose “Yes, I trust this folder”, then come back and Look again.`
      : `${yet}Open Claude there. ${TRUST_HINT}`,
    actions: noWorkspace
      ? [{ id: "check", label: CHECK_AGAIN, primary: true }]
      : [
          { id: "open", label: OPEN_CLAUDE_THERE, primary: true },
          { id: "check", label: CHECK_AGAIN },
        ],
    details: folder,
  };
}
