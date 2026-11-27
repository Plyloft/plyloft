import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable]:not([contenteditable="false"])',
].join(",");

type Options = {
  active?: boolean;
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onDismiss: () => void;
  canDismiss?: boolean;
  /** True while another dialog is drawn above this one (a sheet over the
   *  Settings shell): Esc and Tab are left to it untouched. */
  yieldTo?: () => boolean;
};

type DialogStackEntry = {
  token: symbol;
  containerRef: RefObject<HTMLElement | null>;
};

const dialogStack: DialogStackEntry[] = [];

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (element) =>
      element.getAttribute("aria-hidden") !== "true" &&
      element.getAttribute("aria-disabled") !== "true" &&
      element.getClientRects().length > 0,
  );
}

/** Focus in something a person types in or chooses from. */
export function inField(element: Element | null): boolean {
  return element?.matches("input, textarea, select, [contenteditable='true']") ?? false;
}

function isFocusVisible(element: HTMLElement): boolean {
  for (
    let current: HTMLElement | null = element;
    current;
    current = current.parentElement
  ) {
    // OB-4: a dialog under an inert layer (the shell under Setup) is not on
    // top of anything the person can reach; it must not take Esc or Tab.
    if (current.hasAttribute("inert")) return false;
    const style = window.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

function topVisibleDialogToken(): symbol | null {
  for (let index = dialogStack.length - 1; index >= 0; index -= 1) {
    const container = dialogStack[index]?.containerRef.current;
    if (container && isFocusVisible(container)) {
      return dialogStack[index]?.token ?? null;
    }
  }
  return null;
}

/** Shared modal focus contract for the bounded P3-5 dialog set. It owns only
 * DOM focus and dismissal ordering; product actions stay in each caller. */
export function useDialogFocus({
  active = true,
  containerRef,
  initialFocusRef,
  onDismiss,
  canDismiss = true,
  yieldTo,
}: Options): void {
  const dismissRef = useRef(onDismiss);
  const canDismissRef = useRef(canDismiss);
  const yieldRef = useRef(yieldTo);
  dismissRef.current = onDismiss;
  canDismissRef.current = canDismiss;
  yieldRef.current = yieldTo;

  useEffect(() => {
    if (!active) return;
    const token = Symbol("dialog-focus");
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialogStack.push({ token, containerRef });

    const frame = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) return;
      // 1.174.0 X1: focus moved inside the dialog since it opened (its list
      // taking focus once loaded, a press the person made) is kept; the
      // first frame doesn't take it back. 1.179.0: neither is a field of the
      // dialog that took focus as it was drawn (`autoFocus`, which this
      // effect then reads as the opener), unless the dialog names what takes
      // focus: a dialog whose choice is only its own surface names nothing.
      const now = document.activeElement;
      const named = initialFocusRef?.current;
      if (now instanceof HTMLElement && container.contains(now) && (now !== opener || !named || named === container)) return;
      const initial = initialFocusRef?.current ?? focusableElements(container)[0];
      (initial ?? container).focus({ preventScroll: true });
    });

    function onKey(event: KeyboardEvent) {
      if (topVisibleDialogToken() !== token) return;
      if (event.key === "Escape" || event.key === "Tab") {
        if (yieldRef.current?.()) return;
      }
      const container = containerRef.current;
      if (!container) return;

      if (event.key === "Escape") {
        const target = event.target as HTMLElement | null;
        const disclosure = target?.closest<HTMLDetailsElement>("details[open]");
        if (disclosure && container.contains(disclosure)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          disclosure.open = false;
          disclosure.querySelector<HTMLElement>(":scope > summary")?.focus();
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        if (canDismissRef.current) dismissRef.current();
        return;
      }

      if (event.key !== "Tab") return;
      const focusable = focusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }
      const activeElement = document.activeElement as HTMLElement | null;
      const current = activeElement ? focusable.indexOf(activeElement) : -1;
      if (event.shiftKey && (current <= 0 || !container.contains(activeElement))) {
        event.preventDefault();
        focusable[focusable.length - 1]?.focus();
      } else if (
        !event.shiftKey &&
        (current === focusable.length - 1 || !container.contains(activeElement))
      ) {
        event.preventDefault();
        focusable[0]?.focus();
      }
    }

    document.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey, true);
      const index = dialogStack.findIndex((entry) => entry.token === token);
      if (index >= 0) dialogStack.splice(index, 1);
      requestAnimationFrame(() => {
        // The frame can come late: somebody already typing somewhere keeps it.
        if (inField(document.activeElement)) return;
        if (opener?.isConnected && isFocusVisible(opener)) {
          opener.focus({ preventScroll: true });
        }
      });
    };
  }, [active, containerRef, initialFocusRef]);
}
