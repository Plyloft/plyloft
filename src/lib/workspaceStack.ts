/**
 * The sidebar's stack of other workspaces (Notion's teamspaces): below the
 * current workspace's section, every OTHER workspace with something going on —
 * something that needs the person, something failed, or something working —
 * so a person running several workspaces sees who finished without opening
 * the switcher. Below those, in the slots left under the one cap, the other
 * workspaces used recently — active earlier this session, idle now (files
 * open, a terminal at its prompt, Claude done and waiting for the next
 * message) — so a workspace in use does not drop out of the sidebar each time
 * it goes quiet (`recentWorkspaces`, `stackSlots`).
 *
 * Nothing here decides a state of its own. It regroups what is already
 * derived elsewhere, per workspace:
 *
 * - **needs you** — the units of the one count (`lib/needsYou.ts`): a live
 *   session waiting for its answer (`waitingSessions`, itself
 *   `deriveTileAttention`) and a Needs you row of the Inbox feed;
 * - **failed** — a Needs you row that says something failed
 *   (`inboxView.ts::isFailureRow`; 1.173.0 F1 folded Failed into Needs you);
 * - **working** — a live tile the header calls working (`sessionRows`, the
 *   header's `tileStatusLine`), a card's Builder session that is not waiting,
 *   and the feed's running cards and agent runs (cold workspaces included).
 *
 * A card is listed once: a Builder waiting for its answer and the feed's
 * Needs you row for the same card are one item (the session, which is what
 * opens it). So the row's numbers are the items listed beneath it, and can be
 * one lower than the switcher's count, which counts both.
 *
 * Pure — no React, no store — so `workspaceStack.test.ts` runs it under node.
 */
import type { InboxEvent } from "../ipc";
import { countedFeedRow, waitingWords, type WaitingSession } from "./needsYou.ts";
import { inboxRowWords, isFailureRow } from "./inboxView.ts";
import type { ReconciledEvent } from "./inboxReconcile.ts";
import { cardSessionWords, type CardPresentation } from "./cardPresentation.ts";
import {
  builderSessionName,
  sessionRows,
  type SessionCardInput,
  type SessionTileInput,
} from "./sessionRows.ts";

/** QoL 1.168 (D7): `limit` — a session at its usage limit, listed grey and
 *  counted nowhere (nothing to do until it resets). */
export type StackState = "needs-you" | "failed" | "working" | "limit";

/** Where a click on an item lands. */
export type StackTarget =
  /** The card, open over its Board (a Builder session or a card row). */
  | { kind: "card"; cardId: string }
  /** Terminals with that tile expanded — what the current section's row does. */
  | { kind: "tile"; tileId: string }
  /** A feed row without a card (an agent run): the Inbox's own jump. */
  | { kind: "event"; eventId: string };

export type StackItem = {
  key: string;
  name: string;
  state: StackState;
  /** What it is doing, in words — the accessible name and the tooltip. */
  words: string;
  target: StackTarget;
  /** A feed row the item came from: its click is the Inbox's jump. */
  eventId?: string;
  /** UX P-A Mac walk 5: the card's own dot (`presentCard`), where the item
   *  speaks for its card as the Inbox row does; else the state's. */
  dot?: CardPresentation["dot"]["state"];
  /** A plain shell tile: its own words already say it runs ("running",
   *  owner 2026-10-19), so no "working" beside them. */
  shell?: true;
};

/** What a loaded card says (`presentCard`), for an item's dot. */
export type StackPresentOf = (cardId: string) => Pick<CardPresentation, "rule" | "headline" | "dot" | "waiting"> | null;

export type StackEntry = {
  workspaceId: string;
  name: string;
  needsYou: number;
  failed: number;
  /** Working sessions other than plain shells. */
  working: number;
  /** Plain shell tiles running a command (owner 2026-10-19: a shell says
   *  shell words) — "1 running" in the row, not counted in "working". */
  running?: number;
  /** Needs you first, then failed, then working. */
  items: StackItem[];
};

export type StackWorkspace = { id: string; name: string; lastOpenedAt?: number | null };
export type StackTileInput = SessionTileInput & { runId?: string };

