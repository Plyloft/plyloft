// 1.176.0 R6: the guided Repair, in words. Pure: the engine's plan
// (`cliRepairIpc.ts`, tagged values, no sentences) in, the sheet's sentences
// and decisions out. Every switch on an engine union ends in `unhandled`, so
// a value added to the engine does not compile until it is worded here.
//
//     node --experimental-strip-types src/lib/repairView.test.ts

import type {
  RepairBlock,
  RepairGiveUp,
  RepairManualCommand,
  RepairManualPurpose,
  RepairNote,
  RepairPathRefusal,
  RepairRefusal,
  RepairPlan,
  RepairSession,
  RepairSituation,
  RepairStep,
  RepairStepKind,
} from "./cliRepairIpc.ts";
import type { CliHealth, CliTool, InstallChannel, StartFailure } from "./cliHealthIpc.ts";
import { machineWords, platform, type Platform } from "./platform.ts";
import { problemReason, whatShellReports } from "./programFolders.ts";

/** A sentence in this platform's words: "this PC" for "this Mac", and a
 *  terminal that isn't macOS's Terminal app. */
export function words(text: string, p: Platform = platform()): string {
  const t = machineWords(text, p);
  const home = tildePath(t);
  return p === "windows" ? home.replace(/\bTerminal windows?\b/g, (m) => m.toLowerCase()).replace(/\bTerminal\b/g, "terminal") : home;
}

/** A compile error when a value is added to an engine union and not worded. */
export function unhandled(value: never): string {
  return String(value);
}

export const TOOL_NAME: Record<CliTool, string> = { claude: "Claude Code", codex: "Codex" };

// ── Words for what the engine found ───────────────────────────────────

const CHANNEL: Record<InstallChannel, string> = {
  native: "official install",
  standalone: "official install",
  npm: "copy installed with npm",
  bun: "bun copy",
  pnpm: "pnpm copy",
  homebrew: "Homebrew copy",
  legacyLocal: "old local install",
  winget: "WinGet copy",
  unknown: "copy",
};

export function channelWords(channel: InstallChannel): string {
  return CHANNEL[channel];
}

function failureWords(name: string, path: string, failure: StartFailure): string {
  switch (failure) {
    case "notFound":
      return `${name} can't be found at ${path} any more.`;
    case "permissionDenied":
      return `The computer doesn't let ${name} run from ${path}.`;
    case "timedOut":
      return `${name} at ${path} didn't answer in time.`;
    case "badBinary":
      return `The ${name} program at ${path} is damaged: it stops as soon as it starts.`;
    case "spawnFailed":
      return `The ${name} program at ${path} won't start.`;
    case "exited":
      return `${name} at ${path} starts and stops at once.`;
    case "unreadable":
      return `Plyloft couldn't read the ${name} program at ${path}.`;
    case "signal":
      return `The system stopped ${name} at ${path} as soon as it started.`;
    default:
      return unhandled(failure);
  }
}

/** One thing that is wrong: a sentence, and the exact paths behind Details. */
export interface Line {
  text: string;
  paths: string[];
}

