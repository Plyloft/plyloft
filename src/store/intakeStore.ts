import { create } from "zustand";
import {
  intakeStart,
  intakeConclude,
  intakeCancel,
  intakeReadDraft,
  intakeApply,
  type IntakeProposal,
} from "../ipc";
import {
  INTAKE_CONCLUDE_POLL_TIMEOUT_MS,
  intakeConcludeTimeoutMessage,
} from "../lib/intakeConclude";
import { foldIntakePoll, type IntakeStop } from "../lib/intakeStopped";

/**
 * v1.7.0: in-memory cache of `cardId → ptyId` for active intake sessions.
 * The backend (`IntakeRegistry`) is the source of truth; this store
 * survives selectedCardId changes within a session so the embedded xterm
 * can re-attach when the user toggles between cards. Cleared on
 * `cancel` / `apply`. NOT persisted — intake conversations don't survive
 * an app restart (kanban load force-resets `intake_status: active` to
 * `none`).
 */
interface IntakeStoreShape {
  /** Card-id → live PTY id. */
  ptyByCard: Record<string, string>;
  /**
   * Card-id → most recent error surfaced from the backend (intake start
   * failed, conclude timed out, draft malformed, etc). Cleared when the
   * user retries or cancels.
   */
  errorByCard: Record<string, string>;
  /**
   * Card-id → "concluding" while the FE is polling for the agent's draft
   * file. Drives the spinner / disable-input UI. Cleared on apply or
   * timeout-into-error.
   */
  concludingByCard: Record<string, true>;
  /**
   * N14 walk F14: cards whose intake conversation stopped while the card
   * still reads as planning — its exit or the sweeper's close (`markStopped`),
   * or the backend's poll (`applyPoll`: ended, or no conversation left), card
   * open or not. The Board, the Now box and the Inbox say it stopped
   * (`lib/intakeStopped.ts`). Cleared for a card on start, cancel, clear
   * and apply. Conclude errors are not stops (`errorByCard`).
   */
  stoppedByCard: Record<string, IntakeStop>;
  /** Challenger P3-4: planning cards the last poll found with no
   *  conversation at all (a stop once seen twice). */
  missingOnce: Record<string, true>;
  /** Challenger P3-1: bumped by start, cancel, clear and apply — a poll
   *  answered across one of them is dropped. */
  generation: number;

  start: (
    workspaceId: string,
    cardId: string,
    workspaceCwd: string,
  ) => Promise<string>;
  conclude: (
    workspaceId: string,
    cardId: string,
  ) => Promise<IntakeProposal>;
  /** `replanned` (N14 walk F20): Plan again ends this conversation to start
   *  a new one at once; its record says so. */
  cancel: (workspaceId: string, cardId: string, opts?: { replanned?: boolean }) => Promise<void>;
  setPtyId: (cardId: string, ptyId: string | null) => void;
  setError: (cardId: string, error: string | null) => void;
  clear: (cardId: string) => void;
  /** A real stop: the conversation exited, or the sweeper closed it. Only
   *  for the card's current conversation (`ptyId`). */
  markStopped: (cardId: string, ptyId: string, reason: string, now?: number) => void;
  /** One poll's answer, asked at `generation` (dropped when it moved). */
  applyPoll: (
    generation: number,
    report: { ended: readonly string[]; live: readonly string[] },
    planning: readonly string[],
    now: number,
  ) => void;
}

/** Without `cardId`'s entry. */
function without<T>(map: Record<string, T>, cardId: string): Record<string, T> {
  if (!(cardId in map)) return map;
  const next = { ...map };
  delete next[cardId];
  return next;
}

const POLL_INTERVAL_MS = 1000;
// v1.8.3: bumped from 30s to 5min. claude can legitimately take 1-2
// minutes composing a complex dispatchPrompt, especially when bash/write
// tool calls trigger permission prompts in the middle. 30s was too
// aggressive — the FE would surface "Conclude timed out" while the agent
// was still working, then a later poll would silently pick up the result
// (confusing UX). 5min is comfortable headroom; the user can always
// click Cancel if something is genuinely stuck.

