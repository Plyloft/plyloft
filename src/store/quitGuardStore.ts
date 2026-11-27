import { create } from "zustand";
import { deriveTileAttention, type AttentionTile } from "../lib/attention";
import { offScreenJudgement } from "../lib/builderScreenState";
import { READY_QUIET_MS, tileHeaderStatusFor, type Readiness } from "../lib/tileHeaderStatus";
import { screenProvesTurnOver, tileScreenNow } from "../lib/tileScreen";
import { STARTING_MS } from "../lib/tileStatusLine";
import { runningCounts, type RunningCounts } from "../lib/closeChoice";
import { unsavedFiles } from "../lib/editorSave";
import { quitAsks, type QuitLoss, type QuitReason } from "../lib/quitGuard";
import { useTiles } from "./tileStore";
import {
  builderResumedIdle,
  builderScreenOf,
  builderScreens,
  freshBuilderScreens,
  noBuilderScreensToRead,
  isBuilderObserved,
  useBuilder,
} from "./builderStore";
import { useAgents } from "./agentStore";
import { useKanban } from "./kanbanStore";
import { useSwarms } from "./swarmStore";
import { useVerify } from "./verifyStore";
import { useShip } from "./shipStore";
import { useSettings } from "./settingsStore";
import { cardIdOfSessionKey, parseLaneKey } from "../lib/buildBoth";
import type { WaitingSession } from "../lib/needsYou";

/**
 * QoL 1.168 S1-2: the quit guard — asks before Plyloft ends only when
 * something would be lost (`lib/quitGuard.ts` says what and in which words).
 * `confirmQuit` resolves `true` at once when nothing would be; otherwise the
 * one host (`QuitGuardSheet`, mounted in the App) shows the sheet and the
 * answer resolves it: `true` once the files the person chose to save are
 * saved (or they chose to quit anyway), `false` on Cancel.
 */

/**
 * 1.169.0 (Windows walk; Challenger): what a quit would interrupt in a
 * session tile, read from what its header reads — `working` mid-turn,
 * `waiting` for the member's answer (a permission prompt, a question, a
 * chat's approval: owner, a quit asks for those as closing a tile does), or
 * null. A scanned Claude or Codex tile works when its screen shows a turn
 * or background work running, or its header is not Ready; output alone — a
 * resumed conversation's repaint, the redraw a focus change brings — no
 * longer counts it, as the 10 s silence clock did while the header said
 * Ready. One still starting (nothing drawn yet) has nothing to lose. A tile
 * never scanned keeps the clock; a chat tile reads its session. Shells are
 * never counted (D8).
 */
export function sessionQuitState(
  t: AttentionTile & { readiness?: Readiness; pendingClose?: boolean; id?: string },
  now: number,
): "working" | "waiting" | null {
  if (t.pendingClose || t.status !== "running") return null;
  if (t.kind === "codex-chat") {
    if (t.sessionApprovalPending === true) return "waiting";
    return t.sessionBusy === true ? "working" : null;
  }
  if (t.kind !== "claude" && t.kind !== "codex") return null;
  if (t.questionInView === true || t.question != null || t.readiness?.waiting) return "waiting";
  // The header's Starting…: nothing drawn yet, nothing to lose.
  if (t.lastOutputAt == null && now - t.startedAt < STARTING_MS) return null;
  if (!t.readiness) return deriveTileAttention(t, now) === "working" ? "working" : null;
  if (t.readiness.running || t.readiness.background) return "working";
  if (tileHeaderStatusFor(t.kind, t.readiness, t.startedAt, now).ready) return null;
  // 1.177.1 (item 21): the header leaves "Working" 2 s after a turn's last
  // output; a live screen that proves the turn over (`screenProvesTurnOver`)
  // has nothing to lose in those 2 s. Only in that quiet window — the scan's
  // verdict idle, the header waiting for its quiet (review round 3, L6): a
  // busy verdict stands. No screen, or no proof: working.
  const quietWindow = (t.readiness.matcherIdle ?? true) && now - t.readiness.lastOutputAt < READY_QUIET_MS;
  if (quietWindow && t.id && screenProvesTurnOver(t.kind, tileScreenNow(t.id))) return null;
  return "working";
}

