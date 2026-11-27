import { useEffect, useState } from "react";
import { putOnGithubSent } from "../lib/putOnGithubIpc";
import { UnattendedAsksNote } from "./UnattendedAsksNote";
import { openWebLink, projectLocalOrigin, projectTryCommandGet, tryProjectHasCommit, type KanbanCard, type PrStatus } from "../ipc";
import { GO_LIVE_FIRST, tryInProjectLabel, tryInProjectOffer } from "../lib/tryProject";
import { pressTryInProject, useTryRuns } from "../store/tryRunStore";
import { useWorkspaces } from "../store/workspaceStore";
import {
  followUpShippedLine,
  handedOverOwed,
  handedOverShipLine,
  reviewTruth,
} from "../lib/challengerReview";
// GH #104 (BOARDS.md §4 state C): the third surface of the Challenger's one
// suggested change — a line in this step that leads to the Library page.
import { proposalPage, proposalShipLine } from "../lib/proposals";
import { reviewerWords } from "../lib/words";
import { useProposal } from "../store/proposalStore";
import {
  PROPOSAL_AFTER_TRUST,
  proposalMetTrustQuestion,
  reviewMetTrustQuestion,
} from "../lib/claudeReviewTrust";
import { ClaudeReviewTrustStep } from "./ClaudeReviewTrust";
import { openLibraryPage, useUi } from "../store/uiStore";
import { builderMayCommit } from "../lib/checksFix";
import {
  GITHUB_ACCOUNTS_PAGE,
  GITHUB_ACCOUNTS_ROW,
  GITHUB_SIGN_IN_ACTION,
  githubRefusalLine,
} from "../lib/plainError";
import { LocalBranchBlock } from "./errors/LocalBranchBlock";
import { UnpublishedReleaseBlock } from "./errors/UnpublishedReleaseBlock";
import { dayWords, rawError, shipEntryWords, shippedReceipt, timelineWhen } from "../lib/cardPage";
import {
  autoMergeRefusedWords,
  BRING_UP_TO_DATE_ACTION,
  branchKeptLine,
  checkLabel,
  githubChecksFact,
  prAutoMergeHeldLine,
  prAutoMergeLine,
  prMergeOffered,
  PR_HEAD_MOVED_LINE,
  PR_MERGE_GITHUB_HEAD_LABEL,
  prHeadMoved,
  mergeMethodLabel,
  shipEntryPullRequest,
  prCheckedWords,
  prFactsKey,
  prOpen,
  prShipLine,
  refreshOnOpen,
  upToDateRefusedLine,
} from "../lib/prStatus";
import {
  prAutoMergeOffered,
  prFixKinds,
  prFixOffered,
  prFixSent,
  prFixSentLine,
  prHeadMovedMergeOffered,
  prMergeBlocked,
  prShippingMergeOffered,
  pushedLine,
  pushUpdateLine,
} from "../lib/prFix";
import { useKanban } from "../store/kanbanStore";
import { pushToast } from "../store/toastStore";
import { useBuilder } from "../store/builderStore";
import { CBtn, CIcon, Details, StateWord, StatusLine } from "./ux";
import {
  autoFixDefaultSince,
  autoFixOn,
  autoFixRunningLine,
  autoFixStoppedNow,
  autoFixStoppedWords,
} from "../lib/prAutoFix";
import { usePrAutoFix } from "../store/prAutoFixStore";
import { fixRoundByItselfNow } from "../store/fixRoundStore";
import { machineWords } from "../lib/platform";
import { SEND_FIXES_LABEL, overriddenByWho } from "../lib/deliveryWords";
import { useSettings } from "../store/settingsStore";
import { PR_DRAFT_WRITING } from "../lib/prDraft";
import { PR_EDIT_LABEL, prEditOffered } from "../lib/prEdit";
import { PrEditSheet } from "./PrEditSheet";
import { GlossaryText } from "./GlossaryText";
import { linkDidNotOpen } from "../lib/linkToast";
import { MERGE_STILL_RUNNING, PUSH_STILL_RUNNING, pressOnce, prMergePressKey, prPushPressKey, sayStillRunning } from "../lib/pressOnce";

/**
 * The card's Shipping section (C6): landed result, bounded receipts, and a
 * stopped ship's block. The Now callout owns the card's one primary action;
 * the project release is `Release…` in the card's ⋯ (UX-6.6).
 */
/** v1.154.1 (F14): the pull request's presses, for the Now callout. Their
 *  outcome is said here, in the Shipping section the press opens. */
export interface PrActions {
  merge: () => Promise<void>;
  /** G1–G3 Challenger (2): Merge what's on GitHub now. */
  mergeGitHubHead: () => Promise<void>;
  pushUpdate: () => Promise<void>;
  /** 1.174.0 A2 (P7): Now's "Don't merge by itself" — Merge when checks
   *  pass off, as this section's Turn off. */
  autoMergeOff: () => Promise<void>;
  /** v1.154.1 round 4 (RW-C2): a push or a merge this section runs — the
   *  Now callout's pull-request presses are off meanwhile. */
  busy: "push" | "merge" | "auto" | null;
}

