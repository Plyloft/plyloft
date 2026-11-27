// Tier 3 pure-function test (CL-7). Run with Node 22+:
//   node --experimental-strip-types src/lib/sessionActor.test.ts
import assert from "node:assert/strict";
import {
  actorStateWords,
  bothLanesActorWords,
  cardActor,
  resumedWithoutTurn,
  laneActor,
  type ActorCard,
  type LiveSession,
} from "./sessionActor.ts";
import { sessionSummary } from "./cardPage.ts";
import { matchesClaudePromptIdle, matchesClaudeTurnIdle } from "./attention.ts";
import { waitingSessions } from "./needsYou.ts";
import type { BuildBoth, BuilderReview } from "../ipc.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
}

const NOW = 2_000_000_000;
const MIN = 60_000;

function card(over: Partial<NonNullable<ActorCard["builder"]>> = {}, rest: Partial<ActorCard> = {}): ActorCard {
  return {
    lastRunStatus: "running",
    builder: { vendor: "claude", startedAt: NOW - 30 * MIN, ptyId: "p1", snapshots: [], ...over },
    ...rest,
  };
}

function live(over: Partial<LiveSession> = {}): LiveSession {
  return { ptyId: "p1", vendor: "claude", startedAt: NOW - 30 * MIN, ...over };
}

const busy = live({ lastOutputAt: NOW - 1_000 });
const atPrompt = live({ lastOutputAt: NOW - 60_000, promptBoxIdle: true, turnIdle: true });
const question = live({ lastOutputAt: NOW - 60_000, promptBoxIdle: true, turnIdle: false });
const quiet = live({ lastOutputAt: NOW - 60_000, promptBoxIdle: false });

function review(over: Partial<BuilderReview> = {}): BuilderReview {
  return { snapshotN: 1, provider: "codex", degraded: false, status: "running", at: NOW - 2 * MIN, ...over };
}

test("busy: the vendor, building, and how long this turn has run", () => {
  // No message sent since the session started: its start is the turn's.
  assert.deepEqual(cardActor({ card: card(), live: busy, now: NOW }), {
    words: "Claude · working · 30m",
    spoken: "Claude · working",
    dot: "running",
    session: "building",
  });
  // A message submitted 4 minutes ago started this turn.
  assert.equal(cardActor({ card: card(), live: busy, submittedAt: NOW - 4 * MIN, now: NOW })?.words, "Claude · working · 4m");
  // Keys typed since do not restart the clock: only a submit does.
  assert.equal(
    cardActor({ card: card(), live: busy, sentAt: NOW - 10_000, submittedAt: NOW - 4 * MIN, now: NOW })?.words,
    "Claude · working · 4m",
  );
  // Under a minute: no clock.
  assert.equal(cardActor({ card: card(), live: busy, submittedAt: NOW - 20_000, now: NOW })?.words, "Claude · working");
});

test("Codex as the Builder is named Codex", () => {
  const c = card({ vendor: "codex" });
  assert.equal(cardActor({ card: c, live: live({ vendor: "codex", lastOutputAt: NOW }), submittedAt: NOW - 6 * MIN, now: NOW })?.words, "Codex · working · 6m");
});

test("idle at its prompt, or asking a question: stopped or needs your answer, no clock", () => {
  assert.deepEqual(cardActor({ card: card(), live: atPrompt, now: NOW }), { words: "Claude · your turn", spoken: "Claude · your turn", dot: "done", session: "stopped" });
  assert.deepEqual(cardActor({ card: card(), live: question, now: NOW }), { words: "Claude · asks you something", spoken: "Claude · asks you something", dot: "aborted", session: "question" });
});

test("silent with no prompt in view is quiet, never claimed as waiting", () => {
  assert.deepEqual(cardActor({ card: card(), live: quiet, now: NOW }), { words: "Claude · your turn", spoken: "Claude · your turn", dot: "aborted", session: "quiet" });
});

test("Finish and check with nothing sent since reads work saved", () => {
  const c = card({ snapshots: [{ n: 1, sha: "abc", at: NOW - 5 * MIN } as never] }, { lastRunStatus: "success" });
  assert.deepEqual(cardActor({ card: c, live: atPrompt, now: NOW }), { words: "Claude · your turn", spoken: "Claude · your turn", dot: "done", session: "saved" });
  // Something sent after the snapshot: the session's own state again.
  assert.equal(cardActor({ card: c, live: busy, sentAt: NOW - 2 * MIN, submittedAt: NOW - 2 * MIN, now: NOW })?.words, "Claude · working · 2m");
});

