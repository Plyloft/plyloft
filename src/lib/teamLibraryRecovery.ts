// GH #226: a team clone that is ahead AND behind GitHub, and its way out —
// "Reapply mine on top". Pure: no React, no stores, no IPC, so node runs it
// (`src/lib/teamLibraryRecovery.test.ts`).
//
// The owner's decision: Ply rebases this Mac's unpublished library commits
// onto GitHub's and pushes them — never a force-push. A collision (the same
// file changed on both sides) is aborted with the clone left exactly as it
// was, and the member is told which file and what to do.
//
// ux-language PATTERNS §4: the three parts are words; the clone's path, the
// backup ref, the repo-relative paths and git's output live in Details only.

// Type-only, so this file stays runnable by node on its own.
import type { LibraryDivergence, LibraryInterruption, LibraryResolved, ReapplyChoice, ReapplyReport } from "../ipc";
import type { UxError, UxErrorAction } from "./uxError.ts";
import { basename } from "./paths.ts";
import { machineWords, platformWord } from "./platform.ts";

/** The one way out, in every surface that offers it. */
export const REAPPLY_LABEL = "Reapply mine on top";

/** The action ids the Settings › Team blocks switch on. */
export const REAPPLY_ACTION = "reapply";
export const REVEAL_ACTION = "reveal";

const REAPPLY: UxErrorAction = { id: REAPPLY_ACTION, label: REAPPLY_LABEL, primary: true };
const REVEAL: UxErrorAction = { id: REVEAL_ACTION, label: platformWord("showIn") };

// ── QoL 13.3: the conflict resolver's words ──────────────────────────────

/** The three choices per file, in the order the chooser shows them. */
export const CHOICE_LABELS: { value: ReapplyChoice; label: string }[] = [
  { value: "mine", label: "Keep mine" },
  { value: "theirs", label: "Keep theirs" },
  { value: "both", label: "Keep both" },
];
/** What each choice does, under the chooser. */
export const CHOICE_MEANING_MAC =
  "Keep mine puts your version in the team library; Keep theirs keeps your teammate's; Keep both " +
  "keeps your teammate's in the library and saves yours in a folder on this Mac.";
/** What each choice does, under the chooser, in this machine's words. */
export function choiceMeaning(): string {
  return machineWords(CHOICE_MEANING_MAC);
}
/** The chooser's button: settles on this Mac, publishes nothing. */
export const SETTLE_LABEL = "Put them together";
export const MOVE_ASIDE_LABEL = "Move them aside";
export const PUBLISH_LABEL = "Publish";
export const UNDO_LABEL = "Undo";

export const MOVE_ASIDE_ACTION = "move-aside";
export const PUBLISH_ACTION = "publish";
export const UNDO_ACTION = "undo";

const MOVE_ASIDE: UxErrorAction = { id: MOVE_ASIDE_ACTION, label: MOVE_ASIDE_LABEL, primary: true };
const PUBLISH: UxErrorAction = { id: PUBLISH_ACTION, label: PUBLISH_LABEL, primary: true };
const UNDO: UxErrorAction = { id: UNDO_ACTION, label: UNDO_LABEL };

/** Every file a collision named has a choice. */
export function allChosen(paths: string[], choices: Record<string, ReapplyChoice>): boolean {
  return paths.length > 0 && paths.every((p) => choices[p] !== undefined);
}

/** The block while choices wait on this Mac to be published or undone. */
export function resolvedError(resolved: Pick<LibraryResolved, "paths" | "asideDir" | "cloneDir" | "backupRef">): UxError {
  const kept = resolved.asideDir
    ? machineWords(" Your own version of what you kept both of is saved in a folder on this Mac.")
    : "";
  const lines = [`Team clone: ${resolved.cloneDir}`, `Backup: ${resolved.backupRef}`];
  if (resolved.asideDir) lines.push(`Saved versions: ${resolved.asideDir}`);
  lines.push(...resolved.paths.map((p) => `  ${p}`));
  return {
    title: machineWords("Your choices are put together, on this Mac only."),
    happened:
      `Plyloft put your team library changes on top of your teammate's, keeping what you chose for ` +
      `${listed(resolved.paths) || "each file"}.${kept}`,
    untouched: "Nothing is published yet, and the backup of how it was is kept.",
    todo: machineWords(`${PUBLISH_LABEL} sends them to the team library. ${UNDO_LABEL} puts the team library on this Mac back as it was.`),
    actions: [PUBLISH, UNDO],
    details: lines.join("\n"),
  };
}

