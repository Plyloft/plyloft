import { showBackendText } from "./backendMarks.ts";
import type { BuilderReview, CardPresentationState, KanbanCard, PrReview } from "../ipc";
import { OVERRIDDEN_WORD, sendFixesLine } from "./deliveryWords.ts";
import { reviewApprovedWord } from "./challengerReview.ts";

/**
 * Challenger on a pull request (`pr_review.rs`): what a card that reviews
 * a pull request offers, and how the Board and its page word it. Pure.
 */

/** `challengerReview.ts::reviewCanRunAgain`, kept here so this module
 *  imports nothing of the card lifecycle (which imports it). */
function canRunAgain(review: BuilderReview): boolean {
  return (
    review.status === "failed" ||
    (review.status === "done" && (review.verdict == null || review.verdict === "incomplete")) ||
    (review.status === "skipped" && Boolean(review.note) && (review.failedPasses ?? 0) > 0)
  );
}

export type ReviewOffer = "review" | "newCommits" | "runAgain" | "running" | "current" | "closed";

type PrCard = Pick<KanbanCard, "builder"> & Partial<Pick<KanbanCard, "verifyStatus" | "builderVendorPref">> & {
  prReview?: PrReview | null;
};

/** The card's review of its newest snapshot, if any. */
export function currentReview(card: PrCard): BuilderReview | null {
  const b = card.builder;
  const last = b?.snapshots[b.snapshots.length - 1];
  const review = b?.review ?? null;
  if (!last || !review || review.snapshotN !== last.n) return null;
  return review;
}

/** Mirrors `pr_review.rs::review_offer`: new commits are a head GitHub
 *  reports that no snapshot of the card is (a pushed fix is one). Null on a
 *  card that reviews no pull request. */
export function reviewOffer(card: PrCard): ReviewOffer | null {
  const pr = card.prReview;
  if (!pr) return null;
  if (pr.state !== "open") return "closed";
  if (card.builder?.review?.status === "running") return "running";
  const snapshots = card.builder?.snapshots ?? [];
  // Walk 3 of #386 (finding 5): nor the head an unpushed fix is built on
  // (Bring in the new commits merged it) — the fix's own review counts.
  // Challenger on 55c90ec2: nor a pushed fix the pull request was taken off.
  if (
    snapshots.length > 0 &&
    (!snapshots.some((s) => s.sha === pr.headSha) || pushedFixTakenOff(card)) &&
    !fixOnHead(card)
  )
    return "newCommits";
  const review = currentReview(card);
  if (!review) return "review";
  return canRunAgain(review) ? "runAgain" : "current";
}

/** `pr_review.rs::pushed_fix_taken_off`: the card's branch is on its
 *  newest snapshot, a pushed fix, and GitHub's head is another commit (the
 *  pull request was force-pushed off the fix). */
export function pushedFixTakenOff(card: PrCard): boolean {
  const pr = card.prReview;
  const snapshots = card.builder?.snapshots ?? [];
  const last = snapshots[snapshots.length - 1];
  if (!pr || !last) return false;
  return (
    !(pr.heads ?? []).includes(last.n) &&
    last.n <= (pr.headMark ?? 0) &&
    (pr.branchHead ?? null) === last.sha &&
    Boolean(pr.headSha) &&
    last.sha !== pr.headSha
  );
}

/** `pr_review.rs::fix_on_head`: the newest snapshot is an unpushed fix
 *  built on the head GitHub reports. */
export function fixOnHead(card: PrCard): boolean {
  const pr = card.prReview;
  return Boolean(pr) && unpushedFix(card) && (pr!.branchHead ?? null) === pr!.headSha;
}

/** `pr_review.rs::merge_conflicts_again`: the last Bring in the new commits
 *  conflicted, and neither the pull request's head nor the card's fix has
 *  changed since — pressing it again would conflict again. */
export function mergeConflictsAgain(card: PrCard): boolean {
  const c = card.prReview?.mergeConflict;
  const snapshots = card.builder?.snapshots ?? [];
  const fix = snapshots[snapshots.length - 1]?.sha;
  return Boolean(c) && c!.head === card.prReview!.headSha && fix === c!.fix;
}

/** The card's newest snapshot is a Builder's fix GitHub doesn't have
 *  (`pr_review.rs::unpushed_fix`). */
export function unpushedFix(card: PrCard): boolean {
  const pr = card.prReview;
  const snapshots = card.builder?.snapshots ?? [];
  const last = snapshots[snapshots.length - 1];
  if (!pr || !last) return false;
  return !(pr.heads ?? []).includes(last.n) && last.sha !== pr.headSha && last.n > (pr.headMark ?? 0);
}

/** Bring in the new commits merged them and no Build done has snapshotted
 *  the merge (`pr_review.rs::merged_not_built`). */
