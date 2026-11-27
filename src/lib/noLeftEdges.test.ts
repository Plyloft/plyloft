// E4 (owner, 2026-10-28): no coloured left edges. A row, a notice or a quote
// never carries its state, its selection or its kind on a stripe down its
// left side: colour lives on a dot or an icon, the words say the rest, a
// selection is the neutral selected wash and a quote is an indent.
// Run with Node 22+:  node --experimental-strip-types src/lib/noLeftEdges.test.ts
//
// Fails on, anywhere in src/ (every .css; inline styles in .ts/.tsx):
//   - a `border-left*` / `border-inline-start*` declaration that draws (a
//     width or a colour that is not transparent, none or 0);
//   - a `box-shadow` with an `inset` part offset sideways only — `inset 2px
//     0 0 <colour>`, the stripe drawn without a border;
//   - an inline `borderLeft*` / `borderInlineStart*` style, or an inline
//     inset box-shadow of the same shape.
// …outside the allowlist below, where each line is a hairline divider, a
// connecting line or the editor's caret — not an accent on a row.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative as relativeNative, sep } from "node:path";
// Always "/" in a relative path, as on a Mac: the checks below compare it with text and lists written with "/".
const relative = (from: string, to: string): string => relativeNative(from, to).split(sep).join("/");
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));

type Allowed = {
  file: string;
  selector: string;
  reason: string;
};

const ALLOWED: Allowed[] = [
  {
    file: "App.css",
    selector: ".card-detail-brainstorm-banner-dismiss",
    reason: "a 1 px hairline between the banner's words and its Dismiss button",
  },
  {
    file: "App.css",
    selector: ".code-mode-preview",
    reason: "the pane divider between the editor and its preview",
  },
  {
    file: "components/ux/ux.css",
    selector: ".ux-segment + .ux-segment",
    reason: "the hairline between two segments of one control",
  },
  {
    file: "components/ux/ux.css",
    selector: ".ux-timeline-event:not(:last-child)::before",
    reason: "the timeline's connecting line between two events' dots",
  },
  {
    file: "components/ux/ux.css",
    selector: ":is(.ux-page, .ux-surface, .ux-sheet) .cbtn.ux-split-toggle",
    reason: "the seam between a split button's two halves",
  },
  {
    file: "components/editorTheme.ts",
    selector: ".cm-cursor, .cm-dropCursor",
    reason: "the editor's caret is a 1 px left border in CodeMirror",
  },
];

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

/** A border value that draws nothing: transparent, none, hidden or a zero width. */
function drawsNothing(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (/^(transparent|none|hidden|0|0px|initial|unset|inherit)$/.test(v)) return true;
  return /\btransparent\b/.test(v) && !/var\(|#|rgb|hsl|color-mix/.test(v);
}

/** Split a declaration value on top-level spaces (not inside `var(…)`). */
function words(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value.trim()) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** `border-width` / `border-color` with four values where only the 4th —
 *  the left — draws: `0 0 0 3px`, `transparent transparent transparent
 *  var(--warn)`. A box drawn on every side is not an edge. */
function isLeftOnlyBox(prop: string, value: string): boolean {
  if (prop !== "border-width" && prop !== "border-color") return false;
  const w = words(value);
  if (w.length !== 4) return false;
  return w.slice(0, 3).every(drawsNothing) && !drawsNothing(w[3]);
}

/** A template literal's holes as a non-zero length. */
const withoutHoles = (s: string) => s.replace(/\$\{[^}]*\}/g, "1");

/** An inset shadow part offset sideways only: `inset Npx 0 …`, N ≠ 0. */
function isSideStripe(shadow: string): boolean {
  for (const part of shadow.split(/,(?![^(]*\))/)) {
    const p = part.trim();
    if (!/\binset\b/.test(p)) continue;
    const m = p.replace(/\binset\b/, "").trim().match(/^(-?[\d.]+)(px)?\s+(-?[\d.]+)(px)?/);
    if (!m) continue;
    if (Number(m[1]) !== 0 && Number(m[3]) === 0 && !/\btransparent\b/.test(p)) return true;
  }
  return false;
}

type Hit = { file: string; line: number; selector: string; decl: string };
const hits: Hit[] = [];

