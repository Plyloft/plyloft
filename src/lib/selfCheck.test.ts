// Unit tests for the Builder's self-check at Build done (ADR 0006, third
// card): when Build done goes on by itself, and what the card keeps.
//
// Run: node --experimental-strip-types src/lib/selfCheck.test.ts

import assert from "node:assert/strict";

import type { SelfCheckRecord } from "../ipc.ts";
import { turnIdleMatcherFor } from "./attention.ts";
import {
  SELF_CHECK_SILENCE_MS,
  formatDuration,
  selfCheckLead,
  selfCheckNote,
  selfCheckRecord,
  canDeliver,
  seesCompletion,
  selfCheckStep,
  selfCheckToken,
  settleSelfCheck,
  startBuildDone,
  tickSelfCheck,
  withoutMessage,
  type SelfCheckDeps,
  type SelfCheckObservation,
  type SelfCheckRun,
} from "./selfCheck.ts";

const TIMEOUT = 600_000;
const t0 = 1_000_000;
const run = (deliveredAt: number | null): SelfCheckRun => ({
  workspaceId: "ws",
  startedAt: t0,
  deliveredAt,
  message: "[Plyloft] self-check",
  token: "ply-abc123",
});

// Queued behind work the Builder was doing: nothing to wait on yet.
assert.equal(selfCheckStep(run(null), { lastOutputAt: t0 + 5_000 }, t0 + 60_000, TIMEOUT), "wait");

// Delivered, but nothing printed since: the Builder has not answered.
assert.equal(
  selfCheckStep(run(t0), { lastOutputAt: t0 - 1, turnIdle: true, promptScanAt: t0 }, t0 + 60_000, TIMEOUT),
  "wait",
);

// Working: output keeps coming, so it is not silent.
const back = {
  observed: true,
  lastOutputAt: t0 + 30_000,
  turnIdle: true,
  promptScanAt: t0 + 30_700,
  completionSeen: true,
};
assert.equal(selfCheckStep(run(t0), back, t0 + 31_000, TIMEOUT), "wait");

// Back at its prompt: silent long enough, and the scan after the last
// output shows the turn over. Build done continues on the prompt returning.
assert.equal(selfCheckStep(run(t0), back, t0 + 30_000 + SELF_CHECK_SILENCE_MS, TIMEOUT), "answered");

// GH #111 F2/F19: a pause at a drawn composer (a Codex stream) without the
// run's completion line is no answer.
assert.equal(
  selfCheckStep(run(t0), { ...back, completionSeen: false }, t0 + 300_000, TIMEOUT),
  "wait",
);
// The completion line: the echo of the message never matches (no number),
// nor an earlier run's line (another token).
const message = "End your answer with this line, the number filled in:\nSelf-check complete: <number of classes> classes (ply-abc123)";
assert.equal(seesCompletion(message, "ply-abc123"), false);
assert.equal(seesCompletion("K. Other — checked\nSelf-check complete: 11 classes (ply-old999)", "ply-abc123"), false);
assert.equal(seesCompletion("⏺ K. Other — checked\n  Self-check complete: 11 classes (ply-abc123)", "ply-abc123"), true);
assert.match(selfCheckToken(() => 0.5), /^ply-[0-9a-z]{6}$/);

// GH #111 F2: silent at a question or in a running turn — the production
// matchers say not idle, so it keeps waiting however long the silence.
const scanned = (tail: string, vendor: string): SelfCheckObservation => ({
  observed: true,
  lastOutputAt: t0 + 30_000,
  turnIdle: turnIdleMatcherFor(vendor)(tail),
  promptScanAt: t0 + 30_700,
  completionSeen: true,
});
const approval = [
  "Would you like to run the following command?",
  "  $ cargo test --workspace --lib",
  "› 1. Yes, proceed (y)",
  "  2. No, and tell Codex what to do differently (esc)",
  "",
  "  Press enter to confirm or esc to cancel",
].join("\n");
const permission = [
  "│ Do you want to proceed?                                │",
  "│ ❯ 1. Yes                                               │",
  "│   2. No, and tell Claude what to do differently (esc)  │",
].join("\n");
const quietTool = [
  "✻ Running cargo test… (3m 12s · esc to interrupt)",
  "────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────",
].join("\n");
for (const [tail, vendor] of [
  [approval, "codex"],
  [permission, "claude"],
  [quietTool, "claude"],
] as const) {
  assert.equal(selfCheckStep(run(t0), scanned(tail, vendor), t0 + 300_000, TIMEOUT), "wait", tail);
}

