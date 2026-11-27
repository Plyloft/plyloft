import { invoke } from "@tauri-apps/api/core";
import type { SetupTool } from "../ipc.ts";

// 1.176.0 R2: what an install or update run really did, beside `ipc.ts`'s
// Setup block (kept out of it for its line cap): the final `setup://progress`
// event's evidence (`setup_outcome::Evidence`, flattened into the event) and
// the last-run record on disk (`setup_last_run.rs`).

/** Why a run didn't work, as far as its output says (`setup_outcome::Cause`). */
/** `not-admin`, `password-refused`: sudo's answers (R4, a Repair's chown only). */
export type SetupRunCause =
  | "permissions"
  | "disk-full"
  | "file-in-use"
  | "network"
  | "timed-out"
  | "not-admin"
  | "password-refused"
  /** 1.176.1: a command the run needed wasn't found (exit 127, 126, 9009);
   *  `causePath` is its name when the output names it. */
  | "command-not-found"
  | "unknown";

/** The final event's evidence. Absent on older builds and on every event
 *  before the last. */
export interface SetupRunEvidence {
  /** Set when the run didn't succeed and wasn't stopped by the person. */
  cause?: SetupRunCause | null;
  /** The folder or file the output says was refused, best effort. */
  causePath?: string | null;
  /** An install or update: the tool's version before the run and after it. */
  versionBefore?: string | null;
  versionAfter?: string | null;
}

/** A tool's last guided install or update, as kept on disk. Outcome and
 *  cause are wire names kept as text: a newer Plyloft's names still read. */
export interface SetupLastRun {
  actionId: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  outcome: string | null;
  cause: string | null;
  causePath: string | null;
  versionBefore: string | null;
  versionAfter: string | null;
  tail: string[];
}

/** The last install or update of `tool`, or null when none was recorded. */
export function setupLastRun(tool: SetupTool) {
  return invoke<SetupLastRun | null>("setup_last_run", { tool }).then((r) =>
    r && typeof r === "object" && typeof r.actionId === "string" ? { ...r, tail: Array.isArray(r.tail) ? r.tail : [] } : null,
  );
}
