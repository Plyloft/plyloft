// UX-3.7 (the Shell board): every keyboard shortcut, in one list. App.tsx's
// global key handler asks `matchShortcut` which one a key press is, the ⌘/
// sheet draws the list, and every hint (⌘K's rows, tooltips) reads its keys
// from here — so a shortcut that changes changes everywhere, and a shortcut
// that is not in this list does not exist. Pure, so node can test it.
//
// Windows (W5): the list is written in the Mac's glyphs; `shortcutKeys` draws
// them for the platform (`Ctrl+Shift+F`), and the matcher reads Ctrl where the
// Mac reads ⌘.
//
// 1.174.0 E5 (P22, D5 b): on Windows, Ctrl and a letter belong to the program
// in a terminal (PowerShell, Claude, Codex: `terminalOwnsChord`), so the
// shortcuts that are a plain Ctrl letter there have a second form with Shift,
// or Alt for a new tile (`windowsInTerminal`). It works everywhere but where
// the editor owns it; Terminals' own surfaces draw it
// (`shortcutKeys(id, { terminal: true })`), the sheet draws both.

import { formatKeys, isWindows, mod, platform, type Platform } from "./platform.ts";

export type ShortcutId =
  | "palette"
  | "files"
  | "text"
  | "history"
  | "shortcuts"
  | "shortcutsInEditor"
  | "sidebar"
  | "settings"
  | "workspaceN"
  | "modeInbox"
  | "modeBoard"
  | "modeCode"
  | "modeTerminals"
  | "modeHistory"
  | "modeLibrary"
  | "notes"
  | "newShell"
  | "newClaude"
  | "newCodex"
  | "copyInTerminal"
  | "pasteInTerminal"
  | "closeTab"
  | "nextTile"
  | "previousTile"
  | "nextTilePage"
  | "previousTilePage"
  | "expandTile"
  | "closeTile"
  | "resume"
  | "comparePass"
  | "save"
  | "saveAll"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "boardNextCard"
  | "boardColumn"
  | "boardMoveCard"
  | "boardAskColumn"
  | "boardCardMenu"
  | "rescanFiles"
  | "findCard"
  | "newCard"
  | "renameWorkspace"
  | "escape"
  | "quit";

export type ShortcutGroup = "Search" | "Go to" | "Board" | "Terminals and files" | "Window";

/** A key press, as much of a KeyboardEvent as the matcher reads. */
export interface KeyPress {
  key: string;
  code?: string;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey?: boolean;
  /** A KeyboardEvent's own; reads AltGr on Windows. */
  getModifierState?: (key: string) => boolean;
  /** A KeyboardEvent's own: 3 is the numeric keypad. */
  location?: number;
}

interface Chord {
  /** `event.key`, lower-cased; or a test on it. */
  key?: string | RegExp;
  /** `event.code` — with ⌥ held, macOS rewrites `key` to the alt character. */
  code?: string;
  shift: boolean | "any";
  alt: boolean | "any";
  /** ⌃ must not be held (⌘P only). */
  noCtrl?: boolean;
}