export function situationLine(s: RepairSituation, tool: CliTool): Line {
  const name = TOOL_NAME[tool];
  const one = (text: string, paths: string[] = []): Line => ({ text, paths });
  switch (s.kind) {
    case "healthy":
      return one(`${name} is fine.`);
    case "healthyEnough":
      return one(`${name} works.`, s.runs ? [s.runs] : []);
    case "missing":
      return one(`${name} isn't installed on this Mac.`);
    case "danglingLauncher":
      return one(
        `A shortcut to ${name} points at a file that isn't there any more, so ${name} can't start from it.`,
        [s.path, ...(s.target ? [s.target] : [])],
      );
    case "brokenBinary":
      return one(failureWords(name, s.path, s.failure), [s.path]);
    case "notExecutable":
      return one(`The ${name} file isn't allowed to run, so ${name} can't start.`, [s.path]);
    case "startInconclusive":
      return one(`${name} was slow to answer, so Plyloft can't tell yet whether it starts.`, [s.path]);
    case "foldersNotOwned":
      return one(
        `Some of ${name}'s folders belong to another account (an earlier install as an administrator can do that), so ${name} can't update itself there.`,
        s.paths,
      );
    case "foldersNotWritable":
      return one(`Some of ${name}'s folders are read-only for your account, so ${name} can't update itself there.`, s.paths);
    case "systemFolders":
      return one(`${name} lives in a folder that belongs to the system. Only an administrator can change it.`, s.paths);
    case "cachedPathStale":
      return one(`Plyloft remembers an old place for ${name}, so new tiles may not start it.`, [
        ...(s.cached ? [s.cached] : []),
        ...(s.now ? [s.now] : []),
      ]);
    case "wrongCopyFirst":
      return one(
        `A copy of ${name} that doesn't work comes first, so a tile or a Terminal window may start the wrong one.`,
        [...(s.first ? [s.first] : []), s.working],
      );
    case "cannotUpdate":
      return one(`The ${CHANNEL[s.channel]} works, but it can't update itself.`, [s.path]);
    case "severalCopies":
      return one(`There are several copies of ${name} on this Mac. They can get in each other's way.`, s.paths);
    case "unreadable":
      return one(`Plyloft couldn't read some folders where ${name} may be, so it can't see everything.`, s.paths);
    case "fileInUseLastTime":
      return one(`The last update stopped because a file ${name} had to replace was in use.`, s.path ? [s.path] : []);
    case "pathOverrideFirst":
      return one(
        `Your Program folders in Settings put a copy of ${name} that doesn't work first, so tiles start that one. A copy that works comes later.`,
        [s.first, s.working],
      );
    case "outsideProgramFolders":
      return one(
        s.problems.length > 0
          ? `${name} works, but your Program folders in Settings can't find it: ${problemReason(s.problems, platform() === "windows")}.`
          : `${name} works, but it is in ${s.folder}, which isn't among your Program folders in Settings, so tiles can't start it.`,
        [s.copy],
      );
    case "programFoldersLeaveOutWhatItNeeds":
      return one(
        s.needs
          ? `${name} is in your Program folders, but it needs ${s.needs}, which your Program folders don't find, so tiles can't start it.`
          : `${name} is in your Program folders, but something it needs isn't, so tiles can't start it. With the folders your shell reports, it starts.`,
        [s.path],
      );
    case "programFoldersMalformed":
      return one(
        `Your Program folders in Settings can't work as written: ${problemReason(s.problems, platform() === "windows")}. Plyloft looks for ${name} only there.`,
      );
    default:
      return one(unhandled(s));
  }
}

/** What stays as it is. The two notes about Terminal windows are the end's
 *  (`terminalNote`); they are `null` here. */
export function noteLine(n: RepairNote, tool: CliTool, ctx: { canRemoveNpm?: boolean } = {}): Line | null {
  const name = TOOL_NAME[tool];
  const one = (text: string, paths: string[] = []): Line => ({ text, paths });
  switch (n.kind) {
    case "npmCopyStays":
      switch (n.reason) {
        case "needsAdmin":
          return one(`The copy installed with npm stays: removing it needs an administrator.`, [n.path]);
        case "noNpm":
          return one(`The copy installed with npm stays: Plyloft can't find npm to remove it.`, [n.path]);
        case "unknownPrefix":
          return one(`The copy installed with npm stays: Plyloft can't tell which folder npm put it in.`, [n.path]);
        default:
          return one(unhandled(n.reason));
      }
    case "npmCopyCanBeRemoved":
      return null;
    case "otherCopyStays":
      return one(`The ${CHANNEL[n.channel]} stays as it is.`, [n.path]);
    case "otherCopyFirst":
      // The engine emits this for the copy Plyloft itself runs: it keeps
      // starting it, and so does a terminal, until the new copy is first.
      return one(
        `Plyloft and Terminal windows keep starting the ${CHANNEL[n.channel]} until the new copy is put first.` +
          (n.channel === "npm" && ctx.canRemoveNpm ? " Tick the box below to remove it and use the new one." : ""),
        [n.path],
      );
    case "terminalMayPickOld":
      return one(`A Terminal window that is already open may keep starting an older copy until you open a new one.`);
    case "terminalRunsOther":
    case "updatesGoToNative":
      return null;
    case "folderByHand":
      return one(`This folder needs changing by hand. The commands are listed if the repair ends without it.`, [n.path]);
    case "payloadNotExecutable":
      return one(`A ${name} file isn't allowed to run. Plyloft leaves it.`, [n.path]);
    case "npmUpdaterMayTouchNative":
      return one(
        `The copy installed with npm may change ${name}'s settings or remove the official install when it updates itself. Removing the copy installed with npm is the safer way.`,
        [n.npm, n.native],
      );
    case "byHandOnWindows":
      return one(`Plyloft can't change who owns these folders on Windows. They need changing by hand.`, n.paths);
    case "parentNotYours":
      return one(`The folder that holds this one isn't yours, so Plyloft leaves it.`, [n.path]);
    case "parentNotWritable":
      return one(`The folder that holds this one is read-only for your account, so Plyloft leaves it.`, [n.path]);
    case "copyNotYours":
      return one(`This copy isn't yours, so Plyloft leaves it.`, [n.path]);
    case "brokenCopyLeft":
      return one(`A copy that doesn't work stays; it isn't in the way.`, [n.path]);
    case "installDirNotOnPath":
      return one(
        `A Terminal window won't find ${name} until this folder is among the folders a Terminal looks in.`,
        [n.dir],
      );
    case "unreadable":
      return one(`Plyloft couldn't read some folders, so it leaves them alone.`, n.paths);
    case "programFoldersStillShort":
      return null; // the end's own line (`stillShortLine`)
    default:
      return one(unhandled(n));
  }
}

