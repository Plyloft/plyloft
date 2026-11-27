// 1.176.3: which typed model names are asked about. Run with:
//
//     node --experimental-strip-types src/lib/unknownModel.test.ts
import assert from "node:assert/strict";
import { isUnknownModel, unknownModelQuestion } from "./unknownModel.ts";

const KNOWN = ["claude-opus-5-5", "claude-sonnet-5-5"];
assert.equal(isUnknownModel("", KNOWN, "claude"), false, "empty is the default");
assert.equal(isUnknownModel("   ", KNOWN, "claude"), false);
assert.equal(isUnknownModel("claude-opus-5-5", KNOWN, "claude"), false, "a listed name");
assert.equal(isUnknownModel(" claude-opus-5-5 ", KNOWN, "claude"), false, "spaces around it don't count");
assert.equal(isUnknownModel("claude-opus-5-55", KNOWN, "claude"), true, "a mistyped one");
assert.equal(isUnknownModel("claude-opus-9", KNOWN, "claude"), true, "a model not in the list yet is asked about, not refused");
assert.equal(isUnknownModel("anything", [], "claude"), false, "no list read yet: nothing to judge by");
assert.equal(isUnknownModel("The tool's default", KNOWN, "claude", ["The tool's default"]), false);
assert.equal(isUnknownModel("the TOOL's default", KNOWN, "claude", ["The tool's default"]), false);
const q = unknownModelQuestion(" claude-opus-5-55 ", "Builder model (Claude)");
assert.equal(q.title, "Save this model name?");
assert.match(q.body, /^Plyloft doesn't know “claude-opus-5-55” as a model for Builder model \(Claude\)\./);
// Claude's own names are never questioned (M2): aliases, [1m], cloud ids.
for (const ok of ["opus", "Sonnet", "haiku", "opusplan", "default", "sonnet[1m]", "claude-opus-5-5[1m]", "us.anthropic.claude-sonnet-4-5-v1:0", "claude-sonnet-4-5@20250929", "claude-3-5-sonnet-20241022"]) {
  assert.equal(isUnknownModel(ok, KNOWN, "claude"), false, ok);
}
assert.equal(isUnknownModel("opus", ["gpt-6-sol"], "codex"), true, "Claude's aliases never apply to Codex");
assert.equal(isUnknownModel("sonnet[1m]", ["gpt-6-sol"], "codex"), true);
assert.equal(isUnknownModel("gpt-6-sol", ["gpt-6-sol"], "codex"), false);
assert.equal(isUnknownModel("opuss", KNOWN, "claude"), true, "a typo of an alias is still asked about");
console.log("unknownModel: all assertions passed");
