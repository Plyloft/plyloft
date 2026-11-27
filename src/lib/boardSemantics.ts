import type {
  CardPresentationState,
  KanbanCard,
  PlanExchangeStatus,
  ReviewTipFacts,
  SwarmStatus,
} from "../ipc.ts";
import { latestTaggedEntry, ownShipEntry, shipEntryWords, shippedWords } from "./shipVersion.ts";
import {
  EMPTY_CARD_STATE_CONTEXT,
  cardShippedOrPrOpen,
  cardLanded,
  challengerReviewing,
  closedBuilderAborted,
  deriveCardState,
  isCardSwarmQueued,
  mergedWithoutRelease,
  pullRequestNumber,
} from "./cardLifecycle.ts";
import { mergeReviewGap, reviewTruth } from "./challengerReview.ts";
import { openPrBoard, prOpen } from "./prStatus.ts";
import { unshippedBlockers } from "./cardDependencies.ts";
import { setupNowWords, type SetupHold } from "./worktreeSetup.ts";

export type BoardCardStateChip = {
  state: CardPresentationState;
  label: string;
  tone: "accent" | "quiet";
  /** C7 (UX-7.3): "Blocked by #12" when a blocker holds the card; the Board
   *  card's fact line and the List's Status say it instead of the state. */
  blocked: string | null;
  /** F3 (SL-4): the card's setup holds its Builder — the chip says so
   *  instead of "Ready to start". */
  setup?: SetupHold | null;
  /** N14 walk F14: its intake conversation ended while it still plans —
   *  "Planning with Claude stopped", not a live dot. */
  intakeStopped?: boolean;
  /** Plan with two AIs: the card's exchange runs, waits for the member or
   *  is paused — "Two AIs are planning", "Plan ready to review", "Plan
   *  paused" instead of "Ready to start" or "Draft". */
  plan?: PlanExchangeStatus;
};

/** SL-4: the card's own setup speaks for a card that is ready to start and
 *  nothing has started (a card built by both says where its builds are
 *  instead; a card back in draft reads as a draft, whatever old record it
 *  keeps). */
export function setupPresentation(
  card: Pick<KanbanCard, "worktreeSetup" | "buildBoth">,
  state: CardPresentationState,
): ReturnType<typeof setupNowWords> {
  if (card.buildBoth || state !== "ready") return null;
  return setupNowWords(card.worktreeSetup);
}

export type BoardCardProvenance = {
  kind: "github" | "local" | "branch";
  status: "default" | "pending" | "missing";
  label: string;
  title: string;
};

/**
 * The Board deliberately presents a coarser vocabulary, but it does not own
 * a second state machine. This exhaustive table collapses the canonical
 * eighteen-state authority (sixteen + the two v1.112.0 Builder states) into the
 * Board's bounded projection. GH #104 retired the three post-ship lesson states.
 */
export const BOARD_CARD_STATE_COLLAPSE = {
  archived: "archived",
  shipped: "shipped",
  shipping: "shipped",
  running: "running",
  "session-closed": "session-closed",
  paused: "paused",
  queued: "queued",
  // v1.112.0: a Challenger reading a snapshot is "checks" on the Board;
  // changes requested is its own chip — it is a needs-you signal.
  "challenger-reviewing": "checking",
  "changes-requested": "changes-requested",
  checking: "checking",
  "verify-failed": "verify-failed",
  failed: "failed",
  "review-stale": "result-ready",
  "no-changes": "result-ready",
  "ready-to-ship": "result-ready",
  "result-ready": "result-ready",
  "intake-live": "intake-live",
  closed: "closed",
  ready: "ready",
  draft: "draft",
} as const satisfies Record<CardPresentationState, CardPresentationState>;

/**
 * CL-10: a verified result ready to ship, whatever its column. A Builder
 * (PTY) card never leaves In progress, so the Ship batch's predicate — which
 * requires Complete and must keep requiring it (`ship.rs` relies on it) —
 * never matched an approved Builder card. Here: unshipped, not landed, no
 * open pull request, checks passed or skipped, a worktree, and either in
 * Complete or approved by the Challenger on its latest snapshot.
 */
export function readyToShipForStage(card: KanbanCard): boolean {
  if (card.archived) return false;
  // Challenger on a pull request: never shipped; fixes go to the pull request.
  if (card.prReview) return false;
  if ((card.shipStatus ?? "unshipped") !== "unshipped") return false;
  if (cardShippedOrPrOpen(card)) return false;
  if (prOpen(card)) return false;
  if (card.verifyStatus !== "passed" && card.verifyStatus !== "skipped") return false;
  const builder = card.builder;
  if (!builder) return card.columnId === "complete";
  if (!card.worktreePath) return false;
  if (card.columnId === "complete") return true;
  const review = builder.review;
  const latest = builder.snapshots[builder.snapshots.length - 1]?.n ?? 0;
  return review?.status === "done" && review.verdict === "approve" && review.snapshotN === latest;
}

/**
 * 1.170 walk fix (D1, Windows re-walk 2026-10-27): whether ⋯ › Release… is
 * offered. A card in Done not shipped, as before — or a card its page calls
 * ready to ship (`readyToShipForStage`). An approved Builder card stays in
 * In progress (CL-10), and since C5 nothing moves it to Done but a ship, so
 * Release… — G8's release through a pull request on GitHub — was never
 * offered for one: Ship it opens the card's own pull request, and Only on
 * this Mac ships the card here. The release takes the Builder card's
 * verified snapshot only (`ship.rs`, `require_at_last_snapshot`).
 */
