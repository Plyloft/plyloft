// Group B decision §3: `New skill…` in Library › Skills — the words and the
// checks of the flow, kept pure so they are tested without a window.
//
// The Library creates the container and Code the content (ADR 0005): the flow
// asks a name and a one-line description, then the backend
// (`project_skills::create_new_skill`) writes `.claude/skills/<name>/SKILL.md`
// and `.agents/skills/<name>/SKILL.md` with the same text in the checkout.
// The backend repeats every check here; these only let the flow say the
// problem before the button is pressed.

/** The two roots the flow writes, Claude's first. Mirrors `INSTALL_ROOTS`. */
export const NEW_SKILL_ROOTS = [".claude/skills", ".agents/skills"] as const;

/** Mirrors `project_skills::NEW_SKILL_NAME_MAX`. */
export const NEW_SKILL_NAME_MAX = 64;
/** Mirrors `project_skills::NEW_SKILL_DESCRIPTION_MAX`. */
export const NEW_SKILL_DESCRIPTION_MAX = 1024;

/** The flow's hint under the description field. */
export const DESCRIPTION_HINT =
  "One line that starts “Use when…”: the agent reads it to decide when the skill applies.";

/**
 * Why `name` cannot be a new skill's, or `null`. Mirrors
 * `project_skills::new_skill_name_problem`, sentence for sentence.
 */
export function nameProblem(name: string): string | null {
  if (name === "") return "Give the skill a name.";
  if ([...name].length > NEW_SKILL_NAME_MAX) {
    return `A name is at most ${NEW_SKILL_NAME_MAX} characters.`;
  }
  if (!/^[a-z0-9-]+$/.test(name)) return "Use lowercase letters, digits and hyphens only.";
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
    return "A hyphen goes between two words, not at an end or twice.";
  }
  if (windowsReserved(name)) {
    return `\`${name}\` is a name Windows keeps for a device, so no folder can have it there.`;
  }
  return null;
}

/**
 * A device name Windows refuses as a folder name, in any case. Mirrors
 * `project_skills::windows_reserved`: refused on every platform, because the
 * skill must check out on a teammate's Windows PC too.
 */
export function windowsReserved(name: string): boolean {
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name);
}

/** Why `description` cannot be a new skill's, or `null`. */
export function descriptionProblem(description: string): string | null {
  const text = description.trim();
  if (text === "") return "Say when the agent should use it — the description is how it decides.";
  if (/[\r\n]/.test(text)) return "The description is one line.";
  if ([...text].length > NEW_SKILL_DESCRIPTION_MAX) {
    return `A description is at most ${NEW_SKILL_DESCRIPTION_MAX} characters.`;
  }
  return null;
}

/**
 * Why the name is taken in this repository, or `null`: a skill in the
 * checkout (any root either CLI reads), a directory neither CLI loads, or one
 * that is on the integration branch and not in this checkout yet.
 */
export function nameTaken(
  name: string,
  repository: {
    skills: { name: string }[];
    unloadable: { name: string; root: string }[];
    mirror: { name: string }[];
  },
  branch: string | null,
): string | null {
  if (repository.skills.some((skill) => skill.name === name)) {
    return `This repository already has a skill called ${name}.`;
  }
  const unloadable = repository.unloadable.find((skill) => skill.name === name);
  if (unloadable) return `${unloadable.root} already has a ${name} folder.`;
  if (repository.mirror.some((skill) => skill.name === name)) {
    return `${branch ?? "The integration branch"} already carries a skill called ${name}.`;
  }
  return null;
}

/** The roots the flow would write that git ignores here, in writing order. */
export function newSkillIgnoredRoots(ignoredRoots: readonly string[]): string[] {
  return NEW_SKILL_ROOTS.filter((root) => ignoredRoots.includes(root));
}

/** Why the flow cannot write at all, when a root it writes is gitignored. */
export function ignoredRefusal(roots: string[]): string {
  return (
    `Git ignores ${roots.join(" and ")} here, so no card could carry the new skill. ` +
    `Press Let Git see it first.`
  );
}

/**
 * The flow's closing line, above the button: that nothing is committed, and
 * that the two copies must be kept in step. The paths are in [`newSkillPaths`],
 * under Details.
 */
export function newSkillClosingLine(branch: string | null): string {
  const where = branch ?? "the integration branch";
  return (
    `Plyloft adds it to your project folder for Claude and Codex, with the same text, and opens ` +
    `Claude's copy in Code. Nothing is committed: Ship it with a card (or Publish to ${where}, ` +
    `where the row offers it) gets it to teammates. Edit both copies, or Align them once ` +
    `published, so Claude and Codex read the same skill.`
  );
}

/** Where the two copies go, for the flow's Details. */
export function newSkillPaths(name: string): { claude: string; codex: string } {
  const shown = name || "<name>";
  return {
    claude: `${NEW_SKILL_ROOTS[0]}/${shown}/SKILL.md`,
    codex: `${NEW_SKILL_ROOTS[1]}/${shown}/SKILL.md`,
  };
}

/** The toast after it was written. */
export function createdToast(name: string): { title: string; body: string } {
  return {
    title: `${name} is in this repository`,
    // QoL 13 (walk): both copies are written the same, so the row shows
    // them aligned — the toast says what is true now, and what an edit to
    // one copy alone does.
    body:
      "Written for Claude and Codex, with the same text, and opened in Code (Claude's copy). " +
      "If you edit only that copy, the row says the two differ until Codex's matches. Ship it with a card once it reads right.",
  };
}
