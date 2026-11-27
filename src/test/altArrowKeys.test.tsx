// 1.169.0 (B1): xterm 6 dropped xterm 5's own Alt+arrow word keys (#5346)
// and sends a bare ESC[1;3D. Against the real xterm.js: every terminal
// host's key handler sends what xterm 5 sent, once, and the keydown goes no
// further (xterm 5 cancelled it).
import { afterEach, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { installTerminalClipboardKeys } from "../lib/terminalKeys";
import { installTerminalHostKeys } from "../components/terminalReading";
import { setPlatformForTests } from "../lib/platform";

let term: Terminal | null = null;
afterEach(() => {
  term?.dispose();
  term = null;
  setPlatformForTests(null);
  document.body.innerHTML = "";
});

const HOSTS = {
  installTerminalClipboardKeys: (t: Terminal) => installTerminalClipboardKeys(t),
  installTerminalHostKeys: (t: Terminal) => installTerminalHostKeys(t),
} as const;

function open(install: (t: Terminal) => void): { t: Terminal; sent: string[]; bubbled: string[] } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const t = new Terminal({ cols: 80, rows: 10 });
  term = t;
  t.open(host);
  install(t);
  const sent: string[] = [];
  t.onData((d) => sent.push(d));
  const bubbled: string[] = [];
  document.body.addEventListener("keydown", (e) => bubbled.push(e.key));
  return { t, sent, bubbled };
}

function press(target: HTMLElement, key: string, keyCode: number, init: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, keyCode, altKey: true, bubbles: true, cancelable: true, ...init }));
  target.dispatchEvent(new KeyboardEvent("keyup", { key, keyCode, altKey: true, bubbles: true, cancelable: true, ...init }));
}

const EXPECTED = {
  mac: { left: "\x1bb", right: "\x1bf" },
  windows: { left: "\x1b[1;5D", right: "\x1b[1;5C" },
} as const;

describe("Alt+arrow word keys reach the PTY as xterm 5 sent them", () => {
  for (const [name, install] of Object.entries(HOSTS)) {
    for (const p of ["mac", "windows"] as const) {
      it(`${name} on ${p}: ⌥←/⌥→ send ${JSON.stringify(EXPECTED[p])}, once, and do not bubble`, () => {
        setPlatformForTests(p);
        const { t, sent, bubbled } = open(install);
        press(t.textarea!, "ArrowLeft", 37);
        press(t.textarea!, "ArrowRight", 39);
        expect(sent).toEqual([EXPECTED[p].left, EXPECTED[p].right]);
        expect(bubbled).toEqual([]);
      });
    }
  }

  it("Windows: Alt+↑/↓ are Ctrl+↑/↓; the Mac leaves ⌥↑ to xterm", () => {
    setPlatformForTests("windows");
    const win = open(installTerminalHostKeys);
    press(win.t.textarea!, "ArrowUp", 38);
    press(win.t.textarea!, "ArrowDown", 40);
    expect(win.sent).toEqual(["\x1b[1;5A", "\x1b[1;5B"]);
    expect(win.bubbled).toEqual([]);
    win.t.dispose();
    document.body.innerHTML = "";
    setPlatformForTests("mac");
    const mac = open(installTerminalHostKeys);
    press(mac.t.textarea!, "ArrowUp", 38);
    expect(mac.sent).toEqual(["\x1b[1;3A"]);
  });

  it("without the hosts' handler, xterm 6 sends the bare ESC[1;3D", () => {
    setPlatformForTests("mac");
    const { t, sent } = open(() => {});
    press(t.textarea!, "ArrowLeft", 37);
    expect(sent).toEqual(["\x1b[1;3D"]);
  });

  it("an IME composing keeps its Alt+arrow", () => {
    setPlatformForTests("mac");
    const { t, sent } = open(installTerminalHostKeys);
    press(t.textarea!, "ArrowLeft", 229);
    expect(sent).not.toContain("\x1bb");
  });
});
