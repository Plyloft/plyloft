import { earlyDraftForShip } from "../store/prDraftEarlyStore";
import { PrDraftRow } from "./PrDraftRow";
import { endSentence } from "../lib/plainError";
import { forgetJustPut, usePutOnGithubCount } from "./PutOnGithubSheet";
import { machineWords } from "../lib/platform";
import { reviewerWords } from "../lib/words";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePlanner } from "./usePlanner";
import { newCardBuilderVendor } from "../lib/settingsShape";
import {
  cardOutcome,
  cardReviewRequestChanges,
  cardShip,
  cardShipWithFollowUp,
  decodeTargetDirtyError,
  openWebLink,
  workspaceShipOffersPr,
  type BuilderReview,
  type CardOutcome,
  type ReviewTipFacts,
} from "../ipc";
import { useKanban, type KanbanCard } from "../store/kanbanStore";
import { useSwarms } from "../store/swarmStore";
import { draftPullRequestFor, useBuilder } from "../store/builderStore";
import { NOWHERE_FOR_CHANGES, changesRoute, changesSentStands, notRightWords } from "../lib/reviewChanges";
import { dismissToast, pushToast } from "../store/toastStore";
import { installHeldAfter } from "../store/checksConsentStore";
import { installHeldSentence } from "../lib/checksConsent";
import { announceShipConflict } from "../store/shipConflictToast";
import { showPlanRefusal } from "../store/planPrompts";
import { observeShipAttempt } from "../store/errorBlockStore";
import { useWorkspaces } from "../store/workspaceStore";
import { openCardStep } from "../store/uiStore";
import { cardActionError, dayWords, loadFailedError, pushbackAccepted, rawError } from "../lib/cardPage";
import { NOTHING_RUNS_AFTER_SHIPPING, goLiveWords } from "../lib/shipDone";
import { SHOW_THEM, TARGET_DIRTY_TITLE, targetDirtyToastBody } from "../lib/shipPreflight";
import { openFolderChanges } from "../store/projectFolderStore";
import { carriesLocalCommitsQuestion, landedCardTitles, prOpen, prShipLine, shippedSessionKind } from "../lib/prStatus";
import { closeBuilderWithUndo, followBuilderSession } from "../store/builderAtDone";
import { prOpenedMerger, prOpenedToastLine } from "../lib/deliveryWords";
import { asRecordUnreadable, type UxError } from "../lib/uxError";
import { CBtn, Details, ErrorBlock, StatusLine } from "./ux";
import { confirmChoice } from "../store/confirmStore";
import { askOutsideFiles, ensureCardArea } from "../store/cardAreaStore";
import { localShipLine, remoteWords, targetHere } from "../lib/worktreeBase";
import { CardReviewPanel } from "./CardReviewPanel";
import { IndependentReview } from "./IndependentReview";
import { ClaudeReviewTrustStep } from "./ClaudeReviewTrust";
import { reviewMetTrustQuestion } from "../lib/claudeReviewTrust";
import { OverlapWarnings } from "./OverlapWarnings";
import type { OverlapWarning } from "../ipc";
import { useCardDelete } from "./CardDeleteDialog";
import { isSkillCard, skillCardLine, skillShipLine } from "../lib/skillCards";
import { markSkillCardBehind, refreshSkillCard, skillBehindNow } from "./useSkillCardBehind";
import { skillBehindShowFirstHelper } from "../lib/cardPresentation";
import { MarkdownText } from "./MarkdownText";
import {
  SHIP_CHOICE_LABELS,
  SHIP_NOTICE_QUESTION,
  shipAnywayTitle,
  shipChoiceHint,
  shipChoiceMode,
  shipChoiceRemembers,
  shipItGoesToGitHub,
  shipNoticeAnswer,
  shipWithoutAutoMergeMode,
  shipNoticeDue,
  shipPressLabel,
  shipPressOf,
  type ShipChoice,
  type ShipMode,
} from "../lib/shipVia";
import { SHIP_ANYWAY_LABEL, overriddenByWho } from "../lib/deliveryWords";
import { useSettings } from "../store/settingsStore";
import { ShippedResult, SkippedReviewLine } from "./ShippedResult";
import { VerifyPanel } from "./VerifyPanel";
import { ReviewAgainButton } from "./BuilderRunStep";
import { latestSnapshotKey } from "../lib/snapshotRevision";
import { shipOffersTryInProject } from "../lib/tryProject";
import { tryInProjectAction, useTryRuns } from "../store/tryRunStore";
import { ChallengerFindings, SeriousCatch } from "./ChallengerFindings";
import { GlossaryText } from "./GlossaryText";
import { WhenItMerges } from "./WhenItMerges";
import {
  SWEEPING_TEXT,
  isSweep,
  reviewCoverage,
  reviewCanRunAgain,
  reviewIncomplete,
  reviewTruth,
  singleVendorReviewTip,
  type ReviewTruth,
  changesRequestedResultLine,
  followUpShippedLine,
  prShipOffer,
  SHIP_PR_WITH_FOLLOW_UP_LABEL,
  SHIP_WITH_FOLLOW_UP_LABEL,
  shipWithFollowUpOffer,
  verdictOwed,
  reviewApprovedWord,
} from "../lib/challengerReview";
import { linkDidNotOpen } from "../lib/linkToast";
import { cardPageIsOpen } from "../lib/errorButtons";
import { pressOnce, sayStillRunning, shipPressKey, shippingStillRunning, usePressRunning } from "../lib/pressOnce";
import { errorToastFor, pushErrorToast } from "../lib/errorToast";

/** v1.39.0: detect the synthesis-fallback prefix on a recon summary.
 *  When present, the audit ran on the pre-v1.38 ux-reviewer / architect
 *  prompt; we surface a small nudge pointing the user to reseed role
 *  presets for a richer next audit. The prefix is the literal string
 *  written by `synthesize_recon_summary_md` in commands.rs. */
function isSynthesizedSummary(md: string | null | undefined): boolean {
  if (!md) return false;
  return md.trimStart().startsWith("> _Synthesized from structured artifact fields");
}

/**
 * v1.31.0 (Outcome screen): the vibe-default post-swarm surface. A non-
 * developer reviews *outcomes* — what was asked, whether an AI reviewer
 * approved it, whether automated checks pass — then Ships it or sends it
 * back. The per-hunk diff (Cycle 1's `CardReviewPanel`) is one click away
 * under "Show developer details" — progressive disclosure, no mode toggle.
 *
 * Scope: card swarms only. Mounts in `CardDetailPanel`; wraps `OverlapWarnings`,
 * and `CardReviewPanel` when drawn on its own — on the card page the diff is
 * the page's "The diff" section (SP-1 phase 2, `onSeeDiff`).
 */
export type OutcomePresentationSummary = {
  loading: boolean;
  filesChanged: number | null;
  shipBusy: boolean;
  /** CL-11: the repository has no remote, so no pull request can be
   *  opened (`CardOutcome.hasRemote === false`). */
  noRemote?: boolean;
  /** G1: a pull request can be opened (`CardOutcome.hasRemote === true`). */
  prOffered?: boolean;
  /** 1.169.1 walk: why no pull request can be opened, in the card's words
   *  (`noPullRequestWords`) — the card page says it under Now, where a
   *  card Ready to ship has its Ship it. Null where one can be opened. */
  noPullRequestWords?: string | null;
  /** 1.175.0 F3: no remote at all (not another host, not an unreadable
   *  address) — the case "Put it on GitHub…" is offered for. Follows
   *  `noPullRequestWords`, so the card's comparison needs no field of its own. */
  onlyHere?: boolean;
};

/** SP-1 phase 2: the diff this result has, when it has one — drawn by the
 *  card page in its own section ("The diff"), beside the result on a wide
 *  page and after it on a narrow one. */
export type OutcomeDiffOffer = {
  /** An open pull request holds the card's work (RW-A): its diff. */
  openPrNumber: number | null;
};

/** CL-11 (walks): what a local-only repository says where Ship ▾'s pull
 *  request choices would be. */
// 1.175.0 F9 (UX-17): no "remote" on screen. The first sentence of F3's
// approved row; F3 adds "Put it on GitHub…" after it.
export const NO_REMOTE_WORDS = "This project is only on this Mac, so Ship it merges the card here.";

/** What the card page says happened, unless it is only the title again. */
function shipHappened(e: unknown): string {
  const said = cardActionError("Ship it", e).happened;
  return said === "Plyloft couldn't finish “Ship it”." ? "" : said;
}

/** R10: what a repository whose `origin` is on another host says there
 *  (the same words as Rust's `origin_elsewhere_words`). */
export function originElsewhereWords(host: string): string {
  return `Pull requests need a project on GitHub; this project is on ${host}.`;
}

/** R10 (Challenger): a GitHub address that isn't a repository's
 *  (the same words as Rust's `origin_unreadable_words`). */
export function originUnreadableWords(url: string): string {
  return `This project's GitHub address isn't a repository Plyloft can read: ${url}.`;
}

