// Unit tests for the per-workspace local write queue (card #94 review, F5
// and F14).
//
// Run: node --experimental-strip-types src/lib/localWriteQueue.test.ts

import {
  enqueueWrite,
  resetWriteQueues,
  watchWrites,
  writesInFlight,
} from "./localWriteQueue.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
  resetWriteQueues();
  try {
    await fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${name}: ${(e as Error).message}`);
  }
}

function eq(actual: unknown, expected: unknown, msg = ""): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} expected ${b}, got ${a}`);
}

/** Jobs start on a microtask, so the assertions wait a turn of the loop. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

/** A job whose finish the test decides. */
function held<T>(value: T) {
  let release!: () => void;
  let reject!: (e: unknown) => void;
  const gate = new Promise<void>((ok, no) => {
    release = () => ok();
    reject = no;
  });
  return { release, reject, run: () => gate.then(() => value) };
}

await it("a write waits for the one before it, reads included", async () => {
  const order: string[] = [];
  const first = held("first");
  const second = held("second");
  const a = enqueueWrite("ws", async () => {
    order.push("a starts");
    const v = await first.run();
    order.push("a ends");
    return v;
  });
  const b = enqueueWrite("ws", async () => {
    order.push("b starts");
    const v = await second.run();
    order.push("b ends");
    return v;
  });
  await settle();
  eq(order, ["a starts"], "b has not begun to read");
  eq(writesInFlight("ws"), 2);
  first.release();
  await a;
  await settle();
  eq(order, ["a starts", "a ends", "b starts"], "b begins only after a ended");
  second.release();
  await b;
  eq(order, ["a starts", "a ends", "b starts", "b ends"]);
  eq(writesInFlight("ws"), 0);
});

await it("a failed write does not hold back the ones behind it", async () => {
  const first = held("first");
  const ran: string[] = [];
  const a = enqueueWrite("ws", async () => {
    await first.run();
    return "a";
  }).catch((e) => `caught ${String(e)}`);
  const b = enqueueWrite("ws", async () => {
    ran.push("b");
    return "b";
  });
  first.reject(new Error("no"));
  eq(await a, "caught Error: no", "the failure is the caller's");
  eq(await b, "b");
  eq(ran, ["b"]);
  eq(writesInFlight("ws"), 0);
});

await it("each workspace has its own queue", async () => {
  const one = held("one");
  const started: string[] = [];
  const a = enqueueWrite("ws1", async () => {
    started.push("ws1");
    return one.run();
  });
  const b = enqueueWrite("ws2", async () => {
    started.push("ws2");
    return "two";
  });
  eq(await b, "two", "ws2 does not wait for ws1");
  eq(started.sort(), ["ws1", "ws2"]);
  eq(writesInFlight("ws1"), 1);
  eq(writesInFlight("ws2"), 0);
  one.release();
  await a;
});

await it("the count stays up while anything is still queued", async () => {
  // F14: a page that goes idle after its first write finishes would let a
  // Reset run beside the writes still behind it.
  const seen: number[] = [];
  const stop = watchWrites("ws", (n) => seen.push(n));
  eq(seen, [0], "a watcher is told where things stand at once");
  const first = held("first");
  const second = held("second");
  const a = enqueueWrite("ws", first.run);
  const b = enqueueWrite("ws", second.run);
  eq(seen, [0, 1, 2]);
  first.release();
  await a;
  eq(writesInFlight("ws"), 1, "still busy: one is queued");
  second.release();
  await b;
  eq(seen[seen.length - 1], 0);
  stop();
  await enqueueWrite("ws", async () => "after");
  eq(seen[seen.length - 1], 0, "a stopped watcher hears nothing more");
});

await it("a write queued after the queue drained still runs in order", async () => {
  await enqueueWrite("ws", async () => "one");
  const order: string[] = [];
  const held2 = held("two");
  const a = enqueueWrite("ws", async () => {
    order.push("two starts");
    return held2.run();
  });
  const b = enqueueWrite("ws", async () => {
    order.push("three");
    return "three";
  });
  await settle();
  eq(order, ["two starts"]);
  held2.release();
  await Promise.all([a, b]);
  eq(order, ["two starts", "three"]);
});

if (failed > 0) {
  console.error(`localWriteQueue.test.ts: ${failed} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`localWriteQueue.test.ts: ${passed} passed`);
