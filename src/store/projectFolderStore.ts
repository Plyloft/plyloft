// F1 (1.172.1, owner 2026-10-28): the project folder's ask — which workspace's
// changes sheet is open, and which ask the person already answered with
// *Bring it up to date* (so the Board stops asking it). *I don't work here*
// is persisted per workspace (`Workspace.dontWorkHere`); the answered key is a
// convenience of this Mac's browser storage: lost, the ask shows once more.
import { create } from "zustand";

const ANSWERED = "plyloft.folderAskAnswered.";

function readAnswered(workspaceId: string): string | null {
  try {
    return globalThis.localStorage?.getItem(ANSWERED + workspaceId) ?? null;
  } catch {
    return null;
  }
}

function writeAnswered(workspaceId: string, key: string | null): void {
  try {
    if (key === null) globalThis.localStorage?.removeItem(ANSWERED + workspaceId);
    else globalThis.localStorage?.setItem(ANSWERED + workspaceId, key);
  } catch {
    /* storage refused: the ask shows again next time */
  }
}

/** Why the changes sheet opened (TX5 round 1, T30b): the Board's ask and a
 *  Sync ("sync"), or a ship the folder's changes stopped ("ship"). */
export type FolderSheetReason = "sync" | "ship";

interface ProjectFolderShape {
  /** The workspace whose changes sheet is open, or null. */
  sheetFor: string | null;
  /** Why it opened; "sync" while it is closed. */
  sheetReason: FolderSheetReason;
  /** Per workspace: the ask key last answered with Bring it up to date
   *  (`undefined`: not read from storage yet). */
  answered: Record<string, string | null>;
  openSheet: (workspaceId: string, reason?: FolderSheetReason) => void;
  closeSheet: () => void;
  markAnswered: (workspaceId: string, key: string | null) => void;
}

export const useProjectFolder = create<ProjectFolderShape>((set) => ({
  sheetFor: null,
  sheetReason: "sync",
  answered: {},
  openSheet: (workspaceId, reason = "sync") => set({ sheetFor: workspaceId, sheetReason: reason }),
  closeSheet: () => set({ sheetFor: null, sheetReason: "sync" }),
  markAnswered: (workspaceId, key) => {
    writeAnswered(workspaceId, key);
    set((s) => ({ answered: { ...s.answered, [workspaceId]: key } }));
  },
}));

/** Opens the project folder's changes sheet (`FolderChangesSheet`, 1.172.1)
 *  for `workspaceId` — the Board's ask, a local-branch toast's press and,
 *  from 1.174.0 (TX5), the Show them of a ship the folder's changes stopped. */
export function openFolderChanges(workspaceId: string, reason: FolderSheetReason = "sync"): void {
  useProjectFolder.getState().openSheet(workspaceId, reason);
}

/** The ask key answered for `workspaceId`, from memory or storage. */
export function answeredAsk(workspaceId: string): string | null {
  const known = useProjectFolder.getState().answered;
  return workspaceId in known ? known[workspaceId] : readAnswered(workspaceId);
}

/** A hook form of [`answeredAsk`]: re-renders when it is answered here. */
export function useAnsweredAsk(workspaceId: string): string | null {
  const inMemory = useProjectFolder((s) => (workspaceId in s.answered ? s.answered[workspaceId] : undefined));
  return inMemory === undefined ? readAnswered(workspaceId) : inMemory;
}
