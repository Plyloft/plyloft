import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type {
  DiscussionLeg,
  DiscussionLegKind,
  DiscussionStatus,
  DiscussionView,
} from "../ipc.ts";
import {
  DISCUSSION_LEG_ORDER,
  deriveDiscussionPresentation,
} from "./discussionPresentation.ts";

function leg(
  kind: DiscussionLegKind,
  provider: "claude" | "codex",
  status: DiscussionLeg["status"] = "pending",
): DiscussionLeg {
  return {
    kind,
    provider,
    status,
    executable: provider,
    version: `${provider}-1`,
    capability: provider === "claude" ? "harness-enforced" : "os-sandboxed",
    attemptCount: status === "pending" ? 0 : 1,
    promptDigest: "digest",
    artifact: status === "completed" ? { answer: kind } : null,
    exitCode: null,
    timedOut: false,
    writeEscaped: false,
    endRevision: null,
    unavailable: null,
    attemptHistory: [],
    diagnostics: [],
    startedAt: null,
    endedAt: null,
  };
}

function view(status: DiscussionStatus = "preparing"): DiscussionView {
  return {
    currentRevision: "abcdef123456",
    stale: false,
    record: {
      schemaVersion: 1,
      id: "discussion-1",
      workspaceId: "workspace-1",
      cardId: "card-1",
      problem: "Which design is safer?",
      source: {
        project: { displayPath: "/project", comparisonKey: "/project" },
        displayPath: "/project",
        sourceRef: "main",
        baseRevision: null,
        pinnedRevision: "abcdef123456",
        dirtyPaths: ["one.ts", "two.ts"],
        dirtyPathsTruncated: false,
      },
      participants: {
        analysisA: {
          provider: "claude",
          executable: "claude",
          version: "claude-1",
          capability: "harness-enforced",
        },
        analysisB: {
          provider: "codex",
          executable: "codex",
          version: "codex-1",
          capability: "os-sandboxed",
        },
        synthesizer: {
          provider: "claude",
          executable: "claude",
          version: "claude-1",
          capability: "harness-enforced",
        },
      },
      status,
      currentPhase: status === "completed" ? "completed" : "preparing",
      promptEnvelopeDigest: "envelope",
      legs: {
        analysisA: leg("analysis_a", "claude"),
        analysisB: leg("analysis_b", "codex"),
        crossReviewA: leg("cross_review_a", "claude"),
        crossReviewB: leg("cross_review_b", "codex"),
        synthesis: leg("synthesis", "claude"),
      },
      ledgerReady: false,
      disagreementLedger: [],
      finalResult: null,
      startedAt: 1,
      updatedAt: 1,
      endedAt: null,
    },
  };
}

const preflight = deriveDiscussionPresentation(view());
assert.equal(preflight.mode, "preflight");
assert.deepEqual(preflight.sections, ["outcome", "pin", "action", "setup"]);
assert.deepEqual(preflight.primaryAction, {
  kind: "launch",
  label: "Start the discussion",
});
assert.deepEqual(preflight.orderedLegs.map(({ kind }) => kind), DISCUSSION_LEG_ORDER);
assert.equal(preflight.trust.excludedPathCount, 2);

// Startup reconciliation intentionally marks an unlaunched prepared record as
// interrupted. It must remain a preflight presentation, while using Resume to
// preserve and open that exact pinned record instead of preparing a new one.
const startupInterruptedView = view("interrupted");
const startupInterrupted = deriveDiscussionPresentation(startupInterruptedView);
assert.equal(startupInterrupted.mode, "preflight");
assert.deepEqual(startupInterrupted.sections, ["outcome", "pin", "action", "setup"]);
assert.deepEqual(startupInterrupted.primaryAction, {
  kind: "resume",
  label: "Start the discussion",
});
assert.equal(startupInterrupted.trust.pinnedRevision, "abcdef123456");
assert.equal(startupInterrupted.trust.excludedPathCount, 2);

const runningView = view("running");
runningView.record.currentPhase = "cross_reviews";
const running = deriveDiscussionPresentation(runningView);
assert.equal(running.mode, "active");
assert.deepEqual(running.sections, ["status", "action", "legs", "attempts"]);
assert.deepEqual(running.primaryAction, { kind: "stop", label: "Stop" });

const startedPreparingView = view("preparing");
startedPreparingView.record.legs.analysisA.attemptCount = 1;
assert.equal(deriveDiscussionPresentation(startedPreparingView).mode, "active");
assert.deepEqual(
  deriveDiscussionPresentation(startedPreparingView).primaryAction,
  { kind: "stop", label: "Stop" },
);

