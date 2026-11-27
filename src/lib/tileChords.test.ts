import assert from "node:assert/strict";
import { tileChordAction } from "./tileChords.ts";

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
console.log("tileChords: all assertions passed");
