// Command blocks in PowerShell (2026-10-19): the bytes the PowerShell snippet
// (`commands.rs::SHELL_INTEGRATION_POWERSHELL`) prints in a tile, fed through
// a real xterm and the tile's own OSC 133 handler (lib/commandBlocks), and
// Settings › Editor and terminals offering PowerShell — first on Windows.
//
// The stream is what the snippet prints, in its order: `prompt` writes D (only
// after a C) and A with [Console]::Write and returns the user's prompt with B
// after it; the PSConsoleHostReadLine wrapper writes C once a non-empty line
// is accepted. ESC is [char]27 and each mark ends in BEL ([char]7).
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { blockScrollLine, shellTileTerminalOptions, trackCommandBlocks, type CommandBlock } from "../lib/commandBlocks";
import { xtermThemeFor } from "../lib/xtermTheme";
import { EditorTerminalsPage, shellSnippetChoices, snippetWhereHint } from "../components/settings/ThisMacPages";
import { DEFAULT_SETTINGS, useSettings } from "../store/settingsStore";
import { setPlatformForTests } from "../lib/platform";
import { act, renderUi, screen, tauri, waitFor } from "./render";

const ESC = "\x1b";
const BEL = "\x07";
const mark = (m: string) => `${ESC}]133;${m}${BEL}`;
/** What `prompt` prints: D (after a command), A, the prompt, B. */
const prompt = (d: string | null, text = "PS C:\\Users\\me> ") =>
  (d === null ? "" : mark(`D;${d}`)) + mark("A") + text + mark("B");

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

/** A shell tile's own xterm: the options `Terminal.tsx` makes it with, not
 *  a test's (the walk found `allowProposedApi` set only in tests). */
function tileTerminal(): Terminal {
  return new Terminal({ ...shellTileTerminalOptions(xtermThemeFor("dark")), cols: 80, rows: 24 });
}

describe("a shell tile's xterm and its OSC 133 handler", () => {
  it("draws the gutter mark with the tile's real options", async () => {
    expect(shellTileTerminalOptions(xtermThemeFor("dark")).allowProposedApi).toBe(true);
    const term = tileTerminal();
    const closed: CommandBlock[] = [];
    trackCommandBlocks(term, (b) => closed.push(b));
    await write(term, mark("A") + "$ true\r\n" + mark("C") + mark("D;0") + mark("A"));
    expect(closed).toHaveLength(1);
    expect(closed[0].decoration).not.toBeNull();
    term.dispose();
  });

  it("never stops the tile's output when a mark throws", async () => {
    // xterm 5 without allowProposedApi: registerDecoration throws.
    const term = new Terminal({ cols: 80, rows: 24 });
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const closed: CommandBlock[] = [];
      trackCommandBlocks(term, (b) => closed.push(b));
      await write(term, "$ ls\r\n" + mark("C") + "a.txt\r\n" + mark("D;0") + "$ next\r\n");
      // The block still closes, without its mark, and the text after D lands.
      expect(closed.map((b) => [b.exitCode, b.decoration])).toEqual([[0, null]]);
      const rows = Array.from({ length: 3 }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true));
      expect(rows).toEqual(["$ ls", "a.txt", "$ next"]);
      expect(errors.length).toBeGreaterThan(0);

      // A throw anywhere else in the handler (here the caller's own
      // callback) is caught too.
      const term2 = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
      trackCommandBlocks(term2, () => {
        throw new Error("boom");
      });
      await write(term2, mark("C") + mark("D;1") + "still here");
      expect(term2.buffer.active.getLine(0)?.translateToString(true)).toBe("still here");
      term2.dispose();
    } finally {
      console.error = original;
      term.dispose();
    }
  });
});

