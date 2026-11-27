/**
 * UX P1 point 2 (P-A): one state function for every surface. What a card
 * says — its headline, its one sentence, its column, its primary, its Inbox
 * group — is decided here, once, from the card and the same live facts on
 * every surface (`hooks/useCardLive.ts` builds them). The Board card, the
 * List row and its stage, the card page's Now box, the dependency chips, the
 * session rows and the Inbox are thin callers. Pure: no React, no store.
 *
 * `deriveCardState` (`cardLifecycle.ts`) stays the canonical first step;
 * the rules below are laid over it in one order (docs/plans/UX_P1.md, point
 * 2, "The order"). `rule` names the one that won, for tests and the
 * `data-ply-rule` attribute every surface carries.
 */
import type {
  CardPresentationState,
  KanbanCard,
  PlanExchangeStatus,
  PlanOpenCard,
  ReviewTipFacts,
  SwarmStatus,
} from "../ipc.ts";
import {
  CARD_STATE_PRESENTATION,
  EMPTY_CARD_STATE_CONTEXT,
  cardShippedOrPrOpen,
  cardStatePresentation,
  closedBuilderAborted,
  builderSessionClosed,
  BUILDER_SESSION_WORDS,
  deriveCardState,
  FINISH_AGAIN_LABEL,
  FINISH_LABEL,
  TITLE_ONLY_HELPER,
  titleOnlyHelper,
  FINISH_TITLE,
  isCardSwarmQueued,
  mergedWithoutRelease,
  resumeFailedHelper,
  START_FRESH_LABEL,
  START_FRESH_TITLE,
  SESSION_ENDED_HELPER,
  PAUSED_ON_CLOSE_HEADLINE,
  PAUSED_ON_CLOSE_HELPER,
  pausedOnClose,
  sessionClosedLabel,
  shipFailedPresentation,
  shipHereTitle,
  SHIP_FAILED_LABEL,
  SHIP_FAILED_SENTENCE,
  swarmTemplateInUse,
  withPlanner,
  type CardPrimaryActionId,
  type CardStatePresentation,
  type ReviewFreshness,
  type ShipFailure,
} from "./cardLifecycle.ts";
import {
  OPEN_PR_RETRY_LABEL,
  SHIP_IT_GITHUB_TITLE,
  shipAnywayTitle,
  shipItGoesToGitHub,
  shipWithoutAutoMergeMode,
  type ShipMode,
} from "./shipVia.ts";
import {
  SHIP_ANYWAY_LABEL,
  fixesDoneHeadline,
  fixesDoneSentence,
  fixingHeadline,
  fixingSentence,
  yourTurnHelper,
  interruptedTurnHelper,
  CHECKING_WORK_LABEL,
  CHECK_STOPPED_LABEL,
  checkStoppedSentence,
  LEAVE_LINE,
  reviewWaitSentence,
  SAVING_WAIT_SENTENCE,
  SAVING_WITHOUT_REVIEW_SENTENCE,
  FINISH_WITHOUT_REVIEW_TITLE,
  selfCheckWaitSentence,
  checksRunningWithoutReviewSentence,
} from "./deliveryWords.ts";

/** 1.171.0 re-walk (step 3): this round's review was skipped with "Check
 *  without the Reviewer" (no override note) — the checks' wait
 *  says the Challenger doesn't review it. The press itself is over by then
 *  (`doneWithoutReview` is cleared), so the review record carries it. */
export function reviewSkippedThisRound(card: Pick<KanbanCard, "builder">): boolean {
  const review = card.builder?.review;
  if (!review || review.status !== "skipped" || review.note) return false;
  const snapshots = card.builder?.snapshots ?? [];
  const last = snapshots[snapshots.length - 1]?.n;
  return last == null || review.snapshotN === last;
}

/** 1.171.0 A3: a card whose pull request was closed without merging ships
 *  again with Ship it. */
export const SHIP_IT_AGAIN_LABEL = "Ship it again";

/** 1.174.0 A2 (P7): Now's line on a card whose open pull request is ready
 *  to merge — it isn't done, and can still change. */
export function readyToMergeLine(card: Partial<Pick<KanbanCard, "shipHistory" | "worktreeBase">>): string {
  return `Merge puts it in ${targetName(shipTargetOf(card))}. You can still change it: the pull request takes a new build with Send the fixes to GitHub.`;
}
import {
  BOARD_CARD_STATE_COLLAPSE,
  PR_CLOSED_LABEL,
  STATE_ATTENTION_COLUMN,
  attentionColumnFor,
  boardCardFact,
  boardChipRunState,
  boardRunState,
  boardSaysReadyToShip,
  cardAttentionSignals,
  setupPresentation,
  type AttentionColumn,
  type AttentionGroups,
  type BoardCardStateChip,
  type BoardRunState,
  boardSortKey,
  cardShippedAt,
  shortDuration,
} from "./boardSemantics.ts";
import {
  changesRequestedPresentation,
  findingsToFixCount,
  handedOverOwed,
  handedOverPresentation,
  mergeReviewGap,
  prShipOffer,
  reviewAgainLabel,
  SKIPPED_REVIEW_GAP,
  reviewCanRunAgain,
  reviewTruth,
  reviewTruthPresentation,
  verdictOwed,
} from "./challengerReview.ts";
import type { HandedOverDelivery } from "./handedOverDelivery.ts";
import {
  CHECKING_BY_ITSELF_LABEL,
  STOPPED_CHECK_LABEL,
  STOPPED_CHECK_SENTENCE,
  checkingByItselfSentence,
  fixRoundHeldWords,
  fixRoundReviewer,
  fixingByItselfSentence,
  type FixRoundFacts,
} from "./fixRoundCheck.ts";
import { reviewWithDraftSentence } from "./prDraft.ts";
import { verdictNeedsSending, type VerdictDelivery } from "./verdictDelivery.ts";
import { BUILDING_WITH_BOTH_LABEL, buildBothNow, isUndecided } from "./buildBoth.ts";
import { ACTOR_WORDS, bothLanesActorWords, type LiveSession } from "./sessionActor.ts";
import type { BuilderWaitingState } from "./needsYou.ts";
import { openPrBoard, prCardReadyToMerge, prClosed, prHeadMoved, prOpen, prOpenSentence } from "./prStatus.ts";
import { deliveryHeadline, deliveryStage, shipTargetOf } from "./deliveryStage.ts";
import { targetName } from "./worktreeBase.ts";
import { prNowAction } from "./prFix.ts";
import { ALLOW_AND_RUN, CHECKS_OK_ACTION_TITLE, CHECKS_OK_LABEL, CHECKS_OK_SHORT, checksOkInboxDetail } from "./checksConsent.ts";
import { autoFixFailingHead } from "./prAutoFix.ts";
import { releasePrStateLabel } from "./uxError.ts";
import { machineWords } from "./platform.ts";
import type { ReleasingFacts } from "./shipRefusal.ts";

/** 1.170 walk: a card in a release through a pull request on its way. */
export const RELEASING_HEADLINE = "Releasing through a pull request";
import { prReviewCardState, prReviewLabel } from "./prReview.ts";
import { CHANGES_SENT_HELPER, CHANGES_SENT_LABEL, changesSentStands } from "./reviewChanges.ts";
import {
  ASK_BUILDER_LABEL,
  ASK_BUILDER_TITLE,
  conflictSentHelper,
  SHIP_AGAIN_LABEL,
  askBuilderOffered,
  conflictMergeStarted,
  shipConflictSentence,
  syncConflictHeadline,
} from "./shipConflict.ts";
import { TRUST_LABEL, intakeTrustHelper, trustHelper, type Vendor } from "./trustQuestion.ts";
import { sessionBlockHeadline, sessionBlockSentence } from "./sessionBlock.ts";
import {
  PLAN_AGAIN_LABEL,
  intakeStoppedHappened,
  intakeStoppedLabel,
  planAgainTitle,
} from "./intakeStopped.ts";
import { FOLLOW_UP_ASK_EMPTY, followUpAskEmpty } from "./followUp.ts";
import {
  AREAS_HELD_HEADLINE,
  AREAS_SETTINGS_LABEL,
  AREA_ASK_WHY,
  WHICH_AREA_CARD,
  startInAreaLabel,
  type NowAreaAsk,
} from "./cardArea.ts";

/** 1.174.0 C4 (P17): beside Start build on a card made from a copy while its
 *  brief is empty (Rust's `kanban::COPY_BRIEF_EMPTY`). */
export const COPY_BRIEF_EMPTY = "Say what the Builder should do first.";
/** C4: Now's headline on that card. */
export const COPY_BRIEF_EMPTY_HEADLINE = "Ready to start, once you say what you want";

/** C4: a card made from a copy, in To do, whose brief (`brief`, as typed)
 *  is still empty: Start build, Build with both and Plan stay off, as for a
 *  follow-up's empty ask (Rust's `kanban::copy_brief_empty`). */
export function copyBriefEmpty(
  card: Pick<KanbanCard, "archived" | "columnId"> & Partial<Pick<KanbanCard, "fromCopy">>,
  brief: string,
): boolean {
  return Boolean(card.fromCopy) && !card.archived && card.columnId === "todo" && !brief.trim();
}
import { blockedByLine, isHeld, startRefusal, unshippedBlockers } from "./cardDependencies.ts";
import { planCardWords } from "./planExchangeView.ts";
import { CLAIMED_BY_YOU } from "./cardClaim.ts";
import { EDIT_CHOOSE_ACTION, editInboxDetail, hasEditConflict } from "./editConflict.ts";
import { cardHasNoChecks } from "./checksWords.ts";
import type { SetupHold } from "./worktreeSetup.ts";
import { boardListRow, boardStageFor, type BoardListRow, type BoardStage } from "./boardList.ts";

// ── The words that name a card's state, defined once ─────────────────────

/** Rules 7 and 8: a CLI's folder-trust question, on every surface. */
export const TRUST_HEADLINE = TRUST_LABEL;
/** Rule 18: a local ship that stopped on a git conflict. */
export const SHIP_CONFLICT_HEADLINE = "Ship stopped on a conflict";
export const SHIP_CONFLICT_SENTENCE = "The last ship stopped on a conflict.";
/** Rule 18's headline for `card`: a ship's, or (1.170.0, G6) a bring-in's. */
export function shipConflictHeadline(card: Pick<KanbanCard, "shipConflict">): string {
  return card.shipConflict?.sync ? syncConflictHeadline(card.shipConflict.branch) : SHIP_CONFLICT_HEADLINE;
}
/** Rule 19: a ship press that didn't go through. */
export const SHIP_FAILED_HEADLINE = SHIP_FAILED_LABEL;
/** Rule 20, a result: what the Board's result rule says. */
export const RESULT_READY_HEADLINE = "Result ready";
export const READY_TO_SHIP_HEADLINE = CARD_STATE_PRESENTATION["ready-to-ship"].label;
/** "One rule about loading": the sentence while the card reads its result. */
export const READING_RESULT_SENTENCE = "Plyloft is reading the result from the card's copy.";
export const BLOCKED_HEADLINE = "Blocked";
/** 1.171.0 B1 (Challenger 5): a card shipped as a pull request before
 *  Plyloft read pull requests back — it opened on GitHub; whether it merged
 *  is not known here, so never "Merged" (nor "Shipped"). */
export const PR_OPENED_HEADLINE = "On GitHub · pull request opened";
/** The Inbox detail of rule 18's row (`inbox.rs::SHIP_CONFLICT_DETAIL`). */
export const SHIP_CONFLICT_INBOX_DETAIL = "ship stopped on a conflict";
/** 1.170.0 (G6): the start of that row's detail for a conflict met bringing
 *  in the target's changes, "conflict with main"
 *  (`inbox.rs::SYNC_CONFLICT_DETAIL_PREFIX`). */
