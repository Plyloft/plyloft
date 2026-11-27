/**
 * Plan with two AIs (`docs/plans/PLAN_WITH_TWO_AIS.md`): the words and rules
 * of the Chat tab's Plan mode, apart from React. Pure — no store, no IPC.
 *
 * One vendor may take both roles (owner, 2026-10-16, Q5): every label tells
 * the two sessions apart by role, never by vendor alone.
 */
import { showBackendText } from "./backendMarks.ts";
import type {
  CardPresentationState,
  ChatMessage,
  ChatTokenUsage,
  ChatVendor,
  IntakeRecord,
  PlanExchange,
  PlanLaneState,
  PlanOpenCard,
  PlanPauseKind,
  PlanRole,
  PlanTurn,
} from "../ipc.ts";
import { chatTokenLine, chatVendorName } from "./chatView.ts";
import { USAGE_LIMIT_HEADLINE } from "./sessionBlock.ts";
import type { VendorReadiness } from "./vendorReadiness.ts";
import { twoAisLineup } from "./vendorReadiness.ts";

export const PLAN_TWO_AIS_LABEL = "Plan with two AIs";
export const CREATE_AND_PLAN_LABEL = "Create and plan with two AIs";

/** Offered on an unbuilt card only: a draft or a ready plan — not while an
 *  intake runs (another planner on the card), never once it builds. */
export function planTwoAisOffered(state: CardPresentationState): boolean {
  return state === "draft" || state === "ready";
}

/** Q2: "Challenge the plan" is no longer offered on an unbuilt card; Plan
 *  with two AIs takes its place there. A card that has a discussion still
 *  shows it (the panel draws it whatever `offer` says). */
export function planChallengeOfferedOn(state: CardPresentationState): boolean {
  void state;
  return false;
}

/** The form's line: who proposes, who critiques, the rounds — and, with one
 *  vendor, that they are two separate sessions and why the other is out. */
export function lineupLine(preferred: ChatVendor, readiness: VendorReadiness, rounds = 2): string | null {
  const lineup = twoAisLineup(preferred, readiness);
  if (!lineup) return null;
  const p = chatVendorName(lineup.proposer);
  const c = chatVendorName(lineup.critic);
  const roundWords = `${rounds} rounds.`;
  if (lineup.proposer === lineup.critic) {
    const other: ChatVendor = lineup.proposer === "claude" ? "codex" : "claude";
    const why = readiness[other].reason;
    return `${p} proposes, ${c} critiques: two separate ${p} sessions. ${roundWords}${why ? ` ${why}.` : ""}`;
  }
  const builder = lineup.proposer === preferred ? " (this card's Builder)" : "";
  return `${p} proposes${builder}, ${c} critiques. ${roundWords}`;
}

const VERB: Record<string, string> = { propose: "proposes", critique: "critiques", revise: "revises" };

/** "Claude proposes", "Codex critiques", "Claude revises". */
export function turnLabel(turn: Pick<PlanTurn, "role" | "vendor">): string {
  return `${chatVendorName(turn.vendor)} ${VERB[turn.role] ?? "answers"}`;
}

/** ", round 1 of 2": the proposal opens round 1 (its turn is stored as
 *  round 0), as the critique that answers it is round 1. */
function roundOf(turn: PlanTurn, exchange: PlanExchange): string {
  return `, round ${Math.max(1, turn.round)} of ${exchange.roundsTarget}`;
}

/** The state line under the switch. */
export function planStateLine(exchange: PlanExchange, waitingForPrompt: boolean): string {
  const turn = exchange.turns[exchange.turns.length - 1];
  switch (exchange.status) {
    case "running": {
      if (!turn || turn.outcome) return "The two AIs are starting the next turn…";
      const name = chatVendorName(turn.vendor);
      if (waitingForPrompt) return `Waiting for ${name}'s prompt…`;
      const doing = turn.role === "propose" ? "writing the plan" : turn.role === "critique" ? "critiquing" : "revising the plan";
      return `${name} is ${doing}${roundOf(turn, exchange)}.`;
    }
    case "awaitingMember":
      return `The plan is ready for you (${exchange.roundsDone === 1 ? "1 round" : `${exchange.roundsDone} rounds`}).`;
    case "paused":
      return "The plan is paused.";
    case "accepted":
      return "You accepted this plan.";
    case "discarded":
      return "You discarded this plan.";
    default:
      return "This plan was saved by a newer Plyloft.";
  }
}

