// UX-3.7: every shortcut in one list; App.tsx's handler matches through it.
// Run with Node 22+:  node --experimental-strip-types src/lib/shortcuts.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LISTED_SHORTCUTS,
  listedShortcuts,
  isItalianCommentChord,
  matchShortcut,
  noteTypedKey,
  setSlashKeyForTests,
  setLayoutNamesForTests,
  learnKeyboardLayout,
  sheetKeys,
  terminalFormShortcut,
  slashChordKeys,
  SHORTCUT_GROUPS,
  SHORTCUTS,
  shortcutKeys,
  type KeyPress,
} from "./shortcuts.ts";
import { setPlatformForTests } from "./platform.ts";

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  key,
  metaKey: true,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  ...mods,
});

// One entry per id, every entry in a known group, keys drawn.
{
  const ids = SHORTCUTS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "no shortcut is listed twice");
  const keys = SHORTCUTS.map((s) => s.keys);
  assert.equal(new Set(keys).size, keys.length, "no two shortcuts share keys");
  for (const s of SHORTCUTS) {
    assert.ok(SHORTCUT_GROUPS.includes(s.group), `${s.id} is in a group`);
    assert.ok(s.keys.length > 0 && s.label.length > 0);
  }
}

// W4: Ctrl+Shift+Q is listed on Windows only and never matched here
// (App.tsx answers it before the list).
{
  assert.ok(!LISTED_SHORTCUTS.some((s) => s.id === "quit"), "the Mac's sheet has no quit");
  assert.deepEqual(listedShortcuts("mac"), LISTED_SHORTCUTS);
  const win = listedShortcuts("windows");
  // Windows adds its quit and leaves out the Mac-only ⌘⇧/ line.
  assert.equal(win.length, LISTED_SHORTCUTS.length);
  assert.ok(!win.some((s) => s.id === "shortcutsInEditor"));
  assert.equal(win.find((s) => s.id === "quit")?.label, "Quit Plyloft");
  assert.equal(matchShortcut(press("Q", { shiftKey: true })), null);
}

