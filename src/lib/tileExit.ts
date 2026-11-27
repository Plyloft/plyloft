// UX-0.1: what a PTY tile says once its process has ended. The tile stays on
// the grid with its output; a clean exit reads differently from a crash.
//
// Pure: no React, no store.

export type ExitedStatus = "done" | "crashed";

/** A process that exits with code 0 ended cleanly; anything else, including
 *  a signal (no code), is a crash. */
export function exitStatus(code: number | null): ExitedStatus {
  return code === 0 ? "done" : "crashed";
}

/** Ctrl-C ends a shell or a CLI with this code (128 + SIGINT). */
const CTRL_C_CODE = 130;
/** Challenger round 1: Windows' STATUS_CONTROL_C_EXIT (0xC000013A), as the
 *  PTY reports it (a u32 cast to i32) or unsigned. */
const WINDOWS_CTRL_C_CODES = [-1073741510, 3221225786];

/** The code a Ctrl-C ends a process with, on this platform. */
export function isCtrlCCode(code: number | null, windows = false): boolean {
  if (code == null) return false;
  return code === CTRL_C_CODE || (windows && WINDOWS_CTRL_C_CODES.includes(code));
}

/**
 * QoL 1.168 (block 4, S3-1): the header chip for an ended PTY tile, in plain
 * words. "Crashed" only meant a crash for a process that stopped with no
 * code; a shell `exit`ed after a failed command, or one quit with Ctrl-C,
 * simply ended. The code stays, in words, in the chip's tooltip
 * (`exitedTitle`).
 */
export function exitedLabel(
  status: ExitedStatus,
  code: number | null,
  windows = false,
  kind = "shell",
): string {
  if (status === "done" || code === 0) return "Ended";
  if (code == null) return "Stopped unexpectedly";
  if (isCtrlCCode(code, windows)) return "Ended with Ctrl-C";
  // QoL 1.168 (block 10 Mac walk): a Claude or Codex session ending with an
  // error code is a crash (a `kill -9` reads as code 1): red, in these words,
  // in its header and its sidebar row alike. A shell's code is its last
  // command's.
  if (exitedAsCrash(code, kind, windows)) return "Stopped unexpectedly";
  return `Ended · error code ${code}`;
}

/** QoL 1.168 (block 10, A6): the one test of a real crash — no code, or
 *  Claude or Codex ending with a code that isn't 0 or Ctrl-C. */
export function exitedAsCrash(code: number | null, kind: string, windows = false): boolean {
  if (code === 0 || isCtrlCCode(code, windows)) return false;
  return code == null || kind === "claude" || kind === "codex";
}

/** The chip's tooltip: what the code means. A shell's code is its last
 *  command's; Claude's or Codex's is the session's own. */
export function exitedTitle(code: number | null, kind = "shell", windows = false): string {
  if (code === 0) return "The session ended normally.";
  if (code == null) return "The process stopped without saying how: it was stopped from outside, or it crashed.";
  if (isCtrlCCode(code, windows)) return `Stopped with Ctrl-C (code ${code}).`;
  if (kind === "claude" || kind === "codex") return `The session ended with an error (code ${code}).`;
  return `The process ended with an error (code ${code}): the last command reported one.`;
}

/** An ended tile whose end reads as calm (muted), not as a failure (red). */
export function exitedCalmly(code: number | null, windows = false): boolean {
  return code === 0 || isCtrlCCode(code, windows);
}

/** Tile kinds whose process runs in a PTY and can be started again. */
export function isRestartableKind(kind: string): kind is "shell" | "claude" | "codex" {
  return kind === "shell" || kind === "claude" || kind === "codex";
}
