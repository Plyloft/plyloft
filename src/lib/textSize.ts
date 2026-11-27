// QoL 1.168 (block 10, A7): the text size of the terminals and of the editor.
//
// Two settings, `terminals.textSize` and `editor.textSize`, both absent until
// changed (13 px, what Plyloft has always drawn). Settings › Editor and
// terminals sets them, and ⌘= / ⌘− / ⌘0 (Ctrl on Windows) in a focused
// terminal or the editor steps the one of what has focus, live — as Windows
// Terminal and VS Code do. The setting is per kind, not per tile: every
// terminal follows, so the next tile opens at the size the last one was
// zoomed to.
// Pure, so node can test it.

import { isWindows, type ModifierPress } from "./platform.ts";

/** What Plyloft has always drawn, and what an absent setting reads as. */
export const DEFAULT_TEXT_SIZE = 13;
export const MIN_TEXT_SIZE = 10;
export const MAX_TEXT_SIZE = 24;

/** A stored size as the app draws it: a whole number of px, 10 to 24;
 *  anything else (absent, null, a word) is the shipped 13. */
export function textSizeOf(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim() || Number.NaN) : Number.NaN;
  if (!Number.isFinite(n)) return DEFAULT_TEXT_SIZE;
  return Math.max(MIN_TEXT_SIZE, Math.min(MAX_TEXT_SIZE, Math.round(n)));
}

/** What the file keeps: null for the shipped size, so a file nobody changed
 *  stays as 1.167 wrote it. */
export function storedTextSize(value: unknown): number | null {
  const n = textSizeOf(value);
  return n === DEFAULT_TEXT_SIZE ? null : n;
}

export type ZoomAction = "in" | "out" | "reset";

export interface ZoomKeyPress extends ModifierPress {
  key: string;
  /** The physical key: on an Italian Mac ⌘ on the US "=" key reads "ì". */
  code?: string;
}

/** Is `e` ⌘= / ⌘+ (larger), ⌘− (smaller) or ⌘0 (back to 13)? Ctrl on
 *  Windows. Shift may be held for + (it is the shifted = on a US keyboard,
 *  and its own key on others); ⌥ never. Matched on `key`, so the + and −
 *  keys of any layout (and the number pad) count. */
export function zoomKeyAction(e: ZoomKeyPress): ZoomAction | null {
  const win = isWindows();
  const modHeld = win ? e.ctrlKey === true && !e.metaKey : e.metaKey && !e.ctrlKey;
  if (!modHeld || e.altKey) return null;
  if (e.key === "=" || e.key === "+" || e.key === "Add") return "in";
  // Block 10 Mac walk: matched on the physical key too, where the layout
  // puts another character there (Italian "ì" on the US "=").
  if (e.code === "Equal" || e.code === "NumpadAdd") return "in";
  if (e.shiftKey) return null;
  if (e.key === "-" || e.key === "−" || e.code === "Minus" || e.code === "NumpadSubtract") return "out";
  if (e.key === "0" || e.code === "Digit0" || e.code === "Numpad0") return "reset";
  return null;
}

/** The size after `action`, one px a step, within 10–24. */
export function nextTextSize(current: unknown, action: ZoomAction): number {
  if (action === "reset") return DEFAULT_TEXT_SIZE;
  return textSizeOf(textSizeOf(current) + (action === "in" ? 1 : -1));
}

/** Challenger (block 10, item 3): a held ⌘= repeats ~30 times a second.
 *  The steps add up here, at once (what `pending` reads, so the text grows
 *  live), and only the last is written, `delayMs` after the last press — one
 *  settings write per burst instead of one per repeat. */
export interface ZoomCoalescer {
  step(action: ZoomAction): number;
  /** The size asked for and not written yet, or null. */
  pending(): number | null;
}

export function createZoomCoalescer(opts: {
  /** The saved size (the setting, as the app draws it). */
  read: () => number;
  write: (size: number) => Promise<unknown>;
  /** Told when `pending` changes, so a view can follow it. */
  changed?: () => void;
  delayMs?: number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}): ZoomCoalescer {
  const delay = opts.delayMs ?? 150;
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let pending: number | null = null;
  let timer: unknown = null;
  const flush = () => {
    timer = null;
    const size = pending;
    if (size == null) return;
    void opts
      .write(size)
      .catch(() => {})
      .finally(() => {
        // A press while it was written asked again: that one stays.
        if (pending === size && timer == null) {
          pending = null;
          opts.changed?.();
        }
      });
  };
  return {
    step(action) {
      pending = nextTextSize(pending ?? opts.read(), action);
      if (timer != null) cancel(timer);
      timer = schedule(flush, delay);
      opts.changed?.();
      return pending;
    },
    pending: () => pending,
  };
}
