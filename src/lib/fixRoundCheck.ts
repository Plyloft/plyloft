/**
 * 1.175.0 F5 (UX-5; owner I6, I7): Finish and check by itself after a fix
 * round Plyloft sent the Builder. Pure: which rounds qualify, whether the
 * card checks by itself, what the driver does next for one round, and every
 * word it says. `src/store/fixRoundStore.ts` drives it; the card keeps its
 * switch and the count (`kanban.rs`: `fix_round_check`,
 * `fix_round_self_checks`; `fix_round.rs`).
 *
 * The rounds (mockup `rounds-and-ship.html` §1c, "Quali giri"): the
 * Reviewer's findings Plyloft sent, Fix with the Builder on this computer's
 * failed checks, Fix with the Builder on a pull request → by itself; the
 * person's own changes (Not right, Send to the Builder), the first build and
 * a card that reviews somebody else's pull request → never.
 *
 * Hard rules: a check starts only after a clean finish — the Builder back at
 * its prompt with its turn over, nothing asked, the last turn not cut off,
 * nothing typed or held in its prompt, something changed since the snapshot
 * the Reviewer read. Plyloft never answers the Builder and never types into
 * a prompt that holds text. Two checks by itself in a row at most; the third
 * round waits. Nothing is ever written to GitHub here: Send the fixes to
 * GitHub stays a press (the G7 loop, "Fix failing checks by itself", is its
 * own and is left to it).
 */
import type { KanbanCard } from "../ipc.ts";
import { LEAVE_LINE } from "./deliveryWords.ts";

/** Owner I6: checks Plyloft starts by itself in a row, at most. */
export const FIX_ROUND_CAP = 2;
/** The Builder's turn must end at least this long after the round went in
 *  (`prAutoFix.ts` TURN_SETTLE_MS). */
export const FIX_ROUND_SETTLE_MS = 1_000;
/** Walk 5.4: a copy read as unchanged is read once more after this long
 *  before the card says the Builder changed nothing (a turn can look over
 *  while its edit is still landing). */
export const FIX_ROUND_RECHECK_MS = 6_000;

/** Where a round came from — only these three are Plyloft's. */
export type FixRoundKind = "findings" | "checks" | "pr";

/** Why a round that would check by itself waits for the person instead. */
export type FixRoundHold =
  /** The Builder stops on a question: Plyloft never answers it; once it is
   *  answered and the turn ends, the check starts after all. */
  | "asks"
  /** The last turn on screen was cut off (Esc). */
  | "interrupted"
  /** Text the person typed (or a `!`/`/` draft, or a Plyloft message still
   *  held) is in the Builder's prompt. */
  | "draft"
  /** The Builder changed nothing since the snapshot the Reviewer read. */
  | "nothing"
  /** Two checks by itself in a row already (owner I6). */
  | "cap"
  /** Whether anything changed couldn't be told: the card waits, in
   *  today's words. */
  | "unknown";

/** A round as the driver keeps it, in memory (a relaunch forgets it: the
 *  card then waits for the press, as before 1.175). */
export type FixRound = {
  kind: FixRoundKind;
  /** The Builder session the round went into. */
  ptyId: string;
  /** When Plyloft's message went in. */
  sentAt: number;
  /** A turn was seen under way after it went in. */
  turnStarted?: boolean;
  /** The last read of whether the copy changed: when, at which end of
   *  turn (`turnIdleAt`), and whether it was the second read. */
  changedRead?: { at: number; idleAt: number | null; again?: boolean };
};

/** The Builder session, as the driver reads it from its terminal. */
export type FixRoundSession = {
  /** The card's session is attached to its terminal in this window. */
  attached: boolean;
  /** No turn running and no question in view (`BuilderRuntime.turnIdle`). */
  turnIdle: boolean;
  turnIdleAt: number | null;
  /** A question, a permission or trust prompt, a usage limit. */
  asking: boolean;
  /** The last turn on screen was cut off. */
  interrupted: boolean;
  /** Text in the prompt the person typed, a `!`/`/` draft, or Plyloft
   *  messages held for the prompt. */
  draft: boolean;
};

/** The card checks by itself after a Plyloft round: its own switch, else
 *  the setting. Never a card that reviews somebody else's pull request. */
export function fixRoundCheckOn(
  card: Pick<KanbanCard, "prReview" | "fixRoundCheck">,
  setting: boolean,
): boolean {
  if (card.prReview) return false;
  return card.fixRoundCheck ?? setting;
}

/** Whether a round of `kind` may check by itself on `card` (the person's
 *  own changes are never a `FixRoundKind`: they never get here). */