/**
 * GH #104: `One skill change is waiting — deploy · Review`, the board's line
 * for this card's improvement proposal, with its own way to the Library page.
 *
 * GH #104 walk: the Shipping section opens only once shipping ran, so on a
 * card that is Ready to ship the line inside it could not be seen. The card
 * page draws it under the state header while that section is closed, and the
 * section draws it while open (`CardShipStep`'s `showProposal`) — one copy on
 * screen either way.
 */
export function CardProposalLine({ card }: { card: KanbanCard }) {
  // GH #104: one slice off the store, and the store is the one reader — the
  // block, the Inbox item and this line can never disagree about whether there
  // is a proposal, because they all read this.
  const stored = useProposal((s) => s.byWorkspace[card.workspaceId]?.view) ?? null;
  useEffect(() => {
    void useProposal.getState().refresh(card.workspaceId);
  }, [card.workspaceId]);
  // **This** card's proposal. The store holds one per workspace, and the board
  // puts the line in "the card's Ship step" — the card it came out of. Without
  // this, every card in the repository would say a change was waiting because
  // one of them had met friction (found by walking the path).
  const proposal = stored?.cardId === card.id ? stored : null;
  const trustStopped = useProposal((s) => s.byWorkspace[card.workspaceId]?.trustStoppedCard);
  // A pass fails in silence, except at Claude's trust question, which only
  // the member can answer: the trust step stands where the line would —
  // only while Claude says the folder is untrusted (unreadable says
  // nothing) — and, once trusted, one line on what happens next, until the
  // card's next pass clears the record.
  if (
    proposalMetTrustQuestion(
      card.id,
      trustStopped,
      proposal !== null,
      reviewMetTrustQuestion(card.builder?.review),
    )
  ) {
    return (
      <ClaudeReviewTrustStep
        subject="proposal"
        workspaceId={card.workspaceId}
        density="dense"
        whenTrusted={<p className="ux-card-proposal">{PROPOSAL_AFTER_TRUST}</p>}
      />
    );
  }
  if (!proposal) return null;
  const waiting = proposalShipLine(proposal);
  // The board's line, with its own way there. It never carries the only copy
  // of what to do (PATTERNS.md §4): the change itself, its reason and its diff
  // are on the Library page this leads to.
  return (
    <p className="ux-card-proposal" data-ply-proposal={proposal.label}>
      {/* "Both carry an accent dot and open this page" (BOARDS.md §4 state
          C). Never the dot alone: the sentence is beside it. */}
      <span className="ux-card-accent-dot" aria-hidden />
      <span>{waiting.line}</span>
      <CBtn
        tone="quiet"
        onClick={() => openLibraryPage(card.workspaceId, proposalPage(proposal))}
      >
        {waiting.action}
      </CBtn>
    </p>
  );
}

