import { useCallback, useEffect, useMemo, useState } from "react";
import { fuzzyScore } from "../lib/fuzzyScore";
import { fsListFilesRecursive, onFileChange, type FileIndex } from "../ipc";
import { useSettings } from "../store/settingsStore";
import { openCenterMode } from "../store/uiStore";
import { openInEditor } from "../lib/openInEditor";
import { useSearch, type SearchMatch } from "../store/searchStore";
import { SearchPanel } from "./SearchPanel";
import { basename, joinPath } from "../lib/paths";
import { failure, type Failure } from "../lib/failure";
import { utf16Columns } from "../lib/matchColumns";
import { isTransientName } from "../lib/filesTree";

// UX-3.6: the Files and "In files" scopes of ⌘K — what Quick Open (⌘P) and
// the search modal (⌘⇧F) did, on the same IPC, drawn inside the one surface.

type CachedIndex = {
  paths: string[];
  truncated: boolean;
  loadedAt: number;
  /** Settings › Code › Show hidden files, as it was when this was walked. */
  hidden: boolean;
};

// The file index per workspace lives for the app's lifetime, across opens of
// ⌘K; Re-scan (⌘R in the Files scope) replaces it.
//
// QoL 6.1 (E2): it no longer goes stale until Re-scan. A file created or
// removed in the workspace (the watcher's `fs://changed`) marks its index
// stale; the next look at it — or the one open right now, after a short
// pause — walks again in the background while the old list stays on screen.
// Turning Show hidden files on or off does the same.
const indexCache = new Map<string, CachedIndex>();
const staleIndexes = new Set<string>();
/** The open Files scopes, told when their workspace's index went stale. */
const staleListeners = new Set<(workspaceId: string) => void>();
let watchingIndexes = false;

/** Marks `workspaceId`'s index stale and tells an open Files scope. */
export function markFileIndexStale(workspaceId: string): void {
  if (!indexCache.has(workspaceId)) return;
  staleIndexes.add(workspaceId);
  for (const listener of staleListeners) listener(workspaceId);
}

/** Once per app: created/removed files mark their workspace's index stale. */
function watchIndexes(): void {
  if (watchingIndexes) return;
  watchingIndexes = true;
  onFileChange((e) => {
    // Challenger L2: a save's own temp file (and an editor's swap file) is not
    // a file of the project; every ⌘S would mark the index stale.
    if (e.kind !== "created" && e.kind !== "removed") return;
    if (isTransientName(basename(e.path))) return;
    markFileIndexStale(e.workspaceId);
  }).catch(() => {
    watchingIndexes = false;
  });
}

/** Test seam: forget every cached index. */
export function resetFileIndexCache(): void {
  indexCache.clear();
  staleIndexes.clear();
}

/** The pause before an open Files scope walks again after a change: an AI
 *  writing ten files is one walk, not ten. */
export const STALE_REWALK_MS = 800;

export const MAX_FILE_RESULTS = 80;

