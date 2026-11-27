import { invoke } from "@tauri-apps/api/core";

// The old "Ply" install left beside Plyloft (legacy_install.rs): its
// backend calls, moved out of `ipc.ts` unchanged (1.175.0, to make room
// under its cap).

export type LegacyInstall = {
  version: string | null;
  /** The folder (Windows) or Ply.app (macOS) that goes. */
  location: string;
  shortcuts: string[];
  /** Its shortcuts in the all-users folders: named after removal, not moved. */
  adminShortcuts: string[];
  /** Ply.lnk files whose target could not be confirmed: named, not moved. */
  unmatchedShortcuts: string[];
  allUsers: boolean;
};

/** What a removal did (legacy_install.rs `LegacyRemoval`). */
export type LegacyRemoval = {
  /** "the Recycle Bin" / "the Trash". */
  bin: string;
  moved: string[];
  adminShortcuts: string[];
  unmatchedShortcuts: string[];
};

export function legacyInstallProbe() {
  return invoke<LegacyInstall | null>("legacy_install_probe");
}

/** Detects again in Rust and removes what it finds; never takes a path. */
export function legacyInstallRemove() {
  return invoke<LegacyRemoval | null>("legacy_install_remove");
}
