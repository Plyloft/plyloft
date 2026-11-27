import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Icon } from "./ux";
import { setToastsPageVisible, useToasts, type Toast } from "../store/toastStore";
import { usePageVisible } from "../hooks/usePageVisible";
import { useOpenSheets } from "../store/sheetLayerStore";
import { controlInUse, noticeOf } from "../lib/rowInUse";
import { useUi } from "../store/uiStore";

/** Where a toast is drawn. 1.176.1 (owner, 1.176.0 walk): a toast raised
 *  while any sheet is open sits above every sheet (`--z-toast-sheet`) and at
 *  the top of the window, away from a sheet's foot where its buttons are —
 *  a confirmation such as "Report copied" was drawn under the backdrop and
 *  never seen. Raised from inside Settings (no sheet) it sits above Settings
 *  (`--z-toast-modal`). Over Setup, the page's
 *  (`--z-toast-setup`). Otherwise above the content. The class picks the
 *  `--z-*` name (App.css). It never takes focus and the live region stays
 *  the same element, so it is announced once. */
export type ToastLayer = "content" | "modal" | "setup" | "sheet";
export function toastLayer(o: { sheetOpen: boolean; overSetup: boolean; settingsOpen: boolean; scope?: "settings" }): ToastLayer {
  if (o.sheetOpen) return "sheet";
  if (o.overSetup) return "setup";
  // 1.176.1 walk 2: decided at paint time by what is open, never by where
  // the focus was when it was raised. "Empty it" (its button goes as the
  // value is saved) and Repair's Undo (raised as its sheet closed) were
  // raised with the focus on nothing, drawn on the content layer, under
  // Settings' backdrop, and seen only once Settings closed.
  if (o.settingsOpen) return "modal";
  return "content";
}

/** 1.176.1: which edge a toast over a sheet takes. The top, unless the sheet
 *  reaches up into the room the toast needs; then the bottom, if the sheet
 *  leaves room there; with room on neither side the top, over the sheet's
 *  head (its title, nothing pressable) and never over its foot's buttons. */
export const SHEET_TOAST_ROOM = 140;
export function sheetToastEdge(sheet: { top: number; bottom: number } | null, windowHeight: number, room = SHEET_TOAST_ROOM): "top" | "bottom" {
  if (!sheet) return "top";
  if (sheet.top >= room) return "top";
  if (windowHeight - sheet.bottom >= room) return "bottom";
  return "top";
}

/** 1.176.1 walks: a toast is painted above whatever overlay is topmost at
 *  paint time, placed from real rects (the toast's and the overlay's), and
 *  placed again on resize, when an overlay opens, closes or changes height,
 *  and when the focus moves. `null` (nothing measured yet) keeps the plain
 *  edge classes, which are still above that overlay. */
export const OVERLAY_TOAST_GAP = 12;
export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}
export interface OverlayBox extends Rect {
  width: number;
  headBottom: number;
}
const hit = (a: Rect, b: Rect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** Walk 3: with a sheet open, the window's top-right corner, which a
 *  centred sheet doesn't reach. Only if the toast would meet the sheet (a
 *  narrow window, a wide sheet): above the sheet when the whole toast fits
 *  there, else below it; with room for neither, the corner, over the
 *  sheet's title band only. */
export function sheetToastPlace(
  sheet: Rect | null,
  win: { width: number; height: number },
  toast: { width: number; height: number },
  gap = OVERLAY_TOAST_GAP,
): { top: number; right: number; width: number } | null {
  if (!sheet || win.width <= 0 || sheet.bottom <= sheet.top) return null;
  const width = Math.round(Math.min(toast.width, win.width - 2 * gap));
  const left = win.width - gap - width;
  const at = (top: number): Rect => ({ top, bottom: top + toast.height, left, right: left + width });
  const corner = { top: gap, right: gap, width };
  if (!hit(at(gap), sheet)) return corner;
  const above = sheet.top - gap - toast.height;
  if (above >= gap) return { ...corner, top: Math.round(above) };
  const below = sheet.bottom + gap;
  if (below + toast.height <= win.height - gap) return { ...corner, top: Math.round(below) };
  return corner;
}

/** Walk 4: over Settings, two spots — the surface's top right under its
 *  title bar, then its bottom right at the foot — and one exclusion zone:
 *  the row in use with its notice and offers (`zone`, a little margin
 *  around it). The first spot that misses the zone; when both meet it (a
 *  very tall row), the one that covers none of that row's buttons with the
 *  smaller overlap. */