export const SYNC_CONFLICT_INBOX_PREFIX = "conflict with ";
/** 1.170.0 (G6, Challenger): the states a bring-in's conflict is said over
 *  — none where a turn, a check or a ship is under way. */
const SYNC_CONFLICT_OVER: ReadonlySet<CardPresentationState> = new Set<CardPresentationState>([
  "result-ready",
  "no-changes",
  "failed",
  "verify-failed",
  "review-stale",
  "ready",
  "draft",
  "closed",
]);
/** H8 Mac walk: Rust's row for a skill card while its workspace is cold
 *  (`inbox.rs::SKILL_CARD_READY_DETAIL`). */
export const SKILL_CARD_READY_INBOX_DETAIL = "skill card ready to ship";
/** The Inbox action of a row that only opens its card. */
export const OPEN_CARD_ACTION = "Open card";
/** Rule 9 (P-B, points 3 and 4): a Builder waiting on the person — the
 *  headline, the sentence and the one primary, the same on every surface. */
/** U25: Now's line beside Merge when the session still asks something. */
export function leftOverQuestionLine(vendor: Vendor, prStillOpen: boolean): string {
  const asks = `${vendor === "codex" ? "Codex" : "Claude"} still asks something in its session`;
  return prStillOpen ? `${asks}; the pull request doesn't wait for it.` : `${asks}.`;
}

export function builderWaitingPresentation(
  base: CardStatePresentation,
  state: BuilderWaitingState,
  vendor: Vendor,
  /** 1.174.3: its turn over because it was cut off (`SessionFacts.turnInterrupted`). */
  turnInterrupted = false,
): CardStatePresentation {
  const who = vendor === "codex" ? "Codex" : "Claude";
  switch (state) {
    case "question":
      return {
        ...base,
        label: BUILDER_SESSION_WORDS.question,
        helper: `${who} asked you something. Answer it in the session.`,
        actionId: "inspect-run",
        actionLabel: "Open the Builder",
        actionTitle: "Show the session, where the question is.",
        tone: "accent",
        shipMode: undefined,
      };
    case "stopped":
      return {
        ...base,
        label: BUILDER_SESSION_WORDS.stopped,
        helper: turnInterrupted ? interruptedTurnHelper(who) : builderStoppedSentence(who),
        actionId: "finish-and-check",
        actionLabel: FINISH_LABEL,
        actionTitle: FINISH_TITLE,
        tone: "accent",
      };
    case "quiet":
      return {
        ...base,
        label: BUILDER_SESSION_WORDS.quiet,
        helper: builderQuietSentence(who),
        actionId: "inspect-run",
        actionLabel: "Open the Builder",
        actionTitle: "Show the session.",
        tone: "accent",
      };
  }
}

/** Rule 9, the Builder's turn over (Your turn): when to press Finish and
 *  check. 1.171.0 C2 (CF8): by the AI's name, no "stopped". */
export function builderStoppedSentence(ai: string): string {
  return `${yourTurnHelper(ai)} When it's finished, Finish and check tests it and has it reviewed.`;
}
export const BUILDER_STOPPED_SENTENCE = builderStoppedSentence("Claude");
/** 1.172.0 E3: Now's line while Codex's transcript search is open in the
 *  card's session (`codexOverlayOpen`). */
export const CODEX_SEARCH_OPEN_SENTENCE = "Codex's search is open in the session. Press Esc there to close it.";
/** Rule 9, the Builder quiet with no prompt in view: Your turn, hedged. */
export function builderQuietSentence(ai: string): string {
  return `${ai} hasn't printed anything for a while. Look at the session: it may be asking something.`;
}

/** GH #310: the Inbox action of a card that can ship now. */
export const SHIP_IT_ACTION = "Ship it";
/** GH #310 / #333: a ready card's Inbox detail, by what its checks did. */
export const READY_TO_SHIP_INBOX_DETAIL = {
  passed: "Ready to ship · checks passed",
  none: "Ready to ship · no checks set up",
  skipped: "Ready to ship · checks skipped",
} as const;

/** Which of `READY_TO_SHIP_INBOX_DETAIL` a ready card's checks say. */
export function readyToShipChecks(
  card: Pick<KanbanCard, "verifyStatus" | "verifyHistory">,
): keyof typeof READY_TO_SHIP_INBOX_DETAIL {
  if (card.verifyStatus === "skipped") return "skipped";
  return cardHasNoChecks(card) ? "none" : "passed";
}
/** Skills hub H3a: a skill card behind its team library. */
export const SKILL_BEHIND_LABEL = "The team changed this skill again";
export const SKILL_BEHIND_HELPER =
  "The team library has a newer version of this skill than the card carries. Refresh card puts that version in the card; then ship it.";
/** Windows walk (H6b step 9): the newer version brings a new or changed
 *  script or file that is not text, which Refresh card won't take in
 *  unseen — the card says so up front and offers the way that works. */
export function skillBehindShowFirstHelper(what: "script" | "file", verb: "Install" | "Update"): string {
  const brings = what === "script" ? "a new or changed script" : "a new or changed file that is not text";
  return `The team library's newer version of this skill brings ${brings}, so Plyloft won't put it in this card without showing it to you. Delete this card, then press ${verb} in the Library: it shows every file first.`;
}

// ── Inputs ─────────────────────────────────────────────────────────────

/** What the card page reads from its result and its review (OutcomeScreen),
 *  shared through `cardFactsStore`. */
export type OutcomeFacts = {
  loading: boolean;
  /** Null: no count has loaded. */
  filesChanged: number | null;
  shipBusy: boolean;
  noRemote: boolean;
  /** G1: the project can take a pull request (`CardOutcome.hasRemote ===
   *  true`) — with the workspace's `shipVia`, whether Ship it goes to
   *  GitHub. Absent: not known. */
  prOffered?: boolean;
  reviewFreshness: ReviewFreshness;
};

/** A live Builder session as this window sees it (points 3, 4, 8 add to
 *  `state` and `block`; P-A uses the trust question). */
export type SessionFacts = {
  vendor: Vendor;
  state: "working" | "question" | "stopped" | "quiet" | "saved" | null;
  block: null | { kind: "trust" } | { kind: "bypass" } | { kind: "usageLimit"; resetsAt: string | null };
  /** P-B: it stopped waiting less than 3 s ago (`builderWaiting.ts`): the
   *  card still says so, so it does not hop columns; the Inbox, which
   *  counts the live session itself, already does not. */
  held?: boolean;
  /** 1.171.0 C1: when the session's current turn started (its start or the
   *  last message submitted into it) — the fix round's clock. */
  since?: number | null;
  /** 1.171.0 C1: Finish and check (or its self-check) is under way for it. */
  finishing?: boolean;
  /** 1.171.0 C2 (CF3): the self-check Finish and check is waiting on —
   *  since when, and whether the checklist reached the AI. Null: none (the
   *  press is saving this version). */
  selfCheck?: { since: number; delivered: boolean } | null;
  /** 1.171.0 C3 walk fix: that press is "Check without the
   *  Reviewer" — Now says the Challenger doesn't review it. */
  withoutReview?: boolean;
  /** 1.172.0 E3: Codex's transcript search is open over its composer in
   *  the card's own session — nothing Plyloft types reaches it. */
  codexSearchOpen?: boolean;
  /** 1.174.3: Resume brought back a turn that was cut off, and nothing was
   *  submitted since: Now doesn't say it's done. */
  turnInterrupted?: boolean;
};

/** SL-6: the two builds' live sessions, for the Now sentence while both build. */
export type BothLaneFacts = {
  live: { a: LiveSession | null; b: LiveSession | null };
  sentAt: { a: number | null; b: number | null };
  submittedAt: { a: number | null; b: number | null };
};

/** Everything a surface may know about a card beyond its record. Every
 *  surface builds it with `useCardLive(card)` (or `cardLiveFromStores`), so
 *  the inputs are the same. */
export type CardLive = {
  linkedSwarmStatus: SwarmStatus | null;
  writerQueued: boolean;
  verificationActive: boolean;
  reviewTip: ReviewTipFacts | null;
  planner: "claude" | "codex";
  /** 1.171.0 C1: the AI Start build launches for this card (its effective
   *  Builder choice). Absent: the planner's. */
  builderVendor?: "claude" | "codex";
  workspaceCards: readonly KanbanCard[];
  plan: Pick<PlanOpenCard, "status" | "proposer" | "critic" | "roundsDone" | "pause"> | null;
  /** Why the intake conversation stopped (`useIntakeStopReason`). */
  intakeStop: string | null;
  /** Who holds its GitHub issue when it is someone else and this Mac has
   *  not run the card, in the claim's words ("Claimed by ana"). */
  claimedByOthers: string | null;
  /** U2: this person holds its GitHub issue and this Mac has not run it:
   *  "Claimed by you" says more than "Ready to start". */
  claimedByYou?: boolean;
  /** 1.175.0 (D1): its words when a teammate is on the issue too —
   *  "Claimed by you and giulia" (`cardClaim.claimChipLabel`). */
  claimedByYouLabel?: string | null;
  /** U25: the question on screen has been there, without a break, since Ship
   *  stopped waiting for the pull request's draft. */
  draftQuestionLeft?: boolean;
  session: SessionFacts | null;
  /** 1.175.0 F5: Finish and check by itself after a Plyloft fix round
   *  (`store/fixRoundStore.ts`). Absent: nothing to say. */
  fixRound?: FixRoundFacts | null;
  /** 1.175.0 F5 round 2: a fix round on this card is checked by itself
   *  (its "After a fix round", else the setting). Absent: yes. */
  fixRoundByItself?: boolean;
  /** 1.175.0 F6: the Builder is writing the pull request's text during this
   *  review (`store/prDraftEarlyStore.ts`). Absent: no. */
  prDraftWriting?: boolean;
  intakeTrust: Vendor | null;
  both: BothLaneFacts | null;
  delivery: {
    handedOver: HandedOverDelivery | null;
    verdict: VerdictDelivery | null;
    changesSentAt: number | null;
    fixSentKey: string | null;
  };
  outcome: OutcomeFacts | null;
  shipFailure: ShipFailure | null;
  /** 1.170 walk: the release through a pull request this card is in, on
   *  its way (`lib/shipRefusal.ts::releasingOf`). Absent: none. */
  releasing?: ReleasingFacts | null;
  /** 1.175.0 F3 walk (R13): the card's land here is on GitHub since (Put it
   *  on GitHub; `store/sentToGitHubStore.ts`). Absent: no. */
  localShipOnGitHub?: boolean;
  workspace: {
    mergeWhenChecksPass: boolean;
    /** G1: how the workspace's Ship it ships (`Workspace.shipVia`). */
    shipVia?: string | null;
  };
  now: number;
  /** 1.171.0 (B1, owner D6): when this launch of Plyloft started — a merge
   *  of Plyloft's own due by a read from before it is "merges when Plyloft
   *  is open" (`prStatus.ts::openPrStage`). Absent: not known. */
  appStartedAt?: number | null;
  /** The brief as typed on the card page, not saved yet (N19's empty ask). */
  notesDraft?: string | null;
  /** Skills hub H3a: a skill card behind its team library
   *  (`useSkillCardBehind`, read by the card page); `"script"` / `"file"`
   *  (H6b) when its newer version is shown first. */
  skillBehind?: boolean | "script" | "file";
  /** 1.174.0 (C3, P9): the card page's reading of its area, in a
   *  repository with two areas or more — Now asks before Start build
   *  (`nowAreaAsk`). Absent or null: nothing to ask (and every surface but
   *  the page, which reads it). */
  areaAsk?: NowAreaAsk | null;
};

