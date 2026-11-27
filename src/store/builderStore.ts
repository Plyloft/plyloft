import { create } from "zustand";
import {
  builderStart,
  builderResume,
  builderDone,
  projectConfigGet,
  builderAcceptPushback,
  builderReviewAgain,
  builderReviewRetry,
  type RetryChoice,
  type KanbanCard,
  builderClose,
  kanbanCardPutBack,
  builderLastOutputAt,
  builderSelfCheckMessage,
  builderSessionBlocks,
  ptyWrite,
  builderVerdictDelivered,
  cardPrFixMessage,
  cardPrBriefFixMessage,
  cardShipConflictStart,
  cardShipConflictUndo,
  cardReviewFollowupMessage,
  SELF_CHECK_TIMEOUT_SECS,
  type BuildDone,
  type SelfCheckRecord,
  type ReviewRejection,
} from "../ipc";
import {
  canDeliver,
  selfCheckLead,
  settleSelfCheck,
  startBuildDone,
  seesCompletion,
  selfCheckToken,
  tickSelfCheck,
  withoutMessage,
  type SelfCheckDeps,
  type SelfCheckRun,
} from "../lib/selfCheck";
import { FINISH_LABEL, noNewSnapshotToast } from "../lib/cardLifecycle";
import { codexComposerHoldsPaste, codexOverlayOpen, outputRestartsSilence } from "../lib/attention";
import {
  codexScreenHelp,
  isCodexOverlayError,
  isCursorReport,
  isTerminalReport,
  OVERLAY_TOOK_PASTE,
  PASTE_STILL_UNSENT,
  pasteBytes,
  SUBMIT_CONFIRM_MS,
  plainForKeys,
  submitsSeparately,
  typedEnter,
  writePasteThenSubmit,
} from "../lib/builderInject";
import { isWindows } from "../lib/platform";
import { targetName } from "../lib/worktreeBase";
import { stampsOnScreenChange } from "../lib/screenChange";
import { cardInWorkspace, startBuildWithClaim } from "../lib/cardClaim";
import { dismissStartRefusalToasts, noteStartRefusalToast } from "./startRefusalToasts";
import { showPlanRefusal } from "./planPrompts";
import { effectiveBuilderVendor, resumeFoundNothing } from "../lib/cardPage";
import { missingBranchOf } from "../lib/projectSetup";
import { resumedWithoutTurn } from "../lib/sessionActor";
import { boundedStartApplies } from "../lib/firstCardGuide";
import { effectiveBuilderPermissions, type BuilderPermissions } from "../lib/builderPermissions";
import { startRefusal, vendorReadiness, VENDOR_NAME } from "../lib/vendorReadiness";
import { useDoctor } from "./doctorStore";
import { cardWorkChanged } from "./errorBlockStore";
import { offerWorktreeEnvCopy } from "./worktreeSetupFlow";
import { autoSetUpForStart } from "../lib/autoSetUp";
import { verdictOwed, type HandedOverOwed, type VerdictOwed } from "../lib/challengerReview";
import {
  deliverVerdict,
  scheduleVerdictAck,
  acknowledgeVerdict,
  verdictSentByHand,
  type VerdictAckTimers,
  type VerdictDelivery,
  type VerdictDeliveryDeps,
  type VerdictSendOutcome,
} from "../lib/verdictDelivery";
import { clearedSkipReview, consumeSkipReview, skipReviewFor } from "../lib/skipReview";
import {
  deliverHandedOver,
  HeldMessageWaiters,
  SESSION_ENDED_ERROR,
  type HandedOverDelivery,
} from "../lib/handedOverDelivery";
import { useKanban } from "./kanbanStore";
import { useVerify } from "./verifyStore";
import { dismissToast, pushToast } from "./toastStore";
import { openCardStep, setUpAction, useUi } from "./uiStore";
import { BRIEF_FIX_WHAT, fixWithBuilder, prFixKey, type FixOutcome } from "../lib/prFix";
import { askBuilderToResolve, UNDO_MERGE_LABEL, type ResolveOutcome } from "../lib/shipConflict";
import {
  laterRequestsOf,
  latestSnapshotN,
  sendChangesToBuilder,
  type ChangesOutcome,
  type LaterRequestDraft,
} from "../lib/reviewChanges";
import { waitUntil } from "../lib/lineCommentSend";
import { anyLiveBuilder, sameTrustAsking, trustAskingFrom, type TrustAsking } from "../lib/trustQuestion";
import { sameSessionBlocks, sessionBlocksFrom, type SessionBlocks } from "../lib/sessionBlock";
import { builderSessionGone } from "../lib/needsYou";
import { cardIdOfSessionKey, noChecksSetUp } from "../lib/buildBoth";
import { builderSessionScreens, type BuilderSessionScreen } from "../lib/builderScreensIpc";
import { workSavedToastWords } from "../lib/finishAndCheck";
import type { ShipMode } from "../lib/shipVia";
import {
  draftPullRequest,
  PR_DRAFT_TOAST,
  type PrDraftOutcome,
  questionLeftByDraft,
} from "../lib/prDraft";

/** SL-2: `deliverWhenIdle`'s key — one pull-request fix per card at a time. */
const PR_FIX_KEY = "pr-fix";
/** P-E: the ship conflict's message, held for the prompt like a fix. */
const SHIP_CONFLICT_KEY = "ship-conflict";
/** G4: one set of requested changes at a time per card. */
const REVIEW_CHANGES_KEY = "review-changes";
/** SL-2: how long Fix with the Builder waits for a resumed session's terminal. */
const FIX_SESSION_WAIT_MS = 20_000;
import { useSettings } from "./settingsStore";
import { fixRoundCheckOn } from "../lib/fixRoundCheck";
import { cardPrDraftForget, cardPrDraftPrepare, cardPrDraftRead } from "../lib/prDraftIpc";
import { ensureCardArea } from "./cardAreaStore";
import { openRepair } from "../lib/openRepair";
import { pushErrorToast } from "../lib/errorToast";

/**
 * v1.106.0 (Builder/Challenger): in-memory runtime of each card's live
 * Builder session. Nothing here is persisted — the card carries the
 * durable half (`KanbanCard.builder`); this store carries what only the
 * attached xterm knows: last output, whether the vendor's prompt box is
 * idle, and messages waiting for that idle moment (the injection
 * contract in docs/builder-challenger/DESIGN.md).
 */
export interface BuilderRuntime {
  workspaceId: string;
  ptyId: string;
  vendor: "claude" | "codex";
  startedAt: number;
  lastOutputAt?: number;
  promptBoxIdle?: boolean;
  /** GH #111: the last scan found the turn over — the idle prompt, with no
   *  running turn and no question in view. What the self-check waits for. */
  turnIdle?: boolean;
  /** CL-7: when the last scan that found the turn over began reading so —
   *  set as `turnIdle` turns true. A submit after it is a new turn. */
  turnIdleAt?: number;
  /** CL-11: the last scan found the CLI asking for a decision (an approval):
   *  asking you at once (`deriveTileAttention`). */
  questionInView?: boolean;
  /** U25: the question on screen when Ship stopped waiting for the draft, for
   *  as long as it stays there and no fix is sent. In memory. */
  draftQuestion?: boolean;
  /** 1.172.0 E3: the last scan found Codex's transcript search open over its
   *  composer (`codexOverlayOpen`) — Now says to press Esc there. */
  codexOverlayOpen?: boolean;
  /** SP-4 round 2-3: when the last SETTLED prompt-box scan ran — one taken
   *  after the output had been quiet for the settle (not a max-wait scan in
   *  the middle of a stream). Cleared by the next output (`markOutput`,
   *  before its coalescing). While it stands, a scan that found the turn
   *  over says "waiting for you" at once (`typingAtPrompt`). */
  lastSettledScanAt?: number;
  /** SP-1 walk (Challenger): a SETTLED scan found the turn over, and no
   *  scan since found it running and nothing was submitted since. Output
   *  does not clear it (Claude's prompt suggestion is output); a max-wait
   *  scan mid-stream never sets it. What `typingAtPrompt` trusts for
   *  Claude. */
  turnIdleSettled?: boolean;
  /** 1.174.3: when the Resume that started this session was pressed
   *  (`sessionActor.ts::resumedWithoutTurn`). In memory, like the rest. */
  resumedAt?: number;
  /** 1.174.3: since Resume nothing was submitted, and the turn on screen was
   *  cut off (`turnInterruptedMatcherFor`). In memory, like the rest. */
  turnInterrupted?: boolean;
  /** 1.175.0 F5: the last scan saw the turn on screen cut off, whatever came
   *  before it (`turnInterruptedMatcherFor`): a fix round then waits. */
  turnCutOff?: boolean;
  /** 2026-10-15: the last scan found the member's draft starting with `!`
   *  (bash mode) or `/` (`attention::composerEscapedMatcherFor`). Plyloft's
   *  messages wait — the held-message valve included — until it is gone. */
  composerEscaped?: boolean;
  /** 1.174.5 (walk 2026-11-05): the last scan found text the person typed in
   *  the input row. A paste of Plyloft's would go out joined to it, so
   *  Plyloft's messages wait until it is sent or cleared. Not `promptBoxIdle`:
   *  the turn is over all the same, and Now still says so. */
  composerDraft?: boolean;
  /** Messages held until the session is at its prompt. */
  pending: string[];
}

/** 2026-10-15: what the Builder's terminal shows while a message of
 *  Plyloft's waits on the member's `!` or `/` draft; null otherwise. */
export function draftHoldNotice(
  rt: Pick<BuilderRuntime, "composerEscaped" | "composerDraft" | "pending" | "questionInView"> | undefined,
  /** 1.174.5: a message waits that isn't among the held ones (the self-check, a verdict). */
  alsoWaiting = false,
): string | null {
  if (rt?.composerEscaped && rt.pending.length > 0) {
    return "A Plyloft message is waiting: clear the ! (or /) in the Builder's prompt.";
  }
  if (rt?.composerDraft && !rt.questionInView && (rt.pending.length > 0 || alsoWaiting)) {
    return "A Plyloft message is waiting: send or clear what you typed in the Builder's prompt.";
  }
  return null;
}

interface BuilderStore {
  byCard: Record<string, BuilderRuntime>;
  /** C6 (UX-6.8): the last Builder press on a card that failed — what the
   *  card page draws as an ErrorBlock until dismissed. Session-only. */
  errorByCard: Record<string, { action: string; cause: string; setUp?: true; missingBranch?: string } | undefined>;
  clearError: (cardId: string) => void;
  /** CL-11 (Windows walk): a start refused because the repository isn't set
   *  up stays on the card — "Set up this repository, then press Start
   *  build" with Set up — not only in a toast that can pass unseen. */
  noteSetUpNeeded: (cardId: string, press: string, cause: string) => void;
  /** 1.174.4: a start refused because its branch is nowhere stays on the card. */
  noteStartBranchMissing: (cardId: string, press: string, cause: string) => void;
  /** Per-card "Build without asking" preference (D14), session-only. */
  bypassPref: Record<string, boolean>;
  /** v1.107.0 (D2): this session's vendor pick per card — the optimistic
   *  value while `setVendorPref` saves it with the card. The saved choice is
   *  `card.builderVendorPref`; read both through `effectiveBuilderVendor`
   *  (absent both = the Settings default). */
  vendorPref: Record<string, "claude" | "codex">;
  /** v1.108.0 (D7): per-card "Skip review" for the next Build done. GH
   *  #135: one press — the Build done that uses it, and start/resume of a
   *  session, clear it (`lib/skipReview.ts`). */
  skipReviewPref: Record<string, boolean>;
  /** ADR 0006 (third card): the self-check Build done is waiting on, per
   *  card. In memory only: a restart ends the session anyway. */
  selfCheck: Record<string, SelfCheckRun>;
  /** GH #111 F6: Build done's own work (snapshot, Verify handoff) running
   *  per card — its button stays disabled and a second press does nothing. */
  doneBusy: Record<string, true>;
  /** 1.171.0 C3 walk fix: the cards whose running Finish and check is
   *  "Check without the Reviewer" — Now's sentence says the
   *  Challenger doesn't review it. In memory, cleared with `doneBusy`. */
  doneWithoutReview: Record<string, true>;
  /** GH #129: the last `Back to the Builder` of each card's handed-over
   *  request — queued, sent (it reached the PTY) or failed. In memory. */
  handedOverDelivery: Record<string, HandedOverDelivery>;
  /** GH #135: the last delivery of each card's settled verdict — the PTY
   *  write and whether the card was told, per verdict (`at`) and session
   *  (`ptyId`), so one verdict is written once and never twice. In
   *  memory: a new session has not had it. */
  verdictDelivery: Record<string, VerdictDelivery>;

