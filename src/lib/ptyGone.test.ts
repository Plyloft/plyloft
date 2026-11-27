// Walk 2026-09-30: closing a Claude tile logged "[ERROR] unhandled rejection:
// pty not found" — the xterm's blur and the grid's reflow wrote to and resized
// a PTY Plyloft had just killed. Run with:
//
//     node --experimental-strip-types src/lib/ptyGone.test.ts

import assert from "node:assert/strict";
import { guardPty, isPtyClosing, isPtyGone, markPtyClosing, PTY_GONE } from "./ptyGone.ts";

const unhandled: unknown[] = [];
process.on("unhandledRejection", (reason) => unhandled.push(reason));
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** Rust's registry as `pty.rs` answers write/resize: gone once killed. */
function fakeRust() {
  const live = new Set<string>();
  const calls: string[] = [];
  const answer = (id: string, what: string) => {
    calls.push(`${what} ${id}`);
    return live.has(id) ? Promise.resolve() : Promise.reject(PTY_GONE);
  };
  return {
    live,
    calls,
    kill(id: string) {
      markPtyClosing(id); // what `ipc.ptyKill` does before its invoke
      live.delete(id);
    },
    write: (id: string, _data: Uint8Array) => answer(id, "write"),
    resize: (id: string, _cols: number, _rows: number) => answer(id, "resize"),
  };
}

// ── The words ────────────────────────────────────────────────────────────
assert.equal(isPtyGone("pty not found"), true);
assert.equal(isPtyGone(new Error("pty not found")), true);
assert.equal(isPtyGone("write: Broken pipe"), false);

// ── Close the tile, then the blur's write and the reflow's resize ────────
{
  const rust = fakeRust();
  rust.live.add("claude-1");
  const pty = guardPty("claude-1", rust);
  pty.write(new Uint8Array([1]));
  pty.resize(80, 24);
  assert.deepEqual(rust.calls, ["write claude-1", "resize claude-1"]);

  rust.kill("claude-1");
  assert.equal(isPtyClosing("claude-1"), true);
  assert.equal(pty.open, false);
  pty.write(new TextEncoder().encode("\x1b[O"));
  pty.resize(100, 30);
  assert.deepEqual(rust.calls, ["write claude-1", "resize claude-1"], "nothing reaches a killed PTY");
  await settle();
  assert.deepEqual(unhandled, []);
}

// ── The race: a call already sent when the session went ──────────────────
{
  const rust = fakeRust();
  const pty = guardPty("claude-2", rust); // exited on its own; Rust dropped it
  pty.resize(80, 24);
  pty.write(new Uint8Array([2]));
  await settle();
  assert.deepEqual(unhandled, [], "a late \"pty not found\" is not an unhandled rejection");
  assert.equal(pty.open, false, "and the terminal stops calling");
  pty.write(new Uint8Array([3]));
  assert.equal(rust.calls.length, 2);
}

// ── The exit event, or the terminal disposed ─────────────────────────────
{
  const rust = fakeRust();
  rust.live.add("shell-1");
  const pty = guardPty("shell-1", rust);
  pty.close();
  pty.write(new Uint8Array([4]));
  pty.resize(80, 24);
  assert.deepEqual(rust.calls, []);
}

// ── Any other failure is still reported, not swallowed ───────────────────
{
  const pty = guardPty("shell-2", {
    write: () => Promise.reject(new Error("write: Broken pipe")),
    resize: () => Promise.resolve(),
  });
  pty.write(new Uint8Array([5]));
  await settle();
  assert.equal(unhandled.length, 1);
  assert.match(String(unhandled[0]), /Broken pipe/);
  assert.equal(pty.open, true, "a different error does not close the PTY");
}

console.log("ptyGone: close-then-write/resize contract passed");