test("a Reviewer review names the reviewer and outranks the Builder", () => {
  assert.deepEqual(cardActor({ card: card({ review: review() }), live: atPrompt, now: NOW }), {
    words: "Codex · reviewing · 2m",
    spoken: "Codex · reviewing",
    dot: "running",
  });
  assert.equal(cardActor({ card: card({ review: review({ at: NOW - 10_000 }) }), live: null, now: NOW })?.words, "Codex · reviewing");
  assert.equal(
    cardActor({ card: card({ vendor: "codex", review: review({ provider: "claude", at: NOW - 3 * MIN }) }), live: null, now: NOW })?.words,
    "Claude · reviewing · 3m",
  );
  // A finished review says nothing here; the session decides.
  assert.equal(cardActor({ card: card({ review: review({ status: "done", verdict: "approve" }) }), live: busy, submittedAt: NOW - MIN, now: NOW })?.words, "Claude · working · 1m");
});

test("Plyloft's checks have no vendor actor", () => {
  assert.deepEqual(cardActor({ card: card({}, { verifyStatus: "running" }), live: busy, now: NOW }), { words: "Running checks", spoken: "Running checks", dot: "running" });
  assert.equal(cardActor({ card: card({}, { verifyStatus: "queued" }), live: atPrompt, now: NOW })?.words, "Running checks");
});

test("no session, or one this window has not attached: nothing is claimed", () => {
  assert.equal(cardActor({ card: card({ ptyId: null }), live: busy, now: NOW }), null);
  assert.equal(cardActor({ card: card(), live: null, now: NOW }), null);
  // A runtime of an older session is not this one.
  assert.equal(cardActor({ card: card(), live: live({ ptyId: "old", lastOutputAt: NOW }), now: NOW }), null);
  assert.equal(cardActor({ card: { lastRunStatus: null, builder: null }, live: null, now: NOW }), null);
});

const both: BuildBoth = {
  startedAt: NOW - 20 * MIN,
  lanes: [
    { lane: "a", vendor: "claude", worktreePath: "/w/a", branchName: "a", ptyId: "pa", startedAt: NOW - 20 * MIN },
    { lane: "b", vendor: "codex", worktreePath: "/w/b", branchName: "b", ptyId: "pb", startedAt: NOW - 20 * MIN },
  ],
};
const bothCard = { worktreeSetup: null, buildBoth: both };

test("Build with both: each build names its vendor", () => {
  const a = live({ ptyId: "pa", lastOutputAt: NOW });
  const b = live({ ptyId: "pb", vendor: "codex", lastOutputAt: NOW - MIN, promptBoxIdle: true, turnIdle: true });
  assert.equal(laneActor({ card: bothCard, lane: "a", live: a, submittedAt: NOW - 4 * MIN, now: NOW }).words, "Claude · working · 4m");
  assert.equal(laneActor({ card: bothCard, lane: "b", live: b, now: NOW }).words, "Codex · your turn");
  assert.equal(
    bothLanesActorWords({ card: bothCard, live: { a, b }, submittedAt: { a: NOW - 4 * MIN }, now: NOW }),
    "Claude · working · 4m. Codex · your turn.",
  );
  // A session not attached here keeps its stage, with its vendor.
  assert.equal(laneActor({ card: bothCard, lane: "b", live: null, now: NOW }).words, "Codex · working");
  // A build done is said as done; its checks are Plyloft's.
  const done: BuildBoth = {
    ...both,
    lanes: [both.lanes[0], { ...both.lanes[1], done: { sha: "s", at: NOW }, verify: { status: "running", sha: "s", at: NOW } }],
  };
  assert.equal(laneActor({ card: { worktreeSetup: null, buildBoth: done }, lane: "b", live: b, now: NOW }).words, "Codex · checks running");
});

