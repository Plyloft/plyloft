import { invoke } from "@tauri-apps/api/core";
import type { CliHealth, CliTool, InstallChannel, StartFailure } from "./cliHealthIpc";
import type { SetupTool } from "../ipc";
import type { ProgramFoldersProblem } from "./programFolders";

// 1.176.0 R4: the guided Repair's engine (`cli_repair.rs`,
// `cli_repair_run.rs`). Mirrors the Rust types field by field (camelCase).
// The window sends only a step id and its own open tiles; every path a step
// acts on comes from a fresh look on the Rust side. No words here: the
// sheet (R6) words each `kind`.

export type RepairStepKind =
  | "closeSessions"
  | "fixOwnership"
  | "fixSharedOwnership"
  | "fixPermissions"
  | "removeBrokenPayload"
  | "removeDanglingLauncher"
  | "runInstaller"
  | "removeNpmCopy"
  /** 1.176.1: a folder put in front of the Program folders setting. */
  | "addProgramFolder"
  /** 1.176.1 (review 1): the Program folders setting emptied. */
  | "emptyProgramFolders"
  | "reread"
  | "verify";

/** Who takes a step: the person (closing sessions), the visible Setup
 *  terminal, or Plyloft itself. */
export type RepairStepBy = "you" | "terminal" | "plyloft";

/** `password`: the person types it in the terminal (sudo); Plyloft never
 *  sees it. */
export type RepairNeed = "closeSessions" | "password";

export type RepairSessionSource =
  | "tile"
  | "agentRun"
  | "swarm"
  | "chat"
  | "review"
  | "codexAppServer"
  | "codexUpdate"
  | "other";

export interface RepairSession {
  source: RepairSessionSource;
  id: string;
  label: string | null;
  ptyId: string | null;
}

/** What a step does (tagged by `kind`). */
export type RepairStepAction =
  | { kind: "closeSessions"; sessions: RepairSession[] }
  /** `sudo chown -R -P --`: folders only the tool's. */
  | { kind: "fixOwnership"; user: string }
  /** `sudo chown -h --`, not recursive: the shared install folder (and
   *  `.claude.json`) and the tool's own launcher entries by name. */
  | { kind: "fixSharedOwnership"; user: string }
  | { kind: "fixPermissions" }
  | { kind: "removeBrokenPayload" }
  | { kind: "removeDanglingLauncher" }
  | { kind: "runInstaller"; channel: InstallChannel }
  | { kind: "removeNpmCopy"; prefix: string; package: string }
  /** 1.176.1: `folder` put in front of the Program folders setting, through
   *  the setting's own save. */
  | { kind: "addProgramFolder"; folder: string; front: boolean; was: string }
  /** 1.176.1 (review 1): the setting emptied; `was` is what the plan saw. */
  | { kind: "emptyProgramFolders"; was: string }
  | { kind: "reread" }
  | { kind: "verify" };

export type RepairStep = RepairStepAction & {
  /** Stable while what it acts on stays the same. */
  id: string;
  by: RepairStepBy;
  needs: RepairNeed | null;
  optional: boolean;
  writes: boolean;
  /** The command as Details shows it (terminal steps). */
  command: string | null;
  /** The exact paths it acts on. */
  paths: string[];
  /** This sudo step asks for the password again (a terminal of its own
   *  after another sudo step): say "you'll be asked twice" up front. */
  passwordAgain: boolean;
};

/** What is wrong, most important first (tagged by `kind`). */
export type RepairSituation =
  | { kind: "healthy" }
  | { kind: "healthyEnough"; runs: string | null }
  | { kind: "missing" }
  | { kind: "danglingLauncher"; path: string; target: string | null }
  | { kind: "brokenBinary"; path: string; failure: StartFailure }
  | { kind: "notExecutable"; path: string }
  | { kind: "startInconclusive"; path: string }
  | { kind: "foldersNotOwned"; paths: string[] }
  | { kind: "foldersNotWritable"; paths: string[] }
  | { kind: "systemFolders"; paths: string[] }
  | { kind: "cachedPathStale"; cached: string | null; now: string | null }
  | { kind: "wrongCopyFirst"; first: string | null; working: string }
  | { kind: "cannotUpdate"; path: string; channel: InstallChannel }
  | { kind: "severalCopies"; paths: string[] }
  | { kind: "unreadable"; paths: string[] }
  | { kind: "fileInUseLastTime"; path: string | null }
  /** 1.176.0 seams: the PATH set in Settings puts `first` (which doesn't
   *  start) before `working`; tiles run `first`. */
  | { kind: "pathOverrideFirst"; first: string; working: string }
  /** 1.176.1: the tool works (`copy`), but its `folder` isn't among the
   *  Program folders set in Settings and nothing there starts. `problems`:
   *  what is wrong with the setting as written; empty when it only lacks
   *  that folder. */
  | { kind: "outsideProgramFolders"; copy: string; folder: string; problems: ProgramFoldersProblem[] }
  /** 1.176.1 (review 1): the setting can't work as written and no working
   *  copy was found elsewhere either. */
  | { kind: "programFoldersMalformed"; problems: ProgramFoldersProblem[] }
  /** 1.176.1 (Windows walk): the copy on the list doesn't start there, but
   *  does with the shell's folders: the list leaves out what it needs. */
  | { kind: "programFoldersLeaveOutWhatItNeeds"; path: string; needs: string | null };

