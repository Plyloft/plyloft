// Skills hub H9: a Plyloft skill's version and its switch at three levels.
// Run with:
//
//     node --experimental-strip-types src/lib/plySkillSwitch.test.ts

import assert from "node:assert/strict";
import type { PlyPlace, PlySkillSwitch } from "../ipc.ts";
import {
  plyMacSwitchNote,
  askOwnerSentence,
  liveSwitch,
  personalizeChoices,
  plyChangeLines,
  plyRowHint,
  plyRowNote,
  plyStatusFor,
  plySwitchRows,
} from "./plySkillSwitch.ts";

const CHANGES = [
  { version: "1.167.0", contentId: "b", summary: "asks for the acceptance check first" },
  { version: "1.152.0", contentId: "a", summary: "first version" },
];

// R9 AC: the row hint after a change.
assert.equal(
  plyRowHint("Turns a rough idea into a brief.", CHANGES),
  "v1.167.0 · Changed in 1.167.0: asks for the acceptance check first",
);
// A skill at its first version: the version and its first sentence.
assert.equal(plyRowHint("Turns a rough idea into a brief.", CHANGES.slice(1)), "v1.152.0 · Turns a rough idea into a brief.");
// A build with no CHANGES.json (Tier 2): as before H9.
assert.equal(plyRowHint("Turns a rough idea into a brief.", undefined), "Turns a rough idea into a brief.");
assert.equal(plyRowHint("Turns a rough idea into a brief.", []), "Turns a rough idea into a brief.");

assert.deepEqual(plyChangeLines(CHANGES), {
  latest: "Changed in 1.167.0: asks for the acceptance check first.",
  earlier: "Earlier: 1.152.0 — first version.",
});
assert.deepEqual(plyChangeLines(undefined), { latest: null, earlier: null });

const sw = (over: Partial<PlySkillSwitch>): PlySkillSwitch => ({
  on: true,
  level: "default",
  workspace: null,
  fork: false,
  teamOff: false,
  macOn: true,
  ...over,
});
const place = (over: Partial<PlyPlace> = {}): PlyPlace => ({
  workspaceName: "acme-web",
  repository: "acme/web",
  shared: true,
  readOnly: false,
  team: { slug: "acme/team", name: "acme", owner: "matteo", youOwn: false },
  ...over,
});

// This Mac's live switch decides only where nothing above it does.
assert.deepEqual(liveSwitch(sw({}), false), sw({ on: false, level: "mac", macOn: false }));
assert.deepEqual(liveSwitch(sw({ on: false, level: "mac", macOn: false }), true), sw({}));
assert.deepEqual(
  liveSwitch(sw({ on: true, level: "workspace", workspace: true }), false),
  sw({ on: true, level: "workspace", workspace: true, macOn: false }),
);
assert.equal(liveSwitch(null, true), null);

// The row notes say which level decides (R9: "Off in this workspace (set in acme/web)").
assert.equal(
  plyRowNote("card-brief", sw({ on: false, level: "workspace", workspace: false }), place()),
  "Off in this workspace (set in acme/web (.atelier/workspace.json)).",
);
assert.equal(
  plyRowNote("card-brief", sw({ on: false, level: "fork", fork: true }), place()),
  "Off in this workspace: acme/web has its own card-brief, personalized from Plyloft.",
);
assert.equal(plyRowNote("card-brief", sw({ on: false, level: "team", teamOff: true }), place()), "Off for the team — set by matteo, in every workspace on this Mac.");
assert.equal(plyRowNote("card-brief", sw({ on: false, level: "mac", macOn: false }), place()), null);
assert.equal(
  plyRowNote("card-brief", sw({ on: true, level: "workspace", workspace: true }), place({ shared: false })),
  "On in this workspace (set for this workspace on this Mac).",
);

