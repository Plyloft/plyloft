// X2 (1.174.0, VC-12): one stacking scale, and the CSS nothing draws.
// Run with Node 22+:  node --experimental-strip-types src/lib/zScale.test.ts
//
// Fails on:
//   - a `z-index` in any src/**/*.css that is not `var(--z-<name>)` with a
//     name the scale in App.css defines (baseline 0: no literal is left);
//   - an inline z-index in a .ts/.tsx file that isn't a `var(--z-<name>)`
//     string: a number, a quoted number, a variable or a template literal
//     (`zIndex: 5`, `zIndex: "5"`, `zIndex: z`, `z-index: ${z}`,
//     `style.zIndex = …`, `setProperty("z-index", …)`);
//   - a scale out of order, or the owner's toast rule broken (2026-10-31:
//     toasts sit above the content; 1.176.1: a toast raised while a sheet
//     is open sits above every layer but the command palette — a new
//     overlay below `--z-toast-sheet` is fine, one above it fails).
// Lists (never fails on) App.css rules whose every selector names a class
// nothing in src/ uses — candidates for deletion, to confirm by hand.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(SRC, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(SRC);
const cssFiles = files.filter((p) => p.endsWith(".css"));
const appCss = readFileSync(join(SRC, "App.css"), "utf8");
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

// ── The scale ─────────────────────────────────────────────────────────
export function scaleOf(css: string): [string, number][] {
  return [...stripComments(css).matchAll(/(--z-[a-z-]+):\s*(\d+)\s*;/g)].map((m) => [m[1], Number(m[2])]);
}
const scale = scaleOf(appCss);
const z = new Map(scale);
assert.ok(scale.length >= 10, "App.css defines the --z-* scale");
assert.equal(z.size, scale.length, "each --z-* name is defined once");
for (let i = 1; i < scale.length; i++) {
  assert.ok(scale[i][1] > scale[i - 1][1], `${scale[i][0]} sits above ${scale[i - 1][0]} (the scale is listed lowest first)`);
}
const at = (name: string) => {
  const v = z.get(name);
  assert.ok(v !== undefined, `${name} is on the scale`);
  return v as number;
};
// The rule: above the content and its menus, under Settings; over Setup's
// page; with a sheet open (1.176.1), above every sheet.
assert.ok(at("--z-toast") > at("--z-popover") && at("--z-toast") > at("--z-float-top"), "a toast sits above the content");
assert.ok(at("--z-toast") < at("--z-scrim") && at("--z-toast") < at("--z-modal"), "a plain toast stays under Settings");
assert.ok(at("--z-toast-setup") > at("--z-setup"), "over Setup, a toast sits above the page");
// 1.176.1: a toast raised while a sheet is open is above every sheet and
// every other overlay; only the command palette is above it. A future
// overlay on the scale that sits above it fails here.
for (const [name, value] of scale) {
  if (name === "--z-toast-sheet" || name === "--z-palette") continue;
  assert.ok(value < at("--z-toast-sheet"), `${name} sits under --z-toast-sheet (a toast raised from a sheet must be seen)`);
}
assert.ok(at("--z-palette") > at("--z-toast-sheet"), "only the command palette is above a sheet's toast");
assert.match(stripComments(appCss), /\.toast-stack--sheet\s*\{[^}]*z-index:\s*var\(--z-toast-sheet\)/, "over a sheet the stack takes --z-toast-sheet");
assert.match(stripComments(appCss), /\.toast-stack\s*\{[^}]*z-index:\s*var\(--z-toast\)/, "the toast stack takes --z-toast");
// Raised from inside Settings: above Settings, under its sheets.
assert.ok(at("--z-toast-modal") > at("--z-modal"), "Settings' own toast sits above Settings");
// ToastStack's layers (`toastLayer`): the overrides take their names.
assert.match(stripComments(appCss), /\.toast-stack--setup\s*\{[^}]*z-index:\s*var\(--z-toast-setup\)/, "over Setup the stack takes --z-toast-setup");
assert.match(stripComments(appCss), /\.toast-stack--modal\s*\{[^}]*z-index:\s*var\(--z-toast-modal\)/, "Settings' toast takes --z-toast-modal");
const usesOf = (name: string) =>
  cssFiles.reduce((n, p) => n + (stripComments(readFileSync(p, "utf8")).match(new RegExp(`var\\(${name}\\)`, "g"))?.length ?? 0), 0);
assert.equal(usesOf("--z-toast-modal"), 1, "--z-toast-modal is used only by Settings' toast");
assert.equal(usesOf("--z-toast-setup"), 1, "--z-toast-setup is used only by the toast over Setup");
assert.equal(usesOf("--z-toast-sheet"), 1, "--z-toast-sheet is used only by the toast over a sheet");
// The layer is React's choice, never a document-wide :has() on the stack.
assert.doesNotMatch(stripComments(appCss), /:has\([^)]*\)[^{]*\.toast-stack/, "no :has() rule picks the toast's layer");

