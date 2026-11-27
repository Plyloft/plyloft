// W5: the find, paste and copy keys a terminal tile answers itself — ⌘ on the
// Mac; Ctrl on Windows, where Ctrl+C without a selection stays SIGINT.
// Run with Node 22+:  node --experimental-strip-types src/lib/terminalKeys.test.ts
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { setPlatformForTests } from "./platform.ts";
import {
  altArrowSequence,
  handleAltArrowKey,
  handleTerminalClipboardKey,
  installMultiLinePasteGuard,
  installTerminalClipboardKeys,
  installTerminalRightClick,
  pasteIntoTerminal,
  shellPastePlan,
  terminalKeyAction,
  terminalRightClickAction,
  type TerminalKeyPress,
} from "./terminalKeys.ts";

const key = (k: string, m: Partial<TerminalKeyPress> = {}): TerminalKeyPress => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...m,
});

// The Mac: ⌘F and ⌘V, nothing else; ⌃ keys are the shell's. ⌘V is the web
// view's native paste (no clipboard read, so no WebKit "Paste" callout); ⌃V
// stays ^V, Claude Code's own image paste.
{
  assert.equal(terminalKeyAction(key("f", { metaKey: true }), false), "find");
  assert.equal(terminalKeyAction(key("v", { metaKey: true }), false), "native-paste");
  assert.equal(terminalKeyAction(key("V", { metaKey: true }), false), "native-paste");
  assert.equal(terminalKeyAction(key("v", { metaKey: true, shiftKey: true }), false), null);
  assert.equal(terminalKeyAction(key("v", { ctrlKey: true }), true), null, "⌃V is ^V for Claude's image paste");
  assert.equal(terminalKeyAction(key("c", { metaKey: true }), true), null, "the web view's copy event copies");
  assert.equal(terminalKeyAction(key("c", { ctrlKey: true }), true), null, "⌃C is SIGINT");
  assert.equal(terminalKeyAction(key("v", { ctrlKey: true }), false), null);
  assert.equal(terminalKeyAction(key("f", { metaKey: true, shiftKey: true }), false), null);
  assert.equal(terminalKeyAction(key("f", { metaKey: true, ctrlKey: true }), false), null);
}

// Windows.
setPlatformForTests("windows");
try {
  assert.equal(terminalKeyAction(key("f", { ctrlKey: true }), false), "find");
  // The web view's own paste too: WebView2 puts a clipboard read behind a
  // permission Tauri does not grant; a user's Ctrl+V needs none.
  assert.equal(terminalKeyAction(key("v", { ctrlKey: true }), false), "native-paste");
  assert.equal(terminalKeyAction(key("v", { ctrlKey: true }), true), "native-paste", "a selection does not change paste");
  assert.equal(terminalKeyAction(key("V", { ctrlKey: true, shiftKey: true }), false), "native-paste");
  assert.equal(terminalKeyAction(key("c", { ctrlKey: true }), true), "copy", "a selection is copied");
  assert.equal(terminalKeyAction(key("c", { ctrlKey: true }), false), null, "no selection: ^C, SIGINT");
  assert.equal(terminalKeyAction(key("C", { ctrlKey: true, shiftKey: true }), false), "copy");
  for (const k of ["d", "z", "r", "w", "k", "l", "a", "e"]) {
    assert.equal(terminalKeyAction(key(k, { ctrlKey: true }), true), null, `Ctrl+${k} is the shell's`);
  }
  assert.equal(terminalKeyAction(key("v", { metaKey: true }), false), null, "the Windows key is not the modifier");
  assert.equal(terminalKeyAction(key("v", { ctrlKey: true, altKey: true }), false), null, "AltGr is not paste");
} finally {
  setPlatformForTests(null);
}

// W4: right-click in a terminal is Windows Terminal's — copy a selection,
// else paste; the Mac keeps its menu.
{
  assert.equal(terminalRightClickAction(true, "windows"), "copy");
  assert.equal(terminalRightClickAction(false, "windows"), "paste");
  assert.equal(terminalRightClickAction(true, "mac"), null);
  assert.equal(terminalRightClickAction(false, "mac"), null);
  assert.equal(terminalRightClickAction(true), null, "the default is the platform");
}

