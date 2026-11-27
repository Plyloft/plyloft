// UX-2.3 (ADR 0007): the list view — the board's second view and any long
// list. Compact rows, a header to sort by, optional grouping and selection.
// Titles wrap to two lines; nothing is truncated to nothing.
import { type ReactNode } from "react";
import { Icon } from "./Icon";

export type ListColumn<R> = {
  key: string;
  label: string;
  cell: (row: R) => ReactNode;
  /** Present when the column sorts. */
  sortable?: boolean;
  /** The column that names the row (wraps, takes the free width). */
  primary?: boolean;
  /** GH #248: a fixed width from the list-column scale (`--list-col-*`);
   *  the primary column takes whatever is left. A value that does not fit
   *  is cut with an ellipsis, the whole in `tooltip`. */
  width?: "xs" | "sm" | "md" | "lg";
  /** The cell's whole text, on hover — for a value the width may cut. */
  tooltip?: (row: R) => string | undefined;
  /** UX P-A Mac walk 3: `data-*` attributes on the cell itself (`<td>`),
   *  where the test bridge reports them beside the cell's name. */
  cellData?: (row: R) => Record<`data-${string}`, string | undefined>;
};

const WIDTH_CLASS = {
  xs: "ux-list-col--xs",
  sm: "ux-list-col--sm",
  md: "ux-list-col--md",
  lg: "ux-list-col--lg",
} as const;


export type ListGroup<R> = {
  key: string;
  label: string;
  rows: R[];
  /** The heading's count when it is not just the rows shown (P-D2 Mac walk:
   *  "10 of 12" while the Board's Done shows its latest ten). */
  count?: string;
};

export type ListSort = { key: string; dir: "asc" | "desc" };

export function ListView<R extends { id: string }>({
  label,
  columns,
  groups,
  sort,
  onSort,
  selected,
  onSelect,
  onOpen,
  canOpen,
  empty,
  rowLabel,
  selectionBar,
}: {
  /** The table's accessible name. */
  label: string;
  columns: ListColumn<R>[];
  /** One group with an empty label draws no group heading. */
  groups: ListGroup<R>[];
  sort?: ListSort;
  onSort?: (next: ListSort) => void;
  /** Ids selected; with `onSelect`, a checkbox column appears. */
  selected?: ReadonlySet<string>;
  onSelect?: (id: string, on: boolean) => void;
  onOpen?: (row: R) => void;
  /** With `onOpen`: which rows open (all when absent). A row that leads
   *  nowhere names itself as plain text, not as a button that does nothing. */
  canOpen?: (row: R) => boolean;
  empty?: ReactNode;
  /** Names a row for its checkbox ("Select Fix login"); "Select row" if absent. */
  rowLabel?: (row: R) => string;
  /** GH #298: while anything is selected, this bar ("3 selected · Ship 2 ·
   *  Clear") takes the header row's place, on the table's own width. The
   *  header row keeps its box (hidden), so the columns do not move. */
  selectionBar?: ReactNode;
}) {
  const selectable = Boolean(onSelect);
  const span = columns.length + (selectable ? 1 : 0);
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  if (total === 0 && empty) return <div className="ux-list-empty">{empty}</div>;
  const barOn = selectionBar != null && (selected?.size ?? 0) > 0;
  const table = (
    <table className="ux-list" aria-label={label}>
      <thead>
        <tr className={barOn ? "ux-list-head--covered" : undefined}>
          {selectable && <th className="ux-list-check" aria-label="Select" />}
          {columns.map((c) => {
            const active = sort?.key === c.key;
            return (
              <th
                key={c.key}
                className={
                  c.primary
                    ? "ux-list-th ux-list-th--primary"
                    : c.width
                      ? `ux-list-th ${WIDTH_CLASS[c.width]}`
                      : "ux-list-th"
                }
                aria-sort={active ? (sort?.dir === "asc" ? "ascending" : "descending") : undefined}
              >
                {c.sortable && onSort ? (
                  <button
                    type="button"
                    className="ux-list-sort"
                    onClick={() =>
                      onSort({ key: c.key, dir: active && sort?.dir === "asc" ? "desc" : "asc" })
                    }
                  >
                    {c.label}
                    {active && <Icon name="expand" size="sm" />}
                  </button>
                ) : (
                  c.label
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      {groups.map((g) => (
        <tbody key={g.key}>
          {g.label && (
            <tr className="ux-list-group">
              <th colSpan={span} scope="rowgroup">
                {g.label} · {g.count ?? g.rows.length}
              </th>
            </tr>
          )}
          {g.rows.map((r) => {
            const on = selected?.has(r.id) ?? false;
            return (
              <tr key={r.id} className={on ? "ux-list-row ux-list-row--selected" : "ux-list-row"}>
                {selectable && (
                  <td className="ux-list-check">
                    <input
                      type="checkbox"
                      className="ux-list-checkbox"
                      checked={on}
                      aria-label={rowLabel ? `Select ${rowLabel(r)}` : "Select row"}
                      onChange={(e) => onSelect?.(r.id, e.target.checked)}
                    />
                  </td>
                )}
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={c.primary ? "ux-list-td ux-list-td--primary" : "ux-list-td"}
                    {...(c.cellData?.(r) ?? {})}
                  >
                    {/* GH #248: the title wraps to two whole lines at most; the
                        clamp is on a span, so the cell stays a table cell —
                        sized by its column, on the row's hairline. */}
                    {c.primary && onOpen && (canOpen?.(r) ?? true) ? (
                      <button
                        type="button"
                        className="ux-list-open"
                        title={rowLabel?.(r)}
                        onClick={() => onOpen(r)}
                      >
                        <span className="ux-list-clamp">{c.cell(r)}</span>
                      </button>
                    ) : c.primary ? (
                      <span className="ux-list-clamp">{c.cell(r)}</span>
                    ) : (
                      <span className="ux-list-cell" title={c.tooltip?.(r)}>
                        {c.cell(r)}
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      ))}
    </table>
  );
  if (selectionBar === undefined) return table;
  return (
    <div className="ux-list-frame">
      {barOn && (
        <div className="ux-list-bar" role="toolbar" aria-label={`Selected ${label.toLowerCase()}`}>
          {selectionBar}
        </div>
      )}
      {table}
    </div>
  );
}
