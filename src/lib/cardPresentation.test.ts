// UX P1 point 2 (P-A): `presentCard`, one state function for every surface.
// Test 1 (one fixture per rule, one per canonical state), test 5 (the
// disagreements of the spec's table, by name), test 7 (the Ship batch leaves
// out a card stopped on a conflict) and test 3's TS half (the shared Inbox
// fixtures). Run with Node 22+:
//   node --experimental-strip-types src/lib/cardPresentation.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { KanbanCard } from "../ipc.ts";
import { CARD_STATES, FINISH_TITLE } from "./cardLifecycle.ts";
import { deriveAttentionColumn, isShipBatchEligible } from "./boardSemantics.ts";
import {
  BUILDER_STOPPED_SENTENCE,
  CODEX_SEARCH_OPEN_SENTENCE,
  PRESENTATION_RULES,
  RESULT_READY_HEADLINE,
  READING_RESULT_SENTENCE,
  SHIP_CONFLICT_HEADLINE,
  SHIP_FAILED_HEADLINE,
  TRUST_HEADLINE,
  COPY_BRIEF_EMPTY,
  COPY_BRIEF_EMPTY_HEADLINE,
  copyBriefEmpty,
  cardLive,
  presentCard,
  queueFilterWords,
  recordInboxGroup,
  type CardPresentation,
  boardCardTitle,
} from "./cardPresentation.ts";
import { NOW, PRESENTATION_FIXTURES, fixtureCard } from "./cardPresentation.fixtures.ts";

// ── 1. One fixture per rule, one per canonical state ──────────────────

/** [fixture, rule, headline, column, primary, Inbox group] */
const EXPECTED: ReadonlyArray<[string, string, string, string | null, string, string | null]> = [
  ["archived card", "archived", "Archived", null, "view-history", null],
  ["reviews a member's pull request", "pr-review", "Not reviewed yet", "needs-you", "rerun-review", "needs_you"],
  ["held by a blocker", "blocked", "Blocked", "waiting", "start-build", null],
  ["someone else holds its issue", "claimed", "Claimed by ana", "waiting", "start-build", null],
  // 1.174.0 (C3, P9): Now asks which area before Start build.
  ["its area is not chosen yet", "choose-area", "Which area is this card for?", "not-started", "start-build", null],
  // 1.173.0 (F1, one count): a Board Needs you card always has its row.
  ["a two-AI plan waits for the person", "plan", "Plan ready to review", "needs-you", "open-plan", "needs_you"],
  ["a two-AI plan runs", "plan", "Two AIs are planning", "working", "open-plan", null],
  ["its setup failed", "setup", "Setup failed", "needs-you", "start-build", "needs_you"],
  ["its setup runs", "setup", "Setting up the card", "working", "start-build", null],
  ["its intake conversation ended", "intake-stopped", "Planning with Claude stopped", "needs-you", "plan-again", "needs_you"],
  ["its intake asks to trust the folder", "intake-trust", TRUST_HEADLINE, "needs-you", "open-conversation", "needs_you"],
  ["its Builder asks to trust the folder", "session-block", TRUST_HEADLINE, "needs-you", "inspect-run", "needs_you"],
  ["its Codex Builder asks to trust the folder", "session-block", TRUST_HEADLINE, "needs-you", "inspect-run", "needs_you"],
  ["its Builder stopped", "builder-waiting", "Your turn", "needs-you", "finish-and-check", "needs_you"],
  ["its Builder asks a question", "builder-waiting", "Asks you something", "needs-you", "inspect-run", "needs_you"],
  ["its Builder went quiet", "builder-waiting", "Your turn", "needs-you", "inspect-run", "needs_you"],
  ["changes requested, its Builder asks a question", "builder-waiting", "Asks you something", "needs-you", "inspect-run", "needs_you"],
  // 1.171.0 C1 (CF1): the fix round.
  ["changes requested, its Builder fixes them", "builder-fixing", "Claude is fixing 3 findings · 2m", "working", "inspect-run", "running"],
  ["changes requested, its Builder finished the fixes", "builder-waiting", "Claude finished the fixes", "needs-you", "finish-and-check", "needs_you"],
  ["Finish and check pressed, its Builder re-reads its work", "finishing", "Re-reading its work", "working", "finish-and-check", "running"],
  ["Plyloft quit during the self-check", "check-stopped", "Finish and check stopped", "needs-you", "finish-and-check", "needs_you"],
  ["the checks wait for this Mac's OK", "checks-ok", "The checks need your OK", "needs-you", "allow-checks", "needs_you"],
  ["changes sent, its Builder works on them", "builder-fixing", "Codex is working on your changes", "working", "inspect-run", "running"],
  ["built by both, a build waits", "both", "Building with both", "needs-you", "inspect-run", "needs_you"],
  ["built by both, both working", "both", "Building with both", "working", "inspect-run", "running"],
  ["changes sent to the Builder", "changes-sent", "Changes sent to the Builder", "working", "inspect-run", null],
  [
    "a request for changes the Builder never received",
    "handed-over",
    "1 finding still open · the last review didn't finish",
    "needs-you",
    "send-handed-over",
    "needs_you",
  ],
  [
    "changes requested, verdict not delivered",
    "verdict-owed",
    "Claude doesn't have the findings yet",
    "needs-you",
    "send-handed-over",
    "needs_you",
  ],
  // QoL 1.168 (C5): Review again leads a failed review; Ship anyway is second.
  ["review failed on a ready card", "review-truth", "The last commit was not reviewed", "needs-you", "review-again", "needs_you"],
  ["a runner is chosen", "swarm-ready", "Ready to start", "not-started", "start-work", null],
  // 1.171.0 B1 (owner D6): its checks running on GitHub — Working, in the
  // stage's words (never "Shipped" while it waits, CP-2).
  ["its pull request is open", "pr-open", "On GitHub · waiting for checks", "working", "inspect-ship", null],
  // 1.169.1 (R1): ready to merge asks for its Merge; a review GitHub
  // requires is On hold (owner, 2026-10-26).
  ["its pull request is ready to merge", "pr-open", "Ready to merge", "needs-you", "pr-merge", "needs_you"],
  ["its pull request has no checks", "pr-open", "Ready to merge", "needs-you", "pr-merge", "needs_you"],
  ["its pull request waits for a review", "pr-open", "Waiting for a review on GitHub", "waiting", "pr-open-github", null],
  ["its pull request was closed", "pr-closed", "Pull request closed", "needs-you", "ship", "needs_you"],
  // 1.171.0 B1 (DL-03): "Merged" said two places; this one is GitHub.
  ["merged as a pull request", "merged", "Shipped · on GitHub", "done", "inspect-ship", null],
  ["its Builder session closed", "session-closed", "Session closed", "needs-you", "resume-session", "needs_you"],
  ["a local ship stopped on a conflict", "ship-conflict", SHIP_CONFLICT_HEADLINE, "needs-you", "ship", "needs_you"],
  ["a skill card behind its team library", "skill-behind", "The team changed this skill again", "needs-you", "refresh-skill", "needs_you"],
  [
    "a skill card behind its team library, a changed script shown first",
    "skill-behind",
    "The team changed this skill again",
    "needs-you",
    "delete-skill-card",
    "needs_you",
  ],
  ["a ship press failed", "ship-failed", SHIP_FAILED_HEADLINE, "needs-you", "ship", "needs_you"],
  ["a release through a pull request on its way", "releasing", "Releasing through a pull request", "working", "release-open-github", "running"],
  // 1.171.0 C1 (CF5): a card with only its title starts.
  ["draft", "base", "Ready to start", "not-started", "start-build", null],
  ["planning with Claude", "base", "Planning with Claude", "working", "open-conversation", null],
  ["closed with no run", "base", "Closed", "done", "view-history", null],
  ["ready to start", "base", "Ready to start", "not-started", "start-build", null],
  // 1.175.0 (D3): the card reads as it did — and is in Needs you, with its
  // Inbox row, while its issue asks which version to keep.
  ["ready, its brief changed on GitHub and here", "base", "Ready to start", "needs-you", "start-build", "needs_you"],
  ["a teammate's, its title changed on GitHub and here", "claimed", "Claimed by ana", "needs-you", "start-build", "needs_you"],
  // 1.173.0 (F1, Challenger 6): On hold in the Inbox, as on the Board.
  ["in line for a swarm slot", "base", "In line", "waiting", "see-queue", "on_hold"],
  ["an agent run is working", "base", "Working", "working", "inspect-run", "running"],
  ["paused swarm", "base", "Paused", "waiting", "resume-work", null],
  ["Reviewing", "base", "Reviewing", "working", "inspect-run", "running"],
  ["Reviewer requests changes (delivered)", "base", "Reviewer requests changes", "needs-you", "inspect-run", "needs_you"],
  ["running checks", "base", "Running checks", "working", "inspect-checks", "running"],
  // 1.173.0 (F1): Failed folded into Needs you.
  ["checks failed", "base", "Checks failed", "needs-you", "inspect-checks", "needs_you"],
  ["the run failed", "base", "Stopped", "needs-you", "retry-work", "needs_you"],
  ["the review is out of date", "base", "Review is out of date", "needs-you", "rerun-review", "needs_you"],
  ["nothing changed", "base", "Nothing changed", "needs-you", "inspect-outcome", "needs_you"],
  ["ready to ship (result read)", "base", "Ready to ship", "needs-you", "ship", "needs_you"],
  ["ready to ship (result not read yet)", "base", "Ready to ship", "needs-you", "inspect-outcome", "needs_you"],
  ["the result is loading", "base", "Ready to ship", "needs-you", "inspect-outcome", "needs_you"],
  ["result ready, not verified", "base", RESULT_READY_HEADLINE, "needs-you", "inspect-outcome", "needs_you"],
  ["shipping", "base", "Shipping", "working", "inspect-ship", "running"],
  ["shipped in a release", "base", "Shipped", "done", "inspect-ship", null],
];

