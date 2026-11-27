// Every terminal host's paste handling, wired to the app: Windows Terminal's
// right-click (copy / paste, lib/terminalKeys.ts) with the clipboard read by
// Plyloft itself, and — in a shell host only — the multi-line paste question
// in the confirm sheet. The pure parts live in lib/terminalKeys.ts, where
// node tests them.

import { clipboardReadText } from "../ipc";
import { confirmSheet } from "../store/confirmStore";
import { pushToast } from "../store/toastStore";
import {
  installMultiLinePasteGuard,
  installTerminalRightClick,
  type RightClickTerminal,
} from "./terminalKeys";

/** "Paste N lines?" — the confirm sheet, Cancel by default: a paste that
 *  would run commands one by one is not undone. */
export async function askMultiLinePaste(lines: number): Promise<boolean> {
  return await confirmSheet({
    title: `Paste ${lines} lines?`,
    body: "Each line runs as a command.",
    confirmLabel: "Paste",
    cautious: true,
  });
}

interface HostElement {
  addEventListener(type: "contextmenu", fn: (e: MouseEvent) => void): void;
  removeEventListener(type: "contextmenu", fn: (e: MouseEvent) => void): void;
  addEventListener(type: "paste", fn: (e: ClipboardEvent) => void, capture: boolean): void;
  removeEventListener(type: "paste", fn: (e: ClipboardEvent) => void, capture: boolean): void;
}

export interface TerminalPasteOptions {
  /** A shell runs here (a shell tile, Setup's terminal): a paste of several
   *  lines without bracketed paste asks first, and a single line is
   *  trimmed of its trailing newline. A TUI host (Claude, Codex, the
   *  Builder, Intake, agent runs) passes false and pastes as is. */
  shell: boolean;
}

/** Give a terminal host's container `el` its right-click and, in a shell
 *  host, its multi-line paste question. Returns the undo. */
export function installTerminalPaste(
  el: HostElement,
  term: RightClickTerminal,
  { shell }: TerminalPasteOptions,
): () => void {
  const ask = shell ? askMultiLinePaste : null;
  const undoMenu = installTerminalRightClick(
    el,
    term,
    {
      readText: clipboardReadText,
      // A write needs no permission; it stays the page's.
      writeText: (text) => navigator.clipboard.writeText(text),
    },
    ask,
    (message) =>
      pushToast({
        kind: "error",
        title: "Nothing pasted",
        body: "Plyloft could not read the clipboard. Try again.",
        details: message,
      }),
  );
  const undoGuard = ask ? installMultiLinePasteGuard(el, term, ask) : () => {};
  return () => {
    undoMenu();
    undoGuard();
  };
}
