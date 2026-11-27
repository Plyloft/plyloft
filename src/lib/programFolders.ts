// 1.176.1: the Program folders setting (`shell.pathOverride`), read before it
// can break the app (`program_folders.rs`), in words. Pure apart from the one
// IPC wrapper, so the words and the save decision are tested in node:
//
//     node --experimental-strip-types src/lib/programFolders.test.ts
//
// The owner's MacBook held `~/.local/bin/claude` there — a program, written
// with `~` — and the row only said "Claude is not on this PATH". Now the row
// says what the list finds and doesn't, and a value that can't work is not
// saved as typed: a `~` is written out, a file is offered as its folder, a
// variable as the explicit list, and a list that leaves the tools or the
// system folders out waits for a confirmation that names what won't be found.

import { invoke } from "@tauri-apps/api/core";

export type ProgramFoldersProblem =
  | "namesAFile"
  | "variable"
  | "tilde"
  | "otherHome"
  | "relative"
  /** Mac: a folder name holds a `:`. */
  | "colonInName"
  /** Spaces or quotes around an entry, an empty entry, a folder twice. */
  | "untidy";

export type ProgramFoldersEntryState =
  | { kind: "folder" }
  | { kind: "missing" }
  | { kind: "file"; folder: string }
  | { kind: "relative" }
  | { kind: "empty" }
  | { kind: "otherHome" }
  | { kind: "unknownVariable"; name: string }
  | { kind: "shellFolders" }
  | { kind: "colonInName"; folder: string };

export interface ProgramFoldersEntry {
  text: string;
  /** Exactly as tiles receive it (untrimmed). */
  raw: string;
  path: string | null;
  tilde: boolean;
  variables: string[];
  state: ProgramFoldersEntryState;
}

/** `program_folders::Verdict`. */
export interface ProgramFoldersVerdict {
  windows: boolean;
  entries: ProgramFoldersEntry[];
  found: { name: string; path: string }[];
  /** Of claude, codex, git and gh, what the list as written doesn't find. */
  missing: string[];
  /** Mac: of curl, bash and sh, what it doesn't find. */
  basicsMissing: string[];
  systemFoldersMissing: string[];
  problems: ProgramFoldersProblem[];
  /** What a save stores (`~` written out, empty entries dropped); null while
   *  an entry blocks the save. */
  saveAs: string | null;
  useFolders: string | null;
  expanded: string | null;
  pathVariableFirst: boolean;
  withShell: string | null;
  needsConfirmation: boolean;
  /** Every folder the value adds is already among what the shell reports:
   *  emptying the setting (following the shell) is the better fix. */
  shellHasThem: boolean;
}

/** The reading of a value (on save, and when the page opens). */
export function programFoldersCheck(value: string): Promise<ProgramFoldersVerdict> {
  return invoke<ProgramFoldersVerdict>("program_folders_check", { value });
}

/** The row's hint (and its settings-search line), per platform. 1.176.1:
 *  "Folders, not programs" leads, after the owner's `~/.local/bin/claude`;
 *  "left empty" says what Plyloft really uses there (`shell_env::run_probe`
 *  widens either with `known_tool_dirs`). */
export const PROGRAM_FOLDERS_HINT_MAC =
  // ux-allow: names the terminal's own word
  "Folders, not programs: where Plyloft looks for the claude, codex, git and gh commands. Called PATH in a terminal. Left empty it uses what your login shell reports, plus where these tools usually install. Tiles and runs started from now on get it.";
export const PROGRAM_FOLDERS_HINT_WINDOWS =
  // ux-allow: names the terminal's own word
  "Folders, not programs: where Plyloft looks for the claude, codex, git and gh commands. Called PATH in a terminal. Left empty it uses the folders Windows gave Plyloft when it started, plus where these tools usually install. Tiles and runs started from now on get it.";

/** The commands the row reports on, in order. */
export const TOOLS = ["claude", "codex", "git", "gh"] as const;