/** The end's note about Terminal windows, when the plan carries one. */
export interface TerminalNote {
  text: string;
  /** The one line to add (the plan's `pathOrder` command), when there is one. */
  line: string | null;
}

export function terminalNote(plan: RepairPlan): TerminalNote | null {
  const line = plan.manual.find((m) => m.purpose === "pathOrder")?.command ?? null;
  const name = TOOL_NAME[plan.tool];
  for (const n of plan.notes) {
    if (n.kind === "terminalRunsOther") {
      return {
        text:
          `${name} runs from ${n.plyloft} in Plyloft. A Terminal window starts the copy at ${n.terminal} first` +
          (n.failure ? `, and that one doesn't work.` : `.`) +
          (line ? ` To make Terminal windows use the right one too, add this line to your shell's startup file:` : ""),
        line,
      };
    }
    if (n.kind === "updatesGoToNative") {
      return {
        text:
          `${name} runs from ${n.runs}, which can't update itself. Updates now go to the copy at ${n.native}, so a Terminal window may keep starting the older one.` +
          (line ? ` To make Terminal windows use the new one, add this line to your shell's startup file:` : ""),
        line,
      };
    }
  }
  return null;
}

// ── Sessions in use (D2) ──────────────────────────────────────────────

export type SessionClosable = "tile" | "cannot";

/** A session that is one window tile (a terminal tile, or a Codex chat). */
export function closesWithTile(s: RepairSession): boolean {
  return (s.source === "tile" && !!s.ptyId) || s.source === "codexAppServer";
}

/** The sessions note, by count: one tile and nothing else is singular. */
export function sessionsNote(onlyOneTile: boolean): string {
  return onlyOneTile ? SESSIONS_NOTE_ONE : SESSIONS_NOTE;
}

/** A path as the report writes it: the home folder as `~`. Commands are
 *  never passed through this. */
export function tildePath(text: string): string {
  return text
    .replace(/(?:\/Users|\/home)\/[^/\s)]+/g, "~")
    .replace(/[A-Za-z]:\\Users\\[^\\\s)]+/g, "~");
}

/** Only a window tile can be closed by Plyloft; the rest is named. */
export function sessionClosable(s: RepairSession): SessionClosable {
  return s.source === "tile" && s.ptyId ? "tile" : "cannot";
}

export function sessionWhat(s: RepairSession): string {
  switch (s.source) {
    case "tile":
      return s.label ?? "A tile";
    case "agentRun":
      return `An agent run${s.label ? `: ${s.label}` : ""}`;
    case "swarm":
      return `A swarm${s.label ? `: ${s.label}` : ""}`;
    case "chat":
      return `A card chat${s.label ? `: ${s.label}` : ""}`;
    case "review":
      return `A review${s.label ? `: ${s.label}` : ""}`;
    case "codexAppServer":
      return `A Codex chat${s.label ? `: ${s.label}` : ""}`;
    case "codexUpdate":
      return "The Codex update Plyloft runs by itself";
    case "other":
      return s.label ?? "Another session";
    default:
      return unhandled(s.source);
  }
}