/** A pause's title, by its kind. */
export function pauseTitle(kind: PlanPauseKind): string {
  switch (kind) {
    case "stopped":
      return "You stopped the plan";
    case "signIn":
      return "Sign in, then retry";
    case "usageLimit":
      // 1.171.0 C2: the session word Paused, as a card's Builder says it.
      return USAGE_LIMIT_HEADLINE;
    case "trust":
      return "Claude asks to trust its folder";
    case "screen":
      return "An AI was waiting on its own screen";
    case "quit":
      return "Plyloft quit during this plan";
    case "sessionEnded":
      return "A session ended";
    case "archived":
      return "This card was archived";
    case "timeout":
      return "A turn took too long";
    default:
      return "The plan stopped";
  }
}

/** What a paused exchange offers. Retry is off while the card is archived;
 *  Use the latest plan only when a finished plan exists. */
export function pauseActions(exchange: PlanExchange, archived: boolean): { retry: boolean; useLatest: boolean } {
  return {
    retry: exchange.status === "paused" && !archived,
    useLatest: exchange.status === "paused" && latestPlan(exchange) != null && !archived,
  };
}

/** The proposer's latest finished plan. */
export function latestPlan(exchange: PlanExchange): string | null {
  for (let i = exchange.turns.length - 1; i >= 0; i--) {
    const t = exchange.turns[i];
    if ((t.role === "propose" || t.role === "revise") && t.outcome === "answered" && t.answer) return t.answer;
  }
  return null;
}

/** The critic's last verdict, in words. */
export function verdictWords(exchange: PlanExchange): string | null {
  const critique = [...exchange.turns].reverse().find((t) => t.role === "critique" && t.outcome === "answered");
  if (!critique) return null;
  const who = exchange.proposer === exchange.critic ? `The second ${chatVendorName(exchange.critic)} session` : chatVendorName(exchange.critic);
  switch (critique.verdict) {
    case "ready":
      return `${who}: ready.`;
    case "changesNeeded":
      return `${who}: changes needed.`;
    default:
      return `${who} gave no verdict.`;
  }
}

/** The decision bar's heading: "The plan (Claude, after 2 rounds). Codex: ready." */
export function decisionHeading(exchange: PlanExchange): string {
  const rounds = exchange.roundsDone === 1 ? "1 round" : `${exchange.roundsDone} rounds`;
  const verdict = verdictWords(exchange);
  return `The plan (${chatVendorName(exchange.proposer)}, after ${rounds}).${verdict ? ` ${verdict}` : ""}`;
}

/** Another round: offered under three rounds, while no other exchange runs. */
export function anotherRound(
  exchange: PlanExchange,
  runningElsewhere: string | null,
): { offered: boolean; reason: string | null } {
  if (exchange.status !== "awaitingMember") return { offered: false, reason: null };
  if (exchange.roundsDone >= exchange.roundsMax) return { offered: false, reason: "Three rounds is the most." };
  if (runningElsewhere) return { offered: false, reason: `Two AIs are planning "${runningElsewhere}" now.` };
  return { offered: true, reason: null };
}

/** Use this plan asks first when the card's plan is one the member edited
 *  by hand. */
export function replaceConfirmNeeded(dispatchPromptEditedAt: number | null | undefined): boolean {
  return dispatchPromptEditedAt != null;
}

export type ThreadItem =
  | { kind: "turn"; key: string; turn: PlanTurn; label: string; round: string }
  | { kind: "message"; key: string; role: PlanRole; vendor: ChatVendor; message: ChatMessage };

function conversationOf(exchange: PlanExchange, role: PlanRole) {
  return role === "proposer" ? exchange.proposerConversation : exchange.criticConversation;
}

