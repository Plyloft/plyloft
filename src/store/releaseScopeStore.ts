// 1.174.0 (DR3): what each area of a workspace would release now
// (`release_scopes`), kept for the openers that say it before the press —
// the Board's ⋯ (Release Site… "4 cards and 2 other changes on main since
// site-v3.0.1") and ⌘K. Read when one of them opens (the backend shares its
// fetch of GitHub for 30 s), never by every warmed Board on mount. The
// Release sheet reads its own area's scope afresh.
//
// DR3 round 1: a reading goes stale when the workspace's release record
// changes (`PENDING_RELEASE_CHANGED`) and when a Ship it or a release is done
// (`markReleaseScopesStale`): the next read starts afresh, never joining a
// read begun before, whose answer is then dropped.
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { PENDING_RELEASE_CHANGED, releaseScopes, type ReleaseScope } from "../ipc";

export interface ScopesReading {
  /** null until the first read answers. */
  scopes: ReleaseScope[] | null;
  /** The last read failed; `scopes` is the one before, if any. */
  failed: boolean;
}

interface ReleaseScopeState {
  byWorkspace: Record<string, ScopesReading>;
  /** Read this workspace's scopes again; the last reading stays until the
   *  answer. A read under way is shared unless the reading went stale since
   *  it began. */
  read: (workspaceId: string) => Promise<void>;
}

/** Per workspace: bumped when its reading goes stale. */
const generation = new Map<string, number>();
const running = new Map<string, { gen: number; done: Promise<void> }>();
const genOf = (workspaceId: string) => generation.get(workspaceId) ?? 0;

export const useReleaseScopes = create<ReleaseScopeState>((set) => ({
  byWorkspace: {},
  read: (workspaceId) => {
    listenOnce();
    const gen = genOf(workspaceId);
    const under = running.get(workspaceId);
    if (under && under.gen === gen) return under.done;
    const done = releaseScopes(workspaceId)
      .then((scopes) => {
        // A reading that went stale while it ran is not the answer.
        if (genOf(workspaceId) !== gen) return;
        set((s) => ({
          byWorkspace: { ...s.byWorkspace, [workspaceId]: { scopes: Array.isArray(scopes) ? scopes : [], failed: false } },
        }));
      })
      .catch(() => {
        if (genOf(workspaceId) !== gen) return;
        set((s) => ({
          byWorkspace: {
            ...s.byWorkspace,
            [workspaceId]: { scopes: s.byWorkspace[workspaceId]?.scopes ?? null, failed: true },
          },
        }));
      })
      .finally(() => {
        if (running.get(workspaceId)?.gen === gen) running.delete(workspaceId);
      });
    running.set(workspaceId, { gen, done });
    return done;
  },
}));

/** The reading of this workspace is stale (its release record changed, a
 *  Ship it or a release is done): read again at once if it was read. */
export function markReleaseScopesStale(workspaceId: string): void {
  generation.set(workspaceId, genOf(workspaceId) + 1);
  if (useReleaseScopes.getState().byWorkspace[workspaceId]) void useReleaseScopes.getState().read(workspaceId);
}

let listening = false;
function listenOnce(): void {
  if (listening) return;
  listening = true;
  void listen<string>(PENDING_RELEASE_CHANGED, (event) => {
    if (typeof event.payload === "string") markReleaseScopesStale(event.payload);
  }).catch(() => {
    listening = false;
  });
}

const UNREAD: ScopesReading = { scopes: null, failed: false };

/** This workspace's last reading (`UNREAD` before the first). */
export function useScopesReading(workspaceId: string | null): ScopesReading {
  return useReleaseScopes((s) => (workspaceId ? (s.byWorkspace[workspaceId] ?? UNREAD) : UNREAD));
}
