/**
 * CL-4 (CLARITY_PLAN, idea 11): this workspace's own Builder and Challenger
 * models, merged **field by field** over the app's `behavior.models`.
 *
 * Pure, and the mirror of `settings.rs::WorkspaceModels` and
 * `resolve_model`. Each field has three states:
 * - blank / absent: the app's field (`Use app default`);
 * - a value: that model or effort;
 * - named in `cliDefault` (round 2): no flag at all in this workspace,
 *   whatever the app row says (`CLI default`).
 * A field with nothing anywhere runs the CLI's own default too.
 *
 * Personal to this Mac (`Workspace.models` in workspaces.json), never in the
 * repository's shared definition (ADR 0003): models stay per user.
 */

import { effortWord, rolePairingLine, type AgentRole, type AgentVendor, type RoleModels } from "./roleModels.ts";

/** The first choice of every workspace row: nothing of its own. */
export const USE_APP_DEFAULT_LABEL = "Use app default";

/** The second choice: force the CLI's own default in this workspace. It is
 *  also what a forced field shows, so the field's text round-trips. */
export const FORCE_CLI_DEFAULT_LABEL = "The tool's default";
/** What the forced label said before UX P-D2, still accepted when typed. */
const LEGACY_CLI_DEFAULT_PATTERN = "cli default";

/** `Workspace.models` as persisted. `cliDefault` names the forced fields
 *  (`claude.builder`, `codex.builderReasoning`, …). */
export interface WorkspaceModels extends RoleModels {
  cliDefault?: string[];
}

/** 1.169.0 (A2): what lies below a workspace's own rows — the team's
 *  suggestion (`.atelier/workspace.json` → `models`), then this Mac's app
 *  rows. A plain `RoleModels` is the app's alone, as before. */
export interface AppRows extends RoleModels {
  team?: RoleModels | null;
}

/** The app's rows with the team's suggestions laid between them and the
 *  workspace's. */
export function withTeam(app: RoleModels, team: RoleModels | null | undefined): AppRows {
  return team ? { ...app, team } : app;
}

/** The label of the team's layer, in menus and on a card's chip. */
export const TEAM_LABEL = "Team";

/** One field of one vendor/role row: its model, or its effort (1.169.0:
 *  Claude's too). */
export type ModelPart = "model" | "reasoning";

/** Where an effective value comes from. `forced`: this workspace says
 *  "CLI default"; `cli`: nothing is set anywhere. */
export type ModelSource = "workspace" | "forced" | "team" | "app" | "cli";

