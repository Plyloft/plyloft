import type {
  BuildDone,
  CardPresentationState,
  KanbanCard,
  SwarmStatus,
} from "../ipc";
import { prReviewCardState } from "./prReview.ts";
import { OPEN_PR_RETRY_LABEL, shipPressMode, type ShipMode } from "./shipVia.ts";
import { NO_CHECKS_TO_RUN } from "./checksWords.ts";
import { targetHere } from "./worktreeBase.ts";
import { SESSION_WORDS, agreeWithBuilderLabel } from "./deliveryWords.ts";
import { nameComesOffSentence, nameOffSentence } from "./cardClaim.ts";

/** 1.171.0 C2 (CF8): the card's headline when its Builder session is gone
 *  — the session word Closed, said of the session (the card state "Closed"
 *  is a card that finished). */
export const SESSION_CLOSED_HEADLINE = `Session ${SESSION_WORDS.closed.toLowerCase()}`;

/** 1.173.0 (F1, BI-7, owner D11): a Builder that was working when Plyloft
 *  quit asks nothing of the person — the card is On hold with Resume, in
 *  these words, on the Board and in the Inbox (`inbox.rs::PAUSED_ON_CLOSE_DETAIL`). */
export const PAUSED_ON_CLOSE_HEADLINE = "Paused when Plyloft closed";
/** Its sentence on the card. */
export const PAUSED_ON_CLOSE_HELPER =
  "Plyloft closed while the Builder was working. The card's copy is safe; Resume continues the same conversation.";

/** 1.173.0 (F1): the run is still recorded as running, its single
 *  Builder's session was lost on a restart (`kanban.rs` load:
 *  `lost_on_restart`), and no Resume has ended at once. A session the person
 *  closed (Aborted) or one that ended by itself while Plyloft ran stays
 *  "Session closed" in Needs you, and one whose self-check was under way is
 *  "Finish and check stopped". Mirrors `inbox.rs::paused_on_close`. */
export function pausedOnClose(
  card: Pick<KanbanCard, "builder" | "lastRunStatus"> &
    Partial<Pick<KanbanCard, "buildBoth" | "linkedRunId" | "linkedSwarmId">>,
): boolean {
  const b = card.builder;
  return (
    card.lastRunStatus === "running" &&
    !card.linkedRunId &&
    !card.linkedSwarmId &&
    !(card.buildBoth && !card.buildBoth.outcome) &&
    b != null &&
    !b.ptyId &&
    b.lostOnRestart === true &&
    !b.resumeFailed &&
    // Challenger 3: Plyloft quit during Finish and check's self-check — it
    // asks for Finish and check again (rule `check-stopped`), Needs you.
    !b.selfCheckStartedAt
  );
}

/** G10 (1.170.0): the title of a Ship that lands here, by the target's real
 *  name when the card knows it ("main on this Mac"); `again` after a
 *  ship that didn't go through. */
export function shipHereTitle(target?: string | null, again = false): string {
  return `Merges this card into ${targetHere(target)}${again ? " again" : ""} and runs the configured ship steps.`;
}

/**
 * v1.66.0 (UX revamp step 2 — inline lifecycle): the card stepper's
 * derivation core. Pure — the four-step lifecycle (intake → run →
 * outcome → ship) is a VIEW over card fields the app already persists;
 * no new state, no IPC (docs/ux-revamp/STEP2.md D1). Manual navigation
 * is a session-only override in `uiStore.cardStep`; the next state
 * transition (derived step changes) clears it — that's auto-advance.
 */

export type CardStep = "intake" | "run" | "outcome" | "ship";

/** A section the card page opens (`uiStore.cardStep`): a lifecycle step, or
 *  the card's Chat, which is no step of the lifecycle (card chat, part 2). */
export type CardPageSection = CardStep | "chat";

/** Every part of the card page drawn as a `CardSection`, by its
 *  `data-ply-card-section` (CardDetailPanel types its `name` with it, so a new
 *  part is added here first). The tutorial's coverage test reads the list:
 *  each part is explained by a tour step or exempted with a reason
 *  (TUTORIAL_SPEC §12.1). */
export const CARD_PAGE_PARTS = ["intake", "run", "chat", "plan", "outcome", "diff", "ship"] as const;
export type CardPagePart = (typeof CARD_PAGE_PARTS)[number];

/** Whether the open section moved between lifecycle steps — what the
 *  installed self-check records as a "step" transition. The Chat is no
 *  step: opening it from none, or closing it to none, is no transition; a
 *  step opened or closed beside it is. */
export function lifecycleStepChanged(
  previous: CardPageSection | null | undefined,
  next: CardPageSection | null | undefined,
): boolean {
  const step = (section: CardPageSection | null | undefined) => (section === "chat" ? null : section ?? null);
  return step(previous) !== step(next);
}

export const CARD_STEPS: readonly CardStep[] = [
  "intake",
  "run",
  "outcome",
  "ship",
];

export const CARD_STEP_LABELS: Record<CardStep, string> = {
  intake: "Intake",
  run: "Run",
  outcome: "Outcome",
  ship: "Ship",
};

export function stepIndex(step: CardStep): number {
  return CARD_STEPS.indexOf(step);
}

type QueueCard = Pick<
  KanbanCard,
  | "columnId"
  | "swarmTemplateId"
  | "linkedSwarmId"
  | "archived"
  | "lastRunStatus"
>;

/**
 * Frontend mirror of `kanban.rs::card_is_queue_eligible`. Keep this helper
 * view-only: backend admission remains authoritative.
 */
export function isCardSwarmQueued(card: QueueCard): boolean {
  return (
    card.columnId === "in_progress" &&
    Boolean(card.swarmTemplateId) &&
    !card.linkedSwarmId &&
    !card.archived &&
    card.lastRunStatus !== "failed"
  );
}

/**
 * G4 (launch D8): role-chain swarms are retired; no new one starts. A card's
 * swarm template still counts while a swarm can run on the card — one ran
 * there (`linkedSwarmId`), or the card is past Todo (running one, or queued
 * for one). A template on a Todo card that never ran a swarm is ignored: the
 * backend drops it when the card starts. Mirror of
 * `kanban.rs::swarm_template_in_use`.
 */
export function swarmTemplateInUse(
  card: Pick<KanbanCard, "swarmTemplateId"> &
    Partial<Pick<KanbanCard, "linkedSwarmId" | "columnId">>,
): boolean {
  return (
    Boolean(card.swarmTemplateId) &&
    (Boolean(card.linkedSwarmId) || card.columnId !== "todo")
  );
}

/** v1.112.0: the Challenger is reviewing the latest build snapshot. */
export function challengerReviewing(
  builder: KanbanCard["builder"] | undefined,
): boolean {
  return builder?.review?.status === "running";
}

/** v1.112.0: the Challenger asked for changes to the LATEST snapshot and
 * no newer snapshot exists yet. An older changes-requested verdict that a
 * later snapshot superseded does not count. */
