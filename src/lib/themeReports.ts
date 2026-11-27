/**
 * 1.168.1 (C1): a terminal's light/dark change reaches the program inside it.
 *
 * A TUI picks its colours from the background the terminal reports when it
 * starts (OSC 11): Claude Code started in Light keeps light bands after the
 * app turns Dark. xterm.js recolours its own palette live but has no colour
 * scheme reports, so a program can't learn the theme changed. This adds the
 * standard ones (DEC private mode 2031, as in Contour, Ghostty, kitty):
 *
 * - a program enables `CSI ? 2031 h` (Claude Code does) and is sent
 *   `CSI ? 997 ; 1 n` (dark) or `CSI ? 997 ; 2 n` (light) on every change;
 *   it then asks OSC 11 again, which xterm answers from the new theme;
 * - `CSI ? 996 n` asks for the current scheme at any time.
 *
 * Only a program that asked gets the report — a shell never enables 2031,
 * so nothing reaches a prompt. The report is fed through `term.input(…,
 * false)` so it takes the same path as xterm's own replies (onData → PTY).
 * Nothing here spawns or touches the PTY itself.
 */
import type { IDisposable, Terminal } from "@xterm/xterm";

/** The themes whose terminal canvas is dark (lib/xtermTheme). */
export function isDarkTerminalTheme(name: string): boolean {
  return name === "dark" || name === "void";
}

/** The colour scheme report: 1 dark, 2 light. */
export function colorSchemeReport(dark: boolean): string {
  return `\x1b[?997;${dark ? 1 : 2}n`;
}

/**
 * xterm's contrast floor for a tile. Codex (0.163) picks its message bands
 * from the background at launch and never asks again, and prints their text
 * in the default colour: started in Light and switched to Dark, that is the
 * new near-white text on the old light band. A floor of 3:1 has xterm darken
 * the text on such a band. Every theme colour already meets 4.5:1 on its own
 * background (lib/xtermTheme.test.ts), so ordinary output is untouched.
 * Claude Code redraws from the report and colours its own text; a shell's
 * colours are the member's: both keep xterm's default (1, off).
 */
export function minimumContrastFor(vendor: "claude" | "codex" | null): number {
  return vendor === "codex" ? 3 : 1;
}

const MODE = 2031;
const QUERY = 996;

type ReportsTerminal = Pick<Terminal, "parser" | "input">;

export type ThemeReports = IDisposable & {
  /** Call with the terminal's theme after it changed: reports a light/dark
   *  flip when the program asked for reports. True when a report was sent
   *  (the program will redraw). */
  notify(dark: boolean): boolean;
  /** Whether the program has mode 2031 on (for tests). */
  readonly enabled: boolean;
};

function hasParam(params: (number | number[])[], n: number): boolean {
  return params.some((p) => (Array.isArray(p) ? p[0] === n : p === n));
}

const NO_REPORTS: ThemeReports = { enabled: false, notify: () => false, dispose() {} };

export type ThemeReportOptions = {
  /** Runs when a report was sent, before the program's redraw arrives: the
   *  host treats that redraw as a resize's (not the session working — the
   *  silence clock and the readiness scan rebaseline). */
  onReport?: () => void;
};

export function trackThemeReports(
  term: ReportsTerminal,
  startsDark: boolean,
  { onReport }: ThemeReportOptions = {},
): ThemeReports {
  // A terminal without a CSI parser hook (a test's stand-in) just goes
  // without reports; the tile never fails for them.
  if (typeof term.parser?.registerCsiHandler !== "function") return NO_REPORTS;
  let enabled = false;
  let last = startsDark;
  // Returning false lets xterm handle the other modes of the same sequence.
  const set = term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
    if (hasParam(params as (number | number[])[], MODE)) enabled = true;
    return false;
  });
  const reset = term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
    if (hasParam(params as (number | number[])[], MODE)) enabled = false;
    return false;
  });
  // A full reset (RIS `ESC c`, soft reset DECSTR `CSI ! p`) turns every mode
  // off, this one too.
  const ris = term.parser.registerEscHandler({ final: "c" }, () => {
    enabled = false;
    return false;
  });
  const decstr = term.parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => {
    enabled = false;
    return false;
  });
  const query = term.parser.registerCsiHandler({ prefix: "?", final: "n" }, (params) => {
    if (params.length !== 1 || params[0] !== QUERY) return false;
    term.input(colorSchemeReport(last), false);
    return true;
  });
  return {
    get enabled() {
      return enabled;
    },
    notify(dark) {
      if (dark === last) return false;
      last = dark;
      if (!enabled) return false;
      onReport?.();
      term.input(colorSchemeReport(dark), false);
      return true;
    },
    dispose() {
      set.dispose();
      reset.dispose();
      ris.dispose();
      decstr.dispose();
      query.dispose();
    },
  };
}
