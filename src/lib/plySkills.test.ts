// GH #106: the switch on a skill that comes with Ply. Run with:
//
//     node --experimental-strip-types src/lib/plySkills.test.ts

import assert from "node:assert/strict";
import { plySkillOn, plySkillSwitchedIn, withPlySkill } from "./plySkills.ts";

// An absent list is every skill switched on, which is what a settings.json
// written before this card — and a fresh one — carries.
assert.equal(plySkillOn([], "card-brief"), true);
assert.equal(plySkillOn(["release-notes"], "card-brief"), true);
assert.equal(plySkillOn(["card-brief"], "card-brief"), false);

// Switching one off adds its name; switching it on again takes the name away.
assert.deepEqual(withPlySkill([], "card-brief", false), ["card-brief"]);
assert.deepEqual(withPlySkill(["card-brief"], "card-brief", true), []);
assert.deepEqual(withPlySkill(["card-brief"], "release-notes", false), [
  "card-brief",
  "release-notes",
]);

// Sorted, so two Macs that switched the same pair off in a different order hold
// the same bytes.
assert.deepEqual(withPlySkill(["release-notes"], "card-brief", false), [
  "card-brief",
  "release-notes",
]);

// A change that changes nothing hands the same list back, by reference: the
// caller can then skip the write instead of rewriting the whole file.
{
  const off = ["card-brief"];
  assert.equal(withPlySkill(off, "card-brief", false), off);
  assert.equal(withPlySkill(off, "release-notes", true), off);
}

// A hand-edited file holding a name twice is repaired by the next switch rather
// than carried forward.
assert.deepEqual(withPlySkill(["a", "a"], "b", false), ["a", "b"]);

// One skill switched on among several off: only that name goes.
assert.deepEqual(withPlySkill(["a", "b", "c"], "b", true), ["a", "c"]);

// The mutation shape: the rest of the settings, and the rest of `library`, are
// carried through untouched — a save that dropped them would undo somebody's
// theme or un-silence every duplicate notice.
{
  const latest = {
    schemaVersion: 1,
    appearance: { theme: "dark" },
    library: { plySkillsOff: ["release-notes"], silencedDuplicates: [{ name: "deploy" }] },
  };
  const next = plySkillSwitchedIn(latest, "card-brief", false);
  assert.deepEqual(next.library.plySkillsOff, ["card-brief", "release-notes"]);
  assert.deepEqual(next.library.silencedDuplicates, [{ name: "deploy" }]);
  assert.deepEqual(next.appearance, { theme: "dark" });
  assert.equal(next.schemaVersion, 1);
  // And the input was not mutated: the queue may still hold a reference to it.
  assert.deepEqual(latest.library.plySkillsOff, ["release-notes"]);
}

console.log("plySkills.test.ts ok");
