// UX language: the four scopes and what their badge says (PATTERNS.md §2,
// SHEET.md "Scope glyphs"). Pure so node can test the modules using it.

import { platformWord, type Platform } from "./platform.ts";

export type Scope = "ply" | "team" | "repository" | "this-mac";

export const SCOPE_BADGE: Record<Scope, { glyph: string; name: string; meaning: string }> = {
  ply: { glyph: "P", name: "Plyloft", meaning: "comes with the app" },
  team: { glyph: "◇", name: "Team", meaning: "every team workspace" },
  // 1.174.0 (T38, G19): the whole word.
  repository: { glyph: "▤", name: "Repository", meaning: "everyone who opens this repository" },
  "this-mac": { glyph: "▪", name: platformWord("thisMachine"), meaning: "only here" },
};

/**
 * 1.174.0 (DS1, D6 b): where a Settings section's rows are kept. A section
 * never mixes two of them.
 *
 *  - `this-mac`: saved only here (`settings.json`, `workspaces.json`);
 *  - `repository`: a row of the project's setup — shared with everyone once
 *    the project shares its setup, and kept here until then;
 *  - `team`: the team's own repository;
 *  - `account`: the Plyloft account (Plan).
 */
export type SectionScope = "this-mac" | "repository" | "team" | "account";

/** The one icon each scope mark draws (`ux/Icon.tsx`'s map). A project row
 *  kept here until the project is shared is drawn with this Mac's icon. */
export function scopeMarkIcon(
  scope: SectionScope,
  { shared = false }: { shared?: boolean } = {},
): "thisMac" | "project" | "team" | "account" {
  if (scope === "repository") return shared ? "project" : "thisMac";
  return scope === "this-mac" ? "thisMac" : scope;
}

/**
 * 1.174.0 G3a walk: whether the project can be shared from this Mac, for
 * every project mark ("until you share the project" only then). Solo mode,
 * or a repository not on GitHub, or one whose question waits on another
 * answer: no. Not known yet (no reading, or a read that failed): yes, the
 * words as they were — a wrong "on this Mac" would hide that Share exists.
 */
export function projectShareable(
  status: { githubRepo?: string | null; action: { kind: string } } | null | undefined,
  solo: boolean,
): boolean {
  if (solo) return false;
  if (!status) return true;
  return Boolean(status.githubRepo) && (status.action.kind === "ask" || status.action.kind === "none");
}

/**
 * The words beside a section's title — five shapes, the same everywhere:
 * `on this Mac`, `shared with the project`, `on this Mac until you share the
 * project`, `shared with the team`, `your Plyloft account` (`this PC` on
 * Windows, through `platformWord`).
 */
export function scopeWords(
  scope: SectionScope,
  { shared = false, shareable = true }: { shared?: boolean; shareable?: boolean } = {},
  p?: Platform,
): string {
  // `This Mac` → `this Mac`: only the first letter is the sentence's.
  const here = platformWord("thisMachine", p).replace(/^This\b/, "this");
  switch (scope) {
    case "this-mac":
      return `on ${here}`;
    case "repository":
      // 1.174.0 G3a walk: a project with nowhere to share it (solo, or no
      // GitHub) is kept here, and says only that.
      if (shared) return "shared with the project";
      return shareable ? `on ${here} until you share the project` : `on ${here}`;
    case "team":
      return "shared with the team";
    case "account":
      return "your Plyloft account";
  }
}
