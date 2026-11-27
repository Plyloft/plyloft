/**
 * Getting started TU-3 (docs/tutorial/TUTORIAL_SPEC.md §4.3): finding a
 * tour anchor on screen. The one lookup the coach-mark (TU-4) and the
 * release walk use; nothing else queries `data-ply-tour`.
 *
 * Why a lookup and not `querySelector`: every warmed workspace keeps its
 * hosts mounted and hides the inactive ones (`.hidden`: visibility hidden,
 * pointer-events none — AGENTS.md, PATTERNS "one host per warmed
 * workspace"). An anchor drawn inside a per-workspace host (Terminals' New,
 * Code's More, the card page) is therefore in the DOM once per warmed
 * workspace, and the first match may be a hidden one. "Exactly one visible
 * element" (§4.3) means: of all the matches, exactly one is outside every
 * hidden host, closed card section and inert layer, and not under a modal or
 * the sidebar overlay.
 */
import type { TourAnchor } from "./manifest.ts";

export function tourSelector(anchor: TourAnchor): string {
  return `[data-ply-tour="${anchor}"]`;
}

/**
 * What hides a mounted element without unmounting it:
 * - `.hidden`: a warmed host that is not the active one (tile-grid-host,
 *   center-card-host, center-mode-host, the sticky Code and Library hosts);
 * - `[inert]` / `[aria-hidden="true"]`: a closed card section, the card body
 *   behind Release…, the shell under Setup and Sign in (`.app-shell-under`),
 *   the sidebar overlay's scrim;
 * - the stage under All skills (`.center-stage--app-page`), which hides every
 *   host but its own.
 */
const HIDING = '.hidden, [inert], [aria-hidden="true"]';

/**
 * What covers the rest of the window while it is up, without making it inert:
 * a modal (Settings, Search, a `Sheet` such as Ship batch or one over the
 * card) and the sidebar's overlay in a narrow window. An anchor outside the
 * topmost one is under it, so it is not on screen. The tour's own panel and
 * coach-mark (TU-4) are therefore never `aria-modal`.
 */
const COVERING = '[role="dialog"][aria-modal="true"], .shell-sidebar-slot--overlay';

/** jsdom has no layout: every box is empty there, so only the rules above
 *  apply in tests. */
function inJsdom(): boolean {
  return typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);
}

function hiddenByMarkup(el: Element): boolean {
  if (el.closest(HIDING)) return true;
  const stage = el.closest(".center-stage--app-page");
  return stage != null && el.closest(".center-mode-allskills") == null;
}

/** The browser's word on CSS the markup rules do not name (`display: none`,
 *  `visibility: hidden` set by a stylesheet). `checkVisibility` is WebKit
 *  17.4+ and Chromium 105+; the app runs from macOS 11 (`minimumSystemVersion`),
 *  whose WebKit may not have it, so without it the box and the computed
 *  visibility decide. */
function laidOut(el: Element): boolean {
  if (inJsdom()) return true;
  const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (typeof check === "function") {
    // Both spellings: `checkVisibilityCSS` is the older one (WebKit 17.4,
    // Chromium 105), `visibilityProperty` the newer.
    return check.call(el, { checkVisibilityCSS: true, visibilityProperty: true });
  }
  if (el.getClientRects().length === 0) return false;
  const view = el.ownerDocument.defaultView;
  return view == null || view.getComputedStyle(el).visibility !== "hidden";
}

export function tourAnchorShown(el: Element): boolean {
  if (hiddenByMarkup(el)) return false;
  const layers = [...el.ownerDocument.querySelectorAll(COVERING)].filter(
    (layer) => !hiddenByMarkup(layer) && laidOut(layer),
  );
  const top = layers[layers.length - 1];
  if (top && !top.contains(el)) return false;
  return laidOut(el);
}

/** TU-5: a modal (a sheet, Settings, Search) is on screen. A sheet drawn
 *  inside the card's page sits in that page's layer, under the tour's
 *  panel, so the tour stands aside while one is up (TU-4 walk: the panel
 *  covered Try it's Save and try). */
export function modalShown(root: Document = document): boolean {
  return [...root.querySelectorAll('[role="dialog"][aria-modal="true"]')].some(
    (layer) => !layer.closest(TOUR_SURFACES) && !hiddenByMarkup(layer) && laidOut(layer),
  );
}

/** 1.171.0 (E2; walk 2026-10-27 #2/#3): a menu or a popover of the page is
 *  open (the card's ⋯, Ship it's ▾, a picker's popover): the coach-mark
 *  steps aside until it closes, so it never sits on what the person opened. */
export const PAGE_POPUPS = '[role="menu"], .ux-popover';

