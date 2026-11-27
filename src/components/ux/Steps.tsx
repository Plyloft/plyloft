// OB-4 (ONBOARDING_SPEC §3.1): the numbered step list and the progress bar of
// a guided procedure (Setup). The list is a `nav` whose current step carries
// `aria-current="step"` (§5.11); each step says its state in words beside a
// run-state dot, never colour alone.
import type { ReactNode } from "react";
import { StateWord } from "./Screen";
import type { RunState } from "./Page";

export type StepItem = {
  id: string;
  number: number;
  title: string;
  /** The dot and the word; absent when the step has nothing to say yet. */
  state?: { dot: RunState; word: string };
};

export function StepList({
  steps,
  current,
  onSelect,
  label,
}: {
  steps: StepItem[];
  current: string | null;
  onSelect: (id: string) => void;
  label: string;
}) {
  return (
    <nav className="ux-steps" aria-label={label}>
      <ol className="ux-steps-list">
        {steps.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className={s.id === current ? "ux-step ux-step--current" : "ux-step"}
              aria-current={s.id === current ? "step" : undefined}
              onClick={() => onSelect(s.id)}
            >
              <span className="ux-step-num">{s.number}</span>
              <span className="ux-step-title">{s.title}</span>
              {s.state && (
                <span className="ux-step-state">
                  <StateWord state={s.state.dot}>{s.state.word}</StateWord>
                </span>
              )}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** How far a procedure has come: `value` of `max`, named by `label`. */
export function ProgressBar({
  value,
  max,
  label,
  valueText,
}: {
  value: number;
  max: number;
  label: string;
  /** Words for a screen reader ("3 of 10 steps done or skipped"). */
  valueText?: string;
}): ReactNode {
  const percent = max > 0 ? Math.round((Math.min(value, max) / max) * 100) : 0;
  return (
    <div
      className="ux-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
    >
      <span className="ux-progress-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}
