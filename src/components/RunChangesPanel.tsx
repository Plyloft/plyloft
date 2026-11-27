import { useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { MergeView } from "@codemirror/merge";
import { FailureText, Icon } from "./ux";
import { failure, type Failure } from "../lib/failure";
import { snapshotGetChanges, type ChangesManifest, type FileChange } from "../ipc";
import { useColorScheme } from "../hooks/useColorScheme";

type Props = {
  runId: string;
  /** v0.9.0 F1: optional refresh trigger — bump this when the run finishes
   *  so the panel re-fetches and finds the just-written changes.json. */
  refreshKey?: unknown;
};

export function RunChangesPanel({ runId, refreshKey }: Props) {
  const [manifest, setManifest] = useState<ChangesManifest | null | undefined>(
    undefined,
  );
  const [error, setError] = useState<Failure | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    snapshotGetChanges(runId)
      .then((m) => {
        if (!cancelled) setManifest(m);
      })
      .catch((e) => {
        if (!cancelled) setError(failure("Plyloft couldn't load this run's changes.", e));
      });
    return () => {
      cancelled = true;
    };
  }, [runId, refreshKey]);

  if (error) {
    return (
      <div className="run-changes-empty">
        <FailureText failure={error} />
      </div>
    );
  }
  if (manifest === undefined) {
    return <div className="run-changes-empty">Loading changes…</div>;
  }
  if (manifest === null) {
    return (
      <div className="run-changes-empty">
        No copy of the files was saved for this run, so there are no changes to show.
      </div>
    );
  }
  if (manifest.changes.length === 0) {
    return (
      <div className="run-changes-empty">
        No file changes detected{manifest.truncated ? " (only part of the run's files were saved)" : ""}.
      </div>
    );
  }

  const counts = {
    added: manifest.changes.filter((c) => c.kind === "added").length,
    modified: manifest.changes.filter((c) => c.kind === "modified").length,
    removed: manifest.changes.filter((c) => c.kind === "removed").length,
  };

  return (
    <div className="run-changes-panel">
      <div className="run-changes-summary">
        {/* CL-11 (walks): files by kind in words — "+0 · ~1 · -0" read as
            lines. This manifest has no line counts. */}
        {manifest.changes.length} file{manifest.changes.length === 1 ? "" : "s"} changed:{" "}
        {[
          `${counts.added} new`,
          `${counts.modified} edited`,
          `${counts.removed} removed`,
        ].join(", ")}
        {manifest.truncated && (
          <span className="run-changes-trunc"> (truncated)</span>
        )}
      </div>
      <ul className="run-changes-list">
        {manifest.changes.map((c) => (
          <ChangeRow key={c.path} change={c} />
        ))}
      </ul>
    </div>
  );
}

function ChangeRow({ change }: { change: FileChange }) {
  const [open, setOpen] = useState(false);
  const kindBadge =
    change.kind === "added" ? "A" : change.kind === "modified" ? "M" : "D";
  return (
    <li className="run-changes-row">
      <button
        type="button"
        className="run-changes-row-head"
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`run-changes-kind kind-${change.kind}`}>
          {kindBadge}
        </span>
        <span className="run-changes-path">{change.path}</span>
        <span
          className={`run-changes-toggle ux-disclosure-caret${open ? "" : " ux-disclosure-caret--closed"}`}
          aria-hidden="true"
        >
          <Icon name="expand" size="sm" />
        </span>
      </button>
      {open && <DiffView change={change} />}
    </li>
  );
}

function DiffView({ change }: { change: FileChange }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const theme = useColorScheme();

  useEffect(() => {
    if (!containerRef.current) return;
    const isDark = theme === "dark" || theme === "void";
    const baseExtensions = [
      lineNumbers(),
      EditorView.editable.of(false),
      EditorView.theme(
        {
          "&": { fontSize: "12px", maxHeight: "400px" },
          ".cm-scroller": { fontFamily: '"SF Mono", Menlo, "Cascadia Mono", Consolas, monospace' },
        },
        { dark: isDark },
      ),
    ];

    if (change.kind === "modified" && change.before != null && change.after != null) {
      const view = new MergeView({
        a: { doc: change.before, extensions: baseExtensions },
        b: { doc: change.after, extensions: baseExtensions },
        parent: containerRef.current,
        revertControls: undefined,
      });
      return () => view.destroy();
    }

    // Added / Removed: render the single side that exists.
    const doc = change.after ?? change.before ?? "";
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: baseExtensions,
      }),
      parent: containerRef.current,
    });
    return () => view.destroy();
  }, [change, theme]);

  return <div ref={containerRef} className="run-changes-diff" />;
}