export const EMPTY_CARD_LIVE: CardLive = {
  linkedSwarmStatus: null,
  writerQueued: false,
  verificationActive: false,
  reviewTip: null,
  planner: "claude",
  workspaceCards: [],
  plan: null,
  intakeStop: null,
  claimedByOthers: null,
  session: null,
  intakeTrust: null,
  both: null,
  delivery: { handedOver: null, verdict: null, changesSentAt: null, fixSentKey: null },
  outcome: null,
  shipFailure: null,
  workspace: { mergeWhenChecksPass: false },
  now: 0,
};

/** A `CardLive` with only some facts known (tests, the record-only Inbox). */
export function cardLive(patch: Partial<CardLive> = {}): CardLive {
  return {
    ...EMPTY_CARD_LIVE,
    ...patch,
    delivery: { ...EMPTY_CARD_LIVE.delivery, ...(patch.delivery ?? {}) },
    workspace: { ...EMPTY_CARD_LIVE.workspace, ...(patch.workspace ?? {}) },
  };
}

// ── Output ─────────────────────────────────────────────────────────────

/** The rule of "The order" that won (first match). */
export type PresentationRule =
  | "archived"
  | "pr-review"
  | "blocked"
  | "claimed"
  | "choose-area"
  | "plan"
  | "setup"
  | "intake-stopped"
  | "intake-trust"
  | "session-block"
  | "builder-waiting"
  | "builder-fixing"
  | "finishing"
  | "check-stopped"
  | "checks-ok"
  | "both"
  | "changes-sent"
  | "handed-over"
  | "verdict-owed"
  | "review-truth"
  | "swarm-ready"
  | "pr-open"
  | "pr-closed"
  | "merged"
  | "session-closed"
  | "ship-conflict"
  | "skill-behind"
  | "ship-failed"
  | "releasing"
  | "base";

/** Every rule, in the order of the table (0–20). */
export const PRESENTATION_RULES: readonly PresentationRule[] = [
  "archived",
  "pr-review",
  "blocked",
  "claimed",
  "choose-area",
  "plan",
  "setup",
  "intake-stopped",
  "intake-trust",
  "session-block",
  "builder-waiting",
  "builder-fixing",
  "finishing",
  "check-stopped",
  "checks-ok",
  "both",
  "changes-sent",
  "handed-over",
  "verdict-owed",
  "review-truth",
  "swarm-ready",
  "pr-open",
  "pr-closed",
  "merged",
  "session-closed",
  "ship-conflict",
  "skill-behind",
  "ship-failed",
  "releasing",
  "base",
];

/** 1.173.0 (F1): the Inbox's groups a card's row can be in. Failed folded
 *  into Needs you; On hold holds a card Plyloft's quit paused. */
export type InboxGroupName = "needs_you" | "on_hold" | "running";

export type CardPresentation = {
  /** Canonical (`deriveCardState`), unchanged. */
  state: CardPresentationState;
  /** The Board's bounded projection of it (`BOARD_CARD_STATE_COLLAPSE`). */
  boardState: CardPresentationState;
  rule: PresentationRule;
  /** The state word, identical on every surface. */
  headline: string;
  /** One sentence of what is true (GH #253). */
  sentence: string;
  tone: "accent" | "quiet";
  dot: { state: BoardRunState; live: boolean };
  /** Rule 9 (P-B): what the Builder waits with — set only when rule 9
   *  speaks, so callers decide on it, never on the headline's words. */
  waiting?: BuilderWaitingState;
  /** Board column; null = the archive. */
  column: AttentionColumn | null;
  action: {
    id: CardPrimaryActionId;
    label: string;
    title: string;
    shipMode?: ShipMode;
  };
  inbox: {
    group: InboxGroupName | null;
    /** The row's words when a rule says them; null keeps the record's. */
    detail: string | null;
    action: string | null;
    /** UX P-A Mac walk 2: the row's action ships the card ("Ship it"), as
     *  the Board card's primary does. */
    ship?: boolean;
    /** The card's row is its live session's (rules 6–9): a Rust row for the
     *  card folds into that session's row. Absent: the card's own row
     *  speaks, and a waiting Builder's row folds into it (UX P-B Mac walk
     *  1: one card, one row). */
    sessionRow?: boolean;
    /** The group comes from a fact Rust never sees (changes sent, a ship
     *  press that failed, a question in a live session): the Inbox
     *  reconciles its rows for this card (`inboxReconcile.ts`). */
    live: boolean;
  };
  /** The Board card's one fact (`boardCardFact`). */
  fact: string | null;
  /** C7: "Blocked by #12" — the Board card and the List say it in place of
   *  the headline. */
  blocked: string | null;
  /** The primary is off while the card is held (blocked, or an empty ask). */
  held: boolean;
  /** The ship rule decided "Ready to ship" (the List's stage reads it). */
  readyToShip: boolean;
  setup: SetupHold | null;
  /** The page's primary, presentation as `CardStateHeader` takes it. */
  presentation: CardStatePresentation;
  /** The state's own presentation before any rule (the page keeps facts
   *  only where the helper is still this one). */
  base: CardStatePresentation;
};

// ── The function ───────────────────────────────────────────────────────

/** The canonical state, from the card and the live facts every surface
 *  shares. A result still loading counts as no result (`outcome` null). */
export function cardStateOf(card: KanbanCard, live: CardLive): CardPresentationState {
  const outcome = live.outcome;
  return deriveCardState(card, {
    ...EMPTY_CARD_STATE_CONTEXT,
    linkedSwarmStatus: live.linkedSwarmStatus,
    writerQueued: live.writerQueued,
    verificationActive: live.verificationActive,
    outcomeLoading: outcome?.loading ?? false,
    outcomeFilesChanged: outcome && !outcome.loading ? outcome.filesChanged : null,
    shipBusy: outcome?.shipBusy ?? false,
    shipConflict: card.reviewStatus === "conflict_blocked",
    reviewFreshness: outcome?.reviewFreshness ?? "none",
  });
}

const RESULT_READY: CardStatePresentation = {
  ...CARD_STATE_PRESENTATION["result-ready"],
  label: RESULT_READY_HEADLINE,
  helper: READING_RESULT_SENTENCE,
  tone: "accent",
};

function swarmReady(card: KanbanCard): boolean {
  const swarmInUse = swarmTemplateInUse(card);
  const retiredDebate = swarmInUse && card.swarmTemplateId === "claude-codex-debate";
  return Boolean((card.agentConfigId || swarmInUse) && !retiredDebate);
}

/**
 * The one presentation of a card. First match wins (docs/plans/UX_P1.md,
 * point 2, "The order"); a question the person must answer now comes
 * before any word about reviews or shipping.
 */