  setBypassPref: (cardId: string, bypass: boolean) => void;
  /** D1: drop a kept posture once a start has used it. */
  clearBypassPref: (cardId: string) => void;
  /** Choose the card's Builder vendor: shown at once, saved with the card
   *  (`kanban_card_set_builder_vendor_pref`). A refused save is undone and
   *  said in a toast. */
  setVendorPref: (
    workspaceId: string,
    cardId: string,
    vendor: "claude" | "codex",
    /** 1.171.0 (K7): the person chose it — a new card starts with it too
     *  (`behavior.lastBuilderVendor`). */
    remember?: boolean,
  ) => Promise<void>;
  setSkipReviewPref: (cardId: string, skip: boolean) => void;
  attach: (
    cardId: string,
    workspaceId: string,
    ptyId: string,
    vendor: "claude" | "codex",
  ) => void;
  detach: (cardId: string, ptyId: string) => void;
  markOutput: (cardId: string) => void;
  /** The card's terminal was just resized: the redraw that follows does not
   *  restart its silence clock (`outputRestartsSilence`). */
  noteResize: (cardId: string) => void;
  markPromptBox: (
    cardId: string,
    idle: boolean,
    turnIdle?: boolean,
    questionInView?: boolean,
    /** SP-4 round 3: the scan ran after the output's settle, not mid-stream. */
    settled?: boolean,
    /** The member's draft starts with `!` or `/` (`composerEscaped`); null
     *  when no composer was in view — the last verdict stands. */
    escaped?: boolean | null,
    /** 1.172.0 E3: Codex's transcript search is open over the composer. */
    overlayOpen?: boolean,
    /** 1.174.3: the screen shows a turn running (`turnRunningMatcherFor`). */
    turnRunning?: boolean,
    /** 1.174.3: the turn on screen was cut off (`turnInterruptedMatcherFor`). */
    interrupted?: boolean,
    /** 1.174.5: the input row holds text; null when the screen can't say. */
    draft?: boolean | null,
  ) => void;
  /** Deliver now if the session is at its prompt, else hold it. */
  inject: (cardId: string, text: string) => void;
  /** SL-5: write `text` into the card's session now if it is at its
   *  prompt, else hold it until it is (`onQueued` is told). Resolves once
   *  it is written; rejects when the write fails or the session ends
   *  first. Null when no session is attached. With a `key`, a second
   *  message of that key for the card, while the first is still held or
   *  being written, is refused (`ALREADY_DELIVERING_ERROR`), never queued.
   *  G7 fixes (M2): `noHold` never holds it — not at its prompt now, or
   *  something of Plyloft's or the member's already waiting there, and it
   *  is refused (`NOT_AT_PROMPT_ERROR`) with nothing written or held, and
   *  no valve: Fix failing checks by itself. */
  deliverWhenIdle: (
    cardId: string,
    text: string,
    onQueued?: () => void,
    key?: string,
    opts?: { noHold?: boolean },
  ) => Promise<void> | null;
  /** SL-5: where each card's Send to Builder stands — sending (resuming,
   *  writing) or queued (held for the prompt). Absent = none under way.
   *  Store state, not the panel's, so a remount of the card keeps it. */
  lineCommentSend: Record<string, "sending" | "queued" | undefined>;
  /** v1.154.1 (walk G1): the sessions stopped at their CLI's folder-trust
   *  question, by session key — the backend's reading of each capture
   *  (`pollTrustQuestions`), card open or not. In memory. */
  trustAsking: TrustAsking;
  setTrustAsking: (next: TrustAsking) => void;
  /** UX P-F (UX P1 point 8): the sessions stopped at Claude's Bypass
   *  Permissions warning or its usage limit, by session key — the same
   *  poll's other kinds (`pollSessionBlocks`). In memory. */
  sessionBlocks: SessionBlocks;
  setSessionBlocks: (next: SessionBlocks) => void;
  /** v1.154.1 (J5): when work last went into each card's session — a Fix
   *  paste, line comments, a hand-over, the person typing — so a session
   *  whose build is done reads "Build done" only while nothing was sent
   *  since the latest snapshot (`liveBuilderSessionState`). Plyloft's own
   *  notices (Build done's, checks, verdicts) ask for no new work and are
   *  not counted. In memory. */
  sentAt: Record<string, number>;
  noteSent: (cardId: string) => void;
  /** CL-7: when a message was last submitted into each session — an Enter
   *  the person typed, or a paste of Plyloft's — not every keystroke, so
   *  the "building · 4m" clock starts with the turn. In memory. */
  submittedAt: Record<string, number>;
  noteSubmitted: (cardId: string) => void;
  /** v1.154.1 (J5): when each card's last Build done went through — an
   *  unchanged tree records no new snapshot, and this build is still done.
   *  In memory. */
  doneAt: Record<string, number>;
  /** SL-5: take the card's Send to Builder slot; false when one is already
   *  under way (a second press, or a remounted card, sends nothing). */
  claimLineCommentSend: (cardId: string) => boolean;
  markLineCommentSendQueued: (cardId: string) => void;
  releaseLineCommentSend: (cardId: string) => void;
  /** GH #129: `Back to the Builder` on a card that owes the Builder a
   *  request for changes a hand-over left unsent. Records and toasts how
   *  the delivery went: queued, sent once written into the PTY, or failed
   *  (a failed write, or the session ended first) — then it can be sent
   *  again. Resolves null when no session is open to receive it. */
  sendHandedOver: (cardId: string, owed: HandedOverOwed) => Promise<"queued" | "sent" | "failed" | null>;
  /** GH #135: send the settled verdict the Builder has not received.
   *  `auto` is Ply, once the card is open with a session at its prompt;
   *  `press` is the human, who is answered either way. Once per session
   *  per verdict: a second call while the first is in flight, or after the
   *  write landed, writes nothing. The card stops owing it as soon as it
   *  is written. */
  sendVerdict: (
    workspaceId: string,
    cardId: string,
    owed: VerdictOwed,
    reason: "auto" | "press",
  ) => Promise<VerdictSendOutcome>;
  /** GH #135: tell the card about a verdict the Builder has but the board
   *  could not be told about — the write is never repeated. */
  ackVerdict: (workspaceId: string, cardId: string, owed: VerdictOwed) => Promise<boolean>;

  /** `retry` (1.169.0 A3): "Retry on…" — this start's model and effort,
   *  this once; only this press carries it. */
  start: (workspaceId: string, cardId: string, retry?: RetryChoice) => Promise<void>;
  resume: (workspaceId: string, cardId: string) => Promise<void>;
  /** Build done. With the repository's self-check on and a live session,
   *  it first sends the Builder the self-check and resolves with null; the
   *  snapshot, Verify and the Challenger follow by themselves once the
   *  Builder is back at its prompt (or on Skip, or after the timeout).
   *  Otherwise resolves with the backend result. */
  done: (workspaceId: string, cardId: string) => Promise<BuildDone | null>;
  /** ADR 0006 (third card): Skip on a running self-check — straight on to
   *  the snapshot and Verify. */
  skipSelfCheck: (cardId: string) => Promise<void>;
  /** Accept the Builder's pushback on the current snapshot's
   *  changes-requested verdict. */
  acceptPushback: (workspaceId: string, cardId: string) => Promise<void>;
  /** GH #58: re-run an incomplete or failed Challenger review in passes. */
  reviewAgain: (workspaceId: string, cardId: string) => Promise<void>;
  /** 1.169.0 (A3): "Retry on…" the Challenger's settled review, this once. */
  reviewRetry: (workspaceId: string, cardId: string, vendor: "claude" | "codex", retry: RetryChoice) => Promise<void>;
  /** SL-2: Fix with the Builder — what the card's open pull request needs
   *  (failed logs, the review, the conflict), pasted into its Builder
   *  session, resumed first when it is closed. Never automatic. */
  /** 1.174.0 A2 (P7): `brief` — ⋯ › Fix with the Builder sends the card's
   *  brief as it reads now (nothing on GitHub to fix), the same way on. */
  fixFromGitHub: (workspaceId: string, cardId: string, options?: { brief?: boolean }) => Promise<FixOutcome>;
  /** UX P1 point 7 (P-E): "Ask the Builder to resolve it" on a card whose
   *  ship stopped on a conflict — the session first (resumed when closed),
   *  then Plyloft starts the merge in the card's copy, then the message.
   *  Its busy state is `fixBusy`'s (a card is never in both). */
  resolveShipConflict: (workspaceId: string, cardId: string) => Promise<ResolveOutcome>;
  /** UX P1 point 7 (P-E): Undo the merge Plyloft started. */
  undoShipConflictMerge: (workspaceId: string, cardId: string) => Promise<void>;
  /** G4: cards whose Builder is writing their pull request's title and
   *  description before Ship opens it (`lib/prDraft.ts`). In memory. */
  prDraftWriting: Record<string, true | undefined>;
  /** SL-2: cards whose Fix with the Builder is running. */
  fixBusy: Record<string, "gathering" | "queued" | undefined>;
  /** v1.154.1 (walk I4): per card, the `prFixKey` of the pull request a
   *  fix was last delivered for. While GitHub still says the same (no new
   *  head, no new failure), Fix is not offered again — the card shows the
   *  fix round. In memory: after a relaunch Fix is offered once more. */
  fixSent: Record<string, string | undefined>;
  /** G4 (launch D8), as walk I4's `fixSent`: per card, the snapshot number
   *  the latest "Not right" / "Request changes" went to the Builder at.
   *  While no newer snapshot exists the card holds Ship and Not right
   *  (`reviewChanges.ts::changesSentStands`); Build done clears it. In
   *  memory, like `fixSent`. */
  changesSent: Record<string, number | undefined>;
  /** 1.175.0 F5: per card, the last fix round Plyloft sent the Builder — the
   *  Reviewer's findings, this computer's failed checks, a pull request's
   *  fix — with the session it went into and when (`fixRoundStore.ts`).
   *  The person's own changes clear it. In memory. */
  fixRoundSent: Record<string, { kind: "findings" | "checks" | "pr"; ptyId: string; at: number; key?: string } | undefined>;
  /** 1.175.0 F5: Stop on a check Plyloft started by itself — the self-check
   *  ends with nothing saved (its message taken back when undelivered).
   *  False when no self-check runs. */
  cancelSelfCheck: (cardId: string) => boolean;
  /** v1.154.1 (F16): cards whose Start build is on its way (the worktree,
   *  its setup, the session) — the Now callout says so at once. */
  startBusy: Record<string, boolean | undefined>;
  /** True when the session closed (a failure is reported, and false). */
  close: (workspaceId: string, cardId: string) => Promise<boolean>;
  /** N14 F8: the card ⋯'s Put back in To do — the backend stops its
   *  sessions and moves it, keeping its branch and worktree. Throws the
   *  backend's words when refused; the caller says them. */
  putBack: (workspaceId: string, cardId: string) => Promise<void>;
  /** G4 (launch D8): the changes a person asked for on the result ("Not
   *  right", rejected hunks) go into the card's Builder session — resumed
   *  first when closed — instead of a new swarm. */
  sendChanges: (
    workspaceId: string,
    cardId: string,
    rejections: ReviewRejection[],
    onQueued?: () => void,
  ) => Promise<ChangesOutcome>;
  /** QoL 1.168 (C2, C4): a message Plyloft wrote (the failing checks'
   *  output; the project folder's changes to commit) into the card's Builder
   *  session, as `sendChanges` delivers — resumed first when closed, held
   *  until its prompt. `markSent`: Now then says the Builder has it and Ship
   *  waits for the next Finish and check, as after Not right. */
  askBuilder: (
    workspaceId: string,
    cardId: string,
    text: string,
    options: {
      next?: string;
      sentBody: string;
      markSent: boolean;
      key: string;
      /** 1.172.0 (A1): the person's own words, kept on the card once sent
       *  (`laterRequests`), so the Challenger reviews against them too. */
      laterRequest?: { text: string; source: "notRight" | "changes" | "chat" };
    },
  ) => Promise<ChangesOutcome>;
}

const STAMP_COALESCE_MS = 1000;

/** 1.172.0 (A1): keep what the person asked on the card, in order. A save
 *  that fails loses only the record, never the send that already went. */
async function keepLaterRequests(workspaceId: string, cardId: string, requests: LaterRequestDraft[]): Promise<void> {
  for (const r of requests) {
    try {
      await useKanban.getState().addLaterRequest(workspaceId, cardId, r.text, r.source);
    } catch (e) {
      console.warn("builder: the later request wasn't kept on the card", e);
    }
  }
}

/** 1.171.0 (K7): the Builder chosen on a card is the one a card made next
 *  takes as its own pick (`kanban_card_create` stamps it); cards made
 *  before keep theirs. Unchanged sends nothing; a refused save
 *  only loses the memory, never the card's own choice. */
function rememberBuilderChoice(vendor: "claude" | "codex"): void {
  void useSettings
    .getState()
    .update((cur) =>
      cur.behavior.lastBuilderVendor === vendor ? cur : { ...cur, behavior: { ...cur.behavior, lastBuilderVendor: vendor } },
    )
    .catch((e) => console.warn("builder: the Builder choice wasn't remembered for new cards", e));
}

/** CL-7 round 3: a submit this old that a scan still finds at an idle
 *  prompt started no turn (an empty Enter, a menu pick): the prompt scan
 *  settles 700 ms after output (`BuilderSession`), plus a margin. */
export const SUBMIT_SETTLE_MS = 1_500;

/** Record the prompt box's state (`idle`, or unchanged when null) and, when
 *  the box is idle or the held-message valve opened (`idle === null`), write
 *  every held message in one paste. */
function flushHeld(cardId: string, idle: boolean | null): void {
  const rt = useBuilder.getState().byCard[cardId];
  if (!rt) return;
  // 1.174.5: never onto what the person typed; it goes once that's gone.
  const flush = idle !== false && !draftInTheWay(cardId, rt);
  let toFlush: string[] = [];
  let settleFlushed: (error?: unknown) => void = () => {};
  useBuilder.setState((s) => {
    const cur = s.byCard[cardId];
    if (!cur) return s;
    toFlush = flush ? cur.pending : [];
    // GH #129: the messages this flush writes, taken with them.
    if (flush) settleFlushed = heldWaiters.take(cardId);
    return {
      byCard: {
        ...s.byCard,
        [cardId]: {
          ...cur,
          ...(idle === null ? {} : { promptBoxIdle: idle }),
          pending: flush ? [] : cur.pending,
        },
      },
    };
  });
  if (flush) stopHeldValve(cardId);
  if (toFlush.length > 0) {
    void writePaste(rt.ptyId, toFlush.join("\n\n")).then(
      () => settleFlushed(),
      (e) => {
        console.warn("builder: pending injection failed", e);
        settleFlushed(e);
      },
    );
  }
}

/** Walk H1: watch a card's held messages; open the valve when due. */
function startHeldValve(cardId: string): void {
  if (!heldSince.has(cardId)) heldSince.set(cardId, Date.now());
  if (heldValveTimers.has(cardId)) return;
  const timer = setInterval(() => {
    const rt = useBuilder.getState().byCard[cardId];
    const since = heldSince.get(cardId);
    if (!rt || rt.pending.length === 0 || since == null) {
      stopHeldValve(cardId);
      return;
    }
    // 2026-10-15: never into the member's `!` or `/` draft — a paste there
    // would run in the shell. It waits, and the terminal says why
    // (`draftHoldNotice`); clearing the draft delivers it.
    if (rt.composerEscaped === true || draftInTheWay(cardId, rt)) return;
    if (heldValveDue({ heldSince: since, lastOutputAt: rt.lastOutputAt, startedAt: rt.startedAt }, Date.now())) {
      console.warn(`builder: ${cardId}: a held message waited ${HELD_VALVE_MS / 1000}s with the session silent; writing it`);
      flushHeld(cardId, null);
    }
  }, HELD_VALVE_TICK_MS);
  heldValveTimers.set(cardId, timer);
}

function pushbackAcceptedMessage(n: number): string {
  return `[Plyloft] The human kept snapshot ${n} as it is: the Reviewer's requested changes are overridden and no further changes are needed. Please do not edit files; the card moves to Ship.`;
}

