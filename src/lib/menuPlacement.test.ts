// Walk follow-ups 2026-10-19: a `⋯` menu stays where it can be seen. Run with:
//
//     node --experimental-strip-types src/lib/menuPlacement.test.ts

import assert from "node:assert/strict";
import { menuPlacement, type MenuBox } from "./menuPlacement.ts";

const box = (left: number, top: number, width: number, height: number): MenuBox => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});
const window = box(0, 0, 1280, 800);

// A row's `⋯` at the right with room below: as drawn.
assert.deepEqual(menuPlacement(box(1000, 124, 260, 200), box(1230, 100, 30, 20), window), {
  start: false,
  end: false,
  up: false,
  maxHeight: null,
});
// The skill page's `⋯` beside the primary, at a panel whose left edge is 300:
// the leftward menu passed it ("alk-1014", "ble to both"), so it opens
// rightwards from the trigger.
const panel = box(300, 0, 980, 800);
assert.deepEqual(menuPlacement(box(160, 124, 260, 200), box(390, 100, 30, 20), panel), {
  start: true,
  end: false,
  up: false,
  maxHeight: null,
});
// A row at the bottom of the list: opened past the window's bottom, it opens
// above the trigger.
assert.deepEqual(menuPlacement(box(1000, 774, 260, 220), box(1230, 750, 30, 20), window), {
  start: false,
  end: false,
  up: true,
  maxHeight: null,
});
// Both at once: the bottom-left corner.
assert.deepEqual(menuPlacement(box(160, 774, 260, 220), box(390, 750, 30, 20), panel), {
  start: true,
  end: false,
  up: true,
  maxHeight: null,
});
// A navigation menu (left-aligned) past the right edge turns leftwards.
assert.deepEqual(menuPlacement(box(1200, 124, 260, 200), box(1200, 100, 60, 20), window), {
  start: false,
  end: true,
  up: false,
  maxHeight: null,
});
// Too little room above as well: it stays below, where there is more (the
// menu scrolls in its own max-height).
const tall = menuPlacement(box(1000, 224, 260, 700), box(1230, 200, 30, 20), window);
assert.equal(tall.up, false);
// Challenger: ...and capped to that room (800 − 220 − 4 gap − 4 margin), so
// its last entries scroll into view instead of running past the window.
assert.equal(tall.maxHeight, 572);
// A menu that fits below needs no cap; one that fits above once turned, none.
assert.equal(menuPlacement(box(1000, 124, 260, 200), box(1230, 100, 30, 20), window).maxHeight, null);

console.log("menuPlacement: ok");
