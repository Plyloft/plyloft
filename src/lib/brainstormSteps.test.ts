// GH #278: node --experimental-strip-types src/lib/brainstormSteps.test.ts
import assert from "node:assert/strict";
import { durationWords, templateStepsWords } from "./brainstormSteps.ts";

assert.equal(
  templateStepsWords({
    steps: [{ role: "scout" }, { role: "builder" }, { role: "reviewer" }],
    maxIterations: 3,
    maxWallSeconds: 3600,
  }),
  "Scout, then Builder, then Reviewer — up to 3 rounds, 1 hour",
);
assert.equal(durationWords(45 * 60), "45 minutes");
assert.equal(durationWords(90 * 60), "1 hour 30 minutes");
assert.equal(durationWords(7200), "2 hours");
const words = templateStepsWords({ steps: [{ role: "scout" }], maxIterations: 1, maxWallSeconds: 60 });
assert.equal(words, "Scout — up to 1 round, 1 minute");
assert.doesNotMatch(words, /iter|wall|→/);
console.log("brainstormSteps: ok");