export function releaseOffered(card: KanbanCard): boolean {
  if (card.archived || card.verifyStatus === "legacy") return false;
  if (card.shipStatus === "shipped") return false;
  return card.columnId === "complete" || readyToShipForStage(card);
}

/** 1.171.0 F3 (CP-15): ⋯ › Release… is in the menu only where it is
 *  offered (`releaseOffered`), with this hint saying what it is. */
export const RELEASE_ITEM_HINT = "Ships it as a new version of the project, with its own version number.";
/** 1.171.0 F3 (CP-15): why ⋯ › Archive is off on an archived card. */
export const ALREADY_ARCHIVED_HINT = "This card is already archived.";

/** v1.154.1 (F22): the state word of a card whose pull request was closed
 *  without merging (Board, Status and the Now callout). */
export const PR_CLOSED_LABEL = "Pull request closed";

/** P-A (UX P1 point 2): the Board chip is `presentCard`'s now —
 *  `cardPresentation.ts::deriveBoardCardState` and `boardChipOf`. */

// ── UX-5.4: the card's one fact line ──────────────────────────────────

/** The dot a card's state draws beside its word (`StateWord`). */
export type BoardRunState = "running" | "done" | "aborted" | "empty";

const CHIP_RUN_STATE: Record<CardPresentationState, BoardRunState> = {
  running: "running",
  checking: "running",
  "challenger-reviewing": "running",
  "intake-live": "running",
  shipping: "running",
  // GH #244: nobody runs it — not a live dot.
  "session-closed": "empty",
  failed: "aborted",
  "verify-failed": "aborted",
  "changes-requested": "aborted",
  "ready-to-ship": "done",
  "result-ready": "done",
  // GH #257: nothing Ply can land — it needs a look, it is not a result.
  "no-changes": "aborted",
  "review-stale": "empty",
  shipped: "done",
  // GH #243: finished without work on record — Done, but not a green result.
  closed: "empty",
  queued: "empty",
  paused: "empty",
  ready: "empty",
  draft: "empty",
  archived: "empty",
};

export function boardRunState(state: CardPresentationState): {
  state: BoardRunState;
  live: boolean;
} {
  const run = CHIP_RUN_STATE[state];
  return { state: run, live: run === "running" };
}

/** The chip's dot: a setup under way is live, one that holds the Builder
 *  back needs a look; otherwise the state's (`boardRunState`). */
export function boardChipRunState(chip: Pick<BoardCardStateChip, "state" | "setup" | "intakeStopped" | "plan">): {
  state: BoardRunState;
  live: boolean;
} {
  // Plan with two AIs: running is live; waiting or paused needs a look.
  if (chip.plan === "running") return { state: "running", live: true };
  if (chip.plan) return { state: "aborted", live: false };
  // N14 walk F14: nothing runs; it needs a look.
  if (chip.intakeStopped) return { state: "aborted", live: false };
  if (chip.setup === "running") return { state: "running", live: true };
  if (chip.setup) return { state: "aborted", live: false };
  return boardRunState(chip.state);
}

/** The card page's dot: as the Board's, except that its `result-ready` is
 *  "Preparing the result", a loading line — in flight, not done (GH #257).
 *  On the Board `result-ready` is the collapsed "Result ready", finished. */
export function cardRunState(state: CardPresentationState): {
  state: BoardRunState;
  live: boolean;
} {
  if (state === "result-ready") return { state: "running", live: true };
  return boardRunState(state);
}

/** "6m", "2h", "3d" — how long something has been going. */
export function shortDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * At most one fact beside the state word: how long a build has run, the
 * version a card shipped in, else its GitHub issue. Never a branch name or
 * a provenance line — those belong to the card's Details.
 */
export function boardCardFact(
  card: Pick<KanbanCard, "builder" | "shippedVersion" | "ghIssueNumber"> &
    Partial<Pick<KanbanCard, "reviewStatus" | "shipStatus" | "prUrl" | "shipHistory" | "commitSha" | "pr">>,
  state: CardPresentationState,
  now: number,
): string | null {
  if (state === "running" && card.builder?.startedAt) {
    return shortDuration(now - card.builder.startedAt);
  }
  // GH #299: "Merged · #29" — the pull request, not the issue.
  if (state === "shipped" && mergedWithoutRelease(card)) {
    const pr = pullRequestNumber(card.prUrl);
    // 1.174.0 (DR4, release.html state 8): a card shipped with Ship it and
    // carried by a release since says which — "#382 · In site-v3.0.2".
    const release = latestTaggedEntry(card);
    const inTag = release && release !== ownShipEntry(card) ? `In ${release.tag!.trim()}` : null;
    if (pr) return inTag ? `${pr} · ${inTag}` : pr;
    if (inTag) return inTag;
  }
  // Skills hub H3a (Mac walk 2): a Land with no version files records
  // "unknown" — the tile says "Shipped", never "Shipped · vunknown".
  // 1.173.0 (B4): the last release's own tag when it is this version's.
  const last = card.shipHistory?.[card.shipHistory.length - 1];
  const version =
    state !== "shipped"
      ? null
      : last?.tag && last.shippedVersion === card.shippedVersion
        ? shipEntryWords(last)
        : shippedWords(card.shippedVersion);
  if (version) return version;
  if (card.ghIssueNumber) return `#${card.ghIssueNumber}`;
  return null;
}

/** One thin provenance line; sync health changes tone/title, not slot count.
 *  UX-5.4: no longer on the Board card — kept for the card's Details (C6). */
