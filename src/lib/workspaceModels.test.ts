import assert from "node:assert/strict";

import type { RoleModels } from "./roleModels.ts";
import {
  FORCE_CLI_DEFAULT_LABEL,
  USE_APP_DEFAULT_LABEL,
  effectiveRoleModels,
  pairingStatus,
  fieldChoice,
  fieldKey,
  forcesCliDefault,
  type WorkspaceModels,
  effectiveLine,
  effectivePart,
  fallbackPlaceholder,
  normalizeModels,
  ownCount,
  rowValue,
  withModelPart,
  withTeam,
  withTeamPart,
  effectiveEffort,
  onlyInSummary,
  onlyInVendor,
  ownsRole,
  teamSuggestsLine,
  teamSummary,
  vendorSummary,
} from "./workspaceModels.ts";

const APP: RoleModels = {
  claude: { builder: "opus", challenger: "sonnet" },
  codex: {
    builder: "gpt-6-astra",
    challenger: "gpt-5.5",
    builderReasoning: "high",
    challengerReasoning: "medium",
  },
};
const NONE: RoleModels = { claude: {}, codex: {} };

// No workspace rows: every line reads the app's, said as such.
assert.equal(effectiveLine(null, APP, "claude", "builder"), "Runs on opus (app default).");
assert.equal(
  effectiveLine(undefined, APP, "codex", "challenger"),
  "Runs on gpt-5.5 (app default), medium effort (app default).",
);
// Nothing anywhere: the CLI's own default.
assert.equal(effectiveLine(null, NONE, "codex", "builder"), "Runs on the tool's default model.");
assert.equal(effectiveLine(null, NONE, "claude", "challenger"), "Runs on the tool's default model.");

// Field by field: a blank workspace field falls back to the app row.
const ws: RoleModels = {
  claude: { builder: "  ", challenger: "claude-fable-5-1" },
  codex: { challengerReasoning: "low" },
};
assert.equal(effectiveLine(ws, APP, "claude", "builder"), "Runs on opus (app default).");
assert.equal(
  effectiveLine(ws, APP, "claude", "challenger"),
  "Runs on claude-fable-5-1 (this workspace).",
);
// Reasoning set without a model: the app's model, the workspace's effort.
assert.equal(
  effectiveLine(ws, APP, "codex", "challenger"),
  "Runs on gpt-5.5 (app default), low effort (this workspace).",
);
assert.deepEqual(effectivePart(ws, NONE, "codex", "challenger", "model"), {
  value: null,
  source: "cli",
});
assert.equal(
  effectiveLine(ws, NONE, "codex", "challenger"),
  "Runs on the tool's default model, low effort (this workspace).",
);
// The whole chain: workspace, else app, else none.
assert.equal(effectivePart({ claude: { builder: "opus" }, codex: {} }, NONE, "claude", "builder", "model").source, "workspace");
assert.equal(effectivePart(NONE, APP, "claude", "builder", "model").source, "app");
assert.equal(effectivePart(NONE, NONE, "claude", "builder", "model").source, "cli");

// 1.169.0 (A1): Claude's effort is a field like Codex's.
assert.equal(rowValue(APP, "claude", "builder", "reasoning"), "");
assert.equal(rowValue({ claude: { builderReasoning: " high " }, codex: {} }, "claude", "builder", "reasoning"), "high");
assert.equal(rowValue(APP, "codex", "builder", "reasoning"), "high");
assert.equal(rowValue(null, "codex", "builder", "model"), "");

// Normalizing: trimmed, blanks dropped, all-blank is null.
assert.equal(normalizeModels(null), null);
assert.equal(normalizeModels(NONE), null);
assert.equal(normalizeModels({ claude: { builder: " " }, codex: { builderReasoning: "" } }), null);
assert.deepEqual(normalizeModels({ claude: { builder: " opus " }, codex: { challenger: "" } }), {
  claude: { builder: "opus" },
  codex: {},
});

