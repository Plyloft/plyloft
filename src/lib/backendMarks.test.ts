// 1.176.0 seams: the backend's three typed marks, read and stripped in one
// place, and the same prefixes as the Rust side.
// Run: node --experimental-strip-types src/lib/backendMarks.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BACKEND_MARK_PREFIXES, PATH_GONE_PREFIX, backendMarkTool, backendMarks, markedPathGone, showBackendText } from "./backendMarks.ts";

// The pair: each prefix is the Rust constant (`cli_fresh.rs`).
const rust = readFileSync(new URL("../../src-tauri/src/cli_fresh.rs", import.meta.url), "utf8");
for (const [name, prefix] of [
  ["UNAVAILABLE_PREFIX", BACKEND_MARK_PREFIXES.unavailable],
  ["NOT_STARTING_PREFIX", BACKEND_MARK_PREFIXES.notStarting],
  ["UPDATE_REFUSED_PREFIX", BACKEND_MARK_PREFIXES.updateRefused],
] as const) {
  assert.ok(rust.includes(`${name}: &str = "${prefix}"`), `${name} is ${prefix}`);
}

const gone = 'PLY_CLI_UNAVAILABLE_V1:{"tool":"codex","was":"/opt/homebrew/bin/codex"}\ncodex: not found in PATH.';
const broken = 'PLY_CLI_NOT_STARTING_V1:{"tool":"claude"}\nClaude Code is installed at /x but doesn\'t start.';
const refused = 'PLY_CLI_UPDATE_REFUSED_V1:{"tool":"codex"}\nPlyloft can\'t update this Codex: …';

assert.deepEqual(backendMarks(gone), [{ kind: "unavailable", tool: "codex" }]);
assert.deepEqual(backendMarks(new Error(broken)), [{ kind: "notStarting", tool: "claude" }]);
assert.equal(backendMarkTool(refused), "codex");
assert.equal(backendMarkTool(refused, "notStarting"), null);
assert.equal(backendMarkTool(`Swarm ended: scout run failed: ${broken}`), "claude", "wrapped, it is found inside");
assert.equal(showBackendText(gone), "codex: not found in PATH.");
assert.equal(showBackendText(`Its Builder couldn't start: ${broken}`), "Its Builder couldn't start: Claude Code is installed at /x but doesn't start.");
assert.equal(showBackendText(`${refused}\r\nmore`).includes("PLY_CLI_"), false);
// A broken mark names nothing but never shows either.
assert.equal(backendMarkTool('PLY_CLI_NOT_STARTING_V1:{oops}\nx'), null);
assert.equal(showBackendText('PLY_CLI_NOT_STARTING_V1:{oops}\nx'), "x");
assert.equal(showBackendText(null), null);
assert.equal(showBackendText("plain words"), "plain words");

// 1.176.3: the "folder is not there" mark (`path_gone.rs`): no tool, never shown.
const pathGone = readFileSync(new URL("../../src-tauri/src/path_gone.rs", import.meta.url), "utf8");
assert.ok(pathGone.includes(`PATH_GONE_PREFIX: &str = "${PATH_GONE_PREFIX}"`), "PATH_GONE_PREFIX is the Rust constant");
const folder = "PLY_PATH_GONE_V1:{}\nworkspace cwd does not exist: /p";
assert.equal(markedPathGone(folder), true);
assert.equal(markedPathGone(new Error(folder)), true);
assert.equal(markedPathGone("workspace cwd does not exist: /p"), false);
assert.deepEqual(backendMarks(folder), []);
assert.equal(showBackendText(folder), "workspace cwd does not exist: /p");

console.log("backendMarks: ok");