// Round 2 (F1): typing at the prompt echoes, so the session's output is
// fresh — but its turn is over and nothing was submitted: waiting for you.
test("typing at its prompt is not building; an Enter after the scan is", () => {
  const typing = live({ lastOutputAt: NOW - 200, promptBoxIdle: true, turnIdle: true, turnIdleAt: NOW - 30_000 });
  assert.deepEqual(cardActor({ card: card(), live: typing, sentAt: NOW - 200, submittedAt: NOW - 5 * MIN, now: NOW }), {
    words: "Claude · your turn",
    spoken: "Claude · your turn",
    dot: "done",
    session: "stopped",
  });
  // Never submitted at all: still typing, still waiting.
  assert.equal(cardActor({ card: card(), live: typing, sentAt: NOW - 200, now: NOW })?.words, "Claude · your turn");
  // Enter pressed after the scan that found the turn over: a new turn, even
  // before the next scan has seen it start — no false "waiting".
  assert.deepEqual(cardActor({ card: card(), live: typing, sentAt: NOW - 100, submittedAt: NOW - 100, now: NOW }), {
    words: "Claude · working",
    spoken: "Claude · working",
    dot: "running",
    session: "building",
  });
  // A submit in the same millisecond as the scan is a submit: building —
  // although a key went in after the scan (the Enter itself).
  assert.equal(cardActor({ card: card(), live: typing, sentAt: NOW - 200, submittedAt: NOW - 30_000, now: NOW })?.words, "Claude · working");
  // One millisecond before the scan, it was the turn the scan saw end.
  assert.equal(
    cardActor({ card: card(), live: typing, sentAt: NOW - 200, submittedAt: NOW - 30_001, now: NOW })?.words,
    "Claude · your turn",
  );
  // The next scan finds the turn running: building, the clock from the submit.
  const running = live({ lastOutputAt: NOW - 200, promptBoxIdle: true, turnIdle: false, turnIdleAt: NOW - 30_000 });
  assert.equal(cardActor({ card: card(), live: running, submittedAt: NOW - 3 * MIN, now: NOW })?.words, "Claude · working · 3m");
});

// SP-4 (walk): Codex keeps its prompt box in view while it works, so the
// last scan can still say its turn is over while fresh output streams. No
// key went in since that scan: the output is Codex's own work — building.
test("1.174.3: a resumed session that received no new turn doesn't claim work", () => {
  const resumed = { ...busy, vendor: "codex" as const, resumedAt: NOW - 3_000, lastOutputAt: NOW - 500 };
  const codexCard = card();
  codexCard.builder = { ...codexCard.builder!, vendor: "codex" };
  const idle = cardActor({ card: codexCard, live: resumed, now: NOW });
  assert.equal(idle?.spoken, "Codex · your turn");
  assert.equal(idle?.session, "resumed");
  assert.equal(
    sessionSummary({ vendor: "codex", attention: "working", startedAt: NOW - 5 * MIN, lastOutputAt: NOW - 500, filesChanged: 1, actor: idle?.session, now: NOW }),
    "Codex hasn't started anything since Resume. Started 5m ago. 1 file changed so far.",
  );
  assert.equal(resumedWithoutTurn(resumed, null, null), true);
  // Keys or a paste since the Resume: the rules of any session again.
  assert.equal(cardActor({ card: codexCard, live: resumed, sentAt: NOW - 1_000, now: NOW })?.session, "building");
  assert.equal(cardActor({ card: codexCard, live: resumed, submittedAt: NOW - 1_000, now: NOW })?.session, "building");
  // Sent before it: that was the last session.
  assert.equal(cardActor({ card: codexCard, live: resumed, sentAt: NOW - 60_000, now: NOW })?.session, "resumed");
  // A settled scan found the turn over: that is evidence, and it says so.
  assert.equal(
    cardActor({ card: codexCard, live: { ...resumed, turnIdle: true, promptBoxIdle: true, turnIdleAt: NOW - 400, lastSettledScanAt: NOW - 100 }, now: NOW })?.session,
    "stopped",
  );
  // A session Start build started is never this.
  assert.equal(cardActor({ card: codexCard, live: { ...resumed, resumedAt: undefined }, now: NOW })?.session, "building");
  // A question in view still asks.
  assert.equal(cardActor({ card: codexCard, live: { ...resumed, questionInView: true }, now: NOW })?.session, "question");
  // Nothing to wait on or to finish until a scan says so: no Your turn rule in
  // the Inbox and the Board.
  const waitingNow = waitingSessions({
    tilesByWorkspace: {},
    builders: { c1: { ...resumed, workspaceId: "w" } },
    cardTitle: () => "A card",
    now: NOW,
  } as never);
  assert.equal(waitingNow.length, 0);
});

