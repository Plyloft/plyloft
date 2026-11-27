import type { RemovedTeamSkill, TeamSkill } from "../ipc";

/**
 * v1.116.0 (team sharing rung 3): how the Team panel reads a skill library.
 *
 * The rung's whole condition is that **both** CLIs load the same skills, so
 * the interesting number is not "how many skills are in the library" but "how
 * many actually reach every session". A skill that reached only
 * `library/claude/` is not loaded for the half of the team on Codex, and
 * nothing else in the product would ever say so — which is why the summary
 * counts the two cases separately and the badges show a vendor that does
 * *not* load a skill rather than omitting it.
 *
 * Here rather than in JSX because it is a rule about the product, and rules
 * get tests.
 */

export type SkillVendor = "claude" | "codex";

export const SKILL_VENDORS: SkillVendor[] = ["claude", "codex"];

export const SKILL_VENDOR_LABEL: Record<SkillVendor, string> = {
  claude: "Claude",
  codex: "Codex",
};

/**
 * `<plugin>:<name>` — how both CLIs name a skill, and the identity two rows
 * are the same skill by. Two plugins may each carry a `review`; they are not
 * the same skill, and the panel must not key them as one.
 */
export function qualifiedSkillName(
  skill: Pick<TeamSkill, "plugin" | "name">,
): string {
  return `${skill.plugin}:${skill.name}`;
}

/** Whether `vendor`'s sessions load this skill. */
export function loadsSkill(skill: TeamSkill, vendor: SkillVendor): boolean {
  return vendor === "claude" ? skill.claude : skill.codex;
}

export interface TeamSkillsSummary {
  /** Loaded by both CLIs — the number that means "the team has this". */
  both: number;
  /** In the library but reaching only one CLI. */
  oneSided: number;
  total: number;
}

export function summarizeTeamSkills(skills: TeamSkill[]): TeamSkillsSummary {
  const both = skills.filter((s) => s.claude && s.codex).length;
  return { both, oneSided: skills.length - both, total: skills.length };
}

/**
 * The line beside the "Team skills" heading.
 *
 * `hasClone` separates "the library is empty" from "Ply has not fetched the
 * team repo yet" — the same distinction the workspace list draws, and the
 * difference between "nobody has shared a skill" and "press Refresh".
 */
export function teamSkillsSummaryLabel(
  skills: TeamSkill[],
  hasClone: boolean,
): string {
  const { both, oneSided } = summarizeTeamSkills(skills);
  if (skills.length === 0) {
    return hasClone ? "none in the library yet" : "not fetched yet";
  }
  const head = `${both} in both CLIs`;
  return oneSided > 0 ? `${head} · ${oneSided} in one only` : head;
}

/**
 * The sentence the "Remove from team" confirm asks. It carries the reach
 * Promote's Replace confirm states — this is a push to everyone on the team —
 * and says what it does *not* touch: copies Install put into repositories.
 *
 * "Once their Mac reads the team again" because that is when it happens:
 * sessions load the team clone as it is on each Mac, and a launch does not
 * pull it. The pull is Settings › Team › Members and library — opening it, or
 * its `Read it again` — which is the page's real place and its real word; the
 * old `Refresh in Settings › Members and library` named neither.
 */
export function removeConfirmBody(
  skill: Pick<TeamSkill, "plugin" | "name">,
): string {
  return (
    `Removing ${qualifiedSkillName(skill)} deletes it from both halves of the ` +
    `team library in one commit and pushes that to everyone on the team: the ` +
    `Claude and Codex sessions Plyloft starts for every member stop loading it once ` +
    `their Mac reads the team again, in Settings › Team › Members and library. Copies already installed in a ` +
    `repository stay there.`
  );
}

/** The Remove toast's body: whether it reached anyone. */
export function removeToastBody(
  outcome: Pick<RemovedTeamSkill, "pushed">,
): string {
  return outcome.pushed
    ? "Teammates stop getting it once their Mac reads the team again, in Settings › Team › Members and library. " +
        "Copies installed in repositories were left alone."
    : "The team's library on this Mac no longer has it, but it isn't connected " +
        "to GitHub, so nothing reached a teammate.";
}
