// 1.177.0 Compare: the relay bar's view model and words. Run with:
//
//     node --experimental-strip-types src/lib/compareView.test.ts
import assert from "node:assert/strict";
import {
  bar,
  clockWords,
  defaultAsk,
  deliveryGate,
  directionOnOffer,
  lastAskInto,
  plannedSincePass,
  pasteParts,
  resolvePair,
  sentOver,
  type BarInput,
  type Pass,
  type TileFacts,
} from "./compareView.ts";
import type { CompareAnswer } from "./compareIpc.ts";
import * as W from "./compareWords.ts";
import { readinessProbe } from "./tileHeaderStatus.ts";
import { choiceMenuInView, matchesClaudePromptIdle, promptInputEmpty, settledTail } from "./attention.ts";
import { liveWorking } from "./tileScreen.ts";
import { STALE_OPEN_QUIET_MS, answerToPass, heldIsProvisional, heldOffered, nextHeld, openTurnStale, passDropped, type ReturnHeld } from "./compareView.ts";

const NOW = 10_000_000;
const tile = (id: string, vendor: "claude" | "codex", over: Partial<TileFacts> = {}): TileFacts => ({
  id,
  vendor,
  label: `${vendor} ${id}`,
  live: true,
  ended: false,
  question: false,
  draft: false,
  promptIdle: true,
  working: false,
  readyBox: true,
  boxDrawn: true,
  ...over,
});
const ans = (vendor: "claude" | "codex", over: Partial<CompareAnswer> = {}): CompareAnswer => ({
  vendor,
  conversation: "known",
  turn: "done",
  answer: "text",
  answerKind: "text",
  finishedAtMs: NOW - 60_000,
  chars: 4,
  cut: false,
  ...over,
});
const fresh = (vendor: "claude" | "codex"): CompareAnswer => ({ vendor, conversation: "none", turn: "none", cut: false });
const input = (over: Partial<BarInput> = {}): BarInput => ({
  tiles: [tile("c1", "claude"), tile("x1", "codex")],
  claudeId: null,
  codexId: null,
  closed: null,
  answers: {},
  history: [],
  flipped: false,
  sent: null,
  now: NOW,
  ...over,
});
const pass = (n: number, from: "claude" | "codex", to: "claude" | "codex", ask: W.CompareAsk): Pass => ({
  n,
  from,
  to,
  ask,
  withNote: false,
  at: NOW,
  mode: "send",
  sent: "x",
  answer: "a",
  cut: false,
});

// 1. No pair possible.
assert.equal(bar(input({ tiles: [tile("c1", "claude")] })).line, "Open a Claude Code tile and a Codex tile to compare them.");
assert.equal(bar(input({ tiles: [] })).kind, "no-pair");
assert.equal(bar(input({ tiles: [tile("x1", "codex")] })).button, null);

// 2. Pairing: one of each pairs by itself, no menu.
let v = bar(input());
assert.equal(v.pickers.length, 0);
assert.equal(v.kind, "nothing");
assert.equal(v.line, "Nothing to pass yet. When Claude or Codex finishes an answer, you can pass it to the other.");
//    two candidates of a kind: a menu for that kind, until chosen.
const two = [tile("c1", "claude"), tile("c2", "claude"), tile("x1", "codex")];
v = bar(input({ tiles: two }));
assert.equal(v.kind, "choose");
assert.deepEqual(v.pickers.map((p) => p.vendor), ["claude"]);
assert.equal(v.pickers[0].selectedId, null);
v = bar(input({ tiles: two, claudeId: "c2" }));
assert.equal(v.kind, "nothing");
assert.equal(v.pickers[0].selectedId, "c2"); // changeable from the same menu
//    a choice that closed is gone: words, the pair undone.
v = bar(input({ tiles: [tile("x1", "codex")], closed: "claude" }));
assert.equal(v.line, "Claude's tile is closed.");
v = bar(input({ tiles: [tile("c1", "claude")], closed: "codex" }));
assert.equal(v.line, "Codex's tile is closed.");
assert.equal(resolvePair(two, "gone", null).claude, null);

// 4. Rest, answer ready.
v = bar(input({ answers: { claude: ans("claude"), codex: fresh("codex") } }));
assert.equal(v.kind, "ready");
assert.equal(v.line, "Claude answered 1 min ago");
assert.equal(v.button?.label, "Pass to Codex →");
assert.equal(v.button?.disabled, false);
assert.equal(v.count, "Nothing passed yet");
assert.equal(v.canSwap, false);
//    source working again.
v = bar(input({ tiles: [tile("c1", "claude", { working: true }), tile("x1", "codex")], answers: { claude: ans("claude", { turn: "open" }), codex: fresh("codex") } }));
assert.equal(v.line, "Claude is working. This is its last finished answer.");
assert.equal(v.button?.disabled, false);
//    Claude on its plan menu: the plan is offered and it is not "working".
v = bar(
  input({
    tiles: [tile("c1", "claude", { question: true }), tile("x1", "codex")],
    answers: { claude: ans("claude", { turn: "open", answerKind: "plan", planPending: true }), codex: fresh("codex") },
  }),
);
assert.equal(v.line, "Claude answered 1 min ago");
assert.equal(v.button?.disabled, false);

// Counts.
assert.equal(W.passCountWords(0), "Nothing passed yet");
assert.equal(W.passCountWords(1), "1 pass");
assert.equal(W.passCountWords(3), "3 passes");
v = bar(input({ answers: { claude: ans("claude") }, history: [pass(2, "codex", "claude", "answer-review"), pass(1, "claude", "codex", "review-plan")] }));
assert.equal(v.count, "2 passes");

// Direction: the newest finishedAtMs; the member can flip.
const both = { claude: ans("claude", { finishedAtMs: 100 }), codex: ans("codex", { finishedAtMs: 200 }) };
assert.deepEqual(directionOnOffer(both, false), { from: "codex", to: "claude", both: true });
assert.deepEqual(directionOnOffer(both, true), { from: "claude", to: "codex", both: true });
assert.deepEqual(directionOnOffer({ claude: ans("claude") }, true), { from: "claude", to: "codex", both: false });
assert.equal(directionOnOffer({ claude: ans("claude", { answer: undefined }) }, false), null);
v = bar(input({ answers: both }));
assert.equal(v.from, "codex");
assert.equal(v.button?.label, "Pass to Claude →");
assert.equal(v.canSwap, true);
v = bar(input({ answers: both, flipped: true }));
assert.equal(v.button?.label, "Pass to Codex →");