export function settingsToastPlace(
  box: OverlayBox | null,
  win: { width: number; height: number },
  toastHeight: number,
  zone: Rect | null,
  buttons: readonly Rect[] = [],
  gap = OVERLAY_TOAST_GAP,
  margin = 8,
): { top: number; right: number; width: number } | null {
  if (!box || box.width <= 2 * gap || box.headBottom <= 0 || win.width <= 0) return null;
  const width = Math.round(Math.min(480, box.width - 2 * gap));
  const right = Math.round(Math.max(gap, win.width - box.right + gap));
  const left = win.width - right - width;
  const first = box.headBottom + gap;
  const foot = Math.max(first, Math.min(box.bottom, win.height) - gap - toastHeight);
  const at = (top: number): Rect => ({ top, bottom: top + toastHeight, left, right: left + width });
  const spots = [first, foot];
  const place = (top: number) => ({ top: Math.round(top), right, width });
  if (!zone) return place(first);
  const z: Rect = { top: zone.top - margin, bottom: zone.bottom + margin, left: zone.left - margin, right: zone.right + margin };
  for (const top of spots) if (!hit(at(top), z)) return place(top);
  const overlap = (r: Rect) =>
    Math.max(0, Math.min(r.right, z.right) - Math.max(r.left, z.left)) * Math.max(0, Math.min(r.bottom, z.bottom) - Math.max(r.top, z.top));
  const ranked = spots
    .map((top) => ({ top, buttons: buttons.filter((b) => hit(at(top), b)).length, area: overlap(at(top)) }))
    .sort((x, y) => x.buttons - y.buttons || x.area - y.area);
  return place(ranked[0].top);
}

/** The row in use (`rowInUse.ts`) with its notice: the zone a toast over
 *  Settings stays off, and that row's buttons. */
function zoneIn(surface: Element): { zone: Rect | null; buttons: Rect[] } {
  const focused = document.activeElement instanceof HTMLElement && surface.contains(document.activeElement) ? document.activeElement : null;
  const control = controlInUse() ?? focused;
  if (!control || !surface.contains(control)) return { zone: null, buttons: [] };
  const parts = [control.closest(".ux-row") ?? control, noticeOf(control)].filter((x): x is Element => !!x);
  const rects = parts.map((p) => p.getBoundingClientRect()).filter((r) => r.height > 0);
  if (rects.length === 0) return { zone: null, buttons: [] };
  const zone = {
    top: Math.min(...rects.map((r) => r.top)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
    left: Math.min(...rects.map((r) => r.left)),
    right: Math.max(...rects.map((r) => r.right)),
  };
  const buttons = parts.flatMap((p) =>
    [...p.querySelectorAll("button")].map((b) => b.getBoundingClientRect()).filter((r) => r.height > 0),
  );
  return { zone, buttons: buttons.map((r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right })) };
}

/** The topmost overlay: the last open sheet, else Settings' surface. */
function topOverlay(layer: ToastLayer): { el: HTMLElement; box: OverlayBox } | null {
  const sel = layer === "sheet" ? ".ux-sheet" : layer === "modal" ? ".ux-surface" : null;
  const head = layer === "sheet" ? ".ux-sheet-head" : ".ux-surface-header";
  if (!sel) return null;
  const all = document.querySelectorAll<HTMLElement>(sel);
  const el = all.length ? all[all.length - 1] : null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const h = el.querySelector<HTMLElement>(head)?.getBoundingClientRect();
  if (r.height <= 0) return null;
  return {
    el,
    box: { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, headBottom: h?.bottom ?? r.top },
  };
}

// UX-2.4 (ADR 0007): toasts sit at the bottom centre on the one scale.
// GH #296, the ToastBar spec: one toast at a time, at most 480 px, raised
// with its shadow; no mono body, no click-to-copy. Undo stays 6 s. GH #297:
// raw machine text is never in the words; it waits behind `Details`.
// QoL 1.168 block 8 (A2): an info never covers a warn or an error (it waits,
// `toastStore.ts` has the rules).
// E3 (owner, 2026-10-28): one calm surface for every kind — no coloured
// edge, no red wash. The kind is said by a small icon in its colour and by
// the words: the title on its own line, the body under it in the muted
// colour, the presses as real (bordered) buttons under them, close at the
// top right. What waits behind it is a press, "1 more message".

/** Between the title and the body when they are read as one line (Recent
 *  messages' rows, `toastText`): a title that ends
 *  its own sentence takes a space. A title that is itself a sentence (two
 *  words or more: "Card archived") before a body that starts a new one ("It
 *  is back…") takes a full stop — never "Card archived — It is back"; a
 *  one-word title or a body that goes on the title's sentence takes a dash
 *  (Challenger L2). */