export function deriveBoardCardProvenance(
  card: KanbanCard,
  githubBacked: boolean,
  issueMissing: boolean,
): BoardCardProvenance | null {
  if (card.ghIssueNumber) {
    return {
      kind: "github",
      status: card.syncPending || card.ghLabelsPending
        ? "pending"
        : issueMissing
          ? "missing"
          : "default",
      label: `#${card.ghIssueNumber}`,
      title: card.syncPending || card.ghLabelsPending
        ? "Local edit not yet mirrored to GitHub — retries on next Sync"
        : issueMissing
          ? "The backing GitHub issue no longer exists"
          : "Backed by a GitHub issue",
    };
  }

  if (githubBacked) {
    return {
      kind: "local",
      status: card.syncPending ? "pending" : "default",
      label: "Local only",
      title: card.syncPending
        ? "Local edit not yet mirrored to GitHub — retries on next Sync"
        : "Not yet pushed to GitHub",
    };
  }

  if (card.branchName) {
    return {
      kind: "branch",
      status: "default",
      label: card.branchName,
      title: `Card branch: ${card.branchName}`,
    };
  }

  return null;
}

/**
 * UX-5.2: the Board's columns are by attention — where the card needs the
 * person, not where its persisted `columnId` says it is. Derived on every
 * render from the card's lifecycle state; `columnId` is never migrated.
 */
export type AttentionColumn = "needs-you" | "not-started" | "working" | "waiting" | "done";

/**
 * QoL 1.168 block 8 (A3, owner D13): one vocabulary (docs/ux-language/
 * PATTERNS.md "The state words"). Needs you holds only what asks the person
 * to act; a card nobody has started (a draft, a brief ready to start) is Not
 * started; "Waiting" alone only ever means waiting for you, so the column
 * where nothing runs and nothing is asked is On hold — its id stays
 * `waiting` (anchors, drops and tests key on it), its words do not.
 */
export const ATTENTION_COLUMNS: ReadonlyArray<{
  id: AttentionColumn;
  label: string;
}> = [
  { id: "needs-you", label: "Needs you" },
  { id: "not-started", label: "Not started" },
  { id: "working", label: "Working" },
  { id: "waiting", label: "On hold" },
  { id: "done", label: "Done" },
];

/**
 * Every canonical state of `cardLifecycle.ts`, in its column. `null` is the
 * archive: it stays out of the columns, in its own row. A draft or ready card
 * held by a blocker that has not shipped is On hold (C7, `signals.blocked`).
 */
export const STATE_ATTENTION_COLUMN = {
  // Not started (D13): nobody has started it — the person starts it when
  // they choose, nothing is asked of them yet.
  draft: "not-started",
  ready: "not-started",
  // Needs you: the person decides or acts next.
  "changes-requested": "needs-you",
  "verify-failed": "needs-you",
  failed: "needs-you",
  "review-stale": "needs-you",
  "no-changes": "needs-you",
  "ready-to-ship": "needs-you",
  "result-ready": "needs-you",
  // GH #244: the session is closed; the person resumes it.
  "session-closed": "needs-you",
  // Working: something runs for the card now.
  "intake-live": "working",
  running: "working",
  "challenger-reviewing": "working",
  checking: "working",
  shipping: "working",
  // On hold (id `waiting`): nothing runs and nothing is asked of the person yet.
  queued: "waiting",
  paused: "waiting",
  // Done.
  shipped: "done",
  closed: "done",
  archived: null,
} as const satisfies Record<CardPresentationState, AttentionColumn | null>;

/**
 * What else a card says about itself beside its one state, for the
 * precedence: a reviewer's request for changes is a decision only the
 * person makes; a failed run or failed checks is Failed. Both can stand
 * while the state reads otherwise (a swarm running after a failed run).
 */
export type AttentionSignals = {
  changesRequested: boolean;
  failed: boolean;
  /** C7 (UX-7.2): a blocker has not shipped. Holds only a card that has not
   *  started (draft, ready): it waits, whatever else it would be. */
  blocked?: boolean;
  /** SL-1: the card's pull request is still open on GitHub — Needs you
   *  when it asks something (failed checks, changes requested, a conflict),
   *  Working while its checks run or it merges by itself (1.171.0 B1, owner
   *  D6), On hold otherwise. Not Done until it merges. */
  pullRequest?: "needs-you" | "working" | "waiting" | null;
  /** v1.154.1 (walk G1): its Builder is stopped at its CLI's folder-trust
   *  question — nothing happens until the person answers it. */
  askingTrust?: boolean;
  /** N14 (item 5): someone else holds its GitHub issue and this Mac has not
   *  run it (`cardClaim.claimedByOthersHere`). Holds only a card nobody has
   *  started (draft, ready): it waits on them, in On hold. */
  claimedByOthers?: boolean;
  /** N14 walk F14: its intake conversation ended while it still plans —
   *  the person plans again or cancels. */
  intakeStopped?: boolean;
  /** UX P1 point 4 (P-B): its Builder (or one of its two builds) waits on
   *  the person — a question, its turn over, or quiet — as the Inbox counts
   *  it (`needsYou.ts::waitingSessions`, held 3 s by `builderWaiting.ts`).
   *  A Working card goes to Needs you. */
  builderWaiting?: boolean;
  /** Challenger M1 (block 8): it sits in Complete (moved there by hand, its
   *  checks on record) — Rust's `review:<id>:manual` row asks the person to
   *  decide, so it is Needs you, never Not started, warm or cold. */
  inComplete?: boolean;
  /** 1.175.0 (D3): a part of its issue (title, brief) changed on GitHub
   *  while it was changed here — the card asks which version to keep. Needs
   *  you, whatever else it is doing; a card that is done asks nothing. */
  editConflict?: boolean;
};