export function CardShipStep({
  card,
  onOpenRelease,
  onPrActionsReady,
  showProposal = true,
  shipping = false,
}: {
  card: KanbanCard;
  onOpenRelease: () => void;
  onPrActionsReady?: (actions: PrActions | null) => void;
  /** QoL 1.168 (C15): a Ship is under way — "Watch it ship" says so, never
   *  "Nothing has shipped yet". */
  shipping?: boolean;
  /** GH #104 walk: false while the card page draws the proposal's line
   *  itself (this section closed), so it is never on the page twice. */
  showProposal?: boolean;
}) {
  const history = card.shipHistory ?? [];
  const review = card.builder?.review;
  const lastSnapshot = card.builder?.snapshots[card.builder.snapshots.length - 1];
  // The shipped snapshot's Challenger verdict was overridden, not addressed
  // (Build done + Skip review on an unchanged tree). Same rule as
  // builder.rs::review_override_summary.
  const reviewOverride =
    review?.status === "skipped" && review.note && review.snapshotN === lastSnapshot?.n
      ? review
      : null;
  // GH #99: the shipped tip was not reviewed — the same rule as
  // builder.rs::unreviewed_ship_summary, from what the card recorded.
  const truth = reviewTruth({ builder: card.builder });
  const shipped = card.shipStatus === "shipped";
  const merged = card.reviewStatus === "merged";
  const notReviewed = truth.kind === "not-reviewed" && !shipped && !merged ? truth : null;
  // Reviews 6–7: once landed, the receipt says what the PR body said, as
  // saved at ship time — a review that settles later does not change it.
  // G2: a line saved before 1.173.0 names the Reviewer by its old name.
  const shippedUnreviewed = shipped || merged ? reviewerWords(card.builder?.shippedUnreviewed ?? null) : null;
  // GH #129: before shipping, the request for changes nobody re-checked.
  const owed = !shipped && !merged ? handedOverOwed(card.builder) : null;

  // 1.169.1 (R13): a receipt that stayed on this computer says it isn't on
  // GitHub, on a project whose repository is there.
  const githubRepo = useGitHubRepo(
    card.workspaceId,
    history.some((e) => e.releaseKind === "local" && !shipEntryPullRequest(card, e)),
  );
  // 1.175.0 F3 (R13): a card shipped here before the project was put on
  // GitHub went there with its branch — its receipt doesn't say "not on
  // GitHub". Read only for a project on GitHub.
  const sentShas = useSentShas(
    card.workspaceId,
    githubRepo !== null ? history.filter((e) => e.releaseKind === "local").map((e) => e.commitSha) : [],
  );

  // G4: the Builder is writing the pull request before Ship opens it.
  const drafting = useBuilder((s) => s.prDraftWriting[card.id] === true);
  const now = Date.now();
  return (
    <div className="ux-card-outcome">
      {/* GH #151: Ship or Land stopped by GH #88's fast-forward refusal. A
          whole operation's refusal lives on the operation's own surface
          (PATTERNS.md §4) — here — with Sync's block and its two ways out. It
          goes when the refusal does: a Trash or Sync that clears it, or the
          next Ship of this card that gets past the fast-forward check. */}
      <LocalBranchBlock workspaceId={card.workspaceId} on="card-ship" cardId={card.id} />
      {/* GH #222: a release of this card committed here whose push was
          stopped; `Publish vX` opens the release dialog on that release. */}
      <UnpublishedReleaseBlock
        workspaceId={card.workspaceId}
        cardId={card.id}
        onPublish={onOpenRelease}
      />
      {/* Round 3 (RW-A): an open pull request has shipped — as a PR. */}
      {shipping && !shipped && !merged && (
        <StatusLine state="running">
          {drafting ? PR_DRAFT_WRITING : "Shipping now. This fills in when it's done."}
        </StatusLine>
      )}
      {!shipping && !shipped && !merged && history.length === 0 && card.pr?.state !== "open" && (
        <p className="ux-card-muted">
          {/* 1.172.0 D2 (CP-20): an archived card won't ship from here. */}
          {card.archived
            ? "This card never shipped."
            : "Nothing has shipped yet. When it's ready, Ship it is at the top of the card."}
        </p>
      )}

      {/* A card shipped as a PR before SL-1 (no `pr`): nothing reads its
          pull request back, so nothing claims it merged. */}
      {merged && card.prUrl && !card.pr && (
        <div className="ux-card-outcome-block">
          {/* 1.169.1 (R13, Challenger): its Open on GitHub is the result's
              (OutcomeScreen), one per page; the link is copied from here. */}
          <StatusLine state="done">Its pull request was opened on GitHub.</StatusLine>
          <Details summary="The pull request">
            <div className="ux-card-tech-value">
              <code className="ux-card-mono ux-card-tech-grow">{card.prUrl}</code>
              <CIcon
                icon="copy"
                tone="quiet"
                aria-label="Copy the pull request link"
                title="Copy the link"
                onClick={() => void navigator.clipboard.writeText(card.prUrl!)}
              />
            </div>
          </Details>
        </div>
      )}
      {card.prUrl && card.pr && (
        <PullRequestBlock card={card} pr={card.pr} onActionsReady={onPrActionsReady} />
      )}

      {reviewOverride && (shipped || merged) && (
        <p className="ux-card-muted">
          The Reviewer's request for changes was overridden: {overriddenByWho(reviewOverride.overriddenBy, useSettings.getState().settings.identity?.userEmail ?? null)}{" "}
          kept it as it was on {dayWords(reviewOverride.at, now)}.
        </p>
      )}

      {card.builder?.followUp?.shipped && (shipped || merged) && (
        <p className="ux-card-muted" data-ply-follow-up={card.builder.followUp.cardId}>
          {followUpShippedLine(card.builder.followUp)} ({card.builder.followUp.findingIds.join(", ")}).
        </p>
      )}

      {/* GH #129: one line each for #99's and the handed-over request. */}
      {shippedUnreviewed?.split("\n").filter(Boolean).map((line) => (
        <p key={line} className="ux-card-muted" data-ply-review-truth="shipped">
          {line}
        </p>
      ))}

      {owed && (
        <p className="ux-card-muted" data-ply-handed-over={owed.snapshotN}>
          {owed.line}. Ship says: {handedOverShipLine(owed)}
        </p>
      )}

      {notReviewed && (
        <div className="ux-card-outcome-block" data-ply-review-truth={notReviewed.cause}>
          <p className="ux-card-muted">
            {notReviewed.headline}. {notReviewed.reason}
            {notReviewed.commitsLine ? ` ${notReviewed.commitsLine}.` : ""}
          </p>
          {notReviewed.details && (
            <Details>
              <p className="ux-card-critique">{notReviewed.details}</p>
            </Details>
          )}
        </div>
      )}

      {showProposal && <CardProposalLine card={card} />}

      <TryInProjectLine card={card} />

      {history.length > 0 && (
        <section className="ux-card-outcome-block" aria-label="Ship history">
          <h3 className="ux-card-subheading">Ship history</h3>
          <ul className="ux-card-ships">
            {history.map((e) => {
              // SL-1 (m2): a merged pull request's entry is not a release.
              const merged = shipEntryPullRequest(card, e);
              return (
              <li key={`${e.commitSha}-${e.shippedAt}`} className="ux-card-ship">
                <StateWord state="done">
                  {merged ?? shipEntryWords(e) ?? "Shipped"}
                </StateWord>
                <span className="ux-card-muted-inline">
                  {merged ? "Merged on GitHub" : releaseKindWords(e.releaseKind, githubRepo !== null && !sentShas.has(e.commitSha))}
                </span>
                <span className="ux-card-ship-when">{dayWords(e.shippedAt, now)}</span>
              </li>
              );
            })}
          </ul>
          <Details summary="The commits">
            <ul className="ux-card-ships">
              {history.map((e) => (
                <li key={`${e.commitSha}-${e.shippedAt}`} className="ux-card-ship">
                  {/* D8: a merged pull request's entry carries the version Plyloft
                      read at the merge, not one it released. */}
                  {!shipEntryPullRequest(card, e) && shipEntryWords(e) && (
                    <code className="ux-card-mono">{e.tag ?? e.shippedVersion}</code>
                  )}
                  <code className="ux-card-mono">{e.commitSha}</code>
                </li>
              ))}
            </ul>
          </Details>
        </section>
      )}
    </div>
  );
}

