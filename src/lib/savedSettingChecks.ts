// 1.176.1: the saved free-text settings that can't work, as one typed list,
// for Settings › Diagnostics (a row each, with a button that opens the field)
// and for whatever else says "this needs you" (the sidebar's row, wired at
// merge). Pure over the readings: `savedSettingProblems` takes the values and
// a `check`, so node tests it without Tauri.
//
//     node --experimental-strip-types src/lib/savedSettingChecks.test.ts
//
// Read when Diagnostics opens and at each Look again; never per keystroke,
// never written back: a press on the row opens the field, which names its
// corrections.

import { checkReason, needsAttention, type CheckContext, type CheckKind, type Reading } from "./settingCheck.ts";

/** Which saved setting. */
export type SavedSettingId = "tileShell" | "teamCloneRoot" | "setupCommand" | "tryCommand";

/** One saved setting that can't work as written, or fails here. */
export interface SavedSettingProblem {
  id: SavedSettingId;
  /** What the row is called: the field's own label. */
  label: string;
  /** The saved value. */
  value: string;
  /** One sentence: why. */
  reason: string;
  /** Where the field is: `openSettingsSection(section, { row })`. */
  open: { section: string; row: string };
  /** A broken this-computer setting stops work at once; a project command
   *  stops only the step that runs it. */
  signal: "error" | "warn";
  /** The sidebar's "needs you" words (`error` ones only). */
  needsYou: string | null;
}

/** The sidebar's words, per this-computer setting. */
export const NEEDS_YOU_WORDS: Partial<Record<SavedSettingId, string>> = {
  tileShell: "Tile shell can't start",
  teamCloneRoot: "Team folder can't be used",
};

/** What the sidebar's "needs you" row shows: only the certain failures of
 *  this computer's settings. Command warnings stay in Diagnostics and next to
 *  their field. */
export function needsYouProblems(list: readonly SavedSettingProblem[]): SavedSettingProblem[] {
  return list.filter((p) => p.signal === "error" && p.needsYou !== null);
}

/** The saved values read. Empty or absent ones are skipped. */
export interface SavedSettings {
  tileShell?: string | null;
  teamCloneRoot?: string | null;
  /** The open project's commands, read against its folder. */
  project?: {
    folder: string;
    setupCommand?: string | null;
    tryCommand?: string | null;
  } | null;
}

type Check = (kind: CheckKind, value: string, context?: CheckContext) => Promise<Reading>;

interface Asked {
  id: SavedSettingId;
  label: string;
  kind: CheckKind;
  value: string;
  context?: CheckContext;
  open: { section: string; row: string };
}

/** The settings that can't work as written, in the order their rows show. A
 *  reading that fails is left out rather than guessed. */
export async function savedSettingProblems(saved: SavedSettings, check: Check): Promise<SavedSettingProblem[]> {
  const asked: Asked[] = [];
  const add = (a: Omit<Asked, "value">, value: string | null | undefined) => {
    if (value && value.trim()) asked.push({ ...a, value });
  };
  add({ id: "tileShell", label: "Tile shell", kind: "tileShell", open: { section: "editor-terminals", row: "Tile shell" } }, saved.tileShell);
  add(
    {
      id: "teamCloneRoot",
      label: "Where team workspaces are cloned",
      kind: "folder",
      context: { keepsTilde: true },
      open: { section: "team-workspaces", row: "Where team workspaces are cloned" },
    },
    saved.teamCloneRoot,
  );
  const p = saved.project;
  if (p) {
    add(
      {
        id: "setupCommand",
        label: "Before the Builder starts, run",
        kind: "command",
        context: { project: p.folder },
        open: { section: "build-release", row: "Before the Builder starts, run" },
      },
      p.setupCommand,
    );
    add(
      {
        id: "tryCommand",
        label: "How to start your app",
        kind: "command",
        // Typed into the person's own shell: a word not found is a hint, and
        // never a row here.
        context: { project: p.folder, interactive: true },
        open: { section: "build-release", row: "How to start your app" },
      },
      p.tryCommand,
    );
  }
  const read = await Promise.all(
    asked.map((a) =>
      check(a.kind, a.value, a.context).then(
        (r) => ({ a, r }),
        () => null,
      ),
    ),
  );
  return read
    .filter((x): x is { a: Asked; r: Reading } => x !== null && needsAttention(x.r))
    .map(({ a, r }) => ({
      id: a.id,
      label: a.label,
      value: a.value,
      reason: checkReason(r),
      open: a.open,
      signal: a.kind === "command" ? ("warn" as const) : ("error" as const),
      needsYou: a.kind === "command" ? null : (NEEDS_YOU_WORDS[a.id] ?? null),
    }));
}
