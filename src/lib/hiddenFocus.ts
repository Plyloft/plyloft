/**
 * GH #95 (owner Tier 4, 2026-09-17): the keyboard never reaches a host the
 * user cannot see.
 *
 * Terminals, cards, Code and Knowledge stay mounted and are CSS-hidden when
 * inactive. WKWebView leaves the focus where it was when an element becomes
 * `visibility: hidden`, so after ⌘⌥2 from Code the keys typed over the Board
 * went into the hidden editor (and, the same way, into a hidden terminal
 * after a workspace switch). The shell therefore takes the focus away from a
 * hidden element when the visible host changes, remembers it, and gives it
 * back when its host is shown again and nothing else took the focus — coming
 * back to Code or Terminals still finds the cursor where it was.
 */

/** What an element looks like to the rule (as in `visibleModal`). */
export type FocusProbe = {
  /** `getClientRects().length` — 0 when it or an ancestor is `display:none`. */
  rects: number;
  /** Computed `visibility`, which inherits from the hidden host. */
  visibility: string;
};

export function isOffScreen(probe: FocusProbe): boolean {
  return probe.rects === 0 || probe.visibility === "hidden";
}

export type FocusAction = "release" | "restore" | "none";

/**
 * `active`: the focused element, null when the focus is on the page itself.
 * `remembered`: the element last released, null when there is none or it
 * left the document.
 */
export function focusAction(
  active: FocusProbe | null,
  remembered: FocusProbe | null,
): FocusAction {
  if (active) return isOffScreen(active) ? "release" : "none";
  if (remembered && !isOffScreen(remembered)) return "restore";
  return "none";
}

function probe(el: Element): FocusProbe {
  return {
    rects: el.getClientRects().length,
    visibility: getComputedStyle(el).visibility,
  };
}

/**
 * Apply the rule to the document. `remembered` is the caller's slot (a ref):
 * returns what it should hold next.
 */
export function settleFocus(
  remembered: HTMLElement | null,
  doc: Document = document,
): HTMLElement | null {
  const el = doc.activeElement;
  const active =
    el instanceof HTMLElement && el !== doc.body ? el : null;
  const kept = remembered && remembered.isConnected ? remembered : null;
  switch (focusAction(active ? probe(active) : null, kept ? probe(kept) : null)) {
    case "release":
      active!.blur();
      return active;
    case "restore":
      kept!.focus({ preventScroll: true });
      return null;
    default:
      // Something visible has the focus: the remembered element lost its turn.
      return active ? null : kept;
  }
}
