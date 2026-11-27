// Windows port (W5): WebView2 answers the browser's own keys — Ctrl+R and F5
// reload the whole shell, Ctrl+P prints, Ctrl+F opens the page's find bar,
// Ctrl+plus zooms, Ctrl+Shift+I opens the developer tools — unless the page
// cancels the keydown. WKWebView has none of these, so the Mac needs nothing.
//
// The guard listens on `window` in the bubble phase and only calls
// `preventDefault`: it runs after every handler of Ply's (the capture-phase
// shortcuts, xterm.js, CodeMirror, the Board's find) and stops none of them.
// Capture would be too early — CodeMirror skips a keydown that is already
// defaultPrevented, so Ctrl+F, Ctrl+G, Ctrl+U and Ctrl+S in the editor would
// stop working. A key one of them answered is already cancelled; cancelling
// it again is harmless.
// Pure, so node can test it.

export interface BrowserKeyPress {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

const CTRL_KEYS = new Set([
  "r", // reload (Ctrl+Shift+R too)
  "p", // print
  "s", // save the page
  "f", // the page's find bar
  "g", // find next
  "u", // view source
  "j", // downloads
  "+",
  "=",
  "-",
  "_",
  "0", // zoom
]);
// With Shift: the developer tools and the element picker.
const CTRL_SHIFT_KEYS = new Set(["i", "c"]);

/** How much of the browser a guard leaves. */
export interface GuardOptions {
  /** A dev build: the developer tools (Ctrl+Shift+I / C, the Inspect menu)
   *  stay reachable. Release builds also have WebView2's accelerator keys
   *  off in the backend (windows_shell.rs). */
  devtools?: boolean;
}

/** Is `e` a key WebView2 would act on as a browser? */
export function isBrowserKey(e: BrowserKeyPress, opts: GuardOptions = {}): boolean {
  if (e.metaKey) return false;
  if (!e.ctrlKey) return !e.altKey && (e.key === "F5" || e.key === "F3");
  // Ctrl+Alt is AltGr on Windows: a character, never a browser key.
  if (e.altKey) return false;
  const key = e.key.toLowerCase();
  if (key === "f5") return true;
  if (e.shiftKey && CTRL_SHIFT_KEYS.has(key)) return !opts.devtools;
  return CTRL_KEYS.has(key);
}

interface KeyTarget {
  addEventListener(type: "keydown", fn: (e: KeyboardEvent) => void): void;
  removeEventListener(type: "keydown", fn: (e: KeyboardEvent) => void): void;
}

/** Cancel the browser's keys on `target` (the window). Returns the undo. */
export function installBrowserKeyGuard(target: KeyTarget, opts: GuardOptions = {}): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (isBrowserKey(e, opts)) e.preventDefault();
  };
  target.addEventListener("keydown", onKey);
  return () => target.removeEventListener("keydown", onKey);
}

// ── The context menu (W4) ─────────────────────────────────────────────
// WebView2's own right-click menu on the page offers Back, Refresh, Save as,
// Print and Inspect — Refresh reloads the whole shell. Over an input, a
// textarea or the editor, or on selected text, it is the editing menu (Cut,
// Copy, Paste), which stays. A terminal answers its own right-click (copy or
// paste, lib/terminalKeys.ts) and never shows a menu. A menu of Ply's own
// has already cancelled the event and is left alone.

export interface ContextMenuSpot {
  /** The target is an input, a textarea or contenteditable. */
  editable: boolean;
  /** The click landed on selected text. A selection elsewhere does not
   *  count: the menu there would be the page's. */
  onSelection: boolean;
  /** The click is in a terminal. */
  inTerminal: boolean;
}

/** Should the browser's context menu at `spot` be cancelled? */
export function isBrowserContextMenu(spot: ContextMenuSpot, opts: GuardOptions = {}): boolean {
  if (spot.inTerminal) return true;
  if (opts.devtools) return false;
  return !spot.editable && !spot.onSelection;
}

const EDITABLE = 'input, textarea, [contenteditable]:not([contenteditable="false"])';

interface RectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The part of a Selection the guard reads. */
export interface SelectionLike {
  isCollapsed: boolean;
  rangeCount: number;
  getRangeAt(i: number): { getClientRects(): ArrayLike<RectLike> };
}

/** Is (x, y) on the selected text? */
export function pointOnSelection(sel: SelectionLike | null | undefined, x: number, y: number): boolean {
  if (!sel || sel.isCollapsed) return false;
  for (let i = 0; i < sel.rangeCount; i += 1) {
    const rects = sel.getRangeAt(i).getClientRects();
    for (let j = 0; j < rects.length; j += 1) {
      const r = rects[j];
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    }
  }
  return false;
}

interface MenuTarget {
  addEventListener(type: "contextmenu", fn: (e: MouseEvent) => void): void;
  removeEventListener(type: "contextmenu", fn: (e: MouseEvent) => void): void;
  getSelection?(): SelectionLike | null;
}

/** Cancel the browser's page menu on `target` (the window). Returns the undo. */
export function installContextMenuGuard(target: MenuTarget, opts: GuardOptions = {}): () => void {
  const onMenu = (e: MouseEvent) => {
    if (e.defaultPrevented) return;
    const el = e.target;
    const isElement = typeof Element !== "undefined" && el instanceof Element;
    const spot: ContextMenuSpot = {
      editable: isElement && el.closest(EDITABLE) !== null,
      onSelection: pointOnSelection(target.getSelection?.(), e.clientX, e.clientY),
      inTerminal: isElement && el.closest(".xterm") !== null,
    };
    if (isBrowserContextMenu(spot, opts)) e.preventDefault();
  };
  target.addEventListener("contextmenu", onMenu);
  return () => target.removeEventListener("contextmenu", onMenu);
}
