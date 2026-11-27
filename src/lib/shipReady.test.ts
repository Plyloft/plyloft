// QoL 1.168 C7: every "Ship N" reads one list, so the sidebar, ⌘K, a Board's
// header and the sheet never disagree.
import assert from "node:assert/strict";
import type { KanbanCard } from "../ipc";
import { batchAreas, eligibleSignature, shipReady, shipReadyTotal } from "./shipReady.ts";

const card = (id: string, ready = true) => ({ id, ready }) as unknown as KanbanCard;
const eligible = (c: KanbanCard) => (c as unknown as { ready: boolean }).ready;

// A Board not loaded this session still counts, from the backend's list.
const pending = [
  { workspaceId: "cold", cardIds: ["c1"] },
  { workspaceId: "warm", cardIds: ["w1", "w2", "gone"] },
];
const boards = { warm: { cards: [card("w1"), card("w2", false), card("w3")] } };
const ready = shipReady(pending, boards, eligible);
// w2 just stopped being eligible, "gone" is no longer on the Board; w3 is
// eligible on the Board but the backend found nothing to ship in it.
assert.deepEqual(ready, { cold: ["c1"], warm: ["w1"] });
assert.equal(shipReadyTotal(ready), 2);

// No list yet: the loaded Boards stand in.
assert.deepEqual(shipReady(null, boards, eligible), { warm: ["w1", "w3"] });
// A workspace with none is left out.
assert.deepEqual(shipReady([{ workspaceId: "warm", cardIds: ["w2"] }], boards, eligible), {});

assert.equal(eligibleSignature(boards, eligible), "warm:w1,w3");
assert.equal(eligibleSignature({}, eligible), "");

console.log("shipReady.test.ts: ok");

// 1.173.0 (B4): a batch is one area — its choices, and the cards no batch
// takes until their area is fixed.
assert.deepEqual(batchAreas(undefined, ["a"]), { choices: [], refused: [] }, "no areas: no choice");
assert.deepEqual(batchAreas({ areas: [] }, ["a"]), { choices: [], refused: [] });
const split = batchAreas(
  {
    areas: [
      { area: "site", name: "Site", cardIds: ["s1", "s2", "gone"], refusal: null, branch: "main", tagPrefix: "site-" },
      { area: "app", name: "App", cardIds: ["a1"], refusal: null, branch: "staging", tagPrefix: "" },
      { area: null, name: "", cardIds: ["n1"], refusal: "Which area is this?", branch: "", tagPrefix: "" },
      { area: "docs", name: "Docs", cardIds: ["gone2"], refusal: null, branch: "main", tagPrefix: "docs-" },
    ],
  },
  ["s1", "s2", "a1", "n1"],
);
assert.deepEqual(
  split.choices.map((c) => [c.key, c.label, c.hint, c.cardIds]),
  [
    ["site", "Release Site (2 cards)", "Goes to main, tagged site-vX.Y.Z.", ["s1", "s2"]],
    ["app", "Release App (1 card)", "Goes to staging, tagged vX.Y.Z.", ["a1"]],
  ],
);
assert.deepEqual(split.refused, [{ cardId: "n1", why: "Which area is this?" }]);
