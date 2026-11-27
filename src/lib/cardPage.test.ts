// C6 pure contract: the words a card page says about itself. Run with:
//   node --experimental-strip-types src/lib/cardPage.test.ts
import assert from "node:assert/strict";
import type { KanbanCard } from "../ipc.ts";
import { GITHUB_SIGN_IN_ACTION, githubRefusalPage, plainCause } from "./plainError.ts";
import {
  ago,
  changeChoicesTitle,
  briefFirstLine,
  BRIEF_FOLD_TITLE,
  builderFact,
  builderVendorChoosable,
  restartPermissionsChoosable,
  effectiveBuilderVendor,
  cardActionError,
  prOpenFailure,
  commitStopError,
  skillPrLocalRefusal,
  startNeedsSetUpError,
  mergeConflictPaths,
  cardTimeline,
  landedSection,
  shippedReceipt,
  checksFact,
  checksRowLabels,
  intakeStartError,
  intakeStoppedError,
  intakeConcludeError,
  dismissFailedError,
  loadFailedError,
  releaseAuditError,
  releaseFailedError,
  releaseConflict,
  RELEASE_ROLLED_BACK_WORDS,
  SET_UP_ACTION,
  reviewFact,
  challengerFact,
  sessionSummary,
  timelineWhen,
  nowFacts,
  runStartedWords,
  checksFailedWords,
  checksRunningWords,
  reviewRoundText,
  visibleRounds,
  unrecordedRoundsText,
  roundFindingIds,
  ROUNDS_SHOWN,
  PUT_BACK_NOW,
  shippedWords,
} from "./cardPage.ts";
import { PUT_BACK_SESSION_WORDS } from "./cardLifecycle.ts";
import { readFileSync } from "node:fs";

const base = (patch: Partial<KanbanCard> = {}): KanbanCard => ({
  id: "c1",
  workspaceId: "ws",
  title: "Fix login redirect",
  columnId: "todo",
  createdAt: 1_000,
  updatedAt: 1_000,
  ...patch,
});

// ── Properties ────────────────────────────────────────────────────────
assert.deepEqual(checksFact(base()), { word: "Not run yet", state: "empty" });
assert.deepEqual(checksFact(base({ verifyStatus: "passed" })), { word: "Passed", state: "done" });
assert.deepEqual(checksFact(base({ verifyStatus: "failed" })), { word: "Failed", state: "aborted" });
// GH #333: a pass with no checks set up ran nothing — "None set up", never Passed.
const noChecksEntry = { verifyRunId: "v0", status: "passed" as const, endedAt: 5_000, steps: [] };
assert.deepEqual(
  checksFact(base({ verifyStatus: "passed", verifyHistory: [noChecksEntry] })),
  { word: "None set up", state: "empty" },
);
assert.deepEqual(
  checksFact(base({ verifyStatus: "passed", verifyHistory: [noChecksEntry, { ...noChecksEntry, verifyRunId: "v1", steps: [{ kind: "script", passed: true, elapsedMs: 1 }] }] })),
  { word: "Passed", state: "done" },
);
// 1.174.0 (TX1, T1; WALK 08): only GitHub has checks → one row, GitHub's;
// both → each row says where it ran (this PC on Windows).
{
  const openPr = (checks: "none" | "passing", extra: Record<string, unknown> = {}) =>
    ({ state: "open", checks, checkedAt: 1, ...extra }) as unknown as KanbanCard["pr"];
  const noOwn = { verifyStatus: "passed" as const, verifyHistory: [noChecksEntry], prUrl: "https://github.com/o/r/pull/8" };
  const own = { verifyStatus: "passed" as const, verifyHistory: [{ ...noChecksEntry, steps: [{ kind: "script", passed: true, elapsedMs: 1 }] }], prUrl: "https://github.com/o/r/pull/8" };
  assert.deepEqual(checksRowLabels(base({ ...noOwn, pr: openPr("passing") }), true, "mac"), { own: null, github: "Checks on GitHub" });
  assert.deepEqual(checksRowLabels(base({ ...noOwn, pr: openPr("none", { awaitingChecks: true }) }), true, "mac"), { own: null, github: "Checks on GitHub" });
  assert.deepEqual(checksRowLabels(base({ ...own, pr: openPr("passing") }), true, "mac"), { own: "Checks on this Mac", github: "Checks on GitHub" });
  assert.deepEqual(checksRowLabels(base({ ...own, pr: openPr("passing") }), true, "windows"), { own: "Checks on this PC", github: "Checks on GitHub" });
  // GitHub with no checks, or not read yet: the card's own row stays.
  assert.deepEqual(checksRowLabels(base({ ...noOwn, pr: openPr("none") }), true, "mac"), { own: "Checks on this Mac", github: "Checks on GitHub" });
  assert.deepEqual(checksRowLabels(base({ ...noOwn, pr: openPr("passing", { checkedAt: null }) }), true, "mac"), { own: "Checks on this Mac", github: "Checks on GitHub" });
  // No open pull request: the card's row as before.
  assert.deepEqual(checksRowLabels(base(noOwn), true, "mac"), { own: "Checks", github: null });
  assert.deepEqual(checksRowLabels(base({ ...noOwn, pr: openPr("passing", { state: "merged" }) }), true, "mac"), { own: "Checks", github: null });
  assert.deepEqual(checksRowLabels(base(own), false, "mac"), { own: null, github: null });
}
{
  const events = cardTimeline(base({ verifyHistory: [noChecksEntry] }));
  const checks = events.filter((e) => e.id.startsWith("checks-"));
  assert.deepEqual(checks.map((e) => [e.text, e.state]), [["No checks set up", "empty"]]);
  assert.ok(!events.some((e) => /Checks passed/.test(e.text)));
}
{
  // 1.172.0 D2 (walk#6): said once, at the latest round that had none — its
  // link the card's See the checks.
  const later = { ...noChecksEntry, verifyRunId: "v2", endedAt: 9_000 };
  const checks = cardTimeline(base({ verifyHistory: [noChecksEntry, later] })).filter((e) => e.id.startsWith("checks-"));
  assert.deepEqual(checks.map((e) => [e.id, e.text]), [["checks-v2", "No checks set up"]]);
  assert.equal(checks[0]!.link?.kind, "checks");
}
// 1.172.0 D2 (CP-21): a shipped card's Shipping is The result's receipt.
assert.equal(shippedReceipt({ shipStatus: "shipped" }), true);
assert.equal(shippedReceipt({ shipStatus: "shipped", prReview: {} as KanbanCard["prReview"] }), false);
assert.equal(landedSection("ship", { shipStatus: "shipped" }), "outcome");
assert.equal(landedSection("ship", { shipStatus: "none" as KanbanCard["shipStatus"] }), "ship");
assert.equal(landedSection("run", { shipStatus: "shipped" }), "run");
assert.deepEqual(checksFact(base({ verifyStatus: "running" })), { word: "Running", state: "running" });

