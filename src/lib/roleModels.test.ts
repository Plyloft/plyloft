import assert from "node:assert/strict";

import {
  challengerVendor,
  modelLabel,
  rolePairingLine,
  roleModelLabel,
  EMPTY_ROLE_MODELS,
  effortWord,
  modelDetailWords,
  modelSentenceWords,
  splitModelLabel,
  type RoleModels,
} from "./roleModels.ts";

// #74: Ply passed no model to either role, so both ran whatever the
// vendor CLI defaulted to on that Mac and one vendor's two roles could
// not differ. These are the pure rules the Settings rows and the pairing
// line read; they mirror settings.rs (`for_role`, `ModelChoice::label`).

{
  // Nothing set anywhere: every label is null, which is "the CLI decides".
  assert.equal(roleModelLabel(EMPTY_ROLE_MODELS, "claude", "builder"), null);
  assert.equal(roleModelLabel(EMPTY_ROLE_MODELS, "claude", "challenger"), null);
  assert.equal(roleModelLabel(EMPTY_ROLE_MODELS, "codex", "builder"), null);
  assert.equal(roleModelLabel(EMPTY_ROLE_MODELS, "codex", "challenger"), null);
}

{
  assert.equal(modelLabel(null), null);
  assert.equal(modelLabel("  "), null);
  assert.equal(modelLabel("opus"), "opus");
  assert.equal(modelLabel(" opus "), "opus");
  assert.equal(modelLabel("gpt-6-astra", "medium"), "gpt-6-astra medium");
  // Effort without a model is still a real choice.
  assert.equal(modelLabel(null, "low"), "low effort");
  assert.equal(modelLabel("opus", "   "), "opus");
  // 1.169.0 (A1): Claude's effort — "opus high", alone "high effort".
  assert.equal(modelLabel("opus", "high", "claude"), "opus high");
  assert.equal(modelLabel(null, "high", "claude"), "high effort");
  assert.equal(effortWord("codex"), "effort", "owner D1: one word for both");
  assert.equal(effortWord("claude"), "effort");
  assert.equal(
    roleModelLabel({ claude: { builder: "opus", builderReasoning: "max" }, codex: {} }, "claude", "builder"),
    "opus max",
  );
  assert.equal(roleModelLabel({ claude: { challengerReasoning: "low" }, codex: {} }, "claude", "challenger"), "low effort");
}

{
  // The two roles of one vendor differ — the whole point of #74.
  const models: RoleModels = {
    claude: { builder: "opus", challenger: "sonnet" },
    codex: {
      builder: "gpt-5.5",
      builderReasoning: "high",
      challenger: "gpt-6-astra",
      challengerReasoning: "medium",
    },
  };
  assert.equal(roleModelLabel(models, "claude", "builder"), "opus");
  assert.equal(roleModelLabel(models, "claude", "challenger"), "sonnet");
  assert.equal(roleModelLabel(models, "codex", "builder"), "gpt-5.5 high");
  assert.equal(roleModelLabel(models, "codex", "challenger"), "gpt-6-astra medium");

  // D1: the Challenger is always the other vendor.
  assert.equal(challengerVendor("claude"), "codex");
  assert.equal(challengerVendor("codex"), "claude");

  assert.equal(
    rolePairingLine("claude", models),
    "Builder: Claude on opus · Reviewer: Codex on gpt-6-astra medium.",
  );
  // Swap the vendor and the same rows pair the other way round.
  assert.equal(
    rolePairingLine("codex", models),
    "Builder: Codex on gpt-5.5 high · Reviewer: Claude on sonnet.",
  );
}

{
  // Blank everything: back to the CLI defaults, and the line says so.
  assert.equal(
    rolePairingLine("claude", EMPTY_ROLE_MODELS),
    "Builder: Claude on its own default · Reviewer: Codex on its own default.",
  );
  // A partially filled block only names what was filled.
  assert.equal(
    rolePairingLine("claude", { claude: { builder: "opus" }, codex: {} }),
    "Builder: Claude on opus · Reviewer: Codex on its own default.",
  );
}

{
  // Walk 2026-10-23: a recorded label read back in a sentence and a fact row.
  assert.deepEqual(splitModelLabel("gpt-6-astra high"), { model: "gpt-6-astra", effort: "high" });
  assert.deepEqual(splitModelLabel("opus"), { model: "opus", effort: null });
  assert.deepEqual(splitModelLabel("low effort"), { model: null, effort: "low" });
  assert.deepEqual(splitModelLabel("low reasoning"), { model: null, effort: "low" }, "a record from before D1");
  assert.deepEqual(splitModelLabel(null), { model: null, effort: null });
  assert.equal(modelSentenceWords("gpt-6-astra high"), "gpt-6-astra with high effort");
  assert.equal(modelSentenceWords("claude-opus-5-5"), "claude-opus-5-5");
  assert.equal(modelSentenceWords("low effort"), "low effort");
  assert.equal(modelDetailWords("claude-opus-5-5 xhigh"), "claude-opus-5-5, xhigh effort");
  assert.equal(modelDetailWords(" "), null);
}

console.log("role model settings tests passed");
