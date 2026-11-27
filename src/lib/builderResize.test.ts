// Runs standalone: node --experimental-strip-types src/lib/builderResize.test.ts
import assert from "node:assert/strict";
import { gridSender } from "./builderResize.ts";

{
  // A same-size resize is skipped once the PTY took the size.
  const calls: string[] = [];
  const send = gridSender(async (c, r) => {
    calls.push(`${c}x${r}`);
  });
  assert.equal(await send(120, 40), true);
  assert.equal(await send(120, 40), false);
  assert.deepEqual(calls, ["120x40"]);
  assert.equal(await send(100, 40), true);
  assert.equal(await send(120, 40), true);
  assert.deepEqual(calls, ["120x40", "100x40", "120x40"]);
  assert.deepEqual(send.sent(), { cols: 120, rows: 40 });
}
{
  // A failed resize is not remembered: the same size is sent again.
  let fail = true;
  const calls: string[] = [];
  const send = gridSender(async (c, r) => {
    calls.push(`${c}x${r}`);
    if (fail) throw new Error("pty gone");
  });
  await assert.rejects(send(120, 40));
  assert.equal(send.sent(), null);
  fail = false;
  assert.equal(await send(120, 40), true);
  assert.deepEqual(calls, ["120x40", "120x40"]);
  assert.deepEqual(send.sent(), { cols: 120, rows: 40 });
}
{
  // Nothing is remembered before the send resolves.
  let release: () => void = () => {};
  const send = gridSender(() => new Promise<void>((r) => (release = r)));
  const pending = send(80, 24);
  assert.equal(send.sent(), null);
  release();
  await pending;
  assert.deepEqual(send.sent(), { cols: 80, rows: 24 });
}
{
  // Two in flight, the earlier resolving last: the later request is the
  // size remembered.
  const releases: Array<() => void> = [];
  const send = gridSender(() => new Promise<void>((r) => releases.push(r)));
  const a = send(80, 24);
  const b = send(100, 30);
  releases[1]();
  await b;
  releases[0]();
  await a;
  assert.deepEqual(send.sent(), { cols: 100, rows: 30 });
}
console.log("builderResize.test.ts — all passed");