export function mergedNotBuilt(card: PrCard): boolean {
  const pr = card.prReview;
  const snapshots = card.builder?.snapshots ?? [];
  const last = snapshots[snapshots.length - 1]?.n ?? 0;
  return Boolean(pr?.merged) && last <= (pr?.headMark ?? 0);
}

/** Bring in the new commits (`pr_review.rs::merge_offered`): new commits on
 *  top of the head an unpushed fix is built on. A pushed fix is the head the
 *  branch is on: new commits on top of it are new commits to review. */
export function mergeOffered(card: PrCard): boolean {
  const pr = card.prReview;
  if (!pr || !pr.pushable || pr.state !== "open") return false;
  return !mergedNotBuilt(card) && unpushedFix(card) && (pr.branchHead ?? null) !== pr.headSha;
}

/** The press Review / Review again offers, or null when there is none. An
 *  unpushed fix with new commits on top brings them in first instead. */
export function reviewPressLabel(offer: ReviewOffer | null, card?: PrCard): string | null {
  if (card && (mergeOffered(card) || mergedNotBuilt(card))) return null;
  switch (offer) {
    case "review":
      return "Review";
    case "newCommits":
    case "runAgain":
      return "Review again";
    default:
      return null;
  }
}

export const PR_MERGED_LABEL = "Pull request merged";
export const PR_REVIEW_CLOSED_LABEL = "Pull request closed";
export const FIX_READY_LABEL = "Fix ready to push";

/** The card's state word on the Board and its page. */
export function prReviewLabel(card: PrCard): string | null {
  const offer = reviewOffer(card);
  if (offer === null) return null;
  const pr = card.prReview!;
  if (offer === "closed") return pr.state === "merged" ? PR_MERGED_LABEL : PR_REVIEW_CLOSED_LABEL;
  if (offer === "running") return "Reviewing";
  if (mergedNotBuilt(card)) return "Merged, not built yet";
  if (mergeOffered(card)) return "New commits under your fix";
  if (pushOffered(card)) return FIX_READY_LABEL;
  if (offer === "newCommits") return "New commits to review";
  if (offer === "review") return "Not reviewed yet";
  const review = currentReview(card);
  if (offer === "runAgain") return review?.status === "failed" ? "Review failed" : "Review incomplete";
  // 1.171.0 C3 (CP-9): an override is the person's decision.
  if (review?.status === "skipped") return review.note ? OVERRIDDEN_WORD : "Review skipped";
  return review?.verdict === "changes_requested" ? "Changes requested" : "Approved";
}

/**
 * The card's presentation state, for the Board's columns: reviewing is
 * Working; a review to run (none yet, new commits, one that didn't finish),
 * changes asked for or a fix ready to push is Needs you; approved is
 * Waiting (on the pull request); merged or closed is Done. Idle states draw
 * no live or green dot. Null when the card's own Builder session decides (a
 * fix of the member's own pull request under way).
 */
export function prReviewCardState(
  card: PrCard & Pick<KanbanCard, "lastRunStatus" | "verifyStatus">,
): CardPresentationState | null {
  const offer = reviewOffer(card);
  if (offer === null) return null;
  if (offer === "closed") return "closed";
  if (card.lastRunStatus === "running") return null;
  if (offer === "running") return "challenger-reviewing";
  if (card.verifyStatus === "queued" || card.verifyStatus === "running") return "checking";
  if (card.verifyStatus === "failed" && unpushedFix(card)) return "verify-failed";
  if (mergedNotBuilt(card) || mergeOffered(card) || pushOffered(card)) return "review-stale";
  if (offer === "current") {
    return currentReview(card)?.verdict === "changes_requested" ? "changes-requested" : "paused";
  }
  return "review-stale";
}

/** Fix with the Builder: the member's own open pull request, no session
 *  open. The backend decides again (`pr_review::builder_refusal`). */
export function fixOffered(card: PrCard): boolean {
  const pr = card.prReview;
  return Boolean(pr && pr.pushable && pr.state === "open" && !card.builder?.ptyId);
}

/** Push the fixes: the member's own open pull request, its newest snapshot
 *  a fix GitHub doesn't have, built on the head GitHub still has. The
 *  backend decides again (Ship's gate, the Challenger's request, GitHub's
 *  head, the protected branches). */
export function pushOffered(card: PrCard): boolean {
  const pr = card.prReview;
  if (!pr || !pr.pushable || pr.state !== "open") return false;
  if (card.verifyStatus === "failed") return false;
  return unpushedFix(card) && fixReviewSettled(card) && (pr.branchHead ?? null) === pr.headSha;
}

/** Walk 2 of #386 (finding 5), `pr_review.rs::fix_review_settled`: the
 *  Challenger's review of the newest snapshot (the fix) ran or was skipped,
 *  none runs or waits on the card, and it asked for no changes. */
