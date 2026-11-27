import { useEffect, useRef, useState, type ReactNode, type PointerEvent, type KeyboardEvent } from "react";
import { useSettings } from "../store/settingsStore";
import { saveSidebarLayout, toggleSidebar, useUi } from "../store/uiStore";
import { useNeedsYou, useNow } from "../hooks/useNeedsYou";
import { shortcutKeys } from "../lib/shortcuts";
import { Icon } from "./ux";
import { useStatusNeedsLook } from "./SidebarStatus";
import {
  clampSidebarWidth,
  SIDEBAR_KEY_STEP,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_OVERLAY_BELOW,
  sidebarLayoutOf,
  sidebarPresentation,
} from "../lib/sidebarLayout";
import { setupIsOpen } from "../store/setupStore";

/** The window's width, kept current on resize. */
export function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

/** Where the sidebar is drawn right now: docked, over the stage, or hidden. */
function useSidebarPresentation() {
  const savedWidth = useSettings((s) => sidebarLayoutOf(s.settings.windows).width);
  const collapsed = useSettings((s) => sidebarLayoutOf(s.settings.windows).collapsed);
  const overlayOpen = useUi((s) => s.sidebarOverlayOpen);
  const windowWidth = useWindowWidth();
  return sidebarPresentation({ width: savedWidth, collapsed }, windowWidth, overlayOpen);
}

/**
 * The stage header's sidebar button (UX-3.5). GH #323: a disclosure — it says
 * whether the sidebar is shown (`aria-expanded`) — and while the sidebar is
 * out of sight (below 1000 px, or hidden with ⌘\) it carries the sidebar's
 * signals: the Inbox count and a dot when a status row waits, both said in
 * its name.
 */
export function SidebarToggle() {
  const shown = useSidebarPresentation() !== "hidden";
  // One button whatever the presentation — focus returns to it when the
  // overlay closes — with the signal inside it only while it is needed.
  return (
    <button
      type="button"
      className="shell-icon-control shell-sidebar-toggle"
      aria-expanded={shown}
      title={`Show or hide the sidebar (${shortcutKeys("sidebar")})`}
      onClick={toggleSidebar}
    >
      <Icon name="sidebar" />
      {/* X6 (G1 Windows walk): the name in one node — two hidden spans read
          "Toggle sidebar , 1 needs you" in WebView2. */}
      {shown ? <span className="ux-sr-only">Toggle sidebar</span> : <SidebarSignal />}
    </button>
  );
}

function SidebarSignal() {
  const total = useNeedsYou(useNow()).total;
  const warn = useStatusNeedsLook();
  const said = [
    total > 0 ? `${total} need${total === 1 ? "s" : ""} you` : null,
    warn ? "a status needs a look" : null,
  ].filter(Boolean);
  return (
    <>
      <span className="ux-sr-only">{said.length > 0 ? `Toggle sidebar, ${said.join(", ")}` : "Toggle sidebar"}</span>
      {total > 0 && (
        <span className="shell-toggle-count" aria-hidden="true">
          {total > 99 ? "99+" : total}
        </span>
      )}
      {warn && total === 0 && (
        <span className="shell-dot shell-dot--warn shell-toggle-dot" aria-hidden="true" />
      )}
    </>
  );
}

/**
 * UX-3.4 (the Shell board): where the sidebar sits. Docked, it is a column of
 * its remembered width with a grip on its right edge (drag, or ←/→ when the
 * grip has focus; 200–320 px). ⌘\ hides it. Below a 1000 px window it leaves
 * the layout and opens over the stage — closed until ⌘\ or the header's
 * sidebar button asks, and closed again by a choice in it, a click outside or
 * Esc — so the stage keeps the full width.
 */
export function SidebarSlot({
  children,
}: {
  /** The sidebar; `onNavigate` closes the overlay after a choice. */
  children: (onNavigate?: () => void) => ReactNode;
}) {
  const savedWidth = useSettings((s) => sidebarLayoutOf(s.settings.windows).width);
  const collapsed = useSettings((s) => sidebarLayoutOf(s.settings.windows).collapsed);
  const overlayOpen = useUi((s) => s.sidebarOverlayOpen);
  const windowWidth = useWindowWidth();
  const presentation = sidebarPresentation(
    { width: savedWidth, collapsed },
    windowWidth,
    overlayOpen,
  );

  // The overlay does not outlive the narrow window it belongs to.
  useEffect(() => {
    if (windowWidth >= SIDEBAR_OVERLAY_BELOW && overlayOpen) {
      useUi.getState().setSidebarOverlayOpen(false);
    }
  }, [windowWidth, overlayOpen]);

  // GH #323: opening the overlay moves focus into it (the switcher, its
  // first row); closing it gives focus back to where it came from.
  const overlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (presentation !== "overlay") return;
    const from = document.activeElement as HTMLElement | null;
    const id = requestAnimationFrame(() => {
      const first =
        overlayRef.current?.querySelector<HTMLElement>(".shell-switcher-trigger") ??
        overlayRef.current?.querySelector<HTMLElement>("button, [href], input");
      first?.focus();
    });
    return () => {
      cancelAnimationFrame(id);
      if (from?.isConnected) from.focus();
    };
  }, [presentation]);

  // Esc closes the overlay.
  useEffect(() => {
    if (presentation !== "overlay") return;
    function onKey(e: globalThis.KeyboardEvent) {
      // OB-4: nothing under Setup answers a key while it is up.
      if (setupIsOpen()) return;
      if (e.key !== "Escape" || e.defaultPrevented) return;
      useUi.getState().setSidebarOverlayOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presentation]);

  // While dragging, the width is local; it is remembered on release.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const width = dragWidth ?? savedWidth;
  const widthRef = useRef(width);
  widthRef.current = width;

  function onGripDown(e: PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, w: width };
    setDragWidth(width);
  }
  function onGripMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    setDragWidth(clampSidebarWidth(d.w + e.clientX - d.x));
  }
  function onGripUp() {
    if (!drag.current) return;
    drag.current = null;
    saveSidebarLayout({ width: widthRef.current, collapsed: false });
    setDragWidth(null);
  }
  function onGripKey(e: KeyboardEvent<HTMLDivElement>) {
    const step =
      e.key === "ArrowLeft" ? -SIDEBAR_KEY_STEP : e.key === "ArrowRight" ? SIDEBAR_KEY_STEP : 0;
    if (!step) return;
    e.preventDefault();
    saveSidebarLayout({ width: clampSidebarWidth(width + step), collapsed: false });
  }

  if (presentation === "hidden") return null;

  if (presentation === "overlay") {
    const close = () => useUi.getState().setSidebarOverlayOpen(false);
    return (
      <>
        <div className="shell-sidebar-scrim" onClick={close} aria-hidden="true" />
        <div
          ref={overlayRef}
          className="shell-sidebar-slot shell-sidebar-slot--overlay"
          style={{ width: savedWidth }}
          data-presentation="overlay"
        >
          {children(close)}
        </div>
      </>
    );
  }

  return (
    <div
      className={`shell-sidebar-slot${dragWidth != null ? " is-resizing" : ""}`}
      style={{ width }}
      data-presentation="docked"
    >
      {children()}
      <div
        className="shell-sidebar-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="Sidebar width"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        title={`Drag to resize the sidebar · ${shortcutKeys("sidebar")} hides it`}
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
        onKeyDown={onGripKey}
      />
    </div>
  );
}
