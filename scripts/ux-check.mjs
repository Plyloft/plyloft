#!/usr/bin/env node
// UX language check (ADR 0004, docs/ux-language/PATTERNS.md §9); a step of
// scripts/ppvp.sh. Tests: scripts/ux-check.test.mjs.
//
// Fails when
//   - a migrated .tsx (docs/ux-language/migrated.json) uses a className
//     outside the catalogue (ux-*, cbtn*, cicon*, cchip*), a ux- class the
//     layer's CSS does not define, a raw <button>/<input>/<select> instead
//     of the layer's, a colour literal or an inline non-token spacing, or a
//     retired text glyph (⋯ ⌕ ✕ × ▾ ▴ ▸ ◂ ←) instead of an `Icon` (GH #274);
//   - the layer (src/components/ux/) uses such a className, or its CSS holds
//     a colour literal, a spacing (margin, padding, gap) that is not a token,
//     or declares a token of its own (tokens live in src/App.css);
//   - anywhere in src/, a toast's `body` is a raw error — `String(e)`,
//     `rawError(e)`, a helper of its kind (`errorText(e)`, `errMsg(e)`),
//     `String((e as Error)…)` or a template around `String(e)` (GH #297): the words go
//     in the line and the raw text in `details`, behind the toast's Details;
//   - anywhere in src/, a `var(--x)` names a custom property nothing
//     defines (UX-0.4): a fallback hides it, and without one the property
//     is dropped — the accent presets and void were silently ignored;
//   - (VC-6, 1.174.0) a .tsx under src/components (not the layer, not a
//     test) is in none of migrated.json's three lists — "files" (strict),
//     "pending" (a file that does not pass yet, with its count of problems,
//     which may only go down) or "legacy" (the closed list of the files that
//     were there before the ratchet; never added to: the baseline keeps it
//     as `legacyComponents`, which --write-baseline only shrinks, and an
//     entry it doesn't hold fails) — or a pending file's count rose, or a
//     listed file no longer exists;
//   - for the rest of the app, one of the three counts — button families,
//     panel families, colour literals — rose above the committed baseline
//     (docs/ux-language/ux-baseline.json). The counts are always printed;
//   - per file (UX P-D1, docs/plans/UX_P1.md point 6), the developer words
//     in visible copy (`jargon`) or the raw errors shown inline
//     (`rawErrorsInline`) rose above the baseline — a file may gain only
//     what others lost in the same run (a move); a rise in the total fails,
//     and a fall or a move fails until --write-baseline records it. The
//     `ux-allow` markers are counted per file (`uxAllows`) the same way,
//     except that the write may raise them.
//     (B3, 1.174.0) A word new to JARGON (not in the baseline's
//     `jargonWords`) fails until --write-baseline records its hits once;
//   - (B3) per file, by the same ratchet: an error toast in `pushToast(…)`
//     with a title and no body or action (`bareErrorToasts`), and the
//     Reviewer's old name in a TS or Rust string literal — where prompts
//     are built — (`agentWords`).
//
// Usage: node scripts/ux-check.mjs [--root DIR] [--write-baseline] [--list]
//   --write-baseline  record today's counts (to ratchet the baseline down);
//                     jargon and raw errors are never raised: a rise is refused.
//                     It also lowers a pending file's count in migrated.json,
//                     and moves a pending file that now passes to "files".
//   --list            print every jargon and raw-error hit and every
//                     ux-allow marker, by file.

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LAYER_DIR = "src/components/ux";
export const MIGRATED_FILE = "docs/ux-language/migrated.json";
export const BASELINE_FILE = "docs/ux-language/ux-baseline.json";

const CATALOGUE = /^(ux-|cbtn|cicon|cchip)/;
/** GH #274: the text glyphs the shared controls once drew — More, search,
 *  close, carets, back — each now a Lucide icon through `Icon`. */
export const TEXT_GLYPH = /[⋯⌕✕×▾▴▸◂←]/g;
const RAW_ELEMENT = /<(button|input|select)\b/g;
/** The 148 CSS named colours (CSS Color 4 §6.1). */
const NAMED_LIST = [
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond",
  "blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue",
  "cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen",
  "darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred",
  "darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise",
  "darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite",
  "forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow",
  "grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush",
  "lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow",
  "lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue",
  "lightslategray lightslategrey lightsteelblue lightyellow lime limegreen",
  "linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple",
  "mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred",
  "midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive",
  "olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise",
  "palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple",
  "red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell",
  "sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue",
  "tan teal thistle tomato turquoise violet wheat white whitesmoke yellow",
  "yellowgreen",
].join(" ").split(" ").join("|");
// Whole words only: `var(--tan-bg)` names a token, not a colour.
const NAMED_COLOURS = new RegExp(`(?<![\\w-])(${NAMED_LIST})(?![\\w-])`, "gi");
const COLOUR_FN = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi;
const HEX = /(?<![\w&#])#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const STRING = "(\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*'|`[^`]*`)";
/** A React style key or an SVG attribute that carries a colour, with its
 *  string value: every hex and every named colour there is a literal. */
const STYLE_COLOUR = new RegExp(
  "\\b(color|background(?:Color|Image)?|border(?:Top|Right|Bottom|Left|Block|Inline)?(?:Color)?|outline(?:Color)?|fill|stroke|boxShadow|textShadow|caretColor|accentColor|textDecoration(?:Color)?|stopColor|floodColor)\\s*[:=]\\s*\\{?\\s*" +
    STRING,
  "g",
);
/** Camel-case keys, logical sides included (`marginInlineStart`), and
 *  quoted kebab-case keys (`"margin-top"`). */
const INLINE_SPACING = new RegExp(
  "\\b((?:margin|padding)(?:Top|Right|Bottom|Left|Block|Inline)?(?:Start|End)?|gap|rowGap|columnGap|(?:margin|padding)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|row-gap|column-gap)[\"']?\\s*:\\s*(" +
    STRING.slice(1, -1) +
    "|[^,}\\n]+)",
  "g",
);
const SPACING_PROP =
  /^(margin|padding)(-(top|right|bottom|left|block|inline)(-(start|end))?)?$|^(gap|row-gap|column-gap)$/;
/** CSS properties whose named colour words are colours. */
const COLOUR_PROP =
  /^(color|background(-color|-image)?|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?|outline(-color)?|fill|stroke|box-shadow|text-shadow|caret-color|accent-color|text-decoration(-color)?|column-rule(-color)?|stop-color|flood-color)$/;

// ── helpers ────────────────────────────────────────────────────────────

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Blank comments out, keeping offsets (and so line numbers) intact. */
export function stripComments(text, { line = true } = {}) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  let out = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  // `//` comments, but not the `//` of a URL inside a string.
  if (line) out = out.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, pre) => pre + blank(m.slice(pre.length)));
  return out;
}

/** Index just past the string starting at `i` (', " or a template). */
function skipString(text, i) {
  const q = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== q) {
    if (text[j] === "\\") j += 2;
    else if (q === "`" && text[j] === "$" && text[j + 1] === "{") j = skipBalanced(text, j + 1);
    else j++;
  }
  return j + 1;
}

/** Index just past the bracket group opening at `i`, strings respected. */
function skipBalanced(text, i) {
  const open = text[i];
  const close = { "(": ")", "[": "]", "{": "}" }[open];
  let depth = 0;
  let j = i;
  while (j < text.length) {
    const c = text[j];
    if (c === '"' || c === "'" || c === "`") {
      j = skipString(text, j);
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return j + 1;
    j++;
  }
  return j;
}

/** String literals (templates split into parts and `${…}` holes) and the
 *  bare identifiers of a JS expression. */
function scanExpr(expr) {
  const strings = [];
  const idents = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === '"' || c === "'") {
      const end = skipString(expr, i);
      strings.push({ parts: [expr.slice(i + 1, end - 1)], holes: [] });
      i = end;
    } else if (c === "`") {
      const parts = [];
      const holes = [];
      let buf = "";
      let j = i + 1;
      while (j < expr.length && expr[j] !== "`") {
        if (expr[j] === "\\") {
          buf += expr.slice(j, j + 2);
          j += 2;
        } else if (expr[j] === "$" && expr[j + 1] === "{") {
          const end = skipBalanced(expr, j + 1);
          parts.push(buf);
          buf = "";
          holes.push(expr.slice(j + 2, end - 1));
          j = end;
        } else buf += expr[j++];
      }
      parts.push(buf);
      strings.push({ parts, holes });
      i = j + 1;
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < expr.length && /[\w$]/.test(expr[j])) j++;
      const before = expr.slice(0, i).trimEnd();
      const after = expr.slice(j).trimStart();
      const member = before.endsWith(".");
      const key = after.startsWith(":") && /(^|[{,])$/.test(before);
      if (!member && !key) idents.push(expr.slice(i, j));
      i = j;
    } else i++;
  }
  return { strings, idents };
}

/** The expression a local `const|let|var name = …;` binds, or null. */
export function localBinding(code, name) {
  const m = new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\s*(?::[^=]+)?=\\s*`).exec(code);
  if (!m) return null;
  let j = m.index + m[0].length;
  const start = j;
  while (j < code.length && code[j] !== ";") {
    const c = code[j];
    if (c === '"' || c === "'" || c === "`") j = skipString(code, j);
    else if (c === "(" || c === "[" || c === "{") j = skipBalanced(code, j);
    else j++;
  }
  return code.slice(start, j);
}

/** Marks a `${…}` hole inside a template while its text is split in words. */
const HOLE = String.fromCharCode(0);

/** Top-level positions of `e` (outside strings and brackets), for `visit`. */
function eachTop(e, visit) {
  let depth = 0;
  for (let j = 0; j < e.length; j++) {
    const c = e[j];
    if (c === '"' || c === "'" || c === "`") {
      j = skipString(e, j) - 1;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && visit(j) === false) return;
  }
}

/** Split `e` on a top-level operator. */
function splitOn(e, op) {
  const parts = [];
  let start = 0;
  eachTop(e, (j) => {
    if (e.startsWith(op, j) && !(op === "?" && (e[j + 1] === "." || e[j + 1] === "?" || e[j - 1] === "?"))) {
      parts.push(e.slice(start, j));
      start = j + op.length;
    }
  });
  parts.push(e.slice(start));
  return parts;
}

/** `cond ? a : b` → [cond, a, b] at the top level, nested ternaries kept. */
function splitTernary(e) {
  let q = -1;
  let colon = -1;
  let open = 0;
  eachTop(e, (j) => {
    const c = e[j];
    if (c === "?" && e[j + 1] !== "." && e[j + 1] !== "?" && e[j - 1] !== "?") {
      if (q < 0) q = j;
      else open++;
    } else if (c === ":" && q >= 0) {
      if (open === 0) {
        colon = j;
        return false;
      }
      open--;
    }
  });
  return q >= 0 && colon > q ? [e.slice(0, q), e.slice(q + 1, colon), e.slice(colon + 1)] : null;
}

function unwrapParens(e) {
  while (e.startsWith("(") && skipBalanced(e, 0) === e.length) e = e.slice(1, -1).trim();
  return e;
}

/** The words of one string literal or template; holes judged as values.
 *  A word marked `first` began its literal with no space before it, so a
 *  template can glue it to a prefix; `empty` = the literal can give "". */
function literalWords(lit, judge) {
  const words = [];
  let unvalidated = false;
  const { strings } = scanExpr(lit);
  const s = strings[0];
  let body = "";
  s.parts.forEach((p, k) => {
    body += p;
    if (k < s.holes.length) body += HOLE + k + HOLE;
  });
  const pieces = body.split(/(\s+)/);
  let first = true;
  for (const w of pieces) {
    if (/^\s*$/.test(w)) {
      if (w) first = false;
      continue;
    }
    const at = w.indexOf(HOLE);
    if (at < 0) {
      words.push({ word: w, prefix: false, first });
      first = false;
      continue;
    }
    const close = w.indexOf(HOLE, at + 1);
    const k = Number(w.slice(at + 1, close));
    const sub = judge(s.holes[k]);
    // Whatever the hole cannot know makes the whole expression unknowable,
    // a glued hole included (`ux-row--${props.x}` can give any classes).
    if (sub.unvalidated) unvalidated = true;
    if (w.slice(close + 1) !== "") {
      unvalidated = true; // text glued after a hole: not composed here
    } else if (at > 0) {
      // `prefix${…}`: the hole's first word completes the prefix, any later
      // word stands alone, and an empty hole leaves the bare prefix.
      const head = w.slice(0, at);
      let glued = false;
      for (const x of sub.words) {
        if (x.first) {
          words.push({ word: head + x.word, prefix: false, first });
          glued = true;
        } else words.push({ ...x, first: false });
      }
      if (!glued || sub.empty) words.push({ word: head, prefix: false, first });
    } else {
      sub.words.forEach((x, n) => words.push({ ...x, first: first && n === 0 && x.first }));
    }
    first = false;
  }
  return { words, unvalidated, empty: body.trim() === "" };
}