export interface Shortcut {
  id: ShortcutId;
  /** As drawn: ⌘ ⌥ ⇧ then the key. */
  keys: string;
  /** What it does, in words. */
  label: string;
  group: ShortcutGroup;
  /** The ⌘ chord App.tsx's global handler answers. Absent: the key is
   *  answered where it is used (a field, a list, a sheet). */
  chord?: Chord;
  /** GH #322: answered, never listed — a retired key kept for muscle memory
   *  whose place has its own shortcut. */
  hidden?: boolean;
  /** W4: listed on Windows only. */
  windowsOnly?: boolean;
  /** Listed on the Mac only: a chord that does not work on Windows. */
  macOnly?: boolean;
  /** QoL 1.168 (M5): Windows' own keys and chord, where the Mac's would
   *  collide with a shell's (PowerShell's PSReadLine takes
   *  Ctrl+Shift+Enter). */
  windows?: { keys: string; chord: Chord };
  /** 1.174.0 E5 (D5 b): on Windows, the form that also works with the
   *  cursor in a terminal, where a plain Ctrl letter is the program's.
   *  `chord` absent: another entry's chord answers it (Restore is
   *  Ctrl+Shift+M, the tile's expand). `notInEditor`: Code's editor owns
   *  that chord (CodeMirror's delete line, go to the matching bracket), so
   *  there it is the editor's. */
  windowsInTerminal?: { keys: string; chord?: Chord; notInEditor?: boolean };
  /** Listed only, answered by the terminal itself (`terminalKeys.ts`): the
   *  keys as Windows writes them out. */
  windowsKeysText?: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  // Search — the one ⌘K surface and its scopes (UX-3.6).
  // E5: Ctrl+Shift+K from a terminal; in Code's editor it is CodeMirror's
  // delete line, and Ctrl+K (which the editor doesn't use) works there.
  { id: "palette", keys: "⌘K", label: "Search and commands", group: "Search", chord: { key: "k", shift: false, alt: "any" }, windowsInTerminal: { keys: "⌘⇧K", chord: { key: "k", shift: true, alt: false }, notInEditor: true } },
  { id: "files", keys: "⌘P", label: "Go to file", group: "Search", chord: { key: "p", shift: false, alt: false, noCtrl: true }, windowsInTerminal: { keys: "⌘⇧P", chord: { key: "p", shift: true, alt: false } } },
  { id: "text", keys: "⌘⇧F", label: "Search text in files", group: "Search", chord: { key: "f", shift: true, alt: "any" } },
  { id: "history", keys: "⌘⇧H", label: "Search inside past sessions", group: "Search", chord: { key: "h", shift: true, alt: "any" } },
  { id: "rescanFiles", keys: "⌘R", label: "Re-scan the files (in Go to file)", group: "Search" },
  // UX-5.7: answered by the Board on screen, not the global handler — ⌘F
  // elsewhere still belongs to whatever has focus.
  { id: "findCard", keys: "/ or ⌘F", label: "Find a card (on the Board)", group: "Search" },
  // QoL 1.168 (C6, block 5.4): a new card from anywhere — the Board opens
  // with its new-card field, as ⌘K › New card… does.
  { id: "newCard", keys: "⌘⇧N", label: "New card (on the Board)", group: "Go to", chord: { key: "n", shift: true, alt: false } },

  // Go to — the sidebar's places.
  { id: "workspaceN", keys: "⌘1–9", label: "Switch to workspace 1–9", group: "Go to", chord: { key: /^[1-9]$/, shift: false, alt: false } },
  { id: "modeInbox", keys: "⌘⌥1", label: "Inbox", group: "Go to", chord: { code: "Digit1", shift: "any", alt: true } },
  { id: "modeBoard", keys: "⌘⌥2", label: "Board", group: "Go to", chord: { code: "Digit2", shift: "any", alt: true } },
  { id: "modeCode", keys: "⌘⌥3", label: "Code", group: "Go to", chord: { code: "Digit3", shift: "any", alt: true } },
  { id: "modeTerminals", keys: "⌘⌥4", label: "Terminals", group: "Go to", chord: { code: "Digit4", shift: "any", alt: true } },
  { id: "modeHistory", keys: "⌘⌥5", label: "History", group: "Go to", chord: { code: "Digit5", shift: "any", alt: true } },
  { id: "modeLibrary", keys: "⌘⌥6", label: "Library", group: "Go to", chord: { code: "Digit6", shift: "any", alt: true } },
  // GH #96 kept ⌘⇧E for the Library's Notes; UX-9.5 retired Notes. It still
  // opens the Library for muscle memory, but the Library has one shortcut
  // and one name (GH #322), so it is not listed.
  { id: "notes", keys: "⌘⇧E", label: "Library", group: "Go to", chord: { key: "e", shift: true, alt: "any" }, hidden: true },

  // QoL 1.168 (block 10, C6): the Board by keyboard, answered by a focused
  // card (lib/boardKeys) — not the global handler.
  { id: "boardNextCard", keys: "↑ ↓ or J K", label: "The card above or below (on the Board)", group: "Board" },
  { id: "boardColumn", keys: "← →", label: "The card in the column beside (on the Board)", group: "Board" },
  { id: "boardMoveCard", keys: "⌥↑ ⌥↓", label: "Move the card up or down its column (on the Board)", group: "Board" },
  { id: "boardAskColumn", keys: "⌥← ⌥→", label: "Move the card to the column beside, or hear why it stays (on the Board)", group: "Board" },
  { id: "boardCardMenu", keys: "⇧F10", label: "The card's menu: Open, Move, Archive, Delete (on the Board)", group: "Board" },

