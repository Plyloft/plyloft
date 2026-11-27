// UX-3.4 (the Shell board): the sidebar is 240 px, dragged between 200 and
// 320, hidden and shown with ⌘\, and below a 1000 px window it leaves the
// layout and opens over the stage instead, so a 900 px window never squeezes
// the stage. The width and the hidden flag are remembered on this Mac in
// `settings.windows.sidebar`; a file written before this card has no such key
// and reads as the defaults. Pure, so node can test it.

import type { Settings, SidebarLayout } from "./settingsShape.ts";

export const SIDEBAR_DEFAULT_WIDTH = 240;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 320;
/** Below this window width the sidebar is an overlay. */
export const SIDEBAR_OVERLAY_BELOW = 1000;
/** One arrow-key step on the resize grip. */
export const SIDEBAR_KEY_STEP = 8;

export const DEFAULT_SIDEBAR_LAYOUT: SidebarLayout = {
  width: SIDEBAR_DEFAULT_WIDTH,
  collapsed: false,
};

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

/** The layout a settings file holds, or the defaults when it holds none
 *  (every file written before UX-3.4) or holds nonsense. */
export function sidebarLayoutOf(
  windows: Partial<Settings["windows"]> | null | undefined,
): SidebarLayout {
  const saved = windows?.sidebar;
  if (!saved || typeof saved !== "object") return DEFAULT_SIDEBAR_LAYOUT;
  return {
    width: clampSidebarWidth(Number(saved.width)),
    collapsed: saved.collapsed === true,
  };
}

/** `latest` with the sidebar set to `next` — `latest` itself when nothing
 *  changes, so the settings queue sends nothing (GH #178). Only the sidebar
 *  key is touched: a preference saved meanwhile is never undone. */
export function withSidebarLayout(latest: Settings, next: SidebarLayout): Settings {
  const was = sidebarLayoutOf(latest.windows);
  const clean = { width: clampSidebarWidth(next.width), collapsed: next.collapsed };
  if (latest.windows?.sidebar && was.width === clean.width && was.collapsed === clean.collapsed) {
    return latest;
  }
  return { ...latest, windows: { ...latest.windows, sidebar: clean } };
}

export type SidebarPresentation = "docked" | "hidden" | "overlay";

/** How the sidebar is drawn: in the layout, not at all, or over the stage. */
export function sidebarPresentation(
  layout: SidebarLayout,
  windowWidth: number,
  overlayOpen: boolean,
): SidebarPresentation {
  if (windowWidth < SIDEBAR_OVERLAY_BELOW) return overlayOpen ? "overlay" : "hidden";
  return layout.collapsed ? "hidden" : "docked";
}