/** What to do about one Plyloft can't close. */
export function sessionWayOut(s: RepairSession): string | null {
  switch (s.source) {
    case "tile":
      return s.ptyId ? null : "Still starting. Wait a moment, then press Look again.";
    case "agentRun":
    case "swarm":
    case "review":
      return "Wait for it to finish, or stop it from its card, then press Look again.";
    case "chat":
    case "codexAppServer":
      return "Close that chat, then press Look again.";
    case "codexUpdate":
      return "It ends by itself in a few minutes. Press Look again then.";
    case "other":
      return "End it, then press Look again.";
    default:
      return unhandled(s.source);
  }
}

// ── Steps ─────────────────────────────────────────────────────────────

export type Who = "plyloft" | "terminal" | "you";

export interface StepView {
  id: string;
  kind: RepairStepKind;
  title: string;
  who: Who;
  /** "Plyloft", or "You, in this window". */
  whoWords: string;
  /** Its command runs in the visible terminal. */
  inTerminal: boolean;
  /** Exactly what it removes (paths, and the npm package), else empty. */
  removes: string[];
  command: string | null;
  paths: string[];
  /** The person types their password in the terminal. */
  password: boolean;
  /** This sudo step asks for the password a second time. */
  passwordAgain: boolean;
  /** A word about how long it takes, said while it runs. */
  slow: string | null;
}

function stepTitle(step: RepairStep, name: string): string {
  switch (step.kind) {
    case "closeSessions":
      return step.sessions.length === 1 && closesWithTile(step.sessions[0])
        ? `Close the open ${name} tile.`
        : `Close the open ${name} tiles and sessions.`;
    case "fixOwnership":
      return `Give ${name}'s folders back to your account.`;
    case "fixSharedOwnership":
      return `Give ${name}'s shared install folder back to your account.`;
    case "fixPermissions":
      return `Let your account write in ${name}'s folders.`;
    case "removeBrokenPayload":
      return `Remove the unfinished ${name} download.`;
    case "removeDanglingLauncher":
      return `Remove the ${name} shortcut that points nowhere.`;
    case "runInstaller":
      return `Install ${name} again with its official installer.`;
    case "removeNpmCopy":
      return `Remove the copy of ${name} installed with npm.`;
    case "addProgramFolder":
      // Review 1: the words say where it goes, and why when in front.
      return step.front
        ? `Add ${tildePath(step.folder)} in front of your Program folders, ahead of a copy of ${name} there that doesn't start.`
        : `Add ${tildePath(step.folder)} at the end of your Program folders.`;
    case "emptyProgramFolders":
      return `Empty Program folders, so Plyloft uses ${whatShellReports(platform() === "windows")}, where ${name} is.`;
    case "reread":
      return `Let Plyloft look again at where ${name} is.`;
    case "verify":
      return `Check that ${name} starts.`;
    default:
      return unhandled(step);
  }
}

const REMOVES: ReadonlySet<RepairStepKind> = new Set<RepairStepKind>([
  "removeBrokenPayload",
  "removeDanglingLauncher",
  "removeNpmCopy",
]);

export function stepView(step: RepairStep, tool: CliTool): StepView {
  const name = TOOL_NAME[tool];
  const password = step.needs === "password";
  const who: Who = password ? "you" : step.by === "terminal" ? "terminal" : step.by === "you" ? "you" : "plyloft";
  // Closing is Plyloft's, after the person confirms; only a session it can't
  // close is the person's.
  const closes = step.kind === "closeSessions" && step.sessions.some((s) => sessionClosable(s) === "tile" || s.source === "codexAppServer");
  const whoWords = step.kind === "closeSessions" ? (closes ? "Plyloft, after you confirm" : "You") : who === "you" ? "You, in this window" : "Plyloft";
  const removes =
    step.kind === "removeNpmCopy"
      ? [...step.paths, `the npm package ${step.package}`]
      : REMOVES.has(step.kind)
        ? step.paths
        : [];
  return {
    id: step.id,
    kind: step.kind,
    title: stepTitle(step, name),
    who,
    whoWords,
    inTerminal: step.by === "terminal",
    removes,
    command: step.command,
    paths: step.paths,
    password,
    passwordAgain: step.passwordAgain === true,
    slow: step.kind === "removeBrokenPayload" ? "Plyloft looks at the file again first. This can take half a minute." : null,
  };
}