  // Terminals and files.
  // QoL 1.168 (D3): the kind Settings › Terminals › What a new tile opens
  // chooses — a shell unless it says otherwise.
  // E5: Ctrl+Alt+T from a terminal (Ctrl+Shift+T is New Claude session),
  // matched on `code` with Save all's AltGr guard.
  { id: "newShell", keys: "⌘T", label: "New tile (a shell, or the kind Settings chooses)", group: "Terminals and files", chord: { key: "t", shift: false, alt: "any" }, windowsInTerminal: { keys: "⌘⌥T", chord: { code: "KeyT", shift: false, alt: true } } },
  { id: "newClaude", keys: "⌘⇧T", label: "New Claude session", group: "Terminals and files", chord: { key: "t", shift: true, alt: "any" } },
  // Post-1.167 block A: Codex had no shortcut, so the empty Terminals page
  // (which offers the ones that have) left Codex out.
  { id: "newCodex", keys: "⌘⇧X", label: "New Codex session", group: "Terminals and files", chord: { key: "x", shift: true, alt: "any" } },
  // E5 (P22): listed only — a terminal answers them itself (terminalKeys.ts).
  { id: "copyInTerminal", keys: "⌘C", label: "Copy in a terminal", group: "Terminals and files", windowsKeysText: "Ctrl+Shift+C, or Ctrl+C on a selection" },
  { id: "pasteInTerminal", keys: "⌘V", label: "Paste in a terminal", group: "Terminals and files", windowsKeysText: "Ctrl+Shift+V, or Ctrl+V" },
  // QoL 1.168 S1-1: ⌘W closes a file only while Code is on screen, and asks
  // first when it has unsaved changes (the tab's × path).
  // E5: from a terminal, Restore is the tile's Ctrl+Shift+M (expandTile).
  { id: "closeTab", keys: "⌘W", label: "Restore an expanded tile, or close the file in Code", group: "Terminals and files", chord: { key: "w", shift: false, alt: "any" }, windowsInTerminal: { keys: "⌘⇧M" } },
  // QoL 1.168 (D8): tiles by keyboard, answered while Terminals is on
  // screen. Shift chords, so on Windows they still reach Plyloft from inside
  // a terminal (`terminalOwnsChord`); the brackets are matched on `code`,
  // the key beside P on any layout.
  { id: "nextTile", keys: "⌘⇧]", label: "Next tile (in Terminals)", group: "Terminals and files", chord: { code: "BracketRight", shift: true, alt: false } },
  { id: "previousTile", keys: "⌘⇧[", label: "Previous tile (in Terminals)", group: "Terminals and files", chord: { code: "BracketLeft", shift: true, alt: false } },
  // Walk (Windows, Italian keyboard): brackets need AltGr there, so the
  // bracket chords cannot be typed. Page Down / Page Up work on any layout
  // (xterm's own scrolling is Shift+Page, without the modifier).
  { id: "nextTilePage", keys: "⌘⇧PageDown", label: "Next tile, on any keyboard layout (in Terminals)", group: "Terminals and files", chord: { key: "pagedown", shift: true, alt: false } },
  { id: "previousTilePage", keys: "⌘⇧PageUp", label: "Previous tile, on any keyboard layout (in Terminals)", group: "Terminals and files", chord: { key: "pageup", shift: true, alt: false } },
  // Windows: Ctrl+Shift+Enter is PSReadLine's InsertLineBelow, so the tile
  // takes Ctrl+Shift+M (maximise) there.
  { id: "expandTile", keys: "⌘⇧Enter", label: "Expand the tile, or show the grid (in Terminals)", group: "Terminals and files", chord: { key: "enter", shift: true, alt: false }, windows: { keys: "⌘⇧M", chord: { key: "m", shift: true, alt: false } } },
  { id: "closeTile", keys: "⌘⇧W", label: "Close the tile (in Terminals; asks only if it is working)", group: "Terminals and files", chord: { key: "w", shift: true, alt: false } },
  // 1.177.0 Compare: opens the relay bar's composer for the direction on
  // offer (answered while Terminals shows its bar). ⌘⇧←/→ would collide with
  // extending a text selection by line in every field (the note, the editor)
  // and Ctrl+Shift+arrows with word selection on Windows; Y is free on both
  // (nothing binds ⌘⇧Y or Ctrl+Shift+Y here, in xterm, or in the editor).
  { id: "comparePass", keys: "⌘⇧Y", label: "Compare: pass the last answer to the other tile (when Compare is on, in Terminals; with two pairs, in the pair you're working in)", group: "Terminals and files", chord: { key: "y", shift: true, alt: false }, windowsInTerminal: { keys: "⌘⇧Y", chord: { key: "y", shift: true, alt: false } } },
  { id: "resume", keys: "⌘⇧R", label: "Resume an earlier conversation", group: "Terminals and files", chord: { key: "r", shift: true, alt: false } },
  // QoL 1.168 E4: ⌘S anywhere in Code (the text answers it itself), and
  // Save all. ⌥ is matched on `code`: with it held, `key` is the alt letter.
  { id: "save", keys: "⌘S", label: "Save the file (in Code)", group: "Terminals and files", chord: { key: "s", shift: false, alt: false } },
  { id: "saveAll", keys: "⌘⌥S", label: "Save all files (in Code)", group: "Terminals and files", chord: { code: "KeyS", shift: false, alt: true } },
  // QoL 1.168 (block 10, A7): the text size of what has focus — a terminal
  // or the editor — answered there (`lib/textSize`), not by the global
  // handler: elsewhere the keys do nothing.
  { id: "zoomIn", keys: "⌘=", label: "Larger text (in a terminal or the editor)", group: "Terminals and files" },
  { id: "zoomOut", keys: "⌘−", label: "Smaller text (in a terminal or the editor)", group: "Terminals and files" },
  { id: "zoomReset", keys: "⌘0", label: "Text back to its usual size (in a terminal or the editor)", group: "Terminals and files" },