// 6. After Send / Put, until the target answers.
const sentAt = NOW - 1000;
v = bar(input({ answers: { claude: ans("claude", { finishedAtMs: sentAt - 5 }) }, sent: { to: "codex", at: sentAt, mode: "send" } }));
assert.equal(v.kind, "sent");
assert.equal(v.line, "Passed to Codex. It's working on it.");
assert.equal(v.button?.label, "Pass to Claude →");
assert.equal(v.button?.disabled, true);
v = bar(input({ answers: { claude: ans("claude") }, sent: { to: "codex", at: sentAt, mode: "put" } }));
assert.equal(v.line, "It's in Codex's box. Press Enter there to send it.");
//    the target answered since: state 4 in the other direction.
v = bar(
  input({
    answers: { claude: ans("claude", { finishedAtMs: sentAt - 5 }), codex: ans("codex", { finishedAtMs: sentAt + 500 }) },
    sent: { to: "codex", at: sentAt, mode: "send" },
  }),
);
assert.equal(v.kind, "ready");
assert.equal(v.from, "codex");

// 7. Blocked: each reason, in order, with "Show it" on the target.
const claudeAnswers = { claude: ans("claude"), codex: ans("codex", { finishedAtMs: 1 }) };
const blocked = (xover: Partial<TileFacts>, ans2: Partial<CompareAnswer> = {}) =>
  bar(input({ tiles: [tile("c1", "claude"), tile("x1", "codex", xover)], answers: { claude: ans("claude"), codex: ans("codex", { finishedAtMs: 1, ...ans2 }) } }));
v = blocked({ question: true });
assert.equal(v.kind, "blocked");
assert.equal(v.note, "Codex is asking you something. Answer it in its tile first.");
assert.equal(v.showIt, "x1");
assert.equal(v.button?.disabled, true);
assert.equal(v.button?.reason, v.note);
assert.equal(blocked({ working: true }).note, "Codex is working. You can pass this when it's done.");
assert.equal(blocked({ draft: true }).note, "Codex's box has text you typed. Send it or clear it first.");
assert.equal(blocked({ promptIdle: null }).note, "Can't tell if Codex is ready. Click its tile and try again.");
assert.equal(blocked({ promptIdle: false }).note, "Can't tell if Codex is ready. Click its tile and try again.");
assert.equal(blocked({ working: null }, { turn: "open" }).note, "Codex is working. You can pass this when it's done.", "an open rollout turn is work");
// Review round 1 (H1): an open rollout turn refuses a Put into Codex too,
// however idle its screen reads; Claude's open turn is the screen's to judge.
assert.equal(blocked({}, { turn: "open" }).note, "Codex is working. You can pass this when it's done.");
assert.equal(deliveryGate("codex", tile("x1", "codex"), ans("codex", { turn: "open" }), "put"), "Codex is working. You can pass this when it's done.");
assert.equal(deliveryGate("codex", tile("x1", "codex"), ans("codex", { turn: "open", conversation: "ambiguous" }), "put"), null, "an ambiguous Codex: the screen guards decide");
assert.equal(deliveryGate("claude", tile("c1", "claude", { turnOverOnScreen: true }), ans("claude", { turn: "open" }), "put"), null, "Claude's orphan open turn (Esc), proven over on screen: Put");
// Review round 6 (M1): an open Claude turn the screen doesn't prove over refuses a Put too.
assert.equal(deliveryGate("claude", tile("c1", "claude"), ans("claude", { turn: "open" }), "put"), "Claude is working. You can pass this when it's done.");
assert.equal(blocked({ working: null }, { conversation: "unstarted", turn: "none" }).note, "Can't tell if Codex is ready. Click its tile and try again.");
assert.equal(blocked({ working: null }).note, null, "unknown working passes only for a known conversation whose turn is not open");
assert.equal(blocked({ draft: null }).note, "Can't tell if Codex is ready. Click its tile and try again.");
assert.equal(blocked({ question: null }).note, "Can't tell if Codex is ready. Click its tile and try again.");
assert.equal(blocked({ live: false }).note, "Can't tell if Codex is ready. Click its tile and try again.");
assert.equal(blocked({ live: false, ended: true }).note, "Codex's session has ended. Open it again first.");
assert.equal(blocked({ overlay: true }).note, W.COMPARE_CODEX_SEARCH_OPEN);
assert.equal(blocked({}).note, null);
// Passing into a fresh, unclaimed Codex tile is a valid first move.
v = bar(input({ answers: { claude: ans("claude"), codex: ans("codex", { conversation: "ambiguous", turn: "none", answer: undefined, finishedAtMs: undefined }) } }));
assert.equal(v.kind, "ready");
assert.equal(v.button?.disabled, false);
// 1.177.0 contract: an ambiguous source with no answer says so (the
// owner-approved sentence); an unstarted tile has plainly nothing yet.
v = bar(input({ answers: { codex: ans("codex", { conversation: "ambiguous", turn: "none", answer: undefined }) } }));
assert.equal(v.line, "Can't tell which conversation Codex's tile is in. Close it and open a new Codex tile to compare.");
v = bar(input({ answers: { claude: ans("claude", { conversation: "ambiguous", turn: "none", answer: undefined }) } }));
assert.equal(v.line, "Can't tell which conversation this Claude tile is in. Send it one message first.");
v = bar(input({ answers: { codex: ans("codex", { conversation: "unstarted", turn: "none", answer: undefined }) } }));
assert.equal(v.line, W.COMPARE_NOTHING_YET);
// 1.179.0: Claude's newest plan can't be read back: nothing offered, and why.
v = bar(input({ answers: { claude: ans("claude", { answer: undefined, answerKind: undefined, planUnread: true }), codex: fresh("codex") } }));
assert.equal(v.kind, "nothing");
assert.equal(v.line, "Can't read Claude's newest plan. Ask Claude to show it again, then pass.");
assert.equal(W.PLAN_UNREAD_WORDS, v.line);
// A blank answer is no answer.
v = bar(input({ answers: { claude: ans("claude", { answer: "  \n " }), codex: fresh("codex") } }));
assert.equal(v.kind, "nothing");
// An unstarted Codex tile is a valid target; an ambiguous one takes a Put, not a Send.
const claudeSays = ans("claude");
v = bar(input({ answers: { claude: claudeSays, codex: ans("codex", { conversation: "unstarted", turn: "none", answer: undefined }) } }));
assert.equal(v.kind, "ready");
assert.equal(deliveryGate("codex", tile("x1", "codex"), ans("codex", { conversation: "ambiguous", turn: "none", answer: undefined }), "put"), null);
assert.equal(
  deliveryGate("codex", tile("x1", "codex"), ans("codex", { conversation: "ambiguous", turn: "none", answer: undefined }), "send"),
  "Can't tell which conversation Codex's tile is in. Close it and open a new Codex tile to compare.",
);
// The source's last turn ended without an answer: the one before it is offered, said so.
v = bar(input({ answers: { claude: ans("claude", { fromEarlierTurn: true }), codex: fresh("codex") } }));
assert.equal(v.line, "Claude's last turn ended without an answer. This is the one before it.");
assert.equal(v.kind, "ready");