export function fixReviewSettled(card: PrCard): boolean {
  const b = card.builder;
  const last = b?.snapshots[b.snapshots.length - 1];
  if (!b || !last || b.waitingReview) return false;
  const review = b.review ?? null;
  if (!review || review.status === "running" || review.snapshotN !== last.n) return false;
  return !(review.status === "done" && review.verdict === "changes_requested");
}

/** The vendor that builds on the card (its session's, else the card's
 *  Builder property) is the Challenger chosen: the fix's review is not by
 *  the other AI. */
export function sameVendorReview(card: PrCard): boolean {
  const challenger = card.prReview?.challenger ?? null;
  if (!challenger || !card.prReview?.pushable) return false;
  const builder = (card.builder?.startedAt ?? 0) > 0 ? card.builder?.vendor : card.builderVendorPref;
  return builder === challenger;
}

/** The Challenger's name: the one chosen in the sheet. */
export function challengerName(card: PrCard): string {
  const chosen = card.prReview?.challenger ?? card.builder?.review?.provider ?? null;
  return chosen === "codex" ? "Codex" : "Claude";
}

/** `#12 · by @octo · retry-upload → main` */
export function prLine(pr: PrReview): string {
  const by = pr.author ? ` · by @${pr.author}` : "";
  return `#${pr.number}${by} · ${pr.headRef} → ${pr.baseRef}`;
}

/** The review's one sentence on the card page. */
export function reviewSentence(card: PrCard): string {
  const offer = reviewOffer(card);
  const pr = card.prReview;
  if (!pr || offer === null) return "";
  const who = challengerName(card);
  if (offer !== "closed" && offer !== "running" && mergedNotBuilt(card)) {
    return "The pull request's new commits are merged into the card's branch but not built yet. Resume the Builder and press Finish and check: the checks and the Reviewer run on the merge, then Send the fixes to GitHub.";
  }
  if (offer !== "closed" && offer !== "running" && mergeOffered(card)) {
    return "The pull request has new commits on top of the head your fix is built on. Bring them in: Plyloft merges them under your fix, and the checks and the Reviewer then run on the merge by themselves.";
  }
  if (offer !== "closed" && offer !== "running" && pushOffered(card)) {
    // 1.171.0 B3 (CP-17): the same line as a card's own pull request.
    return sendFixesLine(pr.number);
  }
  switch (offer) {
    case "closed":
      return pr.state === "merged"
        ? `Pull request #${pr.number} was merged. There is nothing more to review; archive the card when you are done with it.`
        : `Pull request #${pr.number} was closed. There is nothing more to review; archive the card when you are done with it.`;
    case "running":
      return `The Reviewer (${who}) is reviewing the pull request read-only. Its findings stay here in Plyloft.`;
    case "newCommits":
      return "The pull request has commits the Reviewer hasn't reviewed.";
    case "review":
      return "The Reviewer hasn't reviewed this pull request yet.";
    case "runAgain": {
      const review = currentReview(card);
      return review?.status === "failed"
        ? `The Reviewer's (${who}) review didn't finish${review.error ? `: ${showBackendText(review.error)}` : "."}`
        : `The review is incomplete: the Reviewer (${who}) couldn't see enough of the pull request${
            // `challengerReview.ts::incompleteReasonWords`, inlined as above.
            review?.incompleteReason
              ? ` (${review.incompleteReason === "diff too large" ? "the changes were too large" : review.incompleteReason})`
              : ""
          }.`;
    }
    case "current": {
      const review = currentReview(card);
      if (review?.status === "skipped") {
        return review.note
          ? `The Reviewer (${who}) asked for changes; you kept it as it was instead.`
          : "The review of this head was skipped.";
      }
      return review?.verdict === "changes_requested"
        ? `The Reviewer (${who}) asked for changes. Its findings stay here in Plyloft; nothing is posted to the pull request.`
        : // 1.171.0 C3 (CF25): the one approval word, its small notes counted.
          `${reviewApprovedWord(review)}: the Reviewer (${who}) reviewed the pull request without changing it.`;
    }
  }
}

/** Someone else's pull request: the card has no Builder at all — no
 *  Builder property, no notes for one, no session. */
export function reviewOnly(card: { prReview?: PrReview | null }): boolean {
  return Boolean(card.prReview && !card.prReview.pushable);
}

/**
 * Walk of #386: the card page's Status property on a pull request card. The
 * review's own word while it decides the card (not a normal card's hand-off
 * words, "Snapshot 1's requested changes have not reached the Builder"), and
 * on someone else's "· review only". Null while the member's own Builder
 * session decides (a fix under way): the card's usual words fit then.
 */
export function prStatusWord(card: PrCard & Pick<KanbanCard, "lastRunStatus" | "verifyStatus">): string | null {
  if (!card.prReview || prReviewCardState(card) === null) return null;
  const label = prReviewLabel(card);
  if (!label) return null;
  return reviewOnly(card) ? `${label} · review only` : label;
}
