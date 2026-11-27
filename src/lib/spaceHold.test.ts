// Tests for the dictation hold-Space state machine (src/lib/spaceHold.ts):
// tap, hold, auto-repeat, rollover typing, cancel, and the tiles it must
// never touch.
//
//     node --experimental-strip-types src/lib/spaceHold.test.ts

import {
  dictationModeFor,
  refusedTranscriptTitle,
  stepSpaceHold,
  type HoldEffect,
  type HoldEvent,
  type HoldKey,
  type HoldPhase,
} from "./spaceHold.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function it(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${name}: ${(e as Error).message}`);
  }
}

function eq<T>(actual: T, expected: T, label = ""): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label} expected ${b}, got ${a}`);
}

const key = (type: HoldKey["type"], k: string, extra: Partial<HoldKey> = {}): HoldKey => ({
  type,
  key: k,
  repeat: false,
  modifiers: false,
  ...extra,
});

const IDLE = () => true;
const BUSY = () => false;

/** Run a sequence; return the final phase, all effects, and each step's consume flag. */
function run(events: HoldEvent[], start: HoldPhase = "idle") {
  let phase = start;
  const effects: HoldEffect[] = [];
  const consumed: boolean[] = [];
  for (const event of events) {
    const step = stepSpaceHold(phase, event);
    phase = step.phase;
    effects.push(...step.effects);
    consumed.push(step.consume);
  }
  return { phase, effects, consumed };
}

const down = (k = " ", extra: Partial<HoldKey> = {}, idle = IDLE): HoldEvent => ({
  type: "key",
  key: key("keydown", k, extra),
  idle,
});
const up = (k = " "): HoldEvent => ({ type: "key", key: key("keyup", k), idle: IDLE });
const elapsed: HoldEvent = { type: "hold-elapsed" };

it("a tap is one space, sent on key-up", () => {
  const r = run([down(), up()]);
  eq(r.phase, "idle");
  eq(r.effects, ["arm-timer", "disarm-timer", "emit-space"]);
  eq(r.consumed, [true, true]);
});

it("a hold records, and release transcribes", () => {
  const r = run([down(), elapsed, up(), { type: "settled" }]);
  eq(r.effects, ["arm-timer", "start-recording", "stop-recording"]);
  eq(r.phase, "idle");
  eq(run([down(), elapsed]).phase, "recording");
  eq(run([down(), elapsed, up()]).phase, "transcribing");
});

it("auto-repeat is swallowed while pending and while recording", () => {
  const repeat = down(" ", { repeat: true });
  const pending = run([down(), repeat, repeat, repeat]);
  eq(pending.phase, "pending");
  eq(pending.consumed, [true, true, true, true]);
  eq(pending.effects, ["arm-timer"]);
  const recording = run([down(), elapsed, repeat, repeat]);
  eq(recording.phase, "recording");
  eq(recording.consumed.slice(2), [true, true]);
  eq(recording.effects.includes("emit-space"), false);
});

it("Esc cancels a recording and a transcription", () => {
  const recording = run([down(), elapsed, down("Escape")]);
  eq(recording.phase, "idle");
  eq(recording.effects, ["arm-timer", "start-recording", "cancel-recording"]);
  eq(recording.consumed[2], true);
  // The Space released after the cancel is no longer ours.
  eq(stepSpaceHold("idle", up()).consume, false);
  const transcribing = run([down(), elapsed, up(), down("Escape")]);
  eq(transcribing.phase, "idle");
  eq(transcribing.effects[transcribing.effects.length - 1], "cancel-transcription");
});

it("Space with a modifier, a busy prompt, or an IME composition is a normal key", () => {
  eq(run([down(" ", { modifiers: true })]).effects, []);
  eq(run([down(" ", { modifiers: true })]).consumed, [false]);
  const busy = run([down(" ", {}, BUSY), down(" ", { repeat: true }, BUSY), up()]);
  eq(busy.phase, "idle");
  eq(busy.consumed, [false, false, false]);
  eq(busy.effects, []);
  eq(run([down(" ", { composing: true })]).consumed, [false]);
});

it("the idle check runs only for a fresh Space", () => {
  let asked = 0;
  const counting = () => {
    asked++;
    return true;
  };
  run([down("a", {}, counting), down(" ", { repeat: true }, counting), up()]);
  eq(asked, 0);
  run([down(" ", {}, counting)]);
  eq(asked, 1);
});

it("rollover typing sends the space before the next key", () => {
  const r = run([down(), down("b"), up()]);
  eq(r.effects, ["arm-timer", "disarm-timer", "emit-space"]);
  // The space is consumed at keydown, the next key passes through.
  eq(r.consumed, [true, false, false]);
  eq(r.phase, "idle");
});

it("an unrelated key-up while deciding changes nothing", () => {
  const r = run([down(), up("a")]);
  eq(r.phase, "pending");
  eq(r.consumed, [true, false]);
});

it("other keys pass through while recording and while transcribing", () => {
  const recording = run([down(), elapsed, down("x"), up("x")]);
  eq(recording.phase, "recording");
  eq(recording.consumed.slice(2), [false, false]);
  const transcribing = run([down(), elapsed, up(), down(" "), up()]);
  eq(transcribing.phase, "transcribing");
  eq(transcribing.consumed.slice(3), [false, false]);
});

it("losing focus drops a pending tap and cancels a recording, not a transcription", () => {
  eq(run([down(), { type: "blur" }]).effects, ["arm-timer", "disarm-timer"]);
  eq(run([down(), { type: "blur" }]).phase, "idle");
  const recording = run([down(), elapsed, { type: "blur" }]);
  eq(recording.phase, "idle");
  eq(recording.effects[recording.effects.length - 1], "cancel-recording");
  eq(run([down(), elapsed, up(), { type: "blur" }]).phase, "transcribing");
});

it("the cap stops a recording; a failed start returns to idle", () => {
  const capped = run([down(), elapsed, { type: "max-duration" }]);
  eq(capped.phase, "transcribing");
  eq(capped.effects[capped.effects.length - 1], "stop-recording");
  eq(run([down(), elapsed, { type: "settled" }]).phase, "idle");
  // A late timer after a tap does nothing.
  eq(run([down(), up(), elapsed]).phase, "idle");
});

it("dictation belongs to Codex and shell tiles, never Claude", () => {
  eq(dictationModeFor("codex"), "codex-tui");
  eq(dictationModeFor("codex-chat"), "codex-chat");
  eq(dictationModeFor("shell"), "shell");
  eq(dictationModeFor("claude"), null);
  eq(dictationModeFor("agent-run"), null);
});

it("a refused transcript names the gate that refused it (GH #67)", () => {
  eq(refusedTranscriptTitle("codex-tui"), "Transcript not inserted — the composer was not idle");
  eq(refusedTranscriptTitle("shell"), "Transcript not inserted — the shell is not at its prompt");
  eq(refusedTranscriptTitle("codex-chat"), "Transcript not inserted — the composer is unavailable");
});

console.log(`spaceHold.test.ts —${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  throw new Error(`${failed} spaceHold test(s) failed`);
}
