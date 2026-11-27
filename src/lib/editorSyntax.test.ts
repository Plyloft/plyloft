// GH #265: the Code editor's syntax colours are Ply tokens (`--syntax-*` in
// docs/ux-language/tokens.json), and every one of them is text people read:
// ≥ 4.5:1 (WCAG 1.4.3) on the editor's canvas (`--term-bg`), on its active
// line (term-bg under `--hover`) and under a selection (`--selected`), in
// light, dark and void. Headings are the ink at weight 600, never red.
// Run: node --experimental-strip-types src/lib/editorSyntax.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { SYNTAX_TOKENS } from "./editorSyntax.ts";

type Token = { name: string; value: string | Record<string, string> };
const tokens = JSON.parse(readFileSync("docs/ux-language/tokens.json", "utf8"));
const list: Token[] = tokens.color.tokens;
const themes: string[] = tokens.color.themes.map((t: { id: string }) => t.id);

function raw(name: string, theme: string): string {
  const t = list.find((x) => x.name === name);
  assert.ok(t, `--${name} is a token`);
  const v = typeof t.value === "string" ? t.value : t.value[theme];
  assert.ok(v, `--${name} has a ${theme} value`);
  const alias = /^\{(.+)\}$/.exec(v);
  return alias ? raw(alias[1], theme) : v;
}

type RGBA = [number, number, number, number];
function parse(c: string): RGBA {
  const hex = /^#([0-9a-f]{6})$/i.exec(c);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as RGBA;
  const fn = /^rgba?\(([^)]+)\)$/.exec(c);
  assert.ok(fn, `a colour: ${c}`);
  const [r, g, b, a = "1"] = fn[1].split(",").map((s) => s.trim());
  return [Number(r), Number(g), Number(b), Number(a)];
}
function over(top: string, under: string): string {
  const [r, g, b, a] = parse(top);
  const [R, G, B] = parse(under);
  const mix = (x: number, y: number) => Math.round(x * a + y * (1 - a));
  return "#" + [mix(r, R), mix(g, G), mix(b, B)].map((n) => n.toString(16).padStart(2, "0")).join("");
}
function luminance(c: string): number {
  const [r, g, b] = parse(c).map((n) => n / 255);
  const lin = (x: number) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Every colour the highlight style names is a token, and every token is used.
const names = list.map((t) => t.name).filter((n) => n.startsWith("syntax-"));
assert.deepEqual([...names].sort(), [...SYNTAX_TOKENS].map((n) => `syntax-${n}`).sort());

for (const theme of themes) {
  const canvas = raw("term-bg", theme);
  const grounds = {
    canvas,
    "active line": over(raw("hover", theme), canvas),
    selection: over(raw("selected", theme), canvas),
  };
  for (const name of names) {
    const ink = raw(name, theme);
    for (const [where, ground] of Object.entries(grounds)) {
      const ratio = contrast(ink, ground);
      assert.ok(
        ratio >= 4.5,
        `${theme} --${name} ${ink} is ${ratio.toFixed(2)}:1 on the ${where} (${ground})`,
      );
    }
  }
  // Red is for destruction: a heading is the ink.
  assert.equal(raw("syntax-heading", theme), raw("fg", theme), `${theme} headings are the ink`);
  assert.notEqual(raw("syntax-heading", theme), raw("danger", theme));
}

console.log("editorSyntax: all assertions passed");
