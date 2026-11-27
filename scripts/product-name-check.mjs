#!/usr/bin/env node
// Product-name guard (Plyloft rename card): a step of scripts/ppvp.sh.
// Tests: scripts/product-name-check.test.mjs.
//
// The product's user-facing name is "Plyloft"; the bundle (Card B: Ply.app →
// Plyloft.app) reads "Plyloft" too. The identifier, the updater feed and
// every other machine-matched token stay "Ply"/"ply" (AGENTS.md, "Product
// boundaries"). This fails when a standalone "Ply"
// (word boundary, capital P, not immediately followed by "loft" — so it
// never flags "Plyloft" itself) sits in the CODE of a non-comment line in
// src/**/*.ts(x), src-tauri/src/**/*.rs, src-tauri/crates/*/src/**/*.rs or
// index.html, so the rename doesn't quietly regress one file, one JSX text
// node or one multi-line string continuation at a time. It also pins the
// tokens that must NOT rename: tauri.conf.json's
// productName/identifier/updater endpoint, and Info.plist's CFBundleName.
//
// "Code" is whatever is left after stripping `//...` and block comments
// (state tracked across lines, so a continued block comment or a multi-line
// string are both handled correctly regardless of whether a continuation
// line happens to start with `*` or `//`) — this deliberately scans JSX
// bare text and Rust string-literal continuation lines, not just quoted
// spans. The scanner is string-aware: a comment-opening sequence sitting
// inside a "…"/`…`/'…' string, or a Rust raw string or char literal, is
// never mistaken for a real comment (that used to blind the guard for
// thousands of lines after one `"+refs/heads/*:refs/remotes/origin/*"` or
// one `"https://…"`) — the string's own text still gets scanned, since
// that's exactly where prose lives.
//
// Excludes: test files (`*.test.ts`, `*.test.tsx`) and test modules
// (a rust `#[cfg(test)] mod ... { }` block, brace-tracked, or a whole file
// named `*_tests.rs`/`*_test.rs` pulled in elsewhere via `#[path] mod
// tests;`) — those assert against changing source text and are covered by
// running the suites themselves, not this ratchet; `src/components/
// WelcomeScreen.tsx` (being retired, out of scope for this card); comments
// in either language; and the explicit allowlist below, each entry the
// (file, substring) pair for a kept contract — a Rust enum variant/
// identifier, or a script-matched palette query.
//
// Usage: node scripts/product-name-check.mjs [--root DIR]

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PLY_WORD = /\bPly\b(?!loft)/g;

// Kept contracts that would otherwise trip the widened whole-line scan.
// Test files are skipped wholesale (see isTestFile / isRustTestOnlyFile),
// so no entry here should ever name one — that would be dead code. Each
// entry's matcher is a plain substring (`line.includes(...)`) unless it
// would otherwise be too loose, in which case it's a `RegExp` anchored as
// tightly as the actual line allows (see the enum-variant entry below).
export const ALLOWLIST = [
  // scripts/runtime-smoke.mjs types this exact palette query and waits for
  // a `.palette-item-label` matching it verbatim; scripts stay put, so the
  // query text keeps "Ply" too.
  ["src/lib/installedSelfCheck.ts", "Ply diagnostics: P3-1 self-check"],
  // Rust identifiers, not prose: an enum variant and its two match arms.
  // The variant's own declaration is just `    Ply,` — a bare substring
  // match would also allow (and hide a regression in) any other line that
  // happens to contain "Ply," anywhere, so this one is anchored to the
  // whole trimmed line instead.
  ["src-tauri/src/proposals.rs", /^\s*Ply,\s*$/],
  ["src-tauri/src/proposals.rs", "Some(Self::Ply)"],
  ["src-tauri/src/proposals.rs", "ElsewhereScope::Ply"],
  // The old app's own name, on purpose: legacy_install.rs and its sheet
  // find and remove the pre-rename "Ply" left installed beside Plyloft.
  ["src-tauri/src/legacy_install.rs", 'pub const LEGACY_PRODUCT: &str = "Ply";'],
  ["src-tauri/src/legacy_install.rs", "The old Ply went to"],
  ["src-tauri/src/legacy_install.rs", "legacy install: old Ply"],
  ["src/components/LegacyInstallPrompt.tsx", '`Ply ${found.version}` : "Ply"} (this app under its earlier name)'],
  ["src/components/LegacyInstallPrompt.tsx", 'title="Ply is still installed"'],
  ["src/components/LegacyInstallPrompt.tsx", 'title="Ply is removed"'],
  ["src/components/LegacyInstallPrompt.tsx", '"Remove Ply"'],
  ["src/components/LegacyInstallPrompt.tsx", "`Ply was moved to ${done.bin}"],
  ["src/components/LegacyInstallPrompt.tsx", "opens Ply, so it left it; delete it if it does."],
];