/** The exchange as one labelled thread: each turn's heading ("Codex
 *  critiques, round 1 of 2"), then what its side wrote for it — answers,
 *  tool lines, notices. The messages Plyloft sent (the ask, the relays, a
 *  retry) are hidden: each side's answer is already in the thread. */
export function planThread(exchange: PlanExchange): ThreadItem[] {
  const items: ThreadItem[] = [];
  for (const turn of exchange.turns) {
    const role: PlanRole = turn.role === "critique" ? "critic" : "proposer";
    items.push({
      kind: "turn",
      key: `turn-${turn.n}`,
      turn,
      label: turnLabel(turn),
      round: turn.role === "propose" ? "" : `round ${turn.round} of ${exchange.roundsTarget}`,
    });
    const messages = conversationOf(exchange, role)?.messages ?? [];
    // This turn's messages: after its sent message (a retry's included),
    // up to the next turn's.
    const mine = messages.filter((m) => m.role === "user" && m.turn === turn.n).map((m) => m.id);
    const start = mine.length ? messages.findIndex((m) => m.id === mine[0]) : -1;
    if (start < 0) continue;
    for (let i = start + 1; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === "user" && m.turn != null && m.turn !== turn.n) break;
      if (m.role === "user") continue;
      items.push({ kind: "message", key: `${role}-${m.id}`, role, vendor: turn.vendor, message: m });
    }
  }
  return items;
}

/** A side's token line: "Claude (proposer): Tokens …". */
export function laneTokenLine(lane: Pick<PlanLaneState, "role" | "vendor">, usage: ChatTokenUsage | null | undefined): string {
  // E10 kept the chat's zero line out; a plan side still says it (unchanged).
  return `${chatVendorName(lane.vendor)} (${lane.role}): ${chatTokenLine(usage) ?? "No tokens used yet."}`;
}

/** The Activity line of an accepted exchange (`cardPage` timeline). */
export function twoAisActivityWords(record: Pick<IntakeRecord, "vendor" | "twoAis">): string | null {
  if (!record.twoAis) return null;
  const proposer: ChatVendor = record.vendor === "codex" ? "codex" : "claude";
  const critic: ChatVendor = record.twoAis.critic === "codex" ? "codex" : "claude";
  const rounds = record.twoAis.rounds === 1 ? "1 round" : `${record.twoAis.rounds} rounds`;
  if (proposer === critic) return `Planned with two ${chatVendorName(proposer)} sessions (${rounds})`;
  return `Planned with ${chatVendorName(proposer)} and ${chatVendorName(critic)} (${rounds})`;
}

/** The exchange holds the card's build and its Chat (running or waiting
 *  for the member; P1). */
export function exchangeOpen(exchange: PlanExchange | null | undefined): boolean {
  return exchange?.status === "running" || exchange?.status === "awaitingMember";
}

/** P1's words, mirrored from the backend. */
export const BUILD_WAITS = "Two AIs are still planning this card. Use their plan or discard it first.";

export const PLAN_VIEW_ONLY =
  "This terminal is view-only: it shows the plan's own Claude session. Plyloft answers nothing here; if Claude waits on a screen, answer it in a terminal of your own, then Retry.";

/** The view-only line, naming the session shown: "Claude's session (the
 *  critic)" — with Claude in both roles the role tells them apart. */
export function planViewOnly(role: PlanRole): string {
  return `This terminal is view-only: it shows Claude's own session for this plan (the ${role}). Plyloft answers nothing here; if Claude waits on a screen, answer it in a terminal of your own, then Retry.`;
}

/** Show terminal on Codex's turn: Codex runs without a terminal. */
export const CODEX_NO_TERMINAL = "Codex works without a terminal: its answer shows in the thread as it writes.";

/** The side whose turn it is (the last turn's), or null before the first. */
export function activeRole(exchange: Pick<PlanExchange, "turns">): PlanRole | null {
  const last = exchange.turns[exchange.turns.length - 1];
  if (!last) return null;
  return last.role === "critique" ? "critic" : "proposer";
}

/**
 * Show terminal's session: the live Claude session of the side whose turn
 * it is — the order `plan_exchange_screen` reads them in. While a Codex
 * side's turn runs there is no terminal to show (Codex has none): null,
 * never the other side's idle Claude. Otherwise (waiting for the member,
 * paused) the last turn's side, else any live Claude session.
 */