/** Whether `t` is mid-turn (`sessionQuitState`). */
export function tileWorkingNow(t: Parameters<typeof sessionQuitState>[0], now: number): boolean {
  return sessionQuitState(t, now) === "working";
}

/** 1.176.2 (F1 review round 3, S1): which Builders no terminal shows the
 *  last `workingNow` counted as at work or waiting, and why (states and
 *  times, never screen text) — for the update's log. */
let lastOffScreenWhy = "";
export function offScreenWorkingWhy(): string {
  return lastOffScreenWhy;
}

/** 1.176.4 (owner, update line): where a session the last `workingNow`
 *  counted as waiting for the person is — a card's Builder that asks, else a
 *  tile that asks, and a session at its usage limit (the Inbox's grey, muted
 *  row) only when nothing else waits — so the update's "Waiting: …" line can
 *  open it. `where`: the card's title or the tile's label. `limit`: it waits
 *  only on its usage limit (so does every other waiting session, then). */
export type WaitingPlace = Pick<WaitingSession, "workspaceId" | "target"> & { where: string; limit?: true };
let lastWaitingPlace: WaitingPlace | null = null;
export function firstWaitingPlace(): WaitingPlace | null {
  return lastWaitingPlace;
}

/** A Builder session's card, in the project that holds it. */
function builderPlace(key: string, workspaceId: string | undefined): WaitingPlace | null {
  const cardId = cardIdOfSessionKey(key);
  const ws =
    workspaceId ??
    Object.entries(useKanban.getState().byWorkspace).find(([, w]) => w.cards.some((c) => c.id === cardId))?.[0];
  if (!ws) return null;
  const lane = parseLaneKey(key)?.lane;
  const where = useKanban.getState().byWorkspace[ws]?.cards.find((c) => c.id === cardId)?.title ?? "a card's session";
  return { workspaceId: ws, where, target: lane ? { kind: "card", cardId, lane } : { kind: "card", cardId } };
}

/** Work in flight right now: sessions mid-turn (never one waiting at its
 *  prompt, nor a shell), runs, reviews, swarms, builds and a ship.
 *  `unsure` (1.176.2, review F1): the screens of the Builder sessions no
 *  terminal shows could not be read just now — each counts as at work. */
