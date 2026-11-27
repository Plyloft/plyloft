import { prOpen } from "../lib/prStatus";
import { diffSummaryLine } from "../lib/diffSummary";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ErrorBlock, Segmented, Select } from "./ux";
import { loadFailedError } from "../lib/cardPage";
import {
  cardReviewDiff,
  cardReviewMerge,
  cardReviewRequestChanges,
  decodeTargetDirtyError,
  type DiffHunk,
  type FileDiff,
  type FindingAnchor,
  type ReviewDiff,
  type ReviewRejection,
} from "../ipc";
import { SHOW_THEM, TARGET_DIRTY_TITLE, targetDirtyToastBody } from "../lib/shipPreflight";
import { openFolderChanges } from "../store/projectFolderStore";
import { useKanban, type KanbanCard } from "../store/kanbanStore";
import { useSwarms } from "../store/swarmStore";
import { useBuilder } from "../store/builderStore";
import { NOWHERE_FOR_CHANGES, changesRoute } from "../lib/reviewChanges";
import { pushToast } from "../store/toastStore";
import { announceShipConflict } from "../store/shipConflictToast";
import {
  ASK_BUILDER_LABEL,
  ASK_BUILDER_TITLE,
  CONFLICT_SENT_HELPER,
  askBuilderOffered,
  conflictMergeStarted,
  shipConflictSentence,
} from "../lib/shipConflict";
import { ShipConflictDetails } from "./ShipConflictDetails";
import { showPlanRefusal } from "../store/planPrompts";
import { observeShipAttempt } from "../store/errorBlockStore";
import {
  diffRows,
  isSelectable,
  rangeLabel,
  rowLabel,
  selectionRange,
  stepSelectable,
  unsentComments,
  type DiffRow,
} from "../lib/lineComments";
import { LineCommentComposer, LineCommentList } from "./LineComments";
import {
  anchorsOfRound,
  placeAnchors,
  roundChoices,
  roundViewWords,
  type FilePlacement,
  type RoundChoice,
} from "../lib/findingAnchors";
import { useUi } from "../store/uiStore";
import { FindingAnchorRow } from "./FindingAnchors";
import { machineWords } from "../lib/platform";
import { latestSnapshotKey } from "../lib/snapshotRevision";
import { mergeReviewGap } from "../lib/challengerReview";
import { useReviewTip } from "./useReviewTip";
import { GlossaryText } from "./GlossaryText";
import { GLOSSARY } from "../lib/glossary";
import { targetHere } from "../lib/worktreeBase";
import { pushErrorToast } from "../lib/errorToast";

/**
 * v1.31.0 (Cycle 1 — Review surface): interactive post-swarm review for a
 * card swarm. Renders the card's worktree-branch git diff hunk-by-hunk;
 * the reviewer accepts good hunks, rejects bad ones with feedback (which
 * dispatches a follow-up swarm), then lands the whole worktree into the
 * local target branch.
 *
 * Scope: card swarms only — a card with no `worktreePath` renders nothing.
 * Gated to a terminal linked swarm: while the swarm runs, the diff is not
 * final.
 */
type Props = {
  workspaceId: string;
  card: KanbanCard;
  /** SL-5: the card is being shipped (Outcome's Ship): Send to Builder waits. */
  shipBusy?: boolean;
  /** v1.154.1 round 3 (Challenger): the card's changes are in this open
   *  pull request. The panel is for reading them and commenting to the
   *  Builder only: no Merge to the base branch (a local land beside the
   *  pull request), no Request changes, no per-hunk verdicts. */
  openPrNumber?: number | null;
};

type Verdict = { status: "accepted" | "rejected"; feedback: string };

/** SL-5: the lines selected in one file — from the row clicked first to
 *  the row Shift-clicked last (`DiffRow.order`). */
type LineSelection = { path: string; anchor: number; focus: number };

/** SL-5: what a file's rows need to draw and extend a selection. */
type LineCommenting = {
  selection: LineSelection | null;
  /** Select `anchor`…`focus` in `path`'s rows; `toComposer` moves the
   *  keyboard focus into the comment box (a click, Enter), else it stays on
   *  the line (Space, Shift+Arrow). */
  select: (path: string, anchor: number, focus: number, toComposer: boolean) => void;
  /** Bumped each time the comment box should take the focus; 0: it shouldn't. */
  composerFocus: number;
  cancel: () => void;
  add: (path: string, rows: DiffRow[], body: string) => Promise<boolean>;
  busy: boolean;
  draft: string;
  setDraft: (next: string) => void;
  /** Rows of each file covered by a comment not sent yet. */
  commented: (path: string, row: DiffRow) => boolean;
};

const SEP = "\u0000";

/** What a review-diff read answers: the card, its worktree, its review
 *  status and its revision — the latest build snapshot (n:sha), the
 *  revision the last review read and that review, and the branch tip when
 *  it has moved past the snapshot (PR #375 review). A diff read under
 *  another key is not shown as this card's (C4), and Merge isn't offered on
 *  it. `branchTip` equal to the snapshot adds nothing, so the tip's first
 *  read doesn't read the diff again. */