export function presentCard(card: KanbanCard, live: CardLive): CardPresentation {
  const state = cardStateOf(card, live);
  const boardState = BOARD_CARD_STATE_COLLAPSE[state];
  const planner = live.planner;
  const planned = withPlanner(cardStatePresentation(state), planner);
  // 1.171.0 C1 (CF5, Challenger 3): a title-only card names the AI Start
  // build launches, and the one Plan it… first would talk to.
  const base =
    state === "draft" && planned.helper === TITLE_ONLY_HELPER
      ? { ...planned, helper: titleOnlyHelper(live.builderVendor ?? planner, planner) }
      : planned;
  const cards = live.workspaceCards;
  let rule: PresentationRule = "base";
  let readyToShip = false;

  // Rule 20's result rule: "Preparing the result" is retired as a headline.
  // A result not read yet says what the Board says ("Result ready" or
  // "Ready to ship") and that it is being read.
  let p: CardStatePresentation = base;
  if (state === "result-ready") {
    readyToShip = boardSaysReadyToShip(card, live.reviewTip);
    // The headline only: its primary stays the result's ("Review the
    // result") until the result is read — Ship is offered by what was read.
    p = withPlanner(readyToShip ? { ...RESULT_READY, label: READY_TO_SHIP_HEADLINE } : RESULT_READY, planner);
    // 1.171.0 C2 (CF22): while the page reads it, no accent flash — the
    // words stay the Board's, quiet, and its press waits (the card page
    // turns it off until the result is read).
    if (live.outcome?.loading) p = { ...p, tone: "quiet" };
  } else if (state === "ready-to-ship") {
    readyToShip = true;
  }
  const resultBase = p;

  const tip = live.reviewTip;
  const lastReview = card.builder?.review ?? null;
  // A builder read before snapshots were recorded may carry none.
  const snapshots = card.builder?.snapshots ?? [];
  const lastSnapshotN = snapshots[snapshots.length - 1]?.n;
  const truthHeader = reviewTruthPresentation(
    state,
    base,
    reviewTruth({ builder: card.builder, branchTip: tip?.branchTip, commitsSinceReview: tip?.commitsSinceReview }),
    // QoL 1.168 (C5): as The result's Review again (`canReviewAgain`), and
    // its words (`reviewAgainLabel`).
    lastReview && reviewCanRunAgain(lastReview) && lastReview.snapshotN === lastSnapshotN
      ? reviewAgainLabel(lastReview)
      : null,
  );
  const owedToBuilder = handedOverOwed(card.builder, live.delivery.handedOver);
  const handedOverHeader = handedOverPresentation(state, owedToBuilder);
  const owedVerdict = verdictOwed(card.builder, live.delivery.verdict, Boolean(card.prReview));
  const changesRequestedHeader = changesRequestedPresentation(state, base, owedVerdict);
  const bothSessionsGone = state === "session-closed" && isUndecided(card);
  const bothPlain = state === "running" || bothSessionsGone ? buildBothNow(card) : null;
  const bothNow =
    bothPlain && bothPlain.label === BUILDING_WITH_BOTH_LABEL
      ? {
          ...bothPlain,
          helper: bothLanesActorWords({
            card,
            live: live.both?.live ?? { a: null, b: null },
            sentAt: live.both?.sentAt ?? { a: null, b: null },
            submittedAt: live.both?.submittedAt ?? { a: null, b: null },
            now: live.now,
          }),
        }
      : bothPlain;
  const setupNow = setupPresentation(card, state);
  const launchClock = { appStartedAt: live.appStartedAt, now: live.now };
  const shippedStageOf = state === "shipped" ? deliveryStage(card, { localShipOnGitHub: live.localShipOnGitHub === true }) : null;
  const shippedStage =
    shippedStageOf === "shippedOnGitHub" || shippedStageOf === "shippedOnlyHere" ? shippedStageOf : null;
  // Rules 5, 10, 12–18: the card page's order, one of them at most.
  if (setupNow) {
    rule = "setup";
    p = {
      ...base,
      label: setupNow.label,
      helper: setupNow.helper,
      actionId: "start-build",
      actionLabel: setupNow.retryLabel ?? base.actionLabel,
      actionTitle:
        setupNow.hold === "running"
          ? "The Builder waits for the setup."
          : setupNow.hold === "approval"
            ? "Lets the repository's setup command run on this Mac from now on, then starts the Builder."
            : "Runs the setup again, then starts the Builder.",
      tone: setupNow.hold === "running" ? "quiet" : "accent",
    };
  } else if (bothNow) {
    rule = "both";
    // SP-3 round 2: once compared, the picks are the cards right under Now.
    const compared = card.buildBoth?.compare != null && card.buildBoth.compare.status !== "running";
    p = {
      ...(bothSessionsGone ? withPlanner(cardStatePresentation("running"), planner) : base),
      label: bothNow.label,
      helper: bothNow.helper,
      tone: bothNow.label.startsWith("Pick") || bothSessionsGone ? "accent" : base.tone,
      ...(compared
        ? {
            actionId: "show-builds" as const,
            actionLabel: "See the two builds",
            actionTitle: "Brings the two builds and their Picks into view.",
          }
        : {}),
    };
  } else if (handedOverHeader) {
    rule = "handed-over";
    p = handedOverHeader;
  } else if (changesRequestedHeader) {
    // Changes requested: its press sends the verdict while it is owed;
    // otherwise only the sentence names the press that starts the next review.
    if (owedVerdict) rule = "verdict-owed";
    p = changesRequestedHeader;
  } else if (truthHeader) {
    rule = "review-truth";
    p = truthHeader;
  } else if (state === "ready" && swarmReady(card)) {
    rule = "swarm-ready";
    p = {
      ...base,
      actionId: "start-work",
      actionLabel: "Start work (multi-AI)",
      helper: "A runner is chosen and nothing has started.",
      actionTitle: "Starts the runner you chose in its own copy of your project. Nothing leaves this Mac.",
    };
  } else if (state === "shipped" && openPrBoard(card, launchClock)) {
    rule = "pr-open";
    const openPr = openPrBoard(card, launchClock)!;
    const next = prNowAction(card, live.delivery.fixSentKey, live.fixRoundByItself !== false);
    p = {
      ...base,
      label: next?.label ?? openPr.label,
      actionId: next?.actionId ?? "inspect-ship",
      actionLabel: next?.actionLabel ?? "View the pull request",
      actionTitle: next?.actionTitle ?? "Show its checks on GitHub, its review and the link.",
      // 1.171.0 B1 (CP-2): never "It shipped." while it is open.
      // 1.174.0 A2 (P7): ready to merge, it says what Merge does and that
      // the card can still change.
      helper:
        next?.helper ??
        (next?.actionId === "pr-merge" ? readyToMergeLine(card) : null) ??
        prOpenSentence(card) ??
        base.helper,
      tone:
        next?.actionId === "inspect-run" || next?.actionId === "pr-auto-merge-off"
          ? "quiet"
          : openPr.attention === "needs-you" ||
              // R1 (owner, m8): a review GitHub requires is On hold — its
              // Open on GitHub is no accent.
              (next && next.actionId !== "inspect-ship" && next.actionId !== "pr-open-github")
            ? "accent"
            : base.tone,
    };
  } else if ((state === "ready-to-ship" || state === "result-ready") && prClosed(card)) {
    rule = "pr-closed";
    const prShipNow = prShipOffer(card.builder, tip?.branchTip);
    // 1.171.0 A3 (DL-02): the card ships again the way Ship it ships — a
    // new pull request that merges when its checks pass — not the old
    // "Ship as a PR". Unreviewed, it opens one that leaves the merge to the
    // person (G1 Challenger 1, `shipWithoutAutoMergeMode`).
    // It had a pull request: GitHub, unless the project now says otherwise.
    const goes = live.workspace.shipVia !== "local" && live.outcome?.prOffered !== false;
    const anyway = prShipNow.kind === "anyway";
    const closed = `Pull request #${card.pr!.number} was closed without merging.`;
    p = {
      ...base,
      label: PR_CLOSED_LABEL,
      actionId: "ship",
      actionLabel: anyway && goes ? SHIP_ANYWAY_LABEL : SHIP_IT_AGAIN_LABEL,
      shipMode: anyway ? shipWithoutAutoMergeMode(goes) : "ship_it",
      helper: anyway
        ? `${closed} ${mergeReviewGap(card.builder) ?? ""} ${
            goes ? `${SHIP_ANYWAY_LABEL} opens a new one and leaves the merge to you` : `${SHIP_IT_AGAIN_LABEL} ships it on this Mac`
          }; the receipt says the last commit was not reviewed.`.replace(/ {2,}/g, " ")
        : `${closed} ${
            goes
              ? // 1.174.0 A2 (P7): sent, not landed — nothing reached the target.
                `Nothing reached ${targetName(shipTargetOf(card))}. ${SHIP_IT_AGAIN_LABEL} opens a new pull request; Archive puts the card away.`
              : `${SHIP_IT_AGAIN_LABEL} ships it on this Mac.`
          }${
            prShipNow.kind === "wait" ? ` ${SHIP_IT_AGAIN_LABEL} waits for Finish and check: commits were made after the last one.` : ""
          }`,
      actionTitle: anyway && goes ? shipAnywayTitle(true) : goes ? SHIP_IT_GITHUB_TITLE : shipHereTitle(),
      tone: "accent",
    };
  } else if (state === "shipped" && shippedStage) {
    // 1.171.0 B1 (DL-03, BI-20): "Merged" meant two places. The headline
    // says which: on GitHub, or only on this Mac.
    if (mergedWithoutRelease(card)) rule = "merged";
    p = { ...base, label: deliveryHeadline(shippedStage) };
  } else if (state === "shipped" && mergedWithoutRelease(card)) {
    // A pull request shipped before Plyloft read pull requests back: where
    // it went is not known here.
    rule = "merged";
    p = { ...base, label: PR_OPENED_HEADLINE };
  } else if (state === "session-closed" && pausedOnClose(card)) {
    // 1.173.0 (F1, BI-7, owner D11): Plyloft's quit stopped it — nothing is
    // asked of the person, so it is On hold (`columnFor`), with Resume.
    rule = "session-closed";
    p = { ...base, label: PAUSED_ON_CLOSE_HEADLINE, helper: PAUSED_ON_CLOSE_HELPER, tone: "quiet" };
  } else if (state === "session-closed") {
    rule = "session-closed";
    p = {
      ...base,
      label: sessionClosedLabel(card.builder, card.buildBoth),
      ...(card.builder?.resumeFailed
        ? {
            helper: resumeFailedHelper(card.builder.vendor),
            // U16: Codex's conversation wasn't found: another Resume finds
            // nothing either, so the way on leads (the card page names the AI
            // when Start build's has changed). Claude's flag also means it
            // exited quickly (a login, a usage limit), so Resume keeps leading,
            // and a card built by both keeps its own way, as its neighbour does.
            ...(startFreshLeads(card)
              ? {
                  actionId: "start-fresh" as const,
                  actionLabel: START_FRESH_LABEL,
                  actionTitle: START_FRESH_TITLE,
                }
              : {}),
          }
        : card.builder?.sessionLost && !(card.buildBoth && !card.buildBoth.outcome)
          ? { helper: SESSION_ENDED_HELPER }
          : {}),
    };
  } else if (
    card.reviewStatus === "conflict_blocked" &&
    (state === "result-ready" || (card.shipConflict?.sync === true && SYNC_CONFLICT_OVER.has(state)))
  ) {
    readyToShip = false;
    if (conflictMergeStarted(card) && card.builder) {
      // UX P1 point 7 (P-E): Plyloft started the merge and the Builder has
      // it (rule 11's words). Its turn over, Now's press is Finish and
      // check, which commits the merge; Ship waits until then.
      rule = "changes-sent";
      const stopped = live.session?.state === "stopped" && live.session.block == null;
      p = {
        ...base,
        label: CHANGES_SENT_LABEL,
        helper: conflictSentHelper(card.builder.vendor === "codex" ? "Codex" : "Claude", card.shipConflict?.branch),
        ...(stopped
          ? { actionId: "finish-and-check" as const, actionLabel: FINISH_LABEL, actionTitle: FINISH_TITLE, tone: "accent" as const }
          : {
              actionId: "inspect-run" as const,
              actionLabel: "Open the Builder",
              actionTitle: "Show the Builder session resolving the conflict.",
              tone: "quiet" as const,
            }),
        shipMode: undefined,
      };
    } else {
      rule = "ship-conflict";
      const ask = askBuilderOffered(card);
      p = {
        ...base,
        label: shipConflictHeadline(card),
        helper: shipConflictSentence(card),
        ...(ask
          ? { actionId: "ship-conflict-ask" as const, actionLabel: ASK_BUILDER_LABEL, actionTitle: ASK_BUILDER_TITLE }
          : {
              actionId: "ship" as const,
              actionLabel: SHIP_AGAIN_LABEL,
              actionTitle: "Ship again, once the conflicting files are resolved in the card's copy.",
            }),
        tone: "accent",
      };
    }
  }

  // Skills hub H3a (Mac walk 2): a skill card behind its library says so,
  // with Refresh card — not only in a refused Ship's toast that goes.
  if (live.skillBehind && (state === "ready-to-ship" || state === "result-ready")) {
    rule = "skill-behind";
    readyToShip = false;
    p =
      typeof live.skillBehind === "string"
        ? {
            ...base,
            label: SKILL_BEHIND_LABEL,
            helper: skillBehindShowFirstHelper(live.skillBehind, card.kind?.verb === "install" ? "Install" : "Update"),
            actionId: "delete-skill-card",
            actionLabel: "Delete card",
            actionTitle: "Deletes this card and its copy, after you confirm. Nothing is shipped.",
            tone: "accent",
            shipMode: undefined,
          }
        : {
            ...base,
            label: SKILL_BEHIND_LABEL,
            helper: SKILL_BEHIND_HELPER,
            actionId: "refresh-skill",
            actionLabel: "Refresh card",
            actionTitle: "Rebuilds the card's one commit at the team library's version now. Nothing is shipped.",
            tone: "accent",
            shipMode: undefined,
          };
  }

  // Rule 11: "Not right" went to the Builder and no newer round exists —
  // Ship and Not right wait; Now shows the session.
  if (
    changesSentStands(card, live.delivery.changesSentAt ?? undefined) &&
    (state === "ready-to-ship" || state === "result-ready" || state === "no-changes")
  ) {
    rule = "changes-sent";
    p = {
      ...base,
      label: CHANGES_SENT_LABEL,
      helper: CHANGES_SENT_HELPER,
      actionId: "inspect-run",
      actionLabel: "Open the Builder",
      actionTitle: "Show the Builder session working on the changes.",
      tone: "quiet",
      shipMode: undefined,
    };
  }

  // 1.171.0 C1 (CF1): the fix round. The Builder has the Challenger's
  // findings (delivered: nothing is owed to send) or the person's changes
  // (rule 11), and its session is attached here. While it works the card is
  // at work, like a running build (Working, Open session); its turn over,
  // Now's press is Finish and check again — the session's own press — and
  // the card asks for the person (Needs you, rule 9's stopped). A question
  // or its silence is rule 9's, below; a closed session keeps the words.
  const fixRound: number | "changes" | null =
    !card.builder || card.archived || card.prReview || isUndecided(card)
      ? null
      : state === "changes-requested" && !verdictNeedsSending(owedVerdict)
        ? findingsToFixCount(lastReview)
        : rule === "changes-sent" && !conflictMergeStarted(card)
          ? "changes"
          : null;
  // (Challenger 5) Only where the Builder had them in this session: Plyloft
  // delivered the findings into it, or a message went in after the verdict
  // (the person told it). A verdict recorded without either — acknowledged,
  // or delivered to an earlier session — says nothing about its turn.
  const verdictHere =
    fixRound === "changes" ||
    (lastReview != null &&
      (((live.delivery.verdict?.state === "sent" || live.delivery.verdict?.state === "sending") &&
        live.delivery.verdict.at === lastReview.at &&
        live.delivery.verdict.ptyId === card.builder?.ptyId) ||
        (live.session?.since != null && live.session.since > lastReview.at)));
  const fixSession =
    fixRound !== null && verdictHere && live.session && live.session.block == null ? live.session : null;
  /** Its turn over after the fixes: the card's own Inbox row, in its words
   *  (the session's "Claude has stopped" folds into it). */
  let fixesDone = false;
  // 1.175.0 F5: the round Plyloft sent checks by itself (`fixRoundCheck.ts`).
  const fr: FixRoundFacts | null = card.prReview ? null : (live.fixRound ?? null);
  const reviewerName = fixRoundReviewer(card.builder?.vendor, lastReview?.provider);
  if (fixSession && fixRound !== null) {
    const who = fixSession.vendor === "codex" ? "Codex" : "Claude";
    if (fixSession.state === "working" && !fixSession.finishing) {
      rule = "builder-fixing";
      const since = fixSession.since ?? null;
      const elapsed = since != null && live.now - since >= 60_000 ? ` · ${shortDuration(live.now - since)}` : "";
      p = {
        ...base,
        label: `${fixingHeadline(who, fixRound)}${elapsed}`,
        helper: fr?.byItself ? fixingByItselfSentence(who, reviewerName) : fixingSentence(who),
        actionId: "inspect-run",
        actionLabel: "Open the Builder",
        actionTitle: `Show the session, where ${who} is working on them.`,
        tone: "quiet",
        shipMode: undefined,
      };
    } else if (fixSession.state === "stopped" || (fixSession.state === "working" && fixSession.finishing)) {
      // Finish and check pressed: the same words, its press busy, Working.
      rule = fixSession.finishing ? "builder-fixing" : "builder-waiting";
      fixesDone = !fixSession.finishing;
      p = {
        ...base,
        label: fixesDoneHeadline(who),
        helper: fixesDoneSentence(who, fixRound !== "changes"),
        actionId: "finish-and-check",
        actionLabel: FINISH_AGAIN_LABEL,
        actionTitle: FINISH_TITLE,
        tone: "accent",
        shipMode: undefined,
      };
      // 1.175.0 F5: why a round Plyloft sent didn't check by itself, or the
      // check the person stopped — the same press, its own words.
      const held = !fixSession.finishing && fr?.held && fr.held !== "asks" ? fixRoundHeldWords(fr.held, who, reviewerName) : null;
      if (held) p = { ...p, label: held.label, helper: held.helper };
      else if (!fixSession.finishing && fr?.stopped) p = { ...p, label: STOPPED_CHECK_LABEL, helper: STOPPED_CHECK_SENTENCE };
    }
    if (rule === "builder-fixing" || rule === "builder-waiting") readyToShip = false;
  }

  // 1.171.0 C2 (CF3, owner D10): Finish and check pressed — the Builder
  // re-reads its own work (the self-check), then Plyloft saves this
  // version. Now says what is happening and that the person can leave, not
  // the session's "Claude · working" (the press looked ignored), and the
  // Board says the same word. A question or a block in the session is
  // still said by rules 8–9 below; its press stays the busy Finish and
  // check.
  const finishingSession =
    live.session?.finishing === true &&
    live.session.block == null &&
    live.session.state !== "question" &&
    !card.archived &&
    !card.prReview &&
    !isUndecided(card) &&
    state !== "shipped" &&
    state !== "shipping"
      ? live.session
      : null;
  // 1.171.0 C2 ("Errori a metà flusso"): Finish and check asked for the
  // self-check and never went on — Plyloft quit during it, or its session
  // ended. The card says what happened and offers Finish and check again
  // (no session: the work is saved as it is), never an endless wait.
  const checkStopped =
    card.builder?.selfCheckStartedAt != null &&
    !card.builder.ptyId &&
    live.session?.finishing !== true &&
    !card.archived &&
    !card.prReview &&
    !isUndecided(card) &&
    state !== "shipped" &&
    state !== "shipping";
  if (checkStopped && card.builder) {
    rule = "check-stopped";
    readyToShip = false;
    fixesDone = false;
    const who = card.builder.vendor === "codex" ? "Codex" : "Claude";
    p = {
      ...base,
      label: CHECK_STOPPED_LABEL,
      helper: checkStoppedSentence(who, card.builder.lostOnRestart === true),
      actionId: "finish-and-check",
      actionLabel: FINISH_AGAIN_LABEL,
      actionTitle: "Saves the Builder's work as it is, runs your checks and has it reviewed.",
      tone: "accent",
      shipMode: undefined,
    };
  } else if (finishingSession) {
    rule = "finishing";
    readyToShip = false;
    fixesDone = false;
    p = {
      ...base,
      label: fr?.checking ? CHECKING_BY_ITSELF_LABEL : CHECKING_WORK_LABEL,
      helper: fr?.checking && !finishingSession.withoutReview
        ? checkingByItselfSentence(finishingSession.vendor === "codex" ? "Codex" : "Claude", reviewerName)
        : finishingSession.withoutReview
        ? SAVING_WITHOUT_REVIEW_SENTENCE
        : finishingSession.selfCheck
          ? selfCheckWaitSentence()
          : SAVING_WAIT_SENTENCE,
      actionId: "finish-and-check",
      actionLabel: FINISH_LABEL,
      // Challenger 4: without the review, its title doesn't promise one.
      actionTitle: finishingSession.withoutReview ? FINISH_WITHOUT_REVIEW_TITLE : FINISH_TITLE,
      tone: "quiet",
      shipMode: undefined,
    };
  } else if (rule === "base" && state === "challenger-reviewing" && lastReview?.status === "running" && card.builder) {
    // 1.171.0 C2 (CF16): the review says who reviews whose work, and that
    // the person can leave (Now's title is the word with how long).
    const name = (v: string) => (v === "codex" ? "Codex" : "Claude");
    p = {
      ...p,
      helper: live.prDraftWriting
        ? reviewWithDraftSentence(name(lastReview.provider), name(card.builder.vendor), live.verificationActive)
        : reviewWaitSentence(name(lastReview.provider), name(card.builder.vendor), live.verificationActive),
    };
  } else if (rule === "base" && state === "checking" && reviewSkippedThisRound(card)) {
    p = { ...p, helper: checksRunningWithoutReviewSentence(p.helper) };
  } else if (rule === "base" && (state === "challenger-reviewing" || state === "checking")) {
    p = { ...p, helper: `${p.helper} ${LEAVE_LINE}` };
  }

  // 1.175.0 B2 (SEC-4): the card's checks were asked for and didn't run —
  // the repository's checks changed (or are new to this Mac) and wait for
  // its OK. Nothing ran, so the card is neither checked nor failed: one
  // press, Allow and run, on the page that shows the two versions. Over
  // the record's state, under everything a live session or a ship says
  // after it (the rules below).
  const checksHeld =
    card.checksHold != null &&
    rule !== "setup" &&
    rule !== "finishing" &&
    !card.archived &&
    !card.prReview &&
    // Round 2 (G5): a card built by both whose builds' checks wait says so
    // too — the OK is given here, and the comparison waits for it.
    state !== "shipped" &&
    state !== "shipping" &&
    state !== "checking";
  if (checksHeld) {
    rule = "checks-ok";
    readyToShip = false;
    fixesDone = false;
    p = {
      ...base,
      label: CHECKS_OK_LABEL,
      helper: CHECKS_OK_SHORT,
      actionId: "allow-checks",
      actionLabel: ALLOW_AND_RUN,
      actionTitle: CHECKS_OK_ACTION_TITLE,
      tone: "accent",
      shipMode: undefined,
    };
  }

  // Rule 19: beside a ship press that didn't go through, whatever offered
  // the Ship. UX P-A (Windows walk 2): over a recorded conflict too — the
  // failed press is the newest (a later press clears it, and a conflict the
  // card records after it outdates it: `CardDetailPanel`'s failure is kept
  // only under the review status it failed on, a refusal's block goes with
  // a land that merges or conflicts), and it stopped before any merge ran,
  // so it is what the person meets now. The conflict's sentence is not said
  // beside it; the conflict comes back when the failure goes.
  // P-E: over a conflict whose primary asks the Builder, the failed press
  // was its menu's Ship again — said all the same.
  if (live.shipFailure && (p.actionId === "ship" || rule === "ship-conflict")) {
    const overConflict = rule === "ship-conflict";
    rule = "ship-failed";
    p = shipFailedPresentation(overConflict ? { ...p, actionId: "ship" } : p, live.shipFailure);
    if (overConflict && live.shipFailure !== "skill-pr-local" && live.shipFailure !== "teammate") p = { ...p, helper: SHIP_FAILED_SENTENCE };
  }

  // 1.170 walk (Mac and Windows): a release through a pull request on its
  // way is what the card is doing, at every step from the press until the
  // board says Shipped — never "Ready to ship" (its Ship only looks again)
  // nor "Ship didn't go through". A problem with its record is a refusal
  // instead (rule 19, `shipRefusal.ts`).
  const releasing = live.releasing ?? null;
  if (
    releasing &&
    state !== "shipped" &&
    (p.actionId === "ship" || rule === "ship-failed" || rule === "ship-conflict" || state === "ready-to-ship" || state === "result-ready")
  ) {
    rule = "releasing";
    readyToShip = false;
    p = {
      ...base,
      label: RELEASING_HEADLINE,
      helper: `${releasing.tag}: ${releasePrStateLabel(releasing)}.`,
      ...(releasing.url
        ? {
            actionId: "release-open-github" as const,
            actionLabel: "Open on GitHub",
            actionTitle: "Shows the release pull request on GitHub.",
          }
        : {
            actionId: "inspect-ship" as const,
            actionLabel: "View the release",
            actionTitle: "Shows how far the release got.",
          }),
      tone: "quiet",
      shipMode: undefined,
    };
  }

  // Rule 9 (P-B, points 3 and 4): the Builder waits on the person — a
  // question, its turn over at its prompt, or quiet. A card built by both
  // keeps rule 10's words (each build says its own) but goes to Needs you
  // too (`builderWaiting` below); while its pick waits no build is waiting.
  const waitingState =
    live.session && live.session.block == null && live.session.state !== null &&
    (live.session.state === "question" || live.session.state === "stopped" || live.session.state === "quiet")
      ? live.session.state
      : null;
  // UX P-B Mac walk 2: a question the Builder waits on is the most urgent
  // thing on the card ("The order": a question the person must answer now
  // comes before any word about reviews or shipping). It outranks rules
  // 10–19 whatever the card's state — "Challenger requests changes", a
  // review's words, a ship — wherever its live session can ask. "Stopped"
  // and "quiet" stay a running card's: beside "Challenger requests changes"
  // the card's own sentence already says to press Finish and check.
  // U25: except the one question known to be left over: the one on screen,
  // without a break, since Ship stopped waiting for the pull request's draft
  // (`draftQuestionLeft`). A fix round leaves the status Success too, so the
  // state can't tell them apart; any other question still comes first, and a
  // Merge never leads over it. Or a merged card's: Done isn't what it asks about.
  const leftOverQuestion =
    waitingState === "question" &&
    state === "shipped" &&
    fixSession === null &&
    !card.archived &&
    ((prOpen(card) && live.draftQuestionLeft === true) || card.pr?.state === "merged");
  const questionOutranks = waitingState === "question" && !card.archived && !leftOverQuestion;
  // 1.171.0 C1: a fix round's Builder gone quiet is rule 9's too (its turn
  // over is the fix round's own words, above).
  const builderWaiting =
    waitingState !== null &&
    (finishingSession === null || waitingState === "question") &&
    (state === "running" || questionOutranks || (fixSession !== null && waitingState === "quiet"));
  if (builderWaiting && !isUndecided(card) && live.session) {
    rule = "builder-waiting";
    readyToShip = false;
    p = builderWaitingPresentation(p, waitingState!, live.session.vendor, live.session.turnInterrupted === true);
    // 1.175.0 F5: in a round that checks by itself, a question keeps its
    // title and press; the sentence says what follows once it's answered.
    if (waitingState === "question" && fixSession !== null && (fr?.byItself || fr?.held === "asks")) {
      const words = fixRoundHeldWords("asks", live.session.vendor === "codex" ? "Codex" : "Claude", reviewerName);
      if (words) p = { ...p, helper: words.helper };
    }
  } else if (leftOverQuestion && live.session) {
    p = { ...p, helper: `${p.helper} ${leftOverQuestionLine(live.session.vendor, prOpen(card))}`.trim() };
  }

  // 1.172.0 E3 (Windows walk): Codex's transcript search open over its
  // composer is no prompt and no silence to wait out — nothing Plyloft types
  // reaches Codex until it closes (E2), so Now says how to close it, whether
  // the Builder looked quiet or Finish and check waits on its self-check.
  if (
    live.session?.codexSearchOpen === true &&
    live.session.vendor === "codex" &&
    live.session.block == null &&
    (rule === "builder-waiting" || rule === "finishing" || (rule === "base" && state === "running"))
  ) {
    p = {
      ...p,
      helper: CODEX_SEARCH_OPEN_SENTENCE,
      actionId: "inspect-run",
      actionLabel: "Open the Builder",
      actionTitle: "Show the session, where the search is open.",
      tone: "accent",
    };
  }

  // Rule 8: the Builder (or one of the two builds) is stopped at a question
  // in its session — nothing moves until the person answers it there: the
  // folder-trust question, and (UX P-F, points 5 and 8) Claude's Bypass
  // Permissions warning or its usage limit. Plyloft never answers any of
  // them, and never types "continue" by itself.
  const block = live.session?.block ?? null;
  const sessionBlocked = block != null && STATE_ATTENTION_COLUMN[boardState] === "working";
  if (sessionBlocked && live.session && block.kind === "trust") {
    rule = "session-block";
    p = { ...p, label: TRUST_HEADLINE, helper: trustHelper(live.session.vendor), tone: "accent" };
  } else if (sessionBlocked && live.session && block.kind !== "trust") {
    rule = "session-block";
    readyToShip = false;
    const resetsAt = block.kind === "usageLimit" ? block.resetsAt : null;
    p = {
      ...p,
      label: sessionBlockHeadline(block.kind, resetsAt),
      helper: sessionBlockSentence(block.kind, live.session.vendor, resetsAt),
      actionId: "inspect-run",
      actionLabel: "Open the Builder",
      actionTitle: block.kind === "usageLimit" ? "Show the session, where Claude says when its limit resets." : "Show the session, where Claude asks.",
      tone: "accent",
      shipMode: undefined,
    };
  }

  // Rule 7: the intake conversation waits on the folder-trust question.
  if (live.intakeTrust !== null && state === "intake-live") {
    rule = "intake-trust";
    p = { ...p, label: TRUST_HEADLINE, helper: intakeTrustHelper(live.intakeTrust), tone: "accent" };
  }

  // Rule 6: the intake conversation ended while the card still plans.
  const intakeStopped = live.intakeStop !== null && state === "intake-live";
  if (intakeStopped) {
    rule = "intake-stopped";
    p = {
      ...p,
      label: intakeStoppedLabel(planner),
      helper: intakeStoppedHappened(live.intakeStop!, planner),
      actionId: "plan-again",
      actionLabel: PLAN_AGAIN_LABEL,
      actionTitle: planAgainTitle(planner),
      tone: "accent",
    };
  }

  // 1.171.0 C3 walk fix (owner 2026-10-27): a review skipped with "Check
  // without the Reviewer" is no review — nothing merges by itself
  // (Rust's `ship_auto_merge_guarded`). Where Ship it would go to GitHub,
  // the primary is the pull request the person merges, as Ship ▾ offers it;
  // the same for work not reviewed at all (its "Ship anyway", Challenger 3)
  // — one wording for both.
  const skippedPrimary =
    p.actionLabel === "Ship it" &&
    prShipOffer(card.builder, tip?.branchTip).kind === "anyway" &&
    mergeReviewGap(card.builder) === SKIPPED_REVIEW_GAP;
  const unreviewedPrimary = rule === "review-truth" && p.actionLabel === "Ship anyway";
  if (
    state === "ready-to-ship" &&
    p.actionId === "ship" &&
    (skippedPrimary || unreviewedPrimary) &&
    (p.shipMode === undefined || p.shipMode === "ship_it") &&
    shipItGoesToGitHub(live.workspace.shipVia, live.outcome?.prOffered) &&
    !live.outcome?.noRemote
  ) {
    p = {
      ...p,
      actionLabel: SHIP_ANYWAY_LABEL,
      shipMode: shipWithoutAutoMergeMode(true),
      actionTitle: shipAnywayTitle(true),
    };
  }

  // G1: Ship it goes to GitHub here — a pull request that merges when its
  // checks pass (Rust resolves `ship_it` the same way).
  if (
    p.actionId === "ship" &&
    (p.shipMode === undefined || p.shipMode === "ship_it") &&
    shipItGoesToGitHub(live.workspace.shipVia, live.outcome?.prOffered)
  ) {
    p = {
      ...p,
      shipMode: "ship_it",
      actionTitle:
        p.actionLabel === "Try again" || p.actionLabel === OPEN_PR_RETRY_LABEL
          ? "Opens the pull request again, the same way, and merges it when the checks pass."
          : SHIP_IT_GITHUB_TITLE,
    };
  } else if (p.shipMode === "ship_it") {
    // A failed Ship it that lands here is the plain primary again.
    p = { ...p, shipMode: undefined };
  }

  // Modifier: no remote, no pull request — the primary ships here.
  if (live.outcome?.noRemote && (p.shipMode === "pr" || p.shipMode === "pr_only")) {
    p = {
      ...p,
      shipMode: "merge_live",
      actionTitle:
        p.actionLabel === "Try again"
          ? shipHereTitle(null, true)
          : shipHereTitle(),
    };
  }

  // G10: a ship that lands here says where by the target's real name ("main
  // on this computer"), as the card started from it.
  const here = card.worktreeBase?.refName;
  if (p.actionId === "ship" && here && p.actionTitle === shipHereTitle()) {
    p = { ...p, actionTitle: shipHereTitle(here) };
  } else if (p.actionId === "ship" && here && p.actionTitle === shipHereTitle(null, true)) {
    p = { ...p, actionTitle: shipHereTitle(here, true) };
  }

  // Rule 2 (and the empty-ask modifier): a card held by a blocker, or a
  // follow-up whose ask is empty, does not start.
  const blockers = unshippedBlockers(card, cards);
  const blocked = isHeld(card, cards, state);
  const askEmpty =
    !blocked &&
    (state === "draft" || state === "ready") &&
    followUpAskEmpty(card, live.notesDraft ?? card.notes ?? "");
  if (askEmpty) p = { ...p, helper: FOLLOW_UP_ASK_EMPTY };
  // C4: Now's own line says where the work came from (`nowFacts`); the
  // headline says what it waits for, the reason sits beside Start build.
  const copyEmpty =
    !blocked && !askEmpty && (state === "draft" || state === "ready") &&
    copyBriefEmpty(card, live.notesDraft ?? card.notes ?? "");
  if (copyEmpty) p = { ...p, label: COPY_BRIEF_EMPTY_HEADLINE };
  const heldReason = blocked ? startRefusal(blockers) : null;

  // Rule 4: a two-AI plan runs, waits for the person or is paused.
  const planWords =
    live.plan && !card.archived && !blocked && (state === "draft" || state === "ready")
      ? planCardWords(live.plan)
      : null;
  if (planWords) {
    rule = "plan";
    p = {
      ...p,
      label: planWords.label,
      helper: planWords.helper,
      tone: planWords.tone,
      actionId: "open-plan",
      actionLabel: planWords.actionLabel,
      actionTitle: planWords.actionTitle,
    };
  }

  // Rule 3: someone else holds its issue and nobody has started it here.
  const claimed =
    live.claimedByOthers !== null && !blocked && !askEmpty && (boardState === "draft" || boardState === "ready");
  if (claimed) {
    rule = "claimed";
    // U1: Start build stays, as a plain button: it asks before a second
    // claim, and the card isn't this person's to start first.
    p = { ...p, label: live.claimedByOthers!, tone: "quiet" };
  } else if (live.claimedByYou && !blocked && !askEmpty && (boardState === "draft" || boardState === "ready")) {
    // U2: the state's word only; it stays where a card to start belongs.
    p = { ...p, label: live.claimedByYouLabel ?? CLAIMED_BY_YOU };
  }

  // 1.174.0 (C3, P9): a card with no area to start in asks in Now, before
  // its press — "Start in Site" chooses and starts; held areas offer the
  // way to Settings and no filled press.
  const areaNow =
    live.areaAsk && !blocked && !planWords && !claimed && !card.archived && (state === "draft" || state === "ready") && p.actionId === "start-build"
      ? live.areaAsk
      : null;
  if (areaNow?.kind === "choose") {
    rule = "choose-area";
    p = {
      ...p,
      label: WHICH_AREA_CARD,
      helper: areaNow.why ?? AREA_ASK_WHY,
      tone: "accent",
      actionLabel: startInAreaLabel(areaNow.area),
      actionTitle: `Choose ${areaNow.area} and start the build.`,
    };
  } else if (areaNow?.kind === "held") {
    rule = "choose-area";
    p = {
      ...p,
      label: AREAS_HELD_HEADLINE,
      helper: areaNow.sentence,
      tone: "quiet",
      actionId: "open-areas-settings",
      actionLabel: AREAS_SETTINGS_LABEL,
      actionTitle: "Nothing starts or ships until the areas are fixed.",
    };
  }

  if (blocked && heldReason) {
    rule = "blocked";
    p = { ...p, label: BLOCKED_HEADLINE, helper: heldReason, tone: "quiet" };
  }

  // Rule 1: the card reviews a member's pull request (unless its own Builder
  // session, fixing that pull request, is what it shows).
  const prReviewWord = prReviewCardState(card) ? prReviewLabel(card) : null;
  if (prReviewWord) {
    rule = "pr-review";
    p = {
      ...p,
      label: prReviewWord,
      tone: STATE_ATTENTION_COLUMN[boardState] === "needs-you" ? "accent" : "quiet",
    };
  }

  if (card.archived) {
    rule = "archived";
    p = base;
  }

  // ── Column ──
  const prBoard = openPrBoard(card, launchClock);
  const signals = {
    ...cardAttentionSignals(card, cards),
    // B1 (owner D6): Plyloft's merge owed since a launch is On hold.
    pullRequest: prBoard?.attention ?? null,
    askingTrust: sessionBlocked,
    claimedByOthers: live.claimedByOthers !== null,
    intakeStopped,
    builderWaiting,
  };
  const ruled = columnFor(rule, state, signals, live, setupNow?.hold ?? null, card);
  // 1.175.0 (D3): its issue asks which version to keep — Needs you whatever
  // rule the card reads by (held, a teammate's, a build under way); a card
  // in no column, or done, asks nothing.
  const asksEdit = signals.editConflict === true && ruled !== null && ruled !== "done";
  const column = asksEdit ? "needs-you" : ruled;

  // ── Dot ──
  const held = blocked || askEmpty;
  const dot = held
    ? { state: "empty" as const, live: false }
    : rule === "plan" && live.plan
      ? boardChipRunState({ state, plan: live.plan.status as PlanExchangeStatus })
      : rule === "setup" && setupNow
        ? boardChipRunState({ state, setup: setupNow.hold })
        : rule === "releasing" || rule === "builder-fixing" || rule === "finishing" || (rule === "pr-open" && column === "working")
          ? { state: "running" as const, live: true }
          : rule === "ship-failed" ||
            rule === "check-stopped" ||
            rule === "checks-ok" ||
            rule === "intake-stopped" ||
            rule === "ship-conflict" ||
            // UX P-A Mac walk 5: a question nothing moves past is the
            // person's amber on every surface, never a running dot.
            rule === "session-block" ||
            rule === "intake-trust"
          ? { state: "aborted" as const, live: false }
          : rule === "builder-waiting"
            ? // The Builder header's dot: its turn over is done, a question
              // or its silence amber.
              { state: waitingState === "stopped" ? ("done" as const) : ("aborted" as const), live: false }
            : boardRunState(state);

  const action = {
    id: p.actionId,
    label: p.actionLabel,
    // 1.174.0 (TX8, T40): "Nothing leaves this Mac" reads "this PC" on
    // Windows wherever this title is shown; the card page wraps it too.
    title: machineWords(p.actionTitle ?? ""),
    ...(p.shipMode ? { shipMode: p.shipMode } : {}),
  };

  return {
    state,
    boardState,
    rule,
    headline: p.label,
    sentence: p.helper,
    tone: p.tone,
    dot,
    ...(rule === "builder-waiting" && waitingState ? { waiting: waitingState } : {}),
    column,
    action,
    inbox: editAsks(
      asksEdit ? card : null,
      fixesDone && rule === "builder-waiting"
        ? { group: "needs_you", detail: p.label, action: OPEN_CARD_ACTION, live: true }
        : inboxFor(
            card,
            rule,
            state,
            column,
            readyToShip && rule !== "ship-conflict" && rule !== "changes-sent",
            live.session?.held === true,
            p.label,
          ),
    ),
    fact: boardCardFact(card, boardState, live.now),
    blocked: blocked && heldReason ? blockedByLine(blockers) : null,
    held,
    readyToShip: readyToShip && rule !== "ship-conflict" && rule !== "changes-sent",
    setup: setupNow?.hold ?? null,
    presentation: p,
    base: state === "result-ready" ? resultBase : base,
  };
}

