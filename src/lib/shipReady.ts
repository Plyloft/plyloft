/**
 * QoL 1.168 C7: the one answer to "which cards would Ship batch take", for
 * every "Ship N" — the sidebar's "Ship N in a batch", ⌘K, a Board's header
 * and the sheet's own list — so they never disagree ("Ship 1 in a batch" →
 * "Ship 0 cards" was a Board not loaded this session).
 *
 * The source is the backend's list (`ship_pending_cards`: every workspace on
 * disk, with its git check that the card has something to ship). A Board
 * loaded on this Mac narrows its own workspace's ids at once to the cards
 * that are still eligible there (`isShipBatchEligible`, the same rule), so a
 * card shipped or moved a moment ago drops out before the next refresh. With
 * no list yet, the loaded Boards' eligible cards stand in.
 *
 * Pure, so node runs it (`shipReady.test.ts`).
 */

import type { KanbanCard, PendingShipCards } from "../ipc";

export type ShipReady = Record<string, string[]>;

export function shipReady(
  pending: PendingShipCards[] | null,
  boards: Record<string, { cards: KanbanCard[] } | undefined>,
  eligible: (card: KanbanCard) => boolean,
): ShipReady {
  const out: ShipReady = {};
  if (pending === null) {
    for (const [wsId, board] of Object.entries(boards)) {
      const ids = (board?.cards ?? []).filter(eligible).map((c) => c.id);
      if (ids.length > 0) out[wsId] = ids;
    }
    return out;
  }
  for (const p of pending) {
    const board = boards[p.workspaceId];
    const ids = board
      ? p.cardIds.filter((id) => {
          const card = board.cards.find((c) => c.id === id);
          return card !== undefined && eligible(card);
        })
      : [...p.cardIds];
    if (ids.length > 0) out[p.workspaceId] = ids;
  }
  return out;
}

export function shipReadyTotal(ready: ShipReady): number {
  let n = 0;
  for (const ids of Object.values(ready)) n += ids.length;
  return n;
}

/** A signature of the loaded Boards' eligible cards: when it changes, the
 *  backend's list is read again (a card that just became ready). */
export function eligibleSignature(
  boards: Record<string, { cards: KanbanCard[] } | undefined>,
  eligible: (card: KanbanCard) => boolean,
): string {
  const parts: string[] = [];
  for (const wsId of Object.keys(boards).sort()) {
    const ids = (boards[wsId]?.cards ?? []).filter(eligible).map((c) => c.id).sort();
    if (ids.length > 0) parts.push(`${wsId}:${ids.join(",")}`);
  }
  return parts.join("|");
}

/** 1.173.0 (F2): Ship batch's title, and each area's choice: "Release Site
 *  (3 cards)", or "Release 3 cards" where the batch is the whole project. */
export function releaseTitle(name: string | null, n: number): string {
  const cards = `${n} card${n === 1 ? "" : "s"}`;
  return name ? `Release ${name} (${cards})` : `Release ${cards}`;
}

/** 1.173.0 (B4): one area Ship batch can release, by its key ("" is the
 *  whole repository's) — `label` is the choice's words. */
export interface BatchAreaChoice {
  key: string;
  area: string | null;
  name: string;
  cardIds: string[];
  label: string;
  /** Where it goes and how it is tagged. */
  hint: string;
}

/** 1.173.0 (B4): a batch is one area. The backend's groups
 *  (`PendingShipCards.areas`) narrowed to the cards still ready: the areas
 *  that can be released, and the cards no batch takes until their area is
 *  fixed (with why). Without areas, no choice — the batch is as before. */
export function batchAreas(
  entry: Pick<PendingShipCards, "areas"> | undefined,
  readyIds: string[],
): { choices: BatchAreaChoice[]; refused: Array<{ cardId: string; why: string }> } {
  const ready = new Set(readyIds);
  const choices: BatchAreaChoice[] = [];
  const refused: Array<{ cardId: string; why: string }> = [];
  for (const group of entry?.areas ?? []) {
    const cardIds = group.cardIds.filter((id) => ready.has(id));
    if (cardIds.length === 0) continue;
    if (group.refusal !== null) {
      for (const cardId of cardIds) refused.push({ cardId, why: group.refusal });
      continue;
    }
    choices.push({
      key: group.area ?? "",
      area: group.area,
      name: group.name,
      cardIds,
      label: releaseTitle(group.name, cardIds.length),
      hint: `Goes to ${group.branch}, tagged ${group.tagPrefix ?? ""}vX.Y.Z.`,
    });
  }
  return { choices, refused };
}