export function reviewDiffKey(card: KanbanCard, branchTip?: string | null): string {
  const builder = card.builder;
  const last = builder?.snapshots?.length ? builder.snapshots[builder.snapshots.length - 1] : null;
  return [
    card.id,
    card.worktreePath ?? "",
    card.reviewStatus ?? "",
    latestSnapshotKey(builder),
    builder?.review?.reviewedRevision ?? builder?.lastReviewedRevision ?? "",
    builder?.review?.reviewId ?? "",
    branchTip && branchTip !== last?.sha ? branchTip : "",
    // Mac walk 2 (H3a): Refresh card rebuilds a skill card's one commit at
    // the library's new version — the old diff is not this one's.
    card.kind?.origin.version.contentId ?? "",
  ].join(SEP);
}

/** PR #375 review: a new read of the same card keeps the member's accept /
 *  reject on every hunk it still shows unchanged (same file, header and
 *  body); a hunk that changed, or another card's diff, starts over. */
export function keptVerdicts<V>(
  verdicts: Record<string, V>,
  before: ReviewDiff | null | undefined,
  after: ReviewDiff,
): Record<string, V> {
  if (!before || before.cardId !== after.cardId) return {};
  const bodies = (diff: ReviewDiff) => {
    const out = new Map<string, string>();
    for (const file of diff.files) for (const h of file.hunks) out.set(hunkKey(file.path, h.header), h.body);
    return out;
  };
  const was = bodies(before);
  const now = bodies(after);
  const kept: Record<string, V> = {};
  for (const [key, verdict] of Object.entries(verdicts)) {
    if (now.has(key) && now.get(key) === was.get(key)) kept[key] = verdict;
  }
  return kept;
}
function hunkKey(path: string, header: string): string {
  return `${path}${SEP}${header}`;
}

