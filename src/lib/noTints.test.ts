// P32 (UX audit 1.173, VC-1 · BCI-15 · T15 · VC-9): no tinted boxes. A box,
// a banner, a row or a chip never carries its state on a wash of an accent or
// status colour: the surface stays neutral (raised, a hairline border), the
// colour lives on a dot or an icon and the words say the rest (owner,
// 2026-10-28, "calm surfaces").
// Run with Node 22+:  node --experimental-strip-types src/lib/noTints.test.ts
//
// Fails on, anywhere in src/ (every .css; inline styles in .ts/.tsx), a
// `background` / `background-color` / `background-image` that is a tint:
//   - a tint token: `--signal-running-bg`, `--signal-done-bg`,
//     `--signal-aborted-bg`, `--danger-wash`, or any custom property whose
//     own value is a tint — in CSS or set inline (`"--x": "rgba(…)"`), found
//     from the definitions, so a new token that hides a wash is caught too;
//   - a coloured `rgb()`/`rgba()`/`hsl()`/`hsla()`, or a 4- or 8-digit hex,
//     with an alpha below 1 (a grey one — near-equal channels, or no
//     saturation — is a neutral wash and is fine);
//   - a `color-mix()` of a coloured ink (a colour token, a literal colour or
//     `currentColor`) with transparent or a neutral.
// An inline style's whole expression is read, so a ternary or a template
// that can produce a tint counts.
// …outside ALLOWED (a tint that is the content itself, not a box's state)
// and BASELINE (the tints that were there when this guard landed), each
// keyed by file, selector and declaration. The baseline is a ratchet: it
// only goes down. A declaration that no longer tints must leave it, and
// nothing new may join it.
//
// BORDERS does the same for a coloured border (`border`, `border-color`,
// `outline`) drawn from a tint or a coloured alpha: the amber outline that
// goes with an amber wash. The calm look keeps the hairline `--border` /
// `--border-strong`, so these are baselined with their families.
//
// VC-9 (a layout regression this guard names): fixed by 1.174.0 A7, and
// asserted to stay fixed.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));

type Entry = { file: string; selector: string; decl: string; reason: string };

/** Tints that are the content, not a surface's state. */
const ALLOWED: Entry[] = [
  { file: "App.css", selector: ".run-changes-kind.kind-added", decl: "background: var(--signal-done-bg)", reason: "the run's changed-file kind tag is the content (VC-1 keeps the run-changes kinds)" },
  { file: "App.css", selector: ".run-changes-kind.kind-modified", decl: "background: var(--signal-aborted-bg)", reason: "the run's changed-file kind tag is the content (VC-1 keeps the run-changes kinds)" },
  { file: "App.css", selector: ".run-changes-kind.kind-removed", decl: "background: var(--danger-wash)", reason: "the run's changed-file kind tag is the content (VC-1 keeps the run-changes kinds)" },
  { file: "App.css", selector: ".card-review-line.diff-add", decl: "background: var(--signal-done-bg)", reason: "an added or removed line in the comparison view is the content (VC-1 keeps the diff view)" },
  { file: "App.css", selector: ".card-review-line.diff-del", decl: "background: var(--danger-wash)", reason: "an added or removed line in the comparison view is the content (VC-1 keeps the diff view)" },
];

/** Coloured borders that are the content's own signal (owner, 1.174.0 A7). */
const ALLOWED_BORDERS: Entry[] = [
  { file: "App.css", selector: ".ws-template-newform-row input[aria-invalid=\"true\"]", decl: "border-color: var(--signal-aborted-border)", reason: "invalid field next to its error text" },
  { file: "components/ux/ux.css", selector: ".ux-field--error", decl: "border-color: var(--signal-aborted-border)", reason: "invalid field next to its error text" },
];

/** Tinted surfaces that predate the guard (1.174.0, B2). Card A7 made every
 *  one calm (mockups/board.html §7/7b: the raised surface, a hairline, the
 *  colour on a dot or an icon; danger hovers neutral, none in ALLOWED) and
 *  deleted the dead rules (`.cicon--accent`, `.builder-chip-*`). It stays
 *  empty: the ratchet only goes down. */
