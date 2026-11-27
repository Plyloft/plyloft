/**
 * H1 (1.173.0): the window's heartbeat for the Rust watchdog
 * (`src-tauri/src/watchdog.rs`).
 *
 * One tiny IPC call (`watchdog_beat`) every 2 s while the page is visible and
 * every 30 s while it is hidden — a hidden page's timers are slowed anyway,
 * and the watchdog never calls a hidden window silent. A change of
 * visibility beats at once, so the watchdog knows straight away. Nothing is
 * logged per beat, on either side.
 *
 * Pure over its timer and visibility hooks so the test drives it with a fake
 * clock; `main.tsx` wires it to `setTimeout` and `document`.
 */

export const BEAT_VISIBLE_MS = 2_000;
export const BEAT_HIDDEN_MS = 30_000;

export interface HeartbeatHost {
  /** Sends one beat; a failure is ignored (the next beat tries again). */
  send: (visible: boolean) => void;
  isVisible: () => boolean;
  /** Calls `listener` on every visibility change; returns the unsubscribe. */
  onVisibilityChange: (listener: () => void) => () => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

/** The interval for the page's current visibility. */
export function beatInterval(visible: boolean): number {
  return visible ? BEAT_VISIBLE_MS : BEAT_HIDDEN_MS;
}

/** Starts beating; the returned function stops it. */
export function startHeartbeat(host: HeartbeatHost): () => void {
  let timer: unknown = null;
  let stopped = false;
  const beat = () => {
    if (stopped) return;
    const visible = host.isVisible();
    try {
      host.send(visible);
    } catch {
      // The next beat tries again.
    }
    timer = host.setTimer(beat, beatInterval(visible));
  };
  const unsubscribe = host.onVisibilityChange(() => {
    if (timer != null) host.clearTimer(timer);
    timer = null;
    beat();
  });
  beat();
  return () => {
    stopped = true;
    unsubscribe();
    if (timer != null) host.clearTimer(timer);
    timer = null;
  };
}

/** The real page: `document`'s visibility and the global timers. */
export function installHeartbeat(send: (visible: boolean) => void): () => void {
  return startHeartbeat({
    send,
    isVisible: () => document.visibilityState === "visible",
    onVisibilityChange: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
}