// The "sent" state has a way out (S2): the target answers, or its box is
// seen idle and empty again after a while, or it ended; never a dead button.
const sentPut = { to: "codex" as const, at: NOW - 100, mode: "put" as const };
v = bar(input({ answers: { claude: ans("claude"), codex: fresh("codex") }, sent: sentPut }));
assert.equal(v.kind, "sent");
assert.equal(v.button?.disabled, true);
assert.equal(v.button?.reason, "It's in Codex's box. Press Enter there to send it."); // a reason is always shown
v = bar(input({ answers: { claude: ans("claude"), codex: fresh("codex") }, sent: { ...sentPut, at: NOW - 2000 } }));
assert.equal(v.kind, "ready", "a Put whose box is empty and idle again ends");
v = bar(input({ tiles: [tile("c1", "claude"), tile("x1", "codex", { draft: true })], answers: { claude: ans("claude"), codex: fresh("codex") }, sent: { ...sentPut, at: NOW - 20000 } }));
assert.equal(v.kind, "sent", "text still in the box keeps it");
v = bar(input({ answers: { claude: ans("claude"), codex: fresh("codex") }, sent: { to: "codex", at: NOW - 3000, mode: "send" } }));
assert.equal(v.kind, "sent", "a Send gets longer to start working");
v = bar(input({ answers: { claude: ans("claude"), codex: fresh("codex") }, sent: { to: "codex", at: NOW - 9000, mode: "send" } }));
assert.equal(v.kind, "ready");
v = bar(input({ tiles: [tile("c1", "claude"), tile("x1", "codex", { ended: true, live: false })], answers: { claude: ans("claude"), codex: fresh("codex") }, sent: sentPut }));
assert.equal(v.kind, "blocked");
// An unread target (no answer yet) is unknown, never a pass.
v = bar(input({ answers: { claude: ans("claude") } }));
assert.equal(v.button?.disabled, true); // codex not read yet
assert.equal(v.button?.reason, "Can't tell if Codex is ready. Click its tile and try again.");
void claudeAnswers;

// The gate: Send needs a known open turn to be closed; for Codex Put does too
// (round 1 H1), for Claude the screen decides a Put.
const x = tile("x1", "codex");
assert.equal(deliveryGate("codex", x, ans("codex", { turn: "open" }), "send"), "Codex is working. You can pass this when it's done.");
assert.equal(deliveryGate("codex", x, ans("codex", { turn: "open" }), "put"), "Codex is working. You can pass this when it's done.");
assert.equal(deliveryGate("codex", x, ans("codex", { turn: "none", conversation: "unstarted" }), "send"), null);
assert.equal(deliveryGate("codex", x, ans("codex", { conversation: "ambiguous", turn: "open" }), "send"), "Can't tell which conversation Codex's tile is in. Close it and open a new Codex tile to compare.");
assert.equal(deliveryGate("codex", x, ans("codex", { conversation: "ambiguous", turn: "open" }), "put"), null);
assert.equal(deliveryGate("codex", x, undefined, "put"), "Can't tell if Codex is ready. Click its tile and try again.");

// Default ask, the planning flow: a text answer is the work to check only
// when a plan was seen from that tile after the last pass into it.
{
  const p1 = pass(1, "claude", "codex", "review-plan"); // at NOW: a pass FROM claude
  const intoClaude = (n: number, ask: W.CompareAsk, at: number): Pass => ({ ...pass(n, "codex", "claude", ask), at });
  // plan seen -> text, no pass between: Check this work.
  assert.equal(defaultAsk("text", null, plannedSincePass([], "claude", 100)), "check-work");
  assert.equal(defaultAsk("text", null, plannedSincePass([p1], "claude", 100)), "check-work", "a pass FROM it doesn't count");
  // review passed into Claude, Claude answers in text, no new plan since: Answer... the approved row.
  const h1 = [intoClaude(2, "review-plan", 500)];
  assert.equal(plannedSincePass(h1, "claude", 100), false);
  assert.equal(defaultAsk("text", "review-plan", plannedSincePass(h1, "claude", 100)), "answer-review");
  // review passed into Claude, a new plan seen since, approved, text: Check this work.
  assert.equal(plannedSincePass(h1, "claude", 600), true);
  assert.equal(defaultAsk("text", "review-plan", plannedSincePass(h1, "claude", 600)), "check-work");
  // A new plan is always reviewed.
  assert.equal(defaultAsk("plan", "answer-review", true), "review-plan");
  // No plan seen: the approved rows as before.
  assert.equal(plannedSincePass([], "claude", undefined), false);
  assert.equal(defaultAsk("text", null, false), "just-pass");
}
// Default ask.
assert.equal(defaultAsk("plan", null), "review-plan");
assert.equal(defaultAsk("plan", "carry-out"), "review-plan");
assert.equal(defaultAsk("text", "review-plan"), "answer-review");
assert.equal(defaultAsk("text", "carry-out"), "check-work");
assert.equal(defaultAsk("text", "answer-review"), "review-plan");
assert.equal(defaultAsk("text", "check-work"), "just-pass");
assert.equal(defaultAsk(undefined, null), "just-pass");
assert.equal(lastAskInto([pass(2, "claude", "codex", "carry-out"), pass(1, "codex", "claude", "check-work")], "claude"), "check-work");
assert.equal(lastAskInto([], "claude"), null);

