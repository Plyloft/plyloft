// N14 walk F6: a panel, plan or notice that opens or fills inline in answer to
// a press must not appear below the fold unnoticed. When it shows, it is
// brought into view (smoothly, unless the person asked for reduced motion)
// and focus moves to its heading, so a screen reader and the keyboard land
// on it too.
import { useEffect, useRef, type RefObject } from "react";

/** Whether the person asked the system for less motion. */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export interface RevealOptions {
  /** Move focus to the heading (the default). Off where the content holds
   *  its own first field with autoFocus. */
  focus?: boolean;
  /** Where the content lands: `start` for a flow or plan, `nearest` (the
   *  default) for a line that only has to be seen. */
  block?: ScrollLogicalPosition;
}

/**
 * Bring `el` into view and focus its heading: the element marked
 * `data-reveal-focus`, else its first `h1`–`h3`, else the element itself. A
 * heading gets `tabindex="-1"` so it can hold focus without joining the Tab
 * order; `preventScroll` keeps the focus from jumping ahead of the smooth
 * scroll.
 */
export function revealElement(el: HTMLElement | null, options: RevealOptions = {}): void {
  if (!el) return;
  const { focus = true, block = "nearest" } = options;
  el.scrollIntoView?.({ behavior: prefersReducedMotion() ? "auto" : "smooth", block });
  if (!focus) return;
  const target =
    el.querySelector<HTMLElement>("[data-reveal-focus]") ??
    el.querySelector<HTMLElement>("h1, h2, h3") ??
    el;
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  // Marked so ux.css draws no ring on it: a heading, not a control.
  target.setAttribute("data-reveal-target", "");
  target.focus({ preventScroll: true });
}

/** Long enough for a smooth scroll to end, and the local read after a write. */
export const REVEAL_SETTLE_MS = 800;
const PERSON_MOVES = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

/**
 * Walk 2026-11-04: a smooth scroll can stop short when the page changes under
 * it, and nothing says so. After `REVEAL_SETTLE_MS` this puts `el` where the
 * reveal meant it, at once; where it already is, that moves nothing. A person
 * who scrolled, typed or pressed since keeps their place. Returns its cancel.
 */
export function settleReveal(el: HTMLElement | null, block: ScrollLogicalPosition = "start"): () => void {
  if (!el) return () => {};
  const stop = () => {
    window.clearTimeout(timer);
    for (const move of PERSON_MOVES) window.removeEventListener(move, stop, true);
  };
  const timer = window.setTimeout(() => {
    stop();
    el.scrollIntoView?.({ behavior: "auto", block });
  }, REVEAL_SETTLE_MS);
  for (const move of PERSON_MOVES) window.addEventListener(move, stop, { capture: true, passive: true });
  return stop;
}

/**
 * A ref for content that appears in answer to an action. Each time `key`
 * becomes a new truthy value (the plan for another login, a refusal's text)
 * the content is revealed with `revealElement`; a falsy key reveals nothing.
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>(
  key: unknown,
  options: RevealOptions = {},
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const { focus = true, block = "nearest" } = options;
  useEffect(() => {
    if (!key) return;
    revealElement(ref.current, { focus, block });
  }, [key, focus, block]);
  return ref;
}