export type WorkspaceStackInput = {
  workspaces: readonly StackWorkspace[];
  activeId: string | null;
  events: readonly InboxEvent[];
  waiting: readonly WaitingSession[];
  tilesByWorkspace: Record<string, { tiles: readonly StackTileInput[] } | undefined>;
  cardsByWorkspace: Record<string, { cards: readonly SessionCardInput[] } | undefined>;
  /** UX P-A Mac walk 5: what a loaded card says, by workspace. */
  presentOf?: (workspaceId: string, cardId: string) => ReturnType<StackPresentOf>;
  /** When each workspace was last the active one this session; a workspace
   *  not active yet this session falls back to `lastOpenedAt`. */
  lastActiveAt?: Readonly<Record<string, number>>;
  now: number;
};

/** The stack's rows, all told: workspaces with something going on take the
 *  slots first ("N more active" beyond them), recent ones fill what is left. */
export const STACK_CAP = 5;

/** A change of order waits this long, stable, before the rows move. */
export const REORDER_HOLD_MS = 5_000;

/** The feed rows the one count counts (`needsYou.ts::countedFeedRow`). */
function countedEvent(e: InboxEvent): boolean {
  return countedFeedRow(e);
}

/** The feed's working rows: a card building, an agent run running. A queued
 *  card is waiting for a slot, not working. */
function workingEvent(e: InboxEvent): boolean {
  return e.group === "running" && (e.kind === "card_running" || e.kind === "run_running");
}

function eventTarget(e: InboxEvent): StackTarget {
  return e.cardId ? { kind: "card", cardId: e.cardId } : { kind: "event", eventId: e.id };
}

function groupBy<T>(list: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const t of list) {
    const k = key(t);
    const at = out.get(k);
    if (at) at.push(t);
    else out.set(k, [t]);
  }
  return out;
}

