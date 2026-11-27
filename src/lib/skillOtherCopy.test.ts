import assert from "node:assert/strict";
import { otherCopyOf } from "./skillOtherCopy.ts";

// Claude's copy points at Codex's, and back.
assert.deepEqual(otherCopyOf("/repo/.claude/skills/team-style", "team-style"), {
  dir: "/repo/.agents/skills/team-style",
  root: ".agents/skills",
  owner: "Codex",
});
assert.deepEqual(otherCopyOf("/repo/.agents/skills/team-style/", "team-style"), {
  dir: "/repo/.claude/skills/team-style",
  root: ".claude/skills",
  owner: "Claude",
});
// Windows paths keep their separator.
assert.deepEqual(otherCopyOf("C:\\code\\repo\\.claude\\skills\\lint", "lint"), {
  dir: "C:\\code\\repo\\.agents\\skills\\lint",
  root: ".agents/skills",
  owner: "Codex",
});
// Nothing for a folder that is not one of the two roots, or another name.
assert.equal(otherCopyOf("/repo/.codex/skills/lint", "lint"), null);
assert.equal(otherCopyOf("/h/.claude/skills-other/lint", "lint"), null);
assert.equal(otherCopyOf("/repo/.claude/skills/lint", "other"), null);
assert.equal(otherCopyOf(null, "lint"), null);

console.log("skillOtherCopy.test.ts ✓");
