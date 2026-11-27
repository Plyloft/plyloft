import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GoLiveSheet } from "./GoLiveSheet";
import { NewCardAreaPick, useNewCardArea } from "./CardAreaLine";
import { RELEASE_UNREAD } from "../lib/projectRelease";
import { boardReleaseItem } from "../lib/releaseSheet";
import { openHeaderRelease, openRelease, useHeaderRelease } from "../store/projectRelease";
import { useReleaseScopes, useScopesReading } from "../store/releaseScopeStore";
import { pickerAreas } from "../lib/areaPicker";
import { archiveToastBody } from "../lib/cardLifecycle";
import { nameOffIssueOf, sayArchiveNameKept } from "../lib/leaveCard";
import { outsideAuthor, outsideLine } from "../lib/issueText";
import { EDIT_WAITS_LINE, hasEditConflict } from "../lib/editConflict";
import { cardLiveFrom, cardLiveSourcesNow, useCardPresenter } from "../hooks/useCardLive";
import { boardCardTitle, boardNextPress, presentAttentionGroups, presentCard, type CardPresentation } from "../lib/cardPresentation";
import {
  useKanban,
  type KanbanCard,
} from "../store/kanbanStore";
import { listGroupingOf, useWorkspaces } from "../store/workspaceStore";
import { useSwarms } from "../store/swarmStore";
import { useBuilder } from "../store/builderStore";
import { useSettings } from "../store/settingsStore";
import { effectiveBuilderVendor } from "../lib/cardPage";
import { boardUnreadError } from "../lib/boardUnread";
import { ErrorBlock } from "./ux/ErrorBlock";
import { effectiveCenterMode, useUi } from "../store/uiStore";
import { useTeamAllowed } from "../store/accountStore";
import { pushToast } from "../store/toastStore";
import { EMPTY_ARRAY } from "../lib/empties";
import { useLiveReviewTips } from "./useReviewTip";
import {
  ATELIER_CARD_TYPE,
  BOARD_COLUMN_DROP_KINDS,
  acceptsAttr,
  dragIsCardMove,
} from "../lib/dropGuard";
import { KanbanCardContextMenu } from "./KanbanCardContextMenu";
import { DiscussionModal } from "./DiscussionModal";
import { CBtn } from "./ui/primitives";
import { PrReviewSheet } from "./PrReviewSheet";
import { useCardDelete } from "./CardDeleteDialog";
import {
  BOARD_NEW_TASK_EVENT,
  BOARD_PR_REVIEW_EVENT,
  boardNewTaskTarget,
  requestBoardNewTask,
  cardArrivedWords,
} from "../lib/boardCommands";
import {
  ATTENTION_COLUMNS,
  deriveBoardDropDecision,
  moveAsksToStart,
  SHIP_BATCH_BY_AREA,
  shipBatchLabel,
  legalDropZones,
  shipBatchShown,
  shipBatchTitle,
  autoArchiveCandidates,
  cardRestorable,
  restoreTitle,
  restoredWords,
  DONE_VISIBLE,
  type AttentionColumn,
  type BoardDropDecision,
  type BoardDropTarget,
} from "../lib/boardSemantics";
import { boardFocusStep, boardKeyAction, boardMoveTarget, type BoardKeyAction } from "../lib/boardKeys";
import {
  boardFocusReturnCard,
  type BoardSelectionSnapshot,
} from "../lib/boardFocus";
import { TEAM_BOARD_READ_ONLY_MESSAGE } from "../lib/teamGateCardWrites";
import { openPlanSettings } from "../store/planPrompts";
import { BoardNotices } from "./BoardNotices";
import { hiddenFor, hiddenToken, niKey, useNextImprovement, useNiOpens } from "../store/nextImprovementStore";
import { NI_EARLY_HINT, NI_EARLY_LABEL, SHOW_NI } from "../lib/nextImprovement";
import { boardLabelWords, boardTitle, emptyAreaWords, filterByArea, needsYouElsewhere, otherAreasWords } from "../lib/areaPicker";
import { useAreas, useAreasFailure, useAreasView, useCurrentArea } from "../store/areaStore";
import { useSolo } from "../store/workModeStore";
import { ModeHeader } from "./ModeHeader";
import { DuplicateChip, Icon, MoreMenu, SearchField, Segmented, StateWord, type MenuItem } from "./ux";
import { isSkillCard } from "../lib/skillCards";
import { BoardFilterMenu } from "./BoardFilterMenu";
import {
  EMPTY_BOARD_FILTER,
  boardCardMatches,
  boardFilterActive,
  type BoardFilterFacts,
} from "../lib/boardFilter";
import { LIST_GROUPING_OPTIONS, boardBuilder, type BoardBuilder } from "../lib/boardList";
import { shortcutKeys } from "../lib/shortcuts";
import { BoardList } from "./BoardList";
import "./board.css";
import { deferCardRemoval, prReviewAskFresh, UNDO_WINDOW_MS, useBoard } from "../store/boardStore";
import { formatKeys, isWindows, modOnly } from "../lib/platform";
import { CREATE_AND_PLAN_LABEL } from "../lib/planExchangeView";
import { usePlanExchange } from "../store/planExchangeStore";
import { claimLoginNow, useCardClaim, useClaimLogin, useOtherDeviceWords } from "./CardClaimChip";
import { claimMenuLabel, hasLocalRun, isOwnPullRequest, linkedPullRequestWords, sharedClaimLine } from "../lib/cardClaim";
import { cardTarget, targetSyncBadge, type TargetSyncBadge } from "../lib/targetSync";
import { TARGET_SYNC_POLL_MS, useTargetSync } from "../store/targetSyncStore";
import { setupIsOpen } from "../store/setupStore";
import { usePageVisible } from "../hooks/usePageVisible";
import { NO_FRESHNESS, announcedWords, readWords, refreshDue, type RefreshReason } from "../lib/boardFreshness";
import { projectFolderCheck } from "../lib/openPrLinks";
import { projectFolderWords } from "../lib/projectSetup";
import { openWebLink } from "../ipc";
import { focusNewCardBrief } from "./followUpFocus";
import { ARRIVED_MS, BoardEmptyHero, NEW_CARD_FAILED } from "./BoardEmptyHero";
import { linkDidNotOpen } from "../lib/linkToast";
import { pushErrorToast } from "../lib/errorToast";

/** P-A (Challenger): each card's presentation, computed once by the Board
 *  from its one subscription to the live facts and read by its cards. The
 *  default (a card drawn outside a Board) reads the stores as they are. */
const BoardPresented = createContext<(card: KanbanCard) => CardPresentation>((card) =>
  presentCard(card, cardLiveFrom(cardLiveSourcesNow(), card)),
);

/** UX-5.8: the cards the auto-archive already asked about this session. */
const autoArchiveTried = new Set<string>();

/** UX-5.5/5.6: open the Release sheet on this Board's workspace, ticking
 *  `cardIds` (every ready card of the area when null). 1.174.0 (DR3): the
 *  one Release sheet. */
export function openShipBatch(workspaceId: string, cardIds: string[] | null): void {
  openRelease(cardIds ? { workspaceId, cardIds } : { workspaceId });
}

type Props = {
  workspaceId: string;
};

/** 1.172.1 (F2, owner 2026-10-28): under a GitHub-backed Board's title, where
 *  its cards come from, when it last read them and the press that reads them
 *  again — "Cards come from the GitHub issues of o/r · read 2 min ago · Get
 *  new issues" (QoL 14.1's "Updated … · Refresh" read as an app updater).
 *  Its own minute ticker, so the Board doesn't re-render. */
function BoardSourceLine({
  workspaceId,
  ticking,
  areaLabel,
}: {
  workspaceId: string;
  ticking: boolean;
  /** 1.173.0 (C1): the current area's issue label ("labeled area:site");
   *  `null` on All areas and without areas. */
  areaLabel: string | null;
}) {
  const syncing = useKanban((s) => s.syncing[workspaceId] ?? false);
  const reading = useKanban((s) => s.reading[workspaceId] ?? false);
  const freshness = useKanban((s) => s.freshness[workspaceId] ?? NO_FRESHNESS);
  const refreshGithub = useKanban((s) => s.refreshGithub);
  const repo = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId)?.githubOwnerRepo ?? null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [ticking, freshness]);
  // Challenger 2: the on-open Sync and ⋯ Sync with GitHub also write, so
  // they are not "reading…".
  const busy = !syncing ? null : reading ? "reading…" : "syncing with GitHub…";
  // Challenger 3: the ticking "read 3 min ago" is not announced; only a read
  // starting, ending or failing is.
  const announced = busy ?? announcedWords(freshness, now);
  return (
    <>
      <p className="board-source" data-ply-board-source="">
        <span>
          {repo ? (
            <>
              Cards come from the GitHub issues of{" "}
              <button
                type="button"
                className="board-source-repo"
                onClick={() => {
                  const url = `https://github.com/${repo}/issues`;
                  void openWebLink(url).catch((e: unknown) => pushToast(linkDidNotOpen(url, e)));
                }}
                title={`Open the issues of ${repo} on GitHub`}
                aria-label={`${repo}, open its issues on GitHub`}
              >
                {repo}
              </button>
              {areaLabel ? ` ${boardLabelWords(areaLabel)}` : null}
            </>
          ) : (
            `Cards come from this project's GitHub issues${areaLabel ? ` ${boardLabelWords(areaLabel)}` : ""}`
          )}
        </span>
        {" · "}
        <span className="board-source-read">{busy ?? readWords(freshness, now)}</span>
        {" · "}
        <button
          type="button"
          className="board-source-get"
          disabled={syncing}
          onClick={() => void refreshGithub(workspaceId)}
          title="Read this board's GitHub issues again: a new issue becomes a card, and an edited or closed issue updates its card. Nothing is written to GitHub; Sync with GitHub in ⋯ also sends this computer's changes."
        >
          Get new issues
        </button>
      </p>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-ply-board-source-status="">
        {announced}
      </span>
    </>
  );
}

/** DS5: the Board ⋯ entry, named as the section it opens. */
const WHERE_THE_CARDS_LIVE = "Where the cards live";