/** Where no pull request can be opened: why, in the card's words. */
function noPullRequestWords(
  outcome: { originHost?: string | null; originUnreadable?: string | null } | null | undefined,
): string {
  if (outcome?.originUnreadable) return originUnreadableWords(outcome.originUnreadable);
  return outcome?.originHost ? originElsewhereWords(outcome.originHost) : machineWords(NO_REMOTE_WORDS);
}

type Props = {
  workspaceId: string;
  card: KanbanCard;
  onPresentationChange?: (summary: OutcomePresentationSummary) => void;
  onReviewFreshnessChange?: (
    freshness: "none" | "fresh" | "stale",
  ) => void;
  onRerunStaleReady?: (handler: (() => Promise<void>) | null) => void;
  /** GH #99: the live branch tip and commits since the last review,
   *  polled by the card (`useReviewTip`). */
  reviewTip?: ReviewTipFacts | null;
  onShipReady?: (handler: ShipRunner | null) => void;
  /** C6 (UX-6.2): the card's Now callout offers "Not right"; it opens the
   *  same "tell them what's wrong" form this screen draws. */
  onRedoReady?: (open: (() => void) | null) => void;
  /** SP-2: the card's Now callout offers "Not right" itself; the result
   *  draws only the form it opens, not a second trigger. */
  nowOffersRedo?: boolean;
  /** Challenger block 5 (item 6): the Now callout offers "Ask the Builder
   *  to fix them"; the Checks here don't draw a second one. */
  nowOffersChecksFix?: boolean;
  /** SP-2: the card's Now callout offers Ship ▾ (1.171.0 B3: merge when
   *  checks pass, pull request only, only on this Mac); the result does not
   *  repeat them. */
  nowOffersShipMenu?: boolean;
  /** 1.170 walk: a release through a pull request is on its way for this
   *  card; the Now callout follows it, and the result offers no Ship. */
  releasing?: boolean;
  /** SP-1 phase 2: on the card page the diff is its own section. With
   *  these the result draws "See the diff" (or "Hide the diff") instead of
   *  the diff itself, and says whether it has one. Standalone, the diff
   *  stays inline behind "See the diff". */
  onSeeDiff?: () => void;
  onHideDiff?: () => void;
  diffOpen?: boolean;
  onDiffChange?: (offer: OutcomeDiffOffer | null) => void;
  /** Try it TI-4 (D18): the card's Try it button, in the review once the
   *  card's copy has changes. */
  tryIt?: ReactNode;
  /** 1.172.0 (C2): the card's Now callout offers See the changes itself
   *  (Changes requested, a Ship that didn't go through); the Review's row
   *  doesn't draw a second one. */
  nowOffersSeeChanges?: boolean;
  /** 1.172.0 (C2; CP B2): the same Ship it ▾ as Now, last in the Review on
   *  a card Ready to ship. In place of the pull request choices. */
  ship?: ReactNode;
  /** 1.172.0 (C2): the overlap rows the page read once (its chip under
   *  Now uses them too); undefined reads its own. */
  overlaps?: OverlapWarning[] | null;
  /** C6 (UX-6.8): on the card page a failed press is drawn there, in the
   *  error shape; the toast then only says it happened. Standalone, the
   *  toast keeps the reason. SP-1 review 4: it names the card the press
   *  was for and says whether the page drew it — a page now showing another
   *  card does not, and the toast then says it, with Show. */
  onFailure?: (action: string, cause: unknown, cardId: string, followUp?: boolean) => boolean;
};

/** Ship the card; ADR 0006: `followUp` ships it with its open findings
 *  made into one new card (`Ship with follow-up`). */
export type ShipRunner = (
  mode: ShipMode,
  /** `remember` (1.171.0 B3, CP-6): Ship ▾'s pull request choices — the
   *  workspace's remembered merge when checks pass, written before the ship
   *  (a `pr` ship follows it). */
  options?: { followUp?: boolean; remember?: boolean },
) => Promise<void>;

/** 1.171.0 B3: the words when Ship ▾'s choice couldn't be remembered. */
export const SHIP_CHOICE_NOT_SAVED = "Your choice wasn't remembered";

/** GH #306: is this card's page the one on screen — its workspace active,
 *  the Board showing, this card open over it? */
const cardPageShowing = cardPageIsOpen;

/** SP-1 review 3: a piece of state kept per card — the card page's editor is
 *  not keyed by card, so plain state would follow the person to the next
 *  card. A setter writes to the card it was made for, so a press still in
 *  flight when the person switched settles on its own card. */
function usePerCard<T>(cardId: string, initial: T): [T, (value: T) => void] {
  const [byCard, setByCard] = useState<Record<string, T>>({});
  const value = Object.prototype.hasOwnProperty.call(byCard, cardId) ? byCard[cardId] : initial;
  const set = useCallback(
    (next: T) => setByCard((m) => (m[cardId] === next ? m : { ...m, [cardId]: next })),
    [cardId],
  );
  return [value, set];
}

/** 1.170.0 (walk fix): how long "Pull request opened" stays. Its Open on
 *  GitHub is a shortcut — the card offers the pull request too — so it
 *  goes after a while instead of staying until dismissed (the walk saw it
 *  on screen for the whole session, across workspaces). */
export const PR_OPENED_TOAST_MS = 10_000;