/** One workspace's items, from its own events and waiting sessions. */
export function stackItems(input: {
  events: readonly InboxEvent[];
  waiting: readonly WaitingSession[];
  tiles: readonly StackTileInput[];
  cards: readonly SessionCardInput[];
  now: number;
  presentOf?: StackPresentOf;
}): StackItem[] {
  const needsItems: StackItem[] = [];
  const failedItems: StackItem[] = [];
  const workingItems: StackItem[] = [];
  const limitItems: StackItem[] = [];
  const { tiles, cards } = input;

  const waitingTiles = new Set<string>();
  const waitingCards = new Set<string>();
  for (const s of input.waiting) {
    // QoL 1.168 (D7): a usage limit is not a "needs you" item (the one
    // count leaves it out), and never "working": it is listed grey.
    if (s.muted) {
      if (s.target.kind === "tile") waitingTiles.add(s.target.tileId);
      else waitingCards.add(s.target.cardId);
      limitItems.push({
        key: s.id,
        name: s.where,
        state: "limit",
        words: waitingWords(s).title,
        target: s.target.kind === "tile" ? { kind: "tile", tileId: s.target.tileId } : { kind: "card", cardId: s.target.cardId },
        dot: "empty",
      });
      continue;
    }
    if (s.target.kind === "tile") waitingTiles.add(s.target.tileId);
    else waitingCards.add(s.target.cardId);
    // Mac walk 5: a question its card speaks for has the card's dot, as
    // the Inbox row does.
    const p = s.target.kind === "card" ? (input.presentOf?.(s.target.cardId) ?? null) : null;
    needsItems.push({
      key: s.id,
      name: s.where,
      state: "needs-you",
      // (Challenger, P-A) The Inbox row's words: a session at its CLI's
      // folder-trust question says so here too, as its card does.
      words: waitingWords(s).title,
      target: s.target.kind === "tile"
        ? { kind: "tile", tileId: s.target.tileId }
        : { kind: "card", cardId: s.target.cardId },
      ...(p && cardSessionWords(p, undefined)
        ? { dot: p.dot.state }
        : // Windows walk 3: the folder-trust question is amber everywhere
          // (Mac walk 5), a tile's or a card this window has not presented
          // too — never the plain "needs you" green.
          s.question === "trust" || s.question === "usage-limit" || s.question === "bypass"
          ? { dot: "aborted" as const }
          : {}),
    });
  }

  const cardsListed = new Set<string>(waitingCards);
  for (const e of input.events) {
    if (!countedEvent(e)) continue;
    // A card whose Builder is waiting is already listed, as that session.
    if (e.cardId && waitingCards.has(e.cardId)) continue;
    const p = e.cardId ? (input.presentOf?.(e.cardId) ?? null) : null;
    const item: StackItem = {
      key: `event:${e.id}`,
      name: e.title,
      state: isFailureRow(e) ? "failed" : "needs-you",
      // (Challenger, P-A) A row the loaded card words (`inboxReconcile.ts`)
      // reads as the Inbox page draws it.
      words:
        (e as ReconciledEvent).presented?.detail ??
        inboxRowWords(e).detail ??
        (isFailureRow(e) ? "Failed" : "Needs you"),
      target: eventTarget(e),
      eventId: e.id,
      // Mac walk 5: the Inbox row's dot, which is its card's.
      ...(p ? { dot: p.dot.state } : {}),
    };
    if (e.cardId) cardsListed.add(e.cardId);
    (item.state === "failed" ? failedItems : needsItems).push(item);
  }

  // Live sessions the header calls working, Builders first (the rail's order).
  const runsListed = new Set<string>();
  const byTile = new Map(tiles.map((t) => [t.id, t]));
  const byCard = new Map(cards.map((c) => [c.id, c]));
  for (const row of sessionRows(tiles, cards, input.now)) {
    if (row.target.kind === "card") {
      // CL-7: a card built by both has no Builder row of its own, only its
      // builds' rows; here its Inbox and working events cover it.
      if (row.lane) continue;
      const cardId = row.target.cardId;
      // Windows walk 2 (P-A): one item per card. A card the feed already
      // lists (a waiting session, an Inbox row: "Ready to ship") is that
      // item; its Builder session is not a second line for it.
      if (cardsListed.has(cardId)) continue;
      cardsListed.add(cardId);
      const card = byCard.get(cardId);
      workingItems.push({
        key: row.key,
        name: card ? builderSessionName(card) : row.name,
        state: "working",
        words: "working",
        target: { kind: "card", cardId },
      });
      continue;
    }
    const tileId = row.target.tileId;
    if (tileId == null || waitingTiles.has(tileId)) continue;
    // `running` is working; `error` covers a quiet one ("no output for a
    // while", still working) and a failed one, which is not.
    const quiet = row.tone === "quiet";
    if (row.dot !== "running" && !quiet) continue;
    const runId = byTile.get(tileId)?.runId;
    if (runId) runsListed.add(runId);
    workingItems.push({
      key: row.key,
      name: row.name,
      state: "working",
      words: row.state,
      target: { kind: "tile", tileId },
      ...(row.plainShell ? { shell: true as const } : {}),
    });
  }

  for (const e of input.events) {
    if (!workingEvent(e)) continue;
    if (e.cardId && cardsListed.has(e.cardId)) continue;
    if (e.runId && runsListed.has(e.runId)) continue;
    if (e.cardId) cardsListed.add(e.cardId);
    workingItems.push({
      key: `event:${e.id}`,
      name: e.title,
      state: "working",
      words: inboxRowWords(e).detail ?? "Running",
      target: eventTarget(e),
      eventId: e.id,
    });
  }

  return [...needsItems, ...failedItems, ...workingItems, ...limitItems];
}

function tier(e: StackEntry): number {
  return e.needsYou + e.failed > 0 ? 0 : 1;
}

const NO_EVENTS: InboxEvent[] = [];
const NO_WAITING: WaitingSession[] = [];

/**
 * Every other workspace with something going on: needs you (or failed)
 * first, then working, each by when it was last active this session
 * (`lastActiveAt`, else `lastOpenedAt`). The current workspace is never in
 * it — its section is right above.
 */