assert.deepEqual(
  EXPECTED.map((e) => e[0]),
  PRESENTATION_FIXTURES.map((f) => f.name),
  "one expectation per fixture, in order",
);
const presented = new Map<string, CardPresentation>();
for (const f of PRESENTATION_FIXTURES) presented.set(f.name, presentCard(f.card, f.live));
for (const [name, rule, headline, column, action, group] of EXPECTED) {
  const p = presented.get(name)!;
  const f = PRESENTATION_FIXTURES.find((x) => x.name === name)!;
  assert.equal(p.rule, rule, `${name}: rule`);
  assert.equal(p.rule, f.rule, `${name}: the fixture is the rule's`);
  assert.equal(p.headline, headline, `${name}: headline`);
  assert.equal(p.column, column, `${name}: column`);
  assert.equal(p.action.id, action, `${name}: primary`);
  assert.equal(p.inbox.group, group, `${name}: Inbox group`);
}
// Every rule has one.
for (const rule of PRESENTATION_RULES) {
  assert.ok(
    PRESENTATION_FIXTURES.some((f) => presented.get(f.name)!.rule === rule),
    `a fixture for rule ${rule}`,
  );
}
// Every canonical state is reached by a fixture through rule 20 or another.
const reached = new Set([...presented.values()].map((p) => p.state));
for (const state of CARD_STATES) assert.ok(reached.has(state), `a fixture in state ${state}`);

// ── 1.174.0 (C3, P9): Now asks for the area ──
{
  const f = PRESENTATION_FIXTURES.find((x) => x.name === "its area is not chosen yet")!;
  const start = presented.get(f.name)!;
  assert.equal(start.action.label, "Start in Site");
  assert.equal(start.tone, "accent");
  assert.equal(start.held, false);
  // Why it asks, in the backend's words, when it says more.
  const why = presentCard(f.card, { ...f.live, areaAsk: { kind: "choose", area: "Site", why: "Its issue is labeled area:docs." } });
  assert.equal(why.sentence, "Its issue is labeled area:docs.");
  // Held areas: no filled press, the way to Settings.
  const held = presentCard(f.card, { ...f.live, areaAsk: { kind: "held", sentence: "The areas list on GitHub has two areas in the same folder." } });
  assert.equal(held.headline, "This repository's areas can't be used");
  assert.equal(held.tone, "quiet");
  assert.equal(held.action.id, "open-areas-settings");
  assert.equal(held.action.label, "Open Settings › Project › Areas");
  // A blocker and a running card win; nothing asks without the fact.
  const blockedF = PRESENTATION_FIXTURES.find((x) => x.name === "held by a blocker")!;
  assert.equal(presentCard(blockedF.card, { ...blockedF.live, areaAsk: f.live.areaAsk }).rule, "blocked");
  const working = PRESENTATION_FIXTURES.find((x) => x.name === "an agent run is working")!;
  assert.notEqual(presentCard(working.card, { ...working.live, areaAsk: f.live.areaAsk }).rule, "choose-area");
  assert.equal(presentCard(f.card, { ...f.live, areaAsk: null }).rule, "base");
}

// ── 1.169.1 (R1): the green pull request's fixtures, beyond the table ──

{
  const review = presented.get("its pull request waits for a review")!;
  assert.equal(review.action.label, "Open on GitHub");
  assert.notEqual(review.presentation.tone, "accent", "On hold: nothing asked, no accent");
  assert.equal(presented.get("its pull request is ready to merge")!.action.label, "Merge");
  // Auto-merge on: GitHub merges it — 1.171.0 B1 (owner D6): Working, in
  // the stage's words; nothing asked of the person, so no Inbox row.
  const f = PRESENTATION_FIXTURES.find((x) => x.name === "its pull request is ready to merge")!;
  const auto = presentCard({ ...f.card, pr: { ...f.card.pr!, autoMerge: true } }, f.live);
  assert.equal(auto.headline, "On GitHub · merges when checks pass");
  assert.equal(auto.column, "working");
  assert.equal(auto.dot.state, "running");
  assert.equal(auto.inbox.group, null);
}

// ── P-B (points 3 and 4): the Now table's four session rows ──────────