export function popupShown(root: Document = document): boolean {
  return [...root.querySelectorAll(PAGE_POPUPS)].some(
    (layer) => !layer.closest(TOUR_SURFACES) && !hiddenByMarkup(layer) && laidOut(layer),
  );
}

/** 1.171.0 (E2; walk 2026-10-27 #4g): the card's Now box — what the card
 *  says it is doing — is what a coach-mark covers last (`NOW_WEIGHT`). */
export const NOW_BOX = ".ux-card-now";
export const NOW_WEIGHT = 8;

/** The Now box on screen, as one more box the coach-mark keeps clear of;
 *  none when the page shows none. */
export function nowBoxes(root: Document = document): { left: number; top: number; width: number; height: number; weight: number }[] {
  const out: { left: number; top: number; width: number; height: number; weight: number }[] = [];
  for (const el of root.querySelectorAll(NOW_BOX)) {
    if (hiddenByMarkup(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    out.push({ left: r.left, top: r.top, width: r.width, height: r.height, weight: NOW_WEIGHT });
  }
  return out;
}

/** Every element carrying the anchor that is on screen, in document order. */
export function shownTourAnchors(anchor: TourAnchor, root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(tourSelector(anchor))].filter(tourAnchorShown);
}

/**
 * The anchor's one visible element, or null when it is not on screen (another
 * mode, a closed section, a menu not open): the coach-mark then falls back
 * to the panel's instruction and Take me there (§3.2).
 */
export function findTourAnchor(anchor: TourAnchor, root: ParentNode = document): HTMLElement | null {
  return shownTourAnchors(anchor, root)[0] ?? null;
}

/** What a coach-mark should not sit on: the controls a person presses or types in. */
const CONTROLS =
  'button, input, textarea, select, a[href], [role="button"], [role="tab"], [contenteditable="true"], [contenteditable=""], .ux-prop';
/** The tour's own surfaces: never counted as something to keep clear of,
 *  but the Guide panel is (its box is added by the caller). */
const TOUR_SURFACES = "[data-ply-tour-panel], [data-ply-tour-coach]";

/**
 * TU-4 Mac walk: the boxes of the controls on screen near `target` (within
 * `reach` px of it), other than the target and what it holds — what the
 * coach-mark tries not to cover (`placeCoach`'s `avoid`).
 */
export function nearbyControls(
  target: Element,
  reach: number,
): { left: number; top: number; width: number; height: number; weight?: number }[] {
  const t = target.getBoundingClientRect();
  const out: { left: number; top: number; width: number; height: number; weight?: number }[] = [];
  // Run on each placement (a look, a resize, a scroll that moves the
  // control; one per frame at most): the box test first — layout is already
  // fresh from the target's own box, so it is a read — and the ancestor
  // walks only for the few controls near it.
  for (const el of target.ownerDocument.querySelectorAll(CONTROLS)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right < t.left - reach || r.left > t.right + reach || r.bottom < t.top - reach || r.top > t.bottom + reach) {
      continue;
    }
    if (el === target || target.contains(el) || el.contains(target)) continue;
    if (el.closest(TOUR_SURFACES) || hiddenByMarkup(el)) continue;
    const box = { left: r.left, top: r.top, width: r.width, height: r.height };
    // TU-5 Mac walk: a field someone writes in (the brief just written)
    // costs more to cover than a button beside it.
    out.push(el.matches(TYPING) ? { ...box, weight: TYPING_WEIGHT } : box);
  }
  return out;
}

/** What a person writes in: `nearbyControls` weighs it `TYPING_WEIGHT`. */
const TYPING = 'textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), [contenteditable="true"], [contenteditable=""]';
export const TYPING_WEIGHT = 4;

/**
 * TU-5 Mac walk: the fields the Guide panel keeps clear of (`panelCap`) —
 * the empty Board's *What do you want to build?* and the card's What you
 * want — as they are on screen now.
 */
export const KEEP_CLEAR_FIELDS = '.board-empty-field, [data-ply-tour="card-brief"]';

/** Those fields' elements on screen now (followed for a resize by hand). */
export function keepClearElements(root: Document = document): Element[] {
  return [...root.querySelectorAll(KEEP_CLEAR_FIELDS)].filter(tourAnchorShown);
}

/** The boxes of fields on screen, the empty ones left out. */
export function fieldBoxes(fields: readonly Element[]): { left: number; top: number; width: number; height: number }[] {
  const out: { left: number; top: number; width: number; height: number }[] = [];
  for (const el of fields) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    out.push({ left: r.left, top: r.top, width: r.width, height: r.height });
  }
  return out;
}
