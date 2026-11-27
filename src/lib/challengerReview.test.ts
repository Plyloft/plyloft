import assert from "node:assert/strict";
import { OVERLAY_ALREADY_OPEN, OVERLAY_TOOK_PASTE, PASTE_STILL_UNSENT } from "./builderInject.ts";
import { readFileSync } from "node:fs";

import type { BuilderReview, KanbanCard } from "../ipc.ts";
import { deriveCardState, deriveCardStep, EMPTY_CARD_STATE_CONTEXT } from "./cardLifecycle.ts";
import { deriveBoardCardState } from "./cardPresentation.ts";
import {
  CARD_STATE_PRESENTATION,
} from "./cardLifecycle.ts";
import {
  findingsMarkdown,
  NOT_REVIEWED_HEADLINE,
  RETRYING_TEXT,
  reviewChipForTruth,
  reviewTruth,
  reviewTruthPresentation,
  reviewAgainLabel,
  reviewBaseWords,
  reviewCanRunAgain,
  reviewChip,
  reviewCoverage,
  reviewIncomplete,
  reviewSettledMessage,
  skillsFollowedOf,
  reviewMayFollow,
  reviewVerdictKey,
  SWEEPING_TEXT,
  waitingReviewText,
  failedPassesLine,
  findingCardDraft,
  findingLine,
  findingsBySeverity,
  followUpShippedLine,
  changesRequestedPresentation,
  changesRequestedResultLine,
  prShipOffer,
  mergeReviewGap,
  PR_SHIP_WAIT_NOTE,
  handedOverOwed,
  handedOverPresentation,
  handedOverShipLine,
  verdictOwed,
  verdictShownAsWork,
  ledgerSections,
  ledgerOfIds,
  ledgerStateLine,
  ledgerFindingBlocks,
  ledgerFindingMark,
  smallNotesCount,
  smallNotesPhrase,
  reviewApprovedWord,
  ledgerFindingOpen,
  BLOCKING_CHOICES,
  blockingFindingsHint,
  shipWithFollowUpHelper,
  shipWithFollowUpOffer,
  findingsToFixCount,
} from "./challengerReview.ts";
import type { LedgerFinding, ReviewFinding } from "../ipc.ts";
import {
  VERDICT_ACK_ATTEMPTS,
  verdictNeedsAcknowledging,
  verdictNeedsSending,
  verdictSendsItself,
} from "./verdictDelivery.ts";

// GH #58: PR #57's Challenger could not see the whole diff. The outcome is
// "incomplete" — its own state, not "changes requested".

function review(overrides: Partial<BuilderReview> = {}): BuilderReview {
  return {
    snapshotN: 5,
    provider: "codex",
    degraded: false,
    status: "done",
    verdict: "incomplete",
    incompleteReason: "diff too large",
    passCount: 1,
    fileCount: 29,
    at: 3,
    ...overrides,
  };
}

function builderCard(r: BuilderReview): KanbanCard {
  return {
    id: "card-1",
    workspaceId: "workspace-1",
    title: "Dictation",
    columnId: "in_progress",
    createdAt: 1,
    updatedAt: 1,
    lastRunStatus: "success",
    verifyStatus: "passed",
    builder: {
      vendor: "claude",
      bypass: false,
      sessionLost: false,
      startedAt: 1,
      snapshots: [{ n: 5, sha: "e", at: 2 }],
      review: r,
    },
  };
}

{
  const incomplete = review();
  assert.ok(reviewIncomplete(incomplete));
  assert.deepEqual(reviewChip(incomplete), {
    text: "Review incomplete (the changes were too large)",
    tone: "flag",
  });
  assert.ok(reviewCanRunAgain(incomplete));
  assert.equal(reviewAgainLabel(incomplete), "Review again in passes");
  assert.equal(reviewCoverage(incomplete), "29 files, reviewed in 1 pass");

  // Not "changes requested": the card leaves Run and can ship, like a
  // failed review — #41's override is not needed to get out.
  const card = builderCard(incomplete);
  assert.equal(deriveCardStep(card, false), "outcome");
  assert.equal(
    deriveCardState(card, { ...EMPTY_CARD_STATE_CONTEXT, outcomeFilesChanged: 29 }),
    "ready-to-ship",
  );

  const message = reviewSettledMessage(incomplete)!;
  assert.match(message, /could not review all of snapshot 5 \(diff too large\)/);
  assert.match(message, /again in passes/);
  assert.doesNotMatch(message, /requests changes/);

  // A reason the backend did not record still reads as the size problem.
  assert.equal(
    reviewChip(review({ incompleteReason: null })).text,
    "Review incomplete (the changes were too large)",
  );
  assert.equal(
    reviewChip(review({ incompleteReason: "pass 2 of 3 failed" })).text,
    "Review incomplete (pass 2 of 3 failed)",
  );
  // P-D2 (Challenger): the reason Rust records ("diff too large") reads
  // as the changes, as the fallback does.
  assert.equal(
    reviewChip(review({ incompleteReason: "diff too large" })).text,
    "Review incomplete (the changes were too large)",
  );
}

{
  const approved = review({ verdict: "approve", incompleteReason: null, passCount: 4 });
  assert.equal(reviewChip(approved).text, "Reviewer Codex: Approved");
  assert.equal(reviewCoverage(approved), "29 files, reviewed in 4 passes");
  assert.ok(!reviewCanRunAgain(approved));

  const requested = review({ verdict: "changes_requested", incompleteReason: null });
  assert.ok(!reviewCanRunAgain(requested), "changes requested is addressed or overridden, not re-run");
  assert.equal(deriveCardStep(builderCard(requested), false), "run");

  const failed = review({ status: "failed", verdict: null, error: "Pass 2 of 3 timed out" });
  assert.ok(reviewCanRunAgain(failed));
  assert.equal(reviewAgainLabel(failed), "Review again");

  assert.ok(!reviewCanRunAgain(review({ status: "running", verdict: null })));
  assert.equal(reviewSettledMessage(review({ status: "running", verdict: null })), null);

  // Reviews stored before passes carry no counts.
  assert.equal(reviewCoverage(review({ passCount: undefined, fileCount: undefined })), null);

  // #74: the coverage line names the model the Challenger reviewed on,
  // and reads exactly as before when its row was blank.
  assert.equal(
    reviewCoverage(review({ passCount: 1, fileCount: 19, model: "gpt-6-astra medium" })),
    "19 files, reviewed in 1 pass by gpt-6-astra with medium effort",
  );
  assert.equal(
    reviewCoverage(review({ passCount: 1, fileCount: 19, model: null })),
    "19 files, reviewed in 1 pass",
  );
  assert.equal(
    reviewCoverage(review({ passCount: 2, fileCount: 19, model: "   " })),
    "19 files, reviewed in 2 passes",
  );
}