export function challengerRequestedChanges(
  builder: KanbanCard["builder"] | undefined,
): boolean {
  const review = builder?.review;
  if (!builder || !review) return false;
  const latest = builder.snapshots[builder.snapshots.length - 1]?.n ?? 0;
  return (
    review.status === "done" &&
    review.verdict === "changes_requested" &&
    review.snapshotN === latest
  );
}

/** The snapshot list with each SHA once (first entry wins). Build done no
 *  longer records an unchanged tree twice; this keeps cards persisted
 *  before that fix from showing a repeated snapshot. */
export function uniqueSnapshots(
  snapshots: NonNullable<KanbanCard["builder"]>["snapshots"],
): NonNullable<KanbanCard["builder"]>["snapshots"] {
  // Same retention rule as builder.rs::record_snapshot — each SHA keeps its
  // LATEST position, so the number the UI shows is the one Ship reports
  // (Challenger P3 on PR #32: first-wins here disagreed with the backend
  // on legacy [A#1, B#2, B#3] lists).
  const seen = new Set<string>();
  const kept: typeof snapshots = [];
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const s = snapshots[i];
    if (seen.has(s.sha)) continue;
    seen.add(s.sha);
    kept.push(s);
  }
  return kept.reverse();
}

/** The toast for a Finish and check (or the override, 1.171.0 C3: "Agree
 *  with Claude, keep it as it is" / "Ship without these changes") that
 *  recorded no snapshot: the requested changes were overridden, the
 *  verdict still blocks Ship, or simply nothing changed. Pure copy. */
export function noNewSnapshotToast(
  result: Pick<
    BuildDone,
    "snapshot" | "reviewOverridden" | "changesRequested" | "snapshotVerified"
  > &
    Partial<Pick<BuildDone, "waitingDropped" | "waitingStarted">>,
  /** 1.168.1: the project has no checks set up — none run, none passed. */
  noChecks = false,
  /** 1.171.0 C3: the Builder's AI by name ("Claude", "Codex"). */
  ai = "Claude",
  /** U15: pressed with the session closed: the card stays Session closed, whose
   *  presses are Resume and Start fresh. */
  sessionClosed = false,
): { kind: "info" | "warn"; title: string; body: string; details: string } {
  const { n, sha } = result.snapshot;
  // UX P-D2: "round N" in the words; the snapshot and its commit in Details.
  return { ...noNewRoundWords(result, n, noChecks, ai, sessionClosed), details: `snapshot #${n} (${sha.slice(0, 8)})` };
}

function noNewRoundWords(
  result: Parameters<typeof noNewSnapshotToast>[0],
  n: number,
  noChecks: boolean,
  ai: string,
  sessionClosed: boolean,
): { kind: "info" | "warn"; title: string; body: string } {
  const at = `round ${n}`;
  // GH #124: the review left waiting with none running started now.
  if (result.waitingStarted != null) {
    return {
      kind: "info",
      title: "Review started",
      body: `Nothing changed since ${at}; the Reviewer is reviewing round ${result.waitingStarted}, which was waiting.`,
    };
  }
  // GH #124: Skip review cancelled the review waiting for the running one.
  if (result.waitingDropped && !result.reviewOverridden) {
    return {
      kind: "info",
      title: "Waiting review cancelled",
      body: `Checked without the Reviewer: it won't review ${at} once the review that's running ends.`,
    };
  }
  if (result.reviewOverridden) {
    return {
      kind: "info",
      title: "Kept as it is",
      body:
        `The changes the Reviewer requested on ${at} are recorded as overridden by you; the card can move to Ship. ` +
        (noChecks
          ? NO_CHECKS_TO_RUN
          : result.snapshotVerified
          ? "Your checks are not run again: this round already passed them."
          : "Your checks are not run again; Ship still needs this round to pass them."),
    };
  }
  // U15: nothing follows a closed session's unchanged press; say the way on.
  if (result.changesRequested && sessionClosed) {
    return {
      kind: "warn",
      title: "Nothing new to check",
      body: `Nothing changed since ${at}, and the Reviewer's request for changes on it still stands. Press Resume or Start fresh for ${ai} to fix it, or commit the fix in the card's copy.`,
    };
  }
  if (sessionClosed) {
    return {
      kind: "info",
      title: "Nothing new to check",
      body: `Nothing changed since ${at}, so the card stays as it is. Commit your work in the card's copy and press Finish and check again, or press Resume or Start fresh.`,
    };
  }
  if (result.changesRequested) {
    return {
      kind: "warn",
      title: "Nothing new to check — Ship is not reachable yet",
      body:
        `Nothing changed since ${at}, and the Reviewer's request for changes on it still stands. ` +
        // 1.171.0 C3 (CF2): the way on is the card's own press, never a
        // checked "Skip review" (it no longer appears).
        `If ${ai} disagrees with the findings and you agree, press ${agreeWithBuilderLabel(ai)} on the card; otherwise tell ${ai} what to fix.`,
    };
  }
  return {
    kind: "info",
    title: "Nothing new to check",
    body: `Nothing changed since ${at}.`,
  };
}

function builderStillOnRun(
  builder: KanbanCard["builder"] | undefined,
): boolean {
  return challengerReviewing(builder) || challengerRequestedChanges(builder);
}

/**
 * Where the card actually IS in its lifecycle (first match wins —
 * STEP2.md D1 table). `swarmActive` is the live linked-swarm check
 * (running/suspended) the caller reads from the swarm store — a
 * suspended swarm is in-flight, not terminal.
 */
export function deriveCardStep(
  card: Pick<
    KanbanCard,
    | "shipStatus"
    | "reviewStatus"
    | "lastRunStatus"
    | "columnId"
    | "swarmTemplateId"
    | "linkedSwarmId"
    | "archived"
    | "builder"
  >,
  swarmActive: boolean,
): CardStep {
  if (card.shipStatus === "shipped" || card.reviewStatus === "merged") {
    return "ship";
  }
  // Queue-eligible = waiting for a card-swarm slot (the v1.30.0 derived
  // queue predicate, mirrored from kanban.rs::card_is_queue_eligible) —
  // that's in-flight from the user's perspective, so it lives on Run.
  const queued = isCardSwarmQueued(card);
  if (card.lastRunStatus === "running" || swarmActive || queued) {
    return "run";
  }
  // v1.112.0: a Builder card stays on Run while the Challenger is reading
  // the latest snapshot or has asked for changes to it — the results land
  // in the Builder session, not on Outcome. Outcome comes once the review
  // settles (approved, skipped or failed).
  if (builderStillOnRun(card.builder)) {
    return "run";
  }
  if (
    card.lastRunStatus === "success" ||
    card.lastRunStatus === "failed" ||
    card.lastRunStatus === "aborted" ||
    card.lastRunStatus === "rate_limited"
  ) {
    return "outcome";
  }
  return "intake";
}

export type StepChipState = "done" | "active" | "todo";

/**
 * Chip state for one step given the derived progress and the step the
 * user is viewing. A past step the user navigated back to renders
 * `active` (the ring wins over the checkmark) — the stepper is not
 * one-way (decision card #12).
 */
export function stepChipState(
  step: CardStep,
  viewed: CardStep,
  derived: CardStep,
): StepChipState {
  if (step === viewed) return "active";
  return stepIndex(step) < stepIndex(derived) ? "done" : "todo";
}

