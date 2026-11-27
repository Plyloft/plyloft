// C6 (UX-6.2, 6.3, 6.5): the words a card page says about itself, from what
// the card already records. Pure — no React, no stores, no IPC — so node runs
// it (`src/lib/cardPage.test.ts`). The card's state and its one action stay
// `cardLifecycle.ts::CARD_STATE_PRESENTATION`; this file only says the facts
// around it: the properties, the session in words, and the card's story.
import { buildBothHistory } from "./buildBoth.ts";
import { PUT_BACK_SESSION_WORDS, swarmTemplateInUse } from "./cardLifecycle.ts";
import type { CardPresentationState, KanbanCard, ReviewRound } from "../ipc.ts";
import { reviewApprovedWord, smallNotesPhrase } from "./challengerReview.ts";
import { approvedWord, interruptedTurnHelper, overriddenByWho, overriddenWord, smallNotesWords } from "./deliveryWords.ts";
import type { UxError } from "./uxError.ts";
import { SET_UP_LABEL, needsSetUp, needsSetUpByWriter } from "./projectSetup.ts";
import { NO_CHECKS_SENTENCE, NO_CHECKS_WORD, cardHasNoChecks, entryHasNoChecks } from "./checksWords.ts";
import { prNowFact } from "./prStatus.ts";
import { machineWords, type Platform } from "./platform.ts";
import { issueAuthorWords } from "./cardClaim.ts";
import { teammateWork, teammateWorkError } from "./teammateWork.ts";
import { intakeStoppedHappened, intakeStoppedLabel } from "./intakeStopped.ts";
import { modelSentenceWords } from "./roleModels.ts";
import { retryActivityEntries } from "./retryOn.ts";
import { branchDeletedText } from "./branchCleanup.ts";
import { twoAisActivityWords } from "./planExchangeView.ts";
import { verifyNotNeeded } from "./skillCards.ts";
import { copyChangedWords } from "./copyWords.ts";
import type { ChangedFiles } from "./copies.ts";
import { ownShipEntry, shipEntryWords, shippedWords } from "./shipVersion.ts";
import { decodeTargetDirtyError, targetDirtyMessage } from "./shipPreflight.ts";
import {
  GITHUB_SIGN_IN_ACTION,
  OPEN_ON_GITHUB_ACTION,
  githubCause,
  githubCauseWords,
  githubRefusalPage,
  largeFileFact,
  largeFileWay,
  plainCause,
  SECRET_FACT,
  secretWay,
} from "./plainError.ts";
import { ASK_BUILDER_LABEL, NO_BUILDER_SENTENCE } from "./shipConflict.ts";
import { commitStop } from "./checksFix.ts";
import { targetHere } from "./worktreeBase.ts";
import { RELEASE_KIND_LABEL } from "./shippingPage.ts";
import {
  OPEN_PR_RETRY_LABEL,
  PR_ERROR_NAME,
  PR_OPEN_FAILED_WORDS,
  prOpenFailure,
} from "./shipVia.ts";
import { GH_INSTALL_ACTION, onlyHereInline, SHIP_HERE_ACTION, SHIP_NEEDS_GH_SHOWN, SHIP_IT_UNREADABLE_TAIL, SHIP_NEEDS_SIGN_IN_SHOWN, shipNeedsGitHub } from "./shipVia.ts";

/** Skills hub H3a: the Checks property of a skill card whose commit changed
 *  only skill files. */
export const NOT_NEEDED_WORD = "Not needed";

/** A run-state dot (`StateWord`, `Timeline`). */
export type RunDot = "running" | "done" | "aborted" | "empty";

export type Fact = { word: string; state: RunDot };

const VENDOR: Record<"claude" | "codex", string> = { claude: "Claude", codex: "Codex" };

export function vendorName(vendor: "claude" | "codex" | null | undefined): string {
  return vendor ? VENDOR[vendor] : "Claude";
}

/** OB-14 (§13.3): who wrote the card's plan — the last applied intake's
 *  vendor; records before OB-14 were all Claude. */
export function lastPlanner(card: Pick<KanbanCard, "intakeHistory">): "claude" | "codex" {
  const applied = (card.intakeHistory ?? []).filter((r) => r.applied);
  return applied[applied.length - 1]?.vendor ?? "claude";
}

/** GH #304: a card that is history — shipped, archived or closed. A step
 *  it has no record of is "Not recorded", never a step still to come. */
function isHistory(state: CardPresentationState | undefined): boolean {
  return state === "shipped" || state === "archived" || state === "closed";
}

const NOT_RECORDED: Fact = { word: "Not recorded", state: "empty" };

/** The Checks property: what the last verification said. GH #333: a pass
 *  with no checks set up is "None set up", never "Passed". */
export function checksFact(
  card: Pick<KanbanCard, "verifyStatus" | "verifyHistory">,
  state?: CardPresentationState,
): Fact {
  switch (card.verifyStatus) {
    case "passed":
      // Skills hub H3a (§4.2): a skill card's commit changed only skill files.
      if (verifyNotNeeded(card.verifyHistory)) return { word: NOT_NEEDED_WORD, state: "empty" };
      if (cardHasNoChecks(card)) return { word: NO_CHECKS_WORD, state: "empty" };
      return { word: "Passed", state: "done" };
    case "failed":
      return { word: "Failed", state: "aborted" };
    case "queued":
    case "running":
      return { word: "Running", state: "running" };
    case "skipped":
      return { word: "Skipped", state: "empty" };
    case "legacy":
      return NOT_RECORDED;
    default:
      return isHistory(state) ? NOT_RECORDED : { word: "Not run yet", state: "empty" };
  }
}

/**
 * 1.174.0 (TX1, T1; WALK 08): the labels of the card's Checks rows. A card
 * with no checks of its own whose open pull request has checks on GitHub
 * shows only GitHub's row (its "None set up" read as a contradiction); when
 * both are drawn, each says where it ran ("Checks on this Mac", "Checks on
 * GitHub"). `ownShown`: the card's own Checks fact is worth its place
 * (`factShown`). Null: that row is not drawn.
 */
export function checksRowLabels(
  card: Pick<KanbanCard, "verifyStatus" | "verifyHistory" | "pr" | "prUrl">,
  ownShown: boolean,
  p?: Platform,
): { own: string | null; github: string | null } {
  const pr = card.pr;
  const github = pr && card.prUrl && pr.state === "open" ? "Checks on GitHub" : null;
  if (!ownShown) return { own: null, github };
  if (!github) return { own: "Checks", github };
  const githubHasChecks = pr!.checkedAt != null && (pr!.checks !== "none" || Boolean(pr!.awaitingChecks));
  if (githubHasChecks && cardHasNoChecks(card)) return { own: null, github };
  return { own: machineWords("Checks on this Mac", p), github };
}

/** QoL 1.168 (C1, V-1): a fact worth its place in the card's facts line —
 *  the empty "Not run yet" and "Not reviewed yet" of a card nobody has
 *  built say nothing a person needs, so the line leaves them out. */
export function factShown(fact: Fact): boolean {
  return !(fact.state === "empty" && (fact.word === "Not run yet" || fact.word === "Not reviewed yet"));
}

/** CL-1: the Challenger property — who reviews (the vendor, never the
 *  model, which stays under Technical details) and its latest word:
 *  "Codex · approved (2 small notes)", "Claude · same vendor · reviewing". Without
 *  a review there is no vendor to name yet, so the word stands alone. */
export function challengerFact(
  card: Pick<KanbanCard, "builder" | "reviewStatus">,
  state?: CardPresentationState,
  /** Who is reading (`settings.identity.userEmail`): an override of theirs
   *  is "by you" (`overriddenByWho`). */
  me?: string | null,
): Fact {
  const fact = reviewFact(card, state, me);
  const review = card.builder?.review ?? null;
  if (!review) return fact;
  // A review skipped before it ran had no reviewer; an accepted pushback
  // keeps the vendor whose request it answered.
  if (review.status === "skipped" && !pushbackAccepted(review)) return fact;
  const parts = [vendorName(review.provider)];
  // OB-14: one AI set up (singleVendor) is a normal setup; the other vendor
  // unavailable (degraded) names the missing one.
  if (review.singleVendor) parts.push("same vendor");
  else if (review.degraded) {
    parts.push(`same vendor (${review.provider === "codex" ? "Claude" : "Codex"} unavailable)`);
  }
  parts.push(fact.word.charAt(0).toLowerCase() + fact.word.slice(1));
  return { word: parts.join(" · "), state: fact.state };
}

/** The review's latest word on the latest build (the Challenger property
 *  names its vendor around it, `challengerFact`). */
export function reviewFact(
  card: Pick<KanbanCard, "builder" | "reviewStatus">,
  state?: CardPresentationState,
  me?: string | null,
): Fact {
  const review = card.builder?.review ?? null;
  if (!review) {
    if (card.reviewStatus === "changes_requested") {
      return { word: "Changes requested", state: "aborted" };
    }
    // GH #304: "merged" is the pull request's state, not a review verdict.
    if (card.reviewStatus === "merged" || isHistory(state)) return NOT_RECORDED;
    return { word: "Not reviewed yet", state: "empty" };
  }
  switch (review.status) {
    case "running":
      return { word: "Reviewing", state: "running" };
    case "failed":
      return { word: "Couldn't finish", state: "aborted" };
    case "skipped":
      // Round 3 (RW-A): an accepted pushback is a decision, not a skip.
      // 1.171.0 C3 (CP-9): said as the person's — the Builder may never
      // have disagreed.
      return pushbackAccepted(review)
        ? { word: overriddenWord(review.overriddenBy, me), state: "done" }
        : { word: "Skipped", state: "empty" };
    case "done":
      if (review.verdict === "changes_requested") {
        return { word: "Changes requested", state: "aborted" };
      }
      if (review.verdict === "incomplete") return { word: "Incomplete", state: "aborted" };
      // 1.171.0 C3 (CF25): one approval word, its small notes counted.
      return { word: reviewApprovedWord(review), state: "done" };
  }
}

/** The vendor a Start build on this card opens: this session's pick (the
 *  optimistic value while it is being saved), else the card's saved choice,
 *  else the Settings default, else Claude. A live session's own
 *  `builder.vendor` is not this — it is the fact once a build started. */
export function effectiveBuilderVendor(
  sessionPick: "claude" | "codex" | null | undefined,
  card: Pick<KanbanCard, "builderVendorPref"> | null | undefined,
  settingsDefault: "claude" | "codex" | null | undefined,
): "claude" | "codex" {
  return sessionPick ?? card?.builderVendorPref ?? settingsDefault ?? "claude";
}