// Any paid-attempt evidence forbids the preflight label, even when startup
// reconciliation leaves the record interrupted in the preparing phase.
const interruptedWithAttemptHistory = view("interrupted");
interruptedWithAttemptHistory.record.legs.analysisA.attemptHistory = [
  {
    number: 1,
    status: "interrupted",
    executable: "claude",
    version: "claude-1",
    capability: "harness-enforced",
    artifact: null,
    exitCode: null,
    timedOut: false,
    writeEscaped: false,
    endRevision: null,
    unavailable: null,
    error: "Plyloft exited before this discussion leg completed",
    diagnostics: [],
    startedAt: 1,
    endedAt: 2,
  },
];
const resumedAfterAttempt = deriveDiscussionPresentation(
  interruptedWithAttemptHistory,
);
assert.equal(resumedAfterAttempt.mode, "active");
assert.deepEqual(resumedAfterAttempt.primaryAction, {
  kind: "resume",
  label: "Resume",
});

const oneProviderPausedView = view("paused_provider_unavailable");
oneProviderPausedView.record.currentPhase = "independent_analyses";
oneProviderPausedView.record.legs.analysisA.unavailable = {
  kind: "quota",
  reason: "Claude quota",
  resetAt: null,
};
assert.deepEqual(
  deriveDiscussionPresentation(oneProviderPausedView).blockedProviders,
  ["claude"],
);

const pausedView = view("paused_provider_unavailable");
pausedView.record.currentPhase = "independent_analyses";
pausedView.record.legs.analysisA.unavailable = {
  kind: "quota",
  reason: "Claude quota",
  resetAt: null,
};
pausedView.record.legs.analysisB.unavailable = {
  kind: "authentication",
  reason: "Codex auth",
  resetAt: null,
};
const paused = deriveDiscussionPresentation(pausedView);
assert.deepEqual(paused.blockedProviders, ["claude", "codex"]);
assert.deepEqual(paused.primaryAction, { kind: "resume", label: "Resume" });

const interruptedView = view("interrupted");
interruptedView.record.currentPhase = "synthesis";
assert.deepEqual(deriveDiscussionPresentation(interruptedView).primaryAction, {
  kind: "resume",
  label: "Resume",
});

const completedView = view("completed");
for (const key of ["analysisA", "analysisB", "crossReviewA", "crossReviewB", "synthesis"] as const) {
  completedView.record.legs[key].status = "completed";
  completedView.record.legs[key].attemptCount = 1;
}
completedView.record.disagreementLedger = [
  {
    id: "resolved",
    raisedBy: "analysis_a",
    statement: "Resolved statement",
    rationale: "Resolved rationale",
    severity: "medium",
    evidenceRefs: [],
    relatedIds: [],
  },
  {
    id: "open",
    raisedBy: "analysis_b",
    statement: "Open statement",
    rationale: "Open rationale",
    severity: "high",
    evidenceRefs: [],
    relatedIds: [],
  },
];
completedView.record.finalResult = {
  answer: "Use the bounded design.",
  agreements: ["Keep the pin."],
  disagreementResolutions: [
    {
      disagreementId: "resolved",
      disposition: "resolved",
      rationale: "Evidence decides it.",
    },
  ],
  unresolvedQuestions: ["Who owns the follow-up?"],
};
const completed = deriveDiscussionPresentation(completedView);
assert.equal(completed.mode, "completed");
assert.deepEqual(completed.sections, [
  "synthesis",
  "disagreements",
  "trust",
  "legs",
  "attempts",
]);
assert.equal(completed.synthesis?.answer, "Use the bounded design.");
assert.equal(completed.disagreements.length, 2);
assert.equal(completed.disagreements[0]?.unresolved, false);
assert.equal(completed.disagreements[1]?.unresolved, true);
assert.equal(completed.primaryAction, null);
assert.deepEqual(completed.retryLegs, []);
assert.equal(completed.trust.synthesisAttemptCount, 1);

const failedView = view("failed");
failedView.record.currentPhase = "cross_reviews";
failedView.record.legs.analysisA.status = "completed";
failedView.record.legs.crossReviewB.status = "failed";
failedView.record.legs.crossReviewB.attemptCount = 2;
const failed = deriveDiscussionPresentation(failedView);
assert.equal(failed.mode, "terminal");
assert.deepEqual(failed.retryLegs, ["cross_review_b"]);
assert.equal(failed.primaryAction, null);

// The frozen presentation order is executable: DiscussionDetail renders the
// section array itself rather than restating each mode's hierarchy in JSX.
const modalSource = readFileSync(
  new URL("../components/DiscussionModal.tsx", import.meta.url),
  "utf8",
);
assert.match(modalSource, /presentation\.sections\.map\(\(section\) =>/);
assert.match(modalSource, /section=\{section\}/);

console.log("discussionPresentation: all assertions passed");
