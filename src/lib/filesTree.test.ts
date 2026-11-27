// QoL 6.2 / 6.3: the Code tree's pure rules. Run with:
//
//     node --experimental-strip-types src/lib/filesTree.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAtOrUnder, isTransientName, mergeListing, movedPath } from "./filesTree.ts";

type N = { entry: { path: string; size?: number }; expanded: boolean; children: N[] | null };
const node = (path: string, extra: Partial<N> = {}): N => ({ entry: { path }, expanded: false, children: null, ...extra });

test("a fresh listing keeps the folders that were open, and their children", () => {
  const deep = node("/p/src/lib", { expanded: true, children: [node("/p/src/lib/a.ts")] });
  const old = [node("/p/src", { expanded: true, children: [deep] }), node("/p/README.md")];
  const fresh = [node("/p/docs"), node("/p/src"), node("/p/README.md", { entry: { path: "/p/README.md", size: 9 } } as Partial<N>)];
  const merged = mergeListing(old, fresh);
  assert.deepEqual(merged.map((n) => n.entry.path), ["/p/docs", "/p/src", "/p/README.md"]);
  assert.equal(merged[0].expanded, false, "a new folder starts closed");
  assert.equal(merged[1].expanded, true, "an open folder stays open");
  assert.equal(merged[1].children?.[0], deep, "with its own open folders below");
  assert.equal(merged[2].entry.size, 9, "the entry is the fresh one");
});

test("a row gone from disk goes; nothing loaded yet is the fresh listing", () => {
  const old = [node("/p/a", { expanded: true, children: [] }), node("/p/b")];
  assert.deepEqual(mergeListing(old, [node("/p/b")]).map((n) => n.entry.path), ["/p/b"]);
  assert.deepEqual(mergeListing(null, [node("/p/x")]).map((n) => n.entry.path), ["/p/x"]);
});

test("Plyloft's own temp files and editors' swap files are not news", () => {
  for (const name of ["App.tsx.atelier-tmp", ".drop-x.atelier-tmp", "4913", ".#App.tsx", ".App.tsx.swp", "App.tsx~"]) {
    assert.equal(isTransientName(name), true, name);
  }
  for (const name of ["App.tsx", ".env", "swap.ts", "notes.md"]) {
    assert.equal(isTransientName(name), false, name);
  }
});

test("a rename moves the file itself and the files inside a folder", () => {
  assert.equal(movedPath("/p/a.ts", "/p/a.ts", "/p/b.ts", false), "/p/b.ts");
  assert.equal(movedPath("/p/src/x/y.ts", "/p/src", "/p/lib", false), "/p/lib/x/y.ts");
  assert.equal(movedPath("/p/srcs/y.ts", "/p/src", "/p/lib", false), null, "a sibling with a longer name");
  assert.equal(movedPath("C:\\p\\src\\y.ts", "C:\\p\\src", "C:\\p\\lib", true), "C:\\p\\lib\\y.ts");
  assert.equal(isAtOrUnder("/p/src/y.ts", "/p/src", false), true);
  assert.equal(isAtOrUnder("/p/src", "/p/src", false), true);
  assert.equal(isAtOrUnder("/p/srcs", "/p/src", false), false);
});