export function cardAttentionSignals(
  card: Pick<KanbanCard, "reviewStatus" | "lastRunStatus" | "verifyStatus"> &
    Partial<
      Pick<
        KanbanCard,
        | "blockedBy"
        | "archived"
        | "columnId"
        | "pr"
        | "prUrl"
        | "builder"
        | "buildBoth"
        | "linkedRunId"
        | "linkedSwarmId"
        | "editConflicts"
      >
    >,
  cards: readonly KanbanCard[] = [],
): AttentionSignals {
  const run = card.lastRunStatus;
  const pullRequest = openPrBoard(card)?.attention;
  return {
    ...(pullRequest ? { pullRequest } : {}),
    blocked:
      !card.archived &&
      card.columnId === "todo" &&
      unshippedBlockers(card as KanbanCard, cards).length > 0,
    changesRequested: card.reviewStatus === "changes_requested",
    ...(card.columnId === "complete" && !card.archived ? { inComplete: true } : {}),
    ...(!card.archived && (card.editConflicts?.length ?? 0) > 0 ? { editConflict: true } : {}),
    // F11: a closed Builder session's aborted run is "Session closed", not a
    // failure (`closedBuilderAborted`).
    failed:
      run === "failed" ||
      (run === "aborted" && !closedBuilderAborted(card)) ||
      run === "rate_limited" ||
      card.verifyStatus === "failed",
  };
}

/**
 * The column for a state and its signals. Precedence when two apply:
 * Needs you > Failed > Working > On hold (id `waiting`) > Not started. The
 * Board has no Failed column, so Failed lands in Needs you — ahead of any
 * Working, On hold or Not started state. Shipped is Done whatever else is
 * recorded — except a pull request still open on GitHub (SL-1), which is
 * Needs you, Working (1.171.0 B1) or On hold; archived is in no column.
 */
export function attentionColumnFor(
  state: CardPresentationState,
  signals: AttentionSignals,
): AttentionColumn | null {
  const column = STATE_ATTENTION_COLUMN[state];
  // SL-1: its work is in a pull request that is still open on GitHub.
  if (state === "shipped" && signals.pullRequest) return signals.pullRequest;
  if (column === null || column === "done") return column;
  // 1.175.0 (D3): its issue asks which version to keep — the person's to answer.
  if (signals.editConflict) return "needs-you";
  // C7: held by a blocker, a card that has not started is On hold — and
  // when the last blocker ships it is back in Not started, started by no one.
  if (signals.blocked && (state === "draft" || state === "ready")) return "waiting";
  // N14 (item 5): a teammate holds it and nobody started it here — theirs
  // to build, not this person's to act on.
  if (signals.claimedByOthers && (state === "draft" || state === "ready")) return "waiting";
  // D13: not started stays Not started — unless a reviewer asked for
  // changes or a run failed on it, which ask the person.
  if (column === "not-started")
    return signals.changesRequested || signals.failed || signals.inComplete ? "needs-you" : "not-started";
  if (column === "needs-you" || signals.changesRequested) return "needs-you";
  if (signals.failed) return "needs-you";
  if (signals.askingTrust && column === "working") return "needs-you";
  if (signals.builderWaiting && column === "working") return "needs-you";
  if (signals.intakeStopped && state === "intake-live") return "needs-you";
  return column;
}

export function deriveAttentionColumn(
  card: KanbanCard,
  linkedSwarmStatus: SwarmStatus | null,
  /** The workspace's cards, for its blockers (C7). */
  cards: readonly KanbanCard[] = [],
  /** v1.154.1 (walk G1): its Builder waits on the folder-trust question. */
  askingTrust = false,
  /** N14 (item 5): someone else holds it and this Mac has not run it. */
  claimedByOthers = false,
  /** N14 walk F14: its intake conversation ended while it still plans. */
  intakeStopped = false,
): AttentionColumn | null {
  const state = deriveCardState(card, {
    ...EMPTY_CARD_STATE_CONTEXT,
    linkedSwarmStatus,
  });
  return attentionColumnFor(state, {
    ...cardAttentionSignals(card, cards),
    askingTrust,
    claimedByOthers,
    intakeStopped,
  });
}

export type AttentionGroups = Record<AttentionColumn, KanbanCard[]>;

/** Within a column: the person's order (`boardOrder`, UX-5.3), else the
 *  order the cards were made in — the same number space. */
export function boardSortKey(
  card: Pick<KanbanCard, "boardOrder" | "createdAt">,
): number {
  return card.boardOrder ?? card.createdAt;
}

/** When a card landed: its own latest ship (1.174.0, DR2 round 1: not a
 *  later release that carried it), else its last update. */
export function cardShippedAt(
  card: Pick<KanbanCard, "shipHistory" | "updatedAt"> & Partial<Pick<KanbanCard, "commitSha" | "pr" | "prUrl">>,
): number {
  const own = ownShipEntry(card);
  return own && own.shippedAt > 0 ? own.shippedAt : card.updatedAt;
}

/**
 * UX-5.2: every active card admitted once, into exactly one column. Needs
 * you, Not started, Working and On hold keep the person's order; Done is newest first.
 */
