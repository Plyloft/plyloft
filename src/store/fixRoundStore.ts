/**
 * 1.175.0 F5 (UX-5; owner I6, I7): the driver of "Finish and check by
 * itself" after a fix round Plyloft sent the Builder. It watches the boards
 * and the Builder sessions, asks `lib/fixRoundCheck.ts` what comes next for
 * each card with a live round, and does it: note the turn, ask whether the
 * copy changed, count one and start Finish and check — the same `done` as
 * the person's press — or record why the round waits.
 *
 * In the window, because only the window reads the Builder's terminal (as
 * `prAutoFixStore.ts`). A round lives in memory: after a relaunch the card
 * waits for the press, as before 1.175, and a check stopped by a quit says
 * "Finish and check stopped" (`checkStoppedSentence`). It never answers the
 * Builder, never types into its prompt (the self-check message waits for a
 * clean prompt, `selfCheck.ts::canDeliver`), never ships and never writes
 * to GitHub. The G7 loop's own pull request rounds are left to it.
 */
import { create } from "zustand";
import type { KanbanCard } from "../ipc";
import {
  fixRoundCheckOn,
  fixRoundCountAfterReview,
  fixRoundFactsFrom,
  fixRoundNext,
  fixRoundQualifies,
  type FixRound,
  type FixRoundFacts,
  type FixRoundHold,
  type FixRoundSession,
} from "../lib/fixRoundCheck";
import { cardFixRoundChanged, cardFixRoundSelfChecksSet } from "../lib/fixRoundActions";
import { cardTrustQuestion } from "../lib/trustQuestion";
import { cardIdOfSessionKey } from "../lib/buildBoth";
import { builderDraftInTheWay, useBuilder } from "./builderStore";
import { useKanban } from "./kanbanStore";
import { usePrAutoFix } from "./prAutoFixStore";
import { useSettings } from "./settingsStore";

/** How often a round is looked at with nothing else changing. */
const TICK_MS = 2_000;
/** A check just started shows as Plyloft's own until its self-check or its
 *  save is seen running, for at most this long. */
const START_GRACE_MS = 10_000;

type LiveRound = FixRound & {
  key: string;
  held?: FixRoundHold;
  changed?: boolean | null;
};

type FixRoundState = {
  rounds: Record<string, LiveRound | undefined>;
  /** The check Plyloft started by itself, by card: since when, and the
   *  snapshots the card had then (the next one is the check's). */
  checking: Record<string, { since: number; snapshots: number; seenRunning?: boolean } | undefined>;
  /** Stop pressed on that check: the card says so until the next round. */
  stopped: Record<string, true | undefined>;
};

export const useFixRound = create<FixRoundState>(() => ({ rounds: {}, checking: {}, stopped: {} }));

function patch(cardId: string, fn: (s: FixRoundState) => Partial<FixRoundState>) {
  useFixRound.setState((s) => fn(s));
  void cardId;
}

function setRound(cardId: string, round: LiveRound | null) {
  patch(cardId, (s) => {
    const rounds = { ...s.rounds };
    if (round) rounds[cardId] = round;
    else delete rounds[cardId];
    return { rounds };
  });
}

function settingOn(): boolean {
  return useSettings.getState().settings?.behavior?.checkFixRoundsByItself !== false;
}

/** The card's Builder session as the rule reads it. */
export function fixRoundSessionOf(card: Pick<KanbanCard, "id" | "builder">): FixRoundSession {
  const b = useBuilder.getState();
  const rt = b.byCard[card.id];
  const attached = Boolean(rt && card.builder?.ptyId && rt.ptyId === card.builder.ptyId);
  const blocked = Object.keys(b.sessionBlocks).some((k) => cardIdOfSessionKey(k) === card.id);
  return {
    attached,
    turnIdle: rt?.turnIdle === true,
    turnIdleAt: rt?.turnIdleAt ?? null,
    asking: Boolean(rt?.questionInView) || cardTrustQuestion(card.id, b.trustAsking) != null || blocked,
    interrupted: rt?.turnCutOff === true,
    draft:
      rt?.composerDraft === true ||
      rt?.composerEscaped === true ||
      (rt?.pending.length ?? 0) > 0 ||
      builderDraftInTheWay(card.id),
  };
}

function finishingNow(cardId: string): boolean {
  const b = useBuilder.getState();
  return Boolean(b.selfCheck[cardId] || b.doneBusy[cardId]);
}

