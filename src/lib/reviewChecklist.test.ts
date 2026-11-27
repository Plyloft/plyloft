// Unit tests for a repository's own risk-checklist classes (ADR 0006, third
// card): the editor's limits and the class drafted from a late finding.
//
// Run: node --experimental-strip-types src/lib/reviewChecklist.test.ts

import assert from "node:assert/strict";

import type { LedgerFinding } from "../ipc.ts";
import {
  CLASS_MAX_CHARS,
  MAX_CLASSES,
  checklistError,
  checklistInvalidity,
  classLetter,
  indexOfClass,
  saveError,
  draftFromFinding,
  offersChecklistClass,
  withClass,
} from "./reviewChecklist.ts";

assert.equal(classLetter(0), "J");
assert.equal(classLetter(1), "K");
assert.equal(classLetter(MAX_CLASSES - 1), "U");

// The limits, in the backend's words (`project_config::validate_review_checklist`).
const c = (name: string, sentence = "Look.") => ({ name, sentence });
const twelve = Array.from({ length: MAX_CLASSES }, (_, i) => c(`Class ${i}`));
assert.equal(checklistError(twelve), null);
assert.equal(
  checklistError([...twelve, c("One more")]),
  "A repository can add at most 12 checklist classes; this list has 13.",
);
assert.equal(
  checklistError([c("Long", "x".repeat(CLASS_MAX_CHARS - 3))]),
  "Checklist class J (Long) is 301 characters; a class is at most 300, name and sentence together.",
);
assert.equal(checklistError([c("Fits", "x".repeat(CLASS_MAX_CHARS - 4))]), null);
assert.equal(checklistError([c("A"), c("  ")]), "Checklist class K needs a name.");
// GH #111 F4/F10: the sentence is required.
assert.equal(
  checklistError([c("Bare", "  ")]),
  "Checklist class J (Bare) needs its sentence: what a review must look for.",
);

// GH #111 F23: a stored list over the limits is repaired a step at a time.
const fourteen = Array.from({ length: 14 }, (_, i) => c(`C${i}`));
fourteen[0] = c("Long", "x".repeat(400));
fourteen[1] = c("Longer", "x".repeat(400));
assert.equal(checklistInvalidity(fourteen), 4);
assert.equal(saveError(fourteen, fourteen.slice(0, 13)), null, "a removal lowers it: taken");
assert.equal(saveError(fourteen, [c("Short"), ...fourteen.slice(1)]), null, "a fixed class: taken");
assert.match(saveError(fourteen, [...fourteen, c("More")]) ?? "", /at most 12/);
assert.match(saveError([], [c("Bare", "")]) ?? "", /needs its sentence/, "from valid, only valid");

// GH #111 F8: the class the editor opened, found by value after a Sync.
const synced = [c("Other"), c("Branch discovery", "Names the remote.")];
assert.equal(indexOfClass(synced, c("Branch discovery", "Names the remote.")), 1);
assert.equal(indexOfClass(synced, c("Gone")), -1);

// Add, edit, remove as the editor does them.
const one = withClass([], null, c("  Branch   discovery ", " Names\nthe remote. "));
assert.deepEqual(one, [c("Branch discovery", "Names the remote.")]);
const edited = withClass([...one, c("Other")], 0, c("Branch lookup", "Names it."));
assert.deepEqual(edited.map((x) => x.name), ["Branch lookup", "Other"]);

// A finding raised by a follow-up and marked as in code the sweep read.
const finding = (overrides: Partial<LedgerFinding> = {}): LedgerFinding => ({
  id: "F7",
  severity: "P2",
  preExisting: false,
  location: "src-tauri/src/git.rs:40",
  title: "Branch discovery reads the wrong remote.",
  body: "**P2 — Branch discovery reads the wrong remote.** `src-tauri/src/git.rs:40`\nWith two remotes, the lookup reads upstream and publishes to the fork. It repeats in sync.rs.\n**Fix:** Name the remote.",
  reviewId: "r3",
  round: 3,
  state: "open",
  reason: null,
  updatedRound: 3,
  sweepSaw: true,
  ...overrides,
});
assert.equal(offersChecklistClass(finding()), true);
assert.equal(offersChecklistClass(finding({ sweepSaw: false })), false, "the fixes wrote it");
assert.equal(offersChecklistClass(finding({ sweepSaw: undefined })), false, "a ledger before it");
assert.equal(offersChecklistClass(finding({ round: 1 })), false, "the sweep's own finding");
assert.equal(offersChecklistClass(finding({ preExisting: true })), true, "GH #111 F14");

const draft = draftFromFinding(finding());
assert.equal(draft.name, "Branch discovery reads the wrong remote");
assert.equal(
  draft.sentence,
  "Look for this again: With two remotes, the lookup reads upstream and publishes to the fork.",
);
assert.equal(checklistError([draft]), null, "a draft always fits");
const long = draftFromFinding(finding({ title: "t ".repeat(80), body: "**P2 — t.**\n" + "word ".repeat(200) }));
assert.equal(checklistError([long]), null, "a long finding is cut to fit");
const bare = draftFromFinding(finding({ body: "" }));
assert.equal(bare.sentence, "Look for the kind of defect in finding F7.");

console.log("review checklist tests passed");
