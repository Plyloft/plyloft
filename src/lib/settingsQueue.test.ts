// Challenger F1: overlapping settings writes — a preference save and a
// resize save in flight together — both land. Run with:
//
//     node --experimental-strip-types src/lib/settingsQueue.test.ts

import assert from "node:assert/strict";
import { createMutationQueue } from "./settingsQueue.ts";

type S = { theme: string; size: number | null; team: string };

function harness(delays: number[]) {
  let committed: S = { theme: "light", size: null, team: "~/code" };
  const disk: S[] = [];
  let call = 0;
  const mutate = createMutationQueue<S>({
    read: () => committed,
    send: (next) =>
      new Promise((resolve, reject) => {
        const delay = delays[call++] ?? 0;
        setTimeout(() => {
          if ((next as S & { fail?: boolean }).fail) return reject(new Error("ipc"));
          disk.push(next);
          resolve(next);
        }, delay);
      }),
    commit: (saved) => {
      committed = saved;
    },
  });
  return { mutate, disk, committed: () => committed };
}

// A slow preference save, then a fast resize save while it is in flight.
{
  const h = harness([40, 1]);
  const draft = { theme: "dark" }; // the page's draft, taken before either write
  const pref = h.mutate((latest) => ({ ...latest, theme: draft.theme }));
  const size = h.mutate((latest) => ({ ...latest, size: 960 }));
  await Promise.all([pref, size]);
  assert.deepEqual(h.committed(), { theme: "dark", size: 960, team: "~/code" });
  assert.deepEqual(h.disk[h.disk.length - 1], { theme: "dark", size: 960, team: "~/code" }, "the last write holds both");
}

// The other way round: a resize in flight, then the preference save.
{
  const h = harness([40, 1]);
  const size = h.mutate((latest) => ({ ...latest, size: 1200 }));
  const pref = h.mutate((latest) => ({ ...latest, theme: "void" }));
  await Promise.all([size, pref]);
  assert.deepEqual(h.committed(), { theme: "void", size: 1200, team: "~/code" });
}

// Three writers, each owning one field, interleaved.
{
  const h = harness([30, 10, 20]);
  await Promise.all([
    h.mutate((l) => ({ ...l, team: "~/work" })),
    h.mutate((l) => ({ ...l, size: 900 })),
    h.mutate((l) => ({ ...l, theme: "dark" })),
  ]);
  assert.deepEqual(h.committed(), { theme: "dark", size: 900, team: "~/work" });
}

// A failed write rejects its caller, commits nothing, and the next one runs.
{
  const h = harness([5, 5]);
  const bad = h.mutate((l) => ({ ...l, theme: "x", fail: true }) as S);
  const good = h.mutate((l) => ({ ...l, size: 800 }));
  await assert.rejects(bad);
  await good;
  assert.deepEqual(h.committed(), { theme: "light", size: 800, team: "~/code" });
}

// GH #178: a mutation that hands back the state it was given sends nothing,
// and its caller still gets the state; a real change behind it sends once.
{
  const h = harness([5, 5]);
  const before = h.committed();
  const answer = await h.mutate((latest) => latest);
  assert.equal(answer, before, "the caller gets the unchanged state");
  assert.equal(h.disk.length, 0, "nothing was sent");
  assert.equal(h.committed(), before, "and nothing was committed over it");
  await h.mutate((l) => ({ ...l, theme: "dark" }));
  assert.equal(h.disk.length, 1, "a real change is sent exactly once");
  // An equal-looking copy is still a new object, so it is still sent: only the
  // very reference counts as "no change".
  await h.mutate((l) => ({ ...l }));
  assert.equal(h.disk.length, 2);
}

// GH #178: a no-op queued behind a slow write reads that write's result, and
// sends nothing of its own.
{
  const h = harness([30]);
  const slow = h.mutate((l) => ({ ...l, size: 700 }));
  const noop = h.mutate((latest) => (latest.size === 700 ? latest : { ...latest, size: 1 }));
  await slow;
  assert.equal((await noop).size, 700);
  assert.equal(h.disk.length, 1);
}

// 1.176.2 R2: `send` gets the state the mutation read as its base, beside the
// new state, so the backend can apply only what the mutation changed.
{
  let committed: S = { theme: "light", size: null, team: "~/code" };
  const sent: Array<{ next: S; base: S }> = [];
  const mutate = createMutationQueue<S>({
    read: () => committed,
    send: async (next, base) => {
      sent.push({ next, base });
      return next;
    },
    commit: (saved) => {
      committed = saved;
    },
  });
  const first = committed;
  await mutate((l) => ({ ...l, theme: "dark" }));
  await mutate((l) => ({ ...l, size: 640 }));
  assert.equal(sent[0].base, first, "the first save's base is the state its mutation read");
  assert.deepEqual(sent[0].next, { theme: "dark", size: null, team: "~/code" });
  assert.deepEqual(sent[1].base, { theme: "dark", size: null, team: "~/code" }, "the next base is what was saved");
}

// 1.176.3: a reset's own `send` goes through the same queue, in turn, with
// the state it read as its base, and is sent even when this window's copy
// already reads as the reset (the backend may hold a value Plyloft wrote).
{
  let committed: S = { theme: "light", size: null, team: "~/code" };
  const plain: S[] = [];
  const reset: Array<{ next: S; base: S }> = [];
  const mutate = createMutationQueue<S>({
    read: () => committed,
    send: (next) =>
      new Promise((resolve) =>
        setTimeout(() => {
          plain.push(next);
          resolve(next);
        }, 20),
      ),
    commit: (saved) => {
      committed = saved;
    },
  });
  const slow = mutate((l) => ({ ...l, theme: "dark" }));
  const r = mutate(
    (l) => l,
    async (next, base) => {
      reset.push({ next, base });
      return { ...next, size: 1 };
    },
  );
  await slow;
  assert.deepEqual(await r, { theme: "dark", size: 1, team: "~/code" }, "the reset ran after the save before it, and its answer is committed");
  assert.equal(reset.length, 1, "a reset that changes nothing here is still sent");
  assert.deepEqual(reset[0].base, { theme: "dark", size: null, team: "~/code" });
  assert.equal(plain.length, 1, "the reset did not go through the ordinary send");
  assert.deepEqual(committed, { theme: "dark", size: 1, team: "~/code" });
}

console.log("settingsQueue: all assertions passed");