export function fixRoundQualifies(card: Pick<KanbanCard, "prReview" | "builder">, kind: FixRoundKind | null): boolean {
  if (kind == null || card.prReview || !card.builder) return false;
  // Walk 5.4: every settled verdict is delivered, an approval too; only a
  // request for changes is Plyloft's round. After an approval the Builder
  // does what the person asked (a change they queued).
  if (kind === "findings") {
    const review = card.builder.review;
    return review?.status === "done" && review.verdict === "changes_requested";
  }
  return true;
}

export type FixRoundAction =
  | { do: "wait" }
  /** A turn was seen under way after the round went in. */
  | { do: "note-turn" }
  /** Ask the backend whether the copy changed since the last snapshot;
   *  `again`: the second read of an unchanged copy. */
  | { do: "ask-changed"; again?: true }
  /** Count one, then Finish and check. */
  | { do: "start" }
  /** Wait for the person, with this reason. `asks` clears by itself. */
  | { do: "hold"; reason: FixRoundHold }
  /** The round is over without a check by itself (switched off, the
   *  session went, a check already running): forget it, say nothing. */
  | { do: "forget" };

export type FixRoundInput = {
  on: boolean;
  round: FixRound;
  /** The card's Builder session id now. */
  ptyId: string | null;
  session: FixRoundSession;
  /** Finish and check (its self-check or its save) already runs. */
  finishing: boolean;
  /** Checks started by itself in a row (`card.fixRoundSelfChecks`). */
  selfChecks: number;
  /** The backend's answer: undefined not asked yet, null unknown. */
  changed: boolean | null | undefined;
  now: number;
};

/** What the driver does next for one round. */
export function fixRoundNext(input: FixRoundInput): FixRoundAction {
  const { round, session } = input;
  if (!input.on) return { do: "forget" };
  if (!session.attached || input.ptyId !== round.ptyId) return { do: "forget" };
  // Someone pressed Finish and check meanwhile: the round is theirs.
  if (input.finishing) return { do: "forget" };
  // A question waits for the person while it is on screen; never answered.
  if (round.turnStarted && session.asking) return { do: "hold", reason: "asks" };
  const endedSince = session.turnIdleAt != null && session.turnIdleAt >= round.sentAt + FIX_ROUND_SETTLE_MS;
  if (!round.turnStarted) {
    // Seen running, or already over after the message: the turn started.
    if (!session.turnIdle || endedSince) return { do: "note-turn" };
    return { do: "wait" };
  }
  if (!session.turnIdle || !endedSince) return { do: "wait" };
  if (session.interrupted) return { do: "hold", reason: "interrupted" };
  if (session.draft) return { do: "hold", reason: "draft" };
  if (input.selfChecks >= FIX_ROUND_CAP) return { do: "hold", reason: "cap" };
  if (input.changed === undefined) return { do: "ask-changed" };
  const read = round.changedRead;
  // The turn went on and ended again since the read: read again.
  if (read && session.turnIdleAt !== read.idleAt) return { do: "ask-changed" };
  if (input.changed === null) return { do: "hold", reason: "unknown" };
  if (!input.changed) {
    // Walk 5.4: read once more, a moment later, before saying so.
    if (read && !read.again) {
      return input.now - read.at >= FIX_ROUND_RECHECK_MS ? { do: "ask-changed", again: true } : { do: "wait" };
    }
    return { do: "hold", reason: "nothing" };
  }
  return { do: "start" };
}

/** The count after a review settled: an approval, or a review of work the
 *  person sent in themselves (their own Finish and check), starts it over. */
export function fixRoundCountAfterReview(
  count: number,
  review: { verdict?: string | null; status?: string | null } | null | undefined,
  startedByItself: boolean,
): number {
  if (!review || review.status !== "done") return count;
  if (review.verdict === "approve") return 0;
  return startedByItself ? count : 0;
}

// ── Words (`STRINGS-immediacy.md` F5; mockup §1) ───────────────────────

/** What the card page needs of the driver for one card (`CardLive.fixRound`). */
export type FixRoundFacts = {
  /** A Plyloft round is live and the card checks by itself after it. */
  byItself: boolean;
  /** It waits for the person, and why. */
  held: FixRoundHold | null;
  /** The check Plyloft started by itself, since when (until it saved). */
  checking: { since: number } | null;
  /** The person pressed Stop on that check. */
  stopped: boolean;
};

/** What the driver keeps, as the card page reads it. */
export type FixRoundDriverState = {
  rounds: Record<string, { held?: FixRoundHold } | undefined>;
  checking: Record<string, { since: number } | undefined>;
  stopped: Record<string, true | undefined>;
};

