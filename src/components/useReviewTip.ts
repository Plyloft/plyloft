import { useCallback, useEffect, useMemo, useReducer, useSyncExternalStore } from "react";
import { cardReviewTip, type KanbanCard, type ReviewTipFacts } from "../ipc";
import { readyToShipForStage } from "../lib/boardSemantics";
import { latestSnapshotKey } from "../lib/snapshotRevision";

/** How often an open Builder card re-reads its branch tip. */
const REVIEW_TIP_POLL_MS = 5000;

type Entry = {
  workspaceId: string;
  cardId: string;
  facts: ReviewTipFacts | null;
  listeners: Set<() => void>;
  timer: number | null;
  inFlight: boolean;
};

/** One poll per card however many surfaces (header, Run chip, Outcome)
 *  show it. */
const entries = new Map<string, Entry>();

/**
 * UX P-A Mac walk 2: the last tip read for each card (`ws::card`), kept
 * after its surfaces unsubscribe — what the Inbox's reconciliation reads
 * (`useCardLive.ts::liveInboxCards`), so an Inbox row of an open Builder
 * session says "Ready to ship" as its Board card does, from its first
 * frame. Only a read replaces an entry; nothing here polls.
 */
let lastTips: ReadonlyMap<string, ReviewTipFacts> = new Map();
const lastTipListeners = new Set<() => void>();

function publishTip(key: string, facts: ReviewTipFacts) {
  const known = lastTips.get(key);
  if (known && known.branchTip === facts.branchTip && known.commitsSinceReview === facts.commitsSinceReview) return;
  const next = new Map(lastTips);
  next.set(key, facts);
  lastTips = next;
  lastTipListeners.forEach((listener) => listener());
}

function subscribeLastTips(listener: () => void) {
  lastTipListeners.add(listener);
  return () => {
    lastTipListeners.delete(listener);
  };
}

/** The last tips read, by `ws::card` (outside React). */
export function lastReviewTipsNow(): ReadonlyMap<string, ReviewTipFacts> {
  return lastTips;
}

/** The last tips read, by `ws::card`; re-renders when one changes. */
export function useLastReviewTips(): ReadonlyMap<string, ReviewTipFacts> {
  return useSyncExternalStore(subscribeLastTips, lastReviewTipsNow);
}

/** Test seam: forget every tip read. */
export function resetLastReviewTips(): void {
  lastTips = new Map();
}

function read(entry: Entry) {
  if (entry.inFlight) return;
  entry.inFlight = true;
  cardReviewTip(entry.workspaceId, entry.cardId)
    .then((next) => {
      const current = entry.facts;
      if (
        current &&
        current.branchTip === next.branchTip &&
        current.commitsSinceReview === next.commitsSinceReview
      ) {
        return;
      }
      entry.facts = next;
      publishTip(`${entry.workspaceId}::${entry.cardId}`, next);
      entry.listeners.forEach((listener) => listener());
    })
    // Keep the last facts: a transient git error is not a new tip.
    .catch(() => {})
    .finally(() => {
      entry.inFlight = false;
    });
}

function refreshAll() {
  entries.forEach((entry) => read(entry));
}

function subscribe(workspaceId: string, cardId: string, listener: () => void) {
  const key = `${workspaceId}::${cardId}`;
  let entry = entries.get(key);
  if (!entry) {
    entry = { workspaceId, cardId, facts: null, listeners: new Set(), timer: null, inFlight: false };
    entries.set(key, entry);
  }
  entry.listeners.add(listener);
  if (entry.timer == null) {
    const e = entry;
    read(e);
    e.timer = window.setInterval(() => read(e), REVIEW_TIP_POLL_MS);
    // The same function reference is added once, however many cards.
    window.addEventListener("focus", refreshAll);
  }
  return () => {
    const e = entries.get(key);
    if (!e) return;
    e.listeners.delete(listener);
    if (e.listeners.size === 0) {
      if (e.timer != null) window.clearInterval(e.timer);
      entries.delete(key);
      if (entries.size === 0) window.removeEventListener("focus", refreshAll);
    }
  };
}

