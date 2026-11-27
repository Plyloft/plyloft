// 1.173.0 A3: a workspace's copies without a card, as Terminals shows them
// (the Copies view, the tile head's "Copy · name"). Read from `copy_list`
// and read again on `copies://changed`. Keyed by workspace id; never
// persisted (the backend's `copies.json` is the record).
import { create } from "zustand";
import { copyList, onCopiesChanged, type CopyView } from "../ipc";
import { EMPTY_ARRAY } from "../lib/empties";

interface CopiesStore {
  byWorkspace: Record<string, CopyView[]>;
  refresh: (workspaceId: string) => Promise<void>;
  /** Put a row in at once (a copy just made), before the next read. */
  upsert: (workspaceId: string, row: CopyView) => void;
}

export const useCopies = create<CopiesStore>((set) => ({
  byWorkspace: {},
  refresh: async (workspaceId) => {
    try {
      const rows = await copyList(workspaceId);
      set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: rows } }));
    } catch (e) {
      // The list is a convenience: a read that failed keeps the last one.
      console.warn("copy_list failed", e);
    }
  },
  upsert: (workspaceId, row) =>
    set((s) => {
      const rows = s.byWorkspace[workspaceId] ?? [];
      const at = rows.findIndex((r) => r.id === row.id);
      const next = at >= 0 ? rows.map((r, i) => (i === at ? row : r)) : [row, ...rows];
      return { byWorkspace: { ...s.byWorkspace, [workspaceId]: next } };
    }),
}));

/** The rows of one workspace (a stable empty array before the first read). */
export function useWorkspaceCopies(workspaceId: string): CopyView[] {
  return useCopies((s) => s.byWorkspace[workspaceId] ?? (EMPTY_ARRAY as CopyView[]));
}

/** The active copies (the Copies view's first group, and the header's count). */
export function activeCopies(rows: CopyView[]): CopyView[] {
  return rows.filter((r) => r.state === "active");
}

function norm(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** The active copy a folder is in (`cwd` at or under its folder), if any —
 *  separators either way, so a Windows path matches too. */
export function copyForCwd(rows: CopyView[], cwd: string | null | undefined): CopyView | null {
  if (!cwd) return null;
  const at = norm(cwd);
  return (
    rows.find((r) => {
      if (r.state !== "active" || !r.path) return false;
      const root = norm(r.path);
      return at === root || at.startsWith(`${root}/`);
    }) ?? null
  );
}

let listening: Promise<() => void> | null = null;

// 1.174.0 walk G3 Windows: the watcher also says `copies://changed` when a
// copy's files or branch change (a save, a commit), once per batch — while
// a copy is being made that is many. One read runs at a time per workspace;
// what arrives meanwhile is one more read after it.
const reading = new Map<string, boolean>();

function refreshCoalesced(workspaceId: string): void {
  if (reading.has(workspaceId)) {
    reading.set(workspaceId, true);
    return;
  }
  reading.set(workspaceId, false);
  void useCopies
    .getState()
    .refresh(workspaceId)
    .finally(() => {
      const again = reading.get(workspaceId);
      reading.delete(workspaceId);
      if (again) refreshCoalesced(workspaceId);
    });
}

/** Start reading `copies://changed` once for the whole window (idempotent). */
export function listenForCopies(): void {
  if (listening) return;
  listening = onCopiesChanged((workspaceId) => refreshCoalesced(workspaceId)).catch((e) => {
    listening = null;
    console.warn("copies listener failed", e);
    return () => {};
  });
}

/** Tests only: forget the listener so the next test listens again. */
export function resetCopiesListenerForTests(): void {
  listening = null;
  reading.clear();
}
