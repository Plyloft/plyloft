// 1.173.0 A2: the copies' shape. Run with:
//
//     node --experimental-strip-types src/lib/copies.test.ts

import assert from "node:assert/strict";
import { normalizeCopyEntry, normalizeCopyView } from "./copies.ts";

// A row with only an id (a later build's minimal entry) takes every default.
const bare = normalizeCopyView({ id: "copy-1a2b3c4d" });
assert.equal(bare.name, "copy-1a2b3c4d");
assert.equal(bare.state, "active");
assert.deepEqual(bare.changed, { count: 0, files: [], unreadable: false });
assert.equal(bare.terminals, 0);
assert.equal(bare.present, false);
assert.equal(bare.restorable, false);
assert.equal(bare.baseBranch, "");

// A full row keeps what it says, and fields this build doesn't know.
const full = normalizeCopyView({
  id: "copy-1a2b3c4d",
  name: "inbox-empty-state",
  branch: "plyloft/copy-1a2b3c4d-inbox-empty-state",
  path: "/w/.plyloft-worktrees/copy-1a2b3c4d",
  baseBranch: "main",
  baseCommit: "abc",
  baseSource: "origin",
  createdAt: 7,
  state: "trashed",
  changed: { count: 3, files: ["a", "b", "c"] },
  terminals: 1,
  present: true,
  restorable: true,
  ...({ area: "site" } as object),
});
assert.equal(full.state, "trashed");
assert.equal(full.changed.count, 3);
assert.equal((full as unknown as { area: string }).area, "site");

// An entry (throw away, restore, retry) takes the same defaults.
const entry = normalizeCopyEntry({ id: "copy-1a2b3c4d", state: "trashed" });
assert.equal(entry.name, "copy-1a2b3c4d");
assert.equal(entry.state, "trashed");
assert.equal(entry.baseBranch, "");
assert.equal(entry.createdAt, 0);
assert.equal(normalizeCopyEntry({ id: "copy-1a2b3c4d" }).state, "active");

console.log("copies.test.ts: ok");
