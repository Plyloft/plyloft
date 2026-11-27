import { useCallback, useEffect, useMemo, useState } from "react";
import { activityFeed, onKanbanChanged, type ActivityFeed, type ActivityRow, type ShellEnvInfo } from "../ipc";
import { historyResult, typicalRun } from "../lib/historyWords";
import {
  HISTORY_TABS,
  agentRunWords,
  builderWords,
  checksWords,
  countWords,
  filterHistoryRows,
  historyNumbers,
  historyTabOf,
  rowOpens,
  shippedWords,
  tabCountWords,
  tabCut,
  withPendingDeletes,
  type HistoryTab,
} from "../lib/historyView";
import { stripMarkdownInline } from "../lib/stripMarkdown";
import { inboxWhen } from "../lib/inboxView";
import { usePageVisible } from "../hooks/usePageVisible";
import { useWorkspaces } from "../store/workspaceStore";
import { useUi } from "../store/uiStore";
import { useBoard } from "../store/boardStore";
import { ModeHeader } from "./ModeHeader";
import { HistorySessions } from "./HistorySessions";
import {
  ListView,
  MoreMenu,
  Page,
  Properties,
  SearchField,
  Segmented,
  Select,
  StateWord,
  type ListColumn,
  type Property,
} from "./ux";

/**
 * UX-4.5 (C4): History — the sidebar's History entry, a page on the one
 * scale. What ran and shipped across every workspace over the last four
 * weeks, newest first.
 *
 * QoL 11.1 (F8): in tabs — Runs (agent runs, swarms and Builder rounds),
 * Ships, Checks, Sessions (Terminals block P5, `HistorySessions`),
 * Discussions, and Cleanup while it has rows — with a workspace and a text
 * filter over all of them. A card is one row per kind (the feed folds its
 * ships, its checks and its Builder rounds); every number above the list
 * and on the tabs is counted from the rows under the same filter, so they
 * agree with what is listed.
 *
 * QoL 11.2 (owner D9): a cost only when one was billed per use — otherwise
 * no Cost column and no Spent.
 *
 * The centre mode keeps its id, `activity`; everything the person reads
 * says History.
 */

const POLL_MS = 60_000;
/** A burst of board changes reads History once. */
const KANBAN_DEBOUNCE_MS = 500;
const ALL = "__all__";

/** What each tab says when it has nothing (under the filter, or at all). */
function emptyWords(tab: HistoryTab, days: number, filtered: boolean): string {
  if (filtered) return "Nothing here matches the filter.";
  switch (tab) {
    case "runs":
      return `No run in the last ${days} days. A card's Builder rounds and the runs started from the Board land here.`;
    case "ships":
      return `Nothing shipped in the last ${days} days. A card you ship lands here.`;
    case "checks":
      return `No checks ran in the last ${days} days. A card's checks land here when it's built.`;
    case "discussions":
      return `No discussion in the last ${days} days.`;
    default:
      return `Nothing in the last ${days} days.`;
  }
}