  // The window.
  // E5: Ctrl+\ stays the shell's quit signal; Ctrl+Shift+\ types "|" on a
  // US and an Italian keyboard alike. In the editor it is CodeMirror's.
  { id: "sidebar", keys: "⌘\\", label: "Show or hide the sidebar", group: "Window", chord: { key: "\\", shift: false, alt: false }, windowsInTerminal: { keys: "⌘⇧\\", chord: { key: /^[\\|]$/, shift: true, alt: false }, notInEditor: true } },
  // E5: Shift turns "," into "<" (";" on an Italian keyboard): the key's
  // code, named as the layout prints it (";" on a French one: `keyName`).
  { id: "settings", keys: "⌘,", label: "Settings", group: "Window", chord: { key: ",", shift: "any", alt: "any" }, windowsInTerminal: { keys: "⌘⇧,", chord: { code: "Comma", shift: true, alt: false } } },
  // QoL 3.4 (E6): in the editor, ⌘/ is CodeMirror's comment toggle
  // (`matchShortcut`'s `inEditor`), and ⌘? (Shift added) opens this sheet
  // there. Shift is free on purpose: on an Italian keyboard / is ⇧7.
  { id: "shortcuts", keys: "⌘/", label: "Keyboard shortcuts (outside the editor; from anywhere, Search and commands › Keyboard shortcuts)", group: "Window", chord: { key: /^[/?]$/, shift: "any", alt: false } },
  // Listed only: answered by the chord above (Shift is free there).
  // QoL walk of block 6: ⌘⇧/ is a US keyboard's; on an Italian one it is not
  // a key at all (⌘? is macOS's Help search). The sheet names the way that
  // works everywhere — Help › Keyboard Shortcuts on the Mac, Search and
  // commands (⌘K) › Keyboard shortcuts on Windows, where there is no menu.
  { id: "shortcutsInEditor", keys: "⌘⇧/", label: "Keyboard shortcuts from the editor, on a US keyboard (on any keyboard: Help › Keyboard Shortcuts)", group: "Window", macOnly: true },
  { id: "renameWorkspace", keys: "F2", label: "Rename the workspace (in the switcher)", group: "Window" },
  { id: "escape", keys: "Esc", label: "Close a menu, a sheet or search", group: "Window" },
  // W4: Windows only — closing the window hides it to the tray, and there is
  // no app menu with a Quit. Answered by App.tsx (`isQuitChord`); the Mac's
  // ⌘Q is its app menu's.
  { id: "quit", keys: "⌘⇧Q", label: "Quit Plyloft", group: "Window", windowsOnly: true },
];

