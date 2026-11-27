// SL-1: what a card says about its pull request on GitHub. Run with
//   node --experimental-strip-types src/lib/prStatus.test.ts
import assert from "node:assert/strict";
import { machineWords, setPlatformForTests } from "./platform.ts";
import type { KanbanCard, PrStatus } from "../ipc.ts";
import {
  carriesLocalCommitsQuestion,
  landedCardTitles,
  checkLabel,
  githubChecksFact,
  shipEntryPullRequest,
  shippedResultLine,
  whatShippedName,
  openPrBoard,
  prCheckedWords,
  prClosed,
  prInboxDetail,
  prMerged,
  prNowFact,
  prOpen,
  prShipLine,
  refreshOnOpen,
  autoMergeRefusedWords,
  prAutoMergeLine,
  mergeMethodLabel,
  prMergeOffered,
  prFactsKey,
  prReadyToMerge,
  prCardReadyToMerge,
  prWaitsForReview,
  PR_READY_NO_CHECKS_DETAIL,
  prHeadMoved,
  prAutoMergeHeldLine,
  prMergeBlocked,
  PR_HEAD_MOVED_LINE,
  PR_HEAD_MOVED_LABEL,
  AUTO_MERGE_HELD_LINE,
  AUTO_MERGE_TURNED_OFF_LINE,
  AUTO_MERGE_RESUMED_LINE,
  BRING_UP_TO_DATE_ACTION,
  branchKeptLine,
  upToDateRefusedLine,
} from "./prStatus.ts";
import { recordInboxGroup } from "./cardPresentation.ts";
import {
  attentionColumnFor,
  boardCardFact,
  cardAttentionSignals,
  deriveAttentionColumn,
} from "./boardSemantics.ts";
import { deriveBoardCardState } from "./cardPresentation.ts";
import { cardTimeline, nowFacts } from "./cardPage.ts";
import { inboxRowWords } from "./inboxView.ts";
import { cardLanded, cardShippedOrPrOpen, mergedWithoutRelease } from "./cardLifecycle.ts";

const URL = "https://github.com/o/r/pull/12";

const pr = (patch: Partial<PrStatus> = {}): PrStatus => ({
  number: 12,
  state: "open",
  checks: "passing",
  checksTotal: 2,
  checksPassed: 2,
  checksPending: 0,
  failingChecks: [],
  mergeable: "mergeable",
  reviewDecision: "none",
  openedAt: 1_000,
  checkedAt: 2_000,
  ...patch,
});

const card = (patch: Partial<KanbanCard> = {}): KanbanCard => ({
  id: "c1",
  workspaceId: "ws",
  title: "Add sum",
  columnId: "in_progress",
  createdAt: 1,
  updatedAt: 1,
  lastRunStatus: "success",
  verifyStatus: "passed",
  reviewStatus: "merged",
  prUrl: URL,
  pr: pr(),
  ...patch,
});

// ── The pull request's state ──────────────────────────────────────────
assert.equal(prOpen(card()), true);
assert.equal(prOpen(card({ pr: pr({ state: "merged" }) })), false);
assert.equal(prOpen(card({ pr: null })), false, "shipped before SL-1: not known open");
assert.equal(prMerged(card({ pr: pr({ state: "merged" }) })), true);
assert.equal(prClosed(card({ pr: pr({ state: "closed" }), reviewStatus: "pending" })), true);
assert.equal(prClosed(card({ pr: pr({ state: "closed" }) })), false, "shipped again since");

// ── "Checks on GitHub" — never the card's own "Checks" words ──────────
assert.deepEqual(githubChecksFact(pr({ checkedAt: null })), { word: "Not read yet", state: "empty" });
assert.deepEqual(
  githubChecksFact(pr({ checks: "pending", checksPending: 1 })),
  { word: "Running · 1 of 2 done", state: "running" },
);
assert.deepEqual(githubChecksFact(pr()), { word: "Passed", state: "done" });
assert.deepEqual(
  githubChecksFact(pr({ checks: "failing", failingChecks: [{ name: "test", url: "u" }, { name: "lint" }] })),
  { word: "Failed · test, lint", state: "aborted" },
);
assert.deepEqual(githubChecksFact(pr({ checks: "none", checksTotal: 0 })), { word: "None", state: "empty" });

