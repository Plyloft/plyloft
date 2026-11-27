// Repository contract: no synchronous native dialogs in src/.
//
// Under Tauri 2, tauri-plugin-dialog replaces `window.confirm` with an
// async function, so `if (confirm(...))` tests a Promise — always truthy —
// and every destructive action ran without asking (v1.119.0, Ply.log:
// "Command plugin:dialog|confirm not allowed by ACL"). `window.alert` is
// replaced the same way.
//
// GH #281: the only way to ask is `confirmSheet` from
// src/store/confirmStore.ts, awaited — the confirm Sheet, drawn by the one
// ConfirmSheetHost in the App. The native plugin confirm (a macOS alert with
// the app icon) is gone: `confirmDialog` and plugin-dialog's confirm, ask and
// message are forbidden everywhere in src/.
//
// Run: node --experimental-strip-types src/lib/nativeDialogs.test.ts

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function it(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${name}: ${(e as Error).message}`);
  }
}

function eq<T>(actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`expected ${b}, got ${a}`);
}

/** Blank comments and the contents of string/template literals (keeping
 *  newlines and offsets), so only code is scanned. */
function codeOnly(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") j++;
        else if (c !== "`" && src[j] === "\n") break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** Index just past the `)` that closes the `(` at `open`, or -1. */
function closeParen(code: string, open: number): number {
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    if (code[k] === "(") depth++;
    else if (code[k] === ")" && --depth === 0) return k + 1;
  }
  return -1;
}

