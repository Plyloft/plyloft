// A0 (owner, 2026-10-31): tidy tables. A `Group` (and the `DangerZone`) is a
// table: its rows take shared columns — main | value | action | more — through
// `grid-template-columns: subgrid` (ux.css, "Tidy tables"), so every action
// button in it is as wide as the widest one and they share one right edge, and
// ⋯ keeps one slot in every row once any row has one.
//
// What CSS cannot decide is when the table wraps: the label never gives way
// (PATTERNS.md §3), so the table stacks — every row at once — when its side
// columns leave less than 260 px of label. This hook measures every row's
// cells and decides once for the whole table. It always hands the action
// column its measured width (`--ux-action-w`); where the web view has no
// subgrid (macOS 11 without Safari 16), also `--ux-value-w` and `--ux-more-w`.
import { createContext, useContext, useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";
import { ROW_LABEL_MIN, TABLE_CELL_GAP, tableLayout, type TableRowCells } from "../../lib/uxRow";

export type TidyTable = {
  stacked: boolean;
  /** A row of the table has a ⋯ (or a chevron): its slot is kept in every row. */
  hasMore: boolean;
  /** The measured action column (`--ux-action-w`), and where subgrid is
   *  missing the other columns too. */
  vars?: CSSProperties;
  /** F6: this table's own measures, for taking part in a `TidyColumns`. */
  own?: { cells: TableRowCells[]; action: number; content: number; ctl: number; subgrid: boolean };
};

const AT_REST: TidyTable = { stacked: false, hasMore: false };

/**
 * F6 (1.176.2, scope narrowed in 1.176.3): the tables of one `Section` that
 * share their action column. Each `Group` is a table of its own, so two
 * tables of a section each took the width of their own widest button. Inside
 * a `TidyColumns` (`Page.tsx`, drawn by every `Section`) every table reports
 * its action width and takes the widest of them. Only the button width and
 * with it the right edge are shared: the ⋯ slot stays each table's own, so a
 * chevron in one table (Shipping's Version files) never moves the release
 * menus of the table beside it off their edge.
 */
export type TidyShare = {
  report: (id: object, action: number) => void;
  forget: (id: object) => void;
  subscribe: (fn: () => void) => () => void;
  read: () => { action: number };
};

export function createTidyShare(): TidyShare {
  const entries = new Map<object, number>();
  const listeners = new Set<() => void>();
  let snap = { action: 0 };
  const recompute = () => {
    let action = 0;
    for (const e of entries.values()) action = Math.max(action, e);
    if (action !== snap.action) {
      snap = { action };
      listeners.forEach((fn) => fn());
    }
  };
  return {
    report(id, action) {
      if (entries.get(id) === action) return;
      entries.set(id, action);
      recompute();
    },
    forget(id) {
      if (entries.delete(id)) recompute();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    read: () => snap,
  };
}

export const TidyShareContext = createContext<TidyShare | null>(null);

function supportsSubgrid(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function"
    ? CSS.supports("grid-template-columns", "subgrid")
    : true;
}

const CELLS = ["value", "action", "more"] as const;
// The row's own cells only — never those of a row drawn inside its side.
const CELL_PATH = ":scope > .ux-row-side > .ux-row-fieldset > .ux-row-side-inner > ";
const CELL_SELECTOR = {
  value: CELL_PATH + ".ux-row-cell--value",
  action: CELL_PATH + ".ux-row-cell--action",
  more: CELL_PATH + ".ux-row-cell--more",
} as const;

function same(a: TidyTable, b: TidyTable, shares: boolean): boolean {
  if (a.stacked !== b.stacked || a.hasMore !== b.hasMore) return false;
  // The measured width matters only to a page that shares its columns.
  if (shares && (a.own?.action !== b.own?.action || a.own?.content !== b.own?.content)) return false;
  if (shares && JSON.stringify(a.own?.cells) !== JSON.stringify(b.own?.cells)) return false;
  const av = (a.vars ?? {}) as Record<string, unknown>;
  const bv = (b.vars ?? {}) as Record<string, unknown>;
  const keys = new Set([...Object.keys(av), ...Object.keys(bv)]);
  for (const k of keys) if (av[k] !== bv[k]) return false;
  return true;
}

type Filled = { row: number; key: (typeof CELLS)[number]; el: HTMLElement; was: string };

/**
 * One table's measurement, in three phases so that every table waiting in a
 * frame is measured together: all tables write (`max-content` on their
 * filled cells), then all read, then all restore — one layout for the frame
 * however many tables changed.
 */
type Measurer = {
  write: () => void;
  read: () => void;
  restore: () => void;
};

const pending = new Set<Measurer>();
let frame = 0;

function runPending() {
  frame = 0;
  const batch = [...pending];
  pending.clear();
  // Each table's cells are put back whatever happens to its reading — or to
  // another table's: one table that throws never leaves cells at max-content.
  const written: Measurer[] = [];
  try {
    for (const m of batch) {
      written.push(m);
      m.write();
    }
    for (const m of batch) {
      try {
        m.read();
      } catch (e) {
        console.error(e);
      }
    }
  } finally {
    for (const m of written) {
      try {
        m.restore();
      } catch (e) {
        console.error(e);
      }
    }
  }
}

function schedule(m: Measurer) {
  pending.add(m);
  if (!frame) frame = requestAnimationFrame(runPending);
}

function unschedule(m: Measurer) {
  pending.delete(m);
  if (pending.size === 0 && frame) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
}

/** The page's control height (`--ctl-page`), for the ⋯ slot's least width. */
function ctlPage(el: Element): number {
  return parseFloat(getComputedStyle(el).getPropertyValue("--ctl-page")) || 30;
}

/** Measures the table `ref` points at. */
export function useTidyTable(ref: RefObject<HTMLElement | null>): TidyTable {
  const [layout, setLayout] = useState<TidyTable>(AT_REST);
  const share = useContext(TidyShareContext);
  const [shared, setShared] = useState(() => share?.read() ?? { action: 0 });
  useLayoutEffect(() => {
    if (!share) return;
    setShared(share.read());
    return share.subscribe(() => setShared(share.read()));
  }, [share]);

  useLayoutEffect(() => {
    const table = ref.current;
    if (!table) return;
    const subgrid = supportsSubgrid();
    let filled: Filled[] = [];
    let rows: HTMLElement[] = [];
    let cells: TableRowCells[] = [];
    let content = 0;
    let ctl = 30;

    const m: Measurer = {
      write() {
        rows = Array.from(table.children).filter(
          (c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains("ux-row--cells"),
        );
        filled = [];
        rows.forEach((row, i) => {
          for (const key of CELLS) {
            const el = row.querySelector<HTMLElement>(CELL_SELECTOR[key]);
            if (el && el.firstChild) filled.push({ row: i, key, el, was: el.style.width });
          }
        });
        // Every filled cell is read at its natural width.
        for (const f of filled) f.el.style.width = "max-content";
      },
      read() {
        cells = rows.map(() => ({ value: 0, action: 0, more: 0 }));
        for (const f of filled) {
          const cs = getComputedStyle(f.el);
          const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
          // jsdom lays nothing out: a filled cell still counts as filled.
          cells[f.row][f.key] = Math.max(1, f.el.getBoundingClientRect().width - pad);
        }
        // Read in the same layout as the cells, before anything is put back.
        const first = rows[0];
        content = table.clientWidth;
        if (first) {
          const cs = getComputedStyle(first);
          content = first.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
        }
        if (!subgrid) ctl = ctlPage(table);
      },
      restore() {
        for (const f of filled) f.el.style.width = f.was;
        const hasMore = filled.some((f) => f.key === "more");
        // A hidden host (a workspace in the background, a closed page) has no
        // width: what it would decide is wrong, so the table keeps its last
        // layout — no flash of a stacked table — and only learns about ⋯.
        if (content <= 0) {
          setLayout((prev) => (prev.hasMore === hasMore ? prev : { ...prev, hasMore }));
          return;
        }
        const t = tableLayout(cells, content);
        // The action column's width comes from the actions alone, so a wide
        // control in a row with no action (which spans that column) never
        // widens every button.
        const vars: Record<string, string> = { "--ux-action-w": `${Math.ceil(t.action)}px` };
        if (!subgrid) {
          vars["--ux-value-w"] = `${Math.ceil(t.value)}px`;
          // Without subgrid each row is its own grid: the ⋯ slot is never
          // narrower than the square ⋯ and its gap, filled or not.
          const more = hasMore ? Math.max(t.more, ctl + TABLE_CELL_GAP) : t.more;
          vars["--ux-more-w"] = `${Math.ceil(more)}px`;
        }
        const next: TidyTable = {
          stacked: t.stacked,
          hasMore,
          vars: vars as CSSProperties,
          own: { cells, action: t.action, content, ctl: ctlPage(table), subgrid },
        };
        setLayout((prev) => (same(prev, next, !!share) ? prev : next));
        share?.report(m, t.action);
      },
    };

    try {
      m.write();
      m.read();
    } finally {
      m.restore();
    }
    // Later changes are read once per frame, however many arrive in it, and
    // together with every other table that changed in the same frame.
    const soon = () => schedule(m);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(soon);
    ro?.observe(table);
    const mo = new MutationObserver(soon);
    mo.observe(table, { childList: true, subtree: true, characterData: true });
    return () => {
      unschedule(m);
      share?.forget(m);
      ro?.disconnect();
      mo.disconnect();
    };
  }, [ref, share]);

  if (!share || !layout.own) return layout;
  // F6: the widest action column of the section's tables. A table with no
  // action keeps none: its label would lose the room for nothing. Whether it
  // wraps is decided with that width.
  const own = layout.own;
  const t = tableLayout(own.cells, own.content, ROW_LABEL_MIN, { action: shared.action, more: 0 });
  const stacked = own.content > 0 ? t.stacked : layout.stacked;
  if (t.action === own.action && stacked === layout.stacked) return layout;
  const vars = { ...(layout.vars ?? {}) } as Record<string, string>;
  if (t.action > 0) vars["--ux-action-w"] = `${Math.ceil(t.action)}px`;
  return { ...layout, stacked, vars: vars as CSSProperties };
}

/** The table's classes and attributes, for `Group` and `DangerZone`. */
export function tableProps(t: TidyTable, base: string) {
  return {
    className: t.stacked ? `${base} ux-table ux-table--stacked` : `${base} ux-table`,
    "data-has-more": t.hasMore ? "true" : undefined,
    style: t.vars,
  };
}