/** "a", "a and b", "a, b and c" (`or` for a negative). */
export function listWords(items: readonly string[], join: "and" | "or" = "and"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${join} ${items[items.length - 1]}`;
}

/** One plain sentence per problem of the list as written. */
export function problemSentence(p: ProgramFoldersProblem, windows: boolean): string {
  switch (p) {
    case "namesAFile":
      return "It names a file, not a folder. Program folders holds folders, such as the one the file is in.";
    case "variable":
      return windows
        ? "It uses a variable, a name between % signs. This list replaces what Windows reports, and Plyloft reads it as written."
        : "It uses a variable, a name starting with $. This list replaces what your shell reports, and Plyloft reads it as written.";
    case "tilde":
      return "It is written with ~, which Plyloft reads as written, not as your home folder.";
    case "otherHome":
      // Review 1: `~+`, `~-` and `~name` alike — said without guessing.
      return "It starts with ~ in a form Plyloft doesn't read as a folder. Write the whole folder instead.";
    case "relative":
      return windows
        ? "It holds a folder that doesn't start with a drive letter. Write the whole folder, such as C:\\Program Files\\Git\\cmd."
        : "It holds a folder that doesn't start with /. Write the whole folder, such as /opt/homebrew/bin.";
    case "colonInName":
      return "A folder's name holds a :, which separates folders in this list, so that folder can't be written here. Put a link to it in a folder whose path has no :.";
    case "untidy":
      return "It has spaces or quotes around a folder, an empty place between two : signs, or the same folder twice. New tiles get it exactly as written.";
    default: {
      const never: never = p;
      return String(never);
    }
  }
}

/** The short reason Diagnostics and Repair give ("it names a file, not a
 *  folder"), problems joined. */
export function problemReason(problems: readonly ProgramFoldersProblem[], windows: boolean): string {
  const one = (p: ProgramFoldersProblem): string => {
    switch (p) {
      case "namesAFile":
        return "it names a file, not a folder";
      case "variable":
        return windows ? "it uses a variable, a name between % signs" : "it uses a variable, a name starting with $";
      case "tilde":
        return "it is written with ~";
      case "otherHome":
        return "it starts with ~ in a form Plyloft can't read";
      case "relative":
        return "it holds a folder that isn't written in full";
      case "colonInName":
        return "a folder's name holds a :";
      case "untidy":
        return "it has spaces, quotes or empty places in it";
      default: {
        const never: never = p;
        return String(never);
      }
    }
  };
  return listWords(problems.map(one));
}

/** What the list finds and doesn't, under the row. */
export function findsLine(v: ProgramFoldersVerdict): string {
  const found = TOOLS.filter((t) => v.found.some((f) => f.name === t));
  const parts: string[] = [];
  if (found.length === TOOLS.length) parts.push(`Finds ${listWords(found)}.`);
  else if (found.length === 0) parts.push(`Finds none of ${listWords([...TOOLS])}.`);
  else parts.push(`Finds ${listWords(found)}. Doesn't find ${listWords(v.missing, "or")}.`);
  // 1.176.1 walk: a shell tile's own startup files rebuild its list, so
  // nothing is claimed about terminals — only where the commands live.
  const left = leftOutLine(v);
  if (left) parts.push(left);
  const gone = v.entries.filter((e) => e.state.kind === "missing").map((e) => e.path ?? e.text);
  if (gone.length > 0) parts.push(`${listWords(gone)} ${gone.length === 1 ? "doesn't" : "don't"} exist.`);
  return parts.join(" ");
}

/** What a save of a typed value does: store `value` now, ask first, or not
 *  save it as typed. */
export type SaveDecision =
  | { kind: "save"; value: string }
  | { kind: "confirm"; value: string }
  | { kind: "blocked" };

