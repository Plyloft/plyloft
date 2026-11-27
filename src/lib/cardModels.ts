/**
 * 1.168.1 (E2/E3): the models chosen for one card only (`card.models`, this
 * Mac only, never synced to GitHub), over the workspace's rows and the
 * app's, field by field.
 *
 * Pure, and the mirror of `settings.rs::resolve_card_model` (both held to
 * `cardModels.fixtures.json`, CH-4). A card's field
 * has the same three states as a workspace's (`workspaceModels.ts`): blank —
 * the workspace's (else the app's, else the tool's own default); a value;
 * named in `cliDefault` — no flag on this card, whatever is set above it.
 *
 * Every spawn for the card reads it: the Builder (start, Resume, Start
 * fresh), the Challenger's reviews, Plan it, Plan with two AIs, the card's
 * Chat and Build with both's builds (when no model was chosen for a build
 * at its start). A running session keeps the model it started with.
 */

import {
  challengerVendor,
  effortWord,
  modelDetailWords,
  modelLabel,
  type AgentRole,
  type AgentVendor,
} from "./roleModels.ts";
import {
  effectivePart,
  fieldChoice,
  forcesCliDefault,
  normalizeModels,
  rowValue,
  withModelPart,
  TEAM_LABEL,
  pickEffort,
  workspaceEffortLayers,
  type AppRows,
  type EffortFits,
  type ModelPart,
  type ModelSource,
  type WorkspaceModels,
} from "./workspaceModels.ts";
import { effortFit, fitEffort, type ModelCatalog } from "./modelCatalog.ts";

/** The first choice of a card's model field: nothing of the card's own. */
export const USE_WORKSPACE_LABEL = "Use the workspace's";

/** What a field with nothing chosen anywhere runs on. */
export const TOOL_DEFAULT_WORDS = "the tool's default";

/** Where a card's effective value comes from. */
export type CardModelSource = ModelSource | "card" | "cardForced";

/** One part's effective value for the card and where it comes from. */
export function cardEffectivePart(
  card: WorkspaceModels | null | undefined,
  workspace: WorkspaceModels | null | undefined,
  app: AppRows,
  vendor: AgentVendor,
  role: AgentRole,
  part: ModelPart,
): { value: string | null; source: CardModelSource } {
  if (forcesCliDefault(card, vendor, role, part)) return { value: null, source: "cardForced" };
  const own = rowValue(card, vendor, role, part);
  if (own) return { value: own, source: "card" };
  return effectivePart(workspace, app, vendor, role, part);
}

/** Whether an effort runs on a model, by the catalog (none: any does). */
export function catalogFits(catalog: ModelCatalog | null | undefined, vendor: AgentVendor): EffortFits | undefined {
  return catalog ? (model, effort) => effortFit(catalog, vendor, model, effort) !== "unsupported" : undefined;
}

/** A2 (Challenger 5): the card's effort — its own, else down the layers —
 *  the first that fits the model it runs on. */
export function cardEffectiveEffort(
  card: WorkspaceModels | null | undefined,
  workspace: WorkspaceModels | null | undefined,
  app: AppRows,
  vendor: AgentVendor,
  role: AgentRole,
  fits?: EffortFits,
): { value: string | null; source: CardModelSource } {
  const model = cardEffectivePart(card, workspace, app, vendor, role, "model").value;
  const own: { value: string | null; source: CardModelSource }[] = forcesCliDefault(card, vendor, role, "reasoning")
    ? [{ value: null, source: "cardForced" }]
    : [{ value: rowValue(card, vendor, role, "reasoning") || null, source: "card" }];
  return pickEffort<CardModelSource>([...own, ...workspaceEffortLayers(workspace, app, vendor, role)], model, fits) as {
    value: string | null;
    source: CardModelSource;
  };
}

/** The model and effort a spawn of `vendor` in `role` for this card passes;
 *  null parts pass no flag. With the catalog (1.169.0 A1), an effort the
 *  model is known not to take is dropped, as the spawn drops it. */
export function cardRoleModel(
  card: WorkspaceModels | null | undefined,
  workspace: WorkspaceModels | null | undefined,
  app: AppRows,
  vendor: AgentVendor,
  role: AgentRole,
  catalog?: ModelCatalog | null,
): { model: string | null; reasoning: string | null } {
  return fitEffort(catalog, vendor, {
    model: cardEffectivePart(card, workspace, app, vendor, role, "model").value,
    reasoning: cardEffectiveEffort(card, workspace, app, vendor, role, catalogFits(catalog, vendor)).value,
  });
}

