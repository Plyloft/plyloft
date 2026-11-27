// UX language card 1: the Row wrapping rule (PATTERNS.md §3, SHEET.md "Row").
// The label never gives way: when the right side does not fit beside at
// least 260 px of label, it wraps below the label on a line of its own.
// Pure so node can test it; `Row` applies it with a ResizeObserver.

export const ROW_LABEL_MIN = 260;
/** Gap between the two sides of a row (`--page-space-lg`). */
export const ROW_SIDE_GAP = 16;

/** `rowWidth` is the row's content box (padding excluded); `sideWidth` the
 *  right side's natural width. */
export function rowStacks(
  rowWidth: number,
  sideWidth: number,
  labelMin: number = ROW_LABEL_MIN,
): boolean {
  if (sideWidth <= 0) return false;
  return rowWidth - sideWidth - ROW_SIDE_GAP < labelMin;
}

/** What `naturalWidth` needs of an element (a DOM element, or a fake). */
export type Measurable = {
  style: { width: string };
  getBoundingClientRect(): { width: number };
};

/** The right side's own width, whatever its current layout: stacked, it
 *  spans the row, so it is read once at `max-content` and put back in the
 *  same task (nothing paints in between). Challenger F10. */
export function naturalWidth(side: Measurable): number {
  const was = side.style.width;
  side.style.width = "max-content";
  const width = side.getBoundingClientRect().width;
  side.style.width = was;
  return width;
}

/** A control inside a disabled row is disabled, whatever its own prop says;
 *  its own `disabled` can only add to the row's. Challenger F11. */
export function effectiveDisabled(own: boolean | undefined, rowDisabled: boolean | undefined): boolean {
  return own === true || rowDisabled === true;
}

// A0 (owner, 2026-10-31): tidy tables. A `Group` lays its rows out in shared
// columns — main | value | action | more — so every action button in it is as
// wide as the widest one and they share one right edge, ⋯ has one slot, and
// the whole table wraps at once: below the width where its side columns leave
// less than 260 px of label, every row puts its side under its label.

/** One row's side cells at their natural content widths, padding excluded
 *  (0 = the cell is empty). */
export type TableRowCells = { value: number; action: number; more: number };

export type TableLayout = TableRowCells & {
  /** Every row puts its side under its label. */
  stacked: boolean;
};

/** The space a filled cell keeps before itself (`--page-space-sm`). It is
 *  added here, not measured, so the decision reads the same whether the
 *  table is stacked or not (a stacked cell pads differently) and never
 *  flips back and forth at the edge. */
export const TABLE_CELL_GAP = 8;
/** The space the label keeps before the first side cell, beyond the cell's
 *  own (`--page-space-sm` on `.ux-row-main`). */
export const TABLE_MAIN_GAP = 8;

/** The columns a table takes from its rows — each the widest of its cells
 *  with the cell's gap, 0 when no row fills it — and stacked when they
 *  leave less than `labelMin` of `contentWidth`. A row with no action
 *  spreads its value across the action column too (ux.css), so its value
 *  only widens the value column by what the action column cannot hold. */
export function tableLayout(
  rows: readonly TableRowCells[],
  contentWidth: number,
  labelMin: number = ROW_LABEL_MIN,
  /** F6: what the page's other tables ask of this one (`TidyColumns`): the
   *  action column's width (gap included) where this table has actions, and
   *  at least this much for the ⋯ column. */
  shared?: { action: number; more: number },
): TableLayout {
  const gap = (w: number) => (w > 0 ? w + TABLE_CELL_GAP : 0);
  const widest = (list: readonly TableRowCells[], key: keyof TableRowCells) =>
    list.reduce((m, r) => Math.max(m, gap(r[key])), 0);
  const withAction = rows.filter((r) => r.action > 0);
  const without = rows.filter((r) => r.action <= 0);
  const own = widest(rows, "action");
  const action = own > 0 ? Math.max(own, shared?.action ?? 0) : 0;
  const value = Math.max(widest(withAction, "value"), widest(without, "value") - action, 0);
  const more = Math.max(widest(rows, "more"), shared?.more ?? 0);
  const side = value + action + more;
  const stacked = side > 0 && contentWidth - side - TABLE_MAIN_GAP < labelMin;
  return { value, action, more, stacked };
}