// What goes to the backend: parts only, never an assembled string.
assert.deepEqual(pasteParts("claude", "review-plan", "A", "  my note "), {
  lead: "Review this plan. Say what is missing or wrong before any code is written.",
  fromLabel: "From Claude Code:",
  answer: "A",
  note: "my note",
  noteLabel: "My note:",
});
assert.equal(pasteParts("codex", "just-pass", "A", "   ").note, undefined);
assert.equal(pasteParts("codex", "just-pass", "A", "").lead, undefined);
assert.equal(pasteParts("codex", "just-pass", "A", "").fromLabel, "From Codex:");
assert.equal(pasteParts("claude", "carry-out", "A", "").lead, "Carry out this plan.");
assert.equal(pasteParts("claude", "check-work", "A", "").lead, "Check this work against what was asked. Say what is wrong or missing.");
assert.equal(
  pasteParts("claude", "answer-review", "A", "").lead,
  "This is a review of your last answer. Answer it, and change your plan where the review is right.",
);
assert.equal(pasteParts("claude", "just-pass", "A", "x".repeat(5000)).note?.length, 4000);

// Words.
assert.equal(W.composerTitleWords("claude", "codex", "plan"), "Claude's plan to Codex");
assert.equal(W.composerTitleWords("codex", "claude", "text"), "Codex's answer to Claude");
assert.equal(W.charsWords(1240), "1,240 characters");
assert.equal(W.askHeading("codex"), "Ask Codex to");
assert.equal(W.sendWords("claude"), "Send to Claude");
assert.deepEqual([...W.COMPARE_ASKS].map((a) => W.COMPARE_ASK_LABEL[a]), [
  "Review this plan",
  "Carry it out",
  "Check this work",
  "Answer this review",
  "Just pass it",
]);
assert.equal(W.notReachedWords("codex"), "That didn't reach Codex. Nothing was sent.");
assert.match(clockWords(0), /^\d\d:\d\d$/);

// W1: a plan on its approval menu (turn open) is offered with Review this plan.
{
  const planAns = ans("claude", { turn: "open", answerKind: "plan", planPending: true });
  const view = bar(input({ tiles: [tile("c1", "claude", { question: true, promptIdle: true }), tile("x1", "codex")], answers: { claude: planAns, codex: fresh("codex") } }));
  assert.equal(view.kind, "ready");
  assert.equal(view.button?.label, "Pass to Codex →");
  assert.equal(defaultAsk(planAns.answerKind, null), "review-plan");
  assert.equal(W.composerTitleWords("claude", "codex", planAns.answerKind), "Claude's plan to Codex");
}
// W3: the sent state ends once the target is seen not working — a question
// (a refused command leaves it waiting) or an idle box — after the floor.
{
  const base = { answers: { claude: ans("claude"), codex: fresh("codex") } };
  const sentSend = { to: "codex" as const, at: NOW - 9000, mode: "send" as const };
  const asks = bar(input({ ...base, tiles: [tile("c1", "claude"), tile("x1", "codex", { question: true })], sent: sentSend }));
  assert.equal(asks.kind, "blocked", "it asks: the pass state is over, the reason shows");
  const early = bar(input({ ...base, tiles: [tile("c1", "claude"), tile("x1", "codex", { question: true })], sent: { ...sentSend, at: NOW - 2000 } }));
  assert.equal(early.kind, "sent", "the floor covers the start");
  const working = bar(input({ ...base, tiles: [tile("c1", "claude"), tile("x1", "codex", { working: true })], sent: sentSend }));
  assert.equal(working.kind, "sent");
}
// R2-8: Send needs a conversation Plyloft can place.
assert.equal(deliveryGate("codex", tile("x1", "codex"), ans("codex", { conversation: "none", turn: "none" }), "send"), "Can't tell if Codex is ready. Click its tile and try again.");
assert.equal(deliveryGate("codex", tile("x1", "codex"), ans("codex", { conversation: "none", turn: "none" }), "put"), null);
assert.equal(deliveryGate("codex", tile("x1", "codex"), ans("codex", { conversation: "unstarted", turn: "none" }), "send"), null);
// R2-1: a target still printing after a pass keeps the "sent" state.
{
  const base = { answers: { claude: ans("claude"), codex: fresh("codex") } };
  const v2 = bar(input({ ...base, sent: { to: "codex", at: NOW - 3000, mode: "put" }, sentOutputActive: true }));
  assert.equal(v2.kind, "sent");
  const v3 = bar(input({ ...base, sent: { to: "codex", at: NOW - 3000, mode: "put" }, sentOutputActive: false }));
  assert.equal(v3.kind, "ready");
}
// R3-2: a finish time more than 60 s ahead of the clock is unknown: no "ago",
// and it never wins the direction on time.
{
  const future = ans("codex", { finishedAtMs: NOW + 10 * 60_000 });
  const real = ans("claude", { finishedAtMs: NOW - 60_000 });
  assert.equal(directionOnOffer({ claude: real, codex: future }, false, NOW)?.from, "claude");
  const v4 = bar(input({ answers: { codex: future, claude: fresh("claude") } }));
  assert.equal(v4.line, "Codex answered earlier");
  const near = ans("claude", { finishedAtMs: NOW + 30_000 });
  assert.equal(bar(input({ answers: { claude: near, codex: fresh("codex") } })).line, "Claude answered just now");
}
// X1: Claude's empty box in plan mode, after Esc at the plan menu — the line
// that started the turn is off the page, so the probe's `idle` is null: the box is
// drawn and idle and nothing runs, so it is not working (and so ready).
{
  const rows = [
    "╭──────────────────────────────────────────────────╮",
    "│ Ready to code?                                    │",
    "│  1. Parse the file                                │",
    "╰──────────────────────────────────────────────────╯",
    "",
    "────────────────────────────────────────────────────",
    "❯ ",
    "────────────────────────────────────────────────────",
    "  ⏸ plan mode on (shift+tab to cycle)",
    "                         ✔ Update installed · /restart to apply",
  ];
  const probe = readinessProbe("claude", rows);
  assert.equal(probe.idle, null);
  assert.equal(liveWorking(probe), null, "unknown on its own: the backend's known, not-open turn settles it");
  assert.equal(liveWorking({ running: true, idle: null }), true);
  assert.equal(liveWorking({ running: false, idle: false }), true);
  const tail = settledTail(rows, 20).join("\n");
  assert.equal(matchesClaudePromptIdle(tail), true);
  assert.equal(choiceMenuInView("claude", tail), false);
  assert.equal(promptInputEmpty("claude", tail), true);
}
// X3: Claude as the target on its plan menu.
{
  const planOpen = ans("claude", { turn: "open", answerKind: "plan", planPending: true });
  assert.equal(
    deliveryGate("claude", tile("c1", "claude", { question: true }), planOpen, "put"),
    "Claude is waiting for your answer to its plan. To send it this instead, press Esc in its tile, then pass.",
  );
  assert.equal(deliveryGate("claude", tile("c1", "claude", { question: true }), ans("claude"), "put"), "Claude is asking you something. Answer it in its tile first.");
  assert.equal(deliveryGate("codex", tile("x1", "codex", { question: true }), ans("codex", { turn: "open", answerKind: "plan" }), "put"), "Codex is asking you something. Answer it in its tile first.");
  // After Esc: the plan is a finished one (`done`), the empty box is a target.
  assert.equal(deliveryGate("claude", tile("c1", "claude", { working: null }), ans("claude", { turn: "done", answerKind: "plan" }), "send"), null);
  assert.equal(deliveryGate("claude", tile("c1", "claude", { working: null }), ans("claude", { turn: "done", answerKind: "plan" }), "put"), null);
}
// X4: an ambiguous conversation on either side is said quietly.
{
  const v5 = bar(input({ answers: { claude: ans("claude"), codex: ans("codex", { conversation: "ambiguous", turn: "none", answer: undefined }) } }));
  assert.equal(v5.muted, "Can't tell which conversation Codex's tile is in. Close it and open a new Codex tile to compare.");
  const v6 = bar(input({ answers: { codex: ans("codex"), claude: ans("claude", { conversation: "ambiguous", turn: "none", answer: undefined }) } }));
  assert.equal(v6.muted, "Can't tell which conversation Claude's tile is in.", "Claude's variant is as it was");
  assert.equal(bar(input({ answers: { claude: ans("claude"), codex: fresh("codex") } })).muted, null);
}
// L2: a Put whose target is now working (the member pressed Enter there) reads as passed.
{
  const sentPut = { to: "codex" as const, at: NOW - 100, mode: "put" as const };
  const idle = bar(input({ answers: { claude: ans("claude"), codex: fresh("codex") }, sent: sentPut }));
  assert.equal(idle.line, "It's in Codex's box. Press Enter there to send it.");
  const working = bar(input({ tiles: [tile("c1", "claude"), tile("x1", "codex", { working: true })], answers: { claude: ans("claude"), codex: fresh("codex") }, sent: sentPut }));
  assert.equal(working.kind, "sent");
  assert.equal(working.line, "Passed to Codex. It's working on it.");
  // R6-2: working over a box that still holds the text is not yet "passed".
  const typing = bar(input({ tiles: [tile("c1", "claude"), tile("x1", "codex", { working: true, draft: true })], answers: { claude: ans("claude"), codex: fresh("codex") }, sent: sentPut }));
  assert.equal(typing.line, "It's in Codex's box. Press Enter there to send it.");
}
// L3: Codex's words don't advise a message that can't help; Claude's stay.
assert.equal(W.conversationUnknownWords("codex"), "Can't tell which conversation Codex's tile is in. Close it and open a new Codex tile to compare.");
assert.equal(W.conversationUnknownWords("claude"), "Can't tell which conversation this Claude tile is in. Send it one message first.");
console.log("compareView ok");