// Changing one part keeps the others; clearing the last one clears the row.
let rows = withModelPart(null, "codex", "builder", "reasoning", "minimal");
assert.deepEqual(rows, { claude: {}, codex: { builderReasoning: "minimal" } });
rows = withModelPart(rows, "claude", "challenger", "model", "sonnet");
assert.deepEqual(rows, { claude: { challenger: "sonnet" }, codex: { builderReasoning: "minimal" } });
// 1.169.0 (A1): Claude's effort is written beside its model.
rows = withModelPart(rows, "claude", "builder", "reasoning", "high");
assert.deepEqual(rows, { claude: { challenger: "sonnet", builderReasoning: "high" }, codex: { builderReasoning: "minimal" } });
assert.equal(
  effectiveLine(rows, APP, "claude", "builder"),
  "Runs on opus (app default), high effort (this workspace).",
);
rows = withModelPart(rows, "claude", "builder", "reasoning", "");
rows = withModelPart(rows, "claude", "challenger", "model", "");
rows = withModelPart(rows, "codex", "builder", "reasoning", "");
assert.equal(rows, null);

// The empty field's placeholder names what it falls back to.
assert.equal(fallbackPlaceholder(APP, "claude", "builder", "model"), "opus (app default)");
// SP-7: no app value — "Use app default", nothing more.
assert.equal(fallbackPlaceholder(NONE, "codex", "builder", "model"), "Use app default");
assert.equal(USE_APP_DEFAULT_LABEL, "Use app default");

// The section's count: parts this workspace sets of its own.
assert.equal(ownCount(null), 0);
assert.equal(ownCount(ws), 2);
assert.equal(ownCount(APP), 6);

// ── Round 2: an explicit "The tool's default", distinct from "Use app default" ──
assert.equal(FORCE_CLI_DEFAULT_LABEL, "The tool's default");
assert.equal(fieldKey("claude", "builder", "model"), "claude.builder");
assert.equal(fieldKey("codex", "challenger", "reasoning"), "codex.challengerReasoning");

// Forcing beats the app row, and the line says it is this workspace's.
let forced = withModelPart(null, "claude", "builder", "model", "The tool's default");
assert.deepEqual(forced, { claude: {}, codex: {}, cliDefault: ["claude.builder"] });
assert.equal(effectiveLine(forced, APP, "claude", "builder"), "Runs on the tool's default model (this workspace).");
assert.equal(fieldChoice(forced, "claude", "builder", "model"), "The tool's default");
assert.equal(ownCount(forced), 1);
// Case and spaces do not matter when typed.
assert.deepEqual(withModelPart(null, "codex", "builder", "model", "  cli DEFAULT "), {
  claude: {},
  codex: {},
  cliDefault: ["codex.builder"],
});
// Codex effort forced, the app's model kept.
forced = withModelPart(forced, "codex", "challenger", "reasoning", "The tool's default");
assert.equal(
  effectiveLine(forced, APP, "codex", "challenger"),
  "Runs on gpt-5.5 (app default), the tool's default effort (this workspace).",
);
assert.deepEqual(forced?.cliDefault, ["claude.builder", "codex.challengerReasoning"]);
// A value replaces the force; "Use app default" ("") clears both.
forced = withModelPart(forced, "claude", "builder", "model", "opus");
assert.deepEqual(forced, { claude: { builder: "opus" }, codex: {}, cliDefault: ["codex.challengerReasoning"] });
assert.equal(forcesCliDefault(forced, "claude", "builder", "model"), false);
forced = withModelPart(forced, "codex", "challenger", "reasoning", "");
forced = withModelPart(forced, "claude", "builder", "model", "");
assert.equal(forced, null);
// Normalizing drops a forced field's value and dedups the list.
assert.deepEqual(
  normalizeModels({ claude: { challenger: "sonnet" }, codex: {}, cliDefault: ["claude.challenger", "claude.challenger", " "] }),
  { claude: {}, codex: {}, cliDefault: ["claude.challenger"] },
);
// 1.169.0 (A1): Claude's effort can be forced too.
const claudeForced = withModelPart(null, "claude", "builder", "reasoning", "The tool's default");
assert.deepEqual(claudeForced, { claude: {}, codex: {}, cliDefault: ["claude.builderReasoning"] });
assert.equal(fieldKey("claude", "challenger", "reasoning"), "claude.challengerReasoning");
assert.equal(
  effectiveLine(claudeForced, { claude: { builder: "opus", builderReasoning: "max" }, codex: {} }, "claude", "builder"),
  "Runs on opus (app default), the tool's default effort (this workspace).",
);
// A rows-only block (before round 2) reads with nothing forced.
const old: WorkspaceModels = { claude: { builder: "opus" }, codex: {} };
assert.equal(forcesCliDefault(old, "claude", "builder", "model"), false);