test("a stale scan with fresh output and no key sent since reads building", () => {
  const streaming = live({
    ptyId: "pb",
    vendor: "codex",
    lastOutputAt: NOW - 300,
    promptBoxIdle: true,
    turnIdle: true,
    turnIdleAt: NOW - 2 * MIN,
    // The output since cleared the settled scan that found it idle.
  });
  // The last key went in before the scan that found the turn over.
  assert.equal(
    laneActor({ card: bothCard, lane: "b", live: streaming, sentAt: NOW - 3 * MIN, submittedAt: NOW - 3 * MIN, now: NOW }).words,
    "Codex · working · 3m",
  );
  // Nothing ever sent: building too.
  assert.equal(laneActor({ card: bothCard, lane: "b", live: streaming, now: NOW }).words, "Codex · working · 20m");
  // A key after the scan, nothing submitted: the person is typing — waiting.
  assert.equal(
    laneActor({ card: bothCard, lane: "b", live: streaming, sentAt: NOW - 300, submittedAt: NOW - 3 * MIN, now: NOW }).words,
    "Codex · your turn",
  );
  // The same on a single Builder session.
  const single = live({ vendor: "codex", lastOutputAt: NOW - 300, promptBoxIdle: true, turnIdle: true, turnIdleAt: NOW - 2 * MIN });
  assert.equal(cardActor({ card: card({ vendor: "codex" }), live: single, sentAt: NOW - 3 * MIN, now: NOW })?.words, "Codex · working · 30m");
});

// SP-4 round 2 (Challenger F1): a turn that just ended — its last lines
// a second ago, the Enter that started it a minute ago, no key since — is
// waiting for you as soon as a scan after that output found it over, not
// "building" until the output goes quiet.
test("a turn just ended, no key since, reads waiting for you at once", () => {
  const ended = live({
    lastOutputAt: NOW - 2_000,
    lastSettledScanAt: NOW - 1_300,
    promptBoxIdle: true,
    turnIdle: true,
    turnIdleAt: NOW - 1_300,
  });
  assert.equal(
    cardActor({ card: card(), live: ended, sentAt: NOW - MIN, submittedAt: NOW - MIN, now: NOW })?.words,
    "Claude · your turn",
  );
  const lane = { ...ended, ptyId: "pb", vendor: "codex" as const };
  assert.equal(
    laneActor({ card: bothCard, lane: "b", live: lane, sentAt: NOW - MIN, submittedAt: NOW - MIN, now: NOW }).words,
    "Codex · your turn",
  );
  // Output after that scan (which clears it), no key: the session's own
  // work again.
  const after = { ...lane, lastOutputAt: NOW - 200, lastSettledScanAt: undefined };
  assert.match(
    laneActor({ card: bothCard, lane: "b", live: after, sentAt: NOW - MIN, submittedAt: NOW - MIN, now: NOW }).words,
    /^Codex · working/,
  );
});

// SP-4 round 3 (Challenger F1): Codex streams an answer with its composer
// in view; a max-wait scan mid-stream finds it "idle" and turns turnIdle on
// after the submit. That scan is not settled, so nothing trusts it: building.
test("a mid-stream scan that looks idle never reads waiting for you", () => {
  const T = NOW - 10_000;
  const midStream = live({
    ptyId: "pb",
    vendor: "codex",
    lastOutputAt: T + 1_000,
    promptBoxIdle: true,
    turnIdle: true,
    turnIdleAt: T + 1_500,
  });
  const at = T + 1_600;
  assert.match(
    laneActor({ card: bothCard, lane: "b", live: midStream, sentAt: T, submittedAt: T, now: at }).words,
    /^Codex · working/,
  );
  assert.match(cardActor({ card: card({ vendor: "codex" }), live: { ...midStream, ptyId: "p1" }, sentAt: T, submittedAt: T, now: at })?.words ?? "", /^Codex · working/);
  // The turn ends: the output goes quiet and a settled scan finds it over —
  // waiting for you at once, inside the silence window.
  const settled = { ...midStream, lastOutputAt: T + 2_000, turnIdleAt: T + 1_500, lastSettledScanAt: T + 2_750 };
  assert.equal(
    laneActor({ card: bothCard, lane: "b", live: settled, sentAt: T, submittedAt: T, now: T + 2_800 }).words,
    "Codex · your turn",
  );
});

