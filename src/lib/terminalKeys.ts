// Windows port (W5): which clipboard and find keys a terminal tile answers
// itself instead of sending to the shell.
//
// Paste keys are the web view's own paste ("native-paste"): the tile only
// keeps the key from xterm.js and never cancels it, so the web view fires a
// paste event on xterm's textarea and xterm answers it with its own
// (bracketed) paste — one insertion path. No programmatic clipboard read:
// WebKit shows its "Paste" callout for a read of text another app copied,
// and WebView2 puts a read behind its clipboard permission (Tauri does not
// grant it), while a user's own paste needs neither.
//
// Mac: ⌘F finds; ⌘V pastes (through Edit › Paste, the menu's key
// equivalent); ⌘C copies through the web view's own copy event — ⌘ is never
// a terminal key. ⌃V stays the PTY's ^V, which Claude Code reads as "paste
// an image".
// Windows, where the modifier is Ctrl and Ctrl is the terminal's own:
// - Ctrl+C copies when there is a selection and is SIGINT (^C) when there is
//   none, as Windows Terminal does; Ctrl+Shift+C always copies.
// - Ctrl+V and Ctrl+Shift+V paste (^V, quoted-insert, is given up for it).
// - Ctrl+F finds (^F, forward-char, has the → key).
// Pure, so node can test it.

import { isWindows, modOnly, platform, type ModifierPress, type Platform } from "./platform.ts";

/** "native-paste": the tile keeps the key from xterm.js and lets the web
 *  view's native paste event deliver the text. */
export type TerminalKeyAction = "find" | "native-paste" | "copy";

export interface TerminalKeyPress extends ModifierPress {
  key: string;
}

/** What the tile does with `e`, or null to hand it to xterm.js. */
export function terminalKeyAction(
  e: TerminalKeyPress,
  hasSelection: boolean,
): TerminalKeyAction | null {
  const key = e.key.toLowerCase();
  if (!isWindows()) {
    if (!modOnly(e)) return null;
    return key === "f" ? "find" : key === "v" ? "native-paste" : null;
  }
  const ctrlShift = e.ctrlKey === true && e.shiftKey === true && !e.altKey && !e.metaKey;
  if (ctrlShift) return key === "v" ? "native-paste" : key === "c" ? "copy" : null;
  if (!modOnly(e)) return null;
  if (key === "f") return "find";
  if (key === "v") return "native-paste";
  if (key === "c" && hasSelection) return "copy";
  return null;
}

/** The xterm.js calls the clipboard keys need. */
export interface ClipboardKeyTerminal {
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
}

/** The clipboard part of every terminal host's key handler (tiles, the
 *  Builder, Intake, agent runs, Setup): true when `e` was a paste or copy
 *  key, which the host then keeps from xterm.js (returns false). Paste is
 *  left to the web view — no preventDefault, no clipboard read. Copy (the
 *  Windows Ctrl+C on a selection, Ctrl+Shift+C) writes the selection and
 *  clears it. ⌘F and every other key: false, the host decides. The
 *  clipboard is looked up at key time, not at install time. */
export function handleTerminalClipboardKey(
  e: KeyboardEvent,
  term: ClipboardKeyTerminal,
  clipboard?: Pick<Clipboard, "writeText">,
): boolean {
  const action = terminalKeyAction(e, term.hasSelection());
  if (action === "native-paste") return true;
  if (action !== "copy") return false;
  if (e.type === "keydown") {
    e.preventDefault();
    const text = term.getSelection();
    if (text) (clipboard ?? navigator.clipboard).writeText(text).catch(() => {});
    // As Windows Terminal does: the next Ctrl+C is SIGINT again.
    term.clearSelection();
  }
  return true;
}

// ── Alt+arrow word keys (1.169.0, B1) ────────────────────────────────
// xterm 5 sent a word move for Alt (⌥) + ←/→ itself: ESC b / ESC f on the
// Mac (what Terminal.app sends, and what zsh, bash and Claude Code read as
// a word left / right), and Ctrl+arrow (ESC[1;5D …) elsewhere, Alt+↑/↓
// included (what PSReadLine, under ConPTY, reads as a word move). xterm 6
// dropped that (#5346) and sends the bare ESC[1;3D, which no default shell
// binding reads. Every terminal host keeps xterm 5's keys.