const files = walk(SRC);
for (const abs of files.filter((f) => f.endsWith(".css"))) {
  const file = relative(SRC, abs);
  const text = stripComments(readFileSync(abs, "utf8"));
  for (const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = norm(rule[1]);
    if (selector.startsWith("@")) continue;
    const bodyAt = rule.index! + rule[1].length + 1;
    for (const d of rule[2].matchAll(/([\w-]+)\s*:\s*([^;]+)/g)) {
      const prop = d[1].toLowerCase();
      const value = d[2];
      const edge =
        (/^border-(left|inline-start)(-(width|color|style))?$/.test(prop) && !drawsNothing(value)) ||
        (prop === "box-shadow" && isSideStripe(value)) ||
        isLeftOnlyBox(prop, value);
      if (edge) hits.push({ file, line: lineOf(text, bodyAt + d.index!), selector, decl: norm(`${prop}: ${value}`) });
    }
  }
}

for (const abs of files.filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))) {
  const file = relative(SRC, abs);
  const text = readFileSync(abs, "utf8");
  // A CodeMirror theme names its selector as the object's key; elsewhere an
  // inline style has none, so the file alone is the place.
  for (const m of text.matchAll(/\b(borderLeft\w*|borderInlineStart\w*)\s*:\s*([^,}\n]+)/g)) {
    if (drawsNothing(m[2].replace(/["'`]/g, ""))) continue;
    const before = text.slice(0, m.index);
    const key = [...before.matchAll(/"([^"]+)"\s*:\s*\{/g)].pop()?.[1] ?? "";
    hits.push({ file, line: lineOf(text, m.index!), selector: norm(key), decl: norm(m[0]) });
  }
  // Quoted or a template literal (`inset ${w}px 0 0 …`: a hole counts as a
  // non-zero offset — an inline stripe built from a variable is still one).
  for (const m of text.matchAll(/\bboxShadow\s*:\s*(["'`])((?:(?!\1)[\s\S])+)\1/g)) {
    if (isSideStripe(withoutHoles(m[2]))) hits.push({ file, line: lineOf(text, m.index!), selector: "", decl: norm(m[0]) });
  }
}

const allowedHit = (h: Hit) => ALLOWED.find((a) => a.file === h.file && norm(a.selector) === h.selector);
const unexpected = hits.filter((h) => !allowedHit(h));
assert.deepEqual(
  unexpected.map((h) => `${h.file}:${h.line} ${h.selector} { ${h.decl} }`),
  [],
  "no left edge on a row, a notice or a quote: put the colour on a dot or an icon and say the rest in words (E4)",
);

// The allowlist stays honest: every entry still names a line that is
// there, with a reason.
for (const a of ALLOWED) {
  assert.ok(a.reason.length > 10, `${a.selector}: the allowlist says why`);
  assert.ok(
    hits.some((h) => h.file === a.file && h.selector === norm(a.selector)),
    `${a.file} ${a.selector}: allowed but no longer drawn — drop it from the allowlist`,
  );
}

// The checker itself catches what it is for.
assert.ok(isSideStripe("inset 2px 0 0 var(--fg)"));
assert.ok(isSideStripe("inset 0 0 0 1px var(--fg), inset 3px 0 0 var(--warn)"));
assert.ok(!isSideStripe("inset 0 0 0 1px var(--fg)"));
assert.ok(!isSideStripe("0 2px 0 var(--fg)"));
assert.ok(!drawsNothing("3px solid var(--border-strong)"));
assert.ok(drawsNothing("transparent"));
assert.ok(isLeftOnlyBox("border-width", "0 0 0 3px"));
assert.ok(isLeftOnlyBox("border-color", "transparent transparent transparent var(--warn)"));
assert.ok(!isLeftOnlyBox("border-width", "1px 1px 1px 3px"));
assert.ok(!isLeftOnlyBox("border-color", "var(--border) var(--border) var(--border) var(--warn)"));
assert.ok(isSideStripe(withoutHoles("inset ${w}px 0 0 var(--fg)")));
assert.ok(!isSideStripe(withoutHoles("inset 0 0 0 ${w}px var(--fg)")));
assert.ok(!isLeftOnlyBox("border-width", "0 1px"));

// The sidebar row that asks (owner, 2026-10-28): its dot and its words, in
// the asks ink — no edge, and a highlight only for the open session.
const shell = readFileSync(join(SRC, "components/shell.css"), "utf8");
assert.match(shell, /\.shell-session--asks \.shell-session-state \{[^}]*color: var\(--signal-asks-fg\);[^}]*font-weight: 500;/);
assert.doesNotMatch(shell.match(/\.shell-session--asks \{[^}]*\}/)?.[0] ?? "", /box-shadow|outline|border/);
assert.match(shell, /\.shell-session\.is-selected \{[^}]*background: var\(--selected\);/);

console.log(`noLeftEdges: ${hits.length} edge declaration(s), all allowed — ok`);
