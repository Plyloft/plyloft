// 1.173.0 (F2): Release… from the project — which cards each Release… takes,
// and its words.
//     node --experimental-strip-types src/lib/projectRelease.test.ts
import assert from "node:assert/strict";
import type { KanbanCard, PendingShipCards, ReleaseScope } from "../ipc.ts";
import {
  allAreasReleaseCards,
  nothingToRelease,
  RELEASE_READING,
  RELEASE_UNREAD,
  releaseLabel,
  releaseTarget,
  releaseTitle,
} from "./projectRelease.ts";

const site = { id: "site", name: "Site" };
const app = { id: "app", name: "App" };
const entry: Pick<PendingShipCards, "areas"> = {
  areas: [
    { area: "site", name: "Site", cardIds: ["s1", "s2"], refusal: null, branch: "main", tagPrefix: "site-" },
    { area: "app", name: "App", cardIds: ["a1"], refusal: null, branch: "staging", tagPrefix: "" },
    { area: null, name: "", cardIds: ["n1"], refusal: "Which area is this? Choose one on the card first.", branch: "", tagPrefix: "" },
  ],
};
const ready = ["s1", "s2", "a1", "n1"];

// The words.
assert.equal(releaseLabel("Site"), "Release Site…");
assert.equal(releaseLabel(null), "Release…");
assert.equal(nothingToRelease("Site"), "Nothing to release in Site yet: no card of Site is ready to ship.");
assert.equal(nothingToRelease(null), "Nothing to release yet: no card is ready to ship.");
assert.equal(releaseTitle("Site", 3), "Release Site (3 cards)");
assert.equal(releaseTitle("App", 1), "Release App (1 card)");
assert.equal(releaseTitle(null, 2), "Release 2 cards");

// One area's: its group, narrowed to the cards still ready.
assert.deepEqual(releaseTarget({ entry: entry, readyIds: ready }, site), { areaId: "site", name: "Site", cardIds: ["s1", "s2"], off: null });
assert.deepEqual(releaseTarget({ entry: entry, readyIds: ["s2", "a1"] }, site).cardIds, ["s2"]);
// Nothing ready in that area: off, with the words.
const none = releaseTarget({ entry: entry, readyIds: ["a1"] }, site);
assert.deepEqual(none.cardIds, []);
assert.equal(none.off, "Nothing to release in Site yet: no card of Site is ready to ship.");
// A blank name is the id.
assert.equal(releaseTarget({ entry: entry, readyIds: ready }, { id: "site", name: " " }).name, "site");

// Without areas: every ready card, the project's words.
const plain = releaseTarget({ entry: undefined, readyIds: ["c1", "c2"] }, null);
assert.deepEqual(plain, { areaId: null, name: null, cardIds: ["c1", "c2"], off: null });
assert.equal(releaseTarget({ entry: undefined, readyIds: [] }, null).off, "Nothing to release yet: no card is ready to ship.");
// With groups but no area asked: the released groups only, never a refused one.
assert.deepEqual(releaseTarget({ entry: entry, readyIds: ready }, null).cardIds, ["s1", "s2", "a1"]);

// Held areas: every group refused — the reason is the hint, never "nothing to release".
const held: Pick<PendingShipCards, "areas"> = {
  areas: [{ area: null, name: "", cardIds: ["s1"], refusal: "No card can ship while the areas can't be used.", branch: "", tagPrefix: "" }],
};
assert.equal(releaseTarget({ entry: held, readyIds: ["s1"] }, null).off, "No card can ship while the areas can't be used.");

// F2 round 1: a refused card is its own area's reason, never another's.
const card = (id: string, over: Partial<KanbanCard> = {}): KanbanCard =>
  ({
    id,
    workspaceId: "ws",
    title: id,
    columnId: "complete",
    shipStatus: "unshipped",
    verifyStatus: "passed",
    archived: false,
    ...over,
  }) as KanbanCard;