/** 1.172.0 E2 (Challenger 2): per PTY, the message of Plyloft's whose paste
 *  was left in Codex's composer unsent (`PASTE_STILL_UNSENT`). */
const unsentPastes = new Map<string, string>();

/** Windows' Codex Builder: each PTY's pastes in order, so a second message
 *  never lands between a paste and its Enter. */
const pasteChains = new Map<string, Promise<unknown>>();
/** What the human typed into a Builder terminal while one of Ply's pastes
 *  waited for its Enter, per PTY, in order. Written once the Enter is. */
const heldInput = new Map<string, string[]>();

/**
 * The human's keystrokes from the Builder terminal (`BuilderSession`'s
 * xterm `onData`). While a paste of Ply's waits for its separate Enter
 * (Windows + Codex only), they are held: typed into the same composer they
 * would be submitted with Ply's message. They go, in order, right after
 * that Enter. Anywhere else — the Mac, Claude — they are written at once,
 * as before.
 *
 * `onWritten` runs once a direct write landed (1.171 walk): the PTY's
 * activity beacon — what `builder_last_output_at` reads — is stamped by
 * every write too, so the caller rescans the screen after it; otherwise a
 * write that draws nothing (a focus report into an idle Codex) leaves the
 * last scan older than the "last output" for good.
 */
export function writeBuilderInput(ptyId: string, data: string, onWritten?: () => void): void {
  // v1.154.1 (J5): the person typing into the session is work sent to it;
  // the terminal's own reports (focus, cursor position, mouse…) are not.
  if (!isTerminalReport(data)) {
    const typedInto = Object.entries(useBuilder.getState().byCard).find(([, rt]) => rt.ptyId === ptyId)?.[0];
    if (typedInto) {
      useBuilder.getState().noteSent(typedInto);
      typedSinceComposerSeen.add(typedInto);
      typedSinceEmpty.add(ptyId);
      typedAtByCard.set(typedInto, Date.now());
      // CL-7: an Enter submits; the keys before it only type. Round 3: only
      // at the prompt with its turn over — an Enter answering a question
      // mid-turn is not a new turn — and never a pasted line or Option+Enter.
      if (useBuilder.getState().byCard[typedInto]?.turnIdle === true && typedEnter(data)) {
        useBuilder.getState().noteSubmitted(typedInto);
      }
    }
  }
  if (pasteChains.has(ptyId)) {
    // 1.172.0 E2: a cursor position report held until after the paste
    // answers a question nobody is waiting for any more. ConPTY's input
    // parser shares the `R` final between that report and F3 (`ESC[1;mR`):
    // one it didn't ask for reads as F3 with the column as its modifiers —
    // column 1 is plain F3, Codex's transcript search (codex-cli 0.164.0's
    // default). Not measured on Windows; dropped, not held, either way.
    // (Challenger 5) So a program that asks `ESC[6n` in this window gets no
    // answer — acceptable: held, it came seconds late, past any wait for it
    // — and Shift/Ctrl+F3 typed by the person in this window (same shape)
    // is dropped too.
    if (isCursorReport(data)) {
      console.warn("builder: a cursor position report during a paste was dropped");
      return;
    }
    const held = heldInput.get(ptyId);
    if (held) held.push(data);
    else heldInput.set(ptyId, [data]);
    return;
  }
  // E2 (round 2, Challenger 3): the person's Enter for a message of
  // Plyloft's left unsent in Codex's message box — once the screen shows it
  // taken, it is no longer unsent.
  const sendsUnsent = unsentPastes.has(ptyId) && typedEnter(data);
  ptyWrite(ptyId, new TextEncoder().encode(data)).then(
    () => {
      onWritten?.();
      if (sendsUnsent) setTimeout(() => void unsentTakenByHand(ptyId), SUBMIT_CONFIRM_MS);
    },
    (e) => {
      console.warn("builder ptyWrite failed:", e);
      tellInputLost(ptyId, data, e);
    },
  );
}

/** 1.176.2 (E1, S-4): what the person typed into a Builder's terminal
 *  didn't reach it. The failures of one burst (every key of a line fails
 *  alike) are one toast, and the text they typed is under Details. */
