// 1.176.1: the free-text settings that can stop work, read before they do
// (`setting_check.rs`), in words. Pure apart from the one IPC wrapper, so the
// words and the save decision are tested in node:
//
//     node --experimental-strip-types src/lib/settingCheck.test.ts
//
// The model is Program folders (`programFolders.ts`): a value is read on save
// and when its page opens, never per keystroke; plain words under the field
// say what it finds; a value that certainly can't work isn't saved as typed;
// an unusual one is saved after a confirmation that names the consequence; a
// saved broken value is reported with its corrections, never changed by
// itself.

import { invoke } from "@tauri-apps/api/core";

/** `setting_check::CheckKind`. */
export type CheckKind = "tileShell" | "command" | "script" | "folder";

/** `setting_check::Level`, mildest first. */
export type CheckLevel = "ok" | "hint" | "warn" | "confirm" | "blocked";

/** `setting_check::Finding`. */
export type Finding =
  | { kind: "tilde"; written: string }
  | { kind: "untidy" }
  | { kind: "otherHome" }
  | { kind: "variable"; name: string }
  | { kind: "relative" }
  | { kind: "programNotFound"; name: string }
  | { kind: "notRunnable"; path: string }
  | { kind: "isFolder"; path: string }
  | { kind: "missing"; path: string }
  | { kind: "diskAbsent"; disk: string }
  /** The path, or a folder above it, is a link whose target isn't there. */
  | { kind: "linkAway"; link: string; target: string }
  /** Try it only: not in the folders Plyloft knows; the person's own shell
   *  may add it. A hint, never a broken setting. */
  | { kind: "notFoundHere"; word: string }
  | { kind: "hasArguments"; program: string }
  | { kind: "notAShell"; name: string }
  | { kind: "macShellPath" }
  | { kind: "commandNotFound"; word: string }
  | { kind: "projectFileMissing"; path: string }
  | { kind: "noScript"; script: string; tool: string }
  | { kind: "noPackageJson" }
  | { kind: "noMakefile" }
  | { kind: "noMakeTarget"; target: string }
  | { kind: "notAFolder"; path: string }
  | { kind: "notWritable"; path: string }
  | { kind: "willBeCreated"; path: string };

/** `setting_check::Reading`. */
export interface Reading {
  kind: CheckKind;
  windows: boolean;
  level: CheckLevel;
  findings: Finding[];
  resolved: string | null;
  /** What a save stores; null while the value is refused. */
  saveAs: string | null;
  /** The one-press correction. */
  fix: string | null;
  /** The value as written can't work where Plyloft uses it. */
  broken: boolean;
}

/** What else a reading needs: the project a command runs in, and whether a
 *  folder keeps its `~` as typed (Plyloft writes it out where it is used). */
export interface CheckContext {
  project?: string | null;
  keepsTilde?: boolean;
  /** Typed into the person's own interactive shell (Try it). */
  interactive?: boolean;
}

/** The reading of a value (on save, and when the page opens). */
export function settingCheck(kind: CheckKind, value: string, context?: CheckContext): Promise<Reading> {
  return invoke<Reading>("setting_check", { kind, value, context: context ?? null });
}

/** `/Volumes/Tools` → "the disk Tools"; `E:\` → "drive E:"; a share as is. */
export function diskWords(disk: string): string {
  const mac = /^\/Volumes\/(.+)$/.exec(disk);
  if (mac) return `the disk ${mac[1]}`;
  const drive = /^([A-Za-z]):\\?$/.exec(disk);
  if (drive) return `drive ${drive[1].toUpperCase()}:`;
  return disk;
}

function example(kind: CheckKind, windows: boolean): string {
  if (kind === "folder") return windows ? "C:\\Users\\you\\Team" : "~/Team";
  return windows ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe" : "/bin/zsh";
}

