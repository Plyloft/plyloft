// Unit tests for the window's heartbeat (src/lib/heartbeat.ts, H1 1.173.0).
//
// Run: node --experimental-strip-types src/lib/heartbeat.test.ts

import assert from "node:assert/strict";
import { BEAT_HIDDEN_MS, BEAT_VISIBLE_MS, beatInterval, startHeartbeat } from "./heartbeat.ts";

/** A fake clock and page: timers fire when `advance` passes them. */
function fakePage(visible = true) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const listeners = new Set<() => void>();
  const beats: { at: number; visible: boolean }[] = [];
  const page = {
    visible,
    beats,
    get pendingTimers() {
      return timers.size;
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    setVisible(v: boolean) {
      page.visible = v;
      for (const l of listeners) l();
    },
    host: {
      send: (v: boolean) => beats.push({ at: now, visible: v }),
      isVisible: () => page.visible,
      onVisibilityChange: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      setTimer: (fn: () => void, ms: number) => {
        const id = nextId++;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimer: (id: unknown) => {
        timers.delete(id as number);
      },
    },
    get listenerCount() {
      return listeners.size;
    },
  };
  return page;
}

assert.equal(beatInterval(true), 2_000);
assert.equal(beatInterval(false), 30_000);
assert.equal(BEAT_VISIBLE_MS, 2_000);
assert.equal(BEAT_HIDDEN_MS, 30_000);

// A visible page beats at once, then every 2 s.
{
  const page = fakePage(true);
  const stop = startHeartbeat(page.host);
  page.advance(10_000);
  assert.deepEqual(
    page.beats.map((b) => b.at),
    [0, 2_000, 4_000, 6_000, 8_000, 10_000],
  );
  assert.ok(page.beats.every((b) => b.visible));
  stop();
}

// Hidden: one beat every 30 s, and the change itself beats at once.
{
  const page = fakePage(true);
  const stop = startHeartbeat(page.host);
  page.advance(3_000);
  page.setVisible(false);
  const hiddenFrom = page.beats.length - 1;
  assert.deepEqual(page.beats[hiddenFrom], { at: 3_000, visible: false }, "the hide beats at once");
  page.advance(90_000);
  assert.deepEqual(
    page.beats.slice(hiddenFrom).map((b) => b.at),
    [3_000, 33_000, 63_000, 93_000],
    "every 30 s while hidden",
  );
  assert.equal(page.pendingTimers, 1, "one timer, never a pile");
  // Shown again: at once, then every 2 s.
  page.setVisible(true);
  page.advance(4_000);
  assert.deepEqual(
    page.beats.slice(-3),
    [
      { at: 93_000, visible: true },
      { at: 95_000, visible: true },
      { at: 97_000, visible: true },
    ],
  );
  stop();
}

// A failing send never stops the beat.
{
  const page = fakePage(true);
  let calls = 0;
  const stop = startHeartbeat({
    ...page.host,
    send: () => {
      calls += 1;
      throw new Error("ipc down");
    },
  });
  page.advance(6_000);
  assert.equal(calls, 4);
  stop();
}

// Stop clears the timer and the listener.
{
  const page = fakePage(true);
  const stop = startHeartbeat(page.host);
  stop();
  assert.equal(page.pendingTimers, 0);
  assert.equal(page.listenerCount, 0);
  const before = page.beats.length;
  page.advance(20_000);
  page.setVisible(false);
  assert.equal(page.beats.length, before, "nothing after stop");
}

console.log("heartbeat: ok");