{
  const calls: string[] = [];
  let selected = "ls -la";
  const term = {
    hasSelection: () => selected !== "",
    getSelection: () => selected,
    clearSelection: () => {
      calls.push("clear");
      selected = "";
    },
    modes: { bracketedPasteMode: false },
    options: { disableStdin: false },
    paste: (t: string) => calls.push(`paste:${t}`),
  };
  let clip = "echo hi";
  let busy = false;
  const clipboard = {
    readText: async () => {
      if (busy) throw new Error("the clipboard is busy");
      return clip;
    },
    writeText: async (t: string) => {
      calls.push(`write:${t}`);
    },
  };
  const listeners: ((e: MouseEvent) => void)[] = [];
  const el = {
    addEventListener: (_t: string, fn: (e: MouseEvent) => void) => listeners.push(fn),
    removeEventListener: (_t: string, fn: (e: MouseEvent) => void) => {
      listeners.splice(listeners.indexOf(fn), 1);
    },
  };
  const fire = () => {
    const done: string[] = [];
    const event = {
      preventDefault: () => done.push("preventDefault"),
      stopPropagation: () => done.push("stopPropagation"),
    } as unknown as MouseEvent;
    for (const fn of listeners) fn(event);
    return done;
  };
  const asked: number[] = [];
  let answer = false;
  const ask = async (n: number) => {
    asked.push(n);
    return answer;
  };
  const errors: string[] = [];
  const undo = installTerminalRightClick(el, term, clipboard, ask, (m) => void errors.push(m));

  assert.deepEqual(fire(), [], "the Mac: the event is left alone");
  assert.deepEqual(calls, []);

  setPlatformForTests("windows");
  try {
    assert.deepEqual(fire(), ["preventDefault", "stopPropagation"]);
    assert.deepEqual(calls, ["write:ls -la", "clear"], "a selection is copied and cleared");
    calls.length = 0;
    assert.deepEqual(fire(), ["preventDefault", "stopPropagation"]);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(calls, ["paste:echo hi"], "no selection: the clipboard is pasted");
    assert.deepEqual(asked, [], "one line: no question");

    // Several lines into a shell without bracketed paste: asked first.
    calls.length = 0;
    clip = "echo one\necho two\n";
    fire();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    assert.deepEqual(asked, [2]);
    assert.deepEqual(calls, [], "Cancel: nothing pasted");
    answer = true;
    fire();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    assert.deepEqual(asked, [2, 2]);
    assert.deepEqual(calls, ["paste:echo one\necho two\n"], "Paste: pasted once");

    // A busy clipboard is told, not swallowed.
    calls.length = 0;
    busy = true;
    fire();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    assert.deepEqual(errors, ["the clipboard is busy"]);
    assert.deepEqual(calls, []);
    busy = false;

    // A terminal that takes no input (a finished run) pastes nothing.
    term.options.disableStdin = true;
    clip = "echo hi";
    assert.deepEqual(fire(), ["preventDefault", "stopPropagation"]);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    assert.deepEqual(calls, []);
    term.options.disableStdin = false;
  } finally {
    setPlatformForTests(null);
  }
  undo();
  assert.equal(listeners.length, 0);

  // A TUI host (no question): the right-click pastes as read, at once.
  setPlatformForTests("windows");
  try {
    calls.length = 0;
    asked.length = 0;
    clip = "line one\nline two\n";
    const undoTui = installTerminalRightClick(el, term, clipboard, null);
    fire();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    assert.deepEqual(asked, []);
    assert.deepEqual(calls, ["paste:line one\nline two\n"]);
    undoTui();
  } finally {
    setPlatformForTests(null);
  }
}