export function OutcomeScreen({
  workspaceId,
  card,
  onPresentationChange,
  onReviewFreshnessChange,
  onRerunStaleReady,
  onShipReady,
  onRedoReady,
  onFailure,
  reviewTip = null,
  nowOffersRedo = false,
  nowOffersChecksFix = false,
  nowOffersShipMenu = false,
  releasing = false,
  onSeeDiff,
  onHideDiff,
  diffOpen = false,
  onDiffChange,
  tryIt,
  nowOffersSeeChanges = false,
  ship,
  overlaps,
}: Props) {
  const onFailureRef = useRef(onFailure);
  onFailureRef.current = onFailure;
  // OB-14: a new card is planned by the Settings Builder vendor, or the one
  // that is ready.
  // DS4 round 1: the AI a new card really starts with (the last card's pick).
  const newCardVendor = useSettings((s) => newCardBuilderVendor(s.settings.behavior));
  const newCardPlanner = usePlanner({ id: "", builderVendorPref: newCardVendor });
  const loadFromDisk = useKanban((s) => s.loadFromDisk);
  // Skills hub H3a: *Already up to date* offers Delete card.
  const { requestDelete, dialog: deleteDialog } = useCardDelete();
  const requestDeleteRef = useRef<(() => void) | null>(null);
  requestDeleteRef.current = () => requestDelete(card);
  // Challenger, 2026-10-19: a toast with an action now stays until it is
  // dismissed, and *Delete card* opens this screen's own dialog — so the
  // toast goes with the screen rather than offering a press that does nothing.
  const upToDateToast = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (upToDateToast.current) dismissToast(upToDateToast.current);
    },
    [],
  );
  const forkToImplementation = useKanban((s) => s.forkToImplementation);
  const workspaceCwd = useWorkspaces((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.cwd ?? null,
  );
  const [forking, setForking] = usePerCard(card.id, false);

  const linkedSwarmStatus = useSwarms((s) =>
    card.linkedSwarmId
      ? s.byWorkspace[workspaceId]?.swarms.find(
          (sw) => sw.id === card.linkedSwarmId,
        )?.status ?? null
      : null,
  );
  const swarmRunning =
    linkedSwarmStatus === "running" || linkedSwarmStatus === "suspended";

  // SP-1 review 2: the result is kept with the card it was read for — the
  // card page is not keyed by card, so on a switch the previous card's
  // result must not stand in for this one's (its diff, its numbers).
  const [loaded, setLoaded] = useState<{ cardId: string; outcome: CardOutcome } | null>(null);
  const outcome = loaded?.cardId === card.id ? loaded.outcome : null;
  /** G1: whether a pull request can be opened here (null: not read yet). */
  const hasRemote = outcome?.hasRemote ?? null;
  const setOutcome = useCallback(
    (next: CardOutcome | null) => setLoaded(next ? { cardId: card.id, outcome: next } : null),
    [card.id],
  );
  // SP-1 review 3: like the result, the presses in flight and the "Not
  // right" draft are the card's own — a switch shows the next card's (none
  // yet), and coming back shows this card's draft as it was left.
  const [busy, setBusy] = usePerCard(card.id, false);
  const [shipBusyHere, setShipBusy] = usePerCard(card.id, false);
  // 1.176.2 F2 (review M2): a Ship still running from before this page was
  // opened again shows here too — Ship waits, and says it is shipping.
  const shipRunning = usePressRunning(shipPressKey(workspaceId, card.id));
  const shipBusy = shipBusyHere || shipRunning;
  const [redoOpen, setRedoOpen] = usePerCard(card.id, false);
  const [redoText, setRedoText] = usePerCard(card.id, "");
  /** G4: the changes are held for the Builder's prompt. */
  const [redoQueued, setRedoQueued] = usePerCard(card.id, false);
  // G4 (launch D8), as walk I4: a "Not right" the Builder has and no newer
  // snapshot — Ship and Not right wait (the Now callout says so).
  const heldForBuilder = useBuilder((s) => changesSentStands(card, s.changesSent[card.id]));
  // PR #375: a new Build done is a new snapshot (n:sha), not a new count.
  const snapshotKey = latestSnapshotKey(card.builder);
  const putCount = usePutOnGithubCount(workspaceId);

  useEffect(() => {
    setOutcome(null);
    if (!card.worktreePath || swarmRunning) return;
    let cancelled = false;
    cardOutcome(workspaceId, card.id)
      .then((o) => {
        if (!cancelled) setOutcome(o);
      })
      .catch(() => {
        if (!cancelled) setOutcome(null);
      });
    return () => {
      cancelled = true;
    };
    // v1.110.5 (pilot finding 5): the step bodies stay mounted, so this
    // fetch first ran when the card opened — before the Builder changed a
    // line. Refetch on every Build done (latest snapshot), when the
    // Challenger settles, and when the run status moves.
  }, [
    workspaceId,
    card.id,
    card.worktreePath,
    card.reviewStatus,
    card.lastRunStatus,
    snapshotKey,
    card.builder?.review?.status,
    swarmRunning,
    setOutcome,
    // Mac walk 2 (H3a): Refresh card rebuilds a skill card's commit.
    card.kind?.origin.version.contentId,
    // 1.175.0 F3: the project was just put on GitHub (`hasRemote`).
    putCount,
  ]);

  const runShipUnguarded = useCallback(
    async (pressed: ShipMode, options?: { followUp?: boolean; remember?: boolean }) => {
      // 1.173.0 (B3): a card with no area asks first, and one that changed
      // files outside its area says so (scene 4) — before anything else.
      if (!(await ensureCardArea(workspaceId, card.id, "ship"))) return;
      if ((await askOutsideFiles(workspaceId, card.id)) === "stop") return;
      // G1: where this workspace's Ship it goes, and the one-time notice the
      // first Ship it to GitHub asks (Cancel ships nothing).
      const ws = useWorkspaces.getState().workspaces.find((w) => w.id === workspaceId);
      // G1 Challenger (5): a Ship it pressed while the result still loads
      // reads it first (else the workspace's own reading), so the notice is
      // never skipped on a project that ships to GitHub.
      let prOffered = hasRemote;
      if (prOffered === null && pressed === "ship_it" && ws?.shipVia !== "local") {
        prOffered = await cardOutcome(workspaceId, card.id).then(
          (o) => o.hasRemote ?? null,
          () => null,
        );
        if (prOffered === null) prOffered = await workspaceShipOffersPr(workspaceId).catch(() => null);
      }
      const toGitHub = shipItGoesToGitHub(ws?.shipVia, prOffered);
      let mode = pressed;
      if (shipNoticeDue(mode, toGitHub, ws?.shipNoticeSeen)) {
        const answer = shipNoticeAnswer(await confirmChoice(SHIP_NOTICE_QUESTION));
        if (answer.seen) {
          void useWorkspaces
            .getState()
            .markShipNoticeSeen(workspaceId)
            .catch((e) => console.warn("ship: the notice wasn't remembered", e));
        }
        if (!answer.mode) return;
        mode = answer.mode;
      }
      const press = shipPressOf(mode, toGitHub);
      // 1.171.0 B3 (CP-6): only a `pr` ship reads the remembered choice,
      // so only it writes it first (Challenger 4) — and doesn't go without.
      const remember = options?.remember;
      let mergesByItself = ws?.mergeWhenChecksPass === true;
      if (mode === "pr" && remember !== undefined && remember !== mergesByItself) {
        try {
          await useWorkspaces.getState().setMergeWhenChecksPass(workspaceId, remember);
          mergesByItself = remember;
        } catch (e) {
          pushErrorToast(SHIP_CHOICE_NOT_SAVED, e, { then: "Nothing was shipped. Try again." });
          return;
        }
      }
      setShipBusy(true);
      // 1.175.0 F3: the card's "This project is on GitHub now" line lasts
      // until this first Ship it.
      forgetJustPut(workspaceId);
      try {
        // G4: a pull request's title and description come from the card's
        // Builder first — at most 90 s, no dialog; the template otherwise.
        // Challenger 1: only this press's request reaches the ship, both
        // calls of it (R2's second one too).
        let prDraftRequest: string | undefined;
        if (mode === "pr" || mode === "pr_only" || (mode === "ship_it" && toGitHub)) {
          // 1.175.0 F6: the draft written during the review, when there is one.
          const drafted = (await earlyDraftForShip(card)) ?? (await draftPullRequestFor(workspaceId, card.id, mode));
          if (drafted.kind === "draft") prDraftRequest = drafted.requestId;
        }
        const ship = (carryLocalCommits: boolean) =>
          options?.followUp
            ? cardShipWithFollowUp(workspaceId, card.id, mode, { carryLocalCommits, prDraftRequest })
            : cardShip(workspaceId, card.id, mode, { carryLocalCommits, prDraftRequest });
        let res = await ship(false);
        // 1.169.1 (R2): a pull request stopped before any push — it would
        // also carry earlier changes not on GitHub yet. 1.171.0 A3 (DL-11):
        // the cards they came from named, the commits under Show them; Not
        // now pushes nothing, Ship both ships it with them.
        if (res.kind === "carries_local_commits") {
          if (!res.localCommits) return;
          const remote = remoteWords(card.worktreeBase ?? { originSlug: null }).name;
          const others = (useKanban.getState().byWorkspace[workspaceId]?.cards ?? []).filter((c) => c.id !== card.id);
          const titles = landedCardTitles(res.localCommits.subjects, others);
          if ((await confirmChoice(carriesLocalCommitsQuestion(res.localCommits, remote, titles))) !== "confirm") return;
          res = await ship(true);
          if (res.kind === "carries_local_commits") return;
        }
        // GH #151: only a land (merged or conflicted) got past the
        // fast-forward check; a PR or `verify_pending` never reached it, so
        // the Ship step's block stays (review 1).
        observeShipAttempt(workspaceId, [card.id], "ship", {
          passedGate: res.kind === "merged_live" || res.kind === "local_merge",
          // Review 2: a PR is shipped, though it never ran the check.
          shipped: res.kind === "pr" || res.merged,
          // GH #183: Rust's word that the land reached origin's tip.
          fastForwarded: res.fastForwarded === true,
        });
        // A Builder card publishes its last build snapshot — never anything
        // newer — so the toast names it: Ship makes no new snapshot.
        // GH #260: the build it published is named in words; its snapshot
        // number and SHA are the toast's details.
        const shippedBuild = res.shippedSnapshot
          ? `Snapshot ${res.shippedSnapshot.n}, ${res.shippedSnapshot.sha}`
          : undefined;
        // 1.171.0 B2 (DL-06): the pull request's toast leaves out "the last
        // build" (its details name the build); the rest it says too.
        const reviewNote =
          (res.reviewOverride ? ` ${res.reviewOverride}` : "") +
          (res.unreviewed ? ` ${res.unreviewed.replace(/\n/g, " ")}` : "") +
          (res.followUp ? ` ${followUpShippedLine(res.followUp)}.` : "");
        const snapshotNote = (res.shippedSnapshot ? " It is the last build; Ship made no new one." : "") + reviewNote;
        if (res.kind === "verify_pending") {
          pushToast({
            kind: "warn",
            title: "Not shipped yet — checking first",
            body: "Edits nobody had committed were committed, and the checks are running on that commit. Nothing was published; ship again once they pass.",
            details: res.recoverySha ?? undefined,
          });
          await loadFromDisk(workspaceId, true);
          return;
        }
        // Skills hub H3a (§4.2): a skill card's preflight stopped the ship —
        // somebody shipped this change already, or the library moved again.
        if (res.kind === "skill_up_to_date") {
          upToDateToast.current = pushToast({
            kind: "info",
            title: "Already up to date",
            body: res.skillNote ?? "The target already has this change.",
            action: { label: "Delete card", onClick: () => requestDeleteRef.current?.() },
          });
          return;
        }
        if (res.kind === "skill_refresh") {
          // Mac walk 2: said once (the title is only "Not shipped"), and the
          // card itself now offers Refresh card in its Now callout.
          markSkillCardBehind(workspaceId, card.id);
          // Windows walk (H6b step 9): a newer version shown first is never
          // refreshed in — the toast offers what the card's Now offers.
          const showFirst = skillBehindNow(workspaceId, card.id);
          pushToast({
            kind: "warn",
            title: "Not shipped",
            body:
              typeof showFirst === "string"
                ? skillBehindShowFirstHelper(showFirst, card.kind?.verb === "install" ? "Install" : "Update")
                : (res.skillNote ?? "The team library has a newer version of this skill than the card carries. Refresh the card, then ship it."),
            action:
              typeof showFirst === "string"
                ? { label: "Delete card", onClick: () => requestDeleteRef.current?.() }
                : { label: "Refresh card", onClick: () => void refreshSkillCard(workspaceId, card.id) },
          });
          return;
        }
        const skillLine = skillShipLine(res);
        // 1.169.1 (R13): a land never pushes — where the change went, by the
        // target's name, and on a project on GitHub that it isn't there yet.
        // Challenger: both from the backend, by the receipt's own reading.
        const onGitHub = res.onGitHub === true;
        const landedLine = localShipLine(res.target, onGitHub);
        if (!res.merged && res.kind !== "pr") {
          // UX P1 point 7 (P-E): one toast, from both press sites, once the
          // card's record of the conflict has been read.
          await loadFromDisk(workspaceId, true);
          announceShipConflict(workspaceId, card.id, res.conflictingPaths);
        } else if (res.kind === "pr") {
          // 1.172.0 B3 (B2 Challenger leftover): who merges it is what Ship
          // recorded on the card — GitHub's auto-merge, Plyloft's own merge
          // (only while it's open) or, GitHub having refused, the person.
          try {
            await loadFromDisk(workspaceId, true);
          } catch {
            // The toast still says what the press asked for.
          }
          const shipped = useKanban.getState().byWorkspace[workspaceId]?.cards.find((c) => c.id === card.id);
          const merger = prOpenedMerger(
            mode === "ship_it" || (mode === "pr" && mergesByItself),
            shipped?.prUrl === res.prUrl ? shipped?.pr : null,
          );
          pushToast({
            kind: "info",
            // 1.171.0 B2 (DL-06): where it is and who merges it; the link
            // is under Open on GitHub, never the line itself.
            title: prOpenedToastLine(res.prUrl, merger),
            ...(reviewNote || skillLine ? { body: (reviewNote + (skillLine ? ` ${skillLine}` : "")).trim() } : {}),
            details: shippedBuild,
            // 1.170.0 walk fix: it times out like the other notices — its
            // action is a shortcut (the card opens the pull request too),
            // not the way forward an action toast stays for.
            ttlMs: PR_OPENED_TOAST_MS,
            // QoL 14.2 (C21): the pull request opens from its toast.
            ...(res.prUrl
              ? {
                  action: {
                    label: "Open on GitHub",
                    onClick: () => void openWebLink(res.prUrl!).catch((e: unknown) => pushToast(linkDidNotOpen(res.prUrl!, e))),
                  },
                }
              : {}),
          });
        } else if (res.kind === "merged_live") {
          // Try it TI-5: the go-live step rebuilds the app detached, so the
          // toast offers no Try it; the receipt does, saying to wait for it.
          useTryRuns.getState().noteGoLive(workspaceId, card.id);
          pushToast({
            kind: "info",
            title: "Shipped",
            // 1.171.0 A3 (DL-30): "relaunch" only where it does.
            body: goLiveWords(res, onGitHub, landedLine) + snapshotNote,
            details: shippedBuild,
          });
        } else {
          const tryIn = shipOffersTryInProject(res) ? await tryInProjectAction(workspaceId) : undefined;
          // 1.175.0 B2: merged here, and the install step that would have
          // followed waits for this Mac's OK (Review opens the sheet).
          const heldInstall =
            res.kind === "local_merge" && !res.skillOnly ? await installHeldAfter(workspaceId, { tag: null, installScript: "held" }) : null;
          pushToast({
            kind: "info",
            title: "Shipped",
            ...(heldInstall ? { action: heldInstall.action } : tryIn ? { action: tryIn } : {}),
            body:
              (heldInstall
                ? `${landedLine} ${installHeldSentence(heldInstall.held.who, heldInstall.held.firstTime)}`
                : skillLine
                ? `${landedLine} ${skillLine}`
                : onGitHub
                  ? landedLine
                  : `${landedLine} ${NOTHING_RUNS_AFTER_SHIPPING}`) +
              snapshotNote,
            details: shippedBuild,
          });
        }
        await loadFromDisk(workspaceId, true);
        // G11 (1.170.0): nothing asks about the Builder session after a
        // ship. A pull request just opened isn't done: its session follows
        // it (a failed check, a review or an edit goes to it) and closes at
        // Done (`store/builderAtDone`). A ship on this Mac is done: the
        // session closes at once, with Undo. UX P-A Mac walk 1: a land
        // stopped on a conflict shipped nothing, so it closes nothing.
        const shippedKind = shippedSessionKind(res);
        if (card.builder?.ptyId && shippedKind === "pr") {
          followBuilderSession(card.id, card.builder.ptyId);
        } else if (card.builder?.ptyId && shippedKind === "merged") {
          closeBuilderWithUndo(workspaceId, card.id, "shipped");
        }
      } catch (e) {
        // GH #151: GH #88's refusal is announced, and its block drawn on this
        // card's Ship step; it never reaches a toast as a sentence.
        if (observeShipAttempt(workspaceId, [card.id], "ship", { refused: e })) {
          // UX P-A Windows walk 1: the press failed, and every surface says
          // so. The local branch's refusal and an unpublished release are
          // read from their blocks (`lib/shipRefusal.ts`); a record that
          // can't be read is workspace-wide, so the card page records it.
          const unreadable = asRecordUnreadable(e);
          // 1.171.0 B3 (CP-27): the press by id; the card names it.
          if (unreadable !== null) onFailureRef.current?.(press, unreadable, card.id, options?.followUp === true);
          return;
        }
        const dirty = decodeTargetDirtyError(e);
        // UX P-A Windows walk 1: a target with uncommitted changes refused
        // the Ship before anything ran — a failed press too, said on the card
        // (`cardActionError` words it), not only in a toast.
        if (onFailureRef.current) {
          const action = shipPressLabel(press);
          // Try again repeats a ship with follow-up with it (C4).
          const drawn = onFailureRef.current(press, e, card.id, options?.followUp === true);
          // GH #306: said once, on the card. Only a card page that is not on
          // screen gets a pointer to it; a press whose card the page no
          // longer shows (review 4) is said by the toast alone.
          if (!drawn && dirty) {
            pushToast({
              kind: "warn",
              title: TARGET_DIRTY_TITLE,
              body: targetDirtyToastBody(dirty),
              action: { label: SHOW_THEM, onClick: () => openFolderChanges(workspaceId, "ship") },
            });
          } else if (!drawn || !cardPageShowing(workspaceId, card.id)) {
            pushToast({
              kind: "warn",
              title: `${action} didn't go through for “${card.title}”.`,
              details: drawn ? undefined : rawError(e),
              action: { label: "Show", onClick: () => openCardStep(workspaceId, card.id, "ship") },
            });
          }
          return;
        }
        pushToast(
          dirty
            ? {
                kind: "warn",
                title: TARGET_DIRTY_TITLE,
                body: targetDirtyToastBody(dirty),
                action: { label: SHOW_THEM, onClick: () => openFolderChanges(workspaceId, "ship") },
              }
            : // 1.176.2 (E1, A3-11): the cause the card page would give, not a placeholder.
              errorToastFor("The card wasn't shipped", e, {
                // The generic "couldn't finish “Ship it”" only repeats the title; Details keeps the cause.
                body: shipHappened(e),
                then: "It's still ready to ship. Try Ship it again.",
              }),
        );
      } finally {
        setShipBusy(false);
      }
    },
    [workspaceId, card.id, card.title, card.builder?.ptyId, card.worktreeBase, loadFromDisk, setShipBusy, hasRemote],
  );
  // 1.176.2 F2 (A5F-03): one Ship of this card at a time, from every press
  // that reaches it (its Now, its Ship step, Other ways, a key held down):
  // a second press while one runs does nothing — no second draft request to
  // the Builder, no second `card_ship`.
  const runShip = useCallback(
    (pressed: ShipMode, options?: { followUp?: boolean; remember?: boolean }) =>
      pressOnce(
        shipPressKey(workspaceId, card.id),
        () => runShipUnguarded(pressed, options),
        sayStillRunning(shippingStillRunning(card.title)),
      ).then(() => undefined),
    [workspaceId, card.id, card.title, runShipUnguarded],
  );

  const outcomeLoading =
    card.lastRunStatus === "success" &&
    Boolean(card.worktreePath) &&
    !swarmRunning &&
    card.shipStatus !== "shipped" &&
    card.reviewStatus !== "merged" &&
    outcome == null;
  // SP-1 phase 2: the result has a diff exactly where it drew one before —
  // an open pull request after the work left, a finished result, an
  // audit's quick wins.
  const diffAvailable =
    Boolean(card.worktreePath) &&
    card.shipStatus !== "shipped" &&
    (card.reviewStatus === "merged"
      ? prOpen(card)
      : !swarmRunning && outcome != null && (!outcome.isRecon || outcome.filesChanged > 0));
  const diffPrNumber =
    card.reviewStatus === "merged" && prOpen(card) ? (card.pr?.number ?? null) : null;
  // While the result is being (re)fetched — after every build and review —
  // the last answer stands: the diff keeps its section, its line-comment
  // drafts and an open pair. Only a loaded result without one says none.
  const diffPending =
    Boolean(card.worktreePath) &&
    card.shipStatus !== "shipped" &&
    card.reviewStatus !== "merged" &&
    !swarmRunning &&
    outcome == null;
  useEffect(() => {
    if (diffPending) return;
    onDiffChange?.(diffAvailable ? { openPrNumber: diffPrNumber } : null);
  }, [onDiffChange, diffPending, diffAvailable, diffPrNumber]);
  useEffect(() => () => onDiffChange?.(null), [onDiffChange]);
  /** The diff: inline behind "See the diff", or, on the card page, the
   *  press that shows its section. */
  const seeDiffButton = onSeeDiff ? (
    <CBtn
      tone="quiet"
      aria-expanded={diffOpen}
      data-ply-outcome-see-diff=""
      onClick={() => (diffOpen ? onHideDiff?.() : onSeeDiff())}
    >
      {diffOpen ? "Hide the changes" : "See the changes"}
    </CBtn>
  ) : null;
  const seeDiff = seeDiffButton ? <div className="ux-card-section-actions">{seeDiffButton}</div> : null;

  useEffect(() => {
    onPresentationChange?.({
      loading: outcomeLoading,
      filesChanged: outcome?.filesChanged ?? null,
      shipBusy,
      noRemote: outcome?.hasRemote === false,
      prOffered: outcome?.hasRemote === true,
      noPullRequestWords: outcome?.hasRemote === false ? noPullRequestWords(outcome) : null,
      onlyHere: outcome?.hasRemote === false && !outcome.originHost && !outcome.originUnreadable,
    });
  }, [
    onPresentationChange,
    outcomeLoading,
    outcome?.filesChanged,
    outcome?.hasRemote,
    outcome?.originHost,
    outcome?.originUnreadable,
    shipBusy,
  ]);
  useEffect(() => {
    onShipReady?.(runShip);
    return () => onShipReady?.(null);
  }, [onShipReady, runShip]);
  useEffect(() => {
    onRedoReady?.(() => setRedoOpen(true));
    return () => onRedoReady?.(null);
  }, [onRedoReady, setRedoOpen]);

  const actionBusy = busy || shipBusy;
  // 1.171.0 B3: where Ship it goes, for the pull request choices here.
  const shipVia = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId)?.shipVia);

  // v1.39.0: fork the audit into a fresh implementation card. Backend
  // creates the card in Todo with the audit's summary_md preloaded as
  // knowledge; if runIntake is true, intake also starts immediately
  // (failure is non-fatal — the card persists; toast surfaces the
  // error via the store action).
  /** SP-1 review 4: a press on this card failed after the page moved on to
   *  another card: the toast names this one, with its reason and Show. */
  const missedFailure = useCallback(
    (action: string, e: unknown) =>
      pushToast({
        kind: "warn",
        title: `${action} didn't go through for “${card.title}”.`,
        details: rawError(e),
        action: { label: "Show", onClick: () => openCardStep(workspaceId, card.id, "outcome") },
      }),
    [workspaceId, card.id, card.title],
  );
  const onFork = useCallback(
    async (runIntake: boolean) => {
      if (!workspaceCwd) {
        pushToast({
          kind: "error",
          title: "Can't fork",
          body: "Workspace cwd not loaded yet — try again in a moment.",
        });
        return;
      }
      setForking(true);
      try {
        await forkToImplementation(workspaceId, card.id, {
          runIntake,
          workspaceCwd,
        });
        await loadFromDisk(workspaceId, true);
      } catch (e) {
        if (onFailureRef.current?.("Fork to implementation", e, card.id)) return;
        if (onFailureRef.current) {
          missedFailure("Fork to implementation", e);
          return;
        }
        pushErrorToast("Fork failed", e);
      } finally {
        setForking(false);
      }
    },
    [workspaceId, card.id, workspaceCwd, forkToImplementation, loadFromDisk, setForking, missedFailure],
  );

  const onRedo = useCallback(async () => {
    const feedback = redoText.trim();
    if (!feedback) return;
    // G4 (launch D8): a follow-up swarm only for a card that ran one; a
    // Builder card's "Not right" goes into its Builder session.
    const route = changesRoute(card);
    if (route === "none") {
      pushToast({ kind: "warn", title: "Nothing was sent", body: NOWHERE_FOR_CHANGES });
      return;
    }
    const rejection = { path: "", hunkHeader: "", feedback, hunkBody: "" };
    setBusy(true);
    try {
      if (route === "builder") {
        // The store says how it went, in a toast; the note stays on a failure.
        const sent = await useBuilder
          .getState()
          .sendChanges(workspaceId, card.id, [rejection], () => setRedoQueued(true));
        if (sent === "sent") {
          setRedoOpen(false);
          setRedoText("");
        }
        return;
      }
      await cardReviewRequestChanges(workspaceId, card.id, [rejection]);
      pushToast({
        kind: "info",
        title: "Sent back",
        body: "A follow-up agent run is addressing your feedback.",
      });
      setRedoOpen(false);
      setRedoText("");
      await loadFromDisk(workspaceId, true);
    } catch (e) {
      // Launch G1 (round 2, P3-2): a follow-up on a shipped card asked the
      // Free slot and was refused: the slot's sheet says why.
      if (showPlanRefusal(e)) return;
      if (onFailureRef.current?.("Send it back", e, card.id)) return;
      if (onFailureRef.current) {
        missedFailure("Send it back", e);
        return;
      }
      pushErrorToast("Couldn't send feedback", e);
    } finally {
      setBusy(false);
      setRedoQueued(false);
    }
  }, [workspaceId, card, redoText, loadFromDisk, setBusy, setRedoOpen, setRedoText, setRedoQueued, missedFailure]);

  // A swarm-done card whose worktree carries no changes — likely ran before
  // the worktree-isolation fix, or genuinely changed nothing. Don't offer to
  // ship an empty worktree.
  const nothingToShip = outcome != null && outcome.filesChanged === 0;
  // Tier 4 walk 2026-10-14: the pull request, as the diff panel's Merge says it.
  const prShip = prShipOffer(card.builder, reviewTip?.branchTip);
  const toGitHubHere = shipItGoesToGitHub(shipVia, outcome?.hasRemote ?? null);

  // v1.38.0 (Recon-aware Outcome): pre-render the agent-authored markdown
  // report as sanitized HTML. Lazy-imports `lib/markdown` (marked +
  // DOMPurify) in an effect — keeps those deps out of the initial module
  // graph (see EditorPanel.tsx for the same pattern; eager imports caused
  // WKWebView init failures historically). PPVP Tier 1 asserts that
  // markdown-*.js stays a lazy chunk.
  const [reconHtml, setReconHtml] = useState<string | null>(null);
  /** GH #261: a report that couldn't be rendered is an ErrorBlock, its raw
   *  error behind Details — never `render error: …` as the report. */
  const [reconError, setReconError] = useState<UxError | null>(null);
  useEffect(() => {
    let cancelled = false;
    setReconError(null);
    if (!outcome?.isRecon || !outcome.reconSummaryMd) {
      setReconHtml(null);
      return;
    }
    const source = outcome.reconSummaryMd;
    import("../lib/markdown")
      .then(({ renderAgentMarkdown }) => {
        if (!cancelled) setReconHtml(renderAgentMarkdown(source));
      })
      .catch((e) => {
        if (cancelled) return;
        setReconHtml(null);
        setReconError(loadFailedError("The audit's report", e));
      });
    return () => {
      cancelled = true;
    };
  }, [outcome?.isRecon, outcome?.reconSummaryMd]);

  // QoL 1.168 (C8): a shipped card's result is what shipped — its files,
  // its checks, the Challenger's word — not an empty section.
  if (card.shipStatus === "shipped") return <ShippedResult card={card} />;
  if (!card.worktreePath) return null;

  // GH #260: the section's heading is the page's (1.172.0: "Review"), and the
  // card's title is the page's. Lines are state words; the diff, the
  // reviewer's prose and machine text are behind Details.
  if (card.reviewStatus === "merged") {
    // "Merged" here means the work left for its pull request, not that the
    // pull request merged: only GitHub's read says that (SL-0 app tester,
    // Ship pilot: an open PR read "and it was merged").
    const prLine = card.prUrl ? prShipLine(card) : null;
    return (
      <div className="ux-card-outcome">
        <StatusLine state={prLine?.state ?? "done"}>
          <GlossaryText
            text={
              prLine?.text ??
              (card.prUrl
                ? "Its pull request was opened on GitHub."
                : `Shipped — it is in ${targetHere(card.worktreeBase?.refName)}.`)
            }
            words={["pull request"]}
          />
        </StatusLine>
        {/* 1.174.0 C5 round 1: its pull request open or merged, the Review
            still says why the review was skipped. */}
        {card.builder?.review && card.builder.review.status === "skipped" && !pushbackAccepted(card.builder.review) && <SkippedReviewLine />}
        {card.prUrl && (
          // 1.169.1 (R13): the pull request opens from the result, as from
          // its toast; the link itself stays behind Details. Challenger:
          // once read back (`card.pr`), Shipping's pull request block has
          // the page's one Open on GitHub.
          <>
            {!card.pr && <div className="ux-card-section-actions" data-ply-pr-open-github="">
              <CBtn
                tone="quiet"
                onClick={() =>
                  void openWebLink(card.prUrl!).catch((e: unknown) =>
                    pushToast(linkDidNotOpen(card.prUrl!, e)),
                  )
                }
              >
                Open on GitHub
              </CBtn>
            </div>}
            <Details summary="The pull request">
              <code className="ux-card-mono">{card.prUrl}</code>
            </Details>
          </>
        )}
        {/* v1.154.1 round 3 (RW-A): while its pull request is open, the
            card's changes — and line comments on them, sent to its Builder —
            are still reachable (See the checks, Activity › See the changes). */}
        {prOpen(card) && (seeDiff ?? (
          <div data-ply-outcome-diff="">
            <Details summary="See the changes">
              <div className="ux-card-outcome-body">
                <CardReviewPanel
                  workspaceId={workspaceId}
                  card={card}
                  shipBusy={shipBusy}
                  openPrNumber={card.pr?.number ?? null}
                />
              </div>
            </Details>
          </div>
        ))}
      </div>
    );
  }

  if (swarmRunning) {
    return (
      <div className="ux-card-outcome">
        <p className="ux-card-muted">
          The agents are still working; the result fills in when they finish.
        </p>
      </div>
    );
  }

  // v1.38.0: neutral loading skeleton — we don't yet know whether this card
  // ran a recon or code swarm, so don't flash either variant's chrome
  // (ship buttons / markdown report) before `card_outcome` resolves.
  if (!outcome) {
    return (
      <div className="ux-card-outcome">
        <p className="ux-card-muted">Checking the result…</p>
      </div>
    );
  }

  // SP-2: with Now's "Not right" the form opens from there; no second trigger.
  // 1.172.0 (C2): the trigger sits in the Review's row; the form opens
  // under it.
  const redoTrigger =
    redoOpen || nowOffersRedo || heldForBuilder ? null : (
      <CBtn tone="quiet" data-ply-review-not-right="" disabled={actionBusy} onClick={() => setRedoOpen(true)}>
        {notRightWords(changesRoute(card)).button}
      </CBtn>
    );
  const redoForm = !redoOpen ? null : (
    <div className="ux-card-field">
      <textarea
        className="ux-card-textarea"
        aria-label="What's wrong"
        rows={4}
        placeholder={notRightWords(changesRoute(card)).placeholder}
        value={redoText}
        onChange={(e) => setRedoText(e.target.value)}
        autoFocus
      />
      {redoQueued && (
        <StatusLine state="running">
          Queued for the Builder: it goes in when the Builder is back at its prompt.
        </StatusLine>
      )}
      <div className="ux-card-section-actions">
        <CBtn
          tone="quiet"
          disabled={actionBusy}
          onClick={() => {
            setRedoOpen(false);
            setRedoText("");
          }}
        >
          Cancel
        </CBtn>
        <CBtn disabled={actionBusy || redoText.trim().length === 0} onClick={() => void onRedo()}>
          Send it back
        </CBtn>
      </div>
    </div>
  );
  const redo = redoForm ?? (redoTrigger ? <div className="ux-card-section-actions">{redoTrigger}</div> : null);

  // v1.38.0 recon variant: ux-audit / design and any future recon-shape
  // template. Primary content is the markdown summary; ship/verify/review
  // surfaces are hidden by default and only re-surface when there's an
  // actual diff to ship (mixed-deliverable / quick-wins path) or under
  // "Everything else".
  if (outcome.isRecon) {
    const hasQuickWins = outcome.filesChanged > 0;
    return (
      <div className="ux-card-outcome">
        <StatusLine state="done">The audit is complete; its recommendation is below.</StatusLine>

        {reconError !== null ? (
          <ErrorBlock
            density="dense"
            error={reconError}
          />
        ) : reconHtml ? (
          <div
            className="ux-card-report"
            // Sanitized via DOMPurify in renderAgentMarkdown.
            dangerouslySetInnerHTML={{ __html: reconHtml }}
          />
        ) : (
          <StatusLine state="aborted">
            This audit has no readable recommendation. Run it again to write one.
          </StatusLine>
        )}

        {/* v1.39.0: synthesis-fallback nudge. Only fires when the
            summary was built by the structured-field synthesizer
            (pre-v1.38 prompt). Disclosure — non-modal, easy to ignore. */}
        {isSynthesizedSummary(outcome.reconSummaryMd) && (
          <Details summary="This audit ran on an older prompt">
            {/* GH #171 review 1: the reseed button is retired, but
                `swarms::ensure_role_preset` recreates a missing preset from
                the current seed on the next run — so deleting the stale file
                is the way back. */}
            <div className="ux-card-outcome-body">
              <p className="ux-card-plain">
                The summary above was put together from the audit's structured fields, because
                this workspace's role presets predate the prompt that writes one. To get the
                current prompt, quit Plyloft and delete the audit role's preset — the file whose
                presetId is ux-reviewer (architect for a design audit) in the folder below. The
                next run recreates it.
              </p>
              <code className="ux-card-mono">
                ~/Library/Application Support/com.mbadv.ply/agents/workspaces/{workspaceId}/
              </code>
            </div>
          </Details>
        )}

        {/* v1.39.0: fork affordance. Hidden entirely on archived cards
            (mirrors the backend reject path). Disabled while a request is in
            flight to block double-fire. They stay enabled when the verdict
            is negative — the user can override. */}
        {!card.archived && outcome.reconSummaryMd && (
          <>
            {outcome.reconVerdictNegative && (
              <StatusLine state="aborted">
                The audit recommended against going ahead; read it before making a card from it.
              </StatusLine>
            )}
            <div className="ux-card-section-actions">
              <CBtn
                tone="quiet"
                disabled={forking || shipBusy || !workspaceCwd}
                title={`Create an implementation card and start planning it with ${newCardPlanner === "codex" ? "Codex" : "Claude"}`}
                onClick={() => void onFork(true)}
              >
                Make a card and plan it
              </CBtn>
              <CBtn
                tone="quiet"
                disabled={forking || shipBusy || !workspaceCwd}
                title="Create an implementation card with the audit's plan, ready to start"
                onClick={() => void onFork(false)}
              >
                Make a card ready to start
              </CBtn>
            </div>
          </>
        )}

        {hasQuickWins && (
          <section className="ux-card-outcome" aria-label="Quick wins">
            <h3 className="ux-card-subheading">Quick wins ready to ship</h3>
            <p className="ux-card-muted">
              The audit also changed {outcome.filesChanged} file
              {outcome.filesChanged === 1 ? "" : "s"}; ship them on their own while you decide on
              the bigger direction.
            </p>
            <ReviewerLine
              outcome={outcome}
              review={card.builder?.review ?? null}
              card={card}
              onShip={runShip}
              shipBusy={actionBusy}
              reviewTip={reviewTip}
            />
            <VerifyLine verifyStatus={card.verifyStatus} configured={outcome.verifyConfigured} />
            {/* 1.175.0 F6 (I8): where the pull request's text is, with Read it. */}
            <PrDraftRow card={card} />
            {!card.builder && (
              <IndependentReview
                workspaceId={workspaceId}
                cardId={card.id}
                onFreshnessChange={onReviewFreshnessChange}
                onRerunStaleReady={onRerunStaleReady}
              />
            )}
            <VerifyPanel card={card} offerFix={!nowOffersChecksFix} />
            {tryIt && <div className="ux-card-section-actions">{tryIt}</div>}
            {/* SP-2 round 2: the same one overlap callout as the main view. */}
            <OverlapWarnings workspaceId={workspaceId} cardId={card.id} warnings={overlaps} />
            {redo}
          </section>
        )}

        {hasQuickWins && (
        <div data-ply-outcome-diff="">
          <Details summary="Everything else">
              <div className="ux-card-outcome-body">
                {outcome?.hasRemote === false ? (
                  <p className="ux-card-muted" data-ply-no-remote="">
                    {noPullRequestWords(outcome)}
                  </p>
                ) : nowOffersShipMenu || heldForBuilder || releasing ? null : (
                  <PullRequestChoices
                    onShip={runShip}
                    toGitHub={toGitHubHere}
                    disabled={actionBusy}
                  />
                )}
                {seeDiff ?? <CardReviewPanel workspaceId={workspaceId} card={card} shipBusy={shipBusy} />}
              </div>
          </Details>
        </div>
        )}
      </div>
    );
  }

  return (
    <div className="ux-card-outcome">
      {nothingToShip ? (
        <StatusLine state="aborted">
          {outcome.alreadyIn
            ? `This card's work is already in ${outcome.alreadyIn} — nothing to ship.`
            : "This card's copy has no changes yet — nothing to ship."}
        </StatusLine>
      ) : (
        <StatusLine state="done">
          {outcome.filesChanged} file{outcome.filesChanged === 1 ? "" : "s"} changed.
        </StatusLine>
      )}
      {/* Skills hub H3a (§4.2): what a skill card is, and why it has no Verify. */}
      {isSkillCard(card) && <StatusLine state="done">{skillCardLine(card)}</StatusLine>}
      {deleteDialog}

      {outcome.shipBlockedReason && (
        // QoL 1.168 block 8: the backend's reason is a whole sentence — a full
        // stop only when it has none ("…then ship.." was drawn).
        <StatusLine state="aborted">{endSentence(outcome.shipBlockedReason)}</StatusLine>
      )}
      {outcome.recoverySha && (
        <>
          <StatusLine state="aborted">
            Ship found edits nobody had committed and committed them. The checks run on that
            commit; Ship publishes it only once they pass.
          </StatusLine>
          <Details summary="The commit">
            <code className="ux-card-mono">{outcome.recoverySha}</code>
          </Details>
        </>
      )}
      {/* 1.172.0 (C2; CP B2): the Review, in its order — the checks, the
          Challenger's verdict, the overlap with other cards; then See the
          changes · Try it · Not right; then the same Ship it ▾ as Now. */}
      <div data-ply-review-part="checks" role="group" tabIndex={-1} aria-label="Checks">
        <VerifyLine verifyStatus={card.verifyStatus} configured={outcome?.verifyConfigured ?? false} />
        <VerifyPanel card={card} offerFix={!nowOffersChecksFix} />
      </div>
      <div data-ply-review-part="challenger">
        <ReviewerLine
          outcome={outcome}
          review={card.builder?.review ?? null}
          card={card}
          onShip={runShip}
          shipBusy={actionBusy}
          reviewTip={reviewTip}
        />
        {/* 1.175.0 F6 (I8), walk 6.2: the pull request's text, with Read it. */}
        <PrDraftRow card={card} />
        {/* v1.112.0: a Builder card's review is the Challenger's; the manual
            provider panel duplicated it. Swarm cards keep it. */}
        {!card.builder && (
          <IndependentReview
            workspaceId={workspaceId}
            cardId={card.id}
            onFreshnessChange={onReviewFreshnessChange}
            onRerunStaleReady={onRerunStaleReady}
          />
        )}
      </div>

      {/* v1.86.0: pre-merge overlap warning — the moment before "Ship it"
          is where a collision with another card/PR must surface. SP-2: the
          one overlap callout here (ConflictBanner said it a second time).
          1.172.0 (C2): its chip is under Now too. */}
      <OverlapWarnings workspaceId={workspaceId} cardId={card.id} warnings={overlaps} />

      {(() => {
        // The diff's press is the page's (See the changes); a standalone
        // result keeps the diff inline, at its end.
        const see = nowOffersSeeChanges ? null : seeDiffButton;
        return see || tryIt || redoTrigger ? (
          <div className="ux-card-section-actions" data-ply-review-actions="">
            {see}
            {tryIt}
            {redoTrigger}
          </div>
        ) : null;
      })()}
      {redoForm}

      {/* 1.173.0 (D2): what changes online when its pull request merges —
          only with a pull request to open and something D1 can read. */}
      {/* 1.174.0 G3a walk: once its pull request is open, the card page
          draws it on its own, between the Shipping and the Activity. */}
      {!nothingToShip && outcome?.hasRemote !== false && !prOpen(card) && (
        <WhenItMerges
          workspaceId={workspaceId}
          cardId={card.id}
          version={`${card.builder?.snapshots.length ?? 0}:${card.verifyStatus ?? ""}:${outcome?.filesChanged ?? ""}`}
        />
      )}

      {/* v1.112.0: the PR path is a first-class ship, not "everything else".
          CL-11: not offered where no pull request can be opened. SP-2: not
          repeated when the Now callout's Ship ▾ already offers it — 1.172.0
          (C2): the Review ends on that same Ship it ▾. */}
      {outcome?.hasRemote === false ? (
        <>
          <p className="ux-card-muted" data-ply-no-remote="">
            {noPullRequestWords(outcome)}
          </p>
          {ship && !heldForBuilder && !releasing ? (
            <div className="ux-card-section-actions" data-ply-review-ship="">
              {ship}
            </div>
          ) : null}
        </>
      ) : heldForBuilder || releasing ? null : ship ? (
        <div className="ux-card-section-actions" data-ply-review-ship="">
          {ship}
        </div>
      ) : nowOffersShipMenu ? null : prShip.kind === "wait" ? (
        <p className="ux-card-muted" data-ply-ship-wait="">
          {prShip.note}
        </p>
      ) : (
        <>
          {/* Tier 4 walk 2026-10-14: as the diff panel's Merge anyway, Ship
              says when the last snapshot has no approved review. */}
          {prShip.kind === "anyway" && (
            <p className="ux-card-muted" data-ply-ship-gap="">
              {prShip.note}
            </p>
          )}
          {prShip.kind === "anyway" ? (
            <div className="ux-card-section-actions">
              <CBtn
                tone="quiet"
                disabled={actionBusy || nothingToShip}
                title="Open a pull request for the last saved round without an approved review. It doesn't merge by itself; the receipt and the pull request say so."
                onClick={() => void runShip("pr_only")}
              >
                {prShip.label}
              </CBtn>
            </div>
          ) : (
            <PullRequestChoices onShip={runShip} toGitHub={toGitHubHere} disabled={actionBusy || nothingToShip} />
          )}
        </>
      )}

      {!seeDiffButton && (
        <div data-ply-outcome-diff="">
          <Details summary="See the changes">
            <div className="ux-card-outcome-body">
              <CardReviewPanel workspaceId={workspaceId} card={card} shipBusy={shipBusy} />
            </div>
          </Details>
        </div>
      )}
    </div>
  );
}

