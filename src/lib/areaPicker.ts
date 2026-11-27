// 1.173.0 (B2): the area picker under the workspace's name, what follows it
// (the Board's filter and title, where a new copy starts, the Inbox's and
// Ship batch's area), the Board's line when the repository's areas can't be
// used, and the one notice when Plyloft sees two products.
// Mockup: ~/ply-build/next-1173/mockups/areas.html, scenes 1–2.
//
// Pure: no React, no store, no IPC. "this Mac" is said here as on a Mac; the
// surfaces draw it through `machineWords` (this PC on Windows).

import type { AreaDiscovery, AreasView, DiscoveredProduct, KanbanCard, ResolvedArea } from "../ipc";

/** `areas::IMPLICIT_AREA_ID`: the stamp of a card that belongs to the whole
 *  workspace (a started skill card, `card_area::exempt`) — no area's. */
export const IMPLICIT_AREA_ID = "default";

export const ALL_AREAS = "All areas";
export const EDIT_AREAS = "Edit areas…";
export const SET_UP_AREAS = "Set up areas…";
export const AREA_NOTICE_DONT_ASK = "Don't ask again";
export const AREA_MENU_LABEL = "Area";

/** The areas the picker lists: two or more, and none held. One area (or
 *  none) is the repository as it always was: nothing about areas shows. */
export function pickerAreas(view: AreasView | null | undefined): ResolvedArea[] {
  if (!view || view.held || view.areas.length < 2) return [];
  return view.areas;
}

export function pickerShown(view: AreasView | null | undefined): boolean {
  return pickerAreas(view).length > 0;
}

/**
 * The area the workspace is on: the one chosen in this session (`chosen`,
 * `null` = *All areas*), else this Mac's default. An id the repository no
 * longer lists — the default from before a rename, a choice made before
 * the list changed — is *All areas*, with no error. No picker, no area.
 */
export function currentAreaId(
  view: AreasView | null | undefined,
  chosen: string | null | undefined,
  defaultArea: string | null | undefined,
): string | null {
  const areas = pickerAreas(view);
  const wanted = chosen === undefined ? defaultArea ?? null : chosen;
  return wanted != null && areas.some((a) => a.id === wanted) ? wanted : null;
}

export function areaById(view: AreasView | null | undefined, id: string | null | undefined): ResolvedArea | null {
  if (id == null) return null;
  return pickerAreas(view).find((a) => a.id === id) ?? null;
}

export function areaName(area: Pick<ResolvedArea, "id" | "name">): string {
  return area.name.trim() || area.id;
}

/** C1: the Board's source line on an area, after the repository: "Cards
 *  come from the GitHub issues of owner/repo labeled area:site". */
export function boardLabelWords(label: string): string {
  return `labeled ${label.trim()}`;
}

/** The sidebar row: "Area: Site", "Area: All areas". */
export function pickerLabel(area: ResolvedArea | null): string {
  return `Area: ${area ? areaName(area) : ALL_AREAS}`;
}

/** Each area's line in the menu: where its cards go. */
export function cardsGoTo(area: Pick<ResolvedArea, "branch">): string {
  return `cards go to ${area.branch}`;
}

/** "Make Site this Mac's default", "Make All areas this Mac's default". */
export function makeDefaultLabel(area: ResolvedArea | null): string {
  return `Make ${area ? areaName(area) : ALL_AREAS} this Mac's default`;
}

/** The menu's *Make … this Mac's default*: shown checked while the current
 *  choice is the default (pressing it then goes back to All areas), hidden
 *  on All areas while that is already the default. */
export function makeDefaultItem(
  current: ResolvedArea | null,
  defaultArea: string | null | undefined,
  view: AreasView | null | undefined,
): { label: string; checked: boolean; next: string | null } | null {
  const def = areaById(view, defaultArea)?.id ?? null;
  const currentId = current?.id ?? null;
  if (currentId === null && def === null) return null;
  const checked = currentId === def;
  return { label: makeDefaultLabel(current), checked, next: checked ? null : currentId };
}

/** The Board's title: "Board · Site" on an area, "Board" on All areas. */
export function boardTitle(area: ResolvedArea | null): string {
  return area ? `Board · ${areaName(area)}` : "Board";
}

/** A card's area (`KanbanCard.area`, B3); `null` for none — a card from
 *  before areas, or one stamped as the whole workspace's ("default",
 *  `card_area::inherited_area`). */
export function cardAreaOf(card: Pick<KanbanCard, "area">): string | null {
  const area = card.area ?? null;
  return area === IMPLICIT_AREA_ID ? null : area;
}

/**
 * The Board on an area shows that area's cards only. A card with no area —
 * from before areas, from GitHub without a label, or stamped as the whole
 * workspace's ("default") — is under *All areas* only.
 */
export function filterByArea<T extends Pick<KanbanCard, "area">>(cards: readonly T[], areaId: string | null): T[] {
  if (areaId == null) return [...cards];
  return cards.filter((c) => cardAreaOf(c) === areaId);
}