/** Tier 4 walk 2026-10-14: Start fresh on a closed session uses the vendor
 *  Start build would use (the card's own pick, else Settings), not the
 *  closed session's — a new session continues nothing, so a vendor changed
 *  in Settings since applies. When it differs, the button names it and its
 *  title says why. */
export function startFreshOffer(
  closedVendor: "claude" | "codex",
  vendor: "claude" | "codex",
  /** The closed session's posture; kept only for the same vendor (#378 P3-3). */
  closedBypass = false,
): { vendor: "claude" | "codex"; label: string; title: string; bypass: boolean } {
  const same = "Fresh session in the card's copy with the brief sent again; the work so far stays";
  if (vendor === closedVendor) return { vendor, label: "Start fresh", title: same, bypass: closedBypass };
  return {
    vendor,
    label: `Start fresh with ${vendorName(vendor)}`,
    title: `The closed session was ${vendorName(closedVendor)}; the Builder's AI is now ${vendorName(vendor)} (the card's Builder choice, or Settings › Cards › AI and models). A fresh ${vendorName(vendor)} session in the card's copy with the brief sent again; the work so far stays. The Reviewer becomes ${vendorName(closedVendor)}, the other AI, from the next review.`,
    bypass: false,
  };
}

/** The Builder property: who builds this card. */
export function builderFact(
  card: Pick<KanbanCard, "builder" | "swarmTemplateId" | "agentConfigId"> &
    Partial<Pick<KanbanCard, "buildBoth" | "linkedSwarmId" | "columnId">>,
  preferred: "claude" | "codex",
  state?: CardPresentationState,
): string {
  // SL-6: both build it until the owner picks one.
  if (card.buildBoth && !card.buildBoth.outcome) return "Claude and Codex";
  if (card.builder) return vendorName(card.builder.vendor);
  if (swarmTemplateInUse(card)) return "Several AIs";
  if (card.agentConfigId) return "An agent";
  if (isHistory(state)) return NOT_RECORDED.word;
  return `${vendorName(preferred)} (not started)`;
}

/** The Builder property is the vendor picker while nothing has started a
 *  build on the card: no Builder session, no swarm or agent runner, and
 *  the card is not history. Once a session exists the vendor is a fact. */
export function builderVendorChoosable(
  card: Pick<KanbanCard, "builder" | "swarmTemplateId" | "agentConfigId" | "archived"> &
    Partial<Pick<KanbanCard, "buildBoth" | "linkedSwarmId" | "columnId">>,
  state?: CardPresentationState,
): boolean {
  return (
    !card.builder &&
    !(card.buildBoth && !card.buildBoth.outcome) &&
    !swarmTemplateInUse(card) &&
    !card.agentConfigId &&
    !card.archived &&
    !isHistory(state)
  );
}

/** 1.172.0 (A2, owner): how the Builder asks can be chosen again before a
 *  new start, never while a session is open — the card's Builder session
 *  closed (Session closed, Start fresh) or the card moved back to Ready to
 *  start (Start build again). Not on a card whose copy is gone (shipped,
 *  merged, its copy kept), a pull request review's, archived or history,
 *  nor one built by both, a swarm or an agent. */
export function restartPermissionsChoosable(
  card: Pick<KanbanCard, "builder" | "swarmTemplateId" | "agentConfigId" | "archived"> &
    Partial<Pick<KanbanCard, "buildBoth" | "linkedSwarmId" | "columnId" | "prReview" | "shipStatus" | "reviewStatus" | "keptCopy">>,
  state?: CardPresentationState,
): boolean {
  const b = card.builder;
  return (
    b != null &&
    !b.ptyId &&
    (b.startedAt ?? 0) > 0 &&
    !card.prReview &&
    card.shipStatus !== "shipped" &&
    card.reviewStatus !== "merged" &&
    !card.keptCopy &&
    !(card.buildBoth && !card.buildBoth.outcome) &&
    !swarmTemplateInUse(card) &&
    !card.agentConfigId &&
    !card.archived &&
    !isHistory(state)
  );
}

/** 1.168.1 (E2): the card's Builder and Challenger models can be chosen
 *  for it: a card that can still run a Builder session or a review — not
 *  history or archived, not being built by both (each build has its own),
 *  not run by a swarm or an agent. */
export function roleModelChoosable(
  card: Pick<KanbanCard, "swarmTemplateId" | "agentConfigId" | "archived"> &
    Partial<Pick<KanbanCard, "buildBoth" | "linkedSwarmId" | "columnId">>,
  state?: CardPresentationState,
): boolean {
  return (
    !(card.buildBoth && !card.buildBoth.outcome) &&
    !swarmTemplateInUse(card) &&
    !card.agentConfigId &&
    !card.archived &&
    !isHistory(state)
  );
}