// GH #111 F2/F13: the terminal detached (card closed, or another card in
// the host) — output after the last scan: the screen is unknown, and
// silence alone never answers. Only Skip or the timeout end it.
const unseen = { ...back, promptScanAt: t0 + 1_000 };
assert.equal(selfCheckStep(run(t0), unseen, t0 + TIMEOUT - 1, TIMEOUT), "wait");

// The owner's rule (GH #111): unobserved means wait. With the card's live
// terminal not attached, even a screen that looked finished at its last
// scan, with the completion line and long silence, never completes and
// never receives the self-check; only Skip or the timeout end it.
const closed = { ...back, observed: false };
assert.equal(selfCheckStep(run(t0), closed, t0 + TIMEOUT - 1, TIMEOUT), "wait");
assert.equal(selfCheckStep(run(t0), { ...back, observed: undefined }, t0 + TIMEOUT - 1, TIMEOUT), "wait");
assert.equal(selfCheckStep(run(t0), closed, t0 + TIMEOUT, TIMEOUT), "timedOut");

// Not back within the limit: skipped, whatever the screen says.
assert.equal(selfCheckStep(run(t0), back, t0 + TIMEOUT, TIMEOUT), "timedOut");
assert.equal(selfCheckStep(run(null), {}, t0 + TIMEOUT, TIMEOUT), "timedOut");

// The record the card keeps, and what the session and the card say.
const record = selfCheckRecord(run(t0), "answered", t0 + 95_000);
assert.deepEqual(record, { outcome: "answered", startedAt: t0, durationMs: 95_000 });
assert.equal(selfCheckLead("answered"), "");
assert.equal(selfCheckLead(null), "");
assert.match(selfCheckLead("skipped"), /^The human skipped your self-check\. $/);
assert.match(selfCheckLead("timedOut"), /did not finish within 10 minutes/);
assert.equal(selfCheckNote(null), null);
assert.equal(selfCheckNote({ ...record, snapshotN: 3 }), "Re-reading its work took 1 min 35 s.");
assert.equal(
  selfCheckNote({ outcome: "timedOut", startedAt: t0, durationMs: TIMEOUT, snapshotN: 4 }),
  "The Builder didn't finish re-reading its work within 10 minutes, so Plyloft went on to your checks and the review without it.",
);
assert.equal(formatDuration(42_000), "42 s");
assert.equal(formatDuration(120_000), "2 min");

assert.deepEqual(withoutMessage(["a", "check", "b", "check"], "check"), ["a", "b", "check"]);
assert.deepEqual(withoutMessage(["a"], "check"), ["a"]);

// GH #111 F32: when the self-check may be written. A fresh scan showing
// the turn over and 10 s of silence; never at an approval screen, in a
// running turn or a paused stream, or on a scan older than the output.
const idleAt = (ms: number): SelfCheckObservation => ({
  observed: true,
  lastOutputAt: t0 + ms,
  turnIdle: true,
  promptScanAt: t0 + ms + 700,
});
assert.equal(canDeliver(idleAt(0), t0 + SELF_CHECK_SILENCE_MS), true);
assert.equal(canDeliver(idleAt(0), t0 + 2_000), false, "a pause is not the end of a turn");
assert.equal(canDeliver({ ...idleAt(0), promptScanAt: t0 - 1 }, t0 + 60_000), false, "stale scan");
assert.equal(canDeliver({ ...idleAt(0), observed: false }, t0 + 60_000), false, "unobserved: never written");
for (const [tail, vendor] of [
  [approval, "codex"],
  [permission, "claude"],
  [quietTool, "claude"],
] as const) {
  assert.equal(canDeliver({ ...idleAt(0), turnIdle: turnIdleMatcherFor(vendor)(tail) }, t0 + 60_000), false, tail);
}

// ── The flow: Build done → self-check → Verify and the Challenger ──────

