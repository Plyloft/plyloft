/**
 * 1.170.0 (G6): a card kept up to date with its target branch — by merging,
 * never by rewriting, and only on the person's press (owner, 2026-10-26:
 * a badge and a button, never automatic). Pure, no React and no store, so
 * the words and the rules are tested once (`targetSync.test.ts`).
 *
 * The badge reads the card's own reading (`cards_target_sync`: commits of
 * GitHub's target the card's branch lacks, and a dry merge) and, on a card
 * whose pull request is open, GitHub's own merge state (behind, dirty).
 * Bring in the target's changes (`card_bring_in_target`) merges GitHub's
 * target into the card's copy with nothing committed; Finish and check
 * commits it; Push update sends it to an open pull request.
 */
import type { BringInResult, CardTargetSync, KanbanCard, TargetSyncReport } from "../ipc.ts";
import { prOpen } from "./prStatus.ts";
import { ASK_BUILDER_LABEL, syncConflictBeside } from "./shipConflict.ts";
import { targetName } from "./worktreeBase.ts";
import { SEND_FIXES_LABEL } from "./deliveryWords.ts";

type SyncCard = Pick<
  KanbanCard,
  | "archived"
  | "shipStatus"
  | "reviewStatus"
  | "pr"
  | "prUrl"
  | "prReview"
  | "builder"
  | "worktreePath"
  | "lastRunStatus"
  | "shipConflict"
>;

export type TargetSyncBadge = {
  kind: "behind" | "conflict";
  label: string;
  /** The chip's tooltip, on the Board and on the card's line (1.171.0 E3,
   *  BI-4: the Board used to drop it). */
  title: string;
  /** 1.171.0 E3 (DL-22): it asks something of the person — a conflict, or
   *  GitHub requires the pull request to be up to date before it merges.
   *  Otherwise the chip is quiet: being behind is usually nothing to do. */
  urgent: boolean;
};

function commitsWord(n: number): string {
  return n === 1 ? "1 commit" : `${n} commits`;
}

// G10 at the integration: an unknown target is "your main branch", never
// "the target branch" (`worktreeBase.ts::targetName`).
function branchOf(target: string | null | undefined): string {
  return target && target.trim() ? target : targetName(null);
}

/** 1.173.0 (B3): the branch a card is measured against — its area's when
 *  the reading names one, else the workspace's. */
export function cardTarget(report: Pick<TargetSyncReport, "target" | "cards">, cardId: string): string {
  return report.cards[cardId]?.target ?? report.target;
}

/** The badge's words: "Behind main", "Conflict ahead". */
export function behindLabel(target: string): string {
  return `Behind ${branchOf(target)}`;
}
export const CONFLICT_AHEAD_LABEL = "Conflict ahead";

/** The button: "Bring in main's changes". */
export function bringInLabel(target: string): string {
  return `Bring in ${branchOf(target)}'s changes`;
}

/** A card the badge speaks for: not archived, not landed (an open pull
 *  request's card is), not a pull request review, not stopped on a
 *  conflict (its own words say so). */
function speaksFor(card: SyncCard): boolean {
  if (card.archived || card.prReview) return false;
  if (card.reviewStatus === "conflict_blocked") return false;
  if (card.shipStatus === "shipped") return false;
  if (card.reviewStatus === "merged" && !prOpen(card)) return false;
  return true;
}

/** What being behind is: "main on GitHub has 3 commits this card doesn't
 *  have." — the card's line and the chip's tooltip start with it. */
function behindFact(b: string, behind: number): string {
  return behind > 0
    ? `${b} on GitHub has ${commitsWord(behind)} this card doesn't have.`
    : `${b} on GitHub has changes this card doesn't have.`;
}

/** The card's badge, or null: GitHub's merge state on an open pull
 *  request, else the card's own reading. Nothing while a merge is pending
 *  in its copy ([`targetSyncSentence`] says what to press). */
export function targetSyncBadge(
  card: SyncCard,
  sync: CardTargetSync | null | undefined,
  target: string,
): TargetSyncBadge | null {
  if (!speaksFor(card) || sync?.merging) return null;
  const b = branchOf(target);
  const pr = prOpen(card) ? card.pr! : null;
  const conflict =
    Boolean(sync?.conflict) || (pr != null && (pr.mergeState === "dirty" || pr.mergeable === "conflicting"));
  if (conflict) {
    return {
      kind: "conflict",
      label: CONFLICT_AHEAD_LABEL,
      title: `${b} on GitHub changed the same lines as this card. Bringing its changes in needs the conflict resolved. Open the card to see how.`,
      urgent: true,
    };
  }
  const behind = sync?.behind ?? 0;
  // GitHub's "behind": the repository requires the pull request to be up
  // to date before it merges.
  const required = pr?.mergeState === "behind";
  if (behind > 0 || required) {
    const has = behindFact(b, behind);
    return {
      kind: "behind",
      label: behindLabel(b),
      title: required
        ? `${has} GitHub needs them in before it merges the pull request: open the card to bring them in.`
        : `${has} Nothing to do unless GitHub asks for them or they clash with this card's changes.`,
      urgent: required,
    };
  }
  return null;
}