export function deriveAttentionGroups(
  cards: readonly KanbanCard[],
  swarmStatusOf: (card: KanbanCard) => SwarmStatus | null,
  /** Every card of the workspace — a filter may hide a blocker (C7). */
  allCards: readonly KanbanCard[] = cards,
  /** v1.154.1 (walk G1): cards whose Builder waits on the trust question. */
  askingTrust: (card: KanbanCard) => boolean = () => false,
  /** N14 (item 5): cards someone else holds that this Mac has not run. */
  claimedByOthers: (card: KanbanCard) => boolean = () => false,
  /** N14 walk F14: cards whose intake conversation ended while they plan. */
  intakeStopped: (card: KanbanCard) => boolean = () => false,
): AttentionGroups {
  const groups: AttentionGroups = {
    "needs-you": [],
    "not-started": [],
    working: [],
    waiting: [],
    done: [],
  };
  const seen = new Set<string>();
  for (const card of cards) {
    if (card.archived || seen.has(card.id)) continue;
    seen.add(card.id);
    const column = deriveAttentionColumn(
      card,
      swarmStatusOf(card),
      allCards,
      askingTrust(card),
      claimedByOthers(card),
      intakeStopped(card),
    );
    if (column) groups[column].push(card);
  }
  for (const id of ["needs-you", "not-started", "working", "waiting"] as const) {
    groups[id].sort((a, b) => boardSortKey(a) - boardSortKey(b));
  }
  groups.done.sort((a, b) => cardShippedAt(b) - cardShippedAt(a));
  return groups;
}

export function renderedBoardCardIds(groups: AttentionGroups): string[] {
  return ATTENTION_COLUMNS.flatMap(({ id }) => groups[id].map((c) => c.id));
}

// ── UX-5.3: what a drag may do ─────────────────────────────────────────

export const BOARD_ARCHIVE_BLOCKED_COPY =
  "Stop or finish this work before archiving the card.";
/** F6 (SL-4): the backend's `SETUP_BUSY_ARCHIVE`, said at once instead of
 *  after the Undo window. */
export const BOARD_ARCHIVE_SETUP_COPY =
  "The card's setup is running in this card's folder. Wait for it to finish, then archive the card.";
export const BOARD_COLUMN_FOLLOWS_STATE_COPY =
  "A card changes column as its work moves. Open it to start, stop or ship.";
/** QoL 1.168 S1-3: Done is where a card lands when it ships — a drop there
 *  never archives it (the Archived row does, on purpose). */
export const BOARD_DONE_FILLS_ON_SHIP_COPY = "Done fills when a card ships. Open it to ship it.";
/** …and for a card whose work isn't finished yet. */
export const BOARD_DONE_NOT_READY_COPY = "Done fills when a card ships. Finish it first, then ship it.";

/** U32: a card not started, moved to a column it could only reach by starting:
 *  worth asking whether its project's folder is there, the first thing Start
 *  build would say. */
export function moveAsksToStart(decision: BoardDropDecision, from: AttentionColumn | null): boolean {
  return decision.kind === "refused" && decision.message === BOARD_COLUMN_FOLLOWS_STATE_COPY && from === "not-started";
}

/** Where a card was released: a place in a column, or the archive. */
export type BoardDropTarget =
  | { kind: "column"; column: AttentionColumn; index: number }
  | { kind: "archive" };

/**
 * A drag reorders within a column and archives — nothing else. The closed
 * set of outcomes is the guarantee: no outcome starts, stops or ships work,
 * and none changes a lifecycle field or the persisted column.
 */
export type BoardDropDecision =
  | { kind: "noop" }
  | { kind: "reorder"; cardId: string; boardOrder: number }
  | { kind: "archive"; cardId: string }
  | {
      kind: "refused";
      message:
        | typeof BOARD_ARCHIVE_BLOCKED_COPY
        | typeof BOARD_ARCHIVE_SETUP_COPY
        | typeof BOARD_COLUMN_FOLLOWS_STATE_COPY
        | typeof BOARD_DONE_FILLS_ON_SHIP_COPY
        | typeof BOARD_DONE_NOT_READY_COPY;
    };

/** Room either side of the first or last card of a column. */
const ORDER_STEP = 1000;

/**
 * The sort key that puts `card` at `index` of `columnCards` (the column as
 * drawn, the card itself included or not). `null` when it is already there.
 */
export function reorderKey(
  card: Pick<KanbanCard, "id" | "boardOrder" | "createdAt">,
  columnCards: readonly Pick<KanbanCard, "id" | "boardOrder" | "createdAt">[],
  index: number,
): number | null {
  const from = columnCards.findIndex((c) => c.id === card.id);
  const others = columnCards.filter((c) => c.id !== card.id);
  // Released just after itself is where it already was.
  const at = Math.max(0, Math.min(from !== -1 && index > from ? index - 1 : index, others.length));
  if (from === at) return null;
  const before = others[at - 1];
  const after = others[at];
  if (before && after) return (boardSortKey(before) + boardSortKey(after)) / 2;
  if (before) return boardSortKey(before) + ORDER_STEP;
  if (after) return boardSortKey(after) - ORDER_STEP;
  return null;
}

/** Work that still owns the card's worktree: a run, a live or paused
 *  swarm, a queue slot, a Challenger reading it. Archive would prune it. */
export function boardWorkOwnsCard(
  card: KanbanCard,
  linkedSwarmStatus: SwarmStatus | null,
): boolean {
  return (
    card.lastRunStatus === "running" ||
    linkedSwarmStatus === "running" ||
    linkedSwarmStatus === "suspended" ||
    isCardSwarmQueued(card) ||
    challengerReviewing(card.builder)
  );
}

