/**
 * GH #79: `useWorkspaces.refresh()` now also runs in the background, after a
 * shared-definition refresh changed a name, accent or board. Two rules keep
 * those background runs from undoing what the user just did:
 *
 * - a switch made while a refresh awaited wins over the active id it read;
 * - a refresh superseded by a newer one never applies (a delete's or a
 *   create's own refresh must not be overwritten by an older list).
 *
 * Pure, so `activeWorkspace.test.ts` runs it under plain node.
 */
import { LatestRequest } from "./latestRequest.ts";

export function activeIdAfterRefresh(
  before: string | null,
  now: string | null,
  fromBackend: string | null,
  workspaceIds: string[],
): string | null {
  if (now !== before && now !== null && workspaceIds.includes(now)) return now;
  return fromBackend;
}

export interface WorkspaceListing<W extends { id: string }> {
  workspaces: W[];
  activeWorkspaceId: string | null;
}

export interface WorkspaceRefreshDeps<W extends { id: string }> {
  list: () => Promise<WorkspaceListing<W>>;
  cwdExists: (id: string) => Promise<boolean>;
  activeId: () => string | null;
  apply: (next: {
    workspaces: W[];
    activeId: string | null;
    cwdMissing: Record<string, boolean>;
  }) => void;
}

/** The store's `refresh`: only the newest call may apply its result. */
export function makeWorkspaceRefresh<W extends { id: string }>(
  deps: WorkspaceRefreshDeps<W>,
): () => Promise<void> {
  const gate = new LatestRequest();
  return async () => {
    const ticket = gate.begin();
    const activeBefore = deps.activeId();
    const file = await deps.list();
    // All at once: one by one, every round trip queued behind the launch's
    // other IPC and the sidebar waited for the slowest sum.
    const cwdMissing: Record<string, boolean> = {};
    await Promise.all(
      file.workspaces.map(async (ws) => {
        try {
          cwdMissing[ws.id] = !(await deps.cwdExists(ws.id));
        } catch {
          cwdMissing[ws.id] = true;
        }
      }),
    );
    if (!gate.isCurrent(ticket)) return;
    deps.apply({
      workspaces: file.workspaces,
      activeId: activeIdAfterRefresh(
        activeBefore,
        deps.activeId(),
        file.activeWorkspaceId,
        file.workspaces.map((w) => w.id),
      ),
      cwdMissing,
    });
  };
}
