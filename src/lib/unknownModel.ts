/**
 * 1.176.3: a model name typed into a model field that no list of the app has.
 * A name nobody lists is not refused — a new model is not in the list yet —
 * but it is asked about before it is saved, because the tile that uses it
 * fails to start when the name is mistyped. Pure; the ask itself is
 * `confirmUnknownModel` in `unknownModelAsk.ts`.
 */

import type { AgentVendor } from "./roleModels.ts";

/** The names `claude --model` takes besides full ids: the aliases the app's
 *  own code and rows use (`opus`, `sonnet`, `haiku`) and the CLI's other
 *  two (`opusplan`, `default`). Claude's only — Codex has none. */
const CLAUDE_ALIASES = ["opus", "sonnet", "haiku", "opusplan", "default"];

/** A Claude name that is valid by its shape though no list holds it: an
 *  alias, either with the 1M-context suffix `[1m]`, a Bedrock or Vertex id
 *  (`us.anthropic.claude-…-v1:0`, `claude-…@date`), or a dated id. */
function claudeShape(v: string, known: readonly string[]): boolean {
  const base = v.replace(/\[1m\]$/i, "");
  return (
    CLAUDE_ALIASES.includes(base.toLowerCase()) ||
    known.includes(base) ||
    /anthropic\./i.test(base) ||
    base.includes("@") ||
    /^claude-[a-z0-9.-]+-\d{8}$/i.test(base)
  );
}

/** True when `value` is a name the field's lists don't hold. An empty field
 *  (the default) and a known name never are; with no list at all (the catalog
 *  not read yet) nothing can be judged, so nothing is. Claude's aliases and
 *  id shapes apply to Claude fields only. */
export function isUnknownModel(
  value: string,
  known: readonly string[],
  vendor: AgentVendor,
  extra: readonly string[] = [],
): boolean {
  const v = value.trim();
  if (!v || known.length === 0) return false;
  const lower = v.toLowerCase();
  if (known.includes(v) || extra.some((e) => e.toLowerCase() === lower)) return false;
  return !(vendor === "claude" && claudeShape(v, known));
}

/** The question's words, modelled on the checked fields' ("Save this …?",
 *  "Save it anyway", "Keep what was there"). `where` names the field, for a
 *  question that opens after the person looked away. */
export function unknownModelQuestion(value: string, where: string): { title: string; body: string } {
  return {
    title: "Save this model name?",
    body: `Plyloft doesn't know “${value.trim()}” as a model for ${where}. If it's mistyped, the tile won't start. A new model that isn't in the list yet is fine once its name is right.`,
  };
}