// GH #99: card #91 shipped as PR #97 with its last commit never reviewed.
{
  const CAPACITY =
    "Reviewer exited with status 1: Selected model is at capacity. Please try a different model..";
  function builder(
    r: BuilderReview | null,
    extra: Partial<NonNullable<KanbanCard["builder"]>> = {},
  ): NonNullable<KanbanCard["builder"]> {
    return {
      vendor: "claude",
      bypass: false,
      sessionLost: false,
      startedAt: 1,
      snapshots: [
        { n: 1, sha: "a1", at: 1 },
        { n: 2, sha: "b2", at: 2 },
      ],
      review: r,
      ...extra,
    };
  }

  // While the one retry waits, the card says so.
  const waiting = review({
    snapshotN: 2,
    status: "running",
    verdict: null,
    retryAt: 31_000,
    failureReason: "The Reviewer's model was at capacity.",
  });
  assert.equal(RETRYING_TEXT, "Reviewer unavailable — trying again in 30 s");
  assert.deepEqual(reviewChip(waiting), { text: RETRYING_TEXT, tone: "muted" });
  const retrying = reviewTruth({ builder: builder(waiting) });
  assert.equal(retrying.kind, "retrying");
  const retryHeader = reviewTruthPresentation(
    "challenger-reviewing",
    CARD_STATE_PRESENTATION["challenger-reviewing"],
    retrying,
  );
  assert.equal(retryHeader?.label, RETRYING_TEXT);
  assert.equal(
    reviewChip(review({ status: "running", verdict: null, retried: true })).text,
    "Reviewer Codex reviewing again…",
  );

  // Failed after an approved (or changes-requested) snapshot 1: the last
  // commit was not reviewed, with the reason and the raw error.
  const failed = review({
    snapshotN: 2,
    status: "failed",
    verdict: null,
    incompleteReason: null,
    error: CAPACITY,
    failureReason: "The Reviewer's model was at capacity.",
    reviewedRevision: "b2",
    commitsSinceReview: 2,
    retried: true,
  });
  const truth = reviewTruth({ builder: builder(failed, { lastReviewedRevision: "a1" }) });
  assert.deepEqual(truth, {
    kind: "not-reviewed",
    cause: "failed",
    headline: "The last commit was not reviewed",
    reason: "The Reviewer's model was at capacity.",
    commitsLine: "2 commits since the last review",
    details: CAPACITY,
    action: "review-again",
  });
  assert.deepEqual(reviewChip(failed), { text: NOT_REVIEWED_HEADLINE, tone: "flag" });
  assert.ok(reviewCanRunAgain(failed));
  assert.equal(reviewAgainLabel(failed), "Review again");

  // A first review that failed has no "since the last review" to count.
  const firstFailed = reviewTruth({ builder: builder({ ...failed, commitsSinceReview: null }) });
  assert.equal(firstFailed.kind === "not-reviewed" && firstFailed.commitsLine, null);
  // A failure recorded before GH #99 still reads in words.
  const legacy = reviewTruth({ builder: builder({ ...failed, failureReason: null }) });
  assert.equal(
    legacy.kind === "not-reviewed" && legacy.reason,
    "The Reviewer could not finish the review.",
  );

  // Header and Board: Ship stays the primary action, as "Ship anyway".
  const header = reviewTruthPresentation(
    "ready-to-ship",
    CARD_STATE_PRESENTATION["ready-to-ship"],
    truth,
  )!;
  assert.equal(header.label, NOT_REVIEWED_HEADLINE);
  assert.equal(header.actionLabel, "Ship anyway");
  assert.equal(header.actionId, "ship");
  assert.match(header.helper, /at capacity\. 2 commits since the last review\./);
  // QoL 1.168 (C5): when the failed review can run again on the last
  // build, Review again leads; Ship anyway becomes the alternative.
  const again = reviewTruthPresentation("ready-to-ship", CARD_STATE_PRESENTATION["ready-to-ship"], truth, "Review again")!;
  assert.equal(again.actionLabel, "Review again");
  assert.equal(again.actionId, "review-again");
  assert.equal(again.label, NOT_REVIEWED_HEADLINE);
  assert.match(again.helper, /at capacity\. 2 commits since the last review\./);
  const failedCard = builderCard(failed);
  failedCard.builder = builder(failed, { lastReviewedRevision: "a1" });
  assert.equal(deriveCardStep(failedCard, false), "outcome", "never kept on Run");
  assert.equal(
    deriveCardState(failedCard, { ...EMPTY_CARD_STATE_CONTEXT, outcomeFilesChanged: 3 }),
    "ready-to-ship",
    "never blocks Ship",
  );
  const chip = deriveBoardCardState(failedCard, null);
  assert.equal(chip.label, NOT_REVIEWED_HEADLINE);
  assert.equal(chip.tone, "accent");

  // Review 1: pass 1 approved, pass 2 failed after its retry — merged as
  // incomplete, and the last commit was not (fully) reviewed.
  const partial = review({
    snapshotN: 2,
    verdict: "incomplete",
    incompleteReason: "pass 2 of 2 failed",
    passCount: 2,
    failedPasses: 1,
    reviewedRevision: "b2",
    failureReason: "The Reviewer's model was at capacity.",
    error: "Pass 2 of 2 exited with status 1: Selected model is at capacity.",
  });
  const partialTruth = reviewTruth({ builder: builder(partial), branchTip: "b2" });
  assert.equal(partialTruth.kind, "not-reviewed");
  assert.equal(
    partialTruth.kind === "not-reviewed" && partialTruth.reason,
    "1 of 2 review passes failed. The Reviewer's model was at capacity.",
  );
  assert.equal(partialTruth.kind === "not-reviewed" && partialTruth.action, "review-again");
  // Review 8: changes requested plus a failed pass, pushback accepted — the
  // failed pass still reads as not reviewed.
  const overridden = reviewTruth({
    builder: builder({
      ...partial,
      status: "skipped",
      verdict: null,
      note: "changes requested on snapshot 2, overridden by the human",
    }),
  });
  assert.equal(overridden.kind, "not-reviewed");
  // Review 9: and it can be reviewed again, in normal passes.
  const overriddenReview = {
    ...partial,
    status: "skipped" as const,
    verdict: null,
    note: "changes requested on snapshot 2, overridden by the human",
  };
  assert.ok(reviewCanRunAgain(overriddenReview));
  assert.equal(reviewAgainLabel(overriddenReview), "Review again");
  assert.ok(!reviewCanRunAgain({ ...overriddenReview, failedPasses: null }), "a plain override is not re-run");
  assert.equal(
    overridden.kind === "not-reviewed" && overridden.reason,
    "1 of 2 review passes failed. The Reviewer's model was at capacity.",
  );
  // A concrete request for changes still leads.
  assert.deepEqual(
    reviewTruth({ builder: builder({ ...partial, verdict: "changes_requested" }) }),
    { kind: "reviewed" },
  );

  // Approval of the tip: the verdict stands.
  const approved = review({
    snapshotN: 2,
    verdict: "approve",
    incompleteReason: null,
    reviewedRevision: "b2",
  });
  assert.deepEqual(reviewTruth({ builder: builder(approved) }), { kind: "reviewed" });
  assert.deepEqual(
    reviewTruth({ builder: builder(approved), branchTip: "b2", commitsSinceReview: 0 }),
    { kind: "reviewed" },
  );
  // A review stored before GH #99 reads its snapshot's sha.
  assert.deepEqual(
    reviewTruth({ builder: builder({ ...approved, reviewedRevision: null }), branchTip: "b2" }),
    { kind: "reviewed" },
  );
  assert.equal(
    reviewTruthPresentation("ready-to-ship", CARD_STATE_PRESENTATION["ready-to-ship"], {
      kind: "reviewed",
    }),
    null,
  );

  // Approval, then a new commit: the APPROVE on the older commit is not
  // the card's verdict.
  const moved = reviewTruth({ builder: builder(approved), branchTip: "c3", commitsSinceReview: 1 });
  assert.deepEqual(moved, {
    kind: "not-reviewed",
    cause: "moved",
    headline: "1 commit since the last review",
    reason: "Commits were made after the Reviewer's last review.",
    commitsLine: null,
    details: null,
    action: "build-done",
  });
  // The Run chip does not show the stale approval either.
  assert.deepEqual(reviewChipForTruth(approved, moved), {
    text: "1 commit since the last review",
    tone: "flag",
  });
  assert.deepEqual(reviewChipForTruth(approved, { kind: "reviewed" }), {
    text: "Reviewer Codex: Approved",
    tone: "ok",
  });

  // The header does not offer a Ship that would refuse the moved tree.
  const movedHeader = reviewTruthPresentation(
    "ready-to-ship",
    CARD_STATE_PRESENTATION["ready-to-ship"],
    moved,
  )!;
  assert.equal(movedHeader.label, "1 commit since the last review");
  assert.equal(movedHeader.actionId, "inspect-run");

  // The review read an older commit than the snapshot it is filed under.
  const olderRead = reviewTruth({ builder: builder({ ...approved, reviewedRevision: "a1" }) });
  assert.equal(olderRead.kind, "not-reviewed");
  assert.equal(olderRead.kind === "not-reviewed" && olderRead.action, "review-again");

  // Skip review keeps its meaning and is not a failure.
  const skipped = review({ snapshotN: 2, status: "skipped", verdict: null });
  assert.deepEqual(reviewTruth({ builder: builder(skipped), branchTip: "c3" }), {
    kind: "skipped",
  });
  assert.equal(reviewChip(skipped).text, "Review skipped");
  assert.deepEqual(reviewTruth({ builder: builder(null) }), { kind: "none" });

  const message = reviewSettledMessage(failed)!;
  assert.match(message, /at capacity\. Plyloft already tried once more\./);
  assert.match(message, /not reviewed/);
}