// The pairing line's rows: workspace over app, forced as unset.
assert.deepEqual(
  effectiveRoleModels(
    { claude: { builder: "claude-fable-5-1" }, codex: {}, cliDefault: ["codex.challenger"] },
    APP,
  ),
  {
    claude: { builder: "claude-fable-5-1", challenger: "sonnet", builderReasoning: null, challengerReasoning: null },
    codex: { builder: "gpt-6-astra", challenger: null, builderReasoning: "high", challengerReasoning: "medium" },
  },
);
assert.deepEqual(effectiveRoleModels(null, NONE).claude, {
  builder: null,
  challenger: null,
  builderReasoning: null,
  challengerReasoning: null,
});

// F3: the pairing line follows the open workspace when it has rows.
assert.equal(
  pairingStatus("claude", APP, null),
  "Builder: Claude on opus · Reviewer: Codex on gpt-5.5 medium.",
);
assert.equal(pairingStatus("claude", APP, { name: "atelier", models: null }), pairingStatus("claude", APP, null));
assert.equal(
  pairingStatus("claude", APP, {
    name: "atelier",
    models: { claude: {}, codex: {}, cliDefault: ["claude.builder"] },
  }),
  "In atelier, with its own models — Builder: Claude on its own default · Reviewer: Codex on gpt-5.5 medium.",
);
// Walk 2026-10-23: an effort alone is said as one.
assert.match(
  pairingStatus("claude", APP, { name: "notes-app", models: { claude: { challengerReasoning: "max" }, codex: {} } }),
  /^In notes-app, with its own effort — /,
);
assert.match(
  pairingStatus("claude", APP, { name: "notes-app", models: { claude: { builder: "opus", builderReasoning: "max" }, codex: {} } }),
  /^In notes-app, with its own models and effort — /,
);

