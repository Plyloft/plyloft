import { useEffect, useState } from "react";
import { intakeReadTranscript, type IntakeRecord } from "../ipc";
import { ErrorBlock, Icon } from "./ux";
import { loadFailedError } from "../lib/cardPage";
import { machineWords } from "../lib/platform";

/**
 * v1.19.0 (Cycle E4): renders a card's intake history beneath
 * `RunHistoryAccordion` in `CardDetailPanel`. Each record carries the
 * dispatch_prompt that the intake produced (or null for cancelled),
 * timestamps, applied/cancelled state, and a relative path to the
 * persisted transcript. Transcripts are lazy-loaded via
 * `intakeReadTranscript` only when the user expands a row.
 */
export function IntakeHistorySection({ history }: { history: IntakeRecord[] }) {
  const [open, setOpen] = useState(false);
  if (history.length === 0) return null;
  // Newest first.
  const ordered = [...history].reverse();
  return (
    <section className="intake-history">
      <button
        type="button"
        className="intake-history-head"
        onClick={() => setOpen((o) => !o)}
      >
        <span>Prior intakes ({history.length})</span>
        <span
          className={`intake-history-toggle ux-disclosure-caret${open ? "" : " ux-disclosure-caret--closed"}`}
          aria-hidden="true"
        >
          <Icon name="expand" size="sm" />
        </span>
      </button>
      {open && (
        <ul className="intake-history-list">
          {ordered.map((r, idx) => (
            <IntakeHistoryRow
              key={r.intakeId}
              record={r}
              ordinal={history.length - idx}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function IntakeHistoryRow({
  record,
  ordinal,
}: {
  record: IntakeRecord;
  ordinal: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [transcript, setTranscript] = useState<string | null | undefined>(
    undefined,
  );
  // The read's raw error, shown only in the error block's Details.
  const [transcriptError, setTranscriptErrorDetails] = useState<string | null>(null);

  function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && transcript === undefined && record.transcriptPath) {
      setTranscriptErrorDetails(null);
      void intakeReadTranscript(record.transcriptPath)
        .then((text) => setTranscript(text))
        .catch((e) => setTranscriptErrorDetails(String(e)));
    }
  }

  const stateLabel = record.applied ? "applied" : "cancelled";
  const promptPreview = record.dispatchPrompt
    ? record.dispatchPrompt.length > 80
      ? `${record.dispatchPrompt.slice(0, 80)}…`
      : record.dispatchPrompt
    : "(no dispatch prompt — cancelled)";
  return (
    <li className={`intake-history-entry intake-history-${stateLabel}`}>
      <button
        type="button"
        className="intake-history-row"
        onClick={toggle}
      >
        <span className="intake-history-ord">#{ordinal}</span>
        <span className="intake-history-state">{stateLabel}</span>
        <span className="intake-history-time">
          {formatRelative(record.startedAt)}
        </span>
        <span className="intake-history-preview">{promptPreview}</span>
        <span
          className={`intake-history-toggle ux-disclosure-caret${expanded ? "" : " ux-disclosure-caret--closed"}`}
          aria-hidden="true"
        >
          <Icon name="expand" size="sm" />
        </span>
      </button>
      {expanded && (
        <div className="intake-history-detail">
          {record.dispatchPrompt && (
            <div className="intake-history-prompt">
              <header>Dispatch prompt</header>
              <pre>{record.dispatchPrompt}</pre>
            </div>
          )}
          {record.transcriptPath ? (
            <div className="intake-history-transcript">
              <header>Transcript</header>
              {transcriptError && (
                <ErrorBlock error={loadFailedError("The transcript", transcriptError)} density="dense" />
              )}
              {!transcriptError && transcript === undefined && (
                <div className="intake-history-muted">Loading…</div>
              )}
              {!transcriptError && transcript === null && (
                <div className="intake-history-muted">
                  Transcript file no longer on disk (likely FIFO-evicted).
                </div>
              )}
              {!transcriptError && typeof transcript === "string" && (
                <pre>{transcript}</pre>
              )}
            </div>
          ) : (
            <div className="intake-history-muted">
              Nothing was kept of this planning conversation.
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function formatRelative(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

/**
 * C6 (UX-6.4, 6.5): one past intake as something to read — the plan it wrote
 * and the conversation as plain text. The transcript is written when the
 * intake ends (ANSI already stripped), so only a finished intake has one; a
 * live conversation is the terminal itself, behind "Open the conversation".
 */
export function IntakePlan({ record }: { record: IntakeRecord }) {
  const [transcript, setTranscript] = useState<string | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const path = record.transcriptPath ?? null;
  useEffect(() => {
    if (!path) return;
    let live = true;
    setTranscript(undefined);
    setFailed(false);
    intakeReadTranscript(path)
      .then((text) => live && setTranscript(text))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [path]);
  return (
    <div className="ux-card-plan">
      {record.dispatchPrompt ? (
        <>
          <h3 className="ux-card-subheading">The plan</h3>
          <p className="ux-card-plain">{record.dispatchPrompt}</p>
        </>
      ) : (
        <p className="ux-card-muted">This conversation was cancelled; it left no plan.</p>
      )}
      <h3 className="ux-card-subheading">The conversation</h3>
      {!path ? (
        <p className="ux-card-muted">No transcript was kept for this conversation.</p>
      ) : failed ? (
        <p className="ux-card-muted">The transcript couldn't be read.</p>
      ) : transcript === undefined ? (
        <p className="ux-card-muted">Loading…</p>
      ) : transcript === null ? (
        <p className="ux-card-muted">{machineWords("The transcript is no longer on this Mac.")}</p>
      ) : (
        <p className="ux-card-plain ux-card-transcript">{transcript}</p>
      )}
    </div>
  );
}