/** DS8 round 3: how long Settings search's Release… waits for the Board to
 *  read what it needs. */
const BOARD_ASK_EXPIRES_MS = 10_000;
/** Boards mounted per workspace: the ask ends when the last one goes. */
const mountedBoards = new Map<string, number>();

export function KanbanBoard({ workspaceId }: Props) {
  const cards = useKanban(
    (s) => s.byWorkspace[workspaceId]?.cards ?? EMPTY_ARRAY,
  );
  const loaded = useKanban(
    (s) => s.byWorkspace[workspaceId]?.loaded ?? false,
  );
  // 1.176.2 (E1): a board that couldn't be read is not an empty one.
  const loadError = useKanban((s) => (s.byWorkspace[workspaceId]?.loadFailed ? s.byWorkspace[workspaceId]?.loadError ?? "" : null));
  const loadFromDisk = useKanban((s) => s.loadFromDisk);
  const archiveCard = useKanban((s) => s.archiveCard);
  // v1.57.0 (Cycle 3): GitHub-Issues backing — Sync button + reconcile-on-open.
  const reconcileGithub = useKanban((s) => s.reconcileGithub);
  const syncing = useKanban((s) => s.syncing[workspaceId] ?? false);
  const refreshGithub = useKanban((s) => s.refreshGithub);
  const ghBacked = useWorkspaces(
    (s) =>
      s.workspaces.find((w) => w.id === workspaceId)?.kanbanSyncMode ===
      "githubIssues",
  );
  // v1.85.0 (team tier): lapse degrade — a GH-backed board without a
  // valid team key is read-only (sync gated backend-side; the banner +
  // flip-to-local escape live in Settings → Kanban backing).
  const licensed = useTeamAllowed();
  const solo = useSolo();
  const boardReadOnly = ghBacked && !licensed;
  // UX-5.7: "Find a card" and the filters, per workspace for the session.
  const filter = useBoard((s) => s.filter[workspaceId] ?? EMPTY_BOARD_FILTER);
  const setFilter = useBoard((s) => s.setFilter);
  const clearFilter = useBoard((s) => s.clearFilter);
  const needsYouOnly = filter.needsYouOnly;
  const searchId = `board-search-${workspaceId}`;
  const selectedCardId = useUi(
    (state) => state.selectedCardId[workspaceId] ?? null,
  );
  const previousSelectionRef = useRef<BoardSelectionSnapshot>({
    workspaceId,
    selectedCardId,
  });

  // The Board stays mounted behind card detail. When selection clears, put
  // keyboard focus back on the exact card that opened the lifecycle. Deleted
  // or newly archived cards no longer have an opener, so the stable Board
  // filter is the truthful fallback rather than resurrecting a missing row.
  useEffect(() => {
    const current = { workspaceId, selectedCardId };
    const returnCardId = boardFocusReturnCard(
      previousSelectionRef.current,
      current,
    );
    previousSelectionRef.current = current;
    if (!returnCardId) return;
    const frame = requestAnimationFrame(() => {
      const opener = document.querySelector<HTMLButtonElement>(
        `[data-ply-board-card-id="${CSS.escape(returnCardId)}"]`,
      );
      // The search field is the stable fallback (the List's rows and a
      // filtered-out card have no opener).
      const fallback = document.querySelector<HTMLElement>(
        `[data-ply-board-focus-fallback="${CSS.escape(workspaceId)}"] input`,
      );
      (opener ?? fallback)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedCardId, workspaceId]);

  // Lazy load on first render if the warm-up effect hasn't fired yet.
  useEffect(() => {
    if (!loaded) loadFromDisk(workspaceId).catch(() => {});
  }, [workspaceId, loaded, loadFromDisk]);

  // v1.57.0 (Cycle 3): full reconcile once the board is loaded on a GitHub-
  // backed workspace (the "on open" half of the minimal sync schedule). Manual
  // re-sync is the Sync button. `loaded` stays true across the reconcile's
  // forced reload, so this fires once per board mount, not in a loop.
  useEffect(() => {
    if (loaded && ghBacked && licensed)
      reconcileGithub(workspaceId).catch(() => {});
  }, [workspaceId, loaded, ghBacked, licensed, reconcileGithub]);

  // U28: each read of the issues also reads which of them a teammate's open
  // pull request closes, for the tile: one read, never per card.
  const lastRead = useKanban((s) => s.freshness[workspaceId]?.at ?? null);
  const readOpenPrLinks = useKanban((s) => s.readOpenPrLinks);
  useEffect(() => {
    if (loaded && ghBacked && licensed && lastRead != null) void readOpenPrLinks(workspaceId);
  }, [workspaceId, loaded, ghBacked, licensed, lastRead, readOpenPrLinks]);

  // QoL 14.1 (C19): while this Board is on screen it reads its issues again
  // every few minutes and when the window comes back (read only, throttled,
  // backed off after a failure — `boardFreshness`). A hidden Board, another
  // workspace or mode, or a read-only board never asks.
  const pageVisible = usePageVisible();
  const boardMode = useUi(
    (s) => effectiveCenterMode(s.centerMode, workspaceId) === "board",
  );
  const activeHere = useWorkspaces((s) => s.activeId === workspaceId);
  const refreshing = loaded && ghBacked && licensed && pageVisible && boardMode && activeHere;
  useEffect(() => {
    if (!refreshing) return;
    const tick = (reason: RefreshReason) => {
      const at = Date.now();
      const f = useKanban.getState().freshness[workspaceId] ?? NO_FRESHNESS;
      // The first read is the on-open reconcile above, not this.
      if (f.triedAt == null) return;
      if (refreshDue(f, at, reason)) void refreshGithub(workspaceId);
    };
    tick("focus");
    const timer = window.setInterval(() => tick("timer"), 30_000);
    const onFocus = () => tick("focus");
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshing, workspaceId, refreshGithub]);

  // 1.170.0 (G6): while this Board is on screen it reads how far its cards
  // are behind GitHub's target every few minutes (the backend bounds and
  // throttles the fetch) — the cards' Behind / Conflict ahead badges.
  const syncReading = loaded && pageVisible && boardMode && activeHere;
  useEffect(() => {
    if (!syncReading) return;
    void useTargetSync.getState().refresh(workspaceId, false);
    const timer = window.setInterval(() => void useTargetSync.getState().refresh(workspaceId, false), TARGET_SYNC_POLL_MS);
    return () => window.clearInterval(timer);
  }, [syncReading, workspaceId]);

  // UX-5.8: a card shipped more than 14 days ago leaves Done for the
  // archive, where Restore brings it back (and it is not taken again). Once
  // per card per session; the backend re-checks each one before it writes.
  // A read-only (unlicensed GitHub) Board is left as it is.
  useEffect(() => {
    if (!loaded || boardReadOnly) return;
    const due = autoArchiveCandidates(cards, Date.now(), { readOnly: boardReadOnly }).filter(
      (id) => !autoArchiveTried.has(id),
    );
    if (due.length === 0) return;
    for (const id of due) autoArchiveTried.add(id);
    void (async () => {
      for (const id of due) {
        await archiveCard(id, { auto: true }).catch((err: unknown) =>
          console.warn(`auto-archive of ${id} skipped:`, err),
        );
      }
    })();
  }, [loaded, boardReadOnly, cards, archiveCard]);

  // QoL 1.168 S1-3: while a card is dragged the Archived row shows even when
  // nothing is archived yet — it is the one place a drag archives (Done
  // refuses: "Done fills when a card ships").
  const [cardDragging, setCardDragging] = useState(false);
  useEffect(() => {
    const on = (e: DragEvent) => {
      if (dragIsCardMove(e)) setCardDragging(true);
    };
    const off = () => setCardDragging(false);
    document.addEventListener("dragenter", on);
    document.addEventListener("dragend", off);
    document.addEventListener("drop", off);
    return () => {
      document.removeEventListener("dragenter", on);
      document.removeEventListener("dragend", off);
      document.removeEventListener("drop", off);
    };
  }, []);

  // Document-level DnD delegation (v0.6.1: per-column handlers were bypassed
  // on macOS). GH #138: a column only ever claims a card move; a file, URL or
  // text from another app belongs to the shell's drop guard. `dragIsCardMove`
  // reads the drag session recorded at `dragstart`, so a card move is still
  // recognised when WKWebView strips the custom MIME type mid-drag.
  //
  // UX-5.3: a drop reorders within the card's column or archives it (on
  // Done, or on the archive row). It never starts, stops or ships work: the
  // only writes reachable from here are `setBoardOrder` and the archive.
  useEffect(() => {
    let active: Element | null = null;
    // 1.173.0 (F1, BI-16): the zones the dragged card may land in, read once
    // per drag (the card is the one `onDragStart` recorded).
    let legal: { cardId: string; zones: ReturnType<typeof legalDropZones> } | null = null;
    function legalFor(zone: Element): boolean {
      const cardId = boardDrag.cardId;
      if (!cardId) return true;
      if (!legal || legal.cardId !== cardId) {
        const ctx = boardMoveContext(workspaceId, cardId);
        if (!ctx) return true;
        legal = { cardId, zones: legalDropZones(ctx.card, ctx.status, ctx.cards, ctx.from) };
      }
      const column = zone.getAttribute("data-board-column") as AttentionColumn | null;
      return column ? legal.zones.columns.includes(column) : legal.zones.archive;
    }
    function findZone(target: EventTarget | null): Element | null {
      if (!target || !(target instanceof Element)) return null;
      return target.closest("[data-board-column], [data-board-archive]");
    }
    function highlight(zone: Element | null) {
      if (active && active !== zone) active.classList.remove("board-drop-target");
      if (zone) zone.classList.add("board-drop-target");
      active = zone;
    }
    function claim(e: DragEvent) {
      if (!dragIsCardMove(e)) return;
      const zone = findZone(e.target);
      if (!zone) return;
      // The zone still takes the drop — a refused one says why in its toast
      // — but only a zone the card may land in lights up.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      highlight(legalFor(zone) ? zone : null);
    }
    function endDrag() {
      boardDrag.cardId = null;
      legal = null;
      highlight(null);
    }
    function onDragLeave(e: DragEvent) {
      if (!dragIsCardMove(e)) return;
      const related = e.relatedTarget instanceof Element ? e.relatedTarget : null;
      if (findZone(e.target) !== findZone(related)) highlight(null);
    }
    function onDrop(e: DragEvent) {
      if (!dragIsCardMove(e)) return;
      const zone = findZone(e.target);
      if (!zone) return;
      e.preventDefault();
      e.stopPropagation();
      endDrag();
      const cardId =
        e.dataTransfer?.getData(ATELIER_CARD_TYPE) ||
        e.dataTransfer?.getData("text/plain") ||
        "";
      const ctx = boardMoveContext(workspaceId, cardId);
      if (!ctx) return;
      const column = zone.getAttribute("data-board-column") as AttentionColumn | null;
      const target: BoardDropTarget = column
        ? { kind: "column", column, index: dropIndex(zone, e.target, e.clientY) }
        : { kind: "archive" };
      void applyBoardDecision(ctx.card, decideBoardMove(ctx, target), ctx.from);
    }
    document.addEventListener("dragenter", claim);
    document.addEventListener("dragover", claim);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("drop", onDrop);
    document.addEventListener("dragend", endDrag);
    return () => {
      document.removeEventListener("dragenter", claim);
      document.removeEventListener("dragover", claim);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("drop", onDrop);
      document.removeEventListener("dragend", endDrag);
    };
  }, [workspaceId]);

  const [showDiscussion, setShowDiscussion] = useState(false);
  const [showGoLive, setShowGoLive] = useState(false);
  // Challenger on a pull request: Board › ⋯ › Review a pull request.
  const [showPrReview, setShowPrReview] = useState(false);
  // QoL 14.2 (F7): the Inbox's "Review it with the Challenger" opens this
  // Board's sheet with that pull request picked.
  const [prReviewPick, setPrReviewPick] = useState<number | null>(null);
  const prReviewAsk = useBoard((s) => (s.prReviewAsk?.workspaceId === workspaceId ? s.prReviewAsk : null));
  useEffect(() => {
    if (!prReviewAsk) return;
    useBoard.getState().setPrReviewAsk(null);
    // A leftover ask (its Board never showed in time) is dropped unasked.
    if (!prReviewAskFresh(prReviewAsk, Date.now())) return;
    if (boardReadOnly) {
      pushToast({ kind: "info", title: "This board is read-only", body: TEAM_BOARD_READ_ONLY_MESSAGE });
      return;
    }
    setPrReviewPick(prReviewAsk.number);
    setShowPrReview(true);
  }, [prReviewAsk, boardReadOnly]);
  // …and from ⌘K (lib/boardCommands.requestBoardPrReview).
  useEffect(() => {
    function onPrReview(event: Event) {
      const detail = (event as CustomEvent<{ workspaceId: string }>).detail;
      if (detail?.workspaceId !== workspaceId) return;
      if (boardReadOnly) {
        pushToast({ kind: "warn", title: "Board is read-only", body: TEAM_BOARD_READ_ONLY_MESSAGE });
        return;
      }
      setShowPrReview(true);
    }
    window.addEventListener(BOARD_PR_REVIEW_EVENT, onPrReview);
    return () => window.removeEventListener(BOARD_PR_REVIEW_EVENT, onPrReview);
  }, [workspaceId, boardReadOnly]);
  const [newTaskRequest, setNewTaskRequest] = useState(0);
  // SP-1 walk: the last request a field opened for. A column remounts when
  // the List goes back to the columns, and the count alone (still above
  // zero from an earlier New card) opened an empty "New card title" by
  // itself. Only a request not yet shown opens the field.
  const [shownNewTaskRequest, setShownNewTaskRequest] = useState(0);
  const pendingNewTaskRequest = newTaskRequest > shownNewTaskRequest ? newTaskRequest : 0;

  useEffect(() => {
    function onNewTask(event: Event) {
      const detail = (event as CustomEvent<{ workspaceId: string }>).detail;
      if (detail?.workspaceId !== workspaceId) return;
      if (boardReadOnly) {
        pushToast({
          kind: "warn",
          title: "Board is read-only",
          body: TEAM_BOARD_READ_ONLY_MESSAGE,
        });
        return;
      }
      // 1.176.2 (E1): an unread board takes no card, and no request waits for
      // the read to come back and open an empty field by itself.
      if (loadError !== null) {
        pushToast({ kind: "warn", title: "The board couldn't be read", body: "Try again first." });
        return;
      }
      // The new card's field opens at the top of Needs you on the columns:
      // bring the columns back, unfiltered, so it is on screen.
      const board = useBoard.getState();
      if ((board.view[workspaceId] ?? "board") !== "board") board.setView(workspaceId, "board");
      if (boardFilterActive(board.filter[workspaceId] ?? EMPTY_BOARD_FILTER)) {
        board.clearFilter(workspaceId);
      }
      setNewTaskRequest((request) => request + 1);
    }
    window.addEventListener(BOARD_NEW_TASK_EVENT, onNewTask);
    return () => window.removeEventListener(BOARD_NEW_TASK_EVENT, onNewTask);
  }, [workspaceId, boardReadOnly, loadError]);

  // UX-5.9: a card deleted or archived a moment ago is hidden while its
  // Undo is on screen.
  const pendingRemoval = useBoard((s) => s.pendingRemoval);
  const archivedCards = cards.filter((c) => c.archived && !pendingRemoval[c.id]);
  const activeCards = cards.filter((c) => !c.archived && !pendingRemoval[c.id]);
  // 1.173.0 (B2): the area the picker is on — its cards only (a card with
  // no area stays in All areas), and "Board · Site" as the title.
  const area = useCurrentArea(workspaceId);
  // 1.173.0 (E3): Next improvement hidden here (Hide; its toast says so, C7) comes back
  // from the ⋯.
  const niSectionKey = niKey(workspaceId, area?.id ?? null);
  // 1.174.0 (A4): the List's selection bar shows a filled Ship N.
  const [listShipFilled, setListShipFilled] = useState(false);
  const niHidden = useNextImprovement((s) => {
    const token = hiddenFor(s, niSectionKey);
    return token !== null && token === hiddenToken(s.rounds[niSectionKey]?.round);
  });
  // 1.174.0 (A6, D2c): before this person's first shipped card, the ⋯ offers
  // Next improvement (mockups/board.html 5a).
  const niOpens = useNiOpens(workspaceId, niSectionKey);
  const areaCards = filterByArea(activeCards, area?.id ?? null);
  const areaArchived = filterByArea(archivedCards, area?.id ?? null);
  // 1.174.0 (DR3): ⋯ › Release Site… — what the area's release would carry
  // (`release_scopes`, read when the ⋯ opens), the project's without areas,
  // or on All areas the one area with something, else a question.
  const areasView = useAreasView(workspaceId);
  const releaseAreas = pickerAreas(areasView).map((a) => ({ id: a.id, name: a.name }));
  const scopesReading = useScopesReading(workspaceId);
  const releaseItem = boardReleaseItem(
    scopesReading,
    releaseAreas,
    area ? { id: area.id, name: area.name } : null,
    Date.now(),
  );
  // On an area, the header's "Release N cards…" is that area's ready cards; on
  // All areas of a project with areas (1.174.1 P3), the ready cards of the
  // one area the sheet opens, which decides or asks which area.
  const headerRelease = useHeaderRelease(workspaceId);
  // 1.174.0 (DS8): Settings search's "How this goes live" and "Release…"
  // land here and do what the ⋯ menu's entries do.
  const boardAsk = useUi((s) => (s.boardAsk?.workspaceId === workspaceId ? s.boardAsk : null));
  // 1.174.0 (DR3): the ask opens the Release sheet as the ⋯'s Release <Area>…
  // does (`releaseItem`), off with the same reason.
  const releaseOff = boardReadOnly || releaseItem.off;
  // Release… waits for what it reads (the cards, the areas, what each area
  // would release): a Board the ask mounts fresh would otherwise find it
  // off. An areas read that failed is read too: the ask ends, saying so.
  const areasFailed = useAreasFailure(workspaceId) !== undefined && areasView === undefined;
  const asksRelease = boardAsk?.what === "release";
  useEffect(() => {
    if (asksRelease) void useReleaseScopes.getState().read(workspaceId);
  }, [asksRelease, workspaceId]);
  const scopesRead = scopesReading.scopes !== null || scopesReading.failed;
  const releaseAskReady = loaded && (areasView !== undefined || areasFailed) && scopesRead;
  useEffect(() => {
    if (!boardAsk) return;
    if (boardAsk.what === "go-live") {
      useUi.getState().clearBoardAsk();
      setShowGoLive(true);
      return;
    }
    // An ask older than its 10 s is the expiry's to end, never to open.
    if (!releaseAskReady || Date.now() - boardAsk.at >= BOARD_ASK_EXPIRES_MS) return;
    useUi.getState().clearBoardAsk();
    if (areasFailed) {
      pushToast({ kind: "warn", title: RELEASE_UNREAD });
      return;
    }
    if (releaseOff) {
      // Off: the same reason the ⋯ menu's Release… gives.
      if (boardReadOnly) {
        pushToast({ kind: "info", title: "This board is read-only", body: TEAM_BOARD_READ_ONLY_MESSAGE });
      } else if (releaseItem.hint) {
        pushToast({ kind: "info", title: releaseItem.hint });
      }
      return;
    }
    openRelease(releaseItem.areaId === undefined ? { workspaceId } : { workspaceId, areaId: releaseItem.areaId });
    // Only a new ask runs it, once what it reads is read, with the Board as
    // it is then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardAsk?.at, releaseAskReady]);
  // DS8 round 3: an ask that can't be answered never opens by itself
  // later — after 10 s it ends, saying the ready cards couldn't be read.
  const releaseAskAt = boardAsk?.what === "release" ? boardAsk.at : null;
  useEffect(() => {
    if (releaseAskAt === null) return;
    const id = window.setTimeout(() => {
      const ask = useUi.getState().boardAsk;
      if (ask?.workspaceId !== workspaceId || ask.at !== releaseAskAt) return;
      useUi.getState().clearBoardAsk();
      pushToast({ kind: "warn", title: RELEASE_UNREAD });
    }, Math.max(0, releaseAskAt + BOARD_ASK_EXPIRES_MS - Date.now()));
    return () => window.clearTimeout(id);
  }, [releaseAskAt, workspaceId]);
  // ...and it doesn't outlive the Board it was for. Cleared a tick after
  // the last Board of this workspace unmounts (StrictMode's dev remount
  // keeps it).
  useEffect(() => {
    mountedBoards.set(workspaceId, (mountedBoards.get(workspaceId) ?? 0) + 1);
    return () => {
      mountedBoards.set(workspaceId, (mountedBoards.get(workspaceId) ?? 1) - 1);
      window.setTimeout(() => {
        if ((mountedBoards.get(workspaceId) ?? 0) > 0) return;
        if (useUi.getState().boardAsk?.workspaceId === workspaceId) useUi.getState().clearBoardAsk();
      }, 0);
    };
  }, [workspaceId]);
  const swarms = useSwarms(
    (s) => s.byWorkspace[workspaceId]?.swarms ?? EMPTY_ARRAY,
  );
  const statusOf = useCallback(
    (card: KanbanCard) =>
      card.linkedSwarmId
        ? swarms.find((swarm) => swarm.id === card.linkedSwarmId)?.status ?? null
        : null,
    [swarms],
  );
  // P-A (UX P1 point 2): every card says what `presentCard` says — its
  // column, its word in the filter — from the same live facts as its
  // Board card, its List row and its page (the live tips included, so a
  // "Ready to ship" here is the card's own).
  const presenter = useCardPresenter();
  // 1.171.0 re-walk (step 4): the filter's Builder is the List's — the AI
  // the card's page shows when it has no session yet.
  const vendorPref = useBuilder((s) => s.vendorPref);
  const builderDefault = useSettings((s) => s.settings.behavior.builderVendor);
  const tips = useLiveReviewTips(activeCards);
  const presentations = new Map<string, CardPresentation>();
  for (const card of activeCards) presentations.set(card.id, presenter(card, tips.get(card.id) ?? null));
  const presented = (card: KanbanCard) => presentations.get(card.id) ?? presenter(card, null);
  // UX-5.7: what the filter reads of each card, derived once.
  const facts = new Map<string, BoardFilterFacts>();
  for (const card of areaCards) {
    const p = presented(card);
    if (!p.column) continue;
    facts.set(card.id, {
      column: p.column,
      state: p.blocked ?? p.headline,
      builder: boardBuilder(card, effectiveBuilderVendor(vendorPref[card.id], card, builderDefault)),
    });
  }
  const shownCards = areaCards.filter((card) => {
    const f = facts.get(card.id);
    return f ? boardCardMatches(card, f, filter) : false;
  });
  const filtering = boardFilterActive(filter);
  const needsYouCount = [...facts.values()].filter((f) => f.column === "needs-you").length;
  // F1 (Challenger 4): with an area picked, Needs you says what the other
  // areas hold, so it adds up to the Inbox's number.
  const elsewhere = otherAreasWords(needsYouElsewhere(activeCards, area?.id ?? null, (c) => presented(c).column));
  // The columns and the List draw the same filtered cards.
  const allShownGroups = presentAttentionGroups(shownCards, presented);
  // UX-5.8: Done shows the latest ten until "Show all N" — on both views.
  const [showAllDone, setShowAllDone] = useState(false);
  const doneTotal = allShownGroups.done.length;
  const boardGroups = showAllDone
    ? allShownGroups
    : { ...allShownGroups, done: allShownGroups.done.slice(0, DONE_VISIBLE) };
  const doneHiddenCards = allShownGroups.done.slice(DONE_VISIBLE);
  const doneToggle =
    doneTotal > DONE_VISIBLE ? (
      <CBtn
        size="sm"
        tone="quiet"
        className="board-done-toggle"
        onClick={() => setShowAllDone((v) => !v)}
      >
        {showAllDone ? "Show the latest 10" : `Show all ${doneTotal}`}
      </CBtn>
    ) : null;
  // QoL 1.168 C7: the one list every "Ship N" reads (this workspace's).
  const shipCount = headerRelease.cardIds.length;
  // 1.171.0 E3 (owner D5): only for two or more cards.
  // 1.174.0 (C13): the header's Release N cards…, when it shows.
  const headerReleases = shipBatchShown(shipCount);
  // UX-5.6: Board | List, remembered per workspace for the session.
  const view = useBoard((s) => s.view[workspaceId] ?? "board");
  const setView = useBoard((s) => s.setView);
  // CL-9: the List's grouping, remembered per workspace on this Mac.
  const listGrouping = useWorkspaces((s) =>
    listGroupingOf(s.workspaces.find((w) => w.id === workspaceId)),
  );
  const setListGrouping = useWorkspaces((s) => s.setListGrouping);
  // The filter offers what is on this Board: its states, its Builders.
  const stateOptions = boardStateOptions([...facts.values()]);
  const builderOptions = [...new Set([...facts.values()].map((f) => f.builder))].sort(
    (a, b) => BUILDER_ORDER.indexOf(a) - BUILDER_ORDER.indexOf(b),
  );

  // UX-5.7: `/` or ⌘F puts the caret in "Find a card" — on the Board that
  // is on screen, with no card, sheet or field holding the keys.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // OB-4: nothing under Setup answers a key while it is up.
      if (setupIsOpen()) return;
      const slash = e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey;
      const find = e.key.toLowerCase() === "f" && modOnly(e);
      if (!slash && !find) return;
      if (useWorkspaces.getState().activeId !== workspaceId) return;
      const ui = useUi.getState();
      if (effectiveCenterMode(ui.centerMode, workspaceId) !== "board") return;
      if (ui.selectedCardId[workspaceId]) return;
      if (ui.palette.open || ui.settingsOverlayOpen || ui.releaseSheet) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      if (isEditable(e.target)) return;
      const field = document.getElementById(searchId) as HTMLInputElement | null;
      if (!field) return;
      e.preventDefault();
      field.focus();
      field.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [workspaceId, searchId]);

  // v1.75.0 (STEP6 D4): zero non-archived cards → the first-run hero
  // owns the stage instead of four empty columns.
  const newTaskTarget = boardNewTaskTarget(loaded && loadError === null, activeCards.length);
  const boardFailed = loadError !== null;
  const boardEmpty = newTaskTarget === "hero" || boardFailed;

  return (
    <div className="kanban-view">
      {/* UX-3.5 / UX-5.5: the screen header carries the Board's actions —
          Ship N (only for two or more cards), the one primary
          New card, and the ⋯ with Discuss and the GitHub sync (G4: Brainstorm
          left with the swarm UI).
          The sidebar keeps its "Ship N in a batch" row. */}
      <ModeHeader
        mode="board"
        workspaceId={workspaceId}
        title={area ? boardTitle(area) : undefined}
        subtitle={ghBacked && licensed ? <BoardSourceLine workspaceId={workspaceId} ticking={refreshing} areaLabel={area?.label ?? null} /> : undefined}
        actions={
          <>
            {/* GH #251: an empty Board has nothing to switch, find or filter. */}
            {!boardEmpty && (
              <>
                <Segmented
                  label="View"
                  value={view}
                  onChange={(next) => setView(workspaceId, next)}
                  options={[
                    { value: "board", label: "Board" },
                    { value: "list", label: "List" },
                  ]}
                />
                {view === "list" && (
                  <span className="board-group-by">
                    <span className="board-group-by-label" aria-hidden="true">
                      Group by
                    </span>
                    <Segmented
                      label="Group the list"
                      value={listGrouping}
                      onChange={(next) =>
                        void setListGrouping(workspaceId, next).catch((err) =>
                          pushErrorToast("Grouping not saved", err),
                        )
                      }
                      options={[...LIST_GROUPING_OPTIONS]}
                    />
                  </span>
                )}
                <span className="board-search" data-ply-board-focus-fallback={workspaceId}>
                  <SearchField
                    inputId={searchId}
                    value={filter.query}
                    onChange={(query) => setFilter(workspaceId, { query })}
                    placeholder="Find a card"
                    label={`Find a card (${shortcutKeys("findCard")})`}
                  />
                </span>
                <BoardFilterMenu
                  filter={filter}
                  onChange={(patch) => setFilter(workspaceId, patch)}
                  onClear={() => clearFilter(workspaceId)}
                  needsYouCount={needsYouCount}
                  states={stateOptions}
                  builders={builderOptions}
                />
              </>
            )}
            {headerReleases && (
              <CBtn
                onClick={() => openHeaderRelease(workspaceId, headerRelease)}
                // GH #252: a control that cannot act says so where it sits.
                disabled={boardReadOnly}
                title={headerRelease.asks ? SHIP_BATCH_BY_AREA : shipBatchTitle(shipCount)}
                reason={boardReadOnly ? TEAM_BOARD_READ_ONLY_MESSAGE : null}
              >
                <Icon name="shipBatch" />
                {shipBatchLabel(shipCount)}
              </CBtn>
            )}
            {/* G3a walk: New card and ⋯ together, at the right edge. */}
            <span className="board-head-end">
              <CBtn
                // 1.174.0 (A4, owner): one filled button — the List's Ship N
                // while a selection shows it, else New card.
                // 1.176.3: while the Board is empty the box in the middle holds
                // the filled one (Make the card); this stays the tour's anchor.
                tone={(view === "list" && listShipFilled) || newTaskTarget === "hero" ? "ghost" : "accent"}
                onClick={() => requestBoardNewTask(workspaceId)}
                // 1.176.2 (E1): nothing is written onto a board that wasn't read.
                disabled={boardReadOnly || boardFailed}
                // The header's New card is the tour's (TUTORIAL_SPEC B3); the
                // empty Board's quiet one below is not.
                data-ply-tour="board-new-card"
                title="Add a card — it starts as a draft in Not started"
                reason={boardReadOnly ? TEAM_BOARD_READ_ONLY_MESSAGE : boardFailed ? "The board couldn't be read. Try again first." : null}
              >
                <Icon name="add" />
                New card
              </CBtn>
              <MoreMenu
                label="More for the Board"
                onOpen={() => void useReleaseScopes.getState().read(workspaceId)}
                items={[
                  // QoL 1.168 (block 10, C16): in the ⋯, so the header holds
                  // one row at 1280 with the sidebar open (and New card stays
                  // on it); a local-only repository has no pull requests anyway.
                  {
                    label: "Review a pull request…",
                    onSelect: () => setShowPrReview(true),
                    disabled: boardReadOnly,
                    hint: boardReadOnly
                      ? TEAM_BOARD_READ_ONLY_MESSAGE
                      : "The Reviewer reviews an open pull request of this repository on a card of its own",
                  },
                  { label: "Discuss…", onSelect: () => setShowDiscussion(true) },
                  ...(!niOpens
                    ? [
                        {
                          label: NI_EARLY_LABEL,
                          onSelect: () => useNextImprovement.getState().openEarly(workspaceId, niSectionKey),
                          hint: NI_EARLY_HINT,
                        },
                      ]
                    : niHidden
                    ? [
                        {
                          label: SHOW_NI,
                          // A4: and the notes slot opens, if another note is first.
                          onSelect: () => useNextImprovement.getState().show(niSectionKey, workspaceId),
                          hint: "Ideas for this project, one at a time, above the Board",
                        },
                      ]
                    : []),
                  // 1.174.0 (DS5, G2 walk): where this Board's cards are kept —
                  // Project › General's "Where the cards live" (the `board` part).
                  {
                    label: WHERE_THE_CARDS_LIVE,
                    onSelect: () => useUi.getState().openSettingsSection("board", { workspaceId }),
                    hint: "On this Mac, or on GitHub Issues where everyone who opens this project sees the same cards",
                  },
                  // 1.173.0 (D2): where a card goes after it ships, read only.
                  {
                    label: "How this goes live",
                    onSelect: () => setShowGoLive(true),
                    hint: "Where cards go, what changes online when they merge, and how a release is made",
                  },
                  // 1.174.0 (DR3, D1(b)): Release Site… takes everything on the
                  // area's branch since its last tag, and its ready cards — on
                  // as soon as something is new, off with the true reason.
                  // 1.174.0 (C13, BCI-14): one Release — not in the ⋯ while the
                  // header has Release N cards….
                  ...(headerReleases
                    ? []
                    : [
                        {
                          label: releaseItem.label,
                          disabled: boardReadOnly || releaseItem.off,
                          hint: boardReadOnly ? TEAM_BOARD_READ_ONLY_MESSAGE : releaseItem.hint,
                          onSelect: () =>
                            openRelease(
                              releaseItem.areaId === undefined ? { workspaceId } : { workspaceId, areaId: releaseItem.areaId },
                            ),
                        },
                      ]),
                  ...(ghBacked
                    ? [
                        "divider" as const,
                        {
                          label: syncing ? "Syncing with GitHub…" : "Sync with GitHub",
                          disabled: syncing || boardReadOnly,
                          onSelect: () => void reconcileGithub(workspaceId, { manual: true }).catch(() => {}),
                        },
                      ]
                    : []),
                ]}
              />
            </span>
          </>
        }
      />
      {/* 1.174.0 (A4): one slot for the notes above the Board — the
          adoption banner (OB-9: in solo mode it asks nothing about sharing
          or the board; X2: it still says a shared setup found on another
          branch was not used), the areas (B2), the project folder's state
          beside its Sync (E3 round 2) — one at a time, then Next
          improvement's ideas (E3), last; never covers the Board. */}
      <BoardNotices workspaceId={workspaceId} solo={solo} ghBacked={ghBacked} />
      {/* GH #300: no provenance chip — 1.172.1 (F2) the source line under
          the title names a GitHub-backed Board's issues; read-only is one
          line with the way out. */}
      {(boardReadOnly || filtering) && (
        <div className="board-status-line">
          {boardReadOnly && (
            <p className="board-read-only" data-board-read-only="">
              This board is read-only.
              <button
                type="button"
                className="board-status-link"
                onClick={openPlanSettings}
                title={TEAM_BOARD_READ_ONLY_MESSAGE}
              >
                See your plan
              </button>
            </p>
          )}
          {filtering && (
            <CBtn size="sm" tone="quiet" onClick={() => clearFilter(workspaceId)}>
              Clear search and filters
            </CBtn>
          )}
        </div>
      )}
      {/* 1.173.0 (B2): an area with no cards yet says so, with the way back. */}
      {area && !boardEmpty && areaCards.length === 0 && (
        <div className="board-status-line" data-ply-area-empty={area.id}>
          <p className="board-read-only">
            {emptyAreaWords(area)}
            <button
              type="button"
              className="board-status-link"
              onClick={() => useAreas.getState().choose(workspaceId, null)}
            >
              Show all areas
            </button>
          </p>
        </div>
      )}
      <span
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-board-filter-status=""
      >
        {filtering
          ? `Showing ${shownCards.length} of ${areaCards.length} cards`
          : `Showing all ${areaCards.length} cards`}
      </span>
      {showPrReview && (
        <PrReviewSheet
          workspaceId={workspaceId}
          initialNumber={prReviewPick}
          onClose={() => {
            setShowPrReview(false);
            setPrReviewPick(null);
          }}
        />
      )}
      {showGoLive && <GoLiveSheet workspaceId={workspaceId} onClose={() => setShowGoLive(false)} />}
      {showDiscussion && (
        <DiscussionModal
          workspaceId={workspaceId}
          onClose={() => setShowDiscussion(false)}
        />
      )}
      <BoardPresented.Provider value={presented}>
      {boardFailed ? (
        <div className="board-unread" data-ply-board-unread={workspaceId}>
          <ErrorBlock error={boardUnreadError(loadError)} />
          {/* The retry is a bordered button beside the block, not its filled
              way out: the header's New card holds the view's one primary. */}
          <CBtn onClick={() => void loadFromDisk(workspaceId, true)}>Try again</CBtn>
        </div>
      ) : boardEmpty ? (
        <BoardEmptyHero
          workspaceId={workspaceId}
          readOnly={boardReadOnly}
          focusRequest={newTaskTarget === "hero" ? pendingNewTaskRequest : 0}
          onFocusShown={setShownNewTaskRequest}
        />
      ) : (
        <>
          {filtering && shownCards.length === 0 ? (
            <div className="board-filter-empty">
              {needsYouOnly && needsYouCount === 0 && !filter.query.trim()
                ? "Nothing here needs you."
                : "No card matches the search and filters."}
            </div>
          ) : view === "list" ? (
            <BoardList
              workspaceId={workspaceId}
              groups={boardGroups}
              statusOf={statusOf}
              doneFooter={doneToggle}
              doneHidden={showAllDone ? undefined : doneHiddenCards}
              onShipSelected={(ids) => openShipBatch(workspaceId, ids)}
              readOnly={boardReadOnly}
              grouping={listGrouping}
              onShipFilled={setListShipFilled}
            />
          ) : (
            <div className="board-columns">
              {ATTENTION_COLUMNS.map((column) => (
                <BoardColumn
                  key={column.id}
                  workspaceId={workspaceId}
                  column={column.id}
                  label={column.label}
                  cards={boardGroups[column.id]}
                  total={column.id === "done" ? doneTotal : undefined}
                  aside={column.id === "needs-you" ? elsewhere : null}
                  footer={column.id === "done" ? doneToggle : null}
                  readOnly={boardReadOnly}
                  focusNewTask={
                    column.id === "not-started" && newTaskTarget === "todo"
                      ? pendingNewTaskRequest
                      : 0
                  }
                  onNewTaskShown={setShownNewTaskRequest}
                />
              ))}
            </div>
          )}
        </>
      )}
      <KanbanArchivedRow cards={areaArchived} cardDragging={cardDragging} />
      </BoardPresented.Provider>
    </div>
  );
}

const BUILDER_ORDER: readonly BoardBuilder[] = ["claude", "codex", "agent", "swarm", "none"];

/** The words the cards on this Board say, each once, in the order of the
 *  columns — P-A: the filter offers exactly what the cards show. */
function boardStateOptions(facts: readonly BoardFilterFacts[]): Array<{ state: string; label: string }> {
  const order = ATTENTION_COLUMNS.map((c) => c.id);
  const seen = new Map<string, number>();
  for (const f of facts) {
    const rank = order.indexOf(f.column);
    seen.set(f.state, Math.min(seen.get(f.state) ?? rank, rank));
  }
  return [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([state]) => ({ state, label: state }));
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

/** A card's place on the Board as it is drawn, read when a move is asked
 *  for — by a drop, a key or the card's menu (QoL 1.168 block 10, C6): the
 *  one set of facts `deriveBoardDropDecision` decides from. */
type BoardMoveContext = {
  card: KanbanCard;
  cards: KanbanCard[];
  status: ReturnType<typeof swarmStatusNow>;
  groups: Record<AttentionColumn, KanbanCard[]>;
  from: AttentionColumn | null;
};

/** F1 (BI-16): the card being dragged on the Board, from its `dragstart`
 *  (a drag's data can't be read before the drop). */
export const boardDrag: { cardId: string | null } = { cardId: null };

function swarmStatusNow(workspaceId: string, c: KanbanCard) {
  if (!c.linkedSwarmId) return null;
  const swarmsNow = useSwarms.getState().byWorkspace[workspaceId]?.swarms ?? [];
  return swarmsNow.find((swarm) => swarm.id === c.linkedSwarmId)?.status ?? null;
}

function boardMoveContext(workspaceId: string, cardId: string): BoardMoveContext | null {
  const cards = useKanban.getState().byWorkspace[workspaceId]?.cards ?? [];
  const card = cards.find((candidate) => candidate.id === cardId) ?? null;
  if (!card) return null;
  // P-A: the columns as they are drawn — each card where `presentCard`
  // puts it, the one being moved included.
  const sources = cardLiveSourcesNow();
  const presentNow = (c: KanbanCard) => presentCard(c, cardLiveFrom(sources, c));
  return {
    card,
    cards,
    status: swarmStatusNow(workspaceId, card),
    groups: presentAttentionGroups(cards, presentNow),
    from: presentNow(card).column,
  };
}

function decideBoardMove(ctx: BoardMoveContext, target: BoardDropTarget): BoardDropDecision {
  const columnCards = target.kind === "column" ? ctx.groups[target.column] : [];
  return deriveBoardDropDecision(ctx.card, ctx.status, target, columnCards, ctx.cards, ctx.from);
}

/** Carry out a move's decision: say why it was refused, reorder with an
 *  Undo, or archive once the Undo is gone. Resolves when a reorder landed. */
function applyBoardDecision(
  card: KanbanCard,
  decision: BoardDropDecision,
  from: AttentionColumn | null,
): Promise<void> {
  const { setBoardOrder, archiveCard } = useKanban.getState();
  if (decision.kind === "refused") {
    // U32: with the project's folder gone, that is why, as Start build says.
    const folder = moveAsksToStart(decision, from)
      ? projectFolderCheck(card.workspaceId).catch(() => null)
      : Promise.resolve(null);
    return folder.then((refusal) => {
      pushToast({ kind: "warn", title: "Card not moved", body: refusal ? projectFolderWords(refusal) : decision.message });
    });
  } else if (decision.kind === "reorder") {
    // UX-5.9: a move can be undone — the order it had goes back.
    const before = card.boardOrder ?? null;
    return setBoardOrder(decision.cardId, decision.boardOrder).then(() => {
      pushToast({
        kind: "info",
        title: "Card moved",
        body: card.title,
        action: {
          label: "Undo",
          ttlMs: UNDO_WINDOW_MS,
          onClick: () => void setBoardOrder(decision.cardId, before),
        },
      });
    });
  } else if (decision.kind === "archive") {
    // UX-5.9: out of the columns now, archived when the Undo is gone.
    deferCardRemoval({
      cardId: decision.cardId,
      kind: "archive",
      title: "Card archived",
      // QoL 1.168 S1-3: what archiving costs it, as the card's ⋯ says.
      // 1.175.0 (D2): and that the member's own name comes off its issue.
      body: archiveToastBody(card, nameOffIssueOf(card, "archive")),
      commit: () =>
        archiveCard(decision.cardId).then(
          // D2-a: said only when GitHub didn't take the name off.
          () => sayArchiveNameKept(card.workspaceId, card.id, card.title),
          (err: unknown) =>
            pushErrorToast("The card wasn't archived", err, { then: "It's still in its column. Try again." }),
        ),
    });
  }
  return Promise.resolve();
}

/** QoL 1.168 (block 10, C6): ←/→/↑/↓ (J/K) from a focused card to the next
 *  one on the Board, as drawn (filters and Done's "Show all" included). */
function focusBoardStep(cardEl: HTMLElement, dir: "up" | "down" | "left" | "right"): void {
  const board = cardEl.closest(".board-columns");
  if (!board) return;
  const lists = Array.from(board.querySelectorAll("[data-board-column]")).map((col) =>
    Array.from(col.querySelectorAll<HTMLElement>(".board-card-open")),
  );
  const col = lists.findIndex((list) => list.some((b) => cardEl.contains(b)));
  if (col === -1) return;
  const row = lists[col].findIndex((b) => cardEl.contains(b));
  const next = boardFocusStep(lists.map((l) => l.length), { col, row }, dir);
  if (!next) return;
  const el = lists[next.col][next.row];
  el.focus();
  el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

/** The keyboard on the card once a move landed (its node may have moved).
 *  1.174.0 X1: only while the keyboard is still on the Board (or was lost
 *  with the moved node) — a menu, a sheet or a field the person went to
 *  since keeps it. */
function refocusBoardCard(cardId: string): void {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active && active !== document.body && !active.closest(".board-columns")) return;
    document
      .querySelector<HTMLElement>(`.board-columns [data-ply-board-card-id="${CSS.escape(cardId)}"]`)
      ?.focus();
  });
}

type BoardMoveAction = Extract<BoardKeyAction, "moveUp" | "moveDown" | "moveLeft" | "moveRight">;

/** The cards drawn in the column of `cardEl`, in order — what a filter or
 *  a search leaves, and Done's first ten. */
function shownColumnIds(cardEl: Element | null): string[] | null {
  const column = cardEl?.closest("[data-board-column]");
  if (!column) return null;
  return Array.from(column.querySelectorAll("[data-board-card-id]")).map(
    (el) => el.getAttribute("data-board-card-id") ?? "",
  );
}

/** ⌥↑ / ⌥↓ / ⌥← / ⌥→ on a card, or its menu's moves: the place it asks
 *  for, decided as a drop there is. Null: nowhere to go that way. Up and
 *  down go past the card drawn above or below it (Challenger block 10,
 *  item 7: under a filter, the next card shown, not a hidden one). */
function keyMoveDecision(
  ctx: BoardMoveContext,
  action: BoardMoveAction,
  shown: readonly string[] | null = null,
): BoardDropDecision | null {
  if (!ctx.from) return null;
  const list = ctx.groups[ctx.from];
  const index = list.findIndex((c) => c.id === ctx.card.id);
  if ((action === "moveUp" || action === "moveDown") && shown) {
    const at = shown.indexOf(ctx.card.id);
    const neighbour = at === -1 ? undefined : shown[action === "moveUp" ? at - 1 : at + 1];
    const ni = neighbour ? list.findIndex((c) => c.id === neighbour) : -1;
    if (ni === -1) return null;
    const target: BoardDropTarget = { kind: "column", column: ctx.from, index: action === "moveUp" ? ni : ni + 1 };
    return decideBoardMove(ctx, target);
  }
  const target = boardMoveTarget(ctx.from, index, list.length, action);
  return target ? decideBoardMove(ctx, target) : null;
}

function moveCardByKey(
  card: KanbanCard,
  action: BoardMoveAction,
  writable: boolean,
  shown: readonly string[] | null,
  /** The key is being held: a refusal was said at its first press. */
  repeat = false,
): void {
  if (!writable) {
    if (!repeat) pushToast({ kind: "warn", title: "Card not moved", body: TEAM_BOARD_READ_ONLY_MESSAGE });
    return;
  }
  const ctx = boardMoveContext(card.workspaceId, card.id);
  const decision = ctx && keyMoveDecision(ctx, action, shown);
  if (!ctx || !decision) return;
  if (decision.kind === "refused") {
    // Nothing moved, so the keyboard has nowhere to come back from: somebody
    // who went to another card during the folder check stays there.
    if (!repeat) void applyBoardDecision(ctx.card, decision, ctx.from);
    return;
  }
  void applyBoardDecision(ctx.card, decision, ctx.from).then(() => refocusBoardCard(card.id));
}

/** Challenger (block 10, item 8): a card that leaves the Board from its menu
 *  (Archive, Delete) hands the keyboard to the card beside it — the next
 *  drawn in its column, else the one before. Taken when the card's view
 *  unmounts with the focus lost, within a while of the choice. */
const LEAVE_FOCUS_MS = 60_000;
const focusOnLeave = new Map<string, { neighbour: string | null; until: number }>();

function noteLeaving(cardId: string, shown: readonly string[] | null): void {
  const at = shown ? shown.indexOf(cardId) : -1;
  const neighbour = at === -1 ? null : shown![at + 1] ?? shown![at - 1] ?? null;
  focusOnLeave.set(cardId, { neighbour, until: Date.now() + LEAVE_FOCUS_MS });
}

function takeLeaveFocus(cardId: string): void {
  const leaving = focusOnLeave.get(cardId);
  focusOnLeave.delete(cardId);
  if (!leaving || leaving.until < Date.now() || !leaving.neighbour) return;
  const neighbour = leaving.neighbour;
  requestAnimationFrame(() => {
    const at = document.activeElement;
    // Only a focus the card took with it: never one the member moved.
    if (at && at !== document.body) return;
    document
      .querySelector<HTMLElement>(`.board-columns [data-ply-board-card-id="${CSS.escape(neighbour)}"]`)
      ?.focus();
  });
}

/** QoL 1.168 (block 10, C6): a card's menu — Open, the moves (each decided
 *  as a drop there is, a refused one off with the reason), Archive and
 *  Delete. Challenger item 8: a choice is decided again when it is made —
 *  the Board may have moved on while the menu was open. */
function cardMenuItems(
  card: KanbanCard,
  writable: boolean,
  shown: readonly string[] | null,
  open: () => void,
  remove: () => void,
): MenuItem[] {
  const items: MenuItem[] = [{ label: "Open", onSelect: open }];
  const ctx = !card.archived ? boardMoveContext(card.workspaceId, card.id) : null;
  if (ctx?.from) {
    const off = (decision: BoardDropDecision | null): { disabled: boolean; hint?: string } =>
      !writable
        ? { disabled: true, hint: TEAM_BOARD_READ_ONLY_MESSAGE }
        : !decision || decision.kind === "noop"
          ? { disabled: true }
          : decision.kind === "refused"
            ? { disabled: true, hint: decision.message }
            : { disabled: false };
    /** At the press: the facts now, decided again. */
    const go = (decide: (now: BoardMoveContext) => BoardDropDecision | null, leaves = false) => () => {
      const now = boardMoveContext(card.workspaceId, card.id);
      const decision = now ? decide(now) : null;
      if (!now || !decision) return;
      if (leaves && decision.kind === "archive") noteLeaving(card.id, shown);
      void applyBoardDecision(now.card, decision, now.from).then(() => {
        if (decision.kind === "reorder") refocusBoardCard(card.id);
      });
    };
    const moves: MenuItem[] = [];
    for (const [action, label, keys] of [
      ["moveUp", "Move up", "⌥↑"],
      ["moveDown", "Move down", "⌥↓"],
    ] as const) {
      const decide = (c: BoardMoveContext) => keyMoveDecision(c, action, shown);
      moves.push({ label, shortcut: formatKeys(keys), onSelect: go(decide), ...off(decide(ctx)) });
    }
    for (const column of ATTENTION_COLUMNS) {
      if (column.id === ctx.from) continue;
      const decide = (c: BoardMoveContext) => decideBoardMove(c, { kind: "column", column: column.id, index: 0 });
      moves.push({ label: `Move to ${column.label}`, onSelect: go(decide), ...off(decide(ctx)) });
    }
    const archive = (c: BoardMoveContext) => decideBoardMove(c, { kind: "archive" });
    // Block 10 Mac walk: every disabled move says why, even when its
    // neighbour says the same (one reason under a run read as none).
    items.push("divider", ...moves, "divider", {
      label: "Archive",
      onSelect: go(archive, true),
      ...off(archive(ctx)),
    });
  }
  // U3: Claim from the Board, as on the card's own ⋯.
  const claimWord = claimMenuLabel(card, claimLoginNow(card.workspaceId), {
    githubIssues:
      useWorkspaces.getState().workspaces.find((w) => w.id === card.workspaceId)?.kanbanSyncMode === "githubIssues",
    writable,
  });
  if (claimWord) {
    items.push("divider", {
      label: claimWord,
      onSelect: () => void useKanban.getState().claimCard(card.workspaceId, card.id).catch(() => {}),
    });
  }
  items.push("divider", {
    label: "Delete card…",
    danger: true,
    onSelect: () => {
      noteLeaving(card.id, shown);
      remove();
    },
  });
  return items;
}

/** Where in a column a card was released: over a card, before or after it
 *  by which half; else before the first card whose middle is below the
 *  pointer, else at the end. */
function dropIndex(
  column: Element,
  target: EventTarget | null,
  clientY: number,
): number {
  const cards = Array.from(column.querySelectorAll("[data-board-card-id]"));
  const over =
    target instanceof Element ? target.closest("[data-board-card-id]") : null;
  const at = over ? cards.indexOf(over) : -1;
  if (over && at !== -1) {
    const rect = over.getBoundingClientRect();
    return clientY < rect.top + rect.height / 2 ? at : at + 1;
  }
  const index = cards.findIndex((el) => {
    const rect = el.getBoundingClientRect();
    return clientY < rect.top + rect.height / 2;
  });
  return index === -1 ? cards.length : index;
}


/** QoL 1.168 (C6): the new-card field's keys, as this platform draws them. */
function newCardHint(): string {
  return `Enter adds it · ${formatKeys(isWindows() ? "⌘Enter" : "⌘↵")} adds it and opens it`;
}

/** UX-5.2: one attention column — its heading and count, then its cards.
 *  New cards are drafts, so the inline "New card" field opens in Not started
 *  (the card itself is still written to the persisted To do column). */
function BoardColumn({
  workspaceId,
  column,
  label,
  cards,
  readOnly,
  focusNewTask,
  onNewTaskShown,
  total,
  aside,
  footer,
}: {
  workspaceId: string;
  column: AttentionColumn;
  label: string;
  cards: KanbanCard[];
  readOnly: boolean;
  focusNewTask: number;
  /** The request this column opened its field for — taken once, so the
   *  column's next mount (back from the List) does not open it again. */
  onNewTaskShown?: (request: number) => void;
  /** The column's count when it draws fewer cards than it has (Done). */
  total?: number;
  /** F1 (Challenger 4): "· 2 in other areas" beside Needs you's count. */
  aside?: string | null;
  footer?: ReactNode;
}) {
  const addCard = useKanban((s) => s.addCard);
  // 1.174.0 (C3, §2f): on All areas, the new card's area, already chosen.
  const newArea = useNewCardArea(workspaceId);
  const [adding, setAdding] = useState(false);
  const addingRef = useRef(false);
  addingRef.current = adding;
  const [draftTitle, setDraftTitle] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  // 2026-10-16 walk: "Create and plan with two AIs" made two cards 4 ms
  // apart — the press added one, then the field's blur (WebKit blurs a
  // field as it leaves the page, read with its last props) added the same
  // title again. The field adds once per opening, whatever order the
  // press, the blur and Enter come in; the title is read from here, never
  // from a render's closure.
  const draftRef = useRef("");
  const committedRef = useRef(false);
  // QoL 1.168 (C10): a title whose card wasn't made, put back in the field.
  const restoreRef = useRef<string | null>(null);
  const [addFailed, setAddFailed] = useState(false);
  // QoL 1.168 (C9): the card just made, brought into view and marked.
  const [arrived, setArrived] = useState<string | null>(null);
  // 1.171.0 (E2; walk 2026-10-27 #4g): …and announced.
  const [arrivedWords, setArrivedWords] = useState("");
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const headingId = `board-column-${workspaceId}-${column}`;

  useEffect(() => {
    if (!adding) return;
    committedRef.current = false;
    draftRef.current = restoreRef.current ?? "";
    restoreRef.current = null;
  }, [adding]);

  useEffect(() => {
    if (!arrived) return;
    const frame = requestAnimationFrame(() =>
      bodyRef.current
        ?.querySelector<HTMLElement>(`[data-board-card-id="${CSS.escape(arrived)}"]`)
        ?.scrollIntoView?.({ block: "nearest" }),
    );
    const done = window.setTimeout(() => setArrived(null), ARRIVED_MS);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(done);
    };
  }, [arrived]);

  useEffect(() => {
    if (focusNewTask <= 0 || readOnly) return;
    setAdding(true);
    onNewTaskShown?.(focusNewTask);
    // 1.171.0 (E2): the field opens where it can be seen.
    requestAnimationFrame(() => {
      inputRef.current?.scrollIntoView?.({ block: "nearest" });
      inputRef.current?.focus();
    });
  }, [focusNewTask, readOnly, onNewTaskShown]);

  useEffect(() => {
    if (!readOnly) return;
    setAdding(false);
    setDraftTitle("");
  }, [readOnly]);

  function commitAdd(planIt = false, openIt = false) {
    if (committedRef.current) return;
    committedRef.current = true;
    const typed = draftRef.current;
    const title = typed.trim();
    draftRef.current = "";
    setDraftTitle("");
    setAdding(false);
    setAddFailed(false);
    const plans = usePlanExchange.getState();
    // Armed by the palette's "Create and plan with two AIs…", or pressed here.
    const plan = plans.takeNewCardPlan(workspaceId) || planIt;
    if (readOnly || !title) return;
    const area = newArea.area;
    addCard(workspaceId, title, undefined, "todo", area)
      .then((card) => {
        if (area) newArea.remember();
        if (plan) {
          // Created in To do; its page opens on the Plan form.
          plans.requestForm(workspaceId, card.id);
          useUi.getState().selectCard(workspaceId, card.id);
          return;
        }
        // QoL 1.168 (C6): ⌘↵ adds the card and opens it.
        if (openIt) {
          // 1.172.0 (C1; CP-12): its page opens on What you want.
          focusNewCardBrief(card.id);
          useUi.getState().selectCard(workspaceId, card.id);
          return;
        }
        // QoL 1.168 (C9): the new card is brought into view and marked.
        setArrived(card.id);
        setArrivedWords(cardArrivedWords(card.title, label));
      })
      .catch((err) => {
        console.error("kanban add failed:", err);
        // QoL 1.168 (C10): the field opens again with the text, and says so —
        // unless the person already opened it for the next card (Challenger
        // block 5, item 8): that text is theirs; the store's toast says it.
        if (addingRef.current) return;
        restoreRef.current = typed;
        setDraftTitle(typed);
        setAddFailed(true);
        setAdding(true);
      });
  }

  return (
    <section
      // 1.171.0 E3 (walk #5g): an empty column is narrow.
      className={(total ?? cards.length) === 0 && !adding ? "board-column board-column--empty" : "board-column"}
      data-board-column={column}
      aria-labelledby={headingId}
      // GH #138: a column takes a card move and nothing else.
      data-drop-zone="board-column"
      data-drop-accepts={acceptsAttr(BOARD_COLUMN_DROP_KINDS)}
    >
      <h2 className="board-column-heading" id={headingId}>
        {label}
        <span className="board-column-count">{total ?? cards.length}</span>
        {aside && <span className="board-column-count board-column-aside">{aside}</span>}
      </h2>
      <span className="sr-only" role="status" aria-live="polite" data-board-card-arrived="">
        {arrivedWords}
      </span>
      <div className="board-column-body" ref={bodyRef}>
        {adding && (
          <div
            className="board-card board-card--new"
            // Focus moving to the field's own button (Tab) is not leaving it.
            onBlur={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              commitAdd();
            }}
          >
            <input
              ref={inputRef}
              type="text"
              className="board-card-new-input"
              autoFocus
              value={draftTitle}
              disabled={readOnly}
              placeholder="Card title…"
              aria-label="New card title"
              onChange={(e) => {
                draftRef.current = e.target.value;
                setDraftTitle(e.target.value);
              }}
              onKeyDown={(e) => {
                // The Enter that ends an IME composition is not the add
                // (`isComposing`, and the 229 WebKit reports), as in the Chat.
                if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  e.preventDefault();
                  commitAdd(false, modOnly(e));
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  // Given up: the blur as the field goes adds nothing.
                  committedRef.current = true;
                  draftRef.current = "";
                  setAdding(false);
                  setDraftTitle("");
                  setAddFailed(false);
                  // A palette's "Create and plan with two AIs…" given up:
                  // the next card made here is a plain one.
                  usePlanExchange.getState().takeNewCardPlan(workspaceId);
                }
              }}
            />
            <button
              type="button"
              className="board-card-new-plan"
              disabled={readOnly || !draftTitle.trim()}
              // The press keeps the focus in the field, so no blur adds the
              // card the plain way first; the click (or Enter / Space on
              // the button) adds it, once.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commitAdd(true)}
            >
              {CREATE_AND_PLAN_LABEL}
            </button>
            <NewCardAreaPick pick={newArea} disabled={readOnly} />
            {/* QoL 1.168 (C6, C10): what Enter and ⌘↵ do; a card that wasn't
                made says so, its text kept above. */}
            <p className="board-card-new-hint">{newCardHint()}</p>
            {addFailed && (
              <p className="board-new-card-error" role="alert">
                {NEW_CARD_FAILED}
              </p>
            )}
          </div>
        )}
        {cards.map((card) => (
          <KanbanCardView key={card.id} card={card} draggable={!readOnly} arrived={card.id === arrived} />
        ))}
      </div>
      {footer}
    </section>
  );
}