export function workingNow(now = Date.now(), opts: { unsure?: boolean } = {}): RunningCounts {
  const placed = Object.entries(useTiles.getState().byWorkspace).flatMap(([ws, w]) => w.tiles.map((t) => ({ ws, t })));
  const tiles = placed.map((p) => p.t);
  const states = tiles.map((t) => sessionQuitState(t, now));
  const workingTiles = tiles.filter((_, i) => states[i] === "working");
  let waiting = states.filter((s) => s === "waiting").length;
  const tileLimited = (t: (typeof tiles)[number]) => (t as { question?: string | null }).question === "usageLimit";
  const waitingTile =
    placed.find((p, i) => states[i] === "waiting" && !tileLimited(p.t)) ?? placed.find((_, i) => states[i] === "waiting");
  let builderSessions = 0;
  const builders = useBuilder.getState();
  /** 1.176.4: the first Builder counted as waiting that asks, and the
   *  first one waiting only on its usage limit, for the update's line. */
  let waitingBuilder: WaitingPlace | null = null;
  let limitedBuilder: WaitingPlace | null = null;
  const builderWaits = (key: string) => {
    const limited = builders.sessionBlocks[key]?.kind === "usageLimit" && !builders.trustAsking[key];
    if (limited ? limitedBuilder : waitingBuilder) return;
    const ws =
      builders.byCard[key]?.workspaceId ?? builders.trustAsking[key]?.workspaceId ?? builders.sessionBlocks[key]?.workspaceId;
    const place = builderPlace(key, ws);
    if (limited) limitedBuilder = place ? { ...place, limit: true } : null;
    else waitingBuilder = place;
  };
  // 1.176.2 (A5F-14): a Builder the backend reads stopped at its CLI's
  // folder-trust question, Claude's Bypass warning or its usage limit waits
  // for the person, its card open or not (review F4: never one whose
  // process ended). An intake's trust question is no Builder's.
  const blocked = new Set<string>([
    ...Object.entries(builders.trustAsking)
      .filter(([, q]) => !q.intake)
      .map(([key]) => key),
    ...Object.keys(builders.sessionBlocks),
  ]);
  const counted = new Set<string>();
  /** 1.176.2 (A5F-01), 1.176.3 phase 2: a session no terminal here shows,
   *  as the backend last read it, judged from its screen
   *  (`builderScreenState.ts`): at work, waiting for the person, or
   *  neither. No reading of it, or none could be taken just now: at work. */
  const why: string[] = [];
  const offScreen = (key: string, screen: ReturnType<typeof builderScreenOf>, vendor: string) => {
    if (screen?.exited) return;
    if (blocked.has(key)) {
      waiting += 1;
      builderWaits(key);
      why.push(`Builder ${key} ${vendor} waiting: stopped at a question`);
      return;
    }
    if (!screen || opts.unsure) {
      builderSessions += 1;
      why.push(`Builder ${key} ${vendor} working: ${opts.unsure ? "read failed" : "no reading"}`);
      return;
    }
    const judged = offScreenJudgement(screen, now);
    if (judged.state === "working") builderSessions += 1;
    else if (judged.state === "waiting") {
      waiting += 1;
      builderWaits(key);
    } else return;
    why.push(`Builder ${key} ${vendor} ${judged.state}: ${judged.why}`);
  };
  for (const [key, b] of Object.entries(builders.byCard)) {
    counted.add(key);
    // With its card's terminal gone the runtime is frozen at its last scan.
    if (!isBuilderObserved(key)) {
      offScreen(key, builderScreenOf(key), b.vendor);
      continue;
    }
    if (blocked.has(key)) {
      waiting += 1;
      builderWaits(key);
      continue;
    }
    const a = deriveTileAttention(
      {
        kind: b.vendor === "codex" ? "codex" : "claude",
        status: "running",
        startedAt: b.startedAt,
        lastOutputAt: b.lastOutputAt,
        promptBoxIdle: b.promptBoxIdle,
        questionInView: b.questionInView,
      },
      now,
    );
    // 1.174.3: as Now says it: a resumed session that received nothing isn't at work.
    if (a === "working" && !b.turnIdleSettled && !builderResumedIdle(key)) builderSessions += 1;
    // Challenger: a Builder asking the member waits for an answer too.
    else if (a === "asking-you" && b.questionInView === true) {
      waiting += 1;
      builderWaits(key);
    }
  }
  // A live Builder with no runtime in this window (built from the Board,
  // its card never opened).
  for (const [key, screen] of builderScreens()) {
    if (counted.has(key)) continue;
    counted.add(key);
    offScreen(key, screen, screen.vendor);
  }
  for (const key of blocked) {
    if (counted.has(key)) continue;
    waiting += 1;
    builderWaits(key);
  }
  lastOffScreenWhy = why.join("; ");
  const tilePlace: WaitingPlace | null = waitingTile
    ? {
        workspaceId: waitingTile.ws,
        where: waitingTile.t.label,
        target: { kind: "tile", tileId: waitingTile.t.id },
        ...(tileLimited(waitingTile.t) ? { limit: true as const } : {}),
      }
    : null;
  lastWaitingPlace =
    waitingBuilder ?? (tilePlace && !tilePlace.limit ? tilePlace : null) ?? limitedBuilder ?? tilePlace;
  const counts = runningCounts({
    tiles: workingTiles,
    builderSessions,
    runStatuses: Object.values(useAgents.getState().byWorkspace).flatMap((w) =>
      w.runs.map((r) => r.status),
    ),
    reviewStatuses: Object.values(useKanban.getState().byWorkspace).flatMap((w) =>
      w.cards.map((c) => c.builder?.review?.status ?? ""),
    ),
    swarmStatuses: Object.values(useSwarms.getState().byWorkspace).flatMap((w) =>
      w.swarms.map((sw) => sw.status),
    ),
    verifyJobs: useVerify.getState().inflight.length,
    shipping: useShip.getState().shipping,
  });
  return { ...counts, waiting, terminals: 0 };
}

export function quitLossNow(opts: { unsure?: boolean } = {}): QuitLoss {
  return { files: unsavedFiles(), working: workingNow(Date.now(), opts) };
}

export interface QuitAskState {
  id: number;
  reason: QuitReason;
  loss: QuitLoss;
  workingAcknowledged: boolean;
  /** Round 6 (review H1): the Builder screens were read when the sheet
   *  opened. Unread, each off-screen Builder counts as at work (1.176.2,
   *  F1) — the open sheet's later readings too. */
  screensRead: boolean;
  resolve: (ok: boolean) => void;
}

