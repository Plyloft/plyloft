// 1.173.0 (B2): the area picker's rules and words. Run with:
//
//     node --experimental-strip-types src/lib/areaPicker.test.ts

import assert from "node:assert/strict";
import type { AreaDiscovery, AreasView, ResolvedArea } from "../ipc";
import {
  areaProblemLine,
  boardLabelWords,
  boardTitle,
  cardsGoTo,
  copyBranch,
  currentAreaId,
  discoveryShown,
  discoveryTitleParts,
  discoveryWanted,
  discoveryWords,
  cardAreaOf,
  filterByArea,
  makeDefaultItem,
  needsYouElsewhere,
  otherAreasWords,
  pickerAreas,
  pickerLabel,
  pickerShown,
  withAreaName,
} from "./areaPicker.ts";

function area(id: string, name: string, branch: string, first = false): ResolvedArea {
  return {
    id,
    name,
    path: id === "app" ? "" : `${id}/`,
    root: id === "app",
    first,
    targetBranch: branch === "staging" ? null : branch,
    branch,
    versionFiles: null,
    tagPrefix: first ? "" : `${id}-`,
    label: `area:${id}`,
    lookAt: null,
  };
}

const APP = area("app", "App", "staging", true);
const SITE = area("site", "Site", "main");

function view(areas: ResolvedArea[], extra: Partial<AreasView> = {}): AreasView {
  return {
    shared: true,
    readOnly: false,
    defined: areas.map((a) => ({ id: a.id, name: a.name, path: a.path })),
    areas,
    workspaceBranch: "staging",
    check: { errors: [], warnings: [] },
    problem: null,
    held: false,
    ...extra,
  };
}

const TWO = view([APP, SITE]);

// ── Visibility: two areas or more, never held ─────────────────────────────
assert.equal(pickerShown(null), false, "not read yet");
assert.equal(pickerShown(view([])), false, "no areas: the repository as always");
assert.equal(pickerShown(view([APP])), false, "one area: nothing about areas");
assert.equal(pickerShown(TWO), true);
assert.equal(pickerShown(view([APP, SITE], { held: true, problem: "x" })), false, "held: no picker");
assert.deepEqual(pickerAreas(view([APP, SITE], { problem: "bad id", held: false })), [APP, SITE], "kept: the last good list");

// ── The current area: the session's choice, else this Mac's default ─────
assert.equal(currentAreaId(TWO, undefined, "site"), "site", "starts at the default");
assert.equal(currentAreaId(TWO, undefined, null), null, "no default: All areas");
assert.equal(currentAreaId(TWO, null, "site"), null, "All areas chosen beats the default");
assert.equal(currentAreaId(TWO, "app", "site"), "app");
assert.equal(currentAreaId(TWO, undefined, "docs"), null, "a default that no longer exists: All areas, no error");
assert.equal(currentAreaId(TWO, "docs", null), null, "a choice that no longer exists: All areas");
assert.equal(currentAreaId(view([APP]), "app", "app"), null, "no picker, no area");
assert.equal(currentAreaId(view([APP, SITE], { held: true }), "site", "site"), null);

// ── The menu's words ──────────────────────────────────────────────────────
assert.equal(pickerLabel(SITE), "Area: Site");
assert.equal(pickerLabel(null), "Area: All areas");
assert.equal(cardsGoTo(APP), "cards go to staging");
assert.equal(cardsGoTo(SITE), "cards go to main");
assert.equal(pickerLabel({ ...SITE, name: " " }), "Area: site", "an empty name reads as the id");
assert.deepEqual(makeDefaultItem(SITE, "site", TWO), { label: "Make Site this Mac's default", checked: true, next: null });
assert.deepEqual(makeDefaultItem(SITE, null, TWO), { label: "Make Site this Mac's default", checked: false, next: "site" });
assert.deepEqual(makeDefaultItem(null, "site", TWO), { label: "Make All areas this Mac's default", checked: false, next: null });
assert.equal(makeDefaultItem(null, null, TWO), null, "All areas is already the default");
assert.equal(makeDefaultItem(null, "gone", TWO), null, "a default that is gone is All areas");

// ── What follows the picker ───────────────────────────────────────────────
assert.equal(boardTitle(SITE), "Board · Site");
assert.equal(boardTitle(null), "Board");

type Card = { id: string; area?: string | null };
const before: Card[] = [{ id: "a" }, { id: "b" }];
assert.deepEqual(filterByArea(before, "site"), [], "cards from before areas: under All areas only");
assert.deepEqual(filterByArea(before, null), before);
const cards: Card[] = [
  { id: "a", area: "site" },
  { id: "b", area: "app" },
  { id: "c", area: null },
  { id: "d" },
  { id: "e", area: "default" },
];
assert.deepEqual(filterByArea(cards, null), cards, "All areas: every card");
assert.deepEqual(filterByArea(cards, "site").map((c) => c.id), ["a"], "a card with no area stays in All areas");
assert.deepEqual(filterByArea(cards, "default"), [], "the whole workspace's stamp is no area");
assert.equal(cardAreaOf({ area: "default" }), null, "a started skill card's stamp reads as none");
assert.equal(cardAreaOf({}), null);
assert.equal(cardAreaOf({ area: "site" }), "site");

