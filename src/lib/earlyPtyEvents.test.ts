// 1.176.0 R7: a tile's PTY events held until its spawn returned.
// Run: node --experimental-strip-types src/lib/earlyPtyEvents.test.ts
import assert from "node:assert/strict";
import { newPtyId, ptyEventGate, type PtyEvent } from "./earlyPtyEvents.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
const said = (events: PtyEvent[]) =>
  events.map((e) => (e.kind === "data" ? new TextDecoder().decode(e.data) : `exit ${e.code}`));

// Output and the exit before the spawn returned: held, then handed on in
// order, each once.
{
  const got: PtyEvent[] = [];
  const gate = ptyEventGate((e) => got.push(e));
  gate.push({ kind: "data", data: bytes("Error: ") });
  gate.push({ kind: "data", data: bytes("cli.js missing") });
  gate.push({ kind: "exit", code: 1 });
  assert.deepEqual(got, []);
  gate.open();
  assert.deepEqual(said(got), ["Error: ", "cli.js missing", "exit 1"]);
  gate.open(); // a second open hands on nothing again
  assert.equal(got.length, 3);
}

// After the open: straight through, after what was held.
{
  const got: PtyEvent[] = [];
  const gate = ptyEventGate((e) => got.push(e));
  gate.push({ kind: "data", data: bytes("a") });
  gate.open();
  gate.push({ kind: "data", data: bytes("b") });
  gate.push({ kind: "exit", code: 0 });
  assert.deepEqual(said(got), ["a", "b", "exit 0"]);
}

// A spawn that failed, or a tile that went: nothing held is handed on, and
// nothing later.
{
  const got: PtyEvent[] = [];
  const gate = ptyEventGate((e) => got.push(e));
  gate.push({ kind: "data", data: bytes("x") });
  gate.close();
  gate.open();
  gate.push({ kind: "exit", code: 1 });
  assert.deepEqual(got, []);
}

// Closed while handing on (the exit's handler unmounts the tile).
{
  const got: PtyEvent[] = [];
  let gate: ReturnType<typeof ptyEventGate>;
  gate = ptyEventGate((e) => {
    got.push(e);
    if (e.kind === "exit") gate.close();
  });
  gate.push({ kind: "exit", code: 1 });
  gate.push({ kind: "data", data: bytes("late") });
  gate.open();
  assert.deepEqual(said(got), ["exit 1"]);
}

// The id the backend accepts (`pty_tile_id.rs`): a lowercase UUID, new each time.
const a = newPtyId();
assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
assert.notEqual(a, newPtyId());

console.log("earlyPtyEvents: ok");