/**
 * 1.171.0 B3 (LG-04, CP-6): The result's pull request, as Ship ▾ says it —
 * merge when checks pass, or pull request only (I merge it). It replaces
 * "Ship as a PR" and its "Merge when checks pass" checkbox: the press
 * writes the workspace's remembered choice (`ShipRunner`'s `remember`).
 */
function PullRequestChoices({
  onShip,
  toGitHub,
  disabled,
}: {
  onShip: ShipRunner;
  toGitHub: boolean;
  disabled: boolean;
}) {
  const choices: ShipChoice[] = ["auto-merge", "pr-only"];
  return (
    <div className="ux-card-section-actions" data-ply-pr-choices="">
      {choices.map((choice) => (
        <CBtn
          key={choice}
          tone="quiet"
          disabled={disabled}
          title={machineWords(shipChoiceHint(choice))}
          onClick={() =>
            void onShip(shipChoiceMode(choice, toGitHub), { remember: shipChoiceRemembers(choice) ?? undefined })
          }
        >
          {machineWords(SHIP_CHOICE_LABELS[choice])}
        </CBtn>
      ))}
    </div>
  );
}

function ReviewerLine({
  outcome,
  review,
  card,
  onShip,
  shipBusy,
  reviewTip,
}: {
  outcome: CardOutcome | null;
  review: BuilderReview | null;
  card: KanbanCard;
  onShip: ShipRunner;
  shipBusy: boolean;
  reviewTip: ReviewTipFacts | null;
}) {
  // Tier 4 walk 2026-10-14: where a request for changes went is the Now
  // callout's record (`verdictOwed`), not assumed.
  const verdictDelivery = useBuilder((s) => s.verdictDelivery[card.id]);
  const shipVia = useWorkspaces((s) => s.workspaces.find((w) => w.id === card.workspaceId)?.shipVia);
  if (!outcome) {
    return <p className="ux-card-muted">Checking the result…</p>;
  }
  // GH #99: a verdict belongs to the commit it read. When the last review
  // failed, or commits came after it, say so before any verdict.
  const truth = reviewTruth({
    builder: card.builder,
    branchTip: reviewTip?.branchTip,
    commitsSinceReview: reviewTip?.commitsSinceReview,
  });
  if (truth.kind === "retrying") {
    return (
      <>
        <StatusLine state="running">
          {truth.text}. {truth.reason} Plyloft tries the same review once more by itself.
        </StatusLine>
        {reviewMetTrustQuestion(card.builder?.review) && (
          <ClaudeReviewTrustStep refused workspaceId={card.workspaceId} density="dense" />
        )}
      </>
    );
  }
  if (truth.kind === "not-reviewed") {
    // ADR 0006: a review with a failed pass (a synthesis pass, say) still
    // shows what its completed passes found, `Make a card` included.
    return (
      <>
        <NotReviewedLine
          truth={truth}
          card={card}
          review={review}
          onShip={onShip}
          shipBusy={shipBusy || outcome.filesChanged === 0}
          prOffered={outcome.hasRemote ?? null}
        />
        {/* CL-3 (F3): the open serious issues the Inbox still counts. */}
        {review && card.reviewStatus === "changes_requested" && <SeriousCatch review={review} fromLastReview />}
        {review?.status === "done" && <ChallengerFindings card={card} review={review} />}
      </>
    );
  }
  const verdict = outcome.reviewerVerdict;
  // GH #58: an incomplete review is neither an approval nor a request for
  // changes. It says what it could not see and offers the re-run.
  if (review && reviewIncomplete(review)) {
    const reviewer = review.provider === "codex" ? "Codex" : "Claude";
    const coverage = reviewCoverage(review);
    return (
      <div className="ux-card-outcome-block">
        <StatusLine state="aborted">
          The review is incomplete: the Reviewer ({reviewer}) could not see enough of the latest
          build to approve it or ask for changes. Ship is not blocked.
        </StatusLine>
        <p className="ux-card-muted">
          {review.incompleteReason && review.incompleteReason !== "diff too large"
            ? reviewerWords(review.incompleteReason)
            : "The changes are too large."}
          {coverage ? ` ${coverage}.` : ""}
        </p>
        <div className="ux-card-section-actions">
          <ReviewAgainButton card={card} review={review} />
        </div>
        <ChallengerFindings card={card} review={review} />
        {outcome.reviewerCritique && <Critique text={outcome.reviewerCritique} />}
      </div>
    );
  }
  if (verdict == null) {
    // v1.110.5: a Challenger review in flight is not "no reviewer".
    const reviewer = review?.provider === "codex" ? "Codex" : "Claude";
    // GH #124: a Build done that waits for this review.
    const waitingLine = card.builder?.waitingReview
      ? " The newer build is reviewed next, when this review ends."
      : "";
    if (review?.status === "running" && isSweep(review)) {
      // ADR 0006: the first review reads everything and takes minutes.
      return (
        <StatusLine state="running">
          {SWEEPING_TEXT}. The Reviewer ({reviewer}) is reading all of the latest build, read-only,
          against the brief, the project rules and the risk checklist.{waitingLine}
        </StatusLine>
      );
    }
    if (review?.status === "running") {
      return (
        <StatusLine state="running">
          The Reviewer ({reviewer}) is reviewing the latest build, read-only.{waitingLine}
        </StatusLine>
      );
    }
    if (review && pushbackAccepted(review)) {
      return (
        <StatusLine state="empty">
          The Reviewer ({reviewer}) asked for changes; {overriddenByWho(review.overriddenBy, useSettings.getState().settings.identity?.userEmail ?? null)} kept it as
          it was instead on {dayWords(review.at, Date.now())}. Ship records the override.
        </StatusLine>
      );
    }
    if (review?.status === "skipped") {
      // 1.174.0 C5 round 1: Activity's "Why it was skipped" lands here.
      return <SkippedReviewLine />;
    }
    return <StatusLine state="empty">No AI reviewer ran on this task.</StatusLine>;
  }
  const approved = verdict === "approve";
  const challenger = outcome.reviewerSource === "challenger";
  const who = outcome.reviewerProvider === "codex" ? "Codex" : "Claude";
  return (
    <div className="ux-card-outcome-block">
      <StatusLine state={approved ? "done" : "aborted"}>
        {challenger
          ? approved
            ? // 1.171.0 C3 (CF25): the one approval word, its small notes counted.
              `${reviewApprovedWord(review)}: the Reviewer (${who}) reviewed the build without changing it.`
            : changesRequestedResultLine(who, verdictOwed(card.builder, verdictDelivery))
          : approved
            ? "The workflow reviewer checked this and approved it."
            : "The workflow reviewer flagged concerns."}
      </StatusLine>
      {challenger && review && !approved && <SeriousCatch review={review} />}
      <p className="ux-card-muted">
        {challenger
          ? review?.singleVendor
            ? singleVendorReviewTip(review)
            : outcome.reviewerDegraded
            ? "Same-AI review: the other AI wasn't available, so the Reviewer is the Builder's own AI this time, in a separate session that can't edit, in its own copy of the project."
            : "Independent, read-only, in its own pinned copy of the repository — the other AI from the one that built this."
          : "This step of a multi-AI run shared the card's copy and could write to it. It is not an independent read-only review; use Independent AI review below for that."}
      </p>
      {challenger && review && <ChallengerFindings card={card} review={review} />}
      {/* 1.171.0 B3 (CP-14): Ship with follow-up beside the findings it is
          about (ADR 0006: from the fourth request for changes, no P1 open). */}
      {challenger && !approved && !card.prReview && shipWithFollowUpOffer(card.builder).offered && (
        <FollowUpShip
          onShip={onShip}
          shipBusy={shipBusy}
          toGitHub={shipItGoesToGitHub(shipVia, outcome.hasRemote ?? null)}
          prOffered={outcome.hasRemote === true}
        />
      )}
      {/* The critique is the reviewer agent's own code-review prose — kept
          behind a "Why?" toggle so the layer stays a verdict, not a wall of
          developer text. */}
      {outcome.reviewerCritique && <Critique text={outcome.reviewerCritique} />}
    </div>
  );
}