// ── The Board: an open PR is not Done ─────────────────────────────────
const pending = () => card({ pr: pr({ checks: "pending", checksPassed: 1, checksPending: 1 }) });
// 1.171.0 B1 (owner D6): its checks running on GitHub — Working, in the
// stage's words.
assert.deepEqual(openPrBoard(pending()), { label: "On GitHub · waiting for checks", attention: "working" }, "pending");
assert.deepEqual(
  openPrBoard(card({ pr: pr({ checks: "failing", failingChecks: [{ name: "test" }] }) })),
  { label: "Checks failed on GitHub", attention: "needs-you" },
);
assert.deepEqual(
  openPrBoard(card({ pr: pr({ reviewDecision: "changes_requested" }) })),
  { label: "Changes requested on GitHub", attention: "needs-you" },
);
assert.deepEqual(
  openPrBoard(card({ pr: pr({ mergeable: "conflicting" }) })),
  { label: "Can't merge: conflict", attention: "needs-you" },
);
assert.equal(openPrBoard(card({ pr: pr({ state: "merged" }) })), null);

assert.equal(deriveAttentionColumn(pending(), null), "working");
assert.equal(deriveAttentionColumn(card({ pr: pr({ mergeable: "conflicting" }) }), null), "needs-you");
{
  const chip = deriveBoardCardState(card({ pr: pr({ checks: "failing", failingChecks: [{ name: "test" }] }) }), null);
  assert.equal(chip.state, "shipped", "the same canonical state");
  assert.equal(chip.label, "Checks failed on GitHub");
  assert.equal(chip.tone, "accent");
}
assert.equal(deriveBoardCardState(pending(), null).label, "On GitHub · waiting for checks");