assert.equal(copyBranch(TWO, "site"), "main", "a copy starts from its area's branch");
assert.equal(copyBranch(TWO, null), null, "All areas: the workspace's target");
assert.equal(copyBranch(view([SITE]), null), "main", "one area: its branch");
assert.equal(copyBranch(view([APP, SITE], { held: true }), "site"), null);
assert.equal(copyBranch(null, null), null);

assert.equal(withAreaName("lyra", TWO, "site"), "lyra · Site");
assert.equal(withAreaName("lyra", TWO, null), "lyra");
assert.equal(withAreaName("lyra", TWO, "gone"), "lyra");
assert.equal(withAreaName("lyra", view([SITE]), "site"), "lyra", "no picker: the workspace alone");

// ── Held and kept ─────────────────────────────────────────────────────────
assert.equal(areaProblemLine(TWO), null);
assert.deepEqual(areaProblemLine(view([], { held: true, problem: "Two areas use the folder site/." })), {
  held: true,
  text: "This repository's areas can't be used: Two areas use the folder site/. Fix them in Settings › Project › Areas.",
});
assert.deepEqual(areaProblemLine(view([APP, SITE], { problem: "“All” is a reserved name" })), {
  held: false,
  text: "This repository's new areas can't be used: “All” is a reserved name. This Mac keeps using the last good ones. Fix them in Settings › Project › Areas.",
});

// ── The discovery notice ──────────────────────────────────────────────────
const LYRA: AreaDiscovery = {
  products: [
    { path: "", kind: "app" },
    { path: "lyrappc-astro", kind: "site" },
  ],
  suggestion: [
    { id: "app", name: "App", path: "" },
    { id: "site", name: "Site", path: "lyrappc-astro" },
  ],
  notice: true,
};
assert.equal(
  discoveryWords(LYRA),
  "This repository seems to hold two products: the app (the root) and a site (lyrappc-astro/). " +
    "Areas keep them apart: each gets its own cards, where its changes go, its versions and its releases.",
);
assert.equal(
  discoveryWords({ ...LYRA, products: [...LYRA.products, { path: "services/api", kind: "app" }] }),
  "This repository seems to hold three products: the app (the root), a site (lyrappc-astro/) and an app (services/api/). " +
    "Areas keep them apart: each gets its own cards, where its changes go, its versions and its releases.",
);
const none = view([]);
assert.equal(discoveryShown(LYRA, none, false), true);
assert.equal(discoveryShown(LYRA, none, true), false, "Not now: for good");
assert.equal(discoveryShown(LYRA, TWO, false), false, "the repository has areas");
assert.equal(discoveryShown(LYRA, view([APP]), false), false, "even one area");
assert.equal(discoveryShown(LYRA, view([], { held: true, problem: "x" }), false), false, "held: the problem line instead");
assert.equal(discoveryShown({ ...LYRA, notice: false }, none, false), false, "no product at the root");
assert.equal(discoveryShown(null, none, false), false, "one product");
assert.equal(discoveryShown(LYRA, null, false), false, "areas not read yet");
// 1.174.0 (C10, D6): no shared setup — Set up areas… saves on this Mac.
assert.equal(discoveryShown(LYRA, view([], { shared: false, keptHere: false }), false), true, "no shared setup: kept on this Mac");
assert.equal(discoveryShown(LYRA, view([], { readOnly: true }), false), false, "read-only: can't save either");
assert.equal(discoveryWanted(view([], { shared: false }), false), true, "and looked for");
assert.equal(discoveryWanted(view([APP], { shared: false, keptHere: true }), false), false, "areas kept here already");
assert.equal(discoveryWanted(none, false), true);
assert.deepEqual(discoveryTitleParts(LYRA), [
  { text: "This repository seems to hold two products: " },
  { text: "the app", strong: true },
  { text: " (the root)" },
  { text: " and " },
  { text: "a site", strong: true },
  { text: " (lyrappc-astro/)" },
  { text: "." },
]);

// C1: the Board's source line on an area names its issue label.
assert.equal(boardLabelWords("area:site"), "labeled area:site");
assert.equal(boardLabelWords(" website "), "labeled website");

// F1 (Challenger 4): the Board's Needs you says what the other areas hold.
{
  const cards = [{ id: "a", area: "site" }, { id: "b", area: "app" }, { id: "c", area: "app" }, { id: "d", area: null }];
  const column = (c: { id: string }) => (c.id === "d" ? "working" : "needs-you");
  assert.equal(needsYouElsewhere(cards, "site", column), 2);
  assert.equal(needsYouElsewhere(cards, null, column), 0, "All areas: nothing elsewhere");
  assert.equal(otherAreasWords(2), "· 2 in other areas");
  assert.equal(otherAreasWords(0), null);
}

console.log("areaPicker: ok");
