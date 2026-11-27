/**
 * Team walk 2026-10-01 (F4 stopgap): a repository skill both CLIs read lives
 * twice in the checkout — Claude's copy under `.claude/skills/<name>`, Codex's
 * under `.agents/skills/<name>`. The skill page listed only the copy its row
 * points at, so when the two disagreed ("make them match first") the other one
 * could not be opened from Plyloft at all. This names the other copy's folder,
 * for the page to list beside the first.
 */

export const CLAUDE_SKILLS_ROOT = ".claude/skills";
export const CODEX_SKILLS_ROOT = ".agents/skills";

export interface OtherCopy {
  /** The other copy's folder, in the same form as `dir` (absolute here). */
  dir: string;
  /** Its root under the checkout, for the file rows' names. */
  root: string;
  /** Whose copy it is, for the row's hint. */
  owner: "Claude" | "Codex";
}

/**
 * The other copy of the skill at `dir`, or null when `dir` is not one of the
 * two roots the checkout carries for both CLIs (a legacy `.codex/skills`, a
 * personal or team folder, or no folder at all).
 */
export function otherCopyOf(dir: string | null, name: string): OtherCopy | null {
  if (!dir || !name) return null;
  const clean = dir.replace(/[\\/]+$/, "");
  const sep = clean.includes("\\") && !clean.includes("/") ? "\\" : "/";
  const tail = (root: string) => `${sep}${root.split("/").join(sep)}${sep}${name}`;
  const pairs: [string, string, OtherCopy["owner"]][] = [
    [CLAUDE_SKILLS_ROOT, CODEX_SKILLS_ROOT, "Codex"],
    [CODEX_SKILLS_ROOT, CLAUDE_SKILLS_ROOT, "Claude"],
  ];
  for (const [from, to, owner] of pairs) {
    if (clean.endsWith(tail(from))) {
      return { dir: clean.slice(0, -tail(from).length) + tail(to), root: to, owner };
    }
  }
  return null;
}
