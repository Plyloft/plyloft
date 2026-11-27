// 1.174.0 (A4): the slot's order and the "more notes" line.
// Run with Node 22+:  node --experimental-strip-types src/lib/boardNotices.test.ts
import assert from "node:assert/strict";
import {
  adoptionKind,
  adoptionSummary,
  areasSummary,
  folderSummary,
  moreNotesLine,
  NEXT_IMPROVEMENT_SUMMARY,
  orderNotices,
  type BoardNoticeEntry,
} from "./boardNotices.ts";

const note = (id: string, kind: BoardNoticeEntry["kind"], summary = id): BoardNoticeEntry => ({ id, kind, summary });

// broken > setup > folder > areas > Next improvement, whatever order they come in.
assert.deepEqual(
  orderNotices([
    note("ni", "next-improvement"),
    note("areas", "areas"),
    note("folder", "folder"),
    note("adoption", "setup"),
    null,
    note("area-problem", "broken"),
  ]).map((n) => n.id),
  ["area-problem", "adoption", "folder", "areas", "ni"],
);
// Two of one kind keep the order given.
assert.deepEqual(
  orderNotices([note("b1", "broken"), note("s", "setup"), note("b2", "broken")]).map((n) => n.id),
  ["b1", "b2", "s"],
);
assert.deepEqual(orderNotices([null, undefined]), []);

// The mockup's worst case (scene 2): the setup first, then two more.
const worst = orderNotices([
  note("ni", "next-improvement", NEXT_IMPROVEMENT_SUMMARY),
  note("areas", "areas", areasSummary(false, 2)),
  note("folder", "folder", folderSummary(true, "Your project folder is behind GitHub's main")),
  note("adoption", "setup", adoptionSummary({ kind: "elsewhere", title: "This project has a shared setup on GitHub", uses: [{}] })),
]);
assert.equal(worst[0].id, "adoption");
assert.equal(
  moreNotesLine(worst.slice(1, 3)),
  "2 more notes: your project folder is behind GitHub · two products in this repository",
);
assert.equal(moreNotesLine(worst.slice(1, 2)), "1 more note: your project folder is behind GitHub");
assert.equal(moreNotesLine([]), null);
// Next improvement with another note is only its name in the line.
assert.equal(moreNotesLine(worst.slice(3)), "1 more note: Next improvement");

// The adoption banner: a failed switch is broken; the rest is a setup.
assert.equal(adoptionKind("retry"), "broken");
for (const k of ["question", "offer", "elsewhere", "held"] as const) assert.equal(adoptionKind(k), "setup");
assert.equal(adoptionSummary({ kind: "offer", title: "", move: "Move them to GitHub Issues" }), "this Mac's local cards");
assert.equal(adoptionSummary({ kind: "offer", title: "", move: "Move to GitHub Issues" }), "the board on GitHub Issues");
assert.equal(adoptionSummary({ kind: "elsewhere", title: "", uses: [{}, {}] }), "shared setups on GitHub");
assert.equal(adoptionSummary({ kind: "held", title: "The board stays local on this Mac" }), "the board stays local on this Mac");
assert.equal(adoptionSummary({ kind: "question", title: "" }), "sharing this project's setup");

assert.equal(areasSummary(true), "the areas can't be used");
assert.equal(areasSummary(false, 3), "three products in this repository");
assert.equal(areasSummary(false, 12), "12 products in this repository");

// The folder: the ask in the mockup's words; else the title, mid-sentence.
assert.equal(folderSummary(false, "Couldn't bring GitHub's main to this Mac"), "couldn't bring GitHub's main to this Mac");
assert.equal(folderSummary(false, "main on this Mac is behind GitHub"), "main on this Mac is behind GitHub");
assert.equal(folderSummary(false, "GitHub's main moved."), "GitHub's main moved");

console.log("boardNotices.test.ts: ok");