/** Blank, whitespace-only and absent all mean "not set". */
function cleaned(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function reasoningKey(role: AgentRole): "builderReasoning" | "challengerReasoning" {
  return role === "builder" ? "builderReasoning" : "challengerReasoning";
}

/** The `cliDefault` name of one part. Mirrors `settings.rs::model_field_key`. */
export function fieldKey(vendor: AgentVendor, role: AgentRole, part: ModelPart): string {
  return part === "model" ? `${vendor}.${role}` : `${vendor}.${reasoningKey(role)}`;
}

/** This workspace forces the part to the CLI's own default. */
export function forcesCliDefault(
  models: WorkspaceModels | null | undefined,
  vendor: AgentVendor,
  role: AgentRole,
  part: ModelPart,
): boolean {
  return !!models?.cliDefault?.includes(fieldKey(vendor, role, part));
}

/** The raw value one row holds for one part, or "" when unset. */
export function rowValue(
  models: RoleModels | null | undefined,
  vendor: AgentVendor,
  role: AgentRole,
  part: ModelPart,
): string {
  if (!models) return "";
  const rows = models[vendor] ?? {};
  return cleaned(part === "model" ? rows[role] : rows[reasoningKey(role)]) ?? "";
}

/** What a workspace field holds as the person sees it: a value, the
 *  `CLI default` label when forced, or "" for the app's. */
export function fieldChoice(
  models: WorkspaceModels | null | undefined,
  vendor: AgentVendor,
  role: AgentRole,
  part: ModelPart,
): string {
  if (forcesCliDefault(models, vendor, role, part)) return FORCE_CLI_DEFAULT_LABEL;
  return rowValue(models, vendor, role, part);
}

/** Trimmed, blanks dropped, a forced field's value cleared, `cliDefault`
 *  sorted and deduplicated; `null` when nothing is left — what
 *  `workspace_set_models` stores. Mirrors `WorkspaceModels::normalized`. */
export function normalizeModels(
  models: WorkspaceModels | null | undefined,
): WorkspaceModels | null {
  if (!models) return null;
  const forced = [...new Set((models.cliDefault ?? []).map((k) => k.trim()).filter(Boolean))].sort();
  const claude: RoleModels["claude"] = {};
  const codex: RoleModels["codex"] = {};
  for (const role of ["builder", "challenger"] as const) {
    const key = reasoningKey(role);
    const c = cleaned(models.claude?.[role]);
    if (c && !forced.includes(`claude.${role}`)) claude[role] = c;
    const ce = cleaned(models.claude?.[key]);
    if (ce && !forced.includes(`claude.${key}`)) claude[key] = ce;
    const x = cleaned(models.codex?.[role]);
    if (x && !forced.includes(`codex.${role}`)) codex[role] = x;
    const r = cleaned(models.codex?.[key]);
    if (r && !forced.includes(`codex.${key}`)) codex[key] = r;
  }
  if (Object.keys(claude).length === 0 && Object.keys(codex).length === 0 && forced.length === 0) {
    return null;
  }
  return forced.length ? { claude, codex, cliDefault: forced } : { claude, codex };
}

/** The workspace rows with one part changed and normalized: "" is the app's
 *  (`Use app default`), {@link FORCE_CLI_DEFAULT_LABEL} forces the CLI's
 *  default, anything else is that value. */
export function withModelPart(
  models: WorkspaceModels | null | undefined,
  vendor: AgentVendor,
  role: AgentRole,
  part: ModelPart,
  choice: string,
): WorkspaceModels | null {
  const key = fieldKey(vendor, role, part);
  const value = choice.trim();
  // Intentional: typing "CLI default" (any case, spaces trimmed) selects the
  // CLI default, exactly as picking it from the list does. It is also the text
  // a forced field shows, so committing that text again keeps it forced. No
  // model is called that (it has a space). UX P-D2: the label became "The
  // tool's default"; the old words still select it, so a hand-typed "CLI
  // default" behaves as before.
  const lower = value.toLowerCase();
  const force = lower === FORCE_CLI_DEFAULT_LABEL.toLowerCase() || lower === LEGACY_CLI_DEFAULT_PATTERN;
  const next: WorkspaceModels = {
    claude: { ...(models?.claude ?? {}) },
    codex: { ...(models?.codex ?? {}) },
    cliDefault: (models?.cliDefault ?? []).filter((k) => k !== key),
  };
  if (force) next.cliDefault!.push(key);
  const stored = force ? "" : value;
  if (part === "model") next[vendor][role] = stored;
  else next[vendor][reasoningKey(role)] = stored;
  return normalizeModels(next);
}

/** Whether an effort runs on a model (`modelCatalog.ts::effortFit`, not
 *  "unsupported"). Absent: every effort does. */
export type EffortFits = (model: string | null, effort: string) => boolean;

/** A2 (Challenger 5): the effort layers below a card, top first. */
export function workspaceEffortLayers(
  workspace: WorkspaceModels | null | undefined,
  app: AppRows,
  vendor: AgentVendor,
  role: AgentRole,
): { value: string | null; source: ModelSource }[] {
  if (forcesCliDefault(workspace, vendor, role, "reasoning")) return [{ value: null, source: "forced" }];
  return [
    { value: rowValue(workspace, vendor, role, "reasoning") || null, source: "workspace" },
    { value: rowValue(app.team, vendor, role, "reasoning") || null, source: "team" },
    { value: rowValue(app, vendor, role, "reasoning") || null, source: "app" },
  ];
}

/** The first layer's effort that fits `model` — a team's effort the model
 *  doesn't take falls to my app's — or none; a forced layer stops there. The
 *  mirror of `settings.rs::resolve_card_model_fitted`. */
export function pickEffort<S extends string>(
  layers: { value: string | null; source: S | "forced" | "cardForced" }[],
  model: string | null,
  fits?: EffortFits,
): { value: string | null; source: S | "forced" | "cardForced" | "cli" } {
  for (const layer of layers) {
    if (layer.source === "forced" || layer.source === "cardForced") return { value: null, source: layer.source };
    if (layer.value && (!fits || fits(model, layer.value))) return layer;
  }
  return { value: null, source: "cli" };
}

/** The effort a workspace's role runs at, layer by layer against its model. */
export function effectiveEffort(
  workspace: WorkspaceModels | null | undefined,
  app: AppRows,
  vendor: AgentVendor,
  role: AgentRole,
  fits?: EffortFits,
): { value: string | null; source: ModelSource } {
  const model = effectivePart(workspace, app, vendor, role, "model").value;
  return pickEffort(workspaceEffortLayers(workspace, app, vendor, role), model, fits) as {
    value: string | null;
    source: ModelSource;
  };
}

/** A2 (Challenger 1): the team's suggestions with one part changed, every
 *  other key — a later build's too — kept as stored; `null` when nothing is
 *  left. A team suggests values only: blank (or "The tool's default") clears. */
export function withTeamPart(
  models: RoleModels | null | undefined,
  vendor: AgentVendor,
  role: AgentRole,
  part: ModelPart,
  choice: string,
): RoleModels | null {
  const next = JSON.parse(JSON.stringify(models ?? {})) as Record<string, Record<string, unknown> | unknown>;
  const rows = { ...((next[vendor] as Record<string, unknown> | undefined) ?? {}) };
  const key = part === "model" ? role : reasoningKey(role);
  const value = choice.trim();
  const lower = value.toLowerCase();
  if (value && lower !== FORCE_CLI_DEFAULT_LABEL.toLowerCase() && lower !== LEGACY_CLI_DEFAULT_PATTERN) rows[key] = value;
  else delete rows[key];
  if (Object.keys(rows).length) next[vendor] = rows;
  else delete next[vendor];
  for (const v of ["claude", "codex"] as const) {
    const held = next[v];
    if (held && typeof held === "object" && Object.keys(held).length === 0) delete next[v];
  }
  return Object.keys(next).length ? (next as unknown as RoleModels) : null;
}

/** One part's effective value and where it comes from. */
export function effectivePart(
  workspace: WorkspaceModels | null | undefined,
  app: AppRows,
  vendor: AgentVendor,
  role: AgentRole,
  part: ModelPart,
): { value: string | null; source: ModelSource } {
  if (forcesCliDefault(workspace, vendor, role, part)) return { value: null, source: "forced" };
  const own = rowValue(workspace, vendor, role, part);
  if (own) return { value: own, source: "workspace" };
  // A2: the team's suggestion, before this Mac's app rows.
  const team = rowValue(app.team, vendor, role, part);
  if (team) return { value: team, source: "team" };
  const fallback = rowValue(app, vendor, role, part);
  if (fallback) return { value: fallback, source: "app" };
  return { value: null, source: "cli" };
}

const SOURCE_WORDS: Record<"workspace" | "team" | "app", string> = {
  workspace: "(this workspace)",
  team: "(team)",
  app: "(app default)",
};

/**
 * The line under a workspace row: what this workspace's sessions in that role
 * will actually run, and where each part comes from —
 * `Runs on opus (this workspace).`,
 * `Runs on gpt-5.5 (app default), low effort (this workspace).`,
 * `Runs on opus (app default), high effort (this workspace).`,
 * `Runs on the CLI's default model (this workspace).`,
 * `Runs on the CLI's default model.`
 */
export function effectiveLine(
  workspace: WorkspaceModels | null | undefined,
  app: AppRows,
  vendor: AgentVendor,
  role: AgentRole,
  fits?: EffortFits,
): string {
  const model = effectivePart(workspace, app, vendor, role, "model");
  const head =
    model.source === "cli"
      ? "the tool's default model"
      : model.source === "forced"
        ? "the tool's default model (this workspace)"
        : `${model.value} ${SOURCE_WORDS[model.source]}`;
  const effort = effectiveEffort(workspace, app, vendor, role, fits);
  const word = effortWord(vendor);
  if (effort.source === "cli") return `Runs on ${head}.`;
  if (effort.source === "forced") return `Runs on ${head}, the tool's default ${word} (this workspace).`;
  return `Runs on ${head}, ${effort.value} ${word} ${SOURCE_WORDS[effort.source]}.`;
}

/** The rows that will really run in this workspace, as one `RoleModels` —
 *  for the pairing line at the top of Claude and Codex. A forced field reads
 *  as unset there: the CLI's own default. */
export function effectiveRoleModels(
  workspace: WorkspaceModels | null | undefined,
  app: AppRows,
  /** 1.169.0 walk: the catalog's fit per vendor — an effort the model
   *  doesn't take falls to the next layer's, as the spawn does. */
  fitsFor?: (vendor: AgentVendor) => EffortFits | undefined,
): RoleModels {
  const pick = (vendor: AgentVendor, role: AgentRole, part: ModelPart) =>
    part === "reasoning"
      ? effectiveEffort(workspace, app, vendor, role, fitsFor?.(vendor)).value
      : effectivePart(workspace, app, vendor, role, part).value;
  return {
    claude: {
      builder: pick("claude", "builder", "model"),
      challenger: pick("claude", "challenger", "model"),
      builderReasoning: pick("claude", "builder", "reasoning"),
      challengerReasoning: pick("claude", "challenger", "reasoning"),
    },
    codex: {
      builder: pick("codex", "builder", "model"),
      challenger: pick("codex", "challenger", "model"),
      builderReasoning: pick("codex", "builder", "reasoning"),
      challengerReasoning: pick("codex", "challenger", "reasoning"),
    },
  };
}

/** What an empty workspace field shows: the app value it falls back to.
 *  SP-7: with no app value it says only "Use app default" — the app row's
 *  own empty field says what that means. */
export function fallbackPlaceholder(
  app: AppRows,
  vendor: AgentVendor,
  role: AgentRole,
  part: ModelPart,
): string {
  const team = rowValue((app as AppRows).team, vendor, role, part);
  if (team) return `${team} (team)`;
  const value = rowValue(app, vendor, role, part);
  return value ? `${value} (app default)` : USE_APP_DEFAULT_LABEL;
}

/** How many parts this workspace sets of its own, forced ones included. */
export function ownCount(models: WorkspaceModels | null | undefined): number {
  let n = 0;
  for (const vendor of ["claude", "codex"] as const) {
    for (const role of ["builder", "challenger"] as const) {
      for (const part of ["model", "reasoning"] as const) {
        if (fieldChoice(models, vendor, role, part)) n++;
      }
    }
  }
  return n;
}

/** CL-4 (F3): the status line of Claude and Codex. With no workspace open,
 *  or one with no rows of its own, it is the app pairing as before; otherwise
 *  the pairing that will really run there, named as that workspace's. */
export function pairingStatus(
  builderVendor: AgentVendor,
  app: AppRows,
  workspace: { name: string; models?: WorkspaceModels | null } | null,
  fitsFor?: (vendor: AgentVendor) => EffortFits | undefined,
): string {
  const team = app.team && ownCount(app.team) > 0;
  if (!workspace || ownCount(workspace.models) === 0) {
    // A2: with the team's suggestions under it, the pairing that runs.
    const runs = rolePairingLine(builderVendor, fitsFor || team ? effectiveRoleModels(null, app, fitsFor) : app);
    return team ? `With the team's suggestions — ${runs}` : runs;
  }
  // Walk 2026-10-23: say what the workspace sets — models, effort, or both.
  const sets = (part: ModelPart) =>
    (["claude", "codex"] as const).some((v) =>
      (["builder", "challenger"] as const).some((r) => fieldChoice(workspace.models, v, r, part) !== ""),
    );
  const own = sets("model") && sets("reasoning") ? "models and effort" : sets("model") ? "models" : "effort";
  return `In ${workspace.name}, with its own ${own} — ${rolePairingLine(
    builderVendor,
    effectiveRoleModels(workspace.models, app, fitsFor),
  )}`;
}

// ── 1.174.0 (DS4): AI and models' summaries (settings.html scenes 6–8) ──

/** A model id in the words a summary uses: the catalog's name for it, or
 *  the id itself. */
export type ModelName = (vendor: AgentVendor, id: string) => string;

const VENDOR_WORDS: Record<AgentVendor, string> = { claude: "Claude", codex: "Codex" };
const ROLE_NAMES: Record<AgentRole, string> = { builder: "Builder", challenger: "Reviewer" };
const ROLES: readonly AgentRole[] = ["builder", "challenger"];

/** "Sonnet · medium", "the tool's default · high", or null when neither
 *  part says anything. `effortWord` adds " effort" after the level. */
function partWords(
  vendor: AgentVendor,
  model: string,
  effort: string,
  nameOf: ModelName,
  withEffortWord: boolean,
): string | null {
  if (!model && !effort) return null;
  const head = model ? nameOf(vendor, model) : "the tool's default";
  if (!effort) return head;
  return `${head} · ${effort}${withEffortWord ? ` ${effortWord(vendor)}` : ""}`;
}

/** AI and models › Models, one AI's row: what this Mac runs in every
 *  project — "Builder: Opus · high effort · Reviewer: the tool's default". */
export function vendorSummary(rows: RoleModels, vendor: AgentVendor, nameOf: ModelName): string {
  return ROLES.map((role) => {
    const words = partWords(
      vendor,
      rowValue(rows, vendor, role, "model"),
      rowValue(rows, vendor, role, "reasoning"),
      nameOf,
      true,
    );
    return `${ROLE_NAMES[role]}: ${words ?? "the tool's default"}`;
  }).join(" · ");
}

/** One role's own parts in a project, a forced part as the tool's default. */
function ownWords(models: WorkspaceModels | null | undefined, vendor: AgentVendor, role: AgentRole, nameOf: ModelName) {
  const forced = (part: ModelPart) => forcesCliDefault(models, vendor, role, part);
  const model = forced("model") ? "" : rowValue(models, vendor, role, "model");
  const effort = forced("reasoning") ? "the tool's default" : rowValue(models, vendor, role, "reasoning");
  if (!model && !effort && !forced("model")) return null;
  if (!model && !forced("model") && forced("reasoning")) return "the tool's default effort";
  return partWords(vendor, model, effort, nameOf, false) ?? "the tool's default";
}

/** AI and models › Models, the "Only in <project>" row: what this project
 *  sets of its own on this Mac — "Claude Builder: Sonnet · medium. The rest
 *  follows the rows above." — or null when it sets nothing. */
export function onlyInSummary(models: WorkspaceModels | null | undefined, nameOf: ModelName): string | null {
  const parts: string[] = [];
  for (const vendor of ["claude", "codex"] as const) {
    for (const role of ROLES) {
      const words = ownWords(models, vendor, role, nameOf);
      if (words) parts.push(`${VENDOR_WORDS[vendor]} ${ROLE_NAMES[role]}: ${words}`);
    }
  }
  if (parts.length === 0) return null;
  const all = parts.length === 4;
  return `${parts.join("; ")}.${all ? "" : " The rest follows the rows above."}`;
}

/** The vendor the "Only in <project>" row opens: the first with a part of
 *  its own, else `fallback`. */
export function onlyInVendor(models: WorkspaceModels | null | undefined, fallback: AgentVendor): AgentVendor {
  for (const vendor of ["claude", "codex"] as const) {
    if (ROLES.some((role) => ownWords(models, vendor, role, (_v, id) => id))) return vendor;
  }
  return fallback;
}

/** Project › General › Models suggested for the team, one AI's row:
 *  "Builder: Sonnet · medium · Reviewer: none suggested", or "None
 *  suggested". */
export function teamSummary(team: RoleModels | null | undefined, vendor: AgentVendor, nameOf: ModelName): string {
  const words = ROLES.map((role) =>
    partWords(vendor, rowValue(team, vendor, role, "model"), rowValue(team, vendor, role, "reasoning"), nameOf, false),
  );
  if (words.every((w) => w === null)) return "None suggested";
  return ROLES.map((role, i) => `${ROLE_NAMES[role]}: ${words[i] ?? "none suggested"}`).join(" · ");
}

/** A role's row on the Only in <project> sub-page, while the team suggests
 *  for it: "The team suggests Sonnet · medium (Project › General)." */
export function teamSuggestsLine(
  team: RoleModels | null | undefined,
  vendor: AgentVendor,
  role: AgentRole,
  nameOf: ModelName,
): string | null {
  const words = partWords(vendor, rowValue(team, vendor, role, "model"), rowValue(team, vendor, role, "reasoning"), nameOf, false);
  return words ? `The team suggests ${words} (Project › General).` : null;
}

/** Whether a project sets any part of one role of its own (a forced one
 *  included). */
export function ownsRole(models: WorkspaceModels | null | undefined, vendor: AgentVendor, role: AgentRole): boolean {
  return ownWords(models, vendor, role, (_v, id) => id) !== null;
}
