import { useCallback, useEffect, useMemo, useState } from "react";
import {
  historySearchCancel,
  historySearchStart,
  onHistoryDone,
  onHistoryResult,
  terminalSessionsHistoryAll,
  type HistoryDoneStatus,
  type HistoryHit,
  type HistoryKind,
} from "../ipc";
import { useWorkspaces } from "../store/workspaceStore";
import { cardHitExcerpt, dispatchHistoryHit, hitLineText, kindLabel, openSessionHit, sessionHits } from "../lib/historyDeepLink";
import { useKanban } from "../store/kanbanStore";
import { sessionHistoryRows, type SessionHistoryRow } from "../lib/terminalConversations";
import { pushToast } from "../store/toastStore";
import { installCommand } from "../lib/platform";
import { Icon, Segmented, type IconName } from "./ux";
import { pushErrorToast } from "../lib/errorToast";
import { joinSentences, searchFailureLine } from "../lib/plainError";

/** GH #285: each kind's caption (sentence case, plural) and its icon. */
const KIND_CAPTION: Record<HistoryKind, string> = {
  card: "Cards",
  intakeTranscript: "Intake conversations",
  swarmMailbox: "Brainstorms",
  runTranscript: "Run transcripts",
  runRecord: "Run records",
  snapshot: "Snapshots",
};
const KIND_ICON: Record<HistoryKind, IconName> = {
  card: "board",
  intakeTranscript: "inbox",
  swarmMailbox: "builder",
  runTranscript: "terminals",
  runRecord: "status",
  snapshot: "history",
};

const SEARCH_DEBOUNCE_MS = 220;

/**
 * v1.25.0 (Cycle G2) cross-artifact history search — UX-3.6: now the History
 * scope of ⌘K (⌘⇧H opens it there). The field is the surface's; this draws
 * the scope toggle and the hits.
 *
 * Searches the Ply config dir for matches in cards, run records and
 * transcripts, snapshot manifests, intake transcripts and swarm mailboxes.
 * Default scope is the current workspace; All adds every workspace plus run
 * records, transcripts and snapshots (not workspace-scoped on disk). Hits
 * stream in over `history://result` and group by kind.
 *
 * GH #285: drawn as ⌘K's own rows — an icon per kind, the matching line,
 * where it is as the quiet hint — under sentence-case captions, with the
 * scope a Segmented control and what it covers as a hint below.
 *
 * QoL 11.3: every hit opens what it points at (`dispatchHistoryHit`), and
 * the Terminals sessions are found too — by their stored short title only,
 * never what was said (Hard rule 1: nothing reads a conversation).
 */
