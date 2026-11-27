// A tile's fire-and-forget calls into its PTY, after the PTY is gone.
//
// Closing a tile kills its PTY first (`tileStore.closeTile` → `ptyKill`) and
// the tile leaves only on the `pty://exit` that follows. In between the xterm
// is still mounted: the click on ✕ blurs it (a TUI with focus reporting gets
// `ESC [ O` through `onData`) and the grid reflows (its ResizeObserver fires).
// Rust answers both with "pty not found" (`pty.rs` write/resize), and the
// un-awaited promise surfaced as "[ERROR] unhandled rejection: pty not found"
// (walk 2026-09-30).
//
// So: a PTY that Plyloft killed, or that has exited, is not written to or
// resized again, and the one race left — a call already in flight when the
// session went — is ignored when it says "pty not found". Any other error
// still rejects, unhandled, as before: nothing else is swallowed.

/** Rust's words for a session that is no longer in the registry (`pty.rs`). */
export const PTY_GONE = "pty not found";

/** The rejection says the PTY session is gone — nothing else. */
export function isPtyGone(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes(PTY_GONE);
}

// Ids Plyloft has asked Rust to kill. PTY ids are never reused, and a closed
// tile's id is a few bytes, so the set is not pruned.
const closing = new Set<string>();

/** Plyloft is killing this PTY: no more writes or resizes go to it. */
export function markPtyClosing(id: string): void {
  closing.add(id);
}

export function isPtyClosing(id: string): boolean {
  return closing.has(id);
}

export interface PtyCalls {
  write: (id: string, data: Uint8Array) => Promise<unknown>;
  resize: (id: string, cols: number, rows: number) => Promise<unknown>;
}

export interface GuardedPty {
  /** Sent unless the PTY is closing or gone; "pty not found" is ignored. */
  write: (data: Uint8Array) => void;
  resize: (cols: number, rows: number) => void;
  /** The PTY exited, or its terminal is being disposed: stop calling it. */
  close: () => void;
  readonly open: boolean;
}

/** One PTY's fire-and-forget write/resize, closed once the PTY is gone. */
export function guardPty(id: string, calls: PtyCalls): GuardedPty {
  let closed = false;
  const live = () => !closed && !closing.has(id);
  const settle = (call: Promise<unknown>) => {
    call.catch((error: unknown) => {
      if (isPtyGone(error)) {
        closed = true;
        return;
      }
      throw error;
    });
  };
  return {
    write(data) {
      if (live()) settle(calls.write(id, data));
    },
    resize(cols, rows) {
      if (live()) settle(calls.resize(id, cols, rows));
    },
    close() {
      closed = true;
    },
    get open() {
      return live();
    },
  };
}
