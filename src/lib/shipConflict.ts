/**
 * UX P1 point 7 (P-E): a local Ship that stopped on a git conflict, and
 * "Ask the Builder to resolve it" — pure, no React and no store, so the
 * words and the press's steps are tested once (`shipConflict.test.ts`).
 *
 * Plyloft starts the merge (`card_ship_conflict_start`: the commit the
 * failed ship met, merged in the card's copy with nothing committed); the
 * Builder only resolves the conflict marks; Finish and check commits the
 * merge. Nothing here pushes.
 */
import type { KanbanCard, ShipConflict, ShipConflictMessage } from "../ipc.ts";
import { sanitizeForPaste } from "./lineComments.ts";
import { targetName } from "./worktreeBase.ts";

type ConflictCard = Pick<KanbanCard, "reviewStatus" | "shipConflict" | "builder" | "archived">;

/** The card's last ship stopped on a conflict (rule 18). */
export function shipConflictOf(card: ConflictCard): ShipConflict | null {
  return card.reviewStatus === "conflict_blocked" ? (card.shipConflict ?? null) : null;
}

/** Plyloft has started the merge for the Builder to resolve. */
export function conflictMergeStarted(card: ConflictCard): boolean {
  return shipConflictOf(card)?.mergeStartedAt != null;
}

/** The press is offered: a conflict recorded on a card with a Builder. */
export function askBuilderOffered(card: ConflictCard): boolean {
  return Boolean(shipConflictOf(card)) && Boolean(card.builder) && !card.archived;
}

function branchOf(branch: string | null | undefined): string {
  return branch && branch.trim() ? branch : targetName(null);
}

function filesWord(n: number): string {
  return n === 1 ? "1 file" : `${n} files`;
}

// 1.175.0 F8 (and F9's one "Fix with the Builder"): the conflict's press.
export const ASK_BUILDER_LABEL = "Fix with the Builder";
/** F8: the same press as a way out of the ship's error in Now. */
export const CONFLICT_FIX_ACTION = { id: "ship-conflict-ask", label: ASK_BUILDER_LABEL } as const;
export const ASK_BUILDER_TITLE = "Sends the Builder what conflicts and how to resolve it. It doesn't ship.";
export const SHIP_AGAIN_LABEL = "Ship again";
export const UNDO_MERGE_LABEL = "Undo the merge";
export const UNDO_MERGE_TITLE =
  "Stops the merge in the card's copy; the Builder's edits to the conflicting files since it started are dropped.";
export const SEND_AGAIN_LABEL = "Send the message again";
/** After the press: Now's sentence while the Builder resolves it. */
export const CONFLICT_SENT_HELPER =
  "When it has resolved the conflict, press Finish and check. Ship waits until then.";
/** 1.175.0 F8 (card-page.html §6b): Now's sentence while the Builder
 *  resolves it — who, and with what. Until Plyloft checks the fix by
 *  itself (F5), the press is still Finish and check. */
export function conflictSentHelper(ai: string, branch: string | null | undefined): string {
  return `${ai} is resolving the conflict with ${branchOf(branch)}. When it's done, press Finish and check. Ship waits until then.`;
}
export const NO_BUILDER_SENTENCE = "Resolve it in the card's copy, then ship again.";

/** 1.170.0 (G6): the headline of a conflict Bring in the target's changes
 *  met ("Conflict with main"), in place of a ship's. */
export function syncConflictHeadline(branch: string | null | undefined): string {
  return `Conflict with ${branchOf(branch)}`;
}

/** 1.170.0 (G6, orchestrator #8): a bring-in's conflict on a card whose
 *  pull request is open — recorded beside the pull request's status, never
 *  over it (the card still reads as its pull request). */
export function syncConflictBeside(card: ConflictCard): ShipConflict | null {
  const c = card.shipConflict;
  return c?.sync && card.reviewStatus !== "conflict_blocked" ? c : null;
}

/** 1.170.0 (G6): the ⋯ entry that drops a bring-in's conflict — before the
 *  merge is started for the Builder, and after. */
export function leaveOutLabel(branch: string | null | undefined): string {
  return `Leave ${branchOf(branch)}'s changes out`;
}
export const LEAVE_OUT_TITLE =
  "The card's copy goes back to how it was before you brought them in; the Builder's edits to the conflicting files since the merge started are dropped.";