/** The shortcuts the Mac's ⌘/ sheet lists: all but the hidden ones. */
export const LISTED_SHORTCUTS: readonly Shortcut[] = SHORTCUTS.filter(
  (s) => !s.hidden && !s.windowsOnly,
);

/** The shortcuts the sheet lists on `p`: the Mac's, plus Windows' own. */
export function listedShortcuts(p: Platform = platform()): readonly Shortcut[] {
  return p === "windows" ? SHORTCUTS.filter((s) => !s.hidden && !s.macOnly) : LISTED_SHORTCUTS;
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  "Search",
  "Go to",
  "Board",
  "Terminals and files",
  "Window",
];

export interface ShortcutKeysOptions {
  /** 1.174.0 E5: the form that works with the cursor in a terminal — for
   *  Terminals' own surfaces (New, its empty page). The same as the plain
   *  form on the Mac. */
  terminal?: boolean;
}

/** The keys of a shortcut as the platform draws them ("⌘⇧F",
 *  "Ctrl+Shift+F"); "" for an unknown id. */
export function shortcutKeys(id: ShortcutId | string, options: ShortcutKeysOptions = {}): string {
  const s = SHORTCUTS.find((x) => x.id === id);
  if (!s) return "";
  const win = isWindows();
  if (s.id === "shortcuts") {
    const keys = slashChordKeys();
    // E5: Shift is free on the sheet's chord; a terminal needs it.
    return formatKeys(win && options.terminal ? withShift(keys) : keys);
  }
  if (win && s.windowsKeysText) return s.windowsKeysText;
  if (win && options.terminal && s.windowsInTerminal) {
    const t = s.windowsInTerminal;
    // Polish: a key matched on `code` outside the letters and digits is
    // named as this keyboard prints it (Comma is ";" on AZERTY).
    const code = t.chord?.code;
    const name = code && !/^(Key|Digit)/.test(code) ? keyName(code) : null;
    return formatKeys(name ? t.keys.replace(/[^⌘⌥⇧]+$/, name) : t.keys);
  }
  return formatKeys(win && s.windows ? s.windows.keys : s.keys);
}

/** ⌘/ → ⌘⇧/ (each chord of "⌘/ or ⌘⇧7"); one that has Shift keeps it. */
function withShift(keys: string): string {
  return keys
    .split(" or ")
    .map((k) => (k.startsWith("⌘") && !k.startsWith("⌘⇧") ? `⌘⇧${k.slice(1)}` : k))
    .join(" or ");
}

/** 1.174.0 E5 (P22): a row of the shortcuts sheet. On Windows a shortcut
 *  whose terminal form differs shows both ("Ctrl+K · in a terminal
 *  Ctrl+Shift+K"); everywhere else, its keys. */
export function sheetKeys(id: ShortcutId | string): string {
  const plain = shortcutKeys(id);
  if (!isWindows()) return plain;
  const terminal = shortcutKeys(id, { terminal: true });
  return terminal === plain ? plain : `${plain} · in a terminal ${terminal}`;
}

// ── The "/" of this keyboard (1.169.0, C5) ───────────────────────────────
// The sheet opens with ⌘ (Ctrl) and whatever key types "/" here: "/" on a
// US keyboard, ⇧7 on an Italian one. The key is learned from a "/" the
// member types anywhere (its `code`, and whether Shift made it), kept for
// this computer, and the sheet and every hint name it ("⌘⇧7").

export interface SlashKey {
  code: string;
  shift: boolean;
}