// The global handler's chords.
{
  assert.equal(matchShortcut(press("k")), "palette");
  assert.equal(matchShortcut(press("p")), "files");
  assert.equal(matchShortcut(press("p", { ctrlKey: true })), null);
  assert.equal(matchShortcut(press("F", { shiftKey: true })), "text");
  assert.equal(matchShortcut(press("f")), null, "⌘F belongs to whatever has focus");
  assert.equal(matchShortcut(press("H", { shiftKey: true })), "history");
  assert.equal(matchShortcut(press("E", { shiftKey: true })), "notes");
  assert.equal(matchShortcut(press("t")), "newShell");
  assert.equal(matchShortcut(press("T", { shiftKey: true })), "newClaude");
  assert.equal(matchShortcut(press("X", { shiftKey: true })), "newCodex");
  assert.equal(matchShortcut(press("Y", { shiftKey: true })), "comparePass"); // 1.177.0 Compare
  assert.equal(matchShortcut(press("w")), "closeTab");
  // QoL 1.168 E4: ⌘S and ⌘⌥S (⌥ rewrites `key` to "ß"; matched on `code`).
  assert.equal(matchShortcut(press("s", { code: "KeyS" })), "save");
  assert.equal(matchShortcut(press("ß", { altKey: true, code: "KeyS" })), "saveAll");
  assert.equal(matchShortcut(press("S", { shiftKey: true, code: "KeyS" })), null, "⌘⇧S is not Save");
  assert.equal(matchShortcut(press(",")), "settings");
  assert.equal(matchShortcut(press("\\")), "sidebar");
  assert.equal(matchShortcut(press("/")), "shortcuts");
  // QoL 3.4 (E6): in the editor ⌘/ is CodeMirror's comment toggle — also
  // on an Italian keyboard, where / is ⇧7 — and ⌘? opens the sheet there.
  const editor = { inEditor: true };
  assert.equal(matchShortcut(press("/"), editor), null);
  assert.equal(matchShortcut(press("/", { shiftKey: true }), editor), null);
  assert.equal(matchShortcut(press("?", { shiftKey: true }), editor), "shortcuts");
  assert.equal(matchShortcut(press("/", { shiftKey: true })), "shortcuts", "⇧7 on an Italian keyboard");
  assert.equal(matchShortcut(press("?", { shiftKey: true })), "shortcuts");
  assert.equal(matchShortcut(press("k"), editor), "palette", "the editor keeps the other shortcuts");
  // Challenger D4: ⌘⇧/ reported either way opens the sheet from the editor;
  // the Italian ⌘/ (⇧7, code Digit7) stays the editor's comment.
  assert.equal(matchShortcut(press("/", { shiftKey: true, code: "Slash" }), editor), "shortcuts");
  assert.equal(matchShortcut(press("?", { shiftKey: true, code: "Slash" }), editor), "shortcuts");
  assert.equal(matchShortcut(press("/", { shiftKey: true, code: "Digit7" }), editor), null);
  assert.equal(matchShortcut(press("/", { code: "Slash" }), editor), null);
  // QoL walk of block 6, real WebKit on an Italian keyboard: ⌘⇧7 comes as
  // key "7" (code Digit7) — the editor's comment, never a workspace jump.
  assert.equal(isItalianCommentChord(press("7", { shiftKey: true, code: "Digit7" })), true);
  assert.equal(isItalianCommentChord(press("/", { shiftKey: true, code: "Digit7" })), true);
  assert.equal(isItalianCommentChord(press("7", { code: "Digit7" })), false, "⌘7 is workspace 7");
  assert.equal(isItalianCommentChord(press("&", { shiftKey: true, code: "Digit7" })), false, "US ⌘⇧7");
  assert.equal(isItalianCommentChord(press("/", { code: "Slash" })), false, "US ⌘/ is CodeMirror's own");
  assert.equal(matchShortcut(press("7", { shiftKey: true, code: "Digit7" }), editor), null);
  // 1.169.0 (C5): outside the editor the sheet opens with this keyboard's
  // "/": WebKit's Italian ⌘⇧7 (key "7") before anything is learned too.
  setSlashKeyForTests(null);
  assert.equal(matchShortcut(press("7", { shiftKey: true, code: "Digit7" })), "shortcuts", "Italian ⌘⇧7");
  // (Mac walk: the chord teaches the key; forgotten here for the US check.)
  setSlashKeyForTests(null);
  assert.equal(matchShortcut(press("&", { shiftKey: true, code: "Digit7" })), null, "US ⌘⇧7 stays nothing");
  assert.equal(slashChordKeys(), "⌘/");
  // A "/" typed with ⇧7 teaches the key; the sheet then names it.
  noteTypedKey({ key: "/", code: "Digit7", metaKey: false, shiftKey: true, altKey: false, ctrlKey: false });
  assert.equal(slashChordKeys(), "⌘⇧7");
  assert.equal(shortcutKeys("shortcuts"), "⌘⇧7");
  assert.equal(matchShortcut(press("7", { shiftKey: true, code: "Digit7" })), "shortcuts");
  assert.equal(matchShortcut(press("7", { code: "Digit7" })), "workspaceN", "⌘7 is still workspace 7");
  // ⌘/ typed with ⌘ held, or through ⌥, teaches nothing.
  noteTypedKey({ key: "/", code: "Slash", metaKey: true, shiftKey: false, altKey: false });
  noteTypedKey({ key: "/", code: "KeyQ", metaKey: false, shiftKey: false, altKey: true });
  assert.equal(slashChordKeys(), "⌘⇧7");
  // A US "/" (the Slash key, no Shift): "⌘/".
  noteTypedKey({ key: "/", code: "Slash", metaKey: false, shiftKey: false, altKey: false, ctrlKey: false });
  assert.equal(slashChordKeys(), "⌘/");
  // ⌘- (zoom) is untouched.
  assert.equal(matchShortcut(press("-", { code: "Minus" })) === "shortcuts", false);
  // Windows draws it with Ctrl.
  setSlashKeyForTests({ code: "Digit7", shift: true });
  setPlatformForTests("windows");
  try {
    assert.equal(shortcutKeys("shortcuts"), "Ctrl+Shift+7");
    assert.equal(matchShortcut(press("/", { metaKey: false, ctrlKey: true, shiftKey: true, code: "Digit7" })), "shortcuts");
  } finally {
    setPlatformForTests(null);
    setSlashKeyForTests(null);
  }
  // Challenger (C5): the keypad's "/" teaches nothing; the Italian chord
  // stays the sheet's whatever was learned; a key outside the digits and
  // letters is named as this keyboard prints it.
  setSlashKeyForTests({ code: "Digit7", shift: true });
  noteTypedKey({ key: "/", code: "NumpadDivide", metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, location: 3 });
  assert.equal(slashChordKeys(), "⌘⇧7");
  setSlashKeyForTests({ code: "Minus", shift: true });
  assert.equal(matchShortcut(press("7", { shiftKey: true, code: "Digit7" })), "shortcuts", "Italian chord kept");
  assert.equal(slashChordKeys(), "⌘⇧-");
  setLayoutNamesForTests(new Map([["Minus", "'"]]));
  assert.equal(slashChordKeys(), "⌘⇧'", "named as the layout prints it");
  setLayoutNamesForTests(null);
  setSlashKeyForTests(null);
  assert.equal(matchShortcut(press("7", { code: "Digit7" })), "workspaceN");
  assert.equal(matchShortcut(press("3")), "workspaceN");
  assert.equal(matchShortcut(press("0")), null);
  // With ⌥ held macOS rewrites `key` ("¡"); the modes match on `code`.
  assert.equal(matchShortcut(press("¡", { altKey: true, code: "Digit1" })), "modeInbox");
  assert.equal(matchShortcut(press("™", { altKey: true, code: "Digit2" })), "modeBoard");
  assert.equal(matchShortcut(press("§", { altKey: true, code: "Digit6" })), "modeLibrary");
  assert.equal(matchShortcut(press("ª", { altKey: true, code: "Digit7" })), null);
  assert.equal(matchShortcut(press("k", { metaKey: false })), null, "no ⌘, no shortcut");
}