// Part 3 §2.1: one canonical, first-match state order. The installed
// self-check imports this list too, so its coverage cannot drift from the
// product state machine.
export const CARD_STATES = [
  "archived",
  "shipped",
  "shipping",
  "running",
  "session-closed",
  "paused",
  "queued",
  "challenger-reviewing",
  "changes-requested",
  "checking",
  "verify-failed",
  "failed",
  "review-stale",
  "no-changes",
  "ready-to-ship",
  "result-ready",
  "intake-live",
  "closed",
  "ready",
  "draft",
] as const satisfies readonly CardPresentationState[];

export type CardState = CardPresentationState;
export type CardStateTone = "accent" | "quiet";

export type CardPrimaryActionId =
  | "plan"
  | "open-conversation"
  /** v1.106.0: open a live Builder session (Builder/Challenger model). */
  | "start-build"
  | "start-work"
  | "inspect-run"
  /** UX P1 point 3 (P-B): the Builder stopped — Finish and check, pressed
   *  from the Now box (the same press as the session's button). */
  | "finish-and-check"
  /** 1.175.0 B2: the repository's checks wait for this computer's OK —
   *  Allow and run (`checksConsent.ts`). */
  | "allow-checks"
  /** GH #257: a queued card has no run of its own yet — the Board's
   *  running and queued work is what there is to see. */
  | "see-queue"
  /** GH #129: send the request for changes a hand-over left unsent.
   *  GH #135: and the settled verdict the Builder has not received. */
  | "send-handed-over"
  | "resume-work"
  /** GH #244: a new Builder session in the same worktree, continuing. */
  | "resume-session"
  /** U16: a Resume that found no conversation leaves Start fresh to lead. */
  | "start-fresh"
  | "inspect-checks"
  | "retry-work"
  | "inspect-outcome"
  | "rerun-review"
  /** QoL 1.168 (C5): the Challenger's review failed — run it again on the
   *  last build (Ship anyway is the Now box's alternative). */
  | "review-again"
  | "ship"
  | "inspect-ship"
  /** UX P1 point 7 (P-E): a local ship stopped on a conflict — Plyloft
   *  starts the merge in the card's copy and the Builder resolves it. */
  | "ship-conflict-ask"
  /** v1.154.1 (F14, F18): an open pull request's next press. */
  | "pr-fix"
  | "pr-push-update"
  | "pr-merge"
  /** G1–G3 Challenger (2): Merge what's on GitHub now. */
  | "pr-merge-github-head"
  /** 1.169.1 (R1): green, waiting for a review GitHub requires — open it there. */
  | "pr-open-github"
  /** 1.174.0 A2 (P7): it merges by itself once its checks pass — turn that off. */
  | "pr-auto-merge-off"
  /** 1.170 walk: a release through a pull request on its way — open it there. */
  | "release-open-github"
  | "view-history"
  /** SP-3 round 2: built by both, compared — the two builds and their
   *  Picks are right under Now; the press brings them into view. */
  | "show-builds"
  /** Skills hub H3a (Mac walk 2): a skill card behind its library —
   *  rebuild its one commit at the library's version now. */
  | "refresh-skill"
  /** Windows walk (H6b step 9): a skill card whose newer version is shown
   *  first — delete it, then make it again from the Library. */
  | "delete-skill-card"
  /** N14 walk F14: the intake conversation ended while the card plans —
   *  end it and start a new one. */
  | "plan-again"
  /** Plan with two AIs: the card's exchange runs, waits or is paused —
   *  open its Plan view (the decision bar, Retry). */
  | "open-plan"
  /** 1.174.0 (C3): the repository's areas can't be used — Settings › Areas. */
  | "open-areas-settings";

export interface CardStatePresentation {
  label: string;
  actionLabel: string;
  /** GH #253: one sentence of what is true — never what the button does. */
  helper: string;
  tone: CardStateTone;
  actionId: CardPrimaryActionId;
  /** GH #253: what the primary does, as its tooltip. */
  actionTitle?: string;
  /** v1.154.1 (M2): how a `ship` primary ships — merged here or as a pull
   *  request. The menu offers the other one. G1: absent, or `ship_it`, is
   *  the card's Ship it, which Rust ships as the workspace says (a pull
   *  request that merges when its checks pass, or a land here). */
  shipMode?: ShipMode;
}

/** 1.171.0 C1 (CF5): Now's sentence on a card with only its title — by the
 *  AI Start build launches (`builder`) and the one planning would talk to
 *  (`planner`); `presentCard` names them. */
export function titleOnlyHelper(builder: "claude" | "codex", planner: "claude" | "codex"): string {
  const name = (v: "claude" | "codex") => (v === "codex" ? "Codex" : "Claude");
  // 1.172.0 (C1; CP-12): What you want is right under Now, and planning is
  // Now's Plan it first ▾.
  return `${name(builder)} gets only the title for now: say what you want below, or choose Plan it first to have ${name(planner)} ask you questions.`;
}
export const TITLE_ONLY_HELPER = titleOnlyHelper("claude", "claude");
/** 1.172.0 (C1): Plan it first ▾'s item on a card not planned yet ("Plan it
 *  with Codex"). */
export function planFirstLabel(planner: "claude" | "codex"): string {
  return `Plan it with ${planner === "codex" ? "Codex" : "Claude"}`;
}

export const CARD_STATE_PRESENTATION: Record<
  CardState,
  CardStatePresentation
