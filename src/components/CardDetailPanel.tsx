import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { usePlanner } from "./usePlanner";
import {
  useKanban,
  type KanbanCard,
} from "../store/kanbanStore";
import { useSwarms } from "../store/swarmStore";
import { LinkedBrainstormBanner } from "./LinkedBrainstormBanner";
import { useCardArea } from "../store/cardAreaStore";
import { WhenItMerges } from "./WhenItMerges";
import {
  AREAS_SETTINGS_SECTION,
  AREA_LABEL,
  areaChoiceStart,
  areaChoices,
  areaFilesHint,
  areaSetLine,
  AREA_START_STOP_LABEL,
  nowAreaAsk,
  startingInAreaLabel,
} from "../lib/cardArea";
import { effectiveCenterMode, openCenterMode, openProjectSetUp, useUi } from "../store/uiStore";
import { GITHUB_ACCOUNTS_PAGE, GITHUB_ACCOUNTS_ROW, GITHUB_SIGN_IN_ACTION, OPEN_ON_GITHUB_ACTION } from "../lib/plainError";
import { cardDeliveryPath, shipTargetOf } from "../lib/deliveryStage";
import {
  FINISH_CLOSED_SESSION_HINT,
  FINISH_WITHOUT_REVIEW_HINT,
  FINISH_WITHOUT_REVIEW_LABEL,
  LEAVE_LINE,
  SHIP_ANYWAY_LABEL,
  SHIP_WITHOUT_CHANGES_LABEL,
  SHIP_WITHOUT_CHANGES_TITLE,
  agreeWithBuilderLabel,
  agreeWithBuilderTitle,
  liveSentence,
  shipItSentence,
  shipAnywaySentence,
  checksRunningWithoutReviewSentence,
} from "../lib/deliveryWords";
import { APP_STARTED_AT } from "../lib/appStartedAt";
import { useIntake } from "../store/intakeStore";
import { useWorkspaces } from "../store/workspaceStore";
import { usePrAutoFix } from "../store/prAutoFixStore";
import { autoFixDefaultSince, autoFixOn, autoFixStoppedNow } from "../lib/prAutoFix";
import { allowChecksAndRun, ChecksConsentNow } from "./ChecksConsentNow";
import { UnattendedAsksNote } from "./UnattendedAsksNote";
import { useTeamAllowed } from "../store/accountStore";
import { openPlanSettings } from "../store/planPrompts";
import { useVerify } from "../store/verifyStore";
import {
  EMPTY_COORDINATION_STATUS,
  useCoordination,
} from "../store/coordinationStore";
import { pushToast } from "../store/toastStore";
import { deferCardRemoval, useBoard } from "../store/boardStore";
import { EMPTY_ARRAY } from "../lib/empties";
import { changesRoute, notRightWords } from "../lib/reviewChanges";
import { confirmSheet } from "../store/confirmStore";
import { finishAndCheck } from "../store/finishAndCheck";
import { TermHelp } from "./GlossaryText";
import { BuildBothStartSheet } from "./BuildBothStartSheet";
import {
  type CardPatch,
} from "../ipc";
import {
  githubCardWriteBlocked,
  TEAM_BOARD_READ_ONLY_MESSAGE,
} from "../lib/teamGateCardWrites";
import { RunHistoryAccordion } from "./KanbanRunHistory";
import {
  OutcomeScreen,
  type OutcomeDiffOffer,
  type OutcomePresentationSummary,
  type ShipRunner,
} from "./OutcomeScreen";
import { CardReviewPanel } from "./CardReviewPanel";
import { LaterRequests } from "./LaterRequests";
import { IntakeHistorySection, IntakePlan } from "./IntakeHistorySection";
import { IntakeConversation } from "./IntakeConversation";
import { ChatPanel } from "./ChatPanel";
import { FollowUpSheet } from "./FollowUpSheet";
import {
  ASK_ABOUT_CARD_LABEL,
  chatBuilderReach,
  TELL_BUILDER_KEY,
  TELL_BUILDER_SENT,
  tellBuilderMessage,
} from "../lib/chatView";
import { chatKey, useChat } from "../store/chatStore";
import { formRequestFresh, usePlanExchange } from "../store/planExchangeStore";
import { PLAN_TWO_AIS_LABEL, planChallengeOfferedOn, planTwoAisOffered } from "../lib/planExchangeView";
import { DiscussionModal } from "./DiscussionModal";
import { useCardDelete } from "./CardDeleteDialog";
import { CardClaimControl, useCardClaim, useClaimLogin, useOtherDeviceWords } from "./CardClaimChip";
import { CardTechnicalDetails, OPEN_WORKTREE_TERMINAL_LABEL, openWorktreeTerminal } from "./CardTechnicalDetails";
import { LinkedPullRequestList, useLinkedPullRequests } from "./LinkedPullRequests";
import { buildBothNow, buildBothOffer, isUndecided, laneKey } from "../lib/buildBoth";
import { cardActor } from "../lib/sessionActor";
import { refreshSkillCard, useSkillCardBehind } from "./useSkillCardBehind";
import { intakeSweptReason } from "../lib/intakeStopped";
import {
  cardInWorkspace,
  claimMenuLabel,
  hasLocalRun,
  notStarted,
  ownNameComesOff,
  startBuildClaimTitle,
  mergedPrLine,
  teammatePrLine,
} from "../lib/cardClaim";
import {
  boundedStartApplies,
  guidedStartApplies,
  guidedStartSentence,
  guideShownOn,
} from "../lib/firstCardGuide";
import { useBuildBoth } from "../store/buildBothStore";
import { useSettingUp } from "../lib/autoSetUp";
import { useDoctor } from "../store/doctorStore";
import { intakeVendorFor, vendorReadiness } from "../lib/vendorReadiness";
import { CardRunStep } from "./CardRunStep";
import { PrReviewPanel } from "./PrReviewPanel";
import { keepShownPermissions, settleWorktreeSetup } from "./BuilderRunStep";
import { bothPermissionsLabel, builderPermissionsLabel, cardPermissionsChoice } from "../lib/builderPermissions";
import { briefSetupLine, briefSetupMore, factsBeforeBuild } from "../lib/briefSetup";
import { CardPickers } from "./CardPickers";
import { BriefMoreDetail, BriefPlan, BriefSetupLine } from "./CardBrief";
import { draftHoldNotice, useBuilder } from "../store/builderStore";
import { useSettings } from "../store/settingsStore";
import { PlanChallengePanel } from "./PlanChallengePanel";
import { CardMore, CardPageDropLabel, useCardFileIngest, useCardPageDrop } from "./CardMore";
import { cardBriefText, cardLocalBaseCommits, openWebLink } from "../ipc";
import { useCopyChanges } from "../hooks/useCopyChanges";
import { kanbanCardDeviceRelease, sayArchiveNameKept, sayMovedBack, sayStartStopped } from "../lib/leaveCard";
import { teammateWork } from "../lib/teammateWork";
import { HiddenParts, withOutsideNote } from "./IssueTextNotes";
import { EditConflictNotice } from "./EditConflictNotice";
import { BRIEF_ASKED_LINE, editConflictOf } from "../lib/editConflict";
import { issueByline, outsideAuthor } from "../lib/issueText";
import { cardAreaOf } from "../lib/areaPicker";
import { openRelease } from "../store/projectRelease";
import { CardProposalLine, CardShipStep, type PrActions } from "./CardShipStep";
import { githubChecksFact, prOpen } from "../lib/prStatus";
import { BRIEF_FIX_HINT, FIX_SENT_LABEL, briefFixOffered, prFixRoundLine } from "../lib/prFix";
import {
  SEND_AGAIN_LABEL,
  SHIP_AGAIN_LABEL,
  LEAVE_OUT_TITLE,
  UNDO_MERGE_LABEL,
  UNDO_MERGE_TITLE,
  CONFLICT_FIX_ACTION,
  askBuilderOffered,
  conflictMergeStarted,
  leaveOutLabel,
  shipConflictOf,
} from "../lib/shipConflict";
import { ShipConflictFiles } from "./ShipConflictDetails";
import { cardErrorNow, detailsSummary, type CardTroubleKind } from "../lib/cardErrorNow";
import { ShipRefusalBlocks, ToLookAt, builderErrorUx, nowErrorView, withConflictFix, type Trouble } from "./CardTroubles";
import { TargetSyncLine } from "./TargetSyncLine";
import { useTargetSync } from "../store/targetSyncStore";
import { KeptCopyLine } from "./KeptCopyLine";
import { prStatusWord, reviewOnly } from "../lib/prReview";
import { FirstCardGuide } from "./FirstCardGuide";
import { CardStateHeader, type SecondaryAction } from "./CardStateHeader";
import { fixRoundSecondary } from "./fixRoundNow";
import { CardNowNote } from "./CardNowNote";
import type { TourAnchor } from "../lib/tutorial/manifest";
import { focusBrief, focusFollowUpBrief, takeBriefFocus } from "./followUpFocus";
import {
  FOLLOW_UP_ASK_EMPTY,
  FOLLOW_UP_LABEL,
  FOLLOW_UP_TITLE,
  cardIsDone,
  doneBriefLine,
  existingFollowUpWords,
  sentBriefLine,
  followLinkTitle,
  followUpAskEmpty,
  followUpAskLeft,
  followUpDraft,
  followUpOffered as followUpCardIsOffered,
  openFollowUp,
} from "../lib/followUp";
import { BuildBothCards } from "./BuildBothStep";
import { ModeHeader } from "./ModeHeader";
import {
  cardMoreMenu,
  nowPressLabels,
  runHistoryShown,
  type CardMoreAction,
  type CardMoreEntry,
  type CardMoreGroup,
} from "../lib/cardMoreMenu";
import {
  CBtn,
  Callout,
  Select,
  Details,
  ErrorBlock,
  Icon,
  MoreMenu,
  Page,
  Properties,
  SplitButton,
  StateWord,
  Timeline,
  type MenuItem,
  type Property,
  type TimelineEvent,
} from "./ux";
import {
  handedOverOwed,
  handedOverPresentation,
  shipWithFollowUpHelper,
  verdictDetailsNote,
  verdictOwed,
  verdictShownAsWork,
  reviewVerdictKey,
  prShipOffer,
} from "../lib/challengerReview";
import { useReviewTip } from "./useReviewTip";
import {
  cardShippedOrPrOpen,
  challengerRequestedChanges,
  FINISH_BUSY_LABEL,
  FINISH_LABEL,
  planFirstLabel,
  PUT_BACK_OPEN_PR,
  putBackOffered,
  putBackSheet,
  prOpenShipFailure,
  type ShipFailure,
  type ShipPress,
  type CardPrimaryActionId,
  type CardStatePresentation,
  type CardPageSection,
  type CardPagePart,
  archiveToastBody,
  swarmTemplateInUse,
} from "../lib/cardLifecycle";
import { linkDidNotOpen } from "../lib/linkToast";
import { firstSessionOpen, markSessionOpened, sessionFocusNoteHolds, sessionFocusWords } from "../lib/sessionFocus";
import { UnsavedWorkLine } from "./UnsavedWorkLine";
import {
  ALREADY_ARCHIVED_HINT,
  BOARD_ARCHIVE_BLOCKED_COPY,
  BOARD_ARCHIVE_SETUP_COPY,
  RELEASE_ITEM_HINT,
  boardWorkOwnsCard,
  cardSetupRunning,
  releaseOffered,
  setupPresentation,
  ATTENTION_COLUMNS,
  type AttentionColumn,
} from "../lib/boardSemantics";
import { askBuilderToCommit, askBuilderToFixChecks, askBuilderToFixHook, showProjectFiles } from "../store/askBuilderCard";
import { decodeTargetDirtyError } from "../lib/shipPreflight";
import { ASK_BUILDER_FIX_CHECKS_LABEL, askBuilderFixChecksTitle, builderMayCommit, commitStop } from "../lib/checksFix";
import { blockedByShown, dependentsOf, isHeld, startRefusal, unshippedBlockers } from "../lib/cardDependencies";
import { BlockedByValue, BlocksValue } from "./CardDependencies";
import { useCardAreaChoosable, useCardAreaProperty } from "./CardAreaLine";
import { EMPTY_ROLE_MODELS, challengerVendor } from "../lib/roleModels";
import { builderModelFact, challengerModelFact, challengerVendorOf } from "../lib/cardModels";
import { useModelCatalog } from "../store/modelCatalogStore";
import { useTeamModels } from "../store/teamModelsStore";
import { withTeam } from "../lib/workspaceModels";
import { SILENCE_MS, deriveTileAttention } from "../lib/attention";
import { startMayBeLocal, startedLocalLine } from "../lib/worktreeBase";
import type { UxError } from "../lib/uxError";
import {
  builderFact,
  effectiveBuilderVendor,
  startFreshOffer,
  builderVendorChoosable,
  restartPermissionsChoosable,
  roleModelChoosable,
  cardActionError as actionFailedError,
  resumeFoundNothing,
  dependencyRefusedError,
  cardTimeline,
  checksFact,
  checksRowLabels,
  factShown,
  intakeStartError,
  intakeStoppedError,
  intakeConcludeError,
  FINISH_PLANNING_LABEL,
  rawError,
  skillPrLocalRefusal,
  challengerFact,
  runStartedWords,
  checksFailedWords,
  checksRunningWords,
  nowFacts,
  sessionSummary,
  timelineWhen,
  vendorName,
  landedSection,
  shippedReceipt,
  WHY_SKIPPED_LABEL,
  SEE_PULL_REQUEST_LABEL,
  changeChoicesTitle,
  briefFirstLine,
  BRIEF_FOLD_HIDE,
  BRIEF_FOLD_SHOW,
  BRIEF_FOLD_TITLE,
  type TimelineLinkKind,
} from "../lib/cardPage";
import {
  reportInstalledSelfCheckActionTrace,
  type InstalledSelfCheckActionTraceInput,
} from "../lib/installedSelfCheck";
import { machineWords, modOnly } from "../lib/platform";
import { setupIsOpen } from "../store/setupStore";
import { cardLiveFrom, cardLiveSourcesNow, useCardLive } from "../hooks/useCardLive";
import { waitLine } from "../lib/waitLine";
import {
  COPY_BRIEF_EMPTY,
  copyBriefEmpty,
  nowSaysResumeFailed,
  presentCard,
  queueFilterWords,
  reviewSkippedThisRound,
  type OutcomeFacts,
} from "../lib/cardPresentation";
import { copyBriefPlaceholder } from "../lib/copyWords";
import { useCardFacts } from "../store/cardFactsStore";
import { useErrorBlocks } from "../store/errorBlockStore";
import { shipFailureOf, shipRefusedFor } from "../lib/shipRefusal";
import { TryItPanel, TryStartSheetHost, pressTryIt, useTryLane } from "./TryItPanel";
import { TRY_IT_LABEL, TRY_IT_TOUR, tryItOffered } from "../lib/tryPanel";
import {
  CHECK_IT_FIRST_LABEL,
  CHECK_IT_FIRST_TITLE,
  REVIEW_SECTION_TITLE,
  SHIPPED_SECTION_TITLE,
  REVIEW_SHIP_MENU_LABEL,
  SEE_THE_CHECKS_LABEL,
  reviewShipName,
} from "../lib/reviewSection";

/** 1.172.0 C2 (Challenger 2): Read the review moves focus to the Review's
 *  heading; See the checks to its checks. */
const REVIEW_FOCUS = "[data-ply-section-heading]";
const REVIEW_CHECKS_FOCUS = "[data-ply-review-part='checks']";
/** 1.174.0 C5 round 1: where Activity's "Why it was skipped" lands. */
const REVIEW_SKIPPED_FOCUS = "[data-ply-review-part='skipped']";
import { OverlapChip, useOverlapWarnings } from "./OverlapWarnings";
import { useSetup } from "../store/setupStore";
import { pressRunning, shipPressKey } from "../lib/pressOnce";
import {
  GH_INSTALL_ACTION,
  onlyHereHint,
  ONLY_HERE_LABEL,
  SHIP_CHOICE_LABELS,
  SHIP_HERE_ACTION,
  currentShipChoice,
  isShipPress,
  shipAnywayHandedOverTitle,
  shipAnywayTitle,
  shipItGoesToGitHub,
  shipWithoutAutoMergeMode,
  shipPressIsGitHub,
  shipPressMode,
  shipPressOf,
  shipChoiceHint,
  shipChoiceMode,
  shipChoiceRemembers,
  shipChoicesOffered,
  shipPressErrorName,
  shipPressLabel,
  prOpenFailure,
  type ShipMode,
} from "../lib/shipVia";
import { pushErrorToast } from "../lib/errorToast";

type Props = {
  workspaceId: string;
};

/** GH #281: the card's "Clear run history" question, from the runs in More about this card. */
const CLEAR_RUN_HISTORY = {
  title: "Clear all run history for this card?",
  body: "The runs' records go; the card, its copy of the repository and its commits stay.",
  confirmLabel: "Clear",
  destructive: true,
};

/**
 * v1.7.0: per-workspace card-detail surface. Activated when the user clicks
 * a card in the kanban; shows the card's title/notes/knowledge in larger
 * editable fields than the kanban tile allows, plus the existing agent /
 * swarm-template attachments and run history. v1.7.x layers the intake
 * conversation on top; v1.9.x layers the verify-then-ship gate via
 * `VerifyPanel` + the lifecycle pill (the originally-planned "v2 in_review
 * flow" shipped as the verify gate, not as a column).
 *
 * The panel is rendered once per warmed workspace inside RightTabs (warmed-
 * host pattern) — switching workspaces just toggles `.right-tabs-host.hidden`
 * on the parent host, so transient state (selection, in-flight edits) is
 * preserved.
 */
/** v1.154.1 (walk F19): how long after the last keystroke the brief saves. */
const NOTES_AUTOSAVE_MS = 1_200;

export function CardDetailPanel({ workspaceId }: Props) {
  const selectedCardId = useUi(
    (s) => s.selectedCardId[workspaceId] ?? null,
  );
  const cards = useKanban(
    (s) => s.byWorkspace[workspaceId]?.cards ?? EMPTY_ARRAY,
  );
  const card = selectedCardId
    ? cards.find((c) => c.id === selectedCardId) ?? null
    : null;
  const retainedCardIdRef = useRef<string | null>(null);
  if (card) retainedCardIdRef.current = card.id;
  const retainedCard =
    card ??
    (retainedCardIdRef.current
      ? cards.find((candidate) => candidate.id === retainedCardIdRef.current) ??
        null
      : null);

  if (!retainedCard) {
    // v1.76.0: the center host is hidden when nothing is selected, so
    // this renders only in the selected-but-not-loaded window (e.g. an
    // Inbox jump-and-open into a cold workspace whose kanban is still
    // loading) — phrase it as a transition, not an instruction.
    return (
      <div className="card-detail-panel card-detail-empty">
        <p className="muted">
          {selectedCardId ? "Opening card…" : "No card selected."}
        </p>
      </div>
    );
  }

  // P3-1: closing the card hides this warmed host but retains the last editor.
  // The intake xterm therefore keeps the same React mount and backend PTY
  // mapping until a different card replaces it or the workspace is evicted.
  return <CardDetailEditor card={retainedCard} shown={card != null} />;
}