// Hints read their keys from the list.
{
  assert.equal(shortcutKeys("text"), "⌘⇧F");
  assert.equal(shortcutKeys("nope"), "");
}

// W5: Windows — Ctrl is the modifier, the hints spell it out, a terminal
// keeps the Ctrl keys its shell needs, and AltGr is never a shortcut.
setPlatformForTests("windows");
try {
  const ctrl = (key: string, mods: Partial<KeyPress> = {}): KeyPress =>
    press(key, { metaKey: false, ctrlKey: true, ...mods });
  assert.equal(matchShortcut(ctrl("k")), "palette");
  assert.equal(matchShortcut(ctrl("p")), "files", "Ctrl is the modifier, not the ⌃ ⌘P refuses");
  assert.equal(matchShortcut(ctrl("F", { shiftKey: true })), "text");
  assert.equal(matchShortcut(ctrl("T", { shiftKey: true })), "newClaude");
  assert.equal(matchShortcut(ctrl("X", { shiftKey: true })), "newCodex");
  assert.equal(matchShortcut(ctrl("w")), "closeTab");
  assert.equal(matchShortcut(ctrl("s", { code: "KeyS" })), "save");
  assert.equal(matchShortcut(ctrl("s", { altKey: true, code: "KeyS" })), "saveAll");
  assert.equal(matchShortcut(ctrl("3")), "workspaceN");
  assert.equal(matchShortcut(ctrl("1", { altKey: true, code: "Digit1" })), "modeInbox");
  assert.equal(matchShortcut(ctrl("\\")), "sidebar");
  assert.equal(matchShortcut(press("k")), null, "the Windows key is not the modifier");
  assert.equal(matchShortcut(ctrl("k", { metaKey: true })), null);

  // AltGr (Ctrl+Alt) types characters: `@` on Spanish Ctrl+Alt+2 is not the Board.
  assert.equal(matchShortcut(ctrl("@", { altKey: true, code: "Digit2" })), null);
  const altGr = { getModifierState: (k: string) => k === "AltGraph" };
  assert.equal(matchShortcut(ctrl("2", { altKey: true, code: "Digit2", ...altGr })), null);
  assert.equal(matchShortcut(ctrl("2", { altKey: true, code: "Digit2" })), "modeBoard");

  // In a terminal, plain Ctrl letters are the shell's (kill-line, history,
  // transpose, delete-word, SIGQUIT); Shift, Alt and digit chords stay Ply's.
  const term = { inTerminal: true };
  for (const k of ["k", "p", "t", "w", "\\", "/", ","]) {
    assert.equal(matchShortcut(ctrl(k), term), null, `Ctrl+${k} goes to the shell`);
  }
  assert.equal(matchShortcut(ctrl("T", { shiftKey: true }), term), "newClaude");
  assert.equal(matchShortcut(ctrl("X", { shiftKey: true }), term), "newCodex");
  assert.equal(matchShortcut(ctrl("F", { shiftKey: true }), term), "text");
  assert.equal(matchShortcut(ctrl("4", { altKey: true, code: "Digit4" }), term), "modeTerminals");
  assert.equal(matchShortcut(ctrl("2"), term), "workspaceN");

  assert.equal(shortcutKeys("text"), "Ctrl+Shift+F");
  assert.equal(shortcutKeys("modeBoard"), "Ctrl+Alt+2");
  assert.equal(shortcutKeys("findCard"), "/ or Ctrl+F");
  assert.equal(shortcutKeys("renameWorkspace"), "F2");
} finally {
  setPlatformForTests(null);
}

