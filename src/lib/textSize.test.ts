// QoL 1.168 (block 10, A7): Text size and ⌘= / ⌘− / ⌘0.
import assert from "node:assert/strict";
import { setPlatformForTests } from "./platform.ts";
import {
  DEFAULT_TEXT_SIZE,
  nextTextSize,
  storedTextSize,
  textSizeOf,
  zoomKeyAction,
  createZoomCoalescer,
} from "./textSize.ts";

// An absent or odd value is the shipped 13; the range is 10–24.
assert.equal(DEFAULT_TEXT_SIZE, 13);
assert.equal(textSizeOf(undefined), 13);
assert.equal(textSizeOf(null), 13);
assert.equal(textSizeOf("big"), 13);
assert.equal(textSizeOf(""), 13);
assert.equal(textSizeOf(16), 16);
assert.equal(textSizeOf("15"), 15);
assert.equal(textSizeOf(4), 10);
assert.equal(textSizeOf(99), 24);
assert.equal(textSizeOf(14.6), 15);
// The file keeps nothing for the shipped size.
assert.equal(storedTextSize(13), null);
assert.equal(storedTextSize("x"), null);
assert.equal(storedTextSize(18), 18);
assert.equal(storedTextSize(40), 24);

// Steps of one, clamped; reset goes back to 13.
assert.equal(nextTextSize(undefined, "in"), 14);
assert.equal(nextTextSize(13, "out"), 12);
assert.equal(nextTextSize(24, "in"), 24);
assert.equal(nextTextSize(10, "out"), 10);
assert.equal(nextTextSize(20, "reset"), 13);

const press = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

setPlatformForTests("mac");
assert.equal(zoomKeyAction(press("=", { metaKey: true })), "in");
assert.equal(zoomKeyAction(press("+", { metaKey: true, shiftKey: true })), "in");
assert.equal(zoomKeyAction(press("-", { metaKey: true })), "out");
assert.equal(zoomKeyAction(press("0", { metaKey: true })), "reset");
// ⌃ alone is the terminal's own (⌃- is undo in a line editor); ⌥ never zooms.
assert.equal(zoomKeyAction(press("-", { ctrlKey: true })), null);
assert.equal(zoomKeyAction(press("=", { metaKey: true, altKey: true })), null);
assert.equal(zoomKeyAction(press("0", { metaKey: true, shiftKey: true })), null);
assert.equal(zoomKeyAction(press("=")), null);
assert.equal(zoomKeyAction(press("k", { metaKey: true })), null);

// Block 10 Mac walk: an Italian Mac sends "ì" on the US "=" key, "'" on "-".
assert.equal(zoomKeyAction({ ...press("ì", { metaKey: true }), code: "Equal" }), "in");
assert.equal(zoomKeyAction({ ...press("'", { metaKey: true }), code: "Minus" }), "out");
assert.equal(zoomKeyAction({ ...press("à", { metaKey: true }), code: "Digit0" }), "reset");
assert.equal(zoomKeyAction({ ...press("+", { metaKey: true }), code: "BracketRight" }), "in", "Italian +");
assert.equal(zoomKeyAction({ ...press("ì", { metaKey: true, altKey: true }), code: "Equal" }), null);

setPlatformForTests("windows");
assert.equal(zoomKeyAction(press("=", { ctrlKey: true })), "in");
assert.equal(zoomKeyAction(press("-", { ctrlKey: true })), "out");
assert.equal(zoomKeyAction(press("0", { ctrlKey: true })), "reset");
assert.equal(zoomKeyAction(press("=", { metaKey: true })), null);
// AltGr is Ctrl+Alt: a character, never a zoom.
assert.equal(zoomKeyAction(press("0", { ctrlKey: true, altKey: true })), null);
setPlatformForTests(null);

// Challenger (block 10, item 3): a burst of presses is one write, of the
// last size; the size grows at once in between.
{
  let saved = 13;
  const writes: number[] = [];
  const timers: (() => void)[] = [];
  let changes = 0;
  let ids = 0;
  const cancelled = new Set<number>();
  const z = createZoomCoalescer({
    read: () => saved,
    write: async (n) => {
      writes.push(n);
      saved = n;
    },
    changed: () => (changes += 1),
    schedule: (fn) => {
      const id = ++ids;
      timers.push(() => {
        if (!cancelled.has(id)) fn();
      });
      return id;
    },
    cancel: (h) => {
      cancelled.add(h as number);
    },
  });
  for (let i = 0; i < 5; i++) z.step("in");
  assert.equal(z.pending(), 18, "five steps, at once");
  assert.equal(writes.length, 0, "nothing written mid-burst");
  for (const t of timers.splice(0)) t();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(writes, [18], "one write, the last size");
  assert.equal(z.pending(), null, "settled once written");
  assert.ok(changes >= 6);
  z.step("reset");
  for (const t of timers.splice(0)) t();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(writes, [18, 13]);
}

console.log("textSize: all assertions passed");