// ── ADR 0006: the sweep ──────────────────────────────────────────────────
{
  const finding = (severity: string | null, title: string, extra: Partial<ReviewFinding> = {}): ReviewFinding => ({
    severity,
    title,
    body: `**${severity ?? ""} — ${title}.** \`src/a.rs:1\`\n   What goes wrong. **Fix:** the smallest fix.`,
    preExisting: false,
    pass: null,
    ...extra,
  });

  // The Run step says a sweep takes minutes, so a long wait is not a hang.
  const sweeping = review({ status: "running", verdict: null, kind: "sweep" });
  assert.deepEqual(reviewChip(sweeping), { text: SWEEPING_TEXT, tone: "running" });
  assert.equal(SWEEPING_TEXT, "Reviewer sweeping — first review, up to 15 min per pass");
  // A later review keeps today's wording.
  assert.equal(
    reviewChip(review({ status: "running", verdict: null, kind: "review" })).text,
    "Reviewer Codex reviewing…",
  );
  assert.equal(reviewChip(review({ status: "running", verdict: null })).text, "Reviewer Codex reviewing…");

  // Changes requested: the blocking findings are sent; the non-blocking ones
  // travel as optional, and a pre-existing one says what it is.
  const swept = review({
    verdict: "changes_requested",
    incompleteReason: null,
    kind: "sweep",
    excerpt: "## Verdict\nCHANGES_REQUESTED\n\n(the whole markdown)",
    findings: [finding("P1", "Edits lost during migration"), finding("P2", "Retried issue loses its column")],
    nonBlocking: [
      finding("P3", "Progress toast disappears early"),
      finding("P2", "gh runs without a timeout", { preExisting: true }),
    ],
    checklist: ["A. Requirements: checked — nothing"],
  });
  const message = reviewSettledMessage(swept)!;
  assert.match(message, /swept snapshot 5 read-only and requests changes/);
  assert.match(message, /Edits lost during migration[\s\S]*Retried issue loses its column/);
  const [requested, optional] = message.split("Non-blocking (optional, do not start a round for these");
  assert.ok(optional, message);
  assert.doesNotMatch(requested, /Progress toast|gh runs without a timeout/);
  assert.match(optional, /Progress toast disappears early[\s\S]*gh runs without a timeout/);
  assert.doesNotMatch(message, /the whole markdown/, "structured findings replace the excerpt");

  // The backend's handoff is sent as it is, and nothing is appended to it.
  const handedOff = reviewSettledMessage({
    ...swept,
    builderHandoff: "- **P2 — Complete finding.** the whole text, **Fix:** the end.",
  })!;
  assert.match(handedOff, /the whole text, \*\*Fix:\*\* the end\./);
  assert.doesNotMatch(handedOff, /Edits lost during migration|Non-blocking/);

  // Partly read: the structured list and the reviewer's words both travel.
  const partly = reviewSettledMessage({
    ...swept,
    findingsUnread: true,
    excerpt: "## Findings\nThe retry loop never releases its PTY.",
  })!;
  assert.match(partly, /Edits lost during migration/);
  assert.match(partly, /could not read every finding[\s\S]*never releases its PTY/);

  // A review Ply read no findings from still sends the reviewer's words.
  const unread = reviewSettledMessage(review({ verdict: "changes_requested", excerpt: "P1 somewhere", findings: [] }))!;
  assert.match(unread, /P1 somewhere/);
  assert.doesNotMatch(unread, /Non-blocking/);

  // Only P3: an approval with notes, and nothing to do.
  const approvedWithNotes = reviewSettledMessage(
    review({ verdict: "approve", nonBlocking: [finding("P3", "Tautological assertion")] }),
  )!;
  assert.match(approvedWithNotes, /approved it\. Nothing else is needed from you/);
  assert.match(approvedWithNotes, /optional, do not start a round for these[\s\S]*Tautological assertion/);
  assert.equal(reviewChip(review({ verdict: "approve", nonBlocking: [finding("P3", "x")] })).text, "Reviewer Codex: Approved (1 small note)");

  // By severity, P1 first; unrated findings still listed.
  assert.deepEqual(
    findingsBySeverity([finding("P2", "b"), finding(null, "c"), finding("P1", "a")]).map((g) => [
      g.severity,
      g.findings.map((f) => f.title),
    ]),
    [["P1", ["a"]], ["P2", ["b"]], ["Unrated", ["c"]]],
  );
  assert.equal(
    findingLine(finding("P2", "gh runs without a timeout", { preExisting: true, pass: "pass 2 of 3" })),
    "Should fix — pre-existing — gh runs without a timeout (pass 2 of 3)",
  );

  // Make a card: the finding is the brief.
  const draft = findingCardDraft(finding("P2", "gh runs without a timeout", { preExisting: true }), {
    cardTitle: "Share a workspace",
    snapshotN: 1,
  });
  assert.equal(draft.title, "gh runs without a timeout");
  assert.match(draft.notes, /"Share a workspace" did not write/);
  assert.match(draft.notes, /\*\*Fix:\*\* the smallest fix\./);

  // Coverage and failed passes name the synthesis pass.
  assert.equal(
    reviewCoverage(review({ passCount: 2, fileCount: 12, synthesisPass: true })),
    "12 files, reviewed in 2 passes and a synthesis pass",
  );
  assert.equal(
    failedPassesLine({ passCount: 2, synthesisPass: true, failedPassNames: ["the synthesis pass"] }, 1),
    "1 of 3 review passes failed (the synthesis pass).",
  );
  assert.equal(failedPassesLine({ passCount: 3 }, 1), "1 of 3 review passes failed.");
}

// ADR 0006: the findings ledger and Ship with follow-up.
{
  const f = (id: string, severity: string, state: LedgerFinding["state"], extra: Partial<LedgerFinding> = {}): LedgerFinding => ({
    id,
    severity,
    preExisting: false,
    location: null,
    title: `${id} title`,
    body: `${id} body`,
    reviewId: "r1",
    round: 1,
    state,
    reason: null,
    updatedRound: 1,
    ...extra,
  });
  const ledger = [
    f("F1", "P2", "closed", { updatedRound: 2, reason: "Guarded." }),
    f("F2", "P3", "open"),
    f("F3", "P2", "still-open", { updatedRound: 2, reason: "Still races." }),
    f("F4", "P1", "open", { round: 2, updatedRound: 2 }),
  ];
  // Open first (blocking, P1 first), closed apart.
  const sections = ledgerSections(ledger);
  assert.deepEqual(sections.open.map((x) => x.id), ["F4", "F3", "F2"]);
  assert.deepEqual(sections.closed.map((x) => x.id), ["F1"]);
  assert.equal(ledgerStateLine(ledger[0]), "Raised in round 1 · closed in round 2: Guarded.");
  assert.equal(ledgerStateLine(ledger[2]), "Raised in round 1 · still open after round 2: Still races.");
  assert.equal(ledgerStateLine(ledger[3]), "Raised in round 2");

  const builder = (count: number, l: LedgerFinding[], verdict: BuilderReview["verdict"] = "changes_requested"): KanbanCard["builder"] => ({
    vendor: "claude",
    bypass: false,
    sessionLost: false,
    startedAt: 0,
    snapshots: [{ n: 5, sha: "s5", at: 0 }],
    review: review({ verdict, incompleteReason: null, ledger: l }),
    changesRequestedCount: count,
  });
  const noP1 = ledger.filter((x) => x.id !== "F4");
  // Offered from the fourth refusal, never with an open P1.
  assert.equal(shipWithFollowUpOffer(builder(3, noP1)).offered, false);
  assert.equal(shipWithFollowUpOffer(builder(4, noP1)).offered, true);
  assert.equal(shipWithFollowUpOffer(builder(4, noP1)).openCount, 2);
  assert.equal(shipWithFollowUpOffer(builder(6, ledger)).offered, false);
  assert.equal(shipWithFollowUpHelper(builder(6, ledger)), "F4 is serious: this card can't ship with it open.");
  assert.equal(shipWithFollowUpOffer(builder(5, noP1, "approve")).offered, false);
  assert.match(shipWithFollowUpHelper(builder(4, noP1)) ?? "", /^After 4 rounds with the Reviewer, 2 findings are still open\./);
  assert.equal(shipWithFollowUpHelper(builder(2, noP1)), null);
  assert.equal(followUpShippedLine({ cardRef: "#140", findingIds: ["F2", "F3"] }), "Shipped with 2 open findings: #140");
  // An unrated note never blocks, and alone never makes the offer.
  const noteOnly = [f("F9", null as unknown as string, "open", { note: true })];
  assert.equal(ledgerSections(noteOnly).open[0].id, "F9");
  assert.equal(shipWithFollowUpOffer(builder(4, noteOnly)).offered, false);

  // A follow-up says so while it runs and when it settles.
  const running = reviewChip(review({ status: "running", verdict: null, kind: "follow-up", ledger }));
  assert.equal(running.text, "Reviewer following up — re-checking 2 open findings and the fixes");
  const settled = reviewSettledMessage(
    review({ verdict: "changes_requested", kind: "follow-up", ledger, builderHandoff: "Still open from earlier rounds:\n\n- F3" }),
  )!;
  assert.match(settled, /followed up on snapshot 5 read-only and requests changes\. Each finding carries its id/);
  const fellBack = reviewSettledMessage(
    review({ verdict: "changes_requested", kind: "sweep", followUpFallback: "The base moved since the last review (a → b).", builderHandoff: "x" }),
  )!;
  assert.match(fellBack, /It ran as a sweep instead of a follow-up: The base moved/);
}

