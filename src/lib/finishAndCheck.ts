/**
 * UX P1 point 3 (P-B): Finish and check pressed early. The sheet asks a
 * plain question in two cases — the Builder is still working, or it asked a
 * question and waits — and says nothing when its turn is over. Pure: the
 * press itself is `store/finishAndCheck.ts`.
 */
import { deriveTileAttention } from "./attention.ts";
import { NO_CHECKS_TO_RUN } from "./buildBoth.ts";

export type EarlyFinishSheet = {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  /** (Challenger) Always true: the safe answer is the default — Keep
   *  working / Answer first takes focus, so Enter or Space does not save a
   *  half-done turn; Esc keeps working too. */
  cautious: true;
};

/** What the attached xterm knows of the session (`BuilderRuntime`). */
export type FinishSession = {
  vendor: "claude" | "codex";
  startedAt: number;
  lastOutputAt?: number;
  promptBoxIdle?: boolean;
  turnIdle?: boolean;
  questionInView?: boolean;
};

/** The sheet to show before Finish and check, or null to go straight on. */
export function earlyFinishSheet(
  rt: FinishSession | null | undefined,
  now: number,
  /** 1.174.3: resumed and nothing has gone in (`resumedWithoutTurn`): Now says
   *  nothing has started, so "still working" would contradict it. */
  resumedIdle = false,
): EarlyFinishSheet | null {
  if (!rt) return null;
  const who = rt.vendor === "codex" ? "Codex" : "Claude";
  const attention = deriveTileAttention(
    {
      kind: rt.vendor,
      status: "running",
      startedAt: rt.startedAt,
      lastOutputAt: rt.lastOutputAt,
      promptBoxIdle: rt.promptBoxIdle,
      questionInView: rt.questionInView,
    },
    now,
  );
  if (attention === "asking-you" && rt.turnIdle !== true && (rt.questionInView === true || rt.promptBoxIdle !== true)) {
    return {
      title: `${who} asked you something. Finish anyway?`,
      body: "Its question stays unanswered. Plyloft saves the work as it is now and tests it.",
      confirmLabel: "Finish anyway",
      cancelLabel: "Answer first",
      cautious: true,
    };
  }
  if (rt.promptBoxIdle !== true && !resumedIdle) {
    // (Challenger) Silent for a while with no prompt in view, the card says
    // "Maybe waiting for you": "is still working" would contradict it.
    const quiet = attention === "wants-you";
    return {
      title: quiet ? `${who} may still be working. Finish now?` : `${who} is still working. Finish now?`,
      body: `Plyloft saves the work as it is now, tests it and has it reviewed. Anything ${who} does after this waits for the next Finish and check.`,
      confirmLabel: "Finish now",
      cancelLabel: "Keep working",
      cautious: true,
    };
  }
  return null;
}

/** The toast after Finish and check saved the work. 1.168.1 B3: on a
 *  project with no checks set up it never says checks are running. */
export function workSavedToastWords(
  /** The Challenger is still reviewing an earlier round (GH #124). */
  reviewWaiting: boolean,
  noChecks: boolean,
): { title: string; body: string } {
  const waiting = "The Reviewer reviews this round when its running review ends.";
  if (noChecks) {
    return {
      title: "Work saved",
      body: reviewWaiting ? `${NO_CHECKS_TO_RUN} ${waiting} Its review goes back to the Builder.` : NO_CHECKS_TO_RUN,
    };
  }
  return {
    title: "Work saved",
    body: reviewWaiting
      ? `Your checks are running. ${waiting} The results go back to the Builder.`
      : "Your checks are running. The result goes back to the Builder.",
  };
}
