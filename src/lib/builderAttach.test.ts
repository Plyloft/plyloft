// Runs standalone: node --experimental-strip-types src/lib/builderAttach.test.ts
import assert from "node:assert/strict";
import { replayJoin, type LiveChunk } from "./builderAttach.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (parts: Uint8Array[]) => parts.map((p) => new TextDecoder().decode(p)).join("");

/**
 * The backend as it is: the reader tees each read into the capture at once;
 * the emitter sends it as a `pty://data` event later, to the listeners
 * registered at that moment only (Tauri events are not replayed).
 */
function session() {
  const capture: number[] = [];
  const queued: LiveChunk[] = [];
  const listeners = new Set<(c: LiveChunk) => void>();
  let emitted = 0;
  return {
    /** The PTY printed `s` (in the capture now, emitted later). */
    print(s: string) {
      const bytes = enc(s);
      queued.push({ offset: capture.length, data: bytes });
      capture.push(...bytes);
    },
    /** The emitter sends what is queued. */
    emit() {
      for (const chunk of queued.splice(0)) {
        emitted += chunk.data.length;
        for (const l of listeners) l(chunk);
      }
    },
    readCapture: () => ({ bytes: Uint8Array.from(capture), end: capture.length }),
    listen(l: (c: LiveChunk) => void) {
      listeners.add(l);
    },
    emitted: () => emitted,
  };
}

const TRUST = "\x1b[2J\x1b[HQuick safety check: Is this a project you trust?\r\n❯ 1. Yes, I trust this folder\r\n";

{
  // The cause, reproduced: the old attach read the capture, then (after a
  // resize round-trip) subscribed. Claude's trust frame printed in between
  // is in neither, and the CLI prints nothing more until it is answered.
  const s = session();
  const screen: Uint8Array[] = [];
  const { bytes } = s.readCapture(); // fresh session: nothing yet
  if (bytes.length) screen.push(bytes);
  s.print(TRUST); // during `await sendSize(...)` / `await listen(...)`
  s.emit(); // emitted before the listener exists
  s.listen((c) => screen.push(c.data));
  s.emit();
  assert.equal(dec(screen), "", "the old order leaves the terminal blank");
}

{
  // The fix: subscribe first and hold, then replay. The same frame shows once.
  const s = session();
  const screen: Uint8Array[] = [];
  const join = replayJoin((d) => screen.push(d));
  s.listen((c) => join.live(c));
  s.print(TRUST);
  s.emit(); // arrives before the capture is read: held
  const { bytes, end } = s.readCapture();
  join.replay(bytes, end);
  assert.equal(dec(screen), TRUST);
}

{
  // Overlap: teed into the capture before the read, emitted after it. The
  // replay wrote those bytes; the live copy is dropped, and what follows is
  // written.
  const s = session();
  const screen: Uint8Array[] = [];
  const join = replayJoin((d) => screen.push(d));
  s.listen((c) => join.live(c));
  s.print("boot ");
  s.emit();
  s.print("half-");
  const { bytes, end } = s.readCapture();
  join.replay(bytes, end);
  s.emit(); // "half-" arrives after the replay
  s.print("after");
  s.emit();
  assert.equal(dec(screen), "boot half-after");
}

{
  // A batch that straddles the capture's end is cut at it.
  const screen: Uint8Array[] = [];
  const join = replayJoin((d) => screen.push(d));
  join.live({ offset: 0, data: enc("abcdef") });
  join.replay(enc("abcd"), 4);
  join.live({ offset: 6, data: enc("gh") });
  assert.equal(dec(screen), "abcdefgh");
}

{
  // A replayed tail (the capture is capped on the way out): offsets still
  // count from the session's start.
  const screen: Uint8Array[] = [];
  const join = replayJoin((d) => screen.push(d));
  join.live({ offset: 1000, data: enc("xyz") });
  join.replay(enc("tail"), 1002);
  assert.equal(dec(screen), "tailz");
}

{
  // No capture could be read: held chunks go as they are, in order.
  const screen: Uint8Array[] = [];
  const join = replayJoin((d) => screen.push(d));
  join.live({ offset: 0, data: enc("one ") });
  join.live({ offset: 4, data: enc("two") });
  assert.equal(join.joined(), false);
  join.replayFailed();
  assert.equal(join.joined(), true);
  join.live({ offset: 7, data: enc("!") });
  assert.equal(dec(screen), "one two!");
}

{
  // An event without an offset (an older backend) is written whole.
  const screen: Uint8Array[] = [];
  const join = replayJoin((d) => screen.push(d));
  join.replay(enc("x"), 1);
  join.live({ data: enc("y") });
  assert.equal(dec(screen), "xy");
}

{
  // Every interleaving of print / emit / read writes the stream exactly once.
  const steps = ["p1", "e", "p2", "e", "p3", "e"];
  for (let readAt = 0; readAt <= steps.length; readAt++) {
    const s = session();
    const screen: Uint8Array[] = [];
    const join = replayJoin((d) => screen.push(d));
    s.listen((c) => join.live(c));
    steps.forEach((step, i) => {
      if (i === readAt) {
        const { bytes, end } = s.readCapture();
        join.replay(bytes, end);
      }
      if (step === "e") s.emit();
      else s.print(step);
    });
    if (readAt === steps.length) {
      const { bytes, end } = s.readCapture();
      join.replay(bytes, end);
    }
    assert.equal(dec(screen), "p1p2p3", `read at step ${readAt}`);
  }
}

console.log("builderAttach: ok");
