import { useEffect, useMemo, useRef, useState } from "react";
import { usePageVisible } from "./usePageVisible";
import { useTiles } from "../store/tileStore";
import { useBuilder } from "../store/builderStore";
import { useKanban } from "../store/kanbanStore";
import { useShownFeed } from "../store/inboxStore";
import { attentionCounts, waitingSessions, type WaitingSession } from "../lib/needsYou";
import { useIntake } from "../store/intakeStore";
import { stoppedIntakes } from "../lib/intakeStopped";
import { usePlannerOf } from "../components/usePlanner";
import { branchCleanupCounts, useBranchCleanup } from "../store/branchCleanupStore";
import { usePlanExchange } from "../store/planExchangeStore";
import { useTileSeen } from "../store/tileSeenStore";
import type { InboxFeed } from "../ipc";
import { foldWaitingIntoCardRows, reconcileFeed } from "../lib/inboxReconcile";
import { liveInboxCards, sourcesWithLiveWaiting, useCardLiveSources, withLiveWaiting } from "./useCardLive";
import type { BuilderWaitingByCard } from "../lib/builderWaiting";

export type NeedsYou = {
  /** Live sessions waiting for an answer — Needs you rows of the Inbox. */
  waiting: WaitingSession[];
  /** The one count, per workspace (the switcher). */
  byWorkspace: Record<string, number>;
  /** The one count, across workspaces (the sidebar's Inbox row). */
  total: number;
  /** The Inbox page's "N things need you": `total` (F1, one count). */
  needs: number;
  /** P-A (UX P1 point 2): the feed reconciled with what the loaded cards
   *  say (`lib/inboxReconcile.ts`) — what every count above is read from,
   *  and what the Inbox page draws. */
  feed: InboxFeed | null;
  /** UX P-B Mac walk 2: the waiting Builders the rows above were presented
   *  with — the store's, with this render's live sessions over it
   *  (`withLiveWaiting`). The Inbox presents its rows' cards with it. */
  builderWaiting: BuilderWaitingByCard;
};

/** The card keys (`ws::card`) that have a live session's row. */
export function waitingCardKeys(waiting: readonly WaitingSession[]): string[] {
  const out: string[] = [];
  for (const s of waiting) if (s.target.kind === "card") out.push(`${s.workspaceId}::${s.target.cardId}`);
  return out.sort();
}

/** `withLiveWaiting`, the same object while its entries are the same (the
 *  waiting sessions are a new array every second). */
function useStableLiveWaiting(
  byCard: BuilderWaitingByCard | undefined,
  waiting: readonly WaitingSession[],
): BuilderWaitingByCard {
  const last = useRef<BuilderWaitingByCard | null>(null);
  const next = withLiveWaiting(byCard, waiting);
  const prev = last.current;
  if (prev && next !== byCard && sameWaiting(prev, next)) return prev;
  last.current = next;
  return next;
}

function sameWaiting(a: BuilderWaitingByCard, b: BuilderWaitingByCard): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => {
    const x = a[k];
    const y = b[k];
    return y != null && x.state === y.state && x.vendor === y.vendor && x.lane === y.lane && x.releaseAt === y.releaseAt;
  });
}

/** P-A: the shown feed, reconciled with the loaded cards' presentations. */
export function useReconciledFeed(waiting: readonly WaitingSession[]): InboxFeed | null {
  const feed = useShownFeed();
  const sources = useCardLiveSources();
  // UX P-B Mac walk 2: the cards presented with the same live sessions.
  const builderWaiting = useStableLiveWaiting(sources.builderWaiting, waiting);
  const loaded = useMemo(() => liveInboxCards(sourcesWithLiveWaiting(sources, builderWaiting)), [sources, builderWaiting]);
  const waitingKey = waitingCardKeys(waiting).join("\n");
  return useMemo(
    () => reconcileFeed({ feed, loaded, waitingCards: new Set(waitingKey ? waitingKey.split("\n") : []) }),
    [feed, loaded, waitingKey],
  );
}