/** The bytes xterm 5 sent for an Alt+arrow, or null for any other key. */
export function altArrowSequence(
  e: TerminalKeyPress & { isComposing?: boolean; keyCode?: number },
  p: Platform = platform(),
): string | null {
  if (!e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return null;
  // An IME composing (keyCode 229 while it does) keeps its own keys.
  if (e.isComposing || e.keyCode === 229) return null;
  const mac = p === "mac";
  switch (e.key) {
    case "ArrowLeft":
      return mac ? "\x1bb" : "\x1b[1;5D";
    case "ArrowRight":
      return mac ? "\x1bf" : "\x1b[1;5C";
    case "ArrowUp":
      return mac ? null : "\x1b[1;5A";
    case "ArrowDown":
      return mac ? null : "\x1b[1;5B";
    default:
      return null;
  }
}

/** Send `e`'s Alt+arrow word move as typed input; true when it was one (the
 *  host then keeps the key from xterm.js, which would send ESC[1;3D). The
 *  keydown goes no further, as xterm 5's own handling cancelled it: no
 *  app shortcut sees a key the terminal took. */
export function handleAltArrowKey(
  e: KeyboardEvent,
  term: { input(data: string, wasUserInput?: boolean): void },
): boolean {
  const seq = altArrowSequence(e);
  if (seq === null) return false;
  if (e.type === "keydown") {
    e.preventDefault();
    e.stopPropagation();
    term.input(seq, true);
  }
  return true;
}

/** Give a terminal host with no key handler of its own the clipboard keys
 *  (and the Alt+arrow word keys).
 *  (A host with its own handler calls `handleTerminalClipboardKey` in it:
 *  xterm.js keeps one custom handler.) */
export function installTerminalClipboardKeys(
  term: ClipboardKeyTerminal & {
    attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean): void;
    input(data: string, wasUserInput?: boolean): void;
  },
  clipboard?: Pick<Clipboard, "writeText">,
): void {
  term.attachCustomKeyEventHandler(
    (e) => !handleTerminalClipboardKey(e, term, clipboard) && !handleAltArrowKey(e, term),
  );
}

// ── Right-click (W4) ──────────────────────────────────────────────────
// Windows Terminal's right-click: copy the selection (and clear it) when
// there is one, paste the clipboard when there is none. The browser's menu
// never opens there. The Mac keeps the web view's menu. A click has no
// native paste to leave it to, so this one paste reads the clipboard — not
// through the page (its clipboard readText sits behind WebView2's
// clipboard-read permission, whose prompt took the window's focus and
// pasted nothing) but through Plyloft itself (`clipboard_read_text`, wired
// in lib/terminalPaste.ts).

export type TerminalRightClick = "copy" | "paste";

/** What a right-click in a terminal does, or null to leave the event alone. */
export function terminalRightClickAction(
  hasSelection: boolean,
  p: Platform = platform(),
): TerminalRightClick | null {
  if (p !== "windows") return null;
  return hasSelection ? "copy" : "paste";
}

/** The xterm.js calls a right-click needs. */
export interface RightClickTerminal extends PasteTerminal {
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
}

/** Where a right-click's copy goes and its paste comes from. `readText`
 *  is Plyloft's own read on Windows, never the page's. */
export interface RightClickClipboard {
  readText(): Promise<string | null>;
  writeText(text: string): Promise<void>;
}

interface MenuElement {
  addEventListener(type: "contextmenu", fn: (e: MouseEvent) => void): void;
  removeEventListener(type: "contextmenu", fn: (e: MouseEvent) => void): void;
}

/** Give `el` (the terminal's container) Windows Terminal's right-click.
 *  Nothing on the Mac. The paste goes through `pasteIntoTerminal`: in a
 *  shell host (`ask` given) several lines without bracketed paste ask
 *  first; elsewhere it is pasted as read. A read that fails (the clipboard
 *  busy) is told through `onError`. A terminal that takes no input (a
 *  finished agent run) pastes nothing. Returns the undo. */
export function installTerminalRightClick(
  el: MenuElement,
  term: RightClickTerminal,
  clipboard: RightClickClipboard,
  ask: AskMultiLinePaste | null,
  onError: (message: string) => void = () => {},
): () => void {
  const onMenu = (e: MouseEvent) => {
    const action = terminalRightClickAction(term.hasSelection());
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (action === "copy") {
      const text = term.getSelection();
      if (text) clipboard.writeText(text).catch(() => {});
      term.clearSelection();
    } else if (!takesNoInput(term)) {
      clipboard
        .readText()
        .then((text) => (text ? pasteIntoTerminal(term, text, ask) : false))
        .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)));
    }
  };
  el.addEventListener("contextmenu", onMenu);
  return () => el.removeEventListener("contextmenu", onMenu);
}