/** One plain sentence per finding. */
export function findingSentence(f: Finding, kind: CheckKind, windows: boolean): string {
  const command = kind === "command" || kind === "script";
  switch (f.kind) {
    case "tilde":
      return "It is written with ~, which a new tile reads as written, not as your home folder.";
    case "untidy":
      return "It has spaces or quotes around it.";
    case "otherHome":
      return "It starts with ~ in a form Plyloft doesn't read. Write the whole path instead.";
    case "variable":
      return `It uses a variable (${f.name}), which a new tile reads as written.`;
    case "relative":
      return kind === "folder"
        ? `It isn't written in full. Write the whole folder, such as ${example(kind, windows)}.`
        : `It isn't written in full. Write the whole path, such as ${example(kind, windows)}.`;
    case "programNotFound":
      return `Plyloft can't find ${f.name} in the program folders new tiles get.`;
    case "notRunnable":
      return command
        ? `${f.path} isn't marked as a program, so running it as ${f.path} stops.`
        : `${f.path} is a file that can't be run as a program.`;
    case "isFolder":
      return `${f.path} is a folder, not a program.`;
    case "missing":
      return `${f.path} isn't there.`;
    case "diskAbsent":
      return `It is on ${diskWords(f.disk)}, which isn't connected.`;
    case "linkAway":
      return `${f.link} is a link to ${f.target}, which isn't there.`;
    case "notFoundHere":
      return `Plyloft didn't find ${f.word} in the folders it knows. If your shell adds it, this is fine.`;
    case "hasArguments":
      return `It has options after the program. Write only the program's name or path, without options: ${f.program}.`;
    case "notAShell":
      return `Plyloft doesn't know ${f.name} as a shell. New shell tiles will run it in place of one.`;
    case "macShellPath":
      return "This is a path from a Mac. Shell tiles on this PC run your default shell instead.";
    case "commandNotFound":
      return `Plyloft can't find ${f.word} in the program folders new tiles get.`;
    case "projectFileMissing":
      return `${f.path} isn't in the project.`;
    case "noScript":
      return `The project's package.json has no "${f.script}" script for ${f.tool}.`;
    case "noPackageJson":
      return "The project has no package.json.";
    case "noMakefile":
      return "The project has no Makefile for make to read.";
    case "noMakeTarget":
      return `The project's Makefile has no rule called ${f.target}.`;
    case "notAFolder":
      return `${f.path} is a file, not a folder.`;
    case "notWritable":
      return `Plyloft can't create anything in ${f.path}.`;
    case "willBeCreated":
      return `${f.path} isn't there yet. Plyloft creates it with the first project it puts there.`;
    default: {
      const never: never = f;
      return String(never);
    }
  }
}

/** What a save of a typed value does. Commands are never asked about or
 *  refused: the line under the field says what fails here. */
export type CheckDecision =
  | { kind: "save"; value: string }
  | { kind: "confirm"; value: string }
  | { kind: "blocked" };

export function checkDecision(r: Reading): CheckDecision {
  if (r.saveAs === null || r.level === "blocked") return { kind: "blocked" };
  if (r.level === "confirm") return { kind: "confirm", value: r.saveAs };
  return { kind: "save", value: r.saveAs };
}

/** The consequence a confirmation names, per kind. */
function consequence(r: Reading): string | null {
  const f = r.findings[0];
  if (!f) return null;
  if (f.kind === "relative") {
    return r.kind === "folder"
      ? "Plyloft reads it from the folder it runs in, not from your home folder."
      : "Each new shell tile looks for it in its own project folder.";
  }
  if (f.kind === "otherHome" && r.kind === "folder") {
    return "Plyloft reads it as a folder name, not as another account's home.";
  }
  if (f.kind === "diskAbsent" || f.kind === "linkAway") {
    return r.kind === "folder"
      ? "Team projects can't be cloned there until it is connected again."
      : "New shell tiles won't start until it is connected again.";
  }
  return null;
}

const NOUN: Record<CheckKind, string> = {
  tileShell: "tile shell",
  command: "command",
  script: "script",
  folder: "folder",
};

