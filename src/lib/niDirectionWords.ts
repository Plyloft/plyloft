/**
 * 1.173.0 (E5): the words of the direction editor (mockup
 * next-improvement.html scene 2) that `openDirectionEditor` opens. Pure, so
 * each case is tested.
 */
import type { NiApproach, NiDirection, NiDirectionDraft, NiLookAtHint, NiPending } from "../ipc.ts";

export const SAVE_AND_PREPARE = "Save and prepare proposals";

export function directionTitle(areaName: string): string {
  return areaName.trim() ? `Direction for ${areaName.trim()}` : "Direction for this project";
}

/** The lede: what the direction is for, and what Plyloft read to help
 *  while nothing is saved yet (1.174.0, C9, P14: it suggests; it doesn't
 *  write the answers). */
export function directionLede(from: NiDirectionDraft["from"] | null | undefined): string {
  const base = "Next improvement proposes only what serves this.";
  if (!from || from.length === 0) return base;
  const source = from.includes("readme") ? "your README" : "package.json";
  return `${base} Plyloft read ${source} to help with the direction.`;
}

/** C9 (mockups/next-improvement.html §4): the empty For whom's placeholder. */
export function audiencePlaceholder(areaName: string): string {
  return `Who uses ${areaName.trim() || "it"}, in a few words`;
}

/** C9: what the project's own words say, offered under For whom with *Use
 *  it*: "Your README starts: “…”". */
export function audienceSuggestion(hint: NonNullable<NiDirectionDraft["audience"]>): string {
  return hint.source === "readme" ? `Your README starts: “${hint.text}”` : `From package.json: “${hint.text}”`;
}

export const DIRECTION_FIELDS: {
  key: keyof Pick<NiDirection, "audience" | "better" | "avoid">;
  label: string;
  placeholder: string;
}[] = [
  // C9: the sheet draws `audiencePlaceholder(area)` for this one.
  { key: "audience", label: "For whom", placeholder: "Who uses it, in a few words" },
  {
    key: "better",
    label: "What “better” means here",
    placeholder: "What they can do, or do faster, when it's better",
  },
  { key: "avoid", label: "What you don’t want", placeholder: "Pop-ups, new sections nobody asked for…" },
];

/** "What better means" is never drafted (E-COMMON): the hint under it while
 *  it is empty. */
export const BETTER_HINT =
  "Plyloft doesn't guess this one. Next improvement needs it to tell a better idea from a busier one.";

export const APPROACH_LEGEND = "Approach — one or more";
export const NO_APPROACH_HINT = "None ticked: it polishes.";

export const APPROACH_LINES: Record<NiApproach, { name: string; line: string }> = {
  polish: { name: "Polish", line: "Finish what's there: words, spacing, states, small frictions." },
  simplify: { name: "Simplify", line: "Take things away: fewer steps, choices and code. Each idea must remove more than it adds." },
  grow: { name: "Grow", line: "Something new, one at a time, tied to “better” above." },
  fix: { name: "Fix", line: "What's broken or untrue: errors, slow pages, accessibility." },
};

export const WHERE_LABEL = "Where to look at it";
export const WHERE_EMPTY_HINT = "Empty: it reads only the code and the web, and says so.";

const SOURCE_WORDS: Record<NiLookAtHint["source"], string> = {
  area: "From Settings › Project › Areas.",
  railway: "Found in Railway.",
  packageJson: "From package.json.",
  readme: "From your README.",
};

/** Where the suggested address came from, while it is the one shown. */
export function lookAtHintWords(hint: NiLookAtHint | null, shown: string): string | null {
  if (!hint || hint.url !== shown.trim()) return null;
  return `${SOURCE_WORDS[hint.source]} ${WHERE_EMPTY_HINT}`;
}

// ── Who proposes, and who gives the second opinion ─────────────────────

export const PROPOSES_LABEL = "Proposes · second opinion";
export type NiProposer = "claude" | "codex";
const AI: Record<NiProposer, string> = { claude: "Claude", codex: "Codex" };

/** The two-AI segment's choices: "Claude · Codex" and "Codex · Claude". */
export const PROPOSER_OPTIONS: { value: NiProposer; label: string }[] = [
  { value: "claude", label: "Claude · Codex" },
  { value: "codex", label: "Codex · Claude" },
];

