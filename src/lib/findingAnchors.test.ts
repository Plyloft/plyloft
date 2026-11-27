import assert from "node:assert/strict";

import type { FindingAnchor } from "../ipc.ts";
import {
  anchorFateNote,
  anchorLabel,
  anchorOpenByDefault,
  anchorStateLine,
  anchorStateWord,
  anchorTitle,
  anchorWhere,
  anchorsOfRound,
  placeAnchors,
  roundChoices,
  roundViewWords,
  sortAnchors,
} from "./findingAnchors.ts";
import type { ReviewRound } from "../ipc.ts";
import { diffRows } from "./lineComments.ts";

// CL-6: where each Challenger finding is drawn on the review diff, and its words.

function anchor(over: Partial<FindingAnchor>): FindingAnchor {
  return {
    id: "F1",
    severity: "P2",
    state: "open",
    nonBlocking: false,
    title: "Loses edits",
    body: "The whole text.",
    reason: null,
    round: 1,
    updatedRound: 1,
    path: "src/a.ts",
    reviewedLine: 11,
    line: 11,
    fate: "same",
    ...over,
  };
}

const rows = diffRows([
  { oldStart: 10, newStart: 10, body: " keep\n-gone\n+new a\n+new b\n tail\n" },
]);
// rows: 0 ctx new 10, 1 del old 11, 2 add new 11, 3 add new 12, 4 ctx new 13
const files = [{ path: "src/a.ts", rows }];

{
  // Under its line: the added line 11 (row 2), never the removed old line 11.
  const placed = placeAnchors([anchor({})], files);
  assert.deepEqual([...placed.files.get("src/a.ts")!.byRow.keys()], [2]);
  assert.equal(placed.elsewhere.length, 0);
}

{
  // A moved line goes under its new number; a changed one under the new code.
  const placed = placeAnchors(
    [anchor({ id: "F2", line: 13, reviewedLine: 9, fate: "moved" }), anchor({ id: "F3", line: 12, fate: "changed" })],
    files,
  );
  const byRow = placed.files.get("src/a.ts")!.byRow;
  assert.equal(byRow.get(4)![0].id, "F2");
  assert.equal(byRow.get(3)![0].id, "F3");
}

{
  // A line outside the hunks, an unknown one and a removed file go under the
  // file's name; a file the diff doesn't show goes elsewhere.
  const placed = placeAnchors(
    [
      anchor({ id: "F4", line: 80 }),
      anchor({ id: "F5", line: 11, fate: "unknown" }),
      anchor({ id: "F6", line: null, fate: "file-removed" }),
      anchor({ id: "F7", path: "src/other.ts" }),
    ],
    files,
  );
  assert.deepEqual(placed.files.get("src/a.ts")!.onFile.map((a) => a.id), ["F4", "F5", "F6"]);
  assert.equal(placed.files.get("src/a.ts")!.byRow.size, 0);
  assert.deepEqual(placed.elsewhere.map((a) => a.id), ["F7"]);
  assert.equal(anchorWhere(placed.files.get("src/a.ts")!.onFile[0]), "Line 80, outside the lines this diff shows.");
  assert.equal(anchorWhere(placed.files.get("src/a.ts")!.onFile[1]), null);
}

{
  // On one line: open blocking first, P1 first, closed last.
  const placed = placeAnchors(
    [
      anchor({ id: "F9", state: "closed", severity: "P1" }),
      anchor({ id: "F8", severity: "P3", nonBlocking: true }),
      anchor({ id: "F10", severity: "P1" }),
      anchor({ id: "F2" }),
    ],
    files,
  );
  assert.deepEqual(placed.files.get("src/a.ts")!.byRow.get(2)!.map((a) => a.id), ["F10", "F2", "F8", "F9"]);
  assert.equal(placeAnchors(undefined, files).elsewhere.length, 0);
}