/** How that reads: `opus`, `gpt-5.5 high`, `high effort`, or
 *  "the tool's default" when nothing is chosen anywhere. */
export function cardModelWords(
  card: WorkspaceModels | null | undefined,
  workspace: WorkspaceModels | null | undefined,
  app: AppRows,
  vendor: AgentVendor,
  role: AgentRole,
  catalog?: ModelCatalog | null,
): string {
  const m = cardRoleModel(card, workspace, app, vendor, role, catalog);
  return modelLabel(m.model, m.reasoning, vendor) ?? TOOL_DEFAULT_WORDS;
}

const SOURCE_WORDS: Record<CardModelSource, string> = {
  card: "this card",
  cardForced: "this card",
  workspace: "this workspace",
  forced: "this workspace",
  team: "team",
  app: "app default",
  cli: "",
};

/** The line in the card's model menu: what the role will run on and where
 *  each part comes from — `Runs on opus (this card).`,
 *  `Runs on gpt-5.5 (app default), high effort (this card).`,
 *  `Runs on the tool's default model.` */
export function cardModelLine(
  card: WorkspaceModels | null | undefined,
  workspace: WorkspaceModels | null | undefined,
  app: AppRows,
  vendor: AgentVendor,
  role: AgentRole,
  catalog?: ModelCatalog | null,
): string {
  const from = (source: CardModelSource) => (SOURCE_WORDS[source] ? ` (${SOURCE_WORDS[source]})` : "");
  const model = cardEffectivePart(card, workspace, app, vendor, role, "model");
  const head = model.value ? `${model.value}${from(model.source)}` : `the tool's default model${from(model.source)}`;
  const effort = cardEffectiveEffort(card, workspace, app, vendor, role, catalogFits(catalog, vendor));
  const word = effortWord(vendor);
  if (effort.source === "cli") return `Runs on ${head}.`;
  if (!effort.value) return `Runs on ${head}, the tool's default ${word}${from(effort.source)}.`;
  return `Runs on ${head}, ${effort.value} ${word}${from(effort.source)}.`;
}

/** The card chooses something of its own for this vendor and role. */
export function cardSetsRole(
  card: WorkspaceModels | null | undefined,
  vendor: AgentVendor,
  role: AgentRole,
): boolean {
  return fieldChoice(card, vendor, role, "model") !== "" || fieldChoice(card, vendor, role, "reasoning") !== "";
}

/** The card's models with one part changed: "" is the workspace's, the
 *  tool's-default label forces no flag, anything else is that value. */
export function withCardModelPart(
  card: WorkspaceModels | null | undefined,
  vendor: AgentVendor,
  role: AgentRole,
  part: ModelPart,
  choice: string,
): WorkspaceModels | null {
  return withModelPart(card, vendor, role, part, choice);
}

/** "Use the workspace's": the card's own model and effort for this vendor
 *  and role cleared; the rest of the card's choices kept. */
export function withoutCardRole(
  card: WorkspaceModels | null | undefined,
  vendor: AgentVendor,
  role: AgentRole,
): WorkspaceModels | null {
  const next = withModelPart(withModelPart(card, vendor, role, "model", ""), vendor, role, "reasoning", "");
  return normalizeModels(next);
}

type ModelCard = {
  models?: WorkspaceModels | null;
  prReview?: { challenger?: AgentVendor | null } | null;
  builder?: {
    vendor: AgentVendor;
    model?: string | null;
    ptyId?: string | null;
    chosenModel?: { model?: string | null; reasoning?: string | null } | null;
    review?: { status: string; provider?: string | null; model?: string | null } | null;
  } | null;
};

/** What a role's model chip on the card says (E3): the model its next
 *  session (or review) runs on, and — while one runs on another — the one
 *  it runs on now. Only what Plyloft passed is named; with nothing passed it
 *  says "the tool's default", never a model name it can't know. */
export interface RoleModelFact {
  vendor: AgentVendor;
  /** The next session's (or review's) model, in words. */
  next: string;
  /** The running session's (or review's), when it differs from `next`. */
  running: string | null;
  /** From Build with both's start, not the card's or the rows. */
  fromBuildBoth: boolean;
  /** 1.169.0 (A2): the next one's model or effort is the team's suggestion. */
  fromTeam?: boolean;
}