> = {
  // GH #253: each helper is one sentence of what is true now; what the
  // button does is its `actionTitle`. The card page fills in facts from the
  // card where it has them (`cardPage.ts::nowFacts`).
  // 1.171.0 C1 (CF5): a card with only its title can start — the title is
  // the brief. 1.172.0 (C1): planning first is Now's Plan it first ▾.
  draft: {
    label: "Ready to start",
    actionLabel: "Start build",
    helper: TITLE_ONLY_HELPER,
    // 1.171.0 C1 (CF5): a title-only card's words name no AI — Now's helper
    // (`titleOnlyHelper`) names the ones this computer has. T40's words
    // otherwise (TX8), without the parenthesis 475 never had.
    actionTitle:
      "Starts the Builder in its own copy of your project, with this card's title as its brief. Nothing leaves this Mac.",
    tone: "accent",
    actionId: "start-build",
  },
  "intake-live": {
    label: "Planning with Claude",
    actionLabel: "Open the conversation",
    helper: "Claude is asking what you want, to sharpen the task.",
    actionTitle: "Show the conversation with Claude.",
    tone: "quiet",
    actionId: "open-conversation",
  },
  closed: {
    label: "Closed",
    actionLabel: "View history",
    helper: "It finished with no run on record.",
    actionTitle: "Show what happened to this card.",
    tone: "quiet",
    actionId: "view-history",
  },
  ready: {
    label: "Ready to start",
    actionLabel: "Start build",
    helper: "The brief is written and nothing has started.",
    actionTitle:
      "Starts the Builder (Claude or Codex) in its own copy of your project, with this card as its brief. Nothing leaves this Mac.",
    tone: "accent",
    actionId: "start-build",
  },
  queued: {
    label: "In line",
    actionLabel: "See the queue",
    helper: "It is waiting for a free slot.",
    actionTitle: "Show the Board's running and queued work.",
    tone: "quiet",
    actionId: "see-queue",
  },
  running: {
    label: "Working",
    // C6 (UX-6.3): the session is on the card, behind this press.
    actionLabel: "Open the Builder",
    // GH #257: the card page says when it started (`runStartedWords`).
    helper: "It is running now.",
    actionTitle: "Show the session on this card.",
    tone: "quiet",
    actionId: "inspect-run",
  },
  "session-closed": {
    label: SESSION_CLOSED_HEADLINE,
    actionLabel: "Resume",
    helper: "Nothing is running this build, and its copy is safe.",
    actionTitle:
      "Opens a new session in the card's copy and continues the conversation.",
    tone: "accent",
    actionId: "resume-session",
  },
  "challenger-reviewing": {
    label: "Reviewing",
    actionLabel: "Open the Builder",
    helper: "The other AI is reading the latest build, read-only.",
    actionTitle: "Show the Builder session; the verdict goes there and to this card.",
    tone: "quiet",
    actionId: "inspect-run",
  },
  "changes-requested": {
    label: "Reviewer requests changes",
    // GH #135: the button says what the press does. This one only opens
    // the Run step; `changesRequestedPresentation` swaps it for
    // `Send the findings to the Builder` when they are still owed.
    actionLabel: "Open the Builder",
    // GH #135: the part people get wrong, said as a fact.
    helper: "Finish and check in the session saves the fixes and starts the next review.",
    actionTitle: "Show the Builder session.",
    tone: "accent",
    actionId: "inspect-run",
  },
  paused: {
    label: "Paused",
    actionLabel: "Resume",
    helper: "It stopped part-way, and the finished work is kept.",
    actionTitle: "Continues from the saved state. Finished work is not repeated.",
    tone: "accent",
    actionId: "resume-work",
  },
  checking: {
    label: "Running checks",
    actionLabel: "Watch the checks",
    // GH #262: the card page counts them (`checksRunningWords`).
    helper: "Plyloft is running the checks.",
    actionTitle: "Show the checks as they run.",
    tone: "quiet",
    actionId: "inspect-checks",
  },
  failed: {
    label: "Stopped",
    actionLabel: "Try again",
    // GH #253: the card page says why (`nowFacts`).
    helper: "The run stopped before it finished.",
    // 1.169.0 (C7, owner): the automatic retry is review_failure.rs's —
    // once, after RETRY_DELAY_SECS (30), only for a failure that passes
    // with time (a rate limit, a dropped connection).
    actionTitle:
      "Plyloft never starts new work on its own; a review that failed for a passing reason is tried once more after 30 s.",
    tone: "accent",
    actionId: "retry-work",
  },
  "verify-failed": {
    label: "Checks failed",
    actionLabel: "See what failed",
    // GH #262: the card page counts them (`checksFailedWords`).
    helper: "The checks failed.",
    actionTitle: "Show the checks and what they reported.",
    tone: "accent",
    actionId: "inspect-checks",
  },
  "result-ready": {
    label: "Preparing the result",
    // 1.172.0 (C2; CP-5): it opens the Review — one noun per thing.
    actionLabel: "See the review",
    helper: "Plyloft is reading the result from the card's copy of your project.",
    actionTitle: "Open the Review: the checks and the Reviewer's verdict.",
    tone: "quiet",
    actionId: "inspect-outcome",
  },
  "review-stale": {
    label: "Review is out of date",
    actionLabel: "Run the review again",
    helper: "The branch moved after this review ran.",
    actionTitle: "Review the branch as it is now.",
    tone: "accent",
    actionId: "rerun-review",
  },
  "no-changes": {
    label: "Nothing changed",
    // 1.172.0 D2 (CP-5): it opens the Review, by that name.
    actionLabel: "See the review",
    helper: "The run finished without a change to land.",
    actionTitle: "Open the Review: what the run reported.",
    tone: "accent",
    actionId: "inspect-outcome",
  },
  "ready-to-ship": {
    label: "Ready to ship",
    actionLabel: "Ship it",
    // GH #253: the card page says the files, the checks and the review.
    helper: "It is built and ready to ship.",
    actionTitle: shipHereTitle(),
    tone: "accent",
    actionId: "ship",
  },
  shipping: {
    label: "Shipping",
    actionLabel: "Watch it ship",
    // A ship may open a pull request instead of merging (SL-0 app tester).
    helper: "It is shipping now.",
    actionTitle: "Show the ship as it runs.",
    tone: "quiet",
    actionId: "inspect-ship",
  },
  shipped: {
    label: "Shipped",
    actionLabel: "View the shipped result",
    // GH #253: the card page says the version and the day.
    helper: "It shipped.",
    // 1.172.0 D2 (CP-21): its pull request on GitHub, or the one receipt.
    actionTitle: "Opens its pull request on GitHub, or shows what shipped.",
    tone: "quiet",
    actionId: "inspect-ship",
  },
  archived: {
    label: "Archived",
    actionLabel: "View history",
    helper: "It is archived.",
    actionTitle: "Show what happened to this card.",
    tone: "quiet",
    actionId: "view-history",
  },
};

/**
 * GH #104 (ADR 0005): the post-ship lesson is retired, so this is a map lookup
 * again. It kept a `proposal` argument only to tell "drafting" from "not started
 * yet" — two sub-states of a feature that no longer exists.
 */
export function cardStatePresentation(state: CardState): CardStatePresentation {
  return CARD_STATE_PRESENTATION[state];
}

/** OB-14 (§13.3): the planning words name the vendor that plans the card —
 *  its Builder vendor when ready, else the other (`intakeVendorFor`). Only the
 *  plan and conversation presentations name a vendor; Claude's are as they
 *  were. */
export function withPlanner(
  p: CardStatePresentation,
  planner: "claude" | "codex",
): CardStatePresentation {
  if (planner === "claude" || (p.actionId !== "plan" && p.actionId !== "open-conversation")) return p;
  const swap = (t: string) => t.replace(/\bClaude\b/g, "Codex");
  return {
    ...p,
    label: swap(p.label),
    actionLabel: swap(p.actionLabel),
    helper: swap(p.helper),
    actionTitle: p.actionTitle ? swap(p.actionTitle) : p.actionTitle,
  };
}

/** P-A: the word of a Ship press that didn't go through, on every surface
 *  (`cardPresentation.ts::SHIP_FAILED_HEADLINE`). */
export const SHIP_FAILED_LABEL = "Ship didn't go through";
/** GH #306: what a failed Ship says where the card had no sentence of its
 *  own to keep (Ready to ship, or — UX P-A Windows walk 2 — a conflict the
 *  failed press outdates). */
export const SHIP_FAILED_SENTENCE = "The last ship stopped before it finished, and the card's work is kept. Fix what stopped it, then try again.";