// GH #124: a Build done during a running review waits for it, and the
// card says which snapshot is reviewed next.
{
  const builder = (running: BuilderReview | null, waiting: number | null) =>
    ({
      vendor: "claude",
      bypass: false,
      sessionLost: false,
      startedAt: 0,
      snapshots: [],
      review: running,
      waitingReview: waiting == null ? null : { snapshotN: waiting, requestedAt: 1 },
    }) as unknown as KanbanCard["builder"];
  assert.equal(
    waitingReviewText(builder(review({ snapshotN: 1, status: "running", verdict: null, kind: "sweep" }), 2)),
    "The Reviewer is reviewing an earlier version; this one is reviewed next.",
  );
  assert.equal(waitingReviewText(builder(review({ snapshotN: 1, status: "running" }), null)), null);
  assert.equal(waitingReviewText(null), null);
  // A card from before it, or one whose running review is gone (restart).
  assert.equal(waitingReviewText(builder(review({ snapshotN: 1, status: "done" }), 3)), "This version is reviewed next. Finish and check starts its review.");
}

// GH #129: snapshot 5's review asked for changes and handed the card to
// snapshot 7's follow-up; the verdict was never sent. When the follow-up
// gives no verdict, the card names what is owed and Back to the Builder
// sends it.
{
  const owed = { snapshotN: 5, findingIds: ["F3", "F4"], handoff: "- F3 — P1 — Defect F3 (raised in round 1)\n  The whole text of F3.\n\n- F4 — P2 — Defect F4 (raised in round 1)\n  The whole text of F4.", at: 1 };
  const card = (r: BuilderReview | null, handedOver: typeof owed | null = owed): KanbanCard => {
    const c = builderCard(r ?? review());
    c.builder!.snapshots = [5, 6, 7].map((n) => ({ n, sha: `s${n}`, at: n }));
    c.builder!.review = r;
    c.builder!.handedOver = handedOver;
    return c;
  };
  const failed = review({ snapshotN: 7, status: "failed", verdict: null, kind: "follow-up", failureReason: "The Reviewer's model was at capacity." });

  const got = handedOverOwed(card(failed).builder)!;
  assert.equal(got.line, "2 findings still open · the last review didn't finish");
  assert.deepEqual(got.findingIds, ["F3", "F4"]);
  assert.match(got.message, /^\[Plyloft\] The review of snapshot 7 failed, so nothing sent you the changes the Reviewer requested on snapshot 5\. They are still open\. Each finding carries its id; answer by id\./);
  assert.ok(got.message.includes("The whole text of F3.") && got.message.includes("The whole text of F4."), "every open finding, whole");
  assert.match(got.message, /then stop: Plyloft checks your fixes when you are done\.$/);

  // Incomplete, no verdict, skipped: still owed, said as it ended.
  assert.equal(
    handedOverOwed(card(review({ snapshotN: 7, kind: "follow-up" })).builder)!.line,
    "2 findings still open · the last review didn't finish",
  );
  assert.match(handedOverOwed(card(review({ snapshotN: 7, verdict: null })).builder)!.line, /^2 findings still open · the last review gave no verdict$/);
  // A fresh session with no review yet has not received them either.
  assert.equal(handedOverOwed(card(null).builder)!.line, "2 findings still open");

  // While the follow-up runs, its verdict will carry them: nothing shown.
  assert.equal(handedOverOwed(card(review({ snapshotN: 7, status: "running", verdict: null, kind: "follow-up" })).builder), null);
  // A completed follow-up carries them; the backend clears the record.
  assert.equal(handedOverOwed(card(review({ snapshotN: 7, verdict: "approve" })).builder), null);
  assert.equal(handedOverOwed(card(review({ snapshotN: 7, verdict: "changes_requested" })).builder), null);
  assert.equal(handedOverOwed(card(failed, null).builder), null, "no hand-over, no line");
  // A review kept no ledger: its own hand-off, no ids.
  const noIds = handedOverOwed(card(failed, { ...owed, findingIds: [], handoff: "- the defect" }).builder)!;
  assert.equal(noIds.line, "The changes asked for are still open · the last review didn't finish");
  assert.ok(!noIds.message.includes("answer by id") && noIds.message.includes("- the defect"));

  // Ship's line: the same words as builder.rs::handed_over_ship_summary.
  assert.equal(handedOverShipLine(got), "Shipped with 2 open findings from round 5's review, not re-checked: F3, F4.");
  assert.equal(handedOverShipLine({ snapshotN: 5, findingIds: ["F4"] }), "Shipped with 1 open finding from round 5's review, not re-checked: F4.");

  // The header leads with it, Back to the Builder as the primary.
  const header = handedOverPresentation("ready-to-ship", got)!;
  assert.equal(header.label, got.line);
  assert.equal(header.actionLabel, "Back to the Builder");
  assert.equal(header.actionId, "send-handed-over");
  assert.match(header.helper, /Ship is not blocked/);
  assert.equal(handedOverPresentation("challenger-reviewing", got), null);
  assert.equal(handedOverPresentation("ready-to-ship", null), null);
  // The automatic message on the follow-up's failure no longer says
  // nothing is needed while a request is owed.
  const failedNote = reviewSettledMessage(failed, 5)!;
  assert.match(failedNote, /requested on snapshot 5 are still open and have not been sent to you yet/);
  assert.doesNotMatch(failedNote, /Nothing is needed from you/);
  assert.doesNotMatch(reviewSettledMessage(review({ snapshotN: 7 }), 5)!, /Nothing is needed from you/);
  assert.match(reviewSettledMessage(failed)!, /Nothing is needed from you\.$/);

  // F2: once the findings reached this session, the card says so and does
  // not offer to send them again; they stay open, and on Ship's line.
  const live = card(failed);
  live.builder!.ptyId = "pty-1";
  assert.equal(handedOverOwed(live.builder)!.delivery, "unsent");
  const sent = handedOverOwed(live.builder, { handedOverAt: 1, ptyId: "pty-1", state: "sent" })!;
  assert.equal(sent.delivery, "sent");
  assert.equal(sent.line, got.line, "still open");
  assert.equal(sent.status, "Sent to the Builder — still open until a review re-checks them.");
  const sentHeader = handedOverPresentation("ready-to-ship", sent)!;
  assert.equal(sentHeader.actionId, "inspect-run", "no second send");
  assert.match(sentHeader.helper, /^Sent to the Builder/);
  assert.doesNotMatch(sentHeader.helper, /has not received/);
  // Owner-side review: the label says what is owed, never who received it.
  assert.doesNotMatch(sentHeader.label, /has not received/);
  assert.equal(handedOverOwed(live.builder, { handedOverAt: 1, ptyId: "pty-1", state: "queued" })!.delivery, "queued");
  // Another session, or another hand-over, has not received them.
  assert.equal(handedOverOwed(live.builder, { handedOverAt: 1, ptyId: "pty-2", state: "sent" })!.delivery, "unsent");
  assert.equal(handedOverOwed(live.builder, { handedOverAt: 9, ptyId: "pty-1", state: "sent" })!.delivery, "unsent");
  // A failed delivery says why and can be sent again.
  const lost = handedOverOwed(live.builder, { handedOverAt: 1, ptyId: "pty-1", state: "failed", error: "pty closed" })!;
  assert.deepEqual([lost.delivery, lost.deliveryError], ["failed", "pty closed"]);
  assert.equal(handedOverPresentation("ready-to-ship", lost)!.actionId, "send-handed-over");
  assert.match(handedOverPresentation("ready-to-ship", lost)!.helper, /did not reach the Builder: pty closed Back to the Builder sends them again/);

  // The failed follow-up leaves the card where #99 put it.
  const state = deriveCardState(card(failed), { ...EMPTY_CARD_STATE_CONTEXT, outcomeFilesChanged: 3 });
  assert.ok(handedOverPresentation(state, got), `shown on ${state}`);
}