function columnFor(
  rule: PresentationRule,
  state: CardPresentationState,
  signals: Parameters<typeof attentionColumnFor>[1],
  live: CardLive,
  setupHold: SetupHold | null,
  card?: KanbanCard,
): AttentionColumn | null {
  switch (rule) {
    case "archived":
      return null;
    case "blocked":
    case "claimed":
      return "waiting";
    case "plan":
      return live.plan?.status === "running" ? "working" : "needs-you";
    case "setup":
      return setupHold === "running" ? "working" : "needs-you";
    case "intake-stopped":
    case "intake-trust":
    case "session-block":
    case "builder-waiting":
    case "ship-conflict":
    case "ship-failed":
    case "check-stopped":
    case "checks-ok":
      return "needs-you";
    case "changes-sent":
    case "releasing":
    case "builder-fixing":
    case "finishing":
      return "working";
    // 1.173.0 (F1, BI-7): paused by Plyloft's quit asks nothing — On hold.
    case "session-closed":
      return state === "session-closed" && card != null && pausedOnClose(card) ? "waiting" : attentionColumnFor(state, signals);
    default:
      return attentionColumnFor(state, signals);
  }
}

// ── The Inbox group ────────────────────────────────────────────────────

/**
 * Mirror of `inbox.rs::derive_card_events` for one card: the group of the
 * card's attention row from its record alone (needs you outranks on hold,
 * on hold outranks running; ship history is not attention). 1.173.0 (F1):
 * a failed run or failed checks is a Needs you row, as on the Board. The shared
 * fixtures (`attention.fixtures.json`) hold the two to the same answer.
 */