/** The ship presses a failure on the card can come from, by id (1.171.0
 *  B3, CP-27 — `shipPressLabel` names them): Ship it, and Ship ▾'s pull
 *  request that merges when checks pass (`pr`), pull request only and Only
 *  on this Mac. */
export type ShipPress = "ship-it" | "pr" | "pr-only" | "only-here";

/** A Ship that didn't go through, as the card says it: the press that
 *  failed, or — H6b (Windows walk) — a skill card's pull request refused
 *  because it starts from a local target holding commits GitHub's lacks
 *  (`commands::skill_pr_carries_local_commits`). That one never goes
 *  through again the same way; Ship it (a local land) does. */
export type ShipFailure = ShipPress | "skill-pr-local" | "teammate" | `pr-open:${ShipPress}`;

/** 1.171.0 B3 (Challenger 3): a press whose push reached GitHub and whose
 *  pull request didn't open (`prOpenFailure`) — its one retry is Open the
 *  pull request, on the error and as Now's primary. */
export function prOpenShipFailure(press: ShipPress): ShipFailure {
  return `pr-open:${press}`;
}

/** The press a failure repeats (null: the skill card's local refusal). */
export function failedShipPress(failed: ShipFailure): ShipPress | null {
  if (failed === "skill-pr-local" || failed === "teammate") return null;
  return failed.startsWith("pr-open:") ? (failed.slice("pr-open:".length) as ShipPress) : (failed as ShipPress);
}

/** 1.175.0 (D1): Now's sentence beside a Ship a teammate's work stopped
 *  (`teammateWork.ts`) — the box under it names them and their pull
 *  request. Pressing again would be refused again, so nothing says "Try
 *  again": Ship it stays, as a plain button, for once the two have agreed. */
export const TEAMMATE_SHIP_SENTENCE =
  "A teammate's work for this card is already on GitHub. Agree with them which work ships; Plyloft never overwrites a teammate's branch.";

/** H6b (Windows walk): the Now sentence beside that refusal. */
export const SKILL_PR_LOCAL_SENTENCE =
  "A pull request from this skill card would carry commits GitHub doesn't have yet. Ship it lands the card on this Mac, where it starts.";

/**
 * GH #306: the Now callout after a Ship that didn't go through. The card is
 * still the state `deriveCardState` says (its work is unchanged), but the
 * callout beside the ship's ErrorBlock must not say "Ready to ship": it says
 * the ship failed and its primary tries the same press again. Only a
 * presentation whose primary is `ship` changes; any other is returned as is.
 */
export function shipFailedPresentation(
  base: CardStatePresentation,
  failed: ShipFailure,
): CardStatePresentation {
  if (base.actionId !== "ship") return base;
  // H6b (Windows walk): the pull request can't go through until the target
  // is on GitHub, so the primary is the ship that can — the local land.
  if (failed === "skill-pr-local") {
    return {
      ...base,
      shipMode: "merge_live",
      label: SHIP_FAILED_LABEL,
      actionLabel: "Ship it",
      helper: SKILL_PR_LOCAL_SENTENCE,
      actionTitle: `Merges this card into ${targetHere(null)}, where it starts, and runs the configured ship steps.`,
      tone: "accent",
    };
  }
  // 1.175.0 (D1): a teammate got there first — no retry is offered.
  if (failed === "teammate") {
    return { ...base, label: SHIP_FAILED_LABEL, helper: TEAMMATE_SHIP_SENTENCE, tone: "quiet" };
  }
  const press = failedShipPress(failed) ?? "ship-it";
  const prOpen = failed.startsWith("pr-open:");
  return {
    ...base,
    // M2: Try again repeats the press that failed. G1: Ship it as Ship it
    // (the card's presentation says where it goes, `presentCard`).
    shipMode: shipPressMode(press),
    label: SHIP_FAILED_LABEL,
    // 1.171.0 B3 (Challenger 3): one label for one retry.
    actionLabel: prOpen ? OPEN_PR_RETRY_LABEL : "Try again",
    helper:
      base.helper === CARD_STATE_PRESENTATION["ready-to-ship"].helper
        ? SHIP_FAILED_SENTENCE
        : base.helper,
    // Ship it to GitHub gets its own title in `presentCard`.
    actionTitle:
      prOpen || press === "pr" || press === "pr-only"
        ? "Opens the pull request again, the same way."
        : shipHereTitle(null, true),
    tone: "accent",
  };
}

/** GH #299: a card that landed as a merged pull request, with no Ply
 *  release — "Merged", not "Shipped" (reserved for a release). SL-1: a pull
 *  request read back as merged records a ship (`shipStatus: "shipped"`) and
 *  still reads "Merged". */
export function mergedWithoutRelease(
  card: Pick<KanbanCard, "reviewStatus" | "shipStatus"> & Partial<Pick<KanbanCard, "pr">>,
): boolean {
  return (
    card.reviewStatus === "merged" &&
    (card.shipStatus !== "shipped" || card.pr?.state === "merged")
  );
}

/** GH #299: "#29" from a pull request's URL. */
export function pullRequestNumber(prUrl: string | null | undefined): string | null {
  const m = prUrl ? /\/pull\/(\d+)/.exec(prUrl) : null;
  return m ? `#${m[1]}` : null;
}

/** GH #244: a Builder card whose run is recorded as running but whose
 *  session is gone (closed, lost, or Ply restarted) — nobody runs it. */
export function builderSessionClosed(
  card: Pick<KanbanCard, "builder" | "lastRunStatus"> &
    Partial<Pick<KanbanCard, "buildBoth" | "linkedRunId" | "linkedSwarmId">>,
): boolean {
  if (closedBuilderAborted(card)) return true;
  if (card.lastRunStatus !== "running") return false;
  // v1.154.1 (walk J5, G2): a card built by both, both sessions gone — or
  // (round 3) its builds compared and the pick waiting on the person.
  if (card.buildBoth && !card.buildBoth.outcome) {
    return bothAwaitPick(card.buildBoth) || bothSessionsEnded(card.buildBoth);
  }
  return card.builder != null && !card.builder.ptyId;
}

/** F11 (team walk): closing a single Builder's session (or its ending on its
 *  own) records a run still running as aborted — `builder.rs::apply_close`.
 *  It is still a closed session, with Resume, not a failed run. Mirrors
 *  `inbox.rs::builder_session_closed`. */
export function closedBuilderAborted(
  card: Pick<KanbanCard, "builder" | "lastRunStatus"> &
    Partial<Pick<KanbanCard, "buildBoth" | "linkedRunId" | "linkedSwarmId">>,
): boolean {
  return (
    card.lastRunStatus === "aborted" &&
    // A swarm's or an agent run's abort is that run's, and a failure.
    !card.linkedRunId &&
    !card.linkedSwarmId &&
    card.builder != null &&
    !card.builder.ptyId &&
    !(card.buildBoth && !card.buildBoth.outcome)
  );
}

/** F11 review: the archive toast's body. A card whose Builder session was
 *  closed says what archiving costs it — its folder goes to the Trash, so
 *  there is nothing left to Resume; Undo is beside it. */