type Builder = NonNullable<KanbanCard["builder"]>;
const builder = (review?: Builder["review"]): Builder => ({
  vendor: "claude",
  bypass: false,
  sessionLost: false,
  startedAt: 2_000,
  snapshots: [{ n: 1, sha: "abc", at: 3_000 }],
  review: review ?? null,
});
assert.equal(reviewFact(base()).word, "Not reviewed yet");
assert.equal(
  reviewFact(base({ builder: builder({ snapshotN: 1, provider: "codex", degraded: false, status: "done", verdict: "approve", at: 4_000 }) })).word,
  "Approved",
);
assert.deepEqual(
  reviewFact(base({ builder: builder({ snapshotN: 1, provider: "codex", degraded: false, status: "done", verdict: "changes_requested", at: 4_000 }) })),
  { word: "Changes requested", state: "aborted" },
);
assert.equal(
  reviewFact(base({ builder: builder({ snapshotN: 1, provider: "codex", degraded: false, status: "running", at: 4_000 }) })).state,
  "running",
);
// CL-1: the Challenger property names the vendor, never the model.
{
  const r = (extra: Partial<NonNullable<Builder["review"]>>) =>
    base({ builder: builder({ snapshotN: 1, provider: "codex", degraded: false, status: "done", verdict: "approve", at: 4_000, model: "gpt-6-astra medium", ...extra }) });
  assert.deepEqual(challengerFact(r({})), { word: "Codex · approved", state: "done" });
  assert.deepEqual(challengerFact(r({ status: "running", verdict: null })), { word: "Codex · reviewing", state: "running" });
  assert.deepEqual(challengerFact(r({ verdict: "changes_requested" })), { word: "Codex · changes requested", state: "aborted" });
  assert.equal(challengerFact(r({ provider: "claude", singleVendor: true })).word, "Claude · same vendor · approved");
  assert.equal(
    challengerFact(r({ provider: "claude", degraded: true, status: "running", verdict: null })).word,
    "Claude · same vendor (Codex unavailable) · reviewing",
  );
  assert.equal(
    challengerFact(r({ provider: "claude", degraded: true, singleVendor: true })).word,
    "Claude · same vendor · approved",
  );
  assert.deepEqual(challengerFact(r({ status: "skipped", verdict: null })), { word: "Skipped", state: "empty" });
  assert.equal(
    challengerFact(r({ status: "skipped", verdict: null, note: "changes requested on snapshot 1, overridden by the human" })).word,
    "Codex · overridden by you",
  );
  // Challenger 6: the same who as The result — "you" for this person, the
  // recorded name for a teammate.
  const by = (who: string) =>
    r({ status: "skipped", verdict: null, note: "changes requested on snapshot 1, overridden by the human", overriddenBy: who });
  assert.equal(challengerFact(by("me@x.com"), undefined, "ME@x.com").word, "Codex · overridden by you");
  assert.equal(challengerFact(by("ana@x.com"), undefined, "me@x.com").word, "Codex · overridden by ana@x.com");
  assert.ok(cardTimeline(by("ana@x.com"), { me: "me@x.com" }).some((e) => e.text === "ana@x.com overrode the requested changes"));
  assert.ok(cardTimeline(by("me@x.com"), { me: "me@x.com" }).some((e) => e.text === "You overrode the requested changes"));
  assert.ok(!challengerFact(r({})).word.includes("gpt"), "the model stays under Technical details");
  assert.equal(challengerFact(base()).word, "Not reviewed yet");
}
// Round 3 (RW-A): an accepted pushback is said as one, not "skipped".
{
  const accepted = builder({
    snapshotN: 1, provider: "codex", degraded: false, status: "skipped", at: 4_000,
    note: "changes requested on snapshot 1, overridden by the human",
  });
  assert.deepEqual(reviewFact(base({ builder: accepted })), { word: "Overridden by you", state: "done" });
  const texts = cardTimeline(base({ builder: accepted })).map((e) => e.text);
  assert.ok(texts.includes("You overrode the requested changes"), texts.join(" | "));
  assert.ok(!texts.includes("The review was skipped"));
  const skipped = builder({ snapshotN: 1, provider: "codex", degraded: false, status: "skipped", at: 4_000 });
  assert.equal(reviewFact(base({ builder: skipped })).word, "Skipped");
  const skippedRow = cardTimeline(base({ builder: skipped })).find((e) => e.text === "The review was skipped");
  // 1.174.0 C5 (T45): its link opens the Review, which says why.
  assert.deepEqual(skippedRow?.link, { kind: "review", label: "Why it was skipped" });
}
// CL-5: review rounds in Activity — one row per round, in words, linking to
// its findings; older ones folded past ROUNDS_SHOWN; old cards fall back to
// the latest review alone.
{
  type Round = NonNullable<Builder["reviewRounds"]>[number];
  const round = (n: number, patch: Partial<Round> = {}): Round => ({
    round: n, verdict: "changes_requested", new: 0, closed: 0, stillOpen: 0,
    at: 4_000 + n, provider: "codex", reviewId: `r${n}`, snapshotN: n, ...patch,
  });
  assert.equal(reviewRoundText(round(1, { new: 2 })), "Round 1 · Codex · changes requested · 2 new");
  assert.equal(
    reviewRoundText(round(2, { verdict: "approve", closed: 2 })),
    "Round 2 · Codex · approved · 2 closed",
  );
  assert.equal(
    reviewRoundText(round(3, { new: 1, closed: 1, stillOpen: 1, notes: 1 })),
    "Round 3 · Codex · changes requested · 1 new · 1 closed · 1 still open · 1 small note",
  );
  assert.equal(reviewRoundText(round(4, { verdict: "incomplete", provider: "claude" })), "Round 4 · Claude · couldn't see enough to judge");
  // 1.171.0 C3 (CF25): an approval carries its small notes in its word.
  assert.equal(reviewRoundText(round(5, { verdict: "approve", notes: 2 })), "Round 5 · Codex · approved (2 small notes)");
  assert.equal(ROUNDS_SHOWN, 4);
  assert.deepEqual(visibleRounds([1, 2, 3, 4], false), { shown: [1, 2, 3, 4], hidden: [] });
  assert.deepEqual(visibleRounds([1, 2, 3, 4, 5, 6], false), { shown: [3, 4, 5, 6], hidden: [1, 2] });
  assert.deepEqual(visibleRounds([1, 2, 3, 4, 5, 6], true).hidden, []);

  const latest = { snapshotN: 2, provider: "codex", degraded: false, status: "done", verdict: "approve", reviewId: "r2", at: 4_002 } as const;
  const two = base({
    builder: {
      ...builder(latest),
      reviewRounds: [
        round(1, { new: 2, newIds: ["F1", "F2"] }),
        round(2, { verdict: "approve", closed: 2, closedIds: ["F1", "F2"] }),
      ],
    },
  });
  const events = cardTimeline(two);
  const rows = events.filter((e) => e.id.startsWith("review-"));
  assert.deepEqual(
    rows.map((e) => [e.text, e.state, e.link?.label, e.link?.ariaLabel, e.link?.findingIds]),
    [
      ["Round 1 · Codex · changes requested · 2 new", "aborted", "See its findings", "See round 1's findings", ["F1", "F2"]],
      ["Round 2 · Codex · approved · 2 closed", "done", "See its findings", "See round 2's findings", ["F1", "F2"]],
    ],
    "the latest review is its round, not a second row",
  );
  // A review running after the rounds is its own row.
  const running = base({
    builder: { ...builder({ ...latest, status: "running", verdict: null, reviewId: null, at: 5_000 }), reviewRounds: two.builder!.reviewRounds },
  });
  {
    const rows = cardTimeline(running).filter((e) => e.id.startsWith("review-"));
    assert.equal(rows[rows.length - 1]?.text, "Codex is reviewing the latest build");
  }
  // A card before CL-5: the latest review alone, as before.
  const old = cardTimeline(base({ builder: builder(latest) })).filter((e) => e.id.startsWith("review-"));
  assert.deepEqual(old.map((e) => e.text), ["Codex reviewed it · approved"]);
  // Six rounds: the last four, and one row for the two before them.
  const six = base({ builder: { ...builder(null), reviewRounds: [1, 2, 3, 4, 5, 6].map((n) => round(n)) } });
  const folded = cardTimeline(six).filter((e) => e.id.startsWith("review-"));
  assert.deepEqual(folded.map((e) => e.text), [
    "2 earlier review rounds",
    "Round 3 · Codex · changes requested",
    "Round 4 · Codex · changes requested",
    "Round 5 · Codex · changes requested",
    "Round 6 · Codex · changes requested",
  ]);
  assert.deepEqual(folded[0].link, { kind: "rounds", label: "Show them" });
  assert.equal(folded[1].link, undefined, "a round that touched no finding has nothing to open");
  assert.equal(cardTimeline(six, { showAllRounds: true }).filter((e) => e.id.startsWith("review-round-")).length, 6);

  // CL-5 round 2: rounds the card has no record of are said, never skipped.
  assert.equal(unrecordedRoundsText(0, 1), null);
  assert.equal(unrecordedRoundsText(0, 2), "Round 1 wasn't recorded");
  assert.equal(unrecordedRoundsText(0, 5), "Rounds 1–4 weren't recorded");
  assert.equal(unrecordedRoundsText(5, 7), "Round 6 wasn't recorded");
  // CL-5 round 3: rounds the cap dropped are not "never recorded".
  assert.equal(unrecordedRoundsText(0, 3, true), "Rounds 1–2 are no longer kept");
  assert.equal(unrecordedRoundsText(0, 2, true), "Round 1 is no longer kept");
  {
    const trimmed = base({ builder: { ...builder(null), reviewRounds: [round(11, { trimmedBefore: true }), round(12)] } });
    assert.equal(cardTimeline(trimmed).filter((e) => e.id.startsWith("review-"))[0].text, "Rounds 1–10 are no longer kept");
  }
  const midway = base({ builder: { ...builder(null), reviewRounds: [round(5), round(6), round(8)] } });
  assert.deepEqual(
    cardTimeline(midway).filter((e) => e.id.startsWith("review-")).map((e) => [e.text, e.state, e.link]),
    [
      ["Rounds 1–4 weren't recorded", "empty", undefined],
      ["Round 5 · Codex · changes requested", "aborted", undefined],
      ["Round 6 · Codex · changes requested", "aborted", undefined],
      ["Round 7 wasn't recorded", "empty", undefined],
      ["Round 8 · Codex · changes requested", "aborted", undefined],
    ],
  );
  // Folded: the gap before the first shown round is still said.
  const gappy = base({ builder: { ...builder(null), reviewRounds: [1, 2, 4, 5, 6, 7].map((n) => round(n)) } });
  assert.deepEqual(
    cardTimeline(gappy).filter((e) => e.id.startsWith("review-")).map((e) => e.text).slice(0, 3),
    ["2 earlier review rounds", "Round 3 wasn't recorded", "Round 4 · Codex · changes requested"],
  );
  // A ledger that started over: older rounds keep their row, lose the link
  // (their ids name findings that are gone), and a line says so.
  assert.deepEqual(roundFindingIds({ newIds: ["F1"], closedIds: ["F1", "F2"] }, false), ["F1", "F2"]);
  assert.deepEqual(roundFindingIds({ newIds: ["F1"] }, true), []);
  const restarted = base({
    builder: {
      ...builder(null),
      reviewRounds: [round(1, { new: 1, newIds: ["F1"] }), round(2, { ledgerRound: 1, ledgerRestart: true, new: 1, newIds: ["F1"] })],
    },
  });
  assert.deepEqual(
    cardTimeline(restarted).filter((e) => e.id.startsWith("review-")).map((e) => [e.text, e.link?.findingIds]),
    [
      ["Round 1 · Codex · changes requested · 1 new", undefined],
      ["The findings of earlier rounds are no longer kept", undefined],
      ["Round 2 · Codex · changes requested · 1 new", ["F1"]],
    ],
  );
}
assert.equal(builderFact(base({ builder: builder() }), "codex"), "Claude");
assert.equal(builderFact(base(), "codex"), "Codex (not started)");
assert.equal(builderFact(base({ swarmTemplateId: "feature", linkedSwarmId: "sw-1" }), "claude"), "Several AIs");
// G4: a template on a Todo card that never ran a swarm is no runner.
assert.equal(builderFact(base({ swarmTemplateId: "feature", columnId: "todo" }), "claude"), "Claude (not started)");
// The vendor a Start build opens: the pick being saved, the card's saved
// choice, the Settings default, Claude — in that order.
assert.equal(effectiveBuilderVendor(undefined, base(), undefined), "claude");
assert.equal(effectiveBuilderVendor(undefined, base(), "codex"), "codex");
assert.equal(effectiveBuilderVendor(undefined, base({ builderVendorPref: "codex" }), "claude"), "codex");
assert.equal(effectiveBuilderVendor(undefined, base({ builderVendorPref: null }), "codex"), "codex");
assert.equal(effectiveBuilderVendor("claude", base({ builderVendorPref: "codex" }), "codex"), "claude");
assert.equal(effectiveBuilderVendor(undefined, undefined, undefined), "claude");
// The Builder property is the vendor picker until a build starts.
assert.equal(builderVendorChoosable(base()), true);
assert.equal(builderVendorChoosable(base(), "ready"), true);
assert.equal(builderVendorChoosable(base({ builder: builder() })), false);
assert.equal(builderVendorChoosable(base({ swarmTemplateId: "feature", linkedSwarmId: "sw-1" })), false);
assert.equal(builderVendorChoosable(base({ swarmTemplateId: "feature", columnId: "todo" })), true, "G4");
assert.equal(builderVendorChoosable(base({ agentConfigId: "a1" })), false);
assert.equal(builderVendorChoosable(base({ archived: true })), false);
assert.equal(builderVendorChoosable(base(), "shipped"), false);
// 1.172.0 (A2): how the Builder asks is chosen again before a new start —
// a closed session (Start fresh) or a card moved back — never while a
// session is open, and not where the card's copy is gone.
assert.equal(restartPermissionsChoosable(base({ builder: builder() })), true);
assert.equal(restartPermissionsChoosable(base({ builder: builder(), columnId: "todo" }), "ready"), true);
assert.equal(restartPermissionsChoosable(base()), false);
assert.equal(restartPermissionsChoosable(base({ builder: { ...builder(), ptyId: "pty-1" } })), false);
assert.equal(restartPermissionsChoosable(base({ builder: { ...builder(), startedAt: 0 } })), false);
assert.equal(restartPermissionsChoosable(base({ builder: builder(), shipStatus: "shipped" })), false);
assert.equal(restartPermissionsChoosable(base({ builder: builder(), reviewStatus: "merged" })), false);
assert.equal(restartPermissionsChoosable(base({ builder: builder(), archived: true })), false);
assert.equal(restartPermissionsChoosable(base({ builder: builder(), agentConfigId: "a1" })), false);
assert.equal(restartPermissionsChoosable(base({ builder: builder() }), "shipped"), false);