/** SL-4: a setup is running in one of the card's folders (its own, or the
 *  Codex build's), so nothing may archive or prune it yet. A `running`
 *  record a Plyloft that quit left behind is settled to failed on load. */
export function cardSetupRunning(card: Pick<KanbanCard, "worktreeSetup" | "buildBoth">): boolean {
  return (
    card.worktreeSetup?.state === "running" ||
    (card.buildBoth?.lanes ?? []).some((l) => l.worktreeSetup?.state === "running")
  );
}

/**
 * Pointer-drop affordance only: the backend stays the authority, and a run
 * that starts between dragstart and drop can still race this snapshot.
 */
export function deriveBoardDropDecision(
  card: KanbanCard | null,
  linkedSwarmStatus: SwarmStatus | null,
  target: BoardDropTarget | null,
  targetCards: readonly KanbanCard[],
  /** The workspace's cards, for its blockers (C7). */
  allCards: readonly KanbanCard[] = targetCards,
  /** P-A: the column the card is drawn in (`presentCard(...).column`). */
  drawnColumn?: AttentionColumn | null,
): BoardDropDecision {
  if (!card || !target || card.archived) return { kind: "noop" };
  const fromColumn =
    drawnColumn !== undefined ? drawnColumn : deriveAttentionColumn(card, linkedSwarmStatus, allCards);
  if (!fromColumn) return { kind: "noop" };
  // QoL 1.168 S1-3: a drop on Done from another column used to archive the
  // card — its copy went to the Trash, unshipped. Done fills when a card
  // ships; the Archived row is the one way to archive by dragging.
  if (target.kind === "column" && target.column === "done" && fromColumn !== "done") {
    return {
      kind: "refused",
      message: card.columnId === "complete" ? BOARD_DONE_FILLS_ON_SHIP_COPY : BOARD_DONE_NOT_READY_COPY,
    };
  }
  if (target.kind === "archive") {
    // Archive never pulls work out from under a run.
    if (fromColumn === "working" || boardWorkOwnsCard(card, linkedSwarmStatus)) {
      return { kind: "refused", message: BOARD_ARCHIVE_BLOCKED_COPY };
    }
    if (cardSetupRunning(card)) return { kind: "refused", message: BOARD_ARCHIVE_SETUP_COPY };
    return { kind: "archive", cardId: card.id };
  }
  if (target.kind !== "column") return { kind: "noop" };
  if (target.column !== fromColumn) {
    return { kind: "refused", message: BOARD_COLUMN_FOLLOWS_STATE_COPY };
  }
  // Done keeps its newest-first order.
  if (target.column === "done") return { kind: "noop" };
  const key = reorderKey(card, targetCards, target.index);
  return key === null
    ? { kind: "noop" }
    : { kind: "reorder", cardId: card.id, boardOrder: key };
}

/**
 * 1.173.0 (F1, BI-16): where a dragged card may land — the zones the drop
 * decision does not refuse (its own column, to reorder; the Archived row,
 * unless work owns the card). The Board lights only these while the card is
 * dragged; a drop anywhere else is still refused with its toast.
 */
export function legalDropZones(
  card: KanbanCard | null,
  linkedSwarmStatus: SwarmStatus | null,
  allCards: readonly KanbanCard[],
  drawnColumn?: AttentionColumn | null,
): { columns: AttentionColumn[]; archive: boolean } {
  const columns: AttentionColumn[] = [];
  for (const { id } of ATTENTION_COLUMNS) {
    const d = deriveBoardDropDecision(card, linkedSwarmStatus, { kind: "column", column: id, index: 0 }, [], allCards, drawnColumn);
    // A drop on the card's own column is legal even where it moves nothing
    // (Done keeps its order; the card is already first).
    if (d.kind !== "refused" && (d.kind !== "noop" || id === drawnColumn)) columns.push(id);
  }
  const archive = deriveBoardDropDecision(card, linkedSwarmStatus, { kind: "archive" }, [], allCards, drawnColumn).kind === "archive";
  return { columns, archive };
}

// ── UX-5.5: Ship N ─────────────────────────────────────────────────────

/** 1.171.0 F1: the words of `ship.rs::batch_builder_refusal` (the same
 *  strings), said beside a Builder card the batch leaves out. */
export const BATCH_SESSION_OPEN =
  "Its Builder session is still open. Close the session on its page, and the batch can take it.";
export const BATCH_NOT_SAVED = "The Builder's work isn't saved yet. Press Finish and check on its page first.";
export const BATCH_NOT_APPROVED = "The Reviewer hasn't approved its last round. Ship it from its own page.";
/** 1.171.0 F1 (Challenger 4): a card the Board would put in the batch that
 *  the backend's list leaves out — its git check found the copy changed
 *  after the saved work (`ship.rs::batch_ready_on_disk`). */
export const BATCH_COPY_CHANGED = "Its copy changed after its saved work. Press Finish and check on its page.";
/** `build_both::UNDECIDED_REFUSAL`. */
export const BATCH_BOTH_UNDECIDED =
  "Claude and Codex are both building this card. Pick one of the two builds first (or stop building with both).";

type BatchCard = Pick<
  KanbanCard,
  "columnId" | "shipStatus" | "verifyStatus" | "archived" | "reviewStatus" | "worktreePath" | "builder"
> &
  Partial<Pick<KanbanCard, "pr" | "prUrl" | "prReview" | "buildBoth">>;