// ── Multi-line paste (shell hosts) ────────────────────────────────────
// A shell with bracketed paste on (zsh, bash 5.1+, fish) takes a paste as
// text. Without it (Windows PowerShell 5.1's PSReadLine, cmd.exe, macOS
// /bin/bash 3.2) each newline is an Enter: the first line runs while the
// rest is still landing. As Windows Terminal does, a paste into a shell host
// (a shell tile, Setup's terminal) asks first — in Plyloft's own confirm
// sheet — unless the shell takes it bracketed; and, as its `trimPaste`
// does, a single line loses its trailing whitespace and newline, so it is
// pasted, not run. Hosts of a TUI (Claude and Codex tiles, the Builder,
// Intake, agent runs) are left out on purpose: under ConPTY their
// bracketed-paste request may never reach xterm.js, and a TUI's newline is
// not a command, so they paste as they always did. Both platforms.
// Programmatic inserts (a dropped file's path, dictation, Plyloft's own
// injections) never pass through here.

/** The xterm.js calls a paste needs. */
export interface PasteTerminal {
  modes: { readonly bracketedPasteMode: boolean };
  options?: { readonly disableStdin?: boolean };
  paste(text: string): void;
  focus?(): void;
}

/** A terminal that takes no input (a finished run): nothing is pasted. */
function takesNoInput(term: PasteTerminal): boolean {
  return term.options?.disableStdin === true;
}

/** Asks whether to paste `lines` lines that each run as a command; true to
 *  paste. */
export type AskMultiLinePaste = (lines: number) => Promise<boolean>;

/** What a shell host does with a paste: `text` as it goes in, and how many
 *  lines to ask about first (0: at once). Bracketed: unchanged, at once. A
 *  text whose only newlines are trailing is one line: trimmed of trailing
 *  whitespace (Windows Terminal's `trimPaste`), at once, so it is not run.
 *  Several lines: unchanged, after asking about the lines left once the
 *  trailing whitespace is trimmed. */
export interface PastePlan {
  text: string;
  ask: number;
}

export function shellPastePlan(text: string, bracketedPasteMode: boolean): PastePlan {
  if (bracketedPasteMode) return { text, ask: 0 };
  const trimmed = text.replace(/\s+$/, "");
  if (!/[\r\n]/.test(trimmed)) return { text: trimmed, ask: 0 };
  return { text, ask: trimmed.split(/\r\n|\r|\n/).length };
}

/** Pastes `text` into `term` through xterm's own paste (bracketed when the
 *  app asked for it). With `ask` (a shell host) the paste follows
 *  `shellPastePlan`, asking first when lines would run one by one; with
 *  null it goes in as is. Resolves true when it pasted. */
export async function pasteIntoTerminal(
  term: PasteTerminal,
  text: string,
  ask: AskMultiLinePaste | null,
): Promise<boolean> {
  if (takesNoInput(term)) return false;
  if (!ask) {
    term.paste(text);
    return true;
  }
  const plan = shellPastePlan(text, term.modes.bracketedPasteMode);
  if (plan.ask === 0) {
    if (plan.text) term.paste(plan.text);
    return plan.text !== "";
  }
  const ok = await ask(plan.ask).catch(() => false);
  if (ok) term.paste(plan.text);
  term.focus?.();
  return ok;
}

interface PasteElement {
  addEventListener(type: "paste", fn: (e: ClipboardEvent) => void, capture: boolean): void;
  removeEventListener(type: "paste", fn: (e: ClipboardEvent) => void, capture: boolean): void;
}

/** A shell host's guard on the web view's own paste (⌘V, Ctrl+V,
 *  Ctrl+Shift+V, Edit › Paste) into the terminal under `el`: a capture
 *  listener on the container runs before xterm's listeners on its textarea
 *  and element. A paste the plan changes (a trimmed line) or asks about is
 *  cancelled there and pasted through `pasteIntoTerminal`; every other
 *  paste is left to xterm untouched, as is any paste into a terminal that
 *  takes no input. Returns the undo. */
export function installMultiLinePasteGuard(
  el: PasteElement,
  term: PasteTerminal,
  ask: AskMultiLinePaste,
): () => void {
  const onPaste = (e: ClipboardEvent) => {
    if (takesNoInput(term)) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    const plan = shellPastePlan(text, term.modes.bracketedPasteMode);
    if (plan.ask === 0 && plan.text === text) return;
    e.preventDefault();
    e.stopPropagation();
    void pasteIntoTerminal(term, text, ask);
  };
  el.addEventListener("paste", onPaste, true);
  return () => el.removeEventListener("paste", onPaste, true);
}
