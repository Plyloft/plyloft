import type {
  DisagreementEntry,
  DiscussionLeg,
  DiscussionLegKind,
  DiscussionPhase,
  DiscussionStatus,
  DiscussionView,
  ReviewerCapabilityLevel,
} from "../ipc";

export const DISCUSSION_LEG_ORDER = [
  "analysis_a",
  "analysis_b",
  "cross_review_a",
  "cross_review_b",
  "synthesis",
] as const satisfies readonly DiscussionLegKind[];

export const DISCUSSION_LEG_LABELS: Record<DiscussionLegKind, string> = {
  analysis_a: "Analysis A",
  analysis_b: "Analysis B",
  cross_review_a: "Cross-review A",
  cross_review_b: "Cross-review B",
  synthesis: "Synthesis",
};

export type DiscussionPresentationMode =
  | "preflight"
  | "active"
  | "completed"
  | "terminal";

export type DiscussionSection =
  | "outcome"
  | "pin"
  | "action"
  | "setup"
  | "status"
  | "legs"
  | "attempts"
  | "synthesis"
  | "disagreements"
  | "trust";

export type DiscussionPrimaryAction =
  | { kind: "launch"; label: "Start the discussion" }
  | { kind: "stop"; label: "Stop" }
  | { kind: "resume"; label: "Resume" | "Start the discussion" }
  | null;

export interface DiscussionSynthesis {
  answer: string;
  agreements: string[];
  unresolvedQuestions: string[];
  disagreementResolutions: Array<{
    disagreementId: string;
    disposition: string;
    rationale: string;
  }>;
}

export interface DiscussionDisagreementPresentation {
  entry: DisagreementEntry;
  disposition: string | null;
  resolutionRationale: string | null;
  unresolved: boolean;
}

export interface DiscussionTrustParticipant {
  role: "Analysis A" | "Analysis B" | "Synthesizer";
  provider: "claude" | "codex";
  version: string;
  capability: ReviewerCapabilityLevel | null;
}

export interface DiscussionPresentation {
  mode: DiscussionPresentationMode;
  sections: readonly DiscussionSection[];
  statusLabel: string;
  phaseLabel: string;
  primaryAction: DiscussionPrimaryAction;
  blockedProviders: Array<"claude" | "codex">;
  retryLegs: DiscussionLegKind[];
  orderedLegs: Array<{
    kind: DiscussionLegKind;
    label: string;
    leg: DiscussionLeg;
  }>;
  synthesis: DiscussionSynthesis | null;
  disagreements: DiscussionDisagreementPresentation[];
  trust: {
    pinnedRevision: string;
    participants: DiscussionTrustParticipant[];
    synthesisAttemptCount: number;
    excludedPathCount: number;
    excludedPathsTruncated: boolean;
  };
}

const SECTION_ORDER: Record<DiscussionPresentationMode, readonly DiscussionSection[]> = {
  preflight: ["outcome", "pin", "action", "setup"],
  active: ["status", "action", "legs", "attempts"],
  completed: ["synthesis", "disagreements", "trust", "legs", "attempts"],
  terminal: ["status", "action", "legs", "attempts"],
};

const STATUS_LABELS: Record<DiscussionStatus, string> = {
  preparing: "Ready to start",
  running: "Discussion in progress",
  paused_provider_unavailable: "Provider unavailable",
  completed: "Discussion complete",
  failed: "Discussion stopped",
  aborted: "Discussion stopped",
  interrupted: "Discussion interrupted",
};

const PHASE_LABELS: Record<DiscussionPhase, string> = {
  preparing: "Preparing",
  independent_analyses: "Independent analyses",
  cross_reviews: "Cross-reviews",
  synthesis: "Synthesis",
  completed: "Complete",
};

export function discussionLeg(
  view: DiscussionView,
  kind: DiscussionLegKind,
): DiscussionLeg {
  const legs = view.record.legs;
  if (kind === "analysis_a") return legs.analysisA;
  if (kind === "analysis_b") return legs.analysisB;
  if (kind === "cross_review_a") return legs.crossReviewA;
  if (kind === "cross_review_b") return legs.crossReviewB;
  return legs.synthesis;
}

function hasAttemptEvidence(view: DiscussionView): boolean {
  return DISCUSSION_LEG_ORDER.some((kind) => {
    const leg = discussionLeg(view, kind);
    return leg.attemptCount > 0 || leg.attemptHistory.length > 0;
  });
}

function presentationMode(view: DiscussionView): DiscussionPresentationMode {
  if (view.record.status === "completed") return "completed";
  if (view.record.status === "failed" || view.record.status === "aborted") {
    return "terminal";
  }
  if (
    (view.record.status === "preparing" ||
      view.record.status === "interrupted") &&
    view.record.currentPhase === "preparing" &&
    !hasAttemptEvidence(view)
  ) {
    return "preflight";
  }
  return "active";
}