const SLASH_KEY_STORE = "ply.slashKey";
let slashKey: SlashKey | null | undefined;

function storedSlashKey(): SlashKey | null {
  if (slashKey !== undefined) return slashKey;
  slashKey = null;
  try {
    const raw = globalThis.localStorage?.getItem(SLASH_KEY_STORE);
    const parsed = raw ? (JSON.parse(raw) as Partial<SlashKey>) : null;
    if (parsed && typeof parsed.code === "string" && typeof parsed.shift === "boolean") {
      slashKey = { code: parsed.code, shift: parsed.shift };
    }
  } catch {
    // No storage (a private window, a test): the US default.
  }
  return slashKey;
}

/** Note a key the member typed: a "/" without ⌘/Ctrl or ⌥ tells which key
 *  makes it on this keyboard. */
export function noteTypedKey(e: KeyPress): void {
  // Mac walk (C5): the key in the US "/" place that types something else
  // ("-" on an Italian Mac) says this keyboard isn't US, before any "/".
  if (e.code === "Slash" && e.key !== "/" && e.key !== "?" && !e.altKey && e.key.length === 1) noteNotUsLayout();
  if (e.key !== "/" || !e.code || e.metaKey || e.ctrlKey || e.altKey) return;
  // Challenger (C5): the keypad's "/" is on every keyboard; it says nothing
  // about the main block's.
  if (e.location === 3 || e.code.startsWith("Numpad")) return;
  learnSlashKey({ code: e.code, shift: e.shiftKey });
}

function learnSlashKey(next: SlashKey): void {
  const known = storedSlashKey();
  if (known && known.code === next.code && known.shift === next.shift) return;
  slashKey = next;
  try {
    globalThis.localStorage?.setItem(SLASH_KEY_STORE, JSON.stringify(next));
  } catch {
    // Kept for this session only.
  }
}

const NOT_US_STORE = "ply.slashKeyNotUs";
let notUs: boolean | undefined;

function seenNotUs(): boolean {
  if (notUs !== undefined) return notUs;
  notUs = false;
  try {
    notUs = globalThis.localStorage?.getItem(NOT_US_STORE) === "1";
  } catch {
    // No storage: not known.
  }
  return notUs;
}

function noteNotUsLayout(): void {
  if (seenNotUs()) return;
  notUs = true;
  try {
    globalThis.localStorage?.setItem(NOT_US_STORE, "1");
  } catch {
    // Kept for this session only.
  }
}

/** For tests: forget (or set) the learned key, and the not-US hint. */
export function setSlashKeyForTests(key: SlashKey | null, notUsLayout = false): void {
  slashKey = key;
  notUs = notUsLayout;
}

/** What each key prints on this keyboard, from the browser's layout map
 *  (WebView2 has it; WebKit does not): `code` → its unshifted character. */
let layoutNames: ReadonlyMap<string, string> | null = null;

/** For tests: set (or forget) the layout map. */
export function setLayoutNamesForTests(names: ReadonlyMap<string, string> | null): void {
  layoutNames = names;
}

interface LayoutMapKeyboard {
  getLayoutMap?: () => Promise<ReadonlyMap<string, string>>;
}

/** Challenger (C5): read the keyboard's layout once at start, where the
 *  browser offers it (Windows' WebView2), so the sheet's chord is named
 *  before anything is typed: a key that prints "/" unshifted is the key.
 *  A key learned from typing still wins. */
export async function learnKeyboardLayout(): Promise<void> {
  const keyboard = (globalThis.navigator as { keyboard?: LayoutMapKeyboard } | undefined)?.keyboard;
  if (!keyboard?.getLayoutMap) return;
  try {
    const map = await keyboard.getLayoutMap();
    layoutNames = map;
    if (storedSlashKey()) return;
    for (const [code, printed] of map) {
      if (printed === "/" && !code.startsWith("Numpad")) {
        slashKey = { code, shift: false };
        return;
      }
    }
  } catch {
    // Not allowed here (a frame, a test): typing teaches it.
  }
}

/** A key's name on a US keyboard, by `code`, for one the layout map does
 *  not name. */