export type Pause = "sessions" | "password" | "removes" | "changes";

/** Whether the run stops for a press before `step`. The sessions and a
 *  password always wait; any other step that writes waits unless its id was
 *  in the list the person saw when they pressed Repair (`agreed`): the id
 *  hashes its paths and its command, so a different step is another id. */
export function pauseBefore(step: RepairStep, agreed: boolean): Pause | null {
  if (step.needs === "closeSessions") return "sessions";
  if (step.needs === "password") return "password";
  if (step.writes && !agreed) return REMOVES.has(step.kind) ? "removes" : "changes";
  return null;
}

/** Said above the terminal, before a password step starts. `more`: another
 *  password step comes after this one. */
export function passwordNotice(step: StepView, tool: CliTool, more = false): string[] {
  const name = TOOL_NAME[tool];
  const what =
    step.kind === "fixSharedOwnership"
      ? `It makes your account the owner of ${name}'s shared install folder and of its own shortcuts. Nothing else changes.`
      : `It makes your account the owner of the ${name} folders listed under Details, and everything in them. Nothing else changes.`;
  return [
    step.passwordAgain
      ? "Your Mac asks for the password again, for this step. Type it in the box below and press Return."
      : "Your Mac will ask for the password you use to log in. Type it in the box below and press Return; nothing appears while you type.",
    // 1.176.1: the keys pass through Plyloft's terminal to macOS (sudo turns
    // the echo off); the chown step's output is cleared from the final event,
    // the log and the record (`setup_outcome::keeps_tail`). Nothing more is
    // promised.
    "What you type goes straight to macOS. Plyloft doesn't show it, log it or keep it.",
    what,
    ...(more && !step.passwordAgain ? ["It may ask a second time for the next step."] : []),
  ];
}

export function pauseWords(p: Pause, step: StepView): { title: string; text: string; button: string } {
  switch (p) {
    case "sessions":
      return {
        title: "Some sessions are still open.",
        text: "They have to close before anything is changed.",
        button: "Close them and go on",
      };
    case "password":
      return { title: step.title, text: "", button: "Show the password box" };
    case "removes":
      return {
        title: step.title,
        text: step.removes.length > 0 ? "It removes:" : "",
        button: "Remove and go on",
      };
    case "changes":
      return { title: step.title, text: "It was not on the list you agreed to. The details are below.", button: "Go on" };
    default:
      return { title: unhandled(p), text: "", button: "" };
  }
}

// ── The run's list ────────────────────────────────────────────────────

export type ItemState = "done" | "running" | "waiting" | "failed" | "stopped" | "unsure";

export interface JournalEntry {
  id: string;
  kind: RepairStepKind;
  title: string;
  state: "done" | "running" | "failed" | "stopped" | "unsure";
  /** Paths Plyloft's own step couldn't change. */
  failed: string[];
}

export interface RunItem {
  key: string;
  title: string;
  state: ItemState;
  /** Paths a step of Plyloft's own couldn't change. */
  failed: string[];
  /** Said while the step runs. */
  slow: string | null;
}

/** What was done, what runs, and what is still to come. */
export function runItems(journal: readonly JournalEntry[], plan: RepairPlan | null, tool: CliTool): RunItem[] {
  const slowOf = new Map((plan?.steps ?? []).map((s) => [s.id, stepView(s, tool).slow]));
  const items: RunItem[] = journal.map((e, i) => ({
    key: `${e.id}#${i}`,
    title: e.title,
    state: e.state,
    failed: e.failed,
    slow: e.state === "running" ? (slowOf.get(e.id) ?? null) : null,
  }));
  const seen = new Set(journal.map((e) => e.id));
  for (const s of plan?.steps ?? []) {
    if (seen.has(s.id)) continue;
    items.push({ key: `${s.id}#next`, title: stepView(s, tool).title, state: "waiting", failed: [], slow: null });
  }
  return items;
}

export function itemWord(state: ItemState): string {
  switch (state) {
    case "done":
      return "Done";
    case "running":
      return "Running";
    case "waiting":
      return "Later";
    case "failed":
      return "Reported an error";
    case "unsure":
      return "Not confirmed";
    case "stopped":
      return "Stopped";
    default:
      return unhandled(state);
  }
}

