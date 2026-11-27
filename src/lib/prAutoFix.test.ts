// G7: Fix failing checks by itself — the state machine (fail → send → the
// Builder's turn ends → Finish and check → Verify and the Challenger →
// push), the tries, every stop, and the words. Run with
//   node --experimental-strip-types src/lib/prAutoFix.test.ts
import assert from "node:assert/strict";
import type { PrStatus } from "../ipc.ts";
import {
  AUTO_FIX_BUSY_GRACE_MS,
  AUTO_FIX_DELIVER_MS,
  AUTO_FIX_TURN_QUIET_MS,
  AUTO_FIX_REVIEW_START_MS,
  autoFixDefaultSince,
  AUTO_FIX_CHECK_MAX_MS,
  AUTO_FIX_NO_VERIFY_MS,
  AUTO_FIX_WORK_MAX_MS,
  autoFixFailingHead,
  autoFixNext,
  autoFixOn,
  autoFixRunningLine,
  autoFixSaved,
  autoFixStoppedNow,
  autoFixStoppedWords,
  type AutoFixCard,
  type AutoFixInput,
  type AutoFixPhase,
  type AutoFixSession,
} from "./prAutoFix.ts";

const NOW = 1_000_000;

function pr(over: Partial<PrStatus> = {}): PrStatus {
  return {
    number: 4,
    state: "open",
    checks: "failing",
    checksTotal: 1,
    checksPassed: 0,
    checksPending: 0,
    failingChecks: [{ name: "test", workflow: "ci", url: null }],
    mergeable: "mergeable",
    reviewDecision: "none",
    headSha: "h1",
    checkedAt: 10,
    ...over,
  } as PrStatus;
}

function card(over: Partial<AutoFixCard> = {}): AutoFixCard {
  return {
    id: "c1",
    workspaceId: "ws",
    archived: false,
    pr: pr(),
    prUrl: "https://github.com/o/r/pull/4",
    shipStatus: "unshipped",
    prReview: null,
    prAutoFix: true,
    builder: {
      vendor: "codex",
      bypass: false,
      ptyId: "p1",
      sessionLost: false,
      startedAt: 1,
      snapshots: [{ n: 1, sha: "h1", at: 5 }],
    },
    worktreePath: "/wt/c1",
    verifyStatus: "passed",
    verifyHistory: [],
    ...over,
  } as AutoFixCard;
}

const IDLE: AutoFixSession = {
  attached: true,
  live: false,
  promptIdle: true,
  turnIdle: true,
  turnIdleAt: 100,
  asking: false,
  held: false,
};

function next(over: Partial<AutoFixInput> = {}) {
  return autoFixNext({ card: card(), workspaceDefault: null, session: IDLE, phase: null, busySince: null, now: NOW, ...over });
}

// ── When it starts ──────────────────────────────────────────────────────

// Off by default: the workspace's default is off, a card that never
// flipped its own switch follows it.
assert.deepEqual(next({ card: card({ prAutoFix: undefined }) }), { do: "wait" });
const freshFail = pr({ failingSince: 50 });
assert.deepEqual(next({ card: card({ prAutoFix: undefined, pr: freshFail }), workspaceDefault: 40 }), { do: "begin", head: "h1" });
assert.deepEqual(next({ card: card({ prAutoFix: false, pr: freshFail }), workspaceDefault: 40 }), { do: "wait" });
assert.equal(autoFixOn({ prAutoFix: true, prReview: { url: "x" } as never }, 0), false, "never a pull request review card");

// G7 fixes (Minor 5): the workspace's default covers only failures first
// seen after it was turned on; the card's own switch any.
assert.deepEqual(next({ card: card({ prAutoFix: undefined, pr: freshFail }), workspaceDefault: 60 }), { do: "wait" }, "failing before");
assert.deepEqual(next({ card: card({ prAutoFix: undefined }), workspaceDefault: 0 }), { do: "wait" }, "no time kept: old");
assert.deepEqual(next({ card: card({ prAutoFix: true, pr: freshFail }), workspaceDefault: 60 }), { do: "begin", head: "h1" });
assert.equal(autoFixOn({ prAutoFix: undefined, prReview: null, pr: pr({ checks: "passing" }) }, 60), true, "on for the next failure");
assert.equal(autoFixDefaultSince({ fixFailingChecks: true, fixFailingChecksSince: 7 }), 7);
assert.equal(autoFixDefaultSince({ fixFailingChecks: true }), 0, "on before the time was kept");
assert.equal(autoFixDefaultSince({ fixFailingChecks: false, fixFailingChecksSince: 7 }), null);
assert.equal(autoFixDefaultSince(undefined), null);