function changes(n: number): string {
  return n === 1 ? "1 change" : `${n} changes`;
}

/** File names only — the folders are Details'. */
function listed(paths: string[]): string {
  const items = paths.map((p) => basename(p));
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Settings › Team's block while the clone is ahead and behind GitHub. */
export function divergenceError(divergence: LibraryDivergence): UxError {
  return {
    title: "Your team library changes aren't on GitHub.",
    happened:
      `${platformWord("thisMachine")} has ${changes(divergence.ahead)} to the team library that never reached ` +
      `GitHub, and a teammate published ${changes(divergence.behind)} meanwhile. Until the ` +
      "two are put together, every share, move or removal in the team library stops here.",
    untouched:
      "Your changes are kept in the team clone on this Mac, and your teammates' are on " +
      "GitHub. Nothing was lost or overwritten.",
    todo:
      `${REAPPLY_LABEL} puts yours after your teammates' and publishes them. Plyloft keeps a ` +
      "backup first. If you both changed the same file, it stops, changes nothing, and " +
      "tells you which file.",
    actions: [REAPPLY],
    details: `Team clone: ${divergence.cloneDir}`,
  };
}

/** Settings › Team's block while a rebase or merge is under way in the clone. */
export function interruptionError(interruption: LibraryInterruption): UxError {
  const details = `Team clone: ${interruption.cloneDir}`;
  if (interruption.own) {
    return {
      title: "Plyloft's last reapply didn't finish.",
      happened:
        "Plyloft was stopped while it was putting your team library changes on top of " +
        "GitHub's, so the team clone is still halfway through. Every write to the team " +
        "library stops here until it is finished.",
      untouched:
        "Nothing was published. Your changes are safe in the backup Plyloft made before it " +
        "started.",
      todo: `${REAPPLY_LABEL} puts the clone back to that backup and starts again.`,
      actions: [REAPPLY],
      details,
    };
  }
  return {
    title: "The team clone is in the middle of a git merge.",
    happened:
      "Someone started a git merge (or a similar step) in the team clone on this Mac and didn't finish " +
      "it. Plyloft didn't start it, so it won't touch it — and every write to the team library " +
      "stops here until it is done.",
    untouched: "Plyloft changed nothing in the clone and published nothing.",
    todo: "Finish or abort it in the team clone (Details says where), then write again.",
    actions: [REVEAL],
    details,
  };
}

/** The raw facts of a report, for `Details`: where the clone is, the backup,
 *  the files, and git's own words. */
function reportDetails(report: ReapplyReport): string {
  const lines = [`Team clone: ${report.cloneDir}`];
  if (report.backupRef) lines.push(`Backup of ${machineWords("this Mac's")} changes: ${report.backupRef}`);
  if (report.paths.length > 0) lines.push(...report.paths.map((p) => `  ${p}`));
  if (report.detail) lines.push("", report.detail);
  return lines.join("\n");
}

/** The block a finished reapply leaves on Settings › Team, or null when it
 *  succeeded and there is nothing left to do. */
export function reapplyError(report: ReapplyReport): UxError | null {
  const details = reportDetails(report);
  const them = report.paths.length === 1 ? "it" : "them";
  switch (report.result) {
    case "published":
    case "in_step":
      return null;
    case "collision":
      return {
        title: "You and a teammate changed the same file.",
        happened:
          `Both of you changed ${listed(report.paths)}, so Plyloft can't put yours on top ` +
          "without choosing between the two versions.",
        untouched:
          "Plyloft stopped and put everything back exactly as it was: nothing was published " +
          "or lost, and a backup of your changes is kept in the team clone.",
        // QoL 13.3: chosen here, per file — the chooser under this block.
        todo:
          `Choose which version the team library keeps for each file, then ${SETTLE_LABEL}. ` +
          machineWords("Plyloft puts them together on this Mac first; nothing is published until you say so."),
        actions: [REVEAL],
        details,
      };
    case "stopped":
      return {
        title: "Git stopped the reapply before it finished.",
        happened:
          "Git couldn't put your changes on top of GitHub's — most often because a file in " +
          "the team clone that isn't part of the library is in the way.",
        untouched: "Plyloft put everything back exactly as it was: nothing was published or lost.",
        todo: `Clear what git names in Details, then press ${REAPPLY_LABEL} again.`,
        actions: [REAPPLY, REVEAL],
        details,
      };
    case "dirty":
      return {
        title: "The team clone has changes Plyloft didn't make.",
        happened:
          `${listed(report.paths)} ${report.paths.length === 1 ? "is" : "are"} changed in ` +
          `the team clone on this Mac without a commit, so Plyloft won't reapply over ${them}.`,
        untouched: "Nothing was changed: no backup, no reapply, nothing published.",
        // QoL 13.3: Plyloft moves them, into a dated folder on this Mac.
        todo: machineWords(
          `${MOVE_ASIDE_LABEL} copies ${them} into a dated folder on this Mac and puts the team library on this Mac back to its last change; then press ${REAPPLY_LABEL} again.`,
        ),
        actions: [MOVE_ASIDE, REVEAL],
        details,
      };
    case "foreign":
      return interruptionError({ own: false, cloneDir: report.cloneDir });
    case "fetch_failed":
      return {
        title: "Plyloft couldn't reach GitHub.",
        happened: "Reapplying needs GitHub's latest team library, and GitHub couldn't be asked.",
        untouched: "Nothing was changed on this Mac or on GitHub.",
        todo: `Check the connection, then press ${REAPPLY_LABEL} again.`,
        actions: [REAPPLY],
        details,
      };
    case "push_refused":
      return {
        title: "A teammate published again.",
        happened: `Plyloft put your ${changes(report.reapplied)} on top of GitHub's, but a teammate published again before they reached GitHub.`,
        untouched: "Your changes are kept in the team clone on this Mac, with a backup of how they were.",
        todo: `Press ${REAPPLY_LABEL} again.`,
        actions: [REAPPLY],
        details,
      };
    case "push_denied":
      return {
        title: "GitHub won't take your changes from this account.",
        happened: `GitHub refused your ${changes(report.reapplied)}: this account may not be allowed to publish to the team's repository, or its branch is protected.`,
        untouched: "Your changes are kept in the team clone on this Mac, on top of GitHub's.",
        todo: "Pressing again won't help. Ask the team's owner for write access, with GitHub's answer from Details.",
        actions: [],
        details,
      };
    case "push_timed_out":
      return {
        title: "GitHub didn't answer in time.",
        happened: `Plyloft put your ${changes(report.reapplied)} on top of GitHub's, but GitHub didn't confirm the publish before Plyloft stopped waiting.`,
        untouched:
          "Your changes are kept in the team clone on this Mac, and may have reached GitHub anyway.",
        todo: `Once the connection is back, press ${REAPPLY_LABEL} again: it publishes them if they didn't land and changes nothing if they did.`,
        actions: [REAPPLY],
        details,
      };
    case "resolved":
      return resolvedError({
        paths: report.paths,
        asideDir: report.asideDir ?? null,
        cloneDir: report.cloneDir,
        backupRef: report.backupRef ?? "",
      });
    case "unrecovered":
      return {
        title: "Plyloft couldn't put the team clone back.",
        happened:
          "Git stopped the reapply, and Plyloft couldn't confirm the team clone is back as it was.",
        untouched: "Nothing was published. Your changes are safe in the backup Plyloft made first.",
        todo:
          "Don't write to the team library until someone who knows git has looked at the " +
          "team clone — Details names it and the backup.",
        actions: [REVEAL],
        details,
      };
  }
}

/** The toast one reapply raises. Success confirms; anything else says what
 *  happened in the backend's words — the block on Settings › Team keeps the
 *  way out, and Details, on the page. */
export function reapplyToast(report: ReapplyReport): {
  kind: "info" | "error";
  title: string;
  body: string;
} {
  const error = (title: string) => ({ kind: "error" as const, title, body: report.message });
  switch (report.result) {
    case "published":
      return { kind: "info", title: "Your team library changes are published", body: report.message };
    case "in_step":
      return { kind: "info", title: "Team library already in step", body: report.message };
    case "collision":
      return error("Reapply stopped: the same file changed on both sides");
    case "stopped":
      return error("Reapply stopped: git couldn't finish it");
    case "dirty":
      return error("Reapply refused: the team clone has uncommitted changes");
    case "foreign":
      return error("Reapply refused: a rebase or merge is under way in the team clone");
    case "fetch_failed":
      return error("Reapply stopped: GitHub couldn't be reached");
    case "push_refused":
      return error("Reapplied, but a teammate published again");
    case "push_denied":
      return error("Reapplied, but GitHub won't take it from this account");
    case "push_timed_out":
      return error("Reapplied, but GitHub didn't answer");
    case "unrecovered":
      return error("Reapply stopped, and the team clone needs a look");
    case "resolved":
      return { kind: "info", title: machineWords("Your choices are put together on this Mac"), body: report.message };
  }
}