export function CardReviewPanel({ workspaceId, card, shipBusy = false, openPrNumber = null }: Props) {
  // Whatever the review loop wrote (`reviewStatus` changes_requested during
  // a fix round), an open pull request holds the card's work (F11's rule).
  const prNumber = openPrNumber ?? (prOpen(card) ? card.pr!.number : null);
  const inPr = prNumber != null;
  const loadFromDisk = useKanban((s) => s.loadFromDisk);

  // The linked swarm's status — review is gated to a terminal swarm.
  const linkedSwarmStatus = useSwarms((s) =>
    card.linkedSwarmId
      ? s.byWorkspace[workspaceId]?.swarms.find(
          (sw) => sw.id === card.linkedSwarmId,
        )?.status ?? null
      : null,
  );
  const swarmRunning =
    linkedSwarmStatus === "running" || linkedSwarmStatus === "suspended";

  // C4 (team walk 2026-10-02): the diff is kept with the read it answers. A
  // card switch or a new review status renders once before the effect below
  // runs, and the previous answer (an empty diff) must not be shown as this
  // one's — until its own read lands, the panel says it is loading.
  //
  // Tier 4 walk 2026-10-14: the read also answers the card's revision. A
  // Builder card's "Review again" takes a new snapshot with `reviewStatus`
  // unchanged, so a key without it kept showing (and offering to merge) the
  // previous snapshot's diff. The latest snapshot's commit, the revision the
  // last review read and that review's id are part of the key: when one
  // moves, the old diff is not this one's and is read again.
  //
  // PR #375 review: and the branch tip — a commit past the last Build done
  // is read too (the diff shows it, Merge waits for Build done).
  const branchTip = useReviewTip(card)?.branchTip ?? null;
  const diffKey = reviewDiffKey(card, branchTip);
  const [loaded, setLoaded] = useState<{ key: string; diff: ReviewDiff | null } | null>(null);
  // The last diff read, for the verdicts a new read keeps.
  const lastDiff = useRef<ReviewDiff | null>(null);
  const diff: ReviewDiff | null | undefined = loaded?.key === diffKey ? loaded.diff : undefined;
  // The load failure's raw text: it is shown only in the error block's Details.
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const [busy, setBusy] = useState(false);

  const conflictBlocked = card.reviewStatus === "conflict_blocked";
  const mergeStarted = conflictMergeStarted(card);
  const conflictBusy = useBuilder((s) => s.fixBusy[card.id] != null);

  // Fetch the diff once the swarm is terminal. Re-fetch when the key moves:
  // reviewStatus (a completed follow-up flips it back to "pending") or the
  // card's revision (a new build snapshot, a new review).
  useEffect(() => {
    if (!card.worktreePath || swarmRunning) return;
    let cancelled = false;
    setErrorDetails(null);
    const key = diffKey;
    cardReviewDiff(workspaceId, card.id)
      .then((d) => {
        if (!cancelled) {
          const before = lastDiff.current;
          lastDiff.current = d;
          setLoaded({ key, diff: d });
          setVerdicts((prev) => keptVerdicts(prev, before, d));
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setLoaded({ key, diff: null });
          setErrorDetails(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, card.id, card.worktreePath, swarmRunning, diffKey]);

  const setVerdict = useCallback(
    (key: string, next: Verdict | null) => {
      setVerdicts((prev) => {
        const copy = { ...prev };
        if (next) copy[key] = next;
        else delete copy[key];
        return copy;
      });
    },
    [],
  );

  // SL-5: line comments, for cards with a Builder to send them to.
  const [selection, setSelection] = useState<LineSelection | null>(null);
  const [addingComment, setAddingComment] = useState(false);
  // The typed comment belongs to the panel, not the box: clicking other
  // lines moves the selection and keeps the text.
  const [commentDraft, setCommentDraft] = useState("");
  // Challenger on a pull request: someone else's has no Builder to
  // comment to; the diff is read-only there.
  const reviewsOthersPr = Boolean(card.prReview && !card.prReview.pushable);
  const commentsOn = Boolean(card.builder) && !reviewsOthersPr;
  const [composerFocus, setComposerFocus] = useState(0);
  const selectLines = useCallback(
    (path: string, anchor: number, focus: number, toComposer: boolean) => {
      setSelection({ path, anchor, focus });
      setComposerFocus((n) => (toComposer ? n + 1 : 0));
    },
    [],
  );
  const cancelSelection = useCallback(() => {
    setSelection(null);
    setCommentDraft("");
  }, []);
  const addComment = useCallback(
    async (path: string, rows: DiffRow[], body: string) => {
      if (!selection || selection.path !== path) return false;
      const range = selectionRange(rows, selection.anchor, selection.focus);
      if (!range) return false;
      setAddingComment(true);
      try {
        await useKanban
          .getState()
          .addLineComment(workspaceId, card.id, { path, ...range, body });
        setSelection(null);
        setCommentDraft("");
        return true;
      } catch (e) {
        pushErrorToast("The comment couldn't be added", e, { then: "Nothing was saved. Try again." });
        return false;
      } finally {
        setAddingComment(false);
      }
    },
    [selection, workspaceId, card.id],
  );
  const unsentLineComments = useMemo(() => unsentComments(card.lineComments), [card.lineComments]);
  const commented = useCallback(
    (path: string, row: DiffRow) =>
      unsentLineComments.some((c) =>
        c.path !== path
          ? false
          : row.kind === "del"
            ? c.oldStart != null && row.oldLine != null && row.oldLine >= c.oldStart && row.oldLine <= (c.oldEnd ?? c.oldStart)
            : c.newStart != null && row.newLine != null && row.newLine >= c.newStart && row.newLine <= (c.newEnd ?? c.newStart),
      ),
    [unsentLineComments],
  );
  const commenting: LineCommenting | null = commentsOn
    ? {
        selection,
        select: selectLines,
        composerFocus,
        cancel: cancelSelection,
        add: addComment,
        busy: addingComment,
        draft: commentDraft,
        setDraft: setCommentDraft,
        commented,
      }
    : null;

  // SP-6: the round switch above the diff narrows its findings to one
  // review round, as Activity's "See its findings" does (the same filter,
  // the same rule: only while the latest review is the one it was chosen on).
  const reviewRounds = card.builder?.reviewRounds;
  const rounds = useMemo(() => roundChoices(reviewRounds), [reviewRounds]);
  const latestReviewId = card.builder?.review?.reviewId ?? null;
  const roundFilter = useUi((s) => s.reviewRoundFilter[card.id] ?? null);
  const setReviewRoundFilter = useUi((s) => s.setReviewRoundFilter);
  const activeRound = roundFilter && roundFilter.reviewId === latestReviewId ? roundFilter : null;
  const roundIds = activeRound?.ids ?? null;
  const shownAnchors = useMemo(() => anchorsOfRound(diff?.anchors, roundIds), [diff, roundIds]);

  // CL-6: the Challenger's findings on the lines they name.
  const placement = useMemo(
    () =>
      diff
        ? placeAnchors(
            shownAnchors,
            diff.files.map((file) => ({ path: file.path, rows: diffRows(file.hunks) })),
          )
        : null,
    [diff, shownAnchors],
  );
  const anchorCount = diff?.anchors?.length ?? 0;
  const setDiffAnchorIds = useUi((s) => s.setDiffAnchorIds);
  useEffect(() => {
    setDiffAnchorIds(
      card.id,
      shownAnchors.map((anchor) => anchor.id),
    );
    return () => setDiffAnchorIds(card.id, null);
  }, [shownAnchors, card.id, setDiffAnchorIds]);
  // Round 2 (F6): an ask for a finding no anchor took after one pass is
  // dropped, so it can't steal the focus later.
  const findingFocus = useUi((s) => s.findingFocus);
  const focusFinding = useUi((s) => s.focusFinding);
  useEffect(() => {
    if (findingFocus?.to !== "diff" || findingFocus.cardId !== card.id) return;
    const timer = setTimeout(() => {
      if (useUi.getState().findingFocus === findingFocus) focusFinding(null);
    }, 0);
    return () => clearTimeout(timer);
  }, [findingFocus, card.id, focusFinding]);

  const rejectedCount = useMemo(
    () => Object.values(verdicts).filter((v) => v.status === "rejected").length,
    [verdicts],
  );

  const onRequestChanges = useCallback(async () => {
    if (!diff) return;
    const rejections: ReviewRejection[] = [];
    for (const file of diff.files) {
      for (const h of file.hunks) {
        const v = verdicts[hunkKey(file.path, h.header)];
        if (v?.status === "rejected") {
          rejections.push({
            path: file.path,
            hunkHeader: h.header,
            feedback: v.feedback.trim(),
            hunkBody: h.body,
          });
        }
      }
    }
    if (rejections.length === 0) return;
    // G4 (launch D8): a follow-up swarm only for a card that ran one; a
    // Builder card's rejected hunks go into its Builder session.
    const route = changesRoute(card);
    if (route === "none") {
      pushToast({ kind: "warn", title: "Nothing was sent", body: NOWHERE_FOR_CHANGES });
      return;
    }
    setBusy(true);
    try {
      if (route === "builder") {
        // The store says how it went, in a toast; sent, the rejections are
        // the Builder's now and the hunks start over.
        if ((await useBuilder.getState().sendChanges(workspaceId, card.id, rejections)) === "sent") {
          setVerdicts({});
        }
        return;
      }
      await cardReviewRequestChanges(workspaceId, card.id, rejections);
      pushToast({
        kind: "info",
        title: "Changes requested",
        body: `Sent ${rejections.length} rejected ${rejections.length === 1 ? "change" : "changes"} back to be redone.`,
      });
      await loadFromDisk(workspaceId, true);
    } catch (e) {
      // Launch G1 (round 2, P3-2): the follow-up asked the Free slot.
      if (showPlanRefusal(e)) return;
      pushToast({
        kind: "error",
        title: "The changes couldn't be sent",
        body: "Nothing was sent to the agents. Try again; Details says why.",
        copyText: String(e),
      });
    } finally {
      setBusy(false);
    }
  }, [diff, verdicts, workspaceId, card, loadFromDisk]);

  const onMerge = useCallback(async (unreviewedOk = false) => {
    setBusy(true);
    try {
      const res = await cardReviewMerge(workspaceId, card.id, unreviewedOk);
      // GH #151: merged or conflicted, the land got past the fast-forward check.
      observeShipAttempt(workspaceId, [card.id], "merge", {
        passedGate: true,
        shipped: res.merged,
        // GH #183: Rust's word that the land reached origin's tip.
        fastForwarded: res.fastForwarded === true,
      });
      if (res.merged) {
        // G10: one verb — Shipped, to the target by its name on this Mac.
        pushToast({
          kind: "info",
          title: "Shipped",
          body: `Merged into ${targetHere(diff?.baseBranch)}.${
            res.reviewOverride ? ` ${res.reviewOverride}` : ""
          }`,
        });
      } else {
        // UX P1 point 7 (P-E): the toast Ship it raises, word for word.
        await loadFromDisk(workspaceId, true);
        announceShipConflict(workspaceId, card.id, res.conflictingPaths);
        return;
      }
      await loadFromDisk(workspaceId, true);
    } catch (e) {
      // GH #151: GH #88's refusal is the card's Ship step's block, announced.
      if (observeShipAttempt(workspaceId, [card.id], "merge", { refused: e })) return;
      const dirty = decodeTargetDirtyError(e);
      pushToast(
        dirty
          ? {
              kind: "warn",
              title: TARGET_DIRTY_TITLE,
              body: targetDirtyToastBody(dirty),
              action: { label: SHOW_THEM, onClick: () => openFolderChanges(workspaceId, "ship") },
            }
          : {
              kind: "error",
              title: "The merge didn't go through",
              body: "Nothing was merged. Try again; Details says why.",
              copyText: String(e),
            },
      );
    } finally {
      setBusy(false);
    }
  }, [workspaceId, card.id, diff, loadFromDisk]);

  // PR #375 review: a conflicted merge's retry lands the last snapshot
  // plainly only past an approved review. G10: the panel has no Merge of
  // its own any more — the card's one Ship (Now) ships it.
  const reviewGap = mergeReviewGap(card.builder);

  // ── Render gates ──────────────────────────────────────
  if (card.shipStatus === "shipped") return null;
  // Challenger (C4 round 2): nothing to read, so nothing loads — a final line
  // rather than an empty section where the diff would be.
  if (!card.worktreePath) {
    return (
      <section className="card-review-panel">
        <h4 className="card-review-title">Review</h4>
        <p className="card-review-note">{machineWords(NO_WORKTREE_DIFF)}</p>
      </section>
    );
  }
  if (card.reviewStatus === "merged" && !inPr) {
    return (
      <section className="card-review-panel card-review-merged">
        <h4 className="card-review-title">Review</h4>
        <p className="card-review-note">
          {machineWords("✓ Shipped on this Mac.")}
        </p>
      </section>
    );
  }

  return (
    <section className="card-review-panel">
      <h4 className="card-review-title">Review</h4>

      {swarmRunning && (
        <p className="card-review-note">
          The multi-AI run is still working, so the changes aren't final yet.
        </p>
      )}

      {!swarmRunning && conflictBlocked && (
        <div className="card-review-conflict" data-ply-rule="ship-conflict">
          {/* UX P1 point 7 (P-E): the card's own sentence and press. */}
          <p>{mergeStarted ? CONFLICT_SENT_HELPER : shipConflictSentence(card)}</p>
          <ShipConflictDetails card={card} />
          {askBuilderOffered(card) && !mergeStarted && (
            <button
              type="button"
              className="card-review-btn primary"
              disabled={busy || conflictBusy}
              title={ASK_BUILDER_TITLE}
              onClick={() => void useBuilder.getState().resolveShipConflict(workspaceId, card.id)}
            >
              {conflictBusy ? "Starting the merge…" : ASK_BUILDER_LABEL}
            </button>
          )}
          {/* PR #375 review: a retry of a "Merge anyway" asks the same way. */}
          {reviewGap && (
            <p className="card-review-note" data-ply-merge-gap="">
              {`${reviewGap} Retry merge anyway lands it without an approved review; the receipt says so.`}
            </p>
          )}
          {!mergeStarted && (
            <button
              type="button"
              className={askBuilderOffered(card) ? "card-review-btn" : "card-review-btn primary"}
              disabled={busy}
              onClick={() => void onMerge(reviewGap != null)}
            >
              {reviewGap ? "Retry merge anyway" : "Retry merge"}
            </button>
          )}
        </div>
      )}

      {!swarmRunning && !conflictBlocked && diff === undefined && (
        <p className="card-review-note">Loading the changes…</p>
      )}
      {!swarmRunning && !conflictBlocked && diff === null && (
        <ErrorBlock error={loadFailedError("The changes", errorDetails)} density="dense" />
      )}

      {!swarmRunning && !conflictBlocked && diff && diff.files.length === 0 && (
        <p className="card-review-note">{emptyDiffLine(card)}</p>
      )}

      {!swarmRunning && !conflictBlocked && diff && diff.files.length > 0 && (
        <>
          <ReviewSummary diff={diff} />
          {card.prReview ? (
            <p className="card-review-isolation">
              {reviewsOthersPr
                ? `Pull request #${card.prReview.number} against ${diff.baseBranch}, as the card has it. Read-only; nothing here is posted to GitHub.`
                : `Pull request #${card.prReview.number} against ${diff.baseBranch}, with your fix. Comments go to the Builder, never to GitHub.`}
            </p>
          ) : inPr ? (
            <p className="card-review-isolation">
              <GlossaryText text={`These changes are in pull request #${prNumber}; comments go to the Builder.`} words={["pull request"]} />
            </p>
          ) : (
            <p className="card-review-isolation">
              These changes live only on the card's own branch
              (<code>{diff.cardBranch}</code>) — nothing is merged until you
              ship it.
            </p>
          )}
          {commenting && (
            <p className="card-review-isolation">
              Click a line to comment on it; Shift-click another line to take the lines
              between. From the keyboard: Space selects a line, Shift+Arrow takes the next
              ones, Enter opens the comment box, Esc clears. Comments go to the Builder, not
              to GitHub.
            </p>
          )}
          {anchorCount > 0 && rounds.length > 0 && (
            <RoundSwitch
              rounds={rounds}
              value={activeRound?.round ?? null}
              onChange={(choice) =>
                setReviewRoundFilter(
                  card.id,
                  choice ? { round: choice.round, ids: choice.ids, reviewId: latestReviewId } : null,
                )
              }
            />
          )}
          {anchorCount > 0 && (
            <p className="card-review-isolation" data-ply-anchor-intro="">
              {activeRound
                ? <GlossaryText text={roundViewWords(activeRound.round, shownAnchors.length)} words={["round"]} />
                : anchorCount === 1
                  ? "The Reviewer's finding is under the line it names."
                  : `The Reviewer's ${anchorCount} findings are under the lines they name.`}
              {/* Walk of #386: a diff with no line comments (someone else's
                  pull request) has only the Challenger's findings. */}
              {commenting ? " Line comments are yours; findings are the Reviewer's." : ""}
            </p>
          )}
          <div className="card-review-files">
            {diff.files.map((file) => (
              <ReviewFile
                key={file.path}
                cardId={card.id}
                anchors={placement?.files.get(file.path) ?? null}
                file={file}
                verdicts={verdicts}
                onVerdict={setVerdict}
                showVerdicts={!inPr}
                commenting={commenting}
              />
            ))}
          </div>
          {placement && placement.elsewhere.length > 0 && (
            <ElsewhereAnchors cardId={card.id} anchors={placement.elsewhere} />
          )}
          {commentsOn && <LineCommentList workspaceId={workspaceId} card={card} shipBusy={shipBusy} />}
          {!inPr && (
          <footer className="card-review-footer">
            <button
              type="button"
              className="card-review-btn"
              disabled={busy || rejectedCount === 0}
              onClick={() => void onRequestChanges()}
            >
              Request changes ({rejectedCount})
            </button>
          </footer>
          )}
        </>
      )}
    </section>
  );
}

const NO_VERDICTS: Record<string, Verdict> = {};
const noVerdict = () => {};

/** SP-6: "All · Round 1 · Round 2 …" above the diff; past three rounds a
 *  select, as Segmented holds four choices at most. */
function RoundSwitch({
  rounds,
  value,
  onChange,
}: {
  rounds: RoundChoice[];
  value: number | null;
  onChange: (choice: RoundChoice | null) => void;
}) {
  const options = [
    { value: "all", label: "All" },
    ...rounds.map((r) => ({ value: `round-${r.round}`, label: `Round ${r.round}`, title: GLOSSARY.round })),
  ];
  const current = value == null ? "all" : `round-${value}`;
  const pick = (next: string) => onChange(rounds.find((r) => `round-${r.round}` === next) ?? null);
  return (
    <div className="ux-round-switch" data-ply-round-switch="">
      {options.length <= 4 ? (
        <Segmented<string> label="Findings of review round" value={current} onChange={pick} options={options} />
      ) : (
        <Select label="Findings of review round" value={current} onChange={pick} options={options} />
      )}
    </div>
  );
}

/** CL-8: a diff's files drawn as the review draws them, read only — no
 *  verdicts, no line comments (Build with both's Open the diff). */
export function DiffFiles({ cardId, files }: { cardId: string; files: FileDiff[] }) {
  return (
    <div className="card-review-files">
      {files.map((file) => (
        <ReviewFile
          key={`${file.oldPath ?? ""}${SEP}${file.path}`}
          cardId={cardId}
          // A lane's diff is not the card's reviewed diff: no review anchors.
          anchors={null}
          file={file}
          verdicts={NO_VERDICTS}
          onVerdict={noVerdict}
          showVerdicts={false}
          commenting={null}
        />
      ))}
    </div>
  );
}

function ReviewSummary({ diff }: { diff: ReviewDiff }) {
  // CL-11 (walks): lines added and removed, never file counts that read as
  // lines ("+0 · ~1 · -0" for four added lines).
  return (
    <p className="card-review-summary" data-ply-review-summary="">
      {diffSummaryLine(diff.files)}
    </p>
  );
}

/** CL-6: findings on files this diff doesn't show (untouched by the card,
 *  or no longer changed), each under its path. */
function ElsewhereAnchors({ cardId, anchors }: { cardId: string; anchors: FindingAnchor[] }) {
  const paths = [...new Set(anchors.map((anchor) => anchor.path))];
  return (
    <div className="card-review-file" data-ply-anchors-elsewhere="">
      <div className="card-review-file-head">
        <span className="card-review-anchor-heading">Findings on files these changes don't touch</span>
      </div>
      {paths.map((path) => (
        <div key={path} className="card-review-anchors">
          <p className="card-review-anchor-note">
            <code className="card-review-path">{path}</code>
          </p>
          {anchors
            .filter((anchor) => anchor.path === path)
            .map((anchor) => (
              <FindingAnchorRow key={anchor.id} anchor={anchor} cardId={cardId} showWhere />
            ))}
        </div>
      ))}
    </div>
  );
}

function ReviewFile({
  cardId,
  anchors,
  file,
  verdicts,
  onVerdict,
  showVerdicts,
  commenting,
}: {
  cardId: string;
  anchors: FilePlacement | null;
  file: FileDiff;
  verdicts: Record<string, Verdict>;
  onVerdict: (key: string, next: Verdict | null) => void;
  showVerdicts: boolean;
  commenting: LineCommenting | null;
}) {
  const rows = useMemo(() => diffRows(file.hunks), [file.hunks]);
  const sel = commenting?.selection?.path === file.path ? commenting.selection : null;
  const range = sel ? selectionRange(rows, sel.anchor, sel.focus) : null;
  const lo = sel ? Math.min(sel.anchor, sel.focus) : -1;
  const hi = sel ? Math.max(sel.anchor, sel.focus) : -1;
  // v1.154.1 (walk F21): the file's lines are one roving tab stop — the
  // line last focused (else the selection's end, else the first line) has
  // tabIndex 0, the others -1; arrows move between them, across hunks.
  const fileRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const firstPickable = useMemo(() => rows.find(isSelectable)?.order ?? null, [rows]);
  const tabStop =
    active != null && rows[active] && isSelectable(rows[active])
      ? active
      : sel
        ? sel.focus
        : firstPickable;
  const focusRow = useCallback((order: number) => {
    fileRef.current
      ?.querySelector<HTMLElement>(`[data-ply-diff-row="${order}"]`)
      ?.focus();
  }, []);
  const onRowClick = (order: number, extend: boolean) => {
    if (!commenting) return;
    setActive(order);
    if (extend && sel) commenting.select(file.path, sel.anchor, order, true);
    else commenting.select(file.path, order, order, true);
  };
  const onRowKey = (e: KeyboardEvent<HTMLElement>, order: number) => {
    if (!commenting) return;
    const steps: Record<string, number> = {
      ArrowDown: 1,
      ArrowUp: -1,
      Home: -Infinity,
      End: Infinity,
    };
    if (e.key in steps && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const to = stepSelectable(rows, order, steps[e.key]);
      if (e.shiftKey) commenting.select(file.path, sel ? sel.anchor : order, to, false);
      setActive(to);
      focusRow(to);
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      const toComposer = e.key === "Enter";
      if (e.shiftKey && sel) commenting.select(file.path, sel.anchor, order, toComposer);
      else if (toComposer && sel && order >= lo && order <= hi)
        commenting.select(file.path, sel.anchor, sel.focus, true);
      else commenting.select(file.path, order, order, toComposer);
    } else if (e.key === "Escape" && sel) {
      e.preventDefault();
      e.stopPropagation();
      commenting.cancel();
    }
  };
  // Cancel or Esc in the comment box gives the focus back to the lines.
  const cancelToLines = () => {
    commenting?.cancel();
    if (tabStop != null) focusRow(tabStop);
  };
  // The comment box goes under the hunk holding the selection's last line.
  const composerHunk = sel ? rows[hi]?.hunk ?? null : null;
  const badge =
    file.kind === "added"
      ? "A"
      : file.kind === "removed"
      ? "D"
      : file.kind === "renamed"
      ? "R"
      : "M";
  return (
    <div className="card-review-file" ref={fileRef}>
      <div className="card-review-file-head">
        <span className={`card-review-kind kind-${file.kind}`}>{badge}</span>
        <span className="card-review-path">{file.path}</span>
      </div>
      {anchors && anchors.onFile.length > 0 && (
        <div className="card-review-anchors">
          {anchors.onFile.map((anchor) => (
            <FindingAnchorRow key={anchor.id} anchor={anchor} cardId={cardId} showWhere />
          ))}
        </div>
      )}
      {file.hunks.length === 0 && (
        <p className="card-review-note">
          (no textual diff — rename or binary file)
        </p>
      )}
      {file.hunks.map((hunk, i) => (
        <ReviewHunk
          key={hunk.header}
          path={file.path}
          hunk={hunk}
          rows={rows.filter((r) => r.hunk === i)}
          cardId={cardId}
          anchorsByRow={anchors?.byRow ?? null}
          verdict={verdicts[hunkKey(file.path, hunk.header)] ?? null}
          showVerdicts={showVerdicts}
          onVerdict={(next) =>
            onVerdict(hunkKey(file.path, hunk.header), next)
          }
          commenting={commenting}
          selected={(order) => order >= lo && order <= hi}
          tabStop={tabStop}
          onRowClick={onRowClick}
          onRowKey={onRowKey}
          onRowFocus={setActive}
          composer={
            commenting && range && composerHunk === i ? (
              <LineCommentComposer
                label={`${file.path}, ${rangeLabel(range)}`}
                busy={commenting.busy}
                body={commenting.draft}
                onBody={commenting.setDraft}
                onAdd={async (body) => {
                  const added = await commenting.add(file.path, rows, body);
                  // The keyboard goes back to the lines, where it was.
                  if (added && tabStop != null) focusRow(tabStop);
                  return added;
                }}
                onCancel={cancelToLines}
                focusKey={commenting.composerFocus}
              />
            ) : null
          }
        />
      ))}
    </div>
  );
}

function ReviewHunk({
  path,
  hunk,
  rows,
  cardId,
  anchorsByRow,
  verdict,
  showVerdicts,
  onVerdict,
  commenting,
  selected,
  tabStop,
  onRowClick,
  onRowKey,
  onRowFocus,
  composer,
}: {
  path: string;
  hunk: DiffHunk;
  rows: DiffRow[];
  cardId: string;
  anchorsByRow: Map<number, FindingAnchor[]> | null;
  verdict: Verdict | null;
  showVerdicts: boolean;
  onVerdict: (next: Verdict | null) => void;
  commenting: LineCommenting | null;
  selected: (order: number) => boolean;
  tabStop: number | null;
  onRowClick: (order: number, extend: boolean) => void;
  onRowKey: (e: KeyboardEvent<HTMLElement>, order: number) => void;
  onRowFocus: (order: number) => void;
  composer: ReactNode;
}) {
  const segments = useMemo(() => {
    const out: { rows: DiffRow[]; anchors: FindingAnchor[] }[] = [{ rows: [], anchors: [] }];
    for (const row of rows) {
      out[out.length - 1].rows.push(row);
      const under = anchorsByRow?.get(row.order);
      if (under && under.length > 0) {
        out[out.length - 1].anchors = under;
        out.push({ rows: [], anchors: [] });
      }
    }
    if (out.length > 1 && out[out.length - 1].rows.length === 0) out.pop();
    return out;
  }, [rows, anchorsByRow]);
  return (
    <div className={`card-review-hunk verdict-${verdict?.status ?? "none"}`}>
      <div className="card-review-hunk-head">
        <code className="card-review-hunk-header">{hunk.header}</code>
        {showVerdicts && (
        <span className="card-review-hunk-actions">
          <button
            type="button"
            className={`card-review-mini ${
              verdict?.status === "accepted" ? "is-on" : ""
            }`}
            aria-pressed={verdict?.status === "accepted"}
            onClick={() =>
              onVerdict(
                verdict?.status === "accepted"
                  ? null
                  : { status: "accepted", feedback: "" },
              )
            }
          >
            Accept
          </button>
          <button
            type="button"
            className={`card-review-mini reject ${
              verdict?.status === "rejected" ? "is-on" : ""
            }`}
            aria-pressed={verdict?.status === "rejected"}
            onClick={() =>
              onVerdict(
                verdict?.status === "rejected"
                  ? null
                  : { status: "rejected", feedback: "" },
              )
            }
          >
            Reject
          </button>
        </span>
        )}
      </div>
      {/* CL-6: a Challenger finding goes right under the line it names, so
          the lines are cut into runs there (each later run's list is named
          "…, continued"); one scroll box, both ways, holds them all, and the
          findings stay put when the lines scroll sideways. */}
      <div className="card-review-hunk-scroll">
        <div className="card-review-hunk-runs">
        {segments.map((segment, run) => (
          <Fragment key={segment.rows[0]?.order ?? -1}>
            <pre
              className="card-review-hunk-body"
              role={commenting ? "listbox" : undefined}
              aria-multiselectable={commenting ? true : undefined}
              aria-label={
                commenting ? `Lines of ${path}, ${hunk.header}${run > 0 ? ", continued" : ""}` : undefined
              }
            >
              {segment.rows.map((row) => {
                const cls =
                  row.kind === "add" ? "diff-add" : row.kind === "del" ? "diff-del" : "diff-ctx";
                const pickable = commenting != null && isSelectable(row);
                const on = pickable && selected(row.order);
                const noted = pickable && commenting.commented(path, row);
                return (
                  <div
                    key={row.order}
                    className={`card-review-line ${cls}${pickable ? " is-pickable" : ""}${on ? " is-selected" : ""}${noted ? " has-comment" : ""}`}
                    data-ply-diff-row={row.order}
                    // The "\ No newline" line is never an option: hidden from the
                    // listbox, still drawn.
                    role={pickable ? "option" : commenting ? "presentation" : undefined}
                    aria-hidden={commenting && !pickable ? true : undefined}
                    aria-label={
                      pickable
                        ? `${rowLabel(path, row)}${noted ? " (has a comment not sent yet)" : ""}`
                        : undefined
                    }
                    aria-selected={pickable ? on : undefined}
                    tabIndex={pickable ? (row.order === tabStop ? 0 : -1) : undefined}
                    onClick={pickable ? (e) => onRowClick(row.order, e.shiftKey) : undefined}
                    onKeyDown={pickable ? (e) => onRowKey(e, row.order) : undefined}
                    onFocus={pickable ? () => onRowFocus(row.order) : undefined}
                  >
                    {commenting && (
                      <span className="card-review-gutter" aria-hidden>
                        <span>{row.oldLine ?? ""}</span>
                        <span>{row.newLine ?? ""}</span>
                      </span>
                    )}
                    {row.text || " "}
                  </div>
                );
              })}
            </pre>
            {segment.anchors.length > 0 && (
              <div className="card-review-anchors">
                {segment.anchors.map((anchor) => (
                  <FindingAnchorRow key={anchor.id} anchor={anchor} cardId={cardId} />
                ))}
              </div>
            )}
          </Fragment>
        ))}
        </div>
      </div>
      {composer}
      {verdict?.status === "rejected" && (
        <textarea
          className="card-review-feedback"
          placeholder="What should the follow-up swarm change here?"
          value={verdict.feedback}
          onChange={(e) =>
            onVerdict({ status: "rejected", feedback: e.target.value })
          }
        />
      )}
    </div>
  );
}

/** C4: what an empty diff says, in the card's own terms — a swarm's, a
 *  Builder's build, or the card's branch. */
export function emptyDiffLine(card: Pick<KanbanCard, "linkedSwarmId" | "builder"> & Partial<Pick<KanbanCard, "prReview">>): string {
  if (card.prReview) return "The pull request changes nothing against its base.";
  if (card.linkedSwarmId) return "This multi-AI run changed nothing.";
  if (card.builder) return "This build changed nothing.";
  return "Nothing has changed on this card's branch.";
}

/** What the review says for a card with no worktree on this Mac. */
export const NO_WORKTREE_DIFF = "No changes to show yet: this card has no copy of the repository on this Mac.";
