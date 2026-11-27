// 1.176.0 R7: which installed CLIs certainly don't start, and which of them
// the sidebar names.
// Run: node --experimental-strip-types src/lib/cliBroken.test.ts
import assert from "node:assert/strict";
import type { DoctorReport, ToolStatus } from "../ipc.ts";
import { brokenCliRowText, brokenClis, toolDoesNotStart, type BrokenCliInput } from "./cliBroken.ts";

function row(id: "claude" | "codex", patch: Partial<ToolStatus> = {}): ToolStatus {
  return {
    id,
    name: id,
    required: false,
    found: true,
    path: `/bin/${id}`,
    version: "1.0.0",
    versionOk: true,
    detail: "",
    installCmd: "",
    docsUrl: "",
    reviewer: null,
    ...patch,
  } as ToolStatus;
}
const report = (claude: Partial<ToolStatus>, codex: Partial<ToolStatus>) =>
  ({ tools: [row("claude", claude), row("codex", codex)] }) as unknown as DoctorReport;

// R3's three answers: a version (starts), a failure (doesn't), no answer in time (counts as starting).
assert.equal(toolDoesNotStart(row("claude")), false);
assert.equal(toolDoesNotStart(row("claude", { version: null, versionOk: false })), true);
assert.equal(toolDoesNotStart(row("claude", { version: null, versionOk: true })), false, "slow: not a failure");
assert.equal(toolDoesNotStart(row("claude", { version: "0.1.0", versionOk: false })), false, "too old still starts");
assert.equal(toolDoesNotStart(row("codex", { versionOk: false })), true);
assert.equal(toolDoesNotStart(row("codex", { found: false, versionOk: false })), false, "not installed is another row");
assert.equal(toolDoesNotStart(null), false);

const base: BrokenCliInput = {
  report: report({}, { versionOk: false }),
  chosen: "codex",
  tileKinds: [],
  gone: [],
  codexUpdating: false,
};
assert.deepEqual(brokenClis(base), ["codex"]);
// Not during launch: no report yet.
assert.deepEqual(brokenClis({ ...base, report: null }), []);
// Clears by itself once the report reads it starting.
assert.deepEqual(brokenClis({ ...base, report: report({}, {}) }), []);
// A tool the person doesn't use: not chosen, no tile of it.
assert.deepEqual(brokenClis({ ...base, chosen: "claude" }), []);
// …but a tile of it makes it theirs (a codex-chat tile is Codex's).
assert.deepEqual(brokenClis({ ...base, chosen: "claude", tileKinds: ["codex-chat"] }), ["codex"]);
assert.deepEqual(brokenClis({ ...base, chosen: "claude", tileKinds: ["shell"] }), []);
// Codex during its own automatic update: not named.
assert.deepEqual(brokenClis({ ...base, codexUpdating: true }), []);
// A cached path gone (a tile found it gone even after looking again).
const gone = report({ found: false, path: null, version: null, versionOk: false }, {});
assert.deepEqual(brokenClis({ ...base, report: gone, chosen: "claude" }), []);
assert.deepEqual(brokenClis({ ...base, report: gone, chosen: "claude", gone: ["claude"] }), ["claude"]);
// …and once it is found again (and starts), no row, whatever the tile said.
assert.deepEqual(brokenClis({ ...base, report: report({}, {}), chosen: "claude", gone: ["claude"] }), []);

assert.equal(brokenCliRowText("claude"), "Claude Code doesn't start");
assert.equal(brokenCliRowText("codex"), "Codex doesn't start");

console.log("cliBroken: ok");
