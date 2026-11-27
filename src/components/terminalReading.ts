// QoL 1.168 (block 10, A7): Settings › Terminal text size and Screen reader
// support for every terminal host. A tile (`Terminal.tsx`) follows the size
// in its own effects; the card's Builder, Intake and an agent run use
// `followTerminalReading`; every host, Chat and Setup included, uses
// `followScreenReader`. One place so every host reads them the same way,
// open ones included, and answers ⌘= / ⌘− / ⌘0 (Ctrl on Windows) as a tile
// does.

import type { Terminal } from "@xterm/xterm";
import { useSettings } from "../store/settingsStore";
import { textSizeNow, useTextZoom, zoomText } from "../store/textZoomStore";
import { zoomKeyAction } from "../lib/textSize";
import { handleAltArrowKey, handleTerminalClipboardKey } from "../lib/terminalKeys";

/** Challenger (block 10, item 3): how long after the last size change a
 *  terminal refits (and its PTY resizes) — once per burst of ⌘=. */
export const REFIT_AFTER_SIZE_MS = 150;

type ReadingTerminal = Pick<Terminal, "options">;

/** A trailing call `ms` after the last `run()`; `cancel` drops it. */
export function trailing(fn: () => void, ms: number): { run: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    run: () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, ms);
    },
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Apply the terminals' text size to `term` now and whenever it changes,
 *  then `refit` once the size rests (the host's own fit, then its PTY's
 *  resize). Returns the unsubscribe. */
export function followTerminalReading(term: ReadingTerminal, refit: () => void): () => void {
  const later = trailing(refit, REFIT_AFTER_SIZE_MS);
  const apply = (first: boolean) => {
    const px = textSizeNow("terminals");
    if (term.options.fontSize === px) return;
    term.options.fontSize = px;
    if (first) refit();
    else later.run();
  };
  apply(true);
  const offSettings = useSettings.subscribe((state, prev) => {
    if (state.settings.terminals.textSize !== prev.settings.terminals.textSize) apply(false);
  });
  const offZoom = useTextZoom.subscribe((state, prev) => {
    if (state.terminals !== prev.terminals) apply(false);
  });
  return () => {
    later.cancel();
    offSettings();
    offZoom();
  };
}

type FocusTerminal = Pick<Terminal, "options"> & { textarea?: HTMLTextAreaElement | undefined };

/** Challenger (block 10, item 6): Screen reader support turns xterm's
 *  screen reader mode on for the terminal that has the keyboard only, so a
 *  grid of busy tiles doesn't all read out at once. Call after `open()`.
 *  Returns the undo. */
export function followScreenReader(term: FocusTerminal): () => void {
  // Defensive: a test's stand-in xterm may have no real textarea.
  const raw = term.textarea ?? null;
  const area = raw && typeof raw.addEventListener === "function" ? raw : null;
  let focused = area != null && area.ownerDocument?.activeElement === area;
  const apply = () => {
    const want = focused && useSettings.getState().settings.appearance.screenReader === true;
    if ((term.options.screenReaderMode ?? false) !== want) term.options.screenReaderMode = want;
  };
  const onFocus = () => {
    focused = true;
    apply();
  };
  const onBlur = () => {
    focused = false;
    apply();
  };
  area?.addEventListener("focus", onFocus);
  area?.addEventListener("blur", onBlur);
  apply();
  const off = useSettings.subscribe((state, prev) => {
    if (state.settings.appearance.screenReader !== prev.settings.appearance.screenReader) apply();
  });
  return () => {
    area?.removeEventListener("focus", onFocus);
    area?.removeEventListener("blur", onBlur);
    off();
  };
}

/** The key handler of a host with no keys of its own: the zoom keys, then
 *  the clipboard keys and the Alt+arrow word keys
 *  (`installTerminalClipboardKeys`, with zoom). */
export function installTerminalHostKeys(term: Terminal): void {
  term.attachCustomKeyEventHandler((e) => {
    const zoom = zoomKeyAction(e);
    if (zoom) {
      if (e.type === "keydown") {
        e.preventDefault();
        zoomText("terminals", zoom);
      }
      return false;
    }
    return !handleTerminalClipboardKey(e, term) && !handleAltArrowKey(e, term);
  });
}
