#!/usr/bin/env node
// Tests for scripts/ipc-unused-check.mjs, on throwaway roots; the last test
// reads the real tree and pins that its allowlist holds nothing stale.
//
//     node scripts/ipc-unused-check.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registeredCommands, ipcSegments, invokedStrings, stripComments, run } from "./ipc-unused-check.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function write(root, rel, content) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

test("reads every generate_handler list, without comments or cfg attributes", () => {
  const lib = `
    .invoke_handler(tauri::generate_handler![
        app_quit,
        // old_one,
        commands::card_get,
        #[cfg(debug_assertions)]
        crate::dev::dev_only,
    ])
    x.invoke_handler(tauri::generate_handler![crate::commands::second]);`;
  assert.deepEqual([...registeredCommands(lib)].sort(), ["app_quit", "card_get", "dev_only", "second"]);
});

test("cuts ipc.ts at each top-level declaration", () => {
  const segs = ipcSegments(`import x;\nexport function a() {\n  return invoke("a_cmd");\n}\nexport interface B {}\n`);
  assert.deepEqual(segs.map((s) => s.name), [null, "a", "B"]);
});

test("a wrapper nothing uses does not keep its command alive", () => {
  const ipc = [
    `export function used() { return invoke("used_cmd"); }`,
    `export function dead() { return invoke("dead_cmd"); }`,
    `export function inner() { return invoke("inner_cmd"); }`,
    `export function outer() { return inner(); }`,
  ].join("\n");
  const invoked = invokedStrings(ipc, [`import { used, outer } from "../ipc"; used(); outer(); invoke("direct_cmd");`]);
  assert.ok(invoked.has("used_cmd"));
  assert.ok(invoked.has("inner_cmd"), "used by another ipc.ts export");
  assert.ok(invoked.has("direct_cmd"), "invoked outside ipc.ts");
  assert.ok(!invoked.has("dead_cmd"));
});

test("a name in a comment is not an invocation, and a URL's // is not a comment", () => {
  assert.equal(stripComments(`a(); // \`gone_cmd\` stays\nb("https://x.y/z"); /* "also_gone" */ c();`).includes("gone"), false);
  assert.ok(stripComments(`b("https://x.y/z");`).includes("https://x.y/z"));
  const ipc = [
    `export function live() { return invoke("live_cmd"); }`,
    `/** inverse of \`dead\` */`,
    `export function dead() { return invoke("dead_cmd"); }`,
  ].join("\n");
  const invoked = invokedStrings(ipc, [`// \`dead\` and "note_cmd" in a comment\nlive(); /* dead() */`]);
  assert.ok(invoked.has("live_cmd"));
  assert.ok(!invoked.has("dead_cmd"), "a wrapper named only in comments is dead");
  assert.ok(!invoked.has("note_cmd"));
});

test("reports unused commands and stale allowlist entries; tests don't count", () => {
  const root = mkdtempSync(join(tmpdir(), "ipc-unused-check-test."));
  try {
    write(root, "src-tauri/src/lib.rs", "generate_handler![a, b, c, kept, gone_kept])");
    write(root, "src/ipc.ts", `export function aa() { return invoke("a"); }\nexport function bb() { return invoke("b"); }\n`);
    write(root, "src/App.tsx", `aa(); invoke("kept_but_used");`);
    write(root, "src/test/x.test.tsx", `bb(); invoke("c");`);
    write(root, "src/lib/y.test.ts", `invoke("c");`);
    write(root, "scripts/ipc-unused-allowlist.json", JSON.stringify({ kept: "why", gone: "removed", gone_kept: "" }));
    const out = run(root);
    assert.equal(out.registered, 5);
    assert.deepEqual(out.unused, ["b", "c"]);
    assert.deepEqual(out.stale, ["gone", "gone_kept"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real tree: no stale allowlist entry", () => {
  const out = run(REPO_ROOT);
  assert.ok(out.registered > 400, `only ${out.registered} commands found`);
  assert.deepEqual(out.stale, [], "take these out of scripts/ipc-unused-allowlist.json");
});

console.log(`ipc-unused-check tests: ${passed} passed`);