{
  const stopped = presented.get("its Builder stopped")!;
  assert.equal(stopped.sentence, BUILDER_STOPPED_SENTENCE);
  assert.equal(
    stopped.sentence,
    "Claude says it's done. Check it, or tell it what's missing. When it's finished, Finish and check tests it and has it reviewed.",
  );
  assert.equal(stopped.action.label, "Finish and check", "the press itself, from Now");
  assert.equal(stopped.presentation.tone, "accent");
  const question = presented.get("its Builder asks a question")!;
  assert.equal(question.sentence, "Claude asked you something. Answer it in the session.");
  assert.equal(question.action.label, "Open the Builder");
  const quiet = presented.get("its Builder went quiet")!;
  assert.equal(quiet.sentence, "Codex hasn't printed anything for a while. Look at the session: it may be asking something.");
  assert.equal(quiet.action.label, "Open the Builder");
  // 1.174.3 (Windows walk): Resume brought back a cut-off turn — not "says it's
  // done", and Finish and check stays.
  {
    const q = PRESENTATION_FIXTURES.find((x) => x.name === "its Builder stopped")!;
    const session = { ...q.live.session!, vendor: "codex" as const, turnInterrupted: true };
    const cut = presentCard(q.card, { ...q.live, session });
    assert.equal(cut.sentence, "Codex's last turn was interrupted. Tell it to carry on, or Finish and check what's there.");
    assert.equal(cut.action.label, "Finish and check");
  }
  // 1.172.0 E3 (Windows walk): Codex's transcript search open over its
  // composer — Now says how to close it, not "hasn't printed anything".
  {
    const q = PRESENTATION_FIXTURES.find((x) => x.name === "its Builder went quiet")!;
    const search = presentCard(q.card, { ...q.live, session: { ...q.live.session!, codexSearchOpen: true } });
    assert.equal(search.sentence, "Codex's search is open in the session. Press Esc there to close it.");
    assert.equal(search.sentence, CODEX_SEARCH_OPEN_SENTENCE);
    assert.equal(search.action.label, "Open the Builder");
    assert.equal(search.action.id, "inspect-run");
    // And while Finish and check waits on its self-check.
    const checking = presentCard(q.card, cardLive({
      now: NOW,
      session: { vendor: "codex", state: "working", block: null, finishing: true, since: NOW, selfCheck: { since: NOW, delivered: false }, codexSearchOpen: true },
    }));
    assert.equal(checking.rule, "finishing");
    assert.equal(checking.sentence, CODEX_SEARCH_OPEN_SENTENCE);
    assert.equal(checking.action.label, "Open the Builder");
    // Closed again: the quiet words come back.
    assert.equal(presentCard(q.card, q.live).sentence, quiet.sentence);
  }
  // Working: the state's own words, in Working.
  const f = PRESENTATION_FIXTURES.find((x) => x.name === "its Builder stopped")!;
  const working = presentCard(f.card, cardLive({ now: NOW, session: { vendor: "claude", state: "working", block: null } }));
  assert.equal(working.rule, "base");
  assert.equal(working.headline, "Working");
  assert.equal(working.column, "working");
  assert.equal(working.action.id, "inspect-run");
  // Saved: the card's next state speaks (rule 9 is not about it).
  const saved = presentCard(f.card, cardLive({ now: NOW, session: { vendor: "claude", state: "saved", block: null } }));
  assert.equal(saved.rule, "base");
  // The trust question outranks it (rule 8 before 9).
  const trust = presentCard(f.card, cardLive({ now: NOW, session: { vendor: "claude", state: "stopped", block: { kind: "trust" } } }));
  assert.equal(trust.rule, "session-block");
  // UX P-F (point 8): Claude's usage limit — one word on the Board, the card
  // and the Inbox, and the one primary opens the session (Plyloft never
  // types "continue").
  const limit = presentCard(
    f.card,
    cardLive({ now: NOW, session: { vendor: "claude", state: "stopped", block: { kind: "usageLimit", resetsAt: "3pm" } } }),
  );
  assert.equal(limit.rule, "session-block");
  assert.equal(limit.headline, "Paused · your plan's limit resets at 3pm");
  assert.equal(limit.sentence, "Claude's usage limit is reached. After it resets at 3pm, tell the Builder to continue.");
  assert.equal(limit.column, "needs-you");
  assert.equal(limit.action.id, "inspect-run");
  assert.equal(limit.action.label, "Open the Builder");
  assert.equal(limit.inbox.group, "needs_you");
  assert.equal(limit.inbox.sessionRow, true, "its Inbox row is the session's (`sessionBlockWords`)");
  assert.deepEqual(limit.dot, { state: "aborted", live: false });
  assert.equal(limit.readyToShip, false);
  const noTime = presentCard(
    f.card,
    cardLive({ now: NOW, session: { vendor: "claude", state: null, block: { kind: "usageLimit", resetsAt: null } } }),
  );
  assert.equal(noTime.sentence, "Claude's usage limit is reached. After it resets, tell the Builder to continue.");
  assert.equal(noTime.headline, "Paused · your plan's limit resets soon");
  // Point 5's edge case, in P-F: Claude's Bypass Permissions warning.
  const bypass = presentCard(f.card, cardLive({ now: NOW, session: { vendor: "claude", state: null, block: { kind: "bypass" } } }));
  assert.equal(bypass.rule, "session-block");
  assert.equal(bypass.headline, "Asks to work without asking");
  assert.equal(
    bypass.sentence,
    "Claude asks you to accept that it works without asking. In the session, choose “Yes, I accept”. “No, exit” ends the session.",
  );
  assert.equal(bypass.column, "needs-you");
  assert.equal(bypass.action.label, "Open the Builder");
  // Not running (the Challenger reviews, the checks run): rule 9 waits.
  const reviewing = PRESENTATION_FIXTURES.find((x) => x.name === "Reviewing")!;
  const r = presentCard(reviewing.card, cardLive({ now: NOW, session: { vendor: "claude", state: "stopped", block: null } }));
  assert.equal(r.rule, "base");
  assert.equal(r.headline, "Reviewing");
  // UX P-B Mac walk 2: a question outranks every rule after 8, in any
  // state its live session asks in — "Challenger requests changes" (the
  // walk's case), the review running, a ready card.
  const asked = presented.get("changes requested, its Builder asks a question")!;
  assert.equal(asked.state, "changes-requested");
  assert.equal(asked.sentence, "Claude asked you something. Answer it in the session.");
  assert.equal(asked.action.label, "Open the Builder");
  assert.equal(asked.waiting, "question");
  assert.equal(asked.inbox.sessionRow, true, "its Inbox row is the session's");
  assert.deepEqual(asked.dot, { state: "aborted", live: false });
  for (const name of ["Reviewing", "Reviewer requests changes (delivered)", "ready to ship (result read)", "changes requested, verdict not delivered"]) {
    const fx = PRESENTATION_FIXTURES.find((x) => x.name === name)!;
    const q = presentCard(fx.card, { ...fx.live, session: { vendor: "claude", state: "question", block: null } });
    assert.equal(q.rule, "builder-waiting", `${name}: a question outranks it`);
    assert.equal(q.headline, "Asks you something", name);
    assert.equal(q.column, "needs-you", name);
    assert.equal(q.readyToShip, false, `${name}: Ship waits for the answer`);
    assert.equal(q.action.shipMode, undefined, name);
  }
  // 1.171.0 C1 (CF1): beside "Challenger requests changes" with the
  // findings delivered, its live Builder speaks — at work (Working), its
  // turn over (Finish and check again in Now), or quiet (rule 9's); with no
  // live session the card's own words stay.
  const requested = PRESENTATION_FIXTURES.find((x) => x.name === "Reviewer requests changes (delivered)")!;
  // (Challenger 5) A message went into the session after the verdict.
  const fxStopped = presentCard(requested.card, { ...requested.live, session: { vendor: "codex", state: "stopped", block: null, since: NOW } });
  assert.equal(fxStopped.rule, "builder-waiting");
  assert.equal(fxStopped.headline, "Codex finished the fixes");
  assert.equal(fxStopped.action.id, "finish-and-check");
  assert.equal(fxStopped.action.label, "Finish and check again");
  assert.equal(fxStopped.presentation.actionTitle, FINISH_TITLE, "the session's own press");
  assert.equal(fxStopped.waiting, "stopped");
  assert.deepEqual(
    fxStopped.inbox,
    { group: "needs_you", detail: "Codex finished the fixes", action: "Open card", live: true },
    "the card's own row, in its words (the session's folds into it)",
  );
  assert.equal(fxStopped.column, "needs-you");
  const fxQuiet = presentCard(requested.card, { ...requested.live, session: { vendor: "claude", state: "quiet", block: null, since: NOW } });
  assert.equal(fxQuiet.rule, "builder-waiting");
  assert.equal(fxQuiet.headline, "Your turn");
  const fxWorking = presentCard(requested.card, { ...requested.live, now: NOW, session: { vendor: "claude", state: "working", block: null, since: NOW - 500 } });
  assert.equal(fxWorking.rule, "builder-fixing");
  assert.equal(fxWorking.headline, "Claude is fixing the findings", "no count recorded, no clock under a minute");
  assert.equal(fxWorking.inbox.group, "running");
  assert.equal(fxWorking.inbox.detail, "Claude is fixing the findings");
  assert.deepEqual(fxWorking.dot, { state: "running", live: true });
  // Finish and check pressed: 1.171.0 C2 (CF3) — the wait's word, Working,
  // its press busy.
  const fxFinishing = presentCard(requested.card, {
    ...requested.live,
    session: { vendor: "claude", state: "working", block: null, finishing: true, since: NOW },
  });
  assert.equal(fxFinishing.rule, "finishing");
  assert.equal(fxFinishing.headline, "Re-reading its work");
  assert.deepEqual(fxFinishing.inbox, { group: "running", detail: "Re-reading its work", action: null, live: true });
  assert.equal(fxFinishing.action.id, "finish-and-check");
  assert.equal(fxFinishing.column, "working");
  assert.equal(presentCard(requested.card, requested.live).headline, "Reviewer requests changes", "no live session");
  // (Challenger 5) A verdict recorded but never in this session (acknowledged,
  // or delivered to an earlier one), nothing sent in since: its turn being
  // over says nothing about the findings — the card's own words stay.
  for (const verdict of [null, { at: NOW - 1000, ptyId: "pty-old", state: "sent" as const, acked: true }]) {
    const quietTurn = presentCard(requested.card, {
      ...requested.live,
      delivery: { handedOver: null, verdict, changesSentAt: null, fixSentKey: null },
      session: { vendor: "claude", state: "stopped", block: null, since: NOW - 60_000 },
    });
    assert.equal(quietTurn.rule, "base");
    assert.equal(quietTurn.headline, "Reviewer requests changes");
  }
  // Delivered into this very session: the fix round, whatever the clock.
  const deliveredHere = presentCard(
    { ...requested.card, builder: { ...requested.card.builder!, ptyId: "pty-9" } },
    {
      ...requested.live,
      delivery: { handedOver: null, verdict: { at: NOW - 1000, ptyId: "pty-9", state: "sent", acked: true }, changesSentAt: null, fixSentKey: null },
      session: { vendor: "claude", state: "stopped", block: null },
    },
  );
  assert.equal(deliveredHere.headline, "Claude finished the fixes");
  // The clock is in the headline only: the Inbox row's words don't move.
  const fixing = presented.get("changes requested, its Builder fixes them")!;
  assert.equal(fixing.inbox.detail, "Claude is fixing 3 findings");
  assert.equal(fixing.readyToShip, false);
  // A findings send still owed keeps its press (Send the findings…), and a
  // card built by both, archived or reviewing a pull request is not a fix round.
  const owedFx = PRESENTATION_FIXTURES.find((x) => x.name === "changes requested, verdict not delivered")!;
  const owedNow = presentCard(owedFx.card, { ...owedFx.live, session: { vendor: "claude", state: "working", block: null } });
  assert.equal(owedNow.rule, "verdict-owed");
  // (Challenger 3) A title-only card names the AI Start build launches.
  const draftFx = PRESENTATION_FIXTURES.find((x) => x.name === "draft")!;
  assert.equal(
    presentCard(draftFx.card, { ...draftFx.live, builderVendor: "codex", planner: "claude" }).sentence,
    "Codex gets only the title for now: say what you want below, or choose Plan it first to have Claude ask you questions.",
  );
  // Not right's changes: the same, without the pushback.
  const sentFx = PRESENTATION_FIXTURES.find((x) => x.name === "changes sent, its Builder works on them")!;
  const sentDone = presentCard(sentFx.card, { ...sentFx.live, session: { vendor: "codex", state: "stopped", block: null } });
  assert.equal(sentDone.headline, "Codex finished the fixes");
  assert.doesNotMatch(sentDone.sentence, /pushback/);
  assert.equal(sentDone.action.label, "Finish and check again");
  assert.equal(sentDone.readyToShip, false, "Ship waits for Finish and check");
  // Held 3 s after it stopped waiting: Needs you still, the Inbox already
  // Running (it reads the session itself).
  const held = presentCard(f.card, cardLive({ now: NOW, session: { vendor: "claude", state: "stopped", block: null, held: true } }));
  assert.equal(held.column, "needs-you");
  assert.equal(held.inbox.group, "running");
  // A card built by both: each build keeps its words, the card goes to
  // Needs you.
  const both = presented.get("built by both, a build waits")!;
  assert.equal(both.rule, "both");
  assert.equal(both.column, "needs-you");
}