export const SKIP_FILES = new Set(["src/components/WelcomeScreen.tsx"]);

function isTestFile(rel) {
  return /\.test\.tsx?$/.test(rel);
}

function isAllowed(rel, line) {
  return ALLOWLIST.some(([f, matcher]) => {
    if (f !== rel) return false;
    return matcher instanceof RegExp ? matcher.test(line) : line.includes(matcher);
  });
}

/** Rust raw-string prefix (`r"`, `r#"`, `br##"`, …) immediately before the
 *  `"` at `quoteIndex`, or `null` if there isn't one. Returns the `#` count. */
function rawStringHashesBefore(line, quoteIndex) {
  let j = quoteIndex - 1;
  let hashes = 0;
  while (j >= 0 && line[j] === "#") {
    hashes++;
    j--;
  }
  if (j < 0 || line[j] !== "r") return null;
  j--;
  if (j >= 0 && line[j] === "b") j--;
  if (j >= 0 && /[A-Za-z0-9_]/.test(line[j])) return null; // part of a longer identifier
  return hashes;
}

/** Is `line[i]` (a `'`) the start of a Rust char literal (`'x'`, `'\n'`,
 *  `'\''`, `'\u{2014}'`, …)? Returns the index right after the closing `'`
 *  if so, else `null` — meaning it's a lifetime (`'a`, `'static`, `'_`)
 *  instead, which never opens a string. */
function rustCharLiteralEnd(line, i) {
  const n = line.length;
  let j = i + 1;
  if (j >= n) return null;
  if (line[j] === "\\") {
    j++;
    if (j >= n) return null;
    if (line[j] === "u" && line[j + 1] === "{") {
      const close = line.indexOf("}", j);
      if (close === -1) return null;
      j = close + 1;
    } else {
      j++;
    }
  } else {
    j++;
  }
  return j < n && line[j] === "'" ? j + 1 : null;
}

/** Strips real line comments (`//` to end of line) and block comments
 *  (slash-star to star-slash) from `line`, returning the remaining "code"
 *  — which still includes the text of any string/char literal, since
 *  that's exactly where prose lives; only a real comment is ever dropped.
 *  String-aware: a `//`/`/*` sitting inside a `"…"`, `` `…` ``, Rust `'…'`
 *  TS string, or a Rust raw string (`r"…"`, `r#"…"#`, any number of `#`s)
 *  never opens a comment, and a Rust char literal (`'x'`, `'\n'`) is told
 *  apart from a lifetime (`'a`, `'static`) so the latter never opens a
 *  string either. `state.mode` (`"code"`, `"block"`, `"dq"`, `"template"`,
 *  `"sq"` or `"raw"`, plus `state.rawHashes` for `"raw"`) carries an
 *  unterminated block comment, Rust `\`-continued string or multi-line
 *  template literal across the call for the next line; pass the same
 *  object for every line of a file, in order, starting from
 *  `{ mode: "code" }`. `lang` is `"ts"` or `"rust"` — it picks whether `'`
 *  opens a plain string or is resolved as a char literal/lifetime, and
 *  whether `` ` `` opens a template literal at all. A lightweight ratchet,
 *  not a full parser — nested `${…}` template interpolations are treated
 *  as ordinary template text, for instance, which is a non-issue for this
 *  guard since it only ever looks for a bare word. */
