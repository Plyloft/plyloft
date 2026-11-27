import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// 1.176.1: what the backend found changed in `claude` or `codex` since its
// last look (`cli_seen.rs`), kept out of `ipc.ts` for its line cap. The
// backend decides *whether* to say anything (once per change, never at the
// first look, never for Setup's, Repair's or the automatic update's own
// change); `cliSeenNotice.ts` decides the words.

/** One thing to say (`cli_seen::Notice`). Folders already read `~` for home. */
export type CliSeenNotice =
  | {
      kind: "changed";
      tool: "claude" | "codex";
      versionWas: string | null;
      versionNow: string | null;
      folderWas: string | null;
      folderNow: string | null;
    }
  /** The reviewer's background re-check makes its real request now. */
  | { kind: "checking"; tool: "claude" | "codex"; version: string };

/** The notices not shown yet, each given once. */
export function cliSeenTake(): Promise<CliSeenNotice[]> {
  return invoke<CliSeenNotice[]>("cli_seen_take");
}

/** Something new to take. */
export function onCliSeenPending(handler: () => void) {
  return listen("cli-seen://pending", () => handler());
}