/** GitHub itself says the open pull request conflicts: Fix with the
 *  Builder is its way (it merges too). */
function githubConflicts(card: SyncCard): boolean {
  return prOpen(card) && card.pr?.mergeable === "conflicting";
}

/** Bring in the target's changes is offered: a badge, a Builder to take
 *  the merge through Finish and check, its turn over, a copy to merge in,
 *  no conflict recorded yet. Not when GitHub says the open pull request
 *  conflicts — Fix with the Builder is its way. */
export function bringInOffered(
  card: SyncCard,
  sync: CardTargetSync | null | undefined,
  target: string,
): boolean {
  const badge = targetSyncBadge(card, sync, target);
  if (!badge || !card.builder || !card.worktreePath) return false;
  if (card.lastRunStatus === "running" || card.shipConflict) return false;
  if (badge.kind === "conflict" && githubConflicts(card)) return false;
  return true;
}

/** (orchestrator #8) An open pull request's card whose bring-in met a
 *  conflict: Ask the Builder to resolve it is offered on its line, until
 *  the merge is started for it. */
export function askBuilderOnLine(card: SyncCard): boolean {
  const beside = prOpen(card) ? syncConflictBeside(card) : null;
  return Boolean(beside && beside.mergeStartedAt == null && card.builder && !card.archived && card.lastRunStatus !== "running");
}

export function bringInTitle(target: string): string {
  return `Merges ${branchOf(target)} from GitHub into the card's copy. Nothing is committed or pushed until you press Finish and check.`;
}

/** The line under Now: what the badge means, or that a merge waits for
 *  Finish and check. Null when there is nothing to say. */
export function targetSyncSentence(
  card: SyncCard,
  sync: CardTargetSync | null | undefined,
  target: string,
): string | null {
  const b = branchOf(target);
  const beside = prOpen(card) && speaksFor(card) ? syncConflictBeside(card) : null;
  if (beside) {
    const branch = branchOf(beside.branch || target);
    if (beside.mergeStartedAt != null) {
      return `The Builder is resolving the conflict with ${branch}. When it's done, press Finish and check, then ${SEND_FIXES_LABEL} sends it to the pull request.`;
    }
    return `${branch} on GitHub changed the same lines as this card. ${
      card.builder ? "Press Fix with the Builder." : "Resolve it in the card's copy, then press Finish and check."
    }`;
  }
  if (sync?.merging && speaksFor(card)) {
    return `${b}'s changes are merged in the card's copy, not committed yet. Press Finish and check to commit them and run the checks.${
      prOpen(card) ? ` Then ${SEND_FIXES_LABEL} sends them to the pull request.` : ""
    }`;
  }
  const badge = targetSyncBadge(card, sync, target);
  if (!badge) return null;
  // (Challenger) The next step is said only when its button is there.
  const offered = bringInOffered(card, sync, target);
  if (badge.kind === "conflict") {
    if (githubConflicts(card)) {
      return `${b} on GitHub changed the same lines as this card. Fix with the Builder sends it the conflict to resolve.`;
    }
    return `${b} on GitHub changed the same lines as this card.${
      offered ? " Bring in its changes, then ask the Builder to resolve the conflict." : ""
    }`;
  }
  return `${behindFact(b, sync?.behind ?? 0)}${offered ? " Bring them in to keep the card up to date." : ""}`;
}

/** The toast after the press. `onAsk`: Ask the Builder to resolve it, for
 *  a recorded conflict. */
export function bringInToast(
  result: Pick<BringInResult, "kind" | "target" | "paths" | "recorded">,
  prIsOpen: boolean,
  onAsk: (() => void) | null,
): {
  kind: "info" | "warn";
  title: string;
  body: string;
  details?: string;
  action?: { label: string; onClick: () => void };
} {
  const b = branchOf(result.target);
  if (result.kind === "up_to_date") {
    return { kind: "info", title: "Already up to date", body: `The card already has everything ${b} on GitHub has.` };
  }
  if (result.kind === "merged") {
    return {
      kind: "info",
      title: `${b}'s changes are in the card's copy`,
      body: `Nothing is committed yet. Press Finish and check to commit the merge and run the checks.${
        prIsOpen ? ` Then ${SEND_FIXES_LABEL} sends it to the pull request.` : ""
      }`,
    };
  }
  const details = result.paths.length > 0 ? result.paths.join("\n") : undefined;
  return {
    kind: "warn",
    title: `${b} changed the same lines`,
    body: "Nothing was merged, and the card's work is safe. Press Fix with the Builder.",
    details,
    // Walk 8.3: the press's own name, as the body and the page say it.
    ...(onAsk ? { action: { label: ASK_BUILDER_LABEL, onClick: onAsk } } : {}),
  };
}
