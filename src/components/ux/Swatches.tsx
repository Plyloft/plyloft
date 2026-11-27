import { useRef, type KeyboardEvent } from "react";
import { useRowState } from "./Row";

/**
 * UX language card 2 (BOARDS.md §6): the accent colour as four 26 px
 * circles, the selected one ringed **and named beside it**, so the choice
 * never rests on seeing the colour. Read-only, the name alone is shown.
 *
 * A circle is painted with its option's `color` when it has one — the
 * workspace colour, whose circle shows the value it stores (GH #272) — and
 * otherwise with the theme's token (`--page-accent-*` in `src/App.css`), as
 * the app accent is, whose value changes with the theme.
 */

export interface Swatch {
  id: string;
  name: string;
  value: string;
  /** Paint the circle with this colour rather than the theme's token. */
  color?: string;
}

// Spelled out so ux-check can read every class (no `ux-swatch--${id}`).
const SWATCH_CLASS: Record<string, string> = {
  violet: "ux-swatch ux-swatch--violet",
  cyan: "ux-swatch ux-swatch--cyan",
  magenta: "ux-swatch ux-swatch--magenta",
  sunset: "ux-swatch ux-swatch--sunset",
};

export function Swatches({
  value,
  options,
  onChange,
  name,
  label,
}: {
  /** The colour in use, whether or not it is one of the four. */
  value: string | null;
  options: Swatch[];
  onChange: (next: string) => void;
  /** What the chosen colour is called, beside the circles. */
  name: string;
  label?: string;
}) {
  const row = useRowState();
  const group = useRef<HTMLSpanElement>(null);
  if (row?.readOnly) return <span className="ux-readonly-value">{name}</span>;
  const chosen = (v: string) => v.toLowerCase() === (value ?? "").toLowerCase();
  const at = options.findIndex((o) => chosen(o.value));
  // A radio group is one tab stop, and the arrows move between its
  // choices: Tab lands on the chosen one (or the first), then ← → pick.
  const step = (by: number) => {
    const from = at < 0 ? 0 : at;
    const to = options[(from + by + options.length) % options.length];
    onChange(to.value);
    group.current
      ?.querySelectorAll<HTMLButtonElement>(".ux-swatch")
      [(from + by + options.length) % options.length]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    const by = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    step(by);
  };
  return (
    <span className="ux-swatches">
      <span
        ref={group}
        className="ux-swatch-row"
        role="radiogroup"
        aria-label={label}
        aria-labelledby={label ? undefined : row?.labelId}
        aria-describedby={row?.hintId}
        onKeyDown={onKeyDown}
      >
        {options.map((o, i) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={chosen(o.value)}
            aria-label={o.name}
            tabIndex={(at < 0 ? 0 : at) === i ? 0 : -1}
            disabled={row?.disabled}
            style={o.color ? { background: o.color, color: o.color } : undefined}
            className={
              chosen(o.value)
                ? `${SWATCH_CLASS[o.id] ?? "ux-swatch"} ux-swatch--chosen`
                : SWATCH_CLASS[o.id] ?? "ux-swatch"
            }
            onClick={() => onChange(o.value)}
          />
        ))}
      </span>
      <span className="ux-swatch-name">{name}</span>
    </span>
  );
}