function fake(opts: { message?: string | null; alive?: boolean } = {}) {
  let clock = t0;
  const runs = new Map<string, SelfCheckRun>();
  const log: string[] = [];
  const finished: Array<SelfCheckRecord | null> = [];
  // What reached the Builder, and the general queue behind it.
  let pending: string[] = [];
  const delivered: string[] = [];
  // The Builder is busy until the test says its turn is over.
  let seen: SelfCheckObservation = { lastOutputAt: t0, turnIdle: false, promptScanAt: t0 + 700 };
  let alive = opts.alive ?? true;
  let busy = false;
  let release: (() => void) | null = null;
  let deferFinish = false;
  const deps: SelfCheckDeps = {
    now: () => clock,
    timeoutMs: TIMEOUT,
    getRun: (id) => runs.get(id),
    setRun: (id, r) => {
      if (r) runs.set(id, r);
      else runs.delete(id);
    },
    sessionAlive: () => alive,
    message: async () => (opts.message === undefined ? "[Plyloft] self-check" : opts.message),
    send: async (_id, text) => {
      log.push(`send ${text}`);
      delivered.push(text);
      return true;
    },
    token: () => "ply-abc123",
    unsend: (_id, text) => {
      pending = withoutMessage(pending, text);
    },
    busy: () => busy,
    observe: async () => seen,
    // Build done's own work: the snapshot, then Verify and the Challenger,
    // with its notice queued for the Builder.
    finish: async (_ws, _id, check) => {
      busy = true;
      if (deferFinish) await new Promise<void>((resolve) => (release = resolve));
      finished.push(check);
      pending.push("[Plyloft] Build done: snapshot");
      log.push("snapshot + verify");
      busy = false;
    },
    notify: (_kind, title) => {
      log.push(`toast ${title}`);
    },
  };
  return {
    deps,
    runs,
    log,
    finished,
    delivered,
    at: (ms: number) => {
      clock = t0 + ms;
    },
    see: (next: SelfCheckObservation) => {
      seen = next;
    },
    end: () => {
      alive = false;
    },
    defer: () => {
      deferFinish = true;
    },
    release: () => release?.(),
  };
}

