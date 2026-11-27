/**
 * UX P-A (Windows walk 1): a Ship refused before anything ran is a Ship that
 * didn't go through, on every surface.
 *
 * The typed refusals Ship meets — GH #88's `Local <branch> can't be updated`
 * (`LocalBranchRefused`, drawn on the Ship step of the cards pressed: one
 * card, or a batch's every card) and GH #222's release committed here and not
 * published — are kept in `errorBlockStore`, not in the card page's own
 * state: the press may come from the card page, the Ship batch (the Board,
 * the List, the Inbox's Ship it, the palette), the release dialog or the
 * review panel's Merge. They were never the page's "last failed Ship press",
 * so the Board, the List, the Inbox and Now all said "Ready to ship" over a
 * refusal only a toast and a closed Shipping section knew about.
 *
 * Read here instead, they last exactly as long as their block does: a Trash
 * or Sync that clears the way, or the next Ship that gets past the
 * fast-forward check, takes the block down and the card says "Ready to ship"
 * again. A Sync's own refusal (no Ship pressed) is not a failed press.
 *
 * Pure: the store's shape, structurally, so the pure tests run it under node.
 */
import type { PrReleaseStep } from "../ipc.ts";
import type { ShipFailure } from "./cardLifecycle.ts";

/** The part of `errorBlockStore`'s `byWorkspace` this reads. */
export type ShipRefusalBlocks = Record<
  string,
  | {
      localBranch: unknown | null;
      shipStep: { cardIds: readonly string[] } | null;
      unpublished: UnpublishedCards | null;
    }
  | undefined
>;

/** The part of a pending release this reads (`PendingReleaseView`). */
export interface UnpublishedCards {
  cardIds: readonly string[];
  tag?: string;
  problem?: string | null;
  pr?: {
    step: PrReleaseStep;
    waiting?: string | null;
    number?: number | null;
    url?: string | null;
    plyloftMerges?: boolean;
    mergeOnItsWay?: boolean;
  } | null;
}

/** 1.170 walk: a release through a pull request on its way, as its cards
 *  say it (`cardPresentation.ts`'s "releasing" rule). */
export interface ReleasingFacts {
  tag: string;
  step: PrReleaseStep;
  number: number | null;
  url: string | null;
  waiting: string | null;
  /** 1.172.0 B3: who merges it — Plyloft itself, only while it's open
   *  (`ReleasePr.plyloftMerges`), or GitHub, its merge asked for
   *  (`mergeOnItsWay`). Absent: neither said yet. */
  plyloftMerges?: boolean;
  mergeOnItsWay?: boolean;
}

/** 1.170 walk (Mac and Windows): a release through a pull request whose
 *  record has no problem is a state of its cards for every step, from the
 *  press to the board saying Shipped — never a Ship that didn't go through.
 *  Only its problem (or a release not through a pull request, not
 *  published) stops the card's Ship. */
function onItsWay(u: UnpublishedCards): boolean {
  return u.pr != null && !u.problem;
}

/** The cards a pending release stopped (none while it is on its way). */
export function unpublishedStopped(u: UnpublishedCards | null | undefined): readonly string[] {
  if (!u || onItsWay(u)) return [];
  return u.cardIds;
}

/** What a release on its way is called when its record has no tag yet —
 *  words, never a version (`deliveryStage.ts::releasePath` leaves it out). */
export const RELEASE_TAG_UNKNOWN = "The release";

/** The release on its way this card is in, if any. */
export function releasingOf(u: UnpublishedCards | null | undefined, cardId: string): ReleasingFacts | null {
  if (!u || !onItsWay(u) || !u.cardIds.includes(cardId)) return null;
  const pr = u.pr!;
  return {
    tag: u.tag ?? RELEASE_TAG_UNKNOWN,
    step: pr.step,
    number: pr.number ?? null,
    url: pr.url ?? null,
    waiting: pr.waiting ?? null,
    ...(pr.plyloftMerges ? { plyloftMerges: true } : {}),
    ...(pr.mergeOnItsWay ? { mergeOnItsWay: true } : {}),
  };
}

/** Every card's release on its way, as one stable string (a selector that
 *  changes only when one does): `ws::card` → its facts. */
export function releasingKey(byWorkspace: ShipRefusalBlocks): string {
  const out: Array<[string, ReleasingFacts]> = [];
  for (const [ws, blocks] of Object.entries(byWorkspace)) {
    const u = blocks?.unpublished;
    if (!u) continue;
    for (const id of u.cardIds) {
      const facts = releasingOf(u, id);
      if (facts) out.push([`${ws}::${id}`, facts]);
    }
  }
  out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return out.length ? JSON.stringify(out) : "";
}

export function releasingMap(key: string): ReadonlyMap<string, ReleasingFacts> {
  return new Map(key ? (JSON.parse(key) as Array<[string, ReleasingFacts]>) : []);
}

/** `ws::card` of every card a typed refusal stopped, as one stable string (a
 *  selector that changes only when the set does). */
export function shipRefusedKey(byWorkspace: ShipRefusalBlocks): string {
  const out = new Set<string>();
  for (const [ws, blocks] of Object.entries(byWorkspace)) {
    if (!blocks) continue;
    if (blocks.localBranch != null && blocks.shipStep) {
      for (const id of blocks.shipStep.cardIds) out.add(`${ws}::${id}`);
    }
    for (const id of unpublishedStopped(blocks.unpublished)) out.add(`${ws}::${id}`);
  }
  return [...out].sort().join("\n");
}

export function shipRefusedSet(key: string): ReadonlySet<string> {
  return new Set(key ? key.split("\n") : []);
}

/** Whether a typed refusal stopped this card's Ship. */
export function shipRefusedFor(byWorkspace: ShipRefusalBlocks, workspaceId: string, cardId: string): boolean {
  const blocks = byWorkspace[workspaceId];
  if (!blocks) return false;
  if (blocks.localBranch != null && blocks.shipStep?.cardIds.includes(cardId)) return true;
  return unpublishedStopped(blocks.unpublished).includes(cardId);
}

/** The card's failed press: the page's own, else a typed refusal's — which
 *  stops a merge (`Ship it`); a pull request never reaches the check. */
export function shipFailureOf(own: ShipFailure | null, refused: boolean): ShipFailure | null {
  return own ?? (refused ? "ship-it" : null);
}