export function HistoryResults({
  query,
  onClose,
}: {
  query: string;
  /** Close ⌘K before jumping to a hit. */
  onClose: () => void;
}) {
  const activeWorkspaceId = useWorkspaces((s) => s.activeId);
  const workspaceName = useWorkspaces(
    (s) => s.workspaces.find((w) => w.id === s.activeId)?.name ?? null,
  );
  const workspaces = useWorkspaces((s) => s.workspaces);

  const [scope, setScope] = useState<"workspace" | "global">(
    activeWorkspaceId ? "workspace" : "global",
  );
  const [hits, setHits] = useState<HistoryHit[]>([]);
  const [status, setStatus] = useState<HistoryDoneStatus | "running" | "idle">(
    "idle",
  );
  const [total, setTotal] = useState(0);
  // QoL 11.3: the Terminals sessions, read once while ⌘K shows History.
  const [sessions, setSessions] = useState<SessionHistoryRow[]>([]);
  // 1.176.2 (E1, S-7): a read that failed is not "no session matched".
  const [sessionsFailed, setSessionsFailed] = useState(false);
  // 1.176.2 (E1, A3-76): the status line says why the search failed — the toast is gone in seconds.
  const [searchWhy, setSearchWhy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const names = Object.fromEntries(useWorkspaces.getState().workspaces.map((w) => [w.id, w.name]));
    terminalSessionsHistoryAll()
      .then((all) => live && setSessions(sessionHistoryRows(all?.sessions ?? [], names, Date.now())))
      .catch(() => live && setSessionsFailed(true));
    return () => {
      live = false;
    };
  }, []);

  // Subscribe to streaming results while shown.
  useEffect(() => {
    let unsubResult: (() => void) | null = null;
    let unsubDone: (() => void) | null = null;
    let cancelled = false;
    onHistoryResult((hit) => {
      setHits((prev) => [...prev, hit]);
    })
      .then((u) => (cancelled ? u() : (unsubResult = u)))
      .catch(() => {});
    onHistoryDone((e) => {
      setStatus(e.status);
      setTotal(e.total);
      if (e.status === "noRipgrep") {
        pushToast({
          kind: "error",
          title: "ripgrep not found",
          body:
            e.message ??
            `Install: ${installCommand("rg")} — history search needs the rg command installed.`,
        });
      }
    })
      .then((u) => (cancelled ? u() : (unsubDone = u)))
      .catch(() => {});
    return () => {
      cancelled = true;
      unsubResult?.();
      unsubDone?.();
      // The rg subprocess goes with the scope.
      historySearchCancel().catch(() => {});
    };
  }, []);

  // Debounced fire on query / scope change.
  const fireSearch = useCallback(() => {
    const q = query.trim();
    setHits([]);
    setTotal(0);
    if (q.length < 2) {
      setStatus("idle");
      historySearchCancel().catch(() => {});
      return;
    }
    if (scope === "workspace" && !activeWorkspaceId) {
      setStatus("idle");
      return;
    }
    setStatus("running");
    historySearchStart(
      q,
      scope === "workspace"
        ? { kind: "workspace", workspaceId: activeWorkspaceId! }
        : { kind: "global" },
    ).catch((err) => {
      setStatus("error");
      setSearchWhy(searchFailureLine(err));
      pushErrorToast("History search failed", err);
    });
  }, [query, scope, activeWorkspaceId]);

  useEffect(() => {
    const id = window.setTimeout(fireSearch, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [fireSearch]);

  const grouped = useMemo(() => groupByKind(hits), [hits]);
  const sessionMatches = useMemo(
    () => sessionHits(sessions, query, scope === "workspace" ? activeWorkspaceId : null),
    [sessions, query, scope, activeWorkspaceId],
  );

  function onSessionClick(row: SessionHistoryRow) {
    onClose();
    setTimeout(() => void openSessionHit(row), 0);
  }

  function onHitClick(hit: HistoryHit) {
    onClose();
    setTimeout(async () => {
      const ok = await dispatchHistoryHit(hit);
      if (!ok) {
        pushToast({
          kind: "warn",
          title: "Can't open that any more",
          body: `That ${kindLabel(hit.kind).toLowerCase()} was cleared, or it's from another computer.`,
        });
      }
    }, 0);
  }

  // A card hit from an older backend names no title: the loaded board's.
  const boards = useKanban((s) => s.byWorkspace);
  const cardTitleOf = (hit: HistoryHit): string | null =>
    hit.cardId && hit.workspaceId
      ? (boards[hit.workspaceId]?.cards.find((c) => c.id === hit.cardId)?.title ?? null)
      : null;

  const nameOf = (id: string | null) =>
    id ? workspaces.find((w) => w.id === id)?.name ?? null : null;
  const q = query.trim();

  const found = total + sessionMatches.length;
  let line: string | null = null;
  if (status === "running") line = "Searching…";
  else if (status === "completed" && found > 0) line = `${found} result${found === 1 ? "" : "s"}`;
  else if (status === "capped") line = `The first ${total} results — narrow the search to see the rest`;
  else if (status === "cancelled") line = "Search stopped";
  else if (status === "error") line = searchWhy ?? "The search failed";
  else if (status === "noRipgrep") line = `History search needs ripgrep (${installCommand("rg")})`;
  else if (status === "idle" && q.length < 2) line = "Type at least two characters.";
  else if (status === "idle" && scope === "workspace" && !activeWorkspaceId) {
    line = "No workspace is open — choose All.";
  }
  if (sessionsFailed) {
    line = joinSentences(line, "Plyloft couldn't read your Terminals sessions, so they weren't searched.");
  }

  return (
    <div className="history-search-body">
      <div className="palette-options">
        <Segmented
          label="Where"
          value={scope}
          onChange={setScope}
          options={[
            ...(activeWorkspaceId
              ? [{ value: "workspace" as const, label: workspaceName ?? "This workspace" }]
              : []),
            { value: "global" as const, label: "All workspaces" },
          ]}
        />
      </div>

      <p className="palette-status" role="status">
        {line}
      </p>

      {hits.length === 0 && sessionMatches.length === 0 ? (
        <div className="palette-empty">
          {status === "completed" && <p className="palette-empty-text">No matches.</p>}
          <p className="palette-empty-hint">
            Searches cards, planning conversations, brainstorms, the Terminals sessions by their title
            {scope === "global"
              ? ", run transcripts and saved work."
              : ". Run transcripts and saved work aren't kept per workspace — choose All workspaces to include them."}
          </p>
        </div>
      ) : (
        <ul className="palette-list" aria-label="History results">
          {sessionMatches.length > 0 && (
            <li className="palette-group">
              <div className="palette-section">Terminals sessions</div>
              <ul className="palette-group-list">
                {sessionMatches.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      className="palette-item palette-item--button"
                      onClick={() => onSessionClick(row)}
                      title={row.running ? "Open session" : "Find it in History › Sessions"}
                    >
                      <span className="palette-item-main">
                        <span className="palette-item-icon">
                          <Icon name="terminals" />
                        </span>
                        <span className="palette-item-label">{row.title}</span>
                      </span>
                      <span className="palette-item-hint">
                        {scope === "global" ? `${row.kindWord} · ${row.workspaceName}` : row.kindWord}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          )}
          {grouped.map((group) => (
            <li key={group.kind} className="palette-group">
              <div className="palette-section">{KIND_CAPTION[group.kind]}</div>
              <ul className="palette-group-list">
                {group.hits.map((hit, i) => {
                  const where = scope === "global" ? nameOf(hit.workspaceId) : null;
                  // Walk: a card hit is the card's title and a plain excerpt
                  // of what matched — never the board file's JSON line.
                  const excerpt = hit.kind === "card" ? cardHitExcerpt(hit.lineText, hit.matchText) : null;
                  const label = excerpt ? (hit.cardTitle ?? cardTitleOf(hit) ?? "A card") : hitLineText(hit.lineText);
                  const hint = [excerpt ? `${excerpt.where}: “${excerpt.text}”` : null, where]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <li key={`${hit.path}:${hit.lineNumber}:${i}`}>
                      <button
                        type="button"
                        className="palette-item palette-item--button"
                        onClick={() => onHitClick(hit)}
                        title={excerpt ? `${label} · ${excerpt.where}` : `${kindLabel(hit.kind)} · line ${hit.lineNumber}`}
                      >
                        <span className="palette-item-main">
                          <span className="palette-item-icon">
                            <Icon name={KIND_ICON[hit.kind]} />
                          </span>
                          <span className="palette-item-label">{label}</span>
                        </span>
                        {hint && <span className="palette-item-hint">{hint}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function groupByKind(
  hits: HistoryHit[],
): Array<{ kind: HistoryKind; hits: HistoryHit[] }> {
  const order: HistoryKind[] = [
    "card",
    "intakeTranscript",
    "swarmMailbox",
    "runTranscript",
    "runRecord",
    "snapshot",
  ];
  const by = new Map<HistoryKind, HistoryHit[]>();
  for (const h of hits) {
    const list = by.get(h.kind);
    if (list) list.push(h);
    else by.set(h.kind, [h]);
  }
  return order
    .map((k) => ({ kind: k, hits: by.get(k) ?? [] }))
    .filter((g) => g.hits.length > 0);
}