/** The line over the terminal while a step runs, or after it. */
export function stepRunLine(
  title: string,
  phase: "running" | "done",
  outcome: "succeeded" | "cancelled" | "other" | null,
): string {
  if (phase === "running") return title;
  if (outcome === "succeeded") return "That step is done.";
  if (outcome === "cancelled") return "Stopped.";
  return "That step didn't finish.";
}

// ── Blocks and the end ────────────────────────────────────────────────

export function formatBytes(n: number): string {
  const gb = n / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(n / 1024 ** 2))} MB`;
}

export interface BlockView {
  /** What the block says. */
  title: string;
  text: string;
  /** "Try again" re-plans; null: nothing to retry (nothing to repair). */
  retry: boolean;
  /** Plyloft ran nothing that could have fixed it more; the commands are by hand. */
  byHand: boolean;
  /** Not an end of trouble: the tool is fine. */
  fine: boolean;
}

export function giveUpWords(reason: RepairGiveUp, name: string): string {
  switch (reason) {
    case "stillThereAfter":
      return `Plyloft ran its steps, but the problem is still there.`;
    case "onlyByHand":
      return `Plyloft can't repair this by itself.`;
    case "needsChoice":
      return `What is left is the copy installed with npm. Plyloft removes it only if you ask.`;
    case "pathOrder":
      return `${name} itself is in order, but a Terminal window starts another copy first. One line in your shell's startup file fixes that.`;
    case "pathOverride":
      return `Tiles start the copy of ${name} that your Program folders in Settings › Look and feel › Editor and terminals put first, and that copy doesn't work. Change them so the folder of the copy that works comes first, or empty them. Plyloft doesn't change your setting.`;
    case "programFolders":
      return `Plyloft looks for ${name} only in your Program folders in Settings › Look and feel › Editor and terminals, and they need correcting first. Correct them there, or empty them so Plyloft uses ${whatShellReports(platform() === "windows")}. Nothing was installed, and Plyloft doesn't change your setting by itself.`;
    case "needsAdmin":
      return `Your account isn't an administrator of this Mac, so it can't change those folders. Ask whoever manages this computer to run the command, or install ${name} yourself.`;
    case "passwordRefused":
      return `The password wasn't accepted, so nothing in those folders was changed. Try again, or run the command yourself.`;
    default:
      return unhandled(reason);
  }
}

export function blockView(block: RepairBlock, tool: CliTool, version: string | null = null): BlockView {
  const name = TOOL_NAME[tool];
  switch (block.kind) {
    case "nothingToRepair":
      return {
        title: version ? `${name} ${version} is fine.` : `${name} is fine.`,
        text: block.healthyEnough
          ? `${name} works. There is nothing to repair.`
          : `Plyloft looked at ${name} and found nothing to repair.`,
        retry: false,
        byHand: false,
        fine: true,
      };
    case "offline":
      return {
        title: `Plyloft can't reach the download.`,
        text: block.proxy
          ? `You're offline, or this network blocks it. Your network may use a proxy: ask whoever manages it to allow the installer's address. Then press Try again.`
          : `You're offline, or this network blocks it. Connect and press Try again.`,
        retry: true,
        byHand: false,
        fine: false,
      };
    case "diskFull":
      return {
        title: `The disk is too full to repair ${name}.`,
        text: `It needs about ${formatBytes(block.neededBytes)} free and has ${formatBytes(block.freeBytes)}. Free some space on the disk, then press Try again.`,
        retry: true,
        byHand: false,
        fine: false,
      };
    case "notSureYet":
      return {
        title: `Plyloft can't tell yet.`,
        text: `${name} was slow to answer. Try again in a moment.`,
        retry: true,
        byHand: false,
        fine: false,
      };
    case "couldNotRepair":
      return {
        title: `Plyloft couldn't repair ${name}.`,
        text: giveUpWords(block.reason, name),
        retry: block.reason === "passwordRefused",
        byHand: true,
        fine: false,
      };
    default:
      return { title: unhandled(block), text: "", retry: false, byHand: false, fine: false };
  }
}

