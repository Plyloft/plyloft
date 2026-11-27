/**
 * UX language card 2: one local write at a time per workspace.
 *
 * A This-Mac setting is saved by reading the whole `config.json`, changing a
 * field and writing it back. Two of those overlapping lose one of the
 * changes, and the backend's lock does not help: the read that built the
 * second write happened before the first one's write.
 *
 * The queue lives here rather than in the page, because the work outlives
 * the page. A toast's `Undo` is pressed after Settings has been closed and
 * opened again, and a queue owned by a mount would let that Undo read the
 * config beside a write the new page started (card #94 review, F5). The
 * count is what a page shows as busy: it stays busy while anything is still
 * queued, not just the write it started itself (F14).
 *
 * **A job must not enqueue on its own key.** The inner write is chained
 * behind the job that is waiting for it, and both wait for ever. A
 * procedure that both reads and then makes an ordinary change runs its read
 * outside the queue and lets the change queue itself.
 *
 * Pure — no React, no Tauri — so `localWriteQueue.test.ts` runs it under
 * node with jobs it controls.
 */

type Listener = (inFlight: number) => void;

const chains = new Map<string, Promise<unknown>>();
const counts = new Map<string, number>();
const listeners = new Map<string, Set<Listener>>();

function announce(key: string): void {
  const n = counts.get(key) ?? 0;
  for (const listener of listeners.get(key) ?? []) listener(n);
}

/** How many writes for this workspace are queued or running. */
export function writesInFlight(key: string): number {
  return counts.get(key) ?? 0;
}

/** Runs `job` after every write already queued for `key` has settled — its
 *  own reads included, so the next job starts from what is on disk. The
 *  promise is the job's own: its failure is the caller's to handle, and it
 *  never holds the queue back. */
export function enqueueWrite<T>(key: string, job: () => Promise<T>): Promise<T> {
  counts.set(key, (counts.get(key) ?? 0) + 1);
  announce(key);
  const previous = chains.get(key) ?? Promise.resolve();
  // `then(job, job)`: a failed write does not cancel the ones behind it.
  const run = previous.then(job, job);
  chains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run.finally(() => {
    const left = (counts.get(key) ?? 1) - 1;
    if (left <= 0) {
      counts.delete(key);
      // Nothing is waiting on this workspace: let the chain go rather than
      // keeping every settled promise of the session alive.
      chains.delete(key);
    } else {
      counts.set(key, left);
    }
    announce(key);
  });
}

/** Tells `listener` how many writes are in flight, now and on every change.
 *  Returns the way to stop listening. */
export function watchWrites(key: string, listener: Listener): () => void {
  const set = listeners.get(key) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(key, set);
  listener(writesInFlight(key));
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

/** Tests only: forget every queue and listener. */
export function resetWriteQueues(): void {
  chains.clear();
  counts.clear();
  listeners.clear();
}
