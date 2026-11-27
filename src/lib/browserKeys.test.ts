// W5: the browser keys WebView2 would act on, cancelled after Ply's own
// handlers — and only cancelled, never stopped.
// Run with Node 22+:  node --experimental-strip-types src/lib/browserKeys.test.ts
import assert from "node:assert/strict";
import {
  installBrowserKeyGuard,
  installContextMenuGuard,
  isBrowserContextMenu,
  isBrowserKey,
  pointOnSelection,
  type BrowserKeyPress,
  type ContextMenuSpot,
} from "./browserKeys.ts";

const key = (k: string, m: Partial<BrowserKeyPress> = {}): BrowserKeyPress => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...m,
});
const ctrl = (k: string, m: Partial<BrowserKeyPress> = {}) => key(k, { ctrlKey: true, ...m });

// What the browser would do something with.
{
  for (const k of ["r", "p", "s", "f", "g", "u", "j", "+", "=", "-", "0"]) {
    assert.ok(isBrowserKey(ctrl(k)), `Ctrl+${k}`);
  }
  assert.ok(isBrowserKey(ctrl("R", { shiftKey: true })), "Ctrl+Shift+R");
  assert.ok(isBrowserKey(ctrl("I", { shiftKey: true })), "Ctrl+Shift+I");
  assert.ok(isBrowserKey(key("F5")), "F5");
  assert.ok(isBrowserKey(ctrl("F5")), "Ctrl+F5");
  assert.ok(isBrowserKey(key("F3")), "F3");
}

// What is left alone.
{
  assert.ok(!isBrowserKey(ctrl("c")), "Ctrl+C: copy, or SIGINT in a terminal");
  assert.ok(!isBrowserKey(ctrl("v")), "Ctrl+V: paste");
  assert.ok(!isBrowserKey(ctrl("k")));
  assert.ok(!isBrowserKey(ctrl("i")), "plain Ctrl+I");
  assert.ok(!isBrowserKey(ctrl("2", { altKey: true })), "AltGr+2 types @");
  assert.ok(!isBrowserKey(ctrl("f", { altKey: true })));
  assert.ok(!isBrowserKey(key("r")));
  assert.ok(!isBrowserKey(key("F5", { altKey: true })));
  assert.ok(!isBrowserKey(key("r", { metaKey: true })), "the Windows key is not the browser's");
}

// The guard: bubble phase on the window, preventDefault only.
{
  const listeners: ((e: KeyboardEvent) => void)[] = [];
  const target = {
    addEventListener: (type: string, fn: (e: KeyboardEvent) => void, opts?: unknown) => {
      assert.equal(type, "keydown");
      assert.equal(opts, undefined, "the bubble phase: after every handler of Plyloft's");
      listeners.push(fn);
    },
    removeEventListener: (_type: string, fn: (e: KeyboardEvent) => void) => {
      listeners.splice(listeners.indexOf(fn), 1);
    },
  };
  const undo = installBrowserKeyGuard(target);
  assert.equal(listeners.length, 1);
  const fire = (press: BrowserKeyPress) => {
    const calls: string[] = [];
    const event = {
      ...press,
      preventDefault: () => calls.push("preventDefault"),
      stopPropagation: () => calls.push("stopPropagation"),
      stopImmediatePropagation: () => calls.push("stopImmediatePropagation"),
    } as unknown as KeyboardEvent;
    for (const fn of listeners) fn(event);
    return calls;
  };
  assert.deepEqual(fire(ctrl("r")), ["preventDefault"], "reload cancelled, nobody stopped");
  assert.deepEqual(fire(ctrl("p")), ["preventDefault"]);
  assert.deepEqual(fire(key("F5")), ["preventDefault"]);
  assert.deepEqual(fire(ctrl("c")), [], "copy untouched");
  assert.deepEqual(fire(key("a")), []);
  undo();
  assert.equal(listeners.length, 0);
}

// W4: the page's own right-click menu (Refresh, Print, Inspect) is cancelled;
// the editing menu over an input or on selected text stays; a terminal never
// shows one; a dev build keeps the menu (Inspect) and the devtools keys.
{
  const spot = (m: Partial<ContextMenuSpot> = {}): ContextMenuSpot => ({
    editable: false,
    onSelection: false,
    inTerminal: false,
    ...m,
  });
  assert.equal(isBrowserContextMenu(spot()), true);
  assert.equal(isBrowserContextMenu(spot({ editable: true })), false);
  assert.equal(isBrowserContextMenu(spot({ onSelection: true })), false);
  assert.equal(isBrowserContextMenu(spot({ inTerminal: true, editable: true })), true, "a terminal's own");
  assert.equal(isBrowserContextMenu(spot(), { devtools: true }), false, "dev keeps Inspect");
  assert.equal(isBrowserContextMenu(spot({ inTerminal: true }), { devtools: true }), true);

  const devtoolsKey = ctrl("i", { shiftKey: true });
  assert.equal(isBrowserKey(devtoolsKey), true);
  assert.equal(isBrowserKey(devtoolsKey, { devtools: true }), false, "dev keeps the devtools");
  assert.equal(isBrowserKey(ctrl("r"), { devtools: true }), true, "reload stays cancelled in dev");

  // On the selected text, not anywhere once something is selected.
  const sel = (rects: { left: number; right: number; top: number; bottom: number }[], collapsed = false) => ({
    isCollapsed: collapsed,
    rangeCount: 1,
    getRangeAt: () => ({ getClientRects: () => rects }),
  });
  const words = [{ left: 10, right: 60, top: 100, bottom: 118 }];
  assert.equal(pointOnSelection(sel(words), 30, 110), true);
  assert.equal(pointOnSelection(sel(words), 300, 110), false, "a click beside the selection");
  assert.equal(pointOnSelection(sel(words, true), 30, 110), false, "a caret is no selection");
  assert.equal(pointOnSelection(null, 30, 110), false);

  let selection = sel([]);
  const listeners: ((e: MouseEvent) => void)[] = [];
  const target = {
    addEventListener: (_type: string, fn: (e: MouseEvent) => void) => listeners.push(fn),
    removeEventListener: (_type: string, fn: (e: MouseEvent) => void) => {
      listeners.splice(listeners.indexOf(fn), 1);
    },
    getSelection: () => selection,
  };
  const undo = installContextMenuGuard(target);
  const fire = (defaultPrevented = false) => {
    let cancelled = false;
    const event = {
      target: null,
      clientX: 30,
      clientY: 110,
      defaultPrevented,
      preventDefault: () => {
        cancelled = true;
      },
    } as unknown as MouseEvent;
    for (const fn of listeners) fn(event);
    return cancelled;
  };
  assert.equal(fire(), true, "the page menu is cancelled");
  assert.equal(fire(true), false, "a menu of Plyloft's own is left alone");
  selection = sel(words);
  assert.equal(fire(), false, "on the selection: Copy stays");
  selection = sel([{ left: 200, right: 260, top: 100, bottom: 118 }]);
  assert.equal(fire(), true, "a selection elsewhere: still the page's menu");
  undo();
  assert.equal(listeners.length, 0);
}

console.log("browserKeys: all assertions passed");