export function archiveToastBody(
  card: Pick<KanbanCard, "title" | "builder" | "lastRunStatus"> &
    Partial<Pick<KanbanCard, "buildBoth" | "linkedRunId" | "linkedSwarmId" | "worktreePath">>,
  /** 1.175.0 (D2): the issue the member's own name comes off with the
   *  archive (`cardClaim.ownNameComesOff`); Undo keeps it on. */
  nameOffIssue: number | null = null,
): string {
  const name = nameOffIssue != null ? ` ${nameOffSentence({ kind: "off", number: nameOffIssue })}` : "";
  if (card.builder && card.worktreePath && builderSessionClosed(card)) {
    return `${card.title}. Its Builder session was closed; archiving moves its folder to the Trash, so Resume won't be available.${name}`;
  }
  return name ? `${card.title}.${name}` : card.title;
}

/** v1.154.1 (walk J5, G2): Build with both, not decided, no live session
 *  although a build was still working (after a relaunch, or both exited).
 *  Mirrors `build_both.rs::sessions_ended`, which the Inbox reads. */
export function bothSessionsEnded(bb: NonNullable<KanbanCard["buildBoth"]>): boolean {
  return (
    !bb.outcome &&
    bb.lanes.every((l) => !l.ptyId) &&
    bb.lanes.some((l) => l.startedAt != null && !l.done && !l.failed)
  );
}

/** v1.154.1 round 3 (walk RW-B step 10): Build with both, not decided,
 *  its comparison settled (a recommendation, one build with a result, or a
 *  comparison that didn't finish): nothing runs, the person picks. Mirrors
 *  `build_both.rs::pick_words`, which the Inbox reads. */
export function bothAwaitPick(bb: NonNullable<KanbanCard["buildBoth"]>): boolean {
  return !bb.outcome && bb.compare != null && bb.compare.status !== "running";
}

const BOTH_VENDOR: Record<string, string> = { claude: "Claude", codex: "Codex" };

/** The words of a pick that waits: "Pick one of the two builds", or with
 *  one build left "Codex's build is ready to continue" (its Pick carries it
 *  on) — "Only Codex's build is left" when its checks failed — or "Neither
 *  build has a result". A build working again after its Build done is not
 *  in the card's record, so the pick still waits then; a new Build done
 *  compares again. */
export function bothPickLabel(bb: NonNullable<KanbanCard["buildBoth"]>): string {
  const c = bb.compare;
  if (c?.status === "decided") {
    const kept = bb.lanes.find((l) => l.lane === c.recommended);
    if (!kept) return "Neither build has a result";
    const name = BOTH_VENDOR[kept.vendor] ?? "Claude";
    // Challenger L2: its checks failed — it is what is left, not "ready".
    if (kept.verify?.status === "failed") return `Only ${name}'s build is left`;
    return `${name}'s build is ready to continue`;
  }
  return "Pick one of the two builds";
}

/** GH #244, v1.154.1 (F17, J5): a card whose Builder session is gone.
 *  1.171.0 C2 (CF8): one headline whether it was closed, ended by itself or
 *  a Resume ended at once ("Session ended" and "Couldn't continue" are
 *  retired); the sentence says which. A card built by both says the same
 *  until its pick waits. */
export function sessionClosedLabel(
  builder: KanbanCard["builder"],
  buildBoth?: KanbanCard["buildBoth"],
): string {
  void builder;
  if (buildBoth && !buildBoth.outcome) return bothAwaitPick(buildBoth) ? bothPickLabel(buildBoth) : SESSION_CLOSED_HEADLINE;
  return SESSION_CLOSED_HEADLINE;
}

/** v1.154.1 (walk J5): the live Builder session's state word. Once Finish
 *  and check has saved its work (`lastRunStatus` success), no request for
 *  changes is open and nothing was sent to it since that round or the last
 *  Finish and check (`doneAt`: an unchanged tree adds no snapshot; `sentAt`:
 *  a Fix paste, line comments, a hand-over, the person typing), it reads
 *  "Work saved" — working on (a TUI that keeps redrawing, Codex), quiet, or
 *  idle at its prompt with its turn over (`turnIdle`, round 3: it no longer
 *  drifts beside Ready to ship). Only a real question (asking-you with its
 *  turn not over) says "Needs your answer" then. Otherwise its silence
 *  decides, as before. */
export function liveBuilderSessionState(
  card: Pick<KanbanCard, "builder" | "lastRunStatus">,
  attention: "working" | "wants-you" | "asking-you" | null,
  sentAt: number | null = null,
  /** When Finish and check last went through here — with an unchanged tree
   *  it records no new snapshot. */
  doneAt: number | null = null,
  /** The session's last scan found its turn over at an idle prompt, no
   *  question in view (`BuilderRuntime.turnIdle`). */
  turnIdle = false,
): { id: LiveBuilderSessionStateId; label: string; dot: "running" | "done" | "aborted" } {
  // A question is `asking-you` with the turn not over; at its prompt with
  // the turn over is not (round 2's I6 in Now; round 3 RW-A).
  const question = attention === "asking-you" && !turnIdle;
  const atPrompt = attention === "asking-you" && turnIdle;
  const snapshots = card.builder?.snapshots ?? [];
  const lastSnapshotAt = snapshots[snapshots.length - 1]?.at ?? null;
  const snapshotAt =
    lastSnapshotAt == null ? null : Math.max(lastSnapshotAt, doneAt ?? lastSnapshotAt);
  if (
    !question &&
    card.lastRunStatus === "success" &&
    !challengerRequestedChanges(card.builder) &&
    snapshotAt != null &&
    (sentAt == null || snapshotAt >= sentAt)
  ) {
    return { id: "saved", label: WORK_SAVED_LABEL, dot: "done" };
  }
  if (question) return { id: "question", label: BUILDER_SESSION_WORDS.question, dot: "aborted" };
  if (atPrompt) return { id: "stopped", label: BUILDER_SESSION_WORDS.stopped, dot: "done" };
  if (attention === "wants-you") return { id: "quiet", label: BUILDER_SESSION_WORDS.quiet, dot: "aborted" };
  return { id: "working", label: BUILDER_SESSION_WORDS.working, dot: "running" };
}

/** UX P1 point 2 (P-A): what the live session's state IS, apart from its
 *  words — callers decide on this id, never on the label. `saved`: its work
 *  is saved; `stopped`: its turn is over at its prompt (P-B, was
 *  `at-prompt`). */
export type LiveBuilderSessionStateId = "saved" | "question" | "stopped" | "quiet" | "working";

/** UX P1 point 3 (P-B, owner decision D1): the press that saves the
 *  Builder's work, runs the checks and has the Challenger review it — "Build
 *  done" before. Every surface that names the press imports these. */
export const FINISH_LABEL = "Finish and check";
export const FINISH_AGAIN_LABEL = "Finish and check again";
export const FINISH_BUSY_LABEL = "Saving and checking…";
export const FINISH_TITLE =
  "Saves the Builder's work, runs your checks and has it reviewed. The session stays open.";
/** The Builder's state once Finish and check went through (open question 1).
 *  1.171.0 C2 (CF8): one of the five session words — its turn is over, so
 *  it is the person's turn ("Work saved" is retired as a session word). */
