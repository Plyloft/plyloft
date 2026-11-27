/**
 * SL-2 (ship loop): "Fix with the Builder" and Push update — pure, no React
 * and no store, so the rules and the words are tested once
 * (`prFix.test.ts`).
 *
 * A press — except, since 1.170.0 (G7, owner 2026-10-26), failed checks on
 * a card whose "Fix failing checks by itself" is on: `prAutoFix.ts` sends
 * those and finishes and pushes by itself (a review or a conflict stays a
 * press). The backend gathers what the card's open
 * pull request needs (`card_pr_fix_message`); this pastes it into the card's
 * Builder session — resumed first when it is closed — and says how it went.
 * When the Builder is done, the normal loop runs (Build done: verify and the
 * Challenger), then Push update sends the verified snapshot to the same
 * pull request.
 */
import type { KanbanCard, PrFixKind, PrFixMessage, PrStatus } from "../ipc.ts";
import {
  MERGE_STATE_IN_THE_WAY,
  PR_HEAD_MOVED_LINE,
  PR_MERGE_GITHUB_HEAD_LABEL,
  prChecksNow,
  prHeadMoved,
  prMergeBlocked,
  prMergeOffered,
  prOpen,
  prWaitsForReview,
} from "./prStatus.ts";
import { challengerRequestedChanges } from "./cardLifecycle.ts";
import { sanitizeForPaste } from "./lineComments.ts";
import { SEND_FIXES_LABEL, sendFixesLine } from "./deliveryWords.ts";

type FixCard = Pick<KanbanCard, "reviewStatus" | "pr" | "prUrl" | "archived" | "builder" | "worktreePath">;

/** What the open pull request needs fixed now (mirrors `pr_fix.rs::fix_kinds`). */
export function prFixKinds(pr: PrStatus): PrFixKind[] {
  if (pr.state !== "open") return [];
  const kinds: PrFixKind[] = [];
  if (pr.mergeable === "conflicting") kinds.push("conflict");
  // Walk I1: a failure GitHub still shows for the head before a push is
  // not the pushed commit's.
  if (prChecksNow(pr) === "failing") kinds.push("checks");
  if (pr.reviewDecision === "changes_requested") kinds.push("review");
  return kinds;
}

/**
 * v1.154.1 (walk I4): what a fix was sent for — the pull request's head and
 * what GitHub said is wrong with it. A new head (Push update), a new
 * failure, a new review or a conflict that comes or goes is a new key.
 */
export function prFixKey(pr: PrStatus): string {
  return [
    pr.headSha ?? "",
    prFixKinds(pr).join(","),
    pr.failingChecks.map(checkKey).sort().join(","),
    String(pr.changesRequested?.submittedAt ?? ""),
  ].join("|");
}

function checkKey(c: { name: string; workflow?: string | null }): string {
  return `${c.workflow ?? ""}/${c.name}`;
}

/** Walk I4: a fix already went to the Builder for what the pull request
 *  needs now (`sentKey`, the `prFixKey` at that delivery). */
export function prFixSent(card: Pick<KanbanCard, "pr">, sentKey: string | null | undefined): boolean {
  return Boolean(sentKey) && Boolean(card.pr) && prFixKey(card.pr!) === sentKey;
}

/** The card offers Fix with the Builder: an open pull request with
 *  something to fix, a Builder and its worktree — and not a fix already
 *  sent for exactly that (walk I4: a second press would send it again). */
export function prFixOffered(card: FixCard, sentKey?: string | null): boolean {
  return (
    !card.archived &&
    prOpen(card) &&
    Boolean(card.builder) &&
    Boolean(card.worktreePath) &&
    prFixKinds(card.pr!).length > 0 &&
    !prFixSent(card, sentKey)
  );
}

/** Walk I4: the line while the Builder has the fix and GitHub's pull
 *  request is as it was. */
export function prFixSentLine(prNumber: number, byItself = true): string {
  return `The Builder has what pull request #${prNumber} needs. ${prFixNext(byItself)}`;
}

/** Walk I4: the Now label while the Builder has the fix. */
export const FIX_SENT_LABEL = "Fix sent to the Builder";

