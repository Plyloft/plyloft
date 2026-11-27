// A0 (owner, 2026-10-31): tidy tables. In a table — a `Group` of `Row`s —
// every action button has the same width and the same right edge, ⋯ has a
// fixed slot, values and buttons are separate columns, one button size per
// table, and the whole table wraps together. The layout lives once in the ux
// layer (`Group` → useTidyTable, ux.css "Tidy tables"); this guard keeps the
// call sites from undoing it.
// Run with Node 22+:  node --experimental-strip-types src/lib/tidyRows.test.ts
//
// In every .tsx under src/ (tests aside) it fails on:
//   - `width`: a width, min-width, max-width or padding set inline (`style`)
//     on a button inside a `<Row>`'s `action` or its children, or set by a
//     stylesheet rule on a class that such a button carries, or by a rule
//     that targets a button inside a row (`.ux-row … .cbtn`);
//   - `size`: buttons of more than one size inside one `<Group>` of a
//     component (`<CBtn>` with and without `size="sm"`; a square icon button
//     with and without `ux-icon-sm`);
//   - `raw`: a raw `<button>`, or a button component that is not the ux
//     layer's, in a `<Row>`'s `action`;
//   - `value`: anything in a `<Row>`'s `action` that is not a button: a value
//     or status component (`RowValue`, `StatusLine`, any component not named
//     …Button/…Btn), an element with no button in it (a held sentence in a
//     `<span>`), or a string a ternary or `&&` puts there — values have their
//     own column;
//   - `many`: more than one button side by side in one `action` (in one
//     wrapper or fragment, or drawn by a `.map`) — a row has one action.
// `action={name}` is followed one level, to a `const name = …` in the same
// file. A container rule that sizes the buttons of an action's wrapper
// (`.x-actions > .cbtn { min-width }`) counts as `width`.
//
// Known limits (static reading, one file at a time):
//   - a `<Row>` drawn by a component of another file is checked where it is
//     written, never against the `<Group>` it ends up in; within one file,
//     a `<Group>`'s `size` check follows the `function Name(…)` components
//     it draws one level (not arrow-function components);
//   - an identifier is followed one level and only to a `const`/`let` in the
//     same file; a prop, a function's result or a variable built in steps is
//     not read;
//   - a class built at run time (`className={…}`) is not cross-checked
//     against the stylesheets.
// …beyond BASELINE: what was there when the guard landed, counted per file
// and kind. The baseline is a ratchet: a count may only go down, and when it
// does the baseline has to follow (the test says so).
//
// It also checks the table layout's own rule (`tableLayout`), and that the
// stylesheet still draws a table as one (the subgrid columns, the fixed ⋯
// slot, the one wrap).
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative as relativeNative, sep } from "node:path";
// Always "/" in a relative path, as on a Mac: the checks below compare it with text and lists written with "/".
const relative = (from: string, to: string): string => relativeNative(from, to).split(sep).join("/");
import { fileURLToPath } from "node:url";
import { tableLayout } from "./uxRow.ts";

const SRC = fileURLToPath(new URL("..", import.meta.url));

type Kind = "width" | "size" | "raw" | "value" | "many";

/** Hits that predate the guard (1.174.0, A0), per file and kind. Each goes
 *  when a card with an approved mockup or before→after row redraws that row
 *  (Block B ships guards only: no visible change to satisfy this one). */
const BASELINE: Record<string, Partial<Record<Kind, number>>> = {
  // value — status words drawn in the action slot in place of the row's
  // button: Repository › "Re-detect" on a read-only definition, Diagnostics ›
  // "Nothing to clear" and a fix's "Ready", Dictation › a model's "Ready",
  // Team › a workspace's "Its path is taken" and its local path. Each belongs
  // in the row's children (the value column) once a card redraws the row.
  // (1.174.0 E3 redrew Copies: one button per row, the rest in its ⋯.)
  // many — more than one button in one action: Repository › one
  // "use" button per shared setup, Setup › the Getting started tour and its
  // Start over, Team checkout › − and +.
  "components/RepositorySettings.tsx": { many: 1 },
  "components/settings/DiagnosticsPage.tsx": { value: 2 },
  "components/settings/DictationPage.tsx": { value: 1 },
  "components/settings/TeamPage.tsx": { value: 2 },
  "components/setup/TeamCheckout.tsx": { many: 1 },
};