export type RepairNpmStay = "needsAdmin" | "noNpm" | "unknownPrefix";

/** What stays as it is (tagged by `kind`). */
export type RepairNote =
  | { kind: "npmCopyStays"; path: string; reason: RepairNpmStay }
  | { kind: "npmCopyCanBeRemoved"; path: string; prefix: string }
  | { kind: "otherCopyStays"; path: string; channel: InstallChannel }
  | { kind: "otherCopyFirst"; path: string; channel: InstallChannel }
  | { kind: "terminalMayPickOld" }
  /** Plyloft runs `plyloft`; a Terminal starts `terminal` first, which
   *  doesn't start (`manual` has the PATH line). */
  | { kind: "terminalRunsOther"; terminal: string; plyloft: string; failure: StartFailure | null }
  /** `runs` works but can't be updated; updates go to `native`. */
  | { kind: "updatesGoToNative"; runs: string; native: string }
  | { kind: "folderByHand"; path: string }
  | { kind: "payloadNotExecutable"; path: string }
  /** R0 C8: the npm copy Plyloft runs may, updating itself, change the
   *  config or remove the native launcher: removing it is the advice. */
  | { kind: "npmUpdaterMayTouchNative"; npm: string; native: string }
  | { kind: "byHandOnWindows"; paths: string[] }
  | { kind: "parentNotYours"; path: string }
  | { kind: "parentNotWritable"; path: string }
  | { kind: "copyNotYours"; path: string }
  | { kind: "brokenCopyLeft"; path: string }
  | { kind: "installDirNotOnPath"; dir: string }
  | { kind: "unreadable"; paths: string[] }
  /** 1.176.1 walk: the tool is fine, but Program folders still leaves out
   *  git or gh, or can't work as written: said at the end. */
  | { kind: "programFoldersStillShort"; missing: string[]; problems: ProgramFoldersProblem[] };

export type RepairGiveUp =
  | "stillThereAfter"
  | "onlyByHand"
  | "needsChoice"
  /** Only the PATH order is left (`manual`). */
  | "pathOrder"
  /** 1.176.0 seams: the PATH set in Settings runs the copy that doesn't
   *  start; only the person changes it. */
  | "pathOverride"
  /** 1.176.1: the Program folders setting is written so it can't work (a
   *  file, `~`, a variable): the person corrects it in Settings. */
  | "programFolders"
  /** sudo: not an administrator of this Mac. */
  | "needsAdmin"
  /** sudo didn't accept the password. */
  | "passwordRefused";

/** The last install or update of the tool (`setup_last_run`). */
export interface RepairEvidence {
  actionId: string;
  outcome: string | null;
  cause: string | null;
  causePath: string | null;
  exitCode: number | null;
  finishedAt: string | null;
  versionBefore: string | null;
  versionAfter: string | null;
}

export type RepairBlock =
  | { kind: "nothingToRepair"; healthyEnough: boolean }
  | { kind: "offline"; proxy: boolean; details: string | null }
  | { kind: "diskFull"; freeBytes: number; neededBytes: number }
  /** A copy didn't answer in time and none failed for certain: try again. */
  | { kind: "notSureYet"; paths: string[] }
  | {
      kind: "couldNotRepair";
      reason: RepairGiveUp;
      step: RepairStepKind | null;
      evidence: RepairEvidence | null;
    };

export type RepairManualPurpose =
  | "ownership"
  | "permissions"
  | "removePayload"
  | "removeLauncher"
  | "install"
  | "removeNpmCopy"
  | "pathOrder";

export interface RepairManualCommand {
  purpose: RepairManualPurpose;
  command: string;
}

export interface RepairPlan {
  tool: CliTool;
  situations: RepairSituation[];
  notes: RepairNote[];
  /** In order; with a block, what Plyloft would do (nothing runs). */
  steps: RepairStep[];
  block: RepairBlock | null;
  /** The id `cliRepairRun` accepts now; null with a block, or while the
   *  person must close sessions first. */
  nextStep: string | null;
  manual: RepairManualCommand[];
  /** A quick read (`request.quick`): no reach check, the short version
   *  bound only, `nextStep` always null. Never a plan to run. */
  quick: boolean;
  /** 1.176.0 seams: the copy Plyloft runs can't be updated by its own
   *  updater (the test Setup's Update refuses by). Absent from an older
   *  backend: read as false. */
  updateBlocked?: boolean;
}

