// 1.176.0 R7: "the tool didn't start" for a Claude or Codex tile, told apart
// from a session the person ended or a CLI that ran and refused. Pure (node
// runs it: `src/lib/startFailure.test.ts`); Terminal.tsx gathers the facts and
// asks the backend, the tile draws the line with Repair (`TileStartFailedLine`).
//
// Repair is offered only on a confirmed cause, for a tile of kind `claude`
// or `codex` (never a shell, whatever it runs):
//
// 1. The spawn was refused with R3's typed "not there even after looking
//    again" (`cliUnavailable`), or with the PTY's own `spawn: …` (the OS
//    couldn't run the program: it is started directly, never through a
//    shell) → Repair at once.
// 2. The process ended on its own and might be a CLI that can't run
//    (`exitAsksBackend`): an error code (not 0, not Ctrl-C's, not unknown),
//    nothing typed, Plyloft didn't stop it, and either within
//    `DIED_AT_ONCE_MS` with no screen set up (and, resumed, no word of its
//    session), or with a wording/code that says the program couldn't load
//    (`loadFailureSignal`). The tile shows the neutral ended state at once,
//    its output in view, and asks the backend (`cli_start_verdict`: R3's
//    narrow `--version` recheck). Only its certain "fails" turns the line
//    into the Repair offer; a version or an Unknown (slow, mid-update) keeps
//    the neutral state. A bad flag, a broken config, not signed in or
//    offline all leave `--version` answering: neutral.
// 3. The absence of terminal modes is never evidence (ConPTY may swallow or
//    re-render them): modes seen are only a reason not to ask.

import type { TileCli } from "./ptySpawnIpc.ts";
import { decodeCliUnavailable } from "./cliUnavailable.ts";
import { decodeCliNotStarting } from "./cliNotStarting.ts";
import { isCtrlCCode } from "./tileExit.ts";
import { machineWords } from "./platform.ts";

/** A start that ends this soon after the spawn may be a CLI that can't run. */
export const DIED_AT_ONCE_MS = 5_000;

/** DECSET modes that only a program which set up its screen turns on. */
export const SCREEN_SETUP_MODES: readonly number[] = [1004, 1049, 2004];

const SCREEN_SETUP = new RegExp(`\\x1b\\[\\?(?:[\\d;]*;)?(?:${SCREEN_SETUP_MODES.join("|")})(?:;[\\d;]*)?h`);

/** The program's output turned on one of `SCREEN_SETUP_MODES` (a DECSET,
 *  alone or among others: `ESC[?2004h`, `ESC[?1;1049h`). */
export function setsUpScreen(output: string): boolean {
  return SCREEN_SETUP.test(output);
}

/** Exit codes that say the program couldn't be loaded or found: 126/127
 *  (a shell's "cannot execute" / "not found", `env: node: …`), Windows'
 *  9009 (not recognized) and STATUS_DLL_NOT_FOUND (0xC0000135). */
const LOAD_FAILURE_CODES = [126, 127, 9009, -1073741515, 3221225781];

const LOAD_FAILURE_WORDS =
  /\bdyld\b|Library not loaded|bad CPU type|Exec format error|cannot execute|No such file or directory|is not recognized as an internal or external command|Cannot find module/i;

/** The output or code says the program itself couldn't load: a reason to ask
 *  the backend even past the window or after a screen was set up. */
export function loadFailureSignal(code: number | null, output: string): boolean {
  return (code != null && LOAD_FAILURE_CODES.includes(code)) || LOAD_FAILURE_WORDS.test(output);
}

export type StartFailureCause =
  /** Not on disk, even after Plyloft looked again (R3). */
  | "gone"
  /** The OS refused to run the program (`spawn: …`). */
  | "wontRun"
  /** It ran and ended at once, and the backend confirmed it doesn't start. */
  | "stoppedAtOnce";

export interface StartFailure {
  tool: TileCli;
  cause: StartFailureCause;
}

/** The backend's answer (`cli_fresh::StartVerdict`). */
export type StartVerdict = "starts" | "fails" | "unknown";

export interface ExitFacts {
  /** The tile's declared kind; null for a shell. */
  cli: TileCli | null;
  code: number | null;
  /** From the spawn call to the exit. */
  elapsedMs: number;
  /** The person typed or pasted into the tile. */
  typed: boolean;
  /** Plyloft itself ended it (`markPtyClosing`: a close, a Restart, a quit). */
  closedByPlyloft: boolean;
  /** The program turned on one of `SCREEN_SETUP_MODES`. */
  drewScreen: boolean;
  /** The tile resumes a conversation. */
  resumed: boolean;
  /** What the program printed, as text (escapes left in are harmless). */
  output: string;
  windows?: boolean;
}

/** A spawn the backend refused, for a Claude or Codex tile. */
export function spawnStartFailure(cli: TileCli | null | undefined, error: unknown): StartFailure | null {
  if (!cli) return null;
  const gone = decodeCliUnavailable(error);
  if (gone) return { tool: gone.tool, cause: "gone" };
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  if (/^spawn: /.test(raw)) return { tool: cli, cause: "wontRun" };
  return null;
}