const BASELINE: Entry[] = [];

/** Coloured borders (same ratchet). A7 made every one calm; the two
 *  invalid-field outlines are ALLOWED_BORDERS (owner). It stays empty. */
const BORDERS: Entry[] = [];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

/** The inks that carry no colour: a mix of these is a neutral wash. */
const NEUTRAL_VARS = new Set([
  "--fg",
  "--bg",
  "--muted",
  "--panel-bg",
  "--raised",
  "--hover",
  "--selected",
  "--border",
  "--border-strong",
  "--border-control",
  "--shell-accent",
  "--term-bg",
  "--scrim",
]);
/** Literal colours that carry no hue. */
const NEUTRAL_WORDS = new Set(["transparent", "white", "black", "gray", "grey", "silver", "canvas", "canvastext"]);
const SEED_TINTS = ["--signal-running-bg", "--signal-done-bg", "--signal-aborted-bg", "--danger-wash"];

/** Near-equal channels: a grey (the inks are a warm 28/28/30). */
const isGrey = (r: number, g: number, b: number) => Math.max(r, g, b) - Math.min(r, g, b) <= 8;

const alphaOf = (a: string) => (a.endsWith("%") ? Number(a.slice(0, -1)) / 100 : Number(a));

/** A hex colour's channels and alpha (3, 4, 6 or 8 digits). */
function hex(h: string): [number, number, number, number] {
  const full = h.length <= 4 ? [...h].map((c) => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  const a = full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1;
  return [r, g, b, a];
}

/** A colour literal with an alpha below 1 that is not a grey. */
function isColouredAlpha(value: string): boolean {
  for (const m of value.matchAll(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*[,/]\s*([\d.]+%?)\s*\)/g)) {
    const a = alphaOf(m[4]);
    if (a < 1 && a > 0 && !isGrey(Number(m[1]), Number(m[2]), Number(m[3]))) return true;
  }
  for (const m of value.matchAll(/hsla?\(\s*[\d.]+(?:deg)?[\s,]+([\d.]+)%[\s,]+[\d.]+%\s*[,/]\s*([\d.]+%?)\s*\)/g)) {
    const a = alphaOf(m[2]);
    if (a < 1 && a > 0 && Number(m[1]) > 0) return true;
  }
  for (const m of value.matchAll(/#([0-9a-f]{8}|[0-9a-f]{4})(?![0-9a-f])/gi)) {
    const [r, g, b, a] = hex(m[1].toLowerCase());
    if (a < 1 && a > 0 && !isGrey(r, g, b)) return true;
  }
  return false;
}

/** A literal colour inside a mix that carries a hue. */
function isColouredLiteral(part: string): boolean {
  const p = part.trim().replace(/\s+[\d.]+%$/, "").trim().toLowerCase();
  if (!p) return false;
  if (p === "currentcolor") return true;
  const h = p.match(/^#([0-9a-f]{3,8})$/);
  if (h) {
    const [r, g, b] = hex(h[1]);
    return !isGrey(r, g, b);
  }
  const rgb = p.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (rgb) return !isGrey(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
  const hsl = p.match(/^hsla?\(\s*[\d.]+(?:deg)?[\s,]+([\d.]+)%/);
  if (hsl) return Number(hsl[1]) > 0;
  if (/^[a-z]+$/.test(p)) return !NEUTRAL_WORDS.has(p);
  return false;
}

/** Split on top-level commas (not inside `var(…)` or `rgb(…)`). */
function args(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** `color-mix(in srgb, <coloured ink> N%, transparent | <neutral>)`. */
function isColouredMix(value: string): boolean {
  for (const m of value.matchAll(/color-mix\(([^()]*(?:\([^()]*(?:\([^()]*\)[^()]*)*\)[^()]*)*)\)/g)) {
    for (const part of args(m[1]).slice(1)) {
      const v = part.match(/var\((--[\w-]+)/)?.[1];
      if (v ? !NEUTRAL_VARS.has(v) : isColouredLiteral(part)) return true;
    }
  }
  return false;
}

// Every custom property, in any theme or set inline, whose value is a tint
// (the inline ones are read below, once inlineValue is defined).
const files = walk(SRC);
const cssFiles = files.filter((f) => f.endsWith(".css"));
const tsFiles = files.filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
const cssText = new Map(cssFiles.map((abs) => [abs, stripComments(readFileSync(abs, "utf8"))]));
const tsText = new Map(tsFiles.map((abs) => [abs, readFileSync(abs, "utf8")]));
const defs = new Map<string, string[]>();
const define = (name: string, value: string) => defs.set(name, [...(defs.get(name) ?? []), value]);
for (const text of cssText.values()) {
  for (const d of text.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) define(d[1], d[2]);
}
/** A value that washes a surface (or draws a border) in a colour. */
function isTint(value: string): boolean {
  if ([...value.matchAll(/var\((--[\w-]+)/g)].some((r) => tintVars.has(r[1]))) return true;
  return isColouredAlpha(value) || isColouredMix(value);
}

/** An inline style property's whole expression: up to the `,` or `}` that
 *  closes it at its own depth, so `a ? "x" : \`y\`` is read in full. */
function inlineValue(text: string, from: number): string {
  let depth = 0;
  let quote = "";
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      if (depth === 0) return text.slice(from, i);
      depth--;
    } else if ((ch === "," || ch === ";" || ch === "\n") && depth === 0) return text.slice(from, i);
  }
  return text.slice(from);
}

// Custom properties set inline (`style={{ "--x": "rgba(…)" }}`) are tints too.
for (const text of tsText.values()) {
  for (const d of text.matchAll(/["'](--[\w-]+)["']\s*:\s*/g)) define(d[1], inlineValue(text, d.index! + d[0].length));
}
const tintVars = new Set(SEED_TINTS);
for (let grew = true; grew; ) {
  grew = false;
  for (const [name, values] of defs) {
    if (tintVars.has(name)) continue;
    const tint = values.some(
      (v) =>
        isColouredAlpha(v) ||
        isColouredMix(v) ||
        [...v.matchAll(/var\((--[\w-]+)/g)].some((r) => tintVars.has(r[1])),
    );
    if (tint) {
      tintVars.add(name);
      grew = true;
    }
  }
}

type Hit = { file: string; line: number; selector: string; decl: string };
const hits: Hit[] = [];
const borderHits: Hit[] = [];
const BORDER_PROP = /^(border(-(top|right|bottom|left|inline|block)(-(start|end))?)?(-color)?|outline(-color)?)$/;

for (const [abs, text] of cssText) {
  const file = relative(SRC, abs);
  for (const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = norm(rule[1]);
    if (selector.startsWith("@")) continue;
    const bodyAt = rule.index! + rule[1].length + 1;
    for (const d of rule[2].matchAll(/(?<![\w-])([a-z-]+)\s*:\s*([^;]+)/g)) {
      const prop = d[1];
      if (!isTint(d[2])) continue;
      const at = { file, line: lineOf(text, bodyAt + d.index!), selector, decl: norm(`${prop}: ${d[2]}`) };
      if (/^background(-color|-image)?$/.test(prop)) hits.push(at);
      if (BORDER_PROP.test(prop)) borderHits.push(at);
    }
  }
}

for (const [abs, text] of tsText) {
  const file = relative(SRC, abs);
  for (const m of text.matchAll(/\b(background(?:Color|Image)?)\s*:\s*/g)) {
    const value = inlineValue(text, m.index! + m[0].length);
    if (isTint(value)) hits.push({ file, line: lineOf(text, m.index!), selector: "", decl: norm(`${m[1]}: ${value}`) });
  }
}

const key = (e: { file: string; selector: string; decl: string }) => `${e.file} ${norm(e.selector)} { ${norm(e.decl)} }`;
const keys = (list: Entry[]) => new Set(list.map(key));
const allowed = keys(ALLOWED);
const baselined = keys(BASELINE);
const bordered = new Set([...keys(BORDERS), ...keys(ALLOWED_BORDERS)]);
if (process.env.NO_TINTS_DUMP) {
  for (const h of hits) console.log(`bg\t${h.file}\t${h.selector}\t${h.decl}`);
  for (const h of borderHits) console.log(`border\t${h.file}\t${h.selector}\t${h.decl}`);
}
assert.deepEqual(
  hits.filter((h) => !allowed.has(key(h)) && !baselined.has(key(h))).map((h) => `${h.file}:${h.line} ${h.selector} { ${h.decl} }`),
  [],
  "no tinted box, banner, row or chip: keep the surface neutral, put the colour on a dot or an icon and say the rest in words (P32)",
);
assert.deepEqual(
  borderHits.filter((h) => !bordered.has(key(h))).map((h) => `${h.file}:${h.line} ${h.selector} { ${h.decl} }`),
  [],
  "no coloured outline on a box or a chip: keep the hairline border and put the colour on a dot (P32)",
);

// The lists stay honest: every entry still names a declaration that is
// drawn, says why, and appears once — the ratchet.
for (const [name, list, found] of [
  ["ALLOWED", ALLOWED, hits],
  ["BASELINE", BASELINE, hits],
  ["BORDERS", BORDERS, borderHits],
  ["ALLOWED_BORDERS", ALLOWED_BORDERS, borderHits],
] as const) {
  const seen = new Set<string>();
  const there = new Set(found.map(key));
  for (const a of list) {
    const k = key(a);
    assert.ok(!seen.has(k), `${k}: listed twice in ${name}`);
    seen.add(k);
    assert.ok(a.reason.length > 10, `${k}: ${name} says why`);
    assert.ok(there.has(k), `${k}: in ${name} but no longer drawn — drop it from ${name}`);
  }
}
for (const a of ALLOWED) assert.ok(!baselined.has(key(a)), `${key(a)}: in both lists`);

// VC-9 (a regression of 1.171 item 8): a chip inside a Board card stretched
// to the card's width because `.board-card-open` is a column with the
// default stretch. Fixed by 1.174.0 A7 (mockups board.html §4 and §7/7b):
// `align-self: flex-start` on `.board-card-open > .cchip` (board.css). Either
// fix counts: the chip keeps its own width inside the card
// (`.board-card-open … .cchip` / `.ux-duplicate` with `align-self:
// flex-start`), or the card stops stretching its children
// (`.board-card-open` with `align-items: flex-start`).
function vc9Fixed(texts: string[]): boolean {
  return texts.some((text) =>
    [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].some((r) =>
      r[1].split(/,(?![^(]*\))/).some((raw) => {
        const sel = norm(raw);
        const chip = /\.board-card-open\b.*\s\.(cchip|ux-duplicate)\b/.test(sel) && /align-self\s*:\s*flex-start/.test(r[2]);
        const card = /\.board-card-open$/.test(sel) && /align-items\s*:\s*flex-start/.test(r[2]);
        return chip || card;
      }),
    ),
  );
}
assert.ok(
  vc9Fixed([...cssText.values()]),
  "VC-9: a chip in a Board card keeps its own width (`.board-card-open > .cchip { align-self: flex-start }`), not the card's",
);

// The checker itself catches what it is for.
assert.ok(isColouredAlpha("rgba(245, 158, 11, 0.10)"));
assert.ok(isColouredAlpha("rgb(245 158 11 / 10%)"));
assert.ok(!isColouredAlpha("rgba(255, 255, 255, 0.18)"));
assert.ok(!isColouredAlpha("rgba(0, 0, 0, 0.05)"));
assert.ok(!isColouredAlpha("rgba(28, 28, 30, 0.66)"), "the muted ink is a grey");
assert.ok(!isColouredAlpha("rgba(245, 158, 11, 1)"));
assert.ok(isColouredAlpha("#f59e0b1a"));
assert.ok(!isColouredAlpha("#0000001a"));
assert.ok(isColouredAlpha("#f908"), "a 4-digit hex with alpha");
assert.ok(!isColouredAlpha("#0008"));
assert.ok(isColouredAlpha("hsl(40 90% 50% / 10%)"));
assert.ok(isColouredAlpha("hsla(40, 90%, 50%, 0.1)"));
assert.ok(!isColouredAlpha("hsla(0, 0%, 50%, 0.1)"), "no saturation is a grey");
assert.ok(isColouredMix("color-mix(in srgb, var(--warn) 12%, transparent)"));
assert.ok(isColouredMix("color-mix(in srgb, var(--claude-accent) 10%, var(--raised))"));
assert.ok(isColouredMix("color-mix(in srgb, #f59e0b 10%, transparent)"), "a literal colour");
assert.ok(isColouredMix("color-mix(in srgb, currentColor 12%, transparent)"), "currentColor");
assert.ok(isColouredMix("color-mix(in srgb, orange 12%, transparent)"));
assert.ok(isColouredMix("color-mix(in srgb, rgb(245 158 11) 12%, transparent)"));
assert.ok(!isColouredMix("color-mix(in srgb, var(--fg) 8%, transparent)"));
assert.ok(!isColouredMix("color-mix(in srgb, black 8%, transparent)"));
assert.ok(isTint("var(--signal-aborted-bg)"));
assert.ok(isTint("var(--danger-wash)"));
assert.ok(tintVars.has("--signal-aborted-border"), "a token defined as a coloured mix is a tint token");
assert.ok(!tintVars.has("--diff-line-bg"), "the comparison's ink wash is neutral");
assert.ok(!tintVars.has("--signal-empty-bg"), "the empty state's grey wash is neutral");
assert.ok(!isTint("var(--raised)"));
assert.ok(!isTint("var(--selected)"));
assert.ok(!isTint("var(--claude-accent)"), "a filled control is not a tint (onePrimary guards those)");
assert.equal(inlineValue(`a ? "var(--danger-wash)" : "none", color: x`, 0), `a ? "var(--danger-wash)" : "none"`);
assert.equal(inlineValue("`${x}`}", 0), "`${x}`");
assert.ok(isTint(inlineValue(`ok ? "var(--raised)" : \`var(--signal-done-bg)\` }`, 0)), "an inline ternary is read whole");
assert.ok(vc9Fixed([".board-card-open .cchip { align-self: flex-start; }"]));
assert.ok(vc9Fixed([".board-card .board-card-open > .ux-duplicate { align-self: flex-start; }"]));
assert.ok(vc9Fixed([".x, .board-card-open { display: flex; align-items: flex-start; }"]));
assert.ok(!vc9Fixed([".board-card-open .cchip { font-weight: 500; }", ".board-card-open { align-items: stretch; }"]));
{
  // An inline custom property is a definition: its value is read whole.
  const src = `const s = { "--x-wash": "rgba(245, 158, 11, 0.1)", color: "red" };`;
  const d = /["'](--[\w-]+)["']\s*:\s*/.exec(src)!;
  const v = inlineValue(src, d.index + d[0].length);
  assert.equal(v, `"rgba(245, 158, 11, 0.1)"`);
  assert.ok(isColouredAlpha(v), "an inline custom property's tint is found");
}
assert.ok(BORDER_PROP.test("border-color") && BORDER_PROP.test("border") && BORDER_PROP.test("outline"));
assert.ok(!BORDER_PROP.test("border-radius"));
assert.ok(!BORDER_PROP.test("border-width"));

console.log(
  `noTints: ${hits.length} tinted background(s) — ${ALLOWED.length} allowed, ${BASELINE.length} baselined; ` +
    `${borderHits.length} coloured border(s) — ${ALLOWED_BORDERS.length} allowed, ${BORDERS.length} baselined; VC-9 stays fixed; none new — ok`,
);