/**
 * v1.154.1 round 3 (RW-A): the Now line of the fix round, from the live
 * session as the card's Builder header reads it — working, at its prompt
 * with its turn over (round 2's idle words), a question waiting, or quiet.
 * No session attached: what the Builder has, and what comes next.
 */
export function prFixRoundLine(
  prNumber: number,
  who: string,
  attention: "working" | "asking-you" | "wants-you" | null,
  turnIdle: boolean,
  byItself = true,
): string {
  const next = prFixNext(byItself);
  if (attention === "working") return `${who} is working on what pull request #${prNumber} needs. ${next}`;
  if (attention === "asking-you" && turnIdle) {
    // 1.171.0 C2 (CF8): no "turn" or "prompt" on screen.
    return `${who} says it's done. If the fix is done: Finish and check, then ${SEND_FIXES_LABEL}.`;
  }
  if (attention === "asking-you") return `${who} asks you something in its session.`;
  if (attention === "wants-you") return `${who} has gone quiet: it may be asking something. ${next}`;
  return prFixSentLine(prNumber, byItself);
}

/** 1.175.0 F5: what follows the fix — the check by itself, or (a card set
 *  to "Waits for me", round 2) the press, as before 1.175. */
export function prFixNext(byItself: boolean): string {
  return byItself
    ? `When it's done, Plyloft checks the fix by itself; then ${SEND_FIXES_LABEL}.`
    : `When it's done: Finish and check, then ${SEND_FIXES_LABEL}.`;
}

/** The last build snapshot, when GitHub's pull request doesn't have it yet:
 *  what Push update would send. Null when there is nothing to push. */
export function pushUpdateSnapshot(card: FixCard): { n: number; sha: string } | null {
  if (card.archived || !prOpen(card)) return null;
  // v1.154.1 (M1, ADR 0006): a snapshot the Challenger asked changes to is not
  // sent until they are addressed or overridden (`pr_fix::push_update`).
  if (challengerRequestedChanges(card.builder)) return null;
  const snapshots = card.builder?.snapshots ?? [];
  const last = snapshots[snapshots.length - 1];
  if (!last || last.sha === card.pr!.headSha) return null;
  // Walk I1: just pushed; GitHub still shows the head before it.
  // G1–G3 Challenger (2): or GitHub has commits on top of it Plyloft didn't
  // push — sending it again is nothing to do (`prHeadMoved` says so).
  const pushed = card.pr!.pushedHead;
  if (pushed && (pushed.startsWith(last.sha) || last.sha.startsWith(pushed))) return null;
  return { n: last.n, sha: last.sha };
}

// v1.154.1 round 3 (RW-A): `prMergeBlocked` lives in `prStatus.ts` (1.169.1,
// R1: the Board's readiness reads it too); re-exported for its callers.
export { prMergeBlocked };

/** Round 3: Merge is offered (Now's primary, Shipping's button) — nothing in
 *  the way, checks on GitHub passed (or none, once the wait after a push is
 *  over), read at least once, and GitHub isn't merging it on its own. */
export function prMergeReady(card: FixCard): boolean {
  if (prMergeBlocked(card)) return false;
  const pr = card.pr!;
  return (
    pr.checkedAt != null &&
    !pr.autoMerge &&
    !pr.awaitingChecks &&
    // 1.169.1 (R1, round 2): not when GitHub's merge state is in the way —
    // the Board says On hold; Now offers View the pull request.
    !MERGE_STATE_IN_THE_WAY.has(pr.mergeState ?? "") &&
    (pr.checks === "passing" || pr.checks === "none")
  );
}

/** Round 3 (Challenger): Shipping's Merge — SL-3's rule: nothing in the
 *  way, not waiting for a push's checks, read at least once, GitHub not
 *  merging it on its own. Pending checks included: GitHub judges (its
 *  answer is shown). Now's primary stays `prMergeReady`. */
