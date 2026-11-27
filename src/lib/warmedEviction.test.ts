// Tier 3 pure-function test. Run with Node 22+:
//   node --experimental-strip-types src/lib/warmedEviction.test.ts
import assert from "node:assert/strict";
import { workspaceHasLiveSession, workspacesToEvict } from "./warmedEviction.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
  passed += 1;
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`);
const at = (list: string[]) => Object.fromEntries(list.map((id, i) => [id, 100 + i]));

test("under the cap, or already warm: nothing leaves", () => {
  const warmed = new Set(ids(3));
  assert.deepEqual(workspacesToEvict({ warmed, activating: "x", cap: 8, lastActiveAt: {}, isLive: () => false }), []);
  const full = new Set(ids(8));
  assert.deepEqual(workspacesToEvict({ warmed: full, activating: "w3", cap: 8, lastActiveAt: at(ids(8)), isLive: () => false }), []);
});

test("at the cap: the least recently active idle one leaves (the old rule)", () => {
  const warmed = new Set(ids(8));
  assert.deepEqual(
    workspacesToEvict({ warmed, activating: "new", cap: 8, lastActiveAt: at(ids(8)), isLive: () => false }),
    ["w0"],
  );
});

test("a workspace with a live session is never picked", () => {
  const warmed = new Set(ids(8));
  const live = new Set(["w0", "w1"]);
  assert.deepEqual(
    workspacesToEvict({ warmed, activating: "new", cap: 8, lastActiveAt: at(ids(8)), isLive: (id) => live.has(id) }),
    ["w2"],
  );
});

test("every warmed one live: none leaves, the set grows past the cap", () => {
  const warmed = new Set(ids(8));
  assert.deepEqual(
    workspacesToEvict({ warmed, activating: "new", cap: 8, lastActiveAt: at(ids(8)), isLive: () => true }),
    [],
  );
});

test("over the cap after a live stretch: idle ones leave until it fits", () => {
  const warmed = new Set(ids(10));
  const live = new Set(["w0", "w2", "w4", "w5", "w6", "w7", "w8"]);
  assert.deepEqual(
    workspacesToEvict({ warmed, activating: "new", cap: 8, lastActiveAt: at(ids(10)), isLive: (id) => live.has(id) }),
    ["w1", "w3", "w9"],
  );
});

test("the one being warmed is never evicted", () => {
  const warmed = new Set(ids(9));
  assert.deepEqual(
    workspacesToEvict({ warmed, activating: "w0", cap: 8, lastActiveAt: at(ids(9)), isLive: () => false }),
    ["w1"],
  );
});

test("live: a running or starting tile, or a Builder session", () => {
  const tiles = {
    a: { tiles: [{ status: "done" }, { status: "running" }] },
    b: { tiles: [{ status: "pending" }] },
    c: { tiles: [{ status: "crashed" }, { status: "killed" }] },
  };
  const builders = { k1: { workspaceId: "d" } };
  assert.equal(workspaceHasLiveSession("a", tiles, builders), true);
  assert.equal(workspaceHasLiveSession("b", tiles, builders), true);
  assert.equal(workspaceHasLiveSession("c", tiles, builders), false);
  assert.equal(workspaceHasLiveSession("d", tiles, builders), true);
  assert.equal(workspaceHasLiveSession("e", tiles, builders), false);
});

console.log(`warmedEviction: ${passed}/7 passed`);