export function manualWords(m: RepairManualCommand, tool: CliTool): string {
  const name = TOOL_NAME[tool];
  const purpose: RepairManualPurpose = m.purpose;
  switch (purpose) {
    case "ownership":
      return `Give ${name}'s folders back to your account`;
    case "permissions":
      return `Let your account write in ${name}'s folders`;
    case "removePayload":
      return `Remove the unfinished download`;
    case "removeLauncher":
      return `Remove the shortcut that points nowhere`;
    case "install":
      return `Install ${name} with its official installer`;
    case "removeNpmCopy":
      return `Remove the copy installed with npm`;
    case "pathOrder":
      return `Put the official install folder first among the folders a Terminal looks in`;
    default:
      return unhandled(purpose);
  }
}

/** The version that runs now, from the check that ended a repair. */
export function runningVersion(health: CliHealth | null): string | null {
  if (!health) return null;
  const path = health.runsToday ?? health.shouldRun;
  const copy = health.copies.find((c) => c.path === path || c.alsoAt.includes(path ?? ""));
  return copy?.start?.version ?? null;
}

/** 1.176.1 walk: the end's line when the tool starts but Program folders
 *  still breaks other things — never a bare "repaired". Null otherwise. */
export function stillShortLine(plan: RepairPlan | null, tool: CliTool, version: string | null): string | null {
  const n = plan?.notes.find((x) => x.kind === "programFoldersStillShort");
  if (!n || n.kind !== "programFoldersStillShort") return null;
  const name = version ? `${TOOL_NAME[tool]} ${version}` : TOOL_NAME[tool];
  const why =
    n.missing.length > 0
      ? `Your Program folders still don't find ${n.missing.join(" or ")}.`
      : `Your Program folders still can't work as written: ${problemReason(n.problems, platform() === "windows")}.`;
  return `${name} starts now. ${why}`;
}

export function repairedLine(tool: CliTool, version: string | null): string {
  const name = TOOL_NAME[tool];
  return version ? `${name} is repaired. Version ${version} runs now.` : `${name} is repaired. It starts.`;
}

// ── Diagnostics' row ──────────────────────────────────────────────────

export type RepairState = "fine" | "needs" | "unsure";

export interface RepairRow {
  state: RepairState;
  text: string;
}

export function repairRow(plan: RepairPlan): RepairRow {
  const name = TOOL_NAME[plan.tool];
  const block = plan.block;
  if (block?.kind === "nothingToRepair") return { state: "fine", text: `${name} is fine.` };
  if (block?.kind === "notSureYet") return { state: "unsure", text: `Can't tell yet. Try again in a moment.` };
  const first = (plan.situations ?? []).find((s) => s.kind !== "healthy" && s.kind !== "healthyEnough");
  return { state: "needs", text: first ? situationLine(first, plan.tool).text : `${name} needs repair.` };
}

// ── What the person sees at the end ───────────────────────────────────

/** A repair that ran steps and whose last plan found nothing more to do. */
export function isRepaired(plan: RepairPlan, ran: number): boolean {
  return ran > 0 && plan.block?.kind === "nothingToRepair";
}

/** The most steps one repair may run: a guard against a plan that never ends. */
export const MAX_STEPS = 14;

// ── The words of a refusal and of a step that couldn't go on ──────────

export function pathRefusalWords(p: RepairPathRefusal | null): string {
  switch (p) {
    case null:
      return "A folder Plyloft was about to touch isn't one it may change.";
    case "notConfirmed":
      return "Plyloft looked at the file again and couldn't confirm that it is broken, so it kept it.";
    case "hardLinked":
      return "A file in that folder has several links, so Plyloft left the folder alone.";
    case "notPlain":
    case "protected":
    case "outsideRoots":
    case "throughLink":
    case "notAFile":
    case "notALink":
    case "notDangling":
    case "missing":
    case "notListed":
    case "systemFolder":
    case "homeNotYours":
    case "notOnlyTheTool":
      return "A folder Plyloft was about to touch isn't one it may change.";
    default:
      return unhandled(p);
  }
}

