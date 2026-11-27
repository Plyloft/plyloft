// The accent presets against the Design System's tokens, in every theme.
// Run with Node 22+:  node --experimental-strip-types src/lib/accentContrast.test.ts
//
// 1. The chosen preset is the colour on screen in every theme (GH #245): the
//    default ("violet", no data-accent) resolves to accent-violet too.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error — a plain .mjs script, no types
import { CSS_FILE, TOKENS_FILE, currentBlock } from "../../scripts/tokens-css.mjs";
import { ACCENT_CHOICES } from "./repositoryAccent.ts";

type Theme = "light" | "dark" | "void";
const tokens = JSON.parse(readFileSync(TOKENS_FILE, "utf8"));
const block: string = currentBlock(readFileSync(CSS_FILE, "utf8"));
const THEMES: Theme[] = tokens.color.themes.map((t: { id: Theme }) => t.id);
const PRESETS = ["violet", "cyan", "magenta", "sunset"] as const;
type Preset = (typeof PRESETS)[number];

function token(name: string, theme: Theme): string {
  const t = tokens.color.tokens.find((x: { name: string }) => x.name === name);
  assert.ok(t, `tokens.json names ${name}`);
  return typeof t.value === "string" ? t.value : t.value[theme];
}

/** What --claude-accent and --on-accent resolve to under a preset. The
 *  default ("violet") sets no data-accent, so the theme's own values show. */
function resolved(theme: Theme, preset: Preset): { accent: string; on: string } {
  if (preset === "violet") return { accent: token("claude-accent", theme), on: token("on-accent", theme) };
  const rule = `:root[data-accent="${preset}"] { --claude-accent: var(--accent-${preset}); --on-accent: var(--on-accent-preset); }`;
  assert.ok(block.includes(rule), `App.css carries the ${preset} preset rule`);
  return { accent: token(`accent-${preset}`, theme), on: token("on-accent-preset", theme) };
}

// ── 1. The preset is the colour (GH #245) ─────────────────────────────────
for (const theme of THEMES) {
  for (const preset of PRESETS) {
    assert.equal(
      resolved(theme, preset).accent.toLowerCase(),
      token(`accent-${preset}`, theme).toLowerCase(),
      `${theme} + ${preset} paints accent-${preset}`,
    );
  }
}

// ── WCAG 2 contrast, with translucent washes composited ───────────────────
type RGBA = [number, number, number, number];
function parse(c: string): RGBA {
  const hex = /^#([0-9a-f]{6})$/i.exec(c);
  if (hex) {
    const n = hex[1];
    return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16)).concat(1) as RGBA;
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(c);
  assert.ok(fn, `a colour I can read: ${c}`);
  const [r, g, b, a = "1"] = fn[1].split(",").map((s) => s.trim());
  return [Number(r), Number(g), Number(b), Number(a)];
}
function over(top: string, base: RGBA): RGBA {
  const t = parse(top);
  const a = t[3];
  return [0, 1, 2].map((i) => t[i] * a + base[i] * (1 - a)).concat(1) as RGBA;
}
function luminance([r, g, b]: RGBA): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: RGBA, b: RGBA): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const SURFACES = ["bg", "panel-bg", "raised"] as const;
const WASHES = ["hover", "selected"] as const;

// ── 2. The accent as text, and text on the accent (GH #246) ───────────────
for (const theme of THEMES) {
  for (const preset of PRESETS) {
    const { accent, on } = resolved(theme, preset);
    const where = `${theme} + ${preset}`;
    for (const s of SURFACES) {
      const ground = parse(token(s, theme));
      const text = contrast(parse(accent), ground);
      assert.ok(text >= 4.5, `${where}: accent text on ${s} is ${text.toFixed(2)}:1`);
      // A washed row draws its count in the ink, which clears it everywhere.
      for (const w of WASHES) {
        const washed = over(token(w, theme), ground);
        const ink = contrast(parse(token("fg", theme)), washed);
        assert.ok(ink >= 4.5, `${where}: fg on ${w} over ${s} is ${ink.toFixed(2)}:1`);
      }
    }
    const fill = contrast(parse(on), parse(accent));
    assert.ok(fill >= 4.5, `${where}: on-accent on the accent is ${fill.toFixed(2)}:1`);
  }
}

// The attention count leaves the accent on every washed row it can sit on.
{
  const shell = readFileSync(new URL("../components/shell.css", import.meta.url), "utf8");
  const rule = /([^{}]+)\{\s*color: var\(--fg\);\s*\}/g;
  const inked = [...shell.matchAll(rule)]
    .flatMap((m) => m[1].replace(/\/\*[\s\S]*?\*\//g, "").split(","))
    .map((s) => s.trim());
  for (const washed of [
    ".shell-nav-item.is-selected .shell-count--attention",
    ".shell-nav-item:hover:not(:disabled) .shell-count--attention",
    ".shell-switcher-row:hover .shell-count--attention",
    ".shell-switcher-item[aria-current] .shell-count--attention",
  ]) {
    assert.ok(inked.includes(washed), `${washed} draws the count in --fg`);
  }
}

// ── 3. No preset shares the failure hue (GH #247) ─────────────────────────
function hue([r, g, b]: RGBA): number {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const d = max - Math.min(R, G, B);
  if (d === 0) return 0;
  const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return (h * 60 + 360) % 360;
}
const apart = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
for (const theme of THEMES) {
  const failure = hue(parse(token("signal-aborted-fg", theme)));
  for (const preset of PRESETS) {
    const h = hue(parse(token(`accent-${preset}`, theme)));
    assert.ok(
      apart(h, failure) >= 30,
      `${theme}: accent-${preset} (${h.toFixed(0)}°) is ${apart(h, failure).toFixed(0)}° from the failure amber (${failure.toFixed(0)}°)`,
    );
  }
}

// QoL 1.168 (block 10, A6): …nor reads as a crash — the crash red is a
// state now (signal-crashed-fg). A warm preset can't sit 30° from both the
// amber and the red, so 15° from the red, with the amber's 30° kept.
const resolve = (name: string, theme: Theme): string => {
  const v = token(name, theme);
  const alias = /^\{(.+)\}$/.exec(v);
  return alias ? resolve(alias[1], theme) : v;
};
for (const theme of THEMES) {
  const crash = hue(parse(resolve("signal-crashed-fg", theme)));
  for (const preset of PRESETS) {
    const h = hue(parse(token(`accent-${preset}`, theme)));
    assert.ok(
      apart(h, crash) >= 15,
      `${theme}: accent-${preset} (${h.toFixed(0)}°) is ${apart(h, crash).toFixed(0)}° from the crash red (${crash.toFixed(0)}°)`,
    );
  }
}

// ── 4. The workspace colour is the same palette (GH #272) ─────────────────
// Its values are the light presets, and the chip's white monogram reads on each.
for (const c of ACCENT_CHOICES) {
  assert.equal(c.value.toLowerCase(), token(`accent-${c.id}`, "light").toLowerCase(), `${c.id} is accent-${c.id}`);
  const mono = contrast(parse("#ffffff"), parse(c.value));
  assert.ok(mono >= 4.5, `white on the ${c.id} chip is ${mono.toFixed(2)}:1`);
}

console.log("accentContrast: all contracts passed");