// Failed checks on the head it has now, an idle session: a try.
assert.deepEqual(next(), { do: "begin", head: "h1" });
// Only failed checks: a reviewer's request for changes or a conflict stay a press.
assert.deepEqual(next({ card: card({ pr: pr({ checks: "passing", reviewDecision: "changes_requested" }) }) }), { do: "wait" });
assert.deepEqual(next({ card: card({ pr: pr({ mergeable: "conflicting" }) }) }), { do: "wait" });
// Just pushed: the failure GitHub shows is the old head's.
assert.equal(autoFixFailingHead(pr({ awaitingChecks: true })), null);
assert.deepEqual(next({ card: card({ pr: pr({ awaitingChecks: true }) }) }), { do: "wait" });
// Not open, archived, no Builder: nothing.
assert.deepEqual(next({ card: card({ pr: pr({ state: "merged" }) }) }), { do: "wait" });
assert.deepEqual(next({ card: card({ archived: true }) }), { do: "wait" });
assert.deepEqual(next({ card: card({ builder: null }) }), { do: "wait" });
// A round the pull request doesn't have yet is the person's (Push update).
const unpushed = card();
unpushed.builder!.snapshots = [{ n: 1, sha: "h1", at: 5 }, { n: 2, sha: "h9", at: 50 }];
assert.deepEqual(next({ card: unpushed }), { do: "wait" });

// One try per head; a stop after a try stands on this head.
assert.deepEqual(
  next({ card: card({ pr: pr({ autoFix: { heads: ["h1"], stopped: { reason: "push_refused", head: "h1", at: 1 } } }) }) }),
  { do: "wait" },
);
// G7 fixes: a try counted for this head that no window follows (Plyloft
// closed between the count and the paste): said, once.
assert.deepEqual(next({ card: card({ pr: pr({ autoFix: { heads: ["h1"] } }) }) }), {
  do: "stop",
  head: "h1",
  reason: "not_delivered",
});
assert.deepEqual(next({ card: { ...unpushed, pr: pr({ autoFix: { heads: ["h1"] } }) } }), { do: "wait" }, "a round to push is the person's");
// G7 fixes (M1): a stop before a try clears on its own — the try starts
// once the session is ready, and the same stop isn't said again.
const softClosed = pr({ autoFix: { heads: [], stopped: { reason: "session_closed", head: "h1", at: 1 } } });
assert.deepEqual(next({ card: card({ pr: softClosed }) }), { do: "begin", head: "h1" });
assert.deepEqual(next({ card: card({ pr: softClosed }), session: { ...IDLE, attached: false } }), { do: "wait" });
assert.deepEqual(next({ card: card({ pr: softClosed }), session: { ...IDLE, attached: false, live: true } }), {
  do: "stop",
  head: "h1",
  reason: "not_shown",
});
const softBusy = pr({ autoFix: { heads: [], stopped: { reason: "session_busy", head: "h1", at: 1 } } });
assert.deepEqual(next({ card: card({ pr: softBusy }), session: { ...IDLE, turnIdle: false } }), { do: "wait" });
const softSlot = pr({ autoFix: { heads: [], stopped: { reason: "network", head: "h1", at: 1 } } });
assert.deepEqual(next({ card: card({ pr: softSlot }) }), { do: "begin", head: "h1" }, "the claim is asked again");
// The tries running out is never a stop that clears.
assert.deepEqual(
  next({ card: card({ pr: pr({ autoFix: { heads: ["a", "b", "c"], stopped: { reason: "exhausted", head: "h1", at: 1 } } }) }) }),
  { do: "wait" },
);
// Three tries already: counted (the record says "stopped after 3 tries")
// before any session check — even with the session closed.
assert.deepEqual(
  next({
    card: card({
      pr: pr({ headSha: "h4", autoFix: { heads: ["h1", "h2", "h3"] } }),
      builder: { ...card().builder!, snapshots: [{ n: 4, sha: "h4", at: 9 }] },
    }),
    session: { ...IDLE, attached: false },
  }),
  { do: "begin", head: "h4" },
);