export function workspaceStack(input: WorkspaceStackInput): StackEntry[] {
  // Grouped once per call, not scanned once per workspace.
  const events = groupBy(input.events, (e) => e.workspaceId);
  const waiting = groupBy(input.waiting, (s) => s.workspaceId);
  const out: { entry: StackEntry; recency: number }[] = [];
  for (const ws of input.workspaces) {
    if (ws.id === input.activeId) continue;
    const items = stackItems({
      events: events.get(ws.id) ?? NO_EVENTS,
      waiting: waiting.get(ws.id) ?? NO_WAITING,
      tiles: input.tilesByWorkspace[ws.id]?.tiles ?? [],
      cards: input.cardsByWorkspace[ws.id]?.cards ?? [],
      now: input.now,
      ...(input.presentOf ? { presentOf: (cardId: string) => input.presentOf!(ws.id, cardId) } : {}),
    });
    if (items.length === 0) continue;
    let needsYou = 0;
    let failed = 0;
    let working = 0;
    let running = 0;
    for (const i of items) {
      if (i.state === "needs-you") needsYou++;
      else if (i.state === "failed") failed++;
      else if (i.state === "limit") continue;
      else if (i.shell) running++;
      else working++;
    }
    out.push({
      entry: { workspaceId: ws.id, name: ws.name, needsYou, failed, working, running, items },
      recency: input.lastActiveAt?.[ws.id] ?? ws.lastOpenedAt ?? 0,
    });
  }
  out.sort((a, b) => tier(a.entry) - tier(b.entry) || b.recency - a.recency);
  return out.map((o) => o.entry);
}

/** The rows' order on screen, and a change of it waiting to be applied. */
export type HeldOrder = {
  shown: readonly string[];
  pending: readonly string[] | null;
  pendingSince: number;
};

export const EMPTY_ORDER: HeldOrder = { shown: [], pending: null, pendingSince: 0 };

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Keep rows from jumping under the pointer. A workspace that appears or
 * leaves does so at once (the list must be true), and the others keep their
 * places; a new order among them is applied only once it has held, unchanged,
 * for `REORDER_HOLD_MS` — a session flickering between working and needs you
 * never shuffles the stack.
 */
