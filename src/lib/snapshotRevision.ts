import type { KanbanCard } from "../ipc";

/**
 * Tier 4 walk 2026-10-14 (PR #375): which build snapshot a Builder card is
 * at, as "n:sha" ("" with none). Surfaces that re-read on a new Build done
 * key on this, never on the snapshot count alone: a reselected earlier
 * snapshot, or a list rewritten to the same length, is still a new one.
 */
export function latestSnapshotKey(builder: KanbanCard["builder"] | null | undefined): string {
  const snapshots = builder?.snapshots;
  const last = snapshots && snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  return last ? `${last.n}:${last.sha}` : "";
}