export function saveDecision(v: ProgramFoldersVerdict): SaveDecision {
  if (v.saveAs === null) return { kind: "blocked" };
  if (v.needsConfirmation) return { kind: "confirm", value: v.saveAs };
  return { kind: "save", value: v.saveAs };
}

/** A press the row offers: a corrected value to save, or the person's way
 *  out. */
export type FolderAction =
  | { id: "useFolders" | "expand" | "withShell" | "anyway" | "tidy"; label: string; value: string }
  | { id: "keep" | "empty"; label: string };

/** Review 1: why emptying is offered first. */
export const SHELL_HAS_THEM =
  "Your shell already reports this folder. Left empty, Plyloft follows your shell, also when it changes.";
/** Review 1: what an explicit list written from the shell's is. */
export const FIXED_LIST = "This list is fixed: it won't follow later changes in your shell.";

/** Windows walk (1.176.1): on Windows there is no shell to report folders —
 *  it is the folders Windows gave Plyloft. Each sentence in its platform's
 *  words. */
export function shellHasThemLine(windows: boolean): string {
  return windows
    ? "Windows already gives Plyloft this folder. Left empty, Plyloft follows the folders Windows gives it, also when they change."
    : SHELL_HAS_THEM;
}
export function fixedListLine(windows: boolean): string {
  return windows ? "This list is fixed: it won't follow later changes in the folders Windows gives Plyloft." : FIXED_LIST;
}
/** "the folders your shell reports now" / "the folders Windows gives Plyloft now". */
export function shellFoldersNow(windows: boolean): string {
  return windows ? "the folders Windows gives Plyloft now" : "the folders your shell reports now";
}
/** "what your shell reports" / "the folders Windows gives it". */
export function whatShellReports(windows: boolean): string {
  return windows ? "the folders Windows gives it" : "what your shell reports";
}

export interface FoldersNotice {
  title: string;
  lines: string[];
  actions: FolderAction[];
}

/** The system folders (or everyday commands) the list leaves out, said
 *  without a claim about terminals: Plyloft and the Claude and Codex tiles it
 *  starts look only in these folders; a shell tile adds what its own startup
 *  files add. */
function leftOutLine(v: ProgramFoldersVerdict): string | null {
  if (v.systemFoldersMissing.length > 0) {
    return v.windows
      ? `It leaves out ${listWords(v.systemFoldersMissing)}, where Windows' own commands live.`
      : `It leaves out ${listWords(v.systemFoldersMissing)}, where everyday commands such as curl and bash live.`;
  }
  if (v.basicsMissing.length > 0) return `It doesn't find ${listWords(v.basicsMissing, "or")}.`;
  return null;
}

function confirmLines(v: ProgramFoldersVerdict): string[] {
  const lines: string[] = [];
  if (v.missing.length === TOOLS.length) {
    lines.push(`Plyloft won't find ${listWords(v.missing, "or")} there, so no Claude or Codex tile can start.`);
  } else if (v.missing.length > 0) {
    lines.push(`Plyloft won't find ${listWords(v.missing, "or")} there.`);
  }
  const left = leftOutLine(v);
  if (left) lines.push(left);
  return lines;
}

/** The fixes the reading offers, in the order they are pressed most, and
 *  the sentences they need. Review 1: when the shell already reports every
 *  folder the value adds, emptying comes first and no fixed copy of the
 *  shell's list is offered; a fixed copy says that it is one. */