export function recordInboxGroup(card: KanbanCard): InboxGroupName | null {
  if (card.archived) return null;
  const groups = new Set<InboxGroupName>();
  if (card.prReview) {
    const prState = prReviewCardState(card);
    if (prState && STATE_ATTENTION_COLUMN[prState] === "needs-you") groups.add("needs_you");
    if (card.lastRunStatus !== "running") return pick(groups);
  }
  const landed = cardShippedOrPrOpen(card);
  // 1.175.0 (D3): its issue asks which version to keep (`inbox.rs`'s `edit:` row).
  if (!landed && hasEditConflict(card)) groups.add("needs_you");
  const pr = card.pr;
  let prClosedRow = false;
  if (pr && card.prUrl) {
    if (pr.state === "open" && card.shipStatus !== "shipped" && card.reviewStatus !== "merged") {
      // `pr_events`: failing checks, changes requested, a conflict; R1: ready
      // to merge (`card_ready_to_merge`).
      if (
        pr.checks === "failing" ||
        pr.reviewDecision === "changes_requested" ||
        pr.mergeable === "conflicting" ||
        // G1–G3 Challenger (2): `pr_head_moved`.
        prHeadMoved(pr) ||
        prCardReadyToMerge(card)
      ) {
        groups.add("needs_you");
      }
    } else if (pr.state === "open" && openPrBoard(card)?.attention === "needs-you") {
      groups.add("needs_you");
    } else if (pr.state === "closed" && card.reviewStatus !== "merged" && card.shipStatus !== "shipped") {
      groups.add("needs_you");
      prClosedRow = true;
    }
  }
  const changesRequested = !card.prReview && !landed && card.reviewStatus === "changes_requested";
  const run = card.lastRunStatus;
  if (changesRequested) {
    groups.add("needs_you");
  } else if ((run === "failed" || run === "aborted" || run === "rate_limited") && !landed && !builderSessionClosedInbox(card)) {
    groups.add("needs_you");
  } else if (run === "success" && !landed && !prClosedRow) {
    if (card.reviewStatus == null || card.reviewStatus === "pending") groups.add("needs_you");
    // P-A: a local ship stopped on a conflict (`conflict:<card>:<run>`).
    if (card.reviewStatus === "conflict_blocked") groups.add("needs_you");
  } else if (run === "running" && card.buildBoth && !card.buildBoth.outcome && card.buildBoth.compare && card.buildBoth.compare.status !== "running") {
    groups.add("needs_you");
  } else if ((run === "running" || run === "aborted") && sessionEnded(card) && (run === "running" || (!landed && builderSessionClosedInbox(card)))) {
    // 1.173.0 (F1): paused by Plyloft's quit is On hold (`paused_on_close`).
    groups.add(pausedOnClose(card) ? "on_hold" : "needs_you");
  } else if (run === "running") {
    groups.add("running");
  }
  // 1.170.0 (G6): a bring-in's conflict, whatever the last run said
  // (`inbox.rs::sync_conflict_row`).
  if (
    card.reviewStatus === "conflict_blocked" &&
    card.shipConflict?.sync &&
    run !== "success" &&
    run !== "running" &&
    !landed &&
    !prClosedRow &&
    !changesRequested
  ) {
    groups.add("needs_you");
  }
  if (!changesRequested && !landed && card.verifyStatus === "failed") groups.add("needs_you");
  const awaitsReview = run === "success" && (card.reviewStatus == null || card.reviewStatus === "pending");
  const conflictRow =
    card.reviewStatus === "conflict_blocked" &&
    (run === "success" || (card.shipConflict?.sync === true && run !== "running")) &&
    !prClosedRow;
  if (
    !landed &&
    !conflictRow &&
    !changesRequested &&
    !prClosedRow &&
    card.columnId === "complete" &&
    !awaitsReview &&
    !closedWithoutWork(card)
  ) {
    groups.add("needs_you");
  }
  // F1 (Challenger 6): in line for a slot is On hold, as on the Board.
  if (isCardSwarmQueued(card) && run !== "running") groups.add("on_hold");
  return pick(groups);
}