/** The sentence for a refusal Plyloft can't simply re-plan from. */
export function refusalWords(reason: RepairRefusal, path: RepairPathRefusal | null): string | null {
  switch (reason) {
    case "runnerRefused":
      return "Another setup step is still running. Wait for it to finish, or stop it in Setup, then try again.";
    case "pathRefused":
      return `Plyloft stopped before changing anything. ${pathRefusalWords(path)}`;
    case "unsupported":
      return "This step can't run on this computer.";
    case "quickPlan":
      return "Plyloft looked at this quickly and can't run it. Look again.";
    case "notInPlan":
    case "notNextStep":
    case "sessionsInUse":
    case "blocked":
      return null;
    default:
      return unhandled(reason);
  }
}

// ── Program folders (1.176.1) ─────────────────────────────────────────

/** The plan is about the Program folders setting: the sheet offers to open
 *  it, and says the by-hand way. */
/** The sheet offers "Open Program folders": a situation about the setting,
 *  or a working tool whose setting still falls short. */
export function programFoldersOffered(plan: RepairPlan): boolean {
  return programFoldersSituation(plan) !== null || plan.notes.some((n) => n.kind === "programFoldersStillShort");
}

export function programFoldersSituation(
  plan: RepairPlan,
): Extract<RepairSituation, { kind: "outsideProgramFolders" | "programFoldersMalformed" | "programFoldersLeaveOutWhatItNeeds" }> | null {
  const s = plan.situations.find(
    (x) => x.kind === "outsideProgramFolders" || x.kind === "programFoldersMalformed" || x.kind === "programFoldersLeaveOutWhatItNeeds",
  );
  return s && (s.kind === "outsideProgramFolders" || s.kind === "programFoldersMalformed" || s.kind === "programFoldersLeaveOutWhatItNeeds") ? s : null;
}

/** Review 1: Repair changed Program folders — said at the end, with how to
 *  change it back (an Undo is offered too, `repairStore`). */
export const PROGRAM_FOLDERS_CHANGED =
  "Plyloft changed your Program folders. To change them back, use Undo, or edit them in Settings › Look and feel › Editor and terminals › Program folders.";

/** The Repair steps that write the Program folders setting. */
export function writesProgramFolders(kind: RepairStepKind): boolean {
  return kind === "addProgramFolder" || kind === "emptyProgramFolders";
}

/** 1.176.1: what the last run's cause says, when it is a command that
 *  wasn't found (the owner's installer: `exit 127`); null for the others,
 *  which the block's own words cover. */
export function evidenceLine(block: RepairBlock | null, programFoldersSet: boolean): string | null {
  if (block?.kind !== "couldNotRepair" || block.evidence?.cause !== "command-not-found") return null;
  const what = block.evidence.causePath ? `the ${block.evidence.causePath} command` : "a command";
  return (
    `The last step needed ${what} and couldn't find it.` +
    (programFoldersSet
      ? ` Your Program folders in Settings may leave it out: check them, or empty them so Plyloft uses ${whatShellReports(platform() === "windows")}.`
      : "")
  );
}

/** The by-hand alternative to the step, beside "Open Program folders". */
export const PROGRAM_FOLDERS_BY_HAND =
  "Or empty Program folders in Settings, so Plyloft uses what your shell reports.";
/** Windows walk: in this platform's words. */
export function programFoldersByHand(windows: boolean = platform() === "windows"): string {
  return `Or empty Program folders in Settings, so Plyloft uses ${whatShellReports(windows)}.`;
}

export const OPEN_PROGRAM_FOLDERS = "Open Program folders";
/** Walk 3: the line before "Open Program folders" when no by-hand way is said. */
export const PROGRAM_FOLDERS_OFFER_LINE = "Your Program folders setting decides where Plyloft looks for it.";

// ── Reopening a closed tile (D2) ──────────────────────────────────────

/** The sentence under "Reinstall anyway" (nothing was found wrong). */
export const reinstallNote = (name: string) =>
  `This installs ${name} again with its official installer, although nothing was found wrong. Your sign-in and settings stay.`;

export const SESSIONS_NOTE_ONE =
  "Whatever it is doing stops, including a reply being written. The conversation stays in History, and Plyloft can open the tile again afterwards.";
export const SESSIONS_NOTE =
  "Whatever they are doing stops, including a reply being written. Each conversation stays in History, and Plyloft can open the tiles again afterwards.";
export const END_NOTE = (name: string) =>
  `Your sign-in, projects and settings are still there. Plyloft only changed ${name}'s own files and who owns its folders.`;