// The Mac again, with the context the handler passes: ⌘ is never the shell's.
assert.equal(matchShortcut(press("k"), { inTerminal: true }), "palette");
assert.equal(matchShortcut(press("w"), { inTerminal: true }), "closeTab");

// QoL 1.168 (D8): tiles by keyboard — Shift chords, so they reach Plyloft
// from inside a terminal on Windows too; ⌘W stays Restore/close the file.
{
  assert.equal(matchShortcut(press("}", { shiftKey: true, code: "BracketRight" })), "nextTile");
  assert.equal(matchShortcut(press("{", { shiftKey: true, code: "BracketLeft" })), "previousTile");
  // An Italian layout: the key beside P is è; the code is the same.
  assert.equal(matchShortcut(press("é", { shiftKey: true, code: "BracketLeft" })), "previousTile");
  assert.equal(matchShortcut(press("]", { code: "BracketRight" })), null, "⌘] alone is not a tile key");
  assert.equal(matchShortcut(press("Enter", { shiftKey: true })), "expandTile");
  assert.equal(matchShortcut(press("Enter")), null);
  assert.equal(matchShortcut(press("M", { shiftKey: true })), null, "⌘⇧M is Windows' only");
  assert.equal(shortcutKeys("expandTile"), "⌘⇧Enter");
  assert.equal(matchShortcut(press("W", { shiftKey: true })), "closeTile");
  assert.equal(matchShortcut(press("w")), "closeTab");
  assert.equal(matchShortcut(press("R", { shiftKey: true })), "resume");
  // Walk (Italian keyboard): Page Down / Page Up, on any layout.
  assert.equal(matchShortcut(press("PageDown", { shiftKey: true })), "nextTilePage");
  assert.equal(matchShortcut(press("PageUp", { shiftKey: true })), "previousTilePage");
  assert.equal(matchShortcut(press("PageDown")), null, "⌘PageDown alone is not a tile key");
  assert.equal(matchShortcut(press("r")), null, "⌘R stays Go to file's re-scan");
  setPlatformForTests("windows");
  try {
    const term = { inTerminal: true };
    const ctrl = (key: string, mods: Partial<KeyPress> = {}): KeyPress =>
      press(key, { metaKey: false, ctrlKey: true, ...mods });
    assert.equal(matchShortcut(ctrl("}", { shiftKey: true, code: "BracketRight" }), term), "nextTile");
    assert.equal(matchShortcut(ctrl("{", { shiftKey: true, code: "BracketLeft" }), term), "previousTile");
    // M5: Ctrl+Shift+Enter is PSReadLine's; the tile takes Ctrl+Shift+M.
    assert.equal(matchShortcut(ctrl("Enter", { shiftKey: true }), term), null);
    assert.equal(matchShortcut(ctrl("M", { shiftKey: true }), term), "expandTile");
    assert.equal(matchShortcut(ctrl("W", { shiftKey: true }), term), "closeTile");
    assert.equal(matchShortcut(ctrl("R", { shiftKey: true }), term), "resume");
    assert.equal(matchShortcut(ctrl("PageDown", { shiftKey: true }), term), "nextTilePage");
    assert.equal(matchShortcut(ctrl("PageUp", { shiftKey: true }), term), "previousTilePage");
    // xterm's own scrolling (Shift+Page, no Ctrl) is never Plyloft's.
    assert.equal(matchShortcut(press("PageUp", { metaKey: false, shiftKey: true }), term), null);
    assert.equal(shortcutKeys("nextTilePage"), "Ctrl+Shift+PageDown");
    assert.equal(matchShortcut(ctrl("]", { code: "BracketRight" }), term), null, "Ctrl+] is the shell's");
    assert.equal(shortcutKeys("expandTile"), "Ctrl+Shift+M");
    assert.equal(shortcutKeys("nextTile"), "Ctrl+Shift+]");
  } finally {
    setPlatformForTests(null);
  }
}