function pick(groups: Set<InboxGroupName>): InboxGroupName | null {
  if (groups.has("needs_you")) return "needs_you";
  if (groups.has("on_hold")) return "on_hold";
  if (groups.has("running")) return "running";
  return null;
}

/** `inbox.rs::builder_session_closed`. */
function builderSessionClosedInbox(card: KanbanCard): boolean {
  return closedBuilderAborted(card);
}

/** `inbox.rs::card_session_ended`: recorded running (or aborted by a
 *  closed session) and no session runs it. */
function sessionEnded(card: KanbanCard): boolean {
  return builderSessionClosed(card);
}

/** `inbox.rs::card_is_closed_without_work`. */
function closedWithoutWork(card: KanbanCard): boolean {
  return (
    card.lastRunStatus == null &&
    (card.verifyStatus == null || card.verifyStatus === "none" || card.verifyStatus === "legacy")
  );
}

/** Block C: Now's sentence already says why Resume failed, so the session's
 *  section and the error block don't repeat it. A pull request review's Now is
 *  the review's, without that sentence. */
export function nowSaysResumeFailed(
  card: Pick<KanbanCard, "builder" | "prReview">,
  sentence: string,
): boolean {
  return (
    !card.prReview &&
    card.builder?.resumeFailed === true &&
    sentence === resumeFailedHelper(card.builder.vendor)
  );
}

/** The session section's own line about a failed Resume: only while the
 *  session closed is the state and Now doesn't say it, or on a pull request
 *  review, whose Now is the review's. During the checks, or later, it would
 *  offer a Start fresh that isn't there. */
export function sessionSaysResumeFailed(
  card: Pick<KanbanCard, "builder" | "prReview">,
  presented: { state: string; sentence: string },
): boolean {
  if (card.builder?.resumeFailed !== true) return false;
  if (card.prReview) return true;
  return presented.state === "session-closed" && !nowSaysResumeFailed(card, presented.sentence);
}

/** U16: a Codex Resume found no conversation, on a card with one Builder. */
function startFreshLeads(card: KanbanCard): boolean {
  return card.builder?.resumeFailed === true && card.builder.vendor === "codex" && !(card.buildBoth && !card.buildBoth.outcome);
}

/** 1.175.0 (D3): the Inbox row of a card whose issue asks which version to
 *  keep (`asking`; null otherwise). The card is in Needs you, so it has a
 *  row: a row with words of its own keeps them (its Builder waiting, a
 *  failed ship); any other says the question, with *Choose*. */
function editAsks(asking: KanbanCard | null, row: CardPresentation["inbox"]): CardPresentation["inbox"] {
  if (!asking) return row;
  if (row.group === "needs_you" && (row.sessionRow || row.detail != null)) return row;
  return { group: "needs_you", detail: editInboxDetail(asking), action: EDIT_CHOOSE_ACTION, live: true };
}

function inboxFor(
  card: KanbanCard,
  rule: PresentationRule,
  state: CardPresentationState,
  column: AttentionColumn | null,
  readyToShip: boolean,
  /** P-B: a waiting Builder within its 3 s hold — the Inbox, which reads
   *  the live session itself, already lists it as Working again. */
  held = false,
  /** The card's headline (1.171.0 C1: a fix round's row, without its clock). */
  headline = "",
): CardPresentation["inbox"] {
  if (held && (rule === "builder-waiting" || rule === "both") && column === "needs-you" && STATE_ATTENTION_COLUMN[BOARD_CARD_STATE_COLLAPSE[state]] === "working") {
    const record = recordInboxGroup(card);
    const group = constrainToColumn(record, "working", state);
    return { group, detail: null, action: null, live: group !== record };
  }
  switch (rule) {
    case "changes-sent":
      // Working: the Builder has the changes; nothing is asked of the person.
      return { group: null, detail: null, action: null, live: true };
    case "builder-fixing":
      // 1.171.0 C1: Running, like a build — Rust's "changes requested" row
      // (it never sees the live session) moves there, in the card's words.
      return { group: "running", detail: headline.replace(/ · \d+[mhd]$/, ""), action: null, live: true };
    case "ship-failed":
      return { group: "needs_you", detail: SHIP_FAILED_HEADLINE, action: OPEN_CARD_ACTION, live: true };
    case "releasing":
      // Running: Plyloft follows the release; nothing is asked of the person.
      return { group: "running", detail: RELEASING_HEADLINE, action: null, live: true };
    case "finishing":
      // 1.171.0 C2: Running, in the card's word — nothing is asked of the
      // person until Plyloft tells them it's done.
      return { group: "running", detail: CHECKING_WORK_LABEL, action: null, live: true };
    case "check-stopped":
      // 1.171.0 C2: the card's own row, in its words (Rust's "session
      // ended" row for the card folds into it).
      return { group: "needs_you", detail: CHECK_STOPPED_LABEL, action: OPEN_CARD_ACTION, live: true };
    case "checks-ok":
      // 1.175.0 B2: the OK is given on the card, where the two versions are.
      return {
        group: "needs_you",
        detail: checksOkInboxDetail(card.prAutoFix === true && autoFixFailingHead(card.pr) != null),
        action: OPEN_CARD_ACTION,
        live: true,
      };
    case "ship-conflict":
      // UX P-A Mac walk 2: live, so the row the card had before the ship
      // (Rust's "review it") reads the conflict at once, not a second later
      // when the feed brings Rust's own conflict row.
      return { group: "needs_you", detail: shipConflictHeadline(card), action: OPEN_CARD_ACTION, live: true };
    case "session-block":
    case "builder-waiting":
    case "intake-trust":
    case "intake-stopped":
      // Its own row is the live session's (`needsYou.ts::waitingSessions`);
      // Rust's row for the card folds into it (`inboxReconcile.ts`).
      return { group: "needs_you", detail: null, action: null, live: true, sessionRow: true };
    default: {
      // The record's row (Rust's), where the Board's column agrees with it:
      // a card the Board shows Working is Running in the Inbox, one Waiting
      // or Done asks nothing (a queued card is Running). A group that moved
      // is reconciled, in the card's words.
      const record = recordInboxGroup(card);
      const group = constrainToColumn(record, column, state);
      // UX P-A Mac walk 2: a card the Board says is ready to ship is "Ready
      // to ship" with Ship it in the Inbox too — Rust's row ("The work is
      // done · review it") does not know an approved Builder card still in
      // In progress can ship (the Ship batch takes only Complete).
      // 1.173.0 (F1, one count): a card on the Board's Needs you always has
      // its Inbox row, even one Rust's record doesn't row (no changes, a
      // review gone stale): the two Needs you counts are the same cards.
      if (group === null && column === "needs-you") {
        return { group: "needs_you", detail: null, action: null, live: true };
      }
      // U16: the row's press is the card's, Start fresh, once Resume found nothing.
      if (group === "needs_you" && state === "session-closed" && startFreshLeads(card)) {
        return { group, detail: null, action: START_FRESH_LABEL, live: true };
      }
      if (rule === "base" && group === "needs_you" && readyToShip) {
        return {
          group,
          detail: READY_TO_SHIP_INBOX_DETAIL[readyToShipChecks(card)],
          action: SHIP_IT_ACTION,
          ship: true,
          live: true,
        };
      }
      return { group, detail: null, action: null, live: group !== record };
    }
  }
}

