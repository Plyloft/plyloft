// UX language card 1 (Challenger F1): settings.json is one file written
// whole by `settings_set`, and several places change parts of it — the
// Settings pages' draft, the Settings modal's remembered size, the team
// clone root, first-run. Each change is a mutation of the settings as they
// are *when it runs*, and mutations run one at a time, so a write built from
// a snapshot taken before another write landed can never undo that write.
// Pure so node can test it with a delayed fake IPC.
//
// GH #178: a mutation that returns the very state it was given changed
// nothing, so nothing is sent — no `settings_set`, no rewrite of
// settings.json, no `settings://changed` to every window. Its caller still
// gets its answer: the unchanged state. (An overtaken Undo, a resize to the
// size already saved and a prune with nothing to prune all say "no change"
// this way.) A mutation that means to write returns a new object.

export type SettingsMutation<T> = (latest: T) => T;

export function createMutationQueue<T>(io: {
  /** The last committed state. */
  read: () => T;
  /** Persist; resolves to what was saved. `base` is the state the mutation
   *  read: the backend applies only what changed from it (1.176.2 R2), so a
   *  backend write this window hadn't heard of yet is never put back. */
  send: (next: T, base: T) => Promise<T>;
  /** Make a saved state the committed one. */
  commit: (saved: T) => void;
}): (mutation: SettingsMutation<T>, send?: (next: T, base: T) => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  // 1.176.3: `send`, when given, replaces `io.send` for this one mutation
  // (a reset, `settings_reset`), in the same queue. It is always sent: what
  // it puts back may differ from what is stored even where this window's
  // copy already reads the same.
  return (mutation, send) => {
    const run = tail.then(async () => {
      const latest = io.read();
      const next = mutation(latest);
      if (next === latest && !send) return latest;
      const saved = await (send ?? io.send)(next, latest);
      io.commit(saved);
      return saved;
    });
    // A failed write rejects its own caller and does not block the next.
    tail = run.catch(() => {});
    return run;
  };
}