/** 1.171.0 B3 (CP-14, LG-03): ship now and put the open findings in one new
 *  card. It ships as Ship it would and never merges by itself (G1
 *  Challenger 4); on a project kept on this Mac that can take a pull
 *  request, the pull request is the second way. */
function FollowUpShip({
  onShip,
  shipBusy,
  toGitHub,
  prOffered,
}: {
  onShip: ShipRunner;
  shipBusy: boolean;
  toGitHub: boolean;
  prOffered: boolean;
}) {
  return (
    <div className="ux-card-section-actions" data-ply-follow-up-ship="">
      <CBtn
        tone="quiet"
        disabled={shipBusy}
        title={
          toGitHub
            ? "Opens the pull request without these findings fixed and leaves the merge to you. They go into one new card, linked from the pull request."
            : "Ships the card without these findings fixed. They go into one new card."
        }
        onClick={() => void onShip(shipWithoutAutoMergeMode(toGitHub), { followUp: true })}
      >
        {SHIP_WITH_FOLLOW_UP_LABEL}
      </CBtn>
      {!toGitHub && prOffered && (
        <CBtn
          tone="quiet"
          disabled={shipBusy}
          title="Opens the pull request without these findings fixed and leaves the merge to you. They go into one new card, linked from the pull request."
          onClick={() => void onShip("pr_only", { followUp: true })}
        >
          {SHIP_PR_WITH_FOLLOW_UP_LABEL}
        </CBtn>
      )}
    </div>
  );
}

