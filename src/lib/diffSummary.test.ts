// Tier 3 pure-function test (CL-11). Run with Node 22+:
//   node --experimental-strip-types src/lib/diffSummary.test.ts
import assert from "node:assert/strict";
import type { FileDiff } from "../ipc.ts";
import { diffSummaryLine, hunkLineCounts } from "./diffSummary.ts";

const hunk = (body: string) => ({ header: "@@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, body });
const file = (kind: FileDiff["kind"], ...bodies: string[]): FileDiff => ({ path: "src/billing.js", kind, hunks: bodies.map(hunk) });

// The walk: one changed file with four added lines said "+0 · ~1 · -0".
const walk = file("modified", " export function calcDiscount() {}\n+\n+export function totalWithVat(amount) {\n+  return amount * 1.22;\n+}\n");
assert.deepEqual(hunkLineCounts(walk), { added: 4, removed: 0 });
assert.equal(diffSummaryLine([walk]), "1 file changed · +4 −0");

// A removed line that itself starts with "--" or "++" still counts once.
assert.deepEqual(hunkLineCounts(file("modified", "---- old rule\n+++ new rule\n context\n\\ No newline at end of file\n")), { added: 1, removed: 1 });

// Across hunks and files; new, removed and renamed files in words.
assert.equal(
  diffSummaryLine([
    file("added", "+a\n+b\n"),
    file("modified", "-x\n+y\n", " k\n-z\n"),
    file("removed", "-gone\n"),
    { ...file("renamed"), oldPath: "old.ts" },
  ]),
  "4 files changed (1 new, 1 removed, 1 renamed) · +3 −3",
);
assert.equal(diffSummaryLine([]), "No files changed.");

console.log("diffSummary: ok");