/** One tile the window has open that runs the tool. */
export interface RepairTile {
  ptyId: string;
  label?: string | null;
}

export interface RepairRequest {
  tiles?: RepairTile[];
  /** The person ticked "remove the npm copy". */
  removeNpmCopy?: boolean;
  /** A new repair: the steps already tried are forgotten. */
  startOver?: boolean;
  /** "Reinstall anyway": the official installer even on a healthy machine,
   *  once per repair; removes nothing. */
  reinstall?: boolean;
  /** A cheap read for Diagnostics' rows; `cliRepairRun` refuses it
   *  (`quickPlan`). */
  quick?: boolean;
}

export type RepairRefusal =
  | "notInPlan"
  | "notNextStep"
  | "sessionsInUse"
  | "blocked"
  | "pathRefused"
  | "runnerRefused"
  | "quickPlan"
  | "unsupported";

export type RepairPathRefusal =
  | "notPlain"
  | "protected"
  | "outsideRoots"
  | "throughLink"
  | "notAFile"
  | "notALink"
  | "notDangling"
  | "missing"
  | "notListed"
  | "systemFolder"
  | "homeNotYours"
  | "notOnlyTheTool"
  /** A version file a second look didn't confirm broken: kept. */
  | "notConfirmed"
  /** A file with several links, not the user's, inside a `chown -R` tree. */
  | "hardLinked";

/** `setup_actions::Watch` of a Repair's terminal step. */
export type RepairWatch = { kind: "tool-works"; tool: SetupTool } | { kind: "exit-code" };

/** The Setup runner's start of a terminal step; its end comes as
 *  `setup://progress` (`setupRun.ts`). */
export interface RepairStarted {
  runId: string;
  actionId:
    | "repair-install.claude"
    | "repair-install.codex"
    | "repair-chown.claude"
    | "repair-chown.codex"
    | "repair-npm-remove.claude"
    | "repair-npm-remove.codex";
  ptyId: string;
  display: string;
  watch: RepairWatch;
}

export type RepairRunResult =
  | { kind: "started"; stepId: string; step: RepairStepKind; started: RepairStarted }
  | {
      kind: "done";
      stepId: string;
      step: RepairStepKind;
      paths: string[];
      failed: string[];
      reprobed: boolean;
      /** `verify`: the fresh look. */
      health: CliHealth | null;
    }
  | {
      kind: "refused";
      reason: RepairRefusal;
      pathRefusal: RepairPathRefusal | null;
      details: string | null;
      plan: RepairPlan;
    };

/** A fresh look, the context and the plan (seconds when the installer's
 *  host is checked). */
export async function cliRepairPlan(tool: CliTool, request: RepairRequest = {}): Promise<RepairPlan> {
  const plan = await invoke<RepairPlan | null>("cli_repair_plan", { tool, request });
  // A null or malformed answer is "can't tell": a rejection the callers handle.
  if (!isPlan(plan)) throw new Error("cli_repair_plan answered nothing usable");
  return plan;
}

/** Whether `x` has the parts of a plan the sheet reads. */
export function isPlan(x: unknown): x is RepairPlan {
  const p = x as Partial<RepairPlan> | null | undefined;
  return (
    !!p &&
    typeof p === "object" &&
    typeof p.tool === "string" &&
    Array.isArray(p.situations) &&
    Array.isArray(p.notes) &&
    Array.isArray(p.steps) &&
    Array.isArray(p.manual)
  );
}

/** Run `stepId` of a fresh plan (refused unless it is the next one). */
export function cliRepairRun(
  tool: CliTool,
  stepId: string,
  request: RepairRequest = {},
  size?: { cols: number; rows: number },
) {
  return invoke<RepairRunResult | null>("cli_repair_run", {
    tool,
    stepId,
    request,
    cols: size?.cols ?? null,
    rows: size?.rows ?? null,
  }).then((r) => {
    if (!r || typeof r !== "object" || typeof r.kind !== "string") throw new Error("cli_repair_run answered nothing usable");
    if (r.kind === "refused" && !isPlan(r.plan)) throw new Error("cli_repair_run refused without a plan");
    return r;
  });
}

/** The sessions only the backend knows of (runs, swarms, chats, Codex's
 *  App Server, the hidden Codex update). */
export function cliRepairInUse(tool: CliTool) {
  return invoke<RepairSession[] | null>("cli_repair_in_use", { tool }).then((r) => (Array.isArray(r) ? r : []));
}

/** The plain-text report for support, home as `~`, the user name removed. */
export function cliRepairReport(tool: CliTool, includeTail = false) {
  return invoke<string | null>("cli_repair_report", { tool, includeTail }).then((r) => (typeof r === "string" ? r : ""));
}