/** The workspace's file index, loaded on first use and cached. */
export function useFileIndex(
  workspaceId: string | null,
  cwd: string | null,
  enabled: boolean,
) {
  const hidden = useSettings((s) => s.settings.editor.showHiddenFiles);
  const [index, setIndex] = useState<CachedIndex | null>(() =>
    workspaceId ? indexCache.get(workspaceId) ?? null : null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Failure | null>(null);

  const load = useCallback(
    async (force: boolean) => {
      if (!workspaceId || !cwd) return;
      const cached = indexCache.get(workspaceId);
      const fresh = cached && cached.hidden === hidden && !staleIndexes.has(workspaceId);
      if (!force && fresh) {
        setIndex(cached);
        return;
      }
      // A stale list stays on screen while the new one is walked.
      if (cached) setIndex(cached);
      setLoading(true);
      setError(null);
      staleIndexes.delete(workspaceId);
      try {
        const idx: FileIndex = await fsListFilesRecursive(cwd, hidden);
        const next = { paths: idx.paths, truncated: idx.truncated, loadedAt: Date.now(), hidden };
        indexCache.set(workspaceId, next);
        setIndex(next);
      } catch (e) {
        setError(failure("Couldn't list the files.", e));
        setIndex(null);
      } finally {
        setLoading(false);
      }
    },
    [workspaceId, cwd, hidden],
  );

  useEffect(() => {
    watchIndexes();
  }, []);

  useEffect(() => {
    if (enabled) void load(false);
  }, [enabled, load]);

  // While this scope is open, a change in its workspace walks again.
  useEffect(() => {
    if (!enabled || !workspaceId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const listener = (id: string) => {
      if (id !== workspaceId) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(false), STALE_REWALK_MS);
    };
    staleListeners.add(listener);
    return () => {
      staleListeners.delete(listener);
      if (timer) clearTimeout(timer);
    };
  }, [enabled, workspaceId, load]);

  return { index, loading, error, reload: () => void load(true) };
}

/** File paths matching `query`, best first; the basename counts a little
 *  more than the directory. An empty query lists the first ones. */
export function matchFiles(paths: readonly string[], query: string, max: number): string[] {
  const q = query.trim();
  if (!q) return paths.slice(0, max);
  const scored: { path: string; score: number }[] = [];
  for (const p of paths) {
    const name = basename(p);
    const baseScore = fuzzyScore(q, name);
    const fullScore = fuzzyScore(q, p);
    const best =
      baseScore != null && fullScore != null
        ? Math.max(baseScore + 5, fullScore)
        : baseScore != null
          ? baseScore + 5
          : fullScore;
    if (best != null) scored.push({ path: p, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((s) => s.path);
}

/** Open a workspace file (relative path) in Code. */
export async function openWorkspaceFile(
  workspaceId: string,
  cwd: string,
  relPath: string,
): Promise<void> {
  const fullPath = joinPath(cwd, relPath);
  // UX-8.5: a file Code cannot open as text still opens — as a page.
  if (await openInEditor(workspaceId, fullPath, relPath)) {
    // v1.71.0 (step 5b-1): the editor lives in Code mode.
    openCenterMode(workspaceId, "code");
  }
}

/** Open a text-search match in Code, on its line. */
async function openMatch(workspaceId: string, m: SearchMatch): Promise<void> {
  // Walk of block 6: ⌘G in the file follows the search's own options (Match
  // case off finds "Notes" from "notes"), read before the palette closes.
  const slice = useSearch.getState().byWorkspace[workspaceId];
  const find = slice
    ? {
        search: slice.query.trim(),
        caseSensitive: slice.options.caseSensitive,
        regexp: slice.options.regex,
        wholeWord: slice.options.wholeWord,
      }
    : undefined;
  if (!(await openInEditor(workspaceId, m.path))) return;
  openCenterMode(workspaceId, "code");
  // Two frames, so EditorPanel's swap-document effect has run.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.dispatchEvent(
        new CustomEvent("atelier:goto-line", {
          // QoL 3.4 (E9): the match itself is selected, and ⌘G steps on.
          detail: {
            workspaceId,
            path: m.path,
            line: m.lineNumber,
            ...utf16Columns(m.lineText, m.columnStart, m.columnEnd),
            ...(find?.search ? { find } : {}),
          },
        }),
      );
    });
  });
}

/** The "In files" scope: ripgrep over the workspace, the field's text. */
export function TextResults({
  workspaceId,
  cwd,
  query,
  onClose,
}: {
  workspaceId: string;
  cwd: string;
  query: string;
  onClose: () => void;
}) {
  return (
    <div className="ux-palette-text">
      <SearchPanel
        workspaceId={workspaceId}
        cwd={cwd}
        query={query}
        onOpenMatch={(m) => {
          onClose();
          void openMatch(workspaceId, m);
        }}
      />
    </div>
  );
}

/** The files the Files scope lists for `query`, from the cached index. */
export function useFileMatches(
  workspaceId: string | null,
  cwd: string | null,
  query: string,
  enabled: boolean,
  max = MAX_FILE_RESULTS,
) {
  const files = useFileIndex(workspaceId, cwd, enabled);
  const matches = useMemo(
    () => (files.index ? matchFiles(files.index.paths, query, max) : []),
    [files.index, query, max],
  );
  return { ...files, matches };
}
