// P3-5: the single insertion path, against the real xterm.js. The paste keys
// are left to the web view (lib/terminalKeys.ts), so what reaches the PTY is
// xterm's own answer to the paste event on its textarea: the text once,
// bracketed when the app turned bracketed paste on — and the key itself
// sends nothing (no ^V) and is not cancelled.
import { afterEach, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { installTerminalClipboardKeys } from "../lib/terminalKeys";
import { setPlatformForTests } from "../lib/platform";

let term: Terminal | null = null;
afterEach(() => {
  term?.dispose();
  term = null;
  setPlatformForTests(null);
  document.body.innerHTML = "";
});

async function open(): Promise<{ t: Terminal; sent: string[] }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const t = new Terminal({ cols: 80, rows: 10 });
  term = t;
  t.open(host);
  installTerminalClipboardKeys(t);
  const sent: string[] = [];
  t.onData((d) => sent.push(d));
  // The app (a shell, Claude) asks for bracketed paste.
  await new Promise<void>((r) => t.write("\x1b[?2004h", r));
  return { t, sent };
}

function paste(target: HTMLElement, text: string) {
  const e = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "clipboardData", { value: { getData: (type: string) => (type === "text/plain" ? text : "") } });
  target.dispatchEvent(e);
}

function key(target: HTMLElement, init: KeyboardEventInit) {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

describe("a paste reaches the PTY once, through xterm's own paste listener", () => {
  for (const p of ["mac", "windows"] as const) {
    it(`on ${p}: the paste key sends nothing; the paste event sends the bracketed text once`, async () => {
      setPlatformForTests(p);
      const { t, sent } = await open();
      const textarea = t.textarea!;
      const down = key(textarea, p === "mac" ? { key: "v", metaKey: true } : { key: "v", ctrlKey: true });
      expect(down.defaultPrevented).toBe(false); // the web view's paste still happens
      expect(sent).toEqual([]); // no ^V
      paste(textarea, "echo one\necho two");
      expect(sent).toEqual(["\x1b[200~echo one\recho two\x1b[201~"]);
    });
  }

  it("without the helper, Windows Ctrl+V would send ^V (what P3-1 fixed in the other hosts)", async () => {
    setPlatformForTests("windows");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const t = new Terminal({ cols: 80, rows: 10 });
    term = t;
    t.open(host);
    const sent: string[] = [];
    t.onData((d) => sent.push(d));
    key(t.textarea!, { key: "v", ctrlKey: true, keyCode: 86 } as KeyboardEventInit);
    expect(sent).toEqual(["\x16"]);
  });
});
