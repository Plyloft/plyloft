// UX-8.3: every theme names the sixteen ANSI colours, and each colour a
// program prints text in is readable on the theme's terminal background.
import assert from "node:assert/strict";

import {
  ANSI_KEYS,
  DARK_THEME,
  LIGHT_THEME,
  VOID_THEME,
  xtermThemeFor,
} from "./xtermTheme.ts";

function luminance(hex: string): number {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

for (const [name, theme] of [
  ["dark", DARK_THEME],
  ["light", LIGHT_THEME],
  ["void", VOID_THEME],
] as const) {
  for (const key of ANSI_KEYS) {
    assert.ok(key in theme, `${name} names ${key}`);
  }
  // GH #295: every colour a program prints text in is text, held to 4.5:1
  // (WCAG 1.4.3) — dim text included: brightBlack is what autosuggestions,
  // hint lines and `git log` decorations are drawn in. Only "black" on a
  // dark screen is exempt: by convention it is a background colour there.
  for (const key of ANSI_KEYS) {
    const value = (theme as Record<string, string>)[key];
    const background = name !== "light" && key === "black";
    const min = background ? 1.2 : 4.5;
    const ratio = contrast(value, theme.background);
    assert.ok(ratio >= min, `${name} ${key} ${value} is ${ratio.toFixed(2)}:1 on ${theme.background}`);
  }
  // Blue and cyan are two colours, not one drawn twice.
  assert.notEqual(theme.blue, theme.cyan, `${name} blue differs from cyan`);
  assert.notEqual(theme.blue, theme.brightCyan, `${name} blue differs from bright cyan`);
  assert.notEqual(theme.brightBlue, theme.brightCyan, `${name} bright blue differs from bright cyan`);
}

// The light theme is the light one, and the accent still retints the cursor.
assert.equal(xtermThemeFor("light").background, "#efeff1");
assert.equal(xtermThemeFor("dark").yellow, DARK_THEME.yellow);
assert.equal(xtermThemeFor("dark", "cyan").cursor, "#22d3ee");
// GH #245: void's own accent is violet, so its cursor is too.
assert.equal(xtermThemeFor("void", "violet").cursor, "#a78bfa");

console.log("xtermTheme: all assertions passed");