/** Rule 18's sentence on the card. */
export function shipConflictSentence(card: ConflictCard): string {
  const conflict = shipConflictOf(card);
  const head = conflict
    ? `${branchOf(conflict.branch)}${conflict.sync ? " on GitHub" : ""} changed the same lines as this card${
        conflict.paths.length > 0 ? ` in ${filesWord(conflict.paths.length)}` : ""
      }. Nothing was merged.`
    : "The last ship stopped on a conflict. Nothing was merged.";
  return card.builder ? head : `${head} ${NO_BUILDER_SENTENCE}`;
}

/** The one toast both press sites raise (Ship it on the card, Merge in the
 *  review panel). `onAsk` is the press, given only for a card with a
 *  Builder; otherwise the body says how to do it by hand. */
export function shipConflictToast(
  paths: readonly string[],
  branch: string | null | undefined,
  onAsk: (() => void) | null,
): {
  kind: "warn";
  title: string;
  body: string;
  details: string;
  action?: { label: string; onClick: () => void };
} {
  const b = branchOf(branch);
  return {
    kind: "warn",
    title: `Ship stopped: ${b} changed the same lines`,
    body: onAsk
      ? "Nothing was merged, and the card's work is safe. Press Fix with the Builder, then ship again."
      : `Nothing was merged, and the card's work is safe. ${NO_BUILDER_SENTENCE}`,
    details: paths.length > 0 ? paths.join("\n") : "Git didn't name the files.",
    ...(onAsk ? { action: { label: "Ask the Builder", onClick: onAsk } } : {}),
  };
}

export type ResolveOutcome = "sent" | "failed";

export interface ResolveDeps {
  /** `card_ship_conflict_start`: starts the merge, returns the message. */
  start: () => Promise<ShipConflictMessage>;
  sessionOpen: () => boolean;
  sessionRecorded: () => boolean;
  resume: () => Promise<void>;
  reveal: () => void;
  waitForSession: () => Promise<boolean>;
  /** `deliverWhenIdle`: resolves once written; null with no session. */
  deliver: (text: string, onQueued: () => void) => Promise<void> | null;
  queued: () => void;
  notify: (kind: "info" | "warn" | "error", title: string, body: string, details?: string) => void;
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
}

/**
 * One press of "Ask the Builder to resolve it": the session first (resumed
 * when closed), so a merge is never started for a Builder that can't hear
 * about it; then Plyloft starts the merge; then the message goes in at the
 * prompt. Every way it stops says what was left as it was.
 */
export async function askBuilderToResolve(deps: ResolveDeps): Promise<ResolveOutcome> {
  if (!deps.sessionOpen()) {
    if (!deps.sessionRecorded()) {
      try {
        await deps.resume();
      } catch (e) {
        deps.notify("error", "Nothing was sent to the Builder", "Its session couldn't be resumed. Nothing was merged.", reason(e));
        return "failed";
      }
    }
    deps.reveal();
    if (!(await deps.waitForSession())) {
      deps.notify(
        "warn",
        "The Builder session didn't open",
        "Nothing was merged or sent. Resume the session on the card, then ask again.",
      );
      return "failed";
    }
  } else {
    deps.reveal();
  }
  let sent: ShipConflictMessage;
  try {
    sent = await deps.start();
  } catch (e) {
    deps.notify("error", "The merge didn't start", reason(e));
    return "failed";
  }
  const files = sent.paths.length > 0 ? sent.paths.join("\n") : undefined;
  const written = deps.deliver(sanitizeForPaste(sent.message), () => {
    deps.queued();
    deps.notify("info", "Queued for the Builder", "The conflict goes in when the Builder is back at its prompt.", files);
  });
  if (written === null) {
    deps.notify(
      "warn",
      "The Builder session is not open",
      "The merge is started in the card's copy, but nothing was sent. Resume the session, then send the message again.",
    );
    return "failed";
  }
  try {
    await written;
  } catch (e) {
    deps.notify(
      "error",
      "The message didn't reach the Builder",
      "The merge is started in the card's copy. Send the message again from the card.",
      reason(e),
    );
    return "failed";
  }
  deps.notify(
    "info",
    "Sent to the Builder",
    `Plyloft started merging ${branchOf(sent.branch)}; the Builder resolves ${
      sent.paths.length > 0 ? filesWord(sent.paths.length) : "it"
    }. ${CONFLICT_SENT_HELPER}`,
    files,
  );
  return "sent";
}