// F4 (Windows walk 2026-11-25): Claude mid-turn on a permission menu, its
// approved plan of the same turn the last finished answer — it is working,
// not "answered 5 min ago". Only the plan that waits for its menu is not.
{
  const approved = ans("claude", { turn: "open", answerKind: "plan" });
  const onMenu = tile("c1", "claude", { question: true, quietMs: 60_000 });
  const v = bar(input({ tiles: [onMenu, tile("x1", "codex")], answers: { claude: approved, codex: fresh("codex") } }));
  assert.equal(v.line, "Claude is working. This is its last finished answer.");
  assert.equal(v.button?.disabled, false, "passing the last finished answer stays allowed");
  // A text answer with a permission menu up in an open turn: the same.
  const t = bar(input({ tiles: [onMenu, tile("x1", "codex")], answers: { claude: ans("claude", { turn: "open" }), codex: fresh("codex") } }));
  assert.equal(t.line, "Claude is working. This is its last finished answer.");
  // As a target, a permission menu over an approved plan asks, it isn't the plan menu.
  assert.equal(deliveryGate("claude", onMenu, approved, "put"), "Claude is asking you something. Answer it in its tile first.");
}

// F1 (Windows walk 2026-11-25, evidence/win-send-esc-tail.jsonl): Send, then
// Esc in Claude's tile before any output. Claude took the text back into its
// box; the transcript's last entry is the user prompt, so its turn reads open
// for ever. The screen decides what Claude does now.
{
  const orphan = ans("claude", { turn: "open", answer: "Noted: Codex says BLUE.", finishedAtMs: NOW - 70_000 });
  const still = (over: Partial<TileFacts> = {}) =>
    tile("c1", "claude", { working: false, question: false, promptIdle: true, quietMs: STALE_OPEN_QUIET_MS, turnOverOnScreen: true, ...over });
  // Source side: idle, still for 5 s: its last answer, not "working".
  let v = bar(input({ tiles: [still({ draft: true }), tile("x1", "codex")], answers: { claude: orphan, codex: fresh("codex") } }));
  assert.equal(v.line, "Claude answered 1 min ago", "the put-back text in the box is no turn");
  v = bar(input({ tiles: [still(), tile("x1", "codex")], answers: { claude: orphan, codex: fresh("codex") } }));
  assert.equal(v.line, "Claude answered 1 min ago", "box cleared");
  // Target side: Send is refused only for the text in its box; once cleared it goes.
  assert.equal(deliveryGate("claude", still({ draft: true }), orphan, "send"), "Claude's box has text you typed. Send it or clear it first.");
  assert.equal(deliveryGate("claude", still(), orphan, "send"), null, "case A/B: an idle, still Claude takes a Send");
  // Case B: a turn that ended on an error the transcript didn't close — the same rule.
  // A normal running turn still reads as working, whatever else holds:
  const running = tile("c1", "claude", { working: true, question: false, promptIdle: false, quietMs: 0 });
  v = bar(input({ tiles: [running, tile("x1", "codex")], answers: { claude: orphan, codex: fresh("codex") } }));
  assert.equal(v.line, "Claude is working. This is its last finished answer.");
  assert.equal(deliveryGate("claude", running, orphan, "send"), "Claude is working. You can pass this when it's done.");
  // 1.177.1 (item 4/16): the screen's proof alone takes the line out of
  // "working" at once; Send still waits for the screen to be still.
  for (const f of [still({ quietMs: STALE_OPEN_QUIET_MS - 1 }), still({ quietMs: null }), still({ quietMs: undefined })]) {
    assert.equal(openTurnStale(f), false, JSON.stringify(f));
    assert.equal(deliveryGate("claude", f, orphan, "send"), "Claude is working. You can pass this when it's done.", JSON.stringify(f));
    assert.equal(deliveryGate("claude", f, orphan, "put"), null, "Put needs no finished turn");
    const b = bar(input({ tiles: [f, tile("x1", "codex")], answers: { claude: orphan, codex: fresh("codex") } }));
    assert.equal(b.line, "Claude answered 1 min ago", JSON.stringify(f));
  }
  // 4/16: the turn's start off the page ("working" unknown) with the screen's
  // proof of its end: the proof decides.
  assert.equal(openTurnStale(still({ working: null })), true);
  assert.equal(deliveryGate("claude", still({ working: null }), orphan, "send"), null, "the turn's start scrolled off");
  // No proof, or something asks: the open turn stands.
  for (const f of [
    still({ question: null }),
    still({ question: true }),
    still({ turnOverOnScreen: false }),
    still({ turnOverOnScreen: null }),
    still({ turnOverOnScreen: undefined }),
    still({ turnOverOnScreen: false, working: null }),
  ]) {
    assert.equal(openTurnStale(f), false, JSON.stringify(f));
    assert.notEqual(deliveryGate("claude", f, orphan, "send"), null, `never sends: ${JSON.stringify(f)}`);
    const b = bar(input({ tiles: [f, tile("x1", "codex")], answers: { claude: orphan, codex: fresh("codex") } }));
    assert.equal(b.line, "Claude is working. This is its last finished answer.", JSON.stringify(f));
  }
  // No positive proof of the ready box: nothing is written, Put or Send (item 18).
  for (const readyBox of [false, null, undefined]) {
    for (const action of ["put", "send"] as const) {
      assert.equal(deliveryGate("claude", still({ readyBox }), orphan, action), "Can't tell if Claude is ready. Click its tile and try again.");
      assert.equal(deliveryGate("codex", tile("x1", "codex", { readyBox }), ans("codex"), action), "Can't tell if Codex is ready. Click its tile and try again.");
    }
  }
  // Something other than the CLI's box at the bottom (an unknown menu whose
  // marked row reads as typed text): can't tell, never "text you typed".
  assert.equal(deliveryGate("claude", still({ boxDrawn: false, draft: true }), orphan, "put"), "Can't tell if Claude is ready. Click its tile and try again.");
  // Its own refusals keep their words over a missing proof.
  assert.equal(deliveryGate("claude", still({ readyBox: false, draft: true }), orphan, "put"), "Claude's box has text you typed. Send it or clear it first.");
  assert.equal(deliveryGate("claude", still({ readyBox: false, working: true }), orphan, "put"), "Claude is working. You can pass this when it's done.");
  assert.equal(deliveryGate("claude", still({ readyBox: false, question: true }), orphan, "put"), "Claude is asking you something. Answer it in its tile first.");
  // The screen quiet but working (a spinner off the page that prints nothing): never.
  assert.equal(deliveryGate("claude", still({ working: true }), orphan, "send"), "Claude is working. You can pass this when it's done.");
}