const NOT_A_CLASS = /^(true|false|null|undefined|\d+(\.\d+)?)$/;

/**
 * The class words a className expression can produce, read by value
 * position: the branches of a ternary, every operand of `||` and `??`, the
 * last operand of `&&`, each element of an array (`[…].filter(Boolean)
 * .join(" ")`), each `${…}` of a template, and a local constant's value.
 * A condition is not a value. A value that cannot be known — a prop, a
 * member, a call, an identifier with no local binding — makes the
 * expression unvalidated, even beside literal branches.
 */
export function classWords(expr, resolve = () => null, depth = 0, seen = new Set()) {
  const none = { words: [], unvalidated: false, empty: true };
  const bad = { words: [], unvalidated: true, empty: false };
  if (depth > 8) return bad;
  const judge = (sub) => classWords(sub, resolve, depth + 1, seen);
  const merge = (parts) => {
    const out = { words: [], unvalidated: false, empty: false };
    for (const p of parts) {
      const r = judge(p);
      out.words.push(...r.words);
      if (r.unvalidated) out.unvalidated = true;
      if (r.empty) out.empty = true;
    }
    return out;
  };
  const e = unwrapParens(expr.trim());
  if (!e) return none;

  const ternary = splitTernary(e);
  if (ternary) return merge([ternary[1], ternary[2]]);
  for (const op of ["||", "??"]) {
    const parts = splitOn(e, op);
    if (parts.length > 1) return merge(parts);
  }
  const ands = splitOn(e, "&&");
  if (ands.length > 1) return { ...judge(ands[ands.length - 1]), empty: true };

  if (e[0] === '"' || e[0] === "'" || e[0] === "`") {
    if (skipString(e, 0) === e.length) return literalWords(e, judge);
  }
  // `[…]`, alone or with `.filter(…)`/`.join(…)`: its elements are values.
  if (e[0] === "[") {
    const end = skipBalanced(e, 0);
    const rest = e.slice(end).trim();
    if (rest === "" || /^(\.(filter|join)\([^()]*\)\s*)+$/.test(rest)) {
      // Joined with spaces: only the first element can glue to a prefix.
      const elements = splitTop(e.slice(1, end - 1), ",").map((p) => p.text);
      const out = merge(elements);
      const lead = judge(elements[0] ?? "");
      const leadWords = new Set(lead.words.filter((w) => w.first).map((w) => w.word));
      out.words = out.words.map((w) => ({ ...w, first: w.first && leadWords.has(w.word) }));
      return out;
    }
    return bad;
  }
  if (/^!/.test(e) || NOT_A_CLASS.test(e)) return none; // a boolean or a number
  if (/^[A-Za-z_$][\w$]*$/.test(e)) {
    if (seen.has(e)) return bad;
    const bound = resolve(e);
    if (bound == null) return bad;
    seen.add(e);
    const r = judge(bound);
    seen.delete(e);
    return r;
  }
  // `TABLE[key]` over a local object literal: every value it holds.
  const lookup = /^([A-Za-z_$][\w$]*)\s*\[/.exec(e);
  if (lookup && skipBalanced(e, lookup[0].length - 1) === e.length) {
    const table = resolve(lookup[1]);
    const body = table == null ? "" : table.trim().replace(/\s+as\s+const\s*$/, "").trim();
    if (body.startsWith("{") && skipBalanced(body, 0) === body.length) {
      const values = splitTop(body.slice(1, -1), ",")
        .map((p) => p.text.trim())
        .filter(Boolean)
        .map((p) => {
          const colon = splitOn(p, ":");
          return colon.length === 2 ? colon[1] : null;
        });
      if (values.length && values.every((v) => v != null)) return merge(values);
    }
    return bad;
  }
  // A call, a member (`props.className`), anything else: its classes
  // cannot be known from here.
  return bad;
}

/** The expression after each `className=`: a quoted string or a braced block. */
function classNameValues(text) {
  const out = [];
  const re = /className\s*=\s*/g;
  let m;
  while ((m = re.exec(text))) {
    const i = m.index + m[0].length;
    const c = text[i];
    let value = "";
    if (c === '"' || c === "'") value = text.slice(i, skipString(text, i));
    else if (c === "{") value = text.slice(i + 1, skipBalanced(text, i) - 1);
    out.push({ index: m.index, value });
  }
  return out;
}

/** Class names a CSS file defines (in selectors). */
export function definedClasses(css) {
  const out = new Set();
  const text = stripComments(css, { line: false });
  for (const rule of text.matchAll(/([^{}]+)\{/g)) {
    const selector = rule[1];
    if (/^\s*@/.test(selector)) continue;
    for (const c of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(c[1]);
  }
  return out;
}

/** Split on `sep` (" " = any whitespace) outside brackets and strings,
 *  keeping each piece's offset. */
function splitTop(text, sep) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let j = 0; j < text.length; j++) {
    const c = text[j];
    if (c === '"' || c === "'") j = skipString(text, j) - 1;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && (sep === " " ? /\s/.test(c) : c === sep)) {
      out.push({ text: text.slice(start, j), start });
      start = j + 1;
    }
  }
  out.push({ text: text.slice(start), start });
  return out;
}

/** Every declaration of every block, the last one with or without `;`. */
export function declarations(css) {
  const text = stripComments(css, { line: false });
  const out = [];
  for (const block of text.matchAll(/\{([^{}]*)\}/g)) {
    const bodyStart = block.index + 1;
    for (const piece of splitTop(block[1], ";")) {
      const colon = piece.text.indexOf(":");
      if (colon < 0) continue;
      const prop = piece.text.slice(0, colon).trim();
      const value = piece.text.slice(colon + 1).trim();
      if (!/^-{0,2}[a-zA-Z][\w-]*$/.test(prop) || !value) continue;
      const lead = piece.text.length - piece.text.trimStart().length;
      out.push({ prop, value, line: lineOf(text, bodyStart + piece.start + lead) });
    }
  }
  return out;
}

export function colourLiteralsIn(value, { named = true } = {}) {
  const found = [];
  for (const m of value.matchAll(HEX)) found.push(m[0]);
  for (const m of value.matchAll(COLOUR_FN)) found.push(m[0]);
  if (named) for (const m of value.matchAll(NAMED_COLOURS)) found.push(m[0]);
  return found;
}

/** The paren opening at `open` closes at the very end of `t`. */
function wraps(t, open) {
  return t.endsWith(")") && skipBalanced(t, open) === t.length;
}

function varIsToken(t) {
  if (!t.startsWith("var(") || !wraps(t, 3)) return false;
  const [name, ...rest] = splitTop(t.slice(4, -1), ",").map((p) => p.text);
  if (!/^\s*--[\w-]+\s*$/.test(name)) return false;
  // The fallback is what renders when the token is missing: it must pass too.
  return rest.length === 0 || spacingIsToken(rest.join(","));
}