export function prShippingMergeOffered(card: FixCard): boolean {
  if (prMergeBlocked(card)) return false;
  const pr = card.pr!;
  // 1.169.1 (R1, Challenger m4): not while GitHub waits for a required
  // review — it would refuse; Open on GitHub is the way.
  // Round 2: nor when GitHub's merge state is in the way (blocked, behind,
  // a draft, dirty).
  return (
    !pr.awaitingChecks &&
    pr.checkedAt != null &&
    !pr.autoMerge &&
    !prWaitsForReview(pr) &&
    !MERGE_STATE_IN_THE_WAY.has(pr.mergeState ?? "")
  );
}

/** Round 3: "Merge when checks pass" is offered in Shipping — nothing in the
 *  way, auto-merge off, and checks not passed already (then it's Merge). */
export function prAutoMergeOffered(card: FixCard): boolean {
  if (prMergeBlocked(card)) return false;
  const pr = card.pr!;
  return !pr.autoMerge && !pr.plyloftAutoMerge && !pr.autoMergeRefused && !(prChecksNow(pr) === "passing");
}

/** G1–G3 Challenger (2): Merge what's on GitHub now is offered — GitHub's
 *  head isn't the one Plyloft pushed, and nothing else stands in the way
 *  (a failed check, a conflict, a request for changes, the Challenger's,
 *  GitHub merging it on its own). The person's decision, after a look. */
export function prHeadMovedMergeOffered(card: FixCard): boolean {
  if (card.archived || !prOpen(card) || !prMergeOffered(card)) return false;
  const pr = card.pr!;
  return (
    prHeadMoved(pr) &&
    pr.checkedAt != null &&
    !pr.autoMerge &&
    prChecksNow(pr) !== "failing" &&
    pr.mergeable !== "conflicting" &&
    pr.reviewDecision !== "changes_requested"
  );
}

/** The line beside Send the fixes to GitHub (`pr_push_update`). */
export function pushUpdateLine(card: FixCard): string | null {
  const snap = pushUpdateSnapshot(card);
  if (!snap) return null;
  return sendFixesLine(card.pr!.number);
}

/**
 * v1.154.1 (F14, F18): the Now callout's one action for a card whose pull
 * request is open — what it needs next, in this order: a snapshot GitHub
 * doesn't have yet → Push update; failed checks on GitHub, a request for
 * changes or a conflict (with a Builder to fix it) → Fix with the Builder;
 * checks passed and nothing in the way, auto-merge off → Merge. Otherwise
 * (running checks, auto-merge on, no Builder) it shows the pull request.
 * Null when the pull request isn't open.
 */
