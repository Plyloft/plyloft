/**
 * 1.173.0 (F2): Release… from the project, not only from a Done card — on
 * each block of *How this goes live* and in the Board's ⋯. 1.174.0 (DR3):
 * every press opens the one Release sheet; the ready cards are B4's groups
 * (`batchAreas` over `ship_pending_cards`) until the area's scope is read.
 *
 * Pure: no React, no IPC.
 */
import type { KanbanCard, PendingShipCards, ReleaseScope } from "../ipc.ts";
import { batchAreas, releaseTitle } from "./shipReady.ts";
import { cardAreaOf } from "./areaPicker.ts";
import { nothingNewWords, onlyAreaWithSomething, scopeHasSomething } from "./releaseSheet.ts";

export { releaseTitle };

/** What one Release… would release: an area's ready cards (`areaId`), or the
 *  whole project's (`null`). `off` says why it can't, in plain words. */
export interface ReleaseTarget {
  areaId: string | null;
  name: string | null;
  cardIds: string[];
  off: string | null;
}

/** What every Release… reads for one workspace. */
export interface ReleaseInputs {
  /** B4's groups (`ship_pending_cards`); absent without areas. */
  entry: Pick<PendingShipCards, "areas"> | undefined;
  /** The cards a batch would take (`useShipReady`). */
  readyIds: readonly string[];
  /** The workspace's Board cards, when loaded: whose area a refused card
   *  is (the backend's refused group carries no area), and a card only its
   *  own page can release (an approved Builder card with its session open). */
  cards?: readonly KanbanCard[];
  /** The backend's list isn't read yet: off, without a reason that may be
   *  untrue. */
  reading?: boolean;
  /** The backend's list couldn't be read: the Board's own ready cards
   *  stand in (`readyIds`), and with none, Release… says so. */
  failed?: boolean;
}

/** "Release Site…", or "Release…" on a project without areas. */
export function releaseLabel(name: string | null): string {
  return name ? `Release ${name}…` : "Release…";
}

/** The off button's hint. */
export function nothingToRelease(name: string | null): string {
  return name
    ? `Nothing to release in ${name} yet: no card of ${name} is ready to ship.`
    : "Nothing to release yet: no card is ready to ship.";
}

/** The off button's hint while the ready cards are still being read. */
export const RELEASE_READING = "Reading…";
/** The off button's hint when the ready cards couldn't be read. */
export const RELEASE_UNREAD = "Plyloft couldn't read which cards are ready.";

/**
 * One area's Release… (`area` null: the whole project's). 1.174.0 (DR3,
 * D1(b)): with the area's scope read (`release_scope`), what it would
 * release is everything on its branch since its last tag plus its ready
 * cards — `cardIds` are the ready ones (none is fine), off only with nothing
 * new and nothing ready, or a refused area. Before the scope is read, B4's
 * groups: the ready cards for that area, narrowed to the ones still ready;
 * without areas, every ready card. A group B4 refuses (held areas, a card
 * with no area, an area with no version file of its own) is never released:
 * when that is all there is, its reason is the hint — for an area, only the
 * refusal of that area's own cards.
 */
export function releaseTarget(
  inputs: ReleaseInputs,
  area: { id: string; name: string } | null,
  scope?: ReleaseScope,
  now: number = Date.now(),
): ReleaseTarget {
  const { entry, readyIds, cards: board, reading, failed } = inputs;
  const name = area ? area.name.trim() || area.id : null;
  const areaId = area?.id ?? null;
  if (scope) {
    const cardIds = [...scope.readyCardIds];
    if (scope.refusal) return { areaId, name, cardIds: [], off: scope.refusal };
    if (scopeHasSomething(scope)) return { areaId, name, cardIds, off: null };
    return { areaId, name, cardIds, off: nothingNewWords(scope, name, now) };
  }
  if (reading) return { areaId, name, cardIds: [], off: RELEASE_READING };
  const { choices, refused } = batchAreas(entry, [...readyIds]);
  const cardIds = area
    ? (choices.find((c) => c.area === area.id)?.cardIds ?? [])
    : entry?.areas
      ? choices.flatMap((c) => c.cardIds)
      : [...readyIds];
  if (cardIds.length > 0) return { areaId, name, cardIds, off: null };
  const areaOf = (id: string) => {
    const card = board?.find((c) => c.id === id);
    return card ? cardAreaOf(card) : undefined;
  };
  const ownRefusal = area
    ? refused.find((r) => areaOf(r.cardId) === area.id)
    : choices.length === 0
      ? refused[0]
      : undefined;
  if (ownRefusal) return { areaId, name, cardIds: [], off: ownRefusal.why };
  return { areaId, name, cardIds: [], off: failed ? RELEASE_UNREAD : nothingToRelease(name) };
}

/**
 * 1.174.1 P3 (T3): on All areas of a project with two or more areas, the
 * ready cards the header's (and the sidebar's) "Release N cards…" opens the
 * Release sheet on — one area's, as a release is of one area. With the
 * scopes read (`release_scopes`), they only choose the area, as the sheet
 * does: the only area with something (`onlyAreaWithSomething`; none when it
 * is refused), else the first area it lists, not refused, with ready cards.
 * Before they are read, the first area with ready cards. The cards are
 * always today's ready ones of that area — B4's group (`batchAreas`), else
 * the Board's ready cards of that area — so a card ready after the read
 * counts. A card with no area, and a refused group, is no area's release.
 */
export function allAreasReleaseCards(
  inputs: ReleaseInputs,
  areaOrder: readonly string[],
  scopes: readonly ReleaseScope[] | null,
): string[] {
  const { entry, readyIds, cards: board } = inputs;
  const choices = entry?.areas ? batchAreas(entry, [...readyIds]).choices : null;
  const areaOf = new Map((board ?? []).map((c) => [c.id, cardAreaOf(c)]));
  const readyIn = (area: string | null): string[] =>
    area === null
      ? []
      : choices
        ? [...(choices.find((c) => c.area === area)?.cardIds ?? [])]
        : readyIds.filter((id) => areaOf.get(id) === area);
  if (scopes && scopes.length > 0) {
    const only = scopes.length === 1 ? scopes[0] : onlyAreaWithSomething(scopes);
    if (only) return only.refusal === null ? readyIn(only.area) : [];
    for (const sc of scopes) {
      if (sc.refusal !== null) continue;
      const ids = readyIn(sc.area);
      if (ids.length > 0) return ids;
    }
    return [];
  }
  if (choices) return [...(choices[0]?.cardIds ?? [])];
  for (const area of areaOrder) {
    const ids = readyIn(area);
    if (ids.length > 0) return ids;
  }
  return [];
}