// P3-1: the clipboard keys every terminal host shares. Paste is kept from
// xterm and left to the web view; copy writes the selection and clears it.
{
  let selected = "";
  let cleared = 0;
  const writes: string[] = [];
  const term = {
    hasSelection: () => selected !== "",
    getSelection: () => selected,
    clearSelection: () => {
      selected = "";
      cleared += 1;
    },
  };
  const clipboard = { writeText: async (t: string) => void writes.push(t) };
  const press = (type: string, m: Partial<TerminalKeyPress> & { key: string }) => {
    let prevented = 0;
    const e = {
      type,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...m,
      preventDefault: () => void (prevented += 1),
    } as unknown as KeyboardEvent;
    return { handled: handleTerminalClipboardKey(e, term, clipboard), prevented };
  };

  // The Mac.
  for (const type of ["keydown", "keypress", "keyup"]) {
    assert.deepEqual(press(type, { key: "v", metaKey: true }), { handled: true, prevented: 0 }, `⌘V ${type}`);
  }
  assert.deepEqual(press("keydown", { key: "v", ctrlKey: true }), { handled: false, prevented: 0 }, "⌃V is ^V");
  assert.deepEqual(press("keydown", { key: "f", metaKey: true }), { handled: false, prevented: 0 }, "⌘F: the host's");
  selected = "x";
  assert.deepEqual(press("keydown", { key: "c", metaKey: true }), { handled: false, prevented: 0 }, "⌘C: the copy event");
  assert.deepEqual(writes, []);

  setPlatformForTests("windows");
  try {
    assert.deepEqual(press("keydown", { key: "v", ctrlKey: true }), { handled: true, prevented: 0 });
    assert.deepEqual(press("keydown", { key: "V", ctrlKey: true, shiftKey: true }), { handled: true, prevented: 0 });
    selected = "ls -la";
    assert.deepEqual(press("keydown", { key: "c", ctrlKey: true }), { handled: true, prevented: 1 });
    await Promise.resolve();
    assert.deepEqual(writes, ["ls -la"]);
    assert.equal(cleared, 1);
    assert.deepEqual(press("keydown", { key: "c", ctrlKey: true }), { handled: false, prevented: 0 }, "no selection: SIGINT");
    selected = "y";
    assert.deepEqual(press("keyup", { key: "c", ctrlKey: true }), { handled: true, prevented: 0 }, "keyup: kept, no copy");
    assert.deepEqual(writes, ["ls -la"]);
    selected = "echo hi";
    assert.deepEqual(press("keydown", { key: "C", ctrlKey: true, shiftKey: true }), { handled: true, prevented: 1 });
    await Promise.resolve();
    assert.deepEqual(writes, ["ls -la", "echo hi"]);

    // installTerminalClipboardKeys: xterm sees false for a clipboard key.
    let attached: ((e: KeyboardEvent) => boolean) | null = null;
    installTerminalClipboardKeys({ ...term, input: () => {}, attachCustomKeyEventHandler: (fn) => void (attached = fn) }, clipboard);
    const ev = (m: Record<string, unknown>) =>
      ({ type: "keydown", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, preventDefault() {}, ...m }) as unknown as KeyboardEvent;
    assert.equal(attached!(ev({ key: "v", ctrlKey: true })), false, "Ctrl+V kept from xterm");
    assert.equal(attached!(ev({ key: "d", ctrlKey: true })), true, "Ctrl+D is the shell's");
  } finally {
    setPlatformForTests(null);
  }
}

// Alt+arrow word keys (1.169.0, B1): xterm 6 dropped xterm 5's own
// mapping; the hosts send what xterm 5 sent.
{
  const alt = (k: string, m: Partial<TerminalKeyPress> = {}) => key(k, { altKey: true, ...m });
  assert.equal(altArrowSequence(alt("ArrowLeft"), "mac"), "\x1bb");
  assert.equal(altArrowSequence(alt("ArrowRight"), "mac"), "\x1bf");
  assert.equal(altArrowSequence(alt("ArrowUp"), "mac"), null, "Mac: ⌥↑ stays xterm's");
  assert.equal(altArrowSequence(alt("ArrowLeft"), "windows"), "\x1b[1;5D");
  assert.equal(altArrowSequence(alt("ArrowRight"), "windows"), "\x1b[1;5C");
  assert.equal(altArrowSequence(alt("ArrowUp"), "windows"), "\x1b[1;5A");
  assert.equal(altArrowSequence(alt("ArrowDown"), "windows"), "\x1b[1;5B");
  assert.equal(altArrowSequence(key("ArrowLeft"), "mac"), null, "no Alt: xterm's");
  assert.equal(altArrowSequence(alt("ArrowLeft", { shiftKey: true }), "mac"), null, "⇧⌥← stays xterm's");
  assert.equal(altArrowSequence(alt("ArrowLeft", { ctrlKey: true }), "windows"), null);
  assert.equal(altArrowSequence(alt("ArrowLeft", { metaKey: true }), "mac"), null);
  assert.equal(altArrowSequence(alt("b"), "mac"), null);
  assert.equal(altArrowSequence({ ...alt("ArrowLeft"), isComposing: true }, "mac"), null, "IME composing: its key");
  assert.equal(altArrowSequence({ ...alt("ArrowLeft"), keyCode: 229 }, "windows"), null, "IME (229): its key");

  setPlatformForTests("mac");
  try {
    const sent: Array<[string, boolean | undefined]> = [];
    let prevented = 0;
    let stopped = 0;
    const ev = (type: string, k: string, m: Record<string, unknown> = {}) =>
      ({ type, key: k, metaKey: false, ctrlKey: false, altKey: true, shiftKey: false, preventDefault: () => void prevented++, stopPropagation: () => void stopped++, ...m }) as unknown as KeyboardEvent;
    const term = { input: (d: string, u?: boolean) => void sent.push([d, u]) };
    assert.equal(handleAltArrowKey(ev("keydown", "ArrowLeft"), term), true);
    assert.equal(handleAltArrowKey(ev("keyup", "ArrowLeft"), term), true, "keyup kept, nothing sent");
    assert.equal(handleAltArrowKey(ev("keydown", "ArrowLeft", { altKey: false }), term), false);
    assert.deepEqual(sent, [["\x1bb", true]]);
    assert.equal(prevented, 1);
    assert.equal(stopped, 1, "the keydown goes no further");
  } finally {
    setPlatformForTests(null);
  }
}

