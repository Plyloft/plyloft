/**
 * 1.169.0 (A1): the models and efforts the model menus offer — the mirror
 * of `model_catalog.rs`, which builds it from `codex debug models` (Codex),
 * the site's `models.json` (Claude, and Codex's fallback) and the copy in
 * the app (`src-tauri/catalog/models.json`).
 *
 * Pure. Suggestions only: the model field stays free text (#50). A level a
 * known model doesn't list is shown as not available on that model and is
 * not passed at spawn (`ModelCatalog::fit`); on a model the catalog doesn't
 * know it is passed, as before.
 */

import type { AgentVendor } from "./roleModels.ts";

export interface CatalogModel {
  id: string;
  label: string;
  /** Absent: support unknown — the vendor's levels are offered. */
  efforts?: string[] | null;
  defaultEffort?: string | null;
  /** Known (its levels count) but not offered: Codex's hidden models, a file
   *  model missing from Codex's own list, an older version of a family. */
  hidden?: boolean;
}

export interface VendorCatalog {
  /** The levels the vendor's CLI takes: what an unknown model offers. */
  efforts: string[];
  models: CatalogModel[];
}

/** `model_catalog_get` / the `model-catalog-changed` event. */
export interface ModelCatalog {
  claude: VendorCatalog;
  codex: VendorCatalog;
  codexFromCli?: boolean;
  fileFrom?: "site" | "cache" | "bundled";
  /** The installed Claude Code takes `--effort` (2.1.111 or later). Absent
   *  (before the app answers): not said. */
  claudeEffort?: boolean;
  /** Why not, when it doesn't. */
  claudeEffortWhy?: "tooOld" | "notInstalled" | "versionUnknown" | null;
}

/** The oldest Claude Code that takes every effort level (finding 1). The
 *  mirror of `model_catalog.rs::MIN_CLAUDE_VERSION_EFFORT`. */
export const MIN_CLAUDE_VERSION_EFFORT = "2.1.111";

/** Until the app answers: each vendor's levels, no models. The same levels
 *  as the bundled file (a test holds them equal). */
export const FALLBACK_CATALOG: ModelCatalog = {
  claude: { efforts: ["low", "medium", "high", "xhigh", "max"], models: [] },
  codex: { efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], models: [] },
  codexFromCli: false,
  fileFrom: "bundled",
};

