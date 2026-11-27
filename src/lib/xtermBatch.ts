/**
 * v1.63.0: write batcher for xterm instances fed by Tauri PTY/agent events.
 *
 * The backend already coalesces `pty://data` (pty.rs, 8ms window), but each
 * event still lands as its own `term.write()` call. Batching writes behind
 * requestAnimationFrame aligns terminal parsing/rendering with the frame the
 * user actually sees and collapses multi-event bursts into one write.
 *
 * Footgun (see docs/PATTERNS.md): rAF does NOT fire while the document is
 * hidden in WKWebView — and window-close *hides* in Atelier (Hard Rule #5).
 * Without a fallback, a hidden window would stop ingesting scrollback until
 * reopened. Every schedule therefore arms BOTH an rAF and a setTimeout
 * fallback; whichever fires first flushes and cancels the other.
 */

const FALLBACK_FLUSH_MS = 50;

export type WriteBatcher = {
  push(data: Uint8Array): void;
  /** Flush pending bytes synchronously (e.g. before an exit banner). */
  flush(): void;
  /** Flush, then drop everything. Call BEFORE `term.dispose()`. */
  dispose(): void;
};

export function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export function createWriteBatcher(
  write: (data: Uint8Array) => void,
): WriteBatcher {
  let pending: Uint8Array[] = [];
  let rafId: number | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const cancelScheduled = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  const flush = () => {
    cancelScheduled();
    if (disposed || pending.length === 0) return;
    const batch = pending.length === 1 ? pending[0] : concatChunks(pending);
    pending = [];
    write(batch);
  };

  return {
    push(data) {
      if (disposed) return;
      pending.push(data);
      if (rafId !== null || timerId !== null) return; // already scheduled
      rafId = requestAnimationFrame(() => {
        rafId = null;
        flush();
      });
      timerId = setTimeout(() => {
        timerId = null;
        flush();
      }, FALLBACK_FLUSH_MS);
    },
    flush,
    dispose() {
      flush();
      disposed = true;
      cancelScheduled();
      pending = [];
    },
  };
}
