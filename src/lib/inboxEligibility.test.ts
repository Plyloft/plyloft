import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const store = readFileSync(new URL("../store/inboxStore.ts", import.meta.url), "utf8");
const ipc = readFileSync(new URL("../ipc.ts", import.meta.url), "utf8");
const flow = readFileSync(
  new URL("./inboxEligibilityFlow.ts", import.meta.url),
  "utf8",
);
const panel = readFileSync(
  new URL("../components/InboxPanel.tsx", import.meta.url),
  "utf8",
);

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing ordered block ${start} … ${end}`);
  return source.slice(from, to);
}

const markSeen = between(store, "  markSeen: async", "\n\n  open:");
assert.ok(markSeen.includes("set({ proofReady: false });"));
assert.ok(markSeen.includes("inboxMutationQueue.run"));
assert.ok(markSeen.includes("inboxMutationQueue.pending() > 0"));
assert.ok(
  markSeen.indexOf("proofReady: false") <
    markSeen.indexOf("await inboxMutationQueue.run"),
  "single-row writes must invalidate the proof before IPC",
);

const refresh = between(store, "  refresh: async", "\n\n  markSeen:");
assert.ok(refresh.includes("const startedAtGeneration = inboxMutationQueue.generation()"));
assert.equal(
  refresh.match(/inboxRefreshIsCurrent\(startedAtGeneration, inboxMutationQueue\)/g)
    ?.length,
  2,
);

// 1.173.0 (F1): no Mark all seen in the app — Clear the news marks the news
// rows by id through the row-seen write above; to-do rows are never marked
// away. The backend's proof-checked command stays for its own tests.
assert.ok(!store.includes("markAllSeen"));
assert.ok(!ipc.includes('"inbox_mark_all_seen"'));
assert.ok(!panel.includes("Mark all seen"));
assert.ok(panel.includes("markSeen(newsIds)"));
assert.ok(!flow.includes("markAll"));

console.log("inbox eligibility frontend contract passed");