function clean(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

/** The catalog's entry for a model, by its exact id. */
export function catalogModel(
  catalog: ModelCatalog,
  vendor: AgentVendor,
  model: string | null | undefined,
): CatalogModel | null {
  const id = clean(model);
  if (!id) return null;
  return catalog[vendor].models.find((m) => m.id === id) ?? null;
}

function familyAndVersion(id: string): { family: string; version: number[] } {
  const family: string[] = [];
  const version: number[] = [];
  for (const token of id.split("-")) {
    if (/^\d+(\.\d+)*$/.test(token)) version.push(...token.split(".").map(Number));
    else family.push(token);
  }
  while (version.length && version[version.length - 1] === 0) version.pop();
  return { family: family.join("-"), version };
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/** Owner D2 (1.169.0): of `ids`, the newest version of each family — the
 *  family is the id's words without its numbers (`gpt-…-sol`,
 *  `claude-opus-…`), the version those numbers — in the order given, the
 *  first of equals kept. The mirror of `model_catalog.rs::latest_per_family`;
 *  `modelFamilies.fixtures.json` holds both. */
export function latestPerFamily(ids: readonly string[]): string[] {
  const parsed = ids.map(familyAndVersion);
  const out: string[] = [];
  ids.forEach((id, i) => {
    const beaten = parsed.some(
      (p, j) =>
        p.family === parsed[i].family &&
        (compareVersions(p.version, parsed[i].version) > 0 ||
          (compareVersions(p.version, parsed[i].version) === 0 && j < i)),
    );
    if (!beaten && !out.includes(id)) out.push(id);
  });
  return out;
}

/** The model menu's suggestions: the newest of each family the menus offer
 *  (D2), each id with its label when it says more. An older model typed or
 *  saved keeps working; it just isn't offered. */
export function modelSuggestions(
  catalog: ModelCatalog,
  vendor: AgentVendor,
): { value: string; hint?: string }[] {
  const offered = catalog[vendor].models.filter((m) => !m.hidden);
  const latest = latestPerFamily(offered.map((m) => m.id));
  return offered
    .filter((m) => latest.includes(m.id))
    .map((m) =>
      m.label && m.label.toLowerCase() !== m.id.toLowerCase() ? { value: m.id, hint: m.label } : { value: m.id },
    );
}

/** The levels offered for a model: its own when the catalog lists them,
 *  else the vendor's. */
export function effortLevels(
  catalog: ModelCatalog,
  vendor: AgentVendor,
  model: string | null | undefined,
): string[] {
  const own = catalogModel(catalog, vendor, model)?.efforts;
  return own && own.length ? own : catalog[vendor].efforts;
}

/** Whether a level runs: `ok`; `cli` — the installed Claude Code is too old
 *  for `--effort`, so none is passed; `unsupported` — the catalog knows the
 *  model and it doesn't list the level, or no model is chosen and the
 *  vendor doesn't take the level at all, so no flag is passed (the model's
 *  default runs); `unknown` — passed as it is. Mirrors `ModelCatalog::fit`. */
export function effortFit(
  catalog: ModelCatalog,
  vendor: AgentVendor,
  model: string | null | undefined,
  effort: string | null | undefined,
): "ok" | "cli" | "unsupported" | "unknown" {
  const level = clean(effort);
  if (!level) return "ok";
  if (vendor === "claude" && catalog.claudeEffort === false) return "cli";
  const levels = clean(model) ? catalogModel(catalog, vendor, model)?.efforts : catalog[vendor].efforts;
  if (!levels || !levels.length) return "unknown";
  return levels.includes(level) ? "ok" : "unsupported";
}

/** The words for a level a model doesn't take. */
export function notOnModelWords(level: string): string {
  return `${level} (not on this model)`;
}

/** The words for a level the installed Claude Code can't take. */
export function notAvailableWords(level: string): string {
  return `${level} (not available)`;
}

/** An effort picker's options: `head` (the field's own first choices), the
 *  model's levels, and — when the stored level isn't one of them — that
 *  level too, so it is never lost; said as not available when the model is
 *  known not to take it. */
export function effortOptions(
  catalog: ModelCatalog,
  vendor: AgentVendor,
  model: string | null | undefined,
  current: string | null | undefined,
  head: { value: string; label: string }[],
): { value: string; label: string }[] {
  const levels = effortLevels(catalog, vendor, model);
  const options = [...head, ...levels.map((l) => ({ value: l, label: l }))];
  const stored = clean(current);
  const fit = effortFit(catalog, vendor, model, stored);
  if (stored && !options.some((o) => o.value === stored)) {
    options.push({ value: stored, label: fit === "unsupported" ? notOnModelWords(stored) : stored });
  }
  if (fit === "cli") {
    return options.map((o) => (o.value === stored ? { ...o, label: notAvailableWords(stored) } : o));
  }
  return options;
}

/** What a spawn passes for a resolved model and effort: the effort dropped
 *  when the model is known not to take it. Mirrors `ModelCatalog::fit`. */
export function fitEffort(
  catalog: ModelCatalog | null | undefined,
  vendor: AgentVendor,
  choice: { model: string | null; reasoning: string | null },
): { model: string | null; reasoning: string | null } {
  if (!catalog) return choice;
  const fit = effortFit(catalog, vendor, choice.model, choice.reasoning);
  if (fit !== "unsupported" && fit !== "cli") return choice;
  return { model: choice.model, reasoning: null };
}

/** The line under a field whose effort the model doesn't take, or null. */
export function unsupportedEffortLine(
  catalog: ModelCatalog,
  vendor: AgentVendor,
  model: string | null | undefined,
  effort: string | null | undefined,
  /** A2: the lower layer's effort that runs instead, when one fits. */
  fallback?: string | null,
): string | null {
  const fit = effortFit(catalog, vendor, model, effort);
  if (fit === "cli") {
    if (catalog.claudeEffortWhy === "notInstalled") return "Claude Code isn't installed, so no effort is passed.";
    if (catalog.claudeEffortWhy === "versionUnknown") {
      return "Claude Code's version couldn't be read, so no effort is passed.";
    }
    return `Effort needs Claude Code ${MIN_CLAUDE_VERSION_EFFORT} or later, so none is passed.`;
  }
  if (fit !== "unsupported") return null;
  if (fallback && clean(fallback) !== clean(effort)) {
    const on = clean(model) ? ` on ${clean(model)}` : "";
    return `${clean(effort)} isn't available${on}, so it runs at ${clean(fallback)} effort.`;
  }
  if (!clean(model)) return `${clean(effort)} isn't available, so the tool's default effort runs.`;
  return `${clean(effort)} isn't available on ${clean(model)}, so it runs at that model's own default.`;
}