// ── 1.169.1 (R1, walk R3 step A4): a green pull request asks for you ────
{
  // Green, mergeable, no review in the way, auto-merge off: Needs you, Merge.
  const ready = card();
  assert.equal(prReadyToMerge(ready.pr!), true);
  assert.equal(prCardReadyToMerge(ready), true);
  assert.deepEqual(openPrBoard(ready), { label: "Ready to merge", attention: "needs-you" });
  assert.equal(deriveAttentionColumn(ready, null), "needs-you");
  assert.equal(cardAttentionSignals(ready).pullRequest, "needs-you");
  assert.equal(deriveBoardCardState(ready, null).label, "Ready to merge");
  assert.equal(prNowFact(ready, () => "x"), "Its pull request #12 is open; checks on GitHub passed.");
  // 1.174.0 C5 (T46): the card's own pull request is merged from the card;
  // one it reviews for someone else keeps GitHub's words.
  assert.deepEqual(prShipLine(ready), { text: "Pull request #12 is ready to merge. Merge it here with Merge, or on GitHub.", state: "done" });
  assert.deepEqual(prShipLine({ ...ready, prReview: { number: 12 } as never }), {
    text: "Pull request #12 is open: ready to merge on GitHub.",
    state: "done",
  });
  assert.equal(prInboxDetail("pr_ready_to_merge", null), "Ready to merge · checks passed on GitHub");
  const ev = { id: "pr-ready:c1:12:h", kind: "pr_ready_to_merge", group: "needs_you", workspaceId: "ws", workspaceName: "W", cardId: "c1", runId: null, title: "Add sum", detail: null, url: URL, at: 1, seenAt: null, seenEligible: true } as const;
  assert.deepEqual(inboxRowWords(ev, { merge: true }), {
    detail: "Ready to merge · checks passed on GitHub",
    action: "Merge",
    merge: true,
  });
  // 1.174.0 (A5, P16): no Inbox row action is filled — `ship` marks Ship it,
  // and nothing carries `accent` any more.
  assert.equal("accent" in inboxRowWords(ev, { merge: true }), false);
  assert.deepEqual(inboxRowWords(ev, {}), { detail: "Ready to merge · checks passed on GitHub", action: "Open the card" }, "Merge only where Now offers it");

  // B1: no checks on GitHub, once read and the wait after a push is over.
  const none = card({ pr: pr({ checks: "none", checksTotal: 0, checksPassed: 0 }) });
  assert.equal(prReadyToMerge(none.pr!), true);
  assert.equal(deriveAttentionColumn(none, null), "needs-you");
  assert.equal(prNowFact(none, () => "x"), "Its pull request #12 is open; no checks on GitHub.");
  assert.equal(prInboxDetail("pr_ready_to_merge", PR_READY_NO_CHECKS_DETAIL), "Ready to merge · no checks on GitHub");
  assert.equal(prReadyToMerge(pr({ checks: "none", checksTotal: 0, awaitingChecks: true })), false, "GitHub may not have started them");
  assert.equal(prReadyToMerge(pr({ checks: "none", checksTotal: 0, checkedAt: null })), false, "never read");
  assert.equal(prReadyToMerge(pr({ checkedAt: null })), false, "never read");

  // M1: GitHub's merge state stands in the way: On hold, as before R1.
  for (const mergeState of ["blocked", "behind", "draft", "dirty"]) {
    const held = card({ pr: pr({ mergeState }) });
    assert.equal(prReadyToMerge(held.pr!), false, mergeState);
    assert.deepEqual(openPrBoard(held), { label: "On GitHub · pull request open", attention: "waiting" }, mergeState);
  }
  assert.equal(prReadyToMerge(pr({ mergeState: "clean" })), true);

  // m1: Plyloft's own blockers — a build waiting for Push update, the
  // Challenger's request for changes on the latest snapshot.
  const unpushed = card({ pr: pr({ headSha: "h1" }), builder: { snapshots: [{ n: 2, sha: "h2", at: 1 }] } as never });
  assert.equal(prCardReadyToMerge(unpushed), false);
  assert.equal(deriveAttentionColumn(unpushed, null), "waiting");
  const challenged = card({
    pr: pr({ headSha: "h1" }),
    builder: { snapshots: [{ n: 1, sha: "h1", at: 1 }], review: { snapshotN: 1, status: "done", verdict: "changes_requested", at: 2 } } as never,
  });
  assert.equal(prCardReadyToMerge(challenged), false);

  // Owner (m8): green with a required review missing is On hold, its label
  // "Waiting for a review on GitHub"; no Inbox row.
  const review = card({ pr: pr({ reviewDecision: "review_required", mergeState: "blocked" }) });
  assert.equal(prReadyToMerge(review.pr!), false);
  assert.equal(prWaitsForReview(review.pr!), true, "BLOCKED doesn't gate the review wait");
  assert.deepEqual(openPrBoard(review), { label: "Waiting for a review on GitHub", attention: "waiting" });
  assert.equal(deriveAttentionColumn(review, null), "waiting");
  assert.equal(
    prNowFact(review, () => "x"),
    "Its pull request #12 is open; checks on GitHub passed, and it's waiting for a review on GitHub.",
  );
  assert.deepEqual(prShipLine(review), { text: "Pull request #12 is open: waiting for a review on GitHub.", state: "running" });

  // Auto-merge on: GitHub merges it — 1.171.0 B1 (owner D6): Working, in
  // the stage's words; with GitHub's merge state in the way, On hold.
  const auto = card({ pr: pr({ autoMerge: true }) });
  assert.equal(prReadyToMerge(auto.pr!), false);
  assert.deepEqual(openPrBoard(auto), { label: "On GitHub · merges when checks pass", attention: "working" });
  assert.equal(deriveAttentionColumn(auto, null), "working");
  assert.deepEqual(
    openPrBoard(card({ pr: pr({ autoMerge: true, mergeState: "blocked" }) })),
    { label: "On GitHub · merges when checks pass", attention: "waiting" },
  );
  assert.equal(prWaitsForReview(pr({ autoMerge: true, reviewDecision: "review_required" })), false);

  // Pending or right after a push: its checks run (Working, B1); GitHub not
  // sure it's mergeable yet, nothing running: On hold.
  assert.equal(deriveAttentionColumn(pending(), null), "working");
  assert.equal(openPrBoard(card({ pr: pr({ mergeable: "unknown" }) }))!.attention, "waiting");
  assert.equal(openPrBoard(card({ pr: pr({ awaitingChecks: true }) }))!.attention, "working");
}
assert.equal(boardCardFact(card(), "shipped", 0), "#12");
// A card shipped as a PR before SL-1 stays where it was: Done; 1.171.0 B1
// (Challenger 5): it opened on GitHub, whether it merged isn't known.
{
  const legacy = card({ pr: null });
  assert.equal(deriveAttentionColumn(legacy, null), "done");
  assert.equal(deriveBoardCardState(legacy, null).label, "On GitHub · pull request opened");
  assert.equal(cardAttentionSignals(legacy).pullRequest, undefined);
}
// Merged (read back): Done, "Shipped · on GitHub · #12" (1.171.0 B1,
// DL-03), and landed for blockers.
{
  const merged = card({
    pr: pr({ state: "merged", mergedAt: 5_000, mergeCommit: "m1" }),
    shipStatus: "shipped",
    shippedVersion: "1.2.3",
    shipHistory: [{ commitSha: "m1", shippedVersion: "1.2.3", releaseKind: "local", shippedAt: 5_000 }],
    worktreePath: null,
  });
  assert.equal(deriveAttentionColumn(merged, null), "done");
  assert.equal(mergedWithoutRelease(merged), true);
  assert.equal(deriveBoardCardState(merged, null).label, "Shipped · on GitHub");
  assert.equal(boardCardFact(merged, "shipped", 0), "#12");
  assert.equal(cardShippedOrPrOpen(merged), true);
}
// An open PR reads as shipped (the Free slot is free), but it hasn't landed:
// the cards it blocks wait for the merge (1.174.0 A2).
assert.equal(cardShippedOrPrOpen(card()), true);
assert.equal(cardLanded(card()), false);
// Closed: back to review — the card's own state, Needs you.
{
  const closed = card({ pr: pr({ state: "closed", closedAt: 3_000 }), reviewStatus: "pending" });
  assert.equal(cardShippedOrPrOpen(closed), false);
  assert.equal(openPrBoard(closed), null);
  assert.equal(deriveAttentionColumn(closed, null), "needs-you");
}
// The precedence rule itself.
assert.equal(attentionColumnFor("shipped", { changesRequested: false, failed: false, pullRequest: "waiting" }), "waiting");
assert.equal(attentionColumnFor("shipped", { changesRequested: false, failed: false, pullRequest: "working" }), "working");
assert.equal(attentionColumnFor("shipped", { changesRequested: false, failed: false, pullRequest: null }), "done");