// ── 5. The disagreements of the spec's table, by name ─────────────────

{
  // The trust question: the Board, the card page and the Inbox say
  // "Asks to trust the folder" — the page no longer says "Needs you".
  const p = presented.get("its Builder asks to trust the folder")!;
  assert.equal(p.headline, TRUST_HEADLINE);
  assert.equal(p.presentation.label, TRUST_HEADLINE);
  // 1.171.0 D2: once per project (measured on Claude), the answer named.
  assert.match(p.sentence, /^Claude asks this once for this project: .*Choose “Yes, I trust this folder” in the session\.$/);
  assert.equal(p.column, "needs-you");
  // Codex wasn't measured: no "once", no button name.
  const codex = presented.get("its Codex Builder asks to trust the folder")!;
  assert.equal(codex.sentence, "Codex asks whether to trust this folder. Answer it in the session.");
}
{
  // A local ship stopped on a conflict: "Ship stopped on a conflict", in
  // Needs you, with a Needs you Inbox row — not "Preparing the result",
  // not "Result ready", not nothing.
  const p = presented.get("a local ship stopped on a conflict")!;
  assert.equal(p.headline, SHIP_CONFLICT_HEADLINE);
  // P-E: a card with no Builder and no record says how by hand (adopted 15).
  assert.equal(
    p.sentence,
    "The last ship stopped on a conflict. Nothing was merged. Resolve it in the card's copy, then ship again.",
  );
  assert.equal(p.action.label, "Ship again");
  assert.equal(p.inbox.group, "needs_you");
  assert.equal(p.readyToShip, false);
  // UX P-A (Windows walk 2): a Ship press that failed on it after the
  // conflict (Retry ship, refused before any merge ran) is the newest: it
  // says the failure, on every surface, and not the conflict's sentence
  // beside it. Once the failure goes, the conflict is said again.
  const f = PRESENTATION_FIXTURES.find((x) => x.name === "a local ship stopped on a conflict")!;
  const failed = presentCard(f.card, { ...f.live, shipFailure: "ship-it" });
  assert.equal(failed.rule, "ship-failed");
  assert.equal(failed.headline, SHIP_FAILED_HEADLINE);
  assert.equal(failed.sentence, "The last ship stopped before it finished, and the card's work is kept. Fix what stopped it, then try again.");
  assert.equal(failed.action.label, "Try again");
  assert.equal(failed.column, "needs-you");
  assert.equal(failed.readyToShip, false);
  assert.deepEqual(failed.inbox, { group: "needs_you", detail: SHIP_FAILED_HEADLINE, action: "Open card", live: true });
  assert.equal(presentCard(f.card, { ...f.live, shipFailure: null }).rule, "ship-conflict");
}
{
  // UX P1 point 7 (P-E): with a Builder and the conflict recorded, rule 18's
  // primary asks the Builder; the sentence names the branch and the count.
  const f = PRESENTATION_FIXTURES.find((x) => x.name === "a local ship stopped on a conflict")!;
  const builder = { vendor: "claude", bypass: false, ptyId: "pty-c", sessionLost: false, startedAt: 1, snapshots: [{ n: 1, sha: "abc", at: 1 }] };
  const conflict = { paths: ["a.ts", "b.ts"], targetSha: "def", at: 2, branch: "main" };
  const asked = { ...f.card, builder, shipConflict: conflict } as KanbanCard;
  const p = presentCard(asked, f.live);
  assert.equal(p.rule, "ship-conflict");
  assert.equal(p.headline, SHIP_CONFLICT_HEADLINE);
  assert.equal(p.sentence, "main changed the same lines as this card in 2 files. Nothing was merged.");
  assert.equal(p.action.label, "Fix with the Builder");
  assert.equal(p.presentation.actionId, "ship-conflict-ask");
  assert.equal(p.presentation.actionTitle, "Sends the Builder what conflicts and how to resolve it. It doesn't ship.");
  assert.equal(p.column, "needs-you");
  assert.equal(p.inbox.group, "needs_you");
  assert.equal(p.readyToShip, false);
  // Its menu's Ship again that failed is said as any failed ship.
  const failed = presentCard(asked, { ...f.live, shipFailure: "ship-it" });
  assert.equal(failed.rule, "ship-failed");
  assert.equal(failed.action.label, "Try again");
  // Without a Builder the same record: Ship again, and the by-hand sentence.
  const alone = presentCard({ ...asked, builder: null } as KanbanCard, f.live);
  assert.equal(alone.action.label, "Ship again");
  assert.equal(
    alone.sentence,
    "main changed the same lines as this card in 2 files. Nothing was merged. Resolve it in the card's copy, then ship again.",
  );
  // The merge started: rule 11's words, the session to watch; Ship waits.
  const resolving = { ...asked, shipConflict: { ...conflict, mergeStartedAt: 3 } } as KanbanCard;
  const r = presentCard(resolving, f.live);
  assert.equal(r.rule, "changes-sent");
  assert.equal(r.headline, "Changes sent to the Builder");
  assert.equal(r.sentence, "Claude is resolving the conflict with main. When it's done, press Finish and check. Ship waits until then.");
  assert.equal(r.action.label, "Open the Builder");
  assert.equal(r.column, "working");
  assert.equal(r.readyToShip, false);
  // Its turn over: Now's press is Finish and check, which commits the merge.
  const stopped = presentCard(resolving, { ...f.live, session: { vendor: "claude", state: "stopped", block: null } });
  assert.equal(stopped.presentation.actionId, "finish-and-check");
  assert.equal(stopped.action.label, "Finish and check");
  assert.equal(stopped.headline, "Changes sent to the Builder");
}
{
  // A ship press that failed: "Ship didn't go through" on every surface, a
  // Needs you Inbox row in those words — not "Ready to ship · checks passed".
  const p = presented.get("a ship press failed")!;
  assert.equal(p.headline, SHIP_FAILED_HEADLINE);
  assert.equal(p.action.label, "Try again");
  assert.deepEqual(p.inbox, { group: "needs_you", detail: SHIP_FAILED_HEADLINE, action: "Open card", live: true });
  assert.deepEqual(p.dot, { state: "aborted", live: false });
}
{
  // Changes sent to the Builder, no new round: Working, and the Inbox does
  // not list it as Ready to ship.
  const p = presented.get("changes sent to the Builder")!;
  assert.equal(p.headline, "Changes sent to the Builder");
  assert.equal(p.column, "working");
  assert.equal(p.inbox.group, null);
  assert.equal(p.inbox.live, true);
}
{
  // 1.171.0 C2: Finish and check's self-check that never went on — Plyloft
  // quit during it, or its session ended — says so with Finish and check
  // again; a live session (resumed) or one finishing now does not.
  const f = PRESENTATION_FIXTURES.find((x) => x.name === "Plyloft quit during the self-check")!;
  const quit = presented.get(f.name)!;
  assert.match(quit.sentence, /^Plyloft closed while Claude was re-reading its work, so nothing was saved or checked yet\./);
  assert.equal(quit.action.label, "Finish and check again");
  assert.deepEqual(quit.inbox, { group: "needs_you", detail: "Finish and check stopped", action: "Open card", live: true });
  const ended = presentCard({ ...f.card, builder: { ...f.card.builder!, lostOnRestart: false } }, f.live);
  assert.match(ended.sentence, /^Claude's session ended while it was re-reading its work/);
  const resumed = presentCard({ ...f.card, builder: { ...f.card.builder!, ptyId: "pty-2", sessionLost: false } }, f.live);
  assert.notEqual(resumed.rule, "check-stopped");
  const done = presentCard({ ...f.card, builder: { ...f.card.builder!, selfCheckStartedAt: null } }, f.live);
  assert.equal(done.rule, "session-closed");
  // 1.173.0 (F1, BI-7, owner D11): Plyloft's quit paused the Builder — it
  // asks nothing: On hold, with Resume, and the Inbox's On hold row.
  assert.equal(done.headline, "Paused when Plyloft closed");
  assert.equal(done.column, "waiting");
  assert.equal(done.action.label, "Resume");
  assert.equal(done.inbox.group, "on_hold");
  // U16: Start fresh leads only for Codex, and not on a card built by both.
  {
    const closed = { ...f.card, lastRunStatus: "aborted" as const, builder: { ...f.card.builder!, selfCheckStartedAt: null, resumeFailed: true } };
    const codex = presentCard({ ...closed, builder: { ...closed.builder, vendor: "codex" as const } }, f.live);
    assert.equal(codex.action.id, "start-fresh");
    // The Inbox says the card's press: Rust's row would still say Resume.
    assert.equal(codex.inbox.action, "Start fresh");
    assert.equal(codex.inbox.live, true);
    assert.equal(presentCard({ ...closed, builder: { ...closed.builder, vendor: "claude" as const } }, f.live).action.id, "resume-session");
    const both = { ...closed, builder: { ...closed.builder, vendor: "codex" as const }, buildBoth: { lanes: [], outcome: null } as never };
    assert.notEqual(presentCard(both, f.live).action.id, "start-fresh");
  }
  // U25: only the question left from Ship's draft leaves Merge leading.
  {
    const ready = PRESENTATION_FIXTURES.find((x) => x.name === "its pull request is ready to merge")!;
    const live = (extra = {}) =>
      cardLive({ ...ready.live, session: { vendor: "codex", state: "question", block: null }, ...extra });
    // The real flow's status: Fix with the Builder leaves it Success, so the state stays shipped.
    const card = { ...ready.card, lastRunStatus: "success" as const, builder: { ...ready.card.builder!, ptyId: "pty-1" } };
    const left = presentCard(card, live({ draftQuestionLeft: true }));
    assert.equal(left.rule, "pr-open");
    assert.equal(left.headline, "Ready to merge");
    assert.equal(left.action.id, "pr-merge");
    assert.match(left.sentence ?? "", /Codex still asks something in its session; the pull request doesn't wait for it\.$/);
    // A question in a fix round, same status: it comes first, no Merge.
    const fixing = presentCard(card, live());
    assert.equal(fixing.rule, "builder-waiting");
    assert.equal(fixing.action.id, "inspect-run");
    assert.equal(fixing.column, "needs-you");
    // Waiting on checks: a real question still moves the card to Needs you.
    const waitingF = PRESENTATION_FIXTURES.find((x) => x.name === "its pull request is open")!;
    const checks = presentCard(
      { ...waitingF.card, lastRunStatus: "success" as const, builder: { ...(waitingF.card.builder ?? ready.card.builder!), ptyId: "pty-1" } },
      cardLive({ ...waitingF.live, session: { vendor: "codex", state: "question", block: null } }),
    );
    assert.equal(checks.column, "needs-you");
    // Merged: Done isn't led by it.
    const mergedF = { ...card, pr: { ...card.pr!, state: "merged" as const, mergedAt: 2 } };
    const merged = presentCard(mergedF as never, live());
    assert.notEqual(merged.rule, "builder-waiting");
    assert.doesNotMatch(merged.headline, /Asks you something/);
    assert.doesNotMatch(merged.sentence ?? "", /asked you something/);
    assert.match(merged.sentence ?? "", /Codex still asks something in its session\.$/);
  }
  // A session the person closed (aborted), one that ended by itself, or a
  // Resume that ended at once is still "Session closed" in Needs you.
  for (const card of [
    { ...f.card, lastRunStatus: "aborted" as const, builder: { ...f.card.builder!, selfCheckStartedAt: null } },
    { ...f.card, builder: { ...f.card.builder!, selfCheckStartedAt: null, lostOnRestart: false } },
    { ...f.card, builder: { ...f.card.builder!, selfCheckStartedAt: null, resumeFailed: true } },
  ]) {
    const p = presentCard(card, f.live);
    assert.equal(p.headline, "Session closed");
    assert.equal(p.column, "needs-you");
    assert.equal(p.inbox.group, "needs_you");
  }
}
{
  // The result still being read: never "Preparing the result" — the
  // Board's word, and that it is being read; the primary waits for it.
  for (const name of ["the result is loading", "ready to ship (result not read yet)", "result ready, not verified"]) {
    const p = presented.get(name)!;
    assert.notEqual(p.headline, "Preparing the result", name);
    assert.equal(p.sentence, READING_RESULT_SENTENCE, name);
    assert.equal(p.action.id, "inspect-outcome", name);
    assert.deepEqual(p.dot, { state: "done", live: false }, `${name}: finished, not in flight`);
  }
  // A fact still loading never changes the headline: loading reads as no
  // fact at all, on every surface.
  const f = PRESENTATION_FIXTURES.find((x) => x.name === "the result is loading")!;
  assert.equal(presentCard(f.card, { ...f.live, outcome: null }).headline, presented.get(f.name)!.headline);
  // 1.171.0 C2 (CF22): while it is read, no accent flash (the page turns
  // its press off too); a result nobody has read yet stays the Board's accent.
  assert.equal(presented.get("the result is loading")!.tone, "quiet");
  assert.equal(presented.get("result ready, not verified")!.tone, "accent");
}
{
  // "Nothing changed": with the page's count both say it; with no count the
  // Board's rule (every run changed nothing) keeps "Result ready".
  const p = presented.get("nothing changed")!;
  assert.equal(p.headline, "Nothing changed");
  const nothing = fixtureCard("nothing", {
    columnId: "complete",
    lastRunStatus: "success",
    verifyStatus: "passed",
    worktreePath: "/w",
    runHistory: [{ filesChangedCount: 0 } as never],
  });
  assert.equal(presentCard(nothing, cardLive({ now: NOW })).headline, RESULT_READY_HEADLINE);
}
{
  // Rule 3 is only for a card nobody has started: a running card that
  // someone else holds keeps its word.
  const running = fixtureCard("held-running", { columnId: "in_progress", lastRunStatus: "running", ghIssueNumber: 3 });
  assert.equal(presentCard(running, cardLive({ claimedByOthers: "Claimed by ana" })).headline, "Working");
  // A blocked card's chip names its blocker; the headline is Blocked.
  const p = presented.get("held by a blocker")!;
  assert.equal(p.blocked, "Blocked by “blocker”");
  assert.equal(p.held, true);
}
{
  // An archived card is archived, whatever else is live about it.
  const f = PRESENTATION_FIXTURES.find((x) => x.name === "archived card")!;
  assert.equal(presentCard(f.card, { ...f.live, shipFailure: "ship-it" }).rule, "archived");
}

// ── 7. The Ship batch leaves out a card stopped on a conflict ─────────

{
  const ready: KanbanCard = fixtureCard("ready", {
    columnId: "complete",
    lastRunStatus: "success",
    verifyStatus: "passed",
    worktreePath: "/w",
  });
  assert.equal(isShipBatchEligible(ready), true);
  assert.equal(isShipBatchEligible({ ...ready, reviewStatus: "conflict_blocked" }), false);
  // The palette's "Ship batch · N cards": one ready, one stopped → 1.
  assert.equal([ready, { ...ready, id: "c2", reviewStatus: "conflict_blocked" as const }].filter(isShipBatchEligible).length, 1);
}

// ── 3. The shared Inbox fixtures (TS half; inbox.rs holds the Rust half) ─

type AttentionFixture = {
  name: string;
  lastRunStatus: KanbanCard["lastRunStatus"];
  reviewStatus: KanbanCard["reviewStatus"];
  verifyStatus: KanbanCard["verifyStatus"];
  shipStatus: KanbanCard["shipStatus"];
  columnId: KanbanCard["columnId"];
  archived: boolean;
  /** 1.169.1 (R1): the card's pull request, when the fixture has one. */
  prUrl?: string;
  pr?: KanbanCard["pr"];
  /** 1.170.0 (G6): a conflict record, when the fixture has one. */
  shipConflict?: KanbanCard["shipConflict"];
  /** 1.173.0 (F1): the card's Builder, when the fixture has one. */
  builder?: KanbanCard["builder"];
  /** 1.175.0 (D3): open questions on its issue's title or brief. */
  editConflicts?: KanbanCard["editConflicts"];
  expectedGroup?: string;
};
const shared = JSON.parse(
  readFileSync(new URL("./attention.fixtures.json", import.meta.url), "utf8"),
) as AttentionFixture[];
assert.ok(shared.some((f) => f.reviewStatus === "conflict_blocked"), "the conflict row is in the shared fixtures");
for (const f of shared) {
  assert.ok(f.expectedGroup, `${f.name}: the shared fixture names its Inbox group`);
  const card = fixtureCard(f.name, {
    lastRunStatus: f.lastRunStatus,
    reviewStatus: f.reviewStatus,
    verifyStatus: f.verifyStatus,
    shipStatus: f.shipStatus,
    columnId: f.columnId,
    archived: f.archived,
    ...(f.pr ? { pr: f.pr, prUrl: f.prUrl } : {}),
    ...(f.shipConflict ? { shipConflict: f.shipConflict } : {}),
    ...(f.builder ? { builder: f.builder } : {}),
    ...(f.editConflicts ? { editConflicts: f.editConflicts } : {}),
  });
  // The record's group is Rust's (`derive_card_events`, same fixture).
  assert.equal(recordInboxGroup(card) ?? "none", f.expectedGroup, `${f.name}: record group`);
  // The card's own group never disagrees with its Board column.
  const p = presentCard(card, cardLive({ now: NOW }));
  // F1 (one count): a Needs you row is a Needs you card, and back.
  if (p.inbox.group === "needs_you") assert.equal(p.column, "needs-you", f.name);
  if (p.column === "needs-you") assert.equal(p.inbox.group, "needs_you", `${f.name}: the Board's Needs you card has its Inbox row`);
  if (p.inbox.group === "running") assert.equal(p.column, "working", f.name);
  // F1 (Challenger 6): a queued or paused card is On hold in both.
  if (p.inbox.group === "on_hold") assert.equal(p.column, "waiting", f.name);
}

// ── (Challenger) "See the queue" ticks every running card's word ───────
{
  const byName = (name: string) => PRESENTATION_FIXTURES.find((f) => f.name === name)!;
  const live = new Map(PRESENTATION_FIXTURES.map((f) => [f.card.id, f.live]));
  const cards = [
    byName("built by both, both working").card,
    byName("its Builder asks to trust the folder").card,
    byName("in line for a swarm slot").card,
    byName("ready to start").card,
  ];
  const words = queueFilterWords(cards, (c) => presentCard(c, live.get(c.id)!));
  assert.ok(words.includes("Working") && words.includes("In line"), JSON.stringify(words));
  assert.ok(words.includes("Building with both"), JSON.stringify(words));
  assert.ok(words.includes(TRUST_HEADLINE), JSON.stringify(words));
  assert.ok(!words.includes("Ready to start"), JSON.stringify(words));
}

// Gate b05: a Builder read before snapshots were recorded (a tour fixture,
// an older card) has none — presenting it never throws.
{
  const noSnapshots = fixtureCard("no-snapshots", {
    columnId: "in_progress",
    builder: { vendor: "claude", bypass: false, sessionLost: false, startedAt: 1 } as never,
  });
  assert.doesNotThrow(() => presentCard(noSnapshots, cardLive({ now: NOW })));
}

console.log(`cardPresentation: ${PRESENTATION_FIXTURES.length} fixtures, ${PRESENTATION_RULES.length} rules, ${shared.length} shared Inbox fixtures`);

// Challenger M1 (block 8): a card moved to Complete by hand, its checks
// passed and no run — Rust's `review:<id>:manual` row — is Needs you on a
// warm workspace (presentCard) and a cold one (deriveAttentionColumn alone),
// never Not started; a draft in To do is Not started on both.
{
  const manual = fixtureCard("manual-complete", {
    lastRunStatus: null as never,
    reviewStatus: null as never,
    verifyStatus: "passed",
    shipStatus: "unshipped",
    columnId: "complete",
  });
  const warm = presentCard(manual, cardLive({ now: NOW }));
  assert.equal(warm.column, "needs-you", "warm: manual complete");
  assert.equal(warm.inbox.group, "needs_you", "warm: the Inbox row stands");
  assert.equal(deriveAttentionColumn(manual, null), "needs-you", "cold: manual complete");
  const draft = fixtureCard("todo-draft", { columnId: "todo" });
  assert.equal(presentCard(draft, cardLive({ now: NOW })).column, "not-started", "warm: draft");
  assert.equal(deriveAttentionColumn(draft, null), "not-started", "cold: draft");
}

// D8 (1.171.0): the merged-as-a-pull-request fixture carries the version the
// merge stamped; no surface says it shipped as that version.
{
  const { shippedResultLine, whatShippedName } = await import("./prStatus.ts");
  const merged = PRESENTATION_FIXTURES.find((x) => x.name === "merged as a pull request")!.card;
  assert.equal(merged.shipHistory?.[0]?.shippedVersion, "1.0.0");
  const line = shippedResultLine(merged, (v) => `v${v}`, () => "today");
  assert.equal(line, "Merged on GitHub as pull request #5 on today.");
  assert.equal(whatShippedName(merged, "chore: snapshot 1 (#5)"), "Add the merged page");
  const p = presentCard(merged, cardLive({ now: NOW }));
  assert.ok(!JSON.stringify(p).includes("v1.0.0"), "no surface names the stamped version");
}

// 1.171.0 C3 walk fix (owner 2026-10-27): a review skipped with "Check
// without the Reviewer" is no review — on GitHub, Now's primary
// (and the Board's "→ press") is the pull request the person merges; the
// wait after the press says the Challenger doesn't review it.
{
  const { boardNextPress } = await import("./cardPresentation.ts");
  const { SHIP_ANYWAY_LABEL, SAVING_WITHOUT_REVIEW_SENTENCE, SAVING_WAIT_SENTENCE } = await import("./deliveryWords.ts");
  const snaps = [{ n: 1, sha: "aaaaaaaa1", at: NOW - 30_000 }];
  const card = (review: NonNullable<KanbanCard["builder"]>["review"]) =>
    fixtureCard("skipped-ship", {
      columnId: "complete",
      lastRunStatus: "success",
      verifyStatus: "passed",
      worktreePath: "/w/s",
      branchName: "card/s",
      builder: { vendor: "codex", bypass: false, sessionLost: false, startedAt: NOW - 60_000, snapshots: snaps, review },
    });
  const outcome = { loading: false, filesChanged: 2, shipBusy: false, noRemote: false, prOffered: true, reviewFreshness: "none" as const };
  const skipped = presentCard(
    card({ snapshotN: 1, provider: "claude", degraded: false, status: "skipped", at: NOW - 1000 }),
    cardLive({ now: NOW, outcome }),
  );
  assert.equal(skipped.state, "ready-to-ship");
  assert.equal(skipped.presentation.actionLabel, SHIP_ANYWAY_LABEL, "skipped: the pull request the person merges");
  assert.equal(skipped.presentation.shipMode, "pr_only", "skipped: never merges by itself");
  assert.equal(boardNextPress(skipped), SHIP_ANYWAY_LABEL, "the Board's press is Now's");
  // An approved review: Ship it, merging when the checks pass.
  const approved = presentCard(
    card({ snapshotN: 1, provider: "claude", degraded: false, status: "done", verdict: "approve", at: NOW - 1000 }),
    cardLive({ now: NOW, outcome }),
  );
  assert.equal(approved.presentation.actionLabel, "Ship it");
  assert.equal(approved.presentation.shipMode, "ship_it");
  // An override (the person sided with the Builder) is a decision: Ship it.
  const overridden = presentCard(
    card({ snapshotN: 1, provider: "claude", degraded: false, status: "skipped", at: NOW - 1000, note: "changes requested on snapshot 1, overridden by the human" }),
    cardLive({ now: NOW, outcome }),
  );
  assert.equal(overridden.presentation.actionLabel, "Ship it");
  // Not on GitHub: it lands here — Ship it, as before.
  const here = presentCard(
    card({ snapshotN: 1, provider: "claude", degraded: false, status: "skipped", at: NOW - 1000 }),
    cardLive({ now: NOW, outcome: { ...outcome, prOffered: false } }),
  );
  assert.equal(here.presentation.actionLabel, "Ship it");

  // Challenger 3: work not reviewed at all says the same, on GitHub.
  // (A review that failed on an earlier round: no Review again on this one.)
  const unreviewedCard = (): KanbanCard => ({
    ...card({ snapshotN: 1, provider: "claude", degraded: false, status: "failed", at: NOW - 1000 }),
    builder: {
      ...card(undefined).builder!,
      snapshots: [...snaps, { n: 2, sha: "bbbbbbbb2", at: NOW - 20_000 }],
      review: { snapshotN: 1, provider: "claude", degraded: false, status: "failed", at: NOW - 1000 },
    },
  });
  const unreviewed = presentCard(unreviewedCard(), cardLive({ now: NOW, outcome }));
  assert.equal(unreviewed.rule, "review-truth");
  assert.equal(unreviewed.presentation.actionLabel, SHIP_ANYWAY_LABEL);
  assert.equal(unreviewed.presentation.shipMode, "pr_only");
  assert.equal(boardNextPress(unreviewed), SHIP_ANYWAY_LABEL);
  // Here, it stays "Ship anyway".
  const unreviewedHere = presentCard(unreviewedCard(), cardLive({ now: NOW, outcome: { ...outcome, prOffered: false } }));
  assert.equal(unreviewedHere.presentation.actionLabel, "Ship anyway");

  // The wait after the press.
  const running = fixtureCard("skipping", {
    columnId: "in_progress",
    lastRunStatus: "success",
    worktreePath: "/w/k",
    builder: { vendor: "codex", bypass: false, sessionLost: false, startedAt: NOW - 60_000, snapshots: [], ptyId: "pty-1" },
  });
  const finishing = (withoutReview: boolean) =>
    presentCard(
      running,
      cardLive({ now: NOW, session: { vendor: "codex", state: "working", block: null, since: NOW, finishing: true, ...(withoutReview ? { withoutReview: true } : {}) } }),
    );
  assert.equal(finishing(true).rule, "finishing");
  assert.equal(finishing(true).presentation.helper, SAVING_WITHOUT_REVIEW_SENTENCE);
  assert.ok(!/the Reviewer reviews it/.test(finishing(true).presentation.helper));
  assert.equal(finishing(false).presentation.helper, SAVING_WAIT_SENTENCE);
  // Challenger 4: its title doesn't promise the review either.
  assert.ok(!/has it reviewed/.test(finishing(true).presentation.actionTitle ?? ""));
  assert.match(finishing(false).presentation.actionTitle ?? "", /has it reviewed/);

  // 1.171.0 re-walk (step 3): the checks' wait after the press says it too
  // — the press is over (no `withoutReview`), the round's skipped review
  // carries it; the override's note (a decision) and an older round's skip
  // don't.
  const { reviewSkippedThisRound } = await import("./cardPresentation.ts");
  const checkingCard = (review: NonNullable<KanbanCard["builder"]>["review"], snapshots = snaps): KanbanCard => ({
    ...card(review),
    columnId: "in_progress",
    verifyStatus: "running",
    builder: { ...card(review).builder!, snapshots },
  });
  const checks = (c: KanbanCard) => presentCard(c, cardLive({ now: NOW }));
  const skippedChecks = checks(checkingCard({ snapshotN: 1, provider: "claude", degraded: false, status: "skipped", at: NOW - 1000 }));
  assert.equal(skippedChecks.state, "checking");
  assert.equal(
    skippedChecks.presentation.helper,
    "Plyloft is running the checks. The Reviewer doesn't review it this time. You can leave this; Plyloft tells you when it's done.",
  );
  const reviewedChecks = checks(checkingCard({ snapshotN: 1, provider: "claude", degraded: false, status: "done", verdict: "approve", at: NOW - 1000 }));
  assert.equal(reviewedChecks.state, "checking");
  assert.equal(reviewedChecks.presentation.helper, "Plyloft is running the checks. You can leave this; Plyloft tells you when it's done.");
  assert.equal(reviewSkippedThisRound(checkingCard({ snapshotN: 1, provider: "claude", degraded: false, status: "skipped", at: NOW - 1000, note: "overridden" })), false);
  assert.equal(
    reviewSkippedThisRound(
      checkingCard({ snapshotN: 1, provider: "claude", degraded: false, status: "skipped", at: NOW - 1000 }, [...snaps, { n: 2, sha: "bbbbbbbb2", at: NOW - 10_000 }]),
    ),
    false,
    "a skip of an older round says nothing of this one",
  );
}

// 1.174.0 (A5, P16): the Board card's tooltip says the card opens to merge,
// so it reads apart from the Inbox's Merge, which merges in place.
{
  const p = (id: string, column = "needs-you") =>
    ({ column, action: { id, label: id === "pr-merge" ? "Merge" : "See the review" }, held: false, blocked: null }) as never;
  const card = { title: "Site: say hello", pr: { number: 138 } };
  assert.equal(boardCardTitle(card, p("pr-merge")), "Open the card to merge pull request #138");
  assert.equal(boardCardTitle(card, p("open-review")), "Site: say hello");
  assert.equal(boardCardTitle(card, p("pr-merge", "done")), "Site: say hello", "no press, no merge words");
  assert.equal(boardCardTitle({ title: "No pr" }, p("pr-merge")), "No pr");
}

// 1.174.0 C4 (P17): a card made from a copy waits for its brief — the
// headline says so, Now's own line (`nowFacts`) stays, and the brief as typed
// counts.
{
  const fromCopy = { id: "copy-1a2b3c4d", name: "win-copy-1" };
  const card = fixtureCard("copy-empty", { columnId: "todo", notes: "", fromCopy });
  assert.equal(COPY_BRIEF_EMPTY, "Say what the Builder should do first.");
  assert.equal(copyBriefEmpty(card, ""), true);
  assert.equal(copyBriefEmpty(card, "  \n"), true);
  assert.equal(copyBriefEmpty(card, "Keep two plans"), false);
  assert.equal(copyBriefEmpty({ ...card, fromCopy: null }, ""), false, "not made from a copy");
  assert.equal(copyBriefEmpty({ ...card, columnId: "in_progress" }, ""), false, "started");
  assert.equal(copyBriefEmpty({ ...card, archived: true }, ""), false);
  const held = presentCard(card, cardLive({ workspaceCards: [card] }));
  assert.equal(held.presentation.label, COPY_BRIEF_EMPTY_HEADLINE);
  assert.equal(held.presentation.actionId, "start-build");
  assert.equal(held.presentation.helper, held.base.helper, "Now's line is the card's facts");
  const typed = presentCard(card, cardLive({ workspaceCards: [card], notesDraft: "Keep two plans" }));
  assert.equal(typed.presentation.label, "Ready to start");
}
console.log("cardPresentation C4: passed");

// 1.175.0 (D3): the Inbox row of a card whose issue asks which version to
// keep says the question, with Choose; a card that is done asks nothing.
{
  const asks = presentCard(
    fixtureCard("asks", { notes: "mine", ghIssueNumber: 70, editConflicts: [{ part: "brief", theirs: "theirs" }, { part: "title", theirs: "T" }] }),
    cardLive({ now: NOW }),
  );
  assert.deepEqual(asks.inbox, {
    group: "needs_you",
    detail: "The brief changed on GitHub · choose which version the card keeps",
    action: "Choose",
    live: true,
  });
  const titleOnly = presentCard(
    fixtureCard("asks-title", { notes: "mine", ghIssueNumber: 70, editConflicts: [{ part: "title", theirs: "T" }] }),
    cardLive({ now: NOW }),
  );
  assert.equal(titleOnly.inbox.detail, "The title changed on GitHub · choose which version the card keeps");
  const done = presentCard(
    fixtureCard("asks-done", { columnId: "complete", lastRunStatus: "success", shipStatus: "shipped", reviewStatus: "merged", editConflicts: [{ part: "title", theirs: "T" }] }),
    cardLive({ now: NOW }),
  );
  assert.equal(done.column, "done");
  assert.notEqual(done.inbox.group, "needs_you");
  console.log("cardPresentation edit question (D3): ok");
}
