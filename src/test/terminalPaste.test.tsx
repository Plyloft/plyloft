// Paste keys in a terminal tile are the web view's own paste: ⌘V on the Mac,
// Ctrl+V and Ctrl+Shift+V on Windows. The tile's key handler only keeps the
// key from xterm.js (no ^V), never cancels it and never reads
// navigator.clipboard — a programmatic read of text another app copied makes
// WebKit show its "Paste" callout, and WebView2 puts it behind a permission.
// The native paste event then reaches xterm's textarea, xterm's one
// insertion path (v1.25.1: never two). Copy keys are unchanged.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "../components/Terminal";
import { useTiles, type Tile } from "../store/tileStore";
import { setPlatformForTests } from "../lib/platform";
import { act, renderUi, waitFor } from "./render";

type KeyHandler = (e: KeyboardEvent) => boolean;
const handlers: KeyHandler[] = [];
const pasted: string[] = [];
const sel = { text: "", cleared: 0 };

vi.mock("@xterm/xterm", () => {
  const deep = (): unknown =>
    new Proxy(function () {}, {
      get: (_t, prop) => (prop === "dispose" ? () => {} : deep()),
      apply: () => deep(),
    });
  class FakeTerm {
    cols = 100;
    rows = 3;
    options: Record<string, unknown> = {};
    modes = { bracketedPasteMode: true };
    buffer = {
      active: { baseY: 0, length: 3, type: "normal", getLine: () => ({ translateToString: () => "" }) },
    };
    constructor() {
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (prop in target) return Reflect.get(target, prop, receiver);
          if (prop === "then") return undefined;
          return deep();
        },
      });
    }
    attachCustomKeyEventHandler(fn: KeyHandler) {
      handlers.push(fn);
    }
    hasSelection() {
      return sel.text !== "";
    }
    getSelection() {
      return sel.text;
    }
    clearSelection() {
      sel.text = "";
      sel.cleared += 1;
    }
    paste(text: string) {
      pasted.push(text);
    }
    write(_data: string | Uint8Array, done?: () => void) {
      done?.();
    }
  }
  return { Terminal: FakeTerm };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} dispose() {} proposeDimensions() { return undefined; } } }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { dispose() {} onContextLoss() { return { dispose() {} }; } } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { dispose() {} } }));
vi.mock("@xterm/addon-image", () => ({ ImageAddon: class { dispose() {} } }));

afterEach(() => {
  setPlatformForTests(null);
  handlers.length = 0;
  pasted.length = 0;
  sel.text = "";
  sel.cleared = 0;
});

function tile(): Tile {
  return {
    id: "t1",
    workspaceId: "ws",
    kind: "claude",
    ptyId: "pty-1",
    label: "Claude",
    cwd: "/code",
    startedAt: Date.now(),
    status: "running",
    pendingClose: false,
    expanded: false,
  } as Tile;
}

/** Installed after render: user-event's setup puts its own clipboard there. */
function clipboardSpy(text: string) {
  const readText = vi.fn(async () => text);
  const writeText = vi.fn(async (_t: string) => {});
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText, writeText },
  });
  return { readText, writeText };
}

async function mounted(): Promise<KeyHandler> {
  act(() =>
    useTiles.setState({
      byWorkspace: { ws: { tiles: [tile()], expandedTileId: null, detailTileId: null } },
    }),
  );
  const view = renderUi(<Terminal cmd="claude" cli="claude" workspaceId="ws" readiness="claude" />, {
    fixtures: { pty_spawn: "pty-1", cli_fresh_check: null, pty_resize: null, pty_prompt_state: null, pty_prompt_idle: false },
  });
  view.tauri.allowUnhandled();
  await waitFor(() => expect(handlers.length).toBeGreaterThan(0));
  return handlers[handlers.length - 1];
}

function press(handler: KeyHandler, type: string, init: KeyboardEventInit) {
  const e = new KeyboardEvent(type, { cancelable: true, ...init });
  const preventDefault = vi.spyOn(e, "preventDefault");
  return { result: handler(e), preventDefault, e };
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 10)));

/** The key is kept from xterm, left to the web view, and nothing is read. */
async function expectNativePaste(handler: KeyHandler, init: KeyboardEventInit, readText: () => unknown) {
  for (const type of ["keydown", "keypress", "keyup"]) {
    const { result, preventDefault, e } = press(handler, type, init);
    expect(result, type).toBe(false);
    expect(preventDefault, type).not.toHaveBeenCalled();
    expect(e.defaultPrevented, type).toBe(false);
  }
  await flush();
  expect(readText).not.toHaveBeenCalled();
  expect(pasted).toEqual([]); // xterm's own paste listener is the one path
}