// Multi-line paste (shell hosts): what goes in, and when it asks.
{
  const plan = (t: string, b = false) => shellPastePlan(t, b);
  assert.deepEqual(plan("ls -la"), { text: "ls -la", ask: 0 });
  assert.deepEqual(plan(""), { text: "", ask: 0 });
  assert.deepEqual(plan("ls\n"), { text: "ls", ask: 0 }, "one line: trailing newline trimmed, not run");
  assert.deepEqual(plan("cd dir  \r\n\r\n"), { text: "cd dir", ask: 0 }, "trailing whitespace too (trimPaste)");
  assert.deepEqual(plan("a\nb"), { text: "a\nb", ask: 2 });
  assert.deepEqual(plan("a\r\nb\r\nc\r\n"), { text: "a\r\nb\r\nc\r\n", ask: 3 }, "several lines go in unchanged");
  assert.deepEqual(plan("a\rb"), { text: "a\rb", ask: 2 });
  assert.deepEqual(plan("a\n\nb"), { text: "a\n\nb", ask: 3 }, "a blank line is an Enter too");
  assert.deepEqual(plan("a\nb", true), { text: "a\nb", ask: 0 }, "bracketed: unchanged, at once");
  assert.deepEqual(plan("ls\n", true), { text: "ls\n", ask: 0 });
}

{
  const pasted: string[] = [];
  let focused = 0;
  const term = {
    modes: { bracketedPasteMode: false },
    options: { disableStdin: false },
    paste: (t: string) => void pasted.push(t),
    focus: () => void (focused += 1),
  };
  const asked: number[] = [];
  const answers = [false, true];
  const ask = async (n: number) => {
    asked.push(n);
    return answers.shift() ?? false;
  };
  assert.equal(await pasteIntoTerminal(term, "one line", ask), true);
  assert.equal(await pasteIntoTerminal(term, "ls\n", ask), true);
  assert.deepEqual(pasted, ["one line", "ls"]);
  assert.equal(await pasteIntoTerminal(term, "a\nb\nc", ask), false, "Cancel");
  assert.deepEqual(pasted, ["one line", "ls"]);
  assert.equal(await pasteIntoTerminal(term, "a\nb\nc", ask), true, "Paste");
  assert.deepEqual(pasted, ["one line", "ls", "a\nb\nc"]);
  assert.deepEqual(asked, [3, 3]);
  assert.equal(focused, 2, "the terminal has the keyboard back after either answer");
  term.modes.bracketedPasteMode = true;
  assert.equal(await pasteIntoTerminal(term, "x\ny", ask), true);
  assert.deepEqual(asked, [3, 3], "bracketed: no question");
  const failing = async (): Promise<boolean> => {
    throw new Error("no host");
  };
  term.modes.bracketedPasteMode = false;
  pasted.length = 0;
  assert.equal(await pasteIntoTerminal(term, "x\ny", failing), false, "a failed question pastes nothing");
  assert.equal(await pasteIntoTerminal(term, "x\ny\n", null), true, "a TUI host: as is, no question");
  assert.deepEqual(pasted, ["x\ny\n"]);
  term.options.disableStdin = true;
  assert.equal(await pasteIntoTerminal(term, "x", null), false, "no input: nothing");
  assert.equal(await pasteIntoTerminal(term, "x\ny", ask), false);
  assert.deepEqual(pasted, ["x\ny\n"]);
  term.options.disableStdin = false;
  pasted.length = 0;

  // The guard on the web view's own paste event.
  const listeners: { fn: (e: ClipboardEvent) => void; capture: boolean }[] = [];
  const el = {
    addEventListener: (_t: string, fn: (e: ClipboardEvent) => void, capture: boolean) =>
      void listeners.push({ fn, capture }),
    removeEventListener: (_t: string, fn: (e: ClipboardEvent) => void) => {
      listeners.splice(listeners.findIndex((l) => l.fn === fn), 1);
    },
  };
  asked.length = 0;
  answers.push(true);
  const undo = installMultiLinePasteGuard(el, term, ask);
  assert.equal(listeners[0].capture, true, "a capture listener: before xterm's own");
  const firePaste = (text: string) => {
    const done: string[] = [];
    const event = {
      clipboardData: { getData: (type: string) => (type === "text/plain" ? text : "") },
      preventDefault: () => void done.push("preventDefault"),
      stopPropagation: () => void done.push("stopPropagation"),
    } as unknown as ClipboardEvent;
    listeners[0].fn(event);
    return done;
  };
  assert.deepEqual(firePaste("dir"), [], "one line: left to xterm");
  assert.deepEqual(pasted, [], "…which pastes it itself");
  assert.deepEqual(firePaste("dir\r\n"), ["preventDefault", "stopPropagation"], "one line + newline: trimmed");
  assert.deepEqual(pasted, ["dir"]);
  pasted.length = 0;
  assert.deepEqual(firePaste("dir\ncd ..\n"), ["preventDefault", "stopPropagation"]);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.deepEqual(asked, [2]);
  assert.deepEqual(pasted, ["dir\ncd ..\n"], "Paste: through xterm's paste");
  term.modes.bracketedPasteMode = true;
  assert.deepEqual(firePaste("dir\ncd ..\n"), [], "bracketed: left to xterm");
  term.modes.bracketedPasteMode = false;
  term.options.disableStdin = true;
  assert.deepEqual(firePaste("dir\ncd ..\n"), [], "no input: left to xterm, which drops it");
  undo();
  assert.equal(listeners.length, 0);
}

