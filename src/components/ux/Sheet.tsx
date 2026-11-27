import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { TidyShareContext } from "./useTidyTable";
import { useDialogFocus } from "../../lib/dialogFocus";
import { machineWords } from "../../lib/platform";
import { forMachine } from "./Page";
import { holdSheetWhileVisible } from "../../store/sheetLayerStore";

/**
 * UX language card 2 (SHEET.md "Review sheet, confirmation", "ConfirmSheet"):
 * a surface centred over the page on the backdrop. `review` is 640 px wide
 * and lists one card per change; `confirm` is 480–520 px and asks one
 * question; `wide` (UX-10.1) holds a workbench — the independent discussion —
 * at up to 1080 × 780 px. Esc closes it before the surface under it (the
 * shared dialog stack), and Tab stays inside.
 *
 * `canDismiss` false (a press is running) keeps it up: Esc and the backdrop
 * wait. `initialFocusRef` names what takes focus on open (the surface itself
 * by default).
 */
export function Sheet({
  title,
  lede,
  size = "review",
  onClose,
  canDismiss = true,
  initialFocusRef,
  footNote,
  leadAction,
  actions,
  children,
  asIs,
}: {
  /** 1.173.0 (C2): title and lede are this platform's words already
   *  (names quoted as they are): drawn without `machineWords`. */
  asIs?: boolean;
  title: string;
  lede?: ReactNode;
  size?: "review" | "confirm" | "wide";
  onClose: () => void;
  canDismiss?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** The line on the left of the foot (`One commit · .atelier/workspace.json`). */
  footNote?: ReactNode;
  /** The way out that loses something, kept away from the safe ones. */
  leadAction?: ReactNode;
  /** The foot's buttons; none, and the sheet has no foot. */
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus({
    containerRef: surface,
    initialFocusRef: initialFocusRef ?? surface,
    onDismiss: onClose,
    canDismiss,
  });
  // X2 round 1: a toast raised while a sheet is open is drawn above it (ToastStack).
  useEffect(() => holdSheetWhileVisible(surface.current), []);
  const cls =
    size === "confirm"
      ? "ux-sheet ux-sheet--confirm"
      : size === "wide"
        ? "ux-sheet ux-sheet--wide"
        : "ux-sheet";
  return (
    <div
      className="ux-sheet-backdrop"
      onClick={() => {
        if (canDismiss) onClose();
      }}
    >
      <div
        ref={surface}
        className={cls}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => scrollBodyByKey(e, body.current)}
      >
        <div className="ux-sheet-head">
          <h2 id={titleId} className="ux-sheet-title">
            {asIs ? title : machineWords(title)}
          </h2>
          {lede && <p className="ux-sheet-lede">{asIs ? lede : forMachine(lede)}</p>}
        </div>
        {children && (
          <div ref={body} className="ux-sheet-body">
            {/* F6: a sheet opened from a page that shares its table columns
                (TidyColumns) is portalled but keeps the page's context: its
                tables stay their own. */}
            <TidyShareContext.Provider value={null}>{children}</TidyShareContext.Provider>
          </div>
        )}
        {(actions || footNote || leadAction) && (
          <div className="ux-sheet-foot">
            {footNote && <span className="ux-sheet-note">{footNote}</span>}
            {leadAction}
            <span className="ux-sheet-spacer" />
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}

/** 1.169.0 Mac walk: a sheet taller than the window scrolls its body from
 *  the keyboard too — Page Up/Down, Home and End — wherever focus is in it
 *  (the surface, a button in its foot), except in a field that uses those
 *  keys itself. Exported for tests. */
export function scrollBodyByKey(e: KeyboardEvent<HTMLElement>, body: HTMLElement | null): void {
  if (!body || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target as HTMLElement;
  if (target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='menu'], [role='listbox']")) return;
  const page = Math.max(body.clientHeight - 40, 40);
  const to =
    e.key === "PageDown"
      ? body.scrollTop + page
      : e.key === "PageUp"
        ? body.scrollTop - page
        : e.key === "Home" && target === e.currentTarget
          ? 0
          : e.key === "End" && target === e.currentTarget
            ? body.scrollHeight
            : null;
  if (to === null) return;
  e.preventDefault();
  if (typeof body.scrollTo === "function") body.scrollTo({ top: to });
  else body.scrollTop = to;
}

/** One change in a sheet: the label, `old → new`, then what it does. */
export function SheetChange({
  label,
  from,
  to,
  consequence,
  children,
}: {
  label: string;
  from: string;
  to: string;
  consequence?: ReactNode;
  /** A `Details` disclosure, when the change has more to show. */
  children?: ReactNode;
}) {
  return (
    <div className="ux-sheet-change">
      <p className="ux-sheet-change-label">{label}</p>
      <p className="ux-sheet-change-values">
        <span className="ux-sheet-was">{from}</span>
        <span className="ux-sheet-arrow" aria-label="becomes">
          →
        </span>
        <span className="ux-sheet-now">{to}</span>
      </p>
      {consequence && <p className="ux-sheet-change-why">{consequence}</p>}
      {children}
    </div>
  );
}
