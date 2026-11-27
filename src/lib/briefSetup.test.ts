// 1.172.0 (C1): the setup sentence under What you want on a card not built
// yet — who builds it, how it asks, who reviews it. Run with:
//   node --experimental-strip-types src/lib/briefSetup.test.ts
import assert from "node:assert/strict";
import { BUILDER_PERMISSIONS } from "./builderPermissions.ts";
import { BRIEF_SETUP_CHANGE_TITLE, briefSetupLine, briefSetupMore, factsBeforeBuild } from "./briefSetup.ts";

assert.equal(
  briefSetupLine({ builder: "claude", challenger: "codex", permissions: "asks" }),
  "Claude builds it in a copy of your project, with its own permission setting; Codex reviews it.",
);
// 1.175.0 F9 (I1): Codex asks for real; Claude follows its own setting.
assert.equal(
  briefSetupLine({ builder: "codex", challenger: "claude", permissions: "asks" }),
  "Codex builds it in a copy of your project, asking you before every change; Claude reviews it.",
);
assert.equal(
  briefSetupLine({ builder: "codex", challenger: "claude", permissions: "editsCopy" }),
  "Codex builds it in a copy of your project, changing files there without asking; Claude reviews it.",
);
assert.equal(
  briefSetupLine({ builder: "claude", challenger: "codex", permissions: "neverAsks" }),
  "Claude builds it in a copy of your project, never stopping to ask (risky); Codex reviews it.",
  "Never asks says its risk, as the picker does",
);
// One AI for both roles: the review is its second session, never "Claude reviews" its own build.
assert.equal(
  briefSetupLine({ builder: "claude", challenger: "claude", permissions: "asks" }),
  "Claude builds it in a copy of your project, with its own permission setting; a second Claude session reviews it.",
);
// Every choice has its words, one sentence each.
for (const permissions of BUILDER_PERMISSIONS) {
  const line = briefSetupLine({ builder: "codex", challenger: "codex", permissions });
  assert.match(line, /^Codex builds it in a copy of your project, [a-z ()]+; a second Codex session reviews it\.$/);
}
// 1.175.0 F10: the area, only with two or more; the blockers under it.
assert.equal(
  briefSetupLine({ builder: "claude", challenger: "codex", permissions: "asks", area: { name: "Site", areas: 2 } }),
  "Claude builds it in a copy of your project, with its own permission setting; Codex reviews it. It goes to Site.",
);
assert.equal(
  briefSetupLine({ builder: "claude", challenger: "codex", permissions: "asks", area: { name: "Site", areas: 1 } }),
  "Claude builds it in a copy of your project, with its own permission setting; Codex reviews it.",
  "one area: nothing to say",
);
assert.equal(BRIEF_SETUP_CHANGE_TITLE, "Choose the Builder, how it works and the models.");
// Before the first build, the line keeps only what the sentence doesn't say.
const facts = ["Builder", "Permissions", "Reviewer", "Area", "Blocked by", "Blocks", "Follows up", "Issue"].map((label) => ({ label }));
assert.deepEqual(factsBeforeBuild(facts).map((f) => f.label), ["Area", "Blocked by", "Blocks", "Follows up", "Issue"]);
console.log("briefSetup: ok");

// 1.176.3: whose plans it uses and that it can be undone.
assert.equal(
  briefSetupMore("claude"),
  "It uses your own Claude plan, the same allowance as when you use Claude yourself. Your project does not change until you ship the result. You can delete the card, and its copy once it has one, from its ⋯ menu.",
);
assert.match(briefSetupMore("codex"), /^It uses your own ChatGPT plan, the same allowance as when you use Codex yourself\./);
assert.match(briefSetupMore("claude", "codex"), /^It uses your own Claude and ChatGPT plans, the same allowance as when you use them yourself\./);
assert.match(briefSetupMore("codex", "claude"), /^It uses your own ChatGPT and Claude plans/);
assert.match(briefSetupMore("claude", "claude"), /^It uses your own Claude plan,/);