describe("a PowerShell tile's command blocks", () => {
  it("reads A…B…C…D;0 and a failing command's D;1 into two blocks, in order", async () => {
    const term = tileTerminal();
    const closed: CommandBlock[] = [];
    let clock = 1_000;
    const tracker = trackCommandBlocks(term, (b) => closed.push(b), () => clock);

    // The first prompt: no command ran, so no D.
    await write(term, prompt(null));
    expect(tracker.open()).toBeNull();

    // `Get-Date` accepted: the echo and newline, then C, the output, then the
    // next prompt with D;0.
    await write(term, "Get-Date\r\n" + mark("C"));
    expect(tracker.open()).not.toBeNull();
    clock += 50;
    await write(term, "\r\nMonday, 19 October 2026 10:00:00\r\n\r\n" + prompt("0"));
    expect(tracker.open()).toBeNull();

    // An empty Enter: the wrapper prints no C, so the prompt prints no D.
    await write(term, "\r\n" + prompt(null));

    // A failing cmdlet ($? false, no native code): D;1. The stream arrives
    // in pieces that split a mark, as a ConPTY read can.
    clock += 50;
    const failing = "Get-Item nope\r\n" + mark("C") + "Get-Item: Cannot find path\r\n" + prompt("1");
    for (const piece of [failing.slice(0, 18), failing.slice(18, 40), failing.slice(40)]) {
      await write(term, piece);
    }

    // A native command's own exit code: D;-1073741510 (Ctrl+C on Windows).
    clock += 50;
    await write(term, "ping host\r\n" + mark("C") + "^C\r\n" + prompt("-1073741510"));

    expect(closed.map((b) => [b.id, b.exitCode])).toEqual([
      [1, 0],
      [2, 1],
      [3, -1073741510],
    ]);
    expect(closed.every((b) => b.endedAt !== null && b.endedAt >= b.startedAt)).toBe(true);
    expect(closed.every((b) => b.marker !== null)).toBe(true);
    tracker.dispose();
    term.dispose();
  });

  it("leaves the marks out of the screen", async () => {
    const term = tileTerminal();
    trackCommandBlocks(term, () => {});
    await write(term, prompt(null) + "dir\r\n" + mark("C") + "a.txt\r\n" + prompt("0"));
    const rows = Array.from({ length: 4 }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true) ?? "");
    expect(rows).toEqual(["PS C:\\Users\\me> dir", "a.txt", "PS C:\\Users\\me> ", ""]);
    term.dispose();
  });
});

describe("Recent commands' jump", () => {
  const row = (term: Terminal, line: number) => term.buffer.active.getLine(line)?.translateToString(true) ?? "";

  it("puts the prompt and command line at the top, the output below (zsh)", async () => {
    const term = tileTerminal();
    const closed: CommandBlock[] = [];
    trackCommandBlocks(term, (b) => closed.push(b));
    // Scrollback before it, so the jump really scrolls.
    for (let i = 0; i < 60; i++) await write(term, `line ${i}\r\n`);
    // zsh: precmd prints D and A, the prompt; preexec prints C after Enter.
    await write(term, mark("A") + "me@mac code % ls nope\r\n" + mark("C") + "ls: nope: No such file\r\n");
    await write(term, mark("D;1") + mark("A") + "me@mac code % ");
    for (let i = 0; i < 60; i++) await write(term, `more ${i}\r\n`);

    const line = blockScrollLine(closed[0], term.rows);
    // `Terminal.tsx` scrolls with `term.scrollToLine(line)`: this row at the top.
    expect(line).not.toBeNull();
    const top = line!;
    expect(top).toBeLessThan(term.buffer.active.baseY);
    expect(row(term, top)).toBe("me@mac code % ls nope");
    expect(row(term, top + 1)).toBe("ls: nope: No such file");
    term.dispose();
  });

  it("shows a two-row prompt whole, and falls back to the row above the output without an A", async () => {
    const term = tileTerminal();
    const closed: CommandBlock[] = [];
    trackCommandBlocks(term, (b) => closed.push(b));
    await write(term, "\r\n\r\n" + mark("A") + "~/code (main)\r\n❯ git status\r\n" + mark("C") + "clean\r\n" + mark("D;0"));
    expect(row(term, blockScrollLine(closed[0], term.rows)!)).toBe("~/code (main)");

    // A shell that printed no A (a C straight after the echo).
    await write(term, "$ date\r\n" + mark("C") + "Tue\r\n" + mark("D;0"));
    expect(closed[1].promptMarker).toBeNull();
    expect(row(term, blockScrollLine(closed[1], term.rows)!)).toBe("$ date");
    term.dispose();
  });

  it("never scrolls the output's first row out of view, and is null out of scrollback", async () => {
    const term = new Terminal({ ...shellTileTerminalOptions(xtermThemeFor("dark")), cols: 80, rows: 5, scrollback: 20 });
    const closed: CommandBlock[] = [];
    trackCommandBlocks(term, (b) => closed.push(b));
    // A prompt taller than the viewport: the output row stays the last one shown.
    await write(term, mark("A") + "1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n% x\r\n" + mark("C") + "out\r\n" + mark("D;0"));
    const line = blockScrollLine(closed[0], term.rows)!;
    expect(row(term, line + term.rows - 1)).toBe("out");
    // Past the scrollback limit the marker is disposed.
    for (let i = 0; i < 60; i++) await write(term, `x ${i}\r\n`);
    expect(blockScrollLine(closed[0], term.rows)).toBeNull();
    term.dispose();
  });
});

