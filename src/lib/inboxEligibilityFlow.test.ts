import assert from "node:assert/strict";
import {
  createInboxMutationQueue,
  inboxRefreshIsCurrent,
  markSeenThenRefresh,
} from "./inboxEligibilityFlow.ts";
import type { InboxFeed } from "../ipc.ts";

function feed(setSha256: string, userSha256: string): InboxFeed {
  return {
    generatedAt: 1,
    windowDays: 14,
    events: [],
    costRollup: [],
    eligibilityProof: {
      generatedAt: 1,
      licensed: true,
      resolvedUserSha256: userSha256,
      totalRows: 0,
      eligibleUnseenRows: 0,
      byKind: {} as InboxFeed["eligibilityProof"]["byKind"],
      byGroup: {} as InboxFeed["eligibilityProof"]["byGroup"],
      eligibleUnseenSetSha256: setSha256,
      targetPresent: null,
      admittedPrTargets: 0,
      successfulPrSources: 0,
      failedPrSources: 0,
      prSourcesComplete: true,
    },
  };
}

// 1.173.0 (F1): Mark all seen is gone (Clear the news marks rows by id);
// the backend's proof-checked `inbox_mark_all_seen` stays for its own tests.
const refreshed = feed("c".repeat(64), "b".repeat(64));

{
  const calls: string[] = [];
  const previousWarn = console.warn;
  console.warn = () => {};
  const result = await markSeenThenRefresh(["event-1"], {
    markSeen: async (ids) => {
      calls.push(`seen:${ids.join(",")}`);
      throw new Error("write failed");
    },
    refresh: async () => {
      calls.push("refresh");
      return refreshed;
    },
  });
  console.warn = previousWarn;
  assert.deepEqual(calls, ["seen:event-1", "refresh"]);
  assert.equal(result.feed, refreshed);
  assert.equal(result.proofReady, true);
}

{
  const result = await markSeenThenRefresh(["event-1"], {
    markSeen: async () => {},
    refresh: async () => {
      throw new Error("refresh failed");
    },
  });
  assert.equal(result.feed, null);
  assert.equal(result.proofReady, false);
  assert.match(result.error ?? "", /refresh failed/);
}

{
  const queue = createInboxMutationQueue();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = queue.run(async () => {
    order.push("first-start");
    await firstGate;
    order.push("first-end");
    return 1;
  });
  const generationBeforeSecond = queue.generation();
  const second = queue.run(async () => {
    order.push("second-start");
    return 2;
  });
  assert.equal(queue.pending(), 2);
  assert.equal(queue.generation(), generationBeforeSecond + 1);
  assert.equal(inboxRefreshIsCurrent(generationBeforeSecond, queue), false);
  await Promise.resolve();
  assert.deepEqual(order, ["first-start"]);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
  assert.equal(queue.pending(), 0);
  assert.equal(inboxRefreshIsCurrent(generationBeforeSecond, queue), false);
  assert.equal(inboxRefreshIsCurrent(queue.generation(), queue), true);
}

console.log("inbox eligibility flow tests passed");
