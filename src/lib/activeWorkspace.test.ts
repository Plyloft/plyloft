// Unit tests for activeIdAfterRefresh (src/lib/activeWorkspace.ts, GH #79).
//
// Run: node --experimental-strip-types src/lib/activeWorkspace.test.ts

import { activeIdAfterRefresh, makeWorkspaceRefresh } from "./activeWorkspace.ts";

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

function eq(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`expected ${expected}, got ${actual}`);
}

it("a switch made while the refresh was in flight is kept", () => {
  eq(activeIdAfterRefresh("a", "b", "a", ["a", "b"]), "b");
});

it("without a switch the backend's active id applies", () => {
  eq(activeIdAfterRefresh("a", "a", "c", ["a", "c"]), "c");
  eq(activeIdAfterRefresh(null, null, "a", ["a"]), "a");
});

it("a switch to a workspace that no longer exists does not stick", () => {
  eq(activeIdAfterRefresh("a", "gone", "a", ["a"]), "a");
});

type W = { id: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function overlap(): Promise<void> {
  const applied: string[][] = [];
  const lists = [
    deferred<{ workspaces: W[]; activeWorkspaceId: string | null }>(),
    deferred<{ workspaces: W[]; activeWorkspaceId: string | null }>(),
  ];
  let call = 0;
  let active: string | null = "a";
  const refresh = makeWorkspaceRefresh<W>({
    list: () => lists[call++].promise,
    cwdExists: async () => true,
    activeId: () => active,
    apply: (next) => {
      applied.push(next.workspaces.map((w) => w.id));
      active = next.activeId;
    },
  });
  // A background refresh starts, then a delete of "b" runs its own.
  const older = refresh();
  const newer = refresh();
  // The delete's refresh finishes first…
  lists[1].resolve({ workspaces: [{ id: "a" }], activeWorkspaceId: "a" });
  await newer;
  // …then the older one, holding the list from before the delete.
  lists[0].resolve({ workspaces: [{ id: "a" }, { id: "b" }], activeWorkspaceId: "a" });
  await older;
  eq(JSON.stringify(applied), JSON.stringify([["a"]]));
}

await overlap().then(
  () => passed++,
  (e) => {
    failed++;
    failures.push(`an older refresh finishing last does not bring a deleted workspace back: ${(e as Error).message}`);
  },
);

if (failed > 0) {
  console.error(`✗ ${failed} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`✓ ${passed} passed`);
