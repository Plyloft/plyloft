import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  FALLBACK_CATALOG,
  effortFit,
  effortLevels,
  effortOptions,
  fitEffort,
  latestPerFamily,
  modelSuggestions,
  unsupportedEffortLine,
  type ModelCatalog,
} from "./modelCatalog.ts";
import { builderModelFact, cardRoleModel, challengerModelFact } from "./cardModels.ts";
import { startModelPrefill, startModelsRequest } from "./buildBoth.ts";

// 1.169.0 (A1): the bundled file the site publishes (src-tauri/catalog/models.json).
const bundled = JSON.parse(readFileSync(new URL("../../src-tauri/catalog/models.json", import.meta.url), "utf8"));
assert.equal(bundled.schemaVersion, 1);
// The fallback before the app answers names the same levels as the file.
assert.deepEqual(FALLBACK_CATALOG.claude.efforts, bundled.vendors.claude.efforts);
assert.deepEqual(FALLBACK_CATALOG.codex.efforts, bundled.vendors.codex.efforts);
assert.ok(!FALLBACK_CATALOG.codex.efforts.includes("minimal"), "minimal is no longer offered");

const catalog: ModelCatalog = {
  claude: bundled.vendors.claude,
  codex: bundled.vendors.codex,
  fileFrom: "bundled",
  claudeEffort: true,
};

// Owner D2: only the newest of each family, the rule held by both sides.
const families = JSON.parse(readFileSync(new URL("./modelFamilies.fixtures.json", import.meta.url), "utf8"));
for (const c of families.cases) assert.deepEqual(latestPerFamily(c.ids), c.latest, c.ids.join(", "));
assert.deepEqual(
  modelSuggestions(catalog, "claude").map((o) => o.value),
  ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"],
);
assert.deepEqual(
  modelSuggestions(catalog, "codex").map((o) => o.value),
  ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-terra"],
);
// Hidden models (Codex's, the app's older ones) are never offered, but their levels count.
const withHidden: ModelCatalog = {
  ...catalog,
  codex: { efforts: ["low"], models: [{ id: "gpt-9-sol", label: "x" }, { id: "gpt-reserve", label: "R", hidden: true, efforts: ["max"] }] },
};
assert.deepEqual(modelSuggestions(withHidden, "codex"), [{ value: "gpt-9-sol", hint: "x" }]);
assert.equal(effortFit(withHidden, "codex", "gpt-reserve", "low"), "unsupported");

// Suggestions: the id, with the label under it when it says more.
const claude = modelSuggestions(catalog, "claude");
assert.deepEqual(claude[0], { value: "claude-opus-5-5", hint: "Opus 5.5" });
assert.deepEqual(modelSuggestions({ ...catalog, codex: { efforts: [], models: [{ id: "x", label: "X" }] } }, "codex"), [
  { value: "x" },
]);
assert.deepEqual(modelSuggestions(FALLBACK_CATALOG, "codex"), []);

// Levels: the model's own, else the vendor's.
assert.deepEqual(effortLevels(catalog, "codex", "gpt-6-luna"), ["low", "medium", "high", "xhigh", "max"]);
assert.deepEqual(effortLevels(catalog, "codex", "gpt-5.5"), bundled.vendors.codex.efforts);
assert.deepEqual(effortLevels(catalog, "codex", null), bundled.vendors.codex.efforts);
assert.deepEqual(effortLevels(catalog, "claude", "claude-opus-5-5"), ["low", "medium", "high", "xhigh", "max"]);
// An older version, no longer offered, keeps its own levels.
assert.deepEqual(effortLevels(catalog, "codex", "gpt-5.6-luna"), ["low", "medium", "high", "xhigh", "max"]);

