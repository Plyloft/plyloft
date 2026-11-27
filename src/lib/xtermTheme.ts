/**
 * v1.64.0 (UX revamp step 0): the single source of truth for xterm.js
 * theming, extracted from the three per-component copies (Terminal,
 * IntakeConversation, AgentRunView).
 *
 * Terminal canvases are RECESSED — `background` sits one step below the
 * page (`--term-bg` in App.css) so terminals read as designed objects,
 * not holes in the chrome. Keep the background hexes in sync with the
 * `--term-bg` values per theme, and ACCENT_CURSOR with the
 * `[data-accent]` hexes.
 */

/** The sixteen ANSI colours a theme names (UX-8.3). */
export const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/**
 * UX-8.3: dark and light get an ANSI palette of their own, readable on their
 * `--term-bg` (lib/xtermTheme.test.ts holds every colour a program prints
 * text in to 4.5:1 against it, GH #295). xterm's default palette is drawn for a black
 * background: on the light theme its yellow and white vanished.
 */
export const DARK_THEME = {
  background: "#161618",
  foreground: "#f5f5f7",
  cursor: "#f5f5f7",
  selectionBackground: "#3a3a3c",
  black: "#3a3a3c",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#e879f9",
  cyan: "#22d3ee",
  white: "#d4d4d8",
  brightBlack: "#8a8a90",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde047",
  brightBlue: "#93c5fd",
  brightMagenta: "#f0abfc",
  brightCyan: "#67e8f9",
  brightWhite: "#ffffff",
};

export const LIGHT_THEME = {
  background: "#efeff1",
  foreground: "#1c1c1e",
  cursor: "#1c1c1e",
  selectionBackground: "#d4d4d8",
  black: "#1c1c1e",
  red: "#c81e1e",
  green: "#166534",
  yellow: "#8a5a00",
  blue: "#1d4ed8",
  magenta: "#a21caf",
  cyan: "#0e7490",
  // "White" is text too: a program that prints it assumes a dark screen.
  white: "#5f6672",
  brightBlack: "#636369",
  brightRed: "#b91c1c",
  brightGreen: "#136f35",
  brightYellow: "#92400e",
  brightBlue: "#2563eb",
  brightMagenta: "#86198f",
  brightCyan: "#155e75",
  brightWhite: "#3a3a3c",
};

export const VOID_THEME = {
  background: "#000000",
  foreground: "#e6e6e6",
  // The cursor is the accent: violet, as in every theme (GH #245).
  cursor: "#a78bfa",
  selectionBackground: "rgba(167, 139, 250, 0.28)",
  black: "#1a1a1a",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#fbbf24",
  // GH #295: blue is blue — it was cyan's twin, so `ls` directories and
  // cyan prompts read the same.
  blue: "#60a5fa",
  magenta: "#d946ef",
  cyan: "#06b6d4",
  white: "#e6e6e6",
  // GH #295: dim text (autosuggestions, hints, `git log` decorations) is
  // text: 5.9:1 on black, not 2.4:1.
  brightBlack: "#8a8a8a",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#fde047",
  brightBlue: "#93c5fd",
  brightMagenta: "#f0abfc",
  brightCyan: "#22d3ee",
  brightWhite: "#ffffff",
};

/** Accent presets retint the cursor; "violet" = the theme's own cursor
 *  (violet on void, the ink on light and dark). */
const ACCENT_CURSOR: Record<string, string | null> = {
  violet: null,
  cyan: "#22d3ee",
  magenta: "#f472b6",
  sunset: "#ff6b90",
};

export function xtermThemeFor(name: string, accent?: string) {
  const base = (() => {
    switch (name) {
      case "dark":
        return DARK_THEME;
      case "void":
        return VOID_THEME;
      case "light":
      default:
        return LIGHT_THEME;
    }
  })();
  const cursor = accent ? ACCENT_CURSOR[accent] : null;
  return cursor ? { ...base, cursor } : base;
}
