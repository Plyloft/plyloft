import { listen } from "@tauri-apps/api/event";
import type { SetupOutcome } from "../ipc.ts";
import type { SetupRunCause } from "./setupEvidence.ts";

// 1.176.0 R5: the automatic Codex update's events (`codex_auto_update.rs`),
// kept out of `ipc.ts` for its line cap. The window never starts the update:
// the backend runs it while Codex is idle and says when it starts and ends.

/** What the window says about an update that ran (`codex_auto_update::Notice`). */
export type CodexUpdateNoticeKind = "updated" | "still-works" | "not-starting";

/** The end of an update that ran (`codex_auto_update::Done`). */
export interface CodexUpdateDone {
  outcome: SetupOutcome;
  cause: SetupRunCause | null;
  causePath: string | null;
  versionBefore: string | null;
  versionAfter: string | null;
  /** The updater's exit code (null: stopped, or no code). */
  exitCode: number | null;
  /** Codex answers `--version` after the run. */
  starts: boolean;
  /** Null: say nothing (nothing newer, already said for this version and cause). */
  notice: CodexUpdateNoticeKind | null;
  /** What ran, as Diagnostics' Update row names it. */
  command: string;
  tail: string[];
}

/** The update started (true) or ended (false). */
export function onCodexUpdateState(handler: (running: boolean) => void) {
  return listen<{ running: boolean }>("codex-update://state", (e) => handler(e.payload?.running === true));
}

export function onCodexUpdateDone(handler: (done: CodexUpdateDone) => void) {
  return listen<CodexUpdateDone | null>("codex-update://done", (e) => {
    // A payload that isn't an update's end says nothing: no notice, no throw.
    if (e.payload && typeof e.payload === "object") handler({ ...e.payload, tail: Array.isArray(e.payload.tail) ? e.payload.tail : [] });
  });
}