function joiner(title: string, body?: string): string {
  if (/[.!?:…]$/.test(title)) return " ";
  const sentence = /\S\s+\S/.test(title);
  if (sentence && body && /^[A-Z][a-z']/.test(body)) return ". ";
  return " — ";
}

/** A toast's title and body as one sentence (Recent messages' rows). */
export function toastText(t: Pick<Toast, "title" | "body">): string {
  const title = t.title.trim();
  const body = t.body?.trim();
  if (!body) return title;
  if (!title) return body;
  return `${title}${joiner(title, body)}${body}`;
}

export function ToastStack({ overSetup = false }: { overSetup?: boolean }) {
  const toast = useToasts((s) => s.toasts[0]);
  const sheetCount = useOpenSheets((s) => s.count);
  const sheetOpen = sheetCount > 0;
  const settingsOpen = useUi((s) => s.settingsOverlayOpen);
  const layer = toastLayer({ sheetOpen, overSetup, settingsOpen, scope: toast?.scope });
  const waiting = useToasts((s) => s.queue.length);
  const [edge, setEdge] = useState<"top" | "bottom">("top");
  const [anchor, setAnchor] = useState<{ top: number; right: number; width: number } | null>(null);
  const stack = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (layer !== "sheet" && layer !== "modal") {
      setAnchor(null);
      return;
    }
    let watched: HTMLElement | null = null;
    const place = () => {
      const bar = stack.current?.firstElementChild?.getBoundingClientRect();
      const height = bar?.height || 96;
      const win = { width: window.innerWidth, height: window.innerHeight };
      const top = topOverlay(layer);
      // The sheet's own height changes (Details, steps appearing): watched.
      if (top && top.el !== watched) {
        if (watched) ro?.unobserve(watched);
        watched = top.el;
        ro?.observe(watched);
      }
      const next = !top
        ? null
        : layer === "sheet"
          ? sheetToastPlace(top.box, win, { width: Math.min(480, bar?.width || 480), height })
          : (() => {
              const { zone, buttons } = zoneIn(top.el);
              return settingsToastPlace(top.box, win, height, zone, buttons);
            })();
      setAnchor((was) =>
        was && next && was.top === next.top && was.right === next.right && was.width === next.width ? was : next,
      );
      if (layer !== "sheet") return;
      const sheets = document.querySelectorAll<HTMLElement>(".ux-sheet");
      const r = sheets.length ? sheets[sheets.length - 1].getBoundingClientRect() : null;
      setEdge(sheetToastEdge(r && r.height > 0 ? r : null, window.innerHeight));
    };
    // Measured again on the next frame (an overlay that opened or closed
    // with this toast has its box by then) and whenever the toast's size
    // changes (Details opened).
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => place());
    place();
    const frame = window.requestAnimationFrame(place);
    if (stack.current) ro?.observe(stack.current);
    window.addEventListener("resize", place);
    // The control in use moved (Tab, a click): the toast keeps off it. A
    // notice that appears, grows or scrolls into view after a save: placed
    // again (walk 4).
    document.addEventListener("focusin", place);
    document.addEventListener("scroll", place, true);
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => place());
    const surface = layer === "modal" ? document.querySelector(".ux-surface") : null;
    if (surface) mo?.observe(surface, { childList: true, subtree: true });
    return () => {
      window.cancelAnimationFrame(frame);
      ro?.disconnect();
      window.removeEventListener("resize", place);
      document.removeEventListener("focusin", place);
      document.removeEventListener("scroll", place, true);
      mo?.disconnect();
    };
  }, [layer, toast?.id, sheetCount, settingsOpen]);
  // Challenger L3: the timers hold while the window is hidden, as
  // `usePageVisible` reads it (with Tauri's focus as the fallback).
  const visible = usePageVisible();
  useEffect(() => setToastsPageVisible(visible), [visible]);
  // Challenger 1: "1 more message" replaces the toast that held the focus;
  // the next one takes it (its own more press, or its close).
  const moved = useRef(false);
  // v1.154.1 round 3 (walk RW-B 6): the live region is always there, empty
  // between toasts — one created together with its first toast may not be
  // announced, so a first refusal could go unheard.
  // Keyed by id: a replacing toast starts with its Details closed.
  const base =
    layer === "content"
      ? "toast-stack"
      : layer === "sheet" && edge === "bottom" && !anchor
        ? "toast-stack toast-stack--sheet toast-stack--sheet-bottom"
        : `toast-stack toast-stack--${layer}`;
  const style: CSSProperties | undefined = anchor
    ? { top: anchor.top, right: anchor.right, width: anchor.width }
    : undefined;
  return (
    <div
      ref={stack}
      className={anchor ? `${base} toast-stack--anchored` : base}
      style={style}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {toast && (
        <ToastBar
          key={toast.id}
          toast={toast}
          waiting={waiting}
          focusOnShow={moved.current}
          onShown={() => {
            moved.current = false;
          }}
          onMore={() => {
            moved.current = true;
          }}
        />
      )}
    </div>
  );
}