// F3: after a Put, Enter in the target: it works and the screen reads its box
// empty, though the store's draft flag (refreshed only when the output
// settles) still says typed — the sentence leaves at once.
{
  const sent = { to: "codex" as const, at: NOW - 4000, mode: "put" as const };
  const base = { answers: { claude: ans("claude"), codex: fresh("codex") }, sent };
  const working = bar(input({ ...base, tiles: [tile("c1", "claude"), tile("x1", "codex", { working: true, draft: true, draftNow: false })] }));
  assert.equal(working.line, "Passed to Codex. It's working on it.");
  const typing = bar(input({ ...base, tiles: [tile("c1", "claude"), tile("x1", "codex", { working: true, draft: true, draftNow: true })] }));
  assert.equal(typing.line, "It's in Codex's box. Press Enter there to send it.", "text still in its box");
  const noScreen = bar(input({ ...base, tiles: [tile("c1", "claude"), tile("x1", "codex", { working: true, draft: true })] }));
  assert.equal(noScreen.line, "It's in Codex's box. Press Enter there to send it.", "no live read: the store's flag");
}
// Review B1: never Codex — its rollout closes every turn, and its screen can't
// prove it idle (a long silent patch hides its status row).
{
  const open = ans("codex", { turn: "open" });
  const x = tile("x1", "codex", { working: false, question: false, promptIdle: true, quietMs: 60_000, turnOverOnScreen: true });
  assert.equal(openTurnStale(x), false);
  assert.equal(deliveryGate("codex", x, open, "send"), "Codex is working. You can pass this when it's done.");
  const v = bar(input({ tiles: [tile("c1", "claude"), x], answers: { codex: open, claude: fresh("claude") } }));
  assert.equal(v.line, "Codex is working. This is its last finished answer.");
}
console.log("compareView F1-F4: ok");