// 1.174.0 E5 (P22, D5 b): on Windows, Ctrl and a letter stay the program's
// in a terminal (PowerShell, Claude, Codex); Plyloft's own keys there add
// Shift, or Alt for a new tile. They work outside a terminal too, but not
// where Code's editor owns the chord. The Mac does not change.
{
  setPlatformForTests("windows");
  try {
    const ctrl = (key: string, mods: Partial<KeyPress> = {}): KeyPress =>
      press(key, { metaKey: false, ctrlKey: true, ...mods });
    const term = { inTerminal: true };
    const editor = { inEditor: true };
    // Plain Ctrl letters: the program's, as before.
    for (const k of ["k", "p", "t", "w", "r", "\\", ",", "/"]) {
      assert.equal(matchShortcut(ctrl(k, { code: k === "t" ? "KeyT" : undefined }), term), null, `Ctrl+${k} goes to the program`);
      assert.equal(terminalFormShortcut(ctrl(k)), null);
    }
    // Their terminal forms are Plyloft's.
    assert.equal(matchShortcut(ctrl("K", { shiftKey: true, code: "KeyK" }), term), "palette");
    assert.equal(matchShortcut(ctrl("P", { shiftKey: true, code: "KeyP" }), term), "files");
    assert.equal(matchShortcut(ctrl("t", { altKey: true, code: "KeyT" }), term), "newShell");
    assert.equal(matchShortcut(ctrl("T", { shiftKey: true, code: "KeyT" }), term), "newClaude", "Ctrl+Shift+T stays Claude");
    assert.equal(matchShortcut(ctrl("M", { shiftKey: true, code: "KeyM" }), term), "expandTile", "Restore is Ctrl+Shift+M");
    // Ctrl+Shift+, types "<" on a US keyboard and ";" on an Italian one.
    assert.equal(matchShortcut(ctrl("<", { shiftKey: true, code: "Comma" }), term), "settings");
    assert.equal(matchShortcut(ctrl(";", { shiftKey: true, code: "Comma" }), term), "settings");
    // Ctrl+Shift+\ types "|": the Backslash key on a US keyboard, the key
    // left of 1 on an Italian one.
    assert.equal(matchShortcut(ctrl("|", { shiftKey: true, code: "Backslash" }), term), "sidebar");
    assert.equal(matchShortcut(ctrl("|", { shiftKey: true, code: "Backquote" }), term), "sidebar");
    assert.equal(matchShortcut(ctrl("?", { shiftKey: true, code: "Slash" }), term), "shortcuts");
    // Outside a terminal both forms work.
    assert.equal(matchShortcut(ctrl("k")), "palette");
    assert.equal(matchShortcut(ctrl("K", { shiftKey: true })), "palette");
    assert.equal(matchShortcut(ctrl("P", { shiftKey: true })), "files");
    assert.equal(matchShortcut(ctrl("t", { altKey: true, code: "KeyT" })), "newShell");
    // AltGr (Ctrl+Alt on Windows) is never Ctrl+Alt+T — Save all's guard.
    const altGr = { getModifierState: (k: string) => k === "AltGraph" };
    assert.equal(matchShortcut(ctrl("t", { altKey: true, code: "KeyT", ...altGr }), term), null);
    assert.equal(matchShortcut(ctrl("t", { altKey: true, code: "KeyT", ...altGr })), null);
    assert.equal(terminalFormShortcut(ctrl("t", { altKey: true, code: "KeyT", ...altGr })), null);
    // A character typed through AltGr on that key is not a T either.
    assert.equal(matchShortcut(ctrl("ŧ", { altKey: true, code: "KeyT" }), term), null);
    // Code's editor: Ctrl+Shift+K deletes the line and Ctrl+Shift+\ goes to
    // the matching bracket (CodeMirror); Ctrl+K and Ctrl+\ work there.
    assert.equal(matchShortcut(ctrl("K", { shiftKey: true }), editor), null);
    assert.equal(matchShortcut(ctrl("|", { shiftKey: true, code: "Backslash" }), editor), null);
    assert.equal(matchShortcut(ctrl("k"), editor), "palette");
    assert.equal(matchShortcut(ctrl("\\"), editor), "sidebar");
    assert.equal(matchShortcut(ctrl("P", { shiftKey: true }), editor), "files");
    assert.equal(matchShortcut(ctrl("<", { shiftKey: true, code: "Comma" }), editor), "settings");
    // What a terminal keeps from xterm: only the terminal forms.
    assert.equal(terminalFormShortcut(ctrl("K", { shiftKey: true })), "palette");
    assert.equal(terminalFormShortcut(ctrl("P", { shiftKey: true })), "files");
    assert.equal(terminalFormShortcut(ctrl("t", { altKey: true, code: "KeyT" })), "newShell");
    assert.equal(terminalFormShortcut(ctrl("<", { shiftKey: true, code: "Comma" })), "settings");
    assert.equal(terminalFormShortcut(ctrl("|", { shiftKey: true, code: "Backslash" })), "sidebar");
    // 1.177.0 Compare: Ctrl+Shift+Y reaches Plyloft from a terminal, never the program.
    assert.equal(terminalFormShortcut(ctrl("Y", { shiftKey: true })), "comparePass");
    assert.equal(matchShortcut(ctrl("y")), null);
    assert.equal(terminalFormShortcut(ctrl("C", { shiftKey: true })), null, "Ctrl+Shift+C is the terminal's copy");
    assert.equal(terminalFormShortcut(ctrl("V", { shiftKey: true })), null, "Ctrl+Shift+V is the terminal's paste");
    assert.equal(terminalFormShortcut(press("x", { metaKey: false })), null);

    // The keys Terminals draws, and the sheet's two forms.
    assert.equal(shortcutKeys("newShell"), "Ctrl+T");
    assert.equal(shortcutKeys("newShell", { terminal: true }), "Ctrl+Alt+T");
    assert.equal(shortcutKeys("palette", { terminal: true }), "Ctrl+Shift+K");
    assert.equal(shortcutKeys("files", { terminal: true }), "Ctrl+Shift+P");
    assert.equal(shortcutKeys("closeTab", { terminal: true }), "Ctrl+Shift+M");
    assert.equal(shortcutKeys("settings", { terminal: true }), "Ctrl+Shift+,");
    // Polish: the key named as the layout prints it — ";" on AZERTY.
    setLayoutNamesForTests(new Map([["Comma", ";"]]));
    assert.equal(shortcutKeys("settings", { terminal: true }), "Ctrl+Shift+;");
    assert.equal(sheetKeys("settings"), "Ctrl+, · in a terminal Ctrl+Shift+;");
    setLayoutNamesForTests(new Map([["Comma", ","]]));
    assert.equal(shortcutKeys("settings", { terminal: true }), "Ctrl+Shift+,");
    setLayoutNamesForTests(null);
    // Letters are never renamed from the map.
    setLayoutNamesForTests(new Map([["KeyT", "z"]]));
    assert.equal(shortcutKeys("newShell", { terminal: true }), "Ctrl+Alt+T");
    setLayoutNamesForTests(null);
    assert.equal(shortcutKeys("sidebar", { terminal: true }), "Ctrl+Shift+\\");
    assert.equal(shortcutKeys("newClaude", { terminal: true }), "Ctrl+Shift+T");
    assert.equal(shortcutKeys("resume", { terminal: true }), "Ctrl+Shift+R");
    assert.equal(shortcutKeys("shortcuts", { terminal: true }), "Ctrl+Shift+/");
    setSlashKeyForTests({ code: "Digit7", shift: true });
    assert.equal(shortcutKeys("shortcuts", { terminal: true }), "Ctrl+Shift+7", "an Italian / already has Shift");
    setSlashKeyForTests(null, true);
    assert.equal(shortcutKeys("shortcuts", { terminal: true }), "Ctrl+Shift+/ or Ctrl+Shift+7");
    setSlashKeyForTests(null);
    assert.equal(sheetKeys("palette"), "Ctrl+K · in a terminal Ctrl+Shift+K");
    assert.equal(sheetKeys("newShell"), "Ctrl+T · in a terminal Ctrl+Alt+T");
    assert.equal(sheetKeys("newClaude"), "Ctrl+Shift+T");
    assert.equal(shortcutKeys("copyInTerminal"), "Ctrl+Shift+C, or Ctrl+C on a selection");
    assert.equal(shortcutKeys("pasteInTerminal", { terminal: true }), "Ctrl+Shift+V, or Ctrl+V");
    assert.equal(sheetKeys("copyInTerminal"), "Ctrl+Shift+C, or Ctrl+C on a selection");
    // Listed only: nothing matches a copy or paste row.
    assert.ok(!SHORTCUTS.find((s) => s.id === "copyInTerminal")?.chord);
    assert.ok(!SHORTCUTS.find((s) => s.id === "pasteInTerminal")?.chord);
  } finally {
    setPlatformForTests(null);
    setSlashKeyForTests(null);
  }
  // The Mac: one form, no new chord, nothing kept from a terminal.
  assert.equal(shortcutKeys("newShell", { terminal: true }), "⌘T");
  assert.equal(shortcutKeys("palette", { terminal: true }), "⌘K");
  assert.equal(shortcutKeys("shortcuts", { terminal: true }), "⌘/");
  assert.equal(sheetKeys("palette"), "⌘K");
  assert.equal(shortcutKeys("copyInTerminal"), "⌘C");
  assert.equal(shortcutKeys("pasteInTerminal"), "⌘V");
  assert.equal(matchShortcut(press("K", { shiftKey: true })), null, "⌘⇧K stays nothing on the Mac");
  assert.equal(matchShortcut(press("P", { shiftKey: true })), null);
  assert.equal(matchShortcut(press("|", { shiftKey: true, code: "Backslash" })), null);
  assert.equal(matchShortcut(press("k"), { inTerminal: true }), "palette");
  assert.equal(terminalFormShortcut(press("K", { shiftKey: true })), null);
  assert.equal(terminalFormShortcut(press("k")), null);
  assert.ok(LISTED_SHORTCUTS.some((s) => s.id === "copyInTerminal"), "the Mac's sheet lists ⌘C");
}