/** The column ↔ group map: Needs you → needs you; Not started → none;
 *  Working → running; On hold (`waiting`) → on hold when queued or when
 *  Plyloft's quit paused it (F1), else none; Done → none. */
function constrainToColumn(
  record: InboxGroupName | null,
  column: AttentionColumn | null,
  state: CardPresentationState,
): InboxGroupName | null {
  if (record === null || column === null) return null;
  switch (column) {
    case "needs-you":
      return "needs_you";
    // D13: a card nobody started asks nothing of the person — the Inbox
    // leaves it out, as the Board leaves it out of Needs you.
    case "not-started":
      return null;
    case "working":
      return "running";
    case "waiting":
      return state === "queued" || record === "on_hold" ? "on_hold" : null;
    case "done":
      return null;
  }
}

// ── The session's words ────────────────────────────────────────────────

/** UX P-A Mac walk 4: the rules whose words outrank what the live session
 *  is doing — the card is stopped on something the person must answer or
 *  decide, so "Working" or "Build done" beside it would be untrue. */
const SESSION_OUTRANKING_RULES: ReadonlySet<PresentationRule> = new Set([
  "session-block",
  // P-B (point 4): a Builder waiting on the person, held as the card holds
  // it, so the session's row and header never say "building" beside it.
  "builder-waiting",
  "ship-conflict",
  "ship-failed",
]);

/** Rule 9's state → the session row's word after the vendor. */
const WAITING_ROW_WORD: Readonly<Record<BuilderWaitingState, string>> = {
  question: ACTOR_WORDS.question,
  stopped: ACTOR_WORDS.stopped,
  quiet: ACTOR_WORDS.quiet,
};

/**
 * UX P-A Mac walk 4: what a card's Builder session says when its card's
 * rule outranks the session — one presentation for the session panel's
 * header ("Asks to trust the folder") and the sidebar's session row
 * ("Claude · asks to trust the folder"), with the card's own dot. Null:
 * the session's own state speaks (`liveBuilderSessionState`, `cardActor`).
 */
export function cardSessionWords(
  p: Pick<CardPresentation, "rule" | "headline" | "dot" | "waiting">,
  vendor: "claude" | "codex" | undefined,
): { header: string; row: string; dot: BoardRunState; asks: boolean } | null {
  if (!SESSION_OUTRANKING_RULES.has(p.rule)) return null;
  const who = vendor === "codex" ? "Codex" : "Claude";
  const lower =
    (p.rule === "builder-waiting" && p.waiting ? WAITING_ROW_WORD[p.waiting] : undefined) ??
    `${p.headline.charAt(0).toLowerCase()}${p.headline.slice(1)}`;
  return {
    header: p.headline,
    row: vendor ? `${who} · ${lower}` : p.headline,
    dot: p.dot.state,
    // The session waits on a question: Finish and check has nothing to save.
    asks: p.rule === "session-block" || (p.rule === "builder-waiting" && p.waiting === "question"),
  };
}

// ── Callers' shapes ────────────────────────────────────────────────────

/** The Board's attention groups, each card in its presentation's column. */
export function presentAttentionGroups(
  cards: readonly KanbanCard[],
  present: (card: KanbanCard) => CardPresentation,
): AttentionGroups {
  const groups: AttentionGroups = { "needs-you": [], "not-started": [], working: [], waiting: [], done: [] };
  const seen = new Set<string>();
  for (const card of cards) {
    if (card.archived || seen.has(card.id)) continue;
    seen.add(card.id);
    const column = present(card).column;
    if (column) groups[column].push(card);
  }
  for (const id of ["needs-you", "not-started", "working", "waiting"] as const) {
    groups[id].sort((a, b) => boardSortKey(a) - boardSortKey(b));
  }
  groups.done.sort((a, b) => cardShippedAt(b) - cardShippedAt(a));
  return groups;
}

/** The List's stage of a card, from its presentation (CL-9/CL-10). */
export function presentationStage(card: KanbanCard, p: CardPresentation): BoardStage | null {
  return boardStageFor(p.state, { openPullRequest: prOpen(card), shipEligible: p.readyToShip });
}

/**
 * GH #257's "See the queue", with the filter keyed on the cards' words
 * (P-A): the two states' own words, and the word of every card running or
 * in line now — a running card may say "Building with both" or "Asks to
 * trust the folder", which "Working" alone would leave out (Challenger).
 */
export function queueFilterWords(
  cards: readonly KanbanCard[],
  present: (card: KanbanCard) => CardPresentation,
): string[] {
  const words = [CARD_STATE_PRESENTATION.running.label, CARD_STATE_PRESENTATION.queued.label];
  for (const card of cards) {
    if (card.archived) continue;
    const p = present(card);
    if (p.boardState !== "running" && p.boardState !== "queued") continue;
    const word = p.blocked ?? p.headline;
    if (!words.includes(word)) words.push(word);
  }
  return words;
}

/** The Board chip of earlier releases, now read off the presentation. */
/** 1.171.0 E3 (BI-3): a Needs you card's second line on the Board — the
 *  card's own Now primary (`action.label`, the same words the page's button
 *  says), never a word list of the Board's. Nothing in the other columns,
 *  nor while the primary is off (held, blocked). The Board's press opens the
 *  card; nothing runs from it. */
/** Primaries that destroy something: the Board never suggests them on a
 *  tile; the card's page says why before its button (Challenger). */
const BOARD_NEXT_LEFT_OUT: ReadonlySet<CardPrimaryActionId> = new Set<CardPrimaryActionId>(["delete-skill-card"]);

export function boardNextPress(p: Pick<CardPresentation, "column" | "action" | "held" | "blocked">): string | null {
  if (p.column !== "needs-you" || p.held || p.blocked) return null;
  if (BOARD_NEXT_LEFT_OUT.has(p.action.id)) return null;
  return p.action.label.trim() ? p.action.label : null;
}

/** 1.174.0 (A5, P16): the Board card's tooltip. Its "→ Merge" names the
 *  step inside the card — pressing the card opens it — while the Inbox's
 *  Merge merges in place, so the card's tooltip says the two apart. */
export function boardCardTitle(
  card: { title: string; pr?: { number: number } | null },
  p: Pick<CardPresentation, "column" | "action" | "held" | "blocked">,
): string {
  if (boardNextPress(p) && p.action.id === "pr-merge" && card.pr?.number != null) {
    return `Open the card to merge pull request #${card.pr.number}`;
  }
  return card.title;
}

export function boardChipOf(p: CardPresentation): BoardCardStateChip {
  return {
    state: p.boardState,
    label: p.headline,
    tone: p.tone,
    blocked: p.blocked,
    ...(p.rule === "setup" && p.setup ? { setup: p.setup } : {}),
    ...(p.rule === "intake-stopped" ? { intakeStopped: true } : {}),
  };
}

/**
 * The Board's chip from positional facts — the signature tests and the
 * self-check used before `presentCard`. A thin caller: the words are
 * `presentCard`'s.
 */
export function deriveBoardCardState(
  card: KanbanCard,
  linkedSwarmStatus: SwarmStatus | null,
  cards: readonly KanbanCard[] = [],
  planner: "claude" | "codex" = "claude",
  askingTrust = false,
  reviewTip: ReviewTipFacts | null = null,
  intakeStopped = false,
  plan: Pick<PlanOpenCard, "status" | "proposer" | "critic" | "roundsDone" | "pause"> | null = null,
): BoardCardStateChip {
  const p = presentCard(
    card,
    positionalLive(card, linkedSwarmStatus, cards, planner, askingTrust, reviewTip, intakeStopped, plan),
  );
  return { ...boardChipOf(p), ...(p.rule === "plan" && plan ? { plan: plan.status } : {}) };
}

/** The live facts of the positional signatures (tests, the self-check). The
 *  Board's one trust flag stood for the Builder's and the intake's question. */
function positionalLive(
  card: KanbanCard,
  linkedSwarmStatus: SwarmStatus | null,
  cards: readonly KanbanCard[],
  planner: "claude" | "codex",
  askingTrust: boolean,
  reviewTip: ReviewTipFacts | null,
  intakeStopped: boolean,
  plan: Pick<PlanOpenCard, "status" | "proposer" | "critic" | "roundsDone" | "pause"> | null,
): CardLive {
  return cardLive({
    linkedSwarmStatus,
    workspaceCards: cards,
    planner,
    reviewTip,
    intakeStop: intakeStopped ? "The intake conversation ended." : null,
    plan,
    session: askingTrust ? { vendor: "claude", state: null, block: { kind: "trust" } } : null,
    intakeTrust: askingTrust && card.intakeStatus === "active" ? "claude" : null,
  });
}

/** The List's row from positional facts (tests): `presentCard`'s words. */
export function boardListRowOf(
  card: KanbanCard,
  linkedSwarmStatus: SwarmStatus | null,
  cards: readonly KanbanCard[] = [],
  plannerOf: (card: KanbanCard) => "claude" | "codex" = () => "claude",
  askingTrust = false,
  reviewTip: ReviewTipFacts | null = null,
  intakeStopped = false,
  plan: PlanOpenCard | null = null,
): BoardListRow {
  return boardListRow(
    card,
    presentCard(card, positionalLive(card, linkedSwarmStatus, cards, plannerOf(card), askingTrust, reviewTip, intakeStopped, plan)),
  );
}

/** The List's stage from positional facts: the same presentation as the
 *  card's chip (CL-9/CL-10, SP-D). */
export function deriveBoardStage(
  card: KanbanCard,
  linkedSwarmStatus: SwarmStatus | null,
  reviewTip: ReviewTipFacts | null = null,
): BoardStage | null {
  return presentationStage(
    card,
    presentCard(card, positionalLive(card, linkedSwarmStatus, [], "claude", false, reviewTip, false, null)),
  );
}