const NO_SUBSCRIPTION = () => () => {};

/**
 * GH #99 (reviews 2–3): a Builder card's live branch tip and the commits on
 * it since the last completed Challenger review. A commit made after a
 * review changes no card state, so the card re-reads it while any surface
 * shows it, when the window regains focus, and whenever a snapshot or
 * review lands. null until the first read, and for cards without a Builder
 * or already landed.
 */
export function useReviewTip(card: KanbanCard): ReviewTipFacts | null {
  return useTip(card, tipReadable(card));
}

/** A card whose branch tip can be read: a Builder card with a worktree,
 *  not landed. */
function tipReadable(card: KanbanCard): boolean {
  return (
    Boolean(card.builder) &&
    Boolean(card.worktreePath) &&
    card.shipStatus !== "shipped" &&
    card.reviewStatus !== "merged"
  );
}

/** SP-D: a card whose Builder session is open — it can still commit past
 *  the reviewed snapshot — and that would otherwise read "Ready to ship":
 *  the only cards whose tip the Board needs. */
function liveSession(card: KanbanCard): boolean {
  return tipReadable(card) && Boolean(card.builder?.ptyId) && readyToShipForStage(card);
}

/** SP-D: the Board's card — the live tip only while its Builder session is
 *  open (a handful of cards), from the same one-poll-per-card entries. */
export function useLiveReviewTip(card: KanbanCard): ReviewTipFacts | null {
  return useTip(card, liveSession(card));
}

/** SP-D: the List — the live tips of its cards with an open Builder
 *  session, by card id, from the same entries as `useReviewTip`. A card
 *  with no entry yet (first read in flight) maps to null. Unsubscribes when
 *  a card leaves the list or its session ends. */
export function useLiveReviewTips(
  cards: readonly KanbanCard[],
): ReadonlyMap<string, ReviewTipFacts | null> {
  const live = cards.filter(liveSession);
  // Subscriptions are keyed by card only; a landed snapshot or review only
  // re-reads (`reads`), as `useReviewTip` does.
  const sig = JSON.stringify(live.map((c) => [c.workspaceId, c.id]));
  const reads = JSON.stringify(
    live.map((c) => [c.workspaceId, c.id, latestSnapshotKey(c.builder), c.builder?.review?.status ?? null]),
  );
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const keys = JSON.parse(sig) as Array<[string, string]>;
    const unsubscribe = keys.map(([ws, id]) => subscribe(ws, id, () => bump()));
    return () => unsubscribe.forEach((u) => u());
  }, [sig]);
  useEffect(() => {
    for (const [ws, id] of JSON.parse(reads) as Array<[string, string]>) {
      const entry = entries.get(`${ws}::${id}`);
      if (entry) read(entry);
    }
  }, [reads]);
  return useMemo(() => {
    void version;
    const out = new Map<string, ReviewTipFacts | null>();
    for (const [ws, id] of JSON.parse(sig) as Array<[string, string]>) {
      out.set(id, entries.get(`${ws}::${id}`)?.facts ?? null);
    }
    return out;
  }, [sig, version]);
}

function useTip(card: KanbanCard, active: boolean): ReviewTipFacts | null {
  const key = `${card.workspaceId}::${card.id}`;
  const { workspaceId, id } = card;
  const subscribeCard = useCallback(
    (listener: () => void) =>
      active ? subscribe(workspaceId, id, listener) : NO_SUBSCRIPTION(),
    [active, workspaceId, id],
  );
  const facts = useSyncExternalStore(subscribeCard, () =>
    active ? entries.get(key)?.facts ?? null : null,
  );
  const snapshots = latestSnapshotKey(card.builder);
  const reviewStatus = card.builder?.review?.status ?? null;
  useEffect(() => {
    const entry = entries.get(key);
    if (active && entry) read(entry);
  }, [active, key, snapshots, reviewStatus]);
  return facts;
}