export function ActivityView({ env }: { env?: ShellEnvInfo | null } = {}) {
  const [feed, setFeed] = useState<ActivityFeed | null>(null);
  // Sessions reloads with the page (its poll and Refresh).
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [sessionCount, setSessionCount] = useState<number | null>(null);
  const visible = usePageVisible();
  const view = useUi((s) => s.historyView);
  const setView = useUi((s) => s.setHistoryView);
  const workspaces = useWorkspaces((s) => s.workspaces);
  // A workspace that's gone leaves the filter rather than hiding everything.
  const wsFilter =
    view.workspaceId != null && workspaces.some((w) => w.id === view.workspaceId) ? view.workspaceId : null;
  const wsName = wsFilter ? (workspaces.find((w) => w.id === wsFilter)?.name ?? null) : null;

  // Challenger 2: the workspace filter is the backend's, so the row cap
  // applies inside the workspace, not across every one.
  const load = useCallback(() => {
    setBusy(true);
    setReloadKey((k) => k + 1);
    activityFeed(wsFilter)
      .then(setFeed)
      .catch(() => {})
      .finally(() => setBusy(false));
  }, [wsFilter]);

  useEffect(() => {
    load();
  }, [load]);

  // Visible-gated slow poll — a history page, not a live monitor.
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [visible, load]);

  // 1.168.1 (A4 walk): a board that changes while History is on screen — a
  // card deleted, a round finished — reads again, once per burst, so a
  // deleted card's rows say "· card deleted" without leaving the page.
  useEffect(() => {
    if (!visible) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unlisten: (() => void) | null = null;
    let gone = false;
    void onKanbanChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, KANBAN_DEBOUNCE_MS);
    }).then((u) => {
      if (gone) u();
      else unlisten = u;
    });
    return () => {
      gone = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, [visible, load]);

  const now = feed?.generatedAt ?? Date.now();
  const days = feed?.windowDays ?? 28;
  const filter = useMemo(() => ({ workspaceId: wsFilter, text: view.text }), [wsFilter, view.text]);
  const textFiltered = view.text.trim() !== "";
  const filtered = wsFilter != null || textFiltered;

  // A card deleted here reads deleted at once, before its delete has run.
  const pendingRemoval = useBoard((s) => s.pendingRemoval);
  const rows = useMemo(() => withPendingDeletes(feed?.rows ?? [], pendingRemoval), [feed, pendingRemoval]);
  const sent = useMemo(() => historyNumbers(rows), [rows]);
  const shown = useMemo(() => filterHistoryRows(rows, filter), [rows, filter]);
  const numbers = useMemo(() => historyNumbers(shown), [shown]);
  const tabRows = useMemo(
    () => (view.tab === "sessions" ? [] : shown.filter((r) => historyTabOf(r.kind) === view.tab)),
    [shown, view.tab],
  );
  const hasCleanup = (feed?.rows ?? []).some((r) => historyTabOf(r.kind) === "cleanup");
  const tabs = HISTORY_TABS.filter((t) => t.id !== "cleanup" || hasCleanup || view.tab === "cleanup");
  const tabCount = (t: HistoryTab): string | null => {
    if (t === "sessions") return sessionCount != null ? String(sessionCount) : null;
    if (!feed) return null;
    return tabCountWords(numbers.perTab[t], sent.perTab[t], feed.tabTotals?.[t], textFiltered);
  };
  const cutHere =
    view.tab !== "sessions" && feed != null && tabCut(sent.perTab[view.tab], feed.tabTotals?.[view.tab]);

  // QoL 11.2 (D9): no Spent, no cost — Plyloft can't know what was billed.
  const facts: Property[] = feed
    ? [
        // 1.174.0 (TX1, T5; WALK 14): the Builder's cards and rounds first,
        // then the other runs: the cards and the runs add up to the Runs tab.
        ...(numbers.builderCards > 0 ? [{ label: "Builder", value: builderWords(numbers) }] : []),
        { label: "Other AI runs", value: agentRunWords(numbers) },
        { label: "Checks", value: checksWords(numbers) },
        { label: "Shipped", value: shippedWords(numbers) },
        ...(!textFiltered && feed.stats.medianRunSecs != null
          ? [{ label: "Typical agent run", value: typicalRun(feed.stats.medianRunSecs) }]
          : []),
      ]
    : [];

  const columns: ListColumn<ActivityRow>[] = [
    {
      key: "title",
      label: "Title",
      primary: true,
      // 1.168.1 (A4, owner 2026-10-22): a deleted card's runs and checks
      // stay, marked; the row opens nothing (its card is gone).
      cell: (r) =>
        r.cardDeleted ? (
          <>
            {stripMarkdownInline(r.title)} <span className="ux-card-muted-inline">· card deleted</span>
          </>
        ) : (
          stripMarkdownInline(r.title)
        ),
    },
    {
      key: "workspace",
      label: "Workspace",
      width: "md",
      tooltip: (r) => r.workspaceName,
      cell: (r) => r.workspaceName,
    },
    {
      key: "result",
      label: "Result",
      width: "md",
      tooltip: (r) => r.detail || undefined,
      cell: (r) => {
        const res = historyResult(r.state);
        const more = countWords(r);
        return (
          <StateWord state={res.state} live={res.state === "running"}>
            {more ? `${res.word} · ${more}` : res.word}
          </StateWord>
        );
      },
    },
    { key: "when", label: "When", width: "xs", cell: (r) => inboxWhen(r.at, now) },
  ];

  const openRow = (r: ActivityRow) => {
    const opens = rowOpens(r);
    if (opens === "card" && r.cardId != null) {
      const ws = useWorkspaces.getState();
      if (ws.activeId !== r.workspaceId) void ws.setActive(r.workspaceId);
      useUi.getState().selectCard(r.workspaceId, r.cardId, true);
    } else if (opens === "run" && r.runId != null) {
      // QoL 11.3: a standalone run opens its output.
      useUi.getState().openHistorySheet({ kind: "run", workspaceId: r.workspaceId, runId: r.runId });
    }
  };

  const workspaceOptions = [
    { value: ALL, label: "All workspaces" },
    ...workspaces.map((w) => ({ value: w.id, label: w.name })),
  ];

  return (
    <div className="ux-history">
      <ModeHeader
        mode="activity"
        actions={
          <MoreMenu
            label="More for History"
            items={[
              {
                label: busy ? "Refreshing…" : "Refresh",
                disabled: busy,
                onSelect: () => void load(),
              },
            ]}
          />
        }
      />
      <Page wide>
        <p className="ux-inbox-lede">
          What ran and shipped {wsName ? `in ${wsName}` : "in every workspace"} over the last {days} days.
          {cutHere &&
            ` This tab lists the latest ${sent.perTab[view.tab as Exclude<HistoryTab, "sessions">]} of ${
              feed?.tabTotals?.[view.tab]
            }, and the numbers count those.`}
        </p>
        <div className="ux-history-filters">
          <Select
            label="Workspace"
            value={wsFilter ?? ALL}
            onChange={(v) => setView({ workspaceId: v === ALL ? null : v })}
            options={workspaceOptions}
          />
          <SearchField
            label="Filter History"
            placeholder="Filter"
            value={view.text}
            onChange={(text) => setView({ text })}
          />
        </div>
        {facts.length > 0 && (
          <div className="ux-history-facts">
            <Properties items={facts} />
          </div>
        )}
        <div className="ux-history-tabs">
          <Segmented<HistoryTab>
            label="Show"
            value={view.tab}
            onChange={(tab) => setView({ tab })}
            options={tabs.map((t) => {
              const n = tabCount(t.id);
              return { value: t.id, label: n != null ? `${t.label} ${n}` : t.label };
            })}
          />
        </div>
        <div>
          {/* Sessions stays mounted (its count is the tab's) and renders
              nothing on the other tabs — not even for assistive tech. */}
          <HistorySessions
            env={env}
            reloadKey={reloadKey}
            filter={filter}
            onCount={setSessionCount}
            active={view.tab === "sessions"}
          />
          {view.tab !== "sessions" && feed && (
            <div className="ux-history-list">
              <ListView<ActivityRow>
                label={HISTORY_TABS.find((t) => t.id === view.tab)?.label ?? "History"}
                columns={columns}
                groups={[{ key: "all", label: "", rows: tabRows }]}
                onOpen={openRow}
                canOpen={(r) => rowOpens(r) != null}
                empty={emptyWords(view.tab, days, filtered)}
              />
            </div>
          )}
        </div>
      </Page>
    </div>
  );
}
