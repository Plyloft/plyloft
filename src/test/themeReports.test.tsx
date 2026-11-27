// 1.168.1 (C1): a tile started in Light follows the app to Dark. A real
// xterm with the tile's options and lib/themeReports: the program that
// enabled DEC mode 2031 (Claude Code does, measured on 2.1.308) is told the
// scheme changed, and its OSC 11 question is answered from the new theme;
// a shell that never asked gets nothing.
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { shellTileTerminalOptions } from "../lib/commandBlocks";
import { xtermThemeFor } from "../lib/xtermTheme";
import { colorSchemeReport, isDarkTerminalTheme, minimumContrastFor, trackThemeReports } from "../lib/themeReports";
import { isTerminalReport } from "../lib/builderInject";

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function tile(start: string) {
  const term = new Terminal({ ...shellTileTerminalOptions(xtermThemeFor(start)), cols: 80, rows: 24 });
  const sent: string[] = [];
  // Opened, as a tile is: xterm answers OSC 11 from its theme service.
  term.open(document.body.appendChild(document.createElement("div")));
  // Focus in/out (mode 1004) is xterm's own report, not this one's.
  term.onData((d) => {
    if (d !== "\x1b[O" && d !== "\x1b[I") sent.push(d);
  });
  const reports = trackThemeReports(term, isDarkTerminalTheme(start));
  const switchTo = (next: string) => {
    term.options.theme = xtermThemeFor(next);
    reports.notify(isDarkTerminalTheme(next));
  };
  return { term, sent, reports, switchTo };
}

describe("colour scheme reports (DEC 2031)", () => {
  it("tells a program that asked when Light turns Dark, and back", async () => {
    const { term, sent, reports, switchTo } = tile("light");
    await write(term, "\x1b[?2031h\x1b[?1004h");
    expect(reports.enabled).toBe(true);
    // xterm still handled the other mode of the same kind.
    expect(term.modes.sendFocusMode).toBe(true);
    switchTo("dark");
    expect(sent).toEqual(["\x1b[?997;1n"]);
    switchTo("void"); // still dark: no repeat
    switchTo("light");
    expect(sent).toEqual(["\x1b[?997;1n", "\x1b[?997;2n"]);
    term.dispose();
  });

  it("answers the program's next OSC 11 from the new theme", async () => {
    const { term, sent, switchTo } = tile("light");
    await write(term, "\x1b[?2031h");
    switchTo("dark");
    await write(term, "\x1b]11;?\x1b\\");
    const answer = sent.find((s) => s.startsWith("\x1b]11;"));
    // #161618 (DARK_THEME.background), not the light #efeff1.
    expect(answer).toMatch(/rgb:1616\/1616\/1818/);
    term.dispose();
  });

  it("sends nothing to a shell that never enabled it, or after it turned it off", async () => {
    const { term, sent, switchTo } = tile("light");
    switchTo("dark");
    expect(sent).toEqual([]);
    await write(term, "\x1b[?2031h\x1b[?2031l");
    switchTo("light");
    expect(sent).toEqual([]);
    term.dispose();
  });

  it("answers CSI ? 996 n with the current scheme", async () => {
    const { term, sent } = tile("dark");
    await write(term, "\x1b[?996n");
    expect(sent).toEqual([colorSchemeReport(true)]);
    term.dispose();
  });

  it("is a terminal report, not the Builder typing", () => {
    expect(isTerminalReport(colorSchemeReport(true))).toBe(true);
    expect(isTerminalReport(colorSchemeReport(false))).toBe(true);
  });

  it("keeps a Codex band drawn for the old theme legible; leaves Claude and shells alone", () => {
    expect(minimumContrastFor("codex")).toBe(3);
    expect(minimumContrastFor("claude")).toBe(1);
    expect(minimumContrastFor(null)).toBe(1);
  });

  it("reads 2031 inside a combined DECSET, and says when it sent a report", async () => {
    const { term, sent, reports } = tile("light");
    await write(term, "\x1b[?1004;2031h");
    expect(reports.enabled).toBe(true);
    expect(term.modes.sendFocusMode).toBe(true);
    expect(reports.notify(true)).toBe(true);
    expect(reports.notify(true)).toBe(false); // no flip
    expect(sent).toEqual([colorSchemeReport(true)]);
    term.dispose();
  });

  it("turns off on a full reset (ESC c) and a soft reset (CSI ! p)", async () => {
    for (const reset of ["\x1bc", "\x1b[!p"]) {
      const { term, sent, reports } = tile("light");
      await write(term, "\x1b[?2031h" + reset);
      expect(reports.enabled, JSON.stringify(reset)).toBe(false);
      expect(reports.notify(true)).toBe(false);
      expect(sent).toEqual([]);
      term.dispose();
    }
  });

  it("runs onReport only for a report it sent", async () => {
    const term = new Terminal({ ...shellTileTerminalOptions(xtermThemeFor("light")), cols: 80, rows: 24 });
    let reported = 0;
    const reports = trackThemeReports(term, false, { onReport: () => (reported += 1) });
    reports.notify(true); // not enabled yet
    expect(reported).toBe(0);
    await write(term, "\x1b[?2031h");
    reports.notify(false);
    expect(reported).toBe(1);
    term.dispose();
  });

  it("an OSC 11 question before the view opens gets no answer, so nothing stray reaches the prompt", async () => {
    // The Builder / intake attach order (claude_theme.rs): Claude then falls
    // back to COLORFGBG, which the spawn sets from Ply's lightness.
    const term = new Terminal({ ...shellTileTerminalOptions(xtermThemeFor("light")), cols: 80, rows: 24 });
    const sent: string[] = [];
    term.onData((d) => sent.push(d));
    await write(term, "\x1b]11;?\x1b\\");
    expect(sent.some((d) => d.includes("]11;rgb:"))).toBe(false);
    // During a Builder replay an answer is a terminal report, dropped.
    expect(isTerminalReport("\x1b]11;rgb:efef/efef/f1f1\x1b\\")).toBe(true);
    term.dispose();
  });
});