export function holdOrder(
  held: HeldOrder,
  wanted: readonly string[],
  now: number,
  holdMs: number = REORDER_HOLD_MS,
): HeldOrder {
  const present = new Set(wanted);
  const shown = held.shown.filter((id) => present.has(id));
  // A new row takes its wanted place, after the row it follows there.
  wanted.forEach((id, i) => {
    if (shown.includes(id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = shown.indexOf(wanted[j]);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    shown.splice(at, 0, id);
  });
  if (sameOrder(shown, wanted)) return { shown, pending: null, pendingSince: 0 };
  if (held.pending && sameOrder(held.pending, wanted)) {
    if (now - held.pendingSince >= holdMs) {
      return { shown: [...wanted], pending: null, pendingSince: 0 };
    }
    return { shown, pending: held.pending, pendingSince: held.pendingSince };
  }
  return { shown, pending: [...wanted], pendingSince: now };
}

/** The cap: the first five unless shown in full. */
export function capStack<T>(
  entries: readonly T[],
  showAll: boolean,
): { visible: T[]; hidden: number } {
  if (showAll || entries.length <= STACK_CAP) return { visible: [...entries], hidden: 0 };
  return { visible: entries.slice(0, STACK_CAP), hidden: entries.length - STACK_CAP };
}

/** The row's compact state, in the app's words: "1 needs you", "2 need you",
 *  "1 failed", "3 working", and a busy shell's "1 running". */
export function stackSummary(
  entry: Pick<StackEntry, "needsYou" | "failed" | "working"> & Partial<Pick<StackEntry, "items" | "running">>,
): { state: StackState; text: string; dot: StackDot; shell?: true }[] {
  const parts: { state: StackState; text: string; dot: StackDot; shell?: true }[] = [];
  const dot = (state: StackState) => worstDot(state, entry.items);
  if (entry.needsYou > 0) {
    parts.push({
      state: "needs-you",
      text: entry.needsYou === 1 ? "1 needs you" : `${entry.needsYou} need you`,
      dot: dot("needs-you"),
    });
  }
  if (entry.failed > 0) parts.push({ state: "failed", text: `${entry.failed} failed`, dot: dot("failed") });
  if (entry.working > 0) parts.push({ state: "working", text: `${entry.working} working`, dot: dot("working") });
  // A shell running a command: its own word, live like working.
  const running = entry.running ?? 0;
  if (running > 0) parts.push({ state: "working", text: `${running} running`, dot: "running", shell: true });
  return parts;
}

/** QoL 1.168 (block 10, A8): the row draws at most two of the summary's
 *  chips and "+N" for the rest — a third was clipped mid-word ("1 r"). The
 *  row's accessible name and tooltip keep every part. */
export const STACK_SUMMARY_CHIPS = 2;
export function capStackSummary<T>(parts: readonly T[], max = STACK_SUMMARY_CHIPS): { shown: T[]; more: number } {
  if (parts.length <= max) return { shown: [...parts], more: 0 };
  return { shown: parts.slice(0, max), more: parts.length - max };
}

export type StackDot = NonNullable<StackItem["dot"]>;

/** A state's own dot, where no item says its card's. */
export const STACK_STATE_DOT: Record<StackState, StackDot> = {
  "needs-you": "done",
  failed: "aborted",
  working: "running",
  limit: "empty",
};

/** Most urgent first: amber (a question nothing moves past, a failure),
 *  then green (finished, yours to look at), then live, then empty. */
const DOT_RANK: Record<StackDot, number> = { aborted: 3, done: 2, running: 1, empty: 0 };

/** An item's dot on screen: its card's, else its state's. */
export function stackItemDot(item: Pick<StackItem, "state" | "dot">): StackDot {
  return item.dot ?? STACK_STATE_DOT[item.state];
}

/** Windows walk 3 (P-A): a summary's dot is its worst item's — "1 needs
 *  you" whose one item is the amber trust question is amber, not green. */
function worstDot(state: StackState, items: readonly StackItem[] | undefined): StackDot {
  let worst: StackDot | null = null;
  for (const item of items ?? []) {
    if (item.state !== state) continue;
    const d = stackItemDot(item);
    if (worst === null || DOT_RANK[d] > DOT_RANK[worst]) worst = d;
  }
  return worst ?? STACK_STATE_DOT[state];
}

/** An item's short state word beside its name — only when its row mixes
 *  states; otherwise it would only repeat the row's. A shell tile's own
 *  words already say its state ("running", owner 2026-10-19). */
export function itemStateWord(
  entry: Pick<StackEntry, "needsYou" | "failed" | "working"> & Partial<Pick<StackEntry, "running">>,
  item: Pick<StackItem, "state" | "shell">,
): string | null {
  if (stackSummary(entry).length < 2) return null;
  if (item.shell || item.state === "limit") return null;
  return item.state === "needs-you" ? "needs you" : item.state;
}

/** A workspace used recently and idle now: a plain row, its name only. */
export type RecentEntry = { workspaceId: string; name: string };

/**
 * The other workspaces that were the active one earlier this session, most
 * recent first, minus the current one and those already in the stack with a
 * state (`exclude`). Only this session counts — `lastActiveAt`, never
 * `lastOpenedAt`: a workspace opened at some earlier launch is not one the
 * person is working in now, and would fill the slots the day the app starts.
 */
export function recentWorkspaces(input: {
  workspaces: readonly StackWorkspace[];
  activeId: string | null;
  lastActiveAt?: Readonly<Record<string, number>>;
  exclude: ReadonlySet<string>;
}): RecentEntry[] {
  const at = input.lastActiveAt ?? {};
  const out: { entry: RecentEntry; at: number }[] = [];
  for (const ws of input.workspaces) {
    if (ws.id === input.activeId || input.exclude.has(ws.id)) continue;
    const t = at[ws.id];
    if (t == null) continue;
    out.push({ entry: { workspaceId: ws.id, name: ws.name }, at: t });
  }
  out.sort((a, b) => b.at - a.at);
  return out.map((o) => o.entry);
}

/**
 * Which rows the stack shows, in their wanted order: the workspaces with a
 * state first (the first five, or all of them on "N more active"), then the
 * recent ones in the slots left under `STACK_CAP`. `hiddenActive` is what
 * "N more active" counts; the recent ones not shown join the idle ones
 * behind "N more workspaces".
 */
export function stackSlots(
  stateful: readonly string[],
  recent: readonly string[],
  showAll: boolean,
): { wanted: string[]; hiddenActive: number; recentShown: number } {
  const { visible, hidden } = capStack(stateful, showAll);
  const room = Math.max(0, STACK_CAP - visible.length);
  const shownRecent = recent.slice(0, room);
  return {
    wanted: [...visible, ...shownRecent],
    hiddenActive: hidden,
    recentShown: shownRecent.length,
  };
}

/** "3 more workspaces": the ones the stack does not show, left to the
 *  switcher. */
export function idleWorkspacesLabel(n: number): string {
  return n === 1 ? "1 more workspace" : `${n} more workspaces`;
}