describe("paste keys in a terminal tile", () => {
  it("on the Mac, ⌘V leaves the paste to the web view: no ^V, no cancel, no clipboard read", async () => {
    setPlatformForTests("mac");
    const handler = await mounted();
    const { readText } = clipboardSpy("from another app");
    await expectNativePaste(handler, { key: "v", metaKey: true }, readText);
  });

  it("on the Mac, ⌃V still goes to the PTY as ^V (Claude Code's image paste)", async () => {
    setPlatformForTests("mac");
    const handler = await mounted();
    const { readText } = clipboardSpy("x");
    const { result, preventDefault } = press(handler, "keydown", { key: "v", ctrlKey: true });
    expect(result).toBe(true);
    expect(preventDefault).not.toHaveBeenCalled();
    await flush();
    expect(readText).not.toHaveBeenCalled();
  });

  it("on Windows, Ctrl+V and Ctrl+Shift+V leave the paste to the web view too", async () => {
    setPlatformForTests("windows");
    const handler = await mounted();
    const { readText } = clipboardSpy("dir");
    await expectNativePaste(handler, { key: "v", ctrlKey: true }, readText);
    await expectNativePaste(handler, { key: "V", ctrlKey: true, shiftKey: true }, readText);
    sel.text = "selected";
    await expectNativePaste(handler, { key: "v", ctrlKey: true }, readText);
  });
});

describe("copy keys in a terminal tile (unchanged)", () => {
  it("on the Mac, ⌘C is left to xterm and the web view's copy event", async () => {
    setPlatformForTests("mac");
    const handler = await mounted();
    const { writeText } = clipboardSpy("");
    sel.text = "ls -la";
    const { result, preventDefault } = press(handler, "keydown", { key: "c", metaKey: true });
    expect(result).toBe(true);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("on Windows, Ctrl+C copies a selection and clears it; without one it is ^C", async () => {
    setPlatformForTests("windows");
    const handler = await mounted();
    const { writeText } = clipboardSpy("");
    sel.text = "ls -la";
    const copy = press(handler, "keydown", { key: "c", ctrlKey: true });
    expect(copy.result).toBe(false);
    expect(copy.preventDefault).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("ls -la");
    expect(sel.cleared).toBe(1);
    const sigint = press(handler, "keydown", { key: "c", ctrlKey: true });
    expect(sigint.result).toBe(true);
    expect(sigint.preventDefault).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledTimes(1);
    sel.text = "echo hi";
    press(handler, "keydown", { key: "C", ctrlKey: true, shiftKey: true });
    expect(writeText).toHaveBeenLastCalledWith("echo hi");
  });
});

// 1.174.0 E5 (P22, D5 b): on Windows, a Plyloft key in its terminal form is
// the app's (App.tsx answers it in the capture phase) and never also reaches
// the program as a control byte; Ctrl and a letter stay the program's.
describe("Plyloft's keys from inside a terminal (Windows)", () => {
  it("keeps Ctrl+Shift+K, Ctrl+Shift+P, Ctrl+Alt+T, Ctrl+Shift+, and Ctrl+Shift+\\ from xterm", async () => {
    setPlatformForTests("windows");
    const handler = await mounted();
    for (const init of [
      { key: "K", code: "KeyK", ctrlKey: true, shiftKey: true },
      { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true },
      { key: "t", code: "KeyT", ctrlKey: true, altKey: true },
      { key: "<", code: "Comma", ctrlKey: true, shiftKey: true },
      { key: "|", code: "Backslash", ctrlKey: true, shiftKey: true },
    ]) {
      for (const type of ["keydown", "keypress", "keyup"]) {
        const { result, preventDefault } = press(handler, type, init);
        expect(result, `${init.key} ${type}`).toBe(false);
        // Kept from xterm only: App.tsx's handler is the one that cancels it.
        expect(preventDefault).not.toHaveBeenCalled();
      }
    }
  });

  it("leaves Ctrl and a letter to the program: Ctrl+K, Ctrl+R, Ctrl+T, Ctrl+P", async () => {
    setPlatformForTests("windows");
    const handler = await mounted();
    for (const key of ["k", "r", "t", "p", "w"]) {
      expect(press(handler, "keydown", { key, code: `Key${key.toUpperCase()}`, ctrlKey: true }).result, key).toBe(true);
    }
    // AltGr (Ctrl+Alt) on the T key types a character: the program's.
    const altGr = new KeyboardEvent("keydown", { key: "t", code: "KeyT", ctrlKey: true, altKey: true, cancelable: true });
    Object.defineProperty(altGr, "getModifierState", { value: (k: string) => k === "AltGraph" });
    expect(handler(altGr)).toBe(true);
  });

  it("changes nothing on the Mac: ⌃K is the PTY's", async () => {
    setPlatformForTests("mac");
    const handler = await mounted();
    expect(press(handler, "keydown", { key: "k", code: "KeyK", ctrlKey: true }).result).toBe(true);
    expect(press(handler, "keydown", { key: "K", code: "KeyK", ctrlKey: true, shiftKey: true }).result).toBe(true);
  });
});
