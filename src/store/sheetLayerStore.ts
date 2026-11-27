// X2 round 1 (owner, 2026-10-31): how many sheets are open, anywhere —
// Settings', Setup's or the shell's. 1.176.1: a toast raised while one is open
// is drawn above it (`toastLayer`), so it is seen.
import { create } from "zustand";

export const useOpenSheets = create<{ count: number }>(() => ({ count: 0 }));

/** A mounted `<Sheet>` holds one; the returned function lets it go. */
export function holdSheetOpen(): () => void {
  useOpenSheets.setState((s) => ({ count: s.count + 1 }));
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    useOpenSheets.setState((s) => ({ count: Math.max(0, s.count - 1) }));
  };
}

/** The hosts the app hides (never unmounts) when their workspace or tab is
 *  not the one shown: `visibility: hidden` through a `hidden` class. */
const HOST = ".workspace-host, .tile-grid-host";

/** Whether `el` sits in a host that is hidden now. */
export function inHiddenHost(el: Element | null): boolean {
  const host = el?.closest(HOST);
  return !!host && host.classList.contains("hidden");
}

/** 1.176.1: a sheet counts only while it can be seen. One mounted in a
 *  warmed workspace's host that is hidden holds nothing, and holds again
 *  when that host is shown (the host's class is watched). */
export function holdSheetWhileVisible(el: Element | null): () => void {
  const host = el?.closest(HOST) ?? null;
  let release: (() => void) | null = null;
  const sync = () => {
    const hidden = !!host && host.classList.contains("hidden");
    if (hidden && release) {
      release();
      release = null;
    } else if (!hidden && !release) release = holdSheetOpen();
  };
  sync();
  let observer: MutationObserver | null = null;
  if (host && typeof MutationObserver !== "undefined") {
    observer = new MutationObserver(sync);
    observer.observe(host, { attributes: true, attributeFilter: ["class"] });
  }
  return () => {
    observer?.disconnect();
    release?.();
    release = null;
  };
}
