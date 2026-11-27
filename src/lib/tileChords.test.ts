import assert from "node:assert/strict";
import { comparePassTarget, tileChordAction } from "./tileChords.ts";

const off = { onTerminals: false, windows: false, inTerminal: false };
// ⌘⇧W off Terminals: inert, swallowed (never the window's close).
assert.deepEqual(tileChordAction("closeTile", off), { act: false, swallow: true });
assert.deepEqual(tileChordAction("closeTile", { ...off, inTerminal: true }), { act: false, swallow: true }, "the Mac swallows it in a card's terminal too");
// Windows: in a card's terminal the shell gets it.
assert.deepEqual(tileChordAction("closeTile", { ...off, windows: true, inTerminal: true }), { act: false, swallow: false });
assert.deepEqual(tileChordAction("nextTile", { ...off, windows: true, inTerminal: true }), { act: false, swallow: false });
assert.deepEqual(tileChordAction("expandTile", off), { act: false, swallow: false });
// On Terminals every one acts.
assert.deepEqual(tileChordAction("nextTilePage", { ...off, windows: true, inTerminal: true }), { act: false, swallow: false });
for (const id of ["nextTile", "previousTile", "nextTilePage", "previousTilePage", "expandTile", "closeTile"] as const) {
  assert.deepEqual(tileChordAction(id, { onTerminals: true, windows: true, inTerminal: true }), { act: true, swallow: true });
}
assert.equal(tileChordAction("resume", off).act, true);
// 1.179.0 Compare with two pairs: ⌘⇧Y's pair comes from where the keyboard is.
// One pair: its one bar, from anywhere, swallowed as before.
assert.deepEqual(comparePassTarget("single", null, [""]), { place: "", swallow: true });
assert.deepEqual(comparePassTarget("single", "copy-1", [""]), { place: "", swallow: true });
// Two: the pair the keyboard is in.
assert.deepEqual(comparePassTarget("two", "project", ["project", "copy-1"]), { place: "project", swallow: true });
assert.deepEqual(comparePassTarget("two", "copy-1", ["project", "copy-1"]), { place: "copy-1", swallow: true });
// Outside both (a tile in a third place, the page): nothing, and not
// swallowed, so on Windows a terminal's program gets the key.
assert.deepEqual(comparePassTarget("two", null, ["project", "copy-1"]), { place: null, swallow: false });
assert.deepEqual(comparePassTarget("two", "copy-2", ["project", "copy-1"]), { place: null, swallow: false });
console.log("tileChords: all assertions passed");