/** 1.171.0 F1 (K1): why the batch leaves out a Builder card that isn't in
 *  Complete, or null when it may go in — `ship.rs::batch_builder_refusal`.
 *  An approved Builder card stays in In progress (CL-10), so the batch, which
 *  took Complete cards only, never took one. It takes it with Ship it's
 *  gates for merging by itself: one build picked, the session closed, the
 *  work saved, the last round reviewed as `mergeReviewGap` reads it
 *  (`builder.rs::ship_review_record`). Null for a card
 *  with no Builder. That the copy is exactly the saved work is git's (the
 *  backend's list). */
export function batchBuilderRefusal(card: Pick<KanbanCard, "builder"> & Partial<Pick<KanbanCard, "buildBoth">>): string | null {
  const b = card.builder;
  if (!b) return null;
  if (card.buildBoth && !card.buildBoth.outcome) return BATCH_BOTH_UNDECIDED;
  if (b.ptyId) return BATCH_SESSION_OPEN;
  const last = b.snapshots?.[b.snapshots.length - 1];
  if (!last) return BATCH_NOT_SAVED;
  // The one rule of what counts as reviewed (`mergeReviewGap`, the review
  // panel's and Ship's `merge_review_gap`): never a copy of it here.
  return mergeReviewGap(b) === null ? null : BATCH_NOT_APPROVED;
}

/** A card the Ship batch takes: verified (or checks skipped), not landed
 *  (shipped, or its pull request merged), and in Complete — or (1.171.0 F1)
 *  a Builder card in In progress the batch may take (`batchBuilderRefusal`).
 *  A Builder card whose worktree is gone is never taken (Ship refuses it).
 *  The one predicate the header's "Ship N" and the List's "Ship selected"
 *  share (both open the Release sheet, `ReleaseSheet`, 1.174.0); it mirrors `ship.rs::passes_pending_ship_metadata`,
 *  which the sidebar's count and `ship_batch` use (GH #242). */
export function isShipBatchEligible(card: BatchCard): boolean {
  if (card.archived) return false;
  // Challenger on a pull request: Ship never takes it (`ship.rs` refuses it).
  if (card.prReview) return false;
  if (card.columnId !== "complete" && !(card.builder && batchBuilderRefusal(card) === null)) return false;
  if ((card.shipStatus ?? "unshipped") !== "unshipped") return false;
  if (cardShippedOrPrOpen(card)) return false;
  // P-A (UX P1 point 2): its last ship stopped on a conflict — the Board
  // says so, and a batch would only retry it (`ship.rs` leaves it out too).
  if (card.reviewStatus === "conflict_blocked") return false;
  // v1.154.1 (F11): its pull request is open (`ship.rs` refuses it too).
  if (prOpen(card)) return false;
  if (card.verifyStatus !== "passed" && card.verifyStatus !== "skipped") return false;
  // No worktree: a Builder card cannot ship (its snapshot is gone).
  return Boolean(card.worktreePath) || !card.builder;
}

/** 1.171.0 F1: a card its own page calls ready to ship
 *  (`readyToShipForStage`) — or a Builder card past its checks whose review
 *  is the only thing left — that the batch leaves out, with why: said under
 *  the sheet's list, so a card missing from it is never a mystery. Null for
 *  a card the batch takes, and for one nowhere near shipping. */
export function shipBatchLeftOut(card: KanbanCard): string | null {
  if (!card.builder || card.columnId === "complete") return null;
  if (card.archived || card.prReview || !card.worktreePath) return null;
  if ((card.shipStatus ?? "unshipped") !== "unshipped" || cardShippedOrPrOpen(card) || prOpen(card)) return null;
  if (card.reviewStatus === "conflict_blocked") return null;
  if (card.verifyStatus !== "passed" && card.verifyStatus !== "skipped") return null;
  if ((card.builder.snapshots ?? []).length === 0) return null;
  return batchBuilderRefusal(card);
}

/** SP-D: what the Ship batch takes, in plain words — said where a batch
 *  surface has fewer cards than the Board's "Ready to ship" chips. */
export const SHIP_BATCH_RULE =
  "A release of several cards takes cards whose checks have passed and whose build has ended. A Builder card goes in once the Reviewer approved its last round and its session is closed.";

/** 1.171.0 E3 (owner D5, BI-1): the Board header's "Ship N" and the
 *  sidebar's "Ship N in a batch" show only when a batch has something a
 *  single Ship it doesn't — two or more cards it would take — on every
 *  plan. ⌘K's "Ship batch" stays the explicit way in. */
export function shipBatchShown(n: number): boolean {
  return n >= 2;
}

/** SP-D: the title of a control that opens the Ship batch with N cards.
 *  1.173.0 (F2): a batch is a release, so it says so. */
export function shipBatchTitle(n: number): string {
  return `Release ${n} card${n === 1 ? "" : "s"} together, as one version`;
}

/** 1.173.0 (F2): the title of a "Release N cards…" whose N spans more than one
 *  release — a project with areas on All areas (a release is of one area),
 *  or the sidebar's and ⌘K's count over every project. */
export const SHIP_BATCH_BY_AREA = "Release the cards that are ready, one area at a time";
export const SHIP_BATCH_BY_PROJECT = "Release the cards that are ready, one project at a time";

/** 1.173.0 (F2): the words of the Board's header button and the sidebar's
 *  row that open the release with N cards (it was "Ship N in a batch").
 *  1.174.0 (C13, BCI-14): "Release 3 cards…", never the version-like "Release 3…". */
export function shipBatchLabel(n: number): string {
  return `Release ${n} ${n === 1 ? "card" : "cards"}…`;
}