// Status lines.
assert.match(
  plyStatusFor(true, true, sw({ on: false, level: "team", teamOff: true }), true, "card-brief", place()),
  /switched off for the team by matteo, so no tile, card or run in any workspace on this Mac gets it\.$/,
);
assert.match(plyStatusFor(true, true, sw({ on: false, level: "fork", fork: true }), true, "card-brief", place()), /has its own card-brief/);
assert.match(plyStatusFor(true, true, null, false, "card-brief", null), /switched off on this Mac/);
assert.equal(
  plyStatusFor(true, true, sw({}), true, "card-brief", place()),
  "Comes with Plyloft · every Claude and Codex tile, card and run Plyloft opens gets it.",
);

// The `Where it's on` rows: Q27's "No team choice — follows this Mac" and the
// owner named for a member.
{
  const rows = plySwitchRows("card-brief", sw({ on: false, level: "fork", fork: true }), place());
  assert.equal(rows.count, "In acme-web: off");
  assert.equal(rows.workspace.choice, "follow");
  assert.match(rows.workspace.hint, /^Off — acme\/web has its own card-brief, personalized from Plyloft\./);
  assert.match(rows.workspace.hint, /reaches everyone who opens acme\/web\.$/);
  assert.equal(rows.team?.label, "acme's team default");
  assert.equal(
    rows.team?.hint,
    "No team choice — follows this Mac. Only matteo can switch it off for the team.",
  );
  assert.equal(rows.team?.canSet, false);
  assert.equal(rows.mac.hint, "On — used where neither the workspace nor the team decides.");
}
{
  const rows = plySwitchRows(
    "release-notes",
    sw({ on: false, level: "team", teamOff: true }),
    place({ team: { slug: "acme/team", name: "acme", owner: "matteo", youOwn: true } }),
  );
  assert.equal(rows.team?.hint, "Off — set by matteo for the team, in every workspace on this Mac.");
  assert.equal(rows.team?.canSet, true);
  assert.equal(rows.workspace.hint.startsWith("No choice here — follows the team, then this Mac."), true);
}
{
  // A read-only collaborator can't change a shared workspace's choice.
  const rows = plySwitchRows("x", sw({ workspace: true, level: "workspace" }), place({ readOnly: true, team: null }));
  assert.equal(rows.workspace.disabled, true);
  assert.equal(rows.workspace.choice, "on");
  assert.match(rows.workspace.hint, /Only people who can push to acme\/web change it\.$/);
  assert.equal(rows.team, null);
}

// Personalize's choices: the team only with a team and not in solo mode; a
// member hears who can switch Plyloft's off.
{
  const choices = personalizeChoices("card-brief", place(), false);
  assert.deepEqual(choices.map((c) => c.id), ["repository", "team"]);
  assert.match(choices[1].hint, /Only matteo can switch Plyloft's card-brief off for the team\. Your fork reaches sessions next to it until then\./);
  assert.deepEqual(personalizeChoices("card-brief", place(), true).map((c) => c.id), ["repository"]);
  assert.deepEqual(personalizeChoices("card-brief", place({ team: null }), false).map((c) => c.id), ["repository"]);
}
assert.match(askOwnerSentence("card-brief", "acme"), /^Could you switch Plyloft's card-brief off for acme\?/);

// Mac re-walk, 2026-10-20: the row's toggle is this Mac's; said when a level
// above decides the other way here, silent otherwise.
assert.equal(
  plyMacSwitchNote(sw({ on: false, level: "fork", fork: true, macOn: true })),
  "The switch is this Mac's own (on); in this workspace the line above decides.",
);
assert.equal(plyMacSwitchNote(sw({ on: false, level: "team", teamOff: true, macOn: true }))?.includes("(on)"), true);
assert.equal(plyMacSwitchNote(sw({ on: true, level: "workspace", workspace: true, macOn: false }))?.includes("(off)"), true);
assert.equal(plyMacSwitchNote(sw({ on: true, level: "workspace", workspace: true, macOn: true })), null, "agrees: nothing to say");
assert.equal(plyMacSwitchNote(sw({ on: false, level: "mac", macOn: false })), null);
assert.equal(plyMacSwitchNote(null), null);

console.log("plySkillSwitch: ok");