// Owner decision 3 (da confermare): a saved minimal on a listed model is not
// available there; on an unknown model it is passed as before.
assert.equal(effortFit(catalog, "codex", "gpt-6-astra", "minimal"), "unsupported");
assert.equal(effortFit(catalog, "codex", "gpt-6-astra", "xhigh"), "ok");
assert.equal(effortFit(catalog, "codex", "gpt-5.5", "minimal"), "unknown");
// Finding 2: no model chosen and a level the vendor doesn't take at all.
assert.equal(effortFit(catalog, "codex", null, "minimal"), "unsupported");
assert.equal(effortFit(catalog, "codex", null, "high"), "ok");
assert.equal(unsupportedEffortLine(catalog, "codex", null, "minimal"), "minimal isn't available, so the tool's default effort runs.");
assert.equal(effortOptions(catalog, "codex", null, "minimal", [{ value: "", label: "x" }]).pop()?.label, "minimal (not on this model)");
assert.equal(effortFit(catalog, "claude", "opus", "max"), "unknown");
// Finding 1: a Claude Code too old for --effort passes none, and says so.
const oldClaude: ModelCatalog = { ...catalog, claudeEffort: false };
assert.equal(effortFit(oldClaude, "claude", "opus", "high"), "cli");
assert.deepEqual(fitEffort(oldClaude, "claude", { model: "opus", reasoning: "high" }), { model: "opus", reasoning: null });
assert.equal(unsupportedEffortLine(oldClaude, "claude", "opus", "high"), "Effort needs Claude Code 2.1.111 or later, so none is passed.");
assert.equal(
  unsupportedEffortLine({ ...oldClaude, claudeEffortWhy: "tooOld" }, "claude", "opus", "high"),
  "Effort needs Claude Code 2.1.111 or later, so none is passed.",
);
assert.equal(
  unsupportedEffortLine({ ...oldClaude, claudeEffortWhy: "notInstalled" }, "claude", "opus", "high"),
  "Claude Code isn't installed, so no effort is passed.",
);
assert.equal(
  unsupportedEffortLine({ ...oldClaude, claudeEffortWhy: "versionUnknown" }, "claude", "opus", "high"),
  "Claude Code's version couldn't be read, so no effort is passed.",
);
assert.equal(
  effortOptions(oldClaude, "claude", "opus", "high", [{ value: "", label: "x" }]).find((o) => o.value === "high")?.label,
  "high (not available)",
);
assert.equal(effortFit(oldClaude, "codex", "gpt-6-astra", "high"), "ok", "Codex never depends on it");
assert.equal(effortFit({ ...catalog, claudeEffort: undefined }, "claude", "opus", "high"), "unknown");
assert.equal(effortFit(catalog, "codex", "gpt-6-astra", ""), "ok");
assert.deepEqual(fitEffort(catalog, "codex", { model: "gpt-6-astra", reasoning: "minimal" }), {
  model: "gpt-6-astra",
  reasoning: null,
});
assert.deepEqual(fitEffort(catalog, "codex", { model: "gpt-5.5", reasoning: "minimal" }), {
  model: "gpt-5.5",
  reasoning: "minimal",
});
assert.deepEqual(fitEffort(null, "codex", { model: "gpt-6-astra", reasoning: "minimal" }), {
  model: "gpt-6-astra",
  reasoning: "minimal",
});
assert.equal(
  unsupportedEffortLine(catalog, "codex", "gpt-6-astra", "minimal"),
  "minimal isn't available on gpt-6-astra, so it runs at that model's own default.",
);
assert.equal(unsupportedEffortLine(catalog, "codex", "gpt-5.5", "minimal"), null);

// The picker never loses a stored level: shown as not on this model, or plain.
const head = [{ value: "", label: "The tool's default" }];
const astra = effortOptions(catalog, "codex", "gpt-6-astra", "minimal", head);
assert.deepEqual(astra[0], head[0]);
assert.deepEqual(astra[astra.length - 1], { value: "minimal", label: "minimal (not on this model)" });
assert.ok(!astra.slice(1, -1).some((o) => o.value === "minimal"));
const unknown = effortOptions(catalog, "codex", "gpt-5.5", "minimal", head);
assert.deepEqual(unknown[unknown.length - 1], { value: "minimal", label: "minimal" });
assert.equal(effortOptions(catalog, "codex", "gpt-6-astra", "high", head).length, 1 + 6);
assert.equal(effortOptions(catalog, "claude", "opus", "", head).length, 1 + 5);

// The card's chips name only what a spawn passes (with the catalog).
const card = { models: { claude: { builderReasoning: "high" }, codex: { builder: "gpt-6-astra", builderReasoning: "minimal" } } };
assert.equal(builderModelFact(card, null, { claude: { builder: "opus" }, codex: {} }, "claude", oldClaude).next, "opus");
const app = { claude: { builder: "opus" }, codex: {} };
assert.deepEqual(cardRoleModel(card.models, null, app, "claude", "builder"), { model: "opus", reasoning: "high" });
assert.deepEqual(cardRoleModel(card.models, null, app, "codex", "builder", catalog), { model: "gpt-6-astra", reasoning: null });
assert.deepEqual(cardRoleModel(card.models, null, app, "codex", "builder"), { model: "gpt-6-astra", reasoning: "minimal" });
assert.equal(builderModelFact(card, null, app, "claude", catalog).next, "opus high");
assert.equal(builderModelFact(card, null, app, "codex", catalog).next, "gpt-6-astra");
assert.equal(
  builderModelFact({ builder: { vendor: "claude", chosenModel: { model: null, reasoning: "low" } } }, null, app, "claude", catalog).next,
  "low effort",
);
assert.equal(
  challengerModelFact({ models: { claude: { challenger: "sonnet", challengerReasoning: "xhigh" }, codex: {} } }, null, app, "claude", catalog).next,
  "sonnet xhigh",
);

// Build with both: Claude's effort is prefilled and sent.
assert.deepEqual(startModelPrefill(null, { claude: { builder: "opus", builderReasoning: "max" }, codex: {} }, "claude"), {
  model: "opus",
  reasoning: "max",
  from: "opus (app default), max effort (app default)",
});
assert.deepEqual(startModelsRequest({ claude: { model: " opus ", reasoning: " high " }, codex: { model: "", reasoning: "" } }), {
  claude: { model: "opus", reasoning: "high" },
  codex: { model: null, reasoning: null },
});

// A2 (Challenger 5): the card's chip follows the fall-through too.
{
  const rows = { claude: {}, codex: { builderReasoning: "high" }, team: { claude: {}, codex: { builder: "gpt-6-luna", builderReasoning: "ultra" } } };
  assert.deepEqual(cardRoleModel(null, null, rows, "codex", "builder", catalog), { model: "gpt-6-luna", reasoning: "high" });
  assert.equal(
    unsupportedEffortLine(catalog, "codex", "gpt-6-luna", "ultra", "high"),
    "ultra isn't available on gpt-6-luna, so it runs at high effort.",
  );
}

console.log("modelCatalog: ok");
