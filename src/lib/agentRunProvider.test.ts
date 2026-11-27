// Run with: node --experimental-strip-types src/lib/agentRunProvider.test.ts
import assert from "node:assert/strict";
import { runWentThroughCodex } from "./agentRunProvider.ts";

assert.equal(runWentThroughCodex({ provider: "codex", model: null }), true, "a Codex run with no model chosen");
assert.equal(runWentThroughCodex({ provider: "codex", model: "o9" }), true, "any model");
assert.equal(runWentThroughCodex({ provider: "claude", model: "gpt-ish" }), false);
assert.equal(runWentThroughCodex({ model: "gpt-5.5" }), true, "a run from before 1.168.1");
assert.equal(runWentThroughCodex({ model: "claude-opus-5" }), false);
assert.equal(runWentThroughCodex({}), false);
console.log("agentRunProvider: ok");