// ── Never into a closed, asking or busy session ──────────────────────────

assert.deepEqual(next({ session: { ...IDLE, attached: false } }), { do: "stop", head: "h1", reason: "session_closed" });
// G7 fixes (M1): live in Plyloft but its card isn't shown — a wait, said.
assert.deepEqual(next({ session: { ...IDLE, attached: false, live: true } }), { do: "stop", head: "h1", reason: "not_shown" });
assert.deepEqual(next({ session: { ...IDLE, asking: true } }), { do: "stop", head: "h1", reason: "question" });
const busy = { ...IDLE, turnIdle: false };
assert.deepEqual(next({ session: busy }), { do: "note-busy" });
assert.deepEqual(next({ session: busy, busySince: NOW - 1_000 }), { do: "wait" });
assert.deepEqual(next({ session: busy, busySince: NOW - AUTO_FIX_BUSY_GRACE_MS }), { do: "stop", head: "h1", reason: "session_busy" });
assert.deepEqual(next({ session: { ...IDLE, held: true }, busySince: NOW - AUTO_FIX_BUSY_GRACE_MS }), {
  do: "stop",
  head: "h1",
  reason: "session_busy",
});
// Back at its prompt within the grace: the try starts.
assert.deepEqual(next({ busySince: NOW - 1_000 }), { do: "begin", head: "h1" });

// ── One try, step by step ───────────────────────────────────────────────

const sentAt = NOW - 10_000;
const working: AutoFixPhase = { step: "working", head: "h1", attempt: 1, at: sentAt, snapshots: 1 };
// The Builder works (its turn ended before the fix went in): wait.
assert.deepEqual(next({ phase: working, session: { ...IDLE, turnIdleAt: sentAt - 5 } }), { do: "wait" });
assert.deepEqual(next({ phase: working, session: { ...IDLE, turnIdle: false } }), { do: "note-turn" });
assert.deepEqual(next({ phase: { ...working, turnStarted: true }, session: { ...IDLE, turnIdle: false } }), { do: "wait" });
// G7 fixes (Minor 2): no turn started 2 minutes after the paste and the
// composer not idle (the paste sits there, its Enter lost): not delivered.
const stuck = { ...IDLE, promptIdle: false, turnIdleAt: sentAt - 5 };
assert.deepEqual(next({ phase: working, session: stuck, now: sentAt + AUTO_FIX_DELIVER_MS - 1 }), { do: "wait" });
assert.deepEqual(next({ phase: working, session: stuck, now: sentAt + AUTO_FIX_DELIVER_MS }), {
  do: "stop",
  head: "h1",
  reason: "not_delivered",
});
assert.deepEqual(next({ phase: { ...working, turnStarted: true }, session: stuck, now: sentAt + AUTO_FIX_DELIVER_MS }), { do: "wait" });
// The card hidden mid-try: followed again once shown.
assert.deepEqual(next({ phase: working, session: { ...IDLE, attached: false, live: true } }), { do: "wait" });
// Its turn is over after the fix: Finish and check.
assert.deepEqual(next({ phase: working, session: { ...IDLE, turnIdleAt: NOW - AUTO_FIX_TURN_QUIET_MS } }), { do: "finish" });
// Walk 7 (G7): a turn that only looks over (Codex between two steps, 9 s
// after the paste) isn't finished yet: the turn must stay over a moment.
assert.deepEqual(next({ phase: { ...working, turnStarted: true }, session: { ...IDLE, turnIdleAt: NOW - 1_000 } }), { do: "wait" });
// A question meanwhile, the session closed, or too long: it stops.
assert.deepEqual(next({ phase: working, session: { ...IDLE, asking: true } }), { do: "stop", head: "h1", reason: "question" });
assert.deepEqual(next({ phase: working, session: { ...IDLE, attached: false } }), { do: "stop", head: "h1", reason: "session_closed" });
assert.deepEqual(
  next({ phase: { ...working, turnStarted: true }, session: { ...IDLE, turnIdle: false }, now: sentAt + AUTO_FIX_WORK_MAX_MS }),
  { do: "stop", head: "h1", reason: "timed_out" },
);