// Round 2 (F2): a finished build sent new work and working on it.
test("a finished build working again on new work reads building", () => {
  const doneAt = NOW - 10 * MIN;
  const finished: BuildBoth = {
    ...both,
    lanes: [{ ...both.lanes[0], done: { sha: "s", at: doneAt }, verify: { status: "passed", sha: "s", summary: "ok", at: doneAt } }, both.lanes[1]],
  };
  const c = { worktreeSetup: null, buildBoth: finished };
  const a = live({ ptyId: "pa", lastOutputAt: NOW - 500 });
  // Nothing sent since its Build done: the stage's words.
  assert.equal(laneActor({ card: c, lane: "a", live: a, sentAt: doneAt - MIN, now: NOW }).words, "Claude · done · checks passed");
  // Sent after it, and working: building, the clock from the submit.
  assert.equal(
    laneActor({ card: c, lane: "a", live: a, sentAt: NOW - 2 * MIN, submittedAt: NOW - 2 * MIN, now: NOW }).words,
    "Claude · working · 2m",
  );
  // Sent after it but at its prompt again: the stage's words.
  const idle = live({ ptyId: "pa", lastOutputAt: NOW - MIN, promptBoxIdle: true, turnIdle: true, turnIdleAt: NOW - MIN });
  assert.equal(laneActor({ card: c, lane: "a", live: idle, sentAt: NOW - 2 * MIN, now: NOW }).words, "Claude · done · checks passed");
});

// CL-11 (Windows walk b): the Now callout's title said "Claude · waiting
// for you" (the person typing at its prompt, its turn over) while the line
// under it said "Claude is working" from the raw attention. The line now
// follows the title's state.
test("the line under the title agrees with it", () => {
  const typing = live({ lastOutputAt: NOW - 200, promptBoxIdle: true, turnIdle: true, turnIdleAt: NOW - 30_000 });
  const actor = cardActor({ card: card(), live: typing, sentAt: NOW - 200, now: NOW });
  assert.equal(actor?.words, "Claude · your turn");
  const line = (session: Parameters<typeof sessionSummary>[0]["actor"]) =>
    sessionSummary({ vendor: "claude", attention: "working", turnIdle: true, startedAt: NOW - 5 * MIN, lastOutputAt: NOW - 200, filesChanged: null, actor: session, now: NOW });
  assert.equal(line(actor?.session), "Claude says it's done. Started 5m ago.");
  // Without the title's state it would have said working — the bug.
  assert.match(line(undefined), /^Claude is working in the card's copy\./);
  const busy = live({ lastOutputAt: NOW - 1_000, promptBoxIdle: false });
  assert.match(line(cardActor({ card: card(), live: busy, submittedAt: NOW - MIN, now: NOW })?.session), /^Claude is working in the card's copy\./);
  const c = card({ snapshots: [{ at: NOW - MIN } as never] }, { lastRunStatus: "success" });
  const done = cardActor({ card: c, live: live({ promptBoxIdle: true, turnIdle: true, turnIdleAt: NOW - MIN, lastOutputAt: NOW - MIN }), now: NOW });
  assert.equal(done?.words, "Claude · your turn");
  assert.equal(line(done?.session), "Claude says it's done, and its work is saved. Started 5m ago.");
});

// CL-11 (walk): a Codex self-check waited six minutes on an approval in its
// terminal while the card said it was checking its own work. An approval in
// view is "waiting for you" on the card and in Needs you, at once.
test("an approval in view waits for you, on the card and in Needs you", () => {
  const asking = live({ vendor: "codex", lastOutputAt: NOW - 500, promptBoxIdle: true, questionInView: true });
  const c = card({ vendor: "codex" });
  const actor = cardActor({ card: c, live: asking, sentAt: NOW - MIN, submittedAt: NOW - MIN, now: NOW });
  assert.equal(actor?.words, "Codex · asks you something");
  assert.equal(actor?.dot, "aborted");
  assert.equal(actor?.session, "question");
  const waiting = waitingSessions({
    tilesByWorkspace: {},
    builders: { c1: { workspaceId: "ws", ptyId: "p1", vendor: "codex", startedAt: NOW - 10 * MIN, lastOutputAt: NOW - 500, promptBoxIdle: true, questionInView: true } },
    cardTitle: () => "Round half up",
    now: NOW,
  });
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].where, "Round half up");
  // The same screen without the approval, output just now: working.
  const busy = waitingSessions({
    tilesByWorkspace: {},
    builders: { c1: { workspaceId: "ws", ptyId: "p1", vendor: "codex", startedAt: NOW - 10 * MIN, lastOutputAt: NOW - 500, promptBoxIdle: true } },
    cardTitle: () => "Round half up",
    now: NOW,
  });
  assert.equal(busy.length, 0);
});

test("a state word without the vendor", () => {
  assert.equal(actorStateWords({ words: "Claude · your turn", spoken: "", dot: "done" }), "Your turn");
  assert.equal(actorStateWords({ words: "Codex · working · 4m", spoken: "", dot: "running" }), "Working · 4m");
  assert.equal(actorStateWords({ words: "Running checks", spoken: "", dot: "running" }), "Running checks");
});