// App.tsx's handler goes through the list, and the sheet draws it.
{
  const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
  assert.match(app, /matchShortcut\(e[,)]/, "App.tsx asks the list which shortcut a key is");
  const sheet = readFileSync(new URL("../components/ShortcutsSheet.tsx", import.meta.url), "utf8");
  assert.match(sheet, /SHORTCUTS/, "the ⌘/ sheet draws the same list");
}

// 1.169.0 Mac walk (C5): an Italian Mac (no layout map in WebKit).
{
  setSlashKeyForTests(null);
  assert.equal(slashChordKeys(), "⌘/");
  // The US "/" place types "-": not a US keyboard; both are named.
  noteTypedKey({ key: "-", code: "Slash", metaKey: false, shiftKey: false, altKey: false, ctrlKey: false });
  assert.equal(slashChordKeys(), "⌘/ or ⌘⇧7");
  setPlatformForTests("windows");
  try {
    assert.equal(shortcutKeys("shortcuts"), "Ctrl+/ or Ctrl+Shift+7");
  } finally {
    setPlatformForTests(null);
  }
  // ⌘⇧7 opens the sheet and teaches the key: every label names it.
  assert.equal(matchShortcut(press("7", { shiftKey: true, code: "Digit7" })), "shortcuts");
  assert.equal(slashChordKeys(), "⌘⇧7");
  assert.equal(shortcutKeys("shortcuts"), "⌘⇧7");
  // A US keyboard's ⌘/ teaches nothing odd, and ⌘⇧7 there is nothing.
  setSlashKeyForTests(null);
  assert.equal(matchShortcut(press("&", { shiftKey: true, code: "Digit7" })), null);
  assert.equal(slashChordKeys(), "⌘/");
  setSlashKeyForTests(null);
}

// Challenger (C5): the layout map names the key before anything is typed.
{
  setSlashKeyForTests(null);
  const nav = globalThis.navigator as unknown as { keyboard?: unknown };
  const had = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { ...(nav ?? {}), keyboard: { getLayoutMap: async () => new Map([["KeyA", "a"], ["NumpadDivide", "/"], ["Minus", "/"]]) } },
  });
  try {
    await learnKeyboardLayout();
    assert.equal(slashChordKeys(), "⌘/", "the key prints / unshifted: named /");
    assert.equal(matchShortcut(press("/", { code: "Minus" })), "shortcuts");
  } finally {
    if (had) Object.defineProperty(globalThis, "navigator", had);
    setLayoutNamesForTests(null);
    setSlashKeyForTests(null);
  }
}

console.log("shortcuts: all assertions passed");