/** "just now", "4m", "2h", "3d". */
export function ago(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** GH #262: how many of the last verification's checks failed — "2 of 14
 *  checks failed.", "1 check failed." — never the total as the failures. */
export function checksFailedWords(steps: readonly { passed: boolean }[]): string {
  const total = steps.length;
  const failed = steps.filter((s) => !s.passed).length;
  if (failed === 0) return "The checks failed.";
  if (total === 1) return "1 check failed.";
  return `${failed} of ${total} checks failed.`;
}

/** GH #262: "Ply is running 3 checks.", with the plural right. */
export function checksRunningWords(total: number): string {
  if (total <= 0) return "Plyloft is running the checks.";
  return `Plyloft is running ${total} check${total === 1 ? "" : "s"}.`;
}

/** GH #257: when a run that is not a live Builder session started — never
 *  a made-up duration. */
export function runStartedWords(startedAt: number | null | undefined, now: number): string {
  return startedAt ? `Started ${ago(now - startedAt)}.` : "It is running now.";
}

/** What a live session is doing, in words (UX-6.3). Ply keeps no transcript
 *  of a Builder session — it is the vendor's own TUI in a PTY — so the words
 *  come from what the session reports: when it started, when it last printed
 *  and whether it sits at its prompt. */
export function sessionSummary(input: {
  vendor: "claude" | "codex";
  /** `deriveTileAttention` for the live session; null when none is attached. */
  attention: "working" | "asking-you" | "wants-you" | null;
  /** v1.154.1 (walk I6): the session's last scan found its turn over — the
   *  idle prompt, no question and nothing running in view
   *  (`BuilderRuntime.turnIdle`). Then "asking-you" is a prompt waiting for
   *  the next message, not a question waiting for an answer. */
  turnIdle?: boolean;
  startedAt: number;
  lastOutputAt: number | null;
  /** Files the build changed, when the Outcome has counted them. */
  filesChanged: number | null;
  /** CL-11 (walk b): the state the Now callout's title says
   *  (`cardActor(...).session`). When given it decides the sentence, so the
   *  line under "Claude · stopped" never says "Claude is working" —
   *  the title also counts the person typing at its prompt and Finish and check. */
  actor?: "building" | "stopped" | "question" | "quiet" | "saved" | "resumed";
  /** 1.174.3: the turn Resume brought back was cut off (`BuilderRuntime.turnInterrupted`). */
  turnInterrupted?: boolean;
  now: number;
}): string {
  const who = vendorName(input.vendor);
  const started = `Started ${ago(input.now - input.startedAt)}`;
  const files =
    input.filesChanged != null && input.filesChanged > 0
      ? ` ${input.filesChanged} file${input.filesChanged === 1 ? "" : "s"} changed so far.`
      : "";
  if (input.attention === null) {
    return `${who}'s session is not open here. ${started}.${files}`;
  }
  const actor = input.actor;
  if (actor === "saved") {
    // 1.171.0 C2 (CF8): no "turn" or "prompt" on screen.
    return `${who} says it's done, and its work is saved. ${started}.${files}`;
  }
  // 1.174.3: true from the press on, before the CLI has drawn anything.
  if (actor === "resumed") return `${who} hasn't started anything since Resume. ${started}.${files}`;
  if (actor === "stopped" || (!actor && input.attention === "asking-you" && input.turnIdle)) {
    if (input.turnInterrupted) return `${interruptedTurnHelper(who)} ${started}.${files}`;
    return `${who} says it's done. ${started}.${files}`;
  }
  if (actor === "question" || (!actor && input.attention === "asking-you")) {
    return `${who} asks you something. ${started}.${files}`;
  }
  const last =
    input.lastOutputAt != null ? `, last output ${ago(input.now - input.lastOutputAt)}` : "";
  if (actor === "quiet" || (!actor && input.attention === "wants-you")) {
    return `${who} has gone quiet: it may be asking something. ${started}${last}.${files}`;
  }
  return `${who} is working in the card's copy. ${started}${last}.${files}`;
}

// ── UX-6.5: the card's story ───────────────────────────────────────────

/** Where a Timeline event leads: the detail it opens below. */
export type TimelineLinkKind = "plan" | "session" | "diff" | "checks" | "review" | "ship" | "rounds" | "card";

export interface CardTimelineItem {
  id: string;
  state: RunDot;
  text: string;
  at: number;
  live?: boolean;
  /** CL-5: a review round's link opens its findings (`round`, `findingIds`,
   *  `ariaLabel` naming the round); `rounds` shows the earlier rounds
   *  folded away. */
  link?: {
    kind: TimelineLinkKind;
    label: string;
    intakeId?: string;
    round?: number;
    findingIds?: string[];
    ariaLabel?: string;
    /** N19: a `card` link opens this card of the same workspace. */
    cardId?: string;
  };
}

/** CL-5: the review rounds Activity shows before folding the older ones. */
export const ROUNDS_SHOWN = 4;

type RoundLike = Pick<ReviewRound, "round" | "verdict" | "new" | "notes" | "closed" | "stillOpen" | "provider"> &
  Partial<Pick<ReviewRound, "model">>;

/** CL-5: "Round 2 · Codex · approved (1 small note) · 2 closed" — the
 *  round, who reviewed, the verdict in words (1.171.0 C3: an approval with
 *  its small notes), then what changed (only counts above 0). */
export function reviewRoundText(r: RoundLike): string {
  const notes = r.notes ?? 0;
  const approved = r.verdict !== "changes_requested" && r.verdict !== "incomplete";
  const verdict =
    r.verdict === "changes_requested"
      ? "changes requested"
      : r.verdict === "incomplete"
        ? "couldn't see enough to judge"
        : lowerFirst(approvedWord(notes));
  const counts = [
    r.new > 0 ? `${r.new} new` : null,
    r.closed > 0 ? `${r.closed} closed` : null,
    r.stillOpen > 0 ? `${r.stillOpen} still open` : null,
    notes > 0 && !approved ? smallNotesWords(notes) : null,
  ].filter((part): part is string => part !== null);
  // 1.169.0 (A3): the model it reviewed on, when recorded — two attempts
  // of a round read apart.
  const on = modelSentenceWords(r.model);
  const who = on ? `${vendorName(r.provider as "claude" | "codex")} on ${on}` : vendorName(r.provider as "claude" | "codex");
  return [`Round ${r.round}`, who, verdict, ...counts].join(" · ");
}

/** CL-5 round 2: the muted line for rounds the card has no record of —
 *  between `after` and `before` (exclusive). null when there is no gap. */
export function unrecordedRoundsText(after: number, before: number, trimmed = false): string | null {
  const first = after + 1;
  const last = before - 1;
  if (last < first) return null;
  // CL-5 round 3: rounds the card kept and its cap later dropped.
  if (trimmed) return first === last ? `Round ${first} is no longer kept` : `Rounds ${first}–${last} are no longer kept`;
  return first === last ? `Round ${first} wasn't recorded` : `Rounds ${first}–${last} weren't recorded`;
}

/** CL-5 round 2: the ids a round's findings link shows — none when the
 *  round touched no finding, or its ledger has since started over (the ids
 *  name findings that are gone, and may be reused). */
export function roundFindingIds(r: Pick<ReviewRound, "newIds" | "closedIds" | "stillOpenIds">, ledgerGone: boolean): string[] {
  if (ledgerGone) return [];
  return [...new Set([...(r.newIds ?? []), ...(r.closedIds ?? []), ...(r.stillOpenIds ?? [])])];
}

/** CL-5: the rounds Activity lists, and how many earlier ones are folded
 *  away (all are listed once `showAll`). */
export function visibleRounds<T>(rounds: readonly T[], showAll: boolean): { shown: T[]; hidden: T[] } {
  if (showAll || rounds.length <= ROUNDS_SHOWN) return { shown: [...rounds], hidden: [] };
  return { shown: rounds.slice(-ROUNDS_SHOWN), hidden: rounds.slice(0, rounds.length - ROUNDS_SHOWN) };
}

const LINK_LABEL: Record<TimelineLinkKind, string> = {
  plan: "Read the plan",
  session: "Open the Builder",
  diff: "See the changes",
  checks: "See the checks",
  review: "Read the review",
  ship: "See what shipped",
  rounds: "Show them",
  card: "Open it",
};

function link(kind: TimelineLinkKind, intakeId?: string): CardTimelineItem["link"] {
  return intakeId ? { kind, label: LINK_LABEL[kind], intakeId } : { kind, label: LINK_LABEL[kind] };
}

/** 1.174.0 C5 (P43, T45): a ship row's link says what it opens — the pull
 *  request on GitHub, or what shipped on this computer. */
export const SEE_PULL_REQUEST_LABEL = "See the pull request";
export const SEE_WHAT_SHIPPED_LABEL = "See what shipped";
function shipLink(pullRequest: boolean): CardTimelineItem["link"] {
  return { kind: "ship", label: pullRequest ? SEE_PULL_REQUEST_LABEL : SEE_WHAT_SHIPPED_LABEL };
}
/** C5 (T45): the skipped review's link opens the Review, which says why. */
export const WHY_SKIPPED_LABEL = "Why it was skipped";

type TimelineCard = Pick<
  KanbanCard,
  | "createdAt"
  | "updatedAt"
  | "notes"
  | "ghIssueNumber"
  | "intakeHistory"
  | "builder"
  | "runHistory"
  | "verifyHistory"
  | "shipHistory"
  | "prUrl"
  | "reviewStatus"
  | "archived"
  | "archivedAt"
  | "autoArchived"
> &
  Partial<
    Pick<
      KanbanCard,
      | "pr"
      | "buildBoth"
      | "ghAuthor"
      | "putBacks"
      | "intakeStatus"
      | "branchCleanup"
      | "followedUpBy"
      | "prReview"
      | "modelRetries"
      | "fromCopy"
    >
  >;

/**
 * Every lifecycle event the card records, oldest first, each with at most one
 * link (UX-6.5). CL-5: each review round the card keeps is one event, linking
 * to that round's findings; past `ROUNDS_SHOWN` the older ones fold into one
 * row until `showAllRounds`. A card with no rounds (before CL-5) shows its
 * latest review alone; a link to a detail sits on its latest event.
 */
export function cardTimeline(
  card: TimelineCard,
  opts: {
    showAllRounds?: boolean;
    /** N14 (item 6): the GitHub login the workspace's cards are seen from. */
    login?: string | null;
    /** N19: whether a linked card still exists — a deleted one has no link. */
    cardExists?: (cardId: string) => boolean;
    /** 1.171.0 C3: who is reading (`overriddenByWho`). */
    me?: string | null;
  } = {},
): CardTimelineItem[] {
  const items: CardTimelineItem[] = [];
  // Challenger on a pull request: its heads and the Challenger's rounds,
  // and a fix session on the member's own; its findings are on the page.
  const prReview = card.prReview ?? null;
  // N14 (item 6): who opened the issue, when it is someone else.
  const author = card.ghIssueNumber ? issueAuthorWords(card.ghAuthor, opts.login ?? null) : null;
  items.push({
    id: "created",
    state: "empty",
    // T3 (team walk 2026-10-02): a GitHub-backed card may have been written
    // by anyone on the team; its first event is the issue, not "you".
    text: prReview
      ? `Made to review pull request #${prReview.number}`
      : card.fromCopy
      ? // 1.174.0 C4 (P17): where its work came from, not in its brief.
        `Made from the copy \u201c${card.fromCopy.name}\u201d in Terminals`
      : author
      ? author
      : card.ghIssueNumber
      ? `Opened as issue #${card.ghIssueNumber}`
      : (card.notes ?? "").trim()
        ? "You described the card"
        : "Card created",
    at: card.createdAt,
  });

  const intakes = card.intakeHistory ?? [];
  intakes.forEach((r, i) => {
    const at = r.concludedAt ?? r.startedAt;
    // Challenger P3: "Planned again" only when a new conversation followed
    // (a later record, or one still live); a Plan again whose start failed
    // says only that planning stopped.
    const followed = i < intakes.length - 1 || card.intakeStatus === "active";
    // OB-14 (§13.3): the vendor that planned it; older records were Claude.
    const planner = vendorName(r.vendor ?? "claude");
    items.push(
      r.applied
        ? {
            id: `intake-${r.intakeId}`,
            state: "done",
            // Plan with two AIs: "Planned with Claude and Codex (2 rounds)",
            // proposer first; one vendor twice says so.
            text: twoAisActivityWords(r) ?? `Planned with ${planner}`,
            at,
            link: r.transcriptPath || r.dispatchPrompt ? link("plan", r.intakeId) : undefined,
          }
        : r.replanned
        ? // N14 walk F20: ended by Plan again, which started anew at once.
          { id: `intake-${r.intakeId}`, state: "empty", text: followed ? "Planned again" : `Planning with ${planner} stopped`, at }
        : { id: `intake-${r.intakeId}`, state: "empty", text: `Planning with ${planner} was cancelled`, at },
    );
  });

  // N14 walk F19: each time the card went back to To do.
  (card.putBacks ?? []).forEach((at, i) => {
    items.push({ id: `put-back-${i}-${at}`, state: "empty", text: "Moved back to Ready to start", at });
  });

  const builder = card.builder ?? null;
  if (builder) {
    const who = vendorName(builder.vendor);
    const live = Boolean(builder.ptyId);
    const snaps = builder.snapshots ?? [];
    // GH #305: `startedAt` is the newest session's start ("Start fresh"
    // and Resume reset it; the snapshots stay). When it is later than the
    // first build, the first session's start is not recorded: the story says
    // the building started no later than that build, and the newer session
    // is its own event.
    const restarted = !prReview && snaps.length > 0 && builder.startedAt > snaps[0].at;
    if (restarted) {
      items.push({ id: "builder-start", state: "done", text: `${who} started building`, at: snaps[0].at });
    }
    // Walk 3 of #386 (finding 9), walk 4: each Builder session on a pull
    // request card — a new one or a resumed one — is its own entry; the
    // newest is the live one. A review-only card has no session to open.
    if (prReview) {
      const starts = [...new Set([...(prReview.fixStarts ?? []), builder.startedAt].filter((at) => at > 0))].sort(
        (a, b) => a - b,
      );
      starts.forEach((at, i) => {
        const newest = i === starts.length - 1;
        items.push({
          id: newest ? "builder-start" : `builder-start-${at}`,
          state: newest && live ? "running" : "done",
          live: newest && live,
          text: `${who} started fixing it`,
          at,
          link: newest && prReview.pushable ? link("session") : undefined,
        });
      });
    }
    // A pull request review has a Builder only once one fixes it.
    // 1.169.0 walk: a "Retry on…" session is its own entry (the retry's); the
    // first start keeps its own time, not the retry's.
    const retriedFrom = (card.modelRetries ?? [])
      .filter((r) => r.role === "builder" && (r.fromStartedAt ?? 0) > 0)
      .map((r) => r.fromStartedAt as number);
    const firstStart = Math.min(builder.startedAt, ...retriedFrom);
    if (!prReview && !restarted && firstStart < builder.startedAt) {
      items.push({ id: "builder-start", state: "done", text: `${who} started building`, at: firstStart });
    } else if (!prReview) {
      items.push({
        id: restarted ? "builder-restart" : "builder-start",
        state: live ? "running" : "done",
        live,
        text: restarted ? `${who} started again` : `${who} started building`,
        at: builder.startedAt,
        link: link("session"),
      });
    }
    // GH #305: a build is said in words; its snapshot number and SHA are in
    // Technical details. P-D2 (Mac walk): so are a pull request's reads,
    // merges and pushes; each row's time tells them apart.
    // Walk 3 of #386 (finding 5), walk 4: new commits read under the fix,
    // then the snapshot that merged them (`snapshot`: Bring in the new
    // commits or the Builder's own merge), which is not "fixed it".
    const merges = prReview?.merges ?? [];
    const mergeSnapshots = new Set<number>();
    merges.forEach((m) => {
      items.push({
        id: `pr-merge-read-${m.head}-${m.at}`,
        state: "done",
        text: "Read the pull request's new commits",
        at: m.at,
      });
      if (m.snapshot != null) mergeSnapshots.add(m.snapshot);
    });
    snaps.forEach((s, i) => {
      if (prReview) {
        const head = (prReview.heads ?? []).includes(s.n);
        items.push({
          id: `snapshot-${s.n}`,
          state: "done",
          text: head
            ? i === 0
              ? `Read pull request #${prReview.number}`
              : "Read the pull request's new commits"
            : mergeSnapshots.has(s.n)
              ? "Merged the pull request's new commits"
              : `${who} fixed it`,
          at: s.at,
        });
        return;
      }
      items.push({
        id: `snapshot-${s.n}`,
        state: "done",
        text: i === 0 ? `${who} built it` : `${who} built it again`,
        at: s.at,
        link: i === snaps.length - 1 ? link("diff") : undefined,
      });
    });
    const rounds = builder.reviewRounds ?? [];
    const { shown, hidden } = visibleRounds(rounds, opts.showAllRounds ?? false);
    if (hidden.length > 0) {
      items.push({
        id: "review-rounds-earlier",
        state: "empty",
        text: `${hidden.length} earlier review round${hidden.length === 1 ? "" : "s"}`,
        at: hidden[0].at,
        link: link("rounds"),
      });
    }
    // CL-5 round 2: the last ledger that started over; rounds before it
    // keep their counts but their findings are gone.
    let restart = -1;
    rounds.forEach((r, i) => {
      if (r.ledgerRestart) restart = i;
    });
    shown.forEach((r) => {
      const i = rounds.indexOf(r);
      const gap = unrecordedRoundsText(i > 0 ? rounds[i - 1].round : 0, r.round, i === 0 && (r.trimmedBefore ?? false));
      if (gap) items.push({ id: `review-round-gap-${r.reviewId}`, state: "empty", text: gap, at: r.at });
      if (i === restart && i > 0) {
        items.push({
          id: `review-round-restart-${r.reviewId}`,
          state: "empty",
          text: "The findings of earlier rounds are no longer kept",
          at: r.at,
        });
      }
      const ids = roundFindingIds(r, i < restart);
      items.push({
        id: `review-round-${r.reviewId}`,
        state: r.verdict === "approve" ? "done" : "aborted",
        text: reviewRoundText(r),
        at: r.at,
        link:
          ids.length > 0 && !prReview
            ? { kind: "review", label: "See its findings", ariaLabel: `See round ${r.round}'s findings`, round: r.round, findingIds: ids }
            : undefined,
      });
    });
    // CL-5: the latest review's own row, unless it is a round listed above.
    const review = builder.review ?? null;
    const reviewIsRound =
      review?.status === "done" && review.reviewId != null && rounds.some((r) => r.reviewId === review.reviewId);
    if (review && !reviewIsRound) {
      const reviewer = vendorName(review.provider);
      const base = { id: `review-${review.snapshotN}`, at: review.at };
      if (review.status === "running") {
        items.push({
          ...base,
          state: "running",
          live: true,
          text: prReview ? `${reviewer} is reviewing the pull request` : `${reviewer} is reviewing the latest build`,
        });
      } else if (review.status === "failed") {
        items.push({ ...base, state: "aborted", text: `${reviewer}'s review couldn't finish`, link: link("review") });
      } else if (review.status === "skipped" && pushbackAccepted(review)) {
        // Round 3 (RW-A): the Challenger's request overridden — accepted
        // pushback (or Build done + Skip review on the same build) — is not
        // a review never run. 1.171.0 C3 (CP-9): the person's decision.
        const who = overriddenByWho(review.overriddenBy, opts.me);
        items.push({
          ...base,
          state: "done",
          text: `${who === "you" ? "You" : who} overrode the requested changes`,
          link: link("review"),
        });
      } else if (review.status === "skipped") {
        items.push({ ...base, state: "empty", text: "The review was skipped", link: { kind: "review", label: WHY_SKIPPED_LABEL } });
      } else {
        const verdict =
          review.verdict === "changes_requested"
            ? "changes requested"
            : review.verdict === "incomplete"
              ? "couldn't see enough to judge"
              : lowerFirst(reviewApprovedWord(review));
        items.push({
          ...base,
          state: review.verdict === "approve" || review.verdict == null ? "done" : "aborted",
          // OB-14 (§13.2): one AI installed — said plainly, not as a fault.
          text: review.singleVendor
            ? `${reviewer} reviewed its own build (a separate, read-only session) · ${verdict}`
            : `${reviewer} reviewed it · ${verdict}`,
          link: link("review"),
        });
      }
    }
  }

  // Walk 2 of #386: each Push the fixes GitHub took, and the pull request's
  // merge or close as Plyloft read it.
  if (prReview) {
    (prReview.pushes ?? []).forEach((p) => {
      items.push({
        id: `pr-push-${p.sha}-${p.at}`,
        state: "done",
        text: `Pushed the fix to pull request #${prReview.number}`,
        at: p.at,
      });
    });
    if (prReview.state !== "open" && (prReview.closedAt ?? 0) > 0) {
      items.push({
        id: "pr-closed",
        state: "done",
        text: `Pull request #${prReview.number} was ${prReview.state === "merged" ? "merged" : "closed"}`,
        at: prReview.closedAt!,
      });
    }
  }

  // SL-6: a card built by both — the two builds, the comparison and the
  // pick, which names the build set aside and its kept branch.
  const bb = card.buildBoth ?? null;
  if (bb) {
    const undecided = !bb.outcome;
    items.push({
      id: "both-start",
      state: undecided ? "running" : "done",
      live: undecided,
      text: "Claude and Codex both started building",
      at: bb.startedAt,
      link: undecided ? link("session") : undefined,
    });
    for (const lane of bb.lanes) {
      if (lane.done) {
        items.push({ id: `both-done-${lane.lane}`, state: "done", text: `${vendorName(lane.vendor)}'s build is done`, at: lane.done.at });
      }
    }
    const c = bb.compare ?? null;
    if (c?.status === "running") {
      items.push({ id: "both-compare", state: "running", live: true, text: "The Reviewer is comparing the two builds", at: c.startedAt ?? bb.startedAt });
    } else if (c?.status === "done") {
      const rec = bb.lanes.find((l) => l.lane === c.recommended);
      items.push({
        id: "both-compare",
        state: "done",
        text: rec
          ? `The Reviewer compared them · recommends ${vendorName(rec.vendor)}'s`
          : "The Reviewer compared them · recommends neither",
        at: c.at ?? bb.startedAt,
      });
    } else if (c?.status === "failed") {
      items.push({ id: "both-compare", state: "aborted", text: "The comparison couldn't finish", at: c.at ?? bb.startedAt });
    }
    const history = buildBothHistory(bb);
    if (history && bb.outcome) {
      items.push({ id: "both-outcome", state: "done", text: history, at: bb.outcome.at });
    }
  }

  const runs = card.runHistory ?? [];
  runs.forEach((r, i) => {
    const files = r.filesChangedCount;
    const changed = files > 0 ? ` · ${files} file${files === 1 ? "" : "s"} changed` : "";
    const last = i === runs.length - 1;
    if (r.status === "done") {
      items.push({ id: `run-${r.runId}`, state: "done", text: `The run finished${changed}`, at: r.endedAt, link: last ? link("diff") : undefined });
    } else if (r.status === "killed") {
      items.push({ id: `run-${r.runId}`, state: "empty", text: "The run was stopped", at: r.endedAt });
    } else {
      items.push({ id: `run-${r.runId}`, state: "aborted", text: "The run failed", at: r.endedAt, link: last ? link("session") : undefined });
    }
  });

  const checks = card.verifyHistory ?? [];
  // 1.172.0 D2 (walk#6): "No checks set up" is said once, not per round —
  // at the latest run that had none.
  const lastNoChecks = checks.map((v) => entryHasNoChecks(v)).lastIndexOf(true);
  checks.forEach((v, i) => {
    const steps = v.steps ?? [];
    const passed = steps.filter((s) => s.passed).length;
    const count = steps.length > 0 ? ` · ${passed} of ${steps.length}` : "";
    const last = i === checks.length - 1 ? link("checks") : undefined;
    const id = `checks-${v.verifyRunId}`;
    if (entryHasNoChecks(v)) {
      if (i === lastNoChecks) items.push({ id, state: "empty", text: NO_CHECKS_SENTENCE, at: v.endedAt, link: last });
    }
    else if (v.status === "passed") items.push({ id, state: "done", text: `Checks passed${count}`, at: v.endedAt, link: last });
    else if (v.status === "failed") items.push({ id, state: "aborted", text: `Checks failed${count}`, at: v.endedAt, link: last });
    else if (v.status === "skipped") items.push({ id, state: "empty", text: "Checks skipped", at: v.endedAt, link: last });
  });

  const ships = card.shipHistory ?? [];
  const pr = card.prUrl ? card.pr ?? null : null;
  ships.forEach((s, i) => {
    const v = shipEntryWords(s);
    // SL-1: the ship a merged pull request recorded says so.
    const merged =
      pr?.state === "merged" && s.commitSha !== "" && (s.commitSha === pr.mergeCommit || s.commitSha === pr.headSha);
    items.push({
      id: `ship-${s.commitSha}-${s.shippedAt}`,
      state: "done",
      text: merged ? `Pull request #${pr!.number} merged` : v ? `Shipped in ${v}` : "Shipped",
      at: s.shippedAt,
      link: i === ships.length - 1 ? shipLink(merged) : undefined,
    });
  });
  if (pr) {
    // SL-1: when it was opened, and a close without merging.
    items.push({
      id: "pr",
      state: "done",
      text: `Opened pull request #${pr.number}`,
      at: pr.openedAt ?? card.updatedAt,
      link: pr.state === "merged" ? undefined : shipLink(true),
    });
    if (pr.state === "closed" && pr.closedAt != null) {
      items.push({ id: "pr-closed", state: "aborted", text: `Pull request #${pr.number} closed without merging`, at: pr.closedAt });
    }
  } else if (card.prUrl && card.reviewStatus === "merged" && ships.length === 0) {
    // 1.171.0 B1 (CP-2): never read back, so never "Shipped": it opened.
    items.push({ id: "pr", state: "done", text: "Opened a pull request on GitHub", at: card.updatedAt, link: shipLink(true) });
  }

  if (card.archivedAt != null) {
    items.push(
      card.archived
        ? {
            id: "archived",
            state: "empty",
            text: card.autoArchived ? "Archived by Plyloft, 14 days after it shipped" : "Archived",
            at: card.archivedAt,
          }
        : { id: "archived", state: "empty", text: "Archived, then restored", at: card.archivedAt },
    );
  }

  // N18: the card's branch, deleted once its trash entry expired (or kept
  // because the card started again).
  const deleted = branchDeletedText(card.branchCleanup);
  if (deleted && card.branchCleanup) {
    items.push({
      id: `branch-${card.branchCleanup.outcome}-${card.branchCleanup.tip}`,
      state: "empty",
      text: deleted,
      at: card.branchCleanup.outcomeAt ?? card.branchCleanup.since,
    });
  }

  // N19: each card made to follow this one up, linked to it. Its title
  // is the one it had when it was made (a later rename shows on that card).
  // A deleted one says so, as "Follows up" does the other way.
  (card.followedUpBy ?? []).forEach((f) => {
    const gone = opts.cardExists?.(f.cardId) === false;
    items.push({
      id: `followed-up-${f.cardId}`,
      state: "empty",
      text: gone ? `Followed up by “${f.title}” (deleted)` : `Followed up by “${f.title}”`,
      at: f.at,
      link: gone ? undefined : { kind: "card", label: LINK_LABEL.card, ariaLabel: `Open “${f.title}”`, cardId: f.cardId },
    });
  });

  // 1.169.0 (A3): each "Retry on…", with the model it had and the new one.
  // Owner C: the Builder's attempts are two entries, each with its model and outcome.
  (card.modelRetries ?? []).forEach((r, i) => {
    retryActivityEntries(r).forEach((e) => {
      items.push({ id: `model-retry-${i}-${e.earlier ? "from" : "on"}-${e.at}`, state: "empty", text: e.text, at: e.at });
    });
  });

  // Challenger on a pull request: its review and findings are the page's
  // Now, and it has no result or diff section to open.
  const shown = prReview
    ? items.map((item) =>
        item.link && (item.link.kind === "review" || item.link.kind === "diff" || item.link.kind === "checks")
          ? { ...item, link: undefined }
          : item,
      )
    : items;
  // A stable order: by time, the order above breaking ties.
  return shown
    .map((item, i) => ({ item, i }))
    .sort((a, b) => a.item.at - b.item.at || a.i - b.i)
    .map(({ item }) => item);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "09:12" today, "12 Sep 09:12" before today, "12 Sep 2025" in another year. */
export function timelineWhen(at: number, now: number): string {
  const d = new Date(at);
  const n = new Date(now);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return hhmm;
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === n.getFullYear() ? `${day} ${hhmm}` : `${day} ${d.getFullYear()}`;
}

/** "24 Sep", or "24 Sep 2025" in another year. */
export function dayWords(at: number, now: number): string {
  const d = new Date(at);
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === new Date(now).getFullYear() ? day : `${day} ${d.getFullYear()}`;
}

type NowCard = Pick<
  KanbanCard,
  | "verifyStatus"
  | "verifyHistory"
  | "builder"
  | "shipHistory"
  | "prUrl"
  | "reviewStatus"
  | "shipStatus"
  | "archivedAt"
  | "autoArchived"
  | "lastRunStatus"
> &
  Partial<Pick<KanbanCard, "pr" | "columnId" | "putBacks" | "branchName" | "worktreePath" | "fromCopy">>;

/** N14 walk F19: what the Now box says of a card put back in To do whose
 *  branch (or worktree) is still recorded — the work is kept, not lost. */
/** Now's line on a card made from a copy that hasn't started: what its copy
 *  holds, and that Start build carries on with it. */
// G2 (1.173.0): the Now line below names the Reviewer (once the Challenger).
export function fromCopyNow(name: string, changes: ChangedFiles | null): string {
  const changed = changes ? copyChangedWords(changes) : null;
  const what = changed ? `${changed[0].toUpperCase()}${changed.slice(1)}.` : null;
  const lead = `Made from the copy \u201c${name}\u201d, with the work done there.`;
  // 1.174.0 C4 (T22): the checks are "your checks", never "Verify".
  return [lead, what, "Start build carries on with it; then the Reviewer and your checks look at it."].filter(Boolean).join(" ");
}

export const PUT_BACK_NOW = "Moved back to Ready to start — its branch keeps the work; Start build picks it up again.";

/**
 * GH #253: the Now callout's line as facts from the card — what is true,
 * never what the button does (that is its tooltip). Null keeps the state's
 * own sentence (`CARD_STATE_PRESENTATION`).
 */
export function nowFacts(
  state: CardPresentationState,
  card: NowCard,
  context: { filesChanged: number | null; now: number; me?: string | null; copyChanges?: ChangedFiles | null },
): string | null {
  switch (state) {
    case "draft":
      // 1.174.0 C4: a card made from a copy starts with an empty brief.
      return card.fromCopy ? fromCopyNow(card.fromCopy.name, context.copyChanges ?? null) : null;
    case "ready":
      // 1.173.0 A3 (walk fix a): a card made from a copy says the work there
      // is its own, and what Start build does with it.
      if (card.fromCopy) return fromCopyNow(card.fromCopy.name, context.copyChanges ?? null);
      return card.columnId === "todo" &&
        (card.putBacks?.length ?? 0) > 0 &&
        Boolean(card.branchName?.trim() || card.worktreePath?.trim())
        ? PUT_BACK_NOW
        : null;
    case "ready-to-ship": {
      const n = context.filesChanged;
      const files = n != null && n > 0 ? `${n} file${n === 1 ? "" : "s"} changed.` : null;
      const checks =
        card.verifyStatus === "passed"
          ? verifyNotNeeded(card.verifyHistory)
            ? "only skill files changed, so there is nothing to verify"
            : cardHasNoChecks(card)
            ? "no checks are set up"
            : "checks passed"
          : card.verifyStatus === "skipped"
            ? "the checks were skipped"
            : null;
      const review = card.builder?.review ?? null;
      const reviewed =
        review?.status === "done" && (review.verdict === "approve" || review.verdict == null)
          ? // 1.171.0 C3 (CF25): the one approval word, its small notes counted.
            `the Reviewer approved it${smallNotesPhrase(review) ? ` (${smallNotesPhrase(review)})` : ""}`
          : review?.status === "skipped"
            ? pushbackAccepted(review)
              ? `${overriddenByWho(review.overriddenBy, context.me)} overrode the requested changes`
              : "the review was skipped"
            : null;
      const both = [checks, reviewed].filter(Boolean) as string[];
      const rest = both.length > 0 ? `${both.join(" and ")}.` : null;
      const line = [files, rest && rest[0].toUpperCase() + rest.slice(1)].filter(Boolean).join(" ");
      return line || null;
    }
    case "shipped": {
      // SL-1: a pull request read back from GitHub — open, or merged.
      const prLine = prNowFact(card, (at) => dayWords(at, context.now));
      if (prLine) return prLine;
      // 1.174.0 (DR2 round 1): the card's own ship, not a later release's.
      const last = ownShipEntry(card);
      if (last) {
        const v = shipEntryWords(last);
        const day = dayWords(last.shippedAt, context.now);
        return v ? `Shipped in ${v} on ${day}.` : `Shipped on ${day}.`;
      }
      const pr = card.prUrl ? /\/pull\/(\d+)/.exec(card.prUrl) : null;
      if (card.reviewStatus === "merged") {
        // Never read back from GitHub (before SL-1): it opened; whether it
        // merged is not known here.
        // 1.171.0 B1 (CP-2): it opened; "Shipped" waits for a merge.
        return pr ? `Its pull request #${pr[1]} was opened on GitHub.` : "Its pull request was opened on GitHub.";
      }
      return null;
    }
    case "archived":
      if (card.archivedAt == null) return null;
      return card.autoArchived
        ? `Plyloft archived it on ${dayWords(card.archivedAt, context.now)}, 14 days after it shipped.`
        : `Archived on ${dayWords(card.archivedAt, context.now)}.`;
    case "failed":
      switch (card.lastRunStatus) {
        case "rate_limited":
          return "The provider's rate limit stopped the run.";
        case "aborted":
          return "The run was stopped before it finished.";
        case "failed":
          return "The run failed.";
        default:
          return null;
      }
    default:
      return null;
  }
}

// ── UX-6.8: the card's own errors, in the error shape ──────────────────


/** The raw text of whatever was thrown, for `Details` only. */
export function rawError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

/** GH #306: the files git named in a merge conflict (`CONFLICT (…): Merge
 *  conflict in <path>`), or null when `raw` is not a merge conflict. */
export function mergeConflictPaths(raw: string): string[] | null {
  if (!/merge conflict|\bCONFLICT \(/i.test(raw)) return null;
  const paths = [...raw.matchAll(/Merge conflict in (\S+)/g)].map((m) => m[1]);
  return [...new Set(paths)];
}

/** A press on the card that failed ("Start build", "Try again"). */
/** H6b (Windows walk): `commands::skill_pr_carries_local_commits`'s refusal —
 *  a skill card's pull request stopped because it starts from a local target
 *  holding commits GitHub's lacks. `said` is the refusal's own account (any
 *  sentence before it, from the preflight, included), without its last
 *  "Publish …, then ship again." — which the error's What to do carries. */
export function skillPrLocalRefusal(raw: string): { branch: string; said: string } | null {
  const m = /^(.*?This skill card starts from your local (.+?), which has \d+ commits? GitHub's \2 doesn't\. A pull request from it would carry them too, so nothing was shipped\.)\s*Publish \2, then ship again\.?$/s.exec(
    raw.trim(),
  );
  return m ? { branch: m[2], said: m[1] } : null;
}

/** QoL 1.168 (C4): what the card page can do about a failed press — repeat
 *  it (`retry`), and whether the card has a Builder to ask. */
export interface CardActionErrorWays {
  retry?: boolean;
  /** The card's Builder may be asked to commit the project folder's
   *  changes (`checksFix.builderMayCommit`: Claude, asking first). */
  builder?: boolean;
  /** R11 (Challenger): the press talks to GitHub (Ship it to GitHub, Ship
   *  ▾'s pull requests, Send the fixes to GitHub, Merge) — its refusal is
   *  read as GitHub's. Other presses read one as GitHub's only when the text
   *  names GitHub (`namesGitHub`). */
  github?: boolean;
  /** 1.171.0 B3 (DL-27): the card's repository on GitHub (`owner/name`)
   *  and its branch there — a protected branch, a rule or a branch that
   *  moved on then offers Open on GitHub (`githubRefusalPage`). */
  githubPage?: { repo: string | null | undefined; branch?: string | null };
  /** 1.171.0 B3 (Challenger 2): the press's name in titles, when it isn't
   *  `action` (`shipPressErrorName`). */
  name?: string;
  /** R8: the card has a Builder session to ask to fix what the project's
   *  hook refused. */
  fix?: boolean;
}

/** R8: the words for one of Plyloft's commits the project stopped — its
 *  hook refused it, or it ran past its bound — or null for anything else. */
export function commitStopError(
  action: string,
  cause: unknown,
  ways: CardActionErrorWays = {},
  again = ways.retry ? "try again" : `press ${action} again`,
): UxError | null {
  const stop = commitStop(rawError(cause));
  if (!stop) return null;
  if (stop.kind === "timeout") {
    return {
      title: `${action} stopped: committing took too long.`,
      happened: "A hook or a signing prompt in this project may be waiting, so Plyloft stopped the commit after 2 minutes.",
      untouched: "Nothing was committed. Your project folder is as it was.",
      todo: `Check this project's commit hooks and commit signing (a passphrase or a password manager's prompt), then ${again}.`,
      actions: ways.retry
        ? [
            { id: "retry", label: "Try again", primary: true },
            { id: "dismiss", label: "Dismiss" },
          ]
        : [{ id: "dismiss", label: "Dismiss" }],
      details: rawError(cause) || null,
    };
  }
  return {
    title: `${action} stopped: a hook in this project refused the commit.`,
    happened: `The hook said:\n${stop.said}`,
    untouched: "Nothing was committed. Your project folder is as it was, and the card's work is safe in its copy.",
    todo: ways.fix
      ? `Ask the Builder to fix what the hook reports, then press Finish and check, and ${again}.`
      : `Fix what the hook reports, then ${again}.`,
    actions: ways.fix
      ? [
          { id: "ask-hook", label: "Ask the Builder", primary: true },
          { id: "dismiss", label: "Dismiss" },
        ]
      : [{ id: "dismiss", label: "Dismiss" }],
    details: rawError(cause) || null,
  };
}

export { OPEN_PR_RETRY_LABEL, PR_OPEN_FAILED_WORDS, prOpenFailure };

/** U16: the start of `codex_sessions::NOT_FOUND`. */
const RESUME_NOTHING_TO_CONTINUE = "Couldn't find this card's Codex conversation, so Resume can't continue it.";

/** U16: Resume found no conversation of this card's. */
export function resumeFoundNothing(cause: unknown): boolean {
  return rawError(cause).startsWith(RESUME_NOTHING_TO_CONTINUE);
}

export function cardActionError(action: string, cause: unknown, ways: CardActionErrorWays = {}): UxError {
  // 1.171.0 B3 (Challenger 2): titles name the press as `ways.name` says
  // ("The pull request"); "press … again" keeps the label pressed.
  const name = ways.name ?? action;
  const didnt = name === PR_ERROR_NAME ? "The pull request didn't open." : `${name} didn't go through.`;
  // UX P-A Windows walk 1: the target checkout's uncommitted changes refused
  // the Ship before anything ran — said in words, never the typed payload.
  // QoL 1.168 (C4): with its ways out — the files in Code, and the card's
  // Builder asked to commit them (it does, in its session).
  const dirty = decodeTargetDirtyError(cause);
  if (dirty) {
    return {
      title: `${name} stopped: your project folder has changes that aren't in a commit.`,
      happened: targetDirtyMessage(dirty),
      untouched: "Nothing was merged. The card and the card's copy are as they were.",
      todo: ways.builder
        ? `Ask the Builder to commit them, or commit or undo them yourself, then press ${action} again.`
        : `Commit the changes in your project folder, or undo them, then press ${action} again.`,
      // Two ways out at most: with a Builder to ask, Show the files sits
      // under Details beside the list (the card page draws it there).
      actions: ways.builder
        ? [
            { id: "ask-commit", label: "Ask the Builder to commit them", primary: true },
            { id: "dismiss", label: "Dismiss" },
          ]
        : [
            { id: "show-files", label: "Show the files" },
            { id: "dismiss", label: "Dismiss" },
          ],
      details: dirty.paths.length ? dirty.paths.join("\n") : null,
    };
  }
  // R8: before the conflict words — a hook's own output may say anything.
  const stopped = commitStopError(action, cause, ways);
  if (stopped) return stopped;
  const conflict = mergeConflictPaths(rawError(cause));
  if (conflict) {
    // GH #306: name the cause in plain words; git's own text stays in Details.
    const files =
      conflict.length === 0
        ? "some files"
        : conflict.length === 1
          ? conflict[0]
          : `${conflict.length} files`;
    return {
      // 1.175.0 F8 (card-page.html §6): said in Now on one line.
      title: `${name} stopped: the card's changes conflict with ${targetHere(null)}.`,
      happened: `They conflict in ${files}.`,
      untouched: "Nothing was merged; the card and its copy are as they were.",
      todo: "Resolve the conflict in the card's copy, then ship again. Details lists what git reported.",
      actions: [{ id: "dismiss", label: "Dismiss" }],
      details: rawError(cause) || null,
    };
  }
  // UX P1 point 7 (P-E): Finish and check refused over a merge Plyloft
  // started, with conflict marks left — Rust's sentence names the files.
  const marks = /^(\d+ files? still ha(?:s|ve) conflict marks): (.+?)\. Ask the Builder/.exec(rawError(cause));
  if (marks) {
    // (Challenger) The Builder committed the merge itself, marks and all:
    // there is no merge left to undo, so Rust's sentence offers none.
    const undo = /undo the merge/.test(rawError(cause));
    return {
      title: `${name} stopped: ${marks[1]}.`,
      happened: `Still marked: ${marks[2]}.`,
      untouched: undo
        ? "Nothing was committed. The merge is still under way in the card's copy."
        : "Nothing new was saved. The Builder committed the merge with the marks in it.",
      todo: undo ? "Ask the Builder to finish them, or undo the merge." : "Ask the Builder to finish them.",
      actions: undo
        ? [
            // F8 round 2: it drops the merge in progress — never a filled press.
            { id: "undo-merge", label: "Undo the merge", danger: true },
            { id: "dismiss", label: "Dismiss" },
          ]
        : [{ id: "dismiss", label: "Dismiss" }],
      details: null,
    };
  }
  // H6b (Windows walk): said on the card, not in Details; the way on is the
  // local land (the Now primary turns to Ship it, `shipFailedPresentation`).
  const skillLocal = skillPrLocalRefusal(rawError(cause));
  if (skillLocal) {
    return {
      title: `${name} stopped: this skill card starts from your local ${skillLocal.branch}.`,
      happened: skillLocal.said,
      untouched: "Nothing was pushed. The card and the card's copy are as they were.",
      todo: `Press Ship it to land the card on your local ${skillLocal.branch}, where it starts. To ship it as a pull request instead, publish ${skillLocal.branch} to GitHub first, then ship again.`,
      actions: [{ id: "dismiss", label: "Dismiss" }],
      details: null,
    };
  }
  if (rawError(cause).includes(PUT_BACK_SESSION_WORDS)) {
    // N14 walk F18: a Resume refused on a card put back in To do says why,
    // and the way back — not "Try again".
    return {
      title: `${name} isn't offered on a card back at Ready to start.`,
      happened: PUT_BACK_SESSION_WORDS,
      untouched: "Nothing was started. The branch and the work on it are kept.",
      todo: "Press Start build.",
      actions: [{ id: "dismiss", label: "Dismiss" }],
      details: null,
    };
  }
  // 1.169.1 (R11): what GitHub refused a push or a pull request for, in
  // plain words (`plainCause`), with the way on — git's and gh's own text
  // stays under Details. A branch that moved on is never forced or rebased
  // from here, and pressing again won't get past a rule, a sign-in or a
  // large file: no Try again for those.
  // G1 (owner, 2026-10-26): a pull request with no GitHub CLI or no sign-in
  // stops before anything is pushed, with its way on — never a land in its
  // place. 1.171.0 A3: and no land on this computer as the other way on
  // either (it strands the change off GitHub, DL-10).
  const needs = shipNeedsGitHub(rawError(cause));
  // G1 Challenger (8): Ship it on a GitHub address that isn't a
  // repository's stops, with the land on this Mac as the way on.
  if (needs === "unreadable") {
    const raw = rawError(cause);
    return {
      title: `${name} stopped: this project's GitHub address isn't a repository.`,
      happened: raw.slice(0, raw.indexOf(SHIP_IT_UNREADABLE_TAIL)).trim() || raw,
      untouched: "Nothing was pushed. The card and the card's copy are as they were.",
      todo: `Correct the project's GitHub address so it names a repository, then press ${action} again. Or ship it ${onlyHereInline()}; GitHub won't have it.`,
      actions: [SHIP_HERE_ACTION, { id: "dismiss", label: "Dismiss" }],
      details: raw || null,
    };
  }
  if (needs) {
    const again = `press ${action} again`;
    return {
      title:
        needs === "gh-missing"
          ? `${name} stopped: the GitHub command isn't installed on this Mac.`
          : `${name} stopped: GitHub isn't signed in on this Mac.`,
      // 1.174.1 P5 (T5): "this Mac", drawn as this PC on Windows (`errorForMachine`).
      happened: needs === "gh-missing" ? SHIP_NEEDS_GH_SHOWN : SHIP_NEEDS_SIGN_IN_SHOWN,
      untouched: "The card and the card's copy are as they were.",
      todo:
        needs === "gh-missing"
          ? `Install the GitHub command, then ${again}.`
          : `Sign in to GitHub with the account this project uses, then ${again}.`,
      actions: [needs === "gh-missing" ? GH_INSTALL_ACTION : GITHUB_SIGN_IN_ACTION, { id: "dismiss", label: "Dismiss" }],
      details: rawError(cause) || null,
    };
  }
  // 1.175.0 (D1): a teammate's pull request (or branch) for the same card
  // stopped it before anything was sent — named, with its page; no retry.
  const teammate = teammateWork(rawError(cause));
  if (teammate) return teammateWorkError(didnt, teammate);
  const github = githubCause(cause, { github: ways.github });
  if (github) {
    const raw = rawError(cause);
    const page = ways.githubPage ? githubRefusalPage(github, ways.githubPage.repo, ways.githubPage.branch) : null;
    const again = `press ${action} again`;
    const asks = github === "sign-in" || github === "no-access";
    return {
      title: didnt,
      happened:
        github === "large-file" ? largeFileFact(raw) : github === "secret" ? SECRET_FACT : githubCauseWords(github, raw),
      untouched: "Nothing was forced. Nothing else on the card changed.",
      todo:
        github === "sign-in"
          ? `Sign in to GitHub with the account this project uses, then ${again}.`
          : github === "no-access"
            ? `Sign in to GitHub with an account that can, or ask who looks after the repository for access, then ${again}.`
            : github === "ssh-key"
              ? `Check that this Mac's SSH key is added to the GitHub account this project uses, then ${again}.`
              : github === "rate-limit"
                ? `Wait a few minutes, then ${again}.`
                : github === "moved"
                  ? `Look at the branch on GitHub; Plyloft never overwrites it. Then ${again}.`
                  : github === "protected" || github === "ruleset"
                    ? `Change the rules on GitHub, or ask who looks after the repository, then ${again}.`
                    : github === "secret"
                      ? secretWay({ action, builder: ways.builder })
                      : largeFileWay(raw, { action, builder: ways.builder }),
      actions: asks
        ? [GITHUB_SIGN_IN_ACTION, { id: "dismiss", label: "Dismiss" }]
        : page
          ? [{ ...OPEN_ON_GITHUB_ACTION, url: page }, { id: "dismiss", label: "Dismiss" }]
          : [{ id: "dismiss", label: "Dismiss" }],
      details: raw || null,
    };
  }
  // 1.171.0 B3 (PLAN §3, errors mid-flow): the push reached GitHub but the
  // pull request didn't open (the network dropped, gh timed out). Said so,
  // with the same ship again as the way on — it pushes the same commit
  // (nothing new) and opens the pull request (`card_ship`).
  const prOpen = prOpenFailure(rawError(cause));
  if (prOpen !== null) {
    return {
      title: `${name === PR_ERROR_NAME ? "Ship" : name} stopped before the pull request opened.`,
      happened: `The card's work reached GitHub, but its pull request didn't open. ${
        /did not finish within/i.test(prOpen)
          ? "It took too long and was stopped."
          : /error connecting to/i.test(prOpen)
            ? "The network didn't answer."
            : plainCause(prOpen)
      }`,
      untouched: "Nothing was merged, and the card isn't marked shipped.",
      todo: ways.retry
        ? `When GitHub answers again, press ${OPEN_PR_RETRY_LABEL}.`
        : `When GitHub answers again, press ${action} again; it opens the pull request.`,
      actions: ways.retry
        ? [
            { id: "retry", label: OPEN_PR_RETRY_LABEL, primary: true },
            { id: "dismiss", label: "Dismiss" },
          ]
        : [{ id: "dismiss", label: "Dismiss" }],
      details: rawError(cause) || null,
    };
  }
  // U16: Resume again would find nothing either; Start fresh is the way on.
  if (resumeFoundNothing(cause)) {
    return {
      title: didnt,
      happened: RESUME_NOTHING_TO_CONTINUE,
      untouched: "The card's copy is safe.",
      todo: "Press Start fresh: a new session in this card's folder, with the brief sent again. The work so far stays.",
      actions: [{ id: "dismiss", label: "Dismiss" }],
      details: null,
    };
  }
  // QoL 1.168 (C4): "Try again" is a button where the page can repeat the
  // press; elsewhere the words say which press to make.
  return {
    title: didnt,
    happened: `Plyloft couldn't finish “${action}”.`,
    untouched: "Nothing else on the card changed.",
    todo: ways.retry
      ? "Try again. If it keeps failing, Details says why."
      : `Press ${action} again. If it keeps failing, Details says why.`,
    actions: ways.retry
      ? [
          { id: "retry", label: "Try again", primary: true },
          { id: "dismiss", label: "Dismiss" },
        ]
      : [{ id: "dismiss", label: "Dismiss" }],
    details: rawError(cause) || null,
  };
}

/** CL-11 (Windows walk): a start refused because the repository isn't set
 *  up for builds, kept on the card with its way out — the toast alone could
 *  pass before anyone read it, and the press looked inert. */
export function startNeedsSetUpError(press: string, cause: unknown): UxError {
  return {
    title: `${press} didn't start: this repository isn't set up yet.`,
    happened: "Plyloft doesn't yet know which branch to build from or which checks to run here.",
    untouched: "Nothing was started or claimed.",
    todo: `Set up this repository, then press ${press}.`,
    actions: [
      { id: "set-up", label: "Set up", primary: true },
      { id: "dismiss", label: "Dismiss" },
    ],
    details: rawError(cause) || null,
  };
}

/** 1.174.4 (owner's words): a start that found its branch nowhere. It stays on
 *  the card: pressing again can't help, and a toast goes. `area`: the card's,
 *  null in a project with none, whose branch is set in Shipping. */
export function startBranchMissingError(press: string, branch: string, area: string | null, cause: unknown): UxError {
  return {
    title: `${press} didn't go through.`,
    happened: area
      ? `Area ${area} sends its cards to the branch ${branch}, which isn't on GitHub or on this computer.`
      : `Cards here go to the branch ${branch}, which isn't on GitHub or on this computer.`,
    untouched: "Nothing was started.",
    todo: `Create that branch, or choose another one in ${area ? "Settings › Project › Areas" : "Settings › Cards › Shipping"}.`,
    actions: [
      area
        ? { id: "open-areas", label: "Open Areas", primary: true }
        : { id: "open-shipping", label: "Open Shipping", primary: true },
      { id: "dismiss", label: "Dismiss" },
    ],
    details: rawError(cause) || null,
  };
}

/** The intake conversation stopped (UX-6.4, 6.8) on a card no longer
 *  planning. N14 walk F14: while the card still plans, the Now box says it
 *  stopped instead, with Plan again and Cancel intake — in these words
 *  (`lib/intakeStopped.ts`), as the Board and the Inbox do. */
export function intakeStoppedError(
  message: string,
  /** OB-14: who was planning. */
  planner: "claude" | "codex" = "claude",
): UxError {
  return {
    title: `${intakeStoppedLabel(planner)}.`,
    happened: intakeStoppedHappened(message, planner),
    untouched: "The card's brief and its plan are as they were.",
    todo: "Plan again when you're ready.",
    actions: [{ id: "dismiss", label: "Dismiss" }],
    details: message,
  };
}

/** The planning conversation's way out (the Now callout's secondary). The
 *  intake prompt names it through `FINISH_PLANNING_LABEL` in
 *  `src-tauri/src/intake.rs`, which must say the same words (1.168.1 B1). */
export const FINISH_PLANNING_LABEL = "Finish planning";
/** The failed Finish planning's way to ask again. */
export const FINISH_PLANNING_AGAIN_LABEL = `${FINISH_PLANNING_LABEL} again`;

/** Challenger P2 (N14 walk F14): Conclude didn't bring the plan back — it
 *  timed out, the plan couldn't be read, or the ask failed. The
 *  conversation is still there: not a stop. */
export function intakeConcludeError(
  message: string,
  planner: "claude" | "codex" = "claude",
): UxError {
  const who = vendorName(planner);
  return {
    title: "Finishing the planning didn't go through.",
    happened: /timed out/i.test(message)
      ? `${who} didn't write the plan in time.`
      : /parse/i.test(message)
        ? `${who}'s plan couldn't be read.`
        : `Plyloft couldn't ask ${who} for the plan.`,
    untouched: "The conversation is still open, and the card's brief is as it was.",
    todo: `${FINISH_PLANNING_AGAIN_LABEL}, or keep talking in the conversation.`,
    actions: [
      { id: "conclude", label: FINISH_PLANNING_AGAIN_LABEL, primary: true },
      { id: "dismiss", label: "Dismiss" },
    ],
    details: message,
  };
}

/** Planning could not start (the vendor's CLI, the workspace). */
export function intakeStartError(
  cause: unknown,
  /** OB-14: who was to plan the card. */
  planner: "claude" | "codex" = "claude",
): UxError {
  const who = vendorName(planner);
  return {
    title: `Planning with ${who} couldn't start.`,
    happened: `Plyloft couldn't open a ${who} conversation for this card.`,
    untouched: "The card is as it was.",
    todo:
      planner === "codex"
        ? "Check that Codex is installed and signed in, then try again."
        : "Check that Claude Code is installed and signed in, then try again.",
    actions: [{ id: "dismiss", label: "Dismiss" }],
    details: rawError(cause) || null,
  };
}

// ── UX-6.7: the Release flow's words ───────────────────────────────────

/** The release checks could not be read (`ship_audit` failed). */
export function releaseAuditError(cause: unknown): UxError {
  return {
    title: "Plyloft couldn't check this repository before releasing.",
    happened: "The look at the branch, the version and the running work didn't finish.",
    untouched: "Nothing was released and nothing changed.",
    todo: "Close this and open Release… again. If it keeps failing, Details says why.",
    actions: [],
    details: rawError(cause) || null,
  };
}

/** A release that stopped for a reason that is not one of the blocks the
 *  card's Shipping section draws (the fast-forward refusal, the unpublished
 *  release). */
/** R6 (`ship::ROLLED_BACK_WORDS`): a release that stopped after it began
 *  merging put the project folder back as the press found it. */
export const RELEASE_ROLLED_BACK_WORDS = "Nothing was released, and your project folder is as it was.";

/** R6: `ship::roll_back_release`'s conflict — the card's title and branch,
 *  the target and the files git named, and whether the card has a Builder
 *  (`ship::ASK_BUILDER_WORDS`) — or null for any other failure. */
export function releaseConflict(
  raw: string,
): { title: string; branch: string; target: string; files: string; builder: boolean } | null {
  const m = /^Plyloft couldn't merge “(.+?)” \((\S+)\) into (\S+): it conflicts with \3 in (.+?)\. Nothing was released, and your project folder is as it was\./s.exec(
    raw,
  );
  if (!m) return null;
  return { title: m[1], branch: m[2], target: m[3], files: m[4], builder: raw.includes(RELEASE_ASK_BUILDER_WORDS) };
}

/** R6: `ship::ASK_BUILDER_WORDS`. */
export const RELEASE_ASK_BUILDER_WORDS = "Open the card and press Fix with the Builder.";

/** R6 (Challenger M2, m2): what else a stopped release's rollback says — the
 *  changes kept in the stash list, the fast-forward kept — as sentences. */
export function releaseRollbackNotes(raw: string): string[] {
  const notes = [
    /Changes saved in the project folder while the release ran are kept in your stash list \("[^"]+"\)\./,
    /Your project folder was first brought up to date with the online \S+\./,
  ];
  return notes.map((re) => re.exec(raw)?.[0]).filter((n): n is string => Boolean(n));
}

/** R6: what the Release flow can do about a failed release — ask the card's
 *  Builder to commit the project folder's changes (`builderMayCommit`), and
 *  to resolve a conflict (a card with a Builder). */
export interface ReleaseFailedWays {
  builder?: boolean;
  resolve?: boolean;
  /** R8: the card's Builder may be asked to fix what a hook refused. */
  fix?: boolean;
}

export function releaseFailedError(cardTitle: string, cause: unknown, ways: ReleaseFailedWays = {}): UxError {
  // R6: a project folder with tracked changes is refused before anything is
  // merged — Land's words and ways out (`cardActionError`).
  if (decodeTargetDirtyError(cause)) return cardActionError("Release", cause, { builder: ways.builder });
  const raw = rawError(cause);
  // R8: the release commit refused by the project's hook, or stopped.
  const stopped = commitStopError("Release", cause, { fix: ways.fix }, "release again");
  if (stopped) {
    return {
      ...stopped,
      untouched: [RELEASE_ROLLED_BACK_WORDS, ...releaseRollbackNotes(raw), "The card's work is safe in its copy."].join(" "),
    };
  }
  // R6: a conflict, the folder put back and the conflict recorded on the
  // card, so its Builder can be asked to resolve it.
  const conflict = releaseConflict(raw);
  if (conflict) {
    return {
      title: `The release didn't go through: ${conflict.target} changed the same lines as this card.`,
      happened: `Git couldn't merge the card's changes: they conflict in ${conflict.files}.`,
      untouched: [RELEASE_ROLLED_BACK_WORDS, ...releaseRollbackNotes(raw), "The card's work is safe in its copy."].join(" "),
      todo: ways.resolve ? "Press Fix with the Builder, then release again." : NO_BUILDER_SENTENCE.replace("ship again", "release again"),
      actions: ways.resolve
        ? [
            { id: "ask-resolve", label: ASK_BUILDER_LABEL, primary: true },
            { id: "dismiss", label: "Dismiss" },
          ]
        : [{ id: "dismiss", label: "Dismiss" }],
      details: raw || null,
    };
  }
  // A repository that was never set up has one way out, and Ply can open it.
  if (needsSetUp(cause)) {
    return {
      title: "The release didn't go through.",
      happened: `Plyloft doesn't know how to release “${cardTitle}”: this repository isn't set up yet.`,
      untouched: "The card is not shipped; nothing was released.",
      todo: `${SET_UP_LABEL} opens Building and checking: press Re-detect there, then release again.`,
      actions: [{ id: SET_UP_ACTION, label: SET_UP_LABEL, primary: true }],
      details: rawError(cause) || null,
    };
  }
  // Shared settings this account can't write: no Re-detect here to offer.
  if (needsSetUpByWriter(cause)) {
    return {
      title: "The release didn't go through.",
      happened: `Plyloft doesn't know how to release “${cardTitle}”: this repository isn't set up yet.`,
      untouched: "The card is not shipped; nothing was released.",
      todo: "Its settings are shared and need write access: someone who has it presses Re-detect in Building and checking and publishes. Then release again.",
      actions: [],
      details: rawError(cause) || null,
    };
  }
  return {
    title: "The release didn't go through.",
    happened: `Plyloft couldn't finish releasing “${cardTitle}”.`,
    // R6: a release that stopped after it began says the folder is back.
    untouched: raw.includes(RELEASE_ROLLED_BACK_WORDS)
      ? ["The card is not shipped.", RELEASE_ROLLED_BACK_WORDS, ...releaseRollbackNotes(raw)].join(" ")
      : "The card is not shipped; what the release had done so far is in Details.",
    todo: "Fix what Details names, then release again.",
    actions: [],
    details: rawError(cause) || null,
  };
}

/** The id `releaseFailedError`'s `Set up` is pressed by. */
export const SET_UP_ACTION = "set-up";

/** The words a release's kind is chosen by (UX-6.7). */
export const RELEASE_KINDS = [
  {
    value: "local",
    label: RELEASE_KIND_LABEL.local,
    // QoL 1.168 S1-4: any project — the install step is the project's own.
    // 1.174.0 (DR6, P38): the Release sheet says the branch and the script
    // (`releaseSheet.kindHint`); this is the short form.
    hint: "Makes the new version on this Mac, from this Mac's copy of the branch. Nothing goes to GitHub.",
  },
  {
    value: "push_only",
    label: RELEASE_KIND_LABEL.push_only,
    hint: "Also pushes the release and its tag, for anything that deploys from a push.",
    // G8 (1.170.0): a repository on GitHub releases through a pull request.
    // 1.174.0 (DR6, P38, release.html table 12).
    prHint: "A release pull request on GitHub, merged when its checks pass, then tagged.",
  },
  {
    value: "github",
    label: RELEASE_KIND_LABEL.github,
    // 1.169.1 (R13): off GitHub it pushes what Tag and push does and never
    // makes the release page itself (ship.rs).
    hint: "Pushes the release and its tag; the release page on GitHub is created by your own workflow, if you have one.",
    // G8 (1.170.0): on GitHub, after the merge and the tag, Plyloft
    // publishes the release (`gh release create`) with the cards' notes.
    prHint: "The same, then a release page on GitHub with what's in it.",
  },
] as const;

/** G8 (1.170.0): the hint of a release kind for this repository — on GitHub,
 *  a kind that pushes goes through a pull request. */
export function releaseKindHint(kind: (typeof RELEASE_KINDS)[number], throughPr: boolean): string {
  return throughPr && "prHint" in kind ? kind.prHint : kind.hint;
}

/** Something the card reads to show you (the diff, a run's legs, a
 *  transcript) couldn't be read. Nothing was changed by trying. */
export function loadFailedError(what: string, cause: unknown): UxError {
  return {
    title: `${what} couldn't be loaded.`,
    happened: `Plyloft couldn't read ${what.toLowerCase()} for this card.`,
    untouched: "Nothing was changed.",
    todo: "Close this card and open it again. If it keeps failing, Details says why.",
    actions: [],
    details: rawError(cause) || null,
  };
}

/** The recorded release couldn't be dismissed (GH #222's Dismiss). */
export function dismissFailedError(cause: unknown): UxError {
  return {
    title: "The release record couldn't be dismissed.",
    happened: "Plyloft couldn't remove its record of the unpublished release.",
    untouched: "The release commit, its tag and the record are as they were.",
    todo: "Try Dismiss again. If it keeps failing, Details says why.",
    actions: [],
    details: rawError(cause) || null,
  };
}

/** R9: Undo the local release was refused or failed — the backend's words
 *  say why; nothing was changed when it refused. */
export function undoReleaseFailedError(cause: unknown): UxError {
  return {
    title: "The local release couldn't be undone.",
    happened: rawError(cause) || "Plyloft couldn't undo the release.",
    untouched: "The release commit, its tag and the record are as they were, unless Details says otherwise.",
    todo: "Read why under Details. Dismiss keeps the release on this Mac and lets you ship again.",
    actions: [],
    details: rawError(cause) || null,
  };
}

/** G8 (1.170.0): Update the release stopped (a conflict with GitHub's
 *  target, checks that failed, a push GitHub refused). */
export function updateReleaseFailedError(cause: unknown): UxError {
  return {
    title: "The release wasn't updated.",
    happened: rawError(cause) || "Plyloft couldn't update the release.",
    untouched: "The release pull request is as it was on GitHub.",
    todo: "Fix what it names, then press Update the release again, or Dismiss the release.",
    actions: [],
    details: rawError(cause) || null,
  };
}

/** C7: a dependency the backend refused (a cycle, a card that is gone). */
export function dependencyRefusedError(cause: unknown): UxError {
  return {
    title: "That dependency wasn't saved.",
    happened: "Plyloft refused it: the cards would wait for each other in a circle, or the card is gone.",
    untouched: "What this card waits for is as it was.",
    todo: "Choose another card. Details has Plyloft's reason.",
    actions: [{ id: "dismiss", label: "Dismiss" }],
    details: rawError(cause) || null,
  };
}

/** "Approved (1 small note)" inside a sentence: "approved (1 small note)". */
function lowerFirst(word: string): string {
  return word.charAt(0).toLowerCase() + word.slice(1);
}

/** v1.154.1 round 3 (RW-A): a skipped review that is the human overriding
 *  the Challenger's request for changes (`builder.rs::override_changes_requested`
 *  records who and why in `note`) — the Builder's pushback accepted. */
export function pushbackAccepted(review: { status: string; note?: string | null }): boolean {
  return review.status === "skipped" && Boolean(review.note && /overridden/.test(review.note));
}

export { shipEntryWords, shippedWords };

/** 1.172.0 D2 (CP-21): a shipped card has one receipt — The result (what
 *  shipped, its checks, the Challenger's word, its pull request, Ship
 *  history, Try it in the project). Its Shipping section is gone, so a
 *  press or a toast that asks for it opens The result. */
export function shippedReceipt(card: Pick<KanbanCard, "shipStatus" | "prReview">): boolean {
  return card.shipStatus === "shipped" && !card.prReview;
}

export function landedSection<T extends string>(
  section: T,
  card: Pick<KanbanCard, "shipStatus" | "prReview">,
): T | "outcome" {
  return section === "ship" && shippedReceipt(card) ? "outcome" : section;
}

/** 1.174.0 (C2, BCI-11): what the facts line's Change… opens, as its
 *  tooltip — the people (who builds and reviews it, how the Builder asks,
 *  their models), then its area and the cards it waits for, each only when
 *  it can be changed there. `null` when there is nothing to change. */
export function changeChoicesTitle(opts: { people: boolean; area: boolean; blockers: boolean }): string | null {
  const items: string[] = opts.people ? ["Who builds and reviews this card", "how the Builder asks you", "their models"] : [];
  if (opts.area) items.push(items.length ? "its area" : "This card's area");
  if (opts.blockers) items.push(items.length ? "the cards it waits for" : "The cards this card waits for");
  if (items.length === 0) return null;
  if (items.length === 1) return `${items[0]}.`;
  if (items.length === 2) return `${items[0]} and ${items[1]}.`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}.`;
}

/** 1.174.0 (C1, P8): once a card is built, its brief folds under the
 *  Activity: "What you asked", its first line, Show. */
export const BRIEF_FOLD_TITLE = "What you asked";
export const BRIEF_FOLD_SHOW = "Show";
export const BRIEF_FOLD_HIDE = "Hide";

/** The fold's first line is cut here, with "…". */
const BRIEF_LINE_MAX = 160;

/** The brief's first line as the fold says it: the first line with words —
 *  past a fenced code block, a rule and an HTML comment — without a heading's "#",
 *  a quote's ">", a list's "- " or "1.", a task's "[ ]"/"[x]" or the "**"
 *  around it; cut at 160 characters with "…". `null` for an empty brief. */
export function briefFirstLine(notes: string | null | undefined): string | null {
  let fence = false;
  for (const raw of (notes ?? "").split("\n")) {
    const t = raw.trim();
    if (/^(```|~~~)/.test(t)) {
      fence = !fence;
      continue;
    }
    if (fence || /^([-*_])(\s*\1){2,}$/.test(t) || t.startsWith("<!--")) continue;
    let line = t
      .replace(/^(?:>\s*)+/, "")
      .replace(/^#{1,6}(?:\s+|$)/, "")
      .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/^\[[ xX]\]\s*/, "")
      .trim();
    line = line.replace(/^\*\*(.+?)\*\*$/, "$1").trim();
    if (!line) continue;
    return line.length > BRIEF_LINE_MAX ? `${line.slice(0, BRIEF_LINE_MAX - 1).trimEnd()}…` : line;
  }
  return null;
}