/** The ux layer's buttons: they take the table's width and size. */
const UX_BUTTONS = new Set(["CBtn", "CIcon", "MenuButton", "SplitButton", "FilePickButton", "MoreMenu"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

/** A quote that starts a string — not an apostrophe in JSX text (`Don't`). */
function opensQuote(text: string, i: number): boolean {
  const ch = text[i];
  if (ch === '"' || ch === "`") return true;
  return ch === "'" && !/[A-Za-z0-9]/.test(text[i - 1] ?? "");
}

/** The end (index after `>`) of the JSX opening tag starting at `start`
 *  (`<`), skipping braces, strings and template literals; and whether it
 *  closes itself. */
export function openingTag(text: string, start: number): { end: number; selfClosing: boolean } {
  let depth = 0;
  let i = start + 1;
  let quote: string | null = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (opensQuote(text, i)) {
      quote = ch;
    } else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) {
      return { end: i + 1, selfClosing: text[i - 1] === "/" };
    }
    i++;
  }
  return { end: text.length, selfClosing: true };
}

/** The `{…}` expression of attribute `name` in an opening tag's text, or null. */
export function attrExpr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}=\\{`).exec(tag);
  if (!m) return null;
  let depth = 0;
  let quote: string | null = null;
  const from = m.index + m[0].length - 1;
  for (let i = from; i < tag.length; i++) {
    const ch = tag[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (opensQuote(tag, i)) quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return tag.slice(from + 1, i);
  }
  return null;
}

/** A string attribute's value (`size="sm"`), or the expression's text. */
function attrValue(tag: string, name: string): string | null {
  const s = new RegExp(`\\s${name}=(["'])([^"']*)\\1`).exec(tag);
  if (s) return s[2];
  const e = attrExpr(tag, name);
  return e === null ? null : `{${e.trim()}}`;
}

/** Each `<Name …>` element in `text`: its opening tag and, unless it closes
 *  itself, its inner text up to the matching `</Name>`. */
export function elements(text: string, name: string): { at: number; tag: string; inner: string }[] {
  const out: { at: number; tag: string; inner: string }[] = [];
  const open = new RegExp(`<${name}(?=[\\s>/])`, "g");
  for (const m of text.matchAll(open)) {
    const { end, selfClosing } = openingTag(text, m.index!);
    const tag = text.slice(m.index!, end);
    let inner = "";
    if (!selfClosing) {
      const re = new RegExp(`<${name}(?=[\\s>/])|</${name}>`, "g");
      re.lastIndex = end;
      let depth = 1;
      let r: RegExpExecArray | null;
      while ((r = re.exec(text))) {
        if (r[0].startsWith("</")) {
          if (--depth === 0) break;
        } else if (!openingTag(text, r.index).selfClosing) depth++;
      }
      inner = text.slice(end, r ? r.index : text.length);
    }
    out.push({ at: m.index!, tag, inner });
  }
  return out;
}

/** Every button-like element in a piece of JSX: ux buttons, raw buttons and
 *  any component named …Button / …Btn. */
function buttons(jsx: string): { name: string; tag: string; offset: number }[] {
  const out: { name: string; tag: string; offset: number }[] = [];
  for (const m of jsx.matchAll(/<(button|[A-Z][\w.]*)(?=[\s>/])/g)) {
    const name = m[1];
    if (!(name === "button" || UX_BUTTONS.has(name) || /(Button|Btn)$/.test(name))) continue;
    const { end } = openingTag(jsx, m.index!);
    out.push({ name, tag: jsx.slice(m.index!, end), offset: m.index! });
  }
  return out;
}

const isButtonName = (name: string) => name === "button" || UX_BUTTONS.has(name) || /(Button|Btn)$/.test(name);

type Node = { name: string; start: number; end: number; tag: string; inner: string; innerAt: number };

/** The JSX elements of `jsx` that are not inside another one (a fragment's
 *  name is ""), each with its whole extent. */
export function topElements(jsx: string): Node[] {
  const out: Node[] = [];
  const open = /<([A-Za-z][\w.]*)?(?=[\s>/])/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(jsx))) {
    const name = m[1] ?? "";
    // `a < b` in an expression is not a tag.
    if (name === "" && jsx[m.index + 1] !== ">") continue;
    const { end, selfClosing } = openingTag(jsx, m.index);
    const tag = jsx.slice(m.index, end);
    if (selfClosing) {
      out.push({ name, start: m.index, end, tag, inner: "", innerAt: end });
      open.lastIndex = end;
      continue;
    }
    const pat = name === "" ? /<>|<\/>/g : new RegExp(`<${name.replace(".", "\\.")}(?=[\\s>/])|</${name.replace(".", "\\.")}>`, "g");
    pat.lastIndex = end;
    let depth = 1;
    let r: RegExpExecArray | null;
    while ((r = pat.exec(jsx))) {
      if (r[0].startsWith("</")) {
        if (--depth === 0) break;
      } else if (name === "" || !openingTag(jsx, r.index).selfClosing) depth++;
    }
    const close = r ? r.index : jsx.length;
    const after = r ? r.index + r[0].length : jsx.length;
    out.push({ name, start: m.index, end: after, tag, inner: jsx.slice(end, close), innerAt: end });
    open.lastIndex = after;
  }
  return out;
}