// Finish and check saved snapshot 2: checking it.
const finishing: AutoFixPhase = { step: "finishing", head: "h1", attempt: 1, at: NOW - 1_000, snapshots: 1 };
assert.equal(autoFixSaved(finishing, card(), NOW), null, "not saved yet");
assert.deepEqual(next({ phase: finishing, session: { ...IDLE, held: true } }), { do: "wait" });
const saved = card();
saved.builder!.snapshots = [{ n: 1, sha: "h1", at: 5 }, { n: 2, sha: "f2", at: NOW - 500 }];
const checking = autoFixSaved(finishing, saved, NOW)!;
assert.deepEqual(checking, { step: "checking", head: "h1", attempt: 1, at: NOW, snapshotN: 2, snapshotAt: NOW - 500 });

// Verify still running: wait. Passed while the Challenger reviews: wait.
// Passed and the review settled: push.
assert.deepEqual(next({ phase: checking, card: { ...saved, verifyStatus: "running" } }), { do: "wait" });
// 1.175.0 B2: the fix's checks wait for this Mac's OK — a wait with no time
// limit that spends no try; after the OK the round goes on as before.
{
  const held = { ...saved, checksHold: { at: NOW } };
  assert.deepEqual(next({ phase: checking, card: held }), { do: "hold" });
  assert.deepEqual(next({ phase: checking, card: held, now: NOW + 30 * 24 * 3_600_000 }), { do: "hold" }, "never timed out");
  assert.equal(
    autoFixRunningLine(checking, true),
    "Fixing the failed checks by itself (try 1 of 3): waiting for your OK to run this repository's checks.",
  );
  assert.equal(
    autoFixRunningLine(checking),
    "Fixing the failed checks by itself (try 1 of 3): checking the fix (Finish and check).",
  );
  // Only the check step waits on it.
  assert.equal(
    autoFixRunningLine({ step: "working", head: "h", attempt: 2, at: 0, snapshots: 0 }, true),
    "Fixing the failed checks by itself (try 2 of 3): the Builder is working on it.",
  );
}
const passed = { ...saved, verifyStatus: "passed" as const, verifyHistory: [{ verifyRunId: "v", status: "passed" as const, endedAt: NOW - 100 }] };
const reviewing = { ...passed, builder: { ...passed.builder!, review: { snapshotN: 2, status: "running" } as never } };
assert.deepEqual(next({ phase: checking, card: reviewing }), { do: "wait" });
const approved = { ...passed, builder: { ...passed.builder!, review: { snapshotN: 2, status: "done", verdict: "approve" } as never } };
assert.deepEqual(next({ phase: checking, card: approved }), { do: "push" });
// An older passing run (before the save) is not this snapshot's.
const stale = { ...saved, verifyStatus: "passed" as const, verifyHistory: [{ verifyRunId: "v", status: "passed" as const, endedAt: 1 }] };
assert.deepEqual(next({ phase: checking, card: stale }), { do: "wait" });
// No checks set up: none run; after a short wait the push gate decides.
const noChecks = { ...approved, verifyStatus: "none" as const, verifyHistory: [] };
assert.deepEqual(next({ phase: checking, card: noChecks, now: NOW + 1 }), { do: "wait" });
assert.deepEqual(next({ phase: checking, card: noChecks, now: NOW - 500 + AUTO_FIX_NO_VERIFY_MS }), { do: "push" });
// G7 fixes (Minor 1): pushed only once the Challenger approved the fix, or
// the person chose to skip its review; else it stops.
const skipped = { ...passed, builder: { ...passed.builder!, review: { snapshotN: 2, status: "skipped" } as never } };
assert.deepEqual(next({ phase: checking, card: skipped }), { do: "push" });
for (const review of [
  { snapshotN: 2, status: "failed" },
  { snapshotN: 2, status: "done", verdict: "incomplete" },
  { snapshotN: 2, status: "done", verdict: null },
]) {
  const c = { ...passed, builder: { ...passed.builder!, review: review as never } };
  assert.deepEqual(next({ phase: checking, card: c }), { do: "stop", head: "h1", reason: "review_failed" }, JSON.stringify(review));
}
// No review of the fix (an older one only): waits, then stops.
const olderReview = { ...passed, builder: { ...passed.builder!, review: { snapshotN: 1, status: "done", verdict: "approve" } as never } };
assert.deepEqual(next({ phase: checking, card: olderReview }), { do: "wait" });
assert.deepEqual(next({ phase: checking, card: olderReview, now: NOW + AUTO_FIX_REVIEW_START_MS }), {
  do: "stop",
  head: "h1",
  reason: "review_failed",
});
// This computer's checks failed, or the Challenger asked for changes: it stops.
const failed = { ...saved, verifyStatus: "failed" as const, verifyHistory: [{ verifyRunId: "v", status: "failed" as const, endedAt: NOW - 100 }] };
assert.deepEqual(next({ phase: checking, card: failed }), { do: "stop", head: "h1", reason: "verify_failed" });
const changes = { ...passed, builder: { ...passed.builder!, review: { snapshotN: 2, status: "done", verdict: "changes_requested" } as never } };
assert.deepEqual(next({ phase: checking, card: changes }), { do: "stop", head: "h1", reason: "changes_requested" });
assert.deepEqual(next({ phase: checking, card: reviewing, now: NOW + AUTO_FIX_CHECK_MAX_MS }), {
  do: "stop",
  head: "h1",
  reason: "timed_out",
});