export const useIntake = create<IntakeStoreShape>((set) => ({
  ptyByCard: {},
  errorByCard: {},
  concludingByCard: {},
  stoppedByCard: {},
  missingOnce: {},
  generation: 0,

  start: async (workspaceId, cardId, workspaceCwd) => {
    set((s) => {
      const errs = { ...s.errorByCard };
      delete errs[cardId];
      return { errorByCard: errs, ...forget(s, cardId) };
    });
    try {
      const ptyId = await intakeStart({ workspaceId, cardId, workspaceCwd });
      set((s) => ({ ptyByCard: { ...s.ptyByCard, [cardId]: ptyId }, ...forget(s, cardId) }));
      return ptyId;
    } catch (e) {
      const msg = String(e);
      set((s) => ({ errorByCard: { ...s.errorByCard, [cardId]: msg } }));
      throw e;
    }
  },

  conclude: async (workspaceId, cardId) => {
    set((s) => ({
      concludingByCard: { ...s.concludingByCard, [cardId]: true },
      errorByCard: (() => {
        const errs = { ...s.errorByCard };
        delete errs[cardId];
        return errs;
      })(),
    }));
    try {
      await intakeConclude(cardId);
    } catch (e) {
      const msg = `Finish planning failed: ${e}`;
      set((s) => {
        const c = { ...s.concludingByCard };
        delete c[cardId];
        return {
          concludingByCard: c,
          errorByCard: { ...s.errorByCard, [cardId]: msg },
        };
      });
      throw e;
    }

    // Poll for the draft file; a complex proposal may take minutes.
    const started = Date.now();
    while (Date.now() - started < INTAKE_CONCLUDE_POLL_TIMEOUT_MS) {
      try {
        const draft = await intakeReadDraft(workspaceId, cardId);
        if (draft) {
          // Apply (kills PTY + deletes draft + validates) and return the
          // validated proposal so the caller can update the kanban card.
          const proposal = await intakeApply(workspaceId, cardId);
          set((s) => {
            const ptys = { ...s.ptyByCard };
            delete ptys[cardId];
            const c = { ...s.concludingByCard };
            delete c[cardId];
            return { ptyByCard: ptys, concludingByCard: c, ...forget(s, cardId) };
          });
          return proposal;
        }
      } catch (e) {
        // Malformed JSON or unexpected path — surface and stop polling.
        const msg = `Couldn't parse agent output: ${e}`;
        set((s) => {
          const c = { ...s.concludingByCard };
          delete c[cardId];
          return {
            concludingByCard: c,
            errorByCard: { ...s.errorByCard, [cardId]: msg },
          };
        });
        throw new Error(msg);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    const timeoutMsg = intakeConcludeTimeoutMessage();
    set((s) => {
      const c = { ...s.concludingByCard };
      delete c[cardId];
      return {
        concludingByCard: c,
        errorByCard: { ...s.errorByCard, [cardId]: timeoutMsg },
      };
    });
    throw new Error(timeoutMsg);
  },

  cancel: async (workspaceId, cardId, opts) => {
    try {
      await intakeCancel(workspaceId, cardId, opts);
    } finally {
      set((s) => {
        const ptys = { ...s.ptyByCard };
        delete ptys[cardId];
        const errs = { ...s.errorByCard };
        delete errs[cardId];
        const c = { ...s.concludingByCard };
        delete c[cardId];
        return {
          ptyByCard: ptys,
          errorByCard: errs,
          concludingByCard: c,
          ...forget(s, cardId),
        };
      });
    }
  },

  setPtyId: (cardId, ptyId) =>
    set((s) => {
      const ptys = { ...s.ptyByCard };
      if (ptyId) ptys[cardId] = ptyId;
      else delete ptys[cardId];
      return { ptyByCard: ptys };
    }),

  setError: (cardId, error) =>
    set((s) => {
      const errs = { ...s.errorByCard };
      if (error) errs[cardId] = error;
      else delete errs[cardId];
      return { errorByCard: errs };
    }),

  clear: (cardId) =>
    set((s) => {
      const ptys = { ...s.ptyByCard };
      delete ptys[cardId];
      const errs = { ...s.errorByCard };
      delete errs[cardId];
      const c = { ...s.concludingByCard };
      delete c[cardId];
      return {
        ptyByCard: ptys,
        errorByCard: errs,
        concludingByCard: c,
        ...forget(s, cardId),
      };
    }),

  markStopped: (cardId, ptyId, reason, now = Date.now()) =>
    set((s) => {
      if (s.ptyByCard[cardId] !== ptyId) return s;
      const since = s.stoppedByCard[cardId]?.since ?? now;
      return { stoppedByCard: { ...s.stoppedByCard, [cardId]: { reason, since, source: "exit" } } };
    }),

  applyPoll: (generation, report, planning, now) =>
    set((s) => {
      if (generation !== s.generation) return s;
      const notConcluding = planning.filter((id) => !s.concludingByCard[id]);
      const next = foldIntakePoll(
        { stops: s.stoppedByCard, missingOnce: s.missingOnce },
        report,
        notConcluding,
        now,
      );
      return {
        stoppedByCard: sameStops(s.stoppedByCard, next.stops) ? s.stoppedByCard : next.stops,
        missingOnce: sameKeys(s.missingOnce, next.missingOnce) ? s.missingOnce : next.missingOnce,
      };
    }),
}));

/** A card's stop and missing mark go, and polls asked before are dropped. */
function forget(
  s: Pick<IntakeStoreShape, "stoppedByCard" | "missingOnce" | "generation">,
  cardId: string,
): Pick<IntakeStoreShape, "stoppedByCard" | "missingOnce" | "generation"> {
  return {
    stoppedByCard: without(s.stoppedByCard, cardId),
    missingOnce: without(s.missingOnce, cardId),
    generation: s.generation + 1,
  };
}

function sameKeys(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => k in b);
}

function sameStops(a: Record<string, IntakeStop>, b: Record<string, IntakeStop>): boolean {
  return (
    sameKeys(a, b) &&
    Object.keys(a).every(
      (k) => a[k].reason === b[k].reason && a[k].since === b[k].since && a[k].source === b[k].source,
    )
  );
}
