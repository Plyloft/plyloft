#!/usr/bin/env node
// Tests for scripts/product-name-check.mjs, on throwaway roots (nothing here
// reads or writes the repository except the final call against the real
// tree, which pins today's actual rename).
//
//     node scripts/product-name-check.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  violationsInLine,
  extractCode,
  scanTsFile,
  scanRustFile,
  scanHtmlFile,
  checkFrozenTokens,
  run,
} from "./product-name-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "product-name-check-test."));
}

function write(root, rel, content) {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

const cleanups = [];
process.on("exit", () => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

// ── extractCode: comments ────────────────────────────────────────────────

{
  const state = { mode: "code" };
  assert.equal(extractCode('const s = "Welcome to Ply";', state, "ts"), 'const s = "Welcome to Ply";');
  assert.equal(extractCode("// Ply used to do this differently", state, "ts"), "");
  assert.equal(extractCode("code(); // trailing Ply comment", state, "ts"), "code(); ");
}

// A `/* ... */` comment stays out even when it doesn't start with `*`.
{
  const state = { mode: "code" };
  assert.equal(extractCode("before /* Ply note */ after", state, "ts"), "before  after");
  assert.equal(state.mode, "code");
}

// A block comment left open at end of line carries into the next line
// (bare "Ply", no leading `*` or `//`) and closes wherever `*/` lands.
{
  const state = { mode: "code" };
  assert.equal(extractCode("/* This describes", state, "ts"), "");
  assert.equal(state.mode, "block");
  assert.equal(extractCode("   Ply's behavior */ real code here", state, "ts"), " real code here");
  assert.equal(state.mode, "code");
}

// Real multi-line block comments are still skipped end to end.
{
  const state = { mode: "code" };
  const lines = ["/**", " * Ply used to work differently.", " * Still true on this line.", " */", "real();"];
  const out = lines.map((l) => extractCode(l, state, "ts"));
  assert.deepEqual(out, ["", "", "", "", "real();"]);
}

// ── extractCode: strings don't leak `//`/`/*` into comment state ───────────

// A double-quoted string containing `/*` (glob-like patterns, e.g. the real
// `worktrees.rs` refspec) does not open a block comment — a later line is
// still scanned as code.
{
  const state = { mode: "code" };
  assert.equal(
    extractCode('let pat = "+refs/heads/*:refs/remotes/origin/*";', state, "rust"),
    'let pat = "+refs/heads/*:refs/remotes/origin/*";',
  );
  assert.equal(state.mode, "code");
  assert.deepEqual(violationsInLine(extractCode('"Ply could not find the folder."', state, "rust")), ["Ply"]);
}

// `format!("/{rel}/*")` then a later "Ply" line: the embedded `/*` must not
// blind the guard for the rest of the file.
{
  const root = tempRoot();
  cleanups.push(root);
  write(
    root,
    "src-tauri/src/glob.rs",
    [
      'let pattern = format!("/{rel}/*");',
      "let x = 1;",
      '"Ply could not find the folder."',
    ].join("\n"),
  );
  const violations = scanRustFile(root, join(root, "src-tauri/src/glob.rs"));
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.equal(violations[0].lineNo, 3);
}

// A TS regex literal with a quote in it (the real `src/test/setup.ts`
// `/["\\]/g`) desyncs the lexer for at most that line: TS quoted strings
// can't span lines, so the next line is code again and a later comment and
// "Ply" string are each read for what they are.
{
  const state = { mode: "code" };
  extractCode("s.replace(/[\"\\\\]/g, '');", state, "ts");
  assert.equal(state.mode, "code");
  assert.equal(extractCode("// Ply comment", state, "ts"), "");
  extractCode('const g = "a/*b";', state, "ts");
  assert.equal(state.mode, "code");
  assert.deepEqual(violationsInLine(extractCode('const s = "Ply";', state, "ts")), ["Ply"]);
}

// A stray apostrophe in JSX text (`the 'Board page`) doesn't carry past its line.
{
  const state = { mode: "code" };
  extractCode("  Open the 'Board page", state, "ts");
  assert.equal(state.mode, "code");
}

// A `//` inside a URL string does not truncate the line as a comment.
{
  const state = { mode: "code" };
  const code = extractCode('let url = "https://x/Ply";', state, "rust");
  assert.deepEqual(violationsInLine(code), ["Ply"]);
}

// A Rust char literal (`'/'`) is not mistaken for a lifetime or a string
// opener, and doesn't blind a later "Ply" line.
{
  const root = tempRoot();
  cleanups.push(root);
  write(root, "src-tauri/src/charlit.rs", ["let sep = '/';", '"Ply"'].join("\n"));
  const violations = scanRustFile(root, join(root, "src-tauri/src/charlit.rs"));
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.equal(violations[0].lineNo, 2);
}

// A lifetime (`'a`) never opens a char literal or a string.
{
  const state = { mode: "code" };
  const code = extractCode("fn f<'a>(x: &'a str) -> &'a str { x }", state, "rust");
  assert.equal(state.mode, "code");
  assert.equal(code, "fn f<'a>(x: &'a str) -> &'a str { x }");
}

// A `/*` inside a TS template literal doesn't blind a later "Ply" line.
{
  const root = tempRoot();
  cleanups.push(root);
  write(
    root,
    "src/lib/tmpl.ts",
    ["const s = `weird /* not a comment */ text`;", 'const t = "Ply";'].join("\n"),
  );
  const violations = scanTsFile(root, join(root, "src/lib/tmpl.ts"));
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.equal(violations[0].lineNo, 2);
}

// A Rust raw string containing `/*` doesn't blind a later "Ply" line.
{
  const root = tempRoot();
  cleanups.push(root);
  write(
    root,
    "src-tauri/src/rawstr.rs",
    ['let pat = r#"weird /* not a comment */ text"#;', '"Ply"'].join("\n"),
  );
  const violations = scanRustFile(root, join(root, "src-tauri/src/rawstr.rs"));
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.equal(violations[0].lineNo, 2);
}

// A multi-line string continuation (no comment marker at all) is code on
// every line — this is the Rust "multi-line string continuation" case.
{
  const state = { mode: "code" };
  assert.equal(extractCode('const long = "part one \\', state, "rust"), 'const long = "part one \\');
  assert.equal(state.mode, "dq");
  assert.equal(extractCode(' Ply keeps going here";', state, "rust"), ' Ply keeps going here";');
  assert.equal(state.mode, "code");
}

// A TS single-quoted string is tracked, but an apostrophe right after a
// letter reads as a contraction in prose ("Ply's"), not a string opener.
{
  const state = { mode: "code" };
  assert.equal(extractCode("const s = 'Welcome to Ply';", state, "ts"), "const s = 'Welcome to Ply';");
  assert.equal(state.mode, "code");
  const state2 = { mode: "code" };
  assert.equal(extractCode("return <p>outside Ply's brief</p>;", state2, "ts"), "return <p>outside Ply's brief</p>;");
  assert.equal(state2.mode, "code");
}

// A line starting with "* " that is really inside a template literal (not
// a doc-comment continuation) is scanned as code — no block was opened.
{
  const state = { mode: "code" };
  assert.equal(
    extractCode("* Ply bullet inside a template literal", state, "ts"),
    "* Ply bullet inside a template literal",
  );
}

// ── violationsInLine ─────────────────────────────────────────────────────

assert.deepEqual(violationsInLine('const s = "Welcome to Ply";'), ["Ply"]);
assert.deepEqual(violationsInLine('const s = "Welcome to Plyloft";'), []);
assert.deepEqual(violationsInLine("const Ply = 1;"), ["Ply"]);
assert.deepEqual(violationsInLine('"/Applications/Ply.app"'), ["Ply"]);

// ── scanTsFile ───────────────────────────────────────────────────────────

{
  const root = tempRoot();
  cleanups.push(root);
  write(root, "src/components/Widget.tsx", '  const title = "Welcome to Ply";\n');
  const violations = scanTsFile(root, join(root, "src/components/Widget.tsx"));
  assert.equal(violations.length, 1);
  assert.equal(violations[0].lineNo, 1);
}

// JSX bare text (no quotes) is caught by the widened whole-line scan.
{
  const root = tempRoot();
  cleanups.push(root);
  write(root, "src/components/Widget.tsx", "      return <h1>Welcome to Ply</h1>;\n");
  const violations = scanTsFile(root, join(root, "src/components/Widget.tsx"));
  assert.equal(violations.length, 1, JSON.stringify(violations));
}

// Comments never count, even doc-comments, even when a continuation line
// has no leading `*`.
{
  const root = tempRoot();
  cleanups.push(root);
  write(
    root,
    "src/lib/x.ts",
    [
      "// Ply used to do this differently",
      "/** Ply.",
      "    still Ply, still a comment. */",
      "export const x = 1;",
    ].join("\n"),
  );
  assert.deepEqual(scanTsFile(root, join(root, "src/lib/x.ts")), []);
}

// A `*.test.tsx` file is skipped outright, even with an unguarded "Ply".
{
  const root = tempRoot();
  cleanups.push(root);
  write(root, "src/test/thing.test.tsx", 'expect(x).toBe("Ply is running");\n');
  assert.deepEqual(scanTsFile(root, join(root, "src/test/thing.test.tsx")), []);
}

// A `*.test.ts` file is skipped outright too (same wholesale test-file rule).
{
  const root = tempRoot();
  cleanups.push(root);
  write(root, "src/lib/thing.test.ts", 'assert.equal(x, "Ply is running");\n');
  assert.deepEqual(scanTsFile(root, join(root, "src/lib/thing.test.ts")), []);
}

// WelcomeScreen.tsx is out of scope for this card.
{
  const root = tempRoot();
  cleanups.push(root);
  write(root, "src/components/WelcomeScreen.tsx", "Ply runs your projects.\n");
  assert.deepEqual(scanTsFile(root, join(root, "src/components/WelcomeScreen.tsx")), []);
}

// The allowlist protects an exact (file, substring) pair and nothing else.
{
  const root = tempRoot();
  cleanups.push(root);
  write(root, "src/lib/installedSelfCheck.ts", 'export const Q = "Ply diagnostics: P3-1 self-check";\n');
  assert.deepEqual(scanTsFile(root, join(root, "src/lib/installedSelfCheck.ts")), []);
}

// ── scanRustFile ─────────────────────────────────────────────────────────

{
  const root = tempRoot();
  cleanups.push(root);
  write(root, "src-tauri/src/x.rs", '    "resolve Ply executable".to_string();\n');
  const violations = scanRustFile(root, join(root, "src-tauri/src/x.rs"));
  assert.equal(violations.length, 1);
}

// A multi-line Rust string continuation (no leading `//`/`*`, just the raw
// continuation of a `\`-joined string literal) is scanned as code.
{
  const root = tempRoot();
  cleanups.push(root);
  write(
    root,
    "src-tauri/src/y.rs",
    [
      "pub const MSG: &str =",
      '    "Installing Ply from source is macOS-only for now: its install script builds \\',
      '     and installs the app. Nothing was changed.";',
    ].join("\n"),
  );
  const violations = scanRustFile(root, join(root, "src-tauri/src/y.rs"));
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.equal(violations[0].lineNo, 2);
}

// A `#[cfg(test)] mod tests { }` block is skipped entirely, brace-tracked
// past nested items, even when it holds a bare "Ply".
{
  const root = tempRoot();
  cleanups.push(root);
  write(
    root,
    "src-tauri/src/y2.rs",
    [
      'pub fn greet() -> &\'static str { "hello" }',
      "",
      "#[cfg(test)]",
      "mod tests {",
      "    #[test]",
      "    fn fixture() {",
      '        let name = "Ply";',
      "        assert_eq!(name, name);",
      "    }",
      "}",
      "",
      'const AFTER: &str = "Ply runs again after the module closes";',
      "",
    ].join("\n"),
  );
  const violations = scanRustFile(root, join(root, "src-tauri/src/y2.rs"));
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.match(violations[0].text, /AFTER/);
}

// An allowlisted Rust identifier (an enum variant, not prose) is protected —
// anchored to the whole trimmed line, so it doesn't also hide a real
// violation elsewhere in the same file that merely contains "Ply,".
{
  const root = tempRoot();
  cleanups.push(root);
  write(
    root,
    "src-tauri/src/proposals.rs",
    ["enum Scope {", "    Ply,", "}", '"Ply, this is not the enum variant"'].join("\n"),
  );
  const violations = scanRustFile(root, join(root, "src-tauri/src/proposals.rs"));
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.equal(violations[0].lineNo, 4);
}

// A whole file named `*_tests.rs` is skipped wholesale — its own
// `#[cfg(test)]` lives in the file that pulls it in via `#[path]`, not here.
{
  const root = tempRoot();
  cleanups.push(root);
  write(root, "src-tauri/src/workspace_definition_tests.rs", 'assert_eq!(def.name, "Ply");\n');
  assert.deepEqual(
    scanRustFile(root, join(root, "src-tauri/src/workspace_definition_tests.rs")),
    [],
  );
}

// ── scanHtmlFile ─────────────────────────────────────────────────────────

{
  const root = tempRoot();
  cleanups.push(root);
  write(root, "index.html", "<!doctype html>\n<title>Ply</title>\n");
  const violations = scanHtmlFile(root, join(root, "index.html"));
  assert.equal(violations.length, 1);
  assert.equal(violations[0].lineNo, 2);
}

{
  const root = tempRoot();
  cleanups.push(root);
  write(root, "index.html", "<!doctype html>\n<title>Plyloft</title>\n<!-- Ply, in a comment -->\n");
  assert.deepEqual(scanHtmlFile(root, join(root, "index.html")), []);
}

// ── checkFrozenTokens ────────────────────────────────────────────────────

{
  const root = tempRoot();
  cleanups.push(root);
  write(
    root,
    "src-tauri/tauri.conf.json",
    JSON.stringify({
      productName: "Plyloft",
      identifier: "com.mbadv.ply",
      plugins: { updater: { endpoints: ["https://example.com/ply-releases/latest.json"] } },
    }),
  );
  write(root, "src-tauri/Info.plist", "<dict><key>CFBundleName</key><string>Plyloft</string></dict>");
  assert.deepEqual(checkFrozenTokens(root), []);
}

{
  const root = tempRoot();
  cleanups.push(root);
  write(
    root,
    "src-tauri/tauri.conf.json",
    JSON.stringify({
      productName: "Ply",
      identifier: "com.mbadv.plyloft",
      plugins: { updater: { endpoints: ["https://example.com/plyloft-releases/latest.json"] } },
    }),
  );
  write(root, "src-tauri/Info.plist", "<dict></dict>");
  const errors = checkFrozenTokens(root);
  assert.equal(errors.length, 4, JSON.stringify(errors));
}

// ── crates scanning (src-tauri/crates/*/src/**/*.rs) ────────────────────

{
  const root = tempRoot();
  cleanups.push(root);
  write(
    root,
    "src-tauri/tauri.conf.json",
    JSON.stringify({
      productName: "Plyloft",
      identifier: "com.mbadv.ply",
      plugins: { updater: { endpoints: ["ply-releases"] } },
    }),
  );
  write(root, "src-tauri/Info.plist", "<dict><key>CFBundleName</key><string>Plyloft</string></dict>");
  write(root, "index.html", "<title>Plyloft</title>\n");
  write(
    root,
    "src-tauri/crates/ply-mcp/src/lib.rs",
    '    "description": "Search accepted Ply Knowledge in the current workspace.",\n',
  );
  const { violations } = run(root);
  assert.equal(violations.length, 1, JSON.stringify(violations));
  assert.match(violations[0].file, /crates\/ply-mcp\/src\/lib\.rs/);
}

// ── against the real tree ────────────────────────────────────────────────
// The rename this guard ships alongside must itself pass it.

{
  const { violations, tokenErrors } = run(REPO_ROOT);
  assert.deepEqual(violations, [], JSON.stringify(violations, null, 2));
  assert.deepEqual(tokenErrors, [], JSON.stringify(tokenErrors, null, 2));
}

console.log("product-name-check.test.mjs: all assertions passed");