function fixes(v: ProgramFoldersVerdict): { actions: FolderAction[]; lines: string[] } {
  const actions: FolderAction[] = [];
  const lines: string[] = [];
  if (v.shellHasThem) {
    actions.push({ id: "empty", label: "Empty it" });
    lines.push(shellHasThemLine(v.windows));
  }
  const files = v.entries.filter((e) => e.state.kind === "file").length;
  if (v.useFolders !== null) actions.push({ id: "useFolders", label: files > 1 ? "Use their folders" : "Use its folder", value: v.useFolders });
  if (v.shellHasThem) return { actions, lines };
  let fixed = false;
  if (v.expanded !== null) {
    const shellVar = v.entries.some((e) => e.state.kind === "shellFolders");
    const label = !shellVar
      ? "Write the folders out in full"
      : v.pathVariableFirst
        ? `Add them after ${shellFoldersNow(v.windows)}`
        : `Add them in front of ${shellFoldersNow(v.windows)}`;
    fixed ||= shellVar;
    actions.push({ id: "expand", label, value: v.expanded });
  }
  if (v.withShell !== null) {
    actions.push({ id: "withShell", label: `Add them in front of ${shellFoldersNow(v.windows)}`, value: v.withShell });
    fixed = true;
  }
  if (fixed) lines.push(fixedListLine(v.windows));
  return { actions, lines };
}

/**
 * What the row says about a value: a typed one (`typed`: not saved yet) that
 * can't be saved as typed or needs a confirmation, or the saved one when it
 * is written so it can't work. `null`: nothing to say beyond `findsLine`.
 * A typed value that needs a confirmation is asked in the confirm sheet
 * (`ProgramFoldersRow`); the others show under the row.
 */
export function foldersNotice(v: ProgramFoldersVerdict, typed: boolean): FoldersNotice | null {
  const decision = saveDecision(v);
  if (typed && decision.kind === "save") return null;
  // A saved value: any line worth saying gets the way back (1.176.1 walk).
  const gone = v.entries.filter((e) => e.state.kind === "missing");
  const leavesOut = v.needsConfirmation || gone.length > 0;
  if (!typed && v.problems.length === 0 && !leavesOut) return null;
  // A typed `~` (or a stray space) is written out on save: no problem there.
  const problemLines = v.problems
    .filter((p) => !typed || (p !== "tilde" && p !== "untidy"))
    .map((p) => problemSentence(p, v.windows));
  const fix = fixes(v);
  if (typed && decision.kind === "confirm") {
    return {
      title: "Save these program folders?",
      lines: [...problemLines, ...confirmLines(v), ...fix.lines],
      actions: [...fix.actions, { id: "anyway", label: "Save it anyway", value: decision.value }, { id: "keep", label: "Keep what was there" }],
    };
  }
  if (typed) {
    return {
      title: "Plyloft didn't save this.",
      lines: [...problemLines, ...fix.lines],
      actions: [...fix.actions, { id: "keep", label: "Keep what was there" }],
    };
  }
  const tidy =
    v.saveAs !== null && (v.problems.includes("tilde") || v.problems.includes("untidy"))
      ? [{ id: "tidy" as const, label: v.problems.includes("tilde") ? "Write ~ out as your home folder" : "Tidy it", value: v.saveAs }]
      : [];
  // A folder that isn't there, when removing it alone puts the list right.
  const sep = v.windows ? ";" : ":";
  const rest = v.entries.filter((e) => e.state.kind !== "missing" && e.state.kind !== "empty").map((e) => e.text);
  const remove: FolderAction[] =
    gone.length > 0 && v.problems.length === 0 && !v.needsConfirmation && rest.length > 0
      ? [
          {
            id: "tidy",
            label: gone.length === 1 ? `Remove ${gone[0].text}` : "Remove the folders that don't exist",
            value: rest.join(sep),
          },
        ]
      : [];
  const empty = fix.actions.some((a) => a.id === "empty") ? [] : [{ id: "empty" as const, label: "Empty it" }];
  if (v.problems.length === 0) {
    return {
      title: "These program folders leave things out.",
      lines: [...confirmLines(v), ...fix.lines],
      actions: [...remove, ...fix.actions.filter((a) => a.id === "empty"), ...empty],
    };
  }
  return {
    title: "These program folders can't work as written.",
    lines: [...problemLines, ...fix.lines],
    actions: [...fix.actions, ...tidy, ...empty],
  };
}