/** What the card page shows of the driver for one card (`CardLive.fixRound`). */
export function fixRoundFactsOf(card: Pick<KanbanCard, "id" | "prReview" | "fixRoundCheck">): FixRoundFacts | null {
  return fixRoundFactsFrom(useFixRound.getState(), card, settingOn());
}

const seenSent = new Map<string, string>();
const seenReview = new Map<string, string>();
const inFlight = new Set<string>();

async function startCheck(card: KanbanCard, round: LiveRound, now: number): Promise<void> {
  const count = (card.fixRoundSelfChecks ?? 0) + 1;
  // Counted first: a check whose count can't be kept doesn't start.
  await cardFixRoundSelfChecksSet(card.workspaceId, card.id, count);
  const snapshots = card.builder?.snapshots.length ?? 0;
  patch(card.id, (s) => {
    const rounds = { ...s.rounds };
    delete rounds[card.id];
    const stopped = { ...s.stopped };
    delete stopped[card.id];
    return { rounds, stopped, checking: { ...s.checking, [card.id]: { since: now, snapshots } } };
  });
  void round;
  await useBuilder.getState().done(card.workspaceId, card.id);
}

/** One card: the round's next step, the check's end, the count after a review. */
export async function stepFixRound(card: KanbanCard, now = Date.now()): Promise<void> {
  const b = useBuilder.getState();
  const s = useFixRound.getState();

  // A round Plyloft sent, newly seen.
  const sent = b.fixRoundSent[card.id];
  const sentKey = sent ? `${sent.kind}:${sent.ptyId}:${sent.at}` : "";
  if (sentKey !== (seenSent.get(card.id) ?? "")) {
    seenSent.set(card.id, sentKey);
    if (sent && fixRoundQualifies(card, sent.kind)) {
      setRound(card.id, { kind: sent.kind, ptyId: sent.ptyId, sentAt: sent.at, key: sentKey });
      patch(card.id, (st) => {
        const stopped = { ...st.stopped };
        delete stopped[card.id];
        return { stopped };
      });
    } else {
      setRound(card.id, null);
    }
  }

  // A stopped check is said until the person presses Finish and check.
  if (s.stopped[card.id] && finishingNow(card.id) && !s.checking[card.id]) forgetStoppedCheck(card.id);

  // The check started by itself: shown until its self-check and save are over.
  const checking = s.checking[card.id];
  if (checking) {
    const running = finishingNow(card.id);
    const over = (checking.seenRunning && !running) || (!running && now - checking.since >= START_GRACE_MS);
    if (running && !checking.seenRunning) {
      patch(card.id, (st) => ({ checking: { ...st.checking, [card.id]: { ...checking, seenRunning: true } } }));
    } else if (over) {
      patch(card.id, (st) => {
        const next = { ...st.checking };
        delete next[card.id];
        return { checking: next };
      });
    }
  }

  // The count after a review: an approval, or a review of work the person
  // sent in themselves, starts it over (owner I6).
  const review = card.builder?.review ?? null;
  const reviewKey = review ? `${review.snapshotN}:${review.status}:${review.verdict ?? ""}` : "";
  if (reviewKey !== (seenReview.get(card.id) ?? "")) {
    const first = !seenReview.has(card.id);
    seenReview.set(card.id, reviewKey);
    const count = card.fixRoundSelfChecks ?? 0;
    if (!first && review && count > 0) {
      const ours = selfStarted.get(card.id) === review.snapshotN;
      const next = fixRoundCountAfterReview(count, review, ours);
      if (next !== count) void cardFixRoundSelfChecksSet(card.workspaceId, card.id, next).catch(() => {});
    }
  }
  if (checking && card.builder && card.builder.snapshots.length > checking.snapshots) {
    selfStarted.set(card.id, card.builder.snapshots[card.builder.snapshots.length - 1].n);
  }

  const round = useFixRound.getState().rounds[card.id];
  if (!round || inFlight.has(card.id)) return;
  // The G7 loop follows its own pull request rounds to the push.
  if (round.kind === "pr" && usePrAutoFix.getState().phases[card.id]) {
    setRound(card.id, null);
    return;
  }
  // A final hold stands until the next round or the person's press.
  if (round.held && round.held !== "asks") {
    if (finishingNow(card.id)) setRound(card.id, null);
    return;
  }
  const session = fixRoundSessionOf(card);
  const action = fixRoundNext({
    on: fixRoundCheckOn(card, settingOn()),
    round,
    ptyId: card.builder?.ptyId ?? null,
    session,
    finishing: finishingNow(card.id),
    selfChecks: card.fixRoundSelfChecks ?? 0,
    changed: round.changed,
    now,
  });
  switch (action.do) {
    case "wait":
      if (round.held === "asks") setRound(card.id, { ...round, held: undefined });
      return;
    case "note-turn":
      setRound(card.id, { ...round, turnStarted: true, held: undefined });
      return;
    case "forget":
      setRound(card.id, null);
      return;
    case "hold":
      if (round.held !== action.reason) setRound(card.id, { ...round, held: action.reason });
      return;
    case "ask-changed":
      inFlight.add(card.id);
      try {
        const changed = await cardFixRoundChanged(card.workspaceId, card.id).catch(() => null);
        const now2 = useFixRound.getState().rounds[card.id];
        const changedRead = { at: now, idleAt: session.turnIdleAt, again: action.again === true };
        if (now2?.key === round.key) setRound(card.id, { ...now2, changed, changedRead });
      } finally {
        inFlight.delete(card.id);
      }
      schedule();
      return;
    case "start":
      inFlight.add(card.id);
      try {
        await startCheck(card, round, now);
      } catch (e) {
        console.warn("fixRound: the check by itself didn't start", e);
        setRound(card.id, { ...round, held: "unknown" });
      } finally {
        inFlight.delete(card.id);
      }
      return;
  }
}

