// 1.176.0 seams: a Diagnostics row's Update becomes Repair when the copy
// can't be updated by its own updater.
// Run: node --experimental-strip-types src/lib/repairRows.test.ts
import assert from "node:assert/strict";
import { UPDATE_BLOCKED_HINT, aiToolOfRow, repairWhenUpdateBlocked } from "./repairRows.ts";

const update = { id: "tool:codex", hint: "Ready.", fix: { kind: "person", action: "Update", command: "codex update", update: true } };
const blocked = repairWhenUpdateBlocked(update, { codex: true });
assert.equal(blocked.fix.action, "Repair");
assert.equal(blocked.hint, `Ready. ${UPDATE_BLOCKED_HINT}`);
assert.equal((blocked.fix as typeof update.fix).command, "codex update", "the rest of the fix stays");
// Not blocked, another tool, another action, another row: unchanged.
assert.equal(repairWhenUpdateBlocked(update, { codex: false }), update);
assert.equal(repairWhenUpdateBlocked(update, { claude: true }), update);
const install = { ...update, fix: { kind: "person", action: "Install" } };
assert.equal(repairWhenUpdateBlocked(install, { codex: true }), install);
const git = { ...update, id: "tool:git" };
assert.equal(repairWhenUpdateBlocked(git, { codex: true }), git);
assert.equal(aiToolOfRow("tool:claude"), "claude");
console.log("repairRows: ok");