// ── The card page ─────────────────────────────────────────────────────
const day = (at: number) => `day${at}`;
assert.equal(prNowFact(card(), day), "Its pull request #12 is open; checks on GitHub passed.");
assert.equal(
  prNowFact(card({ pr: pr({ checks: "pending" }) }), day),
  "Its pull request #12 is open; checks on GitHub are running.",
);
assert.equal(
  prNowFact(
    card({ pr: pr({ checks: "failing", failingChecks: [{ name: "test" }], reviewDecision: "changes_requested" }) }),
    day,
  ),
  "Its pull request #12 is open: checks failed on GitHub (test); a reviewer asked for changes.",
);
assert.equal(prNowFact(card({ pr: pr({ state: "merged", mergedAt: 7 }) }), day), "Its pull request #12 was merged on day7.");
assert.equal(prNowFact(card({ pr: null }), day), null, "legacy keeps its own sentence");
assert.equal(
  nowFacts("shipped", card(), { filesChanged: null, now: 0 }),
  "Its pull request #12 is open; checks on GitHub passed.",
);
// Before SL-1 nothing read the pull request back: it shipped, merged or not.
assert.equal(nowFacts("shipped", card({ pr: null }), { filesChanged: null, now: 0 }), "Its pull request #12 was opened on GitHub.");

