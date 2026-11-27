/**
 * Walk fix (blank Builder on the first start): how the Builder's terminal
 * joins the backend's capture to the live `pty://data` stream.
 *
 * The backend tees every byte the PTY prints into the session's capture as
 * it reads it, and emits the same bytes as `pty://data` events a moment
 * later. A Tauri event reaches only the listeners registered when it is
 * emitted — there is no replay. The terminal used to read the capture first
 * and subscribe afterwards (after a resize round-trip too), so whatever the
 * session printed between the two was in neither: not in the capture it had
 * already read, not in an event nobody was listening for. Claude's folder-
 * trust question is one frame drawn once, at start-up, and then the CLI
 * waits — when that frame fell in the gap the terminal stayed blank for
 * good, while the card (which scans the capture) said Claude was asking.
 *
 * Now the terminal subscribes first and holds what arrives, reads the
 * capture, and joins the two by stream offset: every event says where its
 * first byte sits in the session's output (`PtyDataEvent.offset`), the
 * capture says where it ends, and the bytes already replayed are dropped
 * from the live side. Each byte is written once, in order.
 *
 * Pure — no Tauri import — so it is unit-tested under node.
 */

export interface LiveChunk {
  /** Stream offset of the chunk's first byte; absent from an older backend,
   *  and then the chunk is written whole. */
  offset?: number;
  data: Uint8Array;
}

export interface ReplayJoin {
  /** A live chunk: held until the replay is in, then written (minus any
   *  bytes the replay already wrote). */
  live(chunk: LiveChunk): void;
  /** The capture: its (tail) bytes and the stream offset they end at.
   *  Writes them, then the held chunks. */
  replay(bytes: Uint8Array, end: number): void;
  /** No capture could be read: the held chunks go as they are. */
  replayFailed(): void;
  /** True once `replay` or `replayFailed` ran. */
  joined(): boolean;
}

export function replayJoin(write: (data: Uint8Array) => void): ReplayJoin {
  let held: LiveChunk[] | null = [];
  // Where the written stream has reached. Only meaningful once joined.
  let end = 0;

  const writeLive = (chunk: LiveChunk) => {
    const { offset, data } = chunk;
    if (offset == null) {
      write(data);
      return;
    }
    const skip = end - offset;
    if (skip >= data.length) return; // wholly replayed already
    write(skip > 0 ? data.subarray(skip) : data);
    end = Math.max(end, offset + data.length);
  };

  const release = () => {
    const pending = held ?? [];
    held = null;
    for (const chunk of pending) writeLive(chunk);
  };

  return {
    live(chunk) {
      if (held) held.push(chunk);
      else writeLive(chunk);
    },
    replay(bytes, captureEnd) {
      if (!held) return;
      if (bytes.length > 0) write(bytes);
      end = captureEnd;
      release();
    },
    replayFailed() {
      if (!held) return;
      end = 0;
      release();
    },
    joined: () => held === null,
  };
}
