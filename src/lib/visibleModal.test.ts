// Tier 3 pure-function test. Run with Node 22+:
//   node --experimental-strip-types src/lib/visibleModal.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  anyModalBlocksShortcuts,
  sheetAbove,
  modalBlocksShortcuts,
} from "./visibleModal.ts";

// An on-screen modal blocks ⌘K / ⌘P.
assert.equal(modalBlocksShortcuts({ rects: 1, visibility: "visible" }), true);
// GH #95 (review 2): one inside a hidden sticky host does not — `visibility`
// inherits from the host, and a `display:none` ancestor leaves no rects even
// for the fixed-position backdrop.
assert.equal(modalBlocksShortcuts({ rects: 1, visibility: "hidden" }), false);
assert.equal(modalBlocksShortcuts({ rects: 0, visibility: "visible" }), false);

assert.equal(anyModalBlocksShortcuts([]), false);
assert.equal(
  anyModalBlocksShortcuts([
    { rects: 1, visibility: "hidden" },
    { rects: 0, visibility: "visible" },
  ]),
  false,
);
assert.equal(
  anyModalBlocksShortcuts([
    { rects: 1, visibility: "hidden" },
    { rects: 1, visibility: "visible" },
  ]),
  true,
);

// Challenger F6: a confirmation inside a visibility:hidden workspace host is
// not a sheet above Settings; a visible one is.
const fakeDoc = (els: { rects: number; visibility: string }[]) => ({
  querySelectorAll: (sel: string) => {
    assert.equal(sel, ".ux-sheet-backdrop");
    return els.map((e) => ({
      getClientRects: () => ({ length: e.rects }),
      visibility: e.visibility,
    })) as unknown as NodeListOf<Element>;
  },
});
const styleOf = (el: Element) => ({ visibility: (el as unknown as { visibility: string }).visibility });
assert.equal(sheetAbove(fakeDoc([{ rects: 1, visibility: "hidden" }]), styleOf), false);
assert.equal(sheetAbove(fakeDoc([]), styleOf), false);
assert.equal(
  sheetAbove(fakeDoc([{ rects: 1, visibility: "hidden" }, { rects: 1, visibility: "visible" }]), styleOf),
  true,
);
const overlay = readFileSync(new URL("../components/SettingsOverlay.tsx", import.meta.url), "utf8");
assert.match(overlay, /sheetAbove\(\)/);
assert.doesNotMatch(overlay, /getClientRects\(\)\.length > 0/);

// The guards must go through the helper, not a raw querySelector.
for (const path of ["../App.tsx", "../components/Tile.tsx"]) {
  const src = readFileSync(new URL(path, import.meta.url), "utf8");
  assert.doesNotMatch(src, /querySelector\(["']\.(modal|ux-sheet)-backdrop["']\)/);
  assert.match(src, /visibleModalOpen\(\)/);
}

console.log("visibleModal: all assertions passed");
