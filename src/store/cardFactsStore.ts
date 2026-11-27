import { create } from "zustand";
import type { KanbanCard } from "../ipc";
import type { ShipFailure } from "../lib/cardLifecycle";
import type { OutcomeFacts } from "../lib/cardPresentation";

/**
 * UX P1 point 2 (P-A): the facts only the card page reads — its loaded
 * result (files changed, still loading, no remote, the review's freshness)
 * and the last ship press that failed — shared so the Board, the List and
 * the Inbox say what the page says. The card page writes it; every other
 * surface reads it. In memory, keyed by `workspaceId::cardId`, never
 * persisted. A surface with no entry gets null, and `presentCard` treats
 * null the same way everywhere.
 */
export type CardFactsEntry = {
  /** What the card was when the page read its result (`cardFactsKey`): a
   *  later run, round or review leaves the entry unread until the page
   *  reads again. */
  key: string;
  outcome: OutcomeFacts | null;
  shipFailure: ShipFailure | null;
};

type CardFactsStore = {
  byCard: Record<string, CardFactsEntry | undefined>;
  setOutcome: (card: KanbanCard, outcome: OutcomeFacts | null) => void;
  setShipFailure: (card: Pick<KanbanCard, "workspaceId" | "id">, press: ShipFailure | null) => void;
  /** (Challenger) The page left the card: what only lasts while the page
   *  watches it goes — the failed press, and a ship under way (nobody tells
   *  the store when that ship ends; a refused ship records nothing on the
   *  card, so the key alone would keep "Shipping" on the Board). */
  leave: (card: Pick<KanbanCard, "workspaceId" | "id">) => void;
};

export function cardFactsId(workspaceId: string, cardId: string): string {
  return `${workspaceId}::${cardId}`;
}

/** What makes a read of the result current: the run, the latest round and
 *  the review on it. */
export function cardFactsKey(
  card: Pick<KanbanCard, "lastRunStatus" | "builder" | "runHistory" | "reviewStatus">,
): string {
  const snapshots = card.builder?.snapshots ?? [];
  const last = snapshots[snapshots.length - 1];
  const review = card.builder?.review;
  return [
    card.lastRunStatus ?? "",
    last?.sha ?? "",
    review ? `${review.status}:${review.snapshotN}:${review.at}` : "",
    card.runHistory?.length ?? 0,
    card.reviewStatus ?? "",
  ].join("|");
}

export const useCardFacts = create<CardFactsStore>((set) => ({
  byCard: {},
  setOutcome: (card, outcome) =>
    set((s) => {
      const id = cardFactsId(card.workspaceId, card.id);
      const key = cardFactsKey(card);
      const cur = s.byCard[id];
      if (cur && cur.key === key && sameOutcome(cur.outcome, outcome)) return s;
      return {
        byCard: {
          ...s.byCard,
          [id]: { key, outcome, shipFailure: cur?.shipFailure ?? null },
        },
      };
    }),
  setShipFailure: (card, press) =>
    set((s) => {
      const id = cardFactsId(card.workspaceId, card.id);
      const cur = s.byCard[id];
      if ((cur?.shipFailure ?? null) === press) return s;
      return {
        byCard: {
          ...s.byCard,
          [id]: { key: cur?.key ?? "", outcome: cur?.outcome ?? null, shipFailure: press },
        },
      };
    }),
  leave: (card) =>
    set((s) => {
      const id = cardFactsId(card.workspaceId, card.id);
      const cur = s.byCard[id];
      if (!cur || (cur.shipFailure === null && !cur.outcome?.shipBusy)) return s;
      return {
        byCard: {
          ...s.byCard,
          [id]: {
            key: cur.key,
            outcome: cur.outcome ? { ...cur.outcome, shipBusy: false } : null,
            shipFailure: null,
          },
        },
      };
    }),
}));

function sameOutcome(a: OutcomeFacts | null, b: OutcomeFacts | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.loading === b.loading &&
    a.filesChanged === b.filesChanged &&
    a.shipBusy === b.shipBusy &&
    a.noRemote === b.noRemote &&
    (a.prOffered ?? false) === (b.prOffered ?? false) &&
    a.reviewFreshness === b.reviewFreshness
  );
}

/** The card's facts as another surface reads them: null when the page has
 *  not read this card as it is now. The ship failure stands until the page
 *  clears it (a new press, another card). */
export function cardFactsFor(
  byCard: CardFactsStore["byCard"],
  card: KanbanCard,
): { outcome: OutcomeFacts | null; shipFailure: ShipFailure | null } {
  const entry = byCard[cardFactsId(card.workspaceId, card.id)];
  if (!entry) return { outcome: null, shipFailure: null };
  return {
    outcome: entry.key === cardFactsKey(card) ? entry.outcome : null,
    shipFailure: entry.shipFailure,
  };
}
