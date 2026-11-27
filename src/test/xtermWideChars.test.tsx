// 1.168.1 (walk #13): in a Claude tile "👋 What" was drawn "👋What" — xterm
// measured the emoji as one cell while Claude Code wrote it as two. A tile's
// xterm, built with its real options, now gives a wide emoji two cells and
// keeps the TUI's box drawing and marks at one.
import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Terminal } from "@xterm/xterm";
import { shellTileTerminalOptions } from "../lib/commandBlocks";
import { xtermThemeFor } from "../lib/xtermTheme";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { FALLBACK_WIDTHS, GRAPHEME_WIDTHS, installWideChars, WIDE_CHAR_OPTIONS } from "../lib/xtermUnicode";

function write(term: Terminal, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

/** Where each character of row 0 starts, and its width. */
function cells(term: Terminal): Array<[string, number]> {
  const line = term.buffer.active.getLine(0)!;
  const out: Array<[string, number]> = [];
  for (let x = 0; x < term.cols; x++) {
    const cell = line.getCell(x)!;
    if (cell.getWidth() === 0) continue;
    out.push([cell.getChars(), cell.getWidth()]);
  }
  return out;
}

describe("wide characters in a tile's xterm", () => {
  it("a Claude tile's reply: 👋 takes two cells and the word after it its own", async () => {
    const term = new Terminal({ ...shellTileTerminalOptions(xtermThemeFor("dark")), cols: 40, rows: 4 });
    expect(installWideChars(term)).toBe(true);
    await write(term, "● Hi! 👋 What");
    const row = cells(term);
    expect(row.slice(0, 8)).toEqual([
      ["●", 1], [" ", 1], ["H", 1], ["i", 1], ["!", 1], [" ", 1], ["👋", 2], [" ", 1],
    ]);
    // Column 9 (after ● Hi! = 6, 👋 = 2, space = 1) is the W, as Claude Code
    // counts it.
    expect(term.buffer.active.getLine(0)!.getCell(9)!.getChars()).toBe("W");
    term.dispose();
  });

  it("box drawing and the TUI's marks stay one cell", async () => {
    const term = new Terminal({ ...WIDE_CHAR_OPTIONS, cols: 20, rows: 2 });
    installWideChars(term);
    await write(term, "╭─│╰┘█⏺❯✻●");
    expect(cells(term).slice(0, 10).map(([, w]) => w)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    term.dispose();
  });

  // 1.169.0 (B1): widths by grapheme cluster. An emoji made wide by VS16
  // (⚠️ = U+26A0 U+FE0F, ❤️) was one cell with Unicode 11's per-code-point
  // widths while Claude Code and Codex draw it as two, so the cursor drifted
  // one cell per emoji and redraws landed on the wrong cells.
  it("a VS16 emoji (⚠️ ❤️) takes two cells and the next character its own", async () => {
    const term = new Terminal({ ...shellTileTerminalOptions(xtermThemeFor("dark")), cols: 20, rows: 2 });
    installWideChars(term);
    expect(term.unicode.activeVersion).toBe(GRAPHEME_WIDTHS);
    await write(term, "\u26a0\ufe0fX\u2764\ufe0fY");
    expect(cells(term).slice(0, 4)).toEqual([["\u26a0\ufe0f", 2], ["X", 1], ["\u2764\ufe0f", 2], ["Y", 1]]);
    expect(term.buffer.active.cursorX).toBe(6);
    term.dispose();
  });

  it("a ZWJ sequence, a flag, a skin tone and a keycap are one two-cell character each", async () => {
    const term = new Terminal({ ...WIDE_CHAR_OPTIONS, cols: 30, rows: 2 });
    installWideChars(term);
    const family = "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}";
    const flag = "\u{1F1EE}\u{1F1F9}";
    const thumb = "\u{1F44D}\u{1F3FD}";
    const keycap = "1\ufe0f\u20e3";
    await write(term, `${family}a${flag}b${thumb}c${keycap}d`);
    expect(cells(term).slice(0, 8)).toEqual([
      [family, 2], ["a", 1], [flag, 2], ["b", 1], [thumb, 2], ["c", 1], [keycap, 2], ["d", 1],
    ]);
    term.dispose();
  });

  it("text symbols without VS16, combining marks and spinners keep one cell; CJK two", async () => {
    const term = new Terminal({ ...WIDE_CHAR_OPTIONS, cols: 30, rows: 2 });
    installWideChars(term);
    // ⚠ ✔ alone (text presentation), é as e + U+0301, braille spinner,
    // ✓ ✗ … → ✻, then 中.
    await write(term, "\u26a0\u2714e\u0301\u280b\u2713\u2717\u2026\u2192\u273b\u4e2d");
    expect(cells(term).map(([, w]) => w).slice(0, 10)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 2]);
    term.dispose();
  });

  it("falls back to Unicode 11 widths when the graphemes addon does not load", async () => {
    const term = new Terminal({ ...WIDE_CHAR_OPTIONS, cols: 20, rows: 2 });
    const load = term.loadAddon.bind(term);
    const spy = vi.spyOn(term, "loadAddon").mockImplementation((addon) => {
      if (addon instanceof UnicodeGraphemesAddon) throw new Error("no graphemes");
      load(addon);
    });
    expect(installWideChars(term)).toBe(true);
    expect(term.unicode.activeVersion).toBe(FALLBACK_WIDTHS);
    await write(term, "\u{1F44B}\u26a0\ufe0fX");
    // 👋 still two cells; ⚠️ back to one (1.168.1's widths).
    expect(cells(term).slice(0, 3)).toEqual([["\u{1F44B}", 2], ["\u26a0\ufe0f", 1], ["X", 1]]);
    spy.mockRestore();
    term.dispose();
  });

  // What the Windows console host itself measures (Windows 11 build
  // 26200.9711, inbox conhost — the one the system ConPTY runs: the cursor
  // column after WriteConsoleW of "a<seq>b" in a headless conhost, B2 probe,
  // 2026-10-23). It counts one cell per UTF-16 code unit: 👋 and VS16 emoji
  // agree with the graphemes table; a ZWJ sequence, a flag and a skin tone
  // do not. Skin tones agreed under 1.168.1's Unicode 11 widths (4 = 4) and
  // now differ (2 vs 4) — the trade for VS16, accepted by the owner. Pinned
  // so a change on either side is seen, not walked into.
  const CONHOST_CELLS: Array<[string, string, number]> = [
    ["👋", "\u{1F44B}", 2],
    ["⚠️", "\u26a0\ufe0f", 2],
    ["❤️", "\u2764\ufe0f", 2],
    ["✔️", "\u2714\ufe0f", 2],
    ["⚠", "\u26a0", 1],
    ["─", "\u2500", 1],
    ["⏺", "\u23fa", 1],
    ["👨‍👩‍👧", "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}", 8],
    ["🇮🇹", "\u{1F1EE}\u{1F1F9}", 4],
    ["👍🏽", "\u{1F44D}\u{1F3FD}", 4],
  ];
  it("agrees with the system Windows console host on VS16 emoji; not on ZWJ, flags and (since B1) skin tones", async () => {
    const term = new Terminal({ ...WIDE_CHAR_OPTIONS, cols: 30, rows: 2 });
    installWideChars(term);
    const disagree: string[] = [];
    for (const [name, seq, conhost] of CONHOST_CELLS) {
      await write(term, `\u001b[H\u001b[2Ka${seq}b`);
      if (term.buffer.active.cursorX - 2 !== conhost) disagree.push(name);
    }
    expect(disagree).toEqual(["👨‍👩‍👧", "🇮🇹", "👍🏽"]);
    term.dispose();
  });

  // One setup for every xterm in the app, so no tile measures differently.
  it("every component that makes an xterm goes through installWideChars", () => {
    const dir = join(__dirname, "../components");
    const hosts = (readdirSync(dir, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
      .filter((f) => /new (?:XTerm|Terminal)\(/.test(readFileSync(join(dir, f), "utf8")));
    expect(hosts.length).toBeGreaterThanOrEqual(6);
    for (const f of hosts) {
      expect(readFileSync(join(dir, f), "utf8"), f).toMatch(/installWideChars\(term\)/);
    }
  });

  it("without allowProposedApi it keeps the default widths and does not throw", () => {
    const term = new Terminal({ cols: 20, rows: 2 });
    expect(installWideChars(term)).toBe(false);
    term.dispose();
  });

  // 1.168.1 Windows walk (step 2): what ConPTY itself sends a PowerShell
  // tile, captured in the Windows 11 VM (build 26200, Windows PowerShell 5.1,
  // PSReadLine 2.0.0, CreatePseudoConsole with portable-pty's flags), for
  // `echo "a👋b"` then `a👋b` typed at the prompt. conhost measures 👋 as two
  // cells (CursorLeft 4 after "a👋b"); here the echo line is 65 cells in 64
  // columns, so it wraps, and ConPTY puts the typed line back with an
  // absolute CUP to row 4. Unicode 11 widths wrap it where conhost does and
  // the redraw lands on the prompt; Unicode 6 widths (before #13) left the
  // line unwrapped and drew the redraw one row below the prompt.
  const CONPTY_WRAPPED_ECHO = "\u001b[?9001h\u001b[?1004h\u001b[?25l\u001b[2J\u001b[m\u001b[HPS C:\\ply-scratch-d\\sandboxes\\tutorial-tu4\\notes-app>\u001b[1C\u001b]0;C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\u0007\u001b[?25h\u001b[?25l\u001b[91m\u001b[1;53H> \u001b[93mecho \u001b[36m\"a\ud83d\udc4b\u001b[?25h\u001b[?25l\u001b[m\u001b[1;53H> \u001b[93mecho \u001b[36m\"a\ud83d\udc4bb\"\r\n\u001b[?25h\u001b[ma\ud83d\udc4bb\r\nPS C:\\ply-scratch-d\\sandboxes\\tutorial-tu4\\notes-app> \u001b[?25l\u001b[93ma\u001b[?25h\u001b[m\u001b[?25l\u001b[93m\ba\ud83d\udc4b\u001b[?25h\u001b[m\u001b[?25l\u001b[93m\u001b[4;55Ha\ud83d\udc4bb\u001b[?25h";
  it("a shell tile agrees with ConPTY on 👋's width (captured on Windows)", async () => {
    const tile = new Terminal({ ...shellTileTerminalOptions(xtermThemeFor("dark")), cols: 64, rows: 10 });
    installWideChars(tile);
    await write(tile, CONPTY_WRAPPED_ECHO);
    const rows = [0, 1, 2, 3, 4].map((y) => tile.buffer.active.getLine(y)!.translateToString(true));
    expect(rows[3]).toBe("PS C:\\ply-scratch-d\\sandboxes\\tutorial-tu4\\notes-app> a👋b");
    expect(rows[4]).toBe("");
    tile.dispose();
    // The same stream with xterm's default (Unicode 6) widths: one row low.
    const before = new Terminal({ ...shellTileTerminalOptions(xtermThemeFor("dark")), cols: 64, rows: 10 });
    await write(before, CONPTY_WRAPPED_ECHO);
    expect(before.buffer.active.getLine(3)!.translateToString(true).trim()).toBe("a👋b");
    before.dispose();
  });

  // Known ConPTY limit, not a width question: a command line that ends
  // exactly at the right edge (65 cells in 65 columns, plain ASCII) and is
  // then entered. conhost wraps the cursor at once and keeps a blank row;
  // ConPTY sends only CRLF for it, then redraws the typed line one row lower
  // than the terminal's prompt. The same happens with or without emoji and
  // with either width table (what the Windows walk saw: its echo line was
  // exactly the tile's 60 columns). When this starts failing, ConPTY or
  // xterm changed — walk that step again.
  const CONPTY_FULL_ROW_ECHO = "\u001b[?9001h\u001b[?1004h\u001b[?25l\u001b[2J\u001b[m\u001b[HPS C:\\ply-scratch-d\\sandboxes\\tutorial-tu4\\notes-app>\u001b[1C\u001b]0;C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\u0007\u001b[?25h\u001b[?25l\u001b[93mecho \u001b[?25h\u001b[?25l\u001b[m\u001b[1;53H> \u001b[93mecho \u001b[36m\"axyb\"\u001b[?25h\u001b[m\r\naxyb\r\nPS C:\\ply-scratch-d\\sandboxes\\tutorial-tu4\\notes-app> \u001b[?25l\u001b[93ma\u001b[?25h\u001b[m\u001b[?25l\u001b[93m\baxy\u001b[?25h\u001b[m\u001b[?25l\u001b[93m\u001b[4;55Haxyb\u001b[?25h";
  // 1.169.0 (B2): the bundled ConPTY's console host (OpenConsole 1.25,
  // measured the same way in the VM) sizes by grapheme cluster by default —
  // passing PSEUDOCONSOLE_GLYPH_WIDTH_GRAPHEMES changes nothing — and agrees
  // with the tiles on every one of them, skin tones included.
  const BUNDLED_CELLS: Array<[string, string, number]> = CONHOST_CELLS.map(([name, seq]) => [
    name,
    seq,
    ["👨‍👩‍👧", "🇮🇹", "👍🏽"].includes(name) ? 2 : (CONHOST_CELLS.find(([n]) => n === name)![2]),
  ]);
  it("agrees with the bundled ConPTY's console host on every sequence", async () => {
    const term = new Terminal({ ...WIDE_CHAR_OPTIONS, cols: 30, rows: 2 });
    installWideChars(term);
    for (const [name, seq, cells] of BUNDLED_CELLS) {
      await write(term, `\u001b[H\u001b[2Ka${seq}b`);
      expect(term.buffer.active.cursorX - 2, name).toBe(cells);
    }
    term.dispose();
  });

  // 1.169.0 (B2): the same case under both ConPTYs, captured in the VM
  // (Windows PowerShell 5.1 in C:\\ply-scratch-d, so its prompt and
  // `echo "axyb"` fill 32 columns exactly; then `axyb` typed). The system
  // ConPTY redraws the typed line one row below the prompt; the bundled one
  // (NuGet Microsoft.Windows.Console.ConPTY 1.25.260930003) keeps the blank
  // row conhost keeps and redraws at the prompt.
  const FULL_ROW_SYSTEM = "G1s/OTAwMWgbWz8xMDA0aBtbPzI1bBtbMkobW20bW0hQUyBDOlxwbHktc2NyYXRjaC1kPhtbMUMbXTA7QzpcV2luZG93c1xTeXN0ZW0zMlxXaW5kb3dzUG93ZXJTaGVsbFx2MS4wXHBvd2Vyc2hlbGwuZXhlBxtbPzI1aBtdNzc3O2VjaG8HG1s/MjVsG1sxOzIwSD4gG1s5M21lY2hvIBtbMzZtImF4eWIiG1s/MjVoG1ttDQpheHliDQpQUyBDOlxwbHktc2NyYXRjaC1kPiAbXTc3Nzt0eXBlZAcbWz8yNWwbWzkzbWEbWz8yNWgbW20bWz8yNWwbWzkzbQhheHkbWz8yNWgbW20bWz8yNWwbWzkzbRtbNDsyMkhheHliG1s/MjVoG103Nzc7ZW5kBw==";
  const FULL_ROW_BUNDLED = "G1sxdBtbYxtbPzEwMDRoG1s/OTAwMWhQUyBDOlxwbHktc2NyYXRjaC1kPiAbXTc3NztlY2hvBxtbPzI1bBtbMTsyMkgbWzkzbWUbWzM5OzQ5bRtbMG0bWzE7MjNIG1s/MjVoG1s/MjVsG1sxOzIySBtbOTNtZWMbWzM5OzQ5bRtbMG0bWzE7MjRIG1s/MjVoG1s/MjVsG1sxOzIySBtbOTNtZWNoG1szOTs0OW0bWzBtG1sxOzI1SBtbPzI1aBtbPzI1bBtbMTsyMkgbWzkzbWVjaG8bWzM5OzQ5bRtbMG0bWzE7MjZIG1s/MjVoG1s/MjVsG1sxOzIySBtbOTNtZWNobxtbMzk7NDltIBtbMzk7NDltG1swbRtbMTsyN0gbWz8yNWgbWz8yNWwbWzE7MjJIG1sxOzIwSBtbOTFtPiAbWzBtG1s5M21lY2hvG1szOTs0OW0gG1szNm0iG1szOTs0OW0bWzBtG1sxOzI4SBtbPzI1aBtbPzI1bBtbMTsyMkgbWzkzbWVjaG8bWzM5OzQ5bSAbWzM2bSJhG1szOTs0OW0bWzBtG1sxOzI5SBtbPzI1aBtbPzI1bBtbMTsyMkgbWzkzbWVjaG8bWzM5OzQ5bSAbWzM2bSJheBtbMzk7NDltG1swbRtbMTszMEgbWz8yNWgbWz8yNWwbWzE7MjJIG1s5M21lY2hvG1szOTs0OW0gG1szNm0iYXh5G1szOTs0OW0bWzBtG1sxOzMxSBtbPzI1aBtbPzI1bBtbMTsyMkgbWzkzbWVjaG8bWzM5OzQ5bSAbWzM2bSJheHliG1szOTs0OW0bWzBtG1sxOzMySBtbPzI1aBtbPzI1bBtbMTsyMkgbWzE7MjBIG1szOTs0OW0+IBtbMG0bWzkzbWVjaG8bWzM5OzQ5bSAbWzM2bSJheHliIhtbMzk7NDltG1swbRtbMjsxSBtbPzI1aBtbMjsxSA0KG1swbRtbMG1heHliDQpQUyBDOlxwbHktc2NyYXRjaC1kPiAbXTc3Nzt0eXBlZAcbWz8yNWwbWzQ7MjJIG1s5M21hG1szOTs0OW0bWzBtG1s0OzIzSBtbPzI1aBtbPzI1bBtbNDsyMkgbWzkzbWF4G1szOTs0OW0bWzBtG1s0OzI0SBtbPzI1aBtbPzI1bBtbNDsyMkgbWzkzbWF4eRtbMzk7NDltG1swbRtbNDsyNUgbWz8yNWgbWz8yNWwbWzQ7MjJIG1s5M21heHliG1szOTs0OW0bWzBtG1s0OzI2SBtbPzI1aBtdNzc3O2VuZAc=";
  const fullRow = async (b64: string) => {
    const tile = new Terminal({ ...shellTileTerminalOptions(xtermThemeFor("dark")), cols: 32, rows: 10 });
    installWideChars(tile);
    await write(tile, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const rows = [0, 1, 2, 3, 4].map((y) => tile.buffer.active.getLine(y)!.translateToString(true));
    tile.dispose();
    return rows;
  };
  it("the bundled ConPTY redraws a line typed after an exactly full row at the prompt", async () => {
    expect(await fullRow(FULL_ROW_SYSTEM)).toEqual([
      'PS C:\\ply-scratch-d> echo "axyb"',
      "axyb",
      "PS C:\\ply-scratch-d> axy",
      "                     axyb",
      "",
    ]);
    expect(await fullRow(FULL_ROW_BUNDLED)).toEqual([
      'PS C:\\ply-scratch-d> echo "axyb"',
      "",
      "axyb",
      "PS C:\\ply-scratch-d> axyb",
      "",
    ]);
  });

  it("known ConPTY limit: after a line that exactly fills the row, the redraw lands one row low", async () => {
    const tile = new Terminal({ ...shellTileTerminalOptions(xtermThemeFor("dark")), cols: 65, rows: 10 });
    installWideChars(tile);
    await write(tile, CONPTY_FULL_ROW_ECHO);
    const rows = [0, 1, 2, 3].map((y) => tile.buffer.active.getLine(y)!.translateToString(true));
    expect(rows[2]).toBe("PS C:\\ply-scratch-d\\sandboxes\\tutorial-tu4\\notes-app> axy");
    expect(rows[3].trim()).toBe("axyb");
    tile.dispose();
  });
});