function primaryAction(
  view: DiscussionView,
  mode: DiscussionPresentationMode,
): DiscussionPrimaryAction {
  if (mode === "preflight") {
    if (view.record.status === "interrupted") {
      return { kind: "resume", label: "Start the discussion" };
    }
    return { kind: "launch", label: "Start the discussion" };
  }
  if (
    mode === "active" &&
    (view.record.status === "paused_provider_unavailable" ||
      view.record.status === "interrupted")
  ) {
    return { kind: "resume", label: "Resume" };
  }
  if (mode === "active") {
    return { kind: "stop", label: "Stop" };
  }
  return null;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseSynthesis(value: unknown): DiscussionSynthesis | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.answer !== "string") return null;
  const rawResolutions = Array.isArray(record.disagreementResolutions)
    ? record.disagreementResolutions
    : [];
  return {
    answer: record.answer,
    agreements: parseStringArray(record.agreements),
    unresolvedQuestions: parseStringArray(record.unresolvedQuestions),
    disagreementResolutions: rawResolutions.flatMap((value) => {
      if (typeof value !== "object" || value == null || Array.isArray(value)) return [];
      const item = value as Record<string, unknown>;
      if (
        typeof item.disagreementId !== "string" ||
        typeof item.disposition !== "string" ||
        typeof item.rationale !== "string"
      ) {
        return [];
      }
      return [{
        disagreementId: item.disagreementId,
        disposition: item.disposition,
        rationale: item.rationale,
      }];
    }),
  };
}

export function deriveDiscussionPresentation(
  view: DiscussionView,
): DiscussionPresentation {
  const mode = presentationMode(view);
  const orderedLegs = DISCUSSION_LEG_ORDER.map((kind) => ({
    kind,
    label: DISCUSSION_LEG_LABELS[kind],
    leg: discussionLeg(view, kind),
  }));
  const blockedProviders = Array.from(
    new Set(
      orderedLegs
        .filter(({ leg }) => leg.status !== "completed" && leg.unavailable != null)
        .map(({ leg }) => leg.provider),
    ),
  );
  const synthesis = parseSynthesis(view.record.finalResult);
  const resolutions = new Map(
    (synthesis?.disagreementResolutions ?? []).map((resolution) => [
      resolution.disagreementId,
      resolution,
    ]),
  );

  return {
    mode,
    sections: SECTION_ORDER[mode],
    statusLabel: STATUS_LABELS[view.record.status],
    phaseLabel: PHASE_LABELS[view.record.currentPhase],
    primaryAction: primaryAction(view, mode),
    blockedProviders,
    retryLegs:
      mode === "terminal"
        ? orderedLegs
            .filter(({ leg }) => leg.status === "failed")
            .map(({ kind }) => kind)
        : [],
    orderedLegs,
    synthesis,
    disagreements: view.record.disagreementLedger.map((entry) => {
      const resolution = resolutions.get(entry.id) ?? null;
      return {
        entry,
        disposition: resolution?.disposition ?? null,
        resolutionRationale: resolution?.rationale ?? null,
        unresolved: resolution == null || resolution.disposition === "unresolved",
      };
    }),
    trust: {
      pinnedRevision: view.record.source.pinnedRevision,
      participants: [
        { role: "Analysis A", ...view.record.participants.analysisA },
        { role: "Analysis B", ...view.record.participants.analysisB },
        { role: "Synthesizer", ...view.record.participants.synthesizer },
      ],
      synthesisAttemptCount: view.record.legs.synthesis.attemptCount,
      excludedPathCount: view.record.source.dirtyPaths.length,
      excludedPathsTruncated: view.record.source.dirtyPathsTruncated,
    },
  };
}

/** OB-14 (§13.4, D5): with one vendor installed, both views come from it, in
 *  two separate sessions with different roles — said once, on the result.
 *  Null for a two-vendor discussion (and for records before OB-14). */
export function singleVendorLine(record: {
  singleVendor?: boolean;
  legs: { analysisA: { provider: string } };
}): string | null {
  if (!record.singleVendor) return null;
  const who = record.legs.analysisA.provider === "codex" ? "Codex" : "Claude";
  return `Both views come from ${who}, in two separate sessions with different roles.`;
}

/** OB-14: the discussion's lede before it starts — who takes part here. */
export function discussionParticipantsLine(only: "claude" | "codex" | null): string {
  if (!only) {
    return "Claude and Codex each answer your question on their own and review each other; then one of them writes the answer. Nothing is changed in your code.";
  }
  const who = only === "codex" ? "Codex" : "Claude";
  return `Two separate ${who} sessions, with different roles, each answer your question on their own and review each other; then ${who} writes the answer. Nothing is changed in your code.`;
}