/** F1 (Challenger 4): with an area picked the Board's Needs you counts that
 *  area's cards; the Inbox counts every area's. The column says the rest —
 *  "· 2 in other areas" — so the two numbers add up. Null when none. */
export function otherAreasWords(n: number): string | null {
  return n > 0 ? `· ${n} in other areas` : null;
}

/** The cards that need the person outside the picked area (none with no
 *  area picked). */
export function needsYouElsewhere<T extends Pick<KanbanCard, "area">>(
  cards: readonly T[],
  areaId: string | null,
  column: (card: T) => string | null,
): number {
  if (areaId == null) return 0;
  return cards.filter((c) => cardAreaOf(c) !== areaId && column(c) === "needs-you").length;
}

/** Where a new copy starts: the current area's branch; with one area, its
 *  branch; otherwise `null` (the workspace's target). */
export function copyBranch(view: AreasView | null | undefined, areaId: string | null): string | null {
  const area = areaById(view, areaId);
  if (area) return area.branch;
  if (view && !view.held && view.areas.length === 1) return view.areas[0].branch;
  return null;
}

/** "lyra · Site" for a card of an area, where the picker shows; else the
 *  workspace's name alone. */
export function withAreaName(
  workspaceName: string,
  view: AreasView | null | undefined,
  areaId: string | null | undefined,
): string {
  const area = areaById(view, areaId);
  return area ? `${workspaceName} · ${areaName(area)}` : workspaceName;
}

function sentence(problem: string): string {
  return problem.trim().replace(/[.\s]+$/, "");
}

/**
 * The Board's line when the repository's areas can't be used (B1's
 * `problem`): held — this Mac has no good list, so no card can start, ship
 * or release — or kept, using the last good one.
 */
export function areaProblemLine(view: AreasView | null | undefined): { text: string; held: boolean } | null {
  if (!view?.problem) return null;
  const problem = sentence(view.problem);
  if (view.held) {
    return {
      held: true,
      text: `This repository's areas can't be used: ${problem}. Fix them in Settings › Project › Areas.`,
    };
  }
  return {
    held: false,
    text: `This repository's new areas can't be used: ${problem}. This Mac keeps using the last good ones. Fix them in Settings › Project › Areas.`,
  };
}

/** The discovery notice shows once: two products at the root and beside it,
 *  a repository with no areas (and none broken), not answered *Don't ask
 *  again* — and only where *Set up areas…* can save them: with write access
 *  to a shared setup, or (1.174.0, C10, D6) on this Mac where nothing is
 *  shared, until the setup is. */
export function discoveryWanted(
  view: AreasView | null | undefined,
  dismissed: boolean | undefined,
): boolean {
  return Boolean(
    view &&
      !view.readOnly &&
      view.areas.length === 0 &&
      view.defined.length === 0 &&
      !view.held &&
      !view.problem &&
      !dismissed,
  );
}

export function discoveryShown(
  discovery: AreaDiscovery | null | undefined,
  view: AreasView | null | undefined,
  dismissed: boolean | undefined,
): boolean {
  return Boolean(discovery?.notice && discovery.products.length >= 2 && discoveryWanted(view, dismissed));
}

const COUNT = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** "the app" (bold in the notice) and "(the root)" for one product. */
function productParts(p: DiscoveredProduct): { kind: string; where: string } {
  const kind = p.kind === "site" ? "site" : "app";
  if (p.path === "") return { kind: `the ${kind}`, where: "(the root)" };
  return { kind: `${kind === "app" ? "an" : "a"} ${kind}`, where: `(${p.path}/)` };
}

/** A piece of the notice's first line; `strong` ones are the kinds. */
export type NoticePart = { text: string; strong?: boolean };

/** Scene 1's first line in pieces: "This repository seems to hold two
 *  products: **the app** (the root) and **a site** (lyrappc-astro/)." */
export function discoveryTitleParts(discovery: AreaDiscovery): NoticePart[] {
  const n = discovery.products.length;
  const parts: NoticePart[] = [{ text: `This repository seems to hold ${COUNT[n] ?? String(n)} products: ` }];
  discovery.products.forEach((p, i) => {
    if (i > 0) parts.push({ text: i === n - 1 ? " and " : ", " });
    const { kind, where } = productParts(p);
    parts.push({ text: kind, strong: true }, { text: ` ${where}` });
  });
  parts.push({ text: "." });
  return parts;
}


/** Scene 1: "This repository seems to hold two products: the app (the root)
 *  and a site (lyrappc-astro/). Areas keep them apart: …". */
export function discoveryWords(discovery: AreaDiscovery): string {
  return discoveryLines(discovery).join(" ");
}

/** The same in two lines: what Plyloft saw (the notice's title), then what
 *  areas do. */
export function discoveryLines(discovery: AreaDiscovery): [string, string] {
  return [
    discoveryTitleParts(discovery)
      .map((p) => p.text)
      .join(""),
    "Areas keep them apart: each gets its own cards, where its changes go, its versions and its releases.",
  ];
}

/** A filtered Board with nothing in its area. */
export function emptyAreaWords(area: ResolvedArea): string {
  return `No cards in ${areaName(area)}.`;
}
