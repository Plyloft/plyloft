// Group B decision §3: `New skill…`'s checks and words. Run with:
//
//     node --experimental-strip-types src/lib/newSkill.test.ts

import assert from "node:assert/strict";
import {
  NEW_SKILL_NAME_MAX,
  descriptionProblem,
  ignoredRefusal,
  nameProblem,
  nameTaken,
  newSkillClosingLine,
  newSkillIgnoredRoots,
  newSkillPaths,
  windowsReserved,
} from "./newSkill.ts";

// Names: the same rule as the backend.
for (const good of ["deploy", "ship-a-card", "v2-notes", "a", "0day"]) {
  assert.equal(nameProblem(good), null, good);
}
for (const bad of [
  "", "Deploy", "ship_a_card", "ship a card", "-deploy", "deploy-", "ship--card",
  "../x", "x/y", "x\\y", ".hidden", "déploy",
]) {
  assert.ok(nameProblem(bad), `${JSON.stringify(bad)} must be refused`);
}
assert.equal(nameProblem("a".repeat(NEW_SKILL_NAME_MAX)), null);
assert.ok(nameProblem("a".repeat(NEW_SKILL_NAME_MAX + 1)));

// Windows device names, in any case (mirrors the backend).
for (const reserved of ["con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9", "CON", "Lpt3"]) {
  assert.ok(windowsReserved(reserved), reserved);
}
for (const fine of ["com", "com0", "com10", "console", "nul-check", "auxiliary"]) {
  assert.equal(windowsReserved(fine), false, fine);
}
assert.match(nameProblem("nul")!, /Windows keeps for a device/);

// Description: required, one line, bounded.
assert.ok(descriptionProblem("   "));
assert.ok(descriptionProblem("Use when\ndeploying."));
assert.ok(descriptionProblem("x".repeat(1025)));
assert.equal(descriptionProblem("Use when deploying."), null);

// Unique across the repository: the checkout's roots, what neither CLI loads,
// and the branch.
const repository = {
  skills: [{ name: "deploy" }],
  unloadable: [{ name: "broken", root: ".agents/skills" }],
  mirror: [{ name: "release" }],
};
assert.match(nameTaken("deploy", repository, "staging")!, /already has a skill called deploy/);
assert.match(nameTaken("broken", repository, "staging")!, /\.agents\/skills already has a broken folder/);
assert.match(nameTaken("release", repository, "staging")!, /staging already carries/);
assert.equal(nameTaken("fresh", repository, "staging"), null);

// Gitignored roots: only the two the flow writes, in writing order.
assert.deepEqual(newSkillIgnoredRoots([".codex/skills"]), []);
assert.deepEqual(newSkillIgnoredRoots([".agents/skills", ".claude/skills"]), [
  ".claude/skills",
  ".agents/skills",
]);
assert.match(ignoredRefusal([".agents/skills"]), /Press Let Git see it first/);

// The closing line says nothing is committed and how to keep the two in step,
// in words (no paths, no "both CLIs"); the paths are under Details.
const line = newSkillClosingLine("staging");
assert.match(line, /Claude and Codex/);
assert.doesNotMatch(line, /both CLIs|\.claude|\.agents/);
assert.match(line, /Nothing is committed/);
assert.match(line, /Publish to staging/);
assert.match(line, /Edit both copies, or Align/);
assert.deepEqual(newSkillPaths("deploy"), {
  claude: ".claude/skills/deploy/SKILL.md",
  codex: ".agents/skills/deploy/SKILL.md",
});

console.log("newSkill: ok");