export function prNowAction(
  card: FixCard,
  /** Walk I4: the `prFixKey` a fix was last delivered for, on this card. */
  fixSentKey?: string | null,
  /** 1.175.0 F5 round 2: the card checks a fix round by itself. */
  byItself = true,
): {
  actionId:
    | "pr-push-update"
    | "pr-fix"
    | "pr-merge"
    | "pr-merge-github-head"
    | "pr-open-github"
    | "pr-auto-merge-off"
    | "inspect-ship"
    | "inspect-run";
  actionLabel: string;
  actionTitle: string;
  /** The state's own label, when it isn't the pull request's. */
  label?: string;
  helper?: string;
} | null {
  if (card.archived || !prOpen(card)) return null;
  const pr = card.pr!;
  const snap = pushUpdateSnapshot(card);
  if (snap) {
    return {
      actionId: "pr-push-update",
      // 1.171.0 B3 (CP-17, owner D7): the label says what it does; the
      // command is `card_pr_push_update`, as before.
      actionLabel: SEND_FIXES_LABEL,
      actionTitle: `Updates pull request #${pr.number}; GitHub runs its checks again. Never forced.`,
      helper: sendFixesLine(pr.number),
    };
  }
  // Walk I4: the fix round — the Builder has the fix; nothing to press
  // until it is done (Build done) or GitHub says something new.
  if (prFixKinds(pr).length > 0 && prFixSent(card, fixSentKey) && card.builder) {
    return {
      actionId: "inspect-run",
      actionLabel: "Open the Builder",
      actionTitle: "Show the Builder session working on the fix.",
      label: FIX_SENT_LABEL,
      helper: prFixSentLine(pr.number, byItself),
    };
  }
  if (prFixOffered(card, fixSentKey)) {
    return {
      actionId: "pr-fix",
      actionLabel: "Fix with the Builder",
      actionTitle:
        "Send what the pull request needs — failed logs, the review, the conflict — to this card's Builder. It doesn't push.",
    };
  }
  // G1–G3 Challenger (2): commits on GitHub Plyloft didn't push — said, and
  // merged only on the person's own press.
  if (prHeadMovedMergeOffered(card)) {
    return {
      actionId: "pr-merge-github-head",
      actionLabel: PR_MERGE_GITHUB_HEAD_LABEL,
      actionTitle: `Merge pull request #${pr.number} as it is on GitHub now, commits Plyloft didn't push included. The card moves to Done.`,
      helper: PR_HEAD_MOVED_LINE,
    };
  }
  // 1.169.1 (R1): green, and GitHub requires a review first — that review
  // happens on GitHub (Merge would be refused there).
  if (!prMergeBlocked(card) && prWaitsForReview(pr)) {
    return {
      actionId: "pr-open-github",
      actionLabel: "Open on GitHub",
      actionTitle: `Open pull request #${pr.number} on GitHub, where it waits for a review.`,
    };
  }
  // Walk I1 / round 3: one rule for Now and Shipping (`prMergeReady`).
  if (prMergeReady(card)) {
    return {
      actionId: "pr-merge",
      actionLabel: "Merge",
      actionTitle: `Merge pull request #${pr.number} on GitHub. The card moves to Done.`,
    };
  }
  // 1.174.0 A2 (P7): it merges by itself once its checks pass — the press
  // that stops that (`card_pr_set_auto_merge` off).
  if (prAutoMergeOffOffered(card)) {
    return {
      actionId: "pr-auto-merge-off",
      actionLabel: DONT_MERGE_BY_ITSELF_LABEL,
      actionTitle: `Turns off Merge when checks pass. Pull request #${pr.number} stays open until you press Merge.`,
    };
  }
  return {
    actionId: "inspect-ship",
    actionLabel: "View the pull request",
    actionTitle: "Show its checks on GitHub, its review and the link.",
  };
}

/** 1.174.0 A2 (P7): the Now press while the open pull request merges by
 *  itself once its checks pass. */
export const DONT_MERGE_BY_ITSELF_LABEL = "Don't merge by itself";

/** 1.174.0 A2 (P7): "Don't merge by itself" is offered — the pull request is
 *  open and merges by itself (GitHub's auto-merge, or Plyloft's own), and
 *  its checks haven't failed (then the fix comes first). */
export function prAutoMergeOffOffered(card: FixCard): boolean {
  if (card.archived || !prMergeOffered(card)) return false;
  const pr = card.pr!;
  // Round 1: also while Plyloft holds a merge by itself it means to turn on
  // (`autoMergeWanted`: held, turned off for an unreviewed commit, resumed).
  return (pr.autoMerge || pr.plyloftAutoMerge === true || pr.autoMergeWanted != null) && prChecksNow(pr) !== "failing";
}

/** The line after a push GitHub took. */
export function pushedLine(prNumber: number): string {
  return `Pushed to pull request #${prNumber}; checks on GitHub run on it again.`;
}

export type FixOutcome = "sent" | "failed";

/** 1.174.0 A2 (P7): what ⋯ › Fix with the Builder sends on an open pull
 *  request, in the toasts' words. */
export const BRIEF_FIX_WHAT = "the brief as it reads now";

/** 1.174.0 A2 (P7): ⋯ › Fix with the Builder is offered — the card's pull
 *  request is open, it has a Builder, and Now isn't already pressing Fix
 *  with the Builder for what GitHub said. */
/** Its hint in the ⋯. */
export const BRIEF_FIX_HINT = "Sends What you want, as it reads now, to the card's Builder. It doesn't push.";

export function briefFixOffered(
  card: FixCard & Partial<Pick<KanbanCard, "notes">>,
  nowActionId: string | null,
): boolean {
  return (
    !card.archived &&
    prOpen(card) &&
    Boolean(card.builder) &&
    Boolean(card.worktreePath) &&
    Boolean(card.notes?.trim()) &&
    nowActionId !== "pr-fix"
  );
}