/**
 * Try it TI-5 (TRY_IT_SPEC §3.2): on the Ship receipt, Try it in <project>
 * when the project has a start command and the change is in the project
 * folder: Ship merged it here, or its pull request was merged and the
 * folder's checkout holds the merge commit. After a go-live step (which
 * rebuilds the app detached, so Plyloft can't tell when it ends) it says to
 * wait for the rebuild.
 */
function TryInProjectLine({ card }: { card: KanbanCard }) {
  const offer = tryInProjectOffer(card);
  const offerKey = offer ? (offer.kind === "pr" ? `pr:${offer.mergeCommit}` : "local") : null;
  const name = useWorkspaces((s) => s.workspaces.find((w) => w.id === card.workspaceId)?.name ?? "");
  const rebuilding = useTryRuns((s) => Boolean(s.goLive[`${card.workspaceId}\u0000${card.id}`]));
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(false);
    if (!offerKey) return;
    let cancelled = false;
    const sha = offerKey.startsWith("pr:") ? offerKey.slice(3) : null;
    void (async () => {
      const view = await projectTryCommandGet(card.workspaceId).catch(() => null);
      if (!view?.command?.trim()) return;
      // A merged pull request's change is there once the folder holds it.
      if (sha && !(await tryProjectHasCommit(card.workspaceId, sha).catch(() => false))) return;
      if (!cancelled) setShown(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [offerKey, card.workspaceId]);
  if (!offerKey || !shown) return null;
  return (
    <div className="ux-card-outcome-block" data-ply-try-in-project="">
      <p className="ux-card-muted">
        {rebuilding ? GO_LIVE_FIRST : "The change is in your project now. See it running there."}
      </p>
      <div className="ux-card-section-actions">
        <CBtn tone="quiet" onClick={() => pressTryInProject(card.workspaceId)}>
          {tryInProjectLabel(name)}
        </CBtn>
      </div>
    </div>
  );
}

/**
 * SL-1: the card's pull request as last read from GitHub — open, merged or
 * closed; while open, its checks on GitHub (never called just "Checks", the
 * card's own), a request for changes with its text, a conflict. Read again
 * when the page opens (an open PR only) and on Refresh; the poller reads it
 * in the background either way.
 */
/** X5: the merged pull request's "copy was kept" line is true only while
 *  the card still records its copy. */
export function keptCopyShown(card: Pick<KanbanCard, "worktreePath">, pr: { state: string; cleanupKept?: string | null }): boolean {
  return pr.state === "merged" && !!pr.cleanupKept && !!card.worktreePath;
}

function PullRequestBlock({
  card,
  pr,
  onActionsReady,
}: {
  card: KanbanCard;
  pr: PrStatus;
  onActionsReady?: (actions: PrActions | null) => void;
}) {
  const refreshPr = useKanban((s) => s.refreshPr);
  const [busy, setBusy] = useState(false);
  // A failed refresh's raw text, shown only in its Details.
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  // SL-3: Merge and the auto-merge switch — one GitHub call at a time.
  const [merging, setMerging] = useState<"merge" | "auto" | null>(null);
  // v1.154.1 (F15): a refusal is about the pull request as it was read; it
  // goes once GitHub says something new (checks passed, a push, a merge).
  const facts = prFactsKey(pr);
  const [mergeNote, setMergeNote] = useState<{
    line: string;
    github: string | null;
    facts: string;
    signIn?: boolean;
  } | null>(null);
  // GitHub said merged but the card's read still says open (a read that lags
  // or failed, a merge queue): Merge waits for the next read — the read time
  // it saw is kept, and a newer one lets it go.
  const [mergedAwaiting, setMergedAwaiting] = useState<number | null | undefined>(undefined);
  const awaitingRead = mergedAwaiting !== undefined && (pr.checkedAt ?? null) === mergedAwaiting;
  // SL-2: Fix with the Builder, and Push update once the fix is verified.
  const fixing = useBuilder((s) => s.fixBusy[card.id] ?? null);
  const fixSentKey = useBuilder((s) => s.fixSent[card.id] ?? null);
  const [pushing, setPushing] = useState(false);
  // G4: Edit title and description's sheet.
  const [editing, setEditing] = useState(false);
  const [pushNote, setPushNote] = useState<{
    line: string;
    git: string | null;
    pushed: boolean;
    facts: string;
    signIn?: boolean;
  } | null>(null);
  // G7: Fix failing checks by itself — the card's switch (else the
  // workspace's default), where a try is, and where it stopped.
  // G7 fixes (Minor 5): since when the workspace's default is on.
  const autoFixDefault = useWorkspaces((s) =>
    autoFixDefaultSince(s.workspaces.find((w) => w.id === card.workspaceId)),
  );
  const autoFixPhase = usePrAutoFix((s) => s.phases[card.id] ?? null);
  const autoRefresh = refreshOnOpen(card);
  useEffect(() => {
    if (!autoRefresh) return;
    // Quiet: offline or gh missing leaves what the card last read.
    void refreshPr(card.workspaceId, card.id).catch(() => {});
    // Once per card page, not on every read it causes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.workspaceId, card.id]);

  const line = prShipLine(card);
  const open = prOpen(card);
  const now = Date.now();
  async function onRefresh() {
    setBusy(true);
    setErrorDetails(null);
    try {
      await refreshPr(card.workspaceId, card.id);
    } catch (e) {
      setErrorDetails(rawError(e));
    } finally {
      setBusy(false);
    }
  }
  // 1.176.2 F2: Merge, Merge when checks pass and Send the fixes to GitHub
  // take their slot before the first await — two presses in one frame (this
  // section and the card's Now, or the Inbox row's Merge) go once.
  function onMerge(githubHead?: string | null) {
    return pressOnce(prMergePressKey(card.workspaceId, card.id), () => mergeNow(githubHead), sayStillRunning(MERGE_STILL_RUNNING));
  }
  async function mergeNow(githubHead?: string | null) {
    if (merging !== null) return;
    setMerging("merge");
    setMergeNote(null);
    try {
      const r = await useKanban.getState().mergePr(card.workspaceId, card.id, githubHead);
      if (r.refused) {
        // 1.169.1 (R11): GitHub's answer in plain words when it is one to act on.
        const said = githubRefusalLine("Not merged", r.refused, r.github);
        setMergeNote({ ...said, github: r.github ?? null, facts: r.card.pr ? prFactsKey(r.card.pr) : facts });
      } else if (r.merged && r.card.pr?.state === "open") setMergedAwaiting(r.card.pr.checkedAt ?? null);
    } catch (e) {
      setMergeNote({
        ...githubRefusalLine("Not merged", "Couldn't reach GitHub to merge it; nothing was merged. Try again.", rawError(e)),
        github: rawError(e),
        facts,
      });
    } finally {
      setMerging(null);
    }
  }
  // G5: Bring this computer up to date, after the merge.
  const [updating, setUpdating] = useState(false);
  async function onUpToDate() {
    if (updating) return;
    setUpdating(true);
    try {
      const r = await useKanban.getState().bringUpToDate(card.workspaceId, card.id);
      if (!r.refused) pushToast({ kind: "info", title: machineWords("This Mac is up to date") });
    } catch (e) {
      pushToast({ kind: "error", title: machineWords("Couldn't bring this Mac up to date. Try again."), details: rawError(e) });
    } finally {
      setUpdating(false);
    }
  }
  function onAutoMerge(on: boolean) {
    return pressOnce(prMergePressKey(card.workspaceId, card.id), () => autoMergeNow(on), sayStillRunning(MERGE_STILL_RUNNING));
  }
  async function autoMergeNow(on: boolean) {
    // 1.170.0 G2: on every plan.
    setMerging("auto");
    setMergeNote(null);
    try {
      const r = await useKanban.getState().setPrAutoMerge(card.workspaceId, card.id, on);
      // Turning it on refused: the card's own line says why (autoMergeRefused).
      if (r.refused && !(on && r.card.pr?.autoMergeRefused)) {
        setMergeNote({ line: r.refused, github: r.github ?? null, facts: r.card.pr ? prFactsKey(r.card.pr) : facts });
      }
    } catch (e) {
      setMergeNote({
        line: on
          ? "Couldn't reach GitHub to turn on Merge when checks pass; nothing changed. Try again."
          : "Couldn't reach GitHub to turn off Merge when checks pass; nothing changed. Try again.",
        github: rawError(e),
        facts,
      });
    } finally {
      setMerging(null);
    }
  }
  function onPushUpdate() {
    return pressOnce(prPushPressKey(card.workspaceId, card.id), pushUpdateNow, sayStillRunning(PUSH_STILL_RUNNING));
  }
  async function pushUpdateNow() {
    if (pushing) return;
    setPushing(true);
    setPushNote(null);
    // 1.169.1: a file over 100 MB comes out of the card's commits — by its
    // Builder when it has one — then Send the fixes to GitHub again.
    const pushWay = { action: SEND_FIXES_LABEL, builder: builderMayCommit(card) };
    try {
      const r = await useKanban.getState().pushPrUpdate(card.workspaceId, card.id);
      const after = r.card?.pr ? prFactsKey(r.card.pr) : facts;
      setPushNote(
        r.pushed
          ? { line: pushedLine(pr.number), git: null, pushed: true, facts: after }
          : // 1.169.1 (R11): git's answer in plain words when it is one to act on.
            { ...githubRefusalLine("Not pushed", r.refused ?? "Not pushed.", r.git, pushWay), git: r.git ?? null, pushed: false, facts: after },
      );
    } catch (e) {
      setPushNote({
        ...githubRefusalLine("Not pushed", "Couldn't push the update; the pull request is as it was. Try again.", rawError(e), pushWay),
        git: rawError(e),
        pushed: false,
        facts,
      });
    } finally {
      setPushing(false);
    }
  }
  // v1.154.1 (F14): the Now callout presses these too; the latest ones.
  useEffect(() => {
    onActionsReady?.({
      merge: () => onMerge(),
      // G1–G3 Challenger (2): the head the card shows, GitHub's.
      mergeGitHubHead: () => onMerge(pr.headSha ?? null),
      pushUpdate: onPushUpdate,
      autoMergeOff: () => onAutoMerge(false),
      busy: pushing ? "push" : merging,
    });
  });
  useEffect(() => () => onActionsReady?.(null), [onActionsReady]);
  const mergeShown = mergeNote && mergeNote.facts === facts ? mergeNote : null;
  // A push that went through stays said; a refusal goes with the read it was about.
  const pushShown = pushNote && (pushNote.pushed || pushNote.facts === facts) ? pushNote : null;
  const fixOffered = prFixOffered(card, fixSentKey);
  // Walk I4: the fix is with the Builder; GitHub's pull request is as it was.
  const fixSent = open && !fixOffered && prFixKinds(pr).length > 0 && prFixSent(card, fixSentKey);
  const pushLine = pushUpdateLine(card);
  const mergeOffered = prMergeOffered(card);
  const autoLine = prAutoMergeLine(pr);
  // G1–G3 Challenger (1, 3): Plyloft's hold on Merge when checks pass.
  const heldLine = open ? prAutoMergeHeldLine(pr) : null;
  // G1–G3 Challenger (2): commits on GitHub Plyloft didn't push.
  const headMoved = open && prHeadMoved(pr);
  const headMovedMerge = prHeadMovedMergeOffered(card);
  // v1.154.1 round 3 (RW-A): Shipping follows Now's gates — no Merge while
  // a check failed, a fix is on its way or being pushed, a conflict, a
  // request for changes, or the wait for a push's checks; nothing pressable
  // while a push or a merge runs.
  const prBusy = merging !== null || pushing;
  const mergeShownHere = prShippingMergeOffered(card) || merging === "merge" || awaitingRead;
  // G3: the way the repository allows, beside Merge.
  const mergeMethod = mergeMethodLabel(pr);
  const autoOffered = prAutoMergeOffered(card);
  const autoRefused = !prMergeBlocked(card) && !pr.autoMerge ? pr.autoMergeRefused ?? null : null;
  const github = open ? githubChecksFact(pr) : null;
  const review = open ? pr.changesRequested ?? null : null;
  const autoFixSwitch = open && Boolean(card.builder) && !card.prReview;
  const autoFixIsOn = autoFixOn(card, autoFixDefault);
  const autoFixStop = open && autoFixIsOn ? autoFixStoppedNow(pr) : null;
  return (
    <div className="ux-card-outcome-block" data-ply-pull-request={pr.state}>
      {/* 1.172.0 D2: on a shipped card What shipped's own line says it
          shipped — its pull request's line isn't said again. */}
      {line && !shippedReceipt(card) && (
        <StatusLine state={line.state}>
          <GlossaryText text={line.text} words={["pull request"]} />
        </StatusLine>
      )}
      {github && (
        <p className="ux-card-muted">
          Checks on GitHub: <StateWord state={github.state}>{github.word}</StateWord>
        </p>
      )}
      {open && pr.reviewDecision === "changes_requested" && (
        <>
          <p className="ux-card-muted">
            {review?.author ? `${review.author} asked for changes on GitHub:` : "A reviewer asked for changes on GitHub."}
          </p>
          {review?.body && <p className="ux-card-critique">{review.body}</p>}
        </>
      )}
      {open && pr.mergeable === "conflicting" && (
        <p className="ux-card-muted">It conflicts with its base branch, so GitHub can't merge it.</p>
      )}
      {/* 1.175.0 F10 (I11): the switch is under the card's Change…
          (`CardAutoFixPick`); what a try does and where it stopped stay
          said here. */}
      {/* 1.172.0 (A2, owner): a Builder that asks before every change
          holds each automatic fix for the person's OK — said where the
          switch is on; under Now while a try waits. */}
      {/* A2 Challenger: stopped on the Builder's question, Now says it (once). */}
      {autoFixSwitch && autoFixIsOn && !autoFixPhase && autoFixStop?.reason !== "question" && (
        <UnattendedAsksNote card={card} kind="autoFix" />
      )}
      {autoFixSwitch && autoFixIsOn && autoFixPhase && (
        <p className="ux-card-muted" data-ply-pr-auto-fix-running={autoFixPhase.step}>
          {autoFixRunningLine(autoFixPhase, card.checksHold != null)}
        </p>
      )}
      {autoFixSwitch && autoFixStop && !autoFixPhase && (
        <>
          {/* G7 fixes (M1): a live Builder whose card wasn't shown — a wait. */}
          <StatusLine state={autoFixStop.reason === "not_shown" ? "running" : "aborted"}>
            {autoFixStoppedWords(autoFixStop.reason)}.
          </StatusLine>
          {autoFixStop.detail && (
            <Details summary="What it said">
              <p className="ux-card-critique">{autoFixStop.detail}</p>
            </Details>
          )}
        </>
      )}
      {fixOffered && (
        <div className="ux-card-section-actions" data-ply-pr-fix="">
          <CBtn
            disabled={fixing !== null || prBusy}
            onClick={() => void useBuilder.getState().fixFromGitHub(card.workspaceId, card.id)}
            title="Send what the pull request needs — failed logs, the review, the conflict — to this card's Builder. It doesn't push."
          >
            {fixing === "gathering" ? "Gathering…" : fixing === "queued" ? "Queued for the Builder" : "Fix with the Builder"}
          </CBtn>
        </div>
      )}
      {fixSent && !pushLine && (
        <p className="ux-card-muted" data-ply-pr-fix-sent="">
          {prFixSentLine(pr.number, fixRoundByItselfNow(card))}
        </p>
      )}
      {pushLine && (
        <p className="ux-card-muted" data-ply-pr-push-update="">
          {/* 1.171.0 B3 (CP-17): "this Mac" is this PC on Windows. */}
          {machineWords(pushLine)}{" "}
          <CBtn tone="quiet" disabled={prBusy} onClick={() => void onPushUpdate()}>
            {pushing ? "Sending…" : SEND_FIXES_LABEL}
          </CBtn>
        </p>
      )}
      {pushShown && (
        <>
          <StatusLine state={pushShown.pushed ? "done" : "aborted"}>{pushShown.line}</StatusLine>
          {pushShown.signIn && <GitHubSignIn />}
          {pushShown.git && (
            <Details summary="git's answer">
              <p className="ux-card-critique">{pushShown.git}</p>
            </Details>
          )}
        </>
      )}
      {headMoved && (
        <p className="ux-card-muted" data-ply-pr-head-moved="">
          {PR_HEAD_MOVED_LINE}{" "}
          {headMovedMerge && (
            <CBtn
              tone="quiet"
              disabled={prBusy || awaitingRead}
              onClick={() => void onMerge(pr.headSha ?? null)}
              title="Merge the pull request as it is on GitHub now, commits Plyloft didn't push included. Look at them on GitHub first."
            >
              {merging === "merge" ? "Merging…" : PR_MERGE_GITHUB_HEAD_LABEL}
            </CBtn>
          )}
        </p>
      )}
      {heldLine && (
        <p className="ux-card-muted" data-ply-auto-merge="held">
          {heldLine}
        </p>
      )}
      {mergeShownHere && (
        <div className="ux-card-section-actions" data-ply-pr-merge="">
          <CBtn disabled={prBusy || awaitingRead} onClick={() => void onMerge()}>
            {merging === "merge" ? "Merging…" : "Merge"}
          </CBtn>
          {mergeMethod && (
            <span className="ux-card-muted" data-ply-merge-method={pr.mergeMethod ?? ""}>
              {mergeMethod}
            </span>
          )}
        </div>
      )}
      {mergeOffered && awaitingRead && (
        <StatusLine state="done">Merged on GitHub; the card updates on its next read.</StatusLine>
      )}
      {mergeOffered && autoLine && (
        <p className="ux-card-muted" data-ply-auto-merge="on">
          {machineWords(autoLine)}{" "}
          <CBtn tone="quiet" disabled={prBusy} onClick={() => void onAutoMerge(false)}>
            {merging === "auto" ? "Turning off…" : "Turn off"}
          </CBtn>
        </p>
      )}
      {autoRefused && (
        <>
          <p className="ux-card-muted" data-ply-auto-merge="refused">
            {autoMergeRefusedWords(autoRefused)}{" "}
            <CBtn tone="quiet" disabled={prBusy} onClick={() => void onAutoMerge(true)}>
              {merging === "auto" ? "Turning on…" : "Try again"}
            </CBtn>
          </p>
          <Details summary="GitHub's answer">
            <p className="ux-card-critique">{autoRefused}</p>
          </Details>
        </>
      )}
      {autoOffered && (
        <p className="ux-card-muted" data-ply-auto-merge="off">
          Or have it merged by itself once checks pass.{" "}
          <CBtn tone="quiet" disabled={prBusy} onClick={() => void onAutoMerge(true)}>
            {merging === "auto" ? "Turning on…" : "Merge when checks pass"}
          </CBtn>
        </p>
      )}
      {mergeShown && (
        <>
          <StatusLine state="aborted">{mergeShown.line}</StatusLine>
          {mergeShown.signIn && <GitHubSignIn />}
          {mergeShown.github && (
            <Details summary="GitHub's answer">
              <p className="ux-card-critique">{mergeShown.github}</p>
            </Details>
          )}
        </>
      )}
      {/* X5 (G1 walk): said only while the card still has its copy — a copy
          removed since (Done, Cards' copies, its session closing) leaves
          the old reason on the pull request. */}
      {keptCopyShown(card, pr) && (
        <p className="ux-card-muted" data-ply-copy-kept="">The card's copy of the repository was kept: {pr.cleanupKept}.</p>
      )}
      {pr.state === "merged" && pr.branchKept && (
        <p className="ux-card-muted" data-ply-branch-kept="">{branchKeptLine(pr.branchKept)}</p>
      )}
      {pr.state === "merged" && pr.upToDateRefused && (
        <p className="ux-card-muted" data-ply-up-to-date="">
          {upToDateRefusedLine(pr.upToDateRefused, pr.upToDateNoPress)}
          {!pr.upToDateNoPress && (
            <>
              {" "}
              <CBtn tone="quiet" disabled={updating} onClick={() => void onUpToDate()}>
                {updating ? "Bringing up to date…" : machineWords(BRING_UP_TO_DATE_ACTION)}
              </CBtn>
            </>
          )}
        </p>
      )}
      {open && (
        <p className="ux-card-muted">
          {prCheckedWords(pr, (at) => timelineWhen(at, now))}{" "}
          <CBtn tone="quiet" disabled={busy || prBusy} onClick={() => void onRefresh()}>
            {busy ? "Reading…" : "Refresh"}
          </CBtn>
        </p>
      )}
      {card.prUrl && (
        // QoL 14.2 (C21): the member's own pull request opens in the browser.
        <div className="ux-card-section-actions" data-ply-pr-open-github="">
          <CBtn tone="quiet" onClick={() => openLink(card.prUrl!)}>
            Open on GitHub
          </CBtn>
          {prEditOffered(card, open) && (
            <CBtn
              tone="quiet"
              data-ply-pr-edit-open=""
              disabled={prBusy}
              onClick={() => setEditing(true)}
              title="Change the pull request's title and description on GitHub."
            >
              {PR_EDIT_LABEL}
            </CBtn>
          )}
        </div>
      )}
      {editing && (
        <PrEditSheet
          workspaceId={card.workspaceId}
          cardId={card.id}
          prNumber={pr.number}
          onClose={() => setEditing(false)}
        />
      )}
      {errorDetails && (
        <>
          <p className="ux-card-muted">Couldn't read the pull request from GitHub; Plyloft tries again on its own.</p>
          <Details>
            <p className="ux-card-critique">{errorDetails}</p>
          </Details>
        </>
      )}
      <Details summary="The pull request">
        <div className="ux-card-tech-value">
          <code className="ux-card-mono ux-card-tech-grow">{card.prUrl}</code>
          <CIcon
            icon="copy"
            tone="quiet"
            aria-label="Copy the pull request link"
            title="Copy the link"
            onClick={() => void navigator.clipboard.writeText(card.prUrl!)}
          />
        </div>
        {open &&
          pr.failingChecks
            .filter((c) => c.url)
            .map((c) => (
              <div key={checkLabel(c)} className="ux-card-tech-value">
                <span>{checkLabel(c)}</span>
                <code className="ux-card-mono ux-card-tech-grow">{c.url}</code>
                <CBtn size="sm" tone="quiet" onClick={() => openLink(c.url!)}>
                  Open
                </CBtn>
                <CIcon
                  icon="copy"
                  tone="quiet"
                  aria-label={`Copy the link to ${checkLabel(c)}`}
                  title="Copy the link"
                  onClick={() => void navigator.clipboard.writeText(c.url!)}
                />
              </div>
            ))}
      </Details>
    </div>
  );
}

/** 1.169.1 (R11): GitHub didn't accept the sign-in — Settings › Account ›
 *  Setup, at GitHub accounts. */
function GitHubSignIn() {
  return (
    <div className="ux-card-section-actions" data-ply-github-sign-in="">
      <CBtn
        onClick={() =>
          useUi.getState().openSettingsSection(GITHUB_ACCOUNTS_PAGE, { row: GITHUB_ACCOUNTS_ROW })
        }
      >
        {GITHUB_SIGN_IN_ACTION.label}
      </CBtn>
    </div>
  );
}

/** QoL 14.2 (C21): a pull request or check link, in the browser. */
function openLink(url: string) {
  void openWebLink(url).catch((e: unknown) =>
    pushToast(linkDidNotOpen(url, e)),
  );
}

/** How far each release went, in words. 1.169.1 (R13): a GitHub release
 *  is tagged and pushed — the release page is the project's own workflow's. */
const RELEASE_KIND_WORDS: Record<string, string> = {
  local: "On this Mac",
  push_only: "Tagged and pushed",
  github: "Tagged and pushed",
};

/** 1.169.1 (R13): a local ship or release never pushes — on a project on
 *  GitHub its receipt says so, in the Shipped toast's words
 *  (`localShipLine`). "this Mac" is "this PC" on Windows, read at render. */
function releaseKindWords(kind: string, onGitHub: boolean): string {
  const words = RELEASE_KIND_WORDS[kind] ?? kind;
  // 1.171.0 B1 (Challenger 6): the card's words, "only on this Mac".
  return machineWords(kind === "local" && onGitHub ? "Only on this Mac — not on GitHub" : words);
}

/** 1.175.0 F3 (R13): the shas of `shas` GitHub has (`putOnGithubSent`);
 *  empty until read and when it can't be read. */
function useSentShas(workspaceId: string, shas: string[]): ReadonlySet<string> {
  const key = shas.join(",");
  const [read, setRead] = useState<{ key: string; sent: ReadonlySet<string> } | null>(null);
  useEffect(() => {
    if (!key) return;
    let gone = false;
    Promise.resolve()
      .then(() => putOnGithubSent(workspaceId, key.split(",")))
      .then((sent) => {
        if (!gone) setRead({ key: `${workspaceId}:${key}`, sent: new Set(sent ?? []) });
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [workspaceId, key]);
  return read?.key === `${workspaceId}:${key}` ? read.sent : EMPTY_SENT;
}
const EMPTY_SENT: ReadonlySet<string> = new Set();

/** R13: the project's GitHub repository, from local refs only (never a
 *  fetch); null without one, until read, or when it can't be read. */
function useGitHubRepo(workspaceId: string, wanted: boolean): string | null {
  const [read, setRead] = useState<{ workspaceId: string; repo: string | null } | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let gone = false;
    Promise.resolve()
      .then(() => projectLocalOrigin(workspaceId))
      .then((o) => {
        if (!gone) setRead({ workspaceId, repo: o?.githubRepo ?? null });
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [workspaceId, wanted]);
  return read?.workspaceId === workspaceId ? read.repo : null;
}
