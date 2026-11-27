import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * v1.63.0: whether the app window is visible to the user. Drives the
 * pause/slow-down of cosmetic 1Hz tickers while the window is hidden
 * (window-close *hides* in Atelier — Hard Rule #5 — so the app spends a
 * lot of its life hidden; idle wakeups are pure battery cost there).
 *
 * One module-level `visibilitychange` listener feeds every subscriber —
 * N components share one DOM listener instead of registering N of them.
 *
 * Belt-and-braces: WKWebView is *expected* to flip `document.hidden` on
 * `window.hide()`, but if it ever doesn't, the Tauri `onFocusChanged`
 * signal forces `visible = true` on focus. It is deliberately resume-only
 * (never marks hidden — a window can be unfocused yet fully visible), so
 * the worst failure mode is timers that keep running (the pre-1.63 status
 * quo), never a frozen UI.
 */

let visible = typeof document !== "undefined" ? !document.hidden : true;
const listeners = new Set<() => void>();

function setVisible(v: boolean) {
  if (v === visible) return;
  visible = v;
  for (const l of listeners) l();
}

let wired = false;
function wireOnce() {
  if (wired) return;
  wired = true;
  document.addEventListener("visibilitychange", () => {
    setVisible(!document.hidden);
  });
  try {
    // getCurrentWindow() THROWS synchronously outside a Tauri context
    // (vite preview, headless smoke test) — guard, don't just .catch().
    getCurrentWindow()
      .onFocusChanged((e) => {
        if (e.payload) setVisible(true);
      })
      .catch(() => {
        // listener registration failed — visibilitychange still covers us
      });
  } catch {
    // not running under Tauri — visibilitychange alone is fine
  }
}

function subscribe(cb: () => void): () => void {
  wireOnce();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): boolean {
  return visible;
}

export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}