interface QuitGuardState {
  ask: QuitAskState | null;
  hosts: number;
}

export const useQuitGuard = create<QuitGuardState>(() => ({ ask: null, hosts: 0 }));

let nextId = 1;

/** The Windows close sheet named what would stop and the person chose Quit:
 *  the quit that follows asks only about unsaved files. */
let workingAcknowledgedUntil = 0;
export function acknowledgeWorkingForQuit(now = Date.now()): void {
  workingAcknowledgedUntil = now + 10_000;
}
function takeWorkingAcknowledged(now = Date.now()): boolean {
  const acknowledged = now < workingAcknowledgedUntil;
  workingAcknowledgedUntil = 0;
  return acknowledged;
}

/** Whether a quit now would ask, without taking the close sheet's
 *  acknowledgement (`confirmQuit` takes it). */
export function peekQuitAsks(now = Date.now(), opts: { unsure?: boolean } = {}): boolean {
  return quitAsks(quitLossNow(opts), {
    askWorking: askWorkingSetting(),
    workingAcknowledged: now < workingAcknowledgedUntil,
  });
}

/** 1.176.2 (review round 2, M1): whether a quit Rust started asks, with the
 *  Builders no terminal shows read now (at most 1 s: Rust waits 3 s for the
 *  ack). No reading — failed, or late — asks. */
export async function quitAsksNow(): Promise<boolean> {
  if (noBuilderScreensToRead()) return peekQuitAsks();
  const read = await freshBuilderScreens(1_000);
  return peekQuitAsks(Date.now(), { unsure: !read });
}

export function askWorkingSetting(): boolean {
  return useSettings.getState().settings.behavior.confirmQuitWithWorkingSessions !== false;
}

/**
 * Whether it is all right to end Plyloft now. Resolves `true` at once when
 * nothing would be lost, or when no host is mounted (never hold a quit back
 * for a sheet nobody can see). `workingAcknowledged`: the work in flight was
 * already named (the Windows close sheet, the update dialog).
 */
export function confirmQuit(
  reason: QuitReason,
  opts: { workingAcknowledged?: boolean } = {},
): Promise<boolean> {
  const workingAcknowledged = takeWorkingAcknowledged() || opts.workingAcknowledged === true;
  // No live Builder: nothing to read, the answer comes at once as before.
  if (noBuilderScreensToRead()) return askQuit(reason, workingAcknowledged, true);
  return freshBuilderScreens().then((read) => askQuit(reason, workingAcknowledged, read));
}

function askQuit(reason: QuitReason, workingAcknowledged: boolean, screensRead: boolean): Promise<boolean> {
  // Review F1: the screens read just now; unread, each session no terminal
  // shows counts as at work, and the sheet asks.
  const loss = quitLossNow({ unsure: !screensRead });
  const asks = quitAsks(loss, { askWorking: askWorkingSetting(), workingAcknowledged });
  const { hosts, ask } = useQuitGuard.getState();
  if (!asks || hosts === 0) return Promise.resolve(true);
  // QoL 1.168 review: a second ask while the sheet is up (⌘Q over the
  // update's restart sheet) is answered "no" at once — the open sheet is the
  // one question, and its answer never runs two endings at once.
  if (ask) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    useQuitGuard.setState({
      ask: { id: nextId++, reason, loss, workingAcknowledged, screensRead, resolve },
    });
  });
}

/** The sheet was answered. */
export function answerQuit(id: number, ok: boolean): void {
  const ask = useQuitGuard.getState().ask;
  if (!ask || ask.id !== id) return;
  useQuitGuard.setState({ ask: null });
  ask.resolve(ok);
}

/** A host mounted; returns its unmount, which answers Cancel to what it held. */
export function registerQuitHost(): () => void {
  useQuitGuard.setState((s) => ({ hosts: s.hosts + 1 }));
  return () => {
    const { hosts, ask } = useQuitGuard.getState();
    const left = hosts - 1;
    useQuitGuard.setState({ hosts: left, ask: left === 0 ? null : ask });
    if (left === 0 && ask) ask.resolve(false);
  };
}
