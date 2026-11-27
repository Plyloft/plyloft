/**
 * N14 walk F14: which intake conversations ended while their card still
 * plans — read from the backend (`intake_ended_cards`, from each intake
 * PTY's exit), card page open or not, and the idle sweeper's closes. The
 * Board, the card's Now box and the Inbox read them through
 * `lib/intakeStopped.ts`.
 */
import { useMemo } from "react";
import { intakeEndedCards, onIntakeSwept, type KanbanCard } from "../ipc";
import {
  intakeStop,
  intakeSweptReason,
  stoppedIntakes,
  type Planner,
  type StoppedIntake,
} from "../lib/intakeStopped";
import { useIntake } from "./intakeStore";
import { useKanban } from "./kanbanStore";

/** Ask the backend which intakes ended and which are live — only while some
 *  card plans. A failed read keeps what was known; an answer that crossed a
 *  start, cancel or apply is dropped (Challenger P3-1). */
let endedPollAt = 0;
export async function pollEndedIntakes(now: number, everyMs = 2_000): Promise<void> {
  if (now - endedPollAt < everyMs) return;
  endedPollAt = now;
  const planning = () =>
    Object.values(useKanban.getState().byWorkspace)
      .flatMap((b) => b?.cards ?? [])
      .filter((c) => c.intakeStatus === "active" && !c.archived)
      .map((c) => c.id);
  const generation = useIntake.getState().generation;
  if (planning().length === 0) {
    useIntake.getState().applyPoll(generation, { ended: [], live: [] }, [], now);
    return;
  }
  try {
    const report = await intakeEndedCards();
    // The cards that plan when the answer lands.
    useIntake.getState().applyPoll(generation, report, planning(), now);
  } catch {
    // The next tick asks again.
  }
}

/** The idle sweeper closed an intake: a stop, card page open or not (its
 *  registry entry is gone, so the ended list does not keep it). */
export function listenForSweptIntakes(): Promise<() => void> {
  return onIntakeSwept((e) =>
    useIntake.getState().markStopped(e.cardId, e.ptyId, intakeSweptReason(e.idleMinutes)),
  );
}

/** Every stopped intake, from the stores as they are now. */
export function stoppedIntakesNow(plannerOf?: (card: KanbanCard) => Planner): StoppedIntake[] {
  return stoppedIntakes(useKanban.getState().byWorkspace, useIntake.getState().stoppedByCard, plannerOf);
}

/** Why the card's intake stopped, or null (`intakeStop`). */
export function useIntakeStopReason(card: KanbanCard): string | null {
  const stop = useIntake((s) => s.stoppedByCard[card.id]);
  return stop ? (intakeStop(card, { [card.id]: stop })?.reason ?? null) : null;
}

/** The same for many cards at once (the Board, the List). */
export function useIntakeStoppedOf(): (card: KanbanCard) => boolean {
  const stops = useIntake((s) => s.stoppedByCard);
  return useMemo(() => (card: KanbanCard) => intakeStop(card, stops) !== null, [stops]);
}