/**
 * The archive, out of the columns. UX-5.3: releasing a card here archives
 * it. UX-5.8: a card Ply archived on its own (or any shipped card) has
 * Restore, which puts it back in Done.
 */
function KanbanArchivedRow({
  cards,
  cardDragging = false,
}: {
  cards: KanbanCard[];
  /** QoL 1.168 S1-3: a card is being dragged — the row shows, empty or not. */
  cardDragging?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const restoreCard = useKanban((s) => s.restoreCard);
  if (cards.length === 0 && !cardDragging) return null;
  const newestFirst = [...cards].sort(
    (a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0),
  );
  return (
    <div
      className="board-archive"
      data-board-archive=""
      // GH #138: it takes a card move and nothing else.
      data-drop-zone="board-column"
      data-drop-accepts={acceptsAttr(BOARD_COLUMN_DROP_KINDS)}
    >
      <button
        type="button"
        className="board-archive-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={open ? "expand" : "opens"} size="sm" />
        Archived
        <span className="board-column-count">{cards.length}</span>
        {cardDragging && <span className="board-archive-hint">Drop here to archive</span>}
      </button>
      {open && (
        <div className="board-archive-body">
          {newestFirst.map((card) => (
            <div key={card.id} className="board-archive-item">
              <KanbanCardView card={card} />
              {cardRestorable(card) && (
                <CBtn
                  size="sm"
                  title={restoreTitle(card)}
                  onClick={() =>
                    restoreCard(card.id)
                      .then((back) => {
                        if (back) pushToast({ kind: "info", ...restoredWords(card, back) });
                      })
                      .catch((err: unknown) =>
                        pushErrorToast("The card wasn't restored", err, { then: "It's still under Archived. Press Restore again." }),
                      )
                  }
                >
                  <Icon name="undo" size="sm" />
                  Restore
                </CBtn>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * UX-5.4: a card on the one scale — the title (14 px, up to three lines, the
 * whole of it in the tooltip) and one fact line: the state's dot and word,
 * and at most one fact ("#42", "6m", "v1.150"). Branch names, provenance and
 * the claim chip moved off the card (the card's Details, C6).
 */
function KanbanCardView({
  card,
  draggable = false,
  arrived = false,
}: {
  card: KanbanCard;
  /** UX-5.3: on a writable Board; never in the archive row. */
  draggable?: boolean;
  /** QoL 1.168 (C9): just made here — marked for a moment. */
  arrived?: boolean;
}) {
  const selectCard = useUi((s) => s.selectCard);

  // v1.31.0: right-click context menu → shared delete-confirm flow.
  const { requestDelete, dialog: deleteDialog } = useCardDelete();
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
  } | null>(null);
  const openRef = useRef<HTMLButtonElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  // Challenger item 8: archived or deleted from its menu, the keyboard goes
  // to the card beside it.
  useEffect(() => () => takeLeaveFocus(card.id), [card.id]);
  const openMenu = (x: number, y: number) =>
    setContextMenu({
      x,
      y,
      items: cardMenuItems(
        card,
        draggable,
        shownColumnIds(cardRef.current),
        () => selectCard(card.workspaceId, card.id),
        () => requestDelete(card),
      ),
    });

  // P-A (UX P1 point 2): the card says what its page, its List row and its
  // Inbox row say — `presentCard`, from the same live facts (the open
  // Builder session's live tip included). T2's "Claimed by …" (someone else
  // holds the issue, nobody started it here) is rule 3 of it; `useCardClaim`
  // keeps this Mac's GitHub login fresh. (Challenger) The Board presents
  // each card once and hands it down: a card does not subscribe to every
  // store of the live facts itself (200 cards × every source).
  const claim = useCardClaim(card);
  // 1.175.0 (D1): both chose to work on it — the card says both names.
  const sharedClaim = sharedClaimLine(claim.state, hasLocalRun(card));
  // 1.175.0 (B3): an issue somebody outside the repository wrote says so,
  // until the card has started on this computer.
  const outside = !hasLocalRun(card) && card.columnId !== "complete" && !card.archived ? outsideAuthor(card) : null;
  // 1.173.0 (C2): "On your MacBook Pro · 2 h ago" / "Taken over by …".
  const otherDevice = useOtherDeviceWords(card);
  // U28: an open pull request of someone else's that closes this card's issue.
  const claimLogin = useClaimLogin(card.workspaceId);
  const prLink = useKanban((s) =>
    card.ghIssueNumber ? (s.openPrLinks[card.workspaceId]?.[card.ghIssueNumber] ?? null) : null,
  );
  const teammatePr = prLink && !isOwnPullRequest(card, prLink.number) ? linkedPullRequestWords(prLink, claimLogin) : null;
  const p = useContext(BoardPresented)(card);
  // 1.170.0 (G6): a string, so a reading that leaves it as it was doesn't
  // draw the card again. 1.171.0 E3 (BI-4, DL-22): the whole badge — the
  // chip keeps its tooltip, and is accented only when it asks something.
  const syncBadgeKey = useTargetSync((s) => {
    const report = s.byWorkspace[card.workspaceId];
    const badge = report ? targetSyncBadge(card, report.cards[card.id], cardTarget(report, card.id)) : null;
    return badge ? JSON.stringify(badge) : null;
  });
  const syncBadge = useMemo(
    () => (syncBadgeKey ? (JSON.parse(syncBadgeKey) as TargetSyncBadge) : null),
    [syncBadgeKey],
  );
  // 1.171.0 E3 (BI-3): a Needs you card says its one press — the card's
  // own Now primary; pressing the card opens it there, nothing runs here.
  const nextPress = boardNextPress(p);
  const run = p.dot;
  const fact = p.fact;
  const word = p.headline;

  return (
    <div
      ref={cardRef}
      className={arrived ? "board-card board-card--arrived" : "board-card"}
      data-board-card-id={card.id}
      data-board-card-state={p.boardState}
      data-ply-rule={p.rule}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        // F1 (BI-16): the Board lights only where this card may land.
        boardDrag.cardId = card.id;
        e.dataTransfer.setData(ATELIER_CARD_TYPE, card.id);
        // Defensive: WKWebView occasionally strips custom MIME types in
        // internal DnD; text/plain is always preserved. Read both on drop.
        e.dataTransfer.setData("text/plain", card.id);
      }}
      onContextMenu={(e) => {
        // The menu is in a portal: its own right-click is not the card's.
        if (!e.currentTarget.contains(e.target as Node)) return;
        e.preventDefault();
        openMenu(e.clientX, e.clientY);
      }}
      onKeyDown={(e) => {
        // QoL 1.168 (block 10, C6): the Board by keyboard (lib/boardKeys).
        // Keys from the menu (a portal) bubble here too: not the card's.
        if (!e.currentTarget.contains(e.target as Node)) return;
        const action = boardKeyAction(e);
        if (!action) return;
        if (action === "menu") {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          openMenu(r.left + 12, r.top + Math.min(r.height, 40));
          return;
        }
        // The archive row's cards are not in a column.
        if (!e.currentTarget.closest("[data-board-column]")) return;
        e.preventDefault();
        e.stopPropagation();
        if (action === "up" || action === "down" || action === "left" || action === "right") {
          focusBoardStep(e.currentTarget, action);
        } else {
          moveCardByKey(card, action, draggable, shownColumnIds(e.currentTarget), e.repeat);
        }
      }}
    >
      <button
        ref={openRef}
        type="button"
        className="board-card-open"
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight Shift+F10"
        data-ply-board-card-id={card.id}
        data-ply-rule={p.rule}
        onClick={() => selectCard(card.workspaceId, card.id)}
        title={boardCardTitle(card, p)}
      >
        <span className="board-card-title">{card.title}</span>
        {/* Skills hub H3a (§4.2): a card Plyloft made for one skill change. */}
        {isSkillCard(card) && <DuplicateChip>Skill</DuplicateChip>}
        {/* 1.170.0 (G6): Behind main / Conflict ahead. 1.174.0 (A7, BCI-15 ·
            VC-9): a badge that asks something is an outline chip with an
            amber dot, as wide as its words; a quiet one ("Behind main") is
            text in the facts, under the state (mockups/board.html §4, §7). */}
        {syncBadge?.urgent && (
          <DuplicateChip title={syncBadge.title} tone="warn">
            {syncBadge.label}
          </DuplicateChip>
        )}
        <span className="board-card-fact">
          {p.blocked ? (
            // UX-7.3: a held card says what it waits for, with the icon.
            <span className="ux-state">
              <Icon name="blockedBy" size="sm" />
              {p.blocked}
            </span>
          ) : (
            <StateWord state={run.state} live={run.live}>
              {fact ? `${word} · ${fact}` : word}
            </StateWord>
          )}
        </span>
        {outside && (
          <span className="board-card-fact board-card-fact--quiet board-card-fact--icon" data-ply-board-card-outside="">
            <Icon name="outside" size="sm" />
            {outsideLine(outside)}
          </span>
        )}
        {hasEditConflict(card) && (
          <span className="board-card-fact board-card-fact--quiet" data-ply-board-card-edit-waits="">
            {EDIT_WAITS_LINE}
          </span>
        )}
        {sharedClaim && (
          <span className="board-card-fact board-card-fact--quiet" data-ply-board-card-shared-claim="">
            {sharedClaim}
          </span>
        )}
        {teammatePr && (
          <span className="board-card-fact board-card-fact--quiet" data-ply-board-card-teammate-pr="">
            {teammatePr}
          </span>
        )}
        {syncBadge && !syncBadge.urgent && (
          <span className="board-card-fact board-card-fact--quiet" title={syncBadge.title} data-ply-board-card-sync="">
            {syncBadge.label}
          </span>
        )}
        {otherDevice && (
          <span className="board-card-device" data-ply-board-card-device="">
            {otherDevice}
          </span>
        )}
        {nextPress && (
          <span className="board-card-next" data-ply-board-card-next="">
            <span aria-hidden="true">→ </span>
            {/* Read as what comes next, not as this button's own action. */}
            <span className="sr-only">Next: </span>
            {nextPress}
          </span>
        )}
      </button>
      {contextMenu && (
        <KanbanCardContextMenu
          cardTitle={card.title}
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={(refocus) => {
            setContextMenu(null);
            if (refocus) openRef.current?.focus();
          }}
        />
      )}
      {deleteDialog}
    </div>
  );
}
