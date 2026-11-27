/**
 * #74: the model each of Ply's two roles runs on, per vendor.
 *
 * Pure: the Settings rows, the pairing line under the Builder vendor
 * selector and the Builder tile all read the same functions, and they
 * mirror `settings.rs` (`RoleModels::for_role`, `ModelChoice::label`).
 *
 * Every field is optional and blank means "pass no flag", so the vendor
 * CLI's own default on this Mac still decides — exactly what Ply did
 * before #74. Model names are free text on purpose (#50): no allow-list,
 * so a name works the day the vendor ships it, and an unknown one comes
 * back as the CLI's own error rather than a Ply validation message.
 *
 * 1.169.0 (A1): both vendors have an effort (`builderReasoning` /
 * `challengerReasoning`): Claude's `--effort`, Codex's
 * `model_reasoning_effort`. The models and levels the menus offer come from
 * `modelCatalog.ts` (Codex's own list, the site's file, the bundled copy);
 * they are suggestions only.
 */

export type AgentRole = "builder" | "challenger";
export type AgentVendor = "claude" | "codex";

/** `behavior.models` as persisted in settings.json. */
export interface RoleModels {
  claude: {
    builder?: string | null;
    challenger?: string | null;
    /** 1.169.0 (A1): `--effort`. Absent on every file before it. */
    builderReasoning?: string | null;
    challengerReasoning?: string | null;
  };
  codex: {
    builder?: string | null;
    challenger?: string | null;
    builderReasoning?: string | null;
    challengerReasoning?: string | null;
  };
}

export const EMPTY_ROLE_MODELS: RoleModels = { claude: {}, codex: {} };

/** Blank, whitespace-only and absent all mean "the CLI's default". */
function cleaned(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** What an effort is called. Owner D1 (1.169.0): "effort" for both
 *  vendors, Codex's reasoning effort included; kept per vendor so a caller
 *  names whose it is. */
export function effortWord(_vendor: AgentVendor): string {
  return "effort";
}

/** How a row reads to a human — "opus", "opus high", "gpt-6-astra medium",
 *  an effort alone as "low effort", or null when nothing is set. Mirrors
 *  `settings.rs::ModelChoice::label_for`. */
export function modelLabel(
  model: string | null | undefined,
  reasoning?: string | null,
  vendor: AgentVendor = "codex",
): string | null {
  const m = cleaned(model);
  const r = cleaned(reasoning);
  if (m && r) return `${m} ${r}`;
  if (m) return m;
  if (r) return `${r} ${effortWord(vendor)}`;
  return null;
}

/** A recorded label ("gpt-6-astra high", "opus", "low effort") split back
 *  into its model and effort. A model id has no space (it is one CLI
 *  argument), so the first space ends it. Mirrors
 *  `settings.rs::split_model_label`. */
export function splitModelLabel(label: string | null | undefined): { model: string | null; effort: string | null } {
  const text = cleaned(label);
  if (!text) return { model: null, effort: null };
  const alone = /^(\S+) (?:effort|reasoning)$/.exec(text);
  if (alone) return { model: null, effort: alone[1] };
  const at = text.indexOf(" ");
  if (at < 0) return { model: text, effort: null };
  return { model: text.slice(0, at), effort: text.slice(at + 1).trim() || null };
}

/** A label in a sentence (walk 2026-10-23): "gpt-6-astra with high effort",
 *  "opus", "high effort". Chips keep the compact label. */
export function modelSentenceWords(label: string | null | undefined): string | null {
  const { model, effort } = splitModelLabel(label);
  if (model && effort) return `${model} with ${effort} effort`;
  if (model) return model;
  return effort ? `${effort} effort` : null;
}

/** A label in a fact row: "gpt-6-astra, high effort". */
export function modelDetailWords(label: string | null | undefined): string | null {
  const { model, effort } = splitModelLabel(label);
  if (model && effort) return `${model}, ${effort} effort`;
  if (model) return model;
  return effort ? `${effort} effort` : null;
}

/** The label for one vendor/role pair. */
export function roleModelLabel(
  models: RoleModels,
  vendor: AgentVendor,
  role: AgentRole,
): string | null {
  const rows = vendor === "codex" ? models.codex : models.claude;
  return modelLabel(
    rows[role],
    role === "builder" ? rows.builderReasoning : rows.challengerReasoning,
    vendor,
  );
}

/** The Challenger is always the other vendor (D1). */
export function challengerVendor(builderVendor: AgentVendor): AgentVendor {
  return builderVendor === "codex" ? "claude" : "codex";
}

/** The one line under the Builder vendor selector: what the current
 *  pairing will actually run. */
export function rolePairingLine(
  builderVendor: AgentVendor,
  models: RoleModels,
): string {
  const name = (vendor: AgentVendor) => (vendor === "codex" ? "Codex" : "Claude");
  const on = (vendor: AgentVendor, role: AgentRole) => {
    const label = roleModelLabel(models, vendor, role);
    return label ? `${name(vendor)} on ${label}` : `${name(vendor)} on its own default`;
  };
  return `Builder: ${on(builderVendor, "builder")} · Reviewer: ${on(
    challengerVendor(builderVendor),
    "challenger",
  )}.`;
}
