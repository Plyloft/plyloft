import { useMemo, useState } from "react";
import { Icon } from "./ux";

import { describeDiff, parseUnifiedDiff } from "../lib/unifiedDiff";

type Props = {
  /** The turn's aggregated unified diff, from `turn/diff/updated`. */
  diff: string;
  /**
   * GH #211: the turn is over and a shell command ran in it. The diff above
   * only carries `apply_patch` edits, so an empty one then does not mean
   * nothing changed.
   */
  ranCommands?: boolean;
};

/**
 * GH #211: the bar's empty state after a turn that ran commands. One line,
 * no action: it says what the empty bar does not mean and where to look —
 * Code, the centre mode that shows the files as they are on disk.
 */
export const SHELL_CHANGES_HINT =
  "Files changed by shell commands don't show here — check them in Code.";

/**
 * v1.103.0 (D5): the turn's changes, one row above the composer.
 *
 * A grid tile is ~400px tall, so the diff cannot hold a permanent share of
 * it. Collapsed, this costs a single line and still announces that something
 * changed while the reader is in the transcript; expanded, it takes a bounded
 * scrollable slice. Tabs were the alternative and would hide the
 * conversation while the diff is read.
 */
export function CodexChanges({ diff, ranCommands = false }: Props) {
  const [open, setOpen] = useState(false);
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);

  const totals = useMemo(
    () =>
      files.reduce(
        (acc, file) => ({
          added: acc.added + file.added,
          removed: acc.removed + file.removed,
        }),
        { added: 0, removed: 0 },
      ),
    [files],
  );

  if (files.length === 0) {
    return ranCommands ? (
      <div className="codex-changes codex-changes-hint" role="note">
        {SHELL_CHANGES_HINT}
      </div>
    ) : null;
  }

  return (
    <div className="codex-changes">
      <button
        type="button"
        className="codex-changes-bar"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title={
          open ? "Hide this turn's changes" : "Show this turn's changes"
        }
      >
        <span
          className={`codex-changes-caret ux-disclosure-caret${open ? "" : " ux-disclosure-caret--closed"}`}
          aria-hidden="true"
        >
          <Icon name="expand" size="sm" />
        </span>
        <span className="codex-changes-label">{describeDiff(files)}</span>
        <span className="codex-changes-added">+{totals.added}</span>
        <span className="codex-changes-removed">−{totals.removed}</span>
      </button>

      {open && (
        <div className="codex-changes-panel">
          {files.map((file, fileIndex) => (
            <div className="codex-changes-file" key={`${file.path}-${fileIndex}`}>
              <div className="codex-changes-path">
                <code title={file.path}>{file.path}</code>
                <span>
                  <span className="codex-changes-added">+{file.added}</span>{" "}
                  <span className="codex-changes-removed">−{file.removed}</span>
                </span>
              </div>
              <pre>
                {file.lines.map((line, lineIndex) => (
                  <span
                    key={lineIndex}
                    className={`codex-diff-line codex-diff-${line.kind}`}
                  >
                    {line.text}
                    {"\n"}
                  </span>
                ))}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