export function showTerminalLane(
  exchange: Pick<PlanExchange, "turns" | "status" | "proposer" | "critic">,
  lanes: readonly PlanLaneState[],
): PlanLaneState | undefined {
  const active = activeRole(exchange) ?? "proposer";
  const live = lanes.filter((l) => l.vendor === "claude" && l.ptyId);
  const mine = live.find((l) => l.role === active);
  if (exchange.status === "running") {
    return (active === "critic" ? exchange.critic : exchange.proposer) === "claude" ? mine : undefined;
  }
  return mine ?? live[0];
}

/** Codex's turn runs now: Show terminal has nothing to show. */
export function codexTurnRunning(exchange: Pick<PlanExchange, "turns" | "status" | "proposer" | "critic">): boolean {
  if (exchange.status !== "running") return false;
  const active = activeRole(exchange) ?? "proposer";
  return (active === "critic" ? exchange.critic : exchange.proposer) === "codex";
}

// ── Outside the Chat: the card's Now, the Board, the Inbox ─────────────

function pairName(open: Pick<PlanOpenCard, "proposer" | "critic">): string {
  return open.proposer === open.critic
    ? `Two ${chatVendorName(open.proposer)} sessions`
    : `${chatVendorName(open.proposer)} and ${chatVendorName(open.critic)}`;
}

function roundsWord(n: number): string {
  return n === 1 ? "1 round" : `${n} rounds`;
}

/** The card's state while its exchange runs, waits or is paused: the Now
 *  box (label, helper, primary), the Board's and the List's word. */
export type PlanCardWords = {
  label: string;
  helper: string;
  tone: "accent" | "quiet";
  actionLabel: string;
  actionTitle: string;
};

export const PLAN_RUNNING_LABEL = "Two AIs are planning";
export const PLAN_READY_LABEL = "Plan ready to review";
export const PLAN_PAUSED_LABEL = "Plan paused";

export function planCardWords(open: Pick<PlanOpenCard, "status" | "proposer" | "critic" | "roundsDone" | "pause">): PlanCardWords | null {
  const who = pairName(open);
  switch (open.status) {
    case "running":
      return {
        label: PLAN_RUNNING_LABEL,
        helper: `${who} are writing and critiquing this card's plan; the build waits for it.`,
        tone: "quiet",
        actionLabel: "Open the plan",
        actionTitle: "Shows the two AIs' plan on this card, with Stop.",
      };
    case "awaitingMember":
      return {
        label: PLAN_READY_LABEL,
        helper: `${who} finished this card's plan after ${roundsWord(Math.max(1, open.roundsDone))}; the build waits for your decision.`,
        tone: "accent",
        actionLabel: "Review the plan",
        actionTitle: "Opens the plan with Use this plan, Another round, Edit and Discard.",
      };
    case "paused":
      return {
        label: PLAN_PAUSED_LABEL,
        helper: showBackendText(open.pause?.reason)?.trim() || "The two AIs' plan for this card is paused.",
        tone: "accent",
        actionLabel: "Open the plan",
        actionTitle: "Opens the paused plan with Retry this turn and Discard.",
      };
    default:
      return null;
  }
}

/** The Inbox row of a plan that needs the member (waits, or is paused). */
export function planInboxWords(
  open: Pick<PlanOpenCard, "status" | "proposer" | "critic" | "roundsDone" | "pause">,
  where: string,
): { title: string; detail: string } | null {
  const words = planCardWords(open);
  if (!words || open.status === "running") return null;
  return {
    title: words.label,
    detail:
      open.status === "awaitingMember"
        ? `In “${where}” — ${pairName(open)} finished the plan after ${roundsWord(Math.max(1, open.roundsDone))}. Use it, change it or discard it on the card.`
        : `In “${where}” — ${words.helper} Retry or discard it on the card.`,
  };
}

/** P1 in a refusal's toast: the words themselves, not "try again". */
export function isBuildWaitsRefusal(e: unknown): boolean {
  return String((e as Error | null)?.message ?? e).includes(BUILD_WAITS);
}