function CardDetailEditor({
  card,
  shown = true,
}: {
  card: KanbanCard;
  /** P3-1: false while the page is closed but this editor is retained —
   *  a brief still being typed is saved then (walk F19). */
  shown?: boolean;
}) {
  const updateCard = useKanban((s) => s.updateCard);
  const adoptIssueRemainder = useKanban((s) => s.adoptIssueRemainder);
  const clearRunHistory = useKanban((s) => s.clearRunHistory);
  const archiveCard = useKanban((s) => s.archiveCard);
  const claimCard = useKanban((s) => s.claimCard);
  const followUpCard = useKanban((s) => s.followUp);
  const selectCard = useUi((s) => s.selectCard);

  // v1.7.0 intake wiring.
  const intakePtyId = useIntake((s) => s.ptyByCard[card.id] ?? null);
  const coordination = useCoordination(
    (s) =>
      s.byWorkspace[card.workspaceId]?.status ?? EMPTY_COORDINATION_STATUS,
  );
  const intakeSession = intakePtyId
    ? coordination.activeSessions.find(
        (session) => session.ptyId === intakePtyId,
      )
    : null;
  const intakeWarnings = intakeSession
    ? coordination.liveWarnings.filter(
        (warning) => warning.sessionId === intakeSession.id,
      )
    : [];
  const intakeWarning = intakeWarnings[0] ?? null;
  const intakeError = useIntake((s) => s.errorByCard[card.id] ?? null);
  const intakeConcluding = useIntake(
    (s) => Boolean(s.concludingByCard[card.id]),
  );
  const startIntake = useIntake((s) => s.start);
  const concludeIntake = useIntake((s) => s.conclude);
  const cancelIntake = useIntake((s) => s.cancel);
  const clearIntake = useIntake((s) => s.clear);
  const setIntakeError = useIntake((s) => s.setError);
  const workspace = useWorkspaces((s) =>
    s.workspaces.find((w) => w.id === card.workspaceId),
  );
  const licensed = useTeamAllowed();
  const githubOwnedReadOnly = workspace
    ? githubCardWriteBlocked(
        workspace.kanbanSyncMode ?? "local",
        licensed,
        true,
      )
    : true;

  // Local draft state — committed on blur or explicit Save.
  const [title, setTitle] = useState(card.title);
  const [notes, setNotes] = useState(card.notes ?? "");
  const [knowledge, setKnowledge] = useState(card.knowledge ?? "");
  const [dispatchPrompt, setDispatchPrompt] = useState(
    card.dispatchPrompt ?? "",
  );

  // Reset drafts when the selected card changes (or its persisted fields
  // change beneath us, e.g. through a swarm completion that updates the card).
  useEffect(() => {
    setTitle(card.title);
    setKnowledge(card.knowledge ?? "");
    setDispatchPrompt(card.dispatchPrompt ?? "");
  }, [
    card.id,
    card.title,
    card.knowledge,
    card.dispatchPrompt,
  ]);

  // v1.154.1 (walk F19): the brief ("What you want") saves itself — a
  // moment after typing stops, on blur, and when the card is left (another
  // card, the page closed, the workspace's host gone) — so a brief typed
  // and left is never lost and the card doesn't stay a Draft. A save that
  // lands while more is typed keeps the newer text: the draft follows the
  // card only while it holds what the card had.
  const persistedNotes = card.notes ?? "";
  const notesBaseRef = useRef({ id: card.id, notes: persistedNotes });
  useEffect(() => {
    const base = notesBaseRef.current;
    notesBaseRef.current = { id: card.id, notes: persistedNotes };
    if (base.id !== card.id) {
      setNotes(persistedNotes);
      return;
    }
    setNotes((cur) => (cur === base.notes ? persistedNotes : cur));
  }, [card.id, persistedNotes]);
  /** The brief typed and not saved yet, and whose it is. */
  const notesDraftRef = useRef<{ workspaceId: string; cardId: string; notes: string } | null>(null);
  const notesWritableRef = useRef(!githubOwnedReadOnly);
  notesWritableRef.current = !githubOwnedReadOnly;
  /** 1.174.0 C4 round 1: the brief's save still on its way, which a start
   *  waits for (`saveBriefFirst`). */
  const briefSaveRef = useRef<Promise<void> | null>(null);
  /** C4 round 3: a start is saving the brief first — the primary says
   *  Starting… and a second press does nothing. */
  const [briefSaving, setBriefSaving] = useState(false);
  const briefSavingRef = useRef(false);
  const flushNotes = useCallback((cardId: string) => {
    const draft = notesDraftRef.current;
    if (!draft || draft.cardId !== cardId) return;
    notesDraftRef.current = null;
    if (!notesWritableRef.current) return;
    const saved = cardInWorkspace(useKanban.getState().byWorkspace, draft.workspaceId, cardId)?.notes ?? "";
    if (draft.notes !== saved) briefSaveRef.current = useKanban.getState().updateCard(cardId, { notes: draft.notes || null });
  }, []);
  // Leaving the card (another card in this host, or the host unmounted).
  useEffect(() => () => flushNotes(card.id), [card.id, flushNotes]);
  // The page closed while this editor stays retained.
  useEffect(() => {
    if (!shown) flushNotes(card.id);
  }, [shown, card.id, flushNotes]);

  // If the license lapses while an owned-field draft is open, discard that
  // unpersisted draft immediately. Local-only dispatch context remains
  // editable and the store guard still protects every programmatic caller.
  useEffect(() => {
    if (!githubOwnedReadOnly) return;
    setTitle(card.title);
    setNotes(card.notes ?? "");
    setKnowledge(card.knowledge ?? "");
  }, [
    githubOwnedReadOnly,
    card.id,
    card.title,
    card.notes,
    card.knowledge,
  ]);

  const titleDirty = title !== card.title;
  const notesDirty = notes !== (card.notes ?? "");
  // Typing stopped: save the brief (walk F19). Not on a card linked to an
  // issue of a GitHub-backed board: each save edits the issue (`gh issue
  // edit`), so there the brief is saved once — on blur or when the card is
  // left — never at every pause.
  const issueLinked = workspace?.kanbanSyncMode === "githubIssues" && card.ghIssueNumber != null;
  // 1.175.0 (D3): the parts both this computer and GitHub changed.
  const briefAsked = issueLinked ? editConflictOf(card, "brief") : null;
  const titleAsked = issueLinked ? editConflictOf(card, "title") : null;
  useEffect(() => {
    if (!notesDirty || issueLinked) return;
    const id = window.setTimeout(() => flushNotes(card.id), NOTES_AUTOSAVE_MS);
    return () => window.clearTimeout(id);
  }, [notes, notesDirty, issueLinked, card.id, flushNotes]);
  const knowledgeDirty = knowledge !== (card.knowledge ?? "");
  const dispatchDirty = dispatchPrompt !== (card.dispatchPrompt ?? "");
  const dirty =
    (!githubOwnedReadOnly && (titleDirty || notesDirty || knowledgeDirty)) ||
    dispatchDirty;

  function commit() {
    const patch: CardPatch = {};
    const trimmed = title.trim();
    if (!githubOwnedReadOnly) {
      if (trimmed && trimmed !== card.title) patch.title = trimmed;
      if (notesDirty) {
        patch.notes = notes || null;
        notesDraftRef.current = null;
      }
      if (knowledgeDirty) patch.knowledge = knowledge || null;
    }
    if (dispatchDirty) {
      patch.dispatchPrompt = dispatchPrompt || null;
      // Stamp the manual-edit marker iff the card already had a value
      // (i.e. intake produced one and the user is now tweaking it). The
      // first time intake writes, that path goes through intake_apply on
      // the backend and won't trip this marker.
      if (card.dispatchPrompt) {
        patch.dispatchPromptEditedAt = Date.now();
      }
    }
    if (Object.keys(patch).length > 0) {
      const saving = updateCard(card.id, patch);
      if ("notes" in patch) briefSaveRef.current = saving;
    }
  }

  /** 1.174.0 C4 round 1: a start reads the brief Rust has (its
   *  `start_refusal`, the Builder's prompt), so what was typed is saved
   *  first — also when the press came before the blur's save, or with
   *  none (⌘↩, a GitHub-linked brief that saves only on blur).
   *  Round 3: `false` — the start stops — while another start is saving,
   *  or when the save didn't land (the store reloaded the card from disk
   *  and its toast said why): never a start on the old brief. */
  async function saveBriefFirst(): Promise<boolean> {
    if (briefSavingRef.current) return false;
    const stored = () => cardInWorkspace(useKanban.getState().byWorkspace, card.workspaceId, card.id)?.notes ?? "";
    const typed = notes;
    briefSavingRef.current = true;
    setBriefSaving(true);
    try {
      flushNotes(card.id);
      if (!githubOwnedReadOnly && typed !== stored()) {
        briefSaveRef.current = updateCard(card.id, { notes: typed || null });
      }
      const saving = briefSaveRef.current;
      briefSaveRef.current = null;
      if (saving) await saving.catch(() => {});
      // C4 approval: line ends and outer spaces don't count — a GitHub
      // reconcile may trim the brief; only a save that didn't land stops it.
      const same = (text: string) => text.replace(/\r\n/g, "\n").trim();
      return githubOwnedReadOnly || same(typed) === same(stored());
    } finally {
      briefSavingRef.current = false;
      setBriefSaving(false);
    }
  }

  // 1.174.0 (DR3): the card's ⋯ › Release… and a stopped release's
  // Publish open the one Release sheet, on the card's area with it ticked.
  const openReleaseSheet = () =>
    openRelease({ workspaceId: card.workspaceId, areaId: cardAreaOf(card), cardIds: [card.id] });
  const [acceptingPushback, setAcceptingPushback] = useState(false);
  /** N19: Follow up is making the new card. */
  const [followingUp, setFollowingUp] = useState(false);
  // 1.171.0 (E2): Follow up shows its suggested card first.
  const [followUpAsk, setFollowUpAsk] = useState<{ title: string; notes: string } | null>(null);
  // SL-4: Retry / Allow and run / Start anyway pressed from the Now box.
  const [settlingSetup, setSettlingSetup] = useState(false);
  // QoL 1.168 (C2, C4): a message to the Builder (the failing checks, the
  // project folder's changes to commit) on its way.
  const [askingFix, setAskingFix] = useState(false);
  const [discussionOpen, setDiscussionOpen] = useState(false);
  // UX-6.8: the last press on this card that failed, drawn as an ErrorBlock.
  const [cardError, setCardError] = useState<UxError | null>(null);
  useEffect(() => setCardError(null), [card.id]);
  /** GH #306: the card's error when it is a Ship that didn't go through,
   *  and which press it was — the Now callout says so beside it. */
  // UX P-A (Windows walk 2): with the review status it failed on — a
  // conflict the card records after it (a later press from the Shipping
  // section, which does not clear the card's error) is newer, and wins.
  const shipFailureRef = useRef<{
    error: UxError;
    press: ShipFailure;
    cardId: string;
    reviewStatus: KanbanCard["reviewStatus"] | null;
  } | null>(null);
  const shipCardIdRef = useRef(card.id);
  shipCardIdRef.current = card.id;
  const shipReviewStatusRef = useRef(card.reviewStatus ?? null);
  shipReviewStatusRef.current = card.reviewStatus ?? null;
  // QoL 1.168 (C4): the failed press behind `cardError` — its cause (a dirty
  // project folder's files) and how to repeat it (Try again).
  const cardFailureRef = useRef<{ error: UxError; cause: unknown; retry: (() => void) | null } | null>(null);
  const hasBuilderRef = useRef(builderMayCommit(card));
  hasBuilderRef.current = builderMayCommit(card);
  // R8: a Builder session to ask to fix what the project's hook refused.
  const canFixRef = useRef(card.builder != null && !card.archived);
  canFixRef.current = card.builder != null && !card.archived;
  const shipAsRef = useRef<((mode: ShipMode, followUp?: boolean) => Promise<void>) | null>(null);
  // Challenger block 5 (item 4): the card page's own Ship under way — Try
  // again repeats it as it was (Ship with follow-up keeps its follow-up).
  const shipPressRef = useRef<{ mode: ShipMode; followUp: boolean } | null>(null);
  // G1: whether this card's Ship it goes to GitHub (read by `failShip`).
  const shipsToGitHubRef = useRef(false);
  // 1.171.0 B3 (DL-27): where a GitHub refusal's Open on GitHub goes — the
  // card's repository and its branch there.
  const githubPageRef = useRef<{ repo: string | null | undefined; branch?: string | null }>({ repo: null });
  // A pull request review card's branch is the pull request's head.
  githubPageRef.current = { repo: card.worktreeBase?.originSlug, branch: card.prReview?.headRef ?? card.branchName };
  const failShip = useCallback((press: ShipPress, cause: unknown, followUpPressed?: boolean) => {
    // R11 (Challenger): only a press that opens a pull request has its
    // refusal read as GitHub's without the text naming GitHub.
    // 1.171.0 B3 (CP-27): the press by id; its words are `shipPressLabel`'s.
    // Challenger 2: titles say "The pull request" for its presses.
    const error = actionFailedError(shipPressLabel(press), cause, {
      name: shipPressErrorName(press),
      retry: true,
      builder: hasBuilderRef.current,
      fix: canFixRef.current,
      github: shipPressIsGitHub(press, shipsToGitHubRef.current),
      githubPage: githubPageRef.current,
    });
    const mode = shipPressMode(press);
    // 1.171.0 B3: a ship with follow-up pressed in The result says so itself.
    const followUp = followUpPressed ?? (shipPressRef.current?.mode === mode && shipPressRef.current.followUp);
    cardFailureRef.current = {
      error,
      cause,
      retry: () => void shipAsRef.current?.(mode, followUp),
    };
    shipFailureRef.current = {
      error,
      // H6b (Windows walk): a skill card's pull request that would carry
      // local commits is not tried again; Now offers Ship it instead.
      // 1.171.0 B3 (Challenger 3): pushed, but its pull request didn't open —
      // Now's primary is the error's Open the pull request.
      // 1.175.0 (D1): a teammate's work stopped it — nothing to try again.
      press: teammateWork(rawError(cause))
        ? "teammate"
        : shipPressIsGitHub(press, shipsToGitHubRef.current) && skillPrLocalRefusal(rawError(cause))
          ? "skill-pr-local"
          : shipPressIsGitHub(press, shipsToGitHubRef.current) && prOpenFailure(rawError(cause)) !== null
            ? prOpenShipFailure(press)
            : press,
      cardId: shipCardIdRef.current,
      reviewStatus: shipReviewStatusRef.current,
    };
    setCardError(error);
  }, []);
  const ownShipFailure =
    cardError !== null &&
    shipFailureRef.current?.error === cardError &&
    shipFailureRef.current.cardId === card.id &&
    shipFailureRef.current.reviewStatus === (card.reviewStatus ?? null)
      ? shipFailureRef.current.press
      : null;
  // …and its block under Now goes with it: the newer state is what is said.
  useEffect(() => {
    const failed = shipFailureRef.current;
    if (failed && cardError === failed.error && failed.reviewStatus !== (card.reviewStatus ?? null)) {
      setCardError(null);
    }
  }, [card.reviewStatus, cardError]);
  // P-A (UX P1 point 2): the Board, the List and the Inbox say it too
  // (`cardFactsStore`); the page forgets it on another card, and so do they.
  useEffect(() => {
    useCardFacts.getState().setShipFailure(card, ownShipFailure);
  }, [card, ownShipFailure]);
  // UX P-A Windows walk 1: a Ship a typed refusal stopped (the local branch
  // can't be updated, a release not published) failed too, wherever it was
  // pressed. Its block is the store's (`lib/shipRefusal.ts`), and Now draws
  // it below without the Shipping section being open.
  const shipRefused = useErrorBlocks((s) => shipRefusedFor(s.byWorkspace, card.workspaceId, card.id));
  const shipFailure = shipFailureOf(ownShipFailure, shipRefused);
  useEffect(() => {
    const shown = { workspaceId: card.workspaceId, id: card.id };
    // (Challenger) A ship under way is the page's to watch too: once the
    // page has left the card nobody would clear it.
    return () => useCardFacts.getState().leave(shown);
  }, [card.workspaceId, card.id]);

  // v1.31.0: card deletion (intake-active guard, running-run/running-
  // swarm detection, opt-out confirm modal, removeCard cascade) is now
  // the shared `useCardDelete` hook so this panel and the Kanban board's
  // right-click "Delete card" menu drive identical behavior. See
  // `CardDeleteDialog.tsx` for the cascade logic and the v1.29.0 history
  // of why the modal exists (native `confirm()`/`alert()` are silently
  // auto-accepted by Tauri 2's WKWebView).
  const { requestDelete, dialog: deleteDialog } = useCardDelete();

  async function onConfirmIntake() {
    setCardError(null);
    if (!(await saveBriefFirst())) return;
    if (!workspace) {
      setCardError(intakeStartError("The card's workspace is not open.", planner));
      return;
    }
    try {
      // Optimistic: flip card.intakeStatus → active before spawn so the
      // panel renders the IntakeConversation as soon as start_intake
      // returns. If start fails, we revert.
      await updateCard(card.id, { intakeStatus: "active" });
      await startIntake(card.workspaceId, card.id, workspace.cwd);
    } catch (e) {
      await updateCard(card.id, { intakeStatus: "none" });
      // The store kept the raw reason as a stopped conversation's; this
      // one never started, and says so once.
      setIntakeError(card.id, null);
      setCardError(intakeStartError(e, planner));
    }
  }

  async function onConcludeIntake() {
    try {
      const proposal = await concludeIntake(card.workspaceId, card.id);
      // v1.20.1 hotfix: reload from disk before the FE-side updateCard
      // writes the card back. The backend's `intake_apply` just appended
      // an IntakeRecord (v1.19.0 / Cycle E4) which is NOT in the FE's
      // in-memory copy; without this reload, updateCard would persist
      // the stale copy and silently clobber the history entry.
      // Same v1.9.2 "Bug B" footgun caught in onCancelIntake below.
      await useKanban.getState().loadFromDisk(card.workspaceId, true);
      await updateCard(card.id, {
        dispatchPrompt: proposal.dispatchPrompt,
        dispatchPromptEditedAt: null,
        intakeStatus: "ready",
        // G4 (launch D8): swarms are retired, so the intake's swarm
        // template suggestion is not applied; the card is built by the
        // Builder.
      });
      pushToast({
        kind: "info",
        title: "Planning finished",
        body: card.title,
      });
      // 1.168.1 B2: the person stays on the card, which now says Ready to
      // start — it used to close and land on the Board.
    } catch {
      // Error is already in `intakeError`; nothing more to do here.
    }
  }

  async function onCancelIntake() {
    try {
      await cancelIntake(card.workspaceId, card.id);
    } finally {
      // v1.20.1 hotfix: reload from disk before the FE-side updateCard
      // writes the card back. The backend's `intake_cancel` just
      // appended an IntakeRecord (v1.19.0 / Cycle E4) which the FE's
      // in-memory copy doesn't know about. Without this reload,
      // updateCard would persist the stale copy and silently clobber
      // the history entry. Same v1.9.2 "Bug B" footgun.
      await useKanban.getState().loadFromDisk(card.workspaceId, true);
      await updateCard(card.id, { intakeStatus: "none" });
    }
  }

  const planningAgain = useRef<Set<string>>(new Set());

  /** N14 walk F14/F20: Plan again on a stopped conversation. The ended one
   *  is recorded as replanned (the Activity's "Planned again", not a
   *  cancel), and the card stays planning throughout — no Draft between the
   *  two conversations. */
  async function onPlanAgain() {
    // Challenger P3: one Plan again per card at a time (a double press).
    if (planningAgain.current.has(card.id)) return;
    planningAgain.current.add(card.id);
    try {
      await planAgainOnce();
    } finally {
      planningAgain.current.delete(card.id);
    }
  }

  async function planAgainOnce() {
    setCardError(null);
    if (!workspace) {
      setCardError(intakeStartError("The card's workspace is not open.", planner));
      return;
    }
    try {
      await cancelIntake(card.workspaceId, card.id, { replanned: true });
    } catch (e) {
      // As Cancel intake: the record (if any) is on disk; the card leaves
      // planning. The cancel is what failed, and it says so.
      await useKanban.getState().loadFromDisk(card.workspaceId, true);
      await updateCard(card.id, { intakeStatus: "none" });
      setCardError(actionFailedError("Plan again", e));
      return;
    }
    // Bug B: the backend just appended the record; reload before any write.
    await useKanban.getState().loadFromDisk(card.workspaceId, true);
    try {
      const current = useKanban
        .getState()
        .byWorkspace[card.workspaceId]?.cards.find((c) => c.id === card.id);
      if (current && current.intakeStatus !== "active") {
        await updateCard(card.id, { intakeStatus: "active" });
      }
      await startIntake(card.workspaceId, card.id, workspace.cwd);
    } catch (e) {
      await updateCard(card.id, { intakeStatus: "none" });
      setIntakeError(card.id, null);
      setCardError(intakeStartError(e, planner));
    }
  }

  function onIntakeUnexpectedExit(code: number | null, ptyId: string) {
    // Agent crashed mid-conversation. N14 walk F14: a stop, said on the
    // Board, Now and the Inbox (only for the conversation still current).
    useIntake.getState().markStopped(
      card.id,
      ptyId,
      `Intake agent exited unexpectedly${
        code != null ? ` (code ${code})` : ""
      }. Cancel and retry.`,
    );
    // Don't auto-cancel here — the user might want to read whatever
    // appeared in the xterm before clicking Cancel themselves.
  }

  // v1.20.3: when the backend's idle sweeper auto-cancels, render a
  // friendlier message than the generic "exited unexpectedly" error.
  // The sweeper has already torn down the session backend-side; the
  // user just needs to know why and that they can start a new one.
  function onIntakeSwept(idleMinutes: number, ptyId: string) {
    useIntake.getState().markStopped(card.id, ptyId, intakeSweptReason(idleMinutes));
  }

  // Re-mounts to a different card clear lingering store entries that
  // belong to the unmounted card. Per-card state lives keyed by id; this
  // is just a guard against unmount-without-cleanup edge cases.
  useEffect(() => {
    return () => {
      // No-op: the store keys persist intentionally so re-selecting the
      // same card resumes its session. Real cleanup happens on cancel/apply.
      void clearIntake;
    };
  }, [card.id, clearIntake]);

  const runHistory = card.runHistory ?? EMPTY_ARRAY;
  const intakeStatus = card.intakeStatus ?? "none";
  const editedSinceIntake = Boolean(card.dispatchPromptEditedAt);

  // C6 (UX-6.3–6.5): the card is one page. What used to be a step body —
  // the conversation, the session, the result, the ship — is a section that
  // is always mounted and shown when opened (`uiStore.cardStep`, one at a
  // time; nothing is open by default). Hidden with CSS, never unmounted:
  // the intake and Builder xterms must survive every open and close.
  const moveCard = useKanban((s) => s.moveCard);
  const linkedSwarmStatus = useSwarms((s) =>
    card.linkedSwarmId
      ? s.byWorkspace[card.workspaceId]?.swarms.find(
          (sw) => sw.id === card.linkedSwarmId,
        )?.status ?? null
      : null,
  );
  // GH #257: when the linked swarm started — the running helper's time.
  const linkedSwarmStartedAt = useSwarms((s) =>
    card.linkedSwarmId
      ? s.byWorkspace[card.workspaceId]?.swarms.find((sw) => sw.id === card.linkedSwarmId)
          ?.startedAt ?? null
      : null,
  );
  const verifyJob = useVerify(
    (s) => s.byKey[`${card.workspaceId}::${card.id}`] ?? null,
  );
  const [taggedOutcome, setOutcomePresentation] =
    useState<OutcomePresentationSummary & { cardId?: string }>({
      loading: card.lastRunStatus === "success",
      filesChanged: null,
      shipBusy: false,
      cardId: card.id,
    });
  // P-A: what the result said is this card's only once it said it for this
  // card — the page's state outlives a switch by one render.
  const outcomePresentation: OutcomePresentationSummary =
    taggedOutcome.cardId === card.id
      ? taggedOutcome
      : { loading: card.lastRunStatus === "success", filesChanged: null, shipBusy: false };
  const outcomeCardIdRef = useRef(card.id);
  outcomeCardIdRef.current = card.id;
  // SP-1 phase 2: the diff the result has, drawn in its own section. Kept
  // with the card that offered it (review 2): this editor is not keyed by
  // card, so after a switch the last card's offer (its PR number) never
  // stands for this one — until this card's own result says so, no diff.
  const [taggedDiffOffer, setTaggedDiffOffer] = useState<
    (OutcomeDiffOffer & { cardId: string }) | null
  >(null);
  const diffOffer: OutcomeDiffOffer | null =
    taggedDiffOffer?.cardId === card.id ? taggedDiffOffer : null;
  const setDiffOffer = useCallback(
    (offer: OutcomeDiffOffer | null) =>
      setTaggedDiffOffer(offer ? { ...offer, cardId: card.id } : null),
    [card.id],
  );
  const [taggedFreshness, setReviewFreshness] = useState<{
    value: "none" | "fresh" | "stale";
    cardId: string;
  }>({ value: "none", cardId: card.id });
  const reviewFreshness = taggedFreshness.cardId === card.id ? taggedFreshness.value : "none";
  const outcomeShipRef = useRef<ShipRunner | null>(null);
  // v1.154.1 (F14): the pull request's Merge and Push update, which the
  // Shipping section holds; the Now callout presses them.
  const prActionsRef = useRef<PrActions | null>(null);
  // Nit: a Merge or Push update pressed from the Now callout, until it is done.
  const [prPress, setPrPress] = useState<"merge" | "push" | "auto" | null>(null);
  // Round 4 (RW-C2): a push or merge the Shipping section runs, whoever
  // pressed it — Now's pull-request presses are off meanwhile.
  const [shippingBusy, setShippingBusy] = useState<"merge" | "push" | "auto" | null>(null);
  const onPrActionsReady = useCallback((actions: PrActions | null) => {
    prActionsRef.current = actions;
    setShippingBusy(actions?.busy ?? null);
  }, []);
  const rerunStaleReviewRef = useRef<(() => Promise<void>) | null>(null);
  const outcomeRedoRef = useRef<(() => void) | null>(null);
  const stateHeadlineRef = useRef<HTMLHeadingElement | null>(null);
  const primaryInvocationRef = useRef<Pick<
    InstalledSelfCheckActionTraceInput,
    "source" | "focusCategory"
  > | null>(null);

  useEffect(() => {
    setOutcomePresentation({
      loading: card.lastRunStatus === "success",
      filesChanged: null,
      shipBusy: false,
      cardId: card.id,
    });
  }, [card.id, card.workspaceId, card.lastRunStatus]);
  useEffect(() => {
    setReviewFreshness({ value: "none", cardId: card.id });
  }, [card.id]);

  const onOutcomePresentationChange = useCallback(
    (next: OutcomePresentationSummary) => {
      const cardId = outcomeCardIdRef.current;
      setOutcomePresentation((current) =>
        current.cardId === cardId &&
        current.loading === next.loading &&
        current.filesChanged === next.filesChanged &&
        current.shipBusy === next.shipBusy &&
        (current.noRemote ?? false) === (next.noRemote ?? false) &&
        (current.prOffered ?? false) === (next.prOffered ?? false) &&
        (current.noPullRequestWords ?? null) === (next.noPullRequestWords ?? null)
          ? current
          : { ...next, cardId },
      );
    },
    [],
  );
  const onReviewFreshnessChange = useCallback(
    (next: "none" | "fresh" | "stale") => setReviewFreshness({ value: next, cardId: outcomeCardIdRef.current }),
    [],
  );
  const onOutcomeShipReady = useCallback(
    (handler: ShipRunner | null) => {
      outcomeShipRef.current = handler;
    },
    [],
  );
  const onOutcomeRedoReady = useCallback((open: (() => void) | null) => {
    outcomeRedoRef.current = open;
  }, []);
  // UX-6.8: a press inside the result (Ship, Send it back) that failed is
  // drawn on the card, in the error shape.
  const onOutcomeFailure = useCallback(
    (action: string, cause: unknown, cardId: string, followUp?: boolean) => {
      // SP-1 review 4: this editor is not keyed by card — a press that
      // fails after the person moved to another card is not this card's
      // error; the result says it in a toast instead.
      if (cardId !== card.id) return false;
      if (isShipPress(action)) failShip(action, cause, followUp);
      else setCardError(actionFailedError(action, cause));
      return true;
    },
    [failShip, card.id],
  );
  const onRerunStaleReady = useCallback(
    (handler: (() => Promise<void>) | null) => {
      rerunStaleReviewRef.current = handler;
    },
    [],
  );

  // GH #99 (review 2): the live branch tip, shared with Outcome, so a
  // commit made after a review is seen without a card state change.
  const reviewTip = useReviewTip(card);
  // #378 (P3-4): the Now callout's pull request says what The result's does.
  const prShipNow = prShipOffer(card.builder, reviewTip?.branchTip);
  // P-A (UX P1 point 2): what the card says is `presentCard`'s — the same
  // function, from the same live facts (`useCardLive`), as its Board card,
  // its List row, its blocker chips, its session row and its Inbox row. The
  // page reads its own result and its last failed ship first; it passes
  // them in and shares them (`cardFactsStore`) with the other surfaces.
  const pageOutcome: OutcomeFacts = {
    loading: outcomePresentation.loading,
    filesChanged: outcomePresentation.filesChanged,
    shipBusy: outcomePresentation.shipBusy,
    noRemote: outcomePresentation.noRemote ?? false,
    prOffered: outcomePresentation.prOffered ?? false,
    reviewFreshness,
  };
  // Skills hub H3a: this page reads whether a skill card is behind its
  // library; every surface's live facts carry the answer.
  useSkillCardBehind(card);
  // 1.174.0 (C3, P9; card-page.html §2): a card with no area to start in
  // asks in Now, on the select below its question — starting on the area
  // its files point to — before Start build, never a toast after it.
  const areaState = useCardArea((s) => s.byCard[card.id]);
  // The person's pick; empty: where the card's reading starts it. Kept
  // through a new reading (Challenger 4), reset for another card or when
  // the repository no longer lists it.
  const [areaChoice, setAreaChoice] = useState("");
  useEffect(() => {
    setAreaChoice("");
  }, [card.id]);
  useEffect(() => {
    if (areaChoice && areaState && !areaState.areas.some((a) => a.id === areaChoice)) setAreaChoice("");
  }, [areaState, areaChoice]);
  const areaPick = areaChoice || (areaState ? areaChoiceStart(areaState) : "");
  // Challenger 1–2: one press at a time while the area is saved, and the
  // start it leads to said as §2b draws it ("Starting in Site…", then
  // "Area set to Site · Codex is opening this card's copy", with Stop).
  // Round 2 (Challenger 1): this page is one mount for every card it shows
  // — a press belongs to its card, and is drawn only on that card's page.
  const areaPressRef = useRef(new Map<string, { stop: boolean; armed: boolean }>());
  const [areaPresses, setAreaPresses] = useState<
    Record<string, { area: string; saved: boolean; stopping: boolean; shown: boolean } | undefined>
  >({});
  const areaPressOfCard = areaPresses[card.id] ?? null;
  const areaBusy = areaPressOfCard != null;
  const areaNowFact = nowAreaAsk(areaState, areaPick);
  const pageFacts = { outcome: pageOutcome, shipFailure, notesDraft: notes, areaAsk: areaNowFact };
  const livePlain = useCardLive(card, reviewTip, pageFacts);
  // 1.171.0 C2: an approval in view in the card's own session during Finish
  // and check is a question (rule 9) at once on this page — the Board's
  // waiting facts catch up a tick later.
  const questionInView = useBuilder((s) => {
    const rt = s.byCard[card.id];
    return Boolean(rt && card.builder?.ptyId && rt.ptyId === card.builder.ptyId && rt.questionInView && rt.turnIdle !== true);
  });
  const live =
    questionInView && livePlain.session?.finishing && livePlain.session.state === "working"
      ? { ...livePlain, session: { ...livePlain.session, state: "question" as const } }
      : livePlain;
  const presentation = presentCard(card, live);
  const presentationState = presentation.state;
  // 1.171.0 (E2; walk 2026-10-27 #6): a done card's brief is read-only and
  // nothing can block it any more.
  const cardDone = cardIsDone(card, presentationState);
  // 1.173.0 A3 (walk fix a): a card made from a copy, not started yet, reads
  // what its copy holds (Now says it).
  // 1.174.0 C4: also while its brief is empty (draft).
  const copyChanges = useCopyChanges(card, presentationState === "ready" || presentationState === "draft");
  const tryLane = useTryLane(card);
  useEffect(() => {
    useCardFacts.getState().setOutcome(card, pageOutcome);
    // The facts by value: a new object each render is not a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    card,
    pageOutcome.loading,
    pageOutcome.filesChanged,
    pageOutcome.shipBusy,
    pageOutcome.noRemote,
    pageOutcome.prOffered,
    pageOutcome.reviewFreshness,
  ]);
  // The rendered state above is derived from this render's card snapshot.
  // The diagnostic authority below independently reads the live stores so a
  // stale React render can produce store_dom_mismatch instead of two equal
  // attributes by construction. P-A: through `presentCard` too, rule and all.
  const freshCard =
    useKanban
      .getState()
      .byWorkspace[card.workspaceId]?.cards.find(
        (candidate) => candidate.id === card.id,
      ) ?? null;
  const storePresentation = freshCard
    ? presentCard(freshCard, { ...cardLiveFrom(cardLiveSourcesNow(), freshCard, reviewTip), ...pageFacts })
    : null;
  const storePresentationState = storePresentation?.state ?? null;
  const chosenSection = useUi((s) => s.cardStep[card.id] ?? null);
  // Card chat: its tab stays mounted once the chat was read.
  const chatStarted = useChat((s) => s.byKey[chatKey(card.workspaceId, card.id)] != null);
  const setCardStep = useUi((s) => s.setCardStep);
  // CL-11 (Mac walk, step 2): a review's verdict lives in "The result",
  // which opened only from a link — after a changes-requested review the
  // page showed Now and Activity and no result. With a verdict in and no
  // section chosen, the result is open; hiding it (or opening another
  // section) is remembered for that review, and the next review opens it
  // again.
  const verdictKey = reviewVerdictKey(card.builder?.review ?? null);
  // Round 2 (F4): kept beside `cardStep`, so Hide survives switching cards.
  const resultSetAside = useUi((s) => s.resultSetAside[card.id] ?? null);
  const setResultSetAsideFor = useUi((s) => s.setResultSetAside);
  const reviewByItself = verdictKey != null && resultSetAside !== verdictKey && !card.prReview;
  const openSection: CardPageSection | null =
    // 1.172.0 D2 (CP-21): a shipped card's Shipping is its result's receipt.
    (chosenSection ? landedSection(chosenSection, card) : null) ?? (reviewByItself ? "outcome" : null);
  // SP-1 phase 2: a pair open together — the result and its diff.
  const diffChosen = useUi((s) => s.cardDiffOpen[card.id] ?? false);
  const diffShown = openSection === "outcome" && diffChosen && diffOffer != null;
  // 1.172.0 (C3; CP-8): the other pair — the Review and the Builder's
  // session, so the findings and the Builder are seen together: opened
  // together, or a new verdict while the session is open (the Review opens
  // by itself, the session stays).
  const sessionWithReview = useUi((s) => s.cardSessionWithReview[card.id] ?? false);
  const reviewWithSession =
    !card.prReview &&
    !diffShown &&
    // 1.172.0 D2: never beside a shipped card's receipt (no Builder to fix).
    !shippedReceipt(card) &&
    ((openSection === "outcome" && sessionWithReview) || (openSection === "run" && reviewByItself));
  const reviewOpen = (openSection === "outcome" || reviewWithSession) && !card.prReview;
  const sessionOpen = openSection === "run" || reviewWithSession;
  // Read by the presses below, so `reveal` keeps its identity (an effect
  // that reveals the chat depends on it).
  const pairNow = useRef({ reviewOpen, sessionOpen, reviewWithSession });
  pairNow.current = { reviewOpen, sessionOpen, reviewWithSession };
  // 1.172.0 (C2; CP-19): the overlap with other cards, read once — the
  // chip under Now on Ready to ship and the Review's list.
  const overlaps = useOverlapWarnings(card.workspaceId, card.id, !card.prReview);
  // UX-6.5: "Read the plan" opens one past intake's plan and transcript.
  const [planOpen, setPlanOpen] = useState<string | null>(null);
  // 1.172.0 D2 (CP-28): the card's one Details (Files, History of runs,
  // Technical); the brief's Files chip opens it.
  const [moreOpen, setMoreOpen] = useState(false);
  // 1.174.0 (C1, P8): a built card's brief is folded until Show — for this
  // session only, closed again for the next card.
  const [briefShown, setBriefShown] = useState(false);
  // 1.172.2 D5: a file dropped anywhere on the card page joins its Files,
  // and Details opens on them so the person sees it arrive.
  const cardFiles = useCardFileIngest(card);
  const pageDrop = useCardPageDrop((files) => {
    openFiles();
    void cardFiles.ingest(files);
  });
  // 1.172.0 D2 (CP-25): the card's pickers, open under the facts line.
  // 1.172.0 walk (E1): this page is one mount for every card it shows — a
  // card opened next (⌘↵ from the Board) starts with them closed, its
  // Change… saying so, not with the last card's left open.
  const [pickersOpen, setPickersOpen] = useState(false);
  // CL-5: Activity folds older review rounds until asked; a round's link
  // narrows the review section to its findings.
  const [showAllRounds, setShowAllRounds] = useState(false);
  // 1.172.0 walk (E1): the page is one mount for every card it shows — the
  // next card opens with its pickers, Details and older rounds closed.
  useEffect(() => {
    setPickersOpen(false);
    setMoreOpen(false);
    setBriefShown(false);
    setShowAllRounds(false);
  }, [card.id]);
  // 1.171.0 D2 (owner D11): said aloud when Open session moves the cursor
  // into the terminal; cleared when the page shows another card.
  const [sessionFocusNote, setSessionFocusNote] = useState<{
    cardId: string;
    section: "run" | "intake" | null;
    text: string;
  }>({ cardId: "", section: null, text: "" });
  const roundsRevealed = useRef(false);
  const setReviewRoundFilter = useUi((s) => s.setReviewRoundFilter);
  // The narrowing is about this page: it goes when the page closes.
  useEffect(() => () => setReviewRoundFilter(card.id, null), [card.id, setReviewRoundFilter]);
  // CL-6: so is an unclaimed ask to show one of its findings.
  useEffect(
    () => () => {
      if (useUi.getState().findingFocus?.cardId === card.id) useUi.getState().focusFinding(null);
    },
    [card.id],
  );
  // "Show them": focus goes to the first round it revealed.
  useEffect(() => {
    if (!showAllRounds || !roundsRevealed.current) return;
    roundsRevealed.current = false;
    const row = document.querySelector<HTMLElement>(
      `[data-ply-card-host][data-ply-card-id="${CSS.escape(card.id)}"] [data-ply-event^="review-round-"]:not([data-ply-event^="review-round-gap-"]):not([data-ply-event^="review-round-restart-"])`,
    );
    // Only this row is made focusable (CL-5 round 3): the rest of the
    // timeline takes no focus, and no ring, from a mouse click.
    if (row) {
      row.tabIndex = -1;
      row.focus();
    }
  }, [showAllRounds, card.id]);
  const openOnly = useCallback(
    (section: CardPageSection | null) => {
      setPlanOpen(null);
      // The person chose: the result no longer opens by itself for this
      // review.
      if (verdictKey != null) setResultSetAsideFor(card.id, verdictKey);
      setCardStep(card.id, section);
    },
    [card.id, setCardStep, setResultSetAsideFor, verdictKey],
  );
  /** C3: open a section; the Review and the session keep each other open. */
  const openKeeping = useCallback(
    (section: CardPageSection) => {
      const { reviewOpen, sessionOpen } = pairNow.current;
      if ((section === "run" && reviewOpen) || (section === "outcome" && sessionOpen && !card.prReview)) {
        setPlanOpen(null);
        if (verdictKey != null) setResultSetAsideFor(card.id, verdictKey);
        useUi.getState().openReviewWithSession(card.id);
        return;
      }
      openOnly(section);
    },
    [card.id, card.prReview, openOnly, setResultSetAsideFor, verdictKey],
  );
  /** C3: hide one of the Review and the session; the other stays. */
  const hideSection = useCallback(
    (section: "run" | "outcome") => {
      if (pairNow.current.reviewWithSession) openOnly(section === "run" ? "outcome" : "run");
      else openOnly(null);
    },
    [openOnly],
  );
  /** Open a section below the Activity and bring it into view. */
  const reveal = useCallback(
    (asked: CardPageSection, focusSelector?: string) => {
      // 1.172.0 D2 (CP-21): a shipped card has one receipt, What shipped.
      const section = landedSection(asked, card);
      openKeeping(section);
      requestAnimationFrame(() => {
        const host = document.querySelector<HTMLElement>(
          `[data-ply-card-host][data-ply-card-id="${CSS.escape(card.id)}"] [data-ply-card-section="${section}"]`,
        );
        host?.scrollIntoView?.({ block: "start" });
        // 1.172.0 C2 (Challenger 2): else the section's own heading.
        if (focusSelector) {
          (host?.querySelector<HTMLElement>(focusSelector) ?? host?.querySelector<HTMLElement>(REVIEW_FOCUS))?.focus();
        }
      });
    },
    [card, openKeeping],
  );
  /** 1.172.0 D2 (CP-20): View history — the card's Activity, in view and
   *  focused. */
  function showActivity() {
    openOnly(null);
    requestAnimationFrame(() => {
      const activity = document.querySelector<HTMLElement>(
        `[data-ply-card-host][data-ply-card-id="${CSS.escape(card.id)}"] [data-ply-card-activity]`,
      );
      activity?.scrollIntoView?.({ block: "start" });
      activity?.focus();
    });
  }
  // Plan with two AIs: its Plan step, the ⋯ entry, or a card just made by
  // "Create and plan with two AIs" opens the Chat tab on the Plan form.
  const planFormAt = usePlanExchange((s) => s.formRequests[chatKey(card.workspaceId, card.id)]);
  useEffect(() => {
    if (formRequestFresh(planFormAt)) reveal("chat");
  }, [planFormAt, reveal]);
  /** SP-1 phase 2: "See the diff" — the result and its diff, open together;
   *  the diff is brought into view (beside the result on a wide page, after
   *  it on a narrow one). */
  const openDiff = useCallback(() => {
    openOnly("outcome");
    useUi.getState().openCardDiff(card.id);
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          `[data-ply-card-host][data-ply-card-id="${CSS.escape(card.id)}"] [data-ply-card-section="diff"]`,
        )
        ?.scrollIntoView?.({ block: "start" });
    });
  }, [card.id, openOnly]);
  const closeDiff = useCallback(() => useUi.getState().closeCardDiff(card.id), [card.id]);
  // SL-4: a worktree setup that failed is shown where its Retry and Start
  // anyway are — the run — as soon as it is on the card.
  const setupFailedAt = card.worktreeSetup?.state === "failed" ? card.worktreeSetup.at : null;
  const setupHolds = setupFailedAt != null || card.worktreeSetup?.state === "running";
  useEffect(() => {
    if (setupFailedAt != null) openOnly("run");
  }, [setupFailedAt, openOnly]);

  // v1.76.0 (STEP6 D8): Esc closes the card back to the Board — with
  // keymap-card-#8 focus-scoping (Esc is real input to the intake
  // xterm, the editor, and text fields; yield there).
  useEffect(() => {
    function onEsc(e: KeyboardEvent) {
      // OB-4: nothing under Setup answers a key while it is up.
      if (setupIsOpen()) return;
      if (e.key !== "Escape") return;
      const ui = useUi.getState();
      if (useWorkspaces.getState().activeId !== card.workspaceId) return;
      if (ui.selectedCardId[card.workspaceId] !== card.id) return;
      if (effectiveCenterMode(ui.centerMode, card.workspaceId) !== "board") {
        return;
      }
      const target = e.target as HTMLElement | null;
      // A nested modal is the topmost layer and owns Escape. Its shared focus
      // contract closes it before this underlying card may return to Board.
      if (
        target?.closest('.ux-sheet-backdrop, [role="dialog"][aria-modal="true"]')
      ) {
        return;
      }
      const host = target?.closest<HTMLElement>(
        `[data-ply-card-host][data-ply-card-id="${CSS.escape(card.id)}"]`,
      );
      const disclosure = target?.closest<HTMLDetailsElement>("details[open]");
      if (host && disclosure && host.contains(disclosure)) {
        e.preventDefault();
        e.stopPropagation();
        disclosure.open = false;
        disclosure.querySelector<HTMLElement>(":scope > summary")?.focus();
        return;
      }
      if (
        target?.closest(
          'input, textarea, .xterm, .cm-editor, [contenteditable]:not([contenteditable="false"])',
        )
      ) {
        return;
      }
      e.preventDefault();
      ui.selectCard(card.workspaceId, null, false);
    }
    document.addEventListener("keydown", onEsc, true);
    return () => document.removeEventListener("keydown", onEsc, true);
  }, [card.id, card.workspaceId]);

  // C6 (UX-6.5): the stepper and its ⌥←/⌥→ are gone with the steps; a
  // Timeline event's link or the Now action opens a section instead.

  // v1.66.0 (D4): dispatch from the card — the SAME choke point the
  // board drag uses (`kanbanStore.moveCard`: intake-active block, claim
  // gate, worktree creation, slot-cap + role-binding preflights,
  // backend prompt compose). No second dispatch path.
  // G4 (launch D8): a swarm template counts only while a swarm can still
  // run on the card (`swarmTemplateInUse`); one on a Todo card that never
  // ran a swarm is ignored, and the card is built by the Builder.
  const swarmInUse = swarmTemplateInUse(card);
  const retiredDebateAttached =
    swarmInUse && card.swarmTemplateId === "claude-codex-debate";
  const canStartRun =
    card.columnId === "todo" &&
    !card.archived &&
    intakeStatus !== "active" &&
    !retiredDebateAttached &&
    Boolean(card.agentConfigId || swarmInUse);

  const defaultVendor = useSettings((s) => s.settings.behavior.builderVendor);
  // 1.171.0 C3 (Challenger 6): an override of this person's says "you".
  const identityEmail = useSettings((s) => s.settings.identity?.userEmail ?? null);
  const vendorPick = useBuilder((s) => s.vendorPref[card.id]);
  // v1.154.1 (walk F23): Build with both, offered where Start build is.
  const doctorReport = useDoctor((s) => s.report);
  const bothOffer = buildBothOffer(card, vendorReadiness(doctorReport));
  // The guided first card keeps its one way forward (OB-16).
  const onGuidedFirstCard = useSettings((s) =>
    guideShownOn(s.settings.onboarding?.firstCard ?? null, card.workspaceId, card.id),
  );
  const startBoth = useBuildBoth((s) => s.start);
  const bothBusy = useBuildBoth((s) => Boolean(s.busy[card.id]));
  const preferredVendor = effectiveBuilderVendor(vendorPick, card, defaultVendor);
  // 1.168.1 (E2/E3): the model each role runs on, chosen here for this card.
  // 1.169.0 (A2): the team's suggestions lie between the workspace's and the app's.
  const teamModels = useTeamModels(card.workspaceId).models;
  const appModels = withTeam(useSettings((s) => s.settings.behavior.models) ?? EMPTY_ROLE_MODELS, teamModels);
  const roleVendor = card.builder?.vendor ?? preferredVendor;
  // 1.169.0 (A1): with the catalog, a chip names only the effort a spawn passes.
  const modelCatalog = useModelCatalog();
  const builderModel = builderModelFact(card, workspace?.models, appModels, roleVendor, modelCatalog);
  const challengerModel = challengerModelFact(
    card,
    workspace?.models,
    appModels,
    challengerVendorOf(card, roleVendor, vendorReadiness(doctorReport)[challengerVendor(roleVendor)].installed),
    modelCatalog,
  );
  // UX P-C: D2's one sentence above the Now box's Start build, on the
  // unedited guided first card while "Build without asking" is off.
  const guidedBypass = useBuilder((s) => s.bypassPref[card.id] ?? false);
  // 1.171.0 (D1): until the card has a permissions choice of its own.
  const guidedStart = useSettings(
    (s) =>
      card.builderPermissions == null &&
      boundedStartApplies(s.settings.onboarding, card.workspaceId, card, guidedBypass),
  );
  // 1.172.0 (C1): the setup sentence names the choice the card's
  // Permissions shows (`BuilderPermissionsPick`).
  const permissionsDefault = useSettings((s) => s.settings.behavior.builderPermissions);
  const tourStartMode = useSettings((s) =>
    boundedStartApplies(s.settings.onboarding, card.workspaceId, card, false),
  );
  // Immediacy walk 3a.1: only the README example's guided card replaces the
  // sentence under What you want with its own (the guide's callout); the
  // tour's card says it there, as the tour's note promises.
  const readmeGuided = useSettings(
    (s) =>
      card.builderPermissions == null &&
      guidedStartApplies(s.settings.onboarding?.firstCard ?? null, card.workspaceId, card, guidedBypass),
  );
  const handedOverDelivery = useBuilder((s) => s.handedOverDelivery[card.id]);
  // OB-14 (§13.3): the planning words name who plans this card.
  const planner = usePlanner(card);
  // P-A: the state's own presentation, and the one `presentCard` chose over
  // it (rules 1–19, in one order, for every surface).
  const basePresentation = presentation.base;
  const statePresentation: CardStatePresentation = presentation.presentation;
  // GH #129: a request for changes the Builder never received leads.
  const owedToBuilder = handedOverOwed(card.builder, handedOverDelivery);
  const handedOverHeader = handedOverPresentation(presentationState, owedToBuilder);
  // GH #135: the settled verdict the Builder has not received.
  const owedVerdict = verdictOwed(card.builder, useBuilder((s) => s.verdictDelivery[card.id]), Boolean(card.prReview));
  // 1.171.0 C2 (CF11, K3): one Plyloft delivers by itself is a note only.
  const owedVerdictNote = verdictShownAsWork(owedVerdict, card.builder?.review) ? null : verdictDetailsNote(owedVerdict);
  // SL-6: a card built by both says where the two builds are.
  const bothSessionsGone = presentationState === "session-closed" && isUndecided(card);
  // CL-7: while both build, each build is named with what its session is
  // doing — `presentCard`'s sentence when its rule is the two builds'.
  const laneA = useBuilder((s) => s.byCard[laneKey(card.id, "a")]);
  const laneB = useBuilder((s) => s.byCard[laneKey(card.id, "b")]);
  const bothPlain = presentationState === "running" || bothSessionsGone ? buildBothNow(card) : null;
  const bothNow = bothPlain
    ? { label: bothPlain.label, helper: presentation.rule === "both" ? presentation.sentence : bothPlain.helper }
    : null;
  // F3/F5: a card whose setup runs, failed or waits for this Mac's OK.
  const setupNow = setupPresentation(card, presentationState);
  // v1.154.1 (walk G1): the Builder (or one of its two builds) is stopped at
  // its CLI's folder-trust question (rule 8) — or (UX P-F) at Claude's bypass
  // warning or its usage limit. Plyloft never answers any of them.
  const trustVendor = live.session?.block ? live.session.vendor : null;
  const askingTrust = trustVendor !== null && presentation.rule === "session-block";
  // N14 walk F14: the intake conversation ended while the card still plans.
  const intakeStopped = presentation.rule === "intake-stopped";
  // v1.154.1 (M2): how the primary Ship ships; the menu offers the other way.
  // G1: by default the card's Ship it, which ships as the workspace says.
  const primaryShipMode: ShipMode = statePresentation.shipMode ?? "ship_it";
  const shipsToGitHub = shipItGoesToGitHub(workspace?.shipVia, outcomePresentation.prOffered);
  shipsToGitHubRef.current = shipsToGitHub;

  // C7 (UX-7.2): a card waiting for a blocker that has not shipped does not
  // start — its Plan or Start stays, off, with the reason.
  const workspaceCards = live.workspaceCards;
  const holdingBlockers = unshippedBlockers(card, workspaceCards);
  const blocked = isHeld(card, workspaceCards, presentationState);
  const heldReason = blocked ? startRefusal(holdingBlockers) : null;
  // N19: a follow-up card whose ask is still empty doesn't start.
  const followUpEmpty =
    !blocked &&
    (presentationState === "draft" || presentationState === "ready") &&
    followUpAskEmpty(card, notes);
  // 1.174.0 C4 (P17): nor a card made from a copy before its brief says
  // anything — the reason sits beside Start build.
  const copyEmpty =
    !blocked &&
    !followUpEmpty &&
    (presentationState === "draft" || presentationState === "ready") &&
    copyBriefEmpty(card, notes);
  const askEmpty = followUpEmpty || copyEmpty;
  const askEmptyReason = copyEmpty ? COPY_BRIEF_EMPTY : FOLLOW_UP_ASK_EMPTY;
  const held = blocked || askEmpty;
  // Plan with two AIs: offered on an unbuilt card (draft, ready), not while
  // an intake runs; never on a pull request's card.
  const twoAisOffered = !card.archived && !card.prReview && planTwoAisOffered(presentationState);
  const openPlanTwoAis = () => usePlanExchange.getState().requestForm(card.workspaceId, card.id);
  const planWords = presentation.rule === "plan";

  // GH #262: the steps of the live or last verification.
  const checkSteps =
    verifyJob?.steps ?? card.verifyHistory?.[card.verifyHistory.length - 1]?.steps ?? [];
  // ADR 0006: from the fourth refusal the Ship step says what is open;
  // 1.171.0 B3 (CP-14): the way to ship with them in a new card is beside
  // the findings (The result), never with a P1 open.
  const followUpHelper =
    presentationState === "changes-requested" ? shipWithFollowUpHelper(card.builder) : null;
  const baseHelper = askingTrust || presentation.rule === "builder-waiting" || presentation.rule === "finishing"
    ? statePresentation.helper
    : bothNow
    ? bothNow.helper
    : presentationState === "running" && !held
      ? runStartedWords(linkedSwarmStartedAt ?? card.builder?.startedAt, Date.now())
      : presentationState === "verify-failed" && statePresentation === basePresentation
        ? checksFailedWords(checkSteps)
        : presentationState === "checking" && presentation.rule === "base"
          ? reviewSkippedThisRound(card)
            ? checksRunningWithoutReviewSentence(checksRunningWords(checkSteps.length))
            : `${checksRunningWords(checkSteps.length)} ${LEAVE_LINE}`
          : statePresentation.helper === basePresentation.helper
            ? // GH #253: the facts the card records, where it has them.
              nowFacts(presentationState, card, {
                filesChanged: outcomePresentation.filesChanged,
                now: Date.now(),
                me: identityEmail,
                copyChanges,
              }) ?? statePresentation.helper
            : statePresentation.helper;
  // 1.171.0 (B1): where the change is, on a card that shipped or is
  // shipping. B2 (B1 Challenger leftover): a card in a release on its way
  // says where the release is.
  // B2 (Challenger 1): the target outlives the ship (`ShipEntry.target`).
  const shipTarget = shipTargetOf(card);
  const deliveryNow = cardDeliveryPath(card, presentation.rule, live.releasing, {
    appStartedAt: APP_STARTED_AT,
    now: Date.now(),
    shipping: presentationState === "shipping",
    // U29: the press under way, or (from the Review's own) what Ship it does.
    shippingToGitHub: shipPressRef.current
      ? shipPressIsGitHub(shipPressOf(shipPressRef.current.mode, shipsToGitHub), shipsToGitHub)
      : shipsToGitHub,
    target: shipTarget, localShipOnGitHub: live.localShipOnGitHub, // F3 walk (R13)
  });
  // 1.171.0 B2 (DL-04, CP-7): what Ship it will do, said before it is
  // pressed — only once where it goes is known (the result read).
  const shipItGoes =
    presentationState === "ready-to-ship" &&
    presentation.rule !== "releasing" &&
    statePresentation.actionId === "ship" &&
    statePresentation.actionLabel === "Ship it" &&
    // Only beside the state's own sentence: a failed Ship says its own.
    statePresentation.helper === basePresentation.helper
      ? primaryShipMode === "ship_it" && shipsToGitHub
        ? "github"
        : primaryShipMode === "merge_live" || workspace?.shipVia === "local" || outcomePresentation.noRemote === true
          ? "here"
          : null
      : null;
  // 1.171.0 C3 walk fix (owner 2026-10-27): after a skipped review the
  // primary opens the pull request the person merges — said so, never
  // "merges it … once GitHub's checks pass".
  const shipAnywayNow =
    presentationState === "ready-to-ship" &&
    presentation.rule !== "releasing" &&
    statePresentation.actionId === "ship" &&
    statePresentation.actionLabel === SHIP_ANYWAY_LABEL &&
    primaryShipMode === "pr_only" &&
    // Beside the state's own sentence, or the unreviewed one's (Challenger
    // 3) — never a failed Ship's.
    (statePresentation.helper === basePresentation.helper || presentation.rule === "review-truth");
  const shipSentence = shipItGoes
    ? shipItSentence(shipItGoes === "github", shipTarget)
    : shipAnywayNow
      ? shipAnywaySentence(shipTarget)
      : null;
  // B2 (DL-07, FR-20): a card shipped on GitHub says how it may go live.
  const goesLive =
    presentationState === "shipped" && deliveryNow?.stage === "shippedOnGitHub"
      ? liveSentence(shipTarget)
      : null;
  const stateHelper =
    baseHelper +
    (followUpHelper ? ` ${followUpHelper}` : "") +
    (shipSentence ? ` ${shipSentence}` : "") +
    (goesLive ? ` ${goesLive}` : "");

  /** UX-6.3/6.4: the conversation and the session are shown and hidden by
   *  the Now action, below the callout; opening one focuses its terminal. */
  /** 1.172.0 D2 (CP-23): Now's press opens the session and brings it into
   *  view; it never becomes "Hide session" — the section has its own Hide. */
  function showSession(section: "intake" | "run") {
    if (section === "run" ? sessionOpen : openSection === section) {
      reveal(section);
      return;
    }
    // C3: opened from the Review (Open the Builder), the Review stays.
    if (section === "run") openKeeping("run");
    else openOnly(section);
    focusSessionFirstTime(section);
  }

  /** 1.171.0 D2 (owner D11): the cursor goes to the terminal only at the
   *  first open of this card's session, and the move is announced. 1.172
   *  A3: Activity's Open session does the same as Now's. */
  function focusSessionFirstTime(section: "intake" | "run") {
    if (!firstSessionOpen(card.id, section)) return;
    const cardId = card.id;
    requestAnimationFrame(() => {
      const host = document.querySelector<HTMLElement>(
        `[data-ply-card-host][data-ply-card-id="${CSS.escape(cardId)}"] [data-ply-card-section="${section}"]`,
      );
      const input = host?.querySelector(".xterm-helper-textarea") as HTMLElement | null;
      if (!input) return;
      input.focus();
      markSessionOpened(cardId, section);
      setSessionFocusNote({ cardId, section, text: sessionFocusWords(section) });
    });
  }

  async function settleCardSetup(kind: "retry" | "skip") {
    const record = card.worktreeSetup;
    const allow = kind === "retry" && record?.approvalNeeded ? (record.command ?? null) : null;
    setSettlingSetup(true);
    try {
      await settleWorktreeSetup(card, kind, allow, undefined, () =>
        useBuilder
          .getState()
          .start(card.workspaceId, card.id)
          .catch(() => {
            // GH #117: the store already reported it; one toast per refusal.
          }),
      );
    } finally {
      setSettlingSetup(false);
    }
  }

  /** C3: Now's area, chosen before a press that starts or plans the card;
   *  `true` when there was none to choose or it was saved (a refusal is the
   *  store's toast). */
  async function chooseNowArea(mode: "start" | "plain" = "plain"): Promise<"go" | "chosen" | "busy" | "failed"> {
    const cardId = card.id;
    if (areaPressRef.current.has(cardId)) return "busy";
    if (areaNowFact?.kind !== "choose" || !areaPick) return "go";
    const name = areaNowFact.area;
    areaPressRef.current.set(cardId, { stop: false, armed: false });
    setAreaPresses((all) => ({ ...all, [cardId]: { area: name, saved: false, stopping: false, shown: mode === "start" } }));
    const ok = await useCardArea.getState().choose(card.workspaceId, cardId, areaPick);
    if (!ok) {
      endAreaPress(cardId);
      return "failed";
    }
    setAreaPresses((all) => {
      const p = all[cardId];
      return p ? { ...all, [cardId]: { ...p, saved: true } } : all;
    });
    return "chosen";
  }
  function endAreaPress(cardId: string) {
    areaPressRef.current.delete(cardId);
    setAreaPresses((all) => {
      if (!(cardId in all)) return all;
      const next = { ...all };
      delete next[cardId];
      return next;
    });
  }
  /** C3 (§2b): Stop while it starts in the chosen area — the area stays
   *  saved; a start not sent yet isn't sent, one under way is closed, its
   *  claim comes off and the card is back at Ready to start. Round 2
   *  (Challenger 4): a double-click's second click, a held key, or a press
   *  before Stop was armed (the first pointerup or keyup once it is on) is
   *  no Stop. */
  function stopAreaPress(event?: { detail?: number }) {
    const press = areaPressRef.current.get(card.id);
    if (!press || !press.armed || (event?.detail ?? 0) >= 2) return;
    press.stop = true;
    const cardId = card.id;
    setAreaPresses((all) => {
      const p = all[cardId];
      return p ? { ...all, [cardId]: { ...p, stopping: true } } : all;
    });
  }
  /** Stop after the start went (round 2, Challenger 2): the session
   *  closes and the card is back at Ready to start (§2b: the area stays).
   *  1.175.0 (D2): the member's name comes off the issue, and the toast
   *  says so; this computer's marker goes only with the card's copy. */
  async function undoAreaStart(ws: string, cardId: string) {
    const closed = await useBuilder.getState().close(ws, cardId);
    if (closed) await kanbanCardDeviceRelease(ws, cardId).catch(() => {});
    try {
      await useBuilder.getState().putBack(ws, cardId);
      await sayStartStopped(ws, cardId);
    } catch (err) {
      pushErrorToast("The card wasn't put back", err);
    }
  }
  /** A press that plans or builds with both: the area first, then it. */
  function afterNowArea(run: () => unknown) {
    const cardId = card.id;
    void chooseNowArea().then(async (r) => {
      if (r === "busy" || r === "failed") return;
      try {
        await run();
      } finally {
        if (r === "chosen") endAreaPress(cardId);
      }
    });
  }

  /** GH #244: as the Run step offers it — the same posture, the brief sent
   *  again; earlier snapshots stay. Tier 4 walk 2026-10-14: the vendor is
   *  Start build's (`startFreshOffer`), named when it changed. */
  function startFreshNow() {
    if (!card.builder) return;
    const fresh = startFreshOffer(card.builder.vendor, preferredVendor, card.builder.bypass);
    useBuilder.getState().setBypassPref(card.id, fresh.bypass);
    // 1.172.0 (A2): in the choice the card's Permissions shows.
    void keepShownPermissions(card, fresh.vendor)
      .then((kept) => (kept ? useBuilder.getState().start(card.workspaceId, card.id) : undefined))
      .catch(() => {
        // toast already shown by the store
      });
  }

  async function onPrimaryAction(actionId: CardPrimaryActionId) {
    setCardError(null);
    try {
      switch (actionId) {
        case "plan":
          await onConfirmIntake();
          return;
        case "plan-again":
          // N14 walk F14: the stopped conversation ends (its history is
          // kept, as replanned — F20), then a new one starts.
          await onPlanAgain();
          return;
        case "open-conversation":
          showSession("intake");
          return;
        case "start-work":
          await moveCard(card.id, "in_progress");
          return;
        case "open-plan":
          // The Chat tab, on the Plan mode with its decision bar.
          openPlanTwoAis();
          return;
        case "open-areas-settings":
          useUi.getState().openSettingsSection(AREAS_SETTINGS_SECTION);
          return;
        case "start-build":
          // SL-4: held by the card's setup — Retry (or Allow and run) from
          // the Now box; a setup under way only shows the run.
          if (setupHolds) {
            reveal("run");
            if (card.worktreeSetup?.state === "failed") await settleCardSetup("retry");
            return;
          }
          {
            // C3 (§2): "Start in Site" chooses the area, then starts — one
            // press; a second while it saves is no second start.
            const { workspaceId: ws, id: cardId } = card;
            const area = await chooseNowArea("start");
            if (area === "busy" || area === "failed") return;
            const press = areaPressRef.current.get(cardId);
            try {
              // 1.172.0 (A2): moved back to Ready to start, it starts again in
              // the choice the card shows.
              if (!(await keepShownPermissions(card, preferredVendor))) return;
              if (!(await saveBriefFirst())) return;
              if (press?.stop) return;
              await useBuilder.getState().start(ws, cardId);
              if (press?.stop) await undoAreaStart(ws, cardId);
            } catch {
              // GH #117: the store already reported it; one toast per refusal.
            } finally {
              if (area === "chosen") endAreaPress(cardId);
            }
          }
          return;
        case "inspect-run":
          // Round 3: the build asking to trust its folder is the one shown.
          if (askingTrust && trustVendor && isUndecided(card)) {
            const lane = card.buildBoth?.lanes.find((l) => l.vendor === trustVendor)?.lane;
            if (lane) useBuildBoth.getState().showLane(card.workspaceId, card.id, lane);
          }
          showSession("run");
          return;
        case "finish-and-check":
          // P-B: the Builder stopped — the session's own press, from Now.
          await finishAndCheck(card.workspaceId, card.id);
          return;
        case "allow-checks":
          // 1.175.0 B2: the OK for the checks Now shows, then they run.
          await allowChecksAndRun(card);
          return;
        case "see-queue": {
          const sourcesNow = cardLiveSourcesNow();
          // GH #257: the card has no run yet — show the Board's running and
          // queued work instead of opening this card's empty session.
          // P-A: the filter keys on the cards' words. (Challenger) A running
          // card does not always say "Working" ("Building with both", "Asks
          // to trust the folder"): the words of every card running or in
          // line now are ticked, beside the two states' own.
          useBoard.getState().setFilter(card.workspaceId, {
            states: queueFilterWords(workspaceCards, (c) => presentCard(c, cardLiveFrom(sourcesNow, c))),
          });
          useUi.getState().selectCard(card.workspaceId, null);
          return;
        }
        case "send-handed-over":
          openKeeping("run");
          // GH #129's owed findings, or GH #135's settled verdict — the
          // header offers whichever the Builder is actually owed.
          if (owedToBuilder) {
            await useBuilder.getState().sendHandedOver(card.id, owedToBuilder);
          } else if (owedVerdict) {
            await useBuilder.getState().sendVerdict(card.workspaceId, card.id, owedVerdict, "press");
          }
          return;
        case "resume-session":
          // GH #244: the session is closed or lost — a new one in the same
          // worktree, continuing; the store toasts a refusal.
          try {
            await useBuilder.getState().resume(card.workspaceId, card.id);
          } catch {
            // GH #117: the store already reported it; one toast per refusal.
          }
          return;
        case "start-fresh":
          startFreshNow();
          return;
        case "resume-work":
          if (card.linkedSwarmId) {
            await useSwarms
              .getState()
              .resume(card.workspaceId, card.linkedSwarmId);
          }
          return;
        case "inspect-checks":
        case "inspect-outcome":
          reveal("outcome");
          return;
        case "retry-work":
          // Launch G1 (Challenger P3-3): a card still In progress with its
          // worktree runs again in place, rather than hopping through To do.
          if (card.columnId === "in_progress" && card.worktreePath) {
            await moveCard(card.id, "in_progress", { redispatch: true });
            return;
          }
          if (card.columnId !== "todo") {
            await moveCard(card.id, "todo");
          }
          await moveCard(card.id, "in_progress");
          return;
        case "review-again":
          // QoL 1.168 (C5): the failed review, run again on the last build.
          reveal("outcome");
          try {
            await useBuilder.getState().reviewAgain(card.workspaceId, card.id);
          } catch {
            // The store already said why, in a toast (as The result's).
          }
          return;
        case "rerun-review":
          reveal("outcome");
          if (rerunStaleReviewRef.current) {
            await rerunStaleReviewRef.current();
          }
          return;
        case "ship":
          if (outcomeShipRef.current) {
            // GH #306: Try again repeats the press that failed.
            // M2: the way the primary ships (a closed PR's card: as a PR;
            // Try again: the press that failed).
            await outcomeShipRef.current(primaryShipMode);
          }
          return;
        case "inspect-ship":
          // 1.172.0 D2 (CP-21): a shipped card's pull request opens on
          // GitHub; one shipped without one shows its receipt (The result).
          if (presentationState === "shipped" && card.prUrl) {
            const url = card.prUrl;
            await openWebLink(url).catch((e: unknown) => pushToast(linkDidNotOpen(url, e)));
            return;
          }
          reveal("ship");
          return;
        case "view-history":
          // 1.172.0 D2 (CP-20): the card's history is its Activity.
          showActivity();
          return;
        case "refresh-skill":
          await refreshSkillCard(card.workspaceId, card.id);
          return;
        case "delete-skill-card":
          requestDelete(card);
          return;
        case "show-builds": {
          // SP-3 round 2: the builds under Now — the recommended Pick, else
          // the first Pick that can be pressed, else the section itself.
          const builds = document.querySelector<HTMLElement>(
            `[data-ply-card-host][data-ply-card-id="${CSS.escape(card.id)}"] [data-ply-build-both-compare]`,
          );
          builds?.scrollIntoView?.({ block: "start" });
          const target =
            builds?.querySelector<HTMLElement>("[data-ply-build-both-recommended] [data-ply-build-both-pick]:not(:disabled)") ??
            builds?.querySelector<HTMLElement>("[data-ply-build-both-pick]:not(:disabled)") ??
            builds;
          target?.focus();
          return;
        }
        // v1.154.1 (F14, F18): the pull request's own presses; what they
        // did is said in the Shipping section they open.
        case "pr-fix":
          await useBuilder.getState().fixFromGitHub(card.workspaceId, card.id);
          return;
        case "ship-conflict-ask":
          // P-E: Plyloft starts the merge in the card's copy; the Builder
          // resolves it. The store says how it went.
          await useBuilder.getState().resolveShipConflict(card.workspaceId, card.id);
          return;
        case "pr-push-update":
          reveal("ship");
          setPrPress("push");
          try {
            await prActionsRef.current?.pushUpdate();
          } finally {
            setPrPress(null);
          }
          return;
        case "pr-auto-merge-off":
          // 1.174.0 A2 (P7): Merge when checks pass off; what GitHub said
          // is in the Shipping section it opens.
          reveal("ship");
          setPrPress("auto");
          try {
            await prActionsRef.current?.autoMergeOff();
          } finally {
            setPrPress(null);
          }
          return;
        case "pr-open-github":
          // 1.169.1 (R1): the review GitHub requires happens there.
          if (card.prUrl) {
            const url = card.prUrl;
            await openWebLink(url).catch((e: unknown) => pushToast(linkDidNotOpen(url, e)));
          }
          return;
        case "release-open-github":
          // 1.170 walk: the release pull request the card is in.
          if (live.releasing?.url) {
            const url = live.releasing.url;
            await openWebLink(url).catch((e: unknown) => pushToast(linkDidNotOpen(url, e)));
          }
          return;
        case "pr-merge":
          reveal("ship");
          setPrPress("merge");
          try {
            await prActionsRef.current?.merge();
          } finally {
            setPrPress(null);
          }
          return;
        case "pr-merge-github-head":
          // G1–G3 Challenger (2): the person's decision to merge commits
          // Plyloft didn't push.
          reveal("ship");
          setPrPress("merge");
          try {
            await prActionsRef.current?.mergeGitHubHead();
          } finally {
            setPrPress(null);
          }
          return;
      }
    } catch (error) {
      // UX-6.8: a press that failed says so on the card, in the error shape.
      if (actionId === "ship") failShip(shipPressOf(primaryShipMode, shipsToGitHub), error);
      else {
        // QoL 1.168 (C4): its Try again repeats this press.
        const failed = actionFailedError(statePresentation.actionLabel, error, {
          retry: true,
          // R11 (Challenger): the pull request's own presses talk to GitHub.
          github:
            actionId === "pr-push-update" ||
            actionId === "pr-merge" ||
            actionId === "pr-merge-github-head" ||
            actionId === "pr-auto-merge-off" ||
            actionId === "pr-fix",
          githubPage: githubPageRef.current,
        });
        cardFailureRef.current = { error: failed, cause: error, retry: () => void onPrimaryAction(actionId) };
        setCardError(failed);
      }
    }
  }

  useEffect(() => {
    // N19: a card Follow up just opened starts on its brief. 1.174.0 C4:
    // so does a card made from a copy while its brief is empty.
    const onBrief = takeBriefFocus(card.id) || copyBriefEmpty(card, card.notes ?? "");
    const frame = requestAnimationFrame(() => {
      const brief = onBrief
        ? document.querySelector<HTMLTextAreaElement>(
            `[data-ply-card-host][data-ply-card-id="${CSS.escape(card.id)}"] textarea.ux-card-brief`,
          )
        : null;
      // 1.174.0 (C1, Challenger 2): a built card's brief is folded — Show
      // it (committed now, so it is focusable at once), then the cursor.
      if (brief?.closest("[hidden]")) flushSync(() => setBriefShown(true));
      if (!focusBrief(brief)) stateHeadlineRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [card.id]);

  useEffect(() => {
    function onPrimaryShortcut(event: KeyboardEvent) {
      // OB-4: nothing under Setup answers a key while it is up.
      if (setupIsOpen()) return;
      if (event.key !== "Enter" || !modOnly(event)) return;
      // Challenger on a pull request: its Now has no primary to press.
      if (card.prReview) return;
      const ui = useUi.getState();
      if (useWorkspaces.getState().activeId !== card.workspaceId) return;
      if (ui.selectedCardId[card.workspaceId] !== card.id) return;
      const cardModeActive =
        effectiveCenterMode(ui.centerMode, card.workspaceId) === "board";
      const target = event.target as HTMLElement | null;
      const host = target?.closest<HTMLElement>(
        `[data-ply-card-host][data-ply-card-id="${CSS.escape(card.id)}"]`,
      );
      const dialogOwnsCommand = Boolean(
        target?.closest('.ux-sheet-backdrop, [role="dialog"][aria-modal="true"]'),
      );
      const focusCategory: InstalledSelfCheckActionTraceInput["focusCategory"] =
        target?.closest(".xterm")
          ? "xterm"
          : target?.closest(".cm-editor")
            ? "code_mirror"
            : target?.closest("input")
              ? "input"
              : target?.closest("textarea")
                ? "textarea"
                : target?.closest(
                      '[contenteditable]:not([contenteditable="false"])',
                    )
                  ? "contenteditable"
                  : host
                    ? "card_background"
                    : "outside_card";
      const guarded =
        !cardModeActive ||
        dialogOwnsCommand ||
        focusCategory !== "card_background";
      if (guarded || statePresentation.actionId === "ship") {
        reportInstalledSelfCheckActionTrace({
          state: presentationState,
          actionId: statePresentation.actionId,
          source: "keyboard",
          focusCategory,
          primaryActionInvocations: 0,
          shipInvocations: 0,
        });
        return;
      }
      if (!host) return;
      const action = host.querySelector<HTMLButtonElement>(
        "[data-ply-primary-action-id]",
      );
      if (!action || action.disabled) return;
      event.preventDefault();
      primaryInvocationRef.current = {
        source: "keyboard",
        focusCategory,
      };
      try {
        action.click();
      } finally {
        primaryInvocationRef.current = null;
      }
    }
    document.addEventListener("keydown", onPrimaryShortcut, true);
    return () =>
      document.removeEventListener("keydown", onPrimaryShortcut, true);
  }, [
    card.id,
    card.workspaceId,
    card.prReview,
    presentationState,
    statePresentation.actionId,
  ]);

  // ── UX-6.3: the session in words ─────────────────────────────────────
  // Ply keeps no transcript of the Builder (the vendor's TUI in a PTY), so
  // the callout says what the session reports: started, last output, at its
  // prompt. A slow tick keeps "12m ago" true while something runs.
  const builderRt = useBuilder((s) => s.byCard[card.id]);
  // 1.172.0 walk (E1): "The cursor is in the session now…" goes when that
  // session closes or ends (or its section is hidden), not left behind.
  const sessionFocusNoteShown = sessionFocusNoteHolds(sessionFocusNote, {
    cardId: card.id,
    runOpen: sessionOpen && Boolean(card.builder?.ptyId) && !card.builder?.sessionLost,
    intakeOpen: openSection === "intake" && Boolean(intakePtyId),
  });
  const sessionFocusNoteSet = sessionFocusNote.section != null;
  useEffect(() => {
    if (sessionFocusNoteSet && !sessionFocusNoteShown) setSessionFocusNote({ cardId: "", section: null, text: "" });
  }, [sessionFocusNoteSet, sessionFocusNoteShown]);
  // 2026-10-15: a message of Plyloft's waits on the member's `!` or `/`
  // draft — Now says so, the session panel open or not.
  const draftHold = draftHoldNotice(
    builderRt,
    // 1.174.5: the self-check and a verdict wait outside the held messages.
    useBuilder((s) => Boolean(s.selfCheck[card.id] && s.selfCheck[card.id]?.deliveredAt == null)) || owedVerdict != null,
  );
  const fixBusy = useBuilder((s) => s.fixBusy[card.id] ?? null);
  // F16: Start build pressed and on its way.
  const starting = useBuilder((s) => s.startBusy[card.id] ?? false);
  // Windows walk of 1.160.0: a first start that sets the repository up says
  // so through the wait, and the button stays off meanwhile.
  const settingUp = useSettingUp((s) => Boolean(s.byCard[card.id]));
  // C3 (§2b): the press drawn on its own card's page, until a long setup
  // takes over with its own Stop and Retry (round 2, Challenger 3).
  const areaPress =
    areaPressOfCard?.shown && !settingUp && card.worktreeSetup?.state !== "running" ? areaPressOfCard : null;
  const areaStopOn = Boolean(areaPress?.saved && !areaPress.stopping);
  useEffect(() => {
    if (!areaStopOn) return;
    // Stop is armed by the first pointerup or keyup once it is on — not the
    // release of the press that chose the area, nor a held key.
    const cardId = card.id;
    const arm = (e: Event) => {
      if (e instanceof KeyboardEvent && e.repeat) return;
      const press = areaPressRef.current.get(cardId);
      if (press) press.armed = true;
      window.removeEventListener("pointerup", arm, true);
      window.removeEventListener("keyup", arm, true);
    };
    window.addEventListener("pointerup", arm, true);
    window.addEventListener("keyup", arm, true);
    return () => {
      window.removeEventListener("pointerup", arm, true);
      window.removeEventListener("keyup", arm, true);
    };
  }, [areaStopOn, card.id]);
  const builderError = useBuilder((s) => s.errorByCard[card.id]);
  // Tier 4 walk 2026-10-14: a Builder press's failure belongs to the session
  // it was pressed on. A new session (started from here, the Run step, Build
  // with both or anywhere else) answers it, so the old block goes.
  const sessionStartedAt = card.builder?.startedAt ?? null;
  const seenSession = useRef({ cardId: card.id, at: sessionStartedAt });
  useEffect(() => {
    const seen = seenSession.current;
    seenSession.current = { cardId: card.id, at: sessionStartedAt };
    // Another card on this page is not a new session of this one.
    if (seen.cardId !== card.id || seen.at === sessionStartedAt) return;
    useBuilder.getState().clearError(card.id);
  }, [card.id, sessionStartedAt]);
  // 1.174.4: "Area App sends its cards to the branch staging" stops being true
  // once the card's area sends them elsewhere.
  useEffect(() => {
    const branch = areaState?.area?.branch?.trim();
    if (builderError?.missingBranch && branch && branch !== builderError.missingBranch) {
      useBuilder.getState().clearError(card.id);
    }
  }, [areaState?.area?.branch, builderError?.missingBranch, card.id]);
  // Block C: a Resume that found no conversation is Now's to say. Forgotten once
  // Now says it, or it would come back as a fresh failure when Now moves on
  // (Move back to Ready to start, Finish and check). A pull request review's
  // Now doesn't say it, and neither does one whose reload failed: those keep it.
  const resumeNowTookOver =
    builderError != null && resumeFoundNothing(builderError.cause) && nowSaysResumeFailed(card, presentation.sentence);
  useEffect(() => {
    if (resumeNowTookOver) useBuilder.getState().clearError(card.id);
  }, [resumeNowTookOver, card.id]);
  const [, setTick] = useState(0);
  const ticking = Boolean(card.builder?.ptyId) || presentationState === "running";
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [ticking]);
  // CL-7: "building" turns to "waiting for you" when the session has been
  // silent for SILENCE_MS — a moment no store change marks. One timer at
  // that moment redraws the callout then, instead of up to a tick later.
  // Round 2 (F3): the two builds' sessions too, while both build — the
  // earliest silence still to come.
  const silentAt =
    [builderRt, laneA, laneB]
      .map((rt) => (rt?.lastOutputAt != null ? rt.lastOutputAt + SILENCE_MS : null))
      .filter((at): at is number => at != null && at > Date.now())
      .sort((x, y) => x - y)[0] ?? null;
  useEffect(() => {
    if (!ticking || silentAt == null) return;
    const wait = silentAt - Date.now();
    if (wait < 0) return;
    const id = window.setTimeout(() => setTick((n) => n + 1), wait + 50);
    return () => window.clearTimeout(id);
  }, [ticking, silentAt]);
  const nowMs = Date.now();
  const sessionAttached =
    Boolean(card.builder?.ptyId) && builderRt?.ptyId === card.builder?.ptyId;
  const sessionAttention =
    sessionAttached && builderRt
      ? deriveTileAttention(
          {
            kind: builderRt.vendor,
            status: "running",
            startedAt: builderRt.startedAt,
            lastOutputAt: builderRt.lastOutputAt,
            promptBoxIdle: builderRt.promptBoxIdle,
            questionInView: builderRt.questionInView,
          },
          nowMs,
        )
      : null;
  // v1.154.1 round 3 (RW-A): the fix round says what the session is doing,
  // as the Builder header does.
  const fixRoundWords =
    statePresentation.label === FIX_SENT_LABEL && card.pr && card.builder
      ? prFixRoundLine(
          card.pr.number,
          card.builder.vendor === "codex" ? "Codex" : "Claude",
          sessionAttention === "working" || sessionAttention === "asking-you" || sessionAttention === "wants-you"
            ? sessionAttention
            : null,
          builderRt?.turnIdle === true,
          live.fixRoundByItself !== false,
        )
      : null;
  // CL-7: who is working, said truly, as the Now callout's title — "Claude ·
  // building · 4m" while the live session works, "Claude · waiting for
  // you" at its prompt, "Codex · reviewing · 2m" during the review. Only
  // where the callout says the plain state (no trust question, hold, setup
  // or ship failure has taken it over); Plyloft's own phases keep their
  // words, and the Board keeps "Working · 6m".
  // P-B: Finish and check from Now is off while it (or its self-check) runs.
  const finishBusy = useBuilder((s) => Boolean(s.doneBusy[card.id]) || Boolean(s.selfCheck[card.id]));
  const builderSentAt = useBuilder((s) => s.sentAt[card.id] ?? null);
  const builderDoneAt = useBuilder((s) => s.doneAt[card.id] ?? null);
  const builderSubmittedAt = useBuilder((s) => s.submittedAt[card.id] ?? null);
  // T2 (team walk 2026-10-02): someone else holds the issue and this Mac has
  // not run the card — Now says who, as the Board tile does, and Start
  // build's tooltip says it asks first.
  const claim = useCardClaim(card);
  // 1.173.0 (C2): another of this person's computers took it.
  const otherDevice = useOtherDeviceWords(card);
  // N14 (items 4, 6): who the card's GitHub facts are seen from, and the
  // pull requests linked to its issue (a teammate's "Closes #21").
  const claimLogin = useClaimLogin(card.workspaceId);
  const linkedPrs = useLinkedPullRequests(card, workspace?.kanbanSyncMode === "githubIssues");
  // UX P-A Mac walk 7: while the Challenger reviews, Now says the state's
  // word ("Challenger reviewing"), as the Board, the List and Status do —
  // not the actor's "Codex · reviewing".
  const actor =
    presentationState === "running" &&
    !bothNow &&
    !askingTrust &&
    !held &&
    statePresentation.label === basePresentation.label
      ? cardActor({
          card,
          live: builderRt ?? null,
          sentAt: builderSentAt,
          submittedAt: builderSubmittedAt,
          doneAt: builderDoneAt,
          now: nowMs,
        })
      : null;

  // P-B: a Builder waiting on the person says rule 9's sentence (when to
  // press Finish and check), not the session's running line.
  const sessionWords =
    presentationState === "running" &&
    card.builder &&
    !askingTrust &&
    presentation.rule !== "builder-waiting" &&
    // 1.171.0 C2: after Finish and check the wait's sentence speaks.
    presentation.rule !== "finishing"
      ? sessionSummary({
          vendor: card.builder.vendor,
          attention:
            sessionAttention === "working" ||
            sessionAttention === "asking-you" ||
            sessionAttention === "wants-you"
              ? sessionAttention
              : null,
          turnIdle: builderRt?.turnIdle === true,
          startedAt: card.builder.startedAt,
          lastOutputAt: builderRt?.lastOutputAt ?? null,
          filesChanged: outcomePresentation.filesChanged,
          // CL-11 (walk b): the line agrees with the title's live state.
          actor: actor?.session,
          turnInterrupted: builderRt?.turnInterrupted === true,
          now: nowMs,
        })
      : null;

  // 1.171.0 C2 (CF3, CF16): after Finish and check, Now's title says what
  // is happening and for how long (the self-check, the checks, the review).
  const waitNow = actor
    ? null
    : waitLine({
        rule: presentation.rule,
        state: presentationState,
        headline: statePresentation.label,
        card,
        selfCheck: live.session?.selfCheck ?? null,
      });

  // GH #306: a Ship that didn't go through is a failure's amber, not done.
  // P-A: the dot is `presentCard`'s, as on the Board, but for who works.
  const run = actor ? { state: actor.dot, live: actor.dot === "running" } : presentation.dot;
  // 1.172.0 D2 (CP-23): the primary never turns into a Hide.
  const primaryLabel =
    statePresentation.actionId === "finish-and-check" && finishBusy
        ? FINISH_BUSY_LABEL
        : // 1.172.0 (C1): Build with both is Start build ▾'s, so the
          // primary says the two builds are starting.
          statePresentation.actionId === "start-build" && bothBusy
          ? settingUp
            ? "Setting up…"
            : "Starting both…"
          : statePresentation.actionId === "start-build" && settingUp
          ? "Setting up…"
          : statePresentation.actionId === "start-build" && (starting || briefSaving)
          ? "Starting…"
          : statePresentation.actionId === "ship-conflict-ask" && fixBusy
            ? fixBusy === "gathering"
              ? "Starting the merge…"
              : "Queued for the Builder"
          : statePresentation.actionId === "pr-fix" && fixBusy
            ? fixBusy === "gathering"
              ? "Gathering…"
              : "Queued for the Builder"
            : (statePresentation.actionId === "pr-merge" || statePresentation.actionId === "pr-merge-github-head") &&
                (prPress === "merge" || shippingBusy === "merge")
              ? "Merging…"
              : statePresentation.actionId === "pr-push-update" && (prPress === "push" || shippingBusy === "push")
                ? "Sending…"
                : statePresentation.actionId === "pr-auto-merge-off" && (prPress === "auto" || shippingBusy === "auto")
                  ? "Turning off…"
                  : statePresentation.actionId === "start-fresh" && card.builder
                    ? startFreshOffer(card.builder.vendor, preferredVendor, card.builder.bypass).label
                    : statePresentation.actionLabel;

  shipAsRef.current = (mode, followUp) => shipAs(mode, followUp);
  /** `remember`: 1.171.0 B3 — Ship ▾'s pull request choices write the
   *  workspace's remembered merge when checks pass (`ShipRunner`). */
  async function shipAs(mode: ShipMode, followUp = false, remember?: boolean) {
    const options =
      followUp || remember !== undefined ? { ...(followUp ? { followUp: true } : {}), ...(remember !== undefined ? { remember } : {}) } : undefined;
    // 1.176.2 F2 (review F2): a Ship of this card still running keeps its
    // own record (where it goes, its error); this press is only answered.
    if (pressRunning(shipPressKey(card.workspaceId, card.id))) {
      await outcomeShipRef.current?.(mode, options);
      return;
    }
    setCardError(null);
    shipPressRef.current = { mode, followUp };
    try {
      await outcomeShipRef.current?.(mode, options);
    } catch (error) {
      failShip(shipPressOf(mode, shipsToGitHub), error);
    } finally {
      shipPressRef.current = null;
    }
  }

  // v1.154.1 (walk F23): Build with both where Start build is offered, not
  // only in the run section, which a card never built can't open. The Now
  // box offers it only when both CLIs are known to run here (the Doctor has
  // read this Mac) and not on the guided first card; the card's ⋯ always
  // has it on a card not built yet — off, with the reason under it, when
  // Claude or Codex can't run.
  const bothShown =
    statePresentation.actionId === "start-build" &&
    !held &&
    (bothOffer.offered || bothOffer.reason !== null);
  // 1.172.0 (C1; CP-11, CF B4): Build with both is Start build ▾'s other
  // way — off, with the reason under it, when Claude or Codex can't run. The
  // guided first card keeps its one way forward: there it stays in the ⋯.
  const bothInStartMenu = bothShown && !onGuidedFirstCard && !card.prReview;
  const bothOff =
    !bothOffer.offered || bothBusy || starting || briefSaving || settingUp || card.intakeStatus === "active";
  const startBothNow = () =>
    void saveBriefFirst().then((saved) => (saved ? startBoth(card.workspaceId, card.id) : undefined));

  // N19 (owner decision 2026-10-06): a shipped card (shipped, or its pull
  // request merged; archived too) is followed up by a new card in To do,
  // linked both ways — never worked on again in place.
  const followUpCardOffered = followUpCardIsOffered(card, presentationState, githubOwnedReadOnly);
  async function onFollowUp() {
    if (followingUp) return;
    // One waiting follow-up at a time: an existing one not started yet
    // (Follow up's, or Ship with follow-up's) is opened instead.
    const waiting = openFollowUp(card, workspaceCards);
    if (waiting) {
      selectCard(card.workspaceId, waiting.id);
      focusFollowUpBrief(waiting.id);
      pushToast({ kind: "info", title: existingFollowUpWords(waiting.title) });
      return;
    }
    // 1.171.0 (E2; walk 2026-10-27 #6): the suggestion first, made on
    // the sheet's Make the card.
    setFollowUpAsk(followUpDraft(card, Date.now()));
  }
  async function makeFollowUp(chosen: { title: string; notes: string }) {
    if (followingUp) return;
    setFollowingUp(true);
    try {
      const made = await followUpCard(card.workspaceId, card.id, chosen.title, chosen.notes);
      setFollowUpAsk(null);
      selectCard(card.workspaceId, made.id);
      focusFollowUpBrief(made.id);
      pushToast({
        kind: "info",
        title: "Follow-up card made",
        body: followUpAskLeft(chosen.notes)
          ? `“${made.title}” is ready to start. Say what should change now, then start it.`
          : `“${made.title}” is ready to start.`,
      });
    } catch {
      // The store said why; the sheet stays with what was written.
    } finally {
      setFollowingUp(false);
    }
  }

  // 1.172.0 (C2; CP-3, CP B2): Ready to ship — Now is Ship it ▾ and one
  // quiet Read the review; See the changes, Try it and Not right are the
  // Review's, which ends on the same Ship it ▾.
  const readyToShipNow =
    presentationState === "ready-to-ship" && statePresentation.actionId === "ship" && !card.prReview && !card.archived;
  // Try it TI-4 (D18): once the card's copy has changes — in Now beside the
  // alternative, or (1.172.0 C2: never both) in the Review on a card Ready
  // to ship.
  const tryOffered = tryItOffered(card, presentationState, isUndecided(card));
  const tryIt: SecondaryAction | undefined = tryOffered && !readyToShipNow
    ? {
        label: TRY_IT_LABEL,
        title: "Start your app in the card's copy and see it here.",
        onAction: () => pressTryIt(card, tryLane),
      }
    : undefined;

  // QoL 1.168 (C3, V-3): where "ship this?" is decided, the changes are one
  // press away — Ready to ship, Changes requested, a Ship that didn't go
  // through — and the same press hides them again.
  const seeChanges: SecondaryAction | undefined =
    !card.prReview &&
    !card.archived &&
    diffOffer != null &&
    !readyToShipNow &&
    (presentationState === "ready-to-ship" || presentationState === "changes-requested" || shipFailure != null)
      ? {
          label: diffShown ? "Hide the changes" : "See the changes",
          title: "The files this card changes, line by line.",
          onAction: () => (diffShown ? closeDiff() : openDiff()),
        }
      : undefined;

  // 1.171.0 C1 (CF1): a fix round's Builder at work or done — Ship and Not
  // right wait for its Finish and check again. The pushback stays: beside it
  // once its turn is over (it may disagree), in ⋯ while it works
  // (Challenger 1).
  function onAcceptPushback() {
    setAcceptingPushback(true);
    void useBuilder
      .getState()
      .acceptPushback(card.workspaceId, card.id)
      .catch(() => {
        // toast already shown by the store
      })
      .finally(() => setAcceptingPushback(false));
  }
  // 1.171.0 C3 (CF2, CF18, CP-9): the one override, named by its case —
  // the Builder had the findings (nothing is owed to it: it may disagree,
  // and the person sides with it), or they never reached it (the person
  // ships over them). A pull request review's fix card is always its
  // Builder's case: nothing ships from it (Send the fixes to GitHub does).
  const builderAi = card.builder?.vendor === "codex" ? "Codex" : "Claude";
  const builderHadFindings = Boolean(card.prReview) || owedVerdict == null;
  const overrideLabel = builderHadFindings ? agreeWithBuilderLabel(builderAi) : SHIP_WITHOUT_CHANGES_LABEL;
  const overrideTitle = builderHadFindings ? agreeWithBuilderTitle(builderAi) : SHIP_WITHOUT_CHANGES_TITLE;
  const fixRoundNow =
    presentation.rule === "builder-fixing" ||
    (presentation.rule === "builder-waiting" && presentation.waiting !== "question" && presentationState !== "running");
  // 1.172.0 (A2, owner): a fix that runs without the person — a try of Fix
  // failing checks by itself, or a fix round Plyloft sent — waiting on a
  // Builder that asks before every change says so under Now.
  const autoFixPhase = usePrAutoFix((s) => s.phases[card.id] ?? null);
  const autoFixDefault = autoFixDefaultSince(workspace);
  const autoFixWaits =
    !card.prReview &&
    autoFixOn(card, autoFixDefault) &&
    (autoFixPhase != null || autoFixStoppedNow(card.pr)?.reason === "question");
  // UX-6.2: at most one quiet alternative beside the primary.
  let secondary: SecondaryAction | undefined;
  /** SP-2: Now's alternative is "Not right"; the result draws no second one. */
  let redoInNow = false;
  /** Challenger block 5 (item 6): Now's alternative is Ask the Builder to
   *  fix them; the result's Checks draw no second one. */
  let fixInNow = false;
  if (setupNow && setupNow.hold !== "running") {
    secondary = {
      label: "Start anyway",
      title: "Starts the Builder without the setup. What it printed stays on the card.",
      disabled: settlingSetup,
      onAction: () => void settleCardSetup("skip"),
    };
  } else if (statePresentation.actionId === "review-again") {
    // QoL 1.168 (C5): Review again leads; shipping unreviewed is second.
    secondary = {
      // 1.171.0 B3 (LG-03): on GitHub the label says the person merges it.
      label: shipsToGitHub ? SHIP_ANYWAY_LABEL : "Ship anyway",
      // G1 Challenger (1): unreviewed, it never merges by itself.
      title: shipAnywayTitle(shipsToGitHub),
      disabled: outcomePresentation.shipBusy,
      onAction: () => void shipAs(shipWithoutAutoMergeMode(shipsToGitHub)),
    };
  } else if (handedOverHeader && presentationState === "ready-to-ship") {
    secondary = {
      label: shipsToGitHub ? SHIP_ANYWAY_LABEL : "Ship anyway",
      // G1 Challenger (1): findings not re-checked never merge by themselves.
      title: shipAnywayHandedOverTitle(shipsToGitHub),
      disabled: outcomePresentation.shipBusy,
      onAction: () => void shipAs(shipWithoutAutoMergeMode(shipsToGitHub)),
    };
  } else if (presentation.rule === "check-stopped" && card.builder) {
    // 1.171.0 C2: Finish and check again leads; Resume is the way to have
    // the Builder re-read its work first.
    const ai = card.builder.vendor === "codex" ? "Codex" : "Claude";
    secondary = {
      label: "Resume",
      title: `Opens ${ai}'s session again in the card's copy; Finish and check there has it re-read its work first.`,
      disabled: false,
      onAction: () => {
        void useBuilder
          .getState()
          .resume(card.workspaceId, card.id)
          .catch(() => {
            // toast already shown by the store
          });
      },
    };
  } else if (presentationState === "changes-requested" && card.builder && presentation.rule !== "builder-fixing") {
    secondary = {
      label: overrideLabel,
      title: overrideTitle,
      disabled: acceptingPushback,
      onAction: onAcceptPushback,
    };
  } else if (presentationState === "session-closed" && card.builder) {
    const fresh = startFreshOffer(card.builder.vendor, preferredVendor, card.builder.bypass);
    // U16: a Resume that found nothing leaves Start fresh to lead and Resume
    // beside it; otherwise Resume leads.
    secondary =
      statePresentation.actionId === "start-fresh"
        ? {
            label: "Resume",
            title: "New session in the card's copy, continuing the previous conversation",
            disabled: false,
            onAction: () => void onPrimaryAction("resume-session"),
          }
        : {
            label: fresh.label,
            title: fresh.title,
            disabled: false,
            onAction: startFreshNow,
          };
  } else if (intakeStopped) {
    secondary = {
      label: "Stop planning",
      title: "End the stopped conversation. The card's brief stays as it is.",
      disabled: false,
      onAction: () => void onCancelIntake(),
    };
  } else if (presentationState === "intake-live") {
    secondary = {
      label: intakeConcluding ? "Finishing…" : FINISH_PLANNING_LABEL,
      title: `Ask ${vendorName(planner)} to write the plan now and end the conversation.`,
      disabled: intakeConcluding || !intakePtyId,
      onAction: () => void onConcludeIntake(),
    };
  } else if (presentationState === "verify-failed" && card.builder && !card.archived && !card.prReview) {
    // QoL 1.168 (C2): the failing checks' output goes to the Builder —
    // nobody copies a log by hand.
    fixInNow = true;
    secondary = {
      label: askingFix ? "Sending…" : ASK_BUILDER_FIX_CHECKS_LABEL,
      title: askBuilderFixChecksTitle(live.fixRoundByItself !== false),
      disabled: askingFix,
      onAction: () => {
        setAskingFix(true);
        void askBuilderToFixChecks(card).finally(() => setAskingFix(false));
      },
    };
  } else if (
    !card.archived &&
    !readyToShipNow &&
    presentation.rule !== "changes-sent" &&
    !fixRoundNow &&
    (presentationState === "ready-to-ship" ||
      presentationState === "result-ready" ||
      presentationState === "no-changes")
  ) {
    redoInNow = true;
    secondary = {
      label: "Not right",
      title: notRightWords(changesRoute(card)).title,
      disabled: outcomePresentation.shipBusy,
      onAction: () => {
        reveal("outcome");
        outcomeRedoRef.current?.();
      },
    };
  } else if (followUpCardOffered) {
    // N19: a shipped card's way to more work — a new card, linked.
    secondary = {
      label: followingUp ? "Making the card…" : FOLLOW_UP_LABEL,
      title: FOLLOW_UP_TITLE,
      disabled: followingUp,
      onAction: () => void onFollowUp(),
    };
  }
  // 1.175.0 F5: Don't check by itself / Stop (fixRoundNow.ts; for F8/F10 to re-place).
  secondary = fixRoundSecondary(card, presentation.rule) ?? secondary;
  // 1.172.0 (C1; CP-11, CF B4): before the build, Now has Start build and
  // one menu, Plan it first ▾ — Build with both is Start build ▾'s other way
  // (`startVariants`), never a second button beside it.
  // The plan is the one way on: no Build with both or another planner.
  if (planWords) {
    secondary = undefined;
    fixInNow = false;
  }

  // UX-6.6: the primary Ship is "Ship it ▾"; its menu holds the other ways.
  // 1.171.0 B3 (LG-04, CP-6): one Ship ▾ in every mode — merge when checks
  // pass, pull request only, only on this Mac — the one Ship it makes now
  // ticked (a press on any ships that way). A project that can't take a
  // pull request has only the land here — the primary itself. The pull
  // request choices write the workspace's remembered "merge when checks
  // pass" (`mergeWhenChecksPass`), which a `pr` ship follows.
  const noPullRequest = outcomePresentation.noRemote === true;
  const shipChoiceNow = currentShipChoice(
    workspace?.shipVia,
    noPullRequest ? false : outcomePresentation.prOffered ? true : null,
  );
  // Only one way (no pull request to open): the primary is it, so no ▾ —
  // Now says why under it (CL-11).
  const shipChoices = shipChoicesOffered(noPullRequest);
  // Challenger 1: with no approved review nothing merges by itself (Rust's
  // `ship_auto_merge_guarded`), so the two pull request choices are one,
  // never ticked — as The result says it.
  const shipVariants: MenuItem[] | undefined =
    statePresentation.actionId === "ship" && shipChoices.length > 1 && prShipNow.kind === "anyway"
      ? [
          {
            label: SHIP_ANYWAY_LABEL,
            checked: false,
            disabled: outcomePresentation.shipBusy,
            hint: prShipNow.note,
            onSelect: () => void shipAs("pr_only"),
          },
          {
            label: SHIP_CHOICE_LABELS["only-here"],
            checked: shipChoiceNow === "only-here",
            disabled: outcomePresentation.shipBusy,
            hint: shipChoiceHint("only-here", card.worktreeBase?.refName),
            onSelect: () => void shipAs("merge_live"),
          },
        ]
      : statePresentation.actionId === "ship" && shipChoices.length > 1
      ? shipChoices.map((choice) => {
          const pr = choice !== "only-here";
          return {
            label: SHIP_CHOICE_LABELS[choice],
            checked: choice === shipChoiceNow,
            disabled: outcomePresentation.shipBusy || (pr && prShipNow.kind === "wait"),
            hint: pr && prShipNow.kind === "wait" ? prShipNow.note : shipChoiceHint(choice, card.worktreeBase?.refName),
            onSelect: () =>
              void shipAs(shipChoiceMode(choice, shipsToGitHub), false, shipChoiceRemembers(choice) ?? undefined),
          };
        })
      : undefined;

  // Challenger block 5 (item 2): after a failed review, Review again leads
  // and Ship anyway is beside it; the other way to ship it unreviewed stays
  // one press away, in the primary's menu. 1.171.0 B3 (LG-03): it never
  // merges by itself, and its label says so.
  const reviewAgainVariants: MenuItem[] | undefined =
    statePresentation.actionId === "review-again" && shipsToGitHub
      ? [
          {
            label: ONLY_HERE_LABEL,
            disabled: outcomePresentation.shipBusy,
            hint: onlyHereHint(card.worktreeBase?.refName),
            onSelect: () => void shipAs("merge_live"),
          },
        ]
      : statePresentation.actionId === "review-again" && !noPullRequest
      ? [
          {
            label: SHIP_ANYWAY_LABEL,
            disabled: outcomePresentation.shipBusy || prShipNow.kind === "wait",
            hint: prShipNow.kind === "plain" ? undefined : prShipNow.note,
            onSelect: () => void shipAs("pr_only"),
          },
        ]
      : undefined;

  // UX P1 point 7 (P-E): the conflict's other ways — Ship again beside
  // "Ask the Builder to resolve it"; once the merge is started, the message
  // again (a delivery that failed).
  const mergeStarted = conflictMergeStarted(card);
  // 1.170.0 (G6): a clean Bring in waits in the card's copy for Finish and
  // check; it can be undone too.
  const broughtIn = useTargetSync((s) => Boolean(s.byWorkspace[card.workspaceId]?.cards[card.id]?.merging));
  // 1.173.0 (B3): the card's area, in a repository with two areas or more.
  const areaProperty = useCardAreaProperty(card);
  // 1.174.0 (C2, BCI-11): the area is chosen under Change…; a press of
  // Start or Ship that had to ask opens it there.
  const areaChoosableHere = useCardAreaChoosable(card.id);
  const areaAsked = useCardArea((s) => s.asked[card.id]);
  useEffect(() => {
    if (!areaAsked) return;
    // C3: where Now asks, the press that had to ask lands on its select;
    // otherwise (a started card) on Change…'s.
    const nowAsk = document.querySelector<HTMLSelectElement>(
      `[data-ply-card-host][data-ply-card-id="${CSS.escape(card.id)}"] [data-ply-now-area] select`,
    );
    if (nowAsk) {
      nowAsk.focus();
      useCardArea.setState((s) => ({ asked: { ...s.asked, [card.id]: undefined } }));
    } else setPickersOpen(true);
  }, [areaAsked]);
  // Put away, the ask is answered: the card shown again doesn't reopen it.
  const clearAreaAsk = () => {
    if (useCardArea.getState().asked[card.id] === undefined) return;
    useCardArea.setState((s) => ({ asked: { ...s.asked, [card.id]: undefined } }));
  };
  const conflictSync = Boolean(shipConflictOf(card)?.sync);
  // 1.170.0 (G6, Challenger): a bring-in's conflict can be dropped at any
  // point — before the merge is started for the Builder too, and on an
  // open pull request's card, where it is kept beside its status.
  const syncRecord = card.shipConflict?.sync ? card.shipConflict : null;
  const leaveOut = syncRecord ? leaveOutLabel(syncRecord.branch) : null;
  async function undoConflictMerge() {
    if (
      await confirmSheet(
        leaveOut
          ? {
              title: `${leaveOut}?`,
              body: "The card's copy goes back to how it was before you brought them in, and the Builder's edits to the conflicting files since the merge started are dropped. The card's own work is kept; you can bring them in again later.",
              confirmLabel: leaveOut,
            }
          : {
              title: "Undo the merge?",
              body: "The merge stops in the card's copy, and the Builder's edits to the conflicting files since it started are dropped. The card's own work is kept.",
              confirmLabel: UNDO_MERGE_LABEL,
            },
      )
    ) {
      await useBuilder.getState().undoShipConflictMerge(card.workspaceId, card.id);
      void useTargetSync.getState().refresh(card.workspaceId, false);
    }
  }
  const conflictVariants: MenuItem[] | undefined =
    statePresentation.actionId === "ship-conflict-ask" && !conflictSync
      ? [
          {
            label: SHIP_AGAIN_LABEL,
            hint: "If you resolved it yourself in the card's copy.",
            disabled: outcomePresentation.shipBusy,
            onSelect: () => void shipAs("merge_live"),
          },
        ]
      : mergeStarted && presentation.rule === "changes-sent" && card.builder
        ? [
            {
              label: SEND_AGAIN_LABEL,
              hint: "The conflict and what not to do, sent to the Builder again.",
              disabled: fixBusy != null,
              onSelect: () => void useBuilder.getState().resolveShipConflict(card.workspaceId, card.id),
            },
          ]
        : undefined;
  // 1.171.0 C3 (CF18, CP-10): Finish and check's other way — without the
  // Challenger's review (the old Skip review toggle), one press.
  // Not over a request for changes: on an unchanged copy it would record
  // an override without saying so (Challenger 1) — Agree / Ship without
  // these changes are the way there.
  const finishVariants: MenuItem[] | undefined =
    statePresentation.actionId === "finish-and-check" && presentationState !== "changes-requested"
      ? [
          {
            label: FINISH_WITHOUT_REVIEW_LABEL,
            hint: FINISH_WITHOUT_REVIEW_HINT,
            disabled: finishBusy,
            onSelect: () => void finishAndCheck(card.workspaceId, card.id, { withoutReview: true }),
          },
        ]
      : undefined;
  // 1.172.0 (C1; CP-11, CF B4): Start build's other way is Build with both.
  const startVariants: MenuItem[] | undefined =
    statePresentation.actionId === "start-build" && bothInStartMenu
      ? [
          {
            label: "Build with both",
            disabled: bothOff || askEmpty || areaBusy,
            hint: askEmpty ? askEmptyReason : bothOffer.offered ? undefined : (bothOffer.reason ?? undefined),
            onSelect: () => afterNowArea(startBothNow),
          },
        ]
      : undefined;
  // 1.172.0 (C1; CP-11, CF B4): every way to plan a card not built yet, in
  // one menu beside Start build — with Claude (or Codex), again once it has
  // a plan, with two AIs. Challenge the plan is offered only after the build
  // (Q2), from the ⋯.
  const planFirstItems: MenuItem[] = [];
  if (
    statePresentation.actionId === "start-build" &&
    !secondary &&
    !card.archived &&
    !card.prReview &&
    (presentationState === "draft" || presentationState === "ready")
  ) {
    if (intakeStatus === "ready" && card.dispatchPrompt) {
      planFirstItems.push({
        label: `Plan again with ${vendorName(planner)}`,
        disabled: held || briefSaving || areaBusy,
        hint: askEmpty ? askEmptyReason : `${vendorName(planner)} asks you questions again, then writes a new plan.`,
        // C3: Plan it first asks on Now's select too.
        onSelect: () => afterNowArea(onConfirmIntake),
      });
    } else if (!card.builder && !card.linkedSwarmId) {
      planFirstItems.push({
        label: planFirstLabel(planner),
        disabled: held || briefSaving || areaBusy,
        hint: askEmpty
          ? askEmptyReason
          : `${vendorName(planner)} asks you questions, then writes the plan the Builder follows. No code yet.`,
        // C3: Plan it first asks on Now's select too.
        onSelect: () => afterNowArea(onConfirmIntake),
      });
    }
    if (twoAisOffered) {
      planFirstItems.push({
        label: PLAN_TWO_AIS_LABEL,
        disabled: held || briefSaving || areaBusy,
        hint: askEmpty ? askEmptyReason : "Two AI sessions write and question the plan; you decide at the end.",
        onSelect: () => afterNowArea(openPlanTwoAis),
      });
    }
  }
  const planFirstShown = planFirstItems.length > 0;

  const canRelease = releaseOffered(card);
  const archivable = !card.archived && !boardWorkOwnsCard(card, linkedSwarmStatus);
  // 1.175.0 (D2): leaving the card takes the member's own name off its issue.
  const nameOffIssue = ownNameComesOff(card, claimLogin, workspace?.kanbanSyncMode === "githubIssues");
  // Round 2: an archive leaves the name on a card that is Done.
  const archiveNameOffIssue = ownNameComesOff(card, claimLogin, workspace?.kanbanSyncMode === "githubIssues", "archive");

  function onArchive() {
    // F6: a setup running in the card's folder refuses at once, as Delete
    // does — not after the card has left with an Undo.
    if (cardSetupRunning(card)) {
      pushToast({ kind: "warn", title: "The card wasn't archived", body: BOARD_ARCHIVE_SETUP_COPY });
      return;
    }
    // UX-5.9's path: the card leaves at once, Undo for a few seconds, then
    // `kanban_card_archive` (which prunes the worktree to the Trash).
    selectCard(card.workspaceId, null, false);
    openCenterMode(card.workspaceId, "board");
    deferCardRemoval({
      cardId: card.id,
      kind: "archive",
      title: "Card archived",
      body: archiveToastBody(card, archiveNameOffIssue),
      commit: () =>
        archiveCard(card.id).then(
          // 1.175.0 (D2-a): said only when GitHub didn't take the name off.
          () => sayArchiveNameKept(card.workspaceId, card.id, card.title),
          (err: unknown) =>
            pushToast({
              kind: "error",
              title: "The card couldn't be archived",
              body: "It is back on the Board as it was.",
              copyText: rawError(err),
            }),
        ),
    });
  }


  async function onPutBack() {
    if (!(await confirmSheet(putBackSheet(card.title, nameOffIssue)))) return;
    const intakeWasLive = card.intakeStatus === "active";
    try {
      await useBuilder.getState().putBack(card.workspaceId, card.id);
      if (intakeWasLive) clearIntake(card.id);
      await sayMovedBack(card.workspaceId, card.id);
    } catch (err) {
      pushErrorToast("The card wasn't put back", err);
    }
  }

  // GH #258: challenging the plan applies before the build; after it, the
  // offer is in the ⋯ (a discussion that exists still shows on the page).
  const planChallengeOffered =
    presentationState === "draft" ||
    presentationState === "ready" ||
    presentationState === "intake-live";
  const planChallengeInMenu =
    !card.archived &&
    !planChallengeOffered &&
    presentationState !== "shipped" &&
    presentationState !== "closed" &&
    // v1.154.1 (J5): not while Claude and Codex both build it — the plan
    // is past challenging, and both CLIs are busy with the card.
    !isUndecided(card) &&
    // 1.172.0 walk (E1): only a card that has a plan to challenge — the plan
    // a planning conversation wrote (the Brief's plan) or one challenged
    // before. A card built from its title and notes alone has none.
    (Boolean(card.dispatchPrompt?.trim()) || Boolean(card.planChallenge));

  // 1.172.0 D1 (CP-4, B5): the ⋯ in four headed groups — Build, Ship,
  // Session, Card — Delete last and apart; nothing Now already offers
  // (`cardMoreMenu`). Run history's switch and Clear are beside the runs, in
  // More about this card. No destructive action in the body.
  const moreEntries: CardMoreEntry[] = [];
  const more = (group: CardMoreGroup, item: CardMoreAction) => moreEntries.push({ group, item });
  // P-E: the merge Plyloft started for a ship conflict can be undone.
  if (leaveOut && !card.archived) {
    more("ship", { label: leaveOut, hint: LEAVE_OUT_TITLE, onSelect: () => void undoConflictMerge() });
  } else if ((mergeStarted || (broughtIn && card.reviewStatus !== "conflict_blocked")) && !card.archived) {
    more("ship", { label: UNDO_MERGE_LABEL, hint: UNDO_MERGE_TITLE, onSelect: () => void undoConflictMerge() });
  }
  if (intakeStatus === "active") {
    // GH #256: the conversation's way out, beside the callout's Conclude.
    more("session", {
      label: "Stop planning",
      disabled: intakeConcluding,
      onSelect: () => void onCancelIntake(),
    });
  }
  if (card.builder?.ptyId) {
    // GH #259: closing the session is not the section's action; it asks.
    more("session", {
      label: "Close the Builder session…",
      onSelect: async () => {
        if (
          await confirmSheet({
            title: "Close the Builder session?",
            body: "The card's copy of the repository and its commits stay.",
            confirmLabel: "Close session",
          })
        ) {
          void useBuilder.getState().close(card.workspaceId, card.id).then((closed) => {
            // 1.173.0 (C2): no longer built here — this computer's claim
            // marker comes off the issue (another computer's stays).
            if (closed) void kanbanCardDeviceRelease(card.workspaceId, card.id).catch(() => {});
          });
        }
      },
    });
  }
  // #370 gap (Tier 4 walk 2026-10-14): a shell in the card's worktree — its
  // port range (PLYLOFT_PORT_BASE) and nothing else of the main checkout.
  // 1.175.0 G7: never in the copy of somebody else's pull request.
  if (card.worktreePath && !card.archived && !reviewOnly(card)) {
    const worktree = card.worktreePath;
    more("session", {
      label: OPEN_WORKTREE_TERMINAL_LABEL,
      onSelect: () => openWorktreeTerminal(card.workspaceId, worktree),
    });
  }
  // Challenger on a pull request: no plan, no Ship, no second build.
  const reviewsPr = Boolean(card.prReview);
  // 1.171.0 C1 (Challenger 2): a title-only card is laid out as a ready one —
  // Plan with two AIs in ⋯ wherever Now's alternative is another.
  // 1.172.0 (C1): Plan it first ▾ holds it wherever Now has that menu.
  if (twoAisOffered && !planFirstShown && (presentationState === "ready" || presentationState === "draft")) {
    more("build", {
      label: `${PLAN_TWO_AIS_LABEL}…`,
      disabled: held,
      hint: askEmpty ? askEmptyReason : undefined,
      onSelect: openPlanTwoAis,
    });
  }
  if (presentationState === "changes-requested" && card.builder && presentation.rule === "builder-fixing" && !reviewsPr) {
    more("ship", {
      label: overrideLabel,
      hint: `If ${builderAi} disagrees with the findings and you agree: the card moves to Ready to ship without these changes.`,
      disabled: acceptingPushback,
      onSelect: onAcceptPushback,
    });
  }
  if (planChallengeInMenu && !reviewsPr) {
    more("build", {
      label: "Challenge the plan…",
      disabled: askEmpty,
      hint: askEmpty ? askEmptyReason : undefined,
      onSelect: () => setDiscussionOpen(true),
    });
  }
  if (!card.archived && intakeStatus === "ready" && card.dispatchPrompt && !planFirstShown) {
    more("build", {
      label: `Plan again with ${vendorName(planner)}`,
      disabled: held || briefSaving,
      onSelect: () => void onConfirmIntake(),
    });
  }
  // G4 (launch D8): the agent and swarm template pickers are gone. A card
  // in Todo that still carries an agent can let it go and be built by the
  // Builder instead.
  if (card.agentConfigId && card.columnId === "todo" && !card.archived && !githubOwnedReadOnly) {
    more("build", {
      label: "Build with the Builder instead",
      onSelect: () => void updateCard(card.id, { agentConfigId: null }),
    });
  }
  // 1.171.0 B3 (CP-14): Ship with follow-up is beside the findings it is
  // about (The result's review), no longer in ⋯.
  // 1.172.0 (C1): Start build ▾ holds it, but on the guided first card.
  if (bothShown && !reviewsPr && !bothInStartMenu) {
    more("build", {
      label: "Build with both",
      disabled: bothOff || askEmpty,
      hint: askEmpty ? askEmptyReason : bothOffer.offered ? undefined : (bothOffer.reason ?? undefined),
      onSelect: startBothNow,
    });
  }
  // 1.174.0 A2 (P7): the pull request is open, so the card can still
  // change — the brief as it reads now goes to the Builder; Send the fixes
  // to GitHub then updates the pull request.
  if (!reviewsPr && !githubOwnedReadOnly && briefFixOffered(card, statePresentation.actionId)) {
    more("build", {
      label: "Fix with the Builder",
      disabled: fixBusy != null,
      hint: BRIEF_FIX_HINT,
      onSelect: () => void useBuilder.getState().fixFromGitHub(card.workspaceId, card.id, { brief: true }),
    });
  }
  // U15: the session is closed, and the copy may hold a commit made by hand.
  // Finish and check needs no session (`startBuildDone` goes straight to
  // `builder_done`, as Finish and check stopped does): the checks and the
  // Reviewer still run, or the person skips the review out loud.
  if (presentationState === "session-closed" && card.builder && !reviewsPr && !githubOwnedReadOnly && !isUndecided(card)) {
    more("build", {
      label: FINISH_LABEL,
      hint: FINISH_CLOSED_SESSION_HINT,
      disabled: finishBusy,
      onSelect: () => void finishAndCheck(card.workspaceId, card.id),
    });
    // Fix round: not over a request for changes on this round. On an unchanged
    // copy the skip would record an override without saying so, and could turn
    // a held auto-merge back on (the same guard as `finishVariants`).
    if (!challengerRequestedChanges(card.builder)) {
      more("build", {
        label: FINISH_WITHOUT_REVIEW_LABEL,
        hint: FINISH_WITHOUT_REVIEW_HINT,
        disabled: finishBusy,
        onSelect: () => void finishAndCheck(card.workspaceId, card.id, { withoutReview: true }),
      });
    }
  }
  // N14 F8 (launch D4): the way back to To do. Its sessions stop; its
  // branch and worktree stay for Start build.
  if (putBackOffered(card, workspace?.kanbanSyncMode === "githubIssues") && !githubOwnedReadOnly && !reviewsPr) {
    const openPr = prOpen(card);
    more("build", {
      label: "Move back to Ready to start…",
      disabled: openPr,
      hint: openPr ? PUT_BACK_OPEN_PR : undefined,
      onSelect: () => void onPutBack(),
    });
  }
  // 1.171.0 F3 (CP-15): Release… only where it is offered, saying what it
  // is; never a greyed item with no reason. Archive off says why.
  if (!reviewsPr && canRelease) {
    more("ship", { label: "Release…", hint: RELEASE_ITEM_HINT, onSelect: openReleaseSheet });
  }
  if (followUpCardOffered) {
    more("card", { label: FOLLOW_UP_LABEL, disabled: followingUp, onSelect: () => void onFollowUp() });
  }
  // U3: Claim where a person looks for it, as well as in Technical.
  const claimMenuWord = claimMenuLabel(card, claimLogin, {
    githubIssues: workspace?.kanbanSyncMode === "githubIssues",
    writable: !githubOwnedReadOnly,
  });
  if (claimMenuWord) {
    more("card", {
      label: claimMenuWord,
      onSelect: () => void claimCard(card.workspaceId, card.id).catch(() => {}),
    });
  }
  more("card", {
    label: "Archive",
    disabled: !archivable,
    hint: archivable ? undefined : card.archived ? ALREADY_ARCHIVED_HINT : BOARD_ARCHIVE_BLOCKED_COPY,
    onSelect: onArchive,
  });
  more("card", { label: "Delete card…", danger: true, onSelect: () => requestDelete(card) });
  const nowVariants = shipVariants ?? reviewAgainVariants ?? conflictVariants ?? startVariants ?? finishVariants;
  // Now's presses — the ones drawn in the Now box — are left out of the ⋯.
  // 1.172.0 (C2; CP-3): Ready to ship's one quiet press beside Ship it ▾.
  const checkFirst: SecondaryAction | undefined =
    readyToShipNow
      ? { label: CHECK_IT_FIRST_LABEL, title: CHECK_IT_FIRST_TITLE, onAction: () => reveal("outcome", REVIEW_FOCUS) }
      : undefined;
  const moreItems = cardMoreMenu(
    moreEntries,
    card.prReview
      ? []
      : nowPressLabels({
          primary: primaryLabel,
          alternatives: [secondary, checkFirst, seeChanges, tryIt],
          menus: [nowVariants, planFirstShown ? planFirstItems : undefined],
        }),
  );

  // The Now callout's primary: off while its press can't go, and pressed
  // the same from Now and from the Review's Ship it ▾ (1.172.0 C2).
  const primaryDisabled =
    (held && statePresentation.actionId !== "open-plan") ||
    (statePresentation.actionId === "start-work" && !canStartRun) ||
    (statePresentation.actionId === "pr-fix" && fixBusy != null) ||
    (statePresentation.actionId === "ship-conflict-ask" && fixBusy != null) ||
    (statePresentation.actionId === "start-build" && (starting || briefSaving || settingUp || bothBusy)) ||
    // C3 (Challenger 1): one press while the area is saved — its Stop
    // (§2b) is the press then, not this one.
    (areaBusy && !areaPress) ||
    ((statePresentation.actionId === "pr-merge" ||
      statePresentation.actionId === "pr-merge-github-head" ||
      statePresentation.actionId === "pr-push-update" ||
      statePresentation.actionId === "pr-auto-merge-off" ||
      statePresentation.actionId === "pr-fix") &&
      (prPress !== null || shippingBusy !== null)) ||
    setupNow?.hold === "running" ||
    settlingSetup ||
    (statePresentation.actionId === "finish-and-check" && finishBusy) ||
    // 1.171.0 C2 (CF22): no press while the result is being read.
    (presentationState === "result-ready" && outcomePresentation.loading);
  // ── 1.175.0 F8 (UX-12, owner I10): one error in Now ─────────────────
  // What is open on the card goes through `cardErrorNow`: the first in
  // §6b's order leads Now, with its one action; the others wait at the top
  // of Details, behind "2 more things on this card need a look."
  const openGithubAccounts = () => useUi.getState().openSettingsSection(GITHUB_ACCOUNTS_PAGE, { row: GITHUB_ACCOUNTS_ROW });
  const onCardErrorAction = (id: string) => {
    if (!cardError) return;
    if (id === "dismiss") setCardError(null);
    // QoL 1.168 (C4): the block's other ways out.
    const failure = cardFailureRef.current?.error === cardError ? cardFailureRef.current : null;
    if (id === "retry" && failure?.retry) void (setCardError(null), failure.retry());
    const dirty = failure ? decodeTargetDirtyError(failure.cause) : null;
    if (id === "show-files" && dirty) void showProjectFiles(card.workspaceId, dirty);
    if (id === "ask-commit" && dirty) void askBuilderToCommit(card, dirty);
    // 1.169.1 (R11): GitHub didn't accept the sign-in.
    if (id === GITHUB_SIGN_IN_ACTION.id) openGithubAccounts();
    // 1.171.0 B3 (DL-27): the rules, or the branch, on GitHub.
    if (id === OPEN_ON_GITHUB_ACTION.id) {
      const url = cardError.actions.find((a) => a.id === id)?.url;
      if (url) void openWebLink(url).catch((e: unknown) => pushToast(linkDidNotOpen(url, e)));
    }
    // G1: a pull request with no GitHub CLI — Setup installs it. The land
    // on this Mac is the way on only for a GitHub address that isn't a
    // repository's (1.171.0 A3).
    if (id === GH_INSTALL_ACTION.id) useSetup.getState().openSetup("rerun", "github");
    if (id === SHIP_HERE_ACTION.id) void (setCardError(null), shipAs("merge_live"));
    // F8: a ship stopped on a conflict — the conflict's own press.
    if (id === CONFLICT_FIX_ACTION.id) void (setCardError(null), useBuilder.getState().resolveShipConflict(card.workspaceId, card.id));
    // R8: what the project's hook said goes to the Builder.
    const stop = failure ? commitStop(rawError(failure.cause)) : null;
    if (id === "ask-hook" && stop?.kind === "hook") void (setCardError(null), askBuilderToFixHook(card, stop.said));
  };
  const onBuilderErrorAction = (id: string) => {
    if (id === "set-up") openProjectSetUp(card.workspaceId);
    if (id === "open-areas") useUi.getState().openSettingsSection("areas", { workspaceId: card.workspaceId });
    if (id === "open-shipping") useUi.getState().openSettingsSection("shipping", { workspaceId: card.workspaceId });
    if (id === "undo-merge" || id === "dismiss") useBuilder.getState().clearError(card.id);
    if (id === "undo-merge") void undoConflictMerge();
    // R11 (Challenger): every block that draws actionFailedError answers
    // its Sign in to GitHub.
    if (id === GITHUB_SIGN_IN_ACTION.id) openGithubAccounts();
  };
  const onIntakeErrorAction = (id: string) => {
    setIntakeError(card.id, null);
    if (id === "conclude") void onConcludeIntake();
  };
  // Block C: a Resume that found no conversation is said once, by Now. N14
  // walk F14: a stopped intake is said in Now; a Conclude that failed on a
  // live conversation is not a stop (Challenger P2).
  const builderUx = resumeNowTookOver ? null : builderErrorUx(builderError, areaState?.area?.name ?? null);
  const intakeUx =
    intakeError && !intakeStopped
      ? (intakeStatus === "active" ? intakeConcludeError : intakeStoppedError)(intakeError, planner)
      : null;
  const pressFailure = cardFailureRef.current?.error === cardError ? cardFailureRef.current : null;
  // A failed ship's Try again is one press: the error's (it repeats the
  // press, with its follow-up), named as the state's; where there is no
  // remote, the state's (it ships here instead).
  const shipFailedNow = presentation.rule === "ship-failed";
  const pressError = withConflictFix(
    cardError && shipFailedNow && noPullRequest ? { ...cardError, actions: cardError.actions.filter((a) => a.id !== "retry") } : cardError,
    pressFailure ? rawError(pressFailure.cause) : null,
    askBuilderOffered(card),
  );
  const shipRefusedShown = shipRefused && !ownShipFailure && openSection !== "ship" && !card.prReview;
  const troubles = cardErrorNow({ press: pressError !== null, "ship-refused": shipRefusedShown, builder: builderUx !== null, intake: intakeUx !== null });
  const troubleOf = (kind: CardTroubleKind): Trouble | null =>
    kind === "press" && pressError ? { error: pressError, onAction: onCardErrorAction }
    : kind === "builder" && builderUx ? { error: builderUx, onAction: onBuilderErrorAction }
    : kind === "intake" && intakeUx ? { error: intakeUx, onAction: onIntakeErrorAction }
    : null;
  const shipRefusalBlocks = <ShipRefusalBlocks workspaceId={card.workspaceId} cardId={card.id} onPublish={openReleaseSheet} />;
  const lead = troubles.now ? troubleOf(troubles.now) : null;
  const pressDirty = pressFailure ? decodeTargetDirtyError(pressFailure.cause) : null;
  // Challenger block 5 (item 5): with Ask the Builder as its way on, Show
  // the files sits beside the list; a conflict names its files.
  const nowError = lead
    ? nowErrorView(lead, troubles.now !== "press" ? undefined : {
        retryTitle: shipFailedNow ? statePresentation.actionTitle : undefined,
        before: shipConflictOf(card) ? <ShipConflictFiles card={card} /> : undefined,
        showFiles: pressDirty ? () => void showProjectFiles(card.workspaceId, pressDirty) : undefined,
      })
    : null;
  /** F8: Now's Show opens Details and puts the focus on its list. */
  const toLookAtRef = useRef<HTMLElement | null>(null);
  const showToLookAt = () => {
    setMoreOpen(true);
    requestAnimationFrame(() => toLookAtRef.current?.focus());
  };

  const pressPrimary = () => {
    const invocation = primaryInvocationRef.current ?? {
      source: "pointer" as const,
      focusCategory: "card_background" as const,
    };
    reportInstalledSelfCheckActionTrace({
      state: presentationState,
      actionId: statePresentation.actionId,
      ...invocation,
      primaryActionInvocations: 1,
      shipInvocations: statePresentation.actionId === "ship" ? 1 : 0,
    });
    void onPrimaryAction(statePresentation.actionId);
  };
  // 1.172.0 (C2; CP B2): the Review ends on the same Ship it ▾ as Now — its
  // words, its menu, its press; never the tour's or the self-check's primary.
  const reviewShip = readyToShipNow ? (
    shipVariants && shipVariants.length > 0 ? (
      <SplitButton
        label={primaryLabel}
        onClick={pressPrimary}
        items={shipVariants}
        menuLabel={REVIEW_SHIP_MENU_LABEL}
        disabled={primaryDisabled}
        tone="ghost"
        // Challenger 1: a name of its own, beginning with what it says.
        mainProps={{
          "aria-label": reviewShipName(primaryLabel),
          title: statePresentation.actionTitle && machineWords(statePresentation.actionTitle),
        }}
      />
    ) : (
      <CBtn
        tone="ghost"
        disabled={primaryDisabled}
        aria-label={reviewShipName(primaryLabel)}
        title={statePresentation.actionTitle && machineWords(statePresentation.actionTitle)}
        onClick={pressPrimary}
      >
        {primaryLabel}
      </CBtn>
    )
  ) : undefined;

  const checks = checksFact(card, presentationState);
  // SL-0 app tester, Ship pilot: a card ready to ship had no visible way to
  // "The result" (its checks, its files, its pull request) but "Not right".
  const resultReachable =
    Boolean(card.worktreePath) &&
    !card.archived &&
    (presentationState === "ready-to-ship" ||
      presentationState === "result-ready" ||
      presentationState === "no-changes" ||
      // Round 3 (RW-A): its pull request open — its changes stay reachable.
      prOpen(card));
  const review = challengerFact(card, presentationState, identityEmail);
  const githubBoard = workspace?.kanbanSyncMode === "githubIssues";
  // Walk of #386: a pull request card's Status is its review's word; on
  // someone else's there is no Builder to name.
  const prStatus = prStatusWord(card);
  // QoL 1.168 (C1, V-1): the state is said once, by the Now box's title —
  // the facts line under it has no Status. A pull request card keeps its
  // grid (and its Status) above its review (block 14's).
  // …and a card nobody has built leaves out the empty "Not run yet" and
  // "Not reviewed yet" (V-1: on a Draft every fact was empty).
  const unbuilt = !card.worktreePath && !card.builder && !card.linkedSwarmId;
  const factOn = (fact: Parameters<typeof factShown>[0]) => Boolean(card.prReview) || !unbuilt || factShown(fact);
  // 1.174.0 (TX1, T1): one Checks row when only GitHub has checks; each
  // row says where it ran when both are drawn.
  const checksLabels = checksRowLabels(card, factOn(checks));
  // 1.172.0 D2 (CP-25, CF17): the card's pickers — who builds it, how it
  // asks, each role's model, Retry on… — behind one Change… beside the
  // facts; nothing to choose from before it is asked for.
  const vendorChoosable = builderVendorChoosable(card, presentationState);
  const permissionsChoosable = vendorChoosable || restartPermissionsChoosable(card, presentationState);
  const modelsChoosable = roleModelChoosable(card, presentationState);
  const peopleChoosable = vendorChoosable || permissionsChoosable || modelsChoosable;
  // 1.174.0 (C2, BCI-11): Change… also holds the card's area and the cards
  // it waits for (*Add a blocker*) — the facts line itself is words.
  const blockersChoosable = !card.archived && !cardDone;
  const setBlockers = (ids: string[]) => {
    setCardError(null);
    void useKanban
      .getState()
      .setBlockedBy(card.id, ids)
      .catch((e: unknown) => setCardError(dependencyRefusedError(e)));
  };
  const areaInPickers = !card.archived && areaChoosableHere;
  const pickersChoosable = !card.archived && (peopleChoosable || areaInPickers || blockersChoosable);
  const pickersShown = pickersOpen && pickersChoosable;
  const changeTitle = changeChoicesTitle({ people: peopleChoosable, area: areaInPickers, blockers: blockersChoosable });
  const changeButton = pickersChoosable ? (
    <CBtn
      tone="quiet"
      size="sm"
      aria-expanded={pickersShown}
      aria-controls={`card-pickers-${card.id}`}
      data-ply-card-change=""
      title={changeTitle ?? undefined}
      // A disclosure: focus stays on it (the setup line's Change… moves it).
      onClick={() => {
        if (pickersShown) clearAreaAsk();
        setPickersOpen(!pickersShown);
      }}
    >
      Change…
    </CBtn>
  ) : null;
  /** Done: the panel goes, and focus goes back to the facts line's Change…
   *  (never to the page's body). */
  function closeCardPickers() {
    clearAreaAsk();
    setPickersOpen(false);
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(`[data-ply-card-host][data-ply-card-id="${CSS.escape(card.id)}"] [data-ply-card-change]`)
        ?.focus(),
    );
  }
  const pickersPanel = pickersShown ? (
    <CardPickers
      card={card}
      cards={workspaceCards}
      vendor={preferredVendor}
      can={{ vendor: vendorChoosable, permissions: permissionsChoosable, models: modelsChoosable, area: areaInPickers, blockers: blockersChoosable }}
      restart={restartPermissionsChoosable(card, presentationState)}
      helper={!guidedStart}
      builderFact={builderFact(card, preferredVendor, presentationState)}
      builderModel={builderModel}
      challengerModel={challengerModel}
      reviewRetry={factOn(review)}
      onBlockers={setBlockers}
      onOpen={(id) => selectCard(card.workspaceId, id)}
      onDone={closeCardPickers}
    />
  ) : null;
  const properties: Property[] = [
    ...(card.prReview
      ? [
          {
            icon: "status" as const,
            label: "Status",
            value: (
              <StateWord state={run.state} live={run.live}>
                {prStatus ?? statePresentation.label}
              </StateWord>
            ),
          },
        ]
      : []),
    ...(reviewOnly(card)
      ? []
      : [
          {
            icon: "builder" as const,
            label: "Builder",
            // 1.172.0 D2 (CP-25, CF17): the facts are words; who builds it,
            // its model and Retry on… are behind Change….
            value: (
              builderFact(card, preferredVendor, presentationState)
            ),
          },
        ]),
    // 1.171.0 (D1; FR-3, CF6): how the Builder will ask, beside it and
    // before Start build — kept by Resume. 1.172.0 (A2, owner): and again
    // before a new start — Session closed (Start fresh), Move back to Ready
    // to start — never while a session is open. 1.172.0 D2: said in words;
    // chosen under Change….
    ...(!reviewOnly(card) && permissionsChoosable
      ? [
          {
            icon: "builder" as const,
            label: "Permissions",
            // 1.175.0 F9 (I1): the choice's name for the AI that builds.
            // A card built by both AIs names each one's.
            value: (card.buildBoth?.lanes.length ?? 0) > 1
              ? bothPermissionsLabel(cardPermissionsChoice(card, preferredVendor, permissionsDefault, tourStartMode))
              : builderPermissionsLabel(cardPermissionsChoice(card, preferredVendor, permissionsDefault, tourStartMode), preferredVendor),
          },
        ]
      : []),
    ...(checksLabels.own ? [{
      icon: "checks" as const,
      label: checksLabels.own,
      value: resultReachable ? (
        <>
          <StateWord state={checks.state}>{checks.word}</StateWord>{" "}
          {/* 1.172.0 (C2; CP-5): the checks are the Review's; the changes
              are See the changes there. */}
          <CBtn tone="quiet" size="sm" onClick={() => onTimelineLink("checks")}>
            {SEE_THE_CHECKS_LABEL}
          </CBtn>
        </>
      ) : (
        <StateWord state={checks.state}>{checks.word}</StateWord>
      ),
    }] : []),
    ...(factOn(review)
      ? [
          {
            icon: "review" as const,
            label: "Reviewer",
            // 1.171.0 C3 (CF9, owner D1): explained where a new person
            // first meets it — a second AI that reviews; it can't edit.
            help: <TermHelp word="Reviewer" />,
            value: (
              <span className="ux-card-builder-pick">
                <StateWord state={review.state}>{review.word}</StateWord>
              </span>
            ),
          },
        ]
      : roleModelChoosable(card, presentationState)
        ? [
            // 1.168.1 (E2, Challenger): a card nobody built leaves out the
            // empty review word (V-1) but says who will review it.
            {
              icon: "review" as const,
              label: "Reviewer",
              help: <TermHelp word="Reviewer" />,
              value: (
                <span className="ux-card-builder-pick">
                  {vendorName(challengerModel.vendor)}
                  </span>
              ),
            },
          ]
        : []),
  ];
  if (areaProperty) properties.push(areaProperty);
  if (otherDevice) properties.push({ label: "Claim", value: otherDevice });
  // SL-1: the pull request's own checks, beside the card's Checks — and
  // alone when the card has none of its own (TX1, T1).
  if (checksLabels.github && card.pr) {
    const github = githubChecksFact(card.pr);
    properties.push({
      icon: "checks",
      label: checksLabels.github,
      value: <StateWord state={github.state}>{github.word}</StateWord>,
    });
  }
  const openCard = (id: string) => selectCard(card.workspaceId, id);
  const dependencyProperties: Property[] = [
    // 1.174.0 (C2, BCI-11): only when the card names a blocker, never
    // "Nothing · Add"; it is changed under Change….
    ...(!blockedByShown(card, workspaceCards)
      ? []
      : [{
      icon: "blockedBy" as const,
      label: "Blocked by",
      wide: true,
      value: (
        <BlockedByValue card={card} cards={workspaceCards} readOnly onOpen={openCard} onChange={setBlockers} />
      ),
    }]),
    // QoL 1.168 (C1): "Blocks: Nothing" says nothing; it shows once a card waits.
    ...(card.prReview || dependentsOf(card, workspaceCards).length > 0
      ? [
          {
            icon: "blockedBy" as const,
            label: "Blocks",
            wide: true,
            value: <BlocksValue card={card} cards={workspaceCards} onOpen={openCard} />,
          },
        ]
      : []),
  ];
  // N19: a follow-up card names the shipped card it follows up; a press
  // opens it. A deleted original keeps the title the link recorded.
  if (card.followsUp) {
    const followed = followLinkTitle(card.followsUp, workspaceCards);
    dependencyProperties.unshift({
      icon: "blockedBy",
      label: "Follows up",
      wide: true,
      value: followed.exists ? (
        <span className="ux-card-deps">
          <CBtn
            tone="quiet"
            className="ux-card-dep-link"
            title={followed.title}
            aria-label={`Follows up “${followed.title}” — open it`}
            onClick={() => openCard(card.followsUp!.cardId)}
          >
            {followed.title}
          </CBtn>
        </span>
      ) : (
        <span className="ux-card-deps-none" title="That card was deleted.">
          {followed.title} (deleted)
        </span>
      ),
    });
  }
  if (githubBoard) {
    const issueUrl =
      card.ghIssueNumber && workspace?.githubOwnerRepo
        ? `https://github.com/${workspace.githubOwnerRepo}/issues/${card.ghIssueNumber}`
        : null;
    properties.push({
      icon: "issue",
      label: "Issue",
      value: card.ghIssueNumber ? (
        <button
          type="button"
          className="ux-card-mono-link"
          title={issueUrl ? `${issueUrl} — copy the link` : undefined}
          onClick={() => {
            if (!issueUrl) return;
            void navigator.clipboard?.writeText(issueUrl).then(
              () => pushToast({ kind: "info", title: "Issue link copied", body: issueUrl }),
              () => {},
            );
          }}
        >
          #{card.ghIssueNumber}
        </button>
      ) : (
        "Local only"
      ),
    });
  }

  if (linkedPrs.length > 0) {
    properties.push({
      icon: "issue",
      label: linkedPrs.length === 1 ? "Linked pull request" : "Linked pull requests",
      value: <LinkedPullRequestList prs={linkedPrs} login={claimLogin} />,
      wide: linkedPrs.length > 1,
    });
  }

  const timeline: TimelineEvent[] = cardTimeline(card, {
    showAllRounds,
    login: claimLogin,
    cardExists: (id) => workspaceCards.some((c) => c.id === id),
    me: identityEmail,
  }).map((e) => ({
    id: e.id,
    state: e.state,
    live: e.live,
    text: e.text,
    when: timelineWhen(e.at, nowMs),
    link: e.link
      ? {
          label: e.link.label,
          ariaLabel: e.link.ariaLabel,
          onClick: () =>
            e.link!.kind === "card" && e.link!.cardId
              ? openCard(e.link!.cardId)
              : onTimelineLink(e.link!.kind, e.link!.intakeId, e.link!.round, e.link!.findingIds, e.link!.label),
        }
      : undefined,
  }));
  const planRecord = planOpen
    ? (card.intakeHistory ?? []).find((r) => r.intakeId === planOpen) ?? null
    : null;

  function onTimelineLink(
    kind: TimelineLinkKind,
    intakeId?: string,
    round?: number,
    findingIds?: string[],
    label?: string,
  ) {
    switch (kind) {
      case "rounds":
        roundsRevealed.current = true;
        setShowAllRounds(true);
        return;
      case "plan":
        openOnly(null);
        setPlanOpen(intakeId ?? null);
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLElement>(
              `[data-ply-card-host][data-ply-card-id="${CSS.escape(card.id)}"] [data-ply-card-section="plan"]`,
            )
            ?.scrollIntoView?.({ block: "start" }),
        );
        return;
      case "session":
        reveal("run");
        focusSessionFirstTime("run");
        return;
      case "diff":
        openDiff();
        return;
      case "review":
        // 1.174.0 C5 round 1: the skipped review's link goes to the line
        // that says why.
        if (label === WHY_SKIPPED_LABEL) {
          setReviewRoundFilter(card.id, null);
          reveal("outcome", REVIEW_SKIPPED_FOCUS);
          return;
        }
        // CL-5: a round's link narrows the review to that round's findings;
        // the latest review's own link shows them all.
        setReviewRoundFilter(
          card.id,
          round != null
            ? { round, ids: findingIds ?? [], reviewId: card.builder?.review?.reviewId ?? null }
            : null,
        );
        reveal("outcome");
        return;
      case "checks":
        // Challenger 2: the cursor goes where the eye does.
        reveal("outcome", REVIEW_CHECKS_FOCUS);
        return;
      case "ship":
        // 1.174.0 C5 round 1: a shipped card's pull request opens on GitHub,
        // as Now's press does (`inspect-ship`).
        if (label === SEE_PULL_REQUEST_LABEL && shippedReceipt(card) && card.prUrl) {
          const url = card.prUrl;
          void openWebLink(url).catch((e: unknown) => pushToast(linkDidNotOpen(url, e)));
          return;
        }
        reveal("ship");
        return;
      case "card":
        return;
    }
  }

  // 1.172.0 (C1; CP-12, CF B4): a card not built yet — planning or not —
  // is brief-first.
  const briefFirst =
    !card.prReview &&
    (presentationState === "draft" ||
      presentationState === "ready" ||
      presentationState === "intake-live" ||
      // 1.174.0 (C1, Challenger 6): queued to start, still not built.
      presentationState === "queued");
  // The guided first card says its own sentence above Start build (D2).
  const setupLine =
    briefFirst && statePresentation.actionId === "start-build" && !readmeGuided && !card.archived
      ? briefSetupLine({
          builder: preferredVendor,
          challenger: challengerModel.vendor,
          permissions: cardPermissionsChoice(card, preferredVendor, permissionsDefault, tourStartMode),
          area: areaState?.area ? { name: areaState.area.name, areas: areaState.areas.length } : null,
        })
      : null;
  // 1.175.0 F10 (UX-10): before the first build the sentence is the facts
  // line, and its Change… the card's one; the line comes with the build.
  const factsLineShown = !unbuilt || !setupLine;
  const lineFacts = factsLineShown
    ? [...properties, ...dependencyProperties]
    : factsBeforeBuild([...properties, ...dependencyProperties]);
  // 1.172.0 D2 (CP-28): the Files chip opens Details on its Files.
  const fileCount = card.attachments?.length ?? 0;
  function openFiles() {
    setMoreOpen(true);
    requestAnimationFrame(() => {
      const files = document.querySelector<HTMLElement>(
        `[data-ply-card-host][data-ply-card-id="${CSS.escape(card.id)}"] [data-ply-card-details-files]`,
      );
      files?.scrollIntoView?.({ block: "nearest" });
      files?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    });
  }

  // 1.172.0 (C1; CP-11, CP-12, CP-13, CF B4): one Brief block — What you
  // want, the plan the Builder follows, More detail. A card not built yet
  // leads with it, right under Now; once built it sits before the Activity.
  // A textarea moving between the two places is remounted, never a
  // terminal: the sessions' sections stay where they are.
  const sentLine = sentBriefLine(card);
  const briefLine = briefFirstLine(notes);
  const briefBlock = (
    <section
      className="ux-card-section"
      aria-label="Brief"
      data-ply-card-brief-block={briefFirst ? "first" : ""}
    >
      <div className="ux-card-brief-head">
        {/* Folded (C1), the fold's What you asked is its heading. */}
        {briefFirst && <h2 className="ux-card-heading">What you want</h2>}
        {/* 1.175.0 (B3): whose text it is, on a card of an issue. */}
        {briefFirst && issueLinked && (
          <span className="ux-card-brief-by" data-ply-card-brief-by="">
            {issueByline(card)}
          </span>
        )}
        {/* 1.172.0 D2 (CP-28): the card's files, one press from the brief. */}
        {(fileCount > 0 || !cardDone) && (
          <CBtn
            tone="quiet"
            size="sm"
            data-ply-card-files-chip=""
            title="The files sent with this card — they are under Details."
            onClick={openFiles}
          >
            <Icon name="file" size="sm" />
            {fileCount > 0 ? `Files (${fileCount})` : "Add files"}
          </CBtn>
        )}
      </div>
      {/* 1.175.0 (D3): the brief changed on GitHub while it was changed here. */}
      {briefAsked && <EditConflictNotice card={card} conflict={briefAsked} />}
      <textarea
        className="ux-card-brief"
        aria-label="What you want"
        data-ply-tour="card-brief"
        rows={4}
        value={notes}
        disabled={githubOwnedReadOnly}
        // 1.171.0 (E2): a done card's brief can be read and copied,
        // not changed; the line under it says why and what to do.
        readOnly={cardDone}
        aria-describedby={
          cardDone ? `card-brief-done-${card.id}` : sentLine ? `card-brief-sent-${card.id}` : undefined
        }
        title={githubOwnedReadOnly ? TEAM_BOARD_READ_ONLY_MESSAGE : undefined}
        placeholder={
          card.fromCopy && card.columnId === "todo"
            ? copyBriefPlaceholder(card.fromCopy.name)
            : "Describe the outcome you want and anything Plyloft should know."
        }
        onChange={(e) => {
          setNotes(e.target.value);
          notesDraftRef.current = { workspaceId: card.workspaceId, cardId: card.id, notes: e.target.value };
        }}
        onBlur={commit}
      />
      {briefAsked && (
        <p className="ux-card-muted" data-ply-card-brief-asked="">
          {machineWords(BRIEF_ASKED_LINE)}
        </p>
      )}
      {/* 1.175.0 (B3): what GitHub hides in the issue's text, shown here. */}
      {issueLinked && <HiddenParts text={notes} />}
      {cardDone && (
        <p className="ux-card-muted" id={`card-brief-done-${card.id}`} data-ply-card-brief-done="">
          {doneBriefLine(card, followUpCardOffered)}
        </p>
      )}
      {/* 1.174.0 A2 (P7): sent, not landed — the brief can still change. */}
      {!cardDone && sentLine && (
        <p className="ux-card-muted" id={`card-brief-sent-${card.id}`} data-ply-card-brief-sent="">
          {sentLine}
        </p>
      )}
      {dirty && (
        <div className="ux-card-section-actions">
          <CBtn tone="quiet" onClick={commit}>
            Save
          </CBtn>
        </div>
      )}
      {/* 1.172.0 (C1; CP-12, CF B4): before the build, who builds it, how
          it asks and who reviews it — Change… is the card's pickers. */}
      {setupLine && (
        <BriefSetupLine
          line={setupLine}
          more={briefSetupMore(preferredVendor, challengerModel.vendor)}
          open={pickersShown}
          controls={`card-pickers-${card.id}`}
          // F10: right under it now — a disclosure, focus stays on it. One
          // Change… on the page: the facts line's once it is shown.
          onChange={factsLineShown ? undefined : pickersShown ? closeCardPickers : () => setPickersOpen(true)}
        />
      )}
      {setupLine && !factsLineShown && pickersPanel}
      {/* 1.172.0 (A1): what was asked after the first result. */}
      <LaterRequests card={card} readOnly={cardDone || githubOwnedReadOnly} />
      {/* 1.172.0 (C1, CP-13): the plan Start build sends, once planned,
          and the longer notes — both were under More about this card. */}
      {(card.dispatchPrompt || dispatchPrompt) && (
        <BriefPlan
          plan={dispatchPrompt}
          onPlan={setDispatchPrompt}
          onCommit={commit}
          edited={editedSinceIntake}
          locked={intakeStatus === "active"}
          readOnly={cardDone}
        />
      )}
      {/* Walk of #386: someone else's pull request has no Builder to note for. */}
      {/* 1.174.0 (C1, P8): a done card with nothing in More detail shows
          no empty field. */}
      {!reviewOnly(card) && !(cardDone && !knowledge.trim()) && (
        <BriefMoreDetail
          value={knowledge}
          onChange={setKnowledge}
          onCommit={commit}
          ownedReadOnly={githubOwnedReadOnly}
          readOnly={cardDone}
        />
      )}
      {/* Issue text outside Plyloft's marker blocks (`ghRawRemainder`).
          Sync adopts it as the brief when "What you want" is empty;
          otherwise it stays here, read-only — the Builder never gets
          it — and "Use as brief" moves it in. */}
      {card.ghRawRemainder && (
        <div className="ux-card-remainder">
          <p className="ux-card-muted">
            From the issue — text outside Plyloft’s brief. The Builder does not get it.
          </p>
          <p className="ux-card-plain">{card.ghRawRemainder}</p>
          <div className="ux-card-section-actions">
            <CBtn
              tone="quiet"
              disabled={githubOwnedReadOnly}
              title="Add this text below “What you want” and update the issue."
              reason={githubOwnedReadOnly ? TEAM_BOARD_READ_ONLY_MESSAGE : null}
              onClick={() => void adoptIssueRemainder(card.id)}
            >
              Use as brief
            </CBtn>
          </div>
        </div>
      )}
      {!card.archived && (
        <>
          <LinkedBrainstormBanner
            workspaceId={card.workspaceId}
            cardId={card.id}
            linkedBrainstormId={card.linkedBrainstormId ?? null}
            dismissedBanners={card.dismissedBanners ?? EMPTY_ARRAY}
          />
          <PlanChallengePanel
            card={card}
            // Q2 (owner, 2026-10-16): on an unbuilt card Plan with
            // two AIs takes the place of Challenge the plan; a
            // discussion the card already has is still shown.
            offer={planChallengeOffered && planChallengeOfferedOn(presentationState)}
            heldReason={askEmpty ? askEmptyReason : null}
            onChallenge={() => setDiscussionOpen(true)}
          />
        </>
      )}
    </section>
  );

  // 1.172.0 D2 (CP-21): one receipt on a shipped card — the ship step is
  // drawn inside The result, and the page has no Shipping section.
  const receipt = shippedReceipt(card);
  const shipStep = (
    <CardShipStep
      card={card}
      onOpenRelease={openReleaseSheet}
      onPrActionsReady={onPrActionsReady}
      showProposal={!receipt && openSection === "ship"}
      shipping={outcomePresentation.shipBusy || presentationState === "shipping"}
    />
  );

  const sessionTitle = isUndecided(card)
    ? "Claude and Codex"
    : card.builder
    ? `${vendorName(card.builder.vendor)} session`
    : card.linkedSwarmId
      ? "The swarm"
      : "The run";

  return (
    <div
      className="ux-card-page"
      {...pageDrop.zoneProps}
      data-ply-card-host=""
      data-ply-card-id={card.id}
      data-ply-card-state={presentationState}
      data-ply-card-store-state={storePresentationState ?? undefined}
      data-ply-rule={presentation.rule}
      data-ply-card-store-rule={storePresentation?.rule ?? undefined}
    >
      {pageDrop.over && <CardPageDropLabel />}
      <p className="sr-only" role="status" aria-live="polite" data-ply-session-focus-note="">
        {sessionFocusNoteShown ? sessionFocusNote.text : ""}
      </p>
      {/* CL-8: Build with both asks each build's model first. */}
      <BuildBothStartSheet workspaceId={card.workspaceId} />
      {/* UX-6.2: Workspace › Board › the card's column; the title (edited
          in place) heads the page, so the crumbs don't repeat it (1.172.0
          D2, CP-29) — they say where the card sits. Everything but the one
          action is in the ⋯. */}
      <ModeHeader
        mode="board"
        workspaceId={card.workspaceId}
        trail={[columnCrumb(presentation.column)]}
        onModeCrumb={() => selectCard(card.workspaceId, null, false)}
        title={null}
      />
      <Page>
        {/* GH #254: the title and its ⋯ head the page column, on the same
            left edge as the properties they head. */}
        <header className="ux-card-head">
          <h1 className="ux-screen-title ux-screen-title--display">
            <CardTitle
              value={title}
              readOnly={githubOwnedReadOnly}
              onChange={setTitle}
              onCommit={commit}
              onRevert={() => setTitle(card.title)}
            />
          </h1>
          {/* Card chat (part 2): the Chat tab, one of the card's sections. */}
          <CBtn
            tone="quiet"
            className="ux-card-chat-toggle"
            aria-expanded={openSection === "chat"}
            aria-controls={`card-chat-${card.id}`}
            data-ply-card-chat-toggle=""
            data-ply-tour="card-tab-chat"
            onClick={() => {
              if (openSection === "chat") openOnly(null);
              else reveal("chat", ".ux-chat-input");
            }}
          >
            {ASK_ABOUT_CARD_LABEL}
          </CBtn>
          <MoreMenu label="More for this card" items={moreItems} tour="card-more" />
        </header>
        {/* 1.175.0 (D3): the title changed on GitHub while it was changed here. */}
        {titleAsked && <EditConflictNotice card={card} conflict={titleAsked} />}
        <div className="ux-card-stack">
        <div
          className="ux-card-body"
          // SP-1 phase 2: the result and its diff are open together — on a
          // wide page the result moves to column 1, the diff takes column 2.
          // C3: the Review and the session — the Review moves to column 1
          // the same way; the session stays where it is, at its width.
          data-ply-card-pair={diffShown ? "diff" : reviewWithSession ? "session" : undefined}
        >
          {githubOwnedReadOnly && (
            <Callout
              kind="info"
              title="Read-only — the Team plan is needed"
              text={TEAM_BOARD_READ_ONLY_MESSAGE}
              actions={
                <CBtn tone="quiet" onClick={openPlanSettings}>
                  See your plan
                </CBtn>
              }
            />
          )}

          {/* Challenger on a pull request: its facts' grid above its review. */}
          {card.prReview && <Properties items={[...properties, ...dependencyProperties]} trailing={changeButton} trailingLabel="Choices" />}
          {card.prReview && pickersPanel}

          {/* Challenger on a pull request: its Now is the review's. */}
          {card.prReview && <PrReviewPanel card={card} onOpenSession={() => reveal("run")} />}
          {!card.prReview && <CardStateHeader
            ref={stateHeadlineRef}
            error={nowError}
            more={troubles.more.length > 0 ? { count: troubles.more.length, onShow: showToLookAt } : null}
            // UX P1 point 7 (P-E): a ship stopped on a conflict names its
            // files — in Now's own Details (1.175.0 F8).
            details={shipConflictOf(card) ? <ShipConflictFiles card={card} /> : undefined}
            state={presentationState}
            rule={presentation.rule}
            label={areaPress ? startingInAreaLabel(areaPress.area) : statePresentation.label}
            title={areaPress ? undefined : (actor?.words ?? undefined)}
            wait={waitNow}
            actionId={statePresentation.actionId}
            actionLabel={areaPress ? AREA_START_STOP_LABEL : primaryLabel}
            actionName={areaPress ? AREA_START_STOP_LABEL : statePresentation.actionLabel}
            actionTitle={
              (statePresentation.actionId === "start-build" && startBuildClaimTitle(claim.state, claim.loginKnown)) ||
              statePresentation.actionTitle
            }
            helper={withOutsideNote(
              // 1.175.0 B2: who changed the checks, and the two versions.
              (presentation.rule === "checks-ok" ? <ChecksConsentNow card={card} /> : null) ??
              // U28: a teammate's open pull request is the first thing to know
              // on a card they hold.
              (presentation.rule === "claimed" ? teammatePrLine(linkedPrs, claimLogin) : null) ??
              // A closed card with no run here and a merged pull request linked
              // to its issue says that, whatever closed it.
              (presentationState === "closed" ? mergedPrLine(linkedPrs, claimLogin) : null) ??
              // C3 (§2b): starting in the area just chosen, once it is saved.
              (areaPress?.saved ? areaSetLine(areaPress.area, vendorName(preferredVendor)) : null) ??
              // 1.174.0 (C3, §2): the question's areas, under why it asks.
              (presentation.rule === "choose-area" && areaNowFact?.kind === "choose" && areaState ? (
                <>
                  {statePresentation.helper}
                  <span className="ux-now-ask" data-ply-now-area="">
                    <Select
                      label={AREA_LABEL}
                      value={areaPick}
                      options={areaChoices(areaState)}
                      disabled={starting || briefSaving || areaBusy}
                      onChange={setAreaChoice}
                    />
                    {(() => {
                      const suggested = areaState.areas.find((a) => a.id === areaState.suggested);
                      const hint = suggested && suggested.id === areaPick ? areaFilesHint(suggested) : null;
                      return hint ? <span className="ux-card-muted-inline">{hint}</span> : null;
                    })()}
                  </span>
                </>
              ) : null) ??
              draftHold ??
              sessionWords ??
              fixRoundWords ??
              // A3: a copy says so first. Owner 2026-11-10: the README card's
              // only; the tour's card says it under What you want.
              (readmeGuided && statePresentation.actionId === "start-build" && !card.fromCopy
                ? guidedStartSentence(preferredVendor, shipTargetOf(card))
                : stateHelper),
              // 1.175.0 (B3): before a start, on an issue somebody outside
              // the repository wrote.
              issueLinked && notStarted(presentationState) && !hasLocalRun(card) ? outsideAuthor(card) : null,
              workspace?.githubOwnerRepo,
            )}
            tone={areaPress ? "quiet" : statePresentation.tone}
            runState={areaPress ? "running" : run.state}
            live={areaPress ? true : run.live}
            disabled={areaPress ? !areaStopOn : primaryDisabled}
            disabledReason={copyEmpty ? COPY_BRIEF_EMPTY : null}
            path={deliveryNow}
            onSignIn={() =>
              useUi.getState().openSettingsSection(GITHUB_ACCOUNTS_PAGE, { row: GITHUB_ACCOUNTS_ROW })
            }
            secondary={secondary}
            seeChanges={seeChanges}
            tryIt={tryIt}
            checkFirst={checkFirst}
            chip={readyToShipNow ? <OverlapChip warnings={overlaps} target={shipTarget} /> : undefined}
            variants={areaPress ? undefined : nowVariants}
            planFirst={!areaPress && planFirstShown ? { items: planFirstItems, tour: "card-plan-two-ais" } : undefined}
            // 1.175.0 F8: the one note under Now's primary (`nowNote`, by rank).
            note={<CardNowNote card={card} actionId={statePresentation.actionId} noPullRequestWords={outcomePresentation.noPullRequestWords}
              onlyHere={outcomePresentation.onlyHere} />}
            onAction={areaPress ? (e) => stopAreaPress(e) : pressPrimary}
          />}

          {/* 1.172.0 (C3 follow-up): with the Review and the session open
              together, the Review sits in column 1 on a wide page but after
              the brief and Activity in the Tab order — one press goes
              there. Shown when it has focus. */}
          {reviewWithSession && (
            <a
              href={`#card-review-${card.id}`}
              className="ux-skip-link"
              data-ply-review-skip=""
              onClick={(e) => {
                e.preventDefault();
                reveal("outcome", REVIEW_FOCUS);
              }}
            >
              Go to the Review
            </a>
          )}

          {!card.prReview && (autoFixWaits || fixRoundNow) && (
            <UnattendedAsksNote card={card} kind={autoFixWaits ? "autoFix" : "round"} />
          )}

          {/* 1.170.0 (G6): Behind main / Conflict ahead, and Bring in main's
              changes — only on the press. 1.174.0 (A7, VC-2): bordered
              while Now has its own filled primary. */}
          {!card.prReview && <TargetSyncLine
              card={card}
              nowHasPrimary={statePresentation.tone === "accent"}
              nowHeadline={actor?.words ?? statePresentation.label}
            />}

          {/* SP-3: built by both and not picked — both builds under Now from
              the start, live; the terminals stay in the session section. */}
          {isUndecided(card) && (
            <BuildBothCards
              card={card}
              onOpenSession={(lane) => {
                useBuildBoth.getState().showLane(card.workspaceId, card.id, lane);
                reveal("run");
              }}
            />
          )}

          {/* Try it TI-4: the copy's running app, under Now. No terminal in
              it: the session is a tile on Terminals. */}
          {!card.prReview && <TryItPanel card={card} />}

          {/* GH #104 walk: the improvement proposal's line, where a card that
              is Ready to ship can see it — the Shipping section below opens
              only once shipping ran, so the line is drawn there only while it
              is open. */}
          {openSection !== "ship" && <CardProposalLine card={card} />}

          {/* UX P-A Windows walk 1: a Ship a typed refusal stopped says why in
              Now — the refusal's own block and its ways out. 1.175.0 F8: only
              while it leads (`cardErrorNow`); else it waits in Details. */}
          {troubles.now === "ship-refused" && shipRefusalBlocks}
          {/* A pull request review card has no Now: its error leads here. */}
          {card.prReview && lead && (
            <ErrorBlock
              error={lead.error}
              density="dense"
              onAction={lead.onAction}
            />
          )}

          {/* 1.172.0 (C1): a card not built yet leads with its brief. */}
          {briefFirst && briefBlock}

          {/* OB-16 (§14): the guided first card's Guide, under the Now box. */}
          <FirstCardGuide
            workspaceId={card.workspaceId}
            cardId={card.id}
            state={presentationState}
            landed={cardShippedOrPrOpen(card)}
            vendor={card.builder?.vendor ?? preferredVendor}
            shipsAs={shipsToGitHub ? "pr" : "merge"}
          />

          {/* QoL 1.168 (C1, V-1): the Now box first, straight under the
              title; the card's facts follow it in one line, the state said
              once (the Now box's title). */}
          {/* 1.172.0 D2: the facts in words, See the checks, then Change… last. */}
          {/* 1.175.0 F10: before the first build, the facts the sentence
              under What you want says aren't said again (`factsBeforeBuild`). */}
          {!card.prReview && lineFacts.length > 0 && <Properties line items={lineFacts} trailing={factsLineShown ? changeButton : undefined} trailingLabel="Choices" />}
          {!card.prReview && factsLineShown && pickersPanel}
          {!card.prReview && <StartedLocalLine card={card} />}
          {/* 1.171.0 D3: the folder's changes not saved in Git aren't in the copy. */}
          {!card.prReview && <UnsavedWorkLine card={card} />}

          {/* 1.174.0 (C1, P8): once built, the Review comes right under Now
              and its facts — Now · Review · When it merges (in the Review)
              · Activity · What you asked · Details. Closed, it takes no
              room, so a card not built yet still leads with its brief. */}
          {/* The Challenger's review is read here, in the Review: the tour's
              card-review (TUTORIAL_SPEC §4.3). Closed, it is not on screen
              and the tour opens it with Take me there. 1.172.0 (C2; CP B2):
              the checks, the Challenger, the overlap; See the changes · Try
              it · Not right; the same Ship it ▾. */}
          <CardSection
            name="outcome"
            id={`card-review-${card.id}`}
            open={reviewOpen}
            // 1.172.0 D2 (CP-21): the Review until it ships; then the card's
            // one receipt, What shipped.
            title={receipt ? SHIPPED_SECTION_TITLE : REVIEW_SECTION_TITLE}
            tour="card-review"
            onHide={() => hideSection("outcome")}
          >
            {/* What was asked, the review, the checks, the diff, "Not
                right" and its pull request. It stays mounted: it holds the
                Ship runner the Now action presses. */}
            {/* Challenger on a pull request: no Ship; its review is above. */}
            {!card.prReview && <OutcomeScreen
              workspaceId={card.workspaceId}
              card={card}
              onPresentationChange={onOutcomePresentationChange}
              onReviewFreshnessChange={onReviewFreshnessChange}
              onRerunStaleReady={onRerunStaleReady}
              onShipReady={onOutcomeShipReady}
              onRedoReady={onOutcomeRedoReady}
              onFailure={onOutcomeFailure}
              reviewTip={reviewTip}
              nowOffersRedo={redoInNow}
              nowOffersChecksFix={fixInNow}
              nowOffersShipMenu={shipVariants !== undefined}
              nowOffersSeeChanges={seeChanges !== undefined}
              ship={reviewShip}
              overlaps={overlaps}
              releasing={presentation.rule === "releasing"}
              onSeeDiff={openDiff}
              onHideDiff={closeDiff}
              diffOpen={diffShown}
              onDiffChange={setDiffOffer}
              tryIt={
                // 1.172.0 (C2): where Now has none — the tour's Try it then.
                tryOffered && !tryIt ? (
                  <CBtn
                    tone="quiet"
                    data-ply-try-it="review"
                    data-ply-tour={TRY_IT_TOUR}
                    title="Start your app in the card's copy and see it here."
                    onClick={() => pressTryIt(card, tryLane)}
                  >
                    {TRY_IT_LABEL}
                  </CBtn>
                ) : undefined
              }
            />}
            {/* 1.172.0 D2 (CP-21): a shipped card's one receipt — its pull
                request, Ship history and Try it in the project follow what
                shipped. */}
            {receipt && shipStep}
          </CardSection>

          {/* SP-1 phase 2: the result's diff, its own section — always
              mounted while the result has one (its verdicts, line comments
              and round switch survive Hide), shown by "See the diff" and
              open only together with the result: beside it on a wide page,
              after it on a narrow one. */}
          <CardSection
            name="diff"
            open={diffShown}
            title="The changes"
            onHide={closeDiff}
          >
            {diffOffer && (
              <div className="ux-card-outcome-body">
                <CardReviewPanel
                  workspaceId={card.workspaceId}
                  card={card}
                  shipBusy={outcomePresentation.shipBusy}
                  openPrNumber={diffOffer.openPrNumber}
                />
              </div>
            )}
          </CardSection>

          {/* The shipped result, its receipts, and a stopped ship's block
              (GH #151, #222) — `Show` on their toast opens this. */}
          {!receipt && (
            <CardSection
              name="ship"
              open={openSection === "ship" && !card.prReview}
              title="Shipping"
              onHide={() => openOnly(null)}
            >
              {!card.prReview && shipStep}
            </CardSection>
          )}

          {/* 1.174.0 (C1, BCI-16; G3a walk): a card whose pull request is
              open keeps When it merges right after its Review and Shipping
              (card-page.html §1), as the Review drew it before Ship. */}
          {!card.prReview && prOpen(card) && (
            <WhenItMerges
              workspaceId={card.workspaceId}
              cardId={card.id}
              version={`${card.builder?.snapshots.length ?? 0}:${card.pr?.headSha ?? ""}:${card.pr?.checks ?? ""}`}
            />
          )}


          {/* UX-6.4: the conversation stays mounted while the intake is
              active and is shown only when opened. The terminal is outside
              every disclosure so it stays measurable. */}
          {intakeStatus === "active" && (
            <CardSection
              name="intake"
              open={openSection === "intake"}
              title={`Conversation with ${vendorName(planner)}`}
              // 1.172.0 D2 (CP-23): its own Hide; Now's press only opens it.
              onHide={() => openOnly(null)}
            >
              {intakeWarning && (
                <Callout
                  kind="info"
                  text={`${intakeWarning.summary}. Advisory only; the conversation stays available.`}
                />
              )}
              {intakePtyId ? (
                <IntakeConversation
                  cardId={card.id}
                  ptyId={intakePtyId}
                  onUnexpectedExit={onIntakeUnexpectedExit}
                  onSwept={onIntakeSwept}
                />
              ) : (
                <p className="ux-card-muted">
                  This card is marked as planning, but no conversation is attached in
                  this session. Stop planning and plan again.
                </p>
              )}
              {/* GH #256: Conclude is the Now callout's; Cancel is in the ⋯. */}
            </CardSection>
          )}

          {/* UX-6.3: the Builder's live terminal (or the swarm's run) is
              mounted always and shown only on "Open session". */}
          <CardSection
            name="run"
            open={sessionOpen}
            title={sessionTitle}
            // 1.172.0 D2 (CP-23): the section's own Hide, always — Now's
            // press only opens it. C3: it closes only the session.
            onHide={() => hideSection("run")}
          >
            {/* Challenger on a pull request: someone else's has no Builder. */}
            {!(card.prReview && !card.prReview.pushable) && (
              <CardRunStep
                card={card}
                // 1.171.0 C2: a Finish and check that stopped offers Resume
                // in Now too, beside Finish and check again.
                resumeInNow={presentationState === "session-closed" || presentation.rule === "check-stopped"}
                // 1.174.0 C4 (G3a walk): its Start build holds as Now's.
                startHold={{ reason: held ? (heldReason ?? askEmptyReason) : null, before: saveBriefFirst }}
              />
            )}
          </CardSection>

          {/* Card chat (part 2): mounted once first opened, then kept (hidden
              like every section), so a terminal, a draft and a stream
              survive Hide. Keyed by card: this page is not. */}
          <CardSection
            name="chat"
            id={`card-chat-${card.id}`}
            open={openSection === "chat"}
            title={ASK_ABOUT_CARD_LABEL}
            onHide={() => openOnly(null)}
          >
            {(openSection === "chat" || chatStarted) && (
              <ChatPanel
                key={card.id}
                workspaceId={card.workspaceId}
                cardId={card.id}
                pullRequest={card.prReview ? { pushable: card.prReview.pushable, fixNote: card.prReview.fixNote } : null}
                // 1.171.0 (E1): the chat opens on the card's Builder, says
                // the Builder doesn't see it, and tells the Builder through
                // the result's Not right path.
                builder={{
                  // Challenger 6: the card's Builder when it can run here,
                  // else the one that can.
                  vendor: intakeVendorFor(roleVendor, vendorReadiness(doctorReport)),
                  reach: chatBuilderReach({
                    landed: cardDone,
                    hasBuilder: changesRoute(card) === "builder",
                    archived: Boolean(card.archived),
                  }),
                  // Challenger 4: its own words to the Builder; the session
                  // opens (the toast says why) as for every message to it.
                  tell: (text) =>
                    useBuilder.getState().askBuilder(card.workspaceId, card.id, tellBuilderMessage(text), {
                      sentBody: TELL_BUILDER_SENT,
                      markSent: true,
                      key: TELL_BUILDER_KEY,
                      // 1.172.0 (A1): kept on the card for the Challenger.
                      laterRequest: { text, source: "chat" },
                    }),
                }}
                plan={{
                  offered: twoAisOffered,
                  preferred: preferredVendor,
                  dispatchPromptEditedAt: card.dispatchPromptEditedAt ?? null,
                  archived: Boolean(card.archived),
                  heldReason: held ? (heldReason ?? askEmptyReason) : null,
                }}
              />
            )}
          </CardSection>

          {/* UX-6.5: the card's story replaces the stepper. A link opens its
              detail below; the details stay mounted when closed. */}
          <section className="ux-card-section" aria-label="Activity" data-ply-card-activity="" tabIndex={-1}>
            <h2 className="ux-card-heading">Activity</h2>
            <Timeline events={timeline} />
          </section>

          {/* 1.174.0 (C1, P8): a built card's brief, folded after its story —
              "What you asked", its first line, Show. Kept mounted closed, so
              a draft in it survives. */}
          {!briefFirst && (
            <div className="ux-card-brief-folded" data-ply-card-brief-fold={briefShown ? "open" : "closed"}>
              {/* Challenger 4: a heading like the sections around it; the
                  button's name is short, its first line the description. */}
              <h2 className="ux-card-heading ux-card-brief-fold-heading">
                <button
                  type="button"
                  className="ux-card-brief-fold"
                  aria-expanded={briefShown}
                  aria-controls={`card-brief-${card.id}`}
                  aria-label={`${BRIEF_FOLD_TITLE}, ${briefShown ? BRIEF_FOLD_HIDE : BRIEF_FOLD_SHOW}`}
                  aria-describedby={!briefShown && briefLine ? `card-brief-line-${card.id}` : undefined}
                  onClick={() => setBriefShown(!briefShown)}
                >
                  <Icon name="expand" size="sm" />
                  <span className="ux-card-brief-fold-title">{BRIEF_FOLD_TITLE}</span>
                  {!briefShown && briefLine && (
                    <span className="ux-card-brief-fold-line" id={`card-brief-line-${card.id}`}>
                      {briefLine}
                    </span>
                  )}
                  <span className="ux-card-brief-fold-press">{briefShown ? BRIEF_FOLD_HIDE : BRIEF_FOLD_SHOW}</span>
                </button>
              </h2>
              <div id={`card-brief-${card.id}`} hidden={!briefShown}>
                {briefBlock}
              </div>
            </div>
          )}

          {planRecord && (
            <CardSection
              name="plan"
              open
              title="The plan"
              onHide={() => setPlanOpen(null)}
            >
              <IntakePlan record={planRecord} />
            </CardSection>
          )}

          {/* 1.172.0 D2 (CP-28): one Details — Files, History of runs,
              Technical — after the card's story: what a person needs only
              to go looking (GH #302). Files is the part people use; the
              brief's Files chip opens it. */}
          <Details
            summary={detailsSummary(troubles.more.length)}
            open={moreOpen}
            onToggle={setMoreOpen}
            data-ply-self-check-disclosure=""
          >
            <div className="ux-card-details" data-ply-card-details="">
              {/* 1.175.0 F8: what else needs a look, first. */}
              <ToLookAt ref={toLookAtRef} kinds={troubles.more} troubleOf={troubleOf} refusal={shipRefusalBlocks} />
              {/* Windows walk 2026-10-20: a Ship that had to keep the card's
                  copy says so, and why — a quiet fact, in Details (F8). */}
              {!card.prReview && <KeptCopyLine card={card} />}
              <div data-ply-card-details-files="">
                <CardMore card={card} files={cardFiles} />
              </div>
              {(runHistoryShown(card) || (card.intakeHistory ?? []).length > 0) && (
                <section className="ux-card-more" aria-label="History of runs" data-ply-card-details-runs="">
                  <h3 className="ux-card-field-label">History of runs</h3>
                  {/* v1.19.0 (Cycle E4): append-only intake history with lazy
                      transcript fetch. */}
                  <IntakeHistorySection history={card.intakeHistory ?? []} />
                  {/* 1.172.0 D1 (CP-4): run history's switch and Clear are
                      here, beside the runs, not in the ⋯. */}
                  {runHistoryShown(card) && (
                    <RunHistoryAccordion
                      entries={runHistory}
                      recording={!card.suppressRunHistory}
                      onRecording={(on) => void updateCard(card.id, { suppressRunHistory: !on })}
                      onClear={async () => {
                        if (
                          await confirmSheet(CLEAR_RUN_HISTORY)
                        ) {
                          void clearRunHistory(card.id);
                        }
                      }}
                    />
                  )}
                </section>
              )}
              {/* Branch, copy, ports, rounds, models, claim: closed until
                  asked, inside Details. */}
              <Details summary="Technical" data-ply-self-check-disclosure="">
                <CardTechnicalDetails card={card} reviewNote={owedVerdictNote} claim={
                  githubBoard ? (
                    <CardClaimControl
                      card={card}
                      onClaim={() => void claimCard(card.workspaceId, card.id).catch(() => {})}
                    />
                  ) : null
                } />
              </Details>
            </div>
          </Details>
        </div>
        </div>
      </Page>

      {discussionOpen && (
        <DiscussionModal
          workspaceId={card.workspaceId}
          initialCardId={card.id}
          initialProblem={cardBriefText(card)}
          issueCard={Boolean(card.ghIssueNumber)}
          initialSynthesizer={
            effectiveBuilderVendor(
              useBuilder.getState().vendorPref[card.id],
              card,
              useSettings.getState().settings.behavior.builderVendor,
            )
          }
          onClose={() => setDiscussionOpen(false)}
        />
      )}
      {deleteDialog}
      {followUpAsk && (
        <FollowUpSheet
          cardTitle={card.title}
          draft={followUpAsk}
          busy={followingUp}
          onMake={(chosen) => void makeFollowUp(chosen)}
          onClose={() => setFollowUpAsk(null)}
        />
      )}
      <TryStartSheetHost workspaceId={card.workspaceId} />
    </div>
  );
}