// 1.177.1 (B): the answer to a pass is held and offered back.
{
  const PASS_AT = NOW - 120_000;
  const pending = { into: "codex" as const, at: PASS_AT, sawWork: false };
  // Which answer is the answer to the pass: that tile's, with text, finished after the pass.
  const reply = ans("codex", { answer: "Codex's review", finishedAtMs: PASS_AT + 30_000 });
  assert.deepEqual(answerToPass(pending, "codex", reply, NOW), { from: "codex", answer: reply });
  assert.equal(answerToPass(pending, "claude", ans("claude", { finishedAtMs: PASS_AT + 1 }), NOW), null, "the other tile");
  assert.equal(answerToPass(pending, "codex", ans("codex", { finishedAtMs: PASS_AT - 1 }), NOW), null, "an answer from before the pass");
  assert.equal(answerToPass(pending, "codex", ans("codex", { finishedAtMs: PASS_AT }), NOW), null, "finished at the pass itself");
  assert.equal(answerToPass(pending, "codex", ans("codex", { finishedAtMs: undefined }), NOW), null, "no time: can't tell");
  assert.equal(answerToPass(pending, "codex", ans("codex", { finishedAtMs: NOW + 3_600_000 }), NOW), null, "ahead of the clock");
  assert.equal(answerToPass(pending, "codex", ans("codex", { answer: "  ", finishedAtMs: PASS_AT + 1 }), NOW), null, "no text");
  assert.equal(answerToPass(pending, "codex", { ...reply, conversation: "ambiguous" }, NOW), null, "an ambiguous conversation");
  assert.equal(answerToPass(null, "codex", reply, NOW), null, "nothing waited for");

  // Offered back B → A with THAT answer, whatever A or B answered since.
  const held: ReturnHeld = { from: "codex", answer: { ...reply, answer: "Codex's review" } };
  const newerClaude = ans("claude", { answer: "Claude chatted", finishedAtMs: NOW - 5_000 });
  const laterCodex = ans("codex", { answer: "Codex answered something else", finishedAtMs: NOW - 2_000 });
  assert.deepEqual(directionOnOffer({ claude: newerClaude, codex: reply }, false, NOW, held), { from: "codex", to: "claude", both: true });
  assert.deepEqual(directionOnOffer({ claude: newerClaude, codex: reply }, false, NOW), { from: "claude", to: "codex", both: true }, "without the hold: newest");
  assert.deepEqual(directionOnOffer({}, false, NOW, held), { from: "codex", to: "claude", both: false }, "A has no answer: no Swap");
  let v = bar(input({ answers: { claude: newerClaude, codex: laterCodex }, held }));
  assert.equal(v.kind, "ready");
  assert.equal(v.from, "codex");
  assert.equal(v.line, "Codex answered 1 min ago", "the held answer's own age, not the later one's");
  assert.equal(v.canSwap, true);
  // B is busy with another question: the held answer still says its age.
  v = bar(input({ tiles: [tile("c1", "claude"), tile("x1", "codex", { working: true })], answers: { claude: newerClaude, codex: ans("codex", { turn: "open" }) }, held }));
  assert.equal(v.line, "Codex answered 1 min ago");
  assert.equal(v.from, "codex");
  // The guard of the return still reads the target (A) as always.
  v = bar(input({ tiles: [tile("c1", "claude", { working: true }), tile("x1", "codex")], answers: { claude: newerClaude, codex: laterCodex }, held }));
  assert.equal(v.kind, "blocked");
  assert.equal(v.note, "Claude is working. You can pass this when it's done.");
  // `flipped` doesn't turn a held offer around (Swap drops the hold first).
  assert.equal(bar(input({ answers: { claude: newerClaude, codex: laterCodex }, held, flipped: true })).from, "codex");
  // While a pass is in flight its sentence wins, as before.
  v = bar(input({ answers: { claude: newerClaude, codex: laterCodex }, held, sent: { to: "claude", at: NOW - 1_000, mode: "send" } }));
  assert.equal(v.kind, "sent");
  // A Codex that started a new conversation (`/new`): its held answer isn't offered.
  const newX = tile("x1", "codex", { newConversation: true });
  assert.equal(heldOffered(held, (vv) => (vv === "codex" ? newX : tile("c1", "claude"))), null);
  v = bar(input({ tiles: [tile("c1", "claude"), newX], answers: { claude: newerClaude, codex: laterCodex }, held }));
  assert.equal(v.from, "claude", "back to the plain rule");
  // A held Claude answer, Codex newest: Claude → Codex stays on offer.
  const heldC: ReturnHeld = { from: "claude", answer: { ...ans("claude"), answer: "Claude's plan v2" } };
  v = bar(input({ answers: { claude: ans("claude", { finishedAtMs: NOW - 600_000 }), codex: ans("codex", { finishedAtMs: NOW - 1_000 }) }, held: heldC }));
  assert.equal(v.from, "claude");
  assert.equal(v.line, "Claude answered 1 min ago");

  // The pass's text left the box with no turn: the next answer isn't the pass's.
  const sent = { to: "codex" as const, at: PASS_AT };
  const idle = tile("x1", "codex");
  assert.equal(passDropped(pending, sent, idle, undefined, NOW), true, "cleared, never worked");
  assert.equal(passDropped({ ...pending, sawWork: true }, sent, idle, undefined, NOW), false, "it worked on it: its answer comes");
  assert.equal(passDropped(pending, sent, idle, reply, NOW), false, "it answered");
  assert.equal(passDropped(pending, sent, tile("x1", "codex", { draft: true }), undefined, NOW), false, "text still in the box");
  assert.equal(passDropped(pending, sent, tile("x1", "codex", { working: null }), undefined, NOW), false, "unknown");
  assert.equal(passDropped(pending, { ...sent, at: PASS_AT + 1 }, idle, undefined, NOW), false, "another pass");
  assert.equal(passDropped(null, sent, idle, undefined, NOW), false);

  // The default ask follows the held answer: a review of a passed plan is answered.
  const history = [pass(1, "claude", "codex", "review-plan")];
  assert.equal(defaultAsk(held.answer.answerKind, lastAskInto(history, "codex"), plannedSincePass(history, "codex", undefined)), "answer-review");
}
console.log("compareView return offer: ok");

// Review round 1 (H2): a held plan of a turn still open follows that turn.
{
  const PASS_AT = NOW - 300_000;
  const v1 = ans("claude", { answer: "Plan v1", answerKind: "plan", turn: "open", planPending: true, finishedAtMs: PASS_AT + 10_000 });
  const v2 = ans("claude", { answer: "Plan v2", answerKind: "plan", turn: "open", planPending: true, finishedAtMs: PASS_AT + 60_000 });
  const done = ans("claude", { answer: "Built it.", answerKind: "text", turn: "done", finishedAtMs: PASS_AT + 120_000 });
  const later = ans("claude", { answer: "A separate question's answer", turn: "done", finishedAtMs: PASS_AT + 200_000 });
  const held1 = answerToPass({ into: "claude", at: PASS_AT, sawWork: true }, "claude", v1, NOW)!;
  assert.equal(heldIsProvisional(held1), true);
  const held2 = nextHeld(held1, "claude", v2, NOW)!;
  assert.equal(held2.answer.answer, "Plan v2", "plan v2 replaces plan v1");
  assert.equal(nextHeld(held2, "claude", v1, NOW), held2, "an older read never does");
  assert.equal(nextHeld(held2, "claude", v2, NOW), held2, "the same read: unchanged");
  assert.equal(nextHeld(held2, "codex", ans("codex", { finishedAtMs: NOW }), NOW), held2, "the other tile never does");
  const final = nextHeld(held2, "claude", done, NOW)!;
  assert.equal(final.answer.answer, "Built it.", "the turn's final answer replaces the plan");
  assert.equal(heldIsProvisional(final), false);
  assert.equal(nextHeld(final, "claude", later, NOW), final, "a separate later question does not replace it");
  // A finished answer held first stays, even while a new turn is open.
  const t1 = answerToPass({ into: "claude", at: PASS_AT, sawWork: true }, "claude", ans("claude", { answer: "First", turn: "open", finishedAtMs: PASS_AT + 5 }), NOW)!;
  assert.equal(nextHeld(t1, "claude", later, NOW), t1);
  // Codex's answers are final.
  const cx = answerToPass({ into: "codex", at: PASS_AT, sawWork: true }, "codex", ans("codex", { turn: "open", finishedAtMs: PASS_AT + 5 }), NOW)!;
  assert.equal(heldIsProvisional(cx), false);
  assert.equal(nextHeld(cx, "codex", ans("codex", { answer: "next", finishedAtMs: NOW - 1 }), NOW), cx);
  // The bar offers v2, with v2's age.
  const v = bar(input({ answers: { claude: v2, codex: ans("codex") }, held: held2 }));
  assert.equal(v.from, "claude");
}
console.log("compareView held plan: ok");

