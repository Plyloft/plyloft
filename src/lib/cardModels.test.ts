// 1.168.1 (E2/E3) pure contract: a card's own models over the workspace's
// and the app's, and what the card's model chips say.
// Run with:
//   node --experimental-strip-types src/lib/cardModels.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { RoleModels } from "./roleModels.ts";
import { FORCE_CLI_DEFAULT_LABEL, withTeam, type WorkspaceModels } from "./workspaceModels.ts";
import {
  TOOL_DEFAULT_WORDS,
  builderModelFact,
  cardEffectiveEffort,
  cardEffectivePart,
  cardModelLine,
  cardModelWords,
  cardRoleModel,
  cardSetsRole,
  challengerModelFact,
  challengerVendorOf,
  modelFactWords,
  usedModelWords,
  withCardModelPart,
  withoutCardRole,
} from "./cardModels.ts";

const app: RoleModels = {
  claude: { builder: "opus", challenger: "sonnet" },
  codex: { builder: "gpt-6-astra", challenger: "gpt-5.5", builderReasoning: "high", challengerReasoning: "medium" },
};
const ws: WorkspaceModels = { claude: { builder: "claude-fable-5-1" }, codex: { builderReasoning: "low" } };

// No card choice: the workspace's resolution, field by field.
assert.deepEqual(cardRoleModel(null, ws, app, "claude", "builder"), { model: "claude-fable-5-1", reasoning: null });
assert.deepEqual(cardRoleModel(null, ws, app, "codex", "builder"), { model: "gpt-6-astra", reasoning: "low" });
assert.equal(cardModelWords(null, null, { claude: {}, codex: {} }, "codex", "challenger"), TOOL_DEFAULT_WORDS);

// The card first, blank falls through, forced passes nothing.
const card: WorkspaceModels = { claude: { builder: "sonnet" }, codex: { builder: "gpt-7" } };
assert.deepEqual(cardEffectivePart(card, ws, app, "claude", "builder", "model"), { value: "sonnet", source: "card" });
assert.deepEqual(cardRoleModel(card, ws, app, "codex", "builder"), { model: "gpt-7", reasoning: "low" });
assert.equal(cardModelWords(card, ws, app, "codex", "builder"), "gpt-7 low");
const forced = withCardModelPart(card, "codex", "builder", "reasoning", FORCE_CLI_DEFAULT_LABEL);
assert.deepEqual(cardRoleModel(forced, ws, app, "codex", "builder"), { model: "gpt-7", reasoning: null });
assert.equal(
  cardModelLine(forced, ws, app, "codex", "builder"),
  "Runs on gpt-7 (this card), the tool's default effort (this card).",
);
assert.equal(cardModelLine(card, ws, app, "claude", "challenger"), "Runs on sonnet (app default).");
assert.equal(cardModelLine(null, null, { claude: {}, codex: {} }, "claude", "builder"), "Runs on the tool's default model.");
assert.equal(cardModelLine(card, ws, app, "codex", "builder"), "Runs on gpt-7 (this card), low effort (this workspace).");

// Set / cleared per vendor and role; "Use the workspace's" keeps the rest.
assert.equal(cardSetsRole(card, "claude", "builder"), true);
assert.equal(cardSetsRole(card, "claude", "challenger"), false);
assert.equal(cardSetsRole(forced, "codex", "builder"), true);
const cleared = withoutCardRole(forced, "codex", "builder");
assert.deepEqual(cleared, { claude: { builder: "sonnet" }, codex: {} });
assert.equal(withoutCardRole(cleared, "claude", "builder"), null, "nothing left: no models key");
assert.equal(withCardModelPart(null, "claude", "builder", "model", "  "), null);

// E3: the chips.
const idle = { models: card, builder: { vendor: "claude" as const, model: "opus", ptyId: null } };
assert.deepEqual(builderModelFact(idle, ws, app, "claude"), { vendor: "claude", next: "sonnet", running: null, fromBuildBoth: false });
const live = { models: card, builder: { vendor: "claude" as const, model: null, ptyId: "p1" } };
const liveFact = builderModelFact(live, ws, app, "claude");
assert.equal(liveFact.running, TOOL_DEFAULT_WORDS, "a session with no model passed runs on the tool's default");
assert.equal(modelFactWords(liveFact), "the tool's default now · sonnet next");
const same = { models: card, builder: { vendor: "claude" as const, model: "sonnet", ptyId: "p1" } };
assert.equal(modelFactWords(builderModelFact(same, ws, app, "claude")), "sonnet");
// A Build with both choice for the same vendor comes first; not for the other.
const both = { models: card, builder: { vendor: "codex" as const, ptyId: null, chosenModel: { model: "gpt-5.5", reasoning: "high" } } };
assert.deepEqual(builderModelFact(both, ws, app, "codex"), { vendor: "codex", next: "gpt-5.5 high", running: null, fromBuildBoth: true });
assert.equal(builderModelFact(both, ws, app, "claude").next, "sonnet");
// Before any build: the card's or the rows'.
assert.equal(builderModelFact({ models: null, builder: null }, null, app, "codex").next, "gpt-6-astra high");

