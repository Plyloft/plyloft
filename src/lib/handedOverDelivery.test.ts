import assert from "node:assert/strict";

import {
  deliverHandedOver,
  deliveryFor,
  HeldMessageWaiters,
  SESSION_ENDED_ERROR,
  type DeliverDeps,
  type HandedOverDelivery,
} from "./handedOverDelivery.ts";

// GH #129 (F1): Back to the Builder says "sent" only once the findings
// reached the PTY; queued while held for the prompt; failed, and sendable
// again, when the write fails or the session ends first.

function deps(over: Partial<DeliverDeps> & { idle?: boolean; open?: boolean }) {
  const reports: HandedOverDelivery[] = [];
  const writes: string[] = [];
  const d: DeliverDeps = {
    session: () => (over.open === false ? null : { ptyId: "pty-1", idle: over.idle ?? true }),
    write: async (_pty, text) => {
      writes.push(text);
    },
    queue: async () => {},
    report: (r) => reports.push(r),
    ...over,
  };
  return { d, reports, writes };
}

// Immediate delivery: the prompt is idle, the write succeeds.
{
  const { d, reports, writes } = deps({ idle: true });
  assert.equal(await deliverHandedOver("F3, F4", 7, d), "sent");
  assert.deepEqual(writes, ["F3, F4"]);
  assert.deepEqual(reports, [{ handedOverAt: 7, ptyId: "pty-1", state: "sent" }]);
}

// Queued delivery: held for the prompt, sent once the held message is written.
{
  const waiters = new HeldMessageWaiters();
  const { d, reports } = deps({ idle: false, queue: () => waiters.wait("c1") });
  const done = deliverHandedOver("F3, F4", 7, d);
  await Promise.resolve();
  assert.deepEqual(reports.map((r) => r.state), ["queued"]);
  waiters.take("c1")();
  assert.equal(await done, "sent");
  assert.deepEqual(reports.map((r) => r.state), ["queued", "sent"]);
}

// PTY failure: the write rejects — failed, with the reason.
{
  const { d, reports } = deps({ idle: true, write: async () => Promise.reject(new Error("pty closed")) });
  assert.equal(await deliverHandedOver("F3", 7, d), "failed");
  assert.deepEqual(reports, [{ handedOverAt: 7, ptyId: "pty-1", state: "failed", error: "pty closed" }]);
}

// The session ends while the message is held: failed, never "sent".
{
  const waiters = new HeldMessageWaiters();
  const { d, reports } = deps({ idle: false, queue: () => waiters.wait("c1") });
  const done = deliverHandedOver("F3", 7, d);
  waiters.take("c1")(new Error(SESSION_ENDED_ERROR));
  assert.equal(await done, "failed");
  assert.equal(reports[reports.length - 1]?.error, SESSION_ENDED_ERROR);
}

// No session: nothing reported.
{
  const { d, reports } = deps({ open: false });
  assert.equal(await deliverHandedOver("F3", 7, d), null);
  assert.deepEqual(reports, []);
}

// A flush settles only the messages held when it began.
{
  const waiters = new HeldMessageWaiters();
  let first = false;
  let second = false;
  void waiters.wait("c1").then(() => (first = true));
  const settle = waiters.take("c1");
  void waiters.wait("c1").then(() => (second = true));
  settle();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(first, true);
  assert.equal(second, false);
}

// A delivery counts only for its hand-over and its session.
{
  const sent: HandedOverDelivery = { handedOverAt: 7, ptyId: "pty-1", state: "sent" };
  assert.equal(deliveryFor(sent, 7, "pty-1"), sent);
  assert.equal(deliveryFor(sent, 8, "pty-1"), null, "a newer hand-over is unsent");
  assert.equal(deliveryFor(sent, 7, "pty-2"), null, "a new session has not received it");
  assert.equal(deliveryFor(sent, 7, null), null);
}

console.log("handed-over delivery tests passed");