/** What an `action` holds that is not a button, and how many buttons stand
 *  side by side in one wrapper. Offsets are into `jsx`. */
export function readAction(jsx: string): { values: { at: number; what: string }[]; many: { at: number; n: number }[] } {
  const values: { at: number; what: string }[] = [];
  const many: { at: number; n: number }[] = [];
  const visit = (text: string, base: number, inWrapper: boolean) => {
    const nodes = topElements(text);
    let buttonsHere = 0;
    for (const n of nodes) {
      if (isButtonName(n.name)) {
        buttonsHere++;
        continue;
      }
      if (/^[A-Z]/.test(n.name)) {
        values.push({ at: base + n.start, what: `<${n.name}>` });
        continue;
      }
      // A wrapper (an element or a fragment): a container of buttons, or a
      // value when no button is in it.
      if (buttons(n.inner).length === 0) {
        values.push({ at: base + n.start, what: n.name ? `<${n.name}> with no button in it` : "a fragment with no button in it" });
        continue;
      }
      visit(n.inner, base + n.innerAt, true);
    }
    if (inWrapper) {
      // A `.map` draws a button per item; two written ones stand side by side.
      const mapped = /\.map\(/.test(text) && buttons(text).length > 0;
      if (buttonsHere > 1 || mapped) many.push({ at: base, n: mapped ? Infinity : buttonsHere });
    }
    // A string a ternary or `&&` puts in the slot, outside every element.
    let rest = text;
    for (const n of [...nodes].reverse()) rest = rest.slice(0, n.start) + " ".repeat(n.end - n.start) + rest.slice(n.end);
    const lit = inWrapper
      ? /\{\s*(["'`])((?:(?!\1).)+)\1\s*\}|(?:[?:]|&&)\s*(["'`])((?:(?!\3).)+)\3/g
      : /(?:^\s*|[?:]\s*|&&\s*)(["'`])((?:(?!\1).)+)\1/g;
    for (const l of rest.matchAll(lit)) values.push({ at: base + l.index!, what: `"${l[2] ?? l[4]}"` });
    // JSX text directly in a wrapper, beside its buttons.
    if (inWrapper) {
      const words = rest.replace(/\{[^{}]*\}/g, " ").trim();
      if (/[A-Za-z]{2,}/.test(words)) values.push({ at: base, what: `text "${words.slice(0, 40)}"` });
    }
  };
  visit(jsx, 0, false);
  return { values, many };
}

/** `name`'s initialiser in `text` (`const name = …;`), or null. */
export function initialiser(text: string, name: string): { expr: string; at: number } | null {
  const m = new RegExp(`\\b(?:const|let)\\s+${name}\\s*(?::[^=]+)?=\\s*`).exec(text);
  if (!m) return null;
  const from = m.index + m[0].length;
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (opensQuote(text, i)) quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      if (--depth < 0) return { expr: text.slice(from, i), at: from };
    } else if (ch === ";" && depth === 0) return { expr: text.slice(from, i), at: from };
  }
  return null;
}

/** A same-file `function Name(…) { … }` component's body, or null. */
function componentBody(text: string, name: string): string | null {
  const m = new RegExp(`\\bfunction\\s+${name}\\s*(?:<[^>]*>)?\\(`).exec(text);
  if (!m) return null;
  // Past the parameters (which may hold `{ … }` destructuring) to the body.
  let i = m.index + m[0].length;
  let depth = 1;
  while (i < text.length && depth > 0) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    i++;
  }
  const open = text.indexOf("{", i);
  if (open < 0) return null;
  depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}" && --depth === 0) return text.slice(open, j + 1);
  }
  return null;
}

const SIZING = /\b(width|minWidth|maxWidth|inlineSize|minInlineSize|padding\w*)\s*:/;
const CSS_SIZING = /(^|;|\{)\s*(width|min-width|max-width|inline-size|min-inline-size|padding(-[\w-]+)?)\s*:/;

// The stylesheet: every rule's selector and body, for the class cross-check.
type CssRule = { file: string; line: number; selector: string; body: string };
const cssRules: CssRule[] = [];
const files = walk(SRC);
for (const abs of files.filter((f) => f.endsWith(".css"))) {
  const file = relative(SRC, abs);
  const text = readFileSync(abs, "utf8").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  for (const r of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = r[1].replace(/\s+/g, " ").trim();
    if (selector.startsWith("@")) continue;
    cssRules.push({ file, line: lineOf(text, r.index! + r[1].length), selector, body: r[2] });
  }
}

/** Rules that size a button carrying class `cls` (as the selector's last
 *  compound names it). */
function sizingRulesFor(cls: string): CssRule[] {
  const re = new RegExp(`\\.${cls.replace(/[-]/g, "\\-")}(?![\\w-])[^\\s>+~,]*$`);
  return cssRules.filter(
    (r) => r.selector.split(",").some((s) => re.test(s.trim().replace(/::?[\w-]+(\([^)]*\))?$/g, ""))) && CSS_SIZING.test(r.body),
  );
}

/** Classes the ux layer's buttons always carry: the layer sizes them. */
const LAYER_CLASS = /^(cbtn|cicon|is-active$)/;

/** Every element of `jsx` at any depth, outside buttons. */
function topElementsDeep(jsx: string, base = 0): Node[] {
  const out: Node[] = [];
  for (const n of topElements(jsx)) {
    out.push({ ...n, start: base + n.start });
    if (!isButtonName(n.name)) out.push(...topElementsDeep(n.inner, base + n.innerAt));
  }
  return out;
}

/** Rules that size a button inside an element of class `cls`
 *  (`.x-actions > .cbtn { min-width: … }`). */
function containerRulesFor(cls: string, rules: readonly CssRule[] = cssRules): CssRule[] {
  const re = new RegExp(`\\.${cls.replace(/-/g, "\\-")}(?![\\w-])[^,]*[\\s>+~]\\s*(?:[\\w.-]*\\.(?:cbtn|cicon)\\b|button\\b)[^\\s>+~,]*$`);
  return rules.filter((r) => r.selector.split(",").some((s) => re.test(s.trim())) && CSS_SIZING.test(r.body));
}

type Hit = { file: string; line: number; kind: Kind; what: string };

/** Every hit in one .tsx file's text. */
export function scanFile(text: string, file: string): Hit[] {
  const hits: Hit[] = [];

  for (const row of elements(text, "Row")) {
    let action = attrExpr(row.tag, "action");
    let actionBase = action === null ? -1 : row.at + row.tag.indexOf(action);
    // `action={name}`: one level, to its `const` in the same file.
    const ident = action?.trim().match(/^[A-Za-z_$][\w$]*$/)?.[0];
    if (ident) {
      const init = initialiser(text, ident);
      if (init) {
        action = init.expr;
        actionBase = init.at;
      }
    }
    const parts: { jsx: string; base: number; isAction: boolean }[] = [];
    if (action !== null) {
      parts.push({ jsx: action, base: actionBase, isAction: true });
      const read = readAction(action);
      for (const v of read.values) hits.push({ file, line: lineOf(text, actionBase + v.at), kind: "value", what: `${v.what} in a row's action` });
      for (const m of read.many) {
        hits.push({ file, line: lineOf(text, actionBase + m.at), kind: "many", what: `${m.n === Infinity ? "a button per item" : `${m.n} buttons`} in one row's action` });
      }
      // A wrapper's container rule that sizes its buttons.
      for (const w of topElementsDeep(action)) {
        if (!/^[a-z]/.test(w.name)) continue;
        const cls = attrValue(w.tag, "className");
        if (!cls || cls.startsWith("{")) continue;
        for (const c of cls.split(/\s+/).filter(Boolean)) {
          for (const r of containerRulesFor(c)) {
            hits.push({ file, line: lineOf(text, actionBase + w.start), kind: "width", what: `.${c}'s buttons sized by ${r.file}:${r.line} ${r.selector}` });
          }
        }
      }
    }
    if (row.inner) parts.push({ jsx: row.inner, base: row.at + row.tag.length, isAction: false });
    for (const { jsx, base, isAction } of parts) {
      for (const b of buttons(jsx)) {
        const line = lineOf(text, base + b.offset);
        const style = attrExpr(b.tag, "style");
        if (style && SIZING.test(style)) hits.push({ file, line, kind: "width", what: `<${b.name} style={${style.trim()}}>` });
        const cls = attrValue(b.tag, "className");
        if (cls && !cls.startsWith("{")) {
          for (const c of cls.split(/\s+/).filter((c) => c && !LAYER_CLASS.test(c))) {
            for (const r of sizingRulesFor(c)) {
              hits.push({ file, line, kind: "width", what: `<${b.name} className="${c}"> sized by ${r.file}:${r.line} ${r.selector}` });
            }
          }
        }
        if (isAction && !UX_BUTTONS.has(b.name)) {
          hits.push({ file, line, kind: "raw", what: `<${b.name}> in a row's action` });
        }
      }
    }
  }

  for (const group of elements(text, "Group")) {
    const sizes = new Set<string>();
    const squares = new Set<string>();
    // One level into the same-file components the group draws (ToggleRow…).
    let drawn = group.inner;
    for (const name of new Set([...group.inner.matchAll(/<([A-Z]\w*)(?=[\s>/])/g)].map((m) => m[1]))) {
      if (isButtonName(name) || name === "Row") continue;
      const body = componentBody(text, name);
      if (body) drawn += "\n" + body;
    }
    for (const b of buttons(drawn)) {
      if (b.name === "CBtn") sizes.add(attrValue(b.tag, "size") ?? "md");
      if (b.name === "CIcon") squares.add(/ux-icon-sm/.test(b.tag) ? "sm" : "md");
      if (b.name === "MoreMenu") squares.add("md");
    }
    if (sizes.size > 1 || squares.size > 1) {
      hits.push({
        file,
        line: lineOf(text, group.at),
        kind: "size",
        what: `<Group> mixes button sizes: ${[...sizes, ...[...squares].map((s) => `icon ${s}`)].join(", ")}`,
      });
    }
  }
  return hits;
}

const hits: Hit[] = [];
for (const abs of files.filter((f) => f.endsWith(".tsx") && !/\.test\.tsx$/.test(f))) {
  hits.push(...scanFile(readFileSync(abs, "utf8"), relative(SRC, abs)));
}

// A stylesheet rule that sizes a button inside a row, whatever its class.
for (const r of cssRules) {
  if (!/ux-row/.test(r.selector)) continue;
  if (!r.selector.split(",").some((s) => /ux-row[\w-]*\b.*(\.cbtn|\.cicon|\bbutton)\b[^\s>+~]*$/.test(s.trim()))) continue;
  if (!CSS_SIZING.test(r.body)) continue;
  hits.push({ file: r.file, line: r.line, kind: "width", what: `${r.selector} sizes a button in a row` });
}

// ── the ratchet ──────────────────────────────────────────────────────
const counts: Record<string, Partial<Record<Kind, number>>> = {};
for (const h of hits) {
  const c = (counts[h.file] ??= {});
  c[h.kind] = (c[h.kind] ?? 0) + 1;
}
const over: string[] = [];
const under: string[] = [];
for (const [file, byKind] of Object.entries(counts)) {
  for (const [kind, n] of Object.entries(byKind) as [Kind, number][]) {
    const allowed = BASELINE[file]?.[kind] ?? 0;
    if (n > allowed) {
      for (const h of hits.filter((h) => h.file === file && h.kind === kind)) over.push(`${h.file}:${h.line} [${h.kind}] ${h.what}`);
    }
  }
}
for (const [file, byKind] of Object.entries(BASELINE)) {
  for (const [kind, allowed] of Object.entries(byKind) as [Kind, number][]) {
    const n = counts[file]?.[kind] ?? 0;
    if (n < allowed) under.push(`${file} [${kind}]: ${n} now, ${allowed} in the baseline`);
  }
}
if (process.env.TIDY_ROWS_LIST) {
  for (const h of hits) console.log(`${h.file}:${h.line} [${h.kind}] ${h.what}`);
}
assert.deepEqual(
  over,
  [],
  "a table keeps one action column (A0): no width or padding on a row's button, one button size per Group, only the ux layer's buttons in a row's action, values in their own column",
);
assert.deepEqual(under, [], "a baselined hit is gone: lower BASELINE in src/lib/tidyRows.test.ts (the ratchet only goes down)");

// ── the checker catches what it is for ─────────────────────────────
{
  const sample = `<Row kind="item" label="A" action={<CBtn style={{ minWidth: 120 }}>Open</CBtn>} />`;
  const [r] = elements(sample, "Row");
  const a = attrExpr(r.tag, "action")!;
  assert.match(a, /minWidth/);
  assert.equal(buttons(a)[0].name, "CBtn");
  const nested = `<Group><Row kind="item" label="x"><Row kind="item" label="y" /></Row></Group>`;
  assert.equal(elements(nested, "Row").length, 2);
  assert.match(elements(nested, "Row")[0].inner, /label="y"/);
  assert.equal(elements(nested, "Group")[0].inner, `<Row kind="item" label="x"><Row kind="item" label="y" /></Row>`);
  assert.ok(openingTag(`<Row label={a > b ? "x" : "y"}>`, 0).end > 20, "a > inside braces does not end the tag");
  assert.ok(openingTag(`<Row action={<CBtn>Don't</CBtn>} />`, 0).selfClosing, "an apostrophe in JSX text is not a quote");
  // What an action holds besides its button.
  const v = readAction(`busy ? "Saving…" : <CBtn>Save</CBtn>`);
  assert.deepEqual(v.values.map((x) => x.what), ['"Saving…"']);
  assert.deepEqual(readAction(`<span className="a"><CBtn>One</CBtn><CBtn>Two</CBtn><span className="held">Held</span></span>`).many.length, 1);
  assert.deepEqual(
    readAction(`<span className="a"><CBtn>One</CBtn><span className="held">Held</span></span>`).values.map((x) => x.what),
    ["<span> with no button in it"],
  );
  assert.equal(readAction(`ok ? <CBtn>Open</CBtn> : <CBtn>Retry</CBtn>`).many.length, 0, "a ternary's two buttons are one at a time");
  assert.equal(readAction(`<>{xs.map((x) => <CBtn key={x}>{x}</CBtn>)}</>`).many.length, 1);
  assert.deepEqual(readAction(`<RowValue>Ready</RowValue>`).values.map((x) => x.what), ["<RowValue>"]);
  assert.equal(readAction(`<span className="ux-row-action-reveal"><CBtn>Share</CBtn></span>`).values.length, 0);
  assert.equal(readAction(`state === "ready" ? <CBtn>Go</CBtn> : null`).values.length, 0, "a comparison's string is not a value");
  assert.equal(initialiser(`const act = cond ? <CBtn>A</CBtn> : null;\n`, "act")?.expr, "cond ? <CBtn>A</CBtn> : null");
  // The whole scan of a file, on samples.
  const kinds = (src: string) => scanFile(src, "sample.tsx").map((h) => h.kind);
  // (a) a Group's size check follows a same-file function component.
  assert.deepEqual(
    kinds(`function ToggleRow() {
  return <Row kind="toggle" label="t" action={<CBtn size="sm">Small</CBtn>} />;
}
function Page() {
  return (
    <Group label="g">
      <ToggleRow />
      <Row kind="procedure" label="p" action={<CBtn>Normal</CBtn>} />
    </Group>
  );
}`),
    ["size"],
  );
  // (b) action={name} is followed to its const.
  assert.deepEqual(kinds(`const act = <CBtn>A</CBtn>;\nconst x = <Row kind="item" label="a" action={act} />;`), []);
  assert.deepEqual(kinds(`const act = <RowValue>x</RowValue>;\nconst x = <Row kind="item" label="a" action={act} />;`), ["value"]);
  // (c) a container rule that sizes a wrapper's buttons.
  assert.equal(
    containerRulesFor("x-actions", [{ file: "x.css", line: 1, selector: ".x-actions > .cbtn", body: " min-width: 4px; " }]).length,
    1,
  );
  // The class cross-check finds a stylesheet rule that sizes a class.
  assert.ok(sizingRulesFor("cbtn--sm").some((r) => r.file === "App.css"), "the cross-check reads the stylesheets");
  assert.ok(SIZING.test("{ minWidth: 120 }") && !SIZING.test("{ opacity: 0.5 }"));
}

// ── the table's rule ───────────────────────────────────────────────
{
  // Each column is the widest of its cells plus the cell's gap; a column no
  // row fills takes nothing.
  const t = tableLayout(
    [
      { value: 0, action: 80, more: 30 },
      { value: 60, action: 120, more: 0 },
      { value: 0, action: 0, more: 0 },
    ],
    800,
  );
  assert.deepEqual(t, { value: 68, action: 128, more: 38, stacked: false });
  // A row with no action spreads its value across the action column: it
  // widens the value column only by what the action column cannot hold.
  assert.equal(tableLayout([{ value: 0, action: 80, more: 0 }, { value: 60, action: 0, more: 0 }], 800).value, 0);
  assert.equal(tableLayout([{ value: 0, action: 80, more: 0 }, { value: 280, action: 0, more: 0 }], 800).value, 200);
  assert.equal(tableLayout([{ value: 0, action: 120, more: 0 }], 800).value, 0);
  // The whole table stacks once its columns leave < 260 px of label.
  const side = 128 + 38 + 8;
  assert.equal(tableLayout([{ value: 0, action: 120, more: 30 }], 260 + side).stacked, false);
  assert.equal(tableLayout([{ value: 0, action: 120, more: 30 }], 260 + side - 1).stacked, true);
  // One wide row stacks every row: the table wraps together.
  const wide = tableLayout(
    [
      { value: 0, action: 60, more: 0 },
      { value: 400, action: 0, more: 0 },
    ],
    600,
  );
  assert.equal(wide.stacked, true);
  // A table with nothing on its side never stacks.
  assert.equal(tableLayout([{ value: 0, action: 0, more: 0 }], 100).stacked, false);
}

// ── the stylesheet draws a table as one ────────────────────────────
{
  const css = readFileSync(join(SRC, "components/ux/ux.css"), "utf8");
  const rule = (sel: string) => {
    const at = css.indexOf(`${sel} {`);
    assert.ok(at >= 0, `ux.css has ${sel}`);
    return css.slice(at, css.indexOf("}", at));
  };
  assert.match(rule(".ux-table"), /display: grid;/);
  assert.match(rule(".ux-table > .ux-row--cells"), /grid-template-columns: subgrid;/);
  // The cells are the row's own grid items: a fieldset cannot be a subgrid
  // in Chromium (WebView2), so the side, its fieldset and its inner box
  // draw no box in a table.
  assert.match(
    rule(
      ".ux-table > .ux-row--cells > .ux-row-side,\n.ux-table > .ux-row--cells > .ux-row-side > .ux-row-fieldset,\n.ux-table > .ux-row--cells > .ux-row-side > .ux-row-fieldset > .ux-row-side-inner",
    ),
    /display: contents;/,
  );
  assert.match(rule('.ux-table[data-has-more="true"] > .ux-row--cells .ux-row-cell--more'), /min-width: calc\(var\(--ctl-page\)/);
  assert.match(rule(".ux-table > .ux-row--cells .ux-row-cell--action > :not(.cicon),\n.ux-table > .ux-row--cells .ux-row-cell--action > .ux-row-action-reveal > :not(.cicon)"), /flex: 1 1 auto;/);
  assert.match(rule(".ux-table--stacked > .ux-row--cells > .ux-row-main"), /grid-column: 1 \/ -1;/);
  // A row with no action keeps its value flush right, across the action
  // column; the action column takes the measured width of the actions alone.
  assert.match(rule(".ux-table > .ux-row--no-action .ux-row-cell--value"), /grid-column: 2 \/ 4;/);
  assert.match(rule(".ux-table"), /grid-template-columns: minmax\(0, 1fr\) auto var\(--ux-action-w, auto\) auto;/);
  assert.match(css, /@supports not \(grid-template-columns: subgrid\)/);
  // No :has() in the table's columns: Safari 14–15.3 (macOS 11) lacks it.
  assert.doesNotMatch(css, /\.ux-row-cell--value:has\(/);
}

console.log(`tidyRows: ${hits.length} hit(s), all within the baseline — ok`);