export function extractCode(line, state, lang) {
  let code = "";
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (state.mode === "block") {
      const end = line.indexOf("*/", i);
      if (end === -1) return code; // whole remainder is comment; stays in block
      i = end + 2;
      state.mode = "code";
      continue;
    }
    if (state.mode === "dq" || state.mode === "template" || state.mode === "sq") {
      const quoteChar = state.mode === "dq" ? '"' : state.mode === "template" ? "`" : "'";
      const start = i;
      let j = i;
      let closed = false;
      while (j < n) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === quoteChar) {
          j++;
          closed = true;
          break;
        }
        j++;
      }
      code += line.slice(start, Math.min(j, n));
      i = j;
      if (!closed) {
        // A TS quoted string can't span lines without a trailing `\`, so an
        // unclosed one here is a misread (a regex literal like /["\\]/g, a
        // backtick inside `${…}`, a stray apostrophe in JSX text): drop back to
        // code at the line end so the desync costs one line, not the file.
        if (lang === "ts" && state.mode !== "template" && !line.endsWith("\\")) {
          state.mode = "code";
        }
        return code; // otherwise the string stays open into the next line
      }
      state.mode = "code";
      continue;
    }
    if (state.mode === "raw") {
      const closer = '"' + "#".repeat(state.rawHashes);
      const end = line.indexOf(closer, i);
      if (end === -1) {
        code += line.slice(i);
        return code;
      }
      code += line.slice(i, end + closer.length);
      i = end + closer.length;
      state.mode = "code";
      continue;
    }
    // state.mode === "code"
    const c = line[i];
    if (c === "/" && line[i + 1] === "/") {
      return code; // rest of the line is a real line comment
    }
    if (c === "/" && line[i + 1] === "*") {
      state.mode = "block";
      i += 2;
      continue;
    }
    if (c === '"') {
      const hashes = lang === "rust" ? rawStringHashesBefore(line, i) : null;
      code += c;
      i += 1;
      if (hashes !== null) {
        state.mode = "raw";
        state.rawHashes = hashes;
      } else {
        state.mode = "dq";
      }
      continue;
    }
    if (c === "`" && lang !== "rust") {
      state.mode = "template";
      code += c;
      i += 1;
      continue;
    }
    if (c === "'") {
      if (lang === "rust") {
        const end = rustCharLiteralEnd(line, i);
        if (end !== null) {
          code += line.slice(i, end);
          i = end;
          continue;
        }
        // A lifetime (`'a`, `'static`, `'_`): plain code, never a string.
        let j = i + 1;
        while (j < n && /[A-Za-z0-9_]/.test(line[j])) j++;
        code += line.slice(i, j);
        i = j;
        continue;
      }
      // TS: an apostrophe right after a letter/digit reads as a
      // contraction in prose ("Ply's", "don't"), not a string opener —
      // a real string literal is never preceded by an identifier
      // character. Anything else opens a single-quoted string.
      const prev = i > 0 ? line[i - 1] : "";
      if (/[A-Za-z0-9_]/.test(prev)) {
        code += c;
        i += 1;
        continue;
      }
      state.mode = "sq";
      code += c;
      i += 1;
      continue;
    }
    code += c;
    i += 1;
  }
  return code;
}

/** Every standalone `Ply` (not `Plyloft`) in `code`, or `[]` when none. */
export function violationsInLine(code) {
  return [...code.matchAll(PLY_WORD)].map((m) => m[0]);
}

