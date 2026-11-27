import { useEffect, useRef, useState } from "react";
import {
  onSearchDone,
  onSearchResult,
  ripgrepAvailable,
  searchCancel,
  searchStart,
} from "../ipc";
import { useSearch, type SearchMatch } from "../store/searchStore";
import { CBtn, Icon, TextField } from "./ux";
import { relativeTo } from "../lib/paths";
import { installCommand } from "../lib/platform";
import { searchFailureLine } from "../lib/plainError";

/** GH #285: the search options in words, as small toggles. */
const OPTIONS = [
  ["caseSensitive", "Match case"],
  ["wholeWord", "Whole word"],
  ["regex", "Regular expression"],
  ["includeHidden", "Hidden files"],
] as const;

const EMPTY_MATCHES: SearchMatch[] = [];

/** The matches by file — files in path order, each file's matches by line
 *  and column. Walk of block 6: ripgrep searches files in parallel, so the
 *  order they arrived in changed between two identical searches. */
export function filesOf(results: readonly SearchMatch[]): Map<string, SearchMatch[]> {
  const byFile = new Map<string, SearchMatch[]>();
  for (const m of results) {
    const arr = byFile.get(m.path) ?? [];
    arr.push(m);
    byFile.set(m.path, arr);
  }
  const paths = [...byFile.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return new Map(
    paths.map((p) => [
      p,
      [...byFile.get(p)!].sort((a, b) => a.lineNumber - b.lineNumber || a.columnStart - b.columnStart),
    ]),
  );
}

/** The matches in the order the panel draws them. */
function groupByFile(results: readonly SearchMatch[]): SearchMatch[] {
  return [...filesOf(results).values()].flat();
}

type Props = {
  workspaceId: string;
  cwd: string;
  onOpenMatch: (match: SearchMatch) => void;
  /** UX-3.6: inside ⌘K the query comes from the surface's one field, and the
   *  panel draws no field of its own. */
  query?: string;
};

export function SearchPanel({ workspaceId, cwd, onOpenMatch, query }: Props) {
  const slice = useSearch((s) => s.byWorkspace[workspaceId]);
  const setQuery = useSearch((s) => s.setQuery);
  const setOptions = useSearch((s) => s.setOptions);
  const startStore = useSearch((s) => s.start);
  const appendMatch = useSearch((s) => s.appendMatch);
  const finish = useSearch((s) => s.finish);

  const [hasRipgrep, setHasRipgrep] = useState<boolean | null>(null);
  /** QoL 3.4 (E9): the match ↑ ↓ point at and Enter opens, inside ⌘K. */
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    ripgrepAvailable().then(setHasRipgrep).catch(() => setHasRipgrep(false));
  }, []);

  // UX-3.6: ⌘K's field drives the query.
  useEffect(() => {
    if (query !== undefined) setQuery(workspaceId, query);
  }, [query, workspaceId, setQuery]);

  // Subscribe once
  useEffect(() => {
    let unR: (() => void) | null = null;
    let unD: (() => void) | null = null;
    let cancelled = false;
    onSearchResult(appendMatch)
      .then((u) => {
        if (cancelled) u();
        else unR = u;
      })
      .catch(() => {});
    onSearchDone((e) => {
      const status =
        e.status === "completed"
          ? "done"
          : e.status === "cancelled"
            ? "cancelled"
            : e.status === "capped"
              ? "capped"
              : e.status === "noRipgrep"
                ? "noRipgrep"
                : "error";
      finish(e.workspaceId, status, e.message ?? undefined);
    })
      .then((u) => {
        if (cancelled) u();
        else unD = u;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (unR) unR();
      if (unD) unD();
    };
  }, [appendMatch, finish]);

  // Debounced launch when query/options change
  const queryDeps = JSON.stringify({
    q: slice?.query,
    o: slice?.options,
  });
  useEffect(() => {
    if (!slice) return;
    const q = slice.query.trim();
    if (q.length < 2) {
      if (slice.status === "running") {
        searchCancel(workspaceId).catch(() => {});
        finish(workspaceId, "idle", undefined);
      }
      return;
    }
    const handle = window.setTimeout(() => {
      startStore(workspaceId);
      searchStart(workspaceId, cwd, q, {
        caseSensitive: slice.options.caseSensitive,
        wholeWord: slice.options.wholeWord,
        regex: slice.options.regex,
        includeHidden: slice.options.includeHidden,
        glob: slice.options.glob || undefined,
      }).catch((e) =>
        finish(workspaceId, "error", String(e)),
      );
    }, 200);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryDeps, workspaceId, cwd]);

  // QoL 3.4 (E9): inside ⌘K, ↑ ↓ move through the matches from the search
  // field and Enter opens the one pointed at — no Tab through the options.
  // Capture, as the palette's own keys are; the glob field keeps its keys.
  // In the order they are drawn: grouped by file, the first file first.
  const ordered = groupByFile(slice?.results ?? EMPTY_MATCHES);
  const resultsRef = useRef(ordered);
  resultsRef.current = ordered;
  const activeRef = useRef(active);
  activeRef.current = active;
  const openRef = useRef(onOpenMatch);
  openRef.current = onOpenMatch;
  useEffect(() => setActive(0), [queryDeps]);
  useEffect(() => {
    if (query === undefined) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      // Challenger D3: only from the search field (or nothing focused) — Enter
      // on an option button or a match row is that button's own press.
      const at = document.activeElement;
      const fromField = at instanceof HTMLInputElement && at.classList.contains("palette-input");
      if (!fromField && at !== null && at !== document.body) return;
      const list = resultsRef.current;
      if (list.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Enter") {
        const m = list[Math.min(activeRef.current, list.length - 1)];
        if (m) openRef.current(m);
        return;
      }
      const by = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => Math.max(0, Math.min(list.length - 1, a + by)));
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(".palette-item.active")
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  if (hasRipgrep === false) {
    return (
      <div className="search-panel">
        <div className="palette-empty">
          <p className="palette-empty-text">Searching in files needs ripgrep.</p>
          <p className="palette-empty-hint">{`Install it with ${installCommand("rg")}, then search again.`}</p>
        </div>
      </div>
    );
  }

  const opts = slice?.options ?? {
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    includeHidden: false,
    glob: "",
  };
  const results = slice?.results ?? [];
  const status = slice?.status ?? "idle";

  const byFile = filesOf(results);
  const activeMatch = query !== undefined ? ordered[active] : undefined;

  let line: string | null = null;
  if (status === "running") line = `Searching… ${results.length}`;
  else if (status === "done") {
    line =
      results.length === 0
        ? "No matches"
        : `${results.length} match${results.length === 1 ? "" : "es"} in ${byFile.size} file${byFile.size === 1 ? "" : "s"}`;
  } else if (status === "capped") line = `The first ${results.length} matches — narrow the search to see the rest`;
  else if (status === "error") line = searchFailureLine(slice?.message);

  // GH #285: ⌘K's own look — the options as small toggles in words, the
  // glob a plain field, each file a caption and each match a row.
  return (
    <div className="search-panel">
      {query === undefined && (
        <div className="palette-options">
          <TextField
            value={slice?.query ?? ""}
            onChange={(v) => setQuery(workspaceId, v)}
            label="Search in workspace"
            placeholder="Search in workspace…"
            wide
          />
        </div>
      )}
      <div className="palette-options" role="group" aria-label="Search options">
        {OPTIONS.map(([key, label]) => (
          <CBtn
            key={key}
            size="sm"
            active={opts[key]}
            aria-pressed={opts[key]}
            onClick={() => setOptions(workspaceId, { [key]: !opts[key] })}
          >
            {label}
          </CBtn>
        ))}
        <TextField
          value={opts.glob}
          onChange={(v) => setOptions(workspaceId, { glob: v })}
          label="Only in files matching"
          placeholder="Only in files matching, e.g. *.ts"
        />
      </div>
      <p className={status === "error" || status === "capped" ? "palette-status palette-status--warn" : "palette-status"} role="status">
        {line}
      </p>
      <ul className="palette-list" aria-label="Matches" ref={listRef}>
        {[...byFile.entries()].map(([path, matches]) => (
          <li key={path} className="palette-group">
            <div className="palette-section palette-section--file" title={path}>
              <span className="palette-section-path">{relativeTo(path, cwd) ?? path}</span>
              <span>{matches.length}</span>
            </div>
            <ul className="palette-group-list">
              {matches.map((m, i) => (
                <li key={i}>
                  <button
                    type="button"
                    className={`palette-item palette-item--button${m === activeMatch ? " active" : ""}`}
                    aria-current={m === activeMatch ? "true" : undefined}
                    onClick={() => onOpenMatch(m)}
                    title={`${m.path}, line ${m.lineNumber}`}
                  >
                    <span className="palette-item-main">
                      <span className="palette-item-icon">
                        <Icon name="code" />
                      </span>
                      <span className="palette-item-label is-path">{m.lineText.trim()}</span>
                    </span>
                    <span className="palette-item-hint">Line {m.lineNumber}</span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
