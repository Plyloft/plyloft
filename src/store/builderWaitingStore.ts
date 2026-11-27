import { create } from "zustand";
import type { WaitingSession } from "../lib/needsYou";
import { useBuilder } from "./builderStore";
import {
  holdBuilderWaiting,
  waitingBuildersByCard,
  type BuilderWaitingByCard,
} from "../lib/builderWaiting";

/**
 * UX P1 point 4 (P-B): which cards' Builders wait on the person, with the
 * 3-second hold (`lib/builderWaiting.ts`). Written on the app's attention
 * tick from the same `waitingSessions` the Inbox counts; read by every card
 * surface through `useCardLive`. In memory, never persisted. The object only
 * changes when a card starts or stops waiting, so the Board does not redraw
 * on every second or every byte of a session.
 */
type BuilderWaitingStore = {
  byCard: BuilderWaitingByCard;
  /** The tick: this second's waiting sessions. */
  update: (waiting: readonly WaitingSession[], now: number) => void;
};

/** (Challenger, P-B) Finish and check is under way for a session key —
 *  its self-check (ADR 0006) or the press itself. `waitingSessions` then
 *  counts only a question in view, and so does this store. */
export function finishingNow(sessionKey: string): boolean {
  const { selfCheck, doneBusy } = useBuilder.getState();
  return Boolean(selfCheck[sessionKey]) || Boolean(doneBusy[sessionKey]);
}

export const useBuilderWaiting = create<BuilderWaitingStore>((set, get) => ({
  byCard: {},
  update: (waiting, now) => {
    const prev = get().byCard;
    // ADR 0006: during the self-check (and Finish and check's own work) the
    // button is off and the card says the self-check's words; the Builder
    // at its prompt then is not "stopped" for the person (`waitingSessions`
    // leaves it out already). A question in view still waits (CL-11).
    // No hold then: the press ended the wait.
    const finishing = (key: string) => finishingNow(key.slice(key.indexOf("::") + 2));
    const waitingNow = waitingBuildersByCard(waiting);
    for (const [key, e] of [...waitingNow]) if (e.state !== "question" && finishing(key)) waitingNow.delete(key);
    let next = holdBuilderWaiting(prev, waitingNow, now);
    const dropped = Object.entries(next)
      .filter(([key, e]) => (e.state !== "question" || e.releaseAt != null) && finishing(key))
      .map(([key]) => key);
    if (dropped.length > 0) {
      next = { ...next };
      for (const key of dropped) delete (next as Record<string, unknown>)[key];
    }
    if (next !== prev) set({ byCard: next });
  },
}));