const BARE_CALL = /(?<![\w$.])(confirm|alert)\s*\(/g;
const GLOBAL_MEMBER = /\b(window|globalThis|self)\s*\.\s*(confirm|alert)\b/g;
const HELPER_CALL = /\bconfirmSheet\s*\(/g;
const RETIRED_CALL = /\bconfirmDialog\s*\(/g;
const PLUGIN_IMPORT =
  /import\s*(type\s+)?\{([^}]*)\}\s*from\s*["']@tauri-apps\/plugin-dialog["']/g;

/** Violations in one source file, as "line N: why". */
function violations(src: string): string[] {
  const code = codeOnly(src);
  const found: string[] = [];
  const at = (idx: number, why: string) =>
    found.push(`line ${code.slice(0, idx).split("\n").length}: ${why}`);

  for (const m of code.matchAll(BARE_CALL)) {
    at(m.index, `bare ${m[1]}() — use await confirmSheet(...)`);
  }
  for (const m of code.matchAll(GLOBAL_MEMBER)) {
    at(m.index, `${m[1]}.${m[2]} — use await confirmSheet(...)`);
  }
  // GH #281: the plugin's own yes/no dialogs are native alerts — nowhere.
  // Imports are matched on the raw source: codeOnly blanks the module
  // specifier.
  for (const m of src.matchAll(PLUGIN_IMPORT)) {
    const names = m[2]
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter((s) => s === "confirm" || s === "ask" || s === "message");
    if (names.length > 0) {
      at(m.index, `imports ${names.join(", ")} from plugin-dialog — use confirmSheet`);
    }
  }
  for (const m of code.matchAll(RETIRED_CALL)) {
    const before = code.slice(0, m.index);
    if (/\bfunction\s+$/.test(before)) continue;
    at(m.index, "confirmDialog(...) — a native alert; use await confirmSheet(...)");
  }
  // confirmSheet returns a Promise: it must be awaited, or its result
  // consumed with .then. `if (confirmDialog(...))` was the original bug.
  for (const m of code.matchAll(HELPER_CALL)) {
    const before = code.slice(0, m.index);
    if (/\bfunction\s+$/.test(before) || /\bimport\s*\{[^}]*$/.test(before)) continue;
    if (/\bawait\s*\(?\s*$/.test(before)) continue;
    const end = closeParen(code, m.index + m[0].length - 1);
    if (end !== -1 && /^\s*\.\s*then\s*\(/.test(code.slice(end))) continue;
    at(m.index, "confirmSheet(...) not awaited — its Promise is always truthy");
  }
  return found;
}

// ── the scanner itself ────────────────────────────────────────────────

it("flags bare confirm/alert and window.confirm", () => {
  eq(violations("if (confirm('x')) go();").length, 1);
  eq(violations("alert('x');").length, 1);
  eq(violations("const ok = window.confirm('x');").length, 1);
  eq(violations("globalThis.alert('x');").length, 1);
  eq(violations("const c = window.confirm;").length, 1);
});

it("flags an un-awaited confirmSheet", () => {
  eq(violations("if (confirmSheet({ title: 'x' })) go();").length, 1);
  eq(violations("const ok = confirmSheet({ title: 'x' }); if (!ok) return;").length, 1);
  eq(violations("void confirmSheet({ title: 'x' });").length, 1);
});

it("flags the retired native confirmDialog, even awaited (GH #281)", () => {
  eq(violations("if (await confirmDialog('x')) go();").length, 1);
});

it("flags confirm/ask/message imported from plugin-dialog", () => {
  eq(
    violations('import { open, confirm } from "@tauri-apps/plugin-dialog";')
      .length,
    1,
  );
  eq(
    violations('import { ask as a } from "@tauri-apps/plugin-dialog";').length,
    1,
  );
  eq(
    violations('import { open, save } from "@tauri-apps/plugin-dialog";')
      .length,
    0,
  );
});

it("accepts awaited and .then-consumed confirmSheet", () => {
  eq(violations("if (await confirmSheet({ title: 'x' })) go();"), []);
  eq(violations("if (!(await confirmSheet({ title: `a (b) ${c}`, k: 1 }))) return;"), []);
  eq(violations("void confirmSheet({ title: 'x (y)' }).then((ok) => ok && go());"), []);
  eq(violations('import { confirmSheet } from "../store/confirmStore";'), []);
  eq(violations("export function confirmSheet(request: R): Promise<boolean> {"), []);
});

it("ignores comments, strings, methods and look-alike names", () => {
  eq(violations("// native `window.confirm()` is auto-accepted"), []);
  eq(violations("/* the original used alert() here */"), []);
  eq(violations("const s = 'do not confirm(this)';"), []);
  eq(violations("onConfirm(tpl); props.confirm(x); setAlert(1);"), []);
  eq(violations("const url = 'https://x'; go();"), []);
});

// ── the repository ────────────────────────────────────────────────────

const SRC = fileURLToPath(new URL("../", import.meta.url));
const HELPER = join(SRC, "store", "confirmStore.ts");
const SELF = fileURLToPath(import.meta.url);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && path !== SELF ? [path] : [];
  });
}

it("src/ has no synchronous native dialog and no un-awaited confirmDialog", () => {
  const files = sources(SRC);
  if (files.length < 50) throw new Error(`scanned only ${files.length} files`);
  const bad = files.flatMap((path) =>
    violations(readFileSync(path, "utf8")).map(
      (v) => `${relative(SRC, path)} ${v}`,
    ),
  );
  if (bad.length > 0) throw new Error(`\n  ${bad.join("\n  ")}`);
});

it("confirmSheet is the one way to ask, fails closed, and has one host (GH #281)", () => {
  const helper = readFileSync(HELPER, "utf8");
  if (!/export function confirmSheet\(/.test(helper)) {
    throw new Error("confirmStore.ts no longer exports confirmSheet");
  }
  // No host on screen: the answer is Cancel, and the guarded action waits.
  if (!/hosts === 0\)[\s\S]{0,160}Promise\.resolve\(false\)/.test(helper)) {
    throw new Error("confirmSheet no longer fails closed without a host");
  }
  if (existsSync(join(SRC, "lib", "confirmDialog.ts"))) {
    throw new Error("src/lib/confirmDialog.ts (the native alert) is back");
  }
  const hosts = sources(SRC).filter((path) => /<ConfirmSheetHost\s*\/>/.test(readFileSync(path, "utf8")));
  eq(hosts.map((path) => relative(SRC, path).split("\\").join("/")).sort(), ["App.tsx", "test/render.tsx"]);
});

it("the capability grants the command the plugin's confirm invokes", () => {
  // plugin-dialog 2.7.0's JS confirm() calls plugin:dialog|message.
  const cap = JSON.parse(
    readFileSync(
      new URL("../../src-tauri/capabilities/default.json", import.meta.url),
      "utf8",
    ),
  ) as { permissions: string[] };
  if (!cap.permissions.includes("dialog:allow-message")) {
    throw new Error("src-tauri/capabilities/default.json lacks dialog:allow-message");
  }
});

if (failed > 0) {
  console.error(`nativeDialogs: ${failed} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`nativeDialogs: ${passed} passed`);