/** Snapshot numbers made by a check Plyloft started, by card (the count's
 *  reset after its review). */
const selfStarted = new Map<string, number>();

/** 1.175.0 F5 round 2: whether a fix round on this card is checked by
 *  itself (its "After a fix round", else the setting) — for the lines that
 *  say what follows a fix. */
export function useFixRoundByItself(card: Pick<KanbanCard, "prReview" | "fixRoundCheck">): boolean {
  const setting = useSettings((s) => s.settings.behavior.checkFixRoundsByItself !== false);
  return fixRoundCheckOn(card, setting);
}

/** The same, read once (no subscription). */
export function fixRoundByItselfNow(card: Pick<KanbanCard, "prReview" | "fixRoundCheck">): boolean {
  return fixRoundCheckOn(card, settingOn());
}

/** "Don't check by itself", for this round: the card waits for the press. */
export function dontCheckThisRound(cardId: string): void {
  setRound(cardId, null);
}

/** Stop on the check Plyloft started by itself: nothing is saved. */
export function stopCheckByItself(cardId: string): boolean {
  const stopped = useBuilder.getState().cancelSelfCheck(cardId);
  if (!stopped) return false;
  patch(cardId, (s) => {
    const checking = { ...s.checking };
    delete checking[cardId];
    return { checking, stopped: { ...s.stopped, [cardId]: true } };
  });
  return true;
}

/** The person pressed Finish and check themselves: what this window said
 *  of a stopped check goes. */
export function forgetStoppedCheck(cardId: string): void {
  patch(cardId, (s) => {
    const stopped = { ...s.stopped };
    delete stopped[cardId];
    return { stopped };
  });
}

function stepAll() {
  const now = Date.now();
  const watched = new Set([
    ...Object.keys(useBuilder.getState().fixRoundSent),
    ...Object.keys(useFixRound.getState().rounds),
    ...Object.keys(useFixRound.getState().checking),
  ]);
  for (const ws of Object.values(useKanban.getState().byWorkspace)) {
    for (const card of ws?.cards ?? []) {
      if (watched.has(card.id) || (card.fixRoundSelfChecks ?? 0) > 0) void stepFixRound(card, now);
    }
  }
}

let started = false;
let pending: ReturnType<typeof setTimeout> | null = null;

function schedule() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    stepAll();
  }, 200);
}

/** Started once, at launch (`App.tsx`). */
export function startFixRound(): void {
  if (started) return;
  started = true;
  useKanban.subscribe((s, prev) => {
    if (s.byWorkspace !== prev.byWorkspace) schedule();
  });
  useBuilder.subscribe(schedule);
  setInterval(schedule, TICK_MS);
}

/** Tests only. */
export function resetFixRoundForTests(): void {
  seenSent.clear();
  seenReview.clear();
  inFlight.clear();
  selfStarted.clear();
  useFixRound.setState({ rounds: {}, checking: {}, stopped: {} });
}