/** The Builder's: a Build with both choice for the same vendor first (as
 *  `builder::chosen_model_for`), else the card's, the workspace's, the
 *  app's. */
export function builderModelFact(
  card: ModelCard,
  workspace: WorkspaceModels | null | undefined,
  app: AppRows,
  vendor: AgentVendor,
  catalog?: ModelCatalog | null,
): RoleModelFact {
  const chosen = card.builder?.vendor === vendor ? card.builder?.chosenModel ?? null : null;
  const fitted = chosen
    ? fitEffort(catalog, vendor, { model: chosen.model?.trim() || null, reasoning: chosen.reasoning?.trim() || null })
    : null;
  const next = fitted
    ? modelLabel(fitted.model, fitted.reasoning, vendor) ?? TOOL_DEFAULT_WORDS
    : cardModelWords(card.models, workspace, app, vendor, "builder", catalog);
  const live = Boolean(card.builder?.ptyId) && card.builder?.vendor === vendor;
  const now = live ? card.builder?.model?.trim() || TOOL_DEFAULT_WORDS : null;
  return {
    vendor,
    next,
    running: now !== null && now !== next ? now : null,
    fromBuildBoth: Boolean(chosen),
    ...(!chosen && fromTeamRows(card.models, workspace, app, vendor, "builder") ? { fromTeam: true } : {}),
  };
}

/** The vendor the card's Challenger reviews with, as `builder.rs::
 *  review_snapshot` picks it: a pull request review's chosen Challenger
 *  first; else the vendor of the card's latest review; else the other vendor
 *  of the Builder's when it is installed, else the Builder's own (OB-14: one
 *  AI is enough). `otherInstalled` unknown counts as installed. */
export function challengerVendorOf(
  card: ModelCard,
  builderVendor: AgentVendor,
  otherInstalled: boolean | null | undefined,
): AgentVendor {
  const pr = card.prReview?.challenger;
  if (pr === "claude" || pr === "codex") return pr;
  const reviewed = card.builder?.review?.provider;
  if (reviewed === "claude" || reviewed === "codex") return reviewed;
  return otherInstalled === false ? builderVendor : challengerVendor(builderVendor);
}

/** The Challenger's: `vendor` (from `challengerVendorOf`), on the card's
 *  (else the workspace's, the app's) Challenger row. */
export function challengerModelFact(
  card: ModelCard,
  workspace: WorkspaceModels | null | undefined,
  app: AppRows,
  vendor: AgentVendor,
  catalog?: ModelCatalog | null,
): RoleModelFact {
  const next = cardModelWords(card.models, workspace, app, vendor, "challenger", catalog);
  const review = card.builder?.review;
  // A review that starts records its model (`builder::started_review`); one
  // still queued records none yet, and the tool's default records none too —
  // so a running review without one claims nothing about "now".
  const now = review?.status === "running" ? review.model?.trim() || null : null;
  return {
    vendor,
    next,
    running: now !== null && now !== next ? now : null,
    fromBuildBoth: false,
    ...(fromTeamRows(card.models, workspace, app, vendor, "challenger") ? { fromTeam: true } : {}),
  };
}

/** A2: either part of the role's next model comes from the team. */
function fromTeamRows(
  card: WorkspaceModels | null | undefined,
  workspace: WorkspaceModels | null | undefined,
  app: AppRows,
  vendor: AgentVendor,
  role: AgentRole,
): boolean {
  return (["model", "reasoning"] as const).some(
    (part) => cardEffectivePart(card, workspace, app, vendor, role, part).source === "team",
  );
}

/** The chip's text: `opus`, or `opus now · sonnet next` while a session runs
 *  on another; `· Team` when the next one is the team's suggestion (A2). */
export function modelFactWords(fact: RoleModelFact): string {
  const next = fact.fromTeam ? `${fact.next} · ${TEAM_LABEL}` : fact.next;
  return fact.running ? `${fact.running} now · ${next} next` : next;
}

/** Technical details (E3): the model a session or review ran on — what
 *  Plyloft passed, or the tool's default when it passed none. */
export function usedModelWords(model: string | null | undefined): string {
  // Walk 2026-10-23: "gpt-6-astra, high effort" — the effort said as one.
  return modelDetailWords(model) ?? TOOL_DEFAULT_WORDS;
}