export const WORK_SAVED_LABEL = SESSION_WORDS.yourTurn;

/** The Builder header's word for each live session state — the Now table
 *  of point 3, the Board's words of point 4. 1.171.0 C2 (CF8/CF10): the
 *  five session words everywhere (`deliveryWords.ts::SESSION_WORDS`, plus
 *  `pausedLabel`): Working · Asks you something · Your turn · Closed ·
 *  Paused. A session gone quiet with no prompt in view is the person's
 *  turn too; its sentence says it may be asking something. */
export const BUILDER_SESSION_WORDS: Readonly<Record<Exclude<LiveBuilderSessionStateId, "saved">, string>> = {
  working: SESSION_WORDS.working,
  question: SESSION_WORDS.asks,
  stopped: SESSION_WORDS.yourTurn,
  quiet: SESSION_WORDS.yourTurn,
};

/** v1.154.1 (walk K3): what a screen reader hears when the Now callout
 *  changes. A primary that is off is not offered as the action: "Setting up
 *  the card. Start build is off.", not "Primary action: Start build". */
export function nowAnnouncement(label: string, actionLabel: string, disabled: boolean): string {
  return disabled ? `${label}. ${actionLabel} is off.` : `${label}. Primary action: ${actionLabel}.`;
}

/** v1.154.1 (F17): a Resume that ended at once — its headline is Session
 *  closed (1.171.0 C2); this sentence says what happened. */
export const RESUME_FAILED_HELPER =
  "The session ended as soon as it was resumed: there may be no conversation to continue in this card's copy. Start fresh opens a new session here with the brief sent again; the work so far stays.";
/** v1.154.1 round 2 (walk J1): Codex resumes the card's own conversation,
 *  found by its folder, and never another card's; when none is found the
 *  card says so. Same words as the backend's `codex_sessions::NOT_FOUND`. */
export const CODEX_RESUME_NOT_FOUND =
  "Couldn't find this card's Codex conversation, so Resume can't continue it. Start fresh opens a new session in this card's folder with the brief sent again; the work so far stays.";
/** 1.171.0 C2: Session closed's sentence when it ended by itself (Plyloft
 *  closed, or it crashed), now that the headline no longer says "ended". */
export const SESSION_ENDED_HELPER =
  "Its session ended: Plyloft closed, or it stopped by itself. The card's copy is safe; Resume continues the same conversation.";

/** U16: the words `startFreshOffer` uses for the same AI. */
export const START_FRESH_LABEL = "Start fresh";
export const START_FRESH_TITLE = "Fresh session in the card's copy with the brief sent again; the work so far stays";

export function resumeFailedHelper(vendor: string | undefined): string {
  return vendor === "codex" ? CODEX_RESUME_NOT_FOUND : RESUME_FAILED_HELPER;
}

export type ReviewFreshness = "none" | "fresh" | "stale";

export interface CardStateContext {
  linkedSwarmStatus: SwarmStatus | null;
  writerQueued: boolean;
  verificationActive: boolean;
  outcomeLoading: boolean;
  /** `null` means no outcome summary has loaded yet. */
  outcomeFilesChanged: number | null;
  shipBusy: boolean;
  shipConflict: boolean;
  reviewFreshness: ReviewFreshness;
}

export const EMPTY_CARD_STATE_CONTEXT: CardStateContext = {
  linkedSwarmStatus: null,
  writerQueued: false,
  verificationActive: false,
  outcomeLoading: false,
  outcomeFilesChanged: null,
  shipBusy: false,
  shipConflict: false,
  reviewFreshness: "none",
};

type StateCard = Pick<
  KanbanCard,
  | "archived"
  | "shipStatus"
  | "reviewStatus"
  | "lastRunStatus"
  | "columnId"
  | "swarmTemplateId"
  | "linkedSwarmId"
  | "verifyStatus"
  | "intakeStatus"
  | "notes"
  | "builder"
> &
  Partial<Pick<KanbanCard, "pr" | "prUrl" | "buildBoth" | "prReview">>;

/**
 * 1.174.0 A2 (P7): where a card's work is — sent is not landed.
 * - `not-sent`: never shipped.
 * - `sent`: in a pull request still open, or closed without merging. The
 *   card is not done: its brief can change, Follow up isn't offered, and a
 *   card waiting for it waits until the merge.
 * - `landed`: on the target branch — its pull request merged, or shipped on
 *   this Mac (Only on this Mac, a Release). A pull request shipped before
 *   Plyloft read pull requests back (a `prUrl` with no `pr`) counts as
 *   landed, as it always did: nothing on the card says otherwise.
 * Derived from `shipStatus`, `reviewStatus` (`"merged"` also marks a pull
 * request opened, `kanban.rs::set_pr_url`), `prUrl` and `pr.state`; no
 * field of its own. Mirrors `kanban.rs::card_delivery`; both are held to
 * `cardDelivery.fixtures.json`.
 */
export type CardDelivery = "not-sent" | "sent" | "landed";

type DeliveryCard = Pick<KanbanCard, "shipStatus" | "reviewStatus"> & Partial<Pick<KanbanCard, "pr" | "prUrl">>;

export function cardDelivery(card: DeliveryCard): CardDelivery {
  if (card.shipStatus === "shipped") return "landed";
  const pr = card.prUrl ? card.pr : null;
  // Round 1: an open pull request is sent, whatever `reviewStatus` says.
  if (pr?.state === "open") return "sent";
  if (card.reviewStatus === "merged") return pr && pr.state !== "merged" ? "sent" : "landed";
  if (pr?.state === "closed") return "sent";
  return "not-sent";
}

/** The card's work is on the target branch (`cardDelivery` is `landed`).
 *  Mirrors `kanban.rs::card_landed`. */
export function cardLanded(card: DeliveryCard): boolean {
  return cardDelivery(card) === "landed";
}

/** Ship it went through: the card landed, or its pull request is open (the
 *  rule `cardHasLanded` had before 1.174.0). The card's state reads as
 *  shipped then, and the Free slot is free (1.170 G2, `plan_gates.rs`).
 *  Not "done": that is `cardLanded`. Mirrors
 *  `kanban.rs::card_shipped_or_pr_open`. */
export function cardShippedOrPrOpen(
  card: Pick<KanbanCard, "shipStatus" | "reviewStatus">,
): boolean {
  return card.shipStatus === "shipped" || card.reviewStatus === "merged";
}

/**
 * v1.154.1 (F11): a card whose pull request is still open is mid-way
 * through a fix round while its Builder runs, or while a snapshot GitHub
 * doesn't have yet is being reviewed or checked — that shows first, as on a
 * card that never shipped. Otherwise (null) it reads as its pull request.
 */