const US_KEY_NAMES: Record<string, string> = {
  Slash: "/",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Backquote: "`",
  IntlBackslash: "<",
  IntlRo: "\\",
  IntlYen: "¥",
};

/** The key's name as this keyboard prints it. */
function keyName(code: string): string | null {
  const printed = layoutNames?.get(code);
  if (printed && printed.trim()) return printed.toUpperCase();
  return /^Digit(\d)$/.exec(code)?.[1] ?? /^Key([A-Z])$/.exec(code)?.[1] ?? US_KEY_NAMES[code] ?? null;
}

/** The sheet's own chord, in the Mac's glyphs: "⌘/" until this keyboard's
 *  "/" is known, then that key as the keyboard names it ("⌘⇧7"). */
export function slashChordKeys(): string {
  const key = storedSlashKey();
  // Mac walk (C5): not learned, on a keyboard known not to be US (WebKit
  // has no layout map): both, the Italian chord named.
  if (!key) return seenNotUs() ? "⌘/ or ⌘⇧7" : "⌘/";
  if (key.code === "Slash" && !key.shift) return "⌘/";
  const name = keyName(key.code);
  if (!name) return "⌘/";
  return `⌘${key.shift ? "⇧" : ""}${name}`;
}

/** Whether `e` is ⌘ (Ctrl) with this keyboard's "/" key: the produced "/"
 *  (any Shift), or the learned key — WebKit reports an Italian ⌘⇧7 as key
 *  "7" — or that Italian chord itself. */
function isSlashChord(e: KeyPress): boolean {
  if (e.altKey) return false;
  // Mac walk (C5): the Italian ⌘⇧7 that opens the sheet before anything was
  // learned teaches the key, so every label then names it.
  if (!storedSlashKey() && isItalianCommentChord(e)) learnSlashKey({ code: "Digit7", shift: true });
  if (e.key === "/" || e.key === "?") return true;
  const key = storedSlashKey();
  if (key && e.code === key.code && e.shiftKey === key.shift) return true;
  // Challenger (C5): the Italian chord always, learned key or not (a key
  // learned on another layout must not take it away).
  return isItalianCommentChord(e);
}

function flagOk(want: boolean | "any", held: boolean): boolean {
  return want === "any" || want === held;
}

/** Where a key press happened, when that changes the answer. */
export interface MatchContext {
  /** Focus is in a terminal tile. */
  inTerminal?: boolean;
  /** QoL 3.4 (E6): focus is in Code's editor, whose ⌘/ comments a line. */
  inEditor?: boolean;
}

/** On Windows, a Ctrl chord a terminal needs: plain Ctrl and a key other
 *  than a digit. Ctrl+K, Ctrl+P, Ctrl+T, Ctrl+W, Ctrl+R and Ctrl+\ are the
 *  shell's line editing and signals there, so in a terminal they go to the
 *  shell; the Shift, Alt and digit chords stay Ply's (1.174.0 E5: each
 *  plain one has its `windowsInTerminal` form). The Mac never needs this:
 *  ⌘ is not a terminal key. */
export function terminalOwnsChord(e: KeyPress): boolean {
  return !e.shiftKey && !e.altKey && !/^[0-9]$/.test(e.key);
}

/** QoL walk of block 6: an Italian keyboard's ⌘/ — ⌘⇧7, which real WebKit
 *  reports as key "7" (or "/") with Shift and code Digit7. CodeMirror's own
 *  Mod-/ never sees a "/" there, so the editor answers this one itself
 *  (Toggle comment). On a US keyboard ⌘⇧7 is bound to nothing. */
export function isItalianCommentChord(e: KeyPress): boolean {
  return mod(e) && e.shiftKey && !e.altKey && e.code === "Digit7" && (e.key === "7" || e.key === "/");
}

/** Which global shortcut `e` is (⌘ on the Mac, Ctrl on Windows), or null.
 *  First match wins, in list order of the ⌥-digit modes, the digits, then
 *  the rest. */