// P3-1: every xterm host answers the clipboard keys — through the shared
// helper, so Windows Ctrl+V never sends ^V in one and pastes in another.
{
  const dir = new URL("../components/", import.meta.url);
  const hosts = readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    .filter((f) => /new (?:XTerm|Terminal)\(/.test(readFileSync(new URL(f, dir), "utf8")));
  assert.ok(hosts.length >= 5, `found the xterm hosts: ${hosts.join(", ")}`);
  assert.ok(
    /return !handleTerminalClipboardKey\(e, term\) && !handleAltArrowKey\(e, term\);/.test(readFileSync(new URL("terminalReading.ts", dir), "utf8")),
    "installTerminalHostKeys answers the clipboard keys and the Alt+arrow word keys",
  );
  for (const f of hosts) {
    const src = readFileSync(new URL(f, dir), "utf8");
    assert.ok(
      // QoL 1.168 (block 10, A7): `installTerminalHostKeys` is the clipboard
      // keys with the zoom keys in front (checked below).
      /installTerminalClipboardKeys\(term\)|handleTerminalClipboardKey\(e, term\)|installTerminalHostKeys\(term\)/.test(src),
      `${f} creates an xterm without the shared clipboard keys`,
    );
    // 1.169.0 (B1): and xterm 5's Alt+arrow word keys, which xterm 6 dropped.
    assert.ok(
      /installTerminalClipboardKeys\(term\)|handleAltArrowKey\(e, term\)|installTerminalHostKeys\(term\)/.test(src),
      `${f} creates an xterm without the Alt+arrow word keys`,
    );
    assert.ok(
      /installTerminalPaste\((?:host|containerRef\.current), term, \{/.test(src),
      `${f} creates an xterm without the shared right-click and multi-line paste question`,
    );
    // The question is a shell host's only: a TUI's newline is no command,
    // and under ConPTY its bracketed-paste request may never reach xterm.
    const shellHost = /SetupTerminal\.tsx$/.test(f)
      ? "true"
      : /(?:^|\/)Terminal\.tsx$/.test(f)
        ? 'readinessKind === "shell"'
        : "false";
    assert.ok(
      src.includes(`shell: ${shellHost}`),
      `${f}: the multi-line question must be { shell: ${shellHost} }`,
    );
  }
}

// The page never reads the clipboard itself: WebView2 asks for a permission
// first (the prompt took the window's focus and pasted nothing), and WebKit
// shows its "Paste" callout.
for (const f of ["terminalKeys.ts", "terminalPaste.ts"]) {
  const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
  assert.ok(!/navigator\.clipboard\.readText|clipboard\.read\(/.test(src), `${f} reads the clipboard from the page`);
}

console.log("terminalKeys: all assertions passed");
