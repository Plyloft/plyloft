/**
 * N14 walk F14: an intake conversation that ended while its card still
 * reads as planning — Claude's folder-trust question answered "No, exit",
 * a crash, an `/exit`, or the idle sweeper closing it. The card stays
 * `intakeStatus: "active"` until the person cancels or plans again, so
 * without this the Board and the Now box kept "Planning with Claude —
 * Claude is asking what you want" and the Inbox said nothing; only the
 * card's page, if it was open when the PTY exited, said it stopped.
 *
 * One derivation for every surface, from real stops only (Challenger P2):
 * the backend's list of ended intakes and of live ones (`intake_ended_cards`,
 * from each PTY's exit, card open or not), the conversation's own
 * unexpected exit, and the idle sweeper's close — kept in
 * `useIntake.stoppedByCard`. A failed or slow Conclude is not a stop: the
 * conversation is still there. The words are the card page's stopped block
 * (`intakeStoppedError`). Pure — no React, no store.
 */
import type { KanbanCard } from "../ipc.ts";
import { EMPTY_CARD_STATE_CONTEXT, deriveCardState } from "./cardLifecycle.ts";

export type Planner = "claude" | "codex";

const NAME: Record<Planner, string> = { claude: "Claude", codex: "Codex" };

/** The reason recorded when the backend saw the exit and nothing else said
 *  why (the card's page was not open). */
export const INTAKE_ENDED_REASON = "The planning conversation ended.";

/** What the idle sweeper's close records (the card page's words for it). */
export function intakeSweptReason(idleMinutes: number): string {
  return `Intake auto-cancelled after ${idleMinutes} minutes of inactivity. Start a new intake when you're ready.`;
}

/** A stop, and where it came from: `exit` — the conversation's own exit or
 *  the sweeper (kept until the intake is cancelled, applied or started
 *  again); `ended` / `missing` — the backend's poll (recomputed each poll).
 *  `since` is when it was first seen (the Inbox row's time). */
export type IntakeStop = { reason: string; since: number; source: "exit" | "ended" | "missing" };

export type IntakeStops = Readonly<Record<string, IntakeStop | undefined>>;

/**
 * The card's stop, or null while it is not stopped: only a card that reads
 * as planning (`deriveCardState` → `intake-live`, Challenger P3-2 — the
 * Board's and the card page's state) with a stop recorded.
 */
export function intakeStop(card: KanbanCard, stops: IntakeStops): IntakeStop | null {
  const stop = stops[card.id];
  if (!stop || card.archived) return null;
  if (deriveCardState(card, EMPTY_CARD_STATE_CONTEXT) !== "intake-live") return null;
  return stop;
}

/** Why the card's intake stopped, or null (`intakeStop`). */
export function intakeStopReason(card: KanbanCard, stops: IntakeStops): string | null {
  return intakeStop(card, stops)?.reason ?? null;
}

/**
 * Challenger P3-4: fold one poll of the backend (`ended`: intakes whose PTY
 * exited; `live`: intakes still running) into the stops. A planning card
 * with neither entry has no conversation left (a webview reload, a close
 * the frontend missed) — counted once it is missing on two polls in a row,
 * so a start or a conclude in flight (the card plans a moment before its
 * entry exists, or after it goes) is not a stop. `exit` stops stay.
 */
export function foldIntakePoll(
  prev: { stops: Readonly<Record<string, IntakeStop>>; missingOnce: Readonly<Record<string, true>> },
  report: { ended: readonly string[]; live: readonly string[] },
  /** The cards that plan now (`intakeStatus: "active"`), but those
   *  concluding (their entry goes on apply). */
  planning: readonly string[],
  now: number,
): { stops: Record<string, IntakeStop>; missingOnce: Record<string, true> } {
  const ended = new Set(report.ended);
  const live = new Set(report.live);
  const stops: Record<string, IntakeStop> = {};
  for (const [id, stop] of Object.entries(prev.stops)) {
    if (stop.source === "exit") stops[id] = stop;
  }
  for (const id of ended) {
    stops[id] ??= { reason: INTAKE_ENDED_REASON, since: prev.stops[id]?.since ?? now, source: "ended" };
  }
  const missingOnce: Record<string, true> = {};
  for (const id of planning) {
    if (ended.has(id) || live.has(id)) continue;
    if (prev.missingOnce[id] || prev.stops[id]?.source === "missing") {
      stops[id] ??= { reason: INTAKE_ENDED_REASON, since: prev.stops[id]?.since ?? now, source: "missing" };
    } else {
      missingOnce[id] = true;
    }
  }
  return { stops, missingOnce };
}

/** The state's word: the Board, the List, the card's Now box. */
export function intakeStoppedLabel(planner: Planner): string {
  return `Planning with ${NAME[planner]} stopped`;
}

/** What happened, in one sentence: the Now box's helper and the block's. */
export function intakeStoppedHappened(reason: string, planner: Planner): string {
  const idle = /after (\d+) minutes/.exec(reason);
  return idle
    ? `The conversation was closed after ${idle[1]} minutes without an answer.`
    : `The conversation with ${NAME[planner]} ended, or couldn't go on.`;
}

/** The Now box's Plan again: ends the stopped conversation, starts anew. */
export const PLAN_AGAIN_LABEL = "Plan again";

export function planAgainTitle(planner: Planner): string {
  return `Ends this conversation and starts a new one with ${NAME[planner]}. It writes no code.`;
}

/** The Inbox row's words. */
export function intakeStoppedWords(
  planner: Planner,
  where: string,
  reason: string,
): { title: string; detail: string } {
  return {
    title: intakeStoppedLabel(planner),
    detail: `In “${where}” — ${lowerFirst(intakeStoppedHappened(reason, planner))} Plan again or cancel it on the card.`,
  };
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** A stopped intake, as the Inbox and the attention count take it. */
export type StoppedIntake = {
  workspaceId: string;
  cardId: string;
  vendor: Planner;
  reason: string;
  /** When the stop was first seen (Challenger P3-3). */
  since: number;
};

/** Every stopped intake across the loaded boards, by the same guard as the
 *  Board and the card's Now box (`intakeStop`). */
export function stoppedIntakes(
  boards: Readonly<Record<string, { cards: readonly KanbanCard[] } | undefined>>,
  stops: IntakeStops,
  plannerOf: (card: KanbanCard) => Planner = () => "claude",
): StoppedIntake[] {
  const out: StoppedIntake[] = [];
  for (const [workspaceId, board] of Object.entries(boards)) {
    for (const card of board?.cards ?? []) {
      const stop = intakeStop(card, stops);
      if (stop === null) continue;
      out.push({ workspaceId, cardId: card.id, vendor: plannerOf(card), reason: stop.reason, since: stop.since });
    }
  }
  return out;
}