function listFiles(dir, exts) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listFiles(full, exts));
    } else if (exts.some((e) => entry.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

/** Scans one TS/TSX file's lines: comments (block-tracked), test-file
 *  exclusion, `WelcomeScreen.tsx` and the allowlist are all skipped.
 *  Returns `{ file, lineNo, text }[]`. */
export function scanTsFile(root, absPath) {
  const rel = relative(root, absPath).split(sep).join("/");
  if (SKIP_FILES.has(rel) || isTestFile(rel)) return [];
  const lines = readFileSync(absPath, "utf8").split("\n");
  const violations = [];
  const state = { mode: "code" };
  lines.forEach((line, i) => {
    const code = extractCode(line, state, "ts");
    if (isAllowed(rel, line)) return;
    if (violationsInLine(code).length > 0) {
      violations.push({ file: rel, lineNo: i + 1, text: line.trim() });
    }
  });
  return violations;
}

/** A whole-file test module pulled in elsewhere via
 *  `#[cfg(test)] #[path = "foo_tests.rs"] mod tests;` — the `#[cfg(test)]`
 *  that marks it lives in the *including* file, not this one, so the
 *  brace-tracking below never sees it. */
function isRustTestOnlyFile(rel) {
  return /_tests?\.rs$/.test(rel);
}

/** Scans one Rust file's lines: comments (block-tracked, so a multi-line
 *  string continuation with no leading `*`/`//` is still scanned as code),
 *  `#[cfg(test)] mod … { }` blocks (brace-tracked from the `mod` line that
 *  follows `#[cfg(test)]`), a whole-file test module (see
 *  `isRustTestOnlyFile`), and the allowlist are all skipped. Returns
 *  `{ file, lineNo, text }[]`. */
export function scanRustFile(root, absPath) {
  const rel = relative(root, absPath).split(sep).join("/");
  if (isRustTestOnlyFile(rel)) return [];
  const lines = readFileSync(absPath, "utf8").split("\n");
  const violations = [];
  let pendingTestAttr = false;
  let inTestModule = false;
  let depth = 0;
  let testEnterDepth = null;
  const state = { mode: "code" };
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    // `#[cfg(test)]` and its combinators (`all(test, unix)`, `all(test,
    // windows)`, …) all gate a `mod tests { }`; `cfg(not(test))` gates the
    // opposite (real, non-test code) and must not be treated as one.
    if (
      !inTestModule &&
      /^#\[cfg\(.*\btest\b.*\)\]$/.test(trimmed) &&
      !trimmed.startsWith("#[cfg(not(")
    ) {
      pendingTestAttr = true;
    } else if (pendingTestAttr) {
      if (/^(pub(\(.*\))?\s+)?mod\s+\w+\s*\{/.test(trimmed)) {
        inTestModule = true;
        testEnterDepth = depth;
      }
      pendingTestAttr = false;
    }

    const code = extractCode(line, state, "rust");
    const skip = inTestModule || isAllowed(rel, line);
    if (!skip && violationsInLine(code).length > 0) {
      violations.push({ file: rel, lineNo: i + 1, text: trimmed });
    }

    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    if (inTestModule && depth <= testEnterDepth) {
      inTestModule = false;
      testEnterDepth = null;
    }
  });
  return violations;
}

/** index.html: strips `<!-- ... -->` comments (block-tracked the same way
 *  as the block comments above) and checks what's left. One small file, so
 *  no allowlist or test-file exclusion is wired up for it. */
export function scanHtmlFile(root, absPath) {
  const rel = relative(root, absPath).split(sep).join("/");
  const lines = readFileSync(absPath, "utf8").split("\n");
  const violations = [];
  const state = { inBlock: false };
  lines.forEach((line, i) => {
    let code = "";
    let idx = 0;
    while (idx < line.length) {
      if (state.inBlock) {
        const end = line.indexOf("-->", idx);
        if (end === -1) return;
        idx = end + 3;
        state.inBlock = false;
        continue;
      }
      const start = line.indexOf("<!--", idx);
      if (start === -1) {
        code += line.slice(idx);
        break;
      }
      code += line.slice(idx, start);
      idx = start + 4;
      state.inBlock = true;
    }
    if (violationsInLine(code).length > 0) {
      violations.push({ file: rel, lineNo: i + 1, text: line.trim() });
    }
  });
  return violations;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The frozen tokens: fails loudly (with the literal expectation) rather
 *  than silently letting a rename touch what must not move. */
export function checkFrozenTokens(root) {
  const errors = [];
  const conf = readJson(join(root, "src-tauri/tauri.conf.json"));
  if (conf.productName !== "Plyloft") {
    errors.push(`tauri.conf.json productName is "${conf.productName}", expected "Plyloft"`);
  }
  if (conf.identifier !== "com.mbadv.ply") {
    errors.push(`tauri.conf.json identifier is "${conf.identifier}", expected "com.mbadv.ply"`);
  }
  const endpoints = conf.plugins?.updater?.endpoints ?? [];
  if (!endpoints.some((e) => e.includes("ply-releases"))) {
    errors.push(`tauri.conf.json updater endpoints do not mention "ply-releases": ${JSON.stringify(endpoints)}`);
  }
  const plist = readFileSync(join(root, "src-tauri/Info.plist"), "utf8");
  if (!/<key>CFBundleName<\/key>\s*<string>Plyloft<\/string>/.test(plist)) {
    errors.push("Info.plist has no CFBundleName = Plyloft");
  }
  return errors;
}

/** `src-tauri/crates/*\/src/**\/*.rs` — the bundled sidecar/library crates
 *  (ply-mcp, ply-collab, ply-memory), read by agents same as anything else
 *  under src-tauri/src. */
function crateRustFiles(root) {
  const cratesDir = join(root, "src-tauri/crates");
  if (!existsSync(cratesDir)) return [];
  const out = [];
  for (const entry of readdirSync(cratesDir)) {
    const srcDir = join(cratesDir, entry, "src");
    if (existsSync(srcDir) && statSync(srcDir).isDirectory()) {
      out.push(...listFiles(srcDir, [".rs"]));
    }
  }
  return out;
}

function listFilesIfPresent(dir, exts) {
  return existsSync(dir) ? listFiles(dir, exts) : [];
}

export function run(root) {
  const tsFiles = listFilesIfPresent(join(root, "src"), [".ts", ".tsx"]);
  const rsFiles = [
    ...listFilesIfPresent(join(root, "src-tauri/src"), [".rs"]),
    ...crateRustFiles(root),
  ];
  const htmlFile = join(root, "index.html");

  const violations = [
    ...tsFiles.flatMap((f) => scanTsFile(root, f)),
    ...rsFiles.flatMap((f) => scanRustFile(root, f)),
    ...(existsSync(htmlFile) ? scanHtmlFile(root, htmlFile) : []),
  ];
  const tokenErrors = checkFrozenTokens(root);

  return {
    violations,
    tokenErrors,
    scanned: tsFiles.length + rsFiles.length + (existsSync(htmlFile) ? 1 : 0),
  };
}

function main() {
  const args = process.argv.slice(2);
  const rootFlagIdx = args.indexOf("--root");
  const root = rootFlagIdx >= 0 ? args[rootFlagIdx + 1] : process.cwd();

  const { violations, tokenErrors, scanned } = run(root);

  if (violations.length > 0) {
    console.error(`product-name-check: ${violations.length} standalone "Ply" left in prose (scanned ${scanned} files):`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.lineNo}: ${v.text}`);
    }
  }
  if (tokenErrors.length > 0) {
    console.error("product-name-check: a frozen token moved:");
    for (const e of tokenErrors) console.error(`  ${e}`);
  }
  if (violations.length > 0 || tokenErrors.length > 0) {
    process.exit(1);
  }
  console.log(`product-name-check: pass (${scanned} files scanned, 0 stray "Ply", tokens intact)`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main();
}
