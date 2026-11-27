import { useEffect, useRef, type RefObject } from "react";

/**
 * Esc for a part of a surface that must answer it before the surface
 * does: an open menu closes, a filled search field clears. The dialog stack
 * (lib/dialogFocus) listens on `document` in the capture phase, so this
 * listens one step earlier, on `window`, and only while focus is inside
 * `root`.
 */
export function useEscapeFirst(
  active: boolean,
  root: RefObject<HTMLElement | null>,
  onEscape: () => void,
): void {
  const handler = useRef(onEscape);
  handler.current = onEscape;
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const el = root.current;
      if (!el || !el.contains(document.activeElement)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      handler.current();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, root]);
}