const noVersionFile = "Site has no version file of its own. Add one in Settings › Project › Areas.";
const siteRefused: Pick<PendingShipCards, "areas"> = {
  areas: [
    { area: null, name: "", cardIds: ["s1"], refusal: noVersionFile, branch: "", tagPrefix: "" },
    { area: "app", name: "App", cardIds: ["a1"], refusal: null, branch: "staging", tagPrefix: "" },
  ],
};
const boardCards = [card("s1", { area: "site" }), card("a1", { area: "app" })];
const refusedInputs = { entry: siteRefused, readyIds: ["s1", "a1"], cards: boardCards };
assert.equal(releaseTarget(refusedInputs, site).off, noVersionFile);
assert.deepEqual(releaseTarget(refusedInputs, app).cardIds, ["a1"]);
// Another area's refusal is never this area's reason.
const appRefused: Pick<PendingShipCards, "areas"> = {
  areas: [{ area: null, name: "", cardIds: ["a1"], refusal: "App is held.", branch: "", tagPrefix: "" }],
};
assert.equal(
  releaseTarget({ entry: appRefused, readyIds: ["a1"], cards: [boardCards[1]] }, site).off,
  nothingToRelease("Site"),
);
// Not read yet: off, and nothing untrue said.
assert.deepEqual(releaseTarget({ entry: undefined, readyIds: ["c1"], reading: true }, site), {
  areaId: "site",
  name: "Site",
  cardIds: [],
  off: RELEASE_READING,
});

// Not readable: the Board's ready cards stand in; with none, says so.
assert.equal(releaseTarget({ entry: undefined, readyIds: [], failed: true }, null).off, RELEASE_UNREAD);
assert.deepEqual(releaseTarget({ entry: undefined, readyIds: ["c1"], failed: true }, null).cardIds, ["c1"]);

// 1.174.0 (DR3): a card only its own page can release (an approved Builder
// card whose session is open) no longer decides the project's release
// (`releaseOffered` is the card's own ⋯ only): nothing ready is nothing.
const sessionOpen = (id: string, area: string) =>
  card(id, {
    area,
    columnId: "in_progress",
    worktreePath: `/wt/${id}`,
    builder: {
      ptyId: "pty-1",
      snapshots: [{ n: 1 }],
      review: { status: "done", verdict: "approve", snapshotN: 1 },
    } as unknown as KanbanCard["builder"],
  });
assert.deepEqual(
  releaseTarget({ entry: { areas: [] }, readyIds: [], cards: [sessionOpen("b1", "site")] }, site),
  { areaId: "site", name: "Site", cardIds: [], off: nothingToRelease("Site") },
);

// 1.174.0 (DR3, D1(b)): with the area's scope read, Release… is on as soon
// as something is new on its branch since its last tag — with no card
// ready — and its cards are the scope's ready ones.
const NOW = Date.UTC(2026, 9, 31, 12);
const DAY = 86_400_000;
const scope = (over: Partial<ReleaseScope> = {}): ReleaseScope => ({
  workspaceId: "ws",
  area: "site",
  name: "Site",
  tagPrefix: "site-",
  targetBranch: "main",
  throughGithub: true,
  head: "7c1e9a2aa",
  fetchProblem: null,
  countProblem: null,
  partial: false,
  folder: "site",
  sinceTag: "site-v3.0.1",
  sinceAt: NOW - DAY,
  cards: [],
  cardsTotal: 0,
  otherChanges: [],
  otherTotal: 0,
  readyCardIds: [],
  localAhead: 0,
  localBehind: 0,
  diverged: false,
  currentVersion: "3.0.1",
  versionSource: "site/package.json",
  fileVersion: "3.0.1",
  tagVersion: "3.0.1",
  versionOnGithub: true,
  versions: [],
  refusal: null,
  inFlight: null,
  busy: false,
  ...over,
});
const noInputs = { entry: undefined, readyIds: [] as string[] };
assert.deepEqual(releaseTarget(noInputs, site, scope({ cardsTotal: 4, otherTotal: 2 }), NOW), {
  areaId: "site",
  name: "Site",
  cardIds: [],
  off: null,
});
assert.deepEqual(releaseTarget(noInputs, site, scope({ readyCardIds: ["r1"] }), NOW).cardIds, ["r1"]);
assert.equal(
  releaseTarget(noInputs, site, scope(), NOW).off,
  "Nothing new on main since site-v3.0.1, released yesterday.",
);
assert.equal(releaseTarget(noInputs, site, scope({ refusal: "Site is held." }), NOW).off, "Site is held.");
// The scope wins over B4's groups once it is read.
assert.deepEqual(releaseTarget({ entry, readyIds: ready }, site, scope({ readyCardIds: ["s2"] }), NOW).cardIds, ["s2"]);

