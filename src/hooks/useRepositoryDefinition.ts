import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  areasGet,
  onWorkspaceDefinitionEdited,
  onWorkspaceDefinitionRefreshed,
  projectConfigGet,
  projectReviewGet,
  workspaceDefinitionGet,
  worktreeSettingsGet,
  type DefinitionView,
  type ProjectConfig,
  type ReviewSettings,
  type WorktreeSettings,
} from "../ipc";
import { definitionReadKey, pageReadFoundNothing } from "../lib/definitionRefresh";
import { LatestRequest } from "../lib/latestRequest";
import { useWorkspaces } from "../store/workspaceStore";
import { deriveRepository, type DerivedRepository } from "../lib/repositoryPage";

/**
 * UX language card 2: everything Settings › Repository reads, under one
 * roof. With `.atelier/workspace.json` on the integration branch the pages
 * edit the shared definition; without one they edit this Mac's own project
 * config, and the fields keep the same names either way (ADR 0004: one
 * page, the scope changes).
 *
 * What those reads *mean* is `deriveRepository`'s, in the pure layer, so
 * the cases that turn up once in a while are tested rather than hoped for.
 */
export interface RepositoryState extends DerivedRepository {
  /** No read has landed yet: the page has nothing true to show. */
  loading: boolean;
  /** A read that failed. The page keeps the last good one beside it. */
  error: string | null;
  config: ProjectConfig | null;
  review: ReviewSettings | null;
  /** SL-4: the worktree settings this Mac runs with. */
  worktree: WorktreeSettings | null;
  /** Counts the reads that completed, whatever they said, and whether the
   *  last one succeeded. A page holding still until it knows what a save
   *  did watches both: only a read that brought values tells it anything
   *  (F3). */
  reads: number;
  lastReadOk: boolean;
  /** Resolves once the authoritative read has landed. */
  reload: () => Promise<void>;
}

/** One read of all three sources. A page built from half of them would
 *  show a failed read as settings that are simply empty (F35), so they
 *  land together or not at all. */
interface Snapshot {
  view: DefinitionView | null;
  config: ProjectConfig | null;
  review: ReviewSettings | null;
  worktree: WorktreeSettings | null;
  /** 1.173.0 (G1): this Mac's default release kind (`areas.json`). */
  releaseKind: string | null;
}

export function useRepositoryDefinition(
  workspaceId: string,
  /** 1.173.0 (G1): also read this Mac's own default release kind (only the
   *  Shipping page shows it). */
  options?: { releaseKind?: boolean },
): RepositoryState {
  const wantsReleaseKind = options?.releaseKind === true;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  const [lastReadOk, setLastReadOk] = useState(true);
  const [offlineNow, setOfflineNow] = useState<boolean | null>(null);
  const workspace = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId) ?? null);
  const latestRead = useRef(new LatestRequest());
  const readFailed = useRef(false);

  const reload = useCallback(async () => {
    const ticket = latestRead.current.begin();
    try {
      // Not `.catch(() => null)`: a rejected read is not "there is none",
      // and settings invented from a failure read as this repository's.
      const [view, config, review, worktree, areas] = await Promise.all([
        workspaceDefinitionGet(workspaceId),
        projectConfigGet(workspaceId),
        projectReviewGet(workspaceId),
        worktreeSettingsGet(workspaceId),
        // G1: only Shipping reads it, and only where nothing is shared — a
        // failed read of it is "none chosen", never a failed page.
        wantsReleaseKind
          ? Promise.resolve()
              .then(() => areasGet(workspaceId))
              .catch(() => null)
          : null,
      ]);
      if (!latestRead.current.isCurrent(ticket)) return;
      readFailed.current = false;
      setSnapshot({ view, config, review, worktree, releaseKind: areas?.releaseKind ?? null });
      setError(null);
      setLastReadOk(true);
      setReads((n) => n + 1);
    } catch (e) {
      // The last good snapshot stays: a page that was readable a moment
      // ago keeps showing what it read, with the failure above it. The
      // read still completed — a page waiting for one is told, and it is
      // the `ok: false` that leaves it waiting.
      if (!latestRead.current.isCurrent(ticket)) return;
      readFailed.current = true;
      setError(String(e));
      setLastReadOk(false);
      setReads((n) => n + 1);
    }
  }, [workspaceId, wantsReleaseKind]);

  useEffect(() => {
    setSnapshot(null);
    setError(null);
    setOfflineNow(null);
  }, [workspaceId]);

  useEffect(() => {
    void reload();
    // What the last read that went through followed. Not seen after a failure.
    let lastSeen: string | null = null;
    const offRefreshed = onWorkspaceDefinitionRefreshed((report) => {
      if (report.workspaceId !== workspaceId) return;
      // Whether Ply could reach the remote is only said here; without a
      // report the queue's own record answers it.
      if (report.publish) setOfflineNow(report.publish.offline);
      if (!readFailed.current && pageReadFoundNothing(report, lastSeen)) return;
      const key = definitionReadKey(report);
      void reload().then(() => {
        lastSeen = readFailed.current ? null : key;
      });
    });
    const offEdited = onWorkspaceDefinitionEdited((id) => {
      if (id === workspaceId) void reload();
    });
    const gate = latestRead.current;
    return () => {
      gate.retireAll();
      void offRefreshed.then((off) => off());
      void offEdited.then((off) => off());
    };
  }, [workspaceId, reload]);

  // Kept as one object while its sources hold still: the page prunes its
  // draft whenever this changes, and a new object every render would make
  // that a state update every render.
  const derived = useMemo(
    () =>
      deriveRepository({
        // No cast: `DefinitionViewLike` and `DefinitionView` have to agree
        // field for field, so a shape that drifts is a type error rather
        // than a value that is quietly `undefined` at runtime.
        view: snapshot?.view ?? null,
        config: snapshot?.config ?? null,
        review: snapshot?.review ?? null,
        worktree: snapshot?.worktree ?? null,
        releaseKind: snapshot?.releaseKind ?? null,
        workspace,
        offlineNow,
      }),
    [snapshot, workspace, offlineNow],
  );

  return {
    ...derived,
    loading: snapshot === null,
    error,
    config: snapshot?.config ?? null,
    review: snapshot?.review ?? null,
    worktree: snapshot?.worktree ?? null,
    reads,
    lastReadOk,
    reload,
  };
}