// ── Every z-index is a name on the scale ─────────────────────────────
export function zProblems(file: string, css: string, names: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const lines = stripComments(css).split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/z-index\s*:\s*([^;}]+)/g)) {
      const value = m[1].trim();
      const named = /^var\((--z-[a-z-]+)\)$/.exec(value);
      if (!named) out.push(`${file}:${i + 1} z-index: ${value} — use a --z-* name (App.css)`);
      else if (!names.has(named[1])) out.push(`${file}:${i + 1} ${named[1]} isn't on the scale`);
    }
  });
  return out;
}
const names = new Set(z.keys());
const problems = cssFiles.flatMap((p) => zProblems(relative(SRC, p), readFileSync(p, "utf8"), names));
/** The inline z-index values in a .ts/.tsx text that aren't a --z-* name. */
export function inlineZProblems(file: string, text: string): string[] {
  const out: string[] = [];
  const named = (v: string) => /^["'`]var\(--z-[a-z-]+\)["'`]$/.test(v.trim());
  text.split("\n").forEach((line, i) => {
    const at = `${file}:${i + 1}`;
    for (const m of line.matchAll(/\bzIndex\s*(?::|=(?!=))\s*([^,;}\n]+)/g)) {
      if (!named(m[1])) out.push(`${at} zIndex ${m[1].trim()} — use "var(--z-…)"`);
    }
    for (const m of line.matchAll(/setProperty\(\s*["'`]z-index["'`]\s*,\s*([^)]+)\)/g)) {
      if (!named(m[1])) out.push(`${at} z-index ${m[1].trim()} — use "var(--z-…)"`);
    }
    // In a string or template literal (inline CSS text).
    for (const m of line.matchAll(/z-index\s*:\s*([^;"'`}\n]+)/g)) {
      if (!/^var\(--z-[a-z-]+\)$/.test(m[1].trim())) out.push(`${at} z-index: ${m[1].trim()} — use a --z-* name`);
    }
  });
  return out;
}
for (const p of files.filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))) {
  problems.push(...inlineZProblems(relative(SRC, p), readFileSync(p, "utf8")));
}
assert.deepEqual(problems, [], `literal z-index values:\n${problems.join("\n")}`);

// Self-tests of the reader.
assert.deepEqual(zProblems("a.css", ".x { z-index: 5; }", names), ["a.css:1 z-index: 5 — use a --z-* name (App.css)"]);
assert.deepEqual(zProblems("a.css", ".x { z-index: var(--z-nope); }", names), ["a.css:1 --z-nope isn't on the scale"]);
assert.deepEqual(zProblems("a.css", "/* z-index: 9 */ .x { z-index: var(--z-toast); }", names), []);
assert.equal(inlineZProblems("a.tsx", "style={{ zIndex: 5 }}").length, 1);
assert.equal(inlineZProblems("a.tsx", 'style={{ zIndex: "5" }}').length, 1);
assert.equal(inlineZProblems("a.tsx", "style={{ zIndex: layer }}").length, 1);
assert.equal(inlineZProblems("a.tsx", "el.style.zIndex = String(n);").length, 1);
assert.equal(inlineZProblems("a.tsx", 'el.style.setProperty("z-index", z);').length, 1);
assert.equal(inlineZProblems("a.tsx", "const css = `.x { z-index: ${z}; }`;").length, 1);
assert.equal(inlineZProblems("a.tsx", "const css = `.x { z-index: 7; }`;").length, 1);
assert.deepEqual(inlineZProblems("a.tsx", 'style={{ zIndex: "var(--z-menu)" }}'), []);
assert.deepEqual(inlineZProblems("a.tsx", "const css = `.x { z-index: var(--z-menu); }`;"), []);
assert.deepEqual(inlineZProblems("a.tsx", "if (a.zIndex === b) {}"), []);

// ── Dead-rule candidates in App.css (listed, never a failure) ────────
const used = files
  .filter((p) => /\.(tsx?|jsx?|mjs|html)$/.test(p) && !/\.test\.tsx?$/.test(p))
  .map((p) => readFileSync(p, "utf8"))
  .concat([readFileSync(join(ROOT, "index.html"), "utf8")])
  .join("\n");
const words = new Set(used.match(/[A-Za-z_][\w-]*/g) ?? []);
const prefixes = [
  ...[...used.matchAll(/([A-Za-z][\w-]*-)\$\{/g)].map((m) => m[1]),
  ...[...used.matchAll(/["'`]([A-Za-z][\w-]*-)["'`]\s*\+/g)].map((m) => m[1]),
].filter((p) => p.length >= 4);
const LIBRARY = /^(lucide|cm-|xterm|hljs|tok-)/;
const classUsed = (c: string) => LIBRARY.test(c) || words.has(c) || prefixes.some((p) => c.startsWith(p));

export function deadRules(css: string, isUsed: (c: string) => boolean): { line: number; selector: string }[] {
  const masked = stripComments(css);
  const stack: { sel: string; at: number }[] = [];
  const out: { line: number; selector: string }[] = [];
  let selStart = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "{") {
      stack.push({ sel: masked.slice(selStart, i).trim(), at: i });
      selStart = i + 1;
    } else if (ch === "}") {
      const top = stack.pop();
      selStart = i + 1;
      if (!top || top.sel.startsWith("@") || /^(from|to|\d+%)/.test(top.sel)) continue;
      const selectors = top.sel.split(/,(?![^(]*\))/).map((s) => s.trim());
      const dead = selectors.every((s) =>
        [...s.replace(/:not\([^)]*\)/g, "").matchAll(/\.([A-Za-z_][\w-]*)/g)].some((m) => !isUsed(m[1])),
      );
      if (dead) out.push({ line: masked.slice(0, top.at).split("\n").length, selector: top.sel.replace(/\s+/g, " ") });
    } else if (ch === ";") {
      selStart = i + 1;
    }
  }
  return out;
}
assert.deepEqual(
  deadRules(".live { a: b; }\n.gone, .gone-too { a: b; }\n*:not(.gone) { a: b; }", (c) => c === "live"),
  [{ line: 2, selector: ".gone, .gone-too" }],
);
const candidates = deadRules(appCss, classUsed);
for (const c of candidates) console.log(`zScale: App.css:${c.line} no class of ${c.selector} is used in src/`);

console.log(`zScale: ok (${scale.length} names, 0 literals; ${candidates.length} dead-rule candidates in App.css)`);
