/**
 * GH #106 (ADR 0005, BOARDS.md §3 `Comes with Ply`): the switch on a skill that
 * comes with Ply, as a rule about `settings.json`.
 *
 * `settings.library.plySkillsOff` holds the names switched **off**, and that is
 * the whole of the migration: all of them are on by default, so an absent list
 * is every skill on, a fresh settings file is every skill on, and an app update
 * that ships a new one delivers it without a settings write.
 *
 * Pure, so `node` can test it, and because the change has to be computable
 * **inside** a settings mutation: `useSettings.update` applies it to the settings
 * as they are when its turn comes, and a list built out here from an older
 * snapshot would undo whatever landed in between (GH #100 review 2).
 */

/** Is this skill switched on, given the names switched off? */
export function plySkillOn(off: readonly string[], name: string): boolean {
  return !off.includes(name);
}

/**
 * The switched-off list with `name` switched on or off.
 *
 * The same list back — by reference — when it already says that, so a mutation
 * that changes nothing can be recognised and skipped rather than writing the
 * whole file for nothing. Sorted, so two Macs that switched the same pair off in
 * a different order hold the same bytes and a diff of the file says something.
 */
export function withPlySkill(
  off: readonly string[],
  name: string,
  on: boolean,
): readonly string[] {
  if (on === plySkillOn(off, name)) return off;
  const next = on ? off.filter((each) => each !== name) : [...off, name];
  // `Set` first: a hand-edited file may hold a name twice, and switching
  // something else off is no reason to keep the duplicate.
  return [...new Set(next)].sort();
}

/** The settings a mutation returns when one Ply skill is switched. */
export function plySkillSwitchedIn<
  T extends { library: { plySkillsOff: string[] } },
>(latest: T, name: string, on: boolean): T {
  return {
    ...latest,
    library: {
      ...latest.library,
      plySkillsOff: [...withPlySkill(latest.library.plySkillsOff, name, on)],
    },
  };
}
