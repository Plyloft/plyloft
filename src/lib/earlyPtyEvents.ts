// 1.176.0 R7: a tile listens for its PTY's events before the spawn (the id
// is its own, `pty_tile_id.rs`), and holds what arrives until the spawn has
// returned — so the tile's handlers run exactly as they did when they were
// attached after it, only now nothing printed in between is lost, and an
// exit in the first milliseconds still ends the tile. Each event is handed
// on once, in the order it came. Pure: node runs it
// (`src/lib/earlyPtyEvents.test.ts`).

export type PtyEvent = { kind: "data"; data: Uint8Array } | { kind: "exit"; code: number | null };

export interface PtyEventGate {
  /** An event for this tile's id: held until `open`, then handed on. */
  push(event: PtyEvent): void;
  /** The spawn returned: hand on what was held, then everything as it comes. */
  open(): void;
  /** The spawn failed (or the tile went): drop what was held, hand on nothing. */
  close(): void;
}

export function ptyEventGate(deliver: (event: PtyEvent) => void): PtyEventGate {
  let held: PtyEvent[] | null = [];
  let closed = false;
  return {
    push(event) {
      if (closed) return;
      if (held) held.push(event);
      else deliver(event);
    },
    open() {
      if (closed || !held) return;
      const pending = held;
      held = null;
      for (const event of pending) {
        if (closed) return;
        deliver(event);
      }
    },
    close() {
      closed = true;
      held = null;
    },
  };
}

/** A new PTY id for a tile, in the one spelling the backend accepts. */
export function newPtyId(): string {
  return crypto.randomUUID().toLowerCase();
}
