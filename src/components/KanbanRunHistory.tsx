import { useEffect, useState } from "react";
import { ErrorBlock, Icon, Toggle } from "./ux";
import { loadFailedError } from "../lib/cardPage";
import { swarmGet } from "../ipc";
import { RunChangesPanel } from "./RunChangesPanel";
import type { RunHistoryEntry } from "../store/kanbanStore";

/**
 * v1.5.x: read-only collapsed accordion for the system-managed
 * RunHistory FIFO. Each entry shows a status icon, relative timestamp,
 * file-change counts, optional collision badge, and (for swarm
 * aggregations) a leg-count chip.
 *
 * v1.7.0: extracted from `KanbanBoard.tsx` so the new card-detail panel
 * can reuse it without duplicating ~80 LOC.
 *
 * v1.16.0 (Cycle E2): expanded rows now render inline diffs instead of
 * a "View changes" toast. Oneshot/sequential entries surface a single
 * `RunChangesPanel`; coordinator aggregates (legs > 1) lazy-fetch the
 * swarm record once per expand and render one panel per leg run_id.
 */
export function RunHistoryAccordion({
  entries,
  onClear,
  recording,
  onRecording,
}: {
  entries: RunHistoryEntry[];
  onClear: () => void;
  /** 1.172.0 D1 (CP-4): whether the card's runs are recorded — the switch
   *  sits here, beside the runs, no longer in the card's ⋯. Left out, no
   *  switch is drawn. */
  recording?: boolean;
  onRecording?: (on: boolean) => void;
}) {
  return (
    <div className="kanban-card-history" data-ply-run-history="">
      <div className="kanban-card-history-header">
        Run history ({entries.length})
      </div>
      {entries.length > 0 ? (
        <div className="kanban-card-history-list">
          {entries.map((entry) => (
            <RunHistoryRow key={entry.runId} entry={entry} />
          ))}
        </div>
      ) : (
        <p className="ux-card-muted">
          {recording === false ? "This card's runs aren't recorded." : "No runs recorded yet."}
        </p>
      )}
      <div className="kanban-card-history-footer">
        {recording !== undefined && onRecording && (
          <label className="kanban-card-history-record">
            <Toggle checked={recording} onChange={onRecording} label={RECORD_RUNS_LABEL} />
            <span aria-hidden="true">{RECORD_RUNS_LABEL}</span>
          </label>
        )}
        {entries.length > 0 && (
          <button
            type="button"
            className="kanban-card-btn"
            onClick={onClear}
          >
            Clear history…
          </button>
        )}
      </div>
    </div>
  );
}

/** The switch's name: on, each run of the card is listed here. */
export const RECORD_RUNS_LABEL = "Record this card's runs";

function RunHistoryRow({ entry }: { entry: RunHistoryEntry }) {
  const [expanded, setExpanded] = useState(false);
  const icon =
    entry.status === "done" ? "✓" :
    entry.status === "killed" ? "⏱" : "✗";
  const legs = entry.legs ?? 1;
  return (
    <div className={`kanban-history-entry kanban-history-entry-${entry.status}`}>
      <button
        type="button"
        className="kanban-history-row"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="kanban-history-icon" title={entry.status}>
          {icon}
        </span>
        <span className="kanban-history-time">
          {formatRelativeTime(entry.endedAt)}
        </span>
        <span className="kanban-history-counts">
          {entry.filesChangedCount}{" "}
          file{entry.filesChangedCount === 1 ? "" : "s"}
        </span>
        {entry.swarmCollisions > 0 && (
          <span
            className="kanban-history-collision"
            title={`${entry.swarmCollisions} out-of-glob write(s)`}
          >
            {/* ADR 0007 §2: the map's warning icon, never the ⚠ glyph. */}
            <Icon name="warning" size="sm" /> {entry.swarmCollisions}
          </span>
        )}
        {legs > 1 && (
          <span className="kanban-history-legs" title="Every step of the multi-AI run">
            {legs} legs
          </span>
        )}
      </button>
      {expanded && (
        <div className="kanban-history-detail">
          {entry.topPaths.length > 0 && (
            <ul className="kanban-history-paths">
              {entry.topPaths.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <RunHistoryDiff entry={entry} />
        </div>
      )}
    </div>
  );
}

/**
 * v1.16.0 (Cycle E2): inline diff view for an expanded RunHistory entry.
 * Oneshot/sequential entries (legs == 1 OR no swarmId) render a single
 * `RunChangesPanel` against the entry's runId. Coordinator aggregates
 * (legs > 1) lazily fetch the swarm record once via `swarmGet` to learn
 * the per-leg run_ids, then render one panel per leg.
 */
function RunHistoryDiff({ entry }: { entry: RunHistoryEntry }) {
  const legs = entry.legs ?? 1;
  const isAggregate = legs > 1 && Boolean(entry.swarmId);

  const [legRunIds, setLegRunIds] = useState<string[] | null>(null);
  // The read's raw error: shown only in the error block's Details.
  const [legError, setLegErrorDetails] = useState<string | null>(null);

  useEffect(() => {
    if (!isAggregate) return;
    let cancelled = false;
    setLegErrorDetails(null);
    void swarmGet(entry.swarmId as string)
      .then((swarm) => {
        if (cancelled) return;
        if (!swarm) {
          setLegErrorDetails("Swarm record not found.");
          return;
        }
        setLegRunIds(swarm.runIds);
      })
      .catch((e) => {
        if (!cancelled) setLegErrorDetails(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [isAggregate, entry.swarmId]);

  if (!isAggregate) {
    return <RunChangesPanel runId={entry.runId} />;
  }

  if (legError) {
    return <ErrorBlock error={loadFailedError("The run's legs", legError)} density="dense" />;
  }
  if (legRunIds === null) {
    return <div className="run-changes-empty">Loading the run's steps…</div>;
  }
  if (legRunIds.length === 0) {
    return (
      <div className="run-changes-empty">
        This run kept no record of its steps.
      </div>
    );
  }

  return (
    <div className="kanban-history-legs-list">
      {legRunIds.map((legRunId, idx) => (
        <section key={legRunId} className="kanban-history-leg">
          <header className="kanban-history-leg-head">
            Leg {idx + 1}/{legRunIds.length} ·{" "}
            <code>{legRunId.slice(0, 8)}</code>
          </header>
          <RunChangesPanel runId={legRunId} />
        </section>
      ))}
    </div>
  );
}

export function formatRelativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}
