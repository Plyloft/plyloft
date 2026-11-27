// Windows walk: a paste of several lines into Windows PowerShell 5.1 ran its
// first line at once — PSReadLine there leaves bracketed paste off, so each
// newline is an Enter. As Windows Terminal does, such a paste asks first, in
// the confirm sheet; a single line and a bracketed paste stay instant. And
// the right-click paste reads the clipboard through Plyloft
// (`clipboard_read_text`), never the page's own read, whose WebView2
// permission prompt took the window's focus. Real xterm.js, real sheet.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { installTerminalClipboardKeys } from "../lib/terminalKeys";
import { installTerminalPaste } from "../lib/terminalPaste";
import { setPlatformForTests } from "../lib/platform";
import { act, renderUi, screen, waitFor } from "./render";

let term: Terminal | null = null;
let undo: (() => void) | null = null;
afterEach(() => {
  undo?.();
  undo = null;
  term?.dispose();
  term = null;
  setPlatformForTests(null);
});

async function open(bracketed: boolean, fixtures: Record<string, unknown> = {}, shell = true) {
  const view = renderUi(<div data-testid="host" />, { fixtures, withToasts: true });
  const host = screen.getByTestId("host");
  const t = new Terminal({ cols: 80, rows: 10 });
  term = t;
  t.open(host);
  installTerminalClipboardKeys(t);
  undo = installTerminalPaste(host, t, { shell });
  const sent: string[] = [];
  t.onData((d) => sent.push(d));
  await new Promise<void>((r) => t.write(bracketed ? "\x1b[?2004h" : "\x1b[?2004l", r));
  return { t, host, sent, ...view };
}

function paste(target: HTMLElement, text: string) {
  const e = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "clipboardData", {
    value: { getData: (type: string) => (type === "text/plain" ? text : "") },
  });
  act(() => {
    target.dispatchEvent(e);
  });
  return e;
}

describe("a multi-line paste into a shell without bracketed paste asks first", () => {
  it("asks in the confirm sheet; Paste sends the lines once, through xterm's paste", async () => {
    const { t, sent, user } = await open(false);
    const e = paste(t.textarea!, "echo one\necho two\n");
    expect(e.defaultPrevented).toBe(true);
    expect(sent).toEqual([]); // nothing ran yet
    expect(await screen.findByText("Paste 2 lines?")).toBeTruthy();
    expect(screen.getByText("Each line runs as a command.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Paste" }));
    await waitFor(() => expect(sent).toEqual(["echo one\recho two\r"]));
    expect(screen.queryByText("Paste 2 lines?")).toBeNull();
  });

  it("Cancel pastes nothing", async () => {
    const { t, sent, user } = await open(false);
    paste(t.textarea!, "a\nb\nc");
    await screen.findByText("Paste 3 lines?");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Paste 3 lines?")).toBeNull());
    expect(sent).toEqual([]);
  });

  it("a single line is pasted at once", async () => {
    const { t, sent } = await open(false);
    paste(t.textarea!, "dir");
    expect(sent).toEqual(["dir"]);
    expect(screen.queryByText(/^Paste \d+ lines?\?$/)).toBeNull();
  });

  it("with bracketed paste on (zsh, Claude Code, pwsh 7) several lines are pasted at once", async () => {
    const { t, sent } = await open(true);
    paste(t.textarea!, "echo one\necho two");
    expect(sent).toEqual(["\x1b[200~echo one\recho two\x1b[201~"]);
    expect(screen.queryByText("Paste 2 lines?")).toBeNull();
  });
});

describe("right-click paste on Windows", () => {
  it("reads the clipboard through Plyloft, never the page, and asks for several lines", async () => {
    setPlatformForTests("windows");
    const readText = vi.fn(async () => "never");
    const { host, sent, user, tauri } = await open(false, {
      clipboard_read_text: "git status\ngit log\n",
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText, writeText: vi.fn(async () => {}) },
    });
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => {
      host.dispatchEvent(menu);
    });
    expect(menu.defaultPrevented).toBe(true);
    await screen.findByText("Paste 2 lines?");
    expect(tauri.callsOf("clipboard_read_text")).toHaveLength(1);
    expect(readText).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Paste" }));
    await waitFor(() => expect(sent).toEqual(["git status\rgit log\r"]));
  });

  it("a single line from the clipboard is pasted at once", async () => {
    setPlatformForTests("windows");
    const { host, sent } = await open(false, { clipboard_read_text: "dir" });
    act(() => {
      host.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(sent).toEqual(["dir"]));
  });

  it("an empty clipboard pastes nothing", async () => {
    setPlatformForTests("windows");
    const { host, sent, tauri } = await open(false, { clipboard_read_text: null });
    act(() => {
      host.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(tauri.callsOf("clipboard_read_text")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual([]);
  });
});

describe("trimPaste, busy clipboard, TUI hosts and finished runs", () => {
  it("one line ending in a newline is pasted trimmed, so it does not run", async () => {
    const { t, sent } = await open(false);
    const e = paste(t.textarea!, "dir\r\n");
    expect(e.defaultPrevented).toBe(true);
    expect(sent).toEqual(["dir"]);
    expect(screen.queryByText(/^Paste \d+ lines\?$/)).toBeNull();
  });

  it("a busy clipboard on right-click says so in a toast", async () => {
    setPlatformForTests("windows");
    const { host, sent } = await open(false, {
      clipboard_read_text: () => {
        throw "the clipboard is busy";
      },
    });
    act(() => {
      host.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    expect(await screen.findByText("Nothing pasted.")).toBeTruthy();
    expect(sent).toEqual([]);
  });

  it("a TUI host (Claude, Codex, Builder, Intake, agent run) pastes several lines at once, no question", async () => {
    const { t, sent } = await open(false, {}, false);
    paste(t.textarea!, "line one\nline two\n");
    expect(sent).toEqual(["line one\rline two\r"]);
    expect(screen.queryByText("Paste 2 lines?")).toBeNull();
  });

  it("a TUI host's right-click pastes as read", async () => {
    setPlatformForTests("windows");
    const { host, sent } = await open(false, { clipboard_read_text: "a\nb\n" }, false);
    act(() => {
      host.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(sent).toEqual(["a\rb\r"]));
    expect(screen.queryByText("Paste 2 lines?")).toBeNull();
  });

  it("a terminal that takes no input (a finished run) gets no question and no right-click paste", async () => {
    setPlatformForTests("windows");
    const { t, host, sent, tauri } = await open(false, { clipboard_read_text: "a\nb" });
    t.options.disableStdin = true;
    paste(t.textarea!, "a\nb");
    act(() => {
      host.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText("Paste 2 lines?")).toBeNull();
    expect(tauri.callsOf("clipboard_read_text")).toHaveLength(0);
    expect(sent).toEqual([]);
  });
});