// Pushed: waiting until GitHub has the new head; then the try is over and
// a new failure there is the next one.
const pushed: AutoFixPhase = { step: "pushed", head: "h1", attempt: 1, at: NOW };
assert.deepEqual(next({ phase: pushed }), { do: "wait" });
assert.deepEqual(next({ phase: pushed, card: card({ pr: pr({ headSha: "f2" }) }) }), { do: "forget" });
assert.deepEqual(
  next({ card: card({ pr: pr({ headSha: "f2", autoFix: { heads: ["h1"] } }), builder: { ...card().builder!, snapshots: [{ n: 2, sha: "f2", at: 9 }] } }) }),
  { do: "begin", head: "f2" },
  "try 2 on the pushed head",
);

// Someone else pushed, the switch went off, the pull request merged: the
// try is forgotten (nothing written).
assert.deepEqual(next({ phase: working, card: card({ pr: pr({ headSha: "zz" }) }) }), { do: "forget" });
assert.deepEqual(next({ phase: working, card: card({ prAutoFix: false }) }), { do: "forget" });
assert.deepEqual(next({ phase: working, card: card({ pr: pr({ state: "merged" }) }) }), { do: "forget" });

// ── Words ────────────────────────────────────────────────────────────────

assert.equal(autoFixStoppedWords("exhausted"), "Stopped fixing checks after 3 tries");
assert.equal(autoFixStoppedWords("session_closed"), "Couldn't fix the checks by itself: the Builder session is closed");
assert.equal(autoFixStoppedWords("from_a_later_build"), "Couldn't fix the checks by itself");
assert.equal(autoFixStoppedWords("not_shown"), "Open the card so Plyloft can follow its Builder");
assert.equal(autoFixStoppedWords("review_failed"), "Couldn't fix the checks by itself: the Reviewer couldn't review the fix");
// An old record's "card_slot" (no such stop any more) reads as the plain line.
assert.equal(autoFixStoppedWords("card_slot"), "Couldn't fix the checks by itself");
for (const r of ["plan_required", "team_account_mismatch", "licence", "network", "not_delivered"]) {
  assert.notEqual(autoFixStoppedWords(r), "Couldn't fix the checks by itself", r);
}
assert.equal(
  autoFixRunningLine({ step: "working", head: "h", attempt: 2, at: 0, snapshots: 0 }),
  "Fixing the failed checks by itself (try 2 of 3): the Builder is working on it.",
);
assert.deepEqual(
  autoFixStoppedNow(pr({ autoFix: { heads: ["h1"], stopped: { reason: "push_refused", head: "h1", at: 1, detail: "moved" } } })),
  { reason: "push_refused", detail: "moved" },
);
assert.equal(autoFixStoppedNow(pr({ headSha: "h2", autoFix: { heads: [], stopped: { reason: "question", head: "h1", at: 1 } } })), null);
// A stop before a try shows only while that head still fails.
const softQ = { heads: [], stopped: { reason: "question", head: "h1", at: 1 } };
assert.deepEqual(autoFixStoppedNow(pr({ autoFix: softQ })), { reason: "question", detail: null });
assert.equal(autoFixStoppedNow(pr({ checks: "pending", autoFix: softQ })), null);

console.log("prAutoFix: ok");