const lostInput = new Map<string, { text: string; cause: unknown; timer: ReturnType<typeof setTimeout> }>();
const LOST_INPUT_SETTLE_MS = 600;
const LOST_INPUT_KEEP = 4000;
export function tellInputLost(ptyId: string, data: string, cause: unknown): void {
  // The terminal's own reports are not the person's words.
  if (isTerminalReport(data)) return;
  const typed = data.replace(/\x1b\[[<0-9;?]*[A-Za-z~]/g, "").replace(/\r/g, "\n").replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
  const held = lostInput.get(ptyId);
  if (held) clearTimeout(held.timer);
  const text = (held?.text ?? "") + typed;
  const timer = setTimeout(() => {
    lostInput.delete(ptyId);
    // What was typed is never shown or kept in the toast (a pasted secret
    // would sit in Recent messages): it is only offered to the clipboard.
    const kept = text.trim() ? text.slice(0, LOST_INPUT_KEEP) : "";
    pushToast({
      kind: "error",
      title: "What you typed didn't reach the Builder",
      body: "The Builder's session isn't taking input. Resume it or start it again, then type it once more.",
      ...(kept
        ? {
            action: {
              label: "Copy what you typed",
              onClick: () => void navigator.clipboard?.writeText(kept).catch(() => {}),
            },
          }
        : {}),
    });
  }, LOST_INPUT_SETTLE_MS);
  lostInput.set(ptyId, { text, cause, timer });
}

/** E2 (round 2): after the person's Enter, whether the message Plyloft left
 *  unsent in `ptyId` has gone — the composer no longer holds it, and no
 *  search is open. Then it is forgotten, and a verdict that was waiting on
 *  it is recorded as sent (`verdictSentByHand`). Unknown screen: nothing. */
async function unsentTakenByHand(ptyId: string): Promise<void> {
  const text = unsentPastes.get(ptyId);
  const cardId = cardOfPty(ptyId);
  if (text === undefined || !cardId) return;
  const holds = composerHoldsPasteNow(cardId, plainForKeys(text));
  if (holds !== false || overlayOpenNow(cardId) === true) return;
  unsentPastes.delete(ptyId);
  const workspaceId = useBuilder.getState().byCard[cardId]?.workspaceId;
  if (!workspaceId) return;
  try {
    await verdictSentByHand(cardId, ptyId, verdictDeps(workspaceId, cardId));
  } catch (e) {
    console.warn("builder: recording the verdict sent by hand failed", e);
  }
}

/** The keystrokes held while a paste of Ply's waited for its Enter
 *  (Windows' Codex), written after it. 1.172.0 B3 (self-check leftover):
 *  they were typed with `writeBuilderInput`, whose `onWritten` (the
 *  caller's rescan) never runs for a held write — so, like a paste, this
 *  write asks the card's live terminal to look at its screen again
 *  (`rescanBuilderScreen`): the PTY's activity beacon is stamped by every
 *  write, and a write that draws nothing must not leave the last scan older
 *  than it. */
function flushHeldInput(ptyId: string): void {
  const held = heldInput.get(ptyId);
  heldInput.delete(ptyId);
  if (!held || held.length === 0) return;
  // 1.174.5: a scan during the paste may have cleared this; no scan has read
  // these keys yet.
  const typedInto = cardOfPty(ptyId);
  if (typedInto) typedSinceComposerSeen.add(typedInto);
  ptyWrite(ptyId, new TextEncoder().encode(held.join(""))).then(
    () => rescanBuilderScreen(cardOfPty(ptyId)),
    (e) => {
      console.warn("builder ptyWrite failed:", e);
      tellInputLost(ptyId, held.join(""), e);
    },
  );
}

/** The card whose Builder runs in `ptyId`, if any. */
function cardOfPty(ptyId: string): string | null {
  return Object.entries(useBuilder.getState().byCard).find(([, rt]) => rt.ptyId === ptyId)?.[0] ?? null;
}

/** Ply's message into a Builder PTY: the paste and its Enter in one write,
 *  or — Codex on Windows — the paste, then the Enter once it has settled.
 *  Exported for its tests. */
export async function writePaste(ptyId: string, text: string): Promise<void> {
  const entry = Object.entries(useBuilder.getState().byCard).find(([, rt]) => rt.ptyId === ptyId);
  // CL-7: a paste of Plyloft's is submitted with it — a new turn.
  if (entry) useBuilder.getState().noteSubmitted(entry[0]);
  if (!entry || !submitsSeparately(entry[1].vendor, isWindows())) {
    await ptyWrite(ptyId, pasteBytes(text));
    // 1.172.0 B3 (self-check leftover): a paste the CLI draws nothing for
    // stamped the activity beacon all the same; the live terminal looks
    // at its screen again, so its last scan isn't older than that.
    rescanBuilderScreen(entry?.[0] ?? null);
    return;
  }
  // Windows: Codex takes an Enter inside the paste as part of it
  // (`builderInject::submitsSeparately`) — the Enter goes once it settled,
  // and (F1) again while the live screen shows the paste still unsent.
  const cardId = entry[0];
  const previous = pasteChains.get(ptyId) ?? Promise.resolve();
  const mine = previous
    .catch(() => {})
    .then(() =>
      writePasteThenSubmit(text, {
        write: (bytes) => ptyWrite(ptyId, bytes),
        lastOutputAt: () => builderLastOutputAt(cardId),
        // E2: the composer is compared with what was typed in — the text
        // as plain keys (`pasteBodyBytes`).
        composerHoldsPaste: () => composerHoldsPasteNow(cardId, plainForKeys(text)),
        alreadyPasted: () => unsentPastes.get(ptyId) === text,
        overlayOpen: () => overlayOpenNow(cardId),
        resubmitted: (n) => console.warn(`builder: ${cardId}: the paste was still unsent; Enter sent again (${n})`),
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      }),
    );
  pasteChains.set(ptyId, mine);
  try {
    await mine;
    if (unsentPastes.get(ptyId) === text) unsentPastes.delete(ptyId);
    rescanBuilderScreen(cardId);
  } catch (e) {
    // E2 (Challenger 2): this message sits in the composer unsent — a
    // retry of it sends only the Enter, never a second copy.
    if (e instanceof Error && e.message === PASTE_STILL_UNSENT) unsentPastes.set(ptyId, text);
    else if (unsentPastes.get(ptyId) === text) unsentPastes.delete(ptyId);
    throw e;
  } finally {
    // The last queued paste is done (Enter written, or its write failed):
    // what the human typed meanwhile goes now, after it.
    if (pasteChains.get(ptyId) === mine) {
      pasteChains.delete(ptyId);
      flushHeldInput(ptyId);
    }
  }
}

/** F1: each card's live Builder screen readers (`BuilderSession`) — the
 *  settled tail of its visible screen. Several hosts of one card can
 *  overlap (as `observedHosts`); the newest is read. */
const screenReaders = new Map<string, Array<() => string>>();

/** 1.172.0 B3: each card's live Builder hosts' rescans (`BuilderSession`'s
 *  prompt scan), newest last, as `screenReaders`. */
const screenRescans = new Map<string, Array<() => void>>();

/** F1: the card's terminal can be read for its screen until the returned
 *  function is called. 1.172.0 B3: `rescan` — its prompt scan, run again
 *  after a write of Ply's that may draw nothing (`rescanBuilderScreen`). */
export function registerBuilderScreen(cardId: string, read: () => string, rescan?: () => void): () => void {
  const list = [...(screenReaders.get(cardId) ?? []), read];
  screenReaders.set(cardId, list);
  if (rescan) screenRescans.set(cardId, [...(screenRescans.get(cardId) ?? []), rescan]);
  return () => {
    const rest = (screenReaders.get(cardId) ?? []).filter((r) => r !== read);
    if (rest.length > 0) screenReaders.set(cardId, rest);
    else screenReaders.delete(cardId);
    if (rescan) {
      const others = (screenRescans.get(cardId) ?? []).filter((r) => r !== rescan);
      if (others.length > 0) screenRescans.set(cardId, others);
      else screenRescans.delete(cardId);
    }
  };
}

/** 1.172.0 B3: the card's newest live Builder terminal scans its screen
 *  again; nothing when none is live. */
export function rescanBuilderScreen(cardId: string | null): void {
  if (!cardId) return;
  const list = screenRescans.get(cardId);
  if (!list || list.length === 0) return;
  try {
    list[list.length - 1]();
  } catch (e) {
    console.warn("builder: screen rescan failed", e);
  }
}

/** F1: whether the card's Codex composer, on its live screen now, still
 *  holds the message pasted (`codexComposerHoldsPaste`); null when no live
 *  terminal of the card can be read. */
function composerHoldsPasteNow(cardId: string, text: string): boolean | null {
  const readers = screenReaders.get(cardId);
  if (!readers || readers.length === 0 || !isBuilderObserved(cardId)) return null;
  try {
    return codexComposerHoldsPaste(readers[readers.length - 1](), text);
  } catch {
    return null;
  }
}

/** 1.172.0 E2: whether the card's Codex, on its live screen now, shows its
 *  transcript search over the composer (`codexOverlayOpen`); null when no
 *  live terminal of the card can be read. */
function overlayOpenNow(cardId: string): boolean | null {
  const readers = screenReaders.get(cardId);
  if (!readers || readers.length === 0 || !isBuilderObserved(cardId)) return null;
  try {
    return codexOverlayOpen(readers[readers.length - 1]());
  } catch {
    return null;
  }
}

/** G4 Challenger 9: when a scan last found each card's Builder working
 *  (its turn not over). Not state: nothing renders it. */
const turnBusySeenAt = new Map<string, number>();

/** When each card's Builder screen was last scanned for its prompt: the
 *  scan result is only good for output older than the scan. Not state —
 *  it changes on every settle and nothing renders it. */
const promptScanAt = new Map<string, number>();
/** When each card's Builder terminal was last resized. Not state either: a
 *  window drag resizes many times a second and nothing renders from it. */
const resizedAtByCard = new Map<string, number>();
/** 1.174.3: the session each card's last Resume started. Its terminal may attach
 *  before or after `builderResume` answers, and again on every remount. A session
 *  from Start fresh has another PTY, so this doesn't reach it. */
const resumedByCard = new Map<string, { ptyId: string; at: number }>();

/** 1.174.3: remembers the session a Resume started (a card's, or a build's by
 *  its lane key), and marks its runtime if its terminal attached first. */
export function noteBuilderResumed(key: string, ptyId: string, at: number): void {
  resumedByCard.set(key, { ptyId, at });
  useBuilder.setState((s) => {
    const rt = s.byCard[key];
    return rt?.ptyId === ptyId ? { byCard: { ...s.byCard, [key]: { ...rt, resumedAt: at } } } : s;
  });
}

/** `resumedWithoutTurn` for a session key, as the store has it now. */
export function builderResumedIdle(key: string): boolean {
  const { byCard, sentAt, submittedAt } = useBuilder.getState();
  const rt = byCard[key];
  return rt != null && resumedWithoutTurn(rt, sentAt[key] ?? null, submittedAt[key] ?? null);
}
/** GH #129: who waits for each card's held messages to be written. */
const heldWaiters = new HeldMessageWaiters();
/** SL-5: keyed messages (`deliverWhenIdle`'s `key`) held or being
 *  written, as `<cardId>\0<key>`: a second of the same key is refused. */
const exclusiveDeliveries = new Set<string>();
/** SL-5: why a second keyed message was refused. */
export const ALREADY_DELIVERING_ERROR = "A message of this kind is already on its way to the Builder.";
/** G7 fixes (M2): why a `noHold` delivery was refused. */
export const NOT_AT_PROMPT_ERROR = "The Builder isn't waiting at its prompt.";
/** GH #129: cards whose `Back to the Builder` is being delivered. */
const handedOverSending = new Set<string>();
/**
 * v1.154.1 (walk H1, Challenger): the safety valve on a held message. The
 * prompt matcher now refuses Claude's input box while a turn runs; were it
 * ever wrong the other way round (an idle screen it doesn't recognise), a
 * held message must not wait forever. A message held longer than this,
 * while the session printed nothing for as long, is written anyway — the
 * CLI queues typed input itself. A running turn redraws its spinner every
 * second, so this never fires mid-turn.
 */
export const HELD_VALVE_MS = 120_000;
const HELD_VALVE_TICK_MS = 15_000;
/** Since when each card has had a message held, and its valve's timer. */
const heldSince = new Map<string, number>();
/** Walk F1: cards whose member typed into the Builder since the last scan
 *  that could read the composer (`markPromptBox`'s `escaped` not null). */
const typedSinceComposerSeen = new Set<string>();
/** 1.174.5 (Challenger 1): sessions whose input row the person has typed into
 *  since it last read empty, by PTY so a remount keeps it. Without keys, text
 *  in that row isn't a draft, however it's drawn: a false reading would hold
 *  every message for good. */
const typedSinceEmpty = new Set<string>();

/** 1.174.5 (walk 2026-11-05): a paste now would go out joined to what the person
 *  typed: the last scan saw it, or keys went in that no scan has read yet. */
function draftInTheWay(cardId: string, rt: Pick<BuilderRuntime, "composerDraft">): boolean {
  return rt.composerDraft === true || typedSinceComposerSeen.has(cardId);
}

/** `draftInTheWay` for a card, from outside this file. */
export function builderDraftInTheWay(cardId: string): boolean {
  const rt = useBuilder.getState().byCard[cardId];
  return rt != null && draftInTheWay(cardId, rt);
}

/** The terminal goes before a scan read the last keys, which would hold
 *  messages with nothing on screen to say why. */
export function forgetUnscannedKeys(cardId: string): void {
  typedSinceComposerSeen.delete(cardId);
}
/** G11 (Challenger): when the person last typed into each card's Builder
 *  session (not the terminal's own reports). Not state: nothing renders it. */
const typedAtByCard = new Map<string, number>();
/** G11: when the person last typed into the card's Builder session. */
export function builderTypedAt(cardId: string): number | undefined {
  return typedAtByCard.get(cardId);
}
const heldValveTimers = new Map<string, ReturnType<typeof setInterval>>();

/** Walk H1: whether the valve lets a held message through at `now`. */
export function heldValveDue(
  held: { heldSince: number; lastOutputAt?: number; startedAt: number },
  now: number,
): boolean {
  const quietSince = held.lastOutputAt ?? held.startedAt;
  return now - held.heldSince >= HELD_VALVE_MS && now - quietSince >= HELD_VALVE_MS;
}

function stopHeldValve(cardId: string): void {
  const timer = heldValveTimers.get(cardId);
  if (timer != null) clearInterval(timer);
  heldValveTimers.delete(cardId);
  heldSince.delete(cardId);
}

/** The polling timer of each running self-check. */
const selfCheckTimers = new Map<string, ReturnType<typeof setInterval>>();
const SELF_CHECK_TICK_MS = 1000;
/** Cards whose Build done is asking the backend for the self-check: a
 *  second press meanwhile starts nothing. */
const selfCheckStarting = new Set<string>();

function stopSelfCheckTimer(cardId: string): void {
  const timer = selfCheckTimers.get(cardId);
  if (timer != null) clearInterval(timer);
  selfCheckTimers.delete(cardId);
}

/** C6 (UX-6.8): a Builder press that failed. The card page draws it in the
 *  error shape (`errorByCard`); the toast only says it happened, and carries
 *  the raw reason to copy. */
function reportFailure(
  set: (fn: (s: BuilderStore) => Partial<BuilderStore>) => void,
  cardId: string,
  action: string,
  e: unknown,
): void {
  const cause = e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
  set((s) => ({ errorByCard: { ...s.errorByCard, [cardId]: { action, cause } } }));
  pushToast({
    kind: "error",
    title: `${action} didn't go through`,
    body: "What happened is on the card.",
    copyText: cause,
  });
}

/** 1.168.1 B3: the project has no checks set up (unknown reads as some). */
function noChecksIn(workspaceId: string): Promise<boolean> {
  return projectConfigGet(workspaceId)
    .then(noChecksSetUp)
    .catch(() => false);
}

function buildDoneToast(result: BuildDone, noChecks: boolean): void {
  if (result.newSnapshot || result.reselected) {
    // 1.168.1 B3: with no checks set up, none run — the toast says so.
    pushToast({ kind: "info", ...workSavedToastWords(result.reviewWaitingOn != null, noChecks) });
  }
}

/** 1.171.0 (D1): the permissions choice a Start build of `card` runs in,
 *  as the card shows it (`effectiveBuilderPermissions`). */
export function startPermissions(workspaceId: string, card: KanbanCard | null | undefined): BuilderPermissions {
  const settings = useSettings.getState().settings;
  const tourMode = card != null && boundedStartApplies(settings.onboarding, workspaceId, card, false);
  return effectiveBuilderPermissions(card?.builderPermissions, settings.behavior.builderPermissions, tourMode);
}

export const useBuilder = create<BuilderStore>((set, get) => ({
  byCard: {},
  sentAt: {},
  submittedAt: {},
  noteSubmitted: (cardId) =>
    set((s) => {
      const submittedAt = { ...s.submittedAt, [cardId]: Date.now() };
      // A submit is a new turn: the settled turn-over no longer stands, nor
      // does a cut-off one.
      const rt = s.byCard[cardId];
      if (!rt?.turnIdleSettled && !rt?.turnInterrupted) return { submittedAt };
      return { submittedAt, byCard: { ...s.byCard, [cardId]: { ...rt, turnIdleSettled: false, turnInterrupted: false } } };
    }),
  doneAt: {},
  noteSent: (cardId) => {
    const now = Date.now();
    // Typing calls this per key: one update a second is enough.
    if (now - (get().sentAt[cardId] ?? 0) < 1000) return;
    set((s) => ({ sentAt: { ...s.sentAt, [cardId]: now } }));
  },
  trustAsking: {},
  setTrustAsking: (next) => {
    if (!sameTrustAsking(get().trustAsking, next)) set({ trustAsking: next });
  },
  sessionBlocks: {},
  setSessionBlocks: (next) => {
    if (!sameSessionBlocks(get().sessionBlocks, next)) set({ sessionBlocks: next });
  },
  errorByCard: {},
  noteSetUpNeeded: (cardId, press, cause) =>
    set((s) => ({ errorByCard: { ...s.errorByCard, [cardId]: { action: press, cause, setUp: true } } })),
  noteStartBranchMissing: (cardId, press, cause) => {
    const missingBranch = missingBranchOf(cause);
    if (missingBranch) set((s) => ({ errorByCard: { ...s.errorByCard, [cardId]: { action: press, cause, missingBranch } } }));
  },
  clearError: (cardId) =>
    set((s) => {
      if (!s.errorByCard[cardId]) return s;
      const next = { ...s.errorByCard };
      delete next[cardId];
      return { errorByCard: next };
    }),
  bypassPref: {},
  vendorPref: {},
  skipReviewPref: {},
  selfCheck: {},
  doneBusy: {},
  doneWithoutReview: {},
  handedOverDelivery: {},
  verdictDelivery: {},
  prDraftWriting: {},
  fixBusy: {},
  fixSent: {},
  changesSent: {},
  fixRoundSent: {},
  startBusy: {},

  setSkipReviewPref: (cardId, skip) =>
    set((s) => ({ skipReviewPref: { ...s.skipReviewPref, [cardId]: skip } })),
  setBypassPref: (cardId, bypass) =>
    set((s) => ({ bypassPref: { ...s.bypassPref, [cardId]: bypass } })),
  clearBypassPref: (cardId) =>
    set((s) => {
      if (!(cardId in s.bypassPref)) return s;
      const next = { ...s.bypassPref };
      delete next[cardId];
      return { bypassPref: next };
    }),
  setVendorPref: async (workspaceId, cardId, vendor, remember = false) => {
    set((s) => ({ vendorPref: { ...s.vendorPref, [cardId]: vendor } }));
    try {
      await useKanban.getState().setBuilderVendorPref(workspaceId, cardId, vendor);
      // Once the card has it: a refused pick is remembered nowhere.
      if (remember) rememberBuilderChoice(vendor);
    } catch (e) {
      set((s) => {
        if (s.vendorPref[cardId] !== vendor) return s;
        const next = { ...s.vendorPref };
        delete next[cardId];
        return { vendorPref: next };
      });
      pushErrorToast("Couldn't save the Builder choice", e);
    }
  },

  attach: (cardId, workspaceId, ptyId, vendor) =>
    set((s) => {
      typedSinceComposerSeen.delete(cardId);
      typedAtByCard.delete(cardId);
      const prev = s.byCard[cardId];
      const pending = prev && prev.ptyId === ptyId ? prev.pending : [];
      // GH #129: messages held for another session are never written.
      if (prev && prev.ptyId !== ptyId) heldWaiters.take(cardId)(new Error(SESSION_ENDED_ERROR));
      const resumed = resumedByCard.get(cardId);
      return {
        byCard: {
          ...s.byCard,
          [cardId]: {
            workspaceId,
            ptyId,
            vendor,
            startedAt: Date.now(),
            pending,
            ...(resumed?.ptyId === ptyId ? { resumedAt: resumed.at } : {}),
          },
        },
      };
    }),

  detach: (cardId, ptyId) =>
    set((s) => {
      const rt = s.byCard[cardId];
      if (!rt || rt.ptyId !== ptyId) return s;
      heldWaiters.take(cardId)(new Error(SESSION_ENDED_ERROR));
      // GH #135 (owner-side review): the booked acknowledgement outlives the
      // session. It writes no PTY — it only tells the card about a write
      // that already landed — and cancelling it here left the verdict owed,
      // so the next session heard it a second time.
      const next = { ...s.byCard };
      delete next[cardId];
      return { byCard: next };
    }),

  markOutput: (cardId) =>
    set((s) => {
      const rt = s.byCard[cardId];
      if (!rt) return s;
      const now = Date.now();
      // SP-4 round 3-4: any output — a resize's redraw too — ends what the
      // last settled scan saw; not coalesced, so a stream never leaves it
      // standing. The next settled scan says what is on screen again.
      const clearScan = rt.lastSettledScanAt != null;
      // A resize's redraw is not activity: a waiting Builder stays waiting,
      // so it moves no output stamp.
      const real = outputRestartsSilence(
        { lastOutputAt: rt.lastOutputAt, resizedAt: resizedAtByCard.get(cardId) },
        now,
      );
      const stamp = real && (rt.lastOutputAt == null || now - rt.lastOutputAt >= STAMP_COALESCE_MS);
      if (!clearScan && !stamp) return s;
      const next: BuilderRuntime = { ...rt, ...(stamp ? { lastOutputAt: now } : {}) };
      if (clearScan) delete next.lastSettledScanAt;
      return { byCard: { ...s.byCard, [cardId]: next } };
    }),

  noteResize: (cardId) => {
    resizedAtByCard.set(cardId, Date.now());
  },

  markPromptBox: (cardId, idle, turnIdle = false, questionInView = false, settled = false, escaped = false, overlayOpen = false, turnRunning = false, interrupted = false, draft = false) => {
    promptScanAt.set(cardId, Date.now());
    if (turnRunning) {
      // Whatever a Resume may say ends here, on a remount too.
      resumedByCard.delete(cardId);
      if (get().byCard[cardId]?.resumedAt != null) {
        set((s) => {
          const cur = s.byCard[cardId];
          if (!cur) return s;
          const next = { ...cur };
          delete next.resumedAt;
          return { byCard: { ...s.byCard, [cardId]: next } };
        });
      }
    }
    // 1.174.3: what a Resume brought back; a turn cut off after a later submit
    // is the person's own Esc, and they know.
    {
      const cur = get().byCard[cardId];
      const cutOff = interrupted && cur?.resumedAt != null && (get().submittedAt[cardId] ?? 0) < cur.resumedAt;
      if (cur && (cur.turnCutOff ?? false) !== interrupted) {
        set((s) => {
          const rt = s.byCard[cardId];
          return rt ? { byCard: { ...s.byCard, [cardId]: { ...rt, turnCutOff: interrupted } } } : s;
        });
      }
      if (cur && (cur.turnInterrupted ?? false) !== cutOff) {
        set((s) => {
          const rt = s.byCard[cardId];
          return rt ? { byCard: { ...s.byCard, [cardId]: { ...rt, turnInterrupted: cutOff } } } : s;
        });
      }
    }
    if ((get().byCard[cardId]?.codexOverlayOpen ?? false) !== overlayOpen) {
      set((s) => {
        const cur = s.byCard[cardId];
        return cur ? { byCard: { ...s.byCard, [cardId]: { ...cur, codexOverlayOpen: overlayOpen } } } : s;
      });
    }
    const now = Date.now();
    // G4 Challenger 9: a scan that finds the Builder working — its turn started.
    if (!turnIdle) turnBusySeenAt.set(cardId, now);
    // Walk F1: no composer in view right after the member typed (a menu
    // their keys opened) is held as escaped — prefer holding to writing
    // into a draft no scan could read.
    const nextEscaped = escaped === null ? (typedSinceComposerSeen.has(cardId) ? true : null) : escaped;
    if (escaped !== null) typedSinceComposerSeen.delete(cardId);
    // 1.174.5: only keys the person typed make a draft. A message of Plyloft's
    // still in the box is none: its own Enter is on the way, or the card asks.
    if (draft !== null) {
      const cur = get().byCard[cardId];
      if (cur) {
        if (!draft) typedSinceEmpty.delete(cur.ptyId);
        const unsent = unsentPastes.get(cur.ptyId);
        const ownPaste =
          pasteChains.has(cur.ptyId) ||
          (unsent !== undefined && composerHoldsPasteNow(cardId, plainForKeys(unsent)) === true);
        const typed = draft && typedSinceEmpty.has(cur.ptyId) && !ownPaste;
        if ((cur.composerDraft ?? false) !== typed) {
          set((s) => {
            const c = s.byCard[cardId];
            return c ? { byCard: { ...s.byCard, [cardId]: { ...c, composerDraft: typed } } } : s;
          });
        }
      }
    }
    if (nextEscaped !== null && (get().byCard[cardId]?.composerEscaped ?? false) !== nextEscaped) {
      set((s) => {
        const cur = s.byCard[cardId];
        return cur ? { byCard: { ...s.byCard, [cardId]: { ...cur, composerEscaped: nextEscaped } } } : s;
      });
    }
    // SP-4 round 3: only a settled scan is one the actor may trust as the
    // latest word; a max-wait scan mid-stream writes nothing for it.
    if (settled) {
      set((s) => {
        const cur = s.byCard[cardId];
        return cur ? { byCard: { ...s.byCard, [cardId]: { ...cur, lastSettledScanAt: now } } } : s;
      });
    }
    // A scan that finds the turn running ends a settled turn-over; only a
    // settled one that finds it over starts one.
    const settledIdle = get().byCard[cardId]?.turnIdleSettled === true;
    const nextSettledIdle = turnIdle ? settledIdle || settled : false;
    if (settledIdle !== nextSettledIdle) {
      set((s) => {
        const cur = s.byCard[cardId];
        return cur ? { byCard: { ...s.byCard, [cardId]: { ...cur, turnIdleSettled: nextSettledIdle } } } : s;
      });
    }
    if ((get().byCard[cardId]?.questionInView ?? false) !== questionInView) {
      set((s) => {
        const cur = s.byCard[cardId];
        return cur
          ? { byCard: { ...s.byCard, [cardId]: { ...cur, questionInView, draftQuestion: questionInView ? cur.draftQuestion : false } } }
          : s;
      });
    }
    const rt = get().byCard[cardId];
    if (rt && rt.turnIdle !== turnIdle) {
      set((s) => {
        const cur = s.byCard[cardId];
        return cur
          ? { byCard: { ...s.byCard, [cardId]: { ...cur, turnIdle, ...(turnIdle ? { turnIdleAt: now } : {}) } } }
          : s;
      });
    } else if (rt && turnIdle) {
      // Round 3: a submit that started no turn — the turn is still over a
      // settle later — is behind this scan, not a turn under way.
      const submitted = get().submittedAt[cardId];
      if (submitted != null && submitted >= (rt.turnIdleAt ?? 0) && now - submitted > SUBMIT_SETTLE_MS) {
        set((s) => {
          const cur = s.byCard[cardId];
          return cur ? { byCard: { ...s.byCard, [cardId]: { ...cur, turnIdleAt: now } } } : s;
        });
      }
    }
    // 1.174.5: the box was idle all along and what the person typed has gone:
    // what waited on it goes now (`flushHeld` keeps it while the text stays).
    if (rt && rt.promptBoxIdle === true && idle && rt.pending.length > 0) {
      flushHeld(cardId, true);
      return;
    }
    if (!rt || rt.promptBoxIdle === idle) return;
    flushHeld(cardId, idle);
  },

  sendHandedOver: async (cardId, owed) => {
    // v1.154.1 (J5): the hand-over's request for changes is new work.
    if (get().byCard[cardId]) get().noteSent(cardId);
    // A second press while the first is being written sends nothing.
    if (handedOverSending.has(cardId)) return null;
    handedOverSending.add(cardId);
    try {
      return await sendHandedOverOnce(cardId, owed);
    } finally {
      handedOverSending.delete(cardId);
    }
  },

  sendVerdict: (workspaceId, cardId, owed, reason) =>
    deliverVerdict(cardId, owed, verdictDeps(workspaceId, cardId), reason),

  ackVerdict: (workspaceId, cardId, owed) =>
    acknowledgeVerdict(cardId, owed, verdictDeps(workspaceId, cardId)),

  deliverWhenIdle: (cardId, text, onQueued, key, opts) => {
    const rt = get().byCard[cardId];
    if (!rt) return null;
    const slot = key ? `${cardId}\u0000${key}` : null;
    if (slot && exclusiveDeliveries.has(slot)) {
      return Promise.reject(new Error(ALREADY_DELIVERING_ERROR));
    }
    if (opts?.noHold && (rt.promptBoxIdle !== true || rt.pending.length > 0 || rt.composerEscaped === true || draftInTheWay(cardId, rt))) {
      return Promise.reject(new Error(NOT_AT_PROMPT_ERROR));
    }
    // v1.154.1 (J5): a Fix paste or line comments are new work.
    get().noteSent(cardId);
    let delivery: Promise<void>;
    if (rt.promptBoxIdle === true && !draftInTheWay(cardId, rt)) {
      delivery = writePaste(rt.ptyId, text);
    } else {
      // As `Back to the Builder` holds its message: the flush of the held
      // messages settles this wait, and a session that ends first rejects it.
      delivery = heldWaiters.wait(cardId);
      set((s) => {
        const cur = s.byCard[cardId];
        if (!cur) return s;
        return { byCard: { ...s.byCard, [cardId]: { ...cur, pending: [...cur.pending, text] } } };
      });
      if (!get().byCard[cardId]) heldWaiters.take(cardId)(new Error(SESSION_ENDED_ERROR));
      else startHeldValve(cardId);
      onQueued?.();
    }
    if (!slot) return delivery;
    exclusiveDeliveries.add(slot);
    return delivery.finally(() => exclusiveDeliveries.delete(slot));
  },

  lineCommentSend: {},
  claimLineCommentSend: (cardId) => {
    if (get().lineCommentSend[cardId]) return false;
    set((s) => ({ lineCommentSend: { ...s.lineCommentSend, [cardId]: "sending" } }));
    return true;
  },
  markLineCommentSendQueued: (cardId) =>
    set((s) =>
      s.lineCommentSend[cardId]
        ? { lineCommentSend: { ...s.lineCommentSend, [cardId]: "queued" } }
        : s,
    ),
  releaseLineCommentSend: (cardId) =>
    set((s) => {
      if (!s.lineCommentSend[cardId]) return s;
      const next = { ...s.lineCommentSend };
      delete next[cardId];
      return { lineCommentSend: next };
    }),

  inject: (cardId, text) => {
    setDraftQuestion(cardId, false); // U25: anything sent makes it a new turn.
    const rt = get().byCard[cardId];
    if (!rt) return;
    if (rt.promptBoxIdle === true && !draftInTheWay(cardId, rt)) {
      void writePaste(rt.ptyId, text).catch((e) =>
        console.warn("builder: injection failed", e),
      );
      return;
    }
    set((s) => {
      const cur = s.byCard[cardId];
      if (!cur) return s;
      return {
        byCard: { ...s.byCard, [cardId]: { ...cur, pending: [...cur.pending, text] } },
      };
    });
  },

  start: async (workspaceId, cardId, retry) => {
    // GH #135: `Skip review` does not outlive its press — a new session is
    // a new decision, and a choice made for a Build done that never came
    // must not surprise the next one.
    set((s) => ({ skipReviewPref: clearedSkipReview(s.skipReviewPref, cardId) }));
    // CL-11: a new press answers the last "set up first" itself. Tier 4
    // walk 2026-10-14: and any earlier failure on the card ("Resume didn't
    // go through." stayed after a new session started); a failed start
    // says so anew.
    get().clearError(cardId);
    const card = cardInWorkspace(useKanban.getState().byWorkspace, workspaceId, cardId);
    // 1.171.0 (D1): the card's permissions choice (else the tour card's
    // mode, else Settings) — "Never asks" is the bypass. A closed bypass
    // session's posture kept by Start fresh (`bypassPref`) asks for it too;
    // Rust puts the card's own choice first.
    const bypass = (get().bypassPref[cardId] ?? false) || startPermissions(workspaceId, card) === "neverAsks";
    // (Challenger 2) A kept posture is for this one press: no hidden
    // "Never asks" on a later start.
    get().clearBypassPref(cardId);
    // The vendor chosen on the card survives a restart (`builderVendorPref`).
    const vendor = effectiveBuilderVendor(
      get().vendorPref[cardId],
      card,
      useSettings.getState().settings.behavior.builderVendor,
    );
    // OB-14 (§13.2): a vendor that isn't ready here is refused before the
    // card moves, with the way out as the toast's action.
    const refusal = startRefusal(vendor, vendorReadiness(useDoctor.getState().report));
    if (refusal) {
      const switchTo = refusal.switchTo;
      pushToast({
        kind: "error",
        title: refusal.sentence,
        action: switchTo
          ? {
              label: `Choose ${VENDOR_NAME[switchTo]}`,
              onClick: () => void get().setVendorPref(workspaceId, cardId, switchTo, true),
            }
          : {
              label: refusal.fixLabel,
              // 1.176.0 R7: a vendor that doesn't start goes to its Repair.
              onClick: () =>
                refusal.repairs
                  ? void openRepair(refusal.repairs)
                  : useUi.getState().openSettingsSection("diagnostics"),
            },
      });
      return;
    }
    // GH #66: Start build on a card someone else claimed asks first.
    // GH #117: an unassigned issue is claimed in the same press, and the
    // outcome is reported once, here.
    // F16 / Windows walk of 1.160.0: from the press to the session the card
    // says it is starting — the `.env` question, the claim, a set-up and its
    // retry included — so the button never turns back into an enabled Start
    // build in between, and a second press can't start a second run.
    if (get().startBusy[cardId]) return;
    set((s) => ({ startBusy: { ...s.startBusy, [cardId]: true } }));
    try {
      // 1.173.0 (B3): a card with no area to start in asks first (Retry
      // too), before the claim and any worktree; the backend refuses it too.
      if (!(await ensureCardArea(workspaceId, cardId, "start"))) return;
      const started = await startBuildWithClaim({
        // SL-4: the one-time question about git-ignored `.env` files comes
        // before the card's first worktree is made, so the answer counts for
        // it — v1.154.1 (K1) only in a repository that is set up: one that
        // isn't is refused here, before the question and before its issue is
        // claimed.
        beforeClaim: () => offerWorktreeEnvCopy(workspaceId, cardId),
        // n16: a repository not set up is set up once, then the start goes on.
        autoSetUp: () => autoSetUpForStart(workspaceId, cardId),
        onPlanRefusal: (e) => showPlanRefusal(e),
        claimStep: () => useKanban.getState().claimBeforeBuild(workspaceId, cardId),
        start: async () => {
          // UX P-C: the guided first card asks for its mode (Rust decides
          // again); every other card, and this one rewritten, starts as today.
          const now = cardInWorkspace(useKanban.getState().byWorkspace, workspaceId, cardId) ?? card;
          // QoL 7.4 (D10): and the tour's own first card.
          const onboarding = useSettings.getState().settings.onboarding;
          const guided =
            now != null && now.builderPermissions == null && boundedStartApplies(onboarding, workspaceId, now, bypass);
          await builderStart(workspaceId, cardId, vendor, bypass, guided, retry);
          await useKanban.getState().loadFromDisk(workspaceId, true);
        },
        notify: ({ setUp, ...notice }) => {
          if (setUp) get().noteSetUpNeeded(cardId, "Start build", notice.details ?? notice.body ?? "");
          else if (notice.details) get().noteStartBranchMissing(cardId, "Start build", notice.details);
          const id = pushToast(setUp ? { ...notice, action: setUpAction(workspaceId) } : notice);
          // 1.172 A3: a refusal is kept, so the start that goes through takes it away.
          if (notice.kind === "error") noteStartRefusalToast(cardId, id);
        },
        issueNumber: card?.ghIssueNumber,
        title: card?.title ?? "",
      });
      // 1.172 A3: an earlier refusal of this card says nothing true now.
      if (started) dismissStartRefusalToasts(cardId);
      console.info(`builder: start of ${cardId}: ${started ? "started" : "not started, nothing thrown"}`);
    } catch (e) {
      console.warn(`builder: start of ${cardId} refused:`, e);
      throw e;
    } finally {
      set((s) => ({ startBusy: { ...s.startBusy, [cardId]: undefined } }));
    }
  },

  resume: async (workspaceId, cardId) => {
    // GH #135: as on `start` — the box reflects the next press, nothing else.
    set((s) => ({ skipReviewPref: clearedSkipReview(s.skipReviewPref, cardId) }));
    // A new press answers the last failure (it says so anew if it fails).
    get().clearError(cardId);
    try {
      const pressedAt = Date.now();
      const ptyId = (await builderResume(workspaceId, cardId))?.ptyId;
      if (ptyId) noteBuilderResumed(cardId, ptyId, pressedAt);
      await useKanban.getState().loadFromDisk(workspaceId, true);
    } catch (e) {
      // U16: the card's flag is written before this refusal: read first, so Now
      // has its sentence when the failure is recorded (no block in between).
      if (resumeFoundNothing(e)) await useKanban.getState().loadFromDisk(workspaceId, true).catch(() => {});
      reportFailure(set, cardId, "Resume", e);
      throw e;
    }
  },

  done: async (workspaceId, cardId) => {
    if (get().doneBusy[cardId]) return null;
    const skipReview = skipReviewFor(get().skipReviewPref, cardId);
    // ADR 0006 (third card): the self-check comes before Verify and the
    // Challenger, so it runs only when the review will, into a live
    // session that can answer; Build done then goes on by itself.
    if (!skipReview && get().byCard[cardId] && !get().selfCheck[cardId]) {
      if (selfCheckStarting.has(cardId)) return null;
      selfCheckStarting.add(cardId);
      let result: BuildDone | null = null;
      try {
        const started = await startBuildDone(
          selfCheckDeps((r) => (result = r)),
          workspaceId,
          cardId,
          skipReview,
        );
        if (started === "self-check") startSelfCheckWatch(cardId);
      } finally {
        selfCheckStarting.delete(cardId);
      }
      return result;
    }
    if (get().selfCheck[cardId]) return null;
    return finishDone(workspaceId, cardId, null);
  },

  cancelSelfCheck: (cardId) => {
    const run = get().selfCheck[cardId];
    if (!run) return false;
    endSelfCheckWatch(cardId);
    const deps = selfCheckDeps();
    deps.setRun(cardId, null);
    if (run.deliveredAt == null) deps.unsend(cardId, run.message);
    return true;
  },

  skipSelfCheck: async (cardId) => {
    endSelfCheckWatch(cardId);
    await settleSelfCheck(selfCheckDeps(), cardId, "skipped");
  },

  acceptPushback: async (workspaceId, cardId) => {
    try {
      const result = await builderAcceptPushback(workspaceId, cardId);
      pushToast(noNewSnapshotToast(result, await noChecksIn(workspaceId)));
      get().inject(cardId, pushbackAcceptedMessage(result.snapshot.n));
      await useKanban.getState().loadFromDisk(workspaceId, true);
    } catch (e) {
      reportFailure(set, cardId, "Keep it as it is", e);
      throw e;
    }
  },

  reviewAgain: async (workspaceId, cardId) => {
    // GH #99: a failed review runs again as it was; an incomplete one in
    // smaller passes (builder.rs::record_review_again chooses the same).
    const card = useKanban
      .getState()
      .byWorkspace[workspaceId]?.cards.find((c) => c.id === cardId);
    const last = card?.builder?.review;
    const smaller = last?.status !== "failed" && !last?.failedPasses;
    const how = smaller ? " in smaller passes" : "";
    try {
      const n = await builderReviewAgain(workspaceId, cardId);
      pushToast({
        kind: "info",
        title: "Reviewing again",
        body: `Round ${n} is reviewed again${how}. The verdict goes to the Builder session and to the card's Review.`,
      });
      // The Builder is told not to edit meanwhile.
      get().inject(
        cardId,
        `[Plyloft] The Reviewer is reviewing snapshot ${n} again${smaller ? ", in smaller passes" : ""}. Please do not edit files until the result arrives here.`,
      );
      await useKanban.getState().loadFromDisk(workspaceId, true);
    } catch (e) {
      reportFailure(set, cardId, "Review again", e);
      throw e;
    }
  },

  reviewRetry: async (workspaceId, cardId, vendor, retry) => {
    const card = cardInWorkspace(useKanban.getState().byWorkspace, workspaceId, cardId);
    try {
      const n = await builderReviewRetry(workspaceId, cardId, vendor, retry);
      pushToast({
        kind: "info",
        title: "Reviewing again",
        body: `Round ${n} is reviewed again on the model you chose. The verdict goes to the Builder session and to the card's Review.`,
      });
      // As Review again: a live Builder is told not to edit meanwhile.
      get().inject(
        cardId,
        `[Plyloft] The Reviewer is reviewing snapshot ${n} again. Please do not edit files until the result arrives here.`,
      );
      await useKanban.getState().loadFromDisk(workspaceId, true);
    } catch (e) {
      // Owner (b): the toast names the card.
      reportFailure(set, cardId, card?.title ? `Retry the review of “${card.title}”` : "Retry the review", e);
      throw e;
    }
  },

  fixFromGitHub: async (workspaceId, cardId, options) => {
    setDraftQuestion(cardId, false); // U25: a fix round's question leads again.
    const brief = options?.brief === true;
    // One press at a time per card: a second one while it gathers, or while
    // its message is held for the prompt, sends nothing.
    if (get().fixBusy[cardId]) return "failed";
    const setBusy = (v: "gathering" | "queued" | null) =>
      set((s) => {
        const next = { ...s.fixBusy };
        if (v) next[cardId] = v;
        else delete next[cardId];
        return { fixBusy: next };
      });
    setBusy("gathering");
    const cardNow = () => cardInWorkspace(useKanban.getState().byWorkspace, workspaceId, cardId);
    const sessionOpen = () => {
      const pty = cardNow()?.builder?.ptyId;
      const rt = get().byCard[cardId];
      return Boolean(pty && rt && rt.ptyId === pty);
    };
    // Walk I4: what this press is about, as GitHub said it at the press.
    const pressedPr = cardNow()?.pr;
    // A brief change isn't GitHub's word: it never holds Fix back.
    const pressedKey = pressedPr && !brief ? prFixKey(pressedPr) : null;
    try {
      const outcome = await fixWithBuilder({
        ...(brief ? { what: BRIEF_FIX_WHAT } : {}),
        // 1.175.0 F5 round 2: a brief change is the person's (never by itself).
        byItself: !brief && fixRoundCheckOn(cardNow() ?? { prReview: null }, useSettings.getState().settings.behavior.checkFixRoundsByItself !== false),
        gather: () => (brief ? cardPrBriefFixMessage(workspaceId, cardId) : cardPrFixMessage(workspaceId, cardId)),
        sessionOpen,
        sessionRecorded: () => Boolean(cardNow()?.builder?.ptyId),
        resume: () => get().resume(workspaceId, cardId),
        reveal: () => openCardStep(workspaceId, cardId, "run"),
        waitForSession: () =>
          waitUntil(sessionOpen, FIX_SESSION_WAIT_MS, (ms) => new Promise((r) => setTimeout(r, ms))),
        deliver: (text, onQueued) => get().deliverWhenIdle(cardId, text, onQueued, PR_FIX_KEY),
        queued: () => setBusy("queued"),
        notify: (kind, title, body, details) => pushToast({ kind, title, body, details }),
      });
      if (outcome === "sent" && pressedKey) {
        set((s) => ({ fixSent: { ...s.fixSent, [cardId]: pressedKey } }));
      }
      // 1.175.0 F5: GitHub's fix is a round Plyloft sent; a brief change is the person's.
      if (outcome === "sent") noteFixRoundSent(cardId, brief ? null : "pr");
      return outcome;
    } finally {
      setBusy(null);
    }
  },

  resolveShipConflict: async (workspaceId, cardId) => {
    if (get().fixBusy[cardId]) return "failed";
    const setBusy = (v: "gathering" | "queued" | null) =>
      set((s) => {
        const next = { ...s.fixBusy };
        if (v) next[cardId] = v;
        else delete next[cardId];
        return { fixBusy: next };
      });
    setBusy("gathering");
    const cardNow = () => cardInWorkspace(useKanban.getState().byWorkspace, workspaceId, cardId);
    const sessionOpen = () => {
      const pty = cardNow()?.builder?.ptyId;
      const rt = get().byCard[cardId];
      return Boolean(pty && rt && rt.ptyId === pty);
    };
    try {
      return await askBuilderToResolve({
        start: async () => {
          try {
            return await cardShipConflictStart(workspaceId, cardId);
          } finally {
            await useKanban.getState().loadFromDisk(workspaceId, true);
          }
        },
        sessionOpen,
        sessionRecorded: () => Boolean(cardNow()?.builder?.ptyId),
        resume: () => get().resume(workspaceId, cardId),
        reveal: () => openCardStep(workspaceId, cardId, "run"),
        waitForSession: () =>
          waitUntil(sessionOpen, FIX_SESSION_WAIT_MS, (ms) => new Promise((r) => setTimeout(r, ms))),
        deliver: (text, onQueued) => get().deliverWhenIdle(cardId, text, onQueued, SHIP_CONFLICT_KEY),
        queued: () => setBusy("queued"),
        notify: (kind, title, body, details) => pushToast({ kind, title, body, details }),
      });
    } finally {
      setBusy(null);
    }
  },

  undoShipConflictMerge: async (workspaceId, cardId) => {
    // 1.170.0 (G6): a merge Bring in started (clean, or its conflict) goes
    // back to before that press, not to a ship's conflict.
    const before = cardInWorkspace(useKanban.getState().byWorkspace, workspaceId, cardId);
    const shipConflict = before?.reviewStatus === "conflict_blocked" && !before.shipConflict?.sync;
    const leftOut = before?.shipConflict?.sync ? before.shipConflict.branch?.trim() || targetName(null) : null;
    try {
      await cardShipConflictUndo(workspaceId, cardId);
      pushToast(
        leftOut
          ? {
              kind: "info",
              title: `${leftOut}'s changes left out`,
              body: "The card's copy is as it was before you brought them in. You can bring them in again later.",
            }
          : {
              kind: "info",
              title: "Merge undone",
              body: shipConflict
                ? "The card's copy is back as it was before the merge. The card is at Ship stopped on a conflict again."
                : "The card's copy is back as it was before the merge.",
            },
      );
    } catch (e) {
      reportFailure(set, cardId, UNDO_MERGE_LABEL, e);
    } finally {
      await useKanban.getState().loadFromDisk(workspaceId, true);
    }
  },

  askBuilder: async (workspaceId, cardId, text, options) => {
    const cardNow = () => cardInWorkspace(useKanban.getState().byWorkspace, workspaceId, cardId);
    const sessionOpen = () => {
      const pty = cardNow()?.builder?.ptyId;
      const rt = get().byCard[cardId];
      return Boolean(pty && rt && rt.ptyId === pty);
    };
    const outcome = await sendChangesToBuilder({
      gather: async () => text,
      sessionOpen,
      sessionRecorded: () => Boolean(cardNow()?.builder?.ptyId),
      resume: () => get().resume(workspaceId, cardId),
      reveal: () => openCardStep(workspaceId, cardId, "run"),
      waitForSession: () =>
        waitUntil(sessionOpen, FIX_SESSION_WAIT_MS, (ms) => new Promise((r) => setTimeout(r, ms))),
      deliver: (message, queued) => get().deliverWhenIdle(cardId, message, queued, options.key),
      notify: (kind, title, body, details) => pushToast({ kind, title, body, details }),
      next: options.next,
      sentBody: options.sentBody,
    });
    if (outcome === "sent" && options.markSent) {
      const at = latestSnapshotN(cardNow() ?? {});
      set((s) => ({ changesSent: { ...s.changesSent, [cardId]: at } }));
    }
    // 1.175.0 F5: this computer's failed checks are a round Plyloft sent.
    if (outcome === "sent") noteFixRoundSent(cardId, options.key === "checks-fix" ? "checks" : null);
    if (outcome === "sent" && options.laterRequest) {
      await keepLaterRequests(workspaceId, cardId, [options.laterRequest]);
    }
    return outcome;
  },

  sendChanges: async (workspaceId, cardId, rejections, onQueued) => {
    setDraftQuestion(cardId, false);
    const cardNow = () => cardInWorkspace(useKanban.getState().byWorkspace, workspaceId, cardId);
    const sessionOpen = () => {
      const pty = cardNow()?.builder?.ptyId;
      const rt = get().byCard[cardId];
      return Boolean(pty && rt && rt.ptyId === pty);
    };
    const outcome = await sendChangesToBuilder({
      gather: () => cardReviewFollowupMessage(rejections),
      sessionOpen,
      sessionRecorded: () => Boolean(cardNow()?.builder?.ptyId),
      resume: () => get().resume(workspaceId, cardId),
      reveal: () => openCardStep(workspaceId, cardId, "run"),
      waitForSession: () =>
        waitUntil(sessionOpen, FIX_SESSION_WAIT_MS, (ms) => new Promise((r) => setTimeout(r, ms))),
      deliver: (text, queued) =>
        get().deliverWhenIdle(
          cardId,
          text,
          () => {
            queued();
            onQueued?.();
          },
          REVIEW_CHANGES_KEY,
        ),
      notify: (kind, title, body, details) => pushToast({ kind, title, body, details }),
    });
    if (outcome === "sent") {
      const at = latestSnapshotN(cardNow() ?? {});
      set((s) => ({ changesSent: { ...s.changesSent, [cardId]: at } }));
      // 1.175.0 F5: the person's own changes never check by themselves.
      noteFixRoundSent(cardId, null);
      await keepLaterRequests(workspaceId, cardId, laterRequestsOf(rejections));
    }
    return outcome;
  },

  close: async (workspaceId, cardId) => {
    try {
      await builderClose(workspaceId, cardId);
      await useKanban.getState().loadFromDisk(workspaceId, true);
      // PR #347 walk: the terminal may have unmounted before the PTY's exit
      // reached it; nothing waits in a closed session.
      dropEndedBuilderSessions(cardId);
      return true;
    } catch (e) {
      reportFailure(set, cardId, "Close session", e);
      return false;
    }
  },
  putBack: async (workspaceId, cardId) => {
    await kanbanCardPutBack(workspaceId, cardId);
    // Bug B: the backend wrote the card; read it before any frontend write.
    await useKanban.getState().loadFromDisk(workspaceId, true);
    // Its sessions (the card's, and both builds' when both built it) ended
    // with it; nothing waits in them.
    dropEndedBuilderSessions(cardId);
  },
}));

/** The snapshot, Verify and the Challenger: Build done after its
 *  self-check (`check`, recorded on the card), or without one. */
async function finishDone(
  workspaceId: string,
  cardId: string,
  check: SelfCheckRecord | null,
): Promise<BuildDone> {
  if (useBuilder.getState().doneBusy[cardId]) {
    throw new Error("Finish and check is already running for this card.");
  }
  // GH #135: this Build done is what the choice was for. Read and cleared
  // in one step — after the guard, so a press that is refused takes nobody
  // else's choice, and before the first await, so the next press starts
  // unchecked and a Build done in flight cannot be read as a second one. A
  // Build done the *backend* refuses spends the choice: the press is what
  // the box is for, and a review that then runs is visible, where a
  // silently skipped one is not.
  const { skipped: skipReview } = takeSkipReview(cardId);
  // Set before the first await, so no click lands between the self-check
  // settling and this guard (GH #111 F6).
  setDoneBusy(cardId, true, skipReview);
  try {
    const result = await builderDone(workspaceId, cardId, skipReview, check);
    // G4: Build done ends the hold a "Not right" sent to the Builder put on.
    useBuilder.setState((s) => {
      const changesSent = { ...s.changesSent };
      delete changesSent[cardId];
      return { doneAt: { ...s.doneAt, [cardId]: Date.now() }, changesSent };
    });
    const { snapshot: snap, newSnapshot, reselected } = result;
    if (!newSnapshot && !reselected) {
      // Unchanged tree: it is already this snapshot, verified and
      // reviewed as such. Record nothing twice; re-run nothing — except
      // that with Skip review a standing changes-requested verdict is
      // overridden (the human accepted the Builder's pushback).
      // U15: with the session closed the live entry is gone; the card knows.
      const onCard = cardInWorkspace(useKanban.getState().byWorkspace, workspaceId, cardId)?.builder;
      const live = useBuilder.getState().byCard[cardId];
      pushToast(
        noNewSnapshotToast(
          result,
          result.reviewOverridden && (await noChecksIn(workspaceId)),
          VENDOR_NAME[live?.vendor ?? (onCard?.vendor === "codex" ? "codex" : "claude")],
          !live?.ptyId && !onCard?.ptyId,
        ),
      );
      if (result.reviewOverridden) {
        useBuilder.getState().inject(cardId, pushbackAcceptedMessage(snap.n));
      }
      if (result.reviewOverridden || result.waitingDropped || result.waitingStarted != null || check) {
        await useKanban.getState().loadFromDisk(workspaceId, true);
      }
      return result;
    }
    // Walk 8.3: a new snapshot is new work; a merge's old refusal goes.
    if (newSnapshot) cardWorkChanged(workspaceId, cardId);
    const lead = selfCheckLead(check?.outcome ?? null);
    // 1.168.1 B3: with no checks set up, none run — the Builder is told so.
    const noChecks = await noChecksIn(workspaceId);
    useBuilder.getState().inject(
      cardId,
      (reselected
        ? `[Plyloft] ${lead}Finish and check: the tree is back at snapshot ${snap.n} (${snap.sha.slice(0, 8)}), which is current again. `
        : `[Plyloft] ${lead}Finish and check: snapshot ${snap.n} committed (${snap.sha.slice(0, 8)}). `) +
        (noChecks ? "No checks are set up for this project, so none run on that snapshot" : "Verification is running on that snapshot now") +
        (skipReview
          ? ""
          : result.reviewWaitingOn != null
            ? // GH #124: one review per card at a time.
              `; the Reviewer (the other AI, read-only) reviews it once its review of ${result.reviewWaitingOn > 0 ? `snapshot ${result.reviewWaitingOn}` : "the earlier snapshot"} ends`
            : " and the Reviewer (the other AI, read-only) is reviewing it") +
        (noChecks && skipReview ? "." : " — please do not edit files until the results arrive here."),
    );
    await useKanban.getState().loadFromDisk(workspaceId, true);
    await useVerify.getState().start({ workspaceId, cardId });
    buildDoneToast(result, noChecks);
    return result;
  } catch (e) {
    reportFailure(useBuilder.setState, cardId, FINISH_LABEL, e);
    throw e;
  } finally {
    setDoneBusy(cardId, false);
  }
}

/** GH #135: the card's `Skip review` for the Build done now running, and
 *  cleared — every Build done that reads it consumes it. */
function takeSkipReview(cardId: string): { skipped: boolean } {
  let skipped = false;
  useBuilder.setState((s) => {
    const taken = consumeSkipReview(s.skipReviewPref, cardId, "build-done");
    skipped = taken.skipped;
    return { skipReviewPref: taken.prefs };
  });
  return { skipped };
}

function setDoneBusy(cardId: string, busy: boolean, withoutReview = false): void {
  useBuilder.setState((s) => {
    const next = { ...s.doneBusy };
    const skipping = { ...s.doneWithoutReview };
    if (busy) next[cardId] = true;
    else delete next[cardId];
    if (busy && withoutReview) skipping[cardId] = true;
    else delete skipping[cardId];
    return { doneBusy: next, doneWithoutReview: skipping };
  });
}

/** ADR 0006 (third card): the self-check flow's effects, wired to this
 *  store, the backend and the toasts. `onFinished` sees Build done's
 *  result when the flow finishes it. */
/** Exported for its tests. */
export function selfCheckDeps(onFinished?: (result: BuildDone) => void): SelfCheckDeps {
  return {
    now: () => Date.now(),
    timeoutMs: SELF_CHECK_TIMEOUT_SECS * 1000,
    getRun: (cardId) => useBuilder.getState().selfCheck[cardId],
    setRun: (cardId, run) =>
      useBuilder.setState((s) => {
        const next = { ...s.selfCheck };
        if (run) next[cardId] = run;
        else {
          // E2 (round 2, Challenger 4): the run is settled — its "told once"
          // goes with it.
          const old = s.selfCheck[cardId];
          if (old) selfCheckToldScreen.delete(old.token);
          delete next[cardId];
        }
        return { selfCheck: next };
      }),
    sessionAlive: (cardId) => Boolean(useBuilder.getState().byCard[cardId]),
    message: (workspaceId, cardId, token) => builderSelfCheckMessage(workspaceId, cardId, token),
    // The self-check never enters the general pending queue: it waits in
    // its run, and `deliverSelfCheck` writes it when a scan (the card's
    // terminal or the observer) finds the turn over.
    send: (cardId) => deliverSelfCheck(cardId),
    unsend: (cardId, text) =>
      useBuilder.setState((s) => {
        const rt = s.byCard[cardId];
        if (!rt) return s;
        return {
          byCard: { ...s.byCard, [cardId]: { ...rt, pending: withoutMessage(rt.pending, text) } },
        };
      }),
    token: () => selfCheckToken(),
    busy: (cardId) => Boolean(useBuilder.getState().doneBusy[cardId]),
    observe: async (cardId) => {
      let backend: number | null = null;
      // Windows (group B walk): the PTY reader stamps every byte, and on
      // ConPTY an idle Claude prints bytes on each focus change, mouse report
      // and resize. While the card's terminal is attached it stamps only what
      // changed its screen (`lib/screenChange.ts`), and that is the stamp to
      // go by. Unattached nothing delivers or completes anyway; the Mac reads
      // both, as before.
      const screenStamped = stampsOnScreenChange(isWindows()) && isBuilderObserved(cardId);
      if (!screenStamped) {
        try {
          backend = await builderLastOutputAt(cardId);
        } catch {
          // The terminal's own stamps still count.
        }
      }
      const rt = useBuilder.getState().byCard[cardId];
      const last = Math.max(rt?.lastOutputAt ?? 0, backend ?? 0);
      return {
        lastOutputAt: last > 0 ? last : null,
        turnIdle: rt?.turnIdle,
        promptScanAt: promptScanAt.get(cardId) ?? null,
        completionSeen: completionSeen.get(cardId) === true,
        observed: isBuilderObserved(cardId),
      };
    },
    finish: async (workspaceId, cardId, check) => {
      endSelfCheckWatch(cardId);
      const result = await finishDone(workspaceId, cardId, check);
      onFinished?.(result);
      return result;
    },
    notify: (kind, title, body, details) => pushToast({ kind, title, body, details }),
    ai: (cardId) => {
      const vendor =
        useBuilder.getState().byCard[cardId]?.vendor ??
        Object.values(useKanban.getState().byWorkspace)
          .flatMap((w) => w?.cards ?? [])
          .find((c) => c.id === cardId)?.builder?.vendor;
      return vendor === "codex" ? "Codex" : "Claude";
    },
  };
}

/** Cards whose tick is waiting on the backend: a slow read never stacks. */
const ticking = new Set<string>();

/** GH #111 F2: whether the running self-check's completion line is on the
 *  Builder's screen, from the observer's scans. */
const completionSeen = new Map<string, boolean>();
/** 1.172.0 E2: self-check runs (by token) whose Codex-screen trouble was
 *  already told, so a tick that keeps finding the search open says it once. */
const selfCheckToldScreen = new Set<string>();
/** Cards whose self-check is being written into the PTY. */
const delivering = new Set<string>();

/** Write the waiting self-check into the Builder — `tickSelfCheck` has
 *  checked the turn is over (`canDeliver`). True once the write succeeded
 *  (or, E2, left it in Codex's composer unsent); the flow stamps the
 *  delivery. Exported for its tests. */
export async function deliverSelfCheck(cardId: string): Promise<boolean> {
  const run = useBuilder.getState().selfCheck[cardId];
  const rt = useBuilder.getState().byCard[cardId];
  if (!run || run.deliveredAt != null || !rt || delivering.has(cardId)) return false;
  // 1.174.5: it waits for what the person typed; the next tick asks again.
  if (draftInTheWay(cardId, rt)) return false;
  // 1.175.0 F5 round 2: nor into a question on screen — a trust or
  // permission prompt, a usage limit, an approval — at the moment it types
  // (a check Plyloft started runs with nobody watching); the next tick asks again.
  const s = useBuilder.getState();
  if (rt.questionInView === true || s.trustAsking[cardId] || s.sessionBlocks[cardId]) return false;
  delivering.add(cardId);
  try {
    await writePaste(rt.ptyId, run.message);
    return true;
  } catch (e) {
    console.warn("builder: self-check delivery failed", e);
    const why = e instanceof Error ? e.message : "";
    // 1.172.0 E2: Codex's search or message box kept it — said once per
    // self-check, in the card's toast, with what to do.
    // The self-check has no press: it is typed in again by itself once the
    // search is closed (the scan reads no prompt while it is open).
    const help =
      why === OVERLAY_TOOK_PASTE
        ? `${OVERLAY_TOOK_PASTE} Press Esc in the session to close the search and clear Codex's message box first: Plyloft types it in again once the session has been quiet for a few seconds.`
        : codexScreenHelp(why, isCodexOverlayError(why));
    if (help && !selfCheckToldScreen.has(run.token)) {
      selfCheckToldScreen.add(run.token);
      pushToast({ kind: "warn", title: "Re-reading didn't reach the Builder", body: help });
    }
    // (Challenger 2) Left in the composer unsent: it is there — no retry
    // pastes or presses on top of it; the person's Enter sends it, and the
    // check goes on as for a delivered message (Skip and the timeout stand).
    return why === PASTE_STILL_UNSENT;
  } finally {
    delivering.delete(cardId);
  }
}

/** Cards whose live terminal (`BuilderSession`) is attached now. Only its
 *  scans deliver or complete a self-check; unobserved, the check waits for
 *  Skip or the timeout (GH #111, the owner's conservative rule). */
const observedHosts = new Map<string, number>();
/** Counted, not a flag: two hosts of one card can overlap (StrictMode's
 *  double mount, a re-attach), and the first to go must not unobserve the
 *  one still mounted. */
export function isBuilderObserved(cardId: string): boolean {
  return (observedHosts.get(cardId) ?? 0) > 0;
}

/** The card's terminal attached (true) or went away (false). */
export function setBuilderObserved(cardId: string, observed: boolean): void {
  const count = (observedHosts.get(cardId) ?? 0) + (observed ? 1 : -1);
  if (count > 0) observedHosts.set(cardId, count);
  else observedHosts.delete(cardId);
}

/** The running self-check wants the whole screen scanned for its
 *  completion line: its token, or null when none runs. */
export function selfCheckTokenFor(cardId: string): string | null {
  return useBuilder.getState().selfCheck[cardId]?.token ?? null;
}

/** The live terminal's scan of its whole buffer, for the completion line. */
export function markSelfCheckScreen(cardId: string, screen: string): void {
  const token = selfCheckTokenFor(cardId);
  if (token) completionSeen.set(cardId, seesCompletion(screen, token));
}

function startSelfCheckWatch(cardId: string): void {
  completionSeen.delete(cardId);
  startSelfCheckTimer(cardId);
}

function endSelfCheckWatch(cardId: string): void {
  stopSelfCheckTimer(cardId);
  completionSeen.delete(cardId);
}

function startSelfCheckTimer(cardId: string): void {
  stopSelfCheckTimer(cardId);
  selfCheckTimers.set(
    cardId,
    setInterval(() => {
      if (ticking.has(cardId)) return;
      ticking.add(cardId);
      void tickSelfCheck(selfCheckDeps(), cardId)
        .then((step) => {
          if (step !== "wait") endSelfCheckWatch(cardId);
        })
        .finally(() => ticking.delete(cardId));
    }, SELF_CHECK_TICK_MS),
  );
}

/** 1.175.0 F5: note (`kind`) or clear (null) the fix round Plyloft sent a
 *  card's Builder, into the session `ptyId` (the attached one when left out). */
export function noteFixRoundSent(cardId: string, kind: "findings" | "checks" | "pr" | null, ptyId?: string, key?: string): void {
  useBuilder.setState((s) => {
    const pty = ptyId ?? s.byCard[cardId]?.ptyId;
    const was = s.fixRoundSent[cardId];
    if (key && was?.key === key && was.ptyId === pty) return s;
    const next = { ...s.fixRoundSent };
    if (kind && pty) next[cardId] = { kind, ptyId: pty, at: Date.now(), ...(key ? { key } : {}) };
    else delete next[cardId];
    return { fixRoundSent: next };
  });
}

/** GH #135: what `lib/verdictDelivery.ts` needs of this store, the card
 *  and the backend. The coordinator holds the rules; this holds nothing
 *  but the wiring, so the rules are unit-tested without Tauri. */
function verdictDeps(workspaceId: string, cardId: string): VerdictDeliveryDeps {
  return {
    // Read from the card every time: the coordinator re-reads inside its
    // own guard, so a verdict superseded (or overridden) since the render
    // that offered the send is simply no longer owed.
    owed: () => {
      const card = cardInWorkspace(useKanban.getState().byWorkspace, workspaceId, cardId);
      return verdictOwed(card?.builder, useBuilder.getState().verdictDelivery[cardId], Boolean(card?.prReview));
    },
    // Only the session the card itself names. On a resume the attached
    // terminal can be the new PTY while the card still carries the old
    // one, and `verdictOwed` matches a delivery against the card's: a
    // write recorded against the other would look, once the card caught
    // up, like a session that already had a verdict it never got.
    session: () => {
      const rt = useBuilder.getState().byCard[cardId];
      const onCard = cardInWorkspace(useKanban.getState().byWorkspace, workspaceId, cardId)?.builder
        ?.ptyId;
      if (!rt || !onCard || rt.ptyId !== onCard) return null;
      // 1.172.0 E2: Codex's transcript search open over the composer is
      // not a prompt to type into — the verdict waits until it is closed.
      return { ptyId: rt.ptyId, idle: rt.promptBoxIdle === true && overlayOpenNow(cardId) !== true && !draftInTheWay(cardId, rt), draft: rt.composerDraft === true };
    },
    write: (ptyId, text) => writePaste(ptyId, text),
    acknowledge: async (snapshotN, at) => {
      await builderVerdictDelivered(workspaceId, cardId, snapshotN, at);
      await useKanban.getState().loadFromDisk(workspaceId, true);
    },
    record: (delivery) => {
      useBuilder.setState((s) => ({
        verdictDelivery: { ...s.verdictDelivery, [cardId]: delivery },
      }));
      // 1.175.0 F5: the Reviewer's findings, written into the session.
      // Recorded again as it is acknowledged: noted once per review.
      if (delivery.state === "sent") noteFixRoundSent(cardId, "findings", delivery.ptyId, `findings:${delivery.at}`);
      // GH #135 (owner-side review, F2): the retry is scheduled, not left
      // to the card's renders — a Builder that has gone quiet causes none.
      scheduleVerdictAck(cardId, verdictDeps(workspaceId, cardId), verdictAckTimers);
    },
    notify: (kind, title, body) => pushToast({ kind, title, body }),
    now: () => Date.now(),
  };
}

/** `lib/verdictDelivery.ts`'s bookings, on real timers. The schedule is
 *  the coordinator's; this is only the clock it runs on. */
const running = new Map<string, ReturnType<typeof setTimeout>>();
const verdictAckTimers: VerdictAckTimers = {
  set: (cardId, delayMs, fire) => {
    verdictAckTimers.clear(cardId);
    running.set(
      cardId,
      setTimeout(() => {
        running.delete(cardId);
        fire();
      }, delayMs),
    );
  },
  clear: (cardId) => {
    const timer = running.get(cardId);
    if (timer != null) clearTimeout(timer);
    running.delete(cardId);
  },
};

/** GH #129: one `Back to the Builder` delivery, reported as it goes. */
async function sendHandedOverOnce(
  cardId: string,
  owed: HandedOverOwed,
): Promise<"queued" | "sent" | "failed" | null> {
  const what =
    owed.findingIds.length > 0
      ? // 1.171.0 C2 (CF10): no snapshot or round numbers on screen.
        `The open findings (${owed.findingIds.join(", ")})`
      : "The changes the review asked for";
  const outcome = await deliverHandedOver(owed.message, owed.handedOverAt, {
    session: () => {
      const rt = useBuilder.getState().byCard[cardId];
      return rt ? { ptyId: rt.ptyId, idle: rt.promptBoxIdle === true && !draftInTheWay(cardId, rt) } : null;
    },
    write: (ptyId, text) => writePaste(ptyId, text),
    queue: (text) => {
      const waited = heldWaiters.wait(cardId);
      useBuilder.setState((s) => {
        const cur = s.byCard[cardId];
        if (!cur) return s;
        return { byCard: { ...s.byCard, [cardId]: { ...cur, pending: [...cur.pending, text] } } };
      });
      if (!useBuilder.getState().byCard[cardId]) heldWaiters.take(cardId)(new Error(SESSION_ENDED_ERROR));
      // As `deliverWhenIdle`: the valve watches what is held.
      else startHeldValve(cardId);
      return waited;
    },
    report: (delivery) => {
      useBuilder.setState((s) => ({ handedOverDelivery: { ...s.handedOverDelivery, [cardId]: delivery } }));
      if (delivery.state === "queued") {
        pushToast({
          kind: "info",
          title: "Queued for the Builder",
          body: `${what} go in when the Builder is back at its prompt.`,
        });
      } else if (delivery.state === "sent") {
        pushToast({ kind: "info", title: "Sent to the Builder", body: `${what}.` });
      } else {
        pushToast({
          kind: "error",
          title: "The findings did not reach the Builder",
          body: `${delivery.error ?? ""} Press Back to the Builder to send them again.`.trim(),
        });
      }
    },
  });
  if (outcome === null) {
    pushToast({
      kind: "warn",
      title: "The Builder session is not open",
      body: "Resume its session on the card, then press Back to the Builder again.",
    });
  }
  return outcome;
}

/** PR #347 walk: drop the runtime of every Builder session that is gone —
 *  closed from the card, or ended while its terminal was not mounted (its
 *  exit listener does it otherwise). The card's live `ptyId` is the truth
 *  (`lib/needsYou.ts` `builderSessionGone`). Returns the keys dropped.
 *
 *  Challenger minor: two forced board reloads that resolve out of order can
 *  show a card without its current session for a moment, and dropping the
 *  runtime rejects its held messages. So a runtime goes only when it was
 *  seen gone on the previous call too (the tick is a second apart) — or at
 *  once for `closedCardId`, the card whose session was just closed. */
let seenGone = new Map<string, string>();
export function dropEndedBuilderSessions(closedCardId?: string): string[] {
  const boards = useKanban.getState().byWorkspace;
  const card = (ws: string, id: string) => boards[ws]?.cards.find((c) => c.id === id) ?? null;
  const loaded = (ws: string) => boards[ws]?.loaded === true;
  const nowGone = new Map<string, string>();
  const drop: [string, string][] = [];
  for (const [key, rt] of Object.entries(useBuilder.getState().byCard)) {
    if (!builderSessionGone(key, rt, card, loaded)) continue;
    const closed = closedCardId != null && cardIdOfSessionKey(key) === closedCardId;
    if (closed || seenGone.get(key) === rt.ptyId) drop.push([key, rt.ptyId]);
    else nowGone.set(key, rt.ptyId);
  }
  seenGone = nowGone;
  for (const [key, ptyId] of drop) useBuilder.getState().detach(key, ptyId);
  return drop.map(([key]) => key);
}

/** UX P-F (was `pollTrustQuestions`, v1.154.1 walk G1): ask the backend
 *  which live Builder sessions are stopped where only the person can move
 *  them on — the folder-trust question, Claude's Bypass Permissions warning,
 *  its usage limit — only while some card has a live session. Never answers
 *  any of them. A failed read keeps what was known. */
let blockPollAt = 0;
export async function pollSessionBlocks(now: number, everyMs = 2_000): Promise<void> {
  if (now - blockPollAt < everyMs) return;
  blockPollAt = now;
  const cards = Object.values(useKanban.getState().byWorkspace).flatMap((b) => b?.cards ?? []);
  if (!anyLiveBuilder(cards)) {
    useBuilder.getState().setTrustAsking({});
    useBuilder.getState().setSessionBlocks({});
    forgetScreens();
    return;
  }
  await Promise.all([
    (async () => {
      try {
        const list = await builderSessionBlocks();
        useBuilder.getState().setTrustAsking(trustAskingFrom(list));
        useBuilder.getState().setSessionBlocks(sessionBlocksFrom(list));
      } catch {
        // The next tick asks again.
      }
    })(),
    refreshBuilderScreens(),
  ]);
}

/** 1.176.2 (A5F-01, review M1): the screens of the live Builder sessions no
 *  terminal of this window shows, by session key, as the backend last drew
 *  them (`builderSessionScreens`). A runtime outlives its card's terminal,
 *  and only that terminal reads its screen: without these a Builder at work
 *  on a card not shown read as quiet after 10 s, and the quit guard and the
 *  scheduled update went over its turn. Judged by `builderScreenState.ts`.
 *  In memory; replaced whole by each read, kept as it was by a failed one. */
let screens = new Map<string, BuilderSessionScreen>();
/** The read under way, joined by any asked meanwhile (review F3), unless it
 *  has gone unanswered for `SCREENS_READ_STALE_MS`. */
let screensRead: { at: number; promise: Promise<boolean> } | null = null;
const SCREENS_READ_STALE_MS = 10_000;
/** Reads are numbered: an older answer never replaces a newer one. */
let screensReadNo = 0;
let screensReadFailing = false;
let screensShownNo = 0;

function forgetScreens(): void {
  screens = new Map();
  screensShownNo = screensReadNo;
}

/** The last screen read of `key`'s session, unless a terminal here shows it. */
export function builderScreenOf(key: string): BuilderSessionScreen | null {
  return screens.get(key) ?? null;
}

/** Every session's last screen read (sessions no terminal here showed). */
export function builderScreens(): ReadonlyMap<string, BuilderSessionScreen> {
  return screens;
}

/** Read the screens again: one call for every session, one at a time
 *  (review F3: a slow read is joined, never overtaken by an older answer).
 *  True when the read went through. */
export function refreshBuilderScreens(): Promise<boolean> {
  const now = Date.now();
  if (screensRead && now - screensRead.at < SCREENS_READ_STALE_MS) return screensRead.promise;
  const no = ++screensReadNo;
  const promise = builderSessionScreens([...observedHosts.keys()]).then(
    (list) => {
      if (no > screensShownNo) {
        screensShownNo = no;
        screens = new Map(list.map((s) => [s.key, s]));
      }
      return true;
    },
    (e) => {
      // 1.176.2 (S1): said once per run of failures.
      if (!screensReadFailing) console.warn("builder: the off-screen Builders couldn't be read", e);
      screensReadFailing = true;
      return false;
    },
  );
  void promise.then((ok) => {
    if (ok) screensReadFailing = false;
  });
  screensRead = { at: now, promise };
  void promise.finally(() => {
    if (screensRead?.promise === promise) screensRead = null;
  });
  return promise;
}

/** 1.176.4 (review): the last read of the off-screen Builders failed — the
 *  update's line then counts each as at work, as the idle look does. */
export function builderScreensReadFailing(): boolean {
  return screensReadFailing;
}

/** No card has a live Builder session: nothing to read (and nothing kept).
 *  Lets a quit with no Builder answer at once, as before. */
export function noBuilderScreensToRead(): boolean {
  const cards = Object.values(useKanban.getState().byWorkspace).flatMap((b) => b?.cards ?? []);
  if (anyLiveBuilder(cards)) return false;
  forgetScreens();
  return true;
}

/** Review F1: before a quit or the scheduled update answers, the screens
 *  read now — the poll slows to 5 s with the window hidden. False when the
 *  read failed or took longer than `timeoutMs`: the caller counts every
 *  session no terminal shows as at work. */
export async function freshBuilderScreens(timeoutMs = 1_500): Promise<boolean> {
  if (noBuilderScreensToRead()) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  // F1 review round 3 (S3): a read already under way may have left before
  // a Builder just started: a new one goes after it.
  const read = (async () => {
    if (screensRead) await screensRead.promise;
    return refreshBuilderScreens();
  })();
  try {
    return await Promise.race([read, late]);
  } finally {
    clearTimeout(timer);
  }
}

// ── G4: the Builder writes the pull request ─────────────────────────────

/** G4: before Ship opens the card's pull request, ask its live Builder for
 *  the title and description and wait for them (at most 90 s, never a
 *  dialog). Only into a session at its idle prompt with nothing asked or
 *  held; otherwise Ship goes on with the template at once. Resolves when
 *  Ship may go on — `card_ship` reads the draft itself. */
/** U25: mark or clear the question left from a draft. */
function setDraftQuestion(cardId: string, on: boolean): void {
  useBuilder.setState((s) => {
    const cur = s.byCard[cardId];
    return cur && (cur.draftQuestion === true) !== on
      ? { byCard: { ...s.byCard, [cardId]: { ...cur, draftQuestion: on } } }
      : s;
  });
}

export async function draftPullRequestFor(
  workspaceId: string,
  cardId: string,
  mode: ShipMode,
): Promise<PrDraftOutcome> {
  let toast: string | null = null;
  let asked = false;
  const outcome = await draftPullRequest({
    idleSession: async () => {
      const s = useBuilder.getState();
      const rt = s.byCard[cardId];
      const onCard = cardInWorkspace(useKanban.getState().byWorkspace, workspaceId, cardId)?.builder?.ptyId;
      if (!rt || !onCard || rt.ptyId !== onCard) return null;
      if (rt.pending.length > 0 || rt.composerEscaped === true || draftInTheWay(cardId, rt) || rt.questionInView === true) return null;
      if (s.selfCheck[cardId] || s.fixBusy[cardId] || s.trustAsking[cardId] || s.sessionBlocks[cardId]) return null;
      // The self-check's own rule for writing into a session: the live
      // terminal's fresh scan shows the turn over, after 10 s of silence.
      const seen = await selfCheckDeps().observe(cardId);
      return canDeliver(seen, Date.now()) ? rt.ptyId : null;
    },
    prepare: () => cardPrDraftPrepare(workspaceId, cardId, mode),
    // 1.174.5: keys typed since the gate above: nothing joins them.
    write: (ptyId, text) =>
      builderDraftInTheWay(cardId) ? Promise.reject(new Error("the person is typing in the session")) : writePaste(ptyId, text),
    read: () => cardPrDraftRead(workspaceId, cardId),
    sessionAlive: (ptyId) => useBuilder.getState().byCard[cardId]?.ptyId === ptyId,
    turnStartedSince: (since) =>
      isBuilderObserved(cardId) ? (turnBusySeenAt.get(cardId) ?? 0) > since : null,
    forget: (requestId) => cardPrDraftForget(workspaceId, cardId, requestId),
    turnOverSince: (since) => {
      const rt = useBuilder.getState().byCard[cardId];
      return rt?.turnIdleSettled === true && (rt.turnIdleAt ?? 0) > since && rt.questionInView !== true;
    },
    writing: (on) => {
      useBuilder.setState((s) => {
        const next = { ...s.prDraftWriting };
        if (on) next[cardId] = true;
        else delete next[cardId];
        return { prDraftWriting: next };
      });
      // Challenger 11: the status line says it is being written; the toast
      // only what follows.
      if (on) asked = true;
      if (on) toast = pushToast({ kind: "info", title: PR_DRAFT_TOAST });
      else if (toast) dismissToast(toast);
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  // U25: only a question that came after the draft was asked for; one already
  // on screen stopped the asking and still comes first.
  if (questionLeftByDraft(asked, outcome.kind, useBuilder.getState().byCard[cardId]?.questionInView)) {
    setDraftQuestion(cardId, true);
  }
  if (outcome.kind === "template") {
    const line = `builder: ${cardId}: the pull request uses Plyloft's description (${outcome.why})`;
    // Challenger 9: a message that sat unsent is logged as such.
    if (outcome.why.startsWith("not submitted")) console.warn(line);
    else console.info(line);
  }
  return outcome;
}
