/**
 * Walk follow-ups 2026-10-19: where a `⋯` menu opens so all of it is seen.
 *
 * A menu opens below its trigger with its right edge on the trigger's (or its
 * left edge, a navigation menu). In a skill's page the `⋯` sits at the
 * panel's left, so the leftward menu was cut by the panel edge; a row at the
 * bottom of the list opened its menu past the window's bottom. Measured once
 * it is drawn, the menu turns to the side and the direction that fit.
 *
 * Pure: the caller measures the boxes (`getBoundingClientRect`) and the
 * bounds (the viewport, narrowed by every ancestor that clips).
 */

export interface MenuBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface MenuPlacement {
  /** Left edge on the trigger's left edge, opening rightwards. */
  start: boolean;
  /** Right edge on the trigger's right edge, opening leftwards. */
  end: boolean;
  /** Opens above the trigger. */
  up: boolean;
  /** Challenger: the room on the side it opens to, when the menu is taller
   *  than that room on both sides — the menu then scrolls inside it rather
   *  than run past the edge. `null`: it fits as it is. */
  maxHeight: number | null;
}

/** The gap between trigger and menu (`--page-space-xs`). */
const GAP = 4;

export function menuPlacement(menu: MenuBox, anchor: MenuBox, bounds: MenuBox): MenuPlacement {
  const width = menu.right - menu.left;
  const height = menu.bottom - menu.top;
  let start = false;
  let end = false;
  if (menu.left < bounds.left) {
    // Past the left edge: open rightwards from the trigger's left — when that
    // fits better than where it is.
    const right = anchor.left + width;
    if (right <= bounds.right || right - bounds.right < bounds.left - menu.left) start = true;
  } else if (menu.right > bounds.right) {
    const left = anchor.right - width;
    if (left >= bounds.left || bounds.left - left < menu.right - bounds.right) end = true;
  }
  // Below it doesn't fit: above, when there is more room there.
  const below = bounds.bottom - (anchor.bottom + GAP);
  const above = anchor.top - GAP - bounds.top;
  const up = menu.top >= anchor.top && height > below && above > below;
  const room = Math.floor((up ? above : below) - GAP);
  const maxHeight = height > room && room > 0 ? room : null;
  return { start, end, up, maxHeight };
}

const CLIPS = ["hidden", "clip", "auto", "scroll"];

/** The part of the viewport `el` can be seen in: the window, narrowed by
 *  every ancestor that clips its overflow. */
export function visibleBounds(el: Element): MenuBox {
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  const bounds: MenuBox = {
    left: 0,
    top: 0,
    right: doc.documentElement.clientWidth || view?.innerWidth || 0,
    bottom: doc.documentElement.clientHeight || view?.innerHeight || 0,
  };
  for (let node = el.parentElement; node && node !== doc.documentElement; node = node.parentElement) {
    const style = view?.getComputedStyle(node);
    if (!style) break;
    const clipsX = CLIPS.includes(style.overflowX || style.overflow);
    const clipsY = CLIPS.includes(style.overflowY || style.overflow);
    if (!clipsX && !clipsY) continue;
    const box = node.getBoundingClientRect();
    // jsdom (and a node not laid out) measures 0 × 0: nothing to learn.
    if (box.width === 0 && box.height === 0) continue;
    if (clipsX) {
      bounds.left = Math.max(bounds.left, box.left);
      bounds.right = Math.min(bounds.right, box.right);
    }
    if (clipsY) {
      bounds.top = Math.max(bounds.top, box.top);
      bounds.bottom = Math.min(bounds.bottom, box.bottom);
    }
  }
  return bounds;
}