/**
 * UX-4.4: the one attention signal (`lib/needsYou.ts`), read from the live
 * stores. `now` comes from the caller's ticker — a session starts waiting
 * after ten quiet seconds, which only a clock can notice.
 */
export function useNeedsYou(now: number): NeedsYou {
  const tilesBy = useTiles((s) => s.byWorkspace);
  const builders = useBuilder((s) => s.byCard);
  const trustAsking = useBuilder((s) => s.trustAsking);
  const sessionBlocks = useBuilder((s) => s.sessionBlocks);
  const sentAt = useBuilder((s) => s.sentAt);
  const submittedAt = useBuilder((s) => s.submittedAt);
  const doneAt = useBuilder((s) => s.doneAt);
  const selfCheck = useBuilder((s) => s.selfCheck);
  const doneBusy = useBuilder((s) => s.doneBusy);
  const cardsBy = useKanban((s) => s.byWorkspace);
  const shownFeed = useShownFeed();
  const sources = useCardLiveSources();
  // N14 walk F14: an intake that ended while its card still plans.
  const intakeStops = useIntake((s) => s.stoppedByCard);
  const plannerOf = usePlannerOf();
  // N18: the card-branch cleanup's asks are Needs you rows too.
  const cleanup = useBranchCleanup((s) => s.pending);
  // Plan with two AIs: a plan that waits for the person, or is paused.
  const plans = usePlanExchange((s) => s.open);
  // QoL 1.168 (D7): the tile turns the person has seen.
  const tileSeen = useTileSeen((s) => s.seen);
  const live = useMemo(
    () =>
      waitingSessions({
        tilesByWorkspace: tilesBy,
        builders,
        cardTitle: (ws, id) => cardsBy[ws]?.cards.find((c) => c.id === id)?.title ?? null,
        now,
        trustAsking,
        sessionBlocks,
        card: (ws, id) => cardsBy[ws]?.cards.find((c) => c.id === id) ?? null,
        loaded: (ws) => cardsBy[ws]?.loaded === true,
        sentAt,
        submittedAt,
        doneAt,
        // (Challenger, P-B) as the app's tick counts it.
        finishing: (key) => Boolean(selfCheck[key]) || Boolean(doneBusy[key]),
        intakesStopped: stoppedIntakes(cardsBy, intakeStops, plannerOf),
        plans: Object.values(plans),
        tileSeen,
      }),
    [tilesBy, builders, trustAsking, sessionBlocks, sentAt, submittedAt, doneAt, selfCheck, doneBusy, cardsBy, now, intakeStops, plannerOf, plans, tileSeen],
  );
  // UX P-B Mac walk 2: the cards are presented with this render's live
  // sessions, the ones `live` lists — not the store's, a tick behind — so
  // a session row and its card's rule agree from the first frame.
  const builderWaiting = useStableLiveWaiting(sources.builderWaiting, live);
  const liveCards = useMemo(() => liveInboxCards(sourcesWithLiveWaiting(sources, builderWaiting)), [sources, builderWaiting]);
  return useMemo(() => {
    // P-A: every count reads the feed as the loaded cards say it.
    const feed = reconcileFeed({
      feed: shownFeed,
      loaded: liveCards,
      waitingCards: new Set(waitingCardKeys(live)),
    });
    // UX P-B Mac walk 1: one card, one row — a waiting Builder's row folds
    // into its card's row when the card speaks for itself.
    const waiting = [...foldWaitingIntoCardRows(live, feed, liveCards)];
    const { byWorkspace, total, needs } = attentionCounts(feed, waiting, branchCleanupCounts(cleanup));
    return { waiting, byWorkspace, total, needs, feed, builderWaiting };
  }, [live, builderWaiting, liveCards, shownFeed, cleanup]);
}

/** A clock for the attention counts: once a second while the window is on
 *  screen, paused while it is hidden (v1.63.0). */
export function useNow(): number {
  const visible = usePageVisible();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [visible]);
  return now;
}