function calcIsToken(t) {
  if (!t.startsWith("calc(") || !wraps(t, 4)) return false;
  let inner = t.slice(5, -1);
  // Take out each var() (checked); what is left is unitless arithmetic.
  for (let at = inner.indexOf("var("); at >= 0; at = inner.indexOf("var(")) {
    const end = skipBalanced(inner, at + 3);
    if (!varIsToken(inner.slice(at, end))) return false;
    inner = inner.slice(0, at) + " 1 " + inner.slice(end);
  }
  inner = inner.replace(/calc\(/g, "(");
  return /\d/.test(inner) && /^[\d.\s+\-*/()]*$/.test(inner);
}

/** A spacing is a token when each part is `0`, `auto` (or a CSS-wide
 *  keyword), a var() — its fallback checked too — or a calc() of those
 *  with unitless factors. Any length, a percentage included, fails. */
export function spacingIsToken(value) {
  const parts = splitTop(value.trim(), " ")
    .map((p) => p.text)
    .filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every(
    (p) =>
      p === "0" ||
      /^(auto|inherit|initial|unset|revert)$/.test(p) ||
      varIsToken(p) ||
      calcIsToken(p),
  );
}

const readsAsColour = (d) => d.length >= 6 || /[a-fA-F]/.test(d) || /^0+$/.test(d);

/** Colour literals in script: hex that reads as a colour anywhere (so the
 *  "#412" of a pull request is not one), colour functions, and in a
 *  styling context (a style key, an SVG colour attribute) any hex and any
 *  named colour. */
export function scriptColours(text) {
  const code = stripComments(text);
  const found = new Map();
  for (const m of code.matchAll(HEX)) if (readsAsColour(m[1])) found.set(m.index, m[0]);
  for (const m of code.matchAll(COLOUR_FN)) found.set(m.index, m[0]);
  for (const m of code.matchAll(STYLE_COLOUR)) {
    const literal = m[2];
    const start = m.index + m[0].length - literal.length + 1;
    const value = literal.slice(1, -1);
    for (const h of value.matchAll(HEX)) found.set(start + h.index, h[0]);
    for (const n of value.matchAll(NAMED_COLOURS)) found.set(start + n.index, n[0]);
  }
  return [...found]
    .sort((a, b) => a[0] - b[0])
    .map(([index, lit]) => ({ lit, line: lineOf(code, index) }));
}

// ── the strict checks ──────────────────────────────────────────────────

/** Violations in a .tsx held to the language. `raw` = raw form elements
 *  are forbidden (migrated files; the layer itself builds on them). */
export function checkTsx(file, text, catalogue, { raw = true } = {}) {
  const errors = [];
  const code = stripComments(text);
  const resolve = (name) => localBinding(code, name);
  for (const { index, value } of classNameValues(code)) {
    const at = `${file}:${lineOf(code, index)}`;
    const { words, unvalidated } = classWords(value, resolve);
    if (unvalidated) {
      errors.push(
        `${at}: className {${value.trim()}} cannot be validated — build it from catalogue literals or a local constant`,
      );
    }
    for (const { word, prefix } of words) {
      if (!CATALOGUE.test(word)) {
        errors.push(`${at}: className "${word}" is off the catalogue (ux-*, cbtn*, cicon*, cchip*)`);
      } else if (word.startsWith("ux-")) {
        const known = prefix
          ? [...catalogue].some((c) => c.startsWith(word))
          : catalogue.has(word);
        if (!known) errors.push(`${at}: className "${word}" is not defined by the ux layer's CSS`);
      }
    }
  }
  for (const { lit, line } of scriptColours(text)) {
    errors.push(`${file}:${line}: colour literal "${lit}" — use a token`);
  }
  // Inline style spacings: a number other than 0, or a string not all tokens.
  for (const m of code.matchAll(INLINE_SPACING)) {
    const value = m[2].trim();
    const quoted = /^["'`]/.test(value);
    const ok = value === "0" || (quoted && spacingIsToken(value.slice(1, -1)));
    if (!ok) {
      errors.push(`${file}:${lineOf(code, m.index)}: ${m[1]}: ${value} — spacing must be a token (--page-space-*)`);
    }
  }
  for (const m of code.matchAll(TEXT_GLYPH)) {
    errors.push(`${file}:${lineOf(code, m.index)}: text glyph "${m[0]}" — use <Icon name=…> (GH #274)`);
  }
  if (raw) {
    for (const m of code.matchAll(RAW_ELEMENT)) {
      errors.push(
        `${file}:${lineOf(code, m.index)}: raw <${m[1]}> — use the layer's control (CBtn, CIcon, Toggle, Select, TextField, SearchField)`,
      );
    }
  }
  return errors;
}

export function checkLayerCss(file, css) {
  const errors = [];
  for (const { prop, value, line } of declarations(css)) {
    const at = `${file}:${line}`;
    if (prop.startsWith("--")) {
      errors.push(`${at}: declares ${prop} — tokens live in src/App.css`);
      continue;
    }
    for (const lit of colourLiteralsIn(value)) {
      errors.push(`${at}: colour literal "${lit}" in ${prop} — use a token`);
    }
    if (SPACING_PROP.test(prop) && !spacingIsToken(value)) {
      errors.push(`${at}: ${prop}: ${value} — spacing must be a token (--page-space-*)`);
    }
    if (prop === "content") {
      for (const m of value.matchAll(TEXT_GLYPH)) {
        errors.push(`${at}: content "${m[0]}" — a text glyph; draw an <Icon> (GH #274)`);
      }
    }
  }
  return errors;
}

// ── raw-error toasts (GH #297) ─────────────────────────────────────────

/** The names a caught error goes by. */
const CAUGHT = String.raw`(?:e|err|error|cause|reason)`;
const RAW_ERROR_BODY = new RegExp(
  String.raw`\bbody:\s*(?:` +
    [
      // String(e), and String((e as Error)?.message ?? e)
      String.raw`String\(\s*${CAUGHT}\s*\)`,
      String.raw`String\(\s*\(\s*${CAUGHT}\s+as\b`,
      // rawError(e), and a helper of the same kind: errorText(e), errMsg(e),
      // messageOf(e), describeError(e) — the raw text by another name
      String.raw`rawError\(`,
      String.raw`\w*(?:[Ee]rr|[Mm]essage|[Tt]ext)\w*\(\s*${CAUGHT}\s*\)`,
      // a template around String(e)
      String.raw`\x60[^\x60]*\$\{\s*String\(`,
    ].join("|") +
    ")",
  "g",
);

/** A toast whose line would carry the raw error, as "file:line: …". */
export function rawErrorToasts(file, text) {
  const code = stripComments(text);
  return [...code.matchAll(RAW_ERROR_BODY)].map(
    (m) => `${file}:${lineOf(code, m.index)}: a raw error as a toast's body — put it in \`details\` (GH #297)`,
  );
}

// ── a link that didn't open (TX6 round 1, 1.174.0; texts.html E10) ─────

/**
 * TX6 (E10, owner: one form everywhere): every `openWebLink(…)` tells a link
 * that didn't open with `linkDidNotOpen` (src/lib/linkToast.ts). A call is
 * judged by where its failure goes:
 *   - its chain — through any `.then(…)` — ends in `.catch(handler)`: the
 *     handler must call `linkDidNotOpen` (a silent `() => {}` or a handler
 *     passed by name is a hit: it can't be seen to use the form);
 *   - it is awaited with no `.catch` of its own: the `try` around it must
 *     have a `catch` block that calls `linkDidNotOpen`;
 *   - anything else (`void openWebLink(u)`, an await outside any `try`) is
 *     a hit: its failure would be lost or said some other way.
 * Known limits: the `try` judged is the innermost one around the call, and
 * the guard doesn't check that its catch is about the link alone (another
 * await in the same block shares it); a call whose promise is returned or
 * passed on is judged as unhandled. "file:line: …" per hit.
 */
export function linkToastHits(file, text) {
  if (/(^|\/)linkToast\.ts$/.test(file) || /(^|\/)ipc\.ts$/.test(file)) return [];
  const code = stripComments(text);
  const uses = (handler) => /(?<![\w$])linkDidNotOpen\s*\(/.test(handler);
  // Every try block with its catch block's text, for the awaited calls.
  const tries = [];
  for (const t of code.matchAll(/(?<![\w$.])try\s*\{/g)) {
    const open = t.index + t[0].length - 1;
    const end = skipBalanced(code, open);
    const after = /^\s*catch\s*(\([^)]*\))?\s*\{/.exec(code.slice(end));
    const handler = after ? code.slice(end + after[0].length - 1, skipBalanced(code, end + after[0].length - 1)) : "";
    tries.push({ open, end, handler });
  }
  const hits = [];
  const hit = (index) =>
    hits.push(`${file}:${lineOf(code, index)}: a link that didn't open is told with linkDidNotOpen (src/lib/linkToast.ts, TX6 E10)`);
  for (const call of code.matchAll(/(?<![\w$.])openWebLink\s*\(/g)) {
    if (/function\s+$/.test(code.slice(Math.max(0, call.index - 12), call.index))) continue;
    const open = call.index + call[0].length - 1;
    let end = skipBalanced(code, open);
    for (;;) {
      const then = /^\s*\.then\s*\(/.exec(code.slice(end));
      if (!then) break;
      end = skipBalanced(code, end + then[0].length - 1);
    }
    const caught = /^\s*\.catch\s*\(/.exec(code.slice(end));
    if (caught) {
      const catchOpen = end + caught[0].length - 1;
      if (!uses(code.slice(catchOpen, skipBalanced(code, catchOpen)))) hit(call.index);
      continue;
    }
    const awaited = /await\s+$/.test(code.slice(Math.max(0, call.index - 12), call.index));
    const inner = tries
      .filter((t) => t.open < call.index && call.index < t.end)
      .sort((a, b) => b.open - a.open)[0];
    if (awaited && inner && uses(inner.handler)) continue;
    hit(call.index);
  }
  return hits;
}

// ── error toasts with only a title (B3, 1.174.0; UX audit P41, G10) ────

/** The keys of the object literal whose body is `inner`, at its top level,
 *  as Map key → value text; null when a spread makes them unknowable. */
function objectKeys(inner) {
  const keys = new Map();
  for (const piece of splitOn(inner, ",")) {
    const t = piece.trim();
    if (!t) continue;
    if (t.startsWith("...")) return null;
    const kv = /^(["']?)([\w$-]+)\1\s*:(?!:)\s*/.exec(t);
    if (kv) keys.set(kv[2], t.slice(kv[0].length));
    else if (/^[A-Za-z_$][\w$]*$/.test(t)) keys.set(t, t);
  }
  return keys;
}

/**
 * An error toast must say what to do next: a `body`, or an `action` to press
 * (UX audit G10: "Archive failed" and nothing after it). Every object literal
 * inside a `pushToast(…)` call — a ternary's branches included — whose `kind`
 * can be "error", with a `title` and neither `body` nor `action`:
 * [{ line, found }] (found = its title). A toast built elsewhere and passed
 * by name, or one with a spread, is not judged.
 */
export function bareErrorToasts(file, text) {
  const code = stripComments(text);
  const hits = [];
  for (const call of code.matchAll(/(?<![\w$.])pushToast\s*\(/g)) {
    const open = call.index + call[0].length - 1;
    const end = skipBalanced(code, open);
    for (let j = open + 1; j < end - 1; j++) {
      const c = code[j];
      if (c === '"' || c === "'" || c === "`") {
        j = skipString(code, j) - 1;
        continue;
      }
      if (c !== "{") continue;
      const close = skipBalanced(code, j);
      const keys = objectKeys(code.slice(j + 1, close - 1));
      if (keys && /["'`]error["'`]/.test(keys.get("kind") ?? "") && keys.has("title") && !keys.has("body") && !keys.has("action")) {
        const line = lineOf(code, j);
        hits.push({ line, found: keys.get("title").replace(/\s+/g, " ").trim().slice(0, 80) });
      }
    }
  }
  return hits;
}

// ── agent words (B3, 1.174.0; UX audit G3, G19) ────────────────────────

/** The Reviewer's old name, in what Plyloft writes for an agent to read:
 *  a prompt says "You are the Reviewer". Counted in the code of every
 *  non-test line of src/ (TS) and src-tauri (Rust), strings included —
 *  wherever a prompt is built — with the lines that only match text saved
 *  before the rename in the baseline (`agentWords`). In
 *  `AGENT_WORDS_ALLOW_FILE` only (New in this version, read by a person,
 *  never by an agent), a line that ends with a `// ux-allow: <reason>`
 *  marker is not counted: TX7's points that announce the rename name the
 *  old name. The markers are counted themselves (`uxAllows`); a marker in
 *  any other file, a prompt included, never hides the old name. */
export const AGENT_WORDS = /\bChallengers?\b/g;
export const AGENT_WORDS_ALLOW_FILE = "src/lib/releaseHighlights.ts";

/** The string literals of a TS/TSX file (template parts included; JSX text
 *  and regexes not): [{ line, text }]. */
export function tsStrings(file, text) {
  const code = stripComments(text);
  const sc = copyScanner(code, { jsx: file.endsWith(".tsx") });
  return sc.strings().map(([s, e]) => ({ line: lineOf(code, s), text: code.slice(s, e) }));
}

/**
 * The string literals of a Rust file — "…", r#"…"#, b"…" — outside comments
 * and outside test code: the item after a `#[cfg(test)]` (or `cfg(all(test,
 * …))`, never `cfg(not(test))`) is skipped whole, a `mod tests { … }` or a
 * test-only constant alike. [{ line, text }]
 */
export function rustStrings(text) {
  const out = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  let skipItem = false; // a cfg(test) attribute was read: skip the next item
  let skipDepth = -1; // inside a skipped item's braces, from this depth
  let depth = 0;
  const advance = (to) => {
    for (let k = i; k < to && k < n; k++) if (text.charCodeAt(k) === 10) line++;
    i = to;
  };
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      const e = text.indexOf("\n", i);
      advance(e < 0 ? n : e);
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      let d = 0;
      let j = i;
      while (j < n) {
        if (text[j] === "/" && text[j + 1] === "*") (d++, (j += 2));
        else if (text[j] === "*" && text[j + 1] === "/") {
          j += 2;
          if (--d === 0) break;
        } else j++;
      }
      advance(j);
      continue;
    }
    const prevWord = i > 0 && /[\w]/.test(text[i - 1]);
    const raw = !prevWord && /^b?r(#*)"/.exec(text.slice(i, i + 12));
    if (raw || c === '"' || (c === "b" && text[i + 1] === '"' && !prevWord)) {
      const open = raw ? raw[0].length : c === "b" ? 2 : 1;
      const close = raw ? '"' + raw[1] : '"';
      let j = i + open;
      if (raw) j = text.indexOf(close, j);
      else while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (j < 0) j = n;
      const at = line;
      const body = text.slice(i + open, j);
      if (skipDepth < 0 && !skipItem) out.push({ line: at, text: body });
      advance(j + close.length);
      continue;
    }
    if (c === "'") {
      // a char literal ('a', '\n', '\u{1F600}', '"') or a lifetime ('a)
      const m = /^'(?:\\u\{[0-9a-fA-F]+\}|\\.|[^\\'\n])'/.exec(text.slice(i, i + 12));
      advance(i + (m ? m[0].length : 1));
      continue;
    }
    if (c === "#" && text[i + 1] === "[") {
      const m = /^#\[cfg\(([^\]]*)\)\]/.exec(text.slice(i, i + 200));
      if (m && /\btest\b/.test(m[1]) && !/^\s*not\s*\(/.test(m[1]) && skipDepth < 0) skipItem = true;
    }
    if (c === "{") {
      if (skipItem && skipDepth < 0) {
        skipDepth = depth;
        skipItem = false;
      }
      depth++;
    } else if (c === "}") {
      depth--;
      if (skipDepth >= 0 && depth === skipDepth) skipDepth = -1;
    } else if (c === ";" && skipItem && skipDepth < 0) skipItem = false;
    advance(i + 1);
  }
  return out;
}

/** A Rust file that is test code whole: `foo_tests.rs`, pulled in with
 *  `#[cfg(test)] #[path = …] mod tests;`. */
const RUST_TEST_FILE = /(?:^|\/)(?:[\w-]+_tests?|tests)\.rs$/;

/** Per-file hits of `AGENT_WORDS` in string literals: Map file → [{ line, found }]. */
export function agentWordHits(root) {
  const out = new Map();
  const add = (rel, strings, allowed = new Set()) => {
    const hits = [];
    for (const { line, text } of strings) {
      for (const m of text.matchAll(AGENT_WORDS)) {
        const at = Math.max(0, m.index - 40);
        const hitLine = line + (text.slice(0, m.index).match(/\n/g)?.length ?? 0);
        if (allowed.has(hitLine)) continue;
        hits.push({ line: hitLine, found: text.slice(at, m.index + 60).replace(/\s+/g, " ").trim() });
      }
    }
    if (hits.length) out.set(rel, hits);
  };
  for (const abs of walk(join(root, "src"))) {
    const rel = posix(relative(root, abs));
    if (!readsCopy(rel)) continue;
    const text = readFileSync(abs, "utf8");
    const allowed = new Set();
    if (rel === AGENT_WORDS_ALLOW_FILE) {
      text.split("\n").forEach((l, i) => {
        if (ALLOW.test(l)) allowed.add(i + 1);
      });
    }
    add(rel, tsStrings(rel, text), allowed);
  }
  const rustRoots = [join(root, "src-tauri/src")];
  const crates = join(root, "src-tauri/crates");
  if (existsSync(crates)) for (const c of readdirSync(crates)) rustRoots.push(join(crates, c, "src"));
  for (const dir of rustRoots) {
    for (const abs of walk(dir)) {
      const rel = posix(relative(root, abs));
      if (!rel.endsWith(".rs") || RUST_TEST_FILE.test(rel)) continue;
      add(rel, rustStrings(readFileSync(abs, "utf8")));
    }
  }
  return out;
}

// ── undefined tokens (UX-0.4) ──────────────────────────────────────────

/** A custom property defined in CSS (`--x: …` as a declaration), in a React
 *  style object (`"--x": …`) or through `setProperty("--x", …)`. */
const TOKEN_DEF = [
  /(?:^|[\s{;])(--[A-Za-z0-9_-]+)\s*:(?!:)/gm,
  /["'`](--[A-Za-z0-9_-]+)["'`]\s*[:\]]/g,
  /setProperty\(\s*["'`](--[A-Za-z0-9_-]+)/g,
];
/** A reference whose whole name is spelled out: `var(--x)` or `var(--x, …)`.
 *  A name built in a template (`var(--ws-${k})`) is not judged. */
const TOKEN_USE = /var\(\s*(--[A-Za-z0-9_-]+)\s*(?=[,)])/g;

/** `sources`: [{ file, text }]. Every `var()` naming a property no source
 *  defines, as "file:line: …". */
export function undefinedTokens(sources) {
  const defined = new Set();
  for (const { text } of sources) {
    const code = stripComments(text);
    for (const re of TOKEN_DEF) {
      for (const m of code.matchAll(re)) defined.add(m[1]);
    }
  }
  const errors = [];
  for (const { file, text } of sources) {
    const code = stripComments(text);
    for (const m of code.matchAll(TOKEN_USE)) {
      if (defined.has(m[1])) continue;
      errors.push(`${file}:${lineOf(code, m.index)}: var(${m[1]}) — no such token is defined`);
    }
  }
  return errors;
}

// ── jargon and raw errors in visible copy (UX P-D1, UX_P1.md point 6) ───

/** Files, and functions inside files, where the developer words are the
 *  point: Settings › Diagnostics, Settings › Worktrees, the Changes code
 *  view, terminals and the card's Details rows. */
export const TECHNICAL_FILE = "docs/ux-language/technical-surfaces.json";

/** The banned words (owner decision D4, 2026-10-17): whole words,
 *  case-insensitive except the acronyms that are also English words
 *  (PATH, SHA, HEAD). Visible copy may keep pull request, branch, commit. */
export const JARGON = [
  ["worktree", /\bworktrees?\b/gi],
  ["snapshot", /\bsnapshot(?:s|ted|ting)?\b/gi],
  ["origin", /\borigin\b/gi],
  ["stash", /\bstash(?:es|ed|ing)?\b/gi],
  ["rebase", /\brebas(?:e|es|ed|ing)\b/gi],
  ["fast-forward", /\bfast[- ]forward(?:s|ed|ing)?\b/gi],
  ["PATH", /\bPATH\b/g],
  ["CLI", /\bCLIs?\b/gi],
  ["sandbox", /\bsandbox(?:es|ed)?\b/gi],
  ["SHA", /\bSHAs?\b/g],
  ["HEAD", /\bHEAD\b/g],
  ["diff", /\bdiffs?\b/gi],
  ["Build done", /\bBuild done\b/gi],
  // The old name of the first column (P-D2 walk): "in To do", a heading
  // "To do · 2", a label "To do" — never prose ("To do this, …").
  ["To do", /\b(?:in|to|back|from|into) To do\b|\bTo do\b(?![ \t]+[a-z])/g],
  // QoL 1.168 block 8 (A4, 2026-10-22): the words the 1.168 review still
  // found in front of the person.
  ["hunk", /\bhunks?\b/gi],
  ["swarm", /\bswarms?\b/gi],
  ["vendor", /\bvendors?\b/gi],
  ["intake", /\bintake\b/gi],
  ["upstream", /\bupstreams?\b/gi],
  // git's checkout — not a payment page's ("the checkout page")
  ["checkout", /\bcheckouts?\b(?![ \t]+(?:page|link|session)\b)/gi],
  ["Un-ignore", /\bun-?ignor(?:e|es|ed|ing)\b/gi],
  ["plugin", /\bplug-?ins?\b/gi],
  ["manifest", /\bmanifests?\b/gi],
  ["pruned", /\bprun(?:e|es|ed|ing)\b/gi],
  ["cleanupPeriodDays", /\bcleanupPeriodDays\b/g],
  ["OSC 133", /\bOSC\s*\d+\b/g],
  ["exit code", /\bexit(?:ed)?(?: with)?(?: code)? \d+\b|\bexit code\b/gi],
  ["into main", /\binto main\b/gi],
  // a severity as a code: "P1 · 2 findings"
  ["P1", /\bP[0-3]\b/g],
  // The state words (PATTERNS.md §7): "Waiting" alone is never a state, a
  // column or a count — it is only ever waiting for you.
  ["Waiting (state)", /^\s*Waiting\s*$|\b(?:in|to|from|into|under) Waiting\b|\d+ waiting\b|^\s+waiting\s*$/g],
  // G2 (1.173.0, owner decisions 1 and 6): the second AI is the Reviewer;
  // the saved ids keep the old name in lower case (`challenger-reviewing`,
  // role `challenger`), which is never copy. The old improvement proposal
  // is a "Suggested skill change", and Ship batch says the Release verb.
  ["Challenger", /\bChallengers?\b/g],
  ["improvement proposal", /\bimprovement proposals?\b/gi],
  ["Ship batch", /\bShip batch\b|\bShip selected\b|\bship in a batch\b/gi],
  // B3 (1.174.0; UX audit P35, P36, G3, G4, G9, G19, NI-7; owner D11). The
  // Reviewer's other names: "the second AI's review", a second AI doing the
  // review without its name, and "second opinion" — which Next improvement
  // keeps for its own pass (D11, in the glossary), so only its files may
  // say it; NI's own "second pass" is that same pass's other name.
  //
  // B3 round 1: these seven are read in every string with a space in it
  // (`anyString`), not only at copy positions — the copy rules miss a
  // sentence returned by a function whose name doesn't say copy, or a key
  // that isn't a copy key. Agent prompts, `details` and the technical
  // surfaces stay out, as for the rest.
  ["second AI's review", /\bsecond AI['’]s review\b/gi, { anyString: true }],
  ["a second AI reviews", /\b(?:a|the) second AI (?:checks|reviews|reads)\b/gi, { anyString: true }],
  ["second opinion", /\bsecond opinions?\b/gi, { anyString: true, allowIn: (rel) => isNextImprovementFile(rel) || rel === "src/lib/glossary.ts" }],
  // TX5 round 1b: the glossary defines the second opinion as NI's second
  // pass, so it may say both words; nowhere else may.
  ["second pass", /\bsecond pass(?:es)?\b/gi, { anyString: true, allowIn: (rel) => rel === "src/lib/glossary.ts" }],
  // "Verify" as the name of a step ("Verify failed", "the Reviewer and
  // Verify check it"): the person's word is "your checks". The verb, with
  // its object ("Verify the build"), is English.
  ["Verify", /\bVerify\b(?![ \t]+(?:the|that|your|it|its|this|these|those|a|an|you|with|each|every|what|whether|how|which|all)\b)/g, { anyString: true }],
  // "repo": the app says repository. Not a token of a command or an
  // address (`-s repo,read:org`, `owner/repo`).
  // (round 1) nor the `gh repo` command, nor a token scope after `-s`.
  ["repo", /(?<![\w/:.-])(?<!\bgh\s)(?<!-s\s)repos?\b(?![-/:]|,\w)/gi, { anyString: true }],
  ["uncommitted", /\buncommitted\b/gi, { anyString: true }],
  // F9 (1.175.0, UX-17): a git "remote" — the app says GitHub, or where the
  // project is online. Not a command's token (`git remote …`, `remote add`,
  // `--remote`) nor a config key (`remote.origin.url`).
  ["remote", /(?<![\w.-])(?<!\bgit\s)(?<!--)remotes?\b(?![-.:]\w|\s+(?:add|get-url|set-url|show|-v)\b)/gi, { anyString: true }],
  // TX10 (1.174.0, PLAN §4.1): the app's copy is spelled the American way,
  // as the guide that quotes it (the site's check:blog). Saved ids keep
  // their old spelling (the action id `authorise`), which is never copy.
  ["grey", /\bgrey(?:s|ed|ing)?\b/gi, { anyString: true }],
  ["colour", /\bcolours?\b/gi, { anyString: true }],
  ["labelled", /\blabelled\b/gi, { anyString: true }],
  ["organisation", /\borganisations?\b/gi, { anyString: true }],
  ["authorise", /\bauthoris(?:e|es|ed|ing)\b/gi, { anyString: true }],
  // DR6 (1.174.0, P38/SL-12): the release kinds say what happens ("Put the
  // version on GitHub"), and running work is stopped in plain words.
  // DR6 round 1: the Settings index's `synonyms` are search words, never
  // shown — an old name there still finds its row.
  ["Tag and push", /\bTag and push\b/gi, { anyString: true, searchSynonyms: true }],
  ["Force ship", /\bForce ship\b/gi, { anyString: true, searchSynonyms: true }],
];

/** (B3, owner D11) Next improvement's own files: "second opinion" is its
 *  word for its separate pass, and nowhere else's. */
export function isNextImprovementFile(rel) {
  return /^src\/(?:components|lib|store)\/(?:NextImprovement[^/]*|nextImprovement[^/]*|NiDirection[^/]*|niDirection[^/]*)\.tsx?$/.test(rel);
}

/** Props and object keys whose string value the person reads. */
const COPY_KEYS = [
  "label", "title", "hint", "helper", "body", "lede", "text", "detail", "sentence",
  "actionLabel", "actionTitle", "confirmLabel", "placeholder", "aria-label", "why",
  "happened", "untouched", "todo", "summary",
  // (Challenger) more of the same: a footnote, a description, an eyebrow
  "footnote", "description", "eyebrow",
];
/** (Challenger) A camelCase key or prop that ends like a copy name
 *  (`cancelLabel`, `menuLabel`, `absentNote`, `emptyTitle`). */
const COPY_KEY_SUFFIX = String.raw`[a-z][A-Za-z0-9]*(?:Label|Title|Hint|Note|Lede|Helper|Footnote)`;
const COPY_KEY_SET = new Set(COPY_KEYS);
const COPY_KEY_NAME = new RegExp(`^${COPY_KEY_SUFFIX}$`);
const isCopyKey = (k) => COPY_KEY_SET.has(k) || COPY_KEY_NAME.test(k);
const COPY_KEY = new RegExp(
  String.raw`(?<=[{,]\s*)(["']?)(${COPY_KEYS.join("|")}|${COPY_KEY_SUFFIX})\1\s*:(?!:)\s*`,
  "g",
);
/** Constants that hold copy, by the end of their name (exported or not;
 *  (Challenger) `FOOTNOTE`, `…_MESSAGE`, `…_TEXT` too). */
const COPY_CONST =
  /\b(?:export\s+)?const\s+((?:[A-Za-z_$][\w$]*?_)?(?:LABEL|HELPER|COPY|WORDS|SENTENCE|TITLE|NOTE|HINT|WHY|LEDE|MESSAGE|TEXT|FOOTNOTE|BODY)S?)\b\s*(?=[:=])/g;
/** (Challenger) Any other UPPER_SNAKE constant whose value is a sentence
 *  (`PUSH_WAITS_FOR_SESSION`, `NO_WORKTREE_DIFF`): only its literals that
 *  read as words (two words with a space) are copy, so an id, a selector or
 *  a command name is not. */
const UPPER_CONST = /\b(?:export\s+)?const\s+([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)\b\s*(?=[:=])/g;
const SENTENCE = /[A-Za-z]{2,}[,.;:!?']*\s+[A-Za-z]{2,}/;
/** (Challenger) A call that only adjusts its first argument's words. */
const PASS_THROUGH = /^(?:machineWords)\s*\(/;
/** (Challenger) The codebase's toast-shaped callback, `notify(kind, title,
 *  body, details?)`: its title and body are copy, its details are not. */
const NOTIFY_CALL = /(?<![\w$])notify\s*\(/g;
/** A local named after a copy key, given to it by shorthand (`{ happened, todo }`). */
const COPY_LOCAL = new RegExp(
  String.raw`\b(?:const|let|var)\s+(${COPY_KEYS.filter((k) => !k.includes("-")).join("|")})\b\s*(?=[:=])`,
  "g",
);
/** (Builder) A function whose name says it returns copy — the codebase's
 *  own convention (`handedOverShipLine`, `targetDirtyMessage`, `stageWords`):
 *  the strings it returns are read. Objects it returns are left to the key
 *  rule, so an `id` or a `kind` is never read. */
const COPY_FN_NAME = String.raw`[A-Za-z_$][\w$]*?(?:Line|Lines|Words|Word|Label|Labels|Text|Hint|Note|Body|Title|Sentence|Message|Summary|Refusal|Toast|Lede|Helper|Why)`;
const COPY_FN = new RegExp(String.raw`\bfunction\s+(${COPY_FN_NAME})\s*[<(]`, "g");
const COPY_ARROW = new RegExp(
  String.raw`\b(?:const|let)\s+(${COPY_FN_NAME})\s*(?::[^=]+)?=\s*(?:async\s+)?(?=\(|[A-Za-z_$][\w$]*\s*=>)`,
  "g",
);
/** Text written for an agent, not the person: its name says so. */
const AGENT_CONST =
  /\b(?:(?:const|let|var)\s+|function\s+)([A-Za-z_$][\w$]*?(?:_PROMPT|_BRIEF_FOR_AGENT)S?)\b/g;
/** Where developer words and raw text belong: behind Details, or copied. */
const DETAILS_VALUE = /(?<![\w$.-])(details|copyText)\s*(?::(?!:)|=(?![=>]))\s*/g;
/** (Challenger) Only in a comment, and with a reason of at least one word:
 *  `// ux-allow: data`. The words inside a string never allow themselves. */
const ALLOW = /(?:\/\/|\/\*)\s*ux-allow:\s*[A-Za-z]{3,}/;
const ALLOW_MARK = /(?:\/\/|\/\*)\s*ux-allow:\s*([^\n]*?)\s*(?:\*\/\s*\}?\s*)?$/gm;

/** A file whose copy is read: app source, not tests, fixtures, the
 *  dev-only test bridge or the IPC types. */
export function readsCopy(rel) {
  return (
    rel.startsWith("src/") &&
    /\.tsx?$/.test(rel) &&
    !/\.d\.ts$/.test(rel) &&
    !/\.test\.tsx?$/.test(rel) &&
    !/\.fixtures\./.test(rel) &&
    !rel.startsWith("src/testBridge/") &&
    !rel.startsWith("src/test/") &&
    rel !== "src/ipc.ts"
  );
}

const CLOSER = { "(": ")", "[": "]", "{": "}" };

/** A scanner over one file's code (comments blanked). `jsx`: the file is
 *  .tsx, so `<Tag` after an operator opens an element. */
function copyScanner(code, { jsx }) {
  /** (B3) Told of every quoted string and template part, while `strings` runs. */
  let onString = null;
  /** End of a quoted string; an unterminated one ends at its line (an
   *  apostrophe in JSX text is not a string). */
  function skipQuote(i) {
    const q = code[i];
    let j = i + 1;
    while (j < code.length && code[j] !== q && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  /** End of a template; `onPart(start, end)` per text part, `onHole` per `${…}`. */
  function skipTemplate(i, onPart, onHole) {
    let j = i + 1;
    let part = j;
    while (j < code.length && code[j] !== "`") {
      if (code[j] === "\\") j += 2;
      else if (code[j] === "$" && code[j + 1] === "{") {
        onPart?.(part, j);
        const end = scan(j + 2, "}", null);
        onHole?.(j + 2, end);
        j = end + 1;
        part = j;
      } else j++;
    }
    onPart?.(part, Math.min(j, code.length));
    return j + 1;
  }
  function prevSignificant(i) {
    let j = i - 1;
    while (j >= 0 && /\s/.test(code[j])) j--;
    return j;
  }
  function isRegexStart(i) {
    if (code[i + 1] === "/" || code[i + 1] === "*") return false;
    const p = prevSignificant(i);
    if (p < 0) return true;
    if ("(,=:[!&|?{};+-*%<>~^".includes(code[p])) return true;
    return /\b(return|typeof|case)$/.test(code.slice(Math.max(0, p - 6), p + 1));
  }
  function skipRegex(i) {
    let j = i + 1;
    let cls = false;
    while (j < code.length && code[j] !== "\n") {
      const c = code[j];
      if (c === "\\") j++;
      else if (c === "[") cls = true;
      else if (c === "]") cls = false;
      else if (c === "/" && !cls) {
        j++;
        while (/[a-z]/.test(code[j] ?? "")) j++;
        return j;
      }
      j++;
    }
    return j;
  }
  function isTagStart(i) {
    if (!jsx || code[i] !== "<") return false;
    const n = code[i + 1] ?? "";
    if (!(n === ">" || n === "/" || /[A-Za-z]/.test(n))) return false;
    const p = prevSignificant(i);
    if (p < 0) return true;
    if ("(,=?:&|{}[;>!".includes(code[p])) return true;
    return /\breturn$/.test(code.slice(Math.max(0, p - 5), p + 1));
  }

  /** Index past the unit starting at `i` (string, template, regex, bracket
   *  group, JSX element), or i + 1. JSX copy goes into `out` when given. */
  function skipAt(i, out) {
    const c = code[i];
    if (c === '"' || c === "'") {
      const end = skipQuote(i);
      onString?.(i + 1, end - 1);
      return end;
    }
    if (c === "`") return skipTemplate(i, onString, out ? (s, e) => scanRange(s, e, out) : null);
    if (c === "/" && isRegexStart(i)) return skipRegex(i);
    if (CLOSER[c]) return scan(i + 1, CLOSER[c], out) + 1;
    if (isTagStart(i)) return element(i, out);
    return i + 1;
  }
  /** Scan from `i` to the `closer` at depth 0; returns its index. */
  function scan(i, closer, out) {
    while (i < code.length) {
      const c = code[i];
      if (c === closer || c === ")" || c === "]" || c === "}") return i;
      i = skipAt(i, out);
    }
    return code.length;
  }
  function scanRange(s, e, out) {
    let i = s;
    while (i < e) i = skipAt(i, out);
  }

  /** One JSX element from its `<`; returns the index past it. Its text
   *  runs and the values of its `{…}` children are recorded. */
  function element(i, out) {
    const tag = openTag(i, out);
    if (!tag) return i + 1;
    if (tag.selfClosing) return tag.end;
    let depth = 1;
    let pos = tag.end;
    let text = pos;
    const flush = (to) => {
      if (out && to > text) out.push({ parts: [{ start: text, text: code.slice(text, to) }] });
    };
    while (pos < code.length) {
      const c = code[pos];
      if (c === "{") {
        flush(pos);
        const end = scan(pos + 1, "}", out);
        if (out) values(pos + 1, end, out);
        pos = end + 1;
        text = pos;
      } else if (c === "<") {
        flush(pos);
        if (code[pos + 1] === "/") {
          const close = code.indexOf(">", pos);
          pos = close < 0 ? code.length : close + 1;
          if (--depth === 0) return pos;
        } else {
          const inner = openTag(pos, out);
          if (!inner) pos++;
          else {
            if (!inner.selfClosing) depth++;
            pos = inner.end;
          }
        }
        text = pos;
      } else pos++;
    }
    flush(pos);
    return pos;
  }
  /** An opening tag; the values of its copy props recorded. Null when it
   *  is not a tag after all. */
  function openTag(i, out) {
    let j = i + 1;
    if (code[j] === ">") return { end: j + 1, selfClosing: false };
    const name = /^[A-Za-z_$][\w$.:-]*/.exec(code.slice(j, j + 200));
    if (!name) return null;
    j += name[0].length;
    if (code[j] === "<") j = skipGeneric(j); // `<Select<T> …>`
    while (j < code.length) {
      while (/\s/.test(code[j] ?? "")) j++;
      const c = code[j];
      if (c === ">") return { end: j + 1, selfClosing: false };
      if (c === "/" && code[j + 1] === ">") return { end: j + 2, selfClosing: true };
      if (c === "{") {
        j = scan(j + 1, "}", out) + 1; // a spread
        continue;
      }
      const attr = /^[A-Za-z_$][\w$:.-]*/.exec(code.slice(j, j + 200));
      if (!attr) return null;
      j += attr[0].length;
      while (/\s/.test(code[j] ?? "")) j++;
      if (code[j] !== "=") continue;
      j++;
      while (/\s/.test(code[j] ?? "")) j++;
      const read = out && isCopyKey(attr[0]);
      if (code[j] === '"' || code[j] === "'") {
        const end = skipQuote(j);
        if (read) record(j, end, out);
        onString?.(j + 1, end - 1);
        j = end;
      } else if (code[j] === "{") {
        const end = scan(j + 1, "}", out);
        if (read) values(j + 1, end, out);
        j = end + 1;
      } else return null;
    }
    return null;
  }
  function skipGeneric(j) {
    let depth = 0;
    for (; j < code.length; j++) {
      if (code[j] === "<") depth++;
      else if (code[j] === ">" && --depth === 0) return j + 1;
    }
    return j;
  }

  function record(s, e, out) {
    const text = code.slice(s + 1, e - 1);
    if (/^\s*\[Plyloft\]/.test(text)) return; // a message to the agent
    out.push({ parts: [{ start: s + 1, text }] });
  }
  /** Top-level positions in [s, e): strings, brackets, regexes, JSX skipped. */
  function tops(s, e, visit) {
    let j = s;
    while (j < e) {
      const c = code[j];
      if (c === '"' || c === "'" || c === "`" || CLOSER[c] || (c === "/" && isRegexStart(j)) || isTagStart(j)) {
        j = skipAt(j, null);
        continue;
      }
      if (visit(j) === false) return;
      j++;
    }
  }
  function splitAt(s, e, op) {
    const cuts = [];
    tops(s, e, (j) => {
      if (!code.startsWith(op, j)) return;
      if (op === "+" && (code[j + 1] === "+" || code[j - 1] === "+" || code[j + 1] === "=")) return;
      if (op.length === 2 && code[j + 2] === "=") return;
      cuts.push(j);
    });
    if (!cuts.length) return null;
    const pieces = [];
    let at = s;
    for (const k of cuts) {
      pieces.push([at, k]);
      at = k + op.length;
    }
    pieces.push([at, e]);
    return pieces;
  }

  /** Record the literals a value expression can show: a string; a
   *  template's own text (its `${…}` code never counts, only a literal in
   *  value position inside it); both branches of a ternary; every operand
   *  of `||`, `??` and `+`; the last of `&&`; an object's values; an array's
   *  elements; an arrow's result. A call, a member or a name shows nothing
   *  this reader can know. */
  /** The values of every `return` in the block [s, e). */
  function returns(s, e, out, shallow = false, depth = 0) {
    const re = /\breturn\b/g;
    re.lastIndex = s;
    for (let m = re.exec(code); m && m.index < e; m = re.exec(code)) {
      const end = Math.min(valueEnd(m.index + 6), e);
      values(m.index + 6, end, out, depth, shallow);
      re.lastIndex = Math.max(end, m.index + 6);
    }
  }
  /** A function's body [start, end) from the `(` or `<` after its name. */
  function body(i) {
    let j = i;
    if (code[j] === "<") j = skipGeneric(j);
    while (j < code.length && code[j] !== "(") j++;
    j = scan(j + 1, ")", null) + 1;
    while (j < code.length && code[j] !== "{" && code[j] !== ";") j = skipAt(j, null);
    if (code[j] !== "{") return null;
    return [j + 1, scan(j + 1, "}", null)];
  }
  function values(s, e, out, depth = 0, shallow = false) {
    if (depth > 16) return;
    while (s < e && /\s/.test(code[s])) s++;
    while (e > s && /\s/.test(code[e - 1])) e--;
    if (s >= e) return;
    const v = (a, b) => values(a, b, out, depth + 1, shallow);
    let cut = -1; // `x as const`, `x satisfies T`
    tops(s, e, (j) => {
      if (/\s/.test(code[j - 1] ?? "") && /^(as|satisfies)\s/.test(code.slice(j, j + 11))) {
        cut = j;
        return false;
      }
    });
    if (cut > s) return v(s, cut);
    if (code[s] === "(" && scan(s + 1, ")", null) + 1 === e) return v(s + 1, e - 1);
    let arrow = -1;
    tops(s, e, (j) => {
      if (code[j] === "=" && code[j + 1] === ">") {
        arrow = j;
        return false;
      }
    });
    if (arrow >= 0) {
      let b = arrow + 2;
      while (b < e && /\s/.test(code[b])) b++;
      if (code[b] !== "{") return v(b, e);
      return returns(b, e, out, shallow, depth + 1);
    }
    let q = -1; // cond ? a : b
    let colon = -1;
    let open = 0;
    tops(s, e, (j) => {
      const c = code[j];
      if (c === "?" && code[j + 1] !== "." && code[j + 1] !== "?" && code[j - 1] !== "?") {
        if (q < 0) q = j;
        else open++;
      } else if (c === ":" && q >= 0) {
        if (open === 0) {
          colon = j;
          return false;
        }
        open--;
      }
    });
    if (q >= 0 && colon > q) {
      v(q + 1, colon);
      v(colon + 1, e);
      return;
    }
    for (const op of ["||", "??"]) {
      const pieces = splitAt(s, e, op);
      if (pieces) return pieces.forEach(([a, b]) => v(a, b));
    }
    const ands = splitAt(s, e, "&&");
    if (ands) return v(...ands[ands.length - 1]);
    const plus = splitAt(s, e, "+");
    if (plus) return plus.forEach(([a, b]) => v(a, b));
    // (Challenger) A wrapper that only adjusts the words, `machineWords(…)`:
    // its first argument is the copy.
    const wrap = PASS_THROUGH.exec(code.slice(s, Math.min(e, s + 40)));
    if (wrap) {
      const open = s + wrap[0].length - 1;
      if (scan(open + 1, ")", null) + 1 === e) {
        const args = splitAt(open + 1, e - 1, ",") ?? [[open + 1, e - 1]];
        return v(...args[0]);
      }
    }
    const c = code[s];
    if ((c === '"' || c === "'") && skipQuote(s) === e) return record(s, e, out);
    if (c === "`" && skipTemplate(s) === e) {
      const parts = [];
      const holes = [];
      skipTemplate(
        s,
        (a, b) => parts.push({ start: a, text: code.slice(a, b) }),
        (a, b) => holes.push([a, b]),
      );
      if (/^\s*\[Plyloft\]/.test(parts[0]?.text ?? "")) return;
      out.push({ parts });
      for (const [a, b] of holes) v(a, b);
      return;
    }
    if (c === "{" && scan(s + 1, "}", null) + 1 === e) {
      if (shallow) return; // a returned object: its copy keys are read by key
      for (const [a, b] of splitAt(s + 1, e - 1, ",") ?? [[s + 1, e - 1]]) {
        let k = a;
        while (k < b && /\s/.test(code[k])) k++;
        if (code.startsWith("...", k)) continue;
        let at = -1;
        tops(k, b, (j) => {
          if (code[j] === ":") {
            at = j;
            return false;
          }
        });
        if (at >= 0) v(at + 1, b); // the value, never the key
      }
      return;
    }
    if (c === "[") {
      const end = scan(s + 1, "]", null) + 1;
      const rest = code.slice(end, e).trim();
      if (rest === "" || /^(\.(filter|join)\([^()]*\)\s*)+$/.test(rest)) {
        for (const [a, b] of splitAt(s + 1, end - 1, ",") ?? [[s + 1, end - 1]]) v(a, b);
      }
    }
  }
  /** Where a value starting at `i` ends: a top-level `,` or `;`, or the
   *  bracket that closes around it. */
  function valueEnd(i) {
    let j = i;
    while (j < code.length) {
      const c = code[j];
      if (c === "," || c === ";" || c === ")" || c === "]" || c === "}") return j;
      j = skipAt(j, null);
    }
    return code.length;
  }
  /** (B3) Every string literal and template part of the file, JSX text
   *  and regex literals left out: [[start, end]]. */
  function strings() {
    const found = [];
    onString = (s, e) => found.push([s, e]);
    scanRange(0, code.length, null);
    onString = null;
    return found;
  }
  return { scan, scanRange, values, returns, body, valueEnd, skipAt, element, openTag, splitAt, strings };
}

function blankRange(chars, s, e) {
  for (let k = s; k < e && k < chars.length; k++) if (chars[k] !== "\n") chars[k] = " ";
}

/** End of the `function name(…) … {…}` whose parameters open after `i`. */
function functionEnd(code, sc, i) {
  const paren = code.indexOf("(", i);
  if (paren < 0) return i;
  let j = sc.scan(paren + 1, ")", null) + 1;
  while (j < code.length && code[j] !== "{") j = sc.skipAt(j, null);
  return j < code.length ? sc.scan(j + 1, "}", null) + 1 : j;
}

/** Blank what is never the person's copy: agent prompts (`…_PROMPT`,
 *  `…_BRIEF_FOR_AGENT`), `details`/`copyText` values, `<Details>` children
 *  and the technical surfaces' functions. Offsets are kept. */
function blankNonCopy(code, jsx, technicalFunctions = []) {
  const sc = copyScanner(code, { jsx });
  const chars = code.split("");
  for (const m of code.matchAll(AGENT_CONST)) {
    const at = m.index + m[0].length;
    if (/^function\b/.test(m[0])) blankRange(chars, m.index, functionEnd(code, sc, at));
    else {
      const eq = code.indexOf("=", at);
      if (eq >= 0) blankRange(chars, m.index, sc.valueEnd(eq + 1));
    }
  }
  for (const m of code.matchAll(DETAILS_VALUE)) {
    const at = m.index + m[0].length;
    if (code[at] === "{" && !m[0].includes(":")) blankRange(chars, m.index, sc.scan(at + 1, "}", null) + 1);
    else blankRange(chars, m.index, sc.valueEnd(at));
  }
  if (jsx) {
    // Its children; the tag's own props (`summary`, a title) stay readable.
    for (const m of code.matchAll(/<Details\b/g)) {
      const tag = sc.openTag(m.index, null);
      if (tag && !tag.selfClosing) blankRange(chars, tag.end, sc.element(m.index, null));
    }
  }
  for (const name of technicalFunctions) {
    for (const m of code.matchAll(new RegExp(String.raw`\bfunction\s+${name}\b`, "g"))) {
      blankRange(chars, m.index, functionEnd(code, sc, m.index + m[0].length));
    }
  }
  return chars.join("");
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}
function lineAt(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
/** `// ux-allow: <reason>` (or `{/* ux-allow: … *\/}`) at the end of the
 *  line, or alone on the line above it. */
function allowedAt(rawLines, line) {
  const above = rawLines[line - 2] ?? "";
  return ALLOW.test(rawLines[line - 1] ?? "") || (ALLOW.test(above) && /^\s*(\/\/|\/\*|\{\s*\/\*)/.test(above));
}

/** The visible literals of one file: JSX text (.tsx), the values of the
 *  copy props and keys, and the copy constants. [{ parts: [{ start, text }] }] */
export function visibleCopy(file, text, { technicalFunctions = [] } = {}) {
  const jsx = file.endsWith(".tsx");
  const code = blankNonCopy(stripComments(text), jsx, technicalFunctions);
  const sc = copyScanner(code, { jsx });
  const out = [];
  if (jsx) sc.scanRange(0, code.length, out);
  for (const m of code.matchAll(COPY_KEY)) {
    const at = m.index + m[0].length;
    sc.values(at, sc.valueEnd(at), out);
  }
  const copyConsts = new Set();
  const valueAfterName = (m) => {
    let j = m.index + m[0].length;
    if (code[j] === ":") {
      // a type annotation, up to the `=` that is not an arrow
      j++;
      while (j < code.length && !/[;,)}\]]/.test(code[j]) && !(code[j] === "=" && code[j + 1] !== ">" && code[j + 1] !== "=")) {
        j = sc.skipAt(j, null);
      }
    }
    return code[j] === "=" ? j + 1 : -1;
  };
  for (const m of [...code.matchAll(COPY_CONST), ...code.matchAll(COPY_LOCAL)]) {
    copyConsts.add(m.index);
    const j = valueAfterName(m);
    if (j >= 0) sc.values(j, sc.valueEnd(j), out);
  }
  for (const m of code.matchAll(UPPER_CONST)) {
    if (copyConsts.has(m.index) || /_(?:MARKER|PATTERN|RE|REGEX)S?$/.test(m[1])) continue; // matched against, not shown
    const j = valueAfterName(m);
    if (j < 0) continue;
    const found = [];
    sc.values(j, sc.valueEnd(j), found, 0, true);
    for (const lit of found) if (lit.parts.some((p) => SENTENCE.test(p.text))) out.push(lit);
  }
  for (const m of code.matchAll(NOTIFY_CALL)) {
    const open = m.index + m[0].length - 1;
    const end = sc.scan(open + 1, ")", null);
    const args = sc.splitAt(open + 1, end, ",") ?? [[open + 1, end]];
    for (const [a, b] of args.slice(1, 3)) sc.values(a, b, out);
  }
  for (const m of code.matchAll(COPY_FN)) {
    const range = sc.body(m.index + m[0].length - 1);
    if (range) sc.returns(range[0], range[1], out, true);
  }
  for (const m of code.matchAll(COPY_ARROW)) {
    const at = m.index + m[0].length;
    sc.values(at, sc.valueEnd(at), out, 0, true);
  }
  return { code, literals: out };
}

/** The banned words in one file's visible copy: [{ line, word, found }]. */
export function jargonHits(file, text, opts = {}) {
  const { code, literals } = visibleCopy(file, text, opts);
  const starts = lineStarts(code);
  const rawLines = text.split("\n");
  const seen = new Set();
  const hits = [];
  // DR6 round 1: where the Settings index's search synonyms are.
  const synonymRanges = [];
  if (file.replace(/\\/g, "/").endsWith("src/lib/settingsIndex.ts")) {
    for (const m of code.matchAll(/\bsynonyms\s*:\s*\[/g)) {
      const end = code.indexOf("]", m.index + m[0].length);
      if (end > 0) synonymRanges.push([m.index, end]);
    }
  }
  const inSynonyms = (index) => synonymRanges.some(([a, b]) => index > a && index < b);
  for (const { parts } of literals) {
    for (const { start, text: part } of parts) {
      // an escape (`\n`) is not a letter of the next word
      const plain = part.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (m) => " ".repeat(m.length));
      for (const [word, re, rule] of JARGON) {
        if (rule?.allowIn?.(file)) continue;
        for (const m of plain.matchAll(re)) {
          const index = start + m.index;
          if (rule?.searchSynonyms && inSynonyms(index)) continue;
          if (seen.has(index)) continue;
          seen.add(index);
          const line = lineAt(starts, index);
          if (allowedAt(rawLines, line)) continue;
          hits.push({ line, word, found: m[0], index });
        }
      }
    }
  }
  // B3 round 1: the `anyString` words in every other string that reads as
  // words (it has a space), in the same blanked code.
  const wide = JARGON.filter(([, , rule]) => rule?.anyString && !rule.allowIn?.(file));
  if (wide.length) {
    for (const [s, e] of copyScanner(code, { jsx: file.endsWith(".tsx") }).strings()) {
      const raw = code.slice(s, e);
      if (!/\S\s+\S/.test(raw)) continue;
      const plain = raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (m) => " ".repeat(m.length));
      for (const [word, re, rule] of wide) {
        for (const m of plain.matchAll(re)) {
          const index = s + m.index;
          if (rule?.searchSynonyms && inSynonyms(index)) continue;
          if (seen.has(index)) continue;
          seen.add(index);
          const line = lineAt(starts, index);
          if (allowedAt(rawLines, line)) continue;
          hits.push({ line, word, found: m[0], index });
        }
      }
    }
  }
  // X5 (1.174.0 G1 walk): a tool's name is the doctor's (Rust,
  // `doctor.rs`: "Codex CLI"), so `${tool.name} as a reviewer` read clean
  // here while the screen said "Codex CLI as a reviewer". A copy template
  // that puts a doctor tool's name in its words is read with each of those
  // names in its place.
  const toolNames = opts.toolNames ?? [];
  if (toolNames.length && /\bToolStatus\b/.test(text)) {
    for (const { parts } of literals) {
      for (let i = 0; i + 1 < parts.length; i++) {
        const holeStart = parts[i].start + parts[i].text.length;
        const hole = code.slice(holeStart, parts[i + 1].start);
        if (!/^\$\{\s*[A-Za-z_$][\w$]*\.name\s*\}$/.test(hole)) continue;
        const line = lineAt(starts, holeStart);
        if (allowedAt(rawLines, line)) continue;
        for (const name of toolNames) {
          for (const [word, re, rule] of JARGON) {
            if (rule?.allowIn?.(file)) continue;
            for (const m of name.matchAll(re)) {
              const key = `${holeStart}:${word}:${name}`;
              if (seen.has(key)) continue;
              seen.add(key);
              hits.push({ line, word, found: `${m[0]} (the tool's name “${name}”)`, index: holeStart });
            }
          }
        }
      }
    }
  }
  return hits.sort((a, b) => a.index - b.index).map(({ line, word, found }) => ({ line, word, found }));
}

/** X5: the tools' display names the doctor sends (`ToolStatus.name`). */
export function doctorToolNames(root) {
  const path = join(root, "src-tauri/src/doctor.rs");
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  return [...new Set([...text.matchAll(/\bname:\s*"([^"]+)"\.into\(\)/g)].map((m) => m[1]))];
}

/** A caught error's raw text, in the shapes the toast rule reads. */
const RAW_TEXT =
  String.raw`(?:String\(\s*${CAUGHT}\s*\)|String\(\s*\(\s*${CAUGHT}\s+as\b|rawError\(\s*${CAUGHT}\s*\)|` +
  // e instanceof Error ? e.message : String(e)
  String.raw`${CAUGHT}\s+instanceof\s+Error\s*\?\s*${CAUGHT}\.message\s*:\s*String\(\s*${CAUGHT}\s*\)|` +
  // a template around ${e}, or around String(e) anywhere in a hole
  String.raw`\x60[^\x60]*\$\{(?:\s*${CAUGHT}\s*\}|[^}\x60]*?\bString\(\s*\(?\s*${CAUGHT}\b))`;
const RAW_INLINE = [
  // a React state setter: setError(String(e)), setNote(`Couldn't: ${e}`)
  { re: new RegExp(String.raw`\b(set[A-Z][\w$]*)\(\s*` + RAW_TEXT, "g"), setter: true },
  // a line of an error block or a row: happened, todo, text, hint
  { re: new RegExp(String.raw`(?<![\w$.-])(?:happened|todo|text|hint)\s*(?::(?!:)|=\{)\s*` + RAW_TEXT, "g") },
  // (Challenger) a transcript line, `append("error", String(error))`
  // (CodexSession), and the body of a `notify(kind, title, body)` toast
  { re: new RegExp(String.raw`(?<![\w$])append\(\s*["'](?:error|warn|info)["']\s*,\s*` + RAW_TEXT, "g") },
  {
    re: new RegExp(
      String.raw`(?<![\w$])notify\(\s*["'][a-z]+["']\s*,\s*(?:"[^"\n]*"|'[^'\n]*'|\x60[^\x60]*\x60)\s*,\s*` + RAW_TEXT,
      "g",
    ),
  },
  // QoL 1.168 block 8 (A5): a template literal that prints a caught error
  // into what the person reads — `${e}`, `${String(e)}`, `${rawError(e)}`,
  // `${e.message}`, `${errorText(e)}` — as a copy key's value (`title:`,
  // `body:`, `text:`, `hint:`, …), a terminal line (`writeln(`) or a state
  // setter's argument (a template handed to `details` or `copyText`,
  // `console.*` or `throw` is never read).
  {
    re: new RegExp(
      String.raw`(?:(?<![\w$.-])(?:title|body|text|label|hint|sentence|happened|todo|lede|helper|note)\s*:\s*|\bwriteln\(\s*|\bset[A-Z][\w$]*\(\s*)` +
      String.raw`\x60[^\x60]*\$\{\s*(?:${CAUGHT}(?:\.message)?|String\(\s*\(?\s*${CAUGHT}\b[^}]*|rawError\(\s*${CAUGHT}\s*\)|\w*(?:[Ee]rr|[Mm]essage|[Tt]ext)\w*\(\s*${CAUGHT}\s*\))\s*\}`,
      "g",
    ),
    template: true,
  },
  // JSX: {String(e)}, {`${e}`}
  {
    re: new RegExp(
      String.raw`(?<![$=\w])\{\s*(?:String\(\s*${CAUGHT}\s*\)\s*\}|\x60[^\x60]*\$\{\s*${CAUGHT}\s*\}[^\x60]*\x60\s*\})`,
      "g",
    ),
    jsx: true,
  },
];

/** A raw caught error shown inline — handed to a state setter, made a line
 *  of an error block, or put in JSX — outside `details`/`copyText`
 *  (`console.*` and `throw` are never read): [{ line, found }]. */
export function rawErrorsInline(file, text) {
  const jsx = file.endsWith(".tsx");
  const code = blankNonCopy(stripComments(text), jsx);
  const starts = lineStarts(code);
  const rawLines = text.split("\n");
  const hits = [];
  // (Challenger) `reason` and `cause` are also plain record fields
  // (worktreeSetup.ts's `${reason}` is the setup record's own line): they
  // count only in a file that catches an error under that name.
  const caughtHere = (name) =>
    new RegExp(String.raw`\bcatch\s*\(\s*${name}\b|\.catch\(\s*(?:async\s*)?\(?\s*${name}\b`).test(code);
  const loose = ["reason", "cause"].filter((n) => !caughtHere(n));
  const looseRe = loose.length ? new RegExp(String.raw`\b(?:${loose.join("|")})\b`) : null;
  const caughtIn = (found) => {
    if (!looseRe) return true;
    const names = [...found.matchAll(/\b(e|err|error|cause|reason)\b/g)].map((x) => x[1]);
    return names.some((n) => !looseRe.test(n));
  };
  const seenAt = new Set();
  for (const { re, setter, jsx: jsxOnly } of RAW_INLINE) {
    if (jsxOnly && !jsx) continue;
    for (const m of code.matchAll(re)) {
      // (block 8) the template rule and the setter rule meet at one place
      if (seenAt.has(m.index)) continue;
      seenAt.add(m.index);
      if (setter && /Details/.test(m[1])) continue;
      // the caught name is what follows the shape's start (`String(`, `${`)
      if (!caughtIn(m[0].replace(/^[^(`{]*[(`{]/, ""))) continue;
      const line = lineAt(starts, m.index);
      if (allowedAt(rawLines, line)) continue;
      hits.push({ line, found: m[0].replace(/\s+/g, " ").trim().slice(0, 60), index: m.index });
    }
  }
  return hits.sort((a, b) => a.index - b.index).map(({ line, found }) => ({ line, found }));
}

/** The technical surfaces: whole files, and named functions in a file. */
export function technicalSurfaces(root) {
  const path = join(root, TECHNICAL_FILE);
  const files = new Set();
  const functions = new Map();
  const missing = [];
  if (!existsSync(path)) return { files, functions, missing };
  const json = JSON.parse(readFileSync(path, "utf8"));
  for (const { file } of json.files ?? []) {
    if (!existsSync(join(root, file))) missing.push(file);
    files.add(file);
  }
  for (const { file, name } of json.functions ?? []) {
    if (!existsSync(join(root, file))) missing.push(file);
    functions.set(file, [...(functions.get(file) ?? []), name]);
  }
  return { files, functions, missing };
}

/** Per-file hits over `src/`: { jargon, raw } as Map file → hits. */
export function copyHits(root) {
  const tech = technicalSurfaces(root);
  const toolNames = doctorToolNames(root);
  const jargon = new Map();
  const raw = new Map();
  const allows = new Map();
  const bare = new Map();
  for (const abs of walk(join(root, "src"))) {
    const rel = posix(relative(root, abs));
    if (!readsCopy(rel)) continue;
    const text = readFileSync(abs, "utf8");
    const a = allowMarks(text);
    if (a.length) allows.set(rel, a);
    if (!tech.files.has(rel)) {
      const j = jargonHits(rel, text, { technicalFunctions: tech.functions.get(rel) ?? [], toolNames });
      if (j.length) jargon.set(rel, j);
    }
    const r = rawErrorsInline(rel, text);
    if (r.length) raw.set(rel, r);
    const b = bareErrorToasts(rel, text);
    if (b.length) bare.set(rel, b);
  }
  return { jargon, raw, allows, bare, missing: tech.missing };
}

/** (Challenger) Every `ux-allow:` marker in a file, with its reason:
 *  [{ line, found }]. Counted per file like the hits, so a new one shows in
 *  the baseline's diff instead of silently lowering a count. */
export function allowMarks(text) {
  const starts = lineStarts(text);
  return [...text.matchAll(ALLOW_MARK)].map((m) => ({ line: lineAt(starts, m.index), found: `ux-allow: ${m[1]}` }));
}

/** Map file → hits as a sorted { file: count }. */
export const countsOf = (hits) =>
  Object.fromEntries([...hits].sort(([a], [b]) => (a < b ? -1 : 1)).map(([f, h]) => [f, h.length]));
const sumOf = (map) => Object.values(map ?? {}).reduce((a, b) => a + b, 0);

/**
 * The per-file ratchet. A file's count may not rise and a new file may not
 * have any — unless the run's total does not rise and other files lost what
 * it gained: a move between files, printed "moved from …". A rise in the
 * total always fails, every hit of each file that gained printed.
 *
 * (Challenger) Any difference from the baseline — a fall or a move — fails
 * too until `--write-baseline` records it in the same change. Otherwise a
 * fall left unrecorded is credit: a later change could add as many words
 * anywhere and pass as a "move". `mayRise` (the `ux-allow` markers): the
 * write records a rise, and until then every new marker is printed, so it
 * appears in the baseline's diff instead of silently lowering a count.
 */
export function ratchetMap(name, was, now, hits, { mayRise = false } = {}) {
  const errors = [];
  const notes = [];
  const before = sumOf(was);
  const after = sumOf(now);
  const gained = [];
  const lost = [];
  for (const f of new Set([...Object.keys(was ?? {}), ...Object.keys(now)])) {
    const a = was?.[f] ?? 0;
    const b = now[f] ?? 0;
    if (b > a) gained.push(f);
    else if (b < a) lost.push(f);
  }
  const rose = after > before;
  const changed = gained.length + lost.length > 0;
  const hitsOf = (f) => (hits.get(f) ?? []).map((h) => `  ${f}:${h.line}: "${h.found}"`);
  if (rose && !mayRise) {
    errors.push(`${name} rose from ${before} to ${after} — say it in plain words, or put it behind Details`);
    for (const f of gained) {
      errors.push(`${f}: ${was?.[f] ?? 0} → ${now[f]}`);
      errors.push(...hitsOf(f));
    }
  } else if (changed) {
    for (const f of gained) {
      notes.push(`${name}: ${f} ${was?.[f] ?? 0} → ${now[f]} (${rose ? "new" : `moved from ${lost.join(", ")}`})`);
      if (mayRise) notes.push(...hitsOf(f));
    }
    for (const f of lost) notes.push(`${name}: ${f} ${was?.[f] ?? 0} → ${now[f] ?? 0}`);
    errors.push(
      `${name} ${before} → ${after} is not recorded in ${BASELINE_FILE} — run \`node scripts/ux-check.mjs --write-baseline\` in this change`,
    );
  }
  return { errors, notes, rose, changed, fell: after < before, before, after };
}

// ── the counts for the rest of the app ─────────────────────────────────

function family(cls) {
  const i = cls.indexOf("--");
  return i > 0 ? cls.slice(0, i) : cls;
}
export const isButtonFamily = (f) => /(btn|button)s?$/.test(f);
export const isPanelFamily = (f) => /(panel|modal|dialog|sheet|popover|overlay|drawer)$/.test(f);

export function countCss(css) {
  const buttons = new Set();
  const panels = new Set();
  for (const c of definedClasses(css)) {
    const f = family(c);
    if (isButtonFamily(f)) buttons.add(f);
    if (isPanelFamily(f)) panels.add(f);
  }
  let colours = 0;
  for (const { prop, value } of declarations(css)) {
    if (prop.startsWith("--")) continue; // a token's own definition
    colours += colourLiteralsIn(value, { named: COLOUR_PROP.test(prop) }).length;
  }
  return { buttons, panels, colours };
}

export function countScriptColours(text) {
  return scriptColours(text).length;
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const posix = (p) => p.split(sep).join("/");

export function appCounts(root, exclude) {
  const buttons = new Set();
  const panels = new Set();
  let colours = 0;
  for (const abs of walk(join(root, "src"))) {
    const rel = posix(relative(root, abs));
    if (exclude(rel)) continue;
    if (rel.endsWith(".css")) {
      const c = countCss(readFileSync(abs, "utf8"));
      c.buttons.forEach((b) => buttons.add(b));
      c.panels.forEach((p) => panels.add(p));
      colours += c.colours;
    } else if (/\.(tsx|ts)$/.test(rel) && !/\.test\.tsx?$/.test(rel)) {
      colours += countScriptColours(readFileSync(abs, "utf8"));
    }
  }
  return {
    buttonFamilies: buttons.size,
    panelFamilies: panels.size,
    colourLiterals: colours,
  };
}

// ── the component registry (VC-6) ──────────────────────────────────────

/** Every component the registry must know: a .tsx under src/components,
 *  not the layer (always checked) and not a test. */
export function componentFiles(root) {
  return walk(join(root, "src/components"))
    .map((abs) => posix(relative(root, abs)))
    .filter((rel) => rel.endsWith(".tsx") && !/\.test\.tsx$/.test(rel) && !rel.startsWith(`${LAYER_DIR}/`))
    .sort();
}

/**
 * The ratchet for new UI (VC-6, 1.174.0). Every component is in exactly one
 * of migrated.json's lists: `files` (held to the strict rules), `pending`
 * ({ file: problems } — it doesn't pass yet, and its count may only go
 * down) or `legacy` (the closed list of the files before the ratchet).
 * `problemsOf(file)` is the strict check's list for a file.
 * Returns the errors, the notes, and the registry `--write-baseline` would
 * write (lowered counts; a pending file at 0 moved to `files`).
 */
export function checkRegistry({ components, files, pending, legacy, closedLegacy = null, exists, problemsOf }) {
  const errors = [];
  const notes = [];
  const where = new Map();
  const lists = [["files", files], ["pending", Object.keys(pending)], ["legacy", legacy]];
  for (const [list, names] of lists) {
    for (const f of names) {
      if (where.get(f) === list) errors.push(`${MIGRATED_FILE}: "${f}" is listed twice in "${list}" — keep one`);
      else if (where.has(f)) errors.push(`${MIGRATED_FILE}: "${f}" is in both "${where.get(f)}" and "${list}" — keep it in one`);
      else where.set(f, list);
    }
  }
  const nextPending = {};
  const moved = [];
  for (const [f, was] of Object.entries(pending)) {
    if (!exists(f)) {
      errors.push(`${MIGRATED_FILE}: pending "${f}" does not exist — if it was renamed or moved, change its entry to the new path; if it was deleted, remove it from "pending"`);
      continue;
    }
    const problems = problemsOf(f);
    const now = problems.length;
    if (now > was) {
      errors.push(`${f}: ${now} problem(s), "pending" allows ${was} — a pending file's count only goes down; fix the new one(s):`);
      errors.push(...problems.map((p) => `  ${p}`));
      nextPending[f] = was;
    } else if (now === 0) {
      notes.push(`${f} passes the migrated rules now (pending ${was} → 0) — run \`node scripts/ux-check.mjs --write-baseline\` to move it to "files"`);
      moved.push(f);
    } else {
      if (now < was) notes.push(`pending ${f} ${was} → ${now} — run \`node scripts/ux-check.mjs --write-baseline\` to record it`);
      nextPending[f] = now;
    }
  }
  // B1 round 1: "legacy" is closed. The baseline keeps the list as it was
  // when the ratchet started (`legacyComponents`); an entry it doesn't hold
  // was added by hand, and fails like an unregistered component.
  const closed = closedLegacy ? new Set(closedLegacy) : null;
  for (const f of legacy) {
    if (!exists(f)) {
      errors.push(
        `${MIGRATED_FILE}: legacy "${f}" does not exist — if it was renamed or moved, list the new path in "pending" with the count ux-check prints for it ("legacy" is closed); if it was deleted, remove it`,
      );
      continue;
    }
    if (closed && !closed.has(f)) {
      const n = problemsOf(f).length;
      errors.push(
        `${MIGRATED_FILE}: "${f}" is in "legacy", which is closed (${BASELINE_FILE} \`legacyComponents\`) — ` +
          (n === 0 ? `it passes the migrated rules: move it to "files"` : `move it to "files" once it passes, or to "pending" as "${f}": ${n}`),
      );
    }
  }
  for (const f of components) {
    if (where.has(f)) continue;
    const n = problemsOf(f).length;
    errors.push(
      n === 0
        ? `${f} is a new component that ${MIGRATED_FILE} doesn't list — it passes the migrated rules: add it to "files"`
        : `${f} is a new component that ${MIGRATED_FILE} doesn't list — it has ${n} problem(s) under the migrated rules: fix them and add it to "files", or add "${f}": ${n} to "pending" (the count may only go down). "legacy" is closed`,
    );
  }
  const changed = moved.length > 0 || Object.entries(nextPending).some(([f, n]) => n !== pending[f]) ||
    Object.keys(nextPending).length !== Object.keys(pending).length;
  return { errors, notes, changed, next: { files: [...files, ...moved], pending: nextPending, legacy } };
}

// ── run ────────────────────────────────────────────────────────────────

export function run(root, { writeBaseline = false, list = false } = {}) {
  const lines = [];
  const errors = [];
  const say = (s) => lines.push(s);

  const migratedPath = join(root, MIGRATED_FILE);
  const registry = existsSync(migratedPath) ? JSON.parse(readFileSync(migratedPath, "utf8")) : {};
  const migrated = registry.files ?? [];
  const pending = registry.pending ?? {};
  const legacy = registry.legacy ?? [];
  const layerFiles = walk(join(root, LAYER_DIR)).map((p) => posix(relative(root, p)));
  const layerCss = layerFiles.filter((f) => f.endsWith(".css"));
  const layerTsx = layerFiles.filter((f) => f.endsWith(".tsx"));

  const catalogue = new Set();
  for (const f of layerCss) {
    const css = readFileSync(join(root, f), "utf8");
    definedClasses(css).forEach((c) => catalogue.add(c));
    errors.push(...checkLayerCss(f, css));
  }
  for (const f of layerTsx) {
    errors.push(...checkTsx(f, readFileSync(join(root, f), "utf8"), catalogue, { raw: false }));
  }
  for (const f of migrated) {
    if (!existsSync(join(root, f))) {
      errors.push(`${MIGRATED_FILE}: "${f}" does not exist — if it was renamed or moved, change its entry to the new path`);
      continue;
    }
    if (f.endsWith(".tsx")) {
      errors.push(...checkTsx(f, readFileSync(join(root, f), "utf8"), catalogue));
    } else if (f.endsWith(".css")) {
      errors.push(...checkLayerCss(f, readFileSync(join(root, f), "utf8")));
    }
  }

  const baselinePath = join(root, BASELINE_FILE);
  const readBaseline = () => (existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : null);
  const closedLegacy = readBaseline()?.legacyComponents ?? null;
  const reg = checkRegistry({
    components: componentFiles(root),
    files: migrated,
    pending,
    legacy,
    closedLegacy,
    exists: (f) => existsSync(join(root, f)),
    problemsOf: (f) => checkTsx(f, readFileSync(join(root, f), "utf8"), catalogue),
  });
  errors.push(...reg.errors);
  for (const n of reg.notes) say(`ux-check: ${n}`);

  const sources = walk(join(root, "src"))
    .map((abs) => posix(relative(root, abs)))
    .filter((rel) => /\.(css|tsx|ts)$/.test(rel) && !/\.test\.tsx?$/.test(rel))
    .map((file) => ({ file, text: readFileSync(join(root, file), "utf8") }));
  errors.push(...undefinedTokens(sources));
  for (const { file, text } of sources) {
    if (/\.tsx?$/.test(file)) errors.push(...rawErrorToasts(file, text), ...linkToastHits(file, text));
  }

  const held = new Set(migrated);
  const counts = appCounts(
    root,
    (rel) => rel.startsWith(`${LAYER_DIR}/`) || held.has(rel),
  );
  const copy = copyHits(root);
  for (const f of copy.missing) errors.push(`${TECHNICAL_FILE}: "${f}" does not exist`);
  const agent = agentWordHits(root);
  const copyCounts = {
    jargon: countsOf(copy.jargon),
    rawErrorsInline: countsOf(copy.raw),
    uxAllows: countsOf(copy.allows),
    bareErrorToasts: countsOf(copy.bare),
    agentWords: countsOf(agent),
  };
  const copyHitsOf = {
    jargon: copy.jargon,
    rawErrorsInline: copy.raw,
    uxAllows: copy.allows,
    bareErrorToasts: copy.bare,
    agentWords: agent,
  };
  const mayRise = (key) => key === "uxAllows";
  // (B3) A word newly added to JARGON: the baseline lists the words its
  // jargon counts were taken with (`jargonWords`). The write records a new
  // word's hits once — they are the ratchet's start — and only then; a word
  // the baseline knows may never rise. Without the list, every word is known.
  const jargonWordsNow = JARGON.map(([w]) => w);
  const knownWords = (b) => new Set(Array.isArray(b?.jargonWords) ? b.jargonWords : jargonWordsNow);
  const jargonOf = (words) => {
    const m = new Map();
    for (const [f, hits] of copy.jargon) {
      const kept = hits.filter((h) => words.has(h.word));
      if (kept.length) m.set(f, kept);
    }
    return m;
  };

  if (writeBaseline) {
    // The per-file maps never rise through a write: a rise in a total is
    // refused, so only a fall or a move (same or lower total) is recorded.
    const old = readBaseline();
    const refused = [];
    for (const key of Object.keys(copyCounts)) {
      if (!old || old[key] === undefined || mayRise(key)) continue; // first recording, or allows
      const hitsNow = key === "jargon" ? jargonOf(knownWords(old)) : copyHitsOf[key];
      const countsNow = key === "jargon" ? countsOf(hitsNow) : copyCounts[key];
      const r = ratchetMap(key, old[key], countsNow, hitsNow);
      if (r.rose) {
        const files = Object.keys(countsNow).filter((f) => countsNow[f] > (old[key][f] ?? 0));
        refused.push(`a count would rise — ${key} ${r.before} → ${r.after} (${files.join(", ")})`);
      }
    }
    // (B3 round 1) A banned word taken out while a new one is recorded:
    // a rename would pass the old word's hits as the new word's start.
    if (old && Array.isArray(old.jargonWords)) {
      const removed = old.jargonWords.filter((w) => !jargonWordsNow.includes(w));
      const added = jargonWordsNow.filter((w) => !old.jargonWords.includes(w));
      if (removed.length && added.length) {
        refused.push(
          `a banned word is taken out (${removed.map((w) => `"${w}"`).join(", ")}) while a new one is recorded (${added.map((w) => `"${w}"`).join(", ")}) — record them in separate changes`,
        );
      }
    }
    // (B3 round 1) Both files or neither: the registry and the baseline are
    // written only when the registry has no error and nothing is refused.
    if (reg.errors.length) refused.push(`the component registry has ${reg.errors.length} problem(s) — fix them first`);
    if (refused.length) {
      errors.push(`--write-baseline refused: ${refused.join("; ")}`);
    } else {
      if (reg.changed) {
        writeFileSync(migratedPath, JSON.stringify({ ...registry, ...reg.next }, null, 2) + "\n");
        say(`ux-check: pending counts written to ${MIGRATED_FILE}`);
      }
      // The closed legacy list only shrinks: the first write records it, a
      // later one keeps only the entries still in migrated.json's "legacy".
      const legacyNow = new Set(legacy);
      const legacyComponents = (closedLegacy ?? [...legacy]).filter((f) => legacyNow.has(f)).sort();
      writeFileSync(
        baselinePath,
        JSON.stringify({ ...counts, ...copyCounts, jargonWords: jargonWordsNow, legacyComponents }, null, 2) + "\n",
      );
      say(`ux-check: baseline written to ${BASELINE_FILE}`);
    }
  }
  const baseline = readBaseline();
  if (!baseline) errors.push(`${BASELINE_FILE} is missing — run with --write-baseline once`);
  else if (!Array.isArray(baseline.legacyComponents)) {
    errors.push(`${BASELINE_FILE} has no legacyComponents — run with --write-baseline once`);
  }
  if (baseline && !Array.isArray(baseline.jargonWords)) {
    errors.push(`${BASELINE_FILE} has no jargonWords — run with --write-baseline once`);
  } else if (baseline) {
    const known = knownWords(baseline);
    const added = jargonWordsNow.filter((w) => !known.has(w));
    if (added.length) {
      errors.push(
        `new banned word(s) ${added.map((w) => `"${w}"`).join(", ")}: their hits today aren't in ${BASELINE_FILE} — run \`node scripts/ux-check.mjs --write-baseline\` to record them (once; after that they only go down)`,
      );
    }
  }

  say(
    `ux-check: ${migrated.length} migrated file(s), ${Object.keys(pending).length} pending (${sumOf(pending)} problem(s)), ${legacy.length} legacy, ${layerFiles.length} layer file(s), ${catalogue.size} ux classes`,
  );
  const names = {
    buttonFamilies: "button families",
    panelFamilies: "panel families",
    colourLiterals: "colour literals",
  };
  const parts = [];
  let lower = false;
  for (const key of Object.keys(names)) {
    const now = counts[key];
    const was = baseline?.[key];
    parts.push(`${names[key]} ${now}${was === undefined ? "" : ` (baseline ${was})`}`);
    if (was !== undefined && now > was) {
      errors.push(`${names[key]} rose from ${was} to ${now} — a new one belongs in the ux layer`);
    }
    if (was !== undefined && now < was) lower = true;
  }
  say(`ux-check: rest of the app — ${parts.join(" · ")}`);

  // Jargon and raw errors in visible copy: per-file ratchets.
  const copyNames = {
    jargon: "jargon",
    rawErrorsInline: "raw errors inline",
    uxAllows: "ux-allow markers",
    bareErrorToasts: "error toasts with no body or action",
    agentWords: "the Reviewer's old name in agent text",
  };
  const copyParts = [];
  for (const key of Object.keys(copyNames)) {
    const now = copyCounts[key];
    const was = baseline?.[key];
    const files = Object.keys(now).length;
    copyParts.push(
      `${copyNames[key]} ${sumOf(now)} in ${files} file(s)${was === undefined ? "" : ` (baseline ${sumOf(was)})`}`,
    );
    if (baseline && was === undefined) {
      errors.push(`${BASELINE_FILE} has no ${key} counts — run with --write-baseline once`);
      continue;
    }
    if (was === undefined) continue;
    const r = ratchetMap(copyNames[key], was, now, copyHitsOf[key], { mayRise: mayRise(key) });
    errors.push(...r.errors);
    for (const n of r.notes) say(`ux-check: ${n}`);
  }
  say(`ux-check: visible copy — ${copyParts.join(" · ")}`);
  const byWord = new Map(JARGON.map(([w]) => [w, 0]));
  for (const hits of copy.jargon.values()) for (const h of hits) byWord.set(h.word, byWord.get(h.word) + 1);
  say(`ux-check: jargon by word — ${[...byWord].map(([w, n]) => `${w} ${n}`).join(" · ")}`);
  if (list) {
    for (const [key, map] of Object.entries(copyHitsOf)) {
      say(`ux-check: every one of the ${copyNames[key]}, by file:`);
      for (const [f, hits] of [...map].sort(([a], [b]) => (a < b ? -1 : 1))) {
        for (const h of hits) say(`  ${f}:${h.line}: "${h.found}"`);
      }
    }
  }
  if (lower && !writeBaseline) {
    say("ux-check: a count fell — run `node scripts/ux-check.mjs --write-baseline` to ratchet the baseline down");
  }
  for (const e of errors) say(`  ✗ ${e}`);
  say(errors.length ? `ux-check: ${errors.length} problem(s)` : "ux-check: clean");
  return { ok: errors.length === 0, errors, counts, output: lines.join("\n") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--root");
  const root =
    at >= 0 ? args[at + 1] : join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const result = run(root, { writeBaseline: args.includes("--write-baseline"), list: args.includes("--list") });
  console.log(result.output);
  process.exit(result.ok ? 0 : 1);
}