/** A press a notice offers. */
export type CheckAction =
  | { id: "fix" | "anyway"; label: string; value: string }
  | { id: "keep" | "default"; label: string };

export interface CheckNoticeModel {
  title: string;
  lines: string[];
  actions: CheckAction[];
}

/** The correction's button: it names what it saves (`Use zsh`, `Use
 *  /Users/ada/bin/fish`). */
export function fixLabel(r: Reading): string | null {
  return r.fix === null ? null : `Use ${r.fix}`;
}

/** The empty value's button: what Plyloft uses when the field is empty. */
export function defaultLabel(kind: CheckKind, windows: boolean): string | null {
  if (kind === "tileShell") return windows ? "Use your default shell" : "Use your login shell";
  if (kind === "folder") return "Use the default";
  return null;
}

/**
 * What the field says about a value under it, as a notice: a typed one
 * (`typed`) that isn't saved as typed or waits for a confirmation, or the
 * saved one when it can't work as written. `null`: nothing beyond
 * {@link checkLine}.
 */
export function checkNotice(r: Reading, typed: boolean): CheckNoticeModel | null {
  const decision = checkDecision(r);
  if (typed && decision.kind === "save") return null;
  if (!typed && !r.broken) return null;
  const noun = NOUN[r.kind];
  // A typed `~` or a stray quote is written out on save: no problem there.
  const lines = r.findings
    .filter((f) => !typed || (f.kind !== "tilde" && f.kind !== "untidy"))
    .map((f) => findingSentence(f, r.kind, r.windows));
  const label = fixLabel(r);
  const fix: CheckAction[] = label && r.fix !== null ? [{ id: "fix", label, value: r.fix }] : [];
  if (typed && decision.kind === "confirm") {
    const then = consequence(r);
    return {
      title: `Save this ${noun}?`,
      lines: then ? [...lines, then] : lines,
      actions: [...fix, { id: "anyway", label: "Save it anyway", value: decision.value }, { id: "keep", label: "Keep what was there" }],
    };
  }
  if (typed) {
    return { title: "Plyloft didn't save this.", lines, actions: [...fix, { id: "keep", label: "Keep what was there" }] };
  }
  const reset = defaultLabel(r.kind, r.windows);
  return {
    title: `This ${noun} can't work as written.`,
    lines,
    actions: [...fix, ...(reset ? [{ id: "default" as const, label: reset }] : [])],
  };
}

/** What the field says once after a save that stored something other than
 *  what was typed (a `~` written out, quotes dropped): nothing is rewritten
 *  without saying so. Surrounding spaces don't count. */
export function savedAsLine(typed: string, stored: string): string | null {
  return stored !== typed.trim() && stored !== "" ? `Saved as ${stored}.` : null;
}

/** The plain line under the field for a saved value: what it runs, or what
 *  fails here. `null` when there is nothing to add. */
export function checkLine(r: Reading): string | null {
  if (r.broken) return null;
  const said = r.findings.filter((f) => f.kind !== "tilde" && f.kind !== "untidy");
  if (said.length > 0) return said.map((f) => findingSentence(f, r.kind, r.windows)).join(" ");
  if (r.kind === "tileShell" && r.resolved) return `New shell tiles run ${r.resolved}.`;
  return null;
}

/** Whether a saved reading is worth a row in Diagnostics: it can't work, or
 *  it fails here. */
export function needsAttention(r: Reading): boolean {
  // An unusual value somebody confirmed (a shell Plyloft doesn't know) is
  // theirs; a disk that is away is not.
  return (
    r.broken ||
    r.level === "warn" ||
    r.level === "blocked" ||
    r.findings.some((f) => f.kind === "diskAbsent" || f.kind === "linkAway")
  );
}

/** The short reason Diagnostics gives: the first finding, as a sentence. */
export function checkReason(r: Reading): string {
  const f = r.findings.find((x) => x.kind !== "untidy") ?? r.findings[0];
  return f ? findingSentence(f, r.kind, r.windows) : "";
}
