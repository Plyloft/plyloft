// UX language card 8 (GH #103): when a shell tile is ready to be typed into,
// what the bytes are, and the contract that Diagnostics' tile goes through the
// app's one PTY spawn path. Run with:
//
//     node --experimental-strip-types src/lib/tileCommand.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROMPT_GRACE_MS, commandBytes, readyToType } from "./tileCommand.ts";

// ── The wait ─────────────────────────────────────────────────────────────

// Nothing is typed before the PTY exists: `writeToTilePty` drops a write on a
// tile with no `ptyId` and says nothing, which is how a command sent too early
// vanishes without a trace.
assert.equal(readyToType(null, 0), false);
assert.equal(readyToType({ ptyId: null }, 0), false);
assert.equal(readyToType({ ptyId: null }, 99999), false, "never, without a PTY");

// The first byte of output is the prompt.
assert.equal(readyToType({ ptyId: "p1" }, 0), false);
assert.equal(readyToType({ ptyId: "p1", lastOutputAt: 1 }, 0), true);

// A shell that prints no banner produces no first byte, so the wait ends by
// itself and the bytes go into the tty's input queue.
assert.equal(readyToType({ ptyId: "p1" }, PROMPT_GRACE_MS - 1), false);
assert.equal(readyToType({ ptyId: "p1" }, PROMPT_GRACE_MS), true);

// ── The bytes ────────────────────────────────────────────────────────────

const bytes = commandBytes(" gh auth login ");
assert.equal(new TextDecoder().decode(bytes), "gh auth login\r");
// Not a bracketed paste: the shell being complained about may be the macOS
// /bin/bash 3.2 that has no paste mode, where the markers are typed literally.
assert.ok(!new TextDecoder().decode(bytes).includes("\u001b[200~"));

// ── The spawn contract ───────────────────────────────────────────────────
// A new place that opens a tile with something running is a new place a PTY
// comes from, and the hard rules say every PTY goes through `pty.rs::spawn`
// with the cached PATH and lands in `PtyRegistry` so `ExitRequested` kills it.
// This file keeps that true by owning no spawn at all: it asks `tileStore` for
// an ordinary shell tile, and `Terminal` spawns it exactly as ⌘T does.
const runnerText = readFileSync(new URL("./runInTile.ts", import.meta.url), "utf8");
// The code, without the comments: the file's own doc names `pty.rs::spawn` to
// say what it does *not* do.
const runner = runnerText.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
assert.match(runner, /addShellTile\(/, "the tile is an ordinary shell tile");
assert.match(runner, /writeToTilePty\(/, "the command is typed into it");
for (const forbidden of [
  "ptySpawn",
  "pty_spawn",
  "pty_kill",
  "ptyKill",
  "ptyWrite",
  "invoke(",
  "<Terminal",
]) {
  assert.ok(
    !runner.includes(forbidden),
    `runInTile.ts must not reach past the tile store: found "${forbidden}"`,
  );
}
// And the one place that does spawn still injects the cached PATH and
// registers the child, so the tile this opens is killed on quit like any
// other. Read from Rust so a change there fails here.
const pty = readFileSync(new URL("../../src-tauri/src/pty.rs", import.meta.url), "utf8");
assert.match(pty, /let env = shell_env::get\(\);/, "the cached PATH is read");
assert.match(pty, /command\.env\("PATH", &env\.path\)/, "and injected");
assert.match(pty, /self\.register\(id\.clone\(\), session\)/, "the child is registered");
const lib = readFileSync(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8");
// v1.154.1 (F1): the cleanup is one function run on ExitRequested and on
// Exit (Cmd-Q on the Mac raises only Exit); it kills the PTY registry.
const cleanup = lib.slice(lib.indexOf("fn run_exit_cleanup("));
assert.match(
  cleanup.slice(0, 8000),
  /PtyRegistry>\(\)[\s\S]{0,200}kill_all\(\)/,
  "the exit cleanup kills the PTY registry",
);
assert.match(lib, /RunEvent::ExitRequested \{ \.\. \} => run_exit_cleanup\(/, "ExitRequested runs it");
assert.match(lib, /RunEvent::Exit => run_exit_cleanup\(/, "and so does Exit (Cmd-Q)");

// ── Diagnostics is the only caller, and it names a workspace ─────────────
const page = readFileSync(
  new URL("../components/settings/DiagnosticsPage.tsx", import.meta.url),
  "utf8",
);
assert.match(page, /runInShellTile\(/, "Diagnostics opens the tile through it");
assert.match(page, /workspaceId/, "in the active workspace");

console.log("tileCommand: all assertions passed");