describe("Settings › Command blocks › Which shell", () => {
  it("offers PowerShell first on Windows and last on the Mac", () => {
    expect(shellSnippetChoices(true).map((c) => c.value)).toEqual(["powershell", "bash"]);
    expect(shellSnippetChoices(false).map((c) => c.value)).toEqual(["zsh", "bash", "powershell"]);
  });

  function load() {
    tauri().fixture("settings_set", ({ settings }: Record<string, unknown>) => settings);
    tauri().fixture("shell_integration_script", ({ shell }: Record<string, unknown>) => `# snippet for ${String(shell)}`);
    const settings = {
      ...DEFAULT_SETTINGS,
      behavior: { ...DEFAULT_SETTINGS.behavior, commandBlocksEnabled: true },
    };
    act(() => useSettings.setState({ settings, loaded: true }));
  }

  it("on Windows asks for the PowerShell snippet and says where $PROFILE is", async () => {
    setPlatformForTests("windows");
    load();
    renderUi(<EditorTerminalsPage scope="this-mac" />);
    expect(await screen.findByText("# snippet for powershell")).toBeTruthy();
    expect(tauri().callsOf("shell_integration_script")[0].args).toEqual({ shell: "powershell" });
    const select = screen.getByRole("combobox", { name: "Which shell" }) as HTMLSelectElement;
    expect(select.value).toBe("powershell");
    expect([...select.options].map((o) => o.textContent)).toEqual(["PowerShell — $PROFILE", "Git Bash — ~/.bashrc"]);
    expect(screen.getByText(/at the end of the file PowerShell names when you type \$PROFILE/)).toBeTruthy();
    expect(screen.getByText(/first lines say how to create that file/)).toBeTruthy();
    expect(screen.getByText(/RemoteSigned in it once/)).toBeTruthy();
    // Challenger: `New-Item -Force` on a profile that is there empties it.
    expect(screen.queryByText(/New-Item -Force \$PROFILE/)).toBeNull();
    expect(screen.queryByText(/Git Bash only|don't show them yet/)).toBeNull();
  });

  it("on the Mac starts at zsh and offers PowerShell too", async () => {
    load();
    const { user } = renderUi(<EditorTerminalsPage scope="this-mac" />);
    expect(await screen.findByText("# snippet for zsh")).toBeTruthy();
    const select = screen.getByRole("combobox", { name: "Which shell" }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["zsh", "bash", "powershell"]);
    // The row isn't set in the Details body's mono; only the snippet is.
    expect(select.closest(".ux-details-body")).toBeNull();
    expect(screen.getByText("# snippet for zsh").closest(".ux-details-body")).not.toBeNull();
    expect(screen.getByText("Paste it at the end of the file, then open a fresh shell tile.")).toBeTruthy();
    await user.selectOptions(select, "powershell");
    expect(await screen.findByText("# snippet for powershell")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/when you type \$PROFILE/)).toBeTruthy());
    // The Mac has no Windows PowerShell: neither of its two notes.
    expect(screen.queryByText(/Windows PowerShell|Set-ExecutionPolicy/)).toBeNull();
  });

  it("names the profile's creation only in the form that keeps an existing one", () => {
    for (const windows of [true, false]) {
      expect(snippetWhereHint("powershell", windows)).not.toMatch(/New-Item/);
    }
    expect(snippetWhereHint("powershell", false)).not.toMatch(/Windows PowerShell/);
    expect(snippetWhereHint("zsh", true)).toBe("Paste it at the end of the file, then open a fresh shell tile.");
  });
});