/** A process that ended on its own: is it worth asking the backend whether
 *  the tool starts? Never an answer by itself. */
export function exitAsksBackend(f: ExitFacts): boolean {
  if (!f.cli || f.closedByPlyloft || f.typed) return false;
  if (f.code == null || f.code === 0 || isCtrlCCode(f.code, f.windows ?? false)) return false;
  if (f.elapsedMs < 0) return false;
  if (loadFailureSignal(f.code, f.output)) return true;
  if (f.elapsedMs > DIED_AT_ONCE_MS || f.drewScreen) return false;
  if (f.resumed && /\b(session|conversation)/i.test(f.output)) return false;
  return true;
}

/** The backend's answer, for a tile that asked: Repair only on "fails". */
export function verdictStartFailure(tool: TileCli, verdict: StartVerdict | null | undefined): StartFailure | null {
  return verdict === "fails" ? { tool, cause: "stoppedAtOnce" } : null;
}

/** The tile's arguments resume a conversation (or open the picker for one). */
export function resumesConversation(cli: TileCli | null | undefined, args: readonly string[]): boolean {
  if (cli === "claude") return args.some((a) => a === "--resume" || a === "-r" || a === "--continue" || a === "-c");
  if (cli === "codex") return args[0] === "resume";
  return false;
}

export function toolName(tool: TileCli): string {
  return tool === "claude" ? "Claude Code" : "Codex";
}

/** The tile's line under its header (Repair beside it). */
export function startFailureLine(f: StartFailure, programFoldersSet = false): string {
  const name = toolName(f.tool);
  switch (f.cause) {
    case "gone":
      // 1.176.1: with Program folders set, that list is where it was looked
      // for; Repair says whether it is installed elsewhere.
      if (programFoldersSet) return `${name} didn't start: Plyloft can't find it in the Program folders you set.`;
      return machineWords(`${name} didn't start: Plyloft can't find it on this Mac any more.`);
    case "wontRun":
      return `${name} didn't start: the computer couldn't run its program.`;
    case "stoppedAtOnce":
      return `${name} didn't start: it stopped as soon as it started, and it doesn't answer Plyloft's check. What it printed is below.`;
  }
}

/** The Repair button's words. */
export function repairLabel(tool: TileCli): string {
  return `Repair ${toolName(tool)}`;
}

/** The way on, as words, where a button can't be (a terminal's own lines). */
export const REPAIR_IN_DIAGNOSTICS = "Settings › Setup and account › Diagnostics › Repair";

/** The terminal's own line under "This session didn't start." */
export function terminalWayOn(failure: StartFailure | null): string {
  if (failure) return `Press ${repairLabel(failure.tool)} above, or Restart.`;
  return "Close this tile and open a new one. If it happens again, Settings › Setup and account › Diagnostics checks the shell.";
}

/**
 * `codex-chat` (the App Server, `CodexSession`): "Codex couldn't start." with
 * its cause when it is known, and whether Repair is the way on. A start
 * refused because Codex isn't there (R3's typed error), doesn't start (the
 * backend's typed mark, `lib/cliNotStarting`) or can't be run (`spawn Codex
 * App Server: …`) offers Repair; any other refusal keeps the plain sentence
 * alone, its words behind Details.
 */
export function codexChatStartFailure(error: unknown): { sentence: string; repair: boolean } {
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  if (decodeCliUnavailable(error))
    return { sentence: machineWords("Codex couldn't start: Plyloft can't find it on this Mac any more."), repair: true };
  if (decodeCliNotStarting(raw) === "codex")
    return { sentence: "Codex couldn't start: it is installed but not starting.", repair: true };
  if (/^spawn Codex App Server: /.test(raw))
    return { sentence: "Codex couldn't start: the computer couldn't run its program.", repair: true };
  return { sentence: "Codex couldn't start.", repair: false };
}

/** The App Server ended before it answered Plyloft's first request, with an
 *  error code, and Plyloft didn't stop it: ask the backend (the same rule as
 *  a tile — a broken `config.toml` leaves `--version` answering). Nothing can
 *  be typed before that answer. */
export function codexChatAsksBackend(f: {
  code: number | null;
  elapsedMs: number;
  answered: boolean;
  stoppedByPlyloft: boolean;
  stderr: string;
  windows?: boolean;
}): boolean {
  if (f.answered || f.stoppedByPlyloft) return false;
  if (f.code == null || f.code === 0 || isCtrlCCode(f.code, f.windows ?? false)) return false;
  if (f.elapsedMs < 0) return false;
  return f.elapsedMs <= DIED_AT_ONCE_MS || loadFailureSignal(f.code, f.stderr);
}

/** Its line once the backend confirmed Codex doesn't start. */
export const CODEX_CHAT_DIED_AT_ONCE =
  "Codex couldn't start: it stopped as soon as it started, and it doesn't answer Plyloft's check. What it printed is above.";