// GH #135: a verdict the Builder has not received. The card records the
// settled review as unsent, so a review that settled with the card closed
// still reaches the Builder on the next open — once, never twice — and the
// button says what its press does.
{
  const card = (
    r: BuilderReview | null,
    undelivered: { snapshotN: number; at: number } | null,
    over: Partial<NonNullable<KanbanCard["builder"]>> = {},
  ): KanbanCard => {
    const c = builderCard(r ?? review());
    c.builder!.review = r;
    c.builder!.undeliveredVerdict = undelivered;
    Object.assign(c.builder!, over);
    return c;
  };
  const asked = review({ snapshotN: 7, verdict: "changes_requested", at: 42, builderHandoff: "- F3 — P1" });

  // The review settled while the card was closed: the card owes it, and
  // says so in the Builder's absence as much as in its presence.
  const owed = verdictOwed(card(asked, { snapshotN: 7, at: 42 }).builder)!;
  assert.equal(owed.line, "Claude doesn't have the findings yet");
  assert.deepEqual([owed.snapshotN, owed.at, owed.delivery], [7, 42, "unsent"]);
  assert.equal(owed.message, reviewSettledMessage(asked));
  assert.equal(owed.sendLabel, "Send the findings to the Builder");
  assert.deepEqual([verdictNeedsSending(owed), verdictSendsItself(owed)], [true, true]);
  // With no session open, the status does not promise a send that cannot
  // happen — it names the press that makes one possible.
  assert.deepEqual([owed.sessionOpen, owed.status], [
    false,
    "The Builder has not received it. Resume the session and Plyloft sends it.",
  ]);
  // Tier 4 walk 2026-10-14: "The result" says what Now says, from the same
  // record — never "they went to the Builder session" while they have not.
  assert.equal(
    changesRequestedResultLine("Codex", owed),
    "The Reviewer (Codex) asks for changes; they have not reached the Builder, and its session is closed.",
  );
  assert.equal(
    changesRequestedResultLine("Codex", verdictOwed(card(asked, { snapshotN: 7, at: 42 }, { ptyId: "p1" }).builder)),
    "The Reviewer (Codex) asks for changes; they have not reached the Builder yet.",
  );
  assert.equal(
    changesRequestedResultLine("Codex", null),
    "The Reviewer (Codex) asks for changes; they went to the Builder session.",
  );

  // It belongs to the review that settled: a newer one, or another
  // moment, is not this verdict (the backend drops the record with it).
  assert.equal(verdictOwed(card(asked, { snapshotN: 7, at: 41 }).builder), null, "another verdict");
  assert.equal(verdictOwed(card(asked, { snapshotN: 6, at: 42 }).builder), null, "another snapshot");
  assert.equal(verdictOwed(card(asked, null).builder), null, "a card before the field owes nothing");
  assert.equal(verdictOwed(card(null, { snapshotN: 7, at: 42 }).builder), null, "no review, nothing to say");
  assert.equal(verdictOwed(null), null);
  assert.equal(verdictNeedsSending(null), false);
  // A skipped review says nothing, so nothing is owed for it.
  assert.equal(
    verdictOwed(card(review({ snapshotN: 7, status: "skipped", verdict: null, at: 42 }), { snapshotN: 7, at: 42 }).builder),
    null,
  );
  // A failed review owes what it has to say too.
  assert.equal(
    verdictOwed(card(review({ snapshotN: 7, status: "failed", verdict: null, at: 42 }), { snapshotN: 7, at: 42 }).builder)!.line,
    "Claude doesn't have the review yet",
  );
  assert.equal(
    verdictOwed(card(review({ snapshotN: 7, at: 42 }), { snapshotN: 7, at: 42 }).builder)!.line,
    "Claude doesn't have the review yet",
  );
  assert.equal(
    verdictOwed(card(review({ snapshotN: 7, verdict: "approve", at: 42 }), { snapshotN: 7, at: 42 }).builder)!.line,
    "Claude doesn't have the review yet",
  );

  // GH #129: when findings are owed beside it, the message says so.
  const withHandOver = card(asked, { snapshotN: 7, at: 42 }, {
    handedOver: { snapshotN: 5, findingIds: ["F3"], handoff: "- F3", at: 1 },
  });
  assert.equal(verdictOwed(withHandOver.builder)!.message, reviewSettledMessage(asked, 5));

  // Sent once, never twice: the delivery is marked per session (`ptyId`),
  // exactly as GH #129's is, and a session that has it is not sent it again.
  const live = card(asked, { snapshotN: 7, at: 42 }, { ptyId: "pty-1" });
  const fresh = verdictOwed(live.builder)!;
  assert.deepEqual([fresh.sessionOpen, fresh.status], [
    true,
    "The Builder has not received it. Plyloft sends it as soon as the Builder is done with what it's doing.",
  ]);
  const sent = verdictOwed(live.builder, { at: 42, ptyId: "pty-1", state: "sent", acked: true })!;
  assert.deepEqual([sent.delivery, verdictNeedsSending(sent), verdictSendsItself(sent)], ["sent", false, false]);
  assert.equal(sent.status, "Sent to the Builder.");

  // The write landed but the card could not be told: never another write,
  // and Ply keeps trying to record it — up to a bound, then it says so.
  const unrecorded = verdictOwed(live.builder, { at: 42, ptyId: "pty-1", state: "sent", acked: false, ackAttempts: 1 })!;
  assert.deepEqual(
    [
      unrecorded.delivery,
      verdictNeedsSending(unrecorded),
      verdictSendsItself(unrecorded),
      verdictNeedsAcknowledging(unrecorded, 0),
    ],
    ["unrecorded", false, false, true],
  );
  assert.equal(unrecorded.status, "Sent to the Builder — Plyloft is still recording that it went.");
  const giveUp = verdictOwed(live.builder, {
    at: 42,
    ptyId: "pty-1",
    state: "sent",
    acked: false,
    ackAttempts: VERDICT_ACK_ATTEMPTS,
  })!;
  assert.equal(verdictNeedsAcknowledging(giveUp, 0), false, "bounded");
  assert.equal(verdictNeedsSending(giveUp), false, "the Builder has it: never a second write");
  assert.match(giveUp.status, /^Sent to the Builder, but Plyloft could not record that it went/);

  // Nothing owed is nothing to send, by any route.
  assert.deepEqual(
    [verdictNeedsSending(null), verdictSendsItself(null), verdictNeedsAcknowledging(null, 0)],
    [false, false, false],
  );
  assert.deepEqual(
    [verdictNeedsSending(undefined), verdictSendsItself(undefined), verdictNeedsAcknowledging(undefined, 0)],
    [false, false, false],
  );
  // A new session has not received it; nor has one given another verdict.
  assert.equal(verdictOwed(live.builder, { at: 42, ptyId: "pty-2", state: "sent", acked: true })!.delivery, "unsent");
  assert.equal(verdictOwed(live.builder, { at: 9, ptyId: "pty-1", state: "sent", acked: true })!.delivery, "unsent");
  // A failed send says why and is offered again.
  const lost = verdictOwed(live.builder, { at: 42, ptyId: "pty-1", state: "failed", error: "pty closed" })!;
  assert.deepEqual([lost.delivery, lost.deliveryError, verdictNeedsSending(lost)], ["failed", "pty closed", true]);
  assert.equal(lost.status, "It did not reach the Builder: pty closed");
  // A failed write is offered again, but Ply does not retry it by itself:
  // a PTY that keeps refusing is not written to in a loop.
  assert.equal(verdictSendsItself(lost), false);

  // 1.171.0 C2 (CF11): only findings have a press; anything else is no
  // "verdict" to send — Plyloft delivers it by itself.
  const approval = verdictOwed(card(review({ snapshotN: 7, verdict: "approve", at: 42 }), { snapshotN: 7, at: 42 }).builder)!;
  assert.equal(approval.findings, false);
  // 1.172.0 E2: its press exists only once Codex's screen kept it.
  assert.equal(approval.sendLabel, "Send it again");
  assert.equal(verdictShownAsWork(approval, review({ verdict: "approve" })), false);

  // F2: the button says what it does. Owed → it sends; not owed → it opens
  // the Builder; either way the helper names the press that starts the
  // next review, because that is the part people get wrong.
  const base = CARD_STATE_PRESENTATION["changes-requested"];
  const owedHeader = changesRequestedPresentation("changes-requested", base, owed)!;
  assert.equal(owedHeader.label, owed.line);
  assert.equal(owedHeader.actionLabel, "Send the findings to the Builder");
  assert.equal(owedHeader.actionId, "send-handed-over");
  assert.equal(owedHeader.actionLabel, owed.sendLabel, "the header and the Run step say the same thing");
  assert.match(owedHeader.helper, /has not received them, and its session is closed\./);
  assert.match(owedHeader.actionTitle!, /Resume the session first/);
  const openSession = changesRequestedPresentation("changes-requested", base, verdictOwed(live.builder)!)!;
  assert.match(openSession.helper, /has not received them\./);
  assert.match(openSession.actionTitle!, /Sends them into the Builder session/);
  // Walk of #378: no "Build done in the session" while it is closed.
  assert.match(owedHeader.helper, /Resume the session or Start fresh first: the findings go to it, and Finish and check there starts the next review\./);
  assert.doesNotMatch(owedHeader.helper, /Finish and check in the session/);
  assert.match(openSession.helper, /Finish and check in the session saves the fixes and starts the next review\./);
  const againHeader = changesRequestedPresentation("changes-requested", base, lost)!;
  assert.equal(againHeader.actionLabel, "Send the findings to the Builder");
  assert.match(againHeader.helper, /did not reach the Builder: pty closed\./);
  assert.match(againHeader.actionTitle!, /again/);

  const openHeader = changesRequestedPresentation("changes-requested", base, null)!;
  assert.equal(openHeader.actionLabel, "Open the Builder");
  assert.equal(openHeader.actionId, "inspect-run");
  assert.match(openHeader.helper, /Finish and check in the session saves the fixes and starts the next review\./);
  // Once it has them, the press opens the Builder and says they are sent.
  const sentHeader = changesRequestedPresentation("changes-requested", base, sent)!;
  assert.equal(sentHeader.actionLabel, "Open the Builder");
  assert.equal(sentHeader.actionId, "inspect-run", "no second send");
  assert.match(sentHeader.helper, /^Sent to the Builder\./);
  // Only this state; the other headers keep what they had.
  assert.equal(changesRequestedPresentation("ready-to-ship", base, owed), null);
  assert.equal(changesRequestedPresentation("running", base, owed), null);

  // The state the card is actually in when a review requests changes.
  assert.equal(
    deriveCardState(card(asked, { snapshotN: 7, at: 42 }, { snapshots: [{ n: 7, sha: "e", at: 2 }] }), {
      ...EMPTY_CARD_STATE_CONTEXT,
      outcomeFilesChanged: 3,
    }),
    "changes-requested",
  );
}