/** The reviewer's own words, behind Details. */
function Critique({ text }: { text: string }) {
  return (
    <Details summary="Why?">
      <MarkdownText text={text} />
    </Details>
  );
}

/** GH #99: the last commit was not reviewed — the reason in words, the raw
 *  error under Details, and two ways on: review again, or ship anyway. */
function NotReviewedLine({
  truth,
  card,
  review,
  onShip,
  shipBusy,
  prOffered,
}: {
  truth: Extract<ReviewTruth, { kind: "not-reviewed" }>;
  card: KanbanCard;
  review: BuilderReview | null;
  onShip: (mode: ShipMode) => Promise<void>;
  shipBusy: boolean;
  /** G1 Challenger (1): a pull request can be opened (`hasRemote`). */
  prOffered: boolean | null;
}) {
  const [busy, setBusy] = useState(false);
  const shipVia = useWorkspaces((s) => s.workspaces.find((w) => w.id === card.workspaceId)?.shipVia);
  const toGitHub = shipItGoesToGitHub(shipVia, prOffered);
  const snapshots = card.builder?.snapshots ?? [];
  const latest = snapshots[snapshots.length - 1]?.n;
  // A failed review of the last snapshot re-runs as it is; commits past the
  // last snapshot need Build done, which snapshots and reviews them.
  const canReviewAgain =
    truth.action === "build-done" ||
    (review != null && reviewCanRunAgain(review) && review.snapshotN === latest);
  const onReviewAgain = async () => {
    setBusy(true);
    try {
      const builder = useBuilder.getState();
      if (truth.action === "build-done") {
        builder.setSkipReviewPref(card.id, false);
        await builder.done(card.workspaceId, card.id);
      } else {
        await builder.reviewAgain(card.workspaceId, card.id);
      }
    } catch {
      // toast already shown by the store
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ux-card-outcome-block" data-ply-review-truth={truth.cause}>
      <StatusLine state="aborted">{truth.headline}</StatusLine>
      {truth.cause === "failed" && reviewMetTrustQuestion(card.builder?.review) && (
        <ClaudeReviewTrustStep refused workspaceId={card.workspaceId} density="dense" />
      )}
      <p className="ux-card-muted">
        {truth.reason}
        {truth.commitsLine ? ` ${truth.commitsLine}.` : ""}
        {truth.action === "build-done"
          ? " They came after the last Finish and check: Review again saves, checks and reviews them before shipping."
          : " Ship is not blocked."}
      </p>
      <div className="ux-card-section-actions">
        {canReviewAgain && (
          <CBtn
            tone="quiet"
            disabled={busy}
            title={
              truth.action === "build-done"
                ? "Finish and check: save the new commits, check them and have them reviewed."
                : "Run the Reviewer again on the last build. Nothing is committed and the checks are not re-run."
            }
            onClick={() => void onReviewAgain()}
          >
            {busy ? "Starting…" : "Review again"}
          </CBtn>
        )}
        {/* Ship publishes only the last build snapshot; commits past it
            are refused, so "Ship anyway" is offered only at the snapshot. */}
        {truth.action !== "build-done" && (
          <CBtn
            tone="quiet"
            disabled={shipBusy}
            title={shipAnywayTitle(toGitHub)}
            onClick={() => void onShip(shipWithoutAutoMergeMode(toGitHub))}
          >
            {/* 1.171.0 B3 (LG-03): on GitHub the label says who merges it. */}
            {toGitHub ? SHIP_ANYWAY_LABEL : "Ship anyway"}
          </CBtn>
        )}
      </div>
      {truth.details && (
        <Details>
          <p className="ux-card-critique">{truth.details}</p>
        </Details>
      )}
    </div>
  );
}

/** The checks' state is the Checks section's (VerifyPanel, below); this
 *  says only what it cannot: that the project has no checks at all. */
function VerifyLine({
  verifyStatus,
  configured,
}: {
  verifyStatus: KanbanCard["verifyStatus"];
  configured: boolean;
}) {
  if (configured || (verifyStatus != null && verifyStatus !== "none")) return null;
  return <StatusLine state="empty">No automated checks are set up for this project.</StatusLine>;
}