// Round 3 (M2): Codex's idle box with a slash command's output above it is
// proof only on the rollout's word that its last turn is closed.
{
  const shape = tile("x1", "codex", { readyBox: false, boxIdle: true });
  for (const action of ["put", "send"] as const) {
    assert.equal(deliveryGate("codex", shape, ans("codex", { turn: "done" }), action), null);
    assert.equal(deliveryGate("codex", shape, ans("codex", { turn: "none" }), action), "Can't tell if Codex is ready. Click its tile and try again.");
    assert.equal(deliveryGate("codex", shape, ans("codex", { turn: "none", conversation: "unstarted" }), action), "Can't tell if Codex is ready. Click its tile and try again.");
    assert.equal(deliveryGate("codex", shape, ans("codex", { turn: "open" }), action), "Codex is working. You can pass this when it's done.");
    assert.equal(deliveryGate("codex", { ...shape, boxIdle: false }, ans("codex"), action), "Can't tell if Codex is ready. Click its tile and try again.");
    assert.equal(deliveryGate("codex", { ...shape, newConversation: true }, ans("codex"), "put"), "Can't tell if Codex is ready. Click its tile and try again.", "after /new: ambiguous, the strict rule");
    // Claude never takes the shape alone.
    assert.equal(deliveryGate("claude", tile("c1", "claude", { readyBox: false, boxIdle: true }), ans("claude"), action), "Can't tell if Claude is ready. Click its tile and try again.");
  }
}
console.log("compareView Codex idle shape: ok");

// Round 3 (walk step 8): Send, then Esc landed before its Enter — the text
// back in Claude's idle box. At the first live read after the pass that
// shows it, the line says where it is: no wait.
{
  const sent = { to: "claude" as const, at: NOW - 300, mode: "send" as const };
  const back = tile("c1", "claude", { draft: true, draftNow: true });
  const base = { answers: { codex: ans("codex"), claude: ans("claude") }, sent };
  assert.equal(bar(input({ ...base, tiles: [back, tile("x1", "codex")] })).line, "It's in Claude's box. Press Enter there to send it.");
  assert.equal(bar(input({ ...base, sent: { ...sent, at: NOW }, tiles: [back, tile("x1", "codex")] })).line, "Passed to Claude. It's working on it.", "no read after the pass yet");
  assert.equal(bar(input({ ...base, tiles: [tile("c1", "claude", { working: true, draft: true, draftNow: false }), tile("x1", "codex")] })).line, "Passed to Claude. It's working on it.", "it works");
  assert.equal(bar(input({ ...base, tiles: [tile("c1", "claude", { draft: true, draftNow: true, working: null }), tile("x1", "codex")] })).line, "Passed to Claude. It's working on it.", "working unknown: as before");
  assert.equal(bar(input({ ...base, tiles: [tile("c1", "claude", { draft: true }), tile("x1", "codex")] })).line, "Passed to Claude. It's working on it.", "no live read: the store's flag isn't enough");
  assert.equal(bar(input({ ...base, sentOutputActive: true, tiles: [back, tile("x1", "codex")] })).line, "Passed to Claude. It's working on it.", "the paste still in flight");
  assert.equal(bar(input({ ...base, tiles: [tile("c1", "claude", { draft: true, draftNow: true, question: true }), tile("x1", "codex")] })).line, "Passed to Claude. It's working on it.", "a menu: not the box");
  assert.equal(bar(input({ ...base, tiles: [back, tile("x1", "codex")] })).kind, "sent", "still the pass's state, its button off");
  // Round 5 (step 9): the sentence stays for as long as the text is in the box.
  const later = { ...base, sent: { ...sent, at: NOW - 60_000 } };
  assert.equal(bar(input({ ...later, tiles: [back, tile("x1", "codex")] })).line, "It's in Claude's box. Press Enter there to send it.");
  assert.equal(sentOver(later.sent, back, ans("claude"), NOW), false);
  assert.equal(sentOver(later.sent, tile("c1", "claude", { draft: false, draftNow: false }), ans("claude"), NOW), true, "the box emptied");
}
console.log("compareView unsent Send: ok");

// Round 7 (final walk 2, step 8b): keys typed into the target just before a
// press, their echo not drawn yet, refuse — both vendors, Put and Send — and
// clear by themselves once drawn (or after ECHO_WAIT_MS with no output at all).
{
  const UNK = (v: string) => `Can't tell if ${v} is ready. Click its tile and try again.`;
  for (const [vendor, name] of [["claude", "Claude"], ["codex", "Codex"]] as const) {
    for (const action of ["put", "send"] as const) {
      const f = (inputQuietMs: number, echoPending: boolean) => tile("t", vendor, { inputQuietMs, echoPending });
      assert.equal(deliveryGate(vendor, f(200, true), ans(vendor), action), UNK(name), "keys just typed, nothing drawn");
      assert.equal(deliveryGate(vendor, f(200, false), ans(vendor), action), UNK(name), "drawn, but within the settle time");
      assert.equal(deliveryGate(vendor, f(1_500, true), ans(vendor), action), UNK(name), "nothing printed since the keys");
      assert.equal(deliveryGate(vendor, f(1_500, false), ans(vendor), action), null, "drawn and settled: the box read decides");
      assert.equal(deliveryGate(vendor, f(6_000, true), ans(vendor), action), null, "a key that draws nothing doesn't block for ever");
      assert.equal(deliveryGate(vendor, tile("t", vendor, { inputQuietMs: Number.POSITIVE_INFINITY, echoPending: false }), ans(vendor), action), null);
      // A draft the screen shows keeps its own words.
      assert.equal(deliveryGate(vendor, tile("t", vendor, { inputQuietMs: 200, echoPending: false, draft: true }), ans(vendor), action), `${name}'s box has text you typed. Send it or clear it first.`);
    }
  }
}
console.log("compareView typed-just-now: ok");