async function flowTests(): Promise<void> {
  // Switch on: Build done sets the self-check up and takes no snapshot yet;
  // it is written once the Builder's turn is confirmed over.
  {
    const f = fake();
    assert.equal(await startBuildDone(f.deps, "ws", "c1", false), "self-check");
    assert.deepEqual(f.log, ["toast Re-reading its work"]);
    assert.equal(f.finished.length, 0, "no snapshot before the Builder answers");
    assert.equal(f.runs.get("c1")?.token, "ply-abc123");
    // A second press while it runs starts nothing.
    assert.equal(await startBuildDone(f.deps, "ws", "c1", false), "already");
    // Busy (an approval question, a running turn): nothing is written.
    f.at(30_000);
    assert.equal(await tickSelfCheck(f.deps, "c1"), "wait");
    assert.deepEqual(f.delivered, []);
    // The turn ends: written, delivery stamped after the write.
    f.see(idleAt(30_000));
    f.at(30_000 + SELF_CHECK_SILENCE_MS);
    assert.equal(await tickSelfCheck(f.deps, "c1"), "wait");
    assert.deepEqual(f.delivered, ["[Plyloft] self-check"]);
    assert.equal(f.runs.get("c1")?.deliveredAt, t0 + 30_000 + SELF_CHECK_SILENCE_MS);
    // It works, prints its completion line and is back: Build done continues.
    f.see({ ...idleAt(100_000), completionSeen: false });
    f.at(100_000 + SELF_CHECK_SILENCE_MS);
    assert.equal(await tickSelfCheck(f.deps, "c1"), "wait", "no completion line yet");
    f.see({ ...idleAt(120_000), completionSeen: true });
    f.at(120_000 + SELF_CHECK_SILENCE_MS);
    assert.equal(await tickSelfCheck(f.deps, "c1"), "answered");
    assert.deepEqual(f.finished, [{ outcome: "answered", startedAt: t0, durationMs: 130_000 }]);
    assert.equal(f.log[f.log.length - 1], "snapshot + verify");
    assert.equal(f.runs.size, 0);
    assert.equal(await tickSelfCheck(f.deps, "c1"), "none", "settled once");
    assert.equal(f.finished.length, 1);
  }
  // GH #111 F5: never written, then Skip — it never reaches the Builder
  // after the snapshot, and Build done runs once however often Skip is
  // pressed.
  {
    const f = fake();
    await startBuildDone(f.deps, "ws", "c1", false);
    f.at(5_000);
    assert.equal(await settleSelfCheck(f.deps, "c1", "skipped"), true);
    assert.equal(await settleSelfCheck(f.deps, "c1", "skipped"), false);
    assert.deepEqual(f.finished, [{ outcome: "skipped", startedAt: t0, durationMs: 5_000 }]);
    f.see(idleAt(6_000));
    f.at(60_000);
    assert.equal(await tickSelfCheck(f.deps, "c1"), "none");
    assert.deepEqual(f.delivered, [], "the skipped self-check is never written");
  }
  // Not back within 10 minutes: skipped with a note, then Verify.
  {
    const f = fake();
    await startBuildDone(f.deps, "ws", "c1", false);
    f.at(TIMEOUT);
    assert.equal(await tickSelfCheck(f.deps, "c1"), "timedOut");
    assert.equal(f.finished[0]?.outcome, "timedOut");
    assert.ok(f.log.includes("toast Re-reading skipped"));
    assert.equal(f.log[f.log.length - 1], "snapshot + verify");
    assert.deepEqual(f.delivered, []);
  }
  // Unobserved means wait: the card closes before the Builder's turn ends.
  // Nothing is written, nothing completes, and at 10 minutes it is skipped
  // with the note — then Verify.
  {
    const f = fake();
    await startBuildDone(f.deps, "ws", "c1", false);
    f.see({ ...idleAt(0), completionSeen: true, observed: false });
    for (const ms of [30_000, 120_000, TIMEOUT - 1]) {
      f.at(ms);
      assert.equal(await tickSelfCheck(f.deps, "c1"), "wait");
    }
    assert.deepEqual(f.delivered, []);
    assert.equal(f.finished.length, 0);
    f.at(TIMEOUT);
    assert.equal(await tickSelfCheck(f.deps, "c1"), "timedOut");
    assert.deepEqual(f.finished, [{ outcome: "timedOut", startedAt: t0, durationMs: TIMEOUT }]);
    assert.deepEqual(f.delivered, []);
  }
  // Delivered while observed, then the card closes before the answer: it
  // waits too, however finished the last scan looked.
  {
    const f = fake();
    await startBuildDone(f.deps, "ws", "c1", false);
    f.see(idleAt(0));
    f.at(SELF_CHECK_SILENCE_MS);
    await tickSelfCheck(f.deps, "c1");
    assert.deepEqual(f.delivered, ["[Plyloft] self-check"]);
    f.see({ ...idleAt(60_000), completionSeen: true, observed: false });
    f.at(60_000 + 5 * SELF_CHECK_SILENCE_MS);
    assert.equal(await tickSelfCheck(f.deps, "c1"), "wait");
    f.see({ ...idleAt(60_000), completionSeen: true, observed: true });
    assert.equal(await tickSelfCheck(f.deps, "c1"), "answered", "the card reopens: its live scan decides");
  }
  // GH #111 F38: the Builder first qualifies at the deadline — an expired,
  // undelivered run is settled, never written.
  {
    const f = fake();
    await startBuildDone(f.deps, "ws", "c1", false);
    f.see(idleAt(TIMEOUT - SELF_CHECK_SILENCE_MS - 1_000));
    f.at(TIMEOUT);
    assert.equal(await tickSelfCheck(f.deps, "c1"), "timedOut");
    assert.deepEqual(f.delivered, [], "never sent after the deadline");
    assert.equal(f.finished[0]?.outcome, "timedOut");
  }
  // The observation crosses the deadline while it is read.
  {
    const f = fake();
    await startBuildDone(f.deps, "ws", "c1", false);
    f.see(idleAt(0));
    f.at(TIMEOUT - 1);
    const observe = f.deps.observe;
    f.deps.observe = async (id) => {
      f.at(TIMEOUT + 1);
      return observe(id);
    };
    assert.equal(await tickSelfCheck(f.deps, "c1"), "timedOut");
    assert.deepEqual(f.delivered, []);
  }
  // The session ends mid-check: nothing is snapshotted behind the human's
  // back, and nothing is written.
  {
    const f = fake();
    await startBuildDone(f.deps, "ws", "c1", false);
    f.end();
    assert.equal(await tickSelfCheck(f.deps, "c1"), "ended");
    assert.equal(f.finished.length, 0);
    assert.deepEqual(f.delivered, []);
    assert.ok(f.log.includes("toast Finish and check stopped"));
  }
  // GH #111 F6: while the continuation's snapshot and Verify handoff run,
  // another press starts neither a self-check nor a second Build done.
  {
    const f = fake();
    f.defer();
    await startBuildDone(f.deps, "ws", "c1", false);
    const settling = settleSelfCheck(f.deps, "c1", "skipped");
    assert.equal(await startBuildDone(f.deps, "ws", "c1", false), "already");
    f.release();
    await settling;
    assert.equal(f.finished.length, 1);
  }
  // Switch off (or nothing new), Skip review, or no live session: Build
  // done goes straight on, with no self-check recorded.
  for (const [f, skip] of [
    [fake({ message: null }), false],
    [fake(), true],
    [fake({ alive: false }), false],
  ] as const) {
    assert.equal(await startBuildDone(f.deps, "ws", "c1", skip), "finished");
    assert.deepEqual(f.finished, [null]);
    assert.deepEqual(f.delivered, []);
  }
  // The backend could not say: Build done goes on without it.
  {
    const f = fake();
    f.deps.message = async () => {
      throw new Error("no worktree");
    };
    assert.equal(await startBuildDone(f.deps, "ws", "c1", false), "finished");
    assert.ok(f.log.includes("toast Self-check not sent"));
  }
}