{
  // Words.
  assert.equal(anchorTitle(anchor({ id: "F3", severity: null })), "F3 · Unrated — Loses edits");
  assert.equal(anchorStateWord(anchor({ state: "still-open" })), "Still open");
  assert.equal(anchorStateWord(anchor({ state: "closed" })), "Closed");
  assert.equal(anchorStateWord(anchor({})), "Open");
  assert.equal(
    anchorStateLine(anchor({ state: "still-open", updatedRound: 2, reason: "Still races." })),
    "Raised in round 1 · still open after round 2: Still races.",
  );
  assert.equal(anchorStateLine(anchor({ state: "closed", updatedRound: 3 })), "Raised in round 1 · closed in round 3");
  assert.equal(anchorStateLine(anchor({ nonBlocking: true })), "Raised in round 1 · non-blocking");
  assert.equal(anchorFateNote(anchor({})), null);
  assert.equal(anchorFateNote(anchor({ fate: "changed", reviewedLine: 25 })), "This line changed since the review. It was line 25.");
  assert.equal(anchorFateNote(anchor({ fate: "removed" })), "This line was removed since the review. It was line 11.");
  assert.equal(anchorFateNote(anchor({ fate: "file-removed" })), "This file was removed since the review. It was line 11.");
  assert.equal(anchorFateNote(anchor({ fate: "unknown" })), "This line may have changed since the review. It was line 11.");
  assert.equal(anchorFateNote(anchor({ fate: "moved", reviewedLine: 9 })), "Was line 9 at the review.");
  assert.equal(anchorTitle(anchor({ id: "F6", preExisting: true })), "F6 · Should fix — pre-existing — Loses edits");
  assert.equal(anchorLabel(anchor({ state: "still-open" })), "Reviewer finding F1, should fix, still open, line 11");
  assert.equal(anchorLabel(anchor({ fate: "unknown" })), "Reviewer finding F1, should fix, open");
  // Tier 4 walk 2026-10-14: a dismissed finding (the ledger keeps its state
  // "open") reads Dismissed, with who dismissed it and why.
  const gone = anchor({
    nonBlocking: true,
    dismissed: true,
    dismissal: { by: "ana@example.com", reason: "walk test", at: 5, round: 2 },
  });
  assert.equal(anchorStateWord(gone), "Dismissed");
  assert.equal(anchorLabel(gone), "Reviewer finding F1, should fix, dismissed, line 11");
  assert.equal(anchorStateLine(gone), "Raised in round 1 · dismissed by ana@example.com as not a real issue: walk test");
  assert.equal(
    anchorStateLine(anchor({ dismissed: true, nonBlocking: true })),
    "Raised in round 1 · dismissed as not a real issue",
  );
  assert.equal(anchorOpenByDefault(gone), false);
  assert.deepEqual(sortAnchors([gone, anchor({ id: "F2" })]).map((a) => a.id), ["F2", "F1"]);
}

{
  // P3 and other non-blocking findings, and closed ones, start collapsed.
  assert.equal(anchorOpenByDefault(anchor({})), true);
  assert.equal(anchorOpenByDefault(anchor({ severity: "P3", nonBlocking: true })), false);
  assert.equal(anchorOpenByDefault(anchor({ nonBlocking: true })), false);
  assert.equal(anchorOpenByDefault(anchor({ state: "closed" })), false);
  assert.equal(anchorOpenByDefault(anchor({ state: "still-open", severity: "P1" })), true);
}

// SP-6: the round switch above the diff.
{
  const round = (n: number, over: Partial<ReviewRound> = {}): ReviewRound => ({
    round: n,
    new: 0,
    closed: 0,
    stillOpen: 0,
    verdict: "changes_requested",
    at: n,
    provider: "codex",
    reviewId: `rev-${n}`,
    snapshotN: n,
    ...over,
  });
  // Rounds whose ids the ledger still keeps, oldest first; a round with no
  // findings is not a choice; rounds before a restart are gone.
  assert.deepEqual(
    roundChoices([
      round(1, { newIds: ["F1"] }),
      round(2, { newIds: ["F2"], closedIds: ["F1"], stillOpenIds: ["F2"] }),
      round(3, { verdict: "approve" }),
      round(4, { ledgerRestart: true, newIds: ["F1"] }),
      round(5, { closedIds: ["F1"] }),
    ]),
    [
      { round: 4, ids: ["F1"] },
      { round: 5, ids: ["F1"] },
    ],
  );
  assert.deepEqual(roundChoices([round(1, { newIds: ["F1"] }), round(2, { newIds: ["F2"], closedIds: ["F1"] })]), [
    { round: 1, ids: ["F1"] },
    { round: 2, ids: ["F2", "F1"] },
  ]);
  assert.deepEqual(roundChoices(undefined), []);
  // A round's view keeps its findings only; no round keeps them all.
  const all = [anchor({ id: "F1" }), anchor({ id: "F2" }), anchor({ id: "F3" })];
  assert.deepEqual(anchorsOfRound(all, ["F3", "F1"]).map((a) => a.id), ["F1", "F3"]);
  assert.equal(anchorsOfRound(all, null).length, 3);
  assert.deepEqual(anchorsOfRound(null, ["F1"]), []);
  assert.equal(roundViewWords(2, 1), "Findings raised or closed in round 2: 1 is under the line it names.");
  assert.equal(roundViewWords(2, 3), "Findings raised or closed in round 2: 3 are under the lines they name.");
  assert.equal(roundViewWords(1, 0), "Findings raised or closed in round 1: none of them is in these changes.");
}

console.log("findingAnchors tests passed");