// ── 1.169.0 (A2): the team's suggestion between the workspace and the app ──
{
  const team: RoleModels = { claude: { challengerReasoning: "max" }, codex: { builder: "gpt-6.1-sol" } };
  const rows = withTeam(APP, team);
  assert.deepEqual(effectivePart(null, rows, "codex", "builder", "model"), { value: "gpt-6.1-sol", source: "team" });
  assert.deepEqual(effectivePart(null, rows, "codex", "builder", "reasoning"), { value: "high", source: "app" });
  assert.equal(effectiveLine(null, rows, "codex", "builder"), "Runs on gpt-6.1-sol (team), high effort (app default).");
  assert.equal(effectiveLine(null, rows, "claude", "challenger"), "Runs on sonnet (app default), max effort (team).");
  assert.equal(fallbackPlaceholder(rows, "codex", "builder", "model"), "gpt-6.1-sol (team)");
  // My workspace's own choice wins; forced still passes nothing.
  assert.equal(effectivePart({ claude: {}, codex: { builder: "gpt-6-luna" } }, rows, "codex", "builder", "model").source, "workspace");
  assert.deepEqual(
    effectivePart({ claude: {}, codex: {}, cliDefault: ["claude.challengerReasoning"] }, rows, "claude", "challenger", "reasoning"),
    { value: null, source: "forced" },
  );
  // No team: as before.
  assert.equal(withTeam(APP, null), APP);
  assert.match(pairingStatus("codex", rows, { name: "atelier", models: null }), /^With the team's suggestions — Builder: Codex on gpt-6.1-sol high/);
}

// A2 (Challenger 1, 9): an edit of the team's keeps every other key; nothing left is null.
{
  const raw = { codex: { builder: "gpt-6-luna", future: 2 }, later: 1 } as unknown as RoleModels;
  assert.deepEqual(withTeamPart(raw, "codex", "builder", "reasoning", "xhigh"), {
    codex: { builder: "gpt-6-luna", future: 2, builderReasoning: "xhigh" },
    later: 1,
  });
  assert.deepEqual(withTeamPart({ claude: { builder: "x" }, codex: {} }, "claude", "builder", "model", ""), null);
  assert.deepEqual(withTeamPart(null, "claude", "builder", "model", "The tool's default"), null, "a team suggests values only");
}
// A2 (Challenger 5): a team's effort the model doesn't take falls to my app's.
{
  const rows = withTeam(APP, { claude: {}, codex: { builder: "gpt-6-luna", builderReasoning: "ultra" } });
  const luna = (_m: string | null, e: string) => e !== "ultra";
  assert.deepEqual(effectiveEffort(null, rows, "codex", "builder", luna), { value: "high", source: "app" });
  assert.deepEqual(effectiveEffort(null, rows, "codex", "builder"), { value: "ultra", source: "team" });
  assert.equal(effectiveLine(null, rows, "codex", "builder", luna), "Runs on gpt-6-luna (team), high effort (app default).");
  assert.deepEqual(effectiveEffort(null, rows, "codex", "builder", () => false), { value: null, source: "cli" });
}

// 1.169.0 walk: the summary runs the effort the row runs (fall-through).
{
  const rows = withTeam(APP, { claude: {}, codex: { builder: "gpt-6-luna", builderReasoning: "ultra" } });
  const luna = () => (_m: string | null, e: string) => e !== "ultra";
  assert.match(pairingStatus("codex", rows, null, luna), /Builder: Codex on gpt-6-luna high/);
}

// 1.174.0 (DS4, settings.html scenes 6–8): AI and models' summaries.
{
  const named = (_v: string, id: string) => (id === "claude-opus-5-5" ? "Opus 5.5" : id === "claude-sonnet-5" ? "Sonnet" : id);
  assert.equal(
    vendorSummary({ claude: { builder: "claude-opus-5-5", builderReasoning: "high" }, codex: {} }, "claude", named),
    "Builder: Opus 5.5 · high effort · Reviewer: the tool's default",
  );
  assert.equal(vendorSummary({ claude: {}, codex: {} }, "codex", named), "Builder: the tool's default · Reviewer: the tool's default");
  assert.equal(
    vendorSummary({ claude: {}, codex: { challengerReasoning: "low" } }, "codex", named),
    "Builder: the tool's default · Reviewer: the tool's default · low effort",
  );
  assert.equal(onlyInSummary(null, named), null, "nothing of its own");
  assert.equal(onlyInSummary({ claude: {}, codex: {} }, named), null);
  assert.equal(
    onlyInSummary({ claude: { builder: "claude-sonnet-5", builderReasoning: "medium" }, codex: {} }, named),
    "Claude Builder: Sonnet · medium. The rest follows the rows above.",
  );
  assert.equal(
    onlyInSummary({ claude: {}, codex: { challengerReasoning: "low" }, cliDefault: ["claude.builder"] }, named),
    "Claude Builder: the tool's default; Codex Reviewer: the tool's default · low. The rest follows the rows above.",
  );
  assert.equal(
    onlyInSummary({ claude: {}, codex: {}, cliDefault: ["codex.builderReasoning"] }, named),
    "Codex Builder: the tool's default effort. The rest follows the rows above.",
  );
  assert.equal(onlyInVendor({ claude: {}, codex: { builder: "x" } }, "claude"), "codex");
  assert.equal(onlyInVendor(null, "codex"), "codex");
  assert.equal(ownsRole({ claude: {}, codex: {}, cliDefault: ["claude.challenger"] }, "claude", "challenger"), true);
  assert.equal(ownsRole({ claude: {}, codex: {} }, "claude", "builder"), false);
  assert.equal(teamSummary(null, "codex", named), "None suggested");
  assert.equal(
    teamSummary({ claude: { builder: "claude-sonnet-5", builderReasoning: "medium" }, codex: {} }, "claude", named),
    "Builder: Sonnet · medium · Reviewer: none suggested",
  );
  assert.equal(
    teamSuggestsLine({ claude: { builder: "claude-sonnet-5", builderReasoning: "medium" }, codex: {} }, "claude", "builder", named),
    "The team suggests Sonnet · medium (Project › General).",
  );
  assert.equal(teamSuggestsLine(null, "claude", "challenger", named), null);
}

console.log("workspaceModels: ok");