// SP-1 walk (sidebar "Claude · working" with Claude at its prompt): a
// second after its turn ends Claude Code draws a dim prompt suggestion into
// its input box. Nobody typed it, and it is output after the settled scan
// that found the turn over. Claude's screen as the walk showed it:
const CLAUDE_SUGGESTION_SCREEN = [
  "● I added the comment above calcSign and committed it as 3e2eaf9:",
  "",
  "  All 4 tests still pass. This commit came after the snapshot the Reviewer",
  "  approved (1b215092), so you may need to run Build done again before you press",
  "  Ship.",
  "",
  "✻ Brewed for 7s · done 10:01 PM",
  "",
  "────────────────────────────────────────────────────────────────────────────────",
  "❯ Show me the final diff",
  "────────────────────────────────────────────────────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
].join("\n");

test("Claude's prompt suggestion, drawn after its turn ended, is not building", () => {
  // The scans read the suggestion's screen as the turn over at its prompt.
  assert.equal(matchesClaudePromptIdle(CLAUDE_SUGGESTION_SCREEN), true);
  assert.equal(matchesClaudeTurnIdle(CLAUDE_SUGGESTION_SCREEN), true);
  const T = NOW - 5_000;
  // The turn ended at T (its last lines); a settled scan at T + 750 found
  // it over; the person's message went in a minute before.
  const ended = live({ lastOutputAt: T, lastSettledScanAt: T + 750, promptBoxIdle: true, turnIdle: true, turnIdleAt: T + 750, turnIdleSettled: true });
  assert.equal(
    cardActor({ card: card(), live: ended, sentAt: T - MIN, submittedAt: T - MIN, now: T + 1_000 })?.words,
    "Claude · your turn",
  );
  // T + 2 s: the suggestion is drawn — output, which clears the settled
  // scan; no key went in. Before the next settled scan, still waiting.
  const suggested = { ...ended, lastOutputAt: T + 2_000, lastSettledScanAt: undefined };
  const words = cardActor({ card: card(), live: suggested, sentAt: T - MIN, submittedAt: T - MIN, now: T + 2_100 });
  assert.equal(words?.words, "Claude · your turn");
  assert.equal(words?.session, "stopped");
  // So does the sidebar's row of a build of a card built by both.
  assert.equal(
    laneActor({ card: bothCard, lane: "a", live: { ...suggested, ptyId: "pa" }, sentAt: T - MIN, submittedAt: T - MIN, now: T + 2_100 }).words,
    "Claude · your turn",
  );
  // An Enter after the scan (the person sent the suggestion): building.
  assert.match(
    cardActor({ card: card(), live: suggested, sentAt: T + 2_050, submittedAt: T + 2_050, now: T + 2_100 })?.words ?? "",
    /^Claude · working/,
  );
  // The next scan finds a turn running (its spinner): building.
  assert.match(
    cardActor({ card: card(), live: { ...suggested, turnIdle: false }, sentAt: T - MIN, submittedAt: T - MIN, now: T + 2_100 })?.words ?? "",
    /^Claude · working/,
  );
  // Challenger: only a SETTLED scan counts. Mid-stream, a max-wait scan
  // read a half-redrawn frame as the turn over (turnIdle true, not
  // settled); the output goes on — building, never "waiting for you".
  const halfFrame = live({ lastOutputAt: T + 2_000, promptBoxIdle: true, turnIdle: true, turnIdleAt: T + 1_500, turnIdleSettled: false });
  assert.match(
    cardActor({ card: card(), live: halfFrame, sentAt: T - MIN, submittedAt: T - MIN, now: T + 2_100 })?.words ?? "",
    /^Claude · working/,
  );
  assert.match(
    laneActor({ card: bothCard, lane: "a", live: { ...halfFrame, ptyId: "pa" }, sentAt: T - MIN, submittedAt: T - MIN, now: T + 2_100 }).words,
    /^Claude · working/,
  );
  // SP-4 kept: Codex's output after the scan, no key sent, is its own
  // work — it streams with its composer in view.
  assert.match(
    laneActor({ card: bothCard, lane: "b", live: { ...suggested, ptyId: "pb", vendor: "codex" }, sentAt: T - MIN, submittedAt: T - MIN, now: T + 2_100 }).words,
    /^Codex · working/,
  );
});

console.log(`sessionActor: ${passed}/${passed} passed`);