/** SP-7 round 4: every run the card records changed no file and no
 *  Builder snapshot exists — the one whole-card sign the Board has of
 *  nothing to ship. A single run's count is no such sign (a re-run that
 *  edited nothing records 0 over earlier work), and whether there is
 *  something to ship stays the backend's git check
 *  (`ship.rs::card_has_worktree_changes`); this only keeps the Board's chip
 *  from saying "Ready to ship". */
export function everyRunChangedNothing(card: Partial<Pick<KanbanCard, "runHistory" | "builder">>): boolean {
  const runs = card.runHistory ?? [];
  if (runs.length === 0) return false;
  if ((card.builder?.snapshots ?? []).length > 0) return false;
  return runs.every((r) => r.filesChangedCount === 0);
}

/** SP-D: the Board's "Ready to ship" — the card page's rule
 *  (`readyToShipForStage`), so an approved Builder card still in In progress
 *  reads the same on the Board as on its page. Not the Ship batch's rule
 *  (`isShipBatchEligible`, Complete only): the batch's surfaces speak of
 *  the batch, never of what is ready to ship. "Result ready" instead for:
 *  - a card whose runs all changed nothing (SP-7 round 4);
 *  - a card whose merge hit a git conflict (`conflict_blocked`);
 *  - a Builder card whose session is still open, unless its live branch
 *    tip (`reviewTip`, as the card page reads it through `useReviewTip`) is
 *    the reviewed one: it can still commit past the approved snapshot.
 *    While the tip loads or can't be read, "Result ready". With commits
 *    since the review the chip says so ("N commits since the last review"),
 *    as the page does. With no live session the snapshot is the tip.
 *  Not checked here: an independent review that went stale after a later
 *  commit — the card page reads that from the live tip. */
export function boardSaysReadyToShip(
  card: KanbanCard,
  reviewTip: ReviewTipFacts | null = null,
): boolean {
  if (everyRunChangedNothing(card)) return false;
  if (card.reviewStatus === "conflict_blocked") return false;
  if (card.builder?.ptyId) {
    if (reviewTip?.branchTip == null) return false;
    const truth = reviewTruth({
      builder: card.builder,
      branchTip: reviewTip.branchTip,
      commitsSinceReview: reviewTip.commitsSinceReview,
    });
    // Only commits past the review demote it; a review with failed passes
    // keeps the page's own behaviour (Ship stays, the chip says so).
    if (truth.kind === "not-reviewed" && truth.cause === "moved") return false;
  }
  return readyToShipForStage(card);
}

// ── UX-5.8: Done shows ten; the auto-archive ───────────────────────────

/** Done shows the latest this many; "Show all N" shows the rest. */
export const DONE_VISIBLE = 10;

/** Mirrors `kanban.rs::AUTO_ARCHIVE_AFTER_MS`. */
export const AUTO_ARCHIVE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The cards the auto-archive takes now: landed more than 14 days ago, never
 * archived (a card the person restored keeps `archivedAt`), no worktree left
 * to prune. None on a read-only Board. Mirrors
 * `kanban.rs::auto_archive_eligible`, which checks again before it writes.
 */
export function autoArchiveCandidates(
  cards: readonly KanbanCard[],
  now: number,
  opts: { readOnly: boolean },
): string[] {
  if (opts.readOnly) return [];
  return cards
    .filter(
      (card) =>
        !card.archived &&
        // 1.174.0 A2 round 1: landed — never while its pull request is open.
        cardLanded(card) &&
        card.archivedAt == null &&
        !card.worktreePath &&
        now - cardShippedAt(card) > AUTO_ARCHIVE_AFTER_MS,
    )
    .map((card) => card.id);
}

/** What the archive can give back (mirrors `kanban.rs::card_restorable`).
 *  QoL 1.168 S1-3: every archived card. */
export function cardRestorable(
  card: Pick<KanbanCard, "archived" | "autoArchived" | "shipStatus">,
): boolean {
  return Boolean(card.archived);
}

/** QoL 1.168 S1-3: the toast after Restore — what came back. `back` is the
 *  card as the backend returned it (its copy back from the Trash, or not). */
export function restoredWords(
  before: Pick<KanbanCard, "title" | "shipStatus" | "reviewStatus" | "branchCleanup"> &
    Partial<Pick<KanbanCard, "pr" | "prUrl">>,
  back: Pick<KanbanCard, "worktreePath">,
): { title: string; body: string } {
  const title = "Card restored";
  if (cardLanded(before)) {
    return { title, body: `${before.title} is back in Done.` };
  }
  if (back.worktreePath) {
    return {
      title,
      body: `${before.title} is back with its copy — changes not yet committed included.`,
    };
  }
  if (before.branchCleanup?.branch) {
    return {
      title,
      body: `${before.title} is back on the Board. Start build checks its branch out again.`,
    };
  }
  return { title, body: `${before.title} is back on the Board with its brief and plan.` };
}

/** QoL 1.168 S1-3: what Restore says it does, for the card it is on. */
export function restoreTitle(
  card: Pick<KanbanCard, "autoArchived" | "shipStatus" | "reviewStatus"> & Partial<Pick<KanbanCard, "pr" | "prUrl">>,
): string {
  if (card.autoArchived) return "Plyloft archived it 14 days after it shipped. Restore puts it back in Done.";
  if (cardLanded(card)) return "Put it back in Done";
  return "Put it back on the Board with its brief, plan and branch. Its copy comes back from the Trash while it is still there.";
}