export interface FixDeps {
  /** 1.175.0 F5 round 2: the card checks a fix round by itself (absent: yes). */
  byItself?: boolean;
  /** 1.174.0 A2: what the fix is about, in words, when it isn't what
   *  GitHub said ("the changed brief"). */
  what?: string;
  /** `card_pr_fix_message`. */
  gather: () => Promise<PrFixMessage>;
  /** The card's own session is attached to its terminal now. */
  sessionOpen: () => boolean;
  /** The card records a session (its terminal may not be attached yet). */
  sessionRecorded: () => boolean;
  /** Resume the closed session in the card's worktree. Rejects when it
   *  couldn't (the resume says why on the card). */
  resume: () => Promise<void>;
  /** Open the card on its session, so its terminal is there to take it. */
  reveal: () => void;
  /** Wait for the card's session to attach; false when it didn't in time. */
  waitForSession: () => Promise<boolean>;
  /** SL-5's `deliverWhenIdle` (key `pr-fix`): written now at the prompt or
   *  held until then; resolves once written, rejects when the write failed
   *  or the session ended first; null when no session is attached. */
  deliver: (text: string, onQueued: () => void) => Promise<void> | null;
  /** The message is held for the prompt. */
  queued: () => void;
  notify: (kind: "info" | "warn" | "error", title: string, body: string, details?: string) => void;
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
}

/** What the Builder was told about, in words: "the conflict and the failed
 *  checks". */
export function fixWhat(kinds: readonly PrFixKind[]): string {
  const words = kinds.map((k) =>
    k === "conflict" ? "the conflict" : k === "checks" ? "the failed checks" : "the requested changes",
  );
  if (words.length <= 1) return words[0] ?? "what it needs";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * One press of Fix with the Builder: gather, find (or resume) the session,
 * paste. Every way it stops is said, with what was left untouched. The
 * message is cleaned of terminal control characters here too (the backend
 * already did): it goes into a bracketed paste.
 */
export async function fixWithBuilder(deps: FixDeps): Promise<FixOutcome> {
  let fix: PrFixMessage;
  try {
    fix = await deps.gather();
  } catch (e) {
    deps.notify(
      "error",
      "Nothing was sent to the Builder",
      deps.what ? `Plyloft couldn't send ${deps.what}.` : "Plyloft couldn't gather what the pull request needs.",
      reason(e),
    );
    return "failed";
  }
  const message = sanitizeForPaste(fix.message);
  if (!deps.sessionOpen()) {
    if (!deps.sessionRecorded()) {
      try {
        await deps.resume();
      } catch (e) {
        deps.notify("error", "Nothing was sent to the Builder", "Its session couldn't be resumed.", reason(e));
        return "failed";
      }
    }
    deps.reveal();
    if (!(await deps.waitForSession())) {
      deps.notify(
        "warn",
        "The Builder session didn't open",
        "Nothing was sent. Resume the session on the card, then press Fix with the Builder again.",
      );
      return "failed";
    }
  } else {
    deps.reveal();
  }
  const what = deps.what ?? fixWhat(fix.kinds);
  const next = prFixNext(deps.byItself !== false);
  const notes = fix.notes.length > 0 ? fix.notes.join("\n") : undefined;
  const written = deps.deliver(message, () => {
    deps.queued();
    deps.notify(
      "info",
      "Queued for the Builder",
      `What pull request #${fix.prNumber} needs (${what}) goes in when the Builder is back at its prompt.`,
      notes,
    );
  });
  if (written === null) {
    deps.notify(
      "warn",
      "The Builder session is not open",
      "Nothing was sent. Resume the session, then press Fix with the Builder again.",
    );
    return "failed";
  }
  try {
    await written;
  } catch (e) {
    deps.notify(
      "error",
      "The fix didn't reach the Builder",
      "Press Fix with the Builder to send it again.",
      reason(e),
    );
    return "failed";
  }
  deps.notify(
    "info",
    "Sent to the Builder",
    `What pull request #${fix.prNumber} needs (${what}) is in its session. ${next}`,
    notes,
  );
  return "sent";
}