// ── The session in words (UX-6.3) ──────────────────────────────────────
const now = 10 * 60 * 60_000;
assert.equal(ago(30_000), "just now");
assert.equal(ago(12 * 60_000), "12m ago");
assert.equal(ago(3 * 60 * 60_000), "3h ago");
assert.equal(
  sessionSummary({ vendor: "claude", attention: "working", startedAt: now - 12 * 60_000, lastOutputAt: now - 60_000, filesChanged: null, now }),
  "Claude is working in the card's copy. Started 12m ago, last output 1m ago.",
);
assert.equal(
  sessionSummary({ vendor: "codex", attention: "asking-you", startedAt: now - 5 * 60_000, lastOutputAt: null, filesChanged: 4, now }),
  "Codex asks you something. Started 5m ago. 4 files changed so far.",
);
// Walk I6 (re-walk R2): idle at its prompt, its turn over, is not a question.
assert.equal(
  sessionSummary({ vendor: "claude", attention: "asking-you", turnIdle: true, startedAt: now - 5 * 60_000, lastOutputAt: null, filesChanged: null, now }),
  "Claude says it's done. Started 5m ago.",
);
assert.equal(
  sessionSummary({ vendor: "claude", attention: "asking-you", turnIdle: false, startedAt: now - 5 * 60_000, lastOutputAt: null, filesChanged: null, now }),
  "Claude asks you something. Started 5m ago.",
);
assert.match(
  sessionSummary({ vendor: "claude", attention: "wants-you", startedAt: now - 60 * 60_000, lastOutputAt: now - 20 * 60_000, filesChanged: 1, now }),
  /^Claude has gone quiet: it may be asking something\. Started 1h ago, last output 20m ago\. 1 file changed so far\.$/,
);
assert.match(
  sessionSummary({ vendor: "claude", attention: null, startedAt: now, lastOutputAt: null, filesChanged: null, now }),
  /session is not open here/,
);

// ── The timeline (UX-6.5): every recorded event, in order, one link ──────
const story = base({
  notes: "Land people where they were going.",
  intakeHistory: [
    { intakeId: "i0", startedAt: 1_100, concludedAt: 1_200, applied: false },
    { intakeId: "i1", startedAt: 1_300, concludedAt: 1_500, dispatchPrompt: "plan", transcriptPath: "t.log", applied: true },
  ],
  builder: {
    ...builder({ snapshotN: 2, provider: "codex", degraded: false, status: "done", verdict: "approve", at: 6_000 }),
    snapshots: [
      { n: 1, sha: "a", at: 3_000 },
      { n: 2, sha: "b", at: 5_000 },
    ],
  },
  verifyHistory: [
    { verifyRunId: "v1", status: "failed", endedAt: 3_500, steps: [{ kind: "t", passed: false, elapsedMs: 1 }] },
    { verifyRunId: "v2", status: "passed", endedAt: 5_500, steps: [{ kind: "t", passed: true, elapsedMs: 1 }] },
  ],
  shipHistory: [{ commitSha: "sha", shippedVersion: "1.150.0", releaseKind: "local", shippedAt: 7_000 }],
  archived: true,
  archivedAt: 8_000,
  autoArchived: true,
});
const events = cardTimeline(story);
assert.deepEqual(
  events.map((e) => e.text),
  [
    "You described the card",
    "Planning with Claude was cancelled",
    "Planned with Claude",
    "Claude started building",
    "Claude built it",
    "Checks failed · 0 of 1",
    "Claude built it again",
    "Checks passed · 1 of 1",
    "Codex reviewed it · approved",
    "Shipped in v1.150.0",
    "Archived by Plyloft, 14 days after it shipped",
  ],
);