// Windows port: the screens codex-cli 0.157.0 left under ConPTY (Windows 11
// VM, 120×32, `ptytui` capture replayed through xterm, rows as
// `translateToString(true)` reads them, trailing spaces dropped). The first
// is Ply's old paste with the CR in the same write: Codex took the Enter as
// part of the paste and the self-check sat unsent — the composer is idle
// and no completion line ever comes, so Build done waited out 10 minutes.
// The second is the same message submitted by a separate Enter: the turn
// over, the completion line on screen.
{
  const unsent = [
    "  /model - choose what model and reasoning effort to use",
    "  /review - review any changes and find issues",
    "", "", "", "", "", "", "", "", "", "", "", "", "", "",
    "› [Pasted Content 2883 chars]",
    "",
    "  GPT-6-Astra default · C:\\Users\\MATTEO~1\\AppData\\Local\\Temp\\ply-tui-91e48f69-871e-4372-8647-1e1f9876d4ba",
    "",
  ].join("\n");
  assert.equal(turnIdleMatcherFor("codex")(unsent), true);
  assert.equal(seesCompletion(unsent, "ply-t3st01"), false);

  const answered = [
    "",
    "• A. Requirements — checked available change; brief absent, full coverage unverified.",
    "  B. Concurrency and ordering — checked, no defects.",
    "  C. State and persistence — checked, no defects.",
    "  D. Failure paths — checked, no defects.",
    "  E. Processes and resources — checked, no defects.",
    "  F. Boundaries and contracts — checked, no defects.",
    "  G. Data safety — checked, no defects.",
    "  H. Tests — reviewed; execution blocked by inaccessible Python executable.",
    "  I. User-facing text and states — checked, no defects.",
    "",
    "  Self-check complete: 9 classes (ply-t3st01)",
    "",
    "  Worked for 1m 2s · 11:00",
    "                                               Tip: Type / to open the command popup; Tab autocompletes slash commands.",
    "",
    "› Ask Codex to do anything",
    "",
    "  GPT-6-Astra default · C:\\Users\\MATTEO~1\\AppData\\Local\\Temp\\ply-tui-3a0da118-ea69-41a8-9ab8-5e489ed92745 · Review chan…",
    "  ? for shortcuts",
  ].join("\n");
  assert.equal(turnIdleMatcherFor("codex")(answered), true);
  assert.equal(seesCompletion(answered, "ply-t3st01"), true);
}

await flowTests();

console.log("self-check tests passed");