/**
 * C6: a part of the card page that is always mounted and shown only when
 * opened — the conversation, the session, the result, the ship. Closed, it
 * takes no room and keeps its content laid out at full size, invisible and
 * inert: a terminal inside keeps its PTY, its scrollback and its size.
 */
function CardSection({
  name,
  id,
  open,
  title,
  onHide,
  tour,
  children,
}: {
  name: CardPagePart;
  /** Its tour anchor (TUTORIAL_SPEC §4.3), on the one section that has one. */
  tour?: TourAnchor;
  id?: string;
  open: boolean;
  title: string;
  /** Omitted when the Now action already shows and hides this section. */
  onHide?: () => void;
  children: ReactNode;
}) {
  return (
    <section
      className={open ? "ux-card-slot" : "ux-card-slot ux-card-slot--closed"}
      id={id}
      data-ply-card-section={name}
      data-ply-tour={tour}
      aria-label={title}
      aria-hidden={open ? undefined : true}
      inert={!open}
    >
      <div className="ux-card-slot-body">
        <div className="ux-card-slot-head">
          <h2 className="ux-card-heading" tabIndex={-1} data-ply-section-heading="">
            {title}
          </h2>
          {onHide && (
            <CBtn tone="quiet" onClick={onHide}>
              Hide
            </CBtn>
          )}
        </div>
        {children}
      </div>
    </section>
  );
}