// 1.174.1 P3 (T3): All areas counts one area's ready cards — the area the
// Release sheet opens, or the first it asks about with ready cards.
{
  const order = ["site", "app"];
  // Before the scopes are read: B4's first group (the no-area card is refused).
  assert.deepEqual(allAreasReleaseCards({ entry, readyIds: ready }, order, null), ["s1", "s2"]);
  assert.deepEqual(allAreasReleaseCards({ entry, readyIds: ["a1", "n1"] }, order, null), ["a1"]);
  assert.deepEqual(allAreasReleaseCards({ entry, readyIds: ["n1"] }, order, null), []);
  // Without B4's groups: the Board's cards by area, in the areas' order.
  const cards = [
    { id: "a1", area: "app" },
    { id: "s1", area: "site" },
    { id: "s2", area: "site" },
    { id: "n1", area: null },
  ] as unknown as KanbanCard[];
  assert.deepEqual(allAreasReleaseCards({ entry: undefined, readyIds: ["a1", "s1", "s2", "n1"], cards }, order, null), ["s1", "s2"]);
  assert.deepEqual(allAreasReleaseCards({ entry: undefined, readyIds: ["a1", "n1"], cards }, order, null), ["a1"]);
  // Read: the scopes choose the area — the only one with something — and
  // the cards are today's ready ones of that area (B4's group).
  const siteNews = scope({ area: "site", name: "Site", cardsTotal: 3, readyCardIds: [] });
  const appReady = scope({ area: "app", name: "App", readyCardIds: ["a1"] });
  const appNothing = scope({ area: "app", name: "App" });
  const siteNothing = scope({ area: "site", name: "Site" });
  assert.deepEqual(allAreasReleaseCards({ entry, readyIds: ready }, order, [siteNothing, appReady]), ["a1"]);
  // Challenger P3-1: one more card ready after the read counts (N + 1).
  const later: Pick<PendingShipCards, "areas"> = {
    areas: [entry.areas![0], { ...entry.areas![1], cardIds: ["a1", "a2"] }, entry.areas![2]],
  };
  assert.deepEqual(allAreasReleaseCards({ entry: later, readyIds: [...ready, "a2"] }, order, [siteNothing, appReady]), ["a1", "a2"]);
  // Without B4's groups: the Board's ready cards of that area.
  const board = [
    { id: "a1", area: "app" },
    { id: "a2", area: "app" },
    { id: "s1", area: "site" },
  ] as unknown as KanbanCard[];
  assert.deepEqual(
    allAreasReleaseCards({ entry: undefined, readyIds: ["s1", "a1", "a2"], cards: board }, order, [siteNothing, appReady]),
    ["a1", "a2"],
  );
  // Two with something: the sheet asks, and the first it lists with ready cards counts.
  assert.deepEqual(
    allAreasReleaseCards({ entry, readyIds: ready }, order, [scope({ area: "site", readyCardIds: ["s1", "s2"] }), appReady]),
    ["s1", "s2"],
  );
  assert.deepEqual(allAreasReleaseCards({ entry, readyIds: ["a1"] }, order, [siteNews, appReady]), ["a1"]);
  // Only commits to release in the one area with something, and no card of it ready: none.
  assert.deepEqual(allAreasReleaseCards({ entry, readyIds: ["a1"] }, order, [siteNews, appNothing]), []);
  // The only area with something refused: none.
  assert.deepEqual(
    allAreasReleaseCards({ entry, readyIds: ready }, order, [scope({ area: "site", refusal: "Site is held.", cardsTotal: 2 }), appNothing].slice(0, 1)),
    [],
  );
  // A refused area is never the one counted.
  assert.deepEqual(
    allAreasReleaseCards({ entry, readyIds: ready }, order, [scope({ area: "site", refusal: "Site is held.", readyCardIds: ["s1"] }), appNothing]),
    ["a1"],
  );
}

console.log("projectRelease: ok");
