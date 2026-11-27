// Tests for the no-bracketed-paste hint (GH #68, src/lib/noPasteHint.ts): a
// held Space in a shell tile whose line editor has no bracketed paste
// (macOS /bin/bash 3.2) explains itself once per session, never takes a key
// from the shell, and never fires where dictation works.
//
//     node --experimental-strip-types src/lib/noPasteHint.test.ts

import assert from "node:assert/strict";
import { NoPasteHint, stepKeyWithHint, type HintSession } from "./noPasteHint.ts";
import { HOLD_MS, type HoldKey, type HoldPhase } from "./spaceHold.ts";

let passed = 0;
const failures: string[] = [];

function it(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push(`${name}: ${(e as Error).message}`);
  }
}

class FakeTimers {
  now = 0;
  #seq = 0;
  #pending = new Map<number, { at: number; fn: () => void }>();
  set = (fn: () => void, ms: number): unknown => {
    const id = ++this.#seq;
    this.#pending.set(id, { at: this.now + ms, fn });
    return id;
  };
  clear = (handle: unknown): void => {
    this.#pending.delete(handle as number);
  };
  advance(ms: number): void {
    this.now += ms;
    for (const [id, entry] of [...this.#pending]) {
      if (entry.at <= this.now) {
        this.#pending.delete(id);
        entry.fn();
      }
    }
  }
}

const key = (type: HoldKey["type"], k: string, extra: Partial<HoldKey> = {}): HoldKey => ({
  type,
  key: k,
  repeat: false,
  modifiers: false,
  ...extra,
});

/** A shell tile at its prompt, routed exactly as DictationController routes
 *  its keys: through the hold machine, then the hint. */
function tile(opts: { bracketedPaste: boolean; session: HintSession; timers: FakeTimers }) {
  let toasts = 0;
  let phase: HoldPhase = "idle";
  const handle = new NoPasteHint(() => toasts++, opts.timers, opts.session);
  const atPrompt = true;
  const consumed: boolean[] = [];
  const press = (k: HoldKey) => {
    const step = stepKeyWithHint(
      phase,
      k,
      () => atPrompt && opts.bracketedPaste,
      { handle, lacksPaste: () => atPrompt && !opts.bracketedPaste },
    );
    phase = step.phase;
    consumed.push(step.consume);
    return step;
  };
  const hold = (ms: number) => {
    press(key("keydown", " "));
    for (let t = 50; t <= ms; t += 50) {
      opts.timers.advance(50);
      if (t >= 100) press(key("keydown", " ", { repeat: true }));
    }
    press(key("keyup", " "));
  };
  return {
    press,
    hold,
    handle,
    get toasts() {
      return toasts;
    },
    get phase() {
      return phase;
    },
    consumed,
  };
}

it("a held Space without bracketed paste shows the toast once, taking no key", () => {
  const timers = new FakeTimers();
  const t = tile({ bracketedPaste: false, session: { shown: false }, timers });
  t.hold(HOLD_MS + 400);
  assert.equal(t.toasts, 1);
  assert.equal(t.phase, "idle", "no recording");
  assert.ok(t.consumed.every((c) => !c), "every key reaches the shell");
  t.hold(HOLD_MS + 400);
  assert.equal(t.toasts, 1, "once per session");
});

it("the toast fires once per session across tiles", () => {
  const timers = new FakeTimers();
  const session = { shown: false };
  const a = tile({ bracketedPaste: false, session, timers });
  const b = tile({ bracketedPaste: false, session, timers });
  a.hold(HOLD_MS + 100);
  b.hold(HOLD_MS + 100);
  assert.equal(a.toasts + b.toasts, 1);
});

it("never fires for a tile with bracketed paste: the hold records instead", () => {
  const timers = new FakeTimers();
  const t = tile({ bracketedPaste: true, session: { shown: false }, timers });
  t.press(key("keydown", " "));
  assert.equal(t.phase, "pending");
  timers.advance(HOLD_MS + 1000);
  assert.equal(t.toasts, 0);
});

it("a tap stays a tap and shows nothing", () => {
  const timers = new FakeTimers();
  const t = tile({ bracketedPaste: false, session: { shown: false }, timers });
  const down = t.press(key("keydown", " "));
  assert.equal(down.consume, false, "the space goes to the shell at once");
  timers.advance(HOLD_MS - 50);
  t.press(key("keyup", " "));
  timers.advance(1000);
  assert.equal(t.toasts, 0);
});

it("typing past a Space, a modifier or blur cancels the pending hint", () => {
  const timers = new FakeTimers();
  const t = tile({ bracketedPaste: false, session: { shown: false }, timers });
  t.press(key("keydown", " "));
  t.press(key("keydown", "a"));
  timers.advance(HOLD_MS * 4);
  assert.equal(t.toasts, 0, "rollover typing");

  t.press(key("keydown", " ", { modifiers: true }));
  timers.advance(HOLD_MS * 4);
  assert.equal(t.toasts, 0, "a modified Space is not a hold");

  t.press(key("keydown", " "));
  t.handle.cancel();
  timers.advance(HOLD_MS * 4);
  assert.equal(t.toasts, 0, "blur");
});

it("a repeat with no fresh keydown behind it arms nothing", () => {
  const timers = new FakeTimers();
  const t = tile({ bracketedPaste: false, session: { shown: false }, timers });
  t.press(key("keydown", " ", { repeat: true }));
  timers.advance(HOLD_MS * 4);
  assert.equal(t.toasts, 0);
});

it("a busy shell (not at a line editor) is never told", () => {
  const timers = new FakeTimers();
  const session = { shown: false };
  let toasts = 0;
  const handle = new NoPasteHint(() => toasts++, timers, session);
  stepKeyWithHint("idle", key("keydown", " "), () => false, {
    handle,
    lacksPaste: () => false,
  });
  timers.advance(HOLD_MS * 4);
  assert.equal(toasts, 0);
  assert.equal(session.shown, false);
});

if (failures.length) {
  for (const f of failures) console.error(`✗ ${f}`);
  console.error(`noPasteHint: ${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`noPasteHint: ${passed} passed`);