export function matchShortcut(e: KeyPress, context: MatchContext = {}): ShortcutId | null {
  if (!mod(e)) return null;
  const win = isWindows();
  if (win && context.inTerminal && terminalOwnsChord(e)) return null;
  // AltGr is Ctrl+Alt on Windows: it types `@`, `#` or `{` on many layouts
  // and is never a shortcut.
  // Fallback kept ready (1.174.0 E5, for the Italian-keyboard walk): if
  // WebView2 reports AltGraph for a left Ctrl+Alt too, Ctrl+Alt+T and
  // Save all's Ctrl+Alt+S never match. Then skip this return for chords
  // matched on a Key/Digit `code` — the `e.key` check below still refuses a
  // character typed through AltGr (the letter must be the key's own):
  //   const altGraph = win && e.getModifierState?.("AltGraph");
  //   ... and in the loop: if (altGraph && !(c.code && /^(Key|Digit)/.test(c.code))) continue;
  // Not switched on: the walk decides.
  if (win && e.getModifierState?.("AltGraph")) return null;
  const key = e.key.toLowerCase();
  // QoL 3.4 (E6): the editor's own ⌘/ (Toggle comment), Shift or not — an
  // Italian keyboard types / with ⇧7. ⌘? still opens the shortcuts there.
  // Challenger D4: WebKit can report ⌘⇧/ as key "/" with Shift held; the
  // physical / key (`code` Slash) with Shift is the sheet's ⌘? whatever
  // `key` says, so it never falls through to a comment.
  const shiftedSlashKey = e.shiftKey && e.code === "Slash";
  if (context.inEditor && key === "/" && !shiftedSlashKey) return null;
  // The ⌥ digits first (matched on `code`), then the plain digits, as the
  // handler always has: with ⌥ held, `key` is the alt character.
  // 1.169.0 (C5): the sheet's chord is this keyboard's "/" (outside the
  // editor, where ⌘/ comments a line; there ⌘? still opens it above).
  if (!context.inEditor && isSlashChord(e)) return "shortcuts";
  const chords: Array<{ s: Shortcut; c: Chord }> = [];
  for (const s of SHORTCUTS) {
    const c = win && s.windows ? s.windows.chord : s.chord;
    if (c) chords.push({ s, c });
    // 1.174.0 E5: Windows' terminal form, wherever the editor doesn't own it.
    const t = win ? s.windowsInTerminal : undefined;
    if (t?.chord && !(t.notInEditor && context.inEditor)) chords.push({ s, c: t.chord });
  }
  const ordered = [...chords.filter((x) => x.c.code), ...chords.filter((x) => !x.c.code)];
  for (const { s, c } of ordered) {
    if (c.code) {
      if (e.code !== c.code) continue;
      // Windows leaves `key` the digit (or the letter, Ctrl+Alt+S); anything
      // else was typed through AltGr. A bracket's `key` is the layout's own
      // (`}`, `è`), so only digits and letters are checked.
      if (win && /^(Digit|Key)/.test(c.code) && e.key.toLowerCase() !== c.code.slice(-1).toLowerCase()) continue;
    } else if (c.key instanceof RegExp) {
      if (!c.key.test(e.key)) continue;
    } else if (c.key !== undefined && key !== c.key) {
      continue;
    }
    if (!flagOk(c.shift, e.shiftKey) || !flagOk(c.alt, e.altKey)) continue;
    // Ctrl is the modifier itself on Windows.
    if (c.noCtrl && !win && e.ctrlKey) continue;
    return s.id;
  }
  return null;
}

/** 1.174.0 E5: on Windows, the Plyloft shortcut a key in a terminal is in
 *  its terminal form (Ctrl+Shift+K, Ctrl+Shift+P, Ctrl+Alt+T,
 *  Ctrl+Shift+, and Ctrl+Shift+\), or null. App.tsx's handler answers it
 *  and stops it in the capture phase; a terminal keeps it from xterm as
 *  well, so it never also reaches the program as a control byte. Every
 *  other key — plain Ctrl letters above all — is the program's. Always null
 *  on the Mac. */
export function terminalFormShortcut(e: KeyPress): ShortcutId | null {
  if (!isWindows()) return null;
  const id = matchShortcut(e, { inTerminal: true });
  if (!id) return null;
  return SHORTCUTS.find((s) => s.id === id)?.windowsInTerminal?.chord ? id : null;
}
