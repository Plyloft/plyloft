/**
 * ADR 0006 (third card) — a repository's own risk-checklist classes.
 *
 * The shared definition's `reviewChecklist`: after the core (A to I) the
 * sweep, the follow-up and the self-check quote them as J, K…. Edited in
 * Settings › Repository › Build & release; `project_config.rs` enforces the
 * limits, and the editor says the same thing before it asks.
 *
 * Pure — no Tauri or React import — so it is unit-tested under node.
 */

import type { LedgerFinding, ReviewChecklistClass } from "../ipc";

/** Mirrors `project_config.rs::REVIEW_CHECKLIST_MAX_CLASSES`. */
export const MAX_CLASSES = 12;
/** Mirrors `project_config.rs::REVIEW_CHECKLIST_CLASS_MAX_CHARS`. */
export const CLASS_MAX_CHARS = 300;
/** Classes in the core, A to I. */
const CORE_CLASSES = 9;

/** The letter the `index`-th class of the repository's own gets: J, K… */
export function classLetter(index: number): string {
  return String.fromCharCode("A".charCodeAt(0) + Math.min(CORE_CLASSES + index, 25));
}

function squash(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/** Characters a class takes against its limit: name and sentence. */
export function classChars(c: ReviewChecklistClass): number {
  return [...squash(c.name)].length + [...squash(c.sentence)].length;
}

/** The message the backend would refuse `classes` with, or null. The same
 *  words as `project_config::validate_review_checklist`. */
export function checklistError(classes: ReviewChecklistClass[]): string | null {
  if (classes.length > MAX_CLASSES) {
    return `A repository can add at most ${MAX_CLASSES} checklist classes; this list has ${classes.length}.`;
  }
  for (let i = 0; i < classes.length; i++) {
    const name = squash(classes[i].name);
    const letter = classLetter(i);
    if (!name) return `Checklist class ${letter} needs a name.`;
    if (!squash(classes[i].sentence)) {
      return `Checklist class ${letter} (${name}) needs its sentence: what a review must look for.`;
    }
    const chars = classChars(classes[i]);
    if (chars > CLASS_MAX_CHARS) {
      return `Checklist class ${letter} (${name}) is ${chars} characters; a class is at most ${CLASS_MAX_CHARS}, name and sentence together.`;
    }
  }
  return null;
}

/** How far a list is from the limits — the same measure as
 *  `project_config::checklist_invalidity`: classes over the count, plus
 *  classes without a name or a sentence, or over the length. 0 is valid. A
 *  save of a stored list already over them is taken when it lowers this
 *  (GH #111 F23: repaired a step at a time). */
export function checklistInvalidity(classes: ReviewChecklistClass[]): number {
  const bad = classes.filter(
    (c) => !squash(c.name) || !squash(c.sentence) || classChars(c) > CLASS_MAX_CHARS,
  ).length;
  return Math.max(0, classes.length - MAX_CLASSES) + bad;
}

/** What a save of `next` over `current` meets: null when it is taken — a
 *  valid list, or one that repairs an invalid `current` a step — else the
 *  reason. */
export function saveError(
  current: ReviewChecklistClass[],
  next: ReviewChecklistClass[],
): string | null {
  const error = checklistError(next);
  if (!error) return null;
  return checklistInvalidity(next) < checklistInvalidity(current) ? null : error;
}

/** Where the class the editor opened now is: found by its value, since a
 *  Sync may have moved or removed it (GH #111 F8). -1 when it is gone. */
export function indexOfClass(classes: ReviewChecklistClass[], original: ReviewChecklistClass): number {
  return classes.findIndex((c) => c.name === original.name && c.sentence === original.sentence);
}

/** The list with `edited` put at `index` (or added at the end when index
 *  is null). */
export function withClass(
  classes: ReviewChecklistClass[],
  index: number | null,
  edited: ReviewChecklistClass,
): ReviewChecklistClass[] {
  const clean = { name: squash(edited.name), sentence: squash(edited.sentence) };
  if (index == null) return [...classes, clean];
  return classes.map((c, i) => (i === index ? clean : c));
}

/** ADR 0006 (third card): a finding a follow-up review raised and marked
 *  as already in the code the sweep read — the sweep had no class for it.
 *  A pre-existing one too: who wrote the defect does not decide whether the
 *  checklist lacks its class (GH #111 F14). */
export function offersChecklistClass(finding: LedgerFinding): boolean {
  return finding.sweepSaw === true && finding.round > 1;
}

const NAME_MAX_CHARS = 60;

function clip(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max - 1).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A draft class from a late finding: its title as the name, the first
 *  sentence of its scenario as what to look for. The person edits it
 *  before Save; nothing is added without them. */
export function draftFromFinding(finding: LedgerFinding): ReviewChecklistClass {
  const name = clip(squash(finding.title).replace(/\.$/, ""), NAME_MAX_CHARS);
  // The body is `**P2 — Title.** \`path:line\`` then the scenario, then
  // `**Fix:** …`; the scenario's first sentence says what went wrong.
  const lines = finding.body.split("\n");
  const scenario = squash(
    lines
      .slice(lines[0]?.startsWith("**") ? 1 : 0)
      .join(" ")
      .split("**Fix:**")[0],
  );
  const first = scenario.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? scenario;
  const room = CLASS_MAX_CHARS - [...name].length;
  const sentence = first
    ? clip(`Look for this again: ${first}`, room)
    : clip(`Look for the kind of defect in finding ${finding.id}.`, room);
  return { name, sentence };
}
