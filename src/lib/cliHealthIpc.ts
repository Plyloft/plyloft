import { invoke } from "@tauri-apps/api/core";

// 1.176.0 R1: the read-only look at one AI CLI (`cli_health.rs`) that the
// guided Repair reads. Mirrors the Rust structs field by field (camelCase);
// nothing here writes or repairs.

export type CliTool = "claude" | "codex";

export type InstallChannel =
  | "native"
  | "standalone"
  | "npm"
  | "bun"
  | "pnpm"
  | "homebrew"
  | "legacyLocal"
  | "winget"
  | "unknown";

/** `timedOut`: past both bounds, inconclusive (not a failed start).
 *  `badBinary`: killed by a signal (a truncated or unsigned binary), or
 *  refused at spawn as malformed / wrong architecture. */
export type StartFailure =
  | "notFound"
  | "permissionDenied"
  | "timedOut"
  | "badBinary"
  | "spawnFailed"
  | "exited"
  | "unreadable"
  /** R4: ended by a signal other than SIGKILL: inconclusive. */
  | "signal";

/** One copy's `--version` result. */
export interface CopyStart {
  starts: boolean;
  version: string | null;
  failure: StartFailure | null;
  /** Ran past both bounds: whether it starts is unknown. */
  inconclusive: boolean;
  exitCode: number | null;
  /** The signal that ended it (unix). */
  signal: number | null;
  /** The last lines it printed, only when it failed. */
  tail: string | null;
}

/** One distinct copy (paths that are the same real file are one copy). */
export interface CliCopy {
  path: string;
  alsoAt: string[];
  /** Links followed; null for a broken link or one that can't be followed. */
  realPath: string | null;
  dangling: boolean;
  /** A folder on the link's way can't be read. */
  unreadable: boolean;
  linkTarget: string | null;
  /** For a link, where its chain ends (the real file, or where it broke). */
  linkEnd: string | null;
  /** Position of its PATH entry (0 = first); null when off PATH. */
  pathRank: number | null;
  inInstallDir: boolean;
  executable: boolean;
  /** null where it can't be told (Windows, a broken link). */
  ownedByUser: boolean | null;
  folderOwnedByUser: boolean | null;
  /** Outside the home and config folders: not the user's to fix. */
  systemFolder: boolean;
  channel: InstallChannel;
  /** null when it wasn't run (a broken link, not executable). */
  start: CopyStart | null;
  /** 1.176.1 (Windows walk): a copy on the Program folders list that doesn't
   *  start, asked again with the shell's folders. Absent on older builds. */
  startsWithShell?: boolean | null;
}

export type FolderKind = "dir" | "file";
export type FolderRole = "config" | "installTarget" | "copy";

export interface FolderCheck {
  path: string;
  kind: FolderKind;
  role: FolderRole;
  channel: InstallChannel;
  /** The copy a tile runs today needs it; otherwise only a Repair does. */
  neededNow: boolean;
  /** Outside the home and config folders: never offer to take it over. */
  systemFolder: boolean;
  exists: boolean;
  /** What was tested: the path, or its nearest existing parent. */
  checked: string | null;
  ownedByUser: boolean | null;
  writable: boolean;
}

/** A folder named in a finding. */
export interface FolderRef {
  path: string;
  neededNow: boolean;
  systemFolder: boolean;
}

/** The path the shell snapshot cached (what a tile runs), against the disk. */
export interface CachedCheck {
  path: string | null;
  runs: string | null;
  exists: boolean;
  executable: boolean;
  usable: boolean;
  /** The first executable copy on PATH now. */
  now: string | null;
  matchesNow: boolean;
}

/** Most severe first; tagged by `kind` (new kinds may be added).
 *  `foldersNotOwned` names only folders that are the user's to fix. */
export type CliFinding =
  | { kind: "missing" }
  | { kind: "noWorkingCopy" }
  | { kind: "cachedPathStale"; cached: string | null; now: string | null; usable: boolean }
  | { kind: "firstOnPathIsNotTheWorkingOne"; first: string | null; working: string; workingOnPath: boolean }
  | {
      kind: "doesNotStart";
      path: string;
      failure: StartFailure;
      exitCode: number | null;
      signal: number | null;
      tail: string | null;
    }
  | { kind: "startInconclusive"; path: string }
  | { kind: "danglingLink"; path: string; target: string | null; channel: InstallChannel }
  | { kind: "notExecutable"; path: string }
  | { kind: "unreadable"; paths: string[] }
  | { kind: "copyNotOwned"; path: string; systemFolder: boolean }
  | { kind: "foldersNotWritable"; folders: FolderRef[] }
  | { kind: "foldersNotOwned"; folders: FolderRef[] }
  | { kind: "severalCopies"; paths: string[] }
  | { kind: "nativeDirNotOnPath"; dir: string };

export interface CliHealth {
  tool: CliTool;
  /** One copy that counts, it is what a tile runs and it starts, the cached
   *  path is usable, its folders are writable and its file is the user's. */
  healthy: boolean;
  /** What a tile runs today (the cached path as a spawn resolves it). */
  runsToday: string | null;
  /** The first copy that starts. */
  shouldRun: string | null;
  /** Where the official installer puts the program. */
  installDir: string | null;
  /** null when Plyloft had no shell snapshot. */
  cached: CachedCheck | null;
  copies: CliCopy[];
  folders: FolderCheck[];
  findings: CliFinding[];
  /** R4: the snapshot passed over the first copy on PATH (it doesn't
   *  start) for `instead`; kept, only reported, under a PATH override. */
  passedOver: { path: string; instead: string; keptByOverride: boolean } | null;
}

/** Look at `tool` now (usually under a second; at most 8 s + 30 s when a
 *  copy's `--version` hangs). */
export function cliHealth(tool: CliTool) {
  return invoke<CliHealth | null>("cli_health", { tool }).then((h) => {
    if (!h || typeof h !== "object" || !Array.isArray(h.copies)) throw new Error("cli_health answered nothing usable");
    return h;
  });
}