/** The card page's facts from the driver's state (null: nothing to say). */
export function fixRoundFactsFrom(
  state: FixRoundDriverState | null | undefined,
  card: Pick<KanbanCard, "id" | "prReview" | "fixRoundCheck">,
  setting: boolean,
): FixRoundFacts | null {
  if (!state || card.prReview) return null;
  const round = state.rounds[card.id];
  const checking = state.checking[card.id] ?? null;
  const stopped = state.stopped[card.id] === true;
  if (!round && !checking && !stopped) return null;
  return {
    byItself: Boolean(round) && fixRoundCheckOn(card, setting) && (round?.held == null || round.held === "asks"),
    held: round?.held ?? null,
    checking: checking ? { since: checking.since } : null,
    stopped,
  };
}

export const DONT_CHECK_LABEL = "Don't check by itself";
export const DONT_CHECK_TITLE = "When the Builder is done with this round, the card waits for you to press Finish and check, as before.";
export const CHECKING_BY_ITSELF_LABEL = "Checking the fixes by itself";
export const STOP_CHECK_LABEL = "Stop";
export const STOP_CHECK_TITLE = "Stops this check before anything is saved. Finish and check again starts it over.";
export const STOPPED_CHECK_LABEL = "You stopped the check";
export const STOPPED_CHECK_SENTENCE = "Nothing was saved or checked yet. Finish and check again starts it over.";

/** Now's sentence while the Builder fixes, when the check follows by itself. */
export function fixingByItselfSentence(ai: string, reviewer: string): string {
  return `${ai} is working on them in its session. When it's done, Plyloft checks the fixes by itself: your checks run and ${reviewer} reviews them.`;
}

/** Under "Checking the fixes by itself". */
export function checkingByItselfSentence(ai: string, reviewer: string): string {
  return `${ai} finished, so Plyloft started Finish and check: ${ai} re-reads its work, your checks run, then ${reviewer} reviews the fixes. ${LEAVE_LINE}`;
}

/** The headline and sentence of a round that waits for the person. */
export function fixRoundHeldWords(reason: FixRoundHold, ai: string, reviewer: string): { label: string; helper: string } | null {
  switch (reason) {
    case "interrupted":
      return {
        label: `${ai} stopped before it finished`,
        helper: `${ai} was interrupted, so Plyloft didn't check the fixes by itself. Tell it to carry on, or Finish and check what's there.`,
      };
    case "draft":
      return {
        label: `${ai} finished the fixes`,
        helper: "Plyloft didn't check by itself: there is text in the Builder's prompt. Send or clear what you typed, then press Finish and check again.",
      };
    case "nothing":
      return {
        label: `${ai} changed nothing`,
        helper: `${ai} finished without changing a file, so there is nothing new to check. If it disagrees with the findings and you side with it, press Agree with ${ai}, keep it as it is.`,
      };
    case "asks":
      return {
        label: `${ai} asks you something`,
        helper: `Answer in its session. Plyloft checks the fixes by itself once ${ai} is done; it never answers for you.`,
      };
    case "cap":
      return {
        label: `${reviewer} asked for changes three times`,
        helper: `Plyloft checked the fixes by itself twice and ${reviewer} still asks for changes, so this round waits for you. Read the review before going on.`,
      };
    case "unknown":
      return null;
  }
}

/** Change… (on the card) and Settings › Cards › AI and models (owner I7). */
export const AFTER_FIX_ROUND_LABEL = "After a fix round";
export const AFTER_FIX_ROUND_BY_ITSELF = "Checks by itself";
export const AFTER_FIX_ROUND_WAITS = "Waits for me";
export const AFTER_FIX_ROUND_HINT =
  "When the Builder finishes fixes Plyloft sent it, Plyloft runs Finish and check. The first build and your own changes always wait for you.";
export const AFTER_FIX_ROUND_SETTING_LABEL = "After a fix round, check by itself";
export const AFTER_FIX_ROUND_SETTING_HINT =
  "When the Builder finishes fixes Plyloft sent it, Plyloft runs Finish and check without waiting for you. Each card can change it. It never ships and never answers the Builder's questions.";

/** The reviewer's name for a card: the last review's, else the other AI. */
export function fixRoundReviewer(builderVendor: string | null | undefined, lastReviewer: string | null | undefined): string {
  const v = lastReviewer ?? (builderVendor === "codex" ? "claude" : "codex");
  return v === "codex" ? "Codex" : "Claude";
}