// N18: the card's branch, deleted once its trash entry expired, is the last
// event; a branch still waiting, or kept, says nothing here.
const swept = cardTimeline({
  ...story,
  branchCleanup: {
    branch: "plyloft/card-abc-landing",
    tip: "fedcba9876543210",
    reason: "shipped",
    since: 7_000,
    outcome: "deleted",
    outcomeAt: 9_000,
  },
});
assert.equal(swept[swept.length - 1].text, "Branch plyloft/card-abc-landing deleted (was fedcba9)");
assert.equal(swept[swept.length - 1].at, 9_000);
assert.equal(swept[swept.length - 1].link, undefined);
for (const outcome of [null, "movedOn", "declined", "gone"] as const) {
  const kept = cardTimeline({ ...story, branchCleanup: { branch: "b", tip: "t", reason: "shipped", since: 1, outcome } });
  assert.equal(kept.length, events.length, `${outcome}: no branch row`);
}

// 1.174.0 C5 (P43, T45): a pull request's rows say "See the pull request";
// a merged one's ship row too; a ship on this computer "See what shipped".
{
  const pr = { number: 138, state: "open", checks: "passing", checksTotal: 2, checksPassed: 2, checksPending: 0, failingChecks: [], mergeable: "mergeable", reviewDecision: "none", openedAt: 5_000 };
  const open = cardTimeline(base({ prUrl: "https://github.com/o/r/pull/138", pr } as never));
  assert.deepEqual(open.find((e) => e.text === "Opened pull request #138")?.link, { kind: "ship", label: "See the pull request" });
  const merged = cardTimeline(
    base({
      prUrl: "https://github.com/o/r/pull/138",
      pr: { ...pr, state: "merged", mergeCommit: "m1" },
      shipHistory: [{ commitSha: "m1", shippedAt: 6_000 }],
    } as never),
  );
  assert.deepEqual(merged.find((e) => e.text === "Pull request #138 merged")?.link, { kind: "ship", label: "See the pull request" });
  assert.equal(merged.some((e) => e.link?.label === "See the ship"), false);
}
// T3 (team walk 2026-10-02): a GitHub-backed card starts as its issue —
// a teammate may have written it — and a local card keeps "you".
assert.equal(cardTimeline({ ...story, ghIssueNumber: 21 })[0].text, "Opened as issue #21");
assert.equal(cardTimeline({ ...story, ghIssueNumber: null })[0].text, "You described the card");
// 1.174.0 C4 (P17): a card made from a copy says so in Activity, not in
// its brief; its Now says where the work is, with "your checks", not Verify.
{
  const fromCopy = { id: "copy-1a2b3c4d", name: "win-copy-1" };
  assert.equal(cardTimeline({ ...story, notes: "", fromCopy })[0].text, "Made from the copy “win-copy-1” in Terminals");
  assert.equal(cardTimeline({ ...story, notes: "Keep two plans", fromCopy })[0].text, "Made from the copy “win-copy-1” in Terminals");
  const copyCard = { ...story, notes: "", columnId: "todo" as const, fromCopy };
  const line = nowFacts("draft", copyCard as never, { filesChanged: null, now: 0, copyChanges: { count: 3, files: ["a.html", "b.css", "c.ts"] } });
  assert.equal(
    line,
    "Made from the copy “win-copy-1”, with the work done there. 3 files changed: a.html, b.css, c.ts. Start build carries on with it; then the Reviewer and your checks look at it.",
  );
  assert.equal(nowFacts("draft", { ...copyCard, fromCopy: undefined } as never, { filesChanged: null, now: 0 }), null, "a title-only card keeps its own line");
}
// N14 (item 6): who opened the issue, when it is someone else; my own issue,
// an unknown author or an unknown login keep "Opened as issue #N".
const teammates = { ...story, ghIssueNumber: 21, ghAuthor: "test-user" };
assert.equal(
  cardTimeline(teammates, { login: "test-owner" })[0].text,
  "test-user described the card",
);
assert.equal(cardTimeline(teammates, { login: "Test-User" })[0].text, "Opened as issue #21");
assert.equal(cardTimeline(teammates)[0].text, "Opened as issue #21");
assert.equal(cardTimeline({ ...teammates, ghAuthor: null }, { login: "me" })[0].text, "Opened as issue #21");
assert.equal(
  cardTimeline({ ...teammates, ghIssueNumber: null }, { login: "me" })[0].text,
  "You described the card",
  "a local card is never someone else's issue",
);
// Ordered by time, oldest first.
for (let i = 1; i < events.length; i++) assert.ok(events[i - 1].at <= events[i].at);
// At most one link each; a detail's link sits on its latest event only.
assert.deepEqual(
  events.filter((e) => e.link).map((e) => [e.text, e.link!.label]),
  [
    ["Planned with Claude", "Read the plan"],
    ["Claude started building", "Open the Builder"],
    ["Claude built it again", "See the changes"],
    ["Checks passed · 1 of 1", "See the checks"],
    ["Codex reviewed it · approved", "Read the review"],
    // 1.174.0 C5 (T45): a ship on this computer says what it opens.
    ["Shipped in v1.150.0", "See what shipped"],
  ],
);
assert.equal(events.find((e) => e.text === "Planned with Claude")!.link!.intakeId, "i1");
// A restored card says it was archived, then restored.
assert.equal(
  cardTimeline(base({ archived: false, archivedAt: 9_000 })).slice(-1)[0].text,
  "Archived, then restored",
);
// A live session and a running review pulse.
const live = cardTimeline(
  base({
    builder: {
      ...builder({ snapshotN: 1, provider: "codex", degraded: false, status: "running", at: 4_000 }),
      ptyId: "pty",
    },
  }),
);
assert.ok(live.find((e) => e.text === "Claude started building")!.live);
assert.ok(live.find((e) => e.text === "Codex is reviewing the latest build")!.live);
// GH #305: no snapshot numbers in the story.
for (const e of [...events, ...live]) assert.doesNotMatch(e.text, /#\d/);
// GH #305: after Start fresh the session's start is newer than the builds;
// the building still starts before the first build, and the new session is
// its own event, after them.
const fresh = cardTimeline(
  base({
    builder: {
      vendor: "claude",
      bypass: false,
      ptyId: "pty",
      sessionLost: false,
      startedAt: 9_000,
      snapshots: [
        { n: 1, sha: "a", at: 3_000 },
        { n: 2, sha: "b", at: 5_000 },
      ],
    },
  }),
).map((e) => e.text);
assert.deepEqual(fresh.slice(1), [
  "Claude started building",
  "Claude built it",
  "Claude built it again",
  "Claude started again",
]);
// A card with no brief was just created.
assert.equal(cardTimeline(base())[0].text, "Card created");

// ── GH #253: the Now line as facts ──────────────────────────────────────
{
  const now = new Date(2026, 8, 24, 12, 0).getTime();
  const ctx = { filesChanged: 6, now };
  const ready = base({
    verifyStatus: "passed",
    builder: {
      vendor: "claude",
      bypass: false,
      ptyId: null,
      sessionLost: false,
      startedAt: 1,
      snapshots: [{ n: 1, sha: "a", at: 2 }],
      review: { snapshotN: 1, provider: "codex", degraded: false, status: "done", verdict: "approve", at: 3 },
    },
  });
  assert.equal(
    nowFacts("ready-to-ship", ready, ctx),
    "6 files changed. Checks passed and the Reviewer approved it.",
  );
  // Tier 4 walk 2026-10-14: an open finding under the threshold ("P1 only")
  // is said beside the approval; a dismissed one is not. 1.171.0 C3
  // (CF25): as small notes, the one approval word's.
  const finding = (id: string, severity: string, extra: object = {}) => ({
    id, severity, title: id, body: "", state: "open" as const, round: 1, updatedRound: 1, reason: null,
    blocking: false, ...extra,
  });
  const withLedger = (ledger: object[]) => ({
    ...ready,
    builder: { ...ready.builder!, review: { ...ready.builder!.review!, ledger } },
  }) as typeof ready;
  assert.equal(
    nowFacts("ready-to-ship", withLedger([finding("F1", "P2")]), ctx),
    "6 files changed. Checks passed and the Reviewer approved it (1 small note).",
  );
  assert.equal(
    nowFacts("ready-to-ship", withLedger([finding("F3", "P3"), finding("F1", "P2"), finding("F2", "P3")]), ctx),
    "6 files changed. Checks passed and the Reviewer approved it (3 small notes).",
  );
  assert.equal(
    nowFacts(
      "ready-to-ship",
      withLedger([
        finding("F1", "P2", { dismissal: { at: 1, round: 1 } }),
        finding("F2", "P3", { state: "closed" }),
      ]),
      ctx,
    ),
    "6 files changed. Checks passed and the Reviewer approved it.",
  );
  assert.equal(nowFacts("ready-to-ship", base(), { filesChanged: 1, now }), "1 file changed.");
  // GH #333: no checks set up is said as such, never "checks passed".
  assert.equal(
    nowFacts("ready-to-ship", { ...ready, verifyHistory: [{ verifyRunId: "v0", status: "passed", endedAt: 4, steps: [] }] }, ctx),
    "6 files changed. No checks are set up and the Reviewer approved it.",
  );
  assert.equal(
    nowFacts("shipped", base({ shipHistory: [{ commitSha: "s", shippedVersion: "1.150.0", releaseKind: "local", shippedAt: new Date(2026, 8, 23, 9).getTime() }] }), ctx),
    "Shipped in v1.150.0 on 23 Sep.",
  );
  assert.equal(
    nowFacts("shipped", base({ reviewStatus: "merged", prUrl: "https://github.com/o/r/pull/29" }), ctx),
    "Its pull request #29 was opened on GitHub.",
  );
  assert.equal(nowFacts("archived", base({ archivedAt: new Date(2025, 0, 2).getTime() }), ctx), "Archived on 2 Jan 2025.");
  // Why it stopped.
  assert.equal(nowFacts("failed", base({ lastRunStatus: "rate_limited" }), ctx), "The provider's rate limit stopped the run.");
  assert.equal(nowFacts("failed", base({ lastRunStatus: "aborted" }), ctx), "The run was stopped before it finished.");
  assert.equal(nowFacts("failed", base({ lastRunStatus: "failed" }), ctx), "The run failed.");
  assert.equal(nowFacts("draft", base(), ctx), null);
}

// ── When ────────────────────────────────────────────────────────────────
const at = new Date(2026, 8, 24, 9, 5).getTime();
assert.equal(timelineWhen(at, new Date(2026, 8, 24, 18, 0).getTime()), "09:05");
assert.equal(timelineWhen(at, new Date(2026, 8, 25, 8, 0).getTime()), "24 Sep 09:05");
assert.equal(timelineWhen(at, new Date(2027, 0, 2).getTime()), "24 Sep 2026");

// ── Errors (UX-6.8): the shape, the raw text only in details ────────────
for (const error of [
  cardActionError("Start build", new Error("git: worktree busy")),
  intakeStartError("spawn failed"),
  intakeStoppedError("Intake agent exited unexpectedly (code 1). Cancel and retry."),
  loadFailedError("The diff", "fatal: bad revision"),
  dismissFailedError("EACCES"),
  releaseAuditError("git: not a repository"),
  releaseFailedError("Fix login redirect", "git push origin main failed: denied"),
  releaseFailedError(
    "Fix login redirect",
    "Atelier isn't set up for Plyloft's builds yet, so Plyloft doesn't know which branch to work from. Nothing was shipped. Open Settings › This repository › Build and release and press Re-detect, then ship again.",
  ),
]) {
  assert.ok(error.title.endsWith("."), error.title);
  assert.ok(error.happened && error.untouched && error.todo);
  assert.ok(error.actions.length <= 2);
  assert.ok(error.actions.filter((a) => a.primary).length <= 1);
  assert.ok(error.details, "the raw reason is kept for Details");
  for (const part of [error.title, error.happened, error.untouched, error.todo]) {
    assert.ok(!part.includes(error.details!), `raw text stays under Details: ${part}`);
  }
}
assert.equal(
  intakeStoppedError("Intake auto-cancelled after 30 minutes of inactivity.").happened,
  "The conversation was closed after 30 minutes without an answer.",
);
// N14 walk F14: a card still planning says it in its Now box (Plan again,
// Cancel intake); the block is for a card no longer planning.
assert.deepEqual(
  intakeStoppedError("x").actions.map((a) => a.label),
  ["Dismiss"],
);

// GH #257: a run's start time in words, never "a short while".
assert.equal(runStartedWords(1_000, 1_000 + 12 * 60_000), "Started 12m ago.");
assert.equal(runStartedWords(null, 5), "It is running now.");

// GH #262: the failures, of the total, with the plural right.
const step = (passed: boolean) => ({ passed });
assert.equal(checksFailedWords([step(true), step(false), step(false)]), "2 of 3 checks failed.");
assert.equal(checksFailedWords([step(false)]), "1 check failed.");
assert.equal(checksFailedWords([step(true), step(false)]), "1 of 2 checks failed.");
assert.equal(checksFailedWords([]), "The checks failed.");
assert.equal(checksRunningWords(1), "Plyloft is running 1 check.");
assert.equal(checksRunningWords(14), "Plyloft is running 14 checks.");
assert.equal(checksRunningWords(0), "Plyloft is running the checks.");

// GH #304: a landed card with no Builder, checks or review on record says
// so, rather than a step to come or a clean review.
{
  const landed = base({ reviewStatus: "merged", prUrl: "https://github.com/o/r/pull/9" });
  assert.equal(builderFact(landed, "claude", "shipped"), "Not recorded");
  assert.deepEqual(checksFact(landed, "shipped"), { word: "Not recorded", state: "empty" });
  assert.deepEqual(reviewFact(landed, "shipped"), { word: "Not recorded", state: "empty" });
  assert.deepEqual(reviewFact(landed), { word: "Not recorded", state: "empty" });
  assert.equal(builderFact(base(), "claude", "archived"), "Not recorded");
  // Work still to come keeps its words.
  assert.equal(builderFact(base(), "claude", "ready"), "Claude (not started)");
  assert.equal(checksFact(base(), "ready").word, "Not run yet");
  assert.equal(reviewFact(base(), "ready").word, "Not reviewed yet");
}

// GH #306: a merge conflict is named in plain words; git's text is Details.
const GIT =
  "git merge failed: CONFLICT (content): Merge conflict in src/lib/settingsSearch.ts\nAutomatic merge failed; fix conflicts and then commit the result.";
assert.deepEqual(mergeConflictPaths(GIT), ["src/lib/settingsSearch.ts"]);
assert.equal(mergeConflictPaths("ship aborted: staging and origin/staging have diverged"), null);
{
  const conflict = cardActionError("Ship it", GIT);
  assert.match(conflict.title, /^Ship it stopped: the card's changes conflict with your main branch on this Mac\.$/);
  assert.match(conflict.happened, /conflict in src\/lib\/settingsSearch\.ts\./);
  assert.equal(conflict.details, GIT);
  for (const part of [conflict.title, conflict.happened, conflict.untouched, conflict.todo]) {
    assert.doesNotMatch(part, /Automatic merge failed/);
  }
  const many = cardActionError("Ship it", `${GIT}\nCONFLICT (content): Merge conflict in a.ts`);
  assert.match(many.happened, /in 2 files\./);
}
// Anything else keeps the generic words.
assert.equal(cardActionError("Ship it", "denied").title, "Ship it didn't go through.");
// 1.169.1 (R11): a pull request's push and gh failures go through plainCause,
// with the way on; git's and gh's text stays under Details.
{
  const PUSH_403 =
    "couldn't push the branch to the remote: git push origin card/x failed: remote: Permission to o/lyra.git denied to bob.\n" +
    "fatal: unable to access 'https://github.com/o/lyra.git/': The requested URL returned error: 403";
  const signIn = cardActionError("Ship it", PUSH_403, { retry: true, github: true });
  assert.equal(signIn.title, "Ship it didn't go through.");
  assert.equal(signIn.happened, plainCause(PUSH_403));
  // R11 (Challenger): a 403 "Permission to … denied to" is this account's
  // access — another account may have it, so Sign in to GitHub stays.
  assert.equal(signIn.happened, "This GitHub account can't push to or merge in this repository.");
  assert.deepEqual(signIn.actions.map((a) => a.id), [GITHUB_SIGN_IN_ACTION.id, "dismiss"]);
  assert.equal(signIn.actions[0].label, "Sign in to GitHub");
  assert.equal(signIn.details, PUSH_403);
  for (const part of [signIn.title, signIn.happened, signIn.untouched, signIn.todo]) assert.doesNotMatch(part, /403|fatal/);
  const moved = cardActionError(
    "Ship it",
    "couldn't push the branch to the remote: git push origin card/x failed: ! [rejected] card/x -> card/x (non-fast-forward)",
    { retry: true },
  );
  assert.equal(moved.happened, "The branch on GitHub has commits this card doesn't.");
  assert.deepEqual(moved.actions.map((a) => a.id), ["dismiss"], "no force, no rebase, no Try again");
  assert.doesNotMatch(moved.todo, /force|rebase/i);
  const big = cardActionError(
    "Ship it",
    "remote: error: File out/app.dmg is 150.00 MB; this exceeds GitHub's file size limit of 100.00 MB\nremote: error: GH001: Large files detected.",
  );
  assert.equal(big.happened, "GitHub refuses files over 100 MB: out/app.dmg.");
  assert.equal(big.todo, "Take it out of the card's commits and add it to .gitignore, then press Ship it again.");
  const bigBuilder = cardActionError(
    "Ship it",
    "remote: error: File out/app.dmg is 150.00 MB; this exceeds GitHub's file size limit of 100.00 MB\nremote: error: GH001: Large files detected.",
    { builder: true },
  );
  assert.equal(
    `${bigBuilder.happened} ${bigBuilder.todo}`,
    "GitHub refuses files over 100 MB: out/app.dmg. Ask the Builder to take it out of the card's commits and add it to .gitignore, then press Ship it again.",
  );
  const prot = cardActionError("Ship it", "opening the pull request failed: remote: error: GH006: Protected branch update failed");
  assert.equal(prot.happened, "This branch is protected on GitHub.");
  // gh missing: as before (the doctor's own sentence under the generic words).
  assert.equal(cardActionError("Ship it", "spawn gh ENOENT").happened, "Plyloft couldn't finish “Ship it”.");
  // U16: never "Press Resume again" when Resume can only find nothing again.
  const noConversation = cardActionError(
    "Resume",
    "Couldn't find this card's Codex conversation, so Resume can't continue it. Start fresh opens a new session in this card's folder with the brief sent again; the work so far stays.",
  );
  assert.equal(noConversation.happened, "Couldn't find this card's Codex conversation, so Resume can't continue it.");
  assert.match(noConversation.todo ?? "", /^Press Start fresh/);
  assert.doesNotMatch(noConversation.todo ?? "", /Resume again/);
}
// 1.171.0 B3 (DL-27): a protected branch, a rule or a branch that moved on
// offers Open on GitHub beside Dismiss — the rules page, or the branch.
{
  const page = { repo: "o/lyra", branch: "plyloft/card-1-x" };
  const prot = cardActionError("Ship it", "remote: error: GH006: Protected branch update failed", { github: true, githubPage: page });
  assert.deepEqual(prot.actions.map((a) => [a.id, a.label, a.url]), [
    ["open-github", "Open on GitHub", "https://github.com/o/lyra/branches"],
    ["dismiss", "Dismiss", undefined],
  ]);
  const rules = cardActionError("Ship it", "remote: error: GH013: Repository rule violations found for refs/heads/x.", {
    github: true,
    githubPage: page,
  });
  assert.equal(rules.actions[0].url, "https://github.com/o/lyra/rules");
  const moved = cardActionError("Ship it", " ! [rejected] x -> x (fetch first)", { github: true, githubPage: page });
  assert.equal(moved.actions[0].url, "https://github.com/o/lyra/tree/plyloft/card-1-x");
  assert.equal(
    cardActionError("Ship it", " ! [rejected] x -> x (fetch first)", { github: true, githubPage: { repo: "o/lyra" } }).actions[0].url,
    "https://github.com/o/lyra/branches",
  );
  // No repository to name: Dismiss alone, as before. A sign-in keeps its own.
  assert.deepEqual(
    cardActionError("Ship it", "remote: error: GH006: Protected branch update failed", { github: true, githubPage: { repo: null } }).actions.map((a) => a.id),
    ["dismiss"],
  );
  assert.deepEqual(
    cardActionError("Ship it", "HTTP 401: Bad credentials", { github: true, githubPage: page }).actions.map((a) => a.id),
    [GITHUB_SIGN_IN_ACTION.id, "dismiss"],
  );
  assert.equal(githubRefusalPage("large-file", "o/lyra"), null);
  assert.equal(githubRefusalPage("protected", "not a slug"), null);
}
// 1.171.0 B3 (errors mid-flow): the push reached GitHub, the pull request
// didn't open — said so, with Open the pull request (the same ship again).
{
  const NET = "opening the pull request failed: error connecting to api.github.com\ncould not resolve host: api.github.com";
  const e = cardActionError("Ship it", NET, { retry: true, github: true });
  assert.equal(e.title, "Ship it stopped before the pull request opened.");
  assert.equal(e.happened, "The card's work reached GitHub, but its pull request didn't open. The network didn't answer.");
  assert.equal(e.untouched, "Nothing was merged, and the card isn't marked shipped.");
  assert.equal(e.todo, "When GitHub answers again, press Open the pull request.");
  assert.deepEqual(e.actions.map((a) => [a.id, a.label]), [
    ["retry", "Open the pull request"],
    ["dismiss", "Dismiss"],
  ]);
  assert.equal(e.details, NET);
  const timedOut = cardActionError("Ship it", "opening the pull request failed: `gh pr create` did not finish within 20 s", { github: true });
  assert.match(timedOut.happened, /didn't open\. It took too long and was stopped\.$/);
  assert.equal(timedOut.todo, "When GitHub answers again, press Ship it again; it opens the pull request.");
  assert.deepEqual(timedOut.actions.map((a) => a.id), ["dismiss"]);
  // A sign-in refused when opening it keeps its own way on.
  assert.equal(
    cardActionError("Ship it", "opening the pull request failed: HTTP 401: Bad credentials", { github: true }).actions[0].id,
    GITHUB_SIGN_IN_ACTION.id,
  );
  assert.equal(prOpenFailure("couldn't push the branch to the remote: x"), null);
  // Challenger 2: a pull request press's titles say "The pull request".
  const prPress = { retry: true, github: true, name: "The pull request" };
  assert.equal(cardActionError("On GitHub, pull request only (I merge it)", NET, prPress).title, "Ship stopped before the pull request opened.");
  assert.equal(cardActionError("On GitHub, pull request only (I merge it)", "gh: boom", prPress).title, "The pull request didn't open.");
  assert.equal(
    cardActionError("On GitHub, pull request only (I merge it)", "remote: error: GH006: Protected branch update failed", prPress).title,
    "The pull request didn't open.",
  );
  assert.equal(cardActionError("Only on this Mac", "boom", { name: "Only on this Mac" }).title, "Only on this Mac didn't go through.");
}
// R11 (Challenger): only a GitHub press, or text that names GitHub, is read
// as GitHub's — Claude's "not logged in" on Start build or Resume is not.
{
  const CLAUDE = "Claude is not logged in on this machine (Please run /login). Open Claude in a terminal tile, sign in, then try again.";
  for (const press of ["Start build", "Resume"]) {
    const e = cardActionError(press, CLAUDE, { retry: true });
    assert.equal(e.happened, `Plyloft couldn't finish “${press}”.`, press);
    assert.ok(!e.actions.some((a) => a.id === GITHUB_SIGN_IN_ACTION.id), press);
    assert.doesNotMatch(`${e.happened} ${e.todo}`, /GitHub/);
  }
  // gh's bare "HTTP 401" counts on a GitHub press only.
  assert.equal(cardActionError("Merge", "HTTP 401: Bad credentials").happened, "Plyloft couldn't finish “Merge”.");
  const merge = cardActionError("Merge", "HTTP 401: Bad credentials", { github: true });
  assert.equal(merge.happened, "GitHub didn't accept the sign-in.");
  assert.deepEqual(merge.actions.map((a) => a.id), [GITHUB_SIGN_IN_ACTION.id, "dismiss"]);
  // Text that names GitHub is GitHub's whatever the press.
  assert.equal(
    cardActionError("Start build", "fatal: Authentication failed for 'https://github.com/o/lyra.git/'").happened,
    "GitHub didn't accept the sign-in.",
  );
  // GH013's push protection: a secret, not a protected branch.
  const SECRET =
    "remote: error: GH013: Repository rule violations found for refs/heads/card/x.\nremote: - GITHUB PUSH PROTECTION\nremote:     - Push cannot contain secrets";
  const secret = cardActionError("Ship it", SECRET, { github: true, builder: true });
  assert.equal(
    `${secret.happened} ${secret.todo}`,
    "GitHub found a secret in the card's commits. Ask the Builder to take it out of the card's commits, then press Ship it again.",
  );
  assert.equal(
    cardActionError("Ship it", SECRET, { github: true }).todo,
    "Take it out of the card's commits, then press Ship it again.",
  );
  assert.equal(
    cardActionError("Ship it", "remote: error: GH013: Repository rule violations found for refs/heads/card/x.", { github: true }).happened,
    "GitHub's rules for this repository refused the push.",
  );
  // An SSH key GitHub didn't take: no Sign in to GitHub (the key is the way).
  const key = cardActionError("Ship it", "git@github.com: Permission denied (publickey).", { github: true });
  assert.equal(key.happened, "GitHub didn't accept this Mac's SSH key.");
  assert.match(key.todo, /SSH key/);
  assert.deepEqual(key.actions.map((a) => a.id), ["dismiss"]);
  // A rate limit's 403 is a wait, not a sign-in.
  const limit = cardActionError("Ship it", "HTTP 403: API rate limit exceeded for user ID 1.", { github: true });
  assert.equal(limit.happened, "GitHub is limiting requests right now; try again in a few minutes.");
  assert.deepEqual(limit.actions.map((a) => a.id), ["dismiss"]);
  // Neutral words for a branch with commits the card lacks.
  const moved = cardActionError("Ship it", "To https://github.com/o/r.git\n ! [rejected] card/x -> card/x (fetch first)", { github: true });
  assert.doesNotMatch(`${moved.happened} ${moved.todo}`, /someone else|moved on/);
}

// H6b (Windows walk): a skill card's pull request that would carry local
// commits says the refusal on the card, nothing in Details, and the way on.
{
  const RUST =
    "This skill card starts from your local walk-1014, which has 2 commits GitHub's walk-1014 doesn't. " +
    "A pull request from it would carry them too, so nothing was shipped. Publish walk-1014, then ship again.";
  assert.deepEqual(skillPrLocalRefusal(RUST), {
    branch: "walk-1014",
    said: RUST.replace(" Publish walk-1014, then ship again.", ""),
  });
  const refused = cardActionError("Ship it", RUST);
  assert.equal(refused.title, "Ship it stopped: this skill card starts from your local walk-1014.");
  assert.ok(refused.happened.startsWith("This skill card starts from your local walk-1014, which has 2 commits"), refused.happened);
  assert.equal(refused.details, null);
  assert.match(refused.todo, /^Press Ship it to land the card on your local walk-1014, where it starts\./);
  assert.match(refused.todo, /publish walk-1014 to GitHub first/);
  assert.doesNotMatch(refused.happened + refused.todo, /Mac|PC/);
  // With the preflight's sentence before it (Here moved), and one commit.
  const moved = `Its copy here changed since it was made. ${RUST.replace("2 commits", "1 commit")}`;
  assert.equal(skillPrLocalRefusal(moved)?.said.startsWith("Its copy here changed"), true);
  assert.equal(skillPrLocalRefusal("This skill card starts from your local main, which is fine."), null);
  assert.equal(skillPrLocalRefusal("denied"), null);
}

// A Ship refused because the repository was never set up offers `Set up`;
// any other failure offers nothing Ply can do.
assert.deepEqual(
  releaseFailedError(
    "Fix login redirect",
    "Atelier isn't set up for Plyloft's builds yet. Nothing was shipped. Open Settings › This repository › Build and release and press Re-detect, then ship again.",
  ).actions,
  [{ id: SET_UP_ACTION, label: "Set up", primary: true }],
);
assert.deepEqual(releaseFailedError("x", "denied").actions, []);
assert.deepEqual(
  releaseFailedError(
    "x",
    "Atelier isn't set up for Plyloft's builds yet. Nothing was shipped. Its settings are shared and this account can't write to the repository: someone with write access has to press Re-detect in Settings › This repository › Build and release and publish; then ship again.",
  ).actions,
  [],
);

// CL-11 (Windows walk): a start refused for setup stays on the card with Set up.
{
  const e = startNeedsSetUpError("Build with both", "Sandbox isn't set up for Plyloft's builds yet");
  assert.equal(e.title, "Build with both didn't start: this repository isn't set up yet.");
  assert.equal(e.todo, "Set up this repository, then press Build with both.");
  assert.deepEqual(e.actions.map((a) => a.id), ["set-up", "dismiss"]);
  assert.equal(e.actions[0].primary, true);
  assert.match(e.details ?? "", /isn't set up/);
}

// N14 walk F19: a card put back in To do — the Now box says its branch keeps
// the work, and the Activity has one row per put back.
{
  const now = 10_000;
  const back = base({ columnId: "todo", putBacks: [3_000, 6_000], branchName: "plyloft/card-c1", worktreePath: "/w/c1" });
  assert.equal(nowFacts("ready", back, { filesChanged: null, now }), PUT_BACK_NOW);
  assert.equal(PUT_BACK_NOW, "Moved back to Ready to start — its branch keeps the work; Start build picks it up again.");
  // Never put back, or nothing recorded to pick up: the state's own sentence.
  assert.equal(nowFacts("ready", base({ branchName: "b" }), { filesChanged: null, now }), null);
  assert.equal(nowFacts("ready", base({ putBacks: [3_000] }), { filesChanged: null, now }), null);
  const rows = cardTimeline(back).filter((e) => e.text === "Moved back to Ready to start");
  assert.deepEqual(rows.map((e) => e.at), [3_000, 6_000]);
  assert.equal(new Set(rows.map((e) => e.id)).size, 2);
}

// N14 walk F20: a conversation ended by Plan again is "Planned again", not a
// cancel; a real cancel keeps its words.
{
  const rec = (id: string, at: number, extra: object = {}) => ({
    intakeId: id,
    startedAt: at,
    concludedAt: at + 1,
    applied: false,
    vendor: "claude" as const,
    ...extra,
  });
  const texts = cardTimeline(
    base({ intakeHistory: [rec("i1", 2_000, { replanned: true }), rec("i2", 3_000)] }),
  ).map((e) => e.text);
  assert.ok(texts.includes("Planned again"));
  assert.equal(texts.filter((t) => t === "Planning with Claude was cancelled").length, 1);
  // The newest record, replanned, with the new conversation live: Planned again.
  const live = cardTimeline(base({ intakeStatus: "active", intakeHistory: [rec("i1", 2_000, { replanned: true })] }));
  assert.ok(live.some((e) => e.text === "Planned again"));
  // Plan again whose new conversation never started: no claim of it.
  const failed = cardTimeline(base({ intakeStatus: "none", intakeHistory: [rec("i1", 2_000, { replanned: true })] })).map((e) => e.text);
  assert.ok(!failed.includes("Planned again"));
  assert.ok(failed.includes("Planning with Claude stopped"));
}

// N14 walk F18: a Resume refused on a card in To do says why and the way back.
{
  const e = cardActionError("Resume", new Error(PUT_BACK_SESSION_WORDS));
  assert.equal(e.happened, PUT_BACK_SESSION_WORDS);
  assert.equal(e.todo, "Press Start build.");
  assert.doesNotMatch(`${e.title} ${e.todo}`, /Try again/);
}

// 1.168.1 B1: a failed Finish planning asks again by the button's name.
{
  const e = intakeConcludeError("Finish planning timed out — x", "claude");
  assert.equal(e.actions?.[0]?.label, "Finish planning again");
  assert.match(e.todo ?? "", /^Finish planning again, or keep talking/);
  assert.doesNotMatch(JSON.stringify(e), /Conclude/);
}


// Skills hub H3a walk: a ship with no recorded version says Shipped, never "vunknown".
assert.equal(shippedWords("unknown"), null);
assert.equal(shippedWords(""), null);
assert.equal(shippedWords("1.2.3"), "v1.2.3");
assert.equal(shippedWords("v1.2.3"), "v1.2.3");

// UX P-A Windows walk 1: a Ship the target's uncommitted changes refused is
// said on the card in words, never as the typed payload.
{
  const payload = { totalCount: 2, paths: ["a.txt", "b.txt"], truncated: false };
  const dirty = cardActionError("Ship it", `PLY_TARGET_DIRTY_V1:${JSON.stringify(payload)}`);
  assert.equal(dirty.title, "Ship it stopped: your project folder has changes that aren't in a commit.");
  assert.equal(dirty.happened, "Your project folder has 2 changed files that aren't in a commit, so Plyloft won't ship into it. Commit them or undo them, then ship again.");
  assert.equal(dirty.details, "a.txt\nb.txt");
  assert.ok(!JSON.stringify(dirty).includes("PLY_TARGET_DIRTY"));
}

// R6: a release that stopped. The project folder's own changes are Land's
// refusal and ways out; a conflict says the folder is back and offers the
// Builder; any other stop after the merge began says the folder is back.
{
  const dirty = 'PLY_TARGET_DIRTY_V1:{"totalCount":1,"paths":["README.md"],"truncated":false}';
  const withBuilder = releaseFailedError("Fix login", dirty, { builder: true });
  assert.equal(withBuilder.title, "Release stopped: your project folder has changes that aren't in a commit.");
  assert.deepEqual(withBuilder.actions.map((a) => a.id), ["ask-commit", "dismiss"]);
  assert.equal(withBuilder.actions[0].label, "Ask the Builder to commit them");
  assert.deepEqual(releaseFailedError("Fix login", dirty).actions.map((a) => a.id), ["show-files", "dismiss"]);

  const raw =
    "Plyloft couldn't merge “Fix login” (plyloft/card-1-fix) into main: it conflicts with main in README.md, src/a b.ts. " +
    "Nothing was released, and your project folder is as it was. " +
    'Changes saved in the project folder while the release ran are kept in your stash list ("Plyloft: changes made while the release ran"). ' +
    "Your project folder was first brought up to date with the online main. " +
    "Open the card and press Fix with the Builder. Git said: git merge --squash plyloft/card-1-fix failed: Automatic merge failed";
  assert.deepEqual(releaseConflict(raw), {
    title: "Fix login",
    branch: "plyloft/card-1-fix",
    target: "main",
    files: "README.md, src/a b.ts",
    builder: true,
  });
  assert.equal(releaseConflict("Plyloft couldn't merge x into main: boom"), null);
  // Anchored: the sentence quoted inside another error is not a conflict.
  assert.equal(releaseConflict(`ship aborted: ${raw}`), null);
  const asked = releaseFailedError("Fix login", raw, { resolve: true });
  assert.equal(asked.title, "The release didn't go through: main changed the same lines as this card.");
  assert.equal(
    asked.untouched,
    `${RELEASE_ROLLED_BACK_WORDS} Changes saved in the project folder while the release ran are kept in your stash list ("Plyloft: changes made while the release ran"). Your project folder was first brought up to date with the online main. The card's work is safe in its copy.`,
  );
  assert.ok(!asked.todo.includes("in the card's copy"), asked.todo);
  assert.deepEqual(asked.actions.map((a) => [a.id, a.label]), [
    ["ask-resolve", "Fix with the Builder"],
    ["dismiss", "Dismiss"],
  ]);
  assert.equal(asked.details, raw);
  const byHand = releaseFailedError("Fix login", raw);
  assert.equal(byHand.todo, "Resolve it in the card's copy, then release again.");
  assert.deepEqual(byHand.actions.map((a) => a.id), ["dismiss"]);

  const stopped = releaseFailedError("Fix login", `git tag v1.0.1 failed: cannot lock ref. ${RELEASE_ROLLED_BACK_WORDS}`);
  assert.equal(stopped.untouched, `The card is not shipped. ${RELEASE_ROLLED_BACK_WORDS}`);

  // The words are the backend's (`ship::ROLLED_BACK_WORDS`, `roll_back_release`).
  const ship = readFileSync(new URL("../../src-tauri/src/ship.rs", import.meta.url), "utf8");
  assert.ok(ship.includes(`"${RELEASE_ROLLED_BACK_WORDS}"`), "ship.rs's ROLLED_BACK_WORDS");
  assert.ok(ship.includes('"Plyloft couldn\'t merge “{title}” ({branch}) into {target}: it conflicts with {target} in {}. {after} {todo} Git said: {said}"'));
  assert.ok(ship.includes('"Open the card and press Fix with the Builder."'), "ship.rs's ASK_BUILDER_WORDS");
  assert.ok(ship.includes('"Plyloft: changes made while the release ran"'));
  assert.ok(ship.includes('" Your project folder was first brought up to date with the online {target}."'));
  assert.ok(ship.includes('" Changes saved in the project folder while the release ran are kept in your stash list (\\"{KEPT_EDITS_STASH}\\")."'));
}

// R8: one of Plyloft's commits refused by the project's hook, or stopped at
// its bound — said as such, with Ask the Builder when the card has one.
{
  const hookRaw = "A hook in this project refused the commit:\nlint: 2 problems\nsrc/a.ts:1 no-unused-vars\n\nNothing was committed.";
  const asked = cardActionError("Ship it", hookRaw, { retry: true, fix: true });
  assert.equal(asked.title, "Ship it stopped: a hook in this project refused the commit.");
  assert.equal(asked.happened, "The hook said:\nlint: 2 problems\nsrc/a.ts:1 no-unused-vars");
  assert.deepEqual(asked.actions.map((a) => a.id), ["ask-hook", "dismiss"]);
  assert.equal(asked.actions[0].label, "Ask the Builder");
  const byHand = cardActionError("Ship it", hookRaw, { retry: true });
  assert.deepEqual(byHand.actions.map((a) => a.id), ["dismiss"]);
  assert.equal(byHand.todo, "Fix what the hook reports, then try again.");
  // A hook's output naming a conflict is still the hook's refusal.
  assert.match(cardActionError("Ship it", hookRaw.replace("lint", "CONFLICT (content): Merge conflict in a")).title, /a hook in this project/);

  const timeoutRaw = "Committing took too long — a hook or a signing prompt in this project may be waiting. Nothing was committed.";
  const late = cardActionError("Ship it", timeoutRaw, { retry: true, fix: true });
  assert.equal(late.title, "Ship it stopped: committing took too long.");
  assert.deepEqual(late.actions.map((a) => a.id), ["retry", "dismiss"]);
  assert.equal(commitStopError("Ship it", "git push failed"), null);

  const release = releaseFailedError("Fix login", `${hookRaw} ${RELEASE_ROLLED_BACK_WORDS}`, { fix: true });
  assert.equal(release.title, "Release stopped: a hook in this project refused the commit.");
  assert.equal(release.happened, "The hook said:\nlint: 2 problems\nsrc/a.ts:1 no-unused-vars");
  assert.ok(release.untouched.startsWith(RELEASE_ROLLED_BACK_WORDS), release.untouched);
  assert.equal(release.todo, "Ask the Builder to fix what the hook reports, then press Finish and check, and release again.");

  // The words are the backend's (`git::HOOK_REFUSED_WORDS`, …).
  const git = readFileSync(new URL("../../src-tauri/src/git.rs", import.meta.url), "utf8");
  assert.ok(git.includes('"A hook in this project refused the commit:"'));
  assert.ok(git.includes('"Committing took too long — a hook or a signing prompt in this project may be waiting. Nothing was committed."'));
  assert.ok(git.includes('"Nothing was committed."'));
  assert.ok(git.includes('format!("{HOOK_REFUSED_WORDS}\\n{said}\\n\\n{NOTHING_COMMITTED_WORDS}")'));
}

// 1.174.0 (C2, BCI-11): Change… says what it opens — the people as
// before, then the area and the blockers it now also holds.
{
  assert.equal(
    changeChoicesTitle({ people: true, area: false, blockers: false }),
    "Who builds and reviews this card, how the Builder asks you, and their models.",
  );
  assert.equal(
    changeChoicesTitle({ people: true, area: true, blockers: true }),
    "Who builds and reviews this card, how the Builder asks you, their models, its area, and the cards it waits for.",
  );
  assert.equal(changeChoicesTitle({ people: false, area: true, blockers: true }), "This card's area and the cards it waits for.");
  assert.equal(changeChoicesTitle({ people: false, area: false, blockers: true }), "The cards this card waits for.");
  assert.equal(changeChoicesTitle({ people: false, area: false, blockers: false }), null);
}

// 1.174.0 (C1, P8): a built card's brief folds to its first line.
{
  assert.equal(BRIEF_FOLD_TITLE, "What you asked");
  assert.equal(briefFirstLine("Change the paragraph.\nAnd more."), "Change the paragraph.");
  assert.equal(briefFirstLine("\n## Expected\n- Copy the line"), "Expected");
  assert.equal(briefFirstLine("  \n- Copy the line\n"), "Copy the line");
  assert.equal(briefFirstLine("1. First step"), "First step");
  assert.equal(briefFirstLine(""), null);
  assert.equal(briefFirstLine("  \n #  \n"), null);
  assert.equal(briefFirstLine(undefined), null);
  // Challenger 3: fences, rules and comments are skipped; quotes, tasks
  // and bold are stripped; a long line is cut with "…".
  assert.equal(briefFirstLine("```ts\nconst a = 1;\n```\nThen the ask"), "Then the ask");
  assert.equal(briefFirstLine("---\n***\nAfter the rule"), "After the rule");
  assert.equal(briefFirstLine("<!-- plyloft:claim x -->\nThe ask"), "The ask");
  assert.equal(briefFirstLine("> Quoted ask"), "Quoted ask");
  assert.equal(briefFirstLine("- [ ] Task one"), "Task one");
  assert.equal(briefFirstLine("- [x] Done one"), "Done one");
  assert.equal(briefFirstLine("**Bold ask**"), "Bold ask");
  assert.equal(briefFirstLine("## **Expected**"), "Expected");
  const long = briefFirstLine("word ".repeat(60))!;
  assert.ok(long.length <= 160 && long.endsWith("…"), long);
}

console.log("cardPage: all assertions passed");