// GH #135: the rules live in `verdictDelivery.ts` and are driven
// end to end by `verdictDelivery.test.ts`. What is left to pin here is
// that the UI and the store route through them rather than keeping a
// second copy: the Run step sends what the card records as owed, instead
// of watching for a running → settled transition it can only see while it
// is mounted. Asserted on the source; the components import Tauri.
{
  const runStep = readFileSync(new URL("../components/BuilderRunStep.tsx", import.meta.url), "utf8");
  const store = readFileSync(new URL("../store/builderStore.ts", import.meta.url), "utf8");
  assert.match(runStep, /verdictOwed\(builder, useBuilder\(\(s\) => s\.verdictDelivery\[card\.id\]\), Boolean\(card\.prReview\)\)/);
  assert.match(runStep, /if \(promptIdle && verdictSendsItself\(owedVerdict\)\) \{/);
  assert.match(runStep, /void sendVerdict\(ws, card\.id, owedVerdict, "auto"\);/);
  assert.match(runStep, /if \(verdictNeedsAcknowledging\(owedVerdict, Date\.now\(\)\)\) void ackVerdict\(/);
  // The coordinator is only ever handed the session the card itself
  // names, so a delivery is never recorded against a PTY that never had it.
  assert.match(store, /if \(!rt \|\| !onCard \|\| rt\.ptyId !== onCard\) return null;/);
  // GH #135 (owner-side review, F2): the schedule itself lives in the
  // coordinator and is driven by `verdictDelivery.test.ts`. What is left
  // here is that the store books it whenever a delivery is recorded, on
  // real timers, and that a session that ends leaves it standing.
  assert.match(
    store,
    /record: \(delivery\) => \{[\s\S]{0,600}?scheduleVerdictAck\(cardId, verdictDeps\(workspaceId, cardId\), verdictAckTimers\);/,
  );
  assert.match(store, /setTimeout\([\s\S]{0,200}?fire\(\);/);
  // Owner-side review: detach does NOT cancel the booked acknowledgement —
// it writes no PTY, and cancelling it left the verdict owed to the next
// session, which then heard it twice.
assert.doesNotMatch(store, /detach:[\s\S]{0,600}?verdictAckTimers\.clear\(cardId\);/);
  assert.doesNotMatch(runStep, /lastReviewKey/, "the mounted-only transition is gone");
  assert.doesNotMatch(runStep, /reviewSettledMessage/, "the message comes from what the card owes");

  assert.match(store, /deliverVerdict\(cardId, owed, verdictDeps\(workspaceId, cardId\), reason\)/);
  assert.match(store, /acknowledgeVerdict\(cardId, owed, verdictDeps\(workspaceId, cardId\)\)/);
  assert.match(store, /builderVerdictDelivered\(workspaceId, cardId, snapshotN, at\)/);
  // The verdict never joins the Builder's held-message queue: that is what
  // let a superseded one still be written (owner-side review, F1).
  const deps = store.slice(store.indexOf("function verdictDeps("));
  const depsBody = deps.slice(0, deps.indexOf("\n}\n"));
  assert.ok(depsBody.includes("writePaste"), "the deps are what was sliced");
  for (const queue of ["heldWaiters", "pending"]) {
    assert.doesNotMatch(depsBody, new RegExp(queue), `the verdict is not ${queue}-queued`);
  }

  const panel = readFileSync(new URL("../components/CardDetailPanel.tsx", import.meta.url), "utf8");
  // P-A (UX P1 point 2): the Now box's words are `presentCard`'s, which lays
  // the verdict's presentation over the state for every surface.
  const presenter = readFileSync(new URL("./cardPresentation.ts", import.meta.url), "utf8");
  assert.match(presenter, /changesRequestedPresentation\(/);
  assert.match(panel, /presentCard\(card, live\)/);
  assert.match(panel, /sendVerdict\(card\.workspaceId, card\.id, owedVerdict, "press"\)/);
}

// CL-2: the "Followed" chips — stored on new reviews, read from the
// excerpt on older ones.
{
  assert.deepEqual(skillsFollowedOf(null), []);
  assert.deepEqual(skillsFollowedOf({ excerpt: "## Verdict\nAPPROVE\n" }), []);
  const stored = [{ skill: "review-rules", note: "RR-OK-1" }];
  assert.deepEqual(
    skillsFollowedOf({ skillsFollowed: stored, excerpt: "## Verdict\nAPPROVE\nFollowed: other\n" }),
    stored,
    "a stored list wins over the excerpt",
  );
  // An older review: the names from the Followed line, the notes from the
  // section the reviewer's answer ends with.
  const older =
    "## Verdict\nAPPROVE\nFollowed: review-rules, ply:verify-before-done\n\n## Findings\nNone.\n\n" +
    "## Skills followed\n- review-rules\n\n> Ends the review with its token.\n> RR-OK-5521\n- ply:verify-before-done\n";
  // CL-11: Plyloft's own Builder skills are not shown as followed.
  assert.deepEqual(skillsFollowedOf({ excerpt: older }), [
    { skill: "review-rules", note: "Ends the review with its token.\nRR-OK-5521" },
  ]);
  // A review in passes: one line per pass, each name once; demoted headings.
  const passes =
    "## Verdict\nAPPROVE\n\n## Passes\n\n### Pass 1 of 2 — APPROVE — a.rs\n\n#### Verdict\nAPPROVE\nFollowed: review-rules\n" +
    "\n### Pass 2 of 2 — APPROVE — b.rs\n\n#### Verdict\nAPPROVE\nFollowed: review-rules, house-style\n\n#### Skills followed\n- house-style\n\n> Be brief.\n";
  assert.deepEqual(skillsFollowedOf({ excerpt: passes }), [
    { skill: "review-rules", note: "" },
    { skill: "house-style", note: "Be brief." },
  ]);
  // F1: only the line after the Verdict heading and its word counts — never
  // one inside a finding's body or a fenced block.
  const inBody =
    "## Verdict\nCHANGES_REQUESTED\n\n## Findings\n- **P2 — Parser.** It reads\nFollowed: invented\n";
  assert.deepEqual(skillsFollowedOf({ excerpt: inBody }), []);
  const inFence = "Notes:\n```\n## Verdict\nAPPROVE\nFollowed: fenced\n```\n";
  assert.deepEqual(skillsFollowedOf({ excerpt: inFence }), []);
  const noWord = "## Verdict\nFollowed: early\n";
  assert.deepEqual(skillsFollowedOf({ excerpt: noWord }), []);
  // A section without a Followed line adds no name.
  assert.deepEqual(skillsFollowedOf({ excerpt: "## Skills followed\n- ghost\n" }), []);
}

// CL-5: a round's findings, by the ids it stored — whatever later rounds
// did to their own round numbers.
{
  const f = (id: string) => ({ id, severity: "P2", preExisting: false, title: id, body: "", reviewId: "r", round: 1, state: "open", updatedRound: 1 }) as never;
  const ledger = [f("F1"), f("F2"), f("F3")];
  assert.deepEqual(ledgerOfIds(ledger, ["F3", "F1", "F9"]).map((x: { id: string }) => x.id), ["F1", "F3"]);
  assert.deepEqual(ledgerOfIds(null, ["F1"]), []);
}

// CL-11 (second walks): "Followed" showed ply:answer-the-challenger, the
// Builder's skill, beside review-rules — on a stored record too.
{
  for (const name of ["ply:answer-the-challenger", "PLY:card-brief", " ply:release-notes", "ply:verify-before-done"]) {
    assert.equal(reviewMayFollow(name), false, name);
  }
  for (const name of ["review-rules", "ply-team:walk-rule", "user:house-style", "plyloft-rules", "ply:", "answer-the-challenger"]) {
    assert.equal(reviewMayFollow(name), true, name);
  }
  assert.deepEqual(
    skillsFollowedOf({
      skillsFollowed: [
        { skill: "review-rules", note: "" },
        { skill: "ply:answer-the-challenger", note: "" },
      ],
    }),
    [{ skill: "review-rules", note: "" }],
  );
  assert.deepEqual(skillsFollowedOf({ skillsFollowed: [{ skill: "ply:answer-the-challenger", note: "" }] }), []);
  assert.deepEqual(skillsFollowedOf({ excerpt: "## Verdict\nCHANGES_REQUESTED\nFollowed: review-rules, ply:answer-the-challenger\n" }), [
    { skill: "review-rules", note: "" },
  ]);
}

// CL-11: a finished review's verdict has a key; nothing else does.
{
  const base = { snapshotN: 2, at: 50 };
  assert.equal(reviewVerdictKey({ ...base, status: "done", verdict: "changes_requested", reviewId: "r1" }), "r1");
  assert.equal(reviewVerdictKey({ ...base, status: "done", verdict: "approve" }), "2@50");
  assert.equal(reviewVerdictKey({ ...base, status: "running" }), null);
  assert.equal(reviewVerdictKey({ ...base, status: "failed" }), null);
  assert.equal(reviewVerdictKey({ ...base, status: "done", verdict: null }), null);
  assert.equal(reviewVerdictKey(null), null);
}

// Findings filter: the mark, the threshold read by the last review, the
// dismissed section, the state line and the Builder's message.
{
  const f = (id: string, severity: string | null, extra: Partial<LedgerFinding> = {}): LedgerFinding => ({
    id,
    severity,
    preExisting: false,
    location: null,
    title: `${id} title`,
    body: `${id} body`,
    reviewId: "r1",
    round: 1,
    state: "open",
    reason: null,
    updatedRound: 1,
    ...extra,
  });
  // Default rule: P2 blocks, P3 is Not blocking.
  assert.equal(ledgerFindingBlocks(f("F1", "P2")), true);
  assert.equal(ledgerFindingMark(f("F1", "P2")), null);
  assert.equal(ledgerFindingMark(f("F2", "P3")), "Small note · nothing to do");
  // `P1 only` as the last review read it: the P2 is Not blocking.
  assert.equal(ledgerFindingBlocks(f("F3", "P2", { blocking: false })), false);
  assert.equal(ledgerFindingMark(f("F3", "P2", { blocking: false })), "Small note · nothing to do");
  // 1.171.0 C3 (CF25): the small notes an approval counts — open ones that
  // don't block; not the blocking, closed or dismissed ones.
  assert.equal(smallNotesCount({ ledger: [f("F2", "P3"), f("F3", "P2", { blocking: false }), f("F1", "P2"), f("F6", "P3", { state: "closed" }), f("F5", "P3", { dismissal: { at: 1, round: 1 } })] }), 2);
  assert.equal(smallNotesCount({ ledger: [], nonBlocking: [{ severity: "P3", title: "x", body: "", preExisting: false, pass: null }] }), 1);
  assert.equal(smallNotesCount(null), 0);
  // 1.172.0 Windows walk (E1): round 2 approved with no notes of its own;
  // round 1's note is still open (a follow-up never re-asks a note), so it
  // counts — said as round 1's, not as this approval's.
  const r2 = (ledger: LedgerFinding[]) => ({ ledger, round: { round: 2, new: 0, notes: 0, closed: 0, stillOpen: 0 } });
  assert.equal(reviewApprovedWord(r2([f("F1", "P3")])), "Approved (1 small note from round 1)");
  assert.equal(reviewApprovedWord(r2([f("F1", "P3"), f("F2", "P3", { round: 2, updatedRound: 2 })])), "Approved (2 small notes, 1 from round 1)");
  // Reported again by round 2: this round's note too.
  assert.equal(reviewApprovedWord(r2([f("F1", "P3", { updatedRound: 2, state: "still-open" })])), "Approved (1 small note)");
  // Closed by round 2, or dismissed: not counted.
  assert.equal(reviewApprovedWord(r2([f("F1", "P3", { state: "closed", updatedRound: 2 })])), "Approved");
  // Round 1 itself, and a review from before the rounds: as before.
  assert.equal(reviewApprovedWord({ ledger: [f("F1", "P3")], round: { round: 1, new: 0, notes: 1, closed: 0, stillOpen: 0 } }), "Approved (1 small note)");
  assert.equal(reviewApprovedWord({ ledger: [f("F1", "P3")] }), "Approved (1 small note)");
  assert.equal(
    smallNotesPhrase({ ledger: [f("F1", "P3"), f("F2", "P3", { round: 2, updatedRound: 2 })], round: { round: 3, new: 0, notes: 0, closed: 0, stillOpen: 0 } }),
    "2 small notes from earlier rounds",
  );
  // `All findings`: the P3 blocks.
  assert.equal(ledgerFindingMark(f("F4", "P3", { blocking: true })), null);
  // Dismissed: never blocks, not open, its own section and line.
  const gone = f("F5", "P1", { dismissal: { reason: "Guarded by the lock", at: 1, round: 1 } });
  assert.equal(ledgerFindingBlocks(gone), false);
  assert.equal(ledgerFindingOpen(gone), false);
  assert.equal(ledgerFindingMark(gone), "Dismissed");
  assert.equal(ledgerStateLine(gone), "Raised in round 1 · dismissed as not a real issue: Guarded by the lock");
  // Tier 4 walk 2026-10-14: who dismissed it, when the board recorded them.
  const byAna = f("F7", "P2", { dismissal: { reason: "walk test", by: "ana@example.com", at: 1, round: 2 } });
  assert.equal(ledgerStateLine(byAna), "Raised in round 1 · dismissed by ana@example.com as not a real issue: walk test");
  const sections = ledgerSections([f("F1", "P2"), gone, f("F6", "P2", { state: "closed" })]);
  assert.deepEqual(sections.open.map((x) => x.id), ["F1"]);
  assert.deepEqual(sections.dismissed.map((x) => x.id), ["F5"]);
  assert.deepEqual(sections.closed.map((x) => x.id), ["F6"]);
  // A closed finding carries no mark.
  assert.equal(ledgerFindingMark(f("F6", "P3", { state: "closed" })), null);
  // The settings row: three choices, the default in the middle, each with its line.
  assert.deepEqual(BLOCKING_CHOICES.map((c) => c.label), ["Serious only", "Serious and Should fix", "All findings"]);
  assert.match(blockingFindingsHint("p1"), /^Only serious findings keep a card in changes requested/);
  assert.match(blockingFindingsHint("p1-p2"), /Minor ones stay on the card as small notes, with nothing to do/);
  assert.match(blockingFindingsHint("all"), /Minor ones included/);
  // An approval that is Plyloft's reading says why, not "approved it".
  const lifted = reviewSettledMessage(
    review({
      verdict: "approve",
      ledgerNote: "Plyloft reads this review as APPROVE: the member dismissed F1 as not a real issue, and no other finding blocks approval.",
    }),
  )!;
  assert.match(lifted, /reviewed snapshot 5\. Plyloft reads this review as APPROVE: the member dismissed F1/);
  assert.doesNotMatch(lifted, /approved it/);
}

// Tier 4 walk 2026-10-14: The result's pull request says what the diff
// panel's Merge anyway says, and waits for Build done past the snapshot.
// 1.171.0 B3 (LG-03, LG-04): no "Ship as a PR" — the anyway label says the
// person merges it.
{
  const PLAIN = { kind: "plain", label: "Open the pull request" };
  const approved = builderCard(review({ verdict: "approve", reviewedRevision: "e" }));
  assert.deepEqual(prShipOffer(approved.builder, "e"), PLAIN);
  assert.deepEqual(prShipOffer(approved.builder, null), PLAIN);
  assert.deepEqual(prShipOffer(approved.builder, "f"), { kind: "wait", note: PR_SHIP_WAIT_NOTE });
  assert.doesNotMatch(PR_SHIP_WAIT_NOTE, /Ship as a PR/);
  const asked = builderCard(review({ verdict: "changes_requested", reviewedRevision: "e" }));
  const offer = prShipOffer(asked.builder, "e");
  assert.equal(offer.kind, "anyway");
  assert.equal(offer.kind === "anyway" && offer.label, "Open the pull request anyway (I merge it)");
  assert.equal(
    offer.kind === "anyway" && offer.note,
    "The Reviewer requested changes on round 5. Open the pull request anyway (I merge it) opens it without an approved review; the receipt and the pull request say so.",
  );
  const running = builderCard(review({ status: "running", verdict: null }));
  assert.match((prShipOffer(running.builder, "e") as { note: string }).note, /^The Reviewer is still reviewing round 5\./);
  // No Builder (a swarm card): plain, as before.
  assert.deepEqual(prShipOffer(null, "x"), PLAIN);
  // #378 (P2-1): a new session (Start fresh) keeps the approved review of the
  // unchanged last snapshot (builder.rs::review_kept_for_new_session), so
  // the offer stays plain and Merge has no gap.
  const restarted = { ...approved.builder!, ptyId: "p2", startedAt: 99 };
  assert.deepEqual(prShipOffer(restarted, "e"), PLAIN);
  assert.equal(mergeReviewGap(restarted), null);
  // 1.171.0 C3 (owner 2026-10-27): a review skipped with "Check without the
  // Reviewer" is no review — Ship ▾ offers the pull request the
  // person merges (as Rust's `unreviewed_ship_summary` says, and it never
  // merges by itself); an override stays the person's decision.
  const skipped = builderCard(review({ status: "skipped", verdict: null }));
  assert.equal(mergeReviewGap(skipped.builder), "You skipped the review of the last round.");
  assert.equal(prShipOffer(skipped.builder, null).kind, "anyway");
  const overridden = builderCard(review({ status: "skipped", verdict: null, note: "changes requested on snapshot 5, overridden by the human" }));
  assert.equal(mergeReviewGap(overridden.builder), null);
  assert.deepEqual(prShipOffer(overridden.builder, null), PLAIN);
}

// P-D2 Windows walk: the review's base note says which starting point the
// review used, without git's remote; the raw note stays under Details.
{
  for (const note of [
    "Review base: the recorded base (origin is a local path).",
    "Review base: not checked against origin (origin could not be reached) and this card has no recorded base.",
    "Local main was ahead of origin; reviewed from the recorded base.",
  ]) {
    const words = reviewBaseWords(note)!;
    assert.doesNotMatch(words, /origin|\bbase\b/i);
    assert.match(words, /Nothing to do unless the changes look wrong\.$/);
  }
  assert.match(reviewBaseWords("This card's commits are already in origin's main.")!, /already on GitHub/);
  assert.equal(reviewBaseWords(null), null);
}

// QoL 14.2 (G27): Copy findings — Markdown with location, text and verdict.
{
  const base = { snapshotN: 1, provider: "claude", degraded: false, status: "done", at: 0 } as BuilderReview;
  const md = findingsMarkdown("Review: Fix login", {
    ...base,
    verdict: "changes_requested",
    findings: [
      { severity: "P1", title: "Token leaks", body: "The token is logged.\nRemove the log line.", preExisting: false, pass: null, location: "src/auth.ts:12" },
    ],
    nonBlocking: [{ severity: "P3", title: "Name", body: "Name", preExisting: false, pass: null }],
  });
  assert.match(md, /^## Review · Review: Fix login\n\nChanges requested\n/);
  assert.match(md, /### Serious \(1\)\n- \*\*Serious\*\* — Token leaks \(`src\/auth.ts:12`\)\n  The token is logged.\n  Remove the log line./);
  assert.match(md, /### Non-blocking \(1\)\n- \*\*Minor\*\* — Name\n/);
  const ledgerMd = findingsMarkdown("T", {
    ...base,
    ledger: [
      { id: "F1", severity: "P2", preExisting: false, location: null, title: "Open one", body: "Fix it", reviewId: "r", round: 1, state: "open", reason: null, updatedRound: 1 },
      { id: "F2", severity: "P1", preExisting: false, location: null, title: "Gone", body: "x", reviewId: "r", round: 1, state: "closed", reason: null, updatedRound: 2 },
    ],
  } as BuilderReview);
  assert.match(ledgerMd, /### Open \(1\)\n- \*\*F1 · Should fix\*\* — Open one\n  Fix it/);
  assert.match(ledgerMd, /### Closed \(1\)\n- F2 · Serious — Gone/);
  assert.match(findingsMarkdown("T", base), /No blocking findings\./);
}

// 1.171.0 C1 (CF1): how many findings the Builder fixes — the ledger's open
// blocking ones, else the review's own in code the change wrote.
{
  const f = (patch: Record<string, unknown>) => ({ severity: "P1", title: "t", body: "b", preExisting: false, pass: null, ...patch });
  assert.equal(findingsToFixCount(null), 0);
  assert.equal(findingsToFixCount({ findings: [f({}), f({ preExisting: true }), f({ severity: "P2" })] } as never), 2);
  const l = (patch: Record<string, unknown>) => ({ id: "F1", severity: "P1", title: "t", state: "open", preExisting: false, ...patch });
  assert.equal(
    findingsToFixCount({
      findings: [f({})],
      ledger: [l({}), l({ id: "F2", state: "closed" }), l({ id: "F3", severity: "P3" }), l({ id: "F4", dismissal: { by: "me", reason: "no" } }), l({ id: "F5", severity: "P2" })],
    } as never),
    2,
    "open and blocking only",
  );
}

// 1.172.0 E2 (Challenger 1): a delivery Codex's transcript search or its
// message box kept, in a session that is still open, says what to do there
// — not "Resume the session" — and the search case goes in again by itself.
{
  const approved = review({ snapshotN: 7, verdict: "approve", at: 42, incompleteReason: undefined });
  const c = builderCard(approved);
  c.builder!.vendor = "codex";
  c.builder!.ptyId = "p1";
  c.builder!.snapshots = [{ n: 7, sha: "e", at: 2 }];
  c.builder!.undeliveredVerdict = { snapshotN: 7, at: 42 };
  const failedWith = (error: string, retryRequested?: boolean) =>
    verdictOwed(c.builder, { at: 42, ptyId: "p1", state: "failed", error, ...(retryRequested ? { retryRequested } : {}) })!;
  const took = failedWith(OVERLAY_TOOK_PASTE);
  assert.equal(
    took.status,
    "Codex opened its transcript search while Plyloft was typing it in. Part of it may be in the search: press Esc in the session to close it, clear Codex's message box if anything is left there, then send it again.",
  );
  // (Round 2, Challenger 2) Part of it may be left: the person's press, not
  // a resend the moment the search closes — for an approval too.
  assert.equal(verdictSendsItself(took), false);
  assert.equal(verdictShownAsWork(took, approved), true);
  assert.equal(took.sendLabel, "Send it again");
  assert.equal(verdictShownAsWork(failedWith(PASTE_STILL_UNSENT), approved), true);
  assert.equal(verdictShownAsWork(failedWith(OVERLAY_ALREADY_OPEN, true), approved), false, "goes in by itself: a note only");
  assert.equal(
    failedWith(OVERLAY_ALREADY_OPEN, true).status,
    "Codex's transcript search was open, so Plyloft didn't type it in. Press Esc in the session to close the search. Plyloft sends it again once the search is closed.",
  );
  const unsent = failedWith(PASTE_STILL_UNSENT);
  assert.equal(unsent.status, "It is in Codex's message box, unsent. Press Enter in the session to send it.");
  assert.equal(verdictSendsItself(unsent), false, "never pasted on top of itself");
  for (const owed of [took, unsent]) {
    assert.doesNotMatch(owed.status, /Resume|did not reach/);
  }
  // Any other failure keeps its words.
  assert.match(failedWith("pty closed").status, /^It did not reach the Builder: pty closed\./);
  // A closed session: the search is gone with it — Resume, as before.
  const closed = { ...c.builder!, ptyId: null };
  assert.match(
    verdictOwed(closed, { at: 42, ptyId: "p1", state: "failed", error: OVERLAY_TOOK_PASTE, retryRequested: true })?.status ?? "",
    /Resume the session and Plyloft sends it\.$/,
  );
}

console.log("challenger review presentation tests passed");
