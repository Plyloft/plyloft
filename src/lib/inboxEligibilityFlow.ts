import type { InboxFeed } from "../ipc";

export type InboxRefreshOutcome = {
  feed: InboxFeed | null;
  proofReady: boolean;
  error: string | null;
};

type SeenDependencies = {
  markSeen: (eventIds: string[]) => Promise<unknown>;
  refresh: () => Promise<InboxFeed>;
};

/** Serialize Inbox writes while exposing a synchronous pending count. The
 * store uses that count to keep a proof disabled until the last queued write
 * has completed its authoritative refresh. */
export function createInboxMutationQueue() {
  let pending = 0;
  let generation = 0;
  let tail: Promise<void> = Promise.resolve();

  return {
    pending: () => pending,
    generation: () => generation,
    run<T>(operation: () => Promise<T>): Promise<T> {
      pending += 1;
      generation += 1;
      const result = tail.then(operation, operation);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result.finally(() => {
        pending -= 1;
      });
    },
  };
}

type MutationQueueState = Pick<
  ReturnType<typeof createInboxMutationQueue>,
  "pending" | "generation"
>;

/** A feed read may publish proof only if no Inbox write started after it. */
export function inboxRefreshIsCurrent(
  startedAtGeneration: number,
  queue: MutationQueueState,
): boolean {
  return queue.pending() === 0 && queue.generation() === startedAtGeneration;
}

/** Execute the row-seen write and always replace optimistic state with a
 * production feed before the proof can be re-enabled. */
export async function markSeenThenRefresh(
  eventIds: string[],
  dependencies: SeenDependencies,
): Promise<InboxRefreshOutcome> {
  try {
    await dependencies.markSeen(eventIds);
  } catch (error) {
    console.warn("inbox_mark_seen failed:", error);
  }
  try {
    return {
      feed: await dependencies.refresh(),
      proofReady: true,
      error: null,
    };
  } catch (error) {
    return { feed: null, proofReady: false, error: String(error) };
  }
}