/** E3 (owner, 2026-10-28): what waits behind the toast on screen, as a press
 *  that says what it is — "1 more message" — never a bare "· 1 more". */
export function moreMessagesLabel(waiting: number): string {
  return waiting === 1 ? "1 more message" : `${waiting} more messages`;
}

const KIND_ICON = { info: "info", warn: "warning", error: "failed" } as const;

function ToastBar({
  toast: t,
  waiting,
  focusOnShow,
  onShown,
  onMore,
}: {
  toast: Toast;
  waiting: number;
  focusOnShow: boolean;
  onShown: () => void;
  onMore: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusOnShow) return;
    onShown();
    const el = root.current;
    (el?.querySelector<HTMLElement>(".toast-more") ?? el?.querySelector<HTMLElement>(".toast-dismiss"))?.focus();
    // Once, as it shows.
  }, []);
  const dismiss = useToasts((s) => s.dismiss);
  const showWaiting = useToasts((s) => s.showWaiting);
  const pauseTimer = useToasts((s) => s.pauseTimer);
  const resumeTimer = useToasts((s) => s.resumeTimer);
  const details = t.details ?? t.copyText;
  const [open, setOpen] = useState(false);
  const title = t.title.trim();
  const body = t.body?.trim();
  // A toast with only a body draws it as its title: one line, never an
  // empty heading above it.
  const under = title ? body : undefined;
  // Read as one sentence (the live region, Recent messages): a title that is
  // a sentence before a body that starts a new one keeps its full stop; any
  // other joiner is there for a screen reader only, never on screen.
  const join = under ? joiner(title, under) : "";
  const head = (title || body || "") + (join === ". " ? "." : "");
  const hasActions = !!t.action || !!t.secondaryAction || !!details || waiting > 0;
  return (
    <div
      ref={root}
      className={`toast toast-${t.kind}`}
      onMouseEnter={() => pauseTimer(t.id, "hover")}
      // An open Details stays until it is closed or dismissed (its own hold).
      onMouseLeave={() => resumeTimer(t.id, "hover")}
    >
      <div className="toast-head">
        {/* E3: the kind is said by this icon, in its colour, and nothing else. */}
        <span className="toast-icon" aria-hidden="true">
          <Icon name={KIND_ICON[t.kind]} />
        </span>
        <div className="toast-text">
          <p className="toast-title">{head}</p>
          {under && <span className="sr-only">{join === ". " ? " " : join}</span>}
          {under && <p className="toast-body">{under}</p>}
        </div>
        <button
          type="button"
          className="toast-dismiss"
          aria-label="Dismiss"
          onClick={() => dismiss(t.id)}
        >
          <Icon name="close" />
        </button>
      </div>
      {hasActions && (
        <div className="toast-actions">
          {/* v1.24.0 (G4): the inline action (e.g. "Undo") runs, then the toast goes. */}
          {t.action && (
            <button
              type="button"
              className="cbtn cbtn--sm cbtn--strong toast-action-btn"
              onClick={() => {
                t.action!.onClick();
                if (t.action!.label === "Undo") useToasts.getState().markUndone(t.id);
                dismiss(t.id);
              }}
            >
              {t.action.label === "Undo" && <Icon name="undo" />}
              {t.action.label}
            </button>
          )}
          {t.secondaryAction && (
            <button
              type="button"
              className="cbtn cbtn--sm toast-action-btn"
              onClick={() => {
                t.secondaryAction!.onClick();
                dismiss(t.id);
              }}
            >
              {t.secondaryAction.label}
            </button>
          )}
          {details && (
            <button
              type="button"
              className="cbtn cbtn--sm toast-action-btn"
              aria-expanded={open}
              onClick={() => {
                // Open, it holds the toast; closed again, the time runs on.
                if (open) resumeTimer(t.id, "details");
                else pauseTimer(t.id, "details");
                setOpen((o) => !o);
              }}
            >
              Details
            </button>
          )}
          {/* E3: what waits behind this one, as a press that shows the next
              (this one goes behind the others, with what is left of its time). */}
          {waiting > 0 && (
            <button
              type="button"
              className="cbtn cbtn--sm cbtn--quiet toast-more"
              title="Show the next one"
              onClick={() => {
                onMore();
                showWaiting();
              }}
            >
              {moreMessagesLabel(waiting)}
            </button>
          )}
        </div>
      )}
      {details && open && (
        <div className="toast-details">
          <pre className="toast-details-text">{details}</pre>
          <button
            type="button"
            className="cbtn cbtn--sm toast-action-btn"
            onClick={() => {
              navigator.clipboard.writeText(details).catch(() => {});
            }}
          >
            <Icon name="copy" />
            Copy the details
          </button>
        </div>
      )}
    </div>
  );
}