function openPrFixRound(card: StateCard, context: CardStateContext): CardState | null {
  const pr = card.pr;
  if (!pr || pr.state !== "open" || !card.prUrl || card.shipStatus === "shipped") return null;
  if ((card.lastRunStatus === "running" || closedBuilderAborted(card)) && card.builder) {
    return builderSessionClosed(card) ? "session-closed" : "running";
  }
  const snapshots = card.builder?.snapshots ?? [];
  const last = snapshots[snapshots.length - 1];
  if (!last || !pr.headSha || last.sha === pr.headSha) return null;
  if (challengerReviewing(card.builder)) return "challenger-reviewing";
  if (challengerRequestedChanges(card.builder)) return "changes-requested";
  if (
    context.verificationActive ||
    card.verifyStatus === "queued" ||
    card.verifyStatus === "running"
  ) {
    return "checking";
  }
  if (card.verifyStatus === "failed") return "verify-failed";
  return null;
}

/** Part 3 §2.1. Pure, total, first match wins. */
export function deriveCardState(
  card: StateCard,
  context: CardStateContext,
): CardState {
  if (card.archived) return "archived";

  // Challenger on a pull request: the card's state is its review's (its
  // own Builder session, fixing the member's pull request, decides below).
  const reviewing = prReviewCardState(card);
  if (reviewing) return reviewing;

  if (cardShippedOrPrOpen(card)) return openPrFixRound(card, context) ?? "shipped";

  if (context.shipBusy) return "shipping";

  const suspended = context.linkedSwarmStatus === "suspended";
  if (context.linkedSwarmStatus === "running") return "running";
  if ((card.lastRunStatus === "running" || closedBuilderAborted(card)) && !suspended) {
    return builderSessionClosed(card) ? "session-closed" : "running";
  }
  if (suspended) return "paused";

  if (isCardSwarmQueued(card) || context.writerQueued) return "queued";

  // N14 F8: a card put back in To do keeps its branch, worktree and
  // snapshots, and no run (`put_back.rs` clears the run state); it reads as
  // To do — Start build picks it up again — whatever was said of its last
  // snapshot, and with no brief written (the title was the brief).
  if (
    card.columnId === "todo" &&
    card.builder &&
    card.lastRunStatus == null &&
    !challengerReviewing(card.builder) &&
    card.intakeStatus !== "active"
  ) {
    return "ready";
  }

  // v1.112.0: Builder/Challenger states outrank "checking" — while the
  // Challenger reads a snapshot, or has asked for changes to it, the card
  // is on Run and "Ready to ship" would be untrue.
  if (challengerReviewing(card.builder)) return "challenger-reviewing";
  if (challengerRequestedChanges(card.builder)) return "changes-requested";

  if (
    context.verificationActive ||
    card.verifyStatus === "queued" ||
    card.verifyStatus === "running"
  ) {
    return "checking";
  }
  if (card.verifyStatus === "failed") return "verify-failed";
  if (
    card.lastRunStatus === "failed" ||
    card.lastRunStatus === "aborted" ||
    card.lastRunStatus === "rate_limited"
  ) {
    return "failed";
  }
  if (context.reviewFreshness === "stale") return "review-stale";

  if (
    card.lastRunStatus === "success" &&
    !context.outcomeLoading &&
    context.outcomeFilesChanged === 0
  ) {
    return "no-changes";
  }
  if (
    card.lastRunStatus === "success" &&
    !context.outcomeLoading &&
    context.outcomeFilesChanged !== null &&
    context.outcomeFilesChanged > 0 &&
    !context.shipConflict
  ) {
    return "ready-to-ship";
  }
  if (card.lastRunStatus === "success") return "result-ready";
  if (card.intakeStatus === "active") return "intake-live";
  // GH #243: a card in Complete that never ran and never landed is history,
  // not work to start — GitHub sync pulls a closed issue's card there. A
  // verified card keeps its state: it may still ship (a pre-worktree card).
  if (
    card.columnId === "complete" &&
    card.lastRunStatus == null &&
    (card.verifyStatus == null || card.verifyStatus === "none" || card.verifyStatus === "legacy")
  ) {
    return "closed";
  }
  if (card.intakeStatus === "ready") return "ready";
  // v1.112.0: a card with a written brief can start a build directly —
  // the Builder takes title + notes as its brief. "Plan it with Claude"
  // stays the primary action only while the card is empty.
  if ((card.notes ?? "").trim().length > 0) return "ready";
  return "draft";
}

const STATE_STEP: Record<Exclude<CardState, "archived">, CardStep> = {
  draft: "intake",
  "intake-live": "intake",
  ready: "intake",
  queued: "run",
  running: "run",
  "session-closed": "run",
  paused: "run",
  "challenger-reviewing": "run",
  "changes-requested": "run",
  checking: "outcome",
  "verify-failed": "outcome",
  failed: "outcome",
  "review-stale": "outcome",
  "no-changes": "outcome",
  "result-ready": "outcome",
  "ready-to-ship": "outcome",
  shipping: "ship",
  shipped: "ship",
  closed: "ship",
};

export function cardStepForState(
  state: CardState,
  archivedFallback: CardStep,
): CardStep {
  return state === "archived" ? archivedFallback : STATE_STEP[state];
}

/** N14 F8: the owner's words for a card whose pull request is open, which
 *  Put back in To do refuses (`put_back.rs::OPEN_PR_REFUSAL`). */
export const PUT_BACK_OPEN_PR =
  "This card has an open pull request — merge or close it first, or archive the card.";

/** N14 F8: the card ⋯ offers Put back in To do on a card In progress, or in
 *  Complete waiting to ship with its worktree, that has not landed — and on
 *  a GitHub Issues board only one built on this Mac (never a card someone
 *  else holds). The backend decides again (`kanban_card_put_back`). */
export function putBackOffered(
  card: Pick<KanbanCard, "archived" | "columnId" | "shipStatus" | "reviewStatus" | "worktreePath"> &
    Partial<Pick<KanbanCard, "pr" | "prUrl">>,
  githubBoard: boolean,
): boolean {
  // 1.174.0 A2: a card in an open pull request hasn't landed — the ⋯ shows
  // it, off, with why (PUT_BACK_OPEN_PR), as `put_back.rs` refuses it.
  if (card.archived || cardLanded(card)) return false;
  const here = Boolean(card.worktreePath?.trim());
  if (githubBoard && !here) return false;
  return card.columnId === "in_progress" || (card.columnId === "complete" && here);
}

/** N14 walk F18: a card in To do keeps its closed Builder session's record
 *  (put back); Resume and Start fresh are not offered there — Start build is
 *  the way back. The words are the backend's refusal of a Resume
 *  (`commands.rs::RESUME_IN_TODO`). */
export const PUT_BACK_SESSION_WORDS = "This card is back at Ready to start. Start build picks it up again with the work so far.";

/** N14 F8: the confirm sheet, in the owner's words. */
export function putBackSheet(
  title: string,
  /** 1.175.0 (D2): the issue the member's own name comes off, on a GitHub
   *  Issues board (`cardClaim.ownNameComesOff`). */
  nameOffIssue: number | null = null,
): { title: string; body: string; confirmLabel: string } {
  const name = nameOffIssue != null ? ` ${nameComesOffSentence(nameOffIssue)}` : "";
  return {
    title: `Move “${title}” back to Ready to start?`,
    body: `Its Builder session stops. The branch and the work done so far are kept; Start build picks it up again.${name}`,
    confirmLabel: "Move back",
  };
}