/** With one AI ready, it proposes and then gives the second opinion in a
 *  separate pass (decision 7). 1.174.0 (texts.html T19): said so it reads
 *  without knowing what a second opinion is. */
export function oneAiWords(ai: NiProposer): string {
  return `${AI[ai]} · then ${AI[ai]} again, in a separate session`;
}

/** E2 review: Codex's read-only session has no web tool. Null for Claude. */
export function proposerNote(proposer: NiProposer, twoAis: boolean): string | null {
  if (proposer !== "codex") return null;
  return twoAis
    ? "Codex reads the code only; Claude also reads the pages at Where to look at it."
    : "Codex reads the code only, not the pages at Where to look at it.";
}

// ── Not to propose again ───────────────────────────────────────────────

export function rejectedLink(n: number): string {
  return `Not to propose again (${n})`;
}
export const REJECTED_HEADING = "Not to propose again";
export const REMOVE = "Remove";

/** A row's second line: why, and who said so when it was someone. */
export function rejectedLine(row: { reason: string; by?: string | null }): string {
  const reason = row.reason.trim();
  const by = row.by?.trim();
  if (reason && by) return `${reason} · ${by}`;
  return reason || by || "";
}

// ── After a save ──────────────────────────────────────────────────────

export const SAVED_TITLE = "Direction saved";

/** A save that didn't reach the repository yet says so plainly (a pull
 *  request, offline, a choice, a problem). Null while it is on its way. */
export function savedPendingWords(pending: NiPending | null | undefined): string | null {
  if (!pending || pending.state === "waiting") return null;
  return pending.message?.trim() || null;
}

/** A start that failed after the save: the direction is kept. */
export function startFailedWords(why: string): string {
  return `The direction is saved. ${why}`;
}

// ── E5 Challenger round 1 ─────────────────────────────────────────────

/** 2: an address E1 would refuse, said under the field before Save. */
export const WHERE_INVALID = "A web address starts with https:// (or http://).";

const SUGGESTED_FROM: Record<NiLookAtHint["source"], string> = {
  area: "From Settings › Project › Areas",
  railway: "Found in Railway",
  packageJson: "From package.json",
  readme: "From your README",
};

/** 6: with a saved direction the suggestion is offered, never filled in:
 *  "Found in Railway: https://…" · *Use it*. */
export function lookAtSuggestion(hint: NiLookAtHint): string {
  // C9 (NIW-2; §4): an address only the README gives is offered, never
  // filled in.
  if (hint.source === "readme") return `Your README links: ${hint.url}`;
  return `${SUGGESTED_FROM[hint.source]}: ${hint.url}`;
}
export const USE_IT = "Use it";

/** 7: a round under way keeps its own direction. */
export const ROUND_RUNNING_WORDS = "Ideas are being prepared now; the next round follows this direction.";

/** 8: the direction names an AI that isn't ready here (`reason`: "Codex
 *  isn't signed in"). Raw "this Mac": callers pass it through machineWords. */
export function proposerStandIn(asked: NiProposer, standIn: NiProposer, reason: string): string {
  return `The direction asks ${AI[asked]} to propose; ${AI[standIn]} does on this Mac while ${reason}.`;
}
export const NONE_READY =
  "Neither Claude Code nor Codex is ready on this Mac. Set one up in Setup, then prepare proposals.";

/** 3: an unshared project. */
export const SHARE_THE_SETUP = "Share the setup";

/** E6: an unshared project keeps its direction in Plyloft's own data on
 *  this computer. Raw "this Mac": callers pass it through machineWords.
 *  1.174.0 (C9, D6, NIW-1): said beside Save, before the press, with *Share
 *  it…* where sharing is possible. */
export const KEPT_HERE = "Kept on this Mac until you share this project's setup.";
export const SHARE_IT = "Share it…";
/** Challenger 8: where the sheet can't share (solo, no GitHub, the notice
 *  above the Board waiting), only the fact. */
export const KEPT_HERE_SHORT = "Kept on this Mac only.";

/** C9 (NIW-1; §4): a shared setup's save, said beside Save before the
 *  press — the cards' branch, and how it gets there. */
export function savesToWords(branch: string, viaPullRequest: boolean): string {
  const how = viaPullRequest ? `a small commit as a pull request to ${branch}` : `a small commit to ${branch}`;
  return `Saved in this project's shared setup: ${how} on GitHub, so your other computers and your team see it.`;
}