// The Challenger's vendor, as the backend picks it.
assert.equal(challengerVendorOf({}, "claude", true), "codex", "the other one");
assert.equal(challengerVendorOf({}, "claude", undefined), "codex", "unknown counts as installed");
assert.equal(challengerVendorOf({}, "claude", false), "claude", "one AI: the Builder's own");
assert.equal(
  challengerVendorOf({ builder: { vendor: "claude", review: { status: "done", provider: "claude" } } }, "claude", true),
  "claude",
  "the latest review's vendor",
);
assert.equal(
  challengerVendorOf(
    { prReview: { challenger: "claude" }, builder: { vendor: "claude", review: { status: "done", provider: "codex" } } },
    "claude",
    true,
  ),
  "claude",
  "a pull request's chosen Reviewer first",
);

// A running review names its own.
assert.deepEqual(challengerModelFact({ models: null }, ws, app, "codex"), {
  vendor: "codex",
  next: "gpt-5.5 medium",
  running: null,
  fromBuildBoth: false,
});
const reviewing = {
  models: { claude: {}, codex: { challenger: "gpt-7" } },
  builder: { vendor: "claude" as const, review: { status: "running", model: "gpt-5.5 medium" } },
};
assert.equal(modelFactWords(challengerModelFact(reviewing, ws, app, "codex")), "gpt-5.5 medium now · gpt-7 medium next");
const sameModel = { ...reviewing, builder: { ...reviewing.builder, review: { status: "running", model: "gpt-7 medium" } } };
assert.equal(modelFactWords(challengerModelFact(sameModel, ws, app, "codex")), "gpt-7 medium", "no false \"now\"");
const unknown = { ...reviewing, builder: { ...reviewing.builder, review: { status: "running", model: null } } };
assert.equal(modelFactWords(challengerModelFact(unknown, ws, app, "codex")), "gpt-7 medium", "a running review with no model claims no \"now\"");

assert.equal(usedModelWords(null), TOOL_DEFAULT_WORDS);
assert.equal(usedModelWords(" opus "), "opus");

// 1.169.0 (A2): a chip says when the next one is the team's suggestion.
{
  const rows = withTeam({ claude: { builder: "claude-opus-5-5" }, codex: {} }, { claude: { builderReasoning: "high" }, codex: {} });
  const fact = builderModelFact({ models: null }, null, rows, "claude");
  assert.equal(fact.next, "claude-opus-5-5 high");
  assert.equal(modelFactWords(fact), "claude-opus-5-5 high · Team");
  assert.equal(cardModelLine(null, null, rows, "claude", "builder"), "Runs on claude-opus-5-5 (app default), high effort (team).");
  const own = builderModelFact({ models: { claude: { builderReasoning: "low" }, codex: {} } }, null, rows, "claude");
  assert.equal(modelFactWords(own), "claude-opus-5-5 low", "the card's own choice: not the team's");
}

// CH-4 (1.174.0): the layers, held to the same fixtures as
// `settings.rs::resolve_card_model_fitted` (src/lib/cardModels.fixtures.json).
{
  type Fixture = {
    name: string;
    card: WorkspaceModels | null;
    workspace: WorkspaceModels | null;
    team: RoleModels | null;
    app: RoleModels;
    vendor: "claude" | "codex";
    role: "builder" | "challenger";
    fits?: Record<string, string[]>;
    expected: { model: string | null; reasoning: string | null };
  };
  const fixtures: { cases: Fixture[] } = JSON.parse(readFileSync(new URL("./cardModels.fixtures.json", import.meta.url), "utf8"));
  assert.ok(fixtures.cases.length >= 10);
  for (const c of fixtures.cases) {
    const rows = withTeam(c.app, c.team);
    const fits = c.fits ? (model: string | null, effort: string) => !model || !c.fits![model] || c.fits![model]!.includes(effort) : undefined;
    const got = {
      model: cardEffectivePart(c.card, c.workspace, rows, c.vendor, c.role, "model").value,
      reasoning: cardEffectiveEffort(c.card, c.workspace, rows, c.vendor, c.role, fits).value,
    };
    assert.deepEqual(got, c.expected, c.name);
    if (!c.fits) assert.deepEqual(cardRoleModel(c.card, c.workspace, rows, c.vendor, c.role), c.expected, `${c.name} (cardRoleModel)`);
  }
}

console.log("cardModels: ok");