assert.deepEqual(prShipLine(pending()), { text: "Pull request #12 is open.", state: "running" });
assert.deepEqual(prShipLine(card({ pr: pr({ mergeable: "conflicting" }) })), {
  text: "Pull request #12 is open: can't merge: conflict.",
  state: "aborted",
});
assert.equal(prShipLine(card({ pr: pr({ state: "merged" }) }))?.text, "Shipped as pull request #12, and it was merged.");
// D8 (Block A walk): the merged pull request's title is what shipped.
assert.equal(
  prShipLine(card({ pr: pr({ state: "merged", title: "Add a notes page" }) }))?.text,
  "Shipped as pull request #12 “Add a notes page”, and it was merged.",
);
assert.match(prShipLine(card({ pr: pr({ state: "closed" }), reviewStatus: "pending" }))!.text, /closed without merging\. The card's copy and its branch are kept/);
// M3: a card shipped as a PR before SL-1 gets no new line (its page keeps its own).
assert.equal(prShipLine(card({ pr: null })), null);
// m4: a closed PR's line goes once the card landed another way.
assert.equal(prShipLine(card({ pr: pr({ state: "closed" }), reviewStatus: "merged", shipStatus: "shipped" })), null);
assert.equal(prShipLine(card({ pr: pr({ state: "closed" }), reviewStatus: "pending", shipStatus: "shipped" })), null);
// m2: the ship-history entry of a merged PR names the PR.
{
  const merged = card({ pr: pr({ state: "merged", mergeCommit: "m1", headSha: "h1" }) });
  assert.equal(shipEntryPullRequest(merged, { commitSha: "m1" }), "Pull request #12");
  assert.equal(shipEntryPullRequest(merged, { commitSha: "h1" }), "Pull request #12");
  assert.equal(shipEntryPullRequest(merged, { commitSha: "other" }), null, "a release stays a release");
  assert.equal(shipEntryPullRequest(card({ pr: null }), { commitSha: "m1" }), null);
}
// m6: a failing check says its workflow when the name doesn't.
assert.equal(checkLabel({ name: "test", workflow: "test" }), "test");
assert.equal(checkLabel({ name: "test", workflow: "lint" }), "lint / test");
assert.deepEqual(
  githubChecksFact(pr({ checks: "failing", failingChecks: [{ name: "test", workflow: "lint" }] })),
  { word: "Failed · lint / test", state: "aborted" },
);
assert.equal(prCheckedWords(pr({ checkedAt: null }), day), "Not read from GitHub yet.");
assert.equal(prCheckedWords(pr(), day), "Read from GitHub day2000.");

assert.equal(refreshOnOpen(card()), true);
assert.equal(refreshOnOpen(card({ archived: true })), false);
assert.equal(refreshOnOpen(card({ pr: pr({ state: "merged" }) })), false);
assert.equal(refreshOnOpen(card({ pr: null })), false, "legacy: Refresh only");

// The timeline: opened, merged as the ship, closed.
{
  const merged = card({
    pr: pr({ state: "merged", mergeCommit: "m1", mergedAt: 5_000 }),
    shipHistory: [{ commitSha: "m1", shippedVersion: "1.2.3", releaseKind: "local", shippedAt: 5_000 }],
  });
  const texts = cardTimeline(merged).map((e) => e.text);
  assert.ok(texts.includes("Opened pull request #12"), texts.join(" | "));
  assert.ok(texts.includes("Pull request #12 merged"), texts.join(" | "));
  assert.ok(!texts.some((t) => t.startsWith("Shipped in")), "the merge, not a release");
  const closed = cardTimeline(card({ pr: pr({ state: "closed", closedAt: 9_000 }), reviewStatus: "pending" }));
  assert.equal(closed[closed.length - 1].text, "Pull request #12 closed without merging");
  const legacy = cardTimeline(card({ pr: null })).map((e) => e.text);
  // 1.171.0 B1 (CP-2): never read back, so it opened — not "Shipped".
  assert.ok(legacy.includes("Opened a pull request on GitHub"), legacy.join(" | "));
}

// ── The Inbox ─────────────────────────────────────────────────────────
const ev = (kind: string, detail: string | null) =>
  ({ kind, detail, group: "needs_you" }) as unknown as Parameters<typeof inboxRowWords>[0];
assert.deepEqual(inboxRowWords(ev("pr_checks_failed", "test")), {
  detail: "Checks failed on GitHub · test",
  action: "See what failed",
});
assert.deepEqual(inboxRowWords(ev("pr_changes_requested", "\n  Please rename it.\nAnd more.")), {
  detail: "Changes requested on GitHub · Please rename it.",
  action: "Open the card",
});
assert.equal(inboxRowWords(ev("pr_conflict", null)).detail, "The pull request can't merge: conflict");
assert.equal(inboxRowWords(ev("pr_closed", "#12")).detail, "Pull request #12 closed without merging · back to review");
assert.deepEqual(inboxRowWords(ev("pr_merged", "#12")), { detail: "Pull request #12 merged", action: null });
// G5: merged, this computer still behind GitHub's — the row asks for the
// card's own press, with the reason as its detail.
assert.deepEqual(inboxRowWords(ev("bring_up_to_date", "You have changes that aren't in a commit")), {
  detail: "You have changes that aren't in a commit",
  action: "Bring this Mac up to date",
  upToDate: true,
});
// G7: where Fix failing checks by itself stopped — the reason in words.
assert.deepEqual(inboxRowWords(ev("pr_auto_fix_stopped", "exhausted")), {
  detail: "Stopped fixing checks after 3 tries",
  action: "Open the card",
});
assert.equal(
  inboxRowWords(ev("pr_auto_fix_stopped", "session_closed")).detail,
  "Couldn't fix the checks by itself: the Builder session is closed",
);
assert.equal(BRING_UP_TO_DATE_ACTION, "Bring this Mac up to date");
// 1.174.1 P5 (T5): this PC on Windows, where it is drawn.
assert.equal(machineWords(BRING_UP_TO_DATE_ACTION, "windows"), "Bring this PC up to date");
setPlatformForTests("windows");
try {
  assert.equal(
    upToDateRefusedLine("GitHub couldn't be reached."),
    "Merged. GitHub couldn't be reached, so this PC wasn't brought up to date.",
  );
} finally {
  setPlatformForTests(null);
}
assert.equal(
  upToDateRefusedLine("main is open in another folder"),
  "Merged. main is open in another folder, so this Mac wasn't brought up to date.",
);
// Challenger 4: commits of its own — the words say what to do, no "so …".
assert.equal(
  upToDateRefusedLine("This computer's main has commits GitHub's doesn't — ship or move them first.", true),
  "Merged. This computer's main has commits GitHub's doesn't — ship or move them first.",
);
// Challenger 7: the branch left on GitHub.
assert.equal(
  branchKeptLine("another open pull request uses plyloft/card-1"),
  "The pull request's branch was left on GitHub: another open pull request uses plyloft/card-1.",
);
assert.equal(
  upToDateRefusedLine("GitHub couldn't be reached."),
  "Merged. GitHub couldn't be reached, so this Mac wasn't brought up to date.",
);
assert.equal(prInboxDetail("pr_changes_requested", "x".repeat(200))!.length, "Changes requested on GitHub · ".length + 80);

console.log("prStatus: ok");

// ── SL-3: Merge, and Merge when checks pass ─────────────────────────────
assert.equal(prMergeOffered(card()), true);
assert.equal(prMergeOffered(card({ archived: true })), false);
assert.equal(prMergeOffered(card({ pr: pr({ state: "merged" }) })), false);
assert.equal(prMergeOffered(card({ pr: null })), false, "legacy: no Merge");
assert.equal(prAutoMergeLine(pr({ autoMerge: true })), "Will merge when checks pass.");
assert.equal(prAutoMergeLine(pr({ autoMerge: true, state: "merged" })), null);
assert.equal(prAutoMergeLine(pr()), null);
// 1.170.0 walk fix: Plyloft keeps it where the base branch requires no checks.
assert.equal(
  prAutoMergeLine(pr({ plyloftAutoMerge: true })),
  "Merges when the checks pass (Plyloft merges it while it's open on this Mac).",
);
assert.equal(prAutoMergeLine(pr({ plyloftAutoMerge: true, state: "merged" })), null);
// G3 Windows walk: "this PC" on Windows, as Now and the toast.
assert.equal(
  machineWords(prAutoMergeLine(pr({ plyloftAutoMerge: true }))!, "windows"),
  "Merges when the checks pass (Plyloft merges it while it's open on this PC).",
);
assert.equal(
  prNowFact(card({ pr: pr({ checks: "pending", plyloftAutoMerge: true }) }), day),
  "Its pull request #12 is open; checks on GitHub are running, and it merges when they pass.",
);
{
  const ready = card({
    pr: pr({ checks: "passing", mergeable: "mergeable", mergeState: "clean", checkedAt: 1, plyloftAutoMerge: true }),
  });
  assert.equal(prCardReadyToMerge(ready), false, "Plyloft merges it: nothing asked of the person");
  assert.equal(prCardReadyToMerge(card({ pr: { ...ready.pr!, plyloftAutoMerge: false } })), true);
}
assert.equal(
  prNowFact(card({ pr: pr({ checks: "pending", autoMerge: true }) }), day),
  "Its pull request #12 is open; checks on GitHub are running, and it merges when they pass.",
);
// Real (sandbox, gh 2.101) and GitHub's documented not-allowed error.
assert.match(
  autoMergeRefusedWords("GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)"),
  /^GitHub doesn't allow merging by itself in this repository; press Merge when it's ready\.$/,
);
// G1: an account that may not turn it on is said the same way.
assert.match(
  autoMergeRefusedWords("GraphQL: Resource not accessible by integration (enablePullRequestAutoMerge)"),
  /^GitHub doesn't allow merging by itself in this repository/,
);
assert.match(
  autoMergeRefusedWords("GraphQL: Pull request Protected branch rules not configured for this branch (enablePullRequestAutoMerge)"),
  /requires no checks or reviews/,
);
assert.match(autoMergeRefusedWords("GraphQL: Pull request is in clean status"), /ready to merge already/);
assert.match(autoMergeRefusedWords("HTTP 502"), /^Merge when checks pass couldn't be turned on\./);
console.log("prStatus SL-3 ok");

// ── v1.154.1 walk fixes ─────────────────────────────────────────────────
// F11: open follows the PR's own state — the review loop writes
// `reviewStatus` too (a request for changes on the fix; v1.154.0 left none).
assert.equal(prOpen(card({ reviewStatus: null })), true);
assert.equal(prOpen(card({ reviewStatus: "changes_requested" })), true);
assert.equal(prOpen(card({ shipStatus: "shipped" })), false, "landed another way");
assert.equal(prOpen(card({ prUrl: null })), false);
assert.equal(prMergeOffered(card({ reviewStatus: null })), true, "Merge stays");
// F14: auto-merge said in the Now callout whatever the checks.
assert.equal(
  prNowFact(card({ pr: pr({ autoMerge: true }) }), day),
  "Its pull request #12 is open; checks on GitHub passed, and GitHub merges it on its own.",
);
assert.equal(
  prNowFact(card({ pr: pr({ autoMerge: true, checks: "none" }) }), day),
  "Its pull request #12 is open, and it merges when checks pass.",
);
// F15: a refusal stands for one read; a new read that says something new ends it.
{
  const failing = pr({ checks: "failing", headSha: "aaa" });
  assert.equal(prFactsKey(failing), prFactsKey({ ...failing, checkedAt: 9_999 }), "a read that changed nothing");
  assert.notEqual(prFactsKey(failing), prFactsKey({ ...failing, checks: "passing" }), "checks passed");
  assert.notEqual(prFactsKey(failing), prFactsKey({ ...failing, headSha: "bbb" }), "a push");
}
// F22: closed without merging — the Board says so, not "Result ready".
{
  const closed = card({ pr: pr({ state: "closed", closedAt: 3_000 }), reviewStatus: "pending" });
  const chip = deriveBoardCardState(closed, null);
  assert.equal(chip.label, "Pull request closed");
  assert.equal(chip.tone, "accent");
  assert.equal(deriveBoardCardState(card({ reviewStatus: "pending", pr: null, prUrl: null }), null).label, "Result ready");
}
console.log("prStatus v1.154.1 ok");

// 1.169.1 (R2): a pull request stopped over commits not on GitHub yet.
// 1.171.0 A3 (DL-11, DL-21): said as earlier changes on this Mac, the cards
// named when known, the commits under Show them; Ship both / Not now.
{
  const one = carriesLocalCommitsQuestion({ target: "main", count: 1, subjects: ["feat: add a half function"] }, "GitHub", ["Add a half function"]);
  assert.equal(one.title, "1 earlier change on this Mac isn't on GitHub yet");
  assert.deepEqual(one.items, ["feat: add a half function"]);
  assert.equal(one.itemsLabel, "Show them");
  assert.equal(one.confirmLabel, "Ship both");
  assert.equal(one.cancelLabel, "Not now");
  assert.equal(one.cautious, true);
  assert.equal(
    one.body,
    "It's from the card “Add a half function”, shipped only on this Mac. It is on main on this Mac, not this card's own work. Ship both sends it to GitHub in this card's pull request. Nothing has been pushed yet.",
  );
  const many = carriesLocalCommitsQuestion({ target: "walk-delivery-3", count: 22, subjects: Array.from({ length: 20 }, (_, i) => `c${i}`) });
  assert.equal(many.title, "22 earlier changes on this Mac aren't on GitHub yet");
  assert.equal(many.items.length, 21);
  assert.equal(many.items[20], "…and 2 more");
  assert.match(many.body, /^They are on walk-delivery-3 on this Mac/, "no card known: none named");
  assert.equal(
    carriesLocalCommitsQuestion({ target: "main", count: 1, subjects: ["x"] }, "the online copy").title,
    "1 earlier change on this Mac isn't on the online copy yet",
  );
  assert.match(
    carriesLocalCommitsQuestion({ target: "main", count: 2, subjects: ["a", "b"] }, "GitHub", ["A", "B"]).body,
    /^They're from the cards “A” and “B”, shipped only on this Mac\./,
  );
  // The cards, from the Land subjects: today's and the older form.
  const shipped = (title: string) => ({ title, shipStatus: "shipped" as const });
  const cards = [shipped("Add a half function"), shipped("fix: footer"), shipped("API keys page."), shipped("Other")];
  assert.deepEqual(
    landedCardTitles(["feat: add a half function", "fix: footer", "Land card: API keys page.", "chore: snapshot 1 for Other", "feat: add a half function"], cards),
    ["Add a half function", "fix: footer", "API keys page."],
  );
  assert.deepEqual(landedCardTitles(["feat: nobody"], cards), []);
  // Only a card that landed here: not one not shipped, nor one merged on GitHub.
  assert.deepEqual(
    landedCardTitles(["feat: add a half function", "feat: footer"], [
      { title: "Add a half function" },
      { title: "Footer", shipStatus: "shipped", reviewStatus: "merged", pr: { state: "merged" } },
    ]),
    [],
  );
}

// G3: beside Merge, the way the repository allows — nothing until read.
{
  assert.equal(mergeMethodLabel({ mergeMethod: "squash" }), "Squash and merge");
  assert.equal(mergeMethodLabel({ mergeMethod: "merge" }), "Create a merge commit");
  assert.equal(mergeMethodLabel({ mergeMethod: "rebase" }), "Add the commits one by one");
  assert.equal(mergeMethodLabel({}), null);
  assert.equal(mergeMethodLabel({ mergeMethod: null }), null);
}

// G1–G3 Challenger (2): commits on GitHub Plyloft didn't push — never
// "ready", never merged by itself; the Board, Now and the Inbox say so.
{
  const A = "1111111111111111111111111111111111111111";
  const B = "a0a74794ac3eada32f2784f95c7dde0609914535";
  const moved = card({ pr: pr({ pushedHead: A, headSha: B }) });
  assert.equal(prHeadMoved(moved.pr!), true);
  assert.equal(prCardReadyToMerge(moved), false);
  assert.equal(prMergeBlocked(moved), true);
  assert.deepEqual(openPrBoard(moved), { label: PR_HEAD_MOVED_LABEL, attention: "needs-you" });
  assert.equal(prNowFact(moved, () => "today"), "Its pull request #12 is open: it has commits on GitHub Plyloft didn't push.");
  assert.equal(recordInboxGroup(moved), "needs_you");
  assert.equal(prInboxDetail("pr_head_moved", null), PR_HEAD_MOVED_LINE);
  assert.deepEqual(inboxRowWords(ev("pr_head_moved", null)), { detail: PR_HEAD_MOVED_LINE, action: "Open the card" });
  // Not while GitHub may be catching up with a push; a short name is the same commit.
  assert.equal(prHeadMoved(pr({ pushedHead: A, headSha: B, awaitingChecks: true })), false);
  assert.equal(prHeadMoved(pr({ pushedHead: B.slice(0, 12), headSha: B })), false);
  assert.equal(prHeadMoved(pr({ pushedHead: null, headSha: B })), false, "shipped before Plyloft recorded it");
  assert.equal(prCardReadyToMerge(card({ pr: pr({ pushedHead: B, headSha: B }) })), true);
}

// G1–G3 Challenger (1, 3): Plyloft's hold on Merge when checks pass.
{
  assert.equal(prAutoMergeHeldLine(pr({ autoMergeWanted: "held" })), AUTO_MERGE_HELD_LINE);
  assert.equal(prAutoMergeHeldLine(pr({ autoMergeWanted: "turnedOff" })), AUTO_MERGE_TURNED_OFF_LINE);
  assert.match(AUTO_MERGE_TURNED_OFF_LINE, /^Merge when checks pass was turned off: the last commit isn't reviewed\./);
  assert.equal(prAutoMergeHeldLine(pr({ autoMergeWanted: "held", autoMerge: true })), null);
  assert.equal(prAutoMergeHeldLine(pr({ autoMergeWanted: "resumed" })), null);
  assert.equal(prAutoMergeHeldLine(pr({})), null);
  assert.equal(prAutoMergeHeldLine(pr({ autoMergeWanted: "held", state: "merged" })), null);
  assert.equal(prAutoMergeLine(pr({ autoMerge: true, autoMergeWanted: "resumed" })), AUTO_MERGE_RESUMED_LINE);
  assert.equal(prAutoMergeLine(pr({ autoMerge: true })), "Will merge when checks pass.");
}

// 1.171.0 (D8, walk #5f): a merged pull request is not a release. The merge
// stamps package.json's version and a local entry; the result said "Shipped
// as v1.0.0" and "What shipped: chore: snapshot 1 for … (#122)".
{
  const version = (v: string) => (v && v !== "unknown" ? `v${v.replace(/^v/, "")}` : null);
  const when = () => "today";
  const mergedEntry = { commitSha: "m1", shippedVersion: "1.0.0", releaseKind: "local" as const, shippedAt: 1 };
  const merged = card({
    title: "Notes page",
    pr: pr({ number: 122, state: "merged", mergeCommit: "m1", title: "Add a notes page" }),
    shipHistory: [mergedEntry],
  });
  assert.equal(shippedResultLine(merged, version, when), "Merged on GitHub as pull request #122 on today.");
  assert.equal(whatShippedName(merged, "chore: snapshot 1 for Notes page (#122)"), "Add a notes page");
  // Read before the title was: the card's title, which Ship opened it with.
  const untitled = card({ ...merged, pr: { ...merged.pr!, title: null } });
  assert.equal(whatShippedName(untitled, "chore: snapshot 1 for Notes page (#122)"), "Notes page");
  // Released later as its own change (ticked): the card is at the release's
  // commit, whose entry says its version.
  const released = card({
    ...merged,
    commitSha: "r1",
    shipHistory: [mergedEntry, { commitSha: "r1", shippedVersion: "1.1.0", releaseKind: "github", shippedAt: 2 }],
  });
  assert.equal(shippedResultLine(released, version, when), "Shipped as v1.1.0 on today.");
  assert.equal(whatShippedName(released, "release 1.1.0"), "release 1.1.0");
  // 1.171.0 B1 (Challenger 6): a Land without a pull request says where;
  // no history says "Shipped."
  const landed = card({ pr: null, prUrl: null, shipHistory: [{ ...mergedEntry, shippedVersion: "unknown" }] });
  assert.equal(shippedResultLine(landed, version, when), "Shipped only on this Mac on today.");
  const landedVersioned = card({ pr: null, prUrl: null, shipHistory: [mergedEntry] });
  assert.equal(shippedResultLine(landedVersioned, version, when), "Shipped as v1.0.0, only on this Mac, on today.");
  // F3 walk (R13): GitHub has it since (Put it on GitHub): not "only here".
  assert.equal(shippedResultLine(landed, version, when, true), "Shipped on today.");
  assert.equal(shippedResultLine(landedVersioned, version, when, true), "Shipped as v1.0.0 on today.");
  assert.equal(shippedResultLine(card({ shipHistory: [] }), version, when), "Shipped.");
  // 1.174.0 (DR2 round 1): carried by a later release (Release Site…, D1(b))
  // — still its own merge, and the release said apart.
  const carried = card({
    ...merged,
    commitSha: "m1",
    shipHistory: [mergedEntry, { commitSha: "r9", shippedVersion: "3.0.2", releaseKind: "github", shippedAt: 3, tag: "site-v3.0.2" }],
  });
  assert.equal(shippedResultLine(carried, version, when), "Merged on GitHub as pull request #122 on today. In site-v3.0.2.");
}
