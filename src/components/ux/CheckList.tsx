// GH #277: a list of things to tick, one per row under hairlines — the
// Ship batch sheet's cards (PATTERNS §Sheet `review`: one row per change).
// The checkbox wears the accent, not the system blue; the row's words wrap
// to two lines and a row may add one muted note ("Checks skipped").
import type { ReactNode } from "react";
import { forMachine } from "./Page";

export function CheckList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ux-check-list" role="group" aria-label={label}>
      {children}
    </div>
  );
}

export function CheckRow({
  checked,
  onChange,
  disabled,
  note,
  hint,
  children,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** One muted fact after the words, said only where it applies. */
  note?: ReactNode;
  /** 1.174.0 (DR3): a muted line under the words (the Release sheet's
   *  "Checked and approved · goes into the release as its own change"). */
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="ux-check-row">
      <input
        type="checkbox"
        className="ux-checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {hint ? (
        <span className="ux-check-row-body">
          <span className="ux-check-row-text">{children}</span>
          <span className="ux-check-row-hint">{forMachine(hint)}</span>
        </span>
      ) : (
        <span className="ux-check-row-text">{children}</span>
      )}
      {note && <span className="ux-check-row-note">{note}</span>}
    </label>
  );
}

/**
 * SL-3: one remembered choice beside the action it changes ("Merge when
 * checks pass" beside Ship as a PR) — a checkbox and its words on one line,
 * no hairline. A hint says what it does, under it, when there is one.
 */
export function CheckLine({
  checked,
  onChange,
  disabled,
  hint,
  children,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className="ux-check-line">
      <label className="ux-check-line-label">
        <input
          type="checkbox"
          className="ux-checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{forMachine(children)}</span>
      </label>
      {/* CL-11 (Windows walk): "on this Mac" reads "on this PC" there. */}
      {hint && <span className="ux-check-line-hint">{forMachine(hint)}</span>}
    </span>
  );
}