/** UX-6.2: the card's title, edited in place (Enter or blur saves, Esc
 *  puts it back). A read-only card shows the words only. */
function CardTitle({
  value,
  readOnly,
  onChange,
  onCommit,
  onRevert,
}: {
  value: string;
  readOnly: boolean;
  onChange: (next: string) => void;
  onCommit: () => void;
  onRevert: () => void;
}) {
  const [editing, setEditing] = useState(false);
  if (readOnly || !editing) {
    return readOnly ? (
      <span>{value}</span>
    ) : (
      <button
        type="button"
        className="ux-card-title"
        title="Rename this card"
        onClick={() => setEditing(true)}
      >
        {value}
      </button>
    );
  }
  return (
    <input
      className="ux-card-title-input"
      aria-label="Title"
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => {
        onCommit();
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onRevert();
          setEditing(false);
        }
      }}
    />
  );
}

/** 1.169.1 (R2): a card started from a target on this Mac that holds
 *  commits GitHub's doesn't says so on the card, under its facts — not only
 *  in Technical details. Read when the card opens, each time it changes and
 *  each time the window comes back; gone once GitHub has them (as last
 *  fetched), or the card has landed. */
export function StartedLocalLine({ card }: { card: KanbanCard }) {
  const asks = startMayBeLocal(card.worktreeBase) && Boolean(card.worktreePath) && !card.archived && !cardShippedOrPrOpen(card);
  const [line, setLine] = useState<{ cardId: string; text: string | null } | null>(null);
  // Read again whenever the window comes back (a push made elsewhere, in a
  // terminal or on GitHub, may have published the target meanwhile).
  const [looked, setLooked] = useState(0);
  useEffect(() => {
    if (!asks) return;
    const again = () => {
      if (document.visibilityState !== "hidden") setLooked((n) => n + 1);
    };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [asks]);
  useEffect(() => {
    if (!asks) return;
    let cancelled = false;
    cardLocalBaseCommits(card.workspaceId, card.id)
      .then((local) => {
        if (!cancelled) setLine({ cardId: card.id, text: startedLocalLine(card.worktreeBase, local) });
      })
      .catch(() => {
        if (!cancelled) setLine(null);
      });
    return () => {
      cancelled = true;
    };
  }, [asks, card.workspaceId, card.id, card.worktreeBase, card.updatedAt, looked]);
  const text = asks && line?.cardId === card.id ? line.text : null;
  return text ? (
    <p className="ux-card-muted" data-ply-card-local-start="">
      {machineWords(text)}
    </p>
  ) : null;
}

/** 1.172.0 D2 (CP-29): the card page's last crumb — the Board column the
 *  card sits in, or Archived. */
function columnCrumb(column: AttentionColumn | null): string {
  if (column === null) return "Archived";
  return ATTENTION_COLUMNS.find((c) => c.id === column)?.label ?? "Board";
}
